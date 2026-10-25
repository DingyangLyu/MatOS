import {
  compareMatOSAssetVersions,
  parseMatOSAssetReference,
} from '../refs.js'
import { tokenizeAssetGraphText } from './searchIndex.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphIndex,
  MatOSAssetGraphNode,
} from './types.js'

export type MatOSAssetRankExplanation = {
  kind:
    | 'exact'
    | 'lexical'
    | 'graph_distance'
    | 'edge_kind'
    | 'status'
    | 'usage'
    | 'lineage'
    | 'evidence'
    | 'penalty'
  score: number
  detail: string
}

export type MatOSAssetRankedHit = {
  assetKey: string
  score: number
  node: MatOSAssetGraphNode
  explanations: MatOSAssetRankExplanation[]
}

export type RankMatOSAssetsInput = {
  index: MatOSAssetGraphIndex
  query?: string
  seedRefs?: string[]
  roleRef?: string
  workflowRef?: string
  assetTypes?: string[]
  evidenceRefs?: string[]
  includeLineage?: boolean
  includeUsage?: boolean
  limit?: number
}

const EDGE_KIND_WEIGHTS: Record<string, number> = {
  depends_on: 1.2,
  mounts_knowledge: 1.1,
  mounts_data: 0.9,
  mounts_skill: 1.4,
  mounts_tool: 1.1,
  uses_tool: 1.0,
  uses_runtime: 0.4,
  uses_plugin: 0.6,
  uses_mcp: 0.6,
  subworkflow: 1.1,
  validates: 0.8,
  benchmarks: 0.8,
  derived_from: 0.7,
  evidence_for: 0.7,
  similar_to: 0.5,
  same_group: 0.3,
  same_tag: 0.2,
}

export function resolveMatOSAssetGraphNodeId(
  index: MatOSAssetGraphIndex,
  reference: string | undefined,
): string | undefined {
  const trimmed = reference?.trim()
  if (!trimmed) {
    return undefined
  }
  if (index.nodes[trimmed]) {
    return trimmed
  }

  const parsed = parseMatOSAssetReference(trimmed)
  const candidates = Object.entries(index.nodes)
    .filter(([, node]) => node.kind === 'asset')
    .filter(([nodeId, node]) => {
      if (parsed.type) {
        return parsed.version
          ? nodeId === `${parsed.type}:${parsed.id}@${parsed.version}`
          : nodeId.startsWith(`${parsed.type}:${parsed.id}@`)
      }
      return node.canonicalKey
        ? parseMatOSAssetReference(node.canonicalKey).id === parsed.id
        : nodeId.includes(`:${parsed.id}@`)
    })
    .sort(([, left], [, right]) => {
      const versionCompare = compareMatOSAssetVersions(
        left.version ?? '0.0.0',
        right.version ?? '0.0.0',
      )
      return versionCompare || left.id.localeCompare(right.id)
    })

  return candidates.at(-1)?.[0]
}

function graphAdjacency(
  index: MatOSAssetGraphIndex,
): Map<string, Array<{ nodeId: string; edge: MatOSAssetGraphEdge }>> {
  const adjacency = new Map<string, Array<{ nodeId: string; edge: MatOSAssetGraphEdge }>>()
  for (const edge of index.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), {
      nodeId: edge.to,
      edge,
    }])
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), {
      nodeId: edge.from,
      edge,
    }])
  }
  return adjacency
}

function graphDistances(
  index: MatOSAssetGraphIndex,
  seedIds: string[],
): Map<string, { distance: number; via?: MatOSAssetGraphEdge }> {
  const adjacency = graphAdjacency(index)
  const distances = new Map<string, { distance: number; via?: MatOSAssetGraphEdge }>()
  const queue: string[] = []

  for (const seedId of seedIds) {
    distances.set(seedId, { distance: 0 })
    queue.push(seedId)
  }

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }
    const currentDistance = distances.get(current)?.distance ?? 0
    for (const next of adjacency.get(current) ?? []) {
      if (distances.has(next.nodeId)) {
        continue
      }
      distances.set(next.nodeId, {
        distance: currentDistance + 1,
        via: next.edge,
      })
      queue.push(next.nodeId)
    }
  }

  return distances
}

function lexicalScore(
  index: MatOSAssetGraphIndex,
  assetKey: string,
  terms: string[],
): MatOSAssetRankExplanation | undefined {
  if (terms.length === 0) {
    return undefined
  }
  const document = index.search.documents[assetKey]
  if (!document) {
    return undefined
  }
  let score = 0
  const matched: string[] = []
  for (const term of terms) {
    const count = document.terms[term] ?? 0
    if (count <= 0) {
      continue
    }
    const df = index.search.vocabulary[term] ?? 1
    const idf = Math.log((index.search.documentCount + 1) / (df + 1)) + 1
    score += count * idf
    matched.push(term)
  }
  if (score <= 0) {
    return undefined
  }
  return {
    kind: 'lexical',
    score,
    detail: `matched terms: ${matched.join(', ')}`,
  }
}

function exactScore(
  node: MatOSAssetGraphNode,
  query: string | undefined,
): MatOSAssetRankExplanation | undefined {
  const normalizedQuery = query?.trim().toLowerCase()
  if (!normalizedQuery) {
    return undefined
  }
  const values = [
    node.id,
    node.canonicalKey,
    node.name,
    node.label,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase())
  if (!values.includes(normalizedQuery)) {
    return undefined
  }
  return {
    kind: 'exact',
    score: 20,
    detail: `exact asset/name match: ${query}`,
  }
}

