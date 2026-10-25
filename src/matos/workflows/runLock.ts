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

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export type WorkflowRunLock = {
  lockDir: string
  metadataPath: string
  /** Random ownership token; release only deletes a lock carrying it. */
  nonce: string
}

export type WorkflowRunLockOptions = {
  owner?: string
  timeoutMs?: number
  pollMs?: number
}

export type WorkflowRunLockInspection = {
  lockDir: string
  metadataPath: string
  state: 'none' | 'held' | 'stale' | 'unreadable'
  owner?: string
  pid?: number
  acquiredAt?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Linux process start time (clock ticks since boot, field 22 of
 * /proc/<pid>/stat). It is a stable identity for the lifetime of a process:
 * when a pid is recycled, the new owner gets a different start time. Returned
 * as the raw string (no numeric conversion needed for an equality check).
 * Undefined when /proc is unavailable (non-Linux) or unreadable.
 */
function procPidStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may contain spaces and parentheses, so the remaining
    // space-separated fields start after the LAST closing parenthesis.
    const closing = stat.lastIndexOf(')')
    if (closing < 0) {
      return undefined
    }
    const fields = stat.slice(closing + 1).trim().split(/\s+/)
    // fields[0] is field 3 (state), so field 22 (starttime) is fields[19].
    const startTime = fields[19]
    return startTime && /^\d+$/.test(startTime) ? startTime : undefined
  } catch {
    return undefined
  }
}

function lockMetadata(
  owner: string | undefined,
  nonce: string,
): Record<string, unknown> {
  const pidStartTime = procPidStartTime(process.pid)
  return {
    owner: owner ?? `pid:${process.pid}`,
    pid: process.pid,
    acquiredAt: nowIso(),
    // Ownership token: release compares it before deleting, so a lock that
    // was reclaimed by another acquirer is never deleted out from under its
    // new holder by the previous one.
    nonce,
    // Identity of the process behind the pid, so a staleness check can tell
    // the live original holder apart from an unrelated process that recycled
    // the pid after the holder died.
    ...(pidStartTime ? { pidStartTime } : {}),
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    // EPERM means the pid exists but belongs to another user; treat as alive.
    return code === 'EPERM'
  }
  // kill(pid, 0) succeeds for an unreaped zombie even though it can no longer
  // own or advance a workflow. PID 1 inside a long-lived container may leave
  // such children around, so treat Linux Z/X states as dead and reclaim their
  // locks. On non-Linux hosts (or when /proc is unavailable), the successful
  // signal probe remains the conservative authority.
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const state = /^State:\s+([A-Z])/m.exec(status)?.[1]
    if (state === 'Z' || state === 'X') {
      return false
    }
  } catch {
    // Fall through: a successful signal probe is safer than reclaiming a lock
    // merely because this platform cannot expose Linux process state.
  }
  return true
}

/**
 * Age backstop for locks whose holder identity cannot be verified. Pids are
 * recycled, so `pidIsAlive` alone can pin a lock forever: after the original
 * holder dies, an unrelated long-lived process may own the same pid and every
 * withWorkflowRunLock caller then times out until someone deletes the lock by
 * hand. When the recorded process start time proves recycling the lock is
 * reclaimed immediately; this threshold only covers locks where that identity
 * is unavailable (locks written by older builds, or hosts without a readable
 * /proc).
 *
 * The value must NOT be sized to "a typical short mutation": resume and
 * initial start advance whole execution segments under this lock
 * (workflowRuntime), so a live holder can legitimately hold it for hours —
 * that case is excluded by the start-time identity check whenever it is
 * verifiable. 10 minutes is 5x the 120s heartbeat stall window run observers
 * use (runPulse WORKFLOW_HEARTBEAT_STALL_SECONDS): far above any short
 * mutation, while still letting a wedged lock self-heal in minutes instead of
 * never. As a second guard for live-but-unverifiable holders (advance
 * segments legitimately exceed any age threshold), the backstop additionally
 * requires the run heartbeat to be stale (see metadataIsStaleForRun).
 */
export const WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS = 10 * 60_000

type WorkflowRunLockMetadata = {
  pid?: unknown
  acquiredAt?: unknown
  pidStartTime?: unknown
}

type WorkflowRunLockStaleness =
  | 'live'
  | 'dead_holder'
  | 'recycled_pid'
  | 'age_backstop'

