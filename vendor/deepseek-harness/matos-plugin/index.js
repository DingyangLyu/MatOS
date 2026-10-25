import { realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as mountFileSystemSkills } from '@deepseek-ai/dsh-skill-filesystem'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import * as DshMcpClient from '@deepseek-ai/dsh-mcp-client'
import * as MatOSNativeMcp from './nativeMcp.js'
import { createAssetStore, redactSecrets, resolveAssetRoot } from './assetStore.js'
import { currentMatOSTurnPolicy, requestMatOSNativePermission, executeMatOSNativeTool } from './sdk.js'

export const name = 'matos-assets'
export const inject = ['tools', 'agents', 'sessionPersistence', 'systemPrompt', 'sandboxPolicy', 'skills']

function nativeParameters(name) {
  const common = { type: 'object', properties: {} }
  if (name === 'read' || name === 'read_image') return { ...common, properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } }
  if (name === 'write') return { ...common, properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }
  if (name === 'edit' || name === 'str_replace_editor') return { ...common, properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, command: { type: 'string' }, path: { type: 'string' }, file_text: { type: 'string' } } }
  if (name === 'grep') return { ...common, properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] }
  if (name === 'glob') return { ...common, properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] }
  if (name === 'skill') return { ...common, properties: { name: { type: 'string' } }, required: ['name'] }
  if (name === 'bash') return { ...common, properties: { command: { type: 'string' }, timeout: { type: 'integer' }, timeoutMs: { type: 'integer' }, workdir: { type: 'string' } }, required: ['command'] }
  return common
}

function envText(key, fallback) {
  const value = process.env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : (fallback || '')
}
function projectRoot() { return resolve(envText('MATOS_PROJECT_CWD', process.cwd())) }
function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes('\0'))
}
function assetStore() { return createAssetStore(resolveAssetRoot(process.env.MATOS_ASSET_ROOT)) }
function jsonArray(key) {
  const value = process.env[key]
  if (!value || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    throw new Error(`${key} must be a JSON string array`)
  }
}
function pathValues(value, output = []) {
  if (typeof value === 'string') {
    if (value.startsWith('/')) output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) pathValues(item, output)
    return output
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) pathValues(item, output)
  }
  return output
}
async function canonicalTarget(path) {
  try { return await realpath(path) } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return join(await canonicalTarget(parent), basename(path))
  }
}

