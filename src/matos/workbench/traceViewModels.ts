import { lstat,open,realpath } from 'node:fs/promises'
import { isAbsolute,relative,resolve } from 'node:path'
import type {
MatOSEventSource,
MatOSSessionSummary,
MatOSTraceSummary,
MatOSWorkflowTraceEvent
} from '../sessions/eventTypes.js'
import { resolveMatOSSessionsDir } from '../sessions/sessionPaths.js'
import {
DEFAULT_MATOS_DAEMON_SOCKET,
DEFAULT_MATOS_DAEMON_TOKEN_FILE,listMatOSDaemonJobs,readMatOSDaemonJobLedgerFile,
readMatOSDaemonJobOutputSlice,
resolveMatOSDaemonJobsOutputDir,
type MatOSDaemonJobRecord
} from './daemonJobs.js'
import {
redactMatOSWorkbenchString,
redactMatOSWorkbenchValue,
} from './redaction.js'
import type {
MatOSWorkbenchAction,
MatOSWorkbenchResource,
MatOSWorkbenchTraceArtifactLink,
MatOSWorkbenchTraceLiveOutputChunk,
MatOSWorkbenchTraceLivePollContract,
MatOSWorkbenchTraceMessage,
MatOSWorkbenchTraceToolCall,
MatOSWorkbenchTranscriptLink,
MatOSWorkbenchTranscriptPreview,
MatOSWorkbenchTranscriptRawLine
} from './types.js'

const TRANSCRIPT_PREVIEW_BYTE_LIMIT = 64 * 1024
const TRANSCRIPT_PREVIEW_LINE_LIMIT = 8
const TRANSCRIPT_OPERATOR_BYTE_LIMIT = 256 * 1024
const TRANSCRIPT_OPERATOR_LINE_LIMIT = 200
const SECRET_FIELD_PATTERN = /api[_-]?key|token|password|secret|authorization|credential|access[_-]?key|refresh[_-]?token/i

export function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function safeWorkspaceRelativePath(cwd: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const rel = relative(resolve(cwd), absolute).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return undefined
  }
  return rel
}

export function safeWorkspaceAbsolutePath(cwd: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  return safeWorkspaceRelativePath(cwd, absolute) ? absolute : undefined
}

export function safeSessionJsonlPath(cwd: string, sessionId: string): string {
  const normalized = stringValue(sessionId)
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    /[\\/]/.test(normalized)
  ) {
    throw new Error('MatOS trace session id is invalid')
  }
  const sessionsDir = resolve(resolveMatOSSessionsDir(cwd))
  const target = resolve(sessionsDir, `${normalized}.jsonl`)
  const relativeTarget = relative(sessionsDir, target)
  if (
    !relativeTarget ||
    relativeTarget.startsWith('..') ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error('MatOS trace session id resolves outside the session store')
  }
  return target
}

export async function safeWorkspaceRegularFileAbsolutePath(
  cwd: string,
  path: string,
): Promise<string | undefined> {
  const absolute = safeWorkspaceAbsolutePath(cwd, path)
  if (!absolute) {
    return undefined
  }
  try {
    const fileStat = await lstat(absolute)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      return undefined
    }
    const resolved = await realpath(absolute)
    return safeWorkspaceAbsolutePath(cwd, resolved)
  } catch {
    return undefined
  }
}

export function containerVisibleAbsolutePath(path: string): string | undefined {
  const absolute = isAbsolute(path) ? resolve(path) : undefined
  if (
    absolute &&
    (absolute.startsWith('/workspace/') || absolute.startsWith('/home/workspace/'))
  ) {
    return absolute
  }
  return undefined
}

type SafePathFields = {
  path?: string
  relativePath?: string
}

export function safePathFields(
  cwd: string,
  path: string,
): SafePathFields {
  const relativePath = safeWorkspaceRelativePath(cwd, path)
  if (relativePath) {
    return {
      path: relativePath,
      relativePath,
    }
  }
  const containerPath = containerVisibleAbsolutePath(path)
  return containerPath ? { path: containerPath } : {}
}

