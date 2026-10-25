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
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  capPromptSummary,
  PROMPT_ENUMERATION_MAX_ENTRIES,
  promptEnumerationOmittedLine,
} from './promptBudget.js'
import type {
  MatOSAsset,
  MatOSAssetMountGroup,
  MatOSAssetMounts,
} from './types.js'
import {
  getMatOSAssetSubgraph,
  type MatOSAssetRegistry,
} from './registry.js'
import {
  MATOS_ASSET_MCP_SERVER_NAME,
  MATOS_ASSET_BUILDER_TOOL_NAMES,
  MATOS_ASSET_DISCOVERY_TOOL_NAMES,
  MATOS_ROLE_BUILDER_TOOL_NAMES,
  MATOS_WORKFLOW_FACADE_TOOL_NAMES,
  MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES,
  MATOS_WORKFLOW_TOOL_NAMES,
  matOSAssetMcpToolName,
} from '../tools/toolNames.js'
import {
  matOSSkillRuntimeLeafAlias,
  matOSSkillRuntimeName,
} from './skillRuntimeNames.js'
import {
  internalAssetPathPlaceholder,
  shouldRedactInternalAssetPaths,
} from './sourceVisibility.js'
import {
  buildMatOSAssetExecProviderScope,
  type MatOSAssetExecProviderScope,
} from '../algorithms/assetExecProvider.js'
import { decideMatOSToolSelection } from '../algorithms/surfaces/toolSelection.js'
import {
  decideMatOSInferenceRouting,
  type MatOSInferenceRoute,
} from '../algorithms/surfaces/inferenceRouting.js'
import { buildMatOSExperienceContext } from '../learning/experienceContextProvider.js'
import { buildMatOSKnowledgeContext } from '../learning/knowledgeContextProvider.js'
import { currentMatOSWorkflowExecutionContext } from '../workflows/executionContext.js'

type WorkflowToolMode = 'none' | 'facade' | 'full'

export type MatOSRuntimeProjection = {
  selectedAgent: string | undefined
  agents: Record<string, Record<string, unknown>>
  appendSystemPrompt: string[]
  skillDirs: string[]
  pluginDirs: string[]
  mcpConfigPaths: string[]
  mcpConfigJson: string[]
  allowedTools: string[]
  disallowedTools: string[]
  readablePaths: string[]
  assetToolDirs: string[]
  mountedWorkflowRefs: string[]
  assetEvents: Array<{
    type: 'selected' | 'projected' | 'skipped'
    assetKey: string
    reason?: string
  }>
}

export type MatOSRuntimeContextProfile = 'full' | 'lean'

export type MatOSRuntimeCompositionOptions = {
  projectCwd?: string
  projectMemberId?: string
  /** Internal registry-local strategy bindings for this composition. */
  algorithmProviderScope?: MatOSAssetExecProviderScope
  /**
   * Current user task text. Used to rank knowledge/experience context against
   * the task instead of only the static role identity.
   */
  taskText?: string
  /**
   * `full` (default) keeps the complete role runtime surface. `lean` keeps
   * task execution surfaces (tools, skills, workflows, knowledge) but drops
   * asset/role builder prompts and tools plus delegated role definitions, for
   * focused single-task runs such as benchmarks.
   */
  contextProfile?: MatOSRuntimeContextProfile
  /**
   * When false (no-tools / reply-only runs), tool, skill, workflow, builder,
   * and delegation prompt sections are omitted because the corresponding tool
   * surfaces are stripped from the runtime args. Knowledge and safety prompts
   * are kept. Defaults to true.
   */
  includeToolSurfaces?: boolean
  /**
   * Extra assets explicitly selected for this project/run. They are composed
   * as temporary mounts on the selected role only; the source role asset is
   * never mutated. References still resolve through the scoped native
   * registry, so a caller cannot use this surface to cross an asset scope.
   */
  additionalAssetRefs?: string[]
  pinnedAssetRefs?: string[]
}

type SkippedAssetReference = {
  reference: string
  reason: string
}

type RoleRuntimeParts = {
  role: MatOSAsset
  rolePrompt: string
  selectedAssets: MatOSAsset[]
  appendSystemPrompt: string[]
  skillDirs: string[]
  pluginDirs: string[]
  mcpConfigPaths: string[]
  allowedTools: string[]
  disallowedTools: string[]
  readablePaths: string[]
  assetToolDirs: string[]
  skillNames: string[]
  callableSkillNames: string[]
  skillAliases: Array<{ alias: string; target: string }>
  assetDiscoveryToolsEnabled: boolean
  workflowFacadeToolsEnabled: boolean
  workflowToolsEnabled: boolean
  mountedWorkflowRefs: string[]
  relevantKnowledge: MatOSAsset[]
  relevantExperiences: MatOSAsset[]
  skippedReferences: SkippedAssetReference[]
}

function runtimePinnedAssetRefs(assets: MatOSAsset[], explicit: string[] = []): string[] {
  return [...new Set([
    ...explicit,
    ...assets.flatMap(asset => [
      ...(asset.dependencies ?? []),
      ...Object.values(asset.mounts ?? {}).flatMap(refs => refs ?? []),
    ]).filter(ref => ref.includes('@')),
  ])]
}

type SkillRuntimeRef = {
  id: string
  manifestDir: string
}

