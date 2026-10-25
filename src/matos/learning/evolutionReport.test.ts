/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Real-implementation tests for the trailing-window self-evolution health
// report: aggregation math, health thresholds, and CLI exit codes. Records
// are seeded on disk in temp evolution roots; no LLM calls are involved.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { runMatOSEvolveCommand } from '../cli/evolve.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  buildMatOSEvolutionReport,
  DEFAULT_EVOLUTION_REPORT_WINDOW_DAYS,
  MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO_ENV,
  MAX_EVOLUTION_REPORT_WINDOW_DAYS,
  resolveEvolutionReportMinAcceptRatio,
} from './evolutionReport.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
// Fixed clock so per-day bucket expectations are deterministic.
const NOW = Date.parse('2026-08-13T12:00:00.000Z')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function tempRoot(): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix: 'matos-evolution-report-' })
  roots.push(root)
  return root
}

function isoAt(ageMs: number, now = NOW): string {
  return new Date(now - ageMs).toISOString()
}

async function writeRun(
  root: string,
  input: {
    runId: string
    status: string
    createdAt: string
    statusReason?: string
    rollbackReason?: string
  },
): Promise<void> {
  const dir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', input.runId)
  await mkdir(dir, { recursive: true })
  // pending_merge records without asset edits are normalized to noop on read,
  // so claim a modified file for blocked/pending seeds.
  const modifiedFiles =
    input.status === 'pending_merge' ? ['user-assets/roles/compute/ROLE.md'] : []
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({
      runId: input.runId,
      status: input.status,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      scope: 'user',
      editorOutput: {
        summary: 'Report test run.',
        modifiedFiles,
        createdAssets: [],
        updatedAssets: [],
        disabledAssets: [],
        evidenceRefs: [],
      },
      modifiedFiles,
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
      roleExitCode: 0,
      ...(input.rollbackReason
        ? { rollback: { reason: input.rollbackReason } }
        : {}),
    }),
    'utf8',
  )
}

async function writeMonitorSession(
  root: string,
  sessionId: string,
  records: Array<{ recordId: string; status: string; createdAt: string }>,
): Promise<void> {
  const dir = join(root, '.matos', 'evolution', 'monitor', 'sessions', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'records.jsonl'),
    `${records
      .map(record =>
        JSON.stringify({
          recordId: record.recordId,
          sessionId,
          triggerKind: 'tool-failure',
          triggerKey: `tool-failure:${record.recordId}`,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          summary: 'Monitor report test record.',
        }),
      )
      .join('\n')}\n`,
    'utf8',
  )
}

describe('evolution report thresholds env knob', () => {
  test('default, valid override, and invalid values', () => {
    expect(resolveEvolutionReportMinAcceptRatio({})).toBe(0.05)
    expect(
      resolveEvolutionReportMinAcceptRatio({
        [MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO_ENV]: '0.5',
      }),
    ).toBe(0.5)
    for (const invalid of ['2.5', '-1', 'abc', '']) {
      expect(
        resolveEvolutionReportMinAcceptRatio({
          [MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO_ENV]: invalid,
        }),
      ).toBe(0.05)
    }
  })
})

