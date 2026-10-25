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

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  matOSAssetMcpToolName,
  matOSToolReferenceToAssetId,
  normalizeMatOSToolName,
} from '../tools/toolNames.js'
import {
  MATOS_ASSET_DIRS,
  getMatOSDefaultAssetRoots,
  getMatOSBundledAssetHostRoot,
  getMatOSConfigPath,
  getMatOSDir,
  readMatOSProjectConfig,
  type MatOSAssetMountConfig,
  type MatOSAssetSourceConfig,
  type MatOSProjectConfig,
} from '../project.js'
import {
  resolveMatOSAssetSourceRootProvenance,
  type MatOSAssetSourceProvenance,
} from './sourceAdapters.js'
import { compareMatOSAssetStrings, toMatOSAssetKey } from './refs.js'
import { applyMatOSAssetLifecycle } from './lifecycle.js'
import { createBuiltinRuntimeAssets } from './builtinRuntimeAssets.js'
import {
  MATOS_ASSET_MOUNT_GROUPS,
  MATOS_ASSET_TYPES,
  type MatOSAsset,
  type MatOSAssetLifecycle,
  type MatOSAssetLifecycleStatus,
  type MatOSAssetManifest,
  type MatOSAssetMounts,
  type MatOSAssetType,
} from './types.js'
import { BUILTIN_TOOL_ASSETS } from './builtinToolAssets.js'

const MANIFEST_FILE_NAMES = new Set(['asset.json', 'matos.asset.json'])
const PACK_METADATA_FILE_NAME = 'matos.pack.json'
// Packs may lay out assets under plural legacy dirs (tools/, skills/, ...) or
// the canonical singular `<asset-type>/<asset-id>/` layout
// (tool/, skill/, workflow/, benchmark/, ...). Both must be discoverable, or
// generated draft packs (repo2asset/paper2asset, Failure2Asset) silently fail
// post-write validation for every non-knowledge asset type.
const PACK_ASSET_DIR_NAMES = new Set([
  ...MATOS_ASSET_DIRS,
  ...MATOS_ASSET_TYPES,
  'benchmark-suites',
])
const ALWAYS_SKIPPED_ASSET_DISCOVERY_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.locks',
  '.runtime-snapshots',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
])
const LEGACY_SKILL_FILE_NAME = 'SKILL.md'
const LEGACY_ROLES_FILE_NAME = 'roles.json'
const LEGACY_TOOL_MANIFEST_FILE_NAME = 'matos.tool.json'
const GENERATED_EXPERIENCE_ASSET_ROOTS = [
  'assets/generated/evolution/experiences',
  'assets/generated/scopes',
] as const
const GENERATED_EVIDENCE_ASSET_TYPES = new Set(['experience'])
const GENERATED_SCOPED_TARGET_ASSET_ROOT = 'assets/generated/scopes'
const GENERATED_SCOPED_TARGET_ASSET_TYPES = new Set([
  'data',
  'knowledge',
  'mcp',
  'role',
  'skill',
  'tool',
  'workflow',
])
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/
const LIFECYCLE_STATUSES = new Set<MatOSAssetLifecycleStatus>([
  'enabled',
  'disabled',
  'deprecated',
  'draft',
])

type AssetPackMetadata = {
  id?: string
  name?: string
  version?: string
  metadata?: Record<string, unknown>
}

// Module-level cache keyed by pack root; a long-lived process (workbench
// service, daemon) reloads assets many times, so entries are fingerprinted by
// the manifest's stat identity instead of being cached forever — a pack whose
// matos.pack.json was edited, republished, or re-materialized must not keep
// serving stale id/name/version metadata.
const packMetadataCache = new Map<
  string,
  { fingerprint: string; value: Promise<AssetPackMetadata> }
>()

type NormalizeOptions = {
  source: MatOSAsset['source']
  sourcePath: string
  pack?: AssetPackMetadata
  rawFilePath?: string
  sourceProvenance?: MatOSAssetSourceProvenance
}

type ManifestReadContext = {
  rootIsPack: boolean
  packs: Map<string, Promise<AssetPackMetadata>>
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isIgnorableAssetFilesystemError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return ['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM'].includes(
    String(error.code),
  )
}

function assetLoadProfile(label: string, startedAt: number): void {
  if (process.env.MATOS_ASSET_LOAD_PROFILE !== '1') {
    return
  }
  const elapsedMs = Math.round(performance.now() - startedAt)
  process.stderr.write(`[matos-assets] ${label}: ${elapsedMs}ms\n`)
}

function shouldSkipAssetDiscoveryDir(name: string): boolean {
  return ALWAYS_SKIPPED_ASSET_DISCOVERY_DIR_NAMES.has(name)
}

async function readAssetDirIfAccessible(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isIgnorableAssetFilesystemError(error)) {
      return []
    }
    throw error
  }
}

