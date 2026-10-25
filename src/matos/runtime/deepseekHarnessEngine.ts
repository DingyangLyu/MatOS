import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MatOSEnv } from './runtimeEnv.js'
import { ensureMatOSDshHome, resolveMatOSAgentEngineScope } from './dshHome.js'

export type MatOSDeepSeekHarnessNotification = { method: string; params: Record<string, unknown> }
export type MatOSDeepSeekToolRequest = {
  sessionId: string; callId: string; name: string; arguments: Record<string, unknown>; signal?: AbortSignal
}
export type MatOSDeepSeekToolPermission = { behavior: 'allow' | 'deny'; reason?: string }
export type MatOSDeepSeekToolResult = { content: Array<Record<string, unknown>>; isError: boolean }
export type MatOSDeepSeekHarnessTurnInput = {
  cwd: string; scopeRef?: string; env?: MatOSEnv; matosSessionId: string; prompt: string
  systemPrompt?: string
  contentBlocks?: Array<Record<string, unknown>>
  nativeHistoryContext?: string
  maxTokens?: number
  reasoningEffort?: string
  maxTurns?: number
  noTools?: boolean
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Extra directories DSH file tools may read or write outside the project. */
  readRoots?: string[]
  writeRoots?: string[]
  onToolPermission?: (request: MatOSDeepSeekToolRequest) => Promise<MatOSDeepSeekToolPermission>
  onToolExecute?: (request: MatOSDeepSeekToolRequest) => Promise<MatOSDeepSeekToolResult>
  signal?: AbortSignal; timeoutMs?: number; keepAlive?: boolean; onNotification?: (notification: MatOSDeepSeekHarnessNotification) => void
}
export type MatOSDeepSeekHarnessTurnResult = {
  exitCode: number; sessionId: string; finalText: string; notifications: MatOSDeepSeekHarnessNotification[]
  timedOut?: boolean; aborted?: boolean; error?: string
  eventLogPath?: string
}

type RuntimeConfig = { executable: string; profile: string; provider: string; model: string; cwd: string; dshHome: string; env: MatOSEnv; maxTokens?: number; reasoningEffort?: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type SessionBinding = {
  notify: (notification: MatOSDeepSeekHarnessNotification) => void; closed: boolean; rootSessionId: string
  permission?: MatOSDeepSeekHarnessTurnInput['onToolPermission']
  execute?: MatOSDeepSeekHarnessTurnInput['onToolExecute']
  signal?: AbortSignal
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.map(block => { const item = record(block); return item?.type === 'text' && typeof item.text === 'string' ? item.text : '' }).filter(Boolean).join('')
}
function assistantTextFromEvent(event: unknown): string {
  const root = record(event); if (root?.type !== 'assistant/message') return ''
  return textFromContent(record(record(root.data)?.message)?.content)
}
function envValue(env: MatOSEnv, key: string): string | undefined { const value = env[key]?.trim(); return value || undefined }

function sanitizeDshEvent(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[depth-limited]'
  if (/(token|secret|password|api[_-]?key|credential|authorization|cookie)/i.test(key)) return undefined
  if (typeof value === 'string') return value.slice(0, 20_000)
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeDshEvent(item, key, depth + 1)).filter(item => item !== undefined)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value)) {
      const safe = sanitizeDshEvent(child, childKey, depth + 1)
      if (safe !== undefined) out[childKey] = safe
    }
    return out
  }
  return value
}

/** Convert native MatOS MCP config JSON into DSH mcp-client plugin instances. */
export function matOSProjectionToDeepSeekMcpConfig(values: readonly string[]): string | undefined {
  const output: Array<Record<string, unknown>> = []
  for (const encoded of values) {
    let parsed: unknown
    try { parsed = JSON.parse(encoded) } catch { continue }
    const servers = record(parsed)?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue
    for (const [rawName, rawConfig] of Object.entries(servers)) {
      const config = record(rawConfig)
      if (!config) continue
      const serverName = rawName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
      if (!serverName) continue
      const common = { serverName, toolCallTimeoutMs: 60_000, failOnStartupError: false }
      if (typeof config.url === 'string' && config.url.trim()) {
        output.push({ ...common, transport: 'streamable-http', url: config.url.trim(), headers: record(config.headers) ?? {} })
        continue
      }
      if (typeof config.command !== 'string' || !config.command.trim()) continue
      const sourceEnv = record(config.env) ?? {}
      // This is the native MCP process configuration, not an audit record.
      // It travels through the private child environment/authenticated daemon
      // channel. Redacting credentials here silently breaks authenticated tools.
      const processEnv = Object.fromEntries(Object.entries(sourceEnv).filter(([, value]) => typeof value === 'string'))
      output.push({ ...common, transport: 'stdio', command: config.command, args: Array.isArray(config.args) ? config.args.filter(item => typeof item === 'string') : [], env: processEnv, cwd: typeof config.cwd === 'string' ? config.cwd : '' })
    }
  }
  return output.length > 0 ? JSON.stringify(output) : undefined
}

