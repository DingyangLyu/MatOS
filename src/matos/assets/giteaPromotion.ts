import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { MatOSAssetValidationResult } from './types.js'
import {
  commitMatOSGitAssetSource,
  materializeMatOSAssetSource,
  matOSGitAssetSourceCheckoutRoot,
  repairMatOSGitAssetSourceCachePermissions,
  type MatOSGitAssetSourceCommitResult,
} from './sourceAdapters.js'
import {
  buildMatOSAssetMergePlan,
  type MatOSAssetMergePlan,
  type MatOSAssetMergePlanItem,
} from './mergePlan.js'
import {
  createMatOSGiteaCommitStatus,
  createMatOSGiteaPullRequest,
  mergeMatOSGiteaPullRequest,
  type MatOSGiteaPullRequestMergeResult,
  type MatOSGiteaPullRequestResult,
} from './giteaClient.js'
import {
  acceptMatOSGiteaAssetSourceCommit,
  type MatOSGiteaAssetAcceptanceResult,
} from './giteaAcceptance.js'
import { matOSGitProcessEnv } from './gitProcessEnv.js'
import {
  getMatOSDir,
  type MatOSGitAssetSourceConfig,
} from '../project.js'

const execFileAsync = promisify(execFile)

export type MatOSGiteaAssetPromotionCreateResult = {
  ok: boolean
  action: 'pr_created' | 'validation_failed' | 'no_changes'
  promotionId: string
  fromSourceId: string
  toSourceId: string
  fromRoot: string
  targetRoot: string
  branch: string
  targetBranch: string
  plan: MatOSAssetMergePlan
  applied: MatOSGiteaAssetPromotionApplyItem[]
  skipped: MatOSGiteaAssetPromotionApplyItem[]
  validation: MatOSAssetValidationResult
  commit?: MatOSGitAssetSourceCommitResult
  pullRequest?: MatOSGiteaPullRequestResult
  statusWritten?: boolean
  recordPath: string
  acceptedRefAdvanced: false
}

export type MatOSGiteaAssetPromotionApplyResult = {
  ok: boolean
  action: 'merged_accepted' | 'blocked_by_policy' | 'accept_failed'
  toSourceId: string
  pullRequest?: MatOSGiteaPullRequestMergeResult
  acceptance?: MatOSGiteaAssetAcceptanceResult
  gates: MatOSGiteaAssetPromotionApplyGates
  statusWritten?: string[]
  recordPath?: string
  acceptedRefAdvanced: boolean
}

export type MatOSGiteaAssetPromotionApplyGates = {
  reviewed: boolean
  benchmarkPassed: boolean
  judgePassed: boolean
}

export type MatOSGiteaAssetPromotionApplyItem = {
  identityKey: string
  action: MatOSAssetMergePlanItem['action']
  reason?: string
  upstreamDir?: string
  targetDir?: string
  createdPackManifestPath?: string
}

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