function pushUnique(values: string[], value: string | undefined): void {
  if (!value || values.includes(value)) {
    return
  }
  values.push(value)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function rolePermissionTools(asset: MatOSAsset): string[] {
  if (!asset.permissions || Array.isArray(asset.permissions)) {
    return Array.isArray(asset.permissions) ? asset.permissions : []
  }

  return stringArray(asset.permissions.tools)
}

function mountRefs(asset: MatOSAsset, group: keyof MatOSAsset['mounts']): string[] {
  return asset.mounts[group] ?? []
}

const ASSET_TYPE_MOUNT_GROUP: Partial<Record<string, MatOSAssetMountGroup>> = {
  knowledge: 'knowledge',
  data: 'data',
  skill: 'skills',
  tool: 'tools',
  mcp: 'mcp',
  plugin: 'plugins',
  workflow: 'workflows',
  role: 'roles',
}

function roleWithAdditionalAssets(
  registry: MatOSAssetRegistry,
  role: MatOSAsset,
  references: readonly string[],
): { role: MatOSAsset; roots: string[] } {
  if (references.length === 0) {
    return { role, roots: [] }
  }

  const mounts: MatOSAssetMounts = { ...role.mounts }
  const roots: string[] = []
  for (const rawReference of references.slice(0, 64)) {
    const reference = rawReference.trim()
    if (!reference || roots.includes(reference)) {
      continue
    }
    const asset = registry.resolve(reference)
    if (!asset) {
      const current = reference.includes('@')
        ? registry.resolve(reference.replace(/@[^@]+$/, ''))
        : undefined
      throw new Error(
        `MatOS selected asset not found: ${reference}. ` +
        (current
          ? `The requested version is unavailable; the current accessible version is ${current.canonicalKey}. Refresh the selection or explicitly update the version pin.`
          : 'No enabled asset with this reference is visible in the current scope. Check publication, sharing permissions and lifecycle status; the selection was not silently skipped.'),
      )
    }
    if (asset.lifecycle.status === 'disabled' || asset.lifecycle.status === 'draft') {
      throw new Error(
        `MatOS selected asset is not enabled: ${asset.canonicalKey} (${asset.lifecycle.status})`,
      )
    }
    const group = ASSET_TYPE_MOUNT_GROUP[asset.type]
    if (!group) {
      throw new Error(
        `MatOS asset type cannot be mounted into a project run: ${asset.type}`,
      )
    }
    const mounted = mounts[group] ?? []
    if (!mounted.some(value => registry.resolve(value)?.canonicalKey === asset.canonicalKey)) {
      mounts[group] = [...mounted, asset.canonicalKey]
    }
    roots.push(asset.canonicalKey)
  }

  return {
    role: { ...role, mounts },
    roots,
  }
}

function runtimeWorkflowRefs(asset: MatOSAsset): string[] {
  return stringArray(asset.metadata.runtimeWorkflowRefs)
}

async function readPrompt(asset: MatOSAsset): Promise<string> {
  if (!asset.entryAbsolutePath) {
    return asset.description ?? asset.name
  }

  return (await readFile(asset.entryAbsolutePath, 'utf8')).trim()
}

export function knowledgeSummary(asset: MatOSAsset): string {
  const summary = optionalString(asset.metadata.summary)
  const description = asset.description
  const readablePath = shouldRedactInternalAssetPaths(asset)
    ? internalAssetPathPlaceholder()
    : asset.entryAbsolutePath ?? asset.absolutePath
  return [
    `- ${asset.type}:${asset.id}@${asset.version ?? 'unknown'} (${asset.name})`,
    // Capped: the full runbook/summary text lives one asset_read away.
    summary || description
      ? `  Summary: ${capPromptSummary((summary ?? description)!)}`
      : undefined,
    `  Path: ${readablePath}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function resolveMountedAssets(
  registry: MatOSAssetRegistry,
  asset: MatOSAsset,
  group: keyof MatOSAsset['mounts'],
  onSkipped?: (reference: string) => void,
): MatOSAsset[] {
  const resolved: MatOSAsset[] = []
  for (const reference of mountRefs(asset, group)) {
    const match = registry.resolve(reference)
    if (match) {
      resolved.push(match)
      continue
    }
    // Colonless entries are not asset references, so they are not "skipped".
    if (reference.includes(':')) {
      onSkipped?.(reference)
    }
  }
  return resolved
}

function resolveRoleWorkflowAssets(
  registry: MatOSAssetRegistry,
  role: MatOSAsset,
  onSkipped?: (reference: string) => void,
): MatOSAsset[] {
  const resolved: MatOSAsset[] = []
  const seen = new Set<string>()
  for (const reference of [
    ...mountRefs(role, 'workflows'),
    ...runtimeWorkflowRefs(role),
  ]) {
    const match = registry.resolve(reference)
    if (match?.canonicalKey && seen.has(match.canonicalKey)) {
      continue
    }
    if (match) {
      if (match.canonicalKey) {
        seen.add(match.canonicalKey)
      }
      resolved.push(match)
      continue
    }
    if (reference.includes(':')) {
      onSkipped?.(reference)
    }
  }
  return resolved
}

function resolveToolAssetReferencesFromSkills(skills: MatOSAsset[]): string[] {
  const refs = new Set<string>()
  for (const skill of skills) {
    for (const reference of [
      ...mountRefs(skill, 'tools'),
      ...stringArray(skill.metadata.toolReferences),
    ]) {
      refs.add(reference)
    }
  }
  return [...refs].sort()
}

function externalToolName(asset: MatOSAsset): string {
  const binding = optionalString(asset.metadata.binding)
  if (binding) {
    return binding
  }
  return matOSAssetMcpToolName(asset.id)
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
  if (knownTools.length === 0) {
    return []
  }
  return knownTools
    .map(tool => {
      if (tool.startsWith('mcp__')) {
        return tool
      }
      return serverName ? `mcp__${serverName}__${tool}` : undefined
    })
    .filter((tool): tool is string => Boolean(tool))
}

const ASSET_MCP_RUNTIME_ENV_KEYS = [
  'MATOS_SCOPE_ID',
  'MATOS_USER_ID',
  'MATOS_PROJECT_ID',
  'MATOS_PROJECT_MEMBER_ID',
  'MATOS_WORKSPACE_ID',
  'MATOS_RUNTIME_REF',
  'MATOS_RUNTIME_PROFILE_REF',
  'MATOS_ASSETS_CWD',
  'MATOS_BUNDLED_ASSET_ROOT',
  'MATOS_EDITABLE_CORE_ASSET_ROOT',
  'MATOS_ASSET_ROOTS',
  'MATOS_DEFAULT_ASSET_ROOTS',
  'MATOS_USER_VISIBLE_ASSET_ROOTS',
  'MATOS_LEGACY_ROOT',
  'MATOS_WORKSPACE_ROOT',
  'MATOS_WORKSPACE_DIR',
  'MATOS_TOS_STORAGE_AVAILABLE',
  'MATOS_TOS_STORAGE_ROOT',
  'MATOS_TOS_STORAGE_CLASS',
  'MATOS_SESSION_DIR',
  'MATOS_WORKFLOW_RUNS_DIR',
  'MATOS_CACHE_DIR',
  'MATOS_READ_ROOTS',
  'MATOS_WRITE_ROOTS',
  'MATOS_VEPFS_PATH_MAP',
  'MATOS_RUNTIME_EXECUTABLE_PATHS',
  'MATOS_RUNTIME_LIBRARY_PATHS',
  'MATOS_COMPUTE_PROFILE_JSON',
  'MATOS_COMPUTE_RUNTIME_IMAGE',
  'MATOS_COMPUTE_REMOTE_IMAGE',
  'MATOS_COMPUTE_TOOLCHAIN_CONTAINER_ROOT',
  'MATOS_COMPUTE_TOOLCHAIN_REMOTE_MOUNT',
  'MATOS_MP_LOCAL_DB',
  'MATOS_MP_LOCAL_DB_AVAILABLE',
  'MATOS_MP_LOCAL_DB_REASON',
  'MP_LOCAL_DB',
  'MATOS_AGENT_HOME',
  'MATOS_VASP_PSP_DIR',
  'MATOS_VASP_RUNNER_URL',
  'MATOS_VASP_RUNNER_TIMEOUT_MS',
  'MATOS_VASP_NPROCS',
  'PMG_VASP_PSP_DIR',
  'VASP_PP_PATH',
  'VASP_PSP_DIR',
  'PATH',
  'LD_LIBRARY_PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'FONTCONFIG_PATH',
  'MPLCONFIGDIR',
  'PYTHONUSERBASE',
  'MATOS_USER_PYTHONUSERBASE',
  'PIP_USER',
  'PIP_CACHE_DIR',
  'MATOS_PACKAGE_SOURCE_PROFILE',
  'MATOS_PIP_INDEX_URL',
  'PIP_INDEX_URL',
  'MATOS_PIP_EXTRA_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
  'UV_CACHE_DIR',
  'HF_HOME',
  'HF_ENDPOINT',
  'HUGGINGFACE_HUB_ENDPOINT',
  'TORCH_HOME',
  'WANDB_DIR',
  'CONDA_ENVS_PATH',
  'CONDA_PKGS_DIRS',
  'MATOS_CONDA_CHANNELS',
  'CONDA_CHANNELS',
  'MATOS_CONDA_CHANNEL_ALIAS',
  'CONDA_CHANNEL_ALIAS',
  'MATOS_USER_CONDA_ROOT',
  'MATOS_USER_CONDA_ENVS_PATH',
  'MATOS_SYSTEM_CONDA_ENVS_PATH',
  'MATOS_QE_PSEUDO_ROOT',
  'MATOS_GENESIS_PYTHON',
  'MATOS_LABENV_PYTHON',
  'MATOS_VLA_DATA_PYTHON',
  'MATOS_CAD_IMPORT_PYTHON',
  'MATOS_INSTRUMENT_ROOT',
  'MATOS_GEMINI_ENV_FILE',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_API_STYLE',
  'MATOS_PAPER_DB_BASE_URL',
  'MATOS_PAPER_DB_USERNAME',
  'MATOS_PAPER_DB_PASSWORD',
  'MATOS_PAPER_DB_ENV_FILE',
  'MATOS_PAPER_DB_DOWNLOAD_ROOT',
  'MATOS_PAPER_DB_TIMEOUT_SECONDS',
  'MATOS_PAPER_DB_HTTP_PROXY',
  'MATOS_PAPER_DB_HTTPS_PROXY',
  'MATOS_WEB_READ_HTTP_PROXY',
  'MATOS_WEB_READ_HTTPS_PROXY',
  'MATOS_JINA_HTTP_PROXY',
  'MATOS_JINA_HTTPS_PROXY',
  'MATOS_WEB_PROXY_URL',
  'MATOS_CONTAINER_PROXY_URL',
  'MATOS_LAB_ACTOR_FILE',
  'MATOS_LAB_SESSION_ID',
  'MATOS_DAEMON_SOCKET',
  'MATOS_DAEMON_HOST',
  'MATOS_DAEMON_PORT',
  'MATOS_DAEMON_AUTH_TOKEN_FILE',
  // Web search / reading provider keys (optional). When set, the built-in
  // WebSearch fallback and the web_read tool automatically use the keyed
  // provider; otherwise keyless backends are used. Configure via env only.
  'BOCHA_API_KEY',
  'BOCHA_SEARCH_API_KEY',
  'BOCHA_AI_API_KEY',
  'BO-CHA-API-KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'SERPER_KEY_ID',
  'BRAVE_SEARCH_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CSE_ID',
  'SERPAPI_API_KEY',
  'JINA_API_KEYS',
  'JINA_API_KEY',
] as const

const CONTAINER_VISIBLE_ENV_PATH_PREFIXES = [
  '/workspace/',
  '/home/workspace/',
  '/home/node/',
  '/app/',
  '/opt/',
  '/data/',
]

const HOST_ONLY_ENV_PATH_PATTERN =
  /\/(?:vepfs-[^\s:'"`,)}\]]+|tos-[^\s:'"`,)}\]/]+|Users|home|root)\/[^\s'"`,)}\]]*/g
const SECRET_ENV_KEY_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEYS?|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?|AUTH(?:ORIZATION)?|BEARER|COOKIE)(?:[^A-Za-z0-9]|$)/i

