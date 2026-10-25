import { dirname } from 'node:path'
import {
  MATOS_CONTROLLER_ACTION_SCHEMA_VERSION,
  addMatOSControllerBudgetUsage,
  createMatOSControllerBudget,
  freezeMatOSControllerValue,
  matOSControllerDigest,
  toMatOSControllerJsonValue,
  type MatOSControllerAction,
  type MatOSControllerBudgetSnapshot,
  type MatOSControllerGraphCas,
  type MatOSControllerJsonValue,
  type MatOSControllerManifestCas,
  type MatOSControllerPinnedProvider,
} from './protocol.js'
import {
  appendBoundedControllerFile,
  ensureControllerStoreDirectory,
  readBoundedControllerFile,
  withControllerFileLock,
} from './storeIo.js'

export const MATOS_CONTROLLER_CHECKPOINT_SCHEMA_VERSION = 1 as const
export const MATOS_CONTROLLER_CHECKPOINT_STORE_MAX_BYTES = 16 * 1024 * 1024

export type MatOSControllerSequencedAction = Readonly<{
  sequence: number
  action: MatOSControllerAction
}>

export type MatOSControllerCheckpoint<
  State extends MatOSControllerJsonValue = MatOSControllerJsonValue,
> = Readonly<{
  schemaVersion: typeof MATOS_CONTROLLER_CHECKPOINT_SCHEMA_VERSION
  checkpointId: string
  checkpointDigest: string
  sequence: number
  previousCheckpointDigest?: string
  createdAt: string
  runRef: string
  scopeRef: string
  eventCursor: string
  seed: number
  provider: MatOSControllerPinnedProvider
  manifest: MatOSControllerManifestCas
  graph: MatOSControllerGraphCas
  budget: MatOSControllerBudgetSnapshot
  observationDigest: string
  actionSequence: readonly MatOSControllerSequencedAction[]
  state: Readonly<State>
}>

export type MatOSControllerCheckpointQuery = Readonly<{
  runRef: string
  scopeRef: string
  controllerId: string
}>

export interface MatOSControllerCheckpointStore {
  append(
    checkpoint: MatOSControllerCheckpoint,
    options: {
      expectedPreviousCheckpointDigest: string | null
    },
  ): Promise<void>
  get(checkpointId: string): Promise<MatOSControllerCheckpoint | undefined>
  latest(
    query: MatOSControllerCheckpointQuery,
  ): Promise<MatOSControllerCheckpoint | undefined>
  list(
    query: MatOSControllerCheckpointQuery,
  ): Promise<readonly MatOSControllerCheckpoint[]>
}

export type MatOSControllerCheckpointErrorCode =
  | 'invalid-checkpoint'
  | 'checkpoint-corrupt'
  | 'checkpoint-cas-mismatch'
  | 'checkpoint-chain-mismatch'
  | 'checkpoint-version-mismatch'
  | 'checkpoint-scope-mismatch'

export class MatOSControllerCheckpointError extends Error {
  readonly code: MatOSControllerCheckpointErrorCode

  constructor(code: MatOSControllerCheckpointErrorCode, message: string) {
    super(message)
    this.name = 'MatOSControllerCheckpointError'
    this.code = code
  }
}

function checkpointError(
  code: MatOSControllerCheckpointErrorCode,
  message: string,
): never {
  throw new MatOSControllerCheckpointError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    checkpointError(
      'invalid-checkpoint',
      `${path} must be a non-empty bounded string`,
    )
  }
  return value
}

function requiredDigest(value: unknown, path: string): string {
  const digest = requiredString(value, path)
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    checkpointError('invalid-checkpoint', `${path} must be a sha256 digest`)
  }
  return digest
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    checkpointError(
      'invalid-checkpoint',
      `${path} must be a non-negative integer`,
    )
  }
  return value as number
}

function checkpointTimestamp(value: unknown): string {
  const timestamp = requiredString(value, 'createdAt')
  if (!Number.isFinite(Date.parse(timestamp))) {
    checkpointError('invalid-checkpoint', 'createdAt must be an ISO timestamp')
  }
  return timestamp
}

