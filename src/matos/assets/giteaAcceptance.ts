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
import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  getMatOSBundledAssetHostRoot,
  getMatOSDefaultAssetRoots,
  getMatOSDir,
  readMatOSProjectConfig,
  writeMatOSProjectConfig,
  type MatOSAssetSourceConfig,
  type MatOSGitAssetSourceConfig,
  type MatOSGitAssetSourceRuntimeRef,
} from '../project.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { parseWorkflowDefinition } from '../workflows/schema.js'
import { validateWorkflowDefinition } from '../workflows/validateWorkflow.js'
import type { MatOSAssetValidationResult } from './types.js'
import { createMatOSGiteaCommitStatus } from './giteaClient.js'
import { loadMatOSAssets } from './loadAssets.js'
import { validateMatOSAssets } from './validateAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import {
  materializeMatOSAssetSource,
  materializeAcceptedRuntimeSnapshot,
  matOSGitAssetSourceCheckoutRoot,
  repairMatOSGitAssetSourceCachePermissions,
  syncMatOSGitAssetSourceOriginRemote,
  withMatOSGitAssetSourceLock,
} from './sourceAdapters.js'
import { matOSGitCheckoutProcessEnv } from './gitProcessEnv.js'
import { bestEffort } from '../support/bestEffort.js'

const execFileAsync = promisify(execFile)

import { archiveMatOSAcceptedCandidate, markMatOSArchiveAccepted, type MatOSArchiveAudit } from './history/acceptedArchive.js'

export const MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV =
  'MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION'

export type MatOSGiteaAcceptanceWorkflowFailure = {
  ref: string
  errors: string[]
}

export type MatOSGiteaAcceptanceWorkflowValidation = {
  validated: number
  failures: MatOSGiteaAcceptanceWorkflowFailure[]
  /** True when failing workflows were accepted anyway via the operator env override. */
  skippedByEnv?: boolean
}

export type MatOSGiteaAssetAcceptanceResult = {
  ok: boolean
  sourceId: string
  acceptedBranch: string
  commit: string
  runtimeRef: MatOSGitAssetSourceRuntimeRef
  materializedRoot: string
  validation: MatOSAssetValidationResult
  workflowValidation?: MatOSGiteaAcceptanceWorkflowValidation
  pushed: boolean
  previousAcceptedCommit?: string
  statusWritten?: boolean
  candidatePreparation?: {
    changed: boolean
    summary?: string
  }
}

function safeAcceptedSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'source'
  )
}

export function matOSAcceptedBranchForSource(input: {
  sourceId: string
  channel?: string
}): string {
  return `accepted/${safeAcceptedSegment(input.sourceId)}/${safeAcceptedSegment(
    input.channel ?? 'stable',
  )}`
}

export function matOSGitBranchName(ref: string): string {
  const branch = ref.trim().replace(/^refs\/heads\//, '')
  if (!branch || branch.startsWith('-') || branch.startsWith('refs/') ||
    /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch) || branch.includes('..') ||
    branch.includes('@{') || branch.endsWith('.') ||
    branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Invalid MatOS Git branch name')
  }
  return branch
}

async function gitSafeDirectoryArgs(cwd: string): Promise<string[]> {
  const directories = [resolve(cwd)]
  const realDirectory = await realpath(cwd).catch(() => undefined)
  if (realDirectory && realDirectory !== directories[0]) {
    directories.push(realDirectory)
  }
  return directories.flatMap(directory => ['-c', `safe.directory=${directory}`])
}

