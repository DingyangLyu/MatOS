import { createHash } from 'node:crypto'
import type { MatOSWorkflowGuardCheck } from '../../workflows/types.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

export type MatOSVerificationPolicyInput = {
  requiredChecks: MatOSWorkflowGuardCheck[]
  candidateChecks?: MatOSWorkflowGuardCheck[]
  maxAdditionalChecks?: number
  env?: Record<string, string | undefined>
  roleAlgorithms?: unknown
  providerOverrides?: MatOSAlgorithmProviderOverrides
  cwd?: string
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
}

export type MatOSVerificationPolicyDecision = {
  checks: MatOSWorkflowGuardCheck[]
}

function checkKey(check: MatOSWorkflowGuardCheck): string {
  if (typeof check.id === 'string' && check.id.trim()) return `id:${check.id}`
  return createHash('sha256').update(JSON.stringify(check)).digest('hex')
}

export const matOSVerificationPolicySurface = createMatOSAlgorithmSurface<
  MatOSVerificationPolicyInput,
  MatOSVerificationPolicyDecision
>({
  surfaceId: 'verification-policy',
  envVar: 'MATOS_ALGO_VERIFICATION_POLICY',
  baseline: {
    description: 'Runs the workflow required checks in their original order.',
    decide: input => ({ checks: [...input.requiredChecks] }),
  },
  sanitizeDecision: (decision, input) => {
    const requiredKeys = new Set(input.requiredChecks.map(checkKey))
    const candidates = new Map(
      (input.candidateChecks ?? []).map(check => [checkKey(check), check]),
    )
    const checks = [...input.requiredChecks]
    const maxAdditional = Math.max(0, input.maxAdditionalChecks ?? candidates.size)
    for (const proposed of Array.isArray(decision.checks) ? decision.checks : []) {
      const key = checkKey(proposed)
      if (requiredKeys.has(key)) continue
      const candidate = candidates.get(key)
      if (!candidate || checks.length >= input.requiredChecks.length + maxAdditional) {
        continue
      }
      checks.push(candidate)
      requiredKeys.add(key)
    }
    return { checks }
  },
  inputDigest: input =>
    createHash('sha256')
      .update(input.requiredChecks.map(checkKey).join(','))
      .update('\u0000')
      .update((input.candidateChecks ?? []).map(checkKey).sort().join(','))
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    requiredCount: input.requiredChecks.length,
    selectedCount: decision.checks.length,
    addedCount: Math.max(0, decision.checks.length - input.requiredChecks.length),
  }),
})

matOSVerificationPolicySurface.register({
  id: 'all-candidates',
  description:
    'Runs all authorized optional checks in addition to every required check.',
  decide: input => ({
    checks: [...input.requiredChecks, ...(input.candidateChecks ?? [])],
  }),
})

export function decideMatOSVerificationPolicy(
  input: MatOSVerificationPolicyInput,
): MatOSAlgorithmDecisionOutcome<MatOSVerificationPolicyDecision> {
  return matOSVerificationPolicySurface.decideSync(input, {
    env: input.env,
    roleAlgorithms: input.roleAlgorithms,
    providerOverrides: input.providerOverrides,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  })
}
