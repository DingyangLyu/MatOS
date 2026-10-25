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

import { randomUUID } from 'node:crypto'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowGraphPatchOperation } from '../workflows/dynamicPatch.js'
import type {
MatOSWorkflowDefinition,
MatOSWorkflowNode,
MatOSWorkflowRunProvenance,
MatOSWorkflowValidationError,
MatOSWorkflowValidationResult,
} from '../workflows/types.js'
import { validateWorkflowDefinition } from '../workflows/validateWorkflow.js'
import type { MatOSWorkflowIntakeView } from '../workflows/workflowIntake.js'
import { buildMatOSWorkflowIntakeView } from '../workflows/workflowIntake.js'
import { matOSWorkflowService } from '../workflows/workflowService.js'
import { buildMatOSWorkbenchRunActions } from './actions.js'
import { redactMatOSWorkbenchValue } from './redaction.js'
import { showMatOSWorkbenchResource } from './resources.js'
import {
applyMatOSWorkbenchRoleDraft,
previewMatOSWorkbenchRoleDraft,
} from './roleDrafts.js'
import { streamMatOSWorkbenchRoleChatSessionTurn } from './roles.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchResourceQuery,
MatOSWorkbenchWorkflowBuilderSessionView,
MatOSWorkbenchWorkflowIntakeSessionView,
MatOSWorkbenchWorkflowRunGraph,
MatOSWorkbenchWorkflowRunGraphEdge,
MatOSWorkbenchWorkflowRunGraphNode,
MatOSWorkbenchWorkflowRunMonitorView,
MatOSWorkbenchWorkflowRunTimelineEntry,
MatOSWorkbenchWorkflowView,
} from './types.js'
import { previewMatOSWorkbenchWorkflowDraft } from './workflowDrafts.js'
import { workflowTraceRefsFromRunAndEvents } from './workflowTraceRefs.js'

export {
applyMatOSWorkbenchWorkflowDraft,
applyMatOSWorkbenchWorkflowToolAttachment,
loadMatOSWorkbenchWorkflowDefinition,
previewMatOSWorkbenchWorkflowDraft,
previewMatOSWorkbenchWorkflowToolAttachment
} from './workflowDrafts.js'
export {
deleteMatOSWorkbenchWorkflowTrigger,
getMatOSWorkbenchWorkflowTrigger,
listMatOSWorkbenchWorkflowTriggerEvents,
listMatOSWorkbenchWorkflowTriggers,
saveMatOSWorkbenchWorkflowTrigger
} from './workflowTriggers.js'

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function redactWorkbenchValue(value: unknown): unknown {
  return redactMatOSWorkbenchValue(value).value
}

function redactWorkbenchArray(value: unknown): unknown[] {
  return asArray(value).map(redactWorkbenchValue)
}

function workflowEventNodeStates(events: unknown[]): Array<Record<string, unknown>> {
  const nodes = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue
    }
    const type = String((event as { type?: unknown }).type || '').toLowerCase()
    const data = (event as { data?: unknown }).data
    if (!data || typeof data !== 'object') {
      continue
    }
    const nodeId = (data as { nodeId?: unknown }).nodeId
    if (typeof nodeId !== 'string' || !nodeId.trim()) {
      continue
    }
    const current = nodes.get(nodeId) ?? { nodeId }
    if (type === 'workflow.node.started') {
      nodes.set(nodeId, { ...current, status: 'running' })
    } else if (type === 'workflow.node.completed') {
      nodes.set(nodeId, { ...current, status: 'completed' })
    } else if (type === 'workflow.node.failed') {
      nodes.set(nodeId, { ...current, status: 'failed' })
    } else if (type === 'workflow.node.skipped') {
      nodes.set(nodeId, { ...current, status: 'skipped' })
    } else {
      nodes.set(nodeId, current)
    }
  }
  return [...nodes.values()]
}

function workflowRunNodes(run: unknown, events: unknown[]): Array<Record<string, unknown>> {
  if (!run || typeof run !== 'object') {
    return workflowEventNodeStates(events)
  }
  const nodes = (run as { nodes?: unknown }).nodes
  if (Array.isArray(nodes)) {
    const runNodes = nodes.filter((node): node is Record<string, unknown> =>
      Boolean(node && typeof node === 'object'),
    )
    return runNodes.length ? runNodes : workflowEventNodeStates(events)
  }
  return workflowEventNodeStates(events)
}

function statusIsFinished(status: unknown): boolean {
  return ['completed', 'failed', 'skipped', 'cancelled', 'canceled'].includes(
    String(status || '').toLowerCase(),
  )
}

function statusIsFailed(status: unknown): boolean {
  return ['failed', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase())
}

function pendingApprovalsFrom(input: unknown): unknown[] {
  if (!input || typeof input !== 'object') {
    return []
  }
  const pending = (input as { pendingApprovals?: unknown; approvals?: unknown }).pendingApprovals
  if (Array.isArray(pending)) {
    return pending
  }
  return asArray((input as { approvals?: unknown }).approvals).filter(approval => {
    if (!approval || typeof approval !== 'object') {
      return false
    }
    return String((approval as { status?: unknown }).status || '').toLowerCase() === 'pending'
  })
}

function approvalCountFrom(input: unknown): number {
  if (!input || typeof input !== 'object') {
    return 0
  }
  return asArray((input as { approvals?: unknown }).approvals).length
}

function traceRefsFrom(run: unknown, events: unknown[]): string[] {
  const refs = workflowTraceRefsFromRunAndEvents(run, events)
  if (refs.length > 0 || !run || typeof run !== 'object') {
    return refs
  }
  const runId = (run as { runId?: unknown }).runId
  return typeof runId === 'string' && runId.trim() ? [runId.trim()] : refs
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function budgetTotalsFrom(value: unknown):
  | {
      nodeAttempts: number
      agentCalls: number
      toolCalls: number
      backendJobs: number
      wallTimeMs: number
    }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const totals = value as Record<string, unknown>
  const numberOf = (key: string): number =>
    typeof totals[key] === 'number' && Number.isFinite(totals[key])
      ? (totals[key] as number)
      : 0
  return {
    nodeAttempts: numberOf('nodeAttempts'),
    agentCalls: numberOf('agentCalls'),
    toolCalls: numberOf('toolCalls'),
    backendJobs: numberOf('backendJobs'),
    wallTimeMs: numberOf('wallTimeMs'),
  }
}

function workflowRunBudgetEvidence(
  run: unknown,
): NonNullable<MatOSWorkbenchWorkflowView['evidence']>['budget'] {
  if (!run || typeof run !== 'object') {
    return undefined
  }
  const budget = (run as { budget?: unknown }).budget
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return undefined
  }
  const totals = budgetTotalsFrom((budget as { totals?: unknown }).totals)
  if (!totals) {
    return undefined
  }
  const violations = (budget as { violations?: unknown }).violations
  return {
    totals,
    violationCount: Array.isArray(violations) ? violations.length : 0,
  }
}

export function buildMatOSWorkbenchWorkflowEvidence(input: {
  run?: unknown
  events?: unknown[]
  artifacts?: unknown[]
  approvals?: unknown
}): NonNullable<MatOSWorkbenchWorkflowView['evidence']> {
  const events = input.events ?? []
  const nodes = workflowRunNodes(input.run, events)
  const finishedNodeCount = nodes.filter(node => statusIsFinished(node.status)).length
  const failedNodeCount = nodes.filter(node => statusIsFailed(node.status)).length
  const run =
    input.run && typeof input.run === 'object'
      ? (input.run as { runId?: unknown; status?: unknown; waitingNodeId?: unknown })
      : {}
  const budget = workflowRunBudgetEvidence(input.run)
  const runRecord = objectField(input.run) ?? {}
  const trace = objectField(runRecord.trace)
  const provenance = objectField(runRecord.provenance)
  return {
    ...(typeof run.runId === 'string' ? { runId: run.runId } : {}),
    ...(typeof run.status === 'string' ? { status: run.status } : {}),
    nodeCount: nodes.length,
    finishedNodeCount,
    failedNodeCount,
    eventCount: events.length,
    artifactCount: input.artifacts?.length ?? 0,
    approvalCount: approvalCountFrom(input.approvals),
    pendingApprovalCount: pendingApprovalsFrom(input.approvals).length,
    ...(typeof run.waitingNodeId === 'string' && run.waitingNodeId
      ? { waitingNodeId: run.waitingNodeId }
      : {}),
    traceRefs: traceRefsFrom(input.run, events),
    ...(trace ? { trace } : {}),
    ...(provenance ? { provenance } : {}),
    ...(budget ? { budget } : {}),
  }
}

const RUN_GRAPH_TIMELINE_EVENT_PREFIXES = [
  'workflow.run.',
  'workflow.node.',
  'workflow.human.',
  'workflow.approval.',
  'workflow.scheduler.',
  'workflow.budget.',
  'workflow.dynamic_patch.',
  'workflow.state_machine.',
  'workflow.recovery.',
  'workflow.map.',
]
const RUN_GRAPH_TIMELINE_LIMIT = 200
const WAITING_NODE_STATUSES = new Set(['waiting_input', 'waiting_approval'])

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function nodeErrorSummary(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim()) {
    return error.slice(0, 300)
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) {
      return message.slice(0, 300)
    }
  }
  return undefined
}

function runGraphTimelineFrom(
  events: unknown[],
): { entries: MatOSWorkbenchWorkflowRunTimelineEntry[]; truncated: boolean } {
  const entries: MatOSWorkbenchWorkflowRunTimelineEntry[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue
    }
    const record = event as { type?: unknown; timestamp?: unknown; data?: unknown }
    const type = String(record.type || '')
    if (!RUN_GRAPH_TIMELINE_EVENT_PREFIXES.some(prefix => type.startsWith(prefix))) {
      continue
    }
    const data =
      record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : {}
    const summaryParts: string[] = []
    for (const key of ['status', 'reason', 'action', 'classification'] as const) {
      const value = data[key]
      if (typeof value === 'string' && value.trim()) {
        summaryParts.push(`${key}=${value.slice(0, 120)}`)
      }
    }
    entries.push({
      ...(stringField(record.timestamp) ? { at: String(record.timestamp) } : {}),
      type,
      ...(stringField(data.nodeId) ? { nodeId: String(data.nodeId) } : {}),
      ...(summaryParts.length ? { summary: summaryParts.join(' ') } : {}),
    })
  }
  const truncated = entries.length > RUN_GRAPH_TIMELINE_LIMIT
  return {
    entries: truncated ? entries.slice(-RUN_GRAPH_TIMELINE_LIMIT) : entries,
    truncated,
  }
}

function runGraphNodeDurationMs(nodeRun: Record<string, unknown>): number | undefined {
  const startedAt = Date.parse(String(nodeRun.startedAt || ''))
  const finishedAt = Date.parse(String(nodeRun.finishedAt || ''))
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    return undefined
  }
  return Math.max(0, finishedAt - startedAt)
}

/**
 * Build the read-only run-graph view model that visualization clients
 * (the workspace workflow view, CLI JSON consumers) render: structural graph
 * nodes/edges from the active graph snapshot decorated with live node-run
 * status, per-node budget, the durable budget ledger, and a compact event
 * timeline.
 */
