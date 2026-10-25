import { describe, expect, test } from 'bun:test'
import {
  InMemoryMatOSControllerCheckpointStore,
} from './checkpoint.js'
import {
  MatOSControllerProtocolError,
  createMatOSControllerAction,
  createMatOSControllerSearchBounds,
  freezeMatOSControllerValue,
  type MatOSControllerObservation,
  type MatOSRunController,
} from './protocol.js'
import { createMatOSControllerRunner } from './runner.js'
import { createGreedyController } from './strategies/greedy.js'
import {
  controllerTestBounds,
  controllerTestObservation,
} from './testFixtures.js'

function runnerOptions<State>(
  store: InMemoryMatOSControllerCheckpointStore,
  controller: MatOSRunController<State>,
) {
  return {
    controller,
    checkpointStore: store,
    runRef: 'workflow-run:1',
    definitionRef: 'workflow:generic',
    objectiveRef: 'objective:quality',
    scopeRef: 'user:alice',
    manifest: {
      ref: 'algorithm-manifest:1',
      digest: 'manifest-digest-1',
    },
    configDigest: 'controller-config-digest-1',
    seed: 73,
    bounds: controllerTestBounds,
    now: () => '2026-07-13T12:00:00.000Z',
  } as const
}

describe('MatOS controller runner', () => {
  test('returns actions only and greedy preserves supplied ready order exactly', async () => {
    const store = new InMemoryMatOSControllerCheckpointStore()
    const runner = createMatOSControllerRunner(
      runnerOptions(store, createGreedyController()),
    )
    const observation = controllerTestObservation({
      readyNodeRefs: ['node:third', 'node:first', 'node:second'],
    })

    const result = await runner.step(observation)

    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({
      type: 'rank-ready',
      orderedNodeRefs: ['node:third', 'node:first', 'node:second'],
      scopeRef: 'user:alice',
      runRef: 'workflow-run:1',
      seed: 73,
    })
    expect(result.checkpoint.actionSequence).toHaveLength(1)
    expect(result.checkpoint.actionSequence[0].action).toEqual(
      result.actions[0],
    )
    expect(result.replayed).toBe(false)
  })

  test('requires explicit scopeRef equality before invoking a controller', async () => {
    const runner = createMatOSControllerRunner(
      runnerOptions(
        new InMemoryMatOSControllerCheckpointStore(),
        createGreedyController(),
      ),
    )
    await expect(
      runner.step(controllerTestObservation({ scopeRef: 'user:alice ' })),
    ).rejects.toMatchObject({ code: 'scope-mismatch' })
  })

  test('rejects stale provider CAS and over-budget search usage', async () => {
    type State = Readonly<{ observation?: MatOSControllerObservation }>
    const current = controllerTestObservation()
    const stale = controllerTestObservation({
      eventCursor: 'event:stale',
      graphDigest: 'graph:stale',
      graphVersion: 0,
    })
    const staleController: MatOSRunController<State> = {
      id: 'stale-controller',
      version: '1.0.0',
      stateVersion: 1,
      initialize: () => ({}),
      observe: (_state, observation) => ({ observation }),
      propose: () => [
        createMatOSControllerAction({
          observation: stale,
          seed: 73,
          intent: { type: 'noop', reason: 'stale proposal' },
        }),
      ],
    }
    const staleRunner = createMatOSControllerRunner(
      runnerOptions(
        new InMemoryMatOSControllerCheckpointStore(),
        staleController,
      ),
    )
    await expect(staleRunner.step(current)).rejects.toMatchObject({
      code: 'action-cas-mismatch',
    })

    const expensiveController: MatOSRunController<State> = {
      ...staleController,
      id: 'expensive-controller',
      propose: (state, context) => [
        createMatOSControllerAction({
          observation: context.observation,
          seed: context.seed,
          budgetUsage: { candidates: 129 },
          intent: { type: 'noop', reason: String(Boolean(state.observation)) },
        }),
      ],
    }
    const expensiveRunner = createMatOSControllerRunner(
      runnerOptions(
        new InMemoryMatOSControllerCheckpointStore(),
        expensiveController,
      ),
    )
    await expect(expensiveRunner.step(current)).rejects.toMatchObject({
      code: 'budget-exceeded',
    })
  })

  test('restores the latest checkpoint and replays the same action ids once', async () => {
    const store = new InMemoryMatOSControllerCheckpointStore()
    const observation = controllerTestObservation()
    const firstRunner = createMatOSControllerRunner(
      runnerOptions(store, createGreedyController()),
    )
    const first = await firstRunner.step(observation)

    const resumedRunner = createMatOSControllerRunner(
      runnerOptions(store, createGreedyController()),
    )
    await resumedRunner.restore()
    const replay = await resumedRunner.step(observation)

    expect(replay.replayed).toBe(true)
    expect(replay.actions.map(action => action.actionId)).toEqual(
      first.actions.map(action => action.actionId),
    )
    const checkpoints = await store.list({
      runRef: observation.runRef,
      scopeRef: observation.scopeRef,
      controllerId: 'greedy-baseline',
    })
    expect(checkpoints).toHaveLength(1)
  })

  test('rejects checkpoint restore when the implementation digest changes', async () => {
    const store = new InMemoryMatOSControllerCheckpointStore()
    const observation = controllerTestObservation()
    const original = createMatOSControllerRunner({
      ...runnerOptions(store, createGreedyController()),
      implementationDigest: 'a'.repeat(64),
    })
    await original.step(observation)

    const replacement = createMatOSControllerRunner({
      ...runnerOptions(store, createGreedyController()),
      implementationDigest: 'b'.repeat(64),
    })
    await expect(replacement.restore()).rejects.toThrow(/not compatible/)
  })

  test('bounds an asynchronous controller lifecycle by wall time', async () => {
    const controller: MatOSRunController<Record<string, never>> = {
      id: 'never-yields',
      version: '1.0.0',
      stateVersion: 1,
      initialize: () => freezeMatOSControllerValue({}),
      observe: state => state,
      propose: () => new Promise(() => undefined),
    }
    const runner = createMatOSControllerRunner({
      ...runnerOptions(
        new InMemoryMatOSControllerCheckpointStore(),
        controller,
      ),
      bounds: createMatOSControllerSearchBounds({
        maxActions: 1,
        maxCandidates: 1,
        maxDepth: 1,
        maxWallTimeMs: 10,
        maxCostUsd: 0,
      }),
    })

    await expect(runner.step(controllerTestObservation())).rejects.toBeInstanceOf(
      MatOSControllerProtocolError,
    )
  })
})