export function redactTranscriptPreviewLine(line: string): { line: string; redacted: boolean } {
  let redacted = false
  const replacements: Array<[RegExp, string]> = [
    [
      /\b(api[_-]?key|token|password|secret|authorization|credential|access[_-]?key|refresh[_-]?token)(["']?\s*[:=]\s*["']?)[^"',}\]\n\r]+/gi,
      '$1$2[REDACTED]',
    ],
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
    [/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]'],
  ]
  let output = line
  for (const [pattern, replacement] of replacements) {
    pattern.lastIndex = 0
    const hasMatch = pattern.test(output)
    pattern.lastIndex = 0
    if (hasMatch) {
      redacted = true
    }
    output = output.replace(pattern, replacement)
  }
  return { line: output, redacted }
}

export function redactTranscriptUnknown(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    const result = redactTranscriptPreviewLine(value)
    return { value: result.line, redacted: result.redacted }
  }
  if (Array.isArray(value)) {
    let redacted = false
    const next = value.map(item => {
      const result = redactTranscriptUnknown(item)
      redacted ||= result.redacted
      return result.value
    })
    return { value: next, redacted }
  }
  if (value && typeof value === 'object') {
    let redacted = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_PATTERN.test(key)) {
        next[key] = '[REDACTED]'
        redacted = true
        continue
      }
      const result = redactTranscriptUnknown(item)
      redacted ||= result.redacted
      next[key] = result.value
    }
    return { value: next, redacted }
  }
  return { value, redacted: false }
}

export async function readTranscriptPreview(path: string): Promise<MatOSWorkbenchTranscriptPreview> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_PREVIEW_BYTE_LIMIT + 1)
    const { bytesRead } = await file.read(
      buffer,
      0,
      TRANSCRIPT_PREVIEW_BYTE_LIMIT + 1,
      0,
    )
    const byteTruncated = bytesRead > TRANSCRIPT_PREVIEW_BYTE_LIMIT
    const text = buffer
      .subarray(0, Math.min(bytesRead, TRANSCRIPT_PREVIEW_BYTE_LIMIT))
      .toString('utf8')
    const rawLines = text.split(/\r?\n/)
    const previewLines = rawLines
      .filter((line, index) => line.trim() || index < rawLines.length - 1)
      .slice(0, TRANSCRIPT_PREVIEW_LINE_LIMIT)
    let redacted = false
    const lines = previewLines.map(line => {
      const result = redactTranscriptPreviewLine(line)
      redacted ||= result.redacted
      return result.line
    })
    return {
      lines,
      lineCount: lines.length,
      truncated: byteTruncated || rawLines.length > TRANSCRIPT_PREVIEW_LINE_LIMIT,
      redacted,
      byteLimit: TRANSCRIPT_PREVIEW_BYTE_LIMIT,
    }
  } finally {
    await file.close()
  }
}

export async function readOperatorTranscriptLines(
  path: string,
  input: {
    byteLimit?: number
    lineLimit?: number
  } = {},
): Promise<{
  lines: MatOSWorkbenchTranscriptRawLine[]
  truncated: boolean
  byteLimit: number
}> {
  const byteLimit = Math.max(1, Math.min(input.byteLimit ?? TRANSCRIPT_OPERATOR_BYTE_LIMIT, TRANSCRIPT_OPERATOR_BYTE_LIMIT))
  const lineLimit = Math.max(1, Math.min(input.lineLimit ?? TRANSCRIPT_OPERATOR_LINE_LIMIT, TRANSCRIPT_OPERATOR_LINE_LIMIT))
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(byteLimit + 1)
    const { bytesRead } = await file.read(buffer, 0, byteLimit + 1, 0)
    const byteTruncated = bytesRead > byteLimit
    const text = buffer.subarray(0, Math.min(bytesRead, byteLimit)).toString('utf8')
    const rawLines = text
      .split(/\r?\n/)
      .filter((line, index, lines) => line.trim() || index < lines.length - 1)
    const outputLines = rawLines.slice(0, lineLimit).map((line, index) => {
      const textResult = redactTranscriptPreviewLine(line)
      const item: MatOSWorkbenchTranscriptRawLine = {
        lineNumber: index + 1,
        text: textResult.line,
        redacted: textResult.redacted,
      }
      try {
        const parsed = JSON.parse(line)
        const parsedResult = redactTranscriptUnknown(parsed)
        item.parsed = parsedResult.value
        item.redacted ||= parsedResult.redacted
      } catch (error) {
        item.parseError = error instanceof Error ? error.message : String(error)
      }
      return item
    })
    return {
      lines: outputLines,
      truncated: byteTruncated || rawLines.length > lineLimit,
      byteLimit,
    }
  } finally {
    await file.close()
  }
}

