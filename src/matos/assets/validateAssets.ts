import { stat } from 'node:fs/promises'
import { matOSAlgorithmStrategyAssetIssues } from '../algorithms/assetExecProvider.js'
import { matOSAlgorithmComponentAssetIssues } from '../algorithms/componentTool.js'
import type {
  MatOSAsset,
  MatOSAssetValidationError,
  MatOSAssetValidationResult,
} from './types.js'
import { isSupportedMatOSAssetType } from './types.js'
import {
  buildMatOSAssetRegistry,
  getMatOSAssetReferences,
  matOSAssetCanShadowCanonicalKey,
  matOSAssetOverlayOf,
  matOSAssetOverlayPrecedence,
} from './registry.js'

export type MatOSAssetValidationOptions = {
  includeDisabled?: boolean
  includeDrafts?: boolean
  requireToolMounts?: boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function missingFieldError(
  asset: MatOSAsset,
  field: string,
): MatOSAssetValidationError {
  return {
    code: 'missing_field',
    assetId: asset.id || undefined,
    manifestPath: asset.manifestPath,
    message: `Asset manifest is missing required field "${field}"`,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function isActiveValidationAsset(
  asset: MatOSAsset,
  options: MatOSAssetValidationOptions,
): boolean {
  if (asset.lifecycle.status === 'disabled') {
    return options.includeDisabled === true
  }
  if (asset.lifecycle.status === 'draft') {
    return options.includeDrafts === true
  }
  return true
}

function duplicateAssetsToReport(
  canonicalKey: string,
  assets: MatOSAsset[],
): MatOSAsset[] {
  if (assets.length <= 1) {
    return []
  }
  let maxPrecedence = Number.NEGATIVE_INFINITY
  for (const asset of assets) {
    maxPrecedence = Math.max(maxPrecedence, matOSAssetOverlayPrecedence(asset))
  }
  const highestPrecedenceAssets = assets.filter(
    asset => matOSAssetOverlayPrecedence(asset) === maxPrecedence,
  )
  if (highestPrecedenceAssets.length !== 1) {
    // One asset that names this key in metadata.overlayOf is a deliberate
    // fork of the others, and resolution picks it; anything else is ambiguous.
    const overlays = highestPrecedenceAssets.filter(
      asset => matOSAssetOverlayOf(asset) === canonicalKey,
    )
    return overlays.length === 1 ? [] : highestPrecedenceAssets
  }
  const highest = highestPrecedenceAssets[0]
  const invalidShadow = assets.some(
    asset =>
      asset !== highest &&
      !matOSAssetCanShadowCanonicalKey(highest, asset, canonicalKey),
  )
  return invalidShadow ? [highest] : []
}

export async function validateMatOSAssets(
  assets: MatOSAsset[],
  options: MatOSAssetValidationOptions = {},
): Promise<MatOSAssetValidationResult> {
  const errors: MatOSAssetValidationError[] = []
  const activeAssets = assets.filter(asset =>
    isActiveValidationAsset(asset, options),
  )
  const registry = buildMatOSAssetRegistry(activeAssets, {
    includeDisabled: options.includeDisabled === true || options.includeDrafts === true,
  })
  const canonicalKeys = new Map<string, MatOSAsset[]>()

  const isBrokenManifestAsset = (asset: MatOSAsset): boolean =>
    typeof asset.metadata.loadError === 'string' &&
    asset.metadata.loadError.length > 0

  for (const asset of activeAssets) {
    if (isBrokenManifestAsset(asset)) {
      errors.push({
        code: 'invalid_manifest',
        assetId: asset.id || undefined,
        manifestPath: asset.manifestPath,
        message: `Asset manifest could not be parsed: ${String(
          asset.metadata.loadError,
        )}`,
      })
      continue
    }
    if (!asset.id) {
      errors.push(missingFieldError(asset, 'id'))
    }
    if (!asset.type) {
      errors.push(missingFieldError(asset, 'type'))
    } else if (!isSupportedMatOSAssetType(asset.type)) {
      errors.push({
        code: 'invalid_type',
        assetId: asset.id || undefined,
        manifestPath: asset.manifestPath,
        message: `Unsupported MatOS asset type "${asset.type}"`,
      })
    }
    if (!asset.name) {
      errors.push(missingFieldError(asset, 'name'))
    }
    if (!asset.version) {
      errors.push(missingFieldError(asset, 'version'))
    }

    if (asset.type === 'runtime') {
      const engine = optionalString(asset.runtime.engine)
      if (!engine) {
        errors.push(missingFieldError(asset, 'runtime.engine'))
      } else if (engine !== 'local' && engine !== 'container') {
        errors.push({
          code: 'invalid_reference',
          assetId: asset.id || undefined,
          assetKey: asset.canonicalKey || undefined,
          manifestPath: asset.manifestPath,
          message: `Unsupported MatOS runtime engine "${engine}"`,
        })
      }
      if (engine === 'container' && !optionalString(asset.runtime.image)) {
        errors.push(missingFieldError(asset, 'runtime.image'))
      }
    }

    // Algorithm strategy tool assets get static contract validation here so
    // every validation gate (CLI validate, self-evolution usability gate,
    // Gitea acceptance) rejects broken strategies before runtime use.
    for (const issue of matOSAlgorithmStrategyAssetIssues(asset)) {
      errors.push({
        code: 'invalid_reference',
        assetId: asset.id || undefined,
        assetKey: asset.canonicalKey || undefined,
        manifestPath: asset.manifestPath,
        message: issue,
      })
    }
    for (const issue of matOSAlgorithmComponentAssetIssues(asset)) {
      errors.push({
        code: 'invalid_reference',
        assetId: asset.id || undefined,
        assetKey: asset.canonicalKey || undefined,
        manifestPath: asset.manifestPath,
        message: issue,
      })
    }

    if (asset.canonicalKey) {
      canonicalKeys.set(asset.canonicalKey, [
        ...(canonicalKeys.get(asset.canonicalKey) ?? []),
        asset,
      ])
    }

    if (!(await pathExists(asset.absolutePath))) {
      errors.push({
        code: 'missing_path',
        assetId: asset.id || undefined,
        manifestPath: asset.manifestPath,
        message: `Asset path does not exist: ${asset.relativePath}`,
      })
    }

    if (asset.entryAbsolutePath && !(await pathExists(asset.entryAbsolutePath))) {
      errors.push({
        code: 'missing_entry',
        assetId: asset.id || undefined,
        assetKey: asset.canonicalKey || undefined,
        manifestPath: asset.manifestPath,
        message: `Asset entry does not exist: ${asset.entryRelativePath}`,
      })
    }
  }

  for (const [canonicalKey, matchingAssets] of canonicalKeys) {
    const duplicateAssets = duplicateAssetsToReport(canonicalKey, matchingAssets)
    if (duplicateAssets.length > 0) {
      for (const asset of duplicateAssets) {
        errors.push({
          code: 'duplicate_asset',
          assetId: asset.id || undefined,
          assetKey: canonicalKey,
          manifestPath: asset.manifestPath,
          message: `Duplicate MatOS asset "${canonicalKey}"`,
        })
      }
    }
  }

  for (const asset of activeAssets) {
    if (isBrokenManifestAsset(asset)) {
      continue
    }
    for (const dependency of asset.dependencies) {
      if (!registry.resolve(dependency)) {
        errors.push({
          code: 'missing_dependency',
          assetId: asset.id || undefined,
          assetKey: asset.canonicalKey || undefined,
          manifestPath: asset.manifestPath,
          message: `Missing MatOS asset dependency "${dependency}"`,
        })
      }
    }

    const runtimeProfile = optionalString(asset.runtime.profile)
    if (runtimeProfile && !registry.resolve(runtimeProfile)) {
      errors.push({
        code: 'missing_dependency',
        assetId: asset.id || undefined,
        assetKey: asset.canonicalKey || undefined,
        manifestPath: asset.manifestPath,
        message: `Missing MatOS asset dependency "${runtimeProfile}"`,
      })
    }

    if (Array.isArray(asset.metadata.toolReferences)) {
      for (const reference of asset.metadata.toolReferences) {
        if (typeof reference !== 'string') {
          errors.push({
            code: 'invalid_reference',
            assetId: asset.id || undefined,
            assetKey: asset.canonicalKey || undefined,
            manifestPath: asset.manifestPath,
            message: 'MatOS asset metadata.toolReferences entries must be strings',
          })
          continue
        }
        if (!registry.resolve(reference)) {
          errors.push({
            code: 'missing_dependency',
            assetId: asset.id || undefined,
            assetKey: asset.canonicalKey || undefined,
            manifestPath: asset.manifestPath,
            message: `Missing MatOS asset toolReference "${reference}"`,
          })
        }
      }
    }

    for (const [group, references] of Object.entries(asset.mounts)) {
      // Tools mounts are best-effort runtime bindings: colonless entries name
      // raw native tools, and dangling tool: refs are tolerated here and
      // surfaced as skipped asset events during runtime composition instead.
      if (group === 'tools' && !options.requireToolMounts) {
        continue
      }
      for (const reference of references ?? []) {
        if (group === 'tools' && Array.isArray(asset.metadata.optionalToolRefs) && asset.metadata.optionalToolRefs.includes(reference)) continue
        if (!reference.includes(':')) {
          continue
        }
        if (!registry.resolve(reference)) {
          errors.push({
            code: 'missing_mount',
            assetId: asset.id || undefined,
            assetKey: asset.canonicalKey || undefined,
            manifestPath: asset.manifestPath,
            message: `Missing MatOS asset mount "${reference}"`,
          })
        }
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const reportedCycles = new Set<string>()

  function cycleReferencesFor(asset: MatOSAsset): string[] {
    return getMatOSAssetReferences(asset).filter(reference => {
      const next = registry.resolve(reference)
      return !(asset.type === 'role' && next?.type === 'role')
    })
  }

  function visit(asset: MatOSAsset, path: string[]): void {
    if (!asset.canonicalKey || visited.has(asset.canonicalKey)) {
      return
    }
    if (visiting.has(asset.canonicalKey)) {
      const cycleStart = path.indexOf(asset.canonicalKey)
      const cycle = [...path.slice(Math.max(0, cycleStart)), asset.canonicalKey]
      const signature = cycle.join(' -> ')
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature)
        errors.push({
          code: 'cyclic_dependency',
          assetId: asset.id || undefined,
          assetKey: asset.canonicalKey,
          manifestPath: asset.manifestPath,
          message: `MatOS asset dependency cycle: ${signature}`,
        })
      }
      return
    }

    visiting.add(asset.canonicalKey)
    for (const reference of cycleReferencesFor(asset)) {
      const next = registry.resolve(reference)
      if (next) {
        visit(next, [...path, asset.canonicalKey])
      }
    }
    visiting.delete(asset.canonicalKey)
    visited.add(asset.canonicalKey)
  }

  for (const asset of activeAssets) {
    visit(asset, [])
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}
