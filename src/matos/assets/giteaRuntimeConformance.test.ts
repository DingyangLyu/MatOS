import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { type MatOSAssetSourceConfig } from '../project.js'
import {
  canAccessMatOSGiteaAssetRepo,
  matOSGiteaAssetRepoPathInfo,
} from './giteaGovernance.js'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import {
  inspectMatOSAssetSource,
  matOSAssetSourceCacheRoot,
  matOSGitAssetSourceCheckoutRoot,
} from './sourceAdapters.js'

const execFileAsync = promisify(execFile)

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    })
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
    'user.name=MatOS Runtime Test',
    '-c',
    'user.email=matos-runtime-test@localhost',
    'commit',
    '-m',
    message,
  ])
}

async function createRolePack(input: {
  repo: string
  packId: string
  roleId: string
  roleName: string
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
  })
}

async function makeProjectWithSource(
  source: MatOSAssetSourceConfig,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-gitea-runtime-'))
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    includeDefaultAssetRoots: false,
    assetRoots: [],
    assetSources: [source],
  })
  return root
}

describe('MatOS Gitea runtime conformance', () => {
  test('uses accepted commits as runtime authority even when source branches drift', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-runtime-repo-'))
    await git(repo, ['init', '-b', 'main'])
    await createRolePack({
      repo,
      packId: 'runtime-contract',
      roleId: 'compute',
      roleName: 'Accepted Compute',
    })
    await commitAll(repo, 'accepted compute asset')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/matos-core-assets/stable',
      acceptedCommit,
    ])
    await createRolePack({
      repo,
      packId: 'runtime-contract',
      roleId: 'compute',
      roleName: 'Drifted Main Compute',
    })
    await commitAll(repo, 'drift main after acceptance')

    const source: MatOSAssetSourceConfig = {
      type: 'git',
      id: 'matos-core-assets',
      repo,
      ref: 'main',
      subdir: 'packs/runtime-contract',
      provider: 'gitea',
      scope: 'core',
      refresh: 'always',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-core-assets/stable',
        commit: acceptedCommit,
      },
    }
    const root = await makeProjectWithSource(source)

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    const status = await inspectMatOSAssetSource(root, source)

    expect(registry.resolve('role:compute')?.name).toBe('Accepted Compute')
    expect(status.currentCommit).toBe(acceptedCommit)
  })

  test('starts from a prepared accepted checkout in container mode without recloning private Gitea URLs', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-prepared-repo-'))
    await git(repo, ['init', '-b', 'main'])
    await createRolePack({
      repo,
      packId: 'user-runtime-contract',
      roleId: 'compute',
      roleName: 'Prepared User Compute',
    })
    await commitAll(repo, 'accepted user compute asset')
    const acceptedCommit = await gitOutput(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      'accepted/matos-user-assets-alice/stable',
      acceptedCommit,
    ])
    await createRolePack({
      repo,
      packId: 'user-runtime-contract',
      roleId: 'compute',
      roleName: 'Unaccepted User Main',
    })
    await commitAll(repo, 'drift user main after acceptance')

    const source: MatOSAssetSourceConfig = {
      type: 'git',
      id: 'matos-user-assets-alice',
      repo: 'http://127.0.0.1:1/matos-users/alice-assets.git',
      ref: 'main',
      subdir: 'packs/user-runtime-contract',
      provider: 'gitea',
      scope: 'user',
      scopeRef: 'user:alice',
      refresh: 'always',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-user-assets-alice/stable',
        commit: acceptedCommit,
      },
    }
    const root = await makeProjectWithSource(source)
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
    const previousToken = process.env.MATOS_GITEA_TOKEN
    const previousGatewayToken = process.env.MATOS_GATEWAY_GITEA_TOKEN
    process.env.MATOS_WORKSPACE_DIR = '/workspace/group/shared'
    process.env.MATOS_GITEA_CONTAINER_SOURCE_BASE_URL =
      'http://matos-gitea:3000'
    delete process.env.MATOS_GITEA_TOKEN
    delete process.env.MATOS_GATEWAY_GITEA_TOKEN
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
      expect(registry.resolve('role:compute')?.name).toBe(
        'Prepared User Compute',
      )
      expect(await gitOutput(checkoutRoot, ['remote', 'get-url', 'origin'])).toBe(
        source.repo,
      )
      expect(await gitOutput(checkoutRoot, ['rev-parse', 'HEAD'])).toBe(
        acceptedCommit,
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

  test('recovers stale MatOS source-cache locks and leaves scoped caches traversable', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-lock-repo-'))
    await git(repo, ['init', '-b', 'main'])
    await createRolePack({
      repo,
      packId: 'lock-contract',
      roleId: 'lock-role',
      roleName: 'Lock Contract Role',
    })
    await commitAll(repo, 'add lock contract role')
    const source: MatOSAssetSourceConfig = {
      type: 'git',
      id: 'matos-user-assets-bob',
      repo,
      ref: 'main',
      subdir: 'packs/lock-contract',
      scope: 'user',
      scopeRef: 'user:bob@example.com',
      refresh: 'always',
    }
    const root = await makeProjectWithSource(source)
    const cacheRoot = matOSAssetSourceCacheRoot(root, source)
    const lockRoot = join(cacheRoot, '.locks')
    const staleLock = join(lockRoot, 'matos-user-assets-bob.lock')
    await mkdir(staleLock, { recursive: true })
    await writeJson(join(staleLock, 'owner.json'), {
      pid: 99999999,
      host: 'stale-host',
      createdAtMs: 0,
    })
    await chmod(lockRoot, 0o700)
    await chmod(staleLock, 0o700)
    await chmod(join(staleLock, 'owner.json'), 0o600)

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    expect(registry.resolve('role:lock-role')?.name).toBe('Lock Contract Role')
    expect(await pathExists(staleLock)).toBe(false)
    expect((await stat(lockRoot)).mode & 0o777).toBe(0o777)
    expect(cacheRoot).toContain(
      join('.matos', 'source-cache', 'scopes', 'users', 'bob-example-com', 'git'),
    )
    expect(
      (
        await lstat(
          join(root, '.matos', 'source-cache', 'git', 'matos-user-assets-bob'),
        )
      ).isSymbolicLink(),
    ).toBe(true)
  })

  test('keeps Gitea asset repository governance scope-aware', () => {
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
        action: 'write',
      }),
    ).toBe(true)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        owner: 'matos-users',
        repo: 'bob-example-com-assets',
        action: 'read',
      }),
    ).toBe(false)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        authorizedScopes: [{ role: 'curator', scopeRef: 'team:lab-a' }],
        owner: 'matos-teams',
        repo: 'lab-a-assets',
        action: 'write',
      }),
    ).toBe(true)
    expect(
      canAccessMatOSGiteaAssetRepo({
        accountScopeRef: 'user:alice@example.com',
        owner: 'matos-core',
        repo: 'assets',
        action: 'read',
      }),
    ).toBe(true)
    expect(matOSGiteaAssetRepoPathInfo('/matos-core/assets/src/branch/main')).toEqual({
      owner: 'matos-core',
      repo: 'assets',
      isMatOSAssetRepo: true,
    })
  })
})
