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

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readMatOSProjectMetadata } from '../projectMetadata.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetGraphIndex } from '../assets/graph/buildGraphIndex.js'
import {
  getMatOSAssetImpact,
  getMatOSAssetLineageTree,
  getMatOSAssetNeighborhood,
  getMatOSAssetRelated,
} from '../assets/graph/queries.js'
import {
  rankMatOSAssets,
  type MatOSAssetRankedHit,
} from '../assets/graph/relevance.js'
import { serializeMatOSGraphRankedAsset } from '../assets/graph/rankedAssetSummary.js'
import type { MatOSAssetGraphProfile } from '../assets/graph/types.js'
import {
  buildMatOSAssetRegistry,
  getMatOSAssetReferences,
  getMatOSAssetSubgraph,
  type MatOSAssetRegistry,
} from '../assets/registry.js'
import {
  redactInternalAssetPaths,
  shouldHideAssetFromUserSurface,
} from '../assets/sourceVisibility.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import type { MatOSAsset } from '../assets/types.js'
import { recordMatOSTraceEventFromEnv } from '../sessions/traceBridge.js'
import { MATOS_ASSET_DISCOVERY_TOOL_NAMES } from './toolNames.js'

export type MatOSAssetDiscoveryToolResult = {
  text: string
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type MatOSAssetDiscoveryTool = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    additionalProperties?: boolean
  }
  call: (input: unknown) => Promise<MatOSAssetDiscoveryToolResult>
}

export type MatOSAssetDiscoveryContext = {
  cwd: string
  assetCwd?: string
  selectedRole?: string
  selectedAssetKeys?: string[]
}

type AssetQuery = {
  type?: string
  query?: string
  group?: string
  prefix?: string
  includeDisabled?: boolean
  limit?: number
  offset?: number
  fields?: string[]
  detail?: 'summary' | 'full'
  includeGroups?: boolean
  groupBy?: 'group' | 'type' | 'pack' | 'status'
  groupLimit?: number
  groupOffset?: number
  graphRank?: boolean
  graphProfile?: MatOSAssetGraphProfile
  seedRefs?: string[]
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const DEFAULT_GROUP_LIMIT = 50
const MAX_GROUP_LIMIT = 200
const DEFAULT_READ_BYTES = 8_000
const MAX_READ_BYTES = 20_000
const SUMMARY_FIELDS = [
  'id',
  'type',
  'name',
  'version',
  'description',
  'canonicalKey',
  'group',
  'tags',
  'summary',
  'status',
  'source',
  'packId',
]
const FIELD_ALIASES: Record<string, string> = {
  key: 'canonicalKey',
  lifecycleStatus: 'status',
  pack: 'packId',
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalDetail(value: unknown): 'summary' | 'full' | undefined {
  return value === 'summary' || value === 'full' ? value : undefined
}

function optionalGroupBy(
  value: unknown,
): 'group' | 'type' | 'pack' | 'status' | undefined {
  return value === 'group' ||
    value === 'type' ||
    value === 'pack' ||
    value === 'status'
    ? value
    : undefined
}

function boundedInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback
  }
  return Math.min(value, max)
}

function boundedOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return 0
  }
  return value
}

function boundedReadBytes(value: unknown): number {
  return Math.max(4, boundedInteger(value, DEFAULT_READ_BYTES, MAX_READ_BYTES))
}

function optionalFields(value: unknown): string[] | undefined {
  const rawFields = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const fields = rawFields
    .filter((item): item is string => typeof item === 'string')
    .map(item => FIELD_ALIASES[item.trim()] ?? item.trim())
    .filter(Boolean)
  return fields.length > 0 ? Array.from(new Set(fields)) : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const result = values
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  return result.length > 0 ? Array.from(new Set(result)) : undefined
}

function optionalDirection(
  value: unknown,
): 'dependencies' | 'reverse' | 'all' | undefined {
  return value === 'dependencies' || value === 'reverse' || value === 'all'
    ? value
    : undefined
}

function optionalAssetGraphMode(
  value: unknown,
):
  | 'dependencies'
  | 'reverse'
  | 'lineage'
  | 'usage'
  | 'related'
  | 'all'
  | undefined {
  return value === 'dependencies' ||
    value === 'reverse' ||
    value === 'lineage' ||
    value === 'usage' ||
    value === 'related' ||
    value === 'all'
    ? value
    : undefined
}

function optionalAssetGraphProfile(value: unknown): MatOSAssetGraphProfile | undefined {
  return value === 'core' ||
    value === 'discovery' ||
    value === 'evidence' ||
    value === 'full'
    ? value
    : undefined
}

