import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { gitBuffer } from './gitBackend.js'
import { bestEffort } from '../../support/bestEffort.js'
import { readMatOSAssetHistorySnapshot } from './records.js'
import {
  assertNoSymlinkPathComponent,
  isWithinMatOSAssetHistoryPath,
  listCurrentMatOSAssetHistoryFiles,
  matOSAssetHistoryAllowedRoots,
  resolveMatOSAssetHistoryRecordPath,
} from './policy.js'
import type { MatOSAssetHistorySnapshotRecord } from './types.js'

type RestorePathBackup =
  | { existed: false }
  | { existed: true; kind: 'file'; content: Buffer }
  | { existed: true; kind: 'symlink'; target: string }
  | { existed: true; kind: 'directory' }

export type RestoreMatOSAssetHistorySnapshotInput = {
  cwd: string
  snapshotId: string
  removeCreatedFiles?: boolean
  compareSnapshotId?: string
  removeFilesNotInSnapshotScope?: boolean
  /** Logical paths written by this transaction; other paths are never read. */
  onlyPaths?: string[]
}

// Cross-UID residue (for example audit files created by host-side root
// provisioning inside a user's scoped source checkout) cannot be unlinked from
// inside the container. Restoring snapshot content is the critical rollback
// guarantee; an undeletable created file must not turn the whole rollback into
// rollback_failed and leave every edit live.
export function isMatOSAssetHistoryResidueRemovalError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM'
}