async function git(
  cwd: string,
  args: string[],
  token?: string,
): Promise<string> {
  const result = await execFileAsync(
    'git',
    [...(await gitSafeDirectoryArgs(cwd)), ...args],
    {
      cwd,
      env: await matOSGitCheckoutProcessEnv(cwd, token, await gitSafeDirectoryArgs(cwd)),
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  return String(result.stdout ?? '').trim()
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

function assertAcceptedRefCommit(value: string | null | undefined): void {
  if (value !== null && value !== undefined && !/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`Invalid MatOS Gitea accepted-ref commit: ${value}`)
  }
}

export async function readMatOSGiteaRemoteRefCommit(input: {
  checkoutRoot: string
  ref: string
  token?: string
}): Promise<string | undefined> {
  const remoteRef = `refs/heads/${matOSGitBranchName(input.ref)}`
  const output = await git(
    input.checkoutRoot,
    ['ls-remote', '--refs', 'origin', remoteRef],
    input.token,
  )
  const match = output
    .split('\n')
    .map(line => line.trim().split(/\s+/, 2))
    .find(([, ref]) => ref === remoteRef)
  const commit = match?.[0]
  if (!commit) return undefined
  assertAcceptedRefCommit(commit)
  return commit
}

/** Compare-and-swap one accepted branch without fetching unrelated refs. */
export async function updateMatOSGiteaAcceptedRefWithLease(input: {
  checkoutRoot: string
  acceptedBranch: string
  targetCommit: string
  expectedRemoteCommit: string | null
  token?: string
  onPushed?: () => void | Promise<void>
}): Promise<void> {
  assertAcceptedRefCommit(input.targetCommit)
  assertAcceptedRefCommit(input.expectedRemoteCommit)
  const remoteRef = `refs/heads/${matOSGitBranchName(input.acceptedBranch)}`
  const expected = input.expectedRemoteCommit ?? ''
  const retainedCommits = [...new Set([input.targetCommit, input.expectedRemoteCommit].filter((value): value is string => Boolean(value)))]
  await git(
    input.checkoutRoot,
    [
      'push',
      '--atomic',
      'origin',
      `--force-with-lease=${remoteRef}:${expected}`,
      `${input.targetCommit}:${remoteRef}`,
      ...retainedCommits.map(commit => `${commit}:refs/tags/matos-accepted/${matOSGitBranchName(input.acceptedBranch)}/${commit}`),
    ],
    input.token,
  )
  // Publish the rollback lease before readback/local metadata work can fail.
  await input.onPushed?.()
  const current = await readMatOSGiteaRemoteRefCommit({
    checkoutRoot: input.checkoutRoot,
    ref: input.acceptedBranch,
    ...(input.token ? { token: input.token } : {}),
  })
  if (current !== input.targetCommit) {
    throw new Error(
      `MatOS Gitea accepted-ref verification failed for ${input.acceptedBranch}: expected ${input.targetCommit}, got ${current ?? '(missing)'}`,
    )
  }
}

function gitErrorText(error: unknown): string {
  const parts = [
    error instanceof Error ? error.message : String(error),
    typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : undefined,
    typeof (error as { stderr?: unknown })?.stderr === 'string'
      ? (error as { stderr: string }).stderr
      : undefined,
  ]
  return parts.filter(Boolean).join('\n')
}

function gitCheckoutErrorIsRecoverable(error: unknown): boolean {
  const text = gitErrorText(error).toLowerCase()
  return (
    text.includes('unable to write new index file') ||
    (text.includes('unable to create') && text.includes('.git/index.lock')) ||
    text.includes('could not lock index') ||
    text.includes('index.lock') ||
    text.includes('permission denied') ||
    text.includes('operation not permitted')
  )
}

async function removeManagedGitIndexLock(checkoutRoot: string): Promise<void> {
  await rm(join(checkoutRoot, '.git', 'index.lock'), { force: true }).catch(
    error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') {
        return
      }
      throw error
    },
  )
}

async function checkoutAcceptedCandidateWithRepair(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  checkoutRoot: string
  commit: string
  token?: string
}): Promise<void> {
  try {
    await git(
      input.checkoutRoot,
      ['checkout', '--force', '--detach', input.commit],
      input.token,
    )
    return
  } catch (error) {
    if (!gitCheckoutErrorIsRecoverable(error)) {
      throw error
    }
    await removeManagedGitIndexLock(input.checkoutRoot)
    await repairMatOSGitAssetSourceCachePermissions(input.cwd, input.source).catch(
      () => undefined,
    )
    await sleep(250)
    await removeManagedGitIndexLock(input.checkoutRoot)
    await git(
      input.checkoutRoot,
      ['checkout', '--force', '--detach', input.commit],
      input.token,
    )
  }
}

