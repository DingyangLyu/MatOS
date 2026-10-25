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

import type { MatOSAssetWorkbenchState } from '../assets/graph/viewModels.js'
import type {
MatOSAssetHistoryReleaseRecord,
MatOSAssetHistorySnapshotRecord,
MatOSAssetHistoryValidationResult,
} from '../assets/history/types.js'
import type { MatOSAssetLifecycleStatus } from '../assets/types.js'
import type { MatOSWorkbenchEvolutionAuditActionRecord } from './evolutionAuditActions.js'

import type {
MatOSWorkbenchAction,
MatOSWorkbenchOperatorReview,
MatOSWorkbenchResource,
MatOSWorkbenchResourceDetail,
MatOSWorkbenchResourceShow,
MatOSWorkbenchResourceType,
MatOSWorkbenchWriteTransactionPreview
} from './typesCore.js'

export type MatOSWorkbenchEvolutionInbox = {
  resources: MatOSWorkbenchResource[]
  monitorRecords: unknown[]
  directEditorRuns: unknown[]
  auditActionRecords: MatOSWorkbenchEvolutionAuditActionRecord[]
  experiences: unknown[]
  summary: {
    resourceCount: number
    monitorRecordCount: number
    directEditorRunCount: number
    auditActionCount: number
    experienceCount: number
    hiddenInternalRecordCount?: number
    visibility?: {
      viewerMode: 'user' | 'operator'
      includeHidden: boolean
      policy:
        | 'public-evolution-assets'
        | 'operator-audit'
        | 'public-asset-genome'
        | 'operator-asset-genome'
        | 'public-evolution-forest'
        | 'operator-evolution-forest'
      hiddenKinds?: string[]
    }
  }
}

export type MatOSWorkbenchEvolutionRecordKind =
  | 'monitor-record'
  | 'direct-editor-run'
  | 'audit-action'
  | 'experience'
  | 'asset'

export type MatOSWorkbenchEvolutionGateStatus =
  | 'passed'
  | 'failed'
  | 'pending'
  | 'not-run'
  | 'unknown'

export type MatOSWorkbenchEvolutionGate = {
  key:
    | 'deterministic-validation'
    | 'semantic-acceptance'
    | 'gitea-audit-files'
    | 'gitea-status'
  label: string
  status: MatOSWorkbenchEvolutionGateStatus
  summary?: string
  evidence?: unknown
}

export type MatOSWorkbenchEvolutionDetail = {
  ref: string
  kind: MatOSWorkbenchEvolutionRecordKind
  title: string
  status: string
  summary?: string
  createdAt?: string
  updatedAt?: string
  trigger?: {
    kind?: string
    key?: string
    eventId?: string
    summary?: string
  }
  evidenceRefs: string[]
  changedAssets: {
    updated: string[]
    created: string[]
    disabled: string[]
  }
  snapshots: {
    before?: string
    after?: string
    rollback?: string
  }
  diff?: {
    patchPath?: string
    summary?: unknown
    visual?: {
      files: Array<{
        path: string
        additions: number
        deletions: number
      }>
      additions: number
      deletions: number
      preview: string
      truncated: boolean
    }
  }
  validation?: unknown
  semanticJudge?: unknown
  rollback?: unknown
  gates: MatOSWorkbenchEvolutionGate[]
  provenance: {
    traceId?: string
    sessionId?: string
    monitorRecordId?: string
    directEditorRunId?: string
    resourceRef?: string
    experienceRefs: string[]
  }
  releasePacket: {
    mode: 'read-only-audit'
    canMutate: false
    actions: MatOSWorkbenchAction[]
    rollbackTargets: string[]
    confirmationFingerprint?: string
    operatorReview?: MatOSWorkbenchOperatorReview
  }
  raw?: unknown
}

export type MatOSWorkbenchEvolutionRecordShow = {
  kind: MatOSWorkbenchEvolutionRecordKind
  record?: unknown
  run?: unknown
  auditActionRecord?: MatOSWorkbenchEvolutionAuditActionRecord
  experience?: unknown
  resource?: MatOSWorkbenchResource
  detail: MatOSWorkbenchEvolutionDetail
  graph?: MatOSAssetWorkbenchState
}

export type MatOSWorkbenchEvolutionActionPreview = {
  ref: string
  action: 'inspect' | 'approve' | 'reject' | 'rollback'
  mode: 'controlled-action-preview'
  invoked: boolean
  readonly: boolean
  reason: string
  targetRef?: string
  requiredFingerprint?: string
  suppliedFingerprint?: string
  validation: {
    ok: boolean
    errors: Array<{ code: string; message: string }>
  }
  detail: MatOSWorkbenchEvolutionDetail
  releasePacket: MatOSWorkbenchEvolutionDetail['releasePacket']
  operatorReview?: MatOSWorkbenchOperatorReview
  releasePreview?: MatOSWorkbenchReleasePreview
  releaseApplyResult?: MatOSWorkbenchReleaseApplyResult
  auditActionRecord?: MatOSWorkbenchEvolutionAuditActionRecord
}

