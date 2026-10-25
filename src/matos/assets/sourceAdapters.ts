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

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { isAbsolute, dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getMatOSDir, readMatOSProjectConfig, type MatOSProjectConfig } from '../project.js'
import type {
  MatOSAssetSourceConfig,
  MatOSGitAssetSourceRuntimeRef,
} from '../project.js'
import { matOSGiteaScopeIdFromScopeRef } from './giteaGovernance.js'
import { matOSGiteaEnvValue } from './giteaOperatorEnv.js'
import {
  DEFAULT_MATOS_GITEA_FILE_SOURCE_ROOT,
  matOSGiteaEquivalentSourceRepos,
  matOSGiteaFileSourceRepoForSource,
  resolveMatOSGitAssetSourceRuntimeRepo,
} from './giteaRuntimeTransport.js'
import { matOSGitProcessEnv } from './gitProcessEnv.js'

const execFileAsync = promisify(execFile)

export const MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV =
  'MATOS_ASSET_SOURCE_PRESERVE_DIRTY'

function preserveDirtyMatOSAssetSourcesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(
    env[MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV]?.trim() ?? '',
  )
}

export type MatOSAssetSourceStatus = {
  id: string
  type: MatOSAssetSourceConfig['type']
  scope: NonNullable<MatOSAssetSourceConfig['scope']>
  refresh: NonNullable<MatOSAssetSourceConfig['refresh']>
  path?: string
  repo?: string
  ref?: string
  subdir?: string
  scopeRef?: string
  provider?: string
  gitea?: Record<string, unknown>
  runtimeRef?: MatOSGitAssetSourceRuntimeRef
  cachePath?: string
  materializedRoot?: string
  exists: boolean
  ok: boolean
  currentRemote?: string
  currentCommit?: string
  error?: string
}

export type MatOSAssetSourceProvenance = {
  sourceId: string
  type: MatOSAssetSourceConfig['type']
  scope: NonNullable<MatOSAssetSourceConfig['scope']>
  scopeRef?: string
  refresh: NonNullable<MatOSAssetSourceConfig['refresh']>
  repo?: string
  ref?: string
  subdir?: string
  provider?: string
  gitea?: Record<string, unknown>
  runtimeRef?: MatOSGitAssetSourceRuntimeRef
  currentRemote?: string
  currentCommit?: string
}

export type MatOSGitAssetSourceCommitResult = {
  ok: boolean
  sourceId: string
  branch: string
  checkoutRoot: string
  action: 'committed' | 'noop'
  dirtyBefore: boolean
  changedPaths: string[]
  commit?: string
  pushed: boolean
}

export function safeMatOSAssetSourceId(id: string): string {
  return id
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'source'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return (
    Boolean(rel) &&
    !rel.startsWith('..') &&
    rel !== '..' &&
    !rel.startsWith(sep)
  )
}

function gitCommandTimeoutMs(): number {
  const parsed = Number(process.env.MATOS_GIT_ASSET_SOURCE_TIMEOUT_MS)
  // Accepted asset checkouts can include thousands of small files on network filesystems.
  // Keep the default long enough for cold workspace preparation while retaining
  // the env override for tests and emergency operator tuning.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000
}

function gitSourceLockTimeoutMs(): number {
  const parsed = Number(process.env.MATOS_GIT_ASSET_SOURCE_LOCK_TIMEOUT_MS)
  // A live lock owner may legitimately hold the lock for one full git command
  // (cold accepted checkouts on network filesystems run up to gitCommandTimeoutMs). Dead
  // owners are still broken after gitSourceLockStaleMs, so a long waiter
  // budget only affects waits on genuinely live work; timing out earlier
  // failed user-visible workspace preparation while a healthy preparation was
  // running on another surface.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000
}

function gitSourceLockStaleMs(): number {
  const parsed = Number(process.env.MATOS_GIT_ASSET_SOURCE_LOCK_STALE_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

function processIsRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readGitSourceLockOwner(lockDir: string): Promise<{
  pid?: number
  host?: string
  createdAtMs?: number
  updatedAtMs?: number
}> {
  try {
    const raw = await readFile(join(lockDir, 'owner.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      pid?: unknown
      host?: unknown
      createdAtMs?: unknown
      updatedAtMs?: unknown
    }
    return {
      ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.createdAtMs === 'number'
        ? { createdAtMs: parsed.createdAtMs }
        : {}),
      ...(typeof parsed.updatedAtMs === 'number'
        ? { updatedAtMs: parsed.updatedAtMs }
        : {}),
    }
  } catch {
    return {}
  }
}

async function writeGitSourceLockOwner(
  lockDir: string,
  createdAtMs: number,
): Promise<void> {
  const ownerPath = join(lockDir, 'owner.json')
  await writeFile(
    ownerPath,
    `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      createdAtMs,
      updatedAtMs: Date.now(),
    })}\n`,
    'utf8',
  )
  await chmodReadablePath(ownerPath, 0o666)
}

// Tracks git-source locks held by the current async execution flow so nested
// operations (for example acceptance calling materialize on the same source)
// re-enter instead of deadlocking on the cross-process directory lock.
const heldGitSourceLocks = new AsyncLocalStorage<Map<string, { active: boolean }>>()

/**
 * Remove a lock directory while tolerating cross-process races. The owner's
 * heartbeat may recreate `owner.json` between the recursive unlink and the
 * final rmdir (ENOTEMPTY/EBUSY), and cross-UID owners can deny the removal
 * (EPERM/EACCES). All of these mean "someone is still using the lock"; the
 * stale sweeper reclaims it later, so never let the race escape as an error.
 */
async function removeGitSourceLockDirBestEffort(lockDir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(lockDir, { recursive: true, force: true })
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return true
      }
      if (
        code !== 'ENOTEMPTY' &&
        code !== 'EBUSY' &&
        code !== 'EPERM' &&
        code !== 'EACCES'
      ) {
        throw error
      }
      if (code === 'EPERM' || code === 'EACCES') {
        return false
      }
      await sleep(50)
    }
  }
  return false
}

async function withGitSourceLock<T>(
  cacheRoot: string,
  sourceId: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockRoot = join(cacheRoot, '.locks')
  const lockDir = join(lockRoot, `${safeMatOSAssetSourceId(sourceId)}.lock`)
  const held = heldGitSourceLocks.getStore()
  if (held?.get(lockDir)?.active) {
    return run()
  }
  await mkdir(lockRoot, { recursive: true })
  await chmodReadablePath(lockRoot, 0o777)
  await removeStaleMatOSGitSourceLocks(lockRoot)
  const start = Date.now()
  const timeoutMs = gitSourceLockTimeoutMs()
  const staleMs = gitSourceLockStaleMs()
  let createdAtMs = 0
  while (true) {
    try {
      await mkdir(lockDir)
      await chmodReadablePath(lockDir, 0o777)
      createdAtMs = Date.now()
      await writeGitSourceLockOwner(lockDir, createdAtMs)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw error
      }
      const owner = await readGitSourceLockOwner(lockDir)
      const lockStat = await stat(lockDir).catch(() => undefined)
      const createdAtMs =
        owner.updatedAtMs ??
        owner.createdAtMs ??
        lockStat?.mtimeMs ??
        lockStat?.ctimeMs ??
        start
      const ageMs = Date.now() - createdAtMs
      const sameHost = owner.host === hostname()
      const ownerAlive =
        sameHost && typeof owner.pid === 'number'
          ? processIsRunning(owner.pid)
          : false
      if (ageMs > staleMs && !ownerAlive) {
        // Only retry immediately when the stale lock was actually removed;
        // an unremovable stale lock (cross-UID residue) must keep flowing
        // into the timeout below instead of spinning forever.
        if (await removeGitSourceLockDirBestEffort(lockDir)) {
          continue
        }
      }
      if (Date.now() - start > timeoutMs) {
        const ownerSummary =
          owner.pid || owner.host || owner.createdAtMs || owner.updatedAtMs
            ? ` owner=${JSON.stringify(owner)} ageMs=${Math.round(ageMs)}`
            : ''
        throw new Error(
          `Timed out waiting for MatOS git asset source lock: ${sourceId}.${ownerSummary}`,
        )
      }
      await sleep(100)
    }
  }

  const heartbeatMs = Math.max(1_000, Math.min(5_000, Math.floor(staleMs / 3)))
  const heartbeat = setInterval(() => {
    void writeGitSourceLockOwner(lockDir, createdAtMs).catch(() => undefined)
  }, heartbeatMs)
  heartbeat.unref?.()
  const lease = { active: true }
  try {
    const nextHeld = new Map(held ?? [])
    nextHeld.set(lockDir, lease)
    return await heldGitSourceLocks.run(nextHeld, run)
  } finally {
    // Detached async descendants retain their context after this operation
    // returns. They must acquire a new lease instead of bypassing a new owner.
    lease.active = false
    clearInterval(heartbeat)
    await removeGitSourceLockDirBestEffort(lockDir)
  }
}

/**
 * Serialize git mutations against one MatOS asset source checkout with the
 * same cross-process lock used by source materialization. Reentrant within
 * one async flow, so a locked operation may call materialize/commit helpers
 * on the same source without deadlocking. Concurrent evolution acceptance,
 * gateway provisioning, and workspace preparation previously raced bare git
 * commands on the same checkout and failed with `.git/index.lock` errors.
 */
export async function withMatOSGitAssetSourceLock<T>(
  cwd: string,
  source: MatOSAssetSourceConfig,
  run: () => Promise<T>,
): Promise<T> {
  if (source.type !== 'git') {
    return run()
  }
  const cacheRoot = matOSAssetSourceCacheRoot(cwd, source)
  await mkdir(cacheRoot, { recursive: true })
  return withGitSourceLock(cacheRoot, source.id, run)
}

const managedGitMetadataLockFiles = [
  'index.lock',
  'config.lock',
  'HEAD.lock',
  'packed-refs.lock',
  'shallow.lock',
  'FETCH_HEAD.lock',
] as const

async function removeManagedGitMetadataLocks(checkoutRoot: string): Promise<void> {
  // Git source checkouts under .matos/source-cache are MatOS-managed caches.
  // A killed checkout/fetch/config update can leave Git metadata locks behind
  // and block every UI workbench read or workspace prepare. Once the MatOS
  // source lock is held, no other MatOS process should be mutating this
  // checkout, so removing these stale Git locks is safe.
  await Promise.all(
    managedGitMetadataLockFiles.map(lockFile =>
      rm(join(checkoutRoot, '.git', lockFile), { force: true }).catch(error => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') {
          return
        }
        throw error
      }),
    ),
  )
}

async function chmodGitSourceCacheTree(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    return
  }
  if (stats.isDirectory()) {
    await chmodReadablePath(path, 0o777)
    const entries = await readdir(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (entries) {
      await Promise.all(
        entries.map(entry => chmodGitSourceCacheTree(join(path, entry))),
      )
    }
    await chmodReadablePath(path, 0o777)
    return
  }
  await chmodReadablePath(path, 0o666)
}

