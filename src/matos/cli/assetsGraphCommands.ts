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

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildMatOSAssetGraphIndex } from '../assets/graph/buildGraphIndex.js'
import {
  getMatOSAssetImpact,
  getMatOSAssetLineageTree,
  getMatOSAssetNeighborhood,
  getMatOSAssetRelated,
} from '../assets/graph/queries.js'
import { rankMatOSAssets } from '../assets/graph/relevance.js'
import { serializeMatOSGraphRankedAsset } from '../assets/graph/rankedAssetSummary.js'
import type {
  MatOSAssetGraphIndex,
  MatOSAssetGraphProfile,
} from '../assets/graph/types.js'
import { matOSUsageWorkflowRunsDirs } from '../assets/graph/usageGraph.js'
import { buildMatOSAssetWorkbenchState } from '../assets/graph/viewModels.js'
import { loadMatOSRuntimeAssets as loadMatOSAssets } from '../assets/loadAssets.js'
import {
  buildMatOSAssetRegistry,
  getMatOSAssetReferences,
  getMatOSAssetSubgraph,
  type MatOSAssetRegistry,
} from '../assets/registry.js'
import { shouldHideAssetFromUserSurface } from '../assets/sourceVisibility.js'
import { getMatOSDir } from '../project.js'
import {
  assetMatchesQuery,
  formatAsset,
  serializeAsset,
  serializeAssetSummary,
  type MatOSAssetsIO,
  type ParsedArgs,
  writeJson,
} from './assetsCliShared.js'

function buildGraph(
  registry: MatOSAssetRegistry,
  rootReference: string,
): Record<string, unknown> | undefined {
  const root = registry.resolve(rootReference)
  if (!root || shouldHideAssetFromUserSurface(root)) {
    return undefined
  }

  const subgraph = getMatOSAssetSubgraph(registry, rootReference).filter(
    asset => !shouldHideAssetFromUserSurface(asset),
  )
  const subgraphKeys = new Set(subgraph.map(asset => asset.canonicalKey))
  const edges: Array<{ from: string; to: string; reference: string }> = []

  for (const asset of subgraph) {
    for (const reference of getMatOSAssetReferences(asset)) {
      const target = registry.resolve(reference)
      if (!target || !subgraphKeys.has(target.canonicalKey)) {
        continue
      }
      edges.push({
        from: asset.canonicalKey,
        to: target.canonicalKey,
        reference,
      })
    }
  }

  return {
    root: root.canonicalKey,
    assets: subgraph.map(serializeAsset),
    edges,
  }
}

export async function graphAssets(
  io: MatOSAssetsIO,
  reference: string | undefined,
  json: boolean,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos assets graph --role <role-ref>\n')
    return 1
  }

  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(io.cwd))
  const graph = buildGraph(registry, reference)
  if (!graph) {
    io.stderr(`MatOS asset not found: ${reference}\n`)
    return 1
  }

  if (json) {
    writeJson(io, graph)
    return 0
  }

  for (const asset of graph.assets as Array<{ canonicalKey: string }>) {
    io.stdout(`${asset.canonicalKey}\n`)
  }
  return 0
}

async function buildAssetGraphIndexForCli(
  io: MatOSAssetsIO,
  options: ParsedArgs,
) {
  const assets = await loadMatOSAssets(io.cwd)
  const registry = buildMatOSAssetRegistry(assets, {
    includeDisabled: options.includeDisabled,
  })
  return buildMatOSAssetGraphIndex({
    cwd: io.cwd,
    assets,
    registry,
    options: {
      profile: options.graphProfile,
      includeDisabled: options.includeDisabled,
      includeLineage: options.includeLineage,
      includeUsage: options.includeUsage,
    },
  })
}

type MatOSAssetGraphCacheSourceSummary = {
  count: number
  newestMtimeMs?: number
  truncated?: boolean
}

type MatOSAssetGraphCacheMetadata = {
  schemaVersion: 1
  purpose: 'audit'
  indexPath: string
  generatedAt: string
  graphSchemaVersion: MatOSAssetGraphIndex['schemaVersion']
  providerCount: number
  optionKey: string
  options: {
    profile?: MatOSAssetGraphProfile
    includeDisabled?: boolean
    includeLineage?: boolean
    includeUsage?: boolean
  }
  stats: MatOSAssetGraphIndex['stats']
  sources: {
    assets: MatOSAssetGraphCacheSourceSummary
    assetHistory: MatOSAssetGraphCacheSourceSummary
    evolution: MatOSAssetGraphCacheSourceSummary
    workflowRuns: MatOSAssetGraphCacheSourceSummary
  }
}

