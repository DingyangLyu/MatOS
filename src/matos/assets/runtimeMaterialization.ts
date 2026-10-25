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

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { getMatOSDir } from '../project.js'
import { resolveMatOSTmpRoot } from '../runtime/tempDirs.js'
import type { MatOSRuntimeProjection } from './runtimeComposition.js'
import {
  matOSSkillRuntimeLeafAlias,
  matOSSkillRuntimeName,
} from './skillRuntimeNames.js'

export type MatOSRuntimeMaterialization = {
  addDirs: string[]
}

export type MatOSRuntimeMaterializationOptions = {
  /**
   * Reuse a persistent fingerprint-keyed materialization cache. This is the
   * default: repeated sessions over unchanged assets skip the full skill-tree
   * copy (the cold-start cost on network filesystems) and share one `cache-<fingerprint>`
   * directory. Pass false to force a fresh single-run directory that
   * cleanupMatOSRuntimeMaterialization removes at session end.
   */
  cache?: boolean
  cacheLabel?: string
}

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)---\s*\n?/
const DEFAULT_MAX_MATERIALIZED_SKILL_FILE_BYTES = 1024 * 1024
const GENERATED_SKILL_CACHE_FILE_PATTERN = /(^|\/)vib\/cache\.[^/]+\.json$/
const MATERIALIZATION_CACHE_MARKER = '.matos-runtime-materialization.json'
const ALWAYS_SKIPPED_SKILL_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.mypy_cache',
  '.pytest_cache',
  '__pycache__',
  'node_modules',
])
const DEFAULT_SKIPPED_SKILL_EXAMPLE_DIR_NAMES = new Set([
  'example',
  'examples',
])
const FAST_COPY_FALLBACK_ERROR_CODES = new Set([
  'EACCES',
  'EIO',
  'EPERM',
  'EXDEV',
  'ENOSYS',
  'ENOTSUP',
  'EINVAL',
])
const DEFAULT_MATERIALIZATION_COPY_CONCURRENCY = 8
const DEFAULT_MATERIALIZATION_CACHE_KEEP_ENTRIES = 3
// Cache entries younger than this are never pruned, so a tree handed to a
// just-started session cannot be reclaimed by a concurrent prune.
const MATERIALIZATION_CACHE_PRUNE_MIN_AGE_MS = 60 * 60 * 1000
// Mid-write scratch dirs (`.cache-<key>.tmp-<uuid>` / `.trash-<uuid>`) only
// outlive a crashed process; reclaim them once clearly abandoned.
const MATERIALIZATION_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MATERIALIZATION_SCRATCH_DIR_PATTERN = /^\.cache-.*\.(?:tmp|trash)-/

type SkippedMaterializedSkillFile = {
  path: string
  size: number
  reason?: string
}

type MaterializationFileLimiter = <T>(task: () => Promise<T>) => Promise<T>

function materializationCopyConcurrency(): number {
  const raw = process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_CONCURRENCY?.trim()
  if (!raw) {
    return DEFAULT_MATERIALIZATION_COPY_CONCURRENCY
  }
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_MATERIALIZATION_COPY_CONCURRENCY
}

function materializationCacheKeepEntries(): number {
  const raw = process.env.MATOS_RUNTIME_MATERIALIZATION_CACHE_KEEP?.trim()
  if (!raw) {
    return DEFAULT_MATERIALIZATION_CACHE_KEEP_ENTRIES
  }
  const parsed = Number(raw)
  return Number.isInteger(parsed)
    ? parsed
    : DEFAULT_MATERIALIZATION_CACHE_KEEP_ENTRIES
}

// Minimal counting semaphore: per-file operations overlap network-filesystem
// latency without unbounded parallel I/O.
function createMaterializationFileLimiter(
  limit: number,
): MaterializationFileLimiter {
  let active = 0
  const waiters: Array<() => void> = []
  return async task => {
    while (active >= limit) {
      await new Promise<void>(resolveWaiter => waiters.push(resolveWaiter))
    }
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiters.shift()?.()
    }
  }
}

export function getMatOSRuntimeMaterializationRoot(cwd: string): string {
  const configured = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR?.trim()
  if (configured && !isContainerOnlyMaterializationRoot(cwd, configured)) {
    return configured
  }
  if (configured) {
    return join(resolveMatOSTmpRoot(cwd), 'matos-runtime', 'asset-runtime')
  }
  return (
    join(getMatOSDir(cwd), 'runtime', 'asset-runtime')
  )
}

