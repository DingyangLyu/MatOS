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
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  acceptMatOSGiteaAssetSourceCommit,
  matOSGitBranchName,
  updateMatOSGiteaAcceptedRefWithLease,
  type MatOSGiteaAssetAcceptanceResult,
} from '../assets/giteaAcceptance.js'
import { createMatOSGiteaCommitStatus } from '../assets/giteaClient.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry, type MatOSAssetRegistry } from '../assets/registry.js'
import {
  commitMatOSGitAssetSource,
  materializeMatOSAssetSource,
  matOSGitAssetSourceCheckoutRoot,
  repairMatOSGitAssetSourceCachePermissions,
  syncMatOSGitAssetSourceOriginRemote,
  resolveMatOSAssetSourceRootProvenance,
  type MatOSGitAssetSourceCommitResult,
} from '../assets/sourceAdapters.js'
import { matOSGitCheckoutProcessEnv } from '../assets/gitProcessEnv.js'
import { MATOS_GITEA_TOKEN_KEYS, matOSGiteaEnvValueWithProcessFallback } from '../assets/giteaOperatorEnv.js'
import { matOSGiteaFileSourceRepoForSource } from '../assets/giteaRuntimeTransport.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import type { MatOSAssetValidationError, MatOSAssetValidationResult } from '../assets/types.js'
import {
  type MatOSAssetSourceConfig,
  type MatOSGitAssetSourceConfig,
  type MatOSProjectConfig,
  readMatOSProjectConfig,
  writeMatOSProjectConfig,
} from '../project.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  coreEditableRoot,
  pathExists,
  replaceDirectoryContents,
} from './directAssetEditorFilesystem.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'
import type {
  MatOSDirectAssetEditorOutput,
  MatOSDirectAssetEditorSourceAcceptance,
  MatOSDirectAssetEditorSourceCommitError,
} from './directAssetEditor.js'
import type { MatOSDirectAssetEditorPromptInput } from './directAssetEditor.js'
import type { MatOSSemanticAcceptanceResult } from './semanticAcceptanceJudge.js'
import type { MatOSDirectAssetEditorAcceptanceEvidence } from './evolutionTargetGovernance.js'
import type { MatOSAssetHistoryValidationResult } from '../assets/history/index.js'

const execFileAsync = promisify(execFile)

function directEditorGiteaFirstEnv(
  env: Record<string, string | undefined> | undefined,
  keys: string[],
): string | undefined {
  return matOSGiteaEnvValueWithProcessFallback(keys, env)
}

function directEditorEnvFlag(
  env: Record<string, string | undefined> | undefined,
  keys: string[],
  defaultValue = false,
): boolean {
  for (const key of keys) {
    const value = env?.[key] ?? process.env[key]
    if (value === undefined) {
      continue
    }
    const normalized = value.trim().toLowerCase()
    return (
      normalized === '1' ||
      normalized === 'true' ||
      normalized === 'on' ||
      normalized === 'yes'
    )
  }
  return defaultValue
}

function directEditorAssetSourceScope(
  source: MatOSAssetSourceConfig,
): NonNullable<MatOSAssetSourceConfig['scope']> {
  return source.scope ?? 'project'
}

function directEditorGitAssetSourceIsCore(
  source: MatOSGitAssetSourceConfig,
): boolean {
  return (
    directEditorAssetSourceScope(source) === 'core' ||
    source.id === 'matos-core-assets' ||
    source.gitea?.owner === 'matos-core'
  )
}

export function directEditorAssetSourceMatchesRunScope(input: {
  source: MatOSGitAssetSourceConfig
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
}): boolean {
  if (input.scope === 'core') {
    return directEditorGitAssetSourceIsCore(input.source)
  }
  const sourceScope = directEditorAssetSourceScope(input.source)
  if (sourceScope !== input.scope) {
    return false
  }
  if (
    input.scope === 'user' ||
    input.scope === 'team' ||
    input.scope === 'project'
  ) {
    return Boolean(input.scopeRef && input.source.scopeRef === input.scopeRef)
  }
  return false
}

function directEditorSourceCommitMessage(input: {
  runId: string
  summary: string
}): string {
  const summary = input.summary.replace(/\s+/g, ' ').trim()
  const suffix = summary ? `: ${summary}` : ''
  return `MatOS evolution ${input.runId}${suffix}`.slice(0, 240)
}

function directEditorSourceEditBranch(runId: string): string {
  return `evolution/${runId}`
}

export type MatOSDirectEditorGiteaAuditInput = {
  schemaVersion: 1
  runId: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  summary: string
  status: string
  promptInput?: Pick<
    MatOSDirectAssetEditorPromptInput,
    'targetContract' | 'currentEvolutionContext'
  >
  editorOutput: Pick<
    MatOSDirectAssetEditorOutput,
    | 'summary'
    | 'targetDecision'
    | 'modifiedFiles'
    | 'createdAssets'
    | 'updatedAssets'
    | 'disabledAssets'
    | 'evidenceRefs'
    | 'expectedBehaviorChange'
    | 'nextSessionEffect'
  >
  acceptanceEvidence?: MatOSDirectAssetEditorAcceptanceEvidence
  semanticAcceptance?: Pick<
    MatOSSemanticAcceptanceResult,
    | 'verdict'
    | 'confidence'
    | 'reason'
    | 'resolvedUserProblem'
    | 'overfitRisk'
    | 'assetPollutionRisk'
    | 'missingEvidence'
    | 'recommendedFollowup'
  >
  validation?: MatOSAssetHistoryValidationResult
  validationBaseline?: MatOSAssetHistoryValidationResult
  introducedValidationErrorCount?: number
  beforeSnapshot?: string
  afterSnapshot?: string
  diffPatchPath?: string
}

type DirectEditorSourceAuditWriteResult = {
  root: string
  jsonPath: string
  summaryPath: string
  diffPath?: string
}

function safeAuditSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 160) || 'run'
  )
}

