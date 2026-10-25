
import type {
MatOSWorkbenchAction,
MatOSWorkbenchActionKey,
MatOSWorkbenchCommandRoute,
MatOSWorkbenchResource,
MatOSWorkbenchResourceShow,
MatOSWorkbenchWriteTransactionPreview
} from './typesCore.js'

export type MatOSWorkbenchProjectActivityItem = {
  id: string
  kind: 'trace'
  title: string
  status?: string
  timestamp?: string
  traceId: string
  sessionIds: string[]
  roleRef?: string
  resourceRefs: string[]
  workflowEventCount: number
  toolCallCount: number
  turnCount: number
  actions: MatOSWorkbenchAction[]
  matos: unknown
}

export type MatOSWorkbenchProjectActivity = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  items: MatOSWorkbenchProjectActivityItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    source: 'matos-trace-index'
  }
  sources?: unknown
}

export type MatOSWorkbenchProjectRunItem = {
  id: string
  runId: string
  workflowRef: string
  title: string
  status: string
  createdAt?: string
  updatedAt?: string
  waitingNodeId?: string
  nodeCount: number
  finishedNodeCount: number
  failedNodeCount: number
  eventCount: number
  artifactCount: number
  approvalCount: number
  pendingApprovalCount: number
  traceRefs: string[]
  trace?: Record<string, unknown>
  provenance?: Record<string, unknown>
  resourceRefs: string[]
  actions: MatOSWorkbenchAction[]
  matos: unknown
}

export type MatOSWorkbenchProjectRuns = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  runs: MatOSWorkbenchProjectRunItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    source: 'matos-workflow-runs'
  }
  sources?: unknown
}

export type MatOSWorkbenchProjectRunDetail = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  run: MatOSWorkbenchProjectRunItem
  resource: MatOSWorkbenchResource
  relatedResources: MatOSWorkbenchResource[]
  summary: {
    source: 'matos-workflow-runs'
    selector: string
    matchedBy: 'runId' | 'id' | 'resourceRef'
  }
  sources?: unknown
  raw?: unknown
}

export type MatOSWorkbenchProjectArtifactItem = {
  id: string
  artifactId: string
  runId: string
  workflowRef: string
  title: string
  kind?: string
  mediaType?: string
  nodeId?: string
  path?: string
  updatedAt?: string
  resourceRefs: string[]
  actions: MatOSWorkbenchAction[]
  matos: unknown
}

export type MatOSWorkbenchProjectArtifacts = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  artifacts: MatOSWorkbenchProjectArtifactItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    source: 'matos-workflow-artifacts'
  }
  sources?: unknown
}

export type MatOSWorkbenchProjectArtifactDetail = {
  project: MatOSWorkbenchProjectArtifacts['project']
  artifact: MatOSWorkbenchProjectArtifactItem
  resource: MatOSWorkbenchResource
  relatedResources: MatOSWorkbenchResource[]
  summary: {
    artifactId: string
    matchedBy: 'artifactId' | 'id' | 'resourceRef'
    runId: string
    workflowRef: string
    nodeId?: string
    source: 'matos-workflow-artifacts'
  }
  sources?: unknown
  raw?: unknown
}

export type MatOSWorkbenchProjectComputeItem = {
  id: string
  jobId: string
  title: string
  status: string
  pid?: number
  username?: string
  command?: string
  gpuIndex?: number
  memoryUsedMiB?: number
  ownerKind?: string
  container?: string
  external: boolean
  actionable: boolean
  resourceRefs: string[]
  actions: MatOSWorkbenchAction[]
  matos: unknown
}

export type MatOSWorkbenchProjectCompute = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  computeJobs: MatOSWorkbenchProjectComputeItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    status: string
    source: 'matos-gpu-watchdog'
    gpuSummary: Record<string, unknown>
  }
  sources?: unknown
}

export type MatOSWorkbenchProjectComputeHistoryItem = {
  id: string
  jobId: string
  taskId?: string
  runId: string
  workflowRef: string
  nodeId: string
  title: string
  status: string
  backend?: string
  operation?: string
  toolRef?: string
  workdir?: string
  remoteWorkdir?: string
  updatedAt?: string
  startedAt?: string
  finishedAt?: string
  logFetched?: boolean
  resourceRefs: string[]
  actions: MatOSWorkbenchAction[]
  reconcile?: {
    source?: string
    taskId?: string
    status?: string
    recordedAt?: string
    ok?: boolean
  }
  matos: unknown
}

