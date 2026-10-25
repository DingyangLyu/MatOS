import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from './types.js'
import {
  applyWorkflowGraphPatch,
  proposeWorkflowGraphPatch,
  validateWorkflowGraphPatchCandidate,
  workflowGraphPatchEffectiveRisk,
  workflowGraphPatchOperatorPolicy,
  writeWorkflowGraphPatchApplication,
  type WorkflowGraphPatchCandidate,
} from './dynamicPatch.js'
import {
  applyWorkflowGraphPatchForRun,
  approveWorkflowGraphPatchForRun,
  startWorkflowRun,
} from './workflowRuntime.js'

function baseWorkflow(): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'dynamic-base',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    nodes: [
      {
        id: 'prepare',
        type: 'exec',
        dependsOn: [],
        command: 'printf ready',
      },
    ],
    outputs: {},
  }
}

function specCandidate(
  operations: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceNodeId: 'prepare',
    reason: 'bounded dynamic patch test',
    operations,
    budgetImpact: {
      addedNodes: operations.filter(operation => operation.op === 'add_node').length,
      estimatedAgentCalls: 0,
      estimatedWallMinutes: 1,
    },
    risk: 'low',
  }
}

describe('controlled workflow dynamic graph patches', () => {
  test('content-addresses proposals by operations, reason, and declared risk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-dynamic-proposal-id-'))
    const runDir = join(root, 'run')
    await mkdir(runDir, { recursive: true })
    const operations = [
      {
        op: 'add_node' as const,
        node: {
          id: 'review',
          type: 'exec' as const,
          dependsOn: ['prepare'],
          command: 'printf review',
        },
      },
    ]
    const common = {
      runDir,
      runId: 'run-proposal-identity',
      definition: baseWorkflow(),
      operations,
      sourceNodeId: 'controller',
    }

    const first = await proposeWorkflowGraphPatch({
      ...common,
      reason: 'first reason',
      risk: 'low',
    })
    const changedReason = await proposeWorkflowGraphPatch({
      ...common,
      reason: 'second reason',
      risk: 'low',
    })
    const changedRisk = await proposeWorkflowGraphPatch({
      ...common,
      reason: 'second reason',
      risk: 'medium',
    })

    expect(first.ok).toBe(true)
    expect(changedReason.ok).toBe(true)
    expect(changedRisk.ok).toBe(true)
    expect(
      new Set([
        first.patch?.patchId,
        changedReason.patch?.patchId,
        changedRisk.patch?.patchId,
      ]).size,
    ).toBe(3)
    expect(first.patch?.candidate?.reason).toBe('first reason')
    expect(changedReason.patch?.candidate?.reason).toBe('second reason')
    expect(changedRisk.patch?.candidate?.risk).toBe('medium')
  })

  test('accepts spec-shaped bounded graph patch candidates', () => {
    const candidate = {
      schemaVersion: 1,
      sourceNodeId: 'prepare',
      reason: 'add a bounded review branch',
      operations: [
        {
          op: 'add_node',
          node: {
            id: 'review',
            type: 'exec',
            dependsOn: [],
            command: 'printf review',
          },
        },
        { op: 'add_edge', from: 'prepare', to: 'review', route: 'success' },
      ],
      budgetImpact: {
        addedNodes: 1,
        estimatedAgentCalls: 0,
        estimatedWallMinutes: 1,
      },
      risk: 'low',
    }

    const result = validateWorkflowGraphPatchCandidate(baseWorkflow(), candidate)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.patchedDefinition?.nodes.map(node => node.id)).toEqual([
      'prepare',
      'review',
    ])
    expect(result.patchedDefinition?.nodes[1]?.dependsOn).toEqual(['prepare'])
    expect(result.patchedDefinition?.edges).toEqual([
      { from: 'prepare', to: 'review', route: 'success' },
    ])
  })

  test('raises effective risk for low-declared patches that add backend work', () => {
    const candidate = {
      id: 'add-backend',
      operations: [
        {
          op: 'add_node',
          node: {
            id: 'submit_remote',
            type: 'backend',
            dependsOn: ['prepare'],
            backend: 'hpc-queue',
          },
        },
      ],
      risk: 'low',
    } satisfies WorkflowGraphPatchCandidate

    expect(workflowGraphPatchEffectiveRisk(candidate)).toBe('high')
  })

  test('raises effective risk for edge operations that touch gate nodes', () => {
    const definition: MatOSWorkflowDefinition = {
      ...baseWorkflow(),
      nodes: [
        ...baseWorkflow().nodes,
        {
          id: 'quality_gate',
          type: 'guard',
          dependsOn: ['prepare'],
          checks: [{ id: 'ok', type: 'expression', value: 'true' }],
        },
        {
          id: 'publish',
          type: 'exec',
          dependsOn: ['quality_gate'],
          command: 'printf publish',
        },
      ],
    }
    // Detaching the guard from the publish step would silently bypass the
    // quality gate, so the patch must not stay auto-applicable.
    const candidate = {
      id: 'detach-gate',
      operations: [{ op: 'remove_edge', from: 'quality_gate', to: 'publish' }],
      risk: 'low',
    } satisfies WorkflowGraphPatchCandidate

    expect(workflowGraphPatchEffectiveRisk(candidate, definition)).toBe('medium')

    // Plain edges between non-gate nodes stay low and auto-applicable.
    const plain = {
      id: 'plain-edge',
      operations: [{ op: 'add_edge', from: 'prepare', to: 'publish' }],
      risk: 'low',
    } satisfies WorkflowGraphPatchCandidate

    expect(workflowGraphPatchEffectiveRisk(plain, definition)).toBe('low')
  })

  test('validates graph patch candidates through the native workflow schema', () => {
    const candidate = {
      id: 'add-check',
      operations: [
        {
          type: 'add_node',
          node: {
            id: 'check',
            type: 'guard',
            dependsOn: [],
            checks: [{ id: 'ok', type: 'expression', value: 'true' }],
          },
        },
        { type: 'connect', from: 'prepare', to: 'check' },
        {
          type: 'set_outputs',
          outputs: {
            ok: { value: '{{ nodes.check.outputs.ok }}' },
          },
        },
      ],
    } satisfies WorkflowGraphPatchCandidate

    const result = validateWorkflowGraphPatchCandidate(baseWorkflow(), candidate)

    expect(result.ok).toBe(true)
    expect(result.patchedDefinition?.nodes.map(node => node.id)).toEqual([
      'prepare',
      'check',
    ])
    expect(result.patchedDefinition?.nodes[1]?.dependsOn).toEqual(['prepare'])
    expect(result.patchedDefinition?.outputs).toEqual({
      ok: { value: '{{ nodes.check.outputs.ok }}' },
    })
  })

  test('validates dynamic patch references against runtime-known parameters', () => {
    const candidate = {
      id: 'runtime-parameter-reference',
      operations: [
        {
          type: 'add_node',
          node: {
            id: 'parameterized',
            type: 'exec',
            dependsOn: ['prepare'],
            command: 'printf "{{ parameters.topic }}"',
          },
        },
      ],
    } satisfies WorkflowGraphPatchCandidate

    const strict = validateWorkflowGraphPatchCandidate(baseWorkflow(), candidate)
    expect(strict.ok).toBe(false)
    expect(strict.errors.map(error => error.message).join('\n')).toContain(
      'references missing parameter "topic"',
    )

    const runtimeAware = validateWorkflowGraphPatchCandidate(
      baseWorkflow(),
      candidate,
      { knownParameterIds: ['topic'] },
    )
    expect(runtimeAware.ok).toBe(true)
  })

  test('rejects candidates that introduce undeclared tools or permission fields', () => {
    const result = validateWorkflowGraphPatchCandidate(baseWorkflow(), {
      id: 'unsafe',
      operations: [
        {
          type: 'add_node',
          node: {
            id: 'submit',
            type: 'backend',
            dependsOn: ['prepare'],
            backend: 'hpc-queue',
            tool: 'tool:hpc-submit',
            allowedTools: ['Bash'],
            input: { dryRun: true },
          },
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'undeclared_asset_reference',
          path: 'operations[0].node.tool',
        }),
        expect.objectContaining({
          code: 'restricted_patch_field',
          path: 'operations[0].node.allowedTools',
        }),
      ]),
    )
  })

  test('parses operator patch policy from environment variables', () => {
    expect(workflowGraphPatchOperatorPolicy({})).toEqual({
      limits: {},
      requireApproval: false,
    })

    expect(
      workflowGraphPatchOperatorPolicy({
        MATOS_WORKFLOW_PATCH_MAX_NODES: '50',
        MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH: '5',
        MATOS_WORKFLOW_PATCH_MAX_FAN_OUT: '8',
        MATOS_WORKFLOW_PATCH_MAX_LOOP_ITERATIONS: '3',
        MATOS_WORKFLOW_PATCH_MAX_NESTED_WORKFLOW_DEPTH: '2',
        MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL: 'true',
      }),
    ).toEqual({
      limits: {
        maxNodes: 50,
        maxAddedNodesPerPatch: 5,
        maxFanOut: 8,
        maxLoopIterations: 3,
        maxNestedWorkflowDepth: 2,
      },
      requireApproval: true,
    })

    // Invalid or non-positive values are ignored instead of breaking policy.
    expect(
      workflowGraphPatchOperatorPolicy({
        MATOS_WORKFLOW_PATCH_MAX_NODES: 'not-a-number',
        MATOS_WORKFLOW_PATCH_MAX_FAN_OUT: '0',
        MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL: 'off',
      }),
    ).toEqual({ limits: {}, requireApproval: false })
  })

  test('operator limit env tightens patch validation over per-call options', () => {
    const candidate = specCandidate(
      Array.from({ length: 3 }, (_, index) => ({
        op: 'add_node',
        node: {
          id: `op_capped_${index}`,
          type: 'exec',
          dependsOn: [],
          command: 'printf ok',
        },
      })),
    )
    const previous = process.env.MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH
    process.env.MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH = '2'
    try {
      const result = validateWorkflowGraphPatchCandidate(
        baseWorkflow(),
        candidate,
        { limits: { maxAddedNodesPerPatch: 30 } },
      )
      expect(result.ok).toBe(false)
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'policy_limit',
            path: 'budgetImpact.addedNodes',
          }),
        ]),
      )
    } finally {
      if (previous === undefined) {
        delete process.env.MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH
      } else {
        process.env.MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH = previous
      }
    }
  })

  test('rejects patches that exceed active graph node limits', () => {
    const result = validateWorkflowGraphPatchCandidate(
      baseWorkflow(),
      specCandidate(
        Array.from({ length: 200 }, (_, index) => ({
          op: 'add_node',
          node: {
            id: `node_${index}`,
            type: 'exec',
            dependsOn: [],
            command: 'printf ok',
          },
        })),
      ),
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'policy_limit',
          path: 'policy.maxNodes',
        }),
      ]),
    )
  })

  test('rejects patches that add too many nodes in one candidate', () => {
    const result = validateWorkflowGraphPatchCandidate(
      baseWorkflow(),
      specCandidate(
        Array.from({ length: 31 }, (_, index) => ({
          op: 'add_node',
          node: {
            id: `new_${index}`,
            type: 'exec',
            dependsOn: [],
            command: 'printf ok',
          },
        })),
      ),
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'policy_limit',
          path: 'budgetImpact.addedNodes',
        }),
      ]),
    )
  })

  test('rejects map fan-out and loop iteration counts above defaults', () => {
    const result = validateWorkflowGraphPatchCandidate(
      baseWorkflow(),
      specCandidate([
        {
          op: 'add_node',
          node: {
            id: 'too_many_items',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:atomistic-materials-discovery@1.0.0',
            items: Array.from({ length: 65 }, (_, index) => index),
          },
        },
        {
          op: 'add_node',
          node: {
            id: 'too_many_rounds',
            type: 'loop',
            dependsOn: [],
            workflow: 'workflow:atomistic-materials-discovery@1.0.0',
            maxIterations: 11,
          },
        },
      ]),
      { allowedAssetRefs: ['workflow:atomistic-materials-discovery@1.0.0'] },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'policy_limit',
          path: 'nodes.too_many_items.items',
        }),
        expect.objectContaining({
          code: 'policy_limit',
          path: 'nodes.too_many_rounds.maxIterations',
        }),
      ]),
    )
  })

  test('rejects nested dynamic workflow depth above the default cap', () => {
    const result = validateWorkflowGraphPatchCandidate(
      baseWorkflow(),
      specCandidate([
        {
          op: 'add_node',
          node: {
            id: 'child',
            type: 'subworkflow',
            dependsOn: [],
            workflow: 'workflow:atomistic-materials-discovery@1.0.0',
          },
        },
      ]),
      {
        allowedAssetRefs: ['workflow:atomistic-materials-discovery@1.0.0'],
        currentNestedWorkflowDepth: 6,
      } as never,
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'policy_limit',
          path: 'policy.maxNestedWorkflowDepth',
        }),
      ]),
    )
  })

  test('rejects node deletion inside active dynamic graph patches', () => {
    const result = validateWorkflowGraphPatchCandidate(
      baseWorkflow(),
      specCandidate([{ op: 'delete_node', nodeId: 'prepare' }]),
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsupported_operation',
          path: 'operations[0].op',
        }),
      ]),
    )
  })

  test('rejects remove_edge operations that do not match an active dependency edge', () => {
    const workflow: MatOSWorkflowDefinition = {
      ...baseWorkflow(),
      nodes: [
        ...baseWorkflow().nodes,
        {
          id: 'write',
          type: 'exec',
          dependsOn: ['prepare'],
          command: 'printf write',
        },
      ],
    }

    const result = validateWorkflowGraphPatchCandidate(
      workflow,
      specCandidate([
        { op: 'remove_edge', from: 'missing', to: 'write' },
        {
          op: 'add_node',
          node: {
            id: 'supplemental',
            type: 'exec',
            dependsOn: [],
            command: 'printf supplemental',
          },
        },
        { op: 'add_edge', from: 'supplemental', to: 'write' },
      ]),
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'validation_failed',
          path: 'operations[0]',
        }),
      ]),
    )
  })

  test('allows declared tool references and writes reversible graph snapshots only when enabled', async () => {
    const candidate = {
      id: 'declared-tool',
      operations: [
        {
          type: 'add_node',
          node: {
            id: 'generate',
            type: 'backend',
            dependsOn: ['prepare'],
            backend: 'hpc-queue',
            tool: 'tool:hpc-generate-yaml',
            input: {
              taskName: 'dynamic-smoke',
              workdir: '/workspace/group/shared/attempt-01',
            },
          },
        },
      ],
    } satisfies WorkflowGraphPatchCandidate
    const before = baseWorkflow()
    const validation = validateWorkflowGraphPatchCandidate(before, candidate, {
      allowedAssetRefs: ['tool:hpc-generate-yaml'],
    })
    expect(validation.ok).toBe(true)
    const after = applyWorkflowGraphPatch(before, candidate)
    const root = await mkdtemp(join(tmpdir(), 'matos-dynamic-patch-'))
    await mkdir(join(root, 'run'), { recursive: true })

    await expect(
      writeWorkflowGraphPatchApplication({
        runDir: join(root, 'run'),
        candidate,
        before,
        after,
        scopeRef: 'user:shared',
        allowDynamicMutation: false,
      }),
    ).rejects.toThrow('dynamic workflow graph mutation is disabled')

    const written = await writeWorkflowGraphPatchApplication({
      runDir: join(root, 'run'),
      candidate,
      before,
      after,
      scopeRef: 'user:local',
      allowDynamicMutation: true,
    })

    expect(written.patchDir).toContain('declared-tool')
    expect(JSON.parse(await readFile(written.beforePath, 'utf8')).nodes).toEqual(
      before.nodes,
    )
    expect(JSON.parse(await readFile(written.afterPath, 'utf8')).nodes).toEqual(
      after.nodes,
    )
  })

  test('writes canonical patch ledger validation decision and versioned graph snapshot', async () => {
    const candidate = specCandidate([
      {
        op: 'add_node',
        node: {
          id: 'review',
          type: 'exec',
          dependsOn: [],
          command: 'printf review',
        },
      },
      { op: 'add_edge', from: 'prepare', to: 'review' },
    ])
    const before = baseWorkflow()
    const validation = validateWorkflowGraphPatchCandidate(before, candidate)
    expect(validation.ok).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'matos-dynamic-patch-ledger-'))
    const runDir = join(root, 'run')
    await mkdir(runDir, { recursive: true })

    const written = await writeWorkflowGraphPatchApplication({
      runDir,
      candidate: candidate as WorkflowGraphPatchCandidate,
      before,
      after: validation.patchedDefinition!,
      scopeRef: 'user:local',
      allowDynamicMutation: true,
    }) as Awaited<ReturnType<typeof writeWorkflowGraphPatchApplication>> & {
      validationPath: string
      decisionPath: string
      graphSnapshotPath: string
      graphHash: string
    }

    const persistedCandidate = JSON.parse(
      await readFile(written.candidatePath, 'utf8'),
    )
    expect(persistedCandidate).toMatchObject({
      schemaVersion: 1,
      sourceNodeId: 'prepare',
      risk: 'low',
    })
    expect(persistedCandidate.operations[0].op).toBe('add_node')
    expect(persistedCandidate.operations[0].type).toBeUndefined()

    expect(JSON.parse(await readFile(written.validationPath, 'utf8'))).toMatchObject({
      ok: true,
      errors: [],
    })
    expect(JSON.parse(await readFile(written.decisionPath, 'utf8'))).toMatchObject({
      status: 'applied',
      graphHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      graphSnapshotPath: 'graph.snapshot.v2.json',
    })
    expect(written.graphHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(written.graphSnapshotPath).toBe(join(runDir, 'graph.snapshot.v2.json'))
    expect(
      JSON.parse(await readFile(written.graphSnapshotPath, 'utf8')).nodes.map(
        (node: { id: string }) => node.id,
      ),
    ).toEqual(['prepare', 'review'])
  })

  // Drive a run to `waiting_input` on a dynamic node whose static candidate
  // requires review (policy.approval: 'ask'), so the manual
  // approve + apply path (applyWorkflowGraphPatchForRun) is exercised.
  async function startRunWaitingOnDynamicPatch(input: {
    prefix: string
    candidate: Record<string, unknown>
  }): Promise<{ root: string; runDir: string }> {
    const root = await mkdtemp(join(tmpdir(), input.prefix))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:dynamic-run-patch@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'dynamic-run-patch',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'plan',
            type: 'dynamic',
            dependsOn: [],
            policy: { approval: 'ask' },
            candidate: input.candidate,
          },
        ],
      },
    })
    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('plan')
    return { root, runDir: run.runDir }
  }

  async function readNodeRunSnapshot(
    runDir: string,
    nodeId: string,
  ): Promise<{ status: string; output?: Record<string, unknown> }> {
    return JSON.parse(
      await readFile(join(runDir, 'node-runs', nodeId, 'node-run.json'), 'utf8'),
    ) as { status: string; output?: Record<string, unknown> }
  }

  test('applied run patch compiles routed edges so a patched-in recovery node executes on failure', async () => {
    const { root, runDir } = await startRunWaitingOnDynamicPatch({
      prefix: 'matos-dynamic-run-patch-failure-route-',
      candidate: {
        schemaVersion: 1,
        id: 'recovery-patch',
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

    await approveWorkflowGraphPatchForRun({ runDir, patchId: 'recovery-patch' })
    const applied = await applyWorkflowGraphPatchForRun({
      runDir,
      patchId: 'recovery-patch',
    })

    // The patched-in failure route must actually fire: flaky fails, the
    // recovery node runs, and the run completes through the routed branch.
    expect(applied.run.status).toBe('completed')
    expect((await readNodeRunSnapshot(runDir, 'flaky')).status).toBe('failed')
    expect((await readNodeRunSnapshot(runDir, 'recover')).status).toBe('completed')
    expect(await readFile(join(root, 'recovered.txt'), 'utf8')).toBe('recovered')

    // The persisted snapshot went through the compiler: the patch-added edge
    // is materialized as node.incomingEdges, not only as a top-level edge.
    const runSnapshot = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as {
      graphSnapshotPath: string
    }
    const snapshot = JSON.parse(
      await readFile(join(runDir, runSnapshot.graphSnapshotPath), 'utf8'),
    ) as MatOSWorkflowDefinition
    const recover = snapshot.nodes.find(node => node.id === 'recover') as
      | (MatOSWorkflowNode & { incomingEdges?: Array<Record<string, unknown>> })
      | undefined
    expect(recover?.dependsOn).toEqual(['flaky'])
    expect(recover?.incomingEdges).toEqual([
      expect.objectContaining({ from: 'flaky', to: 'recover', route: 'failure' }),
    ])
  })

  test('applied run patch lowers semantic node types so dispatch does not crash', async () => {
    const { runDir } = await startRunWaitingOnDynamicPatch({
      prefix: 'matos-dynamic-run-patch-semantic-',
      candidate: {
        schemaVersion: 1,
        id: 'semantic-patch',
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

    await approveWorkflowGraphPatchForRun({ runDir, patchId: 'semantic-patch' })
    const applied = await applyWorkflowGraphPatchForRun({
      runDir,
      patchId: 'semantic-patch',
    })

    // Before the fix the raw semantic type reached the executor registry and
    // dispatch failed with "Unsupported workflow node runtime type: validate".
    expect(applied.run.status).toBe('completed')
    const gate = await readNodeRunSnapshot(runDir, 'gate')
    expect(gate.status).toBe('completed')
    expect(gate.output?.ok).toBe(true)

    const runSnapshot = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as {
      graphSnapshotPath: string
    }
    const snapshot = JSON.parse(
      await readFile(join(runDir, runSnapshot.graphSnapshotPath), 'utf8'),
    ) as MatOSWorkflowDefinition
    const gateNode = snapshot.nodes.find(node => node.id === 'gate')
    expect(gateNode).toMatchObject({ type: 'guard', targetType: 'validate' })
  })
})
