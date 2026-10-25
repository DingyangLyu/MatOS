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

import type { MatOSAsset } from '../types.js'
import type { MatOSAssetRegistry } from '../registry.js'

export type MatOSAssetGraphEdgeKind =
  | 'depends_on'
  | 'mounts_knowledge'
  | 'mounts_data'
  | 'mounts_skill'
  | 'mounts_tool'
  | 'uses_tool'
  | 'uses_runtime'
  | 'uses_plugin'
  | 'uses_mcp'
  | 'subworkflow'
  | 'validates'
  | 'benchmarks'
  | 'derived_from'
  | 'evidence_for'
  | 'edited_by'
  | 'created_by'
  | 'updated_by'
  | 'disabled_by'
  | 'snapshot_before'
  | 'snapshot_after'
  | 'rolled_back_to'
  | 'released_as'
  | 'previous_stable'
  | 'used_in_session'
  | 'used_in_workflow_run'
  | 'similar_to'
  | 'same_group'
  | 'same_tag'
  | 'revision_of'

export type MatOSAssetGraphEdgeSource =
  | 'manifest'
  | 'metadata'
  | 'history'
  | 'evolution'
  | 'trace'
  | 'workflow'
  | 'content'

export type MatOSAssetGraphProviderStage =
  | 'relation'
  | 'type-local'
  | 'lineage'
  | 'usage'
  | 'similarity'

export type MatOSAssetGraphProfile =
  | 'core'
  | 'discovery'
  | 'evidence'
  | 'full'

export type MatOSAssetGraphNodeKind =
  | 'asset'
  | 'asset-revision'
  | 'snapshot'
  | 'release'
  | 'direct-editor-run'
  | 'experience'
  | 'trace'
  | 'workflow-run'
  | 'event'

export type MatOSAssetGraphNode = {
  id: string
  kind: MatOSAssetGraphNodeKind
  label: string
  assetType?: string
  canonicalKey?: string
  name?: string
  version?: string
  description?: string
  tags?: string[]
  lifecycleStatus?: string
  source?: string
  packId?: string
  reference?: string
  createdAt?: string
  metadata?: Record<string, unknown>
}

export type MatOSAssetGraphEdge = {
  from: string
  to: string
  kind: MatOSAssetGraphEdgeKind
  source: MatOSAssetGraphEdgeSource
  reference?: string
  weight?: number
  confidence?: number
  evidenceRefs?: string[]
  createdAt?: string
}

export type MatOSAssetGraphIssue = {
  code: string
  message: string
  assetKey?: string
  providerId?: string
  severity?: 'info' | 'warning' | 'error'
}

export type MatOSAssetSearchDocument = {
  id: string
  assetKey: string
  assetType: string
  title: string
  text: string
  tags: string[]
  terms: Record<string, number>
  exactAliases?: string[]
  metadata?: Record<string, unknown>
}

export type MatOSAssetSearchIndex = {
  documents: Record<string, MatOSAssetSearchDocument>
  documentCount: number
  vocabulary: Record<string, number>
}

export type MatOSAssetTypeGraph = {
  assetType: string
  nodes: string[]
  edges: MatOSAssetGraphEdge[]
  stats: {
    nodeCount: number
    edgeCount: number
  }
}

export type MatOSAssetLineageSummary = {
  assetKey: string
  eventCount: number
  latestEventAt?: string
  rollbackTargetCount: number
}

export type MatOSAssetGraphStats = {
  assetCount: number
  nodeCount: number
  edgeCount: number
  providerCount: number
  typeCounts: Record<string, number>
  edgeKindCounts: Record<string, number>
  issueCount: number
}

export type MatOSAssetGraphIndex = {
  schemaVersion: 1
  generatedAt: string
  root: string
  scope?: string
  nodes: Record<string, MatOSAssetGraphNode>
  edges: MatOSAssetGraphEdge[]
  reverseEdges: Record<string, MatOSAssetGraphEdge[]>
  typeGraphs: Record<string, MatOSAssetTypeGraph>
  lineage: Record<string, MatOSAssetLineageSummary>
  search: MatOSAssetSearchIndex
  stats: MatOSAssetGraphStats
  issues: MatOSAssetGraphIssue[]
}

export type MatOSAssetGraphBuildOptions = {
  profile?: MatOSAssetGraphProfile
  includeLineage?: boolean
  includeUsage?: boolean
  includeDisabled?: boolean
  includeHidden?: boolean
  exposeRootPath?: boolean
  includeEntryExcerpts?: boolean
  scope?: string
  generatedAt?: string
}

export type MatOSAssetGraphProviderContext = {
  cwd: string
  registry: MatOSAssetRegistry
  assets: MatOSAsset[]
  options: MatOSAssetGraphBuildOptions
}

export type MatOSAssetGraphProviderResult = {
  nodes?: MatOSAssetGraphNode[]
  edges?: MatOSAssetGraphEdge[]
  issues?: MatOSAssetGraphIssue[]
  searchDocuments?: MatOSAssetSearchDocument[]
}

export type MatOSAssetGraphProvider = {
  id: string
  stage: MatOSAssetGraphProviderStage
  build: (
    context: MatOSAssetGraphProviderContext,
  ) => Promise<MatOSAssetGraphProviderResult> | MatOSAssetGraphProviderResult
}

export type MatOSAssetGraphBuildInput = {
  cwd: string
  assets?: MatOSAsset[]
  registry?: MatOSAssetRegistry
  options?: MatOSAssetGraphBuildOptions
  providers?: MatOSAssetGraphProvider[]
}
