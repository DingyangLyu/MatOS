import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { decideMatOSApprovalPolicy } from '../algorithms/surfaces/approvalPolicy.js'
import {
  redactTraceValue,
  scrubSecretsFromString,
} from '../sessions/traceContext.js'
import { appendWorkflowEvent, readWorkflowRun, writeNodeAttempt } from './workflowStore.js'
import { writeJson } from './jsonIo.js'
import { withKeyedMutex } from './asyncMutex.js'
import { writeWorkflowHumanPrompt } from './nodeAdapters/humanNode.js'
import { WorkflowValidationFailureError } from './validationFailure.js'
import {
  computeJobSpecForNode,
  computeToolRefForSpec,
} from './nodeAdapters/computeNode.js'
import { validateWorkflowNodeOutputContract } from './outputContract.js'
import { downstreamWorkflowNodeIds } from './scheduler.js'
import {
  waitWorkflowRunBackoff,
  type WorkflowRunControlAction,
} from './workflowControl.js'
import {
  approvalPath,
  nowIso,
  pathIsInsideRoot,
  readNodeRun,
  readWorkflowArtifacts,
  resetNodeRun,
  updateRunStatus,
  writeNodeRun,
  writeWorkflowArtifacts,
} from './runState.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowNodeStatus,
  ValidationResult,
  WorkflowArtifactContract,
  WorkflowArtifactRef,
  WorkflowAttemptSideEffectSummary,
} from './types.js'
import type {
  WorkflowApprovalAction,
  WorkflowApprovalRequest,
} from './runtimeTypes.js'

export type NormalizedRetryPolicy = {
  maxAttempts: number
  backoffMs: number
  retryableExitCodes: number[]
  retryableErrorPatterns: string[]
}

export type WorkflowNodeErrorInfo = {
  message: string
  exitCode?: number
  code?: string
  retryable?: boolean
  sameInputRetrySafe?: boolean
  stdout?: string
  stderr?: string
  details?: unknown
}

export type WorkflowNodeContractValidationInfo = {
  ok: boolean
  errors?: string[]
}

export class WorkflowNodeOutputContractError extends Error {
  code = 'output_contract_failed'
  details: unknown

  constructor(
    public readonly nodeId: string,
    public readonly output: unknown,
    public readonly errors: string[],
  ) {
    super(errors.join('\n'))
    this.details = { nodeId, errors, output }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function nodeInputPayload(node: MatOSWorkflowNode): unknown {
  return node.input ?? node.toolInput ?? node.inputs ?? {}
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function actionFingerprintForNode(node: MatOSWorkflowNode): string {
  return `sha256:${createHash('sha256')
    .update(
      stableJson({
        nodeId: node.id,
        type: node.type,
        backend: node.backend,
        tool: node.tool,
        operation: node.operation,
        input: nodeInputPayload(node),
      }),
    )
    .digest('hex')}`
}

export function backendToolRef(node: MatOSWorkflowNode): string | undefined {
  if (typeof node.tool === 'string' && node.tool.trim()) {
    return node.tool.trim()
  }
  if (node.targetType === 'compute') {
    return computeToolRefForSpec(computeJobSpecForNode(node))
  }
  return undefined
}

function workflowReviewedHighRiskBypassTrusted(
  definition: MatOSWorkflowDefinition,
): boolean {
  return definition.compiled?.reviewedHighRiskBypassTrusted === true
}

/**
 * Physical lab instrument operations always require human approval. Only an
 * explicitly simulated task (`input.simulation: true` or `input.dryRun`)
 * skips the gate. There is no
 * reviewed-high-risk bypass: real-world actuation is irreversible, so the
 * strictest gate applies until per-facility SOPs define anything weaker.
 */
function isPhysicalInstrumentOperation(node: MatOSWorkflowNode): boolean {
  const semanticType =
    node.targetType ?? metadataObject(node.matosProduct).semanticType
  if (semanticType !== 'instrument') {
    return false
  }
  const input = metadataObject(nodeInputPayload(node))
  const flagTrue = (value: unknown): boolean =>
    value === true ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'true')
  return !(flagTrue(input.simulation) || flagTrue(input.dryRun))
}

export function computeLifecycleEventType(output: unknown): string {
  const operation =
    output &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    typeof (output as Record<string, unknown>).operation === 'string'
      ? String((output as Record<string, unknown>).operation)
      : ''
  switch (operation) {
    case 'submit':
      return 'workflow.compute.submitted'
    case 'status':
      return 'workflow.compute.status'
    case 'logs':
      return 'workflow.compute.logs'
    case 'cancel':
      return 'workflow.compute.cancelled'
    default:
      return 'workflow.compute.completed'
  }
}

const SECRET_FIELD_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|auth|credential)/i

function redactApprovalValue(value: unknown, key = ''): unknown {
  if (SECRET_FIELD_PATTERN.test(key)) {
    return '[redacted]'
  }
  if (Array.isArray(value)) {
    return value.map(item => redactApprovalValue(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactApprovalValue(child, childKey),
      ]),
    )
  }
  return value
}

function approvalActionForNode(node: MatOSWorkflowNode): WorkflowApprovalAction {
  return {
    nodeId: node.id,
    type: node.type,
    backend: typeof node.backend === 'string' ? node.backend : undefined,
    toolRef: backendToolRef(node),
    operation: typeof node.operation === 'string' ? node.operation : undefined,
    input: redactApprovalValue(nodeInputPayload(node)),
  }
}

