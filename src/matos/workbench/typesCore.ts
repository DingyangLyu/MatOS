import type { MatOSAssetWorkbenchState } from '../assets/graph/viewModels.js'
import type { MatOSAssetLifecycleStatus } from '../assets/types.js'
import type {
MatOSWorkbenchReleaseApplyResult,
MatOSWorkbenchReleasePreview,
} from './typesEvolutionRelease.js'
import type { MatOSWorkbenchRoleDraftApplyResult } from './typesRoleTool.js'

export type MatOSWorkbenchContext = {
  cwd: string
  scopeRef?: string
  projectId?: string
  env?: Record<string, string | undefined>
}

export type MatOSWorkbenchResourceType =
  | 'role'
  | 'workflow'
  | 'tool'
  | 'skill'
  | 'plugin'
  | 'mcp'
  | 'knowledge'
  | 'data'
  | 'benchmark'
  | 'benchmark-suite'
  | 'evaluation'
  | 'experience'
  | 'evolution-proposal'
  | 'runtime'
  | 'compute-job'
  | 'workflow-run'
  | 'artifact'
  | 'trace'
  | 'asset'

export type MatOSWorkbenchActionKey =
  | 'open'
  | 'edit'
  | 'run'
  | 'debug'
  | 'validate'
  | 'compile'
  | 'publish'
  | 'approve'
  | 'reject'
  | 'rollback'
  | 'duplicate'
  | 'disable'
  | 'enable'
  | 'view-trace'
  | 'view-transcript'
  | 'view-lineage'
  | 'compose'
  | 'attach'
  | 'detach'
  | 'retrieve'
  | 'inspect'
  | 'import'
  | 'install'
  | 'reconcile'
  | 'recover'
  | 'recover-apply'
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'respond'
  | 'retry-node'
  | 'skip-node'
  | 'view-role-job'
  | 'view-role-job-chat'
  | 'cancel-role-job'
  | 'validate-source'
  | 'refresh-source'
  | 'commit-source'
  | 'accept-source'
  | 'rollback-source'

export type MatOSWorkbenchGitGovernanceAction = {
  key:
    | 'open-gitea'
    | 'open-history'
    | 'open-pulls'
    | 'validate-source'
    | 'refresh-source'
    | 'commit-source'
    | 'accept-source'
    | 'rollback-source'
  label: string
  enabled: boolean
  kind: 'external-link' | 'matos-cli'
  url?: string
  command?: MatOSWorkbenchCommandRoute
  reason?: string
}

export type MatOSWorkbenchGitGovernance = {
  sourceId?: string
  provider?: string
  scope?: string
  scopeRef?: string
  repo?: string
  ref?: string
  runtimeRef?: {
    mode?: string
    ref?: string
    commit?: string
    acceptedAt?: string
    acceptedBy?: string
    validationRecord?: string
  }
  subdir?: string
  currentRemote?: string
  currentCommit?: string
  repository?: {
    owner?: string
    repo?: string
    visibility?: string
    webUrl?: string
    cloneUrl?: string
  }
  actions: MatOSWorkbenchGitGovernanceAction[]
}

export type MatOSWorkbenchCommandRoute = {
  argv: string[]
  command: string
}

export type MatOSWorkbenchOperatorReview = {
  mode: 'native-operator-review'
  status:
    | 'not-required'
    | 'preview-only'
    | 'confirmation-required'
    | 'operator-only'
    | 'blocked'
    | 'applied'
  policy:
    | 'native-read-only'
    | 'native-route'
    | 'project-local-controlled-write'
    | 'asset-history-release'
    | 'operator-audit'
    | 'shared-global-promotion-blocked'
    | 'real-tool-execution-disabled'
  reason: string
  targetRef?: string
  targetType?: MatOSWorkbenchResourceType | 'unknown'
  source?: string
  viewerGate?: {
    required?: 'operator'
    current?: 'user' | 'operator'
    satisfied: boolean
    reason?: string
  }
  scopeGate?: {
    allowedSources: string[]
    actualSource?: string
    status: 'passed' | 'blocked' | 'unknown'
    reason: string
  }
  nativeNextStep?: {
    label: string
    description: string
    route?: MatOSWorkbenchCommandRoute
    endpoint?: string
  }
}