async function summarizePathMtimes(
  paths: string[],
  options: { recursiveDepth?: number; maxEntries?: number } = {},
): Promise<MatOSAssetGraphCacheSourceSummary> {
  const recursiveDepth = options.recursiveDepth ?? 0
  const maxEntries = options.maxEntries ?? 1000
  let count = 0
  let truncated = false
  let newestMtimeMs: number | undefined

  async function visit(path: string, depth: number): Promise<void> {
    if (count >= maxEntries) {
      truncated = true
      return
    }
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch {
      return
    }
    count += 1
    newestMtimeMs =
      newestMtimeMs === undefined
        ? info.mtimeMs
        : Math.max(newestMtimeMs, info.mtimeMs)
    if (!info.isDirectory() || depth <= 0 || count >= maxEntries) {
      return
    }
    let entries: string[]
    try {
      entries = await readdir(path)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      await visit(join(path, entry), depth - 1)
      if (count >= maxEntries) {
        truncated = true
        return
      }
    }
  }

  for (const path of paths) {
    await visit(path, recursiveDepth)
    if (count >= maxEntries) {
      truncated = true
      break
    }
  }

  return {
    count,
    ...(newestMtimeMs === undefined ? {} : { newestMtimeMs }),
    ...(truncated ? { truncated: true } : {}),
  }
}

async function buildAssetGraphCacheMetadata(
  io: MatOSAssetsIO,
  index: MatOSAssetGraphIndex,
  options: ParsedArgs,
): Promise<MatOSAssetGraphCacheMetadata> {
  const assets = await loadMatOSAssets(io.cwd)
  const matosDir = getMatOSDir(io.cwd)
  const assetSourcePaths = assets.flatMap(asset =>
    [asset.manifestPath, asset.entryAbsolutePath].filter(
      (path): path is string => typeof path === 'string' && path.length > 0,
    ),
  )

  return {
    schemaVersion: 1,
    purpose: 'audit',
    indexPath: 'assets.graph.v1.json',
    generatedAt: index.generatedAt,
    graphSchemaVersion: index.schemaVersion,
    providerCount: index.stats.providerCount,
    optionKey: JSON.stringify({
      includeDisabled: options.includeDisabled === true,
      includeLineage: options.includeLineage === true,
      includeUsage: options.includeUsage === true,
      ...(options.graphProfile ? { profile: options.graphProfile } : {}),
    }),
    options: {
      ...(options.graphProfile ? { profile: options.graphProfile } : {}),
      ...(options.includeDisabled ? { includeDisabled: true } : {}),
      ...(options.includeLineage ? { includeLineage: true } : {}),
      ...(options.includeUsage ? { includeUsage: true } : {}),
    },
    stats: index.stats,
    sources: {
      assets: await summarizePathMtimes(assetSourcePaths),
      assetHistory: await summarizePathMtimes(
        [join(matosDir, 'asset-history')],
        { recursiveDepth: 3, maxEntries: 1000 },
      ),
      evolution: await summarizePathMtimes(
        [join(matosDir, 'evolution')],
        { recursiveDepth: 4, maxEntries: 1000 },
      ),
      workflowRuns: await summarizePathMtimes(
        matOSUsageWorkflowRunsDirs(io.cwd),
        { recursiveDepth: 3, maxEntries: 1000 },
      ),
    },
  }
}

export async function graphIndexAssets(
  io: MatOSAssetsIO,
  options: ParsedArgs,
): Promise<number> {
  const index = await buildAssetGraphIndexForCli(io, options)
  let path: string | undefined
  let metaPath: string | undefined

  if (options.write) {
    const indexDir = join(getMatOSDir(io.cwd), 'index')
    await mkdir(indexDir, { recursive: true })
    path = join(indexDir, 'assets.graph.v1.json')
    metaPath = join(indexDir, 'assets.graph.v1.meta.json')
    await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    const metadata = await buildAssetGraphCacheMetadata(io, index, options)
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  }

  if (options.json) {
    writeJson(
      io,
      path
        ? {
            ...index,
            path: '.matos/index/assets.graph.v1.json',
            metaPath: '.matos/index/assets.graph.v1.meta.json',
          }
        : index,
    )
    return 0
  }

  io.stdout(
    `MatOS asset graph index: ${index.stats.nodeCount} nodes, ${index.stats.edgeCount} edges\n`,
  )
  if (path) {
    io.stdout('.matos/index/assets.graph.v1.json\n')
    if (metaPath) {
      io.stdout('.matos/index/assets.graph.v1.meta.json\n')
    }
  }
  return 0
}

