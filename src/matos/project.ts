import { existsSync } from 'node:fs'
import { chown, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MATOS_DEPLOY_ROOT } from './runtime/deploymentRoots.js'

export const MATOS_DIR = '.matos'

export const MATOS_ASSET_DIRS = [
  'data',
  'knowledges',
  'tools',
  'skills',
  'roles',
  'workflows',
  'benchmarks',
  'evaluations',
  'experiences',
  'plugins',
  'mcp',
  'runtimes',
  'packs',
] as const

export type MatOSAssetDirectory = (typeof MATOS_ASSET_DIRS)[number]

export type MatOSProjectExecutionConfig = {
  defaultMode?: 'local' | 'container'
  containerRuntime?: string
  runtimeDataDir?: string
  deploymentRoot?: string
  governanceRoot?: string
  backupRoot?: string
  externalToolchainRoot?: string
  containerMode?: 'persistent' | 'ephemeral'
  globalAssetRoots?: string[]
  containerNamePrefix?: string
  workspaceResourceLimits?: {
    memory?: string
    cpus?: string
    gpus?: string
    pidsLimit?: number
    shmSize?: string
  }
  userRuntimePolicy?: {
    workspaceIdentity?: 'deployment-user' | 'project'
    maxContainersPerUser?: number
    maxConcurrentJobs?: number
    idleTtlMinutes?: number
    maxPortAllocationAttempts?: number
  }
}

export type MatOSAssetSourceScope =
  | 'core'
  | 'project'
  | 'user'
  | 'team'
  | 'shared'
  | 'global'

export type MatOSAssetSourceRefresh = 'manual' | 'always'
export type MatOSGitAssetSourceProvider = 'gitea'
export type MatOSGiteaAssetSourceVisibility = 'private' | 'internal' | 'public'

export type MatOSGiteaAssetSourceConfig = {
  owner: string
  repo: string
  visibility?: MatOSGiteaAssetSourceVisibility
  baseUrl?: string
  webUrl?: string
  cloneUrl?: string
}

export type MatOSGitAssetSourceRuntimeRef =
  | {
      mode: 'source-ref'
    }
  | {
      mode: 'accepted-ref'
      ref: string
      commit?: string
      acceptedAt?: string
      acceptedBy?: string
      validationRecord?: string
    }
  | {
      mode: 'commit'
      commit: string
      acceptedAt?: string
      acceptedBy?: string
      validationRecord?: string
    }

export type MatOSLocalAssetSourceConfig = {
  type: 'local'
  id: string
  path: string
  scope?: MatOSAssetSourceScope
  scopeRef?: string
  refresh?: MatOSAssetSourceRefresh
  includeInRuntime?: boolean
}

export type MatOSGitAssetSourceConfig = {
  type: 'git'
  id: string
  repo: string
  ref?: string
  subdir?: string
  scope?: MatOSAssetSourceScope
  scopeRef?: string
  refresh?: MatOSAssetSourceRefresh
  provider?: MatOSGitAssetSourceProvider
  gitea?: MatOSGiteaAssetSourceConfig
  runtimeRef?: MatOSGitAssetSourceRuntimeRef
  includeInRuntime?: boolean
}

export type MatOSAssetSourceConfig =
  | MatOSLocalAssetSourceConfig
  | MatOSGitAssetSourceConfig

export type MatOSProjectConfig = {
  version: 1
  standalone?: { scopeRef: string }
  assetRoots: string[]
  assetSources?: MatOSAssetSourceConfig[]
  includeDefaultAssetRoots?: boolean
  assetMounts?: MatOSAssetMountConfig[]
  defaultRuntimeProfile?: string
  defaultWorkspaceRuntimeProfile?: string
  execution?: MatOSProjectExecutionConfig
}

export type MatOSAssetMountConfig = {
  path: string
  id?: string
  type?: string
  version?: string
  name?: string
  description?: string
  tags?: string[]
  dependencies?: string[]
  metadata?: Record<string, unknown>
}

type Env = Record<string, string | undefined>

function splitPathList(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value
    .split(new RegExp(`[${escapedDelimiter},]`))
    .map(item => item.trim())
    .filter(Boolean)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function envFlagEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (value ?? '').trim().toLowerCase(),
  )
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items = value
    .map(item => optionalString(item))
    .filter((item): item is string => Boolean(item))
  return items.length > 0 ? items : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function normalizeAssetSourceScope(value: unknown): MatOSAssetSourceScope {
  return value === 'core' ||
    value === 'project' ||
    value === 'user' ||
    value === 'team' ||
    value === 'shared' ||
    value === 'global'
    ? value
    : 'project'
}

function normalizeAssetSourceRefresh(value: unknown): MatOSAssetSourceRefresh {
  return value === 'always' ? 'always' : 'manual'
}

