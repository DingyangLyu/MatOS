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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { adaptMatOSPath } from '../assets/adaptPath.js'
import { matOSGiteaScopeIdFromScopeRef } from '../assets/giteaGovernance.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type {
  MatOSAsset,
  MatOSAssetMounts,
  MatOSAssetType,
} from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import type { MatOSDirectAssetEditorScope } from '../learning/directAssetEditorTypes.js'
import { syncGeneratedScopedAssetsToGitea } from '../learning/generatedScopedAssetSync.js'
import { getMatOSDir } from '../project.js'
import {
  applyMatOSWorkbenchAssetCreate,
  previewMatOSWorkbenchAssetCreate,
} from '../workbench/assetCreation.js'

type ScopedAssetScope = Extract<MatOSDirectAssetEditorScope, 'user' | 'team' | 'project'>

const GENERATED_SCOPE_DIRS: Record<ScopedAssetScope, string> = {
  user: 'users',
  team: 'teams',
  project: 'projects',
}

const GENERIC_ASSET_TYPES = [
  'knowledge',
  'data',
  'tool',
  'skill',
  'mcp',
] as const satisfies readonly MatOSAssetType[]

type GenericAssetType = (typeof GENERIC_ASSET_TYPES)[number]
type AssetEditAction = 'create' | 'update' | 'upsert' | 'preview_create' | 'preview_update'

const GENERIC_ASSET_TYPE_SET = new Set<string>(GENERIC_ASSET_TYPES)
const PROJECT_LOCAL_CREATE_TYPES = new Set<string>([
  'knowledge',
  'data',
  'tool',
  'skill',
  'mcp',
])
const DEFAULT_VERSION = '0.1.0'
const VALID_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const ENTRY_FILE_BY_TYPE: Record<GenericAssetType, string> = {
  knowledge: 'README.md',
  data: 'DATA.md',
  tool: 'TOOL.md',
  skill: 'SKILL.md',
  mcp: 'mcp.json',
}

export type MatOSAssetBuilderToolResult = {
  text: string
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type MatOSAssetBuilderTool = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    additionalProperties?: boolean
  }
  call: (input: unknown) => Promise<MatOSAssetBuilderToolResult>
}

export type MatOSAssetBuilderToolContext = {
  /** Project execution cwd; relative adapt_path inputs resolve from here. */
  cwd: string
  /**
   * Scope-level asset governance cwd. User/team/project accepted Gitea
   * sources are registered here even when the active chat runs in a nested
   * project directory.
   */
  assetCwd?: string
  selectedRole?: string
  selectedAssetKeys?: string[]
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringArray(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  return [...new Set(
    raw
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean),
  )]
}

function jsonResult(value: Record<string, unknown>): MatOSAssetBuilderToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    structuredContent: value,
    isError: value.ok === false,
  }
}

function errorResult(message: string, extra: Record<string, unknown> = {}): MatOSAssetBuilderToolResult {
  return jsonResult({
    ok: false,
    error: message,
    ...extra,
  })
}

function textSchema(
  properties: Record<string, object>,
  required: string[] = [],
): MatOSAssetBuilderTool['inputSchema'] {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: true,
  }
}

function slugSegment(value: string | undefined, fallback: string): string {
  const slug = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/@.*/, '')
    .replace(/^[a-z0-9-]+:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || fallback
}

function normalizeGenericAssetType(value: unknown): GenericAssetType | undefined {
  const type = optionalString(value)
  return type && GENERIC_ASSET_TYPE_SET.has(type)
    ? (type as GenericAssetType)
    : undefined
}

function scopeFromRef(scopeRef: string | undefined): {
  scope: ScopedAssetScope
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

function requestScopeRef(raw: Record<string, unknown>): string | undefined {
  return (
    optionalString(raw.scopeRef) ??
    optionalString(raw.scope_ref) ??
    optionalString(raw.scope) ??
    process.env.MATOS_SCOPE_REF ??
    process.env.MATOS_SCOPE_ID ??
    undefined
  )
}

function safeRelativeAssetFile(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('\0') || isAbsolute(trimmed)) {
    return undefined
  }
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
    return undefined
  }
  return parts.join('/')
}

