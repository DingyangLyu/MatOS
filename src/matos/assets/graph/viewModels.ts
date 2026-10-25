import {
  getMatOSAssetImpact,
  getMatOSAssetLineageTree,
  getMatOSAssetNeighborhood,
  getMatOSAssetRelated,
  type MatOSAssetEvolutionTree,
  type MatOSAssetImpactResult,
} from './queries.js'
import {
  rankMatOSAssets,
  resolveMatOSAssetGraphNodeId,
  type MatOSAssetRankedHit,
} from './relevance.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphIndex,
  MatOSAssetGraphNode,
} from './types.js'

export type MatOSAssetWorkbenchMode =
  | 'explore'
  | 'lineage'
  | 'impact'
  | 'validate'
  | 'raw'

export type MatOSAssetWorkbenchNode = {
  id: string
  label: string
  kind: string
  assetType?: string
  canonicalKey?: string
  status?: string
  tags?: string[]
  selected?: boolean
  emphasis: 'primary' | 'asset' | 'event' | 'usage'
  metadata?: Record<string, unknown>
}

export type MatOSAssetWorkbenchEdge = {
  id: string
  from: string
  to: string
  kind: string
  source: string
  label: string
  weight?: number
  confidence?: number
}

export type MatOSAssetWorkbenchInspector = {
  nodeId?: string
  title: string
  subtitle?: string
  sections: Array<{
    title: string
    rows: Array<{ label: string; value: unknown }>
  }>
}

export type MatOSAssetWorkbenchState = {
  mode: MatOSAssetWorkbenchMode
  query: string
  selectedAssetKey?: string
  graph: {
    nodes: MatOSAssetWorkbenchNode[]
    edges: MatOSAssetWorkbenchEdge[]
    summary: {
      nodeCount: number
      edgeCount: number
      issueCount: number
      truncated?: boolean
      totalNodeCount?: number
      totalEdgeCount?: number
    }
  }
  lineage?: MatOSAssetEvolutionTree
  impact?: MatOSAssetImpactResult
  validation?: {
    issues: MatOSAssetGraphIndex['issues']
    stats: MatOSAssetGraphIndex['stats']
  }
  raw?: {
    selectedNode?: MatOSAssetGraphNode
    stats: MatOSAssetGraphIndex['stats']
  }
  related: MatOSAssetRankedHit[]
  inspector?: MatOSAssetWorkbenchInspector
}

export type BuildMatOSAssetWorkbenchStateInput = {
  index: MatOSAssetGraphIndex
  mode?: MatOSAssetWorkbenchMode
  query?: string
  selectedAssetRef?: string
  depth?: number
  direction?: 'dependencies' | 'reverse' | 'all'
  types?: string[]
  limit?: number
}

function edgeId(edge: MatOSAssetGraphEdge): string {
  return [
    edge.from,
    edge.to,
    edge.kind,
    edge.source,
    edge.reference ?? '',
  ].join('|')
}

function workbenchNode(
  node: MatOSAssetGraphNode,
  selectedAssetKey: string | undefined,
): MatOSAssetWorkbenchNode {
  const emphasis =
    node.id === selectedAssetKey
      ? 'primary'
      : node.kind === 'asset'
        ? 'asset'
        : node.kind === 'trace' || node.kind === 'workflow-run'
          ? 'usage'
          : 'event'
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    ...(node.assetType ? { assetType: node.assetType } : {}),
    ...(node.canonicalKey ? { canonicalKey: node.canonicalKey } : {}),
    ...(node.lifecycleStatus ? { status: node.lifecycleStatus } : {}),
    ...(node.tags?.length ? { tags: node.tags } : {}),
    ...(node.id === selectedAssetKey ? { selected: true } : {}),
    emphasis,
    ...(node.metadata ? { metadata: node.metadata } : {}),
  }
}

function workbenchEdge(edge: MatOSAssetGraphEdge): MatOSAssetWorkbenchEdge {
  return {
    id: edgeId(edge),
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    source: edge.source,
    label: edge.kind.replaceAll('_', ' '),
    ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
    ...(edge.confidence !== undefined ? { confidence: edge.confidence } : {}),
  }
}

// Display graphs are bounded so a high-lineage asset (role:compute can reach
// ~580 nodes / ~17k evolution edges) cannot blow up the workbench detail/graph
// payload. The selected node and its direct neighbors are always kept first;
// the remainder is truncated with summary metadata so the UI can show a
// "showing N of M" hint and link to the full lineage/history surfaces.
const WORKBENCH_GRAPH_MAX_NODES = 120
const WORKBENCH_GRAPH_MAX_EDGES = 250
const WORKBENCH_LINEAGE_MAX_EVENTS = 80

