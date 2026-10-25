import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSEvent } from '../sessions/eventTypes.js'
import {
  listMatOSSelfEvolutionMonitorRecords,
  runMatOSSelfEvolutionForSession,
  type MatOSSelfEvolutionTrigger,
} from './evolutionMonitor.js'
import type { MatOSUserFeedbackAnalyzer } from './userFeedbackSignals.js'
import {
  MATOS_EVOLUTION_BUDGET_EXHAUSTED_SKIP_STATUS,
  MATOS_EVOLUTION_DAILY_BUDGET_DEFAULT_USD,
  accumulateMatOSEvolutionSpendItems,
  gateMatOSEvolutionDailyBudget,
  readMatOSEvolutionDailySpend,
  resolveMatOSEvolutionDailyBudgetUsd,
  matOSEvolutionSpendItemsFromMonitorRecord,
} from './evolutionBudgetGate.js'

function feedbackTrigger(key = 'user-feedback:turn-budget-1'): MatOSSelfEvolutionTrigger {
  return {
    kind: 'user-feedback',
    key,
    eventId: 'turn-budget-1',
    summary: 'User feedback should be analyzed.',
  }
}

function sessionEvent(
  sessionId: string,
  id: string,
  type: MatOSEvent['type'],
  data: Record<string, unknown>,
): MatOSEvent {
  return {
    id,
    schemaVersion: 1,
    traceId: `trace-${sessionId}`,
    sessionId,
    timestamp: '2026-08-12T00:00:00.000Z',
    roleRef: 'role:compute',
    type,
    data,
  }
}

