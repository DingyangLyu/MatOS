import { afterEach, describe, expect, test } from 'bun:test'
import {
  decideMatOSWorkflowOptimize,
  matOSWorkflowOptimizeSurface,
} from './surfaces/workflowOptimize.js'
import {
  clearMatOSAlgorithmDecisionLog,
  recentMatOSAlgorithmDecisions,
} from './telemetry.js'

afterEach(() => {
  clearMatOSAlgorithmDecisionLog()
})

describe('workflow-optimize surface', () => {
  test('golden: repair baseline matches the historical CLI directive', () => {
    const { decision, providerId } = decideMatOSWorkflowOptimize({
      intent: 'repair',
      runId: 'run-123',
      failedNodes: [
        { id: 'relax', status: 'failed', error: 'ENOSPC' },
        { id: 'report' },
      ],
      evidence: 'disk filled up',
      defaultRole: 'role:workflow-repair',
      env: {},
    })
    expect(providerId).toBe('baseline')
    expect(decision.role).toBe('role:workflow-repair')
    expect(decision.directive).toBe(
      [
        'Repair MatOS workflow run run-123.',
        'Steps:',
        '1. Inspect the failed run with workflow_inspect (runId run-123) and workflow_events to understand the failure.',
        '2. Decide the minimal reversible graph fix.',
        '3. Either propose a graph patch with workflow_patch_propose against this run, or fork it with workflow_fork_run, edit the draft with the workflow draft tools, validate, and publish.',
        '4. Validate the fix before claiming success and report the patch id or published workflow ref.',
        'Failed nodes: relax(failed): ENOSPC; report',
        'Additional evidence/context: disk filled up',
      ].join('\n'),
    )
  })

  test('golden: optimize baseline matches the historical CLI directive', () => {
    const { decision } = decideMatOSWorkflowOptimize({
      intent: 'optimize',
      workflowRef: 'workflow:qe-si-vc-relax-local',
      evidence: 'retry policy too aggressive',
      defaultRole: 'role:workflow-optimizer',
      env: {},
    })
    expect(decision.role).toBe('role:workflow-optimizer')
    expect(decision.directive).toBe(
      [
        'Optimize MatOS workflow workflow:qe-si-vc-relax-local.',
        'Steps:',
        '1. Load it with workflow_show (workflow:qe-si-vc-relax-local) and workflow_compile to review structure, contracts, risk, and budget.',
        '2. Identify improvements to preflight/validation guards, retry policy, compute resource/profile parameters, routing, and artifact checks.',
        '3. Fork or create a draft, apply the improvements with the workflow draft tools, and validate it.',
        '4. Publish the optimized draft and report the new asset ref plus a concise summary of the changes.',
        'Optimization evidence/query: retry policy too aggressive',
      ].join('\n'),
    )
  })

  test('golden: draft-from-task baseline keeps the planner steps', () => {
    const { decision } = decideMatOSWorkflowOptimize({
      intent: 'draft-from-task',
      task: 'Relax a structure with MACE',
      defaultRole: 'role:workflow-planner',
      env: {},
    })
    expect(decision.role).toBe('role:workflow-planner')
    expect(decision.directive.startsWith(
      'Build a MatOS workflow for this task: Relax a structure with MACE',
    )).toBe(true)
    expect(decision.directive).toContain('workflow_create_draft')
    expect(decision.directive).toContain('workflow_publish_draft')
  })

  test('telemetry hashes task and evidence instead of storing user text', () => {
    const secretTask = 'private unreleased catalyst composition'
    decideMatOSWorkflowOptimize({
      intent: 'draft-from-task',
      task: secretTask,
      evidence: 'confidential evidence',
      defaultRole: 'role:workflow-planner',
      env: {},
    })
    const digest = recentMatOSAlgorithmDecisions(1)[0]?.inputDigest
    expect(digest).toMatch(/^[a-f0-9]{16}$/)
    expect(digest).not.toContain(secretTask)
    expect(digest).not.toContain('confidential')
  })

  test('custom strategy can reroute role and directive; empty fields fall back', () => {
    matOSWorkflowOptimizeSurface.register({
      id: 'test-reroute',
      decide: input => ({
        role: 'role:custom-repairer',
        directive: `Custom repair plan for ${input.runId}`,
      }),
    })
    const rerouted = decideMatOSWorkflowOptimize({
      intent: 'repair',
      runId: 'run-9',
      defaultRole: 'role:workflow-repair',
      env: { MATOS_ALGO_WORKFLOW_OPTIMIZE: 'test-reroute' },
    })
    expect(rerouted.providerId).toBe('test-reroute')
    expect(rerouted.decision.role).toBe('role:custom-repairer')
    expect(rerouted.decision.directive).toBe('Custom repair plan for run-9')

    matOSWorkflowOptimizeSurface.register({
      id: 'test-empty',
      decide: () => ({ role: '   ', directive: '' }),
    })
    const fallback = decideMatOSWorkflowOptimize({
      intent: 'repair',
      runId: 'run-9',
      defaultRole: 'role:workflow-repair',
      env: { MATOS_ALGO_WORKFLOW_OPTIMIZE: 'test-empty' },
    })
    expect(fallback.decision.role).toBe('role:workflow-repair')
    expect(fallback.decision.directive).toContain('Repair MatOS workflow run run-9.')
  })

  test('oversized custom directives are truncated', () => {
    matOSWorkflowOptimizeSurface.register({
      id: 'test-huge',
      decide: () => ({ role: 'role:x', directive: 'y'.repeat(50_000) }),
    })
    const { decision } = decideMatOSWorkflowOptimize({
      intent: 'optimize',
      workflowRef: 'workflow:w',
      defaultRole: 'role:workflow-optimizer',
      env: { MATOS_ALGO_WORKFLOW_OPTIMIZE: 'test-huge' },
    })
    expect(decision.directive.length).toBe(20_000)
  })

  test('strategy errors fall back to the baseline decision', () => {
    matOSWorkflowOptimizeSurface.register({
      id: 'test-crash',
      decide: () => {
        throw new Error('strategy crashed')
      },
    })
    const { decision, fallback } = decideMatOSWorkflowOptimize({
      intent: 'optimize',
      workflowRef: 'workflow:w',
      defaultRole: 'role:workflow-optimizer',
      env: { MATOS_ALGO_WORKFLOW_OPTIMIZE: 'test-crash' },
    })
    expect(fallback).toBe('provider-error')
    expect(decision.role).toBe('role:workflow-optimizer')
    expect(decision.directive).toContain('Optimize MatOS workflow workflow:w.')
  })
})