export async function transcriptPreviewForLink(
  cwd: string,
  link: MatOSWorkbenchTranscriptLink,
): Promise<MatOSWorkbenchTranscriptPreview | undefined> {
  const candidate =
    stringValue(link.relativePath) ??
    stringValue(link.path)
  if (!candidate) {
    return undefined
  }
  const absolute = safeWorkspaceAbsolutePath(cwd, candidate)
  if (!absolute) {
    return undefined
  }
  try {
    return await readTranscriptPreview(absolute)
  } catch {
    return undefined
  }
}

export async function enrichTranscriptLinks(
  cwd: string,
  links: MatOSWorkbenchTranscriptLink[],
): Promise<MatOSWorkbenchTranscriptLink[]> {
  return Promise.all(
    links.map(async link => {
      const preview = await transcriptPreviewForLink(cwd, link)
      return {
        ...link,
        readable: Boolean(preview),
        ...(preview ? { preview } : {}),
      }
    }),
  )
}

export function eventTurnId(event: MatOSEventSource): string | undefined {
  return stringValue(event.turnId) ?? stringValue(event.data.turnId)
}

export function redactMatOSEventSource(event: MatOSEventSource): MatOSEventSource {
  const redacted = redactTranscriptUnknown(event.data).value
  return {
    ...event,
    data: recordValue(redacted),
  }
}

export function redactMatOSWorkflowEvent(event: MatOSWorkflowTraceEvent): MatOSWorkflowTraceEvent {
  const redacted = redactTranscriptUnknown(event.data).value
  return {
    ...event,
    data: recordValue(redacted),
  }
}

export function traceActions(traceId: string): MatOSWorkbenchAction[] {
  return [
    {
      key: 'inspect',
      label: 'Inspect Trace',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['workbench', 'traces', 'show', traceId, '--json'],
        command: `matos "workbench" "traces" "show" ${JSON.stringify(traceId)} "--json"`,
      },
    },
    {
      key: 'view-trace',
      label: 'Open Native Trace',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['trace', 'show', traceId, '--json'],
        command: `matos "trace" "show" ${JSON.stringify(traceId)} "--json"`,
      },
    },
    {
      key: 'debug',
      label: 'Live Debug',
      enabled: true,
      maturity: 'route-only',
      reason:
        'Polls bounded MatOS session JSONL and role daemon job output without exposing raw transcripts.',
      command: {
        argv: ['workbench', 'traces', 'live', traceId, '--json'],
        command: `matos "workbench" "traces" "live" ${JSON.stringify(traceId)} "--json"`,
      },
    },
  ]
}

export function transcriptActions(input: {
  traceId?: string
  sessionId: string
}): MatOSWorkbenchAction[] {
  const actions: MatOSWorkbenchAction[] = [
    {
      key: 'view-transcript',
      label: 'Inspect Session Transcript',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['workbench', 'traces', 'show', input.sessionId, '--json'],
        command: `matos "workbench" "traces" "show" ${JSON.stringify(input.sessionId)} "--json"`,
      },
    },
  ]
  if (input.traceId && input.traceId !== input.sessionId) {
    actions.push({
      key: 'view-trace',
      label: 'Inspect Parent Trace',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['workbench', 'traces', 'show', input.traceId, '--json'],
        command: `matos "workbench" "traces" "show" ${JSON.stringify(input.traceId)} "--json"`,
      },
    })
  }
  return actions
}

export function sessionTranscriptLink(
  cwd: string,
  session: MatOSSessionSummary,
): MatOSWorkbenchTranscriptLink {
  const pathFields = safePathFields(cwd, session.path)
  return {
    id: `matos-session:${session.sessionId}`,
    source: 'matos-session-jsonl',
    sessionId: session.sessionId,
    ...(session.traceId ? { traceId: session.traceId } : {}),
    label: session.command
      ? `${session.sessionId} · ${session.command}`
      : session.sessionId,
    ...pathFields,
    eventCount: session.eventCount,
    ...(session.status ? { status: session.status } : {}),
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.lastEventAt ? { lastEventAt: session.lastEventAt } : {}),
    actions: transcriptActions({
      traceId: session.traceId,
      sessionId: session.sessionId,
    }),
  }
}

export function transcriptPathFromEvent(event: MatOSEventSource): string | undefined {
  return stringValue(event.data.transcriptPath) ??
    stringValue(event.data.transcript_path) ??
    stringValue(event.data.path) ??
    stringValue(event.data.file)
}