/**
 * A lock is stale when its recorded holder can no longer be advancing the
 * run:
 * 1. the holder pid is not alive (primary signal, e.g. kill -9 mid-frame), or
 * 2. the pid is alive but its process start time differs from the recorded
 *    one — the pid was recycled by an unrelated process after the holder
 *    died, or
 * 3. holder identity is unverifiable (no recorded start time / no readable
 *    /proc) and the lock is older than the age backstop. This verdict is
 *    reported separately because the holder may in fact be live (non-Linux
 *    hosts, locks written by older builds): callers additionally require the
 *    run heartbeat to be stale before reclaiming on it.
 * A live pid whose start time matches the recorded one is the original
 * holder, and the lock is never treated as stale regardless of age: advance
 * segments legitimately hold it for as long as their nodes run.
 */
function lockMetadataStaleness(
  metadata: WorkflowRunLockMetadata,
): WorkflowRunLockStaleness {
  const pid = Number(metadata.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'live'
  }
  if (!pidIsAlive(pid)) {
    return 'dead_holder'
  }
  const recordedStartTime =
    typeof metadata.pidStartTime === 'string' && metadata.pidStartTime.trim()
      ? metadata.pidStartTime.trim()
      : undefined
  const currentStartTime = procPidStartTime(pid)
  if (recordedStartTime && currentStartTime) {
    // Exact identity available: stale iff the pid was recycled.
    return recordedStartTime !== currentStartTime ? 'recycled_pid' : 'live'
  }
  const acquiredAtMs =
    typeof metadata.acquiredAt === 'string'
      ? Date.parse(metadata.acquiredAt)
      : Number.NaN
  return Number.isFinite(acquiredAtMs) &&
    Date.now() - acquiredAtMs > WORKFLOW_RUN_LOCK_AGE_BACKSTOP_MS
    ? 'age_backstop'
    : 'live'
}

// Keep aligned with runPulse WORKFLOW_HEARTBEAT_STALL_SECONDS (120s: two
// missed 30s stamps plus slack). The heartbeat is read with a local helper
// instead of runPulse's readWorkflowRunHeartbeat because importing runPulse
// here would create a module cycle (runPulse -> runState -> runLock).
const WORKFLOW_RUN_LOCK_HEARTBEAT_STALL_MS = 120_000

/**
 * True when the run dir carries a fresh heartbeat stamped by a live worker.
 * The advancing worker stamps `heartbeat.json` every 30s while it executes,
 * so a fresh stamp is strong evidence that some live process is actively
 * advancing this run even when the lock holder's identity cannot be verified.
 */
async function workflowRunHeartbeatIsLive(runDir: string): Promise<boolean> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDir, 'heartbeat.json'), 'utf8'),
    ) as { pid?: unknown; at?: unknown }
    const atMs = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
    if (
      !Number.isFinite(atMs) ||
      Date.now() - atMs > WORKFLOW_RUN_LOCK_HEARTBEAT_STALL_MS
    ) {
      return false
    }
    const pid = Number(raw.pid)
    if (!Number.isInteger(pid) || pid <= 0) {
      return false
    }
    return pidIsAlive(pid)
  } catch {
    // No heartbeat file (runs from before the pulse layer, or a worker that
    // died before its first stamp): nothing contradicts the age backstop.
    return false
  }
}

/**
 * Full staleness verdict for one lock metadata record, including the P2-4
 * heartbeat gate: the age backstop covers holders whose identity cannot be
 * verified, but such a holder may be live (non-Linux host, old lock format,
 * mid-upgrade). A fresh run heartbeat from a live worker means someone is
 * still actively advancing the run, so the backstop must not steal the lock;
 * once the worker dies the heartbeat goes stale within 120s and the backstop
 * proceeds, preserving self-healing.
 */
async function metadataIsStaleForRun(
  metadata: WorkflowRunLockMetadata,
  runDir: string,
): Promise<boolean> {
  const staleness = lockMetadataStaleness(metadata)
  if (staleness === 'age_backstop') {
    return !(await workflowRunHeartbeatIsLive(runDir))
  }
  return staleness !== 'live'
}

/**
 * Age backstop for lock directories whose metadata never became readable.
 * A crash (or a failed write, e.g. disk full) between `mkdir(lockDir)` and
 * the `lock.json` write leaves a metadata-less lock that no pid/identity
 * check can ever reclaim — without this backstop every later acquirer times
 * out forever until someone deletes the directory by hand. The threshold only
 * needs to exceed the mkdir→writeFile window of a healthy racing acquirer
 * (milliseconds); 60s adds three orders of magnitude of slack for slow
 * network filesystems.
 */
export const WORKFLOW_RUN_LOCK_MISSING_METADATA_BACKSTOP_MS = 60_000

async function lockDirIsAbandoned(lockDir: string): Promise<boolean> {
  try {
    const info = await stat(lockDir)
    return Date.now() - info.mtimeMs > WORKFLOW_RUN_LOCK_MISSING_METADATA_BACKSTOP_MS
  } catch {
    // The lock directory disappeared under us (holder released) — not
    // abandoned; the caller's mkdir retry will settle ownership.
    return false
  }
}

