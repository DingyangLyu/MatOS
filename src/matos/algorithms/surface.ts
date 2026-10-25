import { createHash, randomUUID } from 'node:crypto'
import {
  captureMatOSAlgorithmDecision,
  matOSAlgorithmCaptureEnabled,
} from './capture.js'
import {
  matOSAlgorithmTelemetryEnabled,
  recordMatOSAlgorithmDecision,
  type MatOSAlgorithmDecisionFallback,
  type MatOSAlgorithmProviderSource,
} from './telemetry.js'
import { traceContextFromEnv, type MatOSTraceContext } from '../sessions/traceContext.js'
import {
  currentMatOSWorkflowExecutionContext,
  type MatOSWorkflowExecutionContext,
} from '../workflows/executionContext.js'
import { recordMatOSAlgorithmRunDecisionReference } from './runDecisionRefs.js'
import { serializeMatOSAlgorithmInput } from './serialization.js'

/**
 * Generic pluggable decision surface for the MatOS Algorithm Layer.
 *
 * Design contract:
 * - The baseline provider wraps today's exact logic and is selected by default;
 *   with no overrides, surface output is byte-identical to the pre-surface code.
 * - Custom provider failures (throw, timeout, undefined, async on a sync call
 *   site) fall back to the baseline decision and never break the caller.
 * - Custom decisions pass through `sanitizeDecision`, which enforces
 *   surface-specific invariants (e.g. approval can only tighten).
 */

export type MatOSAlgorithmEnvironment = Record<string, string | undefined>

export type MatOSAlgorithmProvider<TInput, TDecision> = {
  id: string
  description?: string
  /** Stable implementation identity recorded in a run-level manifest. */
  version?: string
  assetRef?: string
  configDigest?: string
  implementationDigest?: string
  /** Resolves behavior-affecting config for this selection without exposing it. */
  configDigestFor?: (context: {
    env: MatOSAlgorithmEnvironment
    roleAlgorithms?: unknown
  }) => string
  decide: (
    input: TInput,
  ) => TDecision | undefined | Promise<TDecision | undefined>
}

export type MatOSAlgorithmResolvedProvider<TInput, TDecision> =
  MatOSAlgorithmProvider<TInput, TDecision> & {
    version: string
    configDigest: string
    implementationDigest: string
  }

/**
 * Per-decision provider overrides. Asset-backed strategies use this map so a
 * runtime composition is bound to the registry/scope that produced it rather
 * than whichever global provider happened to register most recently.
 */
export type MatOSAlgorithmProviderOverrides = ReadonlyMap<
  string,
  MatOSAlgorithmProvider<unknown, unknown>
>

export type MatOSAlgorithmSelectionContext = {
  /** Explicit provider override (compare commands, experiments). */
  providerId?: string
  env?: MatOSAlgorithmEnvironment
  /** `role.runtime.algorithms` payload from the active role asset. */
  roleAlgorithms?: unknown
  /** Registry/scope-local providers, keyed by normalized provider id. */
  providerOverrides?: MatOSAlgorithmProviderOverrides
  /** Project cwd for the telemetry ledger; defaults to process.cwd(). */
  cwd?: string
  /** Optional causal context for decision -> outcome attribution. */
  trace?: MatOSTraceContext
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
  /** Explicit counterfactual provider; never affects the applied decision. */
  shadowProviderId?: string
  /** Internal manifest writer escape hatch; normal callers must honor pins. */
  ignoreExecutionPin?: boolean
}

export type MatOSAlgorithmResolution<TInput, TDecision> = {
  provider: MatOSAlgorithmResolvedProvider<TInput, TDecision>
  source: MatOSAlgorithmProviderSource
  /** Set when a requested provider id did not resolve to a registered one. */
  requested?: string
}

export type MatOSAlgorithmDecisionOutcome<TDecision> = {
  decisionId: string
  decision: TDecision
  providerId: string
  source: MatOSAlgorithmProviderSource
  fallback?: MatOSAlgorithmDecisionFallback
}

export type MatOSAlgorithmSurfaceOptions<TInput, TDecision> = {
  surfaceId: string
  envVar: string
  /** Wraps today's exact logic. Must be synchronous and total. */
  baseline: {
    description?: string
    version?: string
    implementationDigest?: string
    decide: (input: TInput) => TDecision
  }
  /** Safety clamp applied to custom-provider decisions only, never to baseline. */
  sanitizeDecision?: (decision: TDecision, input: TInput) => TDecision
  inputDigest?: (input: TInput) => string
  decisionSummary?: (
    decision: TDecision,
    input: TInput,
  ) => Record<string, unknown>
  /** Async provider timeout for decide(); defaults to 2000ms. */
  timeoutMs?: number
  /** Consecutive custom-provider failures before a bounded cooldown. */
  circuitBreaker?: {
    failureThreshold?: number
    cooldownMs?: number
  }
}

