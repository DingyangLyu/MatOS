import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { getMatOSDir } from '../../project.js'

type MatOSAssetHistoryLockLease = { active: boolean }

// Asset-history operations can call another history-writing operation while
// handling rollback or acceptance. Keep the process-local lease in async
// context so those calls do not wait on the lock they already own, while
// separate processes and unrelated lock keys remain serialized on disk.
const heldAssetHistoryLocks = new AsyncLocalStorage<
  Map<string, MatOSAssetHistoryLockLease>
>()

export type MatOSAssetHistoryLockRecord = {
  schemaVersion: 1
  pid: number
  hostId?: string
  createdAt: string
  operation: string
  runId?: string
}

export type MatOSAssetHistoryLockInput = {
  cwd: string
  operation: string
  runId?: string
  timeoutMs?: number
  pollMs?: number
  staleMs?: number
  foreignHostStaleMs?: number
  // Optional lock namespace for independent scoped transactions. The default
  // remains the historical global lock for callers that mutate the shared
  // asset-history ledger.
  lockKey?: string
  // Only callers that are deliberately handling a nested rollback/cleanup
  // path may re-enter their current async lock. Keep this opt-in: async-local
  // context also propagates to detached child tasks, which must still contend
  // for the on-disk lock as independent writers.
  allowReentrant?: boolean
  // Interval used to refresh the held lock file's mtime. Staleness detection
  // is mtime-based, so long-held critical sections (LLM judge + Gitea pushes
  // during direct-editor finalize) must keep touching the lock or another
  // host will misjudge the live holder as stale and steal the lock.
  heartbeatMs?: number
}

const DEFAULT_LOCK_HEARTBEAT_MS = 60_000

function safeLockKey(lockKey: string): string {
  const normalized = lockKey
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  if (!normalized) {
    throw new Error('MatOS asset history lock key must not be empty')
  }
  // Keep the readable prefix for operator inspection while preventing two
  // distinct scope refs that normalize to the same filename from sharing a
  // lock accidentally.
  const digest = createHash('sha256').update(lockKey).digest('hex').slice(0, 12)
  return `${normalized}-${digest}`
}

export function assetHistoryLockPath(cwd: string, lockKey?: string): string {
  if (lockKey === undefined) {
    return join(getMatOSDir(cwd), 'locks', 'asset-history.lock')
  }
  return join(
    getMatOSDir(cwd),
    'locks',
    'asset-history',
    `${safeLockKey(lockKey)}.lock`,
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseLock(raw: string): MatOSAssetHistoryLockRecord | undefined {
  try {
    return JSON.parse(raw) as MatOSAssetHistoryLockRecord
  } catch {
    return undefined
  }
}

async function readLockRaw(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined)
}

async function readLock(path: string): Promise<MatOSAssetHistoryLockRecord | undefined> {
  const raw = await readLockRaw(path)
  return raw === undefined ? undefined : parseLock(raw)
}

async function lockAgeMs(path: string): Promise<number | undefined> {
  const info = await stat(path).catch(() => undefined)
  return info ? Date.now() - info.mtimeMs : undefined
}

function currentHostId(): string {
  return process.env.HOSTNAME || hostname()
}

function pidLooksAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH')
  }
}

async function tryWriteLock(
  path: string,
  record: MatOSAssetHistoryLockRecord,
): Promise<boolean> {
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

async function isStaleLock(
  path: string,
  raw: string | undefined,
  staleMs: number,
  foreignHostStaleMs = staleMs,
): Promise<boolean> {
  const record = raw === undefined ? undefined : parseLock(raw)
  if (!record) {
    const ageMs = await lockAgeMs(path)
    return ageMs !== undefined && ageMs >= staleMs
  }
  if (record.hostId && record.hostId !== currentHostId()) {
    const ageMs = await lockAgeMs(path)
    return ageMs !== undefined && ageMs >= foreignHostStaleMs
  }
  return !pidLooksAlive(record.pid)
}

// Atomically reclaim a stale lock. Rather than an unconditional rm() (which can
// wipe a fresh lock another contender just acquired), we "steal" the stale file
// via an atomic rename: only the contender whose rename succeeds may take over.
async function reclaimStaleLock(
  path: string,
  staleMs: number,
  foreignHostStaleMs: number,
  record: MatOSAssetHistoryLockRecord,
): Promise<boolean> {
  const before = await readLockRaw(path)
  if (!(await isStaleLock(path, before, staleMs, foreignHostStaleMs))) {
    return false
  }
  const stealPath = `${path}.stealing.${randomUUID()}`
  try {
    await rename(path, stealPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
  // Verify we stole the exact record we judged stale; if it changed between the
  // read and the rename, another contender is managing it, so restore and bail.
  const after = await readLockRaw(stealPath)
  if (after !== before) {
    await restoreStolenLockIfTargetMissingForTests(stealPath, path)
    return false
  }
  const acquired = await tryWriteLock(path, record)
  await rm(stealPath, { force: true })
  return acquired
}

async function restoreStolenLockIfTargetMissing(
  stealPath: string,
  path: string,
): Promise<boolean> {
  const raw = await readLockRaw(stealPath)
  if (raw === undefined) {
    return false
  }
  let restored = false
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(raw, 'utf8')
      restored = true
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'EEXIST')) {
      throw error
    }
  } finally {
    await rm(stealPath, { force: true })
  }
  return restored
}

