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

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { activeMatOSAssetArchiveScopeRef } from './archiveScope.js'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assetHistoryGitDir,
  git,
  gitWithInput,
  withTemporaryGitIndex,
} from './gitBackend.js'
import {
  matOSAssetHistoryAllowedRoots,
  matOSAssetHistoryLogicalPath,
  listCurrentMatOSAssetHistoryFiles,
  resolveMatOSAssetHistoryRecordPath,
  shouldIgnoreMatOSAssetHistoryPath,
} from './policy.js'
import {
  hasMatOSSecretLookingContent,
  isMatOSSecretLookingFileName,
} from '../secretScan.js'
import {
  readMatOSAssetHistorySnapshot,
  writeMatOSAssetHistorySnapshotRecord,
} from './records.js'
import type {
  MatOSAssetHistoryFileRecord,
  MatOSAssetHistoryScope,
  MatOSAssetHistorySnapshotKind,
  MatOSAssetHistorySnapshotRecord,
} from './types.js'

export type CreateMatOSAssetHistorySnapshotInput = {
  cwd: string
  kind: MatOSAssetHistorySnapshotKind
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  ref?: string
  parentCommit?: string
  message?: string
  paths?: string[]
  /**
   * Read snapshot bytes from an isolated tree while preserving the logical
   * identity of `paths` under the registered, scope-governed target root.
   * Both roots are checked on every file and symlinks are refused. This is
   * used by candidate governance so an unaccepted tree never has to be
   * copied into the runtime checkout merely to create history evidence.
   */
  contentSource?: {
    targetRoot: string
    sourceRoot: string
  }
  assetRefs?: string[]
  provenance?: Record<string, unknown>
}

const MAX_SECRET_SCAN_BYTES = 1024 * 1024
const WORKING_TREE_CACHE_SCHEMA_VERSION = 1
const SNAPSHOT_RACE_MAX_ATTEMPTS = 3

/**
 * Raised when the bytes staged into the snapshot commit no longer match the
 * bytes that were scanned and recorded moments earlier: a concurrent writer
 * (developer edit, self-evolution run on another surface) modified the file
 * between the two reads. Without this check the snapshot record's sha256
 * silently diverges from the committed blob and every later restore/rollback
 * of that snapshot fails with a hash mismatch — and content that never went
 * through the secret scan could be committed.
 */
export class MatOSAssetHistorySnapshotRaceError extends Error {
  constructor(path: string) {
    super(
      `MatOS asset history snapshot raced a concurrent modification of ${path}; scanned and staged bytes differ`,
    )
    this.name = 'MatOSAssetHistorySnapshotRaceError'
  }
}

