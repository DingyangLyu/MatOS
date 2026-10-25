import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InMemoryMatOSControllerCheckpointStore,
  JsonlMatOSControllerCheckpointStore,
  MATOS_CONTROLLER_CHECKPOINT_STORE_MAX_BYTES,
  MatOSControllerCheckpointError,
  assertMatOSControllerCheckpointCompatible,
  createMatOSControllerCheckpoint,
  sanitizeMatOSControllerCheckpoint,
  type MatOSControllerCheckpoint,
  type MatOSControllerSequencedAction,
} from './checkpoint.js'
import { createMatOSControllerAction } from './protocol.js'
import {
  controllerTestBudget,
  controllerTestObservation,
} from './testFixtures.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

const provider = {
  controllerId: 'greedy-baseline',
  providerId: 'greedy-baseline',
  providerVersion: '1.0.0',
  stateVersion: 1,
  configDigest: 'config-digest-1',
  implementationDigest: '4'.repeat(64),
} as const

function checkpointFor(input: {
  observation: ReturnType<typeof controllerTestObservation>
  checkpointSequence: number
  actions: readonly MatOSControllerSequencedAction[]
  previous?: MatOSControllerCheckpoint
}): MatOSControllerCheckpoint {
  return createMatOSControllerCheckpoint({
    sequence: input.checkpointSequence,
    ...(input.previous
      ? { previousCheckpointDigest: input.previous.checkpointDigest }
      : {}),
    createdAt: `2026-07-13T00:00:0${input.checkpointSequence}.000Z`,
    runRef: input.observation.runRef,
    scopeRef: input.observation.scopeRef,
    eventCursor: input.observation.eventCursor,
    seed: 41,
    provider,
    manifest: input.observation.manifest,
    graph: input.observation.graph,
    budget: input.observation.budget,
    observationDigest: input.observation.observationDigest,
    actionSequence: input.actions,
    state: { observed: input.checkpointSequence + 1 },
  })
}

