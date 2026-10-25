import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type MatOSAssetMergePlanAction =
  | 'auto_add'
  | 'auto_metadata'
  | 'llm_user_merge'
  | 'manual_review'
  | 'blocked'
  | 'no_change'

export type MatOSAssetMergePlanItem = {
  action: MatOSAssetMergePlanAction
  identityKey: string
  upstreamRef?: string
  targetRef?: string
  upstreamManifestPath?: string
  targetManifestPath?: string
  upstreamVersion?: string
  targetVersion?: string
  changedPaths: string[]
  reason: string
  safeToAutoApply: boolean
  requiresLlmReview: boolean
  requiresUserConfirmation: boolean
}

export type MatOSAssetMergePlan = {
  schemaVersion: 1
  upstreamSourceId: string
  targetSourceId: string
  generatedAt: string
  items: MatOSAssetMergePlanItem[]
  summary: {
    total: number
    actions: Record<MatOSAssetMergePlanAction, number>
    safeToAutoApply: number
    requiresLlmReview: number
    requiresUserConfirmation: number
  }
}

export type BuildMatOSAssetMergePlanInput = {
  upstreamRoot: string
  targetRoot: string
  upstreamSourceId: string
  targetSourceId: string
  previousUpstreamRoot?: string
}

export type MatOSAssetMergeApplyItem = {
  identityKey: string
  action: MatOSAssetMergePlanAction
  upstreamDir?: string
  targetDir?: string
  createdPackManifestPath?: string
  reason?: string
}

export type MatOSAssetMergeAutoApplyResult = {
  applied: MatOSAssetMergeApplyItem[]
  skipped: MatOSAssetMergeApplyItem[]
}

type AssetEntry = {
  identityKey: string
  canonicalRef: string
  type: string
  id: string
  version: string
  manifest: Record<string, unknown>
  manifestPath: string
  dir: string
  digest: string
  files: string[]
}

const ACTIONS: MatOSAssetMergePlanAction[] = [
  'auto_add',
  'auto_metadata',
  'llm_user_merge',
  'manual_review',
  'blocked',
  'no_change',
]

const BEHAVIOR_SENSITIVE_FIELDS = new Set([
  'allow',
  'allowedTools',
  'commands',
  'dependencies',
  'env',
  'execution',
  'mcp',
  'model',
  'mounts',
  'permissions',
  'plugins',
  'policy',
  'runtime',
  'tools',
  'workflows',
])

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function canonicalRef(input: { type: string; id: string; version: string }): string {
  return `${input.type}:${input.id}@${input.version}`
}

function identityKey(input: { type: string; id: string }): string {
  return `${input.type}:${input.id}`
}

