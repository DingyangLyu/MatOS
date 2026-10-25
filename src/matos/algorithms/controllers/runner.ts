import {
  MatOSControllerProtocolError,
  addMatOSControllerBudgetUsage,
  createMatOSControllerSearchBounds,
  freezeMatOSControllerValue,
  matOSControllerDigest,
  matOSControllerUsageFits,
  sanitizeMatOSControllerAction,
  sanitizeMatOSControllerObservation,
  toMatOSControllerJsonValue,
  type MatOSControllerAction,
  type MatOSControllerFinalizeResult,
  type MatOSControllerManifestCas,
  type MatOSControllerObservation,
  type MatOSControllerPinnedProvider,
  type MatOSControllerSearchBounds,
  type MatOSRunController,
} from './protocol.js'
import {
  assertMatOSControllerCheckpointCompatible,
  createMatOSControllerCheckpoint,
  type MatOSControllerCheckpoint,
  type MatOSControllerCheckpointStore,
  type MatOSControllerSequencedAction,
} from './checkpoint.js'

export type MatOSControllerRunnerOptions<State> = Readonly<{
  controller: MatOSRunController<State>
  checkpointStore: MatOSControllerCheckpointStore
  runRef: string
  definitionRef: string
  objectiveRef: string
  scopeRef: string
  manifest: MatOSControllerManifestCas
  providerId?: string
  configDigest: string
  implementationDigest?: string
  assetRef?: string
  runtimeRef?: string
  seed: number
  bounds: MatOSControllerSearchBounds
  now?: () => string
}>

export type MatOSControllerStepResult = Readonly<{
  actions: readonly MatOSControllerAction[]
  checkpoint: MatOSControllerCheckpoint
  actionSequenceStart?: number
  actionSequenceEnd?: number
  replayed: boolean
}>

function requiredString(value: string, path: string): string {
  if (!value || value.length > 4096) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      `${path} must be a non-empty bounded string`,
    )
  }
  return value
}

function requiredDigest(value: string, path: string): string {
  const digest = requiredString(value, path)
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new MatOSControllerProtocolError(
      'invalid-protocol-value',
      `${path} must be a sha256 digest`,
    )
  }
  return digest
}