function graphScore(
  assetKey: string,
  distances: Map<string, { distance: number; via?: MatOSAssetGraphEdge }>,
): MatOSAssetRankExplanation | undefined {
  const distance = distances.get(assetKey)
  if (!distance || distance.distance <= 0) {
    return undefined
  }
  const score = 6 / (distance.distance + 1)
  return {
    kind: 'graph_distance',
    score,
    detail: `distance ${distance.distance}${distance.via ? ` via ${distance.via.kind}` : ''}`,
  }
}

function edgeKindScore(
  assetKey: string,
  distances: Map<string, { distance: number; via?: MatOSAssetGraphEdge }>,
): MatOSAssetRankExplanation | undefined {
  const edge = distances.get(assetKey)?.via
  if (!edge) {
    return undefined
  }
  const score = EDGE_KIND_WEIGHTS[edge.kind] ?? 0.2
  return {
    kind: 'edge_kind',
    score,
    detail: `edge kind ${edge.kind}`,
  }
}

function statusScore(node: MatOSAssetGraphNode): MatOSAssetRankExplanation {
  if (node.lifecycleStatus === 'enabled') {
    return {
      kind: 'status',
      score: 0.2,
      detail: 'enabled asset',
    }
  }
  if (node.lifecycleStatus === 'draft') {
    return {
      kind: 'penalty',
      score: -1,
      detail: 'draft asset',
    }
  }
  if (node.lifecycleStatus === 'disabled') {
    return {
      kind: 'penalty',
      score: -5,
      detail: 'disabled asset',
    }
  }
  if (node.lifecycleStatus === 'deprecated') {
    return {
      kind: 'penalty',
      score: -3,
      detail: 'deprecated asset',
    }
  }
  return {
    kind: 'status',
    score: 0,
    detail: `status ${node.lifecycleStatus ?? 'unknown'}`,
  }
}

function usageScore(node: MatOSAssetGraphNode): MatOSAssetRankExplanation | undefined {
  const usage = node.metadata?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined
  }
  const count = (usage as Record<string, unknown>).count
  if (typeof count !== 'number' || count <= 0) {
    return undefined
  }
  return {
    kind: 'usage',
    score: Math.min(3, Math.log(count + 1)),
    detail: `observed usage count: ${count}`,
  }
}

function lineageScore(
  index: MatOSAssetGraphIndex,
  assetKey: string,
): MatOSAssetRankExplanation | undefined {
  const summary = index.lineage[assetKey]
  if (!summary || summary.eventCount <= 0) {
    return undefined
  }
  return {
    kind: 'lineage',
    score: Math.min(2.5, Math.log(summary.eventCount + 1)),
    detail: `lineage event count: ${summary.eventCount}`,
  }
}

function evidenceScore(
  index: MatOSAssetGraphIndex,
  assetKey: string,
  evidenceRefs: string[] | undefined,
): MatOSAssetRankExplanation | undefined {
  const refs = new Set(
    (evidenceRefs ?? []).map(ref => ref.trim()).filter(Boolean),
  )
  if (refs.size === 0) {
    return undefined
  }
  const connectedEdges = [
    ...index.edges.filter(edge => edge.from === assetKey),
    ...(index.reverseEdges[assetKey] ?? []),
  ]
  for (const edge of connectedEdges) {
    const edgeRefs = [edge.reference, ...(edge.evidenceRefs ?? [])]
      .filter((ref): ref is string => typeof ref === 'string')
    if (edgeRefs.some(ref => refs.has(ref))) {
      return {
        kind: 'evidence',
        score: 4,
        detail: `matched evidence reference via ${edge.kind}`,
      }
    }
  }
  return undefined
}

function hasPositiveRankingSignal(
  explanations: MatOSAssetRankExplanation[],
): boolean {
  return explanations.some(
    item =>
      item.score > 0 &&
      item.kind !== 'status' &&
      item.kind !== 'penalty',
  )
}

export function rankMatOSAssets(input: RankMatOSAssetsInput): MatOSAssetRankedHit[] {
  const seedIds = [
    ...(input.seedRefs ?? []),
    input.roleRef,
    input.workflowRef,
  ]
    .map(ref => resolveMatOSAssetGraphNodeId(input.index, ref))
    .filter((id): id is string => Boolean(id))
  const seedSet = new Set(seedIds)
  const distances = graphDistances(input.index, seedIds)
  const typeFilter = input.assetTypes?.length
    ? new Set(input.assetTypes)
    : undefined
  // Tokenize the query once; per-asset re-tokenization dominated ranking cost
  // for long role/tool queries over large indexes.
  const queryTerms = tokenizeAssetGraphText(input.query ?? '')
  const hits: MatOSAssetRankedHit[] = []

  for (const [assetKey, node] of Object.entries(input.index.nodes)) {
    if (node.kind !== 'asset') {
      continue
    }
    if (seedSet.has(assetKey)) {
      continue
    }
    if (typeFilter && (!node.assetType || !typeFilter.has(node.assetType))) {
      continue
    }

    const explanations = [
      exactScore(node, input.query),
      lexicalScore(input.index, assetKey, queryTerms),
      graphScore(assetKey, distances),
      edgeKindScore(assetKey, distances),
      statusScore(node),
      input.includeUsage === false ? undefined : usageScore(node),
      input.includeLineage ? lineageScore(input.index, assetKey) : undefined,
      evidenceScore(input.index, assetKey, input.evidenceRefs),
    ].filter((item): item is MatOSAssetRankExplanation => Boolean(item))
    const score = explanations.reduce((sum, item) => sum + item.score, 0)

    if (score <= 0 || !hasPositiveRankingSignal(explanations)) {
      continue
    }
    hits.push({
      assetKey,
      score: Number(score.toFixed(6)),
      node,
      explanations,
    })
  }

  return hits
    .sort((a, b) => b.score - a.score || a.assetKey.localeCompare(b.assetKey))
    .slice(0, input.limit ?? hits.length)
}