/** Encode native MatOS MCP server entries for the DSH MCP plugin. */
export function matOSMcpServerEntriesToDeepSeekConfig(
  entries: readonly { name: string; config: unknown }[],
): string | undefined {
  return matOSProjectionToDeepSeekMcpConfig(
    entries.map(entry => JSON.stringify({ mcpServers: { [entry.name]: entry.config } })),
  )
}
function bundledLauncherPath(): string { return fileURLToPath(new URL('../../../scripts/matos-dsh-launcher.sh', import.meta.url)) }
function terminate(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch { /* process exited concurrently */ }
}

/** A persistent DSH SDK process. Notifications are demultiplexed by sessionId. */
class DeepSeekHarnessRuntime {
  readonly key: string
  private readonly config: RuntimeConfig
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Pending>()
  private readonly sessions = new Map<string, SessionBinding>()
  private serial = 0
  private buffer = ''
  private stderr = ''
  private deadError: Error | undefined
  private initPromise: Promise<void> | undefined
  private readonly closePromise: Promise<void>
  private closeResolve!: () => void

  constructor(config: RuntimeConfig, private readonly onBroken: (runtime: DeepSeekHarnessRuntime) => void, poolKey?: string) {
    this.config = config
    this.key = poolKey ?? [config.executable, config.profile, config.provider, config.model, config.cwd, config.dshHome].join('|')
    this.child = spawn(config.executable, ['--profile', config.profile], {
      cwd: config.cwd,
      env: {
        ...config.env,
        DSH_HOME: config.dshHome,
        DSH_PERMISSION_MODE: config.env.MATOS_DSH_PERMISSION_MODE ?? (config.env.MATOS_PROJECT_CWD ? 'workspace-write' : 'danger-full-access'),
      },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdin.on('error', error => this.markBroken(error))
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8')
    this.closePromise = new Promise(resolve => { this.closeResolve = resolve })
    this.child.stdout.on('data', (chunk: string) => this.read(chunk))
    this.child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000) })
    this.child.on('error', error => this.markBroken(error instanceof Error ? error : new Error(String(error))))
    this.child.on('close', (code, signal) => {
      this.closeResolve()
      this.markBroken(new Error(`DSH runtime exited${code !== null ? ` (exit ${code})` : ` (${signal ?? 'unknown signal'})`}`))
    })
  }

  private markBroken(error: Error): void {
    if (this.deadError) return
    this.deadError = error
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
    for (const binding of this.sessions.values()) binding.notify({ method: 'runtime.error', params: { error: error.message } })
    this.sessions.clear(); this.onBroken(this)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.markBroken(new Error('DSH protocol frame exceeds 16 MiB'))
      this.kill()
      return
    }
    const lines = this.buffer.split('\n'); this.buffer = lines.pop() ?? ''
    for (const line of lines) this.readLine(line)
  }
  private readLine(line: string): void {
    if (!line.trim()) return
    let parsed: unknown; try { parsed = JSON.parse(line) as unknown } catch { this.markBroken(new Error('Invalid DSH protocol JSON')); this.kill(); return }
    const message = record(parsed); if (!message) return
    if ('id' in message && typeof message.method === 'string') {
      void this.handleNativeRequest(message)
      return
    }
    if ('id' in message && !('method' in message)) {
      const entry = this.pending.get(String(message.id)); if (!entry) return
      this.pending.delete(String(message.id))
      const rpcError = record(message.error)
      if (rpcError) entry.reject(new Error(String(rpcError.message ?? 'DSH JSON-RPC error')))
      else entry.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    const params = record(message.params) ?? {}
    const notification = { method: message.method, params }
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (sessionId) this.sessions.get(sessionId)?.notify(notification)
    if (message.method === 'subagent.started' || message.method === 'subagent.finished') {
      for (const binding of this.sessions.values()) {
        if (binding.rootSessionId === params.parentSessionId || binding.rootSessionId === params.childSessionId) binding.notify(notification)
      }
    }
  }

  private async handleNativeRequest(message: Record<string, unknown>): Promise<void> {
    const params = record(message.params)
    const rootSessionId = typeof params?.rootSessionId === 'string' ? params.rootSessionId : ''
    const binding = this.sessions.get(rootSessionId)
    try {
      if (!binding || binding.closed || binding.signal?.aborted || !params ||
          typeof params.sessionId !== 'string' || typeof params.callId !== 'string' ||
          typeof params.name !== 'string' || !record(params.arguments)) {
        throw new Error('No active native MatOS tool context')
      }
      const request: MatOSDeepSeekToolRequest = {
        sessionId: params.sessionId, callId: params.callId, name: params.name,
        arguments: record(params.arguments)!, signal: binding.signal,
      }
      let result: MatOSDeepSeekToolPermission | MatOSDeepSeekToolResult
      if (message.method === 'matos/tool/permission' && binding.permission) result = await binding.permission(request)
      else if (message.method === 'matos/tool/execute' && binding.execute) result = await binding.execute(request)
      else throw new Error('Native MatOS tool callback is unavailable')
      if (binding.closed || binding.signal?.aborted) throw new Error('Native MatOS turn is no longer active')
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    } catch (error) {
      if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }) + '\n')
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.deadError) return Promise.reject(this.deadError)
    const id = `matos_${++this.serial}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) } catch (error) {
        this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  async initialize(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.request('initialize', { cwd: this.config.cwd, provider: this.config.provider, model: this.config.model, ...(this.config.maxTokens ? { maxTokens: this.config.maxTokens } : {}), ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}) }).then(value => {
      if (record(record(value)?.serverInfo)?.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected DSH SDK identity')
      const capabilities = record(record(value)?.matosCapabilities)
      if (!capabilities?.turnContext || !capabilities?.nativePermissions || !capabilities?.nativeToolExecution || !capabilities?.assistantStream || !capabilities?.waitForSession || !capabilities?.nativeHistory) throw new Error('DSH profile is missing native MatOS SDK integration')
    }).catch(error => { this.markBroken(error); throw error })
    return this.initPromise
  }
  attach(sessionId: string, binding: SessionBinding): void {
    if (this.sessions.has(sessionId)) throw new Error(`DSH session is already active: ${sessionId}`)
    this.sessions.set(sessionId, binding)
  }
  detach(sessionId: string): void { this.sessions.delete(sessionId) }
  prompt(sessionId: string, contentBlocks: Array<Record<string, unknown>>): Promise<unknown> {
    return this.request('session/prompt', { sessionId, contentBlocks })
  }
  waitForSession(sessionId: string): Promise<unknown> { return this.request('session/wait', { sessionId }) }
  configureTurn(params: Record<string, unknown>): Promise<unknown> { return this.request('matos/session/configure', params) }
  private stopTask?: Promise<void>
  async stop(): Promise<void> {
    this.stopTask ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!this.deadError) await Promise.race([
          this.request('shutdown', {}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DSH shutdown timed out')), 2000) }),
        ]).catch(() => undefined)
      } finally {
        if (timer) clearTimeout(timer)
        this.child.stdin.end()
        const closeTimer = setTimeout(() => terminate(this.child, 'SIGTERM'), 500)
        const killTimer = setTimeout(() => terminate(this.child, 'SIGKILL'), 1500)
        try { await this.closePromise } finally { clearTimeout(closeTimer); clearTimeout(killTimer) }
      }
    })()
    return this.stopTask
  }
  kill(): void {
    terminate(this.child, 'SIGTERM')
    const timer = setTimeout(() => terminate(this.child, 'SIGKILL'), 500)
    void this.closePromise.finally(() => clearTimeout(timer))
  }
  getError(): string { return this.stderr }
}

const runtimes = new Map<string, DeepSeekHarnessRuntime>()
function runtimeFor(config: RuntimeConfig, sessionId: string): DeepSeekHarnessRuntime {
  // The SDK protocol has no per-session cancel RPC. Keep one runtime per MatOS
  // session so a cancellation can kill only that session's process. The process
  // remains persistent across turns for that session.
  const turnKeys = new Set(['MATOS_DSH_ROLE_PROMPT', 'MATOS_DSH_NO_TOOLS', 'MATOS_DSH_ALLOWED_TOOLS', 'MATOS_DSH_DISALLOWED_TOOLS', 'MATOS_DSH_MAX_TURNS', 'MATOS_DSH_PERMISSION_MODE', 'MATOS_DSH_REQUIRE_NATIVE_PERMISSIONS', 'MATOS_DSH_NATIVE_EXECUTION_TOOLS', 'MATOS_DSH_TIMEOUT_MS'])
  const environmentDigest = createHash('sha256').update(JSON.stringify(Object.entries(config.env).filter(([key]) => !/^MATOS_(?:TRACE|TURN)_/.test(key) && !turnKeys.has(key)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
  const key = JSON.stringify([config.executable, config.profile, config.provider, config.model, config.cwd, config.dshHome, sessionId, environmentDigest, config.maxTokens, config.reasoningEffort])
  const existing = runtimes.get(key)
  if (existing) return existing
  const runtime = new DeepSeekHarnessRuntime(config, dead => { if (runtimes.get(dead.key) === dead) runtimes.delete(dead.key) }, key)
  runtimes.set(key, runtime)
  return runtime
}
/** Test/maintenance hook: gracefully stop all persistent DSH processes. */
export async function disposeMatOSDeepSeekHarnessPool(): Promise<void> {
  const active = [...runtimes.values()]; runtimes.clear(); await Promise.all(active.map(runtime => runtime.stop()))
}

/** Run one turn through a persistent DSH SDK JSON-RPC profile. */
export async function executeMatOSDeepSeekHarnessTurn(input: MatOSDeepSeekHarnessTurnInput): Promise<MatOSDeepSeekHarnessTurnResult> {
  input.signal?.throwIfAborted()
  for (const [name, value] of [['maxTokens', input.maxTokens], ['maxTurns', input.maxTurns]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer`)
  }
  const env = { ...(input.env ?? process.env),
    MATOS_DSH_NATIVE_SDK: '1',
    MATOS_DSH_REQUIRE_NATIVE_PERMISSIONS: input.onToolPermission ? '1' : (input.env?.MATOS_DSH_REQUIRE_NATIVE_PERMISSIONS ?? '0'),
    ...(input.permissionMode ? { MATOS_DSH_PERMISSION_MODE: input.permissionMode } : {}),
    ...(input.noTools !== undefined ? { MATOS_DSH_NO_TOOLS: input.noTools ? '1' : '0' } : {}),
    ...(input.maxTurns ? { MATOS_DSH_MAX_TURNS: String(input.maxTurns) } : {}),
  }
  const scope = await resolveMatOSAgentEngineScope({ cwd: input.cwd, scopeRef: input.scopeRef, env })
  const dshHome = await ensureMatOSDshHome(scope, env)
  const config: RuntimeConfig = {
    executable: envValue(env, 'MATOS_DSH_BIN') ?? (existsSync(bundledLauncherPath()) ? bundledLauncherPath() : 'dsh'), profile: envValue(env, 'MATOS_DSH_PROFILE') ?? 'sdk',
    provider: envValue(env, 'MATOS_DSH_PROVIDER') ?? 'deepseek-official', model: envValue(env, 'MATOS_DSH_MODEL') ?? envValue(env, 'DEEPSEEK_MODEL') ?? 'deepseek-flash', cwd: input.cwd, dshHome, env, maxTokens: input.maxTokens, reasoningEffort: input.reasoningEffort,
  }
  const sessionId = input.matosSessionId; const notifications: MatOSDeepSeekHarnessNotification[] = []
  const eventLogPath = envValue(env, 'MATOS_DSH_EVENT_LOG') ?? join(dshHome, 'matos-events', encodeURIComponent(sessionId) + '.jsonl')
  const runtime = runtimeFor(config, sessionId); let eventWrite = mkdir(dirname(eventLogPath), { recursive: true }).catch(() => undefined); let finalText = ''; let runtimeError: string | undefined; let promptReceiptSeen = false;  let promptReceiptIds = new Set<string>(); let turnEndSeen = false; let turnCompleted = false;
  let promptMessageId: string | undefined
  const binding: SessionBinding = { rootSessionId: sessionId, closed: false, permission: input.onToolPermission, execute: input.onToolExecute, signal: input.signal, notify: notification => {
    notifications.push(notification); eventWrite = eventWrite.then(() => appendFile(eventLogPath, JSON.stringify({ timestamp: new Date().toISOString(), ...record(sanitizeDshEvent(notification)) }) + '\n')).catch(() => undefined); input.onNotification?.(notification)
    const event = record(notification.params.event)
    if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
      const text = assistantTextFromEvent(event); if (text) finalText = text
      const data = record(event?.data); const reason = record(data?.reason); const detail = record(reason?.error)
      if (event?.type === 'agent/inbox/spliced') {
        const inserted = Array.isArray(data?.inserted) ? data.inserted : []
        for (const item of inserted) {
          const id = record(item)?.id
          if (typeof id === 'string') promptReceiptIds.add(id)
        }
        if (promptMessageId !== undefined && promptReceiptIds.has(promptMessageId)) promptReceiptSeen = true
      }
      if (event?.type === 'turn/end') {
        turnEndSeen = true
        turnCompleted = reason?.kind === 'completed'
        if (!turnCompleted) runtimeError = typeof detail?.message === 'string' ? detail.message : `DSH turn ended with ${String(reason?.kind ?? 'unknown reason')}`
      }
    }
  }}
  let attached = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    const ms = input.timeoutMs ?? 30 * 60 * 1000
    timeout = setTimeout(() => reject(new Error(`DSH turn timed out after ${ms}ms`)), ms)
    abort = () => reject(new Error('DSH turn aborted'))
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
  })
  // A pending protocol request rejects if its runtime exits.
  void cancelled.catch(() => undefined)
  try {
    runtime.attach(sessionId, binding)
    attached = true
    await Promise.race([runtime.initialize(), cancelled])
    const envList = (key: string): string[] => {
      const value = env[key as keyof typeof env]
      if (!value) return []
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('Invalid MatOS DSH policy list: ' + key)
      return parsed
    }
    if (env.MATOS_DSH_REQUIRE_NATIVE_PERMISSIONS === '1' && !input.onToolPermission) throw new Error('Native MatOS permission callback is required')
    const configured = await Promise.race([runtime.configureTurn({
      sessionId,
      systemPrompt: input.systemPrompt ?? envValue(env, 'MATOS_DSH_ROLE_PROMPT') ?? '',
      permissionMode: input.permissionMode ?? envValue(env, 'MATOS_DSH_PERMISSION_MODE') ?? (envValue(env as MatOSEnv, 'MATOS_PROJECT_CWD') ? 'workspace-write' : 'danger-full-access'),
      noTools: input.noTools ?? envValue(env, 'MATOS_DSH_NO_TOOLS') === '1',
      nativePermissions: Boolean(input.onToolPermission),
      nativeExecutionTools: input.onToolExecute ? envList('MATOS_DSH_NATIVE_EXECUTION_TOOLS') : [],
      allowedTools: envList('MATOS_DSH_ALLOWED_TOOLS'),
      disallowedTools: envList('MATOS_DSH_DISALLOWED_TOOLS'),
      ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
      ...(input.readRoots?.length ? { readRoots: input.readRoots } : {}),
      ...(input.writeRoots?.length ? { writeRoots: input.writeRoots } : {}),
    }), cancelled])
    const contentBlocks = input.contentBlocks ?? [{ type: 'text', text: input.prompt }]
    const firstContent = record(configured)?.hasStoredSession === false && input.nativeHistoryContext
      ? [{ type: 'text', text: input.nativeHistoryContext }, ...contentBlocks] : contentBlocks
    await Promise.race([
      runtime.prompt(sessionId, firstContent).then(value => {
        const receipt = record(value)?.messageId
        if (typeof receipt !== 'string' || !receipt) throw new Error('DSH prompt receipt is missing')
        promptMessageId = receipt
        promptReceiptSeen = promptReceiptIds.has(receipt)
      }), cancelled,
    ])
    // SDK 0.2 waits for managed descendants as well as the root turn. A root
    // idle notification alone can arrive while a child is still running.
    await Promise.race([runtime.waitForSession(sessionId), cancelled])
    if (!promptReceiptSeen) throw new Error('DSH prompt was not observed in the session inbox')
    return { exitCode: runtimeError || !turnEndSeen || !turnCompleted ? 1 : 0, sessionId, finalText, notifications, eventLogPath, ...(runtimeError ? { error: runtimeError } : {}) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); const timedOut = message.startsWith('DSH turn timed out'); const aborted = input.signal?.aborted === true || message === 'DSH turn aborted'
    if (attached) {
      runtimes.delete(runtime.key)
      runtime.kill()
      await runtime.stop()
    }
    return { exitCode: 1, sessionId, finalText, notifications, eventLogPath, ...(aborted ? { aborted: true } : {}), ...(timedOut ? { timedOut: true } : {}), error: runtime.getError() ? `${message}: ${runtime.getError()}` : message }
  } finally {
    await eventWrite.catch(() => undefined)
    if (timeout) clearTimeout(timeout)
    if (abort && input.signal) input.signal.removeEventListener('abort', abort)
    binding.closed = true
    if (attached) runtime.detach(sessionId)
    if (attached && !input.keepAlive) {
      runtimes.delete(runtime.key)
      await runtime.stop()
    }
  }
}
