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

import { mkdir, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  appendWorkflowEvent,
  readWorkflowRun,
  writeWorkflowRun,
} from './workflowStore.js'
import { recoverWorkflowRun } from './recovery.js'
import { inspectWorkflowRunLock } from './runLock.js'
import { refreshWorkflowBudgetLedger } from './budget.js'
import { readJson, writeJson } from './jsonIo.js'
import { withKeyedMutex } from './asyncMutex.js'
import { listWorkflowFrames } from './stateMachineStore.js'
import { resolveWorkflowTemplateValue } from './workflowExpressions.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunGraph,
  MatOSWorkflowRunSnapshot,
  MatOSWorkflowRunStatus,
} from './types.js'
import type { WorkflowApprovalRequest, WorkflowRunView } from './runtimeTypes.js'
import type { WorkflowArtifactRef } from './types.js'
import { workflowFailureSourceNodeIds } from './validationFailure.js'

export function nowIso(): string {
  return new Date().toISOString()
}

export function pathIsInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)
  const rel = relative(normalizedRoot, normalizedPath)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

export function nodeRunDir(runDir: string, nodeId: string): string {
  return join(runDir, 'node-runs', nodeId)
}

export function nodeRunPath(runDir: string, nodeId: string): string {
  return join(nodeRunDir(runDir, nodeId), 'node-run.json')
}

export function approvalPath(runDir: string, nodeId: string): string {
  return join(runDir, 'approvals', `${nodeId}.json`)
}

export function artifactsPath(runDir: string): string {
  return join(runDir, 'artifacts.json')
}

export async function readWorkflowDefinition(
  runDir: string,
): Promise<MatOSWorkflowDefinition> {
  const snapshot = await readWorkflowRun(runDir).catch(() => undefined)
  return readJson<MatOSWorkflowDefinition>(
    join(runDir, snapshot?.graphSnapshotPath ?? 'graph.snapshot.json'),
  )
}

export async function readApprovalRequest(
  runDir: string,
  nodeId: string,
): Promise<WorkflowApprovalRequest | undefined> {
  try {
    return await readJson<WorkflowApprovalRequest>(approvalPath(runDir, nodeId))
  } catch {
    return undefined
  }
}

export async function listApprovalRequests(
  runDir: string,
): Promise<WorkflowApprovalRequest[]> {
  let entries: string[]
  try {
    entries = await readdir(join(runDir, 'approvals'))
  } catch {
    return []
  }

  const approvals: WorkflowApprovalRequest[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) {
      continue
    }
    const approval = await readApprovalRequest(
      runDir,
      entry.slice(0, -'.json'.length),
    )
    if (approval) {
      approvals.push(approval)
    }
  }
  return approvals
}

export async function readWorkflowArtifacts(
  runDir: string,
): Promise<WorkflowArtifactRef[]> {
  try {
    const value = await readJson<unknown>(artifactsPath(runDir))
    return Array.isArray(value)
      ? value.filter(
          (item): item is WorkflowArtifactRef =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        )
      : []
  } catch {
    return []
  }
}

export async function writeWorkflowArtifacts(
  runDir: string,
  artifacts: WorkflowArtifactRef[],
): Promise<void> {
  await writeJson(artifactsPath(runDir), artifacts)
}

function errnoCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
}

export async function readNodeRun(
  runDir: string,
  nodeId: string,
): Promise<MatOSWorkflowNodeRunSnapshot | undefined> {
  // Only ENOENT may be interpreted as "this node never ran". Any other
  // failure (EMFILE under fd pressure, transient ESTALE on a network
  // filesystem, torn JSON) must NOT silently become `undefined`: the
  // scheduler treats an undefined record as pending and would re-run a
  // node that already completed — repeating its side effects. Retry once
  // for transient errors, then fail loudly so the advance segment aborts
  // and resume re-evaluates from intact state.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readJson<MatOSWorkflowNodeRunSnapshot>(
        nodeRunPath(runDir, nodeId),
      )
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        return undefined
      }
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      throw error
    }
  }
}

export async function writeNodeRun(
  runDir: string,
  snapshot: MatOSWorkflowNodeRunSnapshot,
): Promise<void> {
  await mkdir(nodeRunDir(runDir, snapshot.nodeId), { recursive: true })
  await writeJson(nodeRunPath(runDir, snapshot.nodeId), {
    ...snapshot,
    updatedAt: nowIso(),
  })
}