export type MatOSAlgorithmSurface<TInput, TDecision> = {
  surfaceId: string
  envVar: string
  shadowEnvVar: string
  baselineProviderId: string
  register: (provider: MatOSAlgorithmProvider<TInput, TDecision>) => void
  unregister: (providerId: string) => boolean
  listProviderIds: () => string[]
  describeProviders: () => Array<{ id: string; description?: string }>
  resolve: (
    ctx?: MatOSAlgorithmSelectionContext,
  ) => MatOSAlgorithmResolution<TInput, TDecision>
  resolveShadow: (
    ctx?: MatOSAlgorithmSelectionContext,
  ) => MatOSAlgorithmResolution<TInput, TDecision> | undefined
  /** Synchronous decision for sync call sites (role composition, approval). */
  decideSync: (
    input: TInput,
    ctx?: MatOSAlgorithmSelectionContext,
  ) => MatOSAlgorithmDecisionOutcome<TDecision>
  /** Async decision; additionally supports promise-returning providers. */
  decide: (
    input: TInput,
    ctx?: MatOSAlgorithmSelectionContext,
  ) => Promise<MatOSAlgorithmDecisionOutcome<TDecision>>
}

export const MATOS_ALGORITHM_BASELINE_PROVIDER_ID = 'baseline'

const DEFAULT_ASYNC_TIMEOUT_MS = 2000
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000

const surfaces = new Map<string, MatOSAlgorithmSurface<unknown, unknown>>()
const MAX_CONCURRENT_SHADOW_DECISIONS = 2
const MAX_PENDING_SHADOW_DECISIONS = 64
const MAX_PENDING_SHADOW_DECISIONS_PER_RUN = 8

export type MatOSAlgorithmShadowLifecycleEvent = Readonly<{
  type: 'dropped' | 'terminal-drained'
  at: string
  runDir?: string
  runId?: string
  surfaceId?: string
  providerId?: string
  primaryDecisionId?: string
  reason?:
    | 'serialization-failed'
    | 'resolution-failed'
    | 'per-run-capacity'
    | 'global-capacity'
  pendingForRun: number
  pendingTotal: number
  maxPendingForRun: number
  maxPendingTotal: number
}>

export type MatOSAlgorithmShadowQueueSnapshot = Readonly<{
  runDir?: string
  pendingForRun: number
  queuedForRun: number
  pendingTotal: number
  activeTotal: number
  queuedTotal: number
  maxPendingForRun: number
  maxPendingTotal: number
}>

type ShadowLifecycleObserver = (
  event: MatOSAlgorithmShadowLifecycleEvent,
) => void | Promise<void>

type ShadowRunState = {
  runDir?: string
  runId?: string
  pending: number
  terminalAwaitingRefresh: boolean
  terminalRefreshEmitted: boolean
  waiters: Set<() => void>
}

type ShadowQueueItem = {
  runKey: string
  execute: () => Promise<void>
}

const shadowLifecycleObservers = new Map<string, ShadowLifecycleObserver>()
const shadowRunStates = new Map<string, ShadowRunState>()
const terminalShadowRunKeys = new Set<string>()
const shadowQueue: ShadowQueueItem[] = []
const shadowLifecycleWork = new Set<Promise<void>>()
let activeShadowDecisions = 0
let pendingShadowDecisions = 0

function shadowRunKey(execution?: MatOSWorkflowExecutionContext): string {
  return execution?.runDir ?? '__global__'
}

function shadowState(
  runKey: string,
  execution?: MatOSWorkflowExecutionContext,
): ShadowRunState {
  const existing = shadowRunStates.get(runKey)
  if (existing) return existing
  const created: ShadowRunState = {
    ...(execution?.runDir ? { runDir: execution.runDir } : {}),
    ...(execution?.runId ? { runId: execution.runId } : {}),
    pending: 0,
    terminalAwaitingRefresh: terminalShadowRunKeys.has(runKey),
    terminalRefreshEmitted: false,
    waiters: new Set(),
  }
  shadowRunStates.set(runKey, created)
  return created
}

function emitShadowLifecycle(
  event: MatOSAlgorithmShadowLifecycleEvent,
): void {
  for (const observer of shadowLifecycleObservers.values()) {
    let work!: Promise<void>
    work = new Promise<void>(resolveWork => {
      const immediate = setImmediate(() => {
        Promise.resolve(observer(event))
          .catch(() => undefined)
          .finally(resolveWork)
      })
      immediate.unref?.()
    }).finally(() => shadowLifecycleWork.delete(work))
    shadowLifecycleWork.add(work)
  }
}

function shadowLifecycleEvent(input: {
  type: MatOSAlgorithmShadowLifecycleEvent['type']
  state: ShadowRunState
  surfaceId?: string
  providerId?: string
  primaryDecisionId?: string
  reason?: MatOSAlgorithmShadowLifecycleEvent['reason']
}): MatOSAlgorithmShadowLifecycleEvent {
  return {
    type: input.type,
    at: new Date().toISOString(),
    ...(input.state.runDir ? { runDir: input.state.runDir } : {}),
    ...(input.state.runId ? { runId: input.state.runId } : {}),
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.primaryDecisionId
      ? { primaryDecisionId: input.primaryDecisionId }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    pendingForRun: input.state.pending,
    pendingTotal: pendingShadowDecisions,
    maxPendingForRun: MAX_PENDING_SHADOW_DECISIONS_PER_RUN,
    maxPendingTotal: MAX_PENDING_SHADOW_DECISIONS,
  }
}