type JsonPathToken =
  | { type: 'key'; key: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' }

function parseJsonPath(path: string): JsonPathToken[] | undefined {
  let cursor = path.trim()
  if (!cursor) {
    return undefined
  }
  if (cursor === '$') {
    return []
  }
  if (cursor.startsWith('$')) {
    cursor = cursor.slice(1)
  }
  if (cursor.startsWith('.')) {
    cursor = cursor.slice(1)
  }
  const tokens: JsonPathToken[] = []
  while (cursor.length > 0) {
    const keyMatch = cursor.match(/^([A-Za-z0-9_-]+)/)
    if (keyMatch) {
      tokens.push({ type: 'key', key: keyMatch[1] ?? '' })
      cursor = cursor.slice(keyMatch[0].length)
    } else if (cursor.startsWith('[*]')) {
      tokens.push({ type: 'wildcard' })
      cursor = cursor.slice(3)
    } else {
      const indexMatch = cursor.match(/^\[(\d+)\]/)
      if (!indexMatch) {
        return undefined
      }
      tokens.push({ type: 'index', index: Number(indexMatch[1]) })
      cursor = cursor.slice(indexMatch[0].length)
    }
    if (cursor.startsWith('.')) {
      cursor = cursor.slice(1)
    } else if (cursor.length > 0 && !cursor.startsWith('[')) {
      return undefined
    }
  }
  return tokens
}

function selectJsonPathValue(value: unknown, tokens: JsonPathToken[]): unknown {
  if (tokens.length === 0) {
    return value
  }
  const [token, ...rest] = tokens
  if (!token) {
    return value
  }
  if (token.type === 'wildcard') {
    return Array.isArray(value)
      ? value.map(item => selectJsonPathValue(item, rest))
      : undefined
  }
  if (token.type === 'index') {
    return Array.isArray(value)
      ? selectJsonPathValue(value[token.index], rest)
      : undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return selectJsonPathValue(
    (value as Record<string, unknown>)[token.key],
    rest,
  )
}

function applyJsonPath(content: string, jsonPath: string): unknown {
  const tokens = parseJsonPath(jsonPath)
  if (!tokens) {
    throw new Error(`unsupported jsonPath: ${jsonPath}`)
  }
  return selectJsonPathValue(JSON.parse(content) as unknown, tokens)
}

function jsonResult(value: unknown): MatOSAssetDiscoveryToolResult {
  const redacted = redactMatOSAssetOutput(value)
  return {
    text: `${JSON.stringify(redacted)}\n`,
    structuredContent:
      redacted && typeof redacted === 'object' && !Array.isArray(redacted)
        ? (redacted as Record<string, unknown>)
        : undefined,
  }
}

function workspaceRootValue(): string {
  return '<workspace>'
}

function errorResult(text: string): MatOSAssetDiscoveryToolResult {
  return { text, isError: true }
}

function inputObject(input: unknown): Record<string, unknown> {
  return redactMatOSAssetOutput(metadataObject(input)) as Record<string, unknown>
}

async function recordAssetUsage(data: Record<string, unknown>): Promise<void> {
  await recordMatOSTraceEventFromEnv({
    type: 'matos.asset.used',
    data: redactMatOSAssetOutput(data) as Record<string, unknown>,
  })
}

function resolveAssetInput(
  registry: MatOSAssetRegistry,
  raw: Record<string, unknown>,
): { asset?: MatOSAsset; reference?: string; error?: string } {
  const ref = optionalString(raw.ref)
  const id = optionalString(raw.id)
  const type = optionalString(raw.type)
  const version = optionalString(raw.version)

  if (id) {
    const reference = type
      ? `${type}:${id}${version ? `@${version}` : ''}`
      : `${id}${version ? `@${version}` : ''}`
    const asset = registry.resolve(reference)
    if (asset) {
      return { asset, reference }
    }
    return { reference, error: `MatOS asset not found or disabled: ${reference}` }
  }

  if (ref) {
    const asset = registry.resolve(ref)
    if (asset) {
      return { asset, reference: ref }
    }
    return { reference: ref, error: `MatOS asset not found or disabled: ${ref}` }
  }

  return { error: 'Usage requires ref or id' }
}

function serializeAsset(asset: MatOSAsset): Record<string, unknown> {
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
    entryAbsolutePath: asset.entryAbsolutePath,
    manifestPath: asset.manifestPath,
    source: asset.source,
    packId: asset.packId,
    tags: asset.tags,
    dependencies: asset.dependencies,
    mounts: asset.mounts,
    runtime: asset.runtime,
    lifecycle: asset.lifecycle,
    metadata: asset.metadata,
  })
}

function serializedAssetPathValue(
  serialized: Record<string, unknown>,
  key: 'entryAbsolutePath' | 'manifestPath',
): string | undefined {
  const value = serialized[key]
  return typeof value === 'string' ? value : undefined
}

function assetGroup(asset: MatOSAsset): string {
  const explicitGroup = optionalString(asset.metadata.group)
  if (explicitGroup) {
    return explicitGroup
  }
  const [topLevel] = asset.id.split('/')
  return topLevel || asset.id
}

function assetFieldValue(asset: MatOSAsset, field: string): unknown {
  switch (field) {
    case 'id':
      return asset.id
    case 'type':
      return asset.type
    case 'name':
      return asset.name
    case 'version':
      return asset.version
    case 'description':
      return asset.description
    case 'canonicalKey':
      return asset.canonicalKey
    case 'group':
      return assetGroup(asset)
    case 'tags':
      return asset.tags
    case 'summary':
      return optionalString(asset.metadata.summary)
    case 'status':
      return asset.lifecycle.status
    case 'source':
      return asset.source
    case 'packId':
      return asset.packId
    case 'packName':
      return asset.packName
    case 'packVersion':
      return asset.packVersion
    case 'path':
      return asset.relativePath
    case 'absolutePath':
      return asset.absolutePath
    case 'entry':
      return asset.entryRelativePath
    case 'entryAbsolutePath':
      return asset.entryAbsolutePath
    case 'manifestPath':
      return asset.manifestPath
    case 'dependencies':
      return asset.dependencies
    case 'mounts':
      return asset.mounts
    case 'runtime':
      return asset.runtime
    case 'lifecycle':
      return asset.lifecycle
    case 'metadata':
      return asset.metadata
    default:
      return undefined
  }
}

function serializeAssetForList(
  asset: MatOSAsset,
  query: AssetQuery,
): Record<string, unknown> {
  if (query.detail === 'full') {
    return serializeAsset(asset)
  }
  const fields = query.fields ?? SUMMARY_FIELDS
  const output: Record<string, unknown> = {}
  for (const field of fields) {
    const value = assetFieldValue(asset, field)
    if (value !== undefined) {
      output[field] = value
    }
  }
  return output
}

function serializeAssetForSearch(
  asset: MatOSAsset,
  query: AssetQuery,
): Record<string, unknown> {
  if (query.detail !== 'full') {
    return serializeAssetForList(asset, query)
  }

  return {
    ...serializeAssetForList(asset, {
      ...query,
      detail: 'summary',
    }),
    fullDetailOmitted: true,
    fullDetailHint:
      `Use asset_show with ref="${asset.canonicalKey}" for complete metadata.`,
  }
}

