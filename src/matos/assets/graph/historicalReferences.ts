import { createHash } from 'node:crypto'
import { parseMatOSAssetReference } from '../refs.js'
import type { MatOSAssetGraphNode, MatOSAssetGraphProviderContext } from './types.js'

export function observedAssetKey(context: MatOSAssetGraphProviderContext, reference: string, nodes: Map<string, MatOSAssetGraphNode>, provenance: { sourceId?: unknown; sourceCommit?: unknown } = {}, archived = false): string | undefined {
  const parsed = parseMatOSAssetReference(reference)
  if (!parsed.type || !parsed.id) return undefined
  const current = context.assets.find(asset => asset.type === parsed.type && asset.id === parsed.id)
  // A stale reference must not resurrect an asset hidden in the current scope.
  if (!current && !archived) return undefined
  const currentProvenance = current?.metadata.sourceProvenance as Record<string, unknown> | undefined
  if (current && provenance.sourceId && provenance.sourceId !== currentProvenance?.sourceId) return undefined
  const resolved = context.registry.resolve(reference)
  if (parsed.version && resolved && context.assets.includes(resolved) && !provenance.sourceCommit) return resolved.canonicalKey
  const identity = JSON.stringify([reference, provenance.sourceId ?? null, provenance.sourceCommit ?? null])
  const id = `asset-revision:${createHash('sha256').update(identity).digest('hex')}`
  nodes.set(id, {
    id, kind: 'asset-revision', label: reference, reference, canonicalKey: reference,
    version: parsed.version, assetType: parsed.type,
    metadata: { historical: true, executable: false, currentAssetKey: current?.canonicalKey,
      sourceId: provenance.sourceId, sourceCommit: provenance.sourceCommit, contentAvailable: false,
      versionKnown: Boolean(parsed.version) },
  })
  return id
}