function truncateAuditText(value: unknown, max = 4000): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function auditValidationSummary(
  validation: MatOSAssetHistoryValidationResult | undefined,
) {
  if (!validation) {
    return undefined
  }
  return {
    ok: validation.ok,
    gateProfile: validation.gateProfile,
    assetValidationOk: validation.assetValidation.ok,
    assetValidationErrorCount: validation.assetValidation.errors.length,
    secretScanOk: validation.secretScan.ok,
    secretFindingCount: validation.secretScan.findings.length,
    workflowValidationCount: validation.workflowValidation.length,
  }
}

function sourceAuditRelativeRoot(runId: string): string {
  return `.matos/evolution/audit/direct-editor/${safeAuditSegment(runId)}`
}

function sourceAuditSummaryMarkdown(input: {
  audit: MatOSDirectEditorGiteaAuditInput
  source: MatOSGitAssetSourceConfig
  branch: string
}): string {
  const semantic = input.audit.semanticAcceptance
  const targetConformance =
    input.audit.acceptanceEvidence?.targetConformance
  return [
    `# MatOS Direct Editor Audit: ${input.audit.runId}`,
    '',
    `- Status: ${input.audit.status}`,
    `- Scope: ${input.audit.scope}${
      input.audit.scopeRef ? ` (${input.audit.scopeRef})` : ''
    }`,
    `- Source: ${input.source.id}`,
    `- Edit branch: ${input.branch}`,
    `- Summary: ${input.audit.summary}`,
    semantic
      ? `- Semantic acceptance: ${semantic.verdict} (${semantic.confidence})`
      : '- Semantic acceptance: not recorded',
    targetConformance
      ? `- Target conformance: ${targetConformance.status} (${targetConformance.reason})`
      : '- Target conformance: not recorded',
    `- Validation: ${input.audit.validation?.ok === true ? 'passed' : 'not passed/unknown'}`,
    '',
    '## Assets',
    '',
    `- Created: ${(input.audit.editorOutput.createdAssets ?? []).join(', ') || 'none'}`,
    `- Updated: ${(input.audit.editorOutput.updatedAssets ?? []).join(', ') || 'none'}`,
    `- Disabled: ${(input.audit.editorOutput.disabledAssets ?? []).join(', ') || 'none'}`,
    '',
    '## Evidence',
    '',
    `- Evidence refs: ${(input.audit.editorOutput.evidenceRefs ?? []).join(', ') || 'none'}`,
    `- Modified files: ${(input.audit.editorOutput.modifiedFiles ?? []).join(', ') || 'none'}`,
    input.audit.diffPatchPath ? '- Diff: see `diff.patch`' : '- Diff: not recorded',
    '',
    '## Judge Reason',
    '',
    truncateAuditText(semantic?.reason, 6000) ?? 'No judge reason recorded.',
    '',
  ].join('\n')
}

async function writeDirectEditorSourceAudit(input: {
  cwd: string
  checkoutRoot: string
  source: MatOSGitAssetSourceConfig
  branch: string
  audit: MatOSDirectEditorGiteaAuditInput
}): Promise<DirectEditorSourceAuditWriteResult> {
  const relativeRoot = sourceAuditRelativeRoot(input.audit.runId)
  const root = join(input.checkoutRoot, relativeRoot)
  await mkdir(root, { recursive: true })
  const auditRecord = {
    schemaVersion: 1,
    kind: 'matos-direct-editor-gitea-audit',
    generatedAt: new Date().toISOString(),
    runId: input.audit.runId,
    scope: input.audit.scope,
    ...(input.audit.scopeRef ? { scopeRef: input.audit.scopeRef } : {}),
    status: input.audit.status,
    summary: input.audit.summary,
    source: {
      id: input.source.id,
      repo: input.source.repo,
      ref: input.source.ref,
      subdir: input.source.subdir,
      scope: input.source.scope ?? 'project',
      scopeRef: input.source.scopeRef,
      provider: input.source.provider,
      gitea: input.source.gitea
        ? {
            owner: input.source.gitea.owner,
            repo: input.source.gitea.repo,
            visibility: input.source.gitea.visibility,
            webUrl: input.source.gitea.webUrl,
          }
        : undefined,
      editBranch: input.branch,
    },
    targetContract: input.audit.promptInput?.targetContract,
    trigger: input.audit.promptInput?.currentEvolutionContext?.trigger,
    editorOutput: {
      summary: input.audit.editorOutput.summary,
      targetDecision: input.audit.editorOutput.targetDecision,
      modifiedFiles: input.audit.editorOutput.modifiedFiles,
      createdAssets: input.audit.editorOutput.createdAssets,
      updatedAssets: input.audit.editorOutput.updatedAssets,
      disabledAssets: input.audit.editorOutput.disabledAssets,
      evidenceRefs: input.audit.editorOutput.evidenceRefs,
      expectedBehaviorChange: input.audit.editorOutput.expectedBehaviorChange,
      nextSessionEffect: input.audit.editorOutput.nextSessionEffect,
    },
    acceptanceEvidence: input.audit.acceptanceEvidence,
    semanticAcceptance: input.audit.semanticAcceptance
      ? {
          ...input.audit.semanticAcceptance,
          reason: truncateAuditText(input.audit.semanticAcceptance.reason, 8000),
        }
      : undefined,
    validation: auditValidationSummary(input.audit.validation),
    validationBaseline: auditValidationSummary(input.audit.validationBaseline),
    introducedValidationErrorCount: input.audit.introducedValidationErrorCount ?? 0,
    snapshots: {
      before: input.audit.beforeSnapshot,
      after: input.audit.afterSnapshot,
    },
    localRunRecord:
      `.matos/evolution/direct-editor/runs/${safeAuditSegment(
        input.audit.runId,
      )}/run.json`,
    diff: input.audit.diffPatchPath ? 'diff.patch' : undefined,
  }
  const jsonPath = join(root, 'audit.json')
  const summaryPath = join(root, 'SUMMARY.md')
  await writeFile(jsonPath, `${JSON.stringify(auditRecord, null, 2)}\n`, 'utf8')
  await writeFile(
    summaryPath,
    sourceAuditSummaryMarkdown({
      audit: input.audit,
      source: input.source,
      branch: input.branch,
    }),
    'utf8',
  )
  let diffPath: string | undefined
  if (input.audit.diffPatchPath) {
    const diffAbsolutePath = join(input.cwd, input.audit.diffPatchPath)
    const patch = await readFile(diffAbsolutePath, 'utf8').catch(() => undefined)
    if (patch !== undefined) {
      diffPath = join(root, 'diff.patch')
      await writeFile(diffPath, patch, 'utf8')
    }
  }
  return {
    root: relativeRoot,
    jsonPath: `${relativeRoot}/audit.json`,
    summaryPath: `${relativeRoot}/SUMMARY.md`,
    ...(diffPath ? { diffPath: `${relativeRoot}/diff.patch` } : {}),
  }
}

