import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  parseMatOSEvolutionWorkerArgs,
  runMatOSEvolutionWorker,
} from './matos-evolution-worker.js'

const WORKER_ENV_KEYS = [
  'NODE_ENV',
  'MATOS_BENCHMARK_MODE',
  'MATOS_DISABLE_EVOLUTION',
  'MATOS_DISABLE_EVOLUTION_WORKER',
  'MATOS_DISABLE_EVOLUTION_JOBS',
  'MATOS_DISABLE_REFLECTION_FORK',
  'MATOS_DISABLE_SELF_EVOLUTION',
  'MATOS_DISABLE_ALWAYS_ON_LEARNING',
  'MATOS_EVOLUTION_PROVIDER',
] as const

async function withWorkerEnv(
  env: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const key of WORKER_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }
  // Keep the hidden pipeline inert even when the worker itself proceeds.
  process.env.NODE_ENV = 'test'
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('MatOS evolution worker entrypoint', () => {
  test('parses semantic candidate session triggers with their source event id', () => {
    const parsed = parseMatOSEvolutionWorkerArgs([
      'session-trigger',
      '--cwd',
      '/tmp/example',
      '--session-id',
      'session-1',
      '--session-path',
      '/tmp/example/session.jsonl',
      '--trigger-kind',
      'user-feedback',
      '--trigger-key',
      'user-feedback:turn-1',
      '--summary',
      'Potential user feedback candidate.',
      '--event-id',
      'turn-1',
      '--semantic-candidate',
    ])
    expect(parsed).toMatchObject({
      mode: 'session-trigger',
      triggerKind: 'user-feedback',
      triggerKey: 'user-feedback:turn-1',
      eventId: 'turn-1',
      semanticCandidate: true,
    })
  })

  test('parses plain session triggers without candidate markers', () => {
    const parsed = parseMatOSEvolutionWorkerArgs([
      'session-trigger',
      '--cwd',
      '/tmp/example',
      '--session-id',
      'session-1',
      '--session-path',
      '/tmp/example/session.jsonl',
      '--trigger-kind',
      'tool-failure',
      '--trigger-key',
      'tool-failure:Bash:fp:1',
      '--summary',
      'Tool failed.',
    ])
    expect(parsed).toMatchObject({
      mode: 'session-trigger',
      triggerKind: 'tool-failure',
      semanticCandidate: false,
    })
  })

  test('rechecks evolution enablement in-process before running the pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-worker-recheck-'))
    const sessionPath = join(root, 'session.jsonl')
    await writeFile(sessionPath, '', 'utf8')
    const parsed = parseMatOSEvolutionWorkerArgs([
      'session-close',
      '--cwd',
      root,
      '--session-id',
      'session-1',
      '--session-path',
      sessionPath,
    ])

    await withWorkerEnv({ MATOS_EVOLUTION_PROVIDER: 'disabled' }, async () => {
      expect(await runMatOSEvolutionWorker(parsed)).toBe(false)
    })
    await withWorkerEnv({ MATOS_DISABLE_EVOLUTION: '1' }, async () => {
      expect(await runMatOSEvolutionWorker(parsed)).toBe(false)
    })
    await withWorkerEnv({}, async () => {
      expect(await runMatOSEvolutionWorker(parsed)).toBe(true)
    })
  })
})
