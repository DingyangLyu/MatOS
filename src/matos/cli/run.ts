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

import { assertMatOSRoleUserInvocable } from '../assets/roleInvocationPolicy.js'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matOSAssetRevisionTrace, type MatOSProjectedAssetTrace } from '../sessions/assetRevisionTrace.js'
import {
  loadMatOSAssets,
  loadMatOSAssetsFromRoot,
} from '../assets/loadAssets.js'
import {
  projectMatOSRoleToRuntime,
  type MatOSRuntimeContextProfile,
  type MatOSRuntimeProjection,
} from '../assets/projectRuntime.js'
import {
  cleanupMatOSRuntimeMaterialization,
  getMatOSRuntimeMaterializationRoot,
  materializeMatOSRuntime,
} from '../assets/runtimeMaterialization.js'
import { renderMatOSAssetContext } from '../assets/renderAssetContext.js'
import {
  buildMatOSAssetRegistry,
  getMatOSAssetSubgraph,
  resolveMatOSRoleReference,
} from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'
import type { MatOSEventInput } from '../sessions/eventTypes.js'
import { classifyMatOSToolErrorKind } from '../learning/toolErrorKind.js'
import {
  redactTraceValue,
  scrubSecretsFromString,
} from '../sessions/traceContext.js'
import {
  getMatOSBundledAssetRootCandidates,
  getMatOSDir,
  readMatOSProjectConfig,
} from '../project.js'
import { findMatOSProjectRoot, readMatOSProjectMetadata } from '../projectMetadata.js'
import { matOSRunAssetRefs } from '../projectAssets.js'
import { acquireMatOSProjectWriteLock } from '../runtime/projectWriteLock.js'
import {
  applyMatOSProjectAccessPolicyArgs,
  matOSProjectRoleRefs,
  renderMatOSProjectAccessPrompt,
  type MatOSProjectAccessPolicy,
} from '../runtime/projectAccess.js'
import {
  buildAgentArgsForMatOS,
  buildAgentArgsForMatOSRun,
} from './args.js'

type MatOSRunIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  workflowCommand?: (
    args: string[],
    io: { cwd: string; stdout: (text: string) => void; stderr: (text: string) => void },
  ) => Promise<number>
}

type SDKMessage = Record<string, unknown>

function enforceProjectMemberDelegationBoundary(
  projection: MatOSRuntimeProjection,
  policy: MatOSProjectAccessPolicy,
): void {
  const selectedAgent = projection.selectedAgent
  if (selectedAgent && projection.agents[selectedAgent]) {
    projection.agents = {
      [selectedAgent]: projection.agents[selectedAgent],
    }
  }
  projection.appendSystemPrompt.push(
    [
      'Project member delegation boundary:',
      `- Agent-tool helpers inherit the current member identity (${policy.memberId}) and must not impersonate another project member.`,
      '- Delegate to another mounted MatOS role through mcp__matos_asset__role_run, which starts an independent role process and applies that member\'s own project filesystem policy.',
    ].join('\n'),
  )
}

type SDKEventMappingOptions = {
  turnId?: string
  roleRef?: string
  includeToolLifecycle?: boolean
  includeToolProgress?: boolean
  selectedAssetRefs?: string[]
  projectedAssets?: MatOSProjectedAssetTrace[]
  // Shared across the messages of one SDK stream so tool_result (user) events
  // can recover the toolName recorded on the preceding tool_use (assistant)
  // block. Without it, matos.tool.call.completed carried no toolName, which
  // disabled the agent-repeated-action trigger and collapsed every tool into a
  // single tool-failure cooldown family.
  toolNameById?: Map<string, string>
}

export type ParsedMatOSRunArgs = {
  prompt: string | undefined
  role: string | undefined
  additionalAssetRefs?: string[]
  execution: 'local' | 'container' | undefined
  containerMode?: 'persistent' | 'ephemeral'
  runtime: string | undefined
  scope: string | undefined
  passthroughArgs: string[]
  noTools?: boolean
  replyOnly?: boolean
  contextProfile?: MatOSRuntimeContextProfile
  help?: boolean
  error?: string
}

export type MatOSRunInvocation = {
  prompt: string
  roleReference: string | undefined
  execution: 'local' | 'container'
  containerMode?: 'persistent' | 'ephemeral'
  runtimeReference: string | undefined
  scopeReference: string | undefined
  passthroughArgs: string[]
  assets: MatOSAsset[]
  selectedAssetKeys: string[]
  projection: MatOSRuntimeProjection | undefined
  materializationDirs: string[]
  cliArgFiles?: string[]
  agentArgs: string[]
  projectAccess?: MatOSProjectAccessPolicy
}

export type MatOSRunInvocationOptions = {
  projectAccessMode?: 'enforce' | 'internal-hidden'
  /**
   * Current user task text for task-conditioned knowledge/experience context
   * ranking. `matos run` fills this from the parsed prompt automatically;
   * other launch paths may pass the first user message when known.
   */
  taskText?: string
  /** Runtime context profile override; defaults to full or MATOS_CONTEXT_PROFILE. */
  contextProfile?: MatOSRuntimeContextProfile
  /** Extra scoped assets selected by a project/user for this invocation. */
  additionalAssetRefs?: string[]
}

export type MatOSRoleLaunchInvocation = {
  roleReference: string
  assets: MatOSAsset[]
  selectedAssetKeys: string[]
  projection: MatOSRuntimeProjection
  materializationDirs: string[]
  cliArgFiles?: string[]
  agentArgs: string[]
  projectAccess?: MatOSProjectAccessPolicy
}


export function matOSInvocationAssetTrace(
  invocation: {
    selectedAssetKeys: string[]
    assets?: MatOSAsset[]
    projection?: Pick<MatOSRuntimeProjection, 'assetEvents'>
  },
): {
  selectedAssetRefs: string[]
  projectedAssets: MatOSProjectedAssetTrace[]
} {
  return {
    selectedAssetRefs: [...new Set(invocation.selectedAssetKeys)].slice(0, 200),
    projectedAssets: (invocation.projection?.assetEvents ?? [])
      .filter(event => event.type === 'projected')
      .map(event => ({
        assetRef: event.assetKey,
        ...matOSAssetRevisionTrace(invocation.assets?.find(asset => asset.canonicalKey === event.assetKey)),
        ...(event.reason ? { reason: event.reason } : {}),
      }))
      .slice(0, 100),
  }
}

export function matOSInvocationAssetTraceEnv(
  invocation: {
    selectedAssetKeys: string[]
    assets?: MatOSAsset[]
    projection?: Pick<MatOSRuntimeProjection, 'assetEvents'>
  },
): Record<string, string> {
  const trace = matOSInvocationAssetTrace(invocation)
  return {
    MATOS_SELECTED_ASSET_REFS: JSON.stringify(trace.selectedAssetRefs),
    MATOS_PROJECTED_ASSETS: JSON.stringify(trace.projectedAssets),
  }
}

// Per-run matos.asset.loaded trace events must stay bounded. Role runs select
// a small subgraph, but no-role and container-interactive launches enumerate
// every visible asset — ~2000 in a large workspace — which wrote
// thousands of near-identical JSONL rows per run and multiplied the
// per-append cost of session storage into multi-second run startup stalls.
// The bound matches the projectedAssets cap in matOSInvocationAssetTrace.
export const MATOS_ASSET_LOADED_EVENT_LIMIT = 100

export async function recordMatOSAssetLoadedEvents(input: {
  recorder: { record: (event: MatOSEventInput) => Promise<void> }
  assets: Array<
    Pick<MatOSAsset, 'id' | 'type' | 'name' | 'version' | 'canonicalKey'>
  >
  selectedAssetKeys: string[]
  roleReference?: string
}): Promise<void> {
  const selectedKeys = new Set(input.selectedAssetKeys)
  let recorded = 0
  let omitted = 0
  for (const asset of input.assets) {
    if (
      selectedKeys.size > 0 &&
      asset.canonicalKey &&
      !selectedKeys.has(asset.canonicalKey)
    ) {
      continue
    }
    if (recorded >= MATOS_ASSET_LOADED_EVENT_LIMIT) {
      omitted += 1
      continue
    }
    recorded += 1
    await input.recorder.record({
      type: 'matos.asset.loaded',
      data: {
        id: asset.id,
        type: asset.type,
        name: asset.name,
        version: asset.version,
        canonicalKey: asset.canonicalKey,
        role: input.roleReference,
      },
    })
  }
  if (omitted > 0) {
    await input.recorder.record({
      type: 'matos.asset.loaded',
      data: {
        id: 'truncated',
        type: 'asset-trace',
        name: 'Asset load trace truncated',
        role: input.roleReference,
        recordedAssetCount: recorded,
        omittedAssetCount: omitted,
      },
    })
  }
}

