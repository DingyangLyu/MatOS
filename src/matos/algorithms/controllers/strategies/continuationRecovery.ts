import {
  MatOSControllerProtocolError,
  createMatOSControllerAction,
  freezeMatOSControllerValue,
  matOSControllerDigest,
  sanitizeMatOSControllerObservation,
  toMatOSControllerJsonValue,
  type MatOSControllerAction,
  type MatOSControllerJsonValue,
  type MatOSControllerObservation,
  type MatOSRunController,
} from '../protocol.js'

export const MATOS_CONTINUATION_RECOVERY_CONTROLLER_ID =
  'continuation-recovery'

type ContinuationRecoveryState = {
  observationCount: number
  observation?: MatOSControllerObservation
}

function recoveryCheckpointRef(
  observation: MatOSControllerObservation,
): string {
  return `workflow-recovery:${matOSControllerDigest({
    runRef: observation.runRef,
    graphDigest: observation.graph.digest,
    graphVersion: observation.graph.version,
    failedNodeRefs: observation.failedNodeRefs,
  })}`
}

export function createContinuationRecoveryController(input: {
  id?: string
  version?: string
} = {}): MatOSRunController<ContinuationRecoveryState> {
  return freezeMatOSControllerValue({
    id: input.id ?? MATOS_CONTINUATION_RECOVERY_CONTROLLER_ID,
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
          'continuation recovery controller must observe before proposing',
        )
      }
      if (
        state.observation.observationDigest !==
        context.observation.observationDigest
      ) {
        throw new MatOSControllerProtocolError(
          'observation-digest-mismatch',
          'continuation recovery state does not contain the current observation',
        )
      }
      if (
        context.observation.status !== 'failed' ||
        context.observation.failedNodeRefs.length !== 1 ||
        context.observation.budget.remaining.actions < 1
      ) {
        return []
      }
      return [
        createMatOSControllerAction({
          observation: context.observation,
          seed: context.seed,
          budgetUsage: { actions: 1 },
          intent: {
            type: 'recovery-request',
            checkpointRef: recoveryCheckpointRef(context.observation),
            mode: 'reconcile',
            reason: 'delegate-failed-run-to-native-recovery',
          },
        }),
      ]
    },
    serializeState: state => toMatOSControllerJsonValue(state),
    restoreState: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new MatOSControllerProtocolError(
          'invalid-protocol-value',
          'serialized continuation recovery state is invalid',
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
          'serialized continuation recovery observationCount is invalid',
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
