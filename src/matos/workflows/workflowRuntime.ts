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

import { readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  appendWorkflowEvent,
  createWorkflowRun,
  readWorkflowRun,
  writeNodeAttempt,
  writeWorkflowRun,
} from './workflowStore.js'
import { tryWithWorkflowRunLock, withWorkflowRunLock } from './runLock.js'
import { killWorkflowRunLocalProcesses } from './localProcessRegistry.js'
import { startWorkflowRunHeartbeat } from './runPulse.js'
import { readJson, writeJson } from './jsonIo.js'
import {
  clearWorkflowRunControl,
  readWorkflowRunControlAction,
  requestWorkflowRunControl,
} from './workflowControl.js'
import {
  clearWorkflowRunLocalProcessCancel,
  requestWorkflowRunLocalProcessCancel,
  terminateWorkflowRunLocalProcesses,
  workflowRunLocalProcessCancelRequested,
} from './localProcessLifecycle.js'
import {
  writeWorkflowHumanPrompt,
  writeWorkflowHumanResponse,
} from './nodeAdapters/humanNode.js'
import { retryWorkflowMapFailedChildren } from './nodeAdapters/mapNode.js'
import {
  cancelComputeJobsForWorkflowRun,
  reconcileComputeJobsForWorkflowRun,
  type CancelledComputeJobSummary,
  type ReconciledComputeJobSummary,
} from './computeLifecycle.js'
import {
  recoverWorkflowRun,
  workflowRecoveryReportDigest,
  workflowRecoverySafeAlternativeActions,
  type WorkflowRecoveryRecommendedAction,
  type WorkflowRecoveryReport,
} from './recovery.js'
import { enforceWorkflowBudget } from './budget.js'
import { workflowFailureSourceNodeIds } from './validationFailure.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunSnapshot,
} from './types.js'
import { compileMatOSWorkflowDefinition } from './workflowCompile.js'
import {
  allWorkflowNodesFinished,
  blockedWorkflowNodeToSkip,
  downstreamWorkflowNodeIds,
  readyWorkflowNodes,
} from './scheduler.js'
import {
  inspectWorkflowGraphPatchLedger,
  latestWorkflowGraphPatchForSourceNode,
  readWorkflowGraphPatchLedgerPayload,
  validateWorkflowGraphPatchCandidate,
  workflowGraphPatchGraphHash,
  writeWorkflowGraphPatchApplication,
  writeWorkflowGraphPatchDecision,
  type WorkflowGraphPatchLedgerView,
} from './dynamicPatch.js'
import { isStateMachineWorkflow } from './stateMachineTypes.js'
import {
  approvalPath,
  inspectWorkflowRunView,
  listNodeRuns,
  materializeWorkflowNode,
  nowIso,
  readApprovalRequest,
  readNodeRun,
  readWorkflowArtifacts,
  readWorkflowDefinition,
  resetNodeRun,
  resolveWorkflowOutputs,
  resolveWorkflowParameters,
  updateRunFields,
  updateRunStatus,
} from './runState.js'
import {
  WorkflowNodeOutputContractError,
  assertWorkflowNodeOutputContract,
  attemptIdempotencyKeyForNode,
  attemptSideEffectForNode,
  completeNode,
  failNode,
  failNodeWithOutput,
  hasFailureRouteFromNode,
  markNode,
  nodeApprovalDecision,
  workflowNodeErrorInfo,
} from './nodeLifecycle.js'
import { workflowSubworkflowNodeOutputForChildRun } from './nodeAdapters/subworkflowNode.js'
import { validateValueAgainstJsonSchema } from './outputContract.js'
import { WorkflowSubworkflowWaitingError, runNode } from './nodeExecutors.js'
import {
  adviseWorkflowReadySet,
  redactWorkflowControllerFailureText,
} from './runObservers.js'
import { workflowControllerFailureMode } from '../algorithms/controllerBinding.js'
import { readMatOSAlgorithmRunManifestForExecution } from '../algorithms/manifest.js'
import type {
  StartWorkflowSingleNodeRunInput,
  StartWorkflowRunInput,
  WorkflowApprovalRequest,
  WorkflowDynamicPlannerRunner,
  WorkflowRunView,
} from './runtimeTypes.js'

export type {
  StartWorkflowRunInput,
  WorkflowApprovalAction,
  WorkflowApprovalRequest,
  WorkflowDynamicPlannerRunner,
  WorkflowRunView,
} from './runtimeTypes.js'

export type WorkflowGraphPatchRunDecisionResult = {
  run: WorkflowRunView
  patch: WorkflowGraphPatchLedgerView
}

export type WorkflowComputeReconcileResult = {
  run: WorkflowRunView
  reconciled: ReconciledComputeJobSummary[]
}

export type WorkflowRecoveryApplyResult = {
  recovery: WorkflowRecoveryReport
  appliedAction: WorkflowRecoveryRecommendedAction
  run: WorkflowRunView
  reconciled?: ReconciledComputeJobSummary[]
  remoteCancels?: CancelledComputeJobSummary[]
}

export type RespondToWorkflowNodeInput = {
  runDir: string
  nodeId: string
  response: unknown
}

export type ApproveWorkflowNodeInput = {
  runDir: string
  nodeId: string
  approvedFingerprint?: string
  response?: unknown
}

export type DenyWorkflowNodeInput = {
  runDir: string
  nodeId: string
  reason?: string
}

export type RetryWorkflowNodeInput = {
  runDir: string
  nodeId: string
  failedChildrenOnly?: boolean
}

export type SkipWorkflowNodeInput = {
  runDir: string
  nodeId: string
  reason?: string
}

export type WorkflowApprovalStatusView = {
  run: WorkflowRunView
  approvals: WorkflowApprovalRequest[]
  pendingApprovals: WorkflowApprovalRequest[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeHumanResponseForSchema(
  response: unknown,
  schema: unknown,
): unknown {
  if (typeof response !== 'string' || !isRecord(schema)) {
    return response
  }
  const schemaType = schema.type
  if (schemaType === 'string') {
    return response
  }
  try {
    return JSON.parse(response) as unknown
  } catch {
    return response
  }
}

async function validateWorkflowHumanResponse(input: {
  runDir: string
  node: MatOSWorkflowNode
  response: unknown
}): Promise<unknown> {
  const schema = input.node.responseSchema
  if (schema === undefined) {
    return input.response
  }
  const response = normalizeHumanResponseForSchema(input.response, schema)
  const validation = validateValueAgainstJsonSchema(response, schema)
  if (validation.ok) {
    return response
  }
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.human.response_rejected',
    data: {
      nodeId: input.node.id,
      errors: validation.errors,
    },
  })
  throw new Error(
    `Workflow human response for node ${input.node.id} failed responseSchema: ${validation.errors.join('; ')}`,
  )
}

const DEFAULT_WORKFLOW_MAX_CONCURRENCY_CAP = 8
const WORKFLOW_MAX_CONCURRENCY_HARD_CAP = 32

export function workflowMaxConcurrency(
  definition: MatOSWorkflowDefinition,
): number {
  const direct = Number(definition.policy.maxConcurrency)
  const nested =
    definition.policy.concurrency &&
    typeof definition.policy.concurrency === 'object' &&
    !Array.isArray(definition.policy.concurrency)
      ? Number(
          (definition.policy.concurrency as Record<string, unknown>).maxParallel,
        )
      : Number.NaN
  const value = Number.isFinite(direct) ? direct : nested
  if (!Number.isFinite(value) || value < 2) {
    return 1
  }
  // Stay conservative by default, but let workflows that explicitly opt in
  // raise the cap. Budget enforcement still gates every scheduling round.
  const cap =
    definition.policy.allowHighConcurrency === true
      ? WORKFLOW_MAX_CONCURRENCY_HARD_CAP
      : DEFAULT_WORKFLOW_MAX_CONCURRENCY_CAP
  return Math.min(cap, Math.floor(value))
}

function nodeDeclaredIdempotent(node: MatOSWorkflowNode): boolean {
  return (
    node.policy?.idempotent === true ||
    node.policy?.idempotency === 'safe' ||
    node.policy?.replaySafe === true
  )
}

/**
 * Production parallel-safety policy:
 * - `policy.parallel: false` always opts a node out.
 * - `exec` and `guard` stay parallel-safe by default (local, replayable).
 * - `agent`, `subworkflow`, `map`, and `loop` may opt in with
 *   `policy.parallel: true`.
 * - `backend`/`compute` nodes have external side effects, so opting in
 *   additionally requires an explicit idempotency declaration
 *   (`policy.idempotent: true`, `policy.idempotency: 'safe'`, or
 *   `policy.replaySafe: true`).
 * - `human` and `dynamic` nodes never run in parallel: human gates pause the
 *   run and dynamic nodes mutate the graph snapshot.
 */
export function nodeParallelSafe(node: MatOSWorkflowNode): boolean {
  if (node.policy?.parallel === false) {
    return false
  }
  if (node.type === 'exec' || node.type === 'guard') {
    return true
  }
  if (node.policy?.parallel !== true) {
    return false
  }
  if (node.type === 'human' || node.type === 'dynamic') {
    return false
  }
  if (
    node.type === 'backend' ||
    node.type === 'compute' ||
    node.targetType === 'compute'
  ) {
    return nodeDeclaredIdempotent(node)
  }
  return (
    node.type === 'agent' ||
    node.type === 'subworkflow' ||
    node.type === 'map' ||
    node.type === 'loop'
  )
}

/**
 * Whether dispatching this node right now would park it at an approval gate.
 * Only the backend/compute execution path writes approval gates
 * (executeBackendNode), and an already-approved request lets the node run
 * straight through.
 */
async function nodeWillRequestApproval(
  runDir: string,
  definition: MatOSWorkflowDefinition,
  node: MatOSWorkflowNode,
): Promise<boolean> {
  const backendLike =
    node.type === 'backend' ||
    node.type === 'compute' ||
    node.targetType === 'compute'
  if (!backendLike) {
    return false
  }
  if (!nodeApprovalDecision(definition, node)) {
    return false
  }
  const approval = await readApprovalRequest(runDir, node.id)
  return approval?.status !== 'approved'
}

/**
 * Stop scheduling new node attempts once the durable budget ledger reaches a
 * declared `policy.budget` limit. Returns the terminal/paused run view when
 * the budget is exhausted, or undefined when scheduling may continue.
 */
async function stopRunIfBudgetExhausted(
  runDir: string,
  definition: MatOSWorkflowDefinition,
): Promise<WorkflowRunView | undefined> {
  const enforcement = await enforceWorkflowBudget({ runDir, definition })
  if (!enforcement) {
    return undefined
  }
  await appendWorkflowEvent(runDir, {
    type: 'workflow.budget.exceeded',
    data: {
      violations: enforcement.violations,
      totals: enforcement.ledger.totals,
      onExceeded: enforcement.onExceeded,
    },
  })
  const violationSummary = enforcement.violations
    .map(violation => `${violation.limit}=${violation.max} observed=${violation.observed}`)
    .join('; ')
  if (enforcement.onExceeded === 'pause') {
    const snapshot = await updateRunStatus(runDir, 'paused', {
      waitingNodeId: undefined,
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.run.paused',
      data: { runId: snapshot.runId, reason: `budget exhausted: ${violationSummary}` },
    })
    return inspectWorkflowRunView(runDir)
  }
  const snapshot = await updateRunStatus(runDir, 'failed', {
    waitingNodeId: undefined,
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.run.failed',
    data: { runId: snapshot.runId, reason: `budget exhausted: ${violationSummary}` },
  })
  return inspectWorkflowRunView(runDir)
}

async function skipBlockedNode(
  runDir: string,
  definition: MatOSWorkflowDefinition,
  nodeRuns: Awaited<ReturnType<typeof listNodeRuns>>,
  parameters: Record<string, unknown>,
): Promise<boolean> {
  const node = blockedWorkflowNodeToSkip({ definition, nodeRuns, parameters })
  if (!node) {
    return false
  }

  await markNode(runDir, node, 'skipped', {
    output: { skipped: true, reason: 'dependency condition not met' },
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.node.skipped',
    data: { nodeId: node.id, reason: 'dependency condition not met' },
  })
  return true
}

export type WorkflowSingleNodeRunInput = {
  runDir: string
  node: MatOSWorkflowNode
  runId: string
  artifactRoot: string
  projectCwd: string
  scopeRef?: string
  workspaceDir: string
  workflowsDir: string
  definition: MatOSWorkflowDefinition
  parameters: Record<string, unknown>
  idempotencyScope?: Record<string, unknown>
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
}

/**
 * Runtime bound on child-run nesting (subworkflow/map/loop). Static
 * validation only rejects direct self-recursion; mutual recursion across
 * published workflows (A -> B -> A) resolves at runtime and would otherwise
 * spawn child runs without bound until the host runs out of disk or pids.
 */
const DEFAULT_WORKFLOW_MAX_CHILD_DEPTH = 16

export function workflowMaxChildDepth(): number {
  const configured = Number(process.env.MATOS_WORKFLOW_MAX_CHILD_DEPTH)
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_WORKFLOW_MAX_CHILD_DEPTH
}