const HEADLESS_PASSTHROUGH_VALUE_OPTIONS = new Set([
  '--max-turns',
  '--model',
  '--fallback-model',
  '--max-budget-usd',
  '--task-budget',
  '--output-format',
  '--permission-mode',
  '--agent',
  '--effort',
  '--resume',
  '--session-id',
  '--agent-id',
  '--agent-name',
  '--team-name',
  '--allowed-tools',
  '--disallowed-tools',
  '--tools',
])

const HEADLESS_PASSTHROUGH_BOOLEAN_OPTIONS = new Set([
  '--verbose',
  '--bare',
  '--dangerously-skip-permissions',
])

function getAgentEntrypointPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MATOS_TEST_AGENT_ENTRYPOINT_PATH?.trim()
  if (override) {
    return override
  }
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'entrypoints',
    'agent.ts',
  )
}

function getMatOSBinDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin')
}

export function buildMatOSChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...extraEnv,
    MATOS_DISABLE_QUERYENGINE_TRACE_BRIDGE: '1',
    MATOS_DISABLE_CHILD_TURN_STARTED_TRACE: '1',
    PATH: [getMatOSBinDir(), env.PATH].filter(Boolean).join(':'),
  }
}

export function isHiddenMatOSRunEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.MATOS_INTERNAL_HIDDEN_RUN === '1'
}

function parseContextProfileValue(
  value: string | undefined,
): MatOSRuntimeContextProfile | undefined {
  return value === 'full' || value === 'lean' ? value : undefined
}

export function matOSContextProfileFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MatOSRuntimeContextProfile | undefined {
  return parseContextProfileValue(env.MATOS_CONTEXT_PROFILE?.trim().toLowerCase())
}

export function parseMatOSRunArgs(args: string[]): ParsedMatOSRunArgs {
  let prompt: string | undefined
  let role: string | undefined
  const additionalAssetRefs: string[] = []
  let execution: 'local' | 'container' | undefined
  let containerMode: 'persistent' | 'ephemeral' | undefined
  let runtime: string | undefined
  let scope: string | undefined
  let noTools = false
  let replyOnly = false
  let contextProfile: MatOSRuntimeContextProfile | undefined
  const passthroughArgs: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return {
        prompt,
        role,
        execution,
        ...(containerMode ? { containerMode } : {}),
        runtime,
        scope,
        passthroughArgs,
        ...(noTools ? { noTools } : {}),
        ...(replyOnly ? { replyOnly } : {}),
        ...(contextProfile ? { contextProfile } : {}),
        help: true,
      }
    }
    if (arg === '--no-tools') {
      noTools = true
      continue
    }
    if (arg === '--reply-only') {
      noTools = true
      replyOnly = true
      continue
    }
    if (arg === '--context-profile' || arg?.startsWith('--context-profile=')) {
      const value =
        arg === '--context-profile'
          ? args[(index += 1)]
          : arg.slice('--context-profile='.length)
      const parsedProfile = parseContextProfileValue(value)
      if (!parsedProfile) {
        return {
          prompt,
          role,
          execution,
          runtime,
          scope,
          passthroughArgs,
          ...(noTools ? { noTools } : {}),
          ...(replyOnly ? { replyOnly } : {}),
          error: 'Usage: matos run --context-profile full|lean "<task>"',
        }
      }
      contextProfile = parsedProfile
      continue
    }
    if (arg === '--role') {
      role = args[index + 1]
      index += 1
      continue
    }
    if (arg?.startsWith('--role=')) {
      role = arg.slice('--role='.length)
      continue
    }
    if (arg === '--asset' || arg?.startsWith('--asset=')) {
      const value =
        arg === '--asset'
          ? args[(index += 1)]
          : arg.slice('--asset='.length)
      if (!value || value.startsWith('-')) {
        return {
          prompt,
          role,
          execution,
          runtime,
          scope,
          passthroughArgs,
          error: 'Usage: matos run --role <role-ref> --asset <asset-ref> "<task>"',
        }
      }
      if (!additionalAssetRefs.includes(value)) {
        additionalAssetRefs.push(value)
      }
      continue
    }
    if (arg === '--execution') {
      const value = args[index + 1]
      if (value !== 'local' && value !== 'container') {
        return {
          prompt,
          role,
          execution,
          runtime,
          scope,
          passthroughArgs,
          ...(noTools ? { noTools } : {}),
          ...(replyOnly ? { replyOnly } : {}),
          error: 'Usage: matos run --execution local|container "<task>"',
        }
      }
      execution = value
      index += 1
      continue
    }
    if (arg?.startsWith('--execution=')) {
      const value = arg.slice('--execution='.length)
      if (value !== 'local' && value !== 'container') {
        return {
          prompt,
          role,
          execution,
          runtime,
          scope,
          passthroughArgs,
          ...(noTools ? { noTools } : {}),
          ...(replyOnly ? { replyOnly } : {}),
          error: 'Usage: matos run --execution local|container "<task>"',
        }
      }
      execution = value
      continue
    }
    if (arg === '--container-mode') {
      const value = args[index + 1]
      if (value !== 'persistent' && value !== 'ephemeral') {
        return {
          prompt,
          role,
          execution,
          runtime,
          scope,
          passthroughArgs,
          ...(noTools ? { noTools } : {}),
          ...(replyOnly ? { replyOnly } : {}),
          error: 'Usage: matos run --container-mode persistent|ephemeral "<task>"',
        }
      }
      containerMode = value
      index += 1
      continue
    }
    if (arg?.startsWith('--container-mode=')) {
      const value = arg.slice('--container-mode='.length)
      if (value !== 'persistent' && value !== 'ephemeral') {
        return {
          prompt,
          role,
          execution,
          runtime,
          scope,
          passthroughArgs,
          ...(noTools ? { noTools } : {}),
          ...(replyOnly ? { replyOnly } : {}),
          error: 'Usage: matos run --container-mode persistent|ephemeral "<task>"',
        }
      }
      containerMode = value
      continue
    }
    if (arg === '--runtime') {
      runtime = args[index + 1]
      index += 1
      continue
    }
    if (arg?.startsWith('--runtime=')) {
      runtime = arg.slice('--runtime='.length)
      continue
    }
    if (arg === '--scope') {
      scope = args[index + 1]
      index += 1
      continue
    }
    if (arg?.startsWith('--scope=')) {
      scope = arg.slice('--scope='.length)
      continue
    }
    if (prompt === undefined && HEADLESS_PASSTHROUGH_VALUE_OPTIONS.has(arg)) {
      passthroughArgs.push(arg)
      if (args[index + 1] !== undefined) {
        passthroughArgs.push(args[index + 1]!)
        index += 1
      }
      continue
    }
    if (
      prompt === undefined &&
      [...HEADLESS_PASSTHROUGH_VALUE_OPTIONS].some(option =>
        arg?.startsWith(`${option}=`),
      )
    ) {
      passthroughArgs.push(arg)
      continue
    }
    if (prompt === undefined && HEADLESS_PASSTHROUGH_BOOLEAN_OPTIONS.has(arg)) {
      passthroughArgs.push(arg)
      continue
    }
    if (prompt === undefined) {
      prompt = arg
      continue
    }
    if (arg !== undefined) {
      passthroughArgs.push(arg)
    }
  }

  return {
    prompt,
    role,
    ...(additionalAssetRefs.length > 0 ? { additionalAssetRefs } : {}),
    execution,
    ...(containerMode ? { containerMode } : {}),
    runtime,
    scope,
    passthroughArgs,
    ...(noTools ? { noTools } : {}),
    ...(replyOnly ? { replyOnly } : {}),
    ...(contextProfile ? { contextProfile } : {}),
  }
}

function printMatOSRunHelp(stdout: (text: string) => void): void {
  stdout(`Usage: matos run [--role <role-ref>] [--execution local|container] "<task>"

Options:
  --role <role-ref>              Compose the task through a MatOS role asset.
  --asset <asset-ref>            Add a scoped asset to the selected role for
                                 this run. Repeat to add multiple assets.
  --execution local|container    Run locally or through a MatOS runtime container.
  --container-mode <mode>        persistent or ephemeral container execution.
  --runtime <runtime-ref>        Runtime asset for container execution.
  --scope <scope-ref>            Runtime user/workspace scope for container execution.
  --no-tools                     Disable built-in, role, plugin, and MCP tools.
  --reply-only                   Disable tools and force a single-turn text reply.
  --context-profile full|lean    lean drops builder tools and delegated role
                                 definitions for focused single-task runs.
                                 Defaults to full or MATOS_CONTEXT_PROFILE.
  --max-turns <n>                Pass a headless turn limit to the agent runtime.
  --tools <tools>                Pass an explicit built-in tool set; use "" to disable.
  --resume <session-id>          Resume an existing MatOS session.
  --model <model>                Pass a model override to the agent runtime.
  -h, --help                     Show this help.
`)
}