export function attemptIdempotencyKeyForNode(
  runId: string,
  node: MatOSWorkflowNode,
  attempt: number,
  scope?: Record<string, unknown>,
): string {
  return `sha256:${createHash('sha256')
    .update(
      stableJson({
        runId,
        nodeId: node.id,
        attempt,
        ...(scope ? { scope } : {}),
        actionFingerprint: actionFingerprintForNode(node),
        action: {
          type: node.type,
          targetType: node.targetType,
          command: node.command,
          prompt: node.prompt,
          workflow: node.workflow,
          checks: node.checks,
          backend: node.backend,
          tool: node.tool,
          operation: node.operation,
        },
      }),
    )
    .digest('hex')}`
}

export function attemptInputForNode(
  node: MatOSWorkflowNode,
): Record<string, unknown> {
  return {
    nodeId: node.id,
    type: node.type,
    ...(node.targetType ? { targetType: node.targetType } : {}),
    ...(typeof node.backend === 'string' ? { backend: node.backend } : {}),
    ...(backendToolRef(node) ? { toolRef: backendToolRef(node) } : {}),
    ...(typeof node.operation === 'string' ? { operation: node.operation } : {}),
    input: redactApprovalValue(nodeInputPayload(node)),
  }
}

export function validationRecommendationFromNode(
  node: MatOSWorkflowNode,
  output: ValidationResult,
): ValidationResult['recommendation'] | undefined {
  if (output.ok) {
    return undefined
  }
  if (
    output.recommendation === 'retry' ||
    output.recommendation === 'reroute' ||
    output.recommendation === 'human_review' ||
    output.recommendation === 'fail'
  ) {
    return output.recommendation
  }
  const recommendation = node.recommendation
  if (
    recommendation === 'retry' ||
    recommendation === 'reroute' ||
    recommendation === 'human_review' ||
    recommendation === 'fail'
  ) {
    return recommendation
  }
  return undefined
}

function validationRetryTargetNodeId(
  node: MatOSWorkflowNode,
): string | undefined {
  const direct = node.retryNodeId ?? node.retryNode
  return typeof direct === 'string' && direct.trim().length > 0
    ? direct.trim()
    : undefined
}

export function nodeApprovalRequired(
  definition: MatOSWorkflowDefinition,
  node: MatOSWorkflowNode,
): boolean {
  // Physical instrument actuation cannot be bypassed by node policy,
  // workflow approvalMode, or reviewed-high-risk trust.
  if (isPhysicalInstrumentOperation(node)) {
    return true
  }
  if (node.policy?.approval === 'bypass') {
    return false
  }
  if (node.policy?.approval === 'ask' || node.policy?.approval === 'require') {
    return true
  }
  return (
    definition.policy.approvalMode === 'ask' ||
    definition.policy.approvalMode === 'strict'
  )
}

/**
 * Algorithm Layer wrapper around nodeApprovalRequired. With no configured
 * approval-policy strategy this returns exactly the nodeApprovalRequired
 * verdict. Custom strategies can only tighten approval; the surface clamps
 * `requireApproval` to true whenever the baseline requires it.
 */
export function nodeApprovalDecision(
  definition: MatOSWorkflowDefinition,
  node: MatOSWorkflowNode,
): boolean {
  return decideMatOSApprovalPolicy({
    baselineDecision: nodeApprovalRequired(definition, node),
    definition,
    node,
  }).decision.requireApproval
}

export async function requestNodeApproval(
  runDir: string,
  node: MatOSWorkflowNode,
): Promise<void> {
  const request: WorkflowApprovalRequest = {
    nodeId: node.id,
    status: 'pending',
    backend: typeof node.backend === 'string' ? node.backend : undefined,
    toolRef: backendToolRef(node),
    actionFingerprint: actionFingerprintForNode(node),
    action: approvalActionForNode(node),
    requestedAt: nowIso(),
  }
  await mkdir(join(runDir, 'approvals'), { recursive: true })
  await writeJson(approvalPath(runDir, node.id), request)
  await markNode(runDir, node, 'waiting_approval')
  await appendWorkflowEvent(runDir, {
    type: 'workflow.approval.requested',
    data: request,
  })
  await updateRunStatus(runDir, 'waiting_approval', {
    waitingNodeId: node.id,
  })
}

export async function markNode(
  runDir: string,
  node: MatOSWorkflowNode,
  status: MatOSWorkflowNodeStatus,
  fields: Partial<MatOSWorkflowNodeRunSnapshot> = {},
): Promise<void> {
  const current = await readNodeRun(runDir, node.id)
  await writeNodeRun(runDir, {
    nodeId: node.id,
    attempts: current?.attempts ?? 0,
    updatedAt: nowIso(),
    ...current,
    ...fields,
    status,
  })
}

export async function completeNode(
  runDir: string,
  node: MatOSWorkflowNode,
  output: unknown,
): Promise<void> {
  const current = await readNodeRun(runDir, node.id)
  await markNode(runDir, node, 'completed', {
    output,
    // Clear the error a failed earlier attempt recorded: a completed node
    // carrying a stale `error` misleads run views and agents inspecting it.
    error: undefined,
    sideEffect: attemptSideEffectForNode(node, output, current?.attempts),
  })
  await recordNodeArtifacts(runDir, node, output)
  await appendWorkflowEvent(runDir, {
    type: 'workflow.node.completed',
    data: { nodeId: node.id, output },
  })
}

