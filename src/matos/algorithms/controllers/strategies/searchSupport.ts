import {
  MatOSControllerProtocolError,
  cloneMatOSControllerJson,
  createMatOSControllerAction,
  createMatOSControllerBudgetUsage,
  freezeMatOSControllerValue,
  matOSControllerDigest,
  sanitizeMatOSControllerObservation,
  toMatOSControllerJsonValue,
  type MatOSControllerAction,
  type MatOSControllerBudgetUsage,
  type MatOSControllerJsonValue,
  type MatOSControllerProposalContext,
  type MatOSControllerSearchBounds,
  type MatOSControllerSearchClock,
  type MatOSControllerSearchEvaluation,
  type MatOSControllerSearchResult,
  type MatOSControllerSearchStepContext,
  type MatOSControllerSearchStopReason,
  type MatOSPureControllerSearch,
  type MatOSRunController,
} from '../protocol.js'

export type MatOSSearchStrategyControllerState = Readonly<{
  observationCount: number
  observation?: ReturnType<typeof sanitizeMatOSControllerObservation>
}>

export type MatOSControllerSearchRuntime = Readonly<{
  bounds: MatOSControllerSearchBounds
  seed: number
  clock?: MatOSControllerSearchClock
}>

export type MatOSControllerSearchTracker = {
  readonly seed: number
  readonly bounds: MatOSControllerSearchBounds
  readonly visitedStateKeys: string[]
  readonly maxCandidates: number
  readonly maxTransitions: number
  readonly maxEvaluations: number
  readonly maxDepth: number
  readonly maxWallTimeMs: number
  readonly maxCostUsd: number
  readonly clock: MatOSControllerSearchClock
  candidates: number
  transitions: number
  evaluations: number
  reachedDepth: number
  costUsd: number
  startedAt: number
  lastClock: number
}

export type MatOSNormalizedSearchEvaluation = Readonly<{
  score: number
  costUsd: number
  terminal: boolean
}>

export type MatOSSearchSelection<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
> = Readonly<{
  state: Readonly<State>
  path: readonly Readonly<Candidate>[]
  score: number
  order: number
}>

function finiteLimit(left: number, right: number): number {
  return Math.max(0, Math.min(left, right))
}

export function createSearchTracker(
  context: MatOSControllerProposalContext,
  clock: MatOSControllerSearchClock = () => performance.now(),
): MatOSControllerSearchTracker {
  const remaining = context.observation.budget.remaining
  const startedAt = clock()
  if (!Number.isFinite(startedAt)) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search clock must return a finite number',
    )
  }
  return {
    seed: context.seed,
    bounds: context.bounds,
    visitedStateKeys: [],
    maxCandidates: Math.floor(
      finiteLimit(context.bounds.maxCandidates, remaining.candidates),
    ),
    maxTransitions: Math.floor(
      finiteLimit(context.bounds.maxCandidates, remaining.transitions),
    ),
    maxEvaluations: Math.floor(
      finiteLimit(context.bounds.maxCandidates, remaining.evaluations),
    ),
    maxDepth: Math.floor(
      finiteLimit(context.bounds.maxDepth, remaining.maxDepth),
    ),
    maxWallTimeMs: finiteLimit(
      context.bounds.maxWallTimeMs,
      remaining.wallTimeMs,
    ),
    maxCostUsd: finiteLimit(context.bounds.maxCostUsd, remaining.costUsd),
    clock,
    candidates: 0,
    transitions: 0,
    evaluations: 0,
    reachedDepth: 0,
    costUsd: 0,
    startedAt,
    lastClock: startedAt,
  }
}

export function searchElapsedMs(tracker: MatOSControllerSearchTracker): number {
  const current = tracker.clock()
  if (!Number.isFinite(current) || current < tracker.lastClock) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search clock must be finite and monotonic',
    )
  }
  tracker.lastClock = current
  return current - tracker.startedAt
}

export function searchLimitBeforeTransition(
  tracker: MatOSControllerSearchTracker,
  depth: number,
): MatOSControllerSearchStopReason | undefined {
  if (depth > tracker.maxDepth) return 'depth-limit'
  if (tracker.candidates >= tracker.maxCandidates) return 'candidate-limit'
  if (tracker.transitions >= tracker.maxTransitions) return 'candidate-limit'
  if (tracker.evaluations >= tracker.maxEvaluations) return 'candidate-limit'
  if (searchElapsedMs(tracker) >= tracker.maxWallTimeMs) return 'time-limit'
  return undefined
}

export function recordSearchTransition(
  tracker: MatOSControllerSearchTracker,
  depth: number,
): void {
  tracker.candidates += 1
  tracker.transitions += 1
  tracker.reachedDepth = Math.max(tracker.reachedDepth, depth)
}

export function normalizedSearchEvaluation(
  value: number | MatOSControllerSearchEvaluation,
): MatOSNormalizedSearchEvaluation {
  const evaluation =
    typeof value === 'number'
      ? { score: value, costUsd: 0, terminal: false }
      : {
          score: value.score,
          costUsd: value.costUsd ?? 0,
          terminal: value.terminal ?? false,
        }
  if (!Number.isFinite(evaluation.score)) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search evaluation score must be finite',
    )
  }
  if (!Number.isFinite(evaluation.costUsd) || evaluation.costUsd < 0) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search evaluation costUsd must be finite and non-negative',
    )
  }
  return freezeMatOSControllerValue(evaluation)
}

