import { describe, expect, test } from 'bun:test'
import type { MatOSAssetGraphIndex } from './types.js'
import {
  getMatOSAssetImpact,
  getMatOSAssetNeighborhood,
  getMatOSAssetRelated,
} from './queries.js'
import {
  rankMatOSAssets,
  resolveMatOSAssetGraphNodeId,
} from './relevance.js'

function testIndex(): MatOSAssetGraphIndex {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-06T00:00:00.000Z',
    root: '/tmp/test',
    nodes: {
      'role:compute@0.1.0': {
        id: 'role:compute@0.1.0',
        kind: 'asset',
        label: 'Compute',
        assetType: 'role',
        canonicalKey: 'role:compute@0.1.0',
        name: 'Compute',
        tags: ['materials'],
        lifecycleStatus: 'enabled',
      },
      'skill:mace-md@0.1.0': {
        id: 'skill:mace-md@0.1.0',
        kind: 'asset',
        label: 'MACE MD',
        assetType: 'skill',
        canonicalKey: 'skill:mace-md@0.1.0',
        name: 'MACE MD',
        description: 'Run GPU molecular dynamics with MACE models.',
        tags: ['mace', 'md', 'gpu'],
        lifecycleStatus: 'enabled',
      },
      'tool:web-search@0.1.0': {
        id: 'tool:web-search@0.1.0',
        kind: 'asset',
        label: 'Web Search',
        assetType: 'tool',
        canonicalKey: 'tool:web-search@0.1.0',
        name: 'Web Search',
        tags: ['research'],
        lifecycleStatus: 'enabled',
      },
      'knowledge:mace-runbook@0.1.0': {
        id: 'knowledge:mace-runbook@0.1.0',
        kind: 'asset',
        label: 'MACE Runbook',
        assetType: 'knowledge',
        canonicalKey: 'knowledge:mace-runbook@0.1.0',
        name: 'MACE Runbook',
        description: 'MACE GPU MD runbook with melting point guidance.',
        tags: ['mace', 'gpu'],
        lifecycleStatus: 'enabled',
      },
    },
    edges: [
      {
        from: 'role:compute@0.1.0',
        to: 'skill:mace-md@0.1.0',
        kind: 'mounts_skill',
        source: 'manifest',
      },
      {
        from: 'skill:mace-md@0.1.0',
        to: 'knowledge:mace-runbook@0.1.0',
        kind: 'mounts_knowledge',
        source: 'manifest',
      },
      {
        from: 'skill:mace-md@0.1.0',
        to: 'tool:web-search@0.1.0',
        kind: 'uses_tool',
        source: 'metadata',
      },
    ],
    reverseEdges: {
      'skill:mace-md@0.1.0': [
        {
          from: 'role:compute@0.1.0',
          to: 'skill:mace-md@0.1.0',
          kind: 'mounts_skill',
          source: 'manifest',
        },
      ],
      'knowledge:mace-runbook@0.1.0': [
        {
          from: 'skill:mace-md@0.1.0',
          to: 'knowledge:mace-runbook@0.1.0',
          kind: 'mounts_knowledge',
          source: 'manifest',
        },
      ],
      'tool:web-search@0.1.0': [
        {
          from: 'skill:mace-md@0.1.0',
          to: 'tool:web-search@0.1.0',
          kind: 'uses_tool',
          source: 'metadata',
        },
      ],
    },
    typeGraphs: {},
    lineage: {},
    search: {
      documentCount: 4,
      vocabulary: {
        compute: 1,
        gpu: 2,
        mace: 2,
        md: 1,
        melting: 1,
        point: 1,
        runbook: 1,
        search: 1,
        web: 1,
      },
      documents: {
        'role:compute@0.1.0': {
          id: 'role:compute@0.1.0',
          assetKey: 'role:compute@0.1.0',
          assetType: 'role',
          title: 'Compute',
          text: 'Compute materials',
          tags: ['materials'],
          terms: { compute: 1, materials: 1 },
        },
        'skill:mace-md@0.1.0': {
          id: 'skill:mace-md@0.1.0',
          assetKey: 'skill:mace-md@0.1.0',
          assetType: 'skill',
          title: 'MACE MD',
          text: 'MACE GPU molecular dynamics MD',
          tags: ['mace', 'gpu', 'md'],
          terms: { mace: 1, gpu: 1, molecular: 1, dynamics: 1, md: 1 },
        },
        'tool:web-search@0.1.0': {
          id: 'tool:web-search@0.1.0',
          assetKey: 'tool:web-search@0.1.0',
          assetType: 'tool',
          title: 'Web Search',
          text: 'Web search research',
          tags: ['research'],
          terms: { web: 1, search: 1, research: 1 },
        },
        'knowledge:mace-runbook@0.1.0': {
          id: 'knowledge:mace-runbook@0.1.0',
          assetKey: 'knowledge:mace-runbook@0.1.0',
          assetType: 'knowledge',
          title: 'MACE Runbook',
          text: 'MACE GPU MD melting point runbook',
          tags: ['mace', 'gpu'],
          terms: { mace: 1, gpu: 1, md: 1, melting: 1, point: 1, runbook: 1 },
        },
      },
    },
    stats: {
      assetCount: 4,
      nodeCount: 4,
      edgeCount: 3,
      providerCount: 3,
      typeCounts: { role: 1, skill: 1, tool: 1, knowledge: 1 },
      edgeKindCounts: { mounts_skill: 1, mounts_knowledge: 1, uses_tool: 1 },
      issueCount: 0,
    },
    issues: [],
  }
}

