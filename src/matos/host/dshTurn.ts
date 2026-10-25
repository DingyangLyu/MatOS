import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MatOSRuntimeProjection } from '../assets/runtimeComposition.js'
import { matOSProjectionToDeepSeekMcpConfig } from '../runtime/deepseekHarnessEngine.js'
import { matOSRuleToolNames, parseMatOSToolRule } from './permissions.js'

export type MatOSRoleRuntime = {
  roleReference?: string
  projection?: MatOSRuntimeProjection
  materializationDirs: readonly string[]
  projectAccess?: { projectCwd: string; projectId: string; memberId: string }
}

export type MatOSRoleAgentDefinition = {
  prompt?: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  effort?: string | number
  permissionMode?: string
  maxTurns?: number
  initialPrompt?: string
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

export function matOSAgentDefinition(
  agents: Record<string, Record<string, unknown>> | undefined,
  selected: string | undefined,
): MatOSRoleAgentDefinition | undefined {
  const raw = selected ? agents?.[selected] : undefined
  if (!raw) return undefined
  return {
    ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
    ...(stringList(raw.tools) ? { tools: stringList(raw.tools) } : {}),
    ...(stringList(raw.disallowedTools) ? { disallowedTools: stringList(raw.disallowedTools) } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(typeof raw.effort === 'string' || typeof raw.effort === 'number' ? { effort: raw.effort } : {}),
    ...(typeof raw.permissionMode === 'string' ? { permissionMode: raw.permissionMode } : {}),
    ...(typeof raw.maxTurns === 'number' ? { maxTurns: raw.maxTurns } : {}),
    ...(typeof raw.initialPrompt === 'string' ? { initialPrompt: raw.initialPrompt } : {}),
  }
}

/** Role prompt first, then appended context; repeated sections appear once. */
export function composeMatOSSystemPrompt(sections: ReadonlyArray<string | undefined>): string {
  const kept: string[] = []
  for (const section of sections) {
    const text = section?.trim()
    if (!text) continue
    if (kept.some(existing => existing === text || existing.includes(text))) continue
    kept.push(text)
  }
  return kept.join('\n\n')
}

/** Materialized skill roots under the given directories (and the project). */
export function matOSSkillRoots(dirs: readonly string[], cwd?: string): string[] {
  const roots = new Set<string>()
  for (const dir of [...dirs, ...(cwd ? [cwd] : [])]) {
    const root = join(resolve(dir), '.matos', 'skills')
    if (existsSync(root)) roots.add(root)
  }
  return [...roots]
}

/** MCP config values are files or inline JSON; `<cwd>/.mcp.json` is included when present. */
export async function readMatOSMcpConfigValues(values: readonly string[], cwd: string, includeProject = true): Promise<string[]> {
  const output: string[] = []
  const candidates = [...values]
  const projectConfig = join(cwd, '.mcp.json')
  if (includeProject && existsSync(projectConfig)) candidates.push(projectConfig)
  for (const value of candidates) {
    const trimmed = value.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('{')) {
      output.push(trimmed)
      continue
    }
    try {
      output.push(await readFile(resolve(cwd, trimmed), 'utf8'))
    } catch (error) {
      throw new Error(`MCP config is not readable: ${trimmed}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return output
}

export type MatOSDshTurnPlan = {
  env: Record<string, string>
  systemPrompt: string
  noTools: boolean
  /** DSH tool surface; empty means every DSH tool. */
  toolSurface: string[]
  denyRules: string[]
  agent?: MatOSRoleAgentDefinition
}

export type MatOSDshTurnInput = {
  cwd: string
  roleReference?: string
  projectAccess?: MatOSRoleRuntime['projectAccess']
  materializationDirs: readonly string[]
  agent?: MatOSRoleAgentDefinition
  appendSystemPrompt?: readonly string[]
  /** Role tool surface used when the role agent declares none. */
  roleTools?: readonly string[]
  roleDisallowedTools?: readonly string[]
  mcpConfigJson?: readonly string[]
  /** Explicit project/user MCP servers; their grants never widen the internal asset server. */
  projectMcpConfigJson?: readonly string[]
  /** CLI tool restriction (`--tools`); `[]` disables tools. */
  tools?: readonly string[]
  extraDenyRules?: readonly string[]
  systemPromptOverride?: string
}

/** Inputs for a role composed in-process. */
export function matOSRoleTurnInput(cwd: string, role: MatOSRoleRuntime): MatOSDshTurnInput {
  const projection = role.projection
  return {
    cwd,
    ...(role.roleReference ? { roleReference: role.roleReference } : {}),
    ...(role.projectAccess ? { projectAccess: role.projectAccess } : {}),
    materializationDirs: role.materializationDirs,
    ...(projection ? {
      agent: matOSAgentDefinition(projection.agents, projection.selectedAgent),
      appendSystemPrompt: projection.appendSystemPrompt,
      roleTools: projection.allowedTools,
      roleDisallowedTools: projection.disallowedTools,
      mcpConfigJson: projection.mcpConfigJson,
    } : {}),
  }
}

/**
 * Translate a composed MatOS role into a DSH turn: system prompt, tool
 * surface, skill roots, MCP servers and project identity.
 */
export function planMatOSDshTurn(input: MatOSDshTurnInput): MatOSDshTurnPlan {
  const agent = input.agent
  const surfaceSource = input.tools ?? agent?.tools ?? input.roleTools ?? []
  const noTools = (input.tools !== undefined && input.tools.length === 0) ||
    (input.tools === undefined && agent?.tools !== undefined && agent.tools.length === 0)
  const denyRules = [...new Set([
    ...(agent?.disallowedTools ?? []),
    ...(input.roleDisallowedTools ?? []),
    ...(input.extraDenyRules ?? []),
  ])]
  const plainDenied = denyRules.filter(rule => parseMatOSToolRule(rule)?.pattern === undefined)
  const mcpConfig = noTools ? undefined : matOSProjectionToDeepSeekMcpConfig([...(input.mcpConfigJson ?? [])])
  const skillRoots = matOSSkillRoots(input.materializationDirs, input.cwd)
  const access = input.projectAccess
  const projectMcp = matOSProjectionToDeepSeekMcpConfig(input.projectMcpConfigJson ?? [])
  const projectMcpRules = projectMcp
    ? (JSON.parse(projectMcp) as Array<{ serverName: string }>)
        .filter(server => server.serverName !== 'matos_asset')
        .map(server => `mcp__${server.serverName}__*`)
    : []
  const roleSurface = matOSRuleToolNames(surfaceSource)
  // An empty role surface already allows all tools. Explicit --tools remains
  // authoritative; a project setting never overrides a CLI restriction.
  const toolSurface = noTools ? [] : [...new Set([
    ...roleSurface,
    ...(input.tools === undefined && roleSurface.length > 0 ? projectMcpRules : []),
  ])]
  const env: Record<string, string> = {
    MATOS_DSH_SKILL_ROOTS: JSON.stringify(skillRoots),
    MATOS_DSH_ALLOWED_TOOLS: JSON.stringify(toolSurface),
    MATOS_DSH_DISALLOWED_TOOLS: JSON.stringify(plainDenied),
    MATOS_PROJECT_CWD: access?.projectCwd ?? input.cwd,
    MATOS_ASSET_ROOT: join(access?.projectCwd ?? input.cwd, '.matos', 'assets'),
    ...(mcpConfig ? { MATOS_DSH_MCP_CONFIG: mcpConfig } : {}),
    ...(access ? { MATOS_PROJECT_ID: access.projectId, MATOS_PROJECT_MEMBER_ID: access.memberId } : {}),
    ...(input.roleReference ? { MATOS_ROLE_REF: input.roleReference, MATOS_DSH_AGENT_PRESET: input.roleReference } : {}),
  }
  return {
    env,
    systemPrompt: input.systemPromptOverride ?? composeMatOSSystemPrompt([
      agent?.prompt,
      ...(input.appendSystemPrompt ?? []),
    ]),
    noTools,
    toolSurface,
    denyRules,
    ...(agent ? { agent } : {}),
  }
}
