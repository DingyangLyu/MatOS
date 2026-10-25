/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import {
  buildWorkflowAgentNodeInvocation,
  workflowAgentPrompt,
  workflowAgentPromptWithArtifactContext,
} from './nodeAdapters/agentNode.js'
import { nodeApprovalRequired } from './nodeLifecycle.js'
import { recoverWorkflowRun } from './recovery.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import {
  approveWorkflowNode,
  applyWorkflowRecoveryRecommendation,
  cancelWorkflowRun,
  denyWorkflowNode,
  inspectWorkflowRun,
  nodeParallelSafe,
  pauseWorkflowRun,
  reconcileWorkflowRunComputeJobs,
  requestWorkflowRunCancel,
  resumeWorkflowRun,
  retryWorkflowNode,
  respondToWorkflowNode,
  skipWorkflowNode,
  startWorkflowRun,
  workflowMaxConcurrency,
} from './workflowRuntime.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  readWorkflowRunEvents,
  writeWorkflowRun,
} from './workflowStore.js'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from './types.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function deepResearchStageCommand(stage: string): string {
  return [
    'set -eu',
    'root="${MATOS_WORKFLOW_ARTIFACT_ROOT:?MATOS_WORKFLOW_ARTIFACT_ROOT is required}"',
    'script="${MATOS_PROJECT_CWD:?MATOS_PROJECT_CWD is required}/matos-assets/packs/matos-deep-research/workflows/deep-research/write_v2_artifacts.py"',
    'export MATOS_DEEP_RESEARCH_OFFLINE_SOURCES=1',
    `python3 "$script" --root "$root" --stage ${stage}`,
  ].join('\n')
}

function deepResearchStageNode(
  id: string,
  stage: string,
  dependsOn: string[] = [],
): MatOSWorkflowNode {
  return {
    id,
    type: 'exec',
    dependsOn,
    command: deepResearchStageCommand(stage),
  }
}

