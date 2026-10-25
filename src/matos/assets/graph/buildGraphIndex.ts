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

import { loadMatOSRuntimeAssets } from '../loadAssets.js'
import { redactMatOSAssetOutput } from '../outputRedaction.js'
import { buildMatOSAssetRegistry, getMatOSEffectiveAssets } from '../registry.js'
import {
  isUserVisibleMatOSAsset,
  shouldHideInternalAssetSource,
  shouldHideAssetFromUserSurface,
} from '../sourceVisibility.js'
import { mergeMatOSAssetGraphProviders } from './edgeProviders.js'
import { buildSearchIndex } from './searchIndex.js'
import { buildTypeGraphs } from './typeGraphs.js'
import type {
  MatOSAssetGraphBuildInput,
  MatOSAssetGraphBuildOptions,
  MatOSAssetGraphEdge,
  MatOSAssetGraphEdgeKind,
  MatOSAssetGraphIndex,
  MatOSAssetGraphIssue,
  MatOSAssetLineageSummary,
  MatOSAssetGraphNode,
  MatOSAssetSearchDocument,
} from './types.js'

const CORE_ASSET_EDGE_KINDS = new Set<MatOSAssetGraphEdgeKind>([
  'depends_on',
  'mounts_knowledge',
  'mounts_data',
  'mounts_skill',
  'mounts_tool',
  'uses_tool',
  'uses_runtime',
  'uses_plugin',
  'uses_mcp',
  'subworkflow',
  'validates',
  'benchmarks',
])

const DISCOVERY_ASSET_EDGE_KINDS = new Set<MatOSAssetGraphEdgeKind>([
  ...CORE_ASSET_EDGE_KINDS,
  'similar_to',
  'same_group',
  'same_tag',
])

const DEFAULT_AGENT_ASSET_TYPE_EXCLUSIONS = new Set(['experience'])

function edgeSortKey(edge: MatOSAssetGraphEdge): string {
  return [
    edge.from,
    edge.to,
    edge.kind,
    edge.source,
    edge.reference ?? '',
  ].join('\u0000')
}

function edgeIdentity(edge: MatOSAssetGraphEdge): string {
  return edgeSortKey(edge)
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, T>
}

function mergeGraphNode(
  previous: MatOSAssetGraphNode | undefined,
  next: MatOSAssetGraphNode,
): MatOSAssetGraphNode {
  if (!previous) {
    return next
  }
  if (previous.kind !== 'asset' && next.kind === 'asset') {
    return {
      ...next,
      metadata: {
        ...(previous.metadata ?? {}),
        ...(next.metadata ?? {}),
      },
    }
  }
  return {
    ...previous,
    ...(previous.description === undefined && next.description !== undefined
      ? { description: next.description }
      : {}),
    ...(previous.createdAt === undefined && next.createdAt !== undefined
      ? { createdAt: next.createdAt }
      : {}),
    ...(previous.reference === undefined && next.reference !== undefined
      ? { reference: next.reference }
      : {}),
    ...(previous.tags === undefined && next.tags !== undefined
      ? { tags: next.tags }
      : {}),
    ...(previous.lifecycleStatus === undefined && next.lifecycleStatus !== undefined
      ? { lifecycleStatus: next.lifecycleStatus }
      : {}),
    metadata: {
      ...(previous.metadata ?? {}),
      ...(next.metadata ?? {}),
    },
  }
}

function redactGraphIssue(
  issue: MatOSAssetGraphIssue,
  cwd: string,
): MatOSAssetGraphIssue {
  return redactMatOSAssetOutput(issue, { cwd }) as MatOSAssetGraphIssue
}

function buildReverseEdges(
  edges: MatOSAssetGraphEdge[],
): Record<string, MatOSAssetGraphEdge[]> {
  const reverse: Record<string, MatOSAssetGraphEdge[]> = {}
  for (const edge of edges) {
    reverse[edge.to] = [...(reverse[edge.to] ?? []), edge]
  }
  for (const key of Object.keys(reverse)) {
    reverse[key] = [...(reverse[key] ?? [])].sort((a, b) =>
      edgeSortKey(a).localeCompare(edgeSortKey(b)),
    )
  }
  return sortRecord(reverse)
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<T, number>
}

