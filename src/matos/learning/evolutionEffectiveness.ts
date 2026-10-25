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

/**
 * Post-acceptance observations, not a causal estimate of improvement.
 * Match exact triggers or the same tool failure fingerprint across time
 * buckets. A quiet classification also requires a completed native turn
 * exposed to the exact accepted asset revision and a complete evidence scan.
 * Missing exposure remains unknown; publication alone is never a reward.
 *
 * The module only READS existing record stores:
 * - direct-editor run records via listMatOSDirectAssetEditorRunRecords
 *   (`<cwd>/.matos/evolution/direct-editor/runs/<runId>/run.json`), where the
 *   trigger lives at `input.currentEvolutionContext.trigger.{kind,key}`;
 * - monitor records (`.../evolution/monitor/sessions/<sessionId>/records.jsonl`)
 *   parsed with parseMonitorRecordsJsonl, where each line carries
 *   `triggerKey`, `triggerKind`, `createdAt`, and (for completion records)
 *   `directEditorRunId`.
 *
 * Known trap verified against real records: when a run is accepted, the
 * monitor appends a `direct-edit-complete` record with the SAME trigger key a
 * few milliseconds AFTER the run's acceptance timestamp, carrying
 * `directEditorRunId` equal to the run id. Records whose `directEditorRunId`
 * matches the accepted run are therefore excluded from recurrence matching.
 *
 * Performance is bounded so callers (notably `matos evolve status`) can always
 * compute this: when no accepted runs fall inside the lookback the monitor
 * tree is not touched at all; otherwise session files whose mtime predates the
 * oldest acceptance boundary are skipped (records.jsonl is append-only, so its
 * mtime is an upper bound on every contained `createdAt`), and at most
 * MATOS_EVOLUTION_EFFECTIVENESS_MAX_SESSIONS newest session files are read.
 */

import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'
import { listMatOSDirectAssetEditorRunRecords } from './directAssetEditorRecords.js'
import { observeMatOSEvolutionExposure, type MatOSEvolutionExposure } from './evolutionExposure.js'
import { readEvolutionEvidenceFile } from './evolutionEvidenceRead.js'
import {
  parseMonitorRecordsJsonl,
  resolveMatOSSelfEvolutionMonitorRoots,
} from './evolutionMonitorRecords.js'

export const DEFAULT_EVOLUTION_EFFECTIVENESS_LOOKBACK_DAYS = 30
export const DEFAULT_EVOLUTION_EFFECTIVENESS_MAX_SESSIONS = 500
export const DEFAULT_EVOLUTION_EFFECTIVENESS_MAX_PER_RUN = 50

// records.jsonl mtime and record createdAt come from different clocks
// (filesystem vs process); keep a small slack so a borderline session file is
// scanned rather than wrongly skipped.
const SESSION_MTIME_SLACK_MS = 60_000

const ACCEPTED_STATUSES = new Set<MatOSDirectAssetEditorRunRecord['status']>([
  'accepted',
  'accepted_merged',
])

export type MatOSEvolutionTriggerRecurrenceClassification =
  | 'quiet'
  | 'recurred'
  | 'unknown'

type UnknownReason = 'missing-trigger-key' | 'missing-acceptance-timestamp' | 'no-confirmed-post-acceptance-exposure' | 'incomplete-scan'

export type MatOSEvolutionTriggerRecurrencePerRun = {
  runId: string
  status: string
  scope: string
  triggerKind?: string
  triggerKey?: string
  /** Acceptance boundary used for matching: run.updatedAt (fallback createdAt). */
  acceptedAt?: string
  classification: MatOSEvolutionTriggerRecurrenceClassification
  /** Earliest matching monitor record createdAt after acceptance. */
  recurredAt?: string
  matchedBy?: 'exact-key' | 'tool-failure-fingerprint'
  exposure?: MatOSEvolutionExposure
  /** Distinct session/trigger occurrences, not lifecycle record count. */
  matchingRecordCount?: number
  unknownReason?: UnknownReason
}

export type MatOSEvolutionEffectivenessRecurrence = {
  schemaVersion: 1
  computedAt: string
  lookbackDays: number
  /** Accepted(+merged) runs inside the lookback (undated accepted runs included as unknown). */
  acceptedTotal: number
  quiet: number
  recurred: number
  unknown: number
  /** recurred / (quiet + recurred); 0 when no run could be classified. */
  recurrenceRate: number
  /** Observational coverage, never a causal repair success rate. */
  classifiedTotal: number
  effectivenessProven: false
  exposureScan?: Awaited<ReturnType<typeof observeMatOSEvolutionExposure>>['scan']
  /** Newest-first by acceptance time, capped; aggregates above count all runs. */
  perRun: MatOSEvolutionTriggerRecurrencePerRun[]
  perRunTruncated: boolean
  scan: {
    monitorRoots: number
    /** True when there was nothing to match, so the monitor tree was not read. */
    scanSkipped: boolean
    sessionsSeen: number
    sessionsScanned: number
    sessionsSkippedOldMtime: number
    sessionsSkippedByCap: number
    recordsParsed: number
    unreadable: number
    corrupt: number
    sessionCap: number
    perRunCap: number
  }
}

