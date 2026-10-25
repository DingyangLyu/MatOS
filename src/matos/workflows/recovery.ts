import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readyWorkflowNodes,
  workflowNodeStatus,
} from './scheduler.js'
import { workflowNodeSupportsRemoteLifecycle } from './computeLifecycle.js'
import {
  classifyStateMachineRecovery,
  type StateMachineRecoveryEvidence,
} from './stateMachineRecovery.js'
import { isStateMachineWorkflow } from './stateMachineTypes.js'
import { readJson } from './jsonIo.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowEvent,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunSnapshot,
  WorkflowAttemptSideEffectSummary,
  WorkflowArtifactRef,
} from './types.js'
import { readWorkflowRun, readWorkflowRunEvents } from './workflowStore.js'
import { workflowFailureSourceNodeIds } from './validationFailure.js'

export type WorkflowRecoveryClassification =
  | 'none'
  | 'completed'
  | 'cancelled'
  | 'human_wait'
  | 'approval_wait'
  | 'interrupted_process'
  | 'schema_failure'
  | 'validation_failure'
  | 'dynamic_graph_patch_failure'
  | 'model_api_failure'
  | 'tool_failure'
  | 'backend_failure'
  | 'compute_reconcile_due'
  | 'compute_reconcile_failure'
  | 'compute_cancel_failure'
  | 'compute_remote_exception_escalated'
  | 'unknown_failure'

export type WorkflowRecoveryRecommendedAction =
  | 'none'
  | 'wait'
  | 'resume'
  | 'reconcile_compute'
  | 'retry_remote_cancel'
  | 'retry_node'
  | 'request_human_review'
  | 'fail'

export type WorkflowRemoteRecoveryEvidence = {
  kind: 'cancel' | 'reconcile'
  backend?: string
  taskId?: string
  source?: string
  latestError?: string
  retryAfterMs?: number
  nextRetryAt?: string
  failureCount?: number
  escalationThreshold?: number
  escalated?: boolean
  staleAgeMs?: number
  staleAfterMs?: number
}

export type WorkflowRecoveryReport = {
  runId: string
  runDir: string
  workflowRef: string
  status: MatOSWorkflowRunSnapshot['status']
  classification: WorkflowRecoveryClassification
  recommendedAction: WorkflowRecoveryRecommendedAction
  nodeId?: string
  reason: string
  remoteRecovery?: WorkflowRemoteRecoveryEvidence
  evidence: {
    waitingNodeId?: string
    failedNodeIds: string[]
    runningNodeIds: string[]
    readyNodeIds: string[]
    pendingNodeIds: string[]
    eventCount: number
    artifactCount: number
    causalSourceNodeIds?: string[]
    stateMachine?: StateMachineRecoveryEvidence
  }
}

export function workflowRecoverySafeAlternativeActions(
  report: WorkflowRecoveryReport,
): WorkflowRecoveryRecommendedAction[] {
  if (report.recommendedAction === 'none') return ['none']
  const actions = new Set<WorkflowRecoveryRecommendedAction>([
    report.recommendedAction,
    'request_human_review',
    'wait',
    'fail',
  ])
  return [...actions]
}

export function workflowRecoveryReportDigest(
  report: WorkflowRecoveryReport,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: report.runId,
        status: report.status,
        classification: report.classification,
        recommendedAction: report.recommendedAction,
        nodeId: report.nodeId,
        evidence: report.evidence,
        remoteRecovery: report.remoteRecovery,
      }),
    )
    .digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * A kill -9 between the terminal run.json write and the final event/receipt
 * refresh leaves an executionally-correct run whose runtime receipt is
 * permanently behind (stale status / event digest) — no later event append
 * ever happens on a terminal run, so nothing else refreshes it and evidence
 * verification rejects the run forever. Recovery is the designated
 * self-heal point: rewrite the receipt (idempotent, reads only persisted
 * files) when its status no longer matches the run's.
 */
async function healStaleRuntimeReceipt(
  runDir: string,
  run: MatOSWorkflowRunSnapshot,
): Promise<void> {
  try {
    const receipt = await readJson<{ status?: unknown }>(
      join(runDir, 'runtime-receipt.json'),
    )
    if (receipt.status === run.status) {
      return
    }
  } catch {
    // Missing/unreadable receipt: rewrite below.
  }
  const { writeWorkflowRuntimeReceipt } = await import('./runtimeReceipt.js')
  await writeWorkflowRuntimeReceipt(runDir).catch(() => {
    // Best-effort: recovery classification must not fail over receipt IO.
  })
}