function giteaAuditSummaryTargetUrl(input: {
  baseUrl?: string
  owner: string
  repo: string
  commit: string
  runId: string
}): string | undefined {
  if (!input.baseUrl?.trim()) {
    return undefined
  }
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  const path = `${sourceAuditRelativeRoot(input.runId)}/SUMMARY.md`
  return `${base}/${encodeURIComponent(input.owner)}/${encodeURIComponent(
    input.repo,
  )}/src/commit/${encodeURIComponent(input.commit)}/${path}`
}

async function tryWriteDirectEditorGiteaEvolutionStatus(input: {
  giteaStatus: NonNullable<
    Parameters<typeof acceptMatOSGiteaAssetSourceCommit>[0]['giteaStatus']
  >
  token?: string
  commit: string
  runId: string
}): Promise<boolean> {
  try {
    await createMatOSGiteaCommitStatus({
      apiUrl: input.giteaStatus.apiUrl,
      token: input.token,
      owner: input.giteaStatus.owner,
      repo: input.giteaStatus.repo,
      commit: input.commit,
      state: 'success',
      context: 'matos/evolution',
      description: `MatOS direct-editor audit recorded for ${input.runId}`,
      targetUrl: giteaAuditSummaryTargetUrl({
        baseUrl: input.giteaStatus.baseUrl,
        owner: input.giteaStatus.owner,
        repo: input.giteaStatus.repo,
        commit: input.commit,
        runId: input.runId,
      }),
    })
    return true
  } catch {
    return false
  }
}

function directEditorGiteaStatus(input: {
  source: MatOSGitAssetSourceConfig
  env?: Record<string, string | undefined>
}): Parameters<typeof acceptMatOSGiteaAssetSourceCommit>[0]['giteaStatus'] {
  const owner = input.source.gitea?.owner?.trim()
  const repo = input.source.gitea?.repo?.trim()
  if (!owner || !repo) {
    return undefined
  }
  const apiUrl = directEditorGiteaFirstEnv(input.env, [
    'MATOS_GITEA_API_URL',
    'MATOS_GITEA_API',
  ])
  if (!apiUrl) {
    return undefined
  }
  const baseUrl =
    input.source.gitea?.webUrl?.replace(/\/[^/]+\/[^/]+\/?$/, '') ||
    input.source.gitea?.baseUrl ||
    directEditorGiteaFirstEnv(input.env, [
      'MATOS_GITEA_PUBLIC_BASE_URL',
      'MATOS_GITEA_BASE_URL',
      'MATOS_GITEA_SOURCE_BASE_URL',
      'MATOS_GITEA_UPSTREAM',
    ])
  return {
    apiUrl,
    owner,
    repo,
    ...(baseUrl ? { baseUrl } : {}),
  }
}

function summarizeDirectEditorSourceAcceptance(
  result: MatOSGiteaAssetAcceptanceResult,
  audit?: {
    paths?: DirectEditorSourceAuditWriteResult
    statusWritten?: boolean
  },
): MatOSDirectAssetEditorSourceAcceptance {
  return {
    sourceId: result.sourceId,
    acceptedBranch: result.acceptedBranch,
    commit: result.commit,
    ok: result.ok,
    pushed: result.pushed,
    ...(result.previousAcceptedCommit
      ? { previousAcceptedCommit: result.previousAcceptedCommit }
      : {}),
    validationOk: result.validation.ok,
    ...(!result.validation.ok
      ? {
          validationErrors: result.validation.errors
            .slice(0, 20)
            .map(error => error.message),
        }
      : {}),
    ...(result.statusWritten ? { statusWritten: true } : {}),
    ...(audit?.paths
      ? {
          audit: {
            jsonPath: audit.paths.jsonPath,
            summaryPath: audit.paths.summaryPath,
            ...(audit.paths.diffPath ? { diffPath: audit.paths.diffPath } : {}),
          },
        }
      : {}),
    ...(audit?.statusWritten ? { auditStatusWritten: true } : {}),
  }
}

function gitSourceRuntimeExpectedCommit(
  source: MatOSGitAssetSourceConfig,
): string | undefined {
  if (source.runtimeRef?.mode === 'accepted-ref') {
    return source.runtimeRef.commit?.trim() || undefined
  }
  if (source.runtimeRef?.mode === 'commit') {
    return source.runtimeRef.commit.trim()
  }
  return undefined
}

function gitSourceRuntimeRefName(
  source: MatOSGitAssetSourceConfig,
): string | undefined {
  if (source.runtimeRef?.mode === 'accepted-ref') {
    return matOSGitBranchName(source.runtimeRef.ref)
  }
  return source.ref?.trim() || undefined
}

async function directEditorGitEnv(checkoutRoot: string, token?: string): Promise<NodeJS.ProcessEnv> {
  return matOSGitCheckoutProcessEnv(checkoutRoot, token, await directEditorGitSafeDirectoryArgs(checkoutRoot))
}

async function directEditorGitSafeDirectoryArgs(
  checkoutRoot: string,
): Promise<string[]> {
  const directories = [resolve(checkoutRoot)]
  const realDirectory = await realpath(checkoutRoot).catch(() => undefined)
  if (realDirectory && realDirectory !== directories[0]) {
    directories.push(realDirectory)
  }
  return directories.flatMap(directory => ['-c', `safe.directory=${directory}`])
}

function directEditorGitSourceRequiresPushToken(
  source: MatOSGitAssetSourceConfig,
  env?: Record<string, string | undefined>,
): boolean {
  if (matOSGiteaFileSourceRepoForSource({ source, env })) {
    return false
  }
  const repo = source.repo.trim().toLowerCase()
  return (
    (repo.startsWith('http://') || repo.startsWith('https://')) &&
    (source.provider === 'gitea' || Boolean(source.gitea))
  )
}

