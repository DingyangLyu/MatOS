import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { composeMatOSRoleRuntime } from './runtimeComposition.js'
import { materializeMatOSRuntime } from './runtimeMaterialization.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(options: { pinned?: boolean; version?: string; status?: string; overlay?: boolean } = {}) {
  const root = await mkdtempInMatOSTmp({ prefix: 'skill-overlay-regression-' })
  roots.push(root)
  const assets = join(root, '.matos', 'assets')
  const parent = join(assets, 'core', 'code-interfaces')
  const core = join(parent, 'fenicsx-interface')
  const scoped = join(assets, 'user', 'fenicsx-interface')
  const role = join(assets, 'roles', 'compute')
  const id = 'code-interfaces/fenicsx-interface'
  async function writeAsset(dir: string, manifest: Record<string, unknown>, text: string) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'asset.json'), JSON.stringify({ version: '0.1.0', entry: 'SKILL.md', ...manifest }))
    await writeFile(join(dir, 'SKILL.md'), text)
  }
  await writeAsset(parent, { id: 'code-interfaces', type: 'skill', name: 'Interfaces' }, '# Interfaces\n')
  await writeAsset(core, { id, type: 'skill', name: 'FEniCSx' }, '# Core FEniCSx\n')
  await writeAsset(scoped, {
    id, type: 'skill', name: 'Scoped FEniCSx', version: options.version ?? '0.1.3',
    ...(options.status ? { lifecycle: { status: options.status } } : {}),
    metadata: options.overlay === false ? {} : { overlayOf: `skill:${id}@0.1.0` },
  }, '# Accepted scoped FEniCSx corrections\n')
  await writeAsset(role, {
    id: 'overlay-test', type: 'role', name: 'Overlay test',
    mounts: { skills: ['skill:code-interfaces', `skill:${id}${options.pinned ? '@0.1.0' : ''}`] },
  }, 'Use the mounted skills.\n')
  await writeFile(join(root, '.matos', 'matos.json'), JSON.stringify({
    assetRoots: ['assets'], includeDefaultAssetRoots: false,
  }))
  const loaded = (await loadMatOSAssets(root)).map(asset => ({
    ...asset,
    metadata: { ...asset.metadata, sourceProvenance: { scope: asset.manifestDir === scoped ? 'user' : 'core' } },
  }))
  return { root, parent, core, scoped, id, loaded }
}

describe('nested skill runtime registry authority', () => {
  for (const version of ['0.1.0', '0.1.3']) {
    test(`uses the accepted scoped ${version} overlay once instead of its physical core child`, async () => {
      const f = await fixture({ version })
      const registry = buildMatOSAssetRegistry(f.loaded)
      expect(registry.resolve(`skill:${f.id}`)?.manifestDir).toBe(f.scoped)
      const runtime = await composeMatOSRoleRuntime(registry, 'role:overlay-test', { projectCwd: f.root })
      expect(runtime.skillDirs).toContain(f.scoped)
      expect(runtime.skillDirs).not.toContain(f.core)
      expect(runtime.skillDirs.filter(dir => dir === f.scoped)).toHaveLength(1)
      const result = await materializeMatOSRuntime(f.root, runtime, { cache: false })
      expect(await readFile(join(result.addDirs[0]!, '.matos/skills/code-interfaces__fenicsx-interface/SKILL.md'), 'utf8'))
        .toContain('Accepted scoped FEniCSx corrections')
      expect(await readFile(join(f.core, 'SKILL.md'), 'utf8')).toBe('# Core FEniCSx\n')
    })
  }

  test('honors an explicit version pin over implicitly discovered nested skills', async () => {
    const f = await fixture({ pinned: true })
    const runtime = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(f.loaded), 'role:overlay-test')
    expect(runtime.skillDirs).toContain(f.core)
    expect(runtime.skillDirs).not.toContain(f.scoped)
  })

  test('still rejects genuinely conflicting explicit version mounts', async () => {
    const f = await fixture()
    const conflicting = f.loaded.map(asset => asset.type === 'role'
      ? { ...asset, mounts: { ...asset.mounts, skills: [`skill:${f.id}@0.1.0`, `skill:${f.id}@0.1.3`] } } : asset)
    const runtime = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(conflicting), 'role:overlay-test')
    expect(runtime.skillDirs).toContain(f.core)
    expect(runtime.skillDirs).toContain(f.scoped)
    await expect(materializeMatOSRuntime(f.root, runtime, { cache: false }))
      .rejects.toThrow('MatOS skill runtime name collision')
  })

  test('does not discover a sibling directory with the same path prefix', async () => {
    const f = await fixture()
    const parentOnly = f.loaded.map(asset => asset.type === 'role'
      ? { ...asset, mounts: { ...asset.mounts, skills: ['skill:code-interfaces'] } }
      : asset.manifestDir === f.core ? { ...asset, manifestDir: `${f.parent}-extra/fenicsx-interface` } : asset)
    const runtime = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(parentOnly), 'role:overlay-test')
    expect(runtime.skillDirs).toEqual([f.parent])
  })

  test('does not allow a higher scoped version without a declared overlay to replace core', async () => {
    const f = await fixture({ overlay: false })
    const runtime = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(f.loaded), 'role:overlay-test')
    expect(runtime.skillDirs).toContain(f.core)
    expect(runtime.skillDirs).not.toContain(f.scoped)
  })

  for (const status of ['disabled', 'draft', 'deprecated'] as const) {
    test(`does not load a ${status} nested skill from disk`, async () => {
      const f = await fixture({ status })
      const loaded = f.loaded.map(asset => asset.manifestDir === f.core
        ? { ...asset, lifecycle: { ...asset.lifecycle, status } } : asset)
      const runtime = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(loaded), 'role:overlay-test')
      expect(runtime.skillDirs).toEqual([f.parent])
    })
  }

  test('does not resurrect a filesystem child absent from the scope-filtered registry', async () => {
    const f = await fixture()
    const visible = f.loaded.filter(asset => asset.id !== f.id)
    const runtime = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(visible), 'role:overlay-test')
    expect(runtime.skillDirs).toEqual([f.parent])
  })

  test('resolves a parent-only nested mount to the scoped winner and keeps other users on core', async () => {
    const f = await fixture()
    const parentOnly = f.loaded.map(asset => asset.type === 'role'
      ? { ...asset, mounts: { ...asset.mounts, skills: ['skill:code-interfaces'] } } : asset)
    const personal = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(parentOnly), 'role:overlay-test')
    expect(personal.skillDirs).toEqual([f.parent, f.scoped])
    const publicOnly = parentOnly.filter(asset => asset.manifestDir !== f.scoped)
    const other = await composeMatOSRoleRuntime(buildMatOSAssetRegistry(publicOnly), 'role:overlay-test')
    expect(other.skillDirs).toEqual([f.parent, f.core])
  })
})
