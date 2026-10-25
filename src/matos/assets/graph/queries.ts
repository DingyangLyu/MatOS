import {
  rankMatOSAssets,
  resolveMatOSAssetGraphNodeId,
  type MatOSAssetRankedHit,
} from './relevance.js'
import type { MatOSAssetGraphEdge, MatOSAssetGraphIndex } from './types.js'

export type MatOSAssetRelatedQuery = {
  assetRef: string
  query?: string
  types?: string[]
  limit?: number
}

export type MatOSAssetRelatedResult = {
  root: string
  hits: MatOSAssetRankedHit[]
}

export type MatOSAssetImpactResult = {
  root: string
  affectedAssetKeys: string[]
  edges: MatOSAssetGraphEdge[]
}

export type MatOSAssetNeighborhoodQuery = {
  assetRef: string
  direction?: 'dependencies' | 'reverse' | 'all'
  depth?: number
}

export type MatOSAssetNeighborhoodResult = {
  root: string
  nodes: string[]
  edges: MatOSAssetGraphEdge[]
  depth: number
  direction: 'dependencies' | 'reverse' | 'all'
}

export type MatOSAssetEvolutionEvent = {
  nodeId: string
  kind: string
  label: string
  createdAt?: string
  metadata?: Record<string, unknown>
}

export type MatOSAssetEvolutionTree = {
  assetKey: string
  current?: unknown
  events: MatOSAssetEvolutionEvent[]
  edges: MatOSAssetGraphEdge[]
  stableRelease?: string
  rollbackTargets: Array<{
    snapshotId: string
    commit?: string
    createdAt?: string
    validationOk?: boolean
  }>
  truncated?: boolean
  totalEventCount?: number
  totalEdgeCount?: number
}

const DEPENDENCY_EDGE_KINDS = new Set<string>([
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

function requireNodeId(index: MatOSAssetGraphIndex, assetRef: string): string {
  const nodeId = resolveMatOSAssetGraphNodeId(index, assetRef)
  if (!nodeId) {
    throw new Error(`MatOS asset graph node not found: ${assetRef}`)
  }
  return nodeId
}

function outgoingEdges(index: MatOSAssetGraphIndex, nodeId: string): MatOSAssetGraphEdge[] {
  return index.edges.filter(
    edge => edge.from === nodeId && DEPENDENCY_EDGE_KINDS.has(edge.kind),
  )
}

function incomingEdges(index: MatOSAssetGraphIndex, nodeId: string): MatOSAssetGraphEdge[] {
  return (index.reverseEdges[nodeId] ?? []).filter(edge =>
    DEPENDENCY_EDGE_KINDS.has(edge.kind),
  )
}

function allOutgoingEdges(
  index: MatOSAssetGraphIndex,
  nodeId: string,
): MatOSAssetGraphEdge[] {
  return index.edges.filter(edge => edge.from === nodeId)
}

function allIncomingEdges(
  index: MatOSAssetGraphIndex,
  nodeId: string,
): MatOSAssetGraphEdge[] {
  return index.reverseEdges[nodeId] ?? []
}

function nextEdges(
  index: MatOSAssetGraphIndex,
  nodeId: string,
  direction: 'dependencies' | 'reverse' | 'all',
): MatOSAssetGraphEdge[] {
  if (direction === 'dependencies') {
    return outgoingEdges(index, nodeId)
  }
  if (direction === 'reverse') {
    return incomingEdges(index, nodeId)
  }
  return [...allOutgoingEdges(index, nodeId), ...allIncomingEdges(index, nodeId)]
}

function edgeOtherNode(edge: MatOSAssetGraphEdge, current: string): string {
  return edge.from === current ? edge.to : edge.from
}

export function getMatOSAssetRelated(
  index: MatOSAssetGraphIndex,
  query: MatOSAssetRelatedQuery,
): MatOSAssetRelatedResult {
  const root = requireNodeId(index, query.assetRef)
  return {
    root,
    hits: rankMatOSAssets({
      index,
      query: query.query,
      seedRefs: [root],
      assetTypes: query.types,
      limit: query.limit,
    }),
  }
}

export function getMatOSAssetImpact(
  index: MatOSAssetGraphIndex,
  assetRef: string,
): MatOSAssetImpactResult {
  const root = requireNodeId(index, assetRef)
  const visited = new Set([root])
  const affected = new Set<string>()
  const edges: MatOSAssetGraphEdge[] = []
  const queue = [root]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }
    for (const edge of incomingEdges(index, current)) {
      edges.push(edge)
      if (!visited.has(edge.from)) {
        visited.add(edge.from)
        affected.add(edge.from)
        queue.push(edge.from)
      }
    }
  }

  return {
    root,
    affectedAssetKeys: [...affected].sort(),
    edges: edges.sort((a, b) =>
      [a.from, a.to, a.kind].join('\u0000').localeCompare(
        [b.from, b.to, b.kind].join('\u0000'),
      ),
    ),
  }
}