function normalizeGitAssetSourceProvider(
  value: unknown,
): MatOSGitAssetSourceProvider | undefined {
  return value === 'gitea' ? 'gitea' : undefined
}

function normalizeGiteaAssetSource(
  value: unknown,
): MatOSGiteaAssetSourceConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const owner = optionalString(raw.owner)
  const repo = optionalString(raw.repo)
  if (!owner || !repo) {
    return undefined
  }
  const visibility =
    raw.visibility === 'private' ||
    raw.visibility === 'internal' ||
    raw.visibility === 'public'
      ? raw.visibility
      : undefined
  return {
    owner,
    repo,
    ...(visibility ? { visibility } : {}),
    ...(optionalString(raw.baseUrl)
      ? { baseUrl: optionalString(raw.baseUrl) }
      : {}),
    ...(optionalString(raw.webUrl) ? { webUrl: optionalString(raw.webUrl) } : {}),
    ...(optionalString(raw.cloneUrl)
      ? { cloneUrl: optionalString(raw.cloneUrl) }
      : {}),
  }
}

function normalizeGitAssetSourceRuntimeRef(
  value: unknown,
): MatOSGitAssetSourceRuntimeRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (raw.mode === 'source-ref') {
    return { mode: 'source-ref' }
  }
  if (raw.mode === 'accepted-ref') {
    const ref = optionalString(raw.ref)
    if (!ref) {
      return undefined
    }
    return {
      mode: 'accepted-ref',
      ref,
      ...(optionalString(raw.commit) ? { commit: optionalString(raw.commit) } : {}),
      ...(optionalString(raw.acceptedAt)
        ? { acceptedAt: optionalString(raw.acceptedAt) }
        : {}),
      ...(optionalString(raw.acceptedBy)
        ? { acceptedBy: optionalString(raw.acceptedBy) }
        : {}),
      ...(optionalString(raw.validationRecord)
        ? { validationRecord: optionalString(raw.validationRecord) }
        : {}),
    }
  }
  if (raw.mode === 'commit') {
    const commit = optionalString(raw.commit)
    if (!commit) {
      return undefined
    }
    return {
      mode: 'commit',
      commit,
      ...(optionalString(raw.acceptedAt)
        ? { acceptedAt: optionalString(raw.acceptedAt) }
        : {}),
      ...(optionalString(raw.acceptedBy)
        ? { acceptedBy: optionalString(raw.acceptedBy) }
        : {}),
      ...(optionalString(raw.validationRecord)
        ? { validationRecord: optionalString(raw.validationRecord) }
        : {}),
    }
  }
  return undefined
}

function normalizeAssetSources(value: unknown): MatOSAssetSourceConfig[] {
  if (!Array.isArray(value)) {
    return []
  }

  const sources: MatOSAssetSourceConfig[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const raw = item as Record<string, unknown>
    const id = optionalString(raw.id)
    if (!id) {
      continue
    }
    const scope = normalizeAssetSourceScope(raw.scope)
    const refresh = normalizeAssetSourceRefresh(raw.refresh)
    if (raw.type === 'local') {
      const path = optionalString(raw.path)
      if (!path) {
        continue
      }
      sources.push({
        type: 'local',
        id,
        path,
        scope,
        scopeRef: optionalString(raw.scopeRef),
        refresh,
        ...(raw.includeInRuntime === false ? { includeInRuntime: false } : {}),
      })
      continue
    }
    if (raw.type === 'git') {
      const repo = optionalString(raw.repo)
      if (!repo) {
        continue
      }
      sources.push({
        type: 'git',
        id,
        repo,
        ref: optionalString(raw.ref),
        subdir: optionalString(raw.subdir),
        scope,
        scopeRef: optionalString(raw.scopeRef),
        refresh,
        provider: normalizeGitAssetSourceProvider(raw.provider),
        gitea: normalizeGiteaAssetSource(raw.gitea),
        runtimeRef: normalizeGitAssetSourceRuntimeRef(raw.runtimeRef),
        ...(raw.includeInRuntime === false ? { includeInRuntime: false } : {}),
      })
    }
  }

  return sources
}

function normalizeUserRuntimePolicy(
  value: unknown,
): MatOSProjectExecutionConfig['userRuntimePolicy'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const workspaceIdentity =
    raw.workspaceIdentity === 'deployment-user' || raw.workspaceIdentity === 'project'
      ? raw.workspaceIdentity
      : undefined
  const policy: NonNullable<MatOSProjectExecutionConfig['userRuntimePolicy']> = {
    workspaceIdentity,
    maxContainersPerUser: positiveInteger(raw.maxContainersPerUser),
    maxConcurrentJobs: positiveInteger(raw.maxConcurrentJobs),
    idleTtlMinutes: positiveInteger(raw.idleTtlMinutes),
    maxPortAllocationAttempts: positiveInteger(raw.maxPortAllocationAttempts),
  }
  return Object.values(policy).some(value => value !== undefined)
    ? policy
    : undefined
}