function containsHostOnlyEnvPath(value: string): boolean {
  for (const match of value.matchAll(HOST_ONLY_ENV_PATH_PATTERN)) {
    const path = match[0]
    if (
      !CONTAINER_VISIBLE_ENV_PATH_PREFIXES.some(
        prefix => path.startsWith(prefix) || path === prefix.replace(/\/$/, ''),
      )
    ) {
      return true
    }
  }
  return false
}

function assetMcpRuntimeEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  const schedulerTranslationKeys = new Set([
    'MATOS_VEPFS_PATH_MAP',
  ])
  for (const key of ASSET_MCP_RUNTIME_ENV_KEYS) {
    // Stdio MCP servers inherit the parent process environment through the
    // native MCP client. Keep secret values out of persisted CLI arg files.
    if (SECRET_ENV_KEY_PATTERN.test(key)) {
      continue
    }
    const value = sourceEnv[key]
    if (!value) {
      continue
    }
    if (!schedulerTranslationKeys.has(key) && containsHostOnlyEnvPath(value)) {
      continue
    }
    env[key] = value
  }
  return env
}

function buildAssetToolMcpServerSpec(
  toolDirs: string[],
  options: {
    projectCwd?: string
    projectMemberId?: string
    selectedRoleRef: string
    selectedAssetKeys: string[]
    pinnedAssetRefs?: string[]
    mlipModelManifests?: string[]
    enableAssetDiscoveryTools?: boolean
    enableWorkflowTools?: boolean
    workflowToolMode?: WorkflowToolMode
    mountedWorkflowRefs?: string[]
  },
): Record<string, unknown> {
  const serverPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'tools',
    'matosToolMcpServer.ts',
  )

  return {
    [MATOS_ASSET_MCP_SERVER_NAME]: {
      type: 'stdio',
      command: process.execPath,
      args: [serverPath],
      env: {
        ...assetMcpRuntimeEnv(),
        MATOS_TOOL_ASSET_DIRS: JSON.stringify(toolDirs),
        ...(process.env.MATOS_ASSETS_CWD
          ? { MATOS_ASSETS_CWD: process.env.MATOS_ASSETS_CWD }
          : {}),
        MATOS_MLIP_MODEL_MANIFESTS: JSON.stringify(options.mlipModelManifests ?? []),
        ...(options.projectCwd ? { MATOS_PROJECT_CWD: options.projectCwd } : {}),
        ...(options.projectMemberId
          ? { MATOS_PROJECT_MEMBER_ID: options.projectMemberId }
          : {}),
        MATOS_SELECTED_ROLE_REF: options.selectedRoleRef,
        MATOS_SELECTED_ASSET_KEYS: JSON.stringify(options.selectedAssetKeys),
        MATOS_PINNED_ASSET_REFS: JSON.stringify(options.pinnedAssetRefs ?? []),
        MATOS_ENABLE_ASSET_DISCOVERY_TOOLS:
          options.enableAssetDiscoveryTools === false ? '0' : '1',
        MATOS_ENABLE_WORKFLOW_TOOLS: options.enableWorkflowTools ? '1' : '0',
        MATOS_WORKFLOW_TOOL_MODE:
          options.workflowToolMode ?? (options.enableWorkflowTools ? 'full' : 'none'),
        // An explicit mountedWorkflowRefs array is the security boundary for
        // ordinary roles. Keep role-mounted even when it is empty; otherwise
        // a role with no mounted workflows silently receives unrestricted
        // workflow access through the MCP server.
        MATOS_WORKFLOW_ACCESS_MODE:
          options.mountedWorkflowRefs !== undefined
            ? 'role-mounted'
            : 'unrestricted',
        ...(options.mountedWorkflowRefs !== undefined
          ? { MATOS_ALLOWED_WORKFLOW_REFS: JSON.stringify(options.mountedWorkflowRefs) }
          : {}),
      },
    },
  }
}

function buildAssetToolMcpConfig(
  toolDirs: string[],
  options: {
    projectCwd?: string
    projectMemberId?: string
    selectedRoleRef: string
    selectedAssetKeys: string[]
    pinnedAssetRefs?: string[]
    mlipModelManifests?: string[]
    enableAssetDiscoveryTools?: boolean
    enableWorkflowTools?: boolean
    workflowToolMode?: WorkflowToolMode
    mountedWorkflowRefs?: string[]
  },
): string {
  return JSON.stringify({
    mcpServers: buildAssetToolMcpServerSpec(toolDirs, options),
  })
}

async function buildInlineMcpServerSpecs(
  mcpConfigPaths: string[],
): Promise<Record<string, unknown>[]> {
  const specs: Record<string, unknown>[] = []
  for (const configPath of mcpConfigPaths) {
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8')) as {
        mcpServers?: Record<string, unknown>
      }
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
        continue
      }
      for (const [serverName, serverConfig] of Object.entries(parsed.mcpServers)) {
        if (!serverConfig || typeof serverConfig !== 'object') {
          continue
        }
        specs.push({ [serverName]: serverConfig })
      }
    } catch {
      continue
    }
  }
  return specs
}

function buildAssetDiscoveryPrompt(): string {
  return [
    'MatOS asset discovery tools are available in this role runtime:',
    ...MATOS_ASSET_DISCOVERY_TOOL_NAMES.map(name => `- ${matOSAssetMcpToolName(name)}`),
    'Use these tools to inspect active assets, the selected role graph, and user-readable asset entries during the conversation.',
    'For broad discovery, call asset_list or asset_search with compact fields such as fields=id,type,name,summary,group; use offset/limit for pagination and includeGroups=true to see top-level asset groups before drilling in.',
    'Use asset_show for metadata and asset_read only for user-readable entries. Internal MatOS skill and source paths are not a user-facing interface.',
    'Disabled assets are not runtime-usable unless explicitly inspected with includeDisabled.',
  ].join('\n')
}

function buildAssetBuilderToolsPrompt(): string {
  return [
    'MatOS asset builder tools are available in this role runtime:',
    `- ${matOSAssetMcpToolName('adapt_path')}: adapt an uploaded file or database path into a reference-only data asset bundle and publish it through the active scoped accepted ref.`,
    `- ${matOSAssetMcpToolName('asset_edit')}: create or update non-role/non-workflow assets through native MatOS governance.`,
    'When the user asks to reuse an uploaded path, database, or dataset, prefer adapt_path over hand-writing manifests or copying payloads.',
    'Use asset_edit only for knowledge, data, tool, skill, and MCP assets.',
    'Use role_edit for role assets and workflow_edit for workflow assets; do not hand-write asset manifests when a builder tool can do it.',
    'asset_edit defaults to scoped Gitea accepted-ref writes when scopeRef is user/team/project, so accepted Gitea commits remain the runtime authority.',
    'Only use target=project-local as an explicit recovery or local draft fallback.',
    'Core/shared/global assets are read-only here, but the user can own a personalized fork: read the original with asset_read, then asset_edit create a scoped asset with the SAME type and id, the full adjusted content, and metadata.overlayOf set to the exact overlaid canonical key (for example "skill:materials-compute@1.0.0"). The fork wins resolution only inside this scope; other users keep the public asset, and deleting the fork restores it. Never submit a truncated copy, and note that a same-id scoped asset without metadata.overlayOf fails validation as a duplicate.',
  ].join('\n')
}

function buildRoleBuilderToolsPrompt(): string {
  return [
    'MatOS role builder tools are available in this role runtime:',
    `- ${matOSAssetMcpToolName('role_query')}: inspect roles, compose a role runtime, and preview role create/update plans.`,
    `- ${matOSAssetMcpToolName('role_edit')}: create, update, attach, or detach role assets through native MatOS governance.`,
    `- ${matOSAssetMcpToolName('role_run')}: delegate a focused task to a role explicitly mounted by the active role.`,
    'Use role_run for MatOS-traced delegation when the current execution engine does not expose the native Agent tool.',
    'Prefer role_edit for durable role assets instead of writing asset files by hand.',
    'When scopeRef is user/team/project, role_edit writes through scoped Gitea accepted refs so the accepted commit remains the runtime authority.',
    'Create a new semantic role id for user-specific behavior. Do not shadow core roles unless overlayOf is explicit and the user or operator requested that override.',
    'Durable-agent completion contract: when the user asks to create, build, package, install, or share a reusable Agent or Role, treat that as native Role authoring unless the user explicitly asks only for source code. Build or reuse its dependent assets, call role_edit action=create, require accepted-ref sync and smoke success, and report the canonical role ref. A Python package, prompt file, project folder, or skill by itself is not a completed MatOS Agent/Role.',
    'In project chat, role_edit action=create adds the accepted Role to the project by default. Use projectBinding=replace-current when the user wants the new project Agent to replace the current Compute member. Do not claim the project switched roles unless projectBinding.ok is true; explain that the next turn uses the newly bound Role.',
  ].join('\n')
}

