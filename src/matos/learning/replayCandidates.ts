import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'
import {
  assertPathStaysUnderRoot,
  assertSafeEvolutionRecordId,
} from './evolutionRecordPaths.js'
import {
  redactedWorkflowEvidenceText,
  type MatOSWorkflowEvidence,
} from './workflowEvidence.js'

/**
 * Deterministic self-evolution replay candidates.
 *
 * A replay candidate turns one failed or recovered workflow run into a small
 * durable evidence bundle that later evolution stages, operators, and
 * benchmark tooling can replay without re-reading raw transcripts:
 *
 *   .matos/evolution/replay-candidates/<candidate-id>/
 *     candidate.json           index + provenance refs + verification state
 *     failure_signature.json   workflowRef + failed-node fingerprint
 *     repair_strategy.json     recovery classification/action evidence
 *     replay_plan.json         redacted parameters + replay expectations
 *     benchmark/case.json      workflow-run benchmark draft (secret-scan gated)
 *     benchmark/result.json    replay verification outcome (when verified)
 *
 * Repeated failures with the same workflowRef + failure signature cluster
 * into `.matos/evolution/replay-clusters/<cluster-id>/cluster.json`, and a
 * reproduced cluster materializes a promotion-gated record under
 * `.matos/evolution/stable-improvement-candidates/<id>/candidate.json`.
 *
 * Generation is deterministic and LLM-free; it must never block workflow
 * completion and must never copy secret values into the bundle.
 */

export type MatOSWorkflowReplayTrigger =
  | 'workflow-failed'
  | 'workflow-recovered'
  | 'node-failed'

export type MatOSWorkflowReplayVerificationStatus =
  | 'pending'
  | 'reproduced'
  | 'not-reproduced'
  | 'skipped-unsafe'
  | 'error'

export type MatOSWorkflowReplayVerification = {
  status: MatOSWorkflowReplayVerificationStatus
  verifiedAt?: string
  replayRunId?: string
  replayRunStatus?: string
  signatureMatch?: boolean
  reason?: string
}

export type MatOSWorkflowReplayCandidate = {
  schemaVersion: 1
  candidateId: string
  status: 'draft'
  trigger: MatOSWorkflowReplayTrigger
  workflowRef: string
  runId: string
  runStatus: string
  evidenceId: string
  failedNodeIds: string[]
  failureSignature: string
  benchmarkCaseId: string
  provenance: {
    evidenceRef: string
    runRef: string
    traceId?: string
    sourceRefs: string[]
  }
  files: {
    candidate: string
    failureSignature: string
    repairStrategy: string
    replayPlan: string
    benchmarkCase: string
  }
  verification?: MatOSWorkflowReplayVerification
  createdAt: string
  updatedAt: string
  path?: string
}

export type MatOSWorkflowReplayCluster = {
  schemaVersion: 1
  clusterId: string
  status: 'open'
  workflowRef: string
  failureSignature: string
  occurrences: number
  candidateIds: string[]
  runIds: string[]
  firstSeenAt: string
  lastSeenAt: string
  proposal: {
    kind: 'repeated-failure'
    summary: string
    suggestedTargets: Array<'workflow' | 'skill' | 'knowledge' | 'tool' | 'mcp'>
  }
  path?: string
}

export type MatOSStableImprovementCandidate = {
  schemaVersion: 1
  id: string
  status: 'awaiting-promotion'
  workflowRef: string
  failureSignature: string
  clusterRef: string
  draftRefs: {
    replayCandidateIds: string[]
  }
  evidence: {
    reproducedRunIds: string[]
    workflowEvidenceRefs: string[]
  }
  gates: {
    promotion: {
      status: 'blocked'
      reason: string
    }
  }
  createdAt: string
  updatedAt: string
  path?: string
}

const SECRET_KEY_PATTERN =
  /(?:token|secret|password|passwd|credential|api[-_]?key|auth)/i
const MAX_SOURCE_REFS = 24

function nowIso(): string {
  return new Date().toISOString()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function replayCandidatesDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'replay-candidates')
}

function candidateDir(cwd: string, candidateId: string): string {
  const safeId = assertSafeEvolutionRecordId(candidateId, 'replay candidate id')
  return assertPathStaysUnderRoot(
    replayCandidatesDir(cwd),
    join(replayCandidatesDir(cwd), safeId),
  )
}

