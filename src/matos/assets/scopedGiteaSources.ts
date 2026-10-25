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

import { loadMatOSAssets } from './loadAssets.js'
import { isDeepStrictEqual } from 'node:util'
import { validateMatOSAssets } from './validateAssets.js'
import {
  materializeMatOSAssetSource,
  serializeMatOSAssetSourceConfig,
} from './sourceAdapters.js'
import {
  canonicalizeMatOSGiteaAssetSource,
  matOSGiteaAssetRepoForScope,
  matOSGiteaCloneUrl,
  matOSGiteaScopeIdFromScopeRef,
} from './giteaGovernance.js'
import { matOSAcceptedBranchForSource } from './giteaAcceptance.js'
import { withMatOSAssetHistoryLock } from './history/lock.js'
import {
  readMatOSProjectConfig,
  writeMatOSProjectConfig,
  type MatOSGitAssetSourceConfig,
  type MatOSAssetSourceConfig,
} from '../project.js'

export type RuntimeScopedGiteaAssetSourceScope = 'user' | 'team' | 'project'

export type SyncRuntimeScopedGiteaAssetSourceResult = {
  ok: boolean
  source: MatOSGitAssetSourceConfig
  sources: MatOSAssetSourceConfig[]
  materializedRoot: string
  validation: Awaited<ReturnType<typeof validateMatOSAssets>>
}

