import { MATOS_ASSET_MOUNT_GROUPS, type MatOSAsset } from '../types.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphEdgeKind,
  MatOSAssetGraphEdgeSource,
  MatOSAssetGraphNode,
  MatOSAssetGraphProvider,
  MatOSAssetGraphProviderContext,
  MatOSAssetGraphIssue,
} from './types.js'

const RUNTIME_MOUNT_GROUPS = new Set(['tools'])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function metadataStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

export function assetGraphNodeFromAsset(asset: MatOSAsset): MatOSAssetGraphNode {
  return {
    id: asset.canonicalKey,
    kind: 'asset',
    label: asset.name || asset.canonicalKey,
    assetType: asset.type,
    canonicalKey: asset.canonicalKey,
    name: asset.name,
    version: asset.version,
    description: asset.description,
    tags: [...asset.tags].sort(),
    lifecycleStatus: asset.lifecycle.status,
    source: asset.source,
    packId: asset.packId,
    metadata: {
      group: optionalString(asset.metadata.group),
      summary: optionalString(asset.metadata.summary),
    },
  }
}

function mountEdgeKind(group: string): MatOSAssetGraphEdgeKind | undefined {
  switch (group) {
    case 'knowledge':
      return 'mounts_knowledge'
    case 'data':
      return 'mounts_data'
    case 'skills':
      return 'mounts_skill'
    case 'tools':
      return 'mounts_tool'
    case 'mcp':
      return 'uses_mcp'
    case 'plugins':
      return 'uses_plugin'
    case 'workflows':
      return 'subworkflow'
    case 'roles':
      return 'depends_on'
    default:
      return undefined
  }
}

function pushResolvedEdge(
  edges: MatOSAssetGraphEdge[],
  context: MatOSAssetGraphProviderContext,
  asset: MatOSAsset,
  reference: string,
  kind: MatOSAssetGraphEdgeKind,
  source: MatOSAssetGraphEdgeSource,
  issues: MatOSAssetGraphIssue[],
  missingCode: string,
): void {
  const target = context.registry.resolve(reference)
  if (!target || !context.assets.includes(target)) {
    const optional = metadataStrings(asset.metadata.optionalToolRefs).includes(reference)
    issues.push({
      code: optional ? 'optional_reference_unavailable' : missingCode,
      severity: optional || kind === 'evidence_for' ? 'info' : 'error',
      assetKey: asset.canonicalKey,
      message: `Asset reference ${JSON.stringify(reference)} is unavailable in this runtime view.`,
    })
    return
  }
  edges.push({
    from: asset.canonicalKey,
    to: target.canonicalKey,
    kind,
    source,
    reference,
  })
}

export function buildManifestRelationEdges(
  context: MatOSAssetGraphProviderContext,
  issues: MatOSAssetGraphIssue[] = [],
): MatOSAssetGraphEdge[] {
  const edges: MatOSAssetGraphEdge[] = []

  for (const asset of context.assets) {
    for (const dependency of asset.dependencies) {
      pushResolvedEdge(edges, context, asset, dependency, 'depends_on', 'manifest', issues, 'missing_dependency')
    }

    for (const reference of metadataStrings(asset.metadata.toolReferences)) {
      if (!reference.includes(':')) continue
      pushResolvedEdge(edges, context, asset, reference, 'uses_tool', 'metadata', issues, 'missing_tool')
    }

    // Evolution provenance: experience assets record which assets their
    // lessons target (`metadata.targetAssetRefs`, written by the refiner).
    // Materializing those as edges connects experiences to the live graph —
    // without them the 198 experience nodes averaged 0.03 edges each, so the
    // direct editor's seedRefs were isolated islands and its graph-distance
    // and evidence ranking signals never fired.
    for (const reference of metadataStrings(asset.metadata.targetAssetRefs)) {
      pushResolvedEdge(edges, context, asset, reference, 'evidence_for', 'metadata', issues, 'historical_reference_unavailable')
    }

    const runtimeProfile = optionalString(asset.runtime.profile)
    if (runtimeProfile) {
      pushResolvedEdge(
        edges,
        context,
        asset,
        runtimeProfile,
        'uses_runtime',
        'manifest',
        issues,
        'missing_runtime',
      )
    }

    for (const group of MATOS_ASSET_MOUNT_GROUPS) {
      const kind = mountEdgeKind(group)
      if (!kind) {
        continue
      }
      for (const reference of asset.mounts[group] ?? []) {
        if (RUNTIME_MOUNT_GROUPS.has(group) && !reference.includes(':')) {
          continue
        }
        pushResolvedEdge(edges, context, asset, reference, kind, 'manifest', issues, 'missing_mount')
      }
    }
  }

  return edges
}

export const manifestRelationProvider: MatOSAssetGraphProvider = {
  id: 'manifest-relation',
  stage: 'relation',
  build(context) {
    const issues: MatOSAssetGraphIssue[] = []
    const edges = buildManifestRelationEdges(context, issues)
    return {
      nodes: context.assets.map(assetGraphNodeFromAsset),
      edges,
      issues,
    }
  },
}
