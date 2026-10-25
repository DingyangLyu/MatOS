import { manifestRelationProvider } from './relationEdges.js'
import { lineageProvider } from './lineageGraph.js'
import { searchDocumentProvider } from './searchIndex.js'
import { typeLocalProvider } from './typeGraphs.js'
import { usageProvider } from './usageGraph.js'
import { workflowAssetReferenceProvider } from './workflowAssetReferences.js'
import type {
  MatOSAssetGraphProvider,
  MatOSAssetGraphProviderStage,
} from './types.js'

const PROVIDER_STAGE_ORDER: Record<MatOSAssetGraphProviderStage, number> = {
  relation: 0,
  'type-local': 1,
  lineage: 2,
  usage: 3,
  similarity: 4,
}

export function defaultMatOSAssetGraphProviders(): MatOSAssetGraphProvider[] {
  return [
    manifestRelationProvider,
    workflowAssetReferenceProvider,
    typeLocalProvider,
    lineageProvider,
    usageProvider,
    searchDocumentProvider,
  ]
}

export function sortMatOSAssetGraphProviders(
  providers: MatOSAssetGraphProvider[],
): MatOSAssetGraphProvider[] {
  return [...providers].sort(
    (a, b) =>
      PROVIDER_STAGE_ORDER[a.stage] - PROVIDER_STAGE_ORDER[b.stage] ||
      a.id.localeCompare(b.id),
  )
}

export function mergeMatOSAssetGraphProviders(
  extraProviders: MatOSAssetGraphProvider[] = [],
): MatOSAssetGraphProvider[] {
  const byId = new Map<string, MatOSAssetGraphProvider>()
  for (const provider of defaultMatOSAssetGraphProviders()) {
    byId.set(provider.id, provider)
  }
  for (const provider of extraProviders) {
    if (byId.has(provider.id)) {
      throw new Error(`Duplicate MatOS asset graph provider id: ${provider.id}`)
    }
    byId.set(provider.id, provider)
  }
  return sortMatOSAssetGraphProviders([...byId.values()])
}