/**
 * Locks without readable metadata are not treated as stale immediately, so a
 * half-written lock from a racing acquirer is never deleted under it. They do
 * become stale once older than the missing-metadata age backstop, because at
 * that point no live acquirer can still be between mkdir and its metadata
 * write.
 */
async function lockIsStale(
  metadataPath: string,
  lockDir: string,
): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(metadataPath, 'utf8')
  } catch {
    return lockDirIsAbandoned(lockDir)
  }
  let metadata: WorkflowRunLockMetadata
  try {
    metadata = JSON.parse(raw) as WorkflowRunLockMetadata
  } catch {
    return lockDirIsAbandoned(lockDir)
  }
  // The lock dir lives directly under the run dir (and so does a reclaim
  // capture, which is a sibling), so the heartbeat gate reads the parent.
  return metadataIsStaleForRun(metadata, dirname(lockDir))
}

export async function inspectWorkflowRunLock(
  runDir: string,
): Promise<WorkflowRunLockInspection> {
  const lockDir = join(runDir, '.run.lock')
  const metadataPath = join(lockDir, 'lock.json')
  let raw: string
  try {
    raw = await readFile(metadataPath, 'utf8')
  } catch {
    // Metadata unreadable: distinguish "no lock at all" from "lock directory
    // exists without metadata". The latter still blocks acquisition (mkdir
    // EEXIST), so reporting it as 'none' would contradict what every mutation
    // observes. Match acquisition's verdict: young enough to be a racing
    // acquirer mid-write -> held; older than the backstop -> stale.
    try {
      await stat(lockDir)
    } catch {
      return { lockDir, metadataPath, state: 'none' }
    }
    return {
      lockDir,
      metadataPath,
      state: (await lockDirIsAbandoned(lockDir)) ? 'stale' : 'unreadable',
    }
  }
  try {
    const metadata = JSON.parse(raw) as WorkflowRunLockMetadata & {
      owner?: unknown
    }
    const pid = Number(metadata.pid)
    const hasPid = Number.isInteger(pid) && pid > 0
    // Same verdict acquisition uses (including the age-backstop heartbeat
    // gate), so diagnosis never disagrees with what a competing acquirer
    // would reclaim.
    const state = (await metadataIsStaleForRun(metadata, runDir))
      ? 'stale'
      : 'held'
    return {
      lockDir,
      metadataPath,
      state,
      ...(typeof metadata.owner === 'string' ? { owner: metadata.owner } : {}),
      ...(hasPid ? { pid } : {}),
      ...(typeof metadata.acquiredAt === 'string'
        ? { acquiredAt: metadata.acquiredAt }
        : {}),
    }
  } catch {
    return { lockDir, metadataPath, state: 'unreadable' }
  }
}

/**
 * A reclaim that has not finished within this window is treated as dead so its
 * leaked mutex directory can be stolen. Reclaim is a read + rm (milliseconds);
 * 30s is three orders of magnitude of slack even on slow network filesystems.
 */
const WORKFLOW_RUN_LOCK_RECLAIM_MUTEX_STALE_MS = 30_000

/**
 * Reclaim a lock directory this acquirer just judged stale, serialized so it
 * can never delete a FRESH lock.
 *
 * Reclaim used to be `rm` then `mkdir`, which has no arbitration: two
 * acquirers that both judged the lock stale (realistic under the recycled-pid
 * and age backstops, with resume/retry/respond mutations racing) could both
 * proceed. A rename-capture-then-restore variant is no better — while a fresh
 * lock is renamed away for re-judging, the lock path is momentarily absent and
 * a third acquirer's `mkdir` succeeds, yielding two live holders.
 *
 * Instead take a reclaim mutex (atomic `mkdir` of a sibling directory): exactly
 * one acquirer makes the read→delete decision at a time. Under the mutex the
 * lock is re-judged and removed ONLY while it is still stale, so a fresh lock
 * created by a competitor that already reclaimed is left untouched. Losers back
 * off and fall through to the ordinary mkdir race / staleness re-check. A
 * reclaimer that dies holding the mutex leaks it; the age backstop lets the
 * next reclaimer steal it after 30s.
 */
