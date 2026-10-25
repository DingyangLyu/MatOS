import { afterEach, describe, expect, test } from 'bun:test'
import {
  nodeApprovalDecision,
  nodeApprovalRequired,
} from '../workflows/nodeLifecycle.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
} from '../workflows/types.js'
import { clearMatOSAlgorithmDecisionLog } from './telemetry.js'
import { matOSApprovalPolicySurface } from './surfaces/approvalPolicy.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  clearMatOSAlgorithmDecisionLog()
})

function definitionWith(
  approvalMode: 'bypass' | 'ask' | 'strict',
  compiled?: Record<string, unknown>,
): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'approval policy surface test',
    parameters: {},
    policy: { approvalMode, defaultRisk: 'low' },
    outputs: {},
    nodes: [],
    ...(compiled ? { compiled } : {}),
  }
}

// Mirrors the approval matrix in workflowRuntime.test.ts, including protected
// HPC submit/cancel operations, dry-run exceptions, and reviewed bypass.
const approvalMatrix: Array<{
  definition: MatOSWorkflowDefinition
  node: MatOSWorkflowNode
}> = [
  {
    definition: definitionWith('bypass'),
    node: {
      id: 'submit',
      type: 'backend',
      dependsOn: [],
      backend: 'hpc-queue',
      operation: 'submit',
      policy: { approval: 'bypass' },
    },
  },
  {
    definition: definitionWith('bypass'),
    node: {
      id: 'cancel',
      type: 'backend',
      dependsOn: [],
      backend: 'hpc-queue',
      tool: 'tool:hpc-cancel',
      policy: { approval: 'bypass' },
    },
  },
  {
    definition: definitionWith('bypass'),
    node: {
      id: 'status',
      type: 'backend',
      dependsOn: [],
      backend: 'hpc-queue',
      operation: 'status',
      policy: { approval: 'bypass' },
    },
  },
  {
    definition: definitionWith('bypass'),
    node: {
      id: 'submit-inputs-dry-run',
      type: 'backend',
      dependsOn: [],
      backend: 'hpc-queue',
      operation: 'submit',
      inputs: { dryRun: true },
      policy: { approval: 'bypass' },
    },
  },
  {
    definition: definitionWith('bypass', {
      reviewedHighRiskBypassTrusted: true,
    }),
    node: {
      id: 'reviewed-submit',
      type: 'backend',
      dependsOn: [],
      backend: 'hpc-queue',
      operation: 'submit',
      policy: { approval: 'bypass', reviewedHighRiskBypass: true },
    },
  },
  {
    definition: definitionWith('ask'),
    node: { id: 'plain-exec', type: 'exec', dependsOn: [] },
  },
  {
    definition: definitionWith('strict'),
    node: { id: 'plain-agent', type: 'agent', dependsOn: [] },
  },
  {
    definition: definitionWith('ask'),
    node: {
      id: 'bypass-node',
      type: 'exec',
      dependsOn: [],
      policy: { approval: 'bypass' },
    },
  },
  {
    definition: definitionWith('bypass'),
    node: {
      id: 'require-node',
      type: 'exec',
      dependsOn: [],
      policy: { approval: 'require' },
    },
  },
]

describe('approval-policy surface', () => {
  test('golden: nodeApprovalDecision equals nodeApprovalRequired with no overrides', () => {
    delete process.env.MATOS_ALGO_APPROVAL_POLICY
    for (const item of approvalMatrix) {
      expect(nodeApprovalDecision(item.definition, item.node)).toBe(
        nodeApprovalRequired(item.definition, item.node),
      )
    }
  })

  test('custom strategy can only tighten: baseline-required approvals stay required', () => {
    matOSApprovalPolicySurface.register({
      id: 'test-approve-everything',
      decide: () => ({ requireApproval: false, reason: 'yolo strategy' }),
    })
    process.env.MATOS_ALGO_APPROVAL_POLICY = 'test-approve-everything'
    for (const item of approvalMatrix) {
      const baseline = nodeApprovalRequired(item.definition, item.node)
      const decided = nodeApprovalDecision(item.definition, item.node)
      if (baseline) {
        expect(decided).toBe(true)
      }
    }
  })

  test('custom strategy can tighten approval beyond the baseline', () => {
    matOSApprovalPolicySurface.register({
      id: 'test-require-everything',
      decide: () => ({ requireApproval: true, reason: 'paranoid strategy' }),
    })
    process.env.MATOS_ALGO_APPROVAL_POLICY = 'test-require-everything'
    const definition = definitionWith('bypass')
    const node: MatOSWorkflowNode = {
      id: 'harmless-exec',
      type: 'exec',
      dependsOn: [],
    }
    expect(nodeApprovalRequired(definition, node)).toBe(false)
    expect(nodeApprovalDecision(definition, node)).toBe(true)
  })

  test('fail-closed: strategy errors fall back to the baseline verdict', () => {
    matOSApprovalPolicySurface.register({
      id: 'test-crashing-policy',
      decide: () => {
        throw new Error('policy crashed')
      },
    })
    process.env.MATOS_ALGO_APPROVAL_POLICY = 'test-crashing-policy'
    for (const item of approvalMatrix) {
      expect(nodeApprovalDecision(item.definition, item.node)).toBe(
        nodeApprovalRequired(item.definition, item.node),
      )
    }
  })
})
