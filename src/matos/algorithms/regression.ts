import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import type { MatOSAsset } from '../assets/types.js'
import { getMatOSDir } from '../project.js'
import { matOSAssetExecProviderId } from './assetExecProvider.js'

/**
 * Automatic algo-compare regression after algorithm strategy asset changes.
 *
 * When a self-evolution direct-editor run (or an operator) changes a strategy
 * tool asset, every bundled `algo-compare` benchmark case that references the
 * changed strategy (via `algo.providers` or `subjectRefs`) is re-run and the
 * outcome is recorded under `.matos/algorithms/regressions/`. Regressions are
 * evidence for operators, daily reports, and promotion gates, and never block
 * the foreground path. By default they do not roll back an already-accepted
 * edit; with MATOS_EVOLUTION_REGRESSION_AUTO_ROLLBACK=1 the direct-editor
 * scheduler rolls back an accepted run whose completed regression failed
 * (see shouldAutoRollbackAcceptedRunForRegression in directAssetEditor.ts).
 */

export type MatOSAlgorithmRegressionBenchmarkResult = {
  benchmarkRef: string
  caseId: string
  status: 'succeeded' | 'failed' | 'blocked'
  ok: boolean
  message?: string
}

export type MatOSAlgorithmRegressionRecord = {
  schemaVersion: 1
  regressionId: string
  createdAt: string
  trigger: {
    kind: 'direct-editor' | 'manual'
    runId?: string
  }
  changedStrategyAssets: Array<{
    assetKey: string
    surfaceId: string
    providerId: string
  }>
  benchmarks: MatOSAlgorithmRegressionBenchmarkResult[]
  /** True when no matching benchmark failed (blocked cases do not fail). */
  overallOk: boolean
  status: 'completed' | 'no-benchmarks'
}

export function matOSAlgorithmRegressionsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'algorithms', 'regressions')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function isStrategyAsset(asset: MatOSAsset): boolean {
  return (
    asset.type === 'tool' &&
    Boolean(optionalString(asset.metadata.algorithmSurface))
  )
}

/** Reference forms under which a strategy asset may appear in a case file. */
function strategyReferenceForms(asset: MatOSAsset): Set<string> {
  return new Set(
    [
      asset.canonicalKey,
      `tool:${asset.id}`,
      `tool:${asset.id}@${asset.version}`,
      matOSAssetExecProviderId(asset),
      optionalString(asset.metadata.algorithmSurface),
    ].filter((item): item is string => Boolean(item)),
  )
}

type AlgoCompareCandidate = {
  benchmarkRef: string
  casePath: string
  references: Set<string>
}

async function algoCompareBenchmarkCandidates(
  registry: ReturnType<typeof buildMatOSAssetRegistry>,
): Promise<AlgoCompareCandidate[]> {
  const candidates: AlgoCompareCandidate[] = []
  for (const asset of registry.assets) {
    if (asset.type !== 'benchmark' || !asset.entryAbsolutePath) {
      continue
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(
        await readFile(asset.entryAbsolutePath, 'utf8'),
      ) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed?.kind !== 'algo-compare') {
      continue
    }
    const references = new Set<string>()
    const algo =
      parsed.algo && typeof parsed.algo === 'object' && !Array.isArray(parsed.algo)
        ? (parsed.algo as Record<string, unknown>)
        : undefined
    for (const provider of Array.isArray(algo?.providers) ? algo.providers : []) {
      if (typeof provider === 'string' && provider.trim()) {
        references.add(provider.trim())
        // Version-insensitive form so a strategy version bump still matches.
        references.add(provider.trim().replace(/@[^@]+$/, ''))
      }
    }
    for (const subject of Array.isArray(parsed.subjectRefs)
      ? parsed.subjectRefs
      : []) {
      if (typeof subject === 'string' && subject.trim()) {
        references.add(subject.trim())
        references.add(subject.trim().replace(/@[^@]+$/, ''))
      }
    }
    candidates.push({
      benchmarkRef: asset.canonicalKey,
      casePath: asset.entryAbsolutePath,
      references,
    })
  }
  return candidates
}

function candidateMatchesStrategy(
  candidate: AlgoCompareCandidate,
  strategyForms: Set<string>,
): boolean {
  for (const form of strategyForms) {
    if (
      candidate.references.has(form) ||
      candidate.references.has(form.replace(/@[^@]+$/, ''))
    ) {
      return true
    }
  }
  return false
}

