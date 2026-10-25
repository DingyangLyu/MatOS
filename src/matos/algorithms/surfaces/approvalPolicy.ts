import { createHash } from 'node:crypto'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
} from '../../workflows/types.js'
import {
  createMatOSAlgorithmSurface,
  type MatOSAlgorithmDecisionOutcome,
  type MatOSAlgorithmProviderOverrides,
} from '../surface.js'

/**
 * S2 approval-policy: decides whether a workflow node requires human approval.
 *
 * The baseline verdict is computed by the existing `nodeApprovalRequired`
 * (including the protected remote-operation check) and passed in as data.
 * Custom strategies may only TIGHTEN approval; the sanitize clamp guarantees
 * `requireApproval` can never become false when the baseline requires it.
 */

export type MatOSApprovalPolicyInput = {
  /** Verdict from the existing nodeApprovalRequired logic. */
  baselineDecision: boolean
  definition: MatOSWorkflowDefinition
  node: MatOSWorkflowNode
  env?: Record<string, string | undefined>
  providerOverrides?: MatOSAlgorithmProviderOverrides
}

export type MatOSApprovalPolicyDecision = {
  requireApproval: boolean
  reason?: string
}

function sanitizeApprovalPolicy(
  decision: MatOSApprovalPolicyDecision,
  input: MatOSApprovalPolicyInput,
): MatOSApprovalPolicyDecision {
  return {
    // Only-tighten invariant: strategies can add approval requirements but can
    // never approve something the baseline gates (protected remote operations,
    // strict approvalMode, explicit node-level approval policy).
    requireApproval:
      input.baselineDecision || decision.requireApproval === true,
    ...(typeof decision.reason === 'string' && decision.reason.trim()
      ? { reason: decision.reason.trim() }
      : {}),
  }
}

export const matOSApprovalPolicySurface = createMatOSAlgorithmSurface<
  MatOSApprovalPolicyInput,
  MatOSApprovalPolicyDecision
>({
  surfaceId: 'approval-policy',
  envVar: 'MATOS_ALGO_APPROVAL_POLICY',
  baseline: {
    description:
      'Passes through the native nodeApprovalRequired verdict unchanged.',
    decide: input => ({ requireApproval: input.baselineDecision }),
  },
  sanitizeDecision: sanitizeApprovalPolicy,
  inputDigest: input =>
    createHash('sha256')
      .update(
        JSON.stringify({
          workflow: input.definition.name,
          approvalMode: input.definition.policy?.approvalMode,
          nodeId: input.node.id,
          nodeType: input.node.type,
          nodePolicy: input.node.policy,
          baselineDecision: input.baselineDecision,
        }),
      )
      .digest('hex')
      .slice(0, 16),
  decisionSummary: (decision, input) => ({
    nodeId: input.node.id,
    nodeType: input.node.type,
    baselineDecision: input.baselineDecision,
    requireApproval: decision.requireApproval,
    ...(decision.reason ? { reason: decision.reason } : {}),
  }),
})

export function decideMatOSApprovalPolicy(
  input: MatOSApprovalPolicyInput,
): MatOSAlgorithmDecisionOutcome<MatOSApprovalPolicyDecision> {
  return matOSApprovalPolicySurface.decideSync(input, {
    env: input.env,
    providerOverrides: input.providerOverrides,
  })
}
