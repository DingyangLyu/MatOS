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

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matOSGiteaScopeIdFromScopeRef } from '../assets/giteaGovernance.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry, type MatOSAssetRegistry } from '../assets/registry.js'
import { composeMatOSRoleRuntime } from '../assets/runtimeComposition.js'
import {
  MATOS_ASSET_MOUNT_GROUPS,
  type MatOSAsset,
  type MatOSAssetMountGroup,
  type MatOSAssetMounts,
} from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { getMatOSDir } from '../project.js'
import { scrubSecretsFromString } from '../sessions/traceContext.js'
import { syncGeneratedScopedAssetsToGitea } from '../learning/generatedScopedAssetSync.js'
import type { MatOSDirectAssetEditorScope } from '../learning/directAssetEditorTypes.js'
import {
  applyMatOSWorkbenchAssetCreate,
  previewMatOSWorkbenchAssetCreate,
} from '../workbench/assetCreation.js'
import {
  listMatOSWorkbenchRoles,
  showMatOSWorkbenchRole,
} from '../workbench/roles.js'
import {
  applyMatOSWorkbenchRoleDraft,
  previewMatOSWorkbenchRoleDraft,
} from '../workbench/roleDrafts.js'
import {
  bindMatOSWorkbenchCreatedRole,
} from '../workbench/projectGroups.js'
import {
  MATOS_ASSET_BUILDER_TOOL_NAMES,
  MATOS_ASSET_DISCOVERY_TOOL_NAMES,
  MATOS_ROLE_BUILDER_TOOL_NAMES,
  MATOS_WORKFLOW_FACADE_TOOL_NAMES,
  MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES,
  matOSAssetMcpToolName,
  matOSToolReferenceToAssetId,
} from './toolNames.js'

export type MatOSRoleBuilderToolResult = {
  text: string
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type MatOSRoleBuilderTool = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    additionalProperties?: boolean
  }
  call: (input: unknown) => Promise<MatOSRoleBuilderToolResult>
}

export type MatOSRoleBuilderToolContext = {
  cwd: string
  projectCwd?: string
  selectedRole?: string
  selectedAssetKeys?: string[]
  projectId?: string
  projectMemberId?: string
  env?: Record<string, string | undefined>
}

type ScopedRoleScope = Extract<MatOSDirectAssetEditorScope, 'user' | 'team' | 'project'>

type RoleBuilderAction =
  | 'context'
  | 'list'
  | 'show'
  | 'compose'
  | 'preview_create'
  | 'preview_update'

type RoleEditAction =
  | 'create'
  | 'update'
  | 'attach'
  | 'detach'
  | 'smoke'
  | 'bind-project'
type RoleProjectBindingMode = 'none' | 'add' | 'replace-current'

const MOUNTABLE_ASSET_TYPES = new Set([
  'knowledge',
  'data',
  'skill',
  'tool',
  'mcp',
  'plugin',
  'workflow',
  'role',
])

const GENERATED_SCOPE_DIRS: Record<ScopedRoleScope, string> = {
  user: 'users',
  team: 'teams',
  project: 'projects',
}

const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEFAULT_VERSION = '0.1.0'

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

function projectBindingMode(
  value: unknown,
  context: MatOSRoleBuilderToolContext,
): RoleProjectBindingMode {
  const requested = optionalString(value)
  if (
    requested === 'none' ||
    requested === 'add' ||
    requested === 'replace-current'
  ) {
    return requested
  }
  if (requested) {
    throw new Error(
      `Unsupported projectBinding '${requested}'. Use none, add, or replace-current.`,
    )
  }
  return context.projectId ? 'add' : 'none'
}

function optionalInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback
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

function jsonResult(value: Record<string, unknown>): MatOSRoleBuilderToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    structuredContent: value,
    isError: value.ok === false,
  }
}

function errorResult(message: string, extra: Record<string, unknown> = {}): MatOSRoleBuilderToolResult {
  return jsonResult({
    ok: false,
    error: message,
    ...extra,
  })
}