// The full evolution lineage tree of a heavily evolved asset can carry hundreds
// of events and tens of thousands of edges. The workbench detail/graph payload
// only needs a bounded, most-recent slice for display; full history stays
// available through dedicated history/evolution surfaces. Returns the original
// object unchanged when it is already within bounds so small graphs/tests are
// unaffected.
function boundLineageForDisplay(
  lineage: MatOSAssetEvolutionTree,
): MatOSAssetEvolutionTree {
  const totalEventCount = lineage.events.length
  const totalEdgeCount = lineage.edges.length
  if (
    totalEventCount <= WORKBENCH_LINEAGE_MAX_EVENTS &&
    totalEdgeCount <= WORKBENCH_GRAPH_MAX_EDGES
  ) {
    return lineage
  }
  const events =
    totalEventCount > WORKBENCH_LINEAGE_MAX_EVENTS
      ? [...lineage.events]
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
          .slice(0, WORKBENCH_LINEAGE_MAX_EVENTS)
      : lineage.events
  const edges =
    totalEdgeCount > WORKBENCH_GRAPH_MAX_EDGES
      ? lineage.edges.slice(0, WORKBENCH_GRAPH_MAX_EDGES)
      : lineage.edges
  return {
    ...lineage,
    events,
    edges,
    truncated: true,
    totalEventCount,
    totalEdgeCount,
  }
}

function graphForIds(
  index: MatOSAssetGraphIndex,
  nodeIds: string[],
  edges: MatOSAssetGraphEdge[],
  selectedAssetKey: string | undefined,
  bounds?: { maxNodes?: number; maxEdges?: number },
): MatOSAssetWorkbenchState['graph'] {
  const maxNodes = Math.max(1, bounds?.maxNodes ?? WORKBENCH_GRAPH_MAX_NODES)
  const maxEdges = Math.max(1, bounds?.maxEdges ?? WORKBENCH_GRAPH_MAX_EDGES)
  const nodeSet = new Set(nodeIds)
  for (const edge of edges) {
    nodeSet.add(edge.from)
    nodeSet.add(edge.to)
  }
  const adjacentToSelected = new Set<string>()
  if (selectedAssetKey) {
    for (const edge of edges) {
      if (edge.from === selectedAssetKey) {
        adjacentToSelected.add(edge.to)
      } else if (edge.to === selectedAssetKey) {
        adjacentToSelected.add(edge.from)
      }
    }
  }
  const allNodes = [...nodeSet]
    .map(id => index.nodes[id])
    .filter((node): node is MatOSAssetGraphNode => Boolean(node))
    .map(node => workbenchNode(node, selectedAssetKey))
    .sort((a, b) => a.id.localeCompare(b.id))
  const totalNodeCount = allNodes.length
  const nodePriority = (node: MatOSAssetWorkbenchNode): number =>
    node.id === selectedAssetKey ? 0 : adjacentToSelected.has(node.id) ? 1 : 2
  const keptNodes =
    totalNodeCount > maxNodes
      ? [...allNodes]
          .sort(
            (a, b) => nodePriority(a) - nodePriority(b) || a.id.localeCompare(b.id),
          )
          .slice(0, maxNodes)
          .sort((a, b) => a.id.localeCompare(b.id))
      : allNodes
  const visibleIds = new Set(keptNodes.map(node => node.id))
  const visibleEdges = edges.filter(
    edge => visibleIds.has(edge.from) && visibleIds.has(edge.to),
  )
  const totalEdgeCount = visibleEdges.length
  const edgePriority = (edge: MatOSAssetGraphEdge): number =>
    selectedAssetKey && (edge.from === selectedAssetKey || edge.to === selectedAssetKey)
      ? 0
      : 1
  const keptEdges =
    totalEdgeCount > maxEdges
      ? [...visibleEdges]
          .sort(
            (a, b) => edgePriority(a) - edgePriority(b) || edgeId(a).localeCompare(edgeId(b)),
          )
          .slice(0, maxEdges)
      : visibleEdges
  const graphEdges = keptEdges
    .map(workbenchEdge)
    .sort((a, b) => a.id.localeCompare(b.id))
  const truncated =
    totalNodeCount > keptNodes.length || totalEdgeCount > graphEdges.length

  return {
    nodes: keptNodes,
    edges: graphEdges,
    summary: {
      nodeCount: keptNodes.length,
      edgeCount: graphEdges.length,
      issueCount: index.issues.length,
      ...(truncated
        ? { truncated: true, totalNodeCount, totalEdgeCount }
        : {}),
    },
  }
}

