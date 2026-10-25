/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendWorkflowEvent,
  readWorkflowRun,
  writeNodeAttempt,
} from './workflowStore.js'
import { writeJson } from './jsonIo.js'
import { workflowRunLocalProcessCancelRequested } from './localProcessLifecycle.js'
import {
  WorkflowExecCancelledError,
  runWorkflowExecNode,
} from './nodeAdapters/execNode.js'
import { runWorkflowGuardNode } from './nodeAdapters/guardNode.js'
import { writeWorkflowHumanPrompt } from './nodeAdapters/humanNode.js'
import {
  WorkflowAgentCancelledError,
  runWorkflowAgentNode,
  type WorkflowAgentContractRepair,
} from './nodeAdapters/agentNode.js'
import { runWorkflowSubworkflowNode } from './nodeAdapters/subworkflowNode.js'
import { runWorkflowBackendNode } from './nodeAdapters/backendNode.js'
import { runWorkflowMapNode } from './nodeAdapters/mapNode.js'
import { runWorkflowLoopNode } from './nodeAdapters/loopNode.js'
import {
  computeJobReceiptFromBackendOutput,
  computeJobSpecForNode,
} from './nodeAdapters/computeNode.js'
import {
  runComputePostSubmitLifecycle,
  type ComputeLifecycleResult,
} from './computeLifecycle.js'
import { validationResultFromGuardOutput } from './nodeAdapters/validateNode.js'
import {
  listNodeRuns,
  materializeWorkflowNode,
  nowIso,
  readApprovalRequest,
  readNodeRun,
  readWorkflowArtifacts,
  updateRunStatus,
} from './runState.js'
import {
  WorkflowNodeOutputContractError,
  assertWorkflowNodeOutputContract,
  attemptIdempotencyKeyForNode,
  attemptInputForNode,
  attemptSideEffectForNode,
  backendToolRef,
  completeNode,
  computeLifecycleEventType,
  failNode,
  failNodeWithOutput,
  handleValidationRecommendation,
  hasFailureRouteFromNode,
  isRetryableNodeError,
  markNode,
  nodeApprovalDecision,
  requestNodeApproval,
  retryPolicyForNode,
  scheduleNodeRetry,
  validationRecommendationFromNode,
  workflowNodeErrorInfo,
} from './nodeLifecycle.js'
import { runWorkflowDynamicNode } from './dynamicNodeRunner.js'
import {
  refreshWorkflowBudgetLedger,
  resolveWorkflowBudgetPolicy,
  resolveWorkflowNodeBudgetPolicy,
  workflowRemainingBudget,
} from './budget.js'
import type {
  ComputeJobReceipt,
  MatOSWorkflowAttemptUsage,
  MatOSWorkflowDefinition,
  MatOSWorkflowGuardCheck,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowNodeType,
  MatOSWorkflowRuntimeNodeType,
} from './types.js'
import type {
  ResumeChildWorkflowRun,
  StartChildWorkflowRun,
  WorkflowDynamicPlannerRunner,
} from './runtimeTypes.js'
import { withMatOSWorkflowExecutionContext } from './executionContext.js'
import {
  decideMatOSContinuationPolicy,
  type MatOSContinuationAction,
} from '../algorithms/surfaces/continuationPolicy.js'
import {
  matOSAlgorithmComponentPinsFromManifest,
  matOSAlgorithmSurfacePinsFromManifest,
  readMatOSAlgorithmRunManifestForExecution,
} from '../algorithms/manifest.js'
import {
  clearWorkflowRunControl,
  readWorkflowRunControlAction,
} from './workflowControl.js'

export type WorkflowNodeExecutionResult = 'continue' | 'waiting' | 'failed'

// Per-attempt execution context shared by every node executor. The runNode
// shell owns cross-cutting concerns (template materialization, attempt
// bookkeeping, retry, failure routing); executors own node-type semantics.
// Child-run capable executors receive startChildRun by injection so this
// module never imports the runtime entry module.
export type WorkflowNodeExecutionContext = {
  runDir: string
  attempt: number
  startedAt: string
  idempotencyKey: string
  previousNodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>
  runId: string
  artifactRoot: string
  projectCwd: string
  scopeRef?: string
  workspaceDir: string
  workflowsDir: string
  definition: MatOSWorkflowDefinition
  parameters: Record<string, unknown>
  startChildRun: StartChildWorkflowRun
  resumeChildRun?: ResumeChildWorkflowRun
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
}