async function chmodGitCheckoutDirectories(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    return
  }
  if (stats.isDirectory()) {
    await chmodReadablePath(path, 0o755)
    const entries = await readdir(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (entries) {
      await Promise.all(
        entries
          // Git metadata is repaired separately. Walking it here makes one
          // recovery traverse the object database twice and is especially
          // expensive on shared filesystems.
          .filter(entry => entry !== '.git')
          .map(entry => chmodGitCheckoutDirectories(join(path, entry))),
      )
    }
    await chmodReadablePath(path, 0o755)
  }
}

async function chmodGitCheckoutTrackedFilesFromIndex(
  checkoutRoot: string,
  options: { token?: string } = {},
): Promise<void> {
  const output = await gitMaybe(checkoutRoot, ['ls-files', '-s', '-z'], options)
  if (!output) {
    return
  }
  await Promise.all(
    output
      .split('\0')
      .filter(Boolean)
      .map(async record => {
        const tab = record.indexOf('\t')
        if (tab < 0) {
          return
        }
        const meta = record.slice(0, tab)
        const filePath = record.slice(tab + 1)
        const mode = meta.split(/\s+/, 1)[0]
        if (mode === '120000' || !filePath) {
          return
        }
        const absolutePath = join(checkoutRoot, filePath)
        if (mode === '100755') {
          await chmodReadablePath(absolutePath, 0o755)
          return
        }
        await chmodReadablePath(absolutePath, 0o644)
      }),
  )
}

async function repairGitCheckoutCachePermissions(
  checkoutRoot: string,
  options: { token?: string } = {},
): Promise<void> {
  await repairPreparedGitCheckoutMetadataPermissions(checkoutRoot, options)
  await chmodGitCheckoutDirectories(checkoutRoot)
  await chmodGitCheckoutTrackedFilesFromIndex(checkoutRoot, options)
  // A full repair is an exceptional recovery operation. Traverse metadata
  // once, after Git may have rewritten config/index files.
  await chmodGitSourceCacheTree(join(checkoutRoot, '.git'))
  await removeManagedGitMetadataLocks(checkoutRoot)
}

/**
 * chmod-only normalization of prepared checkout Git metadata. Safe to run
 * without holding the per-source lock: it never removes Git lock files,
 * rewrites config, or spawns git, so it cannot corrupt a concurrent locked
 * mutation on the same checkout.
 */
async function normalizePreparedGitCheckoutMetadataPermissionsFsOnly(
  checkoutRoot: string,
  acceptedRef?: string,
): Promise<void> {
  const gitRoot = join(checkoutRoot, '.git')
  await chmodReadablePath(checkoutRoot, 0o755)
  await chmodReadablePath(gitRoot, 0o777)
  await Promise.all(
    ['HEAD', 'index', 'config', 'packed-refs', 'FETCH_HEAD'].map(name =>
      chmodReadablePath(join(gitRoot, name), 0o666),
    ),
  )

  const normalizedRef = acceptedRef
    ?.trim()
    .replace(/^refs\/heads\//, '')
  const refParts = normalizedRef
    ?.split('/')
    .filter(part => part && part !== '.' && part !== '..')
  if (refParts?.length && refParts.join('/') === normalizedRef) {
    const headsRoot = join(gitRoot, 'refs', 'heads')
    let current = headsRoot
    await chmodReadablePath(join(gitRoot, 'refs'), 0o777)
    await chmodReadablePath(headsRoot, 0o777)
    for (const part of refParts.slice(0, -1)) {
      current = join(current, part)
      await chmodReadablePath(current, 0o777)
    }
    await chmodReadablePath(join(headsRoot, ...refParts), 0o666)
  }
}

async function repairPreparedGitCheckoutMetadataPermissions(
  checkoutRoot: string,
  options: { token?: string } = {},
  acceptedRef?: string,
): Promise<void> {
  await removeManagedGitMetadataLocks(checkoutRoot)
  await normalizePreparedGitCheckoutMetadataPermissionsFsOnly(
    checkoutRoot,
    acceptedRef,
  )
  const configText = await readFile(join(checkoutRoot, '.git', 'config'), 'utf8')
    .catch(() => undefined)
  if (
    !configText ||
    gitConfigValue(configText, 'core', 'sharedrepository') !== '0666'
  ) {
    await gitMaybe(
      checkoutRoot,
      ['config', 'core.sharedRepository', '0666'],
      options,
    )
  }
  await chmodReadablePath(join(checkoutRoot, '.git', 'config'), 0o666)
  await removeManagedGitMetadataLocks(checkoutRoot)
}

function gitConfigValues(
  text: string,
  wantedSection: string,
  wantedKey: string,
): string[] {
  const values: string[] = []
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sectionMatch) {
      section = sectionMatch[1]!.trim().toLowerCase()
      continue
    }
    if (section !== wantedSection.toLowerCase()) {
      continue
    }
    const valueMatch = line.match(/^\s*([^#;][^=]*?)\s*=\s*(.*?)\s*$/)
    if (!valueMatch || valueMatch[1]!.trim().toLowerCase() !== wantedKey.toLowerCase()) {
      continue
    }
    values.push(valueMatch[2]!)
  }
  return values
}

function gitConfigValue(
  text: string,
  section: string,
  key: string,
): string | undefined {
  return gitConfigValues(text, section, key)[0]
}

async function chmodReadablePath(
  path: string,
  mode: 0o644 | 0o666 | 0o755 | 0o777,
): Promise<void> {
  const current = await lstat(path).catch(error => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return undefined
    }
    if (code === 'EPERM' || code === 'EACCES') {
      // Containers often consume host-prepared Gitea source caches whose
      // ownership belongs to the host/gateway user. Permission normalization is
      // best-effort there; the real mkdir/rm/git operation will surface a
      // meaningful error if the cache is still unusable.
      return undefined
    }
    throw error
  })
  if (!current || (current.mode & 0o777) === mode) {
    return
  }
  await chmod(path, mode).catch(error => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES') {
      return
    }
    throw error
  })
}

async function chmodGitSourceLockTree(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (stats.isSymbolicLink()) {
    return
  }
  if (stats.isDirectory()) {
    await chmodReadablePath(path, 0o777)
    const entries = await readdir(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw error
    })
    if (entries) {
      await Promise.all(
        entries.map(entry => chmodGitSourceLockTree(join(path, entry))),
      )
    }
    await chmodReadablePath(path, 0o777)
    return
  }
  await chmodReadablePath(path, 0o666)
}

async function removeStaleMatOSGitSourceLocks(lockRoot: string): Promise<void> {
  const entries = await readdir(lockRoot, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  if (!entries) {
    return
  }
  await Promise.all(
    entries.map(async entry => {
      if (!entry.isDirectory() || !entry.name.endsWith('.lock')) {
        return
      }
      const lockDir = join(lockRoot, entry.name)
      const owner = await readGitSourceLockOwner(lockDir)
      const lockStat = await stat(lockDir).catch(() => undefined)
      const timestamp =
        owner.updatedAtMs ??
        owner.createdAtMs ??
        lockStat?.mtimeMs ??
        lockStat?.ctimeMs
      if (timestamp === undefined) {
        return
      }
      const ageMs = Date.now() - timestamp
      const sameHost = owner.host === hostname()
      const ownerAlive =
        sameHost && typeof owner.pid === 'number'
          ? processIsRunning(owner.pid)
          : false
      if (ageMs <= gitSourceLockStaleMs() || ownerAlive) {
        return
      }
      await removeGitSourceLockDirBestEffort(lockDir)
    }),
  )
}

async function chmodGitSourceCacheRootDirs(
  cwd: string,
  cacheRoot: string,
): Promise<void> {
  const sourceCacheRoot = join(getMatOSDir(cwd), 'source-cache')
  const rel = relative(sourceCacheRoot, cacheRoot)
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(sep)) {
    return
  }
  const dirs = [sourceCacheRoot]
  let current = sourceCacheRoot
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    dirs.push(current)
  }
  for (const dir of dirs) {
    await chmodReadablePath(dir, 0o755)
  }
}

function gitEnv(options: { token?: string; repo?: string } = {}): NodeJS.ProcessEnv {
  return matOSGitProcessEnv(options)
}

export function resolveMatOSGitSourceToken(token: string | undefined, source: MatOSAssetSourceConfig): string | undefined {
  return (
    token?.trim() ||
    (source.type === 'git' && (source.provider === 'gitea' || source.gitea)
      ? matOSGiteaEnvValue(['MATOS_GITEA_TOKEN', 'MATOS_GATEWAY_GITEA_TOKEN']) : undefined) ||
    undefined
  )
}

function gitSafeDirectories(cwd: string, extraLocalRepos: string[] = []): string[] {
  const directories = new Set<string>()
  const addWithRealpath = (path: string) => {
    const resolved = resolve(path)
    directories.add(resolved)
    try {
      const realDirectory = realpathSync(path)
      if (realDirectory !== resolved) {
        directories.add(realDirectory)
      }
    } catch {
      // Missing checkout roots are handled by the caller; keep the requested
      // path safe so clone/reclone error reporting stays focused on the real
      // failure.
    }
  }
  addWithRealpath(cwd)
  // Local filesystem remotes (e.g. the Gitea data-dir bare repository the
  // host-side workspace preparation substitutes for the HTTP clone URL) are
  // subject to the same git ownership check as the checkout itself. Without
  // marking them safe, `git fetch` from a root-owned gateway process against
  // a gitea-owned bare repo fails with "detected dubious ownership".
  for (const repo of extraLocalRepos) {
    const localDirectory = repo ? localGitSafeDirectory(repo.trim()) : undefined
    if (!localDirectory) {
      continue
    }
    addWithRealpath(localDirectory)
  }
  return [...directories]
}

export function gitSafeDirectoryArgs(cwd: string, extraLocalRepos: string[] = []): string[] {
  return gitSafeDirectories(cwd, extraLocalRepos).flatMap(directory => [
    '-c',
    `safe.directory=${directory}`,
  ])
}

