import { afterEach, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { createMatOSEvolutionAlgorithmRuntime } from './evolutionAlgorithmRuntime.js'
import { matOSEvolutionPolicySurface } from '../algorithms/surfaces/evolutionPolicy.js'
import type { MatOSEvolutionObservation } from '../algorithms/evolution/protocol.js'

const roots: string[] = []
const env = { MATOS_ALGO_TELEMETRY: '0', MATOS_ALGO_CAPTURE: '0' }
const observed: MatOSEvolutionObservation = {
  schemaVersion: 1,
  phase: 'observed',
  trigger: { kind: 'user-feedback', key: 'test' },
  constraints: { canAnalyze: true, canEdit: true, maxSignals: 2 },
  signals: [],
}
afterEach(async () => {
  matOSEvolutionPolicySurface.unregister('runtime-test')
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test('algorithm binding survives resume and rejects changed implementations', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-algorithm-' })
  roots.push(cwd)
  const algorithm = await createMatOSEvolutionAlgorithmRuntime({ cwd, env })
  await algorithm.decide(observed)
  const journal = algorithm.journal()
  const resumed = await createMatOSEvolutionAlgorithmRuntime({
    cwd,
    env: { ...env, MATOS_ALGO_EVOLUTION_POLICY: 'baseline' },
    journal,
  })
  expect(resumed.journal()).toEqual(journal)
  await expect(
    createMatOSEvolutionAlgorithmRuntime({
      cwd,
      env,
      journal: {
        ...journal,
        binding: { ...journal.binding, version: 'changed' },
      },
    }),
  ).rejects.toThrow('changed')
})

test('strategy failure defers instead of broadening to the baseline editor', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-algorithm-' })
  roots.push(cwd)
  matOSEvolutionPolicySurface.register({
    id: 'runtime-test',
    version: '1',
    decide: () => {
      throw new Error('broken strategy')
    },
  })
  const algorithm = await createMatOSEvolutionAlgorithmRuntime({
    cwd,
    env: { ...env, MATOS_ALGO_EVOLUTION_POLICY: 'runtime-test' },
  })
  expect((await algorithm.decide(observed)).action).toBe('defer')
  expect(algorithm.journal().decisions[0]?.fallback).toBe('provider-error')
})

test('real executable policy assets stay scoped and cannot cross native gates', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-algorithm-asset-' })
  roots.push(cwd)
  const assetRoot = join(cwd, '.matos/alice/policy')
  await mkdir(assetRoot, { recursive: true })
  await writeFile(
    join(assetRoot, 'asset.json'),
    JSON.stringify({
      schemaVersion: 1,
      type: 'tool',
      id: 'evolution-test',
      version: '1.0.0',
      name: 'Policy',
      entry: './strategy.cjs',
      metadata: {
        algorithmSurface: 'evolution-policy',
        decisionProtocol: 'json-v1',
      },
    }),
  )
  await writeFile(
    join(assetRoot, 'strategy.cjs'),
    "process.stdout.write(JSON.stringify({decision:{action:'retain',signalIds:['foreign']}}))\n",
  )
  await writeFile(
    join(cwd, '.matos/matos.json'),
    JSON.stringify({
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'local',
          id: 'alice',
          scope: 'user',
          scopeRef: 'user:alice',
          path: 'alice',
        },
        {
          type: 'git',
          id: 'bob',
          scope: 'user',
          scopeRef: 'user:bob',
          repo: '/nonexistent-must-not-be-cloned.git',
        },
      ],
    }),
  )
  const selectedEnv = {
    ...env,
    PATH: process.env.PATH,
    MATOS_ALGO_EVOLUTION_POLICY: 'asset:tool:evolution-test@1.0.0',
  }
  const algorithm = await createMatOSEvolutionAlgorithmRuntime({
    cwd,
    scopeRef: 'user:alice',
    env: selectedEnv,
  })
  expect((await algorithm.decide(observed)).action).toBe('defer')
  expect(algorithm.journal().decisions[0]).not.toHaveProperty('fallback')
  expect(
    (
      await algorithm.decide({
        ...observed,
        phase: 'evaluated',
        candidate: { nativeGatesPassed: false },
      })
    ).action,
  ).toBe('reject')
  await expect(
    createMatOSEvolutionAlgorithmRuntime({
      cwd,
      scopeRef: 'user:charlie',
      env: selectedEnv,
    }),
  ).rejects.toThrow('current scope')
  await writeFile(join(assetRoot, 'strategy.cjs'), 'process.exit(1)\n')
  await expect(
    createMatOSEvolutionAlgorithmRuntime({
      cwd,
      scopeRef: 'user:alice',
      env: selectedEnv,
      journal: algorithm.journal(),
    }),
  ).rejects.toThrow('changed')
})
