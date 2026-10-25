import {readMatOSDaemonJobLedgerFile} from '../workbench/daemonJobs.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { getMatOSDir } from '../project.js'
import { resolveMatOSRuntimeScope } from '../runtime/scopes.js'
import {
  listMatOSSessionsFromDir,
  readMatOSSessionEventsFromPath,
} from '../sessions/sessionIndex.js'
import { resolveMatOSSessionsDir } from '../sessions/sessionPaths.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import type { MatOSEvent, MatOSSessionSummary } from '../sessions/eventTypes.js'
import { matOSWorkflowService } from '../workflows/workflowService.js'
import {
  assertPathStaysUnderRoot,
  assertSafeEvolutionRecordId,
} from './evolutionRecordPaths.js'
import { listMatOSSelfEvolutionMonitorRecords } from './evolutionMonitor.js'

/**
 * user2asset evidence intake.
 *
 * Turns a user scope and time window into one structured intake record
 * plus deterministic teaching episodes, without manual log archaeology:
 *
 *   .matos/evolution/intakes/<intake-id>.json
 *   .matos/evolution/episodes/<episode-id>.json
 *
 * Collection is deterministic and LLM-free. Evidence entries reference the
 * existing session JSONL, workflow run dirs, daemon ledger, feedback reports,
 * and self-evolution monitor records instead of copying raw transcripts.
 * Every excerpt passes redactTraceValue and a hard length cap so secrets and
 * full conversation text never land in intake output.
 */

export type MatOSUserTestLogIntakeInput = {
  cwd: string
  /** Runtime scope such as `user:<id>`. Omitted: local project evidence. */
  scopeRef?: string
  /** ISO timestamp or relative window like `24h`, `7d`, `90m`. Default 24h. */
  since?: string
  sessionId?: string
  traceId?: string
  runId?: string
  /** Per-source evidence cap. Default 50. */
  limit?: number
  env?: Record<string, string | undefined>
}

export type MatOSIntakeSessionEvidence = {
  sessionId: string
  path: string
  traceId?: string
  scopeRef?: string
  roleRef?: string
  status?: 'running' | 'completed' | 'failed'
  startedAt?: string
  lastEventAt?: string
  turnCount: number
  toolCallCount: number
  toolFailureCount: number
  hidden: boolean
}

export type MatOSIntakeWorkflowRunEvidence = {
  runId: string
  runDir: string
  workflowRef: string
  status: string
  createdAt?: string
  updatedAt?: string
  traceId?: string
  sessionId?: string
  failedNodes: Array<{ nodeId: string; status?: string; error?: string }>
}

export type MatOSIntakeDaemonJobEvidence = {
  jobId: string
  status: string
  argvPreview?: string
  startedAt?: string
  completedAt?: string
  exitCode?: number
  traceId?: string
  sessionId?: string
}

export type MatOSIntakeFeedbackEvidence = {
  id: string
  path: string
  createdAt?: string
  kind?: string
  severity?: string
  title?: string
  messagePreview?: string
}

export type MatOSIntakeMonitorEvidence = {
  recordId: string
  sessionId: string
  triggerKind: string
  status: string
  createdAt?: string
  summary?: string
}

export type MatOSUserTestLogEpisode = {
  schemaVersion: 1
  episodeId: string
  intakeId: string
  createdAt: string
  scopeRef?: string
  kind:
    | 'workflow-failure'
    | 'session-failure'
    | 'tool-failure'
    | 'user-feedback'
  summary: string
  userIntent?: string
  observedFailure?: string
  suspectedRefs: string[]
  evidenceRefs: {
    sessionIds?: string[]
    traceIds?: string[]
    workflowRunIds?: string[]
    feedbackIds?: string[]
    monitorRecordIds?: string[]
    paths?: string[]
  }
  /** A later matching success exists inside the same window. */
  laterFixed?: boolean
  benchmarkCandidate?: {
    kind: 'workflow-run' | 'tool-call'
    ref: string
  }
  privacy: { redacted: true; scopeRef?: string }
}