describe('evolution report aggregation', () => {
  test('aggregates deployment user scopes and their scoped monitor ledgers', async () => {
    const deployRoot = await tempRoot()
    const runtimeDataDir = join(deployRoot, 'runtime')
    const createdAt = isoAt(DAY_MS)

    for (const [userId, status] of [
      ['alice', 'accepted'],
      ['bob', 'rolled_back'],
    ] as const) {
      const userRoot = join(runtimeDataDir, 'scopes', 'users', userId)
      const cwd = join(userRoot, 'workspace-state', 'shared')
      await writeRun(cwd, {
        runId: `run-${userId}`,
        status,
        createdAt,
      })
      const monitorDir = join(
        userRoot,
        'sessions',
        'evolution-monitor',
        'sessions',
        `session-${userId}`,
      )
      await mkdir(monitorDir, { recursive: true })
      await writeFile(
        join(monitorDir, 'records.jsonl'),
        `${JSON.stringify({
          recordId: `record-${userId}`,
          sessionId: `session-${userId}`,
          triggerKind: 'tool-failure',
          triggerKey: `tool-failure:${userId}`,
          status: 'detected',
          createdAt,
          updatedAt: createdAt,
          summary: 'Fleet monitor record.',
        })}\n`,
        'utf8',
      )
    }

    const report = await buildMatOSEvolutionReport({
      cwd: deployRoot,
      env: {},
      runtimeDataDir,
      now: NOW,
    })

    expect(report.scopeMode).toBe('fleet')
    expect(report.usersScanned).toBe(2)
    expect(report.totals.runs).toBe(2)
    expect(report.totals.accepted).toBe(1)
    expect(report.totals.rolledBack).toBe(1)
    expect(report.monitor).toEqual({
      records: 2,
      statusCounts: { detected: 2 },
    })
  })

  test('aggregates totals, per-day counts, and top rollback reasons over the window', async () => {
    const root = await tempRoot()
    await writeRun(root, { runId: 'acc-1', status: 'accepted', createdAt: isoAt(2 * DAY_MS) })
    await writeRun(root, { runId: 'acc-2', status: 'accepted_merged', createdAt: isoAt(2 * DAY_MS) })
    await writeRun(root, {
      runId: 'rb-sem-1',
      status: 'rolled_back',
      statusReason: 'semantic_acceptance_rejected',
      createdAt: isoAt(1 * DAY_MS),
    })
    await writeRun(root, {
      runId: 'rb-sem-2',
      status: 'rolled_back',
      statusReason: 'semantic_acceptance_rejected',
      createdAt: isoAt(3 * DAY_MS),
    })
    await writeRun(root, {
      runId: 'rb-free',
      status: 'rolled_back',
      rollbackReason: 'semantic acceptance reject: judge said no',
      createdAt: isoAt(1 * DAY_MS),
    })
    await writeRun(root, {
      runId: 'rb-fail',
      status: 'rollback_failed',
      statusReason: 'gate1_validation_failed',
      createdAt: isoAt(1 * DAY_MS),
    })
    await writeRun(root, { runId: 'failed-1', status: 'failed', createdAt: isoAt(4 * DAY_MS) })
    await writeRun(root, { runId: 'noop-1', status: 'noop', createdAt: isoAt(1 * DAY_MS) })
    await writeRun(root, { runId: 'blocked-active', status: 'blocked', createdAt: isoAt(5 * DAY_MS) })
    await writeRun(root, {
      runId: 'blocked-legacy',
      status: 'blocked',
      statusReason: 'legacy_dirty_preflight',
      createdAt: isoAt(6 * DAY_MS),
    })
    await writeRun(root, { runId: 'edited-1', status: 'edited', createdAt: isoAt(1 * DAY_MS) })
    // Outside the 7-day window: must not be counted anywhere.
    await writeRun(root, { runId: 'outside', status: 'accepted', createdAt: isoAt(10 * DAY_MS) })

    const report = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })

    expect(report.mode).toBe('evolution-report')
    expect(report.windowDays).toBe(DEFAULT_EVOLUTION_REPORT_WINDOW_DAYS)
    expect(report.totals).toEqual({
      runs: 11,
      accepted: 2,
      rolledBack: 4,
      activeBlocked: 1,
      legacyBlocked: 1,
      blocked: 2,
      failed: 1,
      noop: 1,
      interrupted: 1,
      decided: 7,
      undated: 0,
    })
    expect(report.statusCounts).toEqual({
      accepted: 1,
      accepted_merged: 1,
      rolled_back: 3,
      rollback_failed: 1,
      failed: 1,
      noop: 1,
      blocked: 2,
      edited: 1,
    })
    expect(report.acceptanceRatio).toBe(Math.round((2 / 7) * 10000) / 10000)
    expect(report.activeBlockedStreak).toBe(0)
    expect(report.health).toBe('ok')

    expect(report.perDay.map(day => day.day)).toEqual([
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ])
    const byDay = new Map(report.perDay.map(day => [day.day, day]))
    expect(byDay.get('2026-08-07')).toMatchObject({ total: 1, other: 1 })
    expect(byDay.get('2026-08-08')).toMatchObject({ total: 1, activeBlocked: 1 })
    expect(byDay.get('2026-08-09')).toMatchObject({ total: 1, failed: 1 })
    expect(byDay.get('2026-08-10')).toMatchObject({ total: 1, rolledBack: 1 })
    expect(byDay.get('2026-08-11')).toMatchObject({ total: 2, accepted: 2 })
    expect(byDay.get('2026-08-12')).toMatchObject({
      total: 5,
      rolledBack: 3,
      noop: 1,
      other: 1,
    })
    expect(byDay.get('2026-08-13')).toMatchObject({ total: 0 })

    expect(report.topRollbackReasons).toEqual([
      { reason: 'semantic_acceptance_rejected', count: 2 },
      { reason: 'gate1_validation_failed', count: 1 },
      { reason: 'semantic acceptance reject: judge said no', count: 1 },
    ])
  })

  test('window-days widens the window and unparseable timestamps count as undated', async () => {
    const root = await tempRoot()
    await writeRun(root, { runId: 'old', status: 'accepted', createdAt: isoAt(10 * DAY_MS) })
    await writeRun(root, { runId: 'undated', status: 'noop', createdAt: 'not-a-date' })

    const narrow = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(narrow.totals.runs).toBe(0)
    expect(narrow.totals.undated).toBe(1)
    expect(narrow.health).toBe('idle')

    const wide = await buildMatOSEvolutionReport({
      cwd: root,
      env: {},
      now: NOW,
      windowDays: 30,
    })
    expect(wide.windowDays).toBe(30)
    expect(wide.totals.runs).toBe(1)
    expect(wide.totals.accepted).toBe(1)

    const capped = await buildMatOSEvolutionReport({
      cwd: root,
      env: {},
      now: NOW,
      windowDays: 100000,
    })
    expect(capped.windowDays).toBe(MAX_EVOLUTION_REPORT_WINDOW_DAYS)
  })

  test('aggregates monitor records inside the window', async () => {
    const root = await tempRoot()
    await writeMonitorSession(root, 'session-a', [
      { recordId: 'm-1', status: 'direct-edit-complete', createdAt: isoAt(1 * DAY_MS) },
      { recordId: 'm-2', status: 'noop', createdAt: isoAt(2 * DAY_MS) },
      { recordId: 'm-old', status: 'failed', createdAt: isoAt(10 * DAY_MS) },
    ])

    const report = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(report.monitor.records).toBe(2)
    expect(report.monitor.statusCounts).toEqual({
      'direct-edit-complete': 1,
      noop: 1,
    })
  })
})

