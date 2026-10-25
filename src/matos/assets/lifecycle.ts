import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getMatOSAssetLifecyclePath } from '../project.js'
import {
  buildMatOSAssetRegistry,
  type MatOSAssetRegistry,
} from './registry.js'
import type {
  MatOSAsset,
  MatOSAssetLifecycle,
  MatOSAssetLifecycleStatus,
} from './types.js'

export type MatOSAssetLifecycleState = {
  version: 1
  assets: Record<string, MatOSAssetLifecycle>
}

export type MatOSAssetLifecycleSummary = {
  total: number
  enabled: number
  disabled: number
  deprecated: number
  draft: number
}

const DEFAULT_LIFECYCLE: MatOSAssetLifecycle = { status: 'enabled' }

export async function readMatOSAssetLifecycleState(
  cwd: string,
): Promise<MatOSAssetLifecycleState> {
  try {
    const raw = await readFile(getMatOSAssetLifecyclePath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as Partial<MatOSAssetLifecycleState>
    return {
      version: 1,
      assets:
        parsed.assets && typeof parsed.assets === 'object'
          ? parsed.assets
          : {},
    }
  } catch {
    return { version: 1, assets: {} }
  }
}

export async function writeMatOSAssetLifecycleState(
  cwd: string,
  state: MatOSAssetLifecycleState,
): Promise<void> {
  const path = getMatOSAssetLifecyclePath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export async function applyMatOSAssetLifecycle(
  cwd: string,
  assets: MatOSAsset[],
): Promise<MatOSAsset[]> {
  const state = await readMatOSAssetLifecycleState(cwd)
  return assets.map(asset => ({
    ...asset,
    lifecycle: asset.canonicalKey
      ? state.assets[asset.canonicalKey] ?? asset.lifecycle
      : asset.lifecycle,
  }))
}

export function summarizeMatOSAssetLifecycle(
  assets: MatOSAsset[],
): MatOSAssetLifecycleSummary {
  const summary: MatOSAssetLifecycleSummary = {
    total: assets.length,
    enabled: 0,
    disabled: 0,
    deprecated: 0,
    draft: 0,
  }

  for (const asset of assets) {
    const status = asset.lifecycle.status
    summary[status] += 1
  }

  return summary
}

function resolveLifecycleAsset(
  registry: MatOSAssetRegistry,
  reference: string,
): MatOSAsset | undefined {
  return registry.resolve(reference)
}

export async function setMatOSAssetLifecycleStatus(
  cwd: string,
  assets: MatOSAsset[],
  reference: string,
  status: MatOSAssetLifecycleStatus,
  reason?: string,
): Promise<MatOSAsset> {
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const asset = resolveLifecycleAsset(registry, reference)
  if (!asset?.canonicalKey) {
    throw new Error(`MatOS asset not found: ${reference}`)
  }

  const state = await readMatOSAssetLifecycleState(cwd)
  state.assets[asset.canonicalKey] = {
    status,
    ...(reason ? { reason } : {}),
    updatedAt: new Date().toISOString(),
  }
  await writeMatOSAssetLifecycleState(cwd, state)
  return {
    ...asset,
    lifecycle: state.assets[asset.canonicalKey] ?? DEFAULT_LIFECYCLE,
  }
}