async function readWorkflowDefinition(
  runDir: string,
  run: MatOSWorkflowRunSnapshot,
): Promise<MatOSWorkflowDefinition> {
  return readJson<MatOSWorkflowDefinition>(join(runDir, run.graphSnapshotPath))
}

async function readArtifacts(runDir: string): Promise<WorkflowArtifactRef[]> {
  const path = join(runDir, 'artifacts.json')
  if (!(await exists(path))) {
    return []
  }
  const value = await readJson<unknown>(path)
  return Array.isArray(value)
    ? value.filter(
        (item): item is WorkflowArtifactRef =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : []
}

async function readEvents(runDir: string): Promise<MatOSWorkflowEvent[]> {
  try {
    return await readWorkflowRunEvents(runDir)
  } catch {
    return []
  }
}

async function listNodeRuns(
  runDir: string,
): Promise<Map<string, MatOSWorkflowNodeRunSnapshot>> {
  const map = new Map<string, MatOSWorkflowNodeRunSnapshot>()
  let entries: string[]
  try {
    entries = await readdir(join(runDir, 'node-runs'))
  } catch {
    return map
  }

  for (const entry of entries) {
    try {
      const run = await readJson<MatOSWorkflowNodeRunSnapshot>(
        join(runDir, 'node-runs', entry, 'node-run.json'),
      )
      map.set(run.nodeId, run)
    } catch {
      // Partial node-run directories are recovery evidence, but an unreadable
      // node-run should not prevent classifying the rest of the persisted run.
    }
  }
  return map
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function outputLifecycle(
  run: MatOSWorkflowNodeRunSnapshot | undefined,
): Record<string, unknown> {
  const output = isRecord(run?.output) ? run.output : undefined
  const diagnostics = isRecord(output?.diagnostics) ? output.diagnostics : undefined
  return isRecord(diagnostics?.lifecycle) ? diagnostics.lifecycle : {}
}

function latestFailureRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return [...value].reverse().find(isRecord)
}

function futureNextRetryAt(
  failure: Record<string, unknown> | undefined,
): string | undefined {
  const nextRetryAt =
    typeof failure?.nextRetryAt === 'string' ? failure.nextRetryAt : undefined
  if (!nextRetryAt) {
    return undefined
  }
  const retryTime = Date.parse(nextRetryAt)
  return Number.isFinite(retryTime) && retryTime > Date.now()
    ? nextRetryAt
    : undefined
}

function lifecycleHasSuccessfulCancel(
  lifecycle: Record<string, unknown>,
): boolean {
  const cancel = isRecord(lifecycle.cancel) ? lifecycle.cancel : undefined
  return cancel?.ok === true
}

function lifecycleHasSuccessfulReconcile(
  lifecycle: Record<string, unknown>,
): boolean {
  const reconcile = isRecord(lifecycle.reconcile)
    ? lifecycle.reconcile
    : undefined
  return reconcile?.ok === true
}

const DEFAULT_COMPUTE_TERMINAL_STATUSES = [
  'finished',
  'success',
  'succeeded',
  'completed',
]
const DEFAULT_COMPUTE_FAILURE_STATUSES = [
  'failed',
  'failure',
  'error',
  'cancelled',
  'canceled',
  'killed',
]
const DEFAULT_STALE_COMPUTE_RECONCILE_AFTER_MS = 10 * 60 * 1000
const DEFAULT_COMPUTE_REMOTE_ESCALATE_AFTER_FAILURES = 3

function rawComputeLifecycle(node: MatOSWorkflowNode): Record<string, unknown> {
  if (isRecord(node.lifecycle)) {
    return node.lifecycle
  }
  if (isRecord(node.computeLifecycle)) {
    return node.computeLifecycle
  }
  return {}
}

function normalizedStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    : []
}

function normalizedStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : undefined
}

function computeLifecycleStatusList(
  raw: Record<string, unknown>,
  key: 'terminalStatuses' | 'failureStatuses',
  defaults: string[],
): string[] {
  const poll = isRecord(raw.poll) ? raw.poll : {}
  const configured = normalizedStringList(poll[key])
    .map(item => normalizedStatus(item))
    .filter((item): item is string => Boolean(item))
  return configured.length > 0 ? configured : defaults
}

