import { describe, expect, test } from 'bun:test'
import {
  MatOSControllerProtocolError,
  createMatOSControllerAction,
  sanitizeMatOSControllerAction,
  sanitizeMatOSControllerObservation,
  type MatOSControllerActionIntent,
} from './protocol.js'
import { controllerTestObservation } from './testFixtures.js'

describe('MatOS controller protocol', () => {
  test('sanitizes to a frozen reference-only observation and verifies its digest', () => {
    const observation = controllerTestObservation()
    const sanitized = sanitizeMatOSControllerObservation({
      ...observation,
      secretPrompt: 'must not cross the controller boundary',
    })

    expect(sanitized).toEqual(observation)
    expect('secretPrompt' in sanitized).toBe(false)
    expect(Object.isFrozen(sanitized)).toBe(true)
    expect(Object.isFrozen(sanitized.graph)).toBe(true)
    expect(Object.isFrozen(sanitized.readyNodeRefs)).toBe(true)
    expect(() => {
      ;(sanitized.readyNodeRefs as string[])[0] = 'node:changed'
    }).toThrow()

    expect(() =>
      sanitizeMatOSControllerObservation({
        ...observation,
        eventCursor: 'event:tampered',
      }),
    ).toThrow(MatOSControllerProtocolError)
  })

  test('binds structured actions to exact scope and observation/graph CAS', () => {
    const observation = controllerTestObservation()
    const action = createMatOSControllerAction({
      observation,
      seed: 17,
      budgetUsage: { actions: 1 },
      intent: {
        type: 'rank-ready',
        orderedNodeRefs: ['node:m', 'node:z', 'node:a'],
      },
    })

    expect(action.cas).toEqual({
      expectedObservationDigest: observation.observationDigest,
      expectedEventCursor: observation.eventCursor,
      expectedManifestDigest: observation.manifest.digest,
      expectedGraphDigest: observation.graph.digest,
      expectedGraphVersion: observation.graph.version,
    })
    expect(sanitizeMatOSControllerAction(action, observation)).toEqual(action)

    const otherScope = controllerTestObservation({ scopeRef: 'user:bob' })
    expect(() => sanitizeMatOSControllerAction(action, otherScope)).toThrow(
      /scopeRef/,
    )
    const newerGraph = controllerTestObservation({
      eventCursor: 'event:2',
      graphDigest: 'graph-digest-2',
      graphVersion: 2,
    })
    expect(() => sanitizeMatOSControllerAction(action, newerGraph)).toThrow(
      /CAS/,
    )
  })

  test('rejects missing ready nodes and direct retry/backtrack action kinds', () => {
    const observation = controllerTestObservation()
    expect(() =>
      createMatOSControllerAction({
        observation,
        seed: 1,
        intent: {
          type: 'rank-ready',
          orderedNodeRefs: ['node:z'],
        },
      }),
    ).toThrow(/every supplied ready node/)

    expect(() =>
      createMatOSControllerAction({
        observation,
        seed: 1,
        intent: {
          type: 'retry',
          nodeId: 'node:z',
        } as unknown as MatOSControllerActionIntent,
      }),
    ).toThrow(/unsupported controller action/)
  })

  test('requires graph patch candidates to carry the observed base CAS', () => {
    const observation = controllerTestObservation()
    expect(() =>
      createMatOSControllerAction({
        observation,
        seed: 2,
        intent: {
          type: 'propose-graph-patch',
          reason: 'candidate improves coverage',
          candidate: {
            candidateRef: 'candidate:1',
            patchDigest: 'patch-digest:1',
            baseGraphDigest: 'stale-graph',
            baseGraphVersion: observation.graph.version,
          },
        },
      }),
    ).toThrow(/graph CAS/)
  })
})