export function linkedTranscriptLinks(
  cwd: string,
  events: MatOSEventSource[],
): MatOSWorkbenchTranscriptLink[] {
  const links: MatOSWorkbenchTranscriptLink[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'matos.transcript.linked') {
      continue
    }
    const path = transcriptPathFromEvent(event)
    if (!path) {
      continue
    }
    const sessionId = stringValue(event.data.sessionId) ?? event.sessionId
    const key = `cmatos-transcript:${sessionId}:${path}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const pathFields = safePathFields(cwd, path)
    links.push({
      id: key,
      source: 'cmatos-transcript',
      sessionId,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      label:
        stringValue(event.data.label) ??
        stringValue(event.data.summary) ??
        `Agent transcript ${sessionId}`,
      ...pathFields,
      ...(event.timestamp ? { lastEventAt: event.timestamp } : {}),
      actions: transcriptActions({
        traceId: event.traceId,
        sessionId,
      }),
    })
  }
  return links
}

export function artifactActions(resourceRef?: string): MatOSWorkbenchAction[] {
  if (!resourceRef) {
    return []
  }
  return [
    {
      key: 'inspect',
      label: 'Inspect Artifact',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['workbench', 'resources', 'show', resourceRef, '--json'],
        command: `matos "workbench" "resources" "show" ${JSON.stringify(resourceRef)} "--json"`,
      },
    },
  ]
}

export function workflowEventArtifactRecord(
  event: MatOSWorkflowTraceEvent,
): Record<string, unknown> | undefined {
  const data = recordValue(event.data)
  const nested = recordValue(data.artifact)
  if (Object.keys(nested).length > 0) {
    return nested
  }
  if (event.type === 'workflow.artifact.created') {
    return data
  }
  return undefined
}

export function workflowArtifactLinks(
  cwd: string,
  traceId: string,
  workflowEvents: MatOSWorkflowTraceEvent[],
): MatOSWorkbenchTraceArtifactLink[] {
  const links: MatOSWorkbenchTraceArtifactLink[] = []
  const seen = new Set<string>()
  for (const [index, event] of workflowEvents.entries()) {
    const artifact = workflowEventArtifactRecord(event)
    if (!artifact) {
      continue
    }
    const artifactId =
      stringValue(artifact.id) ??
      stringValue(artifact.artifactId) ??
      stringValue(artifact.name) ??
      stringValue(artifact.path) ??
      `artifact-${index + 1}`
    const runId = stringValue(event.runId) ?? stringValue(artifact.runId)
    const resourceRef = runId ? `artifact:${runId}:${artifactId}` : undefined
    const key = resourceRef ?? `${traceId}:${artifactId}:${index}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const path = stringValue(artifact.path) ??
      stringValue(artifact.visiblePath) ??
      stringValue(artifact.relativePath)
    const pathFields = path ? safePathFields(cwd, path) : {}
    const nodeId = stringValue(artifact.nodeId) ?? stringValue(artifact.node_id)
    const kind = stringValue(artifact.kind) ?? stringValue(artifact.type)
    const mediaType =
      stringValue(artifact.mediaType) ??
      stringValue(artifact.media_type) ??
      stringValue(artifact.mimeType)
    const createdAt = stringValue(artifact.createdAt)
    const updatedAt = stringValue(artifact.updatedAt)
    links.push({
      id: key,
      artifactId,
      ...(resourceRef ? { resourceRef } : {}),
      ...(runId ? { runId } : {}),
      traceId,
      ...(nodeId ? { nodeId } : {}),
      name: stringValue(artifact.name) ?? stringValue(artifact.title) ?? artifactId,
      ...(kind ? { kind } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...pathFields,
      ...(typeof artifact.size === 'number' && Number.isFinite(artifact.size)
        ? { size: artifact.size }
        : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      source: 'workflow-artifact-event',
      actions: artifactActions(resourceRef),
      artifact,
    })
  }
  return links
}

export function traceResource(trace: MatOSTraceSummary): MatOSWorkbenchResource {
  return {
    id: trace.traceId,
    ref: `trace:${trace.traceId}`,
    type: 'trace',
    name: trace.command ?? trace.traceId,
    description: [
      trace.status ? `status=${trace.status}` : undefined,
      trace.roleRef ? `role=${trace.roleRef}` : undefined,
      `${trace.eventCount} events`,
      `${trace.workflowEventCount} workflow events`,
    ].filter(Boolean).join(' · '),
    scopeRef: trace.scopeRef,
    status: trace.status,
    updatedAt: trace.lastEventAt,
    owner: trace.userId ? { id: trace.userId, name: trace.userId } : undefined,
    dependencies: trace.roleRef ? [trace.roleRef] : [],
    metadata: {
      sessionIds: trace.sessionIds,
      workspaceId: trace.workspaceId,
      runtimeRef: trace.runtimeRef,
      execution: trace.execution,
      toolCallCount: trace.toolCallCount,
      turnCount: trace.turnCount,
      assetCount: trace.assetCount,
      workflowEventCount: trace.workflowEventCount,
    },
    actions: traceActions(trace.traceId),
  }
}

export function eventSummary(event: MatOSEventSource): string {
  const data = event.data ?? {}
  return stringValue(data.summary) ??
    stringValue(data.message) ??
    stringValue(data.text) ??
    stringValue(data.toolName) ??
    stringValue(data.command) ??
    event.type
}

export function messageRole(event: MatOSEventSource): MatOSWorkbenchTraceMessage['role'] {
  if (event.type === 'matos.agent.message') {
    const role = stringValue(event.data.role)
    if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
      return role
    }
    return 'assistant'
  }
  if (event.type.startsWith('matos.tool.call.')) {
    return 'tool'
  }
  if (event.type.startsWith('matos.session.') || event.type.startsWith('matos.turn.')) {
    return 'system'
  }
  return 'event'
}