async function resolveCommitOnce(input: {
  checkoutRoot: string
  ref: string
  token?: string
}): Promise<string | undefined> {
  const candidates = [
    `origin/${input.ref}`,
    `refs/remotes/origin/${input.ref}`,
    input.ref,
    `refs/tags/${input.ref}`,
  ]
  for (const candidate of candidates) {
    const commit = await gitMaybe(
      input.checkoutRoot,
      ['rev-parse', '--verify', `${candidate}^{commit}`],
      input.token,
    )
    if (commit) {
      return commit
    }
  }
  return undefined
}

function fetchableBranchName(ref: string): string | undefined {
  const branch = ref
    .trim()
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
  if (!branch || branch.includes('..') || branch.includes('@{')) {
    return undefined
  }
  return branch
}

async function fetchOriginBranch(input: {
  checkoutRoot: string
  branch: string
  token?: string
}): Promise<void> {
  await gitMaybe(
    input.checkoutRoot,
    [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
    ],
    input.token,
  )
}

function fullCommitSha(ref: string): string | undefined {
  const value = ref.trim()
  return /^[0-9a-f]{40}$/i.test(value) ? value : undefined
}

async function fetchOriginCommit(input: {
  checkoutRoot: string
  commit: string
  token?: string
}): Promise<void> {
  await gitMaybe(
    input.checkoutRoot,
    ['fetch', '--no-tags', 'origin', input.commit],
    input.token,
  )
}

async function resolveCommit(input: {
  checkoutRoot: string
  ref: string
  token?: string
}): Promise<string> {
  // An origin/-prefixed ref means "the current remote state", for example
  // adopting an accepted branch advanced by another execution surface
  // (container self-evolution acceptance vs host gateway provisioning). The
  // local remote-tracking ref can be stale or missing entirely because
  // materialization only fetches the candidate source ref, so refresh it
  // before resolving; failures fall back to the local resolution below.
  const explicitRemoteBranch = input.ref.trim().startsWith('origin/')
    ? fetchableBranchName(input.ref)
    : undefined
  if (explicitRemoteBranch) {
    await fetchOriginBranch({
      checkoutRoot: input.checkoutRoot,
      branch: explicitRemoteBranch,
      ...(input.token ? { token: input.token } : {}),
    })
  }
  const resolved = await resolveCommitOnce(input)
  if (resolved) {
    return resolved
  }
  // `--ref <commit>` is part of the public CLI contract. A materialized
  // checkout intentionally fetches only its configured/accepted refs, so a
  // newly pushed candidate commit can be reachable on the remote while its
  // object is still absent locally. Fetch the exact reachable object before
  // declaring a full SHA missing.
  const explicitCommit = fullCommitSha(input.ref)
  if (explicitCommit) {
    await fetchOriginCommit({
      checkoutRoot: input.checkoutRoot,
      commit: explicitCommit,
      ...(input.token ? { token: input.token } : {}),
    })
    const fetched = await resolveCommitOnce(input)
    if (fetched) {
      return fetched
    }
  }
  const branch = explicitRemoteBranch ? undefined : fetchableBranchName(input.ref)
  if (branch) {
    await fetchOriginBranch({
      checkoutRoot: input.checkoutRoot,
      branch,
      ...(input.token ? { token: input.token } : {}),
    })
    const fetched = await resolveCommitOnce(input)
    if (fetched) {
      return fetched
    }
  }
  throw new Error(`MatOS Gitea asset acceptance ref not found: ${input.ref}`)
}

