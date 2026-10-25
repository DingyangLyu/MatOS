import type { ValidationResult } from './types.js'

function metadataObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sourceNodeId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized && normalized.length <= 200 ? normalized : undefined
}

/**
 * Extract explicit producer links from a persisted workflow failure.
 *
 * Validation nodes may fail because a completed producer wrote invalid data.
 * Keep this extractor deliberately narrow: only authored `sourceNodeId`
 * metadata is causal authority. General dependency ancestry remains useful
 * diagnostic context, but is not enough to invalidate a completed node.
 */
export function workflowFailureSourceNodeIds(error: unknown): string[] {
  const sources = new Set<string>()
  const records = [metadataObject(error)]
  const root = records[0]
  records.push(metadataObject(root?.details))

  for (const record of records) {
    if (!record) {
      continue
    }
    const direct = sourceNodeId(record.sourceNodeId)
    if (direct) {
      sources.add(direct)
    }
    const failedChecks = Array.isArray(record.failedChecks)
      ? record.failedChecks
      : []
    for (const check of failedChecks) {
      const source = sourceNodeId(metadataObject(check)?.sourceNodeId)
      if (source) {
        sources.add(source)
      }
    }
  }
  return [...sources]
}

/**
 * A validation failure that remains useful after JSON serialization.  The
 * workflow inspector and agent-facing tools receive the exact failed checks,
 * their observed values, and repair hints instead of a generic "guard failed"
 * string.
 */
export class WorkflowValidationFailureError extends Error {
  readonly code = 'workflow_validation_failed'
  readonly details: Record<string, unknown>

  constructor(
    nodeId: string,
    validation: ValidationResult,
    recommendation: ValidationResult['recommendation'] = validation.recommendation,
  ) {
    const failedChecks = validation.checks.filter(check => !check.ok)
    const summary = failedChecks
      .map(check => check.code ?? check.id ?? check.type)
      .join(', ')
    super(
      `Workflow validation failed at ${nodeId}${summary ? `: ${summary}` : ''}`,
    )
    this.name = 'WorkflowValidationFailureError'
    this.details = {
      nodeId,
      recommendation,
      severity: validation.severity,
      failedChecks,
      action:
        recommendation === 'retry'
          ? 'repair_and_retry_upstream'
          : recommendation === 'human_review'
            ? 'request_human_review'
            : 'repair_workflow_or_input',
    }
  }
}
