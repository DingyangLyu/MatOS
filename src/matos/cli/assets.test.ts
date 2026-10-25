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
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMatOSAssetsCommand } from './assets.js'
import {
  createMatOSAssetHistorySnapshot,
  matOSAssetHistoryStableRef,
} from '../assets/history/index.js'
import { git } from '../assets/history/gitBackend.js'
import { matOSGitAssetSourceCheckoutRoot } from '../assets/sourceAdapters.js'

const execFileAsync = promisify(execFile)

// Deployment/asset root env vars inherited from an operator shell (e.g. a
// sourced .env.deploy) would silently retarget deploy-tool tests at the REAL
// production asset roots and pollute discovery with the deployment packs.
// This actually happened: a fixture pack leaked into the production global
// asset root. Always scrub them so tests only see roots they create.
const AMBIENT_DEPLOYMENT_ENV_KEYS = [
  'MATOS_DEPLOY_ROOT',
  'MATOS_DATA_DIR',
  'MATOS_GATEWAY_DATA_DIR',
  'MATOS_GATEWAY_CONFIG',
  'MATOS_GATEWAY_ACCOUNT_STORE',
  'MATOS_RUNTIME_DATA_DIR',
  'MATOS_SHARED_ASSET_ROOT',
  'MATOS_GLOBAL_ASSET_ROOT',
  'MATOS_GOVERNANCE_ROOT',
  'MATOS_BACKUP_ROOT',
  'MATOS_OPS_ROOT',
  'MATOS_BUNDLED_ASSET_ROOT',
  'MATOS_ASSET_ROOTS',
  'MATOS_INCLUDE_LEGACY_ASSETS',
  'MATOS_EDITABLE_CORE_ASSET_ROOT',
]

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('missing port'))
        return
      }
      resolve(address.port)
    })
  })
}

async function createAssetCliFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-assets-cli-'))
  const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
  const knowledgeDir = join(root, '.matos', 'assets', 'knowledges', 'matbench')
  await mkdir(roleDir, { recursive: true })
  await mkdir(knowledgeDir, { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })

  await writeJson(join(roleDir, 'asset.json'), {
    id: 'planner',
    type: 'role',
    name: 'Planner',
    version: '0.1.0',
    description: 'Plans materials work.',
    entry: 'prompt.md',
    mounts: {
      knowledge: ['knowledge:matbench'],
      tools: ['Read'],
    },
  })
  await writeFile(join(roleDir, 'prompt.md'), 'You plan materials work.\n')
  await writeJson(join(knowledgeDir, 'asset.json'), {
    id: 'matbench',
    type: 'knowledge',
    name: 'Matbench',
    version: '0.1.0',
    description: 'Benchmark datasets.',
    entry: 'README.md',
    metadata: {
      summary: 'Benchmark datasets.',
      apiKey: 'secret-value',
      hostPath: '/vepfs-mlp2/private/data',
    },
  })
  await writeFile(join(knowledgeDir, 'README.md'), 'Matbench details.\n')

  return root
}

async function createToolPackFixture(root: string): Promise<string> {
  const packRoot = join(root, 'incoming', 'hot-tools')
  const toolDir = join(packRoot, 'tools', 'hot-tool')
  await mkdir(toolDir, { recursive: true })
  await writeJson(join(packRoot, 'matos.pack.json'), {
    id: 'hot-tools',
    name: 'Hot Tools',
    version: '0.1.0',
  })
  await writeJson(join(toolDir, 'asset.json'), {
    id: 'hot-tool',
    type: 'tool',
    name: 'Hot Tool',
    version: '0.1.0',
    description: 'A hot-loaded tool asset.',
    path: '.',
    entry: 'prompt.md',
    metadata: {
      kind: 'external-tool',
    },
  })
  await writeFile(join(toolDir, 'prompt.md'), 'Use the hot-loaded tool.\n')
  return packRoot
}

async function writeDeploymentOnlyAssetConfig(root: string): Promise<void> {
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    includeDefaultAssetRoots: false,
    assetRoots: ['../deploy/assets/global', '../deploy/assets/shared'],
  })
}

async function gitCli(cwd: string, args: string[]): Promise<void> {
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
  return String(result.stdout ?? '').trim()
}

async function commitGitCli(cwd: string, message: string): Promise<void> {
  await gitCli(cwd, ['add', '.'])
  await gitCli(cwd, [
    '-c',
    'user.name=MatOS Test',
    '-c',
    'user.email=matos-test@localhost',
    'commit',
    '-m',
    message,
  ])
}

async function writeGitSourceRolePack(input: {
  repo: string
  roleName: string
}): Promise<void> {
  const roleDir = join(
    input.repo,
    'packs',
    'cli-git-pack',
    'roles',
    'cli-git-role',
  )
  await mkdir(roleDir, { recursive: true })
  await writeJson(join(input.repo, 'packs', 'cli-git-pack', 'matos.pack.json'), {
    id: 'cli-git-pack',
    name: 'CLI Git Pack',
    version: '1.0.0',
  })
  await writeJson(join(roleDir, 'asset.json'), {
    id: 'cli-git-role',
    type: 'role',
    name: input.roleName,
    version: '1.0.0',
    path: '.',
  })
}

async function writeGitSourceAsset(input: {
  repo: string
  pack: string
  typeDir: string
  id: string
  type: string
  name: string
  body: string
  manifest?: Record<string, unknown>
}): Promise<void> {
  const assetDir = join(input.repo, 'packs', input.pack, input.typeDir, input.id)
  await mkdir(assetDir, { recursive: true })
  await writeJson(join(input.repo, 'packs', input.pack, 'matos.pack.json'), {
    id: input.pack,
    name: input.pack,
    version: '1.0.0',
  })
  await writeJson(join(assetDir, 'asset.json'), {
    id: input.id,
    type: input.type,
    name: input.name,
    version: '1.0.0',
    entry: 'README.md',
    ...(input.manifest ?? {}),
  })
  await writeFile(join(assetDir, 'README.md'), input.body, 'utf8')
}