// Collect every status token a compute receipt can carry. Must stay aligned
// with computeLifecycle.computeReceiptStatusTokens so recovery's terminal/stale
// detection sees the same statuses the reconcile path does (a job whose status
// lives only in payload.state must not look "still submitted" to recovery).
function computeReceiptStatusTokens(output: Record<string, unknown>): string[] {
  const payload = isRecord(output.payload) ? output.payload : {}
  return [
    output.status,
    payload.status,
    payload.state,
    payload.phase,
    payload.taskStatus,
  ]
    .map(item => normalizedStatus(item))
    .filter((item): item is string => Boolean(item))
}

function computeReceiptHasKnownTerminalStatus(
  output: Record<string, unknown>,
  rawLifecycle: Record<string, unknown>,
): boolean {
  const tokens = computeReceiptStatusTokens(output)
  if (tokens.length === 0) {
    return false
  }
  const known = new Set([
    ...computeLifecycleStatusList(
      rawLifecycle,
      'terminalStatuses',
      DEFAULT_COMPUTE_TERMINAL_STATUSES,
    ),
    ...computeLifecycleStatusList(
      rawLifecycle,
      'failureStatuses',
      DEFAULT_COMPUTE_FAILURE_STATUSES,
    ),
  ])
  return tokens.some(token => known.has(token))
}

function staleComputeReconcileAfterMs(
  rawLifecycle: Record<string, unknown>,
): number {
  const configured = Number(rawLifecycle.reconcileAfterMs)
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_STALE_COMPUTE_RECONCILE_AFTER_MS
}

function computeRemoteEscalateAfterFailures(
  rawLifecycle: Record<string, unknown>,
  kind: 'cancel' | 'reconcile',
): number {
  const configured = Number(
    kind === 'cancel'
      ? rawLifecycle.cancelEscalateAfterFailures ??
          rawLifecycle.remoteEscalateAfterFailures
      : rawLifecycle.reconcileEscalateAfterFailures ??
          rawLifecycle.remoteEscalateAfterFailures,
  )
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_COMPUTE_REMOTE_ESCALATE_AFTER_FAILURES
}

function nodeRunAgeMs(nodeRun: MatOSWorkflowNodeRunSnapshot | undefined): number {
  const timestamp = nodeRun?.updatedAt ?? nodeRun?.finishedAt ?? nodeRun?.startedAt
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN
  return Number.isFinite(parsed) ? Date.now() - parsed : 0
}

function staleSubmittedComputeReceipt(
  node: MatOSWorkflowNode,
  nodeRun: MatOSWorkflowNodeRunSnapshot | undefined,
): { taskId?: string; ageMs: number } | undefined {
  const rawLifecycle = rawComputeLifecycle(node)
  if (rawLifecycle.reconcileOnResume !== true) {
    return undefined
  }
  const output = isRecord(nodeRun?.output) ? nodeRun.output : undefined
  // Compute receipts always set `operation`; generic backend receipts may
  // omit it, so only skip when the output explicitly was not a submit.
  if (
    !output ||
    (output.operation !== undefined && output.operation !== 'submit')
  ) {
    return undefined
  }
  const taskId = taskIdFromFailureOrOutput(undefined, nodeRun)
  if (!taskId || computeReceiptHasKnownTerminalStatus(output, rawLifecycle)) {
    return undefined
  }
  const ageMs = nodeRunAgeMs(nodeRun)
  if (ageMs < staleComputeReconcileAfterMs(rawLifecycle)) {
    return undefined
  }
  return { taskId, ageMs }
}

function taskIdFromFailureOrOutput(
  failure: Record<string, unknown> | undefined,
  run: MatOSWorkflowNodeRunSnapshot | undefined,
): string | undefined {
  const output = isRecord(run?.output) ? run.output : {}
  const payload = isRecord(output.payload) ? output.payload : {}
  const taskId =
    (typeof failure?.taskId === 'string' && failure.taskId.trim()) ||
    (typeof output.taskId === 'string' && output.taskId.trim()) ||
    (typeof output.jobId === 'string' && output.jobId.trim()) ||
    (typeof payload.taskId === 'string' && payload.taskId.trim()) ||
    (typeof payload.jobId === 'string' && payload.jobId.trim())
  return taskId || undefined
}

function failureTaskId(failure: Record<string, unknown>): string | undefined {
  return typeof failure.taskId === 'string' && failure.taskId.trim()
    ? failure.taskId.trim()
    : undefined
}

