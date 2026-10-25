import type { ValidationResult } from '../types.js'

const VALIDATION_RECOMMENDATIONS = new Set<ValidationResult['recommendation']>([
  'continue',
  'retry',
  'reroute',
  'human_review',
  'fail',
])

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

export function validationResultFromGuardOutput(
  output: Record<string, unknown>,
): ValidationResult {
  const checks = Array.isArray(output.checks) ? output.checks : []
  const normalizedChecks = checks.map((check, index) => {
    const item = metadataObject(check)
    const type = optionalString(item.type) ?? 'unknown'
    return {
      id: optionalString(item.id) ?? `${type}_${index + 1}`,
      type,
      ok: item.ok === true,
      ...(item.observed !== undefined ? { observed: item.observed } : {}),
      ...(item.expected !== undefined ? { expected: item.expected } : {}),
      ...(Array.isArray(item.evidence) ? { evidence: item.evidence } : {}),
      ...(optionalString(item.error) ? { error: optionalString(item.error) } : {}),
      ...(optionalString(item.code) ? { code: optionalString(item.code) } : {}),
      ...(optionalString(item.message)
        ? { message: optionalString(item.message) }
        : {}),
      ...(optionalString(item.hint) ? { hint: optionalString(item.hint) } : {}),
      ...(typeof item.retryable === 'boolean'
        ? { retryable: item.retryable }
        : {}),
      ...(optionalString(item.sourceNodeId)
        ? { sourceNodeId: optionalString(item.sourceNodeId) }
        : {}),
    }
  })
  const ok =
    output.ok === true &&
    normalizedChecks.every(check => check.ok)
  const rawRecommendation = optionalString(output.recommendation)
  const recommendation =
    ok
      ? 'continue'
      : rawRecommendation &&
          VALIDATION_RECOMMENDATIONS.has(
            rawRecommendation as ValidationResult['recommendation'],
          )
        ? (rawRecommendation as ValidationResult['recommendation'])
        : 'fail'
  const severity = optionalString(output.severity)

  return {
    ok,
    severity:
      severity === 'info' || severity === 'warning' || severity === 'error'
        ? severity
        : ok
          ? 'info'
          : 'error',
    recommendation,
    checks: normalizedChecks,
  }
}
