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

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  callMatOSTool,
  loadMatOSToolDefinitions,
  type MatOSToolCallResult,
  type MatOSToolDefinition,
  type MatOSToolInputSchema,
} from './matosToolRunner.js'
// Tool factories are imported lazily inside loadServerTools: their combined
// module trees (workflow runtime, asset builders) dominate this server's
// startup, and the parent CLI blocks on MCP initialize before its first
// model call. Types are import-type only and free at runtime.
import type { MatOSAssetDiscoveryTool } from './assetDiscoveryTools.js'
import type { MatOSAssetBuilderTool } from './assetBuilderTools.js'
import type { MatOSWorkflowTool } from '../workflows/tools/workflowTools.js'
import type { MatOSRoleBuilderTool } from './roleBuilderTools.js'
import { MATOS_NATIVE_SESSION_META_KEY, MATOS_WORKFLOW_FACADE_TOOL_NAMES } from './toolNames.js'
import { assertMatOSProjectToolInputAllowed } from '../runtime/projectAccess.js'
import { MatOSRuntimeToolPolicyError, refreshMatOSRuntimeToolDirectory } from '../assets/sourceAdapters.js'
import { validateValueAgainstJsonSchema } from '../workflows/outputContract.js'
import { recordMatOSTraceEventFromEnv } from '../sessions/traceBridge.js'

export type WorkflowToolMode = 'none' | 'facade' | 'full'

export type ServerTool = {
  name: string
  description: string
  inputSchema: MatOSToolInputSchema
  call: (input: unknown, context?: { sessionId?: string }) => Promise<{
    text: string
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

export type LoadServerToolsInput = {
  enableAssetDiscoveryTools: boolean
  workflowToolMode: WorkflowToolMode
  toolDirs?: string[]
  reportExternalToolDiagnostic?: (diagnostic: string) => void
  /** Internal completeness signal; partial loads must never populate the TTL cache. */
  onIncompleteLoad?: () => void
}

function readToolDirs(): string[] {
  const raw = process.env.MATOS_TOOL_ASSET_DIRS
  if (!raw) {
    return []
  }
  // A malformed value must degrade to "no external tool dirs", not throw and
  // take down every tools/list and tools/call on the asset MCP server.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

// DSH only accepts a small JSON-Schema subset for model-facing MCP tools.
// Keep rich MatOS validation in callMatOSTool and project only the advertised
// schema so unsupported constraints cannot disable every DSH turn.
const DSH_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])
function projectDshSchema(value: unknown, root = false): MatOSToolInputSchema {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    if (!DSH_SCHEMA_KEYS.has(key)) continue
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      result.properties = Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([name, schema]) => [name, projectDshSchema(schema)]))
    } else if (key === 'items') result.items = projectDshSchema(child)
    else if (key === 'oneOf' && Array.isArray(child)) result.oneOf = child.map(schema => projectDshSchema(schema))
    else result[key] = child
  }
  // DSH requires every schema node to carry a primitive/object type and does
  // not support unconstrained JSON-schema unions. Keep the rich native schema
  // for call-time validation, but advertise the narrowest safe model-facing
  // approximation so one malformed optional field cannot abort tools/list.
  if (root) result.type = 'object'
  if (typeof result.type !== 'string') {
    const alternatives = Array.isArray(result.oneOf) ? result.oneOf : []
    const types = alternatives.map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).type : undefined).filter((item): item is string => typeof item === 'string')
    delete result.oneOf
    result.type = types.length > 0 && types.every(type => type === types[0]) ? types[0] : 'string'
  }
  return result as MatOSToolInputSchema
}
function toolDescription(tool: MatOSToolDefinition): string {
  return [tool.description, tool.prompt?.trim()]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
}

export function isStructuredToolPayloadError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return (value as Record<string, unknown>).ok === false
}

function readProjectCwd(): string {
  return process.env.MATOS_PROJECT_CWD || process.cwd()
}

function readAssetCwd(): string {
  return process.env.MATOS_ASSETS_CWD || readProjectCwd()
}

