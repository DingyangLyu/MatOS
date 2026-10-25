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
  seededRandom,
  terminalSearchState,
  type MatOSSearchSelection,
  type MatOSSearchStrategyControllerState,
} from './searchSupport.js'

export const MATOS_MCTS_CONTROLLER_ID = 'mcts'

type MctsNode<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
> = {
  state: Readonly<State>
  path: readonly Readonly<Candidate>[]
  depth: number
  order: number
  parent?: MctsNode<State, Candidate>
  incomingCandidate?: Readonly<Candidate>
  candidates?: readonly Readonly<Candidate>[]
  nextCandidateIndex: number
  children: MctsNode<State, Candidate>[]
  visits: number
  valueSum: number
  terminal: boolean
  score?: number
  bestRollout?: MatOSSearchSelection<State, Candidate>
}

function selectUctChild<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(
  node: MctsNode<State, Candidate>,
  explorationConstant: number,
): MctsNode<State, Candidate> {
  let selected = node.children[0]
  let selectedValue = Number.NEGATIVE_INFINITY
  for (const child of node.children) {
    const exploitation =
      child.visits === 0 ? 0 : child.valueSum / child.visits
    const exploration =
      child.visits === 0
        ? Number.POSITIVE_INFINITY
        : explorationConstant *
          Math.sqrt(Math.log(Math.max(1, node.visits)) / child.visits)
    const value = exploitation + exploration
    if (
      value > selectedValue ||
      (value === selectedValue && child.order < selected.order)
    ) {
      selected = child
      selectedValue = value
    }
  }
  return selected
}

function backpropagate<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(node: MctsNode<State, Candidate>, score: number): void {
  let current: MctsNode<State, Candidate> | undefined = node
  while (current) {
    current.visits += 1
    current.valueSum += score
    current = current.parent
  }
}

function rootChild<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(node: MctsNode<State, Candidate>): MctsNode<State, Candidate> | undefined {
  let current = node
  while (current.parent?.parent) current = current.parent
  return current.parent ? current : undefined
}

