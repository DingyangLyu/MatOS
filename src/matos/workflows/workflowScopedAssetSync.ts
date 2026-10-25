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

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { matOSGiteaScopeIdFromScopeRef } from '../assets/giteaGovernance.js'
import { getMatOSDir, readMatOSProjectConfig } from '../project.js'
import type { MatOSEnv } from '../runtime/runtimeEnv.js'
import { envValue } from '../runtime/runtimeEnv.js'
import {
  syncGeneratedScopedAssetsToGitea,
  type MatOSGeneratedScopedAssetSyncResult,
} from '../learning/generatedScopedAssetSync.js'
import type { MatOSDirectAssetEditorScope } from '../learning/directAssetEditorTypes.js'
import type { PublishWorkflowDraftResult } from './workflowStore.js'

type ScopedWorkflowAssetSyncScope = Extract<
  MatOSDirectAssetEditorScope,
  'user' | 'team' | 'project'
>

export type MatOSWorkflowScopedGiteaSyncResult = {
  ok: boolean
  action: 'skipped' | 'synced' | 'failed'
  scope?: ScopedWorkflowAssetSyncScope
  scopeRef?: string
  reason?: string
  generatedDir?: string
  localAssetDisabled?: boolean
  localAssetRemoved?: boolean
  activationRequired?: boolean
  nextAction?: {
    activateCli: string
  }
  gitea?: MatOSGeneratedScopedAssetSyncResult
}

const GENERATED_SCOPE_DIRS: Record<ScopedWorkflowAssetSyncScope, string> = {
  user: 'users',
  team: 'teams',
  project: 'projects',
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function workflowScopeFromRef(scopeRef: string | undefined): {
  scope: ScopedWorkflowAssetSyncScope
  scopeRef: string
} | undefined {
  const normalized = scopeRef?.trim()
  if (!normalized) {
    return undefined
  }
  for (const scope of ['user', 'team', 'project'] as const) {
    if (normalized.startsWith(`${scope}:`) && normalized.slice(scope.length + 1).trim()) {
      return { scope, scopeRef: normalized }
    }
  }
  return undefined
}

function workflowScopeRef(input: {
  scopeRef?: string
  env?: MatOSEnv
}): string | undefined {
  return (
    input.scopeRef?.trim() ||
    envValue(input.env ?? process.env, 'MATOS_SCOPE_REF') ||
    envValue(input.env ?? process.env, 'MATOS_SCOPE_ID') ||
    undefined
  )
}

function workflowScopedGiteaSyncDisabled(env: MatOSEnv | undefined): boolean {
  const explicit = envValue(env ?? process.env, 'MATOS_WORKFLOW_SCOPED_GITEA_SYNC')
  if (explicit !== undefined) {
    return ['0', 'false', 'off', 'no', 'disabled'].includes(
      explicit.trim().toLowerCase(),
    )
  }
  return envValue(env ?? process.env, 'MATOS_AUTOMAT_BENCHMARK') === '1'
}

async function inferSingleScopedWorkflowSourceRef(
  cwd: string,
): Promise<string | undefined> {
  try {
	    const config = await readMatOSProjectConfig(cwd)
	    const refs = new Set<string>()
	    for (const source of config.assetSources ?? []) {
	      if (source.type !== 'git') {
	        continue
	      }
	      const scoped = workflowScopeFromRef(source.scopeRef)
      if (scoped) {
        refs.add(scoped.scopeRef)
      }
    }
    return refs.size === 1 ? [...refs][0] : undefined
  } catch {
    return undefined
  }
}

function workflowIdFromPublishedAssetKey(assetKey: string): string {
  const withoutType = assetKey.startsWith('workflow:')
    ? assetKey.slice('workflow:'.length)
    : assetKey
  const at = withoutType.indexOf('@')
  return at >= 0 ? withoutType.slice(0, at) : withoutType
}

function generatedScopedWorkflowDir(input: {
  cwd: string
  scope: ScopedWorkflowAssetSyncScope
  scopeRef: string
  workflowId: string
}): string {
  return join(
    getMatOSDir(input.cwd),
    'assets',
    'generated',
    'scopes',
    GENERATED_SCOPE_DIRS[input.scope],
    matOSGiteaScopeIdFromScopeRef(input.scopeRef),
    'workflow',
    input.workflowId,
  )
}

async function copyPublishedWorkflowToGeneratedScope(input: {
  published: PublishWorkflowDraftResult
  targetDir: string
}): Promise<void> {
  await rm(input.targetDir, { recursive: true, force: true })
  await mkdir(dirname(input.targetDir), { recursive: true })
  await cp(input.published.assetDir, input.targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  })
}

async function removeGeneratedScopedWorkflowDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function removeLocalPublishedWorkflowAsset(
  published: PublishWorkflowDraftResult,
): Promise<void> {
  await rm(published.assetDir, { recursive: true, force: true })
}

