import { readFileSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep, posix, isAbsolute } from 'node:path'
import {
  getMatOSConfigPath,
  getMatOSDir,
  resolveMatOSEditableCoreAssetPackRoot,
} from '../../project.js'
import type {
  MatOSAssetHistoryFileRecord,
  MatOSAssetHistoryReleaseRecord,
  MatOSAssetHistoryScope,
  MatOSAssetHistorySnapshotKind,
  MatOSAssetHistorySnapshotRecord,
} from './types.js'

const SNAPSHOT_KINDS = new Set<MatOSAssetHistorySnapshotKind>([
  'manual',
  'direct-editor-before',
  'direct-editor-after',
  'direct-editor-rollback',
  'release',
])

const SCOPES = new Set<MatOSAssetHistoryScope>([
  'core',
  'project',
  'user',
  'team',
  'shared',
  'global',
])

const SUPPORTED_SCOPES = new Set<MatOSAssetHistoryScope>([
  'core',
  'project',
  'user',
  'team',
  'shared',
  'global',
])

export function assertSupportedMatOSAssetHistoryScope(
  scope: MatOSAssetHistoryScope,
): void {
  if (!SUPPORTED_SCOPES.has(scope)) {
    throw new Error(`Unsupported MatOS asset history scope: ${scope}`)
  }
}

export function assertValidMatOSAssetHistorySnapshotId(snapshotId: string): void {
  if (!/^asset-snapshot-[A-Za-z0-9_-]+$/.test(snapshotId)) {
    throw new Error(`Invalid MatOS asset history snapshot id: ${snapshotId}`)
  }
}

export function assertValidMatOSAssetHistoryReleaseId(releaseId: string): void {
  if (!/^asset-release-[A-Za-z0-9._-]+$/.test(releaseId)) {
    throw new Error(`Invalid MatOS asset history release id: ${releaseId}`)
  }
}

export function isWithinMatOSAssetHistoryPath(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

// Logical record-path prefix for the editable core pack. Snapshot file records
// always use this stable, cwd-independent namespace even when the resolved core
// pack root lives outside the cwd (for example an installed asset package).
export const MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX =
  'matos-assets/packs/matos-core'

const CORE_ASSET_SUBDIRS = [
  'roles',
  'skills',
  'workflows',
  'tools',
  'knowledge',
] as const

const GENERATED_ASSET_HISTORY_DIR_NAMES = new Set([
  '.git',
  '.locks',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.ipynb_checkpoints',
])

const GENERATED_ASSET_HISTORY_FILE_NAMES = new Set([
  '.DS_Store',
])

export function shouldIgnoreMatOSAssetHistoryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some(part => GENERATED_ASSET_HISTORY_DIR_NAMES.has(part))) {
    return true
  }
  // Direct-editor provenance artifacts (`.matos/evolution/audit/...` inside a
  // scoped source checkout) are runtime bookkeeping, not assets. Source
  // checkouts may mount a `subdir` as the allowed root, so these artifacts sit
  // outside the allowlist and previously broke snapshots/rollbacks that
  // enumerated them (`rollback_failed`: "outside allowlist ...
  // .matos/evolution/audit/...`). Note: `.matos/assets/generated/evolution/`
  // does NOT match this sequence and remains snapshot-visible.
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === '.matos' && parts[index + 1] === 'evolution') {
      return true
    }
  }
  const basename = parts.at(-1) ?? normalized
  if (GENERATED_ASSET_HISTORY_FILE_NAMES.has(basename)) {
    return true
  }
  return /\.(pyc|pyo)$/i.test(basename)
}

export function matOSAssetHistoryCorePackRoot(cwd: string): string {
  return resolveMatOSEditableCoreAssetPackRoot(cwd)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function safeAssetSourceId(id: string): string {
  return id
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'source'
}

function safeScopeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'default'
  )
}

function scopedSourceCacheKind(
  scope: MatOSAssetHistoryScope,
): 'users' | 'teams' | 'projects' | undefined {
  if (scope === 'user') return 'users'
  if (scope === 'team') return 'teams'
  if (scope === 'project') return 'projects'
  return undefined
}