function failureSource(failure: Record<string, unknown>): string | undefined {
  return typeof failure.source === 'string' && failure.source.trim()
    ? failure.source.trim()
    : undefined
}

function failureError(failure: Record<string, unknown>): string | undefined {
  return typeof failure.error === 'string' && failure.error.trim()
    ? failure.error.trim()
    : undefined
}

function failureRetryAfterMs(
  failure: Record<string, unknown>,
): number | undefined {
  const retryAfterMs = Number(failure.retryAfterMs)
  return Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : undefined
}

function consecutiveFailureCountForLatestTask(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0
  }
  const failures = value.filter(isRecord)
  const latest = failures[failures.length - 1]
  if (!latest) {
    return 0
  }
  const latestTaskId = failureTaskId(latest)
  let count = 0
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const failure = failures[index]
    if (!failure) {
      continue
    }
    if (latestTaskId && failureTaskId(failure) !== latestTaskId) {
      break
    }
    count += 1
  }
  return count
}

function remoteRecoveryEvidenceFromFailure(input: {
  node: MatOSWorkflowNode
  nodeRun: MatOSWorkflowNodeRunSnapshot | undefined
  kind: 'cancel' | 'reconcile'
  failures: unknown
  failure: Record<string, unknown>
  escalated: boolean
}): WorkflowRemoteRecoveryEvidence {
  const taskId = taskIdFromFailureOrOutput(input.failure, input.nodeRun)
  const source = failureSource(input.failure)
  const latestError = failureError(input.failure)
  const retryAfterMs = failureRetryAfterMs(input.failure)
  const nextRetryAt = futureNextRetryAt(input.failure)
  return {
    kind: input.kind,
    ...(typeof input.node.backend === 'string'
      ? { backend: input.node.backend }
      : {}),
    ...(taskId ? { taskId } : {}),
    ...(source ? { source } : {}),
    ...(latestError ? { latestError } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
    failureCount: consecutiveFailureCountForLatestTask(input.failures),
    escalationThreshold: computeRemoteEscalateAfterFailures(
      rawComputeLifecycle(input.node),
      input.kind,
    ),
    escalated: input.escalated,
  }
}

function escalatedRemoteException(input: {
  node: MatOSWorkflowNode
  nodeRun: MatOSWorkflowNodeRunSnapshot | undefined
  kind: 'cancel' | 'reconcile'
  failures: unknown
  latestFailure: Record<string, unknown>
}): {
  classification: 'compute_remote_exception_escalated'
  action: 'request_human_review'
  nodeId: string
  reason: string
  remoteRecovery: WorkflowRemoteRecoveryEvidence
} | undefined {
  const rawLifecycle = rawComputeLifecycle(input.node)
  const threshold = computeRemoteEscalateAfterFailures(rawLifecycle, input.kind)
  const count = consecutiveFailureCountForLatestTask(input.failures)
  if (count < threshold) {
    return undefined
  }
  const remoteRecovery = remoteRecoveryEvidenceFromFailure({
    node: input.node,
    nodeRun: input.nodeRun,
    kind: input.kind,
    failures: input.failures,
    failure: input.latestFailure,
    escalated: true,
  })
  const taskId = remoteRecovery.taskId
  const nextRetryAt = remoteRecovery.nextRetryAt
  const noun = input.kind === 'cancel' ? 'cancel' : 'reconcile'
  return {
    classification: 'compute_remote_exception_escalated',
    action: 'request_human_review',
    nodeId: input.node.id,
    reason: `Compute node ${input.node.id} has ${count} consecutive ${noun} failures${taskId ? ` for ${taskId}` : ''}${nextRetryAt ? `; next retry was scheduled at ${nextRetryAt}` : ''}. Escalate to an operator before continuing automatic remote recovery.`,
    remoteRecovery,
  }
}

function computeReceiptRecoveryEvidence(
  definition: MatOSWorkflowDefinition,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
): {
  classification: Extract<
    WorkflowRecoveryClassification,
    | 'compute_reconcile_due'
    | 'compute_reconcile_failure'
    | 'compute_cancel_failure'
    | 'compute_remote_exception_escalated'
  >
  action: Extract<
    WorkflowRecoveryRecommendedAction,
    'reconcile_compute' | 'retry_remote_cancel' | 'wait' | 'request_human_review'
  >
  nodeId: string
  reason: string
  remoteRecovery: WorkflowRemoteRecoveryEvidence
} | undefined {
  for (const node of definition.nodes) {
    if (!workflowNodeSupportsRemoteLifecycle(node)) {
      continue
    }
    const nodeRun = nodeRuns.get(node.id)
    const lifecycle = outputLifecycle(nodeRun)
    const cancelFailure = latestFailureRecord(lifecycle.cancelFailures)
    if (cancelFailure && !lifecycleHasSuccessfulCancel(lifecycle)) {
      const escalated = escalatedRemoteException({
        node,
        nodeRun,
        kind: 'cancel',
        failures: lifecycle.cancelFailures,
        latestFailure: cancelFailure,
      })
      if (escalated) {
        return escalated
      }
      const taskId = taskIdFromFailureOrOutput(cancelFailure, nodeRun)
      const nextRetryAt = futureNextRetryAt(cancelFailure)
      const remoteRecovery = remoteRecoveryEvidenceFromFailure({
        node,
        nodeRun,
        kind: 'cancel',
        failures: lifecycle.cancelFailures,
        failure: cancelFailure,
        escalated: false,
      })
      if (nextRetryAt) {
        return {
          classification: 'compute_cancel_failure',
          action: 'wait',
          nodeId: node.id,
          reason: `Compute node ${node.id} has a remote cancel failure${taskId ? ` for ${taskId}` : ''}; next retry is scheduled at ${nextRetryAt}. Wait before retrying remote cancellation.`,
          remoteRecovery,
        }
      }
      return {
        classification: 'compute_cancel_failure',
        action: 'retry_remote_cancel',
        nodeId: node.id,
        reason: `Compute node ${node.id} has a remote cancel failure${taskId ? ` for ${taskId}` : ''}. Retry remote cancellation before assuming the backend task stopped.`,
        remoteRecovery,
      }
    }
    const reconcileFailure = latestFailureRecord(lifecycle.reconcileFailures)
    if (reconcileFailure && !lifecycleHasSuccessfulReconcile(lifecycle)) {
      const escalated = escalatedRemoteException({
        node,
        nodeRun,
        kind: 'reconcile',
        failures: lifecycle.reconcileFailures,
        latestFailure: reconcileFailure,
      })
      if (escalated) {
        return escalated
      }
      const taskId = taskIdFromFailureOrOutput(reconcileFailure, nodeRun)
      const nextRetryAt = futureNextRetryAt(reconcileFailure)
      const remoteRecovery = remoteRecoveryEvidenceFromFailure({
        node,
        nodeRun,
        kind: 'reconcile',
        failures: lifecycle.reconcileFailures,
        failure: reconcileFailure,
        escalated: false,
      })
      if (nextRetryAt) {
        return {
          classification: 'compute_reconcile_failure',
          action: 'wait',
          nodeId: node.id,
          reason: `Compute node ${node.id} has a remote status reconciliation failure${taskId ? ` for ${taskId}` : ''}; next retry is scheduled at ${nextRetryAt}. Wait before reconciling the backend task again.`,
          remoteRecovery,
        }
      }
      return {
        classification: 'compute_reconcile_failure',
        action: 'reconcile_compute',
        nodeId: node.id,
        reason: `Compute node ${node.id} has a remote status reconciliation failure${taskId ? ` for ${taskId}` : ''}. Reconcile the backend task before continuing downstream review.`,
        remoteRecovery,
      }
    }
    const staleReceipt = staleSubmittedComputeReceipt(node, nodeRun)
    if (staleReceipt) {
      return {
        classification: 'compute_reconcile_due',
        action: 'reconcile_compute',
        nodeId: node.id,
        reason: `Compute node ${node.id} has a submitted remote task ${staleReceipt.taskId} without a recent status refresh. Reconcile the backend task before continuing downstream review.`,
        remoteRecovery: {
          kind: 'reconcile',
          ...(typeof node.backend === 'string' ? { backend: node.backend } : {}),
          ...(staleReceipt.taskId ? { taskId: staleReceipt.taskId } : {}),
          staleAgeMs: staleReceipt.ageMs,
          staleAfterMs: staleComputeReconcileAfterMs(rawComputeLifecycle(node)),
        },
      }
    }
  }
  return undefined
}

function orderedFailedNodes(
  definition: MatOSWorkflowDefinition,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
): Array<{ node: MatOSWorkflowNode; run: MatOSWorkflowNodeRunSnapshot }> {
  return definition.nodes
    .map(node => ({ node, run: nodeRuns.get(node.id) }))
    .filter(
      (
        item,
      ): item is {
        node: MatOSWorkflowNode
        run: MatOSWorkflowNodeRunSnapshot
      } => item.run?.status === 'failed',
    )
}

function errorMessage(run: MatOSWorkflowNodeRunSnapshot | undefined): string {
  const error = run?.error
  if (!error) {
    return ''
  }
  if (
    typeof error === 'object' &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).message === 'string'
  ) {
    return String((error as Record<string, unknown>).message)
  }
  return String(error)
}