async function materializeCliArgFile(
  cwd: string,
  label: string,
  content: string,
  extension = 'json',
): Promise<string> {
  const runtimeMaterializationDir = getMatOSRuntimeMaterializationRoot(cwd)
  const dir = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR?.trim()
    ? join(dirname(runtimeMaterializationDir), 'cli-args')
    : join(getMatOSDir(cwd), 'runtime', 'cli-args')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${label}-${randomUUID()}.${extension}`)
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
  return path
}

async function buildProjectionArgs(
  cwd: string,
  projection: MatOSRuntimeProjection,
  addDirs: string[] = [],
  options: { includeTools?: boolean } = {},
): Promise<{ args: string[]; cliArgFiles: string[] }> {
  const args: string[] = []
  const cliArgFiles: string[] = []
  const includeTools = options.includeTools !== false

  if (Object.keys(projection.agents).length > 0) {
    const agentsFile = await materializeCliArgFile(
      cwd,
      'agents',
      JSON.stringify(projection.agents),
    )
    cliArgFiles.push(agentsFile)
    args.push('--agents-file', agentsFile)
  }
  if (projection.selectedAgent) {
    args.push('--agent', projection.selectedAgent)
  }
  if (projection.appendSystemPrompt.length > 0) {
    const promptFile = await materializeCliArgFile(
      cwd,
      'append-system-prompt',
      projection.appendSystemPrompt.join('\n\n'),
      'md',
    )
    cliArgFiles.push(promptFile)
    args.push('--append-system-prompt-file', promptFile)
  }
  for (const addDir of addDirs) {
    args.push('--add-dir', addDir)
  }
  if (includeTools) {
    for (const pluginDir of projection.pluginDirs) {
      args.push('--plugin-dir', pluginDir)
    }
    const inlineMcpConfigs = await Promise.all(
      projection.mcpConfigJson.map(config =>
        materializeCliArgFile(cwd, 'mcp-config', config),
      ),
    )
    cliArgFiles.push(...inlineMcpConfigs)
    const mcpConfigs = [...projection.mcpConfigPaths, ...inlineMcpConfigs]
    if (mcpConfigs.length > 0) {
      args.push('--mcp-config', ...mcpConfigs)
    }
    if (projection.allowedTools.length > 0) {
      args.push('--allowed-tools', projection.allowedTools.join(','))
    }
    if (projection.disallowedTools.length > 0) {
      args.push('--disallowed-tools', projection.disallowedTools.join(','))
    }
  }

  return { args, cliArgFiles }
}

function hasHeadlessOption(args: string[], option: string): boolean {
  return args.some(arg => arg === option || arg.startsWith(`${option}=`))
}

function stripHeadlessOptions(
  args: string[],
  valueOptions: Set<string>,
  booleanOptions: Set<string>,
  // Options the underlying CLI declares as variadic (`<values...>`): the flag
  // consumes every following token up to the next `-`-prefixed one, so the
  // strip must swallow the same span. Removing only the first value would
  // leave the remaining values behind as orphan positional tokens and corrupt
  // downstream argument parsing.
  multiValueOptions: Set<string> = new Set<string>(),
): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) {
      continue
    }
    if (booleanOptions.has(arg)) {
      continue
    }
    if (multiValueOptions.has(arg)) {
      while (
        index + 1 < args.length &&
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith('-')
      ) {
        index += 1
      }
      continue
    }
    if (valueOptions.has(arg)) {
      index += 1
      continue
    }
    if (
      [...valueOptions, ...multiValueOptions].some(option =>
        arg.startsWith(`${option}=`),
      )
    ) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

function promptExplicitlyDisablesTools(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }
  const normalized = prompt.toLowerCase()
  return [
    '不要跑工具',
    '不要用工具',
    '不要调用工具',
    '不用工具',
    '别跑工具',
    '别用工具',
    '别调用工具',
    '不要执行工具',
    'do not use tools',
    "don't use tools",
    'no tools',
    'without tools',
  ].some(pattern => normalized.includes(pattern))
}

function promptRequestsSingleTextReply(prompt: string | undefined): boolean {
  if (!prompt) {
    return false
  }
  const normalized = prompt.toLowerCase()
  return [
    '只回复',
    '仅回复',
    '只需要回复',
    '收到即可',
    '回复收到',
    'reply only',
    'only reply',
    'respond only',
  ].some(pattern => normalized.includes(pattern))
}

function effectiveMatOSRunMode(
  parsed: Pick<ParsedMatOSRunArgs, 'prompt' | 'noTools' | 'replyOnly'>,
): { noTools: boolean; replyOnly: boolean } {
  const promptNoTools = promptExplicitlyDisablesTools(parsed.prompt)
  const noTools = parsed.noTools === true || parsed.replyOnly === true || promptNoTools
  const replyOnly =
    parsed.replyOnly === true ||
    (promptNoTools && promptRequestsSingleTextReply(parsed.prompt))
  return { noTools, replyOnly }
}

function effectiveMatOSRunPassthroughArgs(
  parsed: Pick<
    ParsedMatOSRunArgs,
    'prompt' | 'passthroughArgs' | 'noTools' | 'replyOnly'
  >,
): string[] {
  const mode = effectiveMatOSRunMode(parsed)
  if (!mode.noTools && !mode.replyOnly) {
    return parsed.passthroughArgs
  }

  const valueOptions = new Set(['--permission-mode'])
  // Declared variadic by the underlying CLI (`--tools <tools...>`,
  // `--allowed-tools <tools...>`, `--mcp-config <configs...>`).
  const multiValueOptions = new Set([
    '--tools',
    '--allowed-tools',
    '--mcp-config',
  ])
  if (mode.replyOnly) {
    valueOptions.add('--max-turns')
  }
  const passthroughArgs = stripHeadlessOptions(
    parsed.passthroughArgs,
    valueOptions,
    new Set(['--dangerously-skip-permissions']),
    multiValueOptions,
  )

  if (!hasHeadlessOption(passthroughArgs, '--bare')) {
    passthroughArgs.push('--bare')
  }
  passthroughArgs.push('--tools', '', '--permission-mode', 'dontAsk')
  if (mode.replyOnly) {
    passthroughArgs.push('--max-turns', '1')
  }
  return passthroughArgs
}

function formatValidationErrors(errors: Awaited<ReturnType<typeof validateMatOSAssets>>['errors']): string {
  return errors
    .map(error => `${error.code}: ${error.message} (${error.manifestPath})`)
    .join('\n')
}

function selectRoleRuntimeAssetsForValidation(
  assets: MatOSAsset[],
  registry: ReturnType<typeof buildMatOSAssetRegistry>,
  roleReference: string,
): {
  selectedAssets: MatOSAsset[]
  validationAssets: MatOSAsset[]
  roleReference: string
} {
  const roleResolution = resolveMatOSRoleReference(registry, roleReference)
  const effectiveRoleReference = roleResolution?.reference ?? roleReference
  const selectedAssets = roleResolution
    ? getMatOSAssetSubgraph(registry, effectiveRoleReference)
    : []
  if (selectedAssets.length === 0) {
    throw new Error(`MatOS role asset not found: ${roleReference}`)
  }

  const selectedKeys = new Set(
    selectedAssets
      .map(asset => asset.canonicalKey)
      .filter((key): key is string => Boolean(key)),
  )

  return {
    selectedAssets,
    validationAssets: assets.filter(
      asset => Boolean(asset.canonicalKey) && selectedKeys.has(asset.canonicalKey),
    ),
    roleReference: effectiveRoleReference,
  }
}

// Dangling references (a role or skill pointing at an asset that is not
// visible in the current scope's asset roots) are recoverable: runtime
// composition already skips unresolved workflow/skill/tool mounts, so the
// role still works minus the missing attachments. Hard-failing the whole run
// for one dangling workflow ref breaks user roles after partial
// asset syncs. Manifest
// corruption, missing entry files of present assets, and other structural
// errors stay fatal.
const DEGRADABLE_ASSET_VALIDATION_CODES = new Set([
  'missing_dependency',
  'missing_mount',
])

function strictRoleAssetValidation(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['strict', 'fail'].includes(
    String(env.MATOS_ROLE_ASSET_VALIDATION ?? '').trim().toLowerCase(),
  )
}

async function validateSelectedRoleRuntimeAssets(input: {
  assets: MatOSAsset[]
  registry: ReturnType<typeof buildMatOSAssetRegistry>
  roleReference: string
}): Promise<{ selectedAssets: MatOSAsset[]; roleReference: string }> {
  const { selectedAssets, validationAssets, roleReference } = selectRoleRuntimeAssetsForValidation(
    input.assets,
    input.registry,
    input.roleReference,
  )
  const acceptedRuntime = validationAssets.some(asset => asset.manifestPath.includes('/.runtime-snapshots/'))
  const validation = await validateMatOSAssets(validationAssets, { requireToolMounts: acceptedRuntime })
  if (!validation.ok) {
    const fatalErrors = validation.errors.filter(
      error => !DEGRADABLE_ASSET_VALIDATION_CODES.has(error.code),
    )
    if (fatalErrors.length > 0 || acceptedRuntime || strictRoleAssetValidation()) {
      throw new Error(`MatOS role assets are invalid:\n${formatValidationErrors(validation.errors)}`)
    }
    const degradableErrors = validation.errors.filter(error =>
      DEGRADABLE_ASSET_VALIDATION_CODES.has(error.code),
    )
    if (degradableErrors.length > 0) {
      console.error(
        `[MatOS] ${roleReference}: continuing with ${degradableErrors.length} unresolved asset reference(s); ` +
          'the affected workflows/skills/tools are skipped for this run ' +
          '(set MATOS_ROLE_ASSET_VALIDATION=strict to fail instead):\n' +
          formatValidationErrors(degradableErrors),
      )
    }
  }
  return { selectedAssets, roleReference }
}

function isMissingRoleAssetError(error: unknown, roleReference: string): boolean {
  return (
    error instanceof Error &&
    error.message === `MatOS role asset not found: ${roleReference}`
  )
}

async function loadMatOSRunAssets(
  projectCwd: string,
  options: Parameters<typeof loadMatOSAssets>[1] = {},
): Promise<MatOSAsset[]> {
  const projectAssets = await loadMatOSAssets(projectCwd, options)
  const scopeAssetsCwd = process.env.MATOS_ASSETS_CWD?.trim()
  if (!scopeAssetsCwd || resolve(scopeAssetsCwd) === resolve(projectCwd)) {
    return projectAssets
  }

  // Native project runs execute inside the project directory for correct
  // file/tool isolation, while user/team Gitea sources are registered in the
  // scope workspace selected by MATOS_ASSETS_CWD. Merge that scoped registry
  // view with project-local assets so a shared project can resolve the
  // recipient-owned asset forks without changing its execution cwd.
  const scopeAssets = await loadMatOSAssets(scopeAssetsCwd, options)
  const knownAssetIdentities = new Set(
    projectAssets.map(asset => asset.canonicalKey || resolve(asset.manifestPath)),
  )
  const mergedAssets = [...projectAssets]
  for (const asset of scopeAssets) {
    const identity = asset.canonicalKey || resolve(asset.manifestPath)
    if (knownAssetIdentities.has(identity)) continue
    knownAssetIdentities.add(identity)
    mergedAssets.push(asset)
  }
  return mergedAssets
}

async function resolveRoleRuntimeAssets(input: {
  assets: MatOSAsset[]
  roleReference: string
}): Promise<{
  assets: MatOSAsset[]
  registry: ReturnType<typeof buildMatOSAssetRegistry>
  selection: Awaited<ReturnType<typeof validateSelectedRoleRuntimeAssets>>
}> {
  const select = async (assets: MatOSAsset[]) => {
    const registry = buildMatOSAssetRegistry(assets)
    const selection = await validateSelectedRoleRuntimeAssets({
      assets,
      registry,
      roleReference: input.roleReference,
    })
    return { assets, registry, selection }
  }

  try {
    return await select(input.assets)
  } catch (error) {
    if (!isMissingRoleAssetError(error, input.roleReference)) {
      throw error
    }
  }

  // Accepted Git sources are materialized into a shared checkout that may be
  // replaced briefly by a concurrent refresh. Workspace containers also carry
  // a stable, per-user editable-core snapshot of the accepted assets. Consult
  // that trusted snapshot only when the primary registry cannot see the role.
  const recoveredAssets = [...input.assets]
  const knownAssets = new Set(
    recoveredAssets.map(asset => asset.canonicalKey || asset.manifestPath),
  )
  for (const root of getMatOSBundledAssetRootCandidates()) {
    let fallbackAssets: MatOSAsset[]
    try {
      fallbackAssets = await loadMatOSAssetsFromRoot(root)
    } catch {
      continue
    }
    for (const asset of fallbackAssets) {
      const identity = asset.canonicalKey || asset.manifestPath
      if (knownAssets.has(identity)) {
        continue
      }
      knownAssets.add(identity)
      recoveredAssets.push(asset)
    }
  }
  return select(recoveredAssets)
}

export function normalizeRoleReference(role: string): string {
  return role.includes(':') ? role : `role:${role}`
}

export async function buildMatOSRoleLaunchInvocation(
  role: string,
  cwd: string,
  passthroughArgs: string[] = [],
  options: MatOSRunInvocationOptions = {},
): Promise<MatOSRoleLaunchInvocation> {
  const projectCwd = await findMatOSProjectRoot(cwd) ?? cwd
  const projectMetadata = await readMatOSProjectMetadata(projectCwd, { allowMissing: true })
  const additionalAssetRefs = matOSRunAssetRefs(projectMetadata, options.additionalAssetRefs ?? [])
  const requestedRoleReference = normalizeRoleReference(role)
  const assets = await loadMatOSRunAssets(projectCwd, {
    runtimeSnapshot: options.projectAccessMode !== 'internal-hidden',
    followAcceptedUpdates: projectMetadata.assetVersionPolicy !== 'pinned',
  })
  const roleRuntime = await resolveRoleRuntimeAssets({
    assets,
    roleReference: requestedRoleReference,
  })
  const { registry } = roleRuntime
  const { roleReference } = roleRuntime.selection
  assertMatOSRoleUserInvocable(registry.resolve(roleReference), options.projectAccessMode === 'internal-hidden' || isHiddenMatOSRunEnv())
  // Hidden internal runners (self-evolution worker/critic/refiner/judge) are
  // not project members; enforcing project membership rejected every hidden
  // stage inside project directories with inherited MATOS_PROJECT_MEMBER_ID.
  const projectAccess = options.projectAccessMode === 'internal-hidden'
    ? { args: passthroughArgs }
    : await applyMatOSProjectAccessPolicyArgs({
        cwd,
        roleRef: roleReference,
        args: passthroughArgs,
        memberId: process.env.MATOS_PROJECT_MEMBER_ID,
      })
  const contextProfile = options.contextProfile ?? matOSContextProfileFromEnv()
  const projection = await projectMatOSRoleToRuntime(registry, roleReference, {
    projectCwd,
    pinnedAssetRefs: (options.additionalAssetRefs ?? []).filter(ref => ref.includes('@')),
    ...(projectAccess.policy
      ? { projectMemberId: projectAccess.policy.memberId }
      : {}),
    ...(options.taskText ? { taskText: options.taskText } : {}),
    ...(contextProfile ? { contextProfile } : {}),
    ...(additionalAssetRefs.length
      ? { additionalAssetRefs }
      : {}),
  })
  if (projectAccess.policy) {
    enforceProjectMemberDelegationBoundary(projection, projectAccess.policy)
    projection.appendSystemPrompt.push(renderMatOSProjectAccessPrompt(projectAccess.policy))
  }
  const materialized = await materializeMatOSRuntime(projectCwd, projection, {
    cache: true,
    cacheLabel: roleReference,
  })
  const { args: projectionArgs, cliArgFiles } = await buildProjectionArgs(
    projectCwd,
    projection,
    materialized.addDirs,
  )
  const agentArgs = buildAgentArgsForMatOS([
    ...projectionArgs,
    ...projectAccess.args,
  ])

  return {
    roleReference,
    assets: roleRuntime.assets,
    selectedAssetKeys: projection.assetEvents
      .filter(event => event.type !== 'skipped')
      .map(event => event.assetKey),
    projection,
    materializationDirs: materialized.addDirs,
    cliArgFiles,
    agentArgs,
    ...(projectAccess.policy ? { projectAccess: projectAccess.policy } : {}),
  }
}

export async function cleanupMatOSRunInvocationMaterialization(
  cwd: string,
  invocation: Pick<
    MatOSRunInvocation | MatOSRoleLaunchInvocation,
    'materializationDirs' | 'cliArgFiles'
  >,
): Promise<void> {
  await Promise.all(
    (invocation.cliArgFiles ?? []).map(async path => {
      try {
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }),
  )
  await cleanupMatOSRuntimeMaterialization(cwd, invocation.materializationDirs)
}

export async function buildMatOSRunInvocation(
  args: string[],
  cwd: string,
  options: MatOSRunInvocationOptions = {},
): Promise<MatOSRunInvocation> {
  const parsed = parseMatOSRunArgs(args)
  if (parsed.help) {
    throw new Error('MatOS run help requested')
  }
  if (parsed.error) {
    throw new Error(parsed.error)
  }
  if (!parsed.prompt) {
    throw new Error('Usage: matos run [--role <role-ref>] "<task>"')
  }

  const projectCwd = await findMatOSProjectRoot(cwd) ?? cwd
  const config = await readMatOSProjectConfig(projectCwd)
  const execution = parsed.execution ?? config.execution?.defaultMode ?? 'local'
  if (execution === 'container') {
    throw new Error('This MatOS edition runs agents locally only')
  }
  const runtimeReference = parsed.runtime
  const projectMetadata = await readMatOSProjectMetadata(projectCwd, { allowMissing: true })
  const assets = await loadMatOSRunAssets(projectCwd, {
    runtimeSnapshot: options.projectAccessMode !== 'internal-hidden',
    followAcceptedUpdates: projectMetadata.assetVersionPolicy !== 'pinned',
  })
  const runMode = effectiveMatOSRunMode(parsed)
  const passthroughArgs = effectiveMatOSRunPassthroughArgs(parsed)
  const includeRuntimeTools = !runMode.noTools && !runMode.replyOnly
  const projectDefaultRole = projectMetadata.id
    ? defaultProjectRoleRef(projectMetadata, [
        process.env.MATOS_WORKSPACE_ROLE_REF,
        process.env.MATOS_ROLE_REF,
      ])
    : undefined
  const selectedRole = parsed.role ?? projectDefaultRole

  if (!selectedRole && (parsed.additionalAssetRefs?.length ?? 0) > 0) {
    throw new Error('--asset requires --role or a project default role')
  }

  if (selectedRole) {
    const requestedRoleReference = normalizeRoleReference(selectedRole)
    const roleRuntime = await resolveRoleRuntimeAssets({
      assets,
      roleReference: requestedRoleReference,
    })
    const { registry } = roleRuntime
    const { roleReference, selectedAssets } = roleRuntime.selection
    assertMatOSRoleUserInvocable(registry.resolve(roleReference), options.projectAccessMode === 'internal-hidden' || isHiddenMatOSRunEnv())
    const contextProfile =
      parsed.contextProfile ??
      options.contextProfile ??
      matOSContextProfileFromEnv()
    const additionalAssetRefs = matOSRunAssetRefs(projectMetadata, [
      ...(options.additionalAssetRefs ?? []),
      ...(parsed.additionalAssetRefs ?? []),
    ])

    const projectAccess = options.projectAccessMode === 'internal-hidden'
      ? { args: passthroughArgs }
      : await applyMatOSProjectAccessPolicyArgs({
          cwd,
          roleRef: roleReference,
          args: passthroughArgs,
          memberId: process.env.MATOS_PROJECT_MEMBER_ID,
        })
    const rolePassthroughArgs = projectAccess.args

    const projection = await projectMatOSRoleToRuntime(registry, roleReference, {
      projectCwd,
      pinnedAssetRefs: [...(options.additionalAssetRefs ?? []), ...(parsed.additionalAssetRefs ?? [])].filter(ref => ref.includes('@')),
      ...(projectAccess.policy
        ? { projectMemberId: projectAccess.policy.memberId }
        : {}),
      taskText: parsed.prompt,
      ...(contextProfile ? { contextProfile } : {}),
      includeToolSurfaces: includeRuntimeTools,
      ...(additionalAssetRefs.length > 0 ? { additionalAssetRefs } : {}),
    })
    if (projectAccess.policy) {
      enforceProjectMemberDelegationBoundary(projection, projectAccess.policy)
      projection.appendSystemPrompt.push(renderMatOSProjectAccessPrompt(projectAccess.policy))
    }
    const materialized = await materializeMatOSRuntime(projectCwd, projection, {
      cache: true,
      cacheLabel: roleReference,
    })
    const { args: projectionArgs, cliArgFiles } = await buildProjectionArgs(
      projectCwd,
      projection,
      materialized.addDirs,
      { includeTools: includeRuntimeTools },
    )
    const agentArgs = buildAgentArgsForMatOSRun(parsed.prompt, [
      ...projectionArgs,
      ...rolePassthroughArgs,
    ])

    return {
      prompt: parsed.prompt,
      roleReference,
      execution,
      ...(parsed.containerMode ? { containerMode: parsed.containerMode } : {}),
      runtimeReference,
      scopeReference: parsed.scope,
      passthroughArgs: rolePassthroughArgs,
      assets: roleRuntime.assets,
      selectedAssetKeys: projection.assetEvents
        .filter(event => event.type !== 'skipped')
        .map(event => event.assetKey),
      projection,
      materializationDirs: materialized.addDirs,
      cliArgFiles,
      agentArgs,
      ...(projectAccess.policy ? { projectAccess: projectAccess.policy } : {}),
    }
  }

  const assetContext = renderMatOSAssetContext(assets)
  const assetContextFile = assetContext
    ? await materializeCliArgFile(cwd, 'append-system-prompt', assetContext, 'md')
    : undefined
  const assetContextArgs = assetContextFile
    ? ['--append-system-prompt-file', assetContextFile]
    : []
  const agentArgs = buildAgentArgsForMatOSRun(
    parsed.prompt,
    [...assetContextArgs, ...passthroughArgs],
  )

  return {
    prompt: parsed.prompt,
    roleReference: undefined,
    execution,
    ...(parsed.containerMode ? { containerMode: parsed.containerMode } : {}),
    runtimeReference,
    scopeReference: parsed.scope,
    passthroughArgs,
    assets,
    selectedAssetKeys: assets
      .map(asset => asset.canonicalKey)
      .filter((key): key is string => Boolean(key)),
    projection: undefined,
    materializationDirs: [],
    cliArgFiles: assetContextFile ? [assetContextFile] : [],
    agentArgs,
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function defaultProjectRoleRef(
  metadata: Record<string, unknown>,
  inheritedCandidates: Array<string | undefined>,
): string {
  const roles = matOSProjectRoleRefs(metadata)
  for (const candidate of inheritedCandidates) {
    const normalized = candidate?.trim()
    if (!normalized) continue
    if (roles.length === 0) return normalized
    const matched = roles.find(
      roleRef => roleRef.split('@')[0] === normalized.split('@')[0],
    )
    if (matched) return matched
  }
  return roles.find(roleRef => roleRef.split('@')[0] === 'role:compute') ??
    roles[0] ??
    'role:compute'
}

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function userIdFromScopeRef(scopeRef: string | undefined): string | undefined {
  return scopeRef?.startsWith('user:') ? scopeRef.slice('user:'.length) : undefined
}

function withTurnContext(
  event: MatOSEventInput,
  options: SDKEventMappingOptions,
): MatOSEventInput {
  const traceContext = {
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.roleRef ? { roleRef: options.roleRef } : {}),
  }
  return Object.keys(traceContext).length > 0
    ? { ...event, traceContext }
    : event
}

function getContentBlocks(message: SDKMessage): Record<string, unknown>[] {
  const apiMessage = message.message
  if (!apiMessage || typeof apiMessage !== 'object') {
    return []
  }

  const content = (apiMessage as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return []
  }

  return content.filter(
    (block): block is Record<string, unknown> =>
      Boolean(block) && typeof block === 'object',
  )
}

function previewValue(value: unknown, max = 500): string | undefined {
  if (typeof value === 'string') {
    return value.slice(0, max)
  }
  if (Array.isArray(value)) {
    const text = value
      .map(item => {
        if (typeof item === 'string') {
          return item
        }
        if (item && typeof item === 'object' && 'text' in item) {
          const text = (item as { text?: unknown }).text
          return typeof text === 'string' ? text : undefined
        }
        return undefined
      })
      .filter((item): item is string => Boolean(item))
      .join('\n')
    return text ? text.slice(0, max) : undefined
  }
  if (value === undefined || value === null) {
    return undefined
  }
  return JSON.stringify(value).slice(0, max)
}

// Full (untruncated) rendered tool-result text for recording-time error
// classification: the 500-char resultPreview can cut off the embedded
// errorKind/error tail that classifyMatOSToolErrorKind needs.
function fullToolResultText(value: unknown): string | undefined {
  return previewValue(value, Number.MAX_SAFE_INTEGER)
}

function progressPreviewValue(
  value: unknown,
  maxLength = 300,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const redacted = redactTraceValue(value)
  const text =
    typeof redacted === 'string'
      ? redacted
      : JSON.stringify(redacted)
  if (!text) {
    return undefined
  }
  const scrubbed = scrubProgressSecrets(text).replace(/\s+/g, ' ').trim()
  return scrubbed ? scrubbed.slice(0, maxLength) : undefined
}

function scrubProgressSecrets(value: string): string {
  return scrubSecretsFromString(value).replace(
    /((?:\\)?["']?)([A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASS|API[-_]?KEY|AUTH|CREDENTIAL)[A-Z0-9_-]*)\1\s*([:=])\s*((?:\\?["'][^"']*\\?["'])|[^\s"'`,}\\]+)/gi,
    (_match, keyQuote: string, key: string, separator: string) =>
      `${keyQuote}${key}${keyQuote}${separator}[redacted]`,
  )
}

