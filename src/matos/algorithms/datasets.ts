import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getMatOSDir } from '../project.js'
import type { MatOSEvolutionDecision } from './evolution/protocol.js'
import { readMatOSAlgorithmCaptures } from './capture.js'
import {
  getMatOSAlgorithmSurface,
  MATOS_ALGORITHM_BASELINE_PROVIDER_ID,
} from './surface.js'

/**
 * Frozen decision-replay datasets and provider-vs-provider comparison.
 *
 * Datasets are built from opt-in capture rows (`MATOS_ALGO_CAPTURE=1`) so a
 * comparison replays real runtime decision inputs offline, without LLM cost.
 * Comparison results are written as evaluation records and optionally as a
 * draft `evaluation` asset so competing strategies leave reproducible,
 * citable evidence.
 */

export type MatOSAlgorithmDatasetCase = {
  id: string
  input: Record<string, unknown>
  /**
   * Optional human-curated labels. Unlabelled capture/replay datasets remain
   * valid and keep the original baseline-agreement-only behavior.
   */
  expected?: {
    rankedAssetKeys?: string[]
    evolutionAction?: MatOSEvolutionDecision['action']
    signalIds?: string[]
  }
}

export type MatOSAlgorithmDataset = {
  schemaVersion: 1
  surfaceId: string
  createdAt: string
  sourceCaptureCount: number
  cases: MatOSAlgorithmDatasetCase[]
}

export type MatOSAlgorithmProviderMetrics = {
  providerId: string
  cases: number
  fallbackCount: number
  fallbackKinds: Record<string, number>
  meanLatencyMs: number
  agreementWithBaseline: number
  top1AgreementWithBaseline?: number
  meanRankedOverlapWithBaseline?: number
  expectedCaseCount?: number
  top1ExpectedAccuracy?: number
  meanExpectedReciprocalRank?: number
  meanExpectedRecall?: number
  expectedEvolutionCases?: number
  expectedEvolutionActionAccuracy?: number
  expectedEvolutionSignalExactMatch?: number
}

export type MatOSAlgorithmComparison = {
  schemaVersion: 1
  evalId: string
  surfaceId: string
  createdAt: string
  dataset: {
    path: string
    sha256: string
    caseCount: number
  }
  baselineProviderId: string
  providers: MatOSAlgorithmProviderMetrics[]
}

function datasetsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'algorithms', 'datasets')
}

function evaluationsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'algorithms', 'evaluations')
}

function timestampSlug(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
    .toLowerCase()
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function caseId(input: Record<string, unknown>, digest?: string): string {
  if (digest) {
    return digest
  }
  return contentHash(JSON.stringify(input)).slice(0, 16)
}

export async function exportMatOSAlgorithmDataset(options: {
  cwd: string
  surfaceId: string
  limit?: number
}): Promise<{ path: string; dataset: MatOSAlgorithmDataset }> {
  const captures = await readMatOSAlgorithmCaptures(
    options.cwd,
    options.surfaceId,
  )
  if (captures.length === 0) {
    throw new Error(
      `No captured decisions for surface ${options.surfaceId}. ` +
        'Run MatOS with MATOS_ALGO_CAPTURE=1 first to record real decision inputs.',
    )
  }
  const seen = new Set<string>()
  const cases: MatOSAlgorithmDatasetCase[] = []
  // Newest captures win so the frozen dataset reflects the current asset state.
  for (const capture of [...captures].reverse()) {
    const id = caseId(capture.input, capture.inputDigest)
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    cases.push({ id, input: capture.input })
    if (options.limit && cases.length >= options.limit) {
      break
    }
  }
  cases.sort((a, b) => a.id.localeCompare(b.id))
  const dataset: MatOSAlgorithmDataset = {
    schemaVersion: 1,
    surfaceId: options.surfaceId,
    createdAt: new Date().toISOString(),
    sourceCaptureCount: captures.length,
    cases,
  }
  const path = join(
    datasetsDir(options.cwd),
    `${options.surfaceId}-${timestampSlug()}.json`,
  )
  await mkdir(datasetsDir(options.cwd), { recursive: true })
  await writeFile(path, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8')
  return { path, dataset }
}

export async function loadMatOSAlgorithmDataset(
  path: string,
): Promise<{ dataset: MatOSAlgorithmDataset; sha256: string }> {
  const raw = await readFile(path, 'utf8')
  const dataset = JSON.parse(raw) as MatOSAlgorithmDataset
  if (
    !dataset ||
    dataset.schemaVersion !== 1 ||
    typeof dataset.surfaceId !== 'string' ||
    !Array.isArray(dataset.cases)
  ) {
    throw new Error(`Not a MatOS algorithm dataset: ${path}`)
  }
  return { dataset, sha256: contentHash(raw) }
}

function rankedKeys(decision: unknown): string[] | undefined {
  if (!decision || typeof decision !== 'object') {
    return undefined
  }
  const ranked = (decision as Record<string, unknown>).ranked
  if (!Array.isArray(ranked)) {
    return undefined
  }
  const keys: string[] = []
  for (const hit of ranked) {
    if (hit && typeof hit === 'object') {
      const key = (hit as Record<string, unknown>).assetKey
      if (typeof key === 'string') {
        keys.push(key)
      }
    }
  }
  return keys
}

function expectedRankedKeys(
  item: MatOSAlgorithmDatasetCase,
): string[] | undefined {
  const expected = item.expected
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return undefined
  }
  const raw = expected.rankedAssetKeys
  if (!Array.isArray(raw)) {
    return undefined
  }
  const keys = raw.filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  )
  return keys.length > 0 ? [...new Set(keys)] : undefined
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 1
  }
  const a = new Set(left)
  const b = new Set(right)
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1
    }
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 1 : intersection / union
}