export type WorkflowNodeExecutor = (
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
) => Promise<WorkflowNodeExecutionResult>

function errorStream(error: unknown, key: 'stdout' | 'stderr'): string | undefined {
  return error &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>)[key] === 'string'
    ? String((error as Record<string, unknown>)[key])
    : undefined
}

async function executeExecNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const result = await runWorkflowExecNode(runtimeNode, {
    workspaceDir: context.workspaceDir,
    projectCwd: context.projectCwd,
    runDir,
    artifactRoot: context.artifactRoot,
    parameters: context.parameters,
    workflowSourcePath: context.definition.sourcePath,
  })
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    result.output,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: 'completed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output: result.output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    stdout: result.stdout,
    stderr: result.stderr,
  })
  await completeNode(runDir, runtimeNode, result.output)
  return 'continue'
}

async function executeGuardNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const result = await runWorkflowGuardNode(runtimeNode, {
    workspaceDir: context.workspaceDir,
    expressionContext: {
      nodeRuns: context.previousNodeRuns,
      parameters: context.parameters,
    },
    throwOnFailure: runtimeNode.targetType !== 'validate',
    algorithm: {
      candidateChecks: Array.isArray(runtimeNode.candidateChecks)
        ? (runtimeNode.candidateChecks as MatOSWorkflowGuardCheck[])
        : undefined,
      maxAdditionalChecks:
        typeof runtimeNode.maxAdditionalChecks === 'number'
          ? runtimeNode.maxAdditionalChecks
          : undefined,
      roleAlgorithms: context.definition.policy.algorithms,
      cwd: context.projectCwd,
      workflowRunId: context.runId,
      workflowNodeId: runtimeNode.id,
      attempt,
    },
  })
  if (runtimeNode.targetType === 'validate') {
    const output = validationResultFromGuardOutput(result.output)
    assertWorkflowNodeOutputContract(runtimeNode, output)
    const baselineRecommendation = validationRecommendationFromNode(
      runtimeNode,
      output,
    )
    const baselineAction: MatOSContinuationAction =
      baselineRecommendation === 'human_review'
        ? 'request-human'
        : baselineRecommendation ?? 'continue'
    const candidateActions: MatOSContinuationAction[] = [baselineAction]
    for (const action of ['request-human', 'fail'] as const) {
      if (!candidateActions.includes(action)) candidateActions.push(action)
    }
    const continuation = await decideMatOSContinuationPolicy({
      baselineAction,
      candidateActions,
      requiredValidationPassed: output.ok,
      replaySafe: baselineAction !== 'retry' || Boolean(runtimeNode.retryNodeId),
      roleAlgorithms: context.definition.policy.algorithms,
      cwd: context.projectCwd,
      workflowRunId: context.runId,
      workflowNodeId: runtimeNode.id,
      attempt,
    })
    const recommendationOverride =
      continuation.decision.action === 'request-human' ||
      continuation.decision.action === 'pause'
        ? 'human_review'
        : continuation.decision.action === 'stop' ||
            continuation.decision.action === 'fail'
          ? 'fail'
          : continuation.decision.action === 'retry'
            ? 'retry'
            : continuation.decision.action === 'reroute'
              ? 'reroute'
              : baselineRecommendation
    return handleValidationRecommendation({
      runDir,
      node: runtimeNode,
      output,
      attempt,
      startedAt,
      idempotencyKey,
      definition: context.definition,
      recommendationOverride,
    })
  }
  const output = result.output
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    output,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: 'completed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, output, attempt),
  })
  await completeNode(runDir, runtimeNode, output)
  return 'continue'
}

/**
 * Derive contract-repair feedback for an agent retry from the node run that
 * `scheduleNodeRetry` persisted after a WorkflowNodeOutputContractError.
 * Only a persisted `output_contract_failed` error qualifies: a full manual
 * node reset (resetNodeRun) drops the error and therefore starts fresh, and
 * non-contract failures never trigger repair feedback. The running-mark of
 * the retry attempt merges over the prior snapshot (it keeps the error but
 * bumps `attempts`), so the failing attempt is `attempts - 1` when the
 * snapshot is already marked running.
 */