export async function failNode(
  runDir: string,
  node: MatOSWorkflowNode,
  error: unknown,
  options: { failRun?: boolean } = {},
): Promise<void> {
  const failRun = options.failRun ?? true
  const errorInfo = workflowNodeErrorInfo(error)
  const message = errorInfo.message
  const current = await readNodeRun(runDir, node.id)
  await markNode(runDir, node, 'failed', {
    error: errorInfo,
    sideEffect: attemptSideEffectForNode(node, undefined, current?.attempts),
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.node.failed',
    data: {
      nodeId: node.id,
      error: message,
      feedback: workflowNodeErrorFeedback(errorInfo),
      routed: !failRun,
    },
  })
  if (failRun) {
    const run = await readWorkflowRun(runDir)
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      await updateRunStatus(runDir, 'failed')
    }
  }
}

export async function failNodeWithOutput(
  runDir: string,
  node: MatOSWorkflowNode,
  error: unknown,
  output: unknown,
  options: { failRun?: boolean } = {},
): Promise<void> {
  const failRun = options.failRun ?? true
  const errorInfo = workflowNodeErrorInfo(error)
  const message = errorInfo.message
  const current = await readNodeRun(runDir, node.id)
  await markNode(runDir, node, 'failed', {
    output,
    error: errorInfo,
    sideEffect: attemptSideEffectForNode(node, output, current?.attempts),
  })
  await recordNodeArtifacts(runDir, node, output)
  await appendWorkflowEvent(runDir, {
    type: 'workflow.node.failed',
    data: {
      nodeId: node.id,
      error: message,
      feedback: workflowNodeErrorFeedback(errorInfo),
      routed: !failRun,
    },
  })
  if (failRun) {
    const run = await readWorkflowRun(runDir)
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      await updateRunStatus(runDir, 'failed')
    }
  }
}

const ARTIFACT_PATH_KEY_PATTERN =
  /(?:^|\.)(?:artifactPath|recordPath|yamlPath|resultPath|visibleResultPath|outputPath|logPath)$/i

function outputArtifactCandidates(
  node: MatOSWorkflowNode,
  output: unknown,
  attempt: number | undefined,
  prefix = '',
): WorkflowArtifactRef[] {
  if (Array.isArray(output)) {
    return output.flatMap((item, index) =>
      outputArtifactCandidates(node, item, attempt, `${prefix}[${index}]`),
    )
  }
  if (!output || typeof output !== 'object') {
    return []
  }

  const raw = output as Record<string, unknown>
  const declaredArtifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts
        .filter(
          (item): item is WorkflowArtifactRef =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        )
        .map((artifact, index) => ({
          ...artifact,
          id: artifact.id ?? `${node.id}:artifacts[${index}]`,
          nodeId: artifact.nodeId ?? node.id,
          attempt: artifact.attempt ?? attempt,
        }))
    : []

  const pathArtifacts = Object.entries(raw).flatMap(([key, value]) => {
    const pathKey = prefix ? `${prefix}.${key}` : key
    if (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      ARTIFACT_PATH_KEY_PATTERN.test(pathKey)
    ) {
      return [
        {
          id: `${node.id}:${pathKey}`,
          nodeId: node.id,
          attempt,
          path: value,
          kind: key,
        } satisfies WorkflowArtifactRef,
      ]
    }
    return outputArtifactCandidates(node, value, attempt, pathKey)
  })

  return [...declaredArtifacts, ...pathArtifacts]
}

async function declaredArtifactContractCandidates(
  node: MatOSWorkflowNode,
  options: { runDir: string; artifactRoot: string; attempt: number | undefined },
): Promise<WorkflowArtifactRef[]> {
  const contracts = isRecord(node.artifactContract)
    ? (node.artifactContract as Record<string, WorkflowArtifactContract>)
    : {}
  const artifacts: WorkflowArtifactRef[] = []
  for (const [contractId, contract] of Object.entries(contracts)) {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
      continue
    }
    const rawPath = typeof contract.path === 'string' ? contract.path.trim() : ''
    if (!rawPath) {
      continue
    }
    const artifactPath = resolve(rawPath.startsWith('/') ? rawPath : join(options.artifactRoot, rawPath))
    if (
      !pathIsInsideRoot(artifactPath, options.artifactRoot) &&
      !pathIsInsideRoot(artifactPath, options.runDir)
    ) {
      continue
    }
    let stats
    try {
      stats = await stat(artifactPath)
    } catch {
      continue
    }
    artifacts.push({
      id: contract.id ?? contractId,
      nodeId: contract.producerNodeId ?? node.id,
      attempt: options.attempt,
      path: artifactPath,
      kind: contract.kind ?? (stats.isDirectory() ? 'directory' : 'file'),
      ...(contract.mediaType ? { mediaType: contract.mediaType } : {}),
    })
  }
  return artifacts
}

const SIDE_EFFECT_CLASSES = new Set<WorkflowAttemptSideEffectSummary['class']>([
  'none',
  'model_call',
  'local_process',
  'external_backend',
  'human_input',
  'child_workflow',
  'iteration_children',
  'graph_patch',
])

const SIDE_EFFECT_REPLAY_STRATEGIES = new Set<
  WorkflowAttemptSideEffectSummary['replayStrategy']
>([
  'rerun',
  'skip_completed',
  'reconcile_before_resubmit',
  'wait_for_human',
  'manual_review',
])