const METADATA_SEARCH_FIELDS = [
  'summary',
  'aliases',
  'keywords',
  'searchTerms',
  'family',
  'binding',
  'kind',
  'toolReferences',
]

const MATERIALS_SEARCH_SYNONYMS: Array<{
  triggers: string[]
  terms: string[]
}> = [
  {
    triggers: ['dft u', 'dftu', 'hubbard'],
    terms: ['hubbard u', 'dft corrections', 'dft correction'],
  },
  {
    triggers: ['soc', 'spin orbit'],
    terms: ['spin orbit coupling', 'spin orbital coupling', 'soc'],
  },
  {
    triggers: ['convex hull', 'phase stability', 'formation energy'],
    terms: ['convex hull', 'phase stability', 'phase diagram', 'formation energy'],
  },
  {
    triggers: ['cluster job', 'remote job', 'queue job'],
    terms: ['remote compute', 'generate yaml', 'submit'],
  },
  {
    triggers: ['pseudopotential', 'pseudo potential', 'pseudo'],
    terms: ['pseudopotential', 'pseudo potential', 'sssp', 'upf'],
  },
  {
    triggers: ['phonon', 'finite displacement', 'force constant'],
    terms: ['phonon', 'finite displacement', 'force constant', 'thermal properties'],
  },
  {
    triggers: ['neb', 'migration', 'diffusion', 'transition state'],
    terms: ['neb', 'migration barrier', 'diffusion', 'transition state'],
  },
]

function metadataSearchStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(metadataSearchStrings)
  }
  return []
}

function assetSearchParts(asset: MatOSAsset): string[] {
  const metadataParts = METADATA_SEARCH_FIELDS.flatMap(field =>
    metadataSearchStrings(asset.metadata[field]),
  )
  return [
    asset.canonicalKey,
    asset.id,
    asset.type,
    asset.name,
    asset.description,
    asset.tags.join(' '),
    optionalString(asset.metadata.summary),
    ...metadataParts,
    ...asset.dependencies,
    ...Object.values(asset.mounts).flat(),
  ]
    .filter((part): part is string => Boolean(part))
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function queryTokens(value: string): string[] {
  return Array.from(
    new Set(
      normalizeSearchText(value)
        .split(' ')
        .filter(token => token.length >= 3 || /[^\x00-\x7F]/u.test(token)),
    ),
  )
}

function expandedQueryTerms(query: string): string[] {
  const normalized = normalizeSearchText(query)
  const terms = new Set<string>([normalized])
  for (const token of queryTokens(query)) {
    terms.add(token)
  }
  for (const group of MATERIALS_SEARCH_SYNONYMS) {
    if (group.triggers.some(trigger => normalized.includes(normalizeSearchText(trigger)))) {
      for (const term of group.terms) {
        terms.add(normalizeSearchText(term))
      }
    }
  }
  return [...terms].filter(Boolean)
}

function assetQueryScore(asset: MatOSAsset, query: string): number {
  const haystack = normalizeSearchText(assetSearchParts(asset).join('\n'))
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) {
    return 0
  }

  let score = 0
  if (haystack.includes(normalizedQuery)) {
    score += 100 + normalizedQuery.length
  }

  for (const term of expandedQueryTerms(query)) {
    if (!term || term === normalizedQuery) {
      continue
    }
    if (haystack.includes(term)) {
      score += term.includes(' ') ? 16 : 4
    }
  }

  return score
}

function parseAssetQuery(input: unknown): AssetQuery {
  const raw = metadataObject(input)
  return {
    type: optionalString(raw.type),
    query: optionalString(raw.query),
    group: optionalString(raw.group),
    prefix: optionalString(raw.prefix),
    includeDisabled: optionalBoolean(raw.includeDisabled),
    limit: boundedInteger(raw.limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: boundedOffset(raw.offset),
    fields: optionalFields(raw.fields),
    detail: optionalDetail(raw.detail),
    includeGroups: optionalBoolean(raw.includeGroups),
    groupBy: optionalGroupBy(raw.groupBy) ?? 'group',
    groupLimit: boundedInteger(
      raw.groupLimit,
      DEFAULT_GROUP_LIMIT,
      MAX_GROUP_LIMIT,
    ),
    groupOffset: boundedOffset(raw.groupOffset),
    graphRank: optionalBoolean(raw.graphRank),
    graphProfile: optionalAssetGraphProfile(raw.profile),
    seedRefs: optionalStringArray(raw.seedRefs),
  }
}

async function loadRegistry(
  context: MatOSAssetDiscoveryContext,
  includeDisabled = false,
): Promise<MatOSAssetRegistry> {
  return buildMatOSAssetRegistry(await loadDiscoveryAssets(context), {
    includeDisabled,
  })
}

async function loadDiscoveryAssets(
  context: MatOSAssetDiscoveryContext,
): Promise<MatOSAsset[]> {
  const metadata = await readMatOSProjectMetadata(context.cwd, { allowMissing: true })
  const options = { runtimeSnapshot: true, followAcceptedUpdates: metadata.assetVersionPolicy !== 'pinned' }
  const projectAssets = await loadMatOSAssets(context.cwd, options)
  const assetCwd = context.assetCwd?.trim()
  if (!assetCwd || resolve(assetCwd) === resolve(context.cwd)) {
    return projectAssets
  }
  const known = new Set(
    projectAssets.map(asset => asset.canonicalKey || resolve(asset.manifestPath)),
  )
  const merged = [...projectAssets]
  for (const asset of await loadMatOSAssets(assetCwd, options)) {
    const identity = asset.canonicalKey || resolve(asset.manifestPath)
    if (known.has(identity)) continue
    known.add(identity)
    merged.push(asset)
  }
  return merged
}

async function resolveRuntimeAssetInput(context: MatOSAssetDiscoveryContext, registry: MatOSAssetRegistry, raw: Record<string, unknown>) {
  const resolved = resolveAssetInput(registry, raw)
  if (resolved.asset || !resolved.reference?.includes('@') || raw.version || raw.includeDisabled || raw.followUpdates === false) return resolved
  const metadata = await readMatOSProjectMetadata(context.cwd, { allowMissing: true })
  if (metadata.assetVersionPolicy === 'pinned') return resolved
  let pins: unknown = []
  try { pins = JSON.parse(process.env.MATOS_PINNED_ASSET_REFS ?? '[]') } catch { return resolved }
  if (Array.isArray(pins) && pins.includes(resolved.reference)) return resolved
  const latest = registry.resolve(resolved.reference.replace(/@[^@]+$/, ''))
  // Recover stale prompt/display refs only from a verified accepted runtime
  // source. Explicit version queries and local drafts remain exact.
  if (!latest?.manifestPath.includes('/.runtime-snapshots/')) return resolved
  return { asset: latest, reference: resolved.reference }
}

async function loadGraphIndex(
  context: MatOSAssetDiscoveryContext,
  includeDisabled = false,
  options: {
    includeLineage?: boolean
    includeUsage?: boolean
    profile?: MatOSAssetGraphProfile
  } = {},
) {
  const assets = await loadDiscoveryAssets(context)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled })
  return buildMatOSAssetGraphIndex({
    cwd: context.cwd,
    assets,
    registry,
    options: { includeDisabled, ...options },
  })
}