export async function restoreMatOSAssetHistorySnapshot(
  input: RestoreMatOSAssetHistorySnapshotInput,
): Promise<{
  restoredFiles: string[]
  removedFiles: string[]
  skippedRemovals: string[]
}> {
  const cwd = resolve(input.cwd)
  let snapshot = await readMatOSAssetHistorySnapshot(cwd, input.snapshotId)
  if (!snapshot) {
    throw new Error(`MatOS asset history snapshot not found: ${input.snapshotId}`)
  }
  let compareSnapshot = input.compareSnapshotId
    ? await readMatOSAssetHistorySnapshot(cwd, input.compareSnapshotId)
    : undefined
  if (input.compareSnapshotId && !compareSnapshot) {
    throw new Error(`MatOS asset history snapshot not found: ${input.compareSnapshotId}`)
  }
  if (compareSnapshot && compareSnapshot.scope !== snapshot.scope) {
    throw new Error(
      `MatOS asset history restore compare scope mismatch: ${snapshot.scope} vs ${compareSnapshot.scope}`,
    )
  }
  if (
    compareSnapshot &&
    !snapshotsShareRestoreOwner(cwd, snapshot, compareSnapshot)
  ) {
    throw new Error(
      `MatOS asset history restore compare scopeRef mismatch: ${snapshot.scopeRef ?? '(legacy)'} vs ${compareSnapshot.scopeRef ?? '(legacy)'}`,
    )
  }
  const selected = input.onlyPaths?.map(path => resolveMatOSAssetHistoryRecordPath({
    cwd,
    scope: snapshot.scope,
    scopeRef: snapshot.scopeRef,
    path,
  }).relativePath)
  const selectedPath = (path: string) => !selected || selected.some(root => path === root || path.startsWith(`${root}/`))
  if (selected) {
    snapshot = { ...snapshot, files: snapshot.files.filter(file => selectedPath(file.path)) }
    if (compareSnapshot) compareSnapshot = { ...compareSnapshot, files: compareSnapshot.files.filter(file => selectedPath(file.path)) }
  }
  const snapshotFiles = resolveSnapshotFilePaths(cwd, snapshot)
  const compareFiles = compareSnapshot
    ? resolveSnapshotFilePaths(cwd, compareSnapshot)
    : new Map<string, string>()
  const restoredFiles: string[] = []
  const plannedRemovals: string[] = []
  const removedFiles: string[] = []
  const skippedRemovals: string[] = []
  const snapshotPaths = new Set(snapshotFiles.keys())
  const symlinkGuardRoots = matOSAssetHistoryAllowedRoots(
    cwd,
    snapshot.scope,
    snapshot.scopeRef,
  )
  if (input.removeFilesNotInSnapshotScope && !snapshot.fullScope) {
    throw new Error(
      `Refusing full-scope cleanup from partial MatOS asset history snapshot: ${snapshot.snapshotId}`,
    )
  }
  const restorePaths = await pathsNeedingRestore({
    cwd,
    snapshot,
    snapshotFiles,
    compareSnapshot,
  })
  const restoreFiles = new Map(
    [...snapshotFiles].filter(([path]) => restorePaths.has(path)),
  )
  const snapshotContents = await readAndVerifySnapshotContents(
    cwd,
    snapshot,
    restorePaths,
  )
  if (input.removeCreatedFiles) {
    const removablePaths =
      compareFiles.size > 0
        ? [...compareFiles.keys()]
        : input.removeFilesNotInSnapshotScope
          ? await listCurrentMatOSAssetHistoryFiles({
              cwd,
              scope: snapshot.scope,
              ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
            })
          : []
    for (const path of removablePaths) {
      if (selectedPath(path) && !snapshotPaths.has(path)) {
        const resolved = resolveMatOSAssetHistoryRecordPath({
          cwd,
          scope: snapshot.scope,
          ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
          path,
        })
        await assertNoSymlinkPathComponent({
          cwd,
          absolutePath: resolved.absolutePath,
          includeTarget: false,
          baseRoots: symlinkGuardRoots,
        })
        plannedRemovals.push(path)
      }
    }
  }
  for (const [path, targetPath] of snapshotFiles) {
    await assertNoSymlinkPathComponent({
      cwd,
      absolutePath: targetPath,
      includeTarget: false,
      baseRoots: symlinkGuardRoots,
    })
    const targetInfo = await lstat(targetPath).catch(() => undefined)
    if (targetInfo?.isSymbolicLink()) {
      throw new Error(`Refusing to restore over symlink asset path: ${path}`)
    }
  }
  const backupPaths = new Map<string, string>()
  for (const path of plannedRemovals) {
    const resolved = resolveMatOSAssetHistoryRecordPath({
      cwd,
      scope: snapshot.scope,
      ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
      path,
    })
    backupPaths.set(resolved.absolutePath, path)
  }
  for (const [path, targetPath] of restoreFiles) {
    backupPaths.set(targetPath, path)
  }
  const backups = new Map<string, RestorePathBackup>()
  for (const absolutePath of backupPaths.keys()) {
    backups.set(absolutePath, await captureRestorePathBackup(absolutePath))
  }

  try {
    for (const path of plannedRemovals) {
      const resolved = resolveMatOSAssetHistoryRecordPath({
        cwd,
        scope: snapshot.scope,
        ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
        path,
      })
      try {
        await rm(resolved.absolutePath, { force: true, recursive: true })
      } catch (error) {
        if (isMatOSAssetHistoryResidueRemovalError(error)) {
          skippedRemovals.push(path)
          continue
        }
        throw error
      }
      removedFiles.push(path)
      await pruneEmptyAssetDirectories(
        cwd,
        snapshot.scope,
        snapshot.scopeRef,
        resolved.absolutePath,
      )
    }
    for (const [path, targetPath] of restoreFiles) {
      await mkdir(dirname(targetPath), { recursive: true })
      await assertNoSymlinkPathComponent({
        cwd,
        absolutePath: targetPath,
        includeTarget: false,
        baseRoots: symlinkGuardRoots,
      })
      await rm(targetPath, { force: true, recursive: true })
      await writeFile(targetPath, snapshotContents.get(path) ?? Buffer.alloc(0))
      restoredFiles.push(path)
    }
  } catch (error) {
    for (const [absolutePath, backup] of [...backups].reverse()) {
      // A failed backup restore silently leaves the asset tree half-reverted;
      // keep the original restore error but record the swallowed rollback.
      await bestEffort('asset-history-restore-backup', () =>
        restorePathBackup(absolutePath, backup),
      )
    }
    throw error
  }
  return { restoredFiles, removedFiles, skippedRemovals }
}

export function snapshotsShareRestoreOwner(
  cwd: string,
  snapshot: MatOSAssetHistorySnapshotRecord,
  compareSnapshot: MatOSAssetHistorySnapshotRecord,
): boolean {
  if (snapshot.scopeRef === compareSnapshot.scopeRef) {
    return true
  }
  if (snapshot.scopeRef && compareSnapshot.scopeRef) {
    return false
  }

  // A pre-owner-qualification snapshot can be compared with a scoped one only
  // when every legacy path still resolves inside that exact owner's allowlist.
  // This preserves single-owner upgrade recovery without allowing one user's
  // later snapshot to drive deletion in another user's asset tree.
  const scopedRef = snapshot.scopeRef ?? compareSnapshot.scopeRef
  const legacySnapshot = snapshot.scopeRef ? compareSnapshot : snapshot
  if (!scopedRef) {
    return true
  }
  return legacySnapshot.files.every(file => {
    try {
      resolveMatOSAssetHistoryRecordPath({
        cwd,
        scope: legacySnapshot.scope,
        scopeRef: scopedRef,
        path: file.path,
      })
      return true
    } catch {
      return false
    }
  })
}