function generatedScopedAssetDir(input: {
  cwd: string
  scope: ScopedAssetScope
  scopeRef: string
  type: GenericAssetType
  assetId: string
}): string {
  return join(
    getMatOSDir(input.cwd),
    'assets',
    'generated',
    'scopes',
    GENERATED_SCOPE_DIRS[input.scope],
    matOSGiteaScopeIdFromScopeRef(input.scopeRef),
    input.type,
    input.assetId,
  )
}

function assetSourceProvenance(asset: MatOSAsset): Record<string, unknown> {
  const provenance = asset.metadata.sourceProvenance
  return provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>)
    : {}
}

function assetSourceScope(asset: MatOSAsset): string | undefined {
  return optionalString(assetSourceProvenance(asset).scope)
}

function assetSourceScopeRef(asset: MatOSAsset): string | undefined {
  const provenance = assetSourceProvenance(asset)
  return optionalString(provenance.scopeRef) ?? optionalString(provenance.scope_ref)
}

function isScopedGiteaAsset(asset: MatOSAsset, scoped: { scope: ScopedAssetScope; scopeRef: string }): boolean {
  return assetSourceScope(asset) === scoped.scope && assetSourceScopeRef(asset) === scoped.scopeRef
}

function mountRefs(mounts: MatOSAssetMounts): string[] {
  return [...new Set(Object.values(mounts).flatMap(refs => refs ?? []))]
}

function normalizeMounts(value: unknown): MatOSAssetMounts {
  const raw = metadataObject(value)
  const mounts: MatOSAssetMounts = {}
  for (const group of ['knowledge', 'data', 'skills', 'tools', 'mcp', 'plugins', 'workflows', 'roles'] as const) {
    const refs = stringArray(raw[group])
    if (refs.length > 0) {
      mounts[group] = refs
    }
  }
  return mounts
}

function mergeMounts(
  existing: MatOSAssetMounts,
  replacement: MatOSAssetMounts | undefined,
  add: MatOSAssetMounts,
  remove: MatOSAssetMounts,
): MatOSAssetMounts {
  const next: MatOSAssetMounts = {}
  const base = replacement ?? existing
  for (const group of ['knowledge', 'data', 'skills', 'tools', 'mcp', 'plugins', 'workflows', 'roles'] as const) {
    const values = new Set(base[group] ?? [])
    for (const ref of add[group] ?? []) {
      values.add(ref)
    }
    for (const ref of remove[group] ?? []) {
      values.delete(ref)
    }
    if (values.size > 0) {
      next[group] = [...values]
    }
  }
  return next
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const object = metadataObject(value)
  return Object.keys(object).length > 0 ? object : undefined
}

function genericAssetRef(type: GenericAssetType, id: string, version = DEFAULT_VERSION): string {
  return `${type}:${id}@${version}`
}

async function readExistingEntry(asset: MatOSAsset | undefined): Promise<string | undefined> {
  if (!asset?.entryAbsolutePath) {
    return undefined
  }
  try {
    return await readFile(asset.entryAbsolutePath, 'utf8')
  } catch {
    return undefined
  }
}

function defaultEntryContent(input: {
  type: GenericAssetType
  name: string
  description?: string
  targetRef: string
  now: string
}): string {
  if (input.type === 'mcp') {
    return `${JSON.stringify({
      mcpServers: {},
      matos: {
        assetRef: input.targetRef,
        createdAt: input.now,
        source: 'matos-agent-asset-builder',
      },
    }, null, 2)}\n`
  }
  return [
    `# ${input.name}`,
    '',
    input.description ?? `${input.type} asset created by MatOS asset_edit.`,
    '',
    '## MatOS Asset',
    '',
    `- Asset ref: ${input.targetRef}`,
    `- Asset type: ${input.type}`,
    `- Updated at: ${input.now}`,
    '- Source: MatOS agent asset builder',
    '',
  ].join('\n')
}

type GenericAssetPlan = {
  type: GenericAssetType
  id: string
  version: string
  targetRef: string
  name: string
  description?: string
  entry: string
  content?: string
  tags: string[]
  dependencies: string[]
  mounts: MatOSAssetMounts
  runtime: Record<string, unknown>
  metadata: Record<string, unknown>
}