export function buildMatOSWorkbenchWorkflowRunGraph(input: {
  run?: unknown
  events?: unknown[]
}): MatOSWorkbenchWorkflowRunGraph {
  const events = input.events ?? []
  const run =
    input.run && typeof input.run === 'object'
      ? (input.run as Record<string, unknown>)
      : {}
  const graph =
    run.graph && typeof run.graph === 'object' && !Array.isArray(run.graph)
      ? (run.graph as { nodes?: unknown; edges?: unknown })
      : {}
  const nodeRunById = new Map<string, Record<string, unknown>>()
  for (const nodeRun of workflowRunNodes(input.run, events)) {
    const nodeId = stringField(nodeRun.nodeId)
    if (nodeId) {
      nodeRunById.set(nodeId, nodeRun)
    }
  }
  const budget =
    run.budget && typeof run.budget === 'object' && !Array.isArray(run.budget)
      ? (run.budget as Record<string, unknown>)
      : undefined
  const budgetByNode =
    budget?.byNode && typeof budget.byNode === 'object' && !Array.isArray(budget.byNode)
      ? (budget.byNode as Record<string, unknown>)
      : {}

  const graphNodes = Array.isArray(graph.nodes)
    ? graph.nodes.filter(
        (node): node is Record<string, unknown> =>
          Boolean(node && typeof node === 'object'),
      )
    : []
  const nodeIds = graphNodes.length
    ? graphNodes.map(node => String(node.id || ''))
    : [...nodeRunById.keys()]
  const graphNodeById = new Map(
    graphNodes.map(node => [String(node.id || ''), node]),
  )

  const nodes: MatOSWorkbenchWorkflowRunGraphNode[] = nodeIds
    .filter(Boolean)
    .map(nodeId => {
      const graphNode = graphNodeById.get(nodeId) ?? {}
      const nodeRun = nodeRunById.get(nodeId) ?? {}
      const status = stringField(nodeRun.status) ?? 'pending'
      const durationMs = runGraphNodeDurationMs(nodeRun)
      const nodeBudget = budgetTotalsFrom(budgetByNode[nodeId])
      const error = nodeErrorSummary(nodeRun.error)
      return {
        id: nodeId,
        type: stringField(graphNode.type) ?? 'unknown',
        ...(stringField(graphNode.runtimeType)
          ? { runtimeType: String(graphNode.runtimeType) }
          : {}),
        ...(stringField(graphNode.targetType)
          ? { targetType: String(graphNode.targetType) }
          : {}),
        status,
        attempts:
          typeof nodeRun.attempts === 'number' && Number.isFinite(nodeRun.attempts)
            ? (nodeRun.attempts as number)
            : 0,
        ...(stringField(nodeRun.startedAt)
          ? { startedAt: String(nodeRun.startedAt) }
          : {}),
        ...(stringField(nodeRun.finishedAt)
          ? { finishedAt: String(nodeRun.finishedAt) }
          : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        waiting: WAITING_NODE_STATUSES.has(status),
        ...(error ? { error } : {}),
        ...(nodeBudget ? { budget: nodeBudget } : {}),
      }
    })

  const edges: MatOSWorkbenchWorkflowRunGraphEdge[] = (
    Array.isArray(graph.edges) ? graph.edges : []
  )
    .filter(
      (edge): edge is Record<string, unknown> =>
        Boolean(edge && typeof edge === 'object'),
    )
    .map(edge => ({
      from: String(edge.from || ''),
      to: String(edge.to || ''),
      route: stringField(edge.route) ?? 'success',
      ...(stringField(edge.condition) ? { condition: String(edge.condition) } : {}),
    }))
    .filter(edge => edge.from && edge.to)

  const stateMachineFrames =
    run.stateMachine &&
    typeof run.stateMachine === 'object' &&
    Array.isArray((run.stateMachine as { frames?: unknown }).frames)
      ? ((run.stateMachine as { frames: unknown[] }).frames.filter(
          (frame): frame is Record<string, unknown> =>
            Boolean(frame && typeof frame === 'object'),
        ) as Record<string, unknown>[])
      : []

  const timeline = runGraphTimelineFrom(events)
  const statusCount = (matcher: (status: string) => boolean): number =>
    nodes.filter(node => matcher(node.status)).length
  const violations = budget?.violations
  return {
    mode: 'native-workflow-run-graph',
    readonly: true,
    ...(stringField(run.runId) ? { runId: String(run.runId) } : {}),
    ...(stringField(run.workflowRef)
      ? { workflowRef: String(run.workflowRef) }
      : budget && stringField(budget.workflowRef)
        ? { workflowRef: String(budget.workflowRef) }
        : {}),
    ...(stringField(run.status) ? { status: String(run.status) } : {}),
    ...(stringField(run.waitingNodeId)
      ? { waitingNodeId: String(run.waitingNodeId) }
      : {}),
    nodes,
    edges,
    ...(budget ? { budget } : {}),
    timeline: timeline.entries,
    ...(stateMachineFrames.length
      ? {
          stateMachine: {
            frameCount: stateMachineFrames.length,
            frames: stateMachineFrames.map(frame => ({
              frameId: String(frame.frameId || ''),
              index:
                typeof frame.index === 'number' && Number.isFinite(frame.index)
                  ? (frame.index as number)
                  : 0,
              activeNodeId: String(frame.activeNodeId || ''),
              status: String(frame.status || ''),
              ...(stringField(frame.transitionEdgeId)
                ? { transitionEdgeId: String(frame.transitionEdgeId) }
                : {}),
            })),
          },
        }
      : {}),
    summary: {
      nodeCount: nodes.length,
      completedNodeCount: statusCount(status => status === 'completed'),
      failedNodeCount: statusCount(status => statusIsFailed(status)),
      runningNodeCount: statusCount(status => status === 'running'),
      waitingNodeCount: statusCount(status => WAITING_NODE_STATUSES.has(status)),
      pendingNodeCount: statusCount(status => status === 'pending' || status === 'ready'),
      skippedNodeCount: statusCount(status => status === 'skipped'),
      edgeCount: edges.length,
      eventCount: events.length,
      timelineCount: timeline.entries.length,
      timelineTruncated: timeline.truncated,
      budgetViolationCount: Array.isArray(violations) ? violations.length : 0,
      source: 'matos-workflow-run',
    },
  }
}

export async function listMatOSWorkbenchWorkflows(
  input: MatOSWorkbenchResourceQuery,
) {
  const { listMatOSWorkbenchResources } = await import('./resources.js')
  return listMatOSWorkbenchResources({
    ...input,
    types: ['workflow'],
    query: input.query,
    limit: input.limit,
    offset: input.offset,
    includeLineage: input.lightweight ? false : true,
  })
}

export async function showMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & { ref: string },
): Promise<MatOSWorkbenchWorkflowView> {
  const [resource, workflow] = await Promise.all([
    showMatOSWorkbenchResource({ ...input, ref: input.ref, includeGraph: true }),
    matOSWorkflowService.show(input),
  ])
  return {
    resource: resource.resource,
    workflow: workflow.workflow,
    kind: workflow.kind,
    definition: workflow.definition,
    validation: workflow.validation,
    nodeManifests: workflow.nodeManifests,
    nodeManifestReport: workflow.nodeManifestReport,
  }
}

export async function validateMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & { ref: string },
): Promise<MatOSWorkbenchWorkflowView> {
  return {
    ...(await showMatOSWorkbenchWorkflow(input)),
    validation: await matOSWorkflowService.validate(input),
  }
}

export async function compileMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & { ref: string },
): Promise<MatOSWorkbenchWorkflowView> {
  return {
    ...(await showMatOSWorkbenchWorkflow(input)),
    compile: await matOSWorkflowService.compile(input),
  }
}

export async function compileInspectMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const result = await matOSWorkflowService.compileInspect(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function contractsMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & {
    ref?: string
    draftId?: string
    runId?: string
  },
) {
  const result = await matOSWorkflowService.contracts(input)
  return redactWorkbenchValue(result) as typeof result
}

function isWorkflowDefinition(value: unknown): value is MatOSWorkflowDefinition {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nowIso(): string {
  return new Date().toISOString()
}

function workbenchStateDir(cwd: string, name: string): string {
  return join(cwd, '.matos', 'workbench', name)
}

function safeStateId(value: string): string {
  if (!/^[A-Za-z0-9_.:@-]+$/.test(value)) {
    throw new Error(`Invalid MatOS workbench state id: ${value}`)
  }
  return value
}

async function readWorkbenchState<T>(
  cwd: string,
  store: string,
  id: string,
): Promise<T> {
  const path = join(workbenchStateDir(cwd, store), `${safeStateId(id)}.json`)
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function writeWorkbenchState(
  cwd: string,
  store: string,
  id: string,
  value: unknown,
): Promise<void> {
  const dir = workbenchStateDir(cwd, store)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${safeStateId(id)}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  )
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function unquoteSimpleValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseSimpleParameterValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed === 'true') {
    return true
  }
  if (trimmed === 'false') {
    return false
  }
  if (trimmed === 'null') {
    return null
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed)
    if (Number.isFinite(number)) {
      return number
    }
  }
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return unquoteSimpleValue(trimmed)
    }
  }
  return unquoteSimpleValue(trimmed)
}

function extractJsonObjectText(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return trimmed
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const fencedText = fenced?.[1]?.trim()
  return fencedText?.startsWith('{') ? fencedText : undefined
}

function parametersFromMessage(message: string | undefined): Record<string, unknown> {
  const text = message?.trim()
  if (!text) {
    return {}
  }
  const jsonText = extractJsonObjectText(text)
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as unknown
      return objectValue(parsed) ?? {}
    } catch {
      // Fall through to key=value extraction for natural-language intake.
    }
  }
  const extracted: Record<string, unknown> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('- ')) {
      continue
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:|：)\s*(.+)$/)
    if (!match) {
      continue
    }
    extracted[match[1]] = parseSimpleParameterValue(match[2])
  }
  if (Object.keys(extracted).length > 0) {
    return extracted
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return objectValue(parsed) ?? {}
  } catch {
    return {}
  }
}

function mergeParameters(
  base?: Record<string, unknown>,
  next?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(next ?? {}),
  }
}

function intakeStatusFrom(intake: MatOSWorkflowIntakeView): MatOSWorkbenchWorkflowIntakeSessionView['status'] {
  if (intake.canRun) {
    return 'ready'
  }
  return intake.errors.length ? 'blocked' : 'collecting'
}

function intakeSessionStatusFromRun(status: unknown): MatOSWorkbenchWorkflowIntakeSessionView['status'] {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'completed') {
    return 'completed'
  }
  if (normalized === 'failed') {
    return 'failed'
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return 'cancelled'
  }
  return 'running'
}

function intakeAssistantPrompt(intake: MatOSWorkflowIntakeView): string {
  if (intake.canRun) {
    return 'All required workflow inputs are available. The session can run through the native MatOS workflow runtime.'
  }
  const missing = intake.missingRequired.length
    ? intake.missingRequired.join(', ')
    : 'required workflow inputs'
  return `Collect values for ${missing}. Use explicit parameter values so the native workflow intake preflight can verify them.`
}

type WorkflowIntakeAssistantHandoff = {
  mode: 'native-workflow-intake-assistant-handoff'
  source: 'role:workflow-ui-builder'
  ok: boolean
  chatSessionId: string
  conversationId: string
  promptLength: number
  frameCount: number
  eventCount: number
  text: string
  extractedParameters: Record<string, unknown>
  error?: string
}

function workflowIntakeAssistantPrompt(input: {
  sessionId: string
  workflowRef: string
  userMessage: string
  parameters: Record<string, unknown>
  intake: MatOSWorkflowIntakeView
}): string {
  return [
    'You are being invoked from the MatOS native workflow run intake session.',
    'Help the user provide workflow input values, but do not run the workflow and do not edit files.',
    'If you can infer parameter values, include one compact JSON object containing only workflow parameter keys and values.',
    'If values are missing or risky, ask concise follow-up questions instead of guessing.',
    'The native workflow intake preflight will verify any extracted values after your response.',
    '',
    `intakeSessionId: ${input.sessionId}`,
    `workflowRef: ${input.workflowRef}`,
    `currentParameters: ${JSON.stringify(input.parameters).slice(0, 4000)}`,
    `missingRequired: ${JSON.stringify(input.intake.missingRequired)}`,
    `fields: ${JSON.stringify(input.intake.fields.map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      description: field.description,
      placeholder: field.placeholder,
      defaultValue: field.defaultValue,
      sourceHints: field.sourceHints,
    }))).slice(0, 8000)}`,
    '',
    `userMessage: ${input.userMessage}`,
  ].join('\n')
}

function textFromAssistantStreamEvent(event: Record<string, unknown>): string {
  if (typeof event.text === 'string') {
    return event.text
  }
  if (typeof event.message === 'string') {
    return event.message
  }
  const nestedEvent = objectValue(event.event)
  const delta = objectValue(nestedEvent?.delta)
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return delta.text
  }
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return ''
  }
  const contentBlock = objectValue(nestedEvent?.content_block)
  if (typeof contentBlock?.text === 'string') {
    return contentBlock.text
  }
  if (event.type === 'matos.agent.message' && typeof event.summary === 'string') {
    return event.summary
  }
  return ''
}

