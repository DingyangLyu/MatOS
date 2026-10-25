import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { getMatOSConfigPath, readMatOSProjectConfig, writeMatOSProjectConfig } from './project.js'
import { preflightEvolutionGiteaSources } from './learning/evolutionGiteaPreflight.js'

test('critical asset transactions reject corrupt config instead of discovering default/core sources', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-config-strict-'))
  await writeMatOSProjectConfig(cwd, { version: 1, assetRoots: [], includeDefaultAssetRoots: false })
  await writeFile(getMatOSConfigPath(cwd), '{')
  await expect(readMatOSProjectConfig(cwd, { strict: true })).rejects.toThrow()
  for (const value of [[], { version: 2 }, { version: 1, assetSources: [{ type: 'unknown' }] }]) {
    await writeFile(getMatOSConfigPath(cwd), JSON.stringify(value))
    await expect(readMatOSProjectConfig(cwd, { strict: true })).rejects.toThrow()
    expect(await preflightEvolutionGiteaSources({ cwd, scope: 'user', scopeRef: 'user:alice', env: {} })).toMatchObject({
      ok: false, code: 'gitea_source_invalid', sourceId: 'matos-config',
    })
  }
})

test('config publication is atomic and preserves existing access mode', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'matos-config-atomic-'))
  await writeMatOSProjectConfig(cwd, { version: 1, assetRoots: [] })
  const before = await stat(getMatOSConfigPath(cwd))
  await writeMatOSProjectConfig(cwd, { version: 1, assetRoots: ['assets-new'] })
  const after = await stat(getMatOSConfigPath(cwd))
  expect(after.ino).not.toBe(before.ino)
  expect(after.mode & 0o777).toBe(before.mode & 0o777)
  expect(JSON.parse(await readFile(getMatOSConfigPath(cwd), 'utf8')).assetRoots).toEqual(['assets-new'])
})
