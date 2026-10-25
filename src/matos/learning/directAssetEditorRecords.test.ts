import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import type {
  MatOSDirectAssetEditorPendingMergeRecord,
  MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import {
  directEditorPendingMergeDir,
  directEditorRunDir,
  readMatOSDirectAssetEditorPendingMergeRecord,
  readMatOSDirectAssetEditorRunRecord,
  writeDirectEditorRunFile,
  writeMatOSDirectAssetEditorPendingMergeRecord,
  writeMatOSDirectAssetEditorRunRecord,
} from './directAssetEditorRecords.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function tempRoot(): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix: 'matos-direct-editor-records-' })
  roots.push(root)
  return root
}

function runRecord(runId: string): MatOSDirectAssetEditorRunRecord {
  return {
    runId,
    status: 'accepted',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    scope: 'user',
    editorOutput: {
      summary: 'Edited a scoped role.',
      modifiedFiles: ['user-assets/packs/user-alice/roles/compute/ROLE.md'],
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
    },
    modifiedFiles: ['user-assets/packs/user-alice/roles/compute/ROLE.md'],
    createdAssets: [],
    updatedAssets: [],
    disabledAssets: [],
    evidenceRefs: [],
    roleExitCode: 0,
  } as never
}

function pendingMergeRecord(
  runId: string,
  updatedAt: string,
): MatOSDirectAssetEditorPendingMergeRecord {
  return {
    schemaVersion: 1,
    runId,
    status: 'pending',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt,
    scope: 'user',
    scopeRef: 'user:alice',
    mergeMode: 'conflict',
    dirtyFilesAtStart: [],
    conflicts: [{ path: 'user-assets/a.md', reason: 'same hunk changed' }],
    files: [
      {
        path: 'user-assets/a.md',
        basePath: 'files/abc.base',
        baseKind: 'file',
        currentPath: 'files/abc.current',
        currentKind: 'file',
        editPath: 'files/abc.edit',
        editKind: 'file',
      },
    ],
    runRecordPath: `.matos/evolution/direct-editor/runs/${runId}/run.json`,
  }
}

async function inodeOf(path: string): Promise<number> {
  return Number((await lstat(path)).ino)
}

describe('direct-editor record writes are atomic', () => {
  test('run.json is replaced via same-directory tmp+rename, never truncated in place', async () => {
    const root = await tempRoot()
    const runId = 'records-atomic-run'
    const record = runRecord(runId)
    await writeMatOSDirectAssetEditorRunRecord(root, record)
    const runJsonPath = join(directEditorRunDir(root, runId), 'run.json')
    const firstInode = await inodeOf(runJsonPath)

    await writeMatOSDirectAssetEditorRunRecord(root, {
      ...record,
      status: 'rolled_back',
      updatedAt: '2026-07-26T00:00:02.000Z',
    })

    // An in-place writeFile reuses the same inode and exposes a truncated
    // window to crashed/concurrent readers; tmp+rename swaps in a fully
    // written file, which shows up as a new inode.
    expect(await inodeOf(runJsonPath)).not.toBe(firstInode)
    const restored = await readMatOSDirectAssetEditorRunRecord(root, runId)
    expect(restored?.status).toBe('rolled_back')
    expect(restored?.updatedAt).toBe('2026-07-26T00:00:02.000Z')
    const residue = (await readdir(directEditorRunDir(root, runId))).filter(
      name => name.includes('.tmp'),
    )
    expect(residue).toEqual([])
  })

  test('every JSON file written through writeDirectEditorRunFile is atomic', async () => {
    const root = await tempRoot()
    const dir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', 'shared-writer')
    for (const name of ['input.json', 'editor-output.json']) {
      await writeDirectEditorRunFile(dir, name, { version: 1 })
      const firstInode = await inodeOf(join(dir, name))
      await writeDirectEditorRunFile(dir, name, { version: 2 })
      expect(await inodeOf(join(dir, name))).not.toBe(firstInode)
      expect(JSON.parse(await readFile(join(dir, name), 'utf8'))).toEqual({
        version: 2,
      })
    }
    const residue = (await readdir(dir)).filter(name => name.includes('.tmp'))
    expect(residue).toEqual([])
  })

  test('pending merge record.json is replaced atomically and round-trips', async () => {
    const root = await tempRoot()
    const runId = 'records-atomic-pending-merge'
    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: root,
      record: pendingMergeRecord(runId, '2026-07-26T00:00:01.000Z'),
    })
    const recordPath = join(
      directEditorPendingMergeDir(root, runId),
      'record.json',
    )
    const firstInode = await inodeOf(recordPath)

    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: root,
      record: pendingMergeRecord(runId, '2026-07-26T00:00:02.000Z'),
    })

    expect(await inodeOf(recordPath)).not.toBe(firstInode)
    const restored = await readMatOSDirectAssetEditorPendingMergeRecord(
      root,
      runId,
    )
    expect(restored?.updatedAt).toBe('2026-07-26T00:00:02.000Z')
    expect(restored?.conflicts).toEqual([
      { path: 'user-assets/a.md', reason: 'same hunk changed' },
    ])
  })

  test('a corrupted run.json is silently skipped by the reader (why atomic writes matter)', async () => {
    const root = await tempRoot()
    const runId = 'records-corrupt-run'
    await writeMatOSDirectAssetEditorRunRecord(root, runRecord(runId))
    const runJsonPath = join(directEditorRunDir(root, runId), 'run.json')
    await mkdir(directEditorRunDir(root, runId), { recursive: true })
    await writeFile(runJsonPath, '{"runId": "records-corrupt-run", "sta', 'utf8')

    expect(await readMatOSDirectAssetEditorRunRecord(root, runId)).toBeUndefined()
  })
})
