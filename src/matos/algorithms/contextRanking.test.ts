import { afterEach, describe, expect, test } from 'bun:test'
import { assetGraphNodeFromAsset } from '../assets/graph/relationEdges.js'
import { rankMatOSAssets } from '../assets/graph/relevance.js'
import {
  buildSearchIndex,
  searchDocumentFromAsset,
} from '../assets/graph/searchIndex.js'
import type { MatOSAssetGraphIndex } from '../assets/graph/types.js'
import type { MatOSAsset } from '../assets/types.js'
import { clearMatOSAlgorithmDecisionLog } from './telemetry.js'
import {
  decideMatOSContextRanking,
  matOSContextRankingSurface,
} from './surfaces/contextRanking.js'

function fakeAsset(input: {
  id: string
  type?: string
  name?: string
  description?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}): MatOSAsset {
  const type = input.type ?? 'knowledge'
  return {
    id: input.id,
    type,
    name: input.name ?? input.id,
    version: '0.1.0',
    description: input.description,
    canonicalKey: `${type}:${input.id}@0.1.0`,
    relativePath: `${type}/${input.id}`,
    absolutePath: `/tmp/fake/${type}/${input.id}`,
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: `/tmp/fake/${type}/${input.id}/asset.json`,
    manifestDir: `/tmp/fake/${type}/${input.id}`,
    source: 'project',
    sourcePath: '/tmp/fake',
    packId: undefined,
    packName: undefined,
    packVersion: undefined,
    tags: input.tags ?? [],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: input.metadata ?? {},
  }
}

function candidateIndex(
  assets: MatOSAsset[],
  assetType: string,
): MatOSAssetGraphIndex {
  const sorted = [...assets].sort((a, b) =>
    a.canonicalKey.localeCompare(b.canonicalKey),
  )
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: 'context-ranking-test',
    nodes: Object.fromEntries(
      sorted.map(asset => [asset.canonicalKey, assetGraphNodeFromAsset(asset)]),
    ),
    edges: [],
    reverseEdges: {},
    typeGraphs: {
      [assetType]: {
        assetType,
        nodes: sorted.map(asset => asset.canonicalKey),
        edges: [],
        stats: { nodeCount: sorted.length, edgeCount: 0 },
      },
    },
    lineage: {},
    search: buildSearchIndex(
      sorted.map(asset =>
        searchDocumentFromAsset(asset, { includeEntryExcerpt: false }),
      ),
    ),
    stats: {
      assetCount: sorted.length,
      nodeCount: sorted.length,
      edgeCount: 0,
      providerCount: 1,
      typeCounts: { [assetType]: sorted.length },
      edgeKindCounts: {},
      issueCount: 0,
    },
    issues: [],
  }
}

const assets = [
  fakeAsset({
    id: 'vasp-relax-runbook',
    description: 'VASP relaxation troubleshooting runbook',
    tags: ['vasp', 'compute'],
    metadata: { summary: 'How to recover failed VASP relax runs' },
  }),
  fakeAsset({
    id: 'qe-pseudopotentials-guide',
    description: 'Quantum Espresso pseudopotential selection guide',
    tags: ['qe', 'compute'],
    metadata: { summary: 'Choosing SSSP pseudopotentials for QE' },
  }),
  fakeAsset({
    id: 'lammps-md-notes',
    description: 'LAMMPS molecular dynamics notes',
    tags: ['lammps'],
    metadata: { summary: 'Thermal property MD workflows' },
  }),
]

const index = candidateIndex(assets, 'knowledge')
const candidateKeys = assets.map(asset => asset.canonicalKey)

afterEach(() => {
  clearMatOSAlgorithmDecisionLog()
})

describe('context-ranking surface', () => {
  test('golden: baseline output equals direct rankMatOSAssets output', () => {
    const query = 'vasp relax compute troubleshooting'
    const direct = rankMatOSAssets({
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
    })
    const { decision, providerId, fallback } = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
      env: {},
    })
    expect(providerId).toBe('baseline')
    expect(fallback).toBeUndefined()
    expect(decision.ranked).toEqual(
      direct.map(hit => ({ assetKey: hit.assetKey, score: hit.score })),
    )
    expect(decision.ranked.length).toBeGreaterThan(0)
  })

  test('custom strategies cannot introduce assets outside the candidate set', () => {
    matOSContextRankingSurface.register({
      id: 'test-outside-candidates',
      decide: () => ({
        ranked: [
          { assetKey: 'knowledge:not-a-candidate@1.0.0' },
          { assetKey: candidateKeys[2] },
          { assetKey: candidateKeys[2] },
          { assetKey: candidateKeys[0] },
        ],
      }),
    })
    const { decision } = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query: 'anything',
      assetTypes: ['knowledge'],
      limit: 2,
      candidateKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: 'test-outside-candidates' },
    })
    expect(decision.ranked).toEqual([
      { assetKey: candidateKeys[2] },
      { assetKey: candidateKeys[0] },
    ])
  })

  test('failing custom strategy falls back to baseline ranking', () => {
    matOSContextRankingSurface.register({
      id: 'test-broken-ranker',
      decide: () => {
        throw new Error('ranker crashed')
      },
    })
    const query = 'qe pseudopotentials'
    const direct = rankMatOSAssets({
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
    })
    const { decision, fallback } = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: 'test-broken-ranker' },
    })
    expect(fallback).toBe('provider-error')
    expect(decision.ranked).toEqual(
      direct.map(hit => ({ assetKey: hit.assetKey, score: hit.score })),
    )
  })

  test('baseline-configurable reweights ranking signals from env config', () => {
    const query = 'vasp relax compute troubleshooting'
    const baseline = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
      env: {},
    })
    // Multiplying every signal by the same factor preserves the order.
    const uniform = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
      env: {
        MATOS_ALGO_CONTEXT_RANKING: 'baseline-configurable',
        MATOS_ALGO_CONTEXT_RANKING_CONFIG: JSON.stringify({
          multipliers: {
            exact: 2,
            lexical: 2,
            graph_distance: 2,
            edge_kind: 2,
            status: 2,
            usage: 2,
            lineage: 2,
            evidence: 2,
            penalty: 2,
          },
        }),
      },
    })
    expect(uniform.providerId).toBe('baseline-configurable')
    expect(uniform.fallback).toBeUndefined()
    expect(uniform.decision.ranked.map(hit => hit.assetKey)).toEqual(
      baseline.decision.ranked.map(hit => hit.assetKey),
    )

    // Missing or invalid config makes the provider abstain -> baseline result.
    const abstain = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query,
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
      env: {
        MATOS_ALGO_CONTEXT_RANKING: 'baseline-configurable',
        MATOS_ALGO_CONTEXT_RANKING_CONFIG: 'not json',
      },
    })
    expect(abstain.fallback).toBe('empty-decision')
    expect(abstain.decision.ranked).toEqual(baseline.decision.ranked)
  })

  test('role.runtime.algorithms selects the provider for the surface', () => {
    matOSContextRankingSurface.register({
      id: 'test-role-selected',
      decide: input => ({
        ranked: [{ assetKey: input.candidateKeys[1] }],
      }),
    })
    const role = fakeAsset({ id: 'compute-role', type: 'role' })
    role.runtime = {
      algorithms: { 'context-ranking': 'test-role-selected' },
    }
    const { decision, providerId, source } = decideMatOSContextRanking({
      kind: 'knowledge',
      index,
      query: 'anything',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
      role,
      env: {},
    })
    expect(providerId).toBe('test-role-selected')
    expect(source).toBe('role')
    expect(decision.ranked).toEqual([{ assetKey: candidateKeys[1] }])
  })
})