export async function relatedAssets(
  io: MatOSAssetsIO,
  reference: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos assets related <asset-ref>\n')
    return 1
  }
  try {
    const index = await buildAssetGraphIndexForCli(io, {
      ...options,
      graphProfile: options.graphProfile ?? 'core',
    })
    const result = getMatOSAssetRelated(index, {
      assetRef: reference,
      query: options.query,
      types: options.types,
      limit: options.limit,
    })
    if (options.json) {
      writeJson(io, result)
    } else {
      for (const hit of result.hits) {
        io.stdout(`${hit.assetKey}\t${hit.score}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function impactAssets(
  io: MatOSAssetsIO,
  reference: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos assets impact <asset-ref>\n')
    return 1
  }
  try {
    const index = await buildAssetGraphIndexForCli(io, {
      ...options,
      graphProfile: options.graphProfile ?? 'core',
    })
    const result = getMatOSAssetImpact(index, reference)
    if (options.json) {
      writeJson(io, result)
    } else {
      for (const assetKey of result.affectedAssetKeys) {
        io.stdout(`${assetKey}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function lineageAssets(
  io: MatOSAssetsIO,
  reference: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos assets lineage <asset-ref>\n')
    return 1
  }
  try {
    const index = await buildAssetGraphIndexForCli(io, {
      ...options,
      graphProfile: options.graphProfile ?? 'evidence',
      includeLineage: true,
    })
    const result = getMatOSAssetLineageTree(index, reference)
    if (options.json) {
      writeJson(io, result)
    } else {
      for (const event of result.events) {
        io.stdout(`${event.nodeId}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function workbenchAssets(
  io: MatOSAssetsIO,
  reference: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  try {
    const mode = options.mode ?? 'explore'
    const index = await buildAssetGraphIndexForCli(io, {
      ...options,
      includeLineage: options.includeLineage || mode === 'lineage',
      includeUsage: options.includeUsage,
    })
    const state = buildMatOSAssetWorkbenchState({
      index,
      mode,
      query: options.query,
      selectedAssetRef: reference ?? options.ref ?? options.role,
      depth: 1,
      direction: options.direction ?? 'all',
      types: options.types ?? (options.type ? [options.type] : undefined),
      limit: options.limit,
    })

    if (options.json) {
      writeJson(io, state)
      return 0
    }

    io.stdout(
      `${state.mode}\tnodes=${state.graph.summary.nodeCount}\tedges=${state.graph.summary.edgeCount}\n`,
    )
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function searchAssets(
  io: MatOSAssetsIO,
  query: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  const effectiveQuery = query ?? options.query
  if (!effectiveQuery) {
    io.stderr('Usage: matos assets search <query> [--graph-rank]\n')
    return 1
  }

  if (options.graphRank) {
    const index = await buildAssetGraphIndexForCli(io, {
      ...options,
      graphProfile: options.graphProfile ?? 'core',
    })
    const offset = options.offset ?? 0
    const limit = options.limit ?? 50
    const hits = rankMatOSAssets({
      index,
      query: effectiveQuery,
      assetTypes: options.types ?? (options.type ? [options.type] : undefined),
      seedRefs: options.role ? [options.role] : undefined,
    })
    const pageHits = hits.slice(offset, offset + limit)
    if (options.json) {
      writeJson(io, {
        query: effectiveQuery,
        graphRank: true,
        total: hits.length,
        count: pageHits.length,
        offset,
        limit,
        hasMore: offset + pageHits.length < hits.length,
        hits: pageHits,
        assets: pageHits.map(serializeMatOSGraphRankedAsset),
      })
    } else {
      for (const hit of pageHits) {
        io.stdout(`${hit.assetKey}\t${hit.score}\n`)
      }
    }
    return 0
  }

  const assets = (await loadMatOSAssets(io.cwd))
    .filter(asset => !shouldHideAssetFromUserSurface(asset))
    .filter(asset =>
      (options.type ? asset.type === options.type : true) &&
      assetMatchesQuery(asset, effectiveQuery),
    )
  if (options.json) {
    writeJson(io, {
      query: effectiveQuery,
      graphRank: false,
      assets: assets.map(asset => serializeAssetSummary(asset, options.fields)),
    })
  } else {
    for (const asset of assets) {
      io.stdout(formatAsset(asset))
    }
  }
  return 0
}

export async function neighborhoodAssets(
  io: MatOSAssetsIO,
  reference: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos assets neighborhood <asset-ref>\n')
    return 1
  }
  try {
    const index = await buildAssetGraphIndexForCli(io, {
      ...options,
      graphProfile: options.graphProfile ?? 'core',
    })
    const result = getMatOSAssetNeighborhood(index, {
      assetRef: reference,
      direction: options.direction ?? 'dependencies',
      depth: options.limit ?? 1,
    })
    if (options.json) {
      writeJson(io, result)
    } else {
      for (const node of result.nodes) {
        io.stdout(`${node}\n`)
      }
    }
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
