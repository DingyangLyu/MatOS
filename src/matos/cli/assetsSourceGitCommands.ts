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

import { rm } from 'node:fs/promises'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { buildMatOSAssetRegistry, type MatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAssetValidationError, MatOSAssetValidationResult } from '../assets/types.js'
import {
  commitMatOSGitAssetSource,
  inspectMatOSAssetSource,
  materializeMatOSAssetSource,
  serializeMatOSAssetSourceConfig,
} from '../assets/sourceAdapters.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { applyMatOSAssetMergePlanAutoOnly, buildMatOSAssetMergePlan } from '../assets/mergePlan.js'
import { reviewMatOSAssetMergeWithLlm } from '../assets/mergeReview.js'
import { matOSGiteaAssetRepoForScope, matOSGiteaCloneUrl, type MatOSGiteaAssetScope } from '../assets/giteaGovernance.js'
import { buildRuntimeScopedGiteaAssetSource, serializeRuntimeScopedGiteaAssetSource, syncRuntimeScopedGiteaAssetSource } from '../assets/scopedGiteaSources.js'
import { bootstrapMatOSGiteaAssetRepos, createMatOSGiteaBranch, createMatOSGiteaPullRequest, mergeMatOSGiteaPullRequest, provisionMatOSGiteaAssetScope, readMatOSGiteaPullRequest } from '../assets/giteaClient.js'
import { acceptMatOSGiteaAssetSourceCommit, matOSAcceptedBranchForSource } from '../assets/giteaAcceptance.js'
import { matOSGiteaEnvValue } from '../assets/giteaOperatorEnv.js'
import { applyMatOSGiteaAssetPromotionReview, createMatOSGiteaAssetPromotionReview } from '../assets/giteaPromotion.js'
import { createMatOSGiteaRollbackPullRequest } from '../assets/giteaRollback.js'
import { syncGeneratedScopedAssetsToGitea } from '../learning/generatedScopedAssetSync.js'
import { rebaselineMatOSDirectAssetEditorScope } from '../learning/directAssetEditor.js'
import type { MatOSDirectAssetEditorScope } from '../learning/directAssetEditorTypes.js'
import { readMatOSProjectConfig, writeMatOSProjectConfig, type MatOSAssetSourceConfig, type MatOSGitAssetSourceConfig } from '../project.js'
import { objectRecord, type MatOSAssetsIO, type ParsedArgs, writeJson } from './assetsCliShared.js'

