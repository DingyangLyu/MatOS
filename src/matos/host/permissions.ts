import {realpathSync} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import { parse as parseShell } from 'shell-quote'

/** Permission modes accepted on the MatOS agent command line. */
export type MatOSPermissionMode =
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'default'
  | 'acceptEdits'
  | 'auto'

export const MATOS_PERMISSION_MODES: readonly MatOSPermissionMode[] = [
  'plan', 'dontAsk', 'bypassPermissions', 'default', 'acceptEdits', 'auto',
]

export type MatOSDshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type MatOSToolPolicy = {
  mode: MatOSPermissionMode
  cwd: string
  /** Extra directories readable without an explicit allow rule. */
  additionalDirs: readonly string[]
  /** Pre-approved tools: `Name` or `Name(pattern)`. */
  allowRules: readonly string[]
  /** Denied tools: `Name` or `Name(pattern)`. */
  denyRules: readonly string[]
}

export type MatOSToolRequest = {
  name: string
  arguments: Record<string, unknown>
  signal?: AbortSignal
}

export type MatOSToolDecision = { behavior: 'allow' | 'deny'; reason?: string }

export function isMatOSPermissionMode(value: unknown): value is MatOSPermissionMode {
  return typeof value === 'string' && (MATOS_PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * DSH sandbox mode for a MatOS permission mode. Without a usable OS sandbox
 * (`MATOS_NESTED_SANDBOX_AVAILABLE=0`), commands run with the account's own
 * permissions, as documented for trusted single-user hosts.
 */
export function dshSandboxModeFor(
  mode: MatOSPermissionMode,
  hasProject: boolean,
  env: NodeJS.ProcessEnv = process.env,
): MatOSDshSandboxMode {
  if (mode === 'plan') return 'read-only'
  if (env.MATOS_NESTED_SANDBOX_AVAILABLE === '0') return 'danger-full-access'
  return hasProject ? 'workspace-write' : 'danger-full-access'
}

// DSH tool names and the MatOS rule names they answer to.
const DSH_TOOL_RULE_NAMES: Record<string, string> = {
  read: 'Read', read_image: 'Read', write: 'Write', edit: 'Edit', str_replace_editor: 'Edit',
  glob: 'Glob', grep: 'Grep', bash: 'Bash', skill: 'Skill',
  web_fetch: 'WebFetch', web_search: 'WebSearch',
  subagent: 'Agent', subagent_fork: 'Agent', send_message: 'SendMessage',
  interrupt_agent: 'TaskStop', list_agents: 'TaskList', todo_write: 'TodoWrite',
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'TaskList', 'Skill'])
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell'])

/** Rule name for a DSH tool call; `str_replace_editor` view/create map to Read/Write. */
export function matOSToolRuleName(name: string, args: Record<string, unknown> = {}): string {
  if (name === 'str_replace_editor') {
    if (args.command === 'view') return 'Read'
    if (args.command === 'create') return 'Write'
  }
  return DSH_TOOL_RULE_NAMES[name] ?? name
}

type ParsedRule = { name: string; pattern?: string }

export function parseMatOSToolRule(rule: string): ParsedRule | undefined {
  const trimmed = rule.trim()
  if (!trimmed) return undefined
  const match = /^([A-Za-z0-9_.*-]+)\((.*)\)$/s.exec(trimmed)
  if (match) return { name: match[1]!, pattern: match[2]! }
  if (/^[A-Za-z0-9_.*-]+$/.test(trimmed)) return { name: trimmed }
  return undefined
}

/** Plain tool names named by a rule list, for restricting the DSH tool surface. */
export function matOSRuleToolNames(rules: readonly string[]): string[] {
  const names = new Set<string>()
  for (const rule of rules) {
    const parsed = parseMatOSToolRule(rule)
    if (parsed) names.add(parsed.name)
  }
  return [...names]
}

function ruleNameMatches(ruleName: string, toolName: string): boolean {
  if (ruleName.toLowerCase() === toolName.toLowerCase()) return true
  if (ruleName.includes('*')) return picomatch.isMatch(toolName, ruleName, { nocase: true })
  // `mcp__server` covers every tool of that server.
  return ruleName.startsWith('mcp__') && !ruleName.slice(5).includes('__') &&
    toolName.startsWith(`${ruleName}__`)
}

function rulePathGlob(pattern: string, cwd: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  if (pattern.startsWith('~/')) return join(homedir(), pattern.slice(2))
  if (pattern.startsWith('/')) return join(cwd, pattern)
  return join(cwd, pattern)
}

function requestPaths(args: Record<string, unknown>, cwd: string): string[] {
  const values = [args.file_path, args.path, args.notebook_path]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (values.length === 0 && (args.pattern !== undefined || args.glob !== undefined)) values.push('.')
  return values.map(value => resolve(cwd, value))
}

function patternMatches(rule: ParsedRule, toolName: string, args: Record<string, unknown>, cwd: string, denied = false): boolean {
  if (rule.pattern === undefined) return true
  const pattern = rule.pattern
  if (toolName === 'Bash') {
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2)
      return command === prefix || command.startsWith(`${prefix} `)
    }
    return picomatch.isMatch(command, pattern, { dot: true })
  }
  if (toolName === 'Skill') {
    const skill = String(args.name ?? args.skill ?? '').replace(/^\//, '')
    const wanted = pattern.replace(/^\//, '')
    return wanted.endsWith(':*') ? skill.startsWith(wanted.slice(0, -2)) : skill === wanted
  }
  if (toolName === 'WebFetch') {
    const url = typeof args.url === 'string' ? args.url : ''
    if (pattern.startsWith('domain:')) {
      try { return new URL(url).hostname === pattern.slice('domain:'.length) } catch { return false }
    }
    return picomatch.isMatch(url, pattern)
  }
  const glob = rulePathGlob(pattern, cwd)
  const paths = requestPaths(args, cwd)
  const canonicalGlob = canonicalPattern(glob)
  const match = (path: string, pattern: string) => picomatch.isMatch(path, pattern, { dot: true }) || picomatch.isMatch(path+'/', pattern, { dot: true })
  const checks = paths.map(path => {
    const real = canonicalPath(path)
    if (!real || !canonicalGlob) return denied
    return denied ? match(path,glob) || match(real,canonicalGlob) : match(real,canonicalGlob)
  })
  return checks.length > 0 && (denied ? checks.some(Boolean) : checks.every(Boolean))
}

function firstMatchingRule(rules: readonly string[], toolName: string, args: Record<string, unknown>, cwd: string, denied = false): string | undefined {
  for (const rule of rules) {
    const parsed = parseMatOSToolRule(rule)
    if (!parsed || !ruleNameMatches(parsed.name, toolName)) continue
    if (patternMatches(parsed, toolName, args, cwd, denied)) return rule
  }
  return undefined
}

function canonicalPath(path: string): string | undefined {
  let current=resolve(path)
  const tail:string[]=[]
  for(;;){
    try{return join(realpathSync(current),...tail.reverse())}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')return undefined
      const parent=dirname(current)
      if(parent===current)return undefined
      tail.push(basename(current));current=parent
    }
  }
}
function canonicalPattern(glob:string):string|undefined{
  const parts=glob.split('/')
  const index=parts.findIndex(part=>/[?*[{]/.test(part))
  if(index<0)return canonicalPath(glob)
  const prefix=parts.slice(0,index).join('/') || '/'
  const real=canonicalPath(prefix)
  return real ? join(real,...parts.slice(index)) : undefined
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readsInsideWorkspace(policy: MatOSToolPolicy, args: Record<string, unknown>): boolean {
  const roots = [policy.cwd, ...policy.additionalDirs]
  return requestPaths(args, policy.cwd).every(path => { const real=canonicalPath(path); return Boolean(real && roots.some(root=>{const target=canonicalPath(root);return target && inside(target,real)})) })
}

/**
 * Decide one DSH tool call. DSH still enforces its sandbox, project boundary
 * and tool surface; this adds MatOS rule semantics on top of them.
 */
export function decideMatOSToolPermission(policy: MatOSToolPolicy, request: MatOSToolRequest): MatOSToolDecision {
  if (request.signal?.aborted) return { behavior: 'deny', reason: 'MatOS tool request was cancelled' }
  const toolName = matOSToolRuleName(request.name, request.arguments)
  const args = request.arguments
  const denied = firstMatchingRule(policy.denyRules, toolName, args, policy.cwd, true)
  if (denied) return { behavior: 'deny', reason: `MatOS denied ${toolName} by rule ${denied}` }
  if (toolName === 'Bash') {
    const violation = matOSProcessKillViolation(typeof args.command === 'string' ? args.command : '')
    if (violation) return { behavior: 'deny', reason: violation }
  }
  if (policy.mode === 'plan') {
    const nativeQuery = /^mcp__matos_asset__(?:asset_(?:list|search|read|show|graph)|workflow_(?:list|inspect|validate|events|query|preflight)|conda_environment_catalog|atomistic_toolchain_catalog|local_toolchain_preflight|mlip_model_catalog|web_read|deep_research_search|document_parse)$/.test(toolName)
    const readOnly = READ_ONLY_TOOLS.has(toolName) || ['WebFetch','WebSearch'].includes(toolName) || nativeQuery
    return readOnly && !MUTATING_TOOLS.has(toolName)
      ? { behavior: 'allow' }
      : { behavior: 'deny', reason: 'MatOS plan mode permits read-only investigation only' }
  }
  if (policy.mode === 'dontAsk') {
    if (firstMatchingRule(policy.allowRules, toolName, args, policy.cwd)) return { behavior: 'allow' }
    if (READ_ONLY_TOOLS.has(toolName) && readsInsideWorkspace(policy, args)) return { behavior: 'allow' }
    return { behavior: 'deny', reason: `MatOS ${toolName} is not pre-approved for this run` }
  }
  return { behavior: 'allow' }
}

const KILL_MESSAGE = 'MatOS blocked process-name-wide pkill/killall: these can kill other tasks and recovery helpers. Stop your own tracked job with its task tool; for an untracked process verify its exact PID, start time, cwd and ownership before a targeted signal.'
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'sudo', 'time', 'nice', 'timeout', 'env', 'xargs'])
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh'])

function commandWords(command: string): string[][] {
  let tokens: ReturnType<typeof parseShell>
  try {
    tokens = parseShell(command, name => `$${name}`)
  } catch {
    throw new Error('MatOS cannot safely inspect this shell command')
  }
  const commands: string[][] = [[]]
  for (const token of tokens) {
    if (typeof token === 'string') {
      commands[commands.length - 1]!.push(token)
    } else if ('op' in token && token.op !== 'glob') {
      commands.push([])
    } else if ('pattern' in token) {
      commands[commands.length - 1]!.push(String(token.pattern))
    }
  }
  return commands.filter(words => words.length > 0)
}

function killsByName(words: string[], depth: number): boolean {
  let argv = words
  for (let step = 0; step < 16 && argv.length > 0; step++) {
    const name = basename(argv[0]!)
    if (name === 'pkill' || name === 'killall') return true
    if (SHELLS.has(name)) {
      const index = argv.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
      return index > 0 && depth < 4 ? inspectCommand(argv[index + 1] ?? '', depth + 1) : false
    }
    if (!WRAPPERS.has(name)) return false
    argv = argv.slice(1)
    while (argv[0] && (argv[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(argv[0]) || /^\d+(?:\.\d+)?[smhd]?$/.test(argv[0]))) {
      argv = argv.slice(1)
    }
  }
  return false
}

function inspectCommand(command: string, depth: number): boolean {
  if (command.length > 100_000) throw new Error('MatOS shell command is too long to inspect safely')
  return commandWords(command).some(words => killsByName(words, depth))
}

/** Guard against accidental process-name-wide kills; not an isolation boundary. */
export function matOSProcessKillViolation(command: string): string | undefined {
  try { return inspectCommand(command, 0) ? KILL_MESSAGE : undefined }
  catch (error) { return error instanceof Error ? error.message : 'MatOS could not inspect shell command' }
}