export async function reclaimStaleWorkflowRunLock(
  lockDir: string,
): Promise<boolean> {
  const metadataPath = join(lockDir, 'lock.json')
  const mutexDir = `${lockDir}.reclaim`
  try {
    await mkdir(mutexDir)
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
    if (code === 'EEXIST') {
      // Another reclaimer is deciding, or a dead one leaked the mutex. Steal
      // it only once it is provably too old to belong to a live reclaimer.
      try {
        const info = await stat(mutexDir)
        if (
          Date.now() - info.mtimeMs >
          WORKFLOW_RUN_LOCK_RECLAIM_MUTEX_STALE_MS
        ) {
          await rm(mutexDir, { recursive: true, force: true }).catch(() => {})
        }
      } catch {
        // Mutex vanished (holder released it) — nothing to steal.
      }
    }
    // Back off; the caller's loop re-observes the lock (now possibly fresh).
    return false
  }
  try {
    // Re-judge under the mutex: a competitor may have reclaimed since this
    // acquirer's staleness read and created a fresh, live lock. Only remove
    // one that is STILL stale, so a live holder's lock is never deleted.
    if (await lockIsStale(metadataPath, lockDir)) {
      await rm(lockDir, { recursive: true, force: true })
      return true
    }
    return false
  } finally {
    await rm(mutexDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function acquireWorkflowRunLock(
  runDir: string,
  options: WorkflowRunLockOptions,
): Promise<WorkflowRunLock | undefined> {
  const lockDir = join(runDir, '.run.lock')
  const metadataPath = join(lockDir, 'lock.json')
  const timeoutMs = options.timeoutMs ?? 5000
  const pollMs = options.pollMs ?? 25
  const deadline = Date.now() + timeoutMs

  for (;;) {
    let created = false
    try {
      await mkdir(lockDir)
      created = true
      const nonce = randomUUID()
      await writeFile(
        metadataPath,
        `${JSON.stringify(lockMetadata(options.owner, nonce), null, 2)}\n`,
        'utf8',
      )
      return { lockDir, metadataPath, nonce }
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (created) {
        if (code === 'ENOENT') {
          // Our fresh directory vanished between mkdir and the metadata
          // write: a racing reclaimer captured it while re-arbitrating a
          // stale lock at the same path (see reclaimStaleWorkflowRunLock).
          // Ownership was lost cleanly, not corrupted — rejoin the race.
          continue
        }
        // The lock directory is ours but the metadata write failed (e.g.
        // disk full). Leaving it would permanently deadlock the run — no
        // staleness check can reclaim a fresh metadata-less lock — so roll
        // the directory back before surfacing the error.
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      if (code !== 'EEXIST') {
        throw error
      }
      if (await reclaimStaleWorkflowRunLock(lockDir)) {
        // Reclaimers serialize their stale check and removal, so a fresh
        // holder cannot lose its lock to a competing stale verdict.
        continue
      }
      if (Date.now() >= deadline) {
        return undefined
      }
      await delay(pollMs)
    }
  }
}

/**
 * Release only the lock instance we acquired. The nonce comparison prevents
 * the destructive cascade where a holder whose lock was reclaimed (age
 * backstop on identity-less metadata, clock skew, operator intervention)
 * deletes the CURRENT holder's lock on its way out, re-opening the mutual
 * exclusion it no longer owns.
 */
async function releaseWorkflowRunLock(lock: WorkflowRunLock): Promise<void> {
  try {
    const metadata = JSON.parse(
      await readFile(lock.metadataPath, 'utf8'),
    ) as { nonce?: unknown }
    if (typeof metadata.nonce === 'string' && metadata.nonce !== lock.nonce) {
      // The lock was reclaimed and re-acquired by someone else; it is no
      // longer ours to delete.
      return
    }
  } catch {
    // Unreadable/missing metadata: fall through to the delete. Either the
    // directory is already gone (force delete is a no-op) or it carries our
    // half-written state and must not outlive us.
  }
  await rm(lock.lockDir, { recursive: true, force: true }).catch(() => {})
}

export async function withWorkflowRunLock<T>(
  runDir: string,
  fn: (lock: WorkflowRunLock) => Promise<T>,
  options: WorkflowRunLockOptions = {},
): Promise<T> {
  const lock = await acquireWorkflowRunLock(runDir, options)
  if (!lock) {
    throw new Error(`Timed out waiting for workflow run lock: ${runDir}`)
  }
  try {
    return await fn(lock)
  } finally {
    await releaseWorkflowRunLock(lock)
  }
}

// Like withWorkflowRunLock but reports lock contention instead of throwing on
// timeout, so cooperative callers (cancel/pause) can fall back to a control
// marker when a run is actively advancing under another holder.
export async function tryWithWorkflowRunLock<T>(
  runDir: string,
  fn: (lock: WorkflowRunLock) => Promise<T>,
  options: WorkflowRunLockOptions = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lock = await acquireWorkflowRunLock(runDir, options)
  if (!lock) {
    return { acquired: false }
  }
  try {
    return { acquired: true, value: await fn(lock) }
  } finally {
    await releaseWorkflowRunLock(lock)
  }
}
