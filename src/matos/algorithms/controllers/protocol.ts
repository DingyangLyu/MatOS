import { createHash } from 'node:crypto'

export const MATOS_CONTROLLER_PROTOCOL_VERSION = 1 as const
export const MATOS_CONTROLLER_OBSERVATION_SCHEMA_VERSION = 1 as const
export const MATOS_CONTROLLER_ACTION_SCHEMA_VERSION = 1 as const

export type MatOSControllerJsonPrimitive = string | number | boolean | null
export type MatOSControllerJsonValue =
  | MatOSControllerJsonPrimitive
  | readonly MatOSControllerJsonValue[]
  | { readonly [key: string]: MatOSControllerJsonValue }

export type MatOSControllerErrorCode =
  | 'invalid-protocol-value'
  | 'invalid-observation'
  | 'observation-digest-mismatch'
  | 'invalid-action'
  | 'action-cas-mismatch'
  | 'scope-mismatch'
  | 'run-mismatch'
  | 'manifest-mismatch'
  | 'budget-exceeded'
  | 'search-limit-exceeded'
  | 'controller-timeout'
  | 'controller-state-version-mismatch'

export class MatOSControllerProtocolError extends Error {
  readonly code: MatOSControllerErrorCode

  constructor(code: MatOSControllerErrorCode, message: string) {
    super(message)
    this.name = 'MatOSControllerProtocolError'
    this.code = code
  }
}

function protocolError(
  code: MatOSControllerErrorCode,
  message: string,
): never {
  throw new MatOSControllerProtocolError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonValueAt(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): MatOSControllerJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value as MatOSControllerJsonPrimitive
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      protocolError('invalid-protocol-value', `${path} must be finite`)
    }
    return value
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      protocolError('invalid-protocol-value', `${path} contains a cycle`)
    }
    ancestors.add(value)
    const output = value.map((item, index) =>
      jsonValueAt(item, `${path}[${index}]`, ancestors),
    )
    ancestors.delete(value)
    return output
  }
  if (!isRecord(value)) {
    protocolError(
      'invalid-protocol-value',
      `${path} must contain JSON-compatible data only`,
    )
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    protocolError('invalid-protocol-value', `${path} must be a plain object`)
  }
  if (ancestors.has(value)) {
    protocolError('invalid-protocol-value', `${path} contains a cycle`)
  }
  ancestors.add(value)
  const output: Record<string, MatOSControllerJsonValue> = {}
  for (const key of Object.keys(value).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const item = value[key]
    if (item === undefined) {
      protocolError('invalid-protocol-value', `${path}.${key} is undefined`)
    }
    output[key] = jsonValueAt(item, `${path}.${key}`, ancestors)
  }
  ancestors.delete(value)
  return output
}

export function toMatOSControllerJsonValue(
  value: unknown,
): MatOSControllerJsonValue {
  return jsonValueAt(value, '$', new WeakSet<object>())
}

export function freezeMatOSControllerValue<T>(value: T): Readonly<T> {
  const seen = new WeakSet<object>()
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    if (!Object.isFrozen(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) {
        freeze(child)
      }
      Object.freeze(item)
    }
  }
  freeze(value)
  return value
}

export function cloneMatOSControllerJson<T extends MatOSControllerJsonValue>(
  value: T,
): Readonly<T> {
  return freezeMatOSControllerValue(toMatOSControllerJsonValue(value) as T)
}

export function matOSControllerDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(toMatOSControllerJsonValue(value)))
    .digest('hex')
}

function requiredString(
  value: unknown,
  path: string,
  code: MatOSControllerErrorCode = 'invalid-protocol-value',
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    protocolError(code, `${path} must be a non-empty bounded string`)
  }
  return value
}

function optionalString(
  value: unknown,
  path: string,
): string | undefined {
  return value === undefined ? undefined : requiredString(value, path)
}

function nonNegativeNumber(
  value: unknown,
  path: string,
  integer = false,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    protocolError(
      'invalid-protocol-value',
      `${path} must be a non-negative${integer ? ' integer' : ''} number`,
    )
  }
  return value
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nonNegativeNumber(value, path, true)
  if (parsed < 1) {
    protocolError('invalid-protocol-value', `${path} must be at least 1`)
  }
  return parsed
}

function referenceArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    protocolError(
      'invalid-protocol-value',
      `${path} must be a bounded reference array`,
    )
  }
  const refs = value.map((item, index) =>
    requiredString(item, `${path}[${index}]`),
  )
  if (new Set(refs).size !== refs.length) {
    protocolError('invalid-protocol-value', `${path} contains duplicate refs`)
  }
  return refs
}

export type MatOSControllerBudgetUsage = Readonly<{
  actions: number
  candidates: number
  transitions: number
  evaluations: number
  maxDepth: number
  wallTimeMs: number
  costUsd: number
}>

export type MatOSControllerBudgetSnapshot = Readonly<{
  limits: MatOSControllerBudgetUsage
  used: MatOSControllerBudgetUsage
  remaining: MatOSControllerBudgetUsage
}>

const BUDGET_KEYS = [
  'actions',
  'candidates',
  'transitions',
  'evaluations',
  'maxDepth',
  'wallTimeMs',
  'costUsd',
] as const satisfies readonly (keyof MatOSControllerBudgetUsage)[]

const INTEGER_BUDGET_KEYS = new Set<keyof MatOSControllerBudgetUsage>([
  'actions',
  'candidates',
  'transitions',
  'evaluations',
  'maxDepth',
])

export function createMatOSControllerBudgetUsage(
  input: Partial<MatOSControllerBudgetUsage> = {},
): MatOSControllerBudgetUsage {
  const usage = Object.fromEntries(
    BUDGET_KEYS.map(key => [
      key,
      nonNegativeNumber(
        input[key] ?? 0,
        `budget.${key}`,
        INTEGER_BUDGET_KEYS.has(key),
      ),
    ]),
  ) as MatOSControllerBudgetUsage
  return freezeMatOSControllerValue(usage)
}

function parseBudgetUsage(
  value: unknown,
  path: string,
): MatOSControllerBudgetUsage {
  if (!isRecord(value)) {
    protocolError('invalid-protocol-value', `${path} must be an object`)
  }
  return createMatOSControllerBudgetUsage(
    Object.fromEntries(BUDGET_KEYS.map(key => [key, value[key]])),
  )
}

export function addMatOSControllerBudgetUsage(
  values: readonly MatOSControllerBudgetUsage[],
): MatOSControllerBudgetUsage {
  const total = createMatOSControllerBudgetUsage()
  const mutable = { ...total }
  for (const value of values) {
    for (const key of BUDGET_KEYS) {
      mutable[key] =
        key === 'maxDepth'
          ? Math.max(mutable[key], value[key])
          : mutable[key] + value[key]
    }
  }
  return createMatOSControllerBudgetUsage(mutable)
}

export function createMatOSControllerBudget(input: {
  limits: MatOSControllerBudgetUsage
  used?: Partial<MatOSControllerBudgetUsage>
}): MatOSControllerBudgetSnapshot {
  const limits = createMatOSControllerBudgetUsage(input.limits)
  const used = createMatOSControllerBudgetUsage(input.used)
  const remaining = { ...limits }
  for (const key of BUDGET_KEYS) {
    if (used[key] > limits[key]) {
      protocolError(
        'budget-exceeded',
        `budget.used.${key} exceeds budget.limits.${key}`,
      )
    }
    remaining[key] = Math.max(0, limits[key] - used[key])
  }
  return freezeMatOSControllerValue({
    limits,
    used,
    remaining: createMatOSControllerBudgetUsage(remaining),
  })
}

function parseBudgetSnapshot(value: unknown): MatOSControllerBudgetSnapshot {
  if (!isRecord(value)) {
    protocolError('invalid-protocol-value', 'budget must be an object')
  }
  const limits = parseBudgetUsage(value.limits, 'budget.limits')
  const used = parseBudgetUsage(value.used, 'budget.used')
  const expected = createMatOSControllerBudget({ limits, used })
  const remaining = parseBudgetUsage(value.remaining, 'budget.remaining')
  for (const key of BUDGET_KEYS) {
    if (Math.abs(remaining[key] - expected.remaining[key]) > 1e-9) {
      protocolError(
        'invalid-protocol-value',
        `budget.remaining.${key} is inconsistent with limits and used`,
      )
    }
  }
  return expected
}

