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
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  assetHistoryLockPath,
  createMatOSAssetHistorySnapshot,
  diffMatOSAssetHistorySnapshots,
  listMatOSAssetHistorySnapshots,
  listMatOSAssetHistorySnapshotsWithIssues,
  readMatOSAssetHistorySnapshot,
  restoreMatOSAssetHistorySnapshot,
  validateMatOSAssetHistorySnapshot,
  withMatOSAssetHistoryLock,
} from './index.js'
import {
  listCurrentMatOSAssetHistoryFiles,
  matOSAssetHistoryAllowedRoots,
} from './policy.js'
import { restoreStolenLockIfTargetMissingForTests } from './lock.js'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createHistoryFixture(): Promise<{
  root: string
  rolePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-'))
  return createHistoryFixtureIn(root)
}

async function createHistoryFixtureIn(root: string): Promise<{
  root: string
  rolePath: string
}> {
  const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
  await mkdir(roleDir, { recursive: true })
  await writeJson(join(roleDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'compute',
    type: 'role',
    name: 'Compute',
    version: '0.1.0',
    entry: 'ROLE.md',
  })
  const rolePath = join(roleDir, 'ROLE.md')
  await writeFile(rolePath, '# Compute\n\nUse remote queues.\n', 'utf8')
  return { root, rolePath }
}