function missingDirectEditorGitSourceTokenError(sourceId: string): MatOSDirectAssetEditorSourceCommitError {
  return {
    sourceId,
    error:
      'MatOS Gitea source push requires MATOS_GITEA_TOKEN or MATOS_GATEWAY_GITEA_TOKEN; set MATOS_GITEA_OPERATOR_ENV_FILE/MATOS_DEPLOY_ROOT for operator runs or enable workspace Gitea token passthrough before accepting scoped generated assets',
  }
}

async function execDirectEditorGit(
  checkoutRoot: string,
  args: string[],
  token?: string,
): Promise<void> {
  await execFileAsync('git', [
    ...(await directEditorGitSafeDirectoryArgs(checkoutRoot)),
    '-C',
    checkoutRoot,
    ...args,
  ], {
    env: await directEditorGitEnv(checkoutRoot, token),
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  })
}

async function directEditorGitOutput(
  checkoutRoot: string,
  args: string[],
  token?: string,
): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', [
      ...(await directEditorGitSafeDirectoryArgs(checkoutRoot)),
      '-C',
      checkoutRoot,
      ...args,
    ], {
      env: await directEditorGitEnv(checkoutRoot, token),
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    })
    const output = String(result.stdout ?? '').trim()
    return output || undefined
  } catch {
    return undefined
  }
}

async function directEditorGitSucceeds(
  checkoutRoot: string,
  args: string[],
  token?: string,
): Promise<boolean> {
  try {
    await execDirectEditorGit(checkoutRoot, args, token)
    return true
  } catch {
    return false
  }
}