function isContainerOnlyMaterializationRoot(cwd: string, root: string): boolean {
  const resolvedCwd = resolve(cwd)
  const resolvedRoot = resolve(root)
  const runningInWorkspace =
    resolvedCwd === '/workspace' ||
    resolvedCwd.startsWith('/workspace/') ||
    process.env.HOME === '/home/workspace' ||
    process.env.HOME === '/home/node'
  if (runningInWorkspace) {
    return false
  }
  return (
    resolvedRoot === '/workspace' ||
    resolvedRoot.startsWith('/workspace/') ||
    resolvedRoot === '/home/workspace' ||
    resolvedRoot.startsWith('/home/workspace/')
  )
}

function getMatOSRuntimeMaterializationRunRoot(cwd: string): string {
  return join(getMatOSRuntimeMaterializationRoot(cwd), randomUUID())
}

function getMatOSRuntimeMaterializationCacheRoot(
  cwd: string,
  cacheKey: string,
): string {
  return join(getMatOSRuntimeMaterializationRoot(cwd), `cache-${cacheKey}`)
}

async function isCachedMaterializationRoot(path: string): Promise<boolean> {
  if (!basename(path).startsWith('cache-')) {
    return false
  }
  try {
    await stat(join(path, MATERIALIZATION_CACHE_MARKER))
    return true
  } catch {
    return false
  }
}

// Warm-path validation: the marker must parse and record the expected
// fingerprint, and the materialized skills root must exist. Anything else is
// treated as a cache miss and re-materialized.
async function isReusableMaterializationCacheRoot(
  root: string,
  cacheKey: string,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(root, MATERIALIZATION_CACHE_MARKER), 'utf8'),
    ) as { cacheKey?: unknown }
    if (marker?.cacheKey !== cacheKey) {
      return false
    }
    await stat(join(root, '.matos', 'skills'))
    return true
  } catch {
    return false
  }
}

// Reuse refreshes the marker mtime so pruning keeps recently used fingerprint
// trees rather than recently created ones.
async function touchMaterializationCacheRoot(root: string): Promise<void> {
  const now = new Date()
  await utimes(join(root, MATERIALIZATION_CACHE_MARKER), now, now).catch(
    () => undefined,
  )
}

// Atomically publish a fully written scratch tree as `cache-<fingerprint>`.
// Two sessions racing on the same fingerprint are safe: whoever renames first
// wins and the loser discards its identical scratch tree and reuses the
// published one.
async function flipMaterializationCacheRootIntoPlace(
  writeRoot: string,
  root: string,
  cacheKey: string,
): Promise<'created' | 'reused'> {
  try {
    await rename(writeRoot, root)
    return 'created'
  } catch (error) {
    if (await isReusableMaterializationCacheRoot(root, cacheKey)) {
      await rm(writeRoot, { recursive: true, force: true }).catch(() => undefined)
      return 'reused'
    }
    // The target exists but is not a valid cache tree (stale or corrupted):
    // move it aside atomically instead of deleting a path a concurrent
    // process might be about to publish over, then retry once.
    const trashRoot = join(
      dirname(root),
      `.${basename(root)}.trash-${randomUUID()}`,
    )
    await rename(root, trashRoot).catch(() => undefined)
    await rm(trashRoot, { recursive: true, force: true }).catch(() => undefined)
    try {
      await rename(writeRoot, root)
      return 'created'
    } catch (retryError) {
      if (await isReusableMaterializationCacheRoot(root, cacheKey)) {
        await rm(writeRoot, { recursive: true, force: true }).catch(
          () => undefined,
        )
        return 'reused'
      }
      await rm(writeRoot, { recursive: true, force: true }).catch(
        () => undefined,
      )
      throw retryError
    }
  }
}

