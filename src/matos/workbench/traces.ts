import { readFile } from 'node:fs/promises'
import { loadTraceBundle } from '../cli/trace.js'
import type {
MatOSEvent,
MatOSEventSource,
MatOSSessionSummary,
MatOSTraceSummary
} from '../sessions/eventTypes.js'
import { readMatOSSessionEventSources } from '../sessions/sessionIndex.js'
import {
redactMatOSWorkbenchString
} from './redaction.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchTraceList,
MatOSWorkbenchTraceLiveView,
MatOSWorkbenchTraceTailView,
MatOSWorkbenchTraceToolCall,
MatOSWorkbenchTraceTranscriptView,
MatOSWorkbenchTraceView,
MatOSWorkbenchTranscriptLink
} from './types.js'

import {
applyQuery,
buildToolCalls,
enrichTranscriptLinks,
findTrace,
latestSessionId,
linkedTranscriptLinks,
readOperatorTranscriptLines,
readTraceLiveJobOutput,
redactDaemonJobRecord,
redactMatOSEventSource,
redactMatOSWorkflowEvent,
resolveTraceDaemonJobs,
safeSessionJsonlPath,
safeWorkspaceRegularFileAbsolutePath,
sessionTranscriptLink,
stringValue,
traceActions,
traceLivePollContract,
traceMessageFromEvent,
traceResource,
workflowArtifactLinks,
workflowMessageFromEvent,
} from './traceViewModels.js'

export async function listMatOSWorkbenchTraces(
  input: MatOSWorkbenchContext & {
    query?: string
    limit?: number
    offset?: number
    includeHidden?: boolean
  },
): Promise<MatOSWorkbenchTraceList> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const offset = Math.max(0, input.offset ?? 0)
  const bundle = await loadTraceBundle({
    cwd: input.cwd,
    scope: input.scopeRef,
  })
  const visible = bundle.traces.filter(trace => input.includeHidden || !trace.hidden)
  const filtered = applyQuery(visible, input.query)
  const page = filtered.slice(offset, offset + limit)
  return {
    traces: page,
    resources: page.map(traceResource),
    sources: bundle.sources,
    summary: {
      count: page.length,
      total: filtered.length,
      offset,
      limit,
    },
  }
}

