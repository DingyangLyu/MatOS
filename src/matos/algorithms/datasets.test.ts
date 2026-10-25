import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { assetGraphNodeFromAsset } from '../assets/graph/relationEdges.js'
import {
  buildSearchIndex,
  searchDocumentFromAsset,
} from '../assets/graph/searchIndex.js'
import type { MatOSAssetGraphIndex } from '../assets/graph/types.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import type { MatOSAsset } from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { readMatOSAlgorithmCaptures } from './capture.js'
import {
  compareMatOSAlgorithmProviders,
  exportMatOSAlgorithmDataset,
  writeMatOSAlgorithmEvaluationAsset,
} from './datasets.js'
import { matOSContextRankingSurface } from './surfaces/contextRanking.js'
import './surfaces/evolutionPolicy.js'
import { clearMatOSAlgorithmDecisionLog } from './telemetry.js'

afterEach(() => {
  clearMatOSAlgorithmDecisionLog()
})

function fakeAsset(input: {
  id: string
  tags?: string[]
  description?: string
}): MatOSAsset {
  return {
    id: input.id,
    type: 'knowledge',
    name: input.id,
    version: '0.1.0',
    description: input.description,
    canonicalKey: `knowledge:${input.id}@0.1.0`,
    relativePath: `knowledge/${input.id}`,
    absolutePath: `/tmp/fake/knowledge/${input.id}`,
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: `/tmp/fake/knowledge/${input.id}/asset.json`,
    manifestDir: `/tmp/fake/knowledge/${input.id}`,
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
    metadata: {},
  }
}

function candidateIndex(assets: MatOSAsset[]): MatOSAssetGraphIndex {
  const sorted = [...assets].sort((a, b) =>
    a.canonicalKey.localeCompare(b.canonicalKey),
  )
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: 'datasets-test',
    nodes: Object.fromEntries(
      sorted.map(asset => [asset.canonicalKey, assetGraphNodeFromAsset(asset)]),
    ),
    edges: [],
    reverseEdges: {},
    typeGraphs: {
      knowledge: {
        assetType: 'knowledge',
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
      typeCounts: { knowledge: sorted.length },
      edgeKindCounts: {},
      issueCount: 0,
    },
    issues: [],
  }
}

const assets = [
  fakeAsset({ id: 'vasp-notes', tags: ['compute'], description: 'compute vasp notes' }),
  fakeAsset({ id: 'qe-notes', tags: ['compute'], description: 'compute qe notes' }),
  fakeAsset({ id: 'md-notes', tags: ['compute'], description: 'compute md notes' }),
]
const index = candidateIndex(assets)
const candidateKeys = assets.map(asset => asset.canonicalKey)

function rankingInput(query: string) {
  return {
    kind: 'knowledge' as const,
    index,
    query,
    assetTypes: ['knowledge'],
    limit: 3,
    candidateKeys,
  }
}

async function waitForCaptures(
  cwd: string,
  surfaceId: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const captures = await readMatOSAlgorithmCaptures(cwd, surfaceId)
    if (captures.length >= expected) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`captures for ${surfaceId} did not reach ${expected}`)
}