describe('evolution report health thresholds', () => {
  test('zero runs in window is idle', async () => {
    const root = await tempRoot()
    const report = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(report.health).toBe('idle')
    expect(report.totals.runs).toBe(0)
    expect(report.acceptanceRatio).toBeNull()
  })

  test('low acceptance ratio degrades only with enough decided runs', async () => {
    const root = await tempRoot()
    for (let index = 0; index < 9; index += 1) {
      await writeRun(root, {
        runId: `rb-${index}`,
        status: 'rolled_back',
        statusReason: 'semantic_acceptance_rejected',
        createdAt: isoAt((index + 1) * HOUR_MS),
      })
    }
    // 9 decided runs at ratio 0: below the 10-run sample floor, stays ok.
    const smallSample = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(smallSample.totals.decided).toBe(9)
    expect(smallSample.acceptanceRatio).toBe(0)
    expect(smallSample.health).toBe('ok')

    await writeRun(root, {
      runId: 'rb-9',
      status: 'rolled_back',
      statusReason: 'semantic_acceptance_rejected',
      createdAt: isoAt(10 * HOUR_MS),
    })
    const degraded = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(degraded.totals.decided).toBe(10)
    expect(degraded.health).toBe('degraded')
    expect(degraded.healthReasons.join(' ')).toContain('acceptance ratio 0 is below 0.05')

    // One acceptance lifts the ratio back over the default threshold.
    await writeRun(root, {
      runId: 'acc-recovery',
      status: 'accepted',
      createdAt: isoAt(30 * 60 * 1000),
    })
    const recovered = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(recovered.totals.decided).toBe(11)
    expect(recovered.acceptanceRatio).toBe(Math.round((1 / 11) * 10000) / 10000)
    expect(recovered.health).toBe('ok')

    // A stricter operator threshold flips the same tree back to degraded.
    const strict = await buildMatOSEvolutionReport({
      cwd: root,
      env: { [MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO_ENV]: '0.5' },
      now: NOW,
    })
    expect(strict.health).toBe('degraded')
    expect(strict.thresholds.minAcceptRatio).toBe(0.5)
  })

  test('an active-blocked streak of 5 newest runs degrades health', async () => {
    const root = await tempRoot()
    for (let index = 0; index < 5; index += 1) {
      await writeRun(root, {
        runId: `blocked-${index}`,
        status: 'blocked',
        createdAt: isoAt((index + 1) * HOUR_MS),
      })
    }
    await writeRun(root, { runId: 'older-ok', status: 'accepted', createdAt: isoAt(2 * DAY_MS) })

    const degraded = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(degraded.activeBlockedStreak).toBe(5)
    expect(degraded.health).toBe('degraded')
    expect(degraded.healthReasons.join(' ')).toContain('active-blocked')

    // A newer healthy run breaks the streak: 5 blocked runs still exist in the
    // window but no longer as the newest consecutive outcomes.
    await writeRun(root, { runId: 'newest-noop', status: 'noop', createdAt: isoAt(1 * 60 * 1000) })
    const recovered = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(recovered.activeBlockedStreak).toBe(0)
    expect(recovered.health).toBe('ok')
  })

  test('legacy-blocked runs do not count toward the active-blocked streak', async () => {
    const root = await tempRoot()
    for (let index = 0; index < 5; index += 1) {
      await writeRun(root, {
        runId: `legacy-${index}`,
        status: 'blocked',
        statusReason: 'legacy_dirty_preflight',
        createdAt: isoAt((index + 1) * HOUR_MS),
      })
    }
    const report = await buildMatOSEvolutionReport({ cwd: root, env: {}, now: NOW })
    expect(report.totals.legacyBlocked).toBe(5)
    expect(report.activeBlockedStreak).toBe(0)
    expect(report.health).toBe('ok')
  })
})