function toolUseInputPreview(block: Record<string, unknown>): string | undefined {
  const input = getObject(block.input)
  if (!input) {
    return undefined
  }
  const toolName = getString(block.name)
  if (toolName === 'Bash') {
    return progressPreviewValue(input.command ?? input.description ?? input)
  }
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    return progressPreviewValue(input.file_path ?? input.path ?? input)
  }
  return progressPreviewValue(input)
}

function sdkMessageProgressText(message: SDKMessage): string | undefined {
  const type = getString(message.type)
  const subtype = getString(message.subtype)

  if (type === 'system' && subtype === 'init') {
    const model = getString(message.model) ?? 'unknown-model'
    const cwd = getString(message.cwd) ?? 'unknown-cwd'
    return `[MatOS] session initialized model=${model} cwd=${cwd} tools=${getArrayLength(message.tools)} mcp=${getArrayLength(message.mcp_servers)}`
  }

  if (type === 'assistant') {
    const lines: string[] = []
    for (const block of getContentBlocks(message)) {
      if (block.type !== 'tool_use') {
        continue
      }
      const toolName = getString(block.name) ?? 'tool'
      const id = getString(block.id)
      const inputPreview = toolUseInputPreview(block)
      lines.push(
        `[MatOS] tool start ${toolName}${id ? ` ${id}` : ''}${
          inputPreview ? `: ${inputPreview}` : ''
        }`,
      )
    }
    return lines.length > 0 ? lines.join('\n') : undefined
  }

  if (type === 'user') {
    const lines: string[] = []
    for (const block of getContentBlocks(message)) {
      if (block.type !== 'tool_result') {
        continue
      }
      const id = getString(block.tool_use_id)
      const status = getBoolean(block.is_error) ? 'error' : 'ok'
      const resultPreview = progressPreviewValue(
        block.content ?? message.tool_use_result,
      )
      lines.push(
        `[MatOS] tool result${id ? ` ${id}` : ''} ${status}${
          resultPreview ? `: ${resultPreview}` : ''
        }`,
      )
    }
    if (lines.length > 0) {
      return lines.join('\n')
    }
    if (message.tool_use_result !== undefined) {
      const resultPreview = progressPreviewValue(message.tool_use_result)
      return `[MatOS] tool result${resultPreview ? `: ${resultPreview}` : ''}`
    }
    return undefined
  }

  if (type === 'control_request' && subtype === 'can_use_tool') {
    const toolName = getString(message.tool_name) ?? 'tool'
    return `[MatOS] permission requested ${toolName}`
  }

  if (type === 'control_response') {
    return '[MatOS] permission resolved'
  }

  if (type === 'result') {
    const isError = Boolean(message.is_error)
    const turns = getNumber(message.num_turns)
    const durationMs = getNumber(message.duration_ms)
    const cost = getNumber(message.total_cost_usd)
    const parts = [
      `[MatOS] session ${!isError && subtype === 'success' ? 'completed' : 'failed'}`,
      turns !== undefined ? `turns=${turns}` : undefined,
      durationMs !== undefined ? `duration_ms=${durationMs}` : undefined,
      cost !== undefined ? `cost_usd=${cost}` : undefined,
    ].filter((part): part is string => Boolean(part))
    return parts.join(' ')
  }

  return undefined
}

