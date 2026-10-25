import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from './types.js'
import { startWorkflowRun } from './workflowRuntime.js'

// The manual approve+apply path (applyWorkflowGraphPatchForRun) compiles the
// patched definition before persisting it. The dynamic-node AUTO-apply path
// (runWorkflowDynamicNode) persists a snapshot through the same door, so it
// must compile too; these tests drive it end-to-end through startWorkflowRun
// with a low-risk static candidate and no approval gate.

async function startAutoApplyRun(input: {
  prefix: string
  candidate: Record<string, unknown>
  commandAllowlist?: string[]
}): Promise<{ root: string; runDir: string; status: string }> {
  const root = await mkdtemp(join(tmpdir(), input.prefix))
  const run = await startWorkflowRun({
    cwd: root,
    workflowsDir: join(root, 'workflows'),
    workflowRef: 'workflow:dynamic-auto-apply@0.1.0',
    parameters: {},
    workspaceDir: root,
    definition: {
      schemaVersion: 1,
      name: 'dynamic-auto-apply',
      parameters: {},
      policy: {
        approvalMode: 'bypass',
        defaultRisk: 'low',
        // Auto-applying a patch that introduces shell commands requires the
        // workflow to pre-declare those exact commands (P2-8 command gate);
        // otherwise the patch elevates to medium risk and waits for review.
        ...(input.commandAllowlist
          ? { dynamicCommandAllowlist: input.commandAllowlist }
          : {}),
      },
      outputs: {},
      nodes: [
        {
          id: 'plan',
          type: 'dynamic',
          dependsOn: [],
          candidate: input.candidate,
        },
      ],
    },
  })
  return { root, runDir: run.runDir, status: run.status }
}

async function readNodeRunSnapshot(
  runDir: string,
  nodeId: string,
): Promise<{ status: string; output?: Record<string, unknown> }> {
  return JSON.parse(
    await readFile(join(runDir, 'node-runs', nodeId, 'node-run.json'), 'utf8'),
  ) as { status: string; output?: Record<string, unknown> }
}

async function readPersistedSnapshot(
  runDir: string,
): Promise<MatOSWorkflowDefinition> {
  const runSnapshot = JSON.parse(
    await readFile(join(runDir, 'run.json'), 'utf8'),
  ) as { graphSnapshotPath: string }
  return JSON.parse(
    await readFile(join(runDir, runSnapshot.graphSnapshotPath), 'utf8'),
  ) as MatOSWorkflowDefinition
}

