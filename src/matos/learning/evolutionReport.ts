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

// Read-only self-evolution health report over the trailing window.
//
// `matos evolve status` answers "what exists on disk right now"; this module
// answers the operational sweep question "did evolution quietly degrade over
// the last N days" (outcome blindness). It aggregates the SAME per-scope
// records that already exist - direct-editor run records under
// `.matos/evolution/direct-editor/runs/<run-id>/run.json` and hidden monitor
// records under the monitor roots - and reduces them to a machine-checkable
// `health` verdict so a daily cron can alert on the exit code alone.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'
import { listMatOSDirectAssetEditorRunRecords } from './directAssetEditorRecords.js'
import { listMatOSSelfEvolutionMonitorRecordLedger } from './evolutionMonitorRecords.js'

export const MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO_ENV =
  'MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO'

export const DEFAULT_EVOLUTION_REPORT_WINDOW_DAYS = 7
// Bounds the zero-filled per-day series; a fat-fingered --window-days must
// not allocate an unbounded array or walk years of records.
export const MAX_EVOLUTION_REPORT_WINDOW_DAYS = 365
const DEFAULT_MIN_ACCEPT_RATIO = 0.05
// The low-acceptance rule only fires with a meaningful sample: at least this
// many decided runs (accepted + rolledBack + failed) inside the window.
// noop/blocked runs are excluded from the denominator so a quiet week where
// the editor mostly decides "nothing to edit" is not reported as degradation.
export const EVOLUTION_REPORT_MIN_DECIDED_RUNS = 10
export const EVOLUTION_REPORT_ACTIVE_BLOCKED_STREAK = 5
const TOP_ROLLBACK_REASON_LIMIT = 10
const DAY_MS = 24 * 60 * 60 * 1000

export type MatOSEvolutionReportHealth = 'ok' | 'degraded' | 'idle'

export type MatOSEvolutionReportDay = {
  day: string
  total: number
  accepted: number
  rolledBack: number
  failed: number
  activeBlocked: number
  noop: number
  other: number
}

export type MatOSEvolutionReport = {
  mode: 'evolution-report'
  scopeMode: 'workspace' | 'fleet'
  usersScanned: number
  generatedAt: string
  windowDays: number
  windowStart: string
  totals: {
    runs: number
    accepted: number
    rolledBack: number
    activeBlocked: number
    legacyBlocked: number
    blocked: number
    failed: number
    noop: number
    interrupted: number
    /** accepted + rolledBack + failed: runs where an edit outcome was decided. */
    decided: number
    /** Runs whose createdAt could not be parsed; excluded from the window. */
    undated: number
  }
  statusCounts: Record<string, number>
  /** accepted / decided, rounded to 4 decimals; null when nothing was decided. */
  acceptanceRatio: number | null
  /** Consecutive newest-first runs in the window that are active-blocked. */
  activeBlockedStreak: number
  perDay: MatOSEvolutionReportDay[]
  topRollbackReasons: Array<{ reason: string; count: number }>
  monitor: {
    records: number
    statusCounts: Record<string, number>
  }
  health: MatOSEvolutionReportHealth
  healthReasons: string[]
  thresholds: {
    minAcceptRatio: number
    minDecidedRuns: number
    activeBlockedStreak: number
  }
}

export type MatOSEvolutionReportInput = {
  cwd: string
  env?: Record<string, string | undefined>
  /** Aggregate every user scope under this deployment runtime root. */
  runtimeDataDir?: string
  /** Test/override hook for explicit scope roots. */
  userScopes?: Array<{ cwd: string; sessionDir?: string }>
  windowDays?: number
  now?: number
}

type EvolutionReportScope = {
  cwd: string
  env: Record<string, string | undefined>
}

async function listEvolutionReportScopes(
  input: MatOSEvolutionReportInput,
): Promise<EvolutionReportScope[]> {
  const baseEnv = input.env ?? process.env
  if (input.userScopes) {
    return input.userScopes.map(scope => ({
      cwd: scope.cwd,
      env: {
        ...baseEnv,
        ...(scope.sessionDir ? { MATOS_SESSION_DIR: scope.sessionDir } : {}),
      },
    }))
  }
  if (!input.runtimeDataDir) {
    return [{ cwd: input.cwd, env: baseEnv }]
  }

  const usersDir = join(input.runtimeDataDir, 'scopes', 'users')
  let entries: string[]
  try {
    entries = await readdir(usersDir)
  } catch {
    return []
  }
  const scopes = await Promise.all(
    entries.sort().map(async userId => {
      const userRoot = join(usersDir, userId)
      try {
        if (!(await stat(userRoot)).isDirectory()) {
          return undefined
        }
      } catch {
        return undefined
      }
      return {
        cwd: join(userRoot, 'workspace-state', 'shared'),
        env: {
          ...baseEnv,
          MATOS_SESSION_DIR: join(userRoot, 'sessions'),
        },
      }
    }),
  )
  return scopes.flatMap(scope => (scope ? [scope] : []))
}