function genericAssetPlan(input: {
  raw: Record<string, unknown>
  existing?: MatOSAsset
}): GenericAssetPlan | { error: string } {
  const type = normalizeGenericAssetType(input.raw.type ?? input.existing?.type)
  if (!type) {
    return {
      error:
        'asset_edit supports only knowledge, data, tool, skill, and mcp assets. Use role_edit for role assets and workflow_edit for workflow assets.',
    }
  }
  const id = slugSegment(
    optionalString(input.raw.id) ?? input.existing?.id ?? optionalString(input.raw.name),
    `${type}-asset`,
  )
  const version =
    optionalString(input.raw.version) ??
    input.existing?.version ??
    DEFAULT_VERSION
  const targetRef = genericAssetRef(type, id, version)
  const name =
    optionalString(input.raw.name) ??
    input.existing?.name ??
    id
  const description =
    optionalString(input.raw.description) ??
    input.existing?.description
  const entry =
    safeRelativeAssetFile(optionalString(input.raw.entry) ?? input.existing?.entryRelativePath) ??
    ENTRY_FILE_BY_TYPE[type]
  const replacementMounts =
    input.raw.mounts === undefined
      ? undefined
      : normalizeMounts(input.raw.mounts)
  const mounts = mergeMounts(
    input.existing?.mounts ?? {},
    replacementMounts,
    normalizeMounts(input.raw.addMounts ?? input.raw.add_mounts),
    normalizeMounts(input.raw.removeMounts ?? input.raw.remove_mounts),
  )
  const tags = stringArray(input.raw.tags).length
    ? stringArray(input.raw.tags)
    : input.existing?.tags.length
      ? input.existing.tags
      : [type, 'agent-created']
  const dependencies = stringArray(input.raw.dependencies).length
    ? stringArray(input.raw.dependencies)
    : input.existing?.dependencies ?? []
  const runtime = {
    ...(input.existing?.runtime ?? {}),
    ...(objectOrUndefined(input.raw.runtime) ?? {}),
  }
  const metadata = {
    ...(input.existing?.metadata ?? {}),
    ...(objectOrUndefined(input.raw.metadata) ?? {}),
  }
  delete metadata.sourceProvenance
  delete metadata.lifecycle
  return {
    type,
    id,
    version,
    targetRef,
    name,
    ...(description ? { description } : {}),
    entry,
    content: optionalString(input.raw.content),
    tags,
    dependencies,
    mounts,
    runtime,
    metadata,
  }
}

function assetManifest(input: {
  plan: GenericAssetPlan
  now: string
  action: 'create' | 'update'
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: input.plan.id,
    type: input.plan.type,
    name: input.plan.name,
    version: input.plan.version,
    ...(input.plan.description ? { description: input.plan.description } : {}),
    entry: input.plan.entry,
    tags: input.plan.tags,
    ...(input.plan.dependencies.length > 0 ? { dependencies: input.plan.dependencies } : {}),
    ...(mountRefs(input.plan.mounts).length > 0 ? { mounts: input.plan.mounts } : {}),
    ...(Object.keys(input.plan.runtime).length > 0 ? { runtime: input.plan.runtime } : {}),
    lifecycle: {
      status: 'enabled',
      origin: 'matos-agent-asset-builder',
      updatedAt: input.now,
    },
    metadata: {
      ...input.plan.metadata,
      sourceFormat: 'matos-agent-asset-builder',
      updatedAt: input.now,
      updatedBy: 'asset_edit',
      lastBuilderAction: input.action,
      targetRef: input.plan.targetRef,
    },
  }
}