export function workflowAgentContractRepairFromNodeRun(
  nodeRun: MatOSWorkflowNodeRunSnapshot | undefined,
): WorkflowAgentContractRepair | undefined {
  if (!nodeRun || !nodeRun.error || typeof nodeRun.error !== 'object') {
    return undefined
  }
  const error = nodeRun.error as {
    code?: unknown
    details?: { errors?: unknown; output?: unknown }
  }
  if (error.code !== 'output_contract_failed') {
    return undefined
  }
  const errors = Array.isArray(error.details?.errors)
    ? error.details.errors.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : []
  if (errors.length === 0) {
    return undefined
  }
  const output =
    error.details?.output && typeof error.details.output === 'object'
      ? (error.details.output as Record<string, unknown>)
      : undefined
  const upstreamSessionId =
    typeof output?.upstreamSessionId === 'string' &&
    output.upstreamSessionId.trim().length > 0
      ? output.upstreamSessionId
      : undefined
  const previousAttempt = Math.max(
    1,
    nodeRun.status === 'running' ? nodeRun.attempts - 1 : nodeRun.attempts,
  )
  return {
    errors,
    previousAttempt,
    ...(upstreamSessionId ? { upstreamSessionId } : {}),
  }
}

async function executeAgentNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const contractRepair =
    attempt > 1
      ? workflowAgentContractRepairFromNodeRun(
          await readNodeRun(runDir, runtimeNode.id),
        )
      : undefined
  const result = await runWorkflowAgentNode(runtimeNode, {
    cwd: context.projectCwd,
    scopeRef: context.scopeRef,
    runDir: context.runDir,
    attempt: context.attempt,
    ...(contractRepair ? { contractRepair } : {}),
  })
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    result.output,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: 'completed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output: result.output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.usage ? { usage: result.usage } : {}),
  })
  await completeNode(runDir, runtimeNode, result.output)
  return 'continue'
}

async function executeBackendNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const approval = await readApprovalRequest(runDir, runtimeNode.id)
  if (
    nodeApprovalDecision(context.definition, runtimeNode) &&
    approval?.status !== 'approved'
  ) {
    await writeNodeAttempt({
      runDir,
      nodeId: runtimeNode.id,
      attempt,
      status: 'waiting_approval',
      startedAt,
      idempotencyKey,
      input: attemptInputForNode(runtimeNode),
      sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
    })
    await requestNodeApproval(runDir, runtimeNode)
    return 'waiting'
  }

  await appendWorkflowEvent(runDir, {
    type: 'workflow.backend.started',
    data: {
      nodeId: runtimeNode.id,
      backend: runtimeNode.backend,
      toolRef: backendToolRef(runtimeNode),
    },
  })
  const result = await runWorkflowBackendNode(runtimeNode, {
    cwd: context.projectCwd,
  })
  const output =
    runtimeNode.targetType === 'compute'
      ? computeJobReceiptFromBackendOutput(
          computeJobSpecForNode(runtimeNode),
          result.output,
        )
      : result.output
  await appendWorkflowEvent(runDir, {
    type: 'workflow.backend.completed',
    data: {
      nodeId: runtimeNode.id,
      backend: runtimeNode.backend,
      toolRef: backendToolRef(runtimeNode),
      output,
    },
  })
  if (runtimeNode.targetType === 'compute') {
    await appendWorkflowEvent(runDir, {
      type: computeLifecycleEventType(output),
      data: {
        nodeId: runtimeNode.id,
        backend: runtimeNode.backend,
        toolRef: backendToolRef(runtimeNode),
        output,
      },
    })
    await markNode(runDir, runtimeNode, 'running', {
      output,
      sideEffect: attemptSideEffectForNode(runtimeNode, output, attempt),
    })
  }
  let lifecycle: ComputeLifecycleResult = {
    output: output as ComputeJobReceipt,
  }
  if (runtimeNode.targetType === 'compute') {
    lifecycle = await runComputePostSubmitLifecycle(
      runDir,
      runtimeNode,
      output as ComputeJobReceipt,
      { cwd: context.projectCwd },
    )
  }
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    lifecycle.output,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: lifecycle.cancelled
      ? 'cancelled'
      : lifecycle.failureMessage
        ? 'failed'
        : 'completed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output: lifecycle.output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, lifecycle.output, attempt),
    stdout: result.stdout,
    stderr: result.stderr,
  })
  if (lifecycle.cancelled) {
    await markNode(runDir, runtimeNode, 'cancelled', {
      output: lifecycle.output,
      sideEffect: attemptSideEffectForNode(
        runtimeNode,
        lifecycle.output,
        attempt,
      ),
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.node.cancelled',
      data: { nodeId: runtimeNode.id, output: lifecycle.output },
    })
    return 'continue'
  }
  if (lifecycle.failureMessage) {
    const routedFailure = hasFailureRouteFromNode(
      context.definition,
      runtimeNode.id,
    )
    await failNodeWithOutput(
      runDir,
      runtimeNode,
      lifecycle.failureMessage,
      lifecycle.output,
      { failRun: !routedFailure },
    )
    return routedFailure ? 'continue' : 'failed'
  }
  await completeNode(runDir, runtimeNode, lifecycle.output)
  return 'continue'
}