const ORIGINAL_ENV = { ...process.env }
const WORKFLOW_AGENT_NODE_TEST_TIMEOUT_MS = Number.parseInt(
  process.env.MATOS_WORKFLOW_AGENT_TEST_TIMEOUT_MS ?? '60000',
  10,
)

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('MatOS workflow runtime', () => {
  test('rejects unknown workflow parameters before creating a run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-parameters-'))
    await expect(
      startWorkflowRun({
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:strict-parameters@0.1.0',
        parameters: { inputPath: 'input.in' },
        definition: {
          schemaVersion: 1,
          name: 'strict-parameters',
          parameters: { inputFiles: { type: 'array' } },
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [],
        },
        workspaceDir: root,
      }),
    ).rejects.toThrow(
      'Unknown workflow parameter "inputPath". Accepted parameters: inputFiles.',
    )
  })

  test('retries a completed causal producer and invalidates only its downstream closure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-causal-retry-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:causal-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'causal-retry',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'unaffected',
            type: 'exec',
            dependsOn: [],
            command: 'printf x >> unaffected.log',
          },
          {
            id: 'produce',
            type: 'exec',
            dependsOn: [],
            command:
              'printf x >> produce.log; if [ -f repaired.flag ]; then printf finite > result.txt; else printf NaN > result.txt; fi',
          },
          {
            id: 'validate',
            type: 'guard',
            dependsOn: ['produce'],
            checks: [
              {
                type: 'regex',
                path: 'result.txt',
                pattern: 'NaN',
                negate: true,
                failureCode: 'non_finite_result',
                repairHint: 'Repair and recompute the producer.',
                sourceNodeId: 'produce',
              },
            ],
          },
          {
            id: 'report',
            type: 'exec',
            dependsOn: ['validate'],
            command: 'printf done > report.txt',
          },
        ],
      },
    })
    expect(run.status).toBe('failed')
    expect(run.nodes?.find(node => node.nodeId === 'produce')?.status).toBe(
      'completed',
    )
    expect(run.diagnostics?.failedNodes[0]?.remediation).toMatchObject({
      action: 'repair_and_retry_upstream',
      hint: expect.stringContaining('causal producer(s) produce'),
    })

    await writeFile(join(root, 'repaired.flag'), 'yes\n', 'utf8')
    const repaired = await retryWorkflowNode({
      runDir: run.runDir,
      nodeId: 'produce',
    })

    expect(repaired.status).toBe('completed')
    expect(repaired.nodes?.find(node => node.nodeId === 'produce')?.attempts).toBe(2)
    expect(repaired.nodes?.find(node => node.nodeId === 'validate')?.attempts).toBe(2)
    expect(repaired.nodes?.find(node => node.nodeId === 'unaffected')?.attempts).toBe(1)
    expect(await readFile(join(root, 'produce.log'), 'utf8')).toBe('xx')
    expect(await readFile(join(root, 'unaffected.log'), 'utf8')).toBe('x')
    expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('done')
    expect(await readWorkflowRunEvents(run.runDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'workflow.node.retry_requested',
          data: expect.objectContaining({
            nodeId: 'produce',
            reason: 'downstream_validation_identified_causal_producer',
            causalFailedNodeIds: ['validate'],
          }),
        }),
      ]),
    )
  })

  test('runs exec and guard nodes, then waits for human input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-runtime-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:local@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'local',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'make_file', type: 'exec', dependsOn: [], command: 'printf ok > result.txt' },
          {
            id: 'check_file',
            type: 'guard',
            dependsOn: ['make_file'],
            checks: [{ type: 'file_exists', path: 'result.txt' }],
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['check_file'],
            prompt: 'Review result',
            responseSchema: { type: 'object' },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('review')
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('ok')

    const completed = await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'review',
      response: { approved: true },
    })

    expect(completed.status).toBe('completed')
  })

  test('escalates a repeatedly failing node from node repair to workflow adaptation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-remediation-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:remediation@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'remediation',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'always_fails',
            type: 'exec',
            dependsOn: [],
            command: 'exit 7',
            policy: { retry: { maxAttempts: 2, retryableExitCodes: [7] } },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    const failed = inspected.diagnostics?.failedNodes?.[0]
    expect(failed?.attempts).toBe(2)
    // Driving the same failing node to the end of its budget is what made the
    // agent give up instead of fixing the workflow, so a repeat failure has to
    // read as a contract mismatch.
    expect(failed?.remediation?.scope).toBe('workflow')
    expect(failed?.remediation?.action).toBe('adapt_workflow_or_substitute')
    expect(failed?.remediation?.options).toEqual(
      expect.arrayContaining([
        expect.stringContaining('substitute a published workflow'),
        expect.stringContaining('never remove or weaken a validation gate'),
      ]),
    )
  })

  test('fails nodes with output contract diagnostics when runtime output shape is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-contract-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:contract-failure@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'contract-failure',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'produce_text',
            type: 'exec',
            dependsOn: [],
            command: 'printf ok',
            outputContract: {
              stdout: { type: 'number', required: true },
            },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    const node = inspected.nodes?.find(item => item.nodeId === 'produce_text')
    expect(node?.status).toBe('failed')
    expect(inspected.diagnostics).toMatchObject({
      nodeCount: 1,
      failedCount: 1,
      failedNodes: [
        expect.objectContaining({
          nodeId: 'produce_text',
          attempts: 1,
          // A first, retry-safe failure still points at the node, not the workflow.
          remediation: expect.objectContaining({ scope: 'node' }),
        }),
      ],
      timeline: [
        expect.objectContaining({
          nodeId: 'produce_text',
          status: 'failed',
          attempts: 1,
        }),
      ],
    })
    expect(node?.error).toMatchObject({
      code: 'output_contract_failed',
      details: {
        nodeId: 'produce_text',
        errors: expect.arrayContaining([
          expect.stringContaining('expected number'),
        ]),
      },
    })
    const attempt = JSON.parse(
      await readFile(
        join(
          run.runDir,
          'node-runs',
          'produce_text',
          'attempts',
          '1',
          'attempt.json',
        ),
        'utf8',
      ),
    )
    expect(attempt).toMatchObject({
      status: 'failed',
      outputPath: 'output.json',
      errorPath: 'error.json',
      contractValidation: {
        ok: false,
        errors: expect.arrayContaining([
          expect.stringContaining('expected number'),
        ]),
      },
    })
  })

  test('surfaces stderr snippets on failed exec nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-exec-error-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:exec-error@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'exec-error',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'bad_params',
            type: 'exec',
            dependsOn: [],
            command: 'printf "insertions must be between 500 and 20000\\n" >&2; exit 2',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    const node = inspected.nodes?.find(item => item.nodeId === 'bad_params')
    expect(node?.error).toMatchObject({
      exitCode: 2,
      stderr: 'insertions must be between 500 and 20000',
    })
    const attempt = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'bad_params', 'attempts', '1', 'attempt.json'),
        'utf8',
      ),
    ) as { stderrPath?: string }
    expect(attempt.stderrPath).toBe('stderr.log')
    await expect(
      readFile(
        join(run.runDir, 'node-runs', 'bad_params', 'attempts', '1', 'stderr.log'),
        'utf8',
      ),
    ).resolves.toContain('insertions must be between 500 and 20000')
  })

  test('records durable workflow budget accounting from node attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-budget-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:budget@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'budget',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'make_file', type: 'exec', dependsOn: [], command: 'printf ok > result.txt' },
          {
            id: 'check_file',
            type: 'guard',
            dependsOn: ['make_file'],
            checks: [{ type: 'file_exists', path: 'result.txt' }],
          },
          {
            id: 'review',
            type: 'human',
            dependsOn: ['check_file'],
            prompt: 'Review result',
            responseSchema: { type: 'object' },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('waiting_input')

    await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'review',
      response: { approved: true },
    })
    const inspected = await inspectWorkflowRun(run.runDir)

    expect(inspected.budget?.schemaVersion).toBe(1)
    expect(inspected.budget?.runId).toBe(run.runId)
    expect(inspected.budget?.totals.nodeAttempts).toBe(3)
    expect(inspected.budget?.totals.toolCalls).toBe(2)
    expect(inspected.budget?.totals.agentCalls).toBe(0)
    expect(inspected.budget?.totals.backendJobs).toBe(0)
    expect(inspected.budget?.totals.wallTimeMs).toBeGreaterThanOrEqual(0)
    expect(inspected.budget?.byNode.make_file.toolCalls).toBe(1)
    expect(inspected.budget?.byNode.check_file.toolCalls).toBe(1)
    expect(inspected.budget?.byNode.review.toolCalls).toBe(0)

    const budget = JSON.parse(
      await readFile(join(run.runDir, 'budget.json'), 'utf8'),
    )
    expect(budget.totals).toEqual(inspected.budget?.totals)
  })

  test('stops scheduling new nodes when the declared budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-budget-stop-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:budget-stop@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'budget-stop',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          budget: { maxToolCalls: 2, onExceeded: 'fail' },
        },
        outputs: {},
        nodes: [
          { id: 'step_one', type: 'exec', dependsOn: [], command: 'printf one > one.txt' },
          {
            id: 'step_two',
            type: 'exec',
            dependsOn: ['step_one'],
            command: 'printf two > two.txt',
          },
          {
            id: 'step_three',
            type: 'exec',
            dependsOn: ['step_two'],
            command: 'printf three > three.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.find(node => node.nodeId === 'step_one')?.status).toBe(
      'completed',
    )
    expect(inspected.nodes?.find(node => node.nodeId === 'step_two')?.status).toBe(
      'completed',
    )
    expect(
      inspected.nodes?.find(node => node.nodeId === 'step_three')?.status ??
        'pending',
    ).toBe('pending')
    expect(inspected.budget?.policy).toMatchObject({
      maxToolCalls: 2,
      onExceeded: 'fail',
    })
    expect(inspected.budget?.violations).toEqual([
      { limit: 'maxToolCalls', max: 2, observed: 2 },
    ])

    const events = await readWorkflowRunEvents(run.runDir)
    const exceeded = events.find(event => event.type === 'workflow.budget.exceeded')
    expect(exceeded?.data).toMatchObject({
      onExceeded: 'fail',
      violations: [{ limit: 'maxToolCalls', max: 2, observed: 2 }],
    })
  })

  test('pauses budget-exhausted runs when onExceeded is pause and stays paused on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-budget-pause-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:budget-pause@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'budget-pause',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          budget: { maxNodeAttempts: 1, onExceeded: 'pause' },
        },
        outputs: {},
        nodes: [
          { id: 'first', type: 'exec', dependsOn: [], command: 'printf first > first.txt' },
          {
            id: 'second',
            type: 'exec',
            dependsOn: ['first'],
            command: 'printf second > second.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('paused')
    const resumed = await resumeWorkflowRun(run.runDir)
    expect(resumed.status).toBe('paused')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(
      inspected.nodes?.find(node => node.nodeId === 'second')?.status ?? 'pending',
    ).toBe('pending')
    expect(inspected.budget?.violations).toEqual([
      { limit: 'maxNodeAttempts', max: 1, observed: 1 },
    ])
  })

  test('completes runs that finish exactly at the declared budget limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-budget-exact-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:budget-exact@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'budget-exact',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          budget: { maxToolCalls: 2, onExceeded: 'fail' },
        },
        outputs: {},
        nodes: [
          { id: 'left', type: 'exec', dependsOn: [], command: 'printf left > left.txt' },
          {
            id: 'right',
            type: 'exec',
            dependsOn: ['left'],
            command: 'printf right > right.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
  })

  test('aggregates attempt usage tokens, turns, and cost into the budget ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-budget-usage-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:budget-usage@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'budget-usage',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'only', type: 'exec', dependsOn: [], command: 'printf ok > ok.txt' },
        ],
      },
      workspaceDir: root,
    })
    expect(run.status).toBe('completed')

    // Inject usage into the durable attempt manifest the way an agent node
    // attempt would persist it, then recompute the ledger from disk.
    const attemptPath = join(
      run.runDir,
      'node-runs',
      'only',
      'attempts',
      '1',
      'attempt.json',
    )
    const attempt = JSON.parse(await readFile(attemptPath, 'utf8'))
    attempt.usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 500,
      agentTurns: 4,
      totalCostUsd: 0.025,
    }
    await writeJson(attemptPath, attempt)

    const { refreshWorkflowBudgetLedger } = await import('./budget.js')
    const ledger = await refreshWorkflowBudgetLedger(run.runDir)
    expect(ledger.totals.inputTokens).toBe(1700)
    expect(ledger.totals.outputTokens).toBe(300)
    expect(ledger.totals.totalTokens).toBe(2000)
    expect(ledger.totals.agentTurns).toBe(4)
    expect(ledger.totals.totalCostUsd).toBeCloseTo(0.025)
    expect(ledger.byNode.only.totalTokens).toBe(2000)
    expect(ledger.byNode.only.totalCostUsd).toBeCloseTo(0.025)
  })

  test('stops scheduling when a token budget limit is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-budget-token-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:budget-token@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'budget-token',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          budget: { maxTotalTokens: 1000, onExceeded: 'fail' },
        },
        outputs: {},
        nodes: [
          { id: 'first', type: 'exec', dependsOn: [], command: 'printf one > one.txt' },
          {
            id: 'second',
            type: 'exec',
            dependsOn: ['first'],
            command: 'printf two > two.txt',
          },
        ],
      },
      workspaceDir: root,
    })
    // exec nodes record no token usage, so the run completes within budget.
    expect(run.status).toBe('completed')

    const attemptPath = join(
      run.runDir,
      'node-runs',
      'first',
      'attempts',
      '1',
      'attempt.json',
    )
    const attempt = JSON.parse(await readFile(attemptPath, 'utf8'))
    attempt.usage = { inputTokens: 900, outputTokens: 200 }
    await writeJson(attemptPath, attempt)

    const { refreshWorkflowBudgetLedger } = await import('./budget.js')
    const ledger = await refreshWorkflowBudgetLedger(run.runDir)
    expect(ledger.violations).toEqual([
      { limit: 'maxTotalTokens', max: 1000, observed: 1100 },
    ])
  })

  test('stops scheduling when a node-level budget limit is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-node-budget-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:node-budget@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'node-budget',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'flaky',
            type: 'exec',
            dependsOn: [],
            command: 'exit 7',
            budget: { maxNodeAttempts: 1 },
            policy: { retry: { maxAttempts: 3, retryableExitCodes: [7] } },
          },
          {
            id: 'after',
            type: 'exec',
            dependsOn: ['flaky'],
            command: 'printf done > done.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    // The node budget stops the run after the first attempt instead of
    // burning the remaining retry attempts.
    expect(inspected.budget?.byNode.flaky?.nodeAttempts).toBe(1)
    expect(inspected.budget?.violations).toEqual([
      { limit: 'maxNodeAttempts', max: 1, observed: 1, nodeId: 'flaky' },
    ])
    const events = await readWorkflowRunEvents(run.runDir)
    const exceeded = events.find(event => event.type === 'workflow.budget.exceeded')
    expect(exceeded?.data).toMatchObject({
      violations: [{ limit: 'maxNodeAttempts', max: 1, observed: 1, nodeId: 'flaky' }],
    })
  })

  test('exposes the run graph projection on inspected runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-run-graph-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:run-graph@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'run-graph',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'build', type: 'exec', dependsOn: [], command: 'printf ok > built.txt' },
          {
            id: 'verify',
            type: 'guard',
            dependsOn: ['build'],
            checks: [{ type: 'file_exists', path: 'built.txt' }],
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.graph?.nodes).toEqual([
      { id: 'build', type: 'exec', dependsOn: [] },
      { id: 'verify', type: 'guard', dependsOn: ['build'] },
    ])
    expect(inspected.graph?.edges).toEqual([{ from: 'build', to: 'verify' }])
  })

  test('exec nodes receive project and workspace path environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-exec-env-'))
    const project = join(root, 'project')
    const workspace = join(root, 'workspace')
    await mkdir(project, { recursive: true })
    await mkdir(workspace, { recursive: true })

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:exec-env@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'exec env',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'capture_env',
            type: 'exec',
            dependsOn: [],
            command:
              'printf "%s\\n%s\\n" "$MATOS_PROJECT_CWD" "$MATOS_WORKSPACE_DIR" > env.txt',
          },
        ],
      },
      cwd: project,
      workspaceDir: workspace,
    })

    expect(run.status).toBe('completed')
    expect(await readFile(join(workspace, 'env.txt'), 'utf8')).toBe(
      `${project}\n${workspace}\n`,
    )
  })

  test('workflow workspaceDir templates can drive exec args and guard paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-workspace-template-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'input.txt'), 'workspace-template-ok\n', 'utf8')

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:workspace-template@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'workspace template',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          stdout: { value: '{{ nodes.read_input.outputs.stdout }}' },
          guardOk: { value: '{{ nodes.check_input.outputs.ok }}' },
        },
        nodes: [
          {
            id: 'read_input',
            type: 'exec',
            dependsOn: [],
            command: 'cat',
            args: ['{{ workflow.workspaceDir }}/input.txt'],
          },
          {
            id: 'check_input',
            type: 'guard',
            dependsOn: ['read_input'],
            checks: [
              {
                type: 'file_exists',
                path: '{{ workflow.workspaceDir }}/input.txt',
              },
            ],
          },
        ],
      },
      workspaceDir: workspace,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.stdout).toBe('workspace-template-ok\n')
    expect(run.outputs.guardOk).toBe(true)
  })

  test('exec nodes receive workflow parameters as JSON environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-exec-params-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:exec-params@0.1.0',
      parameters: {
        topic: 'open research topic',
        preset: 'open-topic',
      },
      definition: {
        schemaVersion: 1,
        name: 'exec params',
        parameters: {
          topic: { type: 'string' },
          preset: { type: 'string' },
        },
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'capture_params',
            type: 'exec',
            dependsOn: [],
            command:
              'python3 -c "import json, os; data=json.loads(os.environ[\\\"MATOS_WORKFLOW_PARAMETERS_JSON\\\"]); print(data[\\\"topic\\\"], data[\\\"preset\\\"])" > params.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(await readFile(join(root, 'params.txt'), 'utf8')).toBe(
      'open research topic open-topic\n',
    )
  })

  test('exec nodes receive the workflow run directory environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-exec-run-dir-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:exec-run-dir@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'exec run dir',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'capture_run_dir',
            type: 'exec',
            dependsOn: [],
            command: 'printf "%s" "$MATOS_WORKFLOW_RUN_DIR" > run-dir.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(await readFile(join(root, 'run-dir.txt'), 'utf8')).toBe(run.runDir)
  })

  test('exec nodes and workflow outputs use a run-scoped artifact root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-artifact-root-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:artifact-root@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'artifact root',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          artifactRoot: { value: '{{ workflow.artifactRoot }}' },
          reportPath: { value: '{{ workflow.artifactRoot }}/report.md' },
          reportArtifactPath: {
            value: '{{ nodes.write_report.artifacts.report_file.path }}',
          },
          reportArtifact: {
            value: '{{ nodes.write_report.artifacts.report_file }}',
          },
          copiedReport: { value: '{{ nodes.read_report.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'write_report',
            type: 'exec',
            dependsOn: [],
            artifactContract: {
              report_file: {
                kind: 'file',
                path: 'report.md',
                required: true,
              },
            },
            command:
              'mkdir -p "$MATOS_WORKFLOW_ARTIFACT_ROOT" && printf "%s" "$MATOS_WORKFLOW_ARTIFACT_ROOT" > artifact-root.txt && printf report > "$MATOS_WORKFLOW_ARTIFACT_ROOT/report.md"',
          },
          {
            id: 'read_report',
            type: 'exec',
            dependsOn: ['write_report'],
            command:
              'cat "{{ nodes.write_report.artifacts.report_file.path }}" > copied-report.txt && cat copied-report.txt',
          },
        ],
      },
      workspaceDir: root,
    })

    const expectedArtifactRoot = join(
      root,
      'matos-workflows',
      'artifact-root',
      run.runId,
    )
    expect(run.status).toBe('completed')
    expect(await readFile(join(root, 'artifact-root.txt'), 'utf8')).toBe(
      expectedArtifactRoot,
    )
    expect(run.outputs).toMatchObject({
      artifactRoot: expectedArtifactRoot,
      reportPath: join(expectedArtifactRoot, 'report.md'),
      reportArtifactPath: join(expectedArtifactRoot, 'report.md'),
      reportArtifact: expect.objectContaining({
        id: 'report_file',
        nodeId: 'write_report',
        path: join(expectedArtifactRoot, 'report.md'),
      }),
      copiedReport: 'report',
    })
    expect(await readFile(join(expectedArtifactRoot, 'report.md'), 'utf8')).toBe(
      'report',
    )
    expect(await readFile(join(root, 'copied-report.txt'), 'utf8')).toBe('report')
    const artifacts = JSON.parse(
      await readFile(join(run.runDir, 'artifacts.json'), 'utf8'),
    )
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'report_file',
          nodeId: 'write_report',
          kind: 'file',
          path: join(expectedArtifactRoot, 'report.md'),
        }),
      ]),
    )
  })

  test('records durable attempt metadata with timestamps and idempotency keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-attempt-meta-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:attempt-meta@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'attempt meta',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'capture',
            type: 'exec',
            dependsOn: [],
            command: 'printf attempt-meta-ok',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    const attempt = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'capture', 'attempts', '1', 'attempt.json'),
        'utf8',
      ),
    ) as {
      nodeId: string
      attempt: number
      status: string
      startedAt: string
      finishedAt: string
      idempotencyKey: string
      outputPath?: string
      stdoutPath?: string
      stderrPath?: string
      contractValidation?: { ok: boolean }
      sideEffect?: { class: string; replayStrategy: string; replaySafe: boolean }
    }

    expect(attempt).toMatchObject({
      nodeId: 'capture',
      attempt: 1,
      status: 'completed',
      outputPath: 'output.json',
      stdoutPath: 'stdout.log',
      stderrPath: 'stderr.log',
      contractValidation: { ok: true },
      sideEffect: {
        class: 'local_process',
        replayStrategy: 'rerun',
        replaySafe: false,
      },
    })
    expect(Date.parse(attempt.startedAt)).not.toBeNaN()
    expect(Date.parse(attempt.finishedAt)).not.toBeNaN()
    expect(attempt.idempotencyKey).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Date.parse(attempt.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(attempt.startedAt),
    )
  })

  test('dynamic nodes apply low-risk graph patches and run newly added nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-auto-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-auto@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic auto',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          review: { value: '{{ nodes.review.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'plan',
            type: 'dynamic',
            dependsOn: [],
            candidate: {
              schemaVersion: 1,
              sourceNodeId: 'plan',
              reason: 'add bounded review node',
              operations: [
                {
                  op: 'add_node',
                  node: {
                    id: 'review',
                    type: 'exec',
                    dependsOn: [],
                    command:
                      'printf dynamic-review > dynamic.txt; printf dynamic-review',
                  },
                },
                { op: 'add_edge', from: 'plan', to: 'review' },
              ],
              budgetImpact: {
                addedNodes: 1,
                estimatedAgentCalls: 0,
                estimatedWallMinutes: 1,
              },
              risk: 'low',
            },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.review).toBe('dynamic-review')
    expect(await readFile(join(root, 'dynamic.txt'), 'utf8')).toBe(
      'dynamic-review',
    )
    const runSnapshot = JSON.parse(await readFile(join(run.runDir, 'run.json'), 'utf8'))
    expect(runSnapshot.graphSnapshotPath).toBe('graph.snapshot.v2.json')
    expect(
      JSON.parse(
        await readFile(join(run.runDir, 'dynamic-patches', 'plan-add-bounded-review-node', 'decision.json'), 'utf8'),
      ),
    ).toMatchObject({
      status: 'applied',
      graphSnapshotPath: 'graph.snapshot.v2.json',
    })
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.dynamic_patch.applied',
    )
  })

  test('dynamic planner nodes use agent output as graph patch candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-planner-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-planner@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic planner',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          review: { value: '{{ nodes.review.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'plan',
            type: 'dynamic',
            dependsOn: [],
            role: 'role:planner',
            prompt: 'Propose a bounded review node for this workflow.',
            passthroughArgs: ['--bare', '--tools', '', '--max-turns', '1'],
          },
        ],
      },
      workspaceDir: root,
      dynamicPlannerRunner: async (node: MatOSWorkflowNode) => ({
        stdout: '',
        stderr: '',
        output: {
          result: '',
          role: node.role,
          structured: {
            candidate: {
              schemaVersion: 1,
              sourceNodeId: 'plan',
              reason: 'agent planned review node',
              operations: [
                {
                  op: 'add_node',
                  node: {
                    id: 'review',
                    type: 'exec',
                    dependsOn: [],
                    command:
                      'printf agent-dynamic-review > planner-dynamic.txt; printf agent-dynamic-review',
                  },
                },
                { op: 'add_edge', from: 'plan', to: 'review' },
              ],
              budgetImpact: {
                addedNodes: 1,
                estimatedAgentCalls: 1,
                estimatedWallMinutes: 1,
              },
              risk: 'low',
            },
          },
        },
      }),
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.review).toBe('agent-dynamic-review')
    expect(await readFile(join(root, 'planner-dynamic.txt'), 'utf8')).toBe(
      'agent-dynamic-review',
    )
    const patch = JSON.parse(
      await readFile(
        join(run.runDir, 'dynamic-patches', 'plan-agent-planned-review-node', 'candidate.json'),
        'utf8',
      ),
    )
    expect(patch).toMatchObject({
      sourceNodeId: 'plan',
      risk: 'low',
      budgetImpact: { estimatedAgentCalls: 1 },
    })
  })

  test('dynamic planner-executor-reviewer protocol expands into bounded executor and reviewer nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-protocol-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-protocol@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic protocol',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          review: { value: '{{ nodes.review_evidence.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'plan',
            type: 'dynamic',
            dependsOn: [],
            protocol: 'planner-executor-reviewer',
            role: 'role:planner',
            prompt: 'Split the topic into bounded executor work and a reviewer.',
            passthroughArgs: ['--bare', '--tools', '', '--max-turns', '1'],
          },
        ],
      },
      workspaceDir: root,
      dynamicPlannerRunner: async (node: MatOSWorkflowNode) => ({
        stdout: '',
        stderr: '',
        output: {
          result: '',
          role: node.role,
          structured: {
            protocol: 'planner-executor-reviewer',
            planId: 'collect-then-review',
            reason: 'collect evidence before review',
            risk: 'low',
            budgetImpact: {
              estimatedAgentCalls: 1,
              estimatedWallMinutes: 1,
            },
            executorNodes: [
              {
                id: 'collect_evidence',
                type: 'exec',
                dependsOn: [],
                command: 'printf evidence > evidence.txt; printf evidence',
              },
            ],
            reviewerNode: {
              id: 'review_evidence',
              type: 'exec',
              dependsOn: [],
              command: 'cat evidence.txt > review.txt; printf reviewed',
            },
          },
        },
      }),
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.review).toBe('reviewed')
    expect(await readFile(join(root, 'review.txt'), 'utf8')).toBe('evidence')

    const patch = JSON.parse(
      await readFile(
        join(run.runDir, 'dynamic-patches', 'plan-collect-evidence-before-review', 'candidate.json'),
        'utf8',
      ),
    )
    expect(patch).toMatchObject({
      sourceNodeId: 'plan',
      reason: 'collect evidence before review',
      risk: 'low',
      metadata: {
        protocol: 'planner-executor-reviewer',
        planId: 'collect-then-review',
      },
    })
    expect(patch.operations.map((operation: { op?: string; type?: string }) => operation.op ?? operation.type)).toEqual([
      'add_node',
      'add_node',
      'add_edge',
      'add_edge',
    ])
  })

  test('dynamic planner-executor-reviewer protocol can split independent executor branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-parallel-executors-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-parallel-executors@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic parallel executors',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          review: { value: '{{ nodes.review_split.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'plan_split',
            type: 'dynamic',
            dependsOn: [],
            protocol: 'planner-executor-reviewer',
            role: 'role:planner',
            prompt: 'Split independent evidence collection tasks before review.',
            passthroughArgs: ['--bare', '--tools', '', '--max-turns', '1'],
          },
        ],
      },
      workspaceDir: root,
      dynamicPlannerRunner: async (node: MatOSWorkflowNode) => ({
        stdout: '',
        stderr: '',
        output: {
          result: '',
          role: node.role,
          structured: {
            protocol: 'planner-executor-reviewer',
            planId: 'parallel-evidence',
            reason: 'split independent evidence collection',
            risk: 'low',
            executionMode: 'parallel',
            budgetImpact: {
              estimatedAgentCalls: 1,
              estimatedWallMinutes: 1,
            },
            executorNodes: [
              {
                id: 'collect_alpha',
                type: 'exec',
                dependsOn: [],
                command: 'printf alpha > alpha.txt; printf alpha',
              },
              {
                id: 'collect_beta',
                type: 'exec',
                dependsOn: [],
                command: 'printf beta > beta.txt; printf beta',
              },
            ],
            reviewerNode: {
              id: 'review_split',
              type: 'exec',
              dependsOn: [],
              command: 'cat alpha.txt beta.txt > split-review.txt; printf reviewed',
            },
          },
        },
      }),
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.review).toBe('reviewed')
    expect(await readFile(join(root, 'split-review.txt'), 'utf8')).toBe(
      'alphabeta',
    )

    const patch = JSON.parse(
      await readFile(
        join(run.runDir, 'dynamic-patches', 'plan_split-split-independent-evidence-collection', 'candidate.json'),
        'utf8',
      ),
    )
    const edges = patch.operations
      .filter((operation: { op?: string }) => operation.op === 'add_edge')
      .map((operation: { from: string; to: string }) => [operation.from, operation.to])
    expect(edges).toEqual([
      ['plan_split', 'collect_alpha'],
      ['plan_split', 'collect_beta'],
      ['collect_alpha', 'review_split'],
      ['collect_beta', 'review_split'],
    ])
  })

  test('dynamic planner-executor-reviewer protocol can schedule a bounded follow-up planner round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-follow-up-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-follow-up@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic follow up',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          dynamicAllowedAssetRefs: ['role:planner'],
        },
        outputs: {},
        nodes: [
          {
            id: 'plan_round_1',
            type: 'dynamic',
            dependsOn: [],
            protocol: 'planner-executor-reviewer',
            role: 'role:planner',
            prompt: 'Plan the first bounded round and schedule one follow-up planner.',
            passthroughArgs: ['--bare', '--tools', '', '--max-turns', '1'],
          },
        ],
      },
      workspaceDir: root,
      dynamicPlannerRunner: async (node: MatOSWorkflowNode) => {
        const structured =
          node.id === 'plan_round_1'
            ? {
                protocol: 'planner-executor-reviewer',
                planId: 'round-1',
                reason: 'first round then follow up',
                risk: 'low',
                budgetImpact: {
                  estimatedAgentCalls: 1,
                  estimatedWallMinutes: 1,
                },
                executorNodes: [
                  {
                    id: 'collect_first',
                    type: 'exec',
                    dependsOn: [],
                    command: 'printf first > first.txt; printf first',
                  },
                ],
                reviewerNode: {
                  id: 'review_first',
                  type: 'exec',
                  dependsOn: [],
                  command: 'printf first-reviewed > first-review.txt; printf first-reviewed',
                },
                followUpPlannerNode: {
                  id: 'plan_round_2',
                  type: 'dynamic',
                  dependsOn: [],
                  protocol: 'planner-executor-reviewer',
                  role: 'role:planner',
                  prompt: 'Plan the second bounded round from first-review.txt.',
                  passthroughArgs: ['--bare', '--tools', '', '--max-turns', '1'],
                },
                outputs: {
                  first: { value: '{{ nodes.review_first.outputs.stdout }}' },
                },
              }
            : {
                protocol: 'planner-executor-reviewer',
                planId: 'round-2',
                reason: 'second round after review',
                risk: 'low',
                budgetImpact: {
                  estimatedAgentCalls: 1,
                  estimatedWallMinutes: 1,
                },
                executorNodes: [
                  {
                    id: 'collect_second',
                    type: 'exec',
                    dependsOn: [],
                    command: 'cat first-review.txt > second.txt; printf second',
                  },
                ],
                reviewerNode: {
                  id: 'review_second',
                  type: 'exec',
                  dependsOn: [],
                  command: 'cat second.txt > second-review.txt; printf second-reviewed',
                },
                outputs: {
                  first: { value: '{{ nodes.review_first.outputs.stdout }}' },
                  second: { value: '{{ nodes.review_second.outputs.stdout }}' },
                },
              }
        return {
          stdout: '',
          stderr: '',
          output: {
            result: '',
            role: node.role,
            structured,
          },
        }
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs).toMatchObject({
      first: 'first-reviewed',
      second: 'second-reviewed',
    })
    expect(await readFile(join(root, 'second-review.txt'), 'utf8')).toBe(
      'first-reviewed',
    )
    const firstPatch = JSON.parse(
      await readFile(
        join(run.runDir, 'dynamic-patches', 'plan_round_1-first-round-then-follow-up', 'candidate.json'),
        'utf8',
      ),
    )
    expect(firstPatch.operations.map((operation: { op?: string }) => operation.op)).toEqual([
      'add_node',
      'add_node',
      'add_node',
      'add_edge',
      'add_edge',
      'add_edge',
      'set_outputs',
    ])
    expect(firstPatch.operations).toContainEqual(
      expect.objectContaining({
        op: 'add_node',
        node: expect.objectContaining({
          id: 'plan_round_2',
          type: 'dynamic',
          protocol: 'planner-executor-reviewer',
        }),
      }),
    )
    expect(firstPatch.operations).toContainEqual({
      op: 'add_edge',
      from: 'review_first',
      to: 'plan_round_2',
    })
    expect(firstPatch.operations).toContainEqual({
      op: 'set_outputs',
      outputs: {
        first: { value: '{{ nodes.review_first.outputs.stdout }}' },
      },
    })
    const secondPatch = JSON.parse(
      await readFile(
        join(run.runDir, 'dynamic-patches', 'plan_round_2-second-round-after-review', 'candidate.json'),
        'utf8',
      ),
    )
    expect(secondPatch.operations).toContainEqual({
      op: 'set_outputs',
      outputs: {
        first: { value: '{{ nodes.review_first.outputs.stdout }}' },
        second: { value: '{{ nodes.review_second.outputs.stdout }}' },
      },
    })
  })

  test('dynamic nodes apply graph patch candidates read from run-scoped artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-file-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-file@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic file',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          review: { value: '{{ nodes.file_planned_review.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'write_patch',
            type: 'exec',
            dependsOn: [],
            command: [
              'cat > "$MATOS_WORKFLOW_ARTIFACT_ROOT/file_patch.json" <<\'JSON\'',
              JSON.stringify({
                schemaVersion: 1,
                id: 'write-patch-add-file-planned-review',
                sourceNodeId: 'expand_from_file',
                reason: 'add review node from planner artifact',
                operations: [
                  {
                    op: 'add_node',
                    node: {
                      id: 'file_planned_review',
                      type: 'exec',
                      dependsOn: [],
                      command:
                        'printf file-planned-review > file-planned.txt; printf file-planned-review',
                    },
                  },
                  {
                    op: 'add_edge',
                    from: 'expand_from_file',
                    to: 'file_planned_review',
                  },
                ],
                budgetImpact: {
                  addedNodes: 1,
                  estimatedAgentCalls: 0,
                  estimatedWallMinutes: 1,
                },
                risk: 'low',
              }),
              'JSON',
            ].join('\n'),
          },
          {
            id: 'expand_from_file',
            type: 'dynamic',
            dependsOn: ['write_patch'],
            input: {
              candidatePath: '{{ workflow.artifactRoot }}/file_patch.json',
            },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.review).toBe('file-planned-review')
    expect(await readFile(join(root, 'file-planned.txt'), 'utf8')).toBe(
      'file-planned-review',
    )
  })

  test('invalid dynamic patches write validation evidence without changing the active graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-invalid-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-invalid@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic invalid',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'plan',
            type: 'dynamic',
            dependsOn: [],
            candidate: {
              schemaVersion: 1,
              sourceNodeId: 'plan',
              reason: 'invalid duplicate node',
              operations: [
                {
                  op: 'add_node',
                  node: {
                    id: 'plan',
                    type: 'exec',
                    dependsOn: [],
                    command: 'printf duplicate',
                  },
                },
              ],
              budgetImpact: {
                addedNodes: 1,
                estimatedAgentCalls: 0,
              },
              risk: 'low',
            },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('failed')
    const runSnapshot = JSON.parse(await readFile(join(run.runDir, 'run.json'), 'utf8'))
    expect(runSnapshot.graphSnapshotPath).toBe('graph.snapshot.json')
    const validation = JSON.parse(
      await readFile(
        join(run.runDir, 'dynamic-patches', 'plan-invalid-duplicate-node', 'validation.json'),
        'utf8',
      ),
    )
    expect(validation).toMatchObject({ ok: false })
    expect(
      JSON.parse(
        await readFile(
          join(run.runDir, 'dynamic-patches', 'plan-invalid-duplicate-node', 'decision.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'rejected' })
  })

  test('high-risk dynamic patches pause for human review before graph mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-review-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-review@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'dynamic review',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'plan',
            type: 'dynamic',
            dependsOn: [],
            prompt: 'Review high-risk dynamic patch',
            candidate: {
              schemaVersion: 1,
              sourceNodeId: 'plan',
              reason: 'high risk expansion',
              operations: [
                {
                  op: 'add_node',
                  node: {
                    id: 'review',
                    type: 'exec',
                    dependsOn: [],
                    command: 'printf should-not-run',
                  },
                },
              ],
              budgetImpact: {
                addedNodes: 1,
                estimatedAgentCalls: 0,
              },
              risk: 'high',
            },
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('plan')
    const runSnapshot = JSON.parse(await readFile(join(run.runDir, 'run.json'), 'utf8'))
    expect(runSnapshot.graphSnapshotPath).toBe('graph.snapshot.json')
    expect(
      JSON.parse(
        await readFile(
          join(run.runDir, 'dynamic-patches', 'plan-high-risk-expansion', 'decision.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'proposed' })
    await expect(readFile(join(root, 'should-not-run'), 'utf8')).rejects.toThrow()
  })

  test('operator policy forces low-risk dynamic patches into human review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-dynamic-operator-policy-'))
    const previous = process.env.MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL
    process.env.MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL = '1'
    try {
      const run = await startWorkflowRun({
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:dynamic-operator-policy@0.1.0',
        parameters: {},
        definition: {
          schemaVersion: 1,
          name: 'dynamic operator policy',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'plan',
              type: 'dynamic',
              dependsOn: [],
              prompt: 'Review operator-forced dynamic patch',
              candidate: {
                schemaVersion: 1,
                sourceNodeId: 'plan',
                reason: 'add local review step',
                operations: [
                  {
                    op: 'add_node',
                    node: {
                      id: 'review_step',
                      type: 'exec',
                      dependsOn: [],
                      command: 'printf review',
                    },
                  },
                ],
                budgetImpact: { addedNodes: 1, estimatedAgentCalls: 0 },
                risk: 'low',
              },
            },
          ],
        },
        workspaceDir: root,
      })

      expect(run.status).toBe('waiting_input')
      expect(run.waitingNodeId).toBe('plan')
      const decision = JSON.parse(
        await readFile(
          join(
            run.runDir,
            'dynamic-patches',
            'plan-add-local-review-step',
            'decision.json',
          ),
          'utf8',
        ),
      )
      expect(decision).toMatchObject({ status: 'proposed' })
      expect(decision.reason).toContain('operator policy')
    } finally {
      if (previous === undefined) {
        delete process.env.MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL
      } else {
        process.env.MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL = previous
      }
    }
  })

  test('guard file_exists checks absolute paths without prefixing the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-guard-absolute-'))
    const absolutePath = join(root, 'absolute-result.txt')
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:absolute@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'absolute guard',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          ok: { value: '{{ nodes.check_file.outputs.ok }}' },
        },
        nodes: [
          {
            id: 'make_file',
            type: 'exec',
            dependsOn: [],
            command: `printf ok > ${JSON.stringify(absolutePath)}`,
          },
          {
            id: 'check_file',
            type: 'guard',
            dependsOn: ['make_file'],
            checks: [{ type: 'file_exists', path: absolutePath }],
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.ok).toBe(true)
  })

  test('dispatches independent safe nodes as an opt-in scheduler batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-parallel-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:parallel@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'parallel',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low', maxConcurrency: 2 },
        outputs: {
          left: { value: '{{ nodes.left.outputs.stdout }}' },
          right: { value: '{{ nodes.right.outputs.stdout }}' },
        },
        nodes: [
          { id: 'left', type: 'exec', dependsOn: [], command: 'printf left' },
          { id: 'right', type: 'exec', dependsOn: [], command: 'printf right' },
          { id: 'join', type: 'guard', dependsOn: ['left', 'right'], checks: [] },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.left).toBe('left')
    expect(run.outputs.right).toBe('right')
    const events = await readWorkflowRunEvents(run.runDir)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'workflow.scheduler.ready_set',
          data: expect.objectContaining({ nodeIds: ['left', 'right'] }),
        }),
        expect.objectContaining({
          type: 'workflow.scheduler.node_dispatched',
          data: expect.objectContaining({ nodeId: 'left' }),
        }),
        expect.objectContaining({
          type: 'workflow.scheduler.node_dispatched',
          data: expect.objectContaining({ nodeId: 'right' }),
        }),
      ]),
    )
  })

  // Regression for engine review defect P2-5: the parallel batch used
  // Promise.all over runNode calls, so a rejection thrown before runNode's
  // try block (e.g. attempt bookkeeping IO) abandoned in-flight siblings and
  // unwound through withWorkflowRunLock, releasing the run lock while the
  // siblings were still writing state in the background.
  test('parallel batch settles in-flight siblings before reporting a pre-execution branch failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-parallel-settle-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:parallel-settle@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'parallel settle',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low', maxConcurrency: 2 },
        outputs: {},
        nodes: [
          {
            id: 'gate',
            type: 'human',
            dependsOn: [],
            prompt: 'Release the batch',
            responseSchema: { type: 'object' },
          },
          {
            id: 'boom',
            type: 'exec',
            dependsOn: ['gate'],
            command: 'printf boom-should-never-run',
          },
          {
            id: 'slow',
            type: 'exec',
            dependsOn: ['gate'],
            command:
              'sleep 1.2 && printf sibling-done > "$MATOS_WORKFLOW_ARTIFACT_ROOT/sibling.txt" && printf sibling-ok',
          },
        ],
      },
      workspaceDir: root,
    })
    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('gate')

    // Sabotage boom's bookkeeping: its attempts directory path is occupied by
    // a regular file, so runNode's pre-execution writeNodeAttempt (which runs
    // before runNode's try/catch) rejects with ENOTDIR while the sibling is
    // mid-flight.
    await mkdir(join(run.runDir, 'node-runs', 'boom'), { recursive: true })
    await writeFile(
      join(run.runDir, 'node-runs', 'boom', 'attempts'),
      'not a directory',
      'utf8',
    )

    const settled = await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'gate',
      response: { approved: true },
    })

    // The batch reports the failure instead of throwing out of the advance
    // segment.
    expect(settled.status).toBe('failed')
    const boomRun = JSON.parse(
      await readFile(join(run.runDir, 'node-runs', 'boom', 'node-run.json'), 'utf8'),
    ) as { status: string; error?: unknown }
    expect(boomRun.status).toBe('failed')
    expect(boomRun.error).toBeDefined()

    // The in-flight sibling finished all of its writes before the advance
    // segment returned (and with it, before the run lock was released).
    const slowRun = JSON.parse(
      await readFile(join(run.runDir, 'node-runs', 'slow', 'node-run.json'), 'utf8'),
    ) as { status: string }
    expect(slowRun.status).toBe('completed')
    expect(
      await readFile(join(run.artifactRoot ?? '', 'sibling.txt'), 'utf8'),
    ).toBe('sibling-done')

    // The lock is only released after every branch settled.
    expect(await readdir(run.runDir)).not.toContain('.run.lock')

    const events = await readWorkflowRunEvents(run.runDir)
    expect(
      events.some(
        event =>
          event.type === 'workflow.node.completed' &&
          event.data.nodeId === 'slow',
      ),
    ).toBe(true)
    expect(
      events.some(
        event =>
          event.type === 'workflow.node.failed' && event.data.nodeId === 'boom',
      ),
    ).toBe(true)
  })

  // Regression for engine review defect P2-4: the full exec/agent stdout used
  // to be copied verbatim into node-run.json and the workflow.node.completed
  // event payload in addition to the attempt log, so chatty multi-hour nodes
  // ballooned run dirs and events.jsonl. The attempt stdout.log keeps the
  // full transcript; the embedded copies must stay bounded head+tail
  // excerpts with byte counts and pointers to the attempt file.
  test('bounds large stdout copies in node-run.json and events while the attempt log keeps the full transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-stream-bound-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:stream-bound@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'stream bound',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'chatty',
            type: 'exec',
            dependsOn: [],
            command: [
              "printf 'HEAD-SENTINEL\\n'",
              'i=0',
              'while [ "$i" -lt 3000 ]; do printf "%064d\\n" "$i"; i=$((i+1)); done',
              "printf 'TAIL-SENTINEL\\n'",
            ].join('\n'),
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')

    // ~195KB total: under the attempt-log retention window, so the attempt
    // file holds the single full copy.
    const fullLog = await readFile(
      join(run.runDir, 'node-runs', 'chatty', 'attempts', '1', 'stdout.log'),
      'utf8',
    )
    expect(fullLog.length).toBeGreaterThan(190_000)
    expect(fullLog).toContain('HEAD-SENTINEL')
    expect(fullLog).toContain('TAIL-SENTINEL')
    expect(fullLog).not.toContain('truncated')

    const nodeRun = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'chatty', 'node-run.json'),
        'utf8',
      ),
    ) as {
      output: {
        stdout: string
        stdoutTruncated?: boolean
        stdoutChars?: number
      }
    }
    const embedded = nodeRun.output.stdout
    expect(embedded.length).toBeLessThan(70_000)
    expect(embedded).toContain('HEAD-SENTINEL')
    expect(embedded).toContain('TAIL-SENTINEL')
    expect(embedded).toContain('stream truncated for node output')
    expect(embedded).toContain('see the attempt stdout/stderr log')
    expect(nodeRun.output.stdoutTruncated).toBe(true)
    expect(nodeRun.output.stdoutChars).toBe(fullLog.length)

    const events = await readWorkflowRunEvents(run.runDir)
    const completedEvent = events.find(
      event =>
        event.type === 'workflow.node.completed' &&
        event.data.nodeId === 'chatty',
    )
    const eventStdout =
      (completedEvent?.data.output as { stdout?: string } | undefined)
        ?.stdout ?? ''
    expect(eventStdout.length).toBeGreaterThan(0)
    expect(eventStdout.length).toBeLessThan(8_000)
    expect(eventStdout).toContain('event payload truncated')
    expect(eventStdout).toContain('persisted in the node run/attempt files')
  })

  test('applies production parallel-safety policy per node type and declaration', () => {
    const node = (value: Partial<MatOSWorkflowNode>): MatOSWorkflowNode => ({
      id: 'n',
      type: 'exec',
      dependsOn: [],
      ...value,
    })

    // exec/guard stay parallel-safe by default but can opt out.
    expect(nodeParallelSafe(node({ type: 'exec' }))).toBe(true)
    expect(nodeParallelSafe(node({ type: 'guard' }))).toBe(true)
    expect(
      nodeParallelSafe(node({ type: 'exec', policy: { parallel: false } })),
    ).toBe(false)

    // agent/subworkflow/map/loop require explicit opt-in.
    expect(nodeParallelSafe(node({ type: 'agent' }))).toBe(false)
    expect(
      nodeParallelSafe(node({ type: 'agent', policy: { parallel: true } })),
    ).toBe(true)
    expect(
      nodeParallelSafe(node({ type: 'subworkflow', policy: { parallel: true } })),
    ).toBe(true)
    expect(
      nodeParallelSafe(node({ type: 'map', policy: { parallel: true } })),
    ).toBe(true)
    expect(
      nodeParallelSafe(node({ type: 'loop', policy: { parallel: true } })),
    ).toBe(true)

    // backend/compute opt-in additionally requires an idempotency declaration.
    expect(
      nodeParallelSafe(node({ type: 'backend', policy: { parallel: true } })),
    ).toBe(false)
    expect(
      nodeParallelSafe(
        node({ type: 'backend', policy: { parallel: true, idempotent: true } }),
      ),
    ).toBe(true)
    expect(
      nodeParallelSafe(
        node({
          type: 'backend',
          targetType: 'compute',
          policy: { parallel: true, idempotency: 'safe' },
        }),
      ),
    ).toBe(true)
    expect(
      nodeParallelSafe(
        node({
          type: 'backend',
          targetType: 'compute',
          policy: { parallel: true, replaySafe: true },
        }),
      ),
    ).toBe(true)
    expect(
      nodeParallelSafe(
        node({ type: 'backend', targetType: 'compute', policy: { parallel: true } }),
      ),
    ).toBe(false)
    // Literal target-form compute nodes follow the same compute policy.
    expect(
      nodeParallelSafe(
        node({ type: 'compute', policy: { parallel: true, idempotent: true } }),
      ),
    ).toBe(true)
    expect(
      nodeParallelSafe(node({ type: 'compute', policy: { parallel: true } })),
    ).toBe(false)

    // human/dynamic never run in parallel, even with explicit opt-in.
    expect(
      nodeParallelSafe(node({ type: 'human', policy: { parallel: true } })),
    ).toBe(false)
    expect(
      nodeParallelSafe(node({ type: 'dynamic', policy: { parallel: true } })),
    ).toBe(false)
  })

  test('caps workflow concurrency at 8 unless high concurrency is opted in', () => {
    const definition = (
      policy: Record<string, unknown>,
    ): Parameters<typeof workflowMaxConcurrency>[0] => ({
      schemaVersion: 1,
      name: 'concurrency-policy',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low', ...policy },
      outputs: {},
      nodes: [],
    })

    expect(workflowMaxConcurrency(definition({}))).toBe(1)
    expect(workflowMaxConcurrency(definition({ maxConcurrency: 1 }))).toBe(1)
    expect(workflowMaxConcurrency(definition({ maxConcurrency: 4 }))).toBe(4)
    expect(workflowMaxConcurrency(definition({ maxConcurrency: 20 }))).toBe(8)
    expect(
      workflowMaxConcurrency(
        definition({ concurrency: { maxParallel: 6 } }),
      ),
    ).toBe(6)
    expect(
      workflowMaxConcurrency(
        definition({ maxConcurrency: 20, allowHighConcurrency: true }),
      ),
    ).toBe(20)
    expect(
      workflowMaxConcurrency(
        definition({ maxConcurrency: 100, allowHighConcurrency: true }),
      ),
    ).toBe(32)
    expect(
      workflowMaxConcurrency(
        definition({
          concurrency: { maxParallel: 100 },
          allowHighConcurrency: true,
        }),
      ),
    ).toBe(32)
  })

  test('routes explicit external tool failures into recovery nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-failure-route-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:failure-route@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'failure-route',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          recovered: { value: '{{ nodes.recover.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'external_tool',
            type: 'exec',
            dependsOn: [],
            command: 'printf tool-failed >&2; exit 42',
          },
          {
            id: 'recover',
            type: 'exec',
            dependsOn: ['external_tool'],
            command: 'printf recovered',
          },
          {
            id: 'success_only',
            type: 'exec',
            dependsOn: ['external_tool'],
            command: 'printf should-not-run',
          },
        ],
        edges: [
          { from: 'external_tool', to: 'recover', route: 'failure' },
          { from: 'external_tool', to: 'success_only', route: 'success' },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.recovered).toBe('recovered')
    const events = await readWorkflowRunEvents(run.runDir)
    expect(events.map(event => event.type)).toEqual(
      expect.arrayContaining([
        'workflow.node.failed',
        'workflow.node.completed',
        'workflow.run.completed',
      ]),
    )
  })

  test('resolves workflow parameter templates with default values in node fields and outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-parameters-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:parameters@0.1.0',
      parameters: { message: 'parameter-ok' },
      definition: {
        schemaVersion: 1,
        name: 'parameters',
        parameters: {
          message: { type: 'string', default: 'default-message' },
          resultFile: { type: 'string', default: 'result.txt' },
        },
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          message: { value: '{{ parameters.message }}' },
          resultFile: { value: '{{ parameters.resultFile }}' },
        },
        nodes: [
          {
            id: 'write_file',
            type: 'exec',
            dependsOn: [],
            command:
              'printf "{{ parameters.message }}" > "{{ parameters.resultFile }}"',
          },
        ],
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.message).toBe('parameter-ok')
    expect(run.outputs.resultFile).toBe('result.txt')
    expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('parameter-ok')
  })

  test('agent nodes resolve roles through existing MatOS runtime projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-agent-'))
    const result = await buildWorkflowAgentNodeInvocation({
      cwd: root,
      role: 'role:compute',
      prompt: 'Return JSON {"ok": true}.',
      passthroughArgs: ['--model', 'deepseek-v4-flash'],
    })

    expect(result.agentArgs).toContain('--agent')
    expect(result.agentArgs).toContain('compute')
    expect(result.agentArgs).toContain('--dangerously-skip-permissions')
    expect(result.agentArgs).toContain('--model')
    expect(result.agentArgs).toContain('deepseek-v4-flash')
    // fs-heavy real role projection/materialization; runs on vePFS TMPDIR and
    // under concurrent suite load, so allow generous margin over the ~5s default.
  }, WORKFLOW_AGENT_NODE_TEST_TIMEOUT_MS)

  test('agent nodes do not accept workflow-local max turn caps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-agent-turns-'))
    const result = await buildWorkflowAgentNodeInvocation({
      cwd: root,
      role: 'role:compute',
      prompt: 'Return JSON {"ok": true}.',
      passthroughArgs: [
        '--model',
        'deepseek-v4-flash',
        '--max-turns',
        '1',
        '--max-turns=2',
      ],
    })

    expect(result.agentArgs).toContain('--model')
    expect(result.agentArgs).toContain('deepseek-v4-flash')
    expect(result.agentArgs).not.toContain('--max-turns')
    expect(result.agentArgs).not.toContain('1')
    expect(result.agentArgs.some(arg => arg.startsWith('--max-turns='))).toBe(
      false,
    )
  }, WORKFLOW_AGENT_NODE_TEST_TIMEOUT_MS)

  test('agent nodes merge Coze system prompt into runtime task prompt', () => {
    expect(
      workflowAgentPrompt({
        id: 'plan',
        type: 'agent',
        dependsOn: [],
        role: 'role:compute',
        systemPrompt: 'Prefer concise evidence.',
        prompt: 'Rank candidates.',
      }),
    ).toBe(
      [
        'Workflow node system instructions:',
        'Prefer concise evidence.',
        '',
        'Workflow node user task:',
        'Rank candidates.',
      ].join('\n'),
    )
  })

  test('agent nodes can append explicit small artifact content to prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-agent-artifact-context-'))
    const artifactPath = join(root, 'summary.txt')
    await writeFile(artifactPath, 'capacity = 2.09 Ah\nrate = 0.5C\n', 'utf8')

    const prompt = await workflowAgentPromptWithArtifactContext(
      {
        id: 'assess',
        type: 'agent',
        dependsOn: [],
        role: 'role:compute',
        prompt: 'Assess the battery result.',
        artifactContext: {
          resultSummary: {
            id: 'summary',
            path: artifactPath,
          },
        },
      },
      { cwd: root },
    )

    expect(prompt).toContain('Assess the battery result.')
    expect(prompt).toContain('Workflow artifact context:')
    expect(prompt).toContain('capacity = 2.09 Ah')
    expect(prompt).toContain(artifactPath)
  })

  test('normalizes SDK result envelope usage into attempt usage', async () => {
    const { usageFromSdkResultMessage } = await import(
      './nodeAdapters/agentNode.js'
    )

    expect(
      usageFromSdkResultMessage({
        type: 'result',
        subtype: 'success',
        result: 'OK',
        num_turns: 3,
        total_cost_usd: 0.0042,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 10,
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 10,
      totalTokens: 135,
      agentTurns: 3,
      totalCostUsd: 0.0042,
    })

    expect(
      usageFromSdkResultMessage({ type: 'assistant', message: {} }),
    ).toBeUndefined()
    expect(usageFromSdkResultMessage({ type: 'result' })).toBeUndefined()
  })

  test('runs subworkflow nodes as child workflow runs and mirrors child outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-subworkflow-'))
    const workflowRunsDir = join(root, 'custom-workflow-runs')
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'child')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'child',
      type: 'workflow',
      name: 'Child',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'child',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        ready: { value: '{{ nodes.make_file.outputs.stdout }}' },
        recordPath: { value: '{{ workflow.workspaceDir }}/child.txt' },
      },
      nodes: [
        {
          id: 'make_file',
          type: 'exec',
          dependsOn: [],
          command: 'printf ready > child.txt && printf ready',
        },
        {
          id: 'check_file',
          type: 'guard',
          dependsOn: ['make_file'],
          checks: [{ type: 'file_exists', path: 'child.txt' }],
        },
      ],
    })

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRunsDir,
      workflowRef: 'workflow:parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'child_run',
            type: 'subworkflow',
            dependsOn: [],
            workflow: 'workflow:child',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    const nodeOutput = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'child_run', 'node-run.json'),
        'utf8',
      ),
    ).output as {
      childRunId: string
      status: string
      outputs: Record<string, unknown>
    }
    expect(nodeOutput.childRunId).toStartWith('run_')
    expect(nodeOutput.status).toBe('completed')
    expect(nodeOutput.outputs.ready).toBe('ready')
    expect(nodeOutput.outputs.recordPath).toBe(join(root, 'child.txt'))
    expect(run.runDir.startsWith(workflowRunsDir)).toBe(true)
    expect(
      JSON.parse(
        await readFile(
          join(workflowRunsDir, nodeOutput.childRunId, 'run.json'),
          'utf8',
        ),
      ).runId,
    ).toBe(nodeOutput.childRunId)
    expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('ready')
    expect(
      JSON.parse(
        await readFile(join(run.runDir, 'artifacts.json'), 'utf8'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'child_run:outputs.recordPath',
          nodeId: 'child_run',
          kind: 'recordPath',
          path: join(root, 'child.txt'),
        }),
      ]),
    )
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toEqual(
      expect.arrayContaining([
        'workflow.subworkflow.started',
        'workflow.subworkflow.completed',
      ]),
    )
  })

  test('denies backend approval requests by failing the waiting node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-backend-deny-'))
    const workspace = join(root, 'workspace')
    const workdir = join(workspace, 'attempt-01')
    await mkdir(workdir, { recursive: true })

    const started = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:backend-deny@0.1.0',
      parameters: {},
      workspaceDir: workspace,
      definition: {
        schemaVersion: 1,
        name: 'backend deny',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'generate_yaml',
            type: 'backend',
            dependsOn: [],
            backend: 'hpc-queue',
            tool: 'tool:hpc-generate-yaml',
            policy: { approval: 'ask' },
            input: {
              taskName: 'workflow-backend-deny',
              workdir,
              entrypoint: 'echo ok',
            },
          },
        ],
      },
    })

    const denied = await denyWorkflowNode({
      runDir: started.runDir,
      nodeId: 'generate_yaml',
      reason: 'not safe enough',
    })

    expect(denied.status).toBe('failed')
    expect((await readWorkflowRunEvents(started.runDir)).map(event => event.type)).toEqual(
      expect.arrayContaining([
        'workflow.approval.requested',
        'workflow.approval.denied',
      ]),
    )
  })

  test('retries a failed node without re-running completed siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-retry-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'retry',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          result: { value: '{{ nodes.flaky.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'stable',
            type: 'exec',
            dependsOn: [],
            command: 'printf stable >> stable.log',
          },
          {
            id: 'flaky',
            type: 'exec',
            dependsOn: ['stable'],
            command:
              'if [ ! -f retry-marker ]; then touch retry-marker; echo first >&2; exit 7; fi; printf retry-ok',
          },
        ],
      },
    })

    expect(run.status).toBe('failed')
    const retried = await retryWorkflowNode({
      runDir: run.runDir,
      nodeId: 'flaky',
    })

    expect(retried.status).toBe('completed')
    expect(retried.outputs.result).toBe('retry-ok')
    expect(await readFile(join(root, 'stable.log'), 'utf8')).toBe('stable')

    const nodeRun = JSON.parse(
      await readFile(join(run.runDir, 'node-runs', 'flaky', 'node-run.json'), 'utf8'),
    )
    expect(nodeRun.attempts).toBe(2)
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toEqual(
      expect.arrayContaining(['workflow.node.retry_requested']),
    )
  })

  test('automatically retries retryable nodes according to node policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-auto-retry-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:auto-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'auto-retry',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          result: { value: '{{ nodes.flaky.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'flaky',
            type: 'exec',
            dependsOn: [],
            policy: {
              retry: {
                maxAttempts: 2,
                retryableExitCodes: [7],
                backoffMs: 0,
              },
            },
            command:
              'if [ ! -f auto-retry-marker ]; then touch auto-retry-marker; exit 7; fi; printf auto-retry-ok',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.result).toBe('auto-retry-ok')
    const nodeRun = JSON.parse(
      await readFile(join(run.runDir, 'node-runs', 'flaky', 'node-run.json'), 'utf8'),
    )
    expect(nodeRun.attempts).toBe(2)
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toEqual(
      expect.arrayContaining(['workflow.node.retry_scheduled']),
    )
  })

  test('validate retry recommendation reruns a named upstream node without rerunning completed siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-validate-retry-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validate-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validate-retry',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          value: { value: '{{ nodes.produce.outputs.stdout }}' },
          recommendation: {
            value: '{{ nodes.validate_quality.outputs.recommendation }}',
          },
        },
        nodes: [
          {
            id: 'stable',
            type: 'exec',
            dependsOn: [],
            command: 'printf stable >> stable.log',
          },
          {
            id: 'produce',
            type: 'exec',
            dependsOn: ['stable'],
            command:
              'if [ ! -f validation-retry-marker ]; then touch validation-retry-marker; printf bad > result.txt; printf bad; else printf good > result.txt; printf good; fi',
          },
          {
            id: 'validate_quality',
            type: 'validate',
            dependsOn: ['produce'],
            recommendation: 'retry',
            retryNodeId: 'produce',
            policy: { retry: { maxAttempts: 2, backoffMs: 0 } },
            checks: [{ type: 'grep', path: 'result.txt', pattern: 'good' }],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.value).toBe('good')
    expect(run.outputs.recommendation).toBe('continue')
    expect(await readFile(join(root, 'stable.log'), 'utf8')).toBe('stable')

    const produceRun = JSON.parse(
      await readFile(join(run.runDir, 'node-runs', 'produce', 'node-run.json'), 'utf8'),
    )
    const validateRun = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'validate_quality', 'node-run.json'),
        'utf8',
      ),
    )
    expect(produceRun.attempts).toBe(2)
    expect(validateRun.attempts).toBe(2)
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.validation.retry_requested',
    )
  })

  test('validate human_review recommendation pauses with preserved validation output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-validate-review-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validate-review@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validate-review',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'validate_quality',
            type: 'validate',
            dependsOn: [],
            recommendation: 'human_review',
            prompt: 'Review validation failure',
            checks: [{ type: 'file_exists', path: 'missing.txt' }],
          },
        ],
      },
    })

    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('validate_quality')
    const nodeRun = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'validate_quality', 'node-run.json'),
        'utf8',
      ),
    )
    expect(nodeRun).toMatchObject({
      status: 'waiting_input',
      output: {
        ok: false,
        recommendation: 'human_review',
      },
    })
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.validation.human_review_requested',
    )
  })

  test('does not automatically retry terminal node failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-terminal-retry-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:terminal-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'terminal-retry',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'terminal',
            type: 'exec',
            dependsOn: [],
            policy: {
              retry: {
                maxAttempts: 3,
                retryableExitCodes: [7],
                backoffMs: 0,
              },
            },
            command: 'exit 9',
          },
        ],
      },
    })

    expect(run.status).toBe('failed')
    const nodeRun = JSON.parse(
      await readFile(
        join(run.runDir, 'node-runs', 'terminal', 'node-run.json'),
        'utf8',
      ),
    )
    expect(nodeRun.attempts).toBe(1)
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).not.toContain(
      'workflow.node.retry_scheduled',
    )
  })

  test('pauses, resumes, and skips failed workflow nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-pause-skip-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:pause-skip@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'pause-skip',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'review',
            type: 'human',
            dependsOn: [],
            prompt: 'Continue?',
          },
          {
            id: 'always_fail',
            type: 'exec',
            dependsOn: ['review'],
            command: 'exit 9',
          },
        ],
      },
    })

    expect(run.status).toBe('waiting_input')
    const paused = await pauseWorkflowRun(run.runDir)
    expect(paused.status).toBe('paused')
    const resumed = await resumeWorkflowRun(run.runDir)
    expect(resumed.status).toBe('waiting_input')

    const failed = await respondToWorkflowNode({
      runDir: run.runDir,
      nodeId: 'review',
      response: { approved: true },
    })
    expect(failed.status).toBe('failed')

    const skipped = await skipWorkflowNode({
      runDir: run.runDir,
      nodeId: 'always_fail',
      reason: 'operator skipped failed optional node',
    })
    expect(skipped.status).toBe('completed')
    const inspected = await skipWorkflowNode({
      runDir: run.runDir,
      nodeId: 'always_fail',
      reason: 'idempotent skip',
    }).catch(error => error)
    expect(inspected).toBeInstanceOf(Error)
  })
})

