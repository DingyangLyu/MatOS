import type { MatOSDaemonJobRecord } from './daemonJobs.js'

import type {
MatOSWorkbenchAction,
MatOSWorkbenchCommandRoute,
MatOSWorkbenchResource,
MatOSWorkbenchWarning
} from './typesCore.js'

export type MatOSWorkbenchComputeView = {
  kind: 'compute-status' | 'compute-check-dry-run'
  status: 'ok' | 'failed'
  gpu?: unknown
  stderr?: string
  dryRun?: boolean
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchTraceMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'event'
  type: string
  timestamp: string
  turnId?: string
  summary: string
  payload?: unknown
  sourcePath?: string
}

export type MatOSWorkbenchTraceToolCall = {
  id: string
  toolUseId?: string
  toolName?: string
  status: 'started' | 'completed' | 'unknown'
  turnId?: string
  startedAt?: string
  completedAt?: string
  input?: unknown
  output?: unknown
  sourcePath?: string
}

export type MatOSWorkbenchTranscriptPreview = {
  lines: string[]
  lineCount: number
  truncated: boolean
  redacted: boolean
  byteLimit: number
}

export type MatOSWorkbenchTranscriptRawLine = {
  lineNumber: number
  text: string
  redacted: boolean
  parsed?: unknown
  parseError?: string
}

export type MatOSWorkbenchTranscriptLink = {
  id: string
  source: 'matos-session-jsonl' | 'cmatos-transcript'
  sessionId: string
  traceId?: string
  label: string
  path?: string
  relativePath?: string
  eventCount?: number
  status?: string
  startedAt?: string
  lastEventAt?: string
  readable?: boolean
  preview?: MatOSWorkbenchTranscriptPreview
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchTraceTranscriptView = {
  mode: 'operator-transcript-view'
  viewerMode: 'operator'
  id: string
  traceId?: string
  sessionId: string
  linkId: string
  source: MatOSWorkbenchTranscriptLink['source']
  label: string
  path?: string
  relativePath?: string
  readable: boolean
  lines: MatOSWorkbenchTranscriptRawLine[]
  summary: {
    lineCount: number
    parsedLineCount: number
    redactedLineCount: number
    truncated: boolean
    byteLimit: number
  }
  transcriptLink: MatOSWorkbenchTranscriptLink
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchTraceArtifactLink = {
  id: string
  artifactId: string
  resourceRef?: string
  runId?: string
  traceId?: string
  nodeId?: string
  name: string
  kind?: string
  mediaType?: string
  path?: string
  relativePath?: string
  size?: number
  createdAt?: string
  updatedAt?: string
  source: 'workflow-artifact-event'
  actions: MatOSWorkbenchAction[]
  artifact: unknown
}

export type MatOSWorkbenchTraceView = {
  id: string
  trace: unknown
  sessions: unknown[]
  events: unknown[]
  workflowEvents: unknown[]
  transcriptLinks: MatOSWorkbenchTranscriptLink[]
  artifactLinks: MatOSWorkbenchTraceArtifactLink[]
  messages: MatOSWorkbenchTraceMessage[]
  toolCalls: MatOSWorkbenchTraceToolCall[]
  live?: MatOSWorkbenchTraceLivePollContract
  summary: {
    eventCount: number
    workflowEventCount: number
    messageCount: number
    toolCallCount: number
    transcriptLinkCount: number
    transcriptPreviewCount: number
    artifactLinkCount: number
  }
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchTraceLivePollContract = {
  mode: 'native-trace-live-poll-contract'
  readonly: true
  traceId?: string
  sessionId?: string
  jobId?: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  pollIntervalMs: number
  sessionOffset: number
  jobOutputOffset: number
  endpoint: 'traces.live'
  command: MatOSWorkbenchCommandRoute
  sources: Array<'matos-session-jsonl' | 'matos-daemon' | 'matos-daemon-ledger' | 'matos-daemon-job-output'>
  warnings?: MatOSWorkbenchWarning[]
}

export type MatOSWorkbenchTraceTailView = {
  mode: 'native-trace-tail'
  readonly: true
  sessionId: string
  exists: boolean
  offset: number
  nextOffset: number
  eventCount: number
  messages: MatOSWorkbenchTraceMessage[]
  done: boolean
  summary: {
    source: 'matos-session-jsonl'
    sessionId: string
    returned: number
    total: number
    done?: boolean
  }
}

export type MatOSWorkbenchTraceLiveOutputChunk = {
  source: 'matos-daemon-job-output'
  jobId: string
  roleRef?: string
  status?: MatOSDaemonJobRecord['status']
  exists: boolean
  offset: number
  nextOffset: number
  size: number
  content: string
  redacted: boolean
  truncated: boolean
  done: boolean
  error?: string
}

export type MatOSWorkbenchTraceLiveView = {
  mode: 'native-trace-live-debug'
  readonly: true
  id: string
  traceId?: string
  sessionId?: string
  jobId?: string
  trace?: unknown
  sessionTail?: MatOSWorkbenchTraceTailView
  jobs: MatOSDaemonJobRecord[]
  selectedJob?: MatOSDaemonJobRecord
  outputChunk?: MatOSWorkbenchTraceLiveOutputChunk
  messages: MatOSWorkbenchTraceMessage[]
  cursors: {
    sessionOffset: number
    nextSessionOffset: number
    jobOutputOffset: number
    nextJobOutputOffset: number
  }
  done: boolean
  summary: {
    source: 'matos-trace-live-debug'
    sessionSource?: 'matos-session-jsonl'
    jobSource?: 'matos-daemon' | 'matos-daemon-ledger'
    outputSource?: 'matos-daemon-job-output'
    returnedMessageCount: number
    jobOutputLength: number
    totalSessionEventCount: number
    jobCount: number
    daemonError?: string
    redacted: boolean
    truncated: boolean
  }
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchTraceList = {
  traces: unknown[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
  }
  sources?: unknown
}
