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
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'bun:test'
import { readMatOSProjectConfig } from '../project.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import {
  MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV,
  commitMatOSGitAssetSource,
  gitSafeDirectoryArgs,
  inspectMatOSAssetSource,
  materializeMatOSAssetSource,
  matOSAssetSourceCacheRoot,
  matOSGitAssetSourceCheckoutRoot,
  matOSGitCheckoutDirtIsUntrackedOnly,
  matOSGitCleanErrorIsPermissionResidue,
  repairMatOSGitAssetSourceCachePermissions,
  serializeMatOSAssetSourceConfig,
  syncMatOSGitAssetSourceOriginRemote,
  withMatOSGitAssetSourceLock,
} from './sourceAdapters.js'
import {
  DEFAULT_MATOS_GITEA_FILE_SOURCE_ROOT,
  matOSGiteaContainerTransportEnv,
  resolveMatOSGitAssetSourceRuntimeRepo,
} from './giteaRuntimeTransport.js'
import { validateMatOSAssets } from './validateAssets.js'

const execFileAsync = promisify(execFile)
const ASSET_TEST_ROOTS: string[] = []

async function mkAssetTestDir(prefix: string): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix })
  ASSET_TEST_ROOTS.push(root)
  return root
}

function isDefaultMatOSAssetPath(path: string | undefined): boolean {
  return Boolean(path && path.includes(join('matos-assets', 'packs', 'matos-core')))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return String(result.stdout).trim()
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

async function createGitRolePack(input: {
  repo: string
  packId: string
  roleId: string
  roleName: string
  overlayOf?: string
}): Promise<void> {
  const packRoot = join(input.repo, 'packs', input.packId)
  await mkdir(join(packRoot, 'roles', input.roleId), { recursive: true })
  await writeJson(join(packRoot, 'matos.pack.json'), {
    id: input.packId,
    name: input.packId,
    version: '1.0.0',
  })
  await writeJson(join(packRoot, 'roles', input.roleId, 'asset.json'), {
    id: input.roleId,
    type: 'role',
    name: input.roleName,
    version: '1.0.0',
    path: '.',
    ...(input.overlayOf ? { overlayOf: input.overlayOf } : {}),
  })
}

describe('MatOS asset source adapters', () => {
  afterEach(async () => {
    const roots = ASSET_TEST_ROOTS.splice(0)
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })

  test('rewrites loopback Gitea source URLs inside MatOS workspace containers', () => {
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-admin',
      repo: 'http://127.0.0.1:3001/matos-users/admin-assets.git',
      ref: 'main',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:admin',
    }

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source,
        repo: source.repo,
        env: {
          HOME: '/home/workspace',
          MATOS_WORKSPACE_DIR: '/workspace/group/shared',
        },
      }),
    ).toBe('http://matos-gitea:3000/matos-users/admin-assets.git')

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source,
        repo: source.repo,
        env: {
          HOME: '/home/workspace',
          MATOS_WORKSPACE_DIR: '/workspace/group/shared',
          MATOS_GITEA_CONTAINER_SOURCE_BASE_URL:
            'http://gitea.internal:3000/git',
        },
      }),
    ).toBe('http://gitea.internal:3000/git/matos-users/admin-assets.git')
  })

  test('does not rewrite non-container or non-Gitea loopback git source URLs', () => {
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-admin',
      repo: 'http://127.0.0.1:3001/matos-users/admin-assets.git',
      ref: 'main',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:admin',
    }

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/vepfs-mlp2/project',
        source,
        repo: source.repo,
        env: {
          HOME: '/root',
        },
      }),
    ).toBe('http://127.0.0.1:3001/matos-users/admin-assets.git')

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source: { ...source, provider: undefined },
        repo: 'http://127.0.0.1:48765/tmp/git-source.git',
        env: {
          HOME: '/home/workspace',
          MATOS_WORKSPACE_DIR: '/workspace/group/shared',
        },
      }),
    ).toBe('http://127.0.0.1:48765/tmp/git-source.git')
  })

  test('rewrites container-alias Gitea source URLs back to the host base URL on the host', () => {
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-admin',
      // A prior workspace preparation persisted the container-link alias into
      // matos.json. Host-side gateway/self-evolution executions cannot resolve
      // `matos-gitea`, so the runtime repo must fall back to the loopback base.
      repo: 'http://matos-gitea:3000/matos-users/admin-assets.git',
      ref: 'main',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:admin',
    }

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/srv/matos-test-fixtures/matos-v2-state/runtime/scopes/users/admin/workspace-state/shared',
        source,
        repo: source.repo,
        env: {
          HOME: '/root',
          MATOS_GITEA_SOURCE_BASE_URL: 'http://127.0.0.1:3001',
        },
      }),
    ).toBe('http://127.0.0.1:3001/matos-users/admin-assets.git')

    // Falls back to the default loopback host base URL when no host source base
    // URL env is configured.
    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/vepfs-mlp2/project',
        source,
        repo: source.repo,
        env: { HOME: '/root' },
      }),
    ).toBe('http://127.0.0.1:3001/matos-users/admin-assets.git')

    // Honors MATOS_GITEA_UPSTREAM as the host base URL and preserves the repo path.
    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/vepfs-mlp2/project',
        source,
        repo: source.repo,
        env: {
          HOME: '/root',
          MATOS_GITEA_UPSTREAM: 'http://127.0.0.1:3999/',
        },
      }),
    ).toBe('http://127.0.0.1:3999/matos-users/admin-assets.git')
  })

  test('keeps container-alias Gitea source URLs unchanged inside workspace containers', () => {
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-admin',
      repo: 'http://matos-gitea:3000/matos-users/admin-assets.git',
      ref: 'main',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:admin',
    }

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source,
        repo: source.repo,
        env: {
          HOME: '/home/workspace',
          MATOS_WORKSPACE_DIR: '/workspace/group/shared',
        },
      }),
    ).toBe('http://matos-gitea:3000/matos-users/admin-assets.git')
  })

  test('loads only the built-in local runtime profile', async () => {
    const root = await mkAssetTestDir('matos-runtime-builtins-')
    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)

    expect(registry.resolve('runtime:local')?.canonicalKey).toBe(
      'runtime:local@1.0.0',
    )
    expect(registry.resolve('runtime:matos-agent-lite')).toBeUndefined()
  })

  test('materializes git asset sources before loading assets', async () => {
    const root = await mkAssetTestDir('matos-git-source-project-')
    const repo = await mkAssetTestDir('matos-git-source-repo-')
    const packRoot = join(repo, 'packs', 'git-source-pack')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(join(packRoot, 'roles', 'git-role'), { recursive: true })
    await writeJson(join(packRoot, 'matos.pack.json'), {
      id: 'git-source-pack',
      name: 'Git Source Pack',
      version: '1.0.0',
    })
    await writeJson(join(packRoot, 'roles', 'git-role', 'asset.json'), {
      id: 'git-role',
      type: 'role',
      name: 'Git Role',
      version: '1.0.0',
      description: 'Role loaded from a Git-backed asset source.',
      path: '.',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add git source pack')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'git-source-pack',
          repo,
          ref: 'main',
          subdir: 'packs/git-source-pack',
          scope: 'project',
        },
      ],
    })

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    const role = registry.resolve('role:git-role')

    expect(role?.canonicalKey).toBe('role:git-role@1.0.0')
    expect(role?.packId).toBe('git-source-pack')
    expect(role?.source).toBe('pack')
  })

  test('preserves git asset source runtimeRef in status and serialization', async () => {
    const root = await mkAssetTestDir('matos-git-source-runtime-ref-')
    const repo = await mkAssetTestDir('matos-git-source-runtime-ref-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'runtime-ref-pack',
      roleId: 'runtime-ref-role',
      roleName: 'Runtime Ref Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add runtime ref role')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/runtime-ref-source/stable'])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'runtime-ref-source',
          repo,
          ref: 'main',
          subdir: 'packs/runtime-ref-pack',
          scope: 'project',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/runtime-ref-source/stable',
            commit: acceptedCommit,
            acceptedAt: '2026-06-19T00:00:00.000Z',
            validationRecord: '.matos/asset-acceptance/runtime-ref-source.json',
          },
        },
      ],
    })

    const config = await readMatOSProjectConfig(root)
    const source = config.assetSources?.[0]
    expect(source).toMatchObject({
      type: 'git',
      id: 'runtime-ref-source',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/runtime-ref-source/stable',
        acceptedAt: '2026-06-19T00:00:00.000Z',
      },
    })

    const status = await inspectMatOSAssetSource(root, source!)
    expect(status.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/runtime-ref-source/stable',
    })
    expect(serializeMatOSAssetSourceConfig(source!)).toMatchObject({
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/runtime-ref-source/stable',
      },
    })
  })

  test('rewrites loopback Gitea clone URLs only inside MatOS containers', () => {
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:3001/matos-users/alice-assets.git',
      ref: 'main',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:alice',
    }

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/srv/matos-test-fixtures/MatOS',
        source,
        repo: source.repo,
        env: {},
      }),
    ).toBe(source.repo)
    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source,
        repo: source.repo,
        env: { HOME: '/home/workspace' },
      }),
    ).toBe('http://matos-gitea:3000/matos-users/alice-assets.git')
    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source,
        repo: source.repo,
        env: {
          HOME: '/home/workspace',
          MATOS_GITEA_CONTAINER_SOURCE_BASE_URL: 'http://gitea.internal:3000/git',
        },
      }),
    ).toBe('http://gitea.internal:3000/git/matos-users/alice-assets.git')
    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source: { ...source, provider: undefined },
        repo: source.repo,
        env: { HOME: '/home/workspace' },
      }),
    ).toBe(source.repo)
  })

  test('uses mounted per-source file repo before container Gitea HTTP alias', async () => {
    const fileRoot = await mkAssetTestDir('matos-gitea-file-sources-')
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:3001/matos-users/alice-assets.git',
      ref: 'main',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:alice',
    }
    const mountedRepo = join(fileRoot, 'matos-user-assets-alice.git')
    await mkdir(mountedRepo, { recursive: true })

    expect(
      resolveMatOSGitAssetSourceRuntimeRepo({
        cwd: '/workspace/group/shared',
        source,
        repo: source.repo,
        env: {
          HOME: '/home/workspace',
          MATOS_GITEA_CONTAINER_SOURCE_BASE_URL: 'http://matos-gitea:3000',
          MATOS_GITEA_FILE_SOURCE_ROOT: fileRoot,
        },
      }),
    ).toBe(mountedRepo)
  })

  test('does not inject Git insteadOf rewrite env for loopback Gitea sources in containers', () => {
    const env = matOSGiteaContainerTransportEnv(
      {
        version: 1,
        assetRoots: [],
        assetSources: [
          {
            type: 'git',
            id: 'matos-user-assets-alice',
            repo: 'http://127.0.0.1:3001/matos-users/alice-assets.git',
            ref: 'main',
            provider: 'gitea' as const,
            scope: 'user' as const,
            scopeRef: 'user:alice',
          },
        ],
      },
      {},
    )

    expect(env).toMatchObject({
      MATOS_GITEA_CONTAINER_SOURCE_BASE_URL: 'http://matos-gitea:3000',
      MATOS_GITEA_API_URL: 'http://matos-gitea:3000/api/v1',
      MATOS_GITEA_FILE_SOURCE_ROOT: DEFAULT_MATOS_GITEA_FILE_SOURCE_ROOT,
    })
    expect(Object.keys(env).some(key => key.startsWith('GIT_CONFIG_'))).toBe(false)
  })

  test('loads accepted runtime ref instead of drifting main branch', async () => {
    const root = await mkAssetTestDir('matos-git-source-accepted-ref-')
    const repo = await mkAssetTestDir('matos-git-source-accepted-ref-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Accepted Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/accepted-source/stable', acceptedCommit])
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Broken Main Role',
    })
    await commitAll(repo, 'broken main asset content')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'accepted-source',
          repo,
          ref: 'main',
          subdir: 'packs/accepted-ref-pack',
          refresh: 'always',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/accepted-source/stable',
            commit: acceptedCommit,
          },
        },
      ],
    })

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:accepted-role')?.name).toBe('Accepted Role')
    const status = await inspectMatOSAssetSource(
      root,
      (await readMatOSProjectConfig(root)).assetSources![0]!,
    )
    expect(status.currentCommit).toBe(acceptedCommit)
  })

  test('preserves a dirty accepted checkout only for the explicit editor validation environment', async () => {
    const root = await mkAssetTestDir('matos-git-source-preserve-dirty-')
    const repo = await mkAssetTestDir('matos-git-source-preserve-dirty-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'preserve-dirty-pack',
      roleId: 'preserve-dirty-role',
      roleName: 'Accepted Role',
    })
    const original = '# Accepted Role\n\nImmutable accepted content.\n'
    await writeFile(
      join(
        repo,
        'packs',
        'preserve-dirty-pack',
        'roles',
        'preserve-dirty-role',
        'ROLE.md',
      ),
      original,
      'utf8',
    )
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/preserve-dirty-source/stable',
      acceptedCommit,
    ])
    const source = {
      type: 'git' as const,
      id: 'preserve-dirty-source',
      repo,
      ref: 'main',
      subdir: 'packs/preserve-dirty-pack',
      refresh: 'manual' as const,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/preserve-dirty-source/stable',
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    await loadMatOSAssets(root)
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const rolePath = join(
      checkoutRoot,
      'packs',
      'preserve-dirty-pack',
      'roles',
      'preserve-dirty-role',
      'ROLE.md',
    )
    const edited = '# Accepted Role\n\nEditor candidate must survive validation.\n'
    await writeFile(rolePath, edited, 'utf8')

    const previous = process.env[MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV]
    process.env[MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV] = '1'
    try {
      await materializeMatOSAssetSource(root, source)
    } finally {
      if (previous === undefined) {
        delete process.env[MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV]
      } else {
        process.env[MATOS_ASSET_SOURCE_PRESERVE_DIRTY_ENV] = previous
      }
    }
    expect(await readFile(rolePath, 'utf8')).toBe(edited)
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toContain(
      'ROLE.md',
    )

    // The exception is scoped to the trusted validation child. Normal
    // accepted-ref materialization still restores immutable runtime truth.
    await materializeMatOSAssetSource(root, source)
    expect(await readFile(rolePath, 'utf8')).toBe(original)
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
  })

  test('accepted runtime ref without pinned commit prefers remote accepted branch over stale local branch', async () => {
    const root = await mkAssetTestDir('matos-git-source-accepted-remote-')
    const repo = await mkAssetTestDir('matos-git-source-accepted-remote-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Accepted Remote Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted remote asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/accepted-source/stable', acceptedCommit])
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Broken Main Role',
    })
    await commitAll(repo, 'broken main asset content')
    const source = {
      type: 'git' as const,
      id: 'accepted-source',
      repo,
      ref: 'main',
      subdir: 'packs/accepted-ref-pack',
      refresh: 'always' as const,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/accepted-source/stable',
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    expect(
      buildMatOSAssetRegistry(await loadMatOSAssets(root)).resolve(
        'role:accepted-role',
      )?.name,
    ).toBe('Accepted Remote Role')

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await git(checkoutRoot, ['checkout', '-B', 'accepted/accepted-source/stable'])
    await createGitRolePack({
      repo: checkoutRoot,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Stale Local Accepted Role',
    })
    await commitAll(checkoutRoot, 'stale local accepted asset content')
    const staleLocalCommit = await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])
    expect(staleLocalCommit).not.toBe(acceptedCommit)

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:accepted-role')?.name).toBe(
      'Accepted Remote Role',
    )
    expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
      acceptedCommit,
    )
  })

  test('manual accepted runtime sources checkout runtime commit even when main drifts', async () => {
    const root = await mkAssetTestDir('matos-git-source-manual-accepted-ref-')
    const repo = await mkAssetTestDir('matos-git-source-manual-accepted-ref-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Accepted Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/accepted-source/stable', acceptedCommit])
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Broken Main Role',
    })
    await commitAll(repo, 'broken main asset content')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'accepted-source',
          repo,
          ref: 'main',
          subdir: 'packs/accepted-ref-pack',
          refresh: 'manual',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/accepted-source/stable',
            commit: acceptedCommit,
          },
        },
      ],
    })

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:accepted-role')?.name).toBe('Accepted Role')
    const status = await inspectMatOSAssetSource(
      root,
      (await readMatOSProjectConfig(root)).assetSources![0]!,
    )
    expect(status.currentCommit).toBe(acceptedCommit)
  })

  test('repairs git source checkout permissions after materialization', async () => {
    const root = await mkAssetTestDir('matos-git-source-permissions-')
    const repo = await mkAssetTestDir('matos-git-source-permissions-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'permission-pack',
      roleId: 'permission-role',
      roleName: 'Permission Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/permission-source/stable', acceptedCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'permission-source',
          repo,
          ref: 'main',
          subdir: 'packs/permission-pack',
          refresh: 'manual',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/permission-source/stable',
            commit: acceptedCommit,
          },
        },
      ],
    })

    await loadMatOSAssets(root)
    const source = (await readMatOSProjectConfig(root)).assetSources![0]!
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const acceptedDir = join(
      checkoutRoot,
      '.git',
      'refs',
      'heads',
      'accepted',
      'permission-source',
    )
    const acceptedFile = join(acceptedDir, 'stable')
    await mkdir(acceptedDir, { recursive: true })
    await writeFile(acceptedFile, `${acceptedCommit}\n`, 'utf8')
    await chmod(acceptedDir, 0o700)
    await chmod(acceptedFile, 0o600)

    await loadMatOSAssets(root)

    expect((await stat(acceptedDir)).mode & 0o777).toBe(0o777)
    expect((await stat(acceptedFile)).mode & 0o777).toBe(0o666)
    expect(
      (await stat(join(root, '.matos', 'source-cache'))).mode & 0o777,
    ).toBe(0o755)
    expect((await stat(matOSAssetSourceCacheRoot(root, source))).mode & 0o777).toBe(
      0o755,
    )
    expect(
      (await stat(join(matOSAssetSourceCacheRoot(root, source), '.locks')))
        .mode & 0o777,
    ).toBe(0o777)
    expect(
      (await stat(join(root, '.matos', 'source-cache', 'git'))).mode & 0o777,
    ).toBe(0o755)
  })

  test('removes stale MatOS source-cache locks during permission repair', async () => {
    const root = await mkAssetTestDir('matos-git-source-stale-lock-repair-')
    const repo = await mkAssetTestDir('matos-git-source-stale-lock-repair-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'stale-lock-repair-pack',
      roleId: 'stale-lock-repair-role',
      roleName: 'Stale Lock Repair Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/stale-lock-repair-source/stable',
      acceptedCommit,
    ])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'stale-lock-repair-source',
          repo,
          ref: 'main',
          subdir: 'packs/stale-lock-repair-pack',
          refresh: 'manual',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/stale-lock-repair-source/stable',
            commit: acceptedCommit,
          },
        },
      ],
    })

    await loadMatOSAssets(root)
    const source = (await readMatOSProjectConfig(root)).assetSources![0]!
    const lockRoot = join(matOSAssetSourceCacheRoot(root, source), '.locks')
    const staleLock = join(lockRoot, 'stale-lock-repair-source.lock')
    await mkdir(staleLock, { recursive: true })
    await writeJson(join(staleLock, 'owner.json'), {
      pid: 99999999,
      host: 'stale-host',
      createdAtMs: 0,
      updatedAtMs: 0,
    })
    await chmod(lockRoot, 0o700)
    await chmod(staleLock, 0o700)
    await chmod(join(staleLock, 'owner.json'), 0o600)

    await repairMatOSGitAssetSourceCachePermissions(root, source)

    await expect(stat(staleLock)).rejects.toThrow()
    expect((await stat(lockRoot)).mode & 0o777).toBe(0o777)
  })

  test('configures source-cache git metadata for future shared index writes', async () => {
    const root = await mkAssetTestDir('matos-git-source-shared-index-')
    const repo = await mkAssetTestDir('matos-git-source-shared-index-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'shared-index-pack',
      roleId: 'shared-index-role',
      roleName: 'Shared Index Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/shared-index-source/stable', acceptedCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'shared-index-source',
          repo,
          ref: 'main',
          subdir: 'packs/shared-index-pack',
          refresh: 'manual',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/shared-index-source/stable',
            commit: acceptedCommit,
          },
        },
      ],
    })

    await loadMatOSAssets(root)
    const source = (await readMatOSProjectConfig(root)).assetSources![0]!
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    expect(await gitOutput(checkoutRoot, ['config', '--get', 'core.sharedRepository'])).toBe(
      '0666',
    )

    await rm(join(checkoutRoot, '.git', 'index'), { force: true })
    await git(checkoutRoot, ['reset', '--mixed', 'HEAD'])

    expect((await stat(join(checkoutRoot, '.git', 'index'))).mode & 0o777).toBe(
      0o666,
    )
  })

  test('supports shallow accepted-checkout permission repair without walking tracked payloads', async () => {
    const root = await mkAssetTestDir('matos-git-source-shallow-repair-')
    const repo = await mkAssetTestDir('matos-git-source-shallow-repair-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'shallow-repair-pack',
      roleId: 'shallow-repair-role',
      roleName: 'Shallow Repair Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    const source = {
      type: 'git' as const,
      id: 'shallow-repair-source',
      repo,
      ref: 'main',
      runtimeRef: {
        mode: 'commit' as const,
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    await loadMatOSAssets(root)
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const trackedAsset = join(
      checkoutRoot,
      'packs',
      'shallow-repair-pack',
      'roles',
      'shallow-repair-role',
      'asset.json',
    )
    await chmod(trackedAsset, 0o600)
    await chmod(join(checkoutRoot, '.git', 'config'), 0o600)

    await repairMatOSGitAssetSourceCachePermissions(root, source, {
      full: false,
    })

    expect((await stat(trackedAsset)).mode & 0o777).toBe(0o600)
    expect((await stat(join(checkoutRoot, '.git', 'config'))).mode & 0o222).not.toBe(0)

    // An unchanged accepted checkout takes the same shallow steady-state path.
    // This guards against reintroducing a full tracked-tree chmod on every
    // registry load.
    await loadMatOSAssets(root)
    expect((await stat(trackedAsset)).mode & 0o777).toBe(0o600)
  })

  test('preserves executable tracked files while repairing git source checkout permissions', async () => {
    const root = await mkAssetTestDir('matos-git-source-exec-permissions-')
    const repo = await mkAssetTestDir('matos-git-source-exec-permissions-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'exec-permission-pack',
      roleId: 'exec-permission-role',
      roleName: 'Exec Permission Role',
    })
    const scriptPath = join(
      repo,
      'packs',
      'exec-permission-pack',
      'scripts',
      'run.sh',
    )
    await mkdir(dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, '#!/usr/bin/env sh\necho ok\n', 'utf8')
    await chmod(scriptPath, 0o755)
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add executable asset script')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/exec-permission-source/stable', acceptedCommit])
    const source = {
      type: 'git' as const,
      id: 'exec-permission-source',
      repo,
      ref: 'main',
      subdir: 'packs/exec-permission-pack',
      refresh: 'manual' as const,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/exec-permission-source/stable',
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    await loadMatOSAssets(root)
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const checkoutScript = join(
      checkoutRoot,
      'packs',
      'exec-permission-pack',
      'scripts',
      'run.sh',
    )

    expect((await stat(checkoutScript)).mode & 0o777).toBe(0o755)
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
  })

  test('repairs git source checkout permissions after source commits', async () => {
    const root = await mkAssetTestDir('matos-git-source-commit-perms-')
    const repo = await mkAssetTestDir('matos-git-source-commit-perms-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'commit-permission-pack',
      roleId: 'commit-permission-role',
      roleName: 'Commit Permission Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'initial asset content')
    const source = {
      type: 'git' as const,
      id: 'commit-permission-source',
      repo,
      ref: 'main',
      subdir: 'packs/commit-permission-pack',
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    await loadMatOSAssets(root)
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const rolePath = join(
      checkoutRoot,
      'packs',
      'commit-permission-pack',
      'roles',
      'commit-permission-role',
      'ROLE.md',
    )
    await writeFile(rolePath, '# Commit Permission Role\n\nUpdated.\n', 'utf8')
    const result = await commitMatOSGitAssetSource(root, source, {
      message: 'test source permission repair',
      branch: 'evolution/permission-test',
    })

    expect(result.action).toBe('committed')
    expect(
      (await stat(join(checkoutRoot, '.git', 'refs', 'heads', 'evolution')))
        .mode & 0o777,
    ).toBe(0o777)
    expect(
      (await stat(join(checkoutRoot, '.git', 'refs', 'heads', 'evolution', 'permission-test')))
        .mode & 0o777,
    ).toBe(0o666)
  })

  test('serializes concurrent source commits on one checkout without index.lock races', async () => {
    const root = await mkAssetTestDir('matos-git-source-commit-lock-')
    const repo = await mkAssetTestDir('matos-git-source-commit-lock-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'commit-lock-pack',
      roleId: 'commit-lock-role',
      roleName: 'Commit Lock Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'initial asset content')
    const source = {
      type: 'git' as const,
      id: 'commit-lock-source',
      repo,
      ref: 'main',
      subdir: 'packs/commit-lock-pack',
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })
    await loadMatOSAssets(root)
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const packRoot = join(checkoutRoot, 'packs', 'commit-lock-pack')
    await writeFile(join(packRoot, 'note-a.md'), 'note a\n', 'utf8')
    await writeFile(join(packRoot, 'note-b.md'), 'note b\n', 'utf8')

    // Concurrent evolution acceptance and generated-asset sync previously ran
    // bare git add/commit on the same checkout and failed with index.lock
    // errors that rolled back valid runs. Under the source lock, both calls
    // must complete: one commits everything, the other resolves as a noop.
    const [first, second] = await Promise.all([
      commitMatOSGitAssetSource(root, source, {
        message: 'concurrent commit a',
        branch: 'evolution/concurrent-a',
      }),
      commitMatOSGitAssetSource(root, source, {
        message: 'concurrent commit b',
        branch: 'evolution/concurrent-b',
      }),
    ])

    const actions = [first.action, second.action].sort()
    expect(actions).toEqual(['committed', 'noop'])
    const committed = first.action === 'committed' ? first : second
    expect(committed.changedPaths.sort()).toEqual([
      'packs/commit-lock-pack/note-a.md',
      'packs/commit-lock-pack/note-b.md',
    ])
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
  })

  test('re-enters the source lock for nested operations instead of deadlocking', async () => {
    const root = await mkAssetTestDir('matos-git-source-lock-reentrant-')
    const repo = await mkAssetTestDir('matos-git-source-lock-reentrant-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'reentrant-pack',
      roleId: 'reentrant-role',
      roleName: 'Reentrant Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'initial asset content')
    const source = {
      type: 'git' as const,
      id: 'reentrant-lock-source',
      repo,
      ref: 'main',
      subdir: 'packs/reentrant-pack',
      refresh: 'manual' as const,
    }

    // Acceptance-style flows hold the source lock while calling materialize
    // and commit helpers on the same source; the reentrant lock must let the
    // nested calls proceed within the lock-holding async flow.
    const materializedRoot = await withMatOSGitAssetSourceLock(
      root,
      source,
      async () => {
        const inner = await materializeMatOSAssetSource(root, source)
        const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
        await writeFile(
          join(checkoutRoot, 'packs', 'reentrant-pack', 'nested.md'),
          'nested edit\n',
          'utf8',
        )
        const commit = await commitMatOSGitAssetSource(root, source, {
          message: 'nested commit under held lock',
          branch: 'evolution/reentrant',
        })
        expect(commit.action).toBe('committed')
        return inner
      },
    )

    expect(materializedRoot).toContain('reentrant-pack')
  })

  test('classifies untracked-only residue for tolerated accepted-source cleanup', async () => {
    const repo = await mkAssetTestDir('matos-git-untracked-residue-repo-')
    await createGitRolePack({
      repo,
      packId: 'residue-pack',
      roleId: 'residue-role',
      roleName: 'Residue Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'initial asset content')

    // Cross-UID residue tolerance may keep a checkout usable only when every
    // remaining dirty path is untracked; tracked modifications must still fail.
    await writeFile(join(repo, 'residue-untracked.md'), 'residue\n', 'utf8')
    expect(await matOSGitCheckoutDirtIsUntrackedOnly(repo)).toBe(true)

    await writeFile(
      join(repo, 'packs', 'residue-pack', 'matos.pack.json'),
      '{"changed":true}\n',
      'utf8',
    )
    expect(await matOSGitCheckoutDirtIsUntrackedOnly(repo)).toBe(false)

    expect(
      matOSGitCleanErrorIsPermissionResidue(
        new Error(
          "warning: failed to remove .matos/evolution/audit/direct-editor/run/audit.json: Permission denied",
        ),
      ),
    ).toBe(true)
    expect(
      matOSGitCleanErrorIsPermissionResidue(new Error('fatal: pathspec error')),
    ).toBe(false)
  })

  test('refreshes stale prepared accepted checkout when runtime commit advances', async () => {
    const root = await mkAssetTestDir('matos-git-source-stale-accepted-')
    const repo = await mkAssetTestDir('matos-git-source-stale-accepted-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Old Accepted Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'old accepted asset content')
    const oldAcceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/accepted-source/stable', oldAcceptedCommit])

    const source = {
      type: 'git' as const,
      id: 'accepted-source',
      repo,
      ref: 'main',
      subdir: 'packs/accepted-ref-pack',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/accepted-source/stable',
        commit: oldAcceptedCommit,
      },
    }
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await execFileAsync('git', ['clone', '--no-checkout', repo, checkoutRoot], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await git(checkoutRoot, ['checkout', '--force', '--detach', oldAcceptedCommit])

    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'New Accepted Role',
    })
    await commitAll(repo, 'new accepted asset content')
    const newAcceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      '-f',
      'accepted/accepted-source/stable',
      newAcceptedCommit,
    ])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          ...source,
          runtimeRef: {
            ...source.runtimeRef,
            commit: newAcceptedCommit,
          },
        },
      ],
    })

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:accepted-role')?.name).toBe(
      'New Accepted Role',
    )
    expect(
      await gitOutput(checkoutRoot, [
        'rev-parse',
        'refs/remotes/origin/accepted/accepted-source/stable',
      ]),
    ).toBe(newAcceptedCommit)
  })

  test('refreshes accepted checkout when stale cache has only filemode drift', async () => {
    const root = await mkAssetTestDir('matos-git-source-filemode-drift-')
    const repo = await mkAssetTestDir('matos-git-source-filemode-drift-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'filemode-drift-pack',
      roleId: 'filemode-drift-role',
      roleName: 'Old Filemode Drift Role',
    })
    const oldScript = join(repo, 'packs', 'filemode-drift-pack', 'scripts', 'run.sh')
    await mkdir(dirname(oldScript), { recursive: true })
    await writeFile(oldScript, '#!/usr/bin/env sh\necho old\n', 'utf8')
    await chmod(oldScript, 0o755)
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'old accepted asset content')
    const oldAcceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/filemode-drift-source/stable',
      oldAcceptedCommit,
    ])

    const source = {
      type: 'git' as const,
      id: 'filemode-drift-source',
      repo,
      ref: 'main',
      subdir: 'packs/filemode-drift-pack',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/filemode-drift-source/stable',
        commit: oldAcceptedCommit,
      },
    }
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await execFileAsync('git', ['clone', '--no-checkout', repo, checkoutRoot], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await git(checkoutRoot, ['checkout', '--force', '--detach', oldAcceptedCommit])
    await chmod(
      join(checkoutRoot, 'packs', 'filemode-drift-pack', 'scripts', 'run.sh'),
      0o644,
    )
    expect(await gitOutput(checkoutRoot, ['diff', '--summary', 'HEAD'])).toContain(
      'mode change 100755 => 100644',
    )

    await createGitRolePack({
      repo,
      packId: 'filemode-drift-pack',
      roleId: 'filemode-drift-role',
      roleName: 'New Filemode Drift Role',
    })
    await writeFile(oldScript, '#!/usr/bin/env sh\necho new\n', 'utf8')
    await chmod(oldScript, 0o755)
    await commitAll(repo, 'new accepted asset content')
    const newAcceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      '-f',
      'accepted/filemode-drift-source/stable',
      newAcceptedCommit,
    ])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          ...source,
          runtimeRef: {
            ...source.runtimeRef,
            commit: newAcceptedCommit,
          },
        },
      ],
    })

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:filemode-drift-role')?.name).toBe(
      'New Filemode Drift Role',
    )
    expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
      newAcceptedCommit,
    )
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
  })

  test('uses a prepared accepted checkout inside containers without recloning private Gitea sources', async () => {
    const root = await mkAssetTestDir('matos-git-source-container-accepted-')
    const repo = await mkAssetTestDir('matos-git-source-container-accepted-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-container-pack',
      roleId: 'accepted-container-role',
      roleName: 'Accepted Container Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted container asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/matos-user-assets-alice/stable',
      acceptedCommit,
    ])
    await createGitRolePack({
      repo,
      packId: 'accepted-container-pack',
      roleId: 'accepted-container-role',
      roleName: 'Drifted Main Role',
    })
    await commitAll(repo, 'drift main after acceptance')
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:1/matos-users/alice-assets.git',
      ref: 'main',
      subdir: 'packs/accepted-container-pack',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:alice',
      refresh: 'always' as const,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/matos-user-assets-alice/stable',
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await execFileAsync('git', ['clone', '--no-checkout', repo, checkoutRoot], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await git(checkoutRoot, ['remote', 'set-url', 'origin', source.repo])
    await git(checkoutRoot, ['checkout', '--force', '--detach', acceptedCommit])

    const previousWorkspaceDir = process.env.MATOS_WORKSPACE_DIR
    const previousContainerSourceBaseUrl =
      process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL
    process.env.MATOS_WORKSPACE_DIR = '/workspace/group/shared'
    process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL =
      'http://matos-gitea:3000'
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      expect(registry.resolve('role:accepted-container-role')?.name).toBe(
        'Accepted Container Role',
      )
      expect(await gitOutput(checkoutRoot, ['remote', 'get-url', 'origin'])).toBe(
        source.repo,
      )
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env.MATOS_WORKSPACE_DIR
      } else {
        process.env.MATOS_WORKSPACE_DIR = previousWorkspaceDir
      }
      if (previousContainerSourceBaseUrl === undefined) {
        delete process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL
      } else {
        process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL =
          previousContainerSourceBaseUrl
      }
    }
  })

  test('uses prepared accepted checkouts as read-only runtime sources', async () => {
    const root = await mkAssetTestDir('matos-git-source-readonly-accepted-')
    const repo = await mkAssetTestDir('matos-git-source-readonly-accepted-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-readonly-pack',
      roleId: 'accepted-readonly-role',
      roleName: 'Accepted Readonly Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'accepted readonly asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/matos-user-assets-readonly/stable',
      acceptedCommit,
    ])

    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-readonly',
      repo: 'http://127.0.0.1:1/matos-users/readonly-assets.git',
      ref: 'main',
      subdir: 'packs/accepted-readonly-pack',
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:readonly',
      refresh: 'always' as const,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/matos-user-assets-readonly/stable',
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await execFileAsync('git', ['clone', '--no-checkout', repo, checkoutRoot], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await git(checkoutRoot, ['remote', 'set-url', 'origin', source.repo])
    await git(checkoutRoot, ['checkout', '--force', '--detach', acceptedCommit])

    const gitHeadFile = join(checkoutRoot, '.git', 'HEAD')
    await chmod(gitHeadFile, 0o600)

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    expect(registry.resolve('role:accepted-readonly-role')?.name).toBe(
      'Accepted Readonly Role',
    )
    expect((await stat(gitHeadFile)).mode & 0o777).toBe(0o666)
  })

  test('reports missing prepared accepted checkout before cloning container Gitea URLs', async () => {
    const root = await mkAssetTestDir('matos-git-source-container-missing-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-user-assets-bob',
          repo: 'http://127.0.0.1:1/matos-users/bob-assets.git',
          ref: 'main',
          provider: 'gitea',
          scope: 'user',
          scopeRef: 'user:bob',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/matos-user-assets-bob/stable',
            commit: '0123456789abcdef0123456789abcdef01234567',
          },
        },
      ],
    })

    const previousWorkspaceDir = process.env.MATOS_WORKSPACE_DIR
    const previousContainerSourceBaseUrl =
      process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL
    process.env.MATOS_WORKSPACE_DIR = '/workspace/group/shared'
    process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL =
      'http://matos-gitea:3000'
    try {
      await expect(loadMatOSAssets(root)).rejects.toThrow(
        'Run gateway/workspace asset preparation before starting MatOS',
      )
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env.MATOS_WORKSPACE_DIR
      } else {
        process.env.MATOS_WORKSPACE_DIR = previousWorkspaceDir
      }
      if (previousContainerSourceBaseUrl === undefined) {
        delete process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL
      } else {
        process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL =
          previousContainerSourceBaseUrl
      }
    }
  })

  test('reports missing prepared accepted checkout before cloning host Gitea URLs without token', async () => {
    const root = await mkAssetTestDir('matos-git-source-host-missing-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: 'http://127.0.0.1:1/matos-core/assets.git',
          ref: 'main',
          provider: 'gitea',
          scope: 'core',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/matos-core-assets/stable',
            commit: '0123456789abcdef0123456789abcdef01234567',
          },
        },
      ],
    })

    const previousWorkspaceDir = process.env.MATOS_WORKSPACE_DIR
    const previousToken = process.env.MATOS_GITEA_TOKEN
    const previousGatewayToken = process.env.MATOS_GATEWAY_GITEA_TOKEN
    delete process.env.MATOS_WORKSPACE_DIR
    delete process.env.MATOS_GITEA_TOKEN
    delete process.env.MATOS_GATEWAY_GITEA_TOKEN
    try {
      await expect(loadMatOSAssets(root)).rejects.toThrow(
        'Run gateway/workspace asset preparation before starting MatOS',
      )
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env.MATOS_WORKSPACE_DIR
      } else {
        process.env.MATOS_WORKSPACE_DIR = previousWorkspaceDir
      }
      if (previousToken === undefined) {
        delete process.env.MATOS_GITEA_TOKEN
      } else {
        process.env.MATOS_GITEA_TOKEN = previousToken
      }
      if (previousGatewayToken === undefined) {
        delete process.env.MATOS_GATEWAY_GITEA_TOKEN
      } else {
        process.env.MATOS_GATEWAY_GITEA_TOKEN = previousGatewayToken
      }
    }
  })

  test('lets scoped git sources explicitly overlay shared assets with the same canonical key', async () => {
    const root = await mkAssetTestDir('matos-git-source-overlay-')
    const previousRepo = await mkAssetTestDir('matos-git-source-previous-')
    const sharedRepo = await mkAssetTestDir('matos-git-source-shared-')
    const userRepo = await mkAssetTestDir('matos-git-source-user-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo: previousRepo,
      packId: 'matos-core',
      roleId: 'compute',
      roleName: 'Previous Compute',
    })
    await createGitRolePack({
      repo: sharedRepo,
      packId: 'matos-core',
      roleId: 'compute',
      roleName: 'Shared Compute',
    })
    await createGitRolePack({
      repo: userRepo,
      packId: 'alice',
      roleId: 'compute',
      roleName: 'Alice Compute',
      overlayOf: 'role:compute@1.0.0',
    })
    await git(previousRepo, ['init', '-b', 'main'])
    await commitAll(previousRepo, 'add previous role')
    await git(sharedRepo, ['init', '-b', 'main'])
    await commitAll(sharedRepo, 'add shared role')
    await git(userRepo, ['init', '-b', 'main'])
    await commitAll(userRepo, 'add user role')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'previous-shared-assets',
          repo: previousRepo,
          ref: 'main',
          scope: 'shared',
          includeInRuntime: false,
        },
        {
          type: 'git',
          id: 'shared-assets',
          repo: sharedRepo,
          ref: 'main',
          scope: 'shared',
        },
        {
          type: 'git',
          id: 'alice-assets',
          repo: userRepo,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:alice',
        },
      ],
    })

    const assets = await loadMatOSAssets(root)
    const validation = await validateMatOSAssets(assets)
    const registry = buildMatOSAssetRegistry(assets)

    expect(validation.ok).toBe(true)
    expect(registry.resolve('role:compute@1.0.0')?.name).toBe('Alice Compute')
    expect(registry.resolve('role:compute')?.name).toBe('Alice Compute')
    expect(assets.map(asset => asset.name)).not.toContain('Previous Compute')

    const legacyAlias = join(root, '.matos', 'source-cache', 'git', 'alice-assets')
    expect((await lstat(legacyAlias)).isSymbolicLink()).toBe(true)
    expect(await readlink(legacyAlias)).toBe(
      '../scopes/users/alice/git/alice-assets',
    )
  })

  test('rejects git asset source subdirs outside the checkout', async () => {
    const root = await mkAssetTestDir('matos-git-source-project-')
    const repo = await mkAssetTestDir('matos-git-source-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(repo, 'asset.json'), {
      id: 'root-role',
      type: 'role',
      name: 'Root Role',
      version: '1.0.0',
      path: '.',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add root asset')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'escaping-source',
          repo,
          ref: 'main',
          subdir: '../outside',
        },
      ],
    })

    await expect(loadMatOSAssets(root)).rejects.toThrow(
      'subdir escapes checkout root',
    )
  })

  test('refreshes git branch sources from origin when refresh is always', async () => {
    const root = await mkAssetTestDir('matos-git-source-project-')
    const repo = await mkAssetTestDir('matos-git-source-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'refresh-pack',
      roleId: 'refresh-role',
      roleName: 'Before Refresh',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add first version')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'refresh-pack',
          repo,
          ref: 'main',
          subdir: 'packs/refresh-pack',
          refresh: 'always',
        },
      ],
    })

    const firstRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(firstRegistry.resolve('role:refresh-role')?.name).toBe(
      'Before Refresh',
    )

    await writeJson(
      join(repo, 'packs', 'refresh-pack', 'roles', 'refresh-role', 'asset.json'),
      {
        id: 'refresh-role',
        type: 'role',
        name: 'After Refresh',
        version: '1.0.0',
        path: '.',
      },
    )
    await commitAll(repo, 'update role name')

    const secondRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(secondRegistry.resolve('role:refresh-role')?.name).toBe(
      'After Refresh',
    )
  })

  test('refreshes only the configured branch instead of fetching unrelated refs', async () => {
    const root = await mkAssetTestDir('matos-git-targeted-refresh-project-')
    const repo = await mkAssetTestDir('matos-git-targeted-refresh-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'targeted-refresh-pack',
      roleId: 'targeted-refresh-role',
      roleName: 'Initial',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'initial main')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'targeted-refresh',
          repo,
          ref: 'main',
          subdir: 'packs/targeted-refresh-pack',
          refresh: 'always',
        },
      ],
    })

    await loadMatOSAssets(root)
    const source = (await readMatOSProjectConfig(root)).assetSources![0]!
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)

    await git(repo, ['checkout', '-b', 'large-unrelated-history'])
    await writeFile(join(repo, 'unrelated.txt'), 'must not be fetched\n', 'utf8')
    await commitAll(repo, 'unrelated branch update')
    await git(repo, ['checkout', 'main'])
    await writeJson(
      join(
        repo,
        'packs',
        'targeted-refresh-pack',
        'roles',
        'targeted-refresh-role',
        'asset.json',
      ),
      {
        id: 'targeted-refresh-role',
        type: 'role',
        name: 'Updated Main',
        version: '1.0.0',
        path: '.',
      },
    )
    await commitAll(repo, 'main branch update')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:targeted-refresh-role')?.name).toBe(
      'Updated Main',
    )
    await expect(
      gitOutput(checkoutRoot, [
        'rev-parse',
        '--verify',
        'refs/remotes/origin/large-unrelated-history',
      ]),
    ).rejects.toThrow()
  })

  test('restores dirty accepted git source checkouts during runtime asset loads', async () => {
    const root = await mkAssetTestDir('matos-git-source-dirty-accepted-project-')
    const repo = await mkAssetTestDir('matos-git-source-dirty-accepted-repo-')
    const sourceId = 'dirty-accepted-pack'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: sourceId,
      roleId: 'dirty-accepted-role',
      roleName: 'Before Dirty Edit',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add accepted source')
    const seedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', `accepted/${sourceId}/stable`, seedCommit])
    const source = {
      type: 'git' as const,
      id: sourceId,
      repo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: `accepted/${sourceId}/stable`,
        commit: seedCommit,
      },
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const firstRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(firstRegistry.resolve('role:dirty-accepted-role')?.name).toBe(
      'Before Dirty Edit',
    )

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const roleManifest = join(
      checkoutRoot,
      'packs',
      sourceId,
      'roles',
      'dirty-accepted-role',
      'asset.json',
    )
    const dirtyManifest = JSON.parse(await readFile(roleManifest, 'utf8'))
    dirtyManifest.name = 'Dirty Direct Editor Edit'
    await writeJson(roleManifest, dirtyManifest)

    const secondRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(secondRegistry.resolve('role:dirty-accepted-role')?.name).toBe(
      'Before Dirty Edit',
    )
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
    expect(await readFile(roleManifest, 'utf8')).toContain('Before Dirty Edit')
  })

  test('recovers stale index locks in prepared accepted Gitea checkouts', async () => {
    const root = await mkAssetTestDir('matos-git-source-prepared-lock-project-')
    const repo = await mkAssetTestDir('matos-git-source-prepared-lock-repo-')
    const sourceId = 'prepared-accepted-lock-pack'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: sourceId,
      roleId: 'prepared-lock-role',
      roleName: 'Before Accepted Advance',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add prepared accepted source')
    const firstCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await writeJson(
      join(repo, 'packs', sourceId, 'roles', 'prepared-lock-role', 'asset.json'),
      {
        id: 'prepared-lock-role',
        type: 'role',
        name: 'After Accepted Advance',
        version: '1.0.0',
        path: '.',
      },
    )
    await commitAll(repo, 'advance accepted source')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', `accepted/${sourceId}/stable`, acceptedCommit])
    const source = {
      type: 'git' as const,
      id: sourceId,
      provider: 'gitea' as const,
      repo: 'http://127.0.0.1:1/matos-users/bob-assets.git',
      ref: 'main',
      subdir: `packs/${sourceId}`,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: `accepted/${sourceId}/stable`,
        commit: acceptedCommit,
      },
      gitea: {
        owner: 'matos-users',
        repo: 'bob-assets',
      },
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await git(dirname(checkoutRoot), ['clone', repo, checkoutRoot])
    await git(checkoutRoot, ['checkout', '--force', '--detach', firstCommit])
    await writeFile(join(checkoutRoot, '.git', 'index.lock'), 'stale\n', 'utf8')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:prepared-lock-role')?.name).toBe(
      'After Accepted Advance',
    )
    expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
      acceptedCommit,
    )
  })

  test('repairs unreadable prepared accepted Gitea checkout metadata before reporting missing preparation', async () => {
    const root = await mkAssetTestDir('matos-git-source-prepared-metadata-project-')
    const repo = await mkAssetTestDir('matos-git-source-prepared-metadata-repo-')
    const sourceId = 'prepared-accepted-metadata-pack'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: sourceId,
      roleId: 'prepared-metadata-role',
      roleName: 'Prepared Metadata Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add prepared metadata accepted source')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', `accepted/${sourceId}/stable`, acceptedCommit])
    const source = {
      type: 'git' as const,
      id: sourceId,
      provider: 'gitea' as const,
      repo: 'http://127.0.0.1:1/matos-users/alice-assets.git',
      ref: 'main',
      subdir: `packs/${sourceId}`,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: `accepted/${sourceId}/stable`,
        commit: acceptedCommit,
      },
      gitea: {
        owner: 'matos-users',
        repo: 'alice-assets',
      },
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await git(dirname(checkoutRoot), ['clone', repo, checkoutRoot])
    await git(checkoutRoot, ['checkout', '--force', '--detach', acceptedCommit])
    await chmod(join(checkoutRoot, '.git', 'HEAD'), 0o000)
    await chmod(join(checkoutRoot, '.git', 'index'), 0o000)

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(registry.resolve('role:prepared-metadata-role')?.name).toBe(
      'Prepared Metadata Role',
    )
    expect((await stat(join(checkoutRoot, '.git', 'HEAD'))).mode & 0o777).toBe(
      0o666,
    )
    expect((await stat(join(checkoutRoot, '.git', 'index'))).mode & 0o777).toBe(
      0o666,
    )
  })

  test('serves healthy prepared accepted checkouts without mutating git state outside the source lock', async () => {
    // Regression: the pre-lock prepared-checkout fast path used to remove
    // .git metadata locks, rewrite config (core.sharedRepository), and fetch
    // WITHOUT holding the per-source lock. That raced concurrent locked
    // acceptance/preparation on the same source cache — the unlocked-writer
    // class that historically clobbered [remote "origin"]. A healthy prepared
    // checkout must be served read-only: a live git lock owned by another
    // process and the config bytes must survive an asset load untouched.
    const root = await mkAssetTestDir('matos-git-source-prepared-readonly-project-')
    const repo = await mkAssetTestDir('matos-git-source-prepared-readonly-repo-')
    const sourceId = 'prepared-accepted-readonly-guard-pack'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: sourceId,
      roleId: 'prepared-readonly-guard-role',
      roleName: 'Prepared Readonly Guard Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await writeFile(join(repo, 'README.md'), 'prepared checkout read permission guard\n', 'utf8')
    await commitAll(repo, 'add prepared readonly guard source')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', `accepted/${sourceId}/stable`, acceptedCommit])
    const source = {
      type: 'git' as const,
      id: sourceId,
      provider: 'gitea' as const,
      repo: 'http://127.0.0.1:1/matos-users/readonly-guard-assets.git',
      ref: 'main',
      subdir: `packs/${sourceId}`,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: `accepted/${sourceId}/stable`,
        commit: acceptedCommit,
      },
      gitea: {
        owner: 'matos-users',
        repo: 'readonly-guard-assets',
      },
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await git(dirname(checkoutRoot), ['clone', repo, checkoutRoot])
    await git(checkoutRoot, ['checkout', '--force', '--detach', acceptedCommit])
    // Simulate a root-written checkout whose tracked files and directories are
    // too restrictive for the workspace user. The healthy fast path must
    // repair these permissions before the editor copies the source tree.
    await chmod(join(checkoutRoot, 'README.md'), 0o600)
    await chmod(checkoutRoot, 0o700)

    // Simulate a concurrent locked preparation mid-flight on this checkout:
    // its live index.lock and the current config bytes must not be touched by
    // an unrelated load taking the prepared fast path.
    const liveIndexLock = join(checkoutRoot, '.git', 'index.lock')
    await writeFile(liveIndexLock, 'held-by-concurrent-preparation\n', 'utf8')
    const configPath = join(checkoutRoot, '.git', 'config')
    const configBefore = await readFile(configPath, 'utf8')

    const previousEnv = {
      MATOS_GITEA_TOKEN: process.env.MATOS_GITEA_TOKEN,
      MATOS_GITEA_TOKEN_FILE: process.env.MATOS_GITEA_TOKEN_FILE,
      MATOS_GATEWAY_GITEA_TOKEN: process.env.MATOS_GATEWAY_GITEA_TOKEN,
      MATOS_GATEWAY_GITEA_TOKEN_FILE:
        process.env.MATOS_GATEWAY_GITEA_TOKEN_FILE,
      MATOS_GITEA_DISABLE_OPERATOR_ENV:
        process.env.MATOS_GITEA_DISABLE_OPERATOR_ENV,
    }
    delete process.env.MATOS_GITEA_TOKEN
    delete process.env.MATOS_GITEA_TOKEN_FILE
    delete process.env.MATOS_GATEWAY_GITEA_TOKEN
    delete process.env.MATOS_GATEWAY_GITEA_TOKEN_FILE
    process.env.MATOS_GITEA_DISABLE_OPERATOR_ENV = '1'
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      expect(registry.resolve('role:prepared-readonly-guard-role')?.name).toBe(
        'Prepared Readonly Guard Role',
      )
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }

    await expect(readFile(liveIndexLock, 'utf8')).resolves.toBe(
      'held-by-concurrent-preparation\n',
    )
    await expect(readFile(configPath, 'utf8')).resolves.toBe(configBefore)
    expect((await stat(join(checkoutRoot, 'README.md'))).mode & 0o777).toBe(0o644)
    expect((await stat(checkoutRoot)).mode & 0o777).toBe(0o755)
  })

  test('resets dirty accepted source caches when accepted commit advances', async () => {
    const root = await mkAssetTestDir('matos-git-source-dirty-accepted-advance-project-')
    const repo = await mkAssetTestDir('matos-git-source-dirty-accepted-advance-repo-')
    const sourceId = 'dirty-accepted-advance-pack'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: sourceId,
      roleId: 'dirty-advance-role',
      roleName: 'Before Accepted Advance',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add first accepted source')
    const firstCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    const source = {
      type: 'git' as const,
      id: sourceId,
      repo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: `accepted/${sourceId}/stable`,
        commit: firstCommit,
      },
      refresh: 'manual' as const,
    }
    await git(repo, ['branch', `accepted/${sourceId}/stable`, firstCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const firstRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(firstRegistry.resolve('role:dirty-advance-role')?.name).toBe(
      'Before Accepted Advance',
    )

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const roleManifest = join(
      checkoutRoot,
      'packs',
      sourceId,
      'roles',
      'dirty-advance-role',
      'asset.json',
    )
    const dirtyManifest = JSON.parse(await readFile(roleManifest, 'utf8'))
    dirtyManifest.name = 'Dirty Cache Edit'
    await writeJson(roleManifest, dirtyManifest)

    await writeJson(
      join(repo, 'packs', sourceId, 'roles', 'dirty-advance-role', 'asset.json'),
      {
        id: 'dirty-advance-role',
        type: 'role',
        name: 'After Accepted Advance',
        version: '1.0.0',
        path: '.',
      },
    )
    await commitAll(repo, 'advance accepted source')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', '-f', `accepted/${sourceId}/stable`, acceptedCommit])
    source.runtimeRef.commit = acceptedCommit
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const secondRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(secondRegistry.resolve('role:dirty-advance-role')?.name).toBe(
      'After Accepted Advance',
    )
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
    expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
      acceptedCommit,
    )
  })

  test('force resets dirty source caches for Gitea acceptance materialization', async () => {
    const root = await mkAssetTestDir('matos-git-source-force-reset-project-')
    const repo = await mkAssetTestDir('matos-git-source-force-reset-repo-')
    const sourceId = 'force-reset-pack'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: sourceId,
      roleId: 'force-reset-role',
      roleName: 'Before Force Reset',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add force reset source')
    const source = {
      type: 'git' as const,
      id: sourceId,
      repo,
      ref: 'main',
      subdir: `packs/${sourceId}`,
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    await materializeMatOSAssetSource(root, source)
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const roleManifest = join(
      checkoutRoot,
      'packs',
      sourceId,
      'roles',
      'force-reset-role',
      'asset.json',
    )
    const dirtyManifest = JSON.parse(await readFile(roleManifest, 'utf8'))
    dirtyManifest.name = 'Dirty Cache Edit'
    await writeJson(roleManifest, dirtyManifest)

    await writeJson(
      join(repo, 'packs', sourceId, 'roles', 'force-reset-role', 'asset.json'),
      {
        id: 'force-reset-role',
        type: 'role',
        name: 'After Force Reset',
        version: '1.0.0',
        path: '.',
      },
    )
    await commitAll(repo, 'advance force reset source')
    const expectedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])

    await materializeMatOSAssetSource(root, source, {
      refresh: 'always',
      forceResetDirty: true,
    })

    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
    expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
      expectedCommit,
    )
    expect(await readFile(roleManifest, 'utf8')).toContain('After Force Reset')
  })

  test('hydrates no-checkout accepted-ref checkouts even when HEAD already matches runtime commit', async () => {
    const root = await mkAssetTestDir('matos-git-source-no-checkout-accepted-')
    const repo = await mkAssetTestDir('matos-git-source-no-checkout-accepted-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accepted-ref-pack',
      roleId: 'accepted-role',
      roleName: 'Accepted Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed accepted asset content')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/accepted-source/stable', acceptedCommit])
    const source = {
      type: 'git' as const,
      id: 'accepted-source',
      repo,
      ref: 'main',
      subdir: 'packs/accepted-ref-pack',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/accepted-source/stable',
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await execFileAsync('git', ['clone', '--no-checkout', repo, checkoutRoot], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })

    const materialized = await materializeMatOSAssetSource(root, source, {
      refresh: 'manual',
    })

    expect(materialized).toBe(join(checkoutRoot, 'packs', 'accepted-ref-pack'))
    expect(await gitOutput(checkoutRoot, ['status', '--porcelain'])).toBe('')
    await expect(
      readFile(
        join(
          checkoutRoot,
          'packs',
          'accepted-ref-pack',
          'roles',
          'accepted-role',
          'asset.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('Accepted Role')
  })

  test('recovers stale managed git index locks in source cache', async () => {
    const root = await mkAssetTestDir('matos-git-source-lock-project-')
    const repo = await mkAssetTestDir('matos-git-source-lock-repo-')
    const source = {
      type: 'git' as const,
      id: 'lock-pack',
      repo,
      ref: 'main',
      subdir: 'packs/lock-pack',
      refresh: 'always' as const,
    }
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'lock-pack',
      roleId: 'lock-role',
      roleName: 'Lock Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add lock role')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    expect(
      buildMatOSAssetRegistry(await loadMatOSAssets(root)).resolve(
        'role:lock-role',
      )?.name,
    ).toBe('Lock Role')

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    await writeFile(join(checkoutRoot, '.git', 'index.lock'), 'stale\n', 'utf8')

    expect(
      buildMatOSAssetRegistry(await loadMatOSAssets(root)).resolve(
        'role:lock-role',
      )?.name,
    ).toBe('Lock Role')
  })

  test('retries recoverable checkout index write failures in source cache', async () => {
    const root = await mkAssetTestDir('matos-git-source-checkout-retry-project-')
    const repo = await mkAssetTestDir('matos-git-source-checkout-retry-repo-')
    const source = {
      type: 'git' as const,
      id: 'checkout-retry-pack',
      repo,
      ref: 'main',
      subdir: 'packs/checkout-retry-pack',
      refresh: 'always' as const,
    }
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'checkout-retry-pack',
      roleId: 'checkout-retry-role',
      roleName: 'Checkout Retry Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add checkout retry role')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const fakeBin = await mkAssetTestDir('matos-fake-git-')
    const realGit = (await execFileAsync('command', ['-v', 'git'], {
      shell: true,
    })).stdout.toString().trim()
    const marker = join(fakeBin, 'failed-once')
    await writeFile(
      join(fakeBin, 'git'),
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" checkout --force --detach "*)',
        '    if [ -n "$MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER" ] && [ ! -f "$MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER" ]; then',
        '      touch "$MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER"',
        '      echo "fatal: unable to write new index file" >&2',
        '      exit 128',
        '    fi',
        '    ;;',
        'esac',
        'exec "$MATOS_TEST_REAL_GIT" "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )

    const previousPath = process.env.PATH
    const previousRealGit = process.env.MATOS_TEST_REAL_GIT
    const previousMarker = process.env.MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    process.env.MATOS_TEST_REAL_GIT = realGit
    process.env.MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER = marker
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      expect(registry.resolve('role:checkout-retry-role')?.name).toBe(
        'Checkout Retry Role',
      )
      expect(Boolean(await stat(marker).catch(() => undefined))).toBe(true)
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
      if (previousRealGit === undefined) {
        delete process.env.MATOS_TEST_REAL_GIT
      } else {
        process.env.MATOS_TEST_REAL_GIT = previousRealGit
      }
      if (previousMarker === undefined) {
        delete process.env.MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER
      } else {
        process.env.MATOS_TEST_GIT_FAIL_CHECKOUT_MARKER = previousMarker
      }
    }
  })

  test('retries recoverable git clean permission failures in source cache', async () => {
    const root = await mkAssetTestDir('matos-git-source-clean-retry-project-')
    const repo = await mkAssetTestDir('matos-git-source-clean-retry-repo-')
    const source = {
      type: 'git' as const,
      id: 'clean-retry-pack',
      repo,
      ref: 'main',
      subdir: 'packs/clean-retry-pack',
      refresh: 'always' as const,
    }
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'clean-retry-pack',
      roleId: 'clean-retry-role',
      roleName: 'Clean Retry Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add clean retry role')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    const fakeBin = await mkAssetTestDir('matos-fake-git-clean-')
    const realGit = (await execFileAsync('command', ['-v', 'git'], {
      shell: true,
    })).stdout.toString().trim()
    const marker = join(fakeBin, 'clean-failed-once')
    await writeFile(
      join(fakeBin, 'git'),
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" clean -fd "*)',
        '    if [ -n "$MATOS_TEST_GIT_FAIL_CLEAN_MARKER" ] && [ ! -f "$MATOS_TEST_GIT_FAIL_CLEAN_MARKER" ]; then',
        '      touch "$MATOS_TEST_GIT_FAIL_CLEAN_MARKER"',
        '      echo "warning: failed to remove experience/example/asset.json: Permission denied" >&2',
        '      exit 1',
        '    fi',
        '    ;;',
        'esac',
        'exec "$MATOS_TEST_REAL_GIT" "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )

    const previousPath = process.env.PATH
    const previousRealGit = process.env.MATOS_TEST_REAL_GIT
    const previousMarker = process.env.MATOS_TEST_GIT_FAIL_CLEAN_MARKER
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    process.env.MATOS_TEST_REAL_GIT = realGit
    process.env.MATOS_TEST_GIT_FAIL_CLEAN_MARKER = marker
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      expect(registry.resolve('role:clean-retry-role')?.name).toBe(
        'Clean Retry Role',
      )
      expect(Boolean(await stat(marker).catch(() => undefined))).toBe(true)
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
      if (previousRealGit === undefined) {
        delete process.env.MATOS_TEST_REAL_GIT
      } else {
        process.env.MATOS_TEST_REAL_GIT = previousRealGit
      }
      if (previousMarker === undefined) {
        delete process.env.MATOS_TEST_GIT_FAIL_CLEAN_MARKER
      } else {
        process.env.MATOS_TEST_GIT_FAIL_CLEAN_MARKER = previousMarker
      }
    }
  })

  test('serializes concurrent git source materialization', async () => {
    const root = await mkAssetTestDir('matos-git-source-concurrent-project-')
    const repo = await mkAssetTestDir('matos-git-source-concurrent-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'concurrent-pack',
      roleId: 'concurrent-role',
      roleName: 'Concurrent Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add concurrent role')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'concurrent-pack',
          repo,
          ref: 'main',
          subdir: 'packs/concurrent-pack',
          refresh: 'always',
        },
      ],
    })

    const registries = await Promise.all(
      Array.from({ length: 8 }, async () =>
        buildMatOSAssetRegistry(await loadMatOSAssets(root)),
      ),
    )

    for (const registry of registries) {
      expect(registry.resolve('role:concurrent-role')?.name).toBe(
        'Concurrent Role',
      )
    }
  })

  test('does not reclone accepted Gitea sources when only runtime transport changes', async () => {
    const root = await mkAssetTestDir('matos-git-source-transport-')
    const repo = await mkAssetTestDir('matos-git-source-transport-repo-')
    const fileSourceRoot = await mkAssetTestDir('matos-git-source-transport-files-')
    const sourceId = 'matos-user-assets-alice'
    const httpRepo = 'http://matos-gitea:3000/matos-users/alice-assets.git'
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'transport-pack',
      roleId: 'transport-role',
      roleName: 'Transport Role Old',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add old transport role')
    const oldCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    const checkoutSource = {
      type: 'git' as const,
      id: sourceId,
      repo: httpRepo,
      scope: 'user' as const,
      scopeRef: 'user:alice',
    }
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, checkoutSource)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await execFileAsync('git', ['clone', '--no-checkout', repo, checkoutRoot], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await git(checkoutRoot, ['remote', 'set-url', 'origin', httpRepo])
    await git(checkoutRoot, ['checkout', '--force', '--detach', oldCommit])
    const checkoutInodeBefore = (await lstat(checkoutRoot)).ino

    await writeJson(
      join(repo, 'packs', 'transport-pack', 'roles', 'transport-role', 'asset.json'),
      {
        id: 'transport-role',
        type: 'role',
        name: 'Transport Role New',
        version: '1.0.0',
        path: '.',
      },
    )
    await commitAll(repo, 'advance accepted transport role')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', `accepted/${sourceId}/stable`, acceptedCommit])

    const source = {
      type: 'git' as const,
      id: sourceId,
      repo: httpRepo,
      ref: 'main',
      subdir: 'packs/transport-pack',
      refresh: 'manual' as const,
      provider: 'gitea' as const,
      scope: 'user' as const,
      scopeRef: 'user:alice',
      gitea: {
        owner: 'matos-users',
        repo: 'alice-assets',
        cloneUrl: httpRepo,
      },
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: `accepted/${sourceId}/stable`,
        commit: acceptedCommit,
      },
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [source],
    })

    await execFileAsync(
      'git',
      ['clone', '--bare', repo, join(fileSourceRoot, `${sourceId}.git`)],
      {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    )

    const previousWorkspaceDir = process.env.MATOS_WORKSPACE_DIR
    const previousFileSourceRoot = process.env.MATOS_GITEA_FILE_SOURCE_ROOT
    process.env.MATOS_WORKSPACE_DIR = root
    process.env.MATOS_GITEA_FILE_SOURCE_ROOT = fileSourceRoot
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      expect(registry.resolve('role:transport-role')?.name).toBe(
        'Transport Role New',
      )
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env.MATOS_WORKSPACE_DIR
      } else {
        process.env.MATOS_WORKSPACE_DIR = previousWorkspaceDir
      }
      if (previousFileSourceRoot === undefined) {
        delete process.env.MATOS_GITEA_FILE_SOURCE_ROOT
      } else {
        process.env.MATOS_GITEA_FILE_SOURCE_ROOT = previousFileSourceRoot
      }
    }

    expect((await lstat(checkoutRoot)).ino).toBe(checkoutInodeBefore)
    expect(await gitOutput(checkoutRoot, ['remote', 'get-url', 'origin'])).toBe(
      join(fileSourceRoot, `${sourceId}.git`),
    )
    expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
      acceptedCommit,
    )
  })

  test('reclones git asset sources when the same id points to a different repo', async () => {
    const root = await mkAssetTestDir('matos-git-source-project-')
    const firstRepo = await mkAssetTestDir('matos-git-source-repo-a-')
    const secondRepo = await mkAssetTestDir('matos-git-source-repo-b-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo: firstRepo,
      packId: 'switch-pack',
      roleId: 'first-role',
      roleName: 'First Repo Role',
    })
    await createGitRolePack({
      repo: secondRepo,
      packId: 'switch-pack',
      roleId: 'second-role',
      roleName: 'Second Repo Role',
    })
    await git(firstRepo, ['init', '-b', 'main'])
    await commitAll(firstRepo, 'add first repo assets')
    await git(secondRepo, ['init', '-b', 'main'])
    await commitAll(secondRepo, 'add second repo assets')

    const configPath = join(root, '.matos', 'matos.json')
    await writeJson(configPath, {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'switch-pack',
          repo: firstRepo,
          ref: 'main',
          subdir: 'packs/switch-pack',
        },
      ],
    })
    const firstRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(firstRegistry.resolve('role:first-role')?.name).toBe(
      'First Repo Role',
    )

    await writeJson(configPath, {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'switch-pack',
          repo: secondRepo,
          ref: 'main',
          subdir: 'packs/switch-pack',
        },
      ],
    })

    const secondRegistry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    expect(secondRegistry.resolve('role:first-role')).toBeUndefined()
    expect(secondRegistry.resolve('role:second-role')?.name).toBe(
      'Second Repo Role',
    )
  })

  test('rejects git asset source subdirs that do not exist', async () => {
    const root = await mkAssetTestDir('matos-git-source-project-')
    const repo = await mkAssetTestDir('matos-git-source-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'existing-pack',
      roleId: 'existing-role',
      roleName: 'Existing Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'add existing assets')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'missing-subdir',
          repo,
          ref: 'main',
          subdir: 'packs/missing-pack',
        },
      ],
    })

    await expect(loadMatOSAssets(root)).rejects.toThrow(
      'subdir does not exist',
    )
  })

  test('re-aligns container-alias origin remotes for host-side Gitea pushes', async () => {
    // Regression: a user workspace prepared the source-cache checkout inside
    // the container, leaving origin at http://matos-gitea:3000/... . The
    // host-side gateway acceptance then failed `git push origin ...` with
    // "Could not resolve host: matos-gitea".
    const root = await mkAssetTestDir('matos-gitea-remote-sync-root-')
    const checkoutRoot = await mkAssetTestDir('matos-gitea-remote-sync-checkout-')
    await git(checkoutRoot, ['init', '-b', 'main'])
    await git(checkoutRoot, [
      'remote',
      'add',
      'origin',
      'http://matos-gitea:3000/matos-users/alice-assets.git',
    ])
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:3001/matos-users/alice-assets.git',
      ref: 'main',
      scope: 'user' as const,
      provider: 'gitea' as const,
    }

    await syncMatOSGitAssetSourceOriginRemote({
      cwd: root,
      source,
      checkoutRoot,
    })

    expect(await gitOutput(checkoutRoot, ['remote', 'get-url', 'origin'])).toBe(
      'http://127.0.0.1:3001/matos-users/alice-assets.git',
    )
  })

  test('restores a clobbered origin remote and fetch refspec for gitea sources', async () => {
    // Regression: concurrent unlocked `git remote set-url` / `git config`
    // writers raced on one checkout's .git/config and stripped the whole
    // [remote "origin"] section. Every later preparation cycle then failed
    // with "No such remote 'origin'" until an operator repaired the file.
    const root = await mkAssetTestDir('matos-gitea-remote-heal-root-')
    const checkoutRoot = await mkAssetTestDir('matos-gitea-remote-heal-checkout-')
    await git(checkoutRoot, ['init', '-b', 'main'])
    await git(checkoutRoot, ['config', 'core.sharedRepository', '0666'])
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:3001/matos-users/alice-assets.git',
      ref: 'main',
      scope: 'user' as const,
      provider: 'gitea' as const,
    }

    await syncMatOSGitAssetSourceOriginRemote({
      cwd: root,
      source,
      checkoutRoot,
    })

    expect(await gitOutput(checkoutRoot, ['remote', 'get-url', 'origin'])).toBe(
      'http://127.0.0.1:3001/matos-users/alice-assets.git',
    )
    expect(
      await gitOutput(checkoutRoot, [
        'config',
        '--get-all',
        'remote.origin.fetch',
      ]),
    ).toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('keeps origin remotes for different Gitea repositories untouched', async () => {
    const root = await mkAssetTestDir('matos-gitea-remote-keep-root-')
    const checkoutRoot = await mkAssetTestDir('matos-gitea-remote-keep-checkout-')
    await git(checkoutRoot, ['init', '-b', 'main'])
    await git(checkoutRoot, [
      'remote',
      'add',
      'origin',
      'http://matos-gitea:3000/matos-users/bob-assets.git',
    ])
    const source = {
      type: 'git' as const,
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:3001/matos-users/alice-assets.git',
      ref: 'main',
      scope: 'user' as const,
      provider: 'gitea' as const,
    }

    await syncMatOSGitAssetSourceOriginRemote({
      cwd: root,
      source,
      checkoutRoot,
    })

    expect(await gitOutput(checkoutRoot, ['remote', 'get-url', 'origin'])).toBe(
      'http://matos-gitea:3000/matos-users/bob-assets.git',
    )
  })

  test('marks local bare-repository remotes as git safe.directory for fetches', () => {
    // Regression: gateway workspace preparation substitutes the Gitea data-dir
    // bare repo path for the HTTP clone URL, and `git fetch` from a root-owned
    // process against the gitea-owned bare repo failed with "detected dubious
    // ownership" because only the checkout was marked safe.
    const args = gitSafeDirectoryArgs('/tmp/checkout', [
      '/srv/gitea/data/git/repositories/matos-core/assets.git',
      'file:///srv/gitea/data/git/repositories/matos-global/assets.git',
      'http://127.0.0.1:3001/matos-core/assets.git',
      '',
    ])
    expect(args).toContain('safe.directory=/tmp/checkout')
    expect(args).toContain(
      'safe.directory=/srv/gitea/data/git/repositories/matos-core/assets.git',
    )
    expect(args).toContain(
      'safe.directory=/srv/gitea/data/git/repositories/matos-global/assets.git',
    )
    // HTTP remotes are not filesystem paths and must not leak into the config.
    expect(args.join(' ')).not.toContain('http://127.0.0.1:3001')
  })

  test('passes local-remote safe.directory config to git-upload-pack children', async () => {
    const root = await mkAssetTestDir('matos-local-remote-safe-project-')
    const repo = await mkAssetTestDir('matos-local-remote-safe-repo-')
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'local-remote-safe-pack',
      roleId: 'local-remote-safe-role',
      roleName: 'Local Remote Safe Role',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed local remote')
    const source = {
      type: 'git' as const,
      id: 'local-remote-safe-source',
      repo,
      ref: 'main',
      scope: 'core' as const,
      refresh: 'always' as const,
    }
    await materializeMatOSAssetSource(root, source)

    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
    const uploadPack = join(root, 'assert-safe-upload-pack.sh')
    const quotedRepo = `'${repo.replaceAll("'", "'\\''")}'`
    await writeFile(
      uploadPack,
      `#!/usr/bin/env bash
set -euo pipefail
test -n "\${GIT_CONFIG_GLOBAL:-}"
git config --file "$GIT_CONFIG_GLOBAL" --get-all safe.directory | grep -Fqx -- ${quotedRepo}
exec git-upload-pack "$@"
`,
      'utf8',
    )
    await chmod(uploadPack, 0o755)
    await git(checkoutRoot, ['config', 'remote.origin.uploadpack', uploadPack])

    await expect(materializeMatOSAssetSource(root, source)).resolves.toBe(
      checkoutRoot,
    )
  })
})