function buildRuntimeSkillsPrompt(
  projectCwd: string | undefined,
  callableSkillNames: string[],
  skillAliases: Array<{ alias: string; target: string }>,
): string | undefined {
  if (!projectCwd) {
    return undefined
  }

  return [
    'MatOS runtime skills are available through the builtin Skill tool.',
    'MatOS Skill routing checkpoint: for materials computation, invoke Skill("materials-compute") before using Bash or MatOS MCP tools for domain-specific work; then invoke the router-selected top-level or nested skill before writing scripts, generating inputs, or submitting jobs.',
    callableSkillNames.length > 0
      ? `Available MatOS skill names: ${callableSkillNames.join(', ')}.`
      : undefined,
    skillAliases.length > 0
      ? [
          'Unique nested skill aliases are also callable:',
          ...skillAliases.map(alias => `- ${alias.alias} -> ${alias.target}`),
        ].join('\n')
      : undefined,
    'Only invoke Skill with a name explicitly listed above or returned by MatOS asset discovery; do not guess leaf names from directory text.',
    'Invoke Skill by name instead of browsing, printing, or exposing MatOS skill source files.',
    'When older role text mentions `<runtime skills root>`, treat that path as internal runtime plumbing and use Skill or MatOS asset tools instead.',
    'Internal skill materialization paths are intentionally not user-facing.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function buildDelegatedSkillsPrompt(
  availableParts: RoleRuntimeParts[],
  selectedRole: MatOSAsset,
): string | undefined {
  const delegatedRolesWithSkills = availableParts
    .filter(
      parts =>
        parts.role.canonicalKey !== selectedRole.canonicalKey &&
        parts.callableSkillNames.length > 0,
    )
    .map(parts => parts.role.id)
    .sort()
  if (delegatedRolesWithSkills.length === 0) {
    return undefined
  }
  return [
    'Delegated MatOS roles have their own focused Skill tool context.',
    `Skill lists for ${delegatedRolesWithSkills.join(', ')} are loaded when those roles run through the Agent tool; they are not expanded into the current role prompt.`,
    'Use the Agent tool for specialized role work instead of asking the current role to preload every mounted skill.',
  ].join('\n')
}

function buildUniqueSkillAliases(
  skillAssets: SkillRuntimeRef[],
): Array<{ alias: string; target: string }> {
  const canonicalNames = new Set(
    skillAssets.map(skill => matOSSkillRuntimeName(skill.id)),
  )
  const candidates = skillAssets
    .map(skill => ({
      alias: matOSSkillRuntimeLeafAlias(skill.id),
      target: matOSSkillRuntimeName(skill.id),
    }))
    .filter(
      (candidate): candidate is { alias: string; target: string } =>
        Boolean(candidate.alias) && candidate.alias !== candidate.target,
    )
  const aliasCounts = new Map<string, number>()
  for (const candidate of candidates) {
    aliasCounts.set(candidate.alias, (aliasCounts.get(candidate.alias) ?? 0) + 1)
  }
  return candidates.filter(
    candidate =>
      aliasCounts.get(candidate.alias) === 1 &&
      !canonicalNames.has(candidate.alias),
  )
}

function expandSkillRuntimeRefs(
  registry: MatOSAssetRegistry,
  skillAssets: MatOSAsset[],
): SkillRuntimeRef[] {
  const refs: SkillRuntimeRef[] = []
  const seen = new Set<string>()
  const addRef = (ref: SkillRuntimeRef): void => {
    const key = `${ref.id}\0${ref.manifestDir}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    refs.push(ref)
  }

  // Explicit mounts (including exact version pins) take precedence over
  // implicit children. Genuine conflicting explicit mounts still fail later.
  const explicitIds = new Set(skillAssets.map(skill => skill.id))
  for (const skill of skillAssets) {
    addRef({ id: skill.id, manifestDir: skill.manifestDir })
  }
  // The registry owns scope, lifecycle and accepted overlay resolution. A
  // filesystem rescan resurrects shadowed core children and hidden assets.
  const visibleSkills = registry.assets.filter(asset => asset.type === 'skill')
  for (const skill of skillAssets) {
    for (const nested of visibleSkills) {
      if (explicitIds.has(nested.id)) continue
      const childPath = relative(skill.manifestDir, nested.manifestDir)
      if (!childPath || childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) continue
      const winner = registry.resolve(`skill:${nested.id}`)
      if (winner?.type === 'skill' && !['draft', 'disabled', 'deprecated'].includes(winner.lifecycle.status)) {
        addRef({ id: winner.id, manifestDir: winner.manifestDir })
      }
    }
  }

  return refs
}

function buildWorkflowToolsPrompt(): string {
  return [
    'MatOS workflow runtime tools are available in this role runtime:',
    ...MATOS_WORKFLOW_TOOL_NAMES.map(name => `- ${matOSAssetMcpToolName(name)}`),
    'Use these tools to list workflow assets, start runs, inspect status/events, respond to waiting nodes, and cancel runs without shelling out to the CLI.',
    'Prefer native workflow node types agent, exec, guard, human, backend, subworkflow, map, and loop.',
    'Semantic workflow node types compute, approval_gate, validate, and supernode are supported by the native compiler.',
    'Use compute/backend nodes for real scientific jobs, approval_gate for explicit gates, validate/guard nodes for evidence checks, map for finite collections, and bounded loop only with maxIterations.',
    'Dynamic graph mutation is reserved; create drafts or graph patch candidates instead of mutating a live run graph.',
    'When setting workflow outputs, use templates like {{ nodes.<nodeId>.outputs.<field> }}; do not use steps.* templates.',
    'Validation and route expressions may inspect {{ nodes.<nodeId>.status }}, {{ nodes.<nodeId>.attempts }}, and {{ nodes.<nodeId>.error.<field> }} when needed.',
    'Guard nodes expose outputs.ok; exec nodes expose outputs.exitCode, outputs.stdout, and outputs.stderr.',
  ].join('\n')
}

// Deliberately compact: the always-on facade prompt teaches the three tool
// names plus the short behavioral rules. Deep usage guidance lives in the
// tools' own descriptions and in workflow_query action=context, which cost
// context only when loaded/called.
function buildWorkflowFacadeToolsPrompt(hasMountedWorkflows: boolean): string {
  return [
    'MatOS workflow facade tools are available in this role runtime:',
    `- ${matOSAssetMcpToolName('workflow_query')}: discover/inspect workflows, node manifests, templates, runs, events, and artifacts (compact list/show by default).`,
    `- ${matOSAssetMcpToolName('workflow_run')}: preflight, start, wait, inspect, pause/resume, cancel, recover, or respond to a workflow run.`,
    `- ${matOSAssetMcpToolName('workflow_edit')}: create/revise workflow drafts, publish them, and attach published workflows to roles.`,
    hasMountedWorkflows
      ? `Before an ad-hoc shell/script path for a repeatable task that matches a mounted workflow, use the known candidate directly: ${matOSAssetMcpToolName('workflow_query')} action=show, then action=preflight, then ${matOSAssetMcpToolName('workflow_run')} action=start. Use action=context/list only when no candidate is known.`
      : `Use ${matOSAssetMcpToolName('workflow_query')} action=context/list to check for enabled workflows before creating a new workflow from scratch.`,
    `For workflows that may run longer than a few minutes (DFT/HPC/compute pipelines), normally start with ${matOSAssetMcpToolName('workflow_run')} action=start wait=false, then follow with action=wait (bounded long-poll) instead of polling status in a loop. When a tracked CLI harness owns execution, its case-local instructions override this default: launch only through its helper, do not wait or poll, and end the Agent segment after a durable handoff.`,
    `A workflow published during this session is runnable by its returned assetKey (see ${matOSAssetMcpToolName('workflow_query')} action=context sessionWorkflowRefs); use ${matOSAssetMcpToolName('workflow_edit')} action=attach_to_role when it must become a durable role mount.`,
    'Do not delegate merely to run an existing mounted workflow; delegate only for specialist graph authoring, repair, or domain interpretation.',
  ].join('\n')
}

// Context budget for the mounted-workflows prompt section. Full workflow
// descriptions made this the single largest appendSystemPrompt section
// (11.3K chars for 30 workflows on role:compute), so entries carry a capped
// first-sentence summary and the long tail stays name-only; full details are
// one workflow_query action=show away.
const WORKFLOW_PROMPT_DESCRIBED_ENTRIES = 40

function capWorkflowDescription(description: string): string {
  return capPromptSummary(description)
}

function workflowRefLine(asset: MatOSAsset): string {
  return `- ${asset.canonicalKey || `${asset.type}:${asset.id}@${asset.version ?? 'unknown'}`}`
}

export function workflowSummary(asset: MatOSAsset): string {
  return [
    workflowRefLine(asset),
    asset.description ? `: ${capWorkflowDescription(asset.description)}` : '',
  ].join('')
}

export function buildMountedWorkflowsPrompt(
  workflows: MatOSAsset[],
): string | undefined {
  if (workflows.length === 0) {
    return undefined
  }
  const shown = workflows.slice(0, PROMPT_ENUMERATION_MAX_ENTRIES)
  return [
    'MatOS workflows enabled for this role runtime:',
    ...shown.map((asset, index) =>
      index < WORKFLOW_PROMPT_DESCRIBED_ENTRIES
        ? workflowSummary(asset)
        : workflowRefLine(asset),
    ),
    ...(workflows.length > shown.length
      ? [
          promptEnumerationOmittedLine(
            workflows.length - shown.length,
            `${matOSAssetMcpToolName('workflow_query')} action=list`,
          ),
        ]
      : []),
    `Prefer these enabled workflows for repeatable procedures. Descriptions are capped summaries — inspect inputs and full definitions with ${matOSAssetMcpToolName('workflow_query')} action=show before ${matOSAssetMcpToolName('workflow_run')}; ask the user or a workflow-builder role to fill missing inputs instead of guessing.`,
  ].join('\n')
}

function buildRuntimeSafetyPrompt(): string {
  return [
    'MatOS runtime safety and persistence rules:',
    '- The container-visible paths below (/workspace/..., /app/matos-assets, /opt/matos-tools) apply when running inside a MatOS workspace container. On a host install without these mounts (for example an Edition S distribution workspace), skip rules whose paths do not exist and keep the equivalent artifacts under the current workspace directory instead.',
    '- Treat /app/matos-assets, /workspace/assets/global, /workspace/assets/projects, and /opt/matos-tools as administrator-managed read-only sources. Do not edit, chmod, pip install into, or write generated files under them.',
    '- User-created assets belong under /workspace/assets/user/* or /workspace/group/shared/.matos/assets. Normal project work, demos, logs, plots, and summaries belong under the current workspace, usually /workspace/group/shared/<project>.',
    '- When /workspace/group/tos is mounted, use it only as private large-capacity cold storage for large datasets, model checkpoints, completed outputs, and compressed archives. Keep active projects, Git repositories, Conda environments, databases, caches, and small-file-heavy calculations under /workspace/group/shared or their designated cache paths.',
    '- For questions about how to use MatOS itself, first read /workspace/group/shared/MATOS_USER_MANUAL.md and the relevant /workspace/group/shared/matos-manual/*.md chapter when present instead of guessing from memory; do not spend turns searching for the manual when those files are absent.',
    '- Do not rely on /tmp or transient TaskOutput paths for user-visible results. If you start a background command or demo, tee stdout/stderr and write final artifacts into the workspace project directory.',
    '- Before local QE, LAMMPS, VASP, Conda, Python, MLIP, or atomistic-tool work, call the relevant MatOS catalog/preflight MCP tool and follow the returned container-visible paths.',
    '- For MACE and other MLIP models, call mcp__matos_asset__mlip_model_catalog first. Use returned localPath values in model loaders; do not use aliases such as model="medium" when a localPath is available, because aliases may trigger network downloads.',
    '- Use mcp__matos_asset__conda_environment_catalog to choose Python. Shared system environments are read-only; user-created environments must be under /workspace/caches/conda/envs.',
    '- If a required Python package is missing, use mcp__matos_asset__conda_environment_manager to create or update a user-scoped environment under /workspace/caches/conda/envs. Do not pip install into /opt/matos-tools, /app, or the container root layer.',
    '- Avoid exporting broad LD_LIBRARY_PATH values in user scripts. If a tool needs runtime libraries, scope LD_LIBRARY_PATH to that subprocess or use the MatOS-provided wrapper/catalog guidance.',
  ].join('\n')
}

function buildMatOSProductIdentityPrompt(): string {
  return [
    'MatOS product identity:',
    '- You are MatOS, a computational materials science agent running in the MatOS workspace platform.',
    '- Do not identify yourself as Claude, Claude Code, Anthropic, ChatGPT, OpenAI, or any upstream model/provider.',
    '- If the user asks who you are, answer as MatOS and describe the active MatOS role when helpful.',
    '- You may mention that MatOS runs on DeepSeek Harness only when discussing implementation details; do not present that runtime as your product identity.',
  ].join('\n')
}

function buildDelegatedRolesPrompt(
  currentRole: MatOSAsset,
  availableParts: RoleRuntimeParts[],
): string | undefined {
  const delegatedRoles = availableParts
    .filter(parts => parts.role.canonicalKey !== currentRole.canonicalKey)
    .map(parts => parts.role)
    .sort((left, right) => left.id.localeCompare(right.id))

  if (delegatedRoles.length === 0) {
    return undefined
  }

  const shown = delegatedRoles.slice(0, PROMPT_ENUMERATION_MAX_ENTRIES)
  return [
    'MatOS delegated role assets are available through the Agent tool:',
    // Role descriptions are authored for asset pages; cap them to their first
    // sentence here like every other always-on enumeration.
    ...shown.map(role =>
      `- ${role.id}: ${capPromptSummary(role.description ?? role.name)}`,
    ),
    ...(delegatedRoles.length > shown.length
      ? [
          promptEnumerationOmittedLine(
            delegatedRoles.length - shown.length,
            'asset_list type=role',
          ),
        ]
      : []),
    'Delegate to these roles when their focused context or tools fit the task better than the current role.',
    'Do not invent subagent names outside this list.',
  ].join('\n')
}

export function buildToolPrompt(toolMappings: Array<{
  legacyName: string | undefined
  runtimeName: string
  asset: MatOSAsset
}>): string | undefined {
  if (toolMappings.length === 0) {
    return undefined
  }

  const shown = toolMappings.slice(0, PROMPT_ENUMERATION_MAX_ENTRIES)
  return [
    'MatOS mounted tool assets are available through the native MatOS tool runtime:',
    // Capped summaries: each tool's full description/prompt ships with its
    // tool definition when the tool loads, so this always-on list only needs
    // enough for discovery.
    ...shown.map(({ legacyName, runtimeName, asset }) =>
      [
        `- ${legacyName ? `${legacyName} -> ` : ''}${runtimeName}`,
        asset.description ? `: ${capPromptSummary(asset.description)}` : '',
      ].join(''),
    ),
    ...(toolMappings.length > shown.length
      ? [
          promptEnumerationOmittedLine(
            toolMappings.length - shown.length,
            'asset_list type=tool',
          ),
        ]
      : []),
    'Use these runtime tool names when invoking tools.',
  ].join('\n')
}

function isHiddenEvolutionJsonOnlyRole(role: MatOSAsset): boolean {
  if (role.metadata?.hidden !== true || role.metadata?.group !== 'evolution') {
    return false
  }
  return (
    role.id !== 'direct-asset-editor' && role.id !== 'semantic-acceptance-judge'
  )
}

function buildRoleAgentDefinition(
  role: MatOSAsset,
  prompt: string,
  tools: string[],
  disallowedTools: string[],
  skills: string[],
  mcpServers: Record<string, unknown>[] = [],
  jsonOnly = false,
  algorithmProviderScope?: MatOSAssetExecProviderScope,
  projectCwd?: string,
): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    description: role.description ?? role.name,
    prompt,
  }

  if (jsonOnly) {
    agent.tools = []
  } else if (tools.length > 0) {
    agent.tools = tools
  }
  if (disallowedTools.length > 0) {
    agent.disallowedTools = disallowedTools
  }
  if (skills.length > 0) {
    agent.skills = skills
  }
  if (mcpServers.length > 0) {
    agent.mcpServers = mcpServers
  }

  const baselineRoute: MatOSInferenceRoute = {}
  const model = optionalString(role.runtime.model)
  if (model) baselineRoute.model = model
  const baselineEffort = role.runtime.effort
  if (typeof baselineEffort === 'string' && baselineEffort.trim().length > 0) {
    baselineRoute.effort = baselineEffort.trim()
  } else if (typeof baselineEffort === 'number') {
    baselineRoute.effort = baselineEffort
  }
  const candidateRoutes = roleInferenceCandidateRoutes(role, baselineRoute)
  const execution = currentMatOSWorkflowExecutionContext()
  const route = decideMatOSInferenceRouting({
    roleRef: role.canonicalKey,
    baselineRoute,
    candidateRoutes,
    role,
    providerOverrides: algorithmProviderScope?.providersFor('inference-routing'),
    ...(execution?.remainingBudget
      ? { remainingBudget: { ...execution.remainingBudget } }
      : {}),
    ...(execution?.runId ? { workflowRunId: execution.runId } : {}),
    ...(execution?.workflowNodeId
      ? { workflowNodeId: execution.workflowNodeId }
      : {}),
    ...(execution?.attempt !== undefined
      ? { attempt: execution.attempt }
      : {}),
    ...(projectCwd ? { cwd: projectCwd } : {}),
  }).decision
  if (route.model) agent.model = route.model
  if (
    (typeof route.effort === 'string' && route.effort.trim().length > 0) ||
    typeof route.effort === 'number'
  ) {
    agent.effort = route.effort
  }

  const permissionMode = optionalString(role.runtime.permissionMode)
  if (permissionMode) {
    agent.permissionMode = permissionMode
  }

  const maxTurns = optionalPositiveInteger(role.runtime.maxTurns)
  if (maxTurns !== undefined) {
    agent.maxTurns = maxTurns
  }

  const initialPrompt = optionalString(role.runtime.initialPrompt)
  if (initialPrompt) {
    agent.initialPrompt = initialPrompt
  }

  const memory = optionalString(role.runtime.memory)
  if (memory) {
    agent.memory = memory
  }

  return agent
}

function roleInferenceCandidateRoutes(
  role: MatOSAsset,
  baseline: MatOSInferenceRoute,
): MatOSInferenceRoute[] {
  const routes: MatOSInferenceRoute[] = [{ ...baseline }]
  const explicit = Array.isArray(role.runtime.inferenceRoutes)
    ? role.runtime.inferenceRoutes
    : []
  for (const item of explicit) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const route: MatOSInferenceRoute = {}
    const model = optionalString(raw.model)
    if (model) route.model = model
    if (typeof raw.effort === 'string' && raw.effort.trim()) {
      route.effort = raw.effort.trim()
    } else if (typeof raw.effort === 'number' && Number.isFinite(raw.effort)) {
      route.effort = raw.effort
    }
    if (route.model !== undefined || route.effort !== undefined) routes.push(route)
  }
  const models = stringArray(role.runtime.modelCandidates)
  const efforts = Array.isArray(role.runtime.effortCandidates)
    ? role.runtime.effortCandidates.filter(
        (value): value is string | number =>
          (typeof value === 'string' && value.trim().length > 0) ||
          (typeof value === 'number' && Number.isFinite(value)),
      )
    : []
  for (const candidateModel of models) {
    if (efforts.length === 0) routes.push({ model: candidateModel })
    for (const effort of efforts) {
      routes.push({
        model: candidateModel,
        effort: typeof effort === 'string' ? effort.trim() : effort,
      })
    }
  }
  const unique = new Map<string, MatOSInferenceRoute>()
  for (const route of routes) {
    unique.set(JSON.stringify([route.model ?? null, route.effort ?? null]), route)
    if (unique.size >= 64) break
  }
  return [...unique.values()]
}

function roleEnablesWorkflowTools(
  registry: MatOSAssetRegistry,
  role: MatOSAsset,
): boolean {
  for (const toolReference of mountRefs(role, 'tools')) {
    if (!toolReference.includes(':')) {
      continue
    }
    const toolAsset = registry.resolve(toolReference)
    if (!toolAsset) {
      continue
    }
    if (toolAsset.id === 'mcp-workflow-tools') {
      return true
    }
    if (stringArray(toolAsset.metadata.mcpServers).includes('workflow-tools')) {
      return true
    }
  }
  return false
}

async function collectRoleRuntimeParts(
  registry: MatOSAssetRegistry,
  role: MatOSAsset,
  options: MatOSRuntimeCompositionOptions = {},
): Promise<RoleRuntimeParts> {
  const leanContext = options.contextProfile === 'lean'
  const includeToolSurfaces = options.includeToolSurfaces !== false
  const selectedAssetsByKey = new Map<string, MatOSAsset>()
  for (const asset of getMatOSAssetSubgraph(registry, role.canonicalKey)) {
    selectedAssetsByKey.set(asset.canonicalKey, asset)
  }
  for (const reference of options.additionalAssetRefs ?? []) {
    for (const asset of getMatOSAssetSubgraph(registry, reference)) {
      selectedAssetsByKey.set(asset.canonicalKey, asset)
    }
  }
  const selectedAssets = [...selectedAssetsByKey.values()]
  const appendSystemPrompt: string[] = []
  const skillDirs: string[] = []
  const pluginDirs: string[] = []
  const mcpConfigPaths: string[] = []
  const allowedTools: string[] = []
  const disallowedTools: string[] = []
  const readablePaths: string[] = []
  const assetToolDirs: string[] = []
  const skillNames: string[] = []
  const toolMappings: Array<{
    legacyName: string | undefined
    runtimeName: string
    asset: MatOSAsset
  }> = []

  const skippedReferences: SkippedAssetReference[] = []
  const pushSkipped = (reference: string, reason: string): void => {
    if (
      !skippedReferences.some(
        skipped => skipped.reference === reference && skipped.reason === reason,
      )
    ) {
      skippedReferences.push({ reference, reason })
    }
  }
  const mountSkipHandler = (group: string) => (reference: string) =>
    pushSkipped(reference, `unresolved-${group}-reference`)

  const rolePrompt = await readPrompt(role)
  const skillAssets = resolveMountedAssets(
    registry,
    role,
    'skills',
    mountSkipHandler('skills'),
  )
  const skillRuntimeRefs = expandSkillRuntimeRefs(registry, skillAssets)
  const skillAliases = buildUniqueSkillAliases(skillRuntimeRefs)
  const workflowToolsEnabled = roleEnablesWorkflowTools(registry, role)
  const workflowAssets = resolveRoleWorkflowAssets(
    registry,
    role,
    mountSkipHandler('workflows'),
  )
  const mountedWorkflowRefs = workflowAssets.map(asset => asset.canonicalKey)

  for (const toolReference of mountRefs(role, 'tools')) {
    if (!toolReference.includes(':')) {
      pushUnique(allowedTools, toolReference)
      continue
    }

    const toolAsset = registry.resolve(toolReference)
    if (!toolAsset) {
      pushSkipped(toolReference, 'unresolved-tools-reference')
      continue
    }

    const kind = optionalString(toolAsset.metadata.kind)
    if (kind === 'builtin-pack') {
      for (const tool of stringArray(toolAsset.metadata.builtinTools)) {
        pushUnique(allowedTools, tool)
      }
      continue
    }

    if (kind === 'external-tool') {
      const runtimeName = externalToolName(toolAsset)
      pushUnique(allowedTools, runtimeName)
      pushUnique(assetToolDirs, toolAsset.manifestDir)
      toolMappings.push({ legacyName: undefined, runtimeName, asset: toolAsset })
      continue
    }

    pushUnique(allowedTools, optionalString(toolAsset.metadata.binding) ?? toolAsset.id)
  }

  for (const toolReference of resolveToolAssetReferencesFromSkills(skillAssets)) {
    const toolAsset = registry.resolve(toolReference)
    if (!toolAsset) {
      pushSkipped(toolReference, 'unresolved-skill-tool-reference')
      continue
    }
    const kind = optionalString(toolAsset.metadata.kind)
    if (kind === 'builtin-pack') {
      for (const tool of stringArray(toolAsset.metadata.builtinTools)) {
        pushUnique(allowedTools, tool)
      }
      continue
    }
    if (kind !== 'external-tool') {
      pushUnique(allowedTools, optionalString(toolAsset.metadata.binding) ?? toolAsset.id)
      continue
    }
    const runtimeName = externalToolName(toolAsset)
    pushUnique(allowedTools, runtimeName)
    pushUnique(assetToolDirs, toolAsset.manifestDir)
    toolMappings.push({
      legacyName: `matos_tool__${toolAsset.id.replace(/-/g, '_')}`,
      runtimeName,
      asset: toolAsset,
    })
  }

  for (const tool of rolePermissionTools(role)) {
    pushUnique(allowedTools, tool)
  }

  for (const tool of stringArray(role.runtime.disallowedTools)) {
    pushUnique(disallowedTools, tool)
  }

  const jsonOnlyHiddenRole = isHiddenEvolutionJsonOnlyRole(role)
  const assetDiscoveryToolsEnabled =
    !jsonOnlyHiddenRole && role.runtime.assetDiscoveryTools !== false
  const workflowFacadeToolsEnabled =
    assetDiscoveryToolsEnabled && role.runtime.workflowFacadeTools !== false
  if (!jsonOnlyHiddenRole) {
    if (assetDiscoveryToolsEnabled) {
      for (const toolName of MATOS_ASSET_DISCOVERY_TOOL_NAMES) {
        pushUnique(allowedTools, matOSAssetMcpToolName(toolName))
      }
    }

    // Lean context keeps execution surfaces but drops asset/role authoring
    // tools, which focused single-task runs never need.
    if (!leanContext && role.runtime.assetAuthoringTools !== false) {
      for (const toolName of MATOS_ASSET_BUILDER_TOOL_NAMES) {
        pushUnique(allowedTools, matOSAssetMcpToolName(toolName))
      }

      for (const toolName of MATOS_ROLE_BUILDER_TOOL_NAMES) {
        pushUnique(allowedTools, matOSAssetMcpToolName(toolName))
      }
    }

    if (workflowFacadeToolsEnabled) {
      for (const toolName of MATOS_WORKFLOW_FACADE_TOOL_NAMES) {
        pushUnique(allowedTools, matOSAssetMcpToolName(toolName))
      }
    }

    if (workflowToolsEnabled) {
      for (const toolName of MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES) {
        pushUnique(allowedTools, matOSAssetMcpToolName(toolName))
      }
    }
    if (skillAssets.length > 0) {
      pushUnique(allowedTools, 'Skill')
    }
  }

  const knowledgeAssetsByKey = new Map<string, MatOSAsset>()
  const addKnowledgeAssets = (assets: MatOSAsset[]): void => {
    for (const asset of assets) {
      knowledgeAssetsByKey.set(asset.canonicalKey, asset)
    }
  }
  addKnowledgeAssets([
    ...resolveMountedAssets(registry, role, 'knowledge', mountSkipHandler('knowledge')),
    ...resolveMountedAssets(registry, role, 'data', mountSkipHandler('data')),
  ])
  // A project-selected skill is mounted onto a synthetic role at composition
  // time. Its own data/knowledge mounts remain on the skill, so project them
  // explicitly instead of making the agent rediscover assets that were
  // already selected as part of the skill's dependency graph.
  for (const skill of skillAssets) {
    addKnowledgeAssets([
      ...resolveMountedAssets(
        registry,
        skill,
        'knowledge',
        mountSkipHandler('skill-knowledge'),
      ),
      ...resolveMountedAssets(
        registry,
        skill,
        'data',
        mountSkipHandler('skill-data'),
      ),
    ])
  }
  const knowledgeAssets = [...knowledgeAssetsByKey.values()]
  if (knowledgeAssets.length > 0) {
    const shownKnowledge = knowledgeAssets.slice(0, PROMPT_ENUMERATION_MAX_ENTRIES)
    appendSystemPrompt.push(
      [
        'MatOS mounted knowledge and data assets:',
        ...shownKnowledge.map(knowledgeSummary),
        ...(knowledgeAssets.length > shownKnowledge.length
          ? [
              promptEnumerationOmittedLine(
                knowledgeAssets.length - shownKnowledge.length,
                'asset_list type=knowledge',
              ),
            ]
          : []),
      ].join('\n'),
    )
  }

  for (const asset of knowledgeAssets) {
    pushUnique(readablePaths, asset.entryAbsolutePath ?? asset.absolutePath)
  }

  const relevantKnowledgeContext = buildMatOSKnowledgeContext({
    registry,
    role,
    allowedTools,
    mountedAssetKeys: knowledgeAssets.map(asset => asset.canonicalKey),
    ...(options.taskText ? { taskText: options.taskText } : {}),
    providerOverrides:
      options.algorithmProviderScope?.providersFor('context-ranking'),
    assetSelectionProviderOverrides:
      options.algorithmProviderScope?.providersFor('asset-selection'),
    ...(options.projectCwd ? { cwd: options.projectCwd } : {}),
  })
  if (relevantKnowledgeContext) {
    appendSystemPrompt.push(relevantKnowledgeContext.prompt)
    for (const asset of relevantKnowledgeContext.assets) {
      pushUnique(readablePaths, asset.entryAbsolutePath ?? asset.absolutePath)
    }
  }

  const relevantExperienceContext = buildMatOSExperienceContext({
    registry,
    role,
    allowedTools,
    ...(options.taskText ? { taskText: options.taskText } : {}),
    providerOverrides:
      options.algorithmProviderScope?.providersFor('context-ranking'),
    assetSelectionProviderOverrides:
      options.algorithmProviderScope?.providersFor('asset-selection'),
    ...(options.projectCwd ? { cwd: options.projectCwd } : {}),
  })
  if (relevantExperienceContext) {
    appendSystemPrompt.push(relevantExperienceContext.prompt)
  }

  for (const skill of skillAssets) {
    pushUnique(skillNames, matOSSkillRuntimeName(skill.id))
  }

  const callableSkillNames: string[] = []
  for (const skill of skillRuntimeRefs) {
    pushUnique(callableSkillNames, matOSSkillRuntimeName(skill.id))
    pushUnique(skillDirs, skill.manifestDir)
  }

  for (const plugin of resolveMountedAssets(
    registry,
    role,
    'plugins',
    mountSkipHandler('plugins'),
  )) {
    pushUnique(pluginDirs, plugin.absolutePath)
  }

  for (const mcp of resolveMountedAssets(
    registry,
    role,
    'mcp',
    mountSkipHandler('mcp'),
  )) {
    pushUnique(mcpConfigPaths, mcp.entryAbsolutePath ?? mcp.absolutePath)
    for (const tool of mcpRuntimeToolNames(mcp)) {
      pushUnique(allowedTools, tool)
    }
  }

  // Tool, skill, workflow, builder, and delegation prompt sections describe
  // tool surfaces. When those surfaces are stripped from the runtime args
  // (no-tools / reply-only), the sections would only mislead the model and
  // waste context, so they are omitted entirely.
  if (includeToolSurfaces) {
    const toolPrompt = buildToolPrompt(toolMappings)
    if (toolPrompt) {
      appendSystemPrompt.push(toolPrompt)
    }
    const mountedWorkflowsPrompt = buildMountedWorkflowsPrompt(workflowAssets)
    if (mountedWorkflowsPrompt) {
      appendSystemPrompt.push(mountedWorkflowsPrompt)
    }
    const runtimeSkillsPrompt = buildRuntimeSkillsPrompt(
      options.projectCwd,
      callableSkillNames,
      skillAliases,
    )
    if (runtimeSkillsPrompt && skillAssets.length > 0) {
      appendSystemPrompt.push(runtimeSkillsPrompt)
    }
    if (assetDiscoveryToolsEnabled) {
      appendSystemPrompt.push(buildAssetDiscoveryPrompt())
    }
    if (!leanContext) {
      appendSystemPrompt.push(buildAssetBuilderToolsPrompt())
      appendSystemPrompt.push(buildRoleBuilderToolsPrompt())
    }
    if (workflowToolsEnabled) {
      appendSystemPrompt.push(buildWorkflowToolsPrompt())
    } else if (workflowFacadeToolsEnabled) {
      appendSystemPrompt.push(buildWorkflowFacadeToolsPrompt(workflowAssets.length > 0))
    }
  }
  return {
    role,
    rolePrompt,
    selectedAssets,
    appendSystemPrompt,
    skillDirs,
    pluginDirs,
    mcpConfigPaths,
    allowedTools,
    disallowedTools,
    readablePaths,
    assetToolDirs,
    skillNames,
    callableSkillNames,
    skillAliases,
    assetDiscoveryToolsEnabled,
    workflowFacadeToolsEnabled,
    workflowToolsEnabled,
    mountedWorkflowRefs,
    relevantKnowledge: relevantKnowledgeContext?.assets ?? [],
    relevantExperiences: relevantExperienceContext?.assets ?? [],
    skippedReferences,
  }
}

function delegableRoleAssets(
  registry: MatOSAssetRegistry,
  selectedRole: MatOSAsset,
): MatOSAsset[] {
  const roles = new Map<string, MatOSAsset>()
  roles.set(selectedRole.id, selectedRole)
  for (const reference of mountRefs(selectedRole, 'roles')) {
    if (!reference.includes(':')) {
      continue
    }
    const role = registry.resolve(reference)
    if (role?.type === 'role') {
      roles.set(role.id, role)
    }
  }
  return [...roles.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function buildAgentPrompt(
  rolePrompt: string,
  appendSystemPrompt: string[],
): string {
  return [
    buildMatOSProductIdentityPrompt(),
    rolePrompt,
    ...appendSystemPrompt,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function hasDelegatedWorkflowTools(
  partsById: Map<string, RoleRuntimeParts>,
  selectedRole: MatOSAsset,
): boolean {
  for (const parts of partsById.values()) {
    if (
      parts.role.canonicalKey !== selectedRole.canonicalKey &&
      parts.workflowToolsEnabled
    ) {
      return true
    }
  }
  return false
}

function workflowToolModeForParts(parts: RoleRuntimeParts): WorkflowToolMode {
  if (parts.workflowToolsEnabled) {
    return 'full'
  }
  if (parts.workflowFacadeToolsEnabled) {
    return 'facade'
  }
  return 'none'
}

async function buildRolePartsById(
  registry: MatOSAssetRegistry,
  selectedRole: MatOSAsset,
  options: MatOSRuntimeCompositionOptions = {},
): Promise<Map<string, RoleRuntimeParts>> {
  const partsById = new Map<string, RoleRuntimeParts>()
  const selected = roleWithAdditionalAssets(
    registry,
    selectedRole,
    options.additionalAssetRefs ?? [],
  )
  const effectiveSelectedRole = selected.role
  const selectedOptions = selected.roots.length > 0
    ? { ...options, additionalAssetRefs: selected.roots }
    : options
  // Lean/no-tool-surface runs compose only the selected role: delegated role
  // agent definitions are the largest projection payload and focused
  // single-task runs do not delegate.
  const delegableRoles =
    options.contextProfile === 'lean' || options.includeToolSurfaces === false
      ? [effectiveSelectedRole]
      : delegableRoleAssets(registry, effectiveSelectedRole)
  // Collect per-role parts concurrently (prompt/skill reads are I/O bound and
  // independent), then insert in the original deterministic role order so the
  // projected agents object keeps a stable key order.
  const collected = await Promise.all(
    delegableRoles.map(agentRole =>
      collectRoleRuntimeParts(
        registry,
        agentRole,
        agentRole.canonicalKey === effectiveSelectedRole.canonicalKey
          ? selectedOptions
          : { ...options, additionalAssetRefs: [] },
      ),
    ),
  )
  for (const [index, agentRole] of delegableRoles.entries()) {
    const parts = collected[index]
    if (parts) {
      partsById.set(agentRole.id, parts)
    }
  }
  return partsById
}

export async function composeMatOSRoleRuntime(
  registry: MatOSAssetRegistry,
  roleReference: string,
  options: MatOSRuntimeCompositionOptions = {},
): Promise<MatOSRuntimeProjection> {
  const role = registry.resolve(roleReference)
  if (!role || role.type !== 'role') {
    throw new Error(`MatOS role asset not found: ${roleReference}`)
  }

  // Bind executable strategies to this exact registry. Baseline composition
  // does not execute them; a role/env must explicitly select a provider.
  const algorithmProviderScope = buildMatOSAssetExecProviderScope(registry)
  // Use the already scope-filtered registry winners, never parent-directory
  // scans in a Python catalog. Paths are materialized in the current runtime.
  const mlipModelManifests = registry.assets.filter(asset =>
    asset.type === 'data' && registry.resolve(asset.canonicalKey) === asset &&
    (asset.metadata.kind === 'mlip-model' || asset.tags.includes('mlip-model')),
  ).map(asset => asset.manifestPath).sort()
  const scopedOptions = { ...options, algorithmProviderScope }

  const partsById = await buildRolePartsById(registry, role, scopedOptions)
  const selectedParts = partsById.get(role.id)
  if (!selectedParts) {
    throw new Error(`MatOS role asset not found: ${roleReference}`)
  }

  // S4 tool-selection: strategies may reorder or narrow the selected role's
  // composed allowlist, never extend it (sanitize clamp) and never empty it.
  // The baseline returns the composed list unchanged.
  const selectedAllowedTools = decideMatOSToolSelection({
    roleRef: role.canonicalKey,
    allowedTools: selectedParts.allowedTools,
    disallowedTools: selectedParts.disallowedTools,
    role,
    providerOverrides: algorithmProviderScope.providersFor('tool-selection'),
    ...(options.projectCwd ? { cwd: options.projectCwd } : {}),
  }).decision.allowedTools
  const delegatedWorkflowToolsEnabled = hasDelegatedWorkflowTools(partsById, role)
  const selectedWorkflowToolMode = workflowToolModeForParts(selectedParts)
  const selectedMcpWorkflowToolsEnabled = selectedWorkflowToolMode !== 'none'
  const selectedAgentDisallowedTools = [...selectedParts.disallowedTools]
  const availableParts = [...partsById.values()]
  const delegatedSkillsPrompt = buildDelegatedSkillsPrompt(availableParts, role)
  const selectedDelegatedRolesPrompt = buildDelegatedRolesPrompt(
    role,
    availableParts,
  )
  if (delegatedWorkflowToolsEnabled && !selectedParts.workflowToolsEnabled) {
    for (const toolName of MATOS_WORKFLOW_SPECIALIST_TOOL_NAMES) {
      pushUnique(selectedAgentDisallowedTools, matOSAssetMcpToolName(toolName))
    }
  }
  const agents: Record<string, Record<string, unknown>> = {}
  for (const [roleId, parts] of partsById) {
    const isSelected = parts.role.canonicalKey === role.canonicalKey
    const delegatedRolesPrompt = buildDelegatedRolesPrompt(
      parts.role,
      availableParts,
    )
    const prompt = isSelected
      ? parts.rolePrompt
      : buildAgentPrompt(
          parts.rolePrompt,
          [
            buildRuntimeSafetyPrompt(),
            ...parts.appendSystemPrompt,
            ...(delegatedRolesPrompt ? [delegatedRolesPrompt] : []),
          ],
        )
    const mcpServers = isSelected
      ? []
      : [
          buildAssetToolMcpServerSpec(parts.assetToolDirs, {
            mlipModelManifests,
            projectCwd: options.projectCwd,
            ...(options.projectMemberId
              ? { projectMemberId: options.projectMemberId }
              : {}),
            selectedRoleRef: parts.role.canonicalKey,
            selectedAssetKeys: parts.selectedAssets.map(asset => asset.canonicalKey),
            pinnedAssetRefs: runtimePinnedAssetRefs(parts.selectedAssets, options.pinnedAssetRefs),
            enableAssetDiscoveryTools: parts.assetDiscoveryToolsEnabled,
            enableWorkflowTools:
              parts.workflowFacadeToolsEnabled || parts.workflowToolsEnabled,
            workflowToolMode: workflowToolModeForParts(parts),
            mountedWorkflowRefs: parts.mountedWorkflowRefs,
          }),
          ...(await buildInlineMcpServerSpecs(parts.mcpConfigPaths)),
        ]

    agents[roleId] = buildRoleAgentDefinition(
      parts.role,
      prompt,
      parts.allowedTools,
      isSelected ? selectedAgentDisallowedTools : parts.disallowedTools,
      parts.skillNames,
      mcpServers,
      isHiddenEvolutionJsonOnlyRole(parts.role),
      algorithmProviderScope,
      options.projectCwd,
    )
  }

  agents[role.id] = buildRoleAgentDefinition(
    role,
    buildAgentPrompt(selectedParts.rolePrompt, []),
    selectedAllowedTools,
    selectedAgentDisallowedTools,
    selectedParts.skillNames,
    [],
    isHiddenEvolutionJsonOnlyRole(role),
    algorithmProviderScope,
    options.projectCwd,
  )

  const allRoleSkillDirs = [
    ...new Set([...partsById.values()].flatMap(parts => parts.skillDirs)),
  ]
  return {
    selectedAgent: role.id,
    agents,
    appendSystemPrompt: [
      buildMatOSProductIdentityPrompt(),
      buildRuntimeSafetyPrompt(),
      ...selectedParts.appendSystemPrompt,
      ...(delegatedSkillsPrompt ? [delegatedSkillsPrompt] : []),
      ...(selectedDelegatedRolesPrompt ? [selectedDelegatedRolesPrompt] : []),
    ],
    skillDirs: allRoleSkillDirs,
    pluginDirs: selectedParts.pluginDirs,
    mcpConfigPaths: selectedParts.mcpConfigPaths,
    mcpConfigJson: [
      buildAssetToolMcpConfig(selectedParts.assetToolDirs, {
        mlipModelManifests,
        projectCwd: options.projectCwd,
        ...(options.projectMemberId
          ? { projectMemberId: options.projectMemberId }
          : {}),
        selectedRoleRef: role.canonicalKey,
        selectedAssetKeys: selectedParts.selectedAssets.map(asset => asset.canonicalKey),
        pinnedAssetRefs: runtimePinnedAssetRefs(selectedParts.selectedAssets, options.pinnedAssetRefs),
        enableAssetDiscoveryTools: selectedParts.assetDiscoveryToolsEnabled,
        enableWorkflowTools: selectedMcpWorkflowToolsEnabled,
        workflowToolMode: selectedWorkflowToolMode,
        mountedWorkflowRefs: selectedParts.mountedWorkflowRefs,
      }),
    ],
    allowedTools: selectedAllowedTools,
    disallowedTools: selectedParts.disallowedTools,
    readablePaths: selectedParts.readablePaths,
    assetToolDirs: selectedParts.assetToolDirs,
    mountedWorkflowRefs: selectedParts.mountedWorkflowRefs,
    assetEvents: [
      ...selectedParts.selectedAssets.map(asset => ({
        type: 'selected' as const,
        assetKey: asset.canonicalKey,
      })),
      ...selectedParts.relevantExperiences.map(asset => ({
        type: 'projected' as const,
        assetKey: asset.canonicalKey,
        reason: 'relevant-experience',
      })),
      ...selectedParts.relevantKnowledge.map(asset => ({
        type: 'projected' as const,
        assetKey: asset.canonicalKey,
        reason: 'relevant-knowledge',
      })),
      ...selectedParts.skippedReferences.map(skipped => ({
        type: 'skipped' as const,
        assetKey: skipped.reference,
        reason: skipped.reason,
      })),
    ],
  }
}