/**
 * Structured failure for a child run parked at a human/approval gate (or
 * paused), and for a child run that is busy advancing under another lock
 * holder. Marked not-retry-safe so a node retry policy cannot loop into
 * spawning duplicate children while the gate is unanswered; the guidance
 * carries the exact respond/resume commands. An explicit retry_node after
 * the child was answered adopts the same child run (see
 * runWorkflowSubworkflowNode) instead of starting a new one.
 */
export class WorkflowSubworkflowWaitingError extends Error {
  readonly code = 'subworkflow_child_waiting'
  readonly retryable = false
  readonly sameInputRetrySafe = false
  readonly details: Record<string, unknown>

  constructor(nodeId: string, childRun: { runId: string; status: string; waitingNodeId?: string }) {
    const respondHint =
      childRun.status === 'waiting_approval'
        ? `approve it with workflow_run action=approve runId=${childRun.runId} nodeId=${childRun.waitingNodeId ?? '<childNodeId>'}`
        : childRun.status === 'waiting_input'
          ? `answer it with workflow_run action=respond runId=${childRun.runId} nodeId=${childRun.waitingNodeId ?? '<childNodeId>'} response=...`
          : `resume it with workflow_run action=resume runId=${childRun.runId}`
    super(
      `Subworkflow child run is waiting: ${nodeId} -> ${childRun.runId} (${childRun.status}${childRun.waitingNodeId ? ` at ${childRun.waitingNodeId}` : ''}). ` +
        `The child run is its own run: first ${respondHint}, then retry this node (workflow_run action=retry_node nodeId=${nodeId}) — the retry adopts the same child run instead of starting a duplicate.`,
    )
    this.name = 'WorkflowSubworkflowWaitingError'
    this.details = {
      nodeId,
      childRunId: childRun.runId,
      childStatus: childRun.status,
      ...(childRun.waitingNodeId ? { childWaitingNodeId: childRun.waitingNodeId } : {}),
      action: 'respond_to_child_then_retry_node',
      sameInputRetrySafe: false,
      retryable: false,
    }
  }
}

const SUBWORKFLOW_WAITING_CHILD_STATUSES = new Set([
  'waiting_input',
  'waiting_approval',
  'paused',
])

