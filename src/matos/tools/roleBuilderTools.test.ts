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
import { getMatOSConfigPath } from '../project.js'
import {
  buildDelegatedRoleEnv,
  createMatOSRoleBuilderTools,
} from './roleBuilderTools.js'

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
  tools: ReturnType<typeof createMatOSRoleBuilderTools>,
  name: string,
) {
  const tool = tools.find(candidate => candidate.name === name)
  if (!tool) {
    throw new Error(`Missing role builder tool: ${name}`)
  }
  return tool
}

describe('MatOS role builder MCP tools', () => {
  test('starts delegated roles in a fresh child session without parent resume state', () => {
    const env = buildDelegatedRoleEnv({
      MATOS_TRACE_ID: 'trace-parent',
      MATOS_SESSION_ID: 'session-parent',
      MATOS_TURN_ID: 'turn-parent',
      MATOS_CHAT_SESSION_ID: 'chat-parent',
      MATOS_UPSTREAM_SESSION_ID: 'upstream-parent',
      MATOS_RESUME_COMMAND: 'matos --resume upstream-parent',
      MATOS_PROJECT_MEMBER_ID: 'agent-compute',
    }, 'role-delegation-child')
    expect(env).toMatchObject({
      MATOS_TRACE_ID: 'trace-parent',
      MATOS_SESSION_ID: 'role-delegation-child',
      MATOS_CHAT_SESSION_ID: 'role-delegation-child',
      MATOS_PARENT_SESSION_ID: 'session-parent',
      MATOS_PARENT_PROJECT_MEMBER_ID: 'agent-compute',
    })
    expect(env.MATOS_PROJECT_MEMBER_ID).toBeUndefined()
    expect(env.MATOS_UPSTREAM_SESSION_ID).toBeUndefined()
    expect(env.MATOS_RESUME_COMMAND).toBeUndefined()
    expect(env.MATOS_TURN_ID).toBeUndefined()
  })

  test('creates scoped roles through accepted Gitea runtime refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-role-builder-'))
    const projectRoot = await mkdtemp(join(tmpdir(), 'matos-role-builder-project-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-role-builder-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(join(repo, 'skill', 'helper'), { recursive: true })
    await mkdir(join(repo, 'role', 'compute'), { recursive: true })
    await writeJson(join(repo, 'skill', 'helper', 'asset.json'), {
      schemaVersion: 1,
      id: 'helper',
      type: 'skill',
      name: 'Helper Skill',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(repo, 'skill', 'helper', 'SKILL.md'), '# Helper Skill\n', 'utf8')
    await writeJson(join(repo, 'role', 'compute', 'asset.json'), {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '1.0.0',
      entry: 'ROLE.md',
    })
    await writeFile(join(repo, 'role', 'compute', 'ROLE.md'), '# Compute\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
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
      ],
    })

    const tools = createMatOSRoleBuilderTools({
      cwd: root,
      selectedRole: 'role:compute',
    })
    expect(tools.map(tool => tool.name)).toEqual([
      'role_query',
      'role_edit',
      'role_run',
    ])

    const candidates = JSON.parse(
      (
        await toolByName(tools, 'role_query').call({
          action: 'compose',
          query: 'helper',
        })
      ).text,
    ) as {
      ok: boolean
      mounts?: {
        candidates?: Array<{ ref: string; alias: string; group: string }>
      }
    }
    expect(candidates.ok).toBe(true)
    expect(candidates.mounts?.candidates?.[0]).toMatchObject({
      ref: 'skill:helper@0.1.0',
      alias: 'skill:helper',
      group: 'skills',
    })

    const preview = JSON.parse(
      (
        await toolByName(tools, 'role_query').call({
          action: 'preview_create',
          scopeRef: 'user:alice',
          id: 'agent-built-role',
          name: 'Agent Built Role',
          prompt: 'Use mcp__missing_server__missing_tool only if mounted.',
          mounts: {
            skills: ['skill:helper'],
          },
        })
      ).text,
    ) as {
      ok: boolean
      plan?: {
        proposedRole?: { mounts?: { skills?: string[] } }
        mountDiff?: { skills?: { added?: string[] } }
        promptTools?: { unresolved?: string[]; ok?: boolean }
        nextAction?: { switchCli?: string; activateCli?: string }
      }
    }
    expect(preview.ok).toBe(true)
    expect(preview.plan?.proposedRole?.mounts?.skills).toEqual([
      'skill:helper@0.1.0',
    ])
    expect(preview.plan?.mountDiff?.skills?.added).toEqual([
      'skill:helper@0.1.0',
    ])
    expect(preview.plan?.promptTools?.ok).toBe(false)
    expect(preview.plan?.promptTools?.unresolved).toContain(
      'mcp__missing_server__missing_tool',
    )
    expect(preview.plan?.nextAction?.switchCli).toBe('/role agent-built-role')
    expect(preview.plan?.nextAction?.activateCli).toBeUndefined()

    const created = JSON.parse(
      (
        await toolByName(tools, 'role_edit').call({
          action: 'create',
          scopeRef: 'user:alice',
          id: 'agent-built-role',
          name: 'Agent Built Role',
          description: 'Created by role_edit for a real accepted-ref smoke.',
          prompt: 'You are an agent-built MatOS role.',
          mounts: {
            skills: ['skill:helper'],
          },
          reason: 'role builder accepted-ref smoke',
        })
      ).text,
    ) as {
      ok: boolean
      roleRef: string
      generatedDir: string
      smoke?: { ok?: boolean; skippedReferences?: unknown[] }
      role?: {
        mounts?: { skills?: string[] }
        mountDiff?: { skills?: { added?: string[] } }
        lifecycle?: { status?: string }
      }
      gitea?: { copiedAssets?: Array<{ canonicalRef: string }> }
      validation?: { ok: boolean }
      activationRequired?: boolean
      nextAction?: { activateCli?: string; switchCli?: string }
    }

    expect(created.ok).toBe(true)
    expect(created.roleRef).toBe('role:agent-built-role@0.1.0')
    expect(created.validation?.ok).toBe(true)
    expect(created.smoke?.ok).toBe(true)
    expect(created.smoke?.skippedReferences).toEqual([])
    expect(created.role?.mounts?.skills).toEqual(['skill:helper@0.1.0'])
    expect(created.role?.mountDiff?.skills?.added).toEqual(['skill:helper@0.1.0'])
    expect(created.activationRequired).toBeUndefined()
    expect(created.role?.lifecycle?.status).toBe('enabled')
    expect(created.nextAction?.activateCli).toBeUndefined()
    expect(created.nextAction?.switchCli).toBe('/role agent-built-role')
    expect(created.gitea?.copiedAssets?.[0]?.canonicalRef).toBe(
      'role:agent-built-role@0.1.0',
    )
    expect(await pathExists(created.generatedDir)).toBe(false)

    const acceptedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(acceptedCommit).not.toBe(seedCommit)
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:role/agent-built-role/ROLE.md',
      ]),
    ).toContain('agent-built MatOS role')
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:role/agent-built-role/asset.json',
      ]),
    ).toContain('skill:helper@0.1.0')

    const smoke = JSON.parse(
      (
        await toolByName(tools, 'role_edit').call({
          action: 'smoke',
          ref: 'role:agent-built-role',
        })
      ).text,
    ) as { ok: boolean; roleRef: string; skippedReferences?: unknown[] }
    expect(smoke.ok).toBe(true)
    expect(smoke.roleRef).toBe('role:agent-built-role@0.1.0')
    expect(smoke.skippedReferences).toEqual([])

    const shown = JSON.parse(
      (
        await toolByName(tools, 'role_query').call({
          action: 'show',
          ref: 'role:agent-built-role',
        })
      ).text,
    ) as { resource?: { ref?: string; gitGovernance?: { runtimeRef?: { ref?: string } } } }
    expect(shown.resource?.ref).toBe('role:agent-built-role@0.1.0')
    expect(shown.resource?.gitGovernance?.runtimeRef?.ref).toBe(
      'accepted/alice-assets/stable',
    )

    await mkdir(join(projectRoot, '.matos'), { recursive: true })
    await writeJson(join(projectRoot, '.matos', 'project.json'), {
      schemaVersion: 1,
      revision: 1,
      id: 'role-builder-project',
      name: 'Role Builder Project',
      team: [
        {
          memberId: 'agent-compute',
          roleRef: 'role:compute@1.0.0',
          label: 'Compute',
          kind: 'agent',
          source: 'default',
        },
        {
          memberId: 'user-collaborator',
          kind: 'human',
          userId: 'user:collaborator',
          label: 'Collaborator',
          source: 'explicit',
        },
      ],
      memberBriefs: {},
      memberNames: {},
    })
    const projectTools = createMatOSRoleBuilderTools({
      cwd: root,
      projectCwd: projectRoot,
      selectedRole: 'role:compute@1.0.0',
      projectId: 'role-builder-project',
      projectMemberId: 'agent-compute',
      env: {
        ...process.env,
        MATOS_SCOPE_REF: 'user:alice',
      },
    })
    const projectCreated = JSON.parse(
      (
        await toolByName(projectTools, 'role_edit').call({
          action: 'create',
          scopeRef: 'user:alice',
          id: 'project-agent',
          name: 'Project Agent',
          prompt: 'You are the durable project agent.',
          mounts: {
            skills: ['skill:helper'],
          },
          projectBinding: 'replace-current',
          reason: 'replace the default Compute member after accepted Role creation',
        })
      ).text,
    ) as {
      ok: boolean
      roleRef: string
      projectBinding?: {
        ok?: boolean
        mode?: string
        removedCurrent?: { changed?: boolean }
        project?: { roleRefs?: string[]; assetRefs?: string[] }
      }
    }
    expect(projectCreated.ok).toBe(true)
    expect(projectCreated.roleRef).toBe('role:project-agent@0.1.0')
    expect(projectCreated.projectBinding).toMatchObject({
      ok: true,
      mode: 'replace-current',
      removedCurrent: { changed: true },
    })
    expect(projectCreated.projectBinding?.project?.roleRefs).toEqual([
      'role:project-agent@0.1.0',
    ])
    expect(projectCreated.projectBinding?.project?.assetRefs).toEqual([
      'role:project-agent@0.1.0',
    ])

    const projectMetadata = JSON.parse(
      await readFile(join(projectRoot, '.matos', 'project.json'), 'utf8'),
    ) as {
      assetRefs?: string[]
      team?: Array<{ memberId?: string; roleRef?: string; kind?: string; userId?: string }>
    }
    expect(projectMetadata.assetRefs).toEqual(['role:project-agent@0.1.0'])
    expect(projectMetadata.team).toEqual([
      expect.objectContaining({
        memberId: 'user-collaborator',
        kind: 'human',
        userId: 'user:collaborator',
      }),
      expect.objectContaining({
        memberId: 'agent-project-agent',
        roleRef: 'role:project-agent@0.1.0',
      }),
    ])

    const rebound = JSON.parse(
      (
        await toolByName(projectTools, 'role_edit').call({
          action: 'bind-project',
          ref: 'role:project-agent@0.1.0',
          projectBinding: 'add',
        })
      ).text,
    ) as {
      ok?: boolean
      projectBinding?: { ok?: boolean; changed?: boolean }
    }
    expect(rebound).toMatchObject({
      ok: true,
      projectBinding: { ok: true, changed: false },
    })
  }, 60000)
})
