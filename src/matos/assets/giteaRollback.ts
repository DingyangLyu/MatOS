import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { MatOSAssetSourceConfig } from '../project.js'
import { resolveMatOSGitSourceToken } from './sourceAdapters.js'
import {
  createMatOSGiteaPullRequest,
  type MatOSGiteaPullRequestResult,
} from './giteaClient.js'
import type { MatOSAssetValidationResult } from './types.js'
import { matOSGitProcessEnv, matOSGitCheckoutProcessEnv } from './gitProcessEnv.js'
import { resolveMatOSGitAssetSourceRuntimeRepo } from './giteaRuntimeTransport.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { readMatOSGiteaRemoteRefCommit } from './giteaAcceptance.js'

const execFileAsync = promisify(execFile)

export type MatOSGiteaRollbackPrResult = {
  ok: boolean
  action: 'created' | 'noop' | 'validation_failed' | 'preview'
  sourceId: string
  owner: string
  repo: string
  targetBranch: string
  rollbackBranch: string
  restoreRef: string
  restoreCommit: string
  targetCommit: string
  changedPaths: string[]
  validation?: MatOSAssetValidationResult
  rollbackCommit?: string
  pushed: boolean
  pullRequest?: MatOSGiteaPullRequestResult
}

async function git(
  cwd: string,
  args: string[],
  token?: string,
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: await matOSGitCheckoutProcessEnv(cwd, token, args),
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return String(result.stdout ?? '')
}

async function gitMaybe(
  cwd: string,
  args: string[],
  token?: string,
): Promise<string | undefined> {
  try {
    return await git(cwd, args, token)
  } catch {
    return undefined
  }
}

function parseGitStatusPaths(status: string): string[] {
  return status.split('\0').filter(Boolean)
}

async function resolveCommit(
  checkoutRoot: string,
  candidates: string[],
  token?: string,
): Promise<string> {
  for (const candidate of candidates.map(item => item.trim()).filter(Boolean)) {
    const commit = (
      await gitMaybe(checkoutRoot, [
        'rev-parse',
        '--verify',
        `${candidate}^{commit}`,
      ], token)
    )?.trim()
    if (commit) {
      return commit
    }
  }
  throw new Error(`MatOS Gitea rollback ref not found: ${candidates[0] ?? ''}`)
}

function safeRollbackBranch(sourceId: string, restoreCommit: string): string {
  const safeSource = sourceId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'asset-source'
  return `rollback/${safeSource}-${restoreCommit.slice(0, 12)}-${randomUUID().slice(0, 8)}`
}