describe('dynamic node auto-apply persists compiled snapshots', () => {
  test('auto-applied patch compiles routed edges so a failure-routed recovery node executes', async () => {
    const { root, runDir, status } = await startAutoApplyRun({
      prefix: 'matos-dynamic-auto-apply-failure-route-',
      commandAllowlist: [
        'exit 3',
        'printf recovered > recovered.txt; printf recovered',
      ],
      candidate: {
        schemaVersion: 1,
        id: 'auto-recovery-patch',
        sourceNodeId: 'plan',
        reason: 'add failure-routed recovery branch',
        operations: [
          {
            op: 'add_node',
            node: { id: 'flaky', type: 'exec', dependsOn: [], command: 'exit 3' },
          },
          {
            op: 'add_node',
            node: {
              id: 'recover',
              type: 'exec',
              dependsOn: [],
              command: 'printf recovered > recovered.txt; printf recovered',
            },
          },
          { op: 'add_edge', from: 'plan', to: 'flaky' },
          { op: 'add_edge', from: 'flaky', to: 'recover', route: 'failure' },
        ],
        budgetImpact: { addedNodes: 2, estimatedAgentCalls: 0 },
        risk: 'low',
      },
    })

    expect(status).toBe('completed')
    expect((await readNodeRunSnapshot(runDir, 'plan')).output?.status).toBe(
      'applied',
    )
    expect((await readNodeRunSnapshot(runDir, 'flaky')).status).toBe('failed')
    expect((await readNodeRunSnapshot(runDir, 'recover')).status).toBe(
      'completed',
    )
    expect(await readFile(join(root, 'recovered.txt'), 'utf8')).toBe('recovered')

    const snapshot = await readPersistedSnapshot(runDir)
    const recover = snapshot.nodes.find(node => node.id === 'recover') as
      | (MatOSWorkflowNode & { incomingEdges?: Array<Record<string, unknown>> })
      | undefined
    expect(recover?.dependsOn).toEqual(['flaky'])
    expect(recover?.incomingEdges).toEqual([
      expect.objectContaining({ from: 'flaky', to: 'recover', route: 'failure' }),
    ])
  })

  test('gate-adding patch is not auto-applied: effective risk elevates and the run waits for review', async () => {
    const { runDir, status } = await startAutoApplyRun({
      prefix: 'matos-dynamic-auto-apply-semantic-',
      candidate: {
        schemaVersion: 1,
        id: 'auto-semantic-patch',
        sourceNodeId: 'plan',
        reason: 'add semantic validate gate',
        operations: [
          {
            op: 'add_node',
            node: {
              id: 'gate',
              type: 'validate',
              dependsOn: [],
              checks: [{ id: 'ok', type: 'expression', value: 'true' }],
            },
          },
          { op: 'add_edge', from: 'plan', to: 'gate' },
        ],
        budgetImpact: { addedNodes: 1, estimatedAgentCalls: 0 },
        risk: 'low',
      },
    })

    // Adding a quality gate rewires acceptance criteria, so the effective
    // risk elevates above 'low' and the auto-apply door must stay shut: the
    // patch is only proposed and the run parks on the dynamic node for
    // manual review instead of silently applying.
    expect(status).toBe('waiting_input')
    const plan = await readNodeRunSnapshot(runDir, 'plan')
    expect(plan.status).toBe('waiting_input')
    expect(plan.output?.status).toBe('proposed')

    const snapshot = await readPersistedSnapshot(runDir)
    expect(snapshot.nodes.map(node => node.id)).toEqual(['plan'])
  })

  test('command patch auto-applies when no command allowlist is declared (opt-in gate)', async () => {
    // P2-8 command gating is opt-in: with no policy.dynamicCommandAllowlist,
    // a patch-introduced exec command keeps the prior low-risk behavior and
    // auto-applies, so autonomous planners whose commands are generated at
    // run time are not broken.
    const { root, runDir, status } = await startAutoApplyRun({
      prefix: 'matos-dynamic-auto-apply-cmd-open-',
      candidate: {
        schemaVersion: 1,
        id: 'auto-open-cmd-patch',
        sourceNodeId: 'plan',
        reason: 'add exec command node without allowlist',
        operations: [
          {
            op: 'add_node',
            node: {
              id: 'work',
              type: 'exec',
              dependsOn: [],
              command: 'printf ok > ok.txt; printf ok',
            },
          },
          { op: 'add_edge', from: 'plan', to: 'work' },
        ],
        budgetImpact: { addedNodes: 1, estimatedAgentCalls: 0 },
        risk: 'low',
      },
    })

    expect(status).toBe('completed')
    expect((await readNodeRunSnapshot(runDir, 'work')).status).toBe('completed')
    expect(await readFile(join(root, 'ok.txt'), 'utf8')).toBe('ok')
  })

  test('command patch is gated when a non-matching allowlist is declared', async () => {
    // When the workflow opts in by declaring an allowlist, a patch command
    // outside it elevates to medium risk and the run parks for review.
    const { runDir, status } = await startAutoApplyRun({
      prefix: 'matos-dynamic-auto-apply-cmd-gated-',
      commandAllowlist: ['printf a-different-command'],
      candidate: {
        schemaVersion: 1,
        id: 'auto-gated-cmd-patch',
        sourceNodeId: 'plan',
        reason: 'add exec command node outside the allowlist',
        operations: [
          {
            op: 'add_node',
            node: {
              id: 'work',
              type: 'exec',
              dependsOn: [],
              command: 'printf ok > ok.txt; printf ok',
            },
          },
          { op: 'add_edge', from: 'plan', to: 'work' },
        ],
        budgetImpact: { addedNodes: 1, estimatedAgentCalls: 0 },
        risk: 'low',
      },
    })

    expect(status).toBe('waiting_input')
    const plan = await readNodeRunSnapshot(runDir, 'plan')
    expect(plan.output?.status).toBe('proposed')
    const snapshot = await readPersistedSnapshot(runDir)
    expect(snapshot.nodes.map(node => node.id)).toEqual(['plan'])
  })
})
