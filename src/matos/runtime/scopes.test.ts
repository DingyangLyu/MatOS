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

import type { Stats } from 'node:fs'
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  __scopeTestHooks,
  materializeMatOSRuntimeScope,
  repairMatOSRuntimeScopeWritableTrees,
  resolveMatOSRuntimeScope,
} from './scopes.js'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function missingPathError(): NodeJS.ErrnoException {
  return Object.assign(new Error('path disappeared'), { code: 'ENOENT' })
}

function fakeStats(input: {
  directory?: boolean
  symbolicLink?: boolean
  uid?: number
  gid?: number
}): Stats {
  return {
    uid: input.uid ?? 0,
    gid: input.gid ?? 0,
    isDirectory: () => Boolean(input.directory),
    isSymbolicLink: () => Boolean(input.symbolicLink),
  } as Stats
}

describe('MatOS runtime scopes', () => {
  test('ignores disappearing files during scope ownership repair', async () => {
    const calls: string[] = []

    await __scopeTestHooks.repairWritableTree(
      '/workspace/.fuse_hidden_scope_file',
      { uid: 1234, gid: 1234 },
      {
        lstat: async () => {
          calls.push('lstat')
          return fakeStats({})
        },
        lchown: async () => {
          throw new Error('lchown should not run')
        },
        chown: async () => {
          calls.push('chown')
          throw missingPathError()
        },
        chmod: async () => {
          throw new Error('chmod should not run after missing chown')
        },
        readdir: async () => {
          throw new Error('readdir should not run')
        },
      },
    )

    expect(calls).toEqual(['lstat', 'chown'])
  })

  test('ignores disappearing directories during scope ownership repair', async () => {
    const calls: string[] = []

    await __scopeTestHooks.repairWritableTree(
      '/workspace/.fuse_hidden_scope_dir',
      { uid: 1234, gid: 1234 },
      {
        lstat: async () => {
          calls.push('lstat')
          return fakeStats({ directory: true })
        },
        lchown: async () => {
          throw new Error('lchown should not run')
        },
        chown: async () => {
          calls.push('chown')
        },
        chmod: async () => {
          calls.push('chmod')
        },
        readdir: async () => {
          calls.push('readdir')
          throw missingPathError()
        },
      },
    )

    expect(calls).toEqual(['lstat', 'chown', 'chmod', 'readdir'])
  })

  test('repairs project workspace ownership without changing file modes or following symlinks', async () => {
    const owner = { uid: 1234, gid: 5678 }
    const shared = '/scope/workspace-state/shared'
    const workspaces = '/scope/workspace-state/workspaces'
    const rootOwnedDir = join(shared, 'results')
    const rootOwnedFile = join(rootOwnedDir, 'output.dat')
    const ownedFile = join(shared, 'notes.txt')
    const rootOwnedLink = join(workspaces, 'external-link')
    const nodes = new Map<string, Stats>([
      [shared, fakeStats({ directory: true, ...owner })],
      [rootOwnedDir, fakeStats({ directory: true })],
      [rootOwnedFile, fakeStats({})],
      [ownedFile, fakeStats(owner)],
      [workspaces, fakeStats({ directory: true, ...owner })],
      [rootOwnedLink, fakeStats({ symbolicLink: true })],
    ])
    const children = new Map<string, string[]>([
      [shared, ['results', 'notes.txt']],
      [rootOwnedDir, ['output.dat']],
      [workspaces, ['external-link']],
    ])
    const calls: string[] = []
    const scope = {
      ref: 'user:alice',
      sharedWorkspaceDir: shared,
      workspacesDir: workspaces,
    } as never
    const fsOps = {
      lstat: async (path: string) => {
        calls.push(`lstat:${path}`)
        const stats = nodes.get(path)
        if (!stats) throw missingPathError()
        return stats
      },
      chown: async (path: string, uid: number, gid: number) => {
        calls.push(`chown:${path}:${uid}:${gid}`)
        const current = nodes.get(path)
        if (current) {
          nodes.set(path, { ...current, uid, gid } as Stats)
        }
      },
      lchown: async (path: string, uid: number, gid: number) => {
        calls.push(`lchown:${path}:${uid}:${gid}`)
        const current = nodes.get(path)
        if (current) {
          nodes.set(path, { ...current, uid, gid } as Stats)
        }
      },
      readdir: async (path: string) => {
        calls.push(`readdir:${path}`)
        return children.get(path) ?? []
      },
    }

    const audit = await __scopeTestHooks.auditMatOSRuntimeScopeWorkspaceOwnership(
      scope,
      owner,
      fsOps,
    )

    expect(audit).toMatchObject({
      ok: false,
      mode: 'audit',
      expectedOwner: owner,
      scannedEntries: 6,
      mismatchedEntries: 3,
      repairedEntries: 0,
      vanishedEntries: 0,
    })
    expect(audit.samplePaths).toEqual(
      expect.arrayContaining([
        'shared/results',
        'shared/results/output.dat',
        'workspaces/external-link',
      ]),
    )
    expect(calls.some(call => call.startsWith('chown:'))).toBe(false)
    expect(calls.some(call => call.startsWith('lchown:'))).toBe(false)

    calls.length = 0
    const warnings: string[] = []
    const repair = await (async () => {
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      }
      try {
        return await __scopeTestHooks.repairMatOSRuntimeScopeWorkspaceOwnership(
          scope,
          owner,
          fsOps,
        )
      } finally {
        console.warn = originalWarn
      }
    })()

    expect(calls).toContain(`chown:${rootOwnedDir}:1234:5678`)
    expect(calls).toContain(`chown:${rootOwnedFile}:1234:5678`)
    expect(calls).toContain(`lchown:${rootOwnedLink}:1234:5678`)
    expect(calls).not.toContain(`chown:${ownedFile}:1234:5678`)
    expect(calls).not.toContain(`readdir:${rootOwnedLink}`)
    expect(repair).toMatchObject({
      ok: true,
      mode: 'repair',
      expectedOwner: owner,
      scannedEntries: 6,
      mismatchedEntries: 3,
      repairedEntries: 3,
      vanishedEntries: 0,
      postRepairAudit: {
        scannedEntries: 6,
        mismatchedEntries: 0,
        vanishedEntries: 0,
      },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      'workspace ownership repaired scope=user:alice owner=1234:5678',
    )
  })

  test('repairs one shared project tree without scanning sibling workspace paths', async () => {
    const owner = { uid: 1234, gid: 5678 }
    const project = '/scope/workspace-state/shared/projects/battery-screening'
    const output = join(project, 'results', 'output.dat')
    const link = join(project, 'external-link')
    const nodes = new Map<string, Stats>([
      [project, fakeStats({ directory: true })],
      [join(project, 'results'), fakeStats({ directory: true })],
      [output, fakeStats({})],
      [link, fakeStats({ symbolicLink: true })],
    ])
    const children = new Map<string, string[]>([
      [project, ['results', 'external-link']],
      [join(project, 'results'), ['output.dat']],
    ])
    const calls: string[] = []
    const fsOps = {
      lstat: async (path: string) => {
        calls.push(`lstat:${path}`)
        const stats = nodes.get(path)
        if (!stats) throw missingPathError()
        return stats
      },
      chown: async (path: string, uid: number, gid: number) => {
        calls.push(`chown:${path}:${uid}:${gid}`)
        const current = nodes.get(path)
        if (current) nodes.set(path, { ...current, uid, gid } as Stats)
      },
      lchown: async (path: string, uid: number, gid: number) => {
        calls.push(`lchown:${path}:${uid}:${gid}`)
        const current = nodes.get(path)
        if (current) nodes.set(path, { ...current, uid, gid } as Stats)
      },
      readdir: async (path: string) => {
        calls.push(`readdir:${path}`)
        return children.get(path) ?? []
      },
    }

    const report = await __scopeTestHooks.repairMatOSRuntimeOwnershipTree(
      project,
      owner,
      fsOps,
    )

    expect(report).toMatchObject({
      ok: true,
      mode: 'repair',
      scannedEntries: 4,
      mismatchedEntries: 4,
      repairedEntries: 4,
      postRepairAudit: { mismatchedEntries: 0 },
    })
    expect(calls).toContain(`chown:${output}:1234:5678`)
    expect(calls).toContain(`lchown:${link}:1234:5678`)
    expect(calls).not.toContain(`readdir:${link}`)
    expect(calls.some(call => call.includes('/scope/workspace-state/workspaces'))).toBe(false)
    expect(calls.some(call => call.startsWith('chmod:'))).toBe(false)
  })

  test('reports a non-converged workspace ownership repair', async () => {
    const owner = { uid: 1234, gid: 5678 }
    const shared = '/scope/workspace-state/shared'
    const workspaces = '/scope/workspace-state/workspaces'
    const rootOwnedFile = join(shared, 'stuck.dat')
    const nodes = new Map<string, Stats>([
      [shared, fakeStats({ directory: true, ...owner })],
      [rootOwnedFile, fakeStats({})],
      [workspaces, fakeStats({ directory: true, ...owner })],
    ])
    const scope = {
      ref: 'user:alice',
      sharedWorkspaceDir: shared,
      workspacesDir: workspaces,
    } as never
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      const report =
        await __scopeTestHooks.repairMatOSRuntimeScopeWorkspaceOwnership(
          scope,
          owner,
          {
            lstat: async path => {
              const stats = nodes.get(path)
              if (!stats) throw missingPathError()
              return stats
            },
            chown: async () => {
              // Simulate a filesystem reporting success without persisting chown.
            },
            lchown: async () => {},
            readdir: async path =>
              path === shared ? ['stuck.dat'] : [],
          },
        )

      expect(report).toMatchObject({
        ok: false,
        mismatchedEntries: 1,
        repairedEntries: 1,
        postRepairAudit: {
          mismatchedEntries: 1,
          samplePaths: ['shared/stuck.dat'],
        },
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('remaining=1')
    } finally {
      console.warn = originalWarn
    }
  })

  test('keeps ownership convergence strict unless startup explicitly defers it', () => {
    const report = {
      ok: false,
      postRepairAudit: { mismatchedEntries: 17 },
    } as never

    expect(() =>
      __scopeTestHooks.enforceWorkspaceOwnershipConvergence(
        'user:alice',
        report,
        true,
      ),
    ).toThrow('17 entries remain mismatched')

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      expect(() =>
        __scopeTestHooks.enforceWorkspaceOwnershipConvergence(
          'user:alice',
          report,
          false,
        ),
      ).not.toThrow()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('Continuing workspace startup')
    } finally {
      console.warn = originalWarn
    }
  })

  test('ignores an ownership mismatch that converges during a read-only audit', async () => {
    const owner = { uid: 1234, gid: 5678 }
    const shared = '/scope/workspace-state/shared'
    const workspaces = '/scope/workspace-state/workspaces'
    const sourceCache = join(shared, '.matos', 'source-cache')
    const gitRoot = join(sourceCache, 'git')
    const checkout = join(gitRoot, 'demo')
    const gitDir = join(checkout, '.git')
    const transientFile = join(gitDir, 'config')
    const children = new Map<string, string[]>([
      [shared, ['.matos']],
      [join(shared, '.matos'), ['source-cache']],
      [sourceCache, ['git']],
      [gitRoot, ['demo']],
      [checkout, ['.git']],
      [gitDir, ['config']],
      [workspaces, []],
    ])
    let transientReads = 0
    const scope = {
      ref: 'user:alice',
      sharedWorkspaceDir: shared,
      workspacesDir: workspaces,
    } as never

    const report =
      await __scopeTestHooks.auditMatOSRuntimeScopeWorkspaceOwnership(
        scope,
        owner,
        {
          lstat: async path => {
            if (path === transientFile) {
              transientReads += 1
              return fakeStats(
                transientReads < 3 ? {} : owner,
              )
            }
            return fakeStats({ directory: true, ...owner })
          },
          chown: async () => {
            throw new Error('audit must not chown')
          },
          lchown: async () => {
            throw new Error('audit must not lchown')
          },
          readdir: async path => children.get(path) ?? [],
        },
      )

    expect(transientReads).toBe(3)
    expect(report).toMatchObject({
      ok: true,
      mode: 'audit',
      scannedEntries: 8,
      mismatchedEntries: 0,
      repairedEntries: 0,
      samplePaths: [],
    })
  })

  test('keeps host HOME and TMPDIR out of normal scope layout', () => {
    const scope = resolveMatOSRuntimeScope('/project', {
      scopeRef: 'user:local',
      runtimeDataDir: '/project/.matos/runtime',
      env: {
        HOME: '/root',
        TMPDIR: '/tmp',
      },
    })

    expect(scope.homeDir).toBe('/project/.matos/runtime/scopes/users/local/home')
    expect(scope.tmpDir).toBe('/project/.matos/runtime/scopes/users/local/tmp')
  })

  test('uses container-visible env roots inside workspace containers', () => {
    const scope = resolveMatOSRuntimeScope('/workspace/group/shared', {
      scopeRef: 'user:Admin',
      env: {
        MATOS_INTERNAL_STATE_DIR: '/home/workspace/.matos/internal',
        MATOS_WORKSPACE_DIR: '/workspace/group/shared',
        MATOS_SESSION_DIR: '/workspace/sessions',
        MATOS_WORKFLOW_RUNS_DIR: '/workspace/workflows/runs',
        MATOS_CACHE_DIR: '/workspace/caches',
        MATOS_TMP_DIR: '/workspace/caches/tmp',
        MATOS_AGENT_HOME: '/home/workspace/.matos',
      },
    })

    expect(scope.ref).toBe('user:admin')
    expect(scope.rootDir).toBe(
      '/home/workspace/.matos/internal/runtime/scopes/users/admin',
    )
    expect(scope.homeDir).toBe('/home/workspace/.matos')
    expect(scope.workspaceDir).toBe('/workspace/group')
    expect(scope.sharedWorkspaceDir).toBe('/workspace/group/shared')
    expect(scope.sessionsDir).toBe('/workspace/sessions')
    expect(scope.workflowsDir).toBe('/workspace/workflows')
    expect(scope.workflowRunsDir).toBe('/workspace/workflows/runs')
    expect(scope.cachesDir).toBe('/workspace/caches')
    expect(scope.tmpDir).toBe('/workspace/caches/tmp')
  })

  test('does not tighten permissions on external container workspace mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-scope-container-'))
    const workspace = join(root, 'workspace', 'group', 'shared')
    const workflowRuns = join(root, 'workspace', 'workflows', 'runs')
    const sessions = join(root, 'workspace', 'sessions')
    const internal = join(root, 'home', 'workspace', '.matos', 'internal')
    await mkdir(workspace, { recursive: true })
    await chmod(workspace, 0o755)

    const scope = resolveMatOSRuntimeScope(workspace, {
      scopeRef: 'user:admin',
      env: {
        MATOS_INTERNAL_STATE_DIR: internal,
        MATOS_WORKSPACE_DIR: workspace,
        MATOS_SESSION_DIR: sessions,
        MATOS_WORKFLOW_RUNS_DIR: workflowRuns,
      },
    })

    await materializeMatOSRuntimeScope(scope)

    expect((await stat(workspace)).mode & 0o777).toBe(0o755)
    expect(await exists(join(scope.workflowsDir, 'drafts'))).toBe(true)
    expect(await exists(scope.workflowRunsDir)).toBe(true)
    expect(await exists(scope.sessionsDir)).toBe(true)
    expect(await exists(scope.rootDir)).toBe(true)
  })

  test('does not materialize unused cached agent tmp when workspace scratch is tmpfs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-scope-workspace-tmpfs-'))
    const workspace = join(root, 'workspace', 'group', 'shared')
    const workflowRuns = join(root, 'workspace', 'workflows', 'runs')
    const sessions = join(root, 'workspace', 'sessions')
    const caches = join(root, 'workspace', 'caches')
    const agentTmp = join(root, 'tmp', 'agent-tmp')
    const internal = join(root, 'home', 'workspace', '.matos', 'internal')
    const scope = resolveMatOSRuntimeScope(workspace, {
      scopeRef: 'user:admin',
      env: {
        MATOS_INTERNAL_STATE_DIR: internal,
        MATOS_WORKSPACE_DIR: workspace,
        MATOS_SESSION_DIR: sessions,
        MATOS_WORKFLOW_RUNS_DIR: workflowRuns,
        MATOS_CACHE_DIR: caches,
        TMPDIR: agentTmp,
        MATOS_AGENT_HOME: join(root, 'home', 'workspace', '.matos'),
      },
    })

    await materializeMatOSRuntimeScope(scope)

    expect(await exists(join(caches, 'tmp'))).toBe(true)
    expect(await exists(join(caches, 'agent-tmp'))).toBe(false)
    expect(await exists(agentTmp)).toBe(true)
  })

  test('materializes workflow run and draft directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-scope-workflow-'))
    const scope = resolveMatOSRuntimeScope(root, {
      scopeRef: 'user:local',
      runtimeDataDir: join(root, '.matos', 'runtime'),
    })

    await materializeMatOSRuntimeScope(scope)

    expect(await exists(join(scope.workflowsDir, 'runs'))).toBe(true)
    expect(await exists(join(scope.workflowsDir, 'drafts'))).toBe(true)
  })

  test('repairs nested MatOS-owned writable trees without touching the whole workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-scope-repair-'))
    const scope = resolveMatOSRuntimeScope(root, {
      scopeRef: 'user:local',
      runtimeDataDir: join(root, '.matos', 'runtime'),
    })
    await materializeMatOSRuntimeScope(scope)

    const runtimeDir = join(
      scope.sharedWorkspaceDir,
      '.matos',
      'runtime',
      'asset-runtime',
    )
    const nestedDir = join(runtimeDir, 'nested')
    const nestedFile = join(nestedDir, 'probe.txt')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(nestedFile, 'ok\n', 'utf8')
    await chmod(runtimeDir, 0o755)
    await chmod(nestedFile, 0o644)

    await repairMatOSRuntimeScopeWritableTrees(scope)

    expect((await stat(runtimeDir)).mode & 0o777).toBe(0o700)
    expect((await stat(nestedFile)).mode & 0o777).toBe(0o600)
  })

  test('keeps source-cache git checkouts readable for workspace tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-runtime-scope-source-cache-'))
    const scope = resolveMatOSRuntimeScope(root, {
      scopeRef: 'user:local',
      runtimeDataDir: join(root, '.matos', 'runtime'),
    })
    await materializeMatOSRuntimeScope(scope)

    const refDir = join(
      scope.sharedWorkspaceDir,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'local',
      'git',
      'matos-user-assets-local',
      '.git',
      'refs',
      'heads',
      'accepted',
    )
    const refFile = join(refDir, 'matos-user-assets-local')
    await mkdir(refDir, { recursive: true })
    await writeFile(refFile, 'abc123\n', 'utf8')
    await chmod(refDir, 0o700)
    await chmod(refFile, 0o600)

    await repairMatOSRuntimeScopeWritableTrees(scope)

    expect((await stat(join(scope.sharedWorkspaceDir, '.matos'))).mode & 0o777).toBe(0o700)
    expect((await stat(refDir)).mode & 0o777).toBe(0o777)
    expect((await stat(refFile)).mode & 0o777).toBe(0o666)
  })
})