function textPreviewFromContentBlocks(
  blocks: Record<string, unknown>[],
): string | undefined {
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => getString(block.text))
    .filter((item): item is string => Boolean(item))
    .join('\n')
  return text ? text.slice(0, 500) : undefined
}

/**
 * Full (untruncated) assistant text from content blocks. Used only for
 * opt-in progressive stdout streaming; the recorded trace event still stores
 * the bounded preview to keep session JSONL small.
 */
function fullTextFromContentBlocks(
  blocks: Record<string, unknown>[],
): string | undefined {
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => getString(block.text))
    .filter((item): item is string => Boolean(item))
    .join('\n')
  return text ? text : undefined
}

/**
 * Extract a token-level text delta from an SDK `stream_event` partial message.
 * Returns undefined for non-text deltas (tool input json, block start/stop,
 * etc.) so only assistant text is streamed progressively.
 */
function partialTextFromStreamEvent(message: SDKMessage): string | undefined {
  if (getString(message.type) !== 'stream_event') {
    return undefined
  }
  const event = getObject((message as { event?: unknown }).event)
  if (!event || getString(event.type) !== 'content_block_delta') {
    return undefined
  }
  const delta = getObject(event.delta)
  if (!delta || getString(delta.type) !== 'text_delta') {
    return undefined
  }
  return getString(delta.text)
}