function providerFrom(value: unknown): MatOSControllerPinnedProvider {
  if (!isRecord(value)) {
    checkpointError('invalid-checkpoint', 'provider must be an object')
  }
  const stateVersion = nonNegativeInteger(
    value.stateVersion,
    'provider.stateVersion',
  )
  if (stateVersion < 1) {
    checkpointError(
      'invalid-checkpoint',
      'provider.stateVersion must be at least 1',
    )
  }
  return freezeMatOSControllerValue({
    controllerId: requiredString(value.controllerId, 'provider.controllerId'),
    providerId: requiredString(value.providerId, 'provider.providerId'),
    providerVersion: requiredString(
      value.providerVersion,
      'provider.providerVersion',
    ),
    stateVersion,
    configDigest: requiredString(
      value.configDigest,
      'provider.configDigest',
    ),
    implementationDigest: requiredDigest(
      value.implementationDigest,
      'provider.implementationDigest',
    ),
    ...(value.assetRef !== undefined
      ? { assetRef: requiredString(value.assetRef, 'provider.assetRef') }
      : {}),
    ...(value.runtimeRef !== undefined
      ? { runtimeRef: requiredString(value.runtimeRef, 'provider.runtimeRef') }
      : {}),
  })
}

function manifestFrom(value: unknown): MatOSControllerManifestCas {
  if (!isRecord(value)) {
    checkpointError('invalid-checkpoint', 'manifest must be an object')
  }
  return freezeMatOSControllerValue({
    ref: requiredString(value.ref, 'manifest.ref'),
    digest: requiredString(value.digest, 'manifest.digest'),
  })
}

function graphFrom(value: unknown): MatOSControllerGraphCas {
  if (!isRecord(value)) {
    checkpointError('invalid-checkpoint', 'graph must be an object')
  }
  return freezeMatOSControllerValue({
    snapshotRef: requiredString(value.snapshotRef, 'graph.snapshotRef'),
    digest: requiredString(value.digest, 'graph.digest'),
    version: nonNegativeInteger(value.version, 'graph.version'),
  })
}

function budgetFrom(value: unknown): MatOSControllerBudgetSnapshot {
  if (!isRecord(value) || !isRecord(value.limits) || !isRecord(value.used)) {
    checkpointError('invalid-checkpoint', 'budget snapshot is invalid')
  }
  const budget = createMatOSControllerBudget({
    limits: value.limits as MatOSControllerBudgetSnapshot['limits'],
    used: value.used as MatOSControllerBudgetSnapshot['used'],
  })
  if (matOSControllerDigest(budget.remaining) !== matOSControllerDigest(value.remaining)) {
    checkpointError(
      'invalid-checkpoint',
      'budget remaining values are inconsistent',
    )
  }
  return budget
}

const ACTION_TYPES = new Set<MatOSControllerAction['type']>([
  'noop',
  'rank-ready',
  'propose-graph-patch',
  'request-validation',
  'request-human',
  'pause',
  'stop-request',
  'recovery-request',
])

function checkpointActionFrom(
  value: unknown,
  expectedRunRef: string,
  expectedScopeRef: string,
  expectedSeed: number,
): MatOSControllerAction {
  if (!isRecord(value)) {
    checkpointError('invalid-checkpoint', 'action must be an object')
  }
  if (
    value.schemaVersion !== MATOS_CONTROLLER_ACTION_SCHEMA_VERSION ||
    !ACTION_TYPES.has(value.type as MatOSControllerAction['type'])
  ) {
    checkpointError('invalid-checkpoint', 'action schema or type is invalid')
  }
  if (value.runRef !== expectedRunRef) {
    checkpointError('checkpoint-chain-mismatch', 'action runRef changed')
  }
  if (value.scopeRef !== expectedScopeRef) {
    checkpointError('checkpoint-scope-mismatch', 'action scopeRef changed')
  }
  if (value.seed !== expectedSeed) {
    checkpointError('checkpoint-chain-mismatch', 'action seed changed')
  }
  const canonical = toMatOSControllerJsonValue(value)
  if (!isRecord(canonical)) {
    checkpointError('invalid-checkpoint', 'action is not canonical JSON')
  }
  const { actionId, ...withoutId } = canonical
  const expectedId = `controller-action:${matOSControllerDigest(withoutId)}`
  if (actionId !== expectedId) {
    checkpointError('checkpoint-corrupt', 'action digest is invalid')
  }
  return freezeMatOSControllerValue(canonical as MatOSControllerAction)
}

function actionSequenceFrom(input: {
  value: unknown
  runRef: string
  scopeRef: string
  seed: number
}): readonly MatOSControllerSequencedAction[] {
  if (!Array.isArray(input.value)) {
    checkpointError('invalid-checkpoint', 'actionSequence must be an array')
  }
  return freezeMatOSControllerValue(
    input.value.map((item, index) => {
      if (!isRecord(item) || item.sequence !== index + 1) {
        checkpointError(
          'invalid-checkpoint',
          'actionSequence must be contiguous and start at 1',
        )
      }
      return {
        sequence: index + 1,
        action: checkpointActionFrom(
          item.action,
          input.runRef,
          input.scopeRef,
          input.seed,
        ),
      }
    }),
  )
}

