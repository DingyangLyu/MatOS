import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getMatOSBundledAssetRootCandidates,
  getMatOSDefaultAssetRoots,
  readMatOSProjectConfig,
} from './project.js'

const roots: string[] = []
const ORIGINAL_ENV = { ...process.env }

function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, snapshot)
}

afterEach(async () => {
  restoreProcessEnv(ORIGINAL_ENV)
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

async function tempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-project-config-'))
  roots.push(root)
  return root
}

describe('MatOS project config', () => {
  test('includes existing deployment shared and global asset roots by default', async () => {
    const root = await tempProject()
    const sharedRoot = join(root, 'deploy', 'assets', 'shared')
    const globalRoot = join(root, 'deploy', 'assets', 'global')
    await mkdir(sharedRoot, { recursive: true })
    await mkdir(globalRoot, { recursive: true })
    process.env.MATOS_DEPLOY_ROOT = join(root, 'deploy')

    expect(getMatOSDefaultAssetRoots(process.env)).toEqual(
      expect.arrayContaining([sharedRoot, globalRoot]),
    )
  })

  test('treats explicit bundled asset roots as authoritative', async () => {
    const root = await tempProject()
    const bundledRoot = join(root, 'editable-core')
    await mkdir(bundledRoot, { recursive: true })

    expect(
      getMatOSBundledAssetRootCandidates({
        MATOS_BUNDLED_ASSET_ROOT: bundledRoot,
      }),
    ).toEqual([bundledRoot])

    expect(
      getMatOSDefaultAssetRoots({
        MATOS_DEPLOY_ROOT: join(root, 'missing-deploy'),
        MATOS_ASSET_ROOTS: bundledRoot,
        MATOS_BUNDLED_ASSET_ROOT: bundledRoot,
      }),
    ).toEqual([bundledRoot])
  })

  test('parses deployment roots and workspace resource limits', async () => {
    const root = await tempProject()
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        execution: {
          deploymentRoot: '/srv/matos-test-fixtures/matos-v2-state',
          governanceRoot:
            '/srv/matos-test-fixtures/matos-v2-state/governance',
          backupRoot: '/srv/matos-test-fixtures/matos-v2-state/backups',
          workspaceResourceLimits: {
            memory: '16g',
            cpus: '4',
            gpus: '0',
            pidsLimit: 2048,
            shmSize: '2g',
          },
        },
      }),
      'utf8',
    )

    const config = await readMatOSProjectConfig(root)

    expect(config.execution?.deploymentRoot).toBe(
      '/srv/matos-test-fixtures/matos-v2-state',
    )
    expect(config.execution?.governanceRoot).toBe(
      '/srv/matos-test-fixtures/matos-v2-state/governance',
    )
    expect(config.execution?.backupRoot).toBe(
      '/srv/matos-test-fixtures/matos-v2-state/backups',
    )
    expect(config.execution?.workspaceResourceLimits).toEqual({
      memory: '16g',
      cpus: '4',
      gpus: '0',
      pidsLimit: 2048,
      shmSize: '2g',
    })
  })

  test('parses git asset sources', async () => {
    const root = await tempProject()
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        assetSources: [
          {
            type: 'git',
            id: 'global-assets',
            repo: 'file:///tmp/matos-global-assets.git',
            ref: 'main',
            subdir: 'packs',
          },
          {
            type: 'local',
            id: 'team-assets',
            path: '/workspace/assets/team',
            scope: 'team',
            scopeRef: 'team:simulation',
          },
          {
            type: 'git',
            id: '',
            repo: '',
          },
          {
            type: 'unknown',
            id: 'ignored',
            path: '/workspace/assets/ignored',
          },
        ],
      }),
      'utf8',
    )

    const config = await readMatOSProjectConfig(root)

    expect(config.assetSources).toEqual([
      {
        type: 'git',
        id: 'global-assets',
        repo: 'file:///tmp/matos-global-assets.git',
        ref: 'main',
        subdir: 'packs',
        scope: 'project',
        refresh: 'manual',
      },
      {
        type: 'local',
        id: 'team-assets',
        path: '/workspace/assets/team',
        scope: 'team',
        scopeRef: 'team:simulation',
        refresh: 'manual',
      },
    ])
  })
})
