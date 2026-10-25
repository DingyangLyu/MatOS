import { randomUUID } from 'node:crypto'
import { evolutionInfrastructureFailureCode } from './evolutionInfrastructure.js'
import { join } from 'node:path'
import { redactTraceValue } from '../sessions/traceContext.js'
import type { MatOSSelfEvolutionTrigger } from './evolutionMonitor.js'
import {
  appendMonitorRecord,
  type MatOSSelfEvolutionMonitorRecord,
  type MatOSSelfEvolutionMonitorStatus,
} from './evolutionMonitorRecords.js'
import {
  matOSEvolutionOpsLedgerDir,
  readMatOSEvolutionOpsLedgerFile,
  updateMatOSEvolutionOpsLedgerFile,
} from './evolutionOpsLedger.js'

// Cross-session failure-loop suppression.
//
// Trigger cooldowns and concluded-status suppression read only the current
// session's monitor records, so a deterministic failure that re-fires the same
// trigger key from many short sessions (for example the same
// `agent-repeated-action:Bash:...` key failing in many sessions) pays for
// the hidden critic every time. This module keeps a small
// per-cwd ledger of concluded FAILED trigger outcomes and suppresses a trigger
// key once it has failed `MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD` times
// (default 3) across sessions within the last
// `MATOS_EVOLUTION_FAILURE_SUPPRESS_HOURS` hours (default 24). The first
// suppression writes one `skipped-repeated-failure` monitor record so
// operators can see why learning went quiet; a successful conclusion for the
// key clears its entry.

// This status is intentionally NOT added to the shared
// MatOSSelfEvolutionMonitorStatus union: evolutionMonitorLiveNotification.ts
// (owned by the UI workstream) keeps exhaustive maps over that union, and
// records with this status are never surfaced there (only
// 'direct-edit-complete' is). All other readers treat statuses as opaque
// strings, and JSONL storage round-trips unknown statuses unchanged.
export const MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS =
  'skipped-repeated-failure' as unknown as MatOSSelfEvolutionMonitorStatus

const DEFAULT_FAILURE_SUPPRESS_THRESHOLD = 3
const DEFAULT_FAILURE_SUPPRESS_HOURS = 24
const FAILURE_LEDGER_MAX_ENTRIES = 300
const FAILURE_LEDGER_MIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const FAILURE_LEDGER_MIN_TIMESTAMPS = 12
const FAILURE_LEDGER_MAX_ERROR_CHARS = 160

export type MatOSEvolutionFailureLedgerEntry = {
  triggerKey: string
  familyKey: string
  triggerKind: string
  // Lifetime failed-conclusion count for operator visibility.
  failedCount: number
  // Recent failure timestamps (bounded); the suppression rule counts only the
  // timestamps inside the lookback window so stale streaks decay naturally.
  failedAt: string[]
  lastFailedAt: string
  lastFailedSessionId?: string
  // Redacted, short. Never raw user text.
  lastError?: string
  // Set once per failure streak when the skipped-repeated-failure notice
  // record is written; a new failure re-arms the (single) notice.
  noticeWrittenAt?: string
}

export type MatOSEvolutionFailureLedger = {
  schemaVersion: 1
  updatedAt: string
  entries: Record<string, MatOSEvolutionFailureLedgerEntry>
}

export type MatOSEvolutionFailureSuppressionConfig = {
  enabled: boolean
  threshold: number
  lookbackMs: number
}

export function matOSEvolutionFailureLedgerPath(cwd: string): string {
  return join(matOSEvolutionOpsLedgerDir(cwd), 'failure-ledger.json')
}