describe('MatOS controller checkpoints', () => {
  test('persist manifest/graph/budget/digest and an append-only action sequence', async () => {
    const store = new InMemoryMatOSControllerCheckpointStore()
    const firstObservation = controllerTestObservation()
    const firstAction = createMatOSControllerAction({
      observation: firstObservation,
      seed: 41,
      intent: {
        type: 'rank-ready',
        orderedNodeRefs: [...firstObservation.readyNodeRefs],
      },
    })
    const firstActions = [{ sequence: 1, action: firstAction }]
    const first = checkpointFor({
      observation: firstObservation,
      checkpointSequence: 0,
      actions: firstActions,
    })
    await store.append(first, { expectedPreviousCheckpointDigest: null })

    const secondObservation = controllerTestObservation({
      eventCursor: 'event:2',
      graphSnapshotRef: 'graph-snapshot:2',
      graphDigest: 'graph-digest-2',
      graphVersion: 2,
      budget: controllerTestBudget({ actions: 1 }),
    })
    const secondAction = createMatOSControllerAction({
      observation: secondObservation,
      seed: 41,
      intent: { type: 'noop', reason: 'waiting-for-runtime' },
    })
    const second = checkpointFor({
      observation: secondObservation,
      checkpointSequence: 1,
      previous: first,
      actions: [
        ...firstActions,
        { sequence: 2, action: secondAction },
      ],
    })
    await store.append(second, {
      expectedPreviousCheckpointDigest: first.checkpointDigest,
    })

    const latest = await store.latest({
      runRef: first.runRef,
      scopeRef: first.scopeRef,
      controllerId: provider.controllerId,
    })
    expect(latest?.manifest).toEqual(secondObservation.manifest)
    expect(latest?.graph).toEqual(secondObservation.graph)
    expect(latest?.budget).toEqual(secondObservation.budget)
    expect(latest?.observationDigest).toBe(
      secondObservation.observationDigest,
    )
    expect(latest?.actionSequence.map(item => item.action.actionId)).toEqual([
      firstAction.actionId,
      secondAction.actionId,
    ])

    await expect(
      store.append(second, {
        expectedPreviousCheckpointDigest: first.checkpointDigest,
      }),
    ).rejects.toMatchObject({ code: 'checkpoint-cas-mismatch' })
  })

  test('writes versioned JSONL records without rewriting prior lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-controller-checkpoint-'))
    temporaryRoots.push(root)
    const path = join(root, 'checkpoints.jsonl')
    const store = new JsonlMatOSControllerCheckpointStore(path)
    const observation = controllerTestObservation({ readyNodeRefs: [] })
    const action = createMatOSControllerAction({
      observation,
      seed: 41,
      intent: { type: 'noop', reason: 'nothing-ready' },
    })
    const first = checkpointFor({
      observation,
      checkpointSequence: 0,
      actions: [{ sequence: 1, action }],
    })
    await store.append(first, { expectedPreviousCheckpointDigest: null })
    const second = checkpointFor({
      observation,
      checkpointSequence: 1,
      actions: [{ sequence: 1, action }],
      previous: first,
    })
    await store.append(second, {
      expectedPreviousCheckpointDigest: first.checkpointDigest,
    })

    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).checkpointId).toBe(first.checkpointId)
    expect(JSON.parse(lines[1]).previousCheckpointDigest).toBe(
      first.checkpointDigest,
    )
  })

  test('fails explicitly on schema/state versions instead of guessing', () => {
    const observation = controllerTestObservation({ readyNodeRefs: [] })
    const checkpoint = checkpointFor({
      observation,
      checkpointSequence: 0,
      actions: [],
    })
    expect(() =>
      sanitizeMatOSControllerCheckpoint({
        ...checkpoint,
        schemaVersion: 99,
      }),
    ).toThrow(MatOSControllerCheckpointError)
    expect(() =>
      assertMatOSControllerCheckpointCompatible(checkpoint, {
        runRef: checkpoint.runRef,
        scopeRef: checkpoint.scopeRef,
        seed: checkpoint.seed,
        manifest: checkpoint.manifest,
        provider: { ...provider, stateVersion: 2 },
      }),
    ).toThrow(/not compatible/)
  })

  test('serializes cross-instance checkpoint CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-controller-checkpoint-cas-'))
    temporaryRoots.push(root)
    const path = join(root, 'checkpoints.jsonl')
    const firstStore = new JsonlMatOSControllerCheckpointStore(path)
    const secondStore = new JsonlMatOSControllerCheckpointStore(path)
    const observation = controllerTestObservation({ readyNodeRefs: [] })
    const checkpoint = checkpointFor({
      observation,
      checkpointSequence: 0,
      actions: [],
    })
    const settled = await Promise.allSettled([
      firstStore.append(checkpoint, { expectedPreviousCheckpointDigest: null }),
      secondStore.append(checkpoint, { expectedPreviousCheckpointDigest: null }),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(item => item.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'checkpoint-cas-mismatch',
    })
  })

  test('rejects symlinked and oversized checkpoint stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-controller-checkpoint-safe-'))
    temporaryRoots.push(root)
    const outside = join(root, 'outside.jsonl')
    const linked = join(root, 'linked.jsonl')
    await writeFile(outside, '')
    await symlink(outside, linked)
    await expect(
      new JsonlMatOSControllerCheckpointStore(linked).list({
        runRef: 'workflow-run:1',
        scopeRef: 'user:alice',
        controllerId: provider.controllerId,
      }),
    ).rejects.toMatchObject({ code: 'checkpoint-corrupt' })

    const oversized = join(root, 'oversized.jsonl')
    await writeFile(
      oversized,
      Buffer.alloc(MATOS_CONTROLLER_CHECKPOINT_STORE_MAX_BYTES + 1, 0x20),
    )
    await expect(
      new JsonlMatOSControllerCheckpointStore(oversized).list({
        runRef: 'workflow-run:1',
        scopeRef: 'user:alice',
        controllerId: provider.controllerId,
      }),
    ).rejects.toMatchObject({ code: 'checkpoint-corrupt' })
  })
})