function settleShadowRun(runKey: string): void {
  const state = shadowRunStates.get(runKey)
  if (!state) return
  if (
    state.pending === 0 &&
    state.terminalAwaitingRefresh &&
    !state.terminalRefreshEmitted
  ) {
    state.terminalRefreshEmitted = true
    emitShadowLifecycle(
      shadowLifecycleEvent({ type: 'terminal-drained', state }),
    )
  }
  if (state.pending === 0) {
    for (const resolveWaiter of state.waiters) resolveWaiter()
    state.waiters.clear()
    shadowRunStates.delete(runKey)
  }
}

function pumpShadowQueue(): void {
  while (
    activeShadowDecisions < MAX_CONCURRENT_SHADOW_DECISIONS &&
    shadowQueue.length > 0
  ) {
    const item = shadowQueue.shift()!
    activeShadowDecisions += 1
    const immediate = setImmediate(() => {
      void item
        .execute()
        .catch(() => undefined)
        .finally(() => {
          activeShadowDecisions -= 1
          pendingShadowDecisions -= 1
          const state = shadowRunStates.get(item.runKey)
          if (state) state.pending -= 1
          settleShadowRun(item.runKey)
          pumpShadowQueue()
        })
    })
    immediate.unref?.()
  }
}

export function registerMatOSAlgorithmShadowLifecycleObserver(
  name: string,
  observer: ShadowLifecycleObserver,
): () => void {
  shadowLifecycleObservers.set(name, observer)
  return () => {
    if (shadowLifecycleObservers.get(name) === observer) {
      shadowLifecycleObservers.delete(name)
    }
  }
}

export function noteMatOSAlgorithmRunTerminal(runDir: string): void {
  terminalShadowRunKeys.delete(runDir)
  terminalShadowRunKeys.add(runDir)
  while (terminalShadowRunKeys.size > 1_024) {
    terminalShadowRunKeys.delete(terminalShadowRunKeys.values().next().value!)
  }
  const state = shadowRunStates.get(runDir)
  if (state?.pending) state.terminalAwaitingRefresh = true
}

export function matOSAlgorithmShadowQueueSnapshot(
  runDir?: string,
): MatOSAlgorithmShadowQueueSnapshot {
  const state = runDir ? shadowRunStates.get(runDir) : undefined
  return {
    ...(runDir ? { runDir } : {}),
    pendingForRun: state?.pending ?? 0,
    queuedForRun: runDir
      ? shadowQueue.filter(item => item.runKey === runDir).length
      : 0,
    pendingTotal: pendingShadowDecisions,
    activeTotal: activeShadowDecisions,
    queuedTotal: shadowQueue.length,
    maxPendingForRun: MAX_PENDING_SHADOW_DECISIONS_PER_RUN,
    maxPendingTotal: MAX_PENDING_SHADOW_DECISIONS,
  }
}

export async function waitForMatOSAlgorithmRunShadowDecisions(
  runDir: string,
): Promise<void> {
  const state = shadowRunStates.get(runDir)
  if (state?.pending) {
    await new Promise<void>(resolveWaiter => state.waiters.add(resolveWaiter))
  }
  while (shadowLifecycleWork.size > 0) {
    await Promise.allSettled([...shadowLifecycleWork])
  }
}

/** Test/operator compatibility helper. Production terminal paths never call it. */
export async function flushMatOSAlgorithmShadowDecisions(): Promise<void> {
  while (pendingShadowDecisions > 0) {
    const states = [...shadowRunStates.values()].filter(state => state.pending > 0)
    await Promise.all(
      states.map(
        state =>
          new Promise<void>(resolveWaiter => state.waiters.add(resolveWaiter)),
      ),
    )
  }
  while (shadowLifecycleWork.size > 0) {
    await Promise.allSettled([...shadowLifecycleWork])
  }
}

function normalizedProviderId(value: string): string {
  return value.trim().toLowerCase()
}

function requestedRoleProviderId(
  roleAlgorithms: unknown,
  surfaceId: string,
): string | undefined {
  if (
    !roleAlgorithms ||
    typeof roleAlgorithms !== 'object' ||
    Array.isArray(roleAlgorithms)
  ) {
    return undefined
  }
  const value = (roleAlgorithms as Record<string, unknown>)[surfaceId]
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const provider = (value as Record<string, unknown>).provider
    return typeof provider === 'string' && provider.trim().length > 0
      ? provider.trim()
      : undefined
  }
  return undefined
}

function requestedRoleShadowProviderId(
  roleAlgorithms: unknown,
  surfaceId: string,
): string | undefined {
  if (
    !roleAlgorithms ||
    typeof roleAlgorithms !== 'object' ||
    Array.isArray(roleAlgorithms)
  ) {
    return undefined
  }
  const value = (roleAlgorithms as Record<string, unknown>)[surfaceId]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const shadow = (value as Record<string, unknown>).shadow
  return typeof shadow === 'string' && shadow.trim() ? shadow.trim() : undefined
}

export class MatOSAlgorithmPinnedProviderUnavailableError extends Error {
  readonly surfaceId: string
  readonly providerId: string

  constructor(surfaceId: string, providerId: string, reason: string) {
    super(
      `Pinned algorithm provider ${providerId} for ${surfaceId} is unavailable: ${reason}`,
    )
    this.name = 'MatOSAlgorithmPinnedProviderUnavailableError'
    this.surfaceId = surfaceId
    this.providerId = providerId
  }
}

