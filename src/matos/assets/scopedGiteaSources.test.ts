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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'bun:test'
import { readMatOSProjectConfig } from '../project.js'
import { syncRuntimeScopedGiteaAssetSource } from './scopedGiteaSources.js'

const execFileAsync = promisify(execFile)

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return String(result.stdout ?? '').trim()
}

test('preserves an existing accepted runtime ref when replacing a scoped Gitea source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'matos-scoped-gitea-source-'))
  const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-scoped-gitea-source-git-'))
  const worktree = await mkdtemp(join(tmpdir(), 'matos-scoped-gitea-source-work-'))
  const packRoot = join(worktree, 'packs', 'user-pack')
  await mkdir(join(packRoot, 'roles', 'user-role'), { recursive: true })
  await writeJson(join(packRoot, 'matos.pack.json'), {
    id: 'user-pack',
    name: 'User Pack',
    version: '1.0.0',
  })
  await writeJson(join(packRoot, 'roles', 'user-role', 'asset.json'), {
    id: 'user-role',
    type: 'role',
    name: 'User Role',
    version: '1.0.0',
    path: '.',
  })
  await git(worktree, ['init', '-b', 'main'])
  await git(worktree, ['add', '.'])
  await git(worktree, [
    '-c',
    'user.name=MatOS Test',
    '-c',
    'user.email=matos-test@localhost',
    'commit',
    '-m',
    'seed user assets',
  ])
  await mkdir(join(giteaRoot, 'matos-users'), { recursive: true })
  const bareRepo = join(giteaRoot, 'matos-users', 'alice-example-com-assets.git')
  await execFileAsync('git', ['clone', '--bare', worktree, bareRepo])
  const acceptedRef = 'accepted/matos-user-assets-alice-example-com/stable'
  await git(bareRepo, ['branch', acceptedRef, 'main'])
  const acceptedCommit = await git(bareRepo, [
    'rev-parse',
    `refs/heads/${acceptedRef}`,
  ])
  const baseUrl = pathToFileURL(giteaRoot).href
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    includeDefaultAssetRoots: false,
    assetRoots: [],
    assetSources: [
      {
        type: 'git',
        id: 'matos-user-assets-alice-example-com',
        repo: `${baseUrl}/matos-users/alice-example-com-assets.git`,
        ref: 'main',
        scope: 'user',
        scopeRef: 'user:alice@example.com',
        provider: 'gitea',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: acceptedRef,
          commit: acceptedCommit,
          acceptedAt: '2026-08-04T00:00:00.000Z',
        },
      },
    ],
  })

  const result = await syncRuntimeScopedGiteaAssetSource({
    cwd: root,
    scope: 'user',
    scopeRef: 'user:alice@example.com',
    baseUrl,
    replace: true,
  })

  expect(result.validation.ok).toBe(true)
  expect(result.source.runtimeRef).toMatchObject({
    mode: 'accepted-ref',
    ref: acceptedRef,
    commit: acceptedCommit,
  })
  const config = await readMatOSProjectConfig(root)
  expect(config.assetSources).toHaveLength(1)
  expect(config.assetSources?.[0]).toMatchObject({
    id: 'matos-user-assets-alice-example-com',
    runtimeRef: {
      mode: 'accepted-ref',
      ref: acceptedRef,
      commit: acceptedCommit,
    },
  })
})