describe('MatOS workflow cooperative cancel', () => {
  test('cancels an idle waiting run through the cooperative request path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-coop-cancel-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:coop@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'coop',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'review',
            type: 'human',
            dependsOn: [],
            prompt: 'Review',
            responseSchema: { type: 'object' },
          },
        ],
      },
      workspaceDir: root,
    })
    expect(run.status).toBe('waiting_input')

    const cancelled = await requestWorkflowRunCancel(run.runDir)
    expect(cancelled.status).toBe('cancelled')
  })

  test('terminates a local exec child even after it starts a new session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-local-cancel-'))
    const pidPath = join(root, 'escaped.pid')
    const started = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:local-cancel@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'local cancel',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'launch',
            type: 'human',
            dependsOn: [],
            prompt: 'Launch local process',
            responseSchema: { type: 'object' },
          },
          {
            id: 'long_exec',
            type: 'exec',
            dependsOn: ['launch'],
            command: `setsid sleep 30 >/dev/null 2>&1 & printf "%s" "$!" > "${pidPath}"; wait`,
          },
        ],
      },
      workspaceDir: root,
    })
    expect(started.status).toBe('waiting_input')

    const advancing = respondToWorkflowNode({
      runDir: started.runDir,
      nodeId: 'launch',
      response: { launch: true },
    })
    let escapedPid: number | undefined
    for (let index = 0; index < 100; index += 1) {
      const value = await readFile(pidPath, 'utf8').catch(() => '')
      if (value.trim()) {
        escapedPid = Number(value.trim())
        break
      }
      await Bun.sleep(20)
    }
    expect(escapedPid).toBeNumber()

    await requestWorkflowRunCancel(started.runDir)
    const cancelled = await advancing
    expect(cancelled.status).toBe('cancelled')
    let processState: string | undefined
    for (let index = 0; index < 20 && escapedPid; index += 1) {
      const stat = await readFile(`/proc/${escapedPid}/stat`, 'utf8').catch(
        () => '',
      )
      processState = stat.split(' ')[2]
      if (!processState || processState === 'Z') {
        break
      }
      await Bun.sleep(50)
    }
    expect(!processState || processState === 'Z').toBe(true)
  }, 10000)

  test('honors a cancel control marker at the next node boundary instead of running pending work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-coop-marker-'))
    const workflowsDir = join(root, 'workflows')
    const handle = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir: join(workflowsDir, 'runs'),
      workflowRef: 'workflow:coop-marker@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'coop-marker',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'make_file',
            type: 'exec',
            dependsOn: [],
            command: 'printf ran > coop-marker-ran.txt',
          },
        ],
      },
    })
    // Force the run into 'running' with the node still pending, then drop a
    // cooperative cancel marker as a requester would when the advancer holds the
    // run lock. Advancing must honor the marker before running the pending node.
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
    })
    await writeFile(
      join(handle.dir, 'control.json'),
      `${JSON.stringify({ action: 'cancel', requestedAt: new Date().toISOString() })}\n`,
      'utf8',
    )

    const result = await resumeWorkflowRun(handle.dir)
    expect(result.status).toBe('cancelled')
    const nodeRan = await readFile(join(root, 'coop-marker-ran.txt'), 'utf8')
      .then(() => true)
      .catch(() => false)
    expect(nodeRan).toBe(false)
  })

  test('records an in-flight node as cancelled instead of retrying its abort failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-active-cancel-'))
    const workflowsDir = join(root, 'workflows')
    const handle = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir: join(workflowsDir, 'runs'),
      workflowRef: 'workflow:active-cancel@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'active-cancel',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'long_node',
            type: 'exec',
            dependsOn: [],
            command:
              'printf started > active-cancel-started.txt; sleep 5; exit 17',
            policy: { retry: { maxAttempts: 3 } },
          },
        ],
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'running',
    })

    const advancing = resumeWorkflowRun(handle.dir)
    // Wait for the node to signal it started before requesting the cancel, so
    // the request reliably lands while the first attempt is in flight instead
    // of at the pre-node boundary (which would cancel the run without a
    // long_node record) on slow or heavily loaded hosts.
    const startedPath = join(root, 'active-cancel-started.txt')
    const startDeadline = Date.now() + 10_000
    while (Date.now() < startDeadline) {
      const started = await readFile(startedPath, 'utf8')
        .then(() => true)
        .catch(() => false)
      if (started) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await writeFile(
      join(handle.dir, 'control.json'),
      `${JSON.stringify({ action: 'cancel', requestedAt: new Date().toISOString() })}\n`,
      'utf8',
    )

    const result = await advancing
    expect(result.status).toBe('cancelled')
    expect(result.nodes?.find(node => node.nodeId === 'long_node')).toMatchObject({
      status: 'cancelled',
      attempts: 1,
    })
    expect((await readWorkflowRunEvents(handle.dir)).map(event => event.type)).toEqual(
      expect.arrayContaining([
        'workflow.node.cancelled',
        'workflow.run.cancelled',
      ]),
    )
    // The cooperative marker does not interrupt the in-flight command; the
    // attempt runs its full `sleep 5` before the abort failure is classified,
    // so the default 5000ms test timeout can never fit it.
  }, 15000)

  test('propagates cancel to non-terminal child workflow runs it spawned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-child-cancel-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')
    const graphSnapshot = {
      schemaVersion: 1,
      name: 'child-cancel',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [{ id: 'sub', type: 'subworkflow', dependsOn: [], workflow: 'workflow:child@0.1.0' }],
    }
    const parent = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot,
    })
    const coupledChild = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:child@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot,
    })
    const detachedChild = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:child@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot,
    })
    // Simulate a crash-interrupted subtree: both children were left in a
    // non-terminal state while the parent is still waiting for input.
    for (const child of [coupledChild, detachedChild]) {
      await writeWorkflowRun(child.dir, {
        ...(await readWorkflowRun(child.dir)),
        status: 'waiting_input',
        waitingNodeId: 'sub',
      })
    }
    await writeWorkflowRun(parent.dir, {
      ...(await readWorkflowRun(parent.dir)),
      status: 'waiting_input',
      waitingNodeId: 'sub',
    })
    await writeFile(
      join(parent.dir, 'child-runs', 'sub-coupled.json'),
      `${JSON.stringify({ nodeId: 'sub', childRunId: coupledChild.runId, status: 'waiting_input', detachOnParentCancel: false })}\n`,
      'utf8',
    )
    await writeFile(
      join(parent.dir, 'child-runs', 'sub-detached.json'),
      `${JSON.stringify({ nodeId: 'sub', childRunId: detachedChild.runId, status: 'waiting_input', detachOnParentCancel: true })}\n`,
      'utf8',
    )

    const cancelled = await cancelWorkflowRun(parent.dir)
    expect(cancelled.status).toBe('cancelled')

    expect((await readWorkflowRun(coupledChild.dir)).status).toBe('cancelled')
    // A subworkflow that opted out of parent cancel keeps running independently.
    expect((await readWorkflowRun(detachedChild.dir)).status).toBe('waiting_input')

    const parentEvents = (await readWorkflowRunEvents(parent.dir)).map(event => event.type)
    expect(parentEvents).toEqual(
      expect.arrayContaining([
        'workflow.child_run.cancelled',
        'workflow.child_run.cancel_detached',
        'workflow.run.cancelled',
      ]),
    )
    const childEvents = (await readWorkflowRunEvents(coupledChild.dir)).map(event => event.type)
    expect(childEvents).toContain('workflow.run.cancelled')
  })

  test('resume adopts a completed child run for a crash-interrupted subworkflow node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-subworkflow-adopt-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')

    // A child run that already reached `completed` before the parent process
    // crashed. It lives in the shared runs dir, as real child runs do.
    const childRun = await startWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:adopt-child@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'adopt-child',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          message: { value: '{{ nodes.emit.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'emit',
            type: 'exec',
            dependsOn: [],
            command: 'printf child-output',
          },
        ],
      },
    })
    expect(childRun.status).toBe('completed')

    const parent = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:adopt-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'adopt-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'child_step',
            type: 'subworkflow',
            dependsOn: [],
            workflow: 'workflow:adopt-child@0.1.0',
          },
          {
            id: 'after',
            type: 'exec',
            dependsOn: ['child_step'],
            command: 'printf after-ok',
          },
        ],
      },
    })

    // Simulate the crash window: the runner marked the node running and
    // persisted the child-run marker, then died before adopting the child
    // result. The child-carrier node must not be blindly reset (its child
    // already ran), so resume previously looped forever without progress.
    const startedAt = new Date().toISOString()
    await writeWorkflowRun(parent.dir, {
      ...(await readWorkflowRun(parent.dir)),
      status: 'running',
    })
    await mkdir(join(parent.dir, 'node-runs', 'child_step', 'attempts', '1'), {
      recursive: true,
    })
    await writeJson(join(parent.dir, 'node-runs', 'child_step', 'node-run.json'), {
      nodeId: 'child_step',
      status: 'running',
      attempts: 1,
      startedAt,
      updatedAt: startedAt,
      output: { childRunId: childRun.runId, status: 'created', outputs: {} },
    })
    await writeJson(
      join(parent.dir, 'node-runs', 'child_step', 'attempts', '1', 'attempt.json'),
      { nodeId: 'child_step', attempt: 1, status: 'running', startedAt },
    )
    await writeJson(join(parent.dir, 'child-runs', 'child_step.json'), {
      nodeId: 'child_step',
      workflowRef: 'workflow:adopt-child@0.1.0',
      childRunId: childRun.runId,
      status: 'created',
      detachOnParentCancel: false,
    })

    const resumed = await resumeWorkflowRun(parent.dir)

    expect(resumed.status).toBe('completed')
    const nodeRun = JSON.parse(
      await readFile(
        join(parent.dir, 'node-runs', 'child_step', 'node-run.json'),
        'utf8',
      ),
    )
    // The child result was adopted: same child run id, child outputs mirrored,
    // and the crashed attempt finalized instead of a new attempt being opened.
    expect(nodeRun).toMatchObject({
      status: 'completed',
      attempts: 1,
      output: {
        childRunId: childRun.runId,
        status: 'completed',
        outputs: { message: 'child-output' },
      },
    })
    const afterRun = JSON.parse(
      await readFile(join(parent.dir, 'node-runs', 'after', 'node-run.json'), 'utf8'),
    )
    expect(afterRun.status).toBe('completed')
    // No duplicate child run was started: only the parent and the original
    // child exist in the runs dir.
    const runDirs = (await readdir(workflowRunsDir)).filter(name =>
      name.startsWith('run_'),
    )
    expect(runDirs.sort()).toEqual(
      [parent.runId, childRun.runId].sort(),
    )
    expect(
      JSON.parse(
        await readFile(join(parent.dir, 'child-runs', 'child_step.json'), 'utf8'),
      ).status,
    ).toBe('completed')
    expect((await readWorkflowRunEvents(parent.dir)).map(event => event.type)).toEqual(
      expect.arrayContaining([
        'workflow.recovery.child_run_reconciled',
        'workflow.subworkflow.completed',
        'workflow.run.completed',
      ]),
    )
  })

  test('resume adopts a failed child run and does not resurrect the failed parent run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-subworkflow-adopt-failed-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')

    const childRun = await startWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:adopt-failed-child@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'adopt-failed-child',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [{ id: 'boom', type: 'exec', dependsOn: [], command: 'exit 7' }],
      },
    })
    expect(childRun.status).toBe('failed')

    const parent = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:adopt-failed-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'adopt-failed-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'child_step',
            type: 'subworkflow',
            dependsOn: [],
            workflow: 'workflow:adopt-failed-child@0.1.0',
          },
        ],
      },
    })
    const startedAt = new Date().toISOString()
    await writeWorkflowRun(parent.dir, {
      ...(await readWorkflowRun(parent.dir)),
      status: 'running',
    })
    await mkdir(join(parent.dir, 'node-runs', 'child_step'), { recursive: true })
    await writeJson(join(parent.dir, 'node-runs', 'child_step', 'node-run.json'), {
      nodeId: 'child_step',
      status: 'running',
      attempts: 1,
      startedAt,
      updatedAt: startedAt,
      output: { childRunId: childRun.runId, status: 'created', outputs: {} },
    })
    await writeJson(join(parent.dir, 'child-runs', 'child_step.json'), {
      nodeId: 'child_step',
      workflowRef: 'workflow:adopt-failed-child@0.1.0',
      childRunId: childRun.runId,
      status: 'created',
      detachOnParentCancel: false,
    })

    const resumed = await resumeWorkflowRun(parent.dir)

    // The adopted failure terminates the run; resume must not flip it back to
    // running (which would restart the whole no-op resume loop).
    expect(resumed.status).toBe('failed')
    const nodeRun = JSON.parse(
      await readFile(
        join(parent.dir, 'node-runs', 'child_step', 'node-run.json'),
        'utf8',
      ),
    )
    expect(nodeRun).toMatchObject({ status: 'failed', attempts: 1 })
    expect(nodeRun.error.message).toContain(
      'Subworkflow did not complete: child_step (failed)',
    )
    expect(nodeRun.output).toMatchObject({
      childRunId: childRun.runId,
      status: 'failed',
    })
  })

  test('resume reparks a crash-interrupted human node instead of deadlocking on running', async () => {
    // P1-2: a human node persisted as `running` (crash between markNode and
    // the waiting transition) is neither covered by the rerun-strategy reset
    // nor the child-carrier reconcile. Left running, the advance loop counts
    // it as in-flight progress forever and recovery just re-suggests resume.
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-human-repark-'))
    const workflowsDir = join(root, 'workflows')
    const run = await createWorkflowRun({
      workflowsDir,
      workflowRef: 'workflow:human-repark@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'human-repark',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          { id: 'review', type: 'human', dependsOn: [], prompt: 'review please' },
        ],
      },
    })
    const startedAt = new Date().toISOString()
    await writeWorkflowRun(run.dir, {
      ...(await readWorkflowRun(run.dir)),
      status: 'running',
    })
    await mkdir(join(run.dir, 'node-runs', 'review'), { recursive: true })
    await writeJson(join(run.dir, 'node-runs', 'review', 'node-run.json'), {
      nodeId: 'review',
      status: 'running',
      attempts: 1,
      startedAt,
      updatedAt: startedAt,
    })

    const resumed = await resumeWorkflowRun(run.dir)

    // The interrupted human node is re-parked for input; nothing is left
    // `running`, so the run reaches a real waiting state instead of a no-op
    // resume deadlock.
    expect(resumed.status).toBe('waiting_input')
    const nodeRun = JSON.parse(
      await readFile(
        join(run.dir, 'node-runs', 'review', 'node-run.json'),
        'utf8',
      ),
    )
    expect(nodeRun.status).toBe('waiting_input')
  })

  test('resume resets a crash-interrupted map node and re-runs it to completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-reset-'))
    const workflowsDir = join(root, 'workflows')
    const workflowRunsDir = join(workflowsDir, 'runs')
    const leafDir = join(root, '.matos', 'assets', 'workflows', 'reset-leaf')
    await mkdir(leafDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(leafDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'reset-leaf',
      type: 'workflow',
      name: 'Reset Leaf',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'component' } },
    })
    await writeJson(join(leafDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'reset-leaf',
      parameters: { item: { type: 'string', default: 'none' } },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'leaf', type: 'exec', dependsOn: [], command: 'printf leaf-ok' },
      ],
    })

    const parent = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:map-reset@0.1.0',
      parameters: {},
      projectCwd: root,
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'map-reset',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'fanout',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:reset-leaf',
            items: ['only'],
            itemParameter: 'item',
          },
        ],
      },
    })
    // Crash mid-map: node running, but no adoptable aggregate child record.
    const startedAt = new Date().toISOString()
    await writeWorkflowRun(parent.dir, {
      ...(await readWorkflowRun(parent.dir)),
      status: 'running',
    })
    await mkdir(join(parent.dir, 'node-runs', 'fanout'), { recursive: true })
    await writeJson(join(parent.dir, 'node-runs', 'fanout', 'node-run.json'), {
      nodeId: 'fanout',
      status: 'running',
      attempts: 1,
      startedAt,
      updatedAt: startedAt,
    })

    const resumed = await resumeWorkflowRun(parent.dir)

    expect(resumed.status).toBe('completed')
    const nodeRun = JSON.parse(
      await readFile(join(parent.dir, 'node-runs', 'fanout', 'node-run.json'), 'utf8'),
    )
    // Reset preserved the crashed attempt counter, so the re-run is attempt 2.
    expect(nodeRun).toMatchObject({ status: 'completed', attempts: 2 })
    expect(nodeRun.output.count).toBe(1)
    const events = await readWorkflowRunEvents(parent.dir)
    expect(
      events.find(
        event =>
          event.type === 'workflow.recovery.node_reset' &&
          (event.data as { reason?: string }).reason === 'interrupted_child_carrier',
      ),
    ).toBeDefined()
  })

  test('propagates a root cancel through active loop and map children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-live-child-cancel-'))
    const workflowsDir = join(root, 'workflows')
    const childDir = join(root, '.matos', 'assets', 'workflows', 'cancel-child')
    const leafDir = join(root, '.matos', 'assets', 'workflows', 'cancel-leaf')
    await mkdir(childDir, { recursive: true })
    await mkdir(leafDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(childDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'cancel-child',
      type: 'workflow',
      name: 'Cancel Child',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'component' } },
    })
    await writeJson(join(childDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'cancel-child',
      parameters: { iteration: { type: 'number', default: 1 } },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'branches',
          type: 'map',
          dependsOn: [],
          workflow: 'workflow:cancel-leaf',
          items: ['only'],
          itemParameter: 'item',
        },
      ],
    })
    await writeJson(join(leafDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'cancel-leaf',
      type: 'workflow',
      name: 'Cancel Leaf',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'component' } },
    })
    await writeJson(join(leafDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'cancel-leaf',
      parameters: { item: { type: 'string', default: 'none' } },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'active',
          type: 'exec',
          dependsOn: [],
          command: 'sleep 0.3; exit 17',
          policy: { retry: { maxAttempts: 3 } },
        },
      ],
    })

    let parentRunDir = ''
    let notifyCreated: (() => void) | undefined
    const parentCreated = new Promise<void>(resolve => {
      notifyCreated = resolve
    })
    const advancing = startWorkflowRun({
      cwd: root,
      workflowsDir,
      workflowRef: 'workflow:cancel-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      onCreated: run => {
        parentRunDir = run.runDir
        notifyCreated?.()
      },
      definition: {
        schemaVersion: 1,
        name: 'cancel-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'rounds',
            type: 'loop',
            dependsOn: [],
            workflow: 'workflow:cancel-child',
            maxIterations: 1,
            iterationParameter: 'iteration',
          },
        ],
      },
    })
    await parentCreated

    const activeIterationPath = join(
      parentRunDir,
      'iterations',
      'rounds',
      '1',
      'iteration.json',
    )
    let activeIteration: { childRunId: string; status: string } | undefined
    for (let attempt = 0; attempt < 50 && !activeIteration; attempt += 1) {
      activeIteration = await readFile(activeIterationPath, 'utf8')
        .then(text => JSON.parse(text) as { childRunId: string; status: string })
        .catch(() => undefined)
      if (!activeIteration) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    expect(activeIteration).toMatchObject({ status: 'running' })

    const childRunDir = join(dirname(parentRunDir), activeIteration!.childRunId)
    const activeLeafPath = join(
      childRunDir,
      'iterations',
      'branches',
      '1',
      'iteration.json',
    )
    let activeLeaf: { childRunId: string; status: string } | undefined
    for (let attempt = 0; attempt < 50 && !activeLeaf; attempt += 1) {
      activeLeaf = await readFile(activeLeafPath, 'utf8')
        .then(text => JSON.parse(text) as { childRunId: string; status: string })
        .catch(() => undefined)
      if (!activeLeaf) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    expect(activeLeaf).toMatchObject({ status: 'running' })

    const requested = await requestWorkflowRunCancel(parentRunDir)
    const parent = await advancing
    expect(requested.status).toBe('cancelled')
    expect(parent.status).toBe('cancelled')

    const child = await readWorkflowRun(childRunDir)
    expect(child.status).toBe('cancelled')
    expect(childRunDir).not.toBe(parentRunDir)

    const leafRunDir = join(dirname(parentRunDir), activeLeaf!.childRunId)
    const leafView = await inspectWorkflowRun(leafRunDir)
    expect(leafView.status).toBe('cancelled')
    expect(leafView.nodes?.find(node => node.nodeId === 'active')).toMatchObject({
      status: 'cancelled',
      attempts: 1,
    })
  })
})

