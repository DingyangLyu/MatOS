import { createHash } from 'node:crypto'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

export type MatOSContinuationAction =
  | 'continue'
  | 'retry'
  | 'recover'
  | 'reroute'
  | 'pause'
  | 'request-human'
  | 'fail'
  | 'stop'

export type MatOSContinuationPolicyInput = {
  baselineAction: MatOSContinuationAction
  candidateActions: MatOSContinuationAction[]
  requiredValidationPassed: boolean
  budgetExceeded?: boolean
  replaySafe?: boolean
  reason?: string
  env?: Record<string, string | undefined>
  roleAlgorithms?: unknown
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
}

export type MatOSContinuationPolicyDecision = {
  action: MatOSContinuationAction
  reason?: string
}

function allowedActions(input: MatOSContinuationPolicyInput): Set<string> {
  const allowed = new Set(input.candidateActions)
  allowed.add(input.baselineAction)
  if (!input.requiredValidationPassed) allowed.delete('continue')
  if (input.budgetExceeded) {
    for (const action of [...allowed]) {
      if (!['pause', 'fail', 'stop', 'request-human'].includes(action)) {
        allowed.delete(action)
      }
    }
  }
  if (input.replaySafe === false) {
    allowed.delete('retry')
    allowed.delete('recover')
  }
  return allowed
}

function baseline(input: MatOSContinuationPolicyInput): MatOSContinuationPolicyDecision {
  return { action: input.baselineAction }
}

export const matOSContinuationPolicySurface = createMatOSAlgorithmSurface<
  MatOSContinuationPolicyInput,
  MatOSContinuationPolicyDecision
>({
  surfaceId: 'continuation-policy',
  envVar: 'MATOS_ALGO_CONTINUATION_POLICY',
  baseline: {
    description: 'Preserves the native workflow continuation action exactly.',
    decide: baseline,
  },
  sanitizeDecision: (decision, input) => {
    const action = allowedActions(input).has(decision.action)
      ? decision.action
      : input.baselineAction
    return {
      action,
      ...(typeof decision.reason === 'string' && decision.reason.trim()
        ? { reason: decision.reason.trim() }
        : {}),
    }
  },
  inputDigest: input =>
    createHash('sha256')
      .update(
        JSON.stringify({
          baselineAction: input.baselineAction,
          candidateActions: [...input.candidateActions].sort(),
          requiredValidationPassed: input.requiredValidationPassed,
          budgetExceeded: input.budgetExceeded === true,
          replaySafe: input.replaySafe !== false,
        }),
      )
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    baselineAction: input.baselineAction,
    action: decision.action,
    changed: decision.action !== input.baselineAction,
  }),
})

matOSContinuationPolicySurface.register({
  id: 'guarded',
  description:
    'Stops unsafe continuation when validation, budget, or replay constraints require a bounded action.',
  decide: input => {
    const allowed = allowedActions(input)
    if (input.budgetExceeded) {
      for (const action of ['pause', 'stop', 'fail', 'request-human'] as const) {
        if (allowed.has(action)) return { action, reason: 'budget-exceeded' }
      }
    }
    if (!input.requiredValidationPassed) {
      for (const action of ['retry', 'request-human', 'fail'] as const) {
        if (allowed.has(action)) return { action, reason: 'validation-failed' }
      }
    }
    if (input.replaySafe === false && allowed.has('request-human')) {
      return { action: 'request-human', reason: 'replay-unsafe' }
    }
    return { action: input.baselineAction }
  },
})

export async function decideMatOSContinuationPolicy(
  input: MatOSContinuationPolicyInput,
): Promise<MatOSAlgorithmDecisionOutcome<MatOSContinuationPolicyDecision>> {
  return matOSContinuationPolicySurface.decide(input, {
    env: input.env,
    roleAlgorithms: input.roleAlgorithms,
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  })
}