async function writeSession(
  root: string,
  sessionId: string,
  events: MatOSEvent[],
): Promise<string> {
  const dir = join(root, '.matos', 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(
    path,
    events.map(event => JSON.stringify(event)).join('\n') + '\n',
    'utf8',
  )
  return path
}

describe('MatOS evolution daily budget gate', () => {
  test('multiple critic invocations keep their own paid-session identities', () => {
    const items = matOSEvolutionSpendItemsFromMonitorRecord({
      recordId: 'monitor', sessionId: 'user-session', triggerKind: 'user-feedback', triggerKey: 'feedback',
      status: 'detected', summary: '', createdAt: '2026-09-14', updatedAt: '2026-09-14',
      llmDiagnostics: [
        { stage: 'user-feedback-critic', roleReference: 'role:user-feedback-critic', exitCode: 0, parsedResultPresent: true, normalizedAnalysisPresent: true, upstreamSessionId: 'paid-one', totalCostUsd: 0.1 },
        { stage: 'user-feedback-critic', roleReference: 'role:user-feedback-critic', exitCode: 0, parsedResultPresent: true, normalizedAnalysisPresent: true, upstreamSessionId: 'paid-two', totalCostUsd: 0.2 },
      ],
    })
    expect(items.map(i => i.id)).toEqual(['user-feedback-critic:paid-one', 'user-feedback-critic:paid-two'])
  })
  test('paid stage replay is idempotent and later token increments are retained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-budget-idempotent-'))
    const now = new Date('2026-09-14T10:00:00Z')
    const item = { id: 'critic:paid-session', stage: 'critic', costUsd: 0.5, tokens: 100 }
    await accumulateMatOSEvolutionSpendItems({ cwd: root, items: [item, item], now })
    await accumulateMatOSEvolutionSpendItems({ cwd: root, items: [item], now })
    await accumulateMatOSEvolutionSpendItems({ cwd: root, items: [{ ...item, tokens: 120 }], now })
    expect(await readMatOSEvolutionDailySpend({ cwd: root, now })).toMatchObject({ totalCostUsd: 0.5, totalTokens: 120, recordCount: 1 })
    const tomorrow = new Date('2026-09-15T10:00:00Z')
    await accumulateMatOSEvolutionSpendItems({ cwd: root, items: [item], now: tomorrow })
    expect((await readMatOSEvolutionDailySpend({ cwd: root, now: tomorrow })).totalTokens).toBe(0)
  })
  test('parses the budget env knob with default and disable values', () => {
    expect(resolveMatOSEvolutionDailyBudgetUsd(undefined)).toMatchObject({
      disabled: false,
      budgetUsd: MATOS_EVOLUTION_DAILY_BUDGET_DEFAULT_USD,
    })
    expect(
      resolveMatOSEvolutionDailyBudgetUsd({ MATOS_EVOLUTION_DAILY_BUDGET_USD: '12.5' }),
    ).toMatchObject({ disabled: false, budgetUsd: 12.5 })
    for (const value of ['0', 'off', 'unlimited']) {
      expect(
        resolveMatOSEvolutionDailyBudgetUsd({
          MATOS_EVOLUTION_DAILY_BUDGET_USD: value,
        }).disabled,
      ).toBe(true)
    }
  })

  test('accumulates spend items into the daily ledger and reads them back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-budget-ledger-'))
    try {
      const now = new Date('2026-08-12T10:00:00.000Z')
      await accumulateMatOSEvolutionSpendItems({
        cwd: root,
        items: [
          { stage: 'critic', costUsd: 0.5, tokens: 1000 },
          { stage: 'judge', costUsd: 0.25, tokens: 400 },
        ],
        now,
      })
      await accumulateMatOSEvolutionSpendItems({
        cwd: root,
        items: [{ stage: 'critic', costUsd: 0.25, tokens: 600 }],
        now,
      })
      const spend = await readMatOSEvolutionDailySpend({ cwd: root, now })
      expect(spend.totalCostUsd).toBeCloseTo(1.0, 5)
      expect(spend.totalTokens).toBe(2000)
      // Another day is isolated.
      const other = await readMatOSEvolutionDailySpend({
        cwd: root,
        now: new Date('2026-08-13T10:00:00.000Z'),
      })
      expect(other.totalCostUsd).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('blocks the hidden pipeline when the daily budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-budget-block-'))
    try {
      await accumulateMatOSEvolutionSpendItems({
        cwd: root,
        items: [{ stage: 'critic', costUsd: 5, tokens: 100 }],
      })
      let criticCalls = 0
      const analyzer: MatOSUserFeedbackAnalyzer = async () => {
        criticCalls += 1
        return undefined
      }
      const sessionId = 'session-budget-1'
      const sessionPath = await writeSession(root, sessionId, [
        sessionEvent(sessionId, 'turn-budget-1', 'matos.turn.started', {
          prompt: '又报错了，修一下这个提交脚本',
        }),
      ])
      const records = await runMatOSSelfEvolutionForSession(
        {
          cwd: root,
          sessionId,
          sessionPath,
          trigger: feedbackTrigger(),
        },
        {
          feedbackAnalyzer: analyzer,
          env: {
            NODE_ENV: 'test',
            MATOS_SCOPE_ID: 'core',
            MATOS_EVOLUTION_DAILY_BUDGET_USD: '1',
          },
        },
      )
      expect(criticCalls).toBe(0)
      expect(records?.some(r => r.status === MATOS_EVOLUTION_BUDGET_EXHAUSTED_SKIP_STATUS)).toBe(
        true,
      )
      const written = await listMatOSSelfEvolutionMonitorRecords(root)
      expect(
        written.filter(r => r.status === MATOS_EVOLUTION_BUDGET_EXHAUSTED_SKIP_STATUS),
      ).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('manual-evolve triggers bypass the gate with a warning record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-budget-manual-'))
    try {
      await accumulateMatOSEvolutionSpendItems({
        cwd: root,
        items: [{ stage: 'critic', costUsd: 5, tokens: 100 }],
      })
      const result = await gateMatOSEvolutionDailyBudget({
        cwd: root,
        sessionId: 'session-manual',
        trigger: {
          kind: 'manual-evolve',
          key: 'manual-evolve:session-manual:req-1',
          summary: 'Operator requested evolution.',
        },
        stage: 'pipeline-entry',
        env: { MATOS_EVOLUTION_DAILY_BUDGET_USD: '1' },
      })
      expect(result.blocked).toBe(false)
      expect(result.warningRecord?.budgetWarning).toContain('daily-budget-exceeded')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a disabled gate never blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-budget-off-'))
    try {
      await accumulateMatOSEvolutionSpendItems({
        cwd: root,
        items: [{ stage: 'critic', costUsd: 500, tokens: 100 }],
      })
      const result = await gateMatOSEvolutionDailyBudget({
        cwd: root,
        sessionId: 'session-off',
        trigger: feedbackTrigger(),
        stage: 'pipeline-entry',
        env: { MATOS_EVOLUTION_DAILY_BUDGET_USD: 'off' },
      })
      expect(result).toMatchObject({ blocked: false, disabled: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