function childWorkflowRunStarter(parentRunDir: string) {
  return async (input: StartWorkflowRunInput): Promise<WorkflowRunView> => {
    // The parent snapshot must be readable here: childDepth feeds the
    // recursion cap, so silently treating a read failure as depth 0 would
    // reset the chain and defeat the A -> B -> A guard (and sever the
    // provenance linkage). Retry once for transient hiccups, then fail the
    // child start loudly.
    const parent = await readWorkflowRun(parentRunDir).catch(() =>
      readWorkflowRun(parentRunDir),
    )
    return startWorkflowRun({
      ...input,
      workflowRunsDir: input.workflowRunsDir ?? dirname(parentRunDir),
      childDepth: (parent?.childDepth ?? 0) + 1,
      // Child runs carry their spawning run unless the caller declared a
      // more specific provenance; the store would otherwise stamp them
      // 'unknown' and sever the parent linkage trust decisions rely on.
      provenance: input.provenance ?? {
        source: 'workflow',
        ...(parent
          ? {
              parentRunId: parent.runId,
              parentWorkflowRef: parent.workflowRef,
            }
          : {}),
      },
    })
  }
}

const CHILD_RUN_RESUME_LOCK_TIMEOUT_MS = 2000

/**
 * Resume a child run while holding ITS run lock. A bare resumeWorkflowRun
 * here ran concurrently with any service-level `workflow resume <childRunId>`
 * (which locks the child), so two advancers could dispatch the same child
 * node twice. Lock contention means the child is already being advanced by
 * someone else: surface that as the structured "child is busy/waiting"
 * failure so the parent node fails with adoption guidance instead of
 * double-driving the child.
 */
async function resumeChildWorkflowRunHoldingLock(
  childRunDir: string,
  context?: { nodeId?: string },
): Promise<WorkflowRunView> {
  const attempt = await tryWithWorkflowRunLock(
    childRunDir,
    () => resumeWorkflowRun(childRunDir),
    {
      owner: 'workflow.child_resume',
      timeoutMs: CHILD_RUN_RESUME_LOCK_TIMEOUT_MS,
    },
  )
  if (attempt.acquired) {
    return attempt.value
  }
  const child = await readWorkflowRun(childRunDir).catch(() => undefined)
  throw new WorkflowSubworkflowWaitingError(
    context?.nodeId ?? basename(childRunDir),
    {
      runId: child?.runId ?? basename(childRunDir),
      status: child?.status ?? 'running',
      waitingNodeId: child?.waitingNodeId,
    },
  )
}

function childWorkflowRunResumer() {
  return (
    childRunDir: string,
    context?: { nodeId?: string },
  ): Promise<WorkflowRunView> =>
    resumeChildWorkflowRunHoldingLock(childRunDir, context)
}

export async function runWorkflowSingleNode(
  input: WorkflowSingleNodeRunInput,
): Promise<'continue' | 'waiting' | 'failed'> {
  return runNode(input.runDir, input.node, {
    runId: input.runId,
    artifactRoot: input.artifactRoot,
    projectCwd: input.projectCwd,
    scopeRef: input.scopeRef,
    workspaceDir: input.workspaceDir,
    workflowsDir: input.workflowsDir,
    definition: input.definition,
    parameters: input.parameters,
    startChildRun: childWorkflowRunStarter(input.runDir),
    resumeChildRun: childWorkflowRunResumer(),
    idempotencyScope: input.idempotencyScope,
    dynamicPlannerRunner: input.dynamicPlannerRunner,
  })
}

export async function tickControllerAfterWorkflowFailure(input: {
  runDir: string
  snapshot: MatOSWorkflowRunSnapshot
  definition: MatOSWorkflowDefinition
  armEventId: string
  readyNodeIds?: string[]
}): Promise<MatOSWorkflowRunSnapshot> {
  const policy = input.definition.policy.controller
  if (!policy || policy.enabled === false) return input.snapshot
  const nodeRuns = await listNodeRuns(input.runDir)
  const readyNodeIds =
    input.readyNodeIds ??
    readyWorkflowNodes({
      definition: input.definition,
      nodeRuns,
      parameters: input.snapshot.parameters,
    }).map(node => node.id)
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.controller.failure_tick_started',
    data: {
      runId: input.snapshot.runId,
      armEventId: input.armEventId,
      failedNodeIds: [...nodeRuns.values()]
        .filter(node => node.status === 'failed' || node.status === 'cancelled')
        .map(node => node.nodeId)
        .sort(),
    },
  })
  try {
    const advice = await adviseWorkflowReadySet({
      runDir: input.runDir,
      snapshot: input.snapshot,
      definition: input.definition,
      nodeRuns,
      readyNodeIds,
    })
    let current = await readWorkflowRun(input.runDir)
    if ((policy.mode ?? 'active') === 'shadow') {
      return current.status === 'failed'
        ? updateRunStatus(input.runDir, 'failed', {
            waitingNodeId: undefined,
          })
        : current
    }
    if (
      current.status === 'running' ||
      current.status === 'completed' ||
      current.status === 'cancelled'
    ) {
      return current
    }
    const status =
      advice.directive?.status ??
      (workflowControllerFailureMode(input.definition) === 'pause'
        ? 'paused'
        : 'failed')
    if (current.status !== status || status === 'failed') {
      current = await updateRunStatus(input.runDir, status, {
        waitingNodeId: undefined,
      })
    }
    // Log the observed outcome, not the intent: updateRunStatus rejects
    // terminal->paused transitions and returns the unchanged snapshot, and a
    // `recovery_paused` event for a run that stayed `failed` misleads
    // operators and agents reading the event stream.
    await appendWorkflowEvent(input.runDir, {
      type: `workflow.controller.recovery_${current.status}`,
      data: {
        runId: current.runId,
        ...(current.status !== status ? { requestedStatus: status } : {}),
        reason:
          advice.directive?.reason ??
          'controller did not produce an applicable native recovery action',
      },
    })
    return current
  } catch (error) {
    const onFailure = workflowControllerFailureMode(input.definition)
    const message = redactWorkflowControllerFailureText(error, 500)
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.controller.recovery_failed',
      data: { runId: input.snapshot.runId, message },
    })
    if ((policy.mode ?? 'active') === 'shadow' || onFailure === 'baseline') {
      const current = await readWorkflowRun(input.runDir)
      return current.status === 'failed'
        ? updateRunStatus(input.runDir, 'failed', {
            waitingNodeId: undefined,
          })
        : current
    }
    const status = onFailure === 'fail' ? 'failed' : 'paused'
    const current = await readWorkflowRun(input.runDir)
    return current.status === status
      ? current
      : updateRunStatus(input.runDir, status, { waitingNodeId: undefined })
  }
}

async function advanceWorkflowRun(
  runDir: string,
  options: { dynamicPlannerRunner?: WorkflowDynamicPlannerRunner } = {},
): Promise<WorkflowRunView> {
  // Liveness heartbeat for observers (workflow_run action=wait/status, the
  // interactive run watcher): long node executions write no run state for
  // many minutes, and a SIGKILLed detached worker leaves run.json parked in
  // `running` forever. The stamp lets both cases be told apart.
  const stopHeartbeat = startWorkflowRunHeartbeat(runDir)
  try {
    return await advanceWorkflowRunSegment(runDir, options)
  } finally {
    stopHeartbeat()
  }
}