export type MatOSWorkbenchEvolutionTreeMode =
  | 'personal'
  | 'promotion'
  | 'runtime'
  | 'audit'
  | 'asset'
  | 'forest'

export type MatOSWorkbenchEvolutionTreeNodeKind =
  | 'runtime'
  | 'accepted-ref'
  | 'session'
  | 'workflow-run'
  | 'experience'
  | 'direct-edit'
  | 'validation'
  | 'gitea-audit'
  | 'commit'
  | 'promotion-pr'
  | 'asset'
  | 'rollback'
  | 'audit-action'

export type MatOSWorkbenchEvolutionTreeNodeStatus =
  | 'accepted'
  | 'running'
  | 'pending'
  | 'blocked'
  | 'failed'
  | 'rolled-back'
  | 'noop'
  | 'draft'
  | 'unknown'

export type MatOSWorkbenchEvolutionTreeNode = {
  id: string
  kind: MatOSWorkbenchEvolutionTreeNodeKind
  label: string
  ref?: string
  scopeRef?: string
  status: MatOSWorkbenchEvolutionTreeNodeStatus
  lane: string
  summary?: string
  timestamp?: string
  assetRefs: string[]
  evidenceRefs: string[]
  gitea?: {
    sourceId?: string
    repo?: string
    ref?: string
    commit?: string
    acceptedAt?: string
    webUrl?: string
    prUrl?: string
    audit?: {
      jsonPath?: string
      summaryPath?: string
      diffPath?: string
      statusWritten?: boolean
    }
  }
  gates?: Array<Pick<MatOSWorkbenchEvolutionGate, 'key' | 'label' | 'status' | 'summary'>>
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchEvolutionTreeEdge = {
  id: string
  source: string
  target: string
  kind:
    | 'triggered'
    | 'produced'
    | 'edited'
    | 'validated'
    | 'committed'
    | 'accepted-as'
    | 'rolled-back'
    | 'audited'
    | 'depends-on'
  label?: string
  status?: MatOSWorkbenchEvolutionTreeNodeStatus
}

export type MatOSWorkbenchEvolutionTreeLane = {
  id: string
  label: string
  order: number
  summary?: string
}

export type MatOSWorkbenchEvolutionTreeView = {
  mode: 'matos-evolution-tree'
  treeMode: MatOSWorkbenchEvolutionTreeMode
  scopeRef?: string
  assetRef?: string
  viewerMode: 'user' | 'operator'
  rootNodeId: string
  lanes: MatOSWorkbenchEvolutionTreeLane[]
  nodes: MatOSWorkbenchEvolutionTreeNode[]
  edges: MatOSWorkbenchEvolutionTreeEdge[]
  summary: {
    nodeCount: number
    edgeCount: number
    assetCount: number
    experienceCount: number
    directEditCount: number
    acceptedRefCount: number
    hiddenInternalRecordCount: number
    truncated: boolean
  }
  visibility: NonNullable<MatOSWorkbenchEvolutionInbox['summary']['visibility']>
}

export type MatOSWorkbenchAssetGenomeNode = {
  id: string
  kind: string
  label: string
  shortLabel: string
  ref?: string
  status: MatOSWorkbenchEvolutionTreeNodeStatus | 'current' | 'candidate' | 'evidence-only' | 'hidden'
  timestamp?: string
  weight: number
  summary?: string
  sourceRecords: Array<{
    kind: 'asset-history' | 'asset-graph' | 'evolution-tree' | 'gitea' | 'experience'
    ref: string
  }>
  actions: MatOSWorkbenchAction[]
}

export type MatOSWorkbenchAssetGenomeBranch = {
  id: string
  kind: 'learning' | 'release' | 'rollback' | 'promotion' | 'dependency'
  label: string
  status: MatOSWorkbenchAssetGenomeNode['status']
  nodes: MatOSWorkbenchAssetGenomeNode[]
  edgeIds: string[]
}

export type MatOSWorkbenchAssetGenomeEdge = {
  id: string
  source: string
  target: string
  kind: string
  label: string
  status?: MatOSWorkbenchAssetGenomeNode['status']
}

export type MatOSWorkbenchAssetGenomeTreeView = {
  mode: 'matos-asset-genome-tree'
  treeMode: 'asset'
  scopeRef?: string
  assetRef: string
  viewerMode: 'user' | 'operator'
  current: MatOSWorkbenchAssetGenomeNode
  trunk: MatOSWorkbenchAssetGenomeNode[]
  branches: MatOSWorkbenchAssetGenomeBranch[]
  leaves: MatOSWorkbenchAssetGenomeNode[]
  edges: MatOSWorkbenchAssetGenomeEdge[]
  clusters: Array<{
    id: string
    kind: string
    label: string
    count: number
    nodeIds: string[]
  }>
  summary: {
    acceptedRevisionCount: number
    learningBranchCount: number
    changedAssetCount: number
    rollbackTargetCount: number
    promotionCandidateCount: number
    hiddenInternalRecordCount: number
    truncated: boolean
  }
  visibility: NonNullable<MatOSWorkbenchEvolutionInbox['summary']['visibility']>
}

export type MatOSWorkbenchEvolutionForestNode = {
  id: string
  kind: 'runtime' | 'accepted-source'
  label: string
  ref?: string
  status: MatOSWorkbenchEvolutionTreeNodeStatus
  summary?: string
}

export type MatOSWorkbenchEvolutionForestCluster = {
  id: string
  kind: 'asset-type' | 'learning-status' | 'promotion' | 'scope'
  label: string
  count: number
  nodeIds: string[]
  status?: MatOSWorkbenchEvolutionTreeNodeStatus
}

export type MatOSWorkbenchEvolutionForestEdge = {
  id: string
  source: string
  target: string
  kind: 'summarizes' | 'accepts' | 'contains'
  label?: string
}

export type MatOSWorkbenchEvolutionForestView = {
  mode: 'matos-evolution-forest'
  treeMode: 'forest'
  scopeRef?: string
  viewerMode: 'user' | 'operator'
  roots: MatOSWorkbenchEvolutionForestNode[]
  clusters: MatOSWorkbenchEvolutionForestCluster[]
  edges: MatOSWorkbenchEvolutionForestEdge[]
  summary: {
    rootCount: number
    clusterCount: number
    totalAssetCount: number
    totalExperienceCount: number
    totalDirectEditCount: number
    hiddenInternalRecordCount: number
    truncated: boolean
  }
  visibility: NonNullable<MatOSWorkbenchEvolutionInbox['summary']['visibility']>
}

export type MatOSWorkbenchEvolutionTreeResult =
  | MatOSWorkbenchEvolutionTreeView
  | MatOSWorkbenchAssetGenomeTreeView
  | MatOSWorkbenchEvolutionForestView

export type MatOSWorkbenchReleaseAction =
  | 'publish'
  | 'approve'
  | 'reject'
  | 'rollback'

export type MatOSWorkbenchReleaseGate = {
  key:
    | 'resource-resolved'
    | 'resource-visible'
    | 'dependency-graph'
    | 'write-gate'
  label: string
  status: 'passed' | 'blocked' | 'unknown'
  summary: string
  evidence?: unknown
}

export type MatOSWorkbenchReleasePreview = {
  mode: 'release-preview'
  readonly: true
  ref: string
  requestedAction: MatOSWorkbenchReleaseAction
  resource: MatOSWorkbenchResource
  detail?: MatOSWorkbenchResourceDetail
  summary: {
    type: MatOSWorkbenchResourceType
    name: string
    version?: string
    lifecycle?: MatOSAssetLifecycleStatus
    dependencyCount: number
    consumerCount: number
    rollbackTargetCount: number
  }
  gates: MatOSWorkbenchReleaseGate[]
  provenance: {
    source?: string
    packId?: string
    path?: string
    dependencies: string[]
    consumers: string[]
    rollbackTargets: unknown[]
  }
  releasePacket: {
    mode: 'read-only-release-preview'
    canMutate: false
    action: MatOSWorkbenchReleaseAction
    confirmationFingerprint: string
    actions: MatOSWorkbenchAction[]
    rollbackTargets: unknown[]
    dependencies: string[]
    consumers: string[]
    operatorReview: MatOSWorkbenchOperatorReview
  }
  operatorReview: MatOSWorkbenchOperatorReview
  transaction: MatOSWorkbenchWriteTransactionPreview
  write: {
    enabled: false
    reason: string
  }
}

export type MatOSWorkbenchReleaseApplyResult = {
  mode: 'controlled-write'
  source: 'matos-release'
  action: MatOSWorkbenchReleaseAction
  ref: string
  applied: boolean
  readonly: false
  preview: MatOSWorkbenchReleasePreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  before?: MatOSWorkbenchResourceShow
  after?: MatOSWorkbenchResourceShow
  snapshot?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
  release?: MatOSAssetHistoryReleaseRecord
  rollback?: {
    releaseId: string
    restoredSnapshot: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    restoredFiles: string[]
    removedFiles: string[]
  }
  validation?: MatOSAssetHistoryValidationResult
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'releases.apply'
    reason?: string
  }
}