/**
 * Structured failure code persisted with the node run (WorkflowNodeErrorInfo
 * `code`). When present it is the highest-confidence classification anchor:
 * unlike message text it cannot collide with scientific error prose.
 */
function errorCode(run: MatOSWorkflowNodeRunSnapshot | undefined): string {
  const error = run?.error
  return error &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).code === 'string'
    ? String((error as Record<string, unknown>).code)
    : ''
}

/**
 * Message phrases that only genuine output-schema/contract validation
 * failures produce (outputContract.ts and the runtime contract assertion).
 * Deliberately narrow: a bare Ajv-style "... must be ..." also occurs in
 * ordinary domain errors ("lattice parameter must be positive"), so it is NOT
 * matched on its own — contract failures are recognized by their stable
 * `output_contract_failed` code instead (see errorCode above).
 */
const SCHEMA_FAILURE_MESSAGE_PATTERNS: RegExp[] = [
  /\boutput[\s_-]?schema\b/i, // "output schema failed", "outputSchema failed"
  /\boutput[\s_-]?contract\b/i,
  /\bschema\s+(?:validation\s+)?failed\b/i,
  /\bjson\s+schema\b/i,
]

/**
 * Model/API transport failure signals for agent nodes. Word-bounded and
 * phrase-anchored: the old bare substrings misfiled scientific text ("rapid"
 * and "therapy" contain "api"; "connection between adsorbate layers" is not a
 * transport error). ECONN* stays case-sensitive because it is an OS error
 * code, not prose.
 */
