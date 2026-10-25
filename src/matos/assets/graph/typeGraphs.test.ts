import { describe, expect, test } from 'bun:test'
import type { MatOSAsset } from '../types.js'
import { buildTypeGraphs, buildTypeLocalEdges } from './typeGraphs.js'

function asset(input: Partial<MatOSAsset> & Pick<MatOSAsset, 'canonicalKey' | 'id' | 'type'>): MatOSAsset {
  return {
    name: input.id,
    version: '0.1.0',
    description: undefined,
    relativePath: '',
    absolutePath: '',
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: '',
    manifestDir: '',
    source: 'pack',
    sourcePath: '',
    packId: 'test',
    packName: undefined,
    packVersion: undefined,
    tags: [],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: {},
    ...input,
  }
}

describe('MatOS asset type-local graphs', () => {
  test('adds deterministic same-group and same-tag edges within each asset type', () => {
    const edges = buildTypeLocalEdges([
      asset({
        canonicalKey: 'skill:alpha@0.1.0',
        id: 'alpha',
        type: 'skill',
        tags: ['materials', 'planning'],
        metadata: { group: 'materials' },
      }),
      asset({
        canonicalKey: 'skill:beta@0.1.0',
        id: 'beta',
        type: 'skill',
        tags: ['materials'],
        metadata: { group: 'materials' },
      }),
      asset({
        canonicalKey: 'knowledge:alpha@0.1.0',
        id: 'alpha',
        type: 'knowledge',
        tags: ['materials'],
        metadata: { group: 'materials' },
      }),
    ])

    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'skill:alpha@0.1.0',
        to: 'skill:beta@0.1.0',
        kind: 'same_group',
        reference: 'group:materials',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'skill:alpha@0.1.0',
        to: 'skill:beta@0.1.0',
        kind: 'same_tag',
        reference: 'tag:materials',
      }),
    )
    expect(edges).not.toContainEqual(
      expect.objectContaining({
        from: 'knowledge:alpha@0.1.0',
        to: 'skill:alpha@0.1.0',
      }),
    )
  })

  test('skips same_tag buckets above the tag fanout cap but keeps structured similarity', () => {
    // 13 skills sharing one hot tag (> SAME_TAG_FANOUT_LIMIT of 12): the tag
    // is a category, not a similarity — no edges. The two also sharing a
    // structured group still connect.
    const hotTagAssets = Array.from({ length: 13 }, (_, index) =>
      asset({
        canonicalKey: `skill:hot-${String(index).padStart(2, '0')}@0.1.0`,
        id: `hot-${String(index).padStart(2, '0')}`,
        type: 'skill',
        tags: ['materials'],
        metadata: index < 2 ? { group: 'shared-group' } : {},
      }),
    )
    const edges = buildTypeLocalEdges(hotTagAssets)

    expect(edges.filter(edge => edge.kind === 'same_tag')).toHaveLength(0)
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'skill:hot-00@0.1.0',
        to: 'skill:hot-01@0.1.0',
        kind: 'same_group',
      }),
    )

    // At the cap (12 sharing the tag) edges still build.
    const atCap = buildTypeLocalEdges(hotTagAssets.slice(0, 12))
    expect(atCap.some(edge => edge.kind === 'same_tag')).toBe(true)
  })

  test('adds tool similarity edges by backend, binding, and MCP server metadata', () => {
    const edges = buildTypeLocalEdges([
      asset({
        canonicalKey: 'tool:search@0.1.0',
        id: 'search',
        type: 'tool',
        metadata: {
          backend: 'mcp',
          binding: 'stdio',
          mcpServer: 'web',
          failureClasses: ['network-timeout'],
        },
      }),
      asset({
        canonicalKey: 'tool:fetch@0.1.0',
        id: 'fetch',
        type: 'tool',
        metadata: {
          backend: 'mcp',
          binding: 'stdio',
          mcpServer: 'web',
          failureClass: 'network-timeout',
        },
      }),
    ])

    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'tool:fetch@0.1.0',
        to: 'tool:search@0.1.0',
        kind: 'similar_to',
        reference: 'backend:mcp',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'tool:fetch@0.1.0',
        to: 'tool:search@0.1.0',
        kind: 'similar_to',
        reference: 'binding:stdio',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'tool:fetch@0.1.0',
        to: 'tool:search@0.1.0',
        kind: 'similar_to',
        reference: 'mcpServer:web',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'tool:fetch@0.1.0',
        to: 'tool:search@0.1.0',
        kind: 'similar_to',
        reference: 'failureClass:network-timeout',
      }),
    )
  })

  test('adds knowledge similarity edges by topic, family, failure class, and search terms', () => {
    const edges = buildTypeLocalEdges([
      asset({
        canonicalKey: 'knowledge:vasp-runbook@0.1.0',
        id: 'vasp-runbook',
        type: 'knowledge',
        metadata: {
          topics: ['vasp'],
          family: 'runtime',
          failureClass: 'runner-unreachable',
          searchTerms: ['gpu vasp'],
        },
      }),
      asset({
        canonicalKey: 'knowledge:vasp-gpu@0.1.0',
        id: 'vasp-gpu',
        type: 'knowledge',
        metadata: {
          topic: 'vasp',
          families: ['runtime'],
          failureClasses: ['runner-unreachable'],
          searchTerm: 'gpu vasp',
        },
      }),
    ])

    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:vasp-gpu@0.1.0',
        to: 'knowledge:vasp-runbook@0.1.0',
        kind: 'similar_to',
        reference: 'topic:vasp',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:vasp-gpu@0.1.0',
        to: 'knowledge:vasp-runbook@0.1.0',
        kind: 'similar_to',
        reference: 'family:runtime',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:vasp-gpu@0.1.0',
        to: 'knowledge:vasp-runbook@0.1.0',
        kind: 'similar_to',
        reference: 'failureClass:runner-unreachable',
      }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:vasp-gpu@0.1.0',
        to: 'knowledge:vasp-runbook@0.1.0',
        kind: 'similar_to',
        reference: 'searchTerm:gpu vasp',
      }),
    )
  })

  test('derives per-type graph summaries from nodes and edges', () => {
    const edges = [
      {
        from: 'skill:alpha@0.1.0',
        to: 'skill:beta@0.1.0',
        kind: 'same_group' as const,
        source: 'metadata' as const,
      },
      {
        from: 'role:planner@0.1.0',
        to: 'skill:alpha@0.1.0',
        kind: 'mounts_skill' as const,
        source: 'manifest' as const,
      },
    ]

    const graphs = buildTypeGraphs(
      {
        'role:planner@0.1.0': { assetType: 'role' },
        'skill:alpha@0.1.0': { assetType: 'skill' },
        'skill:beta@0.1.0': { assetType: 'skill' },
      },
      edges,
    )

    expect(graphs.skill).toEqual({
      assetType: 'skill',
      nodes: ['skill:alpha@0.1.0', 'skill:beta@0.1.0'],
      edges: [edges[0]],
      stats: { nodeCount: 2, edgeCount: 1 },
    })
    expect(graphs.role?.stats).toEqual({ nodeCount: 1, edgeCount: 0 })
  })
})
