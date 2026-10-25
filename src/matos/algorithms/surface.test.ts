import { afterEach, describe, expect, test } from 'bun:test'
import {
  createMatOSAlgorithmSurface,
  getMatOSAlgorithmSurface,
  listMatOSAlgorithmSurfaces,
} from './surface.js'
import {
  clearMatOSAlgorithmDecisionLog,
  recentMatOSAlgorithmDecisions,
} from './telemetry.js'

type TestInput = { value: number }
type TestDecision = { doubled: number }

let surfaceCounter = 0

function makeSurface(options: {
  sanitize?: (decision: TestDecision, input: TestInput) => TestDecision
  timeoutMs?: number
  circuitBreaker?: { failureThreshold: number; cooldownMs: number }
} = {}) {
  surfaceCounter += 1
  return createMatOSAlgorithmSurface<TestInput, TestDecision>({
    surfaceId: `test-surface-${surfaceCounter}`,
    envVar: 'MATOS_ALGO_TEST_SURFACE',
    baseline: {
      decide: input => ({ doubled: input.value * 2 }),
    },
    ...(options.sanitize ? { sanitizeDecision: options.sanitize } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.circuitBreaker
      ? { circuitBreaker: options.circuitBreaker }
      : {}),
  })
}

afterEach(() => {
  clearMatOSAlgorithmDecisionLog()
})