export type MatOSWorkbenchActionContract = {
  source: 'matos-action-contract'
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  effects: Array<'read' | 'execute' | 'write' | 'asset-history' | 'workflow-run' | 'model-call' | 'human-input'>
  permission: {
    maturity: 'read-only' | 'route-only' | 'controlled-mutation'
    enabled: boolean
    requiresConfirmation: boolean
    danger: boolean
    reason?: string
  }
  native: {
    route?: MatOSWorkbenchCommandRoute
    previewEndpoint?: string
    applyEndpoint?: string
  }
  operatorReview?: MatOSWorkbenchOperatorReview
}

export type MatOSWorkbenchAction = {
  key: MatOSWorkbenchActionKey
  label: string
  enabled: boolean
  maturity?: 'read-only' | 'route-only' | 'controlled-mutation'
  reason?: string
  danger?: boolean
  requiresConfirmation?: boolean
  confirmationFingerprint?: string
  command?: MatOSWorkbenchCommandRoute
  contract?: MatOSWorkbenchActionContract
  operatorReview?: MatOSWorkbenchOperatorReview
}

export type MatOSWorkbenchWriteTransactionGateStatus =
  | 'passed'
  | 'blocked'
  | 'pending'
  | 'unknown'

export type MatOSWorkbenchWriteTransactionGate = {
  key:
    | 'canonical-target'
    | 'draft-validation'
    | 'permission-scope'
    | 'history-snapshot'
    | 'rollback-target'
    | 'deterministic-smoke'
    | 'audit-record'
    | 'semantic-acceptance'
    | 'write-gate'
  label: string
  status: MatOSWorkbenchWriteTransactionGateStatus
  summary: string
  evidence?: unknown
}

export type MatOSWorkbenchWriteTransactionPreview = {
  mode: 'write-transaction-preview'
  readonly: true
  canMutate: false
  source:
    | 'coze-workflow-canvas'
    | 'coze-agent-ide'
    | 'coze-resource-ui'
    | 'matos-release'
  requestedMutation: string
  targetRef?: string
  targetType?: MatOSWorkbenchResourceType | 'unknown'
  scopeRef?: string
  confirmationFingerprint: string
  validation: {
    ok: boolean
    errorCount: number
    warningCount: number
  }
  gates: MatOSWorkbenchWriteTransactionGate[]
  rollback: {
    required: true
    snapshotRequired: true
    targets: unknown[]
  }
  audit: {
    required: true
    target: 'matos-asset-history'
    recordType: 'asset-write-transaction'
  }
  write: {
    enabled: false
    reason: string
  }
}

export type MatOSWorkbenchResourceActionInvocation = {
  mode:
    | 'route-action-preview'
    | 'controlled-action-preview'
    | 'read-only-action-preview'
  ref: string
  actionKey: MatOSWorkbenchActionKey
  action: MatOSWorkbenchAction
  invoked: boolean
  readonly: boolean
  reason: string
  route?: MatOSWorkbenchCommandRoute
  validation: {
    ok: boolean
    errors: Array<{ code: string; message: string }>
  }
  write: {
    enabled: boolean
    reason: string
    status?: 'preview' | 'applied' | 'rolled-back'
  }
  transaction?: MatOSWorkbenchWriteTransactionPreview
  draft?: unknown
  appliedRoleDraft?: MatOSWorkbenchRoleDraftApplyResult
  releasePreview?: MatOSWorkbenchReleasePreview
  releaseApplyResult?: MatOSWorkbenchReleaseApplyResult
}

export type MatOSWorkbenchWarning = {
  code: string
  message: string
  severity?: 'info' | 'warning' | 'error'
}

export type MatOSWorkbenchSearchRanking = {
  query: string
  rank: number
  score: number
  matched: boolean
  tokens: string[]
  reasons: Array<{
    field: string
    kind: 'exact' | 'prefix' | 'contains' | 'token' | 'unfiltered'
    score: number
    value?: string
  }>
}