/** Git blob object id (sha1 object format) for exact byte content. */
export function matOSGitBlobSha1(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

function timestampForId(): string {
  return new Date().toISOString().replace(/[^0-9A-Za-z]+/g, '').slice(0, 15)
}

function snapshotId(): string {
  return `asset-snapshot-${timestampForId()}-${randomBytes(4).toString('hex')}`
}

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return []
  }
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (shouldIgnoreMatOSAssetHistoryPath(fullPath)) {
      continue
    }
    const info = await lstat(fullPath)
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to snapshot symlink asset path: ${fullPath}`)
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

async function resolveSnapshotPaths(
  input: CreateMatOSAssetHistorySnapshotInput,
): Promise<string[]> {
  const cwd = resolve(input.cwd)
  const roots = matOSAssetHistoryAllowedRoots(
    cwd,
    input.scope,
    input.scopeRef,
  )
  // Compare canonical paths on both sides: deployment roots may be reached
  // through a workspace alias. File links that escape these roots still fail.
  const canonicalRoots = await Promise.all(roots.map(root => realpath(root).catch(() => resolve(root))))
  // Explicit non-absolute inputs are logical record paths and must resolve
  // through the same scope-aware mapping used by snapshot records, so core
  // paths reach the configured core pack root even outside the cwd.
  const explicit = input.paths?.map(path =>
    isAbsolute(path)
      ? path
      : resolveMatOSAssetHistoryRecordPath({
          cwd,
          scope: input.scope,
          ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
          path,
        })
          .absolutePath,
  )
  const candidates = explicit ?? (await Promise.all(roots.map(collectFiles))).flat()
  const files: string[] = []
  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    const contentPath = await resolveSnapshotContentPath(resolved, input.contentSource)
    if (explicit && !(await pathExists(contentPath))) {
      continue
    }
    const real = await realpath(resolved).catch(() => resolved)
    if (!canonicalRoots.some(root => isWithin(real, root))) {
      throw new Error(
        `Asset history path is outside MatOS asset history allowlist: ${relative(
          cwd,
          resolved,
        )}`,
      )
    }
    const info = await lstat(contentPath)
    if (!info.isFile()) {
      continue
    }
    if (shouldIgnoreMatOSAssetHistoryPath(resolved)) {
      continue
    }
    const logical = matOSAssetHistoryLogicalPath({
      cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      absolutePath: resolved,
    })
    const name = resolved.split(/[\\/]/).pop() ?? resolved
    if (isMatOSSecretLookingFileName(name)) {
      throw new Error(
        `Refusing to snapshot secret-looking file ${logical ?? relative(cwd, resolved).replace(/\\/g, '/')}`,
      )
    }
    files.push(resolved)
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

async function buildFileRecords(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef: string | undefined,
  files: string[],
  contentSource?: CreateMatOSAssetHistorySnapshotInput['contentSource'],
): Promise<{
  records: MatOSAssetHistoryFileRecord[]
  expectedGitBlobShaByPath: Map<string, string>
}> {
  const records: MatOSAssetHistoryFileRecord[] = []
  const expectedGitBlobShaByPath = new Map<string, string>()
  for (const file of files) {
    const logical = matOSAssetHistoryLogicalPath({
      cwd,
      scope,
      ...(scopeRef ? { scopeRef } : {}),
      absolutePath: file,
    })
    if (!logical) {
      throw new Error(
        `MatOS asset history file is outside allowed roots: ${file}`,
      )
    }
    const contentPath = await resolveSnapshotContentPath(file, contentSource)
    const raw = await readFile(contentPath)
    const text = raw.byteLength <= MAX_SECRET_SCAN_BYTES ? raw.toString('utf8') : ''
    if (
      text &&
      Buffer.from(text, 'utf8').equals(raw) &&
      hasMatOSSecretLookingContent(text)
    ) {
      throw new Error(`Refusing to snapshot secret-looking content in ${logical}`)
    }
    records.push({
      path: logical,
      sha256: createHash('sha256').update(raw).digest('hex'),
      sizeBytes: raw.byteLength,
    })
    expectedGitBlobShaByPath.set(logical, matOSGitBlobSha1(raw))
  }
  return { records, expectedGitBlobShaByPath }
}

async function resolveSnapshotContentPath(
  targetPath: string,
  contentSource?: CreateMatOSAssetHistorySnapshotInput['contentSource'],
): Promise<string> {
  if (!contentSource) {
    return targetPath
  }
  const targetRoot = resolve(contentSource.targetRoot)
  const sourceRoot = resolve(contentSource.sourceRoot)
  if (!isWithin(targetPath, targetRoot)) {
    throw new Error(
      `MatOS asset history content target is outside the declared target root: ${targetPath}`,
    )
  }
  const relativePath = relative(targetRoot, resolve(targetPath))
  const sourcePath = resolve(sourceRoot, relativePath)
  if (!isWithin(sourcePath, sourceRoot)) {
    throw new Error(
      `MatOS asset history content path escaped the isolated source root: ${targetPath}`,
    )
  }
  const [sourceRootReal, sourceInfo] = await Promise.all([
    realpath(sourceRoot),
    lstat(sourcePath),
  ])
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error(
      `Refusing non-regular alternate asset history content: ${sourcePath}`,
    )
  }
  const sourceReal = await realpath(sourcePath)
  if (!isWithin(sourceReal, sourceRootReal)) {
    throw new Error(
      `Alternate asset history content resolves outside its source root: ${sourcePath}`,
    )
  }
  return sourceReal
}

async function nearestAssetManifest(
  roots: string[],
  file: string,
): Promise<string | undefined> {
  let dir = dirname(file)
  while (roots.some(root => isWithin(dir, root) && dir !== resolve(root))) {
    const manifestPath = join(dir, 'asset.json')
    if (await pathExists(manifestPath)) {
      return manifestPath
    }
    const next = dirname(dir)
    if (next === dir) {
      return undefined
    }
    dir = next
  }
  return undefined
}

async function inferAssetRefsForFiles(
  roots: string[],
  files: string[],
): Promise<string[]> {
  const refs = new Set<string>()
  for (const file of files) {
    const manifestPath = await nearestAssetManifest(roots, file)
    if (!manifestPath) {
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        type?: unknown
        id?: unknown
        version?: unknown
      }
      if (typeof manifest.type !== 'string' || typeof manifest.id !== 'string') {
        continue
      }
      const unversioned = `${manifest.type}:${manifest.id}`
      refs.add(unversioned)
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        refs.add(`${unversioned}@${manifest.version}`)
      }
    } catch {
      continue
    }
  }
  return [...refs].sort((a, b) => a.localeCompare(b))
}

type WorkingTreeMetadataRecord = {
  path: string
  sizeBytes: string
  mode: string
  mtimeNs: string
  ctimeNs: string
}

type WorkingTreeChangeCacheRecord = {
  schemaVersion: typeof WORKING_TREE_CACHE_SCHEMA_VERSION
  snapshotId: string
  snapshotCommit: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  currentDiffersFromStable: boolean
  files: WorkingTreeMetadataRecord[]
  createdAt: string
}

function workingTreeCachePath(cwd: string, snapshotId: string): string {
  return join(
    dirname(assetHistoryGitDir(cwd)),
    'asset-history-cache',
    'working-tree',
    `${snapshotId}.json`,
  )
}

async function buildWorkingTreeMetadataRecords(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
}): Promise<WorkingTreeMetadataRecord[] | undefined> {
  const logicalPaths = await listCurrentMatOSAssetHistoryFiles(input)
  const records: WorkingTreeMetadataRecord[] = []
  for (const path of logicalPaths) {
    const { absolutePath } = resolveMatOSAssetHistoryRecordPath({
      cwd: input.cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      path,
    })
    const info = await lstat(absolutePath, { bigint: true }).catch(() => undefined)
    if (!info || !info.isFile()) {
      return undefined
    }
    records.push({
      path,
      sizeBytes: info.size.toString(),
      mode: info.mode.toString(),
      mtimeNs: info.mtimeNs.toString(),
      ctimeNs: info.ctimeNs.toString(),
    })
  }
  return records.sort((a, b) => a.path.localeCompare(b.path))
}

function sameWorkingTreeMetadata(
  left: WorkingTreeMetadataRecord[],
  right: WorkingTreeMetadataRecord[],
): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (
      a?.path !== b?.path ||
      a?.sizeBytes !== b?.sizeBytes ||
      a?.mode !== b?.mode ||
      a?.mtimeNs !== b?.mtimeNs ||
      a?.ctimeNs !== b?.ctimeNs
    ) {
      return false
    }
  }
  return true
}

async function readWorkingTreeChangeCache(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
  currentMetadata: WorkingTreeMetadataRecord[] | undefined
}): Promise<boolean | undefined> {
  if (
    process.env.MATOS_ASSET_HISTORY_DISABLE_WORKTREE_CACHE === '1' ||
    !input.currentMetadata
  ) {
    return undefined
  }
  try {
    const raw = JSON.parse(
      await readFile(
        workingTreeCachePath(input.cwd, input.snapshot.snapshotId),
        'utf8',
      ),
    ) as Partial<WorkingTreeChangeCacheRecord>
    if (
      raw.schemaVersion !== WORKING_TREE_CACHE_SCHEMA_VERSION ||
      raw.snapshotId !== input.snapshot.snapshotId ||
      raw.snapshotCommit !== input.snapshot.commit ||
      raw.scope !== input.snapshot.scope ||
      raw.scopeRef !== input.snapshot.scopeRef ||
      typeof raw.currentDiffersFromStable !== 'boolean' ||
      !Array.isArray(raw.files)
    ) {
      return undefined
    }
    return sameWorkingTreeMetadata(
      input.currentMetadata,
      raw.files as WorkingTreeMetadataRecord[],
    )
      ? raw.currentDiffersFromStable
      : undefined
  } catch {
    return undefined
  }
}

async function writeWorkingTreeChangeCache(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
  currentMetadata: WorkingTreeMetadataRecord[] | undefined
  currentDiffersFromStable: boolean
}): Promise<void> {
  if (
    process.env.MATOS_ASSET_HISTORY_DISABLE_WORKTREE_CACHE === '1' ||
    !input.currentMetadata
  ) {
    return
  }
  const path = workingTreeCachePath(input.cwd, input.snapshot.snapshotId)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const record: WorkingTreeChangeCacheRecord = {
    schemaVersion: WORKING_TREE_CACHE_SCHEMA_VERSION,
    snapshotId: input.snapshot.snapshotId,
    snapshotCommit: input.snapshot.commit,
    scope: input.snapshot.scope,
    ...(input.snapshot.scopeRef
      ? { scopeRef: input.snapshot.scopeRef }
      : {}),
    currentDiffersFromStable: input.currentDiffersFromStable,
    files: input.currentMetadata,
    createdAt: new Date().toISOString(),
  }
  await writeFile(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  await rename(tmp, path).catch(async () => {
    await writeFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  })
}

async function hasWorkingTreeFileRecordChanges(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
  currentMetadata: WorkingTreeMetadataRecord[] | undefined
}): Promise<boolean> {
  const snapshotFiles = new Map(
    input.snapshot.files.map(file => [file.path, file] as const),
  )
  const currentMetadata =
    input.currentMetadata ??
    (await buildWorkingTreeMetadataRecords({
      cwd: input.cwd,
      scope: input.snapshot.scope,
      ...(input.snapshot.scopeRef
        ? { scopeRef: input.snapshot.scopeRef }
        : {}),
    }))
  if (!currentMetadata) {
    // Metadata collection intentionally refuses non-regular files. Run the
    // normal snapshot resolver here so unsafe paths such as escaping symlinks
    // surface the actionable policy error instead of a generic cache miss.
    await resolveSnapshotPaths({
      cwd: input.cwd,
      kind: input.snapshot.kind,
      scope: input.snapshot.scope,
      ...(input.snapshot.scopeRef
        ? { scopeRef: input.snapshot.scopeRef }
        : {}),
    })
    return true
  }
  const currentPaths = new Set(currentMetadata.map(file => file.path))
  if (currentPaths.size !== snapshotFiles.size) {
    return true
  }
  for (const path of snapshotFiles.keys()) {
    if (!currentPaths.has(path)) {
      return true
    }
  }
  for (const current of currentMetadata) {
    const expected = snapshotFiles.get(current.path)
    if (!expected) {
      return true
    }
    if (current.sizeBytes !== String(expected.sizeBytes)) {
      return true
    }
  }
  return (
    (
      await listWorkingTreeChangedFilesForSnapshot({
        cwd: input.cwd,
        snapshot: input.snapshot,
      })
    ).length > 0
  )
}

async function stageAssetHistoryPaths(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  paths: string[]
  indexFile: string
  contentSource?: CreateMatOSAssetHistorySnapshotInput['contentSource']
  expectedGitBlobShaByPath?: Map<string, string>
}): Promise<void> {
  const entries = await Promise.all(
    input.paths.map(async path => {
      const targetPath = resolveMatOSAssetHistoryRecordPath({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        path,
      }).absolutePath
      const absolutePath = await resolveSnapshotContentPath(
        targetPath,
        input.contentSource,
      )
      const info = await stat(absolutePath)
      const mode = info.mode & 0o111 ? '100755' : '100644'
      return { absolutePath, mode, path }
    }),
  )
  if (entries.length === 0) {
    return
  }
  const hashes = (
    await gitWithInput(
      input.cwd,
      ['hash-object', '-w', '--stdin-paths'],
      `${entries.map(entry => entry.absolutePath).join('\n')}\n`,
      { indexFile: input.indexFile },
    )
  ).trim().split('\n').filter(Boolean)
  if (hashes.length !== entries.length) {
    throw new Error(
      `MatOS asset history hash-object returned ${hashes.length} hashes for ${entries.length} files`,
    )
  }
  // hash-object re-reads each file from disk, so the staged bytes can differ
  // from the bytes buildFileRecords scanned and recorded if a concurrent
  // writer touched the file in between. Compare the staged blob id against
  // the one derived from the scanned bytes and fail the attempt as a race
  // instead of committing a snapshot whose record disagrees with its commit.
  // Skip the comparison when the repository does not use the sha1 object
  // format (hash length != 40), where the derived id is not comparable.
  if (input.expectedGitBlobShaByPath) {
    for (const [index, entry] of entries.entries()) {
      const expected = input.expectedGitBlobShaByPath.get(entry.path)
      const actual = hashes[index]
      if (
        expected &&
        actual &&
        actual.length === 40 &&
        actual.toLowerCase() !== expected.toLowerCase()
      ) {
        throw new MatOSAssetHistorySnapshotRaceError(entry.path)
      }
    }
  }
  const indexInfo = entries
    .map((entry, index) => `${entry.mode} ${hashes[index]}\t${entry.path}`)
    .join('\n')
  await gitWithInput(
    input.cwd,
    ['update-index', '--index-info'],
    `${indexInfo}\n`,
    { indexFile: input.indexFile },
  )
}

// Stage a file list into a temporary git index without relying on the git
// work tree. `git add` can only stage paths inside GIT_WORK_TREE (the cwd),
// but the resolved core pack root may live outside the cwd, so each file is
// hashed explicitly and registered under its
// stable logical record path.
async function stageSnapshotFiles(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  fileRecords: MatOSAssetHistoryFileRecord[]
  indexFile: string
  contentSource?: CreateMatOSAssetHistorySnapshotInput['contentSource']
  expectedGitBlobShaByPath?: Map<string, string>
}): Promise<void> {
  await stageAssetHistoryPaths({
    cwd: input.cwd,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    paths: input.fileRecords.map(file => file.path),
    indexFile: input.indexFile,
    ...(input.contentSource ? { contentSource: input.contentSource } : {}),
    ...(input.expectedGitBlobShaByPath
      ? { expectedGitBlobShaByPath: input.expectedGitBlobShaByPath }
      : {}),
  })
}

async function listWorkingTreeChangedFilesForSnapshot(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
}): Promise<string[]> {
  const paths = await listCurrentMatOSAssetHistoryFiles({
    cwd: input.cwd,
    scope: input.snapshot.scope,
    ...(input.snapshot.scopeRef
      ? { scopeRef: input.snapshot.scopeRef }
      : {}),
  })
  const operationId = `${input.snapshot.snapshotId.replace(
    /[^A-Za-z0-9_-]/g,
    '',
  )}-worktree-diff`
  const changed = await withTemporaryGitIndex(
    input.cwd,
    operationId,
    async indexFile => {
      await git(input.cwd, ['read-tree', '--empty'], { indexFile })
      await stageAssetHistoryPaths({
        cwd: input.cwd,
        scope: input.snapshot.scope,
        ...(input.snapshot.scopeRef
          ? { scopeRef: input.snapshot.scopeRef }
          : {}),
        paths,
        indexFile,
      })
      return git(input.cwd, ['diff', '--name-only', '--cached', input.snapshot.commit], {
        indexFile,
      })
    },
  )
  return changed
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

export async function listMatOSAssetHistoryWorkingTreeChangedFiles(input: {
  cwd: string
  snapshotId: string
}): Promise<string[]> {
  const cwd = resolve(input.cwd)
  const snapshot = await readMatOSAssetHistorySnapshot(cwd, input.snapshotId)
  if (!snapshot) {
    throw new Error(`MatOS asset history snapshot not found: ${input.snapshotId}`)
  }
  return listWorkingTreeChangedFilesForSnapshot({ cwd, snapshot })
}

export async function createMatOSAssetHistorySnapshot(
  input: CreateMatOSAssetHistorySnapshotInput,
): Promise<MatOSAssetHistorySnapshotRecord> {
  // A concurrent writer racing the snapshot is transient: re-scan and retry
  // so the recorded hashes and the committed blobs are taken from one
  // consistent read of every file.
  let lastRace: Error | undefined
  for (let attempt = 0; attempt < SNAPSHOT_RACE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await createMatOSAssetHistorySnapshotOnce(input)
    } catch (error) {
      if (
        !(error instanceof MatOSAssetHistorySnapshotRaceError) &&
        !isConcurrentWriteGitError(error)
      ) {
        throw error
      }
      lastRace = error as Error
    }
  }
  throw lastRace
}

/**
 * git reports a file that shrank while it was being indexed as a hard command
 * failure. That is the same concurrent-writer race the hash comparison catches,
 * just detected inside git, so it must be retried rather than surfaced as a
 * snapshot failure.
 */
function isConcurrentWriteGitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const text = `${error.message}\n${
    (error as { stderr?: string }).stderr ?? ''
  }`
  return (
    text.includes('short read while indexing') ||
    text.includes('Unable to add') ||
    text.includes('did not match count')
  )
}

async function createMatOSAssetHistorySnapshotOnce(
  input: CreateMatOSAssetHistorySnapshotInput,
): Promise<MatOSAssetHistorySnapshotRecord> {
  const cwd = resolve(input.cwd)
  const id = snapshotId()
  const files = await resolveSnapshotPaths({ ...input, cwd })
  const { records: fileRecords, expectedGitBlobShaByPath } =
    await buildFileRecords(
      cwd,
      input.scope,
      input.scopeRef,
      files,
      input.contentSource,
    )
  const assetRefs =
    input.assetRefs ??
    (await inferAssetRefsForFiles(
      matOSAssetHistoryAllowedRoots(cwd, input.scope, input.scopeRef),
      files,
    ))
  const operationId = id.replace(/[^A-Za-z0-9_-]/g, '')
  const commit = await withTemporaryGitIndex(cwd, operationId, async indexFile => {
    await git(cwd, ['read-tree', '--empty'], { indexFile })
    await stageSnapshotFiles({
      cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      fileRecords,
      indexFile,
      ...(input.contentSource ? { contentSource: input.contentSource } : {}),
      expectedGitBlobShaByPath,
    })
    const tree = (await git(cwd, ['write-tree'], { indexFile })).trim()
    const args = ['commit-tree', tree]
    if (input.parentCommit) {
      args.push('-p', input.parentCommit)
    }
    args.push('-m', input.message ?? `${input.kind} ${id}`)
    return (await git(cwd, args, { indexFile })).trim()
  })
  // JSON records are not GC roots. Keep every revision reachable even after
  // the mutable stable/latest ref advances or an editor candidate is rejected.
  await git(cwd, ['update-ref', `refs/matos/snapshots/${id}`, commit, ''])
  if (input.ref) {
    await git(cwd, ['update-ref', input.ref, commit])
  }
  const provenance = { ...input.provenance }
  delete provenance.archiveOwnerScopeRef
  const ownerScopeRef = activeMatOSAssetArchiveScopeRef()
  if (input.scope === 'project' && !input.scopeRef && ownerScopeRef && /^(user|team|project):[^\s]+$/.test(ownerScopeRef)) provenance.archiveOwnerScopeRef = ownerScopeRef
  const record: MatOSAssetHistorySnapshotRecord = {
    schemaVersion: 1,
    snapshotId: id,
    kind: input.kind,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    fullScope: !input.paths,
    gitDir: relative(cwd, assetHistoryGitDir(cwd)).replace(/\\/g, '/'),
    commit,
    ...(input.parentCommit ? { parentCommit: input.parentCommit } : {}),
    ...(input.ref ? { ref: input.ref } : {}),
    createdAt: new Date().toISOString(),
    cwd,
    assetRefs,
    files: fileRecords,
    ...(Object.keys(provenance).length ? { provenance } : {}),
  }
  await mkdir(dirname(join(cwd, '.matos')), { recursive: true })
  await writeMatOSAssetHistorySnapshotRecord(cwd, record)
  return record
}

export async function hasMatOSAssetHistoryWorkingTreeChanges(input: {
  cwd: string
  snapshotId: string
}): Promise<boolean> {
  const cwd = resolve(input.cwd)
  const snapshot = await readMatOSAssetHistorySnapshot(cwd, input.snapshotId)
  if (!snapshot) {
    throw new Error(`MatOS asset history snapshot not found: ${input.snapshotId}`)
  }
  const currentMetadata = await buildWorkingTreeMetadataRecords({
    cwd,
    scope: snapshot.scope,
    ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
  }).catch(() => undefined)
  const cached = await readWorkingTreeChangeCache({
    cwd,
    snapshot,
    currentMetadata,
  })
  if (cached !== undefined) {
    return cached
  }
  const changed = await hasWorkingTreeFileRecordChanges({
    cwd,
    snapshot,
    currentMetadata,
  })
  await writeWorkingTreeChangeCache({
    cwd,
    snapshot,
    currentMetadata,
    currentDiffersFromStable: changed,
  }).catch(() => undefined)
  return changed
}