function resolveUnderRoot(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`MatOS promotion path must be relative: ${relativePath}`)
  }
  const resolvedRoot = resolve(root)
  const resolved = resolve(join(resolvedRoot, relativePath))
  if (!isWithin(resolved, resolvedRoot)) {
    throw new Error(`MatOS promotion path escapes root: ${relativePath}`)
  }
  return resolved
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function git(
  cwd: string,
  args: string[],
  options: { token?: string } = {},
): Promise<string> {
  const result = await execFileAsync(
    'git',
    ['-c', `safe.directory=${resolve(cwd)}`, ...args],
    {
      cwd,
      env: matOSGitProcessEnv(options),
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  return String(result.stdout ?? '')
}

function packManifestRelativePathForAssetManifest(
  manifestPath: string,
): string | undefined {
  const segments = manifestPath.split('/').filter(Boolean)
  if (segments[0] !== 'packs' || !segments[1]) {
    return undefined
  }
  return ['packs', segments[1], 'matos.pack.json'].join('/')
}

function promotionBranch(input: {
  fromSource: MatOSGitAssetSourceConfig
  toSource: MatOSGitAssetSourceConfig
  explicit?: string
}): string {
  const explicit = input.explicit?.trim()
  if (explicit) {
    return explicit
  }
  const seed = `${input.fromSource.id}-${input.toSource.id}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return `promotion/${seed || 'matos-evolution'}`
}

function promotionIdFor(input: {
  fromSourceId: string
  toSourceId: string
  branch: string
  plan: MatOSAssetMergePlan
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        fromSourceId: input.fromSourceId,
        toSourceId: input.toSourceId,
        branch: input.branch,
        summary: input.plan.summary,
        items: input.plan.items.map(item => ({
          action: item.action,
          identityKey: item.identityKey,
          changedPaths: item.changedPaths,
        })),
      }),
    )
    .digest('hex')
    .slice(0, 16)
}

function promotionApplyIdFor(input: {
  toSourceId: string
  owner: string
  repo: string
  number: number
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        toSourceId: input.toSourceId,
        owner: input.owner,
        repo: input.repo,
        number: input.number,
      }),
    )
    .digest('hex')
    .slice(0, 16)
}

function shouldApplyPromotionItem(item: MatOSAssetMergePlanItem): boolean {
  return Boolean(
    item.upstreamManifestPath &&
      item.action !== 'blocked' &&
      item.action !== 'no_change',
  )
}

async function applyPromotionPlan(input: {
  fromRoot: string
  targetRoot: string
  plan: MatOSAssetMergePlan
}): Promise<{
  applied: MatOSGiteaAssetPromotionApplyItem[]
  skipped: MatOSGiteaAssetPromotionApplyItem[]
}> {
  const applied: MatOSGiteaAssetPromotionApplyItem[] = []
  const skipped: MatOSGiteaAssetPromotionApplyItem[] = []
  for (const item of input.plan.items) {
    if (!shouldApplyPromotionItem(item) || !item.upstreamManifestPath) {
      skipped.push({
        identityKey: item.identityKey,
        action: item.action,
        reason: item.reason,
      })
      continue
    }
    const upstreamRelativeDir = dirname(item.upstreamManifestPath)
    const targetRelativeDir = item.targetManifestPath
      ? dirname(item.targetManifestPath)
      : upstreamRelativeDir
    const upstreamDir = resolveUnderRoot(input.fromRoot, upstreamRelativeDir)
    const targetDir = resolveUnderRoot(input.targetRoot, targetRelativeDir)
    await mkdir(dirname(targetDir), { recursive: true })
    await rm(targetDir, { recursive: true, force: true })
    await cp(upstreamDir, targetDir, { recursive: true })
    let createdPackManifestPath: string | undefined
    const packManifestRelativePath = packManifestRelativePathForAssetManifest(
      item.upstreamManifestPath,
    )
    if (packManifestRelativePath && !item.targetManifestPath) {
      const upstreamPackManifest = resolveUnderRoot(
        input.fromRoot,
        packManifestRelativePath,
      )
      const targetPackManifest = resolveUnderRoot(
        input.targetRoot,
        packManifestRelativePath,
      )
      if (
        (await pathExists(upstreamPackManifest)) &&
        !(await pathExists(targetPackManifest))
      ) {
        await mkdir(dirname(targetPackManifest), { recursive: true })
        await cp(upstreamPackManifest, targetPackManifest)
        createdPackManifestPath = targetPackManifest
      }
    }
    applied.push({
      identityKey: item.identityKey,
      action: item.action,
      upstreamDir,
      targetDir,
      ...(createdPackManifestPath ? { createdPackManifestPath } : {}),
    })
  }
  return { applied, skipped }
}

async function writePromotionRecord(input: {
  cwd: string
  promotionId: string
  value: unknown
}): Promise<string> {
  // promotionId is sha256-derived today, but guard the id->filename join so a
  // future caller can never traverse out of the promotions dir.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.promotionId)) {
    throw new Error(
      `invalid gitea promotion id (must be a filename-safe token): ${input.promotionId}`,
    )
  }
  const dir = join(getMatOSDir(input.cwd), 'evolution', 'gitea-promotions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${input.promotionId}.json`)
  await writeFile(path, `${JSON.stringify(input.value, null, 2)}\n`, 'utf8')
  return path
}

export async function createMatOSGiteaAssetPromotionReview(input: {
  cwd: string
  fromSource: MatOSGitAssetSourceConfig
  toSource: MatOSGitAssetSourceConfig
  apiUrl: string
  token?: string
  fromRef?: string
  promotionBranch?: string
  targetBranch?: string
  title?: string
  body?: string
  pullRequestTarget?: {
    owner: string
    repo: string
    sourceOwner?: string
  }
  prepareTargetRoot?: (root: string) => Promise<void>
  validateRoot: (root: string) => Promise<MatOSAssetValidationResult>
}): Promise<MatOSGiteaAssetPromotionCreateResult> {
  const targetBranch =
    input.targetBranch?.trim() || input.toSource.ref?.trim() || 'main'
  const branch = promotionBranch({
    fromSource: input.fromSource,
    toSource: input.toSource,
    explicit: input.promotionBranch,
  })
  const fromCandidate: MatOSGitAssetSourceConfig = {
    ...input.fromSource,
    ...(input.fromRef?.trim() ? { ref: input.fromRef.trim() } : {}),
    runtimeRef: { mode: 'source-ref' },
  }
  const targetCandidate: MatOSGitAssetSourceConfig = {
    ...input.toSource,
    ref: targetBranch,
    runtimeRef: { mode: 'source-ref' },
  }
  try {
  const fromRoot = await materializeMatOSAssetSource(input.cwd, fromCandidate, {
    refresh: 'always',
    token: input.token,
  })
  const targetRoot = await materializeMatOSAssetSource(input.cwd, targetCandidate, {
    refresh: 'always',
    token: input.token,
  })
  const targetCheckoutRoot = matOSGitAssetSourceCheckoutRoot(
    input.cwd,
    input.toSource,
  )
  const targetCommit = (await git(targetCheckoutRoot, ['rev-parse', 'HEAD'], {
    token: input.token,
  })).trim()
  await git(targetCheckoutRoot, ['checkout', '-B', branch, targetCommit], {
    token: input.token,
  })
  const plan = await buildMatOSAssetMergePlan({
    upstreamRoot: fromRoot,
    targetRoot,
    upstreamSourceId: input.fromSource.id,
    targetSourceId: input.toSource.id,
  })
  const applied = await applyPromotionPlan({ fromRoot, targetRoot, plan })
  if (input.prepareTargetRoot) {
    await input.prepareTargetRoot(targetRoot)
  }
  const validation = await input.validateRoot(targetRoot)
  const promotionId = promotionIdFor({
    fromSourceId: input.fromSource.id,
    toSourceId: input.toSource.id,
    branch,
    plan,
  })

  if (!validation.ok) {
    const recordPath = await writePromotionRecord({
      cwd: input.cwd,
      promotionId,
      value: {
        schemaVersion: 1,
        status: 'validation_failed',
        fromSourceId: input.fromSource.id,
        toSourceId: input.toSource.id,
        branch,
        targetBranch,
        plan,
        applied: applied.applied,
        skipped: applied.skipped,
        validation,
      },
    })
    return {
      ok: false,
      action: 'validation_failed',
      promotionId,
      fromSourceId: input.fromSource.id,
      toSourceId: input.toSource.id,
      fromRoot,
      targetRoot,
      branch,
      targetBranch,
      plan,
      applied: applied.applied,
      skipped: applied.skipped,
      validation,
      recordPath,
      acceptedRefAdvanced: false,
    }
  }

  const commit = await commitMatOSGitAssetSource(input.cwd, input.toSource, {
    message:
      input.title?.trim() ||
      `MatOS promote assets from ${input.fromSource.id} to ${input.toSource.id}`,
    branch,
    push: true,
    token: input.token,
  })
  if (commit.action === 'noop') {
    const recordPath = await writePromotionRecord({
      cwd: input.cwd,
      promotionId,
      value: {
        schemaVersion: 1,
        status: 'no_changes',
        fromSourceId: input.fromSource.id,
        toSourceId: input.toSource.id,
        branch,
        targetBranch,
        plan,
        applied: applied.applied,
        skipped: applied.skipped,
        validation,
        commit,
      },
    })
    return {
      ok: true,
      action: 'no_changes',
      promotionId,
      fromSourceId: input.fromSource.id,
      toSourceId: input.toSource.id,
      fromRoot,
      targetRoot,
      branch,
      targetBranch,
      plan,
      applied: applied.applied,
      skipped: applied.skipped,
      validation,
      commit,
      recordPath,
      acceptedRefAdvanced: false,
    }
  }

  let statusWritten = false
  if (commit.commit && input.toSource.gitea?.owner && input.toSource.gitea?.repo) {
    await createMatOSGiteaCommitStatus({
      apiUrl: input.apiUrl,
      token: input.token,
      owner: input.toSource.gitea.owner,
      repo: input.toSource.gitea.repo,
      commit: commit.commit,
      state: 'success',
      context: 'matos/promotion-validate',
      description: 'MatOS public asset promotion validation passed',
    })
    statusWritten = true
  }

  const owner = input.pullRequestTarget?.owner ?? input.toSource.gitea?.owner
  const repo = input.pullRequestTarget?.repo ?? input.toSource.gitea?.repo
  if (!owner || !repo) {
    throw new Error(
      `MatOS Gitea promotion target source is missing repo metadata: ${input.toSource.id}`,
    )
  }
  const pullRequest = await createMatOSGiteaPullRequest({
    apiUrl: input.apiUrl,
    token: input.token,
    owner,
    repo,
    sourceBranch: input.pullRequestTarget?.sourceOwner
      ? `${input.pullRequestTarget.sourceOwner}:${branch}`
      : branch,
    targetBranch,
    title:
      input.title?.trim() ||
      `MatOS promotion: ${input.fromSource.id} -> ${input.toSource.id}`,
    body:
      input.body ??
      [
        `MatOS promotion id: ${promotionId}`,
        `From source: ${input.fromSource.id}`,
        `To source: ${input.toSource.id}`,
        `Validation: ${validation.ok ? 'passed' : 'failed'}`,
      ].join('\n'),
  })
  const recordPath = await writePromotionRecord({
    cwd: input.cwd,
    promotionId,
    value: {
      schemaVersion: 1,
      status: 'pr_created',
      fromSourceId: input.fromSource.id,
      toSourceId: input.toSource.id,
      branch,
      targetBranch,
      plan,
      applied: applied.applied,
      skipped: applied.skipped,
      validation,
      commit,
      pullRequest,
      statusWritten,
    },
  })
  return {
    ok: true,
    action: 'pr_created',
    promotionId,
    fromSourceId: input.fromSource.id,
    toSourceId: input.toSource.id,
    fromRoot,
    targetRoot,
    branch,
    targetBranch,
    plan,
    applied: applied.applied,
    skipped: applied.skipped,
    validation,
    commit,
    pullRequest,
    statusWritten,
    recordPath,
    acceptedRefAdvanced: false,
  }
  } finally {
    await Promise.all([
      repairMatOSGitAssetSourceCachePermissions(input.cwd, input.fromSource),
      repairMatOSGitAssetSourceCachePermissions(input.cwd, input.toSource),
    ])
  }
}

function publicGateSatisfied(gates: MatOSGiteaAssetPromotionApplyGates): boolean {
  return gates.reviewed && gates.benchmarkPassed && gates.judgePassed
}

export async function applyMatOSGiteaAssetPromotionReview(input: {
  cwd: string
  toSource: MatOSGitAssetSourceConfig
  apiUrl: string
  token?: string
  owner: string
  repo: string
  number: number
  mergeMethod?: 'merge' | 'squash' | 'rebase'
  channel?: string
  pushAcceptedRef?: boolean
  acceptedBy?: string
  gates: MatOSGiteaAssetPromotionApplyGates
  validateRoot: (root: string) => Promise<MatOSAssetValidationResult>
}): Promise<MatOSGiteaAssetPromotionApplyResult> {
  const promotionId = promotionApplyIdFor({
    toSourceId: input.toSource.id,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
  })
  if (!publicGateSatisfied(input.gates)) {
    const blocked = {
      ok: false,
      action: 'blocked_by_policy',
      toSourceId: input.toSource.id,
      gates: input.gates,
      acceptedRefAdvanced: false,
    } satisfies MatOSGiteaAssetPromotionApplyResult
    const recordPath = await writePromotionRecord({
      cwd: input.cwd,
      promotionId,
      value: {
        schemaVersion: 1,
        status: blocked.action,
        toSourceId: input.toSource.id,
        pullRequest: {
          owner: input.owner,
          repo: input.repo,
          number: input.number,
        },
        gates: input.gates,
      },
    })
    return { ...blocked, recordPath }
  }
  const pullRequest = await mergeMatOSGiteaPullRequest({
    apiUrl: input.apiUrl,
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    method: input.mergeMethod,
  })
  const pushAcceptedRef = input.pushAcceptedRef ?? true
  const acceptance = await acceptMatOSGiteaAssetSourceCommit({
    cwd: input.cwd,
    source: input.toSource,
    channel: input.channel ?? 'stable',
    push: pushAcceptedRef,
    token: input.token,
    acceptedBy: input.acceptedBy,
    validateRoot: input.validateRoot,
    giteaStatus: {
      apiUrl: input.apiUrl,
      owner: input.owner,
      repo: input.repo,
    },
  })
  const statusWritten: string[] = []
  if (acceptance.ok) {
    const contexts: Array<{ context: string; description: string }> = [
      {
        context: 'matos/review',
        description: 'MatOS public asset promotion review gate passed',
      },
      {
        context: 'matos/benchmark',
        description: 'MatOS public asset promotion benchmark gate passed',
      },
      {
        context: 'matos/judge',
        description: 'MatOS public asset promotion semantic judge gate passed',
      },
    ]
    for (const item of contexts) {
      await createMatOSGiteaCommitStatus({
        apiUrl: input.apiUrl,
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        commit: acceptance.commit,
        state: 'success',
        context: item.context,
        description: item.description,
      })
      statusWritten.push(item.context)
    }
  }
  const result: MatOSGiteaAssetPromotionApplyResult = {
    ok: acceptance.ok,
    action: acceptance.ok ? 'merged_accepted' : 'accept_failed',
    toSourceId: input.toSource.id,
    pullRequest,
    acceptance,
    gates: input.gates,
    ...(statusWritten.length > 0 ? { statusWritten } : {}),
    acceptedRefAdvanced:
      acceptance.ok && (!pushAcceptedRef || acceptance.pushed === true),
  }
  const recordPath = await writePromotionRecord({
    cwd: input.cwd,
    promotionId,
    value: {
      schemaVersion: 1,
      status: result.action,
      toSourceId: input.toSource.id,
      pullRequest,
      acceptance,
      gates: input.gates,
      statusWritten,
    },
  })
  return {
    ...result,
    recordPath,
  }
}