async function advanceWorkflowRunSegment(
  runDir: string,
  options: { dynamicPlannerRunner?: WorkflowDynamicPlannerRunner } = {},
): Promise<WorkflowRunView> {
  let definition = await readWorkflowDefinition(runDir)
  let snapshot = await readWorkflowRun(runDir)
  await readMatOSAlgorithmRunManifestForExecution(runDir, {
    runId: snapshot.runId,
    workflowRef: snapshot.workflowRef,
  })
  const workflowsDir = dirname(dirname(runDir))
  const workspaceDir = snapshot.workspaceDir
  if (!workspaceDir) {
    throw new Error(`Workflow run is missing workspaceDir: ${snapshot.runId}`)
  }
  const projectCwd = snapshot.projectCwd ?? workspaceDir
  const artifactRoot = snapshot.artifactRoot ?? join(runDir, 'artifacts-root')

  if (isStateMachineWorkflow(definition)) {
    const { advanceStateMachineWorkflowRun } = await import(
      './stateMachineRuntime.js'
    )
    return advanceStateMachineWorkflowRun({
      runDir,
      definition,
      dynamicPlannerRunner: options.dynamicPlannerRunner,
    })
  }

  if (snapshot.status === 'created') {
    snapshot = await updateRunStatus(runDir, 'running')
  }

  while (snapshot.status === 'running') {
    // Honor a cooperative cancel/pause request before scheduling more work so a
    // long run can be stopped between nodes without the requester needing to win
    // the run lock.
    const controlAction = await readWorkflowRunControlAction(runDir)
    if (
      controlAction === 'cancel' ||
      (await workflowRunLocalProcessCancelRequested(runDir))
    ) {
      return applyWorkflowRunCancel(runDir)
    }
    if (controlAction === 'pause') {
      return applyWorkflowRunPause(runDir)
    }
    definition = await readWorkflowDefinition(runDir)
    const nodeRuns = await listNodeRuns(runDir)
    if (allWorkflowNodesFinished(definition, nodeRuns)) {
      // allWorkflowNodesFinished counts `failed` as terminal, which is only
      // safe for failures consumed by a failure/always route. An unrouted
      // failed node can still surface here as `running`: failNode crashed
      // between marking the node failed and marking the run failed, and
      // recovery resumed the run. Without this check the run would be
      // laundered into `completed` despite the failure.
      const unroutedFailure = definition.nodes.find(
        node =>
          nodeRuns.get(node.id)?.status === 'failed' &&
          !hasFailureRouteFromNode(definition, node.id),
      )
      if (unroutedFailure) {
        snapshot = await updateRunStatus(runDir, 'failed', {
          waitingNodeId: undefined,
        })
        await appendWorkflowEvent(runDir, {
          type: 'workflow.run.failed',
          data: {
            runId: snapshot.runId,
            nodeId: unroutedFailure.id,
            reason: 'unrouted node failure detected at completion check',
          },
        })
        return inspectWorkflowRunView(runDir)
      }
      const artifacts = await readWorkflowArtifacts(runDir)
      const outputs = resolveWorkflowOutputs(
        definition,
        nodeRuns,
        snapshot.parameters,
        {
          artifactRoot,
          projectCwd: snapshot.projectCwd ?? snapshot.workspaceDir,
          runDir,
          runId: snapshot.runId,
          workspaceDir: snapshot.workspaceDir,
          workflowRef: snapshot.workflowRef,
        },
        artifacts,
      )
      await writeJson(join(runDir, 'outputs.json'), outputs)
      snapshot = await updateRunStatus(runDir, 'completed', {
        waitingNodeId: undefined,
        outputs,
      })
      await appendWorkflowEvent(runDir, {
        type: 'workflow.run.completed',
        data: { runId: snapshot.runId },
      })
      return inspectWorkflowRunView(runDir)
    }

    const budgetStop = await stopRunIfBudgetExhausted(runDir, definition)
    if (budgetStop) {
      return budgetStop
    }

    if (
      await skipBlockedNode(
        runDir,
        definition,
        nodeRuns,
        snapshot.parameters,
      )
    ) {
      snapshot = await readWorkflowRun(runDir)
      continue
    }

    const readyNodes = readyWorkflowNodes({
      definition,
      nodeRuns,
      parameters: snapshot.parameters,
    })
    let orderedReadyNodes = readyNodes
    if (
      definition.policy.controller &&
      definition.policy.controller.enabled !== false
    ) {
      try {
        const advice = await adviseWorkflowReadySet({
          runDir,
          snapshot,
          definition,
          nodeRuns,
          readyNodeIds: readyNodes.map(node => node.id),
        })
        if (advice.directive) {
          snapshot = await updateRunStatus(runDir, advice.directive.status, {
            waitingNodeId: undefined,
          })
          await appendWorkflowEvent(runDir, {
            type: `workflow.controller.run_${advice.directive.status}`,
            data: {
              runId: snapshot.runId,
              reason: advice.directive.reason,
            },
          })
          return inspectWorkflowRunView(runDir)
        }
        const readyById = new Map(readyNodes.map(node => [node.id, node]))
        orderedReadyNodes = advice.orderedNodeIds.map(nodeId => {
          const node = readyById.get(nodeId)
          if (!node) {
            throw new Error(`Workflow controller returned unknown ready node ${nodeId}`)
          }
          return node
        })
      } catch (error) {
        const policy = definition.policy.controller
        const onFailure = workflowControllerFailureMode(definition)
        const message = redactWorkflowControllerFailureText(error, 500)
        await appendWorkflowEvent(runDir, {
          type: 'workflow.controller.failed',
          data: { runId: snapshot.runId, message },
        })
        if (policy.mode !== 'shadow' && onFailure !== 'baseline') {
          const status = onFailure === 'fail' ? 'failed' : 'paused'
          snapshot = await updateRunStatus(runDir, status, {
            waitingNodeId: undefined,
          })
          return inspectWorkflowRunView(runDir)
        }
      }
    }
    const maxConcurrency = workflowMaxConcurrency(definition)
    const parallelBatch: MatOSWorkflowNode[] = []
    if (maxConcurrency > 1) {
      // At most one approval gate per batch: the run snapshot has a single
      // waitingNodeId slot, so two nodes concurrently entering
      // requestNodeApproval would overwrite each other's pointer and orphan
      // one gate (its approval is rejected by the waitingNodeId check while
      // the scheduler never re-dispatches waiting_approval nodes -> the run
      // stalls forever). Extra gates simply land in later batches once the
      // first one is decided.
      let approvalGateSeen = false
      for (const node of orderedReadyNodes.filter(nodeParallelSafe)) {
        if (parallelBatch.length >= maxConcurrency) {
          break
        }
        if (await nodeWillRequestApproval(runDir, definition, node)) {
          if (approvalGateSeen) {
            continue
          }
          approvalGateSeen = true
        }
        parallelBatch.push(node)
      }
    }
    if (parallelBatch.length > 1) {
      const controllerFailureArm = definition.policy.controller &&
        definition.policy.controller.enabled !== false
        ? await appendWorkflowEvent(runDir, {
            type: 'workflow.controller.failure_tick_armed',
            data: { nodeIds: parallelBatch.map(node => node.id) },
          })
        : undefined
      await appendWorkflowEvent(runDir, {
        type: 'workflow.scheduler.ready_set',
        data: {
          nodeIds: parallelBatch.map(node => node.id),
          maxConcurrency,
        },
      })
      for (const node of parallelBatch) {
        await appendWorkflowEvent(runDir, {
          type: 'workflow.scheduler.node_dispatched',
          data: { nodeId: node.id },
        })
      }
      // Wait for EVERY batch member to settle before touching run state.
      // Promise.all rejects on the first runNode rejection (bookkeeping IO
      // can throw outside runNode's internal catch), which would abandon the
      // in-flight siblings and — worse — unwind through withWorkflowRunLock
      // and release the run lock while they are still executing, re-opening
      // the mutual exclusion to a second advancer.
      const settled = await Promise.allSettled(
        parallelBatch.map(node =>
          runNode(runDir, node, {
            runId: snapshot.runId,
            artifactRoot,
            projectCwd,
            scopeRef: snapshot.trace?.scopeRef,
            workspaceDir,
            workflowsDir,
            definition,
            parameters: snapshot.parameters,
            startChildRun: childWorkflowRunStarter(runDir),
            resumeChildRun: childWorkflowRunResumer(),
            dynamicPlannerRunner: options.dynamicPlannerRunner,
          }),
        ),
      )
      const results: Awaited<ReturnType<typeof runNode>>[] = []
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value)
          continue
        }
        // A rejection escaped runNode, so its own failure bookkeeping did
        // not complete. Settle the node as failed (best-effort, honoring
        // failure routes) so the run records what happened instead of
        // leaving the node parked in `running`.
        const node = parallelBatch[index]!
        const record = await readNodeRun(runDir, node.id).catch(() => undefined)
        await writeNodeAttempt({
          runDir,
          nodeId: node.id,
          attempt: record?.attempts && record.attempts > 0 ? record.attempts : 1,
          status: 'failed',
          startedAt: record?.startedAt,
          finishedAt: nowIso(),
          idempotencyKey: record?.idempotencyKey,
          sideEffect: attemptSideEffectForNode(
            node,
            undefined,
            record?.attempts ?? 1,
          ),
          error: workflowNodeErrorInfo(outcome.reason),
        }).catch(() => {})
        const routedFailure = hasFailureRouteFromNode(definition, node.id)
        await failNode(runDir, node, outcome.reason, {
          failRun: !routedFailure,
        }).catch(() => {})
        results.push(routedFailure ? 'continue' : 'failed')
      }
      snapshot = await readWorkflowRun(runDir)
      if (results.some(result => result === 'failed')) {
        // failNode may already have marked the run failed before this point,
        // so the tick must run ahead of the not-running early return or an
        // armed controller never gets its recovery chance. The tick leaves
        // cancelled/completed runs untouched.
        snapshot = await tickControllerAfterWorkflowFailure({
          runDir,
          snapshot,
          definition,
          armEventId: controllerFailureArm?.id ?? 'controller-failure-arm:missing',
        })
        if (snapshot.status === 'running') continue
        return inspectWorkflowRunView(runDir)
      }
      if (snapshot.status !== 'running') {
        return inspectWorkflowRunView(runDir)
      }
      if (results.some(result => result === 'waiting')) {
        if (controllerFailureArm) {
          await appendWorkflowEvent(runDir, {
            type: 'workflow.controller.failure_tick_disarmed',
            data: { armEventId: controllerFailureArm.id },
          })
        }
        return inspectWorkflowRunView(runDir)
      }
      if (controllerFailureArm) {
        await appendWorkflowEvent(runDir, {
          type: 'workflow.controller.failure_tick_disarmed',
          data: { armEventId: controllerFailureArm.id },
        })
      }
      continue
    }

    const next = orderedReadyNodes[0]
    if (!next) {
      // No runnable node. This is legitimate while something is in flight or
      // waiting on external input/approval. But if every non-terminal node is
      // merely pending and none can be scheduled or skipped, the run is
      // deadlocked and would otherwise hang in `running` forever. Fail loudly.
      const inFlightOrWaiting = definition.nodes.some(node => {
        const status = nodeRuns.get(node.id)?.status ?? 'pending'
        return (
          status === 'running' ||
          status === 'ready' ||
          status === 'waiting_input' ||
          status === 'waiting_approval'
        )
      })
      if (!inFlightOrWaiting) {
        const blockedNodeIds = definition.nodes
          .filter(node => {
            const status = nodeRuns.get(node.id)?.status ?? 'pending'
            return (
              status !== 'completed' &&
              status !== 'failed' &&
              status !== 'skipped' &&
              status !== 'cancelled'
            )
          })
          .map(node => node.id)
        await appendWorkflowEvent(runDir, {
          type: 'workflow.run.stalled',
          data: { runId: snapshot.runId, blockedNodeIds },
        })
        snapshot = await updateRunStatus(runDir, 'failed', {
          waitingNodeId: undefined,
        })
        return inspectWorkflowRunView(runDir)
      }
      // The run can reach this point as `running` while a node still sits at
      // an approval/input gate whose run-level pointer was lost (e.g. two
      // concurrent gates raced for the single waitingNodeId slot, then the
      // surviving one was approved). Re-surface the remaining gate on the run
      // snapshot so approve/respond APIs (which key off run status +
      // waitingNodeId) stay reachable instead of the run idling in `running`
      // with no live work. Only when nothing is genuinely in flight: an
      // orphaned `running`/`ready` node belongs to resume/recovery, not to a
      // gate re-park. The gate is chosen deterministically — the still-valid
      // current pointer first, then definition order.
      if (snapshot.status === 'running') {
        const hasInFlightNode = definition.nodes.some(node => {
          const status = nodeRuns.get(node.id)?.status
          return status === 'running' || status === 'ready'
        })
        const nodeIsGate = (nodeId: string | undefined): boolean => {
          const status = nodeId ? nodeRuns.get(nodeId)?.status : undefined
          return status === 'waiting_approval' || status === 'waiting_input'
        }
        if (!hasInFlightNode) {
          const gate = nodeIsGate(snapshot.waitingNodeId)
            ? definition.nodes.find(node => node.id === snapshot.waitingNodeId)
            : definition.nodes.find(node => nodeIsGate(node.id))
          if (gate) {
            const gateStatus =
              nodeRuns.get(gate.id)?.status === 'waiting_approval'
                ? ('waiting_approval' as const)
                : ('waiting_input' as const)
            snapshot = await updateRunStatus(runDir, gateStatus, {
              waitingNodeId: gate.id,
            })
          }
        }
      }
      return inspectWorkflowRunView(runDir)
    }

    const controllerFailureArm = definition.policy.controller &&
      definition.policy.controller.enabled !== false
      ? await appendWorkflowEvent(runDir, {
          type: 'workflow.controller.failure_tick_armed',
          data: { nodeIds: [next.id] },
        })
      : undefined
    const result = await runNode(runDir, next, {
      runId: snapshot.runId,
      artifactRoot,
      projectCwd,
      scopeRef: snapshot.trace?.scopeRef,
      workspaceDir,
      workflowsDir,
      definition,
      parameters: snapshot.parameters,
      startChildRun: childWorkflowRunStarter(runDir),
      resumeChildRun: childWorkflowRunResumer(),
      dynamicPlannerRunner: options.dynamicPlannerRunner,
    })
    snapshot = await readWorkflowRun(runDir)
    if (result === 'failed') {
      // failNode may already have marked the run failed before this point,
      // so the tick must run ahead of the not-running early return or an
      // armed controller never gets its recovery chance. The tick leaves
      // cancelled/completed runs untouched.
      snapshot = await tickControllerAfterWorkflowFailure({
        runDir,
        snapshot,
        definition,
        armEventId: controllerFailureArm?.id ?? 'controller-failure-arm:missing',
      })
      if (snapshot.status === 'running') continue
      return inspectWorkflowRunView(runDir)
    }
    if (snapshot.status !== 'running') {
      return inspectWorkflowRunView(runDir)
    }
    if (result === 'waiting') {
      if (controllerFailureArm) {
        await appendWorkflowEvent(runDir, {
          type: 'workflow.controller.failure_tick_disarmed',
          data: { armEventId: controllerFailureArm.id },
        })
      }
      return inspectWorkflowRunView(runDir)
    }
    if (controllerFailureArm) {
      await appendWorkflowEvent(runDir, {
        type: 'workflow.controller.failure_tick_disarmed',
        data: { armEventId: controllerFailureArm.id },
      })
    }
  }

  return inspectWorkflowRunView(runDir)
}

export async function startWorkflowRun(
  input: StartWorkflowRunInput,
): Promise<WorkflowRunView> {
  const childDepth = input.childDepth ?? 0
  const maxChildDepth = workflowMaxChildDepth()
  if (childDepth > maxChildDepth) {
    throw new Error(
      `Workflow child-run depth ${childDepth} exceeds the maximum of ${maxChildDepth} for ${input.workflowRef}. ` +
        'This usually means workflows recurse into each other (for example A -> B -> A) through subworkflow/map/loop nodes. ' +
        'Break the cycle, or raise MATOS_WORKFLOW_MAX_CHILD_DEPTH if the nesting is intentional.',
    )
  }
  const compiled = compileMatOSWorkflowDefinition(input.definition, {
    workflowRef: input.workflowRef,
    allowReviewedHighRiskBypass: input.trustedReviewedHighRiskBypass,
  })
  const definition = compiled.definition
  const run = await createWorkflowRun({
    workflowsDir: input.workflowsDir,
    workflowRunsDir: input.workflowRunsDir,
    workflowRef: input.workflowRef,
    parameters: resolveWorkflowParameters(definition, input.parameters),
    graphSnapshot: definition,
    projectCwd: input.cwd ?? input.workspaceDir,
    workspaceDir: input.workspaceDir,
    ...(childDepth > 0 ? { childDepth } : {}),
    provenance: input.provenance,
  })
  await input.onCreated?.({ runId: run.runId, runDir: run.dir })

  // Deferred-start mode: leave the persisted run in `created` state so a
  // detached worker process can advance it via resumeWorkflowRun. Used by
  // agent tool calls that must not block their turn on long workflows.
  if (input.advance === false) {
    return inspectWorkflowRun(run.dir)
  }

  // Hold the run lock for the initial advance so a concurrent mutation
  // (approve/patch/resume/recover) cannot interleave with the first execution
  // segment. The lock dir lives under the freshly created run dir; a longer
  // acquisition timeout covers the narrow race where a detached
  // resume/recover worker observed the persisted run and grabbed the lock
  // between creation and this advance.
  return withWorkflowRunLock(
    run.dir,
    () =>
      advanceWorkflowRun(run.dir, {
        dynamicPlannerRunner: input.dynamicPlannerRunner,
      }),
    { owner: 'workflow.start', timeoutMs: 30_000 },
  )
}

function singleNodeDebugProvenance(
  input: StartWorkflowSingleNodeRunInput,
): StartWorkflowSingleNodeRunInput['provenance'] {
  return {
    source: 'debug',
    reason: input.provenance?.reason ?? `debug workflow node ${input.nodeId}`,
    metadata: {
      ...(input.provenance?.metadata ?? {}),
      mode: 'single-node-debug',
      nodeId: input.nodeId,
      ...(input.provenance
        ? {
            originalProvenance: input.provenance,
          }
        : {}),
    },
  }
}

