import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordEvolutionUsage,
  parseEvolutionUsageFile,
  incrementalEvolutionResult,
} from './evolutionUsage.js'

describe('evolution usage journal', () => {
  test('shared stages retain turn-local usage but delta cumulative costs and model usage', () => {
    const prior = {
      totalCostUsd: 0.4,
      modelUsage: {
        model: { inputTokens: 100, outputTokens: 20, costUSD: 0.4 },
      },
    }
    const result = {
      usage: { input_tokens: 3 },
      totalCostUsd: 0.5,
      modelUsage: {
        model: { inputTokens: 103, outputTokens: 25, costUSD: 0.5 },
      },
    }
    const delta = incrementalEvolutionResult(result, prior)
    expect(delta.usage.input_tokens).toBe(3)
    expect(delta.totalCostUsd).toBeCloseTo(0.1)
    expect(delta.modelUsage.model).toMatchObject({
      inputTokens: 3,
      outputTokens: 5,
    })
    expect(result.modelUsage.model.inputTokens).toBe(103)
  })
  test('persists numeric usage without secrets and never charges a local cache hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usage-evolution-'))
    const input = {
      cwd: root,
      stage: 'critic',
      env: { MATOS_SESSION_DIR: root },
      result: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          api_key: 'must-not-persist',
        },
        modelUsage: {
          'deepseek-flash': { inputTokens: 9999, outputTokens: 9999 },
        },
        upstreamSessionId: 's',
      },
    }
    await recordEvolutionUsage(input)
    await recordEvolutionUsage({
      ...input,
      result: { ...input.result, cache: { hit: true } },
    })
    const dir = join(root, 'usage/evolution')
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    const raw = await readFile(join(dir, names[0]!), 'utf8')
    expect(raw).not.toContain('must-not-persist')
    expect(parseEvolutionUsageFile(names[0]!, raw)[0]).toMatchObject({
      journal: true,
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  })
  test('does not pretend a redacted judge usage is zero consumption', () => {
    const rows = parseEvolutionUsageFile(
      '/runs/r/run.json',
      JSON.stringify({
        runId: 'r',
        createdAt: '2026-09-01',
        semanticAcceptance: {
          usage: { input_tokens: '[redacted]', output_tokens: '[redacted]' },
        },
      }),
    )
    expect(
      rows.find((r) => r.stage === 'semantic-acceptance-judge')?.unavailable,
    ).toBe(true)
  })
})