export function recordSearchEvaluation(
  tracker: MatOSControllerSearchTracker,
  evaluation: MatOSNormalizedSearchEvaluation,
): boolean {
  if (tracker.costUsd + evaluation.costUsd > tracker.maxCostUsd + 1e-12) {
    return false
  }
  tracker.evaluations += 1
  tracker.costUsd += evaluation.costUsd
  return true
}

export function searchUsage(
  tracker: MatOSControllerSearchTracker,
): MatOSControllerBudgetUsage {
  const wallTimeMs = searchElapsedMs(tracker)
  if (wallTimeMs > tracker.maxWallTimeMs + 1e-9) {
    throw new MatOSControllerProtocolError(
      'search-limit-exceeded',
      'pure search exceeded maxWallTimeMs before it could yield',
    )
  }
  return createMatOSControllerBudgetUsage({
    candidates: tracker.candidates,
    transitions: tracker.transitions,
    evaluations: tracker.evaluations,
    maxDepth: tracker.reachedDepth,
    wallTimeMs,
    costUsd: tracker.costUsd,
  })
}

export function canonicalSearchState<State extends MatOSControllerJsonValue>(
  state: State,
): Readonly<State> {
  return cloneMatOSControllerJson(state)
}

export function canonicalSearchCandidates<
  Candidate extends MatOSControllerJsonValue,
>(candidates: readonly Candidate[]): readonly Readonly<Candidate>[] {
  if (!Array.isArray(candidates)) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search candidates must be a synchronous array',
    )
  }
  return freezeMatOSControllerValue(
    candidates.map(candidate => cloneMatOSControllerJson(candidate)),
  )
}

export function searchStepContext(
  context: MatOSControllerProposalContext,
  depth: number,
  iteration: number,
  candidateIndex: number,
): MatOSControllerSearchStepContext {
  return freezeMatOSControllerValue({
    observation: context.observation,
    seed: context.seed,
    depth,
    iteration,
    candidateIndex,
  })
}

export function searchStateKey<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(
  search: MatOSPureControllerSearch<State, Candidate>,
  state: Readonly<State>,
): string {
  const key = search.stateKey?.(state) ?? matOSControllerDigest(state)
  if (typeof key !== 'string' || key.length === 0 || key.length > 4096) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search stateKey must return a non-empty bounded string',
    )
  }
  return key
}

export function searchCandidateKey<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(
  search: MatOSPureControllerSearch<State, Candidate>,
  candidate: Readonly<Candidate>,
): string {
  const key = search.candidateKey?.(candidate) ?? matOSControllerDigest(candidate)
  if (typeof key !== 'string' || key.length === 0 || key.length > 4096) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'search candidateKey must return a non-empty bounded string',
    )
  }
  return key
}

export function terminalSearchState<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(
  search: MatOSPureControllerSearch<State, Candidate>,
  state: Readonly<State>,
  context: MatOSControllerSearchStepContext,
  evaluation: MatOSNormalizedSearchEvaluation,
): boolean {
  return evaluation.terminal || Boolean(search.isTerminal?.(state, context))
}

export function betterSelection<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(
  candidate: MatOSSearchSelection<State, Candidate>,
  current: MatOSSearchSelection<State, Candidate> | undefined,
): boolean {
  return (
    !current ||
    candidate.score > current.score ||
    (candidate.score === current.score && candidate.order < current.order)
  )
}

export function resultFromSelection<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  selection?: MatOSSearchSelection<State, Candidate>
  tracker: MatOSControllerSearchTracker
  stopReason: MatOSControllerSearchStopReason
}): MatOSControllerSearchResult<State, Candidate> {
  return freezeMatOSControllerValue({
    ...(input.selection
      ? {
          selectedCandidate: input.selection.path[0],
          selectedPath: input.selection.path,
          selectedState: input.selection.state,
          score: input.selection.score,
        }
      : { selectedPath: [] }),
    usage: searchUsage(input.tracker),
    stopReason: input.selection ? 'selected' : input.stopReason,
    visitedStateKeys: [...input.tracker.visitedStateKeys],
  } as MatOSControllerSearchResult<State, Candidate>)
}

export function createPureSearchController<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  id: string
  version?: string
  search: MatOSPureControllerSearch<State, Candidate>
  run: (
    search: MatOSPureControllerSearch<State, Candidate>,
    context: MatOSControllerProposalContext,
  ) => MatOSControllerSearchResult<State, Candidate>
}): MatOSRunController<MatOSSearchStrategyControllerState> {
  return freezeMatOSControllerValue({
    id: input.id,
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
          'search controller must observe before proposing',
        )
      }
      if (state.observation.observationDigest !== context.observation.observationDigest) {
        throw new MatOSControllerProtocolError(
          'observation-digest-mismatch',
          'search controller state does not contain the current observation',
        )
      }
      if (context.observation.budget.remaining.actions < 1) {
        return []
      }
      const result = input.run(input.search, context)
      const intent =
        result.selectedCandidate &&
        result.selectedState &&
        result.score !== undefined
          ? input.search.actionForSelection({
              candidate: result.selectedCandidate,
              path: result.selectedPath,
              state: result.selectedState,
              score: result.score,
              observation: context.observation,
            })
          : {
              type: 'noop' as const,
              reason: `search-${result.stopReason}`,
            }
      return [
        createMatOSControllerAction({
          observation: context.observation,
          seed: context.seed,
          budgetUsage: { ...result.usage, actions: 1 },
          intent,
        }),
      ]
    },
    serializeState: state => toMatOSControllerJsonValue(state),
    restoreState: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new MatOSControllerProtocolError(
          'invalid-protocol-value',
          'serialized search controller state is invalid',
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

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