function textSchema(
  properties: Record<string, object>,
  required: string[] = [],
): MatOSRoleBuilderTool['inputSchema'] {
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
    .replace(/^role:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || fallback
}

function roleRefForId(id: string, version = DEFAULT_VERSION): string {
  return `role:${id}@${version}`
}

function unversionedRoleId(ref: string): string {
  return ref
    .trim()
    .replace(/^role:/, '')
    .replace(/@[^@]+$/, '')
}

function scopeFromRef(scopeRef: string | undefined): {
  scope: ScopedRoleScope
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

function generatedScopedRoleDir(input: {
  cwd: string
  scope: ScopedRoleScope
  scopeRef: string
  roleId: string
}): string {
  return join(
    getMatOSDir(input.cwd),
    'assets',
    'generated',
    'scopes',
    GENERATED_SCOPE_DIRS[input.scope],
    matOSGiteaScopeIdFromScopeRef(input.scopeRef),
    'role',
    input.roleId,
  )
}

function roleSourceScopeRef(asset: MatOSAsset): string | undefined {
  const provenance = metadataObject(asset.metadata.sourceProvenance)
  return optionalString(provenance.scopeRef) ?? optionalString(provenance.scope_ref)
}

function roleSourceScope(asset: MatOSAsset): string | undefined {
  const provenance = metadataObject(asset.metadata.sourceProvenance)
  return optionalString(provenance.scope)
}

function isScopedGiteaRole(asset: MatOSAsset, scoped: { scope: ScopedRoleScope; scopeRef: string }): boolean {
  return (
    asset.type === 'role' &&
    roleSourceScope(asset) === scoped.scope &&
    roleSourceScopeRef(asset) === scoped.scopeRef
  )
}

function mountGroupForRef(ref: string): MatOSAssetMountGroup | undefined {
  const prefix = ref.split(':', 1)[0]
  switch (prefix) {
    case 'knowledge':
      return 'knowledge'
    case 'data':
      return 'data'
    case 'skill':
      return 'skills'
    case 'tool':
      return 'tools'
    case 'mcp':
      return 'mcp'
    case 'plugin':
      return 'plugins'
    case 'workflow':
      return 'workflows'
    case 'role':
      return 'roles'
    default:
      return undefined
  }
}

function groupFromValue(value: unknown): MatOSAssetMountGroup | undefined {
  const text = optionalString(value)
  if (
    text === 'knowledge' ||
    text === 'data' ||
    text === 'skills' ||
    text === 'tools' ||
    text === 'mcp' ||
    text === 'plugins' ||
    text === 'workflows' ||
    text === 'roles'
  ) {
    return text
  }
  return undefined
}

function normalizeMounts(value: unknown): MatOSAssetMounts {
  const raw = metadataObject(value)
  const mounts: MatOSAssetMounts = {}
  for (const [key, item] of Object.entries(raw)) {
    const group = groupFromValue(key)
    if (!group) {
      continue
    }
    const refs = stringArray(item)
    if (refs.length > 0 || Array.isArray(item)) {
      mounts[group] = refs
    }
  }
  return mounts
}

function mountsFromInput(raw: Record<string, unknown>): MatOSAssetMounts {
  const mounts = normalizeMounts(raw.mounts)
  for (const group of ['knowledge', 'data', 'skills', 'tools', 'mcp', 'plugins', 'workflows', 'roles'] as const) {
    const refs = stringArray(raw[group])
    if (refs.length > 0 || Array.isArray(raw[group])) {
      mounts[group] = refs
    }
  }
  return mounts
}

function mergeMounts(
  base: MatOSAssetMounts,
  replace: MatOSAssetMounts,
  add: MatOSAssetMounts,
  remove: MatOSAssetMounts,
): MatOSAssetMounts {
  const groups = new Set<MatOSAssetMountGroup>([
    ...(Object.keys(base) as MatOSAssetMountGroup[]),
    ...(Object.keys(replace) as MatOSAssetMountGroup[]),
    ...(Object.keys(add) as MatOSAssetMountGroup[]),
    ...(Object.keys(remove) as MatOSAssetMountGroup[]),
  ])
  const result: MatOSAssetMounts = {}
  for (const group of groups) {
    const starting = replace[group] !== undefined ? replace[group] ?? [] : base[group] ?? []
    const added = add[group] ?? []
    const removed = new Set(remove[group] ?? [])
    const refs = [...new Set([...starting, ...added])].filter(ref => !removed.has(ref))
    if (refs.length > 0 || replace[group] !== undefined) {
      result[group] = refs
    }
  }
  return result
}

function mountRefs(mounts: MatOSAssetMounts): string[] {
  return [...new Set(Object.values(mounts).flatMap(refs => refs ?? []))].sort()
}

function canonicalAssetRef(
  registry: MatOSAssetRegistry,
  ref: string,
): string {
  return registry.resolve(ref)?.canonicalKey ?? ref
}

function canonicalizeRefList(
  registry: MatOSAssetRegistry,
  refs: string[],
): string[] {
  return [...new Set(refs.map(ref => canonicalAssetRef(registry, ref)))].sort()
}

function canonicalizeMounts(
  registry: MatOSAssetRegistry,
  mounts: MatOSAssetMounts,
): MatOSAssetMounts {
  const result: MatOSAssetMounts = {}
  for (const group of MATOS_ASSET_MOUNT_GROUPS) {
    const refs = mounts[group]
    if (!refs) {
      continue
    }
    result[group] = canonicalizeRefList(registry, refs)
  }
  return result
}

function mountDiff(input: {
  before: MatOSAssetMounts
  after: MatOSAssetMounts
  replaced: MatOSAssetMounts
}): Record<string, {
  mode: 'add' | 'merge' | 'replace'
  before: string[]
  after: string[]
  added: string[]
  removed: string[]
}> {
  const diff: Record<string, {
    mode: 'add' | 'merge' | 'replace'
    before: string[]
    after: string[]
    added: string[]
    removed: string[]
  }> = {}
  for (const group of MATOS_ASSET_MOUNT_GROUPS) {
    const before = input.before[group] ?? []
    const after = input.after[group] ?? []
    const beforeSet = new Set(before)
    const afterSet = new Set(after)
    const added = after.filter(ref => !beforeSet.has(ref))
    const removed = before.filter(ref => !afterSet.has(ref))
    const wasReplaced = input.replaced[group] !== undefined
    if (!added.length && !removed.length && !wasReplaced) {
      continue
    }
    diff[group] = {
      mode: wasReplaced ? 'replace' : before.length ? 'merge' : 'add',
      before,
      after,
      added,
      removed,
    }
  }
  return diff
}

function externalToolName(asset: MatOSAsset): string {
  return optionalString(asset.metadata.binding) ?? matOSAssetMcpToolName(asset.id)
}

function mcpServerNameFromToolPattern(pattern: string | undefined): string | undefined {
  const match = pattern?.match(/^mcp__(.+)__\*$/)
  return match?.[1]
}

function mcpRuntimeToolNames(asset: MatOSAsset): string[] {
  const serverName =
    optionalString(asset.metadata.mcpServerName) ??
    mcpServerNameFromToolPattern(optionalString(asset.metadata.toolNamePattern))
  const knownTools = stringArray(asset.metadata.knownTools)
  return knownTools
    .map(tool => tool.startsWith('mcp__') ? tool : serverName ? `mcp__${serverName}__${tool}` : undefined)
    .filter((tool): tool is string => Boolean(tool))
}

function runtimeToolNamesForToolAsset(asset: MatOSAsset): string[] {
  const kind = optionalString(asset.metadata.kind)
  if (kind === 'builtin-pack') {
    return stringArray(asset.metadata.builtinTools)
  }
  if (kind === 'external-tool') {
    return [externalToolName(asset)]
  }
  return [optionalString(asset.metadata.binding) ?? asset.id]
}

function runtimeToolNamesForAsset(
  registry: MatOSAssetRegistry,
  asset: MatOSAsset,
): string[] {
  if (asset.type === 'tool') {
    return runtimeToolNamesForToolAsset(asset)
  }
  if (asset.type === 'mcp') {
    return mcpRuntimeToolNames(asset)
  }
  if (asset.type !== 'skill') {
    return []
  }
  const names: string[] = []
  for (const reference of stringArray(asset.metadata.toolReferences)) {
    const tool = registry.resolve(reference)
    if (tool?.type === 'tool') {
      names.push(...runtimeToolNamesForToolAsset(tool))
    }
  }
  return [...new Set(names)].sort()
}

function defaultRoleBuilderRuntimeToolNames(): string[] {
  return [
    ...MATOS_ASSET_DISCOVERY_TOOL_NAMES,
    ...MATOS_ASSET_BUILDER_TOOL_NAMES,
    ...MATOS_ROLE_BUILDER_TOOL_NAMES,
    ...MATOS_WORKFLOW_FACADE_TOOL_NAMES,
    ...MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES,
  ].map(name => matOSAssetMcpToolName(name))
}

function promptToolReferences(prompt: string | undefined): string[] {
  if (!prompt) {
    return []
  }
  const matches = prompt.match(/\b(?:mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+|matos_tool__[A-Za-z0-9_]+)\b/g) ?? []
  return [...new Set(matches)].sort()
}

function promptToolReferenceReport(input: {
  registry: MatOSAssetRegistry
  prompt?: string
  allowedTools: string[]
  selectedAssets?: MatOSAsset[]
}): Record<string, unknown> | undefined {
  const references = promptToolReferences(input.prompt)
  if (!references.length) {
    return undefined
  }
  const allowed = new Set(input.allowedTools)
  const selectedAssets = input.selectedAssets ?? []
  const legacyMappings: Array<{
    reference: string
    assetRef: string
    runtimeNames: string[]
  }> = []
  const unresolved: string[] = []
  for (const reference of references) {
    if (allowed.has(reference)) {
      continue
    }
    if (!reference.startsWith('matos_tool__')) {
      unresolved.push(reference)
      continue
    }
    const assetId = matOSToolReferenceToAssetId(reference)
    const tool = selectedAssets.find(asset => asset.type === 'tool' && asset.id === assetId) ??
      input.registry.resolve(`tool:${assetId}`)
    if (!tool || tool.type !== 'tool') {
      unresolved.push(reference)
      continue
    }
    const runtimeNames = runtimeToolNamesForToolAsset(tool)
    if (runtimeNames.some(name => allowed.has(name))) {
      legacyMappings.push({
        reference,
        assetRef: tool.canonicalKey,
        runtimeNames,
      })
      continue
    }
    unresolved.push(reference)
  }
  return {
    references,
    unresolved,
    legacyMappings,
    ok: unresolved.length === 0,
    ...(unresolved.length
      ? {
          warning:
            'Prompt mentions tool names that are not available from the planned role mounts.',
        }
      : {}),
  }
}

function selectedAssetsFromComposition(
  registry: MatOSAssetRegistry,
  assetEvents: Array<{ type: string; assetKey: string }>,
): MatOSAsset[] {
  return assetEvents
    .filter(event => event.type === 'selected')
    .map(event => registry.resolve(event.assetKey))
    .filter((asset): asset is MatOSAsset => Boolean(asset))
}

function candidateSearchText(asset: MatOSAsset): string {
  return [
    asset.canonicalKey,
    `${asset.type}:${asset.id}`,
    asset.id,
    asset.name,
    asset.description,
    asset.source,
    asset.packId,
    ...asset.tags,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase()
}

function candidateRank(asset: MatOSAsset, terms: string[]): number {
  const alias = `${asset.type}:${asset.id}`.toLowerCase()
  const id = asset.id.toLowerCase()
  const name = asset.name.toLowerCase()
  const canonical = asset.canonicalKey.toLowerCase()
  const tags = asset.tags.join(' ').toLowerCase()
  const description = asset.description?.toLowerCase() ?? ''
  const typePriority = new Map([
    ['tool', 0],
    ['mcp', 1],
    ['plugin', 2],
    ['skill', 3],
    ['workflow', 4],
    ['role', 5],
    ['knowledge', 6],
    ['data', 7],
  ])
  let score = typePriority.get(asset.type) ?? 20
  for (const term of terms) {
    if (alias === term || id === term || name === term) {
      score += 0
    } else if (alias.includes(term) || id.includes(term)) {
      score += 2
    } else if (name.includes(term)) {
      score += 5
    } else if (canonical.includes(term)) {
      score += 10
    } else if (tags.includes(term)) {
      score += 20
    } else if (description.includes(term)) {
      score += 30
    } else {
      score += 100
    }
  }
  return score
}

function queryMountCandidates(input: {
  registry: MatOSAssetRegistry
  query?: string
  group?: MatOSAssetMountGroup
  types?: string[]
  limit: number
  offset: number
  selectedAssetKeys?: string[]
}): Record<string, unknown> {
  const terms = (input.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const selected = new Set(input.selectedAssetKeys ?? [])
  const candidates = input.registry.assets
    .filter(asset => MOUNTABLE_ASSET_TYPES.has(asset.type))
    .filter(asset => asset.lifecycle.status !== 'disabled')
    .filter(asset => asset.metadata.hidden !== true)
    .filter(asset => !input.group || mountGroupForRef(asset.canonicalKey) === input.group)
    .filter(asset => !input.types?.length || input.types.includes(asset.type))
    .filter(asset => terms.every(term => candidateSearchText(asset).includes(term)))
    .sort((left, right) =>
      candidateRank(left, terms) - candidateRank(right, terms) ||
      left.canonicalKey.localeCompare(right.canonicalKey),
    )
  const page = candidates.slice(input.offset, input.offset + input.limit)
  return {
    query: input.query ?? '',
    group: input.group,
    types: input.types ?? [],
    limit: input.limit,
    offset: input.offset,
    total: candidates.length,
    candidates: page.map(asset => ({
      ref: asset.canonicalKey,
      alias: `${asset.type}:${asset.id}`,
      type: asset.type,
      group: mountGroupForRef(asset.canonicalKey),
      name: asset.name,
      description: asset.description,
      version: asset.version,
      source: asset.source,
      packId: asset.packId,
      tags: asset.tags,
      mountedBySelectedRole: selected.has(asset.canonicalKey),
      runtimeToolNames: runtimeToolNamesForAsset(input.registry, asset),
    })),
  }
}

async function smokeRole(input: {
  cwd: string
  ref: string
  registry?: MatOSAssetRegistry
}): Promise<Record<string, unknown>> {
  const registry = input.registry ?? buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const role = registry.resolve(input.ref)
  if (!role || role.type !== 'role') {
    return {
      ok: false,
      roleRef: input.ref,
      error: `MatOS role asset not found: ${input.ref}`,
    }
  }
  const prompt = await readRolePrompt(role)
  const composition = await composeMatOSRoleRuntime(registry, role.canonicalKey, {
    projectCwd: input.cwd,
  })
  const skippedReferences = composition.assetEvents
    .filter(event => event.type === 'skipped')
    .map(event => ({
      ref: event.assetKey,
      reason: event.reason,
    }))
  const selectedAssets = selectedAssetsFromComposition(registry, composition.assetEvents)
  const promptTools = promptToolReferenceReport({
    registry,
    prompt,
    allowedTools: composition.allowedTools,
    selectedAssets,
  })
  const promptToolsOk = promptTools
    ? (promptTools.ok as boolean | undefined) !== false
    : true
  return {
    ok: skippedReferences.length === 0 && promptToolsOk,
    roleRef: role.canonicalKey,
    selectedAssetCount: selectedAssets.length,
    allowedToolCount: composition.allowedTools.length,
    skillDirCount: composition.skillDirs.length,
    mcpConfigCount: composition.mcpConfigJson.length + composition.mcpConfigPaths.length,
    mountedWorkflowCount: composition.mountedWorkflowRefs.length,
    skippedReferences,
    promptTools,
  }
}

function nextRoleActions(
  roleRef: string,
  lifecycleStatus: MatOSAsset['lifecycle']['status'] = 'enabled',
): Record<string, unknown> {
  const unversioned = roleRef.replace(/@[^@]+$/, '')
  if (lifecycleStatus !== 'enabled') {
    return {
      activateCli: `matos assets enable ${roleRef}`,
      smoke: {
        tool: 'role_edit',
        input: {
          action: 'smoke',
          ref: roleRef,
        },
      },
    }
  }
  return {
    switchCli: `/role ${unversioned.replace(/^role:/, '')}`,
    smoke: {
      tool: 'role_edit',
      input: {
        action: 'smoke',
        ref: roleRef,
      },
    },
    agentTool: `Task(subagent_type="${unversioned.replace(/^role:/, '')}", prompt="...")`,
  }
}

function defaultProjectMemberId(roleRef: string | undefined): string | undefined {
  if (!roleRef) {
    return undefined
  }
  return `agent-${slugSegment(roleRef, 'agent')}`
}

async function bindCreatedRoleToProject(input: {
  context: MatOSRoleBuilderToolContext
  mode: RoleProjectBindingMode
  projectId?: string
  projectMemberId?: string
  displayName?: string
  roleRef: string
  assetVersionPolicy?: 'follow-accepted' | 'pinned'
}): Promise<Record<string, unknown>> {
  if (input.mode === 'none') {
    return {
      ok: true,
      mode: 'none',
      changed: false,
    }
  }
  const projectId = input.projectId ?? input.context.projectId
  if (!projectId) {
    return {
      ok: false,
      mode: input.mode,
      changed: false,
      error: 'Project binding was requested, but no MatOS project id is available.',
    }
  }
  try {
    const projectCwd = input.context.projectCwd ?? input.context.cwd
    const contextMemberId = input.context.projectMemberId
    if (
      input.mode === 'replace-current' &&
      contextMemberId &&
      input.projectMemberId &&
      input.projectMemberId !== contextMemberId
    ) {
      throw new Error(
        `Refusing to replace project member '${input.projectMemberId}'; the current runtime is bound to '${contextMemberId}'`,
      )
    }
    const currentMemberId =
      contextMemberId ??
      input.projectMemberId ??
      defaultProjectMemberId(input.context.selectedRole)
    const mutation = await bindMatOSWorkbenchCreatedRole({
      cwd: projectCwd,
      assetCwd: input.context.cwd,
      scopeRef: input.context.env?.MATOS_SCOPE_REF ?? input.context.env?.MATOS_SCOPE_ID,
      env: input.context.env,
      projectId,
      roleRef: input.roleRef,
      displayName: input.displayName,
      mode: input.mode,
      assetVersionPolicy: input.assetVersionPolicy,
      ...(input.mode === 'replace-current'
        ? {
            currentMemberId,
            currentRoleRef: input.context.selectedRole,
          }
        : {}),
    })
    const project = mutation.project
    return {
      ok: true,
      mode: input.mode,
      changed: mutation.changed,
      projectId,
      roleRef: input.roleRef,
      added: {
        changed: mutation.changed,
      },
      boundAsset: {
        changed: mutation.changed,
      },
      ...(mutation.removedCurrent
        ? {
            removedCurrent: {
              changed: true,
              memberId: mutation.removedCurrent.memberId,
              roleRef: mutation.removedCurrent.roleRef,
            },
          }
        : {}),
      project: {
        id: project.project.id,
        name: project.project.name,
        roleRefs: project.members.flatMap(member => member.roleRef ? [member.roleRef] : []),
        assetRefs: project.assetRefs,
      },
    }
  } catch (error) {
    return {
      ok: false,
      mode: input.mode,
      changed: false,
      projectId,
      roleRef: input.roleRef,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function completeRoleCreation(input: {
  context: MatOSRoleBuilderToolContext
  raw: Record<string, unknown>
  result: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const mode = projectBindingMode(input.raw.projectBinding, input.context)
  const roleRef = optionalString(input.result.roleRef)
  if (input.result.ok !== true || !roleRef) {
    return input.result
  }
  const projectBinding = await bindCreatedRoleToProject({
    context: input.context,
    mode,
    projectId: optionalString(input.raw.projectId),
    projectMemberId: optionalString(input.raw.projectMemberId),
    displayName: optionalString(input.raw.projectRoleName) ?? optionalString(input.raw.name),
    roleRef,
    assetVersionPolicy: 'pinned',
  })
  if (projectBinding.ok === true) {
    return {
      ...input.result,
      projectBinding,
    }
  }
  return {
    ...input.result,
    ok: false,
    roleCreationOk: true,
    projectBinding,
    error:
      `Role ${roleRef} was created and validated, but project binding failed: ` +
      `${optionalString(projectBinding.error) ?? 'unknown project binding error'}`,
  }
}

function rolePrompt(input: {
  name: string
  description?: string
  prompt?: string
  targetRef: string
  now: string
}): string {
  if (input.prompt?.trim()) {
    return `${input.prompt.trimEnd()}\n`
  }
  return [
    `# Role: ${input.name}`,
    '',
    input.description ?? `MatOS role asset ${input.targetRef}.`,
    '',
    '## Behavior',
    '',
    'Describe the agent behavior, mounted tools, skills, knowledge, workflows, delegation policy, and verification expectations here.',
    '',
    '## Provenance',
    '',
    `- Asset ref: ${input.targetRef}`,
    `- Created at: ${input.now}`,
    '- Source: MatOS role_edit tool',
    '',
  ].join('\n')
}

function roleManifest(input: {
  id: string
  name: string
  version: string
  description?: string
  mounts: MatOSAssetMounts
  dependencies?: string[]
  tags?: string[]
  aliases?: string[]
  model?: string
  permissionMode?: string
  overlayOf?: string
  now: string
  metadata?: Record<string, unknown>
}): Record<string, unknown> {
  const dependencies = [...new Set([
    ...(input.dependencies ?? []),
    ...mountRefs(input.mounts),
  ])].sort()
  return {
    schemaVersion: 1,
    id: input.id,
    type: 'role',
    name: input.name,
    version: input.version,
    ...(input.description ? { description: input.description } : {}),
    entry: 'ROLE.md',
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(Object.keys(input.mounts).length ? { mounts: input.mounts } : {}),
    runtime: {
      ...(input.model ? { model: input.model } : {}),
      permissionMode: input.permissionMode ?? 'bypassPermissions',
    },
    lifecycle: {
      status: 'enabled',
      origin: 'matos-role-builder',
      updatedAt: input.now,
    },
    metadata: {
      sourceFormat: 'matos-role-builder',
      updatedAt: input.now,
      updatedBy: 'matos-role-edit',
      ...(input.aliases?.length ? { aliases: input.aliases } : {}),
      ...(input.overlayOf ? { overlayOf: input.overlayOf } : {}),
      ...(input.metadata ?? {}),
    },
  }
}

async function readRolePrompt(asset: MatOSAsset): Promise<string | undefined> {
  if (!asset.entryAbsolutePath) {
    return undefined
  }
  try {
    return await readFile(asset.entryAbsolutePath, 'utf8')
  } catch {
    return undefined
  }
}

function roleInputPlan(raw: Record<string, unknown>, existing?: MatOSAsset): {
  id: string
  version: string
  targetRef: string
  name: string
  description?: string
  prompt?: string
  model?: string
  permissionMode?: string
  tags: string[]
  aliases: string[]
  overlayOf?: string
  replaceMounts: MatOSAssetMounts
  addMounts: MatOSAssetMounts
  removeMounts: MatOSAssetMounts
  dependencies: string[]
} {
  const id = slugSegment(
    optionalString(raw.id) ??
      optionalString(raw.roleId) ??
      optionalString(raw.role_id) ??
      optionalString(raw.ref) ??
      optionalString(raw.roleRef) ??
      existing?.id,
    'agent-role',
  )
  const version =
    optionalString(raw.version) ??
    existing?.version ??
    DEFAULT_VERSION
  const targetRef = roleRefForId(id, version)
  const name =
    optionalString(raw.name) ??
    optionalString(raw.displayName) ??
    optionalString(raw.display_name) ??
    existing?.name ??
    id
  return {
    id,
    version,
    targetRef,
    name,
    description:
      optionalString(raw.description) ??
      existing?.description,
    prompt:
      optionalString(raw.prompt) ??
      optionalString(metadataObject(raw.prompt_info).prompt),
    model:
      optionalString(raw.model) ??
      optionalString(raw.model_id) ??
      optionalString(metadataObject(raw.model_info).model_id) ??
      optionalString(existing?.runtime.model),
    permissionMode:
      optionalString(raw.permissionMode) ??
      optionalString(raw.permission_mode) ??
      optionalString(existing?.runtime.permissionMode),
    tags: stringArray(raw.tags).length ? stringArray(raw.tags) : existing?.tags ?? [],
    aliases:
      stringArray(raw.aliases).length
        ? stringArray(raw.aliases)
        : stringArray(existing?.metadata.aliases),
    overlayOf:
      optionalString(raw.overlayOf) ??
      optionalString(raw.overlay_of) ??
      optionalString(existing?.metadata.overlayOf),
    replaceMounts: mountsFromInput(raw),
    addMounts: normalizeMounts(raw.addMounts ?? raw.add_mounts),
    removeMounts: normalizeMounts(raw.removeMounts ?? raw.remove_mounts),
    dependencies: stringArray(raw.dependencies),
  }
}

function roleBuilderPlan(input: {
  cwd: string
  scoped?: { scope: ScopedRoleScope; scopeRef: string }
  raw: Record<string, unknown>
  existing?: MatOSAsset
  registry?: MatOSAssetRegistry
}): Record<string, unknown> {
  const plan = roleInputPlan(input.raw, input.existing)
  const rawMounts = mergeMounts(
    input.existing?.mounts ?? {},
    plan.replaceMounts,
    plan.addMounts,
    plan.removeMounts,
  )
  const mounts = input.registry
    ? canonicalizeMounts(input.registry, rawMounts)
    : rawMounts
  const dependencies = input.registry
    ? canonicalizeRefList(input.registry, plan.dependencies)
    : plan.dependencies
  const allowedTools = input.registry
    ? [
        ...defaultRoleBuilderRuntimeToolNames(),
        ...mountRefs(mounts)
          .map(ref => input.registry?.resolve(ref))
          .filter((asset): asset is MatOSAsset => Boolean(asset))
          .flatMap(asset => runtimeToolNamesForAsset(input.registry as MatOSAssetRegistry, asset)),
      ]
    : []
  const promptTools = input.registry
    ? promptToolReferenceReport({
        registry: input.registry,
        prompt: plan.prompt,
        allowedTools,
        selectedAssets: mountRefs(mounts)
          .map(ref => input.registry?.resolve(ref))
          .filter((asset): asset is MatOSAsset => Boolean(asset)),
      })
    : undefined
  const target = input.scoped
    ? {
        mode: 'scoped-gitea',
        scope: input.scoped.scope,
        scopeRef: input.scoped.scopeRef,
        generatedDir: generatedScopedRoleDir({
          cwd: input.cwd,
          scope: input.scoped.scope,
          scopeRef: input.scoped.scopeRef,
          roleId: plan.id,
        }),
      }
    : {
        mode: 'project-local',
      }
  return {
    operation: input.existing ? 'role-update' : 'role-create',
    target,
    proposedRole: {
      id: plan.id,
      version: plan.version,
      ref: plan.targetRef,
      name: plan.name,
      description: plan.description,
      mounts,
      dependencies,
      tags: plan.tags,
      aliases: plan.aliases,
      overlayOf: plan.overlayOf,
    },
    mountDiff: mountDiff({
      before: input.existing?.mounts ?? {},
      after: mounts,
      replaced: plan.replaceMounts,
    }),
    promptTools,
    nextAction: nextRoleActions(plan.targetRef),
  }
}

async function roleReferenceGate(input: {
  cwd: string
  plan: ReturnType<typeof roleInputPlan>
  mounts: MatOSAssetMounts
  existing?: MatOSAsset
  registry?: MatOSAssetRegistry
}): Promise<{
  ok: boolean
  missingRefs: string[]
  mounts: MatOSAssetMounts
  dependencies: string[]
  targetConflict?: {
    ref: string
    manifestPath: string
    source: string
  }
  error?: string
}> {
  const registry = input.registry ?? buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
    includeDisabled: true,
  })
  const mounts = canonicalizeMounts(registry, input.mounts)
  const dependencies = canonicalizeRefList(registry, input.plan.dependencies)
  if (
    input.existing &&
    (input.plan.id !== input.existing.id ||
      input.plan.version !== (input.existing.version ?? DEFAULT_VERSION))
  ) {
    return {
      ok: false,
      missingRefs: [],
      mounts,
      dependencies,
      error:
        `Refusing to update ${input.existing.canonicalKey} as ${input.plan.targetRef}; role_edit update cannot change role id/version.`,
    }
  }
  const target = registry.resolve(input.plan.targetRef)
  if (!input.existing && target && input.plan.overlayOf !== target.canonicalKey) {
    return {
      ok: false,
      missingRefs: [],
      mounts,
      dependencies,
      targetConflict: {
        ref: target.canonicalKey,
        manifestPath: target.manifestPath,
        source: target.source,
      },
      error:
        `Role target already exists: ${target.canonicalKey}. Use action=update or set overlayOf explicitly when intentionally shadowing.`,
    }
  }
  const missingRefs = [
    ...new Set([...input.plan.dependencies, ...mountRefs(input.mounts)]),
  ].filter(ref => !registry.resolve(ref))
  return {
    ok: missingRefs.length === 0,
    missingRefs,
    mounts,
    dependencies,
    ...(missingRefs.length > 0
      ? { error: `Role references are not resolvable: ${missingRefs.join(', ')}` }
      : {}),
  }
}

async function writeScopedRole(input: {
  cwd: string
  scoped: { scope: ScopedRoleScope; scopeRef: string }
  raw: Record<string, unknown>
  existing?: MatOSAsset
  reason?: string
}): Promise<Record<string, unknown>> {
  const plan = roleInputPlan(input.raw, input.existing)
  if (!ROLE_ID_PATTERN.test(plan.id)) {
    return {
      ok: false,
      error: 'Role id must be lowercase alphanumeric/hyphen, max 64 chars, starting with a letter or digit.',
      id: plan.id,
    }
  }
  if (
    input.existing &&
    !isScopedGiteaRole(input.existing, input.scoped)
  ) {
    return {
      ok: false,
      error:
        `Refusing to update ${input.existing.canonicalKey} through scoped role_edit because it is not owned by ${input.scoped.scopeRef}. Create a new role or use direct self-evolution/admin promotion for core/shared roles.`,
      source: input.existing.source,
      sourceScope: roleSourceScope(input.existing),
      sourceScopeRef: roleSourceScopeRef(input.existing),
    }
  }
  const existingPrompt = input.existing ? await readRolePrompt(input.existing) : undefined
  const mounts = mergeMounts(
    input.existing?.mounts ?? {},
    plan.replaceMounts,
    plan.addMounts,
    plan.removeMounts,
  )
  const registryBefore = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
    includeDisabled: true,
  })
  const referenceGate = await roleReferenceGate({
    cwd: input.cwd,
    plan,
    mounts,
    existing: input.existing,
    registry: registryBefore,
  })
  if (!referenceGate.ok) {
    return {
      ...referenceGate,
      ok: false,
      action: input.existing ? 'update' : 'create',
      roleRef: plan.targetRef,
    }
  }
  const now = new Date().toISOString()
  const generatedDir = generatedScopedRoleDir({
    cwd: input.cwd,
    scope: input.scoped.scope,
    scopeRef: input.scoped.scopeRef,
    roleId: plan.id,
  })
  await rm(generatedDir, { recursive: true, force: true })
  await mkdir(generatedDir, { recursive: true })
  await writeFile(
    join(generatedDir, 'asset.json'),
    `${JSON.stringify(roleManifest({
      id: plan.id,
      name: plan.name,
      version: plan.version,
      ...(plan.description ? { description: plan.description } : {}),
      mounts: referenceGate.mounts,
      dependencies: referenceGate.dependencies,
      tags: plan.tags,
      aliases: plan.aliases,
      ...(plan.model ? { model: plan.model } : {}),
      permissionMode: plan.permissionMode,
      ...(plan.overlayOf ? { overlayOf: plan.overlayOf } : {}),
      now,
    }), null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(generatedDir, 'ROLE.md'),
    rolePrompt({
      name: plan.name,
      description: plan.description,
      prompt: plan.prompt ?? existingPrompt,
      targetRef: plan.targetRef,
      now,
    }),
    'utf8',
  )
  const runId = `role-builder-${plan.id}-${Date.now()}`
  const gitea = await syncGeneratedScopedAssetsToGitea({
    cwd: input.cwd,
    scope: input.scoped.scope,
    scopeRef: input.scoped.scopeRef,
    runId,
    summary:
      input.reason ??
      `${input.existing ? 'Update' : 'Create'} role ${plan.targetRef}`,
    env: process.env,
    parkRuntimeAssetsAsDraft: false,
    generatedAssetDirs: [generatedDir],
  })
  if (!gitea.ok) {
    return {
      ok: false,
      action: input.existing ? 'update' : 'create',
      roleRef: plan.targetRef,
      generatedDir,
      gitea,
      error:
        gitea.sourceCommitErrors?.map(error => `${error.sourceId}: ${error.error}`).join('; ') ||
        gitea.skippedAssets.map(asset => asset.reason).join('; ') ||
        'Scoped Gitea role sync failed.',
    }
  }
  const assets = await loadMatOSAssets(input.cwd)
  const validation = await validateMatOSAssets(assets)
  const registry = buildMatOSAssetRegistry(assets, { includeDisabled: true })
  const resolved = registry.resolve(plan.targetRef)
  const smoke = resolved
    ? await smokeRole({ cwd: input.cwd, ref: resolved.canonicalKey, registry })
    : undefined
  return {
    ok: Boolean(resolved) && validation.ok && (smoke?.ok !== false),
    action: input.existing ? 'update' : 'create',
    roleRef: resolved?.canonicalKey ?? plan.targetRef,
    generatedDir,
    gitea,
    validation,
    smoke,
    ...(resolved?.lifecycle.status === 'draft'
      ? { activationRequired: true }
      : {}),
    nextAction: nextRoleActions(
      resolved?.canonicalKey ?? plan.targetRef,
      resolved?.lifecycle.status,
    ),
    ...(resolved
      ? {
          role: {
            id: resolved.id,
            ref: resolved.canonicalKey,
            name: resolved.name,
            description: resolved.description,
            mounts: resolved.mounts,
            mountDiff: mountDiff({
              before: input.existing?.mounts ?? {},
              after: resolved.mounts,
              replaced: plan.replaceMounts,
            }),
            source: resolved.source,
            sourceScope: roleSourceScope(resolved),
            sourceScopeRef: roleSourceScopeRef(resolved),
            lifecycle: resolved.lifecycle,
          },
        }
      : {}),
  }
}

async function applyProjectLocalRoleEdit(input: {
  cwd: string
  raw: Record<string, unknown>
  existing?: MatOSAsset
  reason?: string
}): Promise<Record<string, unknown>> {
  const plan = roleInputPlan(input.raw, input.existing)
  if (!input.existing) {
    const nextMounts = mergeMounts({}, plan.replaceMounts, plan.addMounts, plan.removeMounts)
    const registryBefore = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
      includeDisabled: true,
    })
    const referenceGate = await roleReferenceGate({
      cwd: input.cwd,
      plan,
      mounts: nextMounts,
      existing: input.existing,
      registry: registryBefore,
    })
    if (!referenceGate.ok) {
      return {
        ...referenceGate,
        ok: false,
        action: 'create',
        roleRef: plan.targetRef,
      }
    }
    const preview = await previewMatOSWorkbenchAssetCreate({
      cwd: input.cwd,
      type: 'role',
      id: plan.id,
      name: plan.name,
      description: plan.description,
      version: plan.version,
    })
    const created = await applyMatOSWorkbenchAssetCreate({
      cwd: input.cwd,
      type: 'role',
      id: plan.id,
      name: plan.name,
      description: plan.description,
      version: plan.version,
      fingerprint: preview.transaction.confirmationFingerprint,
      reason: input.reason,
    })
    if (!created.applied || (!plan.prompt && mountRefs(nextMounts).length === 0)) {
      return created as unknown as Record<string, unknown>
    }
    const roleRef = created.targetRef
    const draftRequest = {
      name: plan.name,
      description: plan.description,
      prompt_info: { prompt: plan.prompt },
      model_info: {
        model_id: plan.model,
        parameters: { permissionMode: plan.permissionMode },
      },
      mounts: referenceGate.mounts,
    }
    const draft = await previewMatOSWorkbenchRoleDraft({
      cwd: input.cwd,
      ref: roleRef,
      mutation: 'update',
      request: draftRequest,
    })
    if (draft.summary.changedFieldCount <= 0) {
      return created as unknown as Record<string, unknown>
    }
    const applied = await applyMatOSWorkbenchRoleDraft({
      cwd: input.cwd,
      ref: roleRef,
      mutation: 'update',
      request: draftRequest,
      fingerprint: draft.transaction.confirmationFingerprint,
      reason: input.reason,
    })
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
    const resolved = registry.resolve(roleRef)
    const smoke = resolved
      ? await smokeRole({ cwd: input.cwd, ref: resolved.canonicalKey, registry })
      : undefined
    return {
      ok: applied.applied && (smoke?.ok !== false),
      action: 'create',
      created,
      roleDraft: applied,
      roleRef: resolved?.canonicalKey ?? roleRef,
      smoke,
      nextAction: nextRoleActions(resolved?.canonicalKey ?? roleRef),
    }
  }
  const nextMounts = mergeMounts(input.existing.mounts, plan.replaceMounts, plan.addMounts, plan.removeMounts)
  const registryBefore = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd), {
    includeDisabled: true,
  })
  const referenceGate = await roleReferenceGate({
    cwd: input.cwd,
    plan,
    mounts: nextMounts,
    existing: input.existing,
    registry: registryBefore,
  })
  if (!referenceGate.ok) {
    return {
      ...referenceGate,
      ok: false,
      action: 'update',
      roleRef: input.existing.canonicalKey,
    }
  }
  const draftRequest = {
    name: plan.name,
    description: plan.description,
    prompt_info: { prompt: plan.prompt },
    model_info: {
      model_id: plan.model,
      parameters: { permissionMode: plan.permissionMode },
    },
    mounts: referenceGate.mounts,
  }
  const draft = await previewMatOSWorkbenchRoleDraft({
    cwd: input.cwd,
    ref: input.existing.canonicalKey,
    mutation: 'update',
    request: draftRequest,
  })
  const applied = await applyMatOSWorkbenchRoleDraft({
    cwd: input.cwd,
    ref: input.existing.canonicalKey,
    mutation: 'update',
    request: draftRequest,
    fingerprint: draft.transaction.confirmationFingerprint,
    reason: input.reason,
  })
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const resolved = registry.resolve(input.existing.canonicalKey)
  const smoke = resolved
    ? await smokeRole({ cwd: input.cwd, ref: resolved.canonicalKey, registry })
    : undefined
  return {
    ok: applied.applied && (smoke?.ok !== false),
    action: 'update',
    roleRef: resolved?.canonicalKey ?? input.existing.canonicalKey,
    roleDraft: applied,
    smoke,
    nextAction: nextRoleActions(resolved?.canonicalKey ?? input.existing.canonicalKey),
  }
}

function roleEditMountPatch(raw: Record<string, unknown>): MatOSAssetMounts {
  const assetRef = optionalString(raw.assetRef) ??
    optionalString(raw.asset_ref) ??
    optionalString(raw.resourceRef) ??
    optionalString(raw.resource_ref)
  if (!assetRef) {
    return {}
  }
  const group = groupFromValue(raw.group ?? raw.mountGroup ?? raw.mount_group) ?? mountGroupForRef(assetRef)
  if (!group) {
    return {}
  }
  return { [group]: [assetRef] }
}

function roleEditAction(value: unknown): RoleEditAction {
  const action = optionalString(value)
  return action === 'update' ||
    action === 'attach' ||
    action === 'detach' ||
    action === 'smoke' ||
    action === 'bind-project'
    ? action
    : 'create'
}

function roleQueryAction(value: unknown): RoleBuilderAction {
  const action = optionalString(value)
  return action === 'show' ||
    action === 'compose' ||
    action === 'preview_create' ||
    action === 'preview_update' ||
    action === 'list'
    ? action
    : 'context'
}

function matosEntrypointPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'entrypoints',
    'matos.ts',
  )
}

export function buildDelegatedRoleEnv(
  parentEnv: NodeJS.ProcessEnv,
  delegationSessionId: string,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...parentEnv,
    MATOS_SESSION_ID: delegationSessionId,
    MATOS_CHAT_SESSION_ID: delegationSessionId,
    MATOS_PARENT_SESSION_ID:
      parentEnv.MATOS_SESSION_ID ??
      parentEnv.MATOS_PARENT_SESSION_ID ??
      parentEnv.MATOS_TRACE_ID ??
      '',
    MATOS_INHERIT_PARENT_RUN_TRACE: '1',
    MATOS_RUN_STREAM_STDOUT: '0',
    MATOS_RUN_STREAM_TOOL_EVENTS: '0',
    ...(parentEnv.MATOS_PROJECT_MEMBER_ID
      ? { MATOS_PARENT_PROJECT_MEMBER_ID: parentEnv.MATOS_PROJECT_MEMBER_ID }
      : {}),
  }
  // A delegation is a fresh role session on the same trace. Resume pointers
  // and the caller's member identity would mix role memory or private roots.
  delete childEnv.MATOS_PROJECT_MEMBER_ID
  delete childEnv.MATOS_UPSTREAM_SESSION_ID
  delete childEnv.MATOS_RESUME_COMMAND
  delete childEnv.MATOS_TURN_ID
  return childEnv
}

export function resolveDelegableRoleReference(input: {
  registry: MatOSAssetRegistry
  selectedRole?: string
  requestedRole: string
}): string | undefined {
  const selected = input.selectedRole
    ? input.registry.resolve(input.selectedRole)
    : undefined
  if (!selected || selected.type !== 'role') {
    return undefined
  }
  const requested = input.registry.resolve(
    input.requestedRole.includes(':')
      ? input.requestedRole
      : `role:${input.requestedRole}`,
  )
  if (!requested || requested.type !== 'role') {
    return undefined
  }
  for (const reference of selected.mounts.roles ?? []) {
    const mounted = input.registry.resolve(reference)
    if (mounted?.canonicalKey === requested.canonicalKey) {
      return requested.canonicalKey
    }
  }
  return undefined
}

async function runDelegatedRole(input: {
  cwd: string
  selectedRole?: string
  requestedRole: string
  task: string
  maxTurns?: number
  timeoutMs?: number
}): Promise<Record<string, unknown>> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const roleRef = resolveDelegableRoleReference({
    registry,
    selectedRole: input.selectedRole,
    requestedRole: input.requestedRole,
  })
  if (!roleRef) {
    return {
      ok: false,
      error: `Role is not an explicit delegation target of ${input.selectedRole ?? 'the active role'}: ${input.requestedRole}`,
    }
  }
  const args = [
    matosEntrypointPath(),
    'run',
    '--role',
    roleRef,
    input.task,
    ...(input.maxTurns ? ['--max-turns', String(input.maxTurns)] : []),
  ]
  const timeoutMs = Math.max(
    1_000,
    Math.min(input.timeoutMs ?? 30 * 60 * 1000, 24 * 60 * 60 * 1000),
  )
  const delegationSessionId = `role-delegation-${randomUUID()}`
  const childEnv = buildDelegatedRoleEnv(process.env, delegationSessionId)
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, args, {
      cwd: input.cwd,
      detached: true,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let forceFinishTimer: ReturnType<typeof setTimeout> | undefined
    const append = (current: string, chunk: string): string =>
      `${current}${chunk}`.slice(-128_000)
    const finish = (result: Record<string, unknown>): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (forceFinishTimer) clearTimeout(forceFinishTimer)
      resolveResult(result)
    }
    const signalProcessTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // The delegated process may have exited between checks.
        }
      }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      signalProcessTree('SIGTERM')
      killTimer = setTimeout(() => {
        signalProcessTree('SIGKILL')
        forceFinishTimer = setTimeout(() => {
          finish({
            ok: false,
            roleRef,
            sessionId: delegationSessionId,
            exitCode: 124,
            result: scrubSecretsFromString(stdout.trim()),
            ...(stderr.trim()
              ? { stderr: scrubSecretsFromString(stderr.trim().slice(-8_000)) }
              : {}),
            error: `Delegated role timed out after ${timeoutMs}ms.`,
          })
        }, 1_000)
        forceFinishTimer.unref?.()
      }, 5_000)
      killTimer.unref?.()
    }, timeoutMs)
    timeout.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout = append(stdout, String(chunk))
    })
    child.stderr.on('data', chunk => {
      stderr = append(stderr, String(chunk))
    })
    child.on('error', error => {
      finish({
        ok: false,
        roleRef,
        sessionId: delegationSessionId,
        error: scrubSecretsFromString(error.message),
      })
    })
    child.on('close', code => {
      const exitCode = timedOut ? 124 : code ?? 1
      finish({
        ok: exitCode === 0,
        roleRef,
        sessionId: delegationSessionId,
        exitCode,
        result: scrubSecretsFromString(stdout.trim()),
        ...(stderr.trim()
          ? { stderr: scrubSecretsFromString(stderr.trim().slice(-8_000)) }
          : {}),
        ...(timedOut ? { error: `Delegated role timed out after ${timeoutMs}ms.` } : {}),
      })
    })
  })
}

export function createMatOSRoleBuilderTools(
  context: MatOSRoleBuilderToolContext,
): MatOSRoleBuilderTool[] {
  return [
    {
      name: 'role_query',
      description:
        'Inspect MatOS roles and preview agent-buildable role changes. Use before role_edit when selecting mounts or verifying an existing role.',
      inputSchema: textSchema({
        action: {
          type: 'string',
          enum: ['context', 'list', 'show', 'compose', 'preview_create', 'preview_update'],
          description: 'Role query operation. Defaults to context.',
        },
        ref: { type: 'string', description: 'Role ref for show/compose/preview_update.' },
        query: { type: 'string', description: 'Role or mount search query. For action=compose without ref, returns mount candidates.' },
        group: { type: 'string', description: 'Optional mount group filter for candidate discovery, such as tools, mcp, skills, knowledge, workflows, or roles.' },
        types: { type: 'array', description: 'Optional asset type filters for candidate discovery, such as tool, mcp, skill, knowledge, workflow, or role.' },
        limit: { type: 'number', description: 'List limit.' },
        offset: { type: 'number', description: 'List offset.' },
        scopeRef: { type: 'string', description: 'Optional scope ref such as user:alice.' },
        id: { type: 'string', description: 'Role id for preview_create.' },
        name: { type: 'string', description: 'Role name for preview_create/update.' },
        description: { type: 'string', description: 'Role description.' },
        prompt: { type: 'string', description: 'Role prompt/instructions.' },
        mounts: { type: 'object', description: 'Mount groups such as skills/tools/knowledge/workflows/roles.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const action = roleQueryAction(raw.action)
          if (action === 'context') {
            return jsonResult({
              ok: true,
              cwd: context.cwd,
              projectCwd: context.projectCwd ?? context.cwd,
              selectedRole: context.selectedRole,
              selectedAssetKeys: context.selectedAssetKeys ?? [],
              scopeRef: requestScopeRef(raw),
              roleTools: [...MATOS_ROLE_BUILDER_TOOL_NAMES],
              actions: ['context', 'list', 'show', 'compose', 'preview_create', 'preview_update'],
              editActions: ['create', 'update', 'attach', 'detach', 'bind-project'],
              guidance: [
                'Create new user/team/project roles with role_edit action=create and a semantic id.',
                'Use mounts/addMounts/removeMounts to expose tools, skills, knowledge, workflows, MCP, plugins, data, or delegated roles.',
                'Discover mount candidates with role_query action=compose query=<text>; returned refs are canonical and versioned.',
                'Scoped Gitea accepted refs are the default runtime authority when scopeRef is user/team/project.',
                'In project chat, role_edit action=create defaults to adding the new role to the project. Use projectBinding=replace-current when the new durable agent should replace the current Compute member.',
                'Do not override core roles unless overlayOf is explicitly intended and reviewed.',
              ],
            })
          }
          if (action === 'list') {
            return jsonResult(
              await listMatOSWorkbenchRoles({
                cwd: context.cwd,
                query: optionalString(raw.query),
                limit: optionalInteger(raw.limit, 50),
                offset: optionalInteger(raw.offset, 0),
                lightweight: optionalBoolean(raw.lightweight) ?? true,
              }) as Record<string, unknown>,
            )
          }
          if (action === 'show' || action === 'compose') {
            const ref = optionalString(raw.ref) ?? optionalString(raw.roleRef)
            const query = optionalString(raw.query)
            const registry = buildMatOSAssetRegistry(await loadMatOSAssets(context.cwd))
            if (!ref && action === 'compose' && query) {
              return jsonResult({
                ok: true,
                action: 'compose',
                mode: 'mount-candidate-discovery',
                mounts: queryMountCandidates({
                  registry,
                  query,
                  group: groupFromValue(raw.group),
                  types: stringArray(raw.types),
                  limit: optionalInteger(raw.limit, 50),
                  offset: optionalInteger(raw.offset, 0),
                  selectedAssetKeys: context.selectedAssetKeys,
                }),
                guidance: [
                  'Use candidates[].ref in mounts/addMounts; refs are canonical and versioned.',
                  'Use group to choose the role mount bucket.',
                  'After create/update, run role_edit action=smoke ref=<role-ref> if you need deterministic validation.',
                ],
              })
            }
            if (!ref) {
              return errorResult(`role_query action=${action} requires ref`)
            }
            const shown = await showMatOSWorkbenchRole({
              cwd: context.cwd,
              ref,
              includeComposition: action === 'compose' || optionalBoolean(raw.includeComposition) === true,
              includeInactive: action === 'show',
            }) as Record<string, unknown>
            if (query) {
              shown.mounts = queryMountCandidates({
                registry,
                query,
                group: groupFromValue(raw.group),
                types: stringArray(raw.types),
                limit: optionalInteger(raw.limit, 50),
                offset: optionalInteger(raw.offset, 0),
                selectedAssetKeys: context.selectedAssetKeys,
              })
            }
            return jsonResult(shown)
          }
          const scoped = scopeFromRef(requestScopeRef(raw))
          const registry = buildMatOSAssetRegistry(await loadMatOSAssets(context.cwd), {
            includeDisabled: true,
          })
          const existing = optionalString(raw.ref) ?? optionalString(raw.roleRef)
            ? registry.resolve(optionalString(raw.ref) ?? optionalString(raw.roleRef) ?? '')
            : undefined
          return jsonResult({
            ok: true,
            mode: 'role-builder-preview',
            action,
            plan: roleBuilderPlan({
              cwd: context.cwd,
              scoped,
              raw,
              existing: existing?.type === 'role' ? existing : undefined,
              registry,
            }),
          })
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'role_edit',
      description:
        'Create or revise a MatOS role using native asset governance. Defaults to scoped Gitea accepted-ref writes when scopeRef is user/team/project; supports update, attach, and detach.',
      inputSchema: textSchema({
        action: {
          type: 'string',
          enum: ['create', 'update', 'attach', 'detach', 'smoke', 'bind-project'],
          description: 'Role edit operation. Defaults to create.',
        },
        dryRun: { type: 'boolean', description: 'Preview only; do not write.' },
        target: {
          type: 'string',
          enum: ['scoped-gitea', 'project-local'],
          description: 'Write target. Defaults to scoped-gitea when scopeRef is available.',
        },
        scopeRef: { type: 'string', description: 'Scope ref such as user:alice, team:lab, or project:demo.' },
        ref: { type: 'string', description: 'Existing role ref for update/attach/detach.' },
        id: { type: 'string', description: 'New role id for create.' },
        name: { type: 'string', description: 'Role display name.' },
        description: { type: 'string', description: 'Role description.' },
        prompt: { type: 'string', description: 'Role system instructions written to ROLE.md.' },
        model: { type: 'string', description: 'Optional model id.' },
        permissionMode: { type: 'string', description: 'Optional permission mode.' },
        mounts: { type: 'object', description: 'Mount group replacement map.' },
        addMounts: { type: 'object', description: 'Mount group refs to add.' },
        removeMounts: { type: 'object', description: 'Mount group refs to remove.' },
        assetRef: { type: 'string', description: 'Asset ref for attach/detach.' },
        group: { type: 'string', description: 'Mount group for attach/detach.' },
        overlayOf: { type: 'string', description: 'Explicit canonical role ref this role overlays, when intentionally shadowing.' },
        projectBinding: {
          type: 'string',
          enum: ['none', 'add', 'replace-current'],
          description:
            'Project roster action after a successful create. Defaults to add in project chat and none outside a project. replace-current adds the new role and removes the current project agent member.',
        },
        projectId: { type: 'string', description: 'Optional project id override for projectBinding.' },
        projectMemberId: { type: 'string', description: 'Optional current member id override for projectBinding=replace-current.' },
        projectRoleName: { type: 'string', description: 'Optional display name for the new project role member.' },
        reason: { type: 'string', description: 'Audit reason.' },
      }),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const action = roleEditAction(raw.action)
          const reason = optionalString(raw.reason)
          const scoped = scopeFromRef(requestScopeRef(raw))
          const target = optionalString(raw.target) ?? (scoped ? 'scoped-gitea' : 'project-local')
          const registry = buildMatOSAssetRegistry(await loadMatOSAssets(context.cwd), {
            includeDisabled: true,
          })
          const existingRef = optionalString(raw.ref) ?? optionalString(raw.roleRef)
          const existing = existingRef ? registry.resolve(existingRef) : undefined
          if (action === 'smoke') {
            const ref = existingRef ?? optionalString(raw.id) ?? optionalString(raw.role_id)
            if (!ref) {
              return errorResult('role_edit action=smoke requires ref')
            }
            return jsonResult(await smokeRole({
              cwd: context.cwd,
              ref,
              registry,
            }))
          }
          if (existingRef && (!existing || existing.type !== 'role')) {
            return errorResult(`MatOS role asset not found: ${existingRef}`)
          }
          if (action === 'bind-project') {
            if (!existing || existing.type !== 'role') {
              return errorResult('role_edit action=bind-project requires an existing Role ref')
            }
            const mode = projectBindingMode(raw.projectBinding, context)
            if (optionalBoolean(raw.dryRun) === true) {
              return jsonResult({
                ok: true,
                dryRun: true,
                action,
                roleRef: existing.canonicalKey,
                projectBinding: {
                  mode,
                  projectId: optionalString(raw.projectId) ?? context.projectId,
                },
              })
            }
            const projectBinding = await bindCreatedRoleToProject({
              context,
              mode,
              projectId: optionalString(raw.projectId),
              projectMemberId: optionalString(raw.projectMemberId),
              displayName:
                optionalString(raw.projectRoleName) ?? optionalString(raw.name),
              roleRef: existing.canonicalKey,
            })
            return jsonResult({
              ok: projectBinding.ok === true,
              action,
              roleRef: existing.canonicalKey,
              projectBinding,
              ...(projectBinding.ok === true
                ? {}
                : {
                    error:
                      optionalString(projectBinding.error) ??
                      'Project Role binding failed',
                  }),
            })
          }
          const effectiveRaw = { ...raw }
          if (action === 'attach') {
            if (!optionalString(raw.assetRef) && !optionalString(raw.asset_ref) && !optionalString(raw.resourceRef) && !optionalString(raw.resource_ref)) {
              return errorResult('role_edit action=attach requires assetRef')
            }
            effectiveRaw.addMounts = mergeMounts(
              normalizeMounts(effectiveRaw.addMounts),
              {},
              roleEditMountPatch(raw),
              {},
            )
          } else if (action === 'detach') {
            if (!optionalString(raw.assetRef) && !optionalString(raw.asset_ref) && !optionalString(raw.resourceRef) && !optionalString(raw.resource_ref)) {
              return errorResult('role_edit action=detach requires assetRef')
            }
            effectiveRaw.removeMounts = mergeMounts(
              normalizeMounts(effectiveRaw.removeMounts),
              {},
              roleEditMountPatch(raw),
              {},
            )
          }
          if (optionalBoolean(raw.dryRun) === true) {
            return jsonResult({
              ok: true,
              dryRun: true,
              action,
              target,
              projectBinding:
                action === 'create'
                  ? {
                      mode: projectBindingMode(raw.projectBinding, context),
                      projectId: optionalString(raw.projectId) ?? context.projectId,
                    }
                  : { mode: 'none' },
              plan: roleBuilderPlan({
                cwd: context.cwd,
                scoped: target === 'scoped-gitea' ? scoped : undefined,
                raw: effectiveRaw,
                existing: existing?.type === 'role' ? existing : undefined,
                registry,
              }),
            })
          }
          if (target === 'project-local') {
            const result = await applyProjectLocalRoleEdit({
                cwd: context.cwd,
                raw: effectiveRaw,
                existing: existing?.type === 'role' ? existing : undefined,
                reason,
              })
            return jsonResult(
              action === 'create'
                ? await completeRoleCreation({ context, raw, result })
                : result,
            )
          }
          if (!scoped) {
            return errorResult(
              'role_edit target=scoped-gitea requires scopeRef=user:<id>, team:<id>, or project:<id>.',
            )
          }
          const result = await writeScopedRole({
              cwd: context.cwd,
              scoped,
              raw: effectiveRaw,
              existing: existing?.type === 'role' ? existing : undefined,
              reason,
            })
          return jsonResult(
            action === 'create'
              ? await completeRoleCreation({ context, raw, result })
              : result,
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      name: 'role_run',
      description:
        'Delegate a focused task to a role explicitly mounted by the active MatOS role. The delegated run uses the selected MatOS agent engine and preserves trace ancestry.',
      inputSchema: textSchema(
        {
          role: {
            type: 'string',
            description: 'Mounted target role ref or id.',
          },
          task: {
            type: 'string',
            description: 'Focused task for the delegated role.',
          },
          maxTurns: {
            type: 'number',
            description: 'Optional positive turn limit.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Optional execution timeout in milliseconds.',
          },
        },
        ['role', 'task'],
      ),
      async call(input) {
        try {
          const raw = metadataObject(input)
          const role = optionalString(raw.role) ?? optionalString(raw.roleRef)
          const task = optionalString(raw.task) ?? optionalString(raw.prompt)
          if (!role || !task) {
            return errorResult('role_run requires role and task')
          }
          return jsonResult(
            await runDelegatedRole({
              cwd: context.cwd,
              selectedRole: context.selectedRole,
              requestedRole: role,
              task,
              maxTurns:
                typeof raw.maxTurns === 'number' && Number.isFinite(raw.maxTurns) && raw.maxTurns > 0
                  ? Math.floor(raw.maxTurns)
                  : undefined,
              timeoutMs:
                typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
                  ? Math.floor(raw.timeoutMs)
                  : undefined,
            }),
          )
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
      },
    },
  ]
}
