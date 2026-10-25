import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMatOSAssets, loadMatOSRuntimeAssets } from './loadAssets.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('typed reader matches data from the full reader across packs, loose manifests, versions and mounts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-typed-assets-')); roots.push(cwd)
  await mkdir(join(cwd, '.matos'), { recursive: true })
  const pack = join(cwd, 'native'), loose = join(cwd, 'loose')
  await mkdir(pack); await mkdir(loose)
  await writeFile(join(pack, 'matos.pack.json'), JSON.stringify({ id: 'native', version: '1.0.0' }))
  async function asset(root: string, dir: string, type: string, version = '1.0.0') {
    const target = join(root, dir); await mkdir(target, { recursive: true })
    await writeFile(join(target, 'asset.json'), JSON.stringify({ id: type === 'data' ? 'balance' : dir, type,
      name: dir, version, entry: 'device.json', tags: ['virtual-lab-device'] }))
    await writeFile(join(target, 'device.json'), '{}')
  }
  await asset(pack, 'data/balance-v1', 'data')
  await asset(pack, 'data/balance-v2', 'data', '2.0.0')
  await asset(pack, 'knowledge/manual', 'knowledge')
  await asset(loose, 'arbitrary-name', 'data', '3.0.0')
  await asset(loose, 'also-arbitrary', 'skill')
  await writeFile(join(loose, 'roles.json'), JSON.stringify({ roles: { scientist: { label: 'Scientist' } } }))
  await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1, includeDefaultAssetRoots: false,
    assetRoots: [pack, loose], assetSources: [], assetMounts: [{ type: 'data', id: 'mounted', name: 'Mounted', version: '1.0.0', path: 'mounted.json' }] }))
  await writeFile(join(cwd, 'mounted.json'), '{}')
  const full = (await loadMatOSRuntimeAssets(cwd)).filter(asset => asset.type === 'data')
  expect(await loadMatOSRuntimeAssets(cwd, { types: ['data'] })).toEqual(full)
  expect(await loadMatOSAssets(cwd, { types: [] })).toEqual([])
}, 30000)

test('data reader does not parse irrelevant legacy role files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-data-reader-')); roots.push(cwd)
  await mkdir(join(cwd, '.matos/assets'), { recursive: true })
  await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1, includeDefaultAssetRoots: false, assetRoots: ['assets'] }))
  await writeFile(join(cwd, '.matos/assets/roles.json'), '{ invalid legacy role')
  expect((await loadMatOSAssets(cwd)).some(asset => asset.metadata.loadError)).toBe(true)
  expect(await loadMatOSRuntimeAssets(cwd, { types: ['data'] })).toEqual([])
}, 30000)

test('catalog reader excludes unpublished evolution history without hiding scoped data, share forks or external sources', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-catalog-history-')); roots.push(cwd)
  const local = join(cwd, '.matos/assets'), external = join(cwd, 'accepted-source')
  await mkdir(local, { recursive: true })
  await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({ version: 1, includeDefaultAssetRoots: false, assetRoots: [local, external] }))
  const entries = [
    [local, 'generated/evolution/episode/data/legacy', 'legacy'],
    [local, 'generated/scopes/users/owner/evolution/experiences/history', 'history'],
    [local, 'generated/scopes/users/owner/data/device', 'scoped'],
    [local, 'generated/scopes/users/owner/project-share-forks/device', 'fork'],
    [local, 'packs/local/data/device', 'project'],
    [external, 'generated/evolution/data/device', 'external'],
  ] as const
  for (const [root, dir, id] of entries) {
    const path = join(root, dir); await mkdir(path, { recursive: true })
    await writeFile(join(path, 'asset.json'), JSON.stringify({ type: 'data', id, name: id, version: '1.0.0', metadata: { scopeRef: 'user:owner' } }))
  }
  const full = await loadMatOSRuntimeAssets(cwd, { types: ['data'] })
  expect(full.map(asset => asset.id).sort()).toEqual(['external', 'fork', 'history', 'legacy', 'project', 'scoped'])
  const visible = await loadMatOSRuntimeAssets(cwd, { types: ['data'], excludeEvolutionEvidence: true })
  expect(visible.map(asset => asset.id).sort()).toEqual(['external', 'fork', 'project', 'scoped'])
}, 30000)
