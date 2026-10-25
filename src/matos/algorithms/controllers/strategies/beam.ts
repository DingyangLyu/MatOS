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
  terminalSearchState,
  type MatOSSearchSelection,
  type MatOSSearchStrategyControllerState,
} from './searchSupport.js'

export const MATOS_BEAM_CONTROLLER_ID = 'beam-search'

type BeamEntry<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
> = MatOSSearchSelection<State, Candidate> & Readonly<{ terminal: boolean }>

export function runBeamSearch<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  search: MatOSPureControllerSearch<State, Candidate>
  context: MatOSControllerProposalContext
  beamWidth: number
  clock?: MatOSControllerSearchClock
}): MatOSControllerSearchResult<State, Candidate> {
  if (!Number.isSafeInteger(input.beamWidth) || input.beamWidth < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'beam search requires a positive integer beamWidth',
    )
  }
  const tracker = createSearchTracker(input.context, input.clock)
  const root = canonicalSearchState(
    input.search.initialState(input.context.observation),
  )
  const rootKey = searchStateKey(input.search, root)
  tracker.visitedStateKeys.push(rootKey)
  const seen = new Set([rootKey])
  let frontier: BeamEntry<State, Candidate>[] = [
    { state: root, path: [], score: Number.NEGATIVE_INFINITY, order: 0, terminal: false },
  ]
  let best: MatOSSearchSelection<State, Candidate> | undefined
  let stopReason: MatOSControllerSearchStopReason = 'no-candidates'
  let order = 0

  searchLoop: for (let depth = 1; depth <= tracker.maxDepth; depth += 1) {
    const next: BeamEntry<State, Candidate>[] = []
    for (const parent of frontier) {
      if (parent.terminal) continue
      const expansionContext = searchStepContext(
        input.context,
        depth,
        depth - 1,
        0,
      )
      const candidates = canonicalSearchCandidates(
        input.search.candidates(parent.state, expansionContext),
      )
      for (let index = 0; index < candidates.length; index += 1) {
        const limit = searchLimitBeforeTransition(tracker, depth)
        if (limit) {
          stopReason = limit
          break searchLoop
        }
        const candidate = candidates[index] as Readonly<Candidate>
        const context = searchStepContext(
          input.context,
          depth,
          depth - 1,
          index,
        )
        recordSearchTransition(tracker, depth)
        const state = canonicalSearchState(
          input.search.transition(parent.state, candidate, context),
        )
        const evaluation = normalizedSearchEvaluation(
          input.search.evaluate(state, context),
        )
        if (!recordSearchEvaluation(tracker, evaluation)) {
          stopReason = 'cost-limit'
          break searchLoop
        }
        order += 1
        const path = [...parent.path, candidate]
        const terminal = terminalSearchState(
          input.search,
          state,
          context,
          evaluation,
        )
        const selection: MatOSSearchSelection<State, Candidate> = {
          state,
          path,
          score: evaluation.score,
          order,
        }
        if (betterSelection(selection, best)) best = selection
        const key = searchStateKey(input.search, state)
        tracker.visitedStateKeys.push(key)
        if (!terminal && !seen.has(key)) {
          seen.add(key)
          next.push({ ...selection, terminal })
        }
        stopReason = terminal ? 'terminal' : 'selected'
      }
    }
    if (next.length === 0) break
    next.sort(
      (left, right) => right.score - left.score || left.order - right.order,
    )
    frontier = next.slice(0, input.beamWidth)
    if (depth === tracker.maxDepth) stopReason = 'depth-limit'
  }

  return resultFromSelection({ selection: best, tracker, stopReason })
}

export function createBeamSearchController<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  search: MatOSPureControllerSearch<State, Candidate>
  beamWidth: number
  clock?: MatOSControllerSearchClock
  id?: string
  version?: string
}): MatOSRunController<MatOSSearchStrategyControllerState> {
  if (!Number.isSafeInteger(input.beamWidth) || input.beamWidth < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'beam search requires a positive integer beamWidth',
    )
  }
  return createPureSearchController({
    id: input.id ?? MATOS_BEAM_CONTROLLER_ID,
    version: input.version,
    search: input.search,
    run: (search, context) =>
      runBeamSearch({
        search,
        context,
        beamWidth: input.beamWidth,
        clock: input.clock,
      }),
  })
}
