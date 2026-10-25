import {
  MatOSControllerProtocolError,
  matOSControllerDigest,
  type MatOSControllerJsonValue,
  type MatOSControllerObservation,
  type MatOSControllerSearchStepContext,
  type MatOSPureControllerSearch,
} from './controllers/protocol.js'
import {
  matOSControllerRegistry,
  type MatOSControllerProvider,
} from './controllers/registry.js'
import { createGreedyController } from './controllers/strategies/greedy.js'
import { createBestOfNController } from './controllers/strategies/bestOfN.js'
import { createBeamSearchController } from './controllers/strategies/beam.js'
import { createMctsController } from './controllers/strategies/mcts.js'
import { createContinuationRecoveryController } from './controllers/strategies/continuationRecovery.js'

type ReadyOrderState = {
  orderedNodeRefs: string[]
  remainingNodeRefs: string[]
  score: number
}

type ReadyOrderConfig = {
  priorities: Record<string, number>
  n: number
  beamWidth: number
  maxIterations: number
  explorationConstant: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      `${label} must be a positive safe integer`,
    )
  }
  return Number(resolved)
}

function nonNegativeNumber(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      `${label} must be a finite non-negative number`,
    )
  }
  return resolved
}

function readyOrderConfig(value: MatOSControllerJsonValue): ReadyOrderConfig {
  const source = isRecord(value) ? value : {}
  const rawPriorities = source.priorities
  if (rawPriorities !== undefined && !isRecord(rawPriorities)) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'controller config.priorities must be an object',
    )
  }
  const priorities: Record<string, number> = {}
  for (const [nodeId, priority] of Object.entries(rawPriorities ?? {})) {
    if (
      !nodeId ||
      nodeId.length > 4096 ||
      typeof priority !== 'number' ||
      !Number.isFinite(priority)
    ) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller priorities must map bounded node ids to finite numbers',
      )
    }
    priorities[nodeId] = priority
  }
  return {
    priorities,
    n: positiveInteger(source.n, 4, 'controller config.n'),
    beamWidth: positiveInteger(
      source.beamWidth,
      3,
      'controller config.beamWidth',
    ),
    maxIterations: positiveInteger(
      source.maxIterations,
      16,
      'controller config.maxIterations',
    ),
    explorationConstant: nonNegativeNumber(
      source.explorationConstant,
      Math.SQRT2,
      'controller config.explorationConstant',
    ),
  }
}

function baselineIndex(
  observation: MatOSControllerObservation,
  nodeId: string,
): number {
  const index = observation.readyNodeRefs.indexOf(nodeId)
  return index < 0 ? observation.readyNodeRefs.length : index
}

function readyOrderSearch(
  config: ReadyOrderConfig,
): MatOSPureControllerSearch<ReadyOrderState, string> {
  return {
    initialState: observation => ({
      orderedNodeRefs: [],
      remainingNodeRefs: [...observation.readyNodeRefs],
      score: 0,
    }),
    candidates: state => [...state.remainingNodeRefs],
    transition: (state, candidate, context) => {
      const index = baselineIndex(context.observation, candidate)
      const priority = config.priorities[candidate] ?? 0
      // Priority is authoritative when supplied; baseline index is the stable
      // tie-breaker and therefore preserves static scheduling by default.
      const positionWeight = Math.max(
        1,
        context.observation.readyNodeRefs.length - context.depth + 1,
      )
      const stepScore = (priority * 1_000_000 - index) * positionWeight
      return {
        orderedNodeRefs: [...state.orderedNodeRefs, candidate],
        remainingNodeRefs: state.remainingNodeRefs.filter(ref => ref !== candidate),
        score: state.score + stepScore,
      }
    },
    evaluate: state => ({
      score: state.score,
      terminal: state.remainingNodeRefs.length === 0,
    }),
    isTerminal: state => state.remainingNodeRefs.length === 0,
    stateKey: state =>
      `${state.orderedNodeRefs.join('\u0000')}|${state.remainingNodeRefs.join('\u0000')}`,
    candidateKey: candidate => candidate,
    actionForSelection: ({ path, observation }) => ({
      type: 'rank-ready',
      orderedNodeRefs: [
        ...path,
        ...observation.readyNodeRefs.filter(ref => !path.includes(ref)),
      ],
    }),
  }
}

const BUILTIN_CONTROLLER_VERSION = '1.0.0'

function builtinImplementationDigest(providerId: string): string {
  return matOSControllerDigest({
    providerId,
    providerVersion: BUILTIN_CONTROLLER_VERSION,
    implementationRevision: 1,
  })
}

function providers(): MatOSControllerProvider<unknown>[] {
  return [
    {
      id: 'greedy-baseline',
      version: BUILTIN_CONTROLLER_VERSION,
      stateVersion: 1,
      implementationDigest: builtinImplementationDigest('greedy-baseline'),
      description: 'Preserves the native workflow ready-set order exactly.',
      create: () =>
        createGreedyController({
          id: 'greedy-baseline',
          version: BUILTIN_CONTROLLER_VERSION,
        }),
    },
    {
      id: 'continuation-recovery',
      version: BUILTIN_CONTROLLER_VERSION,
      stateVersion: 1,
      implementationDigest: builtinImplementationDigest('continuation-recovery'),
      description:
        'Delegates failed DAG observations to the native recovery classifier and apply path.',
      create: () =>
        createContinuationRecoveryController({
          id: 'continuation-recovery',
          version: BUILTIN_CONTROLLER_VERSION,
        }),
    },
    {
      id: 'best-of-n',
      version: BUILTIN_CONTROLLER_VERSION,
      stateVersion: 1,
      implementationDigest: builtinImplementationDigest('best-of-n'),
      description: 'Ranks bounded ready-node candidates using pinned priorities.',
      create: input => {
        const config = readyOrderConfig(input.config)
        return createBestOfNController({
          id: 'best-of-n',
          version: BUILTIN_CONTROLLER_VERSION,
          search: readyOrderSearch(config),
          n: config.n,
        })
      },
    },
    {
      id: 'beam-search',
      version: BUILTIN_CONTROLLER_VERSION,
      stateVersion: 1,
      implementationDigest: builtinImplementationDigest('beam-search'),
      description: 'Performs deterministic bounded beam search over ready-node order.',
      create: input => {
        const config = readyOrderConfig(input.config)
        return createBeamSearchController({
          id: 'beam-search',
          version: BUILTIN_CONTROLLER_VERSION,
          search: readyOrderSearch(config),
          beamWidth: config.beamWidth,
        })
      },
    },
    {
      id: 'mcts',
      version: BUILTIN_CONTROLLER_VERSION,
      stateVersion: 1,
      implementationDigest: builtinImplementationDigest('mcts'),
      description: 'Performs seeded bounded MCTS over ready-node order.',
      create: input => {
        const config = readyOrderConfig(input.config)
        return createMctsController({
          id: 'mcts',
          version: BUILTIN_CONTROLLER_VERSION,
          search: readyOrderSearch(config),
          maxIterations: config.maxIterations,
          explorationConstant: config.explorationConstant,
        })
      },
    },
  ]
}

export function ensureBuiltinMatOSWorkflowControllers(): void {
  const existing = new Set(
    matOSControllerRegistry.list().map(provider => `${provider.id}@${provider.version}`),
  )
  for (const provider of providers()) {
    if (!existing.has(`${provider.id}@${provider.version}`)) {
      matOSControllerRegistry.register(provider)
    }
  }
}
