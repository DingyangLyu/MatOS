import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSEvent } from '../sessions/eventTypes.js'
import {
  listMatOSSelfEvolutionMonitorRecords,
  runMatOSSelfEvolutionForSession,
  type MatOSSelfEvolutionTrigger,
} from './evolutionMonitor.js'
import type { MatOSSelfEvolutionMonitorRecord } from './evolutionMonitorRecords.js'
import type { MatOSUserFeedbackAnalyzer } from './userFeedbackSignals.js'
import {
  MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS,
  matOSEvolutionFailureLedgerPath,
  matOSEvolutionFailureSuppressionConfig,
  readMatOSEvolutionFailureLedger,
  recordMatOSEvolutionTriggerConclusionInFailureLedger,
  suppressMatOSEvolutionTriggerForRepeatedFailures,
} from './evolutionCrossSessionSuppression.js'

const LOOP_TRIGGER_KEY = 'tool-failure:Bash:deadbeef0000:bucket-1'

function loopTrigger(): MatOSSelfEvolutionTrigger {
  return {
    kind: 'tool-failure',
    key: LOOP_TRIGGER_KEY,
    eventId: 'tool-fail',
    summary: 'Bash failed with the same deterministic mkdir failure.',
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

async function runLoopTrigger(input: {
  root: string
  sessionId: string
  analyzer: MatOSUserFeedbackAnalyzer
  env?: Record<string, string | undefined>
}): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  const sessionPath = await writeSession(input.root, input.sessionId, [
    sessionEvent(input.sessionId, 'tool-fail', 'matos.tool.call.completed', {
      toolName: 'Bash',
      isError: true,
      resultPreview: 'same deterministic mkdir failure',
    }),
  ])
  return runMatOSSelfEvolutionForSession(
    {
      cwd: input.root,
      sessionId: input.sessionId,
      sessionPath,
      trigger: loopTrigger(),
    },
    {
      feedbackAnalyzer: input.analyzer,
      env: { NODE_ENV: 'test', MATOS_SCOPE_ID: 'core', ...input.env },
    },
  )
}

function failedRecord(input: {
  sessionId: string
  key?: string
  status?: MatOSSelfEvolutionMonitorRecord['status']
  error?: string
}): MatOSSelfEvolutionMonitorRecord {
  const timestamp = new Date().toISOString()
  return {
    recordId: `monitor-test-${input.sessionId}-${Math.random().toString(36).slice(2)}`,
    sessionId: input.sessionId,
    triggerKind: 'tool-failure',
    triggerKey: input.key ?? LOOP_TRIGGER_KEY,
    status: input.status ?? 'failed',
    createdAt: timestamp,
    updatedAt: timestamp,
    summary: 'test conclusion',
    ...(input.error ? { error: input.error } : {}),
  }
}

describe('MatOS evolution cross-session failure suppression', () => {
  test('registry infrastructure failures do not become a failed-algorithm suppression streak', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-infra-not-algorithm-'))
    for (let index = 0; index < 4; index++) {
      await recordMatOSEvolutionTriggerConclusionInFailureLedger({ cwd, record: failedRecord({ sessionId: `auth-${index}`, error: 'gitea_auth_rejected: repair the scoped credential' }) })
    }
    expect(await readMatOSEvolutionFailureLedger(cwd)).toBeUndefined()
    expect(await suppressMatOSEvolutionTriggerForRepeatedFailures({ cwd, sessionId: 'repaired', trigger: loopTrigger() })).toMatchObject({ suppressed: false })
  })
  test('suppresses a trigger key after repeated failed conclusions across sessions and writes one notice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-suppress-'))
    let criticCalls = 0
    const failingAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      criticCalls += 1
      throw new Error('critic unavailable for this deterministic failure')
    }

    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      const records = await runLoopTrigger({ root, sessionId, analyzer: failingAnalyzer })
      expect(records?.map(record => record.status)).toEqual(['detected', 'failed'])
    }
    expect(criticCalls).toBe(3)

    const ledger = await readMatOSEvolutionFailureLedger(root)
    const entry = ledger?.entries[LOOP_TRIGGER_KEY]
    expect(entry?.failedCount).toBe(3)
    expect(entry?.failedAt).toHaveLength(3)
    expect(entry?.familyKey).toBe('tool-failure:Bash')
    expect(entry?.lastFailedSessionId).toBe('session-c')
    expect(matOSEvolutionFailureLedgerPath(root)).toBe(
      join(root, '.matos', 'evolution', 'monitor', 'failure-ledger.json'),
    )

    // Fourth session: the exact key is suppressed before any hidden LLM stage
    // and exactly one skipped-repeated-failure record explains why.
    const suppressedRun = await runLoopTrigger({
      root,
      sessionId: 'session-d',
      analyzer: failingAnalyzer,
    })
    expect(criticCalls).toBe(3)
    expect(suppressedRun).toHaveLength(1)
    expect(suppressedRun?.[0]?.status).toBe(
      MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS,
    )
    expect(suppressedRun?.[0]?.sessionId).toBe('session-d')
    expect(suppressedRun?.[0]?.summary).toMatch(/suppressed/i)

    // Fifth session: still suppressed, but silently (the notice is once per
    // failure streak, across sessions).
    const silentRun = await runLoopTrigger({
      root,
      sessionId: 'session-e',
      analyzer: failingAnalyzer,
    })
    expect(criticCalls).toBe(3)
    expect(silentRun).toBeUndefined()

    const allRecords = await listMatOSSelfEvolutionMonitorRecords(root)
    expect(
      allRecords.filter(
        record => record.status === MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS,
      ),
    ).toHaveLength(1)
  })

  test('a successful conclusion clears the failure ledger entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-clear-'))
    let criticCalls = 0
    const failingAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      criticCalls += 1
      throw new Error('critic unavailable')
    }
    const succeedingAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      criticCalls += 1
      return {
        schemaVersion: 1,
        shouldUseFeedback: false,
        summary: 'no reusable change needed',
        signals: [],
        decisions: [],
      }
    }

    await runLoopTrigger({ root, sessionId: 'session-f1', analyzer: failingAnalyzer })
    await runLoopTrigger({ root, sessionId: 'session-f2', analyzer: failingAnalyzer })
    expect(
      (await readMatOSEvolutionFailureLedger(root))?.entries[LOOP_TRIGGER_KEY]
        ?.failedCount,
    ).toBe(2)

    // Below the default threshold of 3, so the pipeline still runs and now
    // concludes noop, which clears the entry.
    const successRun = await runLoopTrigger({
      root,
      sessionId: 'session-f3',
      analyzer: succeedingAnalyzer,
    })
    expect(successRun?.map(record => record.status)).toContain('noop')
    expect(
      (await readMatOSEvolutionFailureLedger(root))?.entries[LOOP_TRIGGER_KEY],
    ).toBeUndefined()

    // A later failure starts a fresh streak instead of inheriting the old one.
    await runLoopTrigger({ root, sessionId: 'session-f4', analyzer: failingAnalyzer })
    expect(
      (await readMatOSEvolutionFailureLedger(root))?.entries[LOOP_TRIGGER_KEY]
        ?.failedCount,
    ).toBe(1)
    expect(criticCalls).toBe(4)
  })

  test('threshold is configurable through MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-threshold-'))
    let criticCalls = 0
    const failingAnalyzer: MatOSUserFeedbackAnalyzer = async () => {
      criticCalls += 1
      throw new Error('critic unavailable')
    }
    const env = { MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD: '1' }

    await runLoopTrigger({ root, sessionId: 'session-t1', analyzer: failingAnalyzer, env })
    expect(criticCalls).toBe(1)
    const suppressed = await runLoopTrigger({
      root,
      sessionId: 'session-t2',
      analyzer: failingAnalyzer,
      env,
    })
    expect(criticCalls).toBe(1)
    expect(suppressed?.[0]?.status).toBe(MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS)

    // '0' / 'off' disable cross-session suppression entirely.
    await runLoopTrigger({
      root,
      sessionId: 'session-t3',
      analyzer: failingAnalyzer,
      env: { MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD: '0' },
    })
    expect(criticCalls).toBe(2)
  })

  test('failures outside the lookback window do not suppress and old streaks decay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-window-'))
    const staleAt = new Date(Date.now() - 30 * 60 * 60 * 1000)
    for (const sessionId of ['old-1', 'old-2', 'old-3']) {
      await recordMatOSEvolutionTriggerConclusionInFailureLedger({
        cwd: root,
        record: failedRecord({ sessionId }),
        familyKey: 'tool-failure:Bash',
        now: staleAt,
      })
    }
    expect(
      (await readMatOSEvolutionFailureLedger(root))?.entries[LOOP_TRIGGER_KEY]
        ?.failedCount,
    ).toBe(3)

    // 30h-old failures are outside the default 24h window.
    const defaultWindow = await suppressMatOSEvolutionTriggerForRepeatedFailures({
      cwd: root,
      sessionId: 'session-now',
      trigger: loopTrigger(),
      env: {},
    })
    expect(defaultWindow.suppressed).toBe(false)

    // Widening the window through the env knob makes the same streak count.
    const widenedWindow = await suppressMatOSEvolutionTriggerForRepeatedFailures({
      cwd: root,
      sessionId: 'session-now',
      trigger: loopTrigger(),
      env: { MATOS_EVOLUTION_FAILURE_SUPPRESS_HOURS: '48' },
    })
    expect(widenedWindow.suppressed).toBe(true)
    expect(widenedWindow.failedCountInWindow).toBe(3)
    expect(widenedWindow.noticeRecord?.status).toBe(
      MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS,
    )
  })

  test('manual-evolve triggers are never suppressed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-manual-'))
    const manualKey = 'manual-evolve:session-m:req-1'
    for (const sessionId of ['m1', 'm2', 'm3', 'm4']) {
      await recordMatOSEvolutionTriggerConclusionInFailureLedger({
        cwd: root,
        record: failedRecord({ sessionId, key: manualKey }),
      })
    }
    const result = await suppressMatOSEvolutionTriggerForRepeatedFailures({
      cwd: root,
      sessionId: 'session-m',
      trigger: {
        kind: 'manual-evolve',
        key: manualKey,
        summary: 'The user explicitly requested /evolve.',
      },
      env: {},
    })
    expect(result.suppressed).toBe(false)
  })

  test('multiple failed records from the same session count as one failure episode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-episode-'))
    await recordMatOSEvolutionTriggerConclusionInFailureLedger({
      cwd: root,
      record: failedRecord({ sessionId: 'same-session' }),
    })
    await recordMatOSEvolutionTriggerConclusionInFailureLedger({
      cwd: root,
      record: failedRecord({ sessionId: 'same-session' }),
    })
    let entry = (await readMatOSEvolutionFailureLedger(root))?.entries[
      LOOP_TRIGGER_KEY
    ]
    expect(entry?.failedCount).toBe(1)
    expect(entry?.failedAt).toHaveLength(1)

    await recordMatOSEvolutionTriggerConclusionInFailureLedger({
      cwd: root,
      record: failedRecord({ sessionId: 'other-session' }),
    })
    entry = (await readMatOSEvolutionFailureLedger(root))?.entries[LOOP_TRIGGER_KEY]
    expect(entry?.failedCount).toBe(2)
    expect(entry?.failedAt).toHaveLength(2)
  })

  test('redacts and truncates the stored lastError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-redact-'))
    const secret = 'sk-liveKEYabcdefgh12345678'
    await recordMatOSEvolutionTriggerConclusionInFailureLedger({
      cwd: root,
      record: failedRecord({
        sessionId: 'redact-session',
        error: `provider rejected token ${secret} ${'x'.repeat(400)}`,
      }),
    })
    const entry = (await readMatOSEvolutionFailureLedger(root))?.entries[
      LOOP_TRIGGER_KEY
    ]
    expect(entry?.lastError).toBeDefined()
    expect(entry?.lastError).not.toContain(secret)
    expect(entry?.lastError).toContain('[redacted]')
    expect(entry?.lastError!.length).toBeLessThanOrEqual(160)
  })

  test('ledger stays bounded under many distinct trigger keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-bounded-'))
    for (let index = 0; index < 320; index += 1) {
      await recordMatOSEvolutionTriggerConclusionInFailureLedger({
        cwd: root,
        record: failedRecord({
          sessionId: `session-${index}`,
          key: `tool-failure:Bash:fp${index}:bucket`,
        }),
        now: new Date(Date.now() - (320 - index) * 1000),
      })
    }
    const ledger = await readMatOSEvolutionFailureLedger(root)
    const keys = Object.keys(ledger?.entries ?? {})
    expect(keys.length).toBeLessThanOrEqual(300)
    // The newest keys survive compaction.
    expect(ledger?.entries['tool-failure:Bash:fp319:bucket']).toBeDefined()
    expect(ledger?.entries['tool-failure:Bash:fp0:bucket']).toBeUndefined()
  })

  test('concurrent failed conclusions from distinct sessions are all counted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-cross-session-concurrent-'))
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        recordMatOSEvolutionTriggerConclusionInFailureLedger({
          cwd: root,
          record: failedRecord({ sessionId: `concurrent-${index}` }),
        }),
      ),
    )
    const entry = (await readMatOSEvolutionFailureLedger(root))?.entries[
      LOOP_TRIGGER_KEY
    ]
    expect(entry?.failedCount).toBe(6)
    expect(entry?.failedAt?.length).toBe(6)
  })

  test('parses suppression env knobs', () => {
    expect(matOSEvolutionFailureSuppressionConfig({})).toMatchObject({
      enabled: true,
      threshold: 3,
      lookbackMs: 24 * 60 * 60 * 1000,
    })
    expect(
      matOSEvolutionFailureSuppressionConfig({
        MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD: '5',
        MATOS_EVOLUTION_FAILURE_SUPPRESS_HOURS: '2.5',
      }),
    ).toMatchObject({ enabled: true, threshold: 5, lookbackMs: 9_000_000 })
    expect(
      matOSEvolutionFailureSuppressionConfig({
        MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD: 'off',
      }).enabled,
    ).toBe(false)
    expect(
      matOSEvolutionFailureSuppressionConfig({
        MATOS_EVOLUTION_FAILURE_SUPPRESS_HOURS: '0',
      }).enabled,
    ).toBe(false)
    // Garbage falls back to defaults instead of disabling learning safeguards.
    expect(
      matOSEvolutionFailureSuppressionConfig({
        MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD: 'many',
      }),
    ).toMatchObject({ enabled: true, threshold: 3 })
  })
})