export type MatOSWorkbenchProjectComputeHistory = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  computeJobs: MatOSWorkbenchProjectComputeHistoryItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    statusCounts: Record<string, number>
    backendCounts: Record<string, number>
    source: 'matos-workflow-compute-history'
  }
  sources?: unknown
}

export type MatOSWorkbenchProjectComputeJobDetail = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  job: MatOSWorkbenchProjectComputeItem | MatOSWorkbenchProjectComputeHistoryItem
  resource: MatOSWorkbenchResource
  relatedResources: MatOSWorkbenchResource[]
  summary: {
    jobId: string
    matchedBy: 'jobId' | 'id' | 'resourceRef'
    status: string
    source: 'matos-gpu-watchdog' | 'matos-workflow-compute-history'
    gpuSummary?: Record<string, unknown>
    history?: {
      runId: string
      workflowRef: string
      nodeId: string
      taskId?: string
      backend?: string
      reconcile?: MatOSWorkbenchProjectComputeHistoryItem['reconcile']
    }
  }
  sources?: unknown
  raw?: unknown
}

export type MatOSWorkbenchProjectComputeJobAction = {
  project: MatOSWorkbenchProjectComputeJobDetail['project']
  job: MatOSWorkbenchProjectComputeJobDetail['job']
  resource: MatOSWorkbenchResource
  relatedResources: MatOSWorkbenchResource[]
  summary: MatOSWorkbenchProjectComputeJobDetail['summary'] & {
    actionKey: MatOSWorkbenchActionKey
    source: MatOSWorkbenchProjectComputeJobDetail['summary']['source']
  }
  actionKey: MatOSWorkbenchActionKey
  action: MatOSWorkbenchAction
  mode:
    | 'route-action-preview'
    | 'controlled-action-preview'
    | 'controlled-action-applied'
    | 'read-only-action-preview'
  invoked: boolean
  readonly: boolean
  reason: string
  route?: MatOSWorkbenchCommandRoute
  transaction?: MatOSWorkbenchWriteTransactionPreview
  validation: {
    ok: boolean
    errors: Array<{ code: string; message: string }>
  }
  write: {
    enabled: boolean
    reason: string
  }
  applyResult?: {
    source: 'matos-workflow-reconcile'
    runId: string
    appliedAt: string
    reason?: string
    reconciledCount: number
    reconciled: unknown[]
    run: unknown
  }
  operationEvidence: {
    source: MatOSWorkbenchProjectComputeJobDetail['summary']['source']
    matchedBy: MatOSWorkbenchProjectComputeJobDetail['summary']['matchedBy']
    actionKey: MatOSWorkbenchActionKey
    route?: MatOSWorkbenchCommandRoute
    mode:
      | 'route-action-preview'
      | 'controlled-action-preview'
      | 'controlled-action-applied'
      | 'read-only-action-preview'
    invoked: boolean
    readonly: boolean
    validationOk: boolean
    writeEnabled: boolean
    reason: string
    history?: MatOSWorkbenchProjectComputeJobDetail['summary']['history']
    confirmationFingerprint?: string
    nextNativeStep:
      | 'open-route'
      | 'blocked-read-only'
      | 'requires-native-writer'
      | 'requires-confirmation'
      | 'applied'
  }
  sources?: unknown
  raw?: unknown
}

export type MatOSWorkbenchProjectBenchmarkItem = {
  id: string
  resourceRef: string
  type: 'benchmark' | 'benchmark-suite' | 'evaluation'
  title: string
  description?: string
  status?: string
  tags: string[]
  dependencies: string[]
  actions: MatOSWorkbenchAction[]
  matos: MatOSWorkbenchResource
}

export type MatOSWorkbenchProjectBenchmarks = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  benchmarks: MatOSWorkbenchProjectBenchmarkItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    typeCounts: Record<string, number>
    source: 'matos-asset-registry'
  }
}

export type MatOSWorkbenchProjectBenchmarkDetail = {
  project: {
    id: string
    name: string
    cwd: string
    scopeRef?: string
  }
  benchmark: MatOSWorkbenchProjectBenchmarkItem
  resource: MatOSWorkbenchResource
  detail: MatOSWorkbenchResourceShow
  relatedResources: MatOSWorkbenchResource[]
  summary: {
    resourceRef: string
    type: 'benchmark' | 'benchmark-suite' | 'evaluation'
    status?: string
    source: 'matos-asset-registry'
  }
}