export async function resetNodeRun(
  runDir: string,
  nodeId: string,
): Promise<void> {
  const current = await readNodeRun(runDir, nodeId)
  await writeNodeRun(runDir, {
    nodeId,
    status: 'pending',
    attempts: current?.attempts ?? 0,
    updatedAt: nowIso(),
  })
}

export async function listNodeRuns(
  runDir: string,
): Promise<Map<string, MatOSWorkflowNodeRunSnapshot>> {
  const map = new Map<string, MatOSWorkflowNodeRunSnapshot>()
  let entries: string[]
  try {
    entries = await readdir(join(runDir, 'node-runs'))
  } catch {
    return map
  }
  // Read in parallel: this runs on every scheduler round and every
  // status/inspect poll, and sequential reads made large graphs pay one
  // network-filesystem round trip per node. Concurrency is bounded so a
  // very large graph cannot exhaust file descriptors (EMFILE) — which
  // readNodeRun would then surface as a hard error.
  const CONCURRENCY = 64
  for (let offset = 0; offset < entries.length; offset += CONCURRENCY) {
    const batch = entries.slice(offset, offset + CONCURRENCY)
    const runs = await Promise.all(batch.map(entry => readNodeRun(runDir, entry)))
    for (const run of runs) {
      if (run) {
        map.set(run.nodeId, run)
      }
    }
  }
  return map
}

export function viewFromSnapshot(
  runDir: string,
  snapshot: MatOSWorkflowRunSnapshot,
): WorkflowRunView {
  return {
    runId: snapshot.runId,
    workflowRef: snapshot.workflowRef,
    runDir,
    status: snapshot.status,
    artifactRoot: snapshot.artifactRoot,
    waitingNodeId: snapshot.waitingNodeId,
    ...(snapshot.trace ? { trace: snapshot.trace } : {}),
    ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}),
    outputs: snapshot.outputs,
  }
}

/**
 * Lightweight run-graph projection over the active graph snapshot. Carries
 * only structural identity (ids, types, dependencies, routed edges), not
 * prompt bodies or node payloads, so run inspection stays compact enough for
 * CLI JSON and workspace visualization clients.
 */
export function workflowRunGraphFromDefinition(
  definition: MatOSWorkflowDefinition | undefined,
): MatOSWorkflowRunGraph | undefined {
  if (!definition) {
    return undefined
  }
  const nodes: MatOSWorkflowRunGraph['nodes'] = definition.nodes.map(node => ({
    id: node.id,
    ...(typeof node.label === 'string' ? { label: node.label } : {}),
    type: node.type,
    ...(node.runtimeType ? { runtimeType: node.runtimeType } : {}),
    ...(node.targetType ? { targetType: node.targetType } : {}),
    dependsOn: [...node.dependsOn],
  }))
  const edges = new Map<string, MatOSWorkflowRunGraph['edges'][number]>()
  const rememberEdge = (edge: MatOSWorkflowRunGraph['edges'][number]): void => {
    edges.set(
      `${edge.from}->${edge.to}:${edge.route ?? 'success'}:${edge.condition ?? ''}`,
      edge,
    )
  }
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) {
      rememberEdge({ from: dependency, to: node.id })
    }
    for (const incoming of node.incomingEdges ?? []) {
      rememberEdge({
        from: incoming.from,
        to: node.id,
        ...(incoming.route ? { route: incoming.route } : {}),
        ...(incoming.condition ? { condition: incoming.condition } : {}),
      })
    }
  }
  for (const edge of definition.edges ?? []) {
    rememberEdge({
      from: edge.from,
      to: edge.to,
      ...(edge.route ? { route: edge.route } : {}),
      ...(edge.condition ? { condition: edge.condition } : {}),
    })
  }
  for (const transition of definition.transitions ?? []) {
    rememberEdge({
      from: transition.from,
      to: transition.to,
      ...(transition.route ? { route: transition.route } : {}),
      ...(transition.guard ? { condition: transition.guard } : {}),
    })
  }
  return {
    nodes,
    edges: [...edges.values()].sort(
      (left, right) =>
        left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    ),
  }
}