function shouldIgnorePath(path: string): boolean {
  const name = basename(path)
  return (
    name === '.git' ||
    name === '__pycache__' ||
    name === '.pytest_cache' ||
    name === '.DS_Store' ||
    /\.(pyc|pyo)$/i.test(name)
  )
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
    throw new Error(`MatOS merge path must be relative: ${relativePath}`)
  }
  const resolvedRoot = resolve(root)
  const resolved = resolve(join(resolvedRoot, relativePath))
  if (!isWithin(resolved, resolvedRoot)) {
    throw new Error(`MatOS merge path escapes root: ${relativePath}`)
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

function packManifestRelativePathForAssetManifest(
  manifestPath: string,
): string | undefined {
  const segments = manifestPath.split('/').filter(Boolean)
  if (segments[0] !== 'packs' || !segments[1]) {
    return undefined
  }
  return ['packs', segments[1], 'matos.pack.json'].join('/')
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (shouldIgnorePath(path)) {
      continue
    }
    const info = await lstat(path).catch(() => undefined)
    if (!info) {
      continue
    }
    if (info.isDirectory()) {
      files.push(...(await listFiles(path)))
    } else if (info.isFile()) {
      files.push(path)
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

async function fileDigest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function assetDigest(dir: string): Promise<{ digest: string; files: string[] }> {
  const files = await listFiles(dir)
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(dir, file).replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(await fileDigest(file))
    hash.update('\0')
  }
  return { digest: hash.digest('hex'), files }
}

async function collectAssetManifestPaths(root: string): Promise<string[]> {
  const exists = await stat(root).catch(() => undefined)
  if (!exists?.isDirectory()) {
    return []
  }
  const files = await listFiles(root)
  return files.filter(file => basename(file) === 'asset.json')
}

async function readAssetEntry(root: string, manifestPath: string): Promise<AssetEntry | undefined> {
  const raw = objectRecord(JSON.parse(await readFile(manifestPath, 'utf8')))
  const type = stringValue(raw.type)
  const id = stringValue(raw.id)
  if (!type || !id) {
    return undefined
  }
  const version = stringValue(raw.version) ?? '0.0.0'
  const dir = dirname(manifestPath)
  const digest = await assetDigest(dir)
  return {
    identityKey: identityKey({ type, id }),
    canonicalRef: canonicalRef({ type, id, version }),
    type,
    id,
    version,
    manifest: raw,
    manifestPath: relative(root, manifestPath).replace(/\\/g, '/'),
    dir,
    digest: digest.digest,
    files: digest.files.map(file => relative(root, file).replace(/\\/g, '/')),
  }
}

async function collectAssets(root: string): Promise<Map<string, AssetEntry>> {
  const entries = new Map<string, AssetEntry>()
  for (const manifestPath of await collectAssetManifestPaths(root)) {
    const entry = await readAssetEntry(root, manifestPath)
    if (entry) {
      entries.set(entry.canonicalRef, entry)
    }
  }
  return entries
}

function collectAssetsByIdentity(
  assets: Map<string, AssetEntry>,
): Map<string, AssetEntry[]> {
  const byIdentity = new Map<string, AssetEntry[]>()
  for (const entry of assets.values()) {
    byIdentity.set(entry.identityKey, [
      ...(byIdentity.get(entry.identityKey) ?? []),
      entry,
    ])
  }
  return byIdentity
}

function singleAssetForIdentity(
  assetsByIdentity: Map<string, AssetEntry[]>,
  identity: string,
): AssetEntry | undefined {
  const matches = assetsByIdentity.get(identity) ?? []
  return matches.length === 1 ? matches[0] : undefined
}

function hasBehaviorSensitiveManifest(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(item => hasBehaviorSensitiveManifest(item))
  }
  const record = objectRecord(value)
  for (const [key, nested] of Object.entries(record)) {
    if (BEHAVIOR_SENSITIVE_FIELDS.has(key)) {
      return true
    }
    if (hasBehaviorSensitiveManifest(nested)) {
      return true
    }
  }
  return false
}

function changedPaths(upstream: AssetEntry, target?: AssetEntry): string[] {
  if (!target) {
    return upstream.files
  }
  return [...new Set([...upstream.files, ...target.files])].sort((a, b) =>
    a.localeCompare(b),
  )
}

function planItemForUpstreamAsset(input: {
  upstream: AssetEntry
  target?: AssetEntry
}): MatOSAssetMergePlanItem {
  const { upstream, target } = input
  if (!target) {
    return {
      action: 'auto_add',
      identityKey: upstream.identityKey,
      upstreamRef: upstream.canonicalRef,
      upstreamManifestPath: upstream.manifestPath,
      upstreamVersion: upstream.version,
      changedPaths: upstream.files,
      reason:
        'Upstream asset is new for the scoped target; adding the asset file does not overwrite local specialization.',
      safeToAutoApply: true,
      requiresLlmReview: false,
      requiresUserConfirmation: false,
    }
  }
  if (upstream.digest === target.digest) {
    return {
      action: 'no_change',
      identityKey: upstream.identityKey,
      upstreamRef: upstream.canonicalRef,
      targetRef: target.canonicalRef,
      upstreamManifestPath: upstream.manifestPath,
      targetManifestPath: target.manifestPath,
      upstreamVersion: upstream.version,
      targetVersion: target.version,
      changedPaths: [],
      reason: 'Upstream and scoped assets have identical file content.',
      safeToAutoApply: false,
      requiresLlmReview: false,
      requiresUserConfirmation: false,
    }
  }
  if (hasBehaviorSensitiveManifest(upstream.manifest)) {
    return {
      action: 'manual_review',
      identityKey: upstream.identityKey,
      upstreamRef: upstream.canonicalRef,
      targetRef: target.canonicalRef,
      upstreamManifestPath: upstream.manifestPath,
      targetManifestPath: target.manifestPath,
      upstreamVersion: upstream.version,
      targetVersion: target.version,
      changedPaths: changedPaths(upstream, target),
      reason:
        'Upstream changes behavior-sensitive mounts, tools, MCP, permissions, execution, model, or runtime fields.',
      safeToAutoApply: false,
      requiresLlmReview: true,
      requiresUserConfirmation: true,
    }
  }
  return {
    action: 'llm_user_merge',
    identityKey: upstream.identityKey,
    upstreamRef: upstream.canonicalRef,
    targetRef: target.canonicalRef,
    upstreamManifestPath: upstream.manifestPath,
    targetManifestPath: target.manifestPath,
    upstreamVersion: upstream.version,
    targetVersion: target.version,
    changedPaths: changedPaths(upstream, target),
    reason:
      'Scoped target already specializes the same asset identity; merge requires semantic comparison and user confirmation.',
    safeToAutoApply: false,
    requiresLlmReview: true,
    requiresUserConfirmation: true,
  }
}

function inheritedUpstreamPlanItem(input: {
  upstream: AssetEntry
  previous: AssetEntry
}): MatOSAssetMergePlanItem {
  return {
    action: 'no_change',
    identityKey: input.upstream.identityKey,
    upstreamRef: input.upstream.canonicalRef,
    upstreamManifestPath: input.upstream.manifestPath,
    upstreamVersion: input.upstream.version,
    changedPaths:
      input.upstream.digest === input.previous.digest ? [] : input.upstream.files,
    reason:
      'Scoped target has no local specialization for this asset; it inherits the current upstream asset through the source graph.',
    safeToAutoApply: false,
    requiresLlmReview: false,
    requiresUserConfirmation: false,
  }
}

function summarize(items: MatOSAssetMergePlanItem[]): MatOSAssetMergePlan['summary'] {
  const actions = Object.fromEntries(ACTIONS.map(action => [action, 0])) as Record<
    MatOSAssetMergePlanAction,
    number
  >
  for (const item of items) {
    actions[item.action] += 1
  }
  return {
    total: items.length,
    actions,
    safeToAutoApply: items.filter(item => item.safeToAutoApply).length,
    requiresLlmReview: items.filter(item => item.requiresLlmReview).length,
    requiresUserConfirmation: items.filter(item => item.requiresUserConfirmation)
      .length,
  }
}

export async function buildMatOSAssetMergePlan(
  input: BuildMatOSAssetMergePlanInput,
): Promise<MatOSAssetMergePlan> {
  const upstream = await collectAssets(input.upstreamRoot)
  const target = await collectAssets(input.targetRoot)
  const targetByIdentity = collectAssetsByIdentity(target)
  const items: MatOSAssetMergePlanItem[] = []
  let previous: Map<string, AssetEntry> | undefined
  if (input.previousUpstreamRoot) {
    previous = await collectAssets(input.previousUpstreamRoot)
    for (const [key, previousAsset] of previous) {
      if (!upstream.has(key)) {
        items.push({
          action: 'blocked',
          identityKey: previousAsset.identityKey,
          upstreamRef: previousAsset.canonicalRef,
          upstreamManifestPath: previousAsset.manifestPath,
          upstreamVersion: previousAsset.version,
          changedPaths: previousAsset.files,
          reason:
            'Asset existed in the previous upstream root but is absent from the current upstream root; deletion or disabling requires explicit review.',
          safeToAutoApply: false,
          requiresLlmReview: false,
          requiresUserConfirmation: true,
        })
      }
    }
  }
  for (const [key, upstreamAsset] of upstream) {
    const targetAsset =
      target.get(key) ??
      singleAssetForIdentity(targetByIdentity, upstreamAsset.identityKey)
    const previousAsset = previous?.get(key)
    if (!targetAsset && previousAsset) {
      items.push(
        inheritedUpstreamPlanItem({
          upstream: upstreamAsset,
          previous: previousAsset,
        }),
      )
      continue
    }
    items.push(
      planItemForUpstreamAsset({
        upstream: upstreamAsset,
        target: targetAsset,
      }),
    )
  }
  items.sort((a, b) => {
    const byIdentity = a.identityKey.localeCompare(b.identityKey)
    if (byIdentity !== 0) {
      return byIdentity
    }
    return (a.upstreamRef ?? '').localeCompare(b.upstreamRef ?? '')
  })
  return {
    schemaVersion: 1,
    upstreamSourceId: input.upstreamSourceId,
    targetSourceId: input.targetSourceId,
    generatedAt: new Date().toISOString(),
    items,
    summary: summarize(items),
  }
}

export async function applyMatOSAssetMergePlanAutoOnly(input: {
  upstreamRoot: string
  targetRoot: string
  plan: MatOSAssetMergePlan
}): Promise<MatOSAssetMergeAutoApplyResult> {
  const applied: MatOSAssetMergeApplyItem[] = []
  const skipped: MatOSAssetMergeApplyItem[] = []
  for (const item of input.plan.items) {
    if (item.action !== 'auto_add' || !item.safeToAutoApply) {
      skipped.push({
        identityKey: item.identityKey,
        action: item.action,
        reason: item.reason,
      })
      continue
    }
    if (!item.upstreamManifestPath) {
      skipped.push({
        identityKey: item.identityKey,
        action: item.action,
        reason: 'auto_add item is missing upstream manifest path',
      })
      continue
    }
    const relativeDir = dirname(item.upstreamManifestPath)
    const upstreamDir = resolveUnderRoot(input.upstreamRoot, relativeDir)
    const targetDir = resolveUnderRoot(input.targetRoot, relativeDir)
    if (await pathExists(targetDir)) {
      skipped.push({
        identityKey: item.identityKey,
        action: item.action,
        upstreamDir,
        targetDir,
        reason: 'target asset directory already exists',
      })
      continue
    }
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(upstreamDir, targetDir, { recursive: true, errorOnExist: true })
    let createdPackManifestPath: string | undefined
    const packManifestRelativePath = packManifestRelativePathForAssetManifest(
      item.upstreamManifestPath,
    )
    if (packManifestRelativePath) {
      const upstreamPackManifest = resolveUnderRoot(
        input.upstreamRoot,
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
        try {
          await mkdir(dirname(targetPackManifest), { recursive: true })
          await cp(upstreamPackManifest, targetPackManifest, {
            errorOnExist: true,
          })
          createdPackManifestPath = targetPackManifest
        } catch (error) {
          await rm(targetDir, { recursive: true, force: true }).catch(
            () => undefined,
          )
          throw error
        }
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