async function git(
  cwd: string,
  args: string[],
  options: { token?: string; localRepos?: string[]; timeoutMs?: number } = {},
): Promise<string> {
  const localRepos = options.localRepos ?? []
  const safeDirectories = gitSafeDirectories(cwd, localRepos)
  const needsInheritedSafeConfig = localRepos.some(repo =>
    Boolean(localGitSafeDirectory(repo.trim())),
  )
  // Keep the throwaway config next to the source cache (like cloneGitSource)
  // instead of defaulting to the root /tmp overlay; fall back to the OS
  // tmpdir only when the cache parent is not writable.
  const tempGitConfigDir = needsInheritedSafeConfig
    ? await mkdtemp(join(dirname(cwd), '.git-safe-')).catch(() =>
        mkdtemp(join(tmpdir(), 'matos-git-safe-')),
      )
    : undefined
  try {
    const authRepo = options.token
      ? options.localRepos?.find(repo => /^https?:\/\//i.test(repo)) ?? String((await execFileAsync('git', [...gitSafeDirectoryArgs(cwd), 'config', '--get', 'remote.origin.url'], { cwd, timeout: 5000 }).catch(() => ({ stdout: '' }))).stdout).trim()
      : undefined
    const env = gitEnv({ ...options, repo: authRepo })
    if (tempGitConfigDir) {
      const configPath = join(tempGitConfigDir, 'gitconfig')
      for (const safeDirectory of safeDirectories) {
        await execFileAsync(
          'git',
          ['config', '--file', configPath, '--add', 'safe.directory', safeDirectory],
          {
            cwd,
            env,
            timeout: gitCommandTimeoutMs(),
          },
        )
      }
      // `git fetch` starts a separate git-upload-pack process for local
      // filesystem remotes. Command-line `-c safe.directory=...` values are
      // not inherited by that child, while GIT_CONFIG_GLOBAL is. Keep the
      // config command-scoped and remove it immediately after the fetch.
      env.GIT_CONFIG_GLOBAL = configPath
    }
    const result = await execFileAsync(
      'git',
      [...gitSafeDirectoryArgs(cwd, localRepos), ...args],
      {
        cwd,
        env,
        timeout: options.timeoutMs ?? gitCommandTimeoutMs(),
        maxBuffer: 20 * 1024 * 1024,
      },
    )
    return String(result.stdout ?? '')
  } finally {
    if (tempGitConfigDir) {
      await rm(tempGitConfigDir, { recursive: true, force: true })
    }
  }
}

async function gitMaybe(
  cwd: string,
  args: string[],
  options: { token?: string; localRepos?: string[] } = {},
): Promise<string | undefined> {
  try {
    return await git(cwd, args, options)
  } catch {
    return undefined
  }
}

function normalizedFetchBranch(ref: string): string | undefined {
  const normalized = ref.trim().replace(/^refs\/heads\//, '')
  if (
    !normalized ||
    normalized === 'HEAD' ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('@{') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)
  ) {
    return undefined
  }
  return normalized
}

/** Fetch only the source ref needed by this materialization. */
async function fetchGitSourceRef(
  checkoutRoot: string,
  ref: string | undefined,
  options: { token?: string; localRepos?: string[] } = {},
): Promise<void> {
  let requested = ref?.trim() || 'HEAD'
  if (requested === 'HEAD') {
    const symref = await gitMaybe(
      checkoutRoot,
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      options,
    )
    requested =
      symref?.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD$/m)?.[1] ?? 'HEAD'
  }

  if (/^[0-9a-f]{40,64}$/i.test(requested)) {
    await git(checkoutRoot, ['fetch', '--no-tags', 'origin', requested], options)
    return
  }

  if (requested.startsWith('refs/tags/')) {
    const tag = requested.slice('refs/tags/'.length)
    await git(
      checkoutRoot,
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/tags/${tag}:refs/tags/${tag}`,
      ],
      options,
    )
    return
  }

  const branch = normalizedFetchBranch(requested)
  if (branch) {
    const fetchedBranch = await gitMaybe(
      checkoutRoot,
      [
        'fetch',
        '--no-tags',
        '--prune',
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      options,
    )
    if (fetchedBranch !== undefined) {
      return
    }
    if (!requested.startsWith('refs/heads/')) {
      const fetchedTag = await gitMaybe(
        checkoutRoot,
        [
          'fetch',
          '--no-tags',
          'origin',
          `+refs/tags/${branch}:refs/tags/${branch}`,
        ],
        options,
      )
      if (fetchedTag !== undefined) {
        return
      }
    }
  }

  // HEAD without a symbolic target is rare. Limit the fallback to origin;
  // never fetch every configured remote.
  await git(checkoutRoot, ['fetch', '--no-tags', '--prune', 'origin'], options)
}

export function matOSAssetSourceCacheRoot(
  cwd: string,
  source?: MatOSAssetSourceConfig,
): string {
  if (source?.type === 'git' && source.scope && source.scopeRef) {
    const scopeId = matOSGiteaScopeIdFromScopeRef(source.scopeRef)
    if (source.scope === 'user') {
      return join(
        getMatOSDir(cwd),
        'source-cache',
        'scopes',
        'users',
        scopeId,
        'git',
      )
    }
    if (source.scope === 'team') {
      return join(
        getMatOSDir(cwd),
        'source-cache',
        'scopes',
        'teams',
        scopeId,
        'git',
      )
    }
    if (source.scope === 'project') {
      return join(
        getMatOSDir(cwd),
        'source-cache',
        'scopes',
        'projects',
        scopeId,
        'git',
      )
    }
  }
  return join(getMatOSDir(cwd), 'source-cache', 'git')
}

export function matOSGitAssetSourceCheckoutRoot(
  cwd: string,
  sourceOrId: string | MatOSAssetSourceConfig,
): string {
  const id = typeof sourceOrId === 'string' ? sourceOrId : sourceOrId.id
  const source = typeof sourceOrId === 'string' ? undefined : sourceOrId
  return join(matOSAssetSourceCacheRoot(cwd, source), safeMatOSAssetSourceId(id))
}

async function ensureLegacyGitSourceCacheAlias(input: {
  cwd: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  checkoutRoot: string
}): Promise<void> {
  const legacyCacheRoot = join(getMatOSDir(input.cwd), 'source-cache', 'git')
  const legacyCheckoutRoot = join(
    legacyCacheRoot,
    safeMatOSAssetSourceId(input.source.id),
  )
  if (resolve(legacyCheckoutRoot) === resolve(input.checkoutRoot)) {
    return
  }

  await mkdir(legacyCacheRoot, { recursive: true })
  await chmodGitSourceCacheRootDirs(input.cwd, legacyCacheRoot)
  const target = relative(legacyCacheRoot, input.checkoutRoot)
  const existing = await lstat(legacyCheckoutRoot).catch(() => undefined)
  if (existing?.isSymbolicLink()) {
    const currentTarget = await readlink(legacyCheckoutRoot).catch(
      () => undefined,
    )
    if (currentTarget === target) {
      return
    }
    await rm(legacyCheckoutRoot, { force: true })
  } else if (existing) {
    if (await pathExists(join(legacyCheckoutRoot, '.git'))) {
      return
    }
    await rm(legacyCheckoutRoot, { recursive: true, force: true })
  }

  try {
    await symlink(target, legacyCheckoutRoot, 'dir')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') {
      throw error
    }
  }
}

export async function repairMatOSGitAssetSourceCachePermissions(
  cwd: string,
  source: MatOSAssetSourceConfig,
  options: { full?: boolean } = {},
): Promise<void> {
  if (source.type !== 'git') {
    return
  }
  const cacheRoot = matOSAssetSourceCacheRoot(cwd, source)
  const checkoutRoot = matOSGitAssetSourceCheckoutRoot(cwd, source)
  await chmodGitSourceCacheRootDirs(cwd, cacheRoot)
  await chmodGitSourceCacheTree(join(cacheRoot, '.locks'))
  await removeStaleMatOSGitSourceLocks(join(cacheRoot, '.locks'))
  await chmodGitSourceLockTree(join(cacheRoot, '.locks'))
  if (options.full === false) {
    await repairPreparedGitCheckoutMetadataPermissions(
      checkoutRoot,
      {},
      source.runtimeRef?.mode === 'accepted-ref'
        ? source.runtimeRef.ref
        : undefined,
    )
  } else {
    await repairGitCheckoutCachePermissions(checkoutRoot)
  }
  await ensureLegacyGitSourceCacheAlias({
    cwd,
    source,
    checkoutRoot,
  })
  await chmodGitSourceCacheRootDirs(cwd, join(getMatOSDir(cwd), 'source-cache', 'git'))
}

function parseGitStatusPaths(status: string): string[] {
  return status
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
}

function gitNumstatHasNoContentChanges(numstat: string): boolean {
  return numstat
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .every(line => {
      const [added, deleted] = line.split(/\s+/, 3)
      return added === '0' && deleted === '0'
    })
}

function gitSummaryContainsOnlyModeChanges(summary: string): boolean {
  const lines = summary
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every(line => line.startsWith('mode change '))
}

async function hasOnlyGitModeChanges(
  checkoutRoot: string,
  options: { token?: string } = {},
): Promise<boolean> {
  const status = await git(checkoutRoot, ['status', '--porcelain'], options)
  const lines = status.split('\n').map(line => line.trimEnd()).filter(Boolean)
  if (lines.length === 0) {
    return false
  }
  if (lines.some(line => line.startsWith('??'))) {
    return false
  }
  const numstat = await git(checkoutRoot, ['diff', '--numstat', 'HEAD'], options)
  if (!gitNumstatHasNoContentChanges(numstat)) {
    return false
  }
  const summary = await git(checkoutRoot, ['diff', '--summary', 'HEAD'], options)
  return gitSummaryContainsOnlyModeChanges(summary)
}

async function currentGitCommit(checkoutRoot: string): Promise<string | undefined> {
  const detachedHead = await readFile(join(checkoutRoot, '.git', 'HEAD'), 'utf8')
    .then(value => value.trim())
    .catch(() => '')
  if (/^[0-9a-f]{40,64}$/i.test(detachedHead)) {
    return detachedHead
  }
  return (await gitMaybe(checkoutRoot, ['rev-parse', 'HEAD']))?.trim()
}

function gitErrorText(error: unknown): string {
  const parts = [
    error instanceof Error ? error.message : String(error),
    typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : undefined,
    typeof (error as { stderr?: unknown })?.stderr === 'string'
      ? (error as { stderr: string }).stderr
      : undefined,
  ]
  return parts.filter(Boolean).join('\n')
}

function gitCheckoutErrorIsRecoverable(error: unknown): boolean {
  const text = gitErrorText(error).toLowerCase()
  return (
    text.includes('unable to write new index file') ||
    text.includes('unable to create') && text.includes('.git/index.lock') ||
    text.includes('could not lock config file') ||
    text.includes('could not lock index') ||
    text.includes('config.lock') ||
    text.includes('index.lock') ||
    text.includes('permission denied') ||
    text.includes('operation not permitted')
  )
}

async function checkoutGitSourceCommitWithRepair(input: {
  checkoutRoot: string
  commit: string
  token?: string
}): Promise<void> {
  const options = input.token ? { token: input.token } : {}
  try {
    await git(
      input.checkoutRoot,
      ['checkout', '--force', '--detach', input.commit],
      options,
    )
    return
  } catch (error) {
    if (!gitCheckoutErrorIsRecoverable(error)) {
      throw error
    }
    await removeManagedGitMetadataLocks(input.checkoutRoot)
    await repairGitCheckoutCachePermissions(input.checkoutRoot, options).catch(
      () => undefined,
    )
    await sleep(250)
    await removeManagedGitMetadataLocks(input.checkoutRoot)
    await git(
      input.checkoutRoot,
      ['checkout', '--force', '--detach', input.commit],
      options,
    )
  }
}

export function matOSGitCleanErrorIsPermissionResidue(error: unknown): boolean {
  const text = gitErrorText(error).toLowerCase()
  return (
    text.includes('permission denied') ||
    text.includes('operation not permitted')
  )
}

export async function matOSGitCheckoutDirtIsUntrackedOnly(
  checkoutRoot: string,
  options: { token?: string } = {},
): Promise<boolean> {
  const status = await gitMaybe(
    checkoutRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    options,
  )
  if (status === undefined) {
    return false
  }
  const lines = status
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
  return lines.every(line => line.startsWith('??'))
}

async function resetGitSourceCheckoutToCommit(input: {
  checkoutRoot: string
  commit: string
  token?: string
}): Promise<void> {
  const options = input.token ? { token: input.token } : {}
  await checkoutGitSourceCommitWithRepair({
    checkoutRoot: input.checkoutRoot,
    commit: input.commit,
    ...(input.token ? { token: input.token } : {}),
  })
  try {
    await git(input.checkoutRoot, ['clean', '-fd'], options)
  } catch (error) {
    if (!gitCheckoutErrorIsRecoverable(error)) {
      throw error
    }
    await removeManagedGitMetadataLocks(input.checkoutRoot)
    await repairGitCheckoutCachePermissions(input.checkoutRoot, options).catch(
      () => undefined,
    )
    await sleep(250)
    await removeManagedGitMetadataLocks(input.checkoutRoot)
    try {
      await git(input.checkoutRoot, ['clean', '-fd'], options)
    } catch (retryError) {
      // Cross-UID residue (for example root-created evolution audit files from
      // host-side provisioning before ownership repair) cannot be removed or
      // chmod'ed from inside the container. The forced checkout above already
      // put tracked content at the requested commit, so when the only leftover
      // dirt is unremovable untracked files, keep the checkout usable instead
      // of permanently failing every role launch and self-evolution run until
      // an operator intervenes. The next host-side ownership repair lets a
      // later clean remove the residue.
      if (
        !matOSGitCleanErrorIsPermissionResidue(retryError) ||
        !(await matOSGitCheckoutDirtIsUntrackedOnly(input.checkoutRoot, options))
      ) {
        throw retryError
      }
    }
  }
}

async function checkoutGitSourceCommit(input: {
  checkoutRoot: string
  sourceId: string
  commit: string
  token?: string
  forceResetDirty?: boolean
  preserveDirty?: boolean
}): Promise<void> {
  const options = input.token ? { token: input.token } : {}
  let needsPermissionRepair = true
  try {
    if (input.preserveDirty) {
      const currentCommit = await currentGitCommit(input.checkoutRoot)
      if (currentCommit === input.commit) {
        // Trusted asset-editor validation needs to inspect the saved working
        // tree without turning it into runtime truth or erasing it. The caller
        // enables this only for that validation subprocess; ordinary runtime
        // materialization continues to clean accepted checkouts fail-closed.
        needsPermissionRepair = false
        return
      }
    }
    if (input.forceResetDirty) {
      const currentCommit = await currentGitCommit(input.checkoutRoot)
      if (currentCommit === input.commit) {
        const status = await git(input.checkoutRoot, ['status', '--porcelain'], options)
        if (!status.trim()) {
          needsPermissionRepair = false
          return
        }
      }
      await resetGitSourceCheckoutToCommit({
        checkoutRoot: input.checkoutRoot,
        commit: input.commit,
        ...(input.token ? { token: input.token } : {}),
      })
      return
    }
    const status = await git(input.checkoutRoot, ['status', '--porcelain'], {
      ...(input.token ? { token: input.token } : {}),
    })
    const dirtyPaths = parseGitStatusPaths(status)
    if (dirtyPaths.length > 0) {
      const trackedFiles = (
        await gitMaybe(input.checkoutRoot, ['ls-files'], {
          ...(input.token ? { token: input.token } : {}),
        })
      )?.trim()
      if (!trackedFiles) {
        await resetGitSourceCheckoutToCommit({
          checkoutRoot: input.checkoutRoot,
          commit: input.commit,
          ...(input.token ? { token: input.token } : {}),
        })
        return
      }
      const currentCommit = await currentGitCommit(input.checkoutRoot)
      if (currentCommit === input.commit) {
        await resetGitSourceCheckoutToCommit({
          checkoutRoot: input.checkoutRoot,
          commit: input.commit,
          ...(input.token ? { token: input.token } : {}),
        })
        return
      }
      if (
        await hasOnlyGitModeChanges(input.checkoutRoot, {
          ...(input.token ? { token: input.token } : {}),
        })
      ) {
        await resetGitSourceCheckoutToCommit({
          checkoutRoot: input.checkoutRoot,
          commit: input.commit,
          ...(input.token ? { token: input.token } : {}),
        })
        return
      }
      throw new Error(
        `MatOS git asset source ${input.sourceId} has uncommitted changes; refusing to switch from ${currentCommit ?? 'unknown'} to ${input.commit}`,
      )
    }
    await resetGitSourceCheckoutToCommit({
      checkoutRoot: input.checkoutRoot,
      commit: input.commit,
      ...(input.token ? { token: input.token } : {}),
    })
  } finally {
    if (needsPermissionRepair) {
      await repairGitCheckoutCachePermissions(input.checkoutRoot, options).catch(
        () => undefined,
      )
    }
  }
}

function localGitSafeDirectory(repo: string): string | undefined {
  if (isAbsolute(repo)) {
    return repo
  }
  if (repo.startsWith('file://')) {
    try {
      return fileURLToPath(repo)
    } catch {
      return undefined
    }
  }
  return undefined
}

async function cloneGitSource(input: {
  cwd: string
  repo: string
  checkoutRoot: string
  token?: string
}): Promise<void> {
  await removeGitSourceCheckoutForReclone(input.checkoutRoot)
  const safeDirectory = localGitSafeDirectory(input.repo)
  const tempGitConfigDir = safeDirectory
    ? await mkdtemp(join(dirname(input.checkoutRoot), '.git-safe-'))
    : undefined
  try {
    const env = gitEnv({ token: input.token, repo: input.repo })
    if (safeDirectory && tempGitConfigDir) {
      const configPath = join(tempGitConfigDir, 'gitconfig')
      await execFileAsync(
        'git',
        ['config', '--file', configPath, '--add', 'safe.directory', safeDirectory],
        {
          cwd: input.cwd,
          env,
          timeout: gitCommandTimeoutMs(),
        },
      )
      env.GIT_CONFIG_GLOBAL = configPath
    }
    // --no-hardlinks: local-path clones (Gitea bare repository store,
    // deployment-root mirrors) must not hardlink object files into
    // scope-owned source caches. A shared inode carries the store owner into
    // every user cache, and any per-scope ownership repair then rewrites the
    // owner inside the store and all sibling caches at once, so
    // ownership never converges across scopes.
    await execFileAsync(
      'git',
      ['clone', '--no-checkout', '--no-hardlinks', input.repo, input.checkoutRoot],
      {
        cwd: input.cwd,
        env,
        timeout: gitCommandTimeoutMs(),
        maxBuffer: 20 * 1024 * 1024,
      },
    )
  } finally {
    if (tempGitConfigDir) {
      await rm(tempGitConfigDir, { recursive: true, force: true })
    }
  }
}

function gitErrorSaysNoSuchRemote(error: unknown): boolean {
  return gitErrorText(error).toLowerCase().includes('no such remote')
}

/**
 * Point `origin` at the requested repo, recreating the remote when a previous
 * cross-process config write race clobbered the `[remote "origin"]` section.
 * A checkout whose config lost origin otherwise fails `remote set-url` with
 * "No such remote 'origin'" on every preparation cycle until an operator
 * repairs the file by hand.
 */
export async function setMatOSGitSourceOriginRemote(input: {
  checkoutRoot: string
  repo: string
  token?: string
}): Promise<void> {
  const configText = await readFile(
    join(input.checkoutRoot, '.git', 'config'),
    'utf8',
  ).catch(() => undefined)
  if (
    configText &&
    gitConfigValue(configText, 'remote "origin"', 'url') === input.repo &&
    gitConfigValues(configText, 'remote "origin"', 'fetch').some(value =>
      value.trim(),
    )
  ) {
    return
  }
  const options = input.token ? { token: input.token } : {}
  try {
    await git(
      input.checkoutRoot,
      ['remote', 'set-url', 'origin', input.repo],
      options,
    )
  } catch (error) {
    if (!gitErrorSaysNoSuchRemote(error)) {
      throw error
    }
    await git(
      input.checkoutRoot,
      ['remote', 'add', 'origin', input.repo],
      options,
    )
  }
  const fetchSpec = await gitMaybe(
    input.checkoutRoot,
    ['config', '--get-all', 'remote.origin.fetch'],
    options,
  )
  if (!fetchSpec?.trim()) {
    // A partially clobbered config can keep the URL but lose the fetch
    // refspec; restore the default mapping so branch fetch fallbacks work.
    await gitMaybe(
      input.checkoutRoot,
      ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      options,
    )
  }
}

async function ensureGitSourceRemote(input: {
  cwd: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  repo: string
  checkoutRoot: string
  token?: string
}): Promise<void> {
  if (!(await pathExists(join(input.checkoutRoot, '.git')))) {
    await cloneGitSource(input)
    return
  }

  const currentRemote = (
    await gitMaybe(input.checkoutRoot, ['remote', 'get-url', 'origin'])
  )?.trim()
  if (currentRemote === input.repo) {
    return
  }

  if (
    currentRemote &&
    gitSourceRemoteIsEquivalentTransport({
      cwd: input.cwd,
      source: input.source,
      currentRemote,
      requestedRepo: input.repo,
    })
  ) {
    await repairGitCheckoutCachePermissions(input.checkoutRoot, {
      ...(input.token ? { token: input.token } : {}),
    }).catch(() => undefined)
    await setMatOSGitSourceOriginRemote({
      checkoutRoot: input.checkoutRoot,
      repo: input.repo,
      ...(input.token ? { token: input.token } : {}),
    })
    return
  }

  await removeGitSourceCheckoutForReclone(input.checkoutRoot)
  await cloneGitSource(input)
}

async function updateEquivalentGitSourceRemote(input: {
  cwd: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  repo: string
  checkoutRoot: string
  token?: string
}): Promise<void> {
  if (!(await pathExists(join(input.checkoutRoot, '.git')))) {
    return
  }
  const currentRemote = (
    await gitMaybe(input.checkoutRoot, ['remote', 'get-url', 'origin'])
  )?.trim()
  if ((input.source.repo.startsWith('./') || input.source.repo.startsWith('../')) && currentRemote !== input.repo) {
    // A moved standalone workspace carries its bare repository and cache
    // together. Git persisted the old absolute origin during clone; use the
    // workspace-relative source configuration as the transport authority.
    await setMatOSGitSourceOriginRemote({ checkoutRoot: input.checkoutRoot, repo: input.repo })
    return
  }
  if (!currentRemote) {
    // A cross-process config write race can strip the origin remote from a
    // Gitea-managed checkout. The accepted runtimeRef commit checks still
    // verify content, so restoring origin here is safe and turns a permanent
    // per-user failure loop into a self-healing step.
    if (input.source.provider === 'gitea' || input.source.gitea) {
      await setMatOSGitSourceOriginRemote({
        checkoutRoot: input.checkoutRoot,
        repo: input.repo,
        ...(input.token ? { token: input.token } : {}),
      }).catch(() => undefined)
    }
    return
  }
  if (currentRemote === input.repo) {
    return
  }
  if (
    gitSourceRemoteIsEquivalentTransport({
      cwd: input.cwd,
      source: input.source,
      currentRemote,
      requestedRepo: input.repo,
    })
  ) {
    await repairGitCheckoutCachePermissions(input.checkoutRoot, {
      ...(input.token ? { token: input.token } : {}),
    }).catch(() => undefined)
    await setMatOSGitSourceOriginRemote({
      checkoutRoot: input.checkoutRoot,
      repo: input.repo,
      ...(input.token ? { token: input.token } : {}),
    })
  }
}

export async function syncMatOSGitAssetSourceOriginRemote(input: {
  cwd: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  checkoutRoot: string
  token?: string
}): Promise<void> {
  const runtimeRepo = resolveMatOSGitAssetSourceRuntimeRepo({
    cwd: input.cwd,
    source: input.source,
    repo: input.source.repo,
  })
  await updateEquivalentGitSourceRemote({
    cwd: input.cwd,
    source: input.source,
    repo: runtimeRepo,
    checkoutRoot: input.checkoutRoot,
    token: input.token,
  })
  if (!(input.source.provider === 'gitea' || input.source.gitea)) {
    return
  }
  const currentRemote = (
    await gitMaybe(input.checkoutRoot, ['remote', 'get-url', 'origin'])
  )?.trim()
  if (!currentRemote || currentRemote === runtimeRepo) {
    return
  }
  // Fallback for checkouts prepared on another execution surface (container
  // alias vs host loopback) whose source config lacks the gitea owner/repo
  // metadata that the equivalence check needs: same repository path on a
  // different host is still the same Gitea repository.
  const currentPath = normalizedGiteaRemotePath(currentRemote)
  const runtimePath = normalizedGiteaRemotePath(runtimeRepo)
  if (currentPath && runtimePath && currentPath === runtimePath) {
    await setMatOSGitSourceOriginRemote({
      checkoutRoot: input.checkoutRoot,
      repo: runtimeRepo,
      ...(input.token ? { token: input.token } : {}),
    })
  }
}

async function removeGitSourceCheckoutForReclone(
  checkoutRoot: string,
): Promise<void> {
  try {
    await rm(checkoutRoot, { recursive: true, force: true })
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') {
      throw error
    }
    await repairGitCheckoutCachePermissions(checkoutRoot).catch(() => undefined)
    await chmodReadablePath(dirname(checkoutRoot), 0o755)
    try {
      await rm(checkoutRoot, { recursive: true, force: true })
      return
    } catch (retryError) {
      const retryCode = (retryError as NodeJS.ErrnoException).code
      if (retryCode === 'EACCES' || retryCode === 'EPERM') {
        throw new Error(
          `MatOS git asset source checkout cannot be replaced due to filesystem permissions: ${checkoutRoot}. Run workspace asset preparation/ownership repair before retrying.`,
          { cause: retryError },
        )
      }
      throw retryError
    }
  }
}

function normalizedGitRemote(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.replace(/\/+$/, '')
}

function normalizedGiteaRemotePath(value: string | undefined): string | undefined {
  const remote = normalizedGitRemote(value)
  if (!remote) {
    return undefined
  }
  try {
    const parsed = new URL(remote)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined
    }
    return parsed.pathname
      .replace(/^\/+/, '')
      .replace(/\.git$/, '')
      .toLowerCase()
  } catch {
    return undefined
  }
}

function gitSourceRemoteHasSameGiteaRepoIdentity(input: {
  source: MatOSAssetSourceConfig & { type: 'git' }
  currentRemote: string
  requestedRepo: string
}): boolean {
  const currentPath = normalizedGiteaRemotePath(input.currentRemote)
  const requestedPath = normalizedGiteaRemotePath(input.requestedRepo)
  if (!currentPath || !requestedPath || currentPath !== requestedPath) {
    return false
  }
  const owner = typeof input.source.gitea?.owner === 'string'
    ? input.source.gitea.owner.trim().toLowerCase()
    : ''
  const repo = typeof input.source.gitea?.repo === 'string'
    ? input.source.gitea.repo.trim().replace(/\.git$/, '').toLowerCase()
    : ''
  return Boolean(owner && repo && currentPath === `${owner}/${repo}`)
}

function gitSourceRemoteIsEquivalentTransport(input: {
  cwd: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  currentRemote: string
  requestedRepo: string
}): boolean {
  if (!(input.source.provider === 'gitea' || input.source.gitea)) {
    return false
  }
  const currentRemote = normalizedGitRemote(input.currentRemote)
  const requestedRepo = normalizedGitRemote(input.requestedRepo)
  if (!currentRemote || !requestedRepo) {
    return false
  }
  if (
    gitSourceRemoteHasSameGiteaRepoIdentity({
      source: input.source,
      currentRemote,
      requestedRepo,
    })
  ) {
    return true
  }
  const candidates = new Set(
    [
      input.source.repo,
      input.source.gitea?.cloneUrl,
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: input.cwd,
        source: input.source,
        repo: input.source.repo,
      }),
      input.source.gitea?.cloneUrl
        ? resolveMatOSGitAssetSourceRuntimeRepo({
            cwd: input.cwd,
            source: input.source,
            repo: input.source.gitea.cloneUrl,
          })
        : undefined,
      matOSGiteaFileSourceRepoForSource({
        source: input.source,
        requireExists: false,
      }),
      matOSGiteaFileSourceRepoForSource({
        source: input.source,
        env: {
          MATOS_GITEA_FILE_SOURCE_ROOT: DEFAULT_MATOS_GITEA_FILE_SOURCE_ROOT,
        },
        requireExists: false,
      }),
    ]
      .map(normalizedGitRemote)
      .filter((item): item is string => Boolean(item)),
  )
  return candidates.has(currentRemote) && candidates.has(requestedRepo)
}

function gitSourceRuntimeRefIsAccepted(
  source: MatOSAssetSourceConfig & { type: 'git' },
): boolean {
  return (
    source.runtimeRef?.mode === 'accepted-ref' ||
    source.runtimeRef?.mode === 'commit'
  )
}

function gitSourceRuntimeRefExpectedCommit(
  source: MatOSAssetSourceConfig & { type: 'git' },
): string | undefined {
  if (source.runtimeRef?.mode === 'accepted-ref') {
    return source.runtimeRef.commit?.trim().toLowerCase() || undefined
  }
  if (source.runtimeRef?.mode === 'commit') {
    return source.runtimeRef.commit.trim().toLowerCase()
  }
  return undefined
}

async function resolveGitCheckoutCommit(
  checkoutRoot: string,
  ref: string | undefined,
): Promise<string> {
  const requested = ref?.trim() || 'HEAD'
  const branch = requested.replace(/^refs\/heads\//, '')
  const revParseCommit = async (candidate: string): Promise<string | undefined> =>
    (
      await gitMaybe(checkoutRoot, [
        'rev-parse',
        '--verify',
        `${candidate}^{commit}`,
      ])
    )?.trim()
  const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> =>
    (await gitMaybe(checkoutRoot, ['merge-base', '--is-ancestor', ancestor, descendant])) !==
    undefined

  if (requested !== 'HEAD') {
    const localCommit = await revParseCommit(requested)
    const remoteCommit =
      (await revParseCommit(`origin/${branch}`)) ??
      (await revParseCommit(`refs/remotes/origin/${branch}`))
    if (localCommit && remoteCommit) {
      const localIsBehindOrEqual = await isAncestor(localCommit, remoteCommit)
      const remoteIsBehindOrEqual = await isAncestor(remoteCommit, localCommit)
      if (remoteIsBehindOrEqual && !localIsBehindOrEqual) {
        return localCommit
      }
      if (!localIsBehindOrEqual && !remoteIsBehindOrEqual) {
        return localCommit
      }
      return remoteCommit
    }
    if (localCommit) {
      return localCommit
    }
    if (remoteCommit) {
      return remoteCommit
    }
  }

  const candidates =
    requested === 'HEAD'
      ? ['origin/HEAD', 'HEAD']
      : [
          `refs/tags/${requested}`,
          requested,
        ]

  for (const candidate of candidates) {
    const commit = await revParseCommit(candidate)
    if (commit) {
      return commit
    }
  }

  throw new Error(`MatOS git asset source ref not found: ${requested}`)
}

async function resolvePreparedAcceptedCheckoutCommit(input: {
  checkoutRoot: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  ref?: string
  token?: string
}): Promise<string | undefined> {
  if (!gitSourceRuntimeRefIsAccepted(input.source)) {
    return undefined
  }
  if (!(await pathExists(join(input.checkoutRoot, '.git')))) {
    return undefined
  }
  await removeManagedGitMetadataLocks(input.checkoutRoot)
  const expectedCommit = gitSourceRuntimeRefExpectedCommit(input.source)
  if (
    input.source.runtimeRef?.mode === 'accepted-ref' &&
    !expectedCommit &&
    input.ref?.trim()
  ) {
    await fetchGitSourceRef(input.checkoutRoot, input.ref, {
      token: input.token,
      localRepos: [input.source.repo],
    }).catch(() => undefined)
    const requested = input.ref.trim().replace(/^refs\/heads\//, '')
    const remoteCommit =
      (
        await gitMaybe(input.checkoutRoot, [
          'rev-parse',
          '--verify',
          `origin/${requested}^{commit}`,
        ])
      )?.trim() ??
      (
        await gitMaybe(input.checkoutRoot, [
          'rev-parse',
          '--verify',
          `refs/remotes/origin/${requested}^{commit}`,
        ])
      )?.trim()
    if (remoteCommit) {
      return remoteCommit
    }
  }
  const commit = await resolveGitCheckoutCommit(input.checkoutRoot, input.ref).catch(
    () => undefined,
  )
  if (!commit) {
    return undefined
  }
  if (!expectedCommit || commit === expectedCommit) {
    return commit
  }
  await fetchGitSourceRef(
    input.checkoutRoot,
    input.ref ?? expectedCommit,
    {
      token: input.token,
      localRepos: [input.source.repo],
    },
  ).catch(() => undefined)
  const expectedResolvedCommit = await resolveGitCheckoutCommit(
    input.checkoutRoot,
    expectedCommit,
  ).catch(() => undefined)
  if (expectedResolvedCommit === expectedCommit) {
    return expectedResolvedCommit
  }
  const refreshedCommit = await resolveGitCheckoutCommit(
    input.checkoutRoot,
    input.ref,
  ).catch(() => undefined)
  return refreshedCommit === expectedCommit ? refreshedCommit : undefined
}

export function matOSAcceptedGiteaSourceRequiresPreparedCheckout(input: {
  source: MatOSAssetSourceConfig & { type: 'git' }
  repo: string
  token?: string
}): boolean {
  let usesHttpGit = false
  try {
    const parsed = new URL(input.repo)
    usesHttpGit = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    usesHttpGit = false
  }
  // Fail fast only when there is no usable Gitea credential at all. With a
  // runtime-resolvable token (explicit, env, operator env, or the per-user
  // /workspace/ipc/matos-gitea.token file) the materializer may self-heal a
  // missing or corrupted accepted checkout by cloning/fetching directly,
  // instead of blocking every role launch and self-evolution run on an
  // operator-side `provision-assets` repair.
  return Boolean(
    gitSourceRuntimeRefIsAccepted(input.source) &&
      !input.token?.trim() &&
      usesHttpGit &&
      (input.source.provider === 'gitea' || input.source.gitea),
  )
}

/**
 * Pre-lock fast-path check for an already-prepared accepted checkout.
 *
 * This runs BEFORE the per-source lock is acquired, so it must never mutate
 * Git state: a concurrent acceptance, commit, or workspace-preparation flow
 * may hold the source lock and be mid-checkout on this cache right now.
 * Removing `.git` metadata locks here can delete a live lock owned by the
 * locked process, and rewriting config (`core.sharedRepository`) or fetching
 * races the locked process's own config/ref writes — the historical
 * `[remote "origin"]` clobbering came from exactly this kind of unlocked
 * writer. Filesystem chmod normalization is the only side effect allowed
 * because it cannot corrupt a concurrent git operation.
 */
async function resolveHealthyPreparedAcceptedCheckout(input: {
  checkoutRoot: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  subdir?: string
}): Promise<string | undefined> {
  const expectedCommit = gitSourceRuntimeRefExpectedCommit(input.source)
  if (!expectedCommit) {
    // An accepted-ref without a pinned commit needs a fetch to resolve the
    // remote tip; fetching is a mutation and belongs in the locked path.
    return undefined
  }
  if (!(await pathExists(join(input.checkoutRoot, '.git')))) {
    return undefined
  }
  await normalizePreparedGitCheckoutMetadataPermissionsFsOnly(
    input.checkoutRoot,
    input.source.runtimeRef?.mode === 'accepted-ref'
      ? input.source.runtimeRef.ref
      : undefined,
  ).catch(() => undefined)
  let head = await currentGitCommit(input.checkoutRoot)
  if (!head) {
    // Metadata may be unreadable beyond the common files normalized above
    // (for example refs or object directories left at 0o000). Repair with a
    // pure chmod traversal — still safe without the lock — and retry once.
    await chmodGitSourceCacheTree(join(input.checkoutRoot, '.git')).catch(
      () => undefined,
    )
    head = await currentGitCommit(input.checkoutRoot)
  }
  if (head !== expectedCommit) {
    return undefined
  }
  // A prepared checkout can be returned before the locked recovery path.
  // Repair the tracked working tree here as well as Git metadata: workspace
  // preparation may have been performed by root and left README/assets
  // unreadable to the current user.
  await chmodGitCheckoutDirectories(input.checkoutRoot).catch(() => undefined)
  await chmodGitCheckoutTrackedFilesFromIndex(input.checkoutRoot).catch(() => undefined)
  return resolvePreparedGitSourceRoot({
    checkoutRoot: input.checkoutRoot,
    sourceId: input.source.id,
    subdir: input.subdir,
  })
}

async function materializeGitSource(input: {
  cwd: string
  source: MatOSAssetSourceConfig & { type: 'git' }
  repo: string
  ref?: string
  subdir?: string
  refresh?: string
  token?: string
  forceResetDirty?: boolean
  preserveDirty?: boolean
}): Promise<string> {
  const cacheRoot = matOSAssetSourceCacheRoot(input.cwd, input.source)
  const checkoutRoot = matOSGitAssetSourceCheckoutRoot(input.cwd, input.source)
  const runtimeRepo = resolveMatOSGitAssetSourceRuntimeRepo({
    cwd: input.cwd,
    source: input.source,
    repo: input.repo,
  })
  const token = resolveMatOSGitSourceToken(input.token, input.source)
  const requiresPreparedAcceptedCheckout =
    matOSAcceptedGiteaSourceRequiresPreparedCheckout({
      source: input.source,
      repo: runtimeRepo,
      token,
    })

  if (requiresPreparedAcceptedCheckout) {
    // The common runtime path is an already-prepared accepted checkout
    // pinned to a known commit. Answer that case with a strictly read-only
    // probe (plus chmod-only permission normalization) so it stays cheap on
    // network filesystems and cannot race a concurrent locked preparation on the same
    // cache. Everything that mutates Git state — stale-lock removal, config
    // repair, fetch, checkout — happens under the source lock below.
    const preparedSourceRoot = await resolveHealthyPreparedAcceptedCheckout({
      checkoutRoot,
      source: input.source,
      subdir: input.subdir,
    })
    if (preparedSourceRoot) {
      return preparedSourceRoot
    }
  }

  await mkdir(cacheRoot, { recursive: true })
  await chmodGitSourceCacheRootDirs(input.cwd, cacheRoot)

  return withGitSourceLock(cacheRoot, input.source.id, async () => {
    // A new --no-checkout clone has HEAD but no worktree/index yet. It must
    // complete its first checkout, not preserve apparently deleted files.
    const preserveDirty = input.preserveDirty && await pathExists(join(checkoutRoot, '.git'))
    await removeManagedGitMetadataLocks(checkoutRoot)
    // The steady-state accepted checkout is already normalized by workspace
    // preparation. Repair only the small Git metadata surface here; checkout
    // and clean operations below perform the full recovery pass on an actual
    // permission failure or commit transition.
    await repairPreparedGitCheckoutMetadataPermissions(
      checkoutRoot,
      { ...(token ? { token } : {}) },
      input.source.runtimeRef?.mode === 'accepted-ref'
        ? input.source.runtimeRef.ref
        : undefined,
    ).catch(() => undefined)
    await updateEquivalentGitSourceRemote({
      cwd: input.cwd,
      source: input.source,
      repo: runtimeRepo,
      checkoutRoot,
      token,
    })
    let commit = await resolvePreparedAcceptedCheckoutCommit({
      checkoutRoot,
      source: input.source,
      ref: input.ref,
      token,
    })
    if (!commit && requiresPreparedAcceptedCheckout) {
      await repairGitCheckoutCachePermissions(checkoutRoot, {
        ...(token ? { token } : {}),
      }).catch(() => undefined)
      commit = await resolvePreparedAcceptedCheckoutCommit({
        checkoutRoot,
        source: input.source,
        ref: input.ref,
        token,
      })
    }
    if (!commit) {
      if (
        requiresPreparedAcceptedCheckout
      ) {
        throw new Error(
          `MatOS accepted Gitea asset source ${input.source.id} is not prepared in this workspace cache. Run gateway/workspace asset preparation before starting MatOS.`,
        )
      }
      await ensureGitSourceRemote({
        cwd: input.cwd,
        source: input.source,
        repo: runtimeRepo,
        checkoutRoot,
        token,
      })
      await removeManagedGitMetadataLocks(checkoutRoot)
      const expectedCommit = gitSourceRuntimeRefExpectedCommit(input.source)
      if (input.refresh === 'always' || expectedCommit) {
        await fetchGitSourceRef(checkoutRoot, input.ref ?? expectedCommit, {
          token,
          localRepos: [runtimeRepo, input.source.repo],
        })
      }

      commit = expectedCommit
        ? (await resolveGitCheckoutCommit(checkoutRoot, expectedCommit).catch(
            () => undefined,
          )) ?? (await resolveGitCheckoutCommit(checkoutRoot, input.ref))
        : await resolveGitCheckoutCommit(checkoutRoot, input.ref)
    }
    const expectedCommit = gitSourceRuntimeRefExpectedCommit(input.source)
    if (expectedCommit && commit !== expectedCommit) {
      await removeManagedGitMetadataLocks(checkoutRoot)
      await fetchGitSourceRef(checkoutRoot, input.ref ?? expectedCommit, {
        token,
        localRepos: [runtimeRepo, input.source.repo],
      }).catch(() => undefined)
      const expectedResolvedCommit = await resolveGitCheckoutCommit(
        checkoutRoot,
        expectedCommit,
      ).catch(() => undefined)
      if (expectedResolvedCommit === expectedCommit) {
        commit = expectedResolvedCommit
      }
      const refreshedCommit = await resolveGitCheckoutCommit(
        checkoutRoot,
        input.ref,
      ).catch(() => undefined)
      if (commit !== expectedCommit && refreshedCommit) {
        commit = refreshedCommit
      }
    }
    if (expectedCommit && commit !== expectedCommit) {
      throw new Error(
        `MatOS git asset source ${input.source.id} accepted commit mismatch: expected ${expectedCommit}, resolved ${commit}`,
      )
    }
    await checkoutGitSourceCommit({
      checkoutRoot,
      sourceId: input.source.id,
      commit,
      forceResetDirty:
        !preserveDirty &&
        (input.forceResetDirty || gitSourceRuntimeRefIsAccepted(input.source)),
      preserveDirty,
      ...(token ? { token } : {}),
    })

    const sourceRoot = input.subdir
      ? resolve(checkoutRoot, input.subdir)
      : checkoutRoot
    if (!isWithin(sourceRoot, checkoutRoot)) {
      throw new Error(
        `MatOS git asset source ${input.source.id} subdir escapes checkout root`,
      )
    }
    const sourceRootStat = await stat(sourceRoot).catch(() => undefined)
    if (!sourceRootStat) {
      throw new Error(
        `MatOS git asset source ${input.source.id} subdir does not exist: ${
          input.subdir ?? '.'
        }`,
      )
    }
    if (!sourceRootStat.isDirectory()) {
      throw new Error(
        `MatOS git asset source ${input.source.id} subdir is not a directory: ${
          input.subdir ?? '.'
        }`,
      )
    }
    await repairMatOSGitAssetSourceCachePermissions(input.cwd, input.source, {
      full: false,
    })
    return sourceRoot
  })
}

async function resolvePreparedGitSourceRoot(input: {
  checkoutRoot: string
  sourceId: string
  subdir?: string
}): Promise<string | undefined> {
  const sourceRoot = input.subdir
    ? resolve(input.checkoutRoot, input.subdir)
    : input.checkoutRoot
  if (!isWithin(sourceRoot, input.checkoutRoot)) {
    throw new Error(
      `MatOS git asset source ${input.sourceId} subdir escapes checkout root`,
    )
  }
  const sourceRootStat = await stat(sourceRoot).catch(() => undefined)
  if (!sourceRootStat) {
    return undefined
  }
  if (!sourceRootStat.isDirectory()) {
    throw new Error(
      `MatOS git asset source ${input.sourceId} subdir is not a directory: ${
        input.subdir ?? '.'
      }`,
    )
  }
  return sourceRoot
}

function runtimeCheckoutRef(
  source: MatOSAssetSourceConfig & { type: 'git' },
): string | undefined {
  if (source.runtimeRef?.mode === 'commit') {
    return source.runtimeRef.commit
  }
  if (source.runtimeRef?.mode === 'accepted-ref') {
    return source.runtimeRef.ref
  }
  return source.ref
}

export async function materializeMatOSAssetSource(
  cwd: string,
  source: MatOSAssetSourceConfig,
  options: {
    refresh?: NonNullable<MatOSAssetSourceConfig['refresh']>
    token?: string
    forceResetDirty?: boolean
    preserveDirty?: boolean
  } = {},
): Promise<string> {
  if (source.type === 'local') {
    return isAbsolute(source.path)
      ? source.path
      : resolve(getMatOSDir(cwd), source.path)
  }
  return materializeGitSource({
    cwd,
    source,
    repo: source.repo,
    ref: runtimeCheckoutRef(source),
    subdir: source.subdir,
    refresh: options.refresh ?? source.refresh,
    token: options.token,
    forceResetDirty: options.forceResetDirty,
    preserveDirty:
      options.preserveDirty ?? preserveDirtyMatOSAssetSourcesFromEnv(),
  })
}

export async function commitMatOSGitAssetSource(
  cwd: string,
  source: MatOSAssetSourceConfig,
  options: {
    message: string
    branch?: string
    push?: boolean
    token?: string
  },
): Promise<MatOSGitAssetSourceCommitResult> {
  if (source.type !== 'git') {
    throw new Error(`MatOS asset source is not git-backed: ${source.id}`)
  }
  // Serialize with materialization and other commit/acceptance flows: bare
  // concurrent add/commit/checkout on one checkout raced into
  // `.git/index.lock` failures that rolled back valid self-evolution runs.
  return withMatOSGitAssetSourceLock(cwd, source, async () => {
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(cwd, source)
    const runtimeRepo = resolveMatOSGitAssetSourceRuntimeRepo({
      cwd,
      source,
      repo: source.repo,
    })
    if (!(await pathExists(join(checkoutRoot, '.git')))) {
      await materializeMatOSAssetSource(cwd, source)
    } else {
      await updateEquivalentGitSourceRemote({
        cwd,
        source,
        repo: runtimeRepo,
        checkoutRoot,
        token: options.token,
      })
    }
    const branch = options.branch?.trim() || source.ref?.trim() || 'main'
    if (!(await gitMaybe(checkoutRoot, ['check-ref-format', '--branch', branch]))) {
      throw new Error(`Invalid MatOS git asset source branch: ${branch}`)
    }
    const message = options.message.trim()
    if (!message) {
      throw new Error('MatOS git asset source commit message is required')
    }

    try {
      // A previously killed git process may have left a stale index lock; the
      // MatOS source lock is held here, so removing it is safe.
      await removeManagedGitMetadataLocks(checkoutRoot)
      const beforeStatus = await git(checkoutRoot, ['status', '--porcelain'])
      const changedPaths = parseGitStatusPaths(beforeStatus)
      if (changedPaths.length === 0) {
        const currentCommit = (
          await gitMaybe(checkoutRoot, ['rev-parse', 'HEAD'])
        )?.trim()
        return {
          ok: true,
          sourceId: source.id,
          branch,
          checkoutRoot,
          action: 'noop',
          dirtyBefore: false,
          changedPaths: [],
          ...(currentCommit ? { commit: currentCommit } : {}),
          pushed: false,
        }
      }

      await git(checkoutRoot, ['checkout', '-B', branch])
      await git(checkoutRoot, ['add', '-A'])
      await execFileAsync(
        'git',
        [
          ...gitSafeDirectoryArgs(checkoutRoot),
          '-c',
          'user.name=MatOS Asset Bot',
          '-c',
          'user.email=matos-assets@localhost',
          'commit',
          '-m',
          message,
        ],
        {
          cwd: checkoutRoot,
          env: gitEnv(),
          maxBuffer: 20 * 1024 * 1024,
        },
      )
      const commit = (await git(checkoutRoot, ['rev-parse', 'HEAD'])).trim()
      if (options.push) {
        await git(checkoutRoot, ['push', 'origin', `HEAD:${branch}`], {
          token: options.token,
        })
      }
      return {
        ok: true,
        sourceId: source.id,
        branch,
        checkoutRoot,
        action: 'committed',
        dirtyBefore: true,
        changedPaths,
        commit,
        pushed: options.push === true,
      }
    } finally {
      await repairMatOSGitAssetSourceCachePermissions(cwd, source)
    }
  })
}

function sourceScope(source: MatOSAssetSourceConfig): MatOSAssetSourceStatus['scope'] {
  return source.scope ?? 'project'
}

function sourceRefresh(
  source: MatOSAssetSourceConfig,
): MatOSAssetSourceStatus['refresh'] {
  return source.refresh ?? 'manual'
}

function sourceIncludedInRuntime(source: MatOSAssetSourceConfig): boolean {
  return source.includeInRuntime !== false
}

export function serializeMatOSAssetSourceConfig(
  source: MatOSAssetSourceConfig,
): Record<string, unknown> {
  if (source.type === 'local') {
    return {
      id: source.id,
      type: source.type,
      path: source.path,
      scope: sourceScope(source),
      scopeRef: source.scopeRef,
      refresh: sourceRefresh(source),
      ...(source.includeInRuntime === false ? { includeInRuntime: false } : {}),
    }
  }
  return {
    id: source.id,
    type: source.type,
    repo: source.repo,
    ref: source.ref,
    subdir: source.subdir,
    scope: sourceScope(source),
    scopeRef: source.scopeRef,
    refresh: sourceRefresh(source),
    provider: source.provider,
    gitea: source.gitea,
    runtimeRef: source.runtimeRef,
    ...(source.includeInRuntime === false ? { includeInRuntime: false } : {}),
  }
}

export async function inspectMatOSAssetSource(
  cwd: string,
  source: MatOSAssetSourceConfig,
): Promise<MatOSAssetSourceStatus> {
  if (source.type === 'local') {
    const root = isAbsolute(source.path)
      ? source.path
      : resolve(getMatOSDir(cwd), source.path)
    const rootStat = await stat(root).catch(() => undefined)
    const exists = Boolean(rootStat?.isDirectory())
    return {
      id: source.id,
      type: source.type,
      path: root,
      scope: sourceScope(source),
      scopeRef: source.scopeRef,
      refresh: sourceRefresh(source),
      materializedRoot: root,
      exists,
      ok: exists,
      ...(exists
        ? {}
        : { error: `MatOS local asset source not found: ${source.path}` }),
    }
  }

  const checkoutRoot = matOSGitAssetSourceCheckoutRoot(cwd, source)
  const hasCheckout = await pathExists(join(checkoutRoot, '.git'))
  const base: MatOSAssetSourceStatus = {
    id: source.id,
    type: source.type,
    repo: source.repo,
    ref: source.ref,
    subdir: source.subdir,
    scope: sourceScope(source),
    scopeRef: source.scopeRef,
    refresh: sourceRefresh(source),
    provider: source.provider,
    gitea: source.gitea,
    runtimeRef: source.runtimeRef,
    cachePath: checkoutRoot,
    exists: false,
    ok: false,
  }
  if (!hasCheckout) {
    return {
      ...base,
      error: 'MatOS git asset source has not been materialized',
    }
  }

  const materializedRoot = source.subdir
    ? resolve(checkoutRoot, source.subdir)
    : checkoutRoot
  if (!isWithin(materializedRoot, checkoutRoot)) {
    return {
      ...base,
      materializedRoot,
      currentRemote: (
        await gitMaybe(checkoutRoot, ['remote', 'get-url', 'origin'])
      )?.trim(),
      currentCommit: (await gitMaybe(checkoutRoot, ['rev-parse', 'HEAD']))?.trim(),
      error: `MatOS git asset source ${source.id} subdir escapes checkout root`,
    }
  }

  const rootStat = await stat(materializedRoot).catch(() => undefined)
  const exists = Boolean(rootStat?.isDirectory())
  return {
    ...base,
    materializedRoot,
    exists,
    ok: exists,
    currentRemote: (
      await gitMaybe(checkoutRoot, ['remote', 'get-url', 'origin'])
    )?.trim(),
    currentCommit: (await gitMaybe(checkoutRoot, ['rev-parse', 'HEAD']))?.trim(),
    ...(exists
      ? {}
      : {
          error: `MatOS git asset source ${source.id} subdir does not exist: ${
            source.subdir ?? '.'
          }`,
        }),
  }
}

export async function resolveMatOSAssetSourceRoots(
  cwd: string,
  config: MatOSProjectConfig,
): Promise<string[]> {
  const roots: string[] = []
  for (const source of config.assetSources ?? []) {
    if (!sourceIncludedInRuntime(source)) {
      continue
    }
    roots.push(await materializeMatOSAssetSource(cwd, source))
  }
  return [...new Set(roots)]
}

export async function resolveMatOSAssetSourceRootProvenance(
  cwd: string,
  config: MatOSProjectConfig,
  options: { runtimeSnapshot?: boolean; followAcceptedUpdates?: boolean; token?: string } = {},
): Promise<Map<string, MatOSAssetSourceProvenance>> {
  const provenance = new Map<string, MatOSAssetSourceProvenance>()
  for (const source of config.assetSources ?? []) {
    if (!sourceIncludedInRuntime(source)) {
      continue
    }
    const snapshot = options.runtimeSnapshot && source.type === 'git' && gitSourceRuntimeRefIsAccepted(source)
      ? await materializeAcceptedRuntimeSnapshot(cwd, source, options.followAcceptedUpdates === true, options.token)
      : undefined
    const root = snapshot?.root ?? await materializeMatOSAssetSource(cwd, source, { token: options.token })
    const status = await inspectMatOSAssetSource(cwd, source)
    provenance.set(resolve(root), {
      sourceId: source.id,
      type: source.type,
      scope: status.scope,
      ...(status.scopeRef ? { scopeRef: status.scopeRef } : {}),
      refresh: status.refresh,
      ...(status.repo ? { repo: status.repo } : {}),
      ...(status.ref ? { ref: status.ref } : {}),
      ...(status.subdir ? { subdir: status.subdir } : {}),
      ...(status.provider ? { provider: status.provider } : {}),
      ...(status.gitea ? { gitea: status.gitea } : {}),
      ...(status.runtimeRef ? { runtimeRef: status.runtimeRef } : {}),
      ...(status.currentRemote ? { currentRemote: status.currentRemote } : {}),
      ...(snapshot && source.type === 'git' ? { currentCommit: snapshot.commit, runtimeRef: { ...source.runtimeRef, commit: snapshot.commit } as MatOSGitAssetSourceRuntimeRef }
        : status.currentCommit ? { currentCommit: status.currentCommit } : {}),
    })
  }
  return provenance
}

/** Runtime readers never consume the editable Git worktree. Export the accepted
 * Git object into a source/scope/commit-specific tree and publish it by rename.
 * Old trees remain valid for in-flight runs; accepting a new commit never edits
 * an executable underneath a caller. Authoring continues to use the checkout.
 */
export async function materializeAcceptedRuntimeSnapshot(
  cwd: string,
  source: MatOSAssetSourceConfig & { type: 'git' },
  follow: boolean,
  suppliedToken?: string,
  options: { checkUpdates?: boolean; requirePrepared?: boolean } = {},
): Promise<{ root: string; commit: string }> {
  const checkout = matOSGitAssetSourceCheckoutRoot(cwd, source)
  const expected = gitSourceRuntimeRefExpectedCommit(source)
  if (expected && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expected)) {
    throw new Error(`MatOS accepted source ${source.id} has an invalid runtime commit`)
  }
  const identity = runtimeSnapshotIdentity(source, follow)
  const snapshots = join(matOSAssetSourceCacheRoot(cwd, source), '.runtime-snapshots', identity)
  const ref = source.runtimeRef?.mode === 'accepted-ref'
    ? source.runtimeRef.ref.replace(/^refs\/heads\//, '') : undefined
  if (ref && (!ref.startsWith('accepted/') || !await execFileAsync('git', ['check-ref-format', `refs/heads/${ref}`])
    .then(() => true, () => false))) {
    throw new Error(`Invalid accepted runtime ref for source ${source.id}`)
  }
  const snapshotRoot = (commit: string) => {
    const tree = join(snapshots, commit, 'tree')
    const root = source.subdir ? resolve(tree, source.subdir) : tree
    if (!isWithin(root, tree)) throw new Error(`MatOS source ${source.id} subdir escapes snapshot`)
    return root
  }
  const completed = async (commit: string | undefined): Promise<{ root: string; commit: string } | undefined> => {
    if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) return undefined
    const marker = join(snapshots, commit, 'complete.json')
    const root = snapshotRoot(commit)
    try {
      if (!(await lstat(marker)).isFile()) return undefined
      const record = JSON.parse(await readFile(marker, 'utf8'))
      if (record.commit !== commit || (record.identity && record.identity !== identity)) return undefined
      let path = root
      while (isWithin(path, join(snapshots, commit))) {
        if (!(await lstat(path)).isDirectory()) return undefined
        path = dirname(path)
      }
      return { root, commit }
    } catch { return undefined }
  }
  const lastCompleted = async () => {
    if (follow && ref) {
      const last = await readFile(join(snapshots, 'last-accepted.json'), 'utf8')
        .then(text => JSON.parse(text), () => undefined).catch(() => undefined)
      if (last?.identity === identity && last.configuredCommit === expected) {
        const previous = await completed(last.commit)
        if (previous) return previous
      }
    }
    return completed(expected)
  }
  const token = resolveMatOSGitSourceToken(suppliedToken, source)
  const repo = resolveMatOSGitAssetSourceRuntimeRepo({ cwd, source, repo: source.repo })
  const available = await lastCompleted()
  if (available && (options.requirePrepared || !follow || options.checkUpdates === false ||
    matOSAcceptedGiteaSourceRequiresPreparedCheckout({ source, repo, token }) ||
    !await pathExists(join(checkout, '.git')))) return available
  if (options.requirePrepared) throw new Error(`MatOS accepted source ${source.id} has no complete prepared runtime snapshot`)
  // Source preparation may acquire a runtime-export lock, never the reverse.
  if (!(await pathExists(join(checkout, '.git'))) && !await lastCompleted()) {
    await materializeMatOSAssetSource(cwd, source, { token: suppliedToken, preserveDirty: true })
  }
  // This lock serializes only runtime exports/ref probes, not authoring. Git
  // objects are immutable, so readers need not wait for a long editor checkout.
  return withGitSourceLock(matOSAssetSourceCacheRoot(cwd, source), `runtime-${source.id}`, async () => {
    let commit = expected
    const cached = await lastCompleted()
    if (cached) commit = cached.commit
    if (!(await pathExists(join(checkout, '.git')))) {
      // A complete accepted export is runtime data, not a cache of an editable
      // checkout. Losing that checkout or its credentials must not remove it.
      if (cached) return cached
      throw new Error(`MatOS accepted source ${source.id} checkout changed during preparation; retry asset loading`)
    }
    if (follow && ref && options.checkUpdates !== false) {
      // Bind the tracking ref to repository, scope and channel, not just an id
      // which can be reused when a configured source is replaced.
      const target = `refs/matos-runtime/${identity}`
      if (!matOSAcceptedGiteaSourceRequiresPreparedCheckout({ source, repo, token })) {
        try {
          await git(checkout, ['fetch', '--no-tags', '--no-write-fetch-head', repo, `+refs/heads/${ref}:${target}`], { token, localRepos: [repo], timeoutMs: 5000 })
          commit = (await git(checkout, ['rev-parse', `${target}^{commit}`])).trim()
        } catch {
          process.stderr.write(`[matos-assets] update check unavailable for ${safeMatOSAssetSourceId(source.id)}; using last accepted snapshot\n`)
        }
      }
    }
    if (!commit && ref) {
      const origin = (await gitMaybe(checkout, ['remote', 'get-url', 'origin']))?.trim()
      if (origin && (origin === repo || gitSourceRemoteIsEquivalentTransport({ cwd, source, currentRemote: origin, requestedRepo: repo }))) {
        commit = (await gitMaybe(checkout, ['rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`]))?.trim()
      }
    }
    if (!commit || !/^[a-f0-9]{40,64}$/i.test(commit)) {
      throw new Error(`MatOS accepted source ${source.id} has no verified runtime commit`)
    }
    const published = join(snapshots, commit)
    const root = snapshotRoot(commit)
    if (!await completed(commit)) {
      if (await gitMaybe(checkout, ['cat-file', '-e', `${commit}^{commit}`]) === undefined) {
        if (matOSAcceptedGiteaSourceRequiresPreparedCheckout({ source, repo, token })) {
          throw new Error(`MatOS accepted source ${source.id} needs credential repair to prepare its configured commit`)
        }
        await git(checkout, ['fetch', '--no-tags', '--no-write-fetch-head', repo, commit],
          { token, localRepos: [repo], timeoutMs: 5000 })
      }
      await mkdir(snapshots, { recursive: true })
      await chmodGitSourceCacheRootDirs(cwd, snapshots)
      const owner = await stat(checkout)
      if (process.getuid?.() === 0) {
        // The source checkout's scoped owner must be able to publish the next
        // snapshot even when this export was prewarmed by a root gateway.
        await chown(dirname(snapshots), owner.uid, owner.gid)
        await chown(snapshots, owner.uid, owner.gid)
      }
      const stage = await mkdtemp(join(snapshots, '.building-'))
      try {
        const entries = (await git(checkout, ['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean)
        if (entries.some(entry => /^(120000|160000) /.test(entry))) {
          throw new Error(`MatOS source ${source.id} contains a symlink or submodule; runtime assets must be self-contained`)
        }
        const archive = join(stage, 'source.tar')
        await git(checkout, ['archive', '--format=tar', `--output=${archive}`, commit])
        await mkdir(join(stage, 'tree'))
        await execFileAsync('tar', ['--no-same-owner', '--no-same-permissions', '-xf', archive, '-C', join(stage, 'tree')], { timeout: gitCommandTimeoutMs() })
        await rm(archive)
        await writeFile(join(stage, 'complete.json'), JSON.stringify({ commit, identity }))
        await prepareRuntimeSnapshotTree(stage, owner)
        // Keep an incomplete/corrupt export as evidence; never trust just the
        // existence of its marker or remove an unrelated authoring tree.
        if (await pathExists(published)) await rename(published, join(snapshots, `.invalid-${randomUUID()}`))
        await rename(stage, published)
      } catch (error) {
        await rm(stage, { recursive: true, force: true })
        throw error
      }
    }
    if (!await completed(commit)) throw new Error(`MatOS source ${source.id} snapshot root is not a directory`)
    if (follow && ref) {
      const staged = join(snapshots, `.last-${randomUUID()}.json`)
      try {
        const value = JSON.stringify({ identity, commit, configuredCommit: expected })
        if (await readFile(join(snapshots, 'last-accepted.json'), 'utf8').catch(() => '') !== value) {
          await writeFile(staged, value)
          const owner = await stat(published)
          if (process.getuid?.() === 0) await chown(staged, owner.uid, owner.gid)
          await rename(staged, join(snapshots, 'last-accepted.json'))
        }
      } catch {
        process.stderr.write(`[matos-assets] could not checkpoint update for ${safeMatOSAssetSourceId(source.id)}; complete accepted snapshot remains readable\n`)
      } finally { await rm(staged, { force: true }).catch(() => undefined) }
    }
    return { root, commit }
  })
}

