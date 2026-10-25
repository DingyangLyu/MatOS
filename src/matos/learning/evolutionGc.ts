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

// Explicit, plan-first garbage collection for self-evolution storage:
//   1. direct-editor run directories under
//      `.matos/evolution/direct-editor/runs/<run-id>/`
//   2. hidden monitor session directories under the monitor roots
//      (`.matos/evolution/monitor/sessions/<session-id>/` and the configured
//      `MATOS_EVOLUTION_MONITOR_DIR` / `MATOS_SESSION_DIR` roots), plus
//      oversized `records.jsonl` rotation for kept sessions through the same
//      compaction path the append hook already uses.
//
// This complements the bounded opportunistic sweep in
// directAssetEditorRetention.ts (which drains slowly after each finalize):
// gc is operator-invoked, plans the FULL backlog, defaults to dry-run, and
// only deletes when apply is explicitly requested.
//
// A directory survives when EITHER keep rule holds ("whichever keeps MORE"):
//   - age: modified within the trailing keep-days window (default 30), or
//   - count: among the newest keep-runs entries of its root (default 200).
// On top of that, gc never deletes:
//   - the asset-history git dir (`.matos/asset-history.git`; it lives outside
//     both gc roots and every delete target is asserted to stay under a root),
//   - run dirs referenced by an unresolved pending merge or themselves in
//     `pending_merge` status (their evidence is needed by merge apply/abort),
//   - interrupted-checkpoint runs (`edited`/`validated`; recovery authority),
//   - the newest accepted runs (provenance floor, same policy as retention),
//   - anything modified within the last hour (mid-write safety floor).

import type { Dirent } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'
import {
  directEditorRunsDir,
  listMatOSDirectAssetEditorPendingMergeRecords,
  readMatOSDirectAssetEditorRunRecord,
} from './directAssetEditorRecords.js'
import {
  compactMonitorRecordsFileIfOversized,
  monitorRecordsPath,
  resolveMatOSSelfEvolutionMonitorRoots,
} from './evolutionMonitorRecords.js'
import {
  assertPathStaysUnderRoot,
  assertSafeEvolutionRecordId,
} from './evolutionRecordPaths.js'

export const MATOS_EVOLVE_GC_APPLY_ENV = 'MATOS_EVOLVE_GC_APPLY'

export const DEFAULT_EVOLUTION_GC_KEEP_DAYS = 30
export const DEFAULT_EVOLUTION_GC_KEEP_RUNS = 200
const DAY_MS = 24 * 60 * 60 * 1000
// Never touch anything modified within the last hour, regardless of the
// configured keeps: closes races with run dirs that are mid-write and with
// monitor sessions receiving concurrent appends.
const MIN_PRUNE_AGE_MS = 60 * 60 * 1000
// Same provenance floor as directAssetEditorRetention.ts: the newest accepted
// runs are the audit trail of what self-evolution actually changed.
const ACCEPTED_PROVENANCE_KEEP = 20
// run.json re-embeds the full evidence package and can be multi-MB, so the
// newest-accepted discovery scan is read-bounded. When the floor cannot be
// confirmed within the budget, accepted candidates are conservatively kept.
const MAX_ACCEPTED_DISCOVERY_READS = 500
// Mirrors the (unexported) default of monitorRecordsMaxBytes in
// evolutionMonitorRecords.ts; used only to decide which kept sessions to
// report/compact. The compaction itself runs through
// compactMonitorRecordsFileIfOversized, which re-reads its own knobs.
const DEFAULT_MONITOR_RECORDS_MAX_BYTES = 2_000_000
const REMOVE_DIR_ATTEMPTS = 3

export type MatOSEvolutionGcRunPlanEntry = {
  runId: string
  ageDays: number
  status?: string
}

export type MatOSEvolutionGcRunsResult = {
  root: string
  scanned: number
  /** Prune candidates (dry-run plan and apply worklist are identical). */
  planned: MatOSEvolutionGcRunPlanEntry[]
  /** Directories actually removed; empty in dry-run. */
  pruned: string[]
  kept: {
    withinKeepDays: number
    withinKeepRuns: number
    safetyFloor: number
    interrupted: number
    pendingMerge: number
    acceptedProvenance: number
  }
  failures: Array<{ target: string; error: string }>
}