export type MatOSEvolutionEffectivenessRecurrenceInput = {
  cwd: string
  env?: Record<string, string | undefined>
  /** Injectable clock for tests; defaults to the current time. */
  now?: Date
  /**
   * Pre-loaded direct-editor run records (e.g. from a status handler that
   * already listed them) to avoid re-reading every run.json from disk.
   */
  runs?: MatOSDirectAssetEditorRunRecord[]
}

function positiveNumberEnv(
  env: Record<string, string | undefined> | undefined,
  name: string,
  fallback: number,
): number {
  const parsed = Number(env?.[name])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function positiveIntegerEnv(
  env: Record<string, string | undefined> | undefined,
  name: string,
  fallback: number,
): number {
  return Math.floor(positiveNumberEnv(env, name, fallback))
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Family key for triggers whose exact keys cannot recur verbatim. Tool-failure
 * keys look like `tool-failure:<toolName>:<failureFingerprint>:<timeBucket>`
 * (see evolutionMonitor.ts). Only strip the numeric time bucket: different
 * failure fingerprints for the same tool must not be conflated.
 */
function toolFailureFamilyKey(triggerKey: string): string | undefined {
  const parts = triggerKey.split(':')
  if (parts[0] === 'tool-failure' && parts.length >= 4 && parts.at(-2) && /^\d+$/.test(parts.at(-1)!)) {
    return parts.slice(0, -1).join(':')
  }
  return undefined
}

type AcceptedRunMatchState = {
  run: MatOSDirectAssetEditorRunRecord
  triggerKind?: string
  triggerKey?: string
  familyKey?: string
  acceptedAt?: string
  acceptedAtMs?: number
  unknownReason?: UnknownReason
  exposure?: MatOSEvolutionExposure
  earliestRecurredAt?: string
  matchedBy?: 'exact-key' | 'tool-failure-fingerprint'
  matchingRecordCount: number
}

function acceptedRunMatchState(
  run: MatOSDirectAssetEditorRunRecord,
): AcceptedRunMatchState {
  const trigger = run.input?.currentEvolutionContext?.trigger
  const triggerKey = trigger?.key?.trim() ? trigger.key : undefined
  const acceptedAt = run.updatedAt?.trim() ? run.updatedAt : run.createdAt
  const acceptedAtMs = parseTimestampMs(acceptedAt)
  return {
    run,
    ...(trigger?.kind ? { triggerKind: trigger.kind } : {}),
    ...(triggerKey ? { triggerKey } : {}),
    ...(triggerKey && toolFailureFamilyKey(triggerKey)
      ? { familyKey: toolFailureFamilyKey(triggerKey) }
      : {}),
    ...(acceptedAtMs !== undefined ? { acceptedAt, acceptedAtMs } : {}),
    ...(acceptedAtMs === undefined
      ? { unknownReason: 'missing-acceptance-timestamp' as const }
      : !triggerKey
        ? { unknownReason: 'missing-trigger-key' as const }
        : {}),
    matchingRecordCount: 0,
  }
}

function recordRecurrenceMatch(
  state: AcceptedRunMatchState,
  recordCreatedAt: string,
  matchedBy: 'exact-key' | 'tool-failure-fingerprint',
): void {
  state.matchingRecordCount += 1
  if (
    state.earliestRecurredAt === undefined ||
    recordCreatedAt < state.earliestRecurredAt
  ) {
    state.earliestRecurredAt = recordCreatedAt
    state.matchedBy = matchedBy
  } else if (
    recordCreatedAt === state.earliestRecurredAt &&
    matchedBy === 'exact-key'
  ) {
    state.matchedBy = matchedBy
  }
}

type SessionScanCandidate = {
  recordsPath: string
  mtimeMs: number
}

async function collectSessionCandidates(roots: string[]): Promise<{
  candidates: SessionScanCandidate[]
  sessionsSeen: number
  unreadable: number
}> {
  const candidates: SessionScanCandidate[] = []
  const seenPaths = new Set<string>()
  let sessionsSeen = 0
  let unreadable = 0
  for (const root of roots) {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable++
      continue
    }
    const stats = await Promise.all(
      entries.map(async entry => {
        const recordsPath = join(root, entry, 'records.jsonl')
        try {
          return { recordsPath, info: await lstat(recordsPath) }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable++
          return undefined
        }
      }),
    )
    for (const item of stats) {
      if (item?.info.isSymbolicLink()) unreadable++
      if (!item || !item.info.isFile() || seenPaths.has(item.recordsPath)) {
        continue
      }
      seenPaths.add(item.recordsPath)
      sessionsSeen += 1
      candidates.push({ recordsPath: item.recordsPath, mtimeMs: item.info.mtimeMs })
    }
  }
  return { candidates, sessionsSeen, unreadable }
}

function classify(
  state: AcceptedRunMatchState,
): MatOSEvolutionTriggerRecurrenceClassification {
  if (state.unknownReason) {
    return 'unknown'
  }
  return state.matchingRecordCount > 0 ? 'recurred' : 'quiet'
}

function perRunEntry(
  state: AcceptedRunMatchState,
): MatOSEvolutionTriggerRecurrencePerRun {
  const classification = classify(state)
  return {
    runId: state.run.runId,
    status: state.run.status,
    scope: state.run.scope,
    ...(state.triggerKind ? { triggerKind: state.triggerKind } : {}),
    ...(state.triggerKey ? { triggerKey: state.triggerKey } : {}),
    ...(state.acceptedAt ? { acceptedAt: state.acceptedAt } : {}),
    classification,
    ...(state.exposure ? { exposure: state.exposure } : {}),
    ...(classification === 'recurred' && state.earliestRecurredAt
      ? {
          recurredAt: state.earliestRecurredAt,
          matchedBy: state.matchedBy,
          matchingRecordCount: state.matchingRecordCount,
        }
      : {}),
    ...(state.unknownReason ? { unknownReason: state.unknownReason } : {}),
  }
}

export async function computeMatOSEvolutionEffectivenessRecurrence(
  input: MatOSEvolutionEffectivenessRecurrenceInput,
): Promise<MatOSEvolutionEffectivenessRecurrence> {
  const env = input.env ?? process.env
  const now = input.now ?? new Date()
  const lookbackDays = positiveNumberEnv(
    env,
    'MATOS_EVOLUTION_EFFECTIVENESS_LOOKBACK_DAYS',
    DEFAULT_EVOLUTION_EFFECTIVENESS_LOOKBACK_DAYS,
  )
  const sessionCap = positiveIntegerEnv(
    env,
    'MATOS_EVOLUTION_EFFECTIVENESS_MAX_SESSIONS',
    DEFAULT_EVOLUTION_EFFECTIVENESS_MAX_SESSIONS,
  )
  const perRunCap = positiveIntegerEnv(
    env,
    'MATOS_EVOLUTION_EFFECTIVENESS_MAX_PER_RUN',
    DEFAULT_EVOLUTION_EFFECTIVENESS_MAX_PER_RUN,
  )
  const lookbackStartMs = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000

  const runs = input.runs ?? (await listMatOSDirectAssetEditorRunRecords(input.cwd))
  const states = runs
    .filter(run => ACCEPTED_STATUSES.has(run.status))
    .map(acceptedRunMatchState)
    // Undated accepted runs cannot be placed in the lookback window; keep them
    // visible as unknown instead of silently dropping them.
    .filter(
      state => state.acceptedAtMs === undefined || state.acceptedAtMs >= lookbackStartMs && state.acceptedAtMs <= now.getTime(),
    )

  const matchable = states.filter(state => !state.unknownReason)
  const exactIndex = new Map<string, AcceptedRunMatchState[]>()
  const familyIndex = new Map<string, AcceptedRunMatchState[]>()
  for (const state of matchable) {
    const exact = exactIndex.get(state.triggerKey!) ?? []
    exact.push(state)
    exactIndex.set(state.triggerKey!, exact)
    if (state.familyKey) {
      const family = familyIndex.get(state.familyKey) ?? []
      family.push(state)
      familyIndex.set(state.familyKey, family)
    }
  }

  const scan = {
    monitorRoots: 0,
    scanSkipped: matchable.length === 0,
    sessionsSeen: 0,
    sessionsScanned: 0,
    sessionsSkippedOldMtime: 0,
    sessionsSkippedByCap: 0,
    recordsParsed: 0,
    unreadable: 0,
    corrupt: 0,
    sessionCap,
    perRunCap,
  }

  if (matchable.length > 0) {
    const roots = resolveMatOSSelfEvolutionMonitorRoots(input.cwd, env)
    scan.monitorRoots = roots.length
    const oldestAcceptedAtMs = Math.min(
      ...matchable.map(state => state.acceptedAtMs!),
    )
    const { candidates, sessionsSeen, unreadable } = await collectSessionCandidates(roots)
    scan.sessionsSeen = sessionsSeen
    scan.unreadable += unreadable
    const fresh = candidates.filter(
      candidate =>
        candidate.mtimeMs >= oldestAcceptedAtMs - SESSION_MTIME_SLACK_MS,
    )
    scan.sessionsSkippedOldMtime = candidates.length - fresh.length
    fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const scanned = fresh.slice(0, sessionCap)
    scan.sessionsSkippedByCap = fresh.length - scanned.length
    const seenRecordIds = new Set<string>()
    const seenOccurrences = new Set<string>()
    for (const candidate of scanned) {
      let raw: string
      try {
        raw = await readEvolutionEvidenceFile(candidate.recordsPath)
      } catch {
        scan.unreadable++
        continue
      }
      scan.sessionsScanned += 1
      const records = parseMonitorRecordsJsonl(raw)
      scan.corrupt += raw.split('\n').filter(line => line.trim()).length - records.length
      for (const record of records) {
        scan.recordsParsed += 1
        if (typeof record.triggerKey !== 'string' || typeof record.createdAt !== 'string') {
          scan.corrupt++
          continue
        }
        if (record.recordId) {
          if (seenRecordIds.has(record.recordId)) {
            continue
          }
          seenRecordIds.add(record.recordId)
        }
        const recordCreatedAtMs = parseTimestampMs(record.createdAt)
        if (recordCreatedAtMs === undefined) { scan.corrupt++; continue }
        if (recordCreatedAtMs > now.getTime()) {
          continue
        }
        const matches = new Map<
          AcceptedRunMatchState,
          'exact-key' | 'tool-failure-fingerprint'
        >()
        const recordFamily = toolFailureFamilyKey(record.triggerKey)
        if (recordFamily) {
          for (const state of familyIndex.get(recordFamily) ?? []) {
            matches.set(state, 'tool-failure-fingerprint')
          }
        }
        for (const state of exactIndex.get(record.triggerKey) ?? []) {
          matches.set(state, 'exact-key')
        }
        for (const [state, matchedBy] of matches) {
          // Same-run lifecycle records (e.g. the direct-edit-complete monitor
          // record written milliseconds after acceptance with the same trigger
          // key) are completion bookkeeping, not a new firing of the trigger.
          if (record.directEditorRunId === state.run.runId) {
            continue
          }
          if (recordCreatedAtMs <= state.acceptedAtMs!) {
            continue
          }
          const occurrence = `${state.run.runId}:${record.sessionId}:${record.triggerKey}`
          if (seenOccurrences.has(occurrence)) continue
          seenOccurrences.add(occurrence)
          recordRecurrenceMatch(state, record.createdAt, matchedBy)
        }
      }
    }
  }

  const exposure = await observeMatOSEvolutionExposure({ cwd: input.cwd, runs: matchable.map(state => state.run), env, now, sessionCap })
  for (const state of matchable) {
    state.exposure = exposure.byRun.get(state.run.runId)
    if (!state.matchingRecordCount) {
      if (scan.sessionsSkippedByCap || scan.unreadable || scan.corrupt || !exposure.complete) state.unknownReason = 'incomplete-scan'
      else if (!state.exposure?.revisionConfirmedCompletedTurns) state.unknownReason = 'no-confirmed-post-acceptance-exposure'
    }
  }

  let quiet = 0
  let recurred = 0
  let unknown = 0
  for (const state of states) {
    const classification = classify(state)
    if (classification === 'quiet') {
      quiet += 1
    } else if (classification === 'recurred') {
      recurred += 1
    } else {
      unknown += 1
    }
  }
  const classified = quiet + recurred
  const recurrenceRate =
    classified > 0 ? Math.round((recurred / classified) * 10_000) / 10_000 : 0

  const orderedStates = [...states].sort(
    (a, b) => (b.acceptedAtMs ?? 0) - (a.acceptedAtMs ?? 0),
  )
  const perRun = orderedStates.slice(0, perRunCap).map(perRunEntry)

  return {
    schemaVersion: 1,
    computedAt: now.toISOString(),
    lookbackDays,
    acceptedTotal: states.length,
    quiet,
    recurred,
    unknown,
    recurrenceRate,
    classifiedTotal: classified,
    effectivenessProven: false,
    exposureScan: exposure.scan,
    perRun,
    perRunTruncated: orderedStates.length > perRun.length,
    scan,
  }
}