describe('MatOS algorithm datasets and comparison', () => {
  test('labelled evolution cases compare signal selection without calling an LLM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-dataset-'))
    const datasetPath = join(root, 'evolution.json')
    const input = {
      schemaVersion: 1, phase: 'analyzed', trigger: { kind: 'user-feedback', key: 'correction' },
      constraints: { canAnalyze: true, canEdit: true, maxSignals: 8 },
      signals: [
        { id: 'weak', confidence: 0.5, evidenceSupport: 'supported', risk: 'low', targetTypes: ['knowledge'], targetRefs: [] },
        { id: 'strong', confidence: 0.95, evidenceSupport: 'supported', risk: 'low', targetTypes: ['tool'], targetRefs: [] },
      ],
    }
    await writeFile(datasetPath, JSON.stringify({ schemaVersion: 1, surfaceId: 'evolution-policy', createdAt: new Date().toISOString(), sourceCaptureCount: 0, cases: [
      { id: 'select', input, expected: { evolutionAction: 'edit', signalIds: ['strong'] } },
      { id: 'bad-label', input, expected: { evolutionAction: 'bogus', signalIds: [7] } },
    ] }))
    const { comparison } = await compareMatOSAlgorithmProviders({ cwd: root, datasetPath, providerIds: ['baseline', 'evidence-first'] })
    expect(comparison.providers.find(item => item.providerId === 'evidence-first')).toMatchObject({ expectedEvolutionCases: 1, expectedEvolutionActionAccuracy: 1, expectedEvolutionSignalExactMatch: 1, fallbackCount: 0 })
    expect(comparison.providers.find(item => item.providerId === 'baseline')).toMatchObject({ expectedEvolutionCases: 1, expectedEvolutionActionAccuracy: 1, expectedEvolutionSignalExactMatch: 0 })
  })

  test('capture -> export -> compare -> evaluation asset closes the loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-datasets-'))
    const env = {
      MATOS_ALGO_CAPTURE: '1',
      MATOS_ALGO_TELEMETRY: '0',
    }

    // Three real decisions: two distinct inputs plus one duplicate.
    matOSContextRankingSurface.decideSync(rankingInput('compute vasp'), {
      env,
      cwd: root,
    })
    matOSContextRankingSurface.decideSync(rankingInput('compute qe'), {
      env,
      cwd: root,
    })
    matOSContextRankingSurface.decideSync(rankingInput('compute vasp'), {
      env,
      cwd: root,
    })
    await waitForCaptures(root, 'context-ranking', 3)

    const exported = await exportMatOSAlgorithmDataset({
      cwd: root,
      surfaceId: 'context-ranking',
    })
    expect(exported.dataset.sourceCaptureCount).toBe(3)
    expect(exported.dataset.cases.length).toBe(2)

    matOSContextRankingSurface.register({
      id: 'test-reverse-for-compare',
      decide: input => {
        const source = input as { candidateKeys: string[] }
        return {
          ranked: [...source.candidateKeys]
            .reverse()
            .map(assetKey => ({ assetKey })),
        }
      },
    })

    const { comparison, recordPath } = await compareMatOSAlgorithmProviders({
      cwd: root,
      datasetPath: exported.path,
      providerIds: ['baseline', 'test-reverse-for-compare'],
    })
    expect(comparison.surfaceId).toBe('context-ranking')
    expect(comparison.dataset.caseCount).toBe(2)
    const byId = new Map(
      comparison.providers.map(provider => [provider.providerId, provider]),
    )
    const baselineMetrics = byId.get('baseline')
    expect(baselineMetrics?.agreementWithBaseline).toBe(1)
    expect(baselineMetrics?.fallbackCount).toBe(0)
    const reverseMetrics = byId.get('test-reverse-for-compare')
    expect(reverseMetrics).toBeDefined()
    expect(reverseMetrics!.agreementWithBaseline).toBeLessThan(1)
    expect(reverseMetrics!.meanRankedOverlapWithBaseline).toBeGreaterThan(0)
    expect(recordPath).toContain('.matos')

    const assetInfo = await writeMatOSAlgorithmEvaluationAsset({
      cwd: root,
      comparison,
    })
    const loaded = await loadMatOSAssets(root)
    const evaluation = loaded.find(
      asset => asset.canonicalKey === assetInfo.canonicalKey,
    )
    expect(evaluation).toBeDefined()
    expect(evaluation?.type).toBe('evaluation')
    expect(evaluation?.lifecycle.status).toBe('draft')

    const validation = await validateMatOSAssets(loaded, {
      includeDrafts: true,
    })
    const evaluationErrors = validation.errors.filter(
      error => error.assetId === comparison.evalId,
    )
    expect(evaluationErrors).toEqual([])
  })

  test('compare rejects unknown providers with a clear error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-datasets-unknown-'))
    const env = { MATOS_ALGO_CAPTURE: '1', MATOS_ALGO_TELEMETRY: '0' }
    matOSContextRankingSurface.decideSync(rankingInput('compute vasp'), {
      env,
      cwd: root,
    })
    await waitForCaptures(root, 'context-ranking', 1)
    const exported = await exportMatOSAlgorithmDataset({
      cwd: root,
      surfaceId: 'context-ranking',
    })
    await expect(
      compareMatOSAlgorithmProviders({
        cwd: root,
        datasetPath: exported.path,
        providerIds: ['baseline', 'no-such-provider'],
      }),
    ).rejects.toThrow(/not registered/)
  })

  test('labelled datasets report correctness independently of baseline agreement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-datasets-labels-'))
    const datasetPath = join(root, 'labelled.json')
    await writeFile(
      datasetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          surfaceId: 'context-ranking',
          createdAt: '2026-07-13T00:00:00.000Z',
          sourceCaptureCount: 0,
          cases: [
            {
              id: 'labelled-vasp',
              input: rankingInput('compute vasp'),
              expected: { rankedAssetKeys: [candidateKeys[0]] },
            },
            {
              id: 'malformed-label-is-ignored',
              input: rankingInput('compute qe'),
              expected: { rankedAssetKeys: 'not-an-array' },
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    matOSContextRankingSurface.register({
      id: 'test-wrong-label',
      decide: () => ({ ranked: [{ assetKey: candidateKeys[2] }] }),
    })

    const { comparison } = await compareMatOSAlgorithmProviders({
      cwd: root,
      datasetPath,
      providerIds: ['baseline', 'test-wrong-label'],
    })
    const byId = new Map(
      comparison.providers.map(provider => [provider.providerId, provider]),
    )
    expect(byId.get('baseline')?.expectedCaseCount).toBe(1)
    expect(byId.get('baseline')?.top1ExpectedAccuracy).toBe(1)
    expect(byId.get('baseline')?.meanExpectedReciprocalRank).toBe(1)
    expect(byId.get('baseline')?.meanExpectedRecall).toBe(1)
    expect(byId.get('test-wrong-label')?.top1ExpectedAccuracy).toBe(0)
    expect(byId.get('test-wrong-label')?.meanExpectedReciprocalRank).toBe(0)
    expect(byId.get('test-wrong-label')?.meanExpectedRecall).toBe(0)
  })

  test('dataset export without captures fails with guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-datasets-empty-'))
    await expect(
      exportMatOSAlgorithmDataset({ cwd: root, surfaceId: 'context-ranking' }),
    ).rejects.toThrow(/MATOS_ALGO_CAPTURE/)
  })
})