export function createMatOSAlgorithmSurface<TInput, TDecision>(
  options: MatOSAlgorithmSurfaceOptions<TInput, TDecision>,
): MatOSAlgorithmSurface<TInput, TDecision> {
  const providers = new Map<
    string,
    MatOSAlgorithmResolvedProvider<TInput, TDecision>
  >()
  const providerHealth = new Map<
    string,
    { consecutiveFailures: number; openUntil: number }
  >()
  function functionSource(value: unknown): string {
    if (typeof value !== 'function') return ''
    try {
      return Function.prototype.toString.call(value)
    } catch {
      return '[unavailable]'
    }
  }

  function identityDigest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }

  function validDigest(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value)
  }

  function normalizeProvider(
    provider: MatOSAlgorithmProvider<TInput, TDecision>,
  ): MatOSAlgorithmResolvedProvider<TInput, TDecision> {
    const id = normalizedProviderId(provider.id)
    const version = provider.version?.trim() || '1.0.0'
    const configDigest =
      provider.configDigest ??
      identityDigest({
        kind: 'matos-algorithm-provider-config',
        surfaceId: options.surfaceId,
        providerId: id,
        version,
        config: null,
      })
    const implementationDigest =
      provider.implementationDigest ??
      identityDigest({
        kind: 'matos-algorithm-provider-implementation',
        surfaceId: options.surfaceId,
        providerId: id,
        version,
        decide: functionSource(provider.decide),
        configDigestFor: functionSource(provider.configDigestFor),
        sanitizeDecision: functionSource(options.sanitizeDecision),
      })
    if (!validDigest(configDigest) || !validDigest(implementationDigest)) {
      throw new Error(
        `MatOS algorithm provider ${id || '<missing>'} for ${options.surfaceId} must use sha256 config and implementation digests`,
      )
    }
    return {
      ...provider,
      id,
      version,
      configDigest,
      implementationDigest,
    }
  }

  function providerForContext(
    provider: MatOSAlgorithmProvider<TInput, TDecision>,
    ctx: MatOSAlgorithmSelectionContext,
  ): MatOSAlgorithmResolvedProvider<TInput, TDecision> {
    const normalized = normalizeProvider(provider)
    if (!normalized.configDigestFor) return normalized
    const configDigest = normalized.configDigestFor({
      env: ctx.env ?? process.env,
      roleAlgorithms: ctx.roleAlgorithms,
    })
    if (!validDigest(configDigest)) {
      throw new Error(
        `MatOS algorithm provider ${normalized.id} for ${options.surfaceId} resolved an invalid config digest`,
      )
    }
    return { ...normalized, configDigest }
  }

  const baselineProvider = normalizeProvider({
    id: MATOS_ALGORITHM_BASELINE_PROVIDER_ID,
    version: options.baseline.version,
    implementationDigest: options.baseline.implementationDigest,
    description:
      options.baseline.description ??
      'Default provider preserving the original MatOS behavior.',
    decide: options.baseline.decide,
  })
  providers.set(baselineProvider.id, baselineProvider)
  const shadowEnvVar = `${options.envVar}_SHADOW`

  const circuitFailureThreshold = Math.max(
    1,
    Math.trunc(
      options.circuitBreaker?.failureThreshold ??
        DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    ),
  )
  const circuitCooldownMs = Math.max(
    1,
    Math.trunc(
      options.circuitBreaker?.cooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS,
    ),
  )

  function circuitOpen(providerId: string): boolean {
    const state = providerHealth.get(normalizedProviderId(providerId))
    if (!state || state.openUntil <= 0) return false
    if (Date.now() >= state.openUntil) {
      providerHealth.set(normalizedProviderId(providerId), {
        consecutiveFailures: 0,
        openUntil: 0,
      })
      return false
    }
    return true
  }

  function noteProviderFailure(providerId: string): void {
    const id = normalizedProviderId(providerId)
    const previous = providerHealth.get(id)
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1
    providerHealth.set(id, {
      consecutiveFailures,
      openUntil:
        consecutiveFailures >= circuitFailureThreshold
          ? Date.now() + circuitCooldownMs
          : 0,
    })
  }

  function noteProviderSuccess(providerId: string): void {
    providerHealth.delete(normalizedProviderId(providerId))
  }

  function safeInputDigest(input: TInput): string | undefined {
    try {
      return options.inputDigest?.(input)
    } catch {
      return undefined
    }
  }

  function safeDecisionSummary(
    decision: TDecision,
    input: TInput,
  ): Record<string, unknown> | undefined {
    try {
      return options.decisionSummary?.(decision, input)
    } catch {
      return undefined
    }
  }

  function sanitize(decision: TDecision, input: TInput): TDecision {
    return options.sanitizeDecision
      ? options.sanitizeDecision(decision, input)
      : decision
  }

  function resolve(
    ctx: MatOSAlgorithmSelectionContext = {},
  ): MatOSAlgorithmResolution<TInput, TDecision> {
    const execution = currentMatOSWorkflowExecutionContext()
    const pin = ctx.ignoreExecutionPin
      ? undefined
      : execution?.algorithmSurfacePins?.get(options.surfaceId)
    if (pin) {
      const normalized = normalizedProviderId(pin.providerId)
      const registered =
        (ctx.providerOverrides?.get(normalized) as
          | MatOSAlgorithmProvider<TInput, TDecision>
          | undefined) ?? providers.get(normalized)
      if (!registered) {
        throw new MatOSAlgorithmPinnedProviderUnavailableError(
          options.surfaceId,
          pin.providerId,
          'the provider is no longer registered',
        )
      }
      const provider = providerForContext(registered, ctx)
      const identities: Array<
        [string, string | undefined, string | undefined]
      > = [
        ['version', pin.version, provider.version],
        ['assetRef', pin.assetRef, provider.assetRef],
        ['configDigest', pin.configDigest, provider.configDigest],
        [
          'implementationDigest',
          pin.implementationDigest,
          provider.implementationDigest,
        ],
      ]
      const mismatch = identities.find(
        ([, expected, actual]) => expected !== undefined && expected !== actual,
      )
      if (mismatch) {
        throw new MatOSAlgorithmPinnedProviderUnavailableError(
          options.surfaceId,
          pin.providerId,
          `${mismatch[0]} does not match the immutable run manifest (expected ${mismatch[1] ?? '<missing>'}, found ${mismatch[2] ?? '<missing>'})`,
        )
      }
      return {
        provider,
        source: pin.source,
        ...(pin.requested ? { requested: pin.requested } : {}),
      }
    }
    const env = ctx.env ?? process.env
    const candidates: Array<{
      id: string | undefined
      source: Exclude<MatOSAlgorithmProviderSource, 'shadow'>
    }> = [
      { id: ctx.providerId, source: 'explicit' },
      { id: env[options.envVar], source: 'env' },
      {
        id: requestedRoleProviderId(ctx.roleAlgorithms, options.surfaceId),
        source: 'role',
      },
    ]
    for (const candidate of candidates) {
      const requested = candidate.id?.trim()
      if (!requested) {
        continue
      }
      const normalized = normalizedProviderId(requested)
      const registered =
        (ctx.providerOverrides?.get(normalized) as
          | MatOSAlgorithmProvider<TInput, TDecision>
          | undefined) ?? providers.get(normalized)
      if (registered) {
        const provider = providerForContext(registered, ctx)
        return { provider, source: candidate.source }
      }
      // Unknown provider ids must never change runtime behavior silently:
      // fall back to baseline and surface the requested id in telemetry.
      return { provider: baselineProvider, source: 'default', requested }
    }
    return { provider: baselineProvider, source: 'default' }
  }

  function resolveShadow(
    ctx: MatOSAlgorithmSelectionContext = {},
  ): MatOSAlgorithmResolution<TInput, TDecision> | undefined {
    const execution = currentMatOSWorkflowExecutionContext()
    const surfacePin = ctx.ignoreExecutionPin
      ? undefined
      : execution?.algorithmSurfacePins?.get(options.surfaceId)
    const pinned = surfacePin?.shadow
    let requested: string | undefined
    let source: 'explicit' | 'env' | 'role'
    if (surfacePin) {
      if (!pinned) return undefined
      requested = pinned.providerId
      source = pinned.source
    } else {
      const env = ctx.env ?? process.env
      const candidates: Array<{
        id: string | undefined
        source: 'explicit' | 'env' | 'role'
      }> = [
        { id: ctx.shadowProviderId, source: 'explicit' },
        { id: env[shadowEnvVar], source: 'env' },
        {
          id: requestedRoleShadowProviderId(
            ctx.roleAlgorithms,
            options.surfaceId,
          ),
          source: 'role',
        },
      ]
      const selected = candidates.find(candidate => candidate.id?.trim())
      if (!selected) return undefined
      requested = selected.id?.trim()
      source = selected.source
    }
    const normalized = normalizedProviderId(requested as string)
    const registered =
      (ctx.providerOverrides?.get(normalized) as
        | MatOSAlgorithmProvider<TInput, TDecision>
        | undefined) ?? providers.get(normalized)
    if (!registered) {
      if (pinned) {
        throw new MatOSAlgorithmPinnedProviderUnavailableError(
          options.surfaceId,
          requested as string,
          'the pinned shadow provider is no longer registered',
        )
      }
      return undefined
    }
    const provider = providerForContext(registered, ctx)
    if (pinned) {
      const identities: Array<
        [string, string | undefined, string | undefined]
      > = [
        ['version', pinned.version, provider.version],
        ['assetRef', pinned.assetRef, provider.assetRef],
        ['configDigest', pinned.configDigest, provider.configDigest],
        [
          'implementationDigest',
          pinned.implementationDigest,
          provider.implementationDigest,
        ],
      ]
      const mismatch = identities.find(
        ([, expected, actual]) => expected !== undefined && expected !== actual,
      )
      if (mismatch) {
        throw new MatOSAlgorithmPinnedProviderUnavailableError(
          options.surfaceId,
          requested as string,
          `shadow ${mismatch[0]} does not match the immutable run manifest (expected ${mismatch[1] ?? '<missing>'}, found ${mismatch[2] ?? '<missing>'})`,
        )
      }
    }
    return { provider, source }
  }

  function record(input: {
    decisionId: string
    resolution: MatOSAlgorithmResolution<TInput, TDecision>
    decision: TDecision
    rawInput: TInput
    startedAt: number
    fallback?: MatOSAlgorithmDecisionFallback
    ctx: MatOSAlgorithmSelectionContext
    applied?: boolean
    shadowOfDecisionId?: string
    differsFromApplied?: boolean
    executionOverride?: MatOSWorkflowExecutionContext
  }): void {
    const summary = safeDecisionSummary(input.decision, input.rawInput)
    const digest = safeInputDigest(input.rawInput)
    const execution =
      input.executionOverride ?? currentMatOSWorkflowExecutionContext()
    const trace =
      input.ctx.trace ??
      traceContextFromEnv((input.ctx.env ?? process.env) as NodeJS.ProcessEnv)
    recordMatOSAlgorithmDecision(
      {
        schemaVersion: 1,
        decisionId: input.decisionId,
        at: new Date().toISOString(),
        surfaceId: options.surfaceId,
        providerId: input.resolution.provider.id,
        source: input.resolution.source,
        ...(input.resolution.requested
          ? { requested: input.resolution.requested }
          : {}),
        ...(input.fallback ? { fallback: input.fallback } : {}),
        latencyMs: Number((performance.now() - input.startedAt).toFixed(3)),
        ...(digest ? { inputDigest: digest } : {}),
        ...(summary ? { summary } : {}),
        ...(trace?.traceId ? { traceId: trace.traceId } : {}),
        ...(trace?.sessionId ? { sessionId: trace.sessionId } : {}),
        ...(input.ctx.workflowRunId ?? execution?.runId
          ? { workflowRunId: input.ctx.workflowRunId ?? execution?.runId }
          : {}),
        ...(input.ctx.workflowNodeId ?? execution?.workflowNodeId
          ? {
              workflowNodeId:
                input.ctx.workflowNodeId ?? execution?.workflowNodeId,
            }
          : {}),
        ...(input.ctx.attempt ?? execution?.attempt
          ? { attempt: input.ctx.attempt ?? execution?.attempt }
          : {}),
        ...(trace?.scopeRef ?? execution?.scopeRef
          ? { scopeRef: trace?.scopeRef ?? execution?.scopeRef }
          : {}),
        ...(input.applied !== undefined ? { applied: input.applied } : {}),
        ...(input.shadowOfDecisionId
          ? { shadowOfDecisionId: input.shadowOfDecisionId }
          : {}),
        ...(input.differsFromApplied !== undefined
          ? { differsFromApplied: input.differsFromApplied }
          : {}),
      },
      { cwd: input.ctx.cwd, env: input.ctx.env },
    )
    if (
      input.applied !== false &&
      matOSAlgorithmCaptureEnabled(input.ctx.env ?? process.env)
    ) {
      captureMatOSAlgorithmDecision({
        cwd: input.ctx.cwd ?? process.cwd(),
        decisionId: input.decisionId,
        surfaceId: options.surfaceId,
        providerId: input.resolution.provider.id,
        ...(digest ? { inputDigest: digest } : {}),
        rawInput: input.rawInput,
        decision: input.decision,
        ...(trace?.traceId ? { traceId: trace.traceId } : {}),
        ...(trace?.sessionId ? { sessionId: trace.sessionId } : {}),
        ...(input.ctx.workflowRunId ?? execution?.runId
          ? { workflowRunId: input.ctx.workflowRunId ?? execution?.runId }
          : {}),
        ...(input.ctx.workflowNodeId ?? execution?.workflowNodeId
          ? {
              workflowNodeId:
                input.ctx.workflowNodeId ?? execution?.workflowNodeId,
            }
          : {}),
        ...(input.ctx.attempt ?? execution?.attempt
          ? { attempt: input.ctx.attempt ?? execution?.attempt }
          : {}),
        ...(trace?.scopeRef ?? execution?.scopeRef
          ? { scopeRef: trace?.scopeRef ?? execution?.scopeRef }
          : {}),
      })
    }
    if (execution) {
      recordMatOSAlgorithmRunDecisionReference(execution.runDir, {
        schemaVersion: 1,
        decisionId: input.decisionId,
        at: new Date().toISOString(),
        runId: execution.runId,
        ...(execution.workflowNodeId ? { nodeId: execution.workflowNodeId } : {}),
        ...(execution.attempt !== undefined ? { attempt: execution.attempt } : {}),
        surfaceId: options.surfaceId,
        providerId: input.resolution.provider.id,
        source: input.resolution.source,
        ...(input.fallback ? { fallback: input.fallback } : {}),
        ...(digest ? { inputDigest: digest } : {}),
        ...(input.applied !== undefined ? { applied: input.applied } : {}),
        ...(input.shadowOfDecisionId
          ? { shadowOfDecisionId: input.shadowOfDecisionId }
          : {}),
        ...(input.differsFromApplied !== undefined
          ? { differsFromApplied: input.differsFromApplied }
          : {}),
      })
    }
  }

  function decisionsDiffer(left: TDecision, right: TDecision): boolean {
    try {
      return JSON.stringify(left) !== JSON.stringify(right)
    } catch {
      return true
    }
  }

  function scheduleShadowDecision(
    rawInput: TInput,
    primary: MatOSAlgorithmDecisionOutcome<TDecision>,
    ctx: MatOSAlgorithmSelectionContext,
  ): void {
    const env = ctx.env ?? process.env
    if (!matOSAlgorithmTelemetryEnabled(env)) return
    const execution = currentMatOSWorkflowExecutionContext()
    const runKey = shadowRunKey(execution)
    let selected: MatOSAlgorithmResolution<TInput, TDecision> | undefined
    try {
      selected = resolveShadow(ctx)
    } catch {
      const state = shadowState(runKey, execution)
      emitShadowLifecycle(
        shadowLifecycleEvent({
          type: 'dropped',
          state,
          surfaceId: options.surfaceId,
          primaryDecisionId: primary.decisionId,
          reason: 'resolution-failed',
        }),
      )
      if (state.pending === 0) shadowRunStates.delete(runKey)
      return
    }
    if (!selected || selected.provider.id === primary.providerId) return
    const state = shadowState(runKey, execution)
    const serialized = serializeMatOSAlgorithmInput(options.surfaceId, rawInput)
    if (!serialized) {
      emitShadowLifecycle(
        shadowLifecycleEvent({
          type: 'dropped',
          state,
          surfaceId: options.surfaceId,
          providerId: selected.provider.id,
          primaryDecisionId: primary.decisionId,
          reason: 'serialization-failed',
        }),
      )
      if (state.pending === 0) shadowRunStates.delete(runKey)
      return
    }
    const capacityReason =
      state.pending >= MAX_PENDING_SHADOW_DECISIONS_PER_RUN
        ? 'per-run-capacity'
        : pendingShadowDecisions >= MAX_PENDING_SHADOW_DECISIONS
          ? 'global-capacity'
          : undefined
    if (capacityReason) {
      emitShadowLifecycle(
        shadowLifecycleEvent({
          type: 'dropped',
          state,
          surfaceId: options.surfaceId,
          providerId: selected.provider.id,
          primaryDecisionId: primary.decisionId,
          reason: capacityReason,
        }),
      )
      if (state.pending === 0) shadowRunStates.delete(runKey)
      return
    }
    state.pending += 1
    pendingShadowDecisions += 1
    if (state.terminalRefreshEmitted) {
      state.terminalRefreshEmitted = false
      state.terminalAwaitingRefresh = true
    }
    shadowQueue.push({
      runKey,
      execute: async () => {
        try {
          const decisionId = randomUUID()
          const startedAt = performance.now()
          let decision = primary.decision
          let fallback: MatOSAlgorithmDecisionFallback | undefined
          try {
            const timedOut = Symbol('matos-algorithm-shadow-timeout')
            let timer: ReturnType<typeof setTimeout> | undefined
            const raw = await Promise.race([
              Promise.resolve(selected?.provider.decide(serialized as TInput)),
              new Promise<typeof timedOut>(resolveTimeout => {
                timer = setTimeout(
                  () => resolveTimeout(timedOut),
                  options.timeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS,
                )
                timer.unref?.()
              }),
            ]).finally(() => {
              if (timer) clearTimeout(timer)
            })
            if (raw === timedOut) fallback = 'timeout'
            else if (raw === undefined) fallback = 'empty-decision'
            else decision = sanitize(raw as TDecision, rawInput)
          } catch {
            fallback = 'provider-error'
          }
          record({
            decisionId,
            resolution: {
              provider: selected!.provider,
              source: 'shadow',
            },
            decision,
            rawInput,
            startedAt,
            ...(fallback ? { fallback } : {}),
            ctx,
            applied: false,
            shadowOfDecisionId: primary.decisionId,
            differsFromApplied: fallback
              ? false
              : decisionsDiffer(primary.decision, decision),
            executionOverride: execution,
          })
        } catch {
          // Shadow execution is counterfactual evidence only. Provider and
          // telemetry failures never escape into the active workflow path.
        }
      },
    })
    pumpShadowQueue()
  }

  function outcome(input: {
    decisionId: string
    resolution: MatOSAlgorithmResolution<TInput, TDecision>
    decision: TDecision
    fallback?: MatOSAlgorithmDecisionFallback
  }): MatOSAlgorithmDecisionOutcome<TDecision> {
    return {
      decisionId: input.decisionId,
      decision: input.decision,
      providerId: input.resolution.provider.id,
      source: input.resolution.source,
      ...(input.fallback ? { fallback: input.fallback } : {}),
    }
  }

  function decideSync(
    input: TInput,
    ctx: MatOSAlgorithmSelectionContext = {},
  ): MatOSAlgorithmDecisionOutcome<TDecision> {
    const decisionId = randomUUID()
    const startedAt = performance.now()
    const resolution = resolve(ctx)
    if (resolution.provider.id === baselineProvider.id) {
      // Baseline runs unwrapped: errors propagate exactly as the original
      // pre-surface code path did.
      const decision = options.baseline.decide(input)
      const fallback = resolution.requested ? 'unknown-provider' : undefined
      record({ decisionId, resolution, decision, rawInput: input, startedAt, fallback, ctx })
      const result = outcome({ decisionId, resolution, decision, fallback })
      scheduleShadowDecision(input, result, ctx)
      return result
    }
    if (circuitOpen(resolution.provider.id)) {
      const decision = options.baseline.decide(input)
      const fallback: MatOSAlgorithmDecisionFallback = 'circuit-open'
      record({ decisionId, resolution, decision, rawInput: input, startedAt, fallback, ctx })
      const result = outcome({ decisionId, resolution, decision, fallback })
      scheduleShadowDecision(input, result, ctx)
      return result
    }
    let decision: TDecision
    let fallback: MatOSAlgorithmDecisionFallback | undefined
    try {
      const raw = resolution.provider.decide(input)
      if (
        raw &&
        typeof (raw as PromiseLike<unknown>).then === 'function'
      ) {
        fallback = 'async-not-supported'
        decision = options.baseline.decide(input)
      } else if (raw === undefined) {
        fallback = 'empty-decision'
        decision = options.baseline.decide(input)
      } else {
        decision = sanitize(raw as TDecision, input)
      }
    } catch {
      fallback = 'provider-error'
      decision = options.baseline.decide(input)
    }
    if (fallback) noteProviderFailure(resolution.provider.id)
    else noteProviderSuccess(resolution.provider.id)
    record({ decisionId, resolution, decision, rawInput: input, startedAt, fallback, ctx })
    const result = outcome({ decisionId, resolution, decision, fallback })
    scheduleShadowDecision(input, result, ctx)
    return result
  }

  async function decide(
    input: TInput,
    ctx: MatOSAlgorithmSelectionContext = {},
  ): Promise<MatOSAlgorithmDecisionOutcome<TDecision>> {
    const decisionId = randomUUID()
    const startedAt = performance.now()
    const resolution = resolve(ctx)
    if (resolution.provider.id === baselineProvider.id) {
      const decision = options.baseline.decide(input)
      const fallback = resolution.requested ? 'unknown-provider' : undefined
      record({ decisionId, resolution, decision, rawInput: input, startedAt, fallback, ctx })
      const result = outcome({ decisionId, resolution, decision, fallback })
      scheduleShadowDecision(input, result, ctx)
      return result
    }
    if (circuitOpen(resolution.provider.id)) {
      const decision = options.baseline.decide(input)
      const fallback: MatOSAlgorithmDecisionFallback = 'circuit-open'
      record({ decisionId, resolution, decision, rawInput: input, startedAt, fallback, ctx })
      const result = outcome({ decisionId, resolution, decision, fallback })
      scheduleShadowDecision(input, result, ctx)
      return result
    }
    let decision: TDecision
    let fallback: MatOSAlgorithmDecisionFallback | undefined
    try {
      const timeoutMs = options.timeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS
      const timedOut = Symbol('matos-algorithm-timeout')
      let timer: ReturnType<typeof setTimeout> | undefined
      const raw = await Promise.race([
        Promise.resolve(resolution.provider.decide(input)),
        new Promise<typeof timedOut>(resolveTimeout => {
          timer = setTimeout(() => resolveTimeout(timedOut), timeoutMs)
          timer.unref?.()
        }),
      ]).finally(() => {
        if (timer) {
          clearTimeout(timer)
        }
      })
      if (raw === timedOut) {
        fallback = 'timeout'
        decision = options.baseline.decide(input)
      } else if (raw === undefined) {
        fallback = 'empty-decision'
        decision = options.baseline.decide(input)
      } else {
        decision = sanitize(raw as TDecision, input)
      }
    } catch {
      fallback = 'provider-error'
      decision = options.baseline.decide(input)
    }
    if (fallback) noteProviderFailure(resolution.provider.id)
    else noteProviderSuccess(resolution.provider.id)
    record({ decisionId, resolution, decision, rawInput: input, startedAt, fallback, ctx })
    const result = outcome({ decisionId, resolution, decision, fallback })
    scheduleShadowDecision(input, result, ctx)
    return result
  }

  const surface: MatOSAlgorithmSurface<TInput, TDecision> = {
    surfaceId: options.surfaceId,
    envVar: options.envVar,
    shadowEnvVar,
    baselineProviderId: baselineProvider.id,
    register: provider => {
      const id = normalizedProviderId(provider.id)
      if (!id) {
        throw new Error(
          `MatOS algorithm provider id is required for surface ${options.surfaceId}`,
        )
      }
      if (id === baselineProvider.id) {
        throw new Error(
          `MatOS algorithm surface ${options.surfaceId} baseline provider cannot be replaced`,
        )
      }
      if (providers.has(id)) {
        throw new Error(
          `MatOS algorithm provider ${id} is already registered for surface ${options.surfaceId}`,
        )
      }
      providerHealth.delete(id)
      providers.set(id, normalizeProvider({ ...provider, id }))
    },
    unregister: providerId => {
      const id = normalizedProviderId(providerId)
      if (!id || id === baselineProvider.id) {
        return false
      }
      providerHealth.delete(id)
      return providers.delete(id)
    },
    listProviderIds: () => [...providers.keys()].sort(),
    describeProviders: () =>
      [...providers.values()]
        .map(provider => ({
          id: provider.id,
          ...(provider.description
            ? { description: provider.description }
            : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    resolve,
    resolveShadow,
    decideSync,
    decide,
  }

  surfaces.set(options.surfaceId, surface as MatOSAlgorithmSurface<unknown, unknown>)
  return surface
}

export function listMatOSAlgorithmSurfaces(): Array<
  MatOSAlgorithmSurface<unknown, unknown>
> {
  return [...surfaces.values()].sort((a, b) =>
    a.surfaceId.localeCompare(b.surfaceId),
  )
}

export function getMatOSAlgorithmSurface(
  surfaceId: string,
): MatOSAlgorithmSurface<unknown, unknown> | undefined {
  return surfaces.get(surfaceId)
}