async function referenceGate(input: {
  cwd: string
  plan: GenericAssetPlan
  existing?: MatOSAsset
  action: 'create' | 'update' | 'upsert'
}): Promise<{
  ok: boolean
  missingRefs: string[]
  targetConflict?: { ref: string; manifestPath: string; source: string }
  error?: string
}> {
  if (!VALID_ID_PATTERN.test(input.plan.id)) {
    return {
      ok: false,
      missingRefs: [],
      error: 'Asset id must be lowercase alphanumeric/hyphen, max 64 chars, starting with a letter or digit.',
    }
  }
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
    includeDisabled: true,
  })
  if (
    input.existing &&
    (input.plan.type !== input.existing.type ||
      input.plan.id !== input.existing.id ||
      input.plan.version !== (input.existing.version ?? DEFAULT_VERSION))
  ) {
    return {
      ok: false,
      missingRefs: [],
      error:
        `Refusing to update ${input.existing.canonicalKey} as ${input.plan.targetRef}; asset_edit update cannot change type/id/version.`,
    }
  }
  const target = registry.resolve(input.plan.targetRef)
  if (!input.existing && target && input.action === 'create') {
    return {
      ok: false,
      missingRefs: [],
      targetConflict: {
        ref: target.canonicalKey,
        manifestPath: target.manifestPath,
        source: target.source,
      },
      error: `Asset target already exists: ${target.canonicalKey}. Use action=update or action=upsert.`,
    }
  }
  const refs = [
    ...new Set([...input.plan.dependencies, ...mountRefs(input.plan.mounts)]),
  ]
  const missingRefs = refs.filter(ref => {
    if (!ref.includes(':')) {
      return false
    }
    return !registry.resolve(ref)
  })
  return {
    ok: missingRefs.length === 0,
    missingRefs,
    ...(missingRefs.length > 0
      ? { error: `Asset references are not resolvable: ${missingRefs.join(', ')}` }
      : {}),
  }
}

async function writeScopedGenericAsset(input: {
  cwd: string
  scoped: { scope: ScopedAssetScope; scopeRef: string }
  raw: Record<string, unknown>
  existing?: MatOSAsset
  action: 'create' | 'update' | 'upsert'
  reason?: string
}): Promise<Record<string, unknown>> {
  if (input.existing && !isScopedGiteaAsset(input.existing, input.scoped)) {
    return {
      ok: false,
      error:
        `Refusing to update ${input.existing.canonicalKey} through scoped asset_edit because it is not owned by ${input.scoped.scopeRef}. Create a new scoped asset or use reviewed promotion for core/shared assets.`,
      source: input.existing.source,
      sourceScope: assetSourceScope(input.existing),
      sourceScopeRef: assetSourceScopeRef(input.existing),
    }
  }
  const planned = genericAssetPlan({ raw: input.raw, existing: input.existing })
  if ('error' in planned) {
    return { ok: false, error: planned.error }
  }
  const gate = await referenceGate({
    cwd: input.cwd,
    plan: planned,
    existing: input.existing,
    action: input.action,
  })
  if (!gate.ok) {
    return {
      action: input.action,
      assetRef: planned.targetRef,
      ...gate,
      ok: false,
    }
  }
  const now = new Date().toISOString()
  const generatedDir = generatedScopedAssetDir({
    cwd: input.cwd,
    scope: input.scoped.scope,
    scopeRef: input.scoped.scopeRef,
    type: planned.type,
    assetId: planned.id,
  })
  await rm(generatedDir, { recursive: true, force: true })
  await mkdir(generatedDir, { recursive: true })
  await writeFile(
    join(generatedDir, 'asset.json'),
    `${JSON.stringify(assetManifest({
      plan: planned,
      now,
      action: input.existing ? 'update' : 'create',
    }), null, 2)}\n`,
    'utf8',
  )
  const entryPath = join(generatedDir, planned.entry)
  await mkdir(dirname(entryPath), { recursive: true })
  await writeFile(
    entryPath,
    planned.content ??
      (await readExistingEntry(input.existing)) ??
      defaultEntryContent({
        type: planned.type,
        name: planned.name,
        description: planned.description,
        targetRef: planned.targetRef,
        now,
      }),
    'utf8',
  )
  const runId = `asset-builder-${planned.type}-${planned.id}-${Date.now()}`
  const gitea = await syncGeneratedScopedAssetsToGitea({
    cwd: input.cwd,
    scope: input.scoped.scope,
    scopeRef: input.scoped.scopeRef,
    runId,
    summary:
      input.reason ??
      `${input.existing ? 'Update' : 'Create'} ${planned.type} asset ${planned.targetRef}`,
    env: process.env,
    parkRuntimeAssetsAsDraft: false,
    generatedAssetDirs: [generatedDir],
  })
  if (!gitea.ok) {
    await rm(generatedDir, { recursive: true, force: true })
    return {
      ok: false,
      action: input.action,
      assetRef: planned.targetRef,
      generatedDir,
      generatedDirRemoved: true,
      gitea,
      error:
        gitea.sourceCommitErrors?.map(error => `${error.sourceId}: ${error.error}`).join('; ') ||
        gitea.skippedAssets.map(asset => asset.reason).join('; ') ||
        'Scoped Gitea asset sync failed.',
    }
  }
  const assets = await loadMatOSAssets(input.cwd)
  const validation = await validateMatOSAssets(assets)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const resolved = registry.resolve(planned.targetRef)
  const activationRequired = resolved?.lifecycle.status === 'draft'
  return {
    ok: Boolean(resolved) && validation.ok,
    action: input.existing ? 'update' : 'create',
    assetRef: resolved?.canonicalKey ?? planned.targetRef,
    generatedDir,
    gitea,
    validation,
    ...(activationRequired
      ? {
          activationRequired: true,
          nextAction: {
            activateCli: `matos assets enable ${resolved.canonicalKey}`,
          },
        }
      : {}),
    ...(resolved
      ? {
          asset: {
            id: resolved.id,
            ref: resolved.canonicalKey,
            type: resolved.type,
            name: resolved.name,
            description: resolved.description,
            source: resolved.source,
            sourceScope: assetSourceScope(resolved),
            sourceScopeRef: assetSourceScopeRef(resolved),
            lifecycle: resolved.lifecycle,
          },
        }
      : {}),
  }
}