export async function compareMatOSAlgorithmProviders(options: {
  cwd: string
  datasetPath: string
  providerIds: string[]
  env?: Record<string, string | undefined>
}): Promise<{
  comparison: MatOSAlgorithmComparison
  recordPath: string
}> {
  const { dataset, sha256 } = await loadMatOSAlgorithmDataset(
    options.datasetPath,
  )
  const surface = getMatOSAlgorithmSurface(dataset.surfaceId)
  if (!surface) {
    throw new Error(`Unknown algorithm surface: ${dataset.surfaceId}`)
  }
  const providerIds = [...new Set(options.providerIds)]
  if (providerIds.length === 0) {
    throw new Error('compare requires at least one provider id')
  }
  const known = new Set(surface.listProviderIds())
  for (const providerId of providerIds) {
    if (!known.has(providerId)) {
      throw new Error(
        `Provider ${providerId} is not registered on surface ${dataset.surfaceId}. ` +
          `Known providers: ${[...known].join(', ')}`,
      )
    }
  }
  if (dataset.cases.length === 0) {
    throw new Error(`Dataset has no cases: ${options.datasetPath}`)
  }

  // Comparison runs must not select providers through ambient env/role
  // config and must not append telemetry noise from replays into the live
  // ledger, so pass an explicit empty env with telemetry disabled.
  const replayEnv = { MATOS_ALGO_TELEMETRY: '0', ...options.env }

  const baselineDecisions = new Map<string, string>()
  const baselineRanked = new Map<string, string[]>()
  for (const item of dataset.cases) {
    const outcome = await surface.decide(item.input, {
      providerId: MATOS_ALGORITHM_BASELINE_PROVIDER_ID,
      env: replayEnv,
      cwd: options.cwd,
    })
    baselineDecisions.set(item.id, JSON.stringify(outcome.decision))
    const keys = rankedKeys(outcome.decision)
    if (keys) {
      baselineRanked.set(item.id, keys)
    }
  }

  const providers: MatOSAlgorithmProviderMetrics[] = []
  for (const providerId of providerIds) {
    let fallbackCount = 0
    const fallbackKinds: Record<string, number> = {}
    let agreement = 0
    let top1Agreement = 0
    let top1Comparable = 0
    let overlapSum = 0
    let overlapComparable = 0
    let expectedCaseCount = 0
    let top1Expected = 0
    let reciprocalRankSum = 0
    let expectedRecallSum = 0
    let latencySum = 0
    let evolutionCases = 0
    let evolutionActions = 0
    let evolutionSignals = 0
    let evolutionSignalCases = 0
    for (const item of dataset.cases) {
      const startedAt = performance.now()
      const outcome = await surface.decide(item.input, {
        providerId,
        env: replayEnv,
        cwd: options.cwd,
      })
      latencySum += performance.now() - startedAt
      if (outcome.fallback) {
        fallbackCount += 1
        fallbackKinds[outcome.fallback] =
          (fallbackKinds[outcome.fallback] ?? 0) + 1
      }
      const serialized = JSON.stringify(outcome.decision)
      if (dataset.surfaceId === 'evolution-policy' && ['analyze', 'edit', 'defer', 'stop', 'retain', 'reject'].includes(item.expected?.evolutionAction ?? '')) {
        evolutionCases++
        const decision = outcome.decision as MatOSEvolutionDecision
        if (!outcome.fallback && decision.action === item.expected.evolutionAction) evolutionActions++
        if (Array.isArray(item.expected?.signalIds) && item.expected.signalIds.every(id => typeof id === 'string' && id.trim())) {
          evolutionSignalCases++
          if (!outcome.fallback && JSON.stringify([...new Set(decision.signalIds)].sort()) === JSON.stringify([...new Set(item.expected.signalIds)].sort())) evolutionSignals++
        }
      }
      if (serialized === baselineDecisions.get(item.id)) {
        agreement += 1
      }
      const baseKeys = baselineRanked.get(item.id)
      const keys = rankedKeys(outcome.decision)
      if (baseKeys && keys) {
        overlapComparable += 1
        overlapSum += jaccard(baseKeys, keys)
        if (baseKeys.length > 0 || keys.length > 0) {
          top1Comparable += 1
          if (baseKeys[0] === keys[0]) {
            top1Agreement += 1
          }
        }
      }
      const expectedKeys = expectedRankedKeys(item)
      if (keys && expectedKeys && expectedKeys.length > 0) {
        expectedCaseCount += 1
        if (keys[0] === expectedKeys[0]) {
          top1Expected += 1
        }
        const primaryRank = keys.indexOf(expectedKeys[0])
        reciprocalRankSum += primaryRank >= 0 ? 1 / (primaryRank + 1) : 0
        const predicted = new Set(keys)
        const recalled = expectedKeys.filter(key => predicted.has(key)).length
        expectedRecallSum += recalled / expectedKeys.length
      }
    }
    const caseCount = dataset.cases.length
    providers.push({
      providerId,
      cases: caseCount,
      fallbackCount,
      fallbackKinds,
      meanLatencyMs: Number((latencySum / caseCount).toFixed(3)),
      agreementWithBaseline: Number((agreement / caseCount).toFixed(4)),
      ...(evolutionCases ? { expectedEvolutionCases: evolutionCases, expectedEvolutionActionAccuracy: Number((evolutionActions / evolutionCases).toFixed(4)) } : {}),
      ...(evolutionSignalCases ? { expectedEvolutionSignalExactMatch: Number((evolutionSignals / evolutionSignalCases).toFixed(4)) } : {}),
      ...(top1Comparable > 0
        ? {
            top1AgreementWithBaseline: Number(
              (top1Agreement / top1Comparable).toFixed(4),
            ),
          }
        : {}),
      ...(overlapComparable > 0
        ? {
            meanRankedOverlapWithBaseline: Number(
              (overlapSum / overlapComparable).toFixed(4),
            ),
          }
        : {}),
      ...(expectedCaseCount > 0
        ? {
            expectedCaseCount,
            top1ExpectedAccuracy: Number(
              (top1Expected / expectedCaseCount).toFixed(4),
            ),
            meanExpectedReciprocalRank: Number(
              (reciprocalRankSum / expectedCaseCount).toFixed(4),
            ),
            meanExpectedRecall: Number(
              (expectedRecallSum / expectedCaseCount).toFixed(4),
            ),
          }
        : {}),
    })
  }

  const createdAt = new Date().toISOString()
  const evalId = `algo-compare-${dataset.surfaceId}-${timestampSlug(new Date(createdAt))}`
  const comparison: MatOSAlgorithmComparison = {
    schemaVersion: 1,
    evalId,
    surfaceId: dataset.surfaceId,
    createdAt,
    dataset: {
      path: relative(options.cwd, options.datasetPath) || options.datasetPath,
      sha256,
      caseCount: dataset.cases.length,
    },
    baselineProviderId: MATOS_ALGORITHM_BASELINE_PROVIDER_ID,
    providers,
  }
  await mkdir(evaluationsDir(options.cwd), { recursive: true })
  const recordPath = join(evaluationsDir(options.cwd), `${evalId}.json`)
  await writeFile(
    recordPath,
    `${JSON.stringify(comparison, null, 2)}\n`,
    'utf8',
  )
  return { comparison, recordPath }
}