export function replayCandidateIdForRun(runId: string): string {
  const sanitized = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `replay-${sanitized || 'run'}`
}

export function redactReplayValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactedWorkflowEvidenceText(value)
  }
  if (Array.isArray(value)) {
    return value.map(item => redactReplayValue(item))
  }
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key)
        ? '[redacted]'
        : redactReplayValue(item)
    }
    return redacted
  }
  return value
}

const REPLAY_WAITING_RUN_STATUSES = new Set([
  'waiting_input',
  'waiting_approval',
  'paused',
  'running',
])

function replayTriggerFor(
  evidence: MatOSWorkflowEvidence,
  failedNodeIds: string[],
): MatOSWorkflowReplayTrigger | undefined {
  if (evidence.status === 'failed' || evidence.status === 'cancelled') {
    return 'workflow-failed'
  }
  // A run still in flight (running/paused) or waiting on a human is not a
  // terminal failure incident. This check must run BEFORE the failed-node branch
  // so transient node errors in an active run do not become replay candidates
  // (partial/flaky evidence) until the run reaches a terminal state.
  if (REPLAY_WAITING_RUN_STATUSES.has(evidence.status)) {
    return undefined
  }
  if (failedNodeIds.length > 0) {
    return evidence.status === 'completed' ? 'workflow-recovered' : 'node-failed'
  }
  if (evidence.recovery && evidence.recovery.recommendedAction !== 'none') {
    return 'node-failed'
  }
  return undefined
}

function failureSignatureHash(
  evidence: MatOSWorkflowEvidence,
  failedNodeIds: string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workflowRef: evidence.workflowRef,
        runStatus: evidence.status,
        failedNodeIds: [...failedNodeIds].sort(),
        recovery: evidence.recovery?.classification ?? 'none',
      }),
    )
    .digest('hex')
}

async function runParametersFor(
  runDir: string | undefined,
): Promise<Record<string, unknown>> {
  if (!runDir) {
    return {}
  }
  try {
    const run = await readJson<Record<string, unknown>>(join(runDir, 'run.json'))
    const parameters = run.parameters
    if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
      return redactReplayValue(parameters) as Record<string, unknown>
    }
  } catch {
    // Missing run.json is acceptable; the replay plan keeps empty parameters.
  }
  return {}
}

export type GenerateReplayCandidateInput = {
  cwd: string
  evidence: MatOSWorkflowEvidence
  runDir?: string
}