export async function apply(ctx) {
  // Native MatOS materialization owns role/scoped selection and skill aliases.
  // Direct CLI/workflow turns use DSH's supported filesystem loader over only
  // those projected roots; interactive turns keep their native Skill executor.
  const skillRoots = jsonArray('MATOS_DSH_SKILL_ROOTS')
  if (skillRoots.length) mountFileSystemSkills(ctx, { providerName: 'matos-projected', includeDefaultRoots: false, customSkillDirs: skillRoots, watch: false })
  const roleRef = envText('MATOS_ROLE_REF', 'unscoped')
  const project = projectRoot()
  const fallbackPolicy = {
    systemPrompt: envText('MATOS_DSH_ROLE_PROMPT'),
    noTools: process.env.MATOS_DSH_NO_TOOLS === '1',
    allowedTools: jsonArray('MATOS_DSH_ALLOWED_TOOLS'),
    disallowedTools: jsonArray('MATOS_DSH_DISALLOWED_TOOLS'),
    nativePermissions: process.env.MATOS_DSH_REQUIRE_NATIVE_PERMISSIONS === '1',
    nativeExecutionTools: jsonArray('MATOS_DSH_NATIVE_EXECUTION_TOOLS'),
    permissionMode: envText('MATOS_DSH_PERMISSION_MODE', envText('DSH_PERMISSION_MODE', 'workspace-write')),
    maxTurns: process.env.MATOS_DSH_MAX_TURNS ? Number(process.env.MATOS_DSH_MAX_TURNS) : undefined,
    readRoots: [], writeRoots: [],
  }
  const policy = () => currentMatOSTurnPolicy() ?? fallbackPolicy
  const aliases = {
    bash: ['bash'], read: ['read', 'read_image'], write: ['write'], edit: ['edit', 'str_replace_editor'],
    glob: ['glob'], grep: ['grep'], webfetch: ['web_fetch'], websearch: ['web_search'],
    agent: ['subagent', 'subagent_fork'],
    sendmessage: ['send_message'], taskstop: ['interrupt_agent'], tasklist: ['list_agents'],
    todowrite: ['todo_write'],
  }
  const toolMatches = (rules, name) => rules.some(rule => {
    const lower = rule.toLowerCase()
    if (lower.includes('(')) return false
    if ((aliases[lower] || []).includes(name.toLowerCase())) return true
    const escaped = lower.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp('^' + escaped + '$').test(name.toLowerCase())
  })
  const nativeApproved = new WeakSet()
  const agentPolicies = new WeakMap()
  ctx.systemPrompt.section({ name: 'matos:role', order: 10, text: () => policy().systemPrompt })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const current = policy()
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(current.permissionMode)) throw new Error('Invalid MatOS DSH sandbox mode')
    let state = agentPolicies.get(agent)
    if (!state || state.policy !== current) {
      for (const dispose of state?.disposers ?? []) dispose()
      state = { policy: current, steps: 0, disposers: [] }
      agentPolicies.set(agent, state)
      const names = ctx.tools.schemas().map(tool => tool.name).filter(name => name !== 'run_code')
      const allowed = current.noTools ? [] : names.filter(name =>
        (!current.allowedTools.length || toolMatches(current.allowedTools, name)) &&
        !toolMatches(current.disallowedTools, name))
      state.disposers.push(agent.ctx.tools.restrict({ allow: allowed }))
      if (!current.noTools && current.nativePermissions) {
        for (const name of current.nativeExecutionTools) {
          if (!allowed.includes(name)) continue
          const original = ctx.tools.get(name)
          if (!original) throw new Error('Missing native-proxied DSH tool: ' + name)
          state.disposers.push(agent.ctx.tools.register({
            ...original,
            // DSH accepts a strict JSON-Schema subset; native execution validates the full MatOS schema.
            parameters: nativeParameters(name),
            output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => result.content },
            async execute(_args, execution) {
              const result = await executeMatOSNativeTool(execution)
              if (result.isError) throw new Error(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || 'Native MatOS tool failed')
              const content = []
              for (const block of result.content) {
                if (block.type === 'image' && block.source?.type === 'base64') {
                  if (!ctx.get('attachments')) throw new Error('DSH attachment store is unavailable')
                  const [attachment] = await admitEncodedImages(ctx.get('attachments'), [{ data: block.source.data, mediaType: block.source.media_type }])
                  content.push({ type: 'image', attachment })
                } else if (block.type === 'text') content.push(block)
                else throw new Error('Unsupported native MatOS tool result block: ' + block.type)
              }
              return { ...result, content }
            },
          }))
        }
      }
    }
    state.steps += 1
    if (current.maxTurns !== undefined && (!Number.isSafeInteger(current.maxTurns) || current.maxTurns <= 0)) throw new Error('Invalid MatOS DSH step limit')
    if (current.maxTurns !== undefined && state.steps > current.maxTurns) throw new Error('MatOS DSH maximum steps reached')
    if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== current.permissionMode) {
      agent.session.append('sandbox/mode', { mode: current.permissionMode })
    }
    return next()
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind === 'deny') return decision
    const current = policy()
    if (current.noTools) return { kind: 'deny', reason: 'MatOS reply-only turn has no tools' }
    // Native proxies execute through MatOS's full tool pipeline, including its
    // recursive search exclusions and filesystem sandbox. Other DSH tools must
    // pass the project boundary here as well as the native permission callback.
    if (!current.nativeExecutionTools.includes(execution.name) && current.permissionMode !== 'danger-full-access') {
      const args = execution.arguments ?? {}
      const paths = []
      for (const key of ['file_path', 'path', 'file', 'directory', 'cwd', 'workdir', 'target_path']) {
        if (typeof args[key] === 'string' && args[key]) paths.push(args[key])
      }
      if (Array.isArray(args.paths)) paths.push(...args.paths.filter(value => typeof value === 'string'))
      const writes = /(?:write|edit|patch|exec|command|workflow_run)/.test(execution.name.toLowerCase())
      const roots = [project, ...(writes ? current.writeRoots : current.readRoots)]
      const canonicalRoots = await Promise.all(roots.map(root => canonicalTarget(resolve(project, root))))
      for (const candidate of paths) {
        const canonical = await canonicalTarget(resolve(project, candidate))
        if (!canonicalRoots.some(root => inside(root, canonical))) return { kind: 'deny', reason: 'MatOS project sandbox denies path outside permitted roots' }
      }
    }
    if (current.nativePermissions) {
      const native = await requestMatOSNativePermission(execution)
      if (native.behavior !== 'allow') return { kind: 'deny', reason: native.reason || 'Native MatOS denied this tool' }
      nativeApproved.add(execution)
    }
    return decision
  })
  ctx.tools.guard(execution => {
    const current = policy()
    if (current.noTools) return 'MatOS reply-only turn has no tools'
    if (current.nativePermissions && !nativeApproved.has(execution)) return 'Native MatOS permission check is required'
    if (toolMatches(current.disallowedTools, execution.name)) return `MatOS role ${roleRef} disallows tool ${execution.name}`
    if (current.allowedTools.length > 0 && !toolMatches(current.allowedTools, execution.name)) return `MatOS role ${roleRef} does not allow tool ${execution.name}`
    if (current.permissionMode === 'read-only' && /(?:bash|shell|write|edit|patch|exec|command|workflow_run)/.test(execution.name.toLowerCase())) return `MatOS role ${roleRef} is read-only`
    return undefined
  })

  // The upstream SDK server creates a fresh agent for every unknown session id.
  // DSH persistence already owns the durable log, so adopt an existing id via
  // AgentRegistry.resume before allowing a fresh create. This keeps restart,
  // fork and MatOS history on the same Session identity.
  const mcpConfig = process.env.MATOS_DSH_MCP_CONFIG
  if (mcpConfig && mcpConfig.trim()) {
    let parsed
    try { parsed = JSON.parse(mcpConfig) } catch { throw new Error('MATOS_DSH_MCP_CONFIG must be valid JSON') }
    const entries = Array.isArray(parsed) ? parsed : [parsed]
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.serverName !== 'string' || typeof entry.transport !== 'string') throw new Error('Invalid MatOS DSH MCP configuration')
      await ctx.plugin(entry.serverName === 'matos_asset' ? MatOSNativeMcp : DshMcpClient, entry)
    }
  }

  const agents = ctx.agents
  const create = agents.create
  const originalCreate = create.bind(agents)
  const sessionMeta = options => {
    const parentSession = envText('MATOS_PARENT_SESSION_ID')
    const preset = envText('MATOS_DSH_AGENT_PRESET')
    const origin = envText('MATOS_DSH_AGENT_ORIGIN')
    return {
      ...options,
      meta: {
        ...(options.meta || {}),
        ...(parentSession && !options.meta?.parentSession ? { parentSession } : {}),
        ...(preset && !options.meta?.agentPreset ? { agentPreset: preset } : {}),
        ...(origin === 'subagent' && !options.meta?.origin ? { origin: 'subagent' } : {}),
        ...(process.env.MATOS_PROJECT_CWD && !options.meta?.cwd ? { cwd: projectRoot() } : {}),
      },
    }
  }
  agents.create = async options => {
    const persistence = ctx.get('sessionPersistence')
    const enriched = sessionMeta(options)
    if (!persistence) return originalCreate(enriched)
    // 0.2 uses observation plus owned session handles. stat does not take a
    // writer lock; resume owns loading, migration checks, and lock acquisition.
    if (!enriched.sessionId) return originalCreate(enriched)
    const stored = await persistence.stat(enriched.sessionId)
    if (!stored) return originalCreate(enriched)
    return agents.resume({
      resumeSessionId: enriched.sessionId,
      agentOptions: enriched.agentOptions,
      setup: enriched.setup,
      signal: enriched.signal,
    })
  }
  ctx.effect(() => () => { agents.create = create }, 'matos-session-adoption')

  ctx.tools.register(defineTool({
    name: 'matos_asset_list', description: 'List MatOS assets visible in the current scope.',
    parameters: { type: { type: 'string', description: 'Optional asset type filter.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return assetStore().listAssets(args.type) },
  }))
  ctx.tools.register(defineTool({
    name: 'matos_asset_read', description: 'Read an asset manifest inside the scoped MatOS asset root.',
    parameters: { path: { type: 'string', required: true, description: 'Absolute asset.json path.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return assetStore().readAsset(args.path) },
  }))
  ctx.tools.register(defineTool({
    name: 'matos_role_resolve', description: 'Resolve a MatOS role manifest, including its dependencies and declared runtime permission mode.',
    parameters: { role: { type: 'string', required: true, description: 'Role id or role:id@version reference.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const ref = String(args.role || '').replace(/^role:/, '').split('@')[0]
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes('..')) throw new Error('Invalid MatOS role reference')
      const { assets } = await assetStore().listAssets('role')
      const role = assets.find(item => item && item.id === ref)
      if (!role) throw new Error('MatOS role is not visible in the current scope: ' + ref)
      return redactSecrets({ id: role.id, version: role.version, dependencies: role.dependencies || [], mounts: role.mounts || {}, runtime: role.runtime || {}, metadata: role.metadata || {} })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'matos_permission_check', description: 'Check whether a MatOS member and role may perform an operation inside the project sandbox.',
    parameters: { operation: { type: 'string', required: true, enum: ['read', 'write', 'execute'] }, path: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const root = await realpath(projectRoot()).catch(() => projectRoot())
      const target = resolve(String(args.path || ''))
      const targetReal = await canonicalTarget(target)
      const operation = String(args.operation)
      const isInside = inside(root, targetReal)
      const writeHeld = Boolean(envText('MATOS_PROJECT_WRITE_LOCK_HELD'))
      const allowed = isInside && (operation !== 'write' || writeHeld)
      return redactSecrets({ allowed, operation, path: target, projectCwd: root, memberId: envText('MATOS_PROJECT_MEMBER_ID'), roleRef: envText('MATOS_ROLE_REF'), permissionMode: envText('MATOS_PERMISSION_MODE', 'bypassPermissions'), sandboxMode: envText('MATOS_SANDBOX_MODE', 'workspace-write'), reason: allowed ? 'allowed' : (isInside ? 'project write lock is not held' : 'path is outside the project sandbox') })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'matos_project_scope', description: 'Return the active MatOS project, member, role and sandbox boundary.', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      const projectCwd = projectRoot()
      return redactSecrets({ projectCwd, projectId: envText('MATOS_PROJECT_ID'), memberId: envText('MATOS_PROJECT_MEMBER_ID'), roleRef: envText('MATOS_ROLE_REF'), agentId: envText('MATOS_AGENT_ID'), parentSessionId: envText('MATOS_PARENT_SESSION_ID'), sandboxRoot: projectCwd, writeLockHeld: Boolean(envText('MATOS_PROJECT_WRITE_LOCK_HELD')) })
    },
  }))
}