function readAssetSources(cwd: string): Record<string, unknown>[] {
  try {
    const config = objectValue(JSON.parse(readFileSync(getMatOSConfigPath(cwd), 'utf8')))
    const sources = config.assetSources
    return Array.isArray(sources)
      ? sources.filter(
          (source): source is Record<string, unknown> =>
            source !== null && typeof source === 'object' && !Array.isArray(source),
        )
      : []
  } catch {
    return []
  }
}

function gitAssetSourceCheckoutRoot(
  cwd: string,
  source: Record<string, unknown>,
): string {
  const id = safeAssetSourceId(String(source.id ?? 'source'))
  const scope = stringValue(source.scope) as MatOSAssetHistoryScope | undefined
  const scopeRef = stringValue(source.scopeRef)
  const scopedKind = scope ? scopedSourceCacheKind(scope) : undefined
  if (scopedKind && scopeRef) {
    return join(
      cwd,
      '.matos',
      'source-cache',
      'scopes',
      scopedKind,
      safeScopeId(scopeRef),
      'git',
      id,
    )
  }
  return join(cwd, '.matos', 'source-cache', 'git', id)
}

function assetSourceRoot(cwd: string, source: Record<string, unknown>): string | undefined {
  const type = stringValue(source.type)
  if (type === 'local') {
    const path = stringValue(source.path)
    return path ? resolve(getMatOSDir(cwd), path) : undefined
  }
  if (type === 'git') {
    const subdir = stringValue(source.subdir)
    const checkoutRoot = gitAssetSourceCheckoutRoot(cwd, source)
    return resolve(subdir ? join(checkoutRoot, subdir) : checkoutRoot)
  }
  return undefined
}

export function configuredAssetSourceRoots(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): string[] {
  const sources = readAssetSources(cwd).filter(
    source => (stringValue(source.scope) ?? 'project') === scope,
  )
  const scopedKind = scopedSourceCacheKind(scope)
  const requestedScopeRef = scopeRef?.trim()
  const configuredScopeRefs = [
    ...new Set(
      sources
        .map(source => stringValue(source.scopeRef))
        .filter((value): value is string => Boolean(value)),
    ),
  ]
  const effectiveScopeRef = scopedKind
    ? requestedScopeRef ??
      (configuredScopeRefs.length === 1 ? configuredScopeRefs[0] : undefined)
    : undefined
  if (requestedScopeRef && !requestedScopeRef.startsWith(`${scope}:`)) {
    throw new Error(
      `MatOS asset history scopeRef ${requestedScopeRef} does not match scope ${scope}`,
    )
  }
  if (scopedKind && !effectiveScopeRef && configuredScopeRefs.length > 1) {
    throw new Error(
      `MatOS asset history scope ${scope} is ambiguous; scopeRef is required`,
    )
  }
  return sources
    .filter(source =>
      scopedKind
        ? Boolean(
            effectiveScopeRef &&
              stringValue(source.scopeRef) === effectiveScopeRef,
          )
        : true,
    )
    .map(source => assetSourceRoot(cwd, source))
    .filter((root): root is string => Boolean(root))
}

function generatedLocalAssetHistoryRoots(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): string[] {
  const kind = scopedSourceCacheKind(scope)
  if (!kind) {
    return []
  }
  const generatedRoot = join(cwd, '.matos', 'assets', 'generated')
  const configuredScopeRefs = readAssetSources(cwd)
    .filter(source => stringValue(source.scope) === scope)
    .map(source => stringValue(source.scopeRef))
    .filter((scopeRef): scopeRef is string => Boolean(scopeRef))
  const refs = scopeRef?.trim()
    ? [scopeRef.trim()]
    : [...new Set(configuredScopeRefs)]
  if (refs.length > 1) {
    throw new Error(
      `MatOS generated asset history scope ${scope} is ambiguous; scopeRef is required`,
    )
  }
  const roots: string[] = []
  // Legacy experience evidence is not owner-namespaced. Keep it available only
  // in a single-owner workspace; multi-owner workspaces must never expose the
  // shared legacy directory to a scoped editor or rollback.
  const configuredOwners = [...new Set(configuredScopeRefs)]
  if (
    configuredOwners.length <= 1 &&
    (!scopeRef || configuredOwners.length === 0 || configuredOwners[0] === scopeRef)
  ) {
    roots.push(resolve(join(generatedRoot, 'evolution', 'experiences')))
  }
  roots.push(
    ...refs.map(ref =>
      resolve(join(generatedRoot, 'scopes', kind, safeScopeId(ref))),
    ),
  )
  return roots
}