export function matOSControllerUsageFits(
  usage: MatOSControllerBudgetUsage,
  remaining: MatOSControllerBudgetUsage,
): boolean {
  return BUDGET_KEYS.every(key => usage[key] <= remaining[key] + 1e-9)
}

export type MatOSControllerSearchBounds = Readonly<{
  maxActions: number
  maxCandidates: number
  maxDepth: number
  maxWallTimeMs: number
  maxCostUsd: number
}>

export function createMatOSControllerSearchBounds(
  input: MatOSControllerSearchBounds,
): MatOSControllerSearchBounds {
  return freezeMatOSControllerValue({
    maxActions: positiveInteger(input.maxActions, 'bounds.maxActions'),
    maxCandidates: positiveInteger(
      input.maxCandidates,
      'bounds.maxCandidates',
    ),
    maxDepth: positiveInteger(input.maxDepth, 'bounds.maxDepth'),
    maxWallTimeMs: nonNegativeNumber(
      input.maxWallTimeMs,
      'bounds.maxWallTimeMs',
    ),
    maxCostUsd: nonNegativeNumber(input.maxCostUsd, 'bounds.maxCostUsd'),
  })
}

export type MatOSControllerManifestCas = Readonly<{
  ref: string
  digest: string
}>

export type MatOSControllerGraphCas = Readonly<{
  snapshotRef: string
  digest: string
  version: number
}>

export type MatOSControllerObservationStatus =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type MatOSControllerObservation = Readonly<{
  schemaVersion: typeof MATOS_CONTROLLER_OBSERVATION_SCHEMA_VERSION
  runRef: string
  scopeRef: string
  eventCursor: string
  status: MatOSControllerObservationStatus
  manifest: MatOSControllerManifestCas
  graph: MatOSControllerGraphCas
  readyNodeRefs: readonly string[]
  runningNodeRefs: readonly string[]
  completedNodeRefs: readonly string[]
  failedNodeRefs: readonly string[]
  artifactRefs: readonly string[]
  validationRefs: readonly string[]
  budget: MatOSControllerBudgetSnapshot
  resourceSnapshotRef?: string
  userInputRef?: string
  observationDigest: string
}>

export type MatOSControllerObservationInput = Omit<
  MatOSControllerObservation,
  'schemaVersion' | 'observationDigest'
>

