import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { maybeSweepMatOSSessionAppendResidue } from './eventStorage.js'
import type {
  MatOSEvent,
  MatOSEventSource,
  MatOSSessionSummary,
  MatOSTraceSummary,
} from './eventTypes.js'
import { resolveMatOSSessionsDir } from './sessionPaths.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Session JSONL lines can be corrupt in the wild: a crashed writer leaves a
// truncated final line, and concurrent cross-process appends on FUSE/NFS
// filesystems can produce interleaved half-records on a single line. Some of that
// damage still parses as JSON (`null`, `{}`, a spliced object without `type`),
// so structural validation is required on top of the parse guard or summary
// code downstream crashes on `event.type` / `event.data` access.
function normalizeParsedEvent(value: unknown): MatOSEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || !record.type) {
    return undefined
  }
  const data = record.data
  return {
    ...record,
    id: typeof record.id === 'string' ? record.id : '',
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    type: record.type as MatOSEvent['type'],
    data:
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
  } as MatOSEvent
}

function parseJsonlEvents(raw: string): MatOSEvent[] {
  const events: MatOSEvent[] = []
  for (const line of raw.split('\n')) {
    // Strip whitespace plus NUL padding: writers JSON-escape control
    // characters, so literal NUL bytes can only be filesystem tail damage
    // (crash/disconnect on FUSE-backed storage). Removing them salvages an
    // otherwise-complete record instead of dropping it.
    const cleaned = line.replace(/^[\s\u0000]+|[\s\u0000]+$/g, '')
    if (!cleaned) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // Skip corrupt/partial lines instead of dropping the whole session file.
      continue
    }
    const event = normalizeParsedEvent(parsed)
    if (event) {
      events.push(event)
    }
  }
  return events
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function hiddenValue(value: Record<string, unknown>): boolean {
  return value.hidden === true && value.userVisible === false
}

function isInternalRuntimeSessionEvent(event: MatOSEvent): boolean {
  return (
    event.type === 'matos.workspace.job.started' ||
    event.type === 'matos.workspace.job.completed' ||
    event.type === 'matos.workspace.job.cancelled' ||
    event.type === 'matos.workspace.quota.denied'
  )
}

function sessionHidden(events: MatOSEvent[]): boolean {
  const firstData = events[0]?.data ?? {}
  return (
    hiddenValue(firstData) ||
    (events.length > 0 && events.every(isInternalRuntimeSessionEvent))
  )
}

function isInternalSummaryEvent(event: MatOSEvent): boolean {
  return event.type.startsWith('matos.learning.')
}

function sessionStatus(
  events: MatOSEvent[],
): MatOSSessionSummary['status'] {
  if (events.some(event => event.type === 'matos.session.failed')) {
    return 'failed'
  }
  if (events.some(event => event.type === 'matos.session.completed')) {
    return 'completed'
  }
  return events.length > 0 ? 'running' : undefined
}

function countUniqueToolCalls(events: MatOSEvent[]): number {
  const seen = new Set<string>()
  let anonymousCount = 0

  for (const event of events) {
    if (
      event.type !== 'matos.tool.call.started' &&
      event.type !== 'matos.tool.call.completed'
    ) {
      continue
    }
    const toolUseId = stringValue(event.data.toolUseId)
    if (!toolUseId) {
      anonymousCount += 1
      continue
    }
    const toolName = stringValue(event.data.toolName) ?? 'tool'
    seen.add(`${toolName}:${toolUseId}`)
  }

  return seen.size + anonymousCount
}

