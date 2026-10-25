import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import { readMatOSAlgorithmCaptures } from './capture.js'
import { exportMatOSAlgorithmDataset } from './datasets.js'
import {
  listMatOSAlgorithmRegressionRecords,
  runMatOSAlgorithmRegressionsForAssetChange,
  scheduleMatOSAlgorithmRegressionForDirectEditorRun,
} from './regression.js'
import { matOSContextRankingSurface } from './surfaces/contextRanking.js'
import { clearMatOSAlgorithmDecisionLog } from './telemetry.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  clearMatOSAlgorithmDecisionLog()
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// Identity strategy: echoes the baseline candidate order, so agreement-based
// thresholds pass against the baseline ranking on limit>=candidate datasets.
const IDENTITY_STRATEGY_SOURCE = `
const { readFileSync } = require('node:fs')
const payload = JSON.parse(readFileSync(0, 'utf8'))
const keys = [...(payload.input.candidateKeys ?? [])]
process.stdout.write(
  JSON.stringify({ decision: { ranked: keys.map(assetKey => ({ assetKey })) } }),
)
`

const REVERSE_STRATEGY_SOURCE = `
const { readFileSync } = require('node:fs')
const payload = JSON.parse(readFileSync(0, 'utf8'))
const keys = [...(payload.input.candidateKeys ?? [])].reverse()
process.stdout.write(
  JSON.stringify({ decision: { ranked: keys.map(assetKey => ({ assetKey })) } }),
)
`

async function writeStrategyAsset(input: {
  root: string
  id: string
  source: string
}): Promise<void> {
  const dir = join(input.root, '.matos/assets/strategies', input.id)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'asset.json'), {
    schemaVersion: 1,
    id: input.id,
    type: 'tool',
    name: input.id,
    version: '0.1.0',
    description: `strategy ${input.id}`,
    entry: './strategy.cjs',
    tags: ['algorithm-layer'],
    metadata: {
      algorithmSurface: 'context-ranking',
      decisionProtocol: 'json-v1',
      executor: { runtime: 'node', timeoutMs: 5000 },
    },
  })
  const scriptPath = join(dir, 'strategy.cjs')
  await writeFile(scriptPath, input.source, 'utf8')
  await chmod(scriptPath, 0o755)
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
    root: 'algo-regression-test',
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
  ]
  const index = candidateIndex(assets)
  const candidateKeys = assets.map(asset => asset.canonicalKey)
  matOSContextRankingSurface.decideSync(
    {
      kind: 'knowledge',
      index,
      query: 'compute vasp qe notes',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys,
    },
    { env: { MATOS_ALGO_CAPTURE: '1', MATOS_ALGO_TELEMETRY: '0' }, cwd: root },
  )
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const captures = await readMatOSAlgorithmCaptures(root, 'context-ranking')
    if (captures.length >= 1) {
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

async function writeAlgoCompareBenchmark(input: {
  root: string
  id: string
  datasetPath: string
  providerRef: string
  thresholds: Record<string, number>
}): Promise<void> {
  const dir = join(input.root, '.matos/assets/benchmarks', input.id)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'asset.json'), {
    schemaVersion: 1,
    id: input.id,
    type: 'benchmark',
    name: input.id,
    version: '0.1.0',
    description: `algo-compare regression benchmark ${input.id}`,
    entry: 'case.json',
    tags: ['algorithm-layer', 'benchmark'],
  })
  await writeJson(join(dir, 'case.json'), {
    schemaVersion: 2,
    id: input.id,
    kind: 'algo-compare',
    algo: {
      dataset: input.datasetPath,
      providers: ['baseline', input.providerRef],
      thresholds: input.thresholds,
    },
  })
}

describe('algorithm strategy regression automation', () => {
  test('accepted strategy change triggers matching algo-compare benchmarks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-regression-'))
    await writeStrategyAsset({
      root,
      id: 'identity-ranker',
      source: IDENTITY_STRATEGY_SOURCE,
    })
    const datasetPath = await captureDataset(root)
    await writeAlgoCompareBenchmark({
      root,
      id: 'identity-ranker-regression',
      datasetPath,
      providerRef: 'asset:tool:identity-ranker@0.1.0',
      // The dataset ranks both candidates; identity echoes candidate order,
      // which equals the baseline ranked order here, so overlap passes.
      thresholds: { minMeanRankedOverlapWithBaseline: 1 },
    })

    const record = await scheduleMatOSAlgorithmRegressionForDirectEditorRun({
      cwd: root,
      runId: 'run-test-1',
      status: 'accepted',
      changedAssetRefs: ['tool:identity-ranker'],
    })
    expect(record).toBeDefined()
    expect(record!.status).toBe('completed')
    expect(record!.trigger).toEqual({ kind: 'direct-editor', runId: 'run-test-1' })
    expect(record!.changedStrategyAssets[0]?.assetKey).toBe(
      'tool:identity-ranker@0.1.0',
    )
    expect(record!.benchmarks.length).toBe(1)
    expect(record!.benchmarks[0]?.status).toBe('succeeded')
    expect(record!.overallOk).toBe(true)

    const listed = await listMatOSAlgorithmRegressionRecords(root)
    expect(listed.length).toBe(1)
    expect(listed[0]?.regressionId).toBe(record!.regressionId)
  })

  test('regression failure is recorded when the strategy violates thresholds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-regression-fail-'))
    await writeStrategyAsset({
      root,
      id: 'reverse-ranker',
      source: REVERSE_STRATEGY_SOURCE,
    })
    const datasetPath = await captureDataset(root)
    await writeAlgoCompareBenchmark({
      root,
      id: 'reverse-ranker-regression',
      datasetPath,
      providerRef: 'asset:tool:reverse-ranker@0.1.0',
      thresholds: { minAgreementWithBaseline: 1 },
    })

    const record = await runMatOSAlgorithmRegressionsForAssetChange({
      cwd: root,
      changedAssetRefs: ['tool:reverse-ranker@0.1.0'],
      trigger: { kind: 'manual' },
    })
    expect(record).toBeDefined()
    expect(record!.overallOk).toBe(false)
    expect(record!.benchmarks[0]?.status).toBe('failed')
  })

  test('non-strategy changes and non-accepted runs do nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-regression-skip-'))
    const noStrategy = await runMatOSAlgorithmRegressionsForAssetChange({
      cwd: root,
      changedAssetRefs: ['skill:some-skill@1.0.0'],
      trigger: { kind: 'manual' },
    })
    expect(noStrategy).toBeUndefined()

    const rolledBack = await scheduleMatOSAlgorithmRegressionForDirectEditorRun({
      cwd: root,
      runId: 'run-rolled-back',
      status: 'rolled_back',
      changedAssetRefs: ['tool:whatever@0.1.0'],
    })
    expect(rolledBack).toBeUndefined()
    expect(await listMatOSAlgorithmRegressionRecords(root)).toEqual([])
  })

  test('strategy change without matching benchmarks records no-benchmarks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-regression-none-'))
    await writeStrategyAsset({
      root,
      id: 'lonely-ranker',
      source: IDENTITY_STRATEGY_SOURCE,
    })
    const record = await runMatOSAlgorithmRegressionsForAssetChange({
      cwd: root,
      changedAssetRefs: ['tool:lonely-ranker'],
      trigger: { kind: 'manual' },
    })
    expect(record).toBeDefined()
    expect(record!.status).toBe('no-benchmarks')
    expect(record!.overallOk).toBe(true)
    expect(record!.benchmarks).toEqual([])
  })
})
