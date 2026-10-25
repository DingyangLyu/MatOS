import { describe, expect, test } from 'bun:test'
import {
  MatOSControllerRegistryError,
  createMatOSControllerRegistry,
} from './registry.js'
import { createGreedyController } from './strategies/greedy.js'
import { controllerTestBounds } from './testFixtures.js'

describe('MatOS controller registry', () => {
  test('resolves deterministic pinned versions and rejects replacement', () => {
    const registry = createMatOSControllerRegistry()
    registry.register({
      id: 'demo-search',
      version: '1.9.0',
      stateVersion: 1,
      implementationDigest: '1'.repeat(64),
      create: () =>
        createGreedyController({ id: 'demo-search', version: '1.9.0' }),
    })
    registry.register({
      id: 'demo-search',
      version: '1.10.0',
      stateVersion: 1,
      implementationDigest: '2'.repeat(64),
      create: () =>
        createGreedyController({ id: 'demo-search', version: '1.10.0' }),
    })

    expect(registry.resolve('DEMO-SEARCH').version).toBe('1.10.0')
    expect(registry.resolve('demo-search', '1.9.0').version).toBe('1.9.0')
    expect(() =>
      registry.register({
        id: 'demo-search',
        version: '1.9.0',
        stateVersion: 1,
        implementationDigest: '1'.repeat(64),
        create: () =>
          createGreedyController({ id: 'demo-search', version: '1.9.0' }),
      }),
    ).toThrow(MatOSControllerRegistryError)
  })

  test('verifies that provider metadata matches the created controller', () => {
    const registry = createMatOSControllerRegistry()
    registry.register({
      id: 'declared-provider',
      version: '1.0.0',
      stateVersion: 1,
      implementationDigest: '3'.repeat(64),
      create: () => createGreedyController(),
    })

    expect(() =>
      registry.create({
        providerId: 'declared-provider',
        version: '1.0.0',
        config: {},
        seed: 4,
        bounds: controllerTestBounds,
      }),
    ).toThrow(/incompatible controller/)
  })
})