describe('matos evolve report CLI', () => {
  test('--runtime-data-dir selects the fleet report path', async () => {
    const deployRoot = await tempRoot()
    const runtimeDataDir = join(deployRoot, 'runtime')
    const cwd = join(
      runtimeDataDir,
      'scopes',
      'users',
      'alice',
      'workspace-state',
      'shared',
    )
    await writeRun(cwd, {
      runId: 'fleet-accepted',
      status: 'accepted',
      createdAt: new Date().toISOString(),
    })
    const output: string[] = []
    const exitCode = await runMatOSEvolveCommand(
      ['report', '--runtime-data-dir', runtimeDataDir, '--json'],
      {
        cwd: deployRoot,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
        env: {},
      },
    )
    expect(exitCode).toBe(0)
    expect(JSON.parse(output.join(''))).toMatchObject({
      mode: 'evolution-report',
      scopeMode: 'fleet',
      usersScanned: 1,
      totals: { runs: 1, accepted: 1 },
    })
  })

  test('exit code 0 and json payload for a healthy window', async () => {
    const root = await tempRoot()
    await writeRun(root, {
      runId: 'acc-now',
      status: 'accepted',
      createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    })
    const output: string[] = []
    const exitCode = await runMatOSEvolveCommand(['report', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      mode: string
      health: string
      windowDays: number
      totals: { runs: number; accepted: number }
    }
    expect(parsed.mode).toBe('evolution-report')
    expect(parsed.health).toBe('ok')
    expect(parsed.windowDays).toBe(7)
    expect(parsed.totals).toMatchObject({ runs: 1, accepted: 1 })
  })

  test('exit code 3 when degraded, 0 when idle, and --window-days is honored', async () => {
    const idleRoot = await tempRoot()
    const idleOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['report', '--window-days', '30', '--json'], {
        cwd: idleRoot,
        stdout: chunk => idleOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    const idleParsed = JSON.parse(idleOutput.join('')) as {
      health: string
      windowDays: number
    }
    expect(idleParsed.health).toBe('idle')
    expect(idleParsed.windowDays).toBe(30)

    const degradedRoot = await tempRoot()
    for (let index = 0; index < 10; index += 1) {
      await writeRun(degradedRoot, {
        runId: `rb-${index}`,
        status: 'rolled_back',
        statusReason: 'semantic_acceptance_rejected',
        createdAt: new Date(Date.now() - (index + 1) * HOUR_MS).toISOString(),
      })
    }
    const degradedOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['report', '--json'], {
        cwd: degradedRoot,
        stdout: chunk => degradedOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(3)
    expect(
      (JSON.parse(degradedOutput.join('')) as { health: string }).health,
    ).toBe('degraded')

    // Human-readable mode carries the same exit code contract.
    const humanOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['report'], {
        cwd: degradedRoot,
        stdout: chunk => humanOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(3)
    expect(humanOutput.join('')).toContain('health=degraded')
    expect(humanOutput.join('')).toContain(
      'rollbackReason=semantic_acceptance_rejected count=10',
    )
  })
})