async function findManifestFiles(dir: string, types?: ReadonlySet<string>, exclude?: (path: string) => boolean): Promise<string[]> {
  if (exclude?.(dir)) return []
  const entries = await readAssetDirIfAccessible(dir)
  const isPackRoot = entries.some(
    entry => entry.isFile() && entry.name === PACK_METADATA_FILE_NAME,
  )
  const localManifestFiles = entries
    .filter(entry => entry.isFile() && MANIFEST_FILE_NAMES.has(entry.name))
    .map(entry => join(dir, entry.name))

  const files: string[] = []
  const childScans: Array<Promise<string[]>> = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      childScans.push((async () => {
        if (shouldSkipAssetDiscoveryDir(entry.name)) {
          return []
        }
        if (isPackRoot && !PACK_ASSET_DIR_NAMES.has(entry.name)) {
          return []
        }
        // Only declared pack layouts have type directories. Arbitrary local
        // roots must still be discovered by manifest, not guessed by path.
        if (isPackRoot && types && entry.name !== 'packs') {
          const type = entry.name.endsWith('s') ? entry.name.slice(0, -1) : entry.name
          if (!types.has(type)) return []
        }
        if (localManifestFiles.length > 0) {
          const childEntries = await readAssetDirIfAccessible(fullPath)
          const childHasManifest = childEntries.some(
            childEntry =>
              childEntry.isFile() && MANIFEST_FILE_NAMES.has(childEntry.name),
          )
          if (!childHasManifest) {
            return []
          }
        }
        return findManifestFiles(fullPath, types, exclude)
      })())
    }
  }
  for (const childFiles of await Promise.all(childScans)) {
    files.push(...childFiles)
  }

  return [...localManifestFiles, ...files]
}

async function findFilesByName(dir: string, fileName: string, exclude?: (path: string) => boolean): Promise<string[]> {
  if (exclude?.(dir)) return []
  if (!(await pathExists(dir))) {
    return []
  }

  const entries = await readAssetDirIfAccessible(dir)
  if (entries.some(entry => entry.isFile() && entry.name === PACK_METADATA_FILE_NAME)) {
    return []
  }
  const localHasNativeManifest = entries.some(
    entry => entry.isFile() && MANIFEST_FILE_NAMES.has(entry.name),
  )
  const files: string[] = []
  const childScans: Array<Promise<string[]>> = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      childScans.push((async () => {
        if (shouldSkipAssetDiscoveryDir(entry.name)) {
          return []
        }
        if (entry.name === 'packs') {
          return []
        }
        if (localHasNativeManifest) {
          const childEntries = await readAssetDirIfAccessible(fullPath)
          const childHasNativeManifest = childEntries.some(
            childEntry =>
              childEntry.isFile() && MANIFEST_FILE_NAMES.has(childEntry.name),
          )
          if (!childHasNativeManifest) {
            return []
          }
        }
        return findFilesByName(fullPath, fileName, exclude)
      })())
    } else if (entry.isFile() && entry.name === fileName) {
      files.push(fullPath)
    }
  }
  for (const childFiles of await Promise.all(childScans)) {
    files.push(...childFiles)
  }

  return files
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  }
  return []
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function parseMarkdownFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(FRONTMATTER_REGEX)
  if (!match) {
    return {}
  }

  try {
    return metadataObject(parseYaml(match[1] ?? ''))
  } catch {
    return {}
  }
}

function permissionsValue(value: unknown): string[] | Record<string, unknown> {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  return metadataObject(value)
}

function normalizeMounts(value: unknown): MatOSAssetMounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const raw = value as Record<string, unknown>
  const mounts: MatOSAssetMounts = {}
  for (const group of MATOS_ASSET_MOUNT_GROUPS) {
    const refs = stringArray(raw[group])
    if (refs.length > 0) {
      mounts[group] = refs
    }
  }

  return mounts
}

function normalizeLifecycle(manifest: MatOSAssetManifest): MatOSAssetLifecycle {
  const lifecycle = metadataObject(manifest.lifecycle)
  const explicitStatus = optionalString(lifecycle.status)
  if (
    explicitStatus &&
    LIFECYCLE_STATUSES.has(explicitStatus as MatOSAssetLifecycleStatus)
  ) {
    return {
      status: explicitStatus as MatOSAssetLifecycleStatus,
      ...(optionalString(lifecycle.reason)
        ? { reason: optionalString(lifecycle.reason) }
        : {}),
      ...(optionalString(lifecycle.updatedAt)
        ? { updatedAt: optionalString(lifecycle.updatedAt) }
        : {}),
      ...(optionalString(lifecycle.origin)
        ? { origin: optionalString(lifecycle.origin) }
        : {}),
    }
  }

  const tags = stringArray(manifest.tags)
  const metadata = metadataObject(manifest.metadata)
  const metadataLifecycle = optionalString(metadata.lifecycle)
  const sourceFormat = optionalString(metadata.sourceFormat)
  const generatedLearningDraft =
    tags.includes('generated') &&
    tags.includes('learning') &&
    (tags.includes('draft') ||
      metadataLifecycle === 'draft' ||
      sourceFormat === 'matos-learning-draft' ||
      sourceFormat === 'matos-learning-evaluation' ||
      sourceFormat === 'matos-evolution-role-draft' ||
      sourceFormat === 'matos-evolution-gates')

  return { status: generatedLearningDraft ? 'draft' : 'enabled' }
}