function metricsTable(comparison: MatOSAlgorithmComparison): string {
  const lines = [
    '| provider | cases | agreement | baseline top1 | overlap | labelled | expected top1 | expected MRR | expected recall | fallbacks | mean latency (ms) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const provider of comparison.providers) {
    lines.push(
      `| ${provider.providerId} | ${provider.cases} | ${provider.agreementWithBaseline} | ${
        provider.top1AgreementWithBaseline ?? '-'
      } | ${provider.meanRankedOverlapWithBaseline ?? '-'} | ${provider.expectedCaseCount ?? '-'} | ${
        provider.top1ExpectedAccuracy ?? '-'
      } | ${provider.meanExpectedReciprocalRank ?? '-'} | ${provider.meanExpectedRecall ?? '-'} | ${provider.fallbackCount} | ${provider.meanLatencyMs} |`,
    )
  }
  if (comparison.surfaceId === 'evolution-policy') {
    lines.push('', '| provider | labelled evolution cases | expected action accuracy | expected signal exact match |', '| --- | --- | --- | --- |')
    for (const provider of comparison.providers) lines.push(`| ${provider.providerId} | ${provider.expectedEvolutionCases ?? 0} | ${provider.expectedEvolutionActionAccuracy ?? '-'} | ${provider.expectedEvolutionSignalExactMatch ?? '-'} |`)
    lines.push('', 'Offline labelled decision agreement is not evidence of production behavioral improvement.')
  }
  return lines.join('\n')
}

