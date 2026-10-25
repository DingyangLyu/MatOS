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

export const MATOS_ASSET_MCP_SERVER_NAME = 'matos_asset'
export const MATOS_NATIVE_SESSION_META_KEY = 'matos/nativeSessionId'

export const MATOS_ASSET_DISCOVERY_TOOL_NAMES = [
  'asset_context',
  'asset_graph',
  'asset_related',
  'asset_impact',
  'asset_lineage',
  'asset_list',
  'asset_read',
  'asset_search',
  'asset_show',
] as const

export const MATOS_ASSET_BUILDER_TOOL_NAMES = [
  'adapt_path',
  'asset_edit',
] as const

export const MATOS_WORKFLOW_FACADE_TOOL_NAMES = [
  'workflow_query',
  'workflow_run',
  'workflow_edit',
] as const

export const MATOS_ROLE_BUILDER_TOOL_NAMES = [
  'role_query',
  'role_edit',
  'role_run',
] as const

export const MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES = [
  'workflow_context',
  'workflow_list',
  'workflow_show',
  'workflow_validate',
  'workflow_compile',
  'workflow_compile_inspect',
  'workflow_contracts',
  'workflow_status',
  'workflow_inspect',
  'workflow_events',
  'workflow_artifacts',
  'workflow_patches',
  'workflow_patch_propose',
  'workflow_patch_inspect',
  'workflow_patch_approve',
  'workflow_patch_reject',
  'workflow_patch_apply',
  'workflow_approval_status',
  'workflow_respond',
  'workflow_approve',
  'workflow_deny',
  'workflow_create_draft',
  'workflow_show_draft',
  'workflow_add_node',
  'workflow_update_node',
  'workflow_delete_node',
  'workflow_connect',
  'workflow_disconnect',
  'workflow_set_outputs',
  'workflow_validate_draft',
  'workflow_import_component',
  'workflow_publish_draft',
  'workflow_fork_run',
  'workflow_pause',
  'workflow_resume',
  'workflow_reconcile',
  'workflow_recover',
  'workflow_recover_apply',
  'workflow_recover_queue',
  'workflow_recover_drain',
  'workflow_cancel',
  'workflow_retry_node',
  'workflow_skip_node',
] as const

export const MATOS_WORKFLOW_TOOL_NAMES = [
  ...MATOS_WORKFLOW_FACADE_TOOL_NAMES,
  ...MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES,
] as const

export function normalizeMatOSToolName(id: string): string {
  return id
    .trim()
    .replace(/^matos_tool__/, '')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function matOSToolReferenceToAssetId(toolName: string): string {
  return normalizeMatOSToolName(toolName).replace(/_/g, '-')
}

export function matOSAssetMcpToolName(id: string): string {
  return `mcp__${MATOS_ASSET_MCP_SERVER_NAME}__${normalizeMatOSToolName(id)}`
}