function normalizeAsset(
  manifest: MatOSAssetManifest,
  manifestPath: string,
  options: NormalizeOptions,
): MatOSAsset {
  const manifestDir = options.rawFilePath
    ? dirname(options.rawFilePath)
    : dirname(manifestPath)
  const relativePath = options.rawFilePath
    ? basename(options.rawFilePath)
    : typeof manifest.path === 'string'
      ? manifest.path
      : '.'
  const entryRelativePath =
    typeof manifest.entry === 'string'
      ? manifest.entry
      : options.rawFilePath
        ? basename(options.rawFilePath)
        : undefined
  const type = typeof manifest.type === 'string' ? manifest.type : ''
  const id = typeof manifest.id === 'string' ? manifest.id : ''
  const version =
    typeof manifest.version === 'string' ? manifest.version : undefined
  const overlayOf = optionalString(manifest.overlayOf)

  return {
    id,
    type,
    name: typeof manifest.name === 'string' ? manifest.name : '',
    version,
    description:
      typeof manifest.description === 'string' ? manifest.description : undefined,
    canonicalKey:
      type && id && version ? toMatOSAssetKey(type, id, version) : '',
    relativePath,
    absolutePath: options.rawFilePath
      ? resolve(options.rawFilePath)
      : resolve(manifestDir, relativePath),
    entryRelativePath,
    entryAbsolutePath: entryRelativePath
      ? resolve(manifestDir, entryRelativePath)
      : undefined,
    manifestPath,
    manifestDir,
    source: options.source,
    sourcePath: options.sourcePath,
    packId: options.pack?.id,
    packName: options.pack?.name,
    packVersion: options.pack?.version,
    tags: stringArray(manifest.tags),
    permissions: permissionsValue(manifest.permissions),
    dependencies: stringArray(manifest.dependencies),
    mounts: normalizeMounts(manifest.mounts),
    runtime: metadataObject(manifest.runtime),
    lifecycle: normalizeLifecycle(manifest),
    metadata: {
      ...metadataObject(manifest.metadata),
      ...(overlayOf ? { overlayOf } : {}),
      ...(options.sourceProvenance
        ? { sourceProvenance: options.sourceProvenance }
        : {}),
    },
  }
}

function manifestLoadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function brokenManifestAsset(
  manifestPath: string,
  error: unknown,
  options: NormalizeOptions,
): MatOSAsset {
  const manifestDir = dirname(manifestPath)
  return {
    id: '',
    type: '',
    name: '',
    version: undefined,
    description: undefined,
    canonicalKey: '',
    relativePath: '.',
    absolutePath: manifestDir,
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath,
    manifestDir,
    source: options.source,
    sourcePath: options.sourcePath,
    packId: options.pack?.id,
    packName: options.pack?.name,
    packVersion: options.pack?.version,
    tags: [],
    permissions: {},
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: {
      sourceFormat: 'matos-broken-asset-manifest',
      loadError: manifestLoadErrorMessage(error),
      ...(options.sourceProvenance
        ? { sourceProvenance: options.sourceProvenance }
        : {}),
    },
  }
}

// A standalone project lists only its own source, while the user's assets live
// in the standalone workspace's user source. Load that source too, at the
// workspace's current accepted commit, so every project sees adopted and
// published user assets and follows their accepted updates. The project's
// own configuration is not changed.
async function standaloneWorkspaceUserSources(
  cwd: string,
  parsed: MatOSProjectConfig,
): Promise<MatOSAssetSourceConfig[]> {
  const workspace = process.env.MATOS_STANDALONE_WORKSPACE?.trim()
  if (!parsed.standalone || !workspace || resolve(workspace) === resolve(cwd)) {
    return []
  }
  let workspaceConfig: MatOSProjectConfig
  try {
    workspaceConfig = await readMatOSProjectConfig(workspace)
  } catch {
    return []
  }
  const known = new Set((parsed.assetSources ?? []).map(source => source.id))
  return (workspaceConfig.assetSources ?? []).flatMap(source =>
    source.type === 'git' && source.scope === 'user' && !known.has(source.id)
      ? [{
          ...source,
          repo: source.repo.startsWith('./') || source.repo.startsWith('../')
            ? resolve(workspace, source.repo)
            : source.repo,
        }]
      : [],
  )
}

async function readProjectConfig(cwd: string, strict = false): Promise<MatOSProjectConfig> {
  const parsed = await readMatOSProjectConfig(cwd, { strict })
  const workspaceUserSources = await standaloneWorkspaceUserSources(cwd, parsed)
  const defaultAssetRoots =
    parsed.includeDefaultAssetRoots !== false
      ? getMatOSDefaultAssetRoots()
      : []
  // Resolve bundled assets from this installation, not a saved host path.
  const bundledRoot = parsed.standalone ? getMatOSBundledAssetHostRoot() : undefined
  const configuredRoots = [...defaultAssetRoots, ...parsed.assetRoots, ...(bundledRoot ? [bundledRoot] : [])]
  const missingGeneratedExperienceRoots = GENERATED_EXPERIENCE_ASSET_ROOTS.filter(
    generatedRoot => {
      const generatedExperienceRoot = resolveAssetRoot(cwd, generatedRoot)
      return !configuredRoots.some(root => {
        const assetRoot = resolveAssetRoot(cwd, root)
        const relativePath = relative(assetRoot, generatedExperienceRoot)
        return (
          relativePath === '' ||
          (!relativePath.startsWith('..') && !isAbsolute(relativePath))
        )
      })
    },
  )
  return {
    ...parsed,
    assetRoots: [
      ...new Set([
        ...configuredRoots,
        ...missingGeneratedExperienceRoots,
      ]),
    ],
    assetMounts: parsed.assetMounts ?? [],
    ...(workspaceUserSources.length > 0
      ? { assetSources: [...(parsed.assetSources ?? []), ...workspaceUserSources] }
      : {}),
  }
}

function resolveAssetRoot(cwd: string, assetRoot: string): string {
  if (isAbsolute(assetRoot)) {
    return assetRoot
  }
  return resolve(getMatOSDir(cwd), assetRoot)
}

function pathContains(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child))
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