function sideEffectDeclarationRecord(
  node: MatOSWorkflowNode,
): Record<string, unknown> | undefined {
  if (isRecord(node.policy?.sideEffect)) {
    return node.policy.sideEffect
  }
  if (isRecord(node.sideEffect)) {
    return node.sideEffect
  }
  return undefined
}

function firstStringFromRecords(
  records: Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const record of records) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function workflowReceiptFromRecords(
  records: Record<string, unknown>[],
): WorkflowAttemptSideEffectSummary['receipt'] | undefined {
  const receipt = {
    backend: firstStringFromRecords(records, 'backend'),
    operation: firstStringFromRecords(records, 'operation'),
    jobId: firstStringFromRecords(records, 'jobId'),
    taskId: firstStringFromRecords(records, 'taskId'),
    status: firstStringFromRecords(records, 'status'),
  }
  return Object.values(receipt).some(value => value !== undefined)
    ? receipt
    : undefined
}

function declaredSideEffectForNode(
  node: MatOSWorkflowNode,
  outputRecords: Record<string, unknown>[],
): Partial<WorkflowAttemptSideEffectSummary> {
  const declaration = sideEffectDeclarationRecord(node)
  if (!declaration) {
    return {}
  }

  const summary: Partial<WorkflowAttemptSideEffectSummary> = {}
  if (
    typeof declaration.class === 'string' &&
    SIDE_EFFECT_CLASSES.has(
      declaration.class as WorkflowAttemptSideEffectSummary['class'],
    )
  ) {
    summary.class = declaration.class as WorkflowAttemptSideEffectSummary['class']
  }
  if (typeof declaration.replaySafe === 'boolean') {
    summary.replaySafe = declaration.replaySafe
  }
  if (
    typeof declaration.replayStrategy === 'string' &&
    SIDE_EFFECT_REPLAY_STRATEGIES.has(
      declaration.replayStrategy as WorkflowAttemptSideEffectSummary['replayStrategy'],
    )
  ) {
    summary.replayStrategy =
      declaration.replayStrategy as WorkflowAttemptSideEffectSummary['replayStrategy']
  }
  if (typeof declaration.external === 'boolean') {
    summary.external = declaration.external
  }
  if (Array.isArray(declaration.notes)) {
    const notes = declaration.notes.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    )
    if (notes.length > 0) {
      summary.notes = notes
    }
  }

  const declaredReceipt = isRecord(declaration.receipt)
    ? workflowReceiptFromRecords([declaration.receipt])
    : undefined
  const inferredReceipt = workflowReceiptFromRecords(outputRecords)
  const receipt =
    declaredReceipt || inferredReceipt
      ? {
          ...(inferredReceipt ?? {}),
          ...(declaredReceipt ?? {}),
        }
      : undefined
  if (receipt) {
    summary.receipt = receipt
  }

  if (summary.class === 'external_backend') {
    summary.external ??= true
    summary.replaySafe ??= false
    summary.replayStrategy ??= 'reconcile_before_resubmit'
  }
  if (summary.class === 'graph_patch') {
    summary.external ??= false
    summary.replaySafe ??= false
    summary.replayStrategy ??= 'manual_review'
  }
  if (summary.class === 'human_input') {
    summary.external ??= false
    summary.replaySafe ??= false
    summary.replayStrategy ??= 'wait_for_human'
  }

  return summary
}

export function attemptSideEffectForNode(
  node: MatOSWorkflowNode,
  output: unknown,
  attempt: number | undefined,
): WorkflowAttemptSideEffectSummary {
  const artifactWrites = outputArtifactCandidates(node, output, attempt).length
  const raw = isRecord(output) ? output : {}
  const payload = isRecord(raw.payload) ? raw.payload : {}
  const declared = declaredSideEffectForNode(node, [raw, payload])
  const idempotent =
    node.policy?.idempotent === true ||
    node.policy?.idempotency === 'safe' ||
    node.policy?.replaySafe === true
  const finalize = (
    summary: WorkflowAttemptSideEffectSummary,
  ): WorkflowAttemptSideEffectSummary => {
    const notes = [
      ...(summary.notes ?? []),
      ...(declared.notes ?? []),
    ]
    const receipt =
      summary.receipt || declared.receipt
        ? {
            ...(summary.receipt ?? {}),
            ...(declared.receipt ?? {}),
          }
        : undefined
    return {
      ...summary,
      ...declared,
      ...(receipt ? { receipt } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      ...(artifactWrites > 0 ? { artifactWrites } : {}),
    }
  }

  if (node.type === 'agent') {
    return finalize({
      class: 'model_call',
      replaySafe: false,
      replayStrategy: 'rerun',
      external: true,
      notes: ['Agent/model output is stochastic unless the role explicitly makes it deterministic.'],
    })
  }

  if (node.type === 'exec' || node.type === 'guard') {
    return finalize({
      class: 'local_process',
      replaySafe: idempotent,
      replayStrategy: 'rerun',
      external: false,
    })
  }

  if (node.type === 'backend') {
    const receipt = workflowReceiptFromRecords([raw, payload])
    return finalize({
      class: 'external_backend',
      replaySafe: false,
      replayStrategy: 'reconcile_before_resubmit',
      external: true,
      ...(receipt ? { receipt } : {}),
      notes: ['External backend work must be reconciled before resubmission.'],
    })
  }

  if (node.type === 'human') {
    return finalize({
      class: 'human_input',
      replaySafe: false,
      replayStrategy: 'wait_for_human',
      external: false,
    })
  }

  if (node.type === 'subworkflow') {
    return finalize({
      class: 'child_workflow',
      replaySafe: true,
      replayStrategy: 'skip_completed',
      childRuns: typeof raw.childRunId === 'string' ? 1 : 0,
      external: false,
    })
  }

  if (node.type === 'map' || node.type === 'loop') {
    const childRuns = Array.isArray(raw.iterations)
      ? raw.iterations.filter(item => isRecord(item) && typeof item.childRunId === 'string')
          .length
      : typeof raw.count === 'number'
        ? raw.count
        : 0
    return finalize({
      class: 'iteration_children',
      replaySafe: true,
      replayStrategy: 'skip_completed',
      childRuns,
      external: false,
    })
  }

  if (node.type === 'dynamic') {
    return finalize({
      class: 'graph_patch',
      replaySafe: false,
      replayStrategy: 'manual_review',
      graphSnapshot:
        typeof raw.graphSnapshotPath === 'string' ||
        typeof raw.graphHash === 'string',
      external: false,
    })
  }

  return finalize({
    class: 'none',
    replaySafe: true,
    replayStrategy: 'rerun',
    external: false,
  })
}

/**
 * Verified content facts for a re-registered artifact file. Streaming hash so
 * multi-GB scientific outputs do not load into the orchestrator heap; only
 * called on retry re-registrations, never on first registration.
 */
async function artifactFileContentFacts(
  path: string,
): Promise<{ sha256: string; sizeBytes: number } | undefined> {
  try {
    const stats = await stat(path)
    if (!stats.isFile()) {
      return undefined
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer)
    }
    return { sha256: hash.digest('hex'), sizeBytes: stats.size }
  } catch {
    return undefined
  }
}