function normalizeWorkspaceResourceLimits(
  value: unknown,
): MatOSProjectExecutionConfig['workspaceResourceLimits'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const limits: NonNullable<
    MatOSProjectExecutionConfig['workspaceResourceLimits']
  > = {
    memory: optionalString(raw.memory),
    cpus: optionalString(raw.cpus),
    gpus: optionalString(raw.gpus),
    pidsLimit: positiveInteger(raw.pidsLimit),
    shmSize: optionalString(raw.shmSize),
  }
  return Object.values(limits).some(value => value !== undefined)
    ? limits
    : undefined
}

function normalizeExecutionConfig(
  value: unknown,
): MatOSProjectExecutionConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const raw = value as Record<string, unknown>
  const defaultMode =
    raw.defaultMode === 'local' || raw.defaultMode === 'container'
      ? raw.defaultMode
      : undefined
  const containerMode =
    raw.containerMode === 'persistent' || raw.containerMode === 'ephemeral'
      ? raw.containerMode
      : undefined
  const execution: MatOSProjectExecutionConfig = {
    defaultMode,
    containerRuntime: optionalString(raw.containerRuntime),
    runtimeDataDir: optionalString(raw.runtimeDataDir),
    deploymentRoot: optionalString(raw.deploymentRoot),
    governanceRoot: optionalString(raw.governanceRoot),
    backupRoot: optionalString(raw.backupRoot),
    externalToolchainRoot: optionalString(raw.externalToolchainRoot),
    containerMode,
    globalAssetRoots: stringArray(raw.globalAssetRoots),
    containerNamePrefix: optionalString(raw.containerNamePrefix),
    workspaceResourceLimits: normalizeWorkspaceResourceLimits(
      raw.workspaceResourceLimits,
    ),
    userRuntimePolicy: normalizeUserRuntimePolicy(raw.userRuntimePolicy),
  }

  return Object.values(execution).some(value => value !== undefined)
    ? execution
    : undefined
}

export function getMatOSLegacyRootCandidates(
  env: Env = process.env,
): string[] {
  const configured = splitPathList(env.MATOS_LEGACY_ROOT)
  const siblingRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'MatOS',
  )

  return unique([...configured, siblingRoot])
}

export function getMatOSBundledAssetRootCandidates(
  env: Env = process.env,
): string[] {
  const configured = splitPathList(env.MATOS_BUNDLED_ASSET_ROOT)
  if (configured.length > 0) {
    return unique(configured)
  }
  const bundledRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'distribution', 'benchmark-minimal', 'assets',
  )

  return unique([...configured, bundledRoot])
}

export function getMatOSBundledAssetHostRoot(
  env: Env = process.env,
): string | undefined {
  return getMatOSBundledAssetRootCandidates(env).find(root => existsSync(root))
}

// Resolve where the editable `matos-core` asset pack actually lives for
// self-evolution direct editing and core asset history.
//
// Precedence:
// 1. `<cwd>/matos-assets/packs/matos-core` when it exists. This keeps the dev
//    repo, isolated editor workspaces, harnesses, and tests on the local copy.
// 2. `MATOS_EDITABLE_CORE_ASSET_ROOT` when set (authoritative even if missing,
//    so a misconfigured deployment fails visibly instead of editing the wrong
//    tree).
// 3. The first env-configured bundled asset root (`MATOS_BUNDLED_ASSET_ROOT`)
//    that contains `packs/matos-core`. This is the installed case
//    where core assets live in a separate package while the
//    session cwd is a workspace directory. The module-relative bundled
//    fallback is intentionally NOT used here: a foreign cwd (tests, tmp dirs)
//    must never silently target the development repository's core pack.
// 4. The cwd-relative default.
export function resolveMatOSEditableCoreAssetPackRoot(
  cwd: string,
  env: Env = process.env,
): string {
  const cwdRoot = join(resolve(cwd), 'matos-assets', 'packs', 'matos-core')
  if (existsSync(cwdRoot)) {
    return cwdRoot
  }
  const explicit = optionalString(env.MATOS_EDITABLE_CORE_ASSET_ROOT)
  if (explicit) {
    return resolve(explicit)
  }
  for (const candidate of splitPathList(env.MATOS_BUNDLED_ASSET_ROOT)) {
    const packRoot = join(resolve(candidate), 'packs', 'matos-core')
    if (existsSync(packRoot)) {
      return packRoot
    }
  }
  return cwdRoot
}

