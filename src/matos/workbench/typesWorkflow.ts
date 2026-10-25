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
import type {
MatOSWorkflowNodeManifestCoverageReport,
MatOSWorkflowNodeManifestSummary,
} from '../workflows/nodeManifests.js'
import type { MatOSWorkflowDefinition } from '../workflows/types.js'
import type { WorkflowCompileView } from '../workflows/workflowCompile.js'
import type { MatOSWorkflowIntakeView } from '../workflows/workflowIntake.js'
import type { WorkflowRunView } from '../workflows/workflowRuntime.js'

import type {
MatOSWorkbenchAction,
MatOSWorkbenchResource,
MatOSWorkbenchWriteTransactionPreview
} from './typesCore.js'

export type MatOSWorkbenchWorkflowView = {
  resource?: MatOSWorkbenchResource
  workflow?: unknown
  kind?: string
  definition?: unknown
  validation?: unknown
  nodeManifests?: MatOSWorkflowNodeManifestSummary[]
  nodeManifestReport?: MatOSWorkflowNodeManifestCoverageReport
  compile?: unknown
  intake?: MatOSWorkflowIntakeView
  run?: WorkflowRunView
  evidence?: {
    runId?: string
    status?: string
    nodeCount: number
    finishedNodeCount: number
    failedNodeCount: number
    eventCount: number
    artifactCount: number
    approvalCount: number
    pendingApprovalCount: number
    waitingNodeId?: string
    traceRefs: string[]
    trace?: Record<string, unknown>
    provenance?: Record<string, unknown>
    budget?: {
      totals: {
        nodeAttempts: number
        agentCalls: number
        toolCalls: number
        backendJobs: number
        wallTimeMs: number
      }
      violationCount: number
    }
  }
  events?: unknown[]
  artifacts?: unknown[]
  approvals?: unknown
}

export type MatOSWorkbenchWorkflowRunGraphNode = {
  id: string
  type: string
  runtimeType?: string
  targetType?: string
  status: string
  attempts: number
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  waiting: boolean
  error?: string
  budget?: {
    nodeAttempts: number
    agentCalls: number
    toolCalls: number
    backendJobs: number
    wallTimeMs: number
  }
}

export type MatOSWorkbenchWorkflowRunGraphEdge = {
  from: string
  to: string
  route: string
  condition?: string
}

export type MatOSWorkbenchWorkflowRunTimelineEntry = {
  at?: string
  type: string
  nodeId?: string
  summary?: string
}

export type MatOSWorkbenchWorkflowRunGraph = {
  mode: 'native-workflow-run-graph'
  readonly: true
  runId?: string
  workflowRef?: string
  status?: string
  waitingNodeId?: string
  nodes: MatOSWorkbenchWorkflowRunGraphNode[]
  edges: MatOSWorkbenchWorkflowRunGraphEdge[]
  budget?: unknown
  timeline: MatOSWorkbenchWorkflowRunTimelineEntry[]
  stateMachine?: {
    frameCount: number
    frames: Array<{
      frameId: string
      index: number
      activeNodeId: string
      status: string
      transitionEdgeId?: string
    }>
  }
  summary: {
    nodeCount: number
    completedNodeCount: number
    failedNodeCount: number
    runningNodeCount: number
    waitingNodeCount: number
    pendingNodeCount: number
    skippedNodeCount: number
    edgeCount: number
    eventCount: number
    timelineCount: number
    timelineTruncated: boolean
    budgetViolationCount: number
    source: 'matos-workflow-run'
  }
}

export type MatOSWorkbenchWorkflowIntakeSessionView = {
  mode: 'native-workflow-intake-session'
  schemaVersion: 1
  sessionId: string
  workflowRef: string
  status:
    | 'collecting'
    | 'ready'
    | 'blocked'
    | 'confirmed'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
  createdAt: string
  updatedAt: string
  parameters: Record<string, unknown>
  messages: Array<{
    at: string
    role: 'user' | 'system' | 'agent'
    content: string
    extractedParameters?: Record<string, unknown>
  }>
  intake: MatOSWorkflowIntakeView
  assistant: {
    enabled: true
    source: 'native-matos-workflow-intake'
    prompt: string
    missingRequired: string[]
    canRun: boolean
    lastHandoff?: {
      mode: 'native-workflow-intake-assistant-handoff'
      source: 'role:workflow-ui-builder'
      ok: boolean
      chatSessionId: string
      conversationId: string
      frameCount: number
      eventCount: number
      extractedParameterCount: number
      error?: string
    }
  }
  actions: {
    send: {
      endpoint: 'workflows.intakeSession'
      params: { action: 'send'; sessionId: string }
      enabled: true
    }
    confirm: {
      endpoint: 'workflows.intakeSession'
      params: { action: 'confirm'; sessionId: string }
      enabled: boolean
    }
    run: {
      endpoint: 'workflows.intakeSession'
      params: { action: 'run'; sessionId: string }
      enabled: boolean
    }
  }
  runId?: string
}

