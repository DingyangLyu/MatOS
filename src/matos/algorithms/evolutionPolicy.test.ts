import { afterEach, expect, test } from 'bun:test'
import { matOSEvolutionPolicySurface } from './surfaces/evolutionPolicy.js'
import type { MatOSEvolutionObservation } from './evolution/protocol.js'
import { serializeMatOSAlgorithmInput } from './serialization.js'

const observation: MatOSEvolutionObservation = {
  schemaVersion: 1,
  phase: 'analyzed',
  trigger: { kind: 'tool-failure', key: 'tool-failure:submit:abc:1' },
  constraints: { canAnalyze: true, canEdit: true, maxSignals: 2 },
  signals: [
    {
      id: 'weak',
      confidence: 0.55,
      evidenceSupport: 'partially_supported',
      risk: 'low',
      targetTypes: ['knowledge'],
    },
    {
      id: 'strong',
      confidence: 0.95,
      evidenceSupport: 'supported',
      risk: 'low',
      targetTypes: ['tool'],
    },
  ],
}
const env = { MATOS_ALGO_TELEMETRY: '0', MATOS_ALGO_CAPTURE: '0' }
afterEach(() => {
  matOSEvolutionPolicySurface.unregister('test-policy')
})

test('versioned strategies can change learning decisions without changing the pipeline', () => {
  const baseline = matOSEvolutionPolicySurface.decideSync(observation, {
    providerId: 'baseline',
    env,
  })
  const candidate = matOSEvolutionPolicySurface.decideSync(observation, {
    providerId: 'evidence-first',
    env,
  })
  expect(baseline.decision.signalIds).toEqual(['weak', 'strong'])
  expect(candidate.decision.signalIds).toEqual(['strong'])
  expect(
    matOSEvolutionPolicySurface.resolve({ providerId: 'evidence-first', env })
      .provider.version,
  ).toBe('1.0.0')
})

test('a strategy cannot invent signals or bypass the host edit gate', () => {
  matOSEvolutionPolicySurface.register({
    id: 'test-policy',
    decide: () => ({ action: 'edit', signalIds: ['foreign', 'strong'] }),
  })
  const allowed = matOSEvolutionPolicySurface.decideSync(observation, {
    providerId: 'test-policy',
    env,
  })
  expect(allowed.decision.signalIds).toEqual(['strong'])
  const denied = matOSEvolutionPolicySurface.decideSync(
    {
      ...observation,
      constraints: { ...observation.constraints, canEdit: false },
    },
    { providerId: 'test-policy', env },
  )
  expect(denied.decision.action).toBe('defer')
  expect(denied.decision.signalIds).toEqual([])
})

test('a strategy cannot skip the critic or weaken native candidate rejection', () => {
  matOSEvolutionPolicySurface.register({
    id: 'test-policy',
    decide: () => ({ action: 'retain', signalIds: ['strong'] }),
  })
  expect(
    matOSEvolutionPolicySurface.decideSync(
      { ...observation, phase: 'observed' },
      { providerId: 'test-policy', env },
    ).decision.action,
  ).toBe('defer')
  expect(
    matOSEvolutionPolicySurface.decideSync(
      {
        ...observation,
        phase: 'evaluated',
        candidate: { nativeGatesPassed: false },
      },
      { providerId: 'test-policy', env },
    ).decision.action,
  ).toBe('reject')
})

test('strategy input serialization excludes environment and runtime handles', () => {
  const input = serializeMatOSAlgorithmInput('evolution-policy', {
    ...observation,
    env: { PRIVATE_KEY: 'not-for-algorithms' },
    registry: { secret: 'hidden' },
  })
  expect(input?.phase).toBe('analyzed')
  expect(input).not.toHaveProperty('env')
  expect(input).not.toHaveProperty('registry')
})