async function prepareRuntimeSnapshotTree(path: string, owner: { uid: number; gid: number }): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error('Runtime snapshots cannot contain symbolic links')
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await prepareRuntimeSnapshotTree(join(path, entry), owner)
  }
  // tar honors a restrictive gateway umask. Normalize only this newly-created
  // export, never user payloads or private scope ancestors.
  await chmod(path, info.isDirectory() || (info.mode & 0o111) !== 0 ? 0o755 : 0o644)
  if (process.getuid?.() === 0) await chown(path, owner.uid, owner.gid)
}

function runtimeSnapshotIdentity(source: MatOSAssetSourceConfig & { type: 'git' }, follow: boolean): string {
  const acceptedRef = source.runtimeRef?.mode === 'accepted-ref' ? source.runtimeRef.ref : undefined
  const hash = createHash('sha256').update(JSON.stringify([source.id, source.repo, source.scopeRef, source.subdir, source.runtimeRef?.mode, acceptedRef])).digest('hex').slice(0, 24)
  return `${follow && source.runtimeRef?.mode === 'accepted-ref' ? 'follow' : 'pinned'}-${hash}`
}

/** Refresh only the configured source which originally supplied this tool.
 * Never search other scopes or grow the running role's tool allowlist. The
 * returned executable lives in a complete immutable accepted snapshot.
 */
