import { beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMatOSAlgorithmWorkflowIntegration } from '../algorithms/workflowIntegration.js'
import { matOSControllerRegistry } from '../algorithms/controllers/registry.js'
import { createGreedyController } from '../algorithms/controllers/strategies/greedy.js'
import {
  createMatOSControllerAction,
  matOSControllerDigest,
  type MatOSControllerActionIntent,
  type MatOSControllerJsonValue,
} from '../algorithms/controllers/protocol.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNodeRunSnapshot,
} from './types.js'
import {
  adviseMatOSWorkflowReadySet,
  finalizeMatOSWorkflowController,
  waitForMatOSWorkflowShadowController,
} from './controllerBridge.js'
import {
  appendWorkflowEvent,
  createWorkflowRun,
  readWorkflowRun,
  readWorkflowRunEvents,
} from './workflowStore.js'
import { startWorkflowRun } from './workflowRuntime.js'

function definition(
  controller?: MatOSWorkflowDefinition['policy']['controller'],
): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'controller-bridge-test',
    parameters: {},
    policy: controller ? { controller } : {},
    nodes: [
      { id: 'first', type: 'exec', dependsOn: [], command: 'true' },
      { id: 'second', type: 'exec', dependsOn: [], command: 'true' },
    ],
    outputs: {},
  }
}

async function runFixture(
  controller?: MatOSWorkflowDefinition['policy']['controller'],
) {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-controller-bridge-'))
  const graph = definition(controller)
  const run = await createWorkflowRun({
    workflowsDir: join(cwd, '.matos', 'workflows'),
    workflowRef: 'workflow:controller-bridge-test@1.0.0',
    graphSnapshot: graph,
    projectCwd: cwd,
    workspaceDir: cwd,
  })
  return { cwd, graph, run, snapshot: await readWorkflowRun(run.dir) }
}

function controllerImplementationDigest(
  providerId: string,
  revision = '1',
): string {
  return matOSControllerDigest({ providerId, revision })
}

function registerGraphPatchProvider(providerId: string): () => void {
  matOSControllerRegistry.register({
    id: providerId,
    version: '1.0.0',
    stateVersion: 1,
    implementationDigest: controllerImplementationDigest(providerId),
    create: input => {
      const config = input.config as Record<string, MatOSControllerJsonValue>
      const candidateRef = String(config.candidateRef)
      const patchDigest = String(config.patchDigest)
      return {
        id: providerId,
        version: '1.0.0',
        stateVersion: 1,
        initialize: () => ({}),
        observe: state => state,
        propose: (_state, context) => [
          createMatOSControllerAction({
            observation: context.observation,
            seed: context.seed,
            intent: {
              type: 'propose-graph-patch',
              candidate: {
                candidateRef,
                patchDigest,
                baseGraphDigest: context.observation.graph.digest,
                baseGraphVersion: context.observation.graph.version,
              },
              reason: 'bounded-controller-patch-test',
            },
          }),
        ],
        serializeState: () => ({}),
        finalize: () => ({ outcomeRefs: [] }),
      }
    },
  })
  return () => matOSControllerRegistry.unregister(providerId, '1.0.0')
}

function registerControllerActionProvider(
  providerId: string,
  intent: MatOSControllerActionIntent,
): () => void {
  matOSControllerRegistry.register({
    id: providerId,
    version: '1.0.0',
    stateVersion: 1,
    implementationDigest: controllerImplementationDigest(providerId),
    create: () => ({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      initialize: () => ({}),
      observe: state => state,
      propose: (_state, context) => [
        createMatOSControllerAction({
          observation: context.observation,
          seed: context.seed,
          intent,
        }),
      ],
      serializeState: () => ({}),
      finalize: () => ({ outcomeRefs: [] }),
    }),
  })
  return () => matOSControllerRegistry.unregister(providerId, '1.0.0')
}

async function latestControllerReceiptStatus(runDir: string): Promise<string> {
  const files = await readdir(join(runDir, 'controllers', 'action-receipts'))
  const content = await readFile(
    join(runDir, 'controllers', 'action-receipts', files[0]!),
    'utf8',
  )
  return (JSON.parse(content.trim().split('\n').at(-1)!) as { status: string })
    .status
}

