import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  flushMatOSAlgorithmShadowDecisions,
  matOSAlgorithmShadowQueueSnapshot,
  noteMatOSAlgorithmRunTerminal,
  registerMatOSAlgorithmShadowLifecycleObserver,
  waitForMatOSAlgorithmRunShadowDecisions,
} from './surface.js'
import {
  clearMatOSAlgorithmDecisionLog,
  recentMatOSAlgorithmDecisions,
} from './telemetry.js'
import {
  decideMatOSAssetSelection,
  matOSAssetSelectionSurface,
} from './surfaces/assetSelection.js'
import {
  decideMatOSContinuationPolicy,
  matOSContinuationPolicySurface,
} from './surfaces/continuationPolicy.js'
import {
  decideMatOSInferenceRouting,
  matOSInferenceRoutingSurface,
} from './surfaces/inferenceRouting.js'
import {
  decideMatOSRecoveryPolicy,
} from './surfaces/recoveryPolicy.js'
import {
  decideMatOSVerificationPolicy,
  matOSVerificationPolicySurface,
} from './surfaces/verificationPolicy.js'
import type { WorkflowRecoveryReport } from '../workflows/recovery.js'
import { withMatOSWorkflowExecutionContext } from '../workflows/executionContext.js'
import {
  createWorkflowRun,
  readWorkflowRunEvents,
} from '../workflows/workflowStore.js'
import { updateRunStatus } from '../workflows/runState.js'
import { ensureMatOSAlgorithmWorkflowIntegration } from './workflowIntegration.js'

function recoveryReport(): WorkflowRecoveryReport {
  return {
    runId: 'run-1',
    runDir: '/tmp/run-1',
    workflowRef: 'workflow:test@1.0.0',
    status: 'failed',
    classification: 'unknown_failure',
    recommendedAction: 'retry_node',
    nodeId: 'work',
    reason: 'test',
    evidence: {
      failedNodeIds: ['work'],
      runningNodeIds: [],
      readyNodeIds: [],
      pendingNodeIds: [],
      eventCount: 1,
      artifactCount: 0,
    },
  }
}