function inspectorForNode(
  node: MatOSAssetGraphNode | undefined,
): MatOSAssetWorkbenchInspector | undefined {
  if (!node) {
    return undefined
  }
  const identityRows = [
    { label: 'ID', value: node.id },
    ...(node.assetType ? [{ label: 'Type', value: node.assetType }] : []),
    ...(node.version ? [{ label: 'Version', value: node.version }] : []),
    ...(node.lifecycleStatus ? [{ label: 'Status', value: node.lifecycleStatus }] : []),
    ...(node.packId ? [{ label: 'Pack', value: node.packId }] : []),
  ]
  const metadataRows = Object.entries(node.metadata ?? {}).map(([label, value]) => ({
    label,
    value,
  }))

  return {
    nodeId: node.id,
    title: node.label,
    ...(node.description ? { subtitle: node.description } : {}),
    sections: [
      { title: 'Identity', rows: identityRows },
      ...(node.tags?.length ? [{ title: 'Tags', rows: [{ label: 'Tags', value: node.tags }] }] : []),
      ...(metadataRows.length ? [{ title: 'Metadata', rows: metadataRows }] : []),
    ],
  }
}

function defaultExploreNodeIds(
  index: MatOSAssetGraphIndex,
  query: string | undefined,
  types: string[] | undefined,
  limit: number,
): string[] {
  const ranked = rankMatOSAssets({
    index,
    query,
    assetTypes: types,
    limit,
  })
  if (ranked.length > 0) {
    return ranked.map(hit => hit.assetKey)
  }
  return Object.values(index.nodes)
    .filter(node => node.kind === 'asset')
    .filter(node => (types?.length ? node.assetType && types.includes(node.assetType) : true))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(node => node.id)
}

export function buildMatOSAssetWorkbenchState(
  input: BuildMatOSAssetWorkbenchStateInput,
): MatOSAssetWorkbenchState {
  const mode = input.mode ?? 'explore'
  const limit = input.limit ?? 30
  const selectedAssetKey = resolveMatOSAssetGraphNodeId(
    input.index,
    input.selectedAssetRef,
  )
  if (input.selectedAssetRef?.trim() && !selectedAssetKey) {
    throw new Error(`MatOS asset graph node not found: ${input.selectedAssetRef}`)
  }
  const query = input.query ?? ''
  const related = selectedAssetKey
    ? getMatOSAssetRelated(input.index, {
        assetRef: selectedAssetKey,
        query,
        types: input.types,
        limit: Math.min(limit, 20),
      }).hits
    : rankMatOSAssets({
        index: input.index,
        query,
        assetTypes: input.types,
        limit: Math.min(limit, 20),
      })

  let lineage: MatOSAssetEvolutionTree | undefined
  let impact: MatOSAssetImpactResult | undefined
  let validation: MatOSAssetWorkbenchState['validation']
  let raw: MatOSAssetWorkbenchState['raw']
  let graph: MatOSAssetWorkbenchState['graph']

  if (selectedAssetKey && mode === 'lineage') {
    const fullLineage = getMatOSAssetLineageTree(input.index, selectedAssetKey)
    graph = graphForIds(
      input.index,
      [selectedAssetKey, ...fullLineage.events.map(event => event.nodeId)],
      fullLineage.edges,
      selectedAssetKey,
    )
    lineage = boundLineageForDisplay(fullLineage)
  } else if (selectedAssetKey && mode === 'impact') {
    impact = getMatOSAssetImpact(input.index, selectedAssetKey)
    graph = graphForIds(
      input.index,
      [selectedAssetKey, ...impact.affectedAssetKeys],
      impact.edges,
      selectedAssetKey,
    )
  } else if (selectedAssetKey) {
    const neighborhood = getMatOSAssetNeighborhood(input.index, {
      assetRef: selectedAssetKey,
      direction: input.direction ?? 'all',
      depth: input.depth ?? 1,
    })
    graph = graphForIds(
      input.index,
      neighborhood.nodes,
      neighborhood.edges,
      selectedAssetKey,
    )
  } else {
    const nodeIds = defaultExploreNodeIds(input.index, query, input.types, limit)
    graph = graphForIds(input.index, nodeIds, [], undefined)
  }
  if (mode === 'validate') {
    validation = { issues: input.index.issues, stats: input.index.stats }
  }
  if (mode === 'raw') {
    raw = {
      ...(selectedAssetKey ? { selectedNode: input.index.nodes[selectedAssetKey] } : {}),
      stats: input.index.stats,
    }
  }

  return {
    mode,
    query,
    ...(selectedAssetKey ? { selectedAssetKey } : {}),
    graph,
    ...(lineage ? { lineage } : {}),
    ...(impact ? { impact } : {}),
    ...(validation ? { validation } : {}),
    ...(raw ? { raw } : {}),
    related,
    inspector: inspectorForNode(
      selectedAssetKey ? input.index.nodes[selectedAssetKey] : undefined,
    ),
  }
}