function directEditorGitErrorText(error: unknown): string {
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

function directEditorCheckoutErrorIsRecoverable(error: unknown): boolean {
  const text = directEditorGitErrorText(error).toLowerCase()
  return (
    text.includes('unable to write new index file') ||
    (text.includes('unable to create') && text.includes('.git/index.lock')) ||
    text.includes('could not lock index') ||
    text.includes('index.lock') ||
    text.includes('permission denied') ||
    text.includes('operation not permitted')
  )
}

async function removeDirectEditorGitIndexLock(checkoutRoot: string): Promise<void> {
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

async function checkoutDirectEditorSourceCommitWithRepair(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  checkoutRoot: string
  commit: string
  token?: string
}): Promise<void> {
  try {
    await execDirectEditorGit(
      input.checkoutRoot,
      ['checkout', '--force', '--detach', input.commit],
      input.token,
    )
    return
  } catch (error) {
    if (!directEditorCheckoutErrorIsRecoverable(error)) {
      throw error
    }
    await removeDirectEditorGitIndexLock(input.checkoutRoot)
    await repairMatOSGitAssetSourceCachePermissions(input.cwd, input.source).catch(
      () => undefined,
    )
    await sleep(250)
    await removeDirectEditorGitIndexLock(input.checkoutRoot)
    await execDirectEditorGit(
      input.checkoutRoot,
      ['checkout', '--force', '--detach', input.commit],
      input.token,
    )
  }
}

async function directEditorGitSourceHasPendingChanges(
  checkoutRoot: string,
  token?: string,
): Promise<boolean> {
  const result = await execFileAsync(
    'git',
    [
      ...(await directEditorGitSafeDirectoryArgs(checkoutRoot)),
      '-C',
      checkoutRoot,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ],
    {
      env: await directEditorGitEnv(checkoutRoot, token),
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  return String(result.stdout ?? '').trim().length > 0
}

export async function fastForwardDirectEditorSourceToRemoteAccepted(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  token?: string
}): Promise<MatOSGitAssetSourceConfig> {
  if (
    input.source.runtimeRef?.mode !== 'accepted-ref' ||
    !input.source.runtimeRef.commit?.trim() ||
    !input.source.runtimeRef.ref?.trim()
  ) {
    return input.source
  }
  const checkoutRoot = matOSGitAssetSourceCheckoutRoot(input.cwd, input.source)
  if (await directEditorGitSourceHasPendingChanges(checkoutRoot, input.token)) return input.source
  const acceptedRef = matOSGitBranchName(input.source.runtimeRef.ref)
  await syncMatOSGitAssetSourceOriginRemote({
    cwd: input.cwd,
    source: input.source,
    checkoutRoot,
    ...(input.token ? { token: input.token } : {}),
  }).catch(() => undefined)
  await execDirectEditorGit(
    checkoutRoot,
    [
      'fetch',
      'origin',
      `+refs/heads/${acceptedRef}:refs/remotes/origin/${acceptedRef}`,
    ],
    input.token,
  ).catch(() => undefined)
  const remoteCommit = await directEditorGitOutput(
    checkoutRoot,
    ['rev-parse', '--verify', `refs/remotes/origin/${acceptedRef}^{commit}`],
    input.token,
  )
  const localCommit = input.source.runtimeRef.commit.trim()
  if (!remoteCommit || remoteCommit === localCommit) {
    return input.source
  }
  const canFastForward = await directEditorGitSucceeds(
    checkoutRoot,
    ['merge-base', '--is-ancestor', localCommit, remoteCommit],
    input.token,
  )
  if (!canFastForward) {
    return input.source
  }
  await checkoutDirectEditorSourceCommitWithRepair({
    cwd: input.cwd,
    source: input.source,
    checkoutRoot,
    commit: remoteCommit,
    ...(input.token ? { token: input.token } : {}),
  })
  await execDirectEditorGit(
    checkoutRoot,
    ['branch', '-f', acceptedRef, remoteCommit],
    input.token,
  )
  return {
    ...input.source,
    runtimeRef: {
      ...input.source.runtimeRef,
      commit: remoteCommit,
      acceptedAt: new Date().toISOString(),
    },
  }
}

async function restoreDirectEditorSourceCheckoutToRuntimeRef(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  token?: string
  pushAcceptedRef?: boolean
  expectedRemoteCommit?: string
}): Promise<void> {
  const expectedCommit = gitSourceRuntimeExpectedCommit(input.source)
  if (!expectedCommit) {
    await materializeMatOSAssetSource(input.cwd, input.source, {
      refresh: 'always',
      ...(input.token ? { token: input.token } : {}),
    })
    return
  }
  const checkoutRoot = matOSGitAssetSourceCheckoutRoot(input.cwd, input.source)
  try {
    await checkoutDirectEditorSourceCommitWithRepair({
      cwd: input.cwd,
      source: input.source,
      checkoutRoot,
      commit: expectedCommit,
      ...(input.token ? { token: input.token } : {}),
    })
    const refName = gitSourceRuntimeRefName(input.source)
    if (refName) {
      await execDirectEditorGit(
        checkoutRoot,
        ['branch', '-f', refName, expectedCommit],
        input.token,
      )
    }
    if (
      input.pushAcceptedRef &&
      input.source.runtimeRef?.mode === 'accepted-ref' &&
      refName
    ) {
      await syncMatOSGitAssetSourceOriginRemote({
        cwd: input.cwd,
        source: input.source,
        checkoutRoot,
        ...(input.token ? { token: input.token } : {}),
      }).catch(() => undefined)
      if (!input.expectedRemoteCommit) {
        throw new Error(
          `Refusing accepted-ref rollback for ${refName} without the commit advanced by this transaction`,
        )
      }
      await updateMatOSGiteaAcceptedRefWithLease({
        checkoutRoot,
        acceptedBranch: refName,
        targetCommit: expectedCommit,
        expectedRemoteCommit: input.expectedRemoteCommit,
        ...(input.token ? { token: input.token } : {}),
      })
    }
  } finally {
    await repairMatOSGitAssetSourceCachePermissions(input.cwd, input.source, {
      full: false,
    })
  }
}

async function validateDirectEditorAcceptedSourceRoot(input: {
  cwd: string
  root: string
  dependencyRoots?: string[]
}) {
  const tempCwd = await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: 'direct-editor-accepted-source-',
  })
  try {
    await writeMatOSProjectConfig(tempCwd, {
      version: 1,
      assetRoots: [input.root],
      includeDefaultAssetRoots: false,
    })
    const targetValidation = await validateMatOSAssets(await loadMatOSAssets(tempCwd))
    const dependencyRoots = [...new Set(input.dependencyRoots ?? [])].filter(
      root => root !== input.root,
    )
    if (targetValidation.ok || dependencyRoots.length === 0) {
      return targetValidation
    }
    const dependencyCwd = await mkdtempInMatOSTmp({
      cwd: input.cwd,
      prefix: 'direct-editor-accepted-source-deps-',
    })
    try {
      await writeMatOSProjectConfig(dependencyCwd, {
        version: 1,
        assetRoots: dependencyRoots,
        includeDefaultAssetRoots: false,
      })
      const dependencyRegistry = buildMatOSAssetRegistry(
        await loadMatOSAssets(dependencyCwd),
      )
      const filteredErrors = targetValidation.errors.filter(
        error => !directEditorValidationErrorResolvedByDependency(error, dependencyRegistry),
      )
      return {
        ok: filteredErrors.length === 0,
        errors: filteredErrors,
      }
    } finally {
      await rm(dependencyCwd, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    await rm(tempCwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

function directEditorValidationReference(
  error: MatOSAssetValidationError,
): string | undefined {
  if (error.code !== 'missing_dependency' && error.code !== 'missing_mount') {
    return undefined
  }
  return error.message.match(/"([^"]+)"/)?.[1]
}

function directEditorValidationErrorResolvedByDependency(
  error: MatOSAssetValidationError,
  registry: MatOSAssetRegistry,
): boolean {
  const reference = directEditorValidationReference(error)
  return reference ? registry.resolve(reference) !== undefined : false
}

function directEditorValidationSummary(
  validation: MatOSAssetValidationResult,
): string {
  if (validation.ok) {
    return 'validation passed'
  }
  return validation.errors
    .slice(0, 8)
    .map(error => `${error.code}: ${error.message}`)
    .join('; ') || 'validation failed'
}

async function materializeDirectEditorDependencyAssetSourceRoots(input: {
  cwd: string
  sources: MatOSAssetSourceConfig[]
  excludeSourceId: string
  token?: string
  scopeRef?: string
}): Promise<Record<string, string>> {
  const roots: Record<string, string> = {}
  for (const source of input.sources) {
    if (source.id === input.excludeSourceId || source.includeInRuntime === false) {
      continue
    }
    if (!['core', 'shared', 'global'].includes(source.scope ?? '') && source.scopeRef !== input.scopeRef) continue
    const provenance = await resolveMatOSAssetSourceRootProvenance(input.cwd, {
      version: 1, assetRoots: [], includeDefaultAssetRoots: false, assetSources: [source],
    }, { runtimeSnapshot: true,
      ...(input.token && source.type === 'git' && (source.provider === 'gitea' || source.gitea) ? { token: input.token } : {}),
    })
    for (const [path] of provenance) roots[source.id] = path
  }
  return roots
}

function normalizedLogicalChangedPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

// Decide whether the run's accepted changes live inside a source checkout.
// Changed paths come from asset-history (cwd-relative logical paths such as
// `.matos/source-cache/scopes/users/<id>/git/<source-id>/...`). A checkout
// outside the cwd cannot be classified and stays conservative (treated as
// touched).
function changedPathsTouchSourceCheckout(input: {
  cwd: string
  checkoutRoot: string
  changedPaths: string[]
}): boolean {
  const rel = relative(input.cwd, input.checkoutRoot).replace(/\\/g, '/')
  if (!rel || rel === '.' || rel.startsWith('..')) {
    return true
  }
  const prefix = `${rel}/`
  return input.changedPaths.some(path => {
    const normalized = normalizedLogicalChangedPath(path)
    return normalized === rel || normalized.startsWith(prefix)
  })
}

export async function commitAcceptedDirectEditorGitAssetSources(input: {
  cwd: string
  runId: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  summary: string
  env?: Record<string, string | undefined>
  audit?: MatOSDirectEditorGiteaAuditInput
  allowAlreadyAccepted?: boolean
  // Logical asset-history paths changed by this run. When provided, matched
  // sources whose checkouts the run never touched are skipped gracefully
  // instead of failing the run with a noop-checkout error (for example
  // experience-only edits that stay in local generated evidence roots).
  changedPaths?: string[]
  // Invoked immediately after a source's remote accepted ref push succeeds.
  // Callers keep their rollback ledger through this hook so a later throw in
  // this function (project config write, runtime validation) can never orphan
  // an already-pushed accepted ref: the catch path still knows exactly which
  // remote refs must be rolled back and to which lease commit.
  onAcceptedRefPushed?: (pushed: { sourceId: string; commit: string; acceptedBranch: string; previousAcceptedCommit?: string }) => void | Promise<void>
}): Promise<{
  matchedGitSourceCount: number
  sourceRootChangesDetected?: boolean
  sourceCommits?: MatOSGitAssetSourceCommitResult[]
  sourceAcceptance?: MatOSDirectAssetEditorSourceAcceptance[]
  sourceCommitErrors?: MatOSDirectAssetEditorSourceCommitError[]
  acceptedRefPushedSourceIds?: string[]
  acceptedRefPushedCommits?: Record<string, string>
}> {
  const config = await readMatOSProjectConfig(input.cwd, { strict: true })
  const sources = (config.assetSources ?? []).filter(
    (source): source is MatOSAssetSourceConfig & { type: 'git' } =>
      source.type === 'git' &&
      directEditorAssetSourceMatchesRunScope({
        source,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      }),
  )
  if (sources.length === 0) {
    return { matchedGitSourceCount: 0 }
  }
  // Core-scope edits use the editable-core logical layout, not the source
  // checkout paths, and are replaced into the checkout during acceptance.
  // Keep core conservative and classify only scoped (user/team/project) runs.
  const runTouchedSource = (source: MatOSAssetSourceConfig & { type: 'git' }) =>
    !input.changedPaths ||
    input.scope === 'core' ||
    changedPathsTouchSourceCheckout({
      cwd: input.cwd,
      checkoutRoot: matOSGitAssetSourceCheckoutRoot(input.cwd, source),
      changedPaths: input.changedPaths,
    })
  const sourceRootChangesDetected = input.changedPaths
    ? sources.some(source => runTouchedSource(source))
    : undefined

  // Gitea-backed source acceptance is the runtime authority; disable push only
  // for explicit local recovery/debug runs.
  const push = directEditorEnvFlag(
    input.env,
    ['MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH', 'MATOS_EVOLUTION_GIT_SOURCE_PUSH'],
    true,
  )
  const token = matOSGiteaEnvValueWithProcessFallback(MATOS_GITEA_TOKEN_KEYS,
    input.scopeRef ? { ...input.env, MATOS_SCOPE_REF: input.scopeRef } : input.env)
  if (push && !token) {
    const tokenRequiredSources = sources.filter(
      source =>
        directEditorGitSourceRequiresPushToken(source, input.env) &&
        runTouchedSource(source),
    )
    if (tokenRequiredSources.length > 0) {
      return {
        matchedGitSourceCount: sources.length,
        ...(sourceRootChangesDetected !== undefined
          ? { sourceRootChangesDetected }
          : {}),
        sourceCommitErrors: tokenRequiredSources.map(source =>
          missingDirectEditorGitSourceTokenError(source.id),
        ),
      }
    }
  }
  const message = directEditorSourceCommitMessage({
    runId: input.runId,
    summary: input.summary,
  })
  const sourceCommits: MatOSGitAssetSourceCommitResult[] = []
  const sourceAcceptance: MatOSDirectAssetEditorSourceAcceptance[] = []
  const sourceCommitErrors: MatOSDirectAssetEditorSourceCommitError[] = []
  const nextSources = [...(config.assetSources ?? [])]
  const acceptedRefPushedSourceIds = new Set<string>()
  const acceptedRefPushedCommits = new Map<string, string>()
  let shouldWriteConfig = false
  for (const source of sources) {
    if (!runTouchedSource(source)) continue
    try {
      let activeSource = source
      if (input.scope === 'core') {
        const materializedRoot = await materializeMatOSAssetSource(
          input.cwd,
          activeSource,
        )
        const materializedIsPackRoot = await pathExists(
          join(materializedRoot, 'matos.pack.json'),
        )
        await replaceDirectoryContents({
          source: coreEditableRoot(input.cwd),
          target: materializedIsPackRoot
            ? materializedRoot
            : join(materializedRoot, 'packs', 'matos-core'),
        })
      }
      const branch = directEditorSourceEditBranch(input.runId)
      const checkoutRoot = matOSGitAssetSourceCheckoutRoot(input.cwd, activeSource)
      if (!(await pathExists(join(checkoutRoot, '.git')))) {
        await materializeMatOSAssetSource(input.cwd, activeSource, {
          ...(token ? { token } : {}),
        })
      }
      const hasChangesBeforeFastForward =
        await directEditorGitSourceHasPendingChanges(checkoutRoot, token)
      if (!hasChangesBeforeFastForward) {
        activeSource = await fastForwardDirectEditorSourceToRemoteAccepted({
          cwd: input.cwd,
          source: activeSource,
          ...(token ? { token } : {}),
        })
      }
      const hasSourceChangesBeforeAudit =
        hasChangesBeforeFastForward ||
        (await directEditorGitSourceHasPendingChanges(checkoutRoot, token))
      if (!hasSourceChangesBeforeAudit && input.allowAlreadyAccepted) {
        const acceptedBranch = gitSourceRuntimeRefName(activeSource)
        const acceptedCommit = gitSourceRuntimeExpectedCommit(activeSource)
        const checkoutCommit = await directEditorGitOutput(
          checkoutRoot,
          ['rev-parse', 'HEAD'],
          token,
        )
        const acceptedBranchCommit = acceptedBranch
          ? await directEditorGitOutput(
              checkoutRoot,
              ['rev-parse', acceptedBranch],
              token,
            )
          : undefined
        if (
          acceptedBranch &&
          acceptedCommit &&
          checkoutCommit === acceptedCommit &&
          (!acceptedBranchCommit || acceptedBranchCommit === acceptedCommit)
        ) {
          const dependencyRoots =
            await materializeDirectEditorDependencyAssetSourceRoots({
              cwd: input.cwd,
              sources: config.assetSources ?? [],
              excludeSourceId: activeSource.id,
              scopeRef: input.scopeRef,
              ...(token ? { token } : {}),
            })
          const acceptedRoot = resolve(
            activeSource.subdir
              ? join(checkoutRoot, activeSource.subdir)
              : checkoutRoot,
          )
          const validation = await validateDirectEditorAcceptedSourceRoot({
            cwd: input.cwd,
            root: acceptedRoot,
            dependencyRoots: Object.values(dependencyRoots),
          })
          sourceAcceptance.push({
            sourceId: activeSource.id,
            acceptedBranch,
            commit: acceptedCommit,
            ok: validation.ok,
            pushed: false,
            validationOk: validation.ok,
            ...(!validation.ok
              ? {
                  validationErrors: validation.errors
                    .slice(0, 20)
                    .map(error => error.message),
                }
              : {}),
          })
          if (!validation.ok) {
            sourceCommitErrors.push({
              sourceId: source.id,
              error: `already accepted source validation failed for ${acceptedCommit}: ${directEditorValidationSummary(validation)}`,
            })
          } else if (
            activeSource.runtimeRef?.mode === 'accepted-ref' &&
            activeSource.runtimeRef.commit !== gitSourceRuntimeExpectedCommit(source)
          ) {
            const sourceIndex = nextSources.findIndex(item => item.id === source.id)
            if (sourceIndex >= 0) {
              nextSources[sourceIndex] = activeSource
              shouldWriteConfig = true
            }
          }
          continue
        }
      }
      if (!hasSourceChangesBeforeAudit && !runTouchedSource(source)) {
        // The run's accepted changes live entirely outside this source
        // checkout (for example experience evidence in the local generated
        // tree). There is nothing to commit or advance for this source, and
        // failing the whole run here would roll back a legitimate edit.
        sourceCommits.push({
          ok: true,
          sourceId: source.id,
          branch,
          checkoutRoot,
          action: 'noop',
          dirtyBefore: false,
          changedPaths: [],
          pushed: false,
        })
        continue
      }
      const auditWrite = input.audit && hasSourceChangesBeforeAudit
        ? await writeDirectEditorSourceAudit({
            cwd: input.cwd,
            checkoutRoot,
            source: activeSource,
            branch,
            audit: input.audit,
          })
        : undefined
      const sourceCommit = await commitMatOSGitAssetSource(input.cwd, activeSource, {
        message,
        branch,
        push,
        ...(token ? { token } : {}),
      })
      sourceCommits.push(sourceCommit)
      if (sourceCommit.action !== 'committed') {
        sourceCommitErrors.push({
          sourceId: source.id,
          error: `MatOS git asset source ${source.id} produced no direct-editor commit; accepted runtime refs are not allowed to advance from a noop source checkout`,
        })
        continue
      }
      if (sourceCommit.action === 'committed' && sourceCommit.pushed !== true) {
        sourceCommitErrors.push({
          sourceId: source.id,
          error: `MatOS git asset source commit ${
            sourceCommit.commit ?? '(unknown)'
          } was not pushed`,
        })
      }
      if (!sourceCommit.commit) {
        sourceCommitErrors.push({
          sourceId: source.id,
          error: 'MatOS git asset source commit did not produce a commit SHA',
        })
        continue
      }
      const giteaStatus = directEditorGiteaStatus({ source: activeSource, env: input.env })
      const dependencyRoots = await materializeDirectEditorDependencyAssetSourceRoots({
        cwd: input.cwd,
        sources: config.assetSources ?? [],
        excludeSourceId: activeSource.id,
        scopeRef: input.scopeRef,
        ...(token ? { token } : {}),
      })
      const accepted = await acceptMatOSGiteaAssetSourceCommit({
        cwd: input.cwd,
        source: activeSource,
        ref: sourceCommit.commit,
        push,
        archiveAudit: { runId: input.runId, summary: input.audit?.editorOutput.summary ?? input.summary,
          expectedBehaviorChange: input.audit?.editorOutput.expectedBehaviorChange,
          verdict: input.audit?.semanticAcceptance?.verdict,
          beforeSnapshot: input.audit?.beforeSnapshot, afterSnapshot: input.audit?.afterSnapshot },
        ...(token ? { token } : {}),
        onAcceptedRefPushed: async ({ commit, previousAcceptedCommit, acceptedBranch }) => {
          acceptedRefPushedSourceIds.add(source.id)
          acceptedRefPushedCommits.set(source.id, commit)
          // Preserve evidence even if acceptance throws during readback,
          // branch update or permission repair after the remote push.
          sourceAcceptance.push({
            sourceId: source.id,
            acceptedBranch,
            commit, previousAcceptedCommit,
            ok: false, pushed: true, validationOk: true,
          })
          await input.onAcceptedRefPushed?.({ sourceId: source.id, commit, previousAcceptedCommit, acceptedBranch })
        },
        ...(giteaStatus ? { giteaStatus } : {}),
        dependencySourceRoots: dependencyRoots,
        validateRoot: root =>
          validateDirectEditorAcceptedSourceRoot({
            cwd: input.cwd,
            root,
            dependencyRoots: Object.values(dependencyRoots),
          }),
      })
      const auditStatusWritten =
        accepted.ok && giteaStatus && input.audit
          ? await tryWriteDirectEditorGiteaEvolutionStatus({
              giteaStatus,
              ...(token ? { token } : {}),
              commit: accepted.commit,
              runId: input.audit.runId,
            })
          : false
      const acceptanceSummary = summarizeDirectEditorSourceAcceptance(accepted, {
          ...(auditWrite ? { paths: auditWrite } : {}),
          ...(auditStatusWritten ? { statusWritten: true } : {}),
        })
      const pushedIndex = sourceAcceptance.findIndex(item => item.sourceId === source.id)
      if (pushedIndex >= 0) sourceAcceptance[pushedIndex] = acceptanceSummary
      else sourceAcceptance.push(acceptanceSummary)
      if (!accepted.ok) {
        sourceCommitErrors.push({
          sourceId: source.id,
          error: `accepted source validation failed for ${accepted.commit}: ${directEditorValidationSummary(accepted.validation)}`,
        })
        continue
      }
      if (accepted.pushed !== true) {
        sourceCommitErrors.push({
          sourceId: source.id,
          error: `accepted source ref ${accepted.acceptedBranch} was not pushed`,
        })
        continue
      }
      acceptedRefPushedSourceIds.add(source.id)
      acceptedRefPushedCommits.set(source.id, accepted.commit)
      const nextSource: MatOSGitAssetSourceConfig = {
        ...activeSource,
        runtimeRef: accepted.runtimeRef,
      }
      await materializeMatOSAssetSource(input.cwd, nextSource, {
        refresh: 'always',
        ...(token ? { token } : {}),
      })
      const sourceIndex = nextSources.findIndex(item => item.id === source.id)
      if (sourceIndex >= 0) {
        nextSources[sourceIndex] = nextSource
        shouldWriteConfig = true
      }
    } catch (error) {
      sourceCommitErrors.push({
        sourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (shouldWriteConfig && sourceCommitErrors.length === 0) {
    try {
      const current = await readMatOSProjectConfig(input.cwd, { strict: true })
      const replacements = new Map(nextSources.filter(source =>
        !isDeepStrictEqual(source, config.assetSources?.find(old => old.id === source.id)),
      ).map(source => [source.id, source]))
      for (const [id, source] of replacements) {
        const actual = current.assetSources?.find(item => item.id === id)
        if (!isDeepStrictEqual(actual, config.assetSources?.find(item => item.id === id)) && !isDeepStrictEqual(actual, source)) {
          throw new Error(`gitea_source_config_conflict: source ${id} changed during publication`)
        }
      }
      await writeMatOSProjectConfig(input.cwd, { ...current,
        assetSources: current.assetSources?.map(source => replacements.get(source.id) ?? source),
      })
      const validation = await validateMatOSAssets(await loadMatOSAssets(input.cwd, { runtimeSnapshot: true }))
      if (!validation.ok) throw new Error(`accepted source runtime validation failed with ${validation.errors.length} error(s)`)
    } catch (error) {
      sourceCommitErrors.push({
        sourceId: 'matos-config',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    matchedGitSourceCount: sources.length,
    ...(sourceRootChangesDetected !== undefined
      ? { sourceRootChangesDetected }
      : {}),
    ...(sourceCommits.length > 0 ? { sourceCommits } : {}),
    ...(sourceAcceptance.length > 0 ? { sourceAcceptance } : {}),
    ...(sourceCommitErrors.length > 0 ? { sourceCommitErrors } : {}),
    ...(acceptedRefPushedSourceIds.size > 0
      ? { acceptedRefPushedSourceIds: [...acceptedRefPushedSourceIds] }
      : {}),
    ...(acceptedRefPushedCommits.size > 0
      ? { acceptedRefPushedCommits: Object.fromEntries(acceptedRefPushedCommits) }
      : {}),
  }
}

export async function restoreDirectEditorAcceptedSourceState(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  config: MatOSProjectConfig
  pushedSourceIds: Set<string>
  changedPaths?: string[]
  pushedSourceCommits?: Map<string, string>
  env?: Record<string, string | undefined>
  sourceCommitErrors?: MatOSDirectAssetEditorSourceCommitError[]
}): Promise<{ ok: boolean }> {
  const errors = input.sourceCommitErrors ?? []
  const errorsBefore = errors.length
  const restored = new Set<string>()
  const token = matOSGiteaEnvValueWithProcessFallback(MATOS_GITEA_TOKEN_KEYS,
    input.scopeRef ? { ...input.env, MATOS_SCOPE_REF: input.scopeRef } : input.env)
  const sources = (input.config.assetSources ?? []).filter(
    (source): source is MatOSAssetSourceConfig & { type: 'git' } =>
      source.type === 'git' &&
      directEditorAssetSourceMatchesRunScope({
        source,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      }),
  )
  for (const source of sources) {
    if (input.changedPaths && !input.pushedSourceIds.has(source.id)) {
      if (!changedPathsTouchSourceCheckout({ cwd: input.cwd,
        checkoutRoot: matOSGitAssetSourceCheckoutRoot(input.cwd, source), changedPaths: input.changedPaths })) continue
    }
    await restoreDirectEditorSourceCheckoutToRuntimeRef({
      cwd: input.cwd,
      source,
      ...(token ? { token } : {}),
      pushAcceptedRef: input.pushedSourceIds.has(source.id),
      ...(input.pushedSourceCommits?.get(source.id)
        ? { expectedRemoteCommit: input.pushedSourceCommits.get(source.id) }
        : {}),
    }).then(() => { restored.add(source.id) }).catch(error => {
      errors.push({
        sourceId: source.id,
        error: `failed to restore source state after post-acceptance failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    })
  }
  try {
    const current = await readMatOSProjectConfig(input.cwd, { strict: true })
    const nextSources = current.assetSources?.map(source => {
      if (!restored.has(source.id) || source.type !== 'git') return source
      const previous = sources.find(item => item.id === source.id)!
      const { runtimeRef: currentRef, ...currentIdentity } = source
      const { runtimeRef: previousRef, ...previousIdentity } = previous
      if (!isDeepStrictEqual(currentIdentity, previousIdentity) ||
        (!isDeepStrictEqual(currentRef, previousRef) && gitSourceRuntimeExpectedCommit(source) !== input.pushedSourceCommits?.get(source.id))) {
        throw new Error(`gitea_source_config_conflict: refusing to roll back a concurrently changed source ${source.id}`)
      }
      return { ...source, runtimeRef: previousRef }
    })
    await writeMatOSProjectConfig(input.cwd, { ...current, assetSources: nextSources })
  } catch (error) {
    errors.push({
      sourceId: 'matos-config',
      error: `failed to restore project config after post-acceptance failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }
  return {
    ok: errors.length === errorsBefore,
  }
}

export function directEditorSourceAcceptanceFailureMessage(
  errors: MatOSDirectAssetEditorSourceCommitError[] | undefined,
): string | undefined {
  if (!errors || errors.length === 0) {
    return undefined
  }
  return `Gitea-backed source acceptance failed: ${errors
    .map(error => `${error.sourceId}: ${error.error}`)
    .join('; ')}`
}