export function sdkMessageToMatOSEvents(
  message: SDKMessage,
  options: SDKEventMappingOptions = {},
): MatOSEventInput[] {
  const type = getString(message.type)
  const subtype = getString(message.subtype)
  const upstreamSessionId = getString(message.session_id)
  const source =
    getString(message._matos_engine) === 'codex-cli'
      ? 'codex-cli.jsonl'
      : 'cmatos.sdk-stream'

  if (type === 'system' && subtype === 'init') {
    return [
      withTurnContext(
        {
          type: 'matos.turn.context.assembled',
          data: {
            source,
            upstreamSessionId,
            uuid: getString(message.uuid),
            cwd: getString(message.cwd),
            model: getString(message.model),
            permissionMode: getString(message.permissionMode),
            toolCount: getArrayLength(message.tools),
            mcpClientCount: getArrayLength(message.mcp_servers),
            commandCount: getArrayLength(message.slash_commands),
            agentCount: getArrayLength(message.agents),
            skillCount: getArrayLength(message.skills),
            pluginCount: getArrayLength(message.plugins),
            ...(options.selectedAssetRefs
              ? { selectedAssetRefs: options.selectedAssetRefs }
              : {}),
            ...(options.projectedAssets
              ? { projectedAssets: options.projectedAssets }
              : {}),
          },
        },
        options,
      ),
    ]
  }

  if (type === 'assistant') {
    const blocks = getContentBlocks(message)
    const includeToolLifecycle = options.includeToolLifecycle !== false
    const events: MatOSEventInput[] = [
      withTurnContext(
        {
          type: 'matos.agent.message',
          data: {
            source,
            upstreamSessionId,
            uuid: getString(message.uuid),
            contentBlockTypes: blocks.map(block => getString(block.type) ?? 'unknown'),
            textPreview: textPreviewFromContentBlocks(blocks),
            toolUses: blocks
              .filter(block => block.type === 'tool_use')
              .map(block => ({
                toolUseId: getString(block.id),
                toolName: getString(block.name),
              })),
          },
        },
        options,
      ),
    ]

    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const toolUseId = getString(block.id)
        const toolName = getString(block.name)
        if (options.toolNameById && toolUseId && toolName) {
          options.toolNameById.set(toolUseId, toolName)
        }
        if (includeToolLifecycle) {
          events.push(
            withTurnContext(
              {
                type: 'matos.tool.call.started',
                data: {
                  source,
                  upstreamSessionId,
                  toolUseId,
                  toolName,
                },
              },
              options,
            ),
          )
        }
      }
    }

    return events
  }

  if (type === 'user') {
    if (options.includeToolLifecycle === false) {
      return []
    }
    const events: MatOSEventInput[] = []
    for (const block of getContentBlocks(message)) {
      if (block.type === 'tool_result') {
        const toolUseId = getString(block.tool_use_id)
        const toolName =
          toolUseId && options.toolNameById
            ? options.toolNameById.get(toolUseId)
            : undefined
        if (toolUseId && options.toolNameById) {
          options.toolNameById.delete(toolUseId)
        }
        const resultValue = block.content ?? message.tool_use_result
        const isError = getBoolean(block.is_error) ?? false
        events.push(
          withTurnContext(
            {
              type: 'matos.tool.call.completed',
              data: {
                source,
                upstreamSessionId,
                uuid: getString(message.uuid),
                toolUseId,
                ...(toolName ? { toolName } : {}),
                isError,
                resultPreview: previewValue(resultValue),
                // Structured error classification at the recording source so
                // downstream readers (expected-tool-failure guards, evolution
                // triggers) do not depend on error-message wording.
                ...(isError
                  ? {
                      errorKind: classifyMatOSToolErrorKind({
                        resultText: fullToolResultText(resultValue),
                      }),
                    }
                  : {}),
              },
            },
            options,
          ),
        )
      }
    }
    if (events.length > 0) {
      return events
    }
    if (message.tool_use_result !== undefined) {
      return [
        withTurnContext(
          {
            type: 'matos.tool.call.completed',
            data: {
              source,
              upstreamSessionId,
              uuid: getString(message.uuid),
              resultPreview: previewValue(message.tool_use_result),
            },
          },
          options,
        ),
      ]
    }

    return []
  }

  if (type === 'control_request' && subtype === 'can_use_tool') {
    return [
      withTurnContext(
        {
          type: 'matos.permission.requested',
          data: {
            source,
            upstreamSessionId,
            toolName: getString(message.tool_name),
            toolUseId: getString(message.tool_use_id),
            input: message.input,
          },
        },
        options,
      ),
    ]
  }

  if (type === 'control_response') {
    return [
      withTurnContext(
        {
          type: 'matos.permission.resolved',
          data: {
            source,
            upstreamSessionId,
            response: message.response,
          },
        },
        options,
      ),
    ]
  }

  if (type === 'result' && Boolean(message.is_error)) {
    const usage = getObject(message.usage)
    const modelUsage = getObject(message.modelUsage)
    return [
      withTurnContext(
        {
          type: 'matos.session.failed',
          data: {
            source,
            upstreamSessionId,
            subtype,
            isError: true,
            errors: message.errors,
            result: getString(message.result),
            ...(usage ? { usage } : {}),
            ...(modelUsage ? { modelUsage } : {}),
            totalCostUsd: getNumber(message.total_cost_usd) ?? 0,
          },
        },
        options,
      ),
    ]
  }

  if (type === 'result' && subtype === 'success') {
    const usage = getObject(message.usage)
    const modelUsage = getObject(message.modelUsage)
    return [
      withTurnContext(
        {
          type: 'matos.session.completed',
          data: {
            upstreamSessionId,
            result: getString(message.result) ?? '',
            isError: Boolean(message.is_error),
            durationMs: getNumber(message.duration_ms) ?? 0,
            numTurns: getNumber(message.num_turns) ?? 0,
            totalCostUsd: getNumber(message.total_cost_usd) ?? 0,
            ...(usage ? { usage } : {}),
            ...(modelUsage ? { modelUsage } : {}),
          },
        },
        options,
      ),
    ]
  }

  if (type === 'result') {
    const usage = getObject(message.usage)
    const modelUsage = getObject(message.modelUsage)
    return [
      withTurnContext(
        {
          type: 'matos.session.failed',
          data: {
            upstreamSessionId,
            subtype,
            isError: Boolean(message.is_error),
            errors: message.errors,
            ...(usage ? { usage } : {}),
            ...(modelUsage ? { modelUsage } : {}),
            totalCostUsd: getNumber(message.total_cost_usd) ?? 0,
          },
        },
        options,
      ),
    ]
  }

  return []
}