describe('MatOS workflow elapsed wall-clock budget', () => {
  test('enforces maxElapsedWallTimeMs against real run age, not summed attempt time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-elapsed-budget-'))
    const workflowsDir = join(root, 'workflows')
    const handle = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir: join(workflowsDir, 'runs'),
      workflowRef: 'workflow:elapsed@0.1.0',
      parameters: {},
      workspaceDir: root,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'elapsed',
        parameters: {},
        policy: {
          approvalMode: 'bypass',
          defaultRisk: 'low',
          budget: { maxElapsedWallTimeMs: 1000, onExceeded: 'fail' },
        },
        outputs: {},
        nodes: [{ id: 'noop', type: 'exec', dependsOn: [], command: 'true' }],
      },
    })
    // Backdate createdAt so the run is already older than the elapsed budget
    // even though no node attempt has consumed any active wall time.
    const snapshot = await readWorkflowRun(handle.dir)
    await writeWorkflowRun(handle.dir, {
      ...snapshot,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const { refreshWorkflowBudgetLedger } = await import('./budget.js')
    const ledger = await refreshWorkflowBudgetLedger(handle.dir)
    expect(ledger.totals.elapsedWallTimeMs).toBeGreaterThanOrEqual(60_000)
    // No finished attempts, so summed attempt wall time stays zero while the
    // real elapsed budget is already exceeded.
    expect(ledger.totals.wallTimeMs).toBe(0)
    expect(ledger.violations).toEqual([
      { limit: 'maxElapsedWallTimeMs', max: 1000, observed: ledger.totals.elapsedWallTimeMs },
    ])
  })
})