// Best-effort cache maintenance: keep the newest N fingerprint trees (by
// marker mtime, refreshed on reuse) plus the tree that was just published, and
// reclaim abandoned scratch dirs. Never throws; the fresh tree stays valid.
async function pruneMaterializationCacheRoots(
  materializationRoot: string,
  keepRoot: string,
  keepEntries: number,
): Promise<void> {
  try {
    const now = Date.now()
    const resolvedKeepRoot = resolve(keepRoot)
    const entries = await readdir(materializationRoot, { withFileTypes: true })
    const cacheRoots: Array<{ path: string; lastUsedAtMs: number }> = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const path = join(materializationRoot, entry.name)
      if (MATERIALIZATION_SCRATCH_DIR_PATTERN.test(entry.name)) {
        const info = await stat(path).catch(() => undefined)
        if (info && now - info.mtimeMs > MATERIALIZATION_SCRATCH_MAX_AGE_MS) {
          await rm(path, { recursive: true, force: true }).catch(() => undefined)
        }
        continue
      }
      if (
        !entry.name.startsWith('cache-') ||
        resolve(path) === resolvedKeepRoot
      ) {
        continue
      }
      const marker = await stat(join(path, MATERIALIZATION_CACHE_MARKER)).catch(
        () => undefined,
      )
      cacheRoots.push({ path, lastUsedAtMs: marker?.mtimeMs ?? 0 })
    }
    if (keepEntries <= 0) {
      return
    }
    cacheRoots.sort((left, right) => right.lastUsedAtMs - left.lastUsedAtMs)
    for (const stale of cacheRoots.slice(Math.max(keepEntries - 1, 0))) {
      if (now - stale.lastUsedAtMs < MATERIALIZATION_CACHE_PRUNE_MIN_AGE_MS) {
        continue
      }
      await rm(stale.path, { recursive: true, force: true }).catch(
        () => undefined,
      )
    }
  } catch {
    // Pruning is best-effort only.
  }
}

const pendingCachePrunes = new Set<string>()

function scheduleMaterializationCachePrune(root: string): void {
  const parent = dirname(root)
  if (pendingCachePrunes.has(parent)) return
  pendingCachePrunes.add(parent)
  const keepEntries = materializationCacheKeepEntries()
  // Recursive deletion on network storage can take minutes. The published
  // tree is ready; maintenance must never delay the agent's first response.
  setTimeout(() => {
    void pruneMaterializationCacheRoots(parent, root, keepEntries)
      .finally(() => pendingCachePrunes.delete(parent))
  }, 0).unref()
}

export async function cleanupMatOSRuntimeMaterialization(
  cwd: string,
  addDirs: string[],
): Promise<void> {
  const materializationRoot = resolve(getMatOSRuntimeMaterializationRoot(cwd))
  for (const addDir of [...new Set(addDirs)]) {
    const target = resolve(addDir)
    const relativeTarget = relative(materializationRoot, target)
    if (
      target === materializationRoot ||
      relativeTarget === '' ||
      relativeTarget.startsWith('..') ||
      relativeTarget.includes('..')
    ) {
      continue
    }
    if (await isCachedMaterializationRoot(target)) {
      continue
    }
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
  }
}

function modelOnlySkillMarkdown(content: string): string {
  const match = content.match(FRONTMATTER_PATTERN)
  if (!match) {
    return `---\nuser-invocable: false\n---\n${content}`
  }

  const frontmatter = match[1] ?? ''
  const body = content.slice(match[0].length)
  const updatedFrontmatter = /\n?\s*user-invocable\s*:/i.test(frontmatter)
    ? frontmatter.replace(
        /(^|\n)(\s*)user-invocable\s*:\s*[^\n]*/i,
        '$1$2user-invocable: false',
      )
    : `${frontmatter.trimEnd()}\nuser-invocable: false`

  return `---\n${updatedFrontmatter}\n---\n${body}`
}

