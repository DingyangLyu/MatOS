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

import type { MatOSAssetWorkbenchMode } from '../assets/graph/viewModels.js'
import type { MatOSAssetGraphProfile } from '../assets/graph/types.js'
import type { MatOSAssetHistoryScope } from '../assets/history/index.js'
import type { reviewMatOSAssetMergeWithLlm } from '../assets/mergeReview.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { redactInternalAssetPaths } from '../assets/sourceVisibility.js'
import type { MatOSAsset } from '../assets/types.js'

type WorkspaceContainerOps = {
  list: (input: { cwd: string }) => Promise<Array<{ scopeRef: string }>>
  restart: (input: {
    cwd: string
    scopeReference: string
    runtimeReference?: string
  }) => Promise<unknown>
}

export type MatOSAssetsIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Read stdin only when a command explicitly selects `-` as an input file. */
  stdin?: () => Promise<string> | string
  workspaceContainers?: WorkspaceContainerOps
  assetMergeReviewer?: typeof reviewMatOSAssetMergeWithLlm
}

export type ParsedArgs = {
  positionals: string[]
  json: boolean
  summary: boolean
  compact: boolean
  type?: string
  role?: string
  id?: string
  name?: string
  version?: string
  repo?: string
  cloneUrl?: string
  baseUrl?: string
  apiUrl?: string
  branch?: string
  fromSource?: string
  toSource?: string
  previousUpstreamSource?: string
  fromRef?: string
  sourceBranch?: string
  targetBranch?: string
  channel?: string
  title?: string
  body?: string
  message?: string
  model?: string
  members?: string[]
  admins?: string[]
  number?: number
  mergeMethod?: 'merge' | 'squash' | 'rebase'
  rawScope?: string
  scopeRef?: string
  subdir?: string
  sourceRefresh?: 'manual' | 'always'
  runtimeRefMode?: 'accepted' | 'source' | 'commit'
  reason?: string
  fields?: string[]
  limit?: number
  offset?: number
  query?: string
  groupBy?: 'type' | 'packId' | 'source'
  scope?: MatOSAssetHistoryScope
  asset?: string
  ref?: string
  urls?: string[]
  doi?: string
  path?: string
  description?: string
  domain?: string
  tags?: string[]
  pack?: string
  tosArchive?: string
  requirePath?: boolean
  entryFile?: string
  entryName?: string
  inputFile?: string
  timeoutMs?: number
  overwrite: boolean
  forceStale: boolean
  dryRun: boolean
  push: boolean
  replace: boolean
  registerSource: boolean
  excludeRuntime: boolean
  refreshWorkspaces: boolean
  includeDisabled: boolean
  write: boolean
  includeLineage: boolean
  includeUsage: boolean
  graphProfile?: MatOSAssetGraphProfile
  graphRank: boolean
  autoOnly: boolean
  llm: boolean
  reviewed: boolean
  benchmarkPassed: boolean
  judgePassed: boolean
  apply: boolean
  mode?: MatOSAssetWorkbenchMode
  types?: string[]
  direction?: 'dependencies' | 'reverse' | 'all'
  stale: boolean
  staleDays?: number
  duplicates: boolean
  error?: string
}

export function formatAsset(asset: MatOSAsset): string {
  const version = asset.version ? `@${asset.version}` : ''
  const status =
    asset.lifecycle.status === 'enabled'
      ? ''
      : ` [${asset.lifecycle.status}]`
  return `${asset.type}:${asset.id}${version}\t${asset.name}${status}\n`
}