function readSelectedAssetKeys(): string[] {
  const raw = process.env.MATOS_SELECTED_ASSET_KEYS
  if (!raw) {
    return []
  }
  // Tolerate a malformed value: a bad env var must not throw out of every
  // asset-builder/role-builder tool factory during loadServerTools.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

function readJsonStringArrayEnv(name: string): string[] {
  const raw = process.env[name]
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
  } catch {
    return raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  }
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) {
    return defaultValue
  }
  return raw === '1' || raw.toLowerCase() === 'true'
}

export function workflowToolModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): WorkflowToolMode {
  const explicit = env.MATOS_WORKFLOW_TOOL_MODE?.trim().toLowerCase()
  if (explicit === 'none' || explicit === 'facade' || explicit === 'full') {
    return explicit
  }

  const legacyEnabled = env.MATOS_ENABLE_WORKFLOW_TOOLS
  if (legacyEnabled !== undefined) {
    return legacyEnabled === '1' || legacyEnabled.toLowerCase() === 'true'
      ? 'full'
      : 'none'
  }
  return 'full'
}

function workflowAccessModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): 'unrestricted' | 'role-mounted' | undefined {
  const explicit = env.MATOS_WORKFLOW_ACCESS_MODE?.trim().toLowerCase()
  if (explicit === 'unrestricted' || explicit === 'role-mounted') {
    return explicit
  }
  return undefined
}

export function filterWorkflowToolsForMode(
  tools: MatOSWorkflowTool[],
  mode: WorkflowToolMode,
): MatOSWorkflowTool[] {
  if (mode === 'none') {
    return []
  }
  if (mode === 'full') {
    return tools
  }
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
  return MATOS_WORKFLOW_FACADE_TOOL_NAMES.map(name => toolsByName.get(name)).filter(
    (tool): tool is MatOSWorkflowTool => Boolean(tool),
  )
}

function assertToolUpdateAllowed(current: MatOSToolDefinition | undefined, authorized: MatOSToolDefinition): asserts current is MatOSToolDefinition {
  if (!current || current.id !== authorized.id || current.mcpName !== authorized.mcpName) {
    throw new Error('Tool binding changed; refresh the role before using it')
  }
  if ((current.isDestructive && !authorized.isDestructive) || (!current.isReadOnly && authorized.isReadOnly)) {
    throw new Error('Tool permissions changed; refresh the role before using the new version')
  }
}