test('materializes local git sources without hardlinking store object files', async () => {
  // Regression for the 2026-08-13 fleet-repair owner flip-flop: local-path
  // clones (the Gitea bare-store fast path) hardlinked loose objects into
  // scope-owned source caches, so the "cache file" was really the store's
  // inode and per-scope ownership repair rewrote the store owner and every
  // sibling cache sharing the inode. Clones must copy objects instead.
  const root = await mkAssetTestDir('matos-no-hardlink-project-')
  const repo = await mkAssetTestDir('matos-no-hardlink-repo-')
  await mkdir(join(root, '.matos'), { recursive: true })
  await createGitRolePack({
    repo,
    packId: 'no-hardlink-pack',
    roleId: 'no-hardlink-role',
    roleName: 'No Hardlink Role',
  })
  await git(repo, ['init', '-b', 'main'])
  await commitAll(repo, 'seed no-hardlink source')
  const source = {
    type: 'git' as const,
    id: 'no-hardlink-source',
    repo,
    ref: 'main',
    refresh: 'manual' as const,
  }

  await materializeMatOSAssetSource(root, source)

  const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, source)
  const objectsRoot = join(checkoutRoot, '.git', 'objects')
  const looseObjects: string[] = []
  for (const shard of await readdir(objectsRoot)) {
    if (!/^[0-9a-f]{2}$/.test(shard)) {
      continue
    }
    for (const name of await readdir(join(objectsRoot, shard))) {
      looseObjects.push(join(objectsRoot, shard, name))
    }
  }
  expect(looseObjects.length).toBeGreaterThan(0)
  for (const object of looseObjects) {
    const stats = await lstat(object)
    expect({ path: object, nlink: stats.nlink }).toEqual({
      path: object,
      nlink: 1,
    })
  }
})
