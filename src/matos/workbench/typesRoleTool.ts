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

import type {
MatOSAssetHistorySnapshotRecord,
MatOSAssetHistoryValidationResult
} from '../assets/history/types.js'
import type { MatOSAssetLifecycleStatus } from '../assets/types.js'
import type { MatOSDaemonJobRecord } from './daemonJobs.js'
import type { MatOSWorkbenchResumeLink } from './sessionLinks.js'

import type {
MatOSWorkbenchTraceArtifactLink,
MatOSWorkbenchTraceMessage,
MatOSWorkbenchTraceToolCall,
MatOSWorkbenchTraceView,
MatOSWorkbenchTranscriptLink,
} from './typesComputeTrace.js'
import type {
MatOSWorkbenchAction,
MatOSWorkbenchOperatorReview,
MatOSWorkbenchResource,
MatOSWorkbenchResourceShow,
MatOSWorkbenchResourceType,
MatOSWorkbenchWarning,
MatOSWorkbenchWriteTransactionPreview
} from './typesCore.js'

export type MatOSWorkbenchRoleView = {
  resource: MatOSWorkbenchResource
  detail?: MatOSWorkbenchRoleDetail
  composition?: unknown
}

export type MatOSWorkbenchRoleDebugView = {
  mode: 'trace-backed-debug'
  executed: false
  readonly: true
  role: MatOSWorkbenchRoleView
  traces: unknown[]
  daemonJobs?: Array<{
    jobId: string
    pid: number
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    argvPreview: string[]
    cwd: string
    envKeys: string[]
    metadata?: {
      traceId?: string
      sessionId?: string
      parentSessionId?: string
      turnId?: string
      userId?: string
      scopeRef?: string
      workspaceId?: string
      runtimeRef?: string
      roleRef?: string
      execution?: string
      projectId?: string
      conversationId?: string
      topicId?: string
      areaId?: string
      matosChatSessionId?: string
      upstreamSessionId?: string
      resumeCommand?: string
    }
    startedAt: string
    completedAt?: string
    exitCode?: number
    signal?: string
    error?: string
  }>
  selectedTrace?: MatOSWorkbenchTraceView
  messages: MatOSWorkbenchTraceMessage[]
  toolCalls: MatOSWorkbenchTraceToolCall[]
  transcriptLinks: MatOSWorkbenchTranscriptLink[]
  artifactLinks: MatOSWorkbenchTraceArtifactLink[]
  summary: {
    traceCount: number
    messageCount: number
    toolCallCount: number
    transcriptLinkCount: number
    artifactLinkCount: number
    daemonJobCount?: number
    selectedTraceId?: string
    source: 'matos-trace-index'
  }
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchRoleDebugRunView = {
  mode: 'native-role-run-invocation'
  executed: boolean
  submitted?: boolean
  readonly: false
  role: MatOSWorkbenchRoleView
  invocation: {
    prompt: string
    roleReference: string
    execution: 'local' | 'container'
    containerMode?: 'persistent' | 'ephemeral'
    runtimeReference?: string
    scopeReference?: string
    passthroughArgs: string[]
    selectedAssetKeys: string[]
    agentArgCount: number
    command: {
      argv: string[]
      command: string
    }
    daemon?: {
      socketPath?: string
      host?: string
      port?: number
    }
    projection?: {
      selectedAgent?: string
      appendSystemPromptCount: number
      skillDirCount: number
      pluginDirCount: number
      mcpConfigPathCount: number
      mcpConfigJsonCount: number
      allowedTools: string[]
      disallowedTools: string[]
      readablePathCount: number
      assetToolDirCount: number
    }
  }
  summary: {
    source: 'matos-run-invocation'
    selectedAssetCount: number
    agentArgCount: number
    promptLength: number
  }
  job?: {
    jobId: string
    pid: number
    status: 'running'
    cwd: string
    argvPreview: string[]
    envKeys: string[]
    metadata?: {
      traceId?: string
      sessionId?: string
      parentSessionId?: string
      turnId?: string
      userId?: string
      scopeRef?: string
      workspaceId?: string
      runtimeRef?: string
      roleRef?: string
      execution?: string
      projectId?: string
      conversationId?: string
      topicId?: string
      areaId?: string
      matosChatSessionId?: string
      upstreamSessionId?: string
      resumeCommand?: string
    }
  }
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchRoleJobsView = {
  mode: 'native-role-daemon-jobs'
  readonly: true
  role: MatOSWorkbenchRoleView
  jobs: MatOSDaemonJobRecord[]
  selectedJob?: MatOSDaemonJobRecord
  summary: {
    source: 'matos-daemon' | 'matos-daemon-ledger'
    roleRef: string
    total: number
    returned: number
    runningCount: number
    selectedJobId?: string
    daemonError?: string
  }
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchRoleJobCancelView = {
  mode: 'native-role-daemon-job-control'
  readonly: false
  appliedAction: 'cancel'
  ok: boolean
  role: MatOSWorkbenchRoleView
  job?: MatOSDaemonJobRecord
  error?: string
  summary: {
    source: 'matos-daemon'
    roleRef: string
    jobId: string
    status?: string
    signal: string
  }
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchRoleJobOutputView = {
  mode: 'native-role-job-output'
  readonly: true
  jobId: string
  roleRef?: string
  status?: MatOSDaemonJobRecord['status']
  output: string
  offset: number
  nextOffset: number
  size: number
  exists: boolean
  done: boolean
  resume?: MatOSWorkbenchResumeLink
  upstreamSessionId?: string
  error?: string
  summary: {
    source: 'matos-daemon-job-output' | 'matos-daemon' | 'matos-daemon-ledger'
    roleRef?: string
    jobStatus: string
    outputLength: number
    totalLength: number
    daemonError?: string
  }
}

export type MatOSWorkbenchRoleDraftIssue = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  ref?: string
  path?: string
}

export type MatOSWorkbenchRoleWorkflowMount = {
  ref: string
  acceptedRef?: string
  pinnedCommit?: string
  allowedActions: Array<
    | 'query'
    | 'run'
    | 'status'
    | 'monitor'
    | 'respond'
    | 'approve'
    | 'deny'
    | 'recover'
    | 'reconcile'
    | 'patch'
  >
  invocationPolicy: {
    mode: 'explicit' | 'agent-discoverable' | 'auto'
    requireUserApproval?: boolean
    maxConcurrentRuns?: number
  }
  attachedBy?: string
  attachedAt?: string
  reason?: string
}

export type MatOSWorkbenchRoleDraftPreview = {
  roleRef?: string
  mutation: string
  source: 'coze-agent-ide'
  mode: 'draft-preview'
  patch: {
    asset?: {
      name?: string
      description?: string
    }
    selectedAgent?: {
      prompt?: string
      model?: string
      permissionMode?: string
    }
    mounts: Record<string, string[]>
    workflowMounts?: MatOSWorkbenchRoleWorkflowMount[]
  }
  diff?: {
    source: 'matos-role-draft'
    fieldChanges: Array<{
      path: string
      label: string
      kind: 'asset' | 'selected-agent' | 'mounts'
      before?: unknown
      after?: unknown
      changed: boolean
    }>
    promptChanged: boolean
    attachmentChangeCount: number
    preview: string[]
  }
  validation: {
    ok: boolean
    errors: MatOSWorkbenchRoleDraftIssue[]
  }
  issues: MatOSWorkbenchRoleDraftIssue[]
  summary: {
    changedFieldCount: number
    attachmentCount: number
    missingAttachmentCount: number
    warningCount: number
    errorCount: number
  }
  write: {
    enabled: false
    reason: string
    nextAction: MatOSWorkbenchAction
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
  before?: MatOSWorkbenchRoleView
  raw?: {
    request?: unknown
  }
}

export type MatOSWorkbenchRoleDraftApplyResult = {
  roleRef: string
  mutation: string
  source: 'coze-agent-ide'
  mode: 'controlled-write'
  applied: boolean
  readonly: false
  draft: MatOSWorkbenchRoleDraftPreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  before: MatOSWorkbenchRoleView
  after?: MatOSWorkbenchRoleView
  snapshots: {
    before: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    after?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    rollback?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
  }
  validation?: MatOSAssetHistoryValidationResult
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'roles.apply-draft'
    reason?: string
  }
}

export type MatOSWorkbenchAssetDraftIssue = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  ref?: string
  path?: string
}

export type MatOSWorkbenchAssetDraftPreview = {
  resourceRef?: string
  kind: string
  mutation: string
  source: 'coze-resource-ui'
  mode: 'draft-preview'
  patch: {
    asset?: {
      name?: string
      description?: string
    }
    metadata?: {
      documents?: unknown[]
      slices?: unknown[]
      fields?: unknown[]
      records?: unknown[]
      apis?: unknown[]
      commands?: unknown[]
      examples?: unknown[]
      inputSchema?: unknown
      outputSchema?: unknown
      runbook?: unknown
    }
    entryContent?: {
      content: string
      format: 'markdown' | 'json' | 'text'
    }
    dependencies?: string[]
  }
  validation: {
    ok: boolean
    errors: MatOSWorkbenchAssetDraftIssue[]
  }
  issues: MatOSWorkbenchAssetDraftIssue[]
  summary: {
    changedFieldCount: number
    documentCount: number
    sliceCount: number
    fieldCount: number
    recordCount: number
    apiCount: number
    commandCount: number
    entryContentChanged?: boolean
    dependencyCount?: number
    warningCount: number
    errorCount: number
  }
  write: {
    enabled: false
    reason: string
    nextAction: MatOSWorkbenchAction
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
  before?: MatOSWorkbenchResourceShow
  raw?: {
    request?: unknown
  }
}

export type MatOSWorkbenchAssetDraftApplyResult = {
  resourceRef: string
  kind: string
  mutation: string
  source: 'coze-resource-ui'
  mode: 'controlled-write'
  applied: boolean
  readonly: false
  draft: MatOSWorkbenchAssetDraftPreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  before?: MatOSWorkbenchResourceShow
  after?: MatOSWorkbenchResourceShow
  snapshots: {
    before: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    after?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    rollback?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
  }
  validation?: MatOSAssetHistoryValidationResult
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'resources.apply-draft'
    reason?: string
  }
}

export type MatOSWorkbenchToolDryRunStep = {
  key: 'resolve-tool' | 'select-api' | 'validate-input' | 'report-only'
  label: string
  status: 'passed' | 'failed' | 'skipped'
  summary?: string
}

export type MatOSWorkbenchToolDryRun = {
  mode: 'safe-dry-run'
  executed: false
  readonly: true
  tool: {
    ref: string
    id: string
    type: string
    name: string
    description?: string
    binding?: string
    kind?: string
  }
  api: {
    id: string
    name: string
    description?: string
    method: string
    path: string
    inputSchema?: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    raw?: unknown
  }
  input: Record<string, unknown>
  validation: {
    ok: boolean
    errors: Array<{
      code: string
      message: string
      path?: string
    }>
  }
  plan: {
    steps: MatOSWorkbenchToolDryRunStep[]
    reason: string
  }
  executionPolicy: {
    mode: 'real-tool-execution-policy'
    dryRunEnabled: true
    realExecutionEnabled: false
    reason: string
    nativeNextStep: string
    operatorReview: MatOSWorkbenchOperatorReview
  }
  source: 'matos-asset-registry'
}

export type MatOSWorkbenchToolTelemetryCall = {
  id: string
  traceId: string
  traceRef: string
  toolName?: string
  apiId?: string
  apiName?: string
  status: 'started' | 'completed' | 'unknown'
  outcome: 'success' | 'failure' | 'running' | 'unknown'
  matchedBy: 'api' | 'binding' | 'asset-name' | 'asset-id' | 'asset-ref'
  turnId?: string
  startedAt?: string
  completedAt?: string
  inputPreview?: unknown
  outputPreview?: unknown
  sourcePath?: string
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchToolTelemetry = {
  mode: 'tool-telemetry'
  readonly: true
  tool: {
    ref: string
    id: string
    type: string
    name: string
    description?: string
    binding?: string
  }
  api?: MatOSWorkbenchToolDryRun['api']
  calls: MatOSWorkbenchToolTelemetryCall[]
  traces: unknown[]
  summary: {
    count: number
    total: number
    successCount: number
    failureCount: number
    runningCount: number
    unknownCount: number
    scannedTraceCount: number
    offset: number
    limit: number
    query: string
    source: 'matos-trace-index'
  }
  source: 'matos-trace-index'
}

export type MatOSWorkbenchRoleAttachment = {
  group:
    | 'knowledge'
    | 'data'
    | 'skills'
    | 'tools'
    | 'mcp'
    | 'plugins'
    | 'workflows'
    | 'roles'
  ref: string
  resolvedRef?: string
  type?: MatOSWorkbenchResourceType
  name?: string
  description?: string
  lifecycle?: MatOSAssetLifecycleStatus
  missing?: boolean
  workflowParameters?: Array<{
    key: string
    name: string
    type?: string
    description?: string
    required?: boolean
    defaultValue?: unknown
    schema?: unknown
  }>
}

export type MatOSWorkbenchRoleDetail = {
  roleRef: string
  selectedAgentId?: string
  selectedAgent?: {
    id: string
    name: string
    description?: string
    prompt?: string
    model?: string
    effort?: string | number
    permissionMode?: string
    maxTurns?: number
    initialPrompt?: string
    memory?: string
    tools: string[]
    disallowedTools: string[]
    skills: string[]
    mcpServerCount: number
  }
  attachments: MatOSWorkbenchRoleAttachment[]
  attachmentGroups: Record<string, MatOSWorkbenchRoleAttachment[]>
  workflowMounts?: MatOSWorkbenchRoleWorkflowMount[]
  runtime: {
    appendSystemPromptCount: number
    skillDirCount: number
    pluginDirCount: number
    mcpConfigPathCount: number
    mcpConfigJsonCount: number
    allowedTools: string[]
    disallowedTools: string[]
    readablePathCount: number
    assetToolDirCount: number
    assetEvents: unknown[]
  }
  actions: MatOSWorkbenchAction[]
  warnings?: MatOSWorkbenchWarning[]
}
