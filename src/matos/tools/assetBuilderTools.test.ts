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
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { createMatOSAssetBuilderTools } from './assetBuilderTools.js'

const execFileAsync = promisify(execFile)

// Bun applies explicit per-test timeouts over the CLI --timeout default, so
// honor a raised MATOS_TEST_TIMEOUT_MS (the matos-test.sh retry knob) for this
// real-git accepted-ref flow instead of silently pinning it to 30s.
function assetBuilderTestTimeoutMs(): number {
  const runnerTimeout = Number.parseInt(process.env.MATOS_TEST_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(runnerTimeout) && runnerTimeout > 30_000) {
    return runnerTimeout
  }
  return 30_000
}

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

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MatOS Test',
      GIT_AUTHOR_EMAIL: 'matos-test@example.invalid',
      GIT_COMMITTER_NAME: 'MatOS Test',
      GIT_COMMITTER_EMAIL: 'matos-test@example.invalid',
    },
  })
  return stdout.trim()
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', message])
}

function toolByName(
  tools: ReturnType<typeof createMatOSAssetBuilderTools>,
  name: string,
) {
  const tool = tools.find(candidate => candidate.name === name)
  if (!tool) {
    throw new Error(`Missing asset builder tool: ${name}`)
  }
  return tool
}

describe('MatOS asset builder MCP tools', () => {
  test('creates and updates scoped assets through accepted Gitea runtime refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-asset-builder-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-asset-builder-repo-'))
    const bobRepo = await mkdtemp(join(tmpdir(), 'matos-asset-builder-bob-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice user assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    await writeFile(join(bobRepo, 'README.md'), 'bob user assets\n', 'utf8')
    await git(bobRepo, ['init', '-b', 'main'])
    await commitAll(bobRepo, 'seed bob assets')
    const bobSeedCommit = await git(bobRepo, ['rev-parse', 'HEAD'])
    await git(bobRepo, ['branch', 'accepted/bob-assets/stable', bobSeedCommit])
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
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
        {
          type: 'git',
          id: 'bob-assets',
          repo: bobRepo,
          ref: 'main',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/bob-assets/stable',
            commit: bobSeedCommit,
          },
          scope: 'user',
          scopeRef: 'user:bob',
          refresh: 'manual',
        },
      ],
    })

    const tools = createMatOSAssetBuilderTools({
      cwd: root,
      selectedRole: 'role:compute',
    })
    expect(tools.map(tool => tool.name)).toEqual(['adapt_path', 'asset_edit'])

    const created = JSON.parse(
      (
        await toolByName(tools, 'asset_edit').call({
          action: 'create',
          scopeRef: 'user:alice',
          type: 'skill',
          id: 'agent-built-skill',
          name: 'Agent Built Skill',
          description: 'Created by asset_edit for accepted-ref smoke.',
          content: '# Agent Built Skill\n\nUse this procedure for accepted-ref tests.\n',
          reason: 'asset builder accepted-ref smoke',
        })
      ).text,
    ) as {
      ok: boolean
      assetRef: string
      generatedDir: string
      gitea?: { copiedAssets?: Array<{ canonicalRef: string }> }
      validation?: { ok: boolean }
      asset?: { sourceScope?: string; sourceScopeRef?: string }
    }

    expect(created.ok).toBe(true)
    expect(created.assetRef).toBe('skill:agent-built-skill@0.1.0')
    expect(created.asset?.sourceScope).toBe('user')
    expect(created.asset?.sourceScopeRef).toBe('user:alice')
    expect(created.validation?.ok).toBe(true)
    expect(created.gitea?.copiedAssets?.[0]?.canonicalRef).toBe(
      'skill:agent-built-skill@0.1.0',
    )
    expect(await pathExists(created.generatedDir)).toBe(false)

    const createdCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(createdCommit).not.toBe(seedCommit)
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:skill/agent-built-skill/SKILL.md',
      ]),
    ).toContain('accepted-ref tests')

    const updated = JSON.parse(
      (
        await toolByName(tools, 'asset_edit').call({
          action: 'update',
          scopeRef: 'user:alice',
          ref: 'skill:agent-built-skill',
          name: 'Agent Built Skill Updated',
          content: '# Agent Built Skill Updated\n\nUpdated through scoped accepted refs.\n',
          metadata: {
            lifecycle: { status: 'draft' },
            sourceProvenance: { scope: 'core', scopeRef: 'core' },
          },
          reason: 'asset builder accepted-ref update smoke',
        })
      ).text,
    ) as {
      ok: boolean
      assetRef: string
      validation?: { ok: boolean }
      activationRequired?: boolean
      nextAction?: { activateCli?: string }
      asset?: { lifecycle?: { status?: string } }
    }

    expect(updated.ok).toBe(true)
    expect(updated.assetRef).toBe('skill:agent-built-skill@0.1.0')
    expect(updated.validation?.ok).toBe(true)
    expect(updated.activationRequired).toBeUndefined()
    expect(updated.nextAction?.activateCli).toBeUndefined()
    expect(updated.asset?.lifecycle?.status).toBe('enabled')

    const updatedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(updatedCommit).not.toBe(createdCommit)
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:skill/agent-built-skill/SKILL.md',
      ]),
    ).toContain('Updated through scoped accepted refs')
    const updatedManifest = JSON.parse(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:skill/agent-built-skill/asset.json',
      ]),
    ) as {
      name?: string
      lifecycle?: { status?: string; reason?: string }
      metadata?: { lifecycle?: unknown; sourceProvenance?: unknown }
    }
    expect(updatedManifest.name).toBe('Agent Built Skill Updated')
    expect(updatedManifest.lifecycle?.status).toBe('enabled')
    expect(updatedManifest.lifecycle?.reason).toBeUndefined()
    expect(updatedManifest.metadata?.lifecycle).toBeUndefined()
    expect(updatedManifest.metadata?.sourceProvenance).toBeUndefined()

    const crossScopeUpdate = JSON.parse(
      (
        await toolByName(tools, 'asset_edit').call({
          action: 'update',
          scopeRef: 'user:bob',
          ref: 'skill:agent-built-skill',
          content: '# Cross Scope Rewrite\n',
        })
      ).text,
    ) as { ok: boolean; error?: string }
    expect(crossScopeUpdate.ok).toBe(false)
    expect(crossScopeUpdate.error).toContain('not owned by user:bob')

    const missingScope = JSON.parse(
      (
        await toolByName(tools, 'asset_edit').call({
          action: 'create',
          type: 'skill',
          id: 'missing-scope-skill',
          name: 'Missing Scope Skill',
        })
      ).text,
    ) as { ok: boolean; error?: string }
    expect(missingScope.ok).toBe(false)
    expect(missingScope.error).toContain('requires scopeRef=user:<id>')

    const giteaEnvKeys = [
      'MATOS_GITEA_CONTAINER_SOURCE_BASE_URL',
      'MATOS_GITEA_SOURCE_BASE_URL',
      'MATOS_GITEA_BASE_URL',
      'MATOS_GITEA_UPSTREAM',
    ] as const
    const previousGiteaEnv = Object.fromEntries(
      giteaEnvKeys.map(key => [key, process.env[key]]),
    )
    for (const key of giteaEnvKeys) {
      delete process.env[key]
    }
    try {
      const missingSource = JSON.parse(
        (
          await toolByName(tools, 'asset_edit').call({
            action: 'create',
            scopeRef: 'user:carol',
            type: 'skill',
            id: 'missing-source-skill',
            name: 'Missing Source Skill',
          })
        ).text,
      ) as {
        ok: boolean
        error?: string
        generatedDir?: string
        generatedDirRemoved?: boolean
      }
      expect(missingSource.ok).toBe(false)
      expect(missingSource.error).toContain('No matching Gitea asset source')
      expect(missingSource.generatedDirRemoved).toBe(true)
      expect(await pathExists(missingSource.generatedDir ?? '')).toBe(false)
    } finally {
      for (const key of giteaEnvKeys) {
        const value = previousGiteaEnv[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }

    const localUpdate = JSON.parse(
      (
        await toolByName(tools, 'asset_edit').call({
          action: 'update',
          target: 'project-local',
          ref: 'skill:agent-built-skill',
          content: '# Local Update\n',
        })
      ).text,
    ) as { ok: boolean; error?: string }
    expect(localUpdate.ok).toBe(false)
    expect(localUpdate.error).toContain('project-local asset_edit supports create only')

    const rejected = JSON.parse(
      (
        await toolByName(tools, 'asset_edit').call({
          action: 'create',
          scopeRef: 'user:alice',
          type: 'plugin',
          id: 'not-agent-buildable',
          name: 'Not Agent Buildable',
        })
      ).text,
    ) as { ok: boolean; error?: string }
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('supports only knowledge, data, tool, skill, and mcp')
  }, assetBuilderTestTimeoutMs())
})