describe('MatOS asset graph relevance and queries', () => {
  test('ranks assets with lexical, graph-distance, and score explanations', () => {
    const hits = rankMatOSAssets({
      index: testIndex(),
      query: 'mace gpu melting',
      seedRefs: ['role:compute'],
      assetTypes: ['skill', 'knowledge'],
      limit: 3,
    })

    expect(hits.map(hit => hit.assetKey)).toEqual([
      'knowledge:mace-runbook@0.1.0',
      'skill:mace-md@0.1.0',
    ])
    expect(hits[0]?.explanations.map(item => item.kind)).toContain('lexical')
    expect(hits[1]?.explanations.map(item => item.kind)).toContain(
      'graph_distance',
    )
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
  })

  test('returns related assets through the shared ranking API', () => {
    const related = getMatOSAssetRelated(testIndex(), {
      assetRef: 'role:compute',
      types: ['skill', 'knowledge'],
      limit: 2,
    })

    expect(related.root).toBe('role:compute@0.1.0')
    expect(related.hits.map(hit => hit.assetKey)).toContain(
      'skill:mace-md@0.1.0',
    )
  })

  test('reports reverse-impact and graph neighborhoods without UI layout data', () => {
    const impact = getMatOSAssetImpact(testIndex(), 'knowledge:mace-runbook')
    expect(impact.root).toBe('knowledge:mace-runbook@0.1.0')
    expect(impact.affectedAssetKeys).toEqual([
      'role:compute@0.1.0',
      'skill:mace-md@0.1.0',
    ])

    const neighborhood = getMatOSAssetNeighborhood(testIndex(), {
      assetRef: 'skill:mace-md',
      direction: 'all',
      depth: 1,
    })
    expect(neighborhood.nodes).toEqual([
      'knowledge:mace-runbook@0.1.0',
      'role:compute@0.1.0',
      'skill:mace-md@0.1.0',
      'tool:web-search@0.1.0',
    ])
    expect(neighborhood).not.toHaveProperty('layout')
  })

  test('resolves unversioned refs by semantic asset version', () => {
    const index = testIndex()
    index.nodes['skill:versioned@0.9.0'] = {
      id: 'skill:versioned@0.9.0',
      kind: 'asset',
      label: 'Versioned old',
      assetType: 'skill',
      canonicalKey: 'skill:versioned@0.9.0',
      version: '0.9.0',
    }
    index.nodes['skill:versioned@0.10.0'] = {
      id: 'skill:versioned@0.10.0',
      kind: 'asset',
      label: 'Versioned new',
      assetType: 'skill',
      canonicalKey: 'skill:versioned@0.10.0',
      version: '0.10.0',
    }

    expect(resolveMatOSAssetGraphNodeId(index, 'skill:versioned')).toBe(
      'skill:versioned@0.10.0',
    )
  })

  test('impact ignores type-local similarity edges', () => {
    const index = testIndex()
    index.edges.push({
      from: 'knowledge:mace-runbook@0.1.0',
      to: 'tool:web-search@0.1.0',
      kind: 'same_group',
      source: 'metadata',
    })
    index.reverseEdges['tool:web-search@0.1.0'] = [
      ...(index.reverseEdges['tool:web-search@0.1.0'] ?? []),
      {
        from: 'knowledge:mace-runbook@0.1.0',
        to: 'tool:web-search@0.1.0',
        kind: 'same_group',
        source: 'metadata',
      },
    ]

    const impact = getMatOSAssetImpact(index, 'tool:web-search')

    expect(impact.affectedAssetKeys).not.toContain(
      'knowledge:mace-runbook@0.1.0',
    )
  })

  test('boosts assets with observed usage metadata', () => {
    const index = testIndex()
    index.nodes['tool:web-search@0.1.0'] = {
      ...index.nodes['tool:web-search@0.1.0']!,
      metadata: { usage: { count: 20, traceCount: 3, sessionCount: 4 } },
    }

    const hits = rankMatOSAssets({ index, limit: 2 })

    expect(hits[0]?.assetKey).toBe('tool:web-search@0.1.0')
    expect(hits[0]?.explanations).toContainEqual(
      expect.objectContaining({
        kind: 'usage',
        detail: 'observed usage count: 20',
      }),
    )
  })

  test('ranks deprecated assets below draft and above disabled', () => {
    const index = testIndex()
    index.nodes['skill:mace-md@0.1.0'] = {
      ...index.nodes['skill:mace-md@0.1.0']!,
      lifecycleStatus: 'deprecated',
    }

    const hits = rankMatOSAssets({ index, query: 'mace gpu md' })
    const deprecatedHit = hits.find(hit => hit.assetKey === 'skill:mace-md@0.1.0')
    expect(deprecatedHit?.explanations).toContainEqual(
      expect.objectContaining({ kind: 'penalty', detail: 'deprecated asset' }),
    )
    const enabledHit = hits.find(
      hit => hit.assetKey === 'knowledge:mace-runbook@0.1.0',
    )
    expect(enabledHit).toBeDefined()
    expect((enabledHit?.score ?? 0) > (deprecatedHit?.score ?? 0)).toBe(true)
  })

  test('does not return enabled status-only hits for a no-match query', () => {
    const hits = rankMatOSAssets({
      index: testIndex(),
      query: '__no_such_asset_query_zzzz__',
      limit: 3,
    })

    expect(hits).toEqual([])
  })

  test('uses evidence and lineage inputs as ranking signals', () => {
    const index = testIndex()
    index.lineage['knowledge:mace-runbook@0.1.0'] = {
      assetKey: 'knowledge:mace-runbook@0.1.0',
      eventCount: 3,
      rollbackTargetCount: 1,
    }
    index.edges.push({
      from: 'experience-event:experience:mace-fix@0.1.0',
      to: 'tool:web-search@0.1.0',
      kind: 'evidence_for',
      source: 'evolution',
      reference: 'experience:mace-fix@0.1.0',
      evidenceRefs: ['experience:mace-fix@0.1.0'],
    })
    index.reverseEdges['tool:web-search@0.1.0'] = [
      ...(index.reverseEdges['tool:web-search@0.1.0'] ?? []),
      {
        from: 'experience-event:experience:mace-fix@0.1.0',
        to: 'tool:web-search@0.1.0',
        kind: 'evidence_for',
        source: 'evolution',
        reference: 'experience:mace-fix@0.1.0',
        evidenceRefs: ['experience:mace-fix@0.1.0'],
      },
    ]

    const hits = rankMatOSAssets({
      index,
      evidenceRefs: ['experience:mace-fix@0.1.0'],
      includeLineage: true,
      assetTypes: ['tool', 'knowledge'],
    })

    expect(hits.map(hit => hit.assetKey)).toContain('tool:web-search@0.1.0')
    expect(hits.map(hit => hit.assetKey)).toContain(
      'knowledge:mace-runbook@0.1.0',
    )
    expect(
      hits.find(hit => hit.assetKey === 'tool:web-search@0.1.0')?.explanations,
    ).toContainEqual(expect.objectContaining({ kind: 'evidence' }))
    expect(
      hits.find(hit => hit.assetKey === 'knowledge:mace-runbook@0.1.0')
        ?.explanations,
    ).toContainEqual(expect.objectContaining({ kind: 'lineage' }))
  })
})
