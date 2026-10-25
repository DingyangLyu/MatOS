import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import {
  buildMatOSAssetExecProviderScope,
  matOSAssetExecProviderId,
  registerMatOSAssetExecProviders,
  resetMatOSAssetExecAlgorithmProviderState,
} from './assetExecProvider.js'
import { rankMatOSAssets } from '../assets/graph/relevance.js'
import { assetGraphNodeFromAsset } from '../assets/graph/relationEdges.js'
import {
  buildSearchIndex,
  searchDocumentFromAsset,
} from '../assets/graph/searchIndex.js'
import type { MatOSAssetGraphIndex } from '../assets/graph/types.js'
import type { MatOSAsset } from '../assets/types.js'
import { clearMatOSAlgorithmDecisionLog } from './telemetry.js'
import { decideMatOSContextRanking } from './surfaces/contextRanking.js'

afterEach(() => {
  clearMatOSAlgorithmDecisionLog()
  resetMatOSAssetExecAlgorithmProviderState()
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// A real json-v1 strategy: reverse the candidate order.
const REVERSE_STRATEGY_SOURCE = `
const { readFileSync } = require('node:fs')
const payload = JSON.parse(readFileSync(0, 'utf8'))
const keys = [...(payload.input.candidateKeys ?? [])].reverse()
process.stdout.write(
  JSON.stringify({ decision: { ranked: keys.map(assetKey => ({ assetKey })) } }),
)
`

const BROKEN_STRATEGY_SOURCE = `
process.stdout.write('this is not json')
process.exit(0)
`

const IDENTITY_STRATEGY_SOURCE = `
const { readFileSync } = require('node:fs')
const payload = JSON.parse(readFileSync(0, 'utf8'))
const keys = [...(payload.input.candidateKeys ?? [])]
process.stdout.write(
  JSON.stringify({ decision: { ranked: keys.map(assetKey => ({ assetKey })) } }),
)
`

function sandboxProbeStrategySource(escapePath: string): string {
  return `
const { readFileSync, writeFileSync } = require('node:fs')
const payload = JSON.parse(readFileSync(0, 'utf8'))

async function main() {
  let denied = 0
  try { readFileSync('/etc/passwd', 'utf8') } catch { denied += 1 }
  try { writeFileSync(${JSON.stringify(escapePath)}, 'escape') } catch { denied += 1 }
  try {
    require('node:child_process').execFileSync('touch', [${JSON.stringify(
      escapePath,
    )}])
  } catch { denied += 1 }
  const networkDenied = await new Promise(resolve => {
    const socket = require('node:net').createConnection({ host: '127.0.0.1', port: 9 })
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 250)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false) })
    socket.once('error', () => { clearTimeout(timer); resolve(true) })
  })
  if (networkDenied) denied += 1
  const keys = [...(payload.input.candidateKeys ?? [])]
  const ranked = denied === 4 ? keys.reverse() : keys
  process.stdout.write(JSON.stringify({ decision: { ranked: ranked.map(assetKey => ({ assetKey })) } }))
}

main().catch(() => process.exit(2))
`
}

async function writeStrategyAsset(input: {
  root: string
  id: string
  source: string
  surfaceId?: string
  protocol?: string
}): Promise<void> {
  const dir = join(input.root, '.matos/assets/strategies', input.id)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'asset.json'), {
    schemaVersion: 1,
    id: input.id,
    type: 'tool',
    name: input.id,
    version: '0.1.0',
    description: `Test strategy ${input.id}`,
    entry: './strategy.cjs',
    tags: ['test', 'algorithm-layer'],
    metadata: {
      algorithmSurface: input.surfaceId ?? 'context-ranking',
      decisionProtocol: input.protocol ?? 'json-v1',
      executor: { runtime: 'node', timeoutMs: 5000 },
    },
  })
  const scriptPath = join(dir, 'strategy.cjs')
  await writeFile(scriptPath, input.source, 'utf8')
  await chmod(scriptPath, 0o755)
}

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
    root: 'exec-provider-test',
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

const rankingAssets = [
  fakeAsset({
    id: 'alpha-guide',
    tags: ['compute'],
    description: 'compute guide alpha',
  }),
  fakeAsset({
    id: 'beta-guide',
    tags: ['compute'],
    description: 'compute guide beta',
  }),
  fakeAsset({
    id: 'gamma-guide',
    tags: ['compute'],
    description: 'compute guide gamma',
  }),
]
const rankingIndex = candidateIndex(rankingAssets)
const rankingKeys = rankingAssets.map(asset => asset.canonicalKey)