type CheckpointBody<State extends MatOSControllerJsonValue> = Omit<
  MatOSControllerCheckpoint<State>,
  'schemaVersion' | 'checkpointId' | 'checkpointDigest'
>

export function createMatOSControllerCheckpoint<
  State extends MatOSControllerJsonValue,
>(input: CheckpointBody<State>): MatOSControllerCheckpoint<State> {
  const sequence = nonNegativeInteger(input.sequence, 'sequence')
  const runRef = requiredString(input.runRef, 'runRef')
  const scopeRef = requiredString(input.scopeRef, 'scopeRef')
  const seed = nonNegativeInteger(input.seed, 'seed')
  const previousCheckpointDigest = input.previousCheckpointDigest
    ? requiredString(
        input.previousCheckpointDigest,
        'previousCheckpointDigest',
      )
    : undefined
  if ((sequence === 0) !== (previousCheckpointDigest === undefined)) {
    checkpointError(
      'invalid-checkpoint',
      'only checkpoint sequence 0 may omit previousCheckpointDigest',
    )
  }
  const body = {
    sequence,
    ...(previousCheckpointDigest ? { previousCheckpointDigest } : {}),
    createdAt: checkpointTimestamp(input.createdAt),
    runRef,
    scopeRef,
    eventCursor: requiredString(input.eventCursor, 'eventCursor'),
    seed,
    provider: providerFrom(input.provider),
    manifest: manifestFrom(input.manifest),
    graph: graphFrom(input.graph),
    budget: budgetFrom(input.budget),
    observationDigest: requiredString(
      input.observationDigest,
      'observationDigest',
    ),
    actionSequence: actionSequenceFrom({
      value: input.actionSequence,
      runRef,
      scopeRef,
      seed,
    }),
    state: freezeMatOSControllerValue(
      toMatOSControllerJsonValue(input.state) as State,
    ),
  } satisfies CheckpointBody<State>
  const digestPayload = {
    schemaVersion: MATOS_CONTROLLER_CHECKPOINT_SCHEMA_VERSION,
    ...body,
  }
  const checkpointDigest = matOSControllerDigest(digestPayload)
  return freezeMatOSControllerValue({
    ...digestPayload,
    checkpointId: `controller-checkpoint:${sequence}:${checkpointDigest}`,
    checkpointDigest,
  })
}

export function sanitizeMatOSControllerCheckpoint(
  value: unknown,
): MatOSControllerCheckpoint {
  if (!isRecord(value)) {
    checkpointError('checkpoint-corrupt', 'checkpoint must be an object')
  }
  if (value.schemaVersion !== MATOS_CONTROLLER_CHECKPOINT_SCHEMA_VERSION) {
    checkpointError(
      'checkpoint-version-mismatch',
      `unsupported checkpoint schema version ${String(value.schemaVersion)}`,
    )
  }
  const checkpoint = createMatOSControllerCheckpoint(
    value as unknown as CheckpointBody<MatOSControllerJsonValue>,
  )
  if (
    value.checkpointDigest !== checkpoint.checkpointDigest ||
    value.checkpointId !== checkpoint.checkpointId
  ) {
    checkpointError('checkpoint-corrupt', 'checkpoint digest is invalid')
  }
  return checkpoint
}

export function assertMatOSControllerCheckpointCompatible(
  checkpoint: MatOSControllerCheckpoint,
  expected: {
    runRef: string
    scopeRef: string
    seed: number
    provider: MatOSControllerPinnedProvider
    manifest: MatOSControllerManifestCas
    allowStateMigration?: boolean
  },
): void {
  if (checkpoint.runRef !== expected.runRef) {
    checkpointError('checkpoint-chain-mismatch', 'checkpoint runRef changed')
  }
  if (checkpoint.scopeRef !== expected.scopeRef) {
    checkpointError('checkpoint-scope-mismatch', 'checkpoint scopeRef changed')
  }
  if (checkpoint.seed !== expected.seed) {
    checkpointError('checkpoint-chain-mismatch', 'checkpoint seed changed')
  }
  if (
    checkpoint.manifest.ref !== expected.manifest.ref ||
    checkpoint.manifest.digest !== expected.manifest.digest
  ) {
    checkpointError('checkpoint-chain-mismatch', 'checkpoint manifest changed')
  }
  const stateVersionChanged =
    checkpoint.provider.stateVersion !== expected.provider.stateVersion
  if (
    checkpoint.provider.controllerId !== expected.provider.controllerId ||
    checkpoint.provider.providerId !== expected.provider.providerId ||
    checkpoint.provider.providerVersion !== expected.provider.providerVersion ||
    checkpoint.provider.configDigest !== expected.provider.configDigest ||
    checkpoint.provider.implementationDigest !==
      expected.provider.implementationDigest ||
    checkpoint.provider.assetRef !== expected.provider.assetRef ||
    checkpoint.provider.runtimeRef !== expected.provider.runtimeRef ||
    (stateVersionChanged && !expected.allowStateMigration)
  ) {
    checkpointError(
      stateVersionChanged
        ? 'checkpoint-version-mismatch'
        : 'checkpoint-chain-mismatch',
      'checkpoint controller provider is not compatible',
    )
  }
}