function maxMaterializedSkillFileBytes(): number {
  const raw = process.env.MATOS_SKILL_MATERIALIZATION_MAX_FILE_BYTES?.trim()
  if (!raw) {
    return DEFAULT_MAX_MATERIALIZED_SKILL_FILE_BYTES
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_MATERIALIZED_SKILL_FILE_BYTES
}

function shouldSkipGeneratedSkillFile(relativePath: string): boolean {
  return GENERATED_SKILL_CACHE_FILE_PATTERN.test(relativePath)
}

function materializeSkillExamples(): boolean {
  const raw = process.env.MATOS_SKILL_MATERIALIZATION_INCLUDE_EXAMPLES?.trim()
  if (!raw) {
    return true
  }
  return /^(1|true|yes|on)$/i.test(raw)
}

function materializationMode(): string {
  return (
    process.env.MATOS_SKILL_MATERIALIZATION_MODE?.trim().toLowerCase() ??
    'default'
  )
}

function metadataOnlyMaterialization(): boolean {
  return materializationMode() === 'metadata-only'
}

function skippedMaterializedSkillDirReason(relativePath: string): string | undefined {
  if (metadataOnlyMaterialization()) {
    return 'metadata-only-directory'
  }
  const parts = relativePath.split(/[\\/]/).filter(Boolean)
  if (parts.some(part => ALWAYS_SKIPPED_SKILL_DIR_NAMES.has(part))) {
    return 'ignored-directory'
  }
  if (
    !materializeSkillExamples() &&
    parts.some(part => DEFAULT_SKIPPED_SKILL_EXAMPLE_DIR_NAMES.has(part))
  ) {
    return 'examples-directory'
  }
  return undefined
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function shouldFallbackToStreamCopy(error: unknown): boolean {
  const code = errorCode(error)
  if (code && FAST_COPY_FALLBACK_ERROR_CODES.has(code)) {
    return true
  }
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /copy_file_range|cross-device|operation not supported/i.test(message)
}

type MaterializationCopyMode = 'default' | 'copy' | 'stream'

// 'default' tries hardlink -> byte copy -> stream copy; 'copy' skips the
// hardlink attempt; 'stream' forces portable stream copies (legacy behavior
// for filesystems where copy_file_range/link misbehave).
function materializationCopyMode(): MaterializationCopyMode {
  const raw =
    process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE?.trim().toLowerCase()
  if (raw === 'stream') {
    return 'stream'
  }
  if (raw === 'copy') {
    return 'copy'
  }
  return 'default'
}

async function streamCopyFile(
  sourcePath: string,
  targetPath: string,
  sourceMode: number,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  await pipeline(
    createReadStream(sourcePath),
    createWriteStream(targetPath, { mode: sourceMode & 0o777 }),
  )
  await chmod(targetPath, sourceMode & 0o777).catch(() => undefined)
}

async function copySkillFilePortable(
  sourcePath: string,
  targetPath: string,
  sourceMode: number,
): Promise<void> {
  const copyMode = materializationCopyMode()
  if (copyMode !== 'stream') {
    if (copyMode !== 'copy') {
      try {
        // Same-filesystem hardlinks turn the cold-start copy into
        // metadata-only work. The link shares the source inode, so mode bits
        // already match and the byte-copy chmod must be skipped.
        await link(sourcePath, targetPath)
        return
      } catch {
        // EXDEV/EPERM/EMLINK/ENOTSUP/...: hardlinking is only an
        // optimization; fall back to a real copy.
      }
    }
    try {
      await copyFile(sourcePath, targetPath)
      await chmod(targetPath, sourceMode & 0o777).catch(() => undefined)
      return
    } catch (error) {
      if (!shouldFallbackToStreamCopy(error)) {
        throw error
      }
    }
  }

  await streamCopyFile(sourcePath, targetPath, sourceMode)
}

// Entries within a directory are processed concurrently; the shared limiter
// bounds in-flight per-file I/O across the whole materialization run so
// independent copies overlap filesystem latency without unbounded parallelism.
async function copySkillTreeModelOnly(input: {
  sourceDir: string
  currentSourceDir: string
  currentTargetDir: string
  skipped: SkippedMaterializedSkillFile[]
  maxFileBytes: number
  limit: MaterializationFileLimiter
}): Promise<void> {
  await mkdir(input.currentTargetDir, { recursive: true })
  const entries = await readdir(input.currentSourceDir, { withFileTypes: true })
  await Promise.all(
    entries.map(async entry => {
      const sourcePath = join(input.currentSourceDir, entry.name)
      const targetPath = join(input.currentTargetDir, entry.name)
      const relativePath = sourcePath.slice(input.sourceDir.length + 1)
      if (entry.isDirectory()) {
        const skipReason = skippedMaterializedSkillDirReason(relativePath)
        if (skipReason) {
          input.skipped.push({
            path: `${relativePath}/`,
            size: 0,
            reason: skipReason,
          })
          return
        }
        await copySkillTreeModelOnly({
          ...input,
          currentSourceDir: sourcePath,
          currentTargetDir: targetPath,
        })
        return
      }
      if (!entry.isFile()) {
        return
      }

      await input.limit(async () => {
        if (entry.name === 'SKILL.md') {
          const content = await readFile(sourcePath, 'utf8')
          await writeFile(targetPath, modelOnlySkillMarkdown(content), 'utf8')
          return
        }

        const info = await lstat(sourcePath)
        if (metadataOnlyMaterialization() && entry.name !== 'asset.json') {
          input.skipped.push({
            path: relativePath,
            size: info.size,
            reason: 'metadata-only-file',
          })
          return
        }
        if (shouldSkipGeneratedSkillFile(relativePath)) {
          input.skipped.push({
            path: relativePath,
            size: info.size,
            reason: 'generated-cache',
          })
          return
        }
        if (input.maxFileBytes > 0 && info.size > input.maxFileBytes) {
          input.skipped.push({
            path: relativePath,
            size: info.size,
            reason: 'too-large',
          })
          return
        }
        await copySkillFilePortable(sourcePath, targetPath, info.mode)
      })
    }),
  )
}

async function copySkillModelOnly(
  sourceDir: string,
  targetDir: string,
  limit: MaterializationFileLimiter,
): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true })
  const skipped: SkippedMaterializedSkillFile[] = []
  await copySkillTreeModelOnly({
    sourceDir,
    currentSourceDir: sourceDir,
    currentTargetDir: targetDir,
    skipped,
    maxFileBytes: maxMaterializedSkillFileBytes(),
    limit,
  })
  if (skipped.length > 0) {
    // Concurrent entry processing makes push order nondeterministic; sort so
    // materialized output stays byte-stable for identical inputs.
    skipped.sort((left, right) => left.path.localeCompare(right.path))
    await writeFile(
      join(targetDir, '.matos-skipped-files.json'),
      `${JSON.stringify({ skipped }, null, 2)}\n`,
      'utf8',
    )
  }
}