function giteaWebUrl(input: {
  baseUrl?: string
  owner: string
  repo: string
}): string | undefined {
  if (!input.baseUrl?.trim()) {
    return undefined
  }
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(input.owner)}/${encodeURIComponent(
    input.repo,
  )}`
}

export function runtimeScopedGiteaAssetSourceId(input: {
  scope: RuntimeScopedGiteaAssetSourceScope
  scopeRef: string
}): string {
  return `matos-${input.scope}-assets-${matOSGiteaScopeIdFromScopeRef(
    input.scopeRef,
  )}`
}

export function buildRuntimeScopedGiteaAssetSource(input: {
  scope: RuntimeScopedGiteaAssetSourceScope
  scopeRef: string
  baseUrl: string
  id?: string
  ref?: string
  refresh?: NonNullable<MatOSAssetSourceConfig['refresh']>
  runtimeRefMode?: 'accepted' | 'source'
  channel?: string
}): MatOSGitAssetSourceConfig {
  const repo = matOSGiteaAssetRepoForScope({
    scope: input.scope,
    scopeRef: input.scopeRef,
  })
  const cloneUrl = matOSGiteaCloneUrl({
    baseUrl: input.baseUrl,
    owner: repo.owner,
    repo: repo.repo,
  })
  const webUrl = giteaWebUrl({
    baseUrl: input.baseUrl,
    owner: repo.owner,
    repo: repo.repo,
  })
  const sourceId =
    input.id?.trim() ||
    runtimeScopedGiteaAssetSourceId({
      scope: input.scope,
      scopeRef: input.scopeRef,
    })
  return canonicalizeMatOSGiteaAssetSource({
    type: 'git',
    id: sourceId,
    repo: cloneUrl,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : { ref: 'main' }),
    scope: input.scope,
    scopeRef: input.scopeRef,
    refresh: input.refresh ?? 'manual',
    provider: 'gitea',
    ...(input.runtimeRefMode === 'accepted'
      ? {
          runtimeRef: {
            mode: 'accepted-ref' as const,
            ref: matOSAcceptedBranchForSource({
              sourceId,
              channel: input.channel ?? 'stable',
            }),
          },
        }
      : {}),
    gitea: {
      owner: repo.owner,
      repo: repo.repo,
      visibility: repo.visibility,
      baseUrl: input.baseUrl,
      ...(webUrl ? { webUrl } : {}),
      cloneUrl,
    },
  })
}

export function serializeRuntimeScopedGiteaAssetSource(
  source: MatOSAssetSourceConfig,
): Record<string, unknown> {
  return serializeMatOSAssetSourceConfig(source)
}

export async function syncRuntimeScopedGiteaAssetSource(input: {
  cwd: string
  scope: RuntimeScopedGiteaAssetSourceScope
  scopeRef: string
  baseUrl: string
  id?: string
  ref?: string
  refresh?: NonNullable<MatOSAssetSourceConfig['refresh']>
  runtimeRefMode?: 'accepted' | 'source'
  channel?: string
  replace?: boolean
  token?: string
}): Promise<SyncRuntimeScopedGiteaAssetSourceResult> {
  return withMatOSAssetHistoryLock({ cwd: input.cwd, operation: 'scoped-source-sync' },
    () => syncRuntimeScopedGiteaAssetSourceLocked(input))
}

/** For native publishers which already hold the workspace history lock. */
export async function syncRuntimeScopedGiteaAssetSourceLocked(
  input: Parameters<typeof syncRuntimeScopedGiteaAssetSource>[0],
): Promise<SyncRuntimeScopedGiteaAssetSourceResult> {
  const config = await readMatOSProjectConfig(input.cwd, { strict: true })
  const existingSources = config.assetSources ?? []
  const source = buildRuntimeScopedGiteaAssetSource({
    scope: input.scope,
    scopeRef: input.scopeRef,
    baseUrl: input.baseUrl,
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    ref: input.ref,
    refresh: input.refresh ?? 'manual',
    runtimeRefMode: input.runtimeRefMode,
    channel: input.channel,
  })
  const shouldReplaceExisting = (existing: MatOSAssetSourceConfig): boolean =>
    existing.id === source.id ||
    (input.replace === true &&
      existing.type === 'git' &&
      existing.provider === 'gitea' &&
      existing.scope === input.scope &&
      existing.scopeRef === input.scopeRef)
  const existingSource = existingSources.find(shouldReplaceExisting)
  const syncedSource: MatOSGitAssetSourceConfig =
    !source.runtimeRef &&
    input.runtimeRefMode === undefined &&
    existingSource?.type === 'git' &&
    existingSource.runtimeRef
      ? {
          ...source,
          runtimeRef: existingSource.runtimeRef,
        }
      : source
  let published = false
  const restoreConfig = async () => {
    if (!published) return
    const latest = await readMatOSProjectConfig(input.cwd, { strict: true })
    const current = (latest.assetSources ?? []).filter(shouldReplaceExisting)
    if (!isDeepStrictEqual(
      JSON.parse(JSON.stringify(current.map(serializeMatOSAssetSourceConfig))),
      JSON.parse(JSON.stringify([serializeMatOSAssetSourceConfig(syncedSource)])),
    )) {
      throw new Error('Scoped asset source changed during validation; refusing to overwrite its newer version')
    }
    await writeMatOSProjectConfig(input.cwd, { ...latest,
      assetSources: [...(latest.assetSources ?? []).filter(item => !shouldReplaceExisting(item)), ...existingSources.filter(shouldReplaceExisting)],
    })
    published = false
  }
  try {
    const materializedRoot = await materializeMatOSAssetSource(
      input.cwd,
      syncedSource,
      {
        refresh: syncedSource.refresh ?? 'manual',
        token: input.token,
        preserveDirty: true,
      },
    )
    const latest = await readMatOSProjectConfig(input.cwd, { strict: true })
    if (JSON.stringify((latest.assetSources ?? []).filter(shouldReplaceExisting)) !== JSON.stringify(existingSources.filter(shouldReplaceExisting))) {
      throw new Error('Scoped asset source changed during preparation; retry source synchronization')
    }
    const nextSources = [...(latest.assetSources ?? []).filter(item => !shouldReplaceExisting(item)), syncedSource]
    await writeMatOSProjectConfig(input.cwd, { ...latest, assetSources: nextSources })
    published = true
    const validation = await validateMatOSAssets(await loadMatOSAssets(input.cwd, { runtimeSnapshot: true }))
    if (!validation.ok) {
      await restoreConfig()
    }
    return {
      ok: validation.ok,
      source: syncedSource,
      sources: nextSources,
      materializedRoot,
      validation,
    }
  } catch (error) {
    await restoreConfig()
    throw error
  }
}