function summaryFromSessionEvents(input: {
  sessionId: string
  path: string
  events: MatOSEvent[]
}): MatOSSessionSummary {
  const first = input.events[0]
  const last = input.events.at(-1)
  const lastVisible =
    [...input.events].reverse().find(event => !isInternalSummaryEvent(event)) ??
    last
  const firstData = first?.data ?? {}
  const completion = [...input.events]
    .reverse()
    .find(event =>
      event.type === 'matos.session.completed' ||
      event.type === 'matos.session.failed',
    )
  const assetKeys = new Set(
    input.events
      .filter(event => event.type === 'matos.asset.loaded')
      .map(event =>
        stringValue(event.data.canonicalKey) ??
        `${stringValue(event.data.type) ?? 'asset'}:${stringValue(event.data.id) ?? ''}`,
      )
      .filter(Boolean),
  )

  return {
    sessionId: input.sessionId,
    path: input.path,
    traceId:
      stringValue(first?.traceId) ??
      stringValue(firstData.traceId) ??
      input.sessionId,
    userId: stringValue(first?.userId) ?? stringValue(firstData.userId),
    scopeRef: stringValue(first?.scopeRef) ?? stringValue(firstData.scopeRef),
    workspaceId:
      stringValue(first?.workspaceId) ?? stringValue(firstData.workspaceId),
    runtimeRef:
      stringValue(first?.runtimeRef) ?? stringValue(firstData.runtimeRef),
    execution:
      stringValue(first?.execution) ?? stringValue(firstData.execution),
    roleRef: stringValue(first?.roleRef) ?? stringValue(firstData.roleRef),
    command: stringValue(firstData.command),
    cwd: stringValue(firstData.cwd),
    startedAt: first?.timestamp,
    lastEventAt: lastVisible?.timestamp,
    lastEventType: lastVisible?.type,
    eventCount: input.events.length,
    turnCount: input.events.filter(event => event.type === 'matos.turn.started')
      .length,
    assetCount: assetKeys.size,
    assetUsageCount: input.events.filter(
      event => event.type === 'matos.asset.used',
    ).length,
    toolCallCount: countUniqueToolCalls(input.events),
    totalCostUsd: numberValue(completion?.data.totalCostUsd),
    durationMs: numberValue(completion?.data.durationMs),
    numTurns: numberValue(completion?.data.numTurns),
    status: sessionStatus(input.events),
    hidden: sessionHidden(input.events),
  }
}

export async function readMatOSSessionEvents(
  cwd: string,
  sessionId: string,
): Promise<MatOSEvent[]> {
  const filePath = join(resolveMatOSSessionsDir(cwd), `${sessionId}.jsonl`)
  return parseJsonlEvents(await readFile(filePath, 'utf8'))
}

export async function readMatOSSessionEventsFromPath(
  path: string,
): Promise<MatOSEvent[]> {
  return parseJsonlEvents(await readFile(path, 'utf8'))
}

export async function listMatOSSessionsFromDir(
  sessionsDir: string,
): Promise<MatOSSessionSummary[]> {
  if (!(await pathExists(sessionsDir))) {
    return []
  }

  // Listings are the natural off-hot-path trigger for reclaiming crash
  // residue (orphaned append locks / writer registries): fire-and-forget,
  // throttled, and age-gated so live appends are never raced.
  maybeSweepMatOSSessionAppendResidue(sessionsDir)

  const entries = await readdir(sessionsDir, { withFileTypes: true })
  const summaries: MatOSSessionSummary[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }

    const sessionId = entry.name.slice(0, -'.jsonl'.length)
    const path = join(sessionsDir, entry.name)
    // A session file can vanish or become unreadable between readdir and
    // readFile (retention/cleanup races); skip it instead of failing the
    // whole listing.
    const raw = await readFile(path, 'utf8').catch(() => undefined)
    if (raw === undefined) {
      continue
    }
    summaries.push(
      summaryFromSessionEvents({ sessionId, path, events: parseJsonlEvents(raw) }),
    )
  }

  return summaries.sort((a, b) =>
    (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''),
  )
}

export async function listMatOSSessions(
  cwd: string,
): Promise<MatOSSessionSummary[]> {
  const sessionsDir = resolveMatOSSessionsDir(cwd)
  return listMatOSSessionsFromDir(sessionsDir)
}