export function getMatOSDeploymentAssetRootCandidates(
  env: Env = process.env,
): string[] {
  const deployRoot = resolve(
    optionalString(env.MATOS_DEPLOY_ROOT) ?? DEFAULT_MATOS_DEPLOY_ROOT,
  )
  const sharedAssetRoots = splitPathList(env.MATOS_SHARED_ASSET_ROOT)
  const teamAssetRoots = splitPathList(env.MATOS_TEAM_ASSET_ROOT)
  const globalAssetRoots = splitPathList(env.MATOS_GLOBAL_ASSET_ROOT)

  return unique([
    ...(sharedAssetRoots.length > 0
      ? sharedAssetRoots
      : [join(deployRoot, 'assets', 'shared')]),
    ...teamAssetRoots,
    ...(globalAssetRoots.length > 0
      ? globalAssetRoots
      : [join(deployRoot, 'assets', 'global')]),
  ]).map(root => resolve(root))
}

export function getMatOSDeploymentAssetRoots(env: Env = process.env): string[] {
  return getMatOSDeploymentAssetRootCandidates(env).filter(root =>
    existsSync(root),
  )
}

export function getMatOSDefaultAssetRoots(env: Env = process.env): string[] {
  const configuredAssetRoots = [
    ...splitPathList(env.MATOS_ASSET_ROOTS),
    ...splitPathList(env.MATOS_DEFAULT_ASSET_ROOTS),
  ]
  const bundledAssetRoots = getMatOSBundledAssetRootCandidates(env).filter(root =>
    existsSync(root),
  )
  const legacyAssetRoots = envFlagEnabled(env.MATOS_INCLUDE_LEGACY_ASSETS)
    ? getMatOSLegacyRootCandidates(env).flatMap(root => [
        join(root, 'container', 'skills'),
        join(root, 'container', 'tools'),
      ])
    : []
  const deploymentAssetRoots = getMatOSDeploymentAssetRoots(env)

  return unique([
    ...configuredAssetRoots,
    ...deploymentAssetRoots,
    ...bundledAssetRoots,
    ...legacyAssetRoots,
  ])
}

export function getMatOSDir(cwd: string): string {
  return join(cwd, MATOS_DIR)
}

export function getMatOSConfigPath(cwd: string): string {
  return join(getMatOSDir(cwd), 'matos.json')
}

export function getMatOSAssetsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'assets')
}

export function getMatOSSessionsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'sessions')
}

export function getMatOSAssetLifecyclePath(cwd: string): string {
  return join(getMatOSDir(cwd), 'asset-lifecycle.json')
}

export function getDefaultMatOSConfig(): MatOSProjectConfig {
  return {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: true,
  }
}

export async function readMatOSProjectConfig(
  cwd: string,
  options: { strict?: boolean } = {},
): Promise<MatOSProjectConfig> {
  try {
    const raw = await readFile(getMatOSConfigPath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as Partial<MatOSProjectConfig>
    if (options.strict && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (parsed.version !== undefined && parsed.version !== 1) ||
      (parsed.assetSources !== undefined && (!Array.isArray(parsed.assetSources) ||
        normalizeAssetSources(parsed.assetSources).length !== parsed.assetSources.length)))) {
      throw new Error('MatOS project configuration has an unsupported version or malformed asset sources')
    }
    return {
      ...getDefaultMatOSConfig(),
      ...parsed,
      assetRoots: Array.isArray(parsed.assetRoots)
        ? parsed.assetRoots.filter(
            (item): item is string => typeof item === 'string',
          )
        : getDefaultMatOSConfig().assetRoots,
      assetSources: normalizeAssetSources(
        (parsed as Record<string, unknown>).assetSources,
      ),
      assetMounts: Array.isArray(parsed.assetMounts)
        ? parsed.assetMounts.filter(
            (item): item is MatOSAssetMountConfig =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof (item as MatOSAssetMountConfig).path === 'string',
          )
        : [],
      defaultRuntimeProfile: optionalString(parsed.defaultRuntimeProfile),
      defaultWorkspaceRuntimeProfile: optionalString(
        parsed.defaultWorkspaceRuntimeProfile,
      ),
      execution: normalizeExecutionConfig(parsed.execution),
    }
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return getDefaultMatOSConfig()
  }
}

export async function writeMatOSProjectConfig(
  cwd: string,
  config: MatOSProjectConfig,
): Promise<void> {
  await mkdir(getMatOSDir(cwd), { recursive: true })
  const path = getMatOSConfigPath(cwd)
  const prior = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  const staged = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: prior ? prior.mode & 0o777 : 0o644 })
    if (prior) {
      await chmod(staged, prior.mode & 0o777)
      if (process.getuid?.() === 0) await chown(staged, prior.uid, prior.gid)
    }
    await rename(staged, path)
  } finally { await rm(staged, { force: true }) }
}
