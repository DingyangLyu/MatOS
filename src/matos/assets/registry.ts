import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'
import { loadMatOSRuntimeAssets } from './loadAssets.js'
import {
  compareMatOSAssetStrings,
  compareMatOSAssetVersions,
  parseMatOSAssetReference,
  toMatOSAssetAlias,
  toMatOSAssetKey,
} from './refs.js'
import {
  MATOS_ASSET_MOUNT_GROUPS,
  type MatOSAsset,
  type MatOSAssetMountGroup,
} from './types.js'

export type MatOSAssetRegistry = {
  assets: MatOSAsset[]
  experienceAssets: MatOSAsset[]
  assetsByKey: Map<string, MatOSAsset>
  aliases: Map<string, string>
  resolve: (reference: string) => MatOSAsset | undefined
}

export type MatOSAssetRegistryOptions = {
  includeDisabled?: boolean
}

const RUNTIME_MOUNT_GROUPS = new Set<MatOSAssetMountGroup>([
  'tools',
])

function isActiveRuntimeAsset(asset: MatOSAsset): boolean {
  if (asset.lifecycle.status === 'disabled') {
    return false
  }
  // Deprecated is a real retirement tier, not a cosmetic label: deprecated
  // assets leave the active runtime registry (mounts, discovery, context
  // injection) exactly like disabled ones. History/lineage surfaces still see
  // them through includeDisabled.
  if (asset.lifecycle.status === 'deprecated') {
    return false
  }
  // Generated experience assets are evidence and soft runtime guidance. They
  // intentionally remain lifecycle=draft, but agents still need to discover,
  // show, and read them during the same run family that produced them. Other
  // draft assets stay out of the default active registry until promoted.
  if (asset.type === 'experience') {
    return true
  }
  return asset.lifecycle.status !== 'draft'
}

function isRuntimeExperienceAsset(asset: MatOSAsset): boolean {
  return (
    asset.type === 'experience' &&
    asset.lifecycle.status !== 'disabled' &&
    asset.lifecycle.status !== 'deprecated'
  )
}

function runtimeProfileReference(asset: MatOSAsset): string | undefined {
  const profile = asset.runtime.profile
  return typeof profile === 'string' && profile.trim().length > 0
    ? profile.trim()
    : undefined
}

function assetSortKey(asset: MatOSAsset): string {
  return `${asset.canonicalKey || asset.manifestPath}\0${String(
    matOSAssetOverlayPrecedence(asset),
  ).padStart(3, '0')}\0${asset.manifestPath}`
}

// Registry order feeds winner selection (canonical-key shadowing, latest-by-
// alias tie-breaks) and the published index, so the sort must not depend on
// the process locale. localeCompare additionally treats the `\0` separators
// in assetSortKey as ignorable, which could collapse distinct sort keys.
function sortAssets(assets: MatOSAsset[]): MatOSAsset[] {
  return [...assets].sort((a, b) =>
    compareMatOSAssetStrings(assetSortKey(a), assetSortKey(b)),
  )
}

export function matOSAssetSourceScope(asset: MatOSAsset): string | undefined {
  const provenance =
    asset.metadata.sourceProvenance &&
    typeof asset.metadata.sourceProvenance === 'object' &&
    !Array.isArray(asset.metadata.sourceProvenance)
      ? (asset.metadata.sourceProvenance as Record<string, unknown>)
      : {}
  const scope = provenance.scope
  return typeof scope === 'string' && scope.trim().length > 0
    ? scope.trim()
    : undefined
}

export function matOSAssetOverlayOf(asset: MatOSAsset): string | undefined {
  const overlayOf = asset.metadata.overlayOf
  return typeof overlayOf === 'string' && overlayOf.trim().length > 0
    ? overlayOf.trim()
    : undefined
}

function isPublicAssetScope(scope: string | undefined): boolean {
  return scope === 'core' || scope === 'global' || scope === 'shared'
}

