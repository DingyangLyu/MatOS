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

// Opportunistic retention for the direct asset editor's on-disk records.
//
// Two failure modes drive this module:
//   1. Pending merges (conflict dead-letter queue) accumulate forever because
//      `matos evolve direct-editor merge apply/abort` is manual and nobody
//      runs it. Expired entries are auto-aborted through the SAME abort code
//      path operators use, marked `pending_merge_ttl_expired` so audits can
//      tell auto-expiry from manual aborts.
//   2. Run directories under .matos/evolution/direct-editor/runs grow without
//      bound (run.json re-embeds the full evidence package) and leak
//      `*.json.tmp.<pid>.*` atomic-write temps when a process dies mid-write.
//
// Everything here is best-effort maintenance: bounded work per sweep (network
// filesystems handle long metadata storms poorly), every error swallowed into a debug-safe
// report, and conservative keep rules so recovery/provenance data is never
// sacrificed for disk space.

import type { Dirent } from 'node:fs'
import { readdir, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'
import type {
  MatOSDirectAssetEditorPendingMergeRecord,
  MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import {
  directEditorPendingMergeDir,
  directEditorRunDir,
  directEditorRunsDir,
  listMatOSDirectAssetEditorPendingMergeRecords,
  readMatOSDirectAssetEditorRunRecord,
} from './directAssetEditorRecords.js'

export const MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV =
  'MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS'
export const MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV =
  'MATOS_EVOLUTION_RUN_RETENTION_DAYS'
export const MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV =
  'MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS'

export const DIRECT_EDITOR_PENDING_MERGE_TTL_EXPIRED_REASON =
  'pending_merge_ttl_expired'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_PENDING_MERGE_TTL_DAYS = 14
const DEFAULT_RUN_RETENTION_DAYS = 30
const DEFAULT_RUN_RETENTION_MAX_RUNS = 300
// Bounded work per opportunistic sweep so a large backlog drains
// gradually instead of stalling a finalize hook on filesystem metadata operations.
const DEFAULT_MAX_EXPIRED_PENDING_MERGES_PER_SWEEP = 10
const DEFAULT_MAX_PRUNED_RUN_DIRS_PER_SWEEP = 50
// Provenance floor: the newest accepted runs are the audit trail for what
// self-evolution actually changed; keep them regardless of age.
const ACCEPTED_PROVENANCE_KEEP = 20
// Cap on run.json reads used to discover the newest accepted runs, so the
// provenance floor never degenerates into a full-tree scan of multi-MB
// records. If fewer accepted runs are confirmed within the budget, accepted
// candidates are conservatively kept.
const MAX_ACCEPTED_DISCOVERY_READS = 100
// Absolute safety floor: never delete anything modified within the last hour,
// regardless of configured dimensions. This closes races with a run directory
// that is mid-write (input.json written, run.json not yet) and with pending
// merges being resolved concurrently.
const MIN_PRUNE_AGE_MS = 60 * 60 * 1000
// Leaked atomic-write temps are garbage once the writing call has returned;
// one day of slack comfortably covers any legitimately in-flight write.
const LEAKED_TMP_MAX_AGE_MS = DAY_MS
// Empty per-session claim directories under evolution/monitor/claims/ are
// pure residue: claim files are removed on release (and stale `.claim.stale-*`
// residue is swept at release time), but nothing ever removed the directory
// itself, so long-running deployments accumulate one empty dir per session.
const DEFAULT_MAX_REMOVED_EMPTY_CLAIM_DIRS_PER_SWEEP = 25
// Leak scan is bounded to the most recently active run dirs; older leaked
// temps disappear when their whole run directory is pruned.
const MAX_TMP_SCAN_RUN_DIRS = 50
const REMOVE_DIR_ATTEMPTS = 3

export type MatOSDirectAssetEditorPendingMergeAbortFn = (input: {
  cwd: string
  runId: string
  reason?: string
}) => Promise<{ status: 'aborted' } | undefined>

export type MatOSDirectAssetEditorPendingMergeExpiryResult = {
  status: 'disabled' | 'swept'
  ttlDays?: number
  checked: number
  expired: string[]
  removedAbortedResidue: string[]
  failures: Array<{ runId: string; error: string }>
}

export type MatOSDirectAssetEditorRunRetentionResult = {
  status: 'disabled' | 'swept'
  retentionDays?: number
  maxRuns?: number
  scannedRunDirs: number
  examinedCandidates: number
  prunedRunDirs: string[]
  keptInterrupted: number
  keptPendingMerge: number
  keptAcceptedProvenance: number
  removedLeakedTmpFiles: number
  failures: Array<{ target: string; error: string }>
}

export type MatOSEvolutionClaimDirSweepResult = {
  status: 'swept'
  scannedDirs: number
  removedEmptyDirs: string[]
  failures: Array<{ target: string; error: string }>
}

export type MatOSDirectAssetEditorRetentionReport = {
  pendingMerges:
    | MatOSDirectAssetEditorPendingMergeExpiryResult
    | { status: 'failed'; error: string }
  runDirectories:
    | MatOSDirectAssetEditorRunRetentionResult
    | { status: 'failed'; error: string }
  claimSessionDirs:
    | MatOSEvolutionClaimDirSweepResult
    | { status: 'failed'; error: string }
}

// '0'/'off' (and any non-positive number) disable a dimension; unset/blank or
// unparseable values fall back to the default so retention keeps working when
// an operator typos a knob.
function resolveRetentionLimit(
  env: Record<string, string | undefined> | undefined,
  key: string,
  defaultValue: number,
): number | undefined {
  const raw = env?.[key] ?? process.env[key]
  if (raw === undefined || raw.trim() === '') {
    return defaultValue
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off') {
    return undefined
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) {
    return defaultValue
  }
  if (parsed <= 0) {
    return undefined
  }
  return parsed
}

export function resolveDirectEditorPendingMergeTtlDays(
  env?: Record<string, string | undefined>,
): number | undefined {
  return resolveRetentionLimit(
    env,
    MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS_ENV,
    DEFAULT_PENDING_MERGE_TTL_DAYS,
  )
}

export function resolveDirectEditorRunRetentionDays(
  env?: Record<string, string | undefined>,
): number | undefined {
  return resolveRetentionLimit(
    env,
    MATOS_EVOLUTION_RUN_RETENTION_DAYS_ENV,
    DEFAULT_RUN_RETENTION_DAYS,
  )
}

export function resolveDirectEditorRunRetentionMaxRuns(
  env?: Record<string, string | undefined>,
): number | undefined {
  const resolved = resolveRetentionLimit(
    env,
    MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS_ENV,
    DEFAULT_RUN_RETENTION_MAX_RUNS,
  )
  return resolved === undefined ? undefined : Math.max(1, Math.floor(resolved))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseTimeMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function pendingMergeAgeBasisMs(
  record: MatOSDirectAssetEditorPendingMergeRecord,
): number | undefined {
  return parseTimeMs(record.createdAt) ?? parseTimeMs(record.updatedAt)
}

/**
 * NFS/FUSE-backed roots can throw transient ENOTEMPTY during recursive
 * removal (same failure class as scripts/dist removeDirRobust); retry with
 * backoff and surface the final error to the caller's failure list so the
 * next sweep retries instead of renaming partial trees aside.
 */
async function removeDirRobust(path: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < REMOVE_DIR_ATTEMPTS; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Auto-expire pending merges older than MATOS_EVOLUTION_PENDING_MERGE_TTL_DAYS
 * (default 14; '0'/'off' disables) through the injected abort function, which
 * must be the real `abortMatOSDirectAssetEditorPendingMerge` (injected instead
 * of imported so this module never creates a runtime import cycle with
 * directAssetEditor.ts). The abort path re-checks `status === 'pending'` under
 * the asset-history lock, so concurrent manual applies/aborts stay safe: the
 * loser simply sees no pending record and does nothing.
 *
 * Also removes crash residue: pending-merge directories whose record is
 * already persisted as 'aborted' (a crash between the abort's record write and
 * its directory cleanup) are deleted once they are older than the safety
 * floor.
 */
export async function expireMatOSDirectAssetEditorPendingMerges(input: {
  cwd: string
  abortPendingMerge: MatOSDirectAssetEditorPendingMergeAbortFn
  env?: Record<string, string | undefined>
  now?: number
  maxExpirations?: number
}): Promise<MatOSDirectAssetEditorPendingMergeExpiryResult> {
  const ttlDays = resolveDirectEditorPendingMergeTtlDays(input.env)
  if (ttlDays === undefined) {
    return {
      status: 'disabled',
      checked: 0,
      expired: [],
      removedAbortedResidue: [],
      failures: [],
    }
  }
  const now = input.now ?? Date.now()
  const maxExpirations =
    input.maxExpirations ?? DEFAULT_MAX_EXPIRED_PENDING_MERGES_PER_SWEEP
  const cutoff = now - ttlDays * DAY_MS
  const records = await listMatOSDirectAssetEditorPendingMergeRecords(input.cwd)
  const expired: string[] = []
  const removedAbortedResidue: string[] = []
  const failures: Array<{ runId: string; error: string }> = []

  const expiredPending = records
    .filter(record => record.status === 'pending')
    .map(record => ({ record, ageBasis: pendingMergeAgeBasisMs(record) }))
    // Records without a parseable timestamp are never auto-expired: deleting
    // parked edits of unknown age is how provenance gets lost.
    .filter(
      (item): item is { record: (typeof records)[number]; ageBasis: number } =>
        item.ageBasis !== undefined && item.ageBasis < cutoff,
    )
    .sort((a, b) => a.ageBasis - b.ageBasis)
    .slice(0, Math.max(0, maxExpirations))

  for (const item of expiredPending) {
    try {
      const result = await input.abortPendingMerge({
        cwd: input.cwd,
        runId: item.record.runId,
        reason: DIRECT_EDITOR_PENDING_MERGE_TTL_EXPIRED_REASON,
      })
      if (result?.status === 'aborted') {
        expired.push(item.record.runId)
      }
    } catch (error) {
      failures.push({ runId: item.record.runId, error: errorMessage(error) })
    }
  }

  const abortedResidue = records
    .filter(record => record.status === 'aborted')
    .map(record => ({ record, ageBasis: parseTimeMs(record.updatedAt) }))
    .filter(
      (item): item is { record: (typeof records)[number]; ageBasis: number } =>
        item.ageBasis !== undefined && now - item.ageBasis > MIN_PRUNE_AGE_MS,
    )
    .slice(0, Math.max(0, maxExpirations))
  for (const item of abortedResidue) {
    try {
      await removeDirRobust(
        directEditorPendingMergeDir(input.cwd, item.record.runId),
      )
      removedAbortedResidue.push(item.record.runId)
    } catch (error) {
      failures.push({ runId: item.record.runId, error: errorMessage(error) })
    }
  }

  return {
    status: 'swept',
    ttlDays,
    checked: records.length,
    expired,
    removedAbortedResidue,
    failures,
  }
}

async function readRunRecordSafe(
  cwd: string,
  runDirName: string,
): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  try {
    // Throws synchronously for directory names that fail the record-id safety
    // check; treat those like unreadable records.
    return await readMatOSDirectAssetEditorRunRecord(cwd, runDirName)
  } catch {
    return undefined
  }
}

function isAcceptedStatus(status: MatOSDirectAssetEditorRunRecord['status']): boolean {
  return status === 'accepted' || status === 'accepted_merged'
}

function isInterruptedCheckpointStatus(
  status: MatOSDirectAssetEditorRunRecord['status'],
): boolean {
  return status === 'edited' || status === 'validated'
}

function isLeakedJsonTmpName(name: string): boolean {
  return name.includes('.json.tmp.')
}

type RunDirEntry = { name: string; mtimeMs: number }

async function removeLeakedTmpFiles(input: {
  dir: string
  names: string[]
  now: number
}): Promise<number> {
  let removed = 0
  for (const name of input.names) {
    if (!isLeakedJsonTmpName(name)) {
      continue
    }
    const path = join(input.dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile() || input.now - info.mtimeMs < LEAKED_TMP_MAX_AGE_MS) {
        continue
      }
      await unlink(path)
      removed += 1
    } catch {
      // Concurrent deletion or transient stat failure: leave it for the next
      // sweep rather than reporting noise.
    }
  }
  return removed
}

/**
 * Prune old direct-editor run directories under
 * `<cwd>/.matos/evolution/direct-editor/runs`.
 *
 * A run directory is a prune candidate only when EVERY enabled dimension
 * allows it:
 *   - age: last modification (run.json mtime, falling back to the directory
 *     mtime) older than MATOS_EVOLUTION_RUN_RETENTION_DAYS (default 30)
 *   - count: outside the newest MATOS_EVOLUTION_RUN_RETENTION_MAX_RUNS
 *     (default 300) directories for this cwd
 * '0'/'off' disables a dimension; when both are disabled the sweep is fully
 * disabled (explicit operator opt-out, including leak cleanup).
 *
 * Candidates are then still kept when they are:
 *   - interrupted checkpoints (status 'edited'/'validated'): recovery
 *     authority, never pruned
 *   - referenced by an unresolved pending merge (record status 'pending') or
 *     themselves in status 'pending_merge' or 'proposed' (awaiting approval)
 *   - among the newest ACCEPTED_PROVENANCE_KEEP accepted/accepted_merged runs
 *     (kept regardless of age; when the bounded discovery scan cannot confirm
 *     that many newer accepted runs exist, accepted candidates are kept
 *     conservatively)
 *
 * Work per sweep is bounded: one runs-root listing plus stats for ordering, at
 * most `maxPrunedDirs` candidate reads/deletions (default 50), at most
 * MAX_ACCEPTED_DISCOVERY_READS provenance reads, and a leaked-temp scan over
 * at most MAX_TMP_SCAN_RUN_DIRS of the newest run dirs plus the runs root.
 */
export async function pruneMatOSDirectAssetEditorRunDirectories(input: {
  cwd: string
  env?: Record<string, string | undefined>
  now?: number
  maxPrunedDirs?: number
}): Promise<MatOSDirectAssetEditorRunRetentionResult> {
  const retentionDays = resolveDirectEditorRunRetentionDays(input.env)
  const maxRuns = resolveDirectEditorRunRetentionMaxRuns(input.env)
  const base: MatOSDirectAssetEditorRunRetentionResult = {
    status: 'swept',
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    scannedRunDirs: 0,
    examinedCandidates: 0,
    prunedRunDirs: [],
    keptInterrupted: 0,
    keptPendingMerge: 0,
    keptAcceptedProvenance: 0,
    removedLeakedTmpFiles: 0,
    failures: [],
  }
  if (retentionDays === undefined && maxRuns === undefined) {
    return { ...base, status: 'disabled' }
  }
  const now = input.now ?? Date.now()
  const maxPrunedDirs = Math.max(
    0,
    input.maxPrunedDirs ?? DEFAULT_MAX_PRUNED_RUN_DIRS_PER_SWEEP,
  )
  const runsDir = directEditorRunsDir(input.cwd)
  let entries: Dirent[]
  try {
    entries = await readdir(runsDir, { withFileTypes: true })
  } catch {
    return base
  }

  // Leaked atomic-write temps at the runs root (writeJson temp + crash before
  // rename while targeting a root-level path).
  base.removedLeakedTmpFiles += await removeLeakedTmpFiles({
    dir: runsDir,
    names: entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name),
    now,
  })

  const dirs: RunDirEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const recordStat = await stat(join(runsDir, entry.name, 'run.json')).catch(
      () => undefined,
    )
    const basis =
      recordStat ?? (await stat(join(runsDir, entry.name)).catch(() => undefined))
    if (!basis) {
      continue
    }
    dirs.push({ name: entry.name, mtimeMs: basis.mtimeMs })
  }
  base.scannedRunDirs = dirs.length
  const newestFirst = [...dirs].sort((a, b) => b.mtimeMs - a.mtimeMs)

  // Leaked temps inside the most recently active run dirs (new leaks appear
  // where writes happen; old leaks vanish with their pruned directories).
  for (const dir of newestFirst.slice(0, MAX_TMP_SCAN_RUN_DIRS)) {
    const dirPath = join(runsDir, dir.name)
    let names: string[]
    try {
      names = await readdir(dirPath)
    } catch {
      continue
    }
    base.removedLeakedTmpFiles += await removeLeakedTmpFiles({
      dir: dirPath,
      names,
      now,
    })
  }

  const keptByCount = new Set(
    maxRuns === undefined
      ? []
      : newestFirst.slice(0, maxRuns).map(entry => entry.name),
  )
  const ageCutoff =
    retentionDays === undefined ? undefined : now - retentionDays * DAY_MS
  const candidates = newestFirst
    .filter(entry => now - entry.mtimeMs >= MIN_PRUNE_AGE_MS)
    .filter(entry => (maxRuns === undefined ? true : !keptByCount.has(entry.name)))
    .filter(entry => (ageCutoff === undefined ? true : entry.mtimeMs < ageCutoff))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, maxPrunedDirs)
  if (candidates.length === 0) {
    return base
  }

  // Exclusion set from the pending-merge dead-letter queue: those run dirs
  // hold the before/current/edit evidence a later merge apply/abort needs.
  let pendingMergeRefs: Set<string>
  try {
    pendingMergeRefs = new Set(
      (await listMatOSDirectAssetEditorPendingMergeRecords(input.cwd))
        .filter(record => record.status === 'pending')
        .map(record => record.runId),
    )
  } catch {
    pendingMergeRefs = new Set()
  }

  let acceptedKeep: { keep: Set<string>; complete: boolean } | undefined
  const ensureAcceptedKeep = async (): Promise<{
    keep: Set<string>
    complete: boolean
  }> => {
    if (acceptedKeep) {
      return acceptedKeep
    }
    const keep = new Set<string>()
    let reads = 0
    let complete = false
    for (const entry of newestFirst) {
      if (keep.size >= ACCEPTED_PROVENANCE_KEEP) {
        complete = true
        break
      }
      if (reads >= MAX_ACCEPTED_DISCOVERY_READS) {
        break
      }
      reads += 1
      const record = await readRunRecordSafe(input.cwd, entry.name)
      if (record && isAcceptedStatus(record.status)) {
        keep.add(entry.name)
      }
    }
    acceptedKeep = { keep, complete }
    return acceptedKeep
  }

  for (const candidate of candidates) {
    base.examinedCandidates += 1
    const record = await readRunRecordSafe(input.cwd, candidate.name)
    if (record) {
      if (isInterruptedCheckpointStatus(record.status)) {
        base.keptInterrupted += 1
        continue
      }
      if (
        record.status === 'pending_merge' ||
        // A proposal is the only copy of a judged edit until a human decides.
        record.status === 'proposed' ||
        pendingMergeRefs.has(candidate.name) ||
        pendingMergeRefs.has(record.runId)
      ) {
        base.keptPendingMerge += 1
        continue
      }
      if (isAcceptedStatus(record.status)) {
        const provenance = await ensureAcceptedKeep()
        if (!provenance.complete || provenance.keep.has(candidate.name)) {
          base.keptAcceptedProvenance += 1
          continue
        }
      }
    } else if (pendingMergeRefs.has(candidate.name)) {
      // Run dir may be unreadable, but a pending merge still points at it.
      base.keptPendingMerge += 1
      continue
    }
    try {
      await removeDirRobust(directEditorRunDir(input.cwd, candidate.name))
      base.prunedRunDirs.push(candidate.name)
    } catch (error) {
      base.failures.push({ target: candidate.name, error: errorMessage(error) })
    }
  }
  return base
}

