import {
  MatOSControllerProtocolError,
  createMatOSControllerAction,
  freezeMatOSControllerValue,
  sanitizeMatOSControllerObservation,
  toMatOSControllerJsonValue,
  type MatOSControllerAction,
  type MatOSControllerJsonValue,
  type MatOSRunController,
} from '../protocol.js'
import type { MatOSSearchStrategyControllerState } from './searchSupport.js'

export const MATOS_GREEDY_CONTROLLER_ID = 'greedy-baseline'

export function createGreedyController(input: {
  id?: string
  version?: string
} = {}): MatOSRunController<MatOSSearchStrategyControllerState> {
  return freezeMatOSControllerValue({
    id: input.id ?? MATOS_GREEDY_CONTROLLER_ID,
    version: input.version ?? '1.0.0',
    stateVersion: 1,
    initialize: () => freezeMatOSControllerValue({ observationCount: 0 }),
    observe: (state, observation) =>
      freezeMatOSControllerValue({
        observationCount: state.observationCount + 1,
        observation,
      }),
    propose: (state, context): readonly MatOSControllerAction[] => {
      if (!state.observation) {
        throw new MatOSControllerProtocolError(
          'invalid-observation',
          'greedy controller must observe before proposing',
        )
      }
      if (
        state.observation.observationDigest !==
        context.observation.observationDigest
      ) {
        throw new MatOSControllerProtocolError(
          'observation-digest-mismatch',
          'greedy controller state does not contain the current observation',
        )
      }
      if (context.observation.budget.remaining.actions < 1) return []
      const intent =
        context.observation.readyNodeRefs.length > 0
          ? {
              type: 'rank-ready' as const,
              // This is deliberately not sorted. Static scheduler order is the
              // baseline and remains byte-for-byte authoritative.
              orderedNodeRefs: [...context.observation.readyNodeRefs],
            }
          : {
              type: 'noop' as const,
              reason: `no-ready-nodes:${context.observation.status}`,
            }
      return [
        createMatOSControllerAction({
          observation: context.observation,
          seed: context.seed,
          budgetUsage: { actions: 1 },
          intent,
        }),
      ]
    },
    serializeState: state => toMatOSControllerJsonValue(state),
    restoreState: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new MatOSControllerProtocolError(
          'invalid-protocol-value',
          'serialized greedy controller state is invalid',
        )
      }
      const source = value as Record<string, MatOSControllerJsonValue>
      const observationCount = source.observationCount
      if (
        typeof observationCount !== 'number' ||
        !Number.isInteger(observationCount) ||
        observationCount < 0
      ) {
        throw new MatOSControllerProtocolError(
          'invalid-protocol-value',
          'serialized observationCount is invalid',
        )
      }
      return freezeMatOSControllerValue({
        observationCount,
        ...(source.observation
          ? {
              observation: sanitizeMatOSControllerObservation(
                source.observation,
              ),
            }
          : {}),
      })
    },
    finalize: () => ({ outcomeRefs: [] }),
  })
}