export type MatOSWorkbenchResource = {
  id: string
  ref: string
  type: MatOSWorkbenchResourceType
  name: string
  description?: string
  scopeRef?: string
  lifecycle?: MatOSAssetLifecycleStatus
  status?: string
  icon?: string
  tags?: string[]
  owner?: { id?: string; name?: string }
  updatedAt?: string
  source?: string
  packId?: string
  version?: string
  dependencies?: string[]
  lineage?: {
    eventCount?: number
    latestEventAt?: string
    rollbackTargetCount?: number
    parents?: string[]
    children?: string[]
    releases?: string[]
  }
  metadata?: Record<string, unknown>
  gitGovernance?: MatOSWorkbenchGitGovernance
  searchRanking?: MatOSWorkbenchSearchRanking
  actions: MatOSWorkbenchAction[]
  warnings?: MatOSWorkbenchWarning[]
}

export type MatOSWorkbenchResourceList = {
  resources: MatOSWorkbenchResource[]
  groups: Array<{
    type: MatOSWorkbenchResourceType
    count: number
    resources: MatOSWorkbenchResource[]
  }>
  summary: {
    /**
     * Current page item count. Use `total` for the complete resource count.
     */
    count: number
    pageCount?: number
    /**
     * Complete resource count for this query, including static assets and
     * dynamic runtime records such as traces or workflow runs.
     */
    total: number
    /**
     * Complete static MatOS asset count for this query. UI surfaces that say
     * "assets" should prefer this over `total`.
     */
    assetTotal?: number
    staticTotal?: number
    dynamicTotal?: number
    offset: number
    limit: number
    typeCounts: Record<string, number>
    staticTypeCounts?: Record<string, number>
    dynamicTypeCounts?: Record<string, number>
  }
}

export type MatOSWorkbenchResourceDetailTabKey =
  | 'overview'
  | 'dependencies'
  | 'consumers'
  | 'runs'
  | 'benchmarks'
  | 'evolution'
  | 'history'
  | 'raw'

export type MatOSWorkbenchResourceDetailTab = {
  key: MatOSWorkbenchResourceDetailTabKey
  label: string
  status: 'ready' | 'empty' | 'disabled'
  count: number
  summary?: string
  items?: unknown[]
}

export type MatOSWorkbenchResourceEntryContent = {
  path: string
  format: 'markdown' | 'json' | 'yaml' | 'text'
  content: string
  bytes: number
  truncated: boolean
}

export type MatOSWorkbenchResourceDetail = {
  canonicalRef: string
  type: MatOSWorkbenchResourceType
  name: string
  scopeRef?: string
  lifecycle?: MatOSAssetLifecycleStatus
  version?: string
  overview: {
    description?: string
    source?: string
    packId?: string
    tags: string[]
    metadata: Record<string, unknown>
    gitGovernance?: MatOSWorkbenchGitGovernance
    actions: MatOSWorkbenchAction[]
  }
  relationships: {
    dependencies: string[]
    consumers: string[]
    related: unknown[]
  }
  history: {
    eventCount: number
    stableRelease?: string
    rollbackTargets: unknown[]
    events: unknown[]
  }
  evidence: {
    workflowRuns: unknown[]
    traces: unknown[]
    benchmarks: unknown[]
    evaluations: unknown[]
    computeJobs: unknown[]
    evolutionRecords?: unknown[]
    artifacts?: unknown[]
    runtimeScopes?: unknown[]
  }
  entryContent?: MatOSWorkbenchResourceEntryContent
  facets?: {
    knowledge?: {
      formatType?: string
      documents: unknown[]
      sources: unknown[]
      indexing?: unknown
      provenance?: unknown
    }
    data?: {
      fields: unknown[]
      recordsPreview: unknown[]
      recordCount: number
      schema?: unknown
      artifacts: unknown[]
    }
    tool?: {
      binding?: string
      kind?: string
      builtinTools: string[]
      mcpServers: string[]
      apis: unknown[]
      commands: unknown[]
      examples: unknown[]
      runbook?: unknown
      inputSchema?: unknown
      outputSchema?: unknown
      permissionSummary?: unknown
    }
  }
  tabs: MatOSWorkbenchResourceDetailTab[]
}

export type MatOSWorkbenchResourceQuery = MatOSWorkbenchContext & {
  types?: string[]
  query?: string
  limit?: number
  offset?: number
  includeDisabled?: boolean
  includeHidden?: boolean
  includeLineage?: boolean
  lightweight?: boolean
  scriptRunner?: unknown
}

export type MatOSWorkbenchResourceShow = {
  resource: MatOSWorkbenchResource
  detail?: MatOSWorkbenchResourceDetail
  graph?: MatOSAssetWorkbenchState
}