function statusTargetUrl(input: {
  baseUrl?: string
  owner: string
  repo: string
  commit: string
  explicit?: string
}): string | undefined {
  if (input.explicit?.trim()) {
    return input.explicit.trim()
  }
  if (!input.baseUrl?.trim()) {
    return undefined
  }
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(input.owner)}/${encodeURIComponent(
    input.repo,
  )}/src/commit/${encodeURIComponent(input.commit)}`
}

async function tryWriteMatOSGiteaCommitStatus(input: Parameters<typeof createMatOSGiteaCommitStatus>[0]): Promise<boolean> {
  try {
    await createMatOSGiteaCommitStatus(input)
    return true
  } catch {
    return false
  }
}

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function acceptanceSkipsWorkflowValidation(): boolean {
  return process.env[MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV] === '1'
}

/**
 * Already-materialized roots of the OTHER configured asset sources, used only
 * as reference-resolution context for candidate workflow validation (for
 * example a scoped user workflow whose agent node references a core role).
 *
 * This deliberately does not materialize anything: acceptance runs inside the
 * candidate source's lock, and materializing sibling sources here would take
 * their locks while holding ours (deadlock pattern). Callers such as the CLI
 * accept command and direct-editor acceptance materialize dependency sources
 * before calling acceptance, so the checkouts normally already exist.
 */
async function existingSiblingAssetSourceRoots(input: {
  cwd: string
  excludeSourceId: string
}): Promise<string[]> {
  const config = await readMatOSProjectConfig(input.cwd).catch(() => undefined)
  const roots: string[] = []
  for (const source of (config?.assetSources ?? []) as MatOSAssetSourceConfig[]) {
    if (source.id === input.excludeSourceId || source.includeInRuntime === false) {
      continue
    }
    const baseRoot =
      source.type === 'local'
        ? isAbsolute(source.path)
          ? source.path
          : resolve(getMatOSDir(input.cwd), source.path)
        : matOSGitAssetSourceCheckoutRoot(input.cwd, source)
    const root =
      source.type === 'git' && source.subdir
        ? resolve(baseRoot, source.subdir)
        : resolve(baseRoot)
    const rootStat = await stat(root).catch(() => undefined)
    if (rootStat?.isDirectory()) {
      roots.push(root)
    }
  }
  return [...new Set(roots)]
}

/** Validate consumers together with the replacement, before publishing the
 * accepted ref. Validating only the candidate misses incoming dependency edges.
 * Do not use sibling materialization under this source's writer lock.
 */
async function validateAcceptedReplacement(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  root: string
  dependencySourceRoots?: Record<string, string>
}): Promise<MatOSAssetValidationResult> {
  const config = await readMatOSProjectConfig(input.cwd, { strict: true })
  const siblings = input.dependencySourceRoots ? Object.values(input.dependencySourceRoots)
    : await existingSiblingAssetSourceRoots({ cwd: input.cwd, excludeSourceId: input.source.id })
  const checkout = matOSGitAssetSourceCheckoutRoot(input.cwd, input.source)
  const roots = [...new Set([
    input.root, ...siblings,
    ...config.assetRoots.map(root => isAbsolute(root) ? root : resolve(getMatOSDir(input.cwd), root))
      .filter(root => !pathIsWithin(checkout, root)),
  ])]
  const temp = await mkdtempInMatOSTmp({ cwd: input.cwd, prefix: 'accepted-closure-' })
  try {
    // Preserve source scope/overlay precedence when loading combined roots.
    // A flat path-only load misclassifies scoped overlays as duplicate assets.
    const scopedRoots = (config.assetSources ?? []).flatMap(source => {
      if (source.includeInRuntime === false) return []
      const base = source.type === 'git' ? matOSGitAssetSourceCheckoutRoot(input.cwd, source)
        : isAbsolute(source.path) ? source.path : resolve(getMatOSDir(input.cwd), source.path)
      const path = source.id === input.source.id ? input.root
        : input.dependencySourceRoots?.[source.id] ?? (
          source.type === 'git' && source.subdir ? resolve(base, source.subdir) : base)
      return roots.includes(path) ? [{ type: 'local' as const, id: source.id, path, scope: source.scope, scopeRef: source.scopeRef }] : []
    })
    await writeMatOSProjectConfig(temp, {
      version: 1, includeDefaultAssetRoots: false,
      assetRoots: roots.filter(root => !scopedRoots.some(source => source.path === root)),
      assetSources: scopedRoots,
    })
    return validateMatOSAssets(await loadMatOSAssets(temp), { requireToolMounts: true })
  } finally { await rm(temp, { recursive: true, force: true }) }
}

/**
 * Asset-aware workflow validation for one candidate asset tree.
 *
 * Runs the same validation the bundled-workflow schema test uses: every
 * workflow asset in the candidate tree is parsed and passed through
 * `validateWorkflowDefinition` with an asset-aware resolver over the
 * candidate tree plus the provided extra roots (sibling sources) and builtin
 * runtime assets. Shallow asset validation cannot see workflow definitions,
 * which is how an invalid loop node (template maxIterations) once became
 * accepted runtime truth for three days.
 */
// Roots the runtime loads for this project besides its asset sources: the
// installed bundle (standalone), the default roots and the configured asset
// roots. Workflows may reference those assets (role:compute, bundled workflows).
async function runtimeBaseAssetRoots(cwd: string): Promise<string[]> {
  const config = await readMatOSProjectConfig(cwd).catch(() => undefined)
  if (!config) {
    return []
  }
  const bundledRoot = config.standalone ? getMatOSBundledAssetHostRoot() : undefined
  const roots = [
    ...(config.includeDefaultAssetRoots !== false ? getMatOSDefaultAssetRoots() : []),
    ...(config.assetRoots ?? []).map(root =>
      isAbsolute(root) ? root : resolve(getMatOSDir(cwd), root),
    ),
    ...(bundledRoot ? [bundledRoot] : []),
  ]
  const existing: string[] = []
  for (const root of roots) {
    if ((await stat(root).catch(() => undefined))?.isDirectory()) {
      existing.push(resolve(root))
    }
  }
  return [...new Set(existing)]
}

export async function validateMatOSWorkflowAssetsForAcceptance(input: {
  cwd: string
  root: string
  extraAssetRoots?: string[]
}): Promise<{ validated: number; failures: MatOSGiteaAcceptanceWorkflowFailure[] }> {
  const tempCwd = await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: 'asset-accept-workflow-validate-',
  })
  try {
    const assetRoots = [
      resolve(input.root),
      ...[...(input.extraAssetRoots ?? []), ...(await runtimeBaseAssetRoots(input.cwd))]
        .map(root => resolve(root))
        .filter(root => root !== resolve(input.root)),
    ]
    await writeMatOSProjectConfig(tempCwd, {
      version: 1,
      assetRoots,
      includeDefaultAssetRoots: false,
    })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(tempCwd), {
      includeDisabled: true,
    })
    const workflows = registry.assets
      .filter(
        asset =>
          asset.type === 'workflow' &&
          asset.entryAbsolutePath &&
          asset.canonicalKey &&
          pathIsWithin(input.root, asset.entryAbsolutePath),
      )
      .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey))

    const failures: MatOSGiteaAcceptanceWorkflowFailure[] = []
    let validated = 0
    for (const workflow of workflows) {
      validated += 1
      try {
        const definition = parseWorkflowDefinition(
          await readFile(workflow.entryAbsolutePath as string, 'utf8'),
          { sourcePath: workflow.entryAbsolutePath as string },
        )
        const validation = validateWorkflowDefinition(definition, {
          assetResolver: reference => registry.resolve(reference),
        })
        if (!validation.ok) {
          failures.push({
            ref: workflow.canonicalKey,
            errors: validation.errors.map(
              error => `${error.path ?? error.nodeId ?? 'workflow'}: ${error.message}`,
            ),
          })
        }
      } catch (error) {
        failures.push({
          ref: workflow.canonicalKey,
          errors: [error instanceof Error ? error.message : String(error)],
        })
      }
    }
    return { validated, failures }
  } finally {
    await rm(tempCwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

function formatWorkflowFailures(
  failures: MatOSGiteaAcceptanceWorkflowFailure[],
  options: { maxWorkflows?: number; maxErrors?: number } = {},
): string {
  const maxWorkflows = options.maxWorkflows ?? 10
  const maxErrors = options.maxErrors ?? 5
  const lines = failures.slice(0, maxWorkflows).map(failure => {
    const errors = failure.errors.slice(0, maxErrors).join('; ')
    const more =
      failure.errors.length > maxErrors
        ? ` (+${failure.errors.length - maxErrors} more errors)`
        : ''
    return `  ${failure.ref}: ${errors}${more}`
  })
  if (failures.length > maxWorkflows) {
    lines.push(`  ... and ${failures.length - maxWorkflows} more failing workflow(s)`)
  }
  return lines.join('\n')
}

export async function acceptMatOSGiteaAssetSourceCommit(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  ref?: string
  channel?: string
  push?: boolean
  token?: string
  acceptedBy?: string
  /**
   * Give callers one last, validated chance to migrate a candidate checkout
   * before it becomes an accepted runtime ref. The callback must only edit
   * files inside `root`; changed files are committed to the accepted branch
   * as part of the same atomic acceptance transaction.
   */
  prepareCandidate?: (
    root: string,
  ) => Promise<{ changed: boolean; summary?: string } | void>
  dependencySourceRoots?: Record<string, string>
  archiveAudit?: MatOSArchiveAudit
  onAcceptedRefPushed?: (pushed: { commit: string; acceptedBranch: string; previousAcceptedCommit?: string }) => void | Promise<void>
  validateRoot: (root: string) => Promise<MatOSAssetValidationResult>
  giteaStatus?: {
    apiUrl: string
    owner: string
    repo: string
    baseUrl?: string
    targetUrl?: string
  }
}): Promise<MatOSGiteaAssetAcceptanceResult> {
  const acceptedBranch = !input.channel && input.source.runtimeRef?.mode === 'accepted-ref'
    ? matOSGitBranchName(input.source.runtimeRef.ref)
    : matOSAcceptedBranchForSource({
    sourceId: input.source.id,
    channel: input.channel ?? 'stable',
  })
  const sourceForCandidate: MatOSGitAssetSourceConfig = {
    ...input.source,
    runtimeRef: { mode: 'source-ref' },
  }
  // Serialize the whole acceptance transaction (candidate checkout, validate,
  // accepted-ref push, local branch update) against concurrent materialization
  // and commit flows on the same checkout. The inner materialize call re-enters
  // the same reentrant source lock instead of deadlocking.
  return withMatOSGitAssetSourceLock(input.cwd, input.source, async () => {
  try {
    await materializeMatOSAssetSource(input.cwd, sourceForCandidate, {
      refresh: 'always',
      token: input.token,
      forceResetDirty: true,
    })
    const checkoutRoot = matOSGitAssetSourceCheckoutRoot(input.cwd, input.source)
    // The checkout may have been prepared from a different execution surface
    // (container alias vs host loopback). Re-align origin with the runtime
    // transport for this process before fetch/push so host-side acceptance
    // does not fail on container-only hosts such as `matos-gitea`.
    await bestEffort('gitea-acceptance-origin-sync', () =>
      syncMatOSGitAssetSourceOriginRemote({
        cwd: input.cwd,
        source: input.source,
        checkoutRoot,
        ...(input.token ? { token: input.token } : {}),
      }),
    )
    let commit = await resolveCommit({
      checkoutRoot,
      ref: input.ref?.trim() || input.source.ref?.trim() || 'HEAD',
      token: input.token,
    })
    await checkoutAcceptedCandidateWithRepair({
      cwd: input.cwd,
      source: input.source,
      checkoutRoot,
      commit,
      ...(input.token ? { token: input.token } : {}),
    })
    const materializedRoot = input.source.subdir
      ? resolve(checkoutRoot, input.source.subdir)
      : checkoutRoot
    const candidatePreparation = await input.prepareCandidate?.(materializedRoot)
    if (candidatePreparation && typeof candidatePreparation === 'object' && candidatePreparation.changed) {
      const dirty = await git(
        checkoutRoot,
        ['status', '--porcelain=v1', '--untracked-files=no'],
        input.token,
      )
      if (dirty.trim()) {
        await git(checkoutRoot, ['add', '--update'], input.token)
        await git(
          checkoutRoot,
          [
            '-c',
            'user.name=MatOS Asset Migration',
            '-c',
            'user.email=matos-asset-migration@localhost',
            'commit',
            '-m',
            candidatePreparation.summary?.trim() ||
              'Repair stale MatOS asset dependencies',
          ],
          input.token,
        )
        commit = await git(checkoutRoot, ['rev-parse', 'HEAD'], input.token)
      }
    }
    const candidateValidation = await input.validateRoot(materializedRoot)
    const closureValidation = candidateValidation.ok
      ? await validateAcceptedReplacement({ cwd: input.cwd, source: input.source, root: materializedRoot, dependencySourceRoots: input.dependencySourceRoots })
      : candidateValidation
    let validation = closureValidation
    if (validation.ok) {
      try {
        // A candidate must be exportable by the same reader used in user
        // sessions, not merely loadable from its mutable authoring checkout.
        await materializeAcceptedRuntimeSnapshot(input.cwd, {
          ...input.source, runtimeRef: { mode: 'commit', commit },
        }, false, input.token)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/symlink|symbolic link|submodule|subdir escapes|snapshot root is not a directory/.test(message)) throw error
        validation = { ok: false, errors: [{ code: 'invalid_manifest', manifestPath: materializedRoot, message }] }
      }
    }
    const runtimeRef: MatOSGitAssetSourceRuntimeRef = {
      mode: 'accepted-ref',
      ref: acceptedBranch,
      commit,
      acceptedAt: new Date().toISOString(),
      ...(input.acceptedBy?.trim() ? { acceptedBy: input.acceptedBy.trim() } : {}),
    }

    let statusWritten = false
    if (!validation.ok) {
      if (input.giteaStatus) {
        statusWritten = await tryWriteMatOSGiteaCommitStatus({
          apiUrl: input.giteaStatus.apiUrl,
          token: input.token,
          owner: input.giteaStatus.owner,
          repo: input.giteaStatus.repo,
          commit,
          state: 'failure',
          context: 'matos/validate',
          description: 'MatOS asset validation failed',
          targetUrl: statusTargetUrl({
            baseUrl: input.giteaStatus.baseUrl,
            owner: input.giteaStatus.owner,
            repo: input.giteaStatus.repo,
            commit,
            explicit: input.giteaStatus.targetUrl,
          }),
        })
      }
      return {
        ok: false,
        sourceId: input.source.id,
        acceptedBranch,
        commit,
        runtimeRef,
        materializedRoot,
        validation,
        pushed: false,
        ...(candidatePreparation
          ? { candidatePreparation }
          : {}),
        ...(statusWritten ? { statusWritten } : {}),
      }
    }

    // Workflow acceptance gate: shallow asset validation above cannot see
    // inside workflow definitions, so an invalid workflow (for example a loop
    // node with a template maxIterations that the loop adapter cannot
    // resolve) would otherwise become accepted runtime truth. Refuse the
    // acceptance unless the explicit emergency operator override env is set.
    const skipWorkflowRefusal = acceptanceSkipsWorkflowValidation()
    let workflowValidation: MatOSGiteaAcceptanceWorkflowValidation
    try {
      const extraAssetRoots = input.dependencySourceRoots ? Object.values(input.dependencySourceRoots) : await existingSiblingAssetSourceRoots({
        cwd: input.cwd,
        excludeSourceId: input.source.id,
      })
      workflowValidation = await validateMatOSWorkflowAssetsForAcceptance({
        cwd: input.cwd,
        root: materializedRoot,
        extraAssetRoots,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!skipWorkflowRefusal) {
        throw new Error(
          `MatOS Gitea asset acceptance refused for source ${input.source.id} (candidate ${commit}): workflow asset validation could not run: ${message}. Set ${MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV}=1 only for emergency operator override.`,
        )
      }
      process.stderr.write(
        `[matos-assets-accept] WARNING: ${MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV}=1 set; workflow asset validation could not run for source ${input.source.id} candidate ${commit} (${message}). Accepting without the workflow gate — emergency operator override only.\n`,
      )
      workflowValidation = { validated: 0, failures: [], skippedByEnv: true }
    }
    if (workflowValidation.failures.length > 0) {
      if (!skipWorkflowRefusal) {
        if (input.giteaStatus) {
          await tryWriteMatOSGiteaCommitStatus({
            apiUrl: input.giteaStatus.apiUrl,
            token: input.token,
            owner: input.giteaStatus.owner,
            repo: input.giteaStatus.repo,
            commit,
            state: 'failure',
            context: 'matos/validate',
            description: 'MatOS workflow asset validation failed',
            targetUrl: statusTargetUrl({
              baseUrl: input.giteaStatus.baseUrl,
              owner: input.giteaStatus.owner,
              repo: input.giteaStatus.repo,
              commit,
              explicit: input.giteaStatus.targetUrl,
            }),
          })
        }
        throw new Error(
          `MatOS Gitea asset acceptance refused for source ${input.source.id} (candidate ${
            input.ref?.trim() || input.source.ref?.trim() || 'HEAD'
          } -> ${commit}): ${workflowValidation.failures.length} workflow asset(s) failed asset-aware validation:\n${formatWorkflowFailures(
            workflowValidation.failures,
          )}\nFix the workflow assets, or set ${MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV}=1 for an emergency operator override (logged, not recommended).`,
        )
      }
      workflowValidation.skippedByEnv = true
      process.stderr.write(
        `[matos-assets-accept] WARNING: ${MATOS_ASSETS_ACCEPT_SKIP_WORKFLOW_VALIDATION_ENV}=1 set; accepting source ${input.source.id} candidate ${commit} DESPITE ${workflowValidation.failures.length} failing workflow asset(s):\n${formatWorkflowFailures(
          workflowValidation.failures,
        )}\nThe accepted runtime ref will advance with invalid workflow assets — emergency operator override only.\n`,
      )
    }

    const archive = await archiveMatOSAcceptedCandidate({
      cwd: input.cwd, source: input.source, root: materializedRoot, commit, acceptedBranch, audit: input.archiveAudit,
    })
    let previousAcceptedCommit: string | undefined
    if (input.push) {
      previousAcceptedCommit = await readMatOSGiteaRemoteRefCommit({
        checkoutRoot,
        ref: acceptedBranch,
        ...(input.token ? { token: input.token } : {}),
      })
      if (previousAcceptedCommit && previousAcceptedCommit !== commit) {
        // The remote accepted branch may have been advanced by another
        // execution surface, so the local checkout can lack the commit
        // object entirely. Without fetching it first, merge-base fails with
        // "Not a valid commit name" and a genuinely fast-forward candidate is
        // misreported as divergent.
        const previousAcceptedIsLocal = await gitMaybe(
          checkoutRoot,
          ['cat-file', '-e', `${previousAcceptedCommit}^{commit}`],
          input.token,
        )
        if (previousAcceptedIsLocal === undefined) {
          await fetchOriginBranch({
            checkoutRoot,
            branch: acceptedBranch,
            ...(input.token ? { token: input.token } : {}),
          })
        }
        const advancesCurrentAcceptedCommit = await git(
          checkoutRoot,
          ['merge-base', '--is-ancestor', previousAcceptedCommit, commit],
          input.token,
        ).then(
          () => true,
          () => false,
        )
        if (!advancesCurrentAcceptedCommit) {
          throw new Error(
            `Refusing non-fast-forward accepted ref update for refs/heads/${acceptedBranch}: candidate ${commit} does not contain current remote accepted commit ${previousAcceptedCommit}`,
          )
        }
      }
      await updateMatOSGiteaAcceptedRefWithLease({
        checkoutRoot,
        acceptedBranch,
        targetCommit: commit,
        expectedRemoteCommit: previousAcceptedCommit ?? null,
        ...(input.token ? { token: input.token } : {}),
        onPushed: async () => {
          await input.onAcceptedRefPushed?.({ commit, previousAcceptedCommit, acceptedBranch })
          await markMatOSArchiveAccepted(input.cwd, archive, true)
        },
      })
    }
    await git(checkoutRoot, ['branch', '-f', acceptedBranch, commit], input.token)
    if (!input.push) await markMatOSArchiveAccepted(input.cwd, archive, false)
    if (input.giteaStatus) {
      statusWritten = await tryWriteMatOSGiteaCommitStatus({
        apiUrl: input.giteaStatus.apiUrl,
        token: input.token,
        owner: input.giteaStatus.owner,
        repo: input.giteaStatus.repo,
        commit,
        state: 'success',
        context: 'matos/validate',
        description: 'MatOS asset validation passed',
        targetUrl: statusTargetUrl({
          baseUrl: input.giteaStatus.baseUrl,
          owner: input.giteaStatus.owner,
          repo: input.giteaStatus.repo,
          commit,
          explicit: input.giteaStatus.targetUrl,
        }),
      })
    }

    return {
      ok: true,
      sourceId: input.source.id,
      acceptedBranch,
      commit,
      runtimeRef,
      materializedRoot,
      validation,
      workflowValidation,
      pushed: input.push === true,
      ...(candidatePreparation
        ? { candidatePreparation }
        : {}),
      ...(previousAcceptedCommit ? { previousAcceptedCommit } : {}),
      ...(statusWritten ? { statusWritten } : {}),
    }
  } finally {
    await repairMatOSGitAssetSourceCachePermissions(input.cwd, input.source, {
      full: false,
    })
  }
  })
}