const MODEL_API_FAILURE_MESSAGE_PATTERNS: RegExp[] = [
  /\bapi\b/i,
  /\bauthenticat/i, // authenticate/authentication/authenticating
  /\brate[\s_-]?limit/i,
  /\btimed?[\s_-]?outs?\b/i, // "timeout", "timed out", "timed-out"
  /\bconnection\s+(?:refused|reset|closed|aborted|failed|error|lost|timed?[\s_-]?out)\b/i,
  /\bECONN(?:REFUSED|RESET|ABORTED)\b/,
  /\bfetch failed\b/i,
]

function failedNodeClassification(
  node: MatOSWorkflowNode,
  run: MatOSWorkflowNodeRunSnapshot,
  causalSourceNodeId?: string,
): {
  classification: WorkflowRecoveryClassification
  action: WorkflowRecoveryRecommendedAction
  nodeId?: string
  reason: string
} {
  const sideEffect = failedNodeSideEffectClassification(node, run.sideEffect)
  if (sideEffect) {
    return sideEffect
  }
  const message = errorMessage(run)
  const lower = message.toLowerCase()
  if (node.targetType === 'validate' || node.type === 'guard') {
    return {
      classification: 'validation_failure',
      action: 'retry_node',
      ...(causalSourceNodeId ? { nodeId: causalSourceNodeId } : {}),
      reason: causalSourceNodeId
        ? `Validation node ${node.id} rejected output from producer ${causalSourceNodeId}; repair and retry the producer so its affected downstream closure is recomputed.`
        : `Validation node ${node.id} failed; inspect its dependency ancestry before deciding whether to repair the validator or an upstream producer.`,
    }
  }
  if (
    errorCode(run) === 'output_contract_failed' ||
    SCHEMA_FAILURE_MESSAGE_PATTERNS.some(pattern => pattern.test(message))
  ) {
    return {
      classification: 'schema_failure',
      action: 'retry_node',
      reason: `Node ${node.id} failed output/schema validation.`,
    }
  }
  if (
    node.type === 'dynamic' ||
    lower.includes('dynamic workflow patch') ||
    lower.includes('dynamic graph patch') ||
    lower.includes('graph patch')
  ) {
    return {
      classification: 'dynamic_graph_patch_failure',
      action: 'request_human_review',
      reason: `Dynamic graph patch node ${node.id} failed and needs review before retrying or applying graph changes.`,
    }
  }
  if (node.type === 'agent') {
    const apiFailure = MODEL_API_FAILURE_MESSAGE_PATTERNS.some(pattern =>
      pattern.test(message),
    )
    return {
      classification: apiFailure ? 'model_api_failure' : 'tool_failure',
      action: 'retry_node',
      reason: `Agent node ${node.id} failed.`,
    }
  }
  if (node.type === 'backend' || node.targetType === 'compute') {
    return {
      classification: 'backend_failure',
      action: 'retry_node',
      reason: `Backend node ${node.id} failed.`,
    }
  }
  return {
    classification: 'tool_failure',
    action: 'retry_node',
    reason: `Node ${node.id} failed.`,
  }
}

