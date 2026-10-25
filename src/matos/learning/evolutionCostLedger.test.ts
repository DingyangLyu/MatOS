import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { buildMatOSEvolutionCostReport } from './evolutionCostLedger.js'

const USAGE = {
  input_tokens: 100,
  output_tokens: 10,
  cache_creation_input_tokens: 5,
  cache_read_input_tokens: 20,
}

describe('MatOS evolution cost ledger', () => {
  test('does not double-count semantic acceptance usage replayed from cache hits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-cost-ledger-'))
    const runsDir = join(root, '.matos', 'evolution', 'direct-editor', 'runs')
    const writeRun = async (name: string, run: unknown) => {
      const dir = join(runsDir, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'run.json'), JSON.stringify(run), 'utf8')
    }
    await writeRun('run-fresh', {
      runId: 'run-fresh',
      createdAt: '2026-07-01T00:00:00.000Z',
      usage: USAGE,
      totalCostUsd: 0.01,
      semanticAcceptance: {
        verdict: 'accept',
        usage: USAGE,
        totalCostUsd: 0.002,
        cache: { key: 'semantic-1', hit: false },
      },
    })
    // Second run replayed the same verdict from cache: identical usage
    // numbers, but no tokens were actually spent by this run's judge stage.
    await writeRun('run-replayed', {
      runId: 'run-replayed',
      createdAt: '2026-07-02T00:00:00.000Z',
      usage: USAGE,
      totalCostUsd: 0.01,
      semanticAcceptance: {
        verdict: 'accept',
        usage: USAGE,
        totalCostUsd: 0.002,
        cache: { key: 'semantic-1', hit: true },
      },
    })
    const report = await buildMatOSEvolutionCostReport({ cwd: root })
    const judgeRecords = report.records.filter(
      record => record.source === 'semantic-acceptance',
    )
    expect(judgeRecords).toHaveLength(1)
    expect(judgeRecords[0]?.runId).toBe('run-fresh')
    // Two editor runs plus one fresh judge run.
    expect(report.totals.recordCount).toBe(3)
    expect(report.totals.totalCostUsd).toBeCloseTo(0.022, 9)
    expect(report.byStage['semantic-acceptance-judge']?.recordCount).toBe(1)
  })

  test('still counts semantic acceptance usage for verdicts without cache metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-cost-legacy-'))
    const dir = join(
      root,
      '.matos',
      'evolution',
      'direct-editor',
      'runs',
      'run-legacy',
    )
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'run.json'),
      JSON.stringify({
        runId: 'run-legacy',
        createdAt: '2026-07-03T00:00:00.000Z',
        semanticAcceptance: { verdict: 'accept', usage: USAGE },
      }),
      'utf8',
    )
    const report = await buildMatOSEvolutionCostReport({ cwd: root })
    expect(
      report.records.filter(record => record.source === 'semantic-acceptance'),
    ).toHaveLength(1)
  })
})