async function applyProjectLocalCreate(input: {
  cwd: string
  raw: Record<string, unknown>
  reason?: string
}): Promise<Record<string, unknown>> {
  const type = normalizeGenericAssetType(input.raw.type)
  if (!type || !PROJECT_LOCAL_CREATE_TYPES.has(type)) {
    return {
      ok: false,
      error:
        'project-local asset_edit fallback supports only knowledge, data, tool, skill, and mcp. Use scoped Gitea accepted-ref for other asset types.',
    }
  }
  const preview = await previewMatOSWorkbenchAssetCreate({
    cwd: input.cwd,
    type,
    id: optionalString(input.raw.id),
    name: optionalString(input.raw.name),
    description: optionalString(input.raw.description),
    version: optionalString(input.raw.version),
    packId: optionalString(input.raw.packId),
  })
  const applied = await applyMatOSWorkbenchAssetCreate({
    cwd: input.cwd,
    type,
    id: optionalString(input.raw.id),
    name: optionalString(input.raw.name),
    description: optionalString(input.raw.description),
    version: optionalString(input.raw.version),
    packId: optionalString(input.raw.packId),
    fingerprint: preview.transaction.confirmationFingerprint,
    reason: input.reason,
  })
  return {
    ok: applied.applied,
    action: 'create',
    target: 'project-local',
    preview,
    applied,
  }
}

function assetEditAction(value: unknown): AssetEditAction {
  const action = optionalString(value)
  return action === 'update' ||
    action === 'upsert' ||
    action === 'preview_create' ||
    action === 'preview_update'
    ? action
    : 'create'
}