export async function startWorkflowSingleNodeRun(
  input: StartWorkflowSingleNodeRunInput,
): Promise<WorkflowRunView> {
  const compiled = compileMatOSWorkflowDefinition(input.definition, {
    workflowRef: input.workflowRef,
    allowReviewedHighRiskBypass: input.trustedReviewedHighRiskBypass,
  })
  const definition = compiled.definition
  const node = definition.nodes.find(item => item.id === input.nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${input.nodeId}`)
  }
  const parameters = resolveWorkflowParameters(definition, input.parameters)
  const run = await createWorkflowRun({
    workflowsDir: input.workflowsDir,
    workflowRunsDir: input.workflowRunsDir,
    workflowRef: input.workflowRef,
    parameters,
    graphSnapshot: definition,
    projectCwd: input.cwd ?? input.workspaceDir,
    workspaceDir: input.workspaceDir,
    provenance: singleNodeDebugProvenance(input),
  })

  return withWorkflowRunLock(run.dir, async () => {
    const snapshot = await updateRunStatus(run.dir, 'running')
    await appendWorkflowEvent(run.dir, {
      type: 'workflow.node_debug.started',
      data: {
        runId: run.runId,
        workflowRef: input.workflowRef,
        nodeId: input.nodeId,
      },
    })
    const result = await runWorkflowSingleNode({
      runDir: run.dir,
      node,
      runId: run.runId,
      artifactRoot: snapshot.artifactRoot ?? join(run.dir, 'artifacts-root'),
      projectCwd: snapshot.projectCwd ?? input.cwd ?? input.workspaceDir,
      scopeRef: snapshot.trace?.scopeRef,
      workspaceDir: snapshot.workspaceDir ?? input.workspaceDir,
      workflowsDir: input.workflowsDir,
      definition,
      parameters,
      idempotencyScope: {
        mode: 'single-node-debug',
        nodeId: input.nodeId,
      },
      dynamicPlannerRunner: input.dynamicPlannerRunner,
    })

    if (result === 'continue') {
      const nodeRun = await readNodeRun(run.dir, node.id)
      const output = nodeRun?.output
      if (nodeRun?.status === 'failed' || nodeRun?.status === 'cancelled') {
        await updateRunStatus(run.dir, 'failed', {
          waitingNodeId: undefined,
        })
        await appendWorkflowEvent(run.dir, {
          type: 'workflow.node_debug.failed',
          data: {
            runId: run.runId,
            workflowRef: input.workflowRef,
            nodeId: input.nodeId,
            status: nodeRun.status,
            error: nodeRun.error,
          },
        })
      } else {
        const outputs = {
          nodeId: node.id,
          output,
          [node.id]: output,
        }
        await writeJson(join(run.dir, 'outputs.json'), outputs)
        await updateRunStatus(run.dir, 'completed', {
          waitingNodeId: undefined,
          outputs,
        })
        await appendWorkflowEvent(run.dir, {
          type: 'workflow.node_debug.completed',
          data: {
            runId: run.runId,
            workflowRef: input.workflowRef,
            nodeId: input.nodeId,
          },
        })
      }
    } else {
      await appendWorkflowEvent(run.dir, {
        type:
          result === 'waiting'
            ? 'workflow.node_debug.waiting'
            : 'workflow.node_debug.failed',
        data: {
          runId: run.runId,
          workflowRef: input.workflowRef,
          nodeId: input.nodeId,
        },
      })
    }

    return inspectWorkflowRunView(run.dir)
  })
}

export async function respondToWorkflowNode(
  input: RespondToWorkflowNodeInput,
): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(input.runDir)
  const runPointsHere =
    snapshot.status === 'waiting_input' &&
    snapshot.waitingNodeId === input.nodeId
  if (!runPointsHere) {
    // Same single-slot rationale as approveWorkflowNode: a node parked at
    // waiting_input whose run-level pointer was overwritten by a concurrent
    // gate must still accept its response.
    const nodeRun = await readNodeRun(input.runDir, input.nodeId)
    if (nodeRun?.status !== 'waiting_input') {
      throw new Error(`Workflow run is not waiting for node: ${input.nodeId}`)
    }
  }

  const definition = await readWorkflowDefinition(input.runDir)
  const node = definition.nodes.find(node => node.id === input.nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${input.nodeId}`)
  }

  const response = await validateWorkflowHumanResponse({
    runDir: input.runDir,
    node,
    response: input.response,
  })

  await writeWorkflowHumanResponse(input.runDir, input.nodeId, response)
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.human.responded',
    data: { nodeId: input.nodeId, response },
  })
  const current = await readNodeRun(input.runDir, input.nodeId)
  const contractValidation = assertWorkflowNodeOutputContract(node, response)
  await writeNodeAttempt({
    runDir: input.runDir,
    nodeId: input.nodeId,
    attempt: current?.attempts ?? 1,
    status: 'completed',
    startedAt: current?.startedAt ?? nowIso(),
    finishedAt: nowIso(),
    idempotencyKey: current?.idempotencyKey,
    output: response,
    contractValidation,
    sideEffect: attemptSideEffectForNode(node, response, current?.attempts ?? 1),
  })
  await completeNode(input.runDir, node, response)
  await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
  return advanceWorkflowRun(input.runDir)
}

export async function approveWorkflowNode(
  input: ApproveWorkflowNodeInput,
): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(input.runDir)
  const runPointsHere =
    snapshot.status === 'waiting_approval' &&
    snapshot.waitingNodeId === input.nodeId
  if (!runPointsHere) {
    // The run snapshot has a single waitingNodeId slot. A node that lost a
    // race for it (two concurrent approval gates) is still legitimately
    // parked at waiting_approval with a pending request; accept its approval
    // too rather than leaving the gate undischargeable.
    const nodeRun = await readNodeRun(input.runDir, input.nodeId)
    if (nodeRun?.status !== 'waiting_approval') {
      throw new Error(
        `Workflow run is not waiting for approval: ${input.nodeId}`,
      )
    }
  }

  const definition = await readWorkflowDefinition(input.runDir)
  const node = definition.nodes.find(node => node.id === input.nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${input.nodeId}`)
  }

  const approval = await readApprovalRequest(input.runDir, input.nodeId)
  if (!approval || approval.status !== 'pending') {
    throw new Error(`Workflow approval request not found: ${input.nodeId}`)
  }
  if (
    input.approvedFingerprint &&
    input.approvedFingerprint !== approval.actionFingerprint
  ) {
    throw new Error(`Workflow approval fingerprint mismatch: ${input.nodeId}`)
  }

  const approved: WorkflowApprovalRequest = {
    ...approval,
    status: 'approved',
    decidedAt: nowIso(),
    response: input.response,
  }
  await writeJson(approvalPath(input.runDir, input.nodeId), approved)
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.approval.accepted',
    data: approved,
  })
  await markNode(input.runDir, node, 'pending')
  await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
  return advanceWorkflowRun(input.runDir)
}

export async function denyWorkflowNode(
  input: DenyWorkflowNodeInput,
): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(input.runDir)
  const runPointsHere =
    snapshot.status === 'waiting_approval' &&
    snapshot.waitingNodeId === input.nodeId
  if (!runPointsHere) {
    // Mirror approveWorkflowNode: a gate that lost the single-slot
    // waitingNodeId race must remain deniable as well.
    const nodeRun = await readNodeRun(input.runDir, input.nodeId)
    if (nodeRun?.status !== 'waiting_approval') {
      throw new Error(
        `Workflow run is not waiting for approval: ${input.nodeId}`,
      )
    }
  }

  const definition = await readWorkflowDefinition(input.runDir)
  const node = definition.nodes.find(node => node.id === input.nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${input.nodeId}`)
  }

  const approval = await readApprovalRequest(input.runDir, input.nodeId)
  if (!approval || approval.status !== 'pending') {
    throw new Error(`Workflow approval request not found: ${input.nodeId}`)
  }

  const denied: WorkflowApprovalRequest = {
    ...approval,
    status: 'denied',
    decidedAt: nowIso(),
    reason: input.reason ?? 'denied',
  }
  await writeJson(approvalPath(input.runDir, input.nodeId), denied)
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.approval.denied',
    data: denied,
  })

  if (node.policy?.onDeny === 'skip') {
    await markNode(input.runDir, node, 'skipped', {
      output: { denied: true, reason: denied.reason },
    })
    await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
    return advanceWorkflowRun(input.runDir)
  }

  await failNode(input.runDir, node, `Approval denied: ${denied.reason}`)
  return inspectWorkflowRun(input.runDir)
}

function patchSourceNodeId(patch: WorkflowGraphPatchLedgerView): string {
  const nodeId = patch.candidate?.sourceNodeId
  if (!nodeId) {
    throw new Error(`Workflow graph patch source node missing: ${patch.patchId}`)
  }
  return nodeId
}