async function readSkillAssetId(skillDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(skillDir, 'asset.json'), 'utf8'))
    return typeof manifest.id === 'string' && manifest.id.trim().length > 0
      ? manifest.id.trim()
      : undefined
  } catch {
    return undefined
  }
}

// Digest inputs are collected concurrently (metadata lookups on network
// filesystems dominate cache-key time when done sequentially), then hashed in
// the same deterministic depth-first sorted order as the old recursive walk.
async function skillTreeDigestChunks(input: {
  sourceDir: string
  currentDir: string
  maxFileBytes: number
}): Promise<Array<string | Buffer>> {
  const entries = await readdir(input.currentDir, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const chunkGroups = await Promise.all(
    entries.map(async (entry): Promise<Array<string | Buffer>> => {
      const path = join(input.currentDir, entry.name)
      const relativePath = path.slice(input.sourceDir.length + 1)
      if (entry.isDirectory()) {
        const skipReason = skippedMaterializedSkillDirReason(relativePath)
        if (skipReason) {
          return [`skip-dir\0${skipReason}\0${relativePath}\0`]
        }
        return [
          `dir\0${relativePath}\0`,
          ...(await skillTreeDigestChunks({
            ...input,
            currentDir: path,
          })),
        ]
      }
      if (!entry.isFile()) {
        return []
      }

      const info = await lstat(path)
      if (
        metadataOnlyMaterialization() &&
        entry.name !== 'asset.json' &&
        entry.name !== 'SKILL.md'
      ) {
        return [`skip\0metadata-only-file\0${relativePath}\0${info.size}\0`]
      }
      if (shouldSkipGeneratedSkillFile(relativePath)) {
        return [`skip\0generated-cache\0${relativePath}\0${info.size}\0`]
      }
      if (input.maxFileBytes > 0 && info.size > input.maxFileBytes) {
        return [`skip\0too-large\0${relativePath}\0${info.size}\0`]
      }

      const header = `file\0${relativePath}\0${info.size}\0`
      if (relativePath === 'asset.json' || relativePath === 'SKILL.md') {
        return [header, await readFile(path), '\0']
      }
      return [`${header}${Math.trunc(info.mtimeMs)}\0`]
    }),
  )
  return chunkGroups.flat()
}

async function hashSkillTreeMaterializationDigest(input: {
  hash: ReturnType<typeof createHash>
  sourceDir: string
  currentDir: string
  maxFileBytes: number
}): Promise<void> {
  for (const chunk of await skillTreeDigestChunks(input)) {
    input.hash.update(chunk)
  }
}

async function materializationCacheKey(
  runtime: MatOSRuntimeProjection,
  options: MatOSRuntimeMaterializationOptions,
): Promise<string> {
  const hash = createHash('sha256')
  const maxFileBytes = maxMaterializedSkillFileBytes()
  hash.update('matos-runtime-materialization-v7\0')
  hash.update(`label\0${options.cacheLabel ?? ''}\0`)
  hash.update(`max-file-bytes\0${maxFileBytes}\0`)
  hash.update(
    `include-examples\0${materializeSkillExamples() ? '1' : '0'}\0`,
  )
  hash.update(`mode\0${materializationMode()}\0`)
  // Collect all skill-tree digest inputs concurrently, then hash in the same
  // deterministic order; sequential tree walks dominated cache-key time on
  // network filesystems.
  const skillDirs = [...new Set(runtime.skillDirs)].sort()
  const chunksPerSkill = await Promise.all(
    skillDirs.map(skillDir => {
      const resolved = resolve(skillDir)
      return skillTreeDigestChunks({
        sourceDir: resolved,
        currentDir: resolved,
        maxFileBytes,
      })
    }),
  )
  for (const [index, skillDir] of skillDirs.entries()) {
    hash.update(`skill\0${resolve(skillDir)}\0`)
    for (const chunk of chunksPerSkill[index] ?? []) {
      hash.update(chunk)
    }
  }
  return hash.digest('hex').slice(0, 32)
}

function addCount(counts: Map<string, number>, value: string | undefined): void {
  if (!value) {
    return
  }
  counts.set(value, (counts.get(value) ?? 0) + 1)
}

export async function materializeMatOSRuntime(
  cwd: string,
  runtime: MatOSRuntimeProjection,
  options: MatOSRuntimeMaterializationOptions = {},
): Promise<MatOSRuntimeMaterialization> {
  if (runtime.skillDirs.length === 0) {
    return { addDirs: [] }
  }

  const useCache = options.cache !== false
  const cacheKey = useCache
    ? await materializationCacheKey(runtime, options)
    : undefined
  const root = cacheKey
    ? getMatOSRuntimeMaterializationCacheRoot(cwd, cacheKey)
    : getMatOSRuntimeMaterializationRunRoot(cwd)
  if (cacheKey) {
    if (await isReusableMaterializationCacheRoot(root, cacheKey)) {
      await touchMaterializationCacheRoot(root)
      return { addDirs: [root] }
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }

  const writeRoot = cacheKey
    ? join(dirname(root), `.${basename(root)}.tmp-${randomUUID()}`)
    : root
  const writeSkillsRoot = join(writeRoot, '.matos', 'skills')
  await rm(writeRoot, { recursive: true, force: true })
  await mkdir(writeSkillsRoot, { recursive: true })

  const limit = createMaterializationFileLimiter(materializationCopyConcurrency())
  const skillDirs = [...new Set(runtime.skillDirs)]
  const skillIds = await Promise.all(skillDirs.map(dir => readSkillAssetId(dir)))

  // Resolve runtime names and detect collisions deterministically before any
  // copying so parallel tree copies cannot interleave with name checks.
  const materializedNames = new Map<string, string>()
  const materializedSkills: Array<{
    runtimeName: string
    leafAlias: string | undefined
    sourceDir: string
    targetDir: string
  }> = []
  const leafAliasCounts = new Map<string, number>()
  for (const [index, skillDir] of skillDirs.entries()) {
    const skillRef = skillIds[index] ?? basename(skillDir)
    const skillName = matOSSkillRuntimeName(skillRef)
    const leafAlias = matOSSkillRuntimeLeafAlias(skillRef)
    const existingSource = materializedNames.get(skillName)
    if (existingSource && existingSource !== skillDir) {
      throw new Error(
        `MatOS skill runtime name collision: ${skillName} maps to both ${existingSource} and ${skillDir}`,
      )
    }
    materializedNames.set(skillName, skillDir)
    materializedSkills.push({
      runtimeName: skillName,
      leafAlias,
      sourceDir: skillDir,
      targetDir: join(writeSkillsRoot, skillName),
    })
    addCount(leafAliasCounts, leafAlias)
  }

  await Promise.all(
    materializedSkills.map(skill =>
      copySkillModelOnly(skill.sourceDir, skill.targetDir, limit),
    ),
  )

  await Promise.all(
    materializedSkills.map(async skill => {
      const alias = skill.leafAlias
      if (
        !alias ||
        alias === skill.runtimeName ||
        leafAliasCounts.get(alias) !== 1 ||
        materializedNames.has(alias)
      ) {
        return
      }
      await copySkillModelOnly(
        skill.targetDir,
        join(writeSkillsRoot, alias),
        limit,
      )
    }),
  )

  if (cacheKey) {
    await writeFile(
      join(writeRoot, MATERIALIZATION_CACHE_MARKER),
      `${JSON.stringify(
        {
          version: 7,
          cacheKey,
          cacheLabel: options.cacheLabel,
          createdAt: new Date().toISOString(),
          skillDirCount: runtime.skillDirs.length,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const flip = await flipMaterializationCacheRootIntoPlace(
      writeRoot,
      root,
      cacheKey,
    )
    if (flip === 'created') {
      scheduleMaterializationCachePrune(root)
    }
  }

  return { addDirs: [root] }
}