function definedArtifactFields(
  artifact: WorkflowArtifactRef,
): WorkflowArtifactRef {
  return Object.fromEntries(
    Object.entries(artifact).filter(([, value]) => value !== undefined),
  ) as WorkflowArtifactRef
}

async function recordNodeArtifacts(
  runDir: string,
  node: MatOSWorkflowNode,
  output: unknown,
): Promise<void> {
  const current = await readNodeRun(runDir, node.id)
  const run = await readWorkflowRun(runDir).catch(() => undefined)
  const artifactRoot = run?.artifactRoot ?? join(runDir, 'artifacts-root')
  const candidates = [
    ...outputArtifactCandidates(node, output, current?.attempts),
    ...(await declaredArtifactContractCandidates(node, {
      runDir,
      artifactRoot,
      attempt: current?.attempts,
    })),
  ]
  if (candidates.length === 0) {
    return
  }

  // Serialize the read-modify-write of the shared run artifacts file per run so
  // the parallel scheduler batch (multiple nodes completing at once in one
  // process) cannot clobber each other's appended artifacts.
  const { created, updated } = await withKeyedMutex(
    `artifacts:${runDir}`,
    async () => {
      const entries = await readWorkflowArtifacts(runDir)
      const indexByKey = new Map<string, number>()
      const rememberIndex = (
        artifact: WorkflowArtifactRef,
        index: number,
      ): void => {
        if (artifact.id) {
          indexByKey.set(`id:${artifact.id}`, index)
        }
        if (artifact.path) {
          indexByKey.set(`path:${resolve(artifact.path)}`, index)
        }
      }
      entries.forEach((artifact, index) => rememberIndex(artifact, index))
      const created: WorkflowArtifactRef[] = []
      const updated: Array<{
        artifact: WorkflowArtifactRef
        previousAttempt?: number
      }> = []
      for (const candidate of candidates) {
        const idKey = candidate.id ? `id:${candidate.id}` : undefined
        const pathKey = candidate.path
          ? `path:${resolve(candidate.path)}`
          : undefined
        if (!idKey && !pathKey) {
          continue
        }
        const existingIndex =
          (idKey ? indexByKey.get(idKey) : undefined) ??
          (pathKey ? indexByKey.get(pathKey) : undefined)
        if (existingIndex === undefined) {
          rememberIndex(candidate, entries.length)
          entries.push(candidate)
          created.push(candidate)
          continue
        }
        // Re-registration of an already-known artifact. When a later attempt
        // re-produced it (node retry / upstream reset), the file now holds
        // that attempt's bytes, so keeping the original attribution would
        // make artifacts.json lie about provenance. Re-attribute to the
        // producing attempt and refresh content facts from the bytes on
        // disk; a hash recorded for overwritten content must never survive.
        const existing = entries[existingIndex]!
        const sameProducer =
          candidate.attempt === undefined ||
          (existing.attempt === candidate.attempt &&
            (existing.nodeId ?? candidate.nodeId) === candidate.nodeId)
        if (sameProducer) {
          continue
        }
        const merged: WorkflowArtifactRef = {
          ...existing,
          ...definedArtifactFields(candidate),
        }
        const facts = merged.path
          ? await artifactFileContentFacts(resolve(merged.path))
          : undefined
        if (facts) {
          merged.sha256 = facts.sha256
          merged.sizeBytes = facts.sizeBytes
        } else {
          delete merged.sha256
          delete merged.sizeBytes
        }
        entries[existingIndex] = merged
        rememberIndex(merged, existingIndex)
        updated.push({ artifact: merged, previousAttempt: existing.attempt })
      }
      if (created.length > 0 || updated.length > 0) {
        await writeWorkflowArtifacts(runDir, entries)
      }
      return { created, updated }
    },
  )
  for (const artifact of created) {
    await appendWorkflowEvent(runDir, {
      type: 'workflow.artifact.created',
      data: artifact,
    })
  }
  // The event log stays append-only: the original workflow.artifact.created
  // record is never rewritten; re-attribution appends an updated event.
  for (const entry of updated) {
    await appendWorkflowEvent(runDir, {
      type: 'workflow.artifact.updated',
      data: {
        ...entry.artifact,
        ...(entry.previousAttempt !== undefined
          ? { previousAttempt: entry.previousAttempt }
          : {}),
      },
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedNumberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is number => Number.isInteger(item) && item >= 0,
      )
    : []
}

function normalizedStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    : []
}

const ERROR_STREAM_SNIPPET_MAX = 2000

function errorStreamSnippet(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = scrubSecretsFromString(value.trim())
  if (!trimmed) {
    return undefined
  }
  return trimmed.length <= ERROR_STREAM_SNIPPET_MAX
    ? trimmed
    : `${trimmed.slice(0, ERROR_STREAM_SNIPPET_MAX)}...`
}

export function retryPolicyForNode(
  node: MatOSWorkflowNode,
): NormalizedRetryPolicy | undefined {
  const retry = node.policy?.retry
  if (!isRecord(retry)) {
    return undefined
  }

  const maxAttempts =
    Number.isInteger(retry.maxAttempts) && Number(retry.maxAttempts) >= 1
      ? Number(retry.maxAttempts)
      : 1
  if (maxAttempts <= 1) {
    return undefined
  }

  const backoffMs =
    typeof retry.backoffMs === 'number' &&
    Number.isFinite(retry.backoffMs) &&
    retry.backoffMs > 0
      ? retry.backoffMs
      : 0

  return {
    maxAttempts,
    backoffMs,
    retryableExitCodes: normalizedNumberList(retry.retryableExitCodes),
    retryableErrorPatterns: normalizedStringList(retry.retryableErrorPatterns),
  }
}

export function workflowNodeErrorInfo(error: unknown): WorkflowNodeErrorInfo {
  const message = scrubSecretsFromString(
    error instanceof Error ? error.message : String(error),
  )
  if (!isRecord(error)) {
    return { message }
  }
  const details = error.details
  const code = errorStreamSnippet(error.code)
  const retryable =
    typeof error.retryable === 'boolean'
      ? error.retryable
      : isRecord(details) && typeof details.retryable === 'boolean'
        ? details.retryable
        : undefined
  const sameInputRetrySafe =
    typeof error.sameInputRetrySafe === 'boolean'
      ? error.sameInputRetrySafe
      : isRecord(details) && typeof details.sameInputRetrySafe === 'boolean'
        ? details.sameInputRetrySafe
        : undefined
  return {
    message,
    ...(typeof error.exitCode === 'number' ? { exitCode: error.exitCode } : {}),
    ...(code ? { code } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(sameInputRetrySafe !== undefined ? { sameInputRetrySafe } : {}),
    ...(errorStreamSnippet(error.stdout)
      ? { stdout: errorStreamSnippet(error.stdout) }
      : {}),
    ...(errorStreamSnippet(error.stderr)
      ? { stderr: errorStreamSnippet(error.stderr) }
      : {}),
    ...(error.details !== undefined
      ? { details: redactTraceValue(error.details) }
      : {}),
  }
}

const ERROR_FEEDBACK_TEXT_MAX = 1000

function errorFeedbackText(value: unknown): string | undefined {
  const raw = optionalText(value)
  const text = raw ? scrubSecretsFromString(raw) : undefined
  if (!text) {
    return undefined
  }
  return text.length <= ERROR_FEEDBACK_TEXT_MAX
    ? text
    : `${text.slice(0, ERROR_FEEDBACK_TEXT_MAX)}...`
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function failedCheckFeedback(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const feedback: Record<string, unknown> = {}
  for (const key of [
    'id',
    'type',
    'code',
    'message',
    'hint',
    'error',
    'sourceNodeId',
  ] as const) {
    const text = errorFeedbackText(value[key])
    if (text) {
      feedback[key] = text
    }
  }
  if (typeof value.retryable === 'boolean') {
    feedback.retryable = value.retryable
  }
  return Object.keys(feedback).length > 0 ? feedback : undefined
}

function workflowValidationFeedback(
  validation: ValidationResult,
  recommendation: ValidationResult['recommendation'] = validation.recommendation,
): Record<string, unknown> {
  return {
    recommendation,
    severity: validation.severity,
    failedChecks: validation.checks
      .filter(check => !check.ok)
      .slice(0, 50)
      .map(check => failedCheckFeedback(check))
      .filter((check): check is Record<string, unknown> => Boolean(check)),
  }
}

/**
 * Produce a push/event-safe failure summary. Full stdout, observed values, and
 * arbitrary details stay in the node snapshot; events carry only whitelisted,
 * bounded fields that a UI or loop agent can act on immediately.
 */
export function workflowNodeErrorFeedback(
  error: WorkflowNodeErrorInfo,
): Record<string, unknown> {
  const feedback: Record<string, unknown> = {}
  const code = errorFeedbackText(error.code)
  if (code) {
    feedback.code = code
  }
  if (error.exitCode !== undefined) {
    feedback.exitCode = error.exitCode
  }
  if (typeof error.retryable === 'boolean') {
    feedback.retryable = error.retryable
  }
  if (!isRecord(error.details)) {
    return feedback
  }
  for (const key of [
    'category',
    'signatureId',
    'source',
    'causeCode',
    'cwd',
    'signal',
    'hint',
    'action',
    'recommendation',
    'severity',
  ] as const) {
    const text = errorFeedbackText(error.details[key])
    if (text) {
      feedback[key] = text
    }
  }
  for (const key of [
    'repairable',
    'suppressedFailure',
    'detectedWhileRunning',
    'cwdExists',
    'cwdIsDirectory',
    'sameInputRetrySafe',
  ] as const) {
    if (typeof error.details[key] === 'boolean') {
      feedback[key] = error.details[key]
    }
  }
  if (
    typeof error.details.timeoutMs === 'number' &&
    Number.isFinite(error.details.timeoutMs)
  ) {
    feedback.timeoutMs = error.details.timeoutMs
  }
  if (Array.isArray(error.details.failedChecks)) {
    feedback.failedChecks = error.details.failedChecks
      .slice(0, 50)
      .map(check => failedCheckFeedback(check))
      .filter((check): check is Record<string, unknown> => Boolean(check))
  }
  return feedback
}

export function assertWorkflowNodeOutputContract(
  node: MatOSWorkflowNode,
  output: unknown,
): WorkflowNodeContractValidationInfo {
  const contract = validateWorkflowNodeOutputContract(node, output)
  if (!contract.ok) {
    throw new WorkflowNodeOutputContractError(node.id, output, contract.errors)
  }
  return { ok: true }
}

function errorMatchesPattern(message: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(message)
  } catch {
    return message.includes(pattern)
  }
}

export function isRetryableNodeError(
  policy: NormalizedRetryPolicy,
  error: WorkflowNodeErrorInfo,
): boolean {
  // A hard "not replay-safe" verdict vetoes blind retries. A positive hint does
  // not bypass explicit policy allowlists: operators still control which
  // exit codes or error classes may be replayed unchanged.
  if (error.retryable === false) {
    return false
  }
  const hasExitCodeFilter = policy.retryableExitCodes.length > 0
  const hasPatternFilter = policy.retryableErrorPatterns.length > 0
  if (!hasExitCodeFilter && !hasPatternFilter) {
    return error.sameInputRetrySafe === false ? false : (error.retryable ?? true)
  }
  if (
    error.exitCode !== undefined &&
    policy.retryableExitCodes.includes(error.exitCode)
  ) {
    return true
  }
  const details = isRecord(error.details) ? error.details : undefined
  const patternText = [
    error.message,
    error.code,
    optionalText(details?.category),
    optionalText(details?.signatureId),
    optionalText(details?.action),
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
  return policy.retryableErrorPatterns.some(pattern =>
    errorMatchesPattern(patternText, pattern),
  )
}

/**
 * Marks the node pending for its next attempt and waits out the retry
 * backoff. The wait observes the run's cooperative control marker; when a
 * cancel/pause request arrives (or is already set), the observed action is
 * returned so the caller stops retrying and yields to the scheduler loop,
 * which applies the control action at its boundary.
 */
export async function scheduleNodeRetry(input: {
  runDir: string
  node: MatOSWorkflowNode
  attempt: number
  policy: NormalizedRetryPolicy
  error: WorkflowNodeErrorInfo
}): Promise<WorkflowRunControlAction | undefined> {
  await markNode(input.runDir, input.node, 'pending', {
    attempts: input.attempt,
    error: input.error,
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.node.retry_scheduled',
    data: {
      nodeId: input.node.id,
      attempt: input.attempt,
      nextAttempt: input.attempt + 1,
      maxAttempts: input.policy.maxAttempts,
      backoffMs: input.policy.backoffMs,
      error: input.error.message,
      exitCode: input.error.exitCode,
      feedback: workflowNodeErrorFeedback(input.error),
    },
  })
  return waitWorkflowRunBackoff(input.runDir, input.policy.backoffMs)
}

export function hasFailureRouteFromNode(
  definition: MatOSWorkflowDefinition,
  nodeId: string,
): boolean {
  return (
    (definition.edges ?? []).some(
      edge =>
        edge.from === nodeId &&
        (edge.route === 'failure' || edge.route === 'always'),
    ) ||
    (definition.transitions ?? []).some(
      transition =>
        transition.from === nodeId &&
        (transition.route === 'failure' || transition.route === 'always'),
    )
  )
}

function hasConditionalRouteFromNode(
  definition: MatOSWorkflowDefinition,
  nodeId: string,
): boolean {
  return (
    (definition.edges ?? []).some(
      edge =>
        edge.from === nodeId &&
        typeof edge.condition === 'string' &&
        edge.condition.trim().length > 0,
    ) ||
    (definition.transitions ?? []).some(
      transition =>
        transition.from === nodeId &&
        typeof transition.guard === 'string' &&
        transition.guard.trim().length > 0,
    )
  )
}

export async function handleValidationRecommendation(input: {
  runDir: string
  node: MatOSWorkflowNode
  output: ValidationResult
  attempt: number
  startedAt: string
  idempotencyKey: string
  definition: MatOSWorkflowDefinition
  recommendationOverride?: ValidationResult['recommendation']
}): Promise<'continue' | 'waiting' | 'failed'> {
  const recommendation =
    input.recommendationOverride ??
    validationRecommendationFromNode(input.node, input.output)
  if (!recommendation) {
    await writeNodeAttempt({
      runDir: input.runDir,
      nodeId: input.node.id,
      attempt: input.attempt,
      status: 'completed',
      startedAt: input.startedAt,
      finishedAt: nowIso(),
      idempotencyKey: input.idempotencyKey,
      output: input.output,
      contractValidation: assertWorkflowNodeOutputContract(input.node, input.output),
      sideEffect: attemptSideEffectForNode(input.node, input.output, input.attempt),
    })
    await completeNode(input.runDir, input.node, input.output)
    return 'continue'
  }

  const feedback = workflowValidationFeedback(input.output, recommendation)

  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.validation.decision',
    data: {
      nodeId: input.node.id,
      recommendation,
      ok: input.output.ok,
      severity: input.output.severity,
      feedback,
    },
  })

  const conditionalFailureRoute =
    recommendation === 'fail' &&
    input.node.targetType === 'validate' &&
    hasConditionalRouteFromNode(input.definition, input.node.id)

  if (recommendation === 'reroute' || conditionalFailureRoute) {
    await writeNodeAttempt({
      runDir: input.runDir,
      nodeId: input.node.id,
      attempt: input.attempt,
      status: 'completed',
      startedAt: input.startedAt,
      finishedAt: nowIso(),
      idempotencyKey: input.idempotencyKey,
      output: input.output,
      contractValidation: assertWorkflowNodeOutputContract(input.node, input.output),
      sideEffect: attemptSideEffectForNode(input.node, input.output, input.attempt),
    })
    await completeNode(input.runDir, input.node, input.output)
    await appendWorkflowEvent(input.runDir, {
      type: conditionalFailureRoute
        ? 'workflow.validation.failure_routed'
        : 'workflow.validation.reroute_requested',
      data: { nodeId: input.node.id, recommendation, feedback },
    })
    return 'continue'
  }

  if (recommendation === 'human_review') {
    await writeNodeAttempt({
      runDir: input.runDir,
      nodeId: input.node.id,
      attempt: input.attempt,
      status: 'waiting_input',
      startedAt: input.startedAt,
      finishedAt: nowIso(),
      idempotencyKey: input.idempotencyKey,
      output: input.output,
      contractValidation: assertWorkflowNodeOutputContract(input.node, input.output),
      sideEffect: attemptSideEffectForNode(input.node, input.output, input.attempt),
    })
    await writeWorkflowHumanPrompt(input.runDir, input.node)
    await markNode(input.runDir, input.node, 'waiting_input', {
      output: input.output,
      startedAt: input.startedAt,
      idempotencyKey: input.idempotencyKey,
    })
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.validation.human_review_requested',
      data: { nodeId: input.node.id, output: input.output },
    })
    await updateRunStatus(input.runDir, 'waiting_input', {
      waitingNodeId: input.node.id,
    })
    return 'waiting'
  }

  if (recommendation === 'retry') {
    const retryTarget = validationRetryTargetNodeId(input.node)
    const retryPolicy = retryPolicyForNode(input.node)
    if (retryTarget && retryPolicy && input.attempt < retryPolicy.maxAttempts) {
      await writeNodeAttempt({
        runDir: input.runDir,
        nodeId: input.node.id,
        attempt: input.attempt,
        status: 'completed',
        startedAt: input.startedAt,
        finishedAt: nowIso(),
        idempotencyKey: input.idempotencyKey,
        output: input.output,
        contractValidation: assertWorkflowNodeOutputContract(input.node, input.output),
        sideEffect: attemptSideEffectForNode(input.node, input.output, input.attempt),
      })
      const resetIds = [
        retryTarget,
        ...downstreamWorkflowNodeIds(input.definition, retryTarget),
      ]
      for (const resetId of resetIds) {
        await resetNodeRun(input.runDir, resetId)
      }
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.validation.retry_requested',
        data: {
          nodeId: input.node.id,
          retryNodeId: retryTarget,
          attempt: input.attempt,
          nextAttempt: input.attempt + 1,
          maxAttempts: retryPolicy.maxAttempts,
          feedback,
        },
      })
      if (retryPolicy.backoffMs > 0) {
        // Control-marker aware: the scheduler loop applies any cancel/pause
        // observed during the backoff at its next boundary.
        await waitWorkflowRunBackoff(input.runDir, retryPolicy.backoffMs)
      }
      return 'continue'
    }
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.validation.retry_exhausted',
      data: {
        nodeId: input.node.id,
        retryNodeId: retryTarget,
        attempt: input.attempt,
        maxAttempts: retryPolicy?.maxAttempts ?? 1,
        feedback,
      },
    })
  }

  const validationError = new WorkflowValidationFailureError(
    input.node.id,
    input.output,
    recommendation,
  )

  await writeNodeAttempt({
    runDir: input.runDir,
    nodeId: input.node.id,
    attempt: input.attempt,
    status: 'failed',
    startedAt: input.startedAt,
    finishedAt: nowIso(),
    idempotencyKey: input.idempotencyKey,
    output: input.output,
    contractValidation: assertWorkflowNodeOutputContract(input.node, input.output),
    sideEffect: attemptSideEffectForNode(input.node, input.output, input.attempt),
    error: workflowNodeErrorInfo(validationError),
  })
  const routedFailure = hasFailureRouteFromNode(input.definition, input.node.id)
  await failNodeWithOutput(
    input.runDir,
    input.node,
    validationError,
    input.output,
    { failRun: !routedFailure },
  )
  return routedFailure ? 'continue' : 'failed'
}
