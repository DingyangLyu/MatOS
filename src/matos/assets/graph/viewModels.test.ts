import { describe, expect, test } from 'bun:test'
import type { MatOSAssetGraphIndex } from './types.js'
import { buildMatOSAssetWorkbenchState } from './viewModels.js'

function workbenchIndex(): MatOSAssetGraphIndex {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-06T00:00:00.000Z',
    root: '<workspace>',
    nodes: {
      'role:planner@0.1.0': {
        id: 'role:planner@0.1.0',
        kind: 'asset',
        label: 'Planner',
        assetType: 'role',
        canonicalKey: 'role:planner@0.1.0',
        name: 'Planner',
        version: '0.1.0',
        lifecycleStatus: 'enabled',
        tags: ['materials'],
        metadata: { group: 'materials' },
      },
      'knowledge:matbench@0.1.0': {
        id: 'knowledge:matbench@0.1.0',
        kind: 'asset',
        label: 'Matbench',
        assetType: 'knowledge',
        canonicalKey: 'knowledge:matbench@0.1.0',
        name: 'Matbench',
        version: '0.1.0',
        lifecycleStatus: 'enabled',
        description: 'Benchmark datasets.',
      },
      'snapshot:after': {
        id: 'snapshot:after',
        kind: 'snapshot',
        label: 'after',
        reference: 'after',
        createdAt: '2026-06-06T00:01:00.000Z',
        metadata: { snapshotKind: 'direct-editor-after' },
      },
      'release:stable': {
        id: 'release:stable',
        kind: 'release',
        label: 'stable',
        reference: 'stable',
        createdAt: '2026-06-06T00:02:00.000Z',
      },
      'trace:usage': {
        id: 'trace:usage',
        kind: 'trace',
        label: 'usage',
        reference: 'usage',
        metadata: { usageCount: 1 },
      },
    },
    edges: [
      {
        from: 'role:planner@0.1.0',
        to: 'knowledge:matbench@0.1.0',
        kind: 'mounts_knowledge',
        source: 'manifest',
      },
      {
        from: 'knowledge:matbench@0.1.0',
        to: 'snapshot:after',
        kind: 'snapshot_after',
        source: 'history',
        createdAt: '2026-06-06T00:01:00.000Z',
      },
      {
        from: 'snapshot:after',
        to: 'release:stable',
        kind: 'released_as',
        source: 'history',
        createdAt: '2026-06-06T00:02:00.000Z',
      },
      {
        from: 'knowledge:matbench@0.1.0',
        to: 'trace:usage',
        kind: 'used_in_session',
        source: 'trace',
      },
    ],
    reverseEdges: {
      'knowledge:matbench@0.1.0': [
        {
          from: 'role:planner@0.1.0',
          to: 'knowledge:matbench@0.1.0',
          kind: 'mounts_knowledge',
          source: 'manifest',
        },
      ],
      'snapshot:after': [
        {
          from: 'knowledge:matbench@0.1.0',
          to: 'snapshot:after',
          kind: 'snapshot_after',
          source: 'history',
        },
      ],
      'release:stable': [
        {
          from: 'snapshot:after',
          to: 'release:stable',
          kind: 'released_as',
          source: 'history',
        },
      ],
      'trace:usage': [
        {
          from: 'knowledge:matbench@0.1.0',
          to: 'trace:usage',
          kind: 'used_in_session',
          source: 'trace',
        },
      ],
    },
    typeGraphs: {},
    lineage: {},
    search: {
      documentCount: 2,
      vocabulary: { planner: 1, matbench: 1, benchmark: 1 },
      documents: {
        'role:planner@0.1.0': {
          id: 'role:planner@0.1.0',
          assetKey: 'role:planner@0.1.0',
          assetType: 'role',
          title: 'Planner',
          text: '',
          tags: ['materials'],
          terms: { planner: 1 },
        },
        'knowledge:matbench@0.1.0': {
          id: 'knowledge:matbench@0.1.0',
          assetKey: 'knowledge:matbench@0.1.0',
          assetType: 'knowledge',
          title: 'Matbench',
          text: '',
          tags: [],
          terms: { matbench: 1, benchmark: 1 },
        },
      },
    },
    stats: {
      assetCount: 2,
      nodeCount: 5,
      edgeCount: 4,
      providerCount: 4,
      typeCounts: { role: 1, knowledge: 1 },
      edgeKindCounts: {
        mounts_knowledge: 1,
        snapshot_after: 1,
        released_as: 1,
        used_in_session: 1,
      },
      issueCount: 0,
    },
    issues: [],
  }
}

describe('MatOS asset workbench view models', () => {
  test('builds selected explore state without exposing raw graph internals', () => {
    const state = buildMatOSAssetWorkbenchState({
      index: workbenchIndex(),
      selectedAssetRef: 'role:planner',
      mode: 'explore',
    })

    expect(state.selectedAssetKey).toBe('role:planner@0.1.0')
    expect(state.graph.nodes).toContainEqual(
      expect.objectContaining({
        id: 'role:planner@0.1.0',
        selected: true,
        emphasis: 'primary',
      }),
    )
    expect(state.graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'knowledge:matbench@0.1.0',
        label: 'mounts knowledge',
      }),
    )
    expect(state.inspector?.sections[0]?.rows).toContainEqual({
      label: 'ID',
      value: 'role:planner@0.1.0',
    })
  })

  test('builds lineage state with event nodes and stable release', () => {
    const state = buildMatOSAssetWorkbenchState({
      index: workbenchIndex(),
      selectedAssetRef: 'knowledge:matbench',
      mode: 'lineage',
    })

    expect(state.lineage?.stableRelease).toBe('release:stable')
    expect(state.graph.nodes).toContainEqual(
      expect.objectContaining({ id: 'snapshot:after', emphasis: 'event' }),
    )
    expect(state.graph.nodes).toContainEqual(
      expect.objectContaining({ id: 'release:stable', emphasis: 'event' }),
    )
  })

  test('builds impact and search states for asset management navigation', () => {
    const impact = buildMatOSAssetWorkbenchState({
      index: workbenchIndex(),
      selectedAssetRef: 'knowledge:matbench',
      mode: 'impact',
    })
    expect(impact.impact?.affectedAssetKeys).toEqual(['role:planner@0.1.0'])

    const search = buildMatOSAssetWorkbenchState({
      index: workbenchIndex(),
      query: 'benchmark',
      mode: 'explore',
    })
    expect(search.graph.nodes.map(node => node.id)).toContain(
      'knowledge:matbench@0.1.0',
    )
  })

  test('builds validate and raw mode payloads explicitly', () => {
    const validate = buildMatOSAssetWorkbenchState({
      index: workbenchIndex(),
      mode: 'validate',
    })
    expect(validate.validation?.stats.nodeCount).toBe(5)

    const raw = buildMatOSAssetWorkbenchState({
      index: workbenchIndex(),
      selectedAssetRef: 'role:planner',
      mode: 'raw',
    })
    expect(raw.raw?.selectedNode?.id).toBe('role:planner@0.1.0')
  })
})