export function matOSAssetHistoryAllowedRoots(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef?: string,
): string[] {
  assertSupportedMatOSAssetHistoryScope(scope)
  const root = resolve(cwd)
  if (scope === 'core') {
    const coreRoot = matOSAssetHistoryCorePackRoot(root)
    return [...CORE_ASSET_SUBDIRS.map(subdir => resolve(join(coreRoot, subdir))), ...configuredAssetSourceRoots(root, scope, scopeRef)]
  }
  if (scope === 'shared' || scope === 'global') {
    const configured = configuredAssetSourceRoots(root, scope, scopeRef)
    if (!configured.length) throw new Error(`Unsupported MatOS asset history scope without a registered source: ${scope}`)
    return configured
  }
  const sourceRoots =
    scope === 'project'
      ? [
          join(root, '.matos', 'assets'),
          ...configuredAssetSourceRoots(root, scope, scopeRef),
        ]
      : [...configuredAssetSourceRoots(root, scope, scopeRef)]
  const roots =
    scope !== 'project' && sourceRoots.length > 0
      ? [
          ...sourceRoots,
          ...generatedLocalAssetHistoryRoots(root, scope, scopeRef),
        ]
      : [...sourceRoots]
  return [...new Set(roots.map(item => resolve(item)))]
}

export function normalizeMatOSAssetHistoryRelativePath(path: string): string {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('Invalid MatOS asset history file path')
  }
  if (path.includes('\0') || isAbsolute(path)) {
    throw new Error(`Invalid MatOS asset history file path: ${path}`)
  }
  const normalized = posix.normalize(path.replace(/\\/g, '/'))
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').some(part => part === '..' || part === '.')
  ) {
    throw new Error(`Invalid MatOS asset history file path: ${path}`)
  }
  return normalized
}

export function resolveMatOSAssetHistoryRecordPath(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  path: string
}): { relativePath: string; absolutePath: string } {
  const cwd = resolve(input.cwd)
  const relativePath = normalizeMatOSAssetHistoryRelativePath(input.path)
  // Core logical paths resolve against the configured core pack root, which
  // may live outside the session cwd (e.g. an installed asset package).
  // Everything else stays cwd-relative.
  const corePrefix = `${MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX}/`
  const absolutePath =
    input.scope === 'core' && relativePath.startsWith(corePrefix)
      ? resolve(
          join(
            matOSAssetHistoryCorePackRoot(cwd),
            relativePath.slice(corePrefix.length),
          ),
        )
      : resolve(cwd, relativePath)
  const roots = matOSAssetHistoryAllowedRoots(cwd, input.scope, input.scopeRef)
  if (!roots.some(root => isWithinMatOSAssetHistoryPath(absolutePath, root))) {
    throw new Error(
      `MatOS asset history file path is outside allowlist: ${relativePath}`,
    )
  }
  return { relativePath, absolutePath }
}

