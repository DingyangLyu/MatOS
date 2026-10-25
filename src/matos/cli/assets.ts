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
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadMatOSAssets, loadMatOSRuntimeAssets } from '../assets/loadAssets.js'
import {
  setMatOSAssetLifecycleStatus,
  summarizeMatOSAssetLifecycle,
} from '../assets/lifecycle.js'
import { projectMatOSRoleToRuntime } from '../assets/projectRuntime.js'
import {
  buildMatOSAssetRegistry,
  writeMatOSAssetIndex,
} from '../assets/registry.js'
import type { MatOSAsset, MatOSAssetValidationResult } from '../assets/types.js'
import { buildUsageGraphProviderResult } from '../assets/graph/usageGraph.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { shouldHideAssetFromUserSurface } from '../assets/sourceVisibility.js'
import {
  getMatOSDir,
  readMatOSProjectConfig,
  writeMatOSProjectConfig,
  type MatOSAssetMountConfig,
} from '../project.js'
import {
  createMatOSAssetHistorySnapshot,
  diffMatOSAssetHistorySnapshots,
  listMatOSAssetHistoryReleasesWithIssues,
  listMatOSAssetHistorySnapshots,
  listMatOSAssetHistorySnapshotsWithIssues,
  matOSAssetHistoryLatestRef,
  matOSAssetHistoryStableRef,
  readMatOSAssetHistoryRelease,
  readMatOSAssetHistorySnapshot,
  restoreMatOSAssetHistorySnapshot,
  validateMatOSAssetHistorySnapshot,
  withMatOSAssetHistoryLock,
  type MatOSAssetHistoryScope,
} from '../assets/history/index.js'
import { assetHistoryGitDir, git } from '../assets/history/gitBackend.js'
import { isScopedAssetArchiveCaller } from '../assets/history/archive.js'
import {
  createMatOSAssetRelease,
  rollbackMatOSAssetRelease,
} from '../assets/history/releaseService.js'
import {
  hasMatOSSecretLookingContent,
  isMatOSSecretLookingFileName,
} from '../assets/secretScan.js'
import { resolveMatOSDeploymentRoots } from '../runtime/deploymentRoots.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import {
  assetMatchesQuery,
  formatAsset,
  groupAssetSummaries,
  objectRecord,
  serializeAsset,
  serializeAssetCompact,
  serializeAssetSummary,
  type MatOSAssetsIO,
  type ParsedArgs,
  wantsSummaryList,
  writeJson,
} from './assetsCliShared.js'
import {
  graphAssets,
  graphIndexAssets,
  impactAssets,
  lineageAssets,
  neighborhoodAssets,
  relatedAssets,
  searchAssets,
  workbenchAssets,
} from './assetsGraphCommands.js'
import {
  runAssetGitCommand,
  runAssetSourcesCommand,
} from './assetsSourceGitCommands.js'