async function runWorkflowIntakeAssistantHandoff(
  input: MatOSWorkbenchContext & {
    sessionId: string
    workflowRef: string
    userMessage: string
    parameters: Record<string, unknown>
    intake: MatOSWorkflowIntakeView
  },
): Promise<WorkflowIntakeAssistantHandoff> {
  const roleRef = 'role:workflow-ui-builder' as const
  const conversationId = `workflow-intake:${input.sessionId}`
  const chatSessionId = `matos-workflow-intake:${input.sessionId}`
  const prompt = workflowIntakeAssistantPrompt(input)
  let frameCount = 0
  let eventCount = 0
  let text = ''
  try {
    for await (const rawFrame of streamMatOSWorkbenchRoleChatSessionTurn({
      ...input,
      ref: roleRef,
      message: prompt,
      conversationId,
      chatSessionId,
    })) {
      const frame = rawFrame as Record<string, unknown>
      frameCount += 1
      if (frame.type === 'event') {
        eventCount += 1
        const chunk = textFromAssistantStreamEvent(objectValue(frame.event) ?? {})
        if (chunk) {
          text += chunk
        }
      }
      if (frame.type === 'done') {
        const status = String(frame.status || '')
        if (status && status !== 'completed') {
          return {
            mode: 'native-workflow-intake-assistant-handoff',
            source: roleRef,
            ok: false,
            chatSessionId,
            conversationId,
            promptLength: prompt.length,
            frameCount,
            eventCount,
            text,
            extractedParameters: {},
            error: typeof frame.error === 'string' ? frame.error : `assistant status: ${status}`,
          }
        }
      }
    }
    const extractedParameters = parametersFromMessage(text)
    return {
      mode: 'native-workflow-intake-assistant-handoff',
      source: roleRef,
      ok: true,
      chatSessionId,
      conversationId,
      promptLength: prompt.length,
      frameCount,
      eventCount,
      text,
      extractedParameters,
    }
  } catch (error) {
    return {
      mode: 'native-workflow-intake-assistant-handoff',
      source: roleRef,
      ok: false,
      chatSessionId,
      conversationId,
      promptLength: prompt.length,
      frameCount,
      eventCount,
      text,
      extractedParameters: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function buildIntakeSessionView(input: {
  cwd: string
  scopeRef?: string
  sessionId: string
  workflowRef: string
  parameters?: Record<string, unknown>
  messages: MatOSWorkbenchWorkflowIntakeSessionView['messages']
  lastAssistant?: WorkflowIntakeAssistantHandoff
  status?: MatOSWorkbenchWorkflowIntakeSessionView['status']
  runId?: string
  createdAt: string
  updatedAt?: string
}): Promise<MatOSWorkbenchWorkflowIntakeSessionView> {
  const prepared = await prepareMatOSWorkbenchWorkflowIntake({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    ref: input.workflowRef,
    parameters: input.parameters,
  })
  if (!prepared.intake) {
    throw new Error(`Workflow intake unavailable: ${input.workflowRef}`)
  }
  const updatedAt = input.updatedAt ?? nowIso()
  return {
    mode: 'native-workflow-intake-session',
    schemaVersion: 1,
    sessionId: input.sessionId,
    workflowRef: prepared.intake.workflowRef,
    status: input.status ?? intakeStatusFrom(prepared.intake),
    createdAt: input.createdAt,
    updatedAt,
    parameters: input.parameters ?? {},
    messages: input.messages,
    intake: prepared.intake,
    assistant: {
      enabled: true,
      source: 'native-matos-workflow-intake',
      prompt: intakeAssistantPrompt(prepared.intake),
      missingRequired: prepared.intake.missingRequired,
      canRun: prepared.intake.canRun,
      ...(input.lastAssistant
        ? {
            lastHandoff: {
              mode: input.lastAssistant.mode,
              source: input.lastAssistant.source,
              ok: input.lastAssistant.ok,
              chatSessionId: input.lastAssistant.chatSessionId,
              conversationId: input.lastAssistant.conversationId,
              frameCount: input.lastAssistant.frameCount,
              eventCount: input.lastAssistant.eventCount,
              extractedParameterCount: Object.keys(input.lastAssistant.extractedParameters).length,
              ...(input.lastAssistant.error ? { error: input.lastAssistant.error } : {}),
            },
          }
        : {}),
    },
    actions: {
      send: {
        endpoint: 'workflows.intakeSession',
        params: { action: 'send', sessionId: input.sessionId },
        enabled: true,
      },
      confirm: {
        endpoint: 'workflows.intakeSession',
        params: { action: 'confirm', sessionId: input.sessionId },
        enabled: prepared.intake.canRun,
      },
      run: {
        endpoint: 'workflows.intakeSession',
        params: { action: 'run', sessionId: input.sessionId },
        enabled: prepared.intake.canRun,
      },
    },
    ...(input.runId ? { runId: input.runId } : {}),
  }
}

async function persistIntakeSession(
  cwd: string,
  view: MatOSWorkbenchWorkflowIntakeSessionView,
): Promise<void> {
  await writeWorkbenchState(cwd, 'workflow-intake-sessions', view.sessionId, view)
}

export async function prepareMatOSWorkbenchWorkflowIntake(
  input: MatOSWorkbenchContext & {
    ref: string
    parameters?: Record<string, unknown>
  },
): Promise<MatOSWorkbenchWorkflowView> {
  const view = await showMatOSWorkbenchWorkflow(input)
  if (!isWorkflowDefinition(view.definition)) {
    throw new Error(`Workflow definition not available: ${input.ref}`)
  }
  const workflowRef =
    typeof view.resource?.ref === 'string' && view.resource.ref.trim()
      ? view.resource.ref
      : input.ref
  return {
    ...view,
    intake: buildMatOSWorkflowIntakeView({
      workflowRef,
      definition: view.definition,
      parameters: input.parameters,
    }),
  }
}

export async function startMatOSWorkbenchWorkflowIntakeSession(
  input: MatOSWorkbenchContext & {
    ref: string
    parameters?: Record<string, unknown>
    message?: string
  },
): Promise<MatOSWorkbenchWorkflowIntakeSessionView> {
  const sessionId = `workflow-intake-${randomUUID()}`
  const createdAt = nowIso()
  const message = input.message?.trim()
  const parameters = mergeParameters(
    input.parameters,
    parametersFromMessage(message),
  )
  const messages: MatOSWorkbenchWorkflowIntakeSessionView['messages'] = message
    ? [{ at: createdAt, role: 'user', content: message }]
    : []
  const view = await buildIntakeSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId,
    workflowRef: input.ref,
    parameters,
    messages,
    createdAt,
  })
  await persistIntakeSession(input.cwd, view)
  return view
}

export async function showMatOSWorkbenchWorkflowIntakeSession(
  input: MatOSWorkbenchContext & { sessionId: string },
): Promise<MatOSWorkbenchWorkflowIntakeSessionView> {
  const stored = await readWorkbenchState<MatOSWorkbenchWorkflowIntakeSessionView>(
    input.cwd,
    'workflow-intake-sessions',
    input.sessionId,
  )
  const terminalOrConfirmed = new Set(['confirmed', 'running', 'completed', 'failed', 'cancelled'])
  return buildIntakeSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId: stored.sessionId,
    workflowRef: stored.workflowRef,
    parameters: stored.parameters,
    messages: stored.messages,
    status: terminalOrConfirmed.has(stored.status) ? stored.status : undefined,
    runId: stored.runId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  })
}

export async function sendMatOSWorkbenchWorkflowIntakeSession(
  input: MatOSWorkbenchContext & {
    sessionId: string
    parameters?: Record<string, unknown>
    message?: string
  },
): Promise<MatOSWorkbenchWorkflowIntakeSessionView> {
  const current = await showMatOSWorkbenchWorkflowIntakeSession(input)
  const at = nowIso()
  const message = input.message?.trim()
  const extracted = parametersFromMessage(message)
  let parameters = mergeParameters(
    current.parameters,
    mergeParameters(input.parameters, extracted),
  )
  const messages = [
    ...current.messages,
    ...(message
      ? [{
          at,
          role: 'user' as const,
          content: message,
          ...(Object.keys(extracted).length ? { extractedParameters: extracted } : {}),
        }]
      : []),
  ]
  const needsAssistant =
    message &&
    Object.keys(extracted).length === 0 &&
    current.intake.missingRequired.length > 0 &&
    input.env?.MATOS_WORKFLOW_INTAKE_ASSISTANT !== '0'
  const assistant = needsAssistant
    ? await runWorkflowIntakeAssistantHandoff({
        ...input,
        workflowRef: current.workflowRef,
        userMessage: message,
        parameters,
        intake: current.intake,
      })
    : undefined
  if (assistant?.ok && Object.keys(assistant.extractedParameters).length > 0) {
    parameters = mergeParameters(parameters, assistant.extractedParameters)
  }
  const assistantMessage = assistant
    ? {
        at,
        role: 'agent' as const,
        content: assistant.text || (
          assistant.ok
            ? 'Native workflow intake assistant completed without additional text.'
            : `Native workflow intake assistant failed: ${assistant.error ?? 'unknown error'}`
        ),
        ...(Object.keys(assistant.extractedParameters).length
          ? { extractedParameters: assistant.extractedParameters }
          : {}),
      }
    : undefined
  const view = await buildIntakeSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId: input.sessionId,
    workflowRef: current.workflowRef,
    parameters,
    messages: assistantMessage ? [...messages, assistantMessage] : messages,
    ...(assistant ? { lastAssistant: assistant } : {}),
    createdAt: current.createdAt,
    updatedAt: at,
  })
  await persistIntakeSession(input.cwd, view)
  return view
}

export async function confirmMatOSWorkbenchWorkflowIntakeSession(
  input: MatOSWorkbenchContext & { sessionId: string },
): Promise<MatOSWorkbenchWorkflowIntakeSessionView> {
  const current = await showMatOSWorkbenchWorkflowIntakeSession(input)
  const view = await buildIntakeSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId: input.sessionId,
    workflowRef: current.workflowRef,
    parameters: current.parameters,
    messages: [
      ...current.messages,
      {
        at: nowIso(),
        role: 'system',
        content: current.intake.canRun
          ? 'Workflow inputs confirmed by native intake preflight.'
          : 'Workflow inputs cannot be confirmed because required inputs are still missing.',
      },
    ],
    status: current.intake.canRun ? 'confirmed' : intakeStatusFrom(current.intake),
    createdAt: current.createdAt,
  })
  await persistIntakeSession(input.cwd, view)
  return view
}

export async function runMatOSWorkbenchWorkflowIntakeSession(
  input: MatOSWorkbenchContext & { sessionId: string },
): Promise<MatOSWorkbenchWorkflowIntakeSessionView & { run?: MatOSWorkbenchWorkflowView['run']; monitor?: MatOSWorkbenchWorkflowRunMonitorView }> {
  const current = await showMatOSWorkbenchWorkflowIntakeSession(input)
  if (!current.intake.canRun) {
    throw new Error(
      `Workflow intake session ${input.sessionId} is missing required inputs: ${current.intake.missingRequired.join(', ')}`,
    )
  }
  const run = await runMatOSWorkbenchWorkflow({
    ...input,
    ref: current.workflowRef,
    parameters: current.intake.resolvedParameters ?? current.parameters,
    provenance: {
      source: 'manual',
      triggerId: input.sessionId,
    },
  })
  const runId = run.run?.runId
  const at = nowIso()
  const view = await buildIntakeSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId: input.sessionId,
    workflowRef: current.workflowRef,
    parameters: current.parameters,
    messages: [
      ...current.messages,
      {
        at,
        role: 'system',
        content: `Workflow run started through native runtime${runId ? `: ${runId}` : ''}.`,
      },
    ],
    status: intakeSessionStatusFromRun(run.run?.status),
    runId,
    createdAt: current.createdAt,
    updatedAt: at,
  })
  await persistIntakeSession(input.cwd, view)
  const monitor = runId
    ? await monitorMatOSWorkbenchWorkflowRun({ ...input, runId })
    : undefined
  return {
    ...view,
    run: run.run,
    ...(monitor ? { monitor } : {}),
  }
}

export async function runMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & {
    ref: string
    parameters?: Record<string, unknown>
    recordSession?: boolean
    provenance?: MatOSWorkflowRunProvenance
  },
): Promise<MatOSWorkbenchWorkflowView & { actions: ReturnType<typeof buildMatOSWorkbenchRunActions> }> {
  const result = await matOSWorkflowService.run({
    ...input,
    parameters: input.parameters,
    recordSession: input.recordSession,
    provenance: input.provenance,
  })
  const runContext = {
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    runId: result.run.runId,
  }
  const events = await matOSWorkflowService.events(runContext).catch(() => ({ events: [] }))
  const artifacts = await matOSWorkflowService.artifacts(runContext).catch(() => ({ artifacts: [] }))
  const approvals = await matOSWorkflowService
    .approvalStatus(runContext)
    .catch(() => ({ approvals: [], pendingApprovals: [] }))
  const safeRun = redactWorkbenchValue(result.run) as typeof result.run
  const eventList = redactWorkbenchArray((events as { events?: unknown }).events)
  const artifactList = redactWorkbenchArray((artifacts as { artifacts?: unknown }).artifacts)
  const safeApprovals = redactWorkbenchValue(approvals)
  return {
    run: safeRun,
    events: eventList,
    artifacts: artifactList,
    approvals: safeApprovals,
    evidence: buildMatOSWorkbenchWorkflowEvidence({
      run: safeRun,
      events: eventList,
      artifacts: artifactList,
      approvals: safeApprovals,
    }),
    actions: buildMatOSWorkbenchRunActions({
      runId: safeRun.runId,
      status: safeRun.status,
      waitingNodeId: safeRun.waitingNodeId,
    }),
  }
}

export async function debugMatOSWorkbenchWorkflowNode(
  input: MatOSWorkbenchContext & {
    ref: string
    nodeId: string
    parameters?: Record<string, unknown>
    recordSession?: boolean
    provenance?: MatOSWorkflowRunProvenance
  },
): Promise<MatOSWorkbenchWorkflowView & { actions: ReturnType<typeof buildMatOSWorkbenchRunActions> }> {
  const result = await matOSWorkflowService.nodeDebug({
    ...input,
    nodeId: input.nodeId,
    parameters: input.parameters,
    recordSession: input.recordSession,
    provenance: input.provenance,
  })
  const runContext = {
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    runId: result.run.runId,
  }
  const events = await matOSWorkflowService.events(runContext).catch(() => ({ events: [] }))
  const artifacts = await matOSWorkflowService.artifacts(runContext).catch(() => ({ artifacts: [] }))
  const approvals = await matOSWorkflowService
    .approvalStatus(runContext)
    .catch(() => ({ approvals: [], pendingApprovals: [] }))
  const safeRun = redactWorkbenchValue(result.run) as typeof result.run
  const eventList = redactWorkbenchArray((events as { events?: unknown }).events)
  const artifactList = redactWorkbenchArray((artifacts as { artifacts?: unknown }).artifacts)
  const safeApprovals = redactWorkbenchValue(approvals)
  return {
    run: safeRun,
    events: eventList,
    artifacts: artifactList,
    approvals: safeApprovals,
    evidence: buildMatOSWorkbenchWorkflowEvidence({
      run: safeRun,
      events: eventList,
      artifacts: artifactList,
      approvals: safeApprovals,
    }),
    actions: buildMatOSWorkbenchRunActions({
      runId: safeRun.runId,
      status: safeRun.status,
      waitingNodeId: safeRun.waitingNodeId,
    }),
  }
}

