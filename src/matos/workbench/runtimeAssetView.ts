import { resolve } from 'node:path'
import { loadMatOSRuntimeAssets } from '../assets/loadAssets.js'
import type { MatOSAsset } from '../assets/types.js'
import { readMatOSProjectMetadata } from '../projectMetadata.js'

type MatOSWorkbenchAssetContext = {
  cwd: string
  env?: Record<string, string | undefined>
}

/**
 * Load the asset view used by project-scoped workbench and runtime commands.
 *
 * The command cwd remains the project directory for file isolation, while
 * user/team accepted Git sources live on the scope workspace selected by
 * MATOS_ASSETS_CWD. Merging both views keeps resource inspection, project
 * authority checks, and actual role execution consistent.
 */
export async function loadMatOSWorkbenchRuntimeAssets(
  input: MatOSWorkbenchAssetContext,
): Promise<MatOSAsset[]> {
  const metadata = await readMatOSProjectMetadata(input.cwd, { allowMissing: true })
  const options = { followAcceptedUpdates: metadata.assetVersionPolicy !== 'pinned' }
  const projectAssets = await loadMatOSRuntimeAssets(input.cwd, options)
  const scopeAssetsCwd = input.env?.MATOS_ASSETS_CWD?.trim() ??
    process.env.MATOS_ASSETS_CWD?.trim()
  if (!scopeAssetsCwd || resolve(scopeAssetsCwd) === resolve(input.cwd)) {
    return projectAssets
  }

  const scopeAssets = await loadMatOSRuntimeAssets(scopeAssetsCwd, options)
  const knownAssetIdentities = new Set(
    projectAssets.map(asset => asset.canonicalKey || resolve(asset.manifestPath)),
  )
  const mergedAssets = [...projectAssets]
  for (const asset of scopeAssets) {
    const identity = asset.canonicalKey || resolve(asset.manifestPath)
    if (knownAssetIdentities.has(identity)) continue
    knownAssetIdentities.add(identity)
    mergedAssets.push(asset)
  }
  return mergedAssets
}