export function getMatOSAssetNeighborhood(
  index: MatOSAssetGraphIndex,
  query: MatOSAssetNeighborhoodQuery,
): MatOSAssetNeighborhoodResult {
  const root = requireNodeId(index, query.assetRef)
  const direction = query.direction ?? 'dependencies'
  const depth = Math.max(0, query.depth ?? 1)
  const visited = new Set([root])
  const edges: MatOSAssetGraphEdge[] = []
  let frontier = [root]

  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const nextFrontier: string[] = []
    for (const nodeId of frontier) {
      for (const edge of nextEdges(index, nodeId, direction)) {
        edges.push(edge)
        const nextNode = edgeOtherNode(edge, nodeId)
        if (!visited.has(nextNode)) {
          visited.add(nextNode)
          nextFrontier.push(nextNode)
        }
      }
    }
    frontier = nextFrontier
  }

  return {
    root,
    nodes: [...visited].sort(),
    edges: edges.sort((a, b) =>
      [a.from, a.to, a.kind].join('\u0000').localeCompare(
        [b.from, b.to, b.kind].join('\u0000'),
      ),
    ),
    depth,
    direction,
  }
}

export function getMatOSAssetLineageTree(
  index: MatOSAssetGraphIndex,
  assetRef: string,
): MatOSAssetEvolutionTree {
  const root = requireNodeId(index, assetRef)
  const lineageEdges: MatOSAssetGraphEdge[] = []
  const lineageEdgeKeys = new Set<string>()
  const visited = new Set([root])
  const queue = [root]

  function addEdge(edge: MatOSAssetGraphEdge): void {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.reference ?? ''}`
    if (lineageEdgeKeys.has(key)) {
      return
    }
    lineageEdgeKeys.add(key)
    lineageEdges.push(edge)
  }

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }
    const connected = [
      ...index.edges.filter(edge => edge.from === current),
      ...(index.reverseEdges[current] ?? []),
    ].filter(edge => edge.source === 'history' || edge.source === 'evolution')
    const currentNode = index.nodes[current]
    for (const edge of connected) {
      const allowedNextNodes = [edge.from, edge.to]
        .filter(next => next !== current)
        .filter(next => {
          if (next === root) {
            return true
          }
          const nextNode = index.nodes[next]
          if (currentNode?.kind !== 'asset' && nextNode?.kind === 'asset') {
            return (
              edge.kind === 'evidence_for' &&
              (currentNode?.kind === 'experience' || currentNode?.kind === 'event')
            )
          }
          return true
        })
      if (allowedNextNodes.length === 0) {
        continue
      }
      addEdge(edge)
      for (const next of allowedNextNodes) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
  }
  const eventNodeIds = new Set<string>()
  for (const edge of lineageEdges) {
    if (edge.from !== root) {
      eventNodeIds.add(edge.from)
    }
    if (edge.to !== root) {
      eventNodeIds.add(edge.to)
    }
  }
  const events: MatOSAssetEvolutionEvent[] = []
  for (const nodeId of eventNodeIds) {
    const node = index.nodes[nodeId]
    if (!node) {
      continue
    }
    events.push({
      nodeId,
      kind: node.kind,
      label: node.label,
      ...(node.createdAt ? { createdAt: node.createdAt } : {}),
      ...(node.metadata ? { metadata: node.metadata } : {}),
    })
  }
  events.sort(
    (a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
      a.nodeId.localeCompare(b.nodeId),
  )
  const stableRelease = lineageEdges
    .filter(edge => edge.kind === 'released_as' && edge.to.startsWith('release:'))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .at(0)?.to
  const rollbackTargets = lineageEdges
    .filter(edge => edge.kind === 'rolled_back_to' && edge.to.startsWith('snapshot:'))
    .map(edge => {
      const node = index.nodes[edge.to]
      return {
        snapshotId: edge.to.slice('snapshot:'.length),
        ...(typeof node?.metadata?.commit === 'string'
          ? { commit: node.metadata.commit }
          : {}),
        ...(node?.createdAt ? { createdAt: node.createdAt } : {}),
        ...(typeof node?.metadata?.validationOk === 'boolean'
          ? { validationOk: node.metadata.validationOk }
          : {}),
      }
    })

  return {
    assetKey: root,
    current: index.nodes[root],
    events,
    edges: lineageEdges,
    ...(stableRelease ? { stableRelease } : {}),
    rollbackTargets,
  }
}