function orderedNodeRuns(
  definition: MatOSWorkflowDefinition | undefined,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
): MatOSWorkflowNodeRunSnapshot[] {
  const order = new Map(
    (definition?.nodes ?? []).map((node, index) => [node.id, index]),
  )
  return [...nodeRuns.values()].sort((left, right) => {
    const leftOrder = order.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = order.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder
    }
    return left.nodeId.localeCompare(right.nodeId)
  })
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function nodeRunDurationMs(
  node: MatOSWorkflowNodeRunSnapshot,
): number | undefined {
  const started = timestampMs(node.startedAt)
  const finished = timestampMs(node.finishedAt)
  if (started === undefined || finished === undefined || finished < started) {
    return undefined
  }
  return finished - started
}

/** Decide whether a failed node is worth retrying or whether the workflow itself is the problem.
 *
 * A node that has already failed more than once, or that reports an unchanged
 * retry cannot succeed, is not hitting a transient error: its workflow is
 * asking for something this claim cannot supply. Saying so lets the agent
 * re-parameterize, substitute, or fork instead of driving the same failing
 * path to the end of its retry budget.
 */
function failedNodeRemediation(
  node: MatOSWorkflowNodeRunSnapshot,
): NonNullable<
  NonNullable<WorkflowRunView['diagnostics']>['failedNodes'][number]['remediation']
> {
  const error = (node.error ?? {}) as {
    action?: unknown
    sameInputRetrySafe?: unknown
    details?: unknown
  }
  const details = (error.details ?? {}) as { sameInputRetrySafe?: unknown }
  const retryPointless =
    error.sameInputRetrySafe === false || details.sameInputRetrySafe === false
  const repeated = node.attempts > 1
  const causalSourceNodeIds = workflowFailureSourceNodeIds(node.error)
  if (causalSourceNodeIds.length > 0 && !repeated) {
    return {
      scope: 'node',
      action: 'repair_and_retry_upstream',
      hint: `Node ${node.nodeId} rejected output from causal producer(s) ${causalSourceNodeIds.join(', ')}. Repair and retry the earliest invalid producer; recompute its affected downstream closure.`,
    }
  }
  if (!repeated && !retryPointless) {
    return {
      scope: 'node',
      action:
        typeof error.action === 'string' && error.action.length > 0
          ? error.action
          : 'inspect_logs_and_repair',
      hint: `Repair the first error inside ${node.nodeId} and retry that node before changing the workflow.`,
    }
  }
  return {
    scope: 'workflow',
    action: 'adapt_workflow_or_substitute',
    hint: repeated
      ? `Node ${node.nodeId} failed ${node.attempts} times. Repeating it is unlikely to help; treat this as a workflow-contract mismatch rather than a transient error.`
      : `Node ${node.nodeId} cannot succeed on an unchanged retry; treat this as a workflow-contract mismatch rather than a transient error.`,
    options: [
      're-parameterize this workflow so its declared inputs and requirements match what the claim actually supplies',
      'substitute a published workflow whose contract fits the available inputs, toolchain, and assets',
      'fork this workflow into a labeled variant that expresses the step it is missing',
      'record an honest negative or reduced result, labeled as reduced, when no available workflow can express the claim',
      'never remove or weaken a validation gate to make a run pass; adapt inputs, parameters, or the chosen workflow instead',
    ],
  }
}

function workflowRunDiagnostics(
  nodes: MatOSWorkflowNodeRunSnapshot[],
): WorkflowRunView['diagnostics'] {
  const timeline = nodes.map(node => ({
    nodeId: node.nodeId,
    status: node.status,
    attempts: node.attempts,
    ...(node.startedAt ? { startedAt: node.startedAt } : {}),
    ...(node.finishedAt ? { finishedAt: node.finishedAt } : {}),
    ...(nodeRunDurationMs(node) !== undefined
      ? { durationMs: nodeRunDurationMs(node) }
      : {}),
  }))
  const failedNodes = nodes
    .filter(node => node.status === 'failed')
    .map(node => ({
      nodeId: node.nodeId,
      attempts: node.attempts,
      ...(nodeRunDurationMs(node) !== undefined
        ? { durationMs: nodeRunDurationMs(node) }
        : {}),
      ...(node.error !== undefined ? { error: node.error } : {}),
      remediation: failedNodeRemediation(node),
    }))
  const totalFinishedDurationMs = timeline.reduce((total, node) => {
    return total + (node.durationMs ?? 0)
  }, 0)
  return {
    nodeCount: nodes.length,
    completedCount: nodes.filter(node => node.status === 'completed').length,
    failedCount: failedNodes.length,
    runningCount: nodes.filter(node => node.status === 'running').length,
    waitingCount: nodes.filter(node =>
      node.status === 'waiting_input' || node.status === 'waiting_approval',
    ).length,
    pendingCount: nodes.filter(node => node.status === 'pending').length,
    ...(totalFinishedDurationMs > 0 ? { totalFinishedDurationMs } : {}),
    activeNodeIds: nodes
      .filter(node =>
        node.status === 'running' ||
        node.status === 'waiting_input' ||
        node.status === 'waiting_approval',
      )
      .map(node => node.nodeId),
    failedNodes,
    timeline,
  }
}

