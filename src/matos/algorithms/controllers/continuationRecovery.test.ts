import { describe, expect, test } from 'bun:test'
import { createMatOSControllerRunner } from './runner.js'
import { InMemoryMatOSControllerCheckpointStore } from './checkpoint.js'
import { controllerTestBounds, controllerTestObservation } from './testFixtures.js'
import { matOSControllerRegistry } from './registry.js'
import { ensureBuiltinMatOSWorkflowControllers } from '../workflowControllers.js'

describe('continuation-recovery workflow controller', () => {
  test('delegates a failed observation to native recovery without choosing an action', async () => {
    ensureBuiltinMatOSWorkflowControllers()
    const observation = controllerTestObservation({
      status: 'failed',
      readyNodeRefs: [],
      failedNodeRefs: ['failed-node'],
    })
    const controller = matOSControllerRegistry.create({
      providerId: 'continuation-recovery',
      version: '1.0.0',
      config: {},
      seed: 17,
      bounds: controllerTestBounds,
    })
    const runner = createMatOSControllerRunner({
      controller,
      checkpointStore: new InMemoryMatOSControllerCheckpointStore(),
      runRef: observation.runRef,
      definitionRef: 'workflow:test@1.0.0',
      objectiveRef: 'objective:recover-safely@1',
      scopeRef: observation.scopeRef,
      manifest: observation.manifest,
      providerId: 'continuation-recovery',
      configDigest: 'config-empty',
      seed: 17,
      bounds: controllerTestBounds,
    })
    const step = await runner.step(observation)
    expect(step.actions).toHaveLength(1)
    expect(step.actions[0]).toMatchObject({
      type: 'recovery-request',
      mode: 'reconcile',
      reason: 'delegate-failed-run-to-native-recovery',
    })
    expect(
      step.actions[0]?.type === 'recovery-request'
        ? step.actions[0].checkpointRef
        : '',
    ).toMatch(/^workflow-recovery:/)
  })

  test('does not intervene in a healthy running observation', async () => {
    ensureBuiltinMatOSWorkflowControllers()
    const observation = controllerTestObservation({
      status: 'running',
      failedNodeRefs: [],
    })
    const controller = matOSControllerRegistry.create({
      providerId: 'continuation-recovery',
      version: '1.0.0',
      config: {},
      seed: 17,
      bounds: controllerTestBounds,
    })
    const runner = createMatOSControllerRunner({
      controller,
      checkpointStore: new InMemoryMatOSControllerCheckpointStore(),
      runRef: observation.runRef,
      definitionRef: 'workflow:test@1.0.0',
      objectiveRef: 'objective:recover-safely@1',
      scopeRef: observation.scopeRef,
      manifest: observation.manifest,
      providerId: 'continuation-recovery',
      configDigest: 'config-empty',
      seed: 17,
      bounds: controllerTestBounds,
    })
    expect((await runner.step(observation)).actions).toEqual([])
  })

  test('fails closed instead of partially recovering multiple failed nodes', async () => {
    ensureBuiltinMatOSWorkflowControllers()
    const observation = controllerTestObservation({
      status: 'failed',
      readyNodeRefs: [],
      failedNodeRefs: ['failed-a', 'failed-b'],
    })
    const controller = matOSControllerRegistry.create({
      providerId: 'continuation-recovery',
      version: '1.0.0',
      config: {},
      seed: 17,
      bounds: controllerTestBounds,
    })
    const runner = createMatOSControllerRunner({
      controller,
      checkpointStore: new InMemoryMatOSControllerCheckpointStore(),
      runRef: observation.runRef,
      definitionRef: 'workflow:test@1.0.0',
      objectiveRef: 'objective:recover-safely@1',
      scopeRef: observation.scopeRef,
      manifest: observation.manifest,
      providerId: 'continuation-recovery',
      configDigest: 'config-empty',
      seed: 17,
      bounds: controllerTestBounds,
    })
    expect((await runner.step(observation)).actions).toEqual([])
  })
})