export async function showMatOSWorkbenchTrace(
  input: MatOSWorkbenchContext & { id: string },
): Promise<MatOSWorkbenchTraceView> {
  const bundle = await loadTraceBundle({
    cwd: input.cwd,
    scope: input.scopeRef,
  })
  const trace = findTrace(bundle.traces, input.id)
  if (!trace || trace.hidden) {
    throw new Error(`MatOS trace not found: ${input.id}`)
  }
  const sessionEvents = await readMatOSSessionEventSources(bundle.sessions, input.id)
  const visibleSessionEvents = sessionEvents.map(redactMatOSEventSource)
  const workflowEvents = bundle.workflowEvents.filter(
    event => event.trace?.traceId === trace.traceId,
  )
  const visibleWorkflowEvents = workflowEvents.map(redactMatOSWorkflowEvent)
  const messages = [
    ...visibleSessionEvents.map(traceMessageFromEvent),
    ...visibleWorkflowEvents.map(workflowMessageFromEvent),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const sessions = bundle.sessions.filter(
    session =>
      session.traceId === trace.traceId ||
      trace.sessionIds.includes(session.sessionId),
  )
  const toolCalls = buildToolCalls(visibleSessionEvents)
  const transcriptLinks = await enrichTranscriptLinks(input.cwd, [
    ...sessions.map(session => sessionTranscriptLink(input.cwd, session)),
    ...linkedTranscriptLinks(input.cwd, visibleSessionEvents),
  ])
  const artifactLinks = workflowArtifactLinks(input.cwd, trace.traceId, visibleWorkflowEvents)
  const sessionId = latestSessionId(trace, sessions, input.id)
  return {
    id: trace.traceId,
    trace,
    sessions,
    events: visibleSessionEvents,
    workflowEvents: visibleWorkflowEvents,
    transcriptLinks,
    artifactLinks,
    messages,
    toolCalls,
    live: traceLivePollContract({
      trace,
      sessionId,
      sessionOffset: visibleSessionEvents.length,
    }),
    summary: {
      eventCount: visibleSessionEvents.length,
      workflowEventCount: visibleWorkflowEvents.length,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      transcriptLinkCount: transcriptLinks.length,
      transcriptPreviewCount: transcriptLinks.filter(link => link.preview).length,
      artifactLinkCount: artifactLinks.length,
    },
    actions: traceActions(trace.traceId),
  }
}

export async function liveMatOSWorkbenchTrace(
  input: MatOSWorkbenchContext & {
    id: string
    sessionOffset?: number
    jobOutputOffset?: number
    jobId?: string
    limit?: number
  },
): Promise<MatOSWorkbenchTraceLiveView> {
  const requestedId = stringValue(input.id)
  if (!requestedId) {
    throw new Error('MatOS trace live debug requires a trace id or session id')
  }
  let traceView: MatOSWorkbenchTraceView | undefined
  try {
    traceView = await showMatOSWorkbenchTrace({ ...input, id: requestedId })
  } catch (error) {
    const bundle = await loadTraceBundle({
      cwd: input.cwd,
      scope: input.scopeRef,
    })
    if (findTrace(bundle.traces, requestedId)?.hidden) {
      throw error
    }
    try {
      await readFile(safeSessionJsonlPath(input.cwd, requestedId), 'utf8')
    } catch {
      throw error
    }
  }
  const trace = traceView?.trace as MatOSTraceSummary | undefined
  const sessions = (traceView?.sessions ?? []) as MatOSSessionSummary[]
  const sessionId =
    latestSessionId(trace, sessions, requestedId) ??
    stringValue(input.id)
  const sessionTail = sessionId
    ? await tailMatOSWorkbenchTrace({
        ...input,
        sessionId,
        offset: input.sessionOffset,
        limit: input.limit,
      })
    : undefined
  const daemonJobs = await resolveTraceDaemonJobs({
    env: input.env,
    traceId: trace?.traceId ?? (traceView ? traceView.id : requestedId),
    sessionId,
    jobId: input.jobId,
  })
  const safeJobs = daemonJobs.jobs.map(redactDaemonJobRecord)
  const selectedJob = input.jobId
    ? safeJobs.find(job => job.jobId === input.jobId)
    : safeJobs[0]
  const outputChunk = selectedJob
    ? await readTraceLiveJobOutput({
        env: input.env,
        job: selectedJob,
        offset: input.jobOutputOffset,
        limit: input.limit ? input.limit * 1024 : undefined,
      })
    : undefined
  const messages = sessionTail?.messages ?? []
  const nextSessionOffset = sessionTail?.nextOffset ?? input.sessionOffset ?? 0
  const nextJobOutputOffset = outputChunk?.nextOffset ?? input.jobOutputOffset ?? 0
  // When a session tail exists, its done flag already encodes "terminated and
  // fully consumed"; trusting the indexed trace status alone would stop
  // pollers while tail backlog is still being paginated out.
  const traceDone = sessionTail
    ? sessionTail.done === true
    : trace?.status === 'completed' || trace?.status === 'failed'
  const jobDone = selectedJob ? outputChunk?.done === true : true
  return {
    mode: 'native-trace-live-debug',
    readonly: true,
    id: trace?.traceId ?? requestedId,
    ...(trace?.traceId ? { traceId: trace.traceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(selectedJob ? { jobId: selectedJob.jobId } : {}),
    ...(trace ? { trace } : {}),
    ...(sessionTail ? { sessionTail } : {}),
    jobs: safeJobs.slice(0, 10),
    ...(selectedJob ? { selectedJob } : {}),
    ...(outputChunk ? { outputChunk } : {}),
    messages,
    cursors: {
      sessionOffset: sessionTail?.offset ?? input.sessionOffset ?? 0,
      nextSessionOffset,
      jobOutputOffset: outputChunk?.offset ?? input.jobOutputOffset ?? 0,
      nextJobOutputOffset,
    },
    done: traceDone && jobDone,
    summary: {
      source: 'matos-trace-live-debug',
      ...(sessionTail ? { sessionSource: 'matos-session-jsonl' } : {}),
      jobSource: daemonJobs.source,
      ...(outputChunk ? { outputSource: 'matos-daemon-job-output' } : {}),
      returnedMessageCount: messages.length,
      jobOutputLength: outputChunk?.content.length ?? 0,
      totalSessionEventCount: sessionTail?.eventCount ?? 0,
      jobCount: safeJobs.length,
      ...(daemonJobs.daemonError
        ? { daemonError: redactMatOSWorkbenchString(daemonJobs.daemonError).value }
        : {}),
      redacted: outputChunk?.redacted === true,
      truncated: outputChunk?.truncated === true,
    },
    actions: traceActions(trace?.traceId ?? requestedId),
  }
}

// Tool telemetry scans many traces but only needs each trace's tool calls.
// `showMatOSWorkbenchTrace` reloads the whole trace bundle (and enriches
// transcript links from disk) on every call, which makes a 100-trace scan
// O(N) full-bundle reloads. This helper loads the bundle once and extracts
// only tool calls per trace, so telemetry stays responsive.
export async function listMatOSWorkbenchTraceToolCalls(
  input: MatOSWorkbenchContext & {
    query?: string
    limit?: number
    offset?: number
    includeHidden?: boolean
  },
): Promise<
  Array<{
    traceId: string
    trace: MatOSTraceSummary
    toolCalls: MatOSWorkbenchTraceToolCall[]
  }>
> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const offset = Math.max(0, input.offset ?? 0)
  const bundle = await loadTraceBundle({
    cwd: input.cwd,
    scope: input.scopeRef,
  })
  const visible = bundle.traces.filter(
    trace => input.includeHidden || !trace.hidden,
  )
  const filtered = applyQuery(visible, input.query)
  const page = filtered.slice(offset, offset + limit)
  return Promise.all(
    page.map(async trace => {
      const sessionEvents = await readMatOSSessionEventSources(
        bundle.sessions,
        trace.traceId,
      )
      return {
        traceId: trace.traceId,
        trace,
        toolCalls: buildToolCalls(sessionEvents),
      }
    }),
  )
}

function transcriptLinkMatches(
  link: MatOSWorkbenchTranscriptLink,
  selector?: string,
): boolean {
  if (!selector) {
    return link.readable === true
  }
  return [
    link.id,
    link.sessionId,
    link.path,
    link.relativePath,
    link.source,
  ].some(value => {
    const text = stringValue(value)
    return text === selector || (text ? text.startsWith(selector) : false)
  })
}

const TRACE_TAIL_TERMINAL_EVENT_TYPES = new Set([
  'matos.turn.completed',
  'matos.session.completed',
  'matos.session.failed',
])

/**
 * Incrementally tail a live session transcript by event offset. Reads the
 * session JSONL directly (not the indexed trace bundle) so an in-progress run
 * is visible immediately, and ignores a partial trailing line written during
 * live appending. Designed for cheap polling from the Coze Trace timeline.
 */
export async function tailMatOSWorkbenchTrace(
  input: MatOSWorkbenchContext & {
    sessionId: string
    offset?: number
    limit?: number
  },
): Promise<MatOSWorkbenchTraceTailView> {
  const sessionId = stringValue(input.sessionId)
  if (!sessionId) {
    throw new Error('MatOS trace tail requires a sessionId')
  }
  const requestedOffset =
    Number.isInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 0
  const limit =
    Number.isInteger(input.limit) && Number(input.limit) > 0
      ? Math.min(Number(input.limit), 500)
      : 200
  const path = safeSessionJsonlPath(input.cwd, sessionId)
  let raw = ''
  let exists = true
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      exists = false
    } else {
      throw error
    }
  }
  const events: MatOSEventSource[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as MatOSEvent
      events.push(redactMatOSEventSource({ ...parsed, sourcePath: path }))
    } catch {
      // Ignore a partial trailing line written during live appending.
    }
  }
  const offset = Math.min(requestedOffset, events.length)
  const messages = events.slice(offset, offset + limit).map(traceMessageFromEvent)
  // The next cursor must advance only past the returned batch; jumping to
  // events.length would silently skip everything truncated by the limit.
  const nextOffset = offset + messages.length
  // A tail is done only when the session has terminated AND the caller has
  // consumed every event; otherwise pollers stop with backlog remaining.
  const terminated = events.some(event => TRACE_TAIL_TERMINAL_EVENT_TYPES.has(event.type))
  const done = terminated && nextOffset >= events.length
  return {
    mode: 'native-trace-tail',
    readonly: true,
    sessionId,
    exists,
    offset,
    nextOffset,
    eventCount: events.length,
    messages,
    done,
    summary: {
      source: 'matos-session-jsonl',
      sessionId,
      returned: messages.length,
      total: events.length,
      ...(done ? { done: true } : {}),
    },
  }
}

