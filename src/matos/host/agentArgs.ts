import { isMatOSPermissionMode, type MatOSPermissionMode } from './permissions.js'

export type MatOSAgentOutputFormat = 'text' | 'json' | 'stream-json'

export type MatOSAgentArgs = {
  prompt?: string
  print: boolean
  inputFormat: 'text' | 'stream-json'
  outputFormat: MatOSAgentOutputFormat
  includePartialMessages: boolean
  resume?: string
  sessionId?: string
  model?: string
  effort?: string
  maxTurns?: number
  permissionMode?: MatOSPermissionMode
  skipPermissions: boolean
  agentsFile?: string
  agent?: string
  systemPrompt?: string
  appendSystemPrompts: string[]
  appendSystemPromptFiles: string[]
  addDirs: string[]
  mcpConfigs: string[]
  allowedTools: string[]
  disallowedTools: string[]
  /** `undefined`: role/default surface; `[]`: no tools. */
  tools?: string[]
  noSessionPersistence: boolean
}

// Options accepted for compatibility with existing callers that carry no
// meaning for a DSH turn.
const IGNORED_VALUE_OPTIONS = new Set([
  '--fallback-model', '--max-budget-usd', '--task-budget', '--agent-id', '--agent-name',
  '--team-name', '--setting-sources', '--settings', '--plugin-dir', '--debug-file',
])
const IGNORED_FLAGS = new Set(['--verbose', '--bare', '--strict-mcp-config', '--debug', '-d', '--replay-user-messages'])
const VARIADIC_OPTIONS = new Set([
  '--add-dir', '--mcp-config', '--allowed-tools', '--allowedTools',
  '--disallowed-tools', '--disallowedTools', '--tools',
])

function splitList(values: string[]): string[] {
  return values.flatMap(value => value.split(/[\s,]+/)).map(value => value.trim()).filter(Boolean)
}

// Comma lists keep `Name(pattern, with, commas)` rules intact.
function splitRules(values: string[]): string[] {
  const rules: string[] = []
  for (const value of values) {
    let depth = 0
    let current = ''
    for (const char of value) {
      if (char === '(') depth++
      if (char === ')') depth = Math.max(0, depth - 1)
      if ((char === ',' || /\s/.test(char)) && depth === 0) {
        if (current.trim()) rules.push(current.trim())
        current = ''
        continue
      }
      current += char
    }
    if (current.trim()) rules.push(current.trim())
  }
  return rules
}

export class MatOSAgentArgsError extends Error {}

export function parseMatOSAgentArgs(argv: readonly string[]): MatOSAgentArgs {
  const parsed: MatOSAgentArgs = {
    print: false,
    inputFormat: 'text',
    outputFormat: 'text',
    includePartialMessages: false,
    skipPermissions: false,
    appendSystemPrompts: [],
    appendSystemPromptFiles: [],
    addDirs: [],
    mcpConfigs: [],
    allowedTools: [],
    disallowedTools: [],
    noSessionPersistence: false,
  }
  const positional: string[] = []
  let toolsSeen = false
  const tools: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const name = eq > 0 ? token.slice(0, eq) : token
    const inline = eq > 0 ? token.slice(eq + 1) : undefined
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[index + 1]
      if (next === undefined) throw new MatOSAgentArgsError(`${name} requires a value`)
      index++
      return next
    }
    const values = (): string[] => {
      if (inline !== undefined) return [inline]
      const collected: string[] = []
      while (index + 1 < argv.length && !(argv[index + 1]!.startsWith('-') && argv[index + 1] !== '')) {
        collected.push(argv[++index]!)
      }
      return collected
    }
    if (VARIADIC_OPTIONS.has(name)) {
      const list = values()
      if (name === '--add-dir') parsed.addDirs.push(...list)
      else if (name === '--mcp-config') parsed.mcpConfigs.push(...list)
      else if (name === '--allowed-tools' || name === '--allowedTools') parsed.allowedTools.push(...splitRules(list))
      else if (name === '--disallowed-tools' || name === '--disallowedTools') parsed.disallowedTools.push(...splitRules(list))
      else { toolsSeen = true; tools.push(...splitList(list)) }
      continue
    }
    switch (name) {
      case '-p':
      case '--print':
        parsed.print = true
        continue
      case '--input-format': {
        const format = value()
        if (format !== 'text' && format !== 'stream-json') throw new MatOSAgentArgsError(`Unsupported --input-format ${format}`)
        parsed.inputFormat = format
        continue
      }
      case '--output-format': {
        const format = value()
        if (format !== 'text' && format !== 'json' && format !== 'stream-json') throw new MatOSAgentArgsError(`Unsupported --output-format ${format}`)
        parsed.outputFormat = format
        continue
      }
      case '--include-partial-messages': parsed.includePartialMessages = true; continue
      case '--resume': case '-r': parsed.resume = value(); continue
      case '--session-id': parsed.sessionId = value(); continue
      case '--model': parsed.model = value(); continue
      case '--effort': parsed.effort = value(); continue
      case '--max-turns': {
        const turns = Number(value())
        if (!Number.isSafeInteger(turns) || turns <= 0) throw new MatOSAgentArgsError('--max-turns must be a positive integer')
        parsed.maxTurns = turns
        continue
      }
      case '--permission-mode': {
        const mode = value()
        if (!isMatOSPermissionMode(mode)) throw new MatOSAgentArgsError(`Unsupported --permission-mode ${mode}`)
        parsed.permissionMode = mode
        continue
      }
      case '--dangerously-skip-permissions': parsed.skipPermissions = true; continue
      case '--agents-file': parsed.agentsFile = value(); continue
      case '--agent': parsed.agent = value(); continue
      case '--system-prompt': parsed.systemPrompt = value(); continue
      case '--append-system-prompt': parsed.appendSystemPrompts.push(value()); continue
      case '--append-system-prompt-file': parsed.appendSystemPromptFiles.push(value()); continue
      case '--no-session-persistence': parsed.noSessionPersistence = true; continue
    }
    if (IGNORED_FLAGS.has(name)) continue
    if (IGNORED_VALUE_OPTIONS.has(name)) { value(); continue }
    if (token.startsWith('-') && token !== '-') throw new MatOSAgentArgsError(`Unsupported option ${token}`)
    positional.push(token)
  }
  if (toolsSeen) {
    if (tools.includes('default')) {
      if (tools.length !== 1) throw new MatOSAgentArgsError('Do not combine --tools default with explicit tool names')
    } else parsed.tools = tools
  }
  if (positional.length > 0) parsed.prompt = positional.join(' ')
  if (parsed.resume && parsed.sessionId && parsed.resume !== parsed.sessionId) {
    throw new MatOSAgentArgsError('--resume and --session-id name different sessions')
  }
  return parsed
}

/** Effective permission mode: explicit flag, then skip flag, then role default. */
export function effectiveMatOSPermissionMode(args: MatOSAgentArgs, roleDefault?: string): MatOSPermissionMode {
  if (args.permissionMode) return args.permissionMode
  if (args.skipPermissions) return 'bypassPermissions'
  return isMatOSPermissionMode(roleDefault) ? roleDefault : 'bypassPermissions'
}