async function disableLocalPublishedWorkflowAsset(input: {
  published: PublishWorkflowDraftResult
  reason: string
}): Promise<void> {
  const original = await readFile(input.published.manifestPath, 'utf8')
  const manifest = JSON.parse(original) as Record<string, unknown>
  const lifecycle = objectRecord(manifest.lifecycle)
  await writeFile(
    input.published.manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        lifecycle: {
          ...lifecycle,
          status: 'disabled',
          reason: input.reason,
          updatedAt: new Date().toISOString(),
          origin: 'workflow-scoped-gitea-sync',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

export async function syncPublishedWorkflowDraftToScopedGitea(input: {
  cwd: string
  scopeRef?: string
  env?: MatOSEnv
  draftId: string
  published: PublishWorkflowDraftResult
}): Promise<MatOSWorkflowScopedGiteaSyncResult> {
  if (workflowScopedGiteaSyncDisabled(input.env)) {
    return {
      ok: true,
      action: 'skipped',
      reason: 'workflow scoped Gitea sync disabled for this runtime',
    }
  }

  const scoped = workflowScopeFromRef(
    workflowScopeRef(input) ?? (await inferSingleScopedWorkflowSourceRef(input.cwd)),
  )
  if (!scoped) {
    return {
      ok: true,
      action: 'skipped',
      reason: 'workflow publish did not run in a user/team/project scope',
    }
  }

  // Project files remain project-local; accepted account/team assets belong
  // to the configured scope workspace, not a fresh project's empty config.
  let assetsCwd = input.cwd
  const workspaceCwd = envValue(input.env ?? process.env, 'MATOS_ASSETS_CWD')
  try {
    if (workspaceCwd && resolve(workspaceCwd) !== resolve(input.cwd)) {
      const hasSource = async (cwd: string) => (await readMatOSProjectConfig(cwd, { strict: true }))
        .assetSources?.some(source => source.type === 'git' && source.scope === scoped.scope && source.scopeRef === scoped.scopeRef)
      if (!(await hasSource(input.cwd)) && await hasSource(workspaceCwd)) assetsCwd = workspaceCwd
    }
  } catch (error) {
    await removeLocalPublishedWorkflowAsset(input.published)
    throw error
  }

  const workflowId = workflowIdFromPublishedAssetKey(input.published.assetKey)
  const generatedDir = generatedScopedWorkflowDir({
    cwd: assetsCwd,
    scope: scoped.scope,
    scopeRef: scoped.scopeRef,
    workflowId,
  })
  try {
    await copyPublishedWorkflowToGeneratedScope({
      published: input.published,
      targetDir: generatedDir,
    })
    await disableLocalPublishedWorkflowAsset({
      published: input.published,
      reason:
        `Workflow asset ${input.published.assetKey} is pending scoped Gitea acceptance for ${scoped.scopeRef}; ` +
        'the accepted Gitea ref is the runtime authority.',
    })
  } catch (error) {
    // Staging can fail before the local copy is disabled. Retain the draft,
    // but never leave an unaccepted asset enabled in the local registry.
    await removeLocalPublishedWorkflowAsset(input.published)
    await removeGeneratedScopedWorkflowDir(generatedDir)
    throw error
  }

  const runId = `workflow-${input.draftId}-${Date.now()}`
  let gitea: MatOSGeneratedScopedAssetSyncResult
  try {
    gitea = await syncGeneratedScopedAssetsToGitea({
      cwd: assetsCwd,
      scope: scoped.scope,
      scopeRef: scoped.scopeRef,
      runId,
      summary: `Publish workflow ${input.published.assetKey}`,
      env: input.env,
      parkRuntimeAssetsAsDraft: false,
      generatedAssetDirs: [generatedDir],
    })
  } catch (error) {
    await removeGeneratedScopedWorkflowDir(generatedDir)
    return {
      ok: false,
      action: 'failed',
      scope: scoped.scope,
      scopeRef: scoped.scopeRef,
      generatedDir,
      localAssetDisabled: true,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  if (!gitea.ok) {
    await removeGeneratedScopedWorkflowDir(generatedDir)
    return {
      ok: false,
      action: 'failed',
      scope: scoped.scope,
      scopeRef: scoped.scopeRef,
      generatedDir,
      localAssetDisabled: true,
      reason:
        gitea.sourceCommitErrors?.map(error => `${error.sourceId}: ${error.error}`).join('; ') ||
        gitea.skippedAssets.map(asset => asset.reason).join('; ') ||
        'scoped Gitea sync failed',
      gitea,
    }
  }

  await removeLocalPublishedWorkflowAsset(input.published)
  return {
    ok: true,
    action: 'synced',
    scope: scoped.scope,
    scopeRef: scoped.scopeRef,
    generatedDir,
    localAssetRemoved: true,
    gitea,
  }
}