export async function inspectWorkflowRunView(
  runDir: string,
): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(runDir)
  const definition = await readWorkflowDefinition(runDir).catch(() => undefined)
  const approvals = await listApprovalRequests(runDir)
  const artifacts = await readWorkflowArtifacts(runDir)
  const budget = await refreshWorkflowBudgetLedger(runDir, definition)
  const frames = await listWorkflowFrames(runDir)
  const graph = workflowRunGraphFromDefinition(definition)
  const nodes = orderedNodeRuns(definition, await listNodeRuns(runDir))
  const lock =
    snapshot.status === 'running'
      ? await inspectWorkflowRunLock(runDir).catch(() => undefined)
      : undefined
  const recovery =
    lock?.state === 'stale'
      ? await recoverWorkflowRun(runDir).catch(() => undefined)
      : undefined
  return {
    ...viewFromSnapshot(runDir, snapshot),
    ...(definition?.name ? { workflowName: definition.name } : {}),
    nodes,
    artifacts,
    approvals,
    pendingApprovals: approvals.filter(approval => approval.status === 'pending'),
    budget,
    diagnostics: workflowRunDiagnostics(nodes),
    ...(graph ? { graph } : {}),
    ...(lock ? { runtimeState: { lock } } : {}),
    ...(recovery ? { recovery } : {}),
    ...(frames.length > 0 ? { stateMachine: { frames } } : {}),
  }
}

const TERMINAL_RUN_STATUSES = new Set<MatOSWorkflowRunStatus>([
  'completed',
  'failed',
  'cancelled',
])

export async function updateRunStatus(
  runDir: string,
  status: MatOSWorkflowRunStatus,
  fields: Partial<MatOSWorkflowRunSnapshot> = {},
): Promise<MatOSWorkflowRunSnapshot> {
  // Serialize the read-modify-write per run: a parallel scheduler batch can
  // finish several nodes at once in this process, and an unguarded RMW lets a
  // later writer resurrect the snapshot it read before a sibling's terminal
  // write (classic lost update).
  return withKeyedMutex(`run-status:${runDir}`, async () => {
    const snapshot = await readWorkflowRun(runDir)
    // Never regress a terminal run status. A failing node racing an
    // approval/input-gated sibling used to erase `failed` with
    // `waiting_approval`, after which the run could "complete" with outputs
    // from a failed node. Only an explicit restart to `running`
    // (operator retry/resume/respond paths) or an idempotent same-status
    // rewrite may follow a terminal state.
    if (
      TERMINAL_RUN_STATUSES.has(snapshot.status) &&
      status !== snapshot.status &&
      status !== 'running'
    ) {
      await appendWorkflowEvent(runDir, {
        type: 'workflow.run.status_change_rejected',
        data: { runId: snapshot.runId, from: snapshot.status, to: status },
      })
      return snapshot
    }
    const next: MatOSWorkflowRunSnapshot = {
      ...snapshot,
      ...fields,
      status,
    }
    await writeWorkflowRun(runDir, next)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.run.status_changed',
      data: { runId: snapshot.runId, status },
    })
    return readWorkflowRun(runDir)
  })
}

/**
 * Update non-status run.json fields (e.g. graphSnapshotPath) under the same
 * `run-status:` keyed mutex updateRunStatus uses. A bare read-modify-write of
 * run.json can race a concurrent updateRunStatus in this process and revert
 * whichever write lands first (lost update) — observed as a terminal status
 * or waitingNodeId resurrected by a stale snapshot. Status itself is
 * intentionally preserved; changing it must go through updateRunStatus so
 * terminal-state protection and status events stay in one place.
 */
export async function updateRunFields(
  runDir: string,
  fields: Partial<Omit<MatOSWorkflowRunSnapshot, 'status'>>,
): Promise<MatOSWorkflowRunSnapshot> {
  return withKeyedMutex(`run-status:${runDir}`, async () => {
    const snapshot = await readWorkflowRun(runDir)
    const next: MatOSWorkflowRunSnapshot = {
      ...snapshot,
      ...fields,
      status: snapshot.status,
    }
    await writeWorkflowRun(runDir, next)
    return readWorkflowRun(runDir)
  })
}