export function createMatOSAssetBuilderTools(
  context: MatOSAssetBuilderToolContext,
): MatOSAssetBuilderTool[] {
  return [
    {
      name: 'adapt_path',
      description:
        'Adapt an uploaded file or database path into reusable scoped MatOS assets. Detects formats/schema/size/checksum, keeps payloads in place, creates a reference-only data asset plus guide/skill and a read-only query tool when supported, validates, and publishes through the scope accepted ref.',
      inputSchema: textSchema({
        path: { type: 'string', description: 'Readable file or directory path in the current workspace.' },
        scopeRef: { type: 'string', description: 'Scope ref such as user:alice, team:lab, or project:demo. Defaults to MATOS_SCOPE_REF.' },
        id: { type: 'string', description: 'Base asset id. Defaults to a slug derived from the path.' },
        name: { type: 'string', description: 'Asset display name.' },
        version: { type: 'string', description: 'Asset version. Defaults to 0.1.0.' },
        description: { type: 'string', description: 'Dataset description.' },
        reason: { type: 'string', description: 'Audit reason for the scoped Gitea commit.' },
        dryRun: { type: 'boolean', description: 'Inspect and preview without publishing.' },
        replace: { type: 'boolean', description: 'Replace same-scope assets with the same refs.' },
      }, ['path']),
      call: async input => {
        const raw = metadataObject(input)
        const path = optionalString(raw.path)
        if (!path) return errorResult('adapt_path requires path.')
        const result = await adaptMatOSPath({
          cwd: context.cwd,
          path,
          scopeRef: requestScopeRef(raw),
          id: optionalString(raw.id),
          name: optionalString(raw.name),
          version: optionalString(raw.version),
          description: optionalString(raw.description),
          reason: optionalString(raw.reason),
          dryRun: optionalBoolean(raw.dryRun) ?? false,
          replace: optionalBoolean(raw.replace) ?? false,
          env: process.env,
        })
        return jsonResult(result)
      },
    },
    {
      name: 'asset_edit',
      description:
        'Create or update non-role/non-workflow MatOS assets through native governance. Defaults to scoped Gitea accepted-ref when scopeRef is user/team/project; use role_edit/workflow_edit for roles and workflows.',
      inputSchema: textSchema({
        action: {
          type: 'string',
          enum: ['create', 'update', 'upsert', 'preview_create', 'preview_update'],
          description: 'Asset edit operation. Defaults to create.',
        },
        dryRun: { type: 'boolean', description: 'Preview only; do not write.' },
        target: {
          type: 'string',
          enum: ['scoped-gitea', 'project-local'],
          description: 'Write target. Defaults to scoped-gitea; project-local must be explicit.',
        },
        scopeRef: { type: 'string', description: 'Scope ref such as user:alice, team:lab, or project:demo.' },
        ref: { type: 'string', description: 'Existing asset ref for update/upsert.' },
        type: { type: 'string', enum: ['knowledge', 'data', 'tool', 'skill', 'mcp'], description: 'Asset type. Use role_edit for role and workflow_edit for workflow.' },
        id: { type: 'string', description: 'Asset id.' },
        version: { type: 'string', description: 'Asset version.' },
        name: { type: 'string', description: 'Asset display name.' },
        description: { type: 'string', description: 'Asset description.' },
        content: { type: 'string', description: 'Entry file content.' },
        entry: { type: 'string', description: 'Entry file path relative to the asset directory.' },
        tags: { type: 'array', description: 'Asset tags.' },
        dependencies: { type: 'array', description: 'Asset dependency refs.' },
        mounts: { type: 'object', description: 'Mount group replacement map.' },
        addMounts: { type: 'object', description: 'Mount group refs to add.' },
        removeMounts: { type: 'object', description: 'Mount group refs to remove.' },
        metadata: {
          type: 'object',
          description:
            'Additional manifest metadata. To personalize a read-only core/shared/global asset for this scope, create a scoped asset with the same type+id and set metadata.overlayOf to the exact public canonical key (type:id@version); the fork wins resolution only inside this scope.',
        },
        runtime: { type: 'object', description: 'Additional manifest runtime block.' },
        packId: { type: 'string', description: 'Project-local fallback pack id.' },
        reason: { type: 'string', description: 'Audit reason.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const action = assetEditAction(raw.action)
          const scoped = scopeFromRef(requestScopeRef(raw))
          const target = optionalString(raw.target) ?? 'scoped-gitea'
          // Project chats execute inside the project for file isolation, but
          // scoped accepted-ref sources live in MATOS_ASSETS_CWD. role_edit
          // already uses that governance root; asset_edit must do the same or
          // it sees an empty project-local source list and tries to repair a
          // source that already exists.
          const governanceCwd =
            target === 'project-local'
              ? context.cwd
              : context.assetCwd ?? context.cwd
          const reason = optionalString(raw.reason)
          const registry = buildMatOSAssetRegistry(await loadMatOSAssets(governanceCwd), {
            includeDisabled: true,
          })
          const existingRef = optionalString(raw.ref) ?? optionalString(raw.assetRef)
          const existing = existingRef ? registry.resolve(existingRef) : undefined
          if (existingRef && !existing) {
            return errorResult(`MatOS asset not found: ${existingRef}`)
          }
          if (existing && (existing.type === 'role' || existing.type === 'workflow')) {
            return errorResult(
              existing.type === 'role'
                ? 'Use role_edit for role assets.'
                : 'Use workflow_edit for workflow assets.',
            )
          }
          if (raw.type === 'role' || raw.type === 'workflow') {
            return errorResult(
              raw.type === 'role'
                ? 'Use role_edit for role assets.'
                : 'Use workflow_edit for workflow assets.',
            )
          }
          let planned = genericAssetPlan({
            raw,
            existing: existing && GENERIC_ASSET_TYPE_SET.has(existing.type) ? existing : undefined,
          })
          if ('error' in planned) {
            return errorResult(planned.error)
          }
          const targetExisting = existing ??
            (action === 'update' || action === 'upsert'
              ? registry.resolve(planned.targetRef)
              : undefined)
          if (targetExisting && (targetExisting.type === 'role' || targetExisting.type === 'workflow')) {
            return errorResult(
              targetExisting.type === 'role'
                ? 'Use role_edit for role assets.'
                : 'Use workflow_edit for workflow assets.',
            )
          }
          const existingGeneric =
            targetExisting && GENERIC_ASSET_TYPE_SET.has(targetExisting.type)
              ? targetExisting
              : undefined
          if (existingGeneric && existingGeneric !== existing) {
            planned = genericAssetPlan({ raw, existing: existingGeneric })
            if ('error' in planned) {
              return errorResult(planned.error)
            }
          }
          const effectiveAction: 'create' | 'update' =
            action === 'upsert' && existingGeneric
              ? 'update'
              : action === 'upsert'
                ? 'create'
                : action === 'update' || action === 'preview_update'
                  ? 'update'
                  : 'create'
          if (optionalBoolean(raw.dryRun) === true || action.startsWith('preview_')) {
            return jsonResult({
              ok: true,
              dryRun: true,
              action,
              target,
              selectedRole: context.selectedRole,
              selectedAssetKeys: context.selectedAssetKeys ?? [],
              plan: {
                operation: existingGeneric ? 'asset-update' : 'asset-create',
                target:
                  target === 'scoped-gitea'
                    ? scoped
                      ? {
                          mode: 'scoped-gitea',
                          scope: scoped.scope,
                          scopeRef: scoped.scopeRef,
                          generatedDir: generatedScopedAssetDir({
                            cwd: governanceCwd,
                            scope: scoped.scope,
                            scopeRef: scoped.scopeRef,
                            type: planned.type,
                            assetId: planned.id,
                          }),
                        }
                      : { mode: 'scoped-gitea', missingScopeRef: true }
                    : { mode: 'project-local' },
                proposedAsset: {
                  type: planned.type,
                  id: planned.id,
                  version: planned.version,
                  ref: planned.targetRef,
                  name: planned.name,
                  description: planned.description,
                  entry: planned.entry,
                  dependencies: planned.dependencies,
                  mounts: planned.mounts,
                },
              },
            })
          }
          if (target === 'project-local') {
            if (effectiveAction !== 'create') {
              return errorResult('project-local asset_edit supports create only; use scoped Gitea accepted-ref for updates.')
            }
            return jsonResult(
              await applyProjectLocalCreate({
                cwd: context.cwd,
                raw,
                reason,
              }),
            )
          }
          if (!scoped) {
            return errorResult(
              'asset_edit defaults to scoped-gitea and requires scopeRef=user:<id>, team:<id>, or project:<id>. Pass target=project-local explicitly only for local fallback creates.',
            )
          }
          if (effectiveAction === 'update' && !existingGeneric) {
            return errorResult('asset_edit action=update requires ref for an existing scoped asset.')
          }
          return jsonResult(
            await writeScopedGenericAsset({
              cwd: governanceCwd,
              scoped,
              raw,
              existing: existingGeneric,
              action: effectiveAction,
              reason,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
  ]
}
