import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { readMatOSAssetHistorySnapshot } from '../assets/history/index.js'
import { gitBuffer } from '../assets/history/gitBackend.js'
import {
  isWithinMatOSAssetHistoryPath,
  matOSAssetHistoryAllowedRoots,
} from '../assets/history/policy.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { writeJson } from '../workflows/jsonIo.js'
import {
  backupImportPath,
  captureImportPathEntry,
  guardKeyForPath,
  listHiddenAssetDirs,
  listImportableAssetEntries,
  optionalEntriesEqual,
  pruneEmptyDirectoriesToBase,
  writeImportedAssetEntry,
  type DirectEditorImportBackup,
  type GuardedPathEntry,
} from './directAssetEditorFilesystem.js'
import type {
  MatOSDirectAssetEditorMergeConflict,
  MatOSDirectAssetEditorMergeMode,
  MatOSDirectAssetEditorPendingMergeRecord,
} from './directAssetEditor.js'
import { DIRECT_EDITOR_RUNS_DIR } from './directAssetEditorTransaction.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'
import {
  assertPathStaysUnderRoot,
  assertSafeEvolutionRecordId,
} from './evolutionRecordPaths.js'

const execFileAsync = promisify(execFile)

export type DirectEditorImportResult = {
  backups: DirectEditorImportBackup[]
  touchedPaths: string[]
  mergeMode?: MatOSDirectAssetEditorMergeMode
  dirtyFilesAtStart?: string[]
  pendingMerge?: string
  mergeConflicts?: MatOSDirectAssetEditorMergeConflict[]
}

// Import apply failures must not lose the record of already-applied
// operations: the thrown error carries the backups captured for every
// operation that was started, so the caller can restore the touched real
// paths (including removing files the import created) before rolling back.
export class DirectEditorImportError extends Error {
  readonly appliedBackups: DirectEditorImportBackup[]

  constructor(input: {
    message: string
    appliedBackups: DirectEditorImportBackup[]
    cause?: unknown
  }) {
    super(
      input.message,
      input.cause === undefined ? undefined : { cause: input.cause },
    )
    this.name = 'DirectEditorImportError'
    this.appliedBackups = input.appliedBackups
  }
}

type DirectEditorImportRootPlan = {
  backups: DirectEditorImportBackup[]
  operations: DirectEditorImportOperation[]
  mergeMode?: MatOSDirectAssetEditorMergeMode
  conflicts: MatOSDirectAssetEditorMergeConflict[]
  pendingFiles: DirectEditorMergeFileVersion[]
}

type DirectEditorImportOperation =
  | { kind: 'write'; absolutePath: string; entry: GuardedPathEntry }
  | { kind: 'remove'; absolutePath: string }

type DirectEditorMergeFileVersion = {
  path: string
  base?: GuardedPathEntry
  current?: GuardedPathEntry
  edit?: GuardedPathEntry
}

function pendingMergesDir(cwd: string): string {
  return join(cwd, '.matos', 'evolution', 'direct-editor', 'pending-merges')
}

function pendingMergeDir(cwd: string, runId: string): string {
  const safeId = assertSafeEvolutionRecordId(runId, 'direct editor pending merge id')
  return assertPathStaysUnderRoot(pendingMergesDir(cwd), join(pendingMergesDir(cwd), safeId))
}

function nowIso(): string {
  return new Date().toISOString()
}

async function writeJsonFile(
  dir: string,
  name: string,
  value: unknown,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  // Atomic same-directory tmp+rename write: recovery readers silently drop
  // records that fail to parse, so a crash mid-write must never leave a
  // truncated JSON document at the target path.
  await writeJson(join(dir, name), value)
}

function sha256Buffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function fileSha256(path: string): Promise<string | undefined> {
  const entry = await captureImportPathEntry(path)
  return entry?.kind === 'file' ? sha256Buffer(entry.content) : undefined
}

