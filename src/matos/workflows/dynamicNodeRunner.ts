import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  runWorkflowAgentNode,
  type WorkflowAgentNodeRunResult,
} from './nodeAdapters/agentNode.js'
import { parseStructuredWorkflowResult } from './outputContract.js'
import {
  latestWorkflowGraphPatchForSourceNode,
  normalizeWorkflowGraphPatchCandidate,
  validateWorkflowGraphPatchCandidate,
  workflowGraphPatchGraphHash,
  writeWorkflowGraphPatchApplication,
  writeWorkflowGraphPatchLedger,
  workflowGraphPatchEffectiveRisk,
  workflowGraphPatchOperatorPolicy,
  type WorkflowGraphPatchCandidate,
  type WorkflowGraphPatchRisk,
} from './dynamicPatch.js'
import { appendWorkflowEvent, readWorkflowRun } from './workflowStore.js'
import { compileMatOSWorkflowDefinition } from './workflowCompile.js'
import { pathIsInsideRoot, updateRunFields } from './runState.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowOutput,
} from './types.js'
import type { WorkflowDynamicPlannerRunner } from './runtimeTypes.js'

async function dynamicCandidateForNode(
  node: MatOSWorkflowNode,
  options: { runDir: string; artifactRoot: string },
): Promise<unknown> {
  if (node.candidate !== undefined) {
    return node.candidate
  }
  const input =
    node.input && typeof node.input === 'object' && !Array.isArray(node.input)
      ? (node.input as Record<string, unknown>)
      : undefined
  if (input?.candidate !== undefined) {
    return input.candidate
  }
  if (typeof input?.candidatePath === 'string' && input.candidatePath.trim()) {
    const candidatePath = input.candidatePath.trim()
    if (
      !pathIsInsideRoot(candidatePath, options.runDir) &&
      !pathIsInsideRoot(candidatePath, options.artifactRoot)
    ) {
      throw new Error(
        `Dynamic workflow patch candidatePath must be inside the workflow run or artifact root: ${node.id}`,
      )
    }
    return JSON.parse(await readFile(candidatePath, 'utf8')) as unknown
  }
  return node.input
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function dynamicNodeHasStaticCandidate(node: MatOSWorkflowNode): boolean {
  return node.candidate !== undefined || node.input !== undefined
}

function dynamicNodeCanUsePlanner(node: MatOSWorkflowNode): boolean {
  return (
    typeof node.role === 'string' &&
    node.role.trim().length > 0 &&
    typeof node.prompt === 'string' &&
    node.prompt.trim().length > 0
  )
}

function protocolString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function protocolWorkflowNode(value: unknown): MatOSWorkflowNode | undefined {
  if (!isObject(value)) {
    return undefined
  }
  const id = protocolString(value.id)
  const type = protocolString(value.type)
  if (!id || !type) {
    return undefined
  }
  const dependsOn = Array.isArray(value.dependsOn)
    ? value.dependsOn
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    : []
  return {
    ...value,
    id,
    type,
    dependsOn,
  } as MatOSWorkflowNode
}

function protocolWorkflowOutputs(
  value: unknown,
): Record<string, MatOSWorkflowOutput> | undefined {
  if (!isObject(value)) {
    return undefined
  }
  const outputs: Record<string, MatOSWorkflowOutput> = {}
  for (const [key, output] of Object.entries(value)) {
    if (key.trim().length === 0 || !isObject(output)) {
      continue
    }
    outputs[key] = output as MatOSWorkflowOutput
  }
  return Object.keys(outputs).length > 0 ? outputs : undefined
}

function dynamicPlannerProtocolCandidate(
  node: MatOSWorkflowNode,
  structured: Record<string, unknown>,
): WorkflowGraphPatchCandidate | undefined {
  const protocol =
    protocolString(structured.protocol) ?? protocolString(structured.plannerProtocol)
  if (protocol !== 'planner-executor-reviewer') {
    return undefined
  }
  const rawExecutors = Array.isArray(structured.executorNodes)
    ? structured.executorNodes
    : Array.isArray(structured.executors)
      ? structured.executors
      : []
  const executorNodes = rawExecutors
    .map(protocolWorkflowNode)
    .filter((item): item is MatOSWorkflowNode => Boolean(item))
  const reviewerNode = protocolWorkflowNode(
    structured.reviewerNode ?? structured.reviewNode,
  )
  const followUpPlannerNode = protocolWorkflowNode(
    structured.followUpPlannerNode ??
      structured.nextPlannerNode ??
      structured.continuationPlannerNode,
  )
  const workflowOutputs = protocolWorkflowOutputs(
    structured.workflowOutputs ??
      structured.outputs ??
      structured.outputDefinitions,
  )
  const executorMode =
    protocolString(structured.executorMode) ??
    protocolString(structured.executionMode) ??
    protocolString(structured.executorExecutionMode)
  const parallelExecutors =
    executorMode === 'parallel' || structured.parallelExecutors === true
  const addedNodes = [
    ...executorNodes,
    ...(reviewerNode ? [reviewerNode] : []),
    ...(followUpPlannerNode ? [followUpPlannerNode] : []),
  ]
  if (addedNodes.length === 0) {
    return undefined
  }

  const operations: WorkflowGraphPatchCandidate['operations'] = addedNodes.map(
    item => ({ op: 'add_node', node: item }),
  )
  if (parallelExecutors && executorNodes.length > 1) {
    for (const executorNode of executorNodes) {
      operations.push({
        op: 'add_edge',
        from: node.id,
        to: executorNode.id,
      })
    }
    for (const executorNode of executorNodes) {
      if (reviewerNode) {
        operations.push({
          op: 'add_edge',
          from: executorNode.id,
          to: reviewerNode.id,
        })
      } else if (followUpPlannerNode) {
        operations.push({
          op: 'add_edge',
          from: executorNode.id,
          to: followUpPlannerNode.id,
        })
      }
    }
    if (reviewerNode && followUpPlannerNode) {
      operations.push({
        op: 'add_edge',
        from: reviewerNode.id,
        to: followUpPlannerNode.id,
      })
    }
  } else {
    const chain = [node.id, ...executorNodes.map(item => item.id)]
    if (reviewerNode) {
      chain.push(reviewerNode.id)
    }
    if (followUpPlannerNode) {
      chain.push(followUpPlannerNode.id)
    }
    for (let index = 0; index < chain.length - 1; index += 1) {
      operations.push({
        op: 'add_edge',
        from: chain[index]!,
        to: chain[index + 1]!,
      })
    }
  }
  if (workflowOutputs) {
    operations.push({
      op: 'set_outputs',
      outputs: workflowOutputs,
    })
  }

  const budgetImpact = isObject(structured.budgetImpact)
    ? {
        addedNodes: Number(structured.budgetImpact.addedNodes ?? addedNodes.length),
        estimatedAgentCalls: Number(
          structured.budgetImpact.estimatedAgentCalls ?? 0,
        ),
        ...(structured.budgetImpact.estimatedWallMinutes !== undefined
          ? {
              estimatedWallMinutes: Number(
                structured.budgetImpact.estimatedWallMinutes,
              ),
            }
          : {}),
      }
    : {
        addedNodes: addedNodes.length,
        estimatedAgentCalls: 0,
      }

  const risk = protocolString(structured.risk)
  return {
    schemaVersion: 1,
    sourceNodeId: node.id,
    reason:
      protocolString(structured.reason) ??
      protocolString(structured.planId) ??
      'planner executor reviewer expansion',
    operations,
    budgetImpact,
    risk: risk === 'medium' || risk === 'high' ? risk : 'low',
    metadata: {
      protocol,
      ...(protocolString(structured.planId)
        ? { planId: protocolString(structured.planId) }
        : {}),
      ...(followUpPlannerNode ? { followUpPlannerNodeId: followUpPlannerNode.id } : {}),
    },
  }
}

function dynamicPlannerCandidateFromOutput(
  node: MatOSWorkflowNode,
  output: Record<string, unknown>,
): unknown {
  const structured =
    output.structured !== undefined
      ? output.structured
      : typeof output.result === 'string'
        ? parseStructuredWorkflowResult(output.result)
        : undefined
  if (isObject(structured) && structured.candidate !== undefined) {
    return structured.candidate
  }
  if (isObject(structured)) {
    return dynamicPlannerProtocolCandidate(node, structured) ?? structured
  }
  return structured
}

function dynamicPatchAutoApplyAllowed(
  definition: MatOSWorkflowDefinition,
  node: MatOSWorkflowNode,
  effectiveRisk: WorkflowGraphPatchRisk,
): boolean {
  if (workflowGraphPatchOperatorPolicy().requireApproval) {
    return false
  }
  const approval = node.policy?.approval
  return (
    effectiveRisk === 'low' &&
    approval !== 'ask' &&
    approval !== 'require' &&
    definition.policy.approvalMode === 'bypass'
  )
}

export type WorkflowDynamicNodeResult =
  | { state: 'completed'; output: Record<string, unknown> }
  | { state: 'waiting'; output: Record<string, unknown> }

/**
 * The output an already-applied patch from this node produced, when the run's
 * CURRENT graph is that patch's output. A dynamic node re-entered after a
 * crash (node left `running` and reset) or an operator reset must consume the
 * patch it already applied instead of planning again: replanning would stack
 * a second patch (and its side effects) on top of the first one's graph.
 */
async function appliedWorkflowGraphPatchOutputForCurrentGraph(input: {
  runDir: string
  node: MatOSWorkflowNode
  definition: MatOSWorkflowDefinition
}): Promise<Record<string, unknown> | undefined> {
  const applied = await latestWorkflowGraphPatchForSourceNode(
    input.runDir,
    input.node.id,
    'applied',
  )
  if (!applied?.decision) {
    return undefined
  }
  const run = await readWorkflowRun(input.runDir).catch(() => undefined)
  const matchesSnapshotPath =
    typeof applied.decision.graphSnapshotPath === 'string' &&
    run?.graphSnapshotPath === applied.decision.graphSnapshotPath
  const matchesHash =
    typeof applied.decision.graphHash === 'string' &&
    applied.decision.graphHash === workflowGraphPatchGraphHash(input.definition)
  if (!matchesSnapshotPath && !matchesHash) {
    return undefined
  }
  return {
    ok: true,
    patchId: applied.patchId,
    status: 'applied',
    ...(applied.candidate?.risk ? { risk: applied.candidate.risk } : {}),
    ...(applied.decision.graphHash
      ? { graphHash: applied.decision.graphHash }
      : {}),
    ...(applied.decision.graphSnapshotPath
      ? { graphSnapshotPath: applied.decision.graphSnapshotPath }
      : {}),
    adoptedFromLedger: true,
  }
}

export async function runWorkflowDynamicNode(input: {
  runDir: string
  artifactRoot: string
  node: MatOSWorkflowNode
  definition: MatOSWorkflowDefinition
  attempt: number
  startedAt: string
  idempotencyKey: string
  projectCwd: string
  scopeRef?: string
  parameters?: Record<string, unknown>
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
}): Promise<WorkflowDynamicNodeResult> {
  // Idempotent re-entry: an attempt that crashed after its patch was applied
  // (ledger `applied`, node left `running`) or was reset afterwards must not
  // plan or apply again.
  const alreadyApplied = await appliedWorkflowGraphPatchOutputForCurrentGraph({
    runDir: input.runDir,
    node: input.node,
    definition: input.definition,
  })
  if (alreadyApplied) {
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.dynamic_patch.adopted',
      data: {
        nodeId: input.node.id,
        patchId: alreadyApplied.patchId,
        reason: 'patch already applied to the current graph snapshot',
      },
    })
    return { state: 'completed', output: alreadyApplied }
  }
  let plannerResult: WorkflowAgentNodeRunResult | undefined
  let rawCandidate = await dynamicCandidateForNode(input.node, {
    runDir: input.runDir,
    artifactRoot: input.artifactRoot,
  })
  if (!dynamicNodeHasStaticCandidate(input.node)) {
    if (!dynamicNodeCanUsePlanner(input.node)) {
      throw new Error(
        `Dynamic node requires candidate or planner role+prompt: ${input.node.id}`,
      )
    }
    const runner =
      input.dynamicPlannerRunner ??
      ((node, options) =>
        runWorkflowAgentNode(node, {
          cwd: options.cwd,
          scopeRef: options.scopeRef,
          runDir: options.runDir,
          attempt: options.attempt,
        }))
    plannerResult = await runner(input.node, {
      cwd: input.projectCwd,
      scopeRef: input.scopeRef,
      runDir: input.runDir,
      attempt: input.attempt,
      idempotencyKey: input.idempotencyKey,
    })
    rawCandidate = dynamicPlannerCandidateFromOutput(
      input.node,
      plannerResult.output,
    )
  }
  const normalized = normalizeWorkflowGraphPatchCandidate(rawCandidate)
  if (!normalized.candidate || normalized.errors.length > 0) {
    throw new Error(
      `Dynamic workflow patch invalid: ${normalized.errors
        .map(error => error.message)
        .join('; ')}`,
    )
  }
  const validation = validateWorkflowGraphPatchCandidate(
    input.definition,
    normalized.candidate,
    { knownParameterIds: Object.keys(input.parameters ?? {}) },
  )
  if (!validation.ok || !validation.patchedDefinition) {
    await writeWorkflowGraphPatchLedger({
      runDir: input.runDir,
      candidate: normalized.candidate,
      before: input.definition,
      after: validation.patchedDefinition,
      validation,
      decision: {
        status: 'rejected',
        reason: validation.errors.map(error => error.message).join('; '),
      },
    })
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.dynamic_patch.rejected',
      data: {
        nodeId: input.node.id,
        patchId: normalized.candidate.id,
        reason: validation.errors.map(error => error.message).join('; '),
      },
    })
    throw new Error(
      `Dynamic workflow patch validation failed: ${validation.errors
        .map(error => error.message)
        .join('; ')}`,
    )
  }
  const effectiveRisk = workflowGraphPatchEffectiveRisk(
    normalized.candidate,
    validation.patchedDefinition,
  )
  if (
    !dynamicPatchAutoApplyAllowed(
      input.definition,
      input.node,
      effectiveRisk,
    )
  ) {
    const reviewReason = workflowGraphPatchOperatorPolicy().requireApproval
      ? 'Dynamic workflow patch requires human review (operator policy requires approval)'
      : 'Dynamic workflow patch requires human review'
    await writeWorkflowGraphPatchLedger({
      runDir: input.runDir,
      candidate: normalized.candidate,
      before: input.definition,
      after: validation.patchedDefinition,
      validation,
      decision: {
        status: 'proposed',
        reason: reviewReason,
      },
    })
    const output = {
      ok: true,
      patchId: normalized.candidate.id,
      status: 'proposed',
      reason: reviewReason,
      risk: normalized.candidate.risk,
      effectiveRisk,
    }
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.dynamic_patch.proposed',
      data: {
        nodeId: input.node.id,
        patchId: normalized.candidate.id,
        risk: normalized.candidate.risk,
        effectiveRisk,
      },
    })
    return { state: 'waiting', output }
  }

  const run = await readWorkflowRun(input.runDir)
  // Same requirement as applyWorkflowGraphPatchForRun: the persisted snapshot
  // must be the compiled form (semantic node types lowered, incomingEdges and
  // dependsOn rebuilt from the patched edge list). Persisting the raw patched
  // definition crashes dispatch on semantic nodes and silently skips nodes
  // reachable only via patch-added routed edges.
  const compiledPatch = compileMatOSWorkflowDefinition(
    validation.patchedDefinition,
    {
      workflowRef: run.workflowRef,
      // Preserve (never grant) the reviewed-high-risk trust already carried
      // by the running snapshot.
      allowReviewedHighRiskBypass:
        input.definition.compiled?.reviewedHighRiskBypassTrusted === true,
      // The run may legitimately reference resolved run parameters; without
      // them the compile-side validation flags spurious unknown-parameter
      // errors that would now (correctly) reject the patch below.
      knownParameterIds: Object.keys(input.parameters ?? {}),
    },
  )
  if (!compiledPatch.ok) {
    // The compiled snapshot is what actually executes. Persisting it while
    // its own validation failed would run a graph no gate ever accepted, so
    // reject exactly like a pre-compile validation failure and leave the
    // rejection on the ledger.
    const reason = `compiled patch snapshot failed validation: ${
      compiledPatch.diagnostics
        .filter(diagnostic => diagnostic.severity === 'error')
        .map(diagnostic => diagnostic.message)
        .join('; ') || 'unknown compile error'
    }`
    await writeWorkflowGraphPatchLedger({
      runDir: input.runDir,
      candidate: normalized.candidate,
      before: input.definition,
      after: validation.patchedDefinition,
      validation,
      decision: {
        status: 'rejected',
        reason,
        decidedBy: 'workflow.dynamic_node.compile',
      },
    })
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.dynamic_patch.rejected',
      data: {
        nodeId: input.node.id,
        patchId: normalized.candidate.id,
        reason,
      },
    })
    throw new Error(`Dynamic workflow patch validation failed: ${reason}`)
  }
  const written = await writeWorkflowGraphPatchApplication({
    runDir: input.runDir,
    candidate: normalized.candidate,
    before: input.definition,
    after: compiledPatch.definition,
    scopeRef: input.scopeRef ?? 'user:local',
    allowDynamicMutation: true,
  })
  const graphSnapshotPath = basename(written.graphSnapshotPath)
  // Keyed-mutex RMW: a bare writeWorkflowRun here raced concurrent
  // updateRunStatus writers and could resurrect a stale snapshot.
  await updateRunFields(input.runDir, { graphSnapshotPath })
  const output = {
    ok: true,
    patchId: normalized.candidate.id,
    status: 'applied',
    risk: normalized.candidate.risk,
    effectiveRisk,
    graphHash: written.graphHash,
    graphSnapshotPath,
    ...(plannerResult
      ? {
          planner: {
            role: plannerResult.output.role,
            structured: plannerResult.output.structured,
          },
          ...(plannerResult.usage ? { usage: plannerResult.usage } : {}),
        }
      : {}),
  }
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.dynamic_patch.applied',
    data: {
      nodeId: input.node.id,
      patchId: normalized.candidate.id,
      risk: normalized.candidate.risk,
      effectiveRisk,
      graphHash: written.graphHash,
      graphSnapshotPath,
    },
  })
  return { state: 'completed', output }
}