export function matOSAssetCanShadowCanonicalKey(
  candidate: MatOSAsset,
  shadowed: MatOSAsset,
  canonicalKey: string,
): boolean {
  if (
    matOSAssetOverlayPrecedence(candidate) <=
      matOSAssetOverlayPrecedence(shadowed)
  ) {
    return true
  }
  const candidateScope = matOSAssetSourceScope(candidate)
  const shadowedScope = matOSAssetSourceScope(shadowed)
  if (isPublicAssetScope(candidateScope) && isPublicAssetScope(shadowedScope)) {
    return true
  }
  return matOSAssetOverlayOf(candidate) === canonicalKey
}

function matOSAssetCanWinCanonicalKey(
  candidate: MatOSAsset,
  assets: MatOSAsset[],
  canonicalKey: string,
): boolean {
  return assets.every(
    asset =>
      asset === candidate ||
      matOSAssetCanShadowCanonicalKey(candidate, asset, canonicalKey),
  )
}

function chooseSameVersionAsset(
  current: MatOSAsset,
  candidate: MatOSAsset,
): MatOSAsset {
  const currentPrecedence = matOSAssetOverlayPrecedence(current)
  const candidatePrecedence = matOSAssetOverlayPrecedence(candidate)
  if (candidatePrecedence <= currentPrecedence) {
    return current
  }
  if (
    current.canonicalKey &&
    current.canonicalKey === candidate.canonicalKey &&
    !matOSAssetCanShadowCanonicalKey(candidate, current, current.canonicalKey)
  ) {
    return current
  }
  return candidate
}

function chooseLatest(current: MatOSAsset | undefined, candidate: MatOSAsset): MatOSAsset {
  if (!current) {
    return candidate
  }
  if (!current.version) {
    return candidate
  }
  if (!candidate.version) {
    return current
  }
  const versionComparison = compareMatOSAssetVersions(
    candidate.version,
    current.version,
  )
  if (versionComparison !== 0) {
    if (versionComparison > 0) {
      if (
        current.canonicalKey &&
        matOSAssetOverlayPrecedence(candidate) >
          matOSAssetOverlayPrecedence(current) &&
        !matOSAssetCanShadowCanonicalKey(candidate, current, current.canonicalKey)
      ) {
        return current
      }
      return candidate
    }
    if (
      candidate.canonicalKey &&
      matOSAssetOverlayPrecedence(current) >
        matOSAssetOverlayPrecedence(candidate) &&
      !matOSAssetCanShadowCanonicalKey(current, candidate, candidate.canonicalKey)
    ) {
      return candidate
    }
    return current
  }
  return chooseSameVersionAsset(current, candidate)
}

export function matOSAssetOverlayPrecedence(asset: MatOSAsset): number {
  const scope = matOSAssetSourceScope(asset)
  if (scope === 'core') {
    return 5
  }
  if (scope === 'global') {
    return 10
  }
  if (scope === 'shared') {
    return 20
  }
  if (scope === 'team') {
    return 30
  }
  if (scope === 'user') {
    return 40
  }
  if (scope === 'project') {
    return 50
  }
  if (asset.source === 'mount') {
    return 70
  }
  return 35
}

function isShortMainVersion(version: string): boolean {
  return /^\d+\.\d+$/.test(version)
}

function chooseLatestShortVersionMatch(
  assets: MatOSAsset[],
  input: {
    type?: string
    id: string
    version: string
  },
): MatOSAsset | undefined {
  if (!isShortMainVersion(input.version)) {
    return undefined
  }
  let latest: MatOSAsset | undefined
  for (const asset of assets) {
    if (input.type && asset.type !== input.type) {
      continue
    }
    if (asset.id !== input.id) {
      continue
    }
    if (!asset.version?.startsWith(`${input.version}.`)) {
      continue
    }
    latest = chooseLatest(latest, asset)
  }
  return latest
}