function buildLineageSummaries(
  nodes: Record<string, MatOSAssetGraphNode>,
  edges: MatOSAssetGraphEdge[],
): Record<string, MatOSAssetLineageSummary> {
  const summaries = new Map<string, MatOSAssetLineageSummary>()
  const eventSources = new Set(['history', 'evolution'])

  function ensure(assetKey: string): MatOSAssetLineageSummary {
    const existing = summaries.get(assetKey)
    if (existing) {
      return existing
    }
    const next: MatOSAssetLineageSummary = {
      assetKey,
      eventCount: 0,
      rollbackTargetCount: 0,
    }
    summaries.set(assetKey, next)
    return next
  }

  for (const edge of edges) {
    if (!eventSources.has(edge.source)) {
      continue
    }
    const fromNode = nodes[edge.from]
    const toNode = nodes[edge.to]
    const assetKey =
      fromNode?.kind === 'asset'
        ? edge.from
        : toNode?.kind === 'asset'
          ? edge.to
          : undefined
    const eventNode =
      fromNode?.kind === 'asset'
        ? toNode
        : toNode?.kind === 'asset'
          ? fromNode
          : undefined
    if (!assetKey) {
      continue
    }
    const summary = ensure(assetKey)
    summary.eventCount += 1
    if (edge.kind === 'rolled_back_to') {
      summary.rollbackTargetCount += 1
    }
    const eventAt = edge.createdAt ?? eventNode?.createdAt
    if (eventAt && (!summary.latestEventAt || eventAt > summary.latestEventAt)) {
      summary.latestEventAt = eventAt
    }
  }

  return sortRecord(Object.fromEntries(summaries.entries()))
}

function effectiveGraphBuildOptions(
  options: MatOSAssetGraphBuildOptions,
): MatOSAssetGraphBuildOptions {
  if (options.profile === 'evidence' || options.profile === 'full') {
    return {
      ...options,
      includeLineage: true,
      includeUsage: true,
    }
  }
  if (options.profile === 'core' || options.profile === 'discovery') {
    return {
      ...options,
      includeLineage: false,
      includeUsage: false,
    }
  }
  return options
}

function filterNodesForProfile(
  nodes: Record<string, MatOSAssetGraphNode>,
  options: MatOSAssetGraphBuildOptions,
): Record<string, MatOSAssetGraphNode> {
  if (!options.profile || options.profile === 'full') {
    return nodes
  }
  if (options.profile === 'core' || options.profile === 'discovery') {
    return sortRecord(
      Object.fromEntries(
        Object.entries(nodes).filter(
          ([, node]) =>
            node.kind === 'asset' &&
            !DEFAULT_AGENT_ASSET_TYPE_EXCLUSIONS.has(node.assetType ?? ''),
        ),
      ),
    )
  }
  return nodes
}

function edgeAllowedForProfile(
  edge: MatOSAssetGraphEdge,
  nodes: Record<string, MatOSAssetGraphNode>,
  options: MatOSAssetGraphBuildOptions,
): boolean {
  if (!options.profile || options.profile === 'full') {
    return true
  }
  const from = nodes[edge.from]
  const to = nodes[edge.to]
  if (!from || !to) {
    return false
  }
  if (options.profile === 'core') {
    return from.kind === 'asset' && to.kind === 'asset' && CORE_ASSET_EDGE_KINDS.has(edge.kind)
  }
  if (options.profile === 'discovery') {
    return from.kind === 'asset' && to.kind === 'asset' && DISCOVERY_ASSET_EDGE_KINDS.has(edge.kind)
  }
  if (options.profile === 'evidence') {
    if (from.kind === 'asset' && to.kind === 'asset') {
      // Evolution-provenance edges (experience → target asset) are the whole
      // point of the evidence profile; keep them alongside the core wiring.
      return CORE_ASSET_EDGE_KINDS.has(edge.kind) || edge.kind === 'evidence_for'
    }
    return (
      edge.source === 'history' ||
      edge.source === 'evolution' ||
      edge.source === 'trace' ||
      edge.kind === 'used_in_workflow_run'
    )
  }
  return true
}