// Mirrors claimPath() in evolutionTriggerClaim.ts; the retention test pins the
// layout by acquiring a real claim through that module.
export function evolutionMonitorClaimsRoot(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'monitor', 'claims')
}

/**
 * Remove empty per-session claim directories under
 * `.matos/evolution/monitor/claims/`. Claim files are already deleted on
 * release and `.claim.stale-*` residue is swept at claim-release time, but
 * the per-session directories themselves accumulated forever.
 *
 * Safety: bounded removals per sweep, an age gate on the directory mtime
 * (claim create/remove updates it, so anything touched within the safety
 * floor is skipped), and a non-recursive rmdir so a claim written between
 * the emptiness check and the removal wins the race (ENOTEMPTY is
 * swallowed). The claim writer additionally retries once on ENOENT after
 * re-creating its directory, so even the losing side of the inverse race is
 * harmless.
 */
export async function removeEmptyMatOSEvolutionClaimSessionDirs(input: {
  cwd: string
  now?: number
  maxRemovals?: number
}): Promise<MatOSEvolutionClaimDirSweepResult> {
  const result: MatOSEvolutionClaimDirSweepResult = {
    status: 'swept',
    scannedDirs: 0,
    removedEmptyDirs: [],
    failures: [],
  }
  const now = input.now ?? Date.now()
  const maxRemovals = Math.max(
    0,
    input.maxRemovals ?? DEFAULT_MAX_REMOVED_EMPTY_CLAIM_DIRS_PER_SWEEP,
  )
  const root = evolutionMonitorClaimsRoot(input.cwd)
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (result.removedEmptyDirs.length >= maxRemovals) {
      break
    }
    if (!entry.isDirectory()) {
      continue
    }
    result.scannedDirs += 1
    const dirPath = join(root, entry.name)
    try {
      const info = await stat(dirPath)
      if (now - info.mtimeMs < MIN_PRUNE_AGE_MS) {
        continue
      }
      if ((await readdir(dirPath)).length > 0) {
        continue
      }
      await rmdir(dirPath)
      result.removedEmptyDirs.push(entry.name)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'EBUSY') {
        // A concurrent claim acquire/release won the race; nothing to report.
        continue
      }
      result.failures.push({ target: entry.name, error: errorMessage(error) })
    }
  }
  return result
}