async function writeRegressionRecord(
  cwd: string,
  record: MatOSAlgorithmRegressionRecord,
): Promise<void> {
  const dir = matOSAlgorithmRegressionsDir(cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${record.regressionId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Runs algo-compare regressions for a set of changed asset refs. Returns
 * undefined (and records nothing) when no changed asset is an algorithm
 * strategy tool asset. Strategy executables are exercised through the normal
 * benchmark runner; the real-benchmark gate is opened only for the duration
 * of this regression run because validating an already-accepted strategy
 * edit is exactly what the gate exists to authorize.
 */
export async function runMatOSAlgorithmRegressionsForAssetChange(input: {
  cwd: string
  changedAssetRefs: string[]
  trigger: MatOSAlgorithmRegressionRecord['trigger']
}): Promise<MatOSAlgorithmRegressionRecord | undefined> {
  const changedRefs = [
    ...new Set(
      input.changedAssetRefs
        .map(ref => ref.trim())
        .filter(ref => ref.length > 0),
    ),
  ]
  if (changedRefs.length === 0) {
    return undefined
  }
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const changedStrategies: MatOSAsset[] = []
  const seenKeys = new Set<string>()
  for (const ref of changedRefs) {
    const asset = registry.resolve(ref)
    if (asset && isStrategyAsset(asset) && !seenKeys.has(asset.canonicalKey)) {
      seenKeys.add(asset.canonicalKey)
      changedStrategies.push(asset)
    }
  }
  if (changedStrategies.length === 0) {
    return undefined
  }

  const candidates = await algoCompareBenchmarkCandidates(registry)
  const strategyForms = changedStrategies.map(strategyReferenceForms)
  const matched = candidates.filter(candidate =>
    strategyForms.some(forms => candidateMatchesStrategy(candidate, forms)),
  )

  const record: MatOSAlgorithmRegressionRecord = {
    schemaVersion: 1,
    regressionId: randomUUID(),
    createdAt: new Date().toISOString(),
    trigger: input.trigger,
    changedStrategyAssets: changedStrategies.map(asset => ({
      assetKey: asset.canonicalKey,
      surfaceId: optionalString(asset.metadata.algorithmSurface) as string,
      providerId: matOSAssetExecProviderId(asset),
    })),
    benchmarks: [],
    overallOk: true,
    status: matched.length === 0 ? 'no-benchmarks' : 'completed',
  }

  if (matched.length > 0) {
    const { runMatOSBenchmarkCase } = await import(
      '../learning/benchmarkRunner.js'
    )
    // Authorize strategy-executable replays for this regression run only,
    // then restore the previous gate state (same pattern as the matos-run
    // benchmark selection env).
    const previousGate = process.env.MATOS_RUN_REAL_BENCHMARKS
    process.env.MATOS_RUN_REAL_BENCHMARKS = '1'
    try {
      for (const candidate of matched) {
        try {
          const result = await runMatOSBenchmarkCase({
            cwd: input.cwd,
            benchmarkRef: candidate.benchmarkRef,
            casePath: candidate.casePath,
          })
          record.benchmarks.push({
            benchmarkRef: candidate.benchmarkRef,
            caseId: result.caseId,
            status: result.status,
            ok: result.ok,
            ...(result.evidence.message
              ? { message: result.evidence.message }
              : {}),
          })
          if (result.status === 'failed') {
            record.overallOk = false
          }
        } catch (error) {
          record.benchmarks.push({
            benchmarkRef: candidate.benchmarkRef,
            caseId: 'unknown',
            status: 'failed',
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          })
          record.overallOk = false
        }
      }
    } finally {
      if (previousGate === undefined) {
        delete process.env.MATOS_RUN_REAL_BENCHMARKS
      } else {
        process.env.MATOS_RUN_REAL_BENCHMARKS = previousGate
      }
    }
  }

  await writeRegressionRecord(input.cwd, record)
  return record
}

/**
 * Fire-and-forget scheduler for the direct-editor accepted path. Never
 * throws, never blocks, and does nothing for runs that did not change an
 * algorithm strategy asset.
 */
export function scheduleMatOSAlgorithmRegressionForDirectEditorRun(input: {
  cwd: string
  runId: string
  status: string
  changedAssetRefs: string[]
}): Promise<MatOSAlgorithmRegressionRecord | undefined> {
  if (input.status !== 'accepted' && input.status !== 'accepted_merged') {
    return Promise.resolve(undefined)
  }
  return runMatOSAlgorithmRegressionsForAssetChange({
    cwd: input.cwd,
    changedAssetRefs: input.changedAssetRefs,
    trigger: { kind: 'direct-editor', runId: input.runId },
  }).catch(() => undefined)
}

export async function listMatOSAlgorithmRegressionRecords(
  cwd: string,
  limit = 20,
): Promise<MatOSAlgorithmRegressionRecord[]> {
  let entries: string[] = []
  try {
    entries = await readdir(matOSAlgorithmRegressionsDir(cwd))
  } catch {
    return []
  }
  const records: MatOSAlgorithmRegressionRecord[] = []
  for (const entry of entries.filter(name => name.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(
        await readFile(join(matOSAlgorithmRegressionsDir(cwd), entry), 'utf8'),
      ) as MatOSAlgorithmRegressionRecord
      if (parsed && parsed.schemaVersion === 1 && parsed.regressionId) {
        records.push(parsed)
      }
    } catch {
      // Skip unreadable records.
    }
  }
  return records
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
}