async function createBareGiteaRepo(input: {
  giteaRoot: string
  owner: string
  repo: string
  roleName?: string
}): Promise<void> {
  const worktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-work-'))
  if (input.roleName) {
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: input.roleName,
    })
  } else {
    await writeFile(join(worktree, 'README.md'), `${input.owner}/${input.repo}\n`)
  }
  await gitCli(worktree, ['init', '-b', 'main'])
  await commitGitCli(worktree, `seed ${input.owner}/${input.repo}`)
  const ownerDir = join(input.giteaRoot, input.owner)
  await mkdir(ownerDir, { recursive: true })
  await execFileAsync('git', [
    'clone',
    '--bare',
    worktree,
    join(ownerDir, `${input.repo}.git`),
  ])
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  for (const key of AMBIENT_DEPLOYMENT_ENV_KEYS) {
    delete process.env[key]
  }
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('matos assets CLI', () => {
  test('lists and refreshes configured git asset sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-sources-cli-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-assets-sources-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeGitSourceRolePack({ repo, roleName: 'Before Source Refresh' })
    await gitCli(repo, ['init', '-b', 'main'])
    await commitGitCli(repo, 'add first source asset')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'cli-git-pack',
          repo,
          ref: 'main',
          subdir: 'packs/cli-git-pack',
          scope: 'project',
          refresh: 'manual',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(await runMatOSAssetsCommand(['sources', 'list', '--json'], io)).toBe(0)
    const listed = JSON.parse(stdout.join('')) as {
      sources: Array<{ id: string; type: string; ref?: string; subdir?: string }>
    }
    expect(listed.sources).toEqual([
      expect.objectContaining({
        id: 'cli-git-pack',
        type: 'git',
        ref: 'main',
        subdir: 'packs/cli-git-pack',
      }),
    ])
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['sources', 'status', 'cli-git-pack', '--json'],
        io,
      ),
    ).toBe(1)
    const initialStatus = JSON.parse(stdout.join('')) as {
      ok: boolean
      sources: Array<{ id: string; ok: boolean; error?: string }>
    }
    expect(initialStatus.ok).toBe(false)
    expect(initialStatus.sources).toEqual([
      expect.objectContaining({
        id: 'cli-git-pack',
        ok: false,
        error: 'MatOS git asset source has not been materialized',
      }),
    ])
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['sources', 'refresh', 'cli-git-pack', '--json'],
        io,
      ),
    ).toBe(0)
    const firstRefresh = JSON.parse(stdout.join('')) as {
      ok: boolean
      refreshed: Array<{ id: string; materializedRoot: string }>
      validation: { ok: boolean }
    }
    expect(firstRefresh.ok).toBe(true)
    expect(firstRefresh.refreshed).toEqual([
      expect.objectContaining({
        id: 'cli-git-pack',
        materializedRoot:
          '<workspace>/.matos/source-cache/git/cli-git-pack/packs/cli-git-pack',
      }),
    ])
    expect(firstRefresh.validation.ok).toBe(true)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const beforeShow = JSON.parse(stdout.join('')) as {
      asset: { name: string }
    }
    expect(beforeShow.asset.name).toBe('Before Source Refresh')
    stdout.length = 0

    await writeGitSourceRolePack({ repo, roleName: 'After Source Refresh' })
    await commitGitCli(repo, 'update source asset')

    expect(
      await runMatOSAssetsCommand(
        ['sources', 'refresh', 'cli-git-pack', '--json'],
        io,
      ),
    ).toBe(0)
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const afterShow = JSON.parse(stdout.join('')) as {
      asset: { name: string }
    }
    expect(afterShow.asset.name).toBe('After Source Refresh')
    expect(stderr.join('')).toBe('')
  })

  test('adds and removes git asset sources through project config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-sources-add-cli-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-assets-sources-add-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await writeGitSourceRolePack({ repo, roleName: 'Added Source Role' })
    await gitCli(repo, ['init', '-b', 'main'])
    await commitGitCli(repo, 'add source asset')
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'sources',
          'add-git',
          'added-pack',
          '--repo',
          repo,
          '--ref',
          'main',
          '--subdir',
          'packs/cli-git-pack',
          '--scope',
          'shared',
          '--refresh',
          'always',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const added = JSON.parse(stdout.join('')) as {
      source: { id: string; type: string; scope: string; refresh: string }
      sources: Array<{ id: string }>
    }
    expect(added.source).toMatchObject({
      id: 'added-pack',
      type: 'git',
      scope: 'shared',
      refresh: 'always',
    })
    expect(added.sources.map(source => source.id)).toEqual(['added-pack'])
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as { asset: { name: string } }
    expect(show.asset.name).toBe('Added Source Role')
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['sources', 'remove', 'added-pack', '--json'],
        io,
      ),
    ).toBe(0)
    const removed = JSON.parse(stdout.join('')) as {
      removed: { id: string }
      sources: Array<{ id: string }>
    }
    expect(removed.removed.id).toBe('added-pack')
    expect(removed.sources).toEqual([])
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(1)
    expect(stderr.join('')).toContain('MatOS asset not found: role:cli-git-role')
  })

  test('adds Gitea asset sources with scope metadata and user-scoped cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-add-cli-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await writeGitSourceRolePack({ repo, roleName: 'Gitea Source Role' })
    await gitCli(repo, ['init', '-b', 'main'])
    await commitGitCli(repo, 'add gitea source asset')
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'sources',
          'add-gitea',
          'alice-pack',
          '--repo',
          'matos-users/alice-example-com-assets',
          '--clone-url',
          repo,
          '--ref',
          'main',
          '--subdir',
          'packs/cli-git-pack',
          '--scope',
          'user',
          '--scope-ref',
          'user:alice@example.com',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const added = JSON.parse(stdout.join('')) as {
      source: {
        id: string
        type: string
        scope: string
        scopeRef: string
        gitea: { owner: string; repo: string; visibility: string }
      }
      validation: { ok: boolean }
    }
    expect(added.source).toMatchObject({
      id: 'alice-pack',
      type: 'git',
      scope: 'user',
      scopeRef: 'user:alice@example.com',
      gitea: {
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
        visibility: 'private',
      },
    })
    expect(added.validation.ok).toBe(true)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['sources', 'status', '--json'], io),
    ).toBe(0)
    const status = JSON.parse(stdout.join('')) as {
      sources: Array<{
        id: string
        cachePath: string
        materializedRoot: string
      }>
    }
    expect(status.sources).toEqual([
      expect.objectContaining({
        id: 'alice-pack',
        cachePath:
          '<workspace>/.matos/source-cache/scopes/users/alice-example-com/git/alice-pack',
        materializedRoot:
          '<workspace>/.matos/source-cache/scopes/users/alice-example-com/git/alice-pack/packs/cli-git-pack',
      }),
    ])
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: {
        name: string
        metadata?: {
          sourceProvenance?: {
            provider?: string
            repo?: string
            ref?: string
            gitea?: { owner?: string; repo?: string }
            currentCommit?: string
          }
        }
      }
    }
    expect(show.asset.name).toBe('Gitea Source Role')
    expect(show.asset.metadata?.sourceProvenance).toMatchObject({
      provider: 'gitea',
      ref: 'main',
      gitea: {
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
      },
    })
    expect(show.asset.metadata?.sourceProvenance?.currentCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(stderr.join('')).toBe('')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        [
          'sources',
          'add-gitea',
          'alice-pack',
          '--repo',
          'matos-users/alice-example-com-assets',
          '--clone-url',
          repo,
          '--ref',
          'main',
          '--subdir',
          'packs/cli-git-pack',
          '--scope',
          'user',
          '--scope-ref',
          'user:alice@example.com',
          '--exclude-runtime',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const reviewOnly = JSON.parse(stdout.join('')) as {
      source: { includeInRuntime?: boolean }
    }
    expect(reviewOnly.source.includeInRuntime).toBe(false)
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(1)
  })

  test('bootstraps Gitea asset repositories through the assets git CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-bootstrap-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    const requests: string[] = []
    const existing = new Set<string>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        requests.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
        if (req.method === 'GET') {
          if (req.url === '/api/v1/user') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ login: 'matos-owner' }))
            return
          }
          if (existing.has(req.url ?? '')) {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
            return
          }
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs') {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            username: string
          }
          existing.add(`/api/v1/orgs/${parsed.username}`)
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (req.method === 'POST' && req.url?.startsWith('/api/v1/orgs/')) {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            name: string
          }
          const owner = req.url.split('/')[4]
          existing.add(`/api/v1/repos/${owner}/${parsed.name}`)
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-community/contributions/branch_protections'
        ) {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          res.statusCode = 201
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(parsed))
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)
    const previousToken = process.env.MATOS_GITEA_TOKEN
    process.env.MATOS_GITEA_TOKEN = 'asset-bootstrap-token'
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    try {
      const exitCode = await runMatOSAssetsCommand(
        [
          'git',
          'bootstrap',
          '--api-url',
          `http://127.0.0.1:${port}/api/v1`,
          '--json',
        ],
        io,
      )
      expect(exitCode).toBe(0)
      const result = JSON.parse(stdout.join('')) as {
        ok: boolean
        repositories: Array<{ owner: string; repo: string }>
      }
      expect(result.ok).toBe(true)
      expect(result.repositories.map(repo => `${repo.owner}/${repo.repo}`)).toEqual(
        [
          'matos-core/assets',
          'matos-shared/assets',
          'matos-global/assets',
          'matos-community/contributions',
          'matos-evolution/proposals',
        ],
      )
      expect(JSON.stringify(result)).not.toContain('asset-bootstrap-token')
      expect(requests).toContain('POST /api/v1/orgs/matos-core/repos')
      expect(stderr.join('')).toBe('')
    } finally {
      if (previousToken === undefined) {
        delete process.env.MATOS_GITEA_TOKEN
      } else {
        process.env.MATOS_GITEA_TOKEN = previousToken
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('syncs baseline Gitea asset sources into one runtime source registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-sync-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-bare-'))
    const unrelatedRepo = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-unrelated-'))
    await writeFile(join(unrelatedRepo, 'README.md'), 'user assets placeholder\n')
    await gitCli(unrelatedRepo, ['init', '-b', 'main'])
    await commitGitCli(unrelatedRepo, 'seed unrelated user assets')
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: true,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'unrelated-user-assets',
          repo: unrelatedRepo,
          ref: 'main',
          scope: 'user',
          refresh: 'manual',
        },
      ],
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-core',
      repo: 'assets',
      roleName: 'Unified Gitea Core Role',
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-shared',
      repo: 'assets',
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-global',
      repo: 'assets',
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-sources',
          '--base-url',
          `file://${giteaRoot}`,
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const synced = JSON.parse(stdout.join('')) as {
      ok: boolean
      includeDefaultAssetRoots: boolean
      sources: Array<{ id: string; provider?: string; gitea?: { owner: string } }>
      governanceRepositories: Array<{
        id: string
        runtimeSource: boolean
      }>
      validation: { ok: boolean }
    }
    expect(synced.ok).toBe(true)
    expect(synced.includeDefaultAssetRoots).toBe(false)
    expect(synced.sources.map(source => source.id)).toEqual([
      'unrelated-user-assets',
      'matos-core-assets',
      'matos-shared-assets',
      'matos-global-assets',
    ])
    expect(synced.sources.slice(1)).toEqual([
      expect.objectContaining({
        id: 'matos-core-assets',
        provider: 'gitea',
        gitea: expect.objectContaining({ owner: 'matos-core' }),
      }),
      expect.objectContaining({
        id: 'matos-shared-assets',
        provider: 'gitea',
        gitea: expect.objectContaining({ owner: 'matos-shared' }),
      }),
      expect.objectContaining({
        id: 'matos-global-assets',
        provider: 'gitea',
        gitea: expect.objectContaining({ owner: 'matos-global' }),
      }),
    ])
    expect(
      synced.governanceRepositories.find(
        repo => repo.id === 'matos-evolution-proposals',
      ),
    ).toEqual(expect.objectContaining({ runtimeSource: false }))
    expect(synced.validation.ok).toBe(true)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: { name: string; metadata?: { sourceProvenance?: { provider?: string } } }
    }
    expect(show.asset.name).toBe('Unified Gitea Core Role')
    expect(show.asset.metadata?.sourceProvenance?.provider).toBe('gitea')
    expect(stderr.join('')).toBe('')
  })

  test('dry-runs baseline Gitea asset sources with accepted runtime refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-sync-accepted-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-sync-accepted-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-core',
      repo: 'assets',
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-shared',
      repo: 'assets',
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-global',
      repo: 'assets',
    })
    const stdout: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: () => undefined,
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-sources',
          '--base-url',
          `file://${giteaRoot}`,
          '--runtime-ref',
          'accepted',
          '--dry-run',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const synced = JSON.parse(stdout.join('')) as {
      sources: Array<{ id: string; runtimeRef?: { mode: string; ref: string } }>
    }
    expect(synced.sources).toEqual([
      expect.objectContaining({
        id: 'matos-core-assets',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/matos-core-assets/stable',
        },
      }),
      expect.objectContaining({
        id: 'matos-shared-assets',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/matos-shared-assets/stable',
        },
      }),
      expect.objectContaining({
        id: 'matos-global-assets',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/matos-global-assets/stable',
        },
      }),
    ])
  })

  test('syncs a user-scoped Gitea asset source into the runtime registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-user-sync-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-user-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-users',
      repo: 'alice-example-com-assets',
      roleName: 'Alice Private Gitea Role',
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-user-source',
          '--scope-ref',
          'user:alice@example.com',
          '--base-url',
          `file://${giteaRoot}`,
          '--runtime-ref',
          'accepted',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const synced = JSON.parse(stdout.join('')) as {
      ok: boolean
      source: {
        id: string
        provider?: string
        scope?: string
        scopeRef?: string
        runtimeRef?: { mode?: string; ref?: string }
        gitea?: { owner?: string; repo?: string; visibility?: string }
      }
      materializedRoot: string
      validation: { ok: boolean }
    }
    expect(synced.ok).toBe(true)
    expect(synced.source).toMatchObject({
      id: 'matos-user-assets-alice-example-com',
      provider: 'gitea',
      scope: 'user',
      scopeRef: 'user:alice@example.com',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-user-assets-alice-example-com/stable',
      },
      gitea: {
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
        visibility: 'private',
      },
    })
    expect(synced.materializedRoot).toBe(
      '<workspace>/.matos/source-cache/scopes/users/alice-example-com/git/matos-user-assets-alice-example-com',
    )
    expect(synced.validation.ok).toBe(true)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['sources', 'status', '--json'], io),
    ).toBe(0)
    const status = JSON.parse(stdout.join('')) as {
      sources: Array<{ id: string; cachePath: string; ok: boolean }>
    }
    expect(status.sources).toEqual([
      expect.objectContaining({
        id: 'matos-user-assets-alice-example-com',
        cachePath:
          '<workspace>/.matos/source-cache/scopes/users/alice-example-com/git/matos-user-assets-alice-example-com',
        ok: true,
      }),
    ])
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: {
        name: string
        metadata?: { sourceProvenance?: { provider?: string; scopeRef?: string } }
      }
    }
    expect(show.asset.name).toBe('Alice Private Gitea Role')
    expect(show.asset.metadata?.sourceProvenance).toMatchObject({
      provider: 'gitea',
      scopeRef: 'user:alice@example.com',
    })
    stdout.length = 0

    expect(await runMatOSAssetsCommand(['git', 'status', '--json'], io)).toBe(0)
    const gitStatus = JSON.parse(stdout.join('')) as {
      configured: boolean
      apiConfigured?: boolean
      runtimeSourceConfigured?: boolean
      assetSources: Array<{ id: string }>
    }
    expect(gitStatus.configured).toBe(true)
    expect(gitStatus.apiConfigured).toBe(false)
    expect(gitStatus.runtimeSourceConfigured).toBe(true)
    expect(gitStatus.assetSources.map(source => source.id)).toContain(
      'matos-user-assets-alice-example-com',
    )
    expect(stderr.join('')).toBe('')
  })

  test('dry-runs scoped Gitea asset source with accepted runtime ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-user-accepted-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-user-accepted-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    const stdout: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: () => undefined,
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-scope-source',
          '--scope',
          'user',
          '--scope-ref',
          'user:alice@example.com',
          '--base-url',
          `file://${giteaRoot}`,
          '--runtime-ref',
          'accepted',
          '--dry-run',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const synced = JSON.parse(stdout.join('')) as {
      source: { id: string; runtimeRef?: { mode: string; ref: string } }
    }
    expect(synced.source).toMatchObject({
      id: 'matos-user-assets-alice-example-com',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-user-assets-alice-example-com/stable',
      },
    })
  })

  test('rejects commit runtime refs for scoped Gitea source sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-scope-commit-ref-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-scope-commit-ref-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: () => undefined,
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-scope-source',
          '--scope',
          'user',
          '--scope-ref',
          'user:alice@example.com',
          '--base-url',
          `file://${giteaRoot}`,
          '--runtime-ref',
          'commit',
          '--dry-run',
          '--json',
        ],
        io,
      ),
    ).toBe(1)
    expect(stderr.join('')).toContain(
      'MatOS scoped Gitea asset sources support --runtime-ref accepted or source',
    )
  })

  test('syncs team and project scoped Gitea asset sources into isolated runtime caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-scope-sync-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-scope-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-teams',
      repo: 'alpha-assets',
      roleName: 'Alpha Team Role',
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-projects',
      repo: 'battery-assets',
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-scope-source',
          '--scope',
          'team',
          '--scope-ref',
          'team:alpha',
          '--base-url',
          `file://${giteaRoot}`,
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const team = JSON.parse(stdout.splice(0).join('')) as {
      source: { id: string; scope: string; scopeRef: string; gitea: { owner: string; repo: string } }
      materializedRoot: string
    }
    expect(team.source).toMatchObject({
      id: 'matos-team-assets-alpha',
      scope: 'team',
      scopeRef: 'team:alpha',
      gitea: {
        owner: 'matos-teams',
        repo: 'alpha-assets',
      },
    })
    expect(team.materializedRoot).toBe(
      '<workspace>/.matos/source-cache/scopes/teams/alpha/git/matos-team-assets-alpha',
    )

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-scope-source',
          '--scope',
          'project',
          '--scope-ref',
          'project:battery',
          '--base-url',
          `file://${giteaRoot}`,
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const project = JSON.parse(stdout.splice(0).join('')) as {
      source: { id: string; scope: string; scopeRef: string; gitea: { owner: string; repo: string } }
      materializedRoot: string
    }
    expect(project.source).toMatchObject({
      id: 'matos-project-assets-battery',
      scope: 'project',
      scopeRef: 'project:battery',
      gitea: {
        owner: 'matos-projects',
        repo: 'battery-assets',
      },
    })
    expect(project.materializedRoot).toBe(
      '<workspace>/.matos/source-cache/scopes/projects/battery/git/matos-project-assets-battery',
    )
    expect(stderr.join('')).toBe('')
  })

  test('provisions and registers a scoped Gitea asset source in one command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-provision-register-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-provision-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-teams',
      repo: 'alpha-assets',
      roleName: 'Provision Registered Team Role',
    })
    const requests: string[] = []
    const existing = new Set<string>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        requests.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
        if (req.method === 'GET') {
          if (existing.has(req.url ?? '')) {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
            return
          }
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs') {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            username: string
          }
          existing.add(`/api/v1/orgs/${parsed.username}`)
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs/matos-teams/repos') {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            name: string
          }
          expect(parsed.name).toBe('alpha-assets')
          existing.add(`/api/v1/repos/matos-teams/${parsed.name}`)
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (
          req.method === 'POST' &&
          (req.url ?? '').startsWith(
            '/api/v1/repos/matos-teams/alpha-assets/statuses/',
          )
        ) {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            state: string
            context: string
          }
          expect(parsed.state).toBe('success')
          expect(parsed.context).toBe('matos/validate')
          res.statusCode = 201
          res.end('{}')
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)
    const previousToken = process.env.MATOS_GITEA_TOKEN
    process.env.MATOS_GITEA_TOKEN = 'register-scope-token'
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    try {
      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'provision-scope',
            '--api-url',
            `http://127.0.0.1:${port}/api/v1`,
            '--base-url',
            `file://${giteaRoot}`,
            '--scope',
            'team',
            '--scope-ref',
            'team:alpha',
            '--register-source',
            '--runtime-ref',
            'accepted',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
      const result = JSON.parse(stdout.join('')) as {
        ok: boolean
        assetSource?: {
          source: {
            id: string
            scope: string
            scopeRef: string
            runtimeRef?: { mode?: string; ref?: string; commit?: string }
          }
          validation: { ok: boolean }
        }
      }
      expect(result.ok).toBe(true)
      expect(result.assetSource?.source).toMatchObject({
        id: 'matos-team-assets-alpha',
        scope: 'team',
        scopeRef: 'team:alpha',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/matos-team-assets-alpha/stable',
        },
      })
      expect(result.assetSource?.source.runtimeRef?.commit).toBeString()
      expect(result.assetSource?.validation.ok).toBe(true)
      expect(requests).toContain('POST /api/v1/orgs/matos-teams/repos')
      expect(stderr.join('')).toBe('')
    } finally {
      if (previousToken === undefined) {
        delete process.env.MATOS_GITEA_TOKEN
      } else {
        process.env.MATOS_GITEA_TOKEN = previousToken
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('creates a Gitea rollback pull request from a previously accepted asset commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-rollback-pr-'))
    const worktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-rollback-work-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-rollback-bare-'))
    const ownerDir = join(giteaRoot, 'matos-core')
    const bareRepo = join(ownerDir, 'assets.git')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(ownerDir, { recursive: true })
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Accepted Compute Role',
    })
    await gitCli(worktree, ['init', '-b', 'main'])
    await commitGitCli(worktree, 'accepted asset source')
    const acceptedCommit = await gitOutput(worktree, ['rev-parse', 'HEAD'])
    await gitCli(worktree, [
      'branch',
      'accepted/matos-core-assets/stable',
      acceptedCommit,
    ])
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Broken Compute Role',
    })
    await commitGitCli(worktree, 'broken asset source')
    const brokenCommit = await gitOutput(worktree, ['rev-parse', 'HEAD'])
    await execFileAsync('git', ['clone', '--bare', worktree, bareRepo])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: bareRepo,
          ref: 'main',
          scope: 'global',
          refresh: 'manual',
          provider: 'gitea',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/matos-core-assets/stable',
            commit: acceptedCommit,
          },
          gitea: {
            owner: 'matos-core',
            repo: 'assets',
            visibility: 'internal',
            cloneUrl: bareRepo,
            webUrl: 'https://matos.example/git/matos-core/assets',
          },
        },
      ],
    })

    const requests: Array<{ method: string; url: string; body: string; authorization: string }> =
      []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body,
          authorization: String(req.headers.authorization ?? ''),
        })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            head: 'rollback/matos-core-assets-to-accepted',
            base: 'main',
            title: 'Rollback core assets to accepted commit',
          })
          res.statusCode = 201
          res.end(
            JSON.stringify({
              number: 77,
              state: 'open',
              html_url: 'https://matos.example/git/matos-core/assets/pulls/77',
              head: { ref: parsed.head },
              base: { ref: parsed.base },
            }),
          )
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected' }))
      })
    })
    const port = await listen(server)
    const previousToken = process.env.MATOS_GITEA_TOKEN
    process.env.MATOS_GITEA_TOKEN = 'asset-rollback-token'
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    try {
      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'rollback-pr',
            'matos-core-assets',
            '--api-url',
            `http://127.0.0.1:${port}/api/v1`,
            '--branch',
            'rollback/matos-core-assets-to-accepted',
            '--target',
            'main',
            '--title',
            'Rollback core assets to accepted commit',
            '--body',
            'Restore the last MatOS-accepted asset tree; validate before merge.',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
      const result = JSON.parse(stdout.join('')) as {
        ok: boolean
        action: string
        sourceId: string
        rollbackBranch: string
        restoreCommit: string
        changedPaths: string[]
        validation: { ok: boolean }
        pullRequest?: { number: number; url?: string }
      }
      expect(result).toMatchObject({
        ok: true,
        action: 'created',
        sourceId: 'matos-core-assets',
        rollbackBranch: 'rollback/matos-core-assets-to-accepted',
        restoreCommit: acceptedCommit,
        validation: { ok: true },
        pullRequest: {
          number: 77,
          url: 'https://matos.example/git/matos-core/assets/pulls/77',
        },
      })
      expect(result.changedPaths).toContain(
        'packs/cli-git-pack/roles/cli-git-role/asset.json',
      )
      expect(JSON.stringify(result)).not.toContain('asset-rollback-token')
      expect(requests.every(request => request.authorization === 'token asset-rollback-token')).toBe(
        true,
      )
      const restored = await execFileAsync('git', [
        '--git-dir',
        bareRepo,
        'show',
        'rollback/matos-core-assets-to-accepted:packs/cli-git-pack/roles/cli-git-role/asset.json',
      ])
      expect(String(restored.stdout)).toContain('Accepted Compute Role')
      const checkoutRoot = matOSGitAssetSourceCheckoutRoot(root, {
        type: 'git',
        id: 'matos-core-assets',
        repo: bareRepo,
        ref: 'main',
        scope: 'global',
        refresh: 'manual',
        provider: 'gitea',
        gitea: {
          owner: 'matos-core',
          repo: 'assets',
          visibility: 'internal',
          cloneUrl: bareRepo,
          webUrl: 'https://matos.example/git/matos-core/assets',
        },
      })
      // Candidate preparation must not create or reset the shared runtime checkout.
      expect(await exists(checkoutRoot)).toBe(false)
      expect((await execFileAsync('git', ['--git-dir', bareRepo, 'rev-parse', 'main'])).stdout.trim()).toBe(brokenCommit)
      expect((await execFileAsync('git', ['--git-dir', bareRepo, 'rev-parse', 'accepted/matos-core-assets/stable'])).stdout.trim()).toBe(acceptedCommit)
      expect(stderr.join('')).toBe('')
    } finally {
      if (previousToken === undefined) {
        delete process.env.MATOS_GITEA_TOKEN
      } else {
        process.env.MATOS_GITEA_TOKEN = previousToken
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('accepts a Gitea asset source commit and pins runtime to accepted ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-cli-'))
    const worktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-work-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-bare-'))
    const ownerDir = join(giteaRoot, 'matos-core')
    const bareRepo = join(ownerDir, 'assets.git')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(ownerDir, { recursive: true })
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Accepted CLI Role',
    })
    await gitCli(worktree, ['init', '-b', 'main'])
    await commitGitCli(worktree, 'accepted cli role')
    const acceptedCommit = await gitOutput(worktree, ['rev-parse', 'HEAD'])
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Broken Main Role',
    })
    await commitGitCli(worktree, 'broken main role')
    await execFileAsync('git', ['clone', '--bare', worktree, bareRepo])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: bareRepo,
          ref: 'main',
          scope: 'global',
          refresh: 'always',
          provider: 'gitea',
          gitea: {
            owner: 'matos-core',
            repo: 'assets',
            visibility: 'internal',
            cloneUrl: bareRepo,
          },
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'accept',
          'matos-core-assets',
          '--ref',
          acceptedCommit,
          '--channel',
          'stable',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const accepted = JSON.parse(stdout.splice(0).join('')) as {
      ok: boolean
      source: { runtimeRef: { mode: string; ref: string; commit: string } }
      validation: { ok: boolean }
    }
    expect(accepted.ok).toBe(true)
    expect(accepted.validation.ok).toBe(true)
    expect(accepted.source.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/matos-core-assets/stable',
      commit: acceptedCommit,
    })

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as { asset: { name: string } }
    expect(show.asset.name).toBe('Accepted CLI Role')
    expect(stderr.join('')).toBe('')
  })

  test('syncs direct-editor stable baseline after accepting a scoped Gitea source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-user-baseline-'))
    const worktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-user-work-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-user-bare-'))
    const ownerDir = join(giteaRoot, 'matos-users')
    const bareRepo = join(ownerDir, 'alice-assets.git')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(ownerDir, { recursive: true })
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Accepted User Role',
    })
    await gitCli(worktree, ['init', '-b', 'main'])
    await commitGitCli(worktree, 'accepted user role')
    const acceptedCommit = await gitOutput(worktree, ['rev-parse', 'HEAD'])
    await execFileAsync('git', ['clone', '--bare', worktree, bareRepo])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-user-assets-alice',
          repo: bareRepo,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'always',
          provider: 'gitea',
          gitea: {
            owner: 'matos-users',
            repo: 'alice-assets',
            visibility: 'private',
            cloneUrl: bareRepo,
          },
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'accept',
          'matos-user-assets-alice',
          '--ref',
          acceptedCommit,
          '--channel',
          'stable',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const accepted = JSON.parse(stdout.join('')) as {
      directEditorRebaseline?: { status: string; scope: string }
      validation: { ok: boolean }
    }
    expect(accepted.validation.ok).toBe(true)
    expect(accepted.directEditorRebaseline).toMatchObject({
      status: 'updated',
      scope: 'user',
    })
    expect(
      (
        await git(root, [
          'rev-parse',
          '--verify',
          matOSAssetHistoryStableRef('user', 'user:alice'),
        ])
      ).trim(),
    ).toHaveLength(40)
    expect(stderr.join('')).toBe('')
  })

  test('accept defaults to the fetched remote source ref instead of a stale local cache branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-remote-'))
    const worktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-remote-work-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-accept-remote-bare-'))
    const ownerDir = join(giteaRoot, 'matos-core')
    const bareRepo = join(ownerDir, 'assets.git')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(ownerDir, { recursive: true })
    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Stale Cached Role',
    })
    await gitCli(worktree, ['init', '-b', 'main'])
    await commitGitCli(worktree, 'stale cached role')
    await execFileAsync('git', ['clone', '--bare', worktree, bareRepo])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: bareRepo,
          ref: 'main',
          scope: 'global',
          refresh: 'always',
          provider: 'gitea',
          gitea: {
            owner: 'matos-core',
            repo: 'assets',
            visibility: 'internal',
            cloneUrl: bareRepo,
          },
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    stdout.length = 0

    await writeGitSourceRolePack({
      repo: worktree,
      roleName: 'Remote Main Role',
    })
    await commitGitCli(worktree, 'remote main role')
    const remoteMainCommit = await gitOutput(worktree, ['rev-parse', 'HEAD'])
    await gitCli(worktree, ['push', bareRepo, 'main'])

    expect(
      await runMatOSAssetsCommand(
        ['git', 'accept', 'matos-core-assets', '--channel', 'stable', '--json'],
        io,
      ),
    ).toBe(0)
    const accepted = JSON.parse(stdout.splice(0).join('')) as {
      commit: string
      source: { runtimeRef: { commit: string } }
    }
    expect(accepted.commit).toBe(remoteMainCommit)
    expect(accepted.source.runtimeRef.commit).toBe(remoteMainCommit)

    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as { asset: { name: string } }
    expect(show.asset.name).toBe('Remote Main Role')
    expect(stderr.join('')).toBe('')
  })

  test('creates a public promotion PR without advancing the accepted runtime ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-'))
    const userWorktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-user-'))
    const coreWorktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-core-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-bare-'))
    const userBare = join(giteaRoot, 'matos-users', 'zhicheng-assets.git')
    const coreBare = join(giteaRoot, 'matos-core', 'assets.git')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(join(giteaRoot, 'matos-users'), { recursive: true })
    await mkdir(join(giteaRoot, 'matos-core'), { recursive: true })

    await writeGitSourceRolePack({
      repo: coreWorktree,
      roleName: 'Public Stable Role',
    })
    await gitCli(coreWorktree, ['init', '-b', 'main'])
    await commitGitCli(coreWorktree, 'seed core assets')
    const acceptedCommit = await gitOutput(coreWorktree, ['rev-parse', 'HEAD'])
    await gitCli(coreWorktree, [
      'branch',
      'accepted/matos-core-assets/stable',
      acceptedCommit,
    ])
    await execFileAsync('git', ['clone', '--bare', coreWorktree, coreBare])

    const userOverlayRoleDir = join(
      userWorktree,
      'packs',
      'user-overlays',
      'overlays',
      'core',
      'roles',
      'cli-git-role',
    )
    await mkdir(userOverlayRoleDir, { recursive: true })
    await writeJson(join(userWorktree, 'packs', 'user-overlays', 'matos.pack.json'), {
      id: 'user-overlays',
      name: 'User Overlays',
      version: '1.0.0',
    })
    await writeJson(join(userOverlayRoleDir, 'asset.json'), {
      id: 'cli-git-role',
      type: 'role',
      name: 'Promoted User Role',
      version: '1.0.0',
      path: '.',
      metadata: {
        overlayOf: 'role:cli-git-role@1.0.0',
      },
    })
    await gitCli(userWorktree, ['init', '-b', 'main'])
    await commitGitCli(userWorktree, 'user accepted overlay')
    const userCommit = await gitOutput(userWorktree, ['rev-parse', 'HEAD'])
    await execFileAsync('git', ['clone', '--bare', userWorktree, userBare])

    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: coreBare,
          ref: 'main',
          scope: 'global',
          refresh: 'always',
          provider: 'gitea',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/matos-core-assets/stable',
            commit: acceptedCommit,
          },
          gitea: {
            owner: 'matos-core',
            repo: 'assets',
            visibility: 'internal',
            cloneUrl: coreBare,
          },
        },
        {
          type: 'git',
          id: 'matos-user-assets-zhicheng',
          repo: userBare,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:zhicheng',
          refresh: 'always',
          provider: 'gitea',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'main',
            commit: userCommit,
          },
          gitea: {
            owner: 'matos-users',
            repo: 'zhicheng-assets',
            visibility: 'private',
            cloneUrl: userBare,
          },
        },
      ],
    })

    const requests: Array<{ method: string; url: string; body: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            head: 'promotion/user-zhicheng/direct-editor-conda-probe',
            base: 'main',
            title: 'Promote user compute guidance',
          })
          res.statusCode = 201
          res.end(
            JSON.stringify({
              number: 77,
              title: parsed.title,
              state: 'open',
              html_url: 'https://matos.top/git/matos-core/assets/pulls/77',
              head: { ref: parsed.head },
              base: { ref: parsed.base },
            }),
          )
          return
        }
        if (req.method === 'POST' && req.url?.includes('/statuses/')) {
          res.statusCode = 201
          res.end('{}')
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected', url: req.url }))
      })
    })
    const port = await listen(server)
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }
    try {
      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'promote',
            'create',
            '--api-url',
            `http://127.0.0.1:${port}/api/v1`,
            '--from-source',
            'matos-user-assets-zhicheng',
            '--to-source',
            'matos-core-assets',
            '--branch',
            'promotion/user-zhicheng/direct-editor-conda-probe',
            '--target',
            'main',
            '--title',
            'Promote user compute guidance',
            '--body',
            'Run: direct-editor-conda-probe',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    const promoted = JSON.parse(stdout.join('')) as {
      ok: boolean
      action: string
      pullRequest: { number: number; url: string }
      commit: { branch: string; commit: string; pushed: boolean }
      validation: { ok: boolean }
      acceptedRefAdvanced: boolean
      recordPath: string
    }
    expect(promoted.ok).toBe(true)
    expect(promoted.action).toBe('pr_created')
    expect(promoted.validation.ok).toBe(true)
    expect(promoted.commit.branch).toBe(
      'promotion/user-zhicheng/direct-editor-conda-probe',
    )
    expect(promoted.commit.pushed).toBe(true)
    expect(promoted.pullRequest.number).toBe(77)
    expect(promoted.acceptedRefAdvanced).toBe(false)
    expect(
      (
        await readdir(join(root, '.matos', 'evolution', 'gitea-promotions'))
      ).some(entry => entry.endsWith('.json')),
    ).toBe(true)
    expect(
      await gitOutput(coreBare, [
        'show',
        'promotion/user-zhicheng/direct-editor-conda-probe:packs/cli-git-pack/roles/cli-git-role/asset.json',
      ]),
    ).toContain('Promoted User Role')
    expect(await gitOutput(coreBare, ['rev-parse', 'accepted/matos-core-assets/stable'])).toBe(
      acceptedCommit,
    )
    expect(
      requests.some(
        request =>
          request.method === 'POST' &&
          request.url === '/api/v1/repos/matos-core/assets/pulls',
      ),
    ).toBe(true)
    expect(stderr.join('')).toBe('')
  })

  test('applies a public promotion only after review benchmark and judge gates pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-apply-'))
    const coreWorktree = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-apply-core-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-promote-apply-bare-'))
    const coreBare = join(giteaRoot, 'matos-core', 'assets.git')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(join(giteaRoot, 'matos-core'), { recursive: true })

    await writeGitSourceRolePack({
      repo: coreWorktree,
      roleName: 'Public Stable Role',
    })
    await gitCli(coreWorktree, ['init', '-b', 'main'])
    await commitGitCli(coreWorktree, 'seed core assets')
    const acceptedCommit = await gitOutput(coreWorktree, ['rev-parse', 'HEAD'])
    await gitCli(coreWorktree, [
      'branch',
      'accepted/matos-core-assets/stable',
      acceptedCommit,
    ])
    await gitCli(coreWorktree, [
      'checkout',
      '-B',
      'promotion/user-zhicheng/direct-editor-conda-probe',
    ])
    await writeGitSourceRolePack({
      repo: coreWorktree,
      roleName: 'Promoted User Role',
    })
    await commitGitCli(coreWorktree, 'promotion branch role update')
    const promotionCommit = await gitOutput(coreWorktree, ['rev-parse', 'HEAD'])
    await execFileAsync('git', ['clone', '--bare', coreWorktree, coreBare])

    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'matos-core-assets',
          repo: coreBare,
          ref: 'main',
          scope: 'global',
          refresh: 'always',
          provider: 'gitea',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/matos-core-assets/stable',
            commit: acceptedCommit,
          },
          gitea: {
            owner: 'matos-core',
            repo: 'assets',
            visibility: 'internal',
            cloneUrl: coreBare,
          },
        },
      ],
    })

    let mergeCount = 0
    const requests: Array<{ method: string; url: string; body: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls/77/merge'
        ) {
          mergeCount += 1
          res.end(JSON.stringify({ merged: true }))
          return
        }
        if (req.method === 'POST' && req.url?.includes('/statuses/')) {
          res.statusCode = 201
          res.end('{}')
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected', url: req.url }))
      })
    })
    const port = await listen(server)
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }
    try {
      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'promote',
            'apply',
            '--api-url',
            `http://127.0.0.1:${port}/api/v1`,
            '--to-source',
            'matos-core-assets',
            '--repo',
            'matos-core/assets',
            '--number',
            '77',
            '--json',
          ],
          io,
        ),
      ).toBe(1)
      const blocked = JSON.parse(stdout.splice(0).join('')) as {
        action: string
        acceptedRefAdvanced: boolean
      }
      expect(blocked.action).toBe('blocked_by_policy')
      expect(blocked.acceptedRefAdvanced).toBe(false)
      expect(mergeCount).toBe(0)

      await execFileAsync('git', [
        `--git-dir=${coreBare}`,
        'update-ref',
        'refs/heads/main',
        'refs/heads/promotion/user-zhicheng/direct-editor-conda-probe',
      ])

      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'promote',
            'apply',
            '--api-url',
            `http://127.0.0.1:${port}/api/v1`,
            '--to-source',
            'matos-core-assets',
            '--repo',
            'matos-core/assets',
            '--number',
            '77',
            '--reviewed',
            '--benchmark-passed',
            '--judge-passed',
            '--push',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    const applied = JSON.parse(stdout.splice(0).join('')) as {
      action: string
      acceptedRefAdvanced: boolean
      acceptance: { commit: string; runtimeRef: { commit: string } }
      validation: { ok: boolean }
      statusWritten: string[]
      recordPath: string
    }
    expect(applied.action).toBe('merged_accepted')
    expect(applied.acceptedRefAdvanced).toBe(true)
    expect(applied.acceptance.commit).toBe(promotionCommit)
    expect(applied.acceptance.runtimeRef.commit).toBe(promotionCommit)
    expect(applied.validation.ok).toBe(true)
    expect(applied.statusWritten).toEqual([
      'matos/review',
      'matos/benchmark',
      'matos/judge',
    ])
    expect(
      (
        await readdir(join(root, '.matos', 'evolution', 'gitea-promotions'))
      ).some(entry => entry.endsWith('.json')),
    ).toBe(true)
    expect(await gitOutput(coreBare, ['rev-parse', 'accepted/matos-core-assets/stable'])).toBe(
      promotionCommit,
    )
    expect(
      requests.some(
        request =>
          request.method === 'POST' &&
          request.url === '/api/v1/repos/matos-core/assets/pulls/77/merge',
      ),
    ).toBe(true)
    const statusContexts = requests
      .filter(
        request =>
          request.method === 'POST' &&
          request.url.includes('/api/v1/repos/matos-core/assets/statuses/'),
      )
      .map(request => JSON.parse(request.body).context)
    expect(statusContexts).toContain('matos/validate')
    expect(statusContexts).toContain('matos/review')
    expect(statusContexts).toContain('matos/benchmark')
    expect(statusContexts).toContain('matos/judge')
    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], io),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as { asset: { name: string } }
    expect(show.asset.name).toBe('Promoted User Role')
    expect(stderr.join('')).toBe('')
  })

  test('lists accepted runtime commands in the Gitea asset CLI usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-usage-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(await runMatOSAssetsCommand(['git', 'nope'], io)).toBe(1)
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('accept')
    expect(stderr.join('')).toContain('rollback-pr')
  })

  test('commits and pushes changes from a materialized Gitea asset source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-commit-'))
    const freshRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-commit-fresh-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-commit-bare-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(join(freshRoot, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await writeJson(join(freshRoot, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    await createBareGiteaRepo({
      giteaRoot,
      owner: 'matos-users',
      repo: 'alice-example-com-assets',
      roleName: 'Before Commit Source',
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }
    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-user-source',
          '--scope-ref',
          'user:alice@example.com',
          '--base-url',
          `file://${giteaRoot}`,
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    stdout.length = 0

    const checkout = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'alice-example-com',
      'git',
      'matos-user-assets-alice-example-com',
    )
    await writeJson(
      join(checkout, 'packs', 'cli-git-pack', 'roles', 'cli-git-role', 'asset.json'),
      {
        id: 'cli-git-role',
        type: 'role',
        name: 'After Commit Source',
        version: '1.0.0',
        path: '.',
      },
    )

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'commit-source',
          'matos-user-assets-alice-example-com',
          '--message',
          'Update Alice asset source',
          '--push',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const committed = JSON.parse(stdout.splice(0).join('')) as {
      action: string
      pushed: boolean
      commit?: string
    }
    expect(committed.action).toBe('committed')
    expect(committed.pushed).toBe(true)
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/)

    const freshIo = {
      cwd: freshRoot,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }
    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'sync-user-source',
          '--scope-ref',
          'user:alice@example.com',
          '--base-url',
          `file://${giteaRoot}`,
          '--json',
        ],
        freshIo,
      ),
    ).toBe(0)
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'role:cli-git-role', '--json'], freshIo),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as { asset: { name: string } }
    expect(show.asset.name).toBe('After Commit Source')
    expect(stderr.join('')).toBe('')
  })

  test('generates a personalized asset merge plan for scoped Git asset sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-merge-plan-cli-'))
    const upstreamRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-upstream-'))
    const userRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-user-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Use shared compute defaults.\n',
    })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'skills',
      id: 'gw-basics',
      type: 'skill',
      name: 'GW Basics',
      body: 'Use GW for quasiparticle corrections.\n',
    })
    await writeGitSourceAsset({
      repo: userRepo,
      pack: 'alice',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Prefer Alice lab GPU policy before shared defaults.\n',
    })
    await gitCli(upstreamRepo, ['init', '-b', 'main'])
    await commitGitCli(upstreamRepo, 'seed upstream assets')
    await gitCli(userRepo, ['init', '-b', 'main'])
    await commitGitCli(userRepo, 'seed user assets')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'upstream-assets',
          repo: upstreamRepo,
          ref: 'main',
          scope: 'shared',
          refresh: 'manual',
        },
        {
          type: 'git',
          id: 'alice-assets',
          repo: userRepo,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'merge-plan',
          '--from-source',
          'upstream-assets',
          '--to-source',
          'alice-assets',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const plan = JSON.parse(stdout.join('')) as {
      summary: { actions: Record<string, number> }
      items: Array<{ action: string; identityKey: string; safeToAutoApply: boolean }>
    }
    expect(plan.summary.actions.auto_add).toBe(1)
    expect(plan.summary.actions.llm_user_merge).toBe(1)
    expect(plan.items).toContainEqual(
      expect.objectContaining({
        action: 'auto_add',
        identityKey: 'skill:gw-basics',
        safeToAutoApply: true,
      }),
    )
    expect(plan.items).toContainEqual(
      expect.objectContaining({
        action: 'llm_user_merge',
        identityKey: 'role:compute',
        safeToAutoApply: false,
      }),
    )
    expect(stderr.join('')).toBe('')
  })

  test('applies auto-only personalized asset merge items and commits target source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-merge-apply-cli-'))
    const upstreamRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-apply-upstream-'))
    const userRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-apply-user-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Use shared compute defaults.\n',
    })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'skills',
      id: 'gw-basics',
      type: 'skill',
      name: 'GW Basics',
      body: 'Use GW for quasiparticle corrections.\n',
    })
    await writeGitSourceAsset({
      repo: userRepo,
      pack: 'alice',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Prefer Alice lab GPU policy before shared defaults.\n',
    })
    await gitCli(upstreamRepo, ['init', '-b', 'main'])
    await commitGitCli(upstreamRepo, 'seed upstream assets')
    await gitCli(userRepo, ['init', '-b', 'main'])
    await commitGitCli(userRepo, 'seed user assets')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'upstream-assets',
          repo: upstreamRepo,
          ref: 'main',
          scope: 'shared',
          refresh: 'manual',
        },
        {
          type: 'git',
          id: 'alice-assets',
          repo: userRepo,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'merge-apply',
          '--auto-only',
          '--from-source',
          'upstream-assets',
          '--to-source',
          'alice-assets',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const result = JSON.parse(stdout.join('')) as {
      ok: boolean
      applied: Array<{ identityKey: string }>
      skipped: Array<{ identityKey: string }>
      commit?: { action: string; commit?: string }
      validation: { ok: boolean }
    }
    expect(result.ok).toBe(true)
    expect(result.validation.ok).toBe(true)
    expect(result.applied).toEqual([
      expect.objectContaining({ identityKey: 'skill:gw-basics' }),
    ])
    expect(result.skipped.map(item => item.identityKey)).toContain('role:compute')
    expect(result.commit).toMatchObject({
      action: 'committed',
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    const checkout = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'alice',
      'git',
      'alice-assets',
    )
    expect(
      await readFile(
        join(checkout, 'packs', 'matos-core', 'skills', 'gw-basics', 'README.md'),
        'utf8',
      ),
    ).toBe('Use GW for quasiparticle corrections.\n')
    expect(
      JSON.parse(
        await readFile(join(checkout, 'packs', 'matos-core', 'matos.pack.json'), 'utf8'),
      ),
    ).toMatchObject({
      id: 'matos-core',
      version: '1.0.0',
    })
    expect(
      await readFile(join(checkout, 'packs', 'alice', 'roles', 'compute', 'README.md'), 'utf8'),
    ).toBe('Prefer Alice lab GPU policy before shared defaults.\n')
    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'merge-plan',
          '--from-source',
          'upstream-assets',
          '--to-source',
          'alice-assets',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const followUpPlan = JSON.parse(stdout.join('')) as {
      summary: { actions: Record<string, number> }
      items: Array<{ action: string; identityKey: string }>
    }
    expect(followUpPlan.summary.actions.auto_add).toBe(0)
    expect(followUpPlan.items).toContainEqual(
      expect.objectContaining({
        action: 'no_change',
        identityKey: 'skill:gw-basics',
      }),
    )
    expect(stderr.join('')).toBe('')
  })

  test('applies scoped assets that depend on inherited upstream assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-merge-overlay-cli-'))
    const previousRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-overlay-prev-'))
    const upstreamRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-overlay-upstream-'))
    const userRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-overlay-user-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeGitSourceAsset({
      repo: previousRepo,
      pack: 'matos-core',
      typeDir: 'knowledge',
      id: 'shared-guide',
      type: 'knowledge',
      name: 'Shared Guide',
      body: 'Shared guide available from core assets.\n',
    })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'knowledge',
      id: 'shared-guide',
      type: 'knowledge',
      name: 'Shared Guide',
      body: 'Shared guide available from core assets.\n',
    })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'skills',
      id: 'uses-shared-guide',
      type: 'skill',
      name: 'Uses Shared Guide',
      body: 'Use knowledge:shared-guide when answering.\n',
      manifest: {
        dependencies: ['knowledge:shared-guide@1.0.0'],
      },
    })
    await writeGitSourceAsset({
      repo: userRepo,
      pack: 'alice',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Alice compute policy.\n',
    })
    await gitCli(previousRepo, ['init', '-b', 'main'])
    await commitGitCli(previousRepo, 'seed previous upstream assets')
    await gitCli(upstreamRepo, ['init', '-b', 'main'])
    await commitGitCli(upstreamRepo, 'seed current upstream assets')
    await gitCli(userRepo, ['init', '-b', 'main'])
    await commitGitCli(userRepo, 'seed user assets')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'previous-upstream-assets',
          repo: previousRepo,
          ref: 'main',
          scope: 'shared',
          refresh: 'manual',
        },
        {
          type: 'git',
          id: 'upstream-assets',
          repo: upstreamRepo,
          ref: 'main',
          scope: 'shared',
          refresh: 'manual',
        },
        {
          type: 'git',
          id: 'alice-assets',
          repo: userRepo,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'merge-apply',
          '--auto-only',
          '--from-source',
          'upstream-assets',
          '--previous-upstream-source',
          'previous-upstream-assets',
          '--to-source',
          'alice-assets',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const result = JSON.parse(stdout.join('')) as {
      ok: boolean
      applied: Array<{ identityKey: string }>
      skipped: Array<{ identityKey: string; action: string }>
      validation: { ok: boolean; errors: Array<{ code: string; message: string }> }
    }
    expect(result.ok).toBe(true)
    expect(result.validation).toMatchObject({ ok: true })
    expect(result.applied).toEqual([
      expect.objectContaining({ identityKey: 'skill:uses-shared-guide' }),
    ])
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        identityKey: 'knowledge:shared-guide',
        action: 'no_change',
      }),
    )
    expect(stderr.join('')).toBe('')
  })

  test('generates an LLM-backed personalized asset merge review for scoped Git sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-merge-review-cli-'))
    const upstreamRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-review-upstream-'))
    const userRepo = await mkdtemp(join(tmpdir(), 'matos-assets-merge-review-user-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeGitSourceAsset({
      repo: upstreamRepo,
      pack: 'matos-core',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Use shared compute defaults and new GW guidance.\n',
    })
    await writeGitSourceAsset({
      repo: userRepo,
      pack: 'alice',
      typeDir: 'roles',
      id: 'compute',
      type: 'role',
      name: 'Compute',
      body: 'Prefer Alice lab GPU queue and local path policy.\n',
    })
    await gitCli(upstreamRepo, ['init', '-b', 'main'])
    await commitGitCli(upstreamRepo, 'seed upstream assets')
    await gitCli(userRepo, ['init', '-b', 'main'])
    await commitGitCli(userRepo, 'seed user assets')
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'upstream-assets',
          repo: upstreamRepo,
          ref: 'main',
          scope: 'shared',
          refresh: 'manual',
        },
        {
          type: 'git',
          id: 'alice-assets',
          repo: userRepo,
          ref: 'main',
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      assetMergeReviewer: async (input: {
        plan: { items: Array<{ identityKey: string }> }
      }) => {
        expect(input.plan.items.map(item => item.identityKey)).toContain(
          'role:compute',
        )
        return {
          enabled: true as const,
          schemaVersion: 1 as const,
          model: 'test-reviewer',
          summary: 'User-specific compute role needs a semantic merge.',
          cacheHit: false,
          items: [
            {
              identityKey: 'role:compute',
              action: 'llm_user_merge' as const,
              recommendation: 'merge_manually' as const,
              rationale: 'Preserve local queue policy while reviewing upstream guidance.',
              risks: ['queue defaults may change'],
              confidence: 0.9,
            },
          ],
        }
      },
    }

    expect(
      await runMatOSAssetsCommand(
        [
          'git',
          'merge-review',
          '--llm',
          '--from-source',
          'upstream-assets',
          '--to-source',
          'alice-assets',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const result = JSON.parse(stdout.join('')) as {
      ok: boolean
      review: {
        enabled: boolean
        items: Array<{ identityKey: string; recommendation: string }>
      }
    }
    expect(result.ok).toBe(true)
    expect(result.review.items).toEqual([
      expect.objectContaining({
        identityKey: 'role:compute',
        recommendation: 'merge_manually',
      }),
    ])
    expect(stderr.join('')).toBe('')
  })

  test('manages Gitea asset branches and pull requests through the assets git CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-pr-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    const requests: Array<{ method: string; url: string; body: string; authorization: string }> =
      []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body,
          authorization: String(req.headers.authorization ?? ''),
        })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'GET' &&
          req.url === '/api/v1/repos/matos-core/assets/branches/evolution%2Frun-42'
        ) {
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/branches'
        ) {
          expect(JSON.parse(body)).toEqual({
            new_branch_name: 'evolution/run-42',
            old_branch_name: 'main',
          })
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            head: 'evolution/run-42',
            base: 'main',
            title: 'Review evolution run 42',
          })
          res.statusCode = 201
          res.end(
            JSON.stringify({
              number: 42,
              title: parsed.title,
              state: 'open',
              html_url: 'https://matos.top/git/matos-core/assets/pulls/42',
              head: { ref: parsed.head },
              base: { ref: parsed.base },
            }),
          )
          return
        }
        if (
          req.method === 'GET' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls/42'
        ) {
          res.end(
            JSON.stringify({
              number: 42,
              title: 'Review evolution run 42',
              state: 'open',
              html_url: 'https://matos.top/git/matos-core/assets/pulls/42',
              head: { ref: 'evolution/run-42' },
              base: { ref: 'main' },
            }),
          )
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls/42/merge'
        ) {
          expect(JSON.parse(body)).toEqual({ Do: 'squash' })
          res.end(JSON.stringify({ merged: true }))
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected' }))
      })
    })
    const port = await listen(server)
    const previousToken = process.env.MATOS_GITEA_TOKEN
    process.env.MATOS_GITEA_TOKEN = 'asset-pr-token'
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }
    const apiUrl = `http://127.0.0.1:${port}/api/v1`

    try {
      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'branch',
            'create',
            '--api-url',
            apiUrl,
            '--repo',
            'matos-core/assets',
            '--branch',
            'evolution/run-42',
            '--from',
            'main',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
      const branch = JSON.parse(stdout.splice(0).join('')) as { action: string }
      expect(branch.action).toBe('created')

      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'pr',
            'create',
            '--api-url',
            apiUrl,
            '--repo',
            'matos-core/assets',
            '--source',
            'evolution/run-42',
            '--target',
            'main',
            '--title',
            'Review evolution run 42',
            '--body',
            'validated by MatOS',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
      const created = JSON.parse(stdout.splice(0).join('')) as {
        number: number
        url: string
      }
      expect(created.number).toBe(42)
      expect(created.url).toBe('https://matos.top/git/matos-core/assets/pulls/42')

      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'pr',
            'status',
            '--api-url',
            apiUrl,
            '--repo',
            'matos-core/assets',
            '--number',
            '42',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
      const status = JSON.parse(stdout.splice(0).join('')) as { state: string }
      expect(status.state).toBe('open')

      expect(
        await runMatOSAssetsCommand(
          [
            'git',
            'pr',
            'merge',
            '--api-url',
            apiUrl,
            '--repo',
            'matos-core/assets',
            '--number',
            '42',
            '--method',
            'squash',
            '--json',
          ],
          io,
        ),
      ).toBe(0)
      const merged = JSON.parse(stdout.splice(0).join('')) as { merged: boolean }
      expect(merged.merged).toBe(true)
      expect(JSON.stringify({ branch, created, status, merged })).not.toContain(
        'asset-pr-token',
      )
      expect(requests.every(request => request.authorization === 'token asset-pr-token')).toBe(
        true,
      )
      expect(stderr.join('')).toBe('')
    } finally {
      if (previousToken === undefined) {
        delete process.env.MATOS_GITEA_TOKEN
      } else {
        process.env.MATOS_GITEA_TOKEN = previousToken
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('provisions a scoped Gitea asset repository through the assets git CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-gitea-scope-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      includeDefaultAssetRoots: false,
      assetRoots: [],
    })
    const requests: Array<{ method: string; url: string; body: string; authorization: string }> =
      []
    const existing = new Set<string>()
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          body,
          authorization: String(req.headers.authorization ?? ''),
        })
        if (req.method === 'GET') {
          if (existing.has(req.url ?? '')) {
            res.setHeader('content-type', 'application/json')
            res.end('{}')
            return
          }
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs') {
          const parsed = JSON.parse(body) as { username: string }
          existing.add(`/api/v1/orgs/${parsed.username}`)
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (req.method === 'POST' && req.url === '/api/v1/orgs/matos-users/repos') {
          const parsed = JSON.parse(body) as { name: string; private: boolean }
          expect(parsed).toMatchObject({
            name: 'alice-example-com-assets',
            private: true,
          })
          existing.add(`/api/v1/repos/matos-users/${parsed.name}`)
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (
          req.method === 'PUT' &&
          req.url ===
            '/api/v1/repos/matos-users/alice-example-com-assets/collaborators/alice'
        ) {
          expect(JSON.parse(body)).toEqual({ permission: 'write' })
          res.statusCode = 204
          res.end('')
          return
        }
        if (
          req.method === 'PUT' &&
          req.url ===
            '/api/v1/repos/matos-users/alice-example-com-assets/collaborators/admin'
        ) {
          expect(JSON.parse(body)).toEqual({ permission: 'admin' })
          res.statusCode = 204
          res.end('')
          return
        }
        res.statusCode = 500
        res.end('unexpected')
      })
    })
    const port = await listen(server)
    const previousToken = process.env.MATOS_GITEA_TOKEN
    process.env.MATOS_GITEA_TOKEN = 'asset-scope-token'
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    try {
      const exitCode = await runMatOSAssetsCommand(
        [
          'git',
          'provision-scope',
          '--api-url',
          `http://127.0.0.1:${port}/api/v1`,
          '--base-url',
          'https://matos.top/git',
          '--scope',
          'user',
          '--scope-ref',
          'user:alice@example.com',
          '--member',
          'alice',
          '--admin',
          'admin',
          '--json',
        ],
        io,
      )
      expect(exitCode).toBe(0)
      const result = JSON.parse(stdout.join('')) as {
        ok: boolean
        repo: { owner: string; repo: string; cloneUrl: string }
        members: Array<{ username: string; permission: string; action: string }>
      }
      expect(result.ok).toBe(true)
      expect(result.repo).toMatchObject({
        owner: 'matos-users',
        repo: 'alice-example-com-assets',
        cloneUrl: 'https://matos.top/git/matos-users/alice-example-com-assets.git',
      })
      expect(result.members).toEqual([
        { username: 'alice', permission: 'write', action: 'added' },
        { username: 'admin', permission: 'admin', action: 'added' },
      ])
      expect(JSON.stringify(result)).not.toContain('asset-scope-token')
      expect(requests.every(request => request.authorization === 'token asset-scope-token')).toBe(
        true,
      )
      expect(stderr.join('')).toBe('')
    } finally {
      if (previousToken === undefined) {
        delete process.env.MATOS_GITEA_TOKEN
      } else {
        process.env.MATOS_GITEA_TOKEN = previousToken
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('deploys a tool pack into the global deployment asset root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-deploy-tool-'))
    const packRoot = await createToolPackFixture(root)
    const deployRoot = join(root, 'deploy')
    const globalRoot = join(deployRoot, 'assets', 'global')
    await writeDeploymentOnlyAssetConfig(root)
    process.env.MATOS_ALLOW_NON_VEPFS_DATA_ROOT = '1'
    process.env.MATOS_DEPLOY_ROOT = deployRoot
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(
        ['deploy-tool', packRoot, '--scope', 'global', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    const result = JSON.parse(stdout.join('')) as {
      ok: boolean
      scope: string
      packId: string
      targetPath: string
      validation: { ok: boolean }
      refreshedWorkspaces: unknown[]
    }
    expect(result).toMatchObject({
      ok: true,
      scope: 'global',
      packId: 'hot-tools',
      targetPath: '<workspace>/deploy/assets/global/packs/hot-tools',
      validation: { ok: true },
      refreshedWorkspaces: [],
    })
    expect(
      await exists(
        join(
          globalRoot,
          'packs',
          'hot-tools',
          'tools',
          'hot-tool',
          'asset.json',
        ),
      ),
    ).toBe(true)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'tool:hot-tool', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: { canonicalKey: string; packId: string; sourcePath: string }
    }
    expect(show.asset.canonicalKey).toBe('tool:hot-tool@0.1.0')
    expect(show.asset.packId).toBe('hot-tools')
    expect(show.asset.sourcePath).toBe(
      '<workspace>/deploy/assets/global/packs/hot-tools',
    )
    expect(stderr.join('')).toBe('')
  })

  test('can restart known workspace containers after deploying a tool pack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-deploy-refresh-'))
    const packRoot = await createToolPackFixture(root)
    const deployRoot = join(root, 'deploy')
    await writeDeploymentOnlyAssetConfig(root)
    process.env.MATOS_ALLOW_NON_VEPFS_DATA_ROOT = '1'
    process.env.MATOS_DEPLOY_ROOT = deployRoot
    const stdout: string[] = []
    const stderr: string[] = []
    const restarted: string[] = []

    expect(
      await runMatOSAssetsCommand(
        [
          'deploy-tool',
          packRoot,
          '--scope',
          'global',
          '--refresh-workspaces',
          '--json',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          workspaceContainers: {
            list: async () => [
              { scopeRef: 'user:alice' },
              { scopeRef: 'user:bob' },
            ],
            restart: async input => {
              restarted.push(input.scopeReference ?? '')
              return { scopeRef: input.scopeReference }
            },
          },
        },
      ),
    ).toBe(0)

    const result = JSON.parse(stdout.join('')) as {
      refreshedWorkspaces: Array<{ scopeRef: string }>
    }
    expect(restarted).toEqual(['user:alice', 'user:bob'])
    expect(result.refreshedWorkspaces).toEqual([
      { scopeRef: 'user:alice' },
      { scopeRef: 'user:bob' },
    ])
    expect(stderr.join('')).toBe('')
  })

  test('refuses to deploy packs containing secret-looking files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-deploy-secret-'))
    const packRoot = await createToolPackFixture(root)
    process.env.MATOS_ALLOW_NON_VEPFS_DATA_ROOT = '1'
    process.env.MATOS_DEPLOY_ROOT = join(root, 'deploy')
    await writeFile(
      join(packRoot, '.env.deploy'),
      'TOKEN=do-not-print\n',
      'utf8',
    )
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['deploy-tool', packRoot, '--scope', 'global'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)

    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('secret-looking file')
    expect(stderr.join('')).not.toContain('do-not-print')
  })

  test('list --compact keeps structural fields but strips heavy metadata', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []

    expect(
      await runMatOSAssetsCommand(['list', '--json', '--compact'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: () => {},
      }),
    ).toBe(0)

    const result = JSON.parse(stdout.join('')) as {
      assets: Array<Record<string, unknown>>
    }
    expect(result.assets.length).toBeGreaterThan(0)
    for (const asset of result.assets) {
      // Structural fields the bridge/UI catalog consumers rely on survive.
      expect(asset).toHaveProperty('id')
      expect(asset).toHaveProperty('type')
      expect(asset).toHaveProperty('dependencies')
      expect(asset).toHaveProperty('lifecycle')
      // Of metadata only sourceProvenance may remain; everything else
      // (summaries, intake payloads, catalogs) must be stripped.
      const metadata = asset.metadata as Record<string, unknown>
      expect(
        Object.keys(metadata).every(key => key === 'sourceProvenance'),
      ).toBe(true)
      // The daemon bridge resolves entry files (workflow card previews)
      // straight from the cached compact listing, so absolutePath stays.
      expect(asset).toHaveProperty('absolutePath')
      // The heavyweight full-row fields stay exclusive to the default mode.
      expect(asset).not.toHaveProperty('manifestPath')
    }
  })

  test('lists compact asset summaries for UI with pagination', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(
        [
          'list',
          '--json',
          '--summary',
          '--fields',
          'canonicalKey,type,name,description,lifecycle',
          '--limit',
          '1',
          '--offset',
          '1',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    const result = JSON.parse(stdout.join('')) as {
      assets: Array<Record<string, unknown>>
      page: { limit: number; offset: number; total: number; nextOffset?: number }
      groups: Array<{ type: string; count: number }>
    }

    expect(result.assets).toHaveLength(1)
    expect(Object.keys(result.assets[0] ?? {}).sort()).toEqual([
      'canonicalKey',
      'description',
      'lifecycle',
      'name',
      'type',
    ])
    expect(result.assets[0]).toMatchObject({
      canonicalKey: expect.any(String),
      type: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
      lifecycle: { status: 'enabled' },
    })
    expect(result.page).toMatchObject({
      limit: 1,
      offset: 1,
      total: 3,
    })
    expect(result.page.nextOffset).toBe(2)
    expect(result.groups).toEqual([
      { type: 'knowledge', count: 1 },
      { type: 'role', count: 1 },
      { type: 'runtime', count: 1 },
    ])
    expect(stderr.join('')).toBe('')
  })

  test('exposes graph index, related, impact, and graph-ranked search commands', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      cwd: root,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    }

    expect(await runMatOSAssetsCommand(['graph-index', '--json'], io)).toBe(0)
    const index = JSON.parse(stdout.join('')) as {
      nodes: Record<string, unknown>
      edges: Array<{ from: string; to: string; kind: string }>
      stats: { nodeCount: number; edgeCount: number }
    }
    expect(index.nodes['role:planner@0.1.0']).toBeDefined()
    expect(index.edges).toContainEqual(
      expect.objectContaining({
        from: 'role:planner@0.1.0',
        to: 'knowledge:matbench@0.1.0',
        kind: 'mounts_knowledge',
      }),
    )
    expect(index.stats.nodeCount).toBeGreaterThan(0)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(['graph-index', '--write', '--json'], io),
    ).toBe(0)
    const writtenIndex = JSON.parse(stdout.join('')) as {
      path?: string
      metaPath?: string
    }
    expect(writtenIndex.path).toBe('.matos/index/assets.graph.v1.json')
    expect(writtenIndex.metaPath).toBe('.matos/index/assets.graph.v1.meta.json')
    expect(writtenIndex.path).not.toContain(root)
    expect(writtenIndex.metaPath).not.toContain(root)
    const writtenMeta = JSON.parse(
      await readFile(
        join(root, '.matos', 'index', 'assets.graph.v1.meta.json'),
        'utf8',
      ),
    ) as {
      indexPath: string
      purpose: string
      graphSchemaVersion: number
      providerCount: number
      optionKey: string
      options: Record<string, unknown>
      sources: { assets: { count: number; newestMtimeMs?: number } }
    }
    expect(writtenMeta.indexPath).toBe('assets.graph.v1.json')
    expect(writtenMeta.purpose).toBe('audit')
    expect(writtenMeta.graphSchemaVersion).toBe(1)
    expect(writtenMeta.providerCount).toBeGreaterThan(0)
    expect(writtenMeta.optionKey).toBe(
      JSON.stringify({
        includeDisabled: false,
        includeLineage: false,
        includeUsage: false,
      }),
    )
    expect(writtenMeta.options).toEqual({})
    expect(writtenMeta.sources.assets.count).toBeGreaterThan(0)
    expect(JSON.stringify(writtenMeta)).not.toContain(root)
    stdout.length = 0

    expect(await runMatOSAssetsCommand(['graph-index', '--write'], io)).toBe(0)
    expect(stdout.join('')).toContain('.matos/index/assets.graph.v1.json')
    expect(stdout.join('')).toContain('.matos/index/assets.graph.v1.meta.json')
    expect(stdout.join('')).not.toContain(root)
    stdout.length = 0

    expect(await runMatOSAssetsCommand(['related', 'role:planner', '--json'], io))
      .toBe(0)
    const related = JSON.parse(stdout.join('')) as {
      root: string
      hits: Array<{ assetKey: string; explanations: unknown[] }>
    }
    expect(related.root).toBe('role:planner@0.1.0')
    expect(related.hits.map(hit => hit.assetKey)).toContain(
      'knowledge:matbench@0.1.0',
    )
    stdout.length = 0

    expect(await runMatOSAssetsCommand(['impact', 'knowledge:matbench', '--json'], io))
      .toBe(0)
    const impact = JSON.parse(stdout.join('')) as {
      root: string
      affectedAssetKeys: string[]
    }
    expect(impact.root).toBe('knowledge:matbench@0.1.0')
    expect(impact.affectedAssetKeys).toContain('role:planner@0.1.0')
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['search', 'benchmark', '--graph-rank', '--json'],
        io,
      ),
    ).toBe(0)
    const search = JSON.parse(stdout.join('')) as {
      hits: Array<{ assetKey: string; explanations: Array<{ kind: string }> }>
      assets: Array<{ id: string; score: number; explanations: Array<{ kind: string }> }>
    }
    expect(search.hits[0]?.assetKey).toBe('knowledge:matbench@0.1.0')
    expect(search.hits[0]?.explanations.map(item => item.kind)).toContain(
      'lexical',
    )
    expect(search.assets[0]).toMatchObject({
      id: 'matbench',
      canonicalKey: 'knowledge:matbench@0.1.0',
      score: expect.any(Number),
      explanations: expect.any(Array),
    })
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['search', '--query', 'benchmark', '--graph-rank', '--json'],
        io,
      ),
    ).toBe(0)
    const querySearch = JSON.parse(stdout.join('')) as {
      hits: Array<{ assetKey: string }>
    }
    expect(querySearch.hits[0]?.assetKey).toBe('knowledge:matbench@0.1.0')
    stdout.length = 0

    const sessionsDir = join(root, '.matos', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(
      join(sessionsDir, 'session-assets-cli.jsonl'),
      `${JSON.stringify({
        id: 'event-asset-cli',
        schemaVersion: 1,
        traceId: 'trace-assets-cli',
        sessionId: 'session-assets-cli',
        roleRef: 'role:planner',
        timestamp: '2026-06-06T00:00:00.000Z',
        type: 'matos.asset.used',
        data: {
          toolName: 'asset_read',
          assetKey: 'knowledge:matbench@0.1.0',
        },
      })}\n`,
      'utf8',
    )
    expect(
      await runMatOSAssetsCommand(
        ['graph-index', '--include-usage', '--json'],
        io,
      ),
    ).toBe(0)
    const usageIndex = JSON.parse(stdout.join('')) as {
      nodes: Record<string, { metadata?: Record<string, unknown> }>
      edges: Array<{ from: string; to: string; kind: string; source: string }>
    }
    expect(usageIndex.nodes['trace:trace-assets-cli']).toBeDefined()
    expect(usageIndex.edges).toContainEqual(
      expect.objectContaining({
        from: 'knowledge:matbench@0.1.0',
        to: 'trace:trace-assets-cli',
        kind: 'used_in_session',
        source: 'trace',
      }),
    )
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['graph-index', '--profile', 'core', '--include-usage', '--json'],
        io,
      ),
    ).toBe(0)
    const coreProfileIndex = JSON.parse(stdout.join('')) as {
      nodes: Record<string, { kind: string }>
      edges: Array<{ kind: string }>
    }
    expect(coreProfileIndex.nodes['trace:trace-assets-cli']).toBeUndefined()
    expect(Object.values(coreProfileIndex.nodes).every(node => node.kind === 'asset'))
      .toBe(true)
    expect(coreProfileIndex.edges.some(edge => edge.kind === 'used_in_session'))
      .toBe(false)
    expect(coreProfileIndex.edges.some(edge => edge.kind === 'same_tag')).toBe(false)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['graph-index', '--profile=evidence', '--json'],
        io,
      ),
    ).toBe(0)
    const evidenceProfileIndex = JSON.parse(stdout.join('')) as {
      nodes: Record<string, { kind: string }>
      edges: Array<{ kind: string }>
    }
    expect(evidenceProfileIndex.nodes['trace:trace-assets-cli']).toBeDefined()
    expect(evidenceProfileIndex.edges.some(edge => edge.kind === 'used_in_session'))
      .toBe(true)
    expect(evidenceProfileIndex.edges.some(edge => edge.kind === 'same_tag')).toBe(false)
    stdout.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['workbench', 'role:planner', '--mode', 'explore', '--json'],
        io,
      ),
    ).toBe(0)
    const workbench = JSON.parse(stdout.join('')) as {
      selectedAssetKey?: string
      graph: { nodes: Array<{ id: string }>; edges: Array<{ kind: string }> }
      inspector?: { title: string }
    }
    expect(workbench.selectedAssetKey).toBe('role:planner@0.1.0')
    expect(workbench.graph.nodes.map(node => node.id)).toContain(
      'knowledge:matbench@0.1.0',
    )
    expect(workbench.graph.edges).toContainEqual(
      expect.objectContaining({ kind: 'mounts_knowledge' }),
    )
    expect(workbench.inspector?.title).toBe('Planner')
    stdout.length = 0
    stderr.length = 0

    expect(
      await runMatOSAssetsCommand(
        ['workbench', 'knowledge:missing', '--json'],
        io,
      ),
    ).toBe(1)
    expect(stderr.join('')).toContain(
      'MatOS asset graph node not found: knowledge:missing',
    )
    stderr.length = 0
    expect(stderr.join('')).toBe('')
  })

  test('filters compact asset summaries by query and group', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(
        [
          'list',
          '--json',
          '--summary',
          '--query',
          'matbench',
          '--group-by',
          'source',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    const result = JSON.parse(stdout.join('')) as {
      assets: Array<{ canonicalKey: string; type: string; name: string }>
      page: { limit: number; offset: number; total: number }
      groups: Array<{ source: string; count: number }>
    }

    expect(result.assets.map(asset => asset.canonicalKey)).toEqual([
      'knowledge:matbench@0.1.0',
    ])
    expect(result.page).toMatchObject({ limit: 50, offset: 0, total: 1 })
    expect(result.groups).toEqual([{ source: 'project', count: 1 }])
    expect(stderr.join('')).toBe('')
  })

  test('search matches Feishu skill aliases across Chinese and English tokens', async () => {
    const root = await createAssetCliFixture()
    const skillDir = join(
      root,
      '.matos',
      'assets',
      'skills',
      'external-channels',
    )
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'external-channels',
      type: 'skill',
      name: 'External Channels',
      version: '1.0.0',
      description: 'Configure Feishu/Lark/飞书 remote CLI channels.',
      entry: 'SKILL.md',
      tags: ['feishu', 'lark', '飞书', '配置飞书通道'],
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# External Channels\n')
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(
        ['search', '飞书 feishu lark', '--type', 'skill', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    const result = JSON.parse(stdout.join('')) as {
      assets: Array<{ canonicalKey: string }>
    }
    expect(result.assets.map(asset => asset.canonicalKey)).toEqual([
      'skill:external-channels@1.0.0',
    ])
    expect(stderr.join('')).toBe('')
  })

  test('lists and shows assets as json', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['list', '--type', 'role', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)

    const list = JSON.parse(stdout.join('')) as {
      assets: Array<{ canonicalKey: string }>
    }
    expect(list.assets.map(asset => asset.canonicalKey)).toEqual([
      'role:planner@0.1.0',
    ])
    expect(stderr.join('')).toBe('')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'role:planner', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: { canonicalKey: string; mounts: { knowledge: string[] } }
      projectionHints: { selectedAgent: string }
    }
    expect(show.asset.canonicalKey).toBe('role:planner@0.1.0')
    expect(show.asset.mounts.knowledge).toEqual(['knowledge:matbench'])
    expect(show.projectionHints.selectedAgent).toBe('planner')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'knowledge:matbench', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const knowledgeShowRaw = stdout.join('')
    const knowledgeShow = JSON.parse(knowledgeShowRaw) as {
      asset: { metadata: Record<string, unknown>; absolutePath: string }
    }
    expect(knowledgeShow.asset.metadata.apiKey).toBe('<redacted>')
    expect(knowledgeShow.asset.metadata.hostPath).toBe('<redacted-path>')
    expect(knowledgeShow.asset.absolutePath).toBe(
      '<workspace>/.matos/assets/knowledges/matbench',
    )
    expect(knowledgeShowRaw).not.toContain('secret-value')
    expect(knowledgeShowRaw).not.toContain('/vepfs-mlp2')
    expect(knowledgeShowRaw).not.toContain(root)
  })

  test('shows draft roles without crashing on runtime projection', async () => {
    // Regression: `matos assets show role:<draft>` resolved the asset through
    // the includeDisabled registry, then crashed because the runtime-active
    // registry used for projection hints cannot resolve draft/disabled roles
    // (composeMatOSRoleRuntime threw "MatOS role asset not found").
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-draft-role-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'routing-draft')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(roleDir, 'asset.json'), {
      id: 'routing-draft',
      type: 'role',
      name: 'Routing Draft',
      version: '0.1.0',
      description: 'Draft routing role.',
      entry: 'prompt.md',
      lifecycle: { status: 'draft' },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'Draft routing role.\n')

    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await runMatOSAssetsCommand(['show', 'role:routing-draft', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: { canonicalKey: string }
      projectionHints: { skipped?: string; selectedAgent?: string }
    }
    expect(show.asset.canonicalKey).toBe('role:routing-draft@0.1.0')
    expect(show.projectionHints.skipped).toContain('not runtime-active')
    expect(show.projectionHints.selectedAgent).toBeUndefined()
    expect(stderr.join('')).toBe('')
  })

  test('hides bundled internal skills from user asset surfaces when configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-hidden-'))
    const assetRoot = join(root, 'bundled-assets')
    const packRoot = join(assetRoot, 'packs', 'matos-core')
    const skillDir = join(packRoot, 'skills', 'operator-runbook')
    await mkdir(skillDir, { recursive: true })
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [assetRoot],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(packRoot, 'matos.pack.json'), {
      id: 'matos-core',
      name: 'MatOS Core',
      version: '1.0.0',
    })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'operator-runbook',
      type: 'skill',
      name: 'Operator Runbook',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Internal Runbook\n')

    process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = '1'
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['list', '--type', 'skill', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).assets).toEqual([])

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'skill:operator-runbook', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    expect(stderr.join('')).toContain('MatOS asset not found')
  })

  test('keeps user-created assets visible while hiding non-user asset roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-user-visible-'))
    const userRoot = join(root, 'workspace-assets', 'user')
    const userSkillDir = join(userRoot, 'generated', 'skills', 'mine')
    const internalRoot = join(root, 'bundled-assets')
    const internalPackRoot = join(internalRoot, 'packs', 'matos-core')
    const internalSkillDir = join(internalPackRoot, 'skills', 'operator-runbook')
    await mkdir(userSkillDir, { recursive: true })
    await mkdir(internalSkillDir, { recursive: true })
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [userRoot, internalRoot],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(userSkillDir, 'asset.json'), {
      id: 'mine',
      type: 'skill',
      name: 'My Skill',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# My Skill\n')
    await writeJson(join(internalPackRoot, 'matos.pack.json'), {
      id: 'matos-core',
      name: 'MatOS Core',
      version: '1.0.0',
    })
    await writeJson(join(internalSkillDir, 'asset.json'), {
      id: 'operator-runbook',
      type: 'skill',
      name: 'Operator Runbook',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(internalSkillDir, 'SKILL.md'), '# Internal Runbook\n')

    process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = '1'
    process.env.MATOS_USER_VISIBLE_ASSET_ROOTS = userRoot
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['list', '--type', 'skill', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const listed = JSON.parse(stdout.join('')) as {
      assets: Array<{ canonicalKey: string; absolutePath?: string }>
    }
    expect(listed.assets.map(asset => asset.canonicalKey)).toEqual([
      'skill:mine@0.1.0',
    ])
    expect(listed.assets[0]?.absolutePath).toBe(
      '<workspace>/workspace-assets/user/generated/skills/mine',
    )

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'skill:operator-runbook', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    expect(stderr.join('')).toContain('MatOS asset not found')
  })

  test('validates, graphs, and writes index as json', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['validate', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: true, errors: [] })

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['graph', '--role', 'role:planner', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const graph = JSON.parse(stdout.join('')) as {
      root: string
      assets: Array<{ canonicalKey: string }>
      edges: Array<{ from: string; to: string; reference: string }>
    }
    expect(graph.root).toBe('role:planner@0.1.0')
    expect(graph.assets.map(asset => asset.canonicalKey)).toEqual([
      'role:planner@0.1.0',
      'knowledge:matbench@0.1.0',
    ])
    expect(graph.edges).toEqual([
      {
        from: 'role:planner@0.1.0',
        to: 'knowledge:matbench@0.1.0',
        reference: 'knowledge:matbench',
      },
    ])

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['index', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const index = JSON.parse(stdout.join('')) as { path: string }
    expect(index.path).toBe('<workspace>/.matos/index/assets.json')
    expect(await exists(join(root, '.matos', 'index', 'assets.json'))).toBe(true)
    expect(await readFile(join(root, '.matos', 'index', 'assets.json'), 'utf8')).toContain('role:planner@0.1.0')
    expect(stderr.join('')).toBe('')
  })

  test('manages asset lifecycle status through a project overlay', async () => {
    const root = await createAssetCliFixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(
        ['disable', 'knowledge:matbench', '--reason', 'bad data'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stdout.join('')).toContain('disabled knowledge:matbench@0.1.0')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'knowledge:matbench', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const disabledShow = JSON.parse(stdout.join('')) as {
      asset: { lifecycle: { status: string; reason: string } }
    }
    expect(disabledShow.asset.lifecycle.status).toBe('disabled')
    expect(disabledShow.asset.lifecycle.reason).toBe('bad data')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['graph', '--role', 'role:planner', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const disabledGraph = JSON.parse(stdout.join('')) as {
      assets: Array<{ canonicalKey: string }>
    }
    expect(disabledGraph.assets.map(asset => asset.canonicalKey)).toEqual([
      'role:planner@0.1.0',
    ])

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['enable', 'knowledge:matbench'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['deprecate', 'knowledge:matbench', '--reason', 'use newer corpus'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['list', '--type', 'knowledge'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(stdout.join('')).toContain('[deprecated]')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'knowledge:matbench'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(stdout.join('')).toContain('Status: deprecated')
    expect(stdout.join('')).toContain('Reason: use newer corpus')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['doctor', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    const doctor = JSON.parse(stdout.join('')) as {
      ok: boolean
      summary: { deprecated: number; disabled: number }
      validation: {
        errors: Array<{ code: string; assetKey?: string }>
      }
    }
    expect(doctor.ok).toBe(false)
    expect(doctor.summary.deprecated).toBe(1)
    expect(doctor.summary.disabled).toBe(0)
    expect(doctor.validation.errors).toContainEqual(
      expect.objectContaining({
        code: 'missing_mount',
        assetKey: 'role:planner@0.1.0',
      }),
    )
    expect(stderr.join('')).toBe('')
  })

  test('imports a raw file as a mounted asset', async () => {
    const root = await createAssetCliFixture()
    const paperPath = join(root, 'paper.md')
    const stdout: string[] = []
    const stderr: string[] = []
    await writeFile(paperPath, '# Paper\n\nMounted knowledge.\n', 'utf8')

    expect(
      await runMatOSAssetsCommand(
        [
          'import',
          paperPath,
          '--type',
          'knowledge',
          '--id',
          'paper',
          '--name',
          'Paper',
          '--version',
          '0.1.0',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stdout.join('')).toContain('imported knowledge:paper@0.1.0')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['show', 'knowledge:paper', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const show = JSON.parse(stdout.join('')) as {
      asset: { canonicalKey: string; source: string; absolutePath: string }
    }
    expect(show.asset.canonicalKey).toBe('knowledge:paper@0.1.0')
    expect(show.asset.source).toBe('mount')
    expect(show.asset.absolutePath).toBe('<workspace>/paper.md')
    expect(stderr.join('')).toBe('')
  })

  test('manages Git-backed asset history snapshots, diffs, restore, and releases', async () => {
    const root = await createAssetCliFixture()
    const plannerPrompt = join(root, '.matos', 'assets', 'roles', 'planner', 'prompt.md')
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['history', 'status', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      initialized: false,
      snapshotCount: 0,
      releaseCount: 0,
    })

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'snapshot', '--scope', 'project', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const before = JSON.parse(stdout.join('')) as {
      snapshot: {
        snapshotId: string
        commit: string
        scope: string
        assetRefs: string[]
      }
    }
    expect(before.snapshot.scope).toBe('project')
    expect(before.snapshot.assetRefs).toContain('role:planner')
    expect(before.snapshot.assetRefs).toContain('knowledge:matbench')

    await writeFile(plannerPrompt, 'You plan materials work. Prefer local GPUs.\n')
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'snapshot', '--scope', 'project', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const after = JSON.parse(stdout.join('')) as {
      snapshot: { snapshotId: string; commit: string }
    }
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(after.snapshot.commit)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'diff', before.snapshot.snapshotId, after.snapshot.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).diff.patch).toContain('+You plan materials work. Prefer local GPUs.')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'list', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).snapshots).toHaveLength(2)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'list', '--asset', 'role:planner', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).snapshots).toHaveLength(2)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'list', '--asset', 'workflow:missing', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).snapshots).toHaveLength(0)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'show', before.snapshot.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).snapshot.commit).toBe(before.snapshot.commit)

    const generatedBadRoleDir = join(root, '.matos', 'assets', 'roles', 'generated-bad')
    await mkdir(generatedBadRoleDir, { recursive: true })
    await writeJson(join(generatedBadRoleDir, 'asset.json'), {
      id: 'generated-bad',
      type: 'role',
      version: '0.1.0',
      entry: 'prompt.md',
    })
    await writeFile(join(generatedBadRoleDir, 'prompt.md'), 'Broken generated role.\n')

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['history', 'restore', before.snapshot.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(await readFile(plannerPrompt, 'utf8')).toBe('You plan materials work.\n')
    expect(await exists(join(generatedBadRoleDir, 'asset.json'))).toBe(false)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'after-local-gpu', '--ref', after.snapshot.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const release = JSON.parse(stdout.join('')) as {
      release: { releaseId: string; name: string; commit: string }
    }
    expect(release.release.name).toBe('after-local-gpu')
    expect(release.release.commit).toBe(after.snapshot.commit)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['release', 'list', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).releases.map((item: { releaseId: string }) => item.releaseId)).toEqual([
      release.release.releaseId,
    ])

    await writeFile(plannerPrompt, 'broken\n')
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'rollback', release.release.releaseId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(await readFile(plannerPrompt, 'utf8')).toBe(
      'You plan materials work. Prefer local GPUs.\n',
    )
    expect(stderr.join('')).toBe('')
  })

  test('does not publish a release or stable ref when release validation fails', async () => {
    const root = await createAssetCliFixture()
    const assetPath = join(root, '.matos', 'assets', 'roles', 'planner', 'asset.json')
    const stdout: string[] = []
    const stderr: string[] = []
    await writeJson(assetPath, {
      id: 'planner',
      type: 'role',
      version: '0.1.0',
      entry: 'prompt.md',
    })

    const invalid = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
    })

    await writeJson(assetPath, {
      id: 'planner',
      type: 'role',
      name: 'Planner',
      version: '0.1.0',
      description: 'Plans materials work.',
      entry: 'prompt.md',
      mounts: {
        knowledge: ['knowledge:matbench'],
        tools: ['Read'],
      },
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        [
          'release',
          'create',
          '--name',
          'invalid-release',
          '--ref',
          invalid.snapshotId,
          '--json',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(1)

    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('validation failed')
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(['release', 'list', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).releases).toEqual([])
    await expect(
      git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable']),
    ).rejects.toThrow()
  })

  test('rolls a release back to the previous stable snapshot', async () => {
    const root = await createAssetCliFixture()
    const plannerPrompt = join(root, '.matos', 'assets', 'roles', 'planner', 'prompt.md')
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(
        ['history', 'snapshot', '--scope', 'project', '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const stableBefore = JSON.parse(stdout.join('')) as {
      snapshot: { snapshotId: string; commit: string }
    }
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        [
          'release',
          'create',
          '--name',
          'stable-before',
          '--ref',
          stableBefore.snapshot.snapshotId,
          '--json',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    await writeFile(plannerPrompt, 'You plan materials work. Bad release.\n')
    const bad = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
      parentCommit: stableBefore.snapshot.commit,
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        [
          'release',
          'create',
          '--name',
          'bad-release',
          '--ref',
          bad.snapshotId,
          '--json',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const badRelease = JSON.parse(stdout.join('')) as {
      release: { releaseId: string; commit: string; previousStableCommit: string }
    }
    expect(badRelease.release.previousStableCommit).toBe(stableBefore.snapshot.commit)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'rollback', badRelease.release.releaseId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    expect(await readFile(plannerPrompt, 'utf8')).toBe('You plan materials work.\n')
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(stableBefore.snapshot.commit)
    expect(stderr.join('')).toBe('')
  })

  test('refuses to roll back an older release when stable has moved on', async () => {
    const root = await createAssetCliFixture()
    const plannerPrompt = join(root, '.matos', 'assets', 'roles', 'planner', 'prompt.md')
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSAssetsCommand(['history', 'snapshot', '--scope', 'project', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const stableBefore = JSON.parse(stdout.join('')) as {
      snapshot: { commit: string }
    }

    await writeFile(plannerPrompt, 'You plan materials work. Release A.\n')
    const snapshotA = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
      parentCommit: stableBefore.snapshot.commit,
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'release-a', '--ref', snapshotA.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const releaseA = JSON.parse(stdout.join('')) as {
      release: { releaseId: string; commit: string }
    }

    await writeFile(plannerPrompt, 'You plan materials work. Release B.\n')
    const snapshotB = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
      parentCommit: snapshotA.commit,
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'release-b', '--ref', snapshotB.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'rollback', releaseA.release.releaseId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(1)

    expect(stderr.join('')).toContain('stale')
    expect(await readFile(plannerPrompt, 'utf8')).toBe(
      'You plan materials work. Release B.\n',
    )
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(snapshotB.commit)
  })

  test('allows rollback past pre-existing unrelated invalid assets', async () => {
    const root = await createAssetCliFixture()
    const plannerPrompt = join(root, '.matos', 'assets', 'roles', 'planner', 'prompt.md')
    const stdout: string[] = []
    const stderr: string[] = []

    const stableBefore = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
    })
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'stable-before-transaction', '--ref', stableBefore.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    await writeFile(plannerPrompt, 'You plan materials work. Released state.\n')
    const released = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
      parentCommit: stableBefore.commit,
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'released-state', '--ref', released.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const release = JSON.parse(stdout.join('')) as {
      release: { releaseId: string; commit: string }
    }

    // Invalid leftover from another process. It existed before the rollback,
    // so the differential post-restore gate must classify it as environmental
    // and let the rollback proceed instead of wedging release recovery.
    const invalidRoleDir = join(root, '.matos', 'assets', 'roles', 'invalid-current')
    await mkdir(invalidRoleDir, { recursive: true })
    await writeJson(join(invalidRoleDir, 'asset.json'), {
      id: 'invalid-current',
      type: 'role',
      version: '0.1.0',
      entry: 'prompt.md',
    })
    await writeFile(join(invalidRoleDir, 'prompt.md'), 'Invalid role left by another process.\n')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'rollback', release.release.releaseId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    const rollbackOutput = JSON.parse(stdout.join('')) as {
      validation: { ok: boolean }
      restoredSnapshot: { snapshotId: string }
    }
    expect(rollbackOutput.validation.ok).toBe(true)
    expect(rollbackOutput.restoredSnapshot.snapshotId).toBe(stableBefore.snapshotId)
    expect(await readFile(plannerPrompt, 'utf8')).toBe('You plan materials work.\n')
    // The unrelated junk is left in place for operators, not silently deleted.
    expect(await readFile(join(invalidRoleDir, 'prompt.md'), 'utf8')).toBe(
      'Invalid role left by another process.\n',
    )
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(stableBefore.commit)
  })

  test('restores the released snapshot if rollback introduces validation errors', async () => {
    const root = await createAssetCliFixture()
    const plannerPrompt = join(root, '.matos', 'assets', 'roles', 'planner', 'prompt.md')
    const helperKnowledgeDir = join(root, '.matos', 'assets', 'knowledges', 'helper-notes')
    const stdout: string[] = []
    const stderr: string[] = []

    const stableBefore = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
    })
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'stable-before-transaction', '--ref', stableBefore.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    // The released state ships a new knowledge asset on top of stable-before.
    await mkdir(helperKnowledgeDir, { recursive: true })
    await writeJson(join(helperKnowledgeDir, 'asset.json'), {
      id: 'helper-notes',
      type: 'knowledge',
      name: 'Helper Notes',
      version: '0.1.0',
      description: 'Operating notes shipped with the release.',
      entry: 'README.md',
    })
    await writeFile(join(helperKnowledgeDir, 'README.md'), 'Helper notes.\n')
    await writeFile(plannerPrompt, 'You plan materials work. Released state.\n')
    const released = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
      parentCommit: stableBefore.commit,
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'released-state', '--ref', released.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const release = JSON.parse(stdout.join('')) as {
      release: { releaseId: string; commit: string }
    }

    // Untracked role that is valid right now because the released knowledge
    // asset satisfies its dependency. Restoring stable-before removes that
    // knowledge asset, so the rollback itself introduces a validation error
    // that is not part of the pre-restore baseline.
    const leftoverRoleDir = join(root, '.matos', 'assets', 'roles', 'leftover-role')
    await mkdir(leftoverRoleDir, { recursive: true })
    await writeJson(join(leftoverRoleDir, 'asset.json'), {
      id: 'leftover-role',
      type: 'role',
      name: 'Leftover Role',
      version: '0.1.0',
      description: 'Depends on the released knowledge asset.',
      entry: 'prompt.md',
      dependencies: ['knowledge:helper-notes'],
    })
    await writeFile(join(leftoverRoleDir, 'prompt.md'), 'Uses helper notes.\n')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'rollback', release.release.releaseId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(1)

    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('rollback validation failed')
    expect(await readFile(plannerPrompt, 'utf8')).toBe(
      'You plan materials work. Released state.\n',
    )
    expect(await readFile(join(helperKnowledgeDir, 'README.md'), 'utf8')).toBe(
      'Helper notes.\n',
    )
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(released.commit)
  })

  test('refuses stale release creation unless explicitly forced', async () => {
    const root = await createAssetCliFixture()
    const plannerPrompt = join(root, '.matos', 'assets', 'roles', 'planner', 'prompt.md')
    const stdout: string[] = []
    const stderr: string[] = []

    const snapshotA = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
    })
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'release-a', '--ref', snapshotA.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    await writeFile(plannerPrompt, 'You plan materials work. Release B.\n')
    const snapshotB = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'project',
      parentCommit: snapshotA.commit,
    })
    stdout.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'release-b', '--ref', snapshotB.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSAssetsCommand(
        ['release', 'create', '--name', 'release-a-again', '--ref', snapshotA.snapshotId, '--json'],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(1)
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('stale')
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(snapshotB.commit)

    stderr.length = 0
    expect(
      await runMatOSAssetsCommand(
        [
          'release',
          'create',
          '--name',
          'release-a-forced',
          '--ref',
          snapshotA.snapshotId,
          '--force-stale',
          '--json',
        ],
        {
          cwd: root,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/project/stable'])).trim(),
    ).toBe(snapshotA.commit)
  })

  test('rejects malformed release records before rollback/show use them', async () => {
    const root = await createAssetCliFixture()
    const releaseDir = join(root, '.matos', 'asset-history', 'releases')
    const stdout: string[] = []
    const stderr: string[] = []
    await mkdir(releaseDir, { recursive: true })
    await writeJson(join(releaseDir, 'asset-release-bad.json'), {
      releaseId: 'asset-release-bad',
      name: 'bad',
    })

    expect(
      await runMatOSAssetsCommand(['release', 'show', 'asset-release-bad', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)

    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toContain('Invalid MatOS asset history release')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSAssetsCommand(['release', 'list', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const releaseList = JSON.parse(stdout.join('')) as {
      releases: unknown[]
      recordIssues: Array<{ kind: string; file: string; message: string }>
    }
    expect(releaseList.releases).toEqual([])
    expect(releaseList.recordIssues).toEqual([
      expect.objectContaining({
        kind: 'release',
        file: 'asset-release-bad.json',
      }),
    ])
    expect(releaseList.recordIssues[0]?.message).toContain(
      'Invalid MatOS asset history release',
    )
  })

  test('surfaces malformed snapshot records in history list output', async () => {
    const root = await createAssetCliFixture()
    const recordDir = join(root, '.matos', 'asset-history', 'records')
    const stdout: string[] = []
    const stderr: string[] = []
    await mkdir(recordDir, { recursive: true })
    await writeJson(join(recordDir, 'asset-snapshot-bad.json'), {
      snapshotId: 'asset-snapshot-bad',
      schemaVersion: 1,
    })

    expect(
      await runMatOSAssetsCommand(['history', 'list', '--json'], {
        cwd: root,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const historyList = JSON.parse(stdout.join('')) as {
      snapshots: unknown[]
      recordIssues: Array<{ kind: string; file: string; message: string }>
    }
    expect(historyList.snapshots).toEqual([])
    expect(historyList.recordIssues).toEqual([
      expect.objectContaining({
        kind: 'snapshot',
        file: 'asset-snapshot-bad.json',
      }),
    ])
    expect(historyList.recordIssues[0]?.message).toContain(
      'Invalid MatOS asset history snapshot',
    )
    expect(stderr.join('')).toBe('')
  })
})
