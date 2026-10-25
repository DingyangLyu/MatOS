import { describe, expect, test } from 'bun:test'
import { normalizeMatOSBenchmarkCase } from './benchmarkSchema.js'

describe('MatOS benchmark schema V2', () => {
  test('normalizes V1 static-json cases for backwards compatibility', () => {
    const normalized = normalizeMatOSBenchmarkCase({
      id: 'legacy-static',
      kind: 'static-json',
      expect: { contains: 'stable' },
    })

    expect(normalized).toMatchObject({
      schemaVersion: 1,
      id: 'legacy-static',
      kind: 'static-json',
      costRisk: 'free',
      approvalPolicy: 'bypass-safe',
    })
  })

  test('accepts V2 matos-run cases with deterministic checks', () => {
    const normalized = normalizeMatOSBenchmarkCase({
      schemaVersion: 2,
      id: 'compute-dry-run',
      kind: 'matos-run',
      subjectRefs: ['role:compute'],
      task: {
        role: 'compute',
        prompt: 'Return exactly benchmark-ok.',
        maxTurns: 1,
      },
      checks: [
        { type: 'stdout-contains', value: 'benchmark-ok' },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'cheap',
      approvalPolicy: 'bypass-safe',
      timeoutMs: 120000,
    })

    expect(normalized.kind).toBe('matos-run')
    expect(normalized.subjectRefs).toEqual(['role:compute'])
    expect(normalized.checks.map(check => check.type)).toEqual([
      'stdout-contains',
      'secret-scan',
    ])
    expect(normalized.timeoutMs).toBe(120000)
  })

  test('task env only keeps MATOS_ALGO_* selection keys', () => {
    const normalized = normalizeMatOSBenchmarkCase({
      schemaVersion: 2,
      id: 'algo-e2e-selection',
      kind: 'matos-run',
      task: {
        role: 'compute',
        prompt: 'Return exactly benchmark-ok.',
        env: {
          MATOS_ALGO_CONTEXT_RANKING: 'baseline-configurable',
          MATOS_ALGO_CONTEXT_RANKING_CONFIG: '{"multipliers":{"usage":0}}',
          ANTHROPIC_MODEL: 'evil-model-override',
          OPENAI_API_KEY: 'stolen',
          PATH: '/tmp',
        },
      },
    })
    expect(normalized.task?.env).toEqual({
      MATOS_ALGO_CONTEXT_RANKING: 'baseline-configurable',
      MATOS_ALGO_CONTEXT_RANKING_CONFIG: '{"multipliers":{"usage":0}}',
    })
  })

  test('accepts algo-compare cases as free offline benchmarks', () => {
    const normalized = normalizeMatOSBenchmarkCase({
      schemaVersion: 2,
      id: 'algo-compare-smoke',
      kind: 'algo-compare',
      algo: {
        dataset: './dataset.json',
        providers: ['baseline'],
      },
    })
    expect(normalized.kind).toBe('algo-compare')
    expect(normalized.costRisk).toBe('free')
  })

  test('rejects command benchmarks without trusted approval policy', () => {
    expect(() =>
      normalizeMatOSBenchmarkCase({
        schemaVersion: 2,
        id: 'unsafe-command',
        kind: 'command',
        command: 'env',
        approvalPolicy: 'bypass-safe',
      }),
    ).toThrow('Command benchmark requires trusted approval policy')
  })

  test('rejects unsupported V2 benchmark kinds', () => {
    expect(() =>
      normalizeMatOSBenchmarkCase({
        schemaVersion: 2,
        id: 'unsupported',
        kind: 'browser-click',
      }),
    ).toThrow('Unsupported MatOS benchmark kind: browser-click')
  })
})