function sameActionPrefix(
  previous: readonly MatOSControllerSequencedAction[],
  next: readonly MatOSControllerSequencedAction[],
): boolean {
  return (
    next.length >= previous.length &&
    previous.every(
      (item, index) =>
        matOSControllerDigest(item) === matOSControllerDigest(next[index]),
    )
  )
}

function assertAppend(
  checkpoint: MatOSControllerCheckpoint,
  previous: MatOSControllerCheckpoint | undefined,
  expectedPreviousCheckpointDigest: string | null,
): void {
  const actualPreviousDigest = previous?.checkpointDigest ?? null
  if (actualPreviousDigest !== expectedPreviousCheckpointDigest) {
    checkpointError(
      'checkpoint-cas-mismatch',
      'checkpoint append CAS does not match the latest checkpoint',
    )
  }
  if (!previous) {
    if (
      checkpoint.sequence !== 0 ||
      checkpoint.previousCheckpointDigest !== undefined
    ) {
      checkpointError(
        'checkpoint-chain-mismatch',
        'first checkpoint must have sequence 0 and no predecessor',
      )
    }
    return
  }
  const stateVersionChanged =
    checkpoint.provider.stateVersion !== previous.provider.stateVersion
  assertMatOSControllerCheckpointCompatible(checkpoint, {
    runRef: previous.runRef,
    scopeRef: previous.scopeRef,
    seed: previous.seed,
    provider: previous.provider,
    manifest: previous.manifest,
    allowStateMigration:
      stateVersionChanged &&
      checkpoint.provider.stateVersion > previous.provider.stateVersion,
  })
  if (
    checkpoint.sequence !== previous.sequence + 1 ||
    checkpoint.previousCheckpointDigest !== previous.checkpointDigest
  ) {
    checkpointError(
      'checkpoint-chain-mismatch',
      'checkpoint sequence or predecessor digest is invalid',
    )
  }
  if (!sameActionPrefix(previous.actionSequence, checkpoint.actionSequence)) {
    checkpointError(
      'checkpoint-chain-mismatch',
      'checkpoint action sequence rewrites prior actions',
    )
  }
  if (checkpoint.graph.version < previous.graph.version) {
    checkpointError(
      'checkpoint-chain-mismatch',
      'checkpoint graph CAS version moved backwards',
    )
  }
  const previousUsed = addMatOSControllerBudgetUsage([previous.budget.used])
  const nextUsed = addMatOSControllerBudgetUsage([checkpoint.budget.used])
  for (const key of Object.keys(previousUsed) as (keyof typeof previousUsed)[]) {
    if (nextUsed[key] < previousUsed[key]) {
      checkpointError(
        'checkpoint-chain-mismatch',
        `checkpoint budget usage moved backwards for ${key}`,
      )
    }
    if (checkpoint.budget.limits[key] > previous.budget.limits[key]) {
      checkpointError(
        'checkpoint-chain-mismatch',
        `checkpoint budget limit increased for ${key}`,
      )
    }
  }
}

function matchesQuery(
  checkpoint: MatOSControllerCheckpoint,
  query: MatOSControllerCheckpointQuery,
): boolean {
  return (
    checkpoint.runRef === query.runRef &&
    checkpoint.scopeRef === query.scopeRef &&
    checkpoint.provider.controllerId === query.controllerId
  )
}

