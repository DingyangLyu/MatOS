import type {
  MatOSWorkflowGuardCheck,
  MatOSWorkflowNode,
  ValidationResult,
} from '../types.js'
import { evaluateWorkflowValidationChecks } from '../validationEngine.js'
import { WorkflowValidationFailureError } from '../validationFailure.js'
import type { WorkflowExpressionContext } from '../workflowExpressions.js'

const VALIDATION_RECOMMENDATIONS = new Set<ValidationResult['recommendation']>([
  'continue',
  'retry',
  'reroute',
  'human_review',
  'fail',
])

function explicitFailureRecommendation(
  node: MatOSWorkflowNode,
): ValidationResult['recommendation'] | undefined {
  const recommendation = node.recommendation
  return typeof recommendation === 'string' &&
    VALIDATION_RECOMMENDATIONS.has(recommendation as ValidationResult['recommendation'])
    ? (recommendation as ValidationResult['recommendation'])
    : undefined
}

export async function runWorkflowGuardNode(
  node: MatOSWorkflowNode,
  options: {
    workspaceDir: string
    throwOnFailure?: boolean
    expressionContext?: WorkflowExpressionContext
    algorithm?: {
      candidateChecks?: MatOSWorkflowGuardCheck[]
      maxAdditionalChecks?: number
      roleAlgorithms?: unknown
      cwd?: string
      workflowRunId?: string
      workflowNodeId?: string
      attempt?: number
    }
  },
): Promise<{ output: Record<string, unknown> }> {
  const throwOnFailure = options.throwOnFailure ?? true
  const checks = Array.isArray(node.checks)
    ? (node.checks as MatOSWorkflowGuardCheck[])
    : []
  const validation = await evaluateWorkflowValidationChecks(checks, {
    workspaceDir: options.workspaceDir,
    expressionContext: options.expressionContext,
    algorithm: options.algorithm,
  })

  const failed = validation.checks.filter(result => !result.ok)
  if (throwOnFailure && failed.length > 0) {
    throw new WorkflowValidationFailureError(node.id, validation)
  }

  if (node.targetType !== 'validate') {
    return { output: { ok: validation.ok, checks: validation.checks } }
  }

  const recommendation = validation.ok
    ? 'continue'
    : explicitFailureRecommendation(node) ?? validation.recommendation

  return {
    output: {
      ok: validation.ok,
      severity: validation.severity,
      recommendation,
      checks: validation.checks,
    },
  }
}