export async function inspectMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const [result, events, artifacts, approvals] = await Promise.all([
    matOSWorkflowService.inspect(input),
    matOSWorkflowService.events(input).catch(() => ({ events: [] })),
    matOSWorkflowService.artifacts(input).catch(() => ({ artifacts: [] })),
    matOSWorkflowService.approvalStatus(input).catch(() => ({ approvals: [], pendingApprovals: [] })),
  ])
  const safeRun = redactWorkbenchValue(result.run) as typeof result.run
  const eventList = redactWorkbenchArray((events as { events?: unknown }).events)
  const artifactList = redactWorkbenchArray((artifacts as { artifacts?: unknown }).artifacts)
  const safeApprovals = redactWorkbenchValue(approvals)
  return {
    run: safeRun,
    events: eventList,
    artifacts: artifactList,
    approvals: safeApprovals,
    evidence: buildMatOSWorkbenchWorkflowEvidence({
      run: safeRun,
      events: eventList,
      artifacts: artifactList,
      approvals: safeApprovals,
    }),
    actions: buildMatOSWorkbenchRunActions({
      runId: safeRun.runId,
      status: safeRun.status,
      waitingNodeId: safeRun.waitingNodeId,
    }),
  }
}

export async function statusMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const result = await matOSWorkflowService.status(input)
  const safeRun = redactWorkbenchValue(result.run) as typeof result.run
  return {
    run: safeRun,
    evidence: buildMatOSWorkbenchWorkflowEvidence({
      run: safeRun,
      events: [],
      artifacts: [],
      approvals: { approvals: [], pendingApprovals: [] },
    }),
    actions: buildMatOSWorkbenchRunActions({
      runId: safeRun.runId,
      status: safeRun.status,
      waitingNodeId: safeRun.waitingNodeId,
    }),
  }
}

export async function runGraphMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const [result, events] = await Promise.all([
    matOSWorkflowService.inspect(input),
    matOSWorkflowService.events(input).catch(() => ({ events: [] })),
  ])
  const safeRun = redactWorkbenchValue(result.run) as typeof result.run
  const eventList = redactWorkbenchArray((events as { events?: unknown }).events)
  return {
    run: safeRun,
    runGraph: buildMatOSWorkbenchWorkflowRunGraph({
      run: safeRun,
      events: eventList,
    }),
    actions: buildMatOSWorkbenchRunActions({
      runId: safeRun.runId,
      status: safeRun.status,
      waitingNodeId: safeRun.waitingNodeId,
    }),
  }
}

export async function monitorMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & {
    runId: string
    limit?: number
    offset?: number
    nodeId?: string
    type?: string
    query?: string
  },
): Promise<MatOSWorkbenchWorkflowRunMonitorView> {
  const [inspect, runGraph, events, artifacts, approvals] = await Promise.all([
    inspectMatOSWorkbenchWorkflowRun(input),
    runGraphMatOSWorkbenchWorkflowRun(input),
    listMatOSWorkbenchWorkflowEvents(input),
    listMatOSWorkbenchWorkflowArtifacts(input),
    listMatOSWorkbenchWorkflowApprovals(input),
  ])
  const pendingApprovals = pendingApprovalsFrom(approvals)
  const eventPage = objectValue(events.page)
  const status =
    inspect.run && typeof inspect.run === 'object'
      ? stringField((inspect.run as Record<string, unknown>).status)
      : undefined
  return {
    mode: 'native-workflow-run-monitor',
    schemaVersion: 1,
    readonly: false,
    runId: input.runId,
    status: status ?? runGraph.runGraph.status ?? 'unknown',
    run: inspect.run,
    runGraph: runGraph.runGraph,
    events: events.events ?? [],
    artifacts: artifacts.artifacts ?? [],
    approvals,
    pendingApprovals,
    evidence: inspect.evidence,
    actions: inspect.actions,
    stream: {
      endpoint: 'workflows.monitor',
      params: { runId: input.runId },
      pollingIntervalMs: 1500,
      ...(eventPage ? { cursor: eventPage } : {}),
    },
    summary: {
      nodeCount: runGraph.runGraph.summary.nodeCount,
      completedNodeCount: runGraph.runGraph.summary.completedNodeCount,
      failedNodeCount: runGraph.runGraph.summary.failedNodeCount,
      runningNodeCount: runGraph.runGraph.summary.runningNodeCount,
      waitingNodeCount: runGraph.runGraph.summary.waitingNodeCount,
      eventCount: inspect.evidence.eventCount,
      artifactCount: inspect.evidence.artifactCount,
      approvalCount: inspect.evidence.approvalCount,
      pendingApprovalCount: inspect.evidence.pendingApprovalCount,
      source: 'native-matos-workflow-runtime',
    },
  }
}

