import { createHash } from 'node:crypto'
import type {
  WorkflowRecoveryRecommendedAction,
  WorkflowRecoveryReport,
} from '../../workflows/recovery.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

export type MatOSRecoveryPolicyInput = {
  report: WorkflowRecoveryReport
  candidateActions: WorkflowRecoveryRecommendedAction[]
  env?: Record<string, string | undefined>
  roleAlgorithms?: unknown
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
}

export type MatOSRecoveryPolicyDecision = {
  action: WorkflowRecoveryRecommendedAction
  reason?: string
}

export const matOSRecoveryPolicySurface = createMatOSAlgorithmSurface<
  MatOSRecoveryPolicyInput,
  MatOSRecoveryPolicyDecision
>({
  surfaceId: 'recovery-policy',
  envVar: 'MATOS_ALGO_RECOVERY_POLICY',
  baseline: {
    description: 'Uses the native workflow recovery recommendation unchanged.',
    decide: input => ({ action: input.report.recommendedAction }),
  },
  sanitizeDecision: (decision, input) => {
    const allowed = new Set([
      input.report.recommendedAction,
      ...input.candidateActions,
    ])
    const action = allowed.has(decision.action)
      ? decision.action
      : input.report.recommendedAction
    return {
      action,
      ...(typeof decision.reason === 'string' && decision.reason.trim()
        ? { reason: decision.reason.trim() }
        : {}),
    }
  },
  inputDigest: input =>
    createHash('sha256')
      .update(input.report.classification)
      .update('\u0000')
      .update(input.report.recommendedAction)
      .update('\u0000')
      .update([...input.candidateActions].sort().join(','))
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    classification: input.report.classification,
    baselineAction: input.report.recommendedAction,
    action: decision.action,
    changed: decision.action !== input.report.recommendedAction,
  }),
})

matOSRecoveryPolicySurface.register({
  id: 'safety-first',
  description:
    'Prefers human review or waiting over replay when the native classification is uncertain or side-effect sensitive.',
  decide: input => {
    const candidates = new Set(input.candidateActions)
    const sensitive = [
      'unknown_failure',
      'dynamic_graph_patch_failure',
      'backend_failure',
      'compute_reconcile_failure',
      'compute_cancel_failure',
    ].includes(input.report.classification)
    if (sensitive && candidates.has('request_human_review')) {
      return { action: 'request_human_review', reason: 'safety-first' }
    }
    if (sensitive && candidates.has('wait')) {
      return { action: 'wait', reason: 'safety-first' }
    }
    return { action: input.report.recommendedAction }
  },
})

export async function decideMatOSRecoveryPolicy(
  input: MatOSRecoveryPolicyInput,
): Promise<MatOSAlgorithmDecisionOutcome<MatOSRecoveryPolicyDecision>> {
  return matOSRecoveryPolicySurface.decide(input, {
    env: input.env,
    roleAlgorithms: input.roleAlgorithms,
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    workflowRunId: input.report.runId,
    ...(input.report.nodeId ? { workflowNodeId: input.report.nodeId } : {}),
  })
}