async function executeSubworkflowNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const result = await runWorkflowSubworkflowNode(runtimeNode, {
    cwd: context.projectCwd,
    runDir,
    workflowsDir: context.workflowsDir,
    workspaceDir: context.workspaceDir,
    startChildRun: context.startChildRun,
    resumeChildRun: context.resumeChildRun,
    onChildCreated: async child => {
      await mkdir(join(runDir, 'child-runs'), { recursive: true })
      await writeJson(join(runDir, 'child-runs', `${runtimeNode.id}.json`), {
        nodeId: runtimeNode.id,
        workflowRef: child.workflowRef,
        childRunId: child.childRunId,
        status: 'created',
        detachOnParentCancel: runtimeNode.policy?.detachOnParentCancel === true,
      })
      await markNode(runDir, runtimeNode, 'running', {
        output: {
          childRunId: child.childRunId,
          status: 'created',
          outputs: {},
        },
      })
      await appendWorkflowEvent(runDir, {
        type: 'workflow.subworkflow.started',
        data: {
          nodeId: runtimeNode.id,
          workflowRef: child.workflowRef,
          childRunId: child.childRunId,
        },
      })
    },
  })
  await mkdir(join(runDir, 'child-runs'), { recursive: true })
  await writeJson(join(runDir, 'child-runs', `${runtimeNode.id}.json`), {
    nodeId: runtimeNode.id,
    workflowRef: result.workflowRef,
    childRunId: result.childRun.runId,
    status: result.childRun.status,
    detachOnParentCancel: runtimeNode.policy?.detachOnParentCancel === true,
  })
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    result.output,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status:
      result.childRun.status === 'completed'
        ? 'completed'
        : result.childRun.status === 'cancelled'
          ? 'cancelled'
          : 'failed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output: result.output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
  })
  if (result.childRun.status === 'cancelled') {
    await markNode(runDir, runtimeNode, 'cancelled', {
      output: result.output,
      sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.subworkflow.cancelled',
      data: {
        nodeId: runtimeNode.id,
        workflowRef: result.workflowRef,
        childRunId: result.childRun.runId,
      },
    })
    await updateRunStatus(runDir, 'cancelled', { waitingNodeId: undefined })
    return 'waiting'
  }
  if (SUBWORKFLOW_WAITING_CHILD_STATUSES.has(result.childRun.status)) {
    throw new WorkflowSubworkflowWaitingError(runtimeNode.id, {
      runId: result.childRun.runId,
      status: result.childRun.status,
      waitingNodeId: result.childRun.waitingNodeId,
    })
  }
  if (result.childRun.status !== 'completed') {
    throw new Error(
      `Subworkflow did not complete: ${runtimeNode.id} (${result.childRun.status})`,
    )
  }
  await appendWorkflowEvent(runDir, {
    type: 'workflow.subworkflow.completed',
    data: {
      nodeId: runtimeNode.id,
      workflowRef: result.workflowRef,
      childRunId: result.childRun.runId,
      outputs: result.output.outputs,
    },
  })
  await completeNode(runDir, runtimeNode, result.output)
  return 'continue'
}

async function executeIterationNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const result = await (runtimeNode.type === 'map'
    ? runWorkflowMapNode
    : runWorkflowLoopNode)(runtimeNode, {
    cwd: context.projectCwd,
    runDir,
    workflowsDir: context.workflowsDir,
    workspaceDir: context.workspaceDir,
    startChildRun: context.startChildRun,
    resumeChildRun: context.resumeChildRun,
  })
  if (result.cancelled) {
    // A run cancel request arrived between child rounds. The node settles as
    // cancelled with its partial output (contract checks do not apply to a
    // deliberately interrupted node) and the scheduler loop applies the
    // pending cancel marker to the run at its next boundary.
    await writeNodeAttempt({
      runDir,
      nodeId: runtimeNode.id,
      attempt,
      status: 'cancelled',
      startedAt,
      finishedAt: nowIso(),
      idempotencyKey,
      output: result.output,
      sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    })
    await markNode(runDir, runtimeNode, 'cancelled', {
      output: result.output,
      sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.node.cancelled',
      data: { nodeId: runtimeNode.id, reason: 'run_cancel_requested' },
    })
    return 'continue'
  }
  await appendWorkflowEvent(runDir, {
    type: 'workflow.iteration.completed',
    data: {
      nodeId: runtimeNode.id,
      type: runtimeNode.type,
      count: result.output.count,
    },
  })
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    result.output,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: result.failureMessage ? 'failed' : 'completed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output: result.output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
  })
  if (result.failureMessage) {
    const routedFailure = hasFailureRouteFromNode(
      context.definition,
      runtimeNode.id,
    )
    await failNodeWithOutput(
      runDir,
      runtimeNode,
      result.failureMessage,
      result.output,
      { failRun: !routedFailure },
    )
    return routedFailure ? 'continue' : 'failed'
  }
  await completeNode(runDir, runtimeNode, result.output)
  return 'continue'
}

async function executeHumanNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  await writeWorkflowHumanPrompt(runDir, runtimeNode)
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: 'waiting_input',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    input: attemptInputForNode(runtimeNode),
    sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
  })
  await markNode(runDir, runtimeNode, 'waiting_input')
  await appendWorkflowEvent(runDir, {
    type: 'workflow.human.prompted',
    data: { nodeId: runtimeNode.id, prompt: runtimeNode.prompt },
  })
  await updateRunStatus(runDir, 'waiting_input', {
    waitingNodeId: runtimeNode.id,
  })
  return 'waiting'
}