function isGeneratedEvidenceAssetRoot(cwd: string, assetRoot: string): boolean {
  const resolvedRoot = resolve(assetRoot)
  return GENERATED_EXPERIENCE_ASSET_ROOTS.some(generatedRoot =>
    pathContains(resolveAssetRoot(cwd, generatedRoot), resolvedRoot),
  )
}

function isGeneratedEvidenceAssetPath(cwd: string, assetPath: string): boolean {
  const resolvedPath = resolve(assetPath)
  return GENERATED_EXPERIENCE_ASSET_ROOTS.some(generatedRoot =>
    pathContains(resolveAssetRoot(cwd, generatedRoot), resolvedPath),
  )
}

function isGeneratedScopedTargetAssetPath(cwd: string, assetPath: string): boolean {
  return pathContains(
    resolveAssetRoot(cwd, GENERATED_SCOPED_TARGET_ASSET_ROOT),
    resolve(assetPath),
  )
}

/** Unpublished legacy critic/refiner history, not accepted scoped assets. */
function isLegacyEvolutionEvidencePath(cwd: string, path: string): boolean {
  const local = relative(resolveAssetRoot(cwd, 'assets/generated'), resolve(path)).replaceAll('\\', '/')
  return local === 'evolution' || local.startsWith('evolution/') ||
    /^scopes\/(?:users|teams|projects)\/[^/]+\/evolution(?:\/|$)/.test(local)
}

function shouldIncludeGeneratedEvidenceAsset(asset: MatOSAsset): boolean {
  return GENERATED_EVIDENCE_ASSET_TYPES.has(asset.type)
}

function shouldIncludeGeneratedScopedTargetAsset(asset: MatOSAsset): boolean {
  return (
    GENERATED_SCOPED_TARGET_ASSET_TYPES.has(asset.type) &&
    typeof asset.metadata.scopeRef === 'string' &&
    asset.metadata.scopeRef.trim().length > 0
  )
}

function assetRootSource(cwd: string, assetRoot: string, sourceProvenance?: MatOSAssetSourceProvenance): MatOSAsset['source'] {
  if (sourceProvenance) {
    return 'pack'
  }
  const rel = relative(resolve(getMatOSDir(cwd)), resolve(assetRoot))
  return rel === '' || (Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel))
    ? 'project'
    : 'pack'
}

async function readPackMetadata(packRoot: string): Promise<AssetPackMetadata> {
  const cacheKey = resolve(packRoot)
  const manifestInfo = await stat(join(cacheKey, PACK_METADATA_FILE_NAME)).catch(
    () => undefined,
  )
  const fingerprint = manifestInfo
    ? `${manifestInfo.ino}:${manifestInfo.size}:${manifestInfo.mtimeMs}`
    : 'missing'
  const cached = packMetadataCache.get(cacheKey)
  if (cached && cached.fingerprint === fingerprint) {
    return cached.value
  }
  const value = readPackMetadataUncached(packRoot)
  packMetadataCache.set(cacheKey, { fingerprint, value })
  return value
}