export type MatOSUserTestLogIntakeRecord = {
  schemaVersion: 1
  intakeId: string
  createdAt: string
  scopeRef?: string
  window: { since: string; until: string }
  filters: { sessionId?: string; traceId?: string; runId?: string }
  sources: {
    sessionsDirs: string[]
    workflowRunsDir?: string
    daemonLedgerPath?: string
    feedbackDir?: string
  }
  evidence: {
    sessions: MatOSIntakeSessionEvidence[]
    workflowRuns: MatOSIntakeWorkflowRunEvidence[]
    daemonJobs: MatOSIntakeDaemonJobEvidence[]
    feedbackReports: MatOSIntakeFeedbackEvidence[]
    monitorRecords: MatOSIntakeMonitorEvidence[]
  }
  stats: {
    sessionCount: number
    failedSessionCount: number
    workflowRunCount: number
    failedWorkflowRunCount: number
    daemonJobCount: number
    failedDaemonJobCount: number
    feedbackCount: number
    monitorRecordCount: number
    episodeCount: number
  }
  episodeIds: string[]
}

const EXCERPT_MAX_CHARS = 360
const DEFAULT_LIMIT = 50
const DEFAULT_WINDOW = '24h'

function intakesDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'intakes')
}

function episodesDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'episodes')
}

export function matOSUserTestLogIntakePath(cwd: string, intakeId: string): string {
  const safe = assertSafeEvolutionRecordId(intakeId, 'intake id')
  const path = join(intakesDir(cwd), `${safe}.json`)
  assertPathStaysUnderRoot(intakesDir(cwd), path)
  return path
}

