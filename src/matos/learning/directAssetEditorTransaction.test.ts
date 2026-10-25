import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  createMatOSAssetHistorySnapshot,
  matOSAssetHistoryStableRef,
  restoreMatOSAssetHistorySnapshot,
  validateMatOSAssetHistorySnapshot,
} from '../assets/history/index.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  stableCommitForDirectEditorScope,
  stableSnapshotForDirectEditorScope,
  updateDirectEditorStableRef,
} from './directAssetEditorTransaction.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('direct-editor owner-qualified stable refs', () => {
  test('targeted restore never reads or rewrites another writer\'s paths', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'matos-targeted-restore-' })
    roots.push(root)
    const assets = join(root, '.matos/assets')
    await mkdir(assets, { recursive: true })
    await writeFile(join(assets, 'own.md'), 'before\n')
    await writeFile(join(assets, 'foreign.md'), 'foreign before\n')
    const before = await createMatOSAssetHistorySnapshot({ cwd: root, scope: 'project', kind: 'manual' })
    await writeFile(join(assets, 'own.md'), 'rejected\n')
    await writeFile(join(root, 'private.txt'), 'foreign current\n')
    await rm(join(assets, 'foreign.md'))
    await symlink(join(root, 'private.txt'), join(assets, 'foreign.md'))
    await restoreMatOSAssetHistorySnapshot({ cwd: root, snapshotId: before.snapshotId, onlyPaths: ['.matos/assets/own.md'] })
    expect(await readFile(join(assets, 'own.md'), 'utf8')).toBe('before\n')
    expect(await readlink(join(assets, 'foreign.md'))).toBe(join(root, 'private.txt'))
    expect(await readFile(join(root, 'private.txt'), 'utf8')).toBe('foreign current\n')
    await expect(restoreMatOSAssetHistorySnapshot({ cwd: root, snapshotId: before.snapshotId, onlyPaths: ['../outside'] })).rejects.toThrow()
  })

  test('keeps two user owners on independent stable snapshots', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'matos-owner-stable-ref-' })
    roots.push(root)
    const aliceRoot = join(root, '.matos', 'assets-alice')
    const bobRoot = join(root, '.matos', 'assets-bob')
    await mkdir(aliceRoot, { recursive: true })
    await mkdir(bobRoot, { recursive: true })
    await writeFile(join(aliceRoot, 'alice.md'), 'alice v1\n', 'utf8')
    await writeFile(join(bobRoot, 'bob.md'), 'bob v1\n', 'utf8')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify({
        version: 1,
        includeDefaultAssetRoots: false,
        assetRoots: [],
        assetSources: [
          {
            type: 'local',
            id: 'alice-assets',
            path: 'assets-alice',
            scope: 'user',
            scopeRef: 'user:alice@example.com',
          },
          {
            type: 'local',
            id: 'bob-assets',
            path: 'assets-bob',
            scope: 'user',
            scopeRef: 'user:bob@example.com',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )

    const alice = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'user',
      scopeRef: 'user:alice@example.com',
    })
    await writeFile(join(bobRoot, 'bob.md'), 'bob v2\n', 'utf8')
    const bob = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'user',
      scopeRef: 'user:bob@example.com',
    })
    await updateDirectEditorStableRef({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice@example.com',
      commit: alice.commit,
    })
    await updateDirectEditorStableRef({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:bob@example.com',
      commit: bob.commit,
    })

    expect(matOSAssetHistoryStableRef('user', 'user:alice@example.com')).not.toBe(
      matOSAssetHistoryStableRef('user', 'user:bob@example.com'),
    )
    expect(
      await stableCommitForDirectEditorScope(
        root,
        'user',
        'user:alice@example.com',
      ),
    ).toBe(alice.commit)
    expect(
      await stableCommitForDirectEditorScope(
        root,
        'user',
        'user:bob@example.com',
      ),
    ).toBe(bob.commit)
    expect(
      await stableSnapshotForDirectEditorScope(
        root,
        'user',
        'user:alice@example.com',
      ),
    ).toBe(alice.snapshotId)
    expect(
      await stableSnapshotForDirectEditorScope(
        root,
        'user',
        'user:bob@example.com',
      ),
    ).toBe(bob.snapshotId)

    await expect(
      validateMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: alice.snapshotId,
        gateProfile: 'structural',
      }),
    ).resolves.toBeDefined()

    await expect(
      restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: alice.snapshotId,
        removeCreatedFiles: true,
        compareSnapshotId: bob.snapshotId,
      }),
    ).rejects.toThrow(/scopeRef mismatch/i)
  })

  test('allows a legacy single-owner snapshot to pair only with that owner', async () => {
    const root = await mkdtempInMatOSTmp({ prefix: 'matos-owner-legacy-restore-' })
    roots.push(root)
    const aliceRoot = join(root, '.matos', 'assets-alice')
    await mkdir(aliceRoot, { recursive: true })
    const assetPath = join(aliceRoot, 'alice.md')
    await writeFile(assetPath, 'alice v1\n', 'utf8')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify({
        version: 1,
        includeDefaultAssetRoots: false,
        assetRoots: [],
        assetSources: [
          {
            type: 'local',
            id: 'alice-assets',
            path: 'assets-alice',
            scope: 'user',
            scopeRef: 'user:alice@example.com',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )

    const legacy = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'user',
    })
    await writeFile(assetPath, 'alice v2\n', 'utf8')
    const scoped = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'user',
      scopeRef: 'user:alice@example.com',
      parentCommit: legacy.commit,
    })

    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: legacy.snapshotId,
      removeCreatedFiles: true,
      compareSnapshotId: scoped.snapshotId,
    })
    expect(await readFile(assetPath, 'utf8')).toBe('alice v1\n')
  })
})