describe('MatOS asset history backend', () => {

  test('snapshots and restores through a workspace alias while rejecting escaping links', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'matos-history-alias-')))
    const alias = root + '-alias'
    try {
      const { rolePath } = await createHistoryFixtureIn(root)
      await symlink(root, alias, 'dir')
      const aliasPath = join(alias, 'matos-assets/packs/matos-core/roles/compute/ROLE.md')
      const snapshot = await createMatOSAssetHistorySnapshot({
        cwd: alias, kind: 'manual', scope: 'core', paths: [aliasPath],
      })
      await writeFile(rolePath, '# Changed by test\n')
      await restoreMatOSAssetHistorySnapshot({ cwd: alias, snapshotId: snapshot.snapshotId })
      expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
      const outside = join(root, 'outside.txt')
      await writeFile(outside, 'outside')
      const escape = join(dirname(aliasPath), 'escape.md')
      await symlink(outside, escape)
      await expect(createMatOSAssetHistorySnapshot({
        cwd: alias, kind: 'manual', scope: 'core', paths: [escape],
      })).rejects.toThrow(/outside MatOS asset history allowlist/)
    } finally {
      await rm(alias, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  test('creates Git-backed snapshots, diffs them, and lists records', async () => {
    const { root, rolePath } = await createHistoryFixture()

    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      ref: 'refs/matos/assets/core/latest',
      message: 'before test edit',
    })
    await writeFile(rolePath, '# Compute\n\nPrefer local GPUs.\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      ref: 'refs/matos/assets/core/latest',
      parentCommit: before.commit,
      message: 'after test edit',
    })

    expect(before.commit).toMatch(/^[0-9a-f]{40,64}$/)
    expect(after.parentCommit).toBe(before.commit)
    expect(after.files.map(file => file.path).sort()).toEqual([
      'matos-assets/packs/matos-core/roles/compute/ROLE.md',
      'matos-assets/packs/matos-core/roles/compute/asset.json',
    ])

    const patch = await diffMatOSAssetHistorySnapshots({
      cwd: root,
      from: before.snapshotId,
      to: after.snapshotId,
    })
    expect(patch.patch).toContain('-Use remote queues.')
    expect(patch.patch).toContain('+Prefer local GPUs.')

    const listed = await listMatOSAssetHistorySnapshots(root)
    expect(listed.map(record => record.snapshotId)).toEqual([
      after.snapshotId,
      before.snapshotId,
    ])
    expect(await readMatOSAssetHistorySnapshot(root, before.snapshotId)).toMatchObject({
      snapshotId: before.snapshotId,
      commit: before.commit,
    })
  })

  test('snapshots isolated candidate bytes under the governed target identity without mutating the target', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const targetRoot = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
    )
    const sourceRoot = join(root, 'optimizer-run', 'candidate-roles')
    const candidatePath = join(sourceRoot, 'compute', 'ROLE.md')
    await mkdir(dirname(candidatePath), { recursive: true })
    await writeFile(candidatePath, '# Compute\n\nUse isolated queues.\n', 'utf8')
    const targetBefore = await readFile(rolePath, 'utf8')

    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'core',
      paths: [rolePath],
    })
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-after',
      scope: 'core',
      paths: [rolePath],
      contentSource: { targetRoot, sourceRoot },
      parentCommit: before.commit,
    })

    expect(await readFile(rolePath, 'utf8')).toBe(targetBefore)
    expect(after.files).toHaveLength(1)
    expect(after.files[0]?.path).toBe(
      'matos-assets/packs/matos-core/roles/compute/ROLE.md',
    )
    const diff = await diffMatOSAssetHistorySnapshots({
      cwd: root,
      from: before.snapshotId,
      to: after.snapshotId,
    })
    expect(diff.patch).toContain('-Use remote queues.')
    expect(diff.patch).toContain('+Use isolated queues.')

    await rm(candidatePath)
    await symlink(rolePath, candidatePath)
    await expect(
      createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'direct-editor-after',
        scope: 'core',
        paths: [rolePath],
        contentSource: { targetRoot, sourceRoot },
      }),
    ).rejects.toThrow('Refusing non-regular alternate asset history content')
  })

  test('ignores generated Python bytecode in asset history snapshots and dirty checks', async () => {
    const { root } = await createHistoryFixture()
    const pycacheDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'tools',
      'example-tool',
      '__pycache__',
    )
    await mkdir(pycacheDir, { recursive: true })
    await writeFile(join(pycacheDir, 'tool.cpython-313.pyc'), 'bytecode-v1', 'utf8')

    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })

    expect(snapshot.files.map(file => file.path)).not.toContain(
      'matos-assets/packs/matos-core/tools/example-tool/__pycache__/tool.cpython-313.pyc',
    )

    await writeFile(join(pycacheDir, 'tool.cpython-313.pyc'), 'bytecode-v2', 'utf8')
    const { hasMatOSAssetHistoryWorkingTreeChanges } = await import('./snapshot.js')
    expect(
      await hasMatOSAssetHistoryWorkingTreeChanges({
        cwd: root,
        snapshotId: snapshot.snapshotId,
      }),
    ).toBe(false)
  })

  test('dirty checks for the same snapshot can run concurrently without temporary index collisions', async () => {
    const { root } = await createHistoryFixture()
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const { hasMatOSAssetHistoryWorkingTreeChanges } = await import('./snapshot.js')

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          hasMatOSAssetHistoryWorkingTreeChanges({
            cwd: root,
            snapshotId: snapshot.snapshotId,
          }),
        ),
      ),
    ).resolves.toEqual(Array(8).fill(false))
  })

  test('dirty check cache is invalidated by asset metadata changes', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const { hasMatOSAssetHistoryWorkingTreeChanges } = await import('./snapshot.js')

    expect(
      await hasMatOSAssetHistoryWorkingTreeChanges({
        cwd: root,
        snapshotId: snapshot.snapshotId,
      }),
    ).toBe(false)
    expect(
      await exists(
        join(
          root,
          '.matos',
          'asset-history-cache',
          'working-tree',
          `${snapshot.snapshotId}.json`,
        ),
      ),
    ).toBe(true)

    await writeFile(
      rolePath,
      '# Compute\n\nUse remote queues.\n\nNew developer guidance.\n',
      'utf8',
    )
    expect(
      await hasMatOSAssetHistoryWorkingTreeChanges({
        cwd: root,
        snapshotId: snapshot.snapshotId,
      }),
    ).toBe(true)
  })

  test('dirty check detects same-size asset content changes', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const { hasMatOSAssetHistoryWorkingTreeChanges } = await import('./snapshot.js')
    const original = await readFile(rolePath, 'utf8')
    const updated = original.replace('Use remote queues.', 'Use local queues. ')

    expect(updated.length).toBe(original.length)
    await writeFile(rolePath, updated, 'utf8')

    expect(
      await hasMatOSAssetHistoryWorkingTreeChanges({
        cwd: root,
        snapshotId: snapshot.snapshotId,
      }),
    ).toBe(true)
  })

  // Production container shape: cwd holds the history state while the core
  // pack root resolves through MATOS_EDITABLE_CORE_ASSET_ROOT outside the cwd.
  test('snapshots, detects changes, and restores a core root outside the cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-prod-cwd-'))
    const external = await mkdtemp(join(tmpdir(), 'matos-asset-history-prod-assets-'))
    const { rolePath } = await createHistoryFixtureIn(external)
    const externalCoreRoot = join(external, 'matos-assets', 'packs', 'matos-core')
    const previousEditableRoot = process.env.MATOS_EDITABLE_CORE_ASSET_ROOT
    process.env.MATOS_EDITABLE_CORE_ASSET_ROOT = externalCoreRoot
    try {
      const before = await createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'core',
        ref: 'refs/matos/assets/core/latest',
      })
      // Logical record paths stay on the stable cwd-independent namespace.
      expect(before.files.map(file => file.path).sort()).toEqual([
        'matos-assets/packs/matos-core/roles/compute/ROLE.md',
        'matos-assets/packs/matos-core/roles/compute/asset.json',
      ])
      // History state lives under the cwd, not the external root.
      expect(await exists(join(root, '.matos', 'asset-history.git'))).toBe(true)
      expect(await exists(join(external, '.matos'))).toBe(false)

      const { hasMatOSAssetHistoryWorkingTreeChanges } = await import('./snapshot.js')
      expect(
        await hasMatOSAssetHistoryWorkingTreeChanges({
          cwd: root,
          snapshotId: before.snapshotId,
        }),
      ).toBe(false)
      await writeFile(rolePath, '# Compute\n\nBroken external guidance.\n', 'utf8')
      expect(
        await hasMatOSAssetHistoryWorkingTreeChanges({
          cwd: root,
          snapshotId: before.snapshotId,
        }),
      ).toBe(true)

      const validation = await validateMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: before.snapshotId,
      })
      expect(validation.assetValidation.ok).toBe(true)
      expect(validation.secretScan.ok).toBe(true)

      await restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: before.snapshotId,
      })
      expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
    } finally {
      if (previousEditableRoot === undefined) {
        delete process.env.MATOS_EDITABLE_CORE_ASSET_ROOT
      } else {
        process.env.MATOS_EDITABLE_CORE_ASSET_ROOT = previousEditableRoot
      }
    }
  })

  test('validates core snapshots with repository dependency packs as read-only context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-context-'))
    const coreRoleDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'compute',
    )
    await mkdir(coreRoleDir, { recursive: true })
    await writeJson(join(coreRoleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '0.1.0',
      entry: 'ROLE.md',
      dependencies: ['tool:deep-research-search'],
    })
    await writeFile(
      join(coreRoleDir, 'ROLE.md'),
      '# Compute\n\nUse scholarly search.\n',
      'utf8',
    )
    const deepResearchToolDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-deep-research',
      'tools',
      'deep-research-search',
    )
    await mkdir(deepResearchToolDir, { recursive: true })
    await writeJson(join(deepResearchToolDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'deep-research-search',
      type: 'tool',
      name: 'Deep Research Scholarly Search',
      version: '0.1.0',
    })

    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const validation = await validateMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: snapshot.snapshotId,
    })

    expect(validation.assetValidation).toMatchObject({ ok: true, errors: [] })
  })

  test('validates core snapshots with production source-cache dependency packs as read-only context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-source-cache-'))
    const previousEditableRoot = process.env.MATOS_EDITABLE_CORE_ASSET_ROOT
    const previousBundledRoot = process.env.MATOS_BUNDLED_ASSET_ROOT
    const editableRoot = join(root, 'workspace', 'assets', 'editable-core')
    const editableCoreRoot = join(editableRoot, 'packs', 'matos-core')
    try {
      process.env.MATOS_EDITABLE_CORE_ASSET_ROOT = editableCoreRoot
      process.env.MATOS_BUNDLED_ASSET_ROOT = editableRoot
      await mkdir(join(root, '.matos'), { recursive: true })
      await writeJson(join(root, '.matos', 'matos.json'), {
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
        assetSources: [
          {
            type: 'git',
            id: 'matos-core-assets',
            repo: 'http://matos-gitea:3000/matos-core/assets.git',
            scope: 'core',
            refresh: 'manual',
          },
        ],
      })

      const coreRoleDir = join(editableCoreRoot, 'roles', 'compute')
      await mkdir(coreRoleDir, { recursive: true })
      await writeJson(join(coreRoleDir, 'asset.json'), {
        schemaVersion: 1,
        id: 'compute',
        type: 'role',
        name: 'Compute',
        version: '0.1.0',
        entry: 'ROLE.md',
        dependencies: ['tool:deep-research-search'],
      })
      await writeFile(
        join(coreRoleDir, 'ROLE.md'),
        '# Compute\n\nUse scholarly search.\n',
        'utf8',
      )

      const sourceCacheRoot = join(
        root,
        '.matos',
        'source-cache',
        'git',
        'matos-core-assets',
        'packs',
      )
      const sourceCacheCoreDir = join(sourceCacheRoot, 'matos-core', 'roles', 'old')
      await mkdir(sourceCacheCoreDir, { recursive: true })
      await writeJson(join(sourceCacheCoreDir, 'asset.json'), {
        schemaVersion: 1,
        id: 'old',
        type: 'role',
        name: 'Old source-cache core role',
        version: '0.1.0',
      })
      const deepResearchPackDir = join(sourceCacheRoot, 'matos-deep-research')
      const deepResearchToolDir = join(
        deepResearchPackDir,
        'tools',
        'deep-research-search',
      )
      await mkdir(deepResearchToolDir, { recursive: true })
      await writeJson(join(deepResearchPackDir, 'matos.pack.json'), {
        schemaVersion: 1,
        id: 'matos-deep-research',
        name: 'MatOS Deep Research Assets',
        version: '0.7.0',
      })
      await writeJson(join(deepResearchToolDir, 'asset.json'), {
        schemaVersion: 1,
        id: 'deep-research-search',
        type: 'tool',
        name: 'Deep Research Scholarly Search',
        version: '0.1.0',
      })
      const bundledDeepResearchPackDir = join(
        root,
        'matos-assets',
        'packs',
        'matos-deep-research',
      )
      const bundledDeepResearchToolDir = join(
        bundledDeepResearchPackDir,
        'tools',
        'deep-research-search',
      )
      await mkdir(bundledDeepResearchToolDir, { recursive: true })
      await writeJson(join(bundledDeepResearchPackDir, 'matos.pack.json'), {
        schemaVersion: 1,
        id: 'matos-deep-research',
        name: 'Bundled MatOS Deep Research Assets',
        version: '0.1.0',
      })
      await writeJson(join(bundledDeepResearchToolDir, 'asset.json'), {
        schemaVersion: 1,
        id: 'deep-research-search',
        type: 'tool',
        name: 'Bundled Deep Research Scholarly Search',
        version: '0.1.0',
      })

      const snapshot = await createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'core',
      })
      const validation = await validateMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: snapshot.snapshotId,
      })

      expect(validation.assetValidation).toMatchObject({ ok: true, errors: [] })
    } finally {
      if (previousEditableRoot === undefined) {
        delete process.env.MATOS_EDITABLE_CORE_ASSET_ROOT
      } else {
        process.env.MATOS_EDITABLE_CORE_ASSET_ROOT = previousEditableRoot
      }
      if (previousBundledRoot === undefined) {
        delete process.env.MATOS_BUNDLED_ASSET_ROOT
      } else {
        process.env.MATOS_BUNDLED_ASSET_ROOT = previousBundledRoot
      }
    }
  })

  test('restores deleted, modified, and newly created files from a snapshot', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    const unchangedAssetPath = join(roleDir, 'asset.json')
    const unchangedInode = (await stat(unchangedAssetPath)).ino
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })

    await writeFile(rolePath, '# Compute\n\nBroken guidance.\n', 'utf8')
    await writeFile(join(roleDir, 'NEW.md'), 'new generated file\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: before.commit,
    })
    const restore = await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: before.snapshotId,
      removeCreatedFiles: true,
      compareSnapshotId: after.snapshotId,
    })

    expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
    expect(await exists(join(roleDir, 'NEW.md'))).toBe(false)
    expect((await stat(unchangedAssetPath)).ino).toBe(unchangedInode)
    expect(restore.skippedRemovals).toEqual([])
  })

  test('restores snapshot files over existing directories at the same path', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })

    await rm(rolePath, { recursive: true, force: true })
    await mkdir(rolePath, { recursive: true })
    await writeFile(join(rolePath, 'stale.txt'), 'stale directory payload\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: before.commit,
    })

    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: before.snapshotId,
      removeCreatedFiles: true,
      compareSnapshotId: after.snapshotId,
    })

    expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
    expect(await exists(join(rolePath, 'stale.txt'))).toBe(false)
  })

  test('tolerates undeletable cross-UID residue when removing created files during restore', async () => {
    // Requires root so the test can drop to an unprivileged euid and get a
    // real EACCES from root-owned residue, the same shape as host-side
    // provisioning files inside a user's scoped source checkout.
    if (process.getuid?.() !== 0 || typeof process.seteuid !== 'function') {
      return
    }
    const { root, rolePath } = await createHistoryFixture()
    const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const residuePath = join(roleDir, 'residue-audit.json')
    await writeFile(residuePath, '{"createdBy":"host-root-provisioning"}\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: before.commit,
    })

    // Ancestors must stay traversable for the unprivileged euid; the fixture
    // tree itself remains root-owned so unlink fails with a real EACCES.
    const modeRestores: Array<{ path: string; mode: number }> = []
    let current = await realpath(root)
    while (true) {
      const info = await stat(current)
      const mode = info.mode & 0o7777
      if ((mode & 0o001) === 0) {
        modeRestores.push({ path: current, mode })
        await chmod(current, mode | 0o011)
      }
      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
    try {
      process.seteuid!(65534)
      const restore = await restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: before.snapshotId,
        removeCreatedFiles: true,
        compareSnapshotId: after.snapshotId,
      })
      expect(restore.skippedRemovals).toEqual([
        'matos-assets/packs/matos-core/roles/compute/residue-audit.json',
      ])
      expect(restore.restoredFiles).toEqual([])
      expect(restore.removedFiles).toEqual([])
    } finally {
      process.seteuid!(0)
      for (const entry of modeRestores) {
        await chmod(entry.path, entry.mode)
      }
    }
    expect(await exists(residuePath)).toBe(true)
    expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
  })

  test('does not treat an unreadable or non-directory current asset root as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-bad-root-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(root, '.matos', 'assets'), 'not a directory\n', 'utf8')

    await expect(
      listCurrentMatOSAssetHistoryFiles({ cwd: root, scope: 'project' }),
    ).rejects.toThrow(/not a directory|ENOTDIR/i)
  })

  test('skips missing explicit paths so rollback snapshots can record restored state', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    const generatedPath = join(roleDir, 'GENERATED.md')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      paths: [rolePath],
    })

    await writeFile(generatedPath, 'temporary generated guidance\n', 'utf8')
    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: before.snapshotId,
      removeCreatedFiles: true,
    })
    const rollback = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      paths: [rolePath, generatedPath],
      parentCommit: before.commit,
    })

    expect(await exists(generatedPath)).toBe(true)
    expect(rollback.files.map(file => file.path)).toEqual([
      'matos-assets/packs/matos-core/roles/compute/GENERATED.md',
      'matos-assets/packs/matos-core/roles/compute/ROLE.md',
    ])
  })

  test('does not delete existing sibling files that were not included in a partial snapshot', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const assetPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'compute',
      'asset.json',
    )
    const originalAsset = await readFile(assetPath, 'utf8')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      paths: [rolePath],
    })

    await writeFile(rolePath, '# Compute\n\nChanged guidance.\n', 'utf8')
    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: before.snapshotId,
      removeCreatedFiles: true,
    })

    expect(await readFile(assetPath, 'utf8')).toBe(originalAsset)
    expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
  })

  test('refuses full-scope cleanup for partial snapshots before deleting siblings', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const assetPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'compute',
      'asset.json',
    )
    const originalAsset = await readFile(assetPath, 'utf8')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      paths: [rolePath],
    })

    await writeFile(rolePath, '# Compute\n\nChanged guidance.\n', 'utf8')
    await expect(
      restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: before.snapshotId,
        removeCreatedFiles: true,
        removeFilesNotInSnapshotScope: true,
      }),
    ).rejects.toThrow(/full-scope/i)

    expect(await readFile(assetPath, 'utf8')).toBe(originalAsset)
    expect(await readFile(rolePath, 'utf8')).toContain('Changed guidance.')
  })

  test('removes files from new asset directories when restoring against a later snapshot', async () => {
    const { root } = await createHistoryFixture()
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const newSkillDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'skills',
      'new-skill',
    )
    await mkdir(newSkillDir, { recursive: true })
    await writeJson(join(newSkillDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'new-skill',
      type: 'skill',
      name: 'New Skill',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(newSkillDir, 'SKILL.md'), '# New Skill\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: before.commit,
    })

    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: before.snapshotId,
      removeCreatedFiles: true,
      compareSnapshotId: after.snapshotId,
    })

    expect(await exists(join(newSkillDir, 'asset.json'))).toBe(false)
    expect(await exists(join(newSkillDir, 'SKILL.md'))).toBe(false)
    expect(await exists(newSkillDir)).toBe(false)
  })

  test('rejects forged snapshot records before deleting any out-of-scope files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'matos-asset-history-forged-parent-'))
    const root = join(parent, 'workspace')
    await mkdir(root, { recursive: true })
    const { rolePath } = await createHistoryFixtureIn(root)
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      paths: [rolePath],
    })
    const outsideDir = join(parent, 'outside')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'keep.txt'), 'keep\n', 'utf8')
    await writeFile(join(outsideDir, 'victim.txt'), 'do not delete\n', 'utf8')
    await writeJson(join(root, '.matos', 'asset-history', 'records', 'forged.json'), {
      ...snapshot,
      snapshotId: 'different-id',
      files: [
        {
          path: '../outside/keep.txt',
          sha256: snapshot.files[0]?.sha256 ?? '0'.repeat(64),
          sizeBytes: 5,
        },
      ],
    })

    await expect(
      restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: 'forged',
        removeCreatedFiles: true,
      }),
    ).rejects.toThrow(/invalid|outside|mismatch/i)

    expect(await readFile(join(outsideDir, 'victim.txt'), 'utf8')).toBe(
      'do not delete\n',
    )
  })

  test('preflights snapshot content hashes before deleting created files', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await writeFile(rolePath, '# Compute\n\nChanged guidance.\n', 'utf8')
    await writeFile(join(roleDir, 'NEW.md'), 'new generated file\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: before.commit,
    })
    await writeJson(join(root, '.matos', 'asset-history', 'records', `${before.snapshotId}.json`), {
      ...before,
      files: before.files.map((file, index) =>
        index === 0 ? { ...file, sha256: '0'.repeat(64) } : file,
      ),
    })

    await expect(
      restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: before.snapshotId,
        removeCreatedFiles: true,
        compareSnapshotId: after.snapshotId,
      }),
    ).rejects.toThrow(/hash|sha/i)

    expect(await exists(join(roleDir, 'NEW.md'))).toBe(true)
    expect(await readFile(rolePath, 'utf8')).toContain('Changed guidance.')
  })

  test('restores over directory conflicts while removing created files', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const extraPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'extra',
      'ROLE.md',
    )
    await rm(rolePath, { force: true })
    await mkdir(dirname(extraPath), { recursive: true })
    await writeFile(extraPath, 'extra\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: before.commit,
    })
    await mkdir(rolePath, { recursive: true })

    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: before.snapshotId,
      removeCreatedFiles: true,
      compareSnapshotId: after.snapshotId,
    })

    expect(await readFile(rolePath, 'utf8')).toContain('Use remote queues.')
    expect(await exists(extraPath)).toBe(false)
  })

  test('does not follow symlink targets when restoring files', async () => {
    const { root, rolePath } = await createHistoryFixture()
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      paths: [rolePath],
    })
    const outsideTarget = join(root, 'outside-target.txt')
    await writeFile(outsideTarget, 'outside original\n', 'utf8')
    await writeFile(rolePath, '# Compute\n\nChanged.\n', 'utf8')
    await rm(rolePath)
    await symlink(outsideTarget, rolePath)

    await expect(
      restoreMatOSAssetHistorySnapshot({
        cwd: root,
        snapshotId: before.snapshotId,
      }),
    ).rejects.toThrow(/symlink/i)

    expect(await readFile(outsideTarget, 'utf8')).toBe('outside original\n')
  })

  test('rejects secret-looking files in asset snapshots', async () => {
    const { root } = await createHistoryFixture()
    const generatedDir = join(root, '.matos', 'assets', 'generated', 'knowledge', 'bad')
    await mkdir(generatedDir, { recursive: true })
    await writeFile(join(generatedDir, '.env'), 'DEEPSEEK_API_KEY=secret-value-123456789\n')

    await expect(
      createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'project',
      }),
    ).rejects.toThrow(/secret-looking file/)
  })

  test('rejects secret-looking content in asset snapshots', async () => {
    const { root, rolePath } = await createHistoryFixture()
    await writeFile(
      rolePath,
      '# Compute\n\nDEEPSEEK_API_KEY=secret-value-123456789\n',
      'utf8',
    )

    await expect(
      createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'core',
      }),
    ).rejects.toThrow(/secret-looking content/)
  })

  test('allows environment-variable secret references in asset snapshots', async () => {
    const { root } = await createHistoryFixture()
    const scriptPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'skills',
      'qmof-database',
      'scripts',
      'query_qmof.py',
    )
    await mkdir(dirname(scriptPath), { recursive: true })
    await writeFile(
      scriptPath,
      [
        'import os',
        'export MP_API_KEY="your_api_key_here"',
        'api_key: Optional[str] = None,',
        'api_key = os.environ.get("MP_API_KEY")',
        'api_key = os.getenv("MP_API_KEY")',
        'secret_key = parser.get("default", "secret_access_key", fallback="").strip()',
        'self.api_key = params["api_key"]',
        'headers["x-api-key"] = api_key',
        'if api_key is None:',
        '    print("Error: missing API key")',
        'client_token = os.getenv("CLIENT_TOKEN")',
        'print(bool(api_key), bool(client_token))',
        '',
      ].join('\n'),
      'utf8',
    )

    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const validation = await validateMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: snapshot.snapshotId,
    })

    expect(validation.secretScan).toMatchObject({ ok: true, findings: [] })
  })

  test('rejects explicit paths outside the asset allowlist', async () => {
    const { root } = await createHistoryFixture()
    const outsidePath = join(root, 'src', 'runtime.ts')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(outsidePath, 'export const unsafe = true\n', 'utf8')

    await expect(
      createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'core',
        paths: [outsidePath],
      }),
    ).rejects.toThrow(/outside MatOS asset history allowlist/)
  })

  test('does not treat project-local assets as a user fallback without an owned source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-user-fallback-'))
    await mkdir(join(root, '.matos', 'assets'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: 'http://matos-gitea:3000/matos-core/assets.git',
          scope: 'core',
          refresh: 'manual',
        },
      ],
    })

    expect(matOSAssetHistoryAllowedRoots(root, 'user')).toEqual([])
  })

  test('selects only the exact configured owner and never discovers unrelated scoped caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-owner-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [],
      includeDefaultAssetRoots: false,
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo: 'http://matos-gitea:3000/matos-users/alice-assets.git',
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
        {
          type: 'git',
          id: 'bob-assets',
          repo: 'http://matos-gitea:3000/matos-users/bob-assets.git',
          scope: 'user',
          scopeRef: 'user:bob',
          refresh: 'manual',
        },
      ],
    })
    const unrelated = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'charlie',
      'git',
      'unregistered-assets',
    )
    await mkdir(unrelated, { recursive: true })

    const aliceRoots = matOSAssetHistoryAllowedRoots(
      root,
      'user',
      'user:alice',
    )
    expect(aliceRoots).toHaveLength(2)
    expect(aliceRoots.some(path => path.includes('/users/alice/'))).toBe(true)
    expect(aliceRoots.some(path => path.includes('/users/bob/'))).toBe(false)
    expect(aliceRoots).not.toContain(unrelated)
    expect(() => matOSAssetHistoryAllowedRoots(root, 'user')).toThrow(
      /scopeRef is required/,
    )
  })

  test('allows generated experience evidence alongside scoped Gitea user sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-user-generated-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [
        {
          type: 'git',
          id: 'matos-user-assets-admin',
          repo: 'http://matos-gitea:3000/matos-users/admin-assets.git',
          scope: 'user',
          scopeRef: 'user:admin',
          refresh: 'manual',
        },
      ],
    })
    const experiencePath = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'paper-db-401',
      'asset.json',
    )
    await mkdir(dirname(experiencePath), { recursive: true })
    await writeJson(experiencePath, {
      schemaVersion: 1,
      id: 'paper-db-401',
      type: 'experience',
      name: 'Paper DB 401',
      version: '0.1.0',
    })

    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'user',
      scopeRef: 'user:admin',
      paths: [
        '.matos/assets/generated/evolution/experiences/paper-db-401/asset.json',
      ],
    })

    expect(snapshot.files.map(file => file.path)).toEqual([
      '.matos/assets/generated/evolution/experiences/paper-db-401/asset.json',
    ])
    expect(matOSAssetHistoryAllowedRoots(root, 'user', 'user:admin')).toContain(
      join(root, '.matos', 'assets', 'generated', 'scopes', 'users', 'admin'),
    )
  })

  test('rejects unsupported shared and global history scopes at the backend layer', async () => {
    const { root } = await createHistoryFixture()

    await expect(
      createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'shared',
      }),
    ).rejects.toThrow(/unsupported MatOS asset history scope/i)
    await expect(
      createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'global',
      }),
    ).rejects.toThrow(/unsupported MatOS asset history scope/i)
  })

  test('rejects snapshot records that omit the files array', async () => {
    const { root } = await createHistoryFixture()
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    const { files: _files, ...withoutFiles } = snapshot
    await writeJson(
      join(root, '.matos', 'asset-history', 'records', `${snapshot.snapshotId}.json`),
      withoutFiles,
    )

    await expect(
      readMatOSAssetHistorySnapshot(root, snapshot.snapshotId),
    ).rejects.toThrow(/files array/i)
  })

  test('snapshots and restores non UTF-8 asset files without text decoding', async () => {
    const { root } = await createHistoryFixture()
    const binaryPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'compute',
      'binary.bin',
    )
    const original = Buffer.from([0xff, 0xfe, 0xfd])
    await writeFile(binaryPath, original)

    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02]))

    await restoreMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: snapshot.snapshotId,
    })

    expect(await readFile(binaryPath)).toEqual(original)
  })

  test('surfaces unreadable snapshot record entries as record issues', async () => {
    const { root } = await createHistoryFixture()
    const recordDir = join(root, '.matos', 'asset-history', 'records')
    await mkdir(join(recordDir, 'asset-snapshot-directory.json'), { recursive: true })

    const list = await listMatOSAssetHistorySnapshotsWithIssues(root)

    expect(list.records).toEqual([])
    expect(list.issues).toEqual([
      expect.objectContaining({
        kind: 'snapshot',
        file: 'asset-snapshot-directory.json',
      }),
    ])
  })

  test('validates a snapshot against the active MatOS asset registry', async () => {
    const { root } = await createHistoryFixture()
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })

    const validation = await validateMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: snapshot.snapshotId,
      gateProfile: 'structural',
    })

    expect(validation).toMatchObject({
      ok: true,
      gateProfile: 'structural',
      assetValidation: { ok: true, errors: [] },
      secretScan: { ok: true, findings: [] },
    })
  })

  test('validates a scoped snapshot against core runtime dependency context', async () => {
    const { root } = await createHistoryFixture()
    const coreRunbookDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'knowledge',
      'hpc-submit-runbook',
    )
    await mkdir(coreRunbookDir, { recursive: true })
    await writeJson(join(coreRunbookDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'hpc-submit-runbook',
      type: 'knowledge',
      name: 'HPC Submit Runbook',
      version: '1.0.0',
      entry: 'KNOWLEDGE.md',
    })
    await writeFile(
      join(coreRunbookDir, 'KNOWLEDGE.md'),
      '# HPC Submit Runbook\n\nUse preflight checks before submit.\n',
      'utf8',
    )
    const scopedRunbookDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'admin-main',
      'knowledge',
      'compute-preflight-runbook',
    )
    await mkdir(scopedRunbookDir, { recursive: true })
    await writeJson(join(scopedRunbookDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'compute-preflight-runbook',
      type: 'knowledge',
      name: 'Compute Preflight Runbook',
      version: '0.1.0',
      entry: 'KNOWLEDGE.md',
      dependencies: ['knowledge:hpc-submit-runbook@1.0.0'],
      metadata: {
        sourceProvenance: {
          scope: 'user',
          scopeRef: 'user:admin-main',
        },
      },
    })
    await writeFile(
      join(scopedRunbookDir, 'KNOWLEDGE.md'),
      '# Compute Preflight Runbook\n\nCheck assets before generating compute jobs.\n',
      'utf8',
    )
    const snapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'user',
    })

    const validation = await validateMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: snapshot.snapshotId,
      gateProfile: 'structural',
    })

    expect(validation).toMatchObject({
      ok: true,
      assetValidation: { ok: true, errors: [] },
      secretScan: { ok: true, findings: [] },
    })
  })

  test('validates the snapshot commit instead of the current workspace state', async () => {
    const { root } = await createHistoryFixture()
    const assetPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'compute',
      'asset.json',
    )
    await writeJson(assetPath, {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      version: '0.1.0',
      entry: 'ROLE.md',
    })
    const invalidSnapshot = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await writeJson(assetPath, {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '0.1.0',
      entry: 'ROLE.md',
    })

    const validation = await validateMatOSAssetHistorySnapshot({
      cwd: root,
      snapshotId: invalidSnapshot.snapshotId,
    })

    expect(validation.ok).toBe(false)
    expect(JSON.stringify(validation.assetValidation.errors)).toContain('name')
  })

  test('serializes asset history writers with a lock file', async () => {
    const { root } = await createHistoryFixture()
    let nestedFailed = false

    await withMatOSAssetHistoryLock(
      {
        cwd: root,
        operation: 'outer-test',
        timeoutMs: 500,
        pollMs: 10,
      },
      async () => {
        await expect(
          withMatOSAssetHistoryLock(
            {
              cwd: root,
              operation: 'inner-test',
              timeoutMs: 20,
              pollMs: 5,
            },
            async () => undefined,
          ),
        ).rejects.toThrow(/asset history is locked/)
        nestedFailed = true
      },
    )

    expect(nestedFailed).toBe(true)
    await withMatOSAssetHistoryLock(
      {
        cwd: root,
        operation: 'after-release',
        timeoutMs: 20,
        pollMs: 5,
      },
      async () => {
        expect(true).toBe(true)
      },
    )
  })

  test('allows an explicitly reentrant rollback path without weakening default contention', async () => {
    const { root } = await createHistoryFixture()
    let nestedRan = false

    await withMatOSAssetHistoryLock(
      { cwd: root, operation: 'outer-test' },
      async () => {
        await withMatOSAssetHistoryLock(
          {
            cwd: root,
            operation: 'nested-rollback-test',
            allowReentrant: true,
          },
          async () => {
            nestedRan = true
          },
        )
      },
    )

    expect(nestedRan).toBe(true)
  })

  test('does not steal a stale-looking lock when the owner pid is still alive', async () => {
    const { root } = await createHistoryFixture()
    const lockPath = assetHistoryLockPath(root)
    await mkdir(join(root, '.matos', 'locks'), { recursive: true })
    await writeJson(lockPath, {
      schemaVersion: 1,
      pid: process.pid,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      operation: 'alive-owner',
    })

    await expect(
      withMatOSAssetHistoryLock(
        {
          cwd: root,
          operation: 'contender',
          timeoutMs: 25,
          pollMs: 5,
          staleMs: 1,
        },
        async () => undefined,
      ),
    ).rejects.toThrow(/asset history is locked/)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).operation).toBe('alive-owner')
  })

  test('reclaims stale foreign-host locks using the shorter foreign-host threshold', async () => {
    const { root } = await createHistoryFixture()
    const lockPath = assetHistoryLockPath(root)
    await mkdir(join(root, '.matos', 'locks'), { recursive: true })
    await writeJson(lockPath, {
      schemaVersion: 1,
      pid: 1,
      hostId: 'old-container-host',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      operation: 'direct-editor-prepare',
      runId: 'direct-editor-dead-container',
    })
    const oldTime = new Date(Date.now() - 60_000)
    await utimes(lockPath, oldTime, oldTime)

    let acquired = false
    await withMatOSAssetHistoryLock(
      {
        cwd: root,
        operation: 'contender',
        timeoutMs: 100,
        pollMs: 5,
        staleMs: 30 * 60_000,
        foreignHostStaleMs: 1,
      },
      async () => {
        acquired = true
      },
    )

    expect(acquired).toBe(true)
    expect(await exists(lockPath)).toBe(false)
  })

  test('does not steal a fresh invalid lock record while another writer is creating it', async () => {
    const { root } = await createHistoryFixture()
    const lockPath = assetHistoryLockPath(root)
    await mkdir(join(root, '.matos', 'locks'), { recursive: true })
    await writeFile(lockPath, '', 'utf8')

    await expect(
      withMatOSAssetHistoryLock(
        {
          cwd: root,
          operation: 'contender',
          timeoutMs: 25,
          pollMs: 5,
          staleMs: 30_000,
        },
        async () => undefined,
      ),
    ).rejects.toThrow(/asset history is locked/)
    expect(await exists(lockPath)).toBe(true)
  })

  test('does not overwrite a fresh lock when restoring a stolen stale lock', async () => {
    const { root } = await createHistoryFixture()
    const lockPath = assetHistoryLockPath(root)
    const stealPath = `${lockPath}.stealing.test`
    await mkdir(join(root, '.matos', 'locks'), { recursive: true })
    await writeJson(stealPath, {
      schemaVersion: 1,
      pid: -1,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      operation: 'stolen-stale',
    })
    await writeJson(lockPath, {
      schemaVersion: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      operation: 'fresh-owner',
    })

    const restored = await restoreStolenLockIfTargetMissingForTests(
      stealPath,
      lockPath,
    )

    expect(restored).toBe(false)
    expect(await exists(stealPath)).toBe(false)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).operation).toBe(
      'fresh-owner',
    )
  })
})
