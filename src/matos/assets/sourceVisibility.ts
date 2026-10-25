import { delimiter, relative, resolve, sep } from 'node:path'
import { getMatOSBundledAssetRootCandidates } from '../project.js'
import type { MatOSAsset } from './types.js'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const REDACTED_INTERNAL_PATH = '<internal>'
const DEFAULT_USER_VISIBLE_ASSET_ROOTS = [
  '/workspace/assets/user',
  '/workspace/group/shared/.matos/assets',
]

function envTruthy(value: string | undefined): boolean {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase())
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

function splitPathList(value: string | undefined): string[] {
  return (value ?? '')
    .split(delimiter)
    .map(item => item.trim())
    .filter(Boolean)
}

function assetCandidatePaths(asset: MatOSAsset): string[] {
  return [
    asset.sourcePath,
    asset.absolutePath,
    asset.entryAbsolutePath,
    asset.manifestPath,
  ].filter((value): value is string => typeof value === 'string')
}

export function shouldHideInternalAssetSource(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envTruthy(env.MATOS_HIDE_INTERNAL_ASSET_SOURCE)
}

export function isUserVisibleMatOSAsset(
  asset: MatOSAsset,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const roots = [
    ...splitPathList(env.MATOS_USER_VISIBLE_ASSET_ROOTS),
    ...DEFAULT_USER_VISIBLE_ASSET_ROOTS,
  ]
  const candidates = assetCandidatePaths(asset)
  return roots.some(root =>
    candidates.some(candidate => isWithin(candidate, root)),
  )
}

export function isBundledMatOSAsset(
  asset: MatOSAsset,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (asset.source === 'pack' && asset.packId === 'matos-core') {
    return true
  }

  const candidates = assetCandidatePaths(asset)

  return getMatOSBundledAssetRootCandidates(env).some(root =>
    candidates.some(candidate => isWithin(candidate, root)),
  )
}

// Bundled assets can opt into user surfaces by declaring
// `metadata.marketplace.visibility: "public"` (the marketplace listing
// marker). Product roles such as role:compute carry this marker while hidden
// self-evolution worker roles deliberately do not, so the internal-source
// hiding policy keeps them invisible.
export function isMarketplacePublicMatOSAsset(asset: MatOSAsset): boolean {
  const metadata = asset.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false
  }
  const marketplace = (metadata as Record<string, unknown>).marketplace
  if (!marketplace || typeof marketplace !== 'object' || Array.isArray(marketplace)) {
    return false
  }
  const visibility = (marketplace as Record<string, unknown>).visibility
  return typeof visibility === 'string' && visibility.trim().toLowerCase() === 'public'
}

function sourceProvenanceObject(asset: MatOSAsset): Record<string, unknown> {
  const provenance = asset.metadata.sourceProvenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return {}
  }
  return provenance as Record<string, unknown>
}

function currentScopeRef(
  env: NodeJS.ProcessEnv,
  scope?: string,
): string | undefined {
  const explicit = env.MATOS_SCOPE_ID?.trim() || env.MATOS_SCOPE_REF?.trim()
  if (explicit) {
    return explicit
  }
  if (scope === 'team') {
    const teamId = env.MATOS_TEAM_ID?.trim()
    return teamId ? `team:${teamId}` : undefined
  }
  if (scope === 'project') {
    const projectId = env.MATOS_PROJECT_ID?.trim()
    return projectId ? `project:${projectId}` : undefined
  }
  const userId =
    env.MATOS_USER_ID?.trim() ||
    env.MATOS_GATEWAY_USER_ID?.trim() ||
    env.MATOS_WORKSPACE_USER_ID?.trim() ||
    env.MATOS_ACCOUNT_ID?.trim()
  return userId ? `user:${userId}` : undefined
}

export function isCurrentScopedMatOSAsset(
  asset: MatOSAsset,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const provenance = sourceProvenanceObject(asset)
  const scope = typeof provenance.scope === 'string' ? provenance.scope.trim() : ''
  const scopeRef =
    typeof provenance.scopeRef === 'string' ? provenance.scopeRef.trim() : ''
  if (!scopeRef || scope !== 'user' && scope !== 'team' && scope !== 'project') {
    return false
  }
  return scopeRef === currentScopeRef(env, scope)
}

export function shouldHideAssetFromUserSurface(
  asset: MatOSAsset,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (asset.type === 'experience') {
    return false
  }

  if (isMarketplacePublicMatOSAsset(asset)) {
    return false
  }

  if (isCurrentScopedMatOSAsset(asset, env)) {
    return false
  }

  return (
    shouldHideInternalAssetSource(env) &&
    !isUserVisibleMatOSAsset(asset, env)
  )
}

export function shouldRedactInternalAssetPaths(
  asset: MatOSAsset,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    shouldHideInternalAssetSource(env) &&
    !isCurrentScopedMatOSAsset(asset, env) &&
    !isUserVisibleMatOSAsset(asset, env)
  )
}

export function redactInternalAssetPaths<T extends Record<string, unknown>>(
  asset: MatOSAsset,
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!shouldRedactInternalAssetPaths(asset, env)) {
    return value
  }

  const redacted = { ...value }
  for (const key of [
    'path',
    'absolutePath',
    'entry',
    'entryAbsolutePath',
    'manifestPath',
    'sourcePath',
  ]) {
    if (Object.hasOwn(redacted, key)) {
      redacted[key as keyof T] = REDACTED_INTERNAL_PATH as T[keyof T]
    }
  }
  return redacted
}

export function internalAssetPathPlaceholder(): string {
  return REDACTED_INTERNAL_PATH
}
