import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  rankMatOSAssets,
  type MatOSAssetRankExplanation,
} from '../../assets/graph/relevance.js'
import type { MatOSAssetGraphIndex } from '../../assets/graph/types.js'
import type { MatOSAsset } from '../../assets/types.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

/**
 * S1 context-ranking: orders candidate knowledge/experience assets for role
 * runtime context injection.
 *
 * Candidate filtering, scope checks, budget capping, and redaction stay in the
 * calling context providers; strategies only reorder within the candidate set.
 */

export type MatOSContextRankingInput = {
  kind: 'knowledge' | 'experience'
  /** Candidate-only graph index prebuilt by the calling context provider. */
  index: MatOSAssetGraphIndex
  query: string
  assetTypes: string[]
  limit: number
  candidateKeys: string[]
  role?: MatOSAsset
  allowedTools?: string[]
  env?: Record<string, string | undefined>
  providerOverrides?: MatOSAlgorithmProviderOverrides
  /** Project cwd for telemetry/capture ledgers. */
  cwd?: string
}

export type MatOSContextRankingDecision = {
  ranked: Array<{ assetKey: string; score?: number }>
}

function baselineContextRanking(
  input: MatOSContextRankingInput,
): MatOSContextRankingDecision {
  const hits = rankMatOSAssets({
    index: input.index,
    query: input.query,
    assetTypes: input.assetTypes,
    limit: input.limit,
  })
  return {
    ranked: hits.map(hit => ({ assetKey: hit.assetKey, score: hit.score })),
  }
}

function sanitizeContextRanking(
  decision: MatOSContextRankingDecision,
  input: MatOSContextRankingInput,
): MatOSContextRankingDecision {
  const candidates = new Set(input.candidateKeys)
  const seen = new Set<string>()
  const ranked: MatOSContextRankingDecision['ranked'] = []
  for (const hit of Array.isArray(decision.ranked) ? decision.ranked : []) {
    if (!hit || typeof hit.assetKey !== 'string') {
      continue
    }
    // Strategies cannot introduce assets outside the pre-filtered candidate
    // set: candidate filtering is a scope/lifecycle boundary, not a ranking
    // preference.
    if (!candidates.has(hit.assetKey) || seen.has(hit.assetKey)) {
      continue
    }
    seen.add(hit.assetKey)
    ranked.push({
      assetKey: hit.assetKey,
      ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
    })
    if (ranked.length >= input.limit) {
      break
    }
  }
  return { ranked }
}

type ContextRankingWeights = {
  multipliers: Partial<Record<MatOSAssetRankExplanation['kind'], number>>
}

/**
 * Parses MATOS_ALGO_CONTEXT_RANKING_CONFIG: either inline JSON or `@<path>`
 * to a JSON file. Shape: `{"multipliers": {"lexical": 2, "usage": 0, ...}}`.
 * Returns undefined for missing/invalid config, which makes the configurable
 * provider abstain (surface falls back to baseline with `empty-decision`).
 */
function contextRankingWeights(
  env: Record<string, string | undefined>,
): ContextRankingWeights | undefined {
  const raw = (
    env.MATOS_ALGO_CONTEXT_RANKING_CONFIG ??
    process.env.MATOS_ALGO_CONTEXT_RANKING_CONFIG ??
    ''
  ).trim()
  if (!raw) {
    return undefined
  }
  try {
    const text = raw.startsWith('@')
      ? readFileSync(raw.slice(1), 'utf8')
      : raw
    const parsed = JSON.parse(text) as Record<string, unknown>
    const multipliersRaw = parsed?.multipliers
    if (
      !multipliersRaw ||
      typeof multipliersRaw !== 'object' ||
      Array.isArray(multipliersRaw)
    ) {
      return undefined
    }
    const multipliers: ContextRankingWeights['multipliers'] = {}
    for (const [kind, value] of Object.entries(multipliersRaw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        multipliers[kind as MatOSAssetRankExplanation['kind']] = value
      }
    }
    return Object.keys(multipliers).length > 0 ? { multipliers } : undefined
  } catch {
    return undefined
  }
}

/**
 * Config-only ablation provider: reruns the native ranker, then reweights
 * each hit's explanation scores with configured per-signal multipliers and
 * reorders. No custom code required; select with
 * MATOS_ALGO_CONTEXT_RANKING=baseline-configurable plus
 * MATOS_ALGO_CONTEXT_RANKING_CONFIG.
 */
function configurableContextRanking(
  input: MatOSContextRankingInput,
): MatOSContextRankingDecision | undefined {
  const weights = contextRankingWeights(input.env ?? process.env)
  if (!weights) {
    return undefined
  }
  const hits = rankMatOSAssets({
    index: input.index,
    query: input.query,
    assetTypes: input.assetTypes,
  })
  const reweighted = hits
    .map(hit => ({
      assetKey: hit.assetKey,
      score: Number(
        hit.explanations
          .reduce(
            (sum, explanation) =>
              sum +
              explanation.score * (weights.multipliers[explanation.kind] ?? 1),
            0,
          )
          .toFixed(6),
      ),
    }))
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.assetKey.localeCompare(b.assetKey))
    .slice(0, input.limit)
  return { ranked: reweighted }
}

export const matOSContextRankingSurface = createMatOSAlgorithmSurface<
  MatOSContextRankingInput,
  MatOSContextRankingDecision
>({
  surfaceId: 'context-ranking',
  envVar: 'MATOS_ALGO_CONTEXT_RANKING',
  baseline: {
    description:
      'Ranks candidates with the native graph relevance ranker (rankMatOSAssets).',
    decide: baselineContextRanking,
  },
  sanitizeDecision: sanitizeContextRanking,
  inputDigest: input =>
    createHash('sha256')
      .update(input.kind)
      .update('\u0000')
      .update(input.query)
      .update('\u0000')
      .update([...input.candidateKeys].sort().join(','))
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    kind: input.kind,
    candidateCount: input.candidateKeys.length,
    rankedCount: decision.ranked.length,
    ...(decision.ranked[0] ? { topAssetKey: decision.ranked[0].assetKey } : {}),
  }),
})

matOSContextRankingSurface.register({
  id: 'baseline-configurable',
  description:
    'Native ranker with per-signal weight multipliers from MATOS_ALGO_CONTEXT_RANKING_CONFIG (config-only ablation).',
  configDigestFor: ({ env }) =>
    createHash('sha256')
      .update(
        JSON.stringify(contextRankingWeights(env) ?? null),
      )
      .digest('hex'),
  decide: configurableContextRanking,
})

function roleAlgorithms(role: MatOSAsset | undefined): unknown {
  const value = role?.runtime.algorithms
  return value && typeof value === 'object' ? value : undefined
}

export function decideMatOSContextRanking(
  input: MatOSContextRankingInput,
): MatOSAlgorithmDecisionOutcome<MatOSContextRankingDecision> {
  return matOSContextRankingSurface.decideSync(input, {
    env: input.env,
    roleAlgorithms: roleAlgorithms(input.role),
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  })
}