function failedNodeSideEffectClassification(
  node: MatOSWorkflowNode,
  sideEffect: WorkflowAttemptSideEffectSummary | undefined,
): {
  classification: WorkflowRecoveryClassification
  action: WorkflowRecoveryRecommendedAction
  reason: string
} | undefined {
  if (!sideEffect) {
    return undefined
  }
  if (sideEffect.replayStrategy === 'reconcile_before_resubmit') {
    const receipt = sideEffect.receipt
    return {
      classification: 'backend_failure',
      action: 'reconcile_compute',
      reason: `Node ${node.id} has external side effects${receipt?.taskId ? ` for ${receipt.taskId}` : ''}; reconcile the backend receipt before resubmitting.`,
    }
  }
  if (
    sideEffect.replayStrategy === 'manual_review' ||
    sideEffect.replayStrategy === 'wait_for_human'
  ) {
    return {
      classification:
        sideEffect.class === 'graph_patch'
          ? 'dynamic_graph_patch_failure'
          : 'unknown_failure',
      action: 'request_human_review',
      reason: `Node ${node.id} failed after ${sideEffect.class} side effects; manual review is required before replay.`,
    }
  }
  if (!sideEffect.replaySafe && sideEffect.replayStrategy !== 'rerun') {
    return {
      classification: 'unknown_failure',
      action: 'request_human_review',
      reason: `Node ${node.id} has replay-unsafe side effects; manual review is required before retry.`,
    }
  }
  return undefined
}