// One retention pass per cwd at a time within this process: post-run hooks can
// fire in quick succession, and overlapping sweeps would only duplicate stats
// and contend on the same directories.
const retentionInFlight = new Set<string>()

/**
 * Combined opportunistic maintenance pass: pending-merge TTL expiry plus
 * run-directory retention. Never throws; each half reports 'failed' with a
 * message instead. Exported so a CLI surface can later invoke the same sweep
 * explicitly with the real abort implementation injected.
 */
export async function runMatOSDirectAssetEditorRetention(input: {
  cwd: string
  abortPendingMerge: MatOSDirectAssetEditorPendingMergeAbortFn
  env?: Record<string, string | undefined>
  now?: number
  limits?: {
    maxExpiredPendingMerges?: number
    maxPrunedRunDirs?: number
  }
}): Promise<MatOSDirectAssetEditorRetentionReport> {
  if (retentionInFlight.has(input.cwd)) {
    return {
      pendingMerges: { status: 'failed', error: 'retention already in flight' },
      runDirectories: {
        status: 'failed',
        error: 'retention already in flight',
      },
      claimSessionDirs: {
        status: 'failed',
        error: 'retention already in flight',
      },
    }
  }
  retentionInFlight.add(input.cwd)
  try {
    const pendingMerges = await expireMatOSDirectAssetEditorPendingMerges({
      cwd: input.cwd,
      abortPendingMerge: input.abortPendingMerge,
      ...(input.env ? { env: input.env } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.limits?.maxExpiredPendingMerges !== undefined
        ? { maxExpirations: input.limits.maxExpiredPendingMerges }
        : {}),
    }).catch(
      (error: unknown) =>
        ({ status: 'failed', error: errorMessage(error) }) as const,
    )
    const runDirectories = await pruneMatOSDirectAssetEditorRunDirectories({
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(input.limits?.maxPrunedRunDirs !== undefined
        ? { maxPrunedDirs: input.limits.maxPrunedRunDirs }
        : {}),
    }).catch(
      (error: unknown) =>
        ({ status: 'failed', error: errorMessage(error) }) as const,
    )
    const claimSessionDirs = await removeEmptyMatOSEvolutionClaimSessionDirs({
      cwd: input.cwd,
      ...(input.now !== undefined ? { now: input.now } : {}),
    }).catch(
      (error: unknown) =>
        ({ status: 'failed', error: errorMessage(error) }) as const,
    )
    return { pendingMerges, runDirectories, claimSessionDirs }
  } finally {
    retentionInFlight.delete(input.cwd)
  }
}
