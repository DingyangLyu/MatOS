import { readFile } from 'node:fs/promises'
import type { MatOSAssetRegistry } from '../assets/registry.js'
import { parseMatOSAssetReference } from '../assets/refs.js'
import type { MatOSAsset } from '../assets/types.js'
import { parseWorkflowDefinition } from './schema.js'
import type { LoadedMatOSWorkflow, MatOSWorkflowKind } from './types.js'

const WORKFLOW_KINDS = new Set<MatOSWorkflowKind>([
  'executable',
  'component',
  'template',
])

function getWorkflowKind(asset: MatOSAsset): MatOSWorkflowKind {
  const runtimeWorkflow =
    asset.runtime.workflow &&
    typeof asset.runtime.workflow === 'object' &&
    !Array.isArray(asset.runtime.workflow)
      ? (asset.runtime.workflow as Record<string, unknown>)
      : {}
  const kind = runtimeWorkflow.kind
  return typeof kind === 'string' && WORKFLOW_KINDS.has(kind as MatOSWorkflowKind)
    ? (kind as MatOSWorkflowKind)
    : 'executable'
}

export function workflowAssetNotFoundMessage(
  registry: MatOSAssetRegistry,
  reference: string,
  prefix = 'MatOS workflow asset not found',
): string {
  const parsed = parseMatOSAssetReference(reference)
  const available = registry.assets
    .filter(asset => asset.type === 'workflow' && asset.id === parsed.id)
    .map(asset => asset.canonicalKey)
    .filter((key): key is string => Boolean(key))
    .sort((left, right) => left.localeCompare(right))
  const uniqueAvailable = [...new Set(available)]
  return uniqueAvailable.length > 0
    ? `${prefix}: ${reference}. Available matching refs: ${uniqueAvailable.join(', ')}`
    : `${prefix}: ${reference}`
}

export async function loadWorkflowAsset(
  registry: MatOSAssetRegistry,
  reference: string,
): Promise<LoadedMatOSWorkflow> {
  const asset = registry.resolve(reference)
  if (!asset) {
    throw new Error(workflowAssetNotFoundMessage(registry, reference))
  }
  if (asset.type !== 'workflow') {
    throw new Error(`MatOS asset is not a workflow: ${asset.canonicalKey}`)
  }
  if (!asset.entryAbsolutePath) {
    throw new Error(`MatOS workflow asset is missing entry: ${asset.canonicalKey}`)
  }

  const content = await readFile(asset.entryAbsolutePath, 'utf8')
  return {
    asset,
    kind: getWorkflowKind(asset),
    definition: parseWorkflowDefinition(content, {
      sourcePath: asset.entryAbsolutePath,
    }),
  }
}
