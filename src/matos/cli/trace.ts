import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readMatOSProjectConfig } from '../project.js'
import { resolveMatOSRuntimeScope } from '../runtime/scopes.js'
import type {
  MatOSEventSource,
  MatOSSessionSummary,
  MatOSTraceSummary,
  MatOSWorkflowTraceEvent,
} from '../sessions/eventTypes.js'
import { resolveMatOSSessionsDir } from '../sessions/sessionPaths.js'
import {
  listMatOSSessionsFromDir,
  readMatOSSessionEventSources,
  summarizeMatOSTraces,
} from '../sessions/sessionIndex.js'

type MatOSTraceIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

type ParsedTraceArgs = {
  positionals: string[]
  json: boolean
  scope?: string
}

export type TraceSources = {
  sessionDirs: string[]
  workflowRunsDirs: string[]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function parseArgs(args: string[]): ParsedTraceArgs {
  const parsed: ParsedTraceArgs = { positionals: [], json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--scope') {
      parsed.scope = args[index + 1]
      index += 1
      continue
    }
    if (arg?.startsWith('--scope=')) {
      parsed.scope = arg.slice('--scope='.length)
      continue
    }
    if (arg) {
      parsed.positionals.push(arg)
    }
  }
  return parsed
}

function writeJson(io: MatOSTraceIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`)
}

async function resolveTraceSources(
  cwd: string,
  scopeRef?: string,
): Promise<TraceSources> {
  const sessionDirs = new Set<string>([resolveMatOSSessionsDir(cwd)])
  const workflowRunsDirs = new Set<string>()
  const config = await readMatOSProjectConfig(cwd)

  for (const ref of [scopeRef, scopeRef ? undefined : 'user:local']) {
    if (!ref && scopeRef) {
      continue
    }
    const scope = resolveMatOSRuntimeScope(cwd, {
      scopeRef: ref,
      runtimeDataDir: config.execution?.runtimeDataDir,
    })
    sessionDirs.add(scope.sessionsDir)
    workflowRunsDirs.add(scope.workflowRunsDir)
  }

  return {
    sessionDirs: [...sessionDirs],
    workflowRunsDirs: [...workflowRunsDirs],
  }
}

async function listTraceSessions(
  sources: TraceSources,
): Promise<MatOSSessionSummary[]> {
  const sessions = await Promise.all(
    sources.sessionDirs.map(dir => listMatOSSessionsFromDir(dir)),
  )
  return sessions.flat().sort((a, b) =>
    (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''),
  )
}

function parseWorkflowJsonl(raw: string): Array<{
  id: string
  timestamp: string
  type: string
  data?: Record<string, unknown>
  trace?: MatOSWorkflowTraceEvent['trace']
}> {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as {
      id: string
      timestamp: string
      type: string
      data?: Record<string, unknown>
      trace?: MatOSWorkflowTraceEvent['trace']
    })
}

async function listWorkflowTraceEvents(
  sources: TraceSources,
  traceId?: string,
): Promise<MatOSWorkflowTraceEvent[]> {
  const events: MatOSWorkflowTraceEvent[] = []
  for (const runsDir of sources.workflowRunsDirs) {
    if (!(await pathExists(runsDir))) {
      continue
    }
    const entries = await readdir(runsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const sourcePath = join(runsDir, entry.name, 'events.jsonl')
      if (!(await pathExists(sourcePath))) {
        continue
      }
      for (const event of parseWorkflowJsonl(await readFile(sourcePath, 'utf8'))) {
        if (!event.trace?.traceId) {
          continue
        }
        if (traceId && event.trace.traceId !== traceId) {
          continue
        }
        events.push({
          id: event.id,
          timestamp: event.timestamp,
          type: event.type,
          data: event.data ?? {},
          trace: event.trace,
          sourcePath,
          runId: basename(join(sourcePath, '..')),
        })
      }
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

function workflowEventCounts(
  workflowEvents: MatOSWorkflowTraceEvent[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of workflowEvents) {
    const traceId = event.trace?.traceId
    if (!traceId) {
      continue
    }
    counts[traceId] = (counts[traceId] ?? 0) + 1
  }
  return counts
}

function findTrace(
  traces: MatOSTraceSummary[],
  id: string,
): MatOSTraceSummary | undefined {
  return traces.find(
    trace => trace.traceId === id || trace.sessionIds.includes(id),
  )
}

export async function loadTraceBundle(input: {
  cwd: string
  id?: string
  scope?: string
}): Promise<{
  sources: TraceSources
  sessions: MatOSSessionSummary[]
  workflowEvents: MatOSWorkflowTraceEvent[]
  traces: MatOSTraceSummary[]
}> {
  const sources = await resolveTraceSources(input.cwd, input.scope)
  const sessions = await listTraceSessions(sources)
  const allWorkflowEvents = await listWorkflowTraceEvents(sources)
  const workflowEvents = input.id
    ? allWorkflowEvents.filter(event => event.trace?.traceId === input.id)
    : allWorkflowEvents
  const traces = summarizeMatOSTraces(
    sessions,
    workflowEventCounts(allWorkflowEvents),
  )
  return { sources, sessions, workflowEvents, traces }
}

function printHelp(io: MatOSTraceIO): void {
  io.stdout(`Usage:
  matos trace list [--scope <scope-ref>] [--json]
  matos trace show <trace-id|session-id> [--scope <scope-ref>] [--json]
  matos trace export <trace-id|session-id> [--scope <scope-ref>] [--json]
  matos trace audit <trace-id|session-id> [--scope <scope-ref>] [--json]
  matos trace doctor [--scope <scope-ref>] [--json]
`)
}

type TraceAuditIssue = {
  code: string
  severity: 'error' | 'warning'
  message: string
  turnId?: string
  toolUseId?: string
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function eventTurnId(event: MatOSEventSource): string | undefined {
  return stringValue(event.turnId) ?? stringValue(event.data.turnId)
}

function auditTraceLifecycle(input: {
  trace: MatOSTraceSummary
  events: MatOSEventSource[]
  workflowEvents: MatOSWorkflowTraceEvent[]
}): {
  ok: boolean
  traceId: string
  turnIds: string[]
  issues: TraceAuditIssue[]
  counts: Record<string, number>
} {
  const issues: TraceAuditIssue[] = []
  const events = input.events
  const count = (type: string): number =>
    events.filter(event => event.type === type).length
  const workspaceEventCount = events.filter(event =>
    event.type.startsWith('matos.workspace.'),
  ).length

  if (count('matos.session.started') === 0 && input.trace.paths.length > 0) {
    issues.push({
      code: 'missing_session_started',
      severity: 'error',
      message: 'Trace has session JSONL evidence but no matos.session.started event.',
    })
  }

  if (
    input.trace.status === 'completed' &&
    count('matos.session.completed') === 0
  ) {
    issues.push({
      code: 'missing_session_completed',
      severity: 'error',
      message: 'Trace summary is completed but no matos.session.completed event was found.',
    })
  }

  const turnEvents = events.filter(event => event.type.startsWith('matos.turn.'))
  const turnIds = [
    ...new Set(turnEvents.map(eventTurnId).filter((id): id is string => Boolean(id))),
  ]
  if (count('matos.turn.started') === 0 && workspaceEventCount === 0) {
    issues.push({
      code: 'missing_turn_started',
      severity: 'error',
      message: 'Trace has no matos.turn.started event.',
    })
  }

  if (turnIds.length === 0 && turnEvents.length > 0) {
    issues.push({
      code: 'missing_turn_ids',
      severity: 'error',
      message: 'Turn lifecycle events exist but do not carry a turnId.',
    })
  }

  for (const turnId of turnIds) {
    const perTurn = events.filter(event => eventTurnId(event) === turnId)
    const countTurn = (type: string): number =>
      perTurn.filter(event => event.type === type).length
    if (countTurn('matos.turn.started') > 1) {
      issues.push({
        code: 'duplicate_turn_started',
        severity: 'error',
        turnId,
        message: `Turn ${turnId} has multiple matos.turn.started events.`,
      })
    }
    if (countTurn('matos.turn.context.assembled') === 0) {
      issues.push({
        code: 'missing_turn_context',
        severity: 'error',
        turnId,
        message: `Turn ${turnId} has no matos.turn.context.assembled event.`,
      })
    }
    if (countTurn('matos.turn.completed') === 0) {
      issues.push({
        code: 'missing_turn_completed',
        severity: 'error',
        turnId,
        message: `Turn ${turnId} has no matos.turn.completed event.`,
      })
    }
  }

  const toolStarts = new Set<string>()
  const toolCompletes = new Set<string>()
  for (const event of events) {
    if (
      event.type !== 'matos.tool.call.started' &&
      event.type !== 'matos.tool.call.completed'
    ) {
      continue
    }
    const toolUseId = stringValue(event.data.toolUseId)
    if (!toolUseId) {
      continue
    }
    if (event.type === 'matos.tool.call.started') {
      toolStarts.add(toolUseId)
    } else {
      toolCompletes.add(toolUseId)
    }
  }
  for (const toolUseId of toolStarts) {
    if (!toolCompletes.has(toolUseId)) {
      issues.push({
        code: 'unclosed_tool_call',
        severity: 'error',
        toolUseId,
        message: `Tool call ${toolUseId} has no matos.tool.call.completed event.`,
      })
    }
  }

  return {
    ok: !issues.some(issue => issue.severity === 'error'),
    traceId: input.trace.traceId,
    turnIds,
    issues,
    counts: {
      sessions: input.trace.sessionIds.length,
      events: events.length,
      workflowEvents: input.workflowEvents.length,
      turnStarted: count('matos.turn.started'),
      turnContext: count('matos.turn.context.assembled'),
      turnCompleted: count('matos.turn.completed'),
      agentMessages: count('matos.agent.message'),
      toolStarted: count('matos.tool.call.started'),
      toolCompleted: count('matos.tool.call.completed'),
      workspaceEvents: workspaceEventCount,
    },
  }
}

export async function runMatOSTraceCommand(
  args: string[],
  io: MatOSTraceIO,
): Promise<number> {
  const parsed = parseArgs(args)
  const subcommand = parsed.positionals[0] ?? 'list'

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp(io)
    return 0
  }

  if (subcommand === 'list') {
    const bundle = await loadTraceBundle({ cwd: io.cwd, scope: parsed.scope })
    const traces = bundle.traces.filter(trace => !trace.hidden)
    if (parsed.json) {
      writeJson(io, { traces, sources: bundle.sources })
      return 0
    }
    if (traces.length === 0) {
      io.stdout('No MatOS traces found\n')
      return 0
    }
    for (const trace of traces) {
      io.stdout(
        `${trace.traceId}\t${trace.status ?? 'unknown'}\t${trace.userId ?? ''}\t${trace.lastEventAt ?? ''}\n`,
      )
    }
    return 0
  }

  if (subcommand === 'show' || subcommand === 'export') {
    const id = parsed.positionals[1]
    if (!id) {
      io.stderr(`Usage: matos trace ${subcommand} <trace-id|session-id>\n`)
      return 1
    }
    const bundle = await loadTraceBundle({
      cwd: io.cwd,
      id,
      scope: parsed.scope,
    })
    const trace = findTrace(bundle.traces, id)
    if (!trace) {
      io.stderr(`MatOS trace not found: ${id}\n`)
      return 1
    }
    const events = await readMatOSSessionEventSources(bundle.sessions, id)
    const workflowEvents =
      trace.traceId === id
        ? bundle.workflowEvents
        : await listWorkflowTraceEvents(bundle.sources, trace.traceId)
    if (parsed.json || subcommand === 'export') {
      writeJson(io, { trace, events, workflowEvents, sources: bundle.sources })
      return 0
    }
    io.stdout(`${trace.traceId}\t${trace.status ?? 'unknown'}\n`)
    for (const event of events) {
      io.stdout(`${event.timestamp}\t${event.type}\t${event.sourcePath}\n`)
    }
    for (const event of workflowEvents) {
      io.stdout(`${event.timestamp}\t${event.type}\t${event.sourcePath}\n`)
    }
    return 0
  }

  if (subcommand === 'audit') {
    const id = parsed.positionals[1]
    if (!id) {
      io.stderr('Usage: matos trace audit <trace-id|session-id>\n')
      return 1
    }
    const bundle = await loadTraceBundle({
      cwd: io.cwd,
      id,
      scope: parsed.scope,
    })
    const trace = findTrace(bundle.traces, id)
    if (!trace) {
      io.stderr(`MatOS trace not found: ${id}\n`)
      return 1
    }
    const events = await readMatOSSessionEventSources(bundle.sessions, id)
    const workflowEvents =
      trace.traceId === id
        ? bundle.workflowEvents
        : await listWorkflowTraceEvents(bundle.sources, trace.traceId)
    const audit = auditTraceLifecycle({ trace, events, workflowEvents })
    if (parsed.json) {
      writeJson(io, audit)
      return audit.ok ? 0 : 1
    }
    if (audit.ok) {
      io.stdout(
        `ok\ttrace=${audit.traceId}\tturns=${audit.turnIds.length}\tissues=0\n`,
      )
      return 0
    }
    for (const issue of audit.issues) {
      io.stdout(
        `${issue.severity}\t${issue.code}\t${issue.turnId ?? issue.toolUseId ?? ''}\t${issue.message}\n`,
      )
    }
    return 1
  }

  if (subcommand === 'doctor') {
    const bundle = await loadTraceBundle({ cwd: io.cwd, scope: parsed.scope })
    const result = {
      ok: true,
      sources: bundle.sources,
      sessionCount: bundle.sessions.length,
      traceCount: bundle.traces.length,
      workflowEventCount: bundle.workflowEvents.length,
      note:
        'MatOS trace indexes existing MatOS session JSONL and trace-linked workflow events; agent transcripts stay in the DeepSeek Harness session store.',
    }
    if (parsed.json) {
      writeJson(io, result)
      return 0
    }
    io.stdout(
      `ok\ttraces=${result.traceCount}\tsessions=${result.sessionCount}\tworkflowEvents=${result.workflowEventCount}\n`,
    )
    return 0
  }

  io.stderr(`Unknown matos trace command: ${subcommand}\n`)
  return 1
}