export async function buildMatOSAssetGraphIndex(
  input: MatOSAssetGraphBuildInput,
): Promise<MatOSAssetGraphIndex> {
  const options = effectiveGraphBuildOptions(input.options ?? {})
  const loadedAssets = input.assets ?? (input.registry?.assets ?? await loadMatOSRuntimeAssets(input.cwd))
  const registry =
    input.registry ??
    buildMatOSAssetRegistry(loadedAssets, {
      includeDisabled: options.includeDisabled,
    })
  const assets = getMatOSEffectiveAssets(registry).filter(asset => {
    if (options.includeHidden) {
      return true
    }
    return asset.type === 'experience'
      ? !shouldHideInternalAssetSource() || isUserVisibleMatOSAsset(asset)
      : !shouldHideAssetFromUserSurface(asset)
  })
  const providers = mergeMatOSAssetGraphProviders(input.providers)
  const context = {
    cwd: input.cwd,
    registry,
    assets,
    options,
  }
  const nodes = new Map<string, MatOSAssetGraphNode>()
  const edges = new Map<string, MatOSAssetGraphEdge>()
  const issues: MatOSAssetGraphIssue[] = []
  const searchDocuments = new Map<string, MatOSAssetSearchDocument>()

  for (const provider of providers) {
    const result = await provider.build(context)
    for (const node of result.nodes ?? []) {
      nodes.set(node.id, mergeGraphNode(nodes.get(node.id), node))
    }
    for (const edge of result.edges ?? []) {
      edges.set(edgeIdentity(edge), edge)
    }
    for (const issue of result.issues ?? []) {
      issues.push(
        redactGraphIssue(
          { ...issue, providerId: issue.providerId ?? provider.id },
          input.cwd,
        ),
      )
    }
    for (const document of result.searchDocuments ?? []) {
      searchDocuments.set(document.id, document)
    }
  }

  const nodesRecord = filterNodesForProfile(
    sortRecord(Object.fromEntries(nodes.entries())),
    options,
  )
  const sortedEdges = [...edges.values()]
    .filter(edge => Boolean(nodesRecord[edge.from]) && Boolean(nodesRecord[edge.to]))
    .filter(edge => edgeAllowedForProfile(edge, nodesRecord, options))
    .sort((a, b) => edgeSortKey(a).localeCompare(edgeSortKey(b)))
  const typeGraphs = buildTypeGraphs(nodesRecord, sortedEdges)
  const lineage = buildLineageSummaries(nodesRecord, sortedEdges)
  const search = buildSearchIndex([...searchDocuments.values()])
  const assetTypeValues = Object.values(nodesRecord)
    .filter(node => node.kind === 'asset')
    .map(node => node.assetType)
    .filter((type): type is string => typeof type === 'string')
  const graphAssetCount = options.profile ? assetTypeValues.length : assets.length
  const edgeKinds = sortedEdges.map(edge => edge.kind)

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    root: options.exposeRootPath ? input.cwd : '<workspace>',
    ...(options.scope ? { scope: options.scope } : {}),
    nodes: nodesRecord,
    edges: sortedEdges,
    reverseEdges: buildReverseEdges(sortedEdges),
    typeGraphs,
    lineage,
    search,
    stats: {
      assetCount: graphAssetCount,
      nodeCount: Object.keys(nodesRecord).length,
      edgeCount: sortedEdges.length,
      providerCount: providers.length,
      typeCounts: countBy(assetTypeValues),
      edgeKindCounts: countBy(edgeKinds),
      issueCount: issues.length,
    },
    issues: issues.sort((a, b) =>
      [
        a.severity ?? '',
        a.code,
        a.assetKey ?? '',
        a.message,
      ].join('\u0000').localeCompare([
        b.severity ?? '',
        b.code,
        b.assetKey ?? '',
        b.message,
      ].join('\u0000')),
    ),
  }
}