export async function showMatOSWorkbenchTraceTranscript(
  input: MatOSWorkbenchContext & {
    id: string
    transcriptId?: string
    viewerMode?: 'user' | 'operator'
    limit?: number
  },
): Promise<MatOSWorkbenchTraceTranscriptView> {
  if (input.viewerMode !== 'operator') {
    throw new Error('MatOS trace transcript raw/debug view is operator-only.')
  }
  const traceView = await showMatOSWorkbenchTrace(input)
  const link = traceView.transcriptLinks.find(candidate =>
    transcriptLinkMatches(candidate, input.transcriptId),
  )
  if (!link) {
    throw new Error(`MatOS transcript link not found for trace ${input.id}.`)
  }
  const candidatePath = stringValue(link.relativePath) ?? stringValue(link.path)
  if (!candidatePath) {
    throw new Error(`MatOS transcript link has no readable workspace path: ${link.id}`)
  }
  const absolute = await safeWorkspaceRegularFileAbsolutePath(input.cwd, candidatePath)
  if (!absolute) {
    throw new Error(`MatOS transcript path is not a regular workspace-local file: ${link.id}`)
  }
  const raw = await readOperatorTranscriptLines(absolute, {
    lineLimit: input.limit,
  })
  return {
    mode: 'operator-transcript-view',
    viewerMode: 'operator',
    id: traceView.id,
    traceId: traceView.id,
    sessionId: link.sessionId,
    linkId: link.id,
    source: link.source,
    label: link.label,
    ...(link.path ? { path: link.path } : {}),
    ...(link.relativePath ? { relativePath: link.relativePath } : {}),
    readable: true,
    lines: raw.lines,
    summary: {
      lineCount: raw.lines.length,
      parsedLineCount: raw.lines.filter(line => line.parsed !== undefined).length,
      redactedLineCount: raw.lines.filter(line => line.redacted).length,
      truncated: raw.truncated,
      byteLimit: raw.byteLimit,
    },
    transcriptLink: link,
    actions: traceActions(traceView.id),
  }
}
