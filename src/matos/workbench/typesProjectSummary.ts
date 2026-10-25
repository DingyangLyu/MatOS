import type { MatOSDaemonJobRecord } from './daemonJobs.js'
import type { MatOSWorkbenchResumeLink } from './sessionLinks.js'

import type {
MatOSWorkbenchAction,
MatOSWorkbenchCommandRoute,
MatOSWorkbenchResource,
MatOSWorkbenchResourceType
} from './typesCore.js'

export type MatOSWorkbenchProjectSummary = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  summary: {
    totalResources: number
    assetTotal?: number
    staticAssetTotal?: number
    dynamicResourceTotal?: number
    typeCounts: Record<string, number>
    assetTypeCounts?: Record<string, number>
    dynamicTypeCounts?: Record<string, number>
    dynamicCounts?: {
      computeHistory?: number
    }
  }
  health?: {
    mode: 'native-project-health-summary'
    status: 'empty' | 'ready' | 'needs-attention'
    checks: Array<{
      key: string
      label: string
      status: 'passed' | 'warning' | 'blocked'
      count: number
      refs: string[]
      summary: string
    }>
  }
  pinnedResources?: {
    mode: 'native-project-pins' | 'derived-read-only'
    policy: {
      persistence: 'native-workbench-store' | 'not-yet-native'
      storeRef?: string
      eventLogRef?: string
      write: {
        enabled: boolean
        reason: string
      }
    }
    items: Array<{
      key: string
      label: string
      reason: string
      source?: 'stored' | 'derived'
      pinnedAt?: string
      updatedAt?: string
      ref: string
      type: MatOSWorkbenchResourceType
      resource: MatOSWorkbenchResource
    }>
  }
  reviewState?: {
    mode: 'native-project-review-summary'
    status: 'idle' | 'ready' | 'attention'
    counts: {
      draft: number
      disabled: number
      warning: number
      evolution: number
      blockedMutation: number
    }
    refs: {
      draft: string[]
      disabled: string[]
      warning: string[]
      evolution: string[]
    }
    policy: {
      source: 'matos-resource-facade'
      hiddenInternalEvolution: true
    }
  }
  releaseState?: {
    mode: 'native-project-release-summary'
    status: 'idle' | 'preview-ready' | 'rollback-ready'
    publishCandidateRefs: string[]
    rollbackCandidateRefs: string[]
    policy: {
      source: 'matos-asset-history'
      applyRequiresConfirmation: true
      sharedGlobalPromotion: 'operator-gated'
    }
  }
  resourceGroups: Array<{
    type: MatOSWorkbenchResourceType
    count: number
    resources: MatOSWorkbenchResource[]
  }>
  surfaces: {
    workflow: { count: number; refs: string[] }
    agent: { count: number; refs: string[] }
    assets: { count: number }
    evolution: { count: number; refs: string[] }
    compute: { count: number; refs: string[] }
    computeHistory?: { count: number; refs: string[] }
    traces: { count: number; refs: string[] }
  }
  raw?: unknown
}

export type MatOSWorkbenchProjectListItem = {
  id: string
  name: string
  cwd: string
  relativePath: string
  description: string
  createdAt?: string
  updatedAt?: string
  source: 'matos-project-file' | 'matos-workspace-folder' | 'workspace-folder-fallback'
  metadataPath?: string
  conversations: {
    count: number
    totalSessions: number
    totalTraces: number
    runningCount: number
    failedCount: number
    completedCount: number
    lastAt?: string
  }
  team: {
    mode: 'metadata-and-session-derived' | 'session-derived' | 'empty'
    roleRefs: string[]
    agents: Array<{
      roleRef: string
      label: string
      source: 'metadata' | 'session'
    }>
  }
  sharedContext: {
    assetCount: number
    typeCounts: Record<string, number>
    workflowCount: number
    knowledgeCount: number
    dataCount: number
  }
  actions: MatOSWorkbenchAction[]
  raw?: unknown
}

export type MatOSWorkbenchProjectList = {
  projects: MatOSWorkbenchProjectListItem[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    source: 'matos-folder-project-catalog'
    scannedRoot: string
    createSupported: boolean
  }
  createAction: {
    key: 'create'
    label: string
    enabled: boolean
    route: MatOSWorkbenchCommandRoute
    targetRoot: string
    metadataPath: string
  }
}

export type MatOSWorkbenchProjectCreateResult = {
  mode: 'matos-project-create'
  created: boolean
  project: MatOSWorkbenchProjectListItem
  targetRoot: string
}

export type MatOSWorkbenchProjectMember = {
  memberId: string
  kind: 'human' | 'agent' | 'service' | 'workflow' | 'external'
  displayName: string
  roleRef?: string
  userId?: string
  source: 'metadata' | 'derived' | 'explicit'
  defaultTools?: string[]
  runtimeRef?: string
}

