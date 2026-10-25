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

import type { MatOSAssetMountGroup } from '../assets/types.js'
import type { MatOSWorkbenchRoleDraftPreview } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = stringValue(value)
    if (string) {
      return string
    }
  }
  return undefined
}

function recordAt(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

function requestName(request: Record<string, unknown>): string | undefined {
  return firstString(
    request.name,
    request.bot_name,
    recordAt(request, 'bot_info')?.name,
    recordAt(request, 'data')?.name,
  )
}

function requestDescription(request: Record<string, unknown>): string | undefined {
  return firstString(
    request.description,
    request.desc,
    recordAt(request, 'bot_info')?.description,
    recordAt(request, 'bot_info')?.desc,
    recordAt(request, 'data')?.description,
    recordAt(request, 'data')?.desc,
  )
}

function requestPrompt(request: Record<string, unknown>): string | undefined {
  return firstString(
    request.prompt,
    recordAt(request, 'prompt_info')?.prompt,
    recordAt(request, 'bot_info', 'prompt_info')?.prompt,
    recordAt(request, 'data', 'prompt_info')?.prompt,
  )
}

function requestModel(request: Record<string, unknown>): string | undefined {
  return firstString(
    request.model,
    request.model_id,
    recordAt(request, 'model_info')?.model_id,
    recordAt(request, 'bot_info', 'model_info')?.model_id,
  )
}

function requestPermissionMode(request: Record<string, unknown>): string | undefined {
  return firstString(
    request.permissionMode,
    request.permission_mode,
    recordAt(request, 'model_info', 'parameters')?.permissionMode,
    recordAt(request, 'bot_info', 'model_info', 'parameters')?.permissionMode,
  )
}

function refsFromObjects(value: unknown, ...keys: string[]): string[] {
  const refs: string[] = []
  for (const item of asArray(value)) {
    if (!isRecord(item)) {
      const ref = stringValue(item)
      if (ref) {
        refs.push(ref)
      }
      continue
    }
    const ref = firstString(...keys.map(key => item[key]))
    if (ref) {
      refs.push(ref)
    }
  }
  return [...new Set(refs)]
}

const ROLE_MOUNT_GROUP_BY_ALIAS: Record<string, MatOSAssetMountGroup> = {
  knowledge: 'knowledge',
  knowledges: 'knowledge',
  dataset: 'knowledge',
  datasets: 'knowledge',
  data_set: 'knowledge',
  data_sets: 'knowledge',
  data: 'data',
  database: 'data',
  databases: 'data',
  table: 'data',
  tables: 'data',
  benchmark: 'data',
  benchmarks: 'data',
  benchmark_suite: 'data',
  benchmark_suites: 'data',
  evaluation: 'data',
  evaluations: 'data',
  skill: 'skills',
  skills: 'skills',
  tool: 'tools',
  tools: 'tools',
  plugin_tool: 'tools',
  plugin_tools: 'tools',
  mcp: 'mcp',
  mcp_server: 'mcp',
  mcp_servers: 'mcp',
  plugin: 'plugins',
  plugins: 'plugins',
  workflow: 'workflows',
  workflows: 'workflows',
  role: 'roles',
  roles: 'roles',
}

const ROLE_REF_PREFIX_BY_MOUNT_GROUP: Record<MatOSAssetMountGroup, string> = {
  knowledge: 'knowledge',
  data: 'data',
  skills: 'skill',
  tools: 'tool',
  mcp: 'mcp',
  plugins: 'plugin',
  workflows: 'workflow',
  roles: 'role',
}

function roleMountGroupFromValue(value: unknown): MatOSAssetMountGroup | undefined {
  const normalized = stringValue(value)?.replace(/-/g, '_').toLowerCase()
  return normalized ? ROLE_MOUNT_GROUP_BY_ALIAS[normalized] : undefined
}

function roleMountGroupFromRef(ref: string): MatOSAssetMountGroup | undefined {
  const prefix = ref.includes(':') ? ref.split(':', 1)[0] : ''
  return roleMountGroupFromValue(prefix)
}

function roleMountRefForGroup(ref: string, group: MatOSAssetMountGroup): string {
  return ref.includes(':') ? ref : `${ROLE_REF_PREFIX_BY_MOUNT_GROUP[group]}:${ref}`
}

function pushMountRefs(
  mounts: Record<string, string[]>,
  group: MatOSAssetMountGroup,
  refs: string[],
): void {
  const existing = mounts[group] ?? []
  mounts[group] = [...new Set([
    ...existing,
    ...refs.map(ref => roleMountRefForGroup(ref, group)),
  ])]
}

function setMountRefs(
  mounts: Record<string, string[]>,
  group: MatOSAssetMountGroup,
  refs: string[],
): void {
  mounts[group] = [...new Set(refs.map(ref => roleMountRefForGroup(ref, group)))]
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  if (typeof value !== 'string' || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function attachmentRef(item: unknown): string | undefined {
  if (typeof item === 'string') {
    return stringValue(item)
  }
  if (!isRecord(item)) {
    return undefined
  }
  return firstString(
    item.resolvedRef,
    item.resolved_ref,
    item.resourceRef,
    item.resource_ref,
    item.assetRef,
    item.asset_ref,
    item.ref,
    item.id,
    item.plugin_id,
    item.workflow_id,
    item.dataset_id,
    item.data_set_id,
    item.database_id,
    item.table_id,
    item.skill_id,
    item.mcp_id,
    item.mcp_server_id,
    item.role_id,
    item.agent_id,
    item.bot_id,
  )
}

function attachmentGroup(item: unknown, fallbackGroup?: MatOSAssetMountGroup): MatOSAssetMountGroup | undefined {
  if (!isRecord(item)) {
    const ref = attachmentRef(item)
    return ref ? roleMountGroupFromRef(ref) ?? fallbackGroup : fallbackGroup
  }
  return (
    roleMountGroupFromValue(item.group) ??
    roleMountGroupFromValue(item.mountGroup) ??
    roleMountGroupFromValue(item.mount_group) ??
    roleMountGroupFromValue(item.assetType) ??
    roleMountGroupFromValue(item.asset_type) ??
    roleMountGroupFromValue(item.type) ??
    (attachmentRef(item) ? roleMountGroupFromRef(attachmentRef(item) ?? '') : undefined) ??
    fallbackGroup
  )
}

function addAttachmentListMounts(
  mounts: Record<string, string[]>,
  value: unknown,
  fallbackGroup?: MatOSAssetMountGroup,
  options: { explicitEmpty?: boolean } = {},
): void {
  if (!Array.isArray(value) && !(typeof value === 'string' && value.trim())) {
    return
  }
  const items = typeof value === 'string' ? parseJsonArray(value) : asArray(value)
  if (options.explicitEmpty && items.length === 0 && fallbackGroup) {
    setMountRefs(mounts, fallbackGroup, [])
    return
  }
  const grouped = new Map<MatOSAssetMountGroup, string[]>()
  for (const item of items) {
    const ref = attachmentRef(item)
    const group = attachmentGroup(item, fallbackGroup)
    if (!ref || !group) {
      continue
    }
    grouped.set(group, [...(grouped.get(group) ?? []), ref])
  }
  for (const [group, refs] of grouped) {
    if (options.explicitEmpty && fallbackGroup === group) {
      setMountRefs(mounts, group, refs)
    } else {
      pushMountRefs(mounts, group, refs)
    }
  }
}

function addMountRecordMounts(mounts: Record<string, string[]>, value: unknown): void {
  if (!isRecord(value)) {
    return
  }
  for (const [key, rawRefs] of Object.entries(value)) {
    const group = roleMountGroupFromValue(key)
    if (!group) {
      continue
    }
    const refs = refsFromObjects(rawRefs, 'ref', 'resolvedRef', 'resourceRef', 'assetRef', 'id')
    setMountRefs(mounts, group, refs)
  }
}

function buildMountPatch(request: Record<string, unknown>): Record<string, string[]> {
  const mounts: Record<string, string[]> = {}
  const pluginInfoList = request.plugin_info_list ?? recordAt(request, 'bot_info')?.plugin_info_list
  const knowledgeInfoList =
    recordAt(request, 'knowledge')?.knowledge_info ??
    recordAt(request, 'knowledge')?.data_set_infos ??
    recordAt(request, 'bot_info', 'knowledge')?.knowledge_info ??
    recordAt(request, 'bot_info', 'knowledge')?.data_set_infos ??
    recordAt(request, 'data', 'knowledge')?.knowledge_info ??
    recordAt(request, 'data', 'knowledge')?.data_set_infos
  const workflowInfoList = request.workflow_info_list ?? recordAt(request, 'bot_info')?.workflow_info_list
  const databaseList = request.database_list ?? request.data_list ?? recordAt(request, 'bot_info')?.database_list
  const skillInfoList = request.skill_info_list ?? request.skills ?? recordAt(request, 'bot_info')?.skill_info_list
  const mcpInfoList = request.mcp_info_list ?? request.mcp_server_list ?? recordAt(request, 'bot_info')?.mcp_info_list
  const pluginAssetList = request.plugin_asset_list ?? request.plugin_list ?? recordAt(request, 'bot_info')?.plugin_asset_list
  const roleInfoList =
    request.role_info_list ??
    request.agent_info_list ??
    request.delegate_role_info_list ??
    request.delegated_role_info_list ??
    request.delegated_roles ??
    request.roles ??
    recordAt(request, 'bot_info')?.role_info_list ??
    recordAt(request, 'bot_info')?.agent_info_list ??
    recordAt(request, 'bot_info')?.delegate_role_info_list ??
    recordAt(request, 'bot_info')?.delegated_role_info_list ??
    recordAt(request, 'bot_info')?.delegated_roles ??
    recordAt(request, 'data')?.role_info_list ??
    recordAt(request, 'data')?.agent_info_list ??
    recordAt(request, 'data')?.delegate_role_info_list ??
    recordAt(request, 'data')?.delegated_role_info_list ??
    recordAt(request, 'data')?.delegated_roles

  addAttachmentListMounts(mounts, pluginInfoList, 'tools', {
    explicitEmpty: Array.isArray(pluginInfoList),
  })
  addAttachmentListMounts(mounts, knowledgeInfoList, 'knowledge', {
    explicitEmpty: Array.isArray(knowledgeInfoList),
  })
  addAttachmentListMounts(mounts, workflowInfoList, 'workflows', {
    explicitEmpty: Array.isArray(workflowInfoList),
  })
  addAttachmentListMounts(mounts, databaseList, 'data', {
    explicitEmpty: Array.isArray(databaseList),
  })
  addAttachmentListMounts(mounts, skillInfoList, 'skills', {
    explicitEmpty: Array.isArray(skillInfoList),
  })
  addAttachmentListMounts(mounts, mcpInfoList, 'mcp', {
    explicitEmpty: Array.isArray(mcpInfoList),
  })
  addAttachmentListMounts(mounts, pluginAssetList, 'plugins', {
    explicitEmpty: Array.isArray(pluginAssetList),
  })
  addAttachmentListMounts(mounts, roleInfoList, 'roles', {
    explicitEmpty: Array.isArray(roleInfoList),
  })

  addAttachmentListMounts(mounts, request.matos_attachments)
  addAttachmentListMounts(mounts, request.attachments)
  addAttachmentListMounts(mounts, recordAt(request, 'matos')?.attachments)
  addAttachmentListMounts(mounts, recordAt(request, 'bot_ext_info')?.matos_attachments)
  addAttachmentListMounts(mounts, recordAt(request, 'bot_info', 'bot_ext_info')?.matos_attachments)
  addAttachmentListMounts(mounts, recordAt(request, 'data', 'bot_ext_info')?.matos_attachments)
  addMountRecordMounts(mounts, request.mounts)
  addMountRecordMounts(mounts, recordAt(request, 'bot_info')?.mounts)
  addMountRecordMounts(mounts, recordAt(request, 'data')?.mounts)

  return mounts
}

function workflowMountRecordRef(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return firstString(
    value.ref,
    value.workflowRef,
    value.workflow_ref,
    value.assetRef,
    value.asset_ref,
    value.workflow_id,
    value.workflowId,
  )
}

function defaultWorkflowMountActions(): NonNullable<
  MatOSWorkbenchRoleDraftPreview['patch']['workflowMounts']
>[number]['allowedActions'] {
  return ['query', 'run', 'status', 'monitor', 'respond', 'approve', 'deny', 'recover', 'reconcile']
}

function workflowMountFromRef(input: {
  ref: string
  request?: Record<string, unknown>
  existing?: unknown
}): NonNullable<MatOSWorkbenchRoleDraftPreview['patch']['workflowMounts']>[number] {
  const existing = isRecord(input.existing) ? input.existing : {}
  const request = input.request ?? {}
  const allowedActions = Array.isArray(request.allowedActions)
    ? request.allowedActions.filter((action): action is string => typeof action === 'string')
    : Array.isArray(existing.allowedActions)
      ? existing.allowedActions.filter((action): action is string => typeof action === 'string')
      : defaultWorkflowMountActions()
  const invocationPolicy = isRecord(request.invocationPolicy)
    ? request.invocationPolicy
    : isRecord(existing.invocationPolicy)
      ? existing.invocationPolicy
      : {}
  return {
    ref: input.ref,
    ...(firstString(request.acceptedRef, request.accepted_ref, existing.acceptedRef, existing.accepted_ref)
      ? { acceptedRef: firstString(request.acceptedRef, request.accepted_ref, existing.acceptedRef, existing.accepted_ref) }
      : {}),
    ...(firstString(request.pinnedCommit, request.pinned_commit, existing.pinnedCommit, existing.pinned_commit)
      ? { pinnedCommit: firstString(request.pinnedCommit, request.pinned_commit, existing.pinnedCommit, existing.pinned_commit) }
      : {}),
    allowedActions: allowedActions as ReturnType<typeof defaultWorkflowMountActions>,
    invocationPolicy: {
      mode:
        firstString(invocationPolicy.mode) === 'auto' ||
        firstString(invocationPolicy.mode) === 'agent-discoverable'
          ? firstString(invocationPolicy.mode) as 'auto' | 'agent-discoverable'
          : 'explicit',
      ...(typeof invocationPolicy.requireUserApproval === 'boolean'
        ? { requireUserApproval: invocationPolicy.requireUserApproval }
        : {}),
      ...(typeof invocationPolicy.maxConcurrentRuns === 'number' && Number.isFinite(invocationPolicy.maxConcurrentRuns)
        ? { maxConcurrentRuns: invocationPolicy.maxConcurrentRuns }
        : {}),
    },
    ...(firstString(request.attachedBy, request.attached_by, existing.attachedBy, existing.attached_by)
      ? { attachedBy: firstString(request.attachedBy, request.attached_by, existing.attachedBy, existing.attached_by) }
      : {}),
    ...(firstString(request.attachedAt, request.attached_at, existing.attachedAt, existing.attached_at)
      ? { attachedAt: firstString(request.attachedAt, request.attached_at, existing.attachedAt, existing.attached_at) }
      : {}),
    ...(firstString(request.reason, existing.reason) ? { reason: firstString(request.reason, existing.reason) } : {}),
  }
}

function buildWorkflowMountPatch(
  request: Record<string, unknown>,
  mounts: Record<string, string[]>,
  before?: MatOSWorkbenchRoleDraftPreview['before'],
): NonNullable<MatOSWorkbenchRoleDraftPreview['patch']['workflowMounts']> | undefined {
  const refs = mounts.workflows
  if (!refs || refs.length === 0) {
    return refs ? [] : undefined
  }
  const explicitRecords = [
    ...asArray(request.workflow_info_list),
    ...asArray(recordAt(request, 'bot_info')?.workflow_info_list),
    ...asArray(request.matos_attachments),
    ...asArray(request.attachments),
    ...asArray(recordAt(request, 'matos')?.attachments),
    ...asArray(recordAt(request, 'bot_ext_info')?.matos_attachments),
    ...asArray(recordAt(request, 'bot_info', 'bot_ext_info')?.matos_attachments),
    ...asArray(recordAt(request, 'data', 'bot_ext_info')?.matos_attachments),
  ].filter(item => attachmentGroup(item) === 'workflows')
  const byRef = new Map<string, Record<string, unknown>>()
  for (const item of explicitRecords) {
    const ref = workflowMountRecordRef(item) ?? attachmentRef(item)
    if (ref) {
      byRef.set(roleMountRefForGroup(ref, 'workflows'), isRecord(item) ? item : {})
    }
  }
  const existingByRef = new Map<string, unknown>()
  for (const item of asArray(before?.resource.metadata?.workflowMounts)) {
    const ref = workflowMountRecordRef(item)
    if (ref) {
      existingByRef.set(roleMountRefForGroup(ref, 'workflows'), item)
    }
  }
  return refs.map(ref => workflowMountFromRef({
    ref,
    request: byRef.get(ref),
    existing: existingByRef.get(ref),
  }))
}

export function buildLegacyRoleDraftPatch(input: {
  request: Record<string, unknown>
  before?: MatOSWorkbenchRoleDraftPreview['before']
}): MatOSWorkbenchRoleDraftPreview['patch'] {
  const mounts = buildMountPatch(input.request)
  const workflowMounts = buildWorkflowMountPatch(input.request, mounts, input.before)
  return {
    asset: {
      ...(requestName(input.request) ? { name: requestName(input.request) } : {}),
      ...(requestDescription(input.request) ? { description: requestDescription(input.request) } : {}),
    },
    selectedAgent: {
      ...(requestPrompt(input.request) ? { prompt: requestPrompt(input.request) } : {}),
      ...(requestModel(input.request) ? { model: requestModel(input.request) } : {}),
      ...(requestPermissionMode(input.request) ? { permissionMode: requestPermissionMode(input.request) } : {}),
    },
    mounts,
    ...(workflowMounts !== undefined ? { workflowMounts } : {}),
  }
}