export async function generateMatOSWorkflowReplayCandidate(
  input: GenerateReplayCandidateInput,
): Promise<MatOSWorkflowReplayCandidate | undefined> {
  const evidence = input.evidence
  const failedNodeIds = evidence.nodeSummary
    .filter(node => node.status === 'failed' || node.hasError)
    .map(node => node.nodeId)
    .sort()
  const trigger = replayTriggerFor(evidence, failedNodeIds)
  if (!trigger) {
    return undefined
  }

  const candidateId = replayCandidateIdForRun(evidence.runId)
  const dir = candidateDir(input.cwd, candidateId)
  await mkdir(join(dir, 'benchmark'), { recursive: true })

  const existing = await readMatOSWorkflowReplayCandidate(
    input.cwd,
    candidateId,
  ).catch(() => undefined)
  const createdAt = existing?.createdAt ?? nowIso()
  const signature = failureSignatureHash(evidence, failedNodeIds)
  const benchmarkCaseId = candidateId

  const files = {
    candidate: 'candidate.json',
    failureSignature: 'failure_signature.json',
    repairStrategy: 'repair_strategy.json',
    replayPlan: 'replay_plan.json',
    benchmarkCase: 'benchmark/case.json',
  }

  await writeJson(join(dir, files.failureSignature), {
    schemaVersion: 1,
    workflowRef: evidence.workflowRef,
    runId: evidence.runId,
    runStatus: evidence.status,
    failedNodes: evidence.nodeSummary.filter(
      node => node.status === 'failed' || node.hasError,
    ),
    eventTypes: evidence.eventTypes,
    signature,
  })

  await writeJson(join(dir, files.repairStrategy), {
    schemaVersion: 1,
    classification: evidence.recovery?.classification ?? 'unknown',
    recommendedAction: evidence.recovery?.recommendedAction ?? 'none',
    ...(evidence.recovery?.nodeId ? { nodeId: evidence.recovery.nodeId } : {}),
    reason: redactedWorkflowEvidenceText(evidence.recovery?.reason ?? ''),
    recovered: trigger === 'workflow-recovered',
  })

  const parameters = await runParametersFor(input.runDir)
  await writeJson(join(dir, files.replayPlan), {
    schemaVersion: 1,
    workflowRef: evidence.workflowRef,
    execution: 'local',
    parameters,
    expect: {
      reproducesFailureSignature: signature,
      failedNodeIds,
    },
    benchmarkCasePath: files.benchmarkCase,
    notes: [
      'Deterministic replay draft generated from workflow evidence.',
      'Review parameters before running; secret-looking values were redacted.',
    ],
  })

  await writeJson(join(dir, files.benchmarkCase), {
    schemaVersion: 2,
    id: benchmarkCaseId,
    kind: 'workflow-run',
    subjectRefs: [evidence.workflowRef],
    task: {
      workflowRef: evidence.workflowRef,
      input: parameters,
    },
    checks: [{ type: 'secret-scan', allow: false }],
    costRisk: 'standard',
    approvalPolicy: 'bypass-safe',
    timeoutMs: 600_000,
    provenance: {
      evidenceRef: `workflow-evidence:${evidence.evidenceId}`,
      runRef: `workflow-run:${evidence.runId}`,
      failureSignature: signature,
    },
  })

  const candidate: MatOSWorkflowReplayCandidate = {
    schemaVersion: 1,
    candidateId,
    status: 'draft',
    trigger,
    workflowRef: evidence.workflowRef,
    runId: evidence.runId,
    runStatus: evidence.status,
    evidenceId: evidence.evidenceId,
    failedNodeIds,
    failureSignature: signature,
    benchmarkCaseId,
    provenance: {
      evidenceRef: `workflow-evidence:${evidence.evidenceId}`,
      runRef: `workflow-run:${evidence.runId}`,
      ...(evidence.traceId ? { traceId: evidence.traceId } : {}),
      sourceRefs: evidence.sourceRefs.slice(0, MAX_SOURCE_REFS),
    },
    files,
    // Preserve prior verification state when the failure signature is unchanged
    // so regenerating a candidate from fresh evidence does not wipe an existing
    // reproduced / skipped-unsafe / error verification result.
    ...(existing?.verification && existing.failureSignature === signature
      ? { verification: existing.verification }
      : {}),
    createdAt,
    updatedAt: nowIso(),
  }
  await writeJson(join(dir, files.candidate), candidate)
  return { ...candidate, path: join(dir, files.candidate) }
}

export async function readMatOSWorkflowReplayCandidate(
  cwd: string,
  candidateId: string,
): Promise<MatOSWorkflowReplayCandidate | undefined> {
  const path = join(candidateDir(cwd, candidateId), 'candidate.json')
  if (!(await pathExists(path))) {
    return undefined
  }
  return { ...(await readJson<MatOSWorkflowReplayCandidate>(path)), path }
}

export async function listMatOSWorkflowReplayCandidates(
  cwd: string,
): Promise<MatOSWorkflowReplayCandidate[]> {
  const dir = replayCandidatesDir(cwd)
  if (!(await pathExists(dir))) {
    return []
  }
  const candidates: MatOSWorkflowReplayCandidate[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const candidate = await readMatOSWorkflowReplayCandidate(cwd, entry.name).catch(
      () => undefined,
    )
    if (candidate) {
      candidates.push(candidate)
    }
  }
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function replayClustersDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'replay-clusters')
}

function improvementCandidatesDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'stable-improvement-candidates')
}

export function replayClusterIdForSignature(signature: string): string {
  return `cluster-${signature.slice(0, 16)}`
}

export function stableImprovementIdForSignature(signature: string): string {
  return `stable-improvement-${signature.slice(0, 16)}`
}

async function writeCandidateUpdate(
  cwd: string,
  candidate: MatOSWorkflowReplayCandidate,
): Promise<MatOSWorkflowReplayCandidate> {
  const dir = candidateDir(cwd, candidate.candidateId)
  const updated: MatOSWorkflowReplayCandidate = {
    ...candidate,
    updatedAt: nowIso(),
  }
  delete updated.path
  await writeJson(join(dir, 'candidate.json'), updated)
  return { ...updated, path: join(dir, 'candidate.json') }
}