function externalToolToServerTool(tool: MatOSToolDefinition, authorized = tool): ServerTool {
  return {
    name: tool.mcpName,
    description: toolDescription(tool),
    inputSchema: tool.inputSchema,
    async call(input) {
      // callMatOSTool rejects when the tool process cannot even start (e.g. a
      // missing runtime binary emits spawn ENOENT). The ServerTool contract is
      // "return an error result", so a broken external tool asset reports a
      // tool error instead of rejecting the whole MCP tools/call handler.
      let result: MatOSToolCallResult
      try {
        const pinned = readJsonStringArrayEnv('MATOS_PINNED_ASSET_REFS').some(ref => ref.replace(/@[^@]+$/, '') === `tool:${tool.id}`)
        const directory = pinned ? tool.dir : await refreshMatOSRuntimeToolDirectory(readProjectCwd(), tool.dir)
        const current = directory === tool.dir ? tool : (await loadMatOSToolDefinitions([directory])).find(definition => definition.id === tool.id)
        assertToolUpdateAllowed(current, authorized)
        if (directory !== tool.dir) {
          const validation = validateValueAgainstJsonSchema(input ?? {}, current.inputSchema)
          if (!validation.ok) return { text: `Tool ${tool.mcpName} was updated. Input must match the current schema: ${JSON.stringify(current.inputSchema)}`, isError: true }
        }
        const acceptedCommit = directory.match(/\/\.runtime-snapshots\/[^/]+\/([a-f0-9]{40,64})\/tree(?:\/|$)/)?.[1]
        if (acceptedCommit) {
          const manifest = JSON.parse(await readFile(join(directory, 'asset.json'), 'utf8')) as { version?: string }
          await recordMatOSTraceEventFromEnv({
            type: 'matos.asset.used',
            data: { source: 'matos.tool.accepted-runtime', action: 'execute', assetKey: `tool:${current.id}@${manifest.version}`, acceptedCommit, refreshed: directory !== tool.dir },
          }).catch(() => undefined)
        }
        // Never retry execution: a tool may already have produced side effects.
        result = await callMatOSTool(current, input ?? {})
      } catch (error) {
        return {
          text: `MatOS tool "${tool.mcpName}" failed to run: ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        }
      }
      let structuredContent: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(result.stdout || '{}') as unknown
        structuredContent =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
      } catch {
        structuredContent = undefined
      }
      return {
        text: result.stdout || result.stderr,
        structuredContent,
        isError:
          result.exitCode !== 0 || isStructuredToolPayloadError(structuredContent),
      }
    },
  }
}

function externalToolFailureCode(error: unknown): string {
  if (error instanceof SyntaxError) {
    return 'invalid-json'
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') return 'missing-file'
    if (code === 'EACCES' || code === 'EPERM') return 'permission-denied'
  }
  return 'invalid-definition'
}

function safeExternalToolId(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/iu.test(value) ||
    /(?:api[_-]?key|auth|credential|password|private|secret|token)/iu.test(value)
  ) {
    return undefined
  }
  return value
}

async function externalToolDiagnosticLabel(toolDir: string): Promise<string> {
  for (const manifestName of ['asset.json', 'matos.tool.json']) {
    try {
      const manifest = JSON.parse(
        await readFile(join(toolDir, manifestName), 'utf8'),
      ) as Record<string, unknown>
      const id = safeExternalToolId(manifest.id)
      if (id) return id
    } catch {
      // Loading the asset already failed. Diagnostics intentionally avoid raw
      // parser/filesystem messages because they may contain host paths or
      // secret-bearing filenames.
    }
  }
  return 'unidentified-external-tool'
}

async function loadExternalServerTools(
  toolDirs: string[],
  reportDiagnostic: (diagnostic: string) => void,
  onIncompleteLoad?: () => void,
): Promise<ServerTool[]> {
  const definitions: Array<{ current: MatOSToolDefinition; authorized: MatOSToolDefinition }> = []
  const snapshots = new Map<string, Promise<{ root: string; commit: string }>>()
  const registries = new Map<string, Promise<import('../assets/registry.js').MatOSAssetRegistry>>()
  for (const toolDir of toolDirs) {
    try {
      const pinned = readJsonStringArrayEnv('MATOS_PINNED_ASSET_REFS')
      const original = await loadMatOSToolDefinitions([toolDir])
      const keepPinned = original.some(tool => pinned.some(ref => ref.replace(/@[^@]+$/, '') === `tool:${tool.id}`))
      let currentDir: string
      try {
        currentDir = keepPinned ? toolDir : await refreshMatOSRuntimeToolDirectory(readProjectCwd(), toolDir, snapshots, registries)
      } catch (error) {
        if (error instanceof MatOSRuntimeToolPolicyError) throw error
        // A transient registry/filesystem failure must not erase an already
        // mounted tool from the model's catalog. This is NOT an execution
        // fallback: externalToolToServerTool rechecks the accepted source on
        // call and returns its error without starting a tool if still broken.
        onIncompleteLoad?.()
        reportDiagnostic(`[matos_asset] external tool "${await externalToolDiagnosticLabel(toolDir)}" update unavailable (${externalToolFailureCode(error)}); execution will recheck its accepted source`)
        definitions.push(...original.map(authorized => ({ current: authorized, authorized })))
        continue
      }
      const updated = currentDir === toolDir ? original : await loadMatOSToolDefinitions([currentDir])
      const allowed = original.map(authorized => {
        const current = updated.find(tool => tool.id === authorized.id)
        assertToolUpdateAllowed(current, authorized)
        return { current, authorized }
      })
      definitions.push(...allowed)
    } catch (error) {
      onIncompleteLoad?.()
      const label = await externalToolDiagnosticLabel(toolDir)
      reportDiagnostic(
        `[matos_asset] skipped invalid external tool "${label}" (${externalToolFailureCode(error)}); run "matos assets validate" for details`,
      )
    }
  }
  return definitions
    .sort((a, b) => a.current.id.localeCompare(b.current.id))
    .map(({ current, authorized }) => externalToolToServerTool(current, authorized))
}

function discoveryToolToServerTool(tool: MatOSAssetDiscoveryTool): ServerTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    call: tool.call,
  }
}

function assetBuilderToolToServerTool(tool: MatOSAssetBuilderTool): ServerTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    call: tool.call,
  }
}

function workflowToolToServerTool(tool: MatOSWorkflowTool): ServerTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    call: tool.call,
  }
}

function roleBuilderToolToServerTool(tool: MatOSRoleBuilderTool): ServerTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    call: tool.call,
  }
}

export async function loadServerTools(
  input: LoadServerToolsInput,
): Promise<ServerTool[]> {
  // Load tool factories and external definitions concurrently; workflow tools
  // (the heaviest tree) are skipped entirely when the composed role disables
  // them.
  const [
    externalTools,
    discoveryToolsModule,
    assetBuilderToolsModule,
    workflowToolsModule,
    roleBuilderToolsModule,
  ] = await Promise.all([
    loadExternalServerTools(
      input.toolDirs ?? readToolDirs(),
      input.reportExternalToolDiagnostic ??
        (diagnostic => console.error(diagnostic)),
      input.onIncompleteLoad,
    ),
    input.enableAssetDiscoveryTools
      ? import('./assetDiscoveryTools.js')
      : undefined,
    import('./assetBuilderTools.js'),
    input.workflowToolMode !== 'none'
      ? import('../workflows/tools/workflowTools.js')
      : undefined,
    import('./roleBuilderTools.js'),
  ])
  return [
    ...(discoveryToolsModule
      ? discoveryToolsModule
          .createMatOSAssetDiscoveryTools({
            cwd: readProjectCwd(),
            assetCwd: process.env.MATOS_ASSETS_CWD,
            selectedRole: process.env.MATOS_SELECTED_ROLE_REF,
            selectedAssetKeys: readSelectedAssetKeys(),
          })
          .map(discoveryToolToServerTool)
      : []),
    ...assetBuilderToolsModule
      .createMatOSAssetBuilderTools({
        cwd: readProjectCwd(),
        assetCwd: readAssetCwd(),
        selectedRole: process.env.MATOS_SELECTED_ROLE_REF,
        selectedAssetKeys: readSelectedAssetKeys(),
      })
      .map(assetBuilderToolToServerTool),
    ...(workflowToolsModule
      ? filterWorkflowToolsForMode(
          workflowToolsModule.createMatOSWorkflowTools({
            cwd: readProjectCwd(),
            selectedRole: process.env.MATOS_SELECTED_ROLE_REF,
            workflowAccessMode: workflowAccessModeFromEnv(),
            workflowStartPolicy:
              process.env.MATOS_AUTOMAT_PROMPT_MODE === 'workflow' &&
              process.env.MATOS_AUTOMAT_TRACKED_WORKFLOW !== '1'
                ? 'tracked-cli-only'
                : 'normal',
            allowedWorkflowRefs: readJsonStringArrayEnv(
              'MATOS_ALLOWED_WORKFLOW_REFS',
            ),
          }),
          input.workflowToolMode,
        ).map(workflowToolToServerTool)
      : []),
    ...roleBuilderToolsModule
      .createMatOSRoleBuilderTools({
        cwd: readAssetCwd(),
        projectCwd: readProjectCwd(),
        selectedRole: process.env.MATOS_SELECTED_ROLE_REF,
        selectedAssetKeys: readSelectedAssetKeys(),
        projectId: process.env.MATOS_PROJECT_ID,
        projectMemberId: process.env.MATOS_PROJECT_MEMBER_ID,
        env: process.env,
      })
      .map(roleBuilderToolToServerTool),
    ...externalTools,
  ]
}

// Every tools/list AND tools/call reloaded the full tool set: tool-dir
// scans, prompt/schema file reads, and tool-factory rebuilds. A short TTL
// cache collapses that per-call cost while preserving the dynamic-assets
// policy — edited or newly added tool assets still become visible without
// restarting the server, one TTL later. MATOS_ASSET_MCP_TOOL_CACHE_MS
// overrides the default; 0 disables caching.
const DEFAULT_SERVER_TOOL_CACHE_MS = 5000

type CachedServerTools = {
  key: string
  tools: Promise<ServerTool[]>
  loadedAt: number
  pending: boolean
}

let cachedServerTools: CachedServerTools | undefined

function serverToolCacheMs(): number {
  const parsed = Number(process.env.MATOS_ASSET_MCP_TOOL_CACHE_MS)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SERVER_TOOL_CACHE_MS
}

function serverToolsCacheKey(input: LoadServerToolsInput): string {
  return JSON.stringify([
    input.enableAssetDiscoveryTools,
    input.workflowToolMode,
    input.toolDirs ?? readToolDirs(),
    process.env.MATOS_SELECTED_ROLE_REF,
    process.env.MATOS_SELECTED_ASSET_KEYS,
    process.env.MATOS_PINNED_ASSET_REFS,
    process.env.MATOS_PROJECT_CWD,
    process.env.MATOS_ASSETS_CWD,
    process.env.MATOS_PROJECT_ID,
    process.env.MATOS_PROJECT_MEMBER_ID,
    process.env.MATOS_WORKFLOW_ACCESS_MODE,
    process.env.MATOS_ALLOWED_WORKFLOW_REFS,
    process.env.MATOS_AUTOMAT_PROMPT_MODE,
    process.env.MATOS_AUTOMAT_TRACKED_WORKFLOW,
  ])
}

export function resetServerToolsCacheForTest(): void {
  cachedServerTools = undefined
}

export function loadServerToolsCached(
  input: LoadServerToolsInput,
): Promise<ServerTool[]> {
  const ttlMs = serverToolCacheMs()
  if (ttlMs <= 0) {
    return loadServerTools(input)
  }
  const key = serverToolsCacheKey(input)
  const now = Date.now()
  if (
    cachedServerTools &&
    cachedServerTools.key === key &&
    (cachedServerTools.pending || now - cachedServerTools.loadedAt < ttlMs)
  ) {
    return cachedServerTools.tools
  }
  let incomplete = false
  const tools = loadServerTools({ ...input, onIncompleteLoad: () => { incomplete = true; input.onIncompleteLoad?.() } })
  const entry: CachedServerTools = { key, tools, loadedAt: now, pending: true }
  cachedServerTools = entry
  void tools.then(() => {
    entry.pending = false
    entry.loadedAt = Date.now()
    if (incomplete && cachedServerTools === entry) cachedServerTools = undefined
  }, () => undefined)
  // A failed load must not stick for the TTL.
  tools.catch(() => {
    if (cachedServerTools === entry) {
      cachedServerTools = undefined
    }
  })
  return tools
}

export async function runMatOSToolMcpServer(): Promise<void> {
  const enableAssetDiscoveryTools = envFlag('MATOS_ENABLE_ASSET_DISCOVERY_TOOLS', true)
  const workflowToolMode = workflowToolModeFromEnv()
  const server = new Server(
    { name: 'matos-asset-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      const tools = await loadServerToolsCached({
        enableAssetDiscoveryTools,
        workflowToolMode,
      })
      return {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: projectDshSchema(tool.inputSchema, true),
        })),
      }
    },
  )

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const tools = await loadServerToolsCached({
        enableAssetDiscoveryTools,
        workflowToolMode,
      })
      const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
      const tool = toolsByName.get(request.params.name)
      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: `Unknown MatOS tool asset: ${request.params.name}`,
            },
          ],
          isError: true,
        }
      }

      try {
        assertMatOSProjectToolInputAllowed(request.params.arguments ?? {})
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        }
      }

      const sessionId = request.params._meta?.[MATOS_NATIVE_SESSION_META_KEY]
      const result = await tool.call(request.params.arguments ?? {}, {
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      })
      return {
        content: [
          {
            type: 'text',
            text: result.text,
          },
        ],
        ...(result.structuredContent
          ? { structuredContent: result.structuredContent }
          : {}),
        isError: result.isError === true,
      }
    },
  )

  await server.connect(new StdioServerTransport())
}

if (import.meta.main) {
  await runMatOSToolMcpServer()
}
