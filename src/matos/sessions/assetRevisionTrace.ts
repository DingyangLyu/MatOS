import type { MatOSAsset } from '../assets/types.js'

export type MatOSProjectedAssetTrace = {
  assetRef: string
  reason?: string
  sourceId?: string
  sourceCommit?: string
}

export function matOSAssetRevisionTrace(
  asset: MatOSAsset | undefined,
): Pick<MatOSProjectedAssetTrace, 'sourceId' | 'sourceCommit'> {
  const provenance = asset?.metadata.sourceProvenance as
    | Record<string, unknown>
    | undefined
  const runtimeRef = provenance?.runtimeRef as
    | Record<string, unknown>
    | undefined
  const commit = runtimeRef?.commit ?? provenance?.currentCommit
  if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(commit))
    return {}
  return {
    sourceCommit: commit,
    ...(typeof provenance?.sourceId === 'string'
      ? { sourceId: provenance.sourceId }
      : {}),
  }
}
