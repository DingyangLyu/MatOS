import { describe, expect, test } from 'bun:test'
import type {
  MatOSControllerJsonValue,
  MatOSControllerProposalContext,
  MatOSPureControllerSearch,
} from '../protocol.js'
import { createMatOSControllerSearchBounds } from '../protocol.js'
import { runBeamSearch } from './beam.js'
import { createBestOfNController, runBestOfNSearch } from './bestOfN.js'
import { runMctsSearch } from './mcts.js'
import {
  controllerTestBounds,
  controllerTestObservation,
} from '../testFixtures.js'

type SearchState = Readonly<{ path: readonly string[] }>
type SearchCandidate = string

function treeSearch(): MatOSPureControllerSearch<
  SearchState,
  SearchCandidate
> {
  return {
    initialState: () => ({ path: [] }),
    candidates: state => {
      if (state.path.length === 0) return ['left', 'right']
      if (state.path.length === 1) {
        return state.path[0] === 'left'
          ? ['finish-left']
          : ['finish-right']
      }
      return []
    },
    transition: (state, candidate) => ({
      path: [...state.path, candidate],
    }),
    evaluate: state => {
      const key = state.path.join('/')
      return {
        score:
          {
            left: 5,
            right: 4,
            'left/finish-left': 6,
            'right/finish-right': 10,
          }[key] ?? 0,
        costUsd: 0.25,
        terminal: state.path.length >= 2,
      }
    },
    stateKey: state => state.path.join('/') || 'root',
    candidateKey: candidate => candidate,
    actionForSelection: ({ candidate }) => ({
      type: 'request-validation',
      validationRef: `validator:${candidate}`,
      targetRefs: [`candidate:${candidate}`],
      reason: 'validate selected search branch',
    }),
  }
}

function context(input: {
  seed?: number
  bounds?: ReturnType<typeof createMatOSControllerSearchBounds>
} = {}): MatOSControllerProposalContext {
  return {
    observation: controllerTestObservation(),
    seed: input.seed ?? 19,
    bounds: input.bounds ?? controllerTestBounds,
  }
}

describe('deterministic pure controller strategies', () => {
  test('best-of-n evaluates N real transitions and keeps supplied tie order', () => {
    type State = Readonly<{ value: string }>
    const search: MatOSPureControllerSearch<State, string> = {
      initialState: () => ({ value: 'root' }),
      candidates: () => ['first', 'second', 'third'],
      transition: (_state, candidate) => ({ value: candidate }),
      evaluate: state => ({
        score: state.value === 'third' ? 100 : 7,
        costUsd: 0.5,
      }),
      actionForSelection: ({ candidate }) => ({
        type: 'request-human',
        promptRef: `prompt:${candidate}`,
        reason: 'review best-of-n choice',
      }),
    }

    const result = runBestOfNSearch({
      search,
      context: context(),
      n: 2,
      clock: () => 0,
    })

    expect(result.selectedCandidate).toBe('first')
    expect(result.selectedPath).toEqual(['first'])
    expect(result.usage).toMatchObject({
      candidates: 2,
      transitions: 2,
      evaluations: 2,
      maxDepth: 1,
      costUsd: 1,
    })
  })

  test('beam search retains a frontier and finds a deeper non-greedy branch', () => {
    const result = runBeamSearch({
      search: treeSearch(),
      context: context(),
      beamWidth: 2,
      clock: () => 0,
    })

    expect(result.selectedCandidate).toBe('right')
    expect(result.selectedPath).toEqual(['right', 'finish-right'])
    expect(result.score).toBe(10)
    expect(result.usage.maxDepth).toBe(2)
    expect(result.usage.candidates).toBe(4)
  })

  test('MCTS performs seeded selection/expansion/rollout/backprop deterministically', () => {
    const search = treeSearch()
    const first = runMctsSearch({
      search,
      context: context({ seed: 31337 }),
      maxIterations: 20,
      clock: () => 0,
    })
    const replay = runMctsSearch({
      search,
      context: context({ seed: 31337 }),
      maxIterations: 20,
      clock: () => 0,
    })

    expect(first.selectedCandidate).toBe('right')
    expect(first.selectedPath[0]).toBe('right')
    expect(first).toEqual(replay)
    expect(first.usage.transitions).toBeGreaterThanOrEqual(4)
    expect(first.usage.maxDepth).toBe(2)
  })

  test('MCTS obeys the hard candidate/depth/time/cost envelope', () => {
    const bounds = createMatOSControllerSearchBounds({
      maxActions: 1,
      maxCandidates: 3,
      maxDepth: 2,
      maxWallTimeMs: 5,
      maxCostUsd: 1,
    })
    const result = runMctsSearch({
      search: treeSearch(),
      context: context({ bounds }),
      maxIterations: 100,
      clock: () => 0,
    })

    expect(result.usage.candidates).toBeLessThanOrEqual(3)
    expect(result.usage.transitions).toBeLessThanOrEqual(3)
    expect(result.usage.maxDepth).toBeLessThanOrEqual(2)
    expect(result.usage.wallTimeMs).toBeLessThanOrEqual(5)
    expect(result.usage.costUsd).toBeLessThanOrEqual(1)
  })

  test('search controller factories expose only CAS-bound structured actions', async () => {
    const controller = createBestOfNController({
      search: treeSearch(),
      n: 2,
      clock: () => 0,
    })
    const proposalContext = context()
    const initialized = await controller.initialize({
      runRef: proposalContext.observation.runRef,
      definitionRef: 'workflow:generic',
      objectiveRef: 'objective:quality',
      scopeRef: proposalContext.observation.scopeRef,
      manifest: proposalContext.observation.manifest,
      budget: proposalContext.observation.budget,
      bounds: proposalContext.bounds,
      seed: proposalContext.seed,
    })
    const observed = await controller.observe(
      initialized,
      proposalContext.observation,
    )
    const actions = await controller.propose(observed, proposalContext)

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'request-validation',
      validationRef: 'validator:left',
      scopeRef: proposalContext.observation.scopeRef,
      runRef: proposalContext.observation.runRef,
      seed: proposalContext.seed,
    })
    expect(actions[0].cas.expectedObservationDigest).toBe(
      proposalContext.observation.observationDigest,
    )
    expect(
      ['retry', 'backtrack'].includes(actions[0].type),
    ).toBe(false)
  })
})

// Compile-time guard: search state and candidate types remain JSON-only.
const _jsonSearchState: MatOSControllerJsonValue = { path: ['left'] }
void _jsonSearchState