const OBSERVATION_STATUSES = new Set<MatOSControllerObservationStatus>([
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

function observationPayload(
  input: MatOSControllerObservationInput,
): Omit<MatOSControllerObservation, 'observationDigest'> {
  const status = input.status
  if (!OBSERVATION_STATUSES.has(status)) {
    protocolError('invalid-observation', `unsupported observation status ${status}`)
  }
  const manifest = {
    ref: requiredString(input.manifest?.ref, 'manifest.ref', 'invalid-observation'),
    digest: requiredString(
      input.manifest?.digest,
      'manifest.digest',
      'invalid-observation',
    ),
  }
  const graph = {
    snapshotRef: requiredString(
      input.graph?.snapshotRef,
      'graph.snapshotRef',
      'invalid-observation',
    ),
    digest: requiredString(
      input.graph?.digest,
      'graph.digest',
      'invalid-observation',
    ),
    version: nonNegativeNumber(input.graph?.version, 'graph.version', true),
  }
  return {
    schemaVersion: MATOS_CONTROLLER_OBSERVATION_SCHEMA_VERSION,
    runRef: requiredString(input.runRef, 'runRef', 'invalid-observation'),
    scopeRef: requiredString(input.scopeRef, 'scopeRef', 'invalid-observation'),
    eventCursor: requiredString(
      input.eventCursor,
      'eventCursor',
      'invalid-observation',
    ),
    status,
    manifest,
    graph,
    readyNodeRefs: referenceArray(input.readyNodeRefs, 'readyNodeRefs'),
    runningNodeRefs: referenceArray(input.runningNodeRefs, 'runningNodeRefs'),
    completedNodeRefs: referenceArray(
      input.completedNodeRefs,
      'completedNodeRefs',
    ),
    failedNodeRefs: referenceArray(input.failedNodeRefs, 'failedNodeRefs'),
    artifactRefs: referenceArray(input.artifactRefs, 'artifactRefs'),
    validationRefs: referenceArray(input.validationRefs, 'validationRefs'),
    budget: parseBudgetSnapshot(input.budget),
    ...(input.resourceSnapshotRef
      ? {
          resourceSnapshotRef: requiredString(
            input.resourceSnapshotRef,
            'resourceSnapshotRef',
            'invalid-observation',
          ),
        }
      : {}),
    ...(input.userInputRef
      ? {
          userInputRef: requiredString(
            input.userInputRef,
            'userInputRef',
            'invalid-observation',
          ),
        }
      : {}),
  }
}

export function createMatOSControllerObservation(
  input: MatOSControllerObservationInput,
): MatOSControllerObservation {
  const payload = observationPayload(input)
  return freezeMatOSControllerValue({
    ...payload,
    observationDigest: matOSControllerDigest(payload),
  })
}

export function sanitizeMatOSControllerObservation(
  value: unknown,
): MatOSControllerObservation {
  if (!isRecord(value)) {
    protocolError('invalid-observation', 'observation must be an object')
  }
  if (value.schemaVersion !== MATOS_CONTROLLER_OBSERVATION_SCHEMA_VERSION) {
    protocolError(
      'invalid-observation',
      `unsupported observation schema version ${String(value.schemaVersion)}`,
    )
  }
  const observation = createMatOSControllerObservation(
    value as MatOSControllerObservationInput,
  )
  if (value.observationDigest !== observation.observationDigest) {
    protocolError(
      'observation-digest-mismatch',
      'observation digest does not match the sanitized payload',
    )
  }
  return observation
}

export type MatOSControllerActionCas = Readonly<{
  expectedObservationDigest: string
  expectedEventCursor: string
  expectedManifestDigest: string
  expectedGraphDigest: string
  expectedGraphVersion: number
}>

export type MatOSControllerGraphPatchCandidate = Readonly<{
  candidateRef: string
  patchDigest: string
  baseGraphDigest: string
  baseGraphVersion: number
  summaryRef?: string
}>

export type MatOSControllerActionIntent =
  | Readonly<{ type: 'noop'; reason: string }>
  | Readonly<{ type: 'rank-ready'; orderedNodeRefs: readonly string[] }>
  | Readonly<{
      type: 'propose-graph-patch'
      candidate: MatOSControllerGraphPatchCandidate
      reason: string
    }>
  | Readonly<{
      type: 'request-validation'
      validationRef: string
      targetRefs: readonly string[]
      reason: string
    }>
  | Readonly<{
      type: 'request-human'
      promptRef: string
      reason: string
    }>
  | Readonly<{
      type: 'pause'
      reason: string
      resumeConditionRef?: string
    }>
  | Readonly<{
      type: 'stop-request'
      status: 'completed' | 'failed' | 'cancelled'
      reason: string
    }>
  | Readonly<{
      type: 'recovery-request'
      checkpointRef: string
      mode: 'restore' | 'reconcile'
      reason: string
    }>

export type MatOSControllerActionBase = Readonly<{
  schemaVersion: typeof MATOS_CONTROLLER_ACTION_SCHEMA_VERSION
  actionId: string
  runRef: string
  scopeRef: string
  seed: number
  cas: MatOSControllerActionCas
  budgetUsage: MatOSControllerBudgetUsage
}>

export type MatOSControllerAction = MatOSControllerActionBase &
  MatOSControllerActionIntent

function canonicalActionIntent(
  intent: MatOSControllerActionIntent,
  observation: MatOSControllerObservation,
): MatOSControllerActionIntent {
  switch (intent.type) {
    case 'noop':
      return { type: 'noop', reason: requiredString(intent.reason, 'reason') }
    case 'rank-ready': {
      const orderedNodeRefs = referenceArray(
        intent.orderedNodeRefs,
        'orderedNodeRefs',
      )
      if (
        orderedNodeRefs.length !== observation.readyNodeRefs.length ||
        orderedNodeRefs.some(ref => !observation.readyNodeRefs.includes(ref))
      ) {
        protocolError(
          'invalid-action',
          'rank-ready must rank every supplied ready node exactly once',
        )
      }
      return { type: 'rank-ready', orderedNodeRefs }
    }
    case 'propose-graph-patch': {
      const candidate = intent.candidate
      if (!candidate || typeof candidate !== 'object') {
        protocolError('invalid-action', 'graph patch candidate is required')
      }
      const canonical: MatOSControllerGraphPatchCandidate = {
        candidateRef: requiredString(
          candidate.candidateRef,
          'candidate.candidateRef',
        ),
        patchDigest: requiredString(
          candidate.patchDigest,
          'candidate.patchDigest',
        ),
        baseGraphDigest: requiredString(
          candidate.baseGraphDigest,
          'candidate.baseGraphDigest',
        ),
        baseGraphVersion: nonNegativeNumber(
          candidate.baseGraphVersion,
          'candidate.baseGraphVersion',
          true,
        ),
        ...(candidate.summaryRef
          ? {
              summaryRef: requiredString(
                candidate.summaryRef,
                'candidate.summaryRef',
              ),
            }
          : {}),
      }
      if (
        canonical.baseGraphDigest !== observation.graph.digest ||
        canonical.baseGraphVersion !== observation.graph.version
      ) {
        protocolError(
          'action-cas-mismatch',
          'graph patch candidate is not based on the observed graph CAS',
        )
      }
      return {
        type: 'propose-graph-patch',
        candidate: canonical,
        reason: requiredString(intent.reason, 'reason'),
      }
    }
    case 'request-validation': {
      const targetRefs = referenceArray(intent.targetRefs, 'targetRefs')
      if (targetRefs.length === 0) {
        protocolError('invalid-action', 'validation targets cannot be empty')
      }
      return {
        type: 'request-validation',
        validationRef: requiredString(
          intent.validationRef,
          'validationRef',
        ),
        targetRefs,
        reason: requiredString(intent.reason, 'reason'),
      }
    }
    case 'request-human':
      return {
        type: 'request-human',
        promptRef: requiredString(intent.promptRef, 'promptRef'),
        reason: requiredString(intent.reason, 'reason'),
      }
    case 'pause':
      return {
        type: 'pause',
        reason: requiredString(intent.reason, 'reason'),
        ...(intent.resumeConditionRef
          ? {
              resumeConditionRef: requiredString(
                intent.resumeConditionRef,
                'resumeConditionRef',
              ),
            }
          : {}),
      }
    case 'stop-request':
      if (!['completed', 'failed', 'cancelled'].includes(intent.status)) {
        protocolError('invalid-action', 'unsupported requested stop status')
      }
      return {
        type: 'stop-request',
        status: intent.status,
        reason: requiredString(intent.reason, 'reason'),
      }
    case 'recovery-request':
      if (intent.mode !== 'restore' && intent.mode !== 'reconcile') {
        protocolError('invalid-action', 'unsupported recovery request mode')
      }
      return {
        type: 'recovery-request',
        checkpointRef: requiredString(intent.checkpointRef, 'checkpointRef'),
        mode: intent.mode,
        reason: requiredString(intent.reason, 'reason'),
      }
    default:
      protocolError(
        'invalid-action',
        `unsupported controller action ${(intent as { type?: unknown }).type}`,
      )
  }
}

function actionWithoutId(input: {
  observation: MatOSControllerObservation
  seed: number
  budgetUsage: MatOSControllerBudgetUsage
  intent: MatOSControllerActionIntent
}): Omit<MatOSControllerAction, 'actionId'> {
  const seed = nonNegativeNumber(input.seed, 'seed', true)
  const budgetUsage = createMatOSControllerBudgetUsage(input.budgetUsage)
  if (budgetUsage.actions !== 1) {
    protocolError(
      'invalid-action',
      'each structured controller action must account for exactly one action',
    )
  }
  const intent = canonicalActionIntent(input.intent, input.observation)
  return {
    schemaVersion: MATOS_CONTROLLER_ACTION_SCHEMA_VERSION,
    runRef: input.observation.runRef,
    scopeRef: input.observation.scopeRef,
    seed,
    cas: {
      expectedObservationDigest: input.observation.observationDigest,
      expectedEventCursor: input.observation.eventCursor,
      expectedManifestDigest: input.observation.manifest.digest,
      expectedGraphDigest: input.observation.graph.digest,
      expectedGraphVersion: input.observation.graph.version,
    },
    budgetUsage,
    ...intent,
  } as Omit<MatOSControllerAction, 'actionId'>
}

export function createMatOSControllerAction(input: {
  observation: MatOSControllerObservation
  seed: number
  budgetUsage?: Partial<MatOSControllerBudgetUsage>
  intent: MatOSControllerActionIntent
}): MatOSControllerAction {
  const withoutId = actionWithoutId({
    ...input,
    budgetUsage: createMatOSControllerBudgetUsage({
      ...input.budgetUsage,
      actions: 1,
    }),
  })
  return freezeMatOSControllerValue({
    ...withoutId,
    actionId: `controller-action:${matOSControllerDigest(withoutId)}`,
  } as MatOSControllerAction)
}

function actionIntentFromRecord(value: Record<string, unknown>): MatOSControllerActionIntent {
  switch (value.type) {
    case 'noop':
      return { type: 'noop', reason: value.reason as string }
    case 'rank-ready':
      return {
        type: 'rank-ready',
        orderedNodeRefs: value.orderedNodeRefs as readonly string[],
      }
    case 'propose-graph-patch':
      return {
        type: 'propose-graph-patch',
        candidate: value.candidate as MatOSControllerGraphPatchCandidate,
        reason: value.reason as string,
      }
    case 'request-validation':
      return {
        type: 'request-validation',
        validationRef: value.validationRef as string,
        targetRefs: value.targetRefs as readonly string[],
        reason: value.reason as string,
      }
    case 'request-human':
      return {
        type: 'request-human',
        promptRef: value.promptRef as string,
        reason: value.reason as string,
      }
    case 'pause':
      return {
        type: 'pause',
        reason: value.reason as string,
        ...(value.resumeConditionRef
          ? { resumeConditionRef: value.resumeConditionRef as string }
          : {}),
      }
    case 'stop-request':
      return {
        type: 'stop-request',
        status: value.status as 'completed' | 'failed' | 'cancelled',
        reason: value.reason as string,
      }
    case 'recovery-request':
      return {
        type: 'recovery-request',
        checkpointRef: value.checkpointRef as string,
        mode: value.mode as 'restore' | 'reconcile',
        reason: value.reason as string,
      }
    default:
      protocolError(
        'invalid-action',
        `unsupported controller action ${String(value.type)}`,
      )
  }
}

export function sanitizeMatOSControllerAction(
  value: unknown,
  observation: MatOSControllerObservation,
): MatOSControllerAction {
  if (!isRecord(value)) {
    protocolError('invalid-action', 'controller action must be an object')
  }
  if (value.schemaVersion !== MATOS_CONTROLLER_ACTION_SCHEMA_VERSION) {
    protocolError('invalid-action', 'unsupported controller action schema')
  }
  const cas = value.cas
  if (!isRecord(cas)) {
    protocolError('invalid-action', 'controller action CAS is required')
  }
  if (value.scopeRef !== observation.scopeRef) {
    protocolError('scope-mismatch', 'controller action scopeRef does not match')
  }
  if (value.runRef !== observation.runRef) {
    protocolError('run-mismatch', 'controller action runRef does not match')
  }
  if (
    cas.expectedObservationDigest !== observation.observationDigest ||
    cas.expectedEventCursor !== observation.eventCursor ||
    cas.expectedManifestDigest !== observation.manifest.digest ||
    cas.expectedGraphDigest !== observation.graph.digest ||
    cas.expectedGraphVersion !== observation.graph.version
  ) {
    protocolError(
      'action-cas-mismatch',
      'controller action CAS does not match the current observation',
    )
  }
  const withoutId = actionWithoutId({
    observation,
    seed: value.seed as number,
    budgetUsage: parseBudgetUsage(value.budgetUsage, 'budgetUsage'),
    intent: actionIntentFromRecord(value),
  })
  const expectedActionId = `controller-action:${matOSControllerDigest(withoutId)}`
  if (value.actionId !== expectedActionId) {
    protocolError('invalid-action', 'controller action digest is invalid')
  }
  return freezeMatOSControllerValue({
    ...withoutId,
    actionId: expectedActionId,
  } as MatOSControllerAction)
}

export type MatOSControllerPinnedProvider = Readonly<{
  controllerId: string
  providerId: string
  providerVersion: string
  stateVersion: number
  configDigest: string
  implementationDigest: string
  assetRef?: string
  runtimeRef?: string
}>

export type MatOSControllerInitializeInput = Readonly<{
  runRef: string
  definitionRef: string
  objectiveRef: string
  scopeRef: string
  manifest: MatOSControllerManifestCas
  budget: MatOSControllerBudgetSnapshot
  bounds: MatOSControllerSearchBounds
  seed: number
}>

export type MatOSControllerProposalContext = Readonly<{
  observation: MatOSControllerObservation
  bounds: MatOSControllerSearchBounds
  seed: number
}>

export type MatOSControllerFinalizeResult = Readonly<{
  summaryRef?: string
  outcomeRefs: readonly string[]
}>

export type MatOSRunController<State> = Readonly<{
  id: string
  version: string
  stateVersion: number
  initialize: (
    input: MatOSControllerInitializeInput,
  ) => State | Promise<State>
  observe: (
    state: Readonly<State>,
    observation: MatOSControllerObservation,
  ) => State | Promise<State>
  propose: (
    state: Readonly<State>,
    context: MatOSControllerProposalContext,
  ) => readonly MatOSControllerAction[] | Promise<readonly MatOSControllerAction[]>
  finalize?: (
    state: Readonly<State>,
  ) => MatOSControllerFinalizeResult | Promise<MatOSControllerFinalizeResult>
  serializeState?: (state: Readonly<State>) => MatOSControllerJsonValue
  restoreState?: (
    value: MatOSControllerJsonValue,
    storedStateVersion: number,
  ) => State
}>

export type MatOSControllerSearchEvaluation = Readonly<{
  score: number
  costUsd?: number
  terminal?: boolean
}>

export type MatOSControllerSearchStepContext = Readonly<{
  observation: MatOSControllerObservation
  seed: number
  depth: number
  iteration: number
  candidateIndex: number
}>

export type MatOSPureControllerSearch<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
> = Readonly<{
  initialState: (observation: MatOSControllerObservation) => State
  candidates: (
    state: Readonly<State>,
    context: MatOSControllerSearchStepContext,
  ) => readonly Candidate[]
  transition: (
    state: Readonly<State>,
    candidate: Readonly<Candidate>,
    context: MatOSControllerSearchStepContext,
  ) => State
  evaluate: (
    state: Readonly<State>,
    context: MatOSControllerSearchStepContext,
  ) => number | MatOSControllerSearchEvaluation
  isTerminal?: (
    state: Readonly<State>,
    context: MatOSControllerSearchStepContext,
  ) => boolean
  stateKey?: (state: Readonly<State>) => string
  candidateKey?: (candidate: Readonly<Candidate>) => string
  actionForSelection: (input: {
    candidate: Readonly<Candidate>
    path: readonly Readonly<Candidate>[]
    state: Readonly<State>
    score: number
    observation: MatOSControllerObservation
  }) => MatOSControllerActionIntent
}>

export type MatOSControllerSearchStopReason =
  | 'selected'
  | 'no-candidates'
  | 'terminal'
  | 'candidate-limit'
  | 'depth-limit'
  | 'time-limit'
  | 'cost-limit'
  | 'iteration-limit'

export type MatOSControllerSearchResult<
  State extends MatOSControllerJsonValue,
  Candidate extends MatOSControllerJsonValue,
> = Readonly<{
  selectedCandidate?: Readonly<Candidate>
  selectedPath: readonly Readonly<Candidate>[]
  selectedState?: Readonly<State>
  score?: number
  usage: MatOSControllerBudgetUsage
  stopReason: MatOSControllerSearchStopReason
  visitedStateKeys: readonly string[]
}>

export type MatOSControllerSearchClock = () => number