export class InMemoryMatOSControllerCheckpointStore
  implements MatOSControllerCheckpointStore
{
  readonly #checkpoints: MatOSControllerCheckpoint[] = []

  async append(
    checkpointValue: MatOSControllerCheckpoint,
    options: { expectedPreviousCheckpointDigest: string | null },
  ): Promise<void> {
    const checkpoint = sanitizeMatOSControllerCheckpoint(checkpointValue)
    const query = {
      runRef: checkpoint.runRef,
      scopeRef: checkpoint.scopeRef,
      controllerId: checkpoint.provider.controllerId,
    }
    const previous = [...this.#checkpoints]
      .reverse()
      .find(item => matchesQuery(item, query))
    assertAppend(
      checkpoint,
      previous,
      options.expectedPreviousCheckpointDigest,
    )
    this.#checkpoints.push(checkpoint)
  }

  async get(
    checkpointId: string,
  ): Promise<MatOSControllerCheckpoint | undefined> {
    return this.#checkpoints.find(item => item.checkpointId === checkpointId)
  }

  async latest(
    query: MatOSControllerCheckpointQuery,
  ): Promise<MatOSControllerCheckpoint | undefined> {
    return [...this.#checkpoints]
      .reverse()
      .find(item => matchesQuery(item, query))
  }

  async list(
    query: MatOSControllerCheckpointQuery,
  ): Promise<readonly MatOSControllerCheckpoint[]> {
    return this.#checkpoints.filter(item => matchesQuery(item, query))
  }
}

export class JsonlMatOSControllerCheckpointStore
  implements MatOSControllerCheckpointStore
{
  readonly path: string
  #pending: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async #readAll(): Promise<MatOSControllerCheckpoint[]> {
    let raw: string | undefined
    try {
      await ensureControllerStoreDirectory(dirname(this.path))
      raw = await readBoundedControllerFile({
        path: this.path,
        maxBytes: MATOS_CONTROLLER_CHECKPOINT_STORE_MAX_BYTES,
        missingOk: true,
      })
    } catch (error) {
      checkpointError('checkpoint-corrupt', `unsafe checkpoint store: ${String(error)}`)
    }
    if (raw === undefined) return []
    const checkpoints: MatOSControllerCheckpoint[] = []
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      try {
        checkpoints.push(sanitizeMatOSControllerCheckpoint(JSON.parse(line)))
      } catch (error) {
        if (error instanceof MatOSControllerCheckpointError) throw error
        checkpointError(
          'checkpoint-corrupt',
          `invalid checkpoint JSONL record at line ${index + 1}`,
        )
      }
    }
    return checkpoints
  }

  async append(
    checkpointValue: MatOSControllerCheckpoint,
    options: { expectedPreviousCheckpointDigest: string | null },
  ): Promise<void> {
    const operation = this.#pending.then(async () => {
      const checkpoint = sanitizeMatOSControllerCheckpoint(checkpointValue)
      await ensureControllerStoreDirectory(dirname(this.path)).catch(error =>
        checkpointError('checkpoint-corrupt', `unsafe checkpoint store: ${String(error)}`),
      )
      await withControllerFileLock({
        path: this.path,
        operation: async () => {
          const checkpoints = await this.#readAll()
          const query = {
            runRef: checkpoint.runRef,
            scopeRef: checkpoint.scopeRef,
            controllerId: checkpoint.provider.controllerId,
          }
          const previous = [...checkpoints]
            .reverse()
            .find(item => matchesQuery(item, query))
          assertAppend(
            checkpoint,
            previous,
            options.expectedPreviousCheckpointDigest,
          )
          await appendBoundedControllerFile({
            path: this.path,
            data: `${JSON.stringify(checkpoint)}\n`,
            maxBytes: MATOS_CONTROLLER_CHECKPOINT_STORE_MAX_BYTES,
          })
        },
      }).catch(error => {
        if (error instanceof MatOSControllerCheckpointError) throw error
        checkpointError('checkpoint-corrupt', `unsafe checkpoint store: ${String(error)}`)
      })
    })
    this.#pending = operation.catch(() => undefined)
    return operation
  }

  async get(
    checkpointId: string,
  ): Promise<MatOSControllerCheckpoint | undefined> {
    await this.#pending
    return (await this.#readAll()).find(
      item => item.checkpointId === checkpointId,
    )
  }

  async latest(
    query: MatOSControllerCheckpointQuery,
  ): Promise<MatOSControllerCheckpoint | undefined> {
    await this.#pending
    return [...(await this.#readAll())]
      .reverse()
      .find(item => matchesQuery(item, query))
  }

  async list(
    query: MatOSControllerCheckpointQuery,
  ): Promise<readonly MatOSControllerCheckpoint[]> {
    await this.#pending
    return (await this.#readAll()).filter(item => matchesQuery(item, query))
  }
}