async function executeDynamicNode(
  runtimeNode: MatOSWorkflowNode,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  const { runDir, attempt, startedAt, idempotencyKey } = context
  const result = await runWorkflowDynamicNode({
    runDir,
    artifactRoot: context.artifactRoot,
    node: runtimeNode,
    definition: context.definition,
    attempt,
    startedAt,
    idempotencyKey,
    projectCwd: context.projectCwd,
    scopeRef: context.scopeRef,
    parameters: context.parameters,
    dynamicPlannerRunner: context.dynamicPlannerRunner,
  })
  if (result.state === 'waiting') {
    await writeWorkflowHumanPrompt(runDir, runtimeNode)
    await writeNodeAttempt({
      runDir,
      nodeId: runtimeNode.id,
      attempt,
      status: 'waiting_input',
      startedAt,
      finishedAt: nowIso(),
      idempotencyKey,
      output: result.output,
      sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    })
    await markNode(runDir, runtimeNode, 'waiting_input', {
      output: result.output,
      startedAt,
      idempotencyKey,
    })
    await updateRunStatus(runDir, 'waiting_input', {
      waitingNodeId: runtimeNode.id,
    })
    return 'waiting'
  }
  const contractValidation = assertWorkflowNodeOutputContract(
    runtimeNode,
    result.output,
  )
  const dynamicUsage =
    result.output &&
    typeof result.output === 'object' &&
    'usage' in result.output &&
    result.output.usage &&
    typeof result.output.usage === 'object'
      ? (result.output.usage as MatOSWorkflowAttemptUsage)
      : undefined
  await writeNodeAttempt({
    runDir,
    nodeId: runtimeNode.id,
    attempt,
    status: 'completed',
    startedAt,
    finishedAt: nowIso(),
    idempotencyKey,
    output: result.output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(runtimeNode, result.output, attempt),
    ...(dynamicUsage ? { usage: dynamicUsage } : {}),
  })
  await completeNode(runDir, runtimeNode, result.output)
  return 'continue'
}

// Type-keyed executor registry. Keying by MatOSWorkflowRuntimeNodeType makes
// the table exhaustive at compile time: adding a runtime node type without
// registering an executor is a type error, not a runtime fallthrough.
const WORKFLOW_NODE_EXECUTORS: Record<
  MatOSWorkflowRuntimeNodeType,
  WorkflowNodeExecutor
> = {
  exec: executeExecNode,
  guard: executeGuardNode,
  agent: executeAgentNode,
  backend: executeBackendNode,
  human: executeHumanNode,
  subworkflow: executeSubworkflowNode,
  map: executeIterationNode,
  loop: executeIterationNode,
  dynamic: executeDynamicNode,
}

function workflowNodeExecutorFor(
  type: MatOSWorkflowNodeType,
): WorkflowNodeExecutor | undefined {
  return (
    WORKFLOW_NODE_EXECUTORS as Partial<Record<string, WorkflowNodeExecutor>>
  )[type]
}

export type RunWorkflowNodeOptions = {
  runId: string
  artifactRoot: string
  projectCwd: string
  scopeRef?: string
  workspaceDir: string
  workflowsDir: string
  definition: MatOSWorkflowDefinition
  parameters: Record<string, unknown>
  startChildRun: StartChildWorkflowRun
  resumeChildRun?: ResumeChildWorkflowRun
  idempotencyScope?: Record<string, unknown>
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
}