export function matOSUserTestLogEpisodePath(cwd: string, episodeId: string): string {
  const safe = assertSafeEvolutionRecordId(episodeId, 'episode id')
  const path = join(episodesDir(cwd), `${safe}.json`)
  assertPathStaysUnderRoot(episodesDir(cwd), path)
  return path
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function redactedExcerpt(value: unknown): string | undefined {
  const raw = stringValue(value)
  if (!raw) {
    return undefined
  }
  // Two-pass scrub: trace redaction catches key=value/token patterns from
  // event payloads, asset output redaction additionally scrubs credential
  // assignments in free text (argv previews, prompts, tool output).
  const redacted = redactMatOSAssetOutput(redactTraceValue(raw))
  const text = typeof redacted === 'string' ? redacted : String(redacted)
  return text.length > EXCERPT_MAX_CHARS
    ? `${text.slice(0, EXCERPT_MAX_CHARS)}…`
    : text
}

export function parseMatOSIntakeSince(
  value: string | undefined,
  now = new Date(),
): Date {
  const raw = (value ?? DEFAULT_WINDOW).trim()
  const relative = /^(\d+)([mhd])$/.exec(raw)
  if (relative) {
    const amount = Number.parseInt(relative[1], 10)
    const unitMs =
      relative[2] === 'm' ? 60_000 : relative[2] === 'h' ? 3_600_000 : 86_400_000
    return new Date(now.getTime() - amount * unitMs)
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid --since value: ${raw}. Use an ISO timestamp or a relative window like 24h, 7d, 90m.`,
    )
  }
  return parsed
}

function inWindow(
  timestamp: string | undefined,
  since: Date,
  until: Date,
): boolean {
  if (!timestamp) {
    return false
  }
  const at = new Date(timestamp).getTime()
  if (Number.isNaN(at)) {
    return false
  }
  return at >= since.getTime() && at <= until.getTime()
}

function matchesScope(
  recordScopeRef: string | undefined,
  scopeRef: string | undefined,
): boolean {
  // Explicit scope filter: records without a scopeRef stay (local runs often
  // omit it), records with a different scopeRef are another user's data.
  if (!scopeRef) {
    return true
  }
  return !recordScopeRef || recordScopeRef === scopeRef
}

function toolFailureEvents(events: MatOSEvent[]): MatOSEvent[] {
  return events.filter(
    event =>
      event.type === 'matos.tool.call.completed' && event.data.isError === true,
  )
}

function firstUserIntent(events: MatOSEvent[]): string | undefined {
  const started = events.find(event => event.type === 'matos.turn.started')
  return redactedExcerpt(started?.data.prompt)
}

async function collectSessions(input: {
  sessionsDirs: string[]
  since: Date
  until: Date
  scopeRef?: string
  sessionId?: string
  traceId?: string
  limit: number
}): Promise<{
  evidence: MatOSIntakeSessionEvidence[]
  eventsBySession: Map<string, MatOSEvent[]>
}> {
  const summaries: MatOSSessionSummary[] = []
  const seenPaths = new Set<string>()
  for (const dir of input.sessionsDirs) {
    const listed = await listMatOSSessionsFromDir(dir).catch(
      () => [] as MatOSSessionSummary[],
    )
    for (const summary of listed) {
      if (!seenPaths.has(summary.path)) {
        seenPaths.add(summary.path)
        summaries.push(summary)
      }
    }
  }
  const filtered = summaries
    .filter(summary => !summary.hidden)
    .filter(summary => matchesScope(summary.scopeRef, input.scopeRef))
    .filter(summary =>
      input.sessionId ? summary.sessionId === input.sessionId : true,
    )
    .filter(summary => (input.traceId ? summary.traceId === input.traceId : true))
    .filter(summary =>
      inWindow(summary.lastEventAt ?? summary.startedAt, input.since, input.until),
    )
    .slice(0, input.limit)

  const evidence: MatOSIntakeSessionEvidence[] = []
  const eventsBySession = new Map<string, MatOSEvent[]>()
  for (const summary of filtered) {
    const events = await readMatOSSessionEventsFromPath(summary.path).catch(
      () => [] as MatOSEvent[],
    )
    eventsBySession.set(summary.sessionId, events)
    evidence.push({
      sessionId: summary.sessionId,
      path: summary.path,
      ...(summary.traceId ? { traceId: summary.traceId } : {}),
      ...(summary.scopeRef ? { scopeRef: summary.scopeRef } : {}),
      ...(summary.roleRef ? { roleRef: summary.roleRef } : {}),
      ...(summary.status ? { status: summary.status } : {}),
      ...(summary.startedAt ? { startedAt: summary.startedAt } : {}),
      ...(summary.lastEventAt ? { lastEventAt: summary.lastEventAt } : {}),
      turnCount: summary.turnCount,
      toolCallCount: summary.toolCallCount,
      toolFailureCount: toolFailureEvents(events).length,
      hidden: summary.hidden,
    })
  }
  return { evidence, eventsBySession }
}

async function collectWorkflowRuns(input: {
  cwd: string
  scopeRef?: string
  since: Date
  until: Date
  runId?: string
  traceId?: string
  sessionId?: string
  limit: number
}): Promise<{ evidence: MatOSIntakeWorkflowRunEvidence[]; runsDir?: string }> {
  try {
    const listed = await matOSWorkflowService.listRuns({
      cwd: input.cwd,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      limit: 500,
      ...(input.traceId || input.sessionId
        ? {
            filter: {
              ...(input.traceId ? { traceId: input.traceId } : {}),
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            },
          }
        : {}),
    })
    const evidence: MatOSIntakeWorkflowRunEvidence[] = []
    for (const item of listed.runs) {
      const snapshot = item.snapshot
      if (input.runId && snapshot.runId !== input.runId) {
        continue
      }
      if (!matchesScope(snapshot.trace?.scopeRef, input.scopeRef)) {
        continue
      }
      const updatedAt =
        stringValue((snapshot as Record<string, unknown>).updatedAt) ??
        stringValue((snapshot as Record<string, unknown>).createdAt)
      if (!input.runId && !inWindow(updatedAt, input.since, input.until)) {
        continue
      }
      const run = item.run as Record<string, unknown>
      const diagnostics =
        run.diagnostics && typeof run.diagnostics === 'object'
          ? (run.diagnostics as Record<string, unknown>)
          : undefined
      const failedNodesRaw = Array.isArray(diagnostics?.failedNodes)
        ? (diagnostics.failedNodes as Array<Record<string, unknown>>)
        : []
      evidence.push({
        runId: snapshot.runId,
        runDir: stringValue(run.runDir) ?? '',
        workflowRef: snapshot.workflowRef,
        status: snapshot.status,
        ...(stringValue((snapshot as Record<string, unknown>).createdAt)
          ? { createdAt: stringValue((snapshot as Record<string, unknown>).createdAt) }
          : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(snapshot.trace?.traceId ? { traceId: snapshot.trace.traceId } : {}),
        ...(snapshot.trace?.sessionId
          ? { sessionId: snapshot.trace.sessionId }
          : {}),
        failedNodes: failedNodesRaw.slice(0, 10).map(node => ({
          nodeId: stringValue(node.nodeId) ?? 'unknown',
          ...(stringValue(node.status) ? { status: stringValue(node.status) } : {}),
          ...(redactedExcerpt(node.error)
            ? { error: redactedExcerpt(node.error) }
            : {}),
        })),
      })
      if (evidence.length >= input.limit) {
        break
      }
    }
    return { evidence, runsDir: listed.sources.workflowRunsDir }
  } catch {
    return { evidence: [] }
  }
}
async function collectDaemonJobs(input: {
  ledgerPath: string
  since: Date
  until: Date
  scopeRef?: string
  limit: number
}): Promise<MatOSIntakeDaemonJobEvidence[]> {
  try {
    const ledger = await readMatOSDaemonJobLedgerFile(input.ledgerPath)
    const jobs = Array.isArray(ledger?.jobs) ? ledger.jobs : []
    return jobs
      .filter(job =>
        matchesScope(
          stringValue((job.metadata as Record<string, unknown> | undefined)?.scopeRef),
          input.scopeRef,
        ),
      )
      .filter(job =>
        inWindow(job.completedAt ?? job.startedAt, input.since, input.until),
      )
      .slice(0, input.limit)
      .map(job => ({
        jobId: job.jobId,
        status: job.status,
        ...(stringValue(job.argvPreview)
          ? { argvPreview: redactedExcerpt(job.argvPreview) }
          : {}),
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.completedAt ? { completedAt: job.completedAt } : {}),
        ...(typeof job.exitCode === 'number' ? { exitCode: job.exitCode } : {}),
        ...(stringValue(
          (job.metadata as Record<string, unknown> | undefined)?.traceId,
        )
          ? {
              traceId: stringValue(
                (job.metadata as Record<string, unknown> | undefined)?.traceId,
              ),
            }
          : {}),
        ...(stringValue(
          (job.metadata as Record<string, unknown> | undefined)?.sessionId,
        )
          ? {
              sessionId: stringValue(
                (job.metadata as Record<string, unknown> | undefined)?.sessionId,
              ),
            }
          : {}),
      }))
  } catch {
    return []
  }
}


async function collectFeedbackReports(input: {
  feedbackDir: string
  since: Date
  until: Date
  limit: number
}): Promise<MatOSIntakeFeedbackEvidence[]> {
  let entries: string[] = []
  try {
    entries = (await readdir(input.feedbackDir)).filter(name =>
      name.endsWith('.json'),
    )
  } catch {
    return []
  }
  const reports: MatOSIntakeFeedbackEvidence[] = []
  for (const entry of entries) {
    try {
      const path = join(input.feedbackDir, entry)
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
      >
      const createdAt = stringValue(parsed.createdAt)
      if (!inWindow(createdAt, input.since, input.until)) {
        continue
      }
      reports.push({
        id: stringValue(parsed.id) ?? entry.replace(/\.json$/, ''),
        path,
        ...(createdAt ? { createdAt } : {}),
        ...(stringValue(parsed.kind) ? { kind: stringValue(parsed.kind) } : {}),
        ...(stringValue(parsed.severity)
          ? { severity: stringValue(parsed.severity) }
          : {}),
        ...(redactedExcerpt(parsed.title)
          ? { title: redactedExcerpt(parsed.title) }
          : {}),
        ...(redactedExcerpt(parsed.messagePreview ?? parsed.message)
          ? { messagePreview: redactedExcerpt(parsed.messagePreview ?? parsed.message) }
          : {}),
      })
    } catch {
      // Skip unreadable feedback files.
    }
  }
  return reports
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, input.limit)
}

async function collectMonitorRecords(input: {
  cwd: string
  since: Date
  until: Date
  sessionIds: Set<string>
  limit: number
}): Promise<MatOSIntakeMonitorEvidence[]> {
  try {
    const records = await listMatOSSelfEvolutionMonitorRecords(input.cwd)
    return records
      .filter(record =>
        input.sessionIds.size > 0
          ? input.sessionIds.has(record.sessionId)
          : inWindow(record.createdAt, input.since, input.until),
      )
      .slice(0, input.limit)
      .map(record => ({
        recordId: record.recordId,
        sessionId: record.sessionId,
        triggerKind: record.triggerKind,
        status: record.status,
        ...(record.createdAt ? { createdAt: record.createdAt } : {}),
        ...(redactedExcerpt(record.summary)
          ? { summary: redactedExcerpt(record.summary) }
          : {}),
      }))
  } catch {
    return []
  }
}

function buildEpisodes(input: {
  intakeId: string
  createdAt: string
  scopeRef?: string
  sessions: MatOSIntakeSessionEvidence[]
  eventsBySession: Map<string, MatOSEvent[]>
  workflowRuns: MatOSIntakeWorkflowRunEvidence[]
  feedbackReports: MatOSIntakeFeedbackEvidence[]
  monitorRecords: MatOSIntakeMonitorEvidence[]
  limit: number
}): MatOSUserTestLogEpisode[] {
  const episodes: MatOSUserTestLogEpisode[] = []
  const privacy = {
    redacted: true as const,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
  }
  const base = (kind: MatOSUserTestLogEpisode['kind']) => ({
    schemaVersion: 1 as const,
    episodeId: `episode-${input.intakeId.replace(/^intake-/, '')}-${kind}-${episodes.length}`,
    intakeId: input.intakeId,
    createdAt: input.createdAt,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    kind,
    privacy,
  })

  // Workflow failures: one episode per failed run; laterFixed when the same
  // workflowRef completed later inside the window.
  for (const run of input.workflowRuns.filter(item => item.status === 'failed')) {
    const laterFixed = input.workflowRuns.some(
      other =>
        other.workflowRef === run.workflowRef &&
        other.status === 'completed' &&
        (other.updatedAt ?? '') > (run.updatedAt ?? ''),
    )
    episodes.push({
      ...base('workflow-failure'),
      summary: `Workflow ${run.workflowRef} run ${run.runId} failed${
        run.failedNodes.length > 0
          ? ` at node ${run.failedNodes[0]?.nodeId}`
          : ''
      }.`,
      ...(run.failedNodes[0]?.error
        ? { observedFailure: run.failedNodes[0].error }
        : {}),
      suspectedRefs: [run.workflowRef],
      evidenceRefs: {
        workflowRunIds: [run.runId],
        ...(run.traceId ? { traceIds: [run.traceId] } : {}),
        ...(run.sessionId ? { sessionIds: [run.sessionId] } : {}),
        ...(run.runDir ? { paths: [run.runDir] } : {}),
      },
      laterFixed,
      benchmarkCandidate: { kind: 'workflow-run', ref: run.workflowRef },
    })
    if (episodes.length >= input.limit) {
      return episodes
    }
  }

  // Session failures.
  for (const session of input.sessions.filter(item => item.status === 'failed')) {
    const events = input.eventsBySession.get(session.sessionId) ?? []
    const failure = toolFailureEvents(events).at(-1)
    episodes.push({
      ...base('session-failure'),
      summary: `Session ${session.sessionId} failed${
        session.roleRef ? ` (role ${session.roleRef})` : ''
      }.`,
      ...(firstUserIntent(events) ? { userIntent: firstUserIntent(events) } : {}),
      ...(redactedExcerpt(failure?.data.resultPreview)
        ? { observedFailure: redactedExcerpt(failure?.data.resultPreview) }
        : {}),
      suspectedRefs: session.roleRef ? [session.roleRef] : [],
      evidenceRefs: {
        sessionIds: [session.sessionId],
        ...(session.traceId ? { traceIds: [session.traceId] } : {}),
        paths: [session.path],
      },
    })
    if (episodes.length >= input.limit) {
      return episodes
    }
  }

  // Tool failures: cluster by tool name across the collected sessions.
  const toolFailures = new Map<
    string,
    { count: number; sessionIds: Set<string>; excerpt?: string }
  >()
  for (const session of input.sessions) {
    for (const event of toolFailureEvents(
      input.eventsBySession.get(session.sessionId) ?? [],
    )) {
      const toolName = stringValue(event.data.toolName) ?? 'tool'
      const entry = toolFailures.get(toolName) ?? {
        count: 0,
        sessionIds: new Set<string>(),
      }
      entry.count += 1
      entry.sessionIds.add(session.sessionId)
      entry.excerpt =
        entry.excerpt ?? redactedExcerpt(event.data.resultPreview)
      toolFailures.set(toolName, entry)
    }
  }
  for (const [toolName, cluster] of [...toolFailures.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    episodes.push({
      ...base('tool-failure'),
      summary: `Tool ${toolName} failed ${cluster.count} time(s) across ${cluster.sessionIds.size} session(s).`,
      ...(cluster.excerpt ? { observedFailure: cluster.excerpt } : {}),
      suspectedRefs: [`tool:${toolName}`],
      evidenceRefs: { sessionIds: [...cluster.sessionIds] },
      benchmarkCandidate: { kind: 'tool-call', ref: `tool:${toolName}` },
    })
    if (episodes.length >= input.limit) {
      return episodes
    }
  }

  // User feedback reports.
  for (const report of input.feedbackReports) {
    episodes.push({
      ...base('user-feedback'),
      summary: report.title ?? `User feedback ${report.id}`,
      ...(report.messagePreview ? { observedFailure: report.messagePreview } : {}),
      suspectedRefs: [],
      evidenceRefs: { feedbackIds: [report.id], paths: [report.path] },
    })
    if (episodes.length >= input.limit) {
      return episodes
    }
  }

  return episodes
}

export async function collectMatOSUserTestLogIntake(
  input: MatOSUserTestLogIntakeInput,
): Promise<{
  intake: MatOSUserTestLogIntakeRecord
  episodes: MatOSUserTestLogEpisode[]
  intakePath: string
  episodePaths: string[]
}> {
  const env = input.env ?? process.env
  const until = new Date()
  const since = parseMatOSIntakeSince(input.since, until)
  const limit =
    input.limit && input.limit > 0 ? Math.min(input.limit, 500) : DEFAULT_LIMIT
  const createdAt = until.toISOString()
  const intakeId = `intake-${createdAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-').toLowerCase()}-${randomUUID().slice(0, 8)}`

  // Evidence roots: the local project sessions dir plus, for an explicit
  // scope, that scope's own sessions/ipc/logs roots.
  const sessionsDirs = [resolveMatOSSessionsDir(input.cwd)]
  let daemonLedgerPath = stringValue(env.MATOS_DAEMON_JOB_LEDGER)
  let feedbackDir = stringValue(env.MATOS_FEEDBACK_DIR)
  if (input.scopeRef) {
    try {
      const scope = resolveMatOSRuntimeScope(input.cwd, {
        scopeRef: input.scopeRef,
        env: env as NodeJS.ProcessEnv,
      })
      sessionsDirs.push(scope.sessionsDir)
      daemonLedgerPath =
        daemonLedgerPath ?? join(scope.ipcDir, 'matos-daemon-jobs.json')
      feedbackDir = feedbackDir ?? join(scope.logsDir, 'feedback')
    } catch {
      // Unknown scope kinds fall back to local project evidence only.
    }
  }

  const { evidence: sessions, eventsBySession } = await collectSessions({
    sessionsDirs,
    since,
    until,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    limit,
  })
  const { evidence: workflowRuns, runsDir } = await collectWorkflowRuns({
    cwd: input.cwd,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    since,
    until,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    limit,
  })
  const daemonJobs = daemonLedgerPath
    ? await collectDaemonJobs({
        ledgerPath: daemonLedgerPath,
        since,
        until,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        limit,
      })
    : []
  const feedbackReports = feedbackDir
    ? await collectFeedbackReports({ feedbackDir, since, until, limit })
    : []
  const monitorRecords = await collectMonitorRecords({
    cwd: input.cwd,
    since,
    until,
    sessionIds: new Set(sessions.map(session => session.sessionId)),
    limit,
  })

  const episodes = buildEpisodes({
    intakeId,
    createdAt,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    sessions,
    eventsBySession,
    workflowRuns,
    feedbackReports,
    monitorRecords,
    limit,
  })

  const intake: MatOSUserTestLogIntakeRecord = {
    schemaVersion: 1,
    intakeId,
    createdAt,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    window: { since: since.toISOString(), until: createdAt },
    filters: {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    },
    sources: {
      sessionsDirs,
      ...(runsDir ? { workflowRunsDir: runsDir } : {}),
      ...(daemonLedgerPath ? { daemonLedgerPath } : {}),
      ...(feedbackDir ? { feedbackDir } : {}),
    },
    evidence: {
      sessions,
      workflowRuns,
      daemonJobs,
      feedbackReports,
      monitorRecords,
    },
    stats: {
      sessionCount: sessions.length,
      failedSessionCount: sessions.filter(item => item.status === 'failed')
        .length,
      workflowRunCount: workflowRuns.length,
      failedWorkflowRunCount: workflowRuns.filter(
        item => item.status === 'failed',
      ).length,
      daemonJobCount: daemonJobs.length,
      failedDaemonJobCount: daemonJobs.filter(item => item.status === 'failed')
        .length,
      feedbackCount: feedbackReports.length,
      monitorRecordCount: monitorRecords.length,
      episodeCount: episodes.length,
    },
    episodeIds: episodes.map(episode => episode.episodeId),
  }

  await mkdir(intakesDir(input.cwd), { recursive: true })
  const intakePath = matOSUserTestLogIntakePath(input.cwd, intakeId)
  await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`, 'utf8')
  const episodePaths: string[] = []
  if (episodes.length > 0) {
    await mkdir(episodesDir(input.cwd), { recursive: true })
    for (const episode of episodes) {
      const episodePath = matOSUserTestLogEpisodePath(
        input.cwd,
        episode.episodeId,
      )
      await writeFile(
        episodePath,
        `${JSON.stringify(episode, null, 2)}\n`,
        'utf8',
      )
      episodePaths.push(episodePath)
    }
  }
  return { intake, episodes, intakePath, episodePaths }
}

export async function listMatOSUserTestLogIntakes(
  cwd: string,
): Promise<MatOSUserTestLogIntakeRecord[]> {
  let entries: string[] = []
  try {
    entries = (await readdir(intakesDir(cwd))).filter(name =>
      name.endsWith('.json'),
    )
  } catch {
    return []
  }
  const records: MatOSUserTestLogIntakeRecord[] = []
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(
        await readFile(join(intakesDir(cwd), entry), 'utf8'),
      ) as MatOSUserTestLogIntakeRecord
      if (parsed && parsed.schemaVersion === 1 && parsed.intakeId) {
        records.push(parsed)
      }
    } catch {
      // Skip unreadable intake files.
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readMatOSUserTestLogEpisode(
  cwd: string,
  episodeId: string,
): Promise<MatOSUserTestLogEpisode | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(matOSUserTestLogEpisodePath(cwd, episodeId), 'utf8'),
    ) as MatOSUserTestLogEpisode
    return parsed && parsed.schemaVersion === 1 ? parsed : undefined
  } catch {
    return undefined
  }
}