export type MatOSWorkbenchWorkflowRunMonitorView = {
  mode: 'native-workflow-run-monitor'
  schemaVersion: 1
  readonly: false
  runId: string
  status: string
  run?: WorkflowRunView
  runGraph: MatOSWorkbenchWorkflowRunGraph
  events: unknown[]
  artifacts: unknown[]
  approvals: unknown
  pendingApprovals: unknown[]
  evidence: NonNullable<MatOSWorkbenchWorkflowView['evidence']>
  actions: unknown
  stream: {
    endpoint: 'workflows.monitor'
    params: { runId: string }
    pollingIntervalMs: number
    cursor?: Record<string, unknown>
  }
  summary: {
    nodeCount: number
    completedNodeCount: number
    failedNodeCount: number
    runningNodeCount: number
    waitingNodeCount: number
    eventCount: number
    artifactCount: number
    approvalCount: number
    pendingApprovalCount: number
    source: 'native-matos-workflow-runtime'
  }
}

export type MatOSWorkbenchWorkflowBuilderSessionView = {
  mode: 'native-workflow-builder-session'
  schemaVersion: 1
  sessionId: string
  goal: string
  workflowRef?: string
  draftId?: string
  status:
    | 'planning'
    | 'drafting'
    | 'validating'
    | 'ready'
    | 'applying'
    | 'repairing'
    | 'published'
    | 'failed'
  createdAt: string
  updatedAt: string
  messages: Array<{
    at: string
    role: 'user' | 'system' | 'agent'
    content: string
    extractedParameters?: Record<string, unknown>
  }>
  events?: Array<{
    at: string
    type:
      | 'message'
      | 'plan'
      | 'create_draft'
      | 'fork_workflow'
      | 'replace_definition'
      | 'validate_draft'
      | 'compile_draft'
      | 'repair_draft'
      | 'assistant_handoff'
      | 'publish_draft'
      | 'error'
    status: 'started' | 'completed' | 'failed'
    summary: string
    draftId?: string
    workflowRef?: string
    validationOk?: boolean
  }>
  phase?: {
    source: 'native-matos-workflow-builder'
    state:
      | 'intent_captured'
      | 'clarifying'
      | 'graph_proposed'
      | 'user_reviewing_patch'
      | 'applying_patch'
      | 'validating'
      | 'ready_to_publish'
      | 'publishing'
      | 'published'
      | 'attach_suggested'
      | 'failed'
    title: string
    summary: string
    activeEventType?: string
    nativeAction?: string
    nextActions: Array<{
      key: string
      label: string
      enabled: boolean
      endpoint: string
      reason?: string
    }>
  }
  patchPreview?: {
    source: 'native-workflow-draft-diff'
    itemCount: number
    changedCount: number
    issueCount: number
    validationOk?: boolean
    compileOk?: boolean
    items: Array<{
      path: string
      label: string
      kind: string
      changed: boolean
    }>
  }
  publishSummary?: {
    source: 'native-workflow-publish'
    workflowRef?: string
    draftId?: string
    assetKey?: string
    scopedGitea?: {
      ok?: boolean
      sourceId?: string
      branch?: string
      acceptedRef?: string
      commit?: string
      status?: string
      activationRequired?: boolean
      activateCli?: string
    }
  }
  publishReadiness?: {
    source: 'native-workflow-publish-readiness'
    draftId?: string
    targetAssetKey?: string
    targetId?: string
    targetVersion?: string
    scope?: 'user' | 'team' | 'project' | 'local'
    scopeRef?: string
    governance: 'scoped-gitea-accepted-ref' | 'local-asset-governance'
    usesScopedGitea: boolean
    validationOk?: boolean
    compileOk?: boolean
    canPublish: boolean
    reason: string
  }
  attachSuggestion?: {
    source: 'native-workflow-role-mount'
    workflowRef?: string
    recommendedRoleRefs: string[]
    reason: string
    action: {
      endpoint: 'workflows.attachRole'
      enabled: boolean
    }
  }
  plan?: {
    source: 'native-matos-workflow-builder'
    steps: Array<{
      id: string
      title: string
      status: 'pending' | 'active' | 'done' | 'blocked'
      description: string
    }>
  }
  workflow?: MatOSWorkbenchWorkflowView
  lastDraft?: unknown
  lastValidation?: unknown
  lastCompile?: unknown
  lastRepair?: unknown
  lastAssistant?: unknown
  lastPublish?: unknown
  assistant: {
    enabled: true
    source: 'native-matos-workflow-builder'
    prompt: string
  }
  actions: {
    send: {
      endpoint: 'workflows.builderSession'
      params: { action: 'send'; sessionId: string }
      enabled: true
    }
    createDraft: {
      endpoint: 'workflows.builderSession'
      params: { action: 'create_draft'; sessionId: string }
      enabled: true
    }
    forkWorkflow: {
      endpoint: 'workflows.builderSession'
      params: { action: 'fork_workflow'; sessionId: string }
      enabled: boolean
    }
    replaceDefinition: {
      endpoint: 'workflows.builderSession'
      params: { action: 'replace_definition'; sessionId: string }
      enabled: boolean
    }
    previewDraft: {
      endpoint: 'workflows.draft'
      params: Record<string, unknown>
      enabled: true
    }
    validate: {
      endpoint: 'workflows.validate'
      params: Record<string, unknown>
      enabled: boolean
    }
    compile: {
      endpoint: 'workflows.compile'
      params: Record<string, unknown>
      enabled: boolean
    }
    repair: {
      endpoint: 'workflows.builderSession'
      params: { action: 'repair_draft'; sessionId: string }
      enabled: boolean
    }
    publish: {
      endpoint: 'workflows.builderSession'
      params: { action: 'publish_draft'; sessionId: string }
      enabled: boolean
    }
  }
}

