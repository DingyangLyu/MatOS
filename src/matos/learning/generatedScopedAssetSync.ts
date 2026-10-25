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
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { matOSGiteaScopeIdFromScopeRef } from '../assets/giteaGovernance.js'
import { matOSGiteaEnvValueWithProcessFallback } from '../assets/giteaOperatorEnv.js'
import {
  buildRuntimeScopedGiteaAssetSource,
  syncRuntimeScopedGiteaAssetSourceLocked,
  type RuntimeScopedGiteaAssetSourceScope,
} from '../assets/scopedGiteaSources.js'
import { matOSGiteaFileSourceRepoForSource } from '../assets/giteaRuntimeTransport.js'
import {
  hasMatOSSecretLookingContent,
  isMatOSSecretLookingFileName,
} from '../assets/secretScan.js'
import { isSupportedMatOSAssetType, type MatOSAssetType } from '../assets/types.js'
import {
  materializeMatOSAssetSource,
  withMatOSGitAssetSourceLock,
  type MatOSGitAssetSourceCommitResult,
} from '../assets/sourceAdapters.js'
import {
  getMatOSDir,
  readMatOSProjectConfig,
  writeMatOSProjectConfig,
  type MatOSAssetSourceConfig,
  type MatOSGitAssetSourceConfig,
} from '../project.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { withMatOSAssetHistoryLock } from '../assets/history/lock.js'
import {
  commitAcceptedDirectEditorGitAssetSources,
  fastForwardDirectEditorSourceToRemoteAccepted,
  restoreDirectEditorAcceptedSourceState,
} from './directAssetEditorSourceAcceptance.js'
import type {
  MatOSDirectAssetEditorSourceAcceptance,
  MatOSDirectAssetEditorSourceCommitError,
} from './directAssetEditor.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'

const execFileAsync = promisify(execFile)
const MAX_GENERATED_SECRET_SCAN_BYTES = 1024 * 1024

export type MatOSGeneratedScopedAssetSyncCopiedAsset = {
  type: MatOSAssetType
  id: string
  version?: string
  generatedDir: string
  targetDir: string
  canonicalRef: string
}

export type MatOSGeneratedScopedAssetSyncSkippedAsset = {
  generatedDir: string
  reason: string
}

export type MatOSGeneratedScopedAssetSyncResult = {
  ok: boolean
  scope: MatOSDirectAssetEditorScope
  scopeRef: string
  runId: string
  generatedRoot: string
  matchedGitSourceCount: number
  targetSourceId?: string
  targetRoot?: string
  copiedAssets: MatOSGeneratedScopedAssetSyncCopiedAsset[]
  skippedAssets: MatOSGeneratedScopedAssetSyncSkippedAsset[]
  sourceCommits?: MatOSGitAssetSourceCommitResult[]
  sourceAcceptance?: MatOSDirectAssetEditorSourceAcceptance[]
  sourceCommitErrors?: MatOSDirectAssetEditorSourceCommitError[]
  acceptedRefPushedSourceIds?: string[]
  acceptedRefPushedCommits?: Record<string, string>
}

export type MatOSGeneratedScopedAssetRollback = () => Promise<{
  ok: boolean
  errors: MatOSDirectAssetEditorSourceCommitError[]
}>

type GeneratedAssetCandidate = {
  type: MatOSAssetType
  id: string
  version?: string
  generatedDir: string
  manifestPath: string
}

type GeneratedAssetSecretFinding = {
  generatedDir: string
  path: string
  reason: string
}

const GENERATED_SCOPE_DIRS: Record<
  Extract<MatOSDirectAssetEditorScope, 'user' | 'team' | 'project'>,
  string
> = {
  user: 'users',
  team: 'teams',
  project: 'projects',
}

const TARGET_TYPE_DIR: Partial<Record<MatOSAssetType, string>> = {
  data: 'data',
  knowledge: 'knowledge',
  tool: 'tool',
  skill: 'skill',
  role: 'role',
  workflow: 'workflow',
  benchmark: 'benchmark',
  'benchmark-suite': 'benchmark-suite',
  evaluation: 'evaluation',
  experience: 'experience',
  plugin: 'plugin',
  mcp: 'mcp',
  runtime: 'runtime',
}