export function traceMessageFromEvent(event: MatOSEventSource): MatOSWorkbenchTraceMessage {
  const redactedEvent = redactMatOSEventSource(event)
  return {
    id: event.id,
    role: messageRole(redactedEvent),
    type: event.type,
    timestamp: event.timestamp,
    ...(eventTurnId(redactedEvent) ? { turnId: eventTurnId(redactedEvent) } : {}),
    summary: eventSummary(redactedEvent),
    payload: redactedEvent.data,
    sourcePath: event.sourcePath,
  }
}

export function workflowMessageFromEvent(event: MatOSWorkflowTraceEvent): MatOSWorkbenchTraceMessage {
  const redactedEvent = redactMatOSWorkflowEvent(event)
  const redactedData = recordValue(redactedEvent.data)
  return {
    id: event.id,
    role: 'event',
    type: event.type,
    timestamp: event.timestamp,
    summary:
      stringValue(redactedData.summary) ??
      stringValue(redactedData.status) ??
      stringValue(event.runId) ??
      event.type,
    payload: redactedEvent.data,
    sourcePath: event.sourcePath,
  }
}

export function buildToolCalls(events: MatOSEventSource[]): MatOSWorkbenchTraceToolCall[] {
  const calls = new Map<string, MatOSWorkbenchTraceToolCall>()
  let anonymous = 0
  for (const event of events) {
    if (
      event.type !== 'matos.tool.call.started' &&
      event.type !== 'matos.tool.call.completed'
    ) {
      continue
    }
    const toolUseId = stringValue(event.data.toolUseId)
    const toolName = stringValue(event.data.toolName)
    const key = toolUseId ?? `${toolName ?? 'tool'}:${anonymous++}`
    const current = calls.get(key) ?? {
      id: key,
      ...(toolUseId ? { toolUseId } : {}),
      ...(toolName ? { toolName } : {}),
      status: 'unknown' as const,
      ...(eventTurnId(event) ? { turnId: eventTurnId(event) } : {}),
      sourcePath: event.sourcePath,
    }
    if (event.type === 'matos.tool.call.started') {
      current.status = 'started'
      current.startedAt = event.timestamp
      current.input = redactTranscriptUnknown(recordValue(event.data).input ?? event.data).value
      current.toolName ??= toolName
    } else {
      current.status = 'completed'
      current.completedAt = event.timestamp
      current.output = redactTranscriptUnknown(recordValue(event.data).output ?? event.data).value
      current.toolName ??= toolName
    }
    calls.set(key, current)
  }
  return [...calls.values()].sort((a, b) =>
    (a.startedAt ?? a.completedAt ?? '').localeCompare(b.startedAt ?? b.completedAt ?? ''),
  )
}