export type MatOSWorkbenchWorkflowDraftIssue = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  nodeId?: string
  path?: string
}

export type MatOSWorkbenchWorkflowDraftPreview = {
  workflowRef?: string
  mutation: string
  source: 'coze-canvas'
  mode: 'draft-preview'
  definition: MatOSWorkflowDefinition
  diff?: {
    source: 'matos-workflow-draft'
    summary: {
      nodeCount: number
      edgeCount: number
      transitionCount?: number
      parameterCount: number
      outputCount: number
      ignoredNodeCount: number
      issueCount: number
    }
    items: Array<{
      path: string
      label: string
      kind:
        | 'workflow'
        | 'node'
        | 'edge'
        | 'transition'
        | 'parameter'
        | 'output'
        | 'issue'
        | 'summary'
      before?: unknown
      after?: unknown
      changed: boolean
    }>
    preview: string[]
  }
  validation: {
    ok: boolean
    errors: MatOSWorkbenchWorkflowDraftIssue[]
  }
  compile: WorkflowCompileView
  issues: MatOSWorkbenchWorkflowDraftIssue[]
  summary: {
    nodeCount: number
    edgeCount: number
    transitionCount?: number
    ignoredNodeCount: number
    warningCount: number
    errorCount: number
  }
  write: {
    enabled: false
    reason: string
    nextAction: MatOSWorkbenchAction
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
  raw?: {
    schema?: unknown
    request?: unknown
  }
}

export type MatOSWorkbenchWorkflowDraftApplyResult = {
  workflowRef: string
  mutation: string
  source: 'coze-canvas'
  mode: 'controlled-write'
  applied: boolean
  readonly: false
  draft: MatOSWorkbenchWorkflowDraftPreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  before?: MatOSWorkbenchWorkflowView
  after?: MatOSWorkbenchWorkflowView
  snapshots: {
    before: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    after?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    rollback?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
  }
  validation?: MatOSAssetHistoryValidationResult
  compile?: WorkflowCompileView
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'workflows.apply-draft'
    reason?: string
  }
}