export async function recordSdkLine(
  line: string,
  recorder: Awaited<ReturnType<typeof createMatOSEventRecorder>>,
  options: SDKEventMappingOptions = {},
): Promise<{
  result?: string
  upstreamSessionId?: string
  plainText?: string
  failureText?: string
  assistantText?: string
  partialText?: string
  progressText?: string
}> {
  let message: SDKMessage
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { plainText: line }
    }
    message = parsed as SDKMessage
  } catch {
    return { plainText: line }
  }
  for (const event of sdkMessageToMatOSEvents(message, options)) {
    await recorder.record(event)
  }
  const progressText = options.includeToolProgress
    ? sdkMessageProgressText(message)
    : undefined

  // Token-level partial deltas (`--include-partial-messages`) are not recorded
  // as trace events to keep session JSONL small; they only feed progressive
  // stdout streaming.
  if (getString(message.type) === 'stream_event') {
    const partialText = partialTextFromStreamEvent(message)
    return partialText ? { partialText, progressText } : { progressText }
  }

  if (message.type === 'result' && message.subtype === 'success') {
    return {
      result: getString(message.result),
      upstreamSessionId: getString(message.session_id),
      failureText: getSdkFailureText(message),
      progressText,
    }
  }

  if (message.type === 'result') {
    return {
      upstreamSessionId: getString(message.session_id),
      failureText: getSdkFailureText(message),
      progressText,
    }
  }

  if (getString(message.type) === 'assistant') {
    const assistantText = fullTextFromContentBlocks(getContentBlocks(message))
    if (assistantText) {
      return { assistantText, progressText }
    }
  }

  return { progressText }
}

export function getSdkFailureText(message: SDKMessage): string | undefined {
  if (message.type !== 'result') {
    return undefined
  }
  const isError = message.is_error === true || message.subtype !== 'success'
  if (!isError) {
    return undefined
  }
  const errors = Array.isArray(message.errors)
    ? message.errors.filter(error => typeof error === 'string')
    : []
  const result = getString(message.result)
  const detail = errors.length > 0
    ? errors.join('; ')
    : result || getString(message.subtype) || 'unknown error'
  return `MatOS run failed: ${detail}`
}

export function sdkResultExitCodeFromLine(line: string): number | undefined {
  let message: SDKMessage
  try {
    const parsed = JSON.parse(line) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }
    message = parsed as SDKMessage
  } catch {
    return undefined
  }
  if (getString(message.type) !== 'result') {
    return undefined
  }
  return message.is_error === true || getString(message.subtype) !== 'success' ? 1 : 0
}

export function sdkRunCompletionSignalFromLine(line: string):
  | { kind: 'result'; exitCode: number }
  | { kind: 'idle' | 'busy' }
  | undefined {
  const exitCode = sdkResultExitCodeFromLine(line)
  if (exitCode !== undefined) return { kind: 'result', exitCode }
  try {
    const message = JSON.parse(line) as {
      type?: unknown; subtype?: unknown; state?: unknown
    } | null
    if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      if (message.state === 'idle') return { kind: 'idle' }
      if (message.state === 'running' || message.state === 'requires_action') return { kind: 'busy' }
    }
    if (
      message.type === 'user' || message.type === 'assistant' ||
      message.type === 'stream_event' ||
      (message.type === 'system' && (message.subtype === 'init' || message.subtype === 'task_started'))
    ) return { kind: 'busy' }
  } catch {
    // Human-readable stdout is not a lifecycle signal.
  }
  return undefined
}

function sdkResultExitGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MATOS_RUN_SDK_RESULT_EXIT_GRACE_MS?.trim()
  if (!raw) {
    return 1000
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000
}

function passthroughOptionValue(
  args: string[],
  option: string,
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === option) {
      return args[index + 1]
    }
    if (value?.startsWith(`${option}=`)) {
      return value.slice(option.length + 1)
    }
  }
  return undefined
}

