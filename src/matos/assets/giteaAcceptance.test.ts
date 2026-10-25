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
import { describe, expect, spyOn, test } from 'bun:test'
import type { MatOSGitAssetSourceConfig } from '../project.js'
import {
  MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV,
  acceptMatOSGiteaAssetSourceCommit,
  matOSAcceptedBranchForSource,
  readMatOSGiteaRemoteRefCommit,
  updateMatOSGiteaAcceptedRefWithLease,
} from './giteaAcceptance.js'
import { loadMatOSAssets } from './loadAssets.js'
import { validateMatOSAssets } from './validateAssets.js'

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

/**
 * Real workflow assets mirroring the deep-research incident shape: an
 * agentic workflow whose loop node drives a child subworkflow. Exact
 * template strings ("{{ parameters.maxRounds }}") are now a sanctioned
 * maxIterations form (validateWorkflow resolves them), so the invalid
 * probe uses a garbage non-template string: shallow asset validation
 * still cannot see it, while deep workflow validation must reject it.
 */
async function createGitWorkflowPack(input: {
  repo: string
  packId: string
  loopMaxIterations: number | string
}): Promise<void> {
  const packRoot = join(input.repo, 'packs', input.packId)
  await mkdir(join(packRoot, 'workflows', 'agentic-loop'), { recursive: true })
  await mkdir(join(packRoot, 'workflows', 'loop-child'), { recursive: true })
  await writeJson(join(packRoot, 'matos.pack.json'), {
    id: input.packId,
    name: input.packId,
    version: '1.0.0',
  })
  await writeJson(join(packRoot, 'workflows', 'agentic-loop', 'asset.json'), {
    schemaVersion: 1,
    id: 'agentic-loop',
    type: 'workflow',
    name: 'Agentic Loop',
    version: '0.3.1',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'executable', approvalMode: 'bypass' } },
  })
  const maxIterations =
    typeof input.loopMaxIterations === 'string'
      ? JSON.stringify(input.loopMaxIterations)
      : String(input.loopMaxIterations)
  await writeFile(
    join(packRoot, 'workflows', 'agentic-loop', 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: agentic-loop',
      'version: "0.3.1"',
      'parameters:',
      '  maxRounds:',
      '    type: number',
      '    default: 4',
      'nodes:',
      '  rounds:',
      '    type: loop',
      '    workflow: workflow:loop-child',
      `    maxIterations: ${maxIterations}`,
      '    iterationParameter: iteration',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(packRoot, 'workflows', 'loop-child', 'asset.json'), {
    schemaVersion: 1,
    id: 'loop-child',
    type: 'workflow',
    name: 'Loop Child',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'component' } },
  })
  await writeFile(
    join(packRoot, 'workflows', 'loop-child', 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: loop-child',
      'version: "0.1.0"',
      'nodes:',
      '  work:',
      '    type: exec',
      '    command: "printf ok"',
      '',
    ].join('\n'),
    'utf8',
  )
}

function acceptanceValidateRoot(root: string) {
  return async (rootPath: string) => {
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [rootPath],
      includeDefaultAssetRoots: false,
    })
    return validateMatOSAssets(await loadMatOSAssets(root))
  }
}