describe('MatOS asset exec providers', () => {
  test('registers a real strategy tool asset and executes it via env selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-exec-'))
    await writeStrategyAsset({
      root,
      id: 'reverse-ranking-strategy',
      source: REVERSE_STRATEGY_SOURCE,
    })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const report = registerMatOSAssetExecProviders(registry)
    const strategyAsset = registry.assets.find(
      asset => asset.id === 'reverse-ranking-strategy',
    )
    expect(strategyAsset).toBeDefined()
    const providerId = matOSAssetExecProviderId(strategyAsset as MatOSAsset)
    expect(report.registered.map(item => item.providerId)).toContain(providerId)

    const baseline = rankMatOSAssets({
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
    })
    expect(baseline.length).toBe(3)

    const { decision, providerId: usedProvider, fallback } =
      decideMatOSContextRanking({
        kind: 'knowledge',
        index: rankingIndex,
        query: 'compute guide',
        assetTypes: ['knowledge'],
        limit: 3,
        candidateKeys: rankingKeys,
        env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
      })
    expect(usedProvider).toBe(providerId)
    expect(fallback).toBeUndefined()
    expect(decision.ranked.map(hit => hit.assetKey)).toEqual(
      [...rankingKeys].reverse(),
    )
  })

  test('broken strategy output falls back to the baseline ranking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-exec-broken-'))
    await writeStrategyAsset({
      root,
      id: 'broken-strategy',
      source: BROKEN_STRATEGY_SOURCE,
    })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    registerMatOSAssetExecProviders(registry)
    const strategyAsset = registry.assets.find(
      asset => asset.id === 'broken-strategy',
    )
    expect(strategyAsset).toBeDefined()
    const providerId = matOSAssetExecProviderId(strategyAsset as MatOSAsset)

    const baseline = rankMatOSAssets({
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
    })
    const { decision, fallback } = decideMatOSContextRanking({
      kind: 'knowledge',
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys: rankingKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
    })
    expect(fallback).toBe('provider-error')
    expect(decision.ranked).toEqual(
      baseline.map(hit => ({ assetKey: hit.assetKey, score: hit.score })),
    )
  })

  test('denies host reads, filesystem mutation, subprocesses, and network access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-exec-sandbox-'))
    const escapePath = join(root, 'strategy-escaped.txt')
    await writeStrategyAsset({
      root,
      id: 'sandbox-probe-strategy',
      source: sandboxProbeStrategySource(escapePath),
    })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    registerMatOSAssetExecProviders(registry)
    const strategyAsset = registry.assets.find(
      asset => asset.id === 'sandbox-probe-strategy',
    )
    const providerId = matOSAssetExecProviderId(strategyAsset as MatOSAsset)
    const result = decideMatOSContextRanking({
      kind: 'knowledge',
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys: rankingKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
    })
    expect(result.fallback).toBeUndefined()
    expect(result.decision.ranked.map(hit => hit.assetKey)).toEqual(
      [...rankingKeys].reverse(),
    )
    await expect(access(escapePath)).rejects.toThrow()
  })

  test('refuses Python providers that cannot enforce a host-read allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-python-read-'))
    const assetDir = join(root, '.matos/assets/strategies/python-reader')
    const secretPath = join(root, 'known-secret.txt')
    await mkdir(assetDir, { recursive: true })
    await writeFile(secretPath, 'must-not-cross-provider-boundary', 'utf8')
    await writeJson(join(assetDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'python-reader',
      type: 'tool',
      name: 'python reader',
      version: '0.1.0',
      entry: './strategy.py',
      metadata: {
        algorithmSurface: 'context-ranking',
        decisionProtocol: 'json-v1',
      },
    })
    await writeFile(
      join(assetDir, 'strategy.py'),
      `import json\nprint(json.dumps({"decision":{"reason":open(${JSON.stringify(
        secretPath,
      )}).read()}}))\n`,
      'utf8',
    )
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const report = registerMatOSAssetExecProviders(registry)
    expect(
      report.registered.some(item => item.assetKey === 'tool:python-reader@0.1.0'),
    ).toBe(false)
    expect(report.skipped).toContainEqual({
      assetKey: 'tool:python-reader@0.1.0',
      reason: 'no-runnable-entry',
    })
  })

  test('same-version strategy edits replace the live provider without restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-exec-refresh-'))
    await writeStrategyAsset({
      root,
      id: 'hot-refresh-strategy',
      source: REVERSE_STRATEGY_SOURCE,
    })
    let registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    registerMatOSAssetExecProviders(registry)
    const strategyAsset = registry.assets.find(
      asset => asset.id === 'hot-refresh-strategy',
    ) as MatOSAsset
    const providerId = matOSAssetExecProviderId(strategyAsset)
    const before = decideMatOSContextRanking({
      kind: 'knowledge',
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys: rankingKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
    })
    expect(before.decision.ranked.map(hit => hit.assetKey)).toEqual(
      [...rankingKeys].reverse(),
    )

    await writeFile(
      join(
        root,
        '.matos/assets/strategies/hot-refresh-strategy/strategy.cjs',
      ),
      IDENTITY_STRATEGY_SOURCE,
      'utf8',
    )
    registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    registerMatOSAssetExecProviders(registry)
    const after = decideMatOSContextRanking({
      kind: 'knowledge',
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys: rankingKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
    })
    expect(after.fallback).toBeUndefined()
    expect(after.decision.ranked.map(hit => hit.assetKey)).toEqual(rankingKeys)

    await rm(
      join(root, '.matos/assets/strategies/hot-refresh-strategy'),
      { recursive: true },
    )
    registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    registerMatOSAssetExecProviders(registry)
    const removed = decideMatOSContextRanking({
      kind: 'knowledge',
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys: rankingKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
    })
    expect(removed.providerId).toBe('baseline')
    expect(removed.fallback).toBe('unknown-provider')
  })

  test('registry-local scopes isolate providers with the same asset identity', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'matos-algo-scope-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'matos-algo-scope-b-'))
    await writeStrategyAsset({
      root: rootA,
      id: 'scoped-strategy',
      source: REVERSE_STRATEGY_SOURCE,
    })
    await writeStrategyAsset({
      root: rootB,
      id: 'scoped-strategy',
      source: IDENTITY_STRATEGY_SOURCE,
    })
    const registryA = buildMatOSAssetRegistry(await loadMatOSAssets(rootA))
    const registryB = buildMatOSAssetRegistry(await loadMatOSAssets(rootB))
    const scopeA = buildMatOSAssetExecProviderScope(registryA)
    const scopeB = buildMatOSAssetExecProviderScope(registryB)
    const asset = registryA.assets.find(
      item => item.id === 'scoped-strategy',
    ) as MatOSAsset
    const providerId = matOSAssetExecProviderId(asset)
    const common = {
      kind: 'knowledge' as const,
      index: rankingIndex,
      query: 'compute guide',
      assetTypes: ['knowledge'],
      limit: 3,
      candidateKeys: rankingKeys,
      env: { MATOS_ALGO_CONTEXT_RANKING: providerId },
    }
    const fromA = decideMatOSContextRanking({
      ...common,
      providerOverrides: scopeA.providersFor('context-ranking'),
    })
    const fromB = decideMatOSContextRanking({
      ...common,
      providerOverrides: scopeB.providersFor('context-ranking'),
    })
    expect(fromA.decision.ranked.map(hit => hit.assetKey)).toEqual(
      [...rankingKeys].reverse(),
    )
    expect(fromB.decision.ranked.map(hit => hit.assetKey)).toEqual(rankingKeys)
  })

  test('reports unsupported protocols and unknown surfaces as skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-exec-skip-'))
    await writeStrategyAsset({
      root,
      id: 'wrong-protocol-strategy',
      source: REVERSE_STRATEGY_SOURCE,
      protocol: 'json-v999',
    })
    await writeStrategyAsset({
      root,
      id: 'unknown-surface-strategy',
      source: REVERSE_STRATEGY_SOURCE,
      surfaceId: 'not-a-real-surface',
    })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const report = registerMatOSAssetExecProviders(registry)
    const reasons = new Map(
      report.skipped.map(item => [item.assetKey, item.reason]),
    )
    expect(reasons.get('tool:wrong-protocol-strategy@0.1.0')).toBe(
      'unsupported-protocol',
    )
    expect(reasons.get('tool:unknown-surface-strategy@0.1.0')).toBe(
      'unknown-surface',
    )
    expect(report.registered.map(item => item.assetKey)).not.toContain(
      'tool:wrong-protocol-strategy@0.1.0',
    )
  })
})