function generatedSyncEnvFlag(
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

function generatedSyncGiteaToken(
  env: Record<string, string | undefined> | undefined,
  scopeRef: string,
): string | undefined {
  const keys = ['MATOS_GITEA_TOKEN', 'MATOS_GATEWAY_GITEA_TOKEN']
  return matOSGiteaEnvValueWithProcessFallback(keys, { ...env, MATOS_SCOPE_REF: scopeRef })
}

function generatedSyncEnvValue(
  env: Record<string, string | undefined> | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = (env?.[key] ?? process.env[key])?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function generatedSyncGiteaBaseUrl(
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  return generatedSyncEnvValue(env, [
    'MATOS_GITEA_CONTAINER_SOURCE_BASE_URL',
    'MATOS_GITEA_SOURCE_BASE_URL',
    'MATOS_GITEA_BASE_URL',
    'MATOS_GITEA_UPSTREAM',
  ])
}

function generatedSyncGiteaSourceRef(
  env: Record<string, string | undefined> | undefined,
): string {
  return (
    generatedSyncEnvValue(env, [
      'MATOS_GATEWAY_USER_GITEA_ASSET_REF',
      'MATOS_GITEA_ASSET_REF',
    ]) ?? 'main'
  )
}

function generatedSyncBaseUrlNeedsToken(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase()
  return normalized.startsWith('http://') || normalized.startsWith('https://')
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined
}

function generatedSyncSourceNeedsRepair(input: {
  source: MatOSGitAssetSourceConfig
  env?: Record<string, string | undefined>
}): boolean {
  if (input.source.runtimeRef?.mode !== 'accepted-ref') {
    return true
  }
  const baseUrl = trimTrailingSlash(generatedSyncGiteaBaseUrl(input.env))
  if (!baseUrl || !(input.source.provider === 'gitea' || input.source.gitea)) {
    return false
  }
  const sourceBaseUrl = trimTrailingSlash(input.source.gitea?.baseUrl)
  if (sourceBaseUrl && sourceBaseUrl !== baseUrl) {
    return true
  }
  try {
    const repo = new URL(input.source.repo)
    const base = new URL(baseUrl)
    return repo.protocol !== base.protocol || repo.host !== base.host
  } catch {
    return false
  }
}

function generatedSyncHasMountedFileSource(input: {
  scope: RuntimeScopedGiteaAssetSourceScope
  scopeRef: string
  baseUrl: string
  env?: Record<string, string | undefined>
}): boolean {
  const source = buildRuntimeScopedGiteaAssetSource({
    scope: input.scope,
    scopeRef: input.scopeRef,
    baseUrl: input.baseUrl,
    ref: generatedSyncGiteaSourceRef(input.env),
  })
  return Boolean(
    matOSGiteaFileSourceRepoForSource({
      source,
      env: input.env,
    }),
  )
}

function gitSourceRequiresPushToken(
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

async function repairMissingGeneratedScopedGiteaSource(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef: string
  env?: Record<string, string | undefined>
}): Promise<
  | { ok: true; source: MatOSGitAssetSourceConfig }
  | { ok: false; error?: string }
> {
  if (
    input.scope !== 'user' &&
    input.scope !== 'team' &&
    input.scope !== 'project'
  ) {
    return { ok: false }
  }
  const baseUrl = generatedSyncGiteaBaseUrl(input.env)
  if (!baseUrl) {
    return { ok: false }
  }
  const token = generatedSyncGiteaToken(input.env, input.scopeRef)
  const mountedFileSource =
    generatedSyncBaseUrlNeedsToken(baseUrl) &&
    generatedSyncHasMountedFileSource({
      scope: input.scope,
      scopeRef: input.scopeRef,
      baseUrl,
      env: input.env,
    })
  if (generatedSyncBaseUrlNeedsToken(baseUrl) && !token && !mountedFileSource) {
    return {
      ok: false,
      error:
        'Matching scoped Gitea source is missing and repair requires MATOS_GITEA_TOKEN or MATOS_GATEWAY_GITEA_TOKEN',
    }
  }
  async function syncSource(runtimeRefMode?: 'accepted' | 'source') {
    return await syncRuntimeScopedGiteaAssetSourceLocked({
      cwd: input.cwd,
      scope: input.scope as RuntimeScopedGiteaAssetSourceScope,
      scopeRef: input.scopeRef,
      baseUrl,
      ref: generatedSyncGiteaSourceRef(input.env),
      refresh: 'always',
      replace: true,
      ...(runtimeRefMode ? { runtimeRefMode } : {}),
      ...(runtimeRefMode === 'accepted' ? { channel: 'stable' } : {}),
      ...(token ? { token } : {}),
    })
  }
  let acceptedError: string | undefined
  try {
    const repaired = await syncSource('accepted')
    if (!repaired.ok) {
      acceptedError = repaired.validation.errors
        .map(error => error.message)
        .join('; ') || 'accepted scoped Gitea source repair validation failed'
    } else {
      return { ok: true, source: repaired.source }
    }
  } catch (error) {
    acceptedError = error instanceof Error ? error.message : String(error)
  }
  try {
    const repaired = await syncSource('source')
    if (!repaired.ok) {
      return {
        ok: false,
        error: repaired.validation.errors
          .map(error => error.message)
          .join('; ') || 'scoped Gitea source repair validation failed',
      }
    }
    return { ok: true, source: repaired.source }
  } catch (error) {
    return {
      ok: false,
      error: [
        acceptedError
          ? `accepted-ref repair failed: ${acceptedError}`
          : undefined,
        `source-branch repair failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]
        .filter(Boolean)
        .join('; '),
    }
  }
}

function generatedSyncPushEnabled(
  env: Record<string, string | undefined> | undefined,
): boolean {
  return generatedSyncEnvFlag(
    env,
    ['MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH', 'MATOS_EVOLUTION_GIT_SOURCE_PUSH'],
    true,
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sourceScope(source: MatOSAssetSourceConfig): NonNullable<MatOSAssetSourceConfig['scope']> {
  return source.scope ?? 'project'
}

function gitSourceMatchesScope(input: {
  source: MatOSAssetSourceConfig
  scope: MatOSDirectAssetEditorScope
  scopeRef: string
}): input is { source: MatOSGitAssetSourceConfig; scope: MatOSDirectAssetEditorScope; scopeRef: string } {
  return (
    input.source.type === 'git' &&
    sourceScope(input.source) === input.scope &&
    input.source.scopeRef === input.scopeRef &&
    input.source.includeInRuntime !== false
  )
}

function generatedScopeRoot(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef: string
}): string | undefined {
  if (
    input.scope !== 'user' &&
    input.scope !== 'team' &&
    input.scope !== 'project'
  ) {
    return undefined
  }
  return join(
    getMatOSDir(input.cwd),
    'assets',
    'generated',
    'scopes',
    GENERATED_SCOPE_DIRS[input.scope],
    matOSGiteaScopeIdFromScopeRef(input.scopeRef),
  )
}

function safeAssetPathSegment(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return undefined
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return undefined
  }
  return trimmed
}

async function findAssetManifests(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      paths.push(...(await findAssetManifests(full)))
    } else if (entry.isFile() && entry.name === 'asset.json') {
      paths.push(full)
    }
  }
  return paths
}

async function discoverGeneratedAssets(root: string): Promise<{
  candidates: GeneratedAssetCandidate[]
  skipped: MatOSGeneratedScopedAssetSyncSkippedAsset[]
}> {
  if (!(await pathExists(root))) {
    return { candidates: [], skipped: [] }
  }
  const candidates: GeneratedAssetCandidate[] = []
  const skipped: MatOSGeneratedScopedAssetSyncSkippedAsset[] = []
  for (const manifestPath of await findAssetManifests(root)) {
    const generatedDir = dirname(manifestPath)
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      const type = typeof parsed.type === 'string' ? parsed.type.trim() : ''
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
      const version =
        typeof parsed.version === 'string' && parsed.version.trim()
          ? parsed.version.trim()
          : undefined
      if (!isSupportedMatOSAssetType(type)) {
        skipped.push({ generatedDir, reason: `unsupported asset type: ${type || '(missing)'}` })
        continue
      }
      if (!safeAssetPathSegment(id)) {
        skipped.push({ generatedDir, reason: `unsafe or missing asset id: ${id || '(missing)'}` })
        continue
      }
      candidates.push({
        type,
        id,
        ...(version ? { version } : {}),
        generatedDir,
        manifestPath,
      })
    } catch (error) {
      skipped.push({
        generatedDir,
        reason: `invalid manifest: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return {
    candidates: candidates.sort((left, right) =>
      left.manifestPath.localeCompare(right.manifestPath),
    ),
    skipped,
  }
}

async function listGeneratedAssetFiles(input: {
  root: string
  dir?: string
}): Promise<{ path: string; absolutePath: string }[]> {
  const dir = input.dir ?? input.root
  const files: { path: string; absolutePath: string }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name)
    const logicalPath = relative(input.root, absolutePath) || entry.name
    if (entry.isDirectory()) {
      files.push(
        ...(await listGeneratedAssetFiles({
          root: input.root,
          dir: absolutePath,
        })),
      )
      continue
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push({ path: logicalPath, absolutePath })
    }
  }
  return files
}

async function secretFindingsForGeneratedAsset(
  candidate: GeneratedAssetCandidate,
): Promise<GeneratedAssetSecretFinding[]> {
  const findings: GeneratedAssetSecretFinding[] = []
  for (const file of await listGeneratedAssetFiles({ root: candidate.generatedDir })) {
    if (isMatOSSecretLookingFileName(file.path)) {
      findings.push({
        generatedDir: candidate.generatedDir,
        path: file.path,
        reason: 'secret-looking file name',
      })
      continue
    }
    const info = await lstat(file.absolutePath).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_GENERATED_SECRET_SCAN_BYTES) {
      continue
    }
    const raw = await readFile(file.absolutePath).catch(() => undefined)
    if (!raw) {
      continue
    }
    const text = raw.toString('utf8')
    if (
      Buffer.from(text, 'utf8').equals(raw) &&
      hasMatOSSecretLookingContent(text)
    ) {
      findings.push({
        generatedDir: candidate.generatedDir,
        path: file.path,
        reason: 'secret-looking content',
      })
    }
  }
  return findings
}

async function secretFindingsForGeneratedAssets(
  candidates: GeneratedAssetCandidate[],
): Promise<GeneratedAssetSecretFinding[]> {
  const findings: GeneratedAssetSecretFinding[] = []
  for (const candidate of candidates) {
    findings.push(...(await secretFindingsForGeneratedAsset(candidate)))
  }
  return findings
}

function assertInside(parent: string, child: string): void {
  const relativePath = relative(parent, child)
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to write outside MatOS asset source root: ${child}`)
  }
}

function canonicalRef(candidate: GeneratedAssetCandidate): string {
  return `${candidate.type}:${candidate.id}${candidate.version ? `@${candidate.version}` : ''}`
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

async function gitStatusLines(checkoutRoot: string): Promise<string[]> {
  const result = await execFileAsync(
    'git',
    [
      '-c',
      `safe.directory=${resolve(checkoutRoot)}`,
      '-C',
      checkoutRoot,
      'status',
      '--porcelain',
    ],
    {
      env: gitEnv(),
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  return String(result.stdout ?? '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function looksLikeAssetRef(value: string): boolean {
  return /^[a-z][a-z0-9-]*:[^@\s]+(?:@[^@\s]+)?$/i.test(value.trim())
}

function assetRefs(value: unknown): string[] {
  return stringArray(value)
    .map(item => item.trim())
    .filter(item => item.length > 0 && looksLikeAssetRef(item))
}

function mergeUnique(...lists: string[][]): string[] {
  return [...new Set(lists.flat().filter(Boolean))]
}

function refsFromDependencyObject(value: unknown): string[] {
  const dependencies = objectRecord(value)
  const refs: string[] = []
  for (const dependencyValue of Object.values(dependencies)) {
    refs.push(...assetRefs(dependencyValue))
  }
  return refs
}

function mergeMountsFromMetadata(input: {
  manifest: Record<string, unknown>
  metadata: Record<string, unknown>
}): Record<string, unknown> | undefined {
  const existing = objectRecord(input.manifest.mounts)
  const mounts: Record<string, string[]> = {
    ...(Object.keys(existing).length > 0
      ? Object.fromEntries(
          Object.entries(existing).map(([key, value]) => [key, assetRefs(value)]),
        )
      : {}),
  }
  const add = (key: string, refs: string[]) => {
    if (refs.length === 0) {
      return
    }
    mounts[key] = mergeUnique(mounts[key] ?? [], refs)
  }
  add('skills', assetRefs(input.metadata.mountedSkills))
  add('tools', assetRefs(input.metadata.mountedTools))
  add('knowledge', assetRefs(input.metadata.mountedKnowledge))
  add('workflows', assetRefs(input.metadata.mountedWorkflows))
  add('roles', assetRefs(input.metadata.mountedRoles))
  add('skills', assetRefs(input.metadata.requiredSkills))
  add('tools', assetRefs(input.metadata.requiredTools))
  add('knowledge', assetRefs(input.metadata.requiredKnowledge))
  add('workflows', assetRefs(input.metadata.requiredWorkflows))

  const normalized = Object.fromEntries(
    Object.entries(mounts).filter(([, refs]) => refs.length > 0),
  )
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function safeRelativeAssetFile(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0') ||
    isAbsolute(trimmed)
  ) {
    return undefined
  }
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    return undefined
  }
  return parts.join('/')
}

async function workflowEntryFromGeneratedDefinition(input: {
  targetDir: string
  manifest: Record<string, unknown>
  metadata: Record<string, unknown>
}): Promise<string | undefined> {
  if (input.manifest.type !== 'workflow') {
    return undefined
  }
  const candidates = [
    safeRelativeAssetFile(input.metadata.definitionFile),
    safeRelativeAssetFile(input.manifest.entry),
    'workflow.yaml',
    'workflow.yml',
    'workflow.json',
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    if (!/\.(ya?ml|json)$/i.test(candidate)) {
      continue
    }
    const candidatePath = resolve(input.targetDir, candidate)
    const relativePath = relative(resolve(input.targetDir), candidatePath)
    if (
      relativePath.startsWith('..') ||
      isAbsolute(relativePath) ||
      !(await pathExists(candidatePath))
    ) {
      continue
    }
    return candidate
  }
  return undefined
}

async function normalizeCopiedGeneratedAssetManifest(
  targetDir: string,
  options: { parkRuntimeAssetsAsDraft?: boolean } = {},
): Promise<void> {
  const manifestPath = join(targetDir, 'asset.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const metadata = objectRecord(manifest.metadata)
  const manifestType = typeof manifest.type === 'string' ? manifest.type : ''
  const shouldParkAsDraft =
    options.parkRuntimeAssetsAsDraft !== false &&
    SYNC_DRAFT_PARKED_ASSET_TYPES.has(manifestType) &&
    objectRecord(manifest.lifecycle).status !== 'disabled'
  const dependencies = mergeUnique(
    assetRefs(manifest.dependencies),
    refsFromDependencyObject(metadata.dependencies),
    assetRefs(metadata.mountedSkills),
    assetRefs(metadata.mountedTools),
    assetRefs(metadata.mountedKnowledge),
    assetRefs(metadata.mountedWorkflows),
    assetRefs(metadata.mountedRoles),
    assetRefs(metadata.requiredSkills),
    assetRefs(metadata.requiredTools),
    assetRefs(metadata.requiredKnowledge),
    assetRefs(metadata.requiredWorkflows),
  )
  const mounts = mergeMountsFromMetadata({ manifest, metadata })
  const workflowEntry = await workflowEntryFromGeneratedDefinition({
    targetDir,
    manifest,
    metadata,
  })
  const normalized = {
    ...manifest,
    ...(workflowEntry ? { entry: workflowEntry } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(mounts ? { mounts } : {}),
    // This sync path usually has not run Gate 1/Gate 2: only type whitelist and
    // secret scan guard it. Runtime assets arriving through that generic side
    // channel must not become live by default. Explicit builders such as
    // role_edit may opt out after running their own reference gate, validation,
    // accepted-ref sync, and smoke checks.
    ...(shouldParkAsDraft
      ? {
          lifecycle: {
            ...objectRecord(manifest.lifecycle),
            status: 'draft',
            reason:
              'generated-scoped-asset-sync: pending review before activation',
          },
        }
      : {}),
  }
  await writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
}

// Runtime asset types that must not arrive enabled through the ungated sync
// side channel. Experiences are evidence and keep their own lifecycle.
const SYNC_DRAFT_PARKED_ASSET_TYPES = new Set([
  'role',
  'skill',
  'workflow',
  'tool',
  'mcp',
  'knowledge',
])

async function copyGeneratedAssetToSource(input: {
  candidate: GeneratedAssetCandidate
  targetRoot: string
  parkRuntimeAssetsAsDraft?: boolean
  preserveExistingAssetVersions?: boolean
}): Promise<MatOSGeneratedScopedAssetSyncCopiedAsset> {
  const typeDir = TARGET_TYPE_DIR[input.candidate.type] ?? input.candidate.type
  const id = safeAssetPathSegment(input.candidate.id)
  if (!id) {
    throw new Error(`Unsafe generated asset id: ${input.candidate.id}`)
  }
  const candidateRef = canonicalRef(input.candidate)
  const defaultTargetDir = resolve(input.targetRoot, typeDir, id)
  let targetDir = defaultTargetDir
  if (
    input.preserveExistingAssetVersions &&
    await pathExists(defaultTargetDir)
  ) {
    const existingRef = await readFile(join(defaultTargetDir, 'asset.json'), 'utf8')
      .then(raw => {
        const manifest = JSON.parse(raw) as Record<string, unknown>
        const type = typeof manifest.type === 'string' ? manifest.type.trim() : ''
        const assetId = typeof manifest.id === 'string' ? manifest.id.trim() : ''
        const version = typeof manifest.version === 'string'
          ? manifest.version.trim()
          : ''
        return type && assetId
          ? `${type}:${assetId}${version ? `@${version}` : ''}`
          : undefined
      })
      .catch(() => undefined)
    if (existingRef !== candidateRef) {
      const version = safeAssetPathSegment(input.candidate.version ?? '')
      if (!version) {
        throw new Error(
          `Cannot preserve the existing ${input.candidate.type}:${input.candidate.id} asset while importing unversioned ${candidateRef}`,
        )
      }
      targetDir = resolve(input.targetRoot, typeDir, `${id}@${version}`)
      if (await pathExists(targetDir)) {
        const versionedRef = await readFile(join(targetDir, 'asset.json'), 'utf8')
          .then(raw => {
            const manifest = JSON.parse(raw) as Record<string, unknown>
            const type = typeof manifest.type === 'string' ? manifest.type.trim() : ''
            const assetId = typeof manifest.id === 'string' ? manifest.id.trim() : ''
            const assetVersion = typeof manifest.version === 'string'
              ? manifest.version.trim()
              : ''
            return type && assetId
              ? `${type}:${assetId}${assetVersion ? `@${assetVersion}` : ''}`
              : undefined
          })
          .catch(() => undefined)
        if (versionedRef !== candidateRef) {
          throw new Error(
            `Refusing to overwrite occupied versioned asset path ${targetDir} while importing ${candidateRef}`,
          )
        }
      }
    }
  }
  assertInside(resolve(input.targetRoot), targetDir)
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(dirname(targetDir), { recursive: true })
  await cp(input.candidate.generatedDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  })
  await normalizeCopiedGeneratedAssetManifest(targetDir, {
    parkRuntimeAssetsAsDraft: input.parkRuntimeAssetsAsDraft,
  })
  return {
    type: input.candidate.type,
    id: input.candidate.id,
    ...(input.candidate.version ? { version: input.candidate.version } : {}),
    generatedDir: input.candidate.generatedDir,
    targetDir,
    canonicalRef: canonicalRef(input.candidate),
  }
}

async function backupAndRemoveGeneratedDirs(input: {
  cwd: string
  generatedRoot: string
  candidates: GeneratedAssetCandidate[]
  runId: string
}): Promise<{
  backupRoot: string
  restore: () => Promise<void>
  cleanup: () => Promise<void>
}> {
  const backupRoot = await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: `generated-scope-sync-${input.runId}-`,
  })
  for (const candidate of input.candidates) {
    const relativeDir = relative(input.generatedRoot, candidate.generatedDir)
    const backupDir = join(backupRoot, relativeDir)
    await cp(candidate.generatedDir, backupDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
    })
    await rm(candidate.generatedDir, { recursive: true, force: true })
  }
  return {
    backupRoot,
    restore: async () => {
      for (const candidate of input.candidates) {
        const relativeDir = relative(input.generatedRoot, candidate.generatedDir)
        const backupDir = join(backupRoot, relativeDir)
        if (!(await pathExists(backupDir))) {
          continue
        }
        await mkdir(dirname(candidate.generatedDir), { recursive: true })
        await rm(candidate.generatedDir, { recursive: true, force: true })
        await cp(backupDir, candidate.generatedDir, {
          recursive: true,
          force: true,
          errorOnExist: false,
        })
      }
    },
    cleanup: async () => {
      await rm(backupRoot, { recursive: true, force: true })
    },
  }
}

export async function syncGeneratedScopedAssetsToGitea(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef: string
  runId: string
  summary?: string
  env?: Record<string, string | undefined>
  parkRuntimeAssetsAsDraft?: boolean
  // Asset-only sharing may import an exact pinned version while the recipient
  // already owns another version of the same type:id. Keep both manifests in
  // distinct directories instead of replacing the recipient-owned directory.
  preserveExistingAssetVersions?: boolean
  // Restrict a publish transaction to explicitly staged asset directories.
  // Callers such as project-share forking must not accidentally sweep up an
  // unrelated generated asset that another workflow left in the same scoped
  // staging tree.
  generatedAssetDirs?: string[]
  // A caller that performs more steps after a successful publish can register
  // a one-shot compensation. The generated sync itself always invokes the
  // same rollback on internal post-acceptance failures.
  registerRollback?: (rollback: MatOSGeneratedScopedAssetRollback) => void
}): Promise<MatOSGeneratedScopedAssetSyncResult> {
  // Generated assets are staged and published per user/team/project. Keep
  // that long-running transaction isolated by scope so a large upload from
  // one scope does not make unrelated asset edits time out on the workspace's
  // global asset-history lock. The source checkout lock still serializes the
  // actual Git source, and history writers keep the default global lock.
  const lockKey = `generated-scoped-asset-sync-${input.scope}-${input.scopeRef}`
  return withMatOSAssetHistoryLock({
    cwd: input.cwd,
    operation: 'generated-scoped-asset-sync',
    lockKey,
  },
    () => syncGeneratedScopedAssetsToGiteaLocked(input))
}

async function syncGeneratedScopedAssetsToGiteaLocked(input: Parameters<typeof syncGeneratedScopedAssetsToGitea>[0]): Promise<MatOSGeneratedScopedAssetSyncResult> {
  const root = generatedScopeRoot({
    cwd: input.cwd,
    scope: input.scope,
    scopeRef: input.scopeRef,
  })
  if (!root) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: '',
      matchedGitSourceCount: 0,
      copiedAssets: [],
      skippedAssets: [
        {
          generatedDir: '',
          reason: `generated scoped asset sync does not support scope ${input.scope}`,
        },
      ],
      sourceCommitErrors: [
        {
          sourceId: 'generated-assets',
          error: `Generated scoped asset sync does not support scope ${input.scope}`,
        },
      ],
    }
  }

  const discovered = await discoverGeneratedAssets(root)
  const requestedGeneratedDirs = input.generatedAssetDirs?.map(path => resolve(path))
  if (
    requestedGeneratedDirs?.some(path => {
      const relativePath = relative(resolve(root), path)
      return (
        relativePath === '' ||
        relativePath.startsWith('..') ||
        isAbsolute(relativePath)
      )
    })
  ) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: 0,
      copiedAssets: [],
      skippedAssets: [],
      sourceCommitErrors: [
        {
          sourceId: 'generated-assets',
          error: 'Generated asset publish selection must stay inside the scoped staging root',
        },
      ],
    }
  }
  const selectedDirs = requestedGeneratedDirs
    ? new Set(requestedGeneratedDirs)
    : undefined
  const candidates = selectedDirs
    ? discovered.candidates.filter(candidate =>
        selectedDirs.has(resolve(candidate.generatedDir)),
      )
    : discovered.candidates
  const skipped = selectedDirs
    ? discovered.skipped.filter(item => selectedDirs.has(resolve(item.generatedDir)))
    : discovered.skipped
  const missingSelectedDirs = selectedDirs
    ? [...selectedDirs].filter(
        selected =>
          !candidates.some(candidate => resolve(candidate.generatedDir) === selected) &&
          !skipped.some(item => resolve(item.generatedDir) === selected),
      )
    : []
  if (missingSelectedDirs.length > 0) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: 0,
      copiedAssets: [],
      skippedAssets: missingSelectedDirs.map(generatedDir => ({
        generatedDir,
        reason: 'selected generated asset directory has no asset.json manifest',
      })),
      sourceCommitErrors: [
        {
          sourceId: 'generated-assets',
          error: `Generated scoped asset sync could not find ${missingSelectedDirs.length} explicitly selected asset(s)`,
        },
      ],
    }
  }
  if (candidates.length === 0) {
    const ok = skipped.length === 0
    return {
      ok,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: 0,
      copiedAssets: [],
      skippedAssets: skipped,
      ...(ok
        ? {}
        : {
            sourceCommitErrors: [
              {
                sourceId: 'generated-assets',
                error: `Generated scoped asset sync skipped ${skipped.length} asset(s); no supported generated assets were accepted`,
              },
            ],
          }),
    }
  }
  const secretFindings = await secretFindingsForGeneratedAssets(candidates)
  if (secretFindings.length > 0) {
    const details = secretFindings
      .slice(0, 5)
      .map(finding => `${relative(root, finding.generatedDir)}/${finding.path}: ${finding.reason}`)
      .join('; ')
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: 0,
      copiedAssets: [],
      skippedAssets: [
        ...skipped,
        ...secretFindings.map(finding => ({
          generatedDir: finding.generatedDir,
          reason: `${finding.path}: ${finding.reason}`,
        })),
      ],
      sourceCommitErrors: [
        {
          sourceId: 'generated-assets',
          error: `Generated scoped asset sync rejected ${secretFindings.length} secret-looking file(s) before copying or committing: ${details}`,
        },
      ],
    }
  }

  let config = await readMatOSProjectConfig(input.cwd, { strict: true })
  let sources = (config.assetSources ?? []).filter(source =>
    gitSourceMatchesScope({
      source,
      scope: input.scope,
      scopeRef: input.scopeRef,
    }),
  ) as MatOSGitAssetSourceConfig[]
  let targetSource = sources[0]
  let sourceRepairError: string | undefined
  if (
    !targetSource ||
    generatedSyncSourceNeedsRepair({
      source: targetSource,
      env: input.env,
    })
  ) {
    const repaired = await repairMissingGeneratedScopedGiteaSource({
      cwd: input.cwd,
      scope: input.scope,
      scopeRef: input.scopeRef,
      env: input.env,
    })
    if (repaired.ok) {
      config = await readMatOSProjectConfig(input.cwd, { strict: true })
      sources = (config.assetSources ?? []).filter(source =>
        gitSourceMatchesScope({
          source,
          scope: input.scope,
          scopeRef: input.scopeRef,
        }),
      ) as MatOSGitAssetSourceConfig[]
      targetSource = sources[0] ?? repaired.source
    } else if (repaired.ok === false && !targetSource) {
      sourceRepairError = repaired.error
    }
  }
  if (!targetSource) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: 0,
      copiedAssets: [],
      skippedAssets: [
        ...skipped,
        ...candidates.map(candidate => ({
          generatedDir: candidate.generatedDir,
          reason: `no matching Gitea asset source for ${input.scopeRef}`,
        })),
      ],
      sourceCommitErrors: [
        {
          sourceId: 'matos-config',
          error: sourceRepairError
            ? `No matching Gitea asset source for ${input.scopeRef}; repair failed: ${sourceRepairError}`
            : `No matching Gitea asset source for ${input.scopeRef}`,
        },
      ],
    }
  }
  return withMatOSGitAssetSourceLock(input.cwd, targetSource, async () => {
  const token = generatedSyncGiteaToken(input.env, input.scopeRef)
  if (
    generatedSyncPushEnabled(input.env) &&
    !token &&
    gitSourceRequiresPushToken(targetSource, input.env)
  ) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: sources.length,
      targetSourceId: targetSource.id,
      copiedAssets: [],
      skippedAssets: skipped,
      sourceCommitErrors: [
        {
          sourceId: targetSource.id,
          error:
            'MatOS generated scoped asset sync requires MATOS_GITEA_TOKEN or MATOS_GATEWAY_GITEA_TOKEN before copying assets into the scoped Gitea source cache',
        },
      ],
    }
  }

  const targetRoot = await materializeMatOSAssetSource(input.cwd, targetSource, {
    refresh: targetSource.refresh ?? 'manual',
    preserveDirty: true,
    ...(token ? { token } : {}),
  })
  let dirtyStatus: string[]
  try {
    dirtyStatus = await gitStatusLines(targetRoot)
  } catch (error) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: sources.length,
      targetSourceId: targetSource.id,
      targetRoot,
      copiedAssets: [],
      skippedAssets: skipped,
      sourceCommitErrors: [
        {
          sourceId: targetSource.id,
          error: `Could not inspect scoped Gitea source cache before generated asset sync: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    }
  }
  if (dirtyStatus.length > 0) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: sources.length,
      targetSourceId: targetSource.id,
      targetRoot,
      copiedAssets: [],
      skippedAssets: skipped,
      sourceCommitErrors: [
        {
          sourceId: targetSource.id,
          error: `Refusing generated scoped asset sync because the target Gitea source cache is already dirty: ${dirtyStatus
            .slice(0, 10)
            .join('; ')}`,
        },
      ],
    }
  }
  const targetSourceCommitBeforeRefresh =
    targetSource.runtimeRef?.mode === 'accepted-ref'
      ? targetSource.runtimeRef.commit
      : undefined
  const refreshedTargetSource = await fastForwardDirectEditorSourceToRemoteAccepted({
    cwd: input.cwd,
    source: targetSource,
    ...(token ? { token } : {}),
  })
  const targetSourceCommitAfterRefresh =
    refreshedTargetSource.runtimeRef?.mode === 'accepted-ref'
      ? refreshedTargetSource.runtimeRef.commit
      : undefined
  if (
    targetSourceCommitAfterRefresh &&
    targetSourceCommitAfterRefresh !== targetSourceCommitBeforeRefresh
  ) {
    const latest = await readMatOSProjectConfig(input.cwd, { strict: true })
    const actual = latest.assetSources?.find(source => source.id === targetSource.id)
    if (JSON.stringify(actual) !== JSON.stringify(config.assetSources?.find(source => source.id === targetSource.id))) {
      throw new Error('gitea_source_config_conflict: scoped source changed during generated sync')
    }
    const nextSources = [...(latest.assetSources ?? [])]
    const sourceIndex = nextSources.findIndex(source => source.id === targetSource.id)
    if (sourceIndex >= 0) {
      nextSources[sourceIndex] = refreshedTargetSource
      config = {
        ...latest,
        assetSources: nextSources,
      }
      await writeMatOSProjectConfig(input.cwd, config)
    }
  }
  targetSource = refreshedTargetSource
  try {
    dirtyStatus = await gitStatusLines(targetRoot)
  } catch (error) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: sources.length,
      targetSourceId: targetSource.id,
      targetRoot,
      copiedAssets: [],
      skippedAssets: skipped,
      sourceCommitErrors: [
        {
          sourceId: targetSource.id,
          error: `Could not inspect scoped Gitea source cache after accepted-ref refresh: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    }
  }
  if (dirtyStatus.length > 0) {
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: sources.length,
      targetSourceId: targetSource.id,
      targetRoot,
      copiedAssets: [],
      skippedAssets: skipped,
      sourceCommitErrors: [
        {
          sourceId: targetSource.id,
          error: `Refusing generated scoped asset sync because the target Gitea source cache became dirty after accepted-ref refresh: ${dirtyStatus
            .slice(0, 10)
            .join('; ')}`,
        },
      ],
    }
  }
  const copiedAssets: MatOSGeneratedScopedAssetSyncCopiedAsset[] = []
  for (const candidate of candidates) {
    copiedAssets.push(
      await copyGeneratedAssetToSource({
        candidate,
        targetRoot,
        parkRuntimeAssetsAsDraft: input.parkRuntimeAssetsAsDraft,
        preserveExistingAssetVersions: input.preserveExistingAssetVersions,
      }),
    )
  }

  const generatedBackup = await backupAndRemoveGeneratedDirs({
    cwd: input.cwd,
    generatedRoot: root,
    candidates,
    runId: input.runId,
  })
  const acceptanceBaselineConfig = await readMatOSProjectConfig(input.cwd, { strict: true })
  const changedPaths = copiedAssets.map(asset => relative(input.cwd, asset.targetDir))
  const pushedSourceIds = new Set<string>()
  const pushedSourceCommits = new Map<string, string>()
  let rollbackUsed = false
  const rollbackAcceptedState: MatOSGeneratedScopedAssetRollback = async () => {
    if (rollbackUsed) return { ok: true, errors: [] }
    rollbackUsed = true
    const rollbackErrors: MatOSDirectAssetEditorSourceCommitError[] = []
    const restored = await withMatOSAssetHistoryLock({
      cwd: input.cwd,
      operation: 'generated-scoped-asset-rollback',
      lockKey: `generated-scoped-asset-sync-${input.scope}-${input.scopeRef}`,
      allowReentrant: true,
    },
      () => withMatOSGitAssetSourceLock(input.cwd, targetSource, () => restoreDirectEditorAcceptedSourceState({
      cwd: input.cwd,
      scope: input.scope,
      scopeRef: input.scopeRef,
      config: acceptanceBaselineConfig,
      pushedSourceIds,
      pushedSourceCommits,
      changedPaths,
      env: input.env,
      sourceCommitErrors: rollbackErrors,
    })))
    return { ok: restored.ok, errors: rollbackErrors }
  }
  let acceptance: Awaited<ReturnType<typeof commitAcceptedDirectEditorGitAssetSources>>
  try {
    acceptance = await commitAcceptedDirectEditorGitAssetSources({
      cwd: input.cwd,
      runId: input.runId,
      scope: input.scope,
      scopeRef: input.scopeRef,
      summary:
        input.summary ??
        `Sync ${copiedAssets.length} generated scoped asset(s) into ${input.scopeRef}`,
      env: input.env,
      changedPaths,
      onAcceptedRefPushed: pushed => {
        pushedSourceIds.add(pushed.sourceId)
        pushedSourceCommits.set(pushed.sourceId, pushed.commit)
      },
    })
  } catch (error) {
    const rollback = await rollbackAcceptedState()
    await generatedBackup.restore()
    await generatedBackup.cleanup()
    return {
      ok: false,
      scope: input.scope,
      scopeRef: input.scopeRef,
      runId: input.runId,
      generatedRoot: root,
      matchedGitSourceCount: sources.length,
      targetSourceId: targetSource.id,
      targetRoot,
      copiedAssets,
      skippedAssets: skipped,
      sourceCommitErrors: [
        {
          sourceId: targetSource.id,
          error: error instanceof Error ? error.message : String(error),
        },
        ...rollback.errors,
      ],
    }
  }
  const errors = acceptance.sourceCommitErrors ?? []
  if (errors.length > 0) {
    const rollback = await rollbackAcceptedState()
    errors.push(...rollback.errors)
    await generatedBackup.restore()
  } else {
    input.registerRollback?.(rollbackAcceptedState)
  }
  await generatedBackup.cleanup()
  return {
    ok: errors.length === 0,
    scope: input.scope,
    scopeRef: input.scopeRef,
    runId: input.runId,
    generatedRoot: root,
    matchedGitSourceCount: acceptance.matchedGitSourceCount,
    targetSourceId: targetSource.id,
    targetRoot,
    copiedAssets,
    skippedAssets: skipped,
    ...(acceptance.sourceCommits ? { sourceCommits: acceptance.sourceCommits } : {}),
    ...(acceptance.sourceAcceptance ? { sourceAcceptance: acceptance.sourceAcceptance } : {}),
    ...(acceptance.acceptedRefPushedSourceIds
      ? { acceptedRefPushedSourceIds: acceptance.acceptedRefPushedSourceIds }
      : {}),
    ...(acceptance.acceptedRefPushedCommits
      ? { acceptedRefPushedCommits: acceptance.acceptedRefPushedCommits }
      : {}),
    ...(errors.length > 0 ? { sourceCommitErrors: errors } : {}),
  }
  })
}