function workflowEventMatchesFilters(
  event: unknown,
  filters: { nodeId?: string; type?: string; query?: string },
): boolean {
  if (!event || typeof event !== 'object') {
    return false
  }
  const record = event as Record<string, unknown>
  if (filters.type) {
    const eventType = typeof record.type === 'string' ? record.type : ''
    if (eventType !== filters.type && !eventType.startsWith(`${filters.type}.`)) {
      return false
    }
  }
  if (filters.nodeId) {
    const data =
      record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : {}
    const nodeId = typeof data.nodeId === 'string' ? data.nodeId : undefined
    const nodeIds = Array.isArray(data.nodeIds) ? data.nodeIds : []
    if (nodeId !== filters.nodeId && !nodeIds.includes(filters.nodeId)) {
      return false
    }
  }
  if (filters.query) {
    try {
      if (!JSON.stringify(record).toLowerCase().includes(filters.query.toLowerCase())) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

export async function listMatOSWorkbenchWorkflowEvents(
  input: MatOSWorkbenchContext & {
    runId: string
    limit?: number
    offset?: number
    nodeId?: string
    type?: string
    query?: string
  },
) {
  const events = await matOSWorkflowService.events(input)
  const allEvents = Array.isArray((events as { events?: unknown }).events)
    ? ((events as { events: unknown[] }).events)
    : []
  const filters = {
    nodeId: input.nodeId?.trim() || undefined,
    type: input.type?.trim() || undefined,
    query: input.query?.trim() || undefined,
  }
  const filtered =
    filters.nodeId || filters.type || filters.query
      ? allEvents.filter(event => workflowEventMatchesFilters(event, filters))
      : allEvents
  const offset =
    Number.isInteger(input.offset) && (input.offset as number) > 0
      ? (input.offset as number)
      : 0
  const limit =
    Number.isInteger(input.limit) && (input.limit as number) > 0
      ? (input.limit as number)
      : undefined
  const page = limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit)
  return {
    ...events,
    events: redactWorkbenchArray(page),
    page: {
      total: filtered.length,
      unfilteredTotal: allEvents.length,
      offset,
      ...(limit !== undefined ? { limit } : {}),
      hasMore: offset + page.length < filtered.length,
      ...(filters.nodeId ? { nodeId: filters.nodeId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.query ? { query: filters.query } : {}),
    },
  }
}

export async function recoverMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const result = await matOSWorkflowService.recover(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function recoverApplyMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const result = await matOSWorkflowService.recoverApply(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function recoverQueueMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { allowedWorkflowRefs?: string[] },
) {
  const result = await matOSWorkflowService.recoverQueue(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function recoverDrainMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { allowedWorkflowRefs?: string[] },
) {
  const result = await matOSWorkflowService.recoverDrain(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function reconcileMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const result = await matOSWorkflowService.reconcile(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function listMatOSWorkbenchWorkflowPatches(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const result = await matOSWorkflowService.patches(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function proposeMatOSWorkbenchWorkflowPatch(
  input: MatOSWorkbenchContext & {
    runId: string
    operations: WorkflowGraphPatchOperation[]
    reason?: string
    risk?: 'low' | 'medium' | 'high'
    sourceNodeId?: string
  },
) {
  const result = await matOSWorkflowService.patchPropose({
    ...input,
    decidedBy: 'workbench',
  })
  return redactWorkbenchValue(result) as typeof result
}

export async function inspectMatOSWorkbenchWorkflowPatch(
  input: MatOSWorkbenchContext & { runId: string; patchId: string },
) {
  const result = await matOSWorkflowService.patchInspect(input)
  return redactWorkbenchValue(result) as typeof result
}

export async function approveMatOSWorkbenchWorkflowPatch(
  input: MatOSWorkbenchContext & {
    runId: string
    patchId: string
    reason?: string
  },
) {
  const result = await matOSWorkflowService.patchApprove({
    ...input,
    decidedBy: 'workbench',
  })
  return redactWorkbenchValue(result) as typeof result
}

export async function rejectMatOSWorkbenchWorkflowPatch(
  input: MatOSWorkbenchContext & {
    runId: string
    patchId: string
    reason?: string
  },
) {
  const result = await matOSWorkflowService.patchReject({
    ...input,
    decidedBy: 'workbench',
  })
  return redactWorkbenchValue(result) as typeof result
}

export async function applyMatOSWorkbenchWorkflowPatch(
  input: MatOSWorkbenchContext & {
    runId: string
    patchId: string
    reason?: string
  },
) {
  const result = await matOSWorkflowService.patchApply({
    ...input,
    decidedBy: 'workbench',
  })
  return redactWorkbenchValue(result) as typeof result
}

export async function listMatOSWorkbenchWorkflowArtifacts(
  input: MatOSWorkbenchContext & { runId: string },
) {
  const artifacts = await matOSWorkflowService.artifacts(input)
  return {
    ...artifacts,
    artifacts: redactWorkbenchArray(
      (artifacts as { artifacts?: unknown }).artifacts,
    ),
  }
}

export async function listMatOSWorkbenchWorkflowApprovals(
  input: MatOSWorkbenchContext & { runId: string },
) {
  return redactWorkbenchValue(await matOSWorkflowService.approvalStatus(input))
}

async function buildBuilderSessionView(input: {
  cwd: string
  scopeRef?: string
  sessionId: string
  goal: string
  workflowRef?: string
  draftId?: string
  messages: MatOSWorkbenchWorkflowBuilderSessionView['messages']
  events?: MatOSWorkbenchWorkflowBuilderSessionView['events']
  status?: MatOSWorkbenchWorkflowBuilderSessionView['status']
  createdAt: string
  updatedAt?: string
  lastDraft?: unknown
  lastValidation?: unknown
  lastCompile?: unknown
  lastRepair?: unknown
  lastAssistant?: unknown
  lastPublish?: unknown
}): Promise<MatOSWorkbenchWorkflowBuilderSessionView> {
  const updatedAt = input.updatedAt ?? nowIso()
  const workflow = input.workflowRef
    ? await showMatOSWorkbenchWorkflow({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        ref: input.workflowRef,
      }).catch(() => undefined)
    : undefined
  const draft =
    input.lastDraft ??
    (input.draftId
      ? await matOSWorkflowService
          .showDraft({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            draftId: input.draftId,
          })
          .catch(() => undefined)
      : undefined)
  const events = input.events ?? []
  const hasDraft = Boolean(input.draftId || draft)
  const planSteps: NonNullable<MatOSWorkbenchWorkflowBuilderSessionView['plan']>['steps'] = [
    {
      id: 'collect_goal',
      title: 'Collect workflow goal',
      status: input.goal.trim() ? 'done' : 'active',
      description: 'Capture the scientific goal and reusable workflow boundary.',
    },
    {
      id: 'create_or_fork_draft',
      title: 'Create or fork native draft',
      status: hasDraft ? 'done' : 'active',
      description: 'Use MatOS workflow draft storage instead of a browser-side workflow runtime.',
    },
    {
      id: 'apply_graph',
      title: 'Apply graph definition',
      status: draft ? 'done' : hasDraft ? 'active' : 'pending',
      description: 'Persist nodes, edges, IO contracts, policy, and canvas layout to the native definition.',
    },
    {
      id: 'validate_compile',
      title: 'Validate and compile',
      status:
        input.lastValidation || input.lastCompile
          ? 'done'
          : hasDraft
            ? 'active'
            : 'pending',
      description: 'Run native validation and compile checks before publication or execution.',
    },
    {
      id: 'publish_attach',
      title: 'Publish and attach',
      status: input.lastPublish ? 'done' : hasDraft ? 'pending' : 'pending',
      description: 'Publish through MatOS asset governance, then attach the workflow to roles when needed.',
    },
  ]
  const status = input.status ?? 'planning'
  const phase = builderSessionPhaseFrom({
    goal: input.goal,
    status,
    draftId: input.draftId,
    workflowRef: input.workflowRef,
    events,
    lastDraft: draft,
    lastValidation: input.lastValidation,
    lastCompile: input.lastCompile,
    lastPublish: input.lastPublish,
  })
  const patchPreview = builderPatchPreviewFrom(draft)
  const publishSummary = builderPublishSummaryFrom({
    lastPublish: input.lastPublish,
    workflowRef: input.workflowRef,
    draftId: input.draftId,
  })
  const publishReadiness = builderPublishReadinessFrom({
    draft,
    draftId: input.draftId,
    scopeRef: input.scopeRef,
    lastValidation: input.lastValidation,
    lastCompile: input.lastCompile,
    lastPublish: input.lastPublish,
  })
  const attachSuggestion = builderAttachSuggestionFrom({
    workflowRef: input.workflowRef,
    lastPublish: input.lastPublish,
  })
  return {
    mode: 'native-workflow-builder-session',
    schemaVersion: 1,
    sessionId: input.sessionId,
    goal: input.goal,
    ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    status,
    createdAt: input.createdAt,
    updatedAt,
    messages: input.messages,
    ...(events.length ? { events } : {}),
    phase,
    ...(patchPreview ? { patchPreview } : {}),
    ...(publishSummary ? { publishSummary } : {}),
    ...(publishReadiness ? { publishReadiness } : {}),
    ...(attachSuggestion ? { attachSuggestion } : {}),
    plan: {
      source: 'native-matos-workflow-builder',
      steps: planSteps,
    },
    ...(workflow ? { workflow } : {}),
    ...(draft ? { lastDraft: draft } : {}),
    ...(input.lastValidation ? { lastValidation: input.lastValidation } : {}),
    ...(input.lastCompile ? { lastCompile: input.lastCompile } : {}),
    ...(input.lastRepair ? { lastRepair: input.lastRepair } : {}),
    ...(input.lastAssistant ? { lastAssistant: input.lastAssistant } : {}),
    ...(input.lastPublish ? { lastPublish: input.lastPublish } : {}),
    assistant: {
      enabled: true,
      source: 'native-matos-workflow-builder',
      prompt:
        'Use the native workflow draft, validate, compile, and publish actions. Ask for missing scientific inputs instead of making users write raw JSON. Do not run a browser-side workflow engine.',
    },
    actions: {
      send: {
        endpoint: 'workflows.builderSession',
        params: { action: 'send', sessionId: input.sessionId },
        enabled: true,
      },
      createDraft: {
        endpoint: 'workflows.builderSession',
        params: { action: 'create_draft', sessionId: input.sessionId },
        enabled: true,
      },
      forkWorkflow: {
        endpoint: 'workflows.builderSession',
        params: { action: 'fork_workflow', sessionId: input.sessionId },
        enabled: true,
      },
      replaceDefinition: {
        endpoint: 'workflows.builderSession',
        params: { action: 'replace_definition', sessionId: input.sessionId },
        enabled: hasDraft,
      },
      previewDraft: {
        endpoint: 'workflows.draft',
        params: input.draftId
          ? { draftId: input.draftId }
          : input.workflowRef
            ? { workflowRef: input.workflowRef }
            : {},
        enabled: true,
      },
      validate: {
        endpoint: 'workflows.validate',
        params: input.draftId
          ? { draftId: input.draftId }
          : input.workflowRef
            ? { workflowRef: input.workflowRef }
            : {},
        enabled: hasDraft || Boolean(input.workflowRef),
      },
      compile: {
        endpoint: 'workflows.compile',
        params: input.draftId
          ? { draftId: input.draftId }
          : input.workflowRef
            ? { workflowRef: input.workflowRef }
            : {},
        enabled: hasDraft || Boolean(input.workflowRef),
      },
      repair: {
        endpoint: 'workflows.builderSession',
        params: { action: 'repair_draft', sessionId: input.sessionId },
        enabled: hasDraft,
      },
      publish: {
        endpoint: 'workflows.builderSession',
        params: { action: 'publish_draft', sessionId: input.sessionId },
        enabled: hasDraft,
      },
    },
  }
}

async function persistBuilderSession(
  cwd: string,
  view: MatOSWorkbenchWorkflowBuilderSessionView,
): Promise<void> {
  await writeWorkbenchState(cwd, 'workflow-builder-sessions', view.sessionId, view)
}

export async function startMatOSWorkbenchWorkflowBuilderSession(
  input: MatOSWorkbenchContext & {
    goal?: string
    ref?: string
    message?: string
  },
): Promise<MatOSWorkbenchWorkflowBuilderSessionView> {
  const sessionId = `workflow-builder-${randomUUID()}`
  const createdAt = nowIso()
  const goal = input.goal?.trim() || input.message?.trim() || 'Build a MatOS workflow.'
  const messages: MatOSWorkbenchWorkflowBuilderSessionView['messages'] = [
    { at: createdAt, role: 'user', content: goal },
  ]
  const view = await buildBuilderSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId,
    goal,
    workflowRef: input.ref,
    messages,
    events: [
      {
        at: createdAt,
        type: 'plan',
        status: 'completed',
        summary: 'Workflow builder session created on the native MatOS workbench path.',
        ...(input.ref ? { workflowRef: input.ref } : {}),
      },
    ],
    createdAt,
  })
  await persistBuilderSession(input.cwd, view)
  return view
}

export async function showMatOSWorkbenchWorkflowBuilderSession(
  input: MatOSWorkbenchContext & { sessionId: string },
): Promise<MatOSWorkbenchWorkflowBuilderSessionView> {
  const stored = await readWorkbenchState<MatOSWorkbenchWorkflowBuilderSessionView>(
    input.cwd,
    'workflow-builder-sessions',
    input.sessionId,
  )
  return buildBuilderSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId: stored.sessionId,
    goal: stored.goal,
    workflowRef: stored.workflowRef,
    draftId: stored.draftId,
    messages: stored.messages,
    events: stored.events,
    status: stored.status,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    lastDraft: stored.lastDraft,
    lastValidation: stored.lastValidation,
    lastCompile: stored.lastCompile,
    lastRepair: stored.lastRepair,
    lastAssistant: stored.lastAssistant,
    lastPublish: stored.lastPublish,
  })
}

type WorkflowBuilderSessionRequest = {
  action?: string
  draftId?: string
  ref?: string
  id?: string
  name?: string
  version?: string
  description?: string
  definition?: MatOSWorkflowDefinition
}

function builderSessionRequest(value: unknown): WorkflowBuilderSessionRequest {
  const request = objectValue(value) ?? {}
  return {
    action:
      typeof request.action === 'string' && request.action.trim()
        ? request.action.trim().replaceAll('-', '_')
        : undefined,
    draftId:
      typeof request.draftId === 'string' && request.draftId.trim()
        ? request.draftId.trim()
        : undefined,
    ref:
      typeof request.ref === 'string' && request.ref.trim()
        ? request.ref.trim()
        : undefined,
    id:
      typeof request.id === 'string' && request.id.trim()
        ? request.id.trim()
        : undefined,
    name:
      typeof request.name === 'string' && request.name.trim()
        ? request.name.trim()
        : undefined,
    version:
      typeof request.version === 'string' && request.version.trim()
        ? request.version.trim()
        : undefined,
    description:
      typeof request.description === 'string' && request.description.trim()
        ? request.description.trim()
        : undefined,
    definition: isWorkflowDefinition(request.definition)
      ? request.definition
      : undefined,
  }
}

type WorkflowBuilderRepairStep = {
  kind: 'applied' | 'blocked'
  path?: string
  summary: string
  errorCode?: string
}

type WorkflowBuilderRepairResult = {
  mode: 'native-workflow-builder-repair'
  source: 'deterministic-structure-repair'
  ok: boolean
  changed: boolean
  appliedSteps: WorkflowBuilderRepairStep[]
  blockedIssues: WorkflowBuilderRepairStep[]
  before: MatOSWorkflowValidationResult
  after?: MatOSWorkflowValidationResult
  draftId: string
}

type WorkflowBuilderAssistantHandoff = {
  mode: 'native-workflow-builder-assistant-handoff'
  source: 'role:workflow-ui-builder'
  ok: boolean
  roleRef: 'role:workflow-ui-builder'
  chatSessionId: string
  conversationId: string
  promptLength: number
  frameCount: number
  eventCount: number
  ack?: unknown
  done?: unknown
  events: Array<Record<string, unknown>>
  refreshedDraft?: boolean
  validationOk?: boolean
  refreshError?: string
  error?: string
}

type WorkflowBuilderSessionEvent = NonNullable<
  MatOSWorkbenchWorkflowBuilderSessionView['events']
>[number]
type WorkflowBuilderSessionPhase = NonNullable<
  MatOSWorkbenchWorkflowBuilderSessionView['phase']
>
type WorkflowBuilderSessionPatchPreview = NonNullable<
  MatOSWorkbenchWorkflowBuilderSessionView['patchPreview']
>
type WorkflowBuilderSessionPublishSummary = NonNullable<
  MatOSWorkbenchWorkflowBuilderSessionView['publishSummary']
>
type WorkflowBuilderSessionPublishReadiness = NonNullable<
  MatOSWorkbenchWorkflowBuilderSessionView['publishReadiness']
>
type WorkflowBuilderSessionAttachSuggestion = NonNullable<
  MatOSWorkbenchWorkflowBuilderSessionView['attachSuggestion']
>

function cloneWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as MatOSWorkflowDefinition
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function repairRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function repairCandidateDefinition(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowDefinition {
  const raw = cloneWorkflowDefinition(definition) as MatOSWorkflowDefinition & Record<string, unknown>
  return {
    ...raw,
    schemaVersion: 1,
    name: typeof raw.name === 'string' ? raw.name : '',
    parameters: repairRecord(raw.parameters)
      ? raw.parameters as MatOSWorkflowDefinition['parameters']
      : {},
    policy: repairRecord(raw.policy)
      ? raw.policy as MatOSWorkflowDefinition['policy']
      : { approvalMode: 'ask', defaultRisk: 'medium' },
    nodes: Array.isArray(raw.nodes)
      ? raw.nodes
          .filter((node): node is MatOSWorkflowNode => repairRecord(node))
          .map(node => ({ ...node, dependsOn: stringArray(node.dependsOn) }))
      : [],
    edges: Array.isArray(raw.edges)
      ? raw.edges.filter(repairRecord) as MatOSWorkflowDefinition['edges']
      : [],
    outputs: repairRecord(raw.outputs)
      ? raw.outputs as MatOSWorkflowDefinition['outputs']
      : {},
  }
}

function validateWorkflowDefinitionForRepair(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowValidationResult {
  try {
    return validateWorkflowDefinition(repairCandidateDefinition(definition))
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: 'invalid_node_config',
        path: 'definition',
        message: error instanceof Error ? error.message : String(error),
      }],
    }
  }
}

function workflowNodeById(
  definition: MatOSWorkflowDefinition,
  nodeId?: string,
): MatOSWorkflowNode | undefined {
  return nodeId
    ? definition.nodes.find(node => node.id === nodeId)
    : undefined
}

function repairStep(input: {
  kind: WorkflowBuilderRepairStep['kind']
  summary: string
  path?: string
  error?: MatOSWorkflowValidationError
}): WorkflowBuilderRepairStep {
  return {
    kind: input.kind,
    summary: input.summary,
    ...(input.path ? { path: input.path } : {}),
    ...(input.error?.code ? { errorCode: input.error.code } : {}),
  }
}

function applySafeNodeRepair(input: {
  definition: MatOSWorkflowDefinition
  error: MatOSWorkflowValidationError
  applied: WorkflowBuilderRepairStep[]
  blocked: WorkflowBuilderRepairStep[]
}): void {
  const node = workflowNodeById(input.definition, input.error.nodeId)
  if (!node) {
    input.blocked.push(repairStep({
      kind: 'blocked',
      error: input.error,
      path: input.error.path,
      summary: `Cannot repair validation issue without a resolved node: ${input.error.message}`,
    }))
    return
  }

  node.dependsOn = stringArray(node.dependsOn)

  const path = input.error.path ?? ''
  const applied = (summary: string, repairPath = path) =>
    input.applied.push(repairStep({
      kind: 'applied',
      error: input.error,
      path: repairPath,
      summary,
    }))
  const blocked = (summary: string, repairPath = path) =>
    input.blocked.push(repairStep({
      kind: 'blocked',
      error: input.error,
      path: repairPath,
      summary,
    }))

  if (input.error.code === 'missing_node_dependency') {
    const existing = new Set(input.definition.nodes.map(item => item.id))
    const before = node.dependsOn.length
    node.dependsOn = node.dependsOn.filter(dep => existing.has(dep))
    if (node.dependsOn.length !== before) {
      applied(`Removed missing dependencies from node ${node.id}.`, `nodes.${node.id}.dependsOn`)
    } else {
      blocked(`Missing dependency could not be identified for node ${node.id}.`)
    }
    return
  }

  if (input.error.code === 'invalid_output_schema' && path.endsWith('.outputSchema')) {
    delete node.outputSchema
    applied(`Removed unsupported outputSchema from non-agent node ${node.id}.`, path)
    return
  }

  if (input.error.code !== 'missing_field' && input.error.code !== 'invalid_node_config') {
    blocked(`Validation issue requires semantic workflow design: ${input.error.message}`)
    return
  }

  switch (node.type) {
    case 'agent':
      if (path.endsWith('.role') || /requires role/i.test(input.error.message)) {
        blocked(`Agent node ${node.id} needs an explicit role choice; not guessing a role.`)
        return
      }
      if (path.endsWith('.prompt') || /requires prompt/i.test(input.error.message)) {
        node.prompt = `Complete the "${node.id}" workflow step. Return concise structured evidence and do not perform external side effects unless the workflow policy allows them.`
        applied(`Added a safe prompt placeholder to agent node ${node.id}.`, `nodes.${node.id}.prompt`)
        return
      }
      break
    case 'exec':
      if (path.endsWith('.command') || /requires command/i.test(input.error.message)) {
        node.command = `printf "matos workflow repair placeholder for ${node.id}\\n"`
        applied(`Added a no-side-effect placeholder command to exec node ${node.id}.`, `nodes.${node.id}.command`)
        return
      }
      if (path.endsWith('.args') || /args must be an array/i.test(input.error.message)) {
        node.args = stringArray(node.args)
        applied(`Normalized exec node ${node.id} args to a string array.`, `nodes.${node.id}.args`)
        return
      }
      break
    case 'guard':
      if (path.includes('.checks') || /requires checks/i.test(input.error.message)) {
        node.checks = [{ type: 'expression', value: 'true' }]
        applied(`Added an explicit pass-through guard check to node ${node.id}.`, `nodes.${node.id}.checks`)
        return
      }
      break
    case 'human':
      if (path.endsWith('.responseSchema')) {
        delete node.responseSchema
        applied(`Removed invalid responseSchema from human node ${node.id}.`, path)
        return
      }
      break
    case 'backend':
      if (path.endsWith('.backend') || /requires backend/i.test(input.error.message)) {
        blocked(`Backend/compute node ${node.id} needs an explicit backend and operation; not guessing external side effects.`)
        return
      }
      break
    case 'subworkflow':
      if (path.endsWith('.workflow') || /requires workflow/i.test(input.error.message)) {
        blocked(`Subworkflow node ${node.id} needs an explicit workflow ref; not guessing a child workflow.`)
        return
      }
      break
    case 'map':
      if (path.endsWith('.items') || /requires items/i.test(input.error.message)) {
        node.items = '{{ parameters.items }}'
        applied(`Bound map node ${node.id} items to parameters.items.`, `nodes.${node.id}.items`)
        return
      }
      if (path.endsWith('.workflow') || /requires workflow/i.test(input.error.message)) {
        blocked(`Map node ${node.id} needs an explicit child workflow ref; not guessing it.`)
        return
      }
      if (path.endsWith('.maxParallel')) {
        node.maxParallel = 1
        applied(`Clamped map node ${node.id} maxParallel to 1.`, path)
        return
      }
      if (path.endsWith('.maxItems')) {
        node.maxItems = 1
        applied(`Clamped map node ${node.id} maxItems to 1.`, path)
        return
      }
      break
    case 'loop':
      if (path.endsWith('.maxIterations') || /requires maxIterations/i.test(input.error.message)) {
        node.maxIterations = 1
        applied(`Set loop node ${node.id} maxIterations to 1.`, `nodes.${node.id}.maxIterations`)
        return
      }
      if (path.endsWith('.workflow') || /requires workflow/i.test(input.error.message)) {
        blocked(`Loop node ${node.id} needs an explicit child workflow ref; not guessing it.`)
        return
      }
      break
    case 'dynamic':
      if (path.endsWith('.candidate') || /requires candidate/i.test(input.error.message)) {
        node.candidate = { operations: [] }
        applied(`Added an empty graph-patch candidate to dynamic node ${node.id}.`, `nodes.${node.id}.candidate`)
        return
      }
      break
    default:
      break
  }

  blocked(`Validation issue requires workflow-builder reasoning: ${input.error.message}`)
}

function repairWorkflowDefinition(input: {
  draftId: string
  definition: MatOSWorkflowDefinition
}): {
  definition: MatOSWorkflowDefinition
  appliedSteps: WorkflowBuilderRepairStep[]
  blockedIssues: WorkflowBuilderRepairStep[]
} {
  const rawDefinition = cloneWorkflowDefinition(input.definition) as Record<string, unknown>
  const definition = repairCandidateDefinition(input.definition)
  const appliedSteps: WorkflowBuilderRepairStep[] = []
  const blockedIssues: WorkflowBuilderRepairStep[] = []

  if (typeof rawDefinition.name !== 'string' || !rawDefinition.name.trim()) {
    definition.name = `Repaired workflow ${input.draftId}`
    appliedSteps.push(repairStep({
      kind: 'applied',
      path: 'name',
      summary: 'Added a workflow name so native validation can proceed.',
    }))
  }
  if (!repairRecord(rawDefinition.parameters)) {
    appliedSteps.push(repairStep({
      kind: 'applied',
      path: 'parameters',
      summary: 'Normalized missing workflow parameters to an empty object.',
    }))
  }
  if (!repairRecord(rawDefinition.policy)) {
    appliedSteps.push(repairStep({
      kind: 'applied',
      path: 'policy',
      summary: 'Added conservative workflow policy defaults.',
    }))
  }
  if (!repairRecord(rawDefinition.outputs)) {
    appliedSteps.push(repairStep({
      kind: 'applied',
      path: 'outputs',
      summary: 'Normalized missing workflow outputs to an empty object.',
    }))
  }

  const seenIds = new Set<string>()
  const renamed = new Map<string, string>()
  definition.nodes = (Array.isArray(definition.nodes) ? definition.nodes : [])
    .filter((node): node is MatOSWorkflowNode =>
      Boolean(node && typeof node === 'object'),
    )
    .map((node, index) => {
      const next = { ...node }
      const baseId =
        typeof next.id === 'string' && next.id.trim()
          ? next.id.trim()
          : `repair_node_${index + 1}`
      const duplicateId = seenIds.has(baseId)
      let id = baseId
      let suffix = 2
      while (seenIds.has(id)) {
        id = `${baseId}_${suffix}`
        suffix += 1
      }
      if (id !== node.id) {
        if (typeof node.id === 'string' && !duplicateId) {
          renamed.set(node.id, id)
        }
        appliedSteps.push(repairStep({
          kind: 'applied',
          path: `nodes[${index}].id`,
          summary: `Normalized workflow node id to ${id}.`,
        }))
      }
      seenIds.add(id)
      next.id = id
      return next
    })

  if (renamed.size > 0) {
    for (const node of definition.nodes) {
      node.dependsOn = node.dependsOn.map(dep => renamed.get(dep) ?? dep)
    }
    definition.edges = (definition.edges ?? []).map(edge => ({
      ...edge,
      from: renamed.get(edge.from) ?? edge.from,
      to: renamed.get(edge.to) ?? edge.to,
    }))
  }

  const nodeIds = new Set(definition.nodes.map(node => node.id))
  const beforeEdgeCount = definition.edges?.length ?? 0
  definition.edges = (definition.edges ?? []).filter(edge =>
    nodeIds.has(edge.from) && nodeIds.has(edge.to),
  )
  if (beforeEdgeCount !== definition.edges.length) {
    appliedSteps.push(repairStep({
      kind: 'applied',
      path: 'edges',
      summary: 'Removed edges that referenced missing workflow nodes.',
    }))
  }

  const maxRepairPasses = Math.max(
    2,
    Math.min(16, definition.nodes.length + 2),
  )
  for (let pass = 0; pass < maxRepairPasses; pass += 1) {
    const validation = validateWorkflowDefinitionForRepair(definition)
    if (validation.ok) {
      break
    }

    const passApplied: WorkflowBuilderRepairStep[] = []
    const passBlocked: WorkflowBuilderRepairStep[] = []
    for (const error of validation.errors) {
      applySafeNodeRepair({
        definition,
        error,
        applied: passApplied,
        blocked: passBlocked,
      })
    }

    if (passApplied.length > 0) {
      appliedSteps.push(...passApplied)
      continue
    }

    blockedIssues.push(...passBlocked)
    break
  }

  const finalValidation = validateWorkflowDefinitionForRepair(definition)
  if (!finalValidation.ok && blockedIssues.length === 0) {
    blockedIssues.push(
      ...finalValidation.errors.map(error =>
        repairStep({
          kind: 'blocked',
          error,
          path: error.path,
          summary: `Validation issue remains after bounded deterministic repair: ${error.message}`,
        }),
      ),
    )
  }

  return { definition, appliedSteps, blockedIssues }
}

function workflowBuilderSystemEvent(input: {
  at: string
  type: NonNullable<MatOSWorkbenchWorkflowBuilderSessionView['events']>[number]['type']
  status: NonNullable<MatOSWorkbenchWorkflowBuilderSessionView['events']>[number]['status']
  summary: string
  draftId?: string
  workflowRef?: string
  validationOk?: boolean
}): NonNullable<MatOSWorkbenchWorkflowBuilderSessionView['events']>[number] {
  return input
}

function booleanRecordField(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  return typeof value?.[key] === 'boolean' ? (value[key] as boolean) : undefined
}

function numberRecordField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  return typeof value?.[key] === 'number' && Number.isFinite(value[key])
    ? (value[key] as number)
    : undefined
}

function builderValidationOk(value: unknown): boolean | undefined {
  const record = objectValue(value)
  if (!record) {
    return undefined
  }
  const validation = objectValue(record.validation) ?? record
  return booleanRecordField(validation, 'ok')
}

function builderCompileOk(value: unknown): boolean | undefined {
  const record = objectValue(value)
  if (!record) {
    return undefined
  }
  const compile = objectValue(record.compile) ?? record
  return booleanRecordField(compile, 'ok')
}

function builderPatchPreviewFrom(
  value: unknown,
): WorkflowBuilderSessionPatchPreview | undefined {
  const record = objectValue(value)
  const diff = objectValue(record?.diff)
  if (!record || !diff) {
    return undefined
  }
  const items = asArray(diff.items)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    )
    .slice(0, 18)
    .map(item => ({
      path: String(item.path || ''),
      label: String(item.label || item.path || 'workflow change'),
      kind: String(item.kind || 'change'),
      changed: item.changed !== false,
    }))
  const summary = objectValue(diff.summary)
  const issueCount =
    numberRecordField(summary, 'issueCount') ?? asArray(record.issues).length
  if (!items.length && issueCount === 0) {
    return undefined
  }
  const itemCount = numberRecordField(summary, 'itemCount') ?? items.length
  const changedCount = items.filter(item => item.changed).length
  return {
    source: 'native-workflow-draft-diff',
    itemCount,
    changedCount,
    issueCount,
    ...(builderValidationOk(record) !== undefined
      ? { validationOk: builderValidationOk(record) }
      : {}),
    ...(builderCompileOk(record) !== undefined
      ? { compileOk: builderCompileOk(record) }
      : {}),
    items,
  }
}

function sanitizeWorkflowPreviewId(value: string | undefined): string {
  const normalized = String(value || 'workflow')
    .trim()
    .replace(/^workflow:/, '')
    .replace(/@.+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'workflow'
}

function scopedWorkflowPublishScope(
  scopeRef: string | undefined,
): WorkflowBuilderSessionPublishReadiness['scope'] {
  const normalized = scopeRef?.trim()
  if (!normalized) {
    return 'local'
  }
  if (normalized.startsWith('user:')) {
    return 'user'
  }
  if (normalized.startsWith('team:')) {
    return 'team'
  }
  if (normalized.startsWith('project:')) {
    return 'project'
  }
  return 'local'
}

function builderPublishReadinessFrom(input: {
  draft?: unknown
  draftId?: string
  scopeRef?: string
  lastValidation?: unknown
  lastCompile?: unknown
  lastPublish?: unknown
}): WorkflowBuilderSessionPublishReadiness | undefined {
  if (!input.draftId || objectValue(input.lastPublish)) {
    return undefined
  }
  const draft = objectValue(input.draft)
  const definition = objectValue(draft?.definition)
  const validationOk =
    builderValidationOk(input.lastValidation) ?? builderValidationOk(draft)
  const compileOk = builderCompileOk(input.lastCompile)
  const targetId = sanitizeWorkflowPreviewId(input.draftId)
  const targetVersion = stringField(definition?.version) ?? '0.1.0'
  const targetAssetKey = `workflow:${targetId}@${targetVersion}`
  const scope = scopedWorkflowPublishScope(input.scopeRef)
  const usesScopedGitea = scope === 'user' || scope === 'team' || scope === 'project'
  const canPublish = validationOk !== false && (compileOk === true || validationOk === true)
  return {
    source: 'native-workflow-publish-readiness',
    draftId: input.draftId,
    targetAssetKey,
    targetId,
    targetVersion,
    scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    governance: usesScopedGitea
      ? 'scoped-gitea-accepted-ref'
      : 'local-asset-governance',
    usesScopedGitea,
    ...(validationOk !== undefined ? { validationOk } : {}),
    ...(compileOk !== undefined ? { compileOk } : {}),
    canPublish,
    reason: canPublish
      ? usesScopedGitea
        ? 'Publishing will create a native workflow asset and sync it to the scoped Gitea accepted-ref governance path.'
        : 'Publishing will create a native workflow asset under local MatOS asset governance.'
      : 'Native validation and compile evidence are required before publishing.',
  }
}

function builderPublishSummaryFrom(input: {
  lastPublish?: unknown
  workflowRef?: string
  draftId?: string
}): WorkflowBuilderSessionPublishSummary | undefined {
  const publish = objectValue(input.lastPublish)
  if (!publish && !input.workflowRef) {
    return undefined
  }
  const published = objectValue(publish?.published)
  const scoped = objectValue(publish?.scopedGiteaSync)
  const gitea = objectValue(scoped?.gitea)
  const sourceAcceptance = asArray(gitea?.sourceAcceptance)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    )
    .at(0)
  const sourceCommit = asArray(gitea?.sourceCommits)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    )
    .at(0)
  const scopedGitea =
    scoped || gitea || sourceAcceptance || sourceCommit
      ? {
          ...(booleanRecordField(scoped, 'ok') !== undefined
            ? { ok: booleanRecordField(scoped, 'ok') }
            : {}),
          ...(stringField(gitea?.targetSourceId) ? { sourceId: String(gitea?.targetSourceId) } : {}),
          ...(stringField(sourceCommit?.branch) ? { branch: String(sourceCommit?.branch) } : {}),
          ...(stringField(sourceAcceptance?.acceptedRef)
            ? { acceptedRef: String(sourceAcceptance?.acceptedRef) }
            : stringField(sourceAcceptance?.ref)
              ? { acceptedRef: String(sourceAcceptance?.ref) }
              : {}),
          ...(stringField(sourceAcceptance?.commit)
            ? { commit: String(sourceAcceptance?.commit) }
            : stringField(sourceCommit?.commit)
              ? { commit: String(sourceCommit?.commit) }
              : {}),
          ...(stringField(scoped?.action)
            ? { status: String(scoped?.action) }
            : stringField(gitea?.status)
              ? { status: String(gitea?.status) }
              : {}),
          ...(booleanRecordField(scoped, 'activationRequired') !== undefined
            ? {
                activationRequired: booleanRecordField(
                  scoped,
                  'activationRequired',
                ),
              }
            : {}),
          ...(stringField(objectValue(scoped?.nextAction)?.activateCli)
            ? {
                activateCli: String(
                  objectValue(scoped?.nextAction)?.activateCli,
                ),
              }
            : {}),
        }
      : undefined
  return {
    source: 'native-workflow-publish',
    ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
    ...(input.draftId ? { draftId: input.draftId } : {}),
    ...(stringField(published?.assetKey)
      ? { assetKey: String(published?.assetKey) }
      : input.workflowRef
        ? { assetKey: input.workflowRef }
        : {}),
    ...(scopedGitea ? { scopedGitea } : {}),
  }
}

function builderAttachSuggestionFrom(input: {
  workflowRef?: string
  lastPublish?: unknown
}): WorkflowBuilderSessionAttachSuggestion | undefined {
  if (!input.workflowRef && !objectValue(input.lastPublish)) {
    return undefined
  }
  return {
    source: 'native-workflow-role-mount',
    ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
    // Unversioned refs resolve deterministically to the newest role version.
    // Pinned versions here went stale whenever developer edits or accepted
    // self-evolution bumped the bundled role, breaking attachment suggestions.
    recommendedRoleRefs: [
      'role:compute',
      'role:workflow-builder',
    ],
    reason:
      'Published workflows become reusable MatOS assets when mounted through the native role draft attachment path.',
    action: {
      endpoint: 'workflows.attachRole',
      enabled: Boolean(input.workflowRef),
    },
  }
}

function builderNextActions(input: {
  draftId?: string
  workflowRef?: string
  validationOk?: boolean
  publishReady?: boolean
}): WorkflowBuilderSessionPhase['nextActions'] {
  const actions: WorkflowBuilderSessionPhase['nextActions'] = []
  if (!input.draftId) {
    actions.push({
      key: 'create_draft',
      label: 'Create draft',
      enabled: true,
      endpoint: 'workflows.builderSession',
      reason: 'No native workflow draft exists yet.',
    })
    if (input.workflowRef) {
      actions.push({
        key: 'fork_workflow',
        label: 'Fork current workflow',
        enabled: true,
        endpoint: 'workflows.builderSession',
      })
    }
    return actions
  }
  actions.push({
    key: 'validate_draft',
    label: 'Validate',
    enabled: true,
    endpoint: 'workflows.builderSession',
  })
  actions.push({
    key: 'repair_draft',
    label: 'Repair safe issues',
    enabled: input.validationOk === false,
    endpoint: 'workflows.builderSession',
    reason: input.validationOk === false
      ? 'Native validation found issues.'
      : 'Only needed when validation fails.',
  })
  actions.push({
    key: 'compile_draft',
    label: 'Compile',
    enabled: input.validationOk !== false,
    endpoint: 'workflows.builderSession',
  })
  actions.push({
    key: 'publish_draft',
    label: 'Publish',
    enabled: Boolean(input.publishReady),
    endpoint: 'workflows.builderSession',
    reason: input.publishReady
      ? 'Draft has passed native checks.'
      : 'Publish is enabled after validation/compile.',
  })
  if (input.workflowRef) {
    actions.push({
      key: 'attach_role',
      label: 'Attach to role',
      enabled: true,
      endpoint: 'workflows.attachRole',
    })
  }
  return actions
}

function builderSessionPhaseFrom(input: {
  goal: string
  status: MatOSWorkbenchWorkflowBuilderSessionView['status']
  draftId?: string
  workflowRef?: string
  events: WorkflowBuilderSessionEvent[]
  lastDraft?: unknown
  lastValidation?: unknown
  lastCompile?: unknown
  lastPublish?: unknown
}): WorkflowBuilderSessionPhase {
  const latest = input.events.at(-1)
  const validationOk =
    builderValidationOk(input.lastValidation) ??
    builderValidationOk(input.lastDraft)
  const compileOk = builderCompileOk(input.lastCompile)
  const publishReady = validationOk !== false && (compileOk === true || Boolean(input.lastCompile))
  const base = {
    source: 'native-matos-workflow-builder' as const,
    ...(latest?.type ? { activeEventType: latest.type } : {}),
    nextActions: builderNextActions({
      draftId: input.draftId,
      workflowRef: input.workflowRef,
      validationOk,
      publishReady,
    }),
  }
  if (input.status === 'failed') {
    return {
      ...base,
      state: 'failed',
      title: 'Builder action failed',
      summary: latest?.summary ?? 'The native workflow builder action failed.',
      nativeAction: latest?.type,
    }
  }
  if (input.lastPublish && input.workflowRef) {
    return {
      ...base,
      state: 'attach_suggested',
      title: 'Attach workflow to an agent',
      summary:
        `Workflow ${input.workflowRef} is published. Attach it to a role so agents can discover and call it as a reusable workflow asset.`,
      nativeAction: 'workflows.attachRole',
    }
  }
  if (input.status === 'published') {
    return {
      ...base,
      state: 'published',
      title: 'Workflow published',
      summary: input.workflowRef
        ? `Workflow is now available as ${input.workflowRef}.`
        : 'Workflow draft has been published.',
      nativeAction: 'workflows.builderSession.publish_draft',
    }
  }
  if (input.status === 'validating' || input.status === 'repairing') {
    return {
      ...base,
      state: 'validating',
      title: validationOk === false ? 'Validation needs repair' : 'Validating draft',
      summary: validationOk === false
        ? 'Native validation found workflow issues. Use deterministic repair for structural problems, then ask the workflow-builder role for semantic fixes.'
        : 'Native validation and compile checks are running through MatOS workflow services.',
      nativeAction: validationOk === false
        ? 'workflows.builderSession.repair_draft'
        : 'workflows.builderSession.validate_draft',
    }
  }
  if (input.status === 'applying') {
    return {
      ...base,
      state: 'applying_patch',
      title: 'Applying draft patch',
      summary: 'MatOS is applying workflow graph changes to the native draft store.',
      nativeAction: 'workflows.builderSession.replace_definition',
    }
  }
  if (validationOk === false && input.draftId) {
    return {
      ...base,
      state: 'validating',
      title: 'Validation needs repair',
      summary:
        'Native validation found workflow issues. Add the missing graph pieces or use deterministic repair before publishing.',
      nativeAction: 'workflows.builderSession.repair_draft',
    }
  }
  if (publishReady && input.draftId) {
    return {
      ...base,
      state: 'ready_to_publish',
      title: 'Ready to publish',
      summary: 'The draft has passed native checks and can be published as a workflow asset.',
      nativeAction: 'workflows.builderSession.publish_draft',
    }
  }
  if (input.draftId && input.lastDraft) {
    return {
      ...base,
      state: 'user_reviewing_patch',
      title: 'Review workflow draft',
      summary:
        'Review the native draft, patch summary, and validation evidence before publishing.',
      nativeAction: 'workflows.builderSession.validate_draft',
    }
  }
  if (input.draftId) {
    return {
      ...base,
      state: 'graph_proposed',
      title: 'Draft graph proposed',
      summary: 'A native workflow draft exists. Add nodes, run validation, or ask the builder role to refine it.',
      nativeAction: 'workflows.builderSession.replace_definition',
    }
  }
  return {
    ...base,
    state: input.goal.trim() ? 'intent_captured' : 'clarifying',
    title: input.goal.trim() ? 'Intent captured' : 'Clarify workflow goal',
    summary: input.goal.trim()
      ? 'MatOS captured the workflow goal. Create or fork a native draft to continue.'
      : 'Describe the workflow goal so the builder can create a native draft.',
    nativeAction: 'workflows.builderSession.create_draft',
  }
}

function workflowBuilderAssistantPrompt(input: {
  goal: string
  message: string
  sessionId: string
  workflowRef?: string
  draftId?: string
  lastValidation?: unknown
  lastRepair?: unknown
}): string {
  return [
    'You are being invoked from the MatOS native workflow builder session.',
    'Use MatOS workflow tools for graph changes. Do not edit files or invent a browser-side workflow runtime.',
    'If you change a workflow, validate the draft and return the compact delegation JSON required by your role instructions.',
    '',
    `builderSessionId: ${input.sessionId}`,
    `goal: ${input.goal}`,
    input.workflowRef ? `workflowRef: ${input.workflowRef}` : undefined,
    input.draftId ? `draftId: ${input.draftId}` : undefined,
    input.lastValidation
      ? `lastValidation: ${JSON.stringify(input.lastValidation).slice(0, 4000)}`
      : undefined,
    input.lastRepair
      ? `lastRepair: ${JSON.stringify(input.lastRepair).slice(0, 4000)}`
      : undefined,
    '',
    `userRequest: ${input.message}`,
  ].filter((line): line is string => typeof line === 'string').join('\n')
}

function assistantFrameSummary(frame: Record<string, unknown>): Record<string, unknown> {
  const type = typeof frame.type === 'string' ? frame.type : 'unknown'
  if (type === 'ack') {
    const session = objectValue(frame.session)
    const job = objectValue(frame.job)
    return {
      type,
      sessionKey: session?.sessionKey,
      chatSessionId: session?.chatSessionId,
      turnId: session?.turnId,
      upstreamSessionId: session?.upstreamSessionId,
      jobId: job?.jobId,
      status: job?.status ?? session?.status,
    }
  }
  if (type === 'event') {
    const event = objectValue(frame.event)
    return {
      type,
      sequence: frame.sequence,
      eventType: event?.type,
      eventSubtype: event?.subtype,
      eventStatus: event?.status,
    }
  }
  if (type === 'done') {
    return {
      type,
      status: frame.status,
      outputOffset: frame.outputOffset,
      eventSequence: frame.eventSequence,
      upstreamSessionId: frame.upstreamSessionId,
      error: frame.error,
    }
  }
  return { type }
}

async function runWorkflowBuilderAssistantHandoff(
  input: MatOSWorkbenchContext & {
    sessionId: string
    goal: string
    message: string
    workflowRef?: string
    draftId?: string
    lastValidation?: unknown
    lastRepair?: unknown
  },
): Promise<WorkflowBuilderAssistantHandoff> {
  const roleRef = 'role:workflow-ui-builder' as const
  const conversationId = `workflow-builder:${input.sessionId}`
  const chatSessionId = `matos-workflow-builder:${input.sessionId}`
  const prompt = workflowBuilderAssistantPrompt(input)
  const events: Array<Record<string, unknown>> = []
  let ack: unknown
  let done: unknown
  let frameCount = 0
  try {
    for await (const rawFrame of streamMatOSWorkbenchRoleChatSessionTurn({
      ...input,
      ref: roleRef,
      message: prompt,
      conversationId,
      chatSessionId,
    })) {
      const frame = rawFrame as Record<string, unknown>
      frameCount += 1
      const summary = assistantFrameSummary(frame)
      if (summary.type === 'ack') {
        ack = summary
      } else if (summary.type === 'done') {
        done = summary
      } else if (summary.type === 'event' && events.length < 20) {
        events.push(summary)
      }
    }
    const doneRecord = objectValue(done)
    const ok = !doneRecord || doneRecord.status === 'completed'
    return {
      mode: 'native-workflow-builder-assistant-handoff',
      source: roleRef,
      ok,
      roleRef,
      chatSessionId,
      conversationId,
      promptLength: prompt.length,
      frameCount,
      eventCount: events.length,
      ...(ack ? { ack } : {}),
      ...(done ? { done } : {}),
      events,
      ...(doneRecord?.error ? { error: String(doneRecord.error) } : {}),
    }
  } catch (error) {
    return {
      mode: 'native-workflow-builder-assistant-handoff',
      source: roleRef,
      ok: false,
      roleRef,
      chatSessionId,
      conversationId,
      promptLength: prompt.length,
      frameCount,
      eventCount: events.length,
      ...(ack ? { ack } : {}),
      events,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function sendMatOSWorkbenchWorkflowBuilderSession(
  input: MatOSWorkbenchContext & {
    sessionId: string
    message?: string
    request?: unknown
  },
): Promise<MatOSWorkbenchWorkflowBuilderSessionView> {
  const current = await showMatOSWorkbenchWorkflowBuilderSession(input)
  const at = nowIso()
  const message = input.message?.trim()
  const request = builderSessionRequest(input.request)
  const events: NonNullable<MatOSWorkbenchWorkflowBuilderSessionView['events']> = [
    ...(current.events ?? []),
  ]
  let workflowRef = current.workflowRef
  let draftId = request.draftId ?? current.draftId
  let lastDraft = current.lastDraft
  let lastValidation = current.lastValidation
  let lastCompile = current.lastCompile
  let lastRepair = current.lastRepair
  let lastAssistant = current.lastAssistant
  let lastPublish = current.lastPublish
  let status: MatOSWorkbenchWorkflowBuilderSessionView['status'] = current.status
  let systemMessage: string | undefined

  if (input.request) {
    const action = request.action ?? 'preview_draft'
    try {
      switch (action) {
        case 'create_draft': {
          status = 'drafting'
          const result = await matOSWorkflowService.createDraft({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            id: request.id,
            name: request.name,
            version: request.version,
            description: request.description,
          })
          draftId = result.draft.draftId
          lastDraft = result
          lastValidation = result.validation
          systemMessage = `Workflow draft created: ${draftId}.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'create_draft',
            status: 'completed',
            summary: systemMessage,
            draftId,
            validationOk: result.validation.ok,
          }))
          break
        }
        case 'fork_workflow': {
          const ref = request.ref ?? current.workflowRef
          if (!ref) {
            throw new Error('workflow builder fork_workflow requires ref')
          }
          status = 'drafting'
          const result = await matOSWorkflowService.forkWorkflow({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            ref,
            id: request.id,
            name: request.name,
            version: request.version,
            description: request.description,
          })
          draftId = result.draft.draftId
          workflowRef = ref
          lastDraft = result
          lastValidation = result.validation
          systemMessage = `Workflow draft forked from ${ref}: ${draftId}.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'fork_workflow',
            status: 'completed',
            summary: systemMessage,
            draftId,
            workflowRef: ref,
            validationOk: result.validation.ok,
          }))
          break
        }
        case 'replace_definition': {
          if (!draftId) {
            throw new Error('workflow builder replace_definition requires draftId')
          }
          if (!request.definition) {
            throw new Error('workflow builder replace_definition requires definition')
          }
          status = 'applying'
          const result = await matOSWorkflowService.replaceDraftDefinition({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            draftId,
            definition: request.definition,
          })
          lastDraft = result
          lastValidation = result.validation
          status = result.validation.ok ? 'ready' : 'repairing'
          systemMessage = result.validation.ok
            ? `Workflow draft ${draftId} updated and validated.`
            : `Workflow draft ${draftId} updated but needs repair.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'replace_definition',
            status: 'completed',
            summary: systemMessage,
            draftId,
            validationOk: result.validation.ok,
          }))
          break
        }
        case 'validate_draft': {
          if (!draftId) {
            throw new Error('workflow builder validate_draft requires draftId')
          }
          status = 'validating'
          const result = await matOSWorkflowService.showDraft({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            draftId,
          })
          lastDraft = result
          lastValidation = result.validation
          status = result.validation.ok ? 'ready' : 'repairing'
          systemMessage = result.validation.ok
            ? `Workflow draft ${draftId} validation passed.`
            : `Workflow draft ${draftId} validation failed.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'validate_draft',
            status: 'completed',
            summary: systemMessage,
            draftId,
            validationOk: result.validation.ok,
          }))
          break
        }
        case 'compile_draft': {
          if (!draftId) {
            throw new Error('workflow builder compile_draft requires draftId')
          }
          status = 'validating'
          const result = await matOSWorkflowService.compileDraft({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            draftId,
          })
          lastCompile = result
          status = 'ready'
          systemMessage = `Workflow draft ${draftId} compiled through the native runtime.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'compile_draft',
            status: 'completed',
            summary: systemMessage,
            draftId,
          }))
          break
        }
        case 'repair_draft': {
          if (!draftId) {
            throw new Error('workflow builder repair_draft requires draftId')
          }
          status = 'repairing'
          const shown = request.definition
            ? {
                definition: request.definition,
                validation: validateWorkflowDefinitionForRepair(request.definition),
              }
            : await matOSWorkflowService.showDraft({
                cwd: input.cwd,
                scopeRef: input.scopeRef,
                draftId,
              })
          const repair = repairWorkflowDefinition({
            draftId,
            definition: shown.definition,
          })
          if (repair.appliedSteps.length > 0) {
            const repairedValidation = validateWorkflowDefinitionForRepair(
              repair.definition,
            )
            if (repairedValidation.ok) {
              const result = await matOSWorkflowService.replaceDraftDefinition({
                cwd: input.cwd,
                scopeRef: input.scopeRef,
                draftId,
                definition: repair.definition,
              })
              lastDraft = result
              lastValidation = result.validation
            } else {
              lastDraft = {
                definition: repair.definition,
                validation: repairedValidation,
              }
              lastValidation = repairedValidation
            }
            lastRepair = {
              mode: 'native-workflow-builder-repair',
              source: 'deterministic-structure-repair',
              ok: repairedValidation.ok && repair.blockedIssues.length === 0,
              changed: true,
              appliedSteps: repair.appliedSteps,
              blockedIssues: repair.blockedIssues,
              before: shown.validation,
              after: repairedValidation,
              draftId,
            } satisfies WorkflowBuilderRepairResult
            status = repairedValidation.ok ? 'ready' : 'repairing'
          } else {
            lastDraft = shown
            lastValidation = shown.validation
            lastRepair = {
              mode: 'native-workflow-builder-repair',
              source: 'deterministic-structure-repair',
              ok: shown.validation.ok && repair.blockedIssues.length === 0,
              changed: false,
              appliedSteps: [],
              blockedIssues: repair.blockedIssues,
              before: shown.validation,
              after: shown.validation,
              draftId,
            } satisfies WorkflowBuilderRepairResult
            status = shown.validation.ok ? 'ready' : 'repairing'
          }
          const repairResult = lastRepair as WorkflowBuilderRepairResult
          const blockedCount = repairResult.blockedIssues.length
          const appliedCount = repairResult.appliedSteps.length
          systemMessage = blockedCount > 0
            ? `Workflow draft ${draftId} repaired ${appliedCount} structural issue(s); ${blockedCount} issue(s) need workflow-builder reasoning.`
            : appliedCount > 0
              ? `Workflow draft ${draftId} repaired ${appliedCount} structural issue(s) through native validation.`
              : `Workflow draft ${draftId} has no deterministic structural repair to apply.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'repair_draft',
            status: blockedCount > 0 ? 'failed' : 'completed',
            summary: systemMessage,
            draftId,
            validationOk: repairResult.ok,
          }))
          break
        }
        case 'publish_draft': {
          if (!draftId) {
            throw new Error('workflow builder publish_draft requires draftId')
          }
          status = 'validating'
          const id = request.id ?? draftId.replace(/^draft[-_:]?/, '')
          const result = await matOSWorkflowService.publishDraft({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            env: input.env,
            draftId,
            id,
            name: request.name,
            version: request.version,
            description: request.description,
          })
          lastPublish = result
          workflowRef = result.published.assetKey
          status = 'published'
          systemMessage = `Workflow draft ${draftId} published as ${workflowRef}.`
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'publish_draft',
            status: 'completed',
            summary: systemMessage,
            draftId,
            workflowRef,
          }))
          break
        }
        case 'preview_draft':
        default:
          lastDraft = await previewMatOSWorkbenchWorkflowDraft({
            ...input,
            ref: workflowRef,
            mutation: 'builder-session-preview',
            request: input.request,
          })
          status = 'drafting'
          systemMessage = 'Workflow draft preview refreshed through native MatOS draft parser.'
          events.push(workflowBuilderSystemEvent({
            at,
            type: 'plan',
            status: 'completed',
            summary: systemMessage,
            draftId,
            workflowRef,
          }))
          break
      }
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error)
      status = 'failed'
      systemMessage = `Workflow builder action failed: ${summary}`
      events.push(workflowBuilderSystemEvent({
        at,
        type: 'error',
        status: 'failed',
        summary: systemMessage,
        draftId,
        workflowRef,
      }))
    }
  } else if (message) {
    status = 'planning'
    events.push(workflowBuilderSystemEvent({
      at,
      type: 'assistant_handoff',
      status: 'started',
      summary: 'Handing the request to role:workflow-ui-builder through native MatOS role chat stream.',
      draftId,
      workflowRef,
    }))
    lastAssistant = await runWorkflowBuilderAssistantHandoff({
      ...input,
      sessionId: input.sessionId,
      goal: current.goal,
      message,
      workflowRef,
      draftId,
      lastValidation,
      lastRepair,
    })
    const assistant = lastAssistant as WorkflowBuilderAssistantHandoff
    if (assistant.ok) {
      status = current.status
      if (draftId) {
        try {
          const refreshed = await matOSWorkflowService.showDraft({
            cwd: input.cwd,
            scopeRef: input.scopeRef,
            draftId,
          })
          lastDraft = refreshed
          lastValidation = refreshed.validation
          status = refreshed.validation.ok ? 'ready' : 'repairing'
          Object.assign(assistant, {
            refreshedDraft: true,
            validationOk: refreshed.validation.ok,
          })
        } catch (error) {
          Object.assign(assistant, {
            refreshedDraft: false,
            refreshError: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } else {
      status = 'failed'
    }
    systemMessage = assistant.ok
      ? `Workflow builder role handoff completed through ${assistant.chatSessionId}${draftId ? ' and refreshed the native draft.' : ''}`
      : `Workflow builder role handoff failed: ${assistant.error ?? 'unknown error'}`
    events.push(workflowBuilderSystemEvent({
      at: nowIso(),
      type: 'assistant_handoff',
      status: assistant.ok ? 'completed' : 'failed',
      summary: systemMessage,
      draftId,
      workflowRef,
      ...(assistant.validationOk !== undefined ? { validationOk: assistant.validationOk } : {}),
    }))
  }

  const view = await buildBuilderSessionView({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    sessionId: input.sessionId,
    goal: current.goal,
    workflowRef,
    draftId,
    messages: [
      ...current.messages,
      ...(message ? [{ at, role: 'user' as const, content: message }] : []),
      ...(systemMessage
        ? [{ at, role: 'system' as const, content: systemMessage }]
        : []),
    ],
    events,
    status,
    createdAt: current.createdAt,
    updatedAt: at,
    lastDraft,
    lastValidation,
    lastCompile,
    lastRepair,
    lastAssistant,
    lastPublish,
  })
  await persistBuilderSession(input.cwd, view)
  return view
}

export async function previewMatOSWorkbenchWorkflowRoleAttachment(
  input: MatOSWorkbenchContext & {
    ref: string
    roleRef: string
    request?: unknown
  },
) {
  const request = objectValue(input.request) ?? {}
  return previewMatOSWorkbenchRoleDraft({
    ...input,
    ref: input.roleRef,
    mutation: 'attach-workflow',
    request: {
      ...request,
      matos_attachments: [
        ...asArray(request.matos_attachments),
        {
          ref: input.ref,
          group: 'workflows',
          allowedActions: ['query', 'run', 'status', 'monitor', 'respond', 'approve', 'deny', 'recover', 'reconcile'],
          invocationPolicy: {
            mode: 'agent-discoverable',
            requireUserApproval: false,
          },
          reason: stringValue(request.reason) ?? 'Attach workflow from the native MatOS workflow builder.',
        },
      ],
    },
  })
}

export async function applyMatOSWorkbenchWorkflowRoleAttachment(
  input: MatOSWorkbenchContext & {
    ref: string
    roleRef: string
    request?: unknown
    fingerprint: string
    reason?: string
  },
) {
  const request = objectValue(input.request) ?? {}
  return applyMatOSWorkbenchRoleDraft({
    ...input,
    ref: input.roleRef,
    mutation: 'attach-workflow',
    request: {
      ...request,
      matos_attachments: [
        ...asArray(request.matos_attachments),
        {
          ref: input.ref,
          group: 'workflows',
          allowedActions: ['query', 'run', 'status', 'monitor', 'respond', 'approve', 'deny', 'recover', 'reconcile'],
          invocationPolicy: {
            mode: 'agent-discoverable',
            requireUserApproval: false,
          },
          reason: stringValue(request.reason) ?? 'Attach workflow from the native MatOS workflow builder.',
        },
      ],
    },
    fingerprint: input.fingerprint,
    reason: input.reason,
  })
}

// Control responses embed run/node state echoes (approval responses, node
// inputs, error details), so they go through the same redaction gate as the
// run/inspect/events read paths before reaching CLI JSON or the workspace.
export async function respondMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & { runId: string; nodeId: string; response: unknown },
) {
  return redactWorkbenchValue(await matOSWorkflowService.respond(input))
}

export async function approveMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & {
    runId: string
    nodeId: string
    fingerprint?: string
    response?: unknown
  },
) {
  return redactWorkbenchValue(await matOSWorkflowService.approve(input))
}

export async function denyMatOSWorkbenchWorkflow(
  input: MatOSWorkbenchContext & { runId: string; nodeId: string; reason?: string },
) {
  return redactWorkbenchValue(await matOSWorkflowService.deny(input))
}

export async function cancelMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  return redactWorkbenchValue(await matOSWorkflowService.cancel(input))
}

export async function pauseMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  return redactWorkbenchValue(await matOSWorkflowService.pause(input))
}

export async function resumeMatOSWorkbenchWorkflowRun(
  input: MatOSWorkbenchContext & { runId: string },
) {
  return redactWorkbenchValue(await matOSWorkflowService.resume(input))
}

export async function retryMatOSWorkbenchWorkflowNode(
  input: MatOSWorkbenchContext & {
    runId: string
    nodeId: string
    failedChildrenOnly?: boolean
  },
) {
  return redactWorkbenchValue(await matOSWorkflowService.retryNode(input))
}

export async function skipMatOSWorkbenchWorkflowNode(
  input: MatOSWorkbenchContext & { runId: string; nodeId: string; reason?: string },
) {
  return redactWorkbenchValue(await matOSWorkflowService.skipNode(input))
}
