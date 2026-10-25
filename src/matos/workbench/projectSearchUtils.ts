import { redactMatOSWorkbenchValue } from './redaction.js'
import type {
MatOSWorkbenchSearchRanking
} from './types.js'

export function normalizedSearchText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function normalizedSearchTokens(query: string): string[] {
  const normalized = normalizedSearchText(query)
  if (!normalized) {
    return []
  }
  return Array.from(
    new Set(
      normalized
        .split(/[\s,;|/\\()[\]{}"']+/)
        .map(token => token.trim())
        .filter(Boolean),
    ),
  )
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(item => stringValue(item))
        .filter((item): item is string => Boolean(item))
    : []
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

export function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function redactWorkbenchValue(value: unknown): unknown {
  return redactMatOSWorkbenchValue(value).value
}

export function boolValue(value: unknown): boolean {
  return value === true || value === 'true' || value === '1'
}

type SearchScoringField = {
  field: string
  value?: string
  exact: number
  prefix: number
  contains: number
  token?: number
}

export function searchRankingForFields(input: {
  query: string
  fields: SearchScoringField[]
  rank?: number
}): MatOSWorkbenchSearchRanking {
  const normalizedQuery = normalizedSearchText(input.query)
  const tokens = normalizedSearchTokens(input.query)
  if (!normalizedQuery) {
    return {
      query: '',
      rank: input.rank ?? 0,
      score: 0,
      matched: true,
      tokens: [],
      reasons: [
        {
          field: 'query',
          kind: 'unfiltered',
          score: 0,
          value: '',
        },
      ],
    }
  }
  const reasons: MatOSWorkbenchSearchRanking['reasons'] = []
  let score = 0
  for (const field of input.fields) {
    const value = stringValue(field.value)
    if (!value) {
      continue
    }
    const normalizedValue = normalizedSearchText(value)
    if (!normalizedValue) {
      continue
    }
    if (normalizedValue === normalizedQuery) {
      score += field.exact
      reasons.push({ field: field.field, kind: 'exact', score: field.exact, value })
      continue
    }
    if (normalizedValue.startsWith(normalizedQuery)) {
      score += field.prefix
      reasons.push({ field: field.field, kind: 'prefix', score: field.prefix, value })
      continue
    }
    if (normalizedValue.includes(normalizedQuery)) {
      score += field.contains
      reasons.push({ field: field.field, kind: 'contains', score: field.contains, value })
    }
    for (const token of tokens) {
      if (token !== normalizedQuery && normalizedValue.includes(token)) {
        const tokenScore = field.token ?? Math.max(1, Math.floor(field.contains / 3))
        score += tokenScore
        reasons.push({ field: field.field, kind: 'token', score: tokenScore, value })
        break
      }
    }
  }
  reasons.sort((left, right) =>
    right.score - left.score ||
    left.field.localeCompare(right.field) ||
    String(left.value || '').localeCompare(String(right.value || '')),
  )
  return {
    query: normalizedQuery,
    rank: input.rank ?? 0,
    score,
    matched: score > 0,
    tokens,
    reasons: reasons.slice(0, 8),
  }
}

export function searchRankingSummary(rankings: MatOSWorkbenchSearchRanking[]) {
  return {
    mode: 'native-search-ranking' as const,
    explain: true as const,
    topScore: rankings.reduce((top, ranking) => Math.max(top, ranking.score), 0),
    scoredCount: rankings.filter(ranking => ranking.score > 0).length,
  }
}