function matchingAssets(
  registry: MatOSAssetRegistry,
  query: AssetQuery,
): MatOSAsset[] {
  const assets = registry.assets
    .filter(asset => !shouldHideAssetFromUserSurface(asset))
    .filter(asset => (query.type ? asset.type === query.type : true))
    .filter(asset => (query.group ? assetGroup(asset) === query.group : true))
    .filter(asset => (query.prefix ? asset.id.startsWith(query.prefix) : true))
  if (!query.query) {
    return assets
  }

  return assets
    .map(asset => ({ asset, score: assetQueryScore(asset, query.query ?? '') }))
    .filter(result => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.asset.canonicalKey.localeCompare(b.asset.canonicalKey),
    )
    .map(result => result.asset)
}

function paginateAssets(assets: MatOSAsset[], query: AssetQuery): MatOSAsset[] {
  const limit = query.limit ?? DEFAULT_LIMIT
  const offset = query.offset ?? 0
  return assets.slice(offset, offset + limit)
}

function assetIdFromGraphKey(assetKey: string): string {
  const afterType = assetKey.includes(':') ? assetKey.split(':').slice(1).join(':') : assetKey
  return afterType.split('@')[0] ?? afterType
}

function graphHitGroupValue(
  hit: MatOSAssetRankedHit,
  groupBy: 'group' | 'type' | 'pack' | 'status',
): string {
  switch (groupBy) {
    case 'type':
      return hit.node.assetType ?? '<none>'
    case 'pack':
      return hit.node.packId ?? '<none>'
    case 'status':
      return hit.node.lifecycleStatus ?? '<none>'
    case 'group':
      return typeof hit.node.metadata?.group === 'string'
        ? hit.node.metadata.group
        : hit.node.assetType ?? '<none>'
  }
}

function graphHitMatchesAssetQuery(
  hit: MatOSAssetRankedHit,
  query: AssetQuery,
): boolean {
  if (query.group && graphHitGroupValue(hit, 'group') !== query.group) {
    return false
  }
  if (query.prefix && !assetIdFromGraphKey(hit.assetKey).startsWith(query.prefix)) {
    return false
  }
  return true
}

function summarizeGraphHitGroups(
  hits: MatOSAssetRankedHit[],
  groupBy: 'group' | 'type' | 'pack' | 'status',
): Array<{ group: string; count: number }> {
  const counts = new Map<string, number>()
  for (const hit of hits) {
    const group = graphHitGroupValue(hit, groupBy)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return [...counts]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group))
}

function groupValue(
  asset: MatOSAsset,
  groupBy: 'group' | 'type' | 'pack' | 'status',
): string {
  switch (groupBy) {
    case 'type':
      return asset.type
    case 'pack':
      return asset.packId ?? '<none>'
    case 'status':
      return asset.lifecycle.status
    case 'group':
      return assetGroup(asset)
  }
}

function summarizeGroups(
  assets: MatOSAsset[],
  groupBy: 'group' | 'type' | 'pack' | 'status',
): Array<{ group: string; count: number }> {
  const counts = new Map<string, number>()
  for (const asset of assets) {
    const group = groupValue(asset, groupBy)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return [...counts]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group))
}

function paginateGroups(
  groups: Array<{ group: string; count: number }>,
  query: AssetQuery,
): {
  groups: Array<{ group: string; count: number }>
  groupCount: number
  groupOffset: number
  groupLimit: number
  groupsHasMore: boolean
} {
  const groupOffset = query.groupOffset ?? 0
  const groupLimit = query.groupLimit ?? DEFAULT_GROUP_LIMIT
  const page = groups.slice(groupOffset, groupOffset + groupLimit)
  return {
    groups: page,
    groupCount: groups.length,
    groupOffset,
    groupLimit,
    groupsHasMore: groupOffset + page.length < groups.length,
  }
}

function sliceUtf8Bytes(
  value: string,
  requestedOffset: number,
  maxBytes: number,
): {
  content: string
  offset: number
  nextOffset?: number
  hasMore: boolean
  totalBytes: number
  partial: boolean
} {
  const bytes = Buffer.from(value, 'utf8')
  let offset = Math.min(requestedOffset, bytes.length)
  // Advance an arbitrary caller-provided offset to the next complete UTF-8
  // code point. Offsets returned by this function are already boundaries.
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) {
    offset += 1
  }
  let end = Math.min(offset + maxBytes, bytes.length)
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1
  }
  const hasMore = end < bytes.length
  return {
    content: bytes.subarray(offset, end).toString('utf8'),
    offset,
    ...(hasMore ? { nextOffset: end } : {}),
    hasMore,
    totalBytes: bytes.length,
    partial: offset > 0 || hasMore,
  }
}