async function captureRestorePathBackup(path: string): Promise<RestorePathBackup> {
  const info = await lstat(path).catch(() => undefined)
  if (!info) {
    return { existed: false }
  }
  if (info.isSymbolicLink()) {
    return { existed: true, kind: 'symlink', target: await readlink(path) }
  }
  if (info.isDirectory()) {
    return { existed: true, kind: 'directory' }
  }
  return { existed: true, kind: 'file', content: await readFile(path) }
}

async function restorePathBackup(path: string, backup: RestorePathBackup): Promise<void> {
  if (!backup.existed) {
    await rm(path, { force: true, recursive: true })
    return
  }
  if (backup.kind === 'directory') {
    await mkdir(path, { recursive: true })
    return
  }
  await rm(path, { force: true, recursive: true })
  await mkdir(dirname(path), { recursive: true })
  if (backup.kind === 'file') {
    await writeFile(path, backup.content)
    return
  }
  await symlink(backup.target, path)
}

async function readAndVerifySnapshotContents(
  cwd: string,
  snapshot: MatOSAssetHistorySnapshotRecord,
  paths?: Set<string>,
): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>()
  for (const file of snapshot.files) {
    if (paths && !paths.has(file.path)) {
      continue
    }
    const resolved = resolveMatOSAssetHistoryRecordPath({
      cwd,
      scope: snapshot.scope,
      ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
      path: file.path,
    })
    const content = await gitBuffer(cwd, ['show', `${snapshot.commit}:${resolved.relativePath}`])
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (sha256 !== file.sha256) {
      throw new Error(`MatOS asset history snapshot hash mismatch for ${resolved.relativePath}`)
    }
    if (content.byteLength !== file.sizeBytes) {
      throw new Error(`MatOS asset history snapshot size mismatch for ${resolved.relativePath}`)
    }
    contents.set(resolved.relativePath, content)
  }
  return contents
}

async function pathsNeedingRestore(input: {
  cwd: string
  snapshot: MatOSAssetHistorySnapshotRecord
  snapshotFiles: Map<string, string>
  compareSnapshot?: MatOSAssetHistorySnapshotRecord
}): Promise<Set<string>> {
  const compareFiles = new Map(
    (input.compareSnapshot?.files ?? []).map(file => [file.path, file]),
  )
  const paths = new Set<string>()
  for (const file of input.snapshot.files) {
    const compared = compareFiles.get(file.path)
    if (
      !compared ||
      compared.sha256 !== file.sha256 ||
      compared.sizeBytes !== file.sizeBytes
    ) {
      paths.add(file.path)
      continue
    }
    const targetPath = input.snapshotFiles.get(file.path)
    if (!targetPath) {
      paths.add(file.path)
      continue
    }
    const info = await lstat(targetPath).catch(() => undefined)
    if (!info?.isFile() || info.size !== file.sizeBytes) {
      paths.add(file.path)
      continue
    }
    const content = await readFile(targetPath)
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) {
      paths.add(file.path)
    }
  }
  return paths
}

async function pruneEmptyAssetDirectories(
  cwd: string,
  scope: MatOSAssetHistorySnapshotRecord['scope'],
  scopeRef: string | undefined,
  deletedPath: string,
): Promise<void> {
  const roots = matOSAssetHistoryAllowedRoots(cwd, scope, scopeRef)
  let dir = dirname(deletedPath)
  while (
    roots.some(root => isWithinMatOSAssetHistoryPath(dir, root)) &&
    !roots.some(root => resolve(dir) === resolve(root))
  ) {
    const entries = await readdir(dir).catch(() => undefined)
    if (!entries || entries.length > 0) {
      return
    }
    await rmdir(dir).catch(() => undefined)
    dir = dirname(dir)
  }
}

function resolveSnapshotFilePaths(
  cwd: string,
  snapshot: MatOSAssetHistorySnapshotRecord,
): Map<string, string> {
  const files = new Map<string, string>()
  for (const file of snapshot.files) {
    const resolved = resolveMatOSAssetHistoryRecordPath({
      cwd,
      scope: snapshot.scope,
      ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
      path: file.path,
    })
    files.set(resolved.relativePath, resolved.absolutePath)
  }
  return files
}