export type MatOSEvolutionGcMonitorRootResult = {
  root: string
  scannedSessions: number
  planned: Array<{ sessionId: string; ageDays: number }>
  pruned: string[]
  /** Kept sessions whose records.jsonl exceeds the rotation threshold. */
  plannedCompactions: string[]
  compacted: string[]
  kept: {
    withinKeepDays: number
    withinKeepRuns: number
    safetyFloor: number
  }
  failures: Array<{ target: string; error: string }>
}

export type MatOSEvolutionGcReport = {
  mode: 'evolution-gc'
  generatedAt: string
  dryRun: boolean
  keepDays: number
  keepRuns: number
  runs: MatOSEvolutionGcRunsResult
  monitor: MatOSEvolutionGcMonitorRootResult[]
  protected: {
    assetHistoryDir: string
    pendingMergeReferencedRuns: number
  }
  notes: string[]
}

export type MatOSEvolutionGcInput = {
  cwd: string
  env?: Record<string, string | undefined>
  now?: number
  keepDays?: number
  keepRuns?: number
  /** false = dry-run (default posture); true = actually delete. */
  apply: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve a gc delete target and refuse anything that would escape the gc
 * root (path separators, `..`, absolute names). Every rm in this module goes
 * through this guard, which is what keeps `.matos/asset-history.git` and any
 * other out-of-root path untouchable even with a hostile directory name.
 */
export function resolveEvolutionGcDeleteTarget(root: string, name: string): string {
  const safe = assertSafeEvolutionRecordId(name, 'evolution gc target')
  return assertPathStaysUnderRoot(root, join(root, safe))
}

/** NFS/FUSE filesystems can throw transient ENOTEMPTY on recursive removal; retry. */
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

type GcDirEntry = { name: string; mtimeMs: number }

async function listAgedSubdirectories(
  root: string,
  basisFile?: string,
): Promise<GcDirEntry[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs: GcDirEntry[] = []
  for (const entry of entries) {
    // Symlinked entries are skipped entirely: following one could reach
    // outside the gc root, so they are neither aged nor deleted.
    if (!entry.isDirectory()) {
      continue
    }
    const basis =
      (basisFile
        ? await stat(join(root, entry.name, basisFile)).catch(() => undefined)
        : undefined) ??
      (await stat(join(root, entry.name)).catch(() => undefined))
    if (!basis) {
      continue
    }
    dirs.push({ name: entry.name, mtimeMs: basis.mtimeMs })
  }
  return dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function splitByKeepRules(input: {
  newestFirst: GcDirEntry[]
  now: number
  keepDays: number
  keepRuns: number
}): {
  candidates: GcDirEntry[]
  kept: { withinKeepDays: number; withinKeepRuns: number; safetyFloor: number }
} {
  const ageCutoff = input.now - input.keepDays * DAY_MS
  const keptByCount = new Set(
    input.newestFirst.slice(0, Math.max(0, input.keepRuns)).map(entry => entry.name),
  )
  const kept = { withinKeepDays: 0, withinKeepRuns: 0, safetyFloor: 0 }
  const candidates: GcDirEntry[] = []
  for (const entry of input.newestFirst) {
    if (entry.mtimeMs >= ageCutoff) {
      kept.withinKeepDays += 1
      continue
    }
    if (keptByCount.has(entry.name)) {
      kept.withinKeepRuns += 1
      continue
    }
    if (input.now - entry.mtimeMs < MIN_PRUNE_AGE_MS) {
      kept.safetyFloor += 1
      continue
    }
    candidates.push(entry)
  }
  // Oldest first: if apply is interrupted, the most stale entries went first.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { candidates, kept }
}

function ageDays(now: number, mtimeMs: number): number {
  return Math.round(((now - mtimeMs) / DAY_MS) * 10) / 10
}

function isAcceptedStatus(status: string): boolean {
  return status === 'accepted' || status === 'accepted_merged'
}

function isInterruptedStatus(status: string): boolean {
  return status === 'edited' || status === 'validated'
}

async function readRunRecordSafe(
  cwd: string,
  runDirName: string,
): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  try {
    return await readMatOSDirectAssetEditorRunRecord(cwd, runDirName)
  } catch {
    return undefined
  }
}

async function gcDirectEditorRuns(input: {
  cwd: string
  now: number
  keepDays: number
  keepRuns: number
  apply: boolean
}): Promise<{ result: MatOSEvolutionGcRunsResult; pendingMergeReferenced: number }> {
  const root = directEditorRunsDir(input.cwd)
  const result: MatOSEvolutionGcRunsResult = {
    root,
    scanned: 0,
    planned: [],
    pruned: [],
    kept: {
      withinKeepDays: 0,
      withinKeepRuns: 0,
      safetyFloor: 0,
      interrupted: 0,
      pendingMerge: 0,
      acceptedProvenance: 0,
    },
    failures: [],
  }
  const newestFirst = await listAgedSubdirectories(root, 'run.json')
  result.scanned = newestFirst.length
  const { candidates, kept } = splitByKeepRules({
    newestFirst,
    now: input.now,
    keepDays: input.keepDays,
    keepRuns: input.keepRuns,
  })
  result.kept.withinKeepDays = kept.withinKeepDays
  result.kept.withinKeepRuns = kept.withinKeepRuns
  result.kept.safetyFloor = kept.safetyFloor

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
  if (candidates.length === 0) {
    return { result, pendingMergeReferenced: pendingMergeRefs.size }
  }

  // Provenance floor: discover the newest accepted runs (newest-first order)
  // so old accepted candidates inside the floor are kept. Discovery stops as
  // soon as the floor is full; when fewer accepted runs exist than the floor
  // size, all accepted candidates are conservatively kept.
  const acceptedKeep = new Set<string>()
  let acceptedFloorComplete = false
  let acceptedDiscoveryReads = 0
  for (const entry of newestFirst) {
    if (acceptedKeep.size >= ACCEPTED_PROVENANCE_KEEP) {
      acceptedFloorComplete = true
      break
    }
    if (acceptedDiscoveryReads >= MAX_ACCEPTED_DISCOVERY_READS) {
      break
    }
    acceptedDiscoveryReads += 1
    const record = await readRunRecordSafe(input.cwd, entry.name)
    if (record && isAcceptedStatus(record.status)) {
      acceptedKeep.add(entry.name)
    }
  }

  for (const candidate of candidates) {
    const record = await readRunRecordSafe(input.cwd, candidate.name)
    if (record) {
      if (isInterruptedStatus(record.status)) {
        result.kept.interrupted += 1
        continue
      }
      if (
        record.status === 'pending_merge' ||
        // A proposal is the only copy of a judged edit until a human decides.
        record.status === 'proposed' ||
        pendingMergeRefs.has(candidate.name) ||
        pendingMergeRefs.has(record.runId)
      ) {
        result.kept.pendingMerge += 1
        continue
      }
      if (isAcceptedStatus(record.status)) {
        if (!acceptedFloorComplete || acceptedKeep.has(candidate.name)) {
          result.kept.acceptedProvenance += 1
          continue
        }
      }
    } else if (pendingMergeRefs.has(candidate.name)) {
      // Unreadable run dir that a pending merge still points at: keep it.
      result.kept.pendingMerge += 1
      continue
    }
    result.planned.push({
      runId: candidate.name,
      ageDays: ageDays(input.now, candidate.mtimeMs),
      ...(record ? { status: record.status } : {}),
    })
    if (!input.apply) {
      continue
    }
    try {
      await removeDirRobust(resolveEvolutionGcDeleteTarget(root, candidate.name))
      result.pruned.push(candidate.name)
    } catch (error) {
      result.failures.push({ target: candidate.name, error: errorMessage(error) })
    }
  }
  return { result, pendingMergeReferenced: pendingMergeRefs.size }
}

async function gcMonitorRoot(input: {
  root: string
  now: number
  keepDays: number
  keepRuns: number
  apply: boolean
}): Promise<MatOSEvolutionGcMonitorRootResult> {
  const result: MatOSEvolutionGcMonitorRootResult = {
    root: input.root,
    scannedSessions: 0,
    planned: [],
    pruned: [],
    plannedCompactions: [],
    compacted: [],
    kept: { withinKeepDays: 0, withinKeepRuns: 0, safetyFloor: 0 },
    failures: [],
  }
  const newestFirst = await listAgedSubdirectories(input.root, 'records.jsonl')
  result.scannedSessions = newestFirst.length
  const { candidates, kept } = splitByKeepRules({
    newestFirst,
    now: input.now,
    keepDays: input.keepDays,
    keepRuns: input.keepRuns,
  })
  result.kept = kept

  const candidateNames = new Set(candidates.map(entry => entry.name))
  for (const candidate of candidates) {
    result.planned.push({
      sessionId: candidate.name,
      ageDays: ageDays(input.now, candidate.mtimeMs),
    })
    if (!input.apply) {
      continue
    }
    try {
      await removeDirRobust(
        resolveEvolutionGcDeleteTarget(input.root, candidate.name),
      )
      result.pruned.push(candidate.name)
    } catch (error) {
      result.failures.push({ target: candidate.name, error: errorMessage(error) })
    }
  }

  // JSONL rotation for kept sessions: reuse the exact compaction/rotation
  // path the append hook runs (records-archive.jsonl with one rotated
  // .1 generation), so an idle-but-oversized session gets bounded too.
  for (const entry of newestFirst) {
    if (candidateNames.has(entry.name)) {
      continue
    }
    const sessionDir = join(input.root, entry.name)
    const recordsPath = monitorRecordsPath(input.root, entry.name)
    const info = await stat(recordsPath).catch(() => undefined)
    if (!info || info.size <= DEFAULT_MONITOR_RECORDS_MAX_BYTES) {
      continue
    }
    result.plannedCompactions.push(entry.name)
    if (!input.apply) {
      continue
    }
    try {
      await compactMonitorRecordsFileIfOversized(sessionDir, recordsPath)
      result.compacted.push(entry.name)
    } catch (error) {
      result.failures.push({ target: entry.name, error: errorMessage(error) })
    }
  }
  return result
}

export async function runMatOSEvolutionGc(
  input: MatOSEvolutionGcInput,
): Promise<MatOSEvolutionGcReport> {
  const now = input.now ?? Date.now()
  const keepDays =
    input.keepDays !== undefined &&
    Number.isFinite(input.keepDays) &&
    input.keepDays >= 0
      ? input.keepDays
      : DEFAULT_EVOLUTION_GC_KEEP_DAYS
  const keepRuns =
    input.keepRuns !== undefined &&
    Number.isFinite(input.keepRuns) &&
    input.keepRuns >= 0
      ? Math.floor(input.keepRuns)
      : DEFAULT_EVOLUTION_GC_KEEP_RUNS

  const { result: runs, pendingMergeReferenced } = await gcDirectEditorRuns({
    cwd: input.cwd,
    now,
    keepDays,
    keepRuns,
    apply: input.apply,
  })

  const monitor: MatOSEvolutionGcMonitorRootResult[] = []
  for (const root of resolveMatOSSelfEvolutionMonitorRoots(
    input.cwd,
    input.env ?? process.env,
  )) {
    monitor.push(
      await gcMonitorRoot({
        root,
        now,
        keepDays,
        keepRuns,
        apply: input.apply,
      }),
    )
  }

  const notes: string[] = []
  if (!input.apply) {
    notes.push(
      'dry-run: nothing was deleted. Re-run with --apply (or MATOS_EVOLVE_GC_APPLY=1) to prune the planned entries.',
    )
  }
  notes.push(
    'a directory is pruned only when it is BOTH older than keep-days AND outside the newest keep-runs entries (whichever rule keeps more wins).',
  )
  notes.push(
    'never deleted: the asset-history git dir, pending-merge-referenced runs, interrupted checkpoints, the newest accepted runs, and anything modified within the last hour.',
  )

  return {
    mode: 'evolution-gc',
    generatedAt: new Date(now).toISOString(),
    dryRun: !input.apply,
    keepDays,
    keepRuns,
    runs,
    monitor,
    protected: {
      assetHistoryDir: join(getMatOSDir(input.cwd), 'asset-history.git'),
      pendingMergeReferencedRuns: pendingMergeReferenced,
    },
    notes,
  }
}