export function resolveEvolutionReportMinAcceptRatio(
  env?: Record<string, string | undefined>,
): number {
  const raw = (env ?? process.env)[MATOS_EVOLVE_REPORT_MIN_ACCEPT_RATIO_ENV]
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MIN_ACCEPT_RATIO
  }
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_MIN_ACCEPT_RATIO
  }
  return parsed
}

function isAcceptedStatus(status: string): boolean {
  return status === 'accepted' || status === 'accepted_merged'
}

// rollback_failed means the pipeline decided to roll the edit back but the
// restore itself failed; for outcome accounting it is still a rejection.
function isRolledBackStatus(status: string): boolean {
  return status === 'rolled_back' || status === 'rollback_failed'
}

function isBlockedStatus(status: string): boolean {
  return status === 'blocked' || status === 'pending_merge'
}

function isInterruptedStatus(status: string): boolean {
  return status === 'edited' || status === 'validated'
}

function isLegacyBlockedRun(run: {
  status: string
  statusReason?: string
}): boolean {
  return (
    isBlockedStatus(run.status) &&
    typeof run.statusReason === 'string' &&
    run.statusReason.startsWith('legacy_')
  )
}

function isActiveBlockedRun(run: {
  status: string
  statusReason?: string
}): boolean {
  return isBlockedStatus(run.status) && !isLegacyBlockedRun(run)
}

function parseTimeMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function utcDay(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10)
}