async function dynamicPatchWaitingNode(input: {
  runDir: string
  patch: WorkflowGraphPatchLedgerView
}): Promise<MatOSWorkflowNode> {
  const nodeId = patchSourceNodeId(input.patch)
  const snapshot = await readWorkflowRun(input.runDir)
  if (
    snapshot.status !== 'waiting_input' ||
    snapshot.waitingNodeId !== nodeId
  ) {
    throw new Error(`Workflow run is not waiting for dynamic patch: ${input.patch.patchId}`)
  }
  const definition = await readWorkflowDefinition(input.runDir)
  const node = definition.nodes.find(item => item.id === nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${nodeId}`)
  }
  if (node.type !== 'dynamic') {
    throw new Error(`Workflow patch source node is not dynamic: ${nodeId}`)
  }
  return node
}

export async function approveWorkflowGraphPatchForRun(input: {
  runDir: string
  patchId: string
  reason?: string
  decidedBy?: string
}): Promise<WorkflowGraphPatchRunDecisionResult> {
  await dynamicPatchWaitingNode({
    runDir: input.runDir,
    patch: await inspectWorkflowGraphPatchLedger(input.runDir, input.patchId),
  })
  const patch = await writeWorkflowGraphPatchDecision({
    runDir: input.runDir,
    patchId: input.patchId,
    status: 'approved',
    reason: input.reason,
    decidedBy: input.decidedBy ?? 'workflow.patch_approve',
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.dynamic_patch.approved',
    data: {
      patchId: patch.patchId,
      nodeId: patchSourceNodeId(patch),
      reason: input.reason,
      decidedBy: input.decidedBy ?? 'workflow.patch_approve',
    },
  })
  return {
    run: await inspectWorkflowRun(input.runDir),
    patch,
  }
}

export async function rejectWorkflowGraphPatchForRun(input: {
  runDir: string
  patchId: string
  reason?: string
  decidedBy?: string
}): Promise<WorkflowGraphPatchRunDecisionResult> {
  const node = await dynamicPatchWaitingNode({
    runDir: input.runDir,
    patch: await inspectWorkflowGraphPatchLedger(input.runDir, input.patchId),
  })
  const patch = await writeWorkflowGraphPatchDecision({
    runDir: input.runDir,
    patchId: input.patchId,
    status: 'rejected',
    reason: input.reason ?? 'rejected',
    decidedBy: input.decidedBy ?? 'workflow.patch_reject',
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.dynamic_patch.rejected',
    data: {
      patchId: patch.patchId,
      nodeId: node.id,
      reason: input.reason ?? 'rejected',
      decidedBy: input.decidedBy ?? 'workflow.patch_reject',
    },
  })
  await markNode(input.runDir, node, 'failed', {
    error: { message: `Dynamic workflow patch rejected: ${input.reason ?? 'rejected'}` },
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.node.failed',
    data: {
      nodeId: node.id,
      error: `Dynamic workflow patch rejected: ${input.reason ?? 'rejected'}`,
      routed: false,
    },
  })
  await updateRunStatus(input.runDir, 'failed', { waitingNodeId: undefined })
  return {
    run: await inspectWorkflowRun(input.runDir),
    patch,
  }
}

export async function applyWorkflowGraphPatchForRun(input: {
  runDir: string
  patchId: string
  reason?: string
  decidedBy?: string
}): Promise<WorkflowGraphPatchRunDecisionResult> {
  const ledger = await readWorkflowGraphPatchLedgerPayload(
    input.runDir,
    input.patchId,
  )
  if (ledger.decision?.status !== 'approved') {
    throw new Error(
      `Workflow graph patch must be approved before apply: ${ledger.patchId}`,
    )
  }
  const node = await dynamicPatchWaitingNode({ runDir: input.runDir, patch: ledger })
  const currentDefinition = await readWorkflowDefinition(input.runDir)
  const run = await readWorkflowRun(input.runDir)
  const validation = validateWorkflowGraphPatchCandidate(
    currentDefinition,
    ledger.candidate,
    { knownParameterIds: Object.keys(run.parameters ?? {}) },
  )
  if (!validation.ok || !validation.patchedDefinition) {
    await writeWorkflowGraphPatchDecision({
      runDir: input.runDir,
      patchId: ledger.patchId,
      status: 'rejected',
      reason: validation.errors.map(error => error.message).join('; '),
      decidedBy: 'workflow.patch_apply.validation',
    })
    throw new Error(
      `Dynamic workflow patch validation failed: ${validation.errors
        .map(error => error.message)
        .join('; ')}`,
    )
  }

  // Route the accepted patch through the same compile step the run snapshot
  // originally went through (startWorkflowRun): semantic node types
  // (compute/instrument/validate/approval_gate/supernode) are lowered to
  // runtime types the executor registry can dispatch, and
  // node.incomingEdges/dependsOn are rebuilt from the patched edge list so
  // the scheduler honors patch-added routes and conditions. Persisting the
  // raw patched definition used to crash dispatch on semantic nodes and
  // silently skip nodes reachable only via patch-added routed edges.
  const compiledPatch = compileMatOSWorkflowDefinition(
    validation.patchedDefinition,
    {
      workflowRef: run.workflowRef,
      // Preserve the operator-granted reviewed-high-risk trust of the
      // running snapshot: recompiling must neither drop nor grant it.
      allowReviewedHighRiskBypass:
        currentDefinition.compiled?.reviewedHighRiskBypassTrusted === true,
      // The run may legitimately reference resolved run parameters; without
      // them the compile-side validation flags spurious unknown-parameter
      // errors that would now (correctly) reject the patch below.
      knownParameterIds: Object.keys(run.parameters ?? {}),
    },
  )
  if (!compiledPatch.ok) {
    // The compiled snapshot is what actually executes; persisting one whose
    // own validation failed would run a graph no gate accepted. Reject like
    // a validation failure and record the rejection on the ledger.
    const reason = `compiled patch snapshot failed validation: ${
      compiledPatch.diagnostics
        .filter(diagnostic => diagnostic.severity === 'error')
        .map(diagnostic => diagnostic.message)
        .join('; ') || 'unknown compile error'
    }`
    await writeWorkflowGraphPatchDecision({
      runDir: input.runDir,
      patchId: ledger.patchId,
      status: 'rejected',
      reason,
      decidedBy: 'workflow.patch_apply.compile',
    })
    throw new Error(`Dynamic workflow patch validation failed: ${reason}`)
  }

  const written = await writeWorkflowGraphPatchApplication({
    runDir: input.runDir,
    candidate: ledger.candidate!,
    before: currentDefinition,
    after: compiledPatch.definition,
    scopeRef: run.trace?.scopeRef ?? 'user:local',
    allowDynamicMutation: true,
    decidedBy: input.decidedBy ?? 'workflow.patch_apply',
    reason: input.reason,
  })
  const graphSnapshotPath = basename(written.graphSnapshotPath)
  // Keyed-mutex RMW: a bare writeWorkflowRun here raced concurrent
  // updateRunStatus writers and could resurrect a stale snapshot.
  await updateRunFields(input.runDir, { graphSnapshotPath })
  const output = {
    ok: true,
    patchId: ledger.patchId,
    status: 'applied',
    graphHash: written.graphHash,
    graphSnapshotPath,
  }
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.dynamic_patch.applied',
    data: {
      patchId: ledger.patchId,
      nodeId: node.id,
      graphHash: written.graphHash,
      graphSnapshotPath,
      decidedBy: input.decidedBy ?? 'workflow.patch_apply',
    },
  })
  const current = await readNodeRun(input.runDir, node.id)
  const contractValidation = assertWorkflowNodeOutputContract(node, output)
  await writeNodeAttempt({
    runDir: input.runDir,
    nodeId: node.id,
    attempt: current?.attempts ?? 1,
    status: 'completed',
    startedAt: current?.startedAt ?? nowIso(),
    finishedAt: nowIso(),
    idempotencyKey: current?.idempotencyKey,
    output,
    contractValidation,
    sideEffect: attemptSideEffectForNode(node, output, current?.attempts ?? 1),
  })
  await completeNode(input.runDir, node, output)
  await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
  await advanceWorkflowRun(input.runDir)
  return {
    run: await inspectWorkflowRun(input.runDir),
    patch: await inspectWorkflowGraphPatchLedger(input.runDir, input.patchId),
  }
}

export async function inspectWorkflowRun(
  runDir: string,
): Promise<WorkflowRunView> {
  return inspectWorkflowRunView(runDir)
}

export async function inspectWorkflowApprovalStatus(
  runDir: string,
): Promise<WorkflowApprovalStatusView> {
  const run = await inspectWorkflowRun(runDir)
  return {
    run,
    approvals: run.approvals ?? [],
    pendingApprovals: run.pendingApprovals ?? [],
  }
}

async function applyWorkflowRunPause(runDir: string): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(runDir)
  if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    await clearWorkflowRunControl(runDir)
    return inspectWorkflowRunView(runDir)
  }
  const paused = await updateRunStatus(runDir, 'paused')
  await appendWorkflowEvent(runDir, {
    type: 'workflow.run.paused',
    data: { runId: paused.runId },
  })
  await clearWorkflowRunControl(runDir)
  return inspectWorkflowRunView(runDir)
}

export async function pauseWorkflowRun(runDir: string): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(runDir)
  if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    throw new Error(`Workflow run cannot be paused from status: ${snapshot.status}`)
  }
  return applyWorkflowRunPause(runDir)
}

// Pause a run that may be actively advancing under another holder. Applies
// immediately when idle; otherwise leaves a cooperative marker the advance loop
// honors at the next node boundary.
export async function requestWorkflowRunPause(
  runDir: string,
): Promise<WorkflowRunView> {
  // Preserve the user-facing contract that pausing a terminal run is an error.
  const snapshot = await readWorkflowRun(runDir)
  if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    throw new Error(`Workflow run cannot be paused from status: ${snapshot.status}`)
  }
  const attempt = await tryWithWorkflowRunLock(
    runDir,
    () => applyWorkflowRunPause(runDir),
    { owner: 'workflow.pause', timeoutMs: 2000 },
  )
  if (attempt.acquired) {
    return attempt.value
  }
  await requestWorkflowRunControl(runDir, 'pause')
  const retry = await tryWithWorkflowRunLock(
    runDir,
    () => applyWorkflowRunPause(runDir),
    { owner: 'workflow.pause', timeoutMs: 2000 },
  )
  return retry.acquired ? retry.value : inspectWorkflowRunView(runDir)
}

export async function reconcileWorkflowRunComputeJobs(
  runDir: string,
): Promise<WorkflowComputeReconcileResult> {
  const snapshot = await readWorkflowRun(runDir)
  const definition = await readWorkflowDefinition(runDir).catch(() => undefined)
  const projectCwd = snapshot.projectCwd ?? snapshot.workspaceDir
  const reconciled =
    definition && projectCwd
      ? await reconcileComputeJobsForWorkflowRun({
          runDir,
          definition,
          projectCwd,
          nodeRuns: await listNodeRuns(runDir),
          source: 'manual_reconcile',
          updateNodeOutput: async (node, nodeRun, output) => {
            await markNode(runDir, node, nodeRun.status, { output })
          },
        })
      : []
  return {
    run: await inspectWorkflowRun(runDir),
    reconciled,
  }
}

export async function applyWorkflowRecoveryRecommendation(
  runDir: string,
  options: {
    recommendedAction?: WorkflowRecoveryRecommendedAction
    expectedRecoveryDigest?: string
  } = {},
): Promise<WorkflowRecoveryApplyResult> {
  const baselineRecovery = await recoverWorkflowRun(runDir)
  if (
    options.expectedRecoveryDigest &&
    workflowRecoveryReportDigest(baselineRecovery) !==
      options.expectedRecoveryDigest
  ) {
    throw new Error('Workflow recovery observation changed before action apply')
  }
  const safeActions = new Set(
    workflowRecoverySafeAlternativeActions(baselineRecovery),
  )
  const selectedAction = options.recommendedAction
  const recovery = {
    ...baselineRecovery,
    recommendedAction:
      selectedAction && safeActions.has(selectedAction)
        ? selectedAction
        : baselineRecovery.recommendedAction,
  }
  const selectedAlternative =
    selectedAction !== undefined &&
    selectedAction !== baselineRecovery.recommendedAction

  // Preserve the historical baseline apply behavior exactly. A custom policy
  // may choose one of the additional fail-safe actions exposed by the recovery
  // classifier; those actions must have an observable effect instead of being
  // reported as selected and then silently collapsing to `none`.
  if (
    selectedAlternative &&
    (recovery.recommendedAction === 'request_human_review' ||
      recovery.recommendedAction === 'wait')
  ) {
    const run = ['completed', 'failed', 'cancelled'].includes(
      baselineRecovery.status,
    )
      ? await inspectWorkflowRunView(runDir)
      : await applyWorkflowRunPause(runDir)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.applied',
      data: {
        classification: recovery.classification,
        action: recovery.recommendedAction,
        nodeId: recovery.nodeId,
        source: 'algorithm-policy',
      },
    })
    return {
      recovery,
      appliedAction: recovery.recommendedAction,
      run,
    }
  }

  if (selectedAlternative && recovery.recommendedAction === 'fail') {
    if (!['completed', 'failed', 'cancelled'].includes(baselineRecovery.status)) {
      await updateRunStatus(runDir, 'failed', { waitingNodeId: undefined })
    }
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.applied',
      data: {
        classification: recovery.classification,
        action: recovery.recommendedAction,
        nodeId: recovery.nodeId,
        source: 'algorithm-policy',
      },
    })
    return {
      recovery,
      appliedAction: recovery.recommendedAction,
      run: await inspectWorkflowRunView(runDir),
    }
  }

  if (recovery.recommendedAction === 'reconcile_compute') {
    const reconciled = await reconcileWorkflowRunComputeJobs(runDir)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.applied',
      data: {
        classification: recovery.classification,
        action: recovery.recommendedAction,
        nodeId: recovery.nodeId,
        reconciled: reconciled.reconciled,
      },
    })
    return {
      recovery,
      appliedAction: recovery.recommendedAction,
      run: reconciled.run,
      reconciled: reconciled.reconciled,
    }
  }

  if (recovery.recommendedAction === 'retry_remote_cancel') {
    const snapshot = await readWorkflowRun(runDir)
    const definition = await readWorkflowDefinition(runDir).catch(() => undefined)
    const projectCwd = snapshot.projectCwd ?? snapshot.workspaceDir
    const remoteCancels =
      definition && projectCwd
        ? await cancelComputeJobsForWorkflowRun({
            runDir,
            definition,
            projectCwd,
            nodeRuns: await listNodeRuns(runDir),
            source: 'recovery_retry_remote_cancel',
            updateNodeOutput: async (node, nodeRun, output) => {
              await markNode(runDir, node, nodeRun.status, { output })
            },
          })
        : []
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.applied',
      data: {
        classification: recovery.classification,
        action: recovery.recommendedAction,
        nodeId: recovery.nodeId,
        remoteCancels,
      },
    })
    return {
      recovery,
      appliedAction: recovery.recommendedAction,
      run: await inspectWorkflowRun(runDir),
      remoteCancels,
    }
  }

  if (recovery.recommendedAction === 'resume') {
    const run = await resumeWorkflowRun(runDir)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.applied',
      data: {
        classification: recovery.classification,
        action: recovery.recommendedAction,
        nodeId: recovery.nodeId,
      },
    })
    return { recovery, appliedAction: recovery.recommendedAction, run }
  }

  if (recovery.recommendedAction === 'retry_node' && recovery.nodeId) {
    const run = await retryWorkflowNode({
      runDir,
      nodeId: recovery.nodeId,
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.applied',
      data: {
        classification: recovery.classification,
        action: recovery.recommendedAction,
        nodeId: recovery.nodeId,
      },
    })
    return { recovery, appliedAction: recovery.recommendedAction, run }
  }

  return {
    recovery,
    appliedAction: 'none',
    run: await inspectWorkflowRun(runDir),
  }
}

/**
 * Reset in-flight `running` nodes that were orphaned by a killed runner
 * process. Resume holds the run lock, so a node persisted as `running` has no
 * live executor and would otherwise leave the run stuck in `running` forever.
 * Only nodes whose side-effect summary replays via `rerun` (local process,
 * model call, no-op) are reset; external-backend work goes through the
 * receipt reconcile path instead of a blind resubmit, and child-run carriers
 * (`map`/`subworkflow`) keep their persisted children.
 */
async function resetOrphanedInFlightNodes(
  runDir: string,
  definition: MatOSWorkflowDefinition,
): Promise<string[]> {
  const nodeRuns = await listNodeRuns(runDir)
  const resetIds: string[] = []
  for (const node of definition.nodes) {
    const record = nodeRuns.get(node.id)
    if (record?.status !== 'running') {
      continue
    }
    const sideEffect = attemptSideEffectForNode(
      node,
      record.output,
      record.attempts,
    )
    if (sideEffect.replayStrategy !== 'rerun') {
      continue
    }
    await resetNodeRun(runDir, node.id)
    resetIds.push(node.id)
  }
  if (resetIds.length > 0) {
    await appendWorkflowEvent(runDir, {
      type: 'workflow.recovery.node_reset',
      data: { nodeIds: resetIds, reason: 'interrupted_in_flight' },
    })
  }
  return resetIds
}

// Persisted at child-runs/<nodeId>.json by the subworkflow executor when the
// child run is created and again when it finishes (nodeExecutors.ts).
type PersistedChildRunMarker = {
  nodeId?: string
  workflowRef?: string
  childRunId?: string
  status?: string
  detachOnParentCancel?: boolean
}

async function readPersistedChildRunMarker(
  runDir: string,
  nodeId: string,
): Promise<PersistedChildRunMarker | undefined> {
  try {
    const value = await readJson<unknown>(join(runDir, 'child-runs', `${nodeId}.json`))
    return isRecord(value) ? (value as PersistedChildRunMarker) : undefined
  } catch {
    return undefined
  }
}

async function resetInterruptedChildCarrierNode(
  runDir: string,
  nodeId: string,
): Promise<void> {
  // resetNodeRun keeps the attempts counter, so the re-run is recorded as a
  // further attempt of the same node instead of erasing crash history.
  await resetNodeRun(runDir, nodeId)
  await appendWorkflowEvent(runDir, {
    type: 'workflow.recovery.node_reset',
    data: { nodeIds: [nodeId], reason: 'interrupted_child_carrier' },
  })
}

/**
 * Crash recovery for child-carrier nodes (`subworkflow`, `map`, `loop`) left
 * `running` by a killed runner process. resetOrphanedInFlightNodes
 * deliberately skips them (their side effect replays via `skip_completed`,
 * not `rerun`), but before this reconcile existed nothing else handled them
 * either: the advance loop treats an in-flight node as progress and returns,
 * recovery keeps recommending resume, and the run is deadlocked forever.
 *
 * - A subworkflow node with a persisted child-run marker is reconciled
 *   against the child run itself: a terminal child is adopted into the node
 *   (complete/fail/cancel exactly as the blocking executor would, including
 *   outputs), and a still-resumable child is resumed in-process first rather
 *   than restarted.
 * - A subworkflow node without a usable child record crashed before its
 *   child run was created, so it is safe to reset to pending and re-run.
 * - map/loop aggregates cannot be adopted from partial per-iteration records
 *   (their runners rebuild every iteration on re-run), so they reset to
 *   pending as well.
 * Completed sibling nodes are untouched and attempts counters are preserved
 * throughout.
 */
async function reconcileInterruptedChildCarrierNodes(
  runDir: string,
  definition: MatOSWorkflowDefinition,
): Promise<void> {
  const nodeRuns = await listNodeRuns(runDir)
  for (const node of definition.nodes) {
    const record = nodeRuns.get(node.id)
    if (record?.status !== 'running') {
      continue
    }
    if (node.type === 'subworkflow') {
      await reconcileInterruptedSubworkflowNode(runDir, definition, node, record)
    } else if (node.type === 'map' || node.type === 'loop') {
      await resetInterruptedChildCarrierNode(runDir, node.id)
    }
  }
}

async function reconcileInterruptedSubworkflowNode(
  runDir: string,
  definition: MatOSWorkflowDefinition,
  node: MatOSWorkflowNode,
  record: { attempts?: number; startedAt?: string; idempotencyKey?: string },
): Promise<void> {
  const marker = await readPersistedChildRunMarker(runDir, node.id)
  const childRunId =
    typeof marker?.childRunId === 'string' && marker.childRunId.trim().length > 0
      ? marker.childRunId
      : undefined
  // Child runs execute in sibling run dirs of the parent (see
  // cancelChildWorkflowRuns); resolve the persisted id the same way.
  const childRunDir = childRunId ? join(dirname(runDir), childRunId) : undefined
  let child = childRunDir
    ? await readWorkflowRun(childRunDir).catch(() => undefined)
    : undefined
  if (!childRunId || !childRunDir || !child) {
    // The crash happened before a child run was persisted (or the record is
    // unreadable). Nothing to adopt or resume: re-run the node from scratch.
    await resetInterruptedChildCarrierNode(runDir, node.id)
    return
  }

  if (!TERMINAL_RUN_STATUSES.has(child.status)) {
    // The child itself was interrupted (or never advanced). Resume it
    // in-process instead of starting a duplicate child run; this recurses
    // into the child's own orphaned/child-carrier nodes. A child that ends
    // up waiting for human input/approval stays non-terminal and is handled
    // like the blocking executor handles a non-completed child below.
    // The resume must hold the CHILD's run lock: a service-level resume of
    // the child can be advancing it concurrently, and two advancers would
    // dispatch the same child node twice. Contention means the child is
    // busy under another holder — fail the parent node with the structured
    // adoption guidance instead of double-driving the child.
    const resumed = await tryWithWorkflowRunLock(
      childRunDir,
      () => resumeWorkflowRun(childRunDir),
      {
        owner: 'workflow.child_resume',
        timeoutMs: CHILD_RUN_RESUME_LOCK_TIMEOUT_MS,
      },
    )
    if (!resumed.acquired) {
      const busyError = new WorkflowSubworkflowWaitingError(node.id, {
        runId: childRunId,
        status: child.status,
        waitingNodeId: child.waitingNodeId,
      })
      const busyAttempt =
        record.attempts && record.attempts > 0 ? record.attempts : 1
      const busyOutput = workflowSubworkflowNodeOutputForChildRun(node, {
        runId: childRunId,
        status: child.status,
        outputs: child.outputs,
      })
      await writeNodeAttempt({
        runDir,
        nodeId: node.id,
        attempt: busyAttempt,
        status: 'failed',
        startedAt: record.startedAt,
        finishedAt: nowIso(),
        idempotencyKey: record.idempotencyKey,
        output: busyOutput,
        sideEffect: attemptSideEffectForNode(node, busyOutput, busyAttempt),
        error: workflowNodeErrorInfo(busyError),
      })
      const routedBusyFailure = hasFailureRouteFromNode(definition, node.id)
      await failNodeWithOutput(runDir, node, busyError, busyOutput, {
        failRun: !routedBusyFailure,
      })
      return
    }
    child = (await readWorkflowRun(childRunDir).catch(() => undefined)) ?? child
  }

  // Refresh the marker with the observed child status, mirroring the
  // executor's post-run write, so later cancel/reconcile passes see it.
  await writeJson(join(runDir, 'child-runs', `${node.id}.json`), {
    nodeId: node.id,
    workflowRef: marker?.workflowRef,
    childRunId,
    status: child.status,
    detachOnParentCancel: node.policy?.detachOnParentCancel === true,
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.recovery.child_run_reconciled',
    data: { nodeId: node.id, childRunId, childStatus: child.status },
  })

  // Attempt bookkeeping: finalize the attempt the crashed process started
  // (runNode marked the node running with this attempts value) instead of
  // opening a new one — no new side effect happened.
  const attempt = record.attempts && record.attempts > 0 ? record.attempts : 1
  const output = workflowSubworkflowNodeOutputForChildRun(node, {
    runId: childRunId,
    status: child.status,
    outputs: child.outputs,
  })
  const sideEffect = attemptSideEffectForNode(node, output, attempt)

  if (child.status === 'completed') {
    let contractValidation
    try {
      contractValidation = assertWorkflowNodeOutputContract(node, output)
    } catch (error) {
      // Same semantics as the executor: a contract violation fails the node
      // (honoring failure routes) even though the child run completed.
      await writeNodeAttempt({
        runDir,
        nodeId: node.id,
        attempt,
        status: 'failed',
        startedAt: record.startedAt,
        finishedAt: nowIso(),
        idempotencyKey: record.idempotencyKey,
        output,
        sideEffect,
        error: workflowNodeErrorInfo(error),
      })
      const routedFailure = hasFailureRouteFromNode(definition, node.id)
      await failNodeWithOutput(runDir, node, error, output, {
        failRun: !routedFailure,
      })
      return
    }
    await writeNodeAttempt({
      runDir,
      nodeId: node.id,
      attempt,
      status: 'completed',
      startedAt: record.startedAt,
      finishedAt: nowIso(),
      idempotencyKey: record.idempotencyKey,
      output,
      contractValidation,
      sideEffect,
    })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.subworkflow.completed',
      data: {
        nodeId: node.id,
        workflowRef: marker?.workflowRef,
        childRunId,
        outputs: output.outputs,
      },
    })
    await completeNode(runDir, node, output)
    return
  }

  if (child.status === 'cancelled') {
    await writeNodeAttempt({
      runDir,
      nodeId: node.id,
      attempt,
      status: 'cancelled',
      startedAt: record.startedAt,
      finishedAt: nowIso(),
      idempotencyKey: record.idempotencyKey,
      output,
      sideEffect,
    })
    await markNode(runDir, node, 'cancelled', { output, sideEffect })
    await appendWorkflowEvent(runDir, {
      type: 'workflow.subworkflow.cancelled',
      data: {
        nodeId: node.id,
        workflowRef: marker?.workflowRef,
        childRunId,
      },
    })
    await updateRunStatus(runDir, 'cancelled', { waitingNodeId: undefined })
    return
  }

  // failed, or still non-terminal after the resume attempt (waiting for
  // input/approval, paused): the blocking executor fails the node for any
  // non-completed child, so adoption does the same. Retry policy is not
  // consulted here: this finalizes an already-observed terminal outcome, and
  // an operator can still retry the node explicitly afterwards.
  const error = new Error(
    `Subworkflow did not complete: ${node.id} (${child.status})`,
  )
  await writeNodeAttempt({
    runDir,
    nodeId: node.id,
    attempt,
    status: 'failed',
    startedAt: record.startedAt,
    finishedAt: nowIso(),
    idempotencyKey: record.idempotencyKey,
    output,
    sideEffect,
    error: workflowNodeErrorInfo(error),
  })
  const routedFailure = hasFailureRouteFromNode(definition, node.id)
  await failNodeWithOutput(runDir, node, error, output, {
    failRun: !routedFailure,
  })
}

/**
 * Re-park an interrupted gate node (human, or dynamic with a proposed patch)
 * at `waiting_input` and point the run snapshot back at it. The crashed
 * process died between the running-mark and the executor's own parking
 * writes; without this the node sits in `running` forever with no live
 * executor and the respond/approve APIs stay unreachable.
 */
async function reparkInterruptedGateNode(
  runDir: string,
  node: MatOSWorkflowNode,
  record: MatOSWorkflowNodeRunSnapshot,
  output: Record<string, unknown> | undefined,
): Promise<void> {
  const attempt = record.attempts && record.attempts > 0 ? record.attempts : 1
  // The prompt write is idempotent and may be missing if the crash hit
  // before the executor reached it.
  await writeWorkflowHumanPrompt(runDir, node).catch(() => {})
  await writeNodeAttempt({
    runDir,
    nodeId: node.id,
    attempt,
    status: 'waiting_input',
    startedAt: record.startedAt,
    finishedAt: nowIso(),
    idempotencyKey: record.idempotencyKey,
    ...(output !== undefined ? { output } : {}),
    sideEffect: attemptSideEffectForNode(node, output, attempt),
  })
  await markNode(
    runDir,
    node,
    'waiting_input',
    output !== undefined ? { output } : {},
  )
  await appendWorkflowEvent(runDir, {
    type: 'workflow.recovery.node_reparked',
    data: { nodeId: node.id, status: 'waiting_input' },
  })
  await updateRunStatus(runDir, 'waiting_input', { waitingNodeId: node.id })
}

/**
 * Crash recovery for a dynamic node left `running`: the patch ledger is the
 * durable record of how far the interrupted attempt got.
 * - Ledger `applied` and the run's graph is (or can be repaired to) that
 *   patch's output -> finalize the node as completed; the graph mutation
 *   already happened and re-planning would stack a second patch on top.
 * - Ledger `proposed` -> the attempt parked for review; re-park it.
 * - No ledger decision -> nothing durable happened; reset to pending and let
 *   the idempotent re-entry in runWorkflowDynamicNode guard the re-run.
 */
async function reconcileInterruptedDynamicNode(
  runDir: string,
  node: MatOSWorkflowNode,
  record: MatOSWorkflowNodeRunSnapshot,
): Promise<void> {
  const applied = await latestWorkflowGraphPatchForSourceNode(
    runDir,
    node.id,
    'applied',
  )
  if (applied?.decision) {
    const decision = applied.decision
    const snapshotName =
      typeof decision.graphSnapshotPath === 'string' &&
      decision.graphSnapshotPath.trim().length > 0
        ? decision.graphSnapshotPath
        : undefined
    const run = await readWorkflowRun(runDir)
    let graphMatches = false
    if (snapshotName && run.graphSnapshotPath === snapshotName) {
      graphMatches = true
    } else if (
      typeof decision.graphHash === 'string' &&
      decision.graphHash ===
        workflowGraphPatchGraphHash(await readWorkflowDefinition(runDir))
    ) {
      graphMatches = true
    } else if (snapshotName) {
      // The crash hit between the ledger/snapshot write and the run.json
      // pointer update. Completing the interrupted apply means repairing the
      // pointer — provided the persisted snapshot is actually readable.
      const repairable = await readJson<MatOSWorkflowDefinition>(
        join(runDir, snapshotName),
      )
        .then(() => true)
        .catch(() => false)
      if (repairable) {
        await updateRunFields(runDir, { graphSnapshotPath: snapshotName })
        graphMatches = true
      }
    }
    if (graphMatches) {
      const attempt =
        record.attempts && record.attempts > 0 ? record.attempts : 1
      const output: Record<string, unknown> = {
        ok: true,
        patchId: applied.patchId,
        status: 'applied',
        ...(applied.candidate?.risk ? { risk: applied.candidate.risk } : {}),
        ...(typeof decision.graphHash === 'string'
          ? { graphHash: decision.graphHash }
          : {}),
        ...(snapshotName ? { graphSnapshotPath: snapshotName } : {}),
        adoptedFromLedger: true,
      }
      await writeNodeAttempt({
        runDir,
        nodeId: node.id,
        attempt,
        status: 'completed',
        startedAt: record.startedAt,
        finishedAt: nowIso(),
        idempotencyKey: record.idempotencyKey,
        output,
        sideEffect: attemptSideEffectForNode(node, output, attempt),
      })
      await appendWorkflowEvent(runDir, {
        type: 'workflow.recovery.dynamic_patch_finalized',
        data: { nodeId: node.id, patchId: applied.patchId },
      })
      await completeNode(runDir, node, output)
      return
    }
  }

  const proposed = await latestWorkflowGraphPatchForSourceNode(
    runDir,
    node.id,
    'proposed',
  )
  if (proposed) {
    const output: Record<string, unknown> = {
      ok: true,
      patchId: proposed.patchId,
      status: 'proposed',
      ...(proposed.decision?.reason ? { reason: proposed.decision.reason } : {}),
      ...(proposed.candidate?.risk ? { risk: proposed.candidate.risk } : {}),
    }
    await reparkInterruptedGateNode(runDir, node, record, output)
    return
  }

  await resetNodeRun(runDir, node.id)
  await appendWorkflowEvent(runDir, {
    type: 'workflow.recovery.node_reset',
    data: { nodeIds: [node.id], reason: 'interrupted_in_flight' },
  })
}

/**
 * Settle a non-compute backend node left `running` by a killed process. Its
 * side-effect strategy is reconcile-before-resubmit, so a blind reset is
 * forbidden — but unlike compute nodes there is no receipt-based reconcile
 * either, so nothing else ever moves it out of `running` and the run
 * deadlocks. Record the interruption as a retryable failure (honoring
 * failure routes); an operator retry re-runs it deliberately.
 */
async function settleInterruptedBackendNode(
  runDir: string,
  definition: MatOSWorkflowDefinition,
  node: MatOSWorkflowNode,
  record: MatOSWorkflowNodeRunSnapshot,
): Promise<void> {
  const attempt = record.attempts && record.attempts > 0 ? record.attempts : 1
  const error = Object.assign(
    new Error(
      `Backend node was interrupted before completion: ${node.id}. ` +
        'The interrupted attempt may or may not have reached the backend; ' +
        'verify the backend state, then retry the node (workflow_run action=retry_node).',
    ),
    { code: 'backend_interrupted', retryable: true },
  )
  await writeNodeAttempt({
    runDir,
    nodeId: node.id,
    attempt,
    status: 'failed',
    startedAt: record.startedAt,
    finishedAt: nowIso(),
    idempotencyKey: record.idempotencyKey,
    sideEffect: attemptSideEffectForNode(node, record.output, attempt),
    error: workflowNodeErrorInfo(error),
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.recovery.node_settled',
    data: { nodeId: node.id, reason: 'interrupted_backend', retryable: true },
  })
  const routedFailure = hasFailureRouteFromNode(definition, node.id)
  await failNode(runDir, node, error, { failRun: !routedFailure })
}

/**
 * Crash recovery for interrupted `running` nodes that neither the
 * rerun-strategy reset nor the child-carrier reconcile covers: human gates,
 * dynamic graph-patch nodes, and non-compute backend nodes. Resume holds the
 * run lock, so a node persisted as `running` here has no live executor;
 * anything left in `running` after this pass would deadlock the run (the
 * advance loop counts it as in-flight progress forever).
 */
async function reconcileInterruptedGateAndBackendNodes(
  runDir: string,
  definition: MatOSWorkflowDefinition,
): Promise<void> {
  const nodeRuns = await listNodeRuns(runDir)
  const interrupted = definition.nodes.filter(node => {
    if (nodeRuns.get(node.id)?.status !== 'running') {
      return false
    }
    return (
      node.type === 'human' ||
      node.type === 'dynamic' ||
      (node.type === 'backend' && node.targetType !== 'compute')
    )
  })
  if (interrupted.length === 0) {
    return
  }
  const snapshot = await readWorkflowRun(runDir)
  const artifacts = await readWorkflowArtifacts(runDir)
  const workflowContext = {
    artifactRoot: snapshot.artifactRoot ?? join(runDir, 'artifacts-root'),
    projectCwd: snapshot.projectCwd ?? snapshot.workspaceDir,
    runDir,
    runId: snapshot.runId,
    workspaceDir: snapshot.workspaceDir,
    workflowRef: snapshot.workflowRef,
  }
  for (const node of interrupted) {
    const record = nodeRuns.get(node.id)!
    let runtimeNode = node
    try {
      runtimeNode = materializeWorkflowNode(
        node,
        nodeRuns,
        snapshot.parameters,
        workflowContext,
        artifacts,
      )
    } catch {
      // Materialization failures must not block recovery; the raw node is
      // enough for parking/settling bookkeeping.
    }
    if (node.type === 'human') {
      await reparkInterruptedGateNode(runDir, runtimeNode, record, undefined)
    } else if (node.type === 'dynamic') {
      await reconcileInterruptedDynamicNode(runDir, runtimeNode, record)
    } else {
      await settleInterruptedBackendNode(runDir, definition, runtimeNode, record)
    }
  }
}

export async function resumeWorkflowRun(runDir: string): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(runDir)
  await readMatOSAlgorithmRunManifestForExecution(runDir, {
    runId: snapshot.runId,
    workflowRef: snapshot.workflowRef,
  })
  // `created` is resumable too: deferred-start runs (startWorkflowRun with
  // advance:false) and runs whose creator process died before the first
  // advance both sit in `created` until a resume/recover picks them up.
  if (
    snapshot.status !== 'paused' &&
    snapshot.status !== 'running' &&
    snapshot.status !== 'created'
  ) {
    return inspectWorkflowRun(runDir)
  }
  const definition = await readWorkflowDefinition(runDir).catch(() => undefined)
  const projectCwd = snapshot.projectCwd ?? snapshot.workspaceDir
  if (definition && projectCwd) {
    await reconcileComputeJobsForWorkflowRun({
      runDir,
      definition,
      projectCwd,
      nodeRuns: await listNodeRuns(runDir),
      updateNodeOutput: async (node, nodeRun, output) => {
        await markNode(runDir, node, nodeRun.status, { output })
      },
    })
  }
  if (definition && !isStateMachineWorkflow(definition)) {
    await resetOrphanedInFlightNodes(runDir, definition)
    await reconcileInterruptedChildCarrierNodes(runDir, definition)
    await reconcileInterruptedGateAndBackendNodes(runDir, definition)
    // Adopting a persisted child-run outcome can legitimately finish the run
    // (child failed with no failure route, or child was cancelled). Return
    // that terminal state instead of falling through to the unconditional
    // restart below, which is allowed to overwrite terminal statuses with
    // `running` and would resurrect the run.
    const reconciled = await readWorkflowRun(runDir)
    if (TERMINAL_RUN_STATUSES.has(reconciled.status)) {
      return inspectWorkflowRun(runDir)
    }
    // A reconciled gate re-parked the run (interrupted human node, or a
    // dynamic node with a proposed patch): surface that waiting state
    // instead of falling through to the unconditional `running` restart,
    // which would erase the just-restored waitingNodeId pointer.
    if (
      reconciled.status === 'waiting_input' ||
      reconciled.status === 'waiting_approval'
    ) {
      return inspectWorkflowRun(runDir)
    }
  }

  if (snapshot.waitingNodeId) {
    const waitingNode = await readNodeRun(runDir, snapshot.waitingNodeId)
    if (waitingNode?.status === 'waiting_input') {
      await updateRunStatus(runDir, 'waiting_input')
      return inspectWorkflowRun(runDir)
    }
    if (waitingNode?.status === 'waiting_approval') {
      await updateRunStatus(runDir, 'waiting_approval')
      return inspectWorkflowRun(runDir)
    }
  }

  await appendWorkflowEvent(runDir, {
    type: 'workflow.run.resumed',
    data: { runId: snapshot.runId },
  })
  await updateRunStatus(runDir, 'running', { waitingNodeId: undefined })
  return advanceWorkflowRun(runDir)
}

export async function retryWorkflowNode(
  input: RetryWorkflowNodeInput,
): Promise<WorkflowRunView> {
  const definition = await readWorkflowDefinition(input.runDir)
  const node = definition.nodes.find(node => node.id === input.nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${input.nodeId}`)
  }
  const current = await readNodeRun(input.runDir, input.nodeId)
  const nodeRuns = await listNodeRuns(input.runDir)
  const causalFailedNodeIds = [...nodeRuns.values()]
    .filter(
      candidate =>
        candidate.status === 'failed' &&
        workflowFailureSourceNodeIds(candidate.error).includes(input.nodeId),
    )
    .map(candidate => candidate.nodeId)
  const completedCausalProducer =
    current?.status === 'completed' && causalFailedNodeIds.length > 0
  if (
    !current ||
    (!['failed', 'skipped', 'cancelled'].includes(current.status) &&
      !completedCausalProducer)
  ) {
    throw new Error(`Workflow node cannot be retried from status: ${current?.status ?? 'pending'}`)
  }

  if (input.failedChildrenOnly) {
    if (node.type !== 'map') {
      throw new Error(
        `Selective failed-child retry requires a failed aggregate map node: ${input.nodeId}`,
      )
    }
    if (current.status !== 'failed') {
      throw new Error(
        `Selective failed-child retry requires a failed map node: ${current.status}`,
      )
    }
    const snapshot = await readWorkflowRun(input.runDir)
    if (!snapshot.workspaceDir) {
      throw new Error(`Workflow run is missing workspaceDir: ${snapshot.runId}`)
    }
    const nodeRuns = await listNodeRuns(input.runDir)
    const artifacts = await readWorkflowArtifacts(input.runDir)
    const runtimeNode = materializeWorkflowNode(
      node,
      nodeRuns,
      snapshot.parameters,
      {
        artifactRoot: snapshot.artifactRoot ?? join(input.runDir, 'artifacts-root'),
        projectCwd: snapshot.projectCwd ?? snapshot.workspaceDir,
        runDir: input.runDir,
        runId: snapshot.runId,
        workspaceDir: snapshot.workspaceDir,
        workflowRef: snapshot.workflowRef,
      },
      artifacts,
    )
    const retryAttempt = (current.attempts ?? 0) + 1
    const startedAt = nowIso()
    const idempotencyKey = attemptIdempotencyKeyForNode(
      snapshot.runId,
      runtimeNode,
      retryAttempt,
    )
    const workflowsDir = dirname(dirname(input.runDir))
    await markNode(input.runDir, runtimeNode, 'running', {
      attempts: retryAttempt,
      startedAt,
      idempotencyKey,
    })
    let result: Awaited<ReturnType<typeof retryWorkflowMapFailedChildren>>
    try {
      result = await retryWorkflowMapFailedChildren(runtimeNode, current.output, {
        cwd: snapshot.projectCwd ?? snapshot.workspaceDir,
        runDir: input.runDir,
        workflowsDir,
        workspaceDir: snapshot.workspaceDir,
        retryAttempt,
        startChildRun: childWorkflowRunStarter(input.runDir),
      })
      assertWorkflowNodeOutputContract(runtimeNode, result.output)
    } catch (error) {
      const errorInfo = workflowNodeErrorInfo(error)
      const contractFailure =
        error instanceof WorkflowNodeOutputContractError ? error : undefined
      await writeNodeAttempt({
        runDir: input.runDir,
        nodeId: runtimeNode.id,
        attempt: retryAttempt,
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
          retryAttempt,
        ),
        error: errorInfo,
      })
      await failNode(input.runDir, runtimeNode, error)
      return inspectWorkflowRun(input.runDir)
    }
    await writeNodeAttempt({
      runDir: input.runDir,
      nodeId: runtimeNode.id,
      attempt: retryAttempt,
      status: result.failureMessage ? 'failed' : 'completed',
      startedAt,
      finishedAt: nowIso(),
      idempotencyKey,
      output: result.output,
      contractValidation: assertWorkflowNodeOutputContract(runtimeNode, result.output),
      sideEffect: attemptSideEffectForNode(runtimeNode, result.output, retryAttempt),
    })
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.map.failed_children_retry_completed',
      data: {
        nodeId: runtimeNode.id,
        retryAttempt,
        output: result.output,
      },
    })
    if (result.failureMessage) {
      await failNodeWithOutput(
        input.runDir,
        runtimeNode,
        result.failureMessage,
        result.output,
      )
      return inspectWorkflowRun(input.runDir)
    }

    await completeNode(input.runDir, runtimeNode, result.output)
    for (const resetId of downstreamWorkflowNodeIds(definition, input.nodeId)) {
      await resetNodeRun(input.runDir, resetId)
    }
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.node.retry_requested',
      data: {
        nodeId: input.nodeId,
        failedChildrenOnly: true,
      },
    })
    await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
    return advanceWorkflowRun(input.runDir)
  }

  if (isStateMachineWorkflow(definition)) {
    const { listWorkflowFrames, writeWorkflowFrame } = await import(
      './stateMachineStore.js'
    )
    const latestFrame = (await listWorkflowFrames(input.runDir)).at(-1)
    if (
      latestFrame?.status === 'failed' &&
      latestFrame.activeNodeId === input.nodeId
    ) {
      await writeWorkflowFrame(input.runDir, {
        ...latestFrame,
        status: 'running',
        transitionEdgeId: undefined,
        updatedAt: nowIso(),
      })
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.state_machine.frame_retry_requested',
        data: {
          frameId: latestFrame.frameId,
          frameIndex: latestFrame.index,
          nodeId: input.nodeId,
        },
      })
    }
  }
  const resetIds = new Set([
    input.nodeId,
    ...downstreamWorkflowNodeIds(definition, input.nodeId),
  ])
  for (const failedNodeId of causalFailedNodeIds) {
    resetIds.add(failedNodeId)
    for (const downstreamId of downstreamWorkflowNodeIds(
      definition,
      failedNodeId,
    )) {
      resetIds.add(downstreamId)
    }
  }
  for (const resetId of definition.nodes
    .map(candidate => candidate.id)
    .filter(candidate => resetIds.has(candidate))) {
    await resetNodeRun(input.runDir, resetId)
  }
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.node.retry_requested',
    data: {
      nodeId: input.nodeId,
      ...(completedCausalProducer
        ? {
            reason: 'downstream_validation_identified_causal_producer',
            causalFailedNodeIds,
            invalidatedNodeIds: [...resetIds],
          }
        : {}),
    },
  })
  await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
  return advanceWorkflowRun(input.runDir)
}