/**
 * Writes the comparison as a draft `evaluation` asset under the project
 * `.matos/assets` root so the result is discoverable, validatable, and
 * promotable through normal asset governance.
 */
export async function writeMatOSAlgorithmEvaluationAsset(options: {
  cwd: string
  comparison: MatOSAlgorithmComparison
}): Promise<{ assetDir: string; canonicalKey: string }> {
  const { comparison } = options
  const assetDir = join(
    getMatOSDir(options.cwd),
    'assets',
    'algorithm-evaluations',
    comparison.evalId,
  )
  await mkdir(assetDir, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    id: comparison.evalId,
    type: 'evaluation',
    name: `Algorithm comparison: ${comparison.surfaceId}`,
    version: '0.1.0',
    description: `Offline replay comparison of Algorithm Layer providers on surface ${comparison.surfaceId} (${comparison.dataset.caseCount} captured cases).`,
    entry: 'EVALUATION.md',
    tags: ['generated', 'algorithm-layer', 'evaluation', comparison.surfaceId],
    lifecycle: { status: 'draft' },
    metadata: {
      kind: 'evaluation',
      group: 'algorithm-layer',
      surfaceId: comparison.surfaceId,
      baselineProviderId: comparison.baselineProviderId,
      providers: comparison.providers.map(provider => provider.providerId),
      dataset: comparison.dataset,
      metrics: comparison.providers,
      method:
        'Replay frozen captured decision inputs through each provider on the same surface and compare decisions, fallbacks, and latency against the baseline provider.',
      passCriteria:
        'Informational comparison record; promotion decisions require human review of the metrics.',
      requiresRealProvider: false,
    },
  }
  const evaluationMd = [
    `# Algorithm comparison: ${comparison.surfaceId}`,
    '',
    `- Eval id: ${comparison.evalId}`,
    `- Created: ${comparison.createdAt}`,
    `- Dataset: ${comparison.dataset.path} (${comparison.dataset.caseCount} cases, sha256 ${comparison.dataset.sha256.slice(0, 12)}…)`,
    `- Baseline provider: ${comparison.baselineProviderId}`,
    '',
    '## Metrics',
    '',
    metricsTable(comparison),
    '',
    'Agreement/baseline top1/overlap compare each provider against the baseline decision on identical inputs. Expected top1, MRR, and recall are computed only for cases with human-curated rankedAssetKeys labels. Fallbacks count replays where the provider failed and the surface returned the baseline decision instead.',
    '',
  ].join('\n')
  await writeFile(
    join(assetDir, 'asset.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(assetDir, 'EVALUATION.md'), evaluationMd, 'utf8')
  await writeFile(
    join(assetDir, 'results.json'),
    `${JSON.stringify(comparison, null, 2)}\n`,
    'utf8',
  )
  return {
    assetDir,
    canonicalKey: `evaluation:${comparison.evalId}@0.1.0`,
  }
}