function graphForRole(
  registry: MatOSAssetRegistry,
  reference: string,
  detail: 'summary' | 'full' = 'summary',
): {
  root: string
  assets: unknown[]
  edges: Array<{ from: string; to: string; reference: string }>
} | undefined {
  const root = registry.resolve(reference)
  if (!root || shouldHideAssetFromUserSurface(root)) {
    return undefined
  }

  const subgraph = getMatOSAssetSubgraph(registry, reference).filter(
    asset => !shouldHideAssetFromUserSurface(asset),
  )
  const subgraphKeys = new Set(subgraph.map(asset => asset.canonicalKey))
  const edges: Array<{ from: string; to: string; reference: string }> = []

  for (const asset of subgraph) {
    for (const edgeReference of getMatOSAssetReferences(asset)) {
      const target = registry.resolve(edgeReference)
      if (!target || !subgraphKeys.has(target.canonicalKey)) {
        continue
      }
      edges.push({
        from: asset.canonicalKey,
        to: target.canonicalKey,
        reference: edgeReference,
      })
    }
  }

  return {
    root: root.canonicalKey,
    assets: subgraph.map(asset => serializeAssetForList(asset, { detail })),
    edges,
  }
}

function discoveryToolNames(): string[] {
  return [...MATOS_ASSET_DISCOVERY_TOOL_NAMES]
}