export function findTrace(
  traces: MatOSTraceSummary[],
  id: string,
): MatOSTraceSummary | undefined {
  return traces.find(trace => trace.traceId === id || trace.sessionIds.includes(id))
}

export function applyQuery(traces: MatOSTraceSummary[], query?: string): MatOSTraceSummary[] {
  const needle = query?.trim().toLowerCase()
  if (!needle) {
    return traces
  }
  return traces.filter(trace =>
    [
      trace.traceId,
      ...trace.sessionIds,
      trace.command,
      trace.roleRef,
      trace.scopeRef,
      trace.userId,
      trace.status,
    ].some(value => stringValue(value)?.toLowerCase().includes(needle)),
  )
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function traceLiveStatus(value: unknown): MatOSWorkbenchTraceLivePollContract['status'] {
  if (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  if (value === 'idle') {
    return 'idle'
  }
  return 'unknown'
}

export function latestSessionId(
  trace: MatOSTraceSummary | undefined,
  sessions: MatOSSessionSummary[],
  requestedId?: string,
): string | undefined {
  const byRequest = sessions.find(session => session.sessionId === requestedId)
  if (byRequest) {
    return byRequest.sessionId
  }
  const byTrace = trace?.sessionIds
    .map(id => sessions.find(session => session.sessionId === id))
    .filter((session): session is MatOSSessionSummary => Boolean(session))
  const candidates = byTrace && byTrace.length > 0 ? byTrace : sessions
  return [...candidates]
    .sort((a, b) =>
      (b.lastEventAt ?? b.startedAt ?? '').localeCompare(a.lastEventAt ?? a.startedAt ?? ''),
    )[0]?.sessionId ?? trace?.sessionIds[0]
}

export function traceLivePollContract(input: {
  trace?: MatOSTraceSummary
  sessionId?: string
  sessionOffset?: number
}): MatOSWorkbenchTraceLivePollContract {
  const id = input.trace?.traceId ?? input.sessionId ?? ''
  const argv = [
    'workbench',
    'traces',
    'live',
    id,
    '--session-offset',
    String(input.sessionOffset ?? 0),
    '--json',
  ]
  return {
    mode: 'native-trace-live-poll-contract',
    readonly: true,
    ...(input.trace?.traceId ? { traceId: input.trace.traceId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    status: traceLiveStatus(input.trace?.status),
    pollIntervalMs: 1000,
    sessionOffset: input.sessionOffset ?? 0,
    jobOutputOffset: 0,
    endpoint: 'traces.live',
    command: {
      argv,
      command: `matos ${argv.map(value => JSON.stringify(value)).join(' ')}`,
    },
    sources: ['matos-session-jsonl'],
  }
}

export function traceDaemonEndpoint(env: Record<string, string | undefined> | undefined): {
  socketPath?: string
  host?: string
  port?: number
  authTokenFile?: string
} {
  const host = stringValue(env?.MATOS_DAEMON_HOST)
  const port = numberValue(env?.MATOS_DAEMON_PORT)
  if (host && port !== undefined) {
    return {
      host,
      port,
      ...(stringValue(env?.MATOS_DAEMON_AUTH_TOKEN_FILE)
        ? { authTokenFile: stringValue(env?.MATOS_DAEMON_AUTH_TOKEN_FILE) }
        : {}),
    }
  }
  return {
    socketPath: stringValue(env?.MATOS_DAEMON_SOCKET) ?? DEFAULT_MATOS_DAEMON_SOCKET,
    authTokenFile:
      stringValue(env?.MATOS_DAEMON_AUTH_TOKEN_FILE) ?? DEFAULT_MATOS_DAEMON_TOKEN_FILE,
  }
}

export function traceDaemonLedgerPath(env: Record<string, string | undefined> | undefined): string {
  return stringValue(env?.MATOS_DAEMON_JOB_LEDGER) ?? '/workspace/ipc/matos-daemon-jobs.json'
}

export function traceDaemonJobOutputDir(env: Record<string, string | undefined> | undefined): string {
  const explicit = stringValue(env?.MATOS_DAEMON_JOB_OUTPUT_DIR)
  const endpoint = traceDaemonEndpoint(env)
  return resolveMatOSDaemonJobsOutputDir({
    ...(explicit ? { jobsOutputDir: explicit } : {}),
    ledgerPath: traceDaemonLedgerPath(env),
    ...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : {}),
  })
}

export function daemonJobTerminal(job: MatOSDaemonJobRecord | undefined): boolean {
  return (
    job?.status === 'completed' ||
    job?.status === 'failed' ||
    job?.status === 'cancelled'
  )
}

export function isHiddenEvolutionDaemonJob(job: MatOSDaemonJobRecord): boolean {
  const roleRef = job.metadata?.roleRef?.toLowerCase() ?? ''
  // Hand-edited or partially written ledger rows may miss argvPreview.
  const argv = (Array.isArray(job.argvPreview) ? job.argvPreview : []).join(' ').toLowerCase()
  return (
    roleRef.includes('evolution') ||
    roleRef.includes('self-evolution') ||
    argv.includes('matos evolve') ||
    argv.includes('self-evolution')
  )
}

export function redactDaemonJobRecord(job: MatOSDaemonJobRecord): MatOSDaemonJobRecord {
  return redactMatOSWorkbenchValue(job).value as MatOSDaemonJobRecord
}

export function daemonJobMatchesTrace(input: {
  job: MatOSDaemonJobRecord
  traceId?: string
  sessionId?: string
  jobId?: string
}): boolean {
  if (isHiddenEvolutionDaemonJob(input.job)) {
    return false
  }
  const metadata = input.job.metadata ?? {}
  if (input.jobId) {
    return (
      input.job.jobId === input.jobId &&
      Boolean(
        !input.traceId && !input.sessionId
          ? false
          : metadata.traceId === input.traceId ||
              metadata.sessionId === input.sessionId ||
              metadata.parentSessionId === input.sessionId,
      )
    )
  }
  return Boolean(
    (input.traceId && metadata.traceId === input.traceId) ||
      (input.sessionId &&
        (metadata.sessionId === input.sessionId ||
          metadata.parentSessionId === input.sessionId)),
  )
}

export async function resolveTraceDaemonJobs(input: {
  env?: Record<string, string | undefined>
  traceId?: string
  sessionId?: string
  jobId?: string
}): Promise<{
  jobs: MatOSDaemonJobRecord[]
  source: 'matos-daemon' | 'matos-daemon-ledger'
  daemonError?: string
}> {
  const filter = (jobs: MatOSDaemonJobRecord[]): MatOSDaemonJobRecord[] =>
    jobs
      .filter(job => daemonJobMatchesTrace({ ...input, job }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  try {
    const live = await listMatOSDaemonJobs(traceDaemonEndpoint(input.env))
    return {
      jobs: filter(live.jobs),
      source: 'matos-daemon',
    }
  } catch (error) {
    const daemonError = error instanceof Error ? error.message : String(error)
    try {
      const ledger = readMatOSDaemonJobLedgerFile(traceDaemonLedgerPath(input.env))
      return {
        jobs: filter(ledger?.jobs ?? []),
        source: 'matos-daemon-ledger',
        daemonError,
      }
    } catch {
      return {
        jobs: [],
        source: 'matos-daemon-ledger',
        daemonError,
      }
    }
  }
}

export async function readTraceLiveJobOutput(input: {
  env?: Record<string, string | undefined>
  job: MatOSDaemonJobRecord
  offset?: number
  limit?: number
}): Promise<MatOSWorkbenchTraceLiveOutputChunk> {
  const job = redactDaemonJobRecord(input.job)
  const limit = Math.max(1, Math.min(input.limit ?? 64 * 1024, 128 * 1024))
  const slice = await readMatOSDaemonJobOutputSlice({
    dir: traceDaemonJobOutputDir(input.env),
    jobId: input.job.jobId,
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  })
  const rawContent = slice.content.slice(0, limit)
  const textResult = redactTranscriptPreviewLine(rawContent)
  const errorResult = input.job.error
    ? redactMatOSWorkbenchString(input.job.error)
    : undefined
  const truncated = slice.content.length > rawContent.length
  return {
    source: 'matos-daemon-job-output',
    jobId: job.jobId,
    ...(job.metadata?.roleRef ? { roleRef: job.metadata.roleRef } : {}),
    status: job.status,
    exists: slice.exists,
    offset: slice.offset,
    nextOffset: truncated ? slice.offset + rawContent.length : slice.nextOffset,
    size: slice.size,
    content: textResult.line,
    redacted: textResult.redacted || errorResult?.redacted === true,
    truncated,
    done: daemonJobTerminal(job) && !truncated,
    ...(errorResult ? { error: errorResult.value } : {}),
  }
}