export type MatOSWorkbenchProjectConversation = {
  id: string
  title: string
  roleRef?: string
  memberRefs: string[]
  createdAt?: string
  updatedAt?: string
  topicCount: number
  messageCount: number
}

export type MatOSWorkbenchProjectArea = {
  areaId: string
  name: string
  kind: 'discussion' | 'planning' | 'agent-run' | 'workflow' | 'assets' | 'compute' | 'paper' | 'incident' | 'custom'
  defaultRoleRef?: string
  defaultWorkflowRefs: string[]
  defaultAssetRefs: string[]
  workspacePath?: string
  createdAt?: string
  updatedAt?: string
}

export type MatOSWorkbenchProjectGroup = {
  mode: 'matos-project-group'
  project: MatOSWorkbenchProjectListItem
  members: MatOSWorkbenchProjectMember[]
  conversations: MatOSWorkbenchProjectConversation[]
  areas: MatOSWorkbenchProjectArea[]
  assetRefs: string[]
  assetVersionPolicy?: 'follow-accepted' | 'pinned'
  workflowRefs: string[]
  profile: {
    revision: number
    goal?: string
    memberBriefs: Record<string, string>
    memberNames: Record<string, string>
    roleResolutionWarnings?: Array<{
      code: string
      requestedRoleRef: string
      fallbackRoleRef: string
      message: string
    }>
    visibilityPolicy: {
      shared: string
      private: string
    }
  }
  store: {
    metadataPath: string
    eventLogRelativePath: string
  }
}

export type MatOSWorkbenchProjectGroupMutation = {
  mode: 'matos-project-group-mutation'
  changed: boolean
  action: string
  project: MatOSWorkbenchProjectGroup
  warning?: string
}

export type MatOSWorkbenchProjectTimelineEvent = {
  eventId: string
  createdAt: string
  projectId: string
  conversationId: string
  topicId?: string
  areaId?: string
  sender: {
    kind: 'human' | 'agent' | 'system'
    id: string
    memberId?: string
    roleRef?: string
  }
  eventType: 'message' | 'agent.message' | 'system.event' | 'workflow.run' | 'compute.job' | 'asset.bound'
  text: string
  refs: {
    assetRefs?: string[]
    workflowRefs?: string[]
    workflowRunId?: string
    traceId?: string
    computeJobId?: string
    jobId?: string
    matosSessionId?: string
    upstreamSessionId?: string
    resumeCommand?: string
    messageId?: string
    runId?: string
  }
}

export type MatOSWorkbenchProjectTimeline = {
  mode: 'matos-project-timeline'
  project: MatOSWorkbenchProjectListItem
  conversationId: string
  topicId?: string
  areaId?: string
  events: MatOSWorkbenchProjectTimelineEvent[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
  }
}

export type MatOSWorkbenchProjectMessageSendResult = {
  mode: 'matos-project-message-send'
  event: MatOSWorkbenchProjectTimelineEvent
  timeline: MatOSWorkbenchProjectTimeline
}

export type MatOSWorkbenchProjectChatSubmitResult = {
  mode: 'matos-project-chat-submit'
  event: MatOSWorkbenchProjectTimelineEvent
  timeline: MatOSWorkbenchProjectTimeline
  roleRef: string
  prompt: {
    source: 'matos-project-chat-context'
    length: number
    timelineEventCount: number
  }
  job?: {
    jobId: string
    pid?: number
    status: string
    cwd?: string
    metadata?: MatOSDaemonJobRecord['metadata'] & {
      projectId?: string
      conversationId?: string
      topicId?: string
      areaId?: string
      memberId?: string
      matosChatSessionId?: string
      upstreamSessionId?: string
      resumeCommand?: string
    }
  }
  session: {
    matosSessionId: string
    traceId: string
    resume?: MatOSWorkbenchResumeLink
  }
  summary: {
    source: 'matos-project-chat'
    submitted: boolean
    projectId: string
    conversationId: string
    topicId?: string
    areaId?: string
    roleRef: string
  }
}

export type MatOSWorkbenchProjectPins = {
  project: MatOSWorkbenchProjectSummary['project']
  pinnedResources: NonNullable<MatOSWorkbenchProjectSummary['pinnedResources']>
  summary: {
    count: number
    storedCount: number
    derivedCount: number
    missingCount: number
  }
  store: {
    mode: 'native-workbench-store'
    relativePath: string
    eventLogRelativePath: string
    updatedAt?: string
    missingRefs: string[]
  }
  raw?: unknown
}

export type MatOSWorkbenchProjectPinAction = {
  mode: 'matos-project-pin-action'
  action: 'pin' | 'unpin' | 'toggle-pin'
  ref: string
  pinned: boolean
  changed: boolean
  reason?: string
  resource?: MatOSWorkbenchResource
  pins: MatOSWorkbenchProjectPins
  audit: {
    relativePath: string
    event: {
      timestamp: string
      action: 'pin' | 'unpin' | 'toggle-pin'
      ref: string
      changed: boolean
      pinned: boolean
      reason?: string
    }
  }
}