export function buildMatOSAssetRegistry(
  assets: MatOSAsset[],
  options: MatOSAssetRegistryOptions = {},
): MatOSAssetRegistry {
  const allSortedAssets = sortAssets(assets)
  const sortedAssets = sortAssets(
    options.includeDisabled
      ? assets
      : assets.filter(isActiveRuntimeAsset),
  )
  const assetsByKey = new Map<string, MatOSAsset>()
  const latestByAlias = new Map<string, MatOSAsset>()
  const assetsByCanonicalKey = new Map<string, MatOSAsset[]>()

  for (const asset of sortedAssets) {
    if (asset.canonicalKey) {
      assetsByCanonicalKey.set(asset.canonicalKey, [
        ...(assetsByCanonicalKey.get(asset.canonicalKey) ?? []),
        asset,
      ])
    }
  }

  for (const [canonicalKey, matchingAssets] of assetsByCanonicalKey) {
    const sortedMatchingAssets = sortAssets(matchingAssets)
    // Among copies that tie on precedence, the one naming this key in
    // metadata.overlayOf is the deliberate fork (e.g. a project-local copy of
    // a bundled asset with the same version); validation accepts exactly that.
    const maxPrecedence = Math.max(...sortedMatchingAssets.map(matOSAssetOverlayPrecedence))
    const declaredOverlays = sortedMatchingAssets.filter(
      asset =>
        matOSAssetOverlayPrecedence(asset) === maxPrecedence &&
        matOSAssetOverlayOf(asset) === canonicalKey,
    )
    const winner =
      (declaredOverlays.length === 1 ? declaredOverlays[0] : undefined) ??
      [...sortedMatchingAssets]
        .reverse()
        .find(asset =>
          matOSAssetCanWinCanonicalKey(asset, sortedMatchingAssets, canonicalKey),
        ) ?? sortedMatchingAssets[0]
    if (winner) {
      assetsByKey.set(canonicalKey, winner)
    }
  }

  const effectiveAssets = sortedAssets.filter(asset => assetsByKey.get(asset.canonicalKey) === asset)
  for (const asset of effectiveAssets) {
    if (asset.type && asset.id) {
      const alias = toMatOSAssetAlias(asset.type, asset.id)
      latestByAlias.set(alias, chooseLatest(latestByAlias.get(alias), asset))
    }
  }
  const aliases = new Map<string, string>()
  for (const [alias, asset] of [...latestByAlias.entries()].sort((a, b) =>
    compareMatOSAssetStrings(a[0], b[0]),
  )) {
    if (asset.canonicalKey) {
      aliases.set(alias, asset.canonicalKey)
    }
  }

  const registry: MatOSAssetRegistry = {
    assets: sortedAssets,
    experienceAssets: allSortedAssets.filter(isRuntimeExperienceAsset),
    assetsByKey,
    aliases,
    resolve(reference: string): MatOSAsset | undefined {
      const parsed = parseMatOSAssetReference(reference)
      if (!parsed.id) {
        return undefined
      }
      if (!parsed.type) {
        const matches = effectiveAssets.filter(asset => asset.id === parsed.id)
        if (parsed.version) {
          return matches.find(asset => asset.version === parsed.version) ??
            chooseLatestShortVersionMatch(effectiveAssets, {
              id: parsed.id,
              version: parsed.version,
            })
        }
        let latest: MatOSAsset | undefined
        for (const match of matches) {
          latest = chooseLatest(latest, match)
        }
        return latest
      }

      if (parsed.version) {
        return assetsByKey.get(
          toMatOSAssetKey(parsed.type, parsed.id, parsed.version),
        ) ?? chooseLatestShortVersionMatch(effectiveAssets, {
          type: parsed.type,
          id: parsed.id,
          version: parsed.version,
        })
      }

      const key = aliases.get(toMatOSAssetAlias(parsed.type, parsed.id))
      return key ? assetsByKey.get(key) : undefined
    },
  }

  return registry
}

// Keep authoring candidates on registry.assets, but project only runtime winners.
export function getMatOSEffectiveAssets(registry: MatOSAssetRegistry): MatOSAsset[] {
  return registry.assets.filter(asset => registry.assetsByKey.get(asset.canonicalKey) === asset)
}