export function runMctsSearch<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  search: MatOSPureControllerSearch<State, Candidate>
  context: MatOSControllerProposalContext
  maxIterations: number
  explorationConstant?: number
  clock?: MatOSControllerSearchClock
}): MatOSControllerSearchResult<State, Candidate> {
  if (!Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'MCTS requires a positive integer maxIterations',
    )
  }
  const explorationConstant = input.explorationConstant ?? Math.SQRT2
  if (!Number.isFinite(explorationConstant) || explorationConstant < 0) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'MCTS explorationConstant must be finite and non-negative',
    )
  }
  const tracker = createSearchTracker(input.context, input.clock)
  const random = seededRandom(input.context.seed)
  const rootState = canonicalSearchState(
    input.search.initialState(input.context.observation),
  )
  const root: MctsNode<State, Candidate> = {
    state: rootState,
    path: [],
    depth: 0,
    order: 0,
    nextCandidateIndex: 0,
    children: [],
    visits: 0,
    valueSum: 0,
    terminal: false,
  }
  tracker.visitedStateKeys.push(searchStateKey(input.search, rootState))
  let stopReason: MatOSControllerSearchStopReason = 'no-candidates'
  let order = 0

  iterationLoop: for (
    let iteration = 0;
    iteration < input.maxIterations;
    iteration += 1
  ) {
    const topLimit = searchLimitBeforeTransition(tracker, 1)
    if (topLimit) {
      stopReason = topLimit
      break
    }
    let node = root

    while (!node.terminal && node.depth < tracker.maxDepth) {
      if (!node.candidates) {
        const context = searchStepContext(
          input.context,
          node.depth + 1,
          iteration,
          0,
        )
        node.candidates = canonicalSearchCandidates(
          input.search.candidates(node.state, context),
        )
      }
      if (node.nextCandidateIndex < node.candidates.length) break
      if (node.children.length === 0) {
        node.terminal = true
        break
      }
      node = selectUctChild(node, explorationConstant)
    }

    if (node.terminal || node.depth >= tracker.maxDepth) {
      if (node.score === undefined) {
        if (tracker.evaluations >= tracker.maxEvaluations) {
          stopReason = 'candidate-limit'
          break
        }
        const context = searchStepContext(
          input.context,
          node.depth,
          iteration,
          0,
        )
        const evaluation = normalizedSearchEvaluation(
          input.search.evaluate(node.state, context),
        )
        if (!recordSearchEvaluation(tracker, evaluation)) {
          stopReason = 'cost-limit'
          break
        }
        node.score = evaluation.score
      }
      backpropagate(node, node.score)
      stopReason = node.depth >= tracker.maxDepth ? 'depth-limit' : 'terminal'
      continue
    }

    const candidateIndex = node.nextCandidateIndex
    const candidate = node.candidates?.[candidateIndex]
    if (!candidate) {
      node.terminal = true
      stopReason = 'terminal'
      continue
    }
    const depth = node.depth + 1
    const limit = searchLimitBeforeTransition(tracker, depth)
    if (limit) {
      stopReason = limit
      break
    }
    node.nextCandidateIndex += 1
    const context = searchStepContext(
      input.context,
      depth,
      iteration,
      candidateIndex,
    )
    recordSearchTransition(tracker, depth)
    const childState = canonicalSearchState(
      input.search.transition(node.state, candidate, context),
    )
    const childEvaluation = normalizedSearchEvaluation(
      input.search.evaluate(childState, context),
    )
    if (!recordSearchEvaluation(tracker, childEvaluation)) {
      stopReason = 'cost-limit'
      break
    }
    order += 1
    const child: MctsNode<State, Candidate> = {
      state: childState,
      path: [...node.path, candidate],
      depth,
      order,
      parent: node,
      incomingCandidate: candidate,
      nextCandidateIndex: 0,
      children: [],
      visits: 0,
      valueSum: 0,
      terminal: terminalSearchState(
        input.search,
        childState,
        context,
        childEvaluation,
      ),
      score: childEvaluation.score,
    }
    node.children.push(child)
    tracker.visitedStateKeys.push(searchStateKey(input.search, childState))

    let rolloutState = child.state
    let rolloutPath = child.path
    let rolloutDepth = child.depth
    let rolloutScore = childEvaluation.score
    let rolloutTerminal = child.terminal
    const rolloutKeys = new Set(
      tracker.visitedStateKeys.slice(-Math.max(1, child.path.length + 1)),
    )

    while (!rolloutTerminal && rolloutDepth < tracker.maxDepth) {
      const rolloutLimit = searchLimitBeforeTransition(
        tracker,
        rolloutDepth + 1,
      )
      if (rolloutLimit) {
        stopReason = rolloutLimit
        break
      }
      const expansionContext = searchStepContext(
        input.context,
        rolloutDepth + 1,
        iteration,
        0,
      )
      const rolloutCandidates = canonicalSearchCandidates(
        input.search.candidates(rolloutState, expansionContext),
      )
      if (rolloutCandidates.length === 0) {
        rolloutTerminal = true
        stopReason = 'terminal'
        break
      }
      const rolloutIndex = Math.floor(random() * rolloutCandidates.length)
      const rolloutCandidate = rolloutCandidates[rolloutIndex] as Readonly<Candidate>
      const rolloutContext = searchStepContext(
        input.context,
        rolloutDepth + 1,
        iteration,
        rolloutIndex,
      )
      recordSearchTransition(tracker, rolloutDepth + 1)
      const nextState = canonicalSearchState(
        input.search.transition(
          rolloutState,
          rolloutCandidate,
          rolloutContext,
        ),
      )
      const evaluation = normalizedSearchEvaluation(
        input.search.evaluate(nextState, rolloutContext),
      )
      if (!recordSearchEvaluation(tracker, evaluation)) {
        stopReason = 'cost-limit'
        break iterationLoop
      }
      rolloutDepth += 1
      rolloutState = nextState
      rolloutPath = [...rolloutPath, rolloutCandidate]
      rolloutScore = evaluation.score
      rolloutTerminal = terminalSearchState(
        input.search,
        nextState,
        rolloutContext,
        evaluation,
      )
      const key = searchStateKey(input.search, nextState)
      tracker.visitedStateKeys.push(key)
      if (rolloutKeys.has(key)) {
        rolloutTerminal = true
      }
      rolloutKeys.add(key)
    }

    backpropagate(child, rolloutScore)
    const first = rootChild(child)
    if (first) {
      const rollout: MatOSSearchSelection<State, Candidate> = {
        state: rolloutState,
        path: rolloutPath,
        score: rolloutScore,
        order,
      }
      if (betterSelection(rollout, first.bestRollout)) {
        first.bestRollout = rollout
      }
    }
    stopReason = rolloutTerminal ? 'terminal' : 'selected'
  }

  let selectedChild: MctsNode<State, Candidate> | undefined
  for (const child of root.children) {
    if (
      !selectedChild ||
      child.visits > selectedChild.visits ||
      (child.visits === selectedChild.visits &&
        child.valueSum / Math.max(1, child.visits) >
          selectedChild.valueSum / Math.max(1, selectedChild.visits)) ||
      (child.visits === selectedChild.visits &&
        child.valueSum / Math.max(1, child.visits) ===
          selectedChild.valueSum / Math.max(1, selectedChild.visits) &&
        child.order < selectedChild.order)
    ) {
      selectedChild = child
    }
  }
  const selection = selectedChild
    ? (selectedChild.bestRollout ?? {
        state: selectedChild.state,
        path: selectedChild.path,
        score:
          selectedChild.valueSum / Math.max(1, selectedChild.visits),
        order: selectedChild.order,
      })
    : undefined
  if (
    selection &&
    stopReason !== 'candidate-limit' &&
    stopReason !== 'time-limit' &&
    stopReason !== 'cost-limit' &&
    input.maxIterations <= root.visits
  ) {
    stopReason = 'iteration-limit'
  }
  return resultFromSelection({ selection, tracker, stopReason })
}

export function createMctsController<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
>(input: {
  search: MatOSPureControllerSearch<State, Candidate>
  maxIterations: number
  explorationConstant?: number
  clock?: MatOSControllerSearchClock
  id?: string
  version?: string
}): MatOSRunController<MatOSSearchStrategyControllerState> {
  if (!Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      'MCTS requires a positive integer maxIterations',
    )
  }
  return createPureSearchController({
    id: input.id ?? MATOS_MCTS_CONTROLLER_ID,
    version: input.version,
    search: input.search,
    run: (search, context) =>
      runMctsSearch({
        search,
        context,
        maxIterations: input.maxIterations,
        explorationConstant: input.explorationConstant,
        clock: input.clock,
      }),
  })
}