export async function skipWorkflowNode(
  input: SkipWorkflowNodeInput,
): Promise<WorkflowRunView> {
  const definition = await readWorkflowDefinition(input.runDir)
  const node = definition.nodes.find(node => node.id === input.nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${input.nodeId}`)
  }
  const current = await readNodeRun(input.runDir, input.nodeId)
  if (current && ['completed', 'skipped', 'cancelled'].includes(current.status)) {
    throw new Error(`Workflow node cannot be skipped from status: ${current.status}`)
  }

  const reason = input.reason ?? 'operator skipped node'
  await markNode(input.runDir, node, 'skipped', {
    output: { skipped: true, reason },
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.node.skipped',
    data: { nodeId: input.nodeId, reason },
  })
  await updateRunStatus(input.runDir, 'running', { waitingNodeId: undefined })
  return advanceWorkflowRun(input.runDir)
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

// Kill registered local exec/agent children of this run and record what was
// terminated. Best-effort: kill/reporting failures must not block the cancel.
async function killWorkflowRunLocalProcessesWithEvent(
  runDir: string,
  source: 'cancel_run' | 'cancel_request',
): Promise<void> {
  try {
    const killed = await killWorkflowRunLocalProcesses(runDir)
    const terminated = killed.filter(
      result => result.outcome === 'terminated' || result.outcome === 'killed',
    )
    if (terminated.length > 0) {
      await appendWorkflowEvent(runDir, {
        type: 'workflow.run.local_processes_terminated',
        data: {
          source,
          processes: terminated.map(result => ({
            nodeId: result.nodeId,
            pid: result.pid,
            kind: result.kind,
            outcome: result.outcome,
          })),
        },
      })
    }
  } catch {
    // Best-effort by design.
  }
}

type ChildRunCancelRef = {
  childRunId: string
  detachOnParentCancel: boolean
}

// Read child-run references a run may have spawned. Subworkflow nodes persist a
// `child-runs/<nodeId>.json` marker with an explicit `detachOnParentCancel`
// flag; map/loop iterations persist `childRunId`s under `iterations`/`rounds`
// (always coupled to the parent). Malformed entries are ignored so cancel stays
// best-effort.
async function listChildRunCancelRefs(
  runDir: string,
): Promise<ChildRunCancelRef[]> {
  const refs = new Map<string, ChildRunCancelRef>()
  const rememberChildRunId = (value: unknown, detach: boolean): void => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return
    }
    const existing = refs.get(value)
    refs.set(value, {
      childRunId: value,
      // Only a subworkflow marker can opt a child out; keep detach sticky once
      // any source has flagged it.
      detachOnParentCancel: (existing?.detachOnParentCancel ?? false) || detach,
    })
  }
  const collect = (value: unknown, detach: boolean): void => {
    if (!value || typeof value !== 'object') {
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item, detach)
      }
      return
    }
    const record = value as Record<string, unknown>
    rememberChildRunId(
      record.childRunId,
      detach || record.detachOnParentCancel === true,
    )
    for (const item of Object.values(record)) {
      collect(item, detach)
    }
  }

  for (const dir of ['child-runs', 'iterations', 'rounds']) {
    await collectJsonRunRefs(join(runDir, dir), collect)
  }
  return [...refs.values()]
}

async function collectJsonRunRefs(
  dir: string,
  collect: (value: unknown, detach: boolean) => void,
  depth = 0,
): Promise<void> {
  if (depth > 8) {
    return
  }
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectJsonRunRefs(path, collect, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    try {
      collect(await readJson<unknown>(path), false)
    } catch {
      // Ignore unreadable/partial JSON; cancel propagation is best-effort.
    }
  }
}

// Cancel non-terminal child workflow runs a cancelled parent spawned, unless a
// subworkflow node opted its child out with `policy.detachOnParentCancel`.
// Child runs execute in `<parentRunDir>/../<childRunId>` (see budget.ts), so
// they are resolved as siblings of the parent run dir. A visited set guards
// against re-entrant refs.
async function cancelChildWorkflowRuns(
  runDir: string,
  visited: Set<string>,
): Promise<void> {
  const childRefs = await listChildRunCancelRefs(runDir)
  for (const ref of childRefs) {
    if (ref.detachOnParentCancel) {
      await appendWorkflowEvent(runDir, {
        type: 'workflow.child_run.cancel_detached',
        data: { childRunId: ref.childRunId },
      })
      continue
    }
    const childRunDir = join(dirname(runDir), ref.childRunId)
    const normalized = resolve(childRunDir)
    if (visited.has(normalized)) {
      continue
    }
    visited.add(normalized)
    const childSnapshot = await readWorkflowRun(childRunDir).catch(() => undefined)
    if (!childSnapshot || TERMINAL_RUN_STATUSES.has(childSnapshot.status)) {
      continue
    }
    await cancelWorkflowRunInternal(childRunDir, visited)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.child_run.cancelled',
      data: { childRunId: ref.childRunId },
    })
  }
}

async function cancelWorkflowRunInternal(
  runDir: string,
  visited: Set<string>,
): Promise<WorkflowRunView> {
  // Publish local intent before signalling the exec tree. This marker is kept
  // separate from cooperative remote-compute control so an active backend poll
  // cannot race the explicit remote cancel below and submit it twice.
  await requestWorkflowRunLocalProcessCancel(runDir)
  // An MPI launcher can move ranks into another session/process group. Reap
  // every process carrying this run's exact ownership marker before declaring
  // cancellation terminal, including stale descendants of a terminal run.
  await terminateWorkflowRunLocalProcesses(runDir)
  const current = await readWorkflowRun(runDir)
  if (TERMINAL_RUN_STATUSES.has(current.status)) {
    // Nothing to cancel on a terminal run; drop any stale control marker.
    await clearWorkflowRunControl(runDir)
    await clearWorkflowRunLocalProcessCancel(runDir)
    return inspectWorkflowRunView(runDir)
  }
  // Terminate registered local node children (detached exec/agent process
  // groups). Without this, cancelling a run whose worker died — or whose
  // exec node launched long local compute — flips run.json to cancelled
  // while the VASP/OpenFOAM-style processes keep computing.
  await killWorkflowRunLocalProcessesWithEvent(runDir, 'cancel_run')
  const definition = await readWorkflowDefinition(runDir).catch(() => undefined)
  const projectCwd = current.projectCwd ?? current.workspaceDir
  if (definition && projectCwd) {
    await cancelComputeJobsForWorkflowRun({
      runDir,
      definition,
      projectCwd,
      nodeRuns: await listNodeRuns(runDir),
      updateNodeOutput: async (node, nodeRun, output) => {
        await markNode(runDir, node, nodeRun.status, { output })
      },
    })
  }
  // Propagate cancel to still-running child workflow runs (subworkflow/map/loop)
  // so remote compute jobs inside them are cancelled and orphaned child runs do
  // not linger in a non-terminal state after the parent is cancelled.
  await cancelChildWorkflowRuns(runDir, visited)
  const snapshot = await updateRunStatus(runDir, 'cancelled', {
    waitingNodeId: undefined,
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.run.cancelled',
    data: { runId: snapshot.runId },
  })
  await clearWorkflowRunControl(runDir)
  await clearWorkflowRunLocalProcessCancel(runDir)
  return inspectWorkflowRunView(runDir)
}

async function applyWorkflowRunCancel(
  runDir: string,
): Promise<WorkflowRunView> {
  return cancelWorkflowRunInternal(runDir, new Set([resolve(runDir)]))
}

export async function cancelWorkflowRun(
  runDir: string,
): Promise<WorkflowRunView> {
  return applyWorkflowRunCancel(runDir)
}

// Cancel a run that may be actively advancing under another holder. Applies
// immediately when the run is idle; otherwise leaves a cooperative cancel
// marker the advance loop honors at the next node boundary, so a long run can
// still be cancelled without waiting on (and timing out against) the run lock.
export async function requestWorkflowRunCancel(
  runDir: string,
): Promise<WorkflowRunView> {
  return requestWorkflowRunCancelInternal(
    runDir,
    new Set<string>(),
  )
}

async function requestWorkflowRunCancelInternal(
  runDir: string,
  visited: Set<string>,
): Promise<WorkflowRunView> {
  const normalized = resolve(runDir)
  if (visited.has(normalized)) {
    return inspectWorkflowRunView(runDir)
  }
  visited.add(normalized)
  const current = await readWorkflowRun(runDir)
  if (TERMINAL_RUN_STATUSES.has(current.status)) {
    await clearWorkflowRunControl(runDir)
    return inspectWorkflowRunView(runDir)
  }

  // Preserve the direct, serialized cancellation path when no advancer owns
  // the lock. This is important for remote compute lifecycle cancellation,
  // where two concurrent cancel calls would target the same backend job.
  const immediate = await tryWithWorkflowRunLock(
    runDir,
    () => cancelWorkflowRunInternal(runDir, visited),
    { owner: 'workflow.cancel', timeoutMs: 0 },
  )
  if (immediate.acquired) {
    return immediate.value
  }

  // Publish cancellation before waiting for the run lock. Active agent nodes
  // watch this marker, and active iteration nodes persist child references at
  // creation time, so the request can reach the deepest running child without
  // waiting for each parent node to return first.
  await requestWorkflowRunControl(runDir, 'cancel')
  await requestWorkflowRunLocalProcessCancel(runDir)
  // The advancing holder only reads the marker between nodes, so an in-flight
  // exec/agent child (potentially hours of local compute) would keep running.
  // Terminate the registered children now; the holder's adapters classify the
  // resulting signal against the marker and settle their nodes as cancelled.
  await killWorkflowRunLocalProcessesWithEvent(runDir, 'cancel_request')
  // Registered-pid kill covers the detached child process groups; the
  // run-scoped /proc scan additionally reaps descendants that escaped their
  // process group (e.g. setsid MPI ranks), releasing the advancer so the
  // retry below can seal cancellation.
  await terminateWorkflowRunLocalProcesses(runDir)
  for (const ref of await listChildRunCancelRefs(runDir)) {
    if (ref.detachOnParentCancel) {
      await appendWorkflowEvent(runDir, {
        type: 'workflow.child_run.cancel_detached',
        data: { childRunId: ref.childRunId },
      })
      continue
    }
    const childRunDir = join(dirname(runDir), ref.childRunId)
    const child = await readWorkflowRun(childRunDir).catch(() => undefined)
    if (!child || TERMINAL_RUN_STATUSES.has(child.status)) {
      continue
    }
    await requestWorkflowRunCancelInternal(childRunDir, visited)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.child_run.cancel_requested',
      data: { childRunId: ref.childRunId },
    })
  }
  const attempt = await tryWithWorkflowRunLock(
    runDir,
    () => cancelWorkflowRunInternal(runDir, visited),
    { owner: 'workflow.cancel', timeoutMs: 2000 },
  )
  return attempt.acquired ? attempt.value : inspectWorkflowRunView(runDir)
}