describe('MatOS Gitea asset acceptance', () => {
  test('builds deterministic accepted branch names', () => {
    expect(matOSAcceptedBranchForSource({ sourceId: 'matos-core-assets' })).toBe(
      'accepted/matos-core-assets/stable',
    )
    expect(
      matOSAcceptedBranchForSource({
        sourceId: 'matos user assets alice@example.com',
        channel: 'main',
      }),
    ).toBe('accepted/matos-user-assets-alice-example-com/main')
  })

  test('rejects a stale accepted-ref writer instead of overwriting a concurrent update', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'matos-gitea-cas-remote-'))
    const seed = await mkdtemp(join(tmpdir(), 'matos-gitea-cas-seed-'))
    const first = await mkdtemp(join(tmpdir(), 'matos-gitea-cas-first-'))
    const second = await mkdtemp(join(tmpdir(), 'matos-gitea-cas-second-'))
    await git(remote, ['init', '--bare'])
    await git(seed, ['init', '-b', 'main'])
    await writeFile(join(seed, 'asset.json'), '{"version":1}\n', 'utf8')
    await commitAll(seed, 'initial')
    await git(seed, ['remote', 'add', 'origin', remote])
    await git(seed, ['push', 'origin', 'main'])
    await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const initial = await git(seed, ['rev-parse', 'HEAD'])
    const branch = 'accepted/cas-source/stable'
    await git(seed, ['push', 'origin', `${initial}:refs/heads/${branch}`])
    await git(first, ['clone', remote, '.'])
    await git(second, ['clone', remote, '.'])

    await writeFile(join(first, 'asset.json'), '{"version":2}\n', 'utf8')
    await commitAll(first, 'first update')
    const firstCommit = await git(first, ['rev-parse', 'HEAD'])
    await writeFile(join(second, 'asset.json'), '{"version":3}\n', 'utf8')
    await commitAll(second, 'second update')
    const secondCommit = await git(second, ['rev-parse', 'HEAD'])

    const observed = await readMatOSGiteaRemoteRefCommit({
      checkoutRoot: first,
      ref: branch,
    })
    expect(observed).toBe(initial)
    expect(await readMatOSGiteaRemoteRefCommit({
      checkoutRoot: first, ref: `refs/heads/${branch}`,
    })).toBe(initial)
    await updateMatOSGiteaAcceptedRefWithLease({
      checkoutRoot: second,
      acceptedBranch: branch,
      targetCommit: secondCommit,
      expectedRemoteCommit: initial,
    })
    await expect(
      updateMatOSGiteaAcceptedRefWithLease({
        checkoutRoot: first,
        acceptedBranch: branch,
        targetCommit: firstCommit,
        expectedRemoteCommit: initial,
      }),
    ).rejects.toThrow(/stale info|rejected|force-with-lease/i)
    expect(
      await readMatOSGiteaRemoteRefCommit({ checkoutRoot: first, ref: branch }),
    ).toBe(secondCommit)
  })

  test('records a successful push before a failing readback so rollback retains its lease', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'matos-gitea-readback-remote-'))
    const seed = await mkdtemp(join(tmpdir(), 'matos-gitea-readback-seed-'))
    await git(remote, ['init', '--bare'])
    await git(seed, ['init', '-b', 'main'])
    await writeFile(join(seed, 'asset.json'), '{"version":1}\n')
    await commitAll(seed, 'initial')
    await git(seed, ['remote', 'add', 'origin', remote])
    const commit = await git(seed, ['rev-parse', 'HEAD'])
    let recorded = false
    await expect(updateMatOSGiteaAcceptedRefWithLease({
      checkoutRoot: seed,
      acceptedBranch: 'accepted/readback/stable',
      targetCommit: commit,
      expectedRemoteCommit: null,
      onPushed: async () => {
        recorded = true
        // Real Git readback failure, after the remote has accepted the push.
        await git(seed, ['remote', 'set-url', 'origin', join(remote, 'offline')])
      },
    })).rejects.toThrow()
    expect(recorded).toBe(true)
    expect(await git(remote, ['rev-parse', 'refs/heads/accepted/readback/stable'])).toBe(commit)
  })

  test('validates and accepts a local git asset source commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-accept-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-accept-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accept-pack',
      roleId: 'accept-role',
      roleName: 'Accepted Through Service',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'candidate asset content')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'accept-source',
      repo,
      ref: 'main',
      subdir: 'packs/accept-pack',
      scope: 'project',
      refresh: 'manual',
    }

    const accepted = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: 'main',
      channel: 'stable',
      push: true,
      validateRoot: async rootPath => {
        await writeJson(join(root, '.matos', 'matos.json'), {
          version: 1,
          assetRoots: [rootPath],
          includeDefaultAssetRoots: false,
        })
        return validateMatOSAssets(await loadMatOSAssets(root))
      },
    })

    expect(accepted.ok).toBe(true)
    expect(accepted.acceptedBranch).toBe('accepted/accept-source/stable')
    expect(accepted.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/accept-source/stable',
      commit: accepted.commit,
    })
    expect(accepted.validation.ok).toBe(true)
    expect(await git(repo, ['rev-parse', 'accepted/accept-source/stable'])).toBe(
      accepted.commit,
    )
  })

  test('commits a prepared candidate before publishing the accepted ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-prepare-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-prepare-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'prepare-pack',
      roleId: 'prepare-role',
      roleName: 'Prepared Candidate',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'candidate asset content')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'prepare-source',
      repo,
      ref: 'main',
      subdir: 'packs/prepare-pack',
      scope: 'project',
      refresh: 'manual',
    }
    const accepted = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: 'main',
      channel: 'stable',
      push: true,
      prepareCandidate: async rootPath => {
        const manifestPath = join(
          rootPath,
          'roles',
          'prepare-role',
          'asset.json',
        )
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
          string,
          unknown
        >
        manifest.description = 'Prepared during acceptance'
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        return { changed: true, summary: 'Repair prepared candidate in test' }
      },
      validateRoot: async rootPath => {
        await writeJson(join(root, '.matos', 'matos.json'), {
          version: 1,
          assetRoots: [rootPath],
          includeDefaultAssetRoots: false,
        })
        return validateMatOSAssets(await loadMatOSAssets(root))
      },
    })
    const sourceCommit = await git(repo, ['rev-parse', 'main'])
    expect(accepted.ok).toBe(true)
    expect(accepted.candidatePreparation).toMatchObject({ changed: true })
    expect(accepted.commit).not.toBe(sourceCommit)
    expect(await git(repo, ['rev-parse', 'accepted/prepare-source/stable'])).toBe(
      accepted.commit,
    )
  })

  test('rejects a candidate that would erase a newer accepted commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-non-ff-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-non-ff-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'non-ff-pack',
      roleId: 'non-ff-role',
      roleName: 'Initial',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'initial')
    const initial = await git(repo, ['rev-parse', 'HEAD'])
    const acceptedBranch = 'accepted/non-ff-source/stable'
    await git(repo, ['branch', acceptedBranch, initial])

    await git(repo, ['checkout', '-b', 'concurrent', initial])
    await writeFile(join(repo, 'concurrent.md'), 'accepted elsewhere\n', 'utf8')
    await commitAll(repo, 'concurrent accepted update')
    const concurrent = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', '-f', acceptedBranch, concurrent])

    await git(repo, ['checkout', '-B', 'main', initial])
    await writeFile(join(repo, 'candidate.md'), 'stale candidate\n', 'utf8')
    await commitAll(repo, 'candidate from stale baseline')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'non-ff-source',
      repo,
      ref: 'main',
      subdir: 'packs/non-ff-pack',
      scope: 'project',
      refresh: 'manual',
    }

    await expect(
      acceptMatOSGiteaAssetSourceCommit({
        cwd: root,
        source,
        ref: 'main',
        channel: 'stable',
        push: true,
        validateRoot: async rootPath => {
          await writeJson(join(root, '.matos', 'matos.json'), {
            version: 1,
            assetRoots: [rootPath],
            includeDefaultAssetRoots: false,
          })
          return validateMatOSAssets(await loadMatOSAssets(root))
        },
      }),
      // The refusal must name refs/heads/accepted/... so gateway provisioning
      // recognizes it and falls back to adopting the remote accepted commit.
    ).rejects.toThrow(/non-fast-forward.*refs\/heads\/accepted\/.*does not contain current remote/i)
    expect(await git(repo, ['rev-parse', acceptedBranch])).toBe(concurrent)
  })

  test('adopts a remote accepted branch that was never fetched locally', async () => {
    // Regression: the remote accepted branch had been advanced by another
    // execution surface (for example container-side self-evolution
    // acceptance), so the local workspace checkout had neither the
    // remote-tracking ref nor the commit objects. Acceptance with
    // `ref: origin/accepted/...` then failed "acceptance ref not found" and
    // gateway provisioning looped on a non-fast-forward refusal forever.
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-adopt-root-'))
    const remote = await mkdtemp(join(tmpdir(), 'matos-gitea-adopt-remote-'))
    const seed = await mkdtemp(join(tmpdir(), 'matos-gitea-adopt-seed-'))
    const otherSurface = await mkdtemp(join(tmpdir(), 'matos-gitea-adopt-other-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await git(remote, ['init', '--bare'])
    await createGitRolePack({
      repo: seed,
      packId: 'adopt-pack',
      roleId: 'adopt-role',
      roleName: 'Initial Role',
    })
    await git(seed, ['init', '-b', 'main'])
    await commitAll(seed, 'initial')
    await git(seed, ['remote', 'add', 'origin', remote])
    await git(seed, ['push', 'origin', 'main'])
    await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'adopt-source',
      repo: remote,
      ref: 'main',
      subdir: 'packs/adopt-pack',
      scope: 'project',
      refresh: 'always',
    }
    const acceptedBranch = 'accepted/adopt-source/stable'
    const validateRoot = async (rootPath: string) => {
      await writeJson(join(root, '.matos', 'matos.json'), {
        version: 1,
        assetRoots: [rootPath],
        includeDefaultAssetRoots: false,
      })
      return validateMatOSAssets(await loadMatOSAssets(root))
    }

    // Materialize the local checkout at main before the accepted branch
    // advances, so the accepted-only commits are unknown to it.
    const seededAcceptance = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: 'main',
      channel: 'stable',
      push: true,
      validateRoot,
    })
    expect(seededAcceptance.ok).toBe(true)

    await git(otherSurface, ['clone', remote, '.'])
    await git(otherSurface, ['checkout', '-b', acceptedBranch, `origin/${acceptedBranch}`])
    await writeJson(
      join(otherSurface, 'packs', 'adopt-pack', 'roles', 'adopt-role', 'asset.json'),
      {
        id: 'adopt-role',
        type: 'role',
        name: 'Role Accepted On Another Surface',
        version: '1.0.1',
        path: '.',
      },
    )
    await commitAll(otherSurface, 'advance accepted from another surface')
    const advancedAccepted = await git(otherSurface, ['rev-parse', 'HEAD'])
    await git(otherSurface, ['push', 'origin', `HEAD:refs/heads/${acceptedBranch}`])

    const adopted = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: `origin/${acceptedBranch}`,
      channel: 'stable',
      push: false,
      validateRoot,
    })
    expect(adopted.ok).toBe(true)
    expect(adopted.commit).toBe(advancedAccepted)
    expect(adopted.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: acceptedBranch,
      commit: advancedAccepted,
    })
  })

  test('accepts a full remote commit SHA that is not present locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-sha-root-'))
    const remote = await mkdtemp(join(tmpdir(), 'matos-gitea-sha-remote-'))
    const seed = await mkdtemp(join(tmpdir(), 'matos-gitea-sha-seed-'))
    const candidate = await mkdtemp(join(tmpdir(), 'matos-gitea-sha-candidate-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await git(remote, ['init', '--bare'])
    await createGitRolePack({
      repo: seed,
      packId: 'sha-pack',
      roleId: 'sha-role',
      roleName: 'Initial SHA Role',
    })
    await git(seed, ['init', '-b', 'main'])
    await commitAll(seed, 'initial')
    await git(seed, ['remote', 'add', 'origin', remote])
    await git(seed, ['push', 'origin', 'main'])
    await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'sha-source',
      repo: remote,
      ref: 'main',
      subdir: 'packs/sha-pack',
      scope: 'project',
      refresh: 'always',
    }
    const validateRoot = acceptanceValidateRoot(root)
    await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: 'main',
      channel: 'stable',
      push: true,
      validateRoot,
    })

    await git(candidate, ['clone', remote, '.'])
    await git(candidate, ['checkout', '-b', 'evolution/sha-candidate'])
    await writeJson(
      join(candidate, 'packs', 'sha-pack', 'roles', 'sha-role', 'asset.json'),
      {
        id: 'sha-role',
        type: 'role',
        name: 'Candidate Available Only By SHA',
        version: '1.0.1',
        path: '.',
      },
    )
    await commitAll(candidate, 'candidate commit')
    const candidateCommit = await git(candidate, ['rev-parse', 'HEAD'])
    await git(candidate, ['push', 'origin', 'HEAD:refs/heads/evolution/sha-candidate'])

    const accepted = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: candidateCommit,
      channel: 'stable',
      push: true,
      validateRoot,
    })
    expect(accepted.ok).toBe(true)
    expect(accepted.commit).toBe(candidateCommit)
    expect(accepted.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      commit: candidateCommit,
    })
  })

  test('repairs a transient checkout index failure during acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-accept-retry-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-accept-retry-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitRolePack({
      repo,
      packId: 'accept-retry-pack',
      roleId: 'accept-retry-role',
      roleName: 'Accepted After Retry',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'candidate asset content')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'accept-retry-source',
      repo,
      ref: 'main',
      subdir: 'packs/accept-retry-pack',
      scope: 'project',
      refresh: 'always',
    }

    const fakeBin = await mkdtemp(join(tmpdir(), 'matos-gitea-fake-git-'))
    const realGit = (await execFileAsync('command', ['-v', 'git'], {
      shell: true,
    })).stdout.toString().trim()
    const countFile = join(fakeBin, 'checkout-count')
    const failedMarker = join(fakeBin, 'acceptance-checkout-failed')
    await writeFile(
      join(fakeBin, 'git'),
      [
        '#!/bin/sh',
        'case " $* " in',
        '  *" checkout --force --detach "*)',
        '    count=0',
        '    if [ -f "$MATOS_TEST_GIT_CHECKOUT_COUNT" ]; then count=$(cat "$MATOS_TEST_GIT_CHECKOUT_COUNT"); fi',
        '    count=$((count + 1))',
        '    printf "%s" "$count" > "$MATOS_TEST_GIT_CHECKOUT_COUNT"',
        '    if [ "$count" = "2" ]; then',
        '      touch "$MATOS_TEST_GIT_ACCEPTANCE_FAILURE_MARKER"',
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
    const previousCount = process.env.MATOS_TEST_GIT_CHECKOUT_COUNT
    const previousFailure = process.env.MATOS_TEST_GIT_ACCEPTANCE_FAILURE_MARKER
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    process.env.MATOS_TEST_REAL_GIT = realGit
    process.env.MATOS_TEST_GIT_CHECKOUT_COUNT = countFile
    process.env.MATOS_TEST_GIT_ACCEPTANCE_FAILURE_MARKER = failedMarker
    try {
      const accepted = await acceptMatOSGiteaAssetSourceCommit({
        cwd: root,
        source,
        ref: 'main',
        channel: 'stable',
        push: true,
        validateRoot: async rootPath => {
          await writeJson(join(root, '.matos', 'matos.json'), {
            version: 1,
            assetRoots: [rootPath],
            includeDefaultAssetRoots: false,
          })
          return validateMatOSAssets(await loadMatOSAssets(root))
        },
      })
      expect(accepted.ok).toBe(true)
      expect(await git(repo, ['rev-parse', 'accepted/accept-retry-source/stable'])).toBe(
        accepted.commit,
      )
      expect(Boolean(await stat(failedMarker).catch(() => undefined))).toBe(true)
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
      if (previousCount === undefined) {
        delete process.env.MATOS_TEST_GIT_CHECKOUT_COUNT
      } else {
        process.env.MATOS_TEST_GIT_CHECKOUT_COUNT = previousCount
      }
      if (previousFailure === undefined) {
        delete process.env.MATOS_TEST_GIT_ACCEPTANCE_FAILURE_MARKER
      } else {
        process.env.MATOS_TEST_GIT_ACCEPTANCE_FAILURE_MARKER = previousFailure
      }
    }
  })

  test('accepts a candidate whose workflow assets pass asset-aware validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-valid-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-valid-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitWorkflowPack({
      repo,
      packId: 'wf-valid-pack',
      loopMaxIterations: 4,
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'valid workflow candidate')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'wf-valid-source',
      repo,
      ref: 'main',
      subdir: 'packs/wf-valid-pack',
      scope: 'project',
      refresh: 'manual',
    }

    const accepted = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: 'main',
      channel: 'stable',
      push: true,
      validateRoot: acceptanceValidateRoot(root),
    })

    expect(accepted.ok).toBe(true)
    expect(accepted.workflowValidation?.validated).toBe(2)
    expect(accepted.workflowValidation?.failures).toEqual([])
    expect(accepted.workflowValidation?.skippedByEnv).toBeUndefined()
    expect(await git(repo, ['rev-parse', 'accepted/wf-valid-source/stable'])).toBe(
      accepted.commit,
    )
  }, 60000)

  test('resolves workflow references to assets in the project asset roots outside the candidate', async () => {
    // Standalone projects also load the installed bundle and their configured
    // asset roots; a project workflow that references those assets must pass.
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-base-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-base-repo-'))
    const baseRoot = join(root, '.matos', 'assets')
    await mkdir(join(baseRoot, 'workflows', 'base-child'), { recursive: true })
    await writeJson(join(baseRoot, 'workflows', 'base-child', 'asset.json'), {
      schemaVersion: 1,
      id: 'base-child',
      type: 'workflow',
      name: 'Base Child',
      version: '1.0.0',
      entry: 'workflow.yaml',
      runtime: { workflow: { kind: 'component' } },
    })
    await writeFile(
      join(baseRoot, 'workflows', 'base-child', 'workflow.yaml'),
      ['schemaVersion: 1', 'name: base-child', 'version: "1.0.0"', 'nodes:', '  work:', '    type: exec', '    command: "printf ok"', ''].join('\n'),
      'utf8',
    )
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    const packRoot = join(repo, 'packs', 'wf-base-pack')
    await mkdir(join(packRoot, 'workflows', 'uses-base'), { recursive: true })
    await writeJson(join(packRoot, 'matos.pack.json'), { id: 'wf-base-pack', name: 'wf-base-pack', version: '1.0.0' })
    await writeJson(join(packRoot, 'workflows', 'uses-base', 'asset.json'), {
      schemaVersion: 1,
      id: 'uses-base',
      type: 'workflow',
      name: 'Uses Base',
      version: '0.1.0',
      entry: 'workflow.yaml',
      runtime: { workflow: { kind: 'executable', approvalMode: 'bypass' } },
    })
    await writeFile(
      join(packRoot, 'workflows', 'uses-base', 'workflow.yaml'),
      ['schemaVersion: 1', 'name: uses-base', 'version: "0.1.0"', 'nodes:', '  child:', '    type: subworkflow', '    workflow: workflow:base-child', ''].join('\n'),
      'utf8',
    )
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'workflow that references a project asset root')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'wf-base-source',
      repo,
      ref: 'main',
      subdir: 'packs/wf-base-pack',
      scope: 'project',
      refresh: 'manual',
    }

    const accepted = await acceptMatOSGiteaAssetSourceCommit({
      cwd: root,
      source,
      ref: 'main',
      channel: 'stable',
      push: true,
      // Shallow validation in its own project, so the project config above stays intact.
      validateRoot: async rootPath => {
        const cwd = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-base-validate-'))
        await mkdir(join(cwd, '.matos'), { recursive: true })
        await writeJson(join(cwd, '.matos', 'matos.json'), {
          version: 1,
          assetRoots: [rootPath, baseRoot],
          includeDefaultAssetRoots: false,
        })
        return validateMatOSAssets(await loadMatOSAssets(cwd))
      },
    })

    expect(accepted.ok).toBe(true)
    expect(accepted.workflowValidation?.validated).toBe(1)
    expect(accepted.workflowValidation?.failures).toEqual([])
  }, 60000)

  test('refuses acceptance when a loop-node workflow fails validation, naming the workflow ref', async () => {
    // Incident regression: workflow:deep-research-agentic@0.3.1 shipped a loop
    // node with maxIterations "{{ parameters.maxRounds }}" — invalid per
    // validateWorkflowDefinition and guaranteed to throw at runtime — yet the
    // accept gate advanced the accepted runtime ref because it ran only
    // shallow asset validation.
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-invalid-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-invalid-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitWorkflowPack({
      repo,
      packId: 'wf-invalid-pack',
      loopMaxIterations: 'lots-of-rounds',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'invalid loop workflow candidate')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'wf-invalid-source',
      repo,
      ref: 'main',
      subdir: 'packs/wf-invalid-pack',
      scope: 'project',
      refresh: 'manual',
    }

    // Shallow asset validation alone accepts this tree — proving the gate
    // must look inside workflow definitions to catch the incident class.
    await writeJson(join(root, '.matos', 'matos.json'), {
      version: 1,
      assetRoots: [join(repo, 'packs', 'wf-invalid-pack')],
      includeDefaultAssetRoots: false,
    })
    const shallow = await validateMatOSAssets(await loadMatOSAssets(root))
    expect(shallow.ok).toBe(true)

    await expect(
      acceptMatOSGiteaAssetSourceCommit({
        cwd: root,
        source,
        ref: 'main',
        channel: 'stable',
        push: true,
        validateRoot: acceptanceValidateRoot(root),
      }),
    ).rejects.toThrow(
      /refused for source wf-invalid-source[\s\S]*workflow:agentic-loop@0\.3\.1[\s\S]*maxIterations/,
    )
    // The accepted branch must not exist locally or on the remote.
    await expect(
      git(repo, ['rev-parse', '--verify', 'refs/heads/accepted/wf-invalid-source/stable']),
    ).rejects.toThrow()
  }, 60000)

  test('emergency env override accepts an invalid workflow candidate with a loud warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-override-root-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-gitea-wf-override-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await createGitWorkflowPack({
      repo,
      packId: 'wf-override-pack',
      loopMaxIterations: 'lots-of-rounds',
    })
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'invalid loop workflow candidate for override')
    const source: MatOSGitAssetSourceConfig = {
      type: 'git',
      id: 'wf-override-source',
      repo,
      ref: 'main',
      subdir: 'packs/wf-override-pack',
      scope: 'project',
      refresh: 'manual',
    }

    const previousOverride = process.env[MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV]
    process.env[MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV] = '1'
    const stderrSpy = spyOn(process.stderr, 'write')
    try {
      const accepted = await acceptMatOSGiteaAssetSourceCommit({
        cwd: root,
        source,
        ref: 'main',
        channel: 'stable',
        push: true,
        validateRoot: acceptanceValidateRoot(root),
      })
      expect(accepted.ok).toBe(true)
      expect(accepted.workflowValidation?.skippedByEnv).toBe(true)
      expect(accepted.workflowValidation?.failures).toHaveLength(1)
      expect(accepted.workflowValidation?.failures[0]?.ref).toBe(
        'workflow:agentic-loop@0.3.1',
      )
      expect(
        await git(repo, ['rev-parse', 'accepted/wf-override-source/stable']),
      ).toBe(accepted.commit)
      const warnings = stderrSpy.mock.calls
        .map(call => String(call[0]))
        .filter(text => text.includes('[matos-assets-accept] WARNING'))
      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings.join('\n')).toContain(
        MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV,
      )
      expect(warnings.join('\n')).toContain('workflow:agentic-loop@0.3.1')
    } finally {
      stderrSpy.mockRestore()
      if (previousOverride === undefined) {
        delete process.env[MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV]
      } else {
        process.env[MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV] = previousOverride
      }
    }
  }, 60000)
})