function timeoutAfter<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MatOSControllerProtocolError(
          'controller-timeout',
          `controller did not yield within ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function assertUsageWithinBounds(
  actions: readonly MatOSControllerAction[],
  observation: MatOSControllerObservation,
  bounds: MatOSControllerSearchBounds,
): void {
  const usage = addMatOSControllerBudgetUsage(
    actions.map(action => action.budgetUsage),
  )
  if (!matOSControllerUsageFits(usage, observation.budget.remaining)) {
    throw new MatOSControllerProtocolError(
      'budget-exceeded',
      'controller actions exceed the observed remaining budget',
    )
  }
  if (
    usage.actions > bounds.maxActions ||
    usage.candidates > bounds.maxCandidates ||
    usage.transitions > bounds.maxCandidates ||
    usage.evaluations > bounds.maxCandidates ||
    usage.maxDepth > bounds.maxDepth ||
    usage.wallTimeMs > bounds.maxWallTimeMs + 1e-9 ||
    usage.costUsd > bounds.maxCostUsd + 1e-12
  ) {
    throw new MatOSControllerProtocolError(
      'search-limit-exceeded',
      'controller actions exceed the pinned search bounds',
    )
  }
}

export class MatOSControllerRunner<State> {
  readonly #controller: MatOSRunController<State>
  readonly #store: MatOSControllerCheckpointStore
  readonly #runRef: string
  readonly #definitionRef: string
  readonly #objectiveRef: string
  readonly #scopeRef: string
  readonly #manifest: MatOSControllerManifestCas
  readonly #provider: MatOSControllerPinnedProvider
  readonly #seed: number
  readonly #bounds: MatOSControllerSearchBounds
  readonly #now: () => string
  #state: State | undefined
  #initialized = false
  #finalized = false
  #active = false
  #latestCheckpoint: MatOSControllerCheckpoint | undefined
  #actionSequence: MatOSControllerSequencedAction[] = []

  constructor(options: MatOSControllerRunnerOptions<State>) {
    this.#controller = options.controller
    this.#store = options.checkpointStore
    this.#runRef = requiredString(options.runRef, 'runRef')
    this.#definitionRef = requiredString(
      options.definitionRef,
      'definitionRef',
    )
    this.#objectiveRef = requiredString(options.objectiveRef, 'objectiveRef')
    this.#scopeRef = requiredString(options.scopeRef, 'scopeRef')
    this.#manifest = freezeMatOSControllerValue({
      ref: requiredString(options.manifest.ref, 'manifest.ref'),
      digest: requiredString(options.manifest.digest, 'manifest.digest'),
    })
    if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller seed must be a non-negative integer',
      )
    }
    if (
      !Number.isSafeInteger(options.controller.stateVersion) ||
      options.controller.stateVersion < 1
    ) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller stateVersion must be a positive integer',
      )
    }
    this.#seed = options.seed
    this.#bounds = createMatOSControllerSearchBounds(options.bounds)
    this.#provider = freezeMatOSControllerValue({
      controllerId: requiredString(options.controller.id, 'controller.id'),
      providerId: requiredString(
        options.providerId ?? options.controller.id,
        'providerId',
      ),
      providerVersion: requiredString(
        options.controller.version,
        'controller.version',
      ),
      stateVersion: options.controller.stateVersion,
      configDigest: requiredString(options.configDigest, 'configDigest'),
      implementationDigest: requiredDigest(
        options.implementationDigest ??
          matOSControllerDigest({
            controllerId: options.controller.id,
            providerId: options.providerId ?? options.controller.id,
            providerVersion: options.controller.version,
            stateVersion: options.controller.stateVersion,
            initialize: String(options.controller.initialize),
            observe: String(options.controller.observe),
            propose: String(options.controller.propose),
            finalize: options.controller.finalize
              ? String(options.controller.finalize)
              : null,
            serializeState: options.controller.serializeState
              ? String(options.controller.serializeState)
              : null,
            restoreState: options.controller.restoreState
              ? String(options.controller.restoreState)
              : null,
          }),
        'implementationDigest',
      ),
      ...(options.assetRef
        ? { assetRef: requiredString(options.assetRef, 'assetRef') }
        : {}),
      ...(options.runtimeRef
        ? { runtimeRef: requiredString(options.runtimeRef, 'runtimeRef') }
        : {}),
    })
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  get provider(): MatOSControllerPinnedProvider {
    return this.#provider
  }

  get latestCheckpoint(): MatOSControllerCheckpoint | undefined {
    return this.#latestCheckpoint
  }

  #observation(value: unknown): MatOSControllerObservation {
    const observation = sanitizeMatOSControllerObservation(value)
    if (observation.scopeRef !== this.#scopeRef) {
      throw new MatOSControllerProtocolError(
        'scope-mismatch',
        'controller observation scopeRef must exactly equal runner scopeRef',
      )
    }
    if (observation.runRef !== this.#runRef) {
      throw new MatOSControllerProtocolError(
        'run-mismatch',
        'controller observation runRef must exactly equal runner runRef',
      )
    }
    if (
      observation.manifest.ref !== this.#manifest.ref ||
      observation.manifest.digest !== this.#manifest.digest
    ) {
      throw new MatOSControllerProtocolError(
        'manifest-mismatch',
        'controller observation manifest does not match the pinned manifest',
      )
    }
    return observation
  }

  async #runBounded<T>(operation: () => T | Promise<T>): Promise<T> {
    return timeoutAfter(
      Promise.resolve().then(operation),
      this.#bounds.maxWallTimeMs,
    )
  }

  async #initialize(observation: MatOSControllerObservation): Promise<void> {
    if (this.#initialized) return
    this.#state = await this.#runBounded(() =>
      this.#controller.initialize({
        runRef: this.#runRef,
        definitionRef: this.#definitionRef,
        objectiveRef: this.#objectiveRef,
        scopeRef: this.#scopeRef,
        manifest: this.#manifest,
        budget: observation.budget,
        bounds: this.#bounds,
        seed: this.#seed,
      }),
    )
    this.#initialized = true
  }

  #actionsForObservation(
    observationDigest: string,
  ): readonly MatOSControllerAction[] {
    return this.#actionSequence
      .filter(
        item =>
          item.action.cas.expectedObservationDigest === observationDigest,
      )
      .map(item => item.action)
  }

  async #appendCheckpoint(
    observation: MatOSControllerObservation,
  ): Promise<MatOSControllerCheckpoint> {
    if (!this.#initialized || this.#state === undefined) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'cannot checkpoint an uninitialized controller',
      )
    }
    const state = this.#controller.serializeState
      ? this.#controller.serializeState(
          freezeMatOSControllerValue(this.#state),
        )
      : toMatOSControllerJsonValue(this.#state)
    const checkpoint = createMatOSControllerCheckpoint({
      sequence: (this.#latestCheckpoint?.sequence ?? -1) + 1,
      ...(this.#latestCheckpoint
        ? {
            previousCheckpointDigest:
              this.#latestCheckpoint.checkpointDigest,
          }
        : {}),
      createdAt: this.#now(),
      runRef: this.#runRef,
      scopeRef: this.#scopeRef,
      eventCursor: observation.eventCursor,
      seed: this.#seed,
      provider: this.#provider,
      manifest: this.#manifest,
      graph: observation.graph,
      budget: observation.budget,
      observationDigest: observation.observationDigest,
      actionSequence: this.#actionSequence,
      state,
    })
    await this.#store.append(checkpoint, {
      expectedPreviousCheckpointDigest:
        this.#latestCheckpoint?.checkpointDigest ?? null,
    })
    this.#latestCheckpoint = checkpoint
    return checkpoint
  }

  async step(value: unknown): Promise<MatOSControllerStepResult> {
    if (this.#active) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller runner does not allow concurrent lifecycle calls',
      )
    }
    if (this.#finalized) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller runner is already finalized',
      )
    }
    this.#active = true
    try {
      const observation = this.#observation(value)
      await this.#initialize(observation)
      if (
        this.#latestCheckpoint?.observationDigest ===
        observation.observationDigest
      ) {
        return freezeMatOSControllerValue({
          actions: this.#actionsForObservation(
            observation.observationDigest,
          ),
          checkpoint: this.#latestCheckpoint,
          replayed: true,
        })
      }
      const output = await this.#runBounded(async () => {
        const observed = await this.#controller.observe(
          freezeMatOSControllerValue(this.#state as State),
          observation,
        )
        const actions = await this.#controller.propose(
          freezeMatOSControllerValue(observed),
          {
            observation,
            bounds: this.#bounds,
            seed: this.#seed,
          },
        )
        return { observed, actions }
      })
      if (!Array.isArray(output.actions)) {
        throw new MatOSControllerProtocolError(
          'invalid-action',
          'controller propose() must return an action array',
        )
      }
      if (output.actions.length > this.#bounds.maxActions) {
        throw new MatOSControllerProtocolError(
          'search-limit-exceeded',
          'controller returned more actions than maxActions',
        )
      }
      const actions = output.actions.map(action => {
        const sanitized = sanitizeMatOSControllerAction(action, observation)
        if (sanitized.seed !== this.#seed) {
          throw new MatOSControllerProtocolError(
            'invalid-action',
            'controller action seed does not match the pinned seed',
          )
        }
        return sanitized
      })
      assertUsageWithinBounds(actions, observation, this.#bounds)
      this.#state = output.observed
      const actionSequenceStart = this.#actionSequence.length + 1
      for (const action of actions) {
        this.#actionSequence.push(
          freezeMatOSControllerValue({
            sequence: this.#actionSequence.length + 1,
            action,
          }),
        )
      }
      const checkpoint = await this.#appendCheckpoint(observation)
      return freezeMatOSControllerValue({
        actions,
        checkpoint,
        ...(actions.length > 0
          ? {
              actionSequenceStart,
              actionSequenceEnd: this.#actionSequence.length,
            }
          : {}),
        replayed: false,
      })
    } finally {
      this.#active = false
    }
  }

  async checkpoint(value: unknown): Promise<MatOSControllerCheckpoint> {
    if (this.#active) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller runner does not allow concurrent lifecycle calls',
      )
    }
    this.#active = true
    try {
      const observation = this.#observation(value)
      await this.#initialize(observation)
      return await this.#appendCheckpoint(observation)
    } finally {
      this.#active = false
    }
  }

  async restore(checkpointId?: string): Promise<MatOSControllerCheckpoint> {
    if (this.#active) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller runner does not allow concurrent lifecycle calls',
      )
    }
    this.#active = true
    try {
      const query = {
        runRef: this.#runRef,
        scopeRef: this.#scopeRef,
        controllerId: this.#provider.controllerId,
      }
      const latest = await this.#store.latest(query)
      const checkpoint = checkpointId
        ? await this.#store.get(checkpointId)
        : latest
      if (!checkpoint) {
        throw new MatOSControllerProtocolError(
          'invalid-protocol-value',
          'controller checkpoint was not found',
        )
      }
      if (latest?.checkpointId !== checkpoint.checkpointId) {
        throw new MatOSControllerProtocolError(
          'action-cas-mismatch',
          'runner may restore only the latest append-only checkpoint',
        )
      }
      const stateVersionChanged =
        checkpoint.provider.stateVersion !== this.#provider.stateVersion
      assertMatOSControllerCheckpointCompatible(checkpoint, {
        runRef: this.#runRef,
        scopeRef: this.#scopeRef,
        seed: this.#seed,
        provider: this.#provider,
        manifest: this.#manifest,
        allowStateMigration:
          stateVersionChanged && Boolean(this.#controller.restoreState),
      })
      if (stateVersionChanged && !this.#controller.restoreState) {
        throw new MatOSControllerProtocolError(
          'controller-state-version-mismatch',
          'controller checkpoint state version requires an explicit migration',
        )
      }
      this.#state = this.#controller.restoreState
        ? this.#controller.restoreState(
            checkpoint.state,
            checkpoint.provider.stateVersion,
          )
        : (checkpoint.state as State)
      this.#initialized = true
      this.#latestCheckpoint = checkpoint
      this.#actionSequence = [...checkpoint.actionSequence]
      return checkpoint
    } finally {
      this.#active = false
    }
  }

  async finalize(): Promise<MatOSControllerFinalizeResult> {
    if (this.#active) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'controller runner does not allow concurrent lifecycle calls',
      )
    }
    if (!this.#initialized || this.#state === undefined) {
      throw new MatOSControllerProtocolError(
        'invalid-protocol-value',
        'cannot finalize an uninitialized controller',
      )
    }
    this.#active = true
    try {
      const result = this.#controller.finalize
        ? await this.#runBounded(() =>
            this.#controller.finalize?.(
              freezeMatOSControllerValue(this.#state as State),
            ),
          )
        : { outcomeRefs: [] }
      if (!result || !Array.isArray(result.outcomeRefs)) {
        throw new MatOSControllerProtocolError(
          'invalid-protocol-value',
          'controller finalize() returned an invalid result',
        )
      }
      this.#finalized = true
      return freezeMatOSControllerValue({
        ...(result.summaryRef
          ? { summaryRef: requiredString(result.summaryRef, 'summaryRef') }
          : {}),
        outcomeRefs: result.outcomeRefs.map((ref, index) =>
          requiredString(ref, `outcomeRefs[${index}]`),
        ),
      })
    } finally {
      this.#active = false
    }
  }
}

export function createMatOSControllerRunner<State>(
  options: MatOSControllerRunnerOptions<State>,
): MatOSControllerRunner<State> {
  return new MatOSControllerRunner(options)
}