export function resolveMatOSRoleReference(
  registry: MatOSAssetRegistry,
  reference: string,
): { asset: MatOSAsset; reference: string; exact: boolean } | undefined {
  const normalized = reference.includes(':') ? reference : `role:${reference}`
  const direct = registry.resolve(normalized)
  if (direct?.type === 'role') {
    return { asset: direct, reference: normalized, exact: true }
  }
  if (direct) {
    return undefined
  }

  const parsed = parseMatOSAssetReference(normalized)
  if (parsed.type !== 'role' || !parsed.version) {
    return undefined
  }

  const current = registry.resolve(toMatOSAssetAlias('role', parsed.id))
  if (current?.type !== 'role' || !current.canonicalKey) {
    return undefined
  }
  return { asset: current, reference: current.canonicalKey, exact: false }
}

export function getMatOSAssetReferences(asset: MatOSAsset): string[] {
  const references: string[] = []
  const seen = new Set<string>()

  function push(reference: string): void {
    if (seen.has(reference)) {
      return
    }
    seen.add(reference)
    references.push(reference)
  }

  for (const dependency of asset.dependencies) {
    push(dependency)
  }

  if (Array.isArray(asset.metadata.toolReferences)) {
    for (const reference of asset.metadata.toolReferences) {
      if (typeof reference === 'string') {
        push(reference)
      }
    }
  }

  const profile = runtimeProfileReference(asset)
  if (profile) {
    push(profile)
  }

  for (const group of MATOS_ASSET_MOUNT_GROUPS) {
    for (const reference of asset.mounts[group] ?? []) {
      if (RUNTIME_MOUNT_GROUPS.has(group) && !reference.includes(':')) {
        continue
      }
      push(reference)
    }
  }

  return references
}

export function getMatOSAssetSubgraph(
  registry: MatOSAssetRegistry,
  rootReference: string,
): MatOSAsset[] {
  const root = registry.resolve(rootReference)
  if (!root) {
    return []
  }

  const visited = new Set<string>()
  const result: MatOSAsset[] = []

  function visit(asset: MatOSAsset): void {
    if (!asset.canonicalKey || visited.has(asset.canonicalKey)) {
      return
    }
    visited.add(asset.canonicalKey)
    result.push(asset)

    for (const reference of getMatOSAssetReferences(asset)) {
      const next = registry.resolve(reference)
      if (next) {
        visit(next)
      }
    }
  }

  visit(root)
  return result
}

function serializeAsset(asset: MatOSAsset): Record<string, unknown> {
  return {
    id: asset.id,
    type: asset.type,
    name: asset.name,
    version: asset.version,
    description: asset.description,
    canonicalKey: asset.canonicalKey,
    path: asset.relativePath,
    entry: asset.entryRelativePath,
    manifestPath: asset.manifestPath,
    source: asset.source,
    packId: asset.packId,
    tags: asset.tags,
    dependencies: asset.dependencies,
    mounts: asset.mounts,
    runtime: asset.runtime,
    metadata: asset.metadata,
  }
}

export function serializeMatOSAssetRegistry(
  registry: MatOSAssetRegistry,
): Record<string, unknown> {
  const assets: Record<string, unknown> = {}
  for (const asset of getMatOSEffectiveAssets(registry)) {
    if (asset.canonicalKey) {
      assets[asset.canonicalKey] = serializeAsset(asset)
    }
  }

  return {
    registryVersion: 1,
    assets,
    aliases: Object.fromEntries(registry.aliases),
  }
}

export async function writeMatOSAssetIndex(cwd: string): Promise<string> {
  const assets = await loadMatOSRuntimeAssets(cwd)
  const registry = buildMatOSAssetRegistry(assets)
  const { validateMatOSAssets } = await import('./validateAssets.js')
  const validation = await validateMatOSAssets(assets)
  const indexDir = join(getMatOSDir(cwd), 'index')
  const indexPath = join(indexDir, 'assets.json')

  await mkdir(indexDir, { recursive: true })
  await writeFile(
    indexPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        projectRoot: cwd,
        ...serializeMatOSAssetRegistry(registry),
        validation: {
          ok: validation.ok,
          errors: validation.errors,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return indexPath
}