export async function recoverWorkflowRun(
  runDir: string,
): Promise<WorkflowRecoveryReport> {
  const run = await readWorkflowRun(runDir)
  const definition = await readWorkflowDefinition(runDir, run)
  const nodeRuns = await listNodeRuns(runDir)
  const events = await readEvents(runDir)
  const artifacts = await readArtifacts(runDir)
  const stateMachine = isStateMachineWorkflow(definition)
    ? await classifyStateMachineRecovery(runDir)
    : undefined
  const readyNodes = readyWorkflowNodes({
    definition,
    nodeRuns,
    parameters: run.parameters,
  })
  const failedNodes = orderedFailedNodes(definition, nodeRuns)
  const causalSourceNodeIds = [
    ...new Set(
      failedNodes.flatMap(item =>
        workflowFailureSourceNodeIds(item.run.error).filter(sourceNodeId =>
          definition.nodes.some(node => node.id === sourceNodeId),
        ),
      ),
    ),
  ]
  const runningNodeIds = definition.nodes
    .filter(node => workflowNodeStatus(nodeRuns, node.id) === 'running')
    .map(node => node.id)
  const pendingNodeIds = definition.nodes
    .filter(node => workflowNodeStatus(nodeRuns, node.id) === 'pending')
    .map(node => node.id)
  const base = {
    runId: run.runId,
    runDir,
    workflowRef: run.workflowRef,
    status: run.status,
    evidence: {
      ...(run.waitingNodeId ? { waitingNodeId: run.waitingNodeId } : {}),
      failedNodeIds: failedNodes.map(item => item.node.id),
      runningNodeIds,
      readyNodeIds: readyNodes.map(node => node.id),
      pendingNodeIds,
      eventCount: events.length,
      artifactCount: artifacts.length,
      ...(causalSourceNodeIds.length > 0 ? { causalSourceNodeIds } : {}),
      ...(stateMachine ? { stateMachine } : {}),
    },
  }

  if (run.status === 'completed') {
    await healStaleRuntimeReceipt(runDir, run)
    return {
      ...base,
      classification: 'completed',
      recommendedAction: 'none',
      reason: 'Workflow run is already completed.',
    }
  }
  const computeRecovery = computeReceiptRecoveryEvidence(definition, nodeRuns)
  if (computeRecovery) {
    return {
      ...base,
      classification: computeRecovery.classification,
      recommendedAction: computeRecovery.action,
      nodeId: computeRecovery.nodeId,
      reason: computeRecovery.reason,
      remoteRecovery: computeRecovery.remoteRecovery,
    }
  }
  if (run.status === 'cancelled') {
    await healStaleRuntimeReceipt(runDir, run)
    return {
      ...base,
      classification: 'cancelled',
      recommendedAction: 'none',
      reason: 'Workflow run is cancelled.',
    }
  }
  if (run.status === 'waiting_input') {
    return {
      ...base,
      classification: 'human_wait',
      recommendedAction: 'request_human_review',
      nodeId: run.waitingNodeId,
      reason: `Workflow is waiting for human input at ${run.waitingNodeId ?? 'unknown node'}.`,
    }
  }
  if (run.status === 'waiting_approval') {
    return {
      ...base,
      classification: 'approval_wait',
      recommendedAction: 'wait',
      nodeId: run.waitingNodeId,
      reason: `Workflow is waiting for approval at ${run.waitingNodeId ?? 'unknown node'}.`,
    }
  }
  if (run.status === 'failed' && failedNodes.length > 0) {
    const failed = failedNodes[0]
    const causalSourceNodeId = workflowFailureSourceNodeIds(failed.run.error).find(
      sourceNodeId => definition.nodes.some(node => node.id === sourceNodeId),
    )
    const classified = failedNodeClassification(
      failed.node,
      failed.run,
      causalSourceNodeId,
    )
    return {
      ...base,
      classification: classified.classification,
      recommendedAction: classified.action,
      nodeId: classified.nodeId ?? failed.node.id,
      reason: classified.reason,
    }
  }
  if (
    run.status === 'running' ||
    run.status === 'paused' ||
    run.status === 'created'
  ) {
    // State-machine runs advance frame by frame, so frame evidence is more
    // precise than the DAG ready-set heuristic: resume either re-executes the
    // interrupted frame or schedules the next transition, and a frame that
    // stopped at a human gate before the run status was persisted should be
    // routed to human review instead of a blind resume.
    if (stateMachine) {
      if (stateMachine.recommendation === 'human_review') {
        return {
          ...base,
          classification: 'human_wait',
          recommendedAction: 'request_human_review',
          nodeId: stateMachine.activeNodeId,
          reason: `State-machine frame ${stateMachine.frameIndex ?? '?'} is waiting at ${stateMachine.activeNodeId ?? 'unknown node'} (${stateMachine.latestFrameStatus ?? 'unknown status'}).`,
        }
      }
      return {
        ...base,
        classification: 'interrupted_process',
        recommendedAction: 'resume',
        nodeId: stateMachine.activeNodeId,
        reason:
          stateMachine.recommendation === 'advance_next_frame'
            ? `State-machine frame ${stateMachine.frameIndex ?? '?'} completed at ${stateMachine.activeNodeId ?? 'unknown node'}; resume will schedule the next transition.`
            : `State-machine run was interrupted at frame ${stateMachine.frameIndex ?? '?'} (${stateMachine.latestFrameStatus ?? 'no frame'}); resume will re-execute the active frame.`,
      }
    }
    if (readyNodes.length > 0 || pendingNodeIds.length > 0 || runningNodeIds.length > 0) {
      return {
        ...base,
        classification: 'interrupted_process',
        recommendedAction: 'resume',
        nodeId: readyNodes[0]?.id ?? runningNodeIds[0] ?? pendingNodeIds[0],
        reason: 'Workflow has unfinished runnable or in-flight nodes and can be resumed from persisted state.',
      }
    }
    return {
      ...base,
      classification: 'none',
      recommendedAction: 'resume',
      reason: 'Workflow is active but has no classified failure; resume will re-evaluate scheduler state.',
    }
  }

  return {
    ...base,
    classification: 'unknown_failure',
    recommendedAction: failedNodes.length > 0 ? 'retry_node' : 'fail',
    nodeId: failedNodes[0]?.node.id,
    reason: 'Workflow recovery classifier could not identify a safer action.',
  }
}