describe('createMatOSAlgorithmSurface', () => {
  test('baseline is the default provider and produces original behavior', () => {
    const surface = makeSurface()
    const result = surface.decideSync({ value: 21 }, { env: {} })
    expect(result.decision).toEqual({ doubled: 42 })
    expect(result.providerId).toBe('baseline')
    expect(result.source).toBe('default')
    expect(result.fallback).toBeUndefined()
  })

  test('provider selection priority: explicit > env > role > default', () => {
    const surface = makeSurface()
    surface.register({ id: 'from-env', decide: () => ({ doubled: -1 }) })
    surface.register({ id: 'from-role', decide: () => ({ doubled: -2 }) })
    surface.register({ id: 'from-explicit', decide: () => ({ doubled: -3 }) })

    const env = { MATOS_ALGO_TEST_SURFACE: 'from-env' }
    const roleAlgorithms = {
      [surface.surfaceId]: 'from-role',
    }

    expect(
      surface.decideSync(
        { value: 1 },
        { providerId: 'from-explicit', env, roleAlgorithms },
      ).providerId,
    ).toBe('from-explicit')
    expect(
      surface.decideSync({ value: 1 }, { env, roleAlgorithms }).providerId,
    ).toBe('from-env')
    expect(
      surface.decideSync({ value: 1 }, { env: {}, roleAlgorithms }).providerId,
    ).toBe('from-role')
    expect(surface.decideSync({ value: 1 }, { env: {} }).providerId).toBe(
      'baseline',
    )
  })

  test('registry-local provider overrides take precedence over global providers', () => {
    const surface = makeSurface()
    surface.register({ id: 'scoped', decide: () => ({ doubled: -1 }) })
    const providerOverrides = new Map([
      [
        'scoped',
        { id: 'scoped', decide: () => ({ doubled: 99 }) },
      ],
    ])
    const result = surface.decideSync(
      { value: 1 },
      {
        env: { MATOS_ALGO_TEST_SURFACE: 'scoped' },
        providerOverrides,
      },
    )
    expect(result.providerId).toBe('scoped')
    expect(result.decision).toEqual({ doubled: 99 })
  })

  test('unknown provider id falls back to baseline and reports the request', () => {
    const surface = makeSurface()
    const result = surface.decideSync(
      { value: 2 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'does-not-exist' } },
    )
    expect(result.decision).toEqual({ doubled: 4 })
    expect(result.providerId).toBe('baseline')
    expect(result.fallback).toBe('unknown-provider')
    const record = recentMatOSAlgorithmDecisions(1)[0]
    expect(record.requested).toBe('does-not-exist')
  })

  test('custom provider errors fall back to baseline decision', () => {
    const surface = makeSurface()
    surface.register({
      id: 'throws',
      decide: () => {
        throw new Error('research strategy exploded')
      },
    })
    const result = surface.decideSync(
      { value: 3 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'throws' } },
    )
    expect(result.decision).toEqual({ doubled: 6 })
    expect(result.fallback).toBe('provider-error')
  })

  test('circuit breaker makes repeated degradation explicit and recovers after cooldown', async () => {
    const surface = makeSurface({
      circuitBreaker: { failureThreshold: 2, cooldownMs: 20 },
    })
    let calls = 0
    surface.register({
      id: 'always-fails',
      decide: () => {
        calls += 1
        throw new Error('failure')
      },
    })
    const context = { env: { MATOS_ALGO_TEST_SURFACE: 'always-fails' } }
    expect(surface.decideSync({ value: 1 }, context).fallback).toBe(
      'provider-error',
    )
    expect(surface.decideSync({ value: 1 }, context).fallback).toBe(
      'provider-error',
    )
    expect(surface.decideSync({ value: 1 }, context).fallback).toBe(
      'circuit-open',
    )
    expect(calls).toBe(2)
    expect(recentMatOSAlgorithmDecisions(1)[0]?.fallback).toBe('circuit-open')

    await new Promise(resolve => setTimeout(resolve, 25))
    expect(surface.decideSync({ value: 1 }, context).fallback).toBe(
      'provider-error',
    )
    expect(calls).toBe(3)
  })

  test('async provider on sync call site falls back to baseline', () => {
    const surface = makeSurface()
    surface.register({
      id: 'async-only',
      decide: async () => ({ doubled: -1 }),
    })
    const result = surface.decideSync(
      { value: 4 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'async-only' } },
    )
    expect(result.decision).toEqual({ doubled: 8 })
    expect(result.fallback).toBe('async-not-supported')
  })

  test('undefined decision falls back to baseline', () => {
    const surface = makeSurface()
    surface.register({ id: 'empty', decide: () => undefined })
    const result = surface.decideSync(
      { value: 5 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'empty' } },
    )
    expect(result.decision).toEqual({ doubled: 10 })
    expect(result.fallback).toBe('empty-decision')
  })

  test('sanitizeDecision clamps custom decisions but not baseline', () => {
    const surface = makeSurface({
      sanitize: (decision, input) => ({
        doubled: Math.max(decision.doubled, input.value * 2),
      }),
    })
    surface.register({ id: 'lowball', decide: () => ({ doubled: 0 }) })
    const custom = surface.decideSync(
      { value: 6 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'lowball' } },
    )
    expect(custom.decision).toEqual({ doubled: 12 })
    const baseline = surface.decideSync({ value: 6 }, { env: {} })
    expect(baseline.decision).toEqual({ doubled: 12 })
  })

  test('async decide supports promise providers and times out to baseline', async () => {
    const surface = makeSurface({ timeoutMs: 30 })
    surface.register({
      id: 'slow',
      decide: () =>
        new Promise(resolve =>
          setTimeout(() => resolve({ doubled: -1 }), 200),
        ),
    })
    surface.register({
      id: 'fast-async',
      decide: async input => ({ doubled: input.value * 10 }),
    })
    const slow = await surface.decide(
      { value: 7 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'slow' } },
    )
    expect(slow.decision).toEqual({ doubled: 14 })
    expect(slow.fallback).toBe('timeout')
    const fast = await surface.decide(
      { value: 7 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'fast-async' } },
    )
    expect(fast.decision).toEqual({ doubled: 70 })
    expect(fast.fallback).toBeUndefined()
  })

  test('baseline provider cannot be replaced', () => {
    const surface = makeSurface()
    expect(() =>
      surface.register({ id: 'baseline', decide: () => ({ doubled: -1 }) }),
    ).toThrow()
  })

  test('provider identities are complete and duplicate ids cannot hot-replace code', () => {
    const surface = makeSurface()
    const original = { id: 'stable-provider', decide: () => ({ doubled: 10 }) }
    surface.register(original)

    const baseline = surface.resolve({ env: {} }).provider
    const registered = surface.resolve({
      env: { MATOS_ALGO_TEST_SURFACE: 'stable-provider' },
    }).provider
    for (const provider of [baseline, registered]) {
      expect(provider.version).toBeTruthy()
      expect(provider.configDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(provider.implementationDigest).toMatch(/^[a-f0-9]{64}$/)
    }

    expect(() =>
      surface.register({
        id: 'STABLE-PROVIDER',
        decide: () => ({ doubled: 99 }),
      }),
    ).toThrow(/already registered/)
    expect(
      surface.decideSync(
        { value: 1 },
        { env: { MATOS_ALGO_TEST_SURFACE: 'stable-provider' } },
      ).decision,
    ).toEqual({ doubled: 10 })
  })

  test('custom providers can be unregistered without affecting baseline', () => {
    const surface = makeSurface()
    surface.register({ id: 'temporary', decide: () => ({ doubled: -1 }) })
    expect(surface.unregister('temporary')).toBe(true)
    expect(surface.unregister('baseline')).toBe(false)
    const result = surface.decideSync(
      { value: 2 },
      { env: { MATOS_ALGO_TEST_SURFACE: 'temporary' } },
    )
    expect(result.providerId).toBe('baseline')
    expect(result.fallback).toBe('unknown-provider')
    expect(result.decision).toEqual({ doubled: 4 })
  })

  test('decisions are recorded in the in-memory telemetry ring', () => {
    const surface = makeSurface()
    clearMatOSAlgorithmDecisionLog()
    surface.decideSync({ value: 8 }, { env: {} })
    const records = recentMatOSAlgorithmDecisions()
    expect(records.length).toBe(1)
    expect(records[0].surfaceId).toBe(surface.surfaceId)
    expect(records[0].providerId).toBe('baseline')
    expect(records[0].source).toBe('default')
    expect(records[0].latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('surfaces register into the global surface list', () => {
    const surface = makeSurface()
    expect(
      listMatOSAlgorithmSurfaces().some(
        item => item.surfaceId === surface.surfaceId,
      ),
    ).toBe(true)
    expect(getMatOSAlgorithmSurface(surface.surfaceId)).toBeDefined()
  })
})