function envValue(
  env: Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  const raw = env?.[key] ?? process.env[key]
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

function isDisableFlag(raw: string): boolean {
  return ['0', 'off', 'disabled', 'false', 'none'].includes(raw.toLowerCase())
}

export function matOSEvolutionFailureSuppressionConfig(
  env?: Record<string, string | undefined>,
): MatOSEvolutionFailureSuppressionConfig {
  let enabled = true
  let threshold = DEFAULT_FAILURE_SUPPRESS_THRESHOLD
  const rawThreshold = envValue(env, 'MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD')
  if (rawThreshold !== undefined) {
    if (isDisableFlag(rawThreshold)) {
      enabled = false
    } else {
      const parsed = Number(rawThreshold)
      if (Number.isFinite(parsed) && parsed >= 1) {
        threshold = Math.floor(parsed)
      } else if (Number.isFinite(parsed) && parsed <= 0) {
        enabled = false
      }
    }
  }
  let lookbackMs = DEFAULT_FAILURE_SUPPRESS_HOURS * 60 * 60 * 1000
  const rawHours = envValue(env, 'MATOS_EVOLUTION_FAILURE_SUPPRESS_HOURS')
  if (rawHours !== undefined) {
    if (isDisableFlag(rawHours)) {
      enabled = false
    } else {
      const parsed = Number(rawHours)
      if (Number.isFinite(parsed) && parsed > 0) {
        lookbackMs = Math.floor(parsed * 60 * 60 * 1000)
      } else if (Number.isFinite(parsed) && parsed <= 0) {
        enabled = false
      }
    }
  }
  return { enabled, threshold, lookbackMs }
}

export async function readMatOSEvolutionFailureLedger(
  cwd: string,
): Promise<MatOSEvolutionFailureLedger | undefined> {
  const ledger = await readMatOSEvolutionOpsLedgerFile<MatOSEvolutionFailureLedger>(
    matOSEvolutionFailureLedgerPath(cwd),
  )
  return ledger && typeof ledger === 'object' && ledger.entries ? ledger : undefined
}

function normalizeFailureLedger(
  current: MatOSEvolutionFailureLedger | undefined,
  nowIso: string,
): MatOSEvolutionFailureLedger {
  if (current && typeof current === 'object' && current.entries) {
    return { schemaVersion: 1, updatedAt: nowIso, entries: { ...current.entries } }
  }
  return { schemaVersion: 1, updatedAt: nowIso, entries: {} }
}

function entryTimestampMs(entry: MatOSEvolutionFailureLedgerEntry): number {
  const parsed = Date.parse(entry.lastFailedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function compactFailureLedger(
  ledger: MatOSEvolutionFailureLedger,
  config: MatOSEvolutionFailureSuppressionConfig,
  nowMs: number,
): void {
  const retentionMs = Math.max(FAILURE_LEDGER_MIN_RETENTION_MS, config.lookbackMs * 2)
  for (const [key, entry] of Object.entries(ledger.entries)) {
    if (nowMs - entryTimestampMs(entry) > retentionMs) {
      delete ledger.entries[key]
    }
  }
  const keys = Object.keys(ledger.entries)
  if (keys.length > FAILURE_LEDGER_MAX_ENTRIES) {
    const oldestFirst = keys.sort(
      (left, right) =>
        entryTimestampMs(ledger.entries[left]!) -
        entryTimestampMs(ledger.entries[right]!),
    )
    for (const key of oldestFirst.slice(0, keys.length - FAILURE_LEDGER_MAX_ENTRIES)) {
      delete ledger.entries[key]
    }
  }
}

function failuresInWindow(
  entry: MatOSEvolutionFailureLedgerEntry,
  cutoffMs: number,
): number {
  return (entry.failedAt ?? []).filter(timestamp => {
    const parsed = Date.parse(timestamp)
    return Number.isFinite(parsed) && parsed >= cutoffMs
  }).length
}

function redactedShortError(error: string | undefined): string | undefined {
  if (!error) {
    return undefined
  }
  const redacted = String(redactTraceValue(error)).replace(/\s+/g, ' ').trim()
  if (!redacted) {
    return undefined
  }
  return redacted.length <= FAILURE_LEDGER_MAX_ERROR_CHARS
    ? redacted
    : `${redacted.slice(0, FAILURE_LEDGER_MAX_ERROR_CHARS - 1)}…`
}

// Statuses that prove the pipeline got through to a terminal, non-failed
// conclusion for the trigger, breaking a detected->failed loop. Skip statuses
// are excluded because no pipeline ran; intermediate statuses ('detected',
// 'analysis-complete', 'experience-written') are excluded because the run may
// still fail afterwards.
const FAILURE_CLEARING_STATUSES = new Set<string>([
  'direct-edit-complete',
  'direct-edit-proposed',
  'direct-edit-blocked',
  'direct-edit-import-blocked',
  'noop',
])

// Called for every monitor record the pipeline appends. Cheap: returns without
// I/O for statuses that are neither a failed conclusion nor a clearing
// conclusion, and never throws into the append path.
export async function recordMatOSEvolutionTriggerConclusionInFailureLedger(input: {
  cwd: string
  record: MatOSSelfEvolutionMonitorRecord
  familyKey?: string
  env?: Record<string, string | undefined>
  now?: Date
}): Promise<void> {
  try {
    if (evolutionInfrastructureFailureCode(input.record) || evolutionInfrastructureFailureCode(input.record.directEditorRun ?? {})) return
    const status = input.record.status as string
    if (status === 'failed') {
      await recordFailedConclusion(input)
      return
    }
    if (FAILURE_CLEARING_STATUSES.has(status)) {
      await clearFailureLedgerEntry(input)
    }
  } catch {
    // Ledger maintenance must never break the hidden pipeline.
  }
}

async function recordFailedConclusion(input: {
  cwd: string
  record: MatOSSelfEvolutionMonitorRecord
  familyKey?: string
  env?: Record<string, string | undefined>
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const config = matOSEvolutionFailureSuppressionConfig(input.env)
  const maxTimestamps = Math.max(FAILURE_LEDGER_MIN_TIMESTAMPS, config.threshold)
  await updateMatOSEvolutionOpsLedgerFile<MatOSEvolutionFailureLedger>(
    matOSEvolutionFailureLedgerPath(input.cwd),
    current => {
      const ledger = normalizeFailureLedger(current, nowIso)
      const existing = ledger.entries[input.record.triggerKey]
      // One pipeline run can append several failed records (for example a
      // scoped-asset sync failure followed by a failed critic); count a key at
      // most once per session so failedCount approximates concluded runs.
      const sameSessionEpisode =
        existing !== undefined &&
        existing.lastFailedSessionId === input.record.sessionId
      const entry: MatOSEvolutionFailureLedgerEntry = existing
        ? { ...existing, failedAt: [...(existing.failedAt ?? [])] }
        : {
            triggerKey: input.record.triggerKey,
            familyKey: input.familyKey ?? input.record.triggerKey,
            triggerKind: input.record.triggerKind,
            failedCount: 0,
            failedAt: [],
            lastFailedAt: nowIso,
          }
      if (!sameSessionEpisode) {
        entry.failedCount += 1
        entry.failedAt.push(nowIso)
        if (entry.failedAt.length > maxTimestamps) {
          entry.failedAt = entry.failedAt.slice(-maxTimestamps)
        }
        // A fresh failure re-arms the single suppression notice.
        delete entry.noticeWrittenAt
      }
      entry.lastFailedAt = nowIso
      entry.lastFailedSessionId = input.record.sessionId
      if (input.familyKey) {
        entry.familyKey = input.familyKey
      }
      const shortError = redactedShortError(input.record.error)
      if (shortError) {
        entry.lastError = shortError
      }
      ledger.entries[input.record.triggerKey] = entry
      compactFailureLedger(ledger, config, now.getTime())
      ledger.updatedAt = nowIso
      return ledger
    },
  )
}

async function clearFailureLedgerEntry(input: {
  cwd: string
  record: MatOSSelfEvolutionMonitorRecord
  now?: Date
}): Promise<void> {
  // Fast path: most conclusions have no failure history, so a single small
  // read avoids taking the ledger lock at all.
  const ledger = await readMatOSEvolutionFailureLedger(input.cwd)
  if (!ledger?.entries[input.record.triggerKey]) {
    return
  }
  const nowIso = (input.now ?? new Date()).toISOString()
  await updateMatOSEvolutionOpsLedgerFile<MatOSEvolutionFailureLedger>(
    matOSEvolutionFailureLedgerPath(input.cwd),
    current => {
      const normalized = normalizeFailureLedger(current, nowIso)
      if (!normalized.entries[input.record.triggerKey]) {
        return undefined
      }
      delete normalized.entries[input.record.triggerKey]
      return normalized
    },
  )
}

export type MatOSEvolutionCrossSessionSuppressionResult = {
  suppressed: boolean
  noticeRecord?: MatOSSelfEvolutionMonitorRecord
  failedCountInWindow?: number
}

function repeatedFailureNoticeRecord(input: {
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  entry: MatOSEvolutionFailureLedgerEntry
  windowCount: number
  config: MatOSEvolutionFailureSuppressionConfig
  nowIso: string
}): MatOSSelfEvolutionMonitorRecord {
  const lookbackHours = Math.round((input.config.lookbackMs / 3_600_000) * 10) / 10
  return {
    recordId: `monitor-${randomUUID()}`,
    sessionId: input.sessionId,
    triggerKind: input.trigger.kind,
    triggerKey: input.trigger.key,
    status: MATOS_EVOLUTION_REPEATED_FAILURE_SKIP_STATUS,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    summary:
      `Self-evolution suppressed this trigger: the same trigger key concluded failed ` +
      `${input.windowCount} time(s) across sessions within the last ${lookbackHours}h ` +
      `(threshold ${input.config.threshold}, MATOS_EVOLUTION_FAILURE_SUPPRESS_THRESHOLD/` +
      `MATOS_EVOLUTION_FAILURE_SUPPRESS_HOURS). It will run again after the failure window ` +
      `expires or after a successful conclusion clears the failure ledger.`,
    ...(input.trigger.eventId ? { eventId: input.trigger.eventId } : {}),
    ...(input.entry.lastError ? { error: input.entry.lastError } : {}),
  }
}

// Pipeline-entry check, called after the per-session suppression checks. The
// common path is a single small ledger read; only the first suppression of a
// failure streak takes the ledger lock (to claim the one-time notice) and
// appends a monitor record.
export async function suppressMatOSEvolutionTriggerForRepeatedFailures(input: {
  cwd: string
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  env?: Record<string, string | undefined>
  now?: Date
}): Promise<MatOSEvolutionCrossSessionSuppressionResult> {
  try {
    if (input.trigger.kind === 'manual-evolve') {
      // Operator-invoked triggers must always run.
      return { suppressed: false }
    }
    const config = matOSEvolutionFailureSuppressionConfig(input.env)
    if (!config.enabled) {
      return { suppressed: false }
    }
    const now = input.now ?? new Date()
    const cutoffMs = now.getTime() - config.lookbackMs
    const ledger = await readMatOSEvolutionFailureLedger(input.cwd)
    const entry = ledger?.entries[input.trigger.key]
    if (!entry) {
      return { suppressed: false }
    }
    const windowCount = failuresInWindow(entry, cutoffMs)
    if (windowCount < config.threshold) {
      return { suppressed: false }
    }
    if (entry.noticeWrittenAt) {
      return { suppressed: true, failedCountInWindow: windowCount }
    }
    const nowIso = now.toISOString()
    let claimedNotice = false
    let claimedEntry = entry
    await updateMatOSEvolutionOpsLedgerFile<MatOSEvolutionFailureLedger>(
      matOSEvolutionFailureLedgerPath(input.cwd),
      current => {
        const normalized = normalizeFailureLedger(current, nowIso)
        const currentEntry = normalized.entries[input.trigger.key]
        if (
          !currentEntry ||
          currentEntry.noticeWrittenAt ||
          failuresInWindow(currentEntry, cutoffMs) < config.threshold
        ) {
          return undefined
        }
        normalized.entries[input.trigger.key] = {
          ...currentEntry,
          noticeWrittenAt: nowIso,
        }
        claimedNotice = true
        claimedEntry = currentEntry
        return normalized
      },
    )
    if (!claimedNotice) {
      return { suppressed: true, failedCountInWindow: windowCount }
    }
    const noticeRecord = repeatedFailureNoticeRecord({
      sessionId: input.sessionId,
      trigger: input.trigger,
      entry: claimedEntry,
      windowCount,
      config,
      nowIso,
    })
    await appendMonitorRecord(input.cwd, noticeRecord).catch(() => undefined)
    return { suppressed: true, noticeRecord, failedCountInWindow: windowCount }
  } catch {
    // Fail open: suppression is an optimization and must never block learning
    // outright or break the pipeline entry.
    return { suppressed: false }
  }
}
