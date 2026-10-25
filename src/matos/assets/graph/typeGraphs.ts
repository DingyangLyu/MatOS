import type { MatOSAsset } from '../types.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphProvider,
  MatOSAssetTypeGraph,
} from './types.js'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function metadataStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  return [
    ...new Set(
      values
        .map(item =>
          typeof item === 'string' && item.trim().length > 0
            ? item.trim().toLowerCase()
            : undefined,
        )
        .filter((item): item is string => Boolean(item)),
    ),
  ].sort()
}

type MetadataSimilarityField =
  | string
  | {
      reference: string
      fields: string[]
    }

function metadataValuesForField(
  asset: MatOSAsset,
  field: MetadataSimilarityField,
): string[] {
  if (typeof field === 'string') {
    return metadataStrings(asset.metadata[field])
  }
  return [
    ...new Set(field.fields.flatMap(item => metadataStrings(asset.metadata[item]))),
  ].sort()
}

function metadataFieldReference(field: MetadataSimilarityField): string {
  return typeof field === 'string' ? field : field.reference
}

function assetGroup(asset: MatOSAsset): string {
  const explicit = optionalString(asset.metadata.group)
  if (explicit) {
    return explicit
  }
  const [prefix] = asset.id.split('/')
  return prefix || asset.id
}

function edgeKey(edge: MatOSAssetGraphEdge): string {
  return [
    edge.from,
    edge.to,
    edge.kind,
    edge.source,
    edge.reference ?? '',
  ].join('\u0000')
}

function addUndirectedPair(
  edges: MatOSAssetGraphEdge[],
  seen: Set<string>,
  from: string,
  to: string,
  edge: Omit<MatOSAssetGraphEdge, 'from' | 'to'>,
): void {
  if (from === to) {
    return
  }
  const ordered = [from, to].sort()
  const next: MatOSAssetGraphEdge = {
    from: ordered[0] ?? from,
    to: ordered[1] ?? to,
    ...edge,
  }
  const key = edgeKey(next)
  if (seen.has(key)) {
    return
  }
  seen.add(key)
  edges.push(next)
}

// Pairwise same-value similarity edges are quadratic in the number of assets
// that share a value. A value shared by a large slice of one type (for
// example the material-bench-data pack, where 650+ bundled data assets share
// the same domain tags) carries almost no similarity signal but used to
// explode the graph to over a million edges, stalling every graph consumer
// including the hidden direct-editor prompt builder and workbench role/member
// surfaces. Buckets above this fanout are skipped entirely.
const SAME_VALUE_FANOUT_LIMIT = 32

// Tags get a much tighter fanout than the structured similarity fields:
// same_tag is the weakest signal in the graph (self-declared weight 0.2),
// yet at limit 32 a popular tag mints C(32,2)=496 edges — tag co-occurrence
// made up half of all graph edges (6.2k of 12.4k measured) and, because
// ranking's seed expansion is an unweighted BFS, every asset sharing one hot
// tag sat at distance 1 from the seeds, drowning the meaningful relations.
// A tag shared by more than a dozen assets is a category, not a similarity.
const SAME_TAG_FANOUT_LIMIT = 12

function bucketFanoutLimit(kind: MatOSAssetGraphEdge['kind']): number {
  return kind === 'same_tag' ? SAME_TAG_FANOUT_LIMIT : SAME_VALUE_FANOUT_LIMIT
}

type SimilarityBucket = {
  assets: MatOSAsset[]
  memberKeys: Set<string>
  edge: Omit<MatOSAssetGraphEdge, 'from' | 'to'>
}

function addBucketMember(
  buckets: Map<string, SimilarityBucket>,
  bucketKey: string,
  asset: MatOSAsset,
  edge: Omit<MatOSAssetGraphEdge, 'from' | 'to'>,
): void {
  const bucket = buckets.get(bucketKey) ?? {
    assets: [],
    memberKeys: new Set<string>(),
    edge,
  }
  if (!bucket.memberKeys.has(asset.canonicalKey)) {
    bucket.memberKeys.add(asset.canonicalKey)
    bucket.assets.push(asset)
  }
  buckets.set(bucketKey, bucket)
}

const TOOL_SIMILARITY_FIELDS: MetadataSimilarityField[] = [
  'binding',
  'backend',
  'mcpServer',
  { reference: 'failureClass', fields: ['failureClass', 'failureClasses'] },
  { reference: 'failureMode', fields: ['failureMode', 'failureModes'] },
]