function rollbackReason(run: MatOSDirectAssetEditorRunRecord): string {
  const statusReason = run.statusReason?.trim()
  if (statusReason) {
    return statusReason
  }
  const freeText = run.rollback?.reason?.trim()
  if (freeText) {
    return freeText.length > 120 ? `${freeText.slice(0, 117)}...` : freeText
  }
  return 'unknown'
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

export async function buildMatOSEvolutionReport(
  input: MatOSEvolutionReportInput,
): Promise<MatOSEvolutionReport> {
  const now = input.now ?? Date.now()
  const windowDays =
    input.windowDays !== undefined &&
    Number.isFinite(input.windowDays) &&
    input.windowDays >= 1
      ? Math.min(Math.floor(input.windowDays), MAX_EVOLUTION_REPORT_WINDOW_DAYS)
      : DEFAULT_EVOLUTION_REPORT_WINDOW_DAYS
  const windowStartMs = now - windowDays * DAY_MS
  const minAcceptRatio = resolveEvolutionReportMinAcceptRatio(input.env)

  const scopes = await listEvolutionReportScopes(input)
  const allRuns = (
    await Promise.all(
      scopes.map(scope =>
        listMatOSDirectAssetEditorRunRecords(scope.cwd).catch(() => []),
      ),
    )
  ).flat()
  let undated = 0
  const windowRuns: Array<{
    run: MatOSDirectAssetEditorRunRecord
    createdAtMs: number
  }> = []
  for (const run of allRuns) {
    const createdAtMs = parseTimeMs(run.createdAt) ?? parseTimeMs(run.updatedAt)
    if (createdAtMs === undefined) {
      undated += 1
      continue
    }
    if (createdAtMs >= windowStartMs && createdAtMs <= now) {
      windowRuns.push({ run, createdAtMs })
    }
  }
  windowRuns.sort((a, b) => b.createdAtMs - a.createdAtMs)

  const statusCounts: Record<string, number> = {}
  const perDayByKey = new Map<string, MatOSEvolutionReportDay>()
  for (let day = utcDay(windowStartMs); ; ) {
    perDayByKey.set(day, {
      day,
      total: 0,
      accepted: 0,
      rolledBack: 0,
      failed: 0,
      activeBlocked: 0,
      noop: 0,
      other: 0,
    })
    if (day === utcDay(now)) {
      break
    }
    day = utcDay(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS)
  }

  const totals = {
    runs: windowRuns.length,
    accepted: 0,
    rolledBack: 0,
    activeBlocked: 0,
    legacyBlocked: 0,
    blocked: 0,
    failed: 0,
    noop: 0,
    interrupted: 0,
    decided: 0,
    undated,
  }
  const rollbackReasonCounts = new Map<string, number>()

  for (const { run, createdAtMs } of windowRuns) {
    statusCounts[run.status] = (statusCounts[run.status] ?? 0) + 1
    const day = perDayByKey.get(utcDay(createdAtMs))
    if (day) {
      day.total += 1
    }
    if (isAcceptedStatus(run.status)) {
      totals.accepted += 1
      if (day) {
        day.accepted += 1
      }
    } else if (isRolledBackStatus(run.status)) {
      totals.rolledBack += 1
      if (day) {
        day.rolledBack += 1
      }
      const reason = rollbackReason(run)
      rollbackReasonCounts.set(reason, (rollbackReasonCounts.get(reason) ?? 0) + 1)
    } else if (run.status === 'failed') {
      totals.failed += 1
      if (day) {
        day.failed += 1
      }
    } else if (isBlockedStatus(run.status)) {
      totals.blocked += 1
      if (isLegacyBlockedRun(run)) {
        totals.legacyBlocked += 1
        if (day) {
          day.other += 1
        }
      } else {
        totals.activeBlocked += 1
        if (day) {
          day.activeBlocked += 1
        }
      }
    } else if (run.status === 'noop') {
      totals.noop += 1
      if (day) {
        day.noop += 1
      }
    } else if (isInterruptedStatus(run.status)) {
      totals.interrupted += 1
      if (day) {
        day.other += 1
      }
    } else if (day) {
      day.other += 1
    }
  }
  totals.decided = totals.accepted + totals.rolledBack + totals.failed

  let activeBlockedStreak = 0
  for (const { run } of windowRuns) {
    if (!isActiveBlockedRun(run)) {
      break
    }
    activeBlockedStreak += 1
  }

  const topRollbackReasons = [...rollbackReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, TOP_ROLLBACK_REASON_LIMIT)

  const monitorStatusCounts: Record<string, number> = {}
  let monitorRecords = 0
  try {
    for (const scope of scopes) {
      for (const record of await listMatOSSelfEvolutionMonitorRecordLedger(
        scope.cwd,
        scope.env,
      )) {
        const createdAtMs = parseTimeMs(record.createdAt)
        if (
          createdAtMs === undefined ||
          createdAtMs < windowStartMs ||
          createdAtMs > now
        ) {
          continue
        }
        monitorRecords += 1
        monitorStatusCounts[record.status] =
          (monitorStatusCounts[record.status] ?? 0) + 1
      }
    }
  } catch {
    // Monitor roots are optional; a missing/unreadable tree is not a report error.
  }

  const acceptanceRatio =
    totals.decided > 0 ? round4(totals.accepted / totals.decided) : null

  const healthReasons: string[] = []
  let health: MatOSEvolutionReportHealth = 'ok'
  if (totals.runs === 0) {
    health = 'idle'
    healthReasons.push(
      `no direct-editor runs recorded in the trailing ${windowDays} day(s)`,
    )
  } else {
    if (
      totals.decided >= EVOLUTION_REPORT_MIN_DECIDED_RUNS &&
      acceptanceRatio !== null &&
      acceptanceRatio < minAcceptRatio
    ) {
      health = 'degraded'
      healthReasons.push(
        `acceptance ratio ${acceptanceRatio} is below ${minAcceptRatio} across ${totals.decided} decided run(s)`,
      )
    }
    if (activeBlockedStreak >= EVOLUTION_REPORT_ACTIVE_BLOCKED_STREAK) {
      health = 'degraded'
      healthReasons.push(
        `newest ${activeBlockedStreak} run(s) are all active-blocked (threshold ${EVOLUTION_REPORT_ACTIVE_BLOCKED_STREAK})`,
      )
    }
    if (health === 'ok') {
      healthReasons.push('acceptance ratio and blocked streak are within thresholds')
    }
  }

  return {
    mode: 'evolution-report',
    scopeMode: input.runtimeDataDir || input.userScopes ? 'fleet' : 'workspace',
    usersScanned: scopes.length,
    generatedAt: new Date(now).toISOString(),
    windowDays,
    windowStart: new Date(windowStartMs).toISOString(),
    totals,
    statusCounts,
    acceptanceRatio,
    activeBlockedStreak,
    perDay: [...perDayByKey.values()],
    topRollbackReasons,
    monitor: {
      records: monitorRecords,
      statusCounts: monitorStatusCounts,
    },
    health,
    healthReasons,
    thresholds: {
      minAcceptRatio,
      minDecidedRuns: EVOLUTION_REPORT_MIN_DECIDED_RUNS,
      activeBlockedStreak: EVOLUTION_REPORT_ACTIVE_BLOCKED_STREAK,
    },
  }
}
