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
import type { MatOSAsset } from '../assets/types.js'
import { readMatOSAlgorithmCaptures } from '../algorithms/capture.js'
import { exportMatOSAlgorithmDataset } from '../algorithms/datasets.js'
import { matOSContextRankingSurface } from '../algorithms/surfaces/contextRanking.js'
import { clearMatOSAlgorithmDecisionLog } from '../algorithms/telemetry.js'
import { runMatOSBenchmarkCase } from './benchmarkRunner.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  clearMatOSAlgorithmDecisionLog()
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function fakeAsset(id: string, description: string): MatOSAsset {
  return {
    id,
    type: 'knowledge',
    name: id,
    version: '0.1.0',
    description,
    canonicalKey: `knowledge:${id}@0.1.0`,
    relativePath: `knowledge/${id}`,
    absolutePath: `/tmp/fake/knowledge/${id}`,
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: `/tmp/fake/knowledge/${id}/asset.json`,
    manifestDir: `/tmp/fake/knowledge/${id}`,
    source: 'project',
    sourcePath: '/tmp/fake',
    packId: undefined,
    packName: undefined,
    packVersion: undefined,
    tags: ['compute'],
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
    root: 'algo-compare-benchmark-test',
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

async function captureDataset(root: string): Promise<string> {
  const assets = [
    fakeAsset('vasp-notes', 'compute vasp notes'),
    fakeAsset('qe-notes', 'compute qe notes'),
    fakeAsset('md-notes', 'compute md notes'),
  ]
  const index = candidateIndex(assets)
  const candidateKeys = assets.map(asset => asset.canonicalKey)
  const env = { MATOS_ALGO_CAPTURE: '1', MATOS_ALGO_TELEMETRY: '0' }
  for (const query of ['compute vasp', 'compute qe']) {
    matOSContextRankingSurface.decideSync(
      {
        kind: 'knowledge',
        index,
        query,
        assetTypes: ['knowledge'],
        limit: 3,
        candidateKeys,
      },
      { env, cwd: root },
    )
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const captures = await readMatOSAlgorithmCaptures(root, 'context-ranking')
    if (captures.length >= 2) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const exported = await exportMatOSAlgorithmDataset({
    cwd: root,
    surfaceId: 'context-ranking',
  })
  return exported.path
}

describe('algo-compare benchmark kind', () => {
  test('baseline self-comparison passes agreement thresholds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-bench-'))
    const datasetPath = await captureDataset(root)
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'algo-baseline-regression',
      kind: 'algo-compare',
      algo: {
        dataset: datasetPath,
        providers: ['baseline'],
        thresholds: { minAgreementWithBaseline: 1 },
      },
    })
    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:algo-baseline-regression@0.1.0',
      casePath,
    })
    expect(result.status).toBe('succeeded')
    expect(result.ok).toBe(true)
    expect(result.evidence.message).toContain('evaluation record')
  })

  test('threshold violations fail the benchmark case', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-bench-fail-'))
    const datasetPath = await captureDataset(root)
    matOSContextRankingSurface.register({
      id: 'test-bench-reverse',
      decide: input => ({
        ranked: [...input.candidateKeys]
          .reverse()
          .map(assetKey => ({ assetKey })),
      }),
    })
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'algo-reverse-must-agree',
      kind: 'algo-compare',
      algo: {
        dataset: datasetPath,
        providers: ['baseline', 'test-bench-reverse'],
        thresholds: { minAgreementWithBaseline: 1 },
      },
    })
    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:algo-reverse-must-agree@0.1.0',
      casePath,
    })
    expect(result.status).toBe('failed')
    expect(result.ok).toBe(false)
    expect(result.evidence.message).toContain('test-bench-reverse agreement')
  })

  test('asset strategy providers are gated behind MATOS_RUN_REAL_BENCHMARKS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-bench-gate-'))
    const datasetPath = await captureDataset(root)
    delete process.env.MATOS_RUN_REAL_BENCHMARKS
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'algo-asset-gated',
      kind: 'algo-compare',
      algo: {
        dataset: datasetPath,
        providers: ['baseline', 'asset:tool:some-strategy@0.1.0'],
      },
    })
    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:algo-asset-gated@0.1.0',
      casePath,
    })
    expect(result.status).toBe('blocked')
    expect(result.evidence.message).toContain('MATOS_RUN_REAL_BENCHMARKS')
  })

  test('labelled correctness thresholds fail a provider that misses the expected asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-bench-labels-'))
    const datasetPath = join(root, 'labelled.json')
    const assets = [
      fakeAsset('expected-notes', 'expected target'),
      fakeAsset('wrong-notes', 'wrong target'),
    ]
    const index = candidateIndex(assets)
    await writeJson(datasetPath, {
      schemaVersion: 1,
      surfaceId: 'context-ranking',
      createdAt: '2026-07-13T00:00:00.000Z',
      sourceCaptureCount: 0,
      cases: [
        {
          id: 'expected-target',
          input: {
            kind: 'knowledge',
            index,
            query: 'expected target',
            assetTypes: ['knowledge'],
            limit: 2,
            candidateKeys: assets.map(asset => asset.canonicalKey),
          },
          expected: { rankedAssetKeys: [assets[0].canonicalKey] },
        },
      ],
    })
    matOSContextRankingSurface.register({
      id: 'test-bench-wrong-label',
      decide: () => ({
        ranked: [{ assetKey: assets[1].canonicalKey }],
      }),
    })
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'algo-label-threshold',
      kind: 'algo-compare',
      algo: {
        dataset: datasetPath,
        providers: ['baseline', 'test-bench-wrong-label'],
        thresholds: {
          minTop1ExpectedAccuracy: 1,
          minMeanExpectedReciprocalRank: 1,
          minMeanExpectedRecall: 1,
        },
      },
    })
    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:algo-label-threshold@0.1.0',
      casePath,
    })
    expect(result.status).toBe('failed')
    expect(result.evidence.message).toContain('expected top1')
    expect(result.evidence.message).toContain('expected MRR')
    expect(result.evidence.message).toContain('expected recall')
  })

  test('missing dataset and missing algo config block with guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-bench-missing-'))
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'algo-missing-dataset',
      kind: 'algo-compare',
      algo: {
        dataset: 'does-not-exist.json',
        providers: ['baseline'],
      },
    })
    const missingDataset = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:algo-missing-dataset@0.1.0',
      casePath,
    })
    expect(missingDataset.status).toBe('blocked')
    expect(missingDataset.evidence.message).toContain('dataset not found')

    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'algo-missing-config',
      kind: 'algo-compare',
    })
    const missingConfig = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:algo-missing-config@0.1.0',
      casePath,
    })
    expect(missingConfig.status).toBe('blocked')
    expect(missingConfig.evidence.message).toContain('algo.dataset')
  })
})