async function snapshotEntriesForRoot(input: {
  cwd: string
  snapshotId: string
  logicalRoot: string
}): Promise<Map<string, GuardedPathEntry>> {
  const snapshot = await readMatOSAssetHistorySnapshot(input.cwd, input.snapshotId)
  if (!snapshot) {
    throw new Error(`MatOS asset history snapshot not found: ${input.snapshotId}`)
  }
  const entries = new Map<string, GuardedPathEntry>()
  const prefix = input.logicalRoot.endsWith('/')
    ? input.logicalRoot
    : `${input.logicalRoot}/`
  for (const file of snapshot.files) {
    if (!file.path.startsWith(prefix)) {
      continue
    }
    const relativePath = file.path.slice(prefix.length)
    if (!relativePath) {
      continue
    }
    const content = await gitBuffer(input.cwd, [
      'show',
      `${snapshot.commit}:${file.path}`,
    ])
    entries.set(relativePath, { kind: 'file', content })
  }
  return entries
}

function hiddenRelativePrefixesForRoot(input: {
  realRoot: string
  hiddenDirs: string[]
}): string[] {
  const root = resolve(input.realRoot)
  return input.hiddenDirs
    .map(dir => resolve(dir))
    .filter(dir => isWithinMatOSAssetHistoryPath(dir, root))
    .map(dir => relative(root, dir).replace(/\\/g, '/'))
    .filter(Boolean)
    .map(prefix => (prefix.endsWith('/') ? prefix : `${prefix}/`))
}

function filterSkippedRelativeEntries(
  entries: Map<string, GuardedPathEntry>,
  skipPrefixes: string[],
): Map<string, GuardedPathEntry> {
  if (skipPrefixes.length === 0) {
    return entries
  }
  return new Map(
    [...entries.entries()].filter(
      ([path]) =>
        !skipPrefixes.some(prefix => path === prefix.slice(0, -1) || path.startsWith(prefix)),
    ),
  )
}

function entryIsTextFile(
  entry: GuardedPathEntry | undefined,
): entry is { kind: 'file'; content: Buffer } {
  if (!entry || entry.kind !== 'file') {
    return false
  }
  return Buffer.from(entry.content.toString('utf8'), 'utf8').equals(entry.content)
}

const ABSENT_JSON_FIELD = Symbol('absent')

function mergeJsonValues(base: unknown, current: unknown, edit: unknown, depth = 0):
  | { ok: true; value: unknown }
  | { ok: false } {
  if (isDeepStrictEqual(current, edit) || isDeepStrictEqual(base, edit)) return { ok: true, value: current }
  if (isDeepStrictEqual(base, current)) return { ok: true, value: edit }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (depth >= 64 || !object(base) || !object(current) || !object(edit)) return { ok: false }
  const merged: Record<string, unknown> = Object.create(null)
  for (const key of new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(edit)])) {
    const field = (value: Record<string, unknown>) => Object.hasOwn(value, key) ? value[key] : ABSENT_JSON_FIELD
    const result = mergeJsonValues(field(base), field(current), field(edit), depth + 1)
    if (!result.ok) return result
    if (result.value !== ABSENT_JSON_FIELD) merged[key] = result.value
  }
  return { ok: true, value: merged }
}

async function mergeFileEntries(input: {
  cwd: string
  runId: string
  path: string
  base: GuardedPathEntry | undefined
  current: GuardedPathEntry | undefined
  edit: GuardedPathEntry | undefined
}): Promise<
  | { status: 'merged'; entry: GuardedPathEntry | undefined }
  | { status: 'keep_current'; reason: string }
  | { status: 'conflict'; reason: string }