export async function runNode(
  runDir: string,
  node: MatOSWorkflowNode,
  options: RunWorkflowNodeOptions,
): Promise<WorkflowNodeExecutionResult> {
  const algorithmManifest = await readMatOSAlgorithmRunManifestForExecution(
    runDir,
    { runId: options.runId },
  )
  while (true) {
    const previousNodeRuns = await listNodeRuns(runDir)
    const artifacts = await readWorkflowArtifacts(runDir)
    const runtimeNode = materializeWorkflowNode(
      node,
      previousNodeRuns,
      options.parameters,
      {
        artifactRoot: options.artifactRoot,
        projectCwd: options.projectCwd,
        runDir,
        runId: options.runId,
        workspaceDir: options.workspaceDir,
      },
      artifacts,
    )
    const currentNodeRun = await readNodeRun(runDir, runtimeNode.id)
    const attempt = (currentNodeRun?.attempts ?? 0) + 1
    const startedAt = nowIso()
    const idempotencyKey = attemptIdempotencyKeyForNode(
      options.runId,
      runtimeNode,
      attempt,
      options.idempotencyScope,
    )

    await markNode(runDir, runtimeNode, 'running', {
      attempts: attempt,
      startedAt,
      finishedAt: undefined,
      idempotencyKey,
    })
    await writeNodeAttempt({
      runDir,
      nodeId: runtimeNode.id,
      attempt,
      status: 'running',
      startedAt,
      idempotencyKey,
      input: attemptInputForNode(runtimeNode),
      sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.node.started',
      data: {
        nodeId: runtimeNode.id,
        type: runtimeNode.type,
        attempt,
        idempotencyKey,
      },
    })

    try {
      const executor = workflowNodeExecutorFor(runtimeNode.type)
      if (!executor) {
        throw new Error(
          `Unsupported workflow node runtime type: ${runtimeNode.type}`,
        )
      }
      const budgetConfigured = Boolean(
        resolveWorkflowBudgetPolicy(options.definition) ||
          resolveWorkflowNodeBudgetPolicy(runtimeNode),
      )
      const remainingBudget = budgetConfigured
        ? workflowRemainingBudget({
            definition: options.definition,
            ledger: await refreshWorkflowBudgetLedger(
              runDir,
              options.definition,
            ),
            nodeId: runtimeNode.id,
          })
        : undefined
      return await withMatOSWorkflowExecutionContext(
        {
          runId: options.runId,
          runDir,
          workflowNodeId: runtimeNode.id,
          attempt,
          projectCwd: options.projectCwd,
          ...(options.scopeRef ? { scopeRef: options.scopeRef } : {}),
          ...(remainingBudget ? { remainingBudget } : {}),
          ...(algorithmManifest
            ? {
                algorithmSurfacePins:
                  matOSAlgorithmSurfacePinsFromManifest(algorithmManifest),
                algorithmComponentPins:
                  matOSAlgorithmComponentPinsFromManifest(algorithmManifest),
              }
            : {}),
        },
        () =>
          executor(runtimeNode, {
            runDir,
            attempt,
            startedAt,
            idempotencyKey,
            previousNodeRuns,
            runId: options.runId,
            artifactRoot: options.artifactRoot,
            projectCwd: options.projectCwd,
            scopeRef: options.scopeRef,
            workspaceDir: options.workspaceDir,
            workflowsDir: options.workflowsDir,
            definition: options.definition,
            parameters: options.parameters,
            startChildRun: options.startChildRun,
            resumeChildRun: options.resumeChildRun,
            dynamicPlannerRunner: options.dynamicPlannerRunner,
          }),
      )
    } catch (error) {
      if ((await readWorkflowRunControlAction(runDir)) === 'cancel') {
        const errorInfo = workflowNodeErrorInfo(error)
        await writeNodeAttempt({
          runDir,
          nodeId: runtimeNode.id,
          attempt,
          status: 'cancelled',
          startedAt,
          finishedAt: nowIso(),
          idempotencyKey,
          sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
          error: errorInfo,
          ...(errorStream(error, 'stdout') !== undefined
            ? { stdout: errorStream(error, 'stdout') }
            : {}),
          ...(errorStream(error, 'stderr') !== undefined
            ? { stderr: errorStream(error, 'stderr') }
            : {}),
        })
        await markNode(runDir, runtimeNode, 'cancelled', {
          error: errorInfo,
        })
        await updateRunStatus(runDir, 'cancelled', {
          waitingNodeId: undefined,
        })
        await appendWorkflowEvent(runDir, {
          type: 'workflow.node.cancelled',
          data: { nodeId: runtimeNode.id, attempt },
        })
        await appendWorkflowEvent(runDir, {
          type: 'workflow.run.cancelled',
          data: { runId: options.runId },
        })
        await clearWorkflowRunControl(runDir)
        return 'failed'
      }
      const errorInfo = workflowNodeErrorInfo(error)
      if (
        error instanceof WorkflowExecCancelledError ||
        error instanceof WorkflowAgentCancelledError
      ) {
        // The run's cancel path terminated this node's process tree (marker
        // watcher or registered-pid kill). Settle the node as cancelled (not
        // failed, never retried) and yield; the scheduler loop applies the
        // cancel marker to the run at its next boundary.
        await writeNodeAttempt({
          runDir,
          nodeId: runtimeNode.id,
          attempt,
          status: 'cancelled',
          startedAt,
          finishedAt: nowIso(),
          idempotencyKey,
          sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
          error: errorInfo,
          stdout: error.stdout,
          stderr: error.stderr,
        })
        await markNode(runDir, runtimeNode, 'cancelled', { error: errorInfo })
        await appendWorkflowEvent(runDir, {
          type: 'workflow.node.cancelled',
          data: { nodeId: runtimeNode.id, reason: 'run_cancel_requested' },
        })
        return 'continue'
      }
      const contractFailure =
        error instanceof WorkflowNodeOutputContractError ? error : undefined
      const cancelRequested =
        (await readWorkflowRunControlAction(runDir)) === 'cancel' ||
        (await workflowRunLocalProcessCancelRequested(runDir)) ||
        (await readWorkflowRun(runDir)).status === 'cancelled'
      if (cancelRequested) {
        await writeNodeAttempt({
          runDir,
          nodeId: runtimeNode.id,
          attempt,
          status: 'cancelled',
          startedAt,
          finishedAt: nowIso(),
          idempotencyKey,
          sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
        })
        await markNode(runDir, runtimeNode, 'cancelled', {
          sideEffect: attemptSideEffectForNode(runtimeNode, undefined, attempt),
        })
        await appendWorkflowEvent(runDir, {
          type: 'workflow.node.cancelled',
          data: { nodeId: runtimeNode.id, reason: 'workflow_cancel_requested' },
        })
        return 'continue'
      }
      await writeNodeAttempt({
        runDir,
        nodeId: runtimeNode.id,
        attempt,
        status: 'failed',
        startedAt,
        finishedAt: nowIso(),
        idempotencyKey,
        ...(contractFailure ? { output: contractFailure.output } : {}),
        ...(contractFailure
          ? { contractValidation: { ok: false, errors: contractFailure.errors } }
          : {}),
        sideEffect: attemptSideEffectForNode(
          runtimeNode,
          contractFailure?.output,
          attempt,
        ),
        error: errorInfo,
        ...(errorStream(error, 'stdout') !== undefined
          ? { stdout: errorStream(error, 'stdout') }
          : {}),
        ...(errorStream(error, 'stderr') !== undefined
          ? { stderr: errorStream(error, 'stderr') }
          : {}),
      })

      const retryPolicy = retryPolicyForNode(runtimeNode)
      const nodeBudgetLimits = resolveWorkflowNodeBudgetPolicy(runtimeNode)
      const nodeBudgetMaxAttempts = nodeBudgetLimits?.maxNodeAttempts
      const nodeBudgetBlocksRetry =
        nodeBudgetMaxAttempts !== undefined && attempt >= nodeBudgetMaxAttempts
      if (
        nodeBudgetBlocksRetry &&
        retryPolicy &&
        attempt < retryPolicy.maxAttempts &&
        isRetryableNodeError(retryPolicy, errorInfo)
      ) {
        // The retry policy still has attempts left, but the node budget does
        // not. Record the budget cut so the run view can explain the early stop.
        await appendWorkflowEvent(runDir, {
          type: 'workflow.budget.exceeded',
          data: {
            violations: [
              {
                limit: 'maxNodeAttempts',
                max: nodeBudgetMaxAttempts,
                observed: attempt,
                nodeId: runtimeNode.id,
              },
            ],
            onExceeded: 'fail',
          },
        })
      }
      if (
        !nodeBudgetBlocksRetry &&
        retryPolicy &&
        attempt < retryPolicy.maxAttempts &&
        isRetryableNodeError(retryPolicy, errorInfo)
      ) {
        if (runtimeNode.type === 'agent' && contractFailure) {
          await appendWorkflowEvent(runDir, {
            type: 'workflow.agent.contract_repair_requested',
            data: {
              nodeId: runtimeNode.id,
              attempt,
              nextAttempt: attempt + 1,
              maxAttempts: retryPolicy.maxAttempts,
              errors: contractFailure.errors,
            },
          })
        }
        const controlAction = await scheduleNodeRetry({
          runDir,
          node: runtimeNode,
          attempt,
          policy: retryPolicy,
          error: errorInfo,
        })
        if (controlAction) {
          // A cancel/pause request arrived while the retry was backing off.
          // The node stays pending with its attempt count recorded; yield so
          // the scheduler loop applies the control action instead of burning
          // further attempts against a cancelled run.
          return 'continue'
        }
        continue
      }

      const routedFailure = hasFailureRouteFromNode(
        options.definition,
        runtimeNode.id,
      )
      await failNode(runDir, runtimeNode, error, { failRun: !routedFailure })
      return routedFailure ? 'continue' : 'failed'
    }
  }
}