export const restoreStolenLockIfTargetMissingForTests =
  restoreStolenLockIfTargetMissing

async function removeOwnedLock(
  path: string,
  record: MatOSAssetHistoryLockRecord,
): Promise<void> {
  const current = await readLock(path)
  if (current?.pid === record.pid && current?.createdAt === record.createdAt) {
    await rm(path, { force: true })
  }
}

// Refresh the lock file mtime only while the lock is still ours. A lock that
// was legitimately stolen (or already released) must never be resurrected by a
// stale holder's timer: open('r+') fails instead of creating a file, and the
// rewrite reuses the exact bytes already on disk so a concurrent reader can
// never observe different content. utimes()/futimes() alone are not enough:
// some network filesystems silently ignore them, so the mtime is refreshed by
// rewriting the identical record through the open handle.
async function touchOwnedLock(
  path: string,
  record: MatOSAssetHistoryLockRecord,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r+')
    const raw = await handle.readFile('utf8')
    const current = parseLock(raw)
    if (current?.pid === record.pid && current?.createdAt === record.createdAt) {
      const now = new Date()
      await utimes(path, now, now).catch(() => undefined)
      await handle.write(raw, 0)
    }
  } catch {
    // Missing/stolen lock or a filesystem hiccup: never escalate from the
    // heartbeat timer.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function withMatOSAssetHistoryLock<T>(
  input: MatOSAssetHistoryLockInput,
  fn: () => Promise<T>,
): Promise<T> {
  const path = assetHistoryLockPath(input.cwd, input.lockKey)
  const held = heldAssetHistoryLocks.getStore()
  const heldLease = held?.get(path)
  if (input.allowReentrant && heldLease?.active) {
    return fn()
  }
  const timeoutMs = input.timeoutMs ?? 30_000
  const pollMs = input.pollMs ?? 100
  const staleMs = input.staleMs ?? 30 * 60_000
  const foreignHostStaleMs = input.foreignHostStaleMs ?? staleMs
  const startedAt = Date.now()
  const record: MatOSAssetHistoryLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    hostId: currentHostId(),
    createdAt: new Date().toISOString(),
    operation: input.operation,
    ...(input.runId ? { runId: input.runId } : {}),
  }

  await mkdir(dirname(path), { recursive: true })
  while (true) {
    if (await tryWriteLock(path, record)) {
      break
    }
    if (await reclaimStaleLock(path, staleMs, foreignHostStaleMs, record)) {
      break
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const current = await readLock(path)
      throw new Error(
        `MatOS asset history is locked by ${current?.operation ?? 'unknown'} pid ${
          current?.pid ?? 'unknown'
        }`,
      )
    }
    await sleep(pollMs)
  }

  // Keep the held lock visibly alive: staleness is judged by mtime, and the
  // direct-editor finalize phase can hold the lock across a multi-minute LLM
  // judge plus Gitea pushes, well past foreign-host staleness windows.
  const heartbeatMs = input.heartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS
  const heartbeat = setInterval(() => {
    void touchOwnedLock(path, record).catch(() => undefined)
  }, heartbeatMs)
  heartbeat.unref?.()

  const lease: MatOSAssetHistoryLockLease = { active: true }
  try {
    const nextHeld = new Map(held ?? [])
    nextHeld.set(path, lease)
    return await heldAssetHistoryLocks.run(nextHeld, fn)
  } finally {
    lease.active = false
    clearInterval(heartbeat)
    await removeOwnedLock(path, record)
  }
}
