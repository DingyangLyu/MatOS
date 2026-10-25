import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runMatOSBenchmarkCase } from './benchmarkRunner.js'

const runReal =
  process.env.MATOS_RUN_REAL_LLM_TESTS === '1' &&
  process.env.MATOS_RUN_REAL_BENCHMARKS === '1' &&
  Boolean(process.env.DEEPSEEK_API_KEY)

describe.skipIf(!runReal)('MatOS real benchmark runner', () => {
  test(
    'runs a V2 matos-run benchmark through the existing MatOS runtime',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-real-benchmark-'))
      const casePath = join(root, 'case.json')
      await writeFile(
        casePath,
        `${JSON.stringify(
          {
            schemaVersion: 2,
            id: 'real-matos-run-smoke',
            kind: 'matos-run',
            task: {
              role: 'compute',
              prompt: 'Reply with exactly: benchmark-ok',
              maxTurns: 1,
            },
            checks: [{ type: 'stdout-contains', value: 'benchmark-ok' }],
            costRisk: 'cheap',
            approvalPolicy: 'bypass-safe',
            timeoutMs: 90000,
          },
          null,
          2,
        )}\n`,
      )

      const result = await runMatOSBenchmarkCase({
        cwd: root,
        benchmarkRef: 'benchmark:real-matos-run-smoke@0.1.0',
        casePath,
      })

      expect(result.status).toBe('succeeded')
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result)).not.toContain('AUTH_TOKEN')
    },
    120_000,
  )
})