async function readPackMetadataUncached(packRoot: string): Promise<AssetPackMetadata> {
  try {
    const raw = await readFile(join(packRoot, 'matos.pack.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      id: typeof parsed.id === 'string' ? parsed.id : basename(packRoot),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      metadata:
        parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
          ? (parsed.metadata as Record<string, unknown>)
          : undefined,
    }
  } catch {
    return { id: basename(packRoot) }
  }
}

function isProjectLocalPack(pack?: AssetPackMetadata): boolean {
  const sourceFormat =
    pack?.metadata && typeof pack.metadata.sourceFormat === 'string'
      ? pack.metadata.sourceFormat
      : undefined
  return (
    pack?.id === 'data-center-pins' ||
    sourceFormat === 'matos-typed-asset-library-pack' ||
    sourceFormat === 'matos-marketplace-duplicate-pack' ||
    sourceFormat === 'matos-external-intake-draft-pack' ||
    sourceFormat === 'matos-external-intake-pack' ||
    sourceFormat === 'matos-registered-data-pack'
  )
}

function findPackRoot(assetRoot: string, manifestPath: string, rootIsPack = existsSync(join(assetRoot, 'matos.pack.json'))): string | undefined {
  if (rootIsPack) {
    const relativePath = relative(assetRoot, manifestPath)
    if (
      relativePath === '' ||
      (!relativePath.startsWith('..') && !isAbsolute(relativePath))
    ) {
      return assetRoot
    }
  }
  const relativePath = relative(assetRoot, manifestPath)
  const parts = relativePath.split(/[\\/]/)
  if (parts[0] !== 'packs' || !parts[1]) {
    return undefined
  }
  return join(assetRoot, 'packs', parts[1])
}

async function normalizeManifestFile(
  assetRoot: string,
  manifestPath: string,
  rootSource: MatOSAsset['source'] = 'project',
  sourceProvenance?: MatOSAssetSourceProvenance,
  types?: ReadonlySet<string>,
  context?: ManifestReadContext,
): Promise<MatOSAsset | undefined> {
  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as MatOSAssetManifest
  if (types && !types.has(String(manifest.type))) return undefined
  const packRoot = findPackRoot(assetRoot, manifestPath, context?.rootIsPack)
  let pack: AssetPackMetadata | undefined
  if (packRoot) {
    let read = context?.packs.get(packRoot)
    if (!read) {
      read = readPackMetadata(packRoot)
      context?.packs.set(packRoot, read)
    }
    pack = await read
  }
  const source = pack
    ? rootSource === 'project' && isProjectLocalPack(pack)
      ? 'project'
      : 'pack'
    : 'project'
  return normalizeAsset(manifest, manifestPath, {
    source,
    sourcePath: packRoot ?? manifestPath,
    pack,
    sourceProvenance,
  })
}

function relativeId(assetRoot: string, dir: string): string {
  const raw = relative(assetRoot, dir).replace(/\\/g, '/')
  return raw && raw !== '.' ? raw : basename(dir)
}

async function hasNativeManifest(dir: string): Promise<boolean> {
  for (const fileName of MANIFEST_FILE_NAMES) {
    if (await pathExists(join(dir, fileName))) {
      return true
    }
  }
  return false
}

function extractLegacyToolReferences(markdown: string): string[] {
  const references = new Set<string>()
  for (const match of markdown.matchAll(/\bmatos_tool__([a-zA-Z0-9_]+)/g)) {
    const rawName = match[0]
    if (markdown[(match.index ?? 0) + rawName.length] === '*') {
      continue
    }
    references.add(`tool:${matOSToolReferenceToAssetId(rawName)}`)
  }
  return [...references].sort()
}

async function normalizeLegacySkillFile(
  assetRoot: string,
  skillPath: string,
  sourceProvenance?: MatOSAssetSourceProvenance,
): Promise<MatOSAsset | undefined> {
  const skillDir = dirname(skillPath)
  if (await hasNativeManifest(skillDir)) {
    return undefined
  }

  const raw = await readFile(skillPath, 'utf8')
  const frontmatter = parseMarkdownFrontmatter(raw)
  const id = relativeId(assetRoot, skillDir)
  const frontmatterRecord = metadataObject(frontmatter)
  const frontmatterName = optionalString(frontmatterRecord.name)
  const tags = stringList(frontmatterRecord.tags)
  const manifest: MatOSAssetManifest = {
    id,
    type: 'skill',
    name: frontmatterName ?? id,
    version: optionalString(frontmatterRecord.version) ?? '1.0.0',
    description: optionalString(frontmatterRecord.description),
    path: '.',
    entry: LEGACY_SKILL_FILE_NAME,
    tags,
    metadata: {
      sourceFormat: 'matos-skill-md',
      frontmatterName,
      toolReferences: extractLegacyToolReferences(raw),
    },
  }

  return normalizeAsset(manifest, skillPath, {
    source: 'project',
    sourcePath: assetRoot,
    sourceProvenance,
  })
}

async function discoverTopLevelSkillIds(assetRoot: string): Promise<string[]> {
  if (!(await pathExists(assetRoot))) {
    return []
  }

  const entries = await readAssetDirIfAccessible(assetRoot)
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const skillPath = join(assetRoot, entry.name, LEGACY_SKILL_FILE_NAME)
    if (await pathExists(skillPath)) {
      ids.push(entry.name)
    }
  }
  return ids.sort()
}

function normalizeLegacyRoleSkills(
  value: unknown,
  excluded: string[],
  topLevelSkillIds: string[],
): string[] {
  const excludeSet = new Set(excluded)
  const skills = stringList(value)
  const selected = skills.includes('*') ? topLevelSkillIds : skills
  return selected
    .filter(skill => !excludeSet.has(skill))
    .map(skill => `skill:${skill}`)
}

function normalizeLegacyToolAssetRefs(role: Record<string, unknown>): string[] {
  const tools = metadataObject(role.tools)
  return stringList(tools.tool_assets).map(toolAsset => `tool:${toolAsset}`)
}