export function resolveWorkflowOutputs(
  definition: MatOSWorkflowDefinition,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
  parameters: Record<string, unknown>,
  workflow: Record<string, unknown>,
  artifacts: WorkflowArtifactRef[] = [],
): Record<string, unknown> {
  const context = { nodeRuns, artifacts, parameters, workflow }
  const outputs: Record<string, unknown> = {}
  for (const [key, output] of Object.entries(definition.outputs)) {
    outputs[key] = resolveWorkflowTemplateValue(output.value ?? output, context)
  }
  return outputs
}

function workflowParameterValueMatchesType(
  value: unknown,
  type: string,
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
    case 'float':
    case 'double':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
    case 'bool':
      return typeof value === 'boolean'
    case 'array':
    case 'list':
      return Array.isArray(value)
    case 'object':
    case 'map':
    case 'record':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'null':
      return value === null
    default:
      // Unknown/custom declared types are not enforced here.
      return true
  }
}

export type WorkflowParameterValidationIssue = {
  code:
    | 'unknown_workflow_parameter'
    | 'missing_required_parameter'
    | 'parameter_type_mismatch'
  key: string
  message: string
  expectedType?: string
  value?: unknown
}

export function validateWorkflowParameters(
  definition: MatOSWorkflowDefinition,
  parameters: Record<string, unknown> | undefined,
): WorkflowParameterValidationIssue[] {
  const declared = definition.parameters ?? {}
  const provided = parameters ?? {}
  const accepted = Object.keys(declared).sort()
  const acceptedMessage = accepted.length
    ? `Accepted parameters: ${accepted.join(', ')}.`
    : 'This workflow accepts no parameters.'
  const issues: WorkflowParameterValidationIssue[] = []

  for (const key of Object.keys(provided).sort()) {
    if (!Object.prototype.hasOwnProperty.call(declared, key)) {
      issues.push({
        code: 'unknown_workflow_parameter',
        key,
        message: `Unknown workflow parameter "${key}". ${acceptedMessage}`,
        value: provided[key],
      })
    }
  }

  for (const [key, parameter] of Object.entries(declared)) {
    const value = Object.prototype.hasOwnProperty.call(provided, key)
      ? provided[key]
      : parameter.default
    if (value === undefined) {
      if (parameter.required === true) {
        issues.push({
          code: 'missing_required_parameter',
          key,
          message: `Workflow parameter "${key}" is required.`,
        })
      }
      continue
    }
    if (value === null) {
      continue
    }
    const type = typeof parameter.type === 'string' ? parameter.type : undefined
    if (type && !workflowParameterValueMatchesType(value, type)) {
      issues.push({
        code: 'parameter_type_mismatch',
        key,
        message: `Workflow parameter "${key}" expected ${type}.`,
        expectedType: type,
        value,
      })
    }
  }
  return issues
}

export function resolveWorkflowParameters(
  definition: MatOSWorkflowDefinition,
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const issues = validateWorkflowParameters(definition, parameters)
  if (issues.length) {
    throw new Error(issues.map(issue => issue.message).join(' '))
  }
  const resolved: Record<string, unknown> = {}
  for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
    if (Object.prototype.hasOwnProperty.call(parameter, 'default')) {
      resolved[key] = parameter.default
    }
  }
  return { ...resolved, ...(parameters ?? {}) }
}

export function materializeWorkflowNode(
  node: MatOSWorkflowNode,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
  parameters: Record<string, unknown>,
  workflow: Record<string, unknown>,
  artifacts: WorkflowArtifactRef[] = [],
): MatOSWorkflowNode {
  const resolved = resolveWorkflowTemplateValue(node, {
    nodeRuns,
    artifacts,
    parameters,
    workflow,
  }) as MatOSWorkflowNode
  if (node.type === 'loop') {
    return {
      ...resolved,
      ...(node.initialState !== undefined ? { initialState: node.initialState } : {}),
      ...(node.nextParameters !== undefined ? { nextParameters: node.nextParameters } : {}),
      ...(node.nextState !== undefined ? { nextState: node.nextState } : {}),
      ...(typeof node.until === 'string' ? { until: node.until } : {}),
    }
  }
  return resolved
}