export async function validateMaterializedAssetRoot(input: {
  cwd: string
  root: string
  dependencyRoots?: string[]
}): Promise<MatOSAssetValidationResult> {
  const tempCwd = await mkdtempInMatOSTmp({
    cwd: input.cwd,
    prefix: 'asset-merge-validate-',
  })
  try {
    await writeMatOSProjectConfig(tempCwd, {
      version: 1,
      assetRoots: [input.root],
      includeDefaultAssetRoots: false,
    })
    const targetValidation = await validateMatOSAssets(await loadMatOSAssets(tempCwd))
    const dependencyRoots = [...new Set(input.dependencyRoots ?? [])].filter(
      root => root !== input.root,
    )
    if (targetValidation.ok || dependencyRoots.length === 0) {
      return targetValidation
    }
    const dependencyCwd = await mkdtempInMatOSTmp({
      cwd: input.cwd,
      prefix: 'asset-merge-dependencies-',
    })
    try {
      await writeMatOSProjectConfig(dependencyCwd, {
        version: 1,
        assetRoots: dependencyRoots,
        includeDefaultAssetRoots: false,
      })
      const dependencyRegistry = buildMatOSAssetRegistry(
        await loadMatOSAssets(dependencyCwd),
      )
      const filteredErrors = targetValidation.errors.filter(
        error => !isResolvedByDependencyRegistry(error, dependencyRegistry),
      )
      return {
        ok: filteredErrors.length === 0,
        errors: filteredErrors,
      }
    } finally {
      await rm(dependencyCwd, { recursive: true, force: true }).catch(() => undefined)
    }
  } finally {
    await rm(tempCwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function materializeDependencyAssetSourceRoots(input: {
  cwd: string
  sources: MatOSAssetSourceConfig[]
  excludeSourceId: string
  token?: string
}): Promise<string[]> {
  const roots: string[] = []
  for (const source of input.sources) {
    if (source.id === input.excludeSourceId || source.includeInRuntime === false) {
      continue
    }
    roots.push(
      await materializeMatOSAssetSource(input.cwd, source, {
        refresh: source.refresh === 'always' ? 'always' : 'manual',
        token: input.token,
      }),
    )
  }
  return [...new Set(roots)]
}

function validationReference(error: MatOSAssetValidationError): string | undefined {
  if (error.code !== 'missing_dependency' && error.code !== 'missing_mount') {
    return undefined
  }
  return error.message.match(/"([^"]+)"/)?.[1]
}

function isResolvedByDependencyRegistry(
  error: MatOSAssetValidationError,
  registry: MatOSAssetRegistry,
): boolean {
  const reference = validationReference(error)
  return reference ? registry.resolve(reference) !== undefined : false
}

function gitSourceNeedsRemoteAcceptedPush(source: MatOSGitAssetSourceConfig): boolean {
  if (source.provider !== 'gitea' && !source.gitea) {
    return false
  }
  try {
    const parsed = new URL(source.repo)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function scopedRuntimeRefMode(
  mode: ParsedArgs['runtimeRefMode'],
): 'accepted' | 'source' | undefined {
  return mode === 'accepted' || mode === 'source' ? mode : undefined
}

function directEditorScopeForAcceptedSource(
  source: MatOSGitAssetSourceConfig,
): MatOSDirectAssetEditorScope | undefined {
  const scope = source.scope ?? 'project'
  return scope === 'core' ||
    scope === 'project' ||
    scope === 'user' ||
    scope === 'team'
    ? scope
    : undefined
}

async function rebaselineDirectEditorAfterAcceptedSource(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  sourceCommit: string
}): Promise<Awaited<ReturnType<typeof rebaselineMatOSDirectAssetEditorScope>> | undefined> {
  const scope = directEditorScopeForAcceptedSource(input.source)
  if (!scope) {
    return undefined
  }
  return rebaselineMatOSDirectAssetEditorScope({
    cwd: input.cwd,
    scope,
    ...(input.source.scopeRef ? { scopeRef: input.source.scopeRef } : {}),
    reason: `accepted Gitea asset source ${input.source.id} at ${input.sourceCommit}`,
  }).catch(error => ({
    status: 'failed' as const,
    scope,
    error: error instanceof Error ? error.message : String(error),
  }))
}

type DirectEditorAcceptRebaseline = Awaited<
  ReturnType<typeof rebaselineDirectEditorAfterAcceptedSource>
>

function summarizeDirectEditorRebaselineForCli(
  result: DirectEditorAcceptRebaseline,
): Record<string, unknown> | undefined {
  if (!result) {
    return undefined
  }
  return {
    status: result.status,
    scope: result.scope,
    ...(result.previousStableSnapshot
      ? { previousStableSnapshot: result.previousStableSnapshot }
      : {}),
    ...(result.previousStableCommit
      ? { previousStableCommit: result.previousStableCommit }
      : {}),
    ...(result.snapshot
      ? {
          snapshot: {
            snapshotId: result.snapshot.snapshotId,
            kind: result.snapshot.kind,
            scope: result.snapshot.scope,
            commit: result.snapshot.commit,
            ...(result.snapshot.parentCommit
              ? { parentCommit: result.snapshot.parentCommit }
              : {}),
            ...(result.snapshot.ref ? { ref: result.snapshot.ref } : {}),
            createdAt: result.snapshot.createdAt,
            assetCount: result.snapshot.assetRefs.length,
            fileCount: result.snapshot.files.length,
          },
        }
      : {}),
    ...(result.validation
      ? {
          validation: {
            ok: result.validation.ok,
            gateProfile: result.validation.gateProfile,
            assetValidation: {
              ok: result.validation.assetValidation.ok,
              errorCount: result.validation.assetValidation.errors.length,
            },
            secretScan: {
              ok: result.validation.secretScan.ok,
              findingCount: result.validation.secretScan.findings.length,
            },
            workflowValidationCount: result.validation.workflowValidation.length,
            ...(result.validation.smoke
              ? {
                  smoke: {
                    ok: result.validation.smoke.errorCount === 0,
                    errorCount: result.validation.smoke.errorCount,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(result.error ? { error: result.error } : {}),
  }
}

async function acceptScopedRuntimeSource(input: {
  cwd: string
  source: MatOSGitAssetSourceConfig
  ref?: string
  channel?: string
  push?: boolean
  token?: string
  apiUrl?: string
}): Promise<{
  source: MatOSGitAssetSourceConfig
  sources: MatOSAssetSourceConfig[]
  validation: MatOSAssetValidationResult
  directEditorRebaseline?: Awaited<ReturnType<typeof rebaselineDirectEditorAfterAcceptedSource>>
}> {
  const config = await readMatOSProjectConfig(input.cwd)
  const dependencyRoots = await materializeDependencyAssetSourceRoots({
    cwd: input.cwd,
    sources: config.assetSources ?? [],
    excludeSourceId: input.source.id,
    token: input.token,
  })
  const statusOwner =
    input.source.gitea?.owner && input.source.gitea?.repo
      ? {
          owner: input.source.gitea.owner,
          repo: input.source.gitea.repo,
          ...(input.source.gitea.baseUrl
            ? { baseUrl: input.source.gitea.baseUrl }
            : {}),
        }
      : undefined
  const acceptance = await acceptMatOSGiteaAssetSourceCommit({
    cwd: input.cwd,
    source: input.source,
    ref: input.ref,
    channel: input.channel ?? 'stable',
    push: input.push,
    token: input.token,
    validateRoot: root =>
      validateMaterializedAssetRoot({
        cwd: input.cwd,
        root,
        dependencyRoots,
      }),
    ...(input.apiUrl && statusOwner
      ? {
          giteaStatus: {
            apiUrl: input.apiUrl,
            ...statusOwner,
          },
        }
      : {}),
  })
  const acceptedSource: MatOSGitAssetSourceConfig = {
    ...input.source,
    runtimeRef: acceptance.runtimeRef,
  }
  const nextConfig = {
    ...config,
    assetSources: (config.assetSources ?? []).map(source =>
      source.id === input.source.id ? acceptedSource : source,
    ),
  }
  let validation: MatOSAssetValidationResult = acceptance.validation
  let directEditorRebaseline: Awaited<
    ReturnType<typeof rebaselineDirectEditorAfterAcceptedSource>
  >
  if (acceptance.ok) {
    await writeMatOSProjectConfig(input.cwd, nextConfig)
    validation = await validateMatOSAssets(await loadMatOSAssets(input.cwd))
    if (!validation.ok) {
      await writeMatOSProjectConfig(input.cwd, config)
    } else {
      directEditorRebaseline = await rebaselineDirectEditorAfterAcceptedSource({
        cwd: input.cwd,
        source: acceptedSource,
        sourceCommit: acceptance.commit,
      })
    }
  }
  return {
    source: acceptedSource,
    sources: nextConfig.assetSources ?? [],
    validation,
    ...(directEditorRebaseline ? { directEditorRebaseline } : {}),
  }
}

function parseAssetSourceScope(
  value: string | undefined,
): NonNullable<MatOSAssetSourceConfig['scope']> | undefined {
  return value === 'project' ||
    value === 'core' ||
    value === 'user' ||
    value === 'team' ||
    value === 'shared' ||
    value === 'global'
    ? value
    : undefined
}

function parseGiteaAssetScope(value: string | undefined): MatOSGiteaAssetScope | undefined {
  return value === 'core' ||
    value === 'evolution' ||
    value === 'global' ||
    value === 'project' ||
    value === 'shared' ||
    value === 'team' ||
    value === 'user'
    ? value
    : undefined
}

function parseRuntimeScopedGiteaAssetSourceScope(
  value: string | undefined,
): 'user' | 'team' | 'project' | undefined {
  return value === 'user' || value === 'team' || value === 'project'
    ? value
    : undefined
}

function inferAssetSourceScopeFromGiteaOwner(
  owner: string,
): NonNullable<MatOSAssetSourceConfig['scope']> | undefined {
  if (owner === 'matos-users') return 'user'
  if (owner === 'matos-teams') return 'team'
  if (owner === 'matos-projects') return 'project'
  if (owner === 'matos-shared') return 'shared'
  if (owner === 'matos-core') return 'core'
  if (owner === 'matos-global') return 'global'
  return undefined
}

type RuntimeGiteaAssetSourceSpec = {
  id: string
  owner: string
  repo: string
  scope: NonNullable<MatOSAssetSourceConfig['scope']>
  giteaScope: MatOSGiteaAssetScope
  description: string
}

const RUNTIME_GITEA_ASSET_SOURCE_SPECS: RuntimeGiteaAssetSourceSpec[] = [
  {
    id: 'matos-core-assets',
    owner: 'matos-core',
    repo: 'assets',
    scope: 'core',
    giteaScope: 'core',
    description: 'Canonical MatOS core text assets.',
  },
  {
    id: 'matos-shared-assets',
    owner: 'matos-shared',
    repo: 'assets',
    scope: 'shared',
    giteaScope: 'shared',
    description: 'Shared operator-managed text assets.',
  },
  {
    id: 'matos-global-assets',
    owner: 'matos-global',
    repo: 'assets',
    scope: 'global',
    giteaScope: 'global',
    description: 'Global reference-only and shared text assets.',
  },
]

const GITEA_GOVERNANCE_REPO_SPECS: RuntimeGiteaAssetSourceSpec[] = [
  ...RUNTIME_GITEA_ASSET_SOURCE_SPECS,
  {
    id: 'matos-evolution-proposals',
    owner: 'matos-evolution',
    repo: 'proposals',
    scope: 'shared',
    giteaScope: 'evolution',
    description:
      'Self-evolution proposal/review repository; not a runtime asset source by default.',
  },
]

function parseGiteaRepoSpec(value: string | undefined):
  | { owner: string; repo: string }
  | undefined {
  const trimmed = value?.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) {
    return undefined
  }
  const [owner, repo, extra] = trimmed.split('/')
  if (!owner || !repo || extra) {
    return undefined
  }
  return {
    owner,
    repo: repo.endsWith('.git') ? repo.slice(0, -4) : repo,
  }
}

function giteaCloneBaseUrlFromEnv(): string | undefined {
  return matOSGiteaEnvValue([
    'MATOS_GITEA_SOURCE_BASE_URL',
    'MATOS_GITEA_UPSTREAM',
    'MATOS_GITEA_BASE_URL',
    'MATOS_GITEA_PUBLIC_BASE_URL',
  ])
}

function giteaBaseUrlFromEnv(): string | undefined {
  return (
    giteaCloneBaseUrlFromEnv() ||
    process.env.MATOS_GITEA_PUBLIC_BASE_URL?.trim()
  )
}

function giteaApiUrlFromEnv(): string | undefined {
  return (
    matOSGiteaEnvValue(['MATOS_GITEA_API_URL', 'MATOS_GITEA_API']) ||
    (matOSGiteaEnvValue(['MATOS_GITEA_UPSTREAM'])?.trim()
      ? `${matOSGiteaEnvValue(['MATOS_GITEA_UPSTREAM'])!.trim().replace(/\/+$/, '')}/api/v1`
      : undefined)
  )
}

function giteaTokenFromEnv(): string | undefined {
  return matOSGiteaEnvValue([
    'MATOS_GITEA_TOKEN',
    'MATOS_GATEWAY_GITEA_TOKEN',
  ])
}

function giteaScopeForOwner(
  owner: string,
): MatOSGiteaAssetScope | undefined {
  if (owner === 'matos-core') return 'core'
  if (owner === 'matos-global') return 'global'
  if (owner === 'matos-shared') return 'shared'
  if (owner === 'matos-projects') return 'project'
  if (owner === 'matos-teams') return 'team'
  if (owner === 'matos-users') return 'user'
  if (owner === 'matos-evolution') return 'evolution'
  return undefined
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

function buildRuntimeGiteaAssetSource(input: {
  spec: RuntimeGiteaAssetSourceSpec
  baseUrl: string
  ref?: string
  refresh?: NonNullable<MatOSAssetSourceConfig['refresh']>
  runtimeRefMode?: ParsedArgs['runtimeRefMode']
  channel?: string
}): MatOSGitAssetSourceConfig {
  const repo = matOSGiteaAssetRepoForScope({ scope: input.spec.giteaScope })
  const cloneUrl = matOSGiteaCloneUrl({
    baseUrl: input.baseUrl,
    owner: input.spec.owner,
    repo: input.spec.repo,
  })
  const webUrl = giteaWebUrl({
    baseUrl: input.baseUrl,
    owner: input.spec.owner,
    repo: input.spec.repo,
  })
  return {
    type: 'git',
    id: input.spec.id,
    repo: cloneUrl,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    scope: input.spec.scope,
    refresh: input.refresh ?? 'manual',
    provider: 'gitea',
    ...(input.runtimeRefMode === 'accepted'
      ? {
          runtimeRef: {
            mode: 'accepted-ref' as const,
            ref: matOSAcceptedBranchForSource({
              sourceId: input.spec.id,
              channel: input.channel ?? 'stable',
            }),
          },
        }
      : input.runtimeRefMode === 'commit' && input.ref?.trim()
        ? {
            runtimeRef: {
              mode: 'commit' as const,
              commit: input.ref.trim(),
            },
          }
        : {}),
    gitea: {
      owner: input.spec.owner,
      repo: input.spec.repo,
      visibility: repo.visibility,
      baseUrl: input.baseUrl,
      ...(webUrl ? { webUrl } : {}),
      cloneUrl,
    },
  }
}

export async function runAssetSourcesCommand(
  io: MatOSAssetsIO,
  subcommand: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  const command = subcommand ?? 'list'
  const config = await readMatOSProjectConfig(io.cwd)
  const sources = config.assetSources ?? []

  if (command === 'list') {
    if (parsed.json) {
      writeJson(io, {
        sources: sources.map(serializeMatOSAssetSourceConfig),
      })
    } else if (sources.length === 0) {
      io.stdout('No MatOS asset sources configured\n')
    } else {
      for (const source of sources) {
        io.stdout(
          `${source.type}:${source.id}\t${source.type === 'git' ? source.repo : source.path}\n`,
        )
      }
    }
    return 0
  }

  if (command === 'status') {
    const targetId = parsed.positionals[0]
    const selected = targetId
      ? sources.filter(source => source.id === targetId)
      : sources
    if (targetId && selected.length === 0) {
      io.stderr(`MatOS asset source not found: ${targetId}\n`)
      return 1
    }
    const statuses = await Promise.all(
      selected.map(source => inspectMatOSAssetSource(io.cwd, source)),
    )
    if (parsed.json) {
      writeJson(io, {
        ok: statuses.every(status => status.ok),
        sources: statuses,
      })
    } else if (statuses.length === 0) {
      io.stdout('No MatOS asset sources configured\n')
    } else {
      for (const status of statuses) {
        io.stdout(
          `${status.ok ? 'ok' : 'missing'}\t${status.type}:${status.id}${
            status.currentCommit ? `\t${status.currentCommit.slice(0, 12)}` : ''
          }\n`,
        )
      }
    }
    return statuses.every(status => status.ok) ? 0 : 1
  }

  if (command === 'refresh') {
    const targetId = parsed.positionals[0]
    const selected = targetId
      ? sources.filter(source => source.id === targetId)
      : sources
    if (sources.length === 0 || selected.length === 0) {
      io.stderr(
        targetId
          ? `MatOS asset source not found: ${targetId}\n`
          : 'No MatOS asset sources configured\n',
      )
      return 1
    }

    try {
      const refreshed: Array<Record<string, unknown>> = []
      for (const source of selected) {
        const materializedRoot = await materializeMatOSAssetSource(
          io.cwd,
          source,
          { refresh: 'always' },
        )
        refreshed.push({
          ...serializeMatOSAssetSourceConfig(source),
          materializedRoot,
        })
      }
      const validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
      const result = {
        ok: validation.ok,
        refreshed,
        validation,
      }
      if (parsed.json) {
        writeJson(io, result)
      } else if (validation.ok) {
        for (const source of refreshed) {
          io.stdout(`refreshed ${source.type}:${source.id}\n`)
        }
      } else {
        io.stderr('MatOS asset validation failed after source refresh\n')
        for (const error of validation.errors) {
          io.stderr(`${error.code}: ${error.message} (${error.manifestPath})\n`)
        }
      }
      return validation.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'add-git') {
    const id = parsed.positionals[0]
    const repo = parsed.repo?.trim()
    const scope = parseAssetSourceScope(parsed.rawScope ?? parsed.scope ?? 'project')
    if (!id || !repo || !scope) {
      io.stderr(
        'Usage: matos assets sources add-git <id> --repo <url> [--ref <ref>] [--subdir <path>] [--scope core|project|user|team|shared|global] [--refresh manual|always] [--json]\n',
      )
      return 1
    }
    const source: MatOSAssetSourceConfig = {
      type: 'git',
      id,
      repo,
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
      scope,
      refresh: parsed.sourceRefresh ?? 'manual',
    }
    try {
      await materializeMatOSAssetSource(io.cwd, source, {
        refresh: source.refresh === 'always' ? 'always' : 'manual',
      })
      const nextSources = [
        ...sources.filter(existing => existing.id !== id),
        source,
      ]
      await writeMatOSProjectConfig(io.cwd, {
        ...config,
        assetSources: nextSources,
      })
      const validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
      if (!validation.ok) {
        await writeMatOSProjectConfig(io.cwd, config)
      }
      const result = {
        ok: validation.ok,
        source: serializeMatOSAssetSourceConfig(source),
        sources: nextSources.map(serializeMatOSAssetSourceConfig),
        validation,
      }
      if (parsed.json) {
        writeJson(io, result)
      } else if (validation.ok) {
        io.stdout(`added git asset source ${id}\n`)
      } else {
        io.stderr('MatOS asset validation failed after adding source\n')
      }
      return validation.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'add-gitea') {
    const id = parsed.positionals[0]
    const repoSpec = parseGiteaRepoSpec(parsed.repo)
    const inferredScope = repoSpec
      ? inferAssetSourceScopeFromGiteaOwner(repoSpec.owner)
      : undefined
    const scope = parseAssetSourceScope(
      parsed.rawScope ?? parsed.scope ?? inferredScope ?? 'project',
    )
    if (!id || !repoSpec || !scope) {
      io.stderr(
        'Usage: matos assets sources add-gitea <id> --repo <owner/repo> [--clone-url <url>] [--base-url <url>] [--ref <ref>] [--subdir <path>] [--scope core|project|user|team|shared|global] [--scope-ref <scope-ref>] [--refresh manual|always] [--exclude-runtime] [--json]\n',
      )
      return 1
    }
    const baseUrl = parsed.baseUrl?.trim() || giteaBaseUrlFromEnv()
    const cloneUrl =
      parsed.cloneUrl?.trim() ||
      (baseUrl
        ? matOSGiteaCloneUrl({
            baseUrl,
            owner: repoSpec.owner,
            repo: repoSpec.repo,
          })
        : undefined)
    if (!cloneUrl) {
      io.stderr(
        'MatOS Gitea asset source requires --clone-url or --base-url/MATOS_GITEA_PUBLIC_BASE_URL\n',
      )
      return 1
    }
    const giteaScope = giteaScopeForOwner(repoSpec.owner)
    const giteaRepo = giteaScope
      ? matOSGiteaAssetRepoForScope({
          scope: giteaScope,
          ...(parsed.scopeRef ? { scopeRef: parsed.scopeRef } : {}),
          scopeId: repoSpec.repo.endsWith('-assets')
            ? repoSpec.repo.slice(0, -'-assets'.length)
            : repoSpec.repo,
        })
      : undefined
    const source: MatOSAssetSourceConfig = {
      type: 'git',
      id,
      repo: cloneUrl,
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
      scope,
      ...(parsed.scopeRef ? { scopeRef: parsed.scopeRef } : {}),
      refresh: parsed.sourceRefresh ?? 'manual',
      ...(parsed.excludeRuntime ? { includeInRuntime: false } : {}),
      provider: 'gitea',
      gitea: {
        owner: repoSpec.owner,
        repo: repoSpec.repo,
        visibility: giteaRepo?.visibility ?? 'private',
        ...(baseUrl ? { baseUrl } : {}),
        ...(giteaWebUrl({ baseUrl, owner: repoSpec.owner, repo: repoSpec.repo })
          ? {
              webUrl: giteaWebUrl({
                baseUrl,
                owner: repoSpec.owner,
                repo: repoSpec.repo,
              }),
            }
          : {}),
        cloneUrl,
      },
    }
    try {
      await materializeMatOSAssetSource(io.cwd, source, {
        refresh: source.refresh === 'always' ? 'always' : 'manual',
      })
      const nextSources = [
        ...sources.filter(existing => existing.id !== id),
        source,
      ]
      await writeMatOSProjectConfig(io.cwd, {
        ...config,
        assetSources: nextSources,
      })
      const validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
      if (!validation.ok) {
        await writeMatOSProjectConfig(io.cwd, config)
      }
      const result = {
        ok: validation.ok,
        source: serializeMatOSAssetSourceConfig(source),
        sources: nextSources.map(serializeMatOSAssetSourceConfig),
        validation,
      }
      if (parsed.json) {
        writeJson(io, result)
      } else if (validation.ok) {
        io.stdout(`added Gitea asset source ${id}\n`)
      } else {
        io.stderr('MatOS asset validation failed after adding Gitea source\n')
      }
      return validation.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'remove') {
    const id = parsed.positionals[0]
    if (!id) {
      io.stderr('Usage: matos assets sources remove <id> [--json]\n')
      return 1
    }
    const removed = sources.find(source => source.id === id)
    if (!removed) {
      io.stderr(`MatOS asset source not found: ${id}\n`)
      return 1
    }
    const nextSources = sources.filter(source => source.id !== id)
    await writeMatOSProjectConfig(io.cwd, {
      ...config,
      assetSources: nextSources,
    })
    if (parsed.json) {
      writeJson(io, {
        ok: true,
        removed: serializeMatOSAssetSourceConfig(removed),
        sources: nextSources.map(serializeMatOSAssetSourceConfig),
      })
    } else {
      io.stdout(`removed asset source ${id}\n`)
    }
    return 0
  }

  io.stderr(
    'Usage: matos assets sources list|status|refresh|add-git|add-gitea|remove [source-id] [--json]\n',
  )
  return 1
}

export async function runAssetGitCommand(
  io: MatOSAssetsIO,
  subcommand: string | undefined,
  parsed: ParsedArgs,
): Promise<number> {
  const command = subcommand ?? 'status'
  const apiUrl = parsed.apiUrl?.trim() || giteaApiUrlFromEnv()
  const token = giteaTokenFromEnv()
  const repo = parseGiteaRepoSpec(parsed.repo)

  const requireApiUrl = (): string | undefined => {
    if (!apiUrl) {
      io.stderr('MatOS Gitea API URL is required; pass --api-url or set MATOS_GITEA_API_URL\n')
      return undefined
    }
    return apiUrl
  }

  const requireRepo = (): { owner: string; repo: string } | undefined => {
    if (!repo) {
      io.stderr('MatOS Gitea repo is required as --repo <owner/repo>\n')
      return undefined
    }
    return repo
  }

  const resolveMergeSources = async (): Promise<
    | {
        fromSource: MatOSAssetSourceConfig
        toSource: MatOSAssetSourceConfig
        previousSource?: MatOSAssetSourceConfig
      }
    | undefined
  > => {
    const fromSourceId = parsed.fromSource?.trim()
    const toSourceId = parsed.toSource?.trim()
    if (!fromSourceId || !toSourceId) {
      io.stderr(
        `Usage: matos assets git ${command} --from-source <source-id> --to-source <source-id> [--previous-upstream-source <source-id>] [--json]\n`,
      )
      return undefined
    }
    const config = await readMatOSProjectConfig(io.cwd)
    const sources = config.assetSources ?? []
    const fromSource = sources.find(source => source.id === fromSourceId)
    const toSource = sources.find(source => source.id === toSourceId)
    const previousSource = parsed.previousUpstreamSource?.trim()
      ? sources.find(source => source.id === parsed.previousUpstreamSource?.trim())
      : undefined
    if (!fromSource) {
      io.stderr(`MatOS upstream asset source not found: ${fromSourceId}\n`)
      return undefined
    }
    if (!toSource) {
      io.stderr(`MatOS target asset source not found: ${toSourceId}\n`)
      return undefined
    }
    if (parsed.previousUpstreamSource?.trim() && !previousSource) {
      io.stderr(
        `MatOS previous upstream asset source not found: ${parsed.previousUpstreamSource.trim()}\n`,
      )
      return undefined
    }
    return {
      fromSource,
      toSource,
      ...(previousSource ? { previousSource } : {}),
    }
  }

  if (command === 'merge-plan') {
    const sources = await resolveMergeSources()
    if (!sources) {
      return 1
    }
    try {
      const upstreamRoot = await materializeMatOSAssetSource(io.cwd, sources.fromSource)
      const targetRoot = await materializeMatOSAssetSource(io.cwd, sources.toSource)
      const previousUpstreamRoot = sources.previousSource
        ? await materializeMatOSAssetSource(io.cwd, sources.previousSource)
        : undefined
      const plan = await buildMatOSAssetMergePlan({
        upstreamRoot,
        targetRoot,
        upstreamSourceId: sources.fromSource.id,
        targetSourceId: sources.toSource.id,
        ...(previousUpstreamRoot ? { previousUpstreamRoot } : {}),
      })
      if (parsed.json) {
        writeJson(io, plan)
      } else {
        io.stdout(
          `merge plan ${sources.fromSource.id} -> ${sources.toSource.id}: ${plan.summary.total} item(s), ${plan.summary.safeToAutoApply} auto-apply candidate(s), ${plan.summary.requiresUserConfirmation} require user confirmation\n`,
        )
      }
      return 0
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'merge-apply') {
    if (!parsed.autoOnly) {
      io.stderr(
        'Usage: matos assets git merge-apply --auto-only --from-source <source-id> --to-source <source-id> [--previous-upstream-source <source-id>] [--message <message>] [--push] [--json]\n',
      )
      return 1
    }
    const sources = await resolveMergeSources()
    if (!sources) {
      return 1
    }
    try {
      const upstreamRoot = await materializeMatOSAssetSource(io.cwd, sources.fromSource)
      const targetRoot = await materializeMatOSAssetSource(io.cwd, sources.toSource)
      const previousUpstreamRoot = sources.previousSource
        ? await materializeMatOSAssetSource(io.cwd, sources.previousSource)
        : undefined
      const plan = await buildMatOSAssetMergePlan({
        upstreamRoot,
        targetRoot,
        upstreamSourceId: sources.fromSource.id,
        targetSourceId: sources.toSource.id,
        ...(previousUpstreamRoot ? { previousUpstreamRoot } : {}),
      })
      const applied = await applyMatOSAssetMergePlanAutoOnly({
        upstreamRoot,
        targetRoot,
        plan,
      })
      const validation = await validateMaterializedAssetRoot({
        cwd: io.cwd,
        root: targetRoot,
        dependencyRoots: [upstreamRoot, previousUpstreamRoot].filter(
          (root): root is string => typeof root === 'string',
        ),
      })
      if (!validation.ok) {
        for (const item of applied.applied) {
          if (item.targetDir) {
            await rm(item.targetDir, { recursive: true, force: true }).catch(
              () => undefined,
            )
          }
          if (item.createdPackManifestPath) {
            await rm(item.createdPackManifestPath, { force: true }).catch(
              () => undefined,
            )
          }
        }
        const output = {
          ok: false,
          plan,
          applied: applied.applied,
          skipped: applied.skipped,
          validation,
        }
        if (parsed.json) {
          writeJson(io, output)
        } else {
          io.stderr('MatOS target asset source validation failed after merge apply\n')
        }
        return 1
      }
      const commit =
        sources.toSource.type === 'git'
          ? await commitMatOSGitAssetSource(io.cwd, sources.toSource, {
              message:
                parsed.message?.trim() ||
                `MatOS merge auto-add from ${sources.fromSource.id}`,
              push: parsed.push,
              token,
            })
          : undefined
      const output = {
        ok: true,
        plan,
        applied: applied.applied,
        skipped: applied.skipped,
        validation,
        ...(commit ? { commit } : {}),
      }
      if (parsed.json) {
        writeJson(io, output)
      } else {
        io.stdout(
          `applied ${applied.applied.length} auto merge item(s) from ${sources.fromSource.id} to ${sources.toSource.id}\n`,
        )
      }
      return 0
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'merge-review') {
    if (!parsed.llm) {
      io.stderr(
        'Usage: matos assets git merge-review --llm --from-source <source-id> --to-source <source-id> [--previous-upstream-source <source-id>] [--model <model>] [--json]\n',
      )
      return 1
    }
    const sources = await resolveMergeSources()
    if (!sources) {
      return 1
    }
    try {
      const upstreamRoot = await materializeMatOSAssetSource(io.cwd, sources.fromSource)
      const targetRoot = await materializeMatOSAssetSource(io.cwd, sources.toSource)
      const previousUpstreamRoot = sources.previousSource
        ? await materializeMatOSAssetSource(io.cwd, sources.previousSource)
        : undefined
      const plan = await buildMatOSAssetMergePlan({
        upstreamRoot,
        targetRoot,
        upstreamSourceId: sources.fromSource.id,
        targetSourceId: sources.toSource.id,
        ...(previousUpstreamRoot ? { previousUpstreamRoot } : {}),
      })
      const review = await (io.assetMergeReviewer ?? reviewMatOSAssetMergeWithLlm)({
        cwd: io.cwd,
        plan,
        upstreamRoot,
        targetRoot,
        ...(parsed.model?.trim() ? { model: parsed.model.trim() } : {}),
      })
      const output = {
        ok: review.enabled,
        plan,
        review,
      }
      if (parsed.json) {
        writeJson(io, output)
      } else if (review.enabled) {
        io.stdout(
          `merge review ${sources.fromSource.id} -> ${sources.toSource.id}: ${review.items.length} item(s), model=${review.model}\n`,
        )
      } else if (review.enabled === false) {
        io.stderr(`MatOS asset merge review failed: ${review.reason}\n`)
      }
      return review.enabled ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'promote') {
    const action = parsed.positionals[0] ?? 'create'
    const config = await readMatOSProjectConfig(io.cwd)
    const sourceById = new Map(
      (config.assetSources ?? []).map(source => [source.id, source]),
    )
    const fromSource = parsed.fromSource
      ? sourceById.get(parsed.fromSource)
      : undefined
    const toSource = parsed.toSource ? sourceById.get(parsed.toSource) : undefined
    const resolvedApiUrl = requireApiUrl()
    if (!resolvedApiUrl || !toSource || toSource.type !== 'git') {
      io.stderr(
        action === 'apply'
          ? 'Usage: matos assets git promote apply --to-source <source-id> --repo <owner/repo> --number <n> --reviewed --benchmark-passed --judge-passed [--channel stable] [--json]\n'
          : 'Usage: matos assets git promote create --from-source <source-id> --to-source <source-id> [--from <ref>] [--branch <promotion-branch>] [--target main] [--title <title>] [--body <text>] [--json]\n',
      )
      return 1
    }
    if (action === 'create') {
      if (!fromSource || fromSource.type !== 'git') {
        io.stderr(
          'Usage: matos assets git promote create --from-source <source-id> --to-source <source-id> [--from <ref>] [--branch <promotion-branch>] [--target main] [--title <title>] [--body <text>] [--json]\n',
        )
        return 1
      }
      try {
        const dependencyRoots = await materializeDependencyAssetSourceRoots({
          cwd: io.cwd,
          sources: config.assetSources ?? [],
          excludeSourceId: toSource.id,
          token,
        })
        const result = await createMatOSGiteaAssetPromotionReview({
          cwd: io.cwd,
          fromSource,
          toSource,
          apiUrl: resolvedApiUrl,
          token,
          fromRef: parsed.fromRef ?? parsed.ref,
          promotionBranch: parsed.branch,
          targetBranch: parsed.targetBranch,
          title: parsed.title,
          body: parsed.body,
          validateRoot: root =>
            validateMaterializedAssetRoot({
              cwd: io.cwd,
              root,
              dependencyRoots,
            }),
        })
        if (parsed.json) {
          writeJson(io, result)
        } else if (result.action === 'pr_created') {
          io.stdout(
            `promotion pr\t${result.toSourceId}\t${result.pullRequest?.number ?? ''}\t${result.pullRequest?.url ?? ''}\n`,
          )
        } else if (result.action === 'no_changes') {
          io.stdout(`promotion noop\t${result.fromSourceId} -> ${result.toSourceId}\n`)
        } else {
          io.stderr(`MatOS promotion validation failed: ${result.toSourceId}\n`)
        }
        return result.ok && result.validation.ok ? 0 : 1
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }
    if (action === 'apply') {
      const resolvedRepo = repo ?? (toSource.gitea?.owner && toSource.gitea?.repo
        ? { owner: toSource.gitea.owner, repo: toSource.gitea.repo }
        : undefined)
      if (!resolvedRepo || !parsed.number) {
        io.stderr(
          'Usage: matos assets git promote apply --to-source <source-id> --repo <owner/repo> --number <n> --reviewed --benchmark-passed --judge-passed [--channel stable] [--json]\n',
        )
        return 1
      }
      try {
        const dependencyRoots = await materializeDependencyAssetSourceRoots({
          cwd: io.cwd,
          sources: config.assetSources ?? [],
          excludeSourceId: toSource.id,
          token,
        })
        const result = await applyMatOSGiteaAssetPromotionReview({
          cwd: io.cwd,
          toSource,
          apiUrl: resolvedApiUrl,
          token,
          owner: resolvedRepo.owner,
          repo: resolvedRepo.repo,
          number: parsed.number,
          mergeMethod: parsed.mergeMethod,
          channel: parsed.channel ?? 'stable',
          pushAcceptedRef: parsed.push,
          acceptedBy: 'matos-promotion',
          gates: {
            reviewed: parsed.reviewed,
            benchmarkPassed: parsed.benchmarkPassed,
            judgePassed: parsed.judgePassed,
          },
          validateRoot: root =>
            validateMaterializedAssetRoot({
              cwd: io.cwd,
              root,
              dependencyRoots,
            }),
        })
        let validation: MatOSAssetValidationResult | undefined
        if (result.acceptance?.ok) {
          const nextSource: MatOSGitAssetSourceConfig = {
            ...toSource,
            runtimeRef: result.acceptance.runtimeRef,
          }
          const nextConfig = {
            ...config,
            assetSources: (config.assetSources ?? []).map(source =>
              source.id === toSource.id ? nextSource : source,
            ),
          }
          await writeMatOSProjectConfig(io.cwd, nextConfig)
          validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
          if (!validation.ok) {
            await writeMatOSProjectConfig(io.cwd, config)
          }
        }
        const output = {
          ...result,
          ...(validation ? { validation } : {}),
        }
        if (parsed.json) {
          writeJson(io, output)
        } else if (result.ok && result.acceptedRefAdvanced) {
          io.stdout(
            `promotion accepted\t${toSource.id}\t${result.acceptance?.commit ?? ''}\n`,
          )
        } else {
          io.stderr(`MatOS promotion apply blocked: ${result.action}\n`)
        }
        return result.ok && (validation?.ok ?? result.acceptance?.ok ?? false) ? 0 : 1
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }
    io.stderr(
      'Usage: matos assets git promote create|apply --from-source <source-id> --to-source <source-id> [--json]\n',
    )
    return 1
  }

  if (command === 'bootstrap') {
    const resolvedApiUrl = requireApiUrl()
    if (!resolvedApiUrl) {
      io.stderr(
        'Usage: matos assets git bootstrap --api-url <url> [--dry-run] [--json]\n',
      )
      return 1
    }
    try {
      const result = await bootstrapMatOSGiteaAssetRepos({
        apiUrl: resolvedApiUrl,
        token,
        dryRun: parsed.dryRun,
      })
      if (parsed.json) {
        writeJson(io, result)
      } else {
        for (const repo of result.repositories) {
          io.stdout(`${repo.action}\t${repo.owner}/${repo.repo}\n`)
        }
      }
      return result.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'accept') {
    const sourceId = parsed.positionals[0]?.trim()
    if (!sourceId) {
      io.stderr(
        'Usage: matos assets git accept <source-id> [--ref <commit-or-ref>] [--channel stable] [--push] [--json]\n',
      )
      return 1
    }
    const config = await readMatOSProjectConfig(io.cwd)
    const source = (config.assetSources ?? []).find(item => item.id === sourceId)
    if (!source || source.type !== 'git') {
      io.stderr(`MatOS git asset source not found: ${sourceId}\n`)
      return 1
    }
    try {
      const dependencyRoots = await materializeDependencyAssetSourceRoots({
        cwd: io.cwd,
        sources: config.assetSources ?? [],
        excludeSourceId: source.id,
        token,
      })
      const statusOwner =
        source.gitea?.owner && source.gitea?.repo
          ? {
              owner: source.gitea.owner,
              repo: source.gitea.repo,
              ...(source.gitea.baseUrl ? { baseUrl: source.gitea.baseUrl } : {}),
            }
          : undefined
      const result = await acceptMatOSGiteaAssetSourceCommit({
        cwd: io.cwd,
        source,
        ref: parsed.ref,
        channel: parsed.channel ?? 'stable',
        push:
          parsed.push ||
          gitSourceNeedsRemoteAcceptedPush(source as MatOSGitAssetSourceConfig),
        token,
        validateRoot: root =>
          validateMaterializedAssetRoot({
            cwd: io.cwd,
            root,
            dependencyRoots,
          }),
        ...(apiUrl && statusOwner
          ? {
              giteaStatus: {
                apiUrl,
                ...statusOwner,
              },
            }
          : {}),
      })
      const nextSource: MatOSGitAssetSourceConfig = {
        ...source,
        runtimeRef: result.runtimeRef,
      }
      const nextConfig = {
        ...config,
        assetSources: (config.assetSources ?? []).map(item =>
          item.id === source.id ? nextSource : item,
        ),
      }
      let validation: MatOSAssetValidationResult = result.validation
      let directEditorRebaseline: Awaited<
        ReturnType<typeof rebaselineDirectEditorAfterAcceptedSource>
      >
      if (result.ok) {
        await writeMatOSProjectConfig(io.cwd, nextConfig)
        validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
        if (!validation.ok) {
          await writeMatOSProjectConfig(io.cwd, config)
        } else {
          directEditorRebaseline = await rebaselineDirectEditorAfterAcceptedSource({
            cwd: io.cwd,
            source: nextSource,
            sourceCommit: result.commit,
          })
        }
      }
      const output = {
        ...result,
        source: serializeMatOSAssetSourceConfig(nextSource),
        validation,
        ...(directEditorRebaseline
          ? {
              directEditorRebaseline:
                summarizeDirectEditorRebaselineForCli(directEditorRebaseline),
            }
          : {}),
      }
      if (parsed.json) {
        writeJson(io, output)
      } else if (result.ok && validation.ok) {
        io.stdout(
          `accepted ${source.id}\t${result.commit}\t${result.acceptedBranch}\n`,
        )
      } else {
        io.stderr(`MatOS accepted source validation failed: ${source.id}\n`)
      }
      return result.ok && validation.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'sync-sources') {
    const baseUrl = parsed.baseUrl?.trim() || giteaCloneBaseUrlFromEnv()
    if (!baseUrl) {
      io.stderr(
        'Usage: matos assets git sync-sources --base-url <url> [--ref <ref>] [--refresh manual|always] [--replace] [--dry-run] [--json]\n',
      )
      return 1
    }

    const config = await readMatOSProjectConfig(io.cwd)
    const existingSources = config.assetSources ?? []
    const ref = parsed.ref?.trim() || 'main'
    const refresh = parsed.sourceRefresh ?? 'manual'
    const runtimeSources = RUNTIME_GITEA_ASSET_SOURCE_SPECS.map(spec =>
      buildRuntimeGiteaAssetSource({
        spec,
        baseUrl,
        ref,
        refresh,
        runtimeRefMode: parsed.runtimeRefMode,
        channel: parsed.channel,
      }),
    )
    const runtimeSourceIds = new Set(runtimeSources.map(source => source.id))
    const nextSources = [
      ...(parsed.replace
        ? []
        : existingSources.filter(source => !runtimeSourceIds.has(source.id))),
      ...runtimeSources,
    ]
    const nextConfig = {
      ...config,
      includeDefaultAssetRoots: false,
      ...(parsed.replace ? { assetRoots: [] } : {}),
      assetSources: nextSources,
    }
    const governanceRepositories = GITEA_GOVERNANCE_REPO_SPECS.map(spec => {
      const repo = matOSGiteaAssetRepoForScope({ scope: spec.giteaScope })
      return {
        id: spec.id,
        owner: spec.owner,
        repo: spec.repo,
        visibility: repo.visibility,
        runtimeSource: runtimeSourceIds.has(spec.id),
        description: spec.description,
        cloneUrl: matOSGiteaCloneUrl({
          baseUrl,
          owner: spec.owner,
          repo: spec.repo,
        }),
        webUrl: giteaWebUrl({
          baseUrl,
          owner: spec.owner,
          repo: spec.repo,
        }),
      }
    })

    if (parsed.dryRun) {
      if (parsed.json) {
        writeJson(io, {
          ok: true,
          dryRun: true,
          includeDefaultAssetRoots: nextConfig.includeDefaultAssetRoots,
          assetRoots: nextConfig.assetRoots,
          sources: nextSources.map(serializeMatOSAssetSourceConfig),
          governanceRepositories,
        })
      } else {
        for (const source of runtimeSources) {
          io.stdout(`would sync ${source.id}\t${source.repo}\n`)
        }
      }
      return 0
    }

    try {
      const materialized: Array<Record<string, unknown>> = []
      for (const source of runtimeSources) {
        const materializedRoot = await materializeMatOSAssetSource(
          io.cwd,
          source,
          { refresh },
        )
        materialized.push({
          ...serializeMatOSAssetSourceConfig(source),
          materializedRoot,
        })
      }

      await writeMatOSProjectConfig(io.cwd, nextConfig)
      const validation = await validateMatOSAssets(await loadMatOSAssets(io.cwd))
      if (!validation.ok) {
        await writeMatOSProjectConfig(io.cwd, config)
      }
      const result = {
        ok: validation.ok,
        includeDefaultAssetRoots: nextConfig.includeDefaultAssetRoots,
        assetRoots: nextConfig.assetRoots,
        sources: nextSources.map(serializeMatOSAssetSourceConfig),
        materialized,
        governanceRepositories,
        validation,
      }
      if (parsed.json) {
        writeJson(io, result)
      } else if (validation.ok) {
        for (const source of runtimeSources) {
          io.stdout(`synced ${source.id}\t${source.repo}\n`)
        }
      } else {
        io.stderr('MatOS asset validation failed after syncing Gitea sources\n')
        for (const error of validation.errors.slice(0, 20)) {
          io.stderr(`${error.code}: ${error.message} (${error.manifestPath})\n`)
        }
      }
      return validation.ok ? 0 : 1
    } catch (error) {
      await writeMatOSProjectConfig(io.cwd, config)
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'sync-user-source' || command === 'sync-scope-source') {
    const scopeRef = parsed.scopeRef?.trim()
    const scope =
      command === 'sync-user-source'
        ? 'user'
        : parseRuntimeScopedGiteaAssetSourceScope(parsed.rawScope)
    const baseUrl = parsed.baseUrl?.trim() || giteaCloneBaseUrlFromEnv()
    if (!scope || !scopeRef || !baseUrl) {
      io.stderr(
        command === 'sync-user-source'
          ? 'Usage: matos assets git sync-user-source --scope-ref user:<id> --base-url <url> [--id <source-id>] [--ref <ref>] [--runtime-ref source|accepted] [--push] [--refresh manual|always] [--replace] [--dry-run] [--json]\n'
          : 'Usage: matos assets git sync-scope-source --scope user|team|project --scope-ref <scope:id> --base-url <url> [--id <source-id>] [--ref <ref>] [--runtime-ref source|accepted] [--push] [--refresh manual|always] [--replace] [--dry-run] [--json]\n',
      )
      return 1
    }
    if (!scopeRef.toLowerCase().startsWith(`${scope}:`)) {
      io.stderr(
        `MatOS ${scope} Gitea asset source requires --scope-ref ${scope}:<id>\n`,
      )
      return 1
    }
    if (parsed.runtimeRefMode === 'commit') {
      io.stderr(
        'MatOS scoped Gitea asset sources support --runtime-ref accepted or source; use matos assets git accept to pin an accepted commit.\n',
      )
      return 1
    }

    const runtimeRefMode = scopedRuntimeRefMode(parsed.runtimeRefMode)
    const source = buildRuntimeScopedGiteaAssetSource({
      scope,
      scopeRef,
      baseUrl,
      ...(parsed.id?.trim() ? { id: parsed.id.trim() } : {}),
      ref: parsed.ref,
      refresh: parsed.sourceRefresh ?? 'manual',
      runtimeRefMode,
      channel: parsed.channel,
    })

    if (parsed.dryRun) {
      const config = await readMatOSProjectConfig(io.cwd)
      const existingSources = config.assetSources ?? []
      const nextSources = [
        ...existingSources.filter(existing => existing.id !== source.id),
        source,
      ]
      if (parsed.json) {
        writeJson(io, {
          ok: true,
          dryRun: true,
          source: serializeRuntimeScopedGiteaAssetSource(source),
          sources: nextSources.map(serializeMatOSAssetSourceConfig),
        })
      } else {
        io.stdout(`would sync ${source.id}\t${source.repo}\n`)
      }
      return 0
    }

    try {
      const result = await syncRuntimeScopedGiteaAssetSource({
        cwd: io.cwd,
        scope,
        scopeRef,
        baseUrl,
        ...(parsed.id?.trim() ? { id: parsed.id.trim() } : {}),
        ref: parsed.ref,
        refresh: parsed.sourceRefresh ?? 'manual',
        replace: parsed.replace,
        token,
      })
      const accepted =
        runtimeRefMode === 'accepted' && result.validation.ok
          ? await acceptScopedRuntimeSource({
              cwd: io.cwd,
              source: result.source,
              ref: parsed.ref,
              channel: parsed.channel,
              push: parsed.push,
              token,
              apiUrl,
            })
          : undefined
      const outputSource = accepted?.source ?? result.source
      const outputSources = accepted?.sources ?? result.sources
      const outputValidation = accepted?.validation ?? result.validation
      const output = {
        ok: result.ok && outputValidation.ok,
        source: serializeRuntimeScopedGiteaAssetSource(outputSource),
        sources: outputSources.map(serializeMatOSAssetSourceConfig),
        materializedRoot: result.materializedRoot,
        validation: outputValidation,
      }
      if (parsed.json) {
        writeJson(io, output)
      } else if (outputValidation.ok) {
        io.stdout(`synced ${outputSource.id}\t${outputSource.repo}\n`)
      } else {
        io.stderr('MatOS asset validation failed after syncing user Gitea source\n')
        for (const error of outputValidation.errors.slice(0, 20)) {
          io.stderr(`${error.code}: ${error.message} (${error.manifestPath})\n`)
        }
      }
      return outputValidation.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'commit-source') {
    const sourceId = parsed.positionals[0]?.trim()
    const message = parsed.message?.trim()
    if (!sourceId || !message) {
      io.stderr(
        'Usage: matos assets git commit-source <source-id> --message <message> [--branch <branch>] [--push] [--json]\n',
      )
      return 1
    }
    const config = await readMatOSProjectConfig(io.cwd)
    const source = (config.assetSources ?? []).find(item => item.id === sourceId)
    if (!source) {
      io.stderr(`MatOS asset source not found: ${sourceId}\n`)
      return 1
    }
    try {
      const result = await commitMatOSGitAssetSource(io.cwd, source, {
        message,
        branch: parsed.branch,
        push: parsed.push,
        token: giteaTokenFromEnv(),
      })
      if (parsed.json) {
        writeJson(io, result)
      } else if (result.action === 'noop') {
        io.stdout(`no changes in ${sourceId}\n`)
      } else {
        io.stdout(
          `committed ${sourceId}\t${result.commit ?? ''}${
            result.pushed ? '\tpushed' : ''
          }\n`,
        )
      }
      return 0
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'sync-generated-scope') {
    const scope = parseRuntimeScopedGiteaAssetSourceScope(parsed.rawScope)
    const scopeRef = parsed.scopeRef?.trim()
    if (!scope || !scopeRef) {
      io.stderr(
        'Usage: matos assets git sync-generated-scope --scope user|team|project --scope-ref <ref> [--json]\n',
      )
      return 1
    }
    try {
      const result = await syncGeneratedScopedAssetsToGitea({
        cwd: io.cwd,
        scope,
        scopeRef,
        runId: `generated-sync-${scope}-${Date.now()}`,
        summary: parsed.message,
        env: process.env,
      })
      if (parsed.json) {
        writeJson(io, result)
      } else if (result.ok) {
        io.stdout(
          `synced generated scoped assets\t${scopeRef}\t${result.copiedAssets.length}\n`,
        )
      } else {
        io.stderr(`generated scoped asset sync failed\t${scopeRef}\n`)
        for (const error of result.sourceCommitErrors ?? []) {
          io.stderr(`${error.sourceId}: ${error.error}\n`)
        }
        for (const skipped of result.skippedAssets.slice(0, 20)) {
          io.stderr(`${skipped.generatedDir}: ${skipped.reason}\n`)
        }
      }
      return result.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'status') {
    const config = await readMatOSProjectConfig(io.cwd)
    const giteaAssetSources = (config.assetSources ?? []).filter(
      source => source.type === 'git' && source.provider === 'gitea',
    )
    const cloneBaseUrl = parsed.baseUrl?.trim() || giteaCloneBaseUrlFromEnv()
    const runtimeSourceConfigured = giteaAssetSources.length > 0
    const apiConfigured = Boolean(apiUrl)
    const cloneConfigured = Boolean(cloneBaseUrl)
    if (parsed.json) {
      writeJson(io, {
        configured: apiConfigured || cloneConfigured || runtimeSourceConfigured,
        apiConfigured,
        apiUrl,
        cloneConfigured,
        cloneBaseUrl,
        tokenConfigured: Boolean(token),
        runtimeSourceConfigured,
        acceptedRuntimeSources: giteaAssetSources
          .filter(
            (source): source is MatOSGitAssetSourceConfig =>
              source.type === 'git' && Boolean(source.runtimeRef),
          )
          .map(source => ({
            id: source.id,
            repo: source.repo,
            ref: source.ref,
            runtimeRef: source.runtimeRef,
            gitea: source.gitea,
          })),
        runtimeSources: RUNTIME_GITEA_ASSET_SOURCE_SPECS.map(spec => ({
          id: spec.id,
          owner: spec.owner,
          repo: spec.repo,
          configured: giteaAssetSources.some(source => source.id === spec.id),
        })),
        governanceRepositories: GITEA_GOVERNANCE_REPO_SPECS.map(spec => ({
          id: spec.id,
          owner: spec.owner,
          repo: spec.repo,
          runtimeSource: RUNTIME_GITEA_ASSET_SOURCE_SPECS.some(
            runtime => runtime.id === spec.id,
          ),
        })),
        assetSources: giteaAssetSources.map(serializeMatOSAssetSourceConfig),
      })
    } else {
      io.stdout(`gitea api: ${apiUrl ?? 'not configured'}\n`)
      io.stdout(`gitea clone base: ${cloneBaseUrl ?? 'not configured'}\n`)
      io.stdout(`gitea token: ${token ? 'configured' : 'missing'}\n`)
      io.stdout(`gitea asset sources: ${giteaAssetSources.length}\n`)
    }
    return 0
  }

  if (command === 'provision-scope') {
    const resolvedApiUrl = requireApiUrl()
    const scope = parseGiteaAssetScope(parsed.rawScope)
    if (!resolvedApiUrl || !scope) {
      io.stderr(
        'Usage: matos assets git provision-scope --scope user|team|project|shared|global|core|evolution [--scope-ref <ref>] [--member <user>] [--admin <user>] [--api-url <url>] [--register-source --base-url <url>] [--dry-run] [--json]\n',
      )
      return 1
    }
    try {
      const repo = matOSGiteaAssetRepoForScope({
        scope,
        scopeRef: parsed.scopeRef,
      })
      const result = await provisionMatOSGiteaAssetScope({
        apiUrl: resolvedApiUrl,
        token,
        owner: repo.owner,
        repo: repo.repo,
        scopeLabel: repo.scopeId ? `${repo.scopeKind}:${repo.scopeId}` : repo.scopeKind,
        private: repo.visibility !== 'public',
        members: parsed.members,
        admins: parsed.admins,
        dryRun: parsed.dryRun,
      })
      const cloneBase = parsed.baseUrl ?? giteaBaseUrlFromEnv()
      let assetSource:
        | {
            ok: boolean
            source: Record<string, unknown>
            sources: Record<string, unknown>[]
            materializedRoot?: string
            validation?: MatOSAssetValidationResult
          }
        | undefined
      const runtimeScope = parseRuntimeScopedGiteaAssetSourceScope(scope)
      if (parsed.registerSource) {
        if (!runtimeScope) {
          throw new Error(
            '--register-source is supported only for user, team, or project scopes',
          )
        }
        if (!cloneBase) {
          throw new Error(
            'MatOS Gitea source registration requires --base-url or MATOS_GITEA_PUBLIC_BASE_URL',
          )
        }
        if (parsed.runtimeRefMode === 'commit') {
          throw new Error(
            'MatOS scoped Gitea asset sources support --runtime-ref accepted or source; use matos assets git accept to pin an accepted commit.',
          )
        }
        if (parsed.dryRun) {
          const source = buildRuntimeScopedGiteaAssetSource({
            scope: runtimeScope,
            scopeRef: parsed.scopeRef ?? `${runtimeScope}:${repo.scopeId ?? 'default'}`,
            baseUrl: cloneBase,
            ref: parsed.ref,
            refresh: parsed.sourceRefresh ?? 'manual',
            runtimeRefMode: scopedRuntimeRefMode(parsed.runtimeRefMode),
            channel: parsed.channel,
          })
          assetSource = {
            ok: true,
            source: serializeRuntimeScopedGiteaAssetSource(source),
            sources: [serializeRuntimeScopedGiteaAssetSource(source)],
          }
        } else {
          const runtimeRefMode = scopedRuntimeRefMode(parsed.runtimeRefMode)
          const synced = await syncRuntimeScopedGiteaAssetSource({
            cwd: io.cwd,
            scope: runtimeScope,
            scopeRef: parsed.scopeRef ?? `${runtimeScope}:${repo.scopeId}`,
            baseUrl: cloneBase,
            ref: parsed.ref,
            refresh: parsed.sourceRefresh ?? 'manual',
            channel: parsed.channel,
            replace: true,
            token,
          })
          const accepted =
            runtimeRefMode === 'accepted' && synced.validation.ok
              ? await acceptScopedRuntimeSource({
                  cwd: io.cwd,
                  source: synced.source,
                  ref: parsed.ref,
                  channel: parsed.channel,
                  push: true,
                  token,
                  apiUrl: resolvedApiUrl,
                })
              : undefined
          const outputSource = accepted?.source ?? synced.source
          const outputSources = accepted?.sources ?? synced.sources
          const outputValidation = accepted?.validation ?? synced.validation
          assetSource = {
            ok: synced.ok && outputValidation.ok,
            source: serializeRuntimeScopedGiteaAssetSource(outputSource),
            sources: outputSources.map(serializeMatOSAssetSourceConfig),
            materializedRoot: synced.materializedRoot,
            validation: outputValidation,
          }
        }
      }
      const output = {
        ...result,
        scope,
        scopeRef: parsed.scopeRef,
        repo: {
          owner: repo.owner,
          repo: repo.repo,
          visibility: repo.visibility,
          scopeKind: repo.scopeKind,
          ...(repo.scopeId ? { scopeId: repo.scopeId } : {}),
          ...(cloneBase
            ? {
                cloneUrl: matOSGiteaCloneUrl({
                  baseUrl: cloneBase,
                  owner: repo.owner,
                  repo: repo.repo,
                }),
              }
            : {}),
        },
        ...(assetSource ? { assetSource } : {}),
      }
      if (parsed.json) {
        writeJson(io, output)
      } else {
        io.stdout(`${result.repository.action}\t${repo.owner}/${repo.repo}\n`)
        for (const member of result.members) {
          io.stdout(`${member.action}\t${member.permission}\t${member.username}\n`)
        }
      }
      return result.ok ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'rollback-pr') {
    const sourceId = parsed.positionals[0]?.trim()
    const resolvedApiUrl = requireApiUrl()
    if (!sourceId || !resolvedApiUrl) {
      io.stderr(
        'Usage: matos assets git rollback-pr <source-id> --from <accepted-ref> [--repo <owner/repo>] [--branch <rollback-branch>] [--target main] [--title <title>] [--body <text>] [--api-url <url>] [--json]\n',
      )
      return 1
    }
    const config = await readMatOSProjectConfig(io.cwd)
    const source = (config.assetSources ?? []).find(item => item.id === sourceId)
    if (!source) {
      io.stderr(`MatOS asset source not found: ${sourceId}\n`)
      return 1
    }
    const restoreRef =
      parsed.fromRef?.trim() ||
      (source.type === 'git' && source.runtimeRef?.mode === 'accepted-ref'
        ? source.runtimeRef.ref
        : source.type === 'git' && source.runtimeRef?.mode === 'commit'
          ? source.runtimeRef.commit
          : undefined)
    if (!restoreRef) {
      io.stderr(
        'Usage: matos assets git rollback-pr <source-id> --from <accepted-ref> [--repo <owner/repo>] [--branch <rollback-branch>] [--target main] [--title <title>] [--body <text>] [--api-url <url>] [--json]\n',
      )
      return 1
    }
    try {
      const dependencyRoots = await materializeDependencyAssetSourceRoots({
        cwd: io.cwd,
        sources: config.assetSources ?? [],
        excludeSourceId: source.id,
        token,
      })
      const result = await createMatOSGiteaRollbackPullRequest({
        cwd: io.cwd,
        source,
        apiUrl: resolvedApiUrl,
        token,
        ...(repo ? { owner: repo.owner, repo: repo.repo } : {}),
        restoreRef,
        rollbackBranch: parsed.branch,
        targetBranch: parsed.targetBranch,
        title: parsed.title,
        body: parsed.body,
        validateRoot: root =>
          validateMaterializedAssetRoot({
            cwd: io.cwd,
            root,
            dependencyRoots,
          }),
      })
      if (parsed.json) {
        writeJson(io, result)
      } else if (result.action === 'noop') {
        io.stdout(
          `rollback noop\t${result.sourceId}\t${result.restoreCommit}\n`,
        )
      } else if (result.action === 'validation_failed') {
        io.stderr(
          `rollback validation failed\t${result.sourceId}\t${result.restoreCommit}\n`,
        )
      } else {
        io.stdout(
          `rollback pr\t${result.owner}/${result.repo}#${result.pullRequest?.number ?? ''}\t${result.pullRequest?.url ?? ''}\n`,
        )
      }
      return result.ok && result.action !== 'validation_failed' ? 0 : 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'branch') {
    const action = parsed.positionals[0] ?? 'create'
    if (action !== 'create') {
      io.stderr(
        'Usage: matos assets git branch create --repo <owner/repo> --branch <branch> [--from <ref>] [--api-url <url>] [--json]\n',
      )
      return 1
    }
    const resolvedApiUrl = requireApiUrl()
    const resolvedRepo = requireRepo()
    if (!resolvedApiUrl || !resolvedRepo || !parsed.branch?.trim()) {
      io.stderr(
        'Usage: matos assets git branch create --repo <owner/repo> --branch <branch> [--from <ref>] [--api-url <url>] [--json]\n',
      )
      return 1
    }
    try {
      const result = await createMatOSGiteaBranch({
        apiUrl: resolvedApiUrl,
        token,
        owner: resolvedRepo.owner,
        repo: resolvedRepo.repo,
        branch: parsed.branch,
        fromRef: parsed.fromRef ?? parsed.ref,
      })
      if (parsed.json) {
        writeJson(io, result)
      } else {
        io.stdout(`${result.action}\t${result.owner}/${result.repo}:${result.branch}\n`)
      }
      return 0
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (command === 'pr') {
    const action = parsed.positionals[0] ?? 'status'
    const resolvedApiUrl = requireApiUrl()
    const resolvedRepo = requireRepo()
    if (!resolvedApiUrl || !resolvedRepo) {
      io.stderr(
        'Usage: matos assets git pr create|status|merge --repo <owner/repo> [--source <branch> --target <branch> --title <title>|--number <n>] [--json]\n',
      )
      return 1
    }
    try {
      if (action === 'create') {
        if (!parsed.sourceBranch?.trim() || !parsed.title?.trim()) {
          io.stderr(
            'Usage: matos assets git pr create --repo <owner/repo> --source <branch> [--target main] --title <title> [--body <text>] [--api-url <url>] [--json]\n',
          )
          return 1
        }
        const result = await createMatOSGiteaPullRequest({
          apiUrl: resolvedApiUrl,
          token,
          owner: resolvedRepo.owner,
          repo: resolvedRepo.repo,
          sourceBranch: parsed.sourceBranch,
          targetBranch: parsed.targetBranch?.trim() || 'main',
          title: parsed.title,
          body: parsed.body,
        })
        if (parsed.json) {
          writeJson(io, result)
        } else {
          io.stdout(
            `pr\t${result.owner}/${result.repo}#${result.number}\t${result.url ?? ''}\n`,
          )
        }
        return 0
      }
      if (action === 'status') {
        if (!parsed.number) {
          io.stderr(
            'Usage: matos assets git pr status --repo <owner/repo> --number <n> [--api-url <url>] [--json]\n',
          )
          return 1
        }
        const result = await readMatOSGiteaPullRequest({
          apiUrl: resolvedApiUrl,
          token,
          owner: resolvedRepo.owner,
          repo: resolvedRepo.repo,
          number: parsed.number,
        })
        if (parsed.json) {
          writeJson(io, result)
        } else {
          io.stdout(
            `pr\t${result.owner}/${result.repo}#${result.number}\t${result.state ?? 'unknown'}\t${result.url ?? ''}\n`,
          )
        }
        return 0
      }
      if (action === 'merge' || action === 'apply') {
        if (!parsed.number) {
          io.stderr(
            'Usage: matos assets git pr merge --repo <owner/repo> --number <n> [--method merge|squash|rebase] [--api-url <url>] [--json]\n',
          )
          return 1
        }
        const result = await mergeMatOSGiteaPullRequest({
          apiUrl: resolvedApiUrl,
          token,
          owner: resolvedRepo.owner,
          repo: resolvedRepo.repo,
          number: parsed.number,
          method: parsed.mergeMethod,
        })
        if (parsed.json) {
          writeJson(io, result)
        } else {
          io.stdout(`merged\t${result.owner}/${result.repo}#${result.number}\n`)
        }
        return 0
      }
      io.stderr(
        'Usage: matos assets git pr create|status|merge --repo <owner/repo> [--json]\n',
      )
      return 1
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  io.stderr('Usage: matos assets git status|merge-plan|merge-apply|merge-review|promote|bootstrap|sync-sources|sync-user-source|sync-scope-source|commit-source|accept|provision-scope|rollback-pr|branch|pr [--json]\n')
  return 1
}