async function normalizeLegacyRolesFile(
  assetRoot: string,
  rolesPath: string,
  sourceProvenance?: MatOSAssetSourceProvenance,
): Promise<MatOSAsset[]> {
  const raw = await readFile(rolesPath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const roles = metadataObject(parsed.roles)
  const topLevelSkillIds = await discoverTopLevelSkillIds(assetRoot)
  const assets: MatOSAsset[] = []

  for (const [id, value] of Object.entries(roles).sort((a, b) =>
    compareMatOSAssetStrings(a[0], b[0]),
  )) {
    const role = metadataObject(value)
    const roleDir = join(assetRoot, id)
    const instructions = optionalString(role.instructions)
    const entry =
      instructions && (await pathExists(join(roleDir, instructions)))
        ? join(id, instructions)
        : undefined
    const excluded = stringList(role.exclude)
    const manifest: MatOSAssetManifest = {
      id,
      type: 'role',
      name: optionalString(role.label) ?? id,
      version: optionalString(role.version) ?? '1.0.0',
      description: optionalString(role.description),
      path: (await pathExists(roleDir)) ? id : '.',
      entry,
      mounts: {
        skills: normalizeLegacyRoleSkills(
          role.skills,
          excluded,
          topLevelSkillIds,
        ),
        tools: normalizeLegacyToolAssetRefs(role),
      },
      metadata: {
        sourceFormat: 'matos-roles-json',
        aliases: stringList(role.aliases),
        excludedSkills: excluded,
        skillSelector: stringList(role.skills).includes('*') ? '*' : undefined,
      },
    }
    assets.push(
      normalizeAsset(manifest, rolesPath, {
        source: 'project',
        sourcePath: rolesPath,
        sourceProvenance,
      }),
    )
  }

  const referencedToolAssets = new Set(
    assets.flatMap(asset => asset.mounts.tools ?? []),
  )
  for (const toolAsset of BUILTIN_TOOL_ASSETS) {
    if (!referencedToolAssets.has(`tool:${toolAsset.id}`)) {
      continue
    }
    const manifest: MatOSAssetManifest = {
      id: toolAsset.id,
      type: 'tool',
      name: toolAsset.label,
      version: '1.0.0',
      description: toolAsset.description,
      path: '.',
      metadata: {
        kind: 'builtin-pack',
        builtinTools: toolAsset.builtinTools,
        mcpServers: toolAsset.mcpServers,
        sourceFormat: 'matos-builtin-tool-pack',
      },
    }
    assets.push(
      normalizeAsset(manifest, rolesPath, {
        source: 'project',
        sourcePath: rolesPath,
        sourceProvenance,
      }),
    )
  }

  return assets
}

async function normalizeLegacyToolManifestFile(
  assetRoot: string,
  manifestPath: string,
  sourceProvenance?: MatOSAssetSourceProvenance,
): Promise<MatOSAsset | undefined> {
  const toolDir = dirname(manifestPath)
  if (await hasNativeManifest(toolDir)) {
    return undefined
  }

  const raw = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const impl = metadataObject(parsed.impl)
  const id = optionalString(parsed.id) ?? basename(toolDir)
  const entry = optionalString(impl.entry)
  const promptPath = optionalString(parsed.prompt)
  const inputSchemaPath = optionalString(parsed.inputSchema)
  const mcpName = normalizeMatOSToolName(id)
  const manifest: MatOSAssetManifest = {
    id,
    type: 'tool',
    name: optionalString(parsed.label) ?? id,
    version: optionalString(parsed.version) ?? '1.0.0',
    description: optionalString(parsed.description),
    path: '.',
    entry,
    tags: stringList(parsed.categories),
    permissions: parsed.permissions,
    metadata: {
      kind: 'external-tool',
      sourceFormat: 'matos-tool-manifest',
      binding: matOSAssetMcpToolName(id),
      promptPath,
      inputSchemaPath,
      isReadOnly: parsed.isReadOnly === true,
      isDestructive: parsed.isDestructive === true,
      executor: {
        type: impl.type === 'python' ? 'matos-python' : optionalString(impl.type),
        runtime: optionalString(impl.runtime) ?? 'python3',
        entry,
        timeoutMs:
          typeof impl.timeoutMs === 'number' && Number.isFinite(impl.timeoutMs)
            ? impl.timeoutMs
            : undefined,
        toolDir,
        mcpName,
      },
    },
  }

  return normalizeAsset(manifest, manifestPath, {
    source: 'project',
    sourcePath: assetRoot,
    sourceProvenance,
  })
}

async function loadMountedAsset(
  cwd: string,
  mount: MatOSAssetMountConfig,
): Promise<MatOSAsset | undefined> {
  const mountPath = resolve(cwd, mount.path)
  const mountStat = await stat(mountPath).catch(() => undefined)
  if (!mountStat) {
    const manifest: MatOSAssetManifest = {
      id: mount.id,
      type: mount.type,
      name: mount.name,
      version: mount.version,
      description: mount.description,
      path: mountPath,
      tags: mount.tags,
      dependencies: mount.dependencies,
      metadata: mount.metadata,
    }
    return normalizeAsset(manifest, getMatOSConfigPath(cwd), {
      source: 'mount',
      sourcePath: mountPath,
      rawFilePath: mountPath,
    })
  }

  if (mountStat.isDirectory()) {
    for (const manifestFileName of MANIFEST_FILE_NAMES) {
      const manifestPath = join(mountPath, manifestFileName)
      if (!(await pathExists(manifestPath))) {
        continue
      }
      const raw = await readFile(manifestPath, 'utf8')
      return normalizeAsset(JSON.parse(raw) as MatOSAssetManifest, manifestPath, {
        source: 'mount',
        sourcePath: mountPath,
      })
    }

    // A mounted directory without a native manifest is described by the
    // mount config itself, like mounted plain data/knowledge directories.
    const manifest: MatOSAssetManifest = {
      id: mount.id,
      type: mount.type,
      name: mount.name,
      version: mount.version,
      description: mount.description,
      path: mountPath,
      tags: mount.tags,
      dependencies: mount.dependencies,
      metadata: mount.metadata,
    }
    return normalizeAsset(manifest, getMatOSConfigPath(cwd), {
      source: 'mount',
      sourcePath: mountPath,
      rawFilePath: mountPath,
    })
  }

  if (MANIFEST_FILE_NAMES.has(basename(mountPath))) {
    const raw = await readFile(mountPath, 'utf8')
    return normalizeAsset(JSON.parse(raw) as MatOSAssetManifest, mountPath, {
      source: 'mount',
      sourcePath: mountPath,
    })
  }

  const manifest: MatOSAssetManifest = {
    id: mount.id,
    type: mount.type,
    name: mount.name,
    version: mount.version,
    description: mount.description,
    entry: basename(mountPath),
    tags: mount.tags,
    dependencies: mount.dependencies,
    metadata: mount.metadata,
  }
  return normalizeAsset(manifest, getMatOSConfigPath(cwd), {
    source: 'mount',
    sourcePath: mountPath,
    rawFilePath: mountPath,
  })
}

// Focused single-root loader for host-side maintenance paths such as the
// per-user editable-core dependency-closure sync. It deliberately skips
// project config, source provenance, config mounts, and generated-evidence
// filtering: callers only need normalized manifests plus registry resolution
// semantics for one directory tree. Broken manifests are skipped because they
// cannot contribute usable references.
export async function loadMatOSAssetsFromRoot(
  assetRoot: string,
  options: { strict?: boolean } = {},
): Promise<MatOSAsset[]> {
  if (options.strict && !(await stat(assetRoot)).isDirectory()) throw new Error("Asset root is not a directory: " + assetRoot)
  const manifestFiles = await findManifestFiles(assetRoot)
  const assets: MatOSAsset[] = []
  for (const manifestPath of manifestFiles.sort()) {
    try {
      const asset = await normalizeManifestFile(assetRoot, manifestPath, 'pack')
      if (asset) assets.push(asset)
      else if (options.strict) throw new Error("Invalid asset manifest")
    } catch {
      if (options.strict) throw new Error("Cannot load asset manifest: " + manifestPath)
      continue
    }
  }
  return assets
}

/** User-facing readers share the native accepted-snapshot path. Editors keep
 * using loadMatOSAssets explicitly to validate their unpublished working tree. */
export async function loadMatOSRuntimeAssets(
  cwd: string,
  options: { followAcceptedUpdates?: boolean; types?: readonly MatOSAssetType[]; excludeEvolutionEvidence?: boolean } = {},
): Promise<MatOSAsset[]> {
  const { readMatOSProjectMetadata } = await import('../projectMetadata.js')
  const metadata = await readMatOSProjectMetadata(cwd, { allowMissing: true })
  return loadMatOSAssets(cwd, {
    runtimeSnapshot: true,
    followAcceptedUpdates: options.followAcceptedUpdates ?? metadata.assetVersionPolicy !== 'pinned',
    types: options.types,
    excludeEvolutionEvidence: options.excludeEvolutionEvidence,
  })
}

export async function loadMatOSAssets(
  cwd: string,
  options: { runtimeSnapshot?: boolean; followAcceptedUpdates?: boolean; types?: readonly MatOSAssetType[]; excludeEvolutionEvidence?: boolean } = {},
): Promise<MatOSAsset[]> {
  const types = options.types ? new Set(options.types) : undefined
  const exclude = options.excludeEvolutionEvidence ? (path: string) => isLegacyEvolutionEvidencePath(cwd, path) : undefined
  const loadStartedAt = performance.now()
  const config = await readProjectConfig(cwd, options.runtimeSnapshot === true)
  assetLoadProfile('readProjectConfig', loadStartedAt)
  const assets: MatOSAsset[] = []
  const generatedScopedTargetCandidates: MatOSAsset[] = []
  const sourceStartedAt = performance.now()
  const sourceRootProvenance = await resolveMatOSAssetSourceRootProvenance(
    cwd,
    config,
    options,
  )
  assetLoadProfile('resolveSourceProvenance', sourceStartedAt)
  const assetRoots = [
    ...new Set([
      ...config.assetRoots,
      ...sourceRootProvenance.keys(),
    ]),
  ]

  for (const assetRootConfig of assetRoots) {
    const rootStartedAt = performance.now()
    const assetRoot = resolveAssetRoot(cwd, assetRootConfig)
    const sourceProvenance = sourceRootProvenance.get(resolve(assetRoot))
    const source = assetRootSource(cwd, assetRoot, sourceProvenance)
    const generatedEvidenceRoot = isGeneratedEvidenceAssetRoot(cwd, assetRoot)
    // A load observes one pack-metadata generation; do not stat it again for
    // every member, especially on per-user network-backed workspace mounts.
    const manifestContext: ManifestReadContext = {
      rootIsPack: await pathExists(join(assetRoot, PACK_METADATA_FILE_NAME)),
      packs: new Map(),
    }
    const manifestStartedAt = performance.now()
    const manifestFiles = await findManifestFiles(assetRoot, types, exclude)
    assetLoadProfile(
      `findManifestFiles ${assetRoot} count=${manifestFiles.length}`,
      manifestStartedAt,
    )
    const normalizeManifestStartedAt = performance.now()
    const manifestResults = await Promise.all(manifestFiles.sort().map(async manifestPath => {
      const generatedEvidenceManifest =
        generatedEvidenceRoot || isGeneratedEvidenceAssetPath(cwd, manifestPath)
      try {
        const asset = await normalizeManifestFile(
          assetRoot,
          manifestPath,
          source,
          sourceProvenance,
          types,
          manifestContext,
        )
        if (!asset) return { assets: [], generatedScopedTargetCandidates: [] }
        if (
          !generatedEvidenceManifest ||
          shouldIncludeGeneratedEvidenceAsset(asset)
        ) {
          return { assets: [asset], generatedScopedTargetCandidates: [] }
        } else if (
          isGeneratedScopedTargetAssetPath(cwd, manifestPath) &&
          shouldIncludeGeneratedScopedTargetAsset(asset)
        ) {
          return { assets: [], generatedScopedTargetCandidates: [asset] }
        }
        return { assets: [], generatedScopedTargetCandidates: [] }
      } catch (error) {
        if (isIgnorableAssetFilesystemError(error)) {
          return { assets: [], generatedScopedTargetCandidates: [] }
        }
        if (generatedEvidenceManifest) {
          return { assets: [], generatedScopedTargetCandidates: [] }
        }
        const packRoot = findPackRoot(assetRoot, manifestPath, manifestContext.rootIsPack)
        const pack = packRoot ? await readPackMetadata(packRoot) : undefined
        return {
          assets: [brokenManifestAsset(manifestPath, error, {
            source: pack
              ? source === 'project' && isProjectLocalPack(pack)
                ? 'project'
                : 'pack'
              : 'project',
            sourcePath: packRoot ?? manifestPath,
            pack,
            sourceProvenance,
          })],
          generatedScopedTargetCandidates: [],
        }
      }
    }))
    for (const result of manifestResults) {
      assets.push(...result.assets)
      generatedScopedTargetCandidates.push(...result.generatedScopedTargetCandidates)
    }
    assetLoadProfile(
      `normalizeManifestFiles ${assetRoot} count=${manifestFiles.length}`,
      normalizeManifestStartedAt,
    )

    if (generatedEvidenceRoot) {
      continue
    }

    const legacySkillsStartedAt = performance.now()
    const skillFiles = !types || types.has('skill') ? await findFilesByName(assetRoot, LEGACY_SKILL_FILE_NAME, exclude) : []
    assetLoadProfile(
      `findLegacySkills ${assetRoot} count=${skillFiles.length}`,
      legacySkillsStartedAt,
    )
    for (const skillPath of skillFiles.sort()) {
      if (isGeneratedEvidenceAssetPath(cwd, skillPath)) {
        continue
      }
      try {
        const asset = await normalizeLegacySkillFile(
          assetRoot,
          skillPath,
          sourceProvenance,
        )
        if (asset) {
          assets.push(asset)
        }
      } catch (error) {
        if (isIgnorableAssetFilesystemError(error)) {
          continue
        }
        assets.push(
          brokenManifestAsset(skillPath, error, {
            source: 'project',
            sourcePath: assetRoot,
            sourceProvenance,
          }),
        )
      }
    }

    const legacyRolesStartedAt = performance.now()
    const rolesFiles = !types || types.has('role') || types.has('tool')
      ? await findFilesByName(assetRoot, LEGACY_ROLES_FILE_NAME, exclude) : []
    assetLoadProfile(
      `findLegacyRoles ${assetRoot} count=${rolesFiles.length}`,
      legacyRolesStartedAt,
    )
    for (const rolesPath of rolesFiles.sort()) {
      if (isGeneratedEvidenceAssetPath(cwd, rolesPath)) {
        continue
      }
      try {
        assets.push(
          ...(await normalizeLegacyRolesFile(assetRoot, rolesPath, sourceProvenance)),
        )
      } catch (error) {
        if (isIgnorableAssetFilesystemError(error)) {
          continue
        }
        assets.push(
          brokenManifestAsset(rolesPath, error, {
            source: 'project',
            sourcePath: rolesPath,
            sourceProvenance,
          }),
        )
      }
    }

    const legacyToolsStartedAt = performance.now()
    const toolManifestFiles = !types || types.has('tool') ? await findFilesByName(
      assetRoot,
      LEGACY_TOOL_MANIFEST_FILE_NAME,
      exclude,
    ) : []
    assetLoadProfile(
      `findLegacyTools ${assetRoot} count=${toolManifestFiles.length}`,
      legacyToolsStartedAt,
    )
    for (const toolManifestPath of toolManifestFiles.sort()) {
      if (isGeneratedEvidenceAssetPath(cwd, toolManifestPath)) {
        continue
      }
      try {
        const asset = await normalizeLegacyToolManifestFile(
          assetRoot,
          toolManifestPath,
          sourceProvenance,
        )
        if (asset) {
          assets.push(asset)
        }
      } catch (error) {
        if (isIgnorableAssetFilesystemError(error)) {
          continue
        }
        assets.push(
          brokenManifestAsset(toolManifestPath, error, {
            source: 'project',
            sourcePath: assetRoot,
            sourceProvenance,
          }),
        )
      }
    }
    assetLoadProfile(`assetRootDone ${assetRoot}`, rootStartedAt)
  }

  const acceptedKeys = new Set(assets.map(asset => asset.canonicalKey))
  // Sort order decides which generated candidate wins a duplicated canonical
  // key below, so it must be locale-independent (see compareMatOSAssetStrings).
  for (const asset of generatedScopedTargetCandidates.sort((a, b) =>
    compareMatOSAssetStrings(
      a.canonicalKey || a.manifestPath,
      b.canonicalKey || b.manifestPath,
    ),
  )) {
    if (!acceptedKeys.has(asset.canonicalKey)) {
      assets.push(asset)
      acceptedKeys.add(asset.canonicalKey)
    }
  }

  for (const mount of config.assetMounts ?? []) {
    const mountPath = resolve(cwd, mount.path)
    try {
      const asset = await loadMountedAsset(cwd, mount)
      if (asset) {
        assets.push(asset)
      }
    } catch (error) {
      if (isIgnorableAssetFilesystemError(error)) {
        continue
      }
      assets.push(
        brokenManifestAsset(
          MANIFEST_FILE_NAMES.has(basename(mountPath))
            ? mountPath
            : join(mountPath, 'asset.json'),
          error,
          {
            source: 'mount',
            sourcePath: mountPath,
          },
        ),
      )
    }
  }

  assets.push(...createBuiltinRuntimeAssets())

  const lifecycleStartedAt = performance.now()
  const lifecycleAssets = await applyMatOSAssetLifecycle(cwd, assets)
  assetLoadProfile('applyLifecycle', lifecycleStartedAt)

  const sortStartedAt = performance.now()
  const sorted = lifecycleAssets.filter(asset => !types || types.has(asset.type as MatOSAssetType)).sort((a, b) =>
    compareMatOSAssetStrings(
      a.canonicalKey || a.manifestPath,
      b.canonicalKey || b.manifestPath,
    ),
  )
  assetLoadProfile('sort', sortStartedAt)
  assetLoadProfile('total', loadStartedAt)
  return sorted
}
