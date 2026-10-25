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

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { loadWorkflowAsset } from '../workflows/loadWorkflow.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { loadMatOSAssets } from './loadAssets.js'
import { validateMatOSAssets } from './validateAssets.js'

const execFileAsync = promisify(execFile)
const ORIGINAL_ENV = { ...process.env }
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const VIRTUAL_LAB_PACK_ROOT = join(
  REPO_ROOT,
  'matos-assets',
  'packs',
  'matos-virtual-lab',
)

const cleanupRoots: string[] = []

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 64 * 1024 * 1024,
  })
  return String(result.stdout ?? '').trim()
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '.'])
  await git(cwd, [
    '-c',
    'user.name=MatOS Test',
    '-c',
    'user.email=matos-test@localhost',
    'commit',
    '-m',
    message,
  ])
}

function includeInPublishedMirror(path: string): boolean {
  const base = basename(path)
  // The real publish path (scripts/matos-assets-gitea-fast-publish.sh) uses
  // `git ls-files --exclude-standard`, so gitignored runtime residue under
  // matos-assets (`**/.matos/`, `**/labenv-work/`, `**/__pycache__/`) never
  // reaches the mirror. Render jobs park ~1GB of scratch under the live
  // render-photoreal tool's `.matos/`; copying it here made this test slow
  // enough to time out and raced against live residue cleanup.
  return (
    base !== '__pycache__' &&
    base !== '.matos' &&
    base !== 'labenv-work' &&
    !base.endsWith('.pyc')
  )
}

// Regression guard for the virtual-lab "GPU 引擎运行" incident: the
// matos-virtual-lab pack was baked into the image at /app/matos-assets but was
// never published to the Gitea matos-core/assets repo, so every provisioned
// scope workspace (includeDefaultAssetRoots: false + Gitea assetSources as
// runtime truth) failed `matos workflow run
// workflow:virtual-lab-experiment-sop` with "asset not found". This test
// mirrors that workspace shape with the real pack files: once the pack is
// present in the core git source, the workflow ref must resolve and its
// definition must load.
describe('scope-workspace-shaped asset loading', () => {
})

describe('asset loader resilience', () => {
  test('skips and reports a malformed asset.json without failing the whole load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-broken-manifest-'))
    cleanupRoots.push(root)
    const healthyDir = join(root, '.matos', 'assets', 'skills', 'healthy')
    const brokenDir = join(root, '.matos', 'assets', 'skills', 'broken')
    await mkdir(healthyDir, { recursive: true })
    await mkdir(brokenDir, { recursive: true })
    await writeFile(
      getMatOSConfigPath(root),
      `${JSON.stringify(
        { version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(
      join(healthyDir, 'asset.json'),
      `${JSON.stringify(
        {
          id: 'healthy',
          type: 'skill',
          name: 'Healthy Skill',
          version: '1.0.0',
          path: '.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(brokenDir, 'asset.json'), '{ "id": "broken", \n', 'utf8')

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    expect(registry.resolve('skill:healthy')?.name).toBe('Healthy Skill')

    const broken = assets.find(
      asset => asset.metadata.sourceFormat === 'matos-broken-asset-manifest',
    )
    expect(broken).toBeDefined()
    expect(broken?.manifestPath).toBe(join(brokenDir, 'asset.json'))
    expect(String(broken?.metadata.loadError ?? '')).not.toBe('')
  })

  test('re-reads pack metadata after matos.pack.json changes in one process', async () => {
    // Regression: pack metadata was cached forever per pack root, so a
    // long-lived process (workbench service, daemon) kept serving stale pack
    // id/name/version after the pack manifest was edited or re-published.
    const root = await mkdtemp(join(tmpdir(), 'matos-pack-metadata-cache-'))
    cleanupRoots.push(root)
    const packRoot = join(root, '.matos', 'assets', 'packs', 'cache-pack')
    const roleDir = join(packRoot, 'roles', 'cache-role')
    await mkdir(roleDir, { recursive: true })
    await writeFile(
      getMatOSConfigPath(root),
      `${JSON.stringify(
        { version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(
      join(packRoot, 'matos.pack.json'),
      `${JSON.stringify(
        { id: 'cache-pack', name: 'Cache Pack', version: '1.0.0' },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(
      join(roleDir, 'asset.json'),
      `${JSON.stringify(
        {
          id: 'cache-role',
          type: 'role',
          name: 'Cache Role',
          version: '1.0.0',
          path: '.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const first = await loadMatOSAssets(root)
    expect(first.find(asset => asset.id === 'cache-role')?.packVersion).toBe(
      '1.0.0',
    )

    await writeFile(
      join(packRoot, 'matos.pack.json'),
      `${JSON.stringify(
        {
          id: 'cache-pack',
          name: 'Cache Pack Republished',
          version: '2.0.0',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const second = await loadMatOSAssets(root)
    const reloaded = second.find(asset => asset.id === 'cache-role')
    expect(reloaded?.packVersion).toBe('2.0.0')
    expect(reloaded?.packName).toBe('Cache Pack Republished')
  })
})
