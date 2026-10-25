import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMatOSDir } from '../project.js'
import { safeMonitorSessionSegment } from './evolutionMonitor.js'
import { resolveEvolutionRoleTimeoutMs } from './evolutionRoleRunner.js'

type EvolutionTriggerClaimRecord = {
  schemaVersion: 1
  pid: number
  hostId: string
  createdAt: string
  triggerKey: string
  sessionId: string
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
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

function claimPath(
  cwd: string,
  sessionId: string,
  triggerKey: string,
): string {
  return join(
    getMatOSDir(cwd),
    'evolution',
    'monitor',
    'claims',
    safeMonitorSessionSegment(sessionId),
    `${digest(triggerKey).slice(0, 32)}.claim`,
  )
}

function claimStaleMs(): number {
  return resolveEvolutionRoleTimeoutMs() + 5 * 60 * 1000
}

async function tryWriteClaim(
  path: string,
  record: EvolutionTriggerClaimRecord,
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

async function isStaleClaim(
  path: string,
  raw: string | undefined,
): Promise<boolean> {
  if (raw === undefined) {
    const info = await stat(path).catch(() => undefined)
    return info ? Date.now() - info.mtimeMs >= claimStaleMs() : true
  }
  try {
    const record = JSON.parse(raw) as EvolutionTriggerClaimRecord
    if (record.hostId && record.hostId !== currentHostId()) {
      const info = await stat(path).catch(() => undefined)
      return info ? Date.now() - info.mtimeMs >= claimStaleMs() : true
    }
    return !pidLooksAlive(record.pid)
  } catch {
    const info = await stat(path).catch(() => undefined)
    return info ? Date.now() - info.mtimeMs >= claimStaleMs() : true
  }
}

// Atomically reclaim a stale claim. Mirrors assets/history/lock.ts: snapshot the
// stale bytes, steal via rename, then verify we stole the exact record we judged
// stale. If it changed between the read and the rename, another contender already
// took over (wrote a fresh claim), so restore and bail instead of stealing a
// live claim.
async function reclaimStaleClaim(
  path: string,
  record: EvolutionTriggerClaimRecord,
): Promise<boolean> {
  const before = await readFile(path, 'utf8').catch(() => undefined)
  if (!(await isStaleClaim(path, before))) {
    return false
  }
  const stalePath = `${path}.stale-${randomSuffix()}`
  try {
    await rename(path, stalePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
  const after = await readFile(stalePath, 'utf8').catch(() => undefined)
  if (after !== before) {
    await restoreStolenClaimIfTargetMissing(stalePath, path)
    return false
  }
  const acquired = await tryWriteClaim(path, record)
  await rm(stalePath, { force: true }).catch(() => {})
  return acquired
}

async function restoreStolenClaimIfTargetMissing(
  stalePath: string,
  path: string,
): Promise<void> {
  const raw = await readFile(stalePath, 'utf8').catch(() => undefined)
  if (raw === undefined) {
    return
  }
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(raw, 'utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'EEXIST')) {
      throw error
    }
  } finally {
    await rm(stalePath, { force: true }).catch(() => {})
  }
}

async function removeOwnedClaim(
  path: string,
  record: EvolutionTriggerClaimRecord,
): Promise<void> {
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) {
    return
  }
  try {
    const current = JSON.parse(raw) as EvolutionTriggerClaimRecord
    if (
      current.pid === record.pid &&
      current.createdAt === record.createdAt &&
      current.hostId === record.hostId
    ) {
      await rm(path, { force: true }).catch(() => {})
    }
  } catch {
    // Corrupt claim record: leave it for stale reclaim rather than risk deleting
    // a different owner's claim.
  }
}

function randomSuffix(): string {
  return `${process.pid}-${Date.now()}-${randomUUID()}`
}

const CLAIM_STALE_RESIDUE_SWEEP_MAX = 10

// reclaimStaleClaim renames a stale claim aside to `<hash>.claim.stale-*`
// before deleting it; a crash between the rename and the rm leaks that file
// forever, because no later acquire ever looks at stale-suffixed names.
// Bounded best-effort sweep at claim-acquisition time. The claim-stale age
// floor means a reclaim currently in flight (whose renamed file is younger
// or about to be restored) is never raced: fresh residue is left alone.
async function removeStaleClaimResidue(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const staleMs = claimStaleMs()
  let removed = 0
  for (const name of names) {
    if (removed >= CLAIM_STALE_RESIDUE_SWEEP_MAX) {
      return
    }
    if (!name.includes('.claim.stale-')) {
      continue
    }
    const path = join(dir, name)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile() || Date.now() - info.mtimeMs < staleMs) {
      continue
    }
    await rm(path, { force: true }).catch(() => {})
    removed += 1
  }
}

// The retention sweep removes empty per-session claim directories that are
// past its age gate. A claim acquire racing that removal between its mkdir
// and the O_EXCL write sees ENOENT; recreate the directory and retry once
// instead of failing the trigger.
async function tryWriteClaimRecreatingDir(
  path: string,
  record: EvolutionTriggerClaimRecord,
): Promise<boolean> {
  try {
    return await tryWriteClaim(path, record)
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) {
      throw error
    }
    await mkdir(dirname(path), { recursive: true })
    return tryWriteClaim(path, record)
  }
}

async function acquireClaim(input: {
  cwd: string
  sessionId: string
  triggerKey: string
}): Promise<{ path: string; record: EvolutionTriggerClaimRecord } | undefined> {
  const path = claimPath(input.cwd, input.sessionId, input.triggerKey)
  await mkdir(dirname(path), { recursive: true })
  const record: EvolutionTriggerClaimRecord = {
    schemaVersion: 1,
    pid: process.pid,
    hostId: currentHostId(),
    createdAt: new Date().toISOString(),
    triggerKey: input.triggerKey,
    sessionId: input.sessionId,
  }
  if (await tryWriteClaimRecreatingDir(path, record)) {
    return { path, record }
  }
  if (await reclaimStaleClaim(path, record)) {
    return { path, record }
  }
  return undefined
}

export async function withMatOSEvolutionTriggerClaim<T>(
  input: {
    cwd: string
    sessionId: string
    triggerKey: string
  },
  fn: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const acquired = await acquireClaim(input)
  if (!acquired) {
    return undefined
  }
  try {
    return await fn()
  } finally {
    // Only delete the claim if we still own it. If our run outlived the stale
    // window and another process reclaimed the trigger, an unconditional rm
    // would delete the new owner's claim and allow a duplicate run.
    await removeOwnedClaim(acquired.path, acquired.record)
    // Residue sweep runs on release, never on acquire: an extra readdir on
    // the acquire path delays the O_EXCL claim write on slow FUSE mounts,
    // which widens the duplicate-claim race window this module exists to
    // close.
    await removeStaleClaimResidue(dirname(acquired.path)).catch(() => {})
  }
}