describe('workflow controller bridge', () => {
  beforeAll(() => ensureMatOSAlgorithmWorkflowIntegration())

  test('leaves the baseline ready order untouched when no controller is configured', async () => {
    const fixture = await runFixture()
    const advice = await adviseMatOSWorkflowReadySet({
      runDir: fixture.run.dir,
      snapshot: fixture.snapshot,
      definition: fixture.graph,
      nodeRuns: new Map(),
      readyNodeIds: ['first', 'second'],
    })
    expect(advice).toEqual({ orderedNodeIds: ['first', 'second'] })
  })

  test('pins and checkpoints a bounded best-of-N ready-set decision', async () => {
    const fixture = await runFixture({
      provider: 'best-of-n',
      version: '1.0.0',
      config: { n: 2, priorities: { second: 10, first: 0 } },
      bounds: {
        maxActions: 1,
        maxCandidates: 8,
        maxDepth: 2,
        maxWallTimeMs: 1_000,
        maxCostUsd: 0.001,
      },
      budget: {
        actions: 10,
        candidates: 20,
        transitions: 20,
        evaluations: 20,
        maxDepth: 20,
        wallTimeMs: 10_000,
        costUsd: 0.001,
      },
    })
    const advice = await adviseMatOSWorkflowReadySet({
      runDir: fixture.run.dir,
      snapshot: fixture.snapshot,
      definition: fixture.graph,
      nodeRuns: new Map(),
      readyNodeIds: ['first', 'second'],
    })
    expect(advice.orderedNodeIds).toEqual(['second', 'first'])
    expect(advice.directive).toBeUndefined()
    const checkpoint = await readFile(
      join(fixture.run.dir, 'controllers', 'best-of-n.checkpoints.jsonl'),
      'utf8',
    )
    expect(checkpoint.trim().split('\n')).toHaveLength(1)
    const decisions = await readFile(
      join(fixture.run.dir, 'algorithm-decisions.jsonl'),
      'utf8',
    )
    expect(decisions).toContain('"surfaceId":"run-controller"')
  })

  test('shadow mode records actions without changing scheduling', async () => {
    const fixture = await runFixture({
      provider: 'best-of-n',
      mode: 'shadow',
      config: { n: 2, priorities: { second: 10 } },
    })
    const advice = await adviseMatOSWorkflowReadySet({
      runDir: fixture.run.dir,
      snapshot: fixture.snapshot,
      definition: fixture.graph,
      nodeRuns: new Map(),
      readyNodeIds: ['first', 'second'],
    })
    expect(advice).toEqual({ orderedNodeIds: ['first', 'second'] })
    await finalizeMatOSWorkflowController({
      runDir: fixture.run.dir,
      snapshot: fixture.snapshot,
      definition: fixture.graph,
    })
    await waitForMatOSWorkflowShadowController(fixture.run.dir)
    expect(
      await readFile(
        join(fixture.run.dir, 'controllers', 'shadow-actions.jsonl'),
        'utf8',
      ),
    ).toContain('best-of-n')
    const decisions = await readFile(
      join(fixture.run.dir, 'algorithm-decisions.jsonl'),
      'utf8',
    )
    expect(decisions).toContain('"surfaceId":"run-controller"')
    expect(decisions).toContain('"applied":false')
  })

  test('fails closed when an active controller manifest is corrupt', async () => {
    const fixture = await runFixture({
      provider: 'greedy-baseline',
      onFailure: 'pause',
    })
    await writeFile(
      join(fixture.run.dir, 'algorithm-manifest.json'),
      '{"schemaVersion":1,"manifestDigest":"corrupt"}\n',
      'utf8',
    )
    const advice = await adviseMatOSWorkflowReadySet({
      runDir: fixture.run.dir,
      snapshot: fixture.snapshot,
      definition: fixture.graph,
      nodeRuns: new Map(),
      readyNodeIds: ['first', 'second'],
    })
    expect(advice.orderedNodeIds).toEqual(['first', 'second'])
    expect(advice.directive?.status).toBe('paused')
    expect(advice.directive?.reason).toContain('failed closed')
  })

  test('defaults omitted controller failure policy to the baseline route', async () => {
    const fixture = await runFixture({ provider: 'greedy-baseline' })
    await writeFile(
      join(fixture.run.dir, 'algorithm-manifest.json'),
      '{"schemaVersion":1,"manifestDigest":"corrupt"}\n',
      'utf8',
    )
    const advice = await adviseMatOSWorkflowReadySet({
      runDir: fixture.run.dir,
      snapshot: fixture.snapshot,
      definition: fixture.graph,
      nodeRuns: new Map(),
      readyNodeIds: ['first', 'second'],
    })
    expect(advice).toEqual({ orderedNodeIds: ['first', 'second'] })
    expect(
      await readFile(
        join(fixture.run.dir, 'controllers', 'failures.jsonl'),
        'utf8',
      ),
    ).toContain('manifest is missing, corrupt, or mismatched')
  })

  test('enforces registry provider/controller contract validation in the bridge', async () => {
    const providerId = 'bridge-contract-mismatch'
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId),
      create: () =>
        createGreedyController({
          id: 'different-controller-id',
          version: '1.0.0',
        }),
    })
    try {
      const fixture = await runFixture({
        provider: providerId,
        version: '1.0.0',
        onFailure: 'pause',
      })
      const advice = await adviseMatOSWorkflowReadySet({
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(advice.directive?.status).toBe('paused')
      expect(
        await readFile(
          join(fixture.run.dir, 'controllers', 'failures.jsonl'),
          'utf8',
        ),
      ).toContain('created an incompatible controller')
    } finally {
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })

  test('redacts controller provider failures before persistence or directives', async () => {
    const providerId = 'bridge-secret-failure'
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId),
      create: () => {
        throw new Error(
          'provider failed clientSecret=hunter2 token=plain-secret sk-1234567890abcdefghijkl',
        )
      },
    })
    try {
      const fixture = await runFixture({
        provider: providerId,
        version: '1.0.0',
        onFailure: 'pause',
      })
      const advice = await adviseMatOSWorkflowReadySet({
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      const failure = await readFile(
        join(fixture.run.dir, 'controllers', 'failures.jsonl'),
        'utf8',
      )
      expect(advice.directive?.status).toBe('paused')
      expect(failure).toContain('[redacted]')
      expect(failure).not.toContain('hunter2')
      expect(failure).not.toContain('plain-secret')
      expect(failure).not.toContain('1234567890abcdefghijkl')
      expect(advice.directive?.reason).not.toContain('hunter2')
      expect(advice.directive?.reason).not.toContain('plain-secret')
    } finally {
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })

  test('resumes and finalizes an unversioned controller with its manifest-pinned version', async () => {
    const providerId = 'bridge-manifest-version-pin'
    const createdVersions: string[] = []
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId),
      create: () => {
        createdVersions.push('1.0.0')
        return createGreedyController({ id: providerId, version: '1.0.0' })
      },
    })
    let registeredV2 = false
    try {
      const fixture = await runFixture({
        provider: providerId,
        onFailure: 'pause',
      })
      const manifest = JSON.parse(
        await readFile(
          join(fixture.run.dir, 'algorithm-manifest.json'),
          'utf8',
        ),
      ) as { controller?: { providerVersion?: string; stateVersion?: number } }
      expect(manifest.controller).toMatchObject({
        providerVersion: '1.0.0',
        stateVersion: 1,
      })

      const initial = await adviseMatOSWorkflowReadySet({
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(initial.directive).toBeUndefined()
      expect(createdVersions).toEqual(['1.0.0'])

      matOSControllerRegistry.register({
        id: providerId,
        version: '2.0.0',
        stateVersion: 2,
        implementationDigest: controllerImplementationDigest(providerId, '2'),
        create: () => {
          createdVersions.push('2.0.0')
          return createGreedyController({ id: providerId, version: '2.0.0' })
        },
      })
      registeredV2 = true
      await appendWorkflowEvent(fixture.run.dir, {
        type: 'workflow.test.resume_after_provider_upgrade',
        data: { providerId },
      })

      const resumed = await adviseMatOSWorkflowReadySet({
        runDir: fixture.run.dir,
        snapshot: await readWorkflowRun(fixture.run.dir),
        definition: fixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(resumed.directive).toBeUndefined()
      expect(createdVersions).toEqual(['1.0.0', '1.0.0'])

      await finalizeMatOSWorkflowController({
        runDir: fixture.run.dir,
        snapshot: await readWorkflowRun(fixture.run.dir),
        definition: fixture.graph,
      })
      expect(createdVersions).toEqual(['1.0.0', '1.0.0', '1.0.0'])
      expect(
        JSON.parse(
          await readFile(
            join(fixture.run.dir, 'controllers', 'finalize.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ providerId, providerVersion: '1.0.0' })
    } finally {
      if (registeredV2) {
        matOSControllerRegistry.unregister(providerId, '2.0.0')
      }
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })

  test('pauses an old run when the same controller id/version is hot-replaced', async () => {
    const providerId = 'bridge-implementation-pin'
    let replacementCreates = 0
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId, 'old'),
      assetRef: 'controller:bridge-implementation-pin@1.0.0',
      runtimeRef: 'accepted/controller-bridge-pin/old',
      create: () =>
        createGreedyController({ id: providerId, version: '1.0.0' }),
    })
    try {
      const fixture = await runFixture({
        provider: providerId,
        version: '1.0.0',
        onFailure: 'baseline',
      })
      const initial = await adviseMatOSWorkflowReadySet({
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(initial.directive).toBeUndefined()

      matOSControllerRegistry.unregister(providerId, '1.0.0')
      matOSControllerRegistry.register({
        id: providerId,
        version: '1.0.0',
        stateVersion: 1,
        implementationDigest: controllerImplementationDigest(
          providerId,
          'replacement',
        ),
        assetRef: 'controller:bridge-implementation-pin@1.0.0',
        runtimeRef: 'accepted/controller-bridge-pin/replacement',
        create: () => {
          replacementCreates += 1
          return createGreedyController({ id: providerId, version: '1.0.0' })
        },
      })

      const resumed = await adviseMatOSWorkflowReadySet({
        runDir: fixture.run.dir,
        snapshot: await readWorkflowRun(fixture.run.dir),
        definition: fixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(resumed.directive?.status).toBe('paused')
      expect(resumed.directive?.reason).toContain('implementation pin mismatch')
      expect(replacementCreates).toBe(0)

      await finalizeMatOSWorkflowController({
        runDir: fixture.run.dir,
        snapshot: await readWorkflowRun(fixture.run.dir),
        definition: fixture.graph,
      })
      expect(
        (await readWorkflowRunEvents(fixture.run.dir)).some(
          event =>
            event.type === 'workflow.controller.implementation_pin_mismatch' &&
            event.data.phase === 'finalize',
        ),
      ).toBe(true)
      expect(replacementCreates).toBe(0)
    } finally {
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })

  test('runs a real workflow with baseline order off and controller order on', async () => {
    const baselineRoot = await mkdtemp(join(tmpdir(), 'matos-controller-baseline-'))
    const controlledRoot = await mkdtemp(join(tmpdir(), 'matos-controller-active-'))
    const nodes: MatOSWorkflowDefinition['nodes'] = [
      {
        id: 'first',
        type: 'exec',
        dependsOn: [],
        command: 'printf first >> order.txt',
      },
      {
        id: 'second',
        type: 'exec',
        dependsOn: [],
        command: 'printf second >> order.txt',
      },
    ]
    const baseline = await startWorkflowRun({
      workflowsDir: join(baselineRoot, 'workflows'),
      workflowRef: 'workflow:baseline-order@1.0.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'baseline-order',
        parameters: {},
        policy: {},
        nodes,
        outputs: {},
      },
      workspaceDir: baselineRoot,
    })
    const controlled = await startWorkflowRun({
      workflowsDir: join(controlledRoot, 'workflows'),
      workflowRef: 'workflow:controlled-order@1.0.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'controlled-order',
        parameters: {},
        policy: {
          controller: {
            provider: 'best-of-n',
            config: { n: 2, priorities: { second: 10 } },
          },
        },
        nodes,
        outputs: {},
      },
      workspaceDir: controlledRoot,
    })
    expect(baseline.status).toBe('completed')
    expect(controlled.status).toBe('completed')
    expect(await readFile(join(baselineRoot, 'order.txt'), 'utf8')).toBe(
      'firstsecond',
    )
    expect(await readFile(join(controlledRoot, 'order.txt'), 'utf8')).toBe(
      'secondfirst',
    )
    expect(
      await readFile(
        join(controlled.runDir, 'controllers', 'finalize.json'),
        'utf8',
      ),
    ).toContain('best-of-n')
  })

  test('rejects symlinked and oversized graph-patch candidates before native proposal', async () => {
    const providerId = 'bridge-safe-graph-patch'
    const unregister = registerGraphPatchProvider(providerId)
    try {
      const patch = {
        operations: [
          {
            op: 'add_node' as const,
            node: {
              id: 'third',
              type: 'exec' as const,
              dependsOn: [],
              command: 'true',
            },
          },
        ],
        risk: 'low' as const,
      }
      const outside = await mkdtemp(join(tmpdir(), 'matos-controller-patch-outside-'))
      const outsidePath = join(outside, 'patch.json')
      await writeFile(outsidePath, JSON.stringify(patch))
      const linked = await runFixture({
        provider: providerId,
        version: '1.0.0',
        onFailure: 'pause',
        config: {
          candidateRef: 'controller-candidates/patch.json',
          patchDigest: matOSControllerDigest(patch),
        },
      })
      await mkdir(join(linked.run.dir, 'controller-candidates'), {
        recursive: true,
      })
      await symlink(
        outsidePath,
        join(linked.run.dir, 'controller-candidates', 'patch.json'),
      )
      const linkedAdvice = await adviseMatOSWorkflowReadySet({
        runDir: linked.run.dir,
        snapshot: linked.snapshot,
        definition: linked.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(linkedAdvice.directive?.status).toBe('paused')
      expect(
        await readFile(
          join(linked.run.dir, 'controllers', 'failures.jsonl'),
          'utf8',
        ),
      ).toContain('symlink')
      expect(
        await readdir(join(linked.run.dir, 'dynamic-patches')).catch(() => []),
      ).toEqual([])

      const oversizedPayload = {
        ...patch,
        reason: 'x'.repeat(1024 * 1024),
      }
      const oversized = await runFixture({
        provider: providerId,
        version: '1.0.0',
        onFailure: 'pause',
        config: {
          candidateRef: 'controller-candidates/patch.json',
          patchDigest: matOSControllerDigest(oversizedPayload),
        },
      })
      await mkdir(join(oversized.run.dir, 'controller-candidates'), {
        recursive: true,
      })
      await writeFile(
        join(oversized.run.dir, 'controller-candidates', 'patch.json'),
        JSON.stringify(oversizedPayload),
      )
      const oversizedAdvice = await adviseMatOSWorkflowReadySet({
        runDir: oversized.run.dir,
        snapshot: oversized.snapshot,
        definition: oversized.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      expect(oversizedAdvice.directive?.status).toBe('paused')
      expect(
        await readFile(
          join(oversized.run.dir, 'controllers', 'failures.jsonl'),
          'utf8',
        ),
      ).toContain('exceeds')
      expect(
        await readdir(join(oversized.run.dir, 'dynamic-patches')).catch(() => []),
      ).toEqual([])
    } finally {
      unregister()
    }
  })

  test('replays an identical graph-patch effect without proposing it twice', async () => {
    const providerId = 'bridge-idempotent-graph-patch'
    const unregister = registerGraphPatchProvider(providerId)
    try {
      const patch = {
        operations: [
          {
            op: 'add_node' as const,
            node: {
              id: 'third',
              type: 'exec' as const,
              dependsOn: [],
              command: 'true',
            },
          },
        ],
        risk: 'low' as const,
      }
      const fixture = await runFixture({
        provider: providerId,
        version: '1.0.0',
        onFailure: 'pause',
        config: {
          candidateRef: 'controller-candidates/patch.json',
          patchDigest: matOSControllerDigest(patch),
        },
      })
      await mkdir(join(fixture.run.dir, 'controller-candidates'), {
        recursive: true,
      })
      await writeFile(
        join(fixture.run.dir, 'controller-candidates', 'patch.json'),
        JSON.stringify(patch),
      )
      const input = {
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
        nodeRuns: new Map<string, MatOSWorkflowNodeRunSnapshot>(),
        readyNodeIds: ['first', 'second'],
      }
      expect((await adviseMatOSWorkflowReadySet(input)).directive?.status).toBe(
        'paused',
      )
      expect(
        (
          await adviseMatOSWorkflowReadySet({
            ...input,
            snapshot: await readWorkflowRun(fixture.run.dir),
          })
        ).directive?.status,
      ).toBe('paused')
      const events = await readWorkflowRunEvents(fixture.run.dir)
      expect(
        events.filter(
          event => event.type === 'workflow.controller.graph_patch_proposed',
        ),
      ).toHaveLength(1)
      expect(await readdir(join(fixture.run.dir, 'dynamic-patches'))).toHaveLength(
        1,
      )
    } finally {
      unregister()
    }
  })

  test('maps safe pause/fail actions and explicitly rejects unsafe terminal or human actions', async () => {
    const cases: Array<{
      providerId: string
      intent: MatOSControllerActionIntent
      directive: 'paused' | 'failed'
      receipt: 'applied' | 'rejected'
      eventType: string
    }> = [
      {
        providerId: 'bridge-action-pause',
        intent: { type: 'pause', reason: 'bounded-controller-pause' },
        directive: 'paused',
        receipt: 'applied',
        eventType: 'workflow.controller.pause_applied',
      },
      {
        providerId: 'bridge-action-fail',
        intent: {
          type: 'stop-request',
          status: 'failed',
          reason: 'bounded-controller-fail',
        },
        directive: 'failed',
        receipt: 'applied',
        eventType: 'workflow.controller.stop_request_applied',
      },
      {
        providerId: 'bridge-action-complete-rejected',
        intent: {
          type: 'stop-request',
          status: 'completed',
          reason: 'unproven-completion',
        },
        directive: 'paused',
        receipt: 'rejected',
        eventType: 'workflow.controller.stop_request_rejected',
      },
      {
        providerId: 'bridge-action-human-rejected',
        intent: {
          type: 'request-human',
          promptRef: 'prompt:controller-review',
          reason: 'no-native-human-node',
        },
        directive: 'paused',
        receipt: 'rejected',
        eventType: 'workflow.controller.request_human_rejected',
      },
    ]
    for (const item of cases) {
      const unregister = registerControllerActionProvider(
        item.providerId,
        item.intent,
      )
      try {
        const fixture = await runFixture({
          provider: item.providerId,
          version: '1.0.0',
          onFailure: 'pause',
        })
        const advice = await adviseMatOSWorkflowReadySet({
          runDir: fixture.run.dir,
          snapshot: fixture.snapshot,
          definition: fixture.graph,
          nodeRuns: new Map(),
          readyNodeIds: ['first', 'second'],
        })
        expect(advice.directive?.status).toBe(item.directive)
        expect(await latestControllerReceiptStatus(fixture.run.dir)).toBe(
          item.receipt,
        )
        expect(
          (await readWorkflowRunEvents(fixture.run.dir)).some(
            event => event.type === item.eventType,
          ),
        ).toBe(true)
      } finally {
        unregister()
      }
    }
  })

  test('maps request-validation only to an already-ready native validation node', async () => {
    const providerId = 'bridge-action-validation'
    const unregister = registerControllerActionProvider(providerId, {
      type: 'request-validation',
      validationRef: 'check',
      targetRefs: ['work'],
      reason: 'validate-before-work',
    })
    try {
      const cwd = await mkdtemp(join(tmpdir(), 'matos-controller-validation-'))
      const graph: MatOSWorkflowDefinition = {
        schemaVersion: 1,
        name: 'controller-validation-action',
        parameters: {},
        policy: {
          controller: {
            provider: providerId,
            version: '1.0.0',
            onFailure: 'pause',
          },
        },
        nodes: [
          {
            id: 'check',
            type: 'validate',
            dependsOn: [],
            checks: [{ type: 'expression', value: 'true' }],
          },
          { id: 'work', type: 'exec', dependsOn: [], command: 'true' },
        ],
        outputs: {},
      }
      const run = await createWorkflowRun({
        workflowsDir: join(cwd, '.matos', 'workflows'),
        workflowRef: 'workflow:controller-validation-action@1.0.0',
        graphSnapshot: graph,
        projectCwd: cwd,
        workspaceDir: cwd,
      })
      const advice = await adviseMatOSWorkflowReadySet({
        runDir: run.dir,
        snapshot: await readWorkflowRun(run.dir),
        definition: graph,
        nodeRuns: new Map(),
        readyNodeIds: ['work', 'check'],
      })
      expect(advice).toEqual({ orderedNodeIds: ['check', 'work'] })
      expect(await latestControllerReceiptStatus(run.dir)).toBe('applied')
      expect(
        (await readWorkflowRunEvents(run.dir)).some(
          event =>
            event.type === 'workflow.controller.request_validation_applied',
        ),
      ).toBe(true)
    } finally {
      unregister()
    }
  })

  test('maps request-human only to an already-ready native human node', async () => {
    const providerId = 'bridge-action-human'
    const unregister = registerControllerActionProvider(providerId, {
      type: 'request-human',
      promptRef: 'review',
      reason: 'native-review-required',
    })
    try {
      const cwd = await mkdtemp(join(tmpdir(), 'matos-controller-human-'))
      const graph: MatOSWorkflowDefinition = {
        schemaVersion: 1,
        name: 'controller-human-action',
        parameters: {},
        policy: {
          controller: {
            provider: providerId,
            version: '1.0.0',
            onFailure: 'pause',
          },
        },
        nodes: [
          {
            id: 'review',
            type: 'human',
            dependsOn: [],
            prompt: 'Review the native workflow evidence.',
          },
          { id: 'work', type: 'exec', dependsOn: [], command: 'true' },
        ],
        outputs: {},
      }
      const run = await createWorkflowRun({
        workflowsDir: join(cwd, '.matos', 'workflows'),
        workflowRef: 'workflow:controller-human-action@1.0.0',
        graphSnapshot: graph,
        projectCwd: cwd,
        workspaceDir: cwd,
      })
      const advice = await adviseMatOSWorkflowReadySet({
        runDir: run.dir,
        snapshot: await readWorkflowRun(run.dir),
        definition: graph,
        nodeRuns: new Map(),
        readyNodeIds: ['work', 'review'],
      })
      expect(advice).toEqual({ orderedNodeIds: ['review', 'work'] })
      expect(await latestControllerReceiptStatus(run.dir)).toBe('applied')
      expect(
        (await readWorkflowRunEvents(run.dir)).some(
          event => event.type === 'workflow.controller.request_human_applied',
        ),
      ).toBe(true)
    } finally {
      unregister()
    }
  })

  test('ticks continuation-recovery after a DAG node failure and applies native safe recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-controller-native-recovery-'))
    const graph: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'controller-native-recovery',
      parameters: {},
      policy: {
        controller: {
          provider: 'continuation-recovery',
          version: '1.0.0',
          onFailure: 'pause',
        },
      },
      nodes: [
        {
          id: 'flaky',
          type: 'exec',
          dependsOn: [],
          command:
            'printf x >> controller-recovery-attempts.txt; if [ ! -f controller-recovery.marker ]; then touch controller-recovery.marker; exit 7; fi; printf recovered',
        },
      ],
      outputs: { result: { value: '{{ nodes.flaky.outputs.stdout }}' } },
    }
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:controller-native-recovery@1.0.0',
      parameters: {},
      definition: graph,
      workspaceDir: root,
    })
    expect(run.status).toBe('completed')
    expect(run.outputs.result).toBe('recovered')
    const receiptFiles = await readdir(
      join(run.runDir, 'controllers', 'action-receipts'),
    )
    expect(receiptFiles.filter(file => file.endsWith('.jsonl'))).toHaveLength(1)
    const receiptLog = await readFile(
      join(run.runDir, 'controllers', 'action-receipts', receiptFiles[0]!),
      'utf8',
    )
    expect(receiptLog).toContain('"status":"proposed"')
    expect(receiptLog).toContain('"status":"applied"')
    expect(receiptLog).toContain('workflow-recovery-report:')

    const persisted = await readWorkflowRun(run.runDir)
    const persistedDefinition = JSON.parse(
      await readFile(join(run.runDir, persisted.graphSnapshotPath), 'utf8'),
    ) as MatOSWorkflowDefinition
    const replayAdvice = await adviseMatOSWorkflowReadySet({
      runDir: run.runDir,
      snapshot: { ...persisted, status: 'failed' },
      definition: persistedDefinition,
      nodeRuns: new Map<string, MatOSWorkflowNodeRunSnapshot>([
        [
          'flaky',
          {
            nodeId: 'flaky',
            status: 'failed',
            attempts: 1,
            updatedAt: new Date().toISOString(),
          },
        ],
      ]),
      readyNodeIds: [],
    })
    expect(replayAdvice.directive).toBeUndefined()
    expect(
      await readFile(join(root, 'controller-recovery-attempts.txt'), 'utf8'),
    ).toBe('xx')
    expect(
      (
        await readFile(
          join(run.runDir, 'controllers', 'action-receipts', receiptFiles[0]!),
          'utf8',
        )
      ).trim().split('\n'),
    ).toHaveLength(2)
  })

  test('ticks continuation-recovery after a state-machine terminal node failure', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-controller-state-machine-recovery-'),
    )
    const graph: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'controller-state-machine-recovery',
      parameters: {},
      policy: {
        executionModel: 'state_machine',
        stateMachine: { initialNodeId: 'flaky', maxTransitions: 2 },
        controller: {
          provider: 'continuation-recovery',
          version: '1.0.0',
          onFailure: 'pause',
        },
      },
      nodes: [
        {
          id: 'flaky',
          type: 'exec',
          dependsOn: [],
          command:
            'printf x >> state-machine-recovery-attempts.txt; if [ ! -f state-machine-recovery.marker ]; then touch state-machine-recovery.marker; exit 9; fi; printf recovered',
        },
      ],
      transitions: [],
      outputs: { result: { value: '{{ nodes.flaky.outputs.stdout }}' } },
    }
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:controller-state-machine-recovery@1.0.0',
      parameters: {},
      definition: graph,
      workspaceDir: root,
    })
    expect(run.status).toBe('completed')
    expect(run.outputs.result).toBe('recovered')
    expect(
      await readFile(join(root, 'state-machine-recovery-attempts.txt'), 'utf8'),
    ).toBe('xx')
    const events = await readWorkflowRunEvents(run.runDir)
    expect(
      events.some(
        event =>
          event.type === 'workflow.controller.failure_tick_started' &&
          Array.isArray(event.data.failedNodeIds) &&
          event.data.failedNodeIds.includes('flaky'),
      ),
    ).toBe(true)
    expect(
      events.some(
        event => event.type === 'workflow.state_machine.frame_retry_requested',
      ),
    ).toBe(true)
    const receiptFiles = await readdir(
      join(run.runDir, 'controllers', 'action-receipts'),
    )
    const receiptLog = await readFile(
      join(run.runDir, 'controllers', 'action-receipts', receiptFiles[0]!),
      'utf8',
    )
    expect(receiptLog).toContain('"status":"applied"')
  })

  test('does not block production scheduling on a slow shadow controller and flushes it at finalize', async () => {
    const providerId = 'bridge-slow-shadow'
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId),
      create: () => ({
        id: providerId,
        version: '1.0.0',
        stateVersion: 1,
        initialize: () => ({}),
        observe: state => state,
        propose: async () => {
          entered()
          await gate
          return []
        },
        serializeState: () => ({}),
        finalize: () => ({ outcomeRefs: [] }),
      }),
    })
    try {
      const fixture = await runFixture({
        provider: providerId,
        version: '1.0.0',
        mode: 'shadow',
      })
      const advice = await Promise.race([
        adviseMatOSWorkflowReadySet({
          runDir: fixture.run.dir,
          snapshot: fixture.snapshot,
          definition: fixture.graph,
          nodeRuns: new Map(),
          readyNodeIds: ['first', 'second'],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('shadow controller blocked scheduling')), 100),
        ),
      ])
      expect(advice).toEqual({ orderedNodeIds: ['first', 'second'] })
      await enteredPromise

      let finalized = false
      const finalizing = finalizeMatOSWorkflowController({
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
      }).then(() => {
        finalized = true
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(finalized).toBe(true)
      release()
      await finalizing
      await waitForMatOSWorkflowShadowController(fixture.run.dir)
      expect(
        await readFile(
          join(fixture.run.dir, 'controllers', 'finalize.json'),
          'utf8',
        ),
      ).toContain(providerId)
    } finally {
      release?.()
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })

  test('bounds shadow controller backlog and persists overflow evidence', async () => {
    const providerId = 'bridge-shadow-overflow'
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId),
      create: () => ({
        id: providerId,
        version: '1.0.0',
        stateVersion: 1,
        initialize: () => ({}),
        observe: state => state,
        propose: async () => {
          await gate
          return []
        },
        serializeState: () => ({}),
        finalize: () => ({ outcomeRefs: [] }),
      }),
    })
    try {
      const fixture = await runFixture({
        provider: providerId,
        version: '1.0.0',
        mode: 'shadow',
      })
      for (let index = 0; index < 6; index += 1) {
        expect(
          await adviseMatOSWorkflowReadySet({
            runDir: fixture.run.dir,
            snapshot: fixture.snapshot,
            definition: fixture.graph,
            nodeRuns: new Map(),
            readyNodeIds: ['first', 'second'],
          }),
        ).toEqual({ orderedNodeIds: ['first', 'second'] })
      }
      await finalizeMatOSWorkflowController({
        runDir: fixture.run.dir,
        snapshot: fixture.snapshot,
        definition: fixture.graph,
      })
      release()
      await waitForMatOSWorkflowShadowController(fixture.run.dir)
      const overflow = await readFile(
        join(fixture.run.dir, 'controllers', 'shadow-overflow.jsonl'),
        'utf8',
      )
      expect(overflow.trim().split('\n')).toHaveLength(2)
      expect(overflow).toContain('per-run-capacity')
      expect(
        (await readWorkflowRunEvents(fixture.run.dir)).filter(
          event => event.type === 'workflow.controller.shadow_overflow',
        ),
      ).toHaveLength(2)
    } finally {
      release?.()
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })

  test('enforces the global shadow controller capacity across runs', async () => {
    const providerId = 'bridge-shadow-global-overflow'
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    matOSControllerRegistry.register({
      id: providerId,
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: controllerImplementationDigest(providerId),
      create: () => ({
        id: providerId,
        version: '1.0.0',
        stateVersion: 1,
        initialize: () => ({}),
        observe: state => state,
        propose: async () => {
          await gate
          return []
        },
        serializeState: () => ({}),
      }),
    })
    const fixtures: Awaited<ReturnType<typeof runFixture>>[] = []
    try {
      for (let index = 0; index < 9; index += 1) {
        fixtures.push(
          await runFixture({
            provider: providerId,
            version: '1.0.0',
            mode: 'shadow',
          }),
        )
      }
      for (const fixture of fixtures.slice(0, 8)) {
        for (let index = 0; index < 4; index += 1) {
          await adviseMatOSWorkflowReadySet({
            runDir: fixture.run.dir,
            snapshot: fixture.snapshot,
            definition: fixture.graph,
            nodeRuns: new Map(),
            readyNodeIds: ['first', 'second'],
          })
        }
      }
      const overflowFixture = fixtures[8]!
      await adviseMatOSWorkflowReadySet({
        runDir: overflowFixture.run.dir,
        snapshot: overflowFixture.snapshot,
        definition: overflowFixture.graph,
        nodeRuns: new Map(),
        readyNodeIds: ['first', 'second'],
      })
      release()
      await Promise.all(
        fixtures.map(fixture =>
          waitForMatOSWorkflowShadowController(fixture.run.dir),
        ),
      )
      const overflow = await readFile(
        join(
          overflowFixture.run.dir,
          'controllers',
          'shadow-overflow.jsonl',
        ),
        'utf8',
      )
      expect(overflow).toContain('global-capacity')
      expect(
        (await readWorkflowRunEvents(overflowFixture.run.dir)).some(
          event =>
            event.type === 'workflow.controller.shadow_overflow' &&
            event.data.reason === 'global-capacity',
        ),
      ).toBe(true)
    } finally {
      release?.()
      matOSControllerRegistry.unregister(providerId, '1.0.0')
    }
  })
})