export function summarizeMatOSTraces(
  sessions: MatOSSessionSummary[],
  workflowEventCounts: Record<string, number> = {},
): MatOSTraceSummary[] {
  const traces = new Map<string, MatOSTraceSummary>()

  for (const session of sessions) {
    const traceId = session.traceId ?? session.sessionId
    const current = traces.get(traceId)
    if (!current) {
      traces.set(traceId, {
        traceId,
        sessionIds: [session.sessionId],
        paths: [session.path],
        userId: session.userId,
        scopeRef: session.scopeRef,
        workspaceId: session.workspaceId,
        runtimeRef: session.runtimeRef,
        execution: session.execution,
        roleRef: session.roleRef,
        command: session.command,
        cwd: session.cwd,
        startedAt: session.startedAt,
        lastEventAt: session.lastEventAt,
        lastEventType: session.lastEventType,
        eventCount: session.eventCount,
        turnCount: session.turnCount,
        assetCount: session.assetCount,
        assetUsageCount: session.assetUsageCount,
        toolCallCount: session.toolCallCount,
        workflowEventCount: workflowEventCounts[traceId] ?? 0,
        totalCostUsd: session.totalCostUsd,
        durationMs: session.durationMs,
        numTurns: session.numTurns,
        status: session.status,
        hidden: session.hidden,
      })
      continue
    }

    current.sessionIds.push(session.sessionId)
    current.paths.push(session.path)
    current.userId ??= session.userId
    current.scopeRef ??= session.scopeRef
    current.workspaceId ??= session.workspaceId
    current.runtimeRef ??= session.runtimeRef
    current.execution ??= session.execution
    current.roleRef ??= session.roleRef
    current.command ??= session.command
    current.cwd ??= session.cwd
    current.startedAt =
      [current.startedAt, session.startedAt].filter(Boolean).sort()[0] ??
      current.startedAt
    if ((session.lastEventAt ?? '') > (current.lastEventAt ?? '')) {
      current.lastEventAt = session.lastEventAt
      current.lastEventType = session.lastEventType
    }
    current.eventCount += session.eventCount
    current.turnCount += session.turnCount
    current.assetCount += session.assetCount
    current.assetUsageCount += session.assetUsageCount
    current.toolCallCount += session.toolCallCount
    current.workflowEventCount = workflowEventCounts[traceId] ?? current.workflowEventCount
    current.totalCostUsd =
      current.totalCostUsd === undefined && session.totalCostUsd === undefined
        ? undefined
        : (current.totalCostUsd ?? 0) + (session.totalCostUsd ?? 0)
    current.durationMs =
      current.durationMs === undefined && session.durationMs === undefined
        ? undefined
        : (current.durationMs ?? 0) + (session.durationMs ?? 0)
    current.numTurns =
      current.numTurns === undefined && session.numTurns === undefined
        ? undefined
        : (current.numTurns ?? 0) + (session.numTurns ?? 0)
    if (current.status !== 'failed') {
      current.status =
        session.status === 'failed'
          ? 'failed'
          : session.status === 'completed' && current.status !== 'running'
            ? 'completed'
            : current.status
    }
    current.hidden = current.hidden && session.hidden
  }

  for (const [traceId, count] of Object.entries(workflowEventCounts)) {
    const current = traces.get(traceId)
    if (current) {
      current.workflowEventCount = count
      continue
    }
    traces.set(traceId, {
      traceId,
      sessionIds: [],
      paths: [],
      userId: undefined,
      scopeRef: undefined,
      workspaceId: undefined,
      runtimeRef: undefined,
      execution: undefined,
      roleRef: undefined,
      command: undefined,
      cwd: undefined,
      startedAt: undefined,
      lastEventAt: undefined,
      lastEventType: undefined,
      eventCount: 0,
      turnCount: 0,
      assetCount: 0,
      assetUsageCount: 0,
      toolCallCount: 0,
      workflowEventCount: count,
      totalCostUsd: undefined,
      durationMs: undefined,
      numTurns: undefined,
      status: undefined,
      hidden: false,
    })
  }

  return [...traces.values()].sort((a, b) =>
    (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''),
  )
}

export async function readMatOSSessionEventSources(
  sessions: MatOSSessionSummary[],
  id: string,
): Promise<MatOSEventSource[]> {
  const events: MatOSEventSource[] = []
  for (const session of sessions) {
    if (session.sessionId !== id && session.traceId !== id) {
      continue
    }
    for (const event of await readMatOSSessionEventsFromPath(session.path)) {
      events.push({ ...event, sourcePath: session.path })
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}