export async function runMatOSAgentTask(
  args: string[],
  io: MatOSRunIO,
): Promise<number> {
  const parsed = parseMatOSRunArgs(args)
  if (parsed.help) {
    printMatOSRunHelp(io.stdout)
    return 0
  }

  let invocation: MatOSRunInvocation
  try {
    invocation = await buildMatOSRunInvocation(args, io.cwd)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }


  const hiddenInternalRun = isHiddenMatOSRunEnv()
  const recorder = await createMatOSEventRecorder(io.cwd, {
    command: `matos run ${args.map(arg => JSON.stringify(arg)).join(' ')}`,
    cwd: io.cwd,
    execution: invocation.execution,
    roleRef: invocation.roleReference,
    runtimeRef: invocation.runtimeReference,
    scopeRef: invocation.scopeReference,
    userId: userIdFromScopeRef(invocation.scopeReference),
    hidden: hiddenInternalRun,
    userVisible: hiddenInternalRun ? false : undefined,
    suppressSessionStarted: process.env.MATOS_INHERIT_PARENT_RUN_TRACE === '1',
  })
  const turnId = randomUUID()
  const shouldRecordWrapperTurn = invocation.execution !== 'container'

  if (shouldRecordWrapperTurn) {
    await recorder.record({
      type: 'matos.turn.started',
      traceContext: { turnId },
      data: {
        prompt: invocation.prompt,
        role: invocation.roleReference,
        execution: invocation.execution,
        runtime: invocation.runtimeReference,
        scope: invocation.scopeReference,
        agentEngine: 'deepseek-harness',
      },
    })
  }
  await recordMatOSAssetLoadedEvents({
    recorder,
    assets: invocation.assets,
    selectedAssetKeys: invocation.selectedAssetKeys,
    ...(invocation.roleReference
      ? { roleReference: invocation.roleReference }
      : {}),
  })

  let releaseProjectWriter = async () => {}
  try {
    if (invocation.execution === 'local' && invocation.projectAccess) {
      releaseProjectWriter = await acquireMatOSProjectWriteLock({
        cwd: invocation.projectAccess.projectCwd,
        runId: recorder.sessionId,
        env: process.env,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`${message}\n`)
    await recorder.record({
      type: 'matos.session.failed',
      data: { execution: invocation.execution, error: message },
    }).catch(() => {})
    await recorder.close().catch(() => {})
    await cleanupMatOSRunInvocationMaterialization(io.cwd, invocation).catch(() => {})
    return 1
  }
  const runProcessEnv = {
    ...process.env,
    ...matOSInvocationAssetTraceEnv(invocation),
    ...(invocation.execution === 'local' && invocation.projectAccess
      ? {
          MATOS_PROJECT_WRITE_LOCK_HELD: recorder.sessionId,
          MATOS_PROJECT_WRITE_LOCK_CWD: invocation.projectAccess.projectCwd,
        }
      : {}),
  }

  try {

  const streamAssistantOutput = process.env.MATOS_RUN_STREAM_STDOUT === '1'
  const streamToolProgress = process.env.MATOS_RUN_STREAM_TOOL_EVENTS === '1'
  let streamedAssistantChars = 0
  let streamedPartialChars = 0
  let stdoutBuffer = ''
  let finalResult: string | undefined
  const plainStdoutLines: string[] = []
  let failureText: string | undefined
  let upstreamSessionId: string | undefined
  const pendingRecords: Promise<void>[] = []
  // When streaming, request token-level partial messages so stdout grows
  // delta-by-delta instead of one assistant message at a time.
  const agentArgs =
    streamAssistantOutput && !invocation.agentArgs.includes('--include-partial-messages')
      ? [...invocation.agentArgs, '--include-partial-messages']
      : invocation.agentArgs

  const exitCode = await new Promise<number>(resolve => {
    let sdkResultExitCode: number | undefined
    let sdkSessionIdle = false
    let resultTerminationTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(
      process.execPath,
      [getAgentEntrypointPath(), ...agentArgs],
      {
        cwd: io.cwd,
        env: {
          ...buildMatOSChildEnv(runProcessEnv, {
            ...recorder.traceEnv,
            MATOS_TURN_ID: turnId,
          }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const scheduleResultTermination = (resultExitCode: number): void => {
      sdkResultExitCode = resultExitCode
      if (resultTerminationTimer) {
        return
      }
      resultTerminationTimer = setTimeout(() => {
        if (sdkSessionIdle && !child.killed) {
          child.kill('SIGTERM')
        }
      }, sdkResultExitGraceMs())
      resultTerminationTimer.unref?.()
    }
    const cancelResultTermination = (): void => {
      if (resultTerminationTimer) {
        clearTimeout(resultTerminationTimer)
        resultTerminationTimer = undefined
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdoutBuffer += String(chunk)
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }
        const completion = sdkRunCompletionSignalFromLine(trimmed)
        if (completion?.kind === 'result') {
          sdkResultExitCode = completion.exitCode
          sdkSessionIdle = false
          cancelResultTermination()
        } else if (completion?.kind === 'idle') {
          sdkSessionIdle = true
          if (sdkResultExitCode !== undefined) scheduleResultTermination(sdkResultExitCode)
        } else if (completion?.kind === 'busy') {
          sdkSessionIdle = false
          sdkResultExitCode = undefined
          cancelResultTermination()
        }
        pendingRecords.push(
          recordSdkLine(trimmed, recorder, {
            turnId,
            includeToolLifecycle: false,
            includeToolProgress: streamToolProgress,
            ...matOSInvocationAssetTrace(invocation),
          }).then(record => {
            if (record.result !== undefined) {
              finalResult = record.result
            }
            if (record.plainText !== undefined) {
              plainStdoutLines.push(record.plainText)
            }
            if (record.failureText !== undefined) {
              failureText = record.failureText
            }
            if (record.upstreamSessionId) {
              upstreamSessionId = record.upstreamSessionId
            }
            if (streamToolProgress && record.progressText) {
              io.stdout(
                record.progressText.endsWith('\n')
                  ? record.progressText
                  : `${record.progressText}\n`,
              )
            }
            if (streamAssistantOutput && record.partialText) {
              io.stdout(record.partialText)
              streamedPartialChars += record.partialText.length
            }
            if (
              streamAssistantOutput &&
              record.assistantText &&
              streamedPartialChars === 0
            ) {
              io.stdout(
                record.assistantText.endsWith('\n')
                  ? record.assistantText
                  : `${record.assistantText}\n`,
              )
              streamedAssistantChars += record.assistantText.length
            }
          }),
        )
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      io.stderr(String(chunk))
    })

    child.on('close', code => {
      if (resultTerminationTimer) {
        clearTimeout(resultTerminationTimer)
      }
      // Never let an earlier successful waiting turn mask a later crash.
      resolve(sdkSessionIdle && sdkResultExitCode !== undefined
        ? sdkResultExitCode
        : code === 0 ? sdkResultExitCode ?? 0 : code ?? 1)
    })
    child.on('error', error => {
      if (resultTerminationTimer) {
        clearTimeout(resultTerminationTimer)
      }
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
      resolve(1)
    })
  })

  if (stdoutBuffer.trim()) {
    pendingRecords.push(
      recordSdkLine(stdoutBuffer.trim(), recorder, {
        turnId,
        includeToolLifecycle: false,
        includeToolProgress: streamToolProgress,
        ...matOSInvocationAssetTrace(invocation),
      }).then(record => {
        if (record.result !== undefined) {
          finalResult = record.result
        }
        if (record.plainText !== undefined) {
          plainStdoutLines.push(record.plainText)
        }
        if (record.failureText !== undefined) {
          failureText = record.failureText
        }
        if (record.upstreamSessionId) {
          upstreamSessionId = record.upstreamSessionId
        }
        if (streamToolProgress && record.progressText) {
          io.stdout(
            record.progressText.endsWith('\n')
              ? record.progressText
              : `${record.progressText}\n`,
          )
        }
        if (streamAssistantOutput && record.partialText) {
          io.stdout(record.partialText)
          streamedPartialChars += record.partialText.length
        }
        if (
          streamAssistantOutput &&
          record.assistantText &&
          streamedPartialChars === 0
        ) {
          io.stdout(
            record.assistantText.endsWith('\n')
              ? record.assistantText
              : `${record.assistantText}\n`,
          )
          streamedAssistantChars += record.assistantText.length
        }
      }),
    )
  }

  try {
    await Promise.all(pendingRecords)

    if (exitCode !== 0) {
      await recorder.record({
        type: 'matos.session.failed',
        data: { exitCode },
      })
    }

    await recorder.record({
      type: 'matos.turn.completed',
      traceContext: { turnId },
      data: { exitCode },
    })
    if (upstreamSessionId) {
      await recorder.record({
        type: 'matos.session.resume-linked',
        traceContext: { turnId },
        data: {
          source: 'cmatos.sdk-stream',
          upstreamSessionId,
          command: `matos --resume ${JSON.stringify(upstreamSessionId)}`,
        },
      })
    }
    await recorder.close()
  } finally {
    await cleanupMatOSRunInvocationMaterialization(io.cwd, invocation)
  }

  if (streamAssistantOutput && (streamedAssistantChars > 0 || streamedPartialChars > 0)) {
    // The final answer was already streamed progressively to stdout (token
    // deltas or whole messages); avoid reprinting it, only terminate the
    // streamed line.
    if (streamedPartialChars > 0) {
      io.stdout('\n')
    }
  } else if (finalResult !== undefined) {
    io.stdout(finalResult.endsWith('\n') ? finalResult : `${finalResult}\n`)
  } else if (plainStdoutLines.length > 0) {
    io.stdout(`${plainStdoutLines.join('\n')}\n`)
  }
  // Failure guidance must not be swallowed just because a result text was
  // printed: the synthetic auth-banner failure has BOTH a result payload (the
  // banner) and an actionable failureText, and previously the else-if chain
  // dropped the latter (the codex engine path already surfaced both).
  if (exitCode !== 0 && failureText !== undefined) {
    io.stderr(failureText.endsWith('\n') ? failureText : `${failureText}\n`)
  }

    return exitCode
  } finally {
    await releaseProjectWriter().catch(() => {})
  }
}