> {
  if (!input.base && input.current) {
    return {
      status: 'keep_current',
      reason: 'asset entry was created concurrently; preserving current entry',
    }
  }
  if (!input.edit) {
    return optionalEntriesEqual(input.base, input.current)
      ? { status: 'merged', entry: undefined }
      : {
          status: 'conflict',
          reason: 'direct editor deleted a file that also differs from the stable baseline',
        }
  }
  if (
    !entryIsTextFile(input.base) ||
    !entryIsTextFile(input.current) ||
    !entryIsTextFile(input.edit)
  ) {
    return {
      status: 'conflict',
      reason: 'three-way merge is only supported for existing text files',
    }
  }
  if (input.path.endsWith('.json')) {
    try {
      const merged = mergeJsonValues(
        JSON.parse(input.base.content.toString('utf8')),
        JSON.parse(input.current.content.toString('utf8')),
        JSON.parse(input.edit.content.toString('utf8')),
      )
      return merged.ok
        ? { status: 'merged', entry: { kind: 'file', content: Buffer.from(`${JSON.stringify(merged.value, null, 2)}\n`) } }
        : { status: 'conflict', reason: 'the same JSON field changed in current assets and direct-editor output' }
    } catch {
      // Invalid/legacy JSON still goes through text merge and native validation.
    }
  }
  const tmp = await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: `${input.runId}-merge-`,
  })
  try {
    const basePath = join(tmp, 'base')
    const currentPath = join(tmp, 'current')
    const editPath = join(tmp, 'edit')
    await writeFile(basePath, input.base.content)
    await writeFile(currentPath, input.current.content)
    await writeFile(editPath, input.edit.content)
    try {
      const result = await execFileAsync('git', [
        'merge-file',
        '-p',
        currentPath,
        basePath,
        editPath,
      ], {
        cwd: input.cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
      return {
        status: 'merged',
        entry: { kind: 'file', content: Buffer.from(String(result.stdout ?? ''), 'utf8') },
      }
    } catch (error) {
      const exitCode =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : undefined
      if (exitCode === 1) {
        return {
          status: 'conflict',
          reason: 'same hunk changed in current assets and direct-editor output',
        }
      }
      return {
        status: 'conflict',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function pendingMergeFileId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 24)
}

async function writePendingMergeVersion(input: {
  dir: string
  name: string
  entry: GuardedPathEntry | undefined
}): Promise<{ path: string; kind: 'file' | 'absent' | 'symlink' | 'dir' }> {
  const relativePath = join('files', input.name).replace(/\\/g, '/')
  const path = join(input.dir, relativePath)
  await mkdir(dirname(path), { recursive: true })
  if (!input.entry) {
    await writeFile(path, '', 'utf8')
    return { path: relativePath, kind: 'absent' }
  }
  if (input.entry.kind !== 'file') {
    await writeFile(path, `<${input.entry.kind}>`, 'utf8')
    return { path: relativePath, kind: input.entry.kind }
  }
  await writeFile(path, input.entry.content)
  return { path: relativePath, kind: 'file' }
}

async function writePendingDirectEditorMerge(input: {
  cwd: string
  runId: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  dirtyFilesAtStart: string[]
  conflicts: MatOSDirectAssetEditorMergeConflict[]
  files: DirectEditorMergeFileVersion[]
}): Promise<MatOSDirectAssetEditorPendingMergeRecord> {
  const dir = pendingMergeDir(input.cwd, input.runId)
  await mkdir(dir, { recursive: true })
  const fileRecords: MatOSDirectAssetEditorPendingMergeRecord['files'] = []
  for (const file of input.files) {
    const id = pendingMergeFileId(file.path)
    const base = await writePendingMergeVersion({
      dir,
      name: `${id}.base`,
      entry: file.base,
    })
    const current = await writePendingMergeVersion({
      dir,
      name: `${id}.current`,
      entry: file.current,
    })
    const edit = await writePendingMergeVersion({
      dir,
      name: `${id}.edit`,
      entry: file.edit,
    })
    fileRecords.push({
      path: file.path,
      basePath: base.path,
      baseKind: base.kind,
      currentPath: current.path,
      currentKind: current.kind,
      editPath: edit.path,
      editKind: edit.kind,
    })
  }
  const timestamp = nowIso()
  const record: MatOSDirectAssetEditorPendingMergeRecord = {
    schemaVersion: 1,
    runId: input.runId,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    mergeMode: 'conflict',
    dirtyFilesAtStart: input.dirtyFilesAtStart,
    conflicts: input.conflicts,
    files: fileRecords,
    runRecordPath: join(
      '.matos',
      ...DIRECT_EDITOR_RUNS_DIR,
      input.runId,
      'run.json',
    ).replace(/\\/g, '/'),
  }
  await writeJsonFile(dir, 'record.json', record)
  return record
}

async function planImportableAssetRootSync(input: {
  realCwd: string
  runId: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  realRoot: string
  isolatedRoot: string
  beforeSnapshotId: string
  baseSnapshotId: string
  dirtyFilesAtStart: string[]
  hiddenDirsByRoot: { real: string[]; isolated: string[] }
}): Promise<DirectEditorImportRootPlan> {
  const logicalRoot = guardKeyForPath(
    input.realCwd,
    input.realRoot,
    input.scope,
    input.scopeRef,
  )
  const sourceEntries = await listImportableAssetEntries({
    root: input.isolatedRoot,
    skipDirs: input.hiddenDirsByRoot.isolated,
  })
  const currentEntries = await listImportableAssetEntries({
    root: input.realRoot,
    skipDirs: input.hiddenDirsByRoot.real,
  })
  const hiddenRelativePrefixes = hiddenRelativePrefixesForRoot({
    realRoot: input.realRoot,
    hiddenDirs: input.hiddenDirsByRoot.real,
  })
  const beforeEntries = filterSkippedRelativeEntries(
    await snapshotEntriesForRoot({
      cwd: input.realCwd,
      snapshotId: input.beforeSnapshotId,
      logicalRoot,
    }),
    hiddenRelativePrefixes,
  )
  const paths = new Set([
    ...[...sourceEntries.entries()]
      .filter(([, entry]) => entry.kind !== 'dir')
      .map(([path]) => path),
    ...beforeEntries.keys(),
  ])
  const backups = new Map<string, DirectEditorImportBackup>()
  const operations: DirectEditorImportOperation[] = []
  const conflicts: MatOSDirectAssetEditorMergeConflict[] = []
  const pendingFiles: DirectEditorMergeFileVersion[] = []
  let usedThreeWay = false
  let usedDirtyAuto = false

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const sourceEntry = sourceEntries.get(path)
    const beforeEntry = beforeEntries.get(path)
    if (sourceEntry?.kind === 'dir') {
      continue
    }
    if (optionalEntriesEqual(sourceEntry, beforeEntry)) {
      continue
    }
    const currentEntry = currentEntries.get(path)
    // The isolation workspace was copied from beforeSnapshot, not the last
    // accepted baseline. Changes already present at preparation are part of
    // the editor's input, not a concurrent branch to merge a second time.
    const baseEntry = beforeEntry
    const absolutePath = join(input.realRoot, path)
    const logicalPath = guardKeyForPath(
      input.realCwd,
      absolutePath,
      input.scope,
      input.scopeRef,
    )
    const fileVersion: DirectEditorMergeFileVersion = {
      path: logicalPath,
      base: baseEntry,
      current: currentEntry,
      edit: sourceEntry,
    }
    pendingFiles.push(fileVersion)
    const needsMerge = !optionalEntriesEqual(currentEntry, beforeEntry)
    if (needsMerge) {
      const merge = await mergeFileEntries({
        cwd: input.realCwd,
        runId: input.runId,
        path: logicalPath,
        base: baseEntry,
        current: currentEntry,
        edit: sourceEntry,
      })
      if (merge.status === 'conflict') {
        conflicts.push({ path: logicalPath, reason: merge.reason })
        continue
      }
      if (merge.status === 'keep_current') {
        usedDirtyAuto = true
        continue
      }
      usedThreeWay = true
      await backupImportPath({ absolutePath, backups })
      if (!merge.entry) {
        operations.push({ kind: 'remove', absolutePath })
      } else {
        operations.push({ kind: 'write', absolutePath, entry: merge.entry })
      }
      continue
    }
    usedDirtyAuto = usedDirtyAuto || input.dirtyFilesAtStart.length > 0
    await backupImportPath({ absolutePath, backups })
    if (!sourceEntry) {
      operations.push({ kind: 'remove', absolutePath })
    } else {
      operations.push({ kind: 'write', absolutePath, entry: sourceEntry })
    }
  }

  return {
    backups: [...backups.values()],
    operations,
    conflicts,
    pendingFiles,
    ...(usedThreeWay
      ? { mergeMode: 'dirty-three-way' as const }
      : usedDirtyAuto
        ? { mergeMode: 'dirty-auto' as const }
        : {}),
  }
}

export async function importDirectEditorAllowedRootsFromIsolation(input: {
  realCwd: string
  isolatedCwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  runId: string
  beforeSnapshotId: string
  baseSnapshotId: string
  dirtyFilesAtStart: string[]
}): Promise<DirectEditorImportResult> {
  const realHiddenDirs = await listHiddenAssetDirs(
    input.realCwd,
    input.scope,
    input.scopeRef,
  )
  const isolatedHiddenDirs = realHiddenDirs.map(dir =>
    resolve(
      join(
        input.isolatedCwd,
        guardKeyForPath(
          input.realCwd,
          dir,
          input.scope,
          input.scopeRef,
        ),
      ),
    ),
  )
  const backups: DirectEditorImportBackup[] = []
  const touchedPaths = new Set<string>()
  let mergeMode: MatOSDirectAssetEditorMergeMode | undefined
  const plans: DirectEditorImportRootPlan[] = []
  for (const realRoot of matOSAssetHistoryAllowedRoots(
    input.realCwd,
    input.scope,
    input.scopeRef,
  )) {
    const logicalRoot = guardKeyForPath(
      input.realCwd,
      realRoot,
      input.scope,
      input.scopeRef,
    )
    const isolatedRoot = join(input.isolatedCwd, logicalRoot)
    const plan = await planImportableAssetRootSync({
      realCwd: input.realCwd,
      runId: input.runId,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      realRoot,
      isolatedRoot,
      beforeSnapshotId: input.beforeSnapshotId,
      baseSnapshotId: input.baseSnapshotId,
      dirtyFilesAtStart: input.dirtyFilesAtStart,
      hiddenDirsByRoot: { real: realHiddenDirs, isolated: isolatedHiddenDirs },
    })
    plans.push(plan)
    if (plan.mergeMode === 'dirty-three-way') {
      mergeMode = 'dirty-three-way'
    } else if (!mergeMode && plan.mergeMode === 'dirty-auto') {
      mergeMode = 'dirty-auto'
    }
  }
  // All roots are planned before anything is applied. A conflict in any root
  // means nothing is applied, and the pending merge record aggregates every
  // root's file versions and conflicts so no root's edits are silently
  // dropped: the resolver can still apply the non-conflicting roots' edits.
  const mergeConflicts = plans.flatMap(plan => plan.conflicts)
  if (mergeConflicts.length > 0) {
    const pending = await writePendingDirectEditorMerge({
      cwd: input.realCwd,
      runId: input.runId,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      dirtyFilesAtStart: input.dirtyFilesAtStart,
      conflicts: mergeConflicts,
      files: plans.flatMap(plan => plan.pendingFiles),
    })
    return {
      backups: [],
      touchedPaths: [],
      dirtyFilesAtStart: input.dirtyFilesAtStart,
      mergeMode: 'conflict',
      pendingMerge: join(
        '.matos',
        'evolution',
        'direct-editor',
        'pending-merges',
        pending.runId,
        'record.json',
      ).replace(/\\/g, '/'),
      mergeConflicts,
    }
  }
  const appliedBackups: DirectEditorImportBackup[] = []
  try {
    for (const plan of plans) {
      backups.push(...plan.backups)
      const backupsByPath = new Map(
        plan.backups.map(backup => [backup.absolutePath, backup]),
      )
      const operations = [...plan.operations].sort((a, b) => {
        if (a.kind === 'remove' && b.kind !== 'remove') {
          return -1
        }
        if (a.kind !== 'remove' && b.kind === 'remove') {
          return 1
        }
        return a.absolutePath.localeCompare(b.absolutePath)
      })
      for (const operation of operations) {
        const backup = backupsByPath.get(operation.absolutePath)
        if (backup) {
          appliedBackups.push(backup)
        }
        if (operation.kind === 'remove') {
          await rm(operation.absolutePath, { recursive: true, force: true })
          await pruneEmptyDirectoriesToBase(input.realCwd, dirname(operation.absolutePath))
        } else {
          await writeImportedAssetEntry({
            cwd: input.realCwd,
            path: operation.absolutePath,
            entry: operation.entry,
          })
        }
        touchedPaths.add(
          guardKeyForPath(
            input.realCwd,
            operation.absolutePath,
            input.scope,
            input.scopeRef,
          ),
        )
      }
    }
  } catch (error) {
    // The import stopped midway: rethrow with the backups for every started
    // operation attached so the caller can restore the real roots. A bare
    // rethrow would strand new files created by already-applied operations.
    throw new DirectEditorImportError({
      message: error instanceof Error ? error.message : String(error),
      appliedBackups,
      cause: error,
    })
  }
  return {
    backups,
    touchedPaths: [...touchedPaths].sort((a, b) => a.localeCompare(b)),
    ...(mergeMode ? { mergeMode } : {}),
    dirtyFilesAtStart: input.dirtyFilesAtStart,
  }
}

export async function directEditorIsolationDiffersFromSnapshot(input: {
  realCwd: string
  isolatedCwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  snapshotId: string
}): Promise<boolean> {
  const realHiddenDirs = await listHiddenAssetDirs(
    input.realCwd,
    input.scope,
    input.scopeRef,
  )
  const isolatedHiddenDirs = realHiddenDirs.map(dir =>
    resolve(
      join(
        input.isolatedCwd,
        guardKeyForPath(
          input.realCwd,
          dir,
          input.scope,
          input.scopeRef,
        ),
      ),
    ),
  )
  for (const realRoot of matOSAssetHistoryAllowedRoots(
    input.realCwd,
    input.scope,
    input.scopeRef,
  )) {
    const logicalRoot = guardKeyForPath(
      input.realCwd,
      realRoot,
      input.scope,
      input.scopeRef,
    )
    const isolatedRoot = join(input.isolatedCwd, logicalRoot)
    const hiddenRelativePrefixes = hiddenRelativePrefixesForRoot({
      realRoot,
      hiddenDirs: realHiddenDirs,
    })
    const snapshotEntries = filterSkippedRelativeEntries(
      await snapshotEntriesForRoot({
        cwd: input.realCwd,
        snapshotId: input.snapshotId,
        logicalRoot,
      }),
      hiddenRelativePrefixes,
    )
    const isolatedEntries = filterSkippedRelativeEntries(
      await listImportableAssetEntries({
        root: isolatedRoot,
        skipDirs: isolatedHiddenDirs,
      }),
      hiddenRelativePrefixes,
    )
    const keys = new Set([
      ...snapshotEntries.keys(),
      ...[...isolatedEntries.entries()]
        .filter(([, entry]) => entry.kind !== 'dir')
        .map(([path]) => path),
    ])
    for (const key of keys) {
      if (!optionalEntriesEqual(snapshotEntries.get(key), isolatedEntries.get(key))) {
        return true
      }
    }
  }
  return false
}