describe('Algorithm Layer V2 online policy surfaces', () => {
  test('continuation baseline remains exact and guarded provider tightens failure', async () => {
    const baseline = await decideMatOSContinuationPolicy({
      baselineAction: 'reroute',
      candidateActions: ['reroute', 'request-human', 'fail'],
      requiredValidationPassed: false,
      env: {},
    })
    expect(baseline.providerId).toBe('baseline')
    expect(baseline.decision.action).toBe('reroute')

    const guarded = await decideMatOSContinuationPolicy({
      baselineAction: 'continue',
      candidateActions: ['continue', 'pause', 'fail'],
      requiredValidationPassed: true,
      budgetExceeded: true,
      env: { MATOS_ALGO_CONTINUATION_POLICY: 'guarded' },
    })
    expect(guarded.decision.action).toBe('pause')
  })

  test('online shadow is off the applied path and records a counterfactual decision', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-algo-shadow-'))
    let shadowCalls = 0
    let releaseShadow!: () => void
    let shadowCompleted = false
    const shadowGate = new Promise<void>(resolve => { releaseShadow = resolve })
    matOSContinuationPolicySurface.register({
      id: 'test-slow-shadow',
      decide: async () => {
        shadowCalls += 1
        await shadowGate
        shadowCompleted = true
        return { action: 'pause', reason: 'shadow-only' }
      },
    })
    clearMatOSAlgorithmDecisionLog()
    try {
      const applied = await decideMatOSContinuationPolicy({
        baselineAction: 'continue',
        candidateActions: ['continue', 'pause'],
        requiredValidationPassed: true,
        cwd,
        env: {
          MATOS_ALGO_CONTINUATION_POLICY_SHADOW: 'test-slow-shadow',
          MATOS_ALGO_TELEMETRY: '1',
        },
      })
      expect(applied.providerId).toBe('baseline')
      expect(applied.decision.action).toBe('continue')
      expect(shadowCompleted).toBe(false)
      releaseShadow()
      await flushMatOSAlgorithmShadowDecisions()
      expect(shadowCalls).toBe(1)
      const records = recentMatOSAlgorithmDecisions(4)
      const shadow = records.find(record => record.source === 'shadow')
      expect(shadow).toMatchObject({
        providerId: 'test-slow-shadow',
        applied: false,
        shadowOfDecisionId: applied.decisionId,
        differsFromApplied: true,
      })
    } finally {
      releaseShadow()
      matOSContinuationPolicySurface.unregister('test-slow-shadow')
      clearMatOSAlgorithmDecisionLog()
    }
  })

  test('bounds each run shadow queue and emits explicit drop/drain lifecycle evidence', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-algo-shadow-bound-'))
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const lifecycle: Array<{ type: string; reason?: string }> = []
    const unregisterObserver = registerMatOSAlgorithmShadowLifecycleObserver(
      `online-shadow-bound-${Date.now()}`,
      event => {
        if (event.runDir === runDir) lifecycle.push(event)
      },
    )
    matOSContinuationPolicySurface.register({
      id: 'test-bounded-shadow',
      decide: async () => {
        await gate
        return { action: 'pause', reason: 'counterfactual-only' }
      },
    })
    try {
      await withMatOSWorkflowExecutionContext(
        {
          runId: 'run-shadow-bound',
          runDir,
          workflowNodeId: 'policy',
          attempt: 1,
          projectCwd: runDir,
        },
        async () => {
          for (let index = 0; index < 10; index += 1) {
            await decideMatOSContinuationPolicy({
              baselineAction: 'continue',
              candidateActions: ['continue', 'pause'],
              requiredValidationPassed: true,
              cwd: runDir,
              env: {
                MATOS_ALGO_CONTINUATION_POLICY_SHADOW: 'test-bounded-shadow',
                MATOS_ALGO_TELEMETRY: '1',
              },
            })
          }
        },
      )
      expect(matOSAlgorithmShadowQueueSnapshot(runDir)).toMatchObject({
        pendingForRun: 8,
        maxPendingForRun: 8,
      })
      noteMatOSAlgorithmRunTerminal(runDir)
      release()
      await waitForMatOSAlgorithmRunShadowDecisions(runDir)
      expect(
        lifecycle.filter(event => event.reason === 'per-run-capacity'),
      ).toHaveLength(2)
      expect(
        lifecycle.filter(event => event.type === 'terminal-drained'),
      ).toHaveLength(1)
      expect(matOSAlgorithmShadowQueueSnapshot(runDir).pendingForRun).toBe(0)
    } finally {
      release?.()
      unregisterObserver()
      matOSContinuationPolicySurface.unregister('test-bounded-shadow')
      await flushMatOSAlgorithmShadowDecisions()
    }
  })

  test('refreshes a terminal workflow outcome after counterfactual evidence drains', async () => {
    ensureMatOSAlgorithmWorkflowIntegration()
    const cwd = await mkdtemp(join(tmpdir(), 'matos-algo-shadow-outcome-'))
    const definition = {
      schemaVersion: 1 as const,
      name: 'shadow-outcome-refresh',
      parameters: {},
      policy: {},
      nodes: [],
      outputs: {},
    }
    const run = await createWorkflowRun({
      workflowsDir: join(cwd, '.matos', 'workflows'),
      workflowRef: 'workflow:shadow-outcome-refresh@1.0.0',
      graphSnapshot: definition,
      projectCwd: cwd,
      workspaceDir: cwd,
    })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    matOSContinuationPolicySurface.register({
      id: 'test-terminal-shadow',
      decide: async () => {
        entered()
        await gate
        return { action: 'pause', reason: 'terminal-counterfactual' }
      },
    })
    try {
      await withMatOSWorkflowExecutionContext(
        {
          runId: run.runId,
          runDir: run.dir,
          workflowNodeId: 'policy',
          attempt: 1,
          projectCwd: cwd,
          scopeRef: 'user:local',
        },
        () =>
          decideMatOSContinuationPolicy({
            baselineAction: 'continue',
            candidateActions: ['continue', 'pause'],
            requiredValidationPassed: true,
            cwd,
            env: {
              MATOS_ALGO_CONTINUATION_POLICY_SHADOW: 'test-terminal-shadow',
              MATOS_ALGO_TELEMETRY: '1',
            },
          }),
      )
      await enteredPromise
      // The gate is only released after this await, so a terminal path that
      // waited for the in-flight shadow decide would hang forever. Any finite
      // watchdog detects that; keep it generous because the awaited terminal
      // observers do real outcome/ledger filesystem work that can take
      // seconds on slow shared storage.
      await Promise.race([
        updateRunStatus(run.dir, 'completed'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('terminal path waited for online shadow')),
            15000,
          ),
        ),
      ])
      await new Promise(resolve => setTimeout(resolve, 5))
      release()
      await waitForMatOSAlgorithmRunShadowDecisions(run.dir)

      const index = JSON.parse(
        await readFile(join(run.dir, 'algorithm-outcomes', 'index.json'), 'utf8'),
      ) as { outcomeRefs: string[] }
      expect(index.outcomeRefs.length).toBeGreaterThanOrEqual(2)
      const latest = JSON.parse(
        await readFile(
          join(run.dir, 'algorithm-outcomes', index.outcomeRefs.at(-1)!),
          'utf8',
        ),
      ) as { decisionRefs?: string[]; counterfactualDecisionRefs?: string[] }
      const runDecisions = (await readFile(
        join(run.dir, 'algorithm-decisions.jsonl'),
        'utf8',
      ))
        .trim()
        .split('\n')
        .map(line =>
          JSON.parse(line) as {
            decisionId: string
            providerId: string
            applied?: boolean
          },
        )
      const shadowDecision = runDecisions.find(
        decision =>
          decision.providerId === 'test-terminal-shadow' &&
          decision.applied === false,
      )
      expect(shadowDecision).toBeDefined()
      expect(latest.counterfactualDecisionRefs).toContain(
        shadowDecision!.decisionId,
      )
      expect(
        (await readWorkflowRunEvents(run.dir)).some(
          event => event.type === 'workflow.algorithm.shadow_drained',
        ),
      ).toBe(true)
    } finally {
      release?.()
      matOSContinuationPolicySurface.unregister('test-terminal-shadow')
      await flushMatOSAlgorithmShadowDecisions()
    }
  })

  test('inference routing cannot introduce a model outside authorized routes', () => {
    matOSInferenceRoutingSurface.register({
      id: 'test-unauthorized-route',
      decide: () => ({ model: 'not-authorized', effort: 'ultra' }),
    })
    const result = decideMatOSInferenceRouting({
      roleRef: 'role:test@1.0.0',
      baselineRoute: { model: 'baseline-model', effort: 'medium' },
      candidateRoutes: [{ model: 'cheap-model', effort: 'low' }],
      env: { MATOS_ALGO_INFERENCE_ROUTING: 'test-unauthorized-route' },
    })
    expect(result.decision).toMatchObject({
      model: 'baseline-model',
      effort: 'medium',
    })
  })

  test('asset selection retains required assets and rejects foreign keys', () => {
    matOSAssetSelectionSurface.register({
      id: 'test-asset-escape',
      decide: () => ({ selectedAssetKeys: ['asset:foreign@1', 'asset:b@1'] }),
    })
    const result = decideMatOSAssetSelection({
      roleRef: 'role:test@1',
      candidateAssetKeys: ['asset:a@1', 'asset:b@1', 'asset:c@1'],
      requiredAssetKeys: ['asset:a@1'],
      maxAssets: 2,
      env: { MATOS_ALGO_ASSET_SELECTION: 'test-asset-escape' },
    })
    expect(result.decision.selectedAssetKeys).toEqual(['asset:a@1', 'asset:b@1'])
  })

  test('verification providers cannot remove or mutate required checks', () => {
    const required = [{ type: 'expression' as const, id: 'required', value: 'true' }]
    const optional = [{ type: 'file_exists' as const, id: 'optional', path: 'x' }]
    matOSVerificationPolicySurface.register({
      id: 'test-drop-required',
      decide: () => ({ checks: optional }),
    })
    const result = decideMatOSVerificationPolicy({
      requiredChecks: required,
      candidateChecks: optional,
      env: { MATOS_ALGO_VERIFICATION_POLICY: 'test-drop-required' },
    })
    expect(result.decision.checks).toEqual([...required, ...optional])
  })

  test('recovery policy is clamped to core-provided safe alternatives', async () => {
    const report = recoveryReport()
    const result = await decideMatOSRecoveryPolicy({
      report,
      candidateActions: ['retry_node', 'request_human_review', 'wait', 'fail'],
      env: { MATOS_ALGO_RECOVERY_POLICY: 'safety-first' },
    })
    expect(result.decision.action).toBe('request_human_review')
  })
})