function giteaString(
  source: MatOSAssetSourceConfig,
  key: string,
): string | undefined {
  const value =
    source.type === 'git' && source.gitea
      ? (source.gitea as Record<string, unknown>)[key]
      : undefined
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export async function createMatOSGiteaRollbackPullRequest(input: {
  cwd: string
  source: MatOSAssetSourceConfig
  apiUrl: string
  token?: string
  owner?: string
  repo?: string
  restoreRef: string
  rollbackBranch?: string
  targetBranch?: string
  title?: string
  body?: string
  paths?: string[]
  expectedTargetCommit?: string
  dryRun?: boolean
  validateRoot: (root: string) => Promise<MatOSAssetValidationResult>
}): Promise<MatOSGiteaRollbackPrResult> {
  if (input.source.type !== 'git') {
    throw new Error(`MatOS asset source is not git-backed: ${input.source.id}`)
  }
  const owner = input.owner?.trim() || giteaString(input.source, 'owner')
  const repo = input.repo?.trim() || giteaString(input.source, 'repo')
  if (!owner || !repo) {
    throw new Error(
      `MatOS Gitea rollback requires --repo <owner/repo> or source gitea metadata: ${input.source.id}`,
    )
  }
  const targetBranch =
    input.targetBranch?.trim() || input.source.ref?.trim() || 'main'
  const restoreRef = input.restoreRef.trim()
  if (!restoreRef) {
    throw new Error('MatOS Gitea rollback requires --from <accepted-ref>')
  }

  input = { ...input, token: resolveMatOSGitSourceToken(input.token, input.source) }
  const runtimeRepo = resolveMatOSGitAssetSourceRuntimeRepo({ cwd: input.cwd, source: input.source as MatOSAssetSourceConfig & { type: 'git' }, repo: (input.source as MatOSAssetSourceConfig & { type: 'git' }).repo })
  const tempRoot = await mkdtempInMatOSTmp({ cwd: input.cwd, prefix: 'matos-rollback-candidate-' })
  const checkoutRoot = join(tempRoot, 'checkout')
  try {
  await execFileAsync('git', ['clone', '--no-checkout', '--', runtimeRepo, checkoutRoot], {
    cwd: input.cwd, env: matOSGitProcessEnv({ token: input.token, repo: runtimeRepo }), timeout: 60_000, maxBuffer: 20 * 1024 * 1024,
  })
  const targetCommit = await resolveCommit(
    checkoutRoot,
    [`origin/${targetBranch}`, targetBranch],
    input.token,
  )
  const restoreCommit = await resolveCommit(
    checkoutRoot,
    [restoreRef, `origin/${restoreRef}`],
    input.token,
  )
  const rollbackBranch =
    input.rollbackBranch?.trim() || safeRollbackBranch(input.source.id, restoreCommit)
  if (input.expectedTargetCommit && input.expectedTargetCommit !== targetCommit) throw new Error('Rollback preview is stale: target branch changed')
    await git(
      checkoutRoot,
      ['checkout', '-B', rollbackBranch, targetCommit],
      input.token,
    )
    const pathspec = input.source.type === 'git' ? input.source.subdir?.trim() || '.' : '.'
    const paths = input.paths ?? [pathspec]
    if (!paths.length || paths.some(path => path !== '.' && (path.startsWith('/') || path.split(/[\\/]/).some(part => part === '..' || part === '.git') || path.includes('\0')))) throw new Error('Invalid rollback asset paths')
    if (pathspec !== '.' && paths.some(path => path !== pathspec && !path.startsWith(`${pathspec}/`))) throw new Error('Rollback paths escape the registered source')
    await git(
      checkoutRoot,
      ['--literal-pathspecs', 'restore', '--source', restoreCommit, '--staged', '--worktree', '--', ...paths],
      input.token,
    )
    const changedPaths = parseGitStatusPaths(
      await git(checkoutRoot, ['diff', '--cached', '--name-only', '-z'], input.token),
    )
    const materializedRoot = input.source.type === 'git' && input.source.subdir
      ? resolve(checkoutRoot, input.source.subdir)
      : checkoutRoot
    const validation = await input.validateRoot(materializedRoot)
    if (!validation.ok) {
      return {
        ok: false,
        action: 'validation_failed',
        sourceId: input.source.id,
        owner,
        repo,
        targetBranch,
        rollbackBranch,
        restoreRef,
        restoreCommit,
        targetCommit,
        changedPaths,
        validation,
        pushed: false,
      }
    }
    if (changedPaths.length === 0) {
      return {
        ok: true,
        action: 'noop',
        sourceId: input.source.id,
        owner,
        repo,
        targetBranch,
        rollbackBranch,
        restoreRef,
        restoreCommit,
        targetCommit,
        changedPaths,
        validation,
        pushed: false,
      }
    }

    if (input.dryRun) return { ok: true, action: 'preview', sourceId: input.source.id, owner, repo, targetBranch, rollbackBranch, restoreRef, restoreCommit, targetCommit, changedPaths, validation, pushed: false }
    if (await readMatOSGiteaRemoteRefCommit({ checkoutRoot, ref: targetBranch, token: input.token }) !== targetCommit) throw new Error('Rollback preview is stale: target branch changed')

    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=MatOS Asset Bot',
        '-c',
        'user.email=matos-assets@localhost',
        'commit',
        '-m',
        input.title?.trim() ||
          `MatOS rollback ${input.source.id} to ${restoreCommit.slice(0, 12)}`,
      ],
      {
        cwd: checkoutRoot,
        env: await matOSGitCheckoutProcessEnv(checkoutRoot, input.token),
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
      },
    )
    const rollbackCommit = (
      await git(checkoutRoot, ['rev-parse', 'HEAD'], input.token)
    ).trim()
    await git(checkoutRoot, ['push', 'origin', `HEAD:${rollbackBranch}`], input.token)
    const pullRequest = await createMatOSGiteaPullRequest({
      apiUrl: input.apiUrl,
      token: input.token,
      owner,
      repo,
      sourceBranch: rollbackBranch,
      targetBranch,
      title:
        input.title?.trim() ||
        `MatOS rollback ${input.source.id} to ${restoreCommit.slice(0, 12)}`,
      body:
        input.body ??
        [
          `Restore MatOS asset source ${input.source.id} to accepted ref ${restoreRef}.`,
          '',
          `Restore commit: ${restoreCommit}`,
          `Target branch: ${targetBranch}`,
          '',
          'MatOS validated the restored asset tree before opening this PR.',
        ].join('\n'),
    })

    return {
      ok: true,
      action: 'created',
      sourceId: input.source.id,
      owner,
      repo,
      targetBranch,
      rollbackBranch,
      restoreRef,
      restoreCommit,
      targetCommit,
      changedPaths,
      validation,
      rollbackCommit,
      pushed: true,
      pullRequest,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
