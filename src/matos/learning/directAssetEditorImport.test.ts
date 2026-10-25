import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createMatOSAssetHistorySnapshot } from '../assets/history/index.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  DirectEditorImportError,
  importDirectEditorAllowedRootsFromIsolation,
} from './directAssetEditorImport.js'
import {
  directEditorPendingMergeDir,
  readMatOSDirectAssetEditorPendingMergeRecord,
} from './directAssetEditorRecords.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

type TwoRootProject = {
  root: string
  isolated: string
  rootA: string
  rootB: string
  isolatedRootA: string
  isolatedRootB: string
}

// Two local user-scoped sources give the import two independent allowed
// roots (.matos/assets-a and .matos/assets-b) plus the generated evidence
// roots, which stay empty in these fixtures.
async function setupTwoRootProject(input: {
  aContent: string
  bContent: string
}): Promise<TwoRootProject> {
  const root = await mkdtempInMatOSTmp({ prefix: 'matos-direct-editor-import-' })
  roots.push(root)
  const isolated = await mkdtempInMatOSTmp({
    prefix: 'matos-direct-editor-import-iso-',
  })
  roots.push(isolated)
  const rootA = join(root, '.matos', 'assets-a')
  const rootB = join(root, '.matos', 'assets-b')
  await mkdir(rootA, { recursive: true })
  await mkdir(rootB, { recursive: true })
  await writeFile(join(rootA, 'a.md'), input.aContent, 'utf8')
  await writeFile(join(rootB, 'b.md'), input.bContent, 'utf8')
  await writeFile(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        includeDefaultAssetRoots: false,
        assetRoots: [],
        assetSources: [
          {
            type: 'local',
            id: 'alice-a',
            path: 'assets-a',
            scope: 'user',
            scopeRef: 'user:alice',
          },
          {
            type: 'local',
            id: 'alice-b',
            path: 'assets-b',
            scope: 'user',
            scopeRef: 'user:alice',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const isolatedRootA = join(isolated, '.matos', 'assets-a')
  const isolatedRootB = join(isolated, '.matos', 'assets-b')
  await mkdir(isolatedRootA, { recursive: true })
  await mkdir(isolatedRootB, { recursive: true })
  await writeFile(join(isolatedRootA, 'a.md'), input.aContent, 'utf8')
  await writeFile(join(isolatedRootB, 'b.md'), input.bContent, 'utf8')
  return { root, isolated, rootA, rootB, isolatedRootA, isolatedRootB }
}

async function takeBaseAndBeforeSnapshots(
  root: string,
): Promise<{ base: string; before: string }> {
  const base = await createMatOSAssetHistorySnapshot({
    cwd: root,
    kind: 'manual',
    scope: 'user',
    scopeRef: 'user:alice',
  })
  const before = await createMatOSAssetHistorySnapshot({
    cwd: root,
    kind: 'manual',
    scope: 'user',
    scopeRef: 'user:alice',
  })
  return { base: base.snapshotId, before: before.snapshotId }
}

function importInput(
  project: TwoRootProject,
  runId: string,
  snapshots: { base: string; before: string },
) {
  return {
    realCwd: project.root,
    isolatedCwd: project.isolated,
    scope: 'user' as const,
    scopeRef: 'user:alice',
    runId,
    beforeSnapshotId: snapshots.before,
    baseSnapshotId: snapshots.base,
    dirtyFilesAtStart: [],
  }
}

describe('importDirectEditorAllowedRootsFromIsolation multi-root planning', () => {
  test('uses the editor input snapshot, not an older stable baseline, for dirty edits', async () => {
    const project = await setupTwoRootProject({ aContent: 'old rule\n', bContent: 'b\n' })
    const base = await createMatOSAssetHistorySnapshot({ cwd: project.root, kind: 'manual', scope: 'user', scopeRef: 'user:alice' })
    await writeFile(join(project.rootA, 'a.md'), 'current rule\n')
    const before = await createMatOSAssetHistorySnapshot({ cwd: project.root, kind: 'manual', scope: 'user', scopeRef: 'user:alice' })
    await writeFile(join(project.isolatedRootA, 'a.md'), 'current rule with a check\n')
    const result = await importDirectEditorAllowedRootsFromIsolation({
      ...importInput(project, 'dirty-input-baseline', { base: base.snapshotId, before: before.snapshotId }),
      dirtyFilesAtStart: ['.matos/assets-a/a.md'],
    })
    expect(result.pendingMerge).toBeUndefined()
    expect(result.mergeMode).toBe('dirty-auto')
    expect(await readFile(join(project.rootA, 'a.md'), 'utf8')).toBe('current rule with a check\n')
  })

  test('merges independent JSON fields without treating neighboring lines as conflicts', async () => {
    const project = await setupTwoRootProject({ aContent: 'a\n', bContent: 'b\n' })
    const original = { version: '1.0.0', description: 'original', metadata: { checked: false } }
    await writeFile(join(project.rootA, 'config.json'), JSON.stringify(original))
    const snapshots = await takeBaseAndBeforeSnapshots(project.root)
    await writeFile(join(project.rootA, 'config.json'), JSON.stringify({ ...original, version: '1.0.1' }))
    await writeFile(join(project.isolatedRootA, 'config.json'), JSON.stringify({ ...original, metadata: { checked: true } }))
    const result = await importDirectEditorAllowedRootsFromIsolation(importInput(project, 'json-independent-fields', snapshots))
    expect(result.pendingMerge).toBeUndefined()
    expect(JSON.parse(await readFile(join(project.rootA, 'config.json'), 'utf8'))).toEqual({ ...original, version: '1.0.1', metadata: { checked: true } })
  })

  test('keeps divergent JSON values pending and preserves both versions', async () => {
    const project = await setupTwoRootProject({ aContent: 'a\n', bContent: 'b\n' })
    await writeFile(join(project.rootA, 'config.json'), '{"required":true}')
    const snapshots = await takeBaseAndBeforeSnapshots(project.root)
    await writeFile(join(project.rootA, 'config.json'), '{"required":"manual"}')
    await writeFile(join(project.isolatedRootA, 'config.json'), '{"required":false}')
    const result = await importDirectEditorAllowedRootsFromIsolation(importInput(project, 'json-divergent-field', snapshots))
    expect(result.mergeMode).toBe('conflict')
    expect(await readFile(join(project.rootA, 'config.json'), 'utf8')).toBe('{"required":"manual"}')
  })

  test('a conflict in a later root aggregates every root into one pending merge', async () => {
    const project = await setupTwoRootProject({
      aContent: 'base a\n',
      bContent: 'line1\n',
    })
    const snapshots = await takeBaseAndBeforeSnapshots(project.root)
    // Concurrent change in real root B after the editor snapshotted, hitting
    // the same hunk as the isolated edit.
    await writeFile(join(project.rootB, 'b.md'), 'current b\n', 'utf8')
    await writeFile(join(project.isolatedRootA, 'a.md'), 'edited a\n', 'utf8')
    await writeFile(join(project.isolatedRootB, 'b.md'), 'edited b\n', 'utf8')
    const runId = 'import-aggregate-later-root'

    const result = await importDirectEditorAllowedRootsFromIsolation(
      importInput(project, runId, snapshots),
    )

    expect(result.mergeMode).toBe('conflict')
    expect(result.pendingMerge).toBe(
      `.matos/evolution/direct-editor/pending-merges/${runId}/record.json`,
    )
    expect(result.backups).toEqual([])
    expect(result.touchedPaths).toEqual([])
    expect(result.mergeConflicts?.map(conflict => conflict.path)).toEqual([
      '.matos/assets-b/b.md',
    ])
    // Nothing may be applied while the merge is pending.
    expect(await readFile(join(project.rootA, 'a.md'), 'utf8')).toBe('base a\n')
    expect(await readFile(join(project.rootB, 'b.md'), 'utf8')).toBe(
      'current b\n',
    )
    // The pending merge record must carry the clean root A edit too; the old
    // per-root early return dropped it silently.
    const record = await readMatOSDirectAssetEditorPendingMergeRecord(
      project.root,
      runId,
    )
    expect(record?.conflicts.map(conflict => conflict.path)).toEqual([
      '.matos/assets-b/b.md',
    ])
    expect(record?.files.map(file => file.path).sort()).toEqual([
      '.matos/assets-a/a.md',
      '.matos/assets-b/b.md',
    ])
    const aFile = record?.files.find(file => file.path === '.matos/assets-a/a.md')
    expect(aFile?.editKind).toBe('file')
    expect(
      await readFile(
        join(directEditorPendingMergeDir(project.root, runId), aFile?.editPath ?? ''),
        'utf8',
      ),
    ).toBe('edited a\n')
  })

  test('a conflict in an earlier root still scans and records later roots', async () => {
    const project = await setupTwoRootProject({
      aContent: 'line1\n',
      bContent: 'base b\n',
    })
    const snapshots = await takeBaseAndBeforeSnapshots(project.root)
    await writeFile(join(project.rootA, 'a.md'), 'current a\n', 'utf8')
    await writeFile(join(project.isolatedRootA, 'a.md'), 'edited a\n', 'utf8')
    await writeFile(join(project.isolatedRootB, 'b.md'), 'edited b\n', 'utf8')
    const runId = 'import-aggregate-earlier-root'

    const result = await importDirectEditorAllowedRootsFromIsolation(
      importInput(project, runId, snapshots),
    )

    expect(result.mergeMode).toBe('conflict')
    expect(result.mergeConflicts?.map(conflict => conflict.path)).toEqual([
      '.matos/assets-a/a.md',
    ])
    expect(await readFile(join(project.rootB, 'b.md'), 'utf8')).toBe('base b\n')
    // The old code returned before planning root B: its edit vanished from
    // both the record and the disk.
    const record = await readMatOSDirectAssetEditorPendingMergeRecord(
      project.root,
      runId,
    )
    expect(record?.conflicts.map(conflict => conflict.path)).toEqual([
      '.matos/assets-a/a.md',
    ])
    expect(record?.files.map(file => file.path).sort()).toEqual([
      '.matos/assets-a/a.md',
      '.matos/assets-b/b.md',
    ])
    const bFile = record?.files.find(file => file.path === '.matos/assets-b/b.md')
    expect(bFile?.editKind).toBe('file')
    expect(
      await readFile(
        join(directEditorPendingMergeDir(project.root, runId), bFile?.editPath ?? ''),
        'utf8',
      ),
    ).toBe('edited b\n')
  })

  test('applies edits across all roots when no root conflicts', async () => {
    const project = await setupTwoRootProject({
      aContent: 'base a\n',
      bContent: 'base b\n',
    })
    const snapshots = await takeBaseAndBeforeSnapshots(project.root)
    await writeFile(join(project.isolatedRootA, 'a.md'), 'edited a\n', 'utf8')
    await writeFile(join(project.isolatedRootB, 'b.md'), 'edited b\n', 'utf8')

    const result = await importDirectEditorAllowedRootsFromIsolation(
      importInput(project, 'import-clean-multi-root', snapshots),
    )

    expect(result.pendingMerge).toBeUndefined()
    expect(result.mergeConflicts).toBeUndefined()
    expect(result.mergeMode).toBeUndefined()
    expect(result.touchedPaths).toEqual([
      '.matos/assets-a/a.md',
      '.matos/assets-b/b.md',
    ])
    expect(
      result.backups.map(backup => backup.absolutePath).sort(),
    ).toEqual([join(project.rootA, 'a.md'), join(project.rootB, 'b.md')])
    expect(await readFile(join(project.rootA, 'a.md'), 'utf8')).toBe('edited a\n')
    expect(await readFile(join(project.rootB, 'b.md'), 'utf8')).toBe('edited b\n')
  })
})

describe('importDirectEditorAllowedRootsFromIsolation apply failures', () => {
  test('a mid-apply failure throws DirectEditorImportError carrying the applied backups', async () => {
    const project = await setupTwoRootProject({
      aContent: 'base a\n',
      bContent: 'base b\n',
    })
    const snapshots = await takeBaseAndBeforeSnapshots(project.root)
    await writeFile(join(project.isolatedRootA, 'a.md'), 'edited a\n', 'utf8')
    // Root B gains a new file whose real parent directory is a symlink: the
    // planner accepts it, but writeImportedAssetEntry refuses to write
    // through the symlink while applying, failing the import midway.
    await mkdir(join(project.isolated, '.matos', 'assets-b', 'sub'), {
      recursive: true,
    })
    await writeFile(
      join(project.isolatedRootB, 'sub', 'inner.md'),
      'new inner\n',
      'utf8',
    )
    await mkdir(join(project.root, 'link-target'), { recursive: true })
    await symlink(join(project.root, 'link-target'), join(project.rootB, 'sub'))

    let thrown: unknown
    try {
      await importDirectEditorAllowedRootsFromIsolation(
        importInput(project, 'import-error-backups', snapshots),
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(DirectEditorImportError)
    const importError = thrown as DirectEditorImportError
    expect(importError.message).toContain('symlink')
    // Every started operation is represented: root A's applied write and the
    // failing root B write, in apply order.
    expect(importError.appliedBackups.map(backup => backup.absolutePath)).toEqual([
      join(project.rootA, 'a.md'),
      join(project.rootB, 'sub', 'inner.md'),
    ])
    const [aBackup, innerBackup] = importError.appliedBackups
    expect(aBackup?.existed).toBe(true)
    if (aBackup?.existed && aBackup.entry.kind === 'file') {
      expect(aBackup.entry.content.toString('utf8')).toBe('base a\n')
    } else {
      throw new Error('expected a file backup for the applied root A write')
    }
    expect(innerBackup?.existed).toBe(false)
    // The backups match the disk state the failure left behind.
    expect(await readFile(join(project.rootA, 'a.md'), 'utf8')).toBe('edited a\n')
  })
})