export function writeJson(io: MatOSAssetsIO, value: unknown): void {
  const redacted = redactMatOSAssetOutput(value, { cwd: io.cwd })
  // The local UI bridge shares the CLI filesystem. It needs the two file
  // locations to read entries outside the workspace, but still receives
  // redacted metadata, prose and secrets. Browser DTOs omit these locations.
  if (process.env.MATOS_ASSET_BRIDGE_PATHS === '1') {
    const original = objectRecord(value)
    const output = objectRecord(redacted)
    const restorePaths = (source: unknown, target: unknown) => {
      const record = objectRecord(source)
      const result = objectRecord(target)
      for (const key of ['absolutePath', 'sourcePath']) {
        if (typeof record[key] === 'string') result[key] = record[key]
      }
    }
    if (original.asset && output.asset) restorePaths(original.asset, output.asset)
    if (Array.isArray(original.assets) && Array.isArray(output.assets)) {
      const assets = output.assets
      original.assets.forEach((asset, index) => restorePaths(asset, assets[index]))
    }
  }
  io.stdout(
    `${JSON.stringify(redacted, null, 2)}\n`,
  )
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function serializeAsset(asset: MatOSAsset): Record<string, unknown> {
  return redactInternalAssetPaths(asset, {
    id: asset.id,
    type: asset.type,
    name: asset.name,
    version: asset.version,
    description: asset.description,
    canonicalKey: asset.canonicalKey,
    path: asset.relativePath,
    absolutePath: asset.absolutePath,
    entry: asset.entryRelativePath,
    manifestPath: asset.manifestPath,
    source: asset.source,
    sourcePath: asset.sourcePath,
    packId: asset.packId,
    tags: asset.tags,
    dependencies: asset.dependencies,
    mounts: asset.mounts,
    runtime: asset.runtime,
    lifecycle: asset.lifecycle,
    metadata: asset.metadata,
  })
}

// Full row minus the heavyweight metadata blob. Bridge/UI catalog consumers
// (the OD assets workbench, role pickers, graph views) need every structural
// field — dependencies, mounts, runtime, lifecycle — but of `metadata` they
// only read `sourceProvenance` for Gitea governance links. On real
// deployments metadata is ~86% of the full `assets list --json` payload
// (7 MB -> ~1 MB with --compact for ~800 assets), which directly cuts the
// CLI spawn stdout, JSON parse time, and bridge cache size.
//
// `absolutePath` stays in the compact row because the daemon bridge (which
// shares the filesystem with the CLI) resolves asset entry files from the
// cached listing — e.g. workflow definition skeletons for card previews —
// without spawning one `assets show` per asset. It rides the same redaction
// pipeline as the full row: internal assets keep `<internal>` and the JSON
// writer rewrites the cwd prefix to `<workspace>`.
export function serializeAssetCompact(asset: MatOSAsset): Record<string, unknown> {
  const sourceProvenance = asset.metadata?.sourceProvenance
  return redactInternalAssetPaths(asset, {
    id: asset.id,
    type: asset.type,
    name: asset.name,
    version: asset.version,
    description: asset.description,
    canonicalKey: asset.canonicalKey,
    path: asset.relativePath,
    absolutePath: asset.absolutePath,
    entry: asset.entryRelativePath,
    source: asset.source,
    packId: asset.packId,
    tags: asset.tags,
    dependencies: asset.dependencies,
    mounts: asset.mounts,
    runtime: asset.runtime,
    lifecycle: asset.lifecycle,
    metadata: sourceProvenance ? { sourceProvenance } : {},
  })
}

export function serializeAssetSummary(
  asset: MatOSAsset,
  fields?: string[],
): Record<string, unknown> {
  const full = {
    canonicalKey: asset.canonicalKey,
    type: asset.type,
    id: asset.id,
    name: asset.name,
    version: asset.version,
    description: asset.description,
    source: asset.source,
    packId: asset.packId,
    tags: asset.tags,
    lifecycle: asset.lifecycle,
  }
  if (!fields?.length) {
    return full
  }
  return Object.fromEntries(
    fields
      .filter(field => Object.hasOwn(full, field))
      .map(field => [field, full[field as keyof typeof full]]),
  )
}

function normalizeAssetSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function assetSearchQueryTokens(query: string): string[] {
  return Array.from(
    new Set(
      normalizeAssetSearchText(query)
        .split(' ')
        .filter(token => token.length >= 2 || /[^\x00-\x7F]/u.test(token)),
    ),
  )
}

function normalizedTextMatchesQuery(haystack: string, query: string): boolean {
  const normalizedQuery = normalizeAssetSearchText(query)
  if (!normalizedQuery) {
    return true
  }
  if (haystack.includes(normalizedQuery)) {
    return true
  }
  const tokens = assetSearchQueryTokens(query)
  if (tokens.length === 0) {
    return true
  }
  const matched = tokens.filter(token => haystack.includes(token)).length
  if (tokens.length <= 2) {
    return matched === tokens.length
  }
  return matched >= Math.max(2, Math.ceil(tokens.length * 0.6))
}

export function assetMatchesQuery(
  asset: MatOSAsset,
  query: string | undefined,
): boolean {
  if (!query?.trim()) {
    return true
  }
  const haystack = [
    asset.canonicalKey,
    asset.type,
    asset.id,
    asset.name,
    asset.description,
    asset.source,
    asset.packId,
    asset.packName,
    asset.tags.join(' '),
    String(asset.metadata.summary ?? ''),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  return normalizedTextMatchesQuery(normalizeAssetSearchText(haystack), query)
}

export function groupAssetSummaries(
  assets: MatOSAsset[],
  groupBy: 'type' | 'packId' | 'source',
): Array<Record<string, unknown>> {
  const counts = new Map<string, number>()
  for (const asset of assets) {
    const value = String(asset[groupBy] ?? 'none')
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ [groupBy]: value, count }))
}

export function wantsSummaryList(options: ParsedArgs): boolean {
  return Boolean(
    options.summary ||
      options.fields?.length ||
      options.limit !== undefined ||
      options.offset !== undefined ||
      options.query ||
      options.groupBy,
  )
}