export class MatOSRuntimeToolPolicyError extends Error {}

export async function refreshMatOSRuntimeToolDirectory(
  cwd: string,
  directory: string,
  batchSnapshots?: Map<string, Promise<{ root: string; commit: string }>>,
  batchRegistries?: Map<string, Promise<import('./registry.js').MatOSAssetRegistry>>,
): Promise<string> {
  const match = resolve(directory).match(/^(.*\/\.runtime-snapshots\/)(follow-[a-f0-9]{24})\/[a-f0-9]{40,64}\/tree(?:\/|$)/)
  if (!match) return directory
  const config = await readMatOSProjectConfig(cwd)
  const source = config.assetSources?.find(source => source.type === 'git' && source.includeInRuntime !== false &&
    matOSGiteaEquivalentSourceRepos(source).some(repo =>
      runtimeSnapshotIdentity({ ...source, repo }, true) === match[2]) &&
    join(matOSAssetSourceCacheRoot(cwd, source), '.runtime-snapshots') + '/' === match[1])
  if (!source || source.type !== 'git') throw new MatOSRuntimeToolPolicyError('The tool asset source is no longer available in this scope')
  const manifest = JSON.parse(await readFile(join(directory, 'asset.json'), 'utf8')) as { id?: string; type?: string }
  if (manifest.type !== 'tool' || !manifest.id) throw new MatOSRuntimeToolPolicyError('Invalid runtime tool manifest')
  // One tools/list may contain dozens of tools from the same source. Probe
  // that source once per list, including during an outage; each later call
  // gets a fresh check, not a long-lived positive or negative source cache.
  const key = match[1] + match[2]
  let pending = batchSnapshots?.get(key)
  if (!pending) {
    pending = materializeAcceptedRuntimeSnapshot(cwd, source, true)
    batchSnapshots?.set(key, pending)
  }
  const snapshot = await pending
  // The immutable snapshot already supplied the authorized tool. An unchanged
  // accepted commit cannot change its version, lifecycle or location. Avoid
  // traversing thousands of unrelated manifests for every mounted tool/call.
  const previousTree = match[0].replace(/\/$/, '')
  const previousRoot = source.subdir ? resolve(previousTree, source.subdir) : previousTree
  if (resolve(snapshot.root) === previousRoot) return directory
  const { loadMatOSAssetsFromRoot } = await import('./loadAssets.js')
  const { buildMatOSAssetRegistry } = await import('./registry.js')
  let registryLoad = batchRegistries?.get(snapshot.root)
  if (!registryLoad) {
    registryLoad = loadMatOSAssetsFromRoot(snapshot.root).then(buildMatOSAssetRegistry)
    batchRegistries?.set(snapshot.root, registryLoad)
  }
  const registry = await registryLoad
  const asset = registry.resolve(`tool:${manifest.id}`)
  if (!asset || asset.lifecycle.status !== 'enabled') throw new MatOSRuntimeToolPolicyError(`Tool asset is no longer enabled: tool:${manifest.id}`)
  return asset.manifestDir
}