const KNOWLEDGE_SIMILARITY_FIELDS: MetadataSimilarityField[] = [
  { reference: 'topic', fields: ['topic', 'topics'] },
  { reference: 'family', fields: ['family', 'families'] },
  { reference: 'failureClass', fields: ['failureClass', 'failureClasses'] },
  { reference: 'searchTerm', fields: ['searchTerm', 'searchTerms'] },
]

function collectTypeSimilarityBuckets(
  sorted: MatOSAsset[],
): Map<string, SimilarityBucket> {
  const buckets = new Map<string, SimilarityBucket>()
  for (const asset of sorted) {
    const group = assetGroup(asset)
    addBucketMember(buckets, `same_group\u0000group:${group}`, asset, {
      kind: 'same_group',
      source: 'metadata',
      reference: `group:${group}`,
      weight: 0.35,
      confidence: 0.8,
    })
    for (const tag of [...new Set(asset.tags)].sort()) {
      addBucketMember(buckets, `same_tag\u0000tag:${tag}`, asset, {
        kind: 'same_tag',
        source: 'metadata',
        reference: `tag:${tag}`,
        weight: 0.2,
        confidence: 0.7,
      })
    }
    const metadataFields =
      asset.type === 'tool'
        ? TOOL_SIMILARITY_FIELDS
        : asset.type === 'knowledge'
          ? KNOWLEDGE_SIMILARITY_FIELDS
          : []
    const metadataWeight = asset.type === 'tool' ? 0.45 : 0.4
    const metadataConfidence = asset.type === 'tool' ? 0.75 : 0.72
    for (const field of metadataFields) {
      const fieldReference = metadataFieldReference(field)
      for (const value of metadataValuesForField(asset, field)) {
        addBucketMember(
          buckets,
          `similar_to\u0000${fieldReference}:${value}`,
          asset,
          {
            kind: 'similar_to',
            source: 'metadata',
            reference: `${fieldReference}:${value}`,
            weight: metadataWeight,
            confidence: metadataConfidence,
          },
        )
      }
    }
  }
  return buckets
}

export function buildTypeLocalEdges(assets: MatOSAsset[]): MatOSAssetGraphEdge[] {
  const edges: MatOSAssetGraphEdge[] = []
  const seen = new Set<string>()
  const byType = new Map<string, MatOSAsset[]>()

  for (const asset of assets) {
    byType.set(asset.type, [...(byType.get(asset.type) ?? []), asset])
  }

  for (const typeAssets of [...byType.values()]) {
    const sorted = [...typeAssets].sort((a, b) =>
      a.canonicalKey.localeCompare(b.canonicalKey),
    )
    for (const bucket of collectTypeSimilarityBuckets(sorted).values()) {
      if (
        bucket.assets.length < 2 ||
        bucket.assets.length > bucketFanoutLimit(bucket.edge.kind)
      ) {
        continue
      }
      for (let leftIndex = 0; leftIndex < bucket.assets.length; leftIndex += 1) {
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < bucket.assets.length;
          rightIndex += 1
        ) {
          const left = bucket.assets[leftIndex]
          const right = bucket.assets[rightIndex]
          if (!left || !right) {
            continue
          }
          addUndirectedPair(
            edges,
            seen,
            left.canonicalKey,
            right.canonicalKey,
            bucket.edge,
          )
        }
      }
    }
  }

  return edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))
}

export function buildTypeGraphs(
  nodesById: Record<string, { assetType?: string; kind?: string }>,
  edges: MatOSAssetGraphEdge[],
): Record<string, MatOSAssetTypeGraph> {
  const nodeEntries = Object.entries(nodesById)
    .filter((entry): entry is [string, { assetType: string }] =>
      typeof entry[1].assetType === 'string' && (!entry[1].kind || entry[1].kind === 'asset'),
    )
    .sort(([a], [b]) => a.localeCompare(b))
  const byType = new Map<string, string[]>()

  for (const [nodeId, node] of nodeEntries) {
    byType.set(node.assetType, [...(byType.get(node.assetType) ?? []), nodeId])
  }

  const graphs: Record<string, MatOSAssetTypeGraph> = {}
  for (const [assetType, nodeIds] of [...byType.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const nodeSet = new Set(nodeIds)
    const localEdges = edges.filter(edge => nodeSet.has(edge.from) && nodeSet.has(edge.to))
    graphs[assetType] = {
      assetType,
      nodes: nodeIds,
      edges: localEdges,
      stats: {
        nodeCount: nodeIds.length,
        edgeCount: localEdges.length,
      },
    }
  }

  return graphs
}

export const typeLocalProvider: MatOSAssetGraphProvider = {
  id: 'type-local',
  stage: 'type-local',
  build(context) {
    return { edges: buildTypeLocalEdges(context.assets) }
  },
}
