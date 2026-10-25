import {
  MatOSControllerProtocolError,
  type MatOSControllerJsonValue,
  type MatOSControllerProposalContext,
  type MatOSControllerSearchClock,
  type MatOSControllerSearchResult,
  type MatOSControllerSearchStopReason,
  type MatOSPureControllerSearch,
  type MatOSRunController,
} from '../protocol.js'
import {
  betterSelection,
  canonicalSearchCandidates,
  canonicalSearchState,
  createPureSearchController,
  createSearchTracker,
  normalizedSearchEvaluation,
  recordSearchEvaluation,
  recordSearchTransition,
  resultFromSelection,
  searchLimitBeforeTransition,
  searchStateKey,
  searchStepContext,
  type MatOSSearchSelection,
  type MatOSSearchStrategyControllerState,
} from './searchSupport.js'

export const MATOS_BEST_OF_N_CONTROLLER_ID = 'best-of-n'

export function runBestOfNSearch<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  search: MatOSPureControllerSearch<State, Candidate>
  context: MatOSControllerProposalContext
  n: number
  clock?: MatOSControllerSearchClock
}): MatOSControllerSearchResult<State, Candidate> {
  if (!Number.isSafeInteger(input.n) || input.n < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'best-of-n requires a positive integer n',
    )
  }
  const tracker = createSearchTracker(input.context, input.clock)
  const root = canonicalSearchState(
    input.search.initialState(input.context.observation),
  )
  tracker.visitedStateKeys.push(searchStateKey(input.search, root))
  const candidateContext = searchStepContext(input.context, 1, 0, 0)
  const candidates = canonicalSearchCandidates(
    input.search.candidates(root, candidateContext),
  )
  let best: MatOSSearchSelection<State, Candidate> | undefined
  let stopReason: MatOSControllerSearchStopReason = 'no-candidates'
  const count = Math.min(input.n, candidates.length)
  for (let index = 0; index < count; index += 1) {
    const limit = searchLimitBeforeTransition(tracker, 1)
    if (limit) {
      stopReason = limit
      break
    }
    const candidate = candidates[index] as Readonly<Candidate>
    const context = searchStepContext(input.context, 1, 0, index)
    recordSearchTransition(tracker, 1)
    const state = canonicalSearchState(
      input.search.transition(root, candidate, context),
    )
    const evaluation = normalizedSearchEvaluation(
      input.search.evaluate(state, context),
    )
    if (!recordSearchEvaluation(tracker, evaluation)) {
      stopReason = 'cost-limit'
      break
    }
    tracker.visitedStateKeys.push(searchStateKey(input.search, state))
    const selection: MatOSSearchSelection<State, Candidate> = {
      state,
      path: [candidate],
      score: evaluation.score,
      order: index,
    }
    if (betterSelection(selection, best)) best = selection
    stopReason = evaluation.terminal ? 'terminal' : 'selected'
  }
  return resultFromSelection({ selection: best, tracker, stopReason })
}

export function createBestOfNController<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  search: MatOSPureControllerSearch<State, Candidate>
  n: number
  clock?: MatOSControllerSearchClock
  id?: string
  version?: string
}): MatOSRunController<MatOSSearchStrategyControllerState> {
  if (!Number.isSafeInteger(input.n) || input.n < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'best-of-n requires a positive integer n',
    )
  }
  return createPureSearchController({
    id: input.id ?? MATOS_BEST_OF_N_CONTROLLER_ID,
    version: input.version,
    search: input.search,
    run: (search, context) =>
      runBestOfNSearch({
        search,
        context,
        n: input.n,
        clock: input.clock,
      }),
  })
}