async function collectAssetSourceProvenanceForHistory(
  cwd: string,
): Promise<Record<string, unknown>[]> {
  try {
    const assets = await loadMatOSAssets(cwd)
    const seen = new Set<string>()
    const provenance: Record<string, unknown>[] = []
    for (const asset of assets) {
      const sourceProvenance = objectRecord(asset.metadata.sourceProvenance)
      if (Object.keys(sourceProvenance).length === 0) {
        continue
      }
      const key = JSON.stringify(sourceProvenance)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      provenance.push(sourceProvenance)
    }
    return provenance
  } catch {
    return []
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    summary: false,
    compact: false,
    forceStale: false,
    dryRun: false,
    push: false,
    replace: false,
    overwrite: false,
    registerSource: false,
    excludeRuntime: false,
    refreshWorkspaces: false,
    includeDisabled: false,
    write: false,
    includeLineage: false,
    includeUsage: false,
    graphRank: false,
    autoOnly: false,
    llm: false,
    reviewed: false,
    benchmarkPassed: false,
    judgePassed: false,
    apply: false,
    stale: false,
    duplicates: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--summary') {
      parsed.summary = true
    } else if (arg === '--compact') {
      parsed.compact = true
    } else if (arg === '--replace') {
      parsed.replace = true
    } else if (arg === '--overwrite') {
      parsed.overwrite = true
    } else if (arg === '--register-source') {
      parsed.registerSource = true
    } else if (arg === '--exclude-runtime') {
      parsed.excludeRuntime = true
    } else if (arg === '--push') {
      parsed.push = true
    } else if (arg === '--refresh-workspaces') {
      parsed.refreshWorkspaces = true
    } else if (arg === '--include-disabled') {
      parsed.includeDisabled = true
    } else if (arg === '--write') {
      parsed.write = true
    } else if (arg === '--include-lineage') {
      parsed.includeLineage = true
    } else if (arg === '--include-usage') {
      parsed.includeUsage = true
    } else if (arg === '--stale') {
      parsed.stale = true
    } else if (arg === '--stale-days') {
      parsed.staleDays = Number.parseInt(args[index + 1] ?? '', 10)
      if (!Number.isInteger(parsed.staleDays) || parsed.staleDays <= 0) {
        parsed.error = '--stale-days must be a positive integer'
      }
      index += 1
    } else if (arg?.startsWith('--stale-days=')) {
      parsed.staleDays = Number.parseInt(arg.slice('--stale-days='.length), 10)
      if (!Number.isInteger(parsed.staleDays) || parsed.staleDays <= 0) {
        parsed.error = '--stale-days must be a positive integer'
      }
    } else if (arg === '--duplicates') {
      parsed.duplicates = true
    } else if (arg === '--graph-rank') {
      parsed.graphRank = true
    } else if (arg === '--profile') {
      parsed.graphProfile = parseGraphProfile(args[index + 1])
      if (!parsed.graphProfile) {
        parsed.error = '--profile must be core, discovery, evidence, or full'
      }
      index += 1
    } else if (arg?.startsWith('--profile=')) {
      parsed.graphProfile = parseGraphProfile(arg.slice('--profile='.length))
      if (!parsed.graphProfile) {
        parsed.error = '--profile must be core, discovery, evidence, or full'
      }
    } else if (arg === '--auto-only') {
      parsed.autoOnly = true
    } else if (arg === '--llm') {
      parsed.llm = true
    } else if (arg === '--reviewed') {
      parsed.reviewed = true
    } else if (arg === '--benchmark-passed') {
      parsed.benchmarkPassed = true
    } else if (arg === '--judge-passed') {
      parsed.judgePassed = true
    } else if (arg === '--apply') {
      parsed.apply = true
    } else if (arg === '--mode') {
      parsed.mode = parseWorkbenchMode(args[index + 1])
      if (!parsed.mode) {
        parsed.error = '--mode must be explore, lineage, impact, validate, or raw'
      }
      index += 1
    } else if (arg?.startsWith('--mode=')) {
      parsed.mode = parseWorkbenchMode(arg.slice('--mode='.length))
      if (!parsed.mode) {
        parsed.error = '--mode must be explore, lineage, impact, validate, or raw'
      }
    } else if (arg === '--force-stale') {
      parsed.forceStale = true
    } else if (arg === '--dry-run') {
      parsed.dryRun = true
    } else if (arg === '--types') {
      parsed.types = parseFields(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--types=')) {
      parsed.types = parseFields(arg.slice('--types='.length))
    } else if (arg === '--direction') {
      parsed.direction = parseDirection(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--direction=')) {
      parsed.direction = parseDirection(arg.slice('--direction='.length))
    } else if (arg === '--scope') {
      const rawScope = args[index + 1]
      parsed.rawScope = rawScope
      const scope = parseAssetScope(rawScope)
      if (scope) {
        parsed.scope = scope
      }
      index += 1
    } else if (arg?.startsWith('--scope=')) {
      const rawScope = arg.slice('--scope='.length)
      parsed.rawScope = rawScope
      const scope = parseAssetScope(rawScope)
      if (scope) {
        parsed.scope = scope
      }
    } else if (arg === '--ref') {
      parsed.ref = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--ref=')) {
      parsed.ref = arg.slice('--ref='.length)
    } else if (arg === '--asset') {
      parsed.asset = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--asset=')) {
      parsed.asset = arg.slice('--asset='.length)
    } else if (arg === '--type') {
      parsed.type = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--type=')) {
      parsed.type = arg.slice('--type='.length)
    } else if (arg === '--role') {
      parsed.role = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--role=')) {
      parsed.role = arg.slice('--role='.length)
    } else if (arg === '--id') {
      parsed.id = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--id=')) {
      parsed.id = arg.slice('--id='.length)
    } else if (arg === '--name') {
      parsed.name = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--name=')) {
      parsed.name = arg.slice('--name='.length)
    } else if (arg === '--version') {
      parsed.version = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--version=')) {
      parsed.version = arg.slice('--version='.length)
    } else if (arg === '--url') {
      parsed.urls = [...(parsed.urls ?? []), args[index + 1] ?? '']
      index += 1
    } else if (arg?.startsWith('--url=')) {
      parsed.urls = [...(parsed.urls ?? []), arg.slice('--url='.length)]
    } else if (arg === '--doi') {
      parsed.doi = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--doi=')) {
      parsed.doi = arg.slice('--doi='.length)
    } else if (arg === '--path') {
      parsed.path = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--path=')) {
      parsed.path = arg.slice('--path='.length)
    } else if (arg === '--description') {
      parsed.description = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--description=')) {
      parsed.description = arg.slice('--description='.length)
    } else if (arg === '--domain') {
      parsed.domain = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--domain=')) {
      parsed.domain = arg.slice('--domain='.length)
    } else if (arg === '--tag') {
      parsed.tags = [...(parsed.tags ?? []), args[index + 1] ?? '']
      index += 1
    } else if (arg?.startsWith('--tag=')) {
      parsed.tags = [...(parsed.tags ?? []), arg.slice('--tag='.length)]
    } else if (arg === '--pack') {
      parsed.pack = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--pack=')) {
      parsed.pack = arg.slice('--pack='.length)
    } else if (arg === '--tos-archive') {
      parsed.tosArchive = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--tos-archive=')) {
      parsed.tosArchive = arg.slice('--tos-archive='.length)
    } else if (arg === '--entry-file') {
      parsed.entryFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--entry-file=')) {
      parsed.entryFile = arg.slice('--entry-file='.length)
    } else if (arg === '--entry-name') {
      parsed.entryName = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--entry-name=')) {
      parsed.entryName = arg.slice('--entry-name='.length)
    } else if (arg === '--input-file') {
      parsed.inputFile = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--input-file=')) {
      parsed.inputFile = arg.slice('--input-file='.length)
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = Number(arg.slice('--timeout-ms='.length))
    } else if (arg === '--require-path') {
      parsed.requirePath = true
    } else if (arg === '--repo') {
      parsed.repo = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--repo=')) {
      parsed.repo = arg.slice('--repo='.length)
    } else if (arg === '--clone-url') {
      parsed.cloneUrl = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--clone-url=')) {
      parsed.cloneUrl = arg.slice('--clone-url='.length)
    } else if (arg === '--base-url') {
      parsed.baseUrl = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--base-url=')) {
      parsed.baseUrl = arg.slice('--base-url='.length)
    } else if (arg === '--api-url') {
      parsed.apiUrl = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--api-url=')) {
      parsed.apiUrl = arg.slice('--api-url='.length)
    } else if (arg === '--branch') {
      parsed.branch = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--branch=')) {
      parsed.branch = arg.slice('--branch='.length)
    } else if (arg === '--from-source') {
      parsed.fromSource = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--from-source=')) {
      parsed.fromSource = arg.slice('--from-source='.length)
    } else if (arg === '--to-source') {
      parsed.toSource = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--to-source=')) {
      parsed.toSource = arg.slice('--to-source='.length)
    } else if (arg === '--previous-upstream-source') {
      parsed.previousUpstreamSource = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--previous-upstream-source=')) {
      parsed.previousUpstreamSource = arg.slice(
        '--previous-upstream-source='.length,
      )
    } else if (arg === '--from') {
      parsed.fromRef = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--from=')) {
      parsed.fromRef = arg.slice('--from='.length)
    } else if (arg === '--source') {
      parsed.sourceBranch = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--source=')) {
      parsed.sourceBranch = arg.slice('--source='.length)
    } else if (arg === '--target') {
      parsed.targetBranch = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--target=')) {
      parsed.targetBranch = arg.slice('--target='.length)
    } else if (arg === '--channel') {
      parsed.channel = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--channel=')) {
      parsed.channel = arg.slice('--channel='.length)
    } else if (arg === '--title') {
      parsed.title = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--title=')) {
      parsed.title = arg.slice('--title='.length)
    } else if (arg === '--body') {
      parsed.body = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--body=')) {
      parsed.body = arg.slice('--body='.length)
    } else if (arg === '--message') {
      parsed.message = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--message=')) {
      parsed.message = arg.slice('--message='.length)
    } else if (arg === '--model') {
      parsed.model = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--model=')) {
      parsed.model = arg.slice('--model='.length)
    } else if (arg === '--member') {
      parsed.members = [...(parsed.members ?? []), ...(parseFields(args[index + 1]) ?? [])]
      index += 1
    } else if (arg?.startsWith('--member=')) {
      parsed.members = [
        ...(parsed.members ?? []),
        ...(parseFields(arg.slice('--member='.length)) ?? []),
      ]
    } else if (arg === '--admin') {
      parsed.admins = [...(parsed.admins ?? []), ...(parseFields(args[index + 1]) ?? [])]
      index += 1
    } else if (arg?.startsWith('--admin=')) {
      parsed.admins = [
        ...(parsed.admins ?? []),
        ...(parseFields(arg.slice('--admin='.length)) ?? []),
      ]
    } else if (arg === '--number') {
      parsed.number = parsePositiveInteger(args[index + 1])
      index += 1
      if (!parsed.number) {
        parsed.error = '--number must be a positive integer'
      }
    } else if (arg?.startsWith('--number=')) {
      parsed.number = parsePositiveInteger(arg.slice('--number='.length))
      if (!parsed.number) {
        parsed.error = '--number must be a positive integer'
      }
    } else if (arg === '--method') {
      parsed.mergeMethod = parseGiteaMergeMethod(args[index + 1])
      index += 1
      if (!parsed.mergeMethod) {
        parsed.error = '--method must be merge, squash, or rebase'
      }
    } else if (arg?.startsWith('--method=')) {
      parsed.mergeMethod = parseGiteaMergeMethod(arg.slice('--method='.length))
      if (!parsed.mergeMethod) {
        parsed.error = '--method must be merge, squash, or rebase'
      }
    } else if (arg === '--scope-ref') {
      parsed.scopeRef = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--scope-ref=')) {
      parsed.scopeRef = arg.slice('--scope-ref='.length)
    } else if (arg === '--subdir') {
      parsed.subdir = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--subdir=')) {
      parsed.subdir = arg.slice('--subdir='.length)
    } else if (arg === '--refresh') {
      const value = args[index + 1]
      if (value === 'manual' || value === 'always') {
        parsed.sourceRefresh = value
      } else {
        parsed.error = '--refresh must be "manual" or "always"'
      }
      index += 1
    } else if (arg?.startsWith('--refresh=')) {
      const value = arg.slice('--refresh='.length)
      if (value === 'manual' || value === 'always') {
        parsed.sourceRefresh = value
      } else {
        parsed.error = '--refresh must be "manual" or "always"'
      }
    } else if (arg === '--runtime-ref') {
      parsed.runtimeRefMode = parseRuntimeRefMode(args[index + 1])
      index += 1
      if (!parsed.runtimeRefMode) {
        parsed.error = '--runtime-ref must be accepted, source, or commit'
      }
    } else if (arg?.startsWith('--runtime-ref=')) {
      parsed.runtimeRefMode = parseRuntimeRefMode(
        arg.slice('--runtime-ref='.length),
      )
      if (!parsed.runtimeRefMode) {
        parsed.error = '--runtime-ref must be accepted, source, or commit'
      }
    } else if (arg === '--reason') {
      parsed.reason = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--reason=')) {
      parsed.reason = arg.slice('--reason='.length)
    } else if (arg === '--fields') {
      parsed.fields = parseFields(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--fields=')) {
      parsed.fields = parseFields(arg.slice('--fields='.length))
    } else if (arg === '--limit') {
      parsed.limit = parseNonNegativeInteger(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--limit=')) {
      parsed.limit = parseNonNegativeInteger(arg.slice('--limit='.length))
    } else if (arg === '--offset') {
      parsed.offset = parseNonNegativeInteger(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--offset=')) {
      parsed.offset = parseNonNegativeInteger(arg.slice('--offset='.length))
    } else if (arg === '--query') {
      parsed.query = args[index + 1]
      index += 1
    } else if (arg?.startsWith('--query=')) {
      parsed.query = arg.slice('--query='.length)
    } else if (arg === '--group-by') {
      parsed.groupBy = parseGroupBy(args[index + 1])
      index += 1
    } else if (arg?.startsWith('--group-by=')) {
      parsed.groupBy = parseGroupBy(arg.slice('--group-by='.length))
    } else if (arg) {
      parsed.positionals.push(arg)
    }
  }

  return parsed
}

function parseWorkbenchMode(
  value: string | undefined,
): ParsedArgs['mode'] {
  if (
    value === 'explore' ||
    value === 'lineage' ||
    value === 'impact' ||
    value === 'validate' ||
    value === 'raw'
  ) {
    return value
  }
  return undefined
}

function parseFields(value: string | undefined): string[] | undefined {
  const fields = value
    ?.split(',')
    .map(field => field.trim())
    .filter(Boolean)
  return fields && fields.length > 0 ? fields : undefined
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined
  }
  return parsed
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = parseNonNegativeInteger(value)
  return parsed && parsed > 0 ? parsed : undefined
}

function parseGiteaMergeMethod(
  value: string | undefined,
): ParsedArgs['mergeMethod'] {
  return value === 'merge' || value === 'squash' || value === 'rebase'
    ? value
    : undefined
}

function parseRuntimeRefMode(
  value: string | undefined,
): ParsedArgs['runtimeRefMode'] {
  return value === 'accepted' || value === 'source' || value === 'commit'
    ? value
    : undefined
}

function parseGroupBy(value: string | undefined): ParsedArgs['groupBy'] {
  return value === 'type' || value === 'packId' || value === 'source'
    ? value
    : undefined
}

function parseDirection(value: string | undefined): ParsedArgs['direction'] {
  return value === 'dependencies' || value === 'reverse' || value === 'all'
    ? value
    : undefined
}

function parseGraphProfile(value: string | undefined): ParsedArgs['graphProfile'] {
  return value === 'core' ||
    value === 'discovery' ||
    value === 'evidence' ||
    value === 'full'
    ? value
    : undefined
}

function parseAssetScope(value: string | undefined): ParsedArgs['scope'] {
  return value === 'shared' ||
    value === 'global' ||
    value === 'core' ||
    value === 'project'
    ? value
    : undefined
}

function parseDeployScope(value: string | undefined): 'global' | 'shared' | undefined {
  return value === 'shared' || value === 'global' ? value : undefined
}

async function listAssets(
  io: MatOSAssetsIO,
  options: ParsedArgs,
): Promise<number> {
  const assets = (await loadMatOSRuntimeAssets(io.cwd))
    .filter(asset => !shouldHideAssetFromUserSurface(asset))
    .filter(asset =>
      (options.type ? asset.type === options.type : true) &&
      assetMatchesQuery(asset, options.query),
    )

  if (options.json) {
    if (wantsSummaryList(options)) {
      const offset = options.offset ?? 0
      const limit = options.limit ?? 50
      const pageAssets =
        limit === 0 ? [] : assets.slice(offset, offset + limit)
      const nextOffset =
        limit > 0 && offset + limit < assets.length
          ? offset + limit
          : undefined
      writeJson(io, {
        assets: pageAssets.map(asset =>
          serializeAssetSummary(asset, options.fields),
        ),
        page: {
          limit,
          offset,
          total: assets.length,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        },
        groups: groupAssetSummaries(assets, options.groupBy ?? 'type'),
      })
      return 0
    }

    writeJson(io, {
      assets: assets.map(options.compact ? serializeAssetCompact : serializeAsset),
    })
    return 0
  }

  if (assets.length === 0) {
    io.stdout(
      options.type
        ? `No MatOS ${options.type} assets found\n`
        : 'No MatOS assets found\n',
    )
    return 0
  }

  for (const asset of assets) {
    io.stdout(formatAsset(asset))
  }
  return 0
}

async function showAsset(
  io: MatOSAssetsIO,
  reference: string | undefined,
  json: boolean,
): Promise<number> {
  if (!reference) {
    io.stderr('Usage: matos assets show <asset-ref>\n')
    return 1
  }

  const assets = await loadMatOSRuntimeAssets(io.cwd, { followAcceptedUpdates: reference.includes('@') ? false : undefined })
  const registry = buildMatOSAssetRegistry(assets, {
    includeDisabled: true,
  })
  const asset = registry.resolve(reference)
  if (!asset || shouldHideAssetFromUserSurface(asset)) {
    io.stderr(`MatOS asset not found: ${reference}\n`)
    return 1
  }

  if (json) {
    let projectionHints: Record<string, unknown> | undefined
    if (asset.type === 'role') {
      // Projection hints preview what this role would mount at runtime, so
      // compose against the runtime-active registry. Draft/disabled roles are
      // intentionally absent from that registry, and hints are best-effort
      // metadata: never let composition failures crash `assets show`.
      const runtimeRegistry = buildMatOSAssetRegistry(assets)
      if (!runtimeRegistry.resolve(asset.canonicalKey)) {
        projectionHints = {
          skipped: `role is not runtime-active (lifecycle: ${asset.lifecycle.status}); enable it to compose a runtime projection`,
        }
      } else {
        try {
          const projection = await projectMatOSRoleToRuntime(
            runtimeRegistry,
            asset.canonicalKey,
          )
          projectionHints = {
            selectedAgent: projection.selectedAgent,
            appendSystemPromptCount: projection.appendSystemPrompt.length,
            pluginDirs: projection.pluginDirs,
            mcpConfigPaths: projection.mcpConfigPaths,
            allowedTools: projection.allowedTools,
          }
        } catch (error) {
          projectionHints = {
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }
    }

    writeJson(io, {
      asset: serializeAsset(asset),
      ...(projectionHints ? { projectionHints } : {}),
    })
    return 0
  }

  io.stdout(formatAsset(asset))
  if (asset.lifecycle.status !== 'enabled') {
    io.stdout(`Status: ${asset.lifecycle.status}\n`)
  }
  if (asset.lifecycle.reason) {
    io.stdout(`Reason: ${asset.lifecycle.reason}\n`)
  }
  if (asset.description) {
    io.stdout(`${asset.description}\n`)
  }
  return 0
}

async function setAssetStatus(
  io: MatOSAssetsIO,
  reference: string | undefined,
  status: 'enabled' | 'disabled' | 'deprecated',
  reason?: string,
): Promise<number> {
  if (!reference) {
    io.stderr(`Usage: matos assets ${status} <asset-ref>\n`)
    return 1
  }

  try {
    const asset = await setMatOSAssetLifecycleStatus(
      io.cwd,
      await loadMatOSAssets(io.cwd),
      reference,
      status,
      reason,
    )
    io.stdout(`${status} ${asset.canonicalKey}\n`)
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const DOCTOR_STALE_DEFAULT_DAYS = 30

type DoctorStaleEntry = {
  assetKey: string
  type: string
  name: string
  usageCount: number
  lastUsedAt?: string
  idleDays?: number
}

type DoctorDuplicateGroup = {
  contentSha256: string
  bytes: number
  assets: { assetKey: string; entryPath: string }[]
}

// Read-only staleness report over the aggregated usage graph. The usage
// signals (usageCount/lastUsedAt) were already collected for graph display but
// had no lifecycle consumer, so unused assets accumulated invisibly. This
// report is deliberately not a cleanup: per policy, retirement stays an
// explicit operator action (matos assets deprecate / disable).
async function collectDoctorStaleReport(
  io: MatOSAssetsIO,
  assets: MatOSAsset[],
  staleDays: number,
): Promise<{
  staleAssets: DoctorStaleEntry[]
  neverUsedAssets: DoctorStaleEntry[]
  usageObserved: boolean
}> {
  const registry = buildMatOSAssetRegistry(assets)
  const usage = await buildUsageGraphProviderResult({
    cwd: io.cwd,
    registry,
    assets,
    options: { includeUsage: true },
  })
  const usageByKey = new Map<string, { count: number; lastUsedAt?: string }>()
  for (const node of usage.nodes ?? []) {
    const usageMeta = node.metadata?.usage
    if (!usageMeta || typeof usageMeta !== 'object' || Array.isArray(usageMeta)) {
      continue
    }
    const record = usageMeta as Record<string, unknown>
    const count = typeof record.count === 'number' ? record.count : 0
    const lastUsedAt =
      typeof record.lastUsedAt === 'string' ? record.lastUsedAt : undefined
    usageByKey.set(node.id, {
      count,
      ...(lastUsedAt ? { lastUsedAt } : {}),
    })
  }
  const now = Date.now()
  const staleAssets: DoctorStaleEntry[] = []
  const neverUsedAssets: DoctorStaleEntry[] = []
  for (const asset of assets) {
    if (
      asset.lifecycle.status === 'disabled' ||
      asset.lifecycle.status === 'deprecated'
    ) {
      continue
    }
    const observed = usageByKey.get(asset.canonicalKey)
    const base: DoctorStaleEntry = {
      assetKey: asset.canonicalKey,
      type: asset.type,
      name: asset.name,
      usageCount: observed?.count ?? 0,
    }
    if (!observed || observed.count === 0) {
      neverUsedAssets.push(base)
      continue
    }
    if (observed.lastUsedAt) {
      const lastUsedMs = Date.parse(observed.lastUsedAt)
      if (Number.isFinite(lastUsedMs)) {
        const idleDays = Math.floor((now - lastUsedMs) / 86_400_000)
        if (idleDays >= staleDays) {
          staleAssets.push({
            ...base,
            lastUsedAt: observed.lastUsedAt,
            idleDays,
          })
        }
      }
    }
  }
  staleAssets.sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0))
  neverUsedAssets.sort((a, b) => a.assetKey.localeCompare(b.assetKey))
  return { staleAssets, neverUsedAssets, usageObserved: usageByKey.size > 0 }
}

// Byte-identical file groups across asset directories (entries AND support
// files — measured drift is mostly copied helper scripts inside skill packs).
// Duplicate content is never converged automatically; this surfaces merge
// candidates for an operator.
async function collectDoctorDuplicateReport(
  assets: MatOSAsset[],
): Promise<DoctorDuplicateGroup[]> {
  const { createHash } = await import('node:crypto')
  const { dirname } = await import('node:path')
  const byHash = new Map<string, DoctorDuplicateGroup>()
  const seenFiles = new Set<string>()
  for (const asset of assets) {
    const assetDir = dirname(asset.manifestPath)
    let entries
    try {
      entries = await readdir(assetDir, { recursive: true, withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }
      const filePath = join(entry.parentPath ?? assetDir, entry.name)
      if (seenFiles.has(filePath)) {
        continue
      }
      seenFiles.add(filePath)
      try {
        const info = await stat(filePath)
        if (info.size === 0 || info.size > 4_000_000) {
          continue
        }
        const digest = createHash('sha256')
          .update(await readFile(filePath))
          .digest('hex')
        const group = byHash.get(digest) ?? {
          contentSha256: digest,
          bytes: info.size,
          assets: [],
        }
        group.assets.push({ assetKey: asset.canonicalKey, entryPath: filePath })
        byHash.set(digest, group)
      } catch {
        // unreadable files are already reported by validation
      }
    }
  }
  return [...byHash.values()]
    .filter(group => group.assets.length > 1)
    .sort((a, b) => b.assets.length - a.assets.length)
}

async function doctorAssets(
  io: MatOSAssetsIO,
  parsed: Pick<ParsedArgs, 'json' | 'stale' | 'staleDays' | 'duplicates'>,
): Promise<number> {
  const json = parsed.json
  const assets = await loadMatOSAssets(io.cwd)
  const validation = await validateMatOSAssets(assets)
  const lifecycle = summarizeMatOSAssetLifecycle(assets)
  const deprecatedAssets = assets
    .filter(asset => asset.lifecycle.status === 'deprecated')
    .map(asset => serializeAsset(asset))
  const disabledAssets = assets
    .filter(asset => asset.lifecycle.status === 'disabled')
    .map(asset => serializeAsset(asset))
  const staleDays = parsed.staleDays ?? DOCTOR_STALE_DEFAULT_DAYS
  const staleReport = parsed.stale
    ? await collectDoctorStaleReport(io, assets, staleDays)
    : undefined
  const duplicateGroups = parsed.duplicates
    ? await collectDoctorDuplicateReport(assets)
    : undefined
  const result = {
    ok: validation.ok,
    summary: lifecycle,
    validation,
    deprecatedAssets,
    disabledAssets,
    ...(staleReport ? { staleDays, ...staleReport } : {}),
    ...(duplicateGroups ? { duplicateGroups } : {}),
  }

  if (json) {
    writeJson(io, result)
    return validation.ok ? 0 : 1
  }

  if (validation.ok) {
    io.stdout(
      `MatOS assets doctor: ok (${lifecycle.enabled} enabled, ${lifecycle.disabled} disabled, ${lifecycle.deprecated} deprecated, ${lifecycle.draft} draft)\n`,
    )
  } else {
    io.stderr('MatOS assets doctor: failed\n')
    for (const error of validation.errors) {
      io.stderr(`${error.code}: ${error.message} (${error.manifestPath})\n`)
    }
  }

  if (staleReport) {
    if (!staleReport.usageObserved) {
      io.stdout(
        'stale: no usage events observed in this scope; never-used counts below reflect missing telemetry, not proven dead assets\n',
      )
    }
    io.stdout(
      `stale (>=${staleDays}d idle): ${staleReport.staleAssets.length}; never used: ${staleReport.neverUsedAssets.length}\n`,
    )
    for (const entry of staleReport.staleAssets.slice(0, 20)) {
      io.stdout(
        `  stale ${entry.assetKey} idle ${entry.idleDays}d (used ${entry.usageCount}x, last ${entry.lastUsedAt})\n`,
      )
    }
    io.stdout(
      'stale report is read-only; retire candidates explicitly with: matos assets deprecate <asset-ref> --reason ...\n',
    )
  }
  if (duplicateGroups) {
    io.stdout(`duplicate entry-content groups: ${duplicateGroups.length}\n`)
    for (const group of duplicateGroups.slice(0, 20)) {
      io.stdout(
        `  ${group.assets.length}x identical (${group.bytes} bytes): ${group.assets
          .map(item => item.entryPath)
          .join(', ')}\n`,
      )
    }
  }

  return validation.ok ? 0 : 1
}

function requiredOption(
  value: string | undefined,
  option: string,
): string | undefined {
  return value?.trim() ? value.trim() : undefined
}

async function importAsset(
  io: MatOSAssetsIO,
  sourcePath: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  const id = requiredOption(options.id, '--id')
  const type = requiredOption(options.type, '--type')
  const name = requiredOption(options.name, '--name')
  const version = requiredOption(options.version, '--version') ?? '0.1.0'

  if (!sourcePath || !id || !type || !name) {
    io.stderr(
      'Usage: matos assets import <path> --type <type> --id <id> --name <name> [--version <version>]\n',
    )
    return 1
  }

  const config = await readMatOSProjectConfig(io.cwd)
  const mount: MatOSAssetMountConfig = {
    path: sourcePath,
    id,
    type,
    name,
    version,
  }
  const assetMounts = [
    ...(config.assetMounts ?? []).filter(existing =>
      !(
        existing.id === id &&
        existing.type === type &&
        (existing.version ?? '0.1.0') === version
      ),
    ),
    mount,
  ]

  await writeMatOSProjectConfig(io.cwd, {
    ...config,
    assetMounts,
  })

  io.stdout(`imported ${type}:${id}@${version}\n`)
  return 0
}

async function assertPackHasNoSecretMaterial(
  root: string,
  current: string = root,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    const relativePath = fullPath.slice(root.length + 1) || entry.name
    if (entry.isDirectory()) {
      await assertPackHasNoSecretMaterial(root, fullPath)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (isMatOSSecretLookingFileName(entry.name)) {
      throw new Error(
        `Refusing to deploy pack: secret-looking file ${relativePath}`,
      )
    }

    const info = await lstat(fullPath)
    if (info.size > 1024 * 1024) {
      continue
    }
    const raw = await readFile(fullPath, 'utf8').catch(() => '')
    if (hasMatOSSecretLookingContent(raw)) {
      throw new Error(
        `Refusing to deploy pack: secret-looking content in ${relativePath}`,
      )
    }
  }
}

function safePackId(value: string | undefined): string | undefined {
  const id = value?.trim()
  if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    return undefined
  }
  return id
}

function isSupportedAssetHistoryScope(scope: MatOSAssetHistoryScope): boolean {
  return scope === 'core' || scope === 'project'
}

async function readDeployPackId(
  sourcePath: string,
  overrideId: string | undefined,
): Promise<string> {
  const raw = await readFile(join(sourcePath, 'matos.pack.json'), 'utf8').catch(
    () => undefined,
  )
  if (!raw) {
    throw new Error(
      'Usage: matos assets deploy-tool <pack-dir> [--scope global|shared] [--replace] [--refresh-workspaces]',
    )
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const id = safePackId(overrideId) ?? safePackId(String(parsed.id ?? ''))
  if (!id) {
    throw new Error(
      'MatOS asset pack id must contain only letters, numbers, ".", "_", or "-"',
    )
  }
  return id
}

function deployTargetRoot(scope: 'global' | 'shared'): string {
  const roots = resolveMatOSDeploymentRoots(process.env)
  return scope === 'shared' ? roots.sharedAssetRoot : roots.globalAssetRoot
}

const DEFAULT_WORKSPACE_CONTAINER_OPS: NonNullable<
  MatOSAssetsIO['workspaceContainers']
> = {
  // Single-user installs have no workspace containers to refresh.
  list: async () => [],
  restart: async () => {},
}

async function refreshWorkspaceContainersAfterDeploy(
  io: MatOSAssetsIO,
): Promise<Array<{ scopeRef: string }>> {
  const ops = io.workspaceContainers ?? DEFAULT_WORKSPACE_CONTAINER_OPS
  const workspaces = await ops.list({ cwd: io.cwd })
  const refreshed: Array<{ scopeRef: string }> = []
  for (const workspace of workspaces) {
    if (!workspace.scopeRef) {
      continue
    }
    await ops.restart({
      cwd: io.cwd,
      scopeReference: workspace.scopeRef,
      runtimeReference: 'runtime:matos-openvscode',
    })
    refreshed.push({ scopeRef: workspace.scopeRef })
  }
  return refreshed
}

async function rollbackDeployCopy(input: {
  targetPath: string
  backupPath?: string
}): Promise<void> {
  await rm(input.targetPath, { recursive: true, force: true })
  if (input.backupPath && existsSync(input.backupPath)) {
    await rename(input.backupPath, input.targetPath)
  }
}

async function deployToolPack(
  io: MatOSAssetsIO,
  sourcePath: string | undefined,
  options: ParsedArgs,
): Promise<number> {
  const scope = parseDeployScope(options.rawScope ?? options.scope ?? 'global')
  if (!scope) {
    io.stderr('--scope must be "global" or "shared" for deploy-tool\n')
    return 1
  }
  if (!sourcePath) {
    io.stderr(
      'Usage: matos assets deploy-tool <pack-dir> [--scope global|shared] [--replace] [--refresh-workspaces]\n',
    )
    return 1
  }

  let copied = false
  let backupPath: string | undefined
  let deployedTargetPath: string | undefined
  const resolvedSourcePath = resolve(io.cwd, sourcePath)

  try {
    const sourceInfo = await lstat(resolvedSourcePath)
    if (!sourceInfo.isDirectory()) {
      throw new Error('deploy-tool source must be an asset pack directory')
    }
    const packId = await readDeployPackId(resolvedSourcePath, options.id)
    await assertPackHasNoSecretMaterial(resolvedSourcePath)

    const targetRoot = deployTargetRoot(scope)
    const targetPath = join(targetRoot, 'packs', packId)
    deployedTargetPath = targetPath
    await mkdir(join(targetRoot, 'packs'), { recursive: true })

    if (existsSync(targetPath)) {
      if (!options.replace) {
        throw new Error(
          `MatOS asset pack already exists at ${targetPath}; pass --replace to overwrite it`,
        )
      }
      backupPath = `${targetPath}.bak-${Date.now()}`
      await rename(targetPath, backupPath)
    }

    await cp(resolvedSourcePath, targetPath, { recursive: true })
    copied = true

    const validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
    if (!validation.ok) {
      await rollbackDeployCopy({ targetPath, backupPath })
      copied = false
      if (options.json) {
        writeJson(io, {
          ok: false,
          scope,
          packId,
          targetPath,
          validation,
          refreshedWorkspaces: [],
        })
      } else {
        io.stderr('MatOS asset validation failed after deploy\n')
        for (const error of validation.errors) {
          io.stderr(`${error.code}: ${error.message} (${error.manifestPath})\n`)
        }
      }
      return 1
    }

    if (backupPath) {
      await rm(backupPath, { recursive: true, force: true })
      backupPath = undefined
    }
    copied = false

    const refreshedWorkspaces = options.refreshWorkspaces
      ? await refreshWorkspaceContainersAfterDeploy(io)
      : []
    const result: {
      ok: true
      scope: 'global' | 'shared'
      packId: string
      sourcePath: string
      targetPath: string
      validation: MatOSAssetValidationResult
      refreshedWorkspaces: Array<{ scopeRef: string }>
    } = {
      ok: true,
      scope,
      packId,
      sourcePath: resolvedSourcePath,
      targetPath,
      validation,
      refreshedWorkspaces,
    }

    if (options.json) {
      writeJson(io, result)
    } else {
      io.stdout(`deployed ${packId} to ${targetPath}\n`)
      for (const workspace of refreshedWorkspaces) {
        io.stdout(`refreshed ${workspace.scopeRef}\n`)
      }
    }
    return 0
  } catch (error) {
    if (copied && deployedTargetPath) {
      await rollbackDeployCopy({
        targetPath: deployedTargetPath,
        backupPath,
      }).catch(() => undefined)
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function assetHistoryInitialized(cwd: string): Promise<boolean> {
  try {
    const info = await stat(assetHistoryGitDir(cwd))
    return info.isDirectory()
  } catch {
    return false
  }
}

async function runAssetHistoryCommand(
  io: MatOSAssetsIO,
  subcommand: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  const command = subcommand ?? 'status'
  if (isScopedAssetArchiveCaller()) {
    io.stderr('Scope-wide history maintenance requires an operator context. Use matos assets archive for scoped history, comparison and rollback.\n')
    return 1
  }
  try {
    if (command === 'status') {
      const [snapshotList, releaseList] = await Promise.all([
        listMatOSAssetHistorySnapshotsWithIssues(io.cwd),
        listMatOSAssetHistoryReleasesWithIssues(io.cwd),
      ])
      writeJson(io, {
        initialized: await assetHistoryInitialized(io.cwd),
        gitDir: assetHistoryGitDir(io.cwd),
        snapshotCount: snapshotList.records.length,
        releaseCount: releaseList.records.length,
        latestSnapshot: snapshotList.records[0]?.snapshotId,
        recordIssues: [...snapshotList.issues, ...releaseList.issues],
      })
      return 0
    }

    if (command === 'snapshot') {
      const scope = parseAssetScope(parsed.rawScope ?? parsed.scope ?? 'core')
      const scopeRef = parsed.scopeRef?.trim()
      if (!scope) {
        io.stderr(
          '--scope must be "core", "project", "global", or "shared" for asset history\n',
        )
        return 1
      }
      if (!isSupportedAssetHistoryScope(scope)) {
        io.stderr(`MatOS asset history scope is not supported yet: ${scope}\n`)
        return 1
      }
      const { snapshot, validation } = await withMatOSAssetHistoryLock(
        {
          cwd: io.cwd,
          operation: 'assets-history-snapshot',
        },
        async () => {
          const previous = (await listMatOSAssetHistorySnapshots(io.cwd)).find(
            snapshot =>
              snapshot.scope === scope && snapshot.scopeRef === scopeRef,
          )
          const assetSources = await collectAssetSourceProvenanceForHistory(io.cwd)
          const snapshot = await createMatOSAssetHistorySnapshot({
            cwd: io.cwd,
            kind: 'manual',
            scope,
            ...(scopeRef ? { scopeRef } : {}),
            ref: matOSAssetHistoryLatestRef(scope, scopeRef),
            ...(previous ? { parentCommit: previous.commit } : {}),
            ...(assetSources.length > 0 ? { provenance: { assetSources } } : {}),
          })
          const validation = await validateMatOSAssetHistorySnapshot({
            cwd: io.cwd,
            snapshotId: snapshot.snapshotId,
          })
          if (validation.ok) {
            await git(io.cwd, [
              'update-ref',
              matOSAssetHistoryStableRef(scope, scopeRef),
              snapshot.commit,
            ])
          }
          return { snapshot, validation }
        },
      )
      if (parsed.json) {
        writeJson(io, { snapshot, validation })
      } else {
        io.stdout(`${snapshot.snapshotId}\t${snapshot.commit}\n`)
      }
      return validation.ok ? 0 : 1
    }

    if (command === 'list') {
      const list = await listMatOSAssetHistorySnapshotsWithIssues(io.cwd)
      const snapshots = list.records.filter(snapshot =>
        parsed.asset ? snapshot.assetRefs.includes(parsed.asset) : true,
      )
      writeJson(io, { snapshots, recordIssues: list.issues })
      return 0
    }

    if (command === 'show') {
      const snapshotId = parsed.positionals[0]
      if (!snapshotId) {
        io.stderr('Usage: matos assets history show <snapshot-id>\n')
        return 1
      }
      const snapshot = await readMatOSAssetHistorySnapshot(io.cwd, snapshotId)
      if (!snapshot) {
        io.stderr(`MatOS asset history snapshot not found: ${snapshotId}\n`)
        return 1
      }
      writeJson(io, { snapshot })
      return 0
    }

    if (command === 'diff') {
      const [from, to] = parsed.positionals
      if (!from || !to) {
        io.stderr('Usage: matos assets history diff <from> <to>\n')
        return 1
      }
      const diff = await diffMatOSAssetHistorySnapshots({
        cwd: io.cwd,
        from,
        to,
      })
      if (parsed.json) {
        writeJson(io, { diff })
      } else {
        io.stdout(diff.patch)
      }
      return 0
    }

    if (command === 'restore') {
      const snapshotId = parsed.positionals[0]
      if (!snapshotId) {
        io.stderr('Usage: matos assets history restore <snapshot-id>\n')
        return 1
      }
      const { restore, validation } = await withMatOSAssetHistoryLock(
        {
          cwd: io.cwd,
          operation: 'assets-history-restore',
        },
        async () => {
          const snapshot = await readMatOSAssetHistorySnapshot(io.cwd, snapshotId)
          if (!snapshot) {
            throw new Error(`MatOS asset history snapshot not found: ${snapshotId}`)
          }
          const restore = await restoreMatOSAssetHistorySnapshot({
            cwd: io.cwd,
            snapshotId,
            removeCreatedFiles: true,
            ...(snapshot.fullScope ? { removeFilesNotInSnapshotScope: true } : {}),
          })
          const validation = await validateMatOSAssetHistorySnapshot({
            cwd: io.cwd,
            scope: snapshot.scope,
            ...(snapshot.scopeRef ? { scopeRef: snapshot.scopeRef } : {}),
          })
          return { restore, validation }
        },
      )
      if (parsed.json) {
        writeJson(io, { restore, validation })
      } else {
        io.stdout(`restored ${snapshotId}\n`)
      }
      return validation.ok ? 0 : 1
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  io.stderr(`Unknown matos assets history command: ${command}\n`)
  return 1
}

async function runAssetReleaseCommand(
  io: MatOSAssetsIO,
  subcommand: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  const command = subcommand ?? 'list'
  try {
    if (command === 'create') {
      const name = parsed.name?.trim()
      if (!name) {
        io.stderr('Usage: matos assets release create --name <name> [--ref <snapshot-id>]\n')
        return 1
      }
      const result = await createMatOSAssetRelease({
        cwd: io.cwd,
        name,
        ref: parsed.ref,
        forceStale: parsed.forceStale,
      })
      if ('error' in result) {
        io.stderr(`${result.error}\n`)
        return 1
      }
      const { release, validation } = result
      if (parsed.json) {
        writeJson(io, { release })
      } else {
        io.stdout(`${release.releaseId}\t${release.commit}\n`)
      }
      return validation.ok ? 0 : 1
    }

    if (command === 'list') {
      const list = await listMatOSAssetHistoryReleasesWithIssues(io.cwd)
      writeJson(io, { releases: list.records, recordIssues: list.issues })
      return 0
    }

    if (command === 'show') {
      const releaseId = parsed.positionals[0]
      if (!releaseId) {
        io.stderr('Usage: matos assets release show <release-id>\n')
        return 1
      }
      const release = await readMatOSAssetHistoryRelease(io.cwd, releaseId)
      if (!release) {
        io.stderr(`MatOS asset release not found: ${releaseId}\n`)
        return 1
      }
      writeJson(io, { release })
      return 0
    }

    if (command === 'rollback') {
      const releaseId = parsed.positionals[0]
      if (!releaseId) {
        io.stderr('Usage: matos assets release rollback <release-id>\n')
        return 1
      }
      const result = await rollbackMatOSAssetRelease({ cwd: io.cwd, releaseId })
      if ('error' in result) {
        io.stderr(`${result.error}\n`)
        return 1
      }
      const { release, rollback, validation, restoredSnapshot } = result
      if (parsed.json) {
        writeJson(io, { release, rollback, validation, restoredSnapshot })
      } else {
        io.stdout(`rolled back ${release.releaseId}\n`)
      }
      return validation.ok ? 0 : 1
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  io.stderr(`Unknown matos assets release command: ${command}\n`)
  return 1
}

export async function runMatOSAssetsCommand(
  args: string[],
  io: MatOSAssetsIO,
): Promise<number> {
  const subcommand = args[0] ?? 'list'
  if (subcommand === 'archive') {
    const { runAssetArchiveCommand } = await import('./assetsArchiveCommands.js')
    return runAssetArchiveCommand(io, args.slice(1))
  }
  const parsed = parseArgs(args.slice(1))
  if (parsed.error) {
    io.stderr(`${parsed.error}\n`)
    return 1
  }

  if (subcommand === 'history') {
    return runAssetHistoryCommand(io, parsed.positionals[0], {
      ...parsed,
      positionals: parsed.positionals.slice(1),
    })
  }

  if (subcommand === 'release') {
    return runAssetReleaseCommand(io, parsed.positionals[0], {
      ...parsed,
      positionals: parsed.positionals.slice(1),
    })
  }

  if (subcommand === 'sources') {
    return runAssetSourcesCommand(io, parsed.positionals[0], {
      ...parsed,
      positionals: parsed.positionals.slice(1),
    })
  }

  if (subcommand === 'git') {
    return runAssetGitCommand(io, parsed.positionals[0], {
      ...parsed,
      positionals: parsed.positionals.slice(1),
    })
  }

  if (subcommand === 'list') {
    return listAssets(io, parsed)
  }

  if (subcommand === 'show') {
    return showAsset(io, parsed.positionals[0], parsed.json)
  }

  if (subcommand === 'enable') {
    return setAssetStatus(io, parsed.positionals[0], 'enabled', parsed.reason)
  }

  if (subcommand === 'disable') {
    return setAssetStatus(io, parsed.positionals[0], 'disabled', parsed.reason)
  }

  if (subcommand === 'deprecate') {
    return setAssetStatus(io, parsed.positionals[0], 'deprecated', parsed.reason)
  }

  if (subcommand === 'doctor') {
    return doctorAssets(io, parsed)
  }

  if (subcommand === 'edit') {
    const { runAssetEditCommand } = await import('./assetsEditCommand.js')
    return runAssetEditCommand(io, args.slice(1))
  }

  if (subcommand === 'import') {
    return importAsset(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'register-data') {
    const { registerDataAsset } = await import('./assetsRegisterData.js')
    return registerDataAsset(io, parsed)
  }

  if (subcommand === 'intake-adopt') {
    const packId = parsed.positionals[0]
    if (!packId) {
      io.stderr('Usage: matos assets intake-adopt <pack-id> [--json]\n')
      return 1
    }
    // Moves an external intake draft pack into the current scope's accepted
    // source (MATOS_SCOPE_REF), where every session can load it.
    const { adoptMatOSExternalIntakeDraftPack } = await import('../workbench/externalIntakeAdopt.js')
    const result = await adoptMatOSExternalIntakeDraftPack({ cwd: io.cwd, packId })
    if (parsed.json) {
      io.stdout(`${JSON.stringify(result)}\n`)
    } else if (result.ok) {
      io.stdout(`adopted ${result.adoptedRefs.join(', ')} into ${result.scopeRef}\n`)
    } else {
      io.stderr(`${result.error ?? 'intake adopt failed'}\n`)
    }
    return result.ok ? 0 : 1
  }

  if (subcommand === 'adapt-path') {
    const { adaptPathAssetsCommand } = await import('./assetsAdaptPath.js')
    return adaptPathAssetsCommand(io, parsed)
  }

  if (subcommand === 'publish-data') {
    const { publishDataAssetCommand } = await import('./assetsPublishData.js')
    return publishDataAssetCommand(io, parsed)
  }

  if (subcommand === 'run-tool') {
    const { runToolAssetCommand } = await import('./assetsRunTool.js')
    return runToolAssetCommand(io, parsed)
  }

  if (subcommand === 'deploy-tool') {
    return deployToolPack(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'validate') {
    const assets = await loadMatOSAssets(io.cwd)
    const result = await validateMatOSAssets(assets)
    if (parsed.json) {
      writeJson(io, result)
      return result.ok ? 0 : 1
    }

    if (result.ok) {
      io.stdout('MatOS assets valid\n')
      return 0
    }

    for (const error of result.errors) {
      io.stderr(`${error.code}: ${error.message} (${error.manifestPath})\n`)
    }
    return 1
  }

  if (subcommand === 'graph') {
    return graphAssets(io, parsed.role ?? parsed.positionals[0], parsed.json)
  }

  if (subcommand === 'graph-index') {
    return graphIndexAssets(io, parsed)
  }

  if (subcommand === 'related') {
    return relatedAssets(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'impact') {
    return impactAssets(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'lineage') {
    return lineageAssets(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'workbench') {
    return workbenchAssets(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'search') {
    return searchAssets(
      io,
      parsed.positionals.length > 0 ? parsed.positionals.join(' ') : undefined,
      parsed,
    )
  }

  if (subcommand === 'neighborhood') {
    return neighborhoodAssets(io, parsed.positionals[0], parsed)
  }

  if (subcommand === 'index') {
    const path = await writeMatOSAssetIndex(io.cwd)
    if (parsed.json) {
      writeJson(io, { path })
    } else {
      io.stdout(`${path}\n`)
    }
    return 0
  }

  if (subcommand === 'factory') {
    return runAssetFactoryCommand(io, args.slice(1))
  }

  io.stderr(`Unknown matos assets command: ${subcommand}\n`)
  return 1
}

/**
 * `matos assets factory repo2asset|paper2asset` is the canonical alias
 * over the deterministic workbench external-intake draft-pack layer
 * (repo2asset / paper2asset V1). Preview delegates to
 * `matos workbench search intake-draft`, and `--apply --fingerprint <sha256>`
 * delegates to `intake-draft-apply`, reusing the existing classification,
 * provenance, secret-scan, asset-history snapshot, and validation logic.
 */
async function runAssetFactoryCommand(
  io: MatOSAssetsIO,
  rest: string[],
): Promise<number> {
  const positionals: string[] = []
  const flags: Record<string, string | boolean | undefined> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--json') {
      flags.json = true
      continue
    }
    if (arg === '--apply') {
      flags.apply = true
      continue
    }
    if (arg === '--with-benchmark' || arg === '--benchmark') {
      flags.withBenchmark = true
      continue
    }
    if (arg === '--executable' || arg === '--exec-entries') {
      flags.executable = true
      continue
    }
    if (arg === '--llm-assist' || arg === '--llm') {
      flags.llmAssist = true
      continue
    }
    if (
      arg === '--path' ||
      arg === '--source' ||
      arg === '--intake' ||
      arg === '--pack-id' ||
      arg === '--fingerprint' ||
      arg === '--reason' ||
      arg === '--model'
    ) {
      flags[arg.slice(2)] = rest[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--')) {
      continue
    }
    positionals.push(arg)
  }
  const kind = positionals[0]
  if (kind !== 'repo2asset' && kind !== 'paper2asset') {
    io.stderr(
      'Usage: matos assets factory repo2asset|paper2asset --path <source> [--pack-id <id>] [--with-benchmark] [--executable [--llm-assist] [--model <model>]] [--apply --fingerprint <sha256> [--reason <text>]] [--json]\n',
    )
    return 1
  }
  const source =
    (typeof flags.path === 'string' && flags.path) ||
    (typeof flags.source === 'string' && flags.source) ||
    (typeof flags.intake === 'string' && flags.intake) ||
    positionals[1]
  if (!source) {
    io.stderr(
      'matos assets factory requires --path <source>: a local directory, a zip/tar archive, a git URL, an http(s) download, or a paper/markdown file for paper2asset\n',
    )
    return 1
  }
  const { runMatOSWorkbenchCommand } = await import('./workbench.js')
  const workbenchArgs: string[] = ['search']
  if (flags.apply) {
    if (typeof flags.fingerprint !== 'string' || !flags.fingerprint) {
      io.stderr(
        'matos assets factory --apply requires --fingerprint <sha256> from the preview\n',
      )
      return 1
    }
    workbenchArgs.push('intake-draft-apply', source, '--fingerprint', flags.fingerprint)
    if (typeof flags['pack-id'] === 'string') {
      workbenchArgs.push('--pack-id', flags['pack-id'])
    }
    if (typeof flags.reason === 'string') {
      workbenchArgs.push('--reason', flags.reason)
    }
  } else {
    workbenchArgs.push('intake-draft', source)
    if (typeof flags['pack-id'] === 'string') {
      workbenchArgs.push('--pack-id', flags['pack-id'])
    }
  }
  if (flags.withBenchmark) {
    workbenchArgs.push('--with-benchmark')
  }
  if (flags.executable) {
    workbenchArgs.push('--executable')
  }
  if (flags.llmAssist) {
    workbenchArgs.push('--llm-assist')
  }
  if (typeof flags.model === 'string' && flags.model) {
    workbenchArgs.push('--model', flags.model)
  }
  if (flags.json) {
    workbenchArgs.push('--json')
  }
  return runMatOSWorkbenchCommand(workbenchArgs, io)
}

export async function runMatOSAssetTypeListCommand(
  type: 'role' | 'skill',
  io: MatOSAssetsIO,
  args: string[] = [],
): Promise<number> {
  return listAssets(io, {
    positionals: [],
    json: args.includes('--json'),
    summary: false,
    compact: false,
    forceStale: false,
    dryRun: false,
    push: false,
    replace: false,
    overwrite: false,
    registerSource: false,
    excludeRuntime: false,
    refreshWorkspaces: false,
    includeDisabled: false,
    write: false,
    includeLineage: false,
    includeUsage: false,
    graphRank: false,
    autoOnly: false,
    llm: false,
    reviewed: false,
    benchmarkPassed: false,
    judgePassed: false,
    apply: false,
    stale: false,
    duplicates: false,
    type,
  })
}