/**
 * Repeated-failure clustering: two or more replay candidates from different
 * runs that share a workflowRef + failure signature form a durable cluster
 * record. The second matching incident creates the cluster; later incidents
 * update occurrence counts. Deterministic and LLM-free.
 */
export async function maintainMatOSWorkflowReplayClusters(
  cwd: string,
): Promise<MatOSWorkflowReplayCluster[]> {
  const candidates = await listMatOSWorkflowReplayCandidates(cwd)
  const groups = new Map<string, MatOSWorkflowReplayCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.workflowRef}::${candidate.failureSignature}`
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  }

  const clusters: MatOSWorkflowReplayCluster[] = []
  const activeClusterIds = new Set<string>()
  for (const group of groups.values()) {
    const runIds = [...new Set(group.map(candidate => candidate.runId))].sort()
    if (runIds.length < 2) {
      continue
    }
    const sorted = [...group].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )
    const first = sorted[0]
    if (!first) {
      continue
    }
    const clusterId = replayClusterIdForSignature(first.failureSignature)
    activeClusterIds.add(clusterId)
    const dir = join(replayClustersDir(cwd), clusterId)
    await mkdir(dir, { recursive: true })
    const cluster: MatOSWorkflowReplayCluster = {
      schemaVersion: 1,
      clusterId,
      status: 'open',
      workflowRef: first.workflowRef,
      failureSignature: first.failureSignature,
      occurrences: runIds.length,
      candidateIds: sorted.map(candidate => candidate.candidateId),
      runIds,
      firstSeenAt: first.createdAt,
      lastSeenAt: sorted[sorted.length - 1]?.createdAt ?? first.createdAt,
      proposal: {
        kind: 'repeated-failure',
        summary:
          `Workflow ${first.workflowRef} failed ${runIds.length} times with the same ` +
          `failure signature (nodes: ${first.failedNodeIds.join(', ') || 'unknown'}). ` +
          'Review the replay plan and consider a workflow, skill, tool, MCP, or knowledge fix.',
        suggestedTargets: ['workflow', 'skill', 'knowledge', 'tool', 'mcp'],
      },
    }
    await writeJson(join(dir, 'cluster.json'), cluster)
    clusters.push({ ...cluster, path: join(dir, 'cluster.json') })
  }
  // Prune cluster dirs whose group fell below the 2-run threshold (e.g. source
  // candidates were removed). Otherwise stale cluster.json files keep showing
  // phantom "repeated failures" in listings and stable-improvement scans.
  const clusterRoot = replayClustersDir(cwd)
  for (const entry of await readdir(clusterRoot, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!entry.isDirectory() || activeClusterIds.has(entry.name)) {
      continue
    }
    await rm(join(clusterRoot, entry.name), {
      recursive: true,
      force: true,
    }).catch(() => {})
  }
  return clusters
}

export async function listMatOSWorkflowReplayClusters(
  cwd: string,
): Promise<MatOSWorkflowReplayCluster[]> {
  const dir = replayClustersDir(cwd)
  if (!(await pathExists(dir))) {
    return []
  }
  const clusters: MatOSWorkflowReplayCluster[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    try {
      const path = join(dir, entry.name, 'cluster.json')
      clusters.push({
        ...(await readJson<MatOSWorkflowReplayCluster>(path)),
        path,
      })
    } catch {
      continue
    }
  }
  return clusters.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

export async function readMatOSWorkflowReplayCluster(
  cwd: string,
  clusterId: string,
): Promise<MatOSWorkflowReplayCluster | undefined> {
  const safeId = assertSafeEvolutionRecordId(clusterId, 'replay cluster id')
  const path = assertPathStaysUnderRoot(
    replayClustersDir(cwd),
    join(replayClustersDir(cwd), safeId, 'cluster.json'),
  )
  if (!(await pathExists(path))) {
    return undefined
  }
  return { ...(await readJson<MatOSWorkflowReplayCluster>(path)), path }
}

type ReplayWorkflowRunner = (input: {
  cwd: string
  workflowRef: string
  parameters: Record<string, unknown>
}) => Promise<{
  runId: string
  status: string
  failedNodeIds: string[]
}>

const REPLAY_UNSAFE_NODE_TYPES = new Set([
  'agent',
  'backend',
  'compute',
  'dynamic',
  'exec',
  'loop',
  'map',
  'subworkflow',
])

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function replaySafeFlag(node: {
  sideEffect?: unknown
  policy?: unknown
  metadata?: unknown
  replaySafe?: unknown
}): boolean {
  return node.replaySafe === true ||
    recordValue(node.sideEffect).replaySafe === true ||
    recordValue(node.policy).replaySafe === true ||
    recordValue(node.metadata).replaySafe === true
}

/**
 * A replay is auto-verifiable only when the recorded definition cannot spend
 * model tokens, run arbitrary shell, submit external jobs, or recursively run
 * child workflows. Exec nodes are local but still arbitrary commands, so they
 * require an explicit replaySafe declaration before background verification
 * may rerun them.
 */
export function replayCandidateIsAutoVerifiable(definition: {
  nodes?: Array<{
    type?: unknown
    runtimeType?: unknown
    targetType?: unknown
    sideEffect?: unknown
    policy?: unknown
    metadata?: unknown
    replaySafe?: unknown
  }>
}): boolean {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  if (nodes.length === 0) {
    return false
  }
  return nodes.every(node => {
    const types = [node.type, node.runtimeType, node.targetType]
      .filter(value => typeof value === 'string')
      .map(String)
    if (types.length === 0) {
      return false
    }
    return types.every(type => {
      if (type === 'exec') {
        return replaySafeFlag(node)
      }
      return !REPLAY_UNSAFE_NODE_TYPES.has(type)
    })
  })
}

/**
 * Replay verification: rerun the recorded workflow with the redacted replay
 * parameters and compare the resulting failed-node set against the recorded
 * failure signature. Writes `benchmark/result.json` and updates the candidate
 * verification state. Never throws into the caller's foreground path.
 */
export async function verifyMatOSWorkflowReplayCandidate(input: {
  cwd: string
  candidateId: string
  runWorkflow: ReplayWorkflowRunner
  definition?: {
    nodes?: Array<{
      type?: unknown
      runtimeType?: unknown
      targetType?: unknown
      sideEffect?: unknown
      policy?: unknown
      metadata?: unknown
      replaySafe?: unknown
    }>
  }
}): Promise<MatOSWorkflowReplayCandidate | undefined> {
  const candidate = await readMatOSWorkflowReplayCandidate(
    input.cwd,
    input.candidateId,
  )
  if (!candidate) {
    return undefined
  }
  const dir = candidateDir(input.cwd, candidate.candidateId)

  if (!input.definition || !replayCandidateIsAutoVerifiable(input.definition)) {
    return writeCandidateUpdate(input.cwd, {
      ...candidate,
      verification: {
        status: 'skipped-unsafe',
        verifiedAt: nowIso(),
        reason:
          'Workflow definition is missing or contains agent/backend/compute/dynamic/map/loop/subworkflow nodes, or exec nodes without explicit replaySafe=true; replay must be run explicitly by an operator.',
      },
    })
  }

  let plan: Record<string, unknown>
  try {
    plan = await readJson<Record<string, unknown>>(
      join(dir, candidate.files.replayPlan),
    )
  } catch (error) {
    return writeCandidateUpdate(input.cwd, {
      ...candidate,
      verification: {
        status: 'error',
        verifiedAt: nowIso(),
        reason: `replay plan unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    })
  }

  try {
    const parameters =
      plan.parameters && typeof plan.parameters === 'object' && !Array.isArray(plan.parameters)
        ? (plan.parameters as Record<string, unknown>)
        : {}
    const replay = await input.runWorkflow({
      cwd: input.cwd,
      workflowRef: candidate.workflowRef,
      parameters,
    })
    const replayFailed = [...replay.failedNodeIds].sort()
    const signatureMatch =
      JSON.stringify(replayFailed) === JSON.stringify([...candidate.failedNodeIds].sort())
    // Require a non-empty failed-node set so an empty-vs-empty match cannot be
    // counted as a reproduction. (Full root-cause signature matching also needs
    // the replay runner to return recovery classification, which it does not yet
    // expose; node-set match plus a non-completed terminal status is the
    // strongest check available here.)
    const reproduced =
      signatureMatch &&
      candidate.failedNodeIds.length > 0 &&
      replay.status !== 'completed'
    await writeJson(join(dir, 'benchmark', 'result.json'), {
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      benchmarkCaseId: candidate.benchmarkCaseId,
      replayRunId: replay.runId,
      replayRunStatus: replay.status,
      replayFailedNodeIds: replayFailed,
      expectedFailedNodeIds: candidate.failedNodeIds,
      signatureMatch,
      reproduced,
      verifiedAt: nowIso(),
    })
    return writeCandidateUpdate(input.cwd, {
      ...candidate,
      verification: {
        status: reproduced ? 'reproduced' : 'not-reproduced',
        verifiedAt: nowIso(),
        replayRunId: replay.runId,
        replayRunStatus: replay.status,
        signatureMatch,
      },
    })
  } catch (error) {
    return writeCandidateUpdate(input.cwd, {
      ...candidate,
      verification: {
        status: 'error',
        verifiedAt: nowIso(),
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/**
 * Promotion-gated stable improvement candidates. A cluster (>=2 same-signature
 * failures) plus at least one reproduced replay produces one durable record
 * that downstream promotion review can inspect. The promotion gate stays
 * blocked until an explicit operator decision; this function never promotes.
 */
export async function maintainMatOSStableImprovementCandidates(
  cwd: string,
): Promise<MatOSStableImprovementCandidate[]> {
  const clusters = await listMatOSWorkflowReplayClusters(cwd)
  if (clusters.length === 0) {
    return []
  }
  const candidates = await listMatOSWorkflowReplayCandidates(cwd)
  const byId = new Map(candidates.map(candidate => [candidate.candidateId, candidate]))

  const written: MatOSStableImprovementCandidate[] = []
  for (const cluster of clusters) {
    const clusterCandidates = cluster.candidateIds
      .map(id => byId.get(id))
      .filter((candidate): candidate is MatOSWorkflowReplayCandidate =>
        Boolean(candidate),
      )
    const reproduced = clusterCandidates.filter(
      candidate => candidate.verification?.status === 'reproduced',
    )
    if (reproduced.length === 0) {
      continue
    }
    const id = stableImprovementIdForSignature(cluster.failureSignature)
    const dir = join(improvementCandidatesDir(cwd), id)
    await mkdir(dir, { recursive: true })
    const existing = await readMatOSStableImprovementCandidate(cwd, id).catch(
      () => undefined,
    )
    const record: MatOSStableImprovementCandidate = {
      schemaVersion: 1,
      id,
      status: 'awaiting-promotion',
      workflowRef: cluster.workflowRef,
      failureSignature: cluster.failureSignature,
      clusterRef: `replay-cluster:${cluster.clusterId}`,
      draftRefs: {
        replayCandidateIds: cluster.candidateIds,
      },
      evidence: {
        reproducedRunIds: reproduced
          .map(candidate => candidate.verification?.replayRunId ?? '')
          .filter(Boolean),
        workflowEvidenceRefs: clusterCandidates.map(
          candidate => candidate.provenance.evidenceRef,
        ),
      },
      gates: {
        promotion: {
          status: 'blocked',
          reason: 'explicit operator promotion required',
        },
      },
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    }
    await writeJson(join(dir, 'candidate.json'), record)
    written.push({ ...record, path: join(dir, 'candidate.json') })
  }
  return written
}

export async function readMatOSStableImprovementCandidate(
  cwd: string,
  id: string,
): Promise<MatOSStableImprovementCandidate | undefined> {
  const safeId = assertSafeEvolutionRecordId(id, 'improvement candidate id')
  const path = assertPathStaysUnderRoot(
    improvementCandidatesDir(cwd),
    join(improvementCandidatesDir(cwd), safeId, 'candidate.json'),
  )
  if (!(await pathExists(path))) {
    return undefined
  }
  return { ...(await readJson<MatOSStableImprovementCandidate>(path)), path }
}

export async function listMatOSStableImprovementCandidates(
  cwd: string,
): Promise<MatOSStableImprovementCandidate[]> {
  const dir = improvementCandidatesDir(cwd)
  if (!(await pathExists(dir))) {
    return []
  }
  const records: MatOSStableImprovementCandidate[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const record = await readMatOSStableImprovementCandidate(cwd, entry.name).catch(
      () => undefined,
    )
    if (record) {
      records.push(record)
    }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
