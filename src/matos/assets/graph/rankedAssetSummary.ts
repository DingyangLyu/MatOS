import { parseMatOSAssetReference } from '../refs.js'
import type { MatOSAssetRankedHit } from './relevance.js'

export function serializeMatOSGraphRankedAsset(
  hit: MatOSAssetRankedHit,
): Record<string, unknown> {
  const canonicalKey = hit.node.canonicalKey ?? hit.assetKey
  const parsed = parseMatOSAssetReference(canonicalKey)
  const lifecycleStatus = hit.node.lifecycleStatus
  return {
    canonicalKey,
    assetKey: hit.assetKey,
    type: parsed.type ?? hit.node.assetType,
    id: parsed.id,
    name: hit.node.name ?? hit.node.label,
    version: parsed.version ?? hit.node.version,
    description: hit.node.description,
    source: hit.node.source,
    packId: hit.node.packId,
    tags: hit.node.tags ?? [],
    ...(lifecycleStatus ? { lifecycle: { status: lifecycleStatus } } : {}),
    score: hit.score,
    explanations: hit.explanations,
  }
}