function textSchema(
  properties: Record<string, object>,
  required: string[] = [],
): MatOSAssetDiscoveryTool['inputSchema'] {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export function createMatOSAssetDiscoveryTools(
  context: MatOSAssetDiscoveryContext,
): MatOSAssetDiscoveryTool[] {
  return [
    {
      name: 'asset_context',
      description:
        'Show the current MatOS asset runtime context, selected role, selected user-visible role graph assets, and available asset discovery tools.',
      inputSchema: textSchema({}),
      async call() {
        await recordAssetUsage({
          toolName: 'asset_context',
          selectedRole: context.selectedRole,
          selectedAssetKeys: context.selectedAssetKeys ?? [],
        })
        return jsonResult({
          cwd: workspaceRootValue(),
          selectedRole: context.selectedRole,
          selectedAssetKeys: context.selectedAssetKeys ?? [],
          discoveryTools: discoveryToolNames(),
          note:
            'Use asset_list/search/show/graph/related/impact/lineage/read to inspect active user-visible assets. asset_graph/asset_related/asset_search graphRank default to profile=core so agents see strong asset structure first; use profile=discovery/evidence/full only when weak similarity or runtime evidence is needed. asset_list and asset_search default to compact paginated summaries; use fields, offset/limit, group, prefix, includeGroups, graphRank, or asset_show/detail=full when needed. Internal MatOS skill source is not exposed as a user-facing asset surface.',
        })
      },
    },
    {
      name: 'asset_graph',
      description:
        'Resolve a MatOS role asset graph. Defaults to the current selected role when no role is provided.',
      inputSchema: textSchema({
        role: {
          type: 'string',
          description:
            'Role asset reference, for example role:compute. Defaults to the selected runtime role.',
        },
        ref: {
          type: 'string',
          description:
            'Any asset reference when using mode=dependencies, reverse, lineage, usage, related, or all.',
        },
        mode: {
          type: 'string',
          enum: ['dependencies', 'reverse', 'lineage', 'usage', 'related', 'all'],
          description:
            'Graph mode. Defaults to legacy role dependency graph for compatibility.',
        },
        depth: {
          type: 'integer',
          description: 'Neighborhood depth for non-legacy graph modes. Defaults to 1.',
        },
        profile: {
          type: 'string',
          enum: ['core', 'discovery', 'evidence', 'full'],
          description:
            'Graph profile. Defaults to core for agent use. Use discovery for weak similarity edges, evidence for usage/lineage, full for debugging.',
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary returns compact asset nodes; full returns complete asset metadata.',
        },
      }),
      async call(input) {
        const raw = metadataObject(input)
        const rawMode = optionalString(raw.mode)
        const mode = optionalAssetGraphMode(raw.mode)
        const rawProfile = optionalString(raw.profile)
        const profile = optionalAssetGraphProfile(raw.profile)
        if (rawMode && !mode) {
          return errorResult(
            'Usage: asset_graph mode must be dependencies, reverse, lineage, usage, related, or all',
          )
        }
        if (rawProfile && !profile) {
          return errorResult(
            'Usage: asset_graph profile must be core, discovery, evidence, or full',
          )
        }
        if (mode) {
          const ref = optionalString(raw.ref) ?? optionalString(raw.role) ?? context.selectedRole
          if (!ref) {
            return errorResult('Usage: asset_graph mode requires ref or selected role')
          }
          try {
            const index = await loadGraphIndex(context, false, {
              profile:
                profile ??
                (mode === 'lineage' || mode === 'usage' ? 'evidence' : 'core'),
              includeLineage: mode === 'lineage',
              includeUsage: mode === 'usage',
            })
            if (mode === 'lineage') {
              const lineage = getMatOSAssetLineageTree(index, ref)
              await recordAssetUsage({
                toolName: 'asset_graph',
                ref,
                mode,
                resultCount: lineage.events.length,
              })
              return jsonResult(lineage)
            }
            const graph = getMatOSAssetNeighborhood(index, {
              assetRef: ref,
              direction:
                mode === 'reverse'
                  ? 'reverse'
                  : mode === 'all' || mode === 'related' || mode === 'usage'
                    ? 'all'
                    : 'dependencies',
              depth: boundedInteger(raw.depth, 1, 5),
            })
            const result =
              mode === 'usage'
                ? {
                    ...graph,
                    edges: graph.edges.filter(edge =>
                      edge.kind === 'used_in_session' ||
                      edge.kind === 'used_in_workflow_run',
                    ),
                    nodes: [
                      ...new Set(
                        graph.edges
                          .filter(edge =>
                            edge.kind === 'used_in_session' ||
                            edge.kind === 'used_in_workflow_run',
                          )
                          .flatMap(edge => [edge.from, edge.to]),
                      ),
                    ].sort(),
                  }
                : graph
            await recordAssetUsage({
              toolName: 'asset_graph',
              ref,
              mode,
              resultCount: result.nodes.length,
            })
            return jsonResult(result)
          } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error))
          }
        }

        const role = optionalString(raw.role) ?? context.selectedRole
        if (!role) {
          return errorResult('Usage: asset_graph requires role when no selected role is active')
        }

        const registry = await loadRegistry(context)
        const graph = graphForRole(registry, role, optionalDetail(raw.detail))
        await recordAssetUsage({
          toolName: 'asset_graph',
          role,
          found: Boolean(graph),
          resultCount: graph?.assets.length ?? 0,
        })
        return graph
          ? jsonResult(graph)
          : errorResult(`MatOS role asset not found or disabled: ${role}`)
      },
    },
    {
      name: 'asset_related',
      description:
        'Rank assets related to a selected MatOS asset using graph distance, metadata, and lexical relevance.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Asset reference, for example role:compute or skill:mace-md.',
          },
          query: {
            type: 'string',
            description: 'Optional text query to combine with graph relevance.',
          },
          profile: {
            type: 'string',
            enum: ['core', 'discovery', 'evidence', 'full'],
            description:
              'Graph profile. Defaults to core. Use discovery for weak similarity, evidence for usage/lineage, full for debugging.',
          },
          types: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Optional asset type filter, for example skill,tool,knowledge.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of related assets. Defaults to 50 and caps at 500.',
          },
        },
        ['ref'],
      ),
      async call(input) {
        const raw = metadataObject(input)
        const ref = optionalString(raw.ref)
        const rawProfile = optionalString(raw.profile)
        const profile = optionalAssetGraphProfile(raw.profile)
        if (!ref) {
          return errorResult('Usage: asset_related requires ref')
        }
        if (rawProfile && !profile) {
          return errorResult(
            'Usage: asset_related profile must be core, discovery, evidence, or full',
          )
        }
        try {
          const index = await loadGraphIndex(context, false, {
            profile: profile ?? 'core',
            includeLineage: profile === 'evidence' || profile === 'full',
          })
          const result = getMatOSAssetRelated(index, {
            assetRef: ref,
            query: optionalString(raw.query),
            types: optionalStringArray(raw.types),
            limit: boundedInteger(raw.limit, DEFAULT_LIMIT, MAX_LIMIT),
          })
          await recordAssetUsage({
            toolName: 'asset_related',
            ref,
            resultCount: result.hits.length,
          })
          return jsonResult(result)
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'asset_impact',
      description:
        'Show reverse dependencies and affected assets for a proposed MatOS asset change.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Asset reference to analyze.',
          },
        },
        ['ref'],
      ),
      async call(input) {
        const raw = metadataObject(input)
        const ref = optionalString(raw.ref)
        if (!ref) {
          return errorResult('Usage: asset_impact requires ref')
        }
        try {
          const index = await loadGraphIndex(context, false, { profile: 'core' })
          const result = getMatOSAssetImpact(index, ref)
          await recordAssetUsage({
            toolName: 'asset_impact',
            ref,
            resultCount: result.affectedAssetKeys.length,
          })
          return jsonResult(result)
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'asset_lineage',
      description:
        'Show indexed lineage summary for a MatOS asset. V1 returns compact graph-backed lineage records when present.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Asset reference to inspect.',
          },
        },
        ['ref'],
      ),
      async call(input) {
        const raw = metadataObject(input)
        const ref = optionalString(raw.ref)
        if (!ref) {
          return errorResult('Usage: asset_lineage requires ref')
        }
        try {
          const assets = await loadDiscoveryAssets(context)
          const registry = buildMatOSAssetRegistry(assets)
          const index = await buildMatOSAssetGraphIndex({
            cwd: context.cwd,
            assets,
            registry,
            options: { profile: 'evidence', includeLineage: true },
          })
          const result = getMatOSAssetLineageTree(index, ref)
          await recordAssetUsage({
            toolName: 'asset_lineage',
            ref,
            resultCount: result.events.length,
          })
          return jsonResult(result)
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'asset_list',
      description:
        'List MatOS assets from the active project registry. Disabled assets are hidden unless includeDisabled is true.',
      inputSchema: textSchema({
        type: {
          type: 'string',
          description: 'Optional asset type filter such as role, skill, tool, knowledge, data, workflow, plugin, or mcp.',
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive text filter over id, name, description, tags, and summary.',
        },
        includeDisabled: {
          type: 'boolean',
          description: 'Include disabled assets for inspection. Disabled assets are not runtime-usable.',
        },
        group: {
          type: 'string',
          description: 'Optional top-level asset group filter, for example electronic-structure.',
        },
        prefix: {
          type: 'string',
          description: 'Optional asset id prefix filter, for example electronic-structure/.',
        },
        fields: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description:
            'Optional comma-separated string or array of fields. Defaults to compact summary fields. Use detail=full for complete metadata.',
        },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary returns compact fields; full returns complete asset metadata.',
        },
        offset: {
          type: 'integer',
          description: 'Zero-based pagination offset. Defaults to 0.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of assets to return. Defaults to 50 and caps at 500.',
        },
        includeGroups: {
          type: 'boolean',
          description: 'Include grouped counts for the matched result set before pagination.',
        },
        groupBy: {
          type: 'string',
          enum: ['group', 'type', 'pack', 'status'],
          description: 'Grouping dimension used when includeGroups is true. Defaults to group.',
        },
        groupOffset: {
          type: 'integer',
          description: 'Zero-based pagination offset for grouped counts. Defaults to 0.',
        },
        groupLimit: {
          type: 'integer',
          description: 'Maximum grouped counts to return. Defaults to 50 and caps at 200.',
        },
      }),
      async call(input) {
        const query = parseAssetQuery(input)
        const registry = await loadRegistry(context, query.includeDisabled === true)
        const matches = matchingAssets(registry, query)
        const assets = paginateAssets(matches, query)
        const offset = query.offset ?? 0
        const limit = query.limit ?? DEFAULT_LIMIT
        await recordAssetUsage({
          toolName: 'asset_list',
          query: inputObject(input),
          total: matches.length,
          resultCount: assets.length,
          offset,
          limit,
        })
        const grouped = query.includeGroups
          ? paginateGroups(
              summarizeGroups(matches, query.groupBy ?? 'group'),
              query,
            )
          : undefined
        return jsonResult({
          cwd: workspaceRootValue(),
          total: matches.length,
          count: assets.length,
          offset,
          limit,
          hasMore: offset + assets.length < matches.length,
          ...(grouped ?? {}),
          assets: assets.map(asset => serializeAssetForList(asset, query)),
        })
      },
    },
    {
      name: 'asset_read',
      description:
        'Read the entry file for an active MatOS asset so the agent can use mounted knowledge, data, role prompts, or skill instructions during a run.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Asset reference, for example knowledge:public-reproducibility or skill:materials-compute.',
          },
          id: {
            type: 'string',
            description:
              'Asset id without a type prefix, for example electronic-structure/vasp-bands. Use ref when the type is ambiguous.',
          },
          type: {
            type: 'string',
            description: 'Optional asset type used with id, for example skill.',
          },
          version: {
            type: 'string',
            description: 'Optional asset version used with id.',
          },
          followUpdates: {
            type: 'boolean',
            description: 'Recover stale accepted display refs using the current published version. Defaults to true; false keeps ref exact.',
          },
          maxBytes: {
            type: 'integer',
            minimum: 4,
            description: 'Maximum UTF-8 bytes to return. Defaults to 8000 and caps at 20000.',
          },
          offset: {
            type: 'integer',
            description:
              'UTF-8 byte offset for continued reads. Start at 0, then pass the returned nextOffset while hasMore is true.',
          },
          detail: {
            type: 'string',
            enum: ['summary', 'full'],
            description: 'summary returns compact asset metadata; full returns complete asset metadata.',
          },
          fields: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Optional asset metadata fields to return with the content.',
          },
          jsonPath: {
            type: 'string',
            description:
              'Optional lightweight JSON path for JSON entry files, for example $.items[0].name or $.items[*].id.',
          },
        },
      ),
      async call(input) {
        const raw = metadataObject(input)
        const registry = await loadRegistry(context)
        const resolved = await resolveRuntimeAssetInput(context, registry, raw)
        if (
          !resolved.asset ||
          shouldHideAssetFromUserSurface(resolved.asset)
        ) {
          return errorResult(resolved.error ?? 'MatOS asset not found')
        }
        const asset = resolved.asset
        const reference = resolved.reference ?? asset.canonicalKey

        const path = asset.entryAbsolutePath ?? asset.manifestPath
        const serializedForPath = serializeAsset(asset)
        const visiblePath =
          serializedAssetPathValue(serializedForPath, 'entryAbsolutePath') ??
          serializedAssetPathValue(serializedForPath, 'manifestPath') ??
          asset.entryRelativePath ??
          asset.relativePath
        const maxBytes = boundedReadBytes(raw.maxBytes)
        const requestedOffset = boundedOffset(raw.offset)
        const rawContent = await readFile(path, 'utf8')
        const jsonPath = optionalString(raw.jsonPath)
        let selected: unknown
        let contentSource = rawContent
        if (jsonPath) {
          try {
            selected = applyJsonPath(rawContent, jsonPath)
            contentSource = JSON.stringify(selected)
          } catch (error) {
            return errorResult(
              `asset_read jsonPath failed for ${reference}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        }
        const page = sliceUtf8Bytes(contentSource, requestedOffset, maxBytes)
        await recordAssetUsage({
          toolName: 'asset_read',
          assetKey: asset.canonicalKey,
          reference,
          path: visiblePath,
          jsonPath,
          maxBytes,
          offset: page.offset,
          nextOffset: page.nextOffset,
          hasMore: page.hasMore,
          totalBytes: page.totalBytes,
          contentBytes: Buffer.byteLength(page.content, 'utf8'),
          truncated: page.partial,
        })

        return jsonResult({
          asset: serializeAssetForList(asset, {
            fields: optionalFields(raw.fields),
            detail: optionalDetail(raw.detail),
          }),
          path: visiblePath,
          ...(jsonPath
            ? page.partial
              ? { jsonPath, selectedTruncated: true }
              : { jsonPath, selected }
            : {}),
          content: page.content,
          offset: page.offset,
          maxBytes,
          totalBytes: page.totalBytes,
          hasMore: page.hasMore,
          ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
          truncated: page.partial,
        })
      },
    },
    {
      name: 'asset_search',
      description:
        'Search active MatOS assets by text over id, name, description, tags, and summary.',
      inputSchema: textSchema(
        {
          query: {
            type: 'string',
            description: 'Case-insensitive search text.',
          },
          type: {
            type: 'string',
            description: 'Optional asset type filter.',
          },
          includeDisabled: {
            type: 'boolean',
            description: 'Include disabled assets for inspection. Disabled assets are not runtime-usable.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of assets to return. Defaults to 50 and caps at 500.',
          },
          fields: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description:
              'Optional fields to include for each search hit. Defaults to compact summary fields.',
          },
          detail: {
            type: 'string',
            enum: ['summary', 'full'],
            description:
              'summary returns compact fields. For search, full preserves compact hits and adds an asset_show hint to avoid oversized broad-search results.',
          },
          offset: {
            type: 'integer',
            description: 'Zero-based pagination offset. Defaults to 0.',
          },
          graphRank: {
            type: 'boolean',
            description:
              'Use the shared asset graph ranking engine and return explainable hits.',
          },
          profile: {
            type: 'string',
            enum: ['core', 'discovery', 'evidence', 'full'],
            description:
              'Graph profile for graphRank. Defaults to core so weak tag/group edges do not dominate broad searches.',
          },
          seedRefs: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description:
              'Optional seed asset refs used by graphRank for graph-distance boosts.',
          },
          includeGroups: {
            type: 'boolean',
            description: 'Include paginated grouped counts for the matched result set.',
          },
          groupBy: {
            type: 'string',
            enum: ['group', 'type', 'pack', 'status'],
            description: 'Grouping dimension used when includeGroups is true. Defaults to group.',
          },
          groupOffset: {
            type: 'integer',
            description: 'Zero-based pagination offset for grouped counts. Defaults to 0.',
          },
          groupLimit: {
            type: 'integer',
            description: 'Maximum grouped counts to return. Defaults to 50 and caps at 200.',
          },
        },
        ['query'],
      ),
      async call(input) {
        const query = parseAssetQuery(input)
        if (!query.query) {
          return errorResult('Usage: asset_search requires query')
        }
        if (optionalString(inputObject(input).profile) && !query.graphProfile) {
          return errorResult(
            'Usage: asset_search profile must be core, discovery, evidence, or full',
          )
        }

        if (query.graphRank) {
          const index = await loadGraphIndex(
            context,
            query.includeDisabled === true,
            {
              profile: query.graphProfile ?? 'core',
            },
          )
          const offset = query.offset ?? 0
          const limit = query.limit ?? DEFAULT_LIMIT
          const hits = rankMatOSAssets({
            index,
            query: query.query,
            seedRefs: query.seedRefs ?? (context.selectedRole ? [context.selectedRole] : undefined),
            assetTypes: query.type ? [query.type] : undefined,
          }).filter(hit => graphHitMatchesAssetQuery(hit, query))
          const pageHits = hits.slice(offset, offset + limit)
          const groups = query.includeGroups
            ? paginateGroups(
                summarizeGraphHitGroups(hits, query.groupBy ?? 'group'),
                query,
              )
            : undefined
          await recordAssetUsage({
            toolName: 'asset_search',
            query: inputObject(input),
            graphRank: true,
            total: hits.length,
            resultCount: pageHits.length,
            offset,
            limit,
          })
          return jsonResult({
            cwd: workspaceRootValue(),
            query: query.query,
            graphRank: true,
            total: hits.length,
            count: pageHits.length,
            offset,
            limit,
            hasMore: offset + pageHits.length < hits.length,
            hits: pageHits,
            assets: pageHits.map(serializeMatOSGraphRankedAsset),
            ...(groups ?? {}),
          })
        }

        const registry = await loadRegistry(context, query.includeDisabled === true)
        const matches = matchingAssets(registry, query)
        const assets = paginateAssets(matches, query)
        const offset = query.offset ?? 0
        const limit = query.limit ?? DEFAULT_LIMIT
        const grouped = query.includeGroups
          ? paginateGroups(
              summarizeGroups(matches, query.groupBy ?? 'group'),
              query,
            )
          : undefined
        await recordAssetUsage({
          toolName: 'asset_search',
          query: inputObject(input),
          total: matches.length,
          resultCount: assets.length,
          offset,
          limit,
        })
        return jsonResult({
          cwd: workspaceRootValue(),
          query: query.query,
          total: matches.length,
          count: assets.length,
          offset,
          limit,
          hasMore: offset + assets.length < matches.length,
          ...(grouped ?? {}),
          ...(query.detail === 'full'
            ? {
                fullDetailLimited: true,
                fullDetailHint:
                  'asset_search is for discovery and keeps broad results compact. Use asset_show for complete metadata of a chosen asset.',
              }
            : {}),
          assets: assets.map(asset => serializeAssetForSearch(asset, query)),
        })
      },
    },
    {
      name: 'asset_show',
      description:
        'Show one MatOS asset and its lifecycle status, mounts, dependencies, metadata, and file locations.',
      inputSchema: textSchema(
        {
          ref: {
            type: 'string',
            description: 'Asset reference, for example role:compute or skill:materials-compute.',
          },
          id: {
            type: 'string',
            description:
              'Asset id without a type prefix, for example electronic-structure/vasp-bands. Use ref when the type is ambiguous.',
          },
          type: {
            type: 'string',
            description: 'Optional asset type used with id, for example skill.',
          },
          version: {
            type: 'string',
            description: 'Optional asset version used with id.',
          },
          followUpdates: {
            type: 'boolean',
            description: 'Recover stale accepted display refs using the current published version. Defaults to true; false keeps ref exact.',
          },
          includeDisabled: {
            type: 'boolean',
            description: 'Allow showing disabled assets for inspection.',
          },
        },
      ),
      async call(input) {
        const raw = metadataObject(input)
        const registry = await loadRegistry(
          context,
          optionalBoolean(raw.includeDisabled) === true,
        )
        const resolved = await resolveRuntimeAssetInput(context, registry, raw)
        if (
          !resolved.asset ||
          shouldHideAssetFromUserSurface(resolved.asset)
        ) {
          return errorResult(resolved.error ?? 'MatOS asset not found')
        }
        await recordAssetUsage({
          toolName: 'asset_show',
          assetKey: resolved.asset.canonicalKey,
          reference: resolved.reference,
        })
        return jsonResult({ asset: serializeAsset(resolved.asset) })
      },
    },
  ]
}
