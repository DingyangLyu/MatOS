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
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { materializeMatOSAssetSource } from '../assets/sourceAdapters.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { readMatOSProjectConfig } from '../project.js'
import { commitAcceptedDirectEditorGitAssetSources } from './directAssetEditorSourceAcceptance.js'
import {
  syncGeneratedScopedAssetsToGitea,
  type MatOSGeneratedScopedAssetRollback,
} from './generatedScopedAssetSync.js'

const execFileAsync = promisify(execFile)

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 20 * 1024 * 1024,
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

describe('generated scoped asset Gitea sync', () => {
  test('an explicit publish selection never sweeps an unrelated staged asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-selection-'))
    const base = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
    )
    const selected = join(base, 'project-share-forks', 'run-1', 'skill', 'selected')
    const unrelated = join(base, 'knowledge', 'unrelated')
    for (const [dir, type, id] of [
      [selected, 'skill', 'selected'],
      [unrelated, 'knowledge', 'unrelated'],
    ] as const) {
      await mkdir(dir, { recursive: true })
      await writeJson(join(dir, 'asset.json'), {
        schemaVersion: 1,
        id,
        type,
        name: id,
        version: '1.0.0',
      })
    }
    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'selection-only',
      generatedAssetDirs: [selected],
      env: {},
    })
    expect(result.ok).toBe(false)
    expect(result.skippedAssets.map(item => item.generatedDir)).toContain(selected)
    expect(result.skippedAssets.map(item => item.generatedDir)).not.toContain(unrelated)
    expect(await pathExists(unrelated)).toBe(true)
  })

  test('normalizes generated metadata-only mounts into native runtime mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-native-mounts-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-native-mounts-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'native scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed native assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo,
          ref: 'main',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/alice-assets/stable',
            commit: seedCommit,
          },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })
    const base = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
    )
    const assets = [
      {
        dir: join(base, 'tools', 'vasp-preflight'),
        manifest: {
          schemaVersion: 1,
          id: 'vasp-preflight',
          type: 'tool',
          name: 'VASP Preflight Tool',
          version: '1.0.0',
          entry: 'TOOL.md',
        },
        file: 'TOOL.md',
      },
      {
        dir: join(base, 'knowledge', 'vasp-runbook'),
        manifest: {
          schemaVersion: 1,
          id: 'vasp-runbook',
          type: 'knowledge',
          name: 'VASP Runbook',
          version: '1.0.0',
          entry: 'KNOWLEDGE.md',
        },
        file: 'KNOWLEDGE.md',
      },
      {
        dir: join(base, 'skills', 'vasp-preflight'),
        manifest: {
          schemaVersion: 1,
          id: 'vasp-preflight',
          type: 'skill',
          name: 'VASP Preflight Skill',
          version: '1.0.0',
          entry: 'SKILL.md',
          metadata: {
            dependencies: {
              tool: ['tool:vasp-preflight@1.0.0'],
              knowledge: ['knowledge:vasp-runbook@1.0.0'],
            },
          },
        },
        file: 'SKILL.md',
      },
      {
        dir: join(base, 'workflows', 'vasp-preflight-flow'),
        manifest: {
          schemaVersion: 1,
          id: 'vasp-preflight-flow',
          type: 'workflow',
          name: 'VASP Preflight Flow',
          version: '1.0.0',
          entry: 'workflow.md',
          metadata: {
            definitionFile: 'workflow.yaml',
            requiredSkills: ['skill:vasp-preflight@1.0.0'],
            requiredTools: ['tool:vasp-preflight@1.0.0'],
            requiredKnowledge: ['knowledge:vasp-runbook@1.0.0'],
          },
        },
        file: 'workflow.md',
      },
      {
        dir: join(base, 'roles', 'vasp-role'),
        manifest: {
          schemaVersion: 1,
          id: 'vasp-role',
          type: 'role',
          name: 'VASP Role',
          version: '1.0.0',
          entry: 'ROLE.md',
          metadata: {
            mountedSkills: ['skill:vasp-preflight@1.0.0'],
            mountedTools: ['tool:vasp-preflight@1.0.0'],
            mountedKnowledge: ['knowledge:vasp-runbook@1.0.0'],
            mountedWorkflows: ['workflow:vasp-preflight-flow@1.0.0'],
          },
        },
        file: 'ROLE.md',
      },
    ]
    for (const asset of assets) {
      await mkdir(asset.dir, { recursive: true })
      await writeJson(join(asset.dir, 'asset.json'), asset.manifest)
      await writeFile(join(asset.dir, asset.file), `# ${asset.manifest.name}\n`, 'utf8')
    }
    await writeFile(
      join(base, 'workflows', 'vasp-preflight-flow', 'workflow.yaml'),
      [
        'schemaVersion: 1',
        'name: vasp-preflight-flow',
        'nodes:',
        '  check:',
        '    type: exec',
        '    command: echo ok',
      ].join('\n'),
      'utf8',
    )

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'native-mounts',
    })

    expect(result).toMatchObject({ ok: true })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root), {
      includeDisabled: true,
    })
    const role = registry.resolve('role:vasp-role@1.0.0')
    const skill = registry.resolve('skill:vasp-preflight@1.0.0')
    const workflow = registry.resolve('workflow:vasp-preflight-flow@1.0.0')
    expect(role?.mounts).toMatchObject({
      skills: ['skill:vasp-preflight@1.0.0'],
      tools: ['tool:vasp-preflight@1.0.0'],
      knowledge: ['knowledge:vasp-runbook@1.0.0'],
      workflows: ['workflow:vasp-preflight-flow@1.0.0'],
    })
    expect(role?.dependencies).toContain('skill:vasp-preflight@1.0.0')
    expect(skill?.dependencies).toContain('tool:vasp-preflight@1.0.0')
    expect(workflow?.dependencies).toContain('skill:vasp-preflight@1.0.0')
    expect(workflow?.entryRelativePath).toBe('workflow.yaml')
    expect((await validateMatOSAssets(await loadMatOSAssets(root))).ok).toBe(true)
  })

  test('repairs a missing scoped Gitea source before syncing generated assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-repair-source-'))
    const giteaRoot = await mkdtemp(join(tmpdir(), 'matos-generated-sync-repair-gitea-'))
    const ownerRoot = join(giteaRoot, 'matos-users')
    const bareRepo = join(ownerRoot, 'alice-assets.git')
    await mkdir(ownerRoot, { recursive: true })
    await execFileAsync('git', ['init', '--bare', bareRepo])

    const seedRepo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-repair-seed-'))
    await git(seedRepo, ['init', '-b', 'main'])
    await writeFile(join(seedRepo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await commitAll(seedRepo, 'seed alice assets')
    await git(seedRepo, ['remote', 'add', 'origin', bareRepo])
    await git(seedRepo, ['push', 'origin', 'main'])
    await writeFile(join(seedRepo, 'ACCEPTED.md'), 'accepted runtime baseline\n', 'utf8')
    await commitAll(seedRepo, 'advance accepted runtime baseline')
    await git(seedRepo, [
      'push',
      'origin',
      'HEAD:refs/heads/accepted/matos-user-assets-alice/stable',
    ])

    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [],
    })

    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'knowledge',
      'compute-preflight-runbook',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'compute-preflight-runbook',
      type: 'knowledge',
      name: 'Compute Preflight Runbook',
      version: '0.1.0',
      entry: 'KNOWLEDGE.md',
    })
    await writeFile(
      join(generatedDir, 'KNOWLEDGE.md'),
      '# Compute Preflight Runbook\n\nAlways inspect toolchain/profile/runbook context before VASP, QE, or HPC submissions.\n',
      'utf8',
    )

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'repair-missing-source',
      env: {
        MATOS_GITEA_SOURCE_BASE_URL: `file://${giteaRoot}`,
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.ok).toBe(true)
    expect(result.targetSourceId).toBe('matos-user-assets-alice')
    expect(result.copiedAssets.map(asset => asset.canonicalRef)).toEqual([
      'knowledge:compute-preflight-runbook@0.1.0',
    ])
    expect(result.sourceAcceptance?.[0]).toMatchObject({
      ok: true,
      acceptedBranch: 'accepted/matos-user-assets-alice/stable',
    })
    const config = await readMatOSProjectConfig(root)
    expect(config.assetSources?.[0]).toMatchObject({
      id: 'matos-user-assets-alice',
      scope: 'user',
      scopeRef: 'user:alice',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-user-assets-alice/stable',
      },
    })
    const loaded = await loadMatOSAssets(root)
    const syncedRunbook = loaded.find(
      asset =>
        asset.canonicalKey === 'knowledge:compute-preflight-runbook@0.1.0',
    )
    expect(syncedRunbook).toBeDefined()
    // The sync side channel never runs Gate 1/Gate 2, so runtime assets must
    // arrive parked as draft, not live.
    expect(syncedRunbook?.lifecycle.status).toBe('draft')
    expect((await validateMatOSAssets(loaded)).ok).toBe(true)
  })

  test('repairs a missing scoped Gitea source through a mounted file source without exposing a token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-file-source-root-'))
    const fileSourceRoot = await mkdtemp(join(tmpdir(), 'matos-generated-sync-file-source-'))
    const bareRepo = join(fileSourceRoot, 'matos-user-assets-alice.git')
    await execFileAsync('git', ['init', '--bare', bareRepo])

    const seedRepo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-file-source-seed-'))
    await git(seedRepo, ['init', '-b', 'main'])
    await writeFile(join(seedRepo, 'README.md'), 'alice mounted file-source assets\n', 'utf8')
    await commitAll(seedRepo, 'seed mounted file-source assets')
    const seedCommit = await git(seedRepo, ['rev-parse', 'HEAD'])
    await git(seedRepo, ['remote', 'add', 'origin', bareRepo])
    await git(seedRepo, ['push', 'origin', 'main'])
    await git(seedRepo, [
      'push',
      'origin',
      `HEAD:refs/heads/accepted/matos-user-assets-alice/stable`,
    ])

    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [],
    })

    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'workflow',
      'hello-workflow',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'hello-workflow',
      type: 'workflow',
      name: 'Hello Workflow',
      version: '0.1.0',
      entry: 'workflow.json',
    })
    await writeJson(join(generatedDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'Hello Workflow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'echo',
          type: 'exec',
          dependsOn: [],
          command: 'printf hello-file-source',
        },
      ],
      outputs: {
        text: { value: '{{ nodes.echo.outputs.stdout }}' },
      },
    })

    const previousWorkspaceDir = process.env.MATOS_WORKSPACE_DIR
    const previousFileSourceRoot = process.env.MATOS_GITEA_FILE_SOURCE_ROOT
    const previousToken = process.env.MATOS_GITEA_TOKEN
    const previousGatewayToken = process.env.MATOS_GATEWAY_GITEA_TOKEN
    process.env.MATOS_WORKSPACE_DIR = '/workspace/group/shared'
    process.env.MATOS_GITEA_FILE_SOURCE_ROOT = fileSourceRoot
    delete process.env.MATOS_GITEA_TOKEN
    delete process.env.MATOS_GATEWAY_GITEA_TOKEN
    try {
      const result = await syncGeneratedScopedAssetsToGitea({
        cwd: root,
        scope: 'user',
        scopeRef: 'user:alice',
        runId: 'repair-missing-file-source',
        env: {
          MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
          MATOS_GITEA_CONTAINER_SOURCE_BASE_URL: 'http://matos-gitea:3000',
          MATOS_GITEA_FILE_SOURCE_ROOT: fileSourceRoot,
        },
      })

      expect(result.ok).toBe(true)
      expect(result.targetSourceId).toBe('matos-user-assets-alice')
      expect(result.copiedAssets.map(asset => asset.canonicalRef)).toEqual([
        'workflow:hello-workflow@0.1.0',
      ])
      expect(result.sourceCommitErrors).toBeUndefined()
      const acceptedCommit = await git(bareRepo, [
        'rev-parse',
        'accepted/matos-user-assets-alice/stable',
      ])
      expect(acceptedCommit).not.toBe(seedCommit)
      expect(
        await git(bareRepo, [
          'show',
          `${acceptedCommit}:workflow/hello-workflow/workflow.json`,
        ]),
      ).toContain('hello-file-source')
      const config = await readMatOSProjectConfig(root)
      expect(config.assetSources?.[0]).toMatchObject({
        id: 'matos-user-assets-alice',
        repo: 'http://matos-gitea:3000/matos-users/alice-assets.git',
        scope: 'user',
        scopeRef: 'user:alice',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/matos-user-assets-alice/stable',
          commit: acceptedCommit,
        },
      })
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

  test('does not copy generated assets into a Gitea source cache before push credentials are available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-preflight-token-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo: 'http://matos-gitea:3000/matos-users/alice-assets.git',
          ref: 'main',
          provider: 'gitea',
          gitea: {
            owner: 'matos-users',
            repo: 'alice-assets',
            visibility: 'private',
          },
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/alice-assets/stable',
            commit: '1111111111111111111111111111111111111111',
          },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })
    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'skills',
      'vasp-preflight',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-preflight',
      type: 'skill',
      name: 'VASP Preflight',
      version: '1.0.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(generatedDir, 'SKILL.md'), '# VASP Preflight\n', 'utf8')

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'missing-token-before-copy',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.ok).toBe(false)
    expect(result.copiedAssets).toEqual([])
    expect(await pathExists(generatedDir)).toBe(true)
    expect(
      await pathExists(
        join(
          root,
          '.matos',
          'source-cache',
          'scopes',
          'users',
          'alice',
          'git',
          'alice-assets',
        ),
      ),
    ).toBe(false)
    expect(result.sourceCommitErrors?.[0]?.error).toContain(
      'before copying assets',
    )
  })

  test('fails before git prompts when a Gitea HTTP source needs push credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-token-root-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo: 'http://matos-gitea:3000/matos-users/alice-assets.git',
          ref: 'main',
          provider: 'gitea',
          gitea: {
            owner: 'matos-users',
            repo: 'alice-assets',
            visibility: 'private',
          },
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/alice-assets/stable',
            commit: '1111111111111111111111111111111111111111',
          },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })

    const result = await commitAcceptedDirectEditorGitAssetSources({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'missing-token',
      summary: 'missing token',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.matchedGitSourceCount).toBe(1)
    expect(result.sourceCommitErrors?.[0]).toMatchObject({
      sourceId: 'alice-assets',
    })
    expect(result.sourceCommitErrors?.[0]?.error).toContain(
      'MATOS_GITEA_TOKEN or MATOS_GATEWAY_GITEA_TOKEN',
    )
    expect(result.sourceCommitErrors?.[0]?.error).not.toContain('Username')
  })

  test('never matches another user\'s scoped source during acceptance', async () => {
    // Multi-user concurrency guarantee: a user-scope run can only commit into
    // sources whose scopeRef equals its own scope. Bob's source must be
    // invisible to Alice's run even when it is the only configured source.
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-cross-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [],
      assetSources: [
        {
          type: 'git',
          id: 'bob-assets',
          repo: 'http://matos-gitea:3000/matos-users/bob-assets.git',
          ref: 'main',
          provider: 'gitea',
          gitea: { owner: 'matos-users', repo: 'bob-assets', visibility: 'private' },
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/bob-assets/stable',
            commit: '2222222222222222222222222222222222222222',
          },
          scope: 'user',
          scopeRef: 'user:bob',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })

    const result = await commitAcceptedDirectEditorGitAssetSources({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'cross-scope-guard',
      summary: 'cross scope guard',
      env: { MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1' },
    })

    expect(result.matchedGitSourceCount).toBe(0)
    expect(result.sourceCommits).toBeUndefined()
    expect(result.sourceCommitErrors).toBeUndefined()
  })

  test('accepts generated user assets through the scoped Gitea runtime ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo,
          ref: 'main',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/alice-assets/stable',
            commit: seedCommit,
          },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })
    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'tools',
      'vasp-preflight',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-preflight',
      type: 'tool',
      name: 'VASP Preflight',
      version: '1.0.0',
      entry: 'TOOL.md',
      metadata: {
        scopeRef: 'user:alice',
        source: 'agent-generated',
      },
    })
    await writeFile(
      join(generatedDir, 'TOOL.md'),
      '# VASP Preflight\n\nCheck pseudopotential family before VASP runs.\n',
      'utf8',
    )

    let rollback: MatOSGeneratedScopedAssetRollback | undefined
    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'generated-sync-test',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
      registerRollback: compensation => {
        rollback = compensation
      },
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.copiedAssets.map(asset => asset.canonicalRef)).toEqual([
      'tool:vasp-preflight@1.0.0',
    ])
    expect(await pathExists(generatedDir)).toBe(false)
    const acceptedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(acceptedCommit).not.toBe(seedCommit)
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:tool/vasp-preflight/TOOL.md',
      ]),
    ).toContain('Check pseudopotential family')
    const config = await readMatOSProjectConfig(root)
    expect(config.assetSources?.[0]).toMatchObject({
      type: 'git',
      id: 'alice-assets',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: acceptedCommit,
      },
    })
    const assets = await loadMatOSAssets(root)
    expect((await validateMatOSAssets(assets)).ok).toBe(true)
    expect(
      assets.some(
        asset =>
          asset.type === 'tool' &&
          asset.id === 'vasp-preflight' &&
          asset.version === '1.0.0',
      ),
    ).toBe(true)

    expect(rollback).toBeDefined()
    expect(await rollback!()).toEqual({ ok: true, errors: [] })
    expect(await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])).toBe(
      seedCommit,
    )
    const rolledBackConfig = await readMatOSProjectConfig(root)
    expect(rolledBackConfig.assetSources?.[0]).toMatchObject({
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: seedCommit,
      },
    })
    expect(
      (await loadMatOSAssets(root)).some(
        asset => asset.type === 'tool' && asset.id === 'vasp-preflight',
      ),
    ).toBe(false)
    // The compensation is one-shot and safe if two outer recovery paths race.
    expect(await rollback!()).toEqual({ ok: true, errors: [] })
  })

  test('validates accepted scoped sources against runtime dependency sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-deps-root-'))
    const userRepo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-deps-user-'))
    const sharedRepo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-deps-shared-'))
    await mkdir(join(root, '.matos'), { recursive: true })

    await writeFile(join(userRepo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await git(userRepo, ['init', '-b', 'main'])
    await commitAll(userRepo, 'seed alice assets')
    const userSeedCommit = await git(userRepo, ['rev-parse', 'HEAD'])
    await git(userRepo, ['branch', 'accepted/alice-assets/stable', userSeedCommit])

    const sharedSkillDir = join(sharedRepo, 'skills', 'shared-helper')
    await mkdir(sharedSkillDir, { recursive: true })
    await writeJson(join(sharedSkillDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'shared-helper',
      type: 'skill',
      name: 'Shared Helper',
      version: '1.0.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(sharedSkillDir, 'SKILL.md'), '# Shared Helper\n', 'utf8')
    await git(sharedRepo, ['init', '-b', 'main'])
    await commitAll(sharedRepo, 'seed shared skill')
    const sharedSeedCommit = await git(sharedRepo, ['rev-parse', 'HEAD'])
    await git(sharedRepo, ['branch', 'accepted/shared-assets/stable', sharedSeedCommit])

    const userSource = {
      type: 'git' as const,
      id: 'alice-assets',
      repo: userRepo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/alice-assets/stable',
        commit: userSeedCommit,
      },
      scope: 'user' as const,
      scopeRef: 'user:alice',
      refresh: 'manual' as const,
    }
    const sharedSource = {
      type: 'git' as const,
      id: 'shared-assets',
      repo: sharedRepo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/shared-assets/stable',
        commit: sharedSeedCommit,
      },
      scope: 'shared' as const,
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [],
      assetSources: [userSource, sharedSource],
      includeDefaultAssetRoots: false,
    })

    const userCheckout = await materializeMatOSAssetSource(root, userSource)
    const roleDir = join(userCheckout, 'roles', 'alice-compute')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'alice-compute',
      type: 'role',
      name: 'Alice Compute',
      version: '1.0.0',
      entry: 'ROLE.md',
      mounts: {
        skills: ['skill:shared-helper@1.0.0'],
      },
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'Alice compute role.\n', 'utf8')

    const result = await commitAcceptedDirectEditorGitAssetSources({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'dependency-validation',
      summary: 'Create role that reuses a shared skill',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.sourceCommitErrors).toBeUndefined()
    expect(result.sourceAcceptance?.[0]?.ok).toBe(true)
    const acceptedCommit = await git(userRepo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(acceptedCommit).not.toBe(userSeedCommit)
    const assets = await loadMatOSAssets(root)
    expect((await validateMatOSAssets(assets)).ok).toBe(true)
  })

  test('records direct-editor audit files in accepted Gitea source commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-audit-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-audit-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const source = {
      type: 'git' as const,
      id: 'alice-assets',
      repo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/alice-assets/stable',
        commit: seedCommit,
      },
      scope: 'user' as const,
      scopeRef: 'user:alice',
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [source],
      includeDefaultAssetRoots: false,
    })
    const checkoutRoot = await materializeMatOSAssetSource(root, source)
    const assetDir = join(checkoutRoot, 'knowledge', 'gitea-audit-runbook')
    await mkdir(assetDir, { recursive: true })
    await writeJson(join(assetDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'gitea-audit-runbook',
      type: 'knowledge',
      name: 'Gitea Audit Runbook',
      version: '1.0.0',
      entry: 'KNOWLEDGE.md',
    })
    await writeFile(
      join(assetDir, 'KNOWLEDGE.md'),
      '# Gitea Audit Runbook\n\nRecord accepted self-evolution evidence in the accepted asset source commit.\n',
      'utf8',
    )
    const diffPath = join(
      root,
      '.matos',
      'evolution',
      'direct-editor',
      'runs',
      'audit-test',
      'diff.patch',
    )
    await mkdir(join(diffPath, '..'), { recursive: true })
    await writeFile(
      diffPath,
      'diff --git a/knowledge/gitea-audit-runbook/KNOWLEDGE.md b/knowledge/gitea-audit-runbook/KNOWLEDGE.md\n',
      'utf8',
    )

    const result = await commitAcceptedDirectEditorGitAssetSources({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'audit-test',
      summary: 'Create Gitea audit runbook',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
      audit: {
        schemaVersion: 1,
        runId: 'audit-test',
        scope: 'user',
        scopeRef: 'user:alice',
        status: 'accepted',
        summary: 'Create Gitea audit runbook',
        promptInput: {
          targetContract: {
            schemaVersion: 1,
            mode: 'strict',
            expectedTypes: ['knowledge'],
            preferredRefs: ['knowledge:gitea-audit-runbook@1.0.0'],
            source: 'feedback',
          },
        },
        editorOutput: {
          summary: 'Create Gitea audit runbook',
          targetDecision: {
            selectedTypes: ['knowledge'],
            selectedRefs: ['knowledge:gitea-audit-runbook@1.0.0'],
            fallbackUsed: false,
            reason: 'The reusable lesson belongs in a runbook.',
          },
          modifiedFiles: [
            'knowledge/gitea-audit-runbook/asset.json',
            'knowledge/gitea-audit-runbook/KNOWLEDGE.md',
          ],
          createdAssets: ['knowledge:gitea-audit-runbook@1.0.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['event:audit-test'],
          expectedBehaviorChange:
            'Future evolution inspection can find the accepted-source audit package.',
          nextSessionEffect:
            'The user-scoped runbook is available from the accepted Gitea ref.',
        },
        semanticAcceptance: {
          verdict: 'accept',
          confidence: 0.93,
          reason: 'The edit creates a scoped runbook and records evidence.',
          resolvedUserProblem: true,
          overfitRisk: 'low',
          assetPollutionRisk: 'low',
          missingEvidence: [],
          recommendedFollowup: [],
        },
        diffPatchPath:
          '.matos/evolution/direct-editor/runs/audit-test/diff.patch',
      },
    })

    expect(result.sourceCommitErrors).toBeUndefined()
    expect(result.sourceAcceptance?.[0]).toMatchObject({
      ok: true,
      audit: {
        jsonPath:
          '.matos/evolution/audit/direct-editor/audit-test/audit.json',
        summaryPath:
          '.matos/evolution/audit/direct-editor/audit-test/SUMMARY.md',
        diffPath:
          '.matos/evolution/audit/direct-editor/audit-test/diff.patch',
      },
    })
    const acceptedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(acceptedCommit).not.toBe(seedCommit)
    const audit = JSON.parse(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:.matos/evolution/audit/direct-editor/audit-test/audit.json',
      ]),
    )
    expect(audit).toMatchObject({
      kind: 'matos-direct-editor-gitea-audit',
      runId: 'audit-test',
      scope: 'user',
      scopeRef: 'user:alice',
      editorOutput: {
        createdAssets: ['knowledge:gitea-audit-runbook@1.0.0'],
      },
    })
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:.matos/evolution/audit/direct-editor/audit-test/SUMMARY.md',
      ]),
    ).toContain('Create Gitea audit runbook')
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:.matos/evolution/audit/direct-editor/audit-test/diff.patch',
      ]),
    ).toContain('gitea-audit-runbook')

    const noop = await commitAcceptedDirectEditorGitAssetSources({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'audit-noop',
      summary: 'No-op audit should not advance accepted ref',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
      audit: {
        schemaVersion: 1,
        runId: 'audit-noop',
        scope: 'user',
        scopeRef: 'user:alice',
        status: 'accepted',
        summary: 'No-op audit should not advance accepted ref',
        editorOutput: {
          summary: 'No-op audit should not advance accepted ref',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['event:audit-noop'],
        },
      },
    })
    expect(noop.sourceCommits?.[0]).toMatchObject({ action: 'noop' })
    expect(noop.sourceCommitErrors?.[0]?.error).toContain(
      'produced no direct-editor commit',
    )
    expect(await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])).toBe(
      acceptedCommit,
    )
  })

  test('rejects secret-looking generated scoped assets before copying or committing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-secret-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-secret-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo,
          ref: 'main',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/alice-assets/stable',
            commit: seedCommit,
          },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
    })
    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'skills',
      'secret-skill',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'secret-skill',
      type: 'skill',
      name: 'Secret Skill',
      version: '1.0.0',
      entry: 'SKILL.md',
    })
    await writeFile(
      join(generatedDir, 'SKILL.md'),
      'api_key = "sk-live-realistic-secret-value"\n',
      'utf8',
    )

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'secret-generated',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.ok).toBe(false)
    expect(result.copiedAssets).toEqual([])
    expect(await pathExists(generatedDir)).toBe(true)
    expect(result.sourceCommitErrors?.[0]?.error).toMatch(/secret/i)
    expect(await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])).toBe(
      seedCommit,
    )
  })

  test('preserves dirty authoring state and staged assets instead of resetting them during sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-dirty-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-dirty-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const source = {
      type: 'git' as const,
      id: 'alice-assets',
      repo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/alice-assets/stable',
        commit: seedCommit,
      },
      scope: 'user' as const,
      scopeRef: 'user:alice',
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [source],
      includeDefaultAssetRoots: false,
    })
    const targetRoot = await materializeMatOSAssetSource(root, source)
    await mkdir(join(targetRoot, 'scratch'), { recursive: true })
    await writeFile(join(targetRoot, 'scratch', 'dirty.txt'), 'unrelated dirty state\n', 'utf8')

    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'tools',
      'vasp-preflight',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-preflight',
      type: 'tool',
      name: 'VASP Preflight',
      version: '1.0.0',
      entry: 'TOOL.md',
    })
    await writeFile(join(generatedDir, 'TOOL.md'), '# VASP Preflight\n', 'utf8')

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'dirty-source-cache',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.ok).toBe(false)
    expect(result.copiedAssets).toEqual([])
    expect(result.sourceCommitErrors?.[0]?.error).toContain('already dirty')
    expect(await pathExists(generatedDir)).toBe(true)
    expect(await readFile(join(targetRoot, 'scratch', 'dirty.txt'), 'utf8')).toBe('unrelated dirty state\n')
    expect(await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])).toBe(
      seedCommit,
    )
  })

  test('fast-forwards stale pinned accepted runtime before syncing generated scoped assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-stale-pinned-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-generated-sync-stale-pinned-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice scoped assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const source = {
      type: 'git' as const,
      id: 'alice-assets',
      repo,
      ref: 'main',
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: 'accepted/alice-assets/stable',
        commit: seedCommit,
      },
      scope: 'user' as const,
      scopeRef: 'user:alice',
      refresh: 'manual' as const,
    }
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [source],
      includeDefaultAssetRoots: false,
    })
    await materializeMatOSAssetSource(root, source)

    await writeFile(join(repo, 'REMOTE_ACCEPTED.md'), 'remote accepted baseline\n', 'utf8')
    const existingKnowledgeDir = join(repo, 'knowledge', 'vasp-runbook')
    await mkdir(existingKnowledgeDir, { recursive: true })
    await writeJson(join(existingKnowledgeDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-runbook',
      type: 'knowledge',
      name: 'VASP Runbook',
      version: '1.0.0',
      entry: 'KNOWLEDGE.md',
    })
    await writeFile(
      join(existingKnowledgeDir, 'KNOWLEDGE.md'),
      '# Old VASP Runbook\n',
      'utf8',
    )
    await commitAll(repo, 'advance remote accepted baseline')
    const remoteAcceptedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, [
      'branch',
      '-f',
      'accepted/alice-assets/stable',
      remoteAcceptedCommit,
    ])

    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'knowledge',
      'vasp-runbook',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'vasp-runbook',
      type: 'knowledge',
      name: 'VASP Runbook',
      version: '1.0.0',
      entry: 'KNOWLEDGE.md',
    })
    await writeFile(join(generatedDir, 'KNOWLEDGE.md'), '# Updated VASP Runbook\n', 'utf8')

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'stale-pinned-runtime',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
      },
    })

    expect(result.ok).toBe(true)
    expect(result.sourceCommitErrors).toBeUndefined()
    const acceptedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    await git(repo, ['merge-base', '--is-ancestor', remoteAcceptedCommit, acceptedCommit])
    const config = await readMatOSProjectConfig(root)
    expect(config.assetSources?.[0]).toMatchObject({
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: acceptedCommit,
      },
    })
    const syncedKnowledge = await git(repo, [
      'show',
      `${acceptedCommit}:knowledge/vasp-runbook/KNOWLEDGE.md`,
    ])
    expect(syncedKnowledge).toContain('# Updated VASP Runbook')
  })

  test('reports skipped-only generated assets as unsuccessful sync work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-generated-sync-skipped-only-'))
    const generatedDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'unknown',
      'bad-asset',
    )
    await mkdir(generatedDir, { recursive: true })
    await writeJson(join(generatedDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'bad-asset',
      type: 'unsupported-type',
      name: 'Bad Asset',
      version: '1.0.0',
    })

    const result = await syncGeneratedScopedAssetsToGitea({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'skipped-only',
    })

    expect(result.ok).toBe(false)
    expect(result.copiedAssets).toEqual([])
    expect(result.skippedAssets).toHaveLength(1)
    expect(result.sourceCommitErrors?.[0]?.error).toMatch(/skipped/i)
  })
})