// Inverse of resolveMatOSAssetHistoryRecordPath: map an absolute file path
// inside an allowed root to its stable logical record path.
export function matOSAssetHistoryLogicalPath(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
  absolutePath: string
}): string | undefined {
  const cwd = resolve(input.cwd)
  const absolutePath = resolve(input.absolutePath)
  if (input.scope === 'core') {
    const coreRoot = resolve(matOSAssetHistoryCorePackRoot(cwd))
    if (isWithinMatOSAssetHistoryPath(absolutePath, coreRoot)) {
      const rel = relative(coreRoot, absolutePath).replace(/\\/g, '/')
      return rel
        ? `${MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX}/${rel}`
        : MATOS_ASSET_HISTORY_CORE_LOGICAL_PREFIX
    }
  }
  const allowedRoots = matOSAssetHistoryAllowedRoots(
    cwd,
    input.scope,
    input.scopeRef,
  )
  if (
    !allowedRoots.some(root =>
      isWithinMatOSAssetHistoryPath(absolutePath, root),
    )
  ) {
    return undefined
  }
  const rel = relative(cwd, absolutePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return undefined
  }
  return rel.replace(/\\/g, '/')
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validateFileRecord(
  cwd: string,
  scope: MatOSAssetHistoryScope,
  scopeRef: string | undefined,
  value: unknown,
): MatOSAssetHistoryFileRecord {
  const raw = objectValue(value)
  const path = resolveMatOSAssetHistoryRecordPath({
    cwd,
    scope,
    ...(scopeRef ? { scopeRef } : {}),
    path: String(raw.path ?? ''),
  }).relativePath
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256 : ''
  const sizeBytes = Number(raw.sizeBytes)
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error(`Invalid MatOS asset history sha256 for ${path}`)
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid MatOS asset history size for ${path}`)
  }
  return { path, sha256, sizeBytes }
}

export function validateMatOSAssetHistorySnapshotRecord(input: {
  cwd: string
  requestedSnapshotId?: string
  record: unknown
}): MatOSAssetHistorySnapshotRecord {
  const raw = objectValue(input.record)
  if (raw.schemaVersion !== 1) {
    throw new Error('Invalid MatOS asset history snapshot schemaVersion')
  }
  const snapshotId = typeof raw.snapshotId === 'string' ? raw.snapshotId : ''
  assertValidMatOSAssetHistorySnapshotId(snapshotId)
  if (input.requestedSnapshotId && snapshotId !== input.requestedSnapshotId) {
    throw new Error(
      `MatOS asset history snapshot id mismatch: expected ${input.requestedSnapshotId}, got ${snapshotId}`,
    )
  }
  const kind = raw.kind as MatOSAssetHistorySnapshotKind
  if (!SNAPSHOT_KINDS.has(kind)) {
    throw new Error(`Invalid MatOS asset history snapshot kind: ${String(raw.kind)}`)
  }
  const scope = raw.scope as MatOSAssetHistoryScope
  if (!SCOPES.has(scope)) {
    throw new Error(`Invalid MatOS asset history snapshot scope: ${String(raw.scope)}`)
  }
  assertSupportedMatOSAssetHistoryScope(scope)
  const scopeRef = stringValue(raw.scopeRef)
  if (scopeRef && !scopeRef.startsWith(`${scope}:`)) {
    throw new Error(
      `Invalid MatOS asset history scopeRef ${scopeRef} for scope ${scope}`,
    )
  }
  const commit = typeof raw.commit === 'string' ? raw.commit : ''
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`Invalid MatOS asset history commit for ${snapshotId}`)
  }
  const parentCommit =
    typeof raw.parentCommit === 'string' && /^[0-9a-f]{40,64}$/i.test(raw.parentCommit)
      ? raw.parentCommit
      : undefined
  if (raw.parentCommit !== undefined && !parentCommit) {
    throw new Error(`Invalid MatOS asset history parent commit for ${snapshotId}`)
  }
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : ''
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Invalid MatOS asset history createdAt for ${snapshotId}`)
  }
  if (!Array.isArray(raw.files)) {
    throw new Error(`Invalid MatOS asset history snapshot files array for ${snapshotId}`)
  }
  const files = raw.files.map(file =>
    validateFileRecord(input.cwd, scope, scopeRef, file),
  )
  return {
    schemaVersion: 1,
    snapshotId,
    kind,
    scope,
    ...(scopeRef ? { scopeRef } : {}),
    ...(raw.fullScope === true ? { fullScope: true } : {}),
    gitDir: typeof raw.gitDir === 'string' ? raw.gitDir : '.matos/asset-history/git',
    commit,
    ...(parentCommit ? { parentCommit } : {}),
    ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
    createdAt,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : resolve(input.cwd),
    assetRefs: stringArray(raw.assetRefs),
    files,
    ...(optionalRecord(raw.provenance) ? { provenance: optionalRecord(raw.provenance) } : {}),
  }
}

