import { readFile } from 'node:fs/promises'
import { parseWorkflowDefinition } from '../../workflows/schema.js'
import type { MatOSAsset } from '../types.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphEdgeKind,
  MatOSAssetGraphProvider,
  MatOSAssetGraphProviderContext,
  MatOSAssetGraphProviderResult,
} from './types.js'

type WorkflowReferenceSpec = {
  keys: Set<string>
  kind: MatOSAssetGraphEdgeKind
}

const WORKFLOW_REFERENCE_SPECS: WorkflowReferenceSpec[] = [
  {
    keys: new Set(['role', 'roleref']),
    kind: 'depends_on',
  },
  {
    keys: new Set(['tool', 'toolref']),
    kind: 'uses_tool',
  },
  {
    keys: new Set([
      'workflow',
      'workflowref',
      'childworkflow',
      'subworkflow',
      'subworkflowref',
    ]),
    kind: 'subworkflow',
  },
  {
    keys: new Set(['validator', 'validatorref', 'validatorasset']),
    kind: 'validates',
  },
  {
    keys: new Set(['benchmark', 'benchmarkref', 'benchmarkasset']),
    kind: 'benchmarks',
  },
  {
    keys: new Set(['skill', 'skillref']),
    kind: 'mounts_skill',
  },
  {
    keys: new Set(['knowledge', 'knowledgeref']),
    kind: 'mounts_knowledge',
  },
  {
    keys: new Set(['data', 'dataref']),
    kind: 'mounts_data',
  },
  {
    keys: new Set(['mcp', 'mcpref']),
    kind: 'uses_mcp',
  },
  {
    keys: new Set(['plugin', 'pluginref']),
    kind: 'uses_plugin',
  },
  {
    keys: new Set(['asset', 'assetref', 'assetrefs']),
    kind: 'depends_on',
  },
]

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

function referenceSpecForKey(key: string): WorkflowReferenceSpec | undefined {
  const normalized = normalizeKey(key)
  const explicit = WORKFLOW_REFERENCE_SPECS.find(spec => spec.keys.has(normalized))
  if (explicit) {
    return explicit
  }
  if (normalized.endsWith('assetref') || normalized.endsWith('assetrefs')) {
    return { keys: new Set([normalized]), kind: 'depends_on' }
  }
  return undefined
}

function stringReferences(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function edgeKindForResolvedTarget(
  fallback: MatOSAssetGraphEdgeKind,
  targetType: string,
): MatOSAssetGraphEdgeKind {
  switch (targetType) {
    case 'knowledge':
      return 'mounts_knowledge'
    case 'data':
      return 'mounts_data'
    case 'skill':
      return 'mounts_skill'
    case 'tool':
      return 'uses_tool'
    case 'workflow':
      return 'subworkflow'
    case 'benchmark':
    case 'benchmark-suite':
    case 'evaluation':
      return 'benchmarks'
    case 'mcp':
      return 'uses_mcp'
    case 'plugin':
      return 'uses_plugin'
    case 'role':
    case 'runtime':
    default:
      return fallback
  }
}

function collectWorkflowReferenceEdges(input: {
  context: MatOSAssetGraphProviderContext
  workflowAsset: MatOSAsset
  value: unknown
  path: string
  key?: string
  edges: MatOSAssetGraphEdge[]
}): void {
  const spec = input.key ? referenceSpecForKey(input.key) : undefined
  if (spec) {
    for (const reference of stringReferences(input.value)) {
      const target = input.context.registry.resolve(reference)
      if (!target || target.canonicalKey === input.workflowAsset.canonicalKey) {
        continue
      }
      input.edges.push({
        from: input.workflowAsset.canonicalKey,
        to: target.canonicalKey,
        kind: edgeKindForResolvedTarget(spec.kind, target.type),
        source: 'workflow',
        reference: input.path,
        weight: 0.8,
        confidence: 0.9,
      })
    }
  }

  if (Array.isArray(input.value)) {
    input.value.forEach((item, index) =>
      collectWorkflowReferenceEdges({
        ...input,
        value: item,
        path: `${input.path}[${index}]`,
        key: undefined,
      }),
    )
    return
  }

  if (!input.value || typeof input.value !== 'object') {
    return
  }

  for (const [key, value] of Object.entries(input.value as Record<string, unknown>)) {
    collectWorkflowReferenceEdges({
      ...input,
      value,
      path: input.path ? `${input.path}.${key}` : key,
      key,
    })
  }
}

export async function buildWorkflowAssetReferenceProviderResult(
  context: MatOSAssetGraphProviderContext,
): Promise<MatOSAssetGraphProviderResult> {
  const edges: MatOSAssetGraphEdge[] = []
  const issues: MatOSAssetGraphProviderResult['issues'] = []

  for (const asset of context.assets) {
    if (asset.type !== 'workflow' || !asset.entryAbsolutePath) {
      continue
    }
    try {
      const content = await readFile(asset.entryAbsolutePath, 'utf8')
      const definition = parseWorkflowDefinition(content, {
        sourcePath: asset.entryAbsolutePath,
      })
      collectWorkflowReferenceEdges({
        context,
        workflowAsset: asset,
        value: {
          policy: definition.policy,
          outputs: definition.outputs,
          compiled: definition.compiled,
        },
        path: 'workflow',
        edges,
      })
      for (const node of definition.nodes) {
        collectWorkflowReferenceEdges({
          context,
          workflowAsset: asset,
          value: node,
          path: `nodes.${node.id}`,
          edges,
        })
      }
    } catch (error) {
      issues.push({
        code: 'invalid_workflow_asset_reference_scan',
        assetKey: asset.canonicalKey,
        message: error instanceof Error ? error.message : String(error),
        severity: 'warning',
      })
    }
  }

  return { edges, issues }
}

export const workflowAssetReferenceProvider: MatOSAssetGraphProvider = {
  id: 'workflow-asset-reference',
  stage: 'relation',
  build: buildWorkflowAssetReferenceProviderResult,
}
