import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  claimMatOSEvolutionDailyBudget,
  DEFAULT_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT,
  resolveEvolutionDailyHiddenRunLimit,
} from './evolutionDailyBudget.js'

describe('MatOS self-evolution daily budget', () => {
  test('uses a bounded production default and accepts explicit overrides', () => {
    expect(resolveEvolutionDailyHiddenRunLimit({})).toBe(
      DEFAULT_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT,
    )
    expect(
      resolveEvolutionDailyHiddenRunLimit({
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '3',
      }),
    ).toBe(3)
    expect(
      resolveEvolutionDailyHiddenRunLimit({
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: 'invalid',
      }),
    ).toBe(DEFAULT_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT)
    // Kill-switch semantics: 0 means zero automatic runs, never unlimited.
    expect(
      resolveEvolutionDailyHiddenRunLimit({
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '0',
      }),
    ).toBe(0)
    expect(
      resolveEvolutionDailyHiddenRunLimit({
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: 'off',
      }),
    ).toBe(-1)
    expect(
      resolveEvolutionDailyHiddenRunLimit({
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '-1',
      }),
    ).toBe(-1)
  })

  test('limit 0 denies automatic runs and off disables the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-budget-'))
    const denied = await claimMatOSEvolutionDailyBudget({
      cwd: root,
      sessionId: 'session-zero',
      triggerKey: 'trigger-zero',
      triggerKind: 'user-feedback',
      env: {
        MATOS_EVOLUTION_BUDGET_DIR: join(root, 'budget'),
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '0',
      },
    })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('exhausted')

    const unlimited = await claimMatOSEvolutionDailyBudget({
      cwd: root,
      sessionId: 'session-off',
      triggerKey: 'trigger-off',
      triggerKind: 'user-feedback',
      env: {
        MATOS_EVOLUTION_BUDGET_DIR: join(root, 'budget'),
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: 'off',
      },
    })
    expect(unlimited.allowed).toBe(true)
    expect(unlimited.reason).toBe('unlimited')

    // Manual runs bypass the kill-switch so `/evolve` keeps working.
    const manual = await claimMatOSEvolutionDailyBudget({
      cwd: root,
      sessionId: 'session-manual',
      triggerKey: 'trigger-manual',
      triggerKind: 'manual-evolve',
      env: {
        MATOS_EVOLUTION_BUDGET_DIR: join(root, 'budget'),
        MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '0',
      },
    })
    expect(manual.allowed).toBe(true)
    expect(manual.reason).toBe('manual')
  })

  test('claims automatic runs atomically and denies runs past the daily limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-budget-'))
    const env = {
      MATOS_SCOPE_ID: 'user:alice',
      MATOS_EVOLUTION_BUDGET_DIR: join(root, 'budget'),
      MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '2',
    }
    const now = new Date('2026-08-11T05:00:00.000Z')
    const claims = await Promise.all(
      ['one', 'two', 'three'].map(triggerKey =>
        claimMatOSEvolutionDailyBudget({
          cwd: root,
          sessionId: `session-${triggerKey}`,
          triggerKey,
          triggerKind: 'user-feedback',
          env,
          now,
        }),
      ),
    )

    expect(claims.filter(claim => claim.allowed)).toHaveLength(2)
    expect(claims.filter(claim => !claim.allowed)).toEqual([
      { allowed: false, limit: 2, used: 2, reason: 'exhausted' },
    ])
  })

  test('first claim of the day prunes expired day directories but keeps the retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-budget-retention-'))
    const budgetDir = join(root, 'budget')
    const env = {
      MATOS_EVOLUTION_BUDGET_DIR: budgetDir,
      MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '2',
    }
    // No scope/user in env, so the owner segment defaults to 'local'.
    const ownerDir = join(budgetDir, 'local')
    await mkdir(join(ownerDir, '2026-07-01'), { recursive: true })
    await writeFile(join(ownerDir, '2026-07-01', '00001.claim'), '{}\n', 'utf8')
    // Inside the 7-day retention window relative to `now` below.
    await mkdir(join(ownerDir, '2026-08-09'), { recursive: true })
    // Non-date-named entries must never be touched.
    await mkdir(join(ownerDir, 'not-a-day'), { recursive: true })

    const now = new Date('2026-08-11T05:00:00.000Z')
    const first = await claimMatOSEvolutionDailyBudget({
      cwd: root,
      sessionId: 'session-retention',
      triggerKey: 'trigger-retention-1',
      triggerKind: 'user-feedback',
      env,
      now,
    })
    expect(first).toMatchObject({ allowed: true, used: 1, reason: 'claimed' })
    expect((await readdir(ownerDir)).sort()).toEqual([
      '2026-08-09',
      '2026-08-11',
      'not-a-day',
    ])

    // Later claims of the same day are not slot 1 and must not pay the sweep.
    await mkdir(join(ownerDir, '2026-06-01'), { recursive: true })
    const second = await claimMatOSEvolutionDailyBudget({
      cwd: root,
      sessionId: 'session-retention',
      triggerKey: 'trigger-retention-2',
      triggerKind: 'user-feedback',
      env,
      now,
    })
    expect(second).toMatchObject({ allowed: true, used: 2, reason: 'claimed' })
    expect((await readdir(ownerDir)).sort()).toEqual([
      '2026-06-01',
      '2026-08-09',
      '2026-08-11',
      'not-a-day',
    ])
  })

  test('does not charge explicit manual evolution against the automatic limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolution-budget-manual-'))
    const claim = await claimMatOSEvolutionDailyBudget({
      cwd: root,
      sessionId: 'manual-session',
      triggerKey: 'manual-evolve:role',
      triggerKind: 'manual-evolve',
      env: { MATOS_EVOLUTION_DAILY_HIDDEN_RUN_LIMIT: '1' },
    })
    expect(claim).toMatchObject({ allowed: true, reason: 'manual', used: 0 })
  })
})