export function validateMatOSAssetHistoryReleaseRecord(input: {
  requestedReleaseId?: string
  record: unknown
}): MatOSAssetHistoryReleaseRecord {
  const raw = objectValue(input.record)
  if (raw.schemaVersion !== 1) {
    throw new Error('Invalid MatOS asset history release schemaVersion')
  }
  const releaseId = typeof raw.releaseId === 'string' ? raw.releaseId : ''
  assertValidMatOSAssetHistoryReleaseId(releaseId)
  if (input.requestedReleaseId && releaseId !== input.requestedReleaseId) {
    throw new Error(
      `MatOS asset history release id mismatch: expected ${input.requestedReleaseId}, got ${releaseId}`,
    )
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) {
    throw new Error(`Invalid MatOS asset history release name for ${releaseId}`)
  }
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : ''
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Invalid MatOS asset history release createdAt for ${releaseId}`)
  }
  const sourceRef = typeof raw.sourceRef === 'string' ? raw.sourceRef : ''
  if (
    !/^asset-snapshot-[A-Za-z0-9_-]+$/.test(sourceRef) &&
    !/^[0-9a-f]{40,64}$/i.test(sourceRef)
  ) {
    throw new Error(`Invalid MatOS asset history release sourceRef for ${releaseId}`)
  }
  const commit = typeof raw.commit === 'string' ? raw.commit : ''
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`Invalid MatOS asset history release commit for ${releaseId}`)
  }
  const previousStableCommit =
    typeof raw.previousStableCommit === 'string' &&
    /^[0-9a-f]{40,64}$/i.test(raw.previousStableCommit)
      ? raw.previousStableCommit
      : undefined
  if (raw.previousStableCommit !== undefined && !previousStableCommit) {
    throw new Error(
      `Invalid MatOS asset history release previous stable commit for ${releaseId}`,
    )
  }
  return {
    schemaVersion: 1,
    releaseId,
    name,
    createdAt,
    sourceRef,
    commit,
    ...(raw.validation && typeof raw.validation === 'object'
      ? { validation: raw.validation as MatOSAssetHistoryReleaseRecord['validation'] }
      : {}),
    ...(previousStableCommit ? { previousStableCommit } : {}),
    ...(optionalRecord(raw.provenance) ? { provenance: optionalRecord(raw.provenance) } : {}),
  }
}

export async function assertNoSymlinkPathComponent(input: {
  cwd: string
  absolutePath: string
  includeTarget?: boolean
  // Optional extra walk bases for paths that legitimately live outside the
  // cwd, such as a core pack root installed outside it. The
  // path must be inside the cwd or one of these roots.
  baseRoots?: string[]
}): Promise<void> {
  const cwd = resolve(input.cwd)
  const target = resolve(input.absolutePath)
  const bases = [cwd, ...(input.baseRoots ?? []).map(root => resolve(root))]
  const base = bases.find(candidate => {
    const rel = relative(candidate, target)
    return Boolean(rel) && !rel.startsWith('..') && !rel.startsWith(sep)
  })
  if (!base) {
    throw new Error(`MatOS asset history path is outside cwd: ${target}`)
  }
  const rel = relative(base, target)
  let current = base
  const parts = rel.split(/[\\/]/).filter(Boolean)
  const limit = input.includeTarget ? parts.length : Math.max(0, parts.length - 1)
  for (const part of parts.slice(0, limit)) {
    current = join(current, part)
    const info = await lstatOrMissing(current)
    if (!info) {
      return
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `Refusing to restore through symlink asset path: ${relative(base, current)}`,
      )
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function readdirOrMissing(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

async function lstatOrMissing(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

async function listCurrentFiles(
  toLogical: (fullPath: string) => string | undefined,
  dir: string,
): Promise<string[]> {
  const entries = await readdirOrMissing(dir)
  if (!entries) {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (shouldIgnoreMatOSAssetHistoryPath(fullPath)) {
      continue
    }
    const info = await lstatOrMissing(fullPath)
    if (!info) {
      continue
    }
    if (info.isDirectory()) {
      files.push(...(await listCurrentFiles(toLogical, fullPath)))
      continue
    }
    if (info.isSymbolicLink() || info.isFile()) {
      const logical = toLogical(fullPath)
      if (logical) {
        files.push(logical)
      }
    }
  }
  return files
}

export async function listCurrentMatOSAssetHistoryFiles(input: {
  cwd: string
  scope: MatOSAssetHistoryScope
  scopeRef?: string
}): Promise<string[]> {
  const cwd = resolve(input.cwd)
  const files: string[] = []
  const toLogical = (fullPath: string): string | undefined =>
    matOSAssetHistoryLogicalPath({
      cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      absolutePath: fullPath,
    })
  for (const root of matOSAssetHistoryAllowedRoots(
    cwd,
    input.scope,
    input.scopeRef,
  )) {
    if (!(await pathExists(root))) {
      continue
    }
    files.push(...(await listCurrentFiles(toLogical, root)))
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}
