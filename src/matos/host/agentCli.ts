import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { withMatOSToolCompletionErrorKind } from '../learning/toolErrorKind.js'
import { deepSeekModelCosts } from '../provider/modelPricing.js'
import {
  disposeMatOSDeepSeekHarnessPool,
  executeMatOSDeepSeekHarnessTurn,
  type MatOSDeepSeekHarnessNotification,
} from '../runtime/deepseekHarnessEngine.js'
import type { MatOSEventInput } from '../sessions/eventTypes.js'
import { recordMatOSTraceEventFromEnv } from '../sessions/traceBridge.js'
import { scrubSecretsFromString } from '../sessions/traceContext.js'
import { createWorkflowRunWatcher } from '../workflows/runPulse.js'
import {
  effectiveMatOSPermissionMode,
  MatOSAgentArgsError,
  parseMatOSAgentArgs,
  type MatOSAgentArgs,
} from './agentArgs.js'
import {
  createDshEventProjector,
  dshUsageToAnthropic,
  mapEffortToDeepSeek,
  record,
  userContentToDshBlocks,
} from './dshEvents.js'
import {
  matOSAgentDefinition,
  planMatOSDshTurn,
  readMatOSMcpConfigValues,
  type MatOSDshTurnPlan,
} from './dshTurn.js'
import {
  decideMatOSToolPermission,
  dshSandboxModeFor,
  matOSToolRuleName,
  type MatOSPermissionMode,
} from './permissions.js'

type RecordValue = Record<string, unknown>

export type MatOSAgentCliIO = {
  cwd: string
  env: NodeJS.ProcessEnv
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Records MatOS trace events; defaults to the env trace context. */
  recordEvent?: (event: MatOSEventInput) => Promise<unknown>
  /** Process signal hookup; tests pass their own controller. */
  signal?: AbortSignal
}

type TurnUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

const DEFAULT_MODEL = 'deepseek-flash'

function isDeepSeekModel(model: string | undefined): model is string {
  return typeof model === 'string' && /^deepseek[-\w.[\]]*$/i.test(model.trim())
}

function textOf(content: RecordValue[]): string {
  return content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('')
}

function preview(value: unknown, max = 500): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return scrubSecretsFromString(text ?? '').slice(0, max)
}

function costUsd(model: string, usage: TurnUsage): number {
  const costs = deepSeekModelCosts(model)
  if (!costs) return 0
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens)
  return (uncached * costs.inputTokens + usage.cacheWriteTokens * costs.promptCacheWriteTokens +
    usage.cacheReadTokens * costs.promptCacheReadTokens + usage.outputTokens * costs.outputTokens) / 1_000_000
}

class LineQueue {
  private readonly items: RecordValue[][] = []
  private waiter: (() => void) | undefined
  closed = false
  push(blocks: RecordValue[]): void { this.items.push(blocks); this.wake() }
  close(): void { this.closed = true; this.wake() }
  shift(): RecordValue[] | undefined { return this.items.shift() }
  get size(): number { return this.items.length }
  wake(): void { const waiter = this.waiter; this.waiter = undefined; waiter?.() }
  wait(): Promise<void> { return new Promise(resolve => { this.waiter = resolve }) }
}

/** Read prompts from stdin: stream-json user lines, or one text prompt. */
function readStdinPrompts(args: MatOSAgentArgs, io: MatOSAgentCliIO, queue: LineQueue, onError: (message: string) => void): void {
  if (args.inputFormat === 'stream-json') {
    const lines = createInterface({ input: io.stdin, crlfDelay: Infinity })
    lines.on('line', line => {
      if (!line.trim()) return
      try {
        const message = record(JSON.parse(line))
        if (message.type !== 'user') return
        const blocks = userContentToDshBlocks(record(message.message).content)
        if (blocks.length) queue.push(blocks)
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
      }
    })
    lines.on('close', () => queue.close())
    return
  }
  let text = ''
  io.stdin.setEncoding?.('utf8')
  io.stdin.on('data', chunk => { text += String(chunk) })
  io.stdin.on('end', () => {
    if (text.trim()) queue.push([{ type: 'text', text }])
    queue.close()
  })
  io.stdin.on('error', () => queue.close())
}

export async function runMatOSAgentCli(argv: readonly string[], io: MatOSAgentCliIO): Promise<number> {
  if (io.signal?.aborted) return 143
  let args: MatOSAgentArgs
  try {
    args = parseMatOSAgentArgs(argv)
  } catch (error) {
    io.stderr(`${error instanceof MatOSAgentArgsError ? error.message : String(error)}\n`)
    return 2
  }
  const env: NodeJS.ProcessEnv = { ...io.env }
  const recordEvent = io.recordEvent ?? ((event: MatOSEventInput) => recordMatOSTraceEventFromEnv(event, env.MATOS_PROJECT_CWD || io.cwd, env))
  // Child runs whose parent mirrors their stdout record only tool events.
  const recordTurnStarted = env.MATOS_DISABLE_CHILD_TURN_STARTED_TRACE !== '1'
  const recordTurnEvents = env.MATOS_DISABLE_QUERYENGINE_TRACE_BRIDGE !== '1'
  let plan: MatOSDshTurnPlan
  let permissionMode: MatOSPermissionMode
  try {
    const agents = args.agentsFile ? record(JSON.parse(await readFile(args.agentsFile, 'utf8'))) as Record<string, Record<string, unknown>> : {}
    const agent = matOSAgentDefinition(agents, args.agent)
    if (args.agent && !agent) throw new Error(`Unknown agent ${args.agent}`)
    const appendSystemPrompt = [
      ...args.appendSystemPrompts,
      ...await Promise.all(args.appendSystemPromptFiles.map(file => readFile(file, 'utf8'))),
    ]
    const projectMcpConfigJson = await readMatOSMcpConfigValues([], io.cwd)
    const mcpConfigJson = [
      ...await readMatOSMcpConfigValues(args.mcpConfigs, io.cwd, false),
      ...projectMcpConfigJson,
    ]
    const projectCwd = env.MATOS_PROJECT_CWD || io.cwd
    plan = planMatOSDshTurn({
      cwd: io.cwd,
      ...(env.MATOS_ROLE_REF ? { roleReference: env.MATOS_ROLE_REF } : {}),
      ...(env.MATOS_PROJECT_ID ? { projectAccess: { projectCwd, projectId: env.MATOS_PROJECT_ID, memberId: env.MATOS_PROJECT_MEMBER_ID ?? '' } } : {}),
      materializationDirs: args.addDirs,
      ...(agent ? { agent } : {}),
      appendSystemPrompt,
      mcpConfigJson,
      projectMcpConfigJson,
      ...(args.tools !== undefined ? { tools: args.tools } : {}),
      extraDenyRules: args.disallowedTools,
      ...(args.systemPrompt !== undefined ? { systemPromptOverride: composePromptOverride(args.systemPrompt, appendSystemPrompt) } : {}),
    })
    permissionMode = effectiveMatOSPermissionMode(args, agent?.permissionMode)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (permissionMode === 'plan') {
    plan.systemPrompt += '\n\nThis turn is read-only investigation. Read project files and use read-only query tools; do not edit files, run shell commands, or start jobs. Describe proposed changes instead of executing them.'
  }
  const agent = plan.agent
  const model = isDeepSeekModel(args.model) ? args.model.trim()
    : isDeepSeekModel(agent?.model) ? agent.model.trim()
    : env.MATOS_DSH_MODEL?.trim() || env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL
  let reasoningEffort: ReturnType<typeof mapEffortToDeepSeek>
  try {
    reasoningEffort = mapEffortToDeepSeek(args.effort ?? (typeof agent?.effort === 'string' ? agent.effort : undefined) ?? env.MATOS_DSH_EFFORT)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const maxTurns = args.maxTurns ?? agent?.maxTurns
  const sessionId = args.resume ?? args.sessionId ?? randomUUID()
  const hasProject = Boolean(env.MATOS_PROJECT_CWD || env.MATOS_PROJECT_ID)
  const sandboxMode = dshSandboxModeFor(permissionMode, hasProject, env)
  const extraRoots = args.addDirs
  const policy = {
    mode: permissionMode,
    cwd: io.cwd,
    additionalDirs: extraRoots,
    allowRules: args.allowedTools,
    denyRules: plan.denyRules,
  }
  const turnEnv: Record<string, string | undefined> = {
    ...env,
    ...plan.env,
    MATOS_DSH_MODEL: model,
    MATOS_SESSION_ID: env.MATOS_SESSION_ID ?? sessionId,
    MATOS_WORKFLOW_SESSION_ID: sessionId,
  }
  const timeoutMs = Number(env.MATOS_DSH_TIMEOUT_MS) > 0 ? Number(env.MATOS_DSH_TIMEOUT_MS) : undefined
  const stream = args.outputFormat === 'stream-json'
  const interactive = !args.print && args.prompt === undefined && io.stdin.isTTY === true
  const write = (message: RecordValue): void => {
    if (stream) io.stdout(`${JSON.stringify({ ...message, session_id: sessionId, uuid: randomUUID() })}\n`)
  }
  const controller = new AbortController()
  const abort = () => controller.abort(io.signal?.reason)
  if (io.signal?.aborted) abort()
  else io.signal?.addEventListener('abort', abort, { once: true })

  write({
    type: 'system', subtype: 'init', cwd: io.cwd, model, permissionMode,
    tools: plan.toolSurface, mcp_servers: [], apiKeySource: env.DEEPSEEK_API_KEY ? 'environment' : 'none', agent: args.agent ?? null,
  })

  const queue = new LineQueue()
  let inputError: string | undefined
  let promptHook: (() => void) | undefined
  if (interactive) {
    // A minimal line REPL: each line is one turn.
    const lines = createInterface({ input: io.stdin, output: process.stderr, terminal: true, prompt: '> ' })
    lines.prompt()
    lines.on('line', line => {
      const text = line.trim()
      if (text === 'exit' || text === 'quit') { lines.close(); return }
      if (text) queue.push([{ type: 'text', text }])
      else lines.prompt()
    })
    lines.on('close', () => queue.close())
    promptHook = () => lines.prompt()
  } else if (args.prompt !== undefined) {
    queue.push([{ type: 'text', text: args.prompt }])
    if (args.inputFormat === 'stream-json') readStdinPrompts(args, io, queue, message => { inputError = message })
    else queue.close()
  } else {
    readStdinPrompts(args, io, queue, message => { inputError = message })
  }

  const hiddenWorker = env.MATOS_INTERNAL_HIDDEN_RUN === '1' || Boolean(env.MATOS_EVOLUTION_JOB_ID)
  const watcher = hiddenWorker ? undefined : createWorkflowRunWatcher({
    cwd: env.MATOS_PROJECT_CWD || io.cwd,
    sessionId,
    onNotification: notification => {
      queue.push([{ type: 'text', text: notification.message }])
    },
  })
  watcher?.start()

  let exitCode = 0
  let firstTurn = true
  let lastResult: RecordValue | undefined
  try {
    for (;;) {
      if (controller.signal.aborted) { exitCode = 143; break }
      const blocks = queue.shift()
      if (!blocks) {
        if (queue.closed) {
          await watcher?.tick().catch(() => [])
          if (queue.size > 0) continue
          if (!watcher?.hasPendingRuns()) break
        }
        await Promise.race([queue.wait(), new Promise(resolve => setTimeout(resolve, 5_000))])
        continue
      }
      if (firstTurn && agent?.initialPrompt) blocks.unshift({ type: 'text', text: agent.initialPrompt })
      firstTurn = false
      const turn = await runTurn(blocks)
      lastResult = turn.result
      if (turn.exitCode !== 0) exitCode = turn.exitCode
      if (interactive) promptHook?.()
    }
  } finally {
    watcher?.stop()
    io.signal?.removeEventListener('abort', abort)
    write({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await disposeMatOSDeepSeekHarnessPool().catch(() => undefined)
  }
  if (inputError) io.stderr(`MatOS ignored an invalid stream-json input line: ${inputError}\n`)
  if (args.outputFormat === 'json' && lastResult) io.stdout(`${JSON.stringify({ ...lastResult, session_id: sessionId })}\n`)
  return exitCode

  async function runTurn(contentBlocks: RecordValue[]): Promise<{ exitCode: number; result: RecordValue }> {
    const started = Date.now()
    const turnId = randomUUID()
    const promptText = textOf(contentBlocks)
    if (recordTurnStarted) await recordEvent({
      type: 'matos.turn.started',
      traceContext: { turnId },
      data: {
        promptPreview: preview(promptText),
        promptLength: promptText.length,
        inputKind: 'content_blocks',
        imageCount: contentBlocks.filter(block => block.type === 'image').length,
        agentEngine: 'deepseek-harness',
      },
    }).catch(() => undefined)
    write({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    const project = createDshEventProjector()
    const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const toolNames = new Map<string, string>()
    let steps = 0
    let finalText = ''
    let streamedText = false
    const pending: Promise<unknown>[] = []
    const onNotification = (notification: MatOSDeepSeekHarnessNotification): void => {
      for (const item of project(notification)) {
        if (item.type === 'stream_start') {
          steps++
          if (args.includePartialMessages) {
            write({ type: 'stream_event', parent_tool_use_id: null, event: {
              type: 'message_start',
              message: { id: item.id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: dshUsageToAnthropic(undefined) },
            } })
          }
        } else if (item.type === 'stream_event') {
          if (args.includePartialMessages) write({ type: 'stream_event', parent_tool_use_id: null, event: item.event })
          const delta = record(item.event.delta)
          if (interactive && delta.type === 'text_delta' && typeof delta.text === 'string') {
            io.stdout(delta.text)
            streamedText = true
          }
        } else if (item.type === 'assistant') {
          const raw = record(item.usage)
          usage.inputTokens += Number(raw.inputTokens ?? 0)
          usage.outputTokens += Number(raw.outputTokens ?? 0)
          usage.cacheReadTokens += Number(raw.cacheReadTokens ?? 0)
          usage.cacheWriteTokens += Number(raw.cacheWriteTokens ?? 0)
          const hasToolUse = item.content.some(block => block.type === 'tool_use')
          write({ type: 'assistant', parent_tool_use_id: null, message: {
            id: item.id ?? randomUUID(), type: 'message', role: 'assistant', model: item.model ?? model,
            content: item.content, stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null,
            usage: dshUsageToAnthropic(item.usage),
          } })
          const text = textOf(item.content)
          if (text) {
            finalText = text
            if (recordTurnEvents) pending.push(recordEvent({ type: 'matos.agent.message', traceContext: { turnId }, data: { agentEngine: 'deepseek-harness', text: preview(text, 20_000) } }).catch(() => undefined))
          }
          for (const block of item.content) {
            if (block.type !== 'tool_use') continue
            const name = String(block.name)
            toolNames.set(String(block.id), name)
            pending.push(recordEvent({ type: 'matos.tool.call.started', traceContext: { turnId }, data: {
              source: 'dsh', toolUseId: block.id, toolName: matOSToolRuleName(name, record(block.input)), dshToolName: name,
              input: block.input, isMcp: name.startsWith('mcp__'),
            } }).catch(() => undefined))
          }
        } else if (item.type === 'tool_result') {
          write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: item.callId, content: item.content, is_error: item.isError },
          ] } })
          const name = toolNames.get(item.callId) ?? ''
          const resultText = textOf(item.content)
          pending.push(recordEvent({ type: 'matos.tool.call.completed', traceContext: { turnId }, data: withMatOSToolCompletionErrorKind({
            source: 'dsh', toolUseId: item.callId, toolName: matOSToolRuleName(name), dshToolName: name,
            isError: item.isError, isMcp: name.startsWith('mcp__'),
            ...(item.isError ? { error: preview(resultText, 2_000) } : {}),
            resultPreview: preview(resultText, 2_000),
          }) }).catch(() => undefined))
        }
      }
    }
    const result = await executeMatOSDeepSeekHarnessTurn({
      cwd: io.cwd,
      ...(env.MATOS_SCOPE_REF ? { scopeRef: env.MATOS_SCOPE_REF } : {}),
      env: turnEnv as NodeJS.ProcessEnv,
      matosSessionId: sessionId,
      prompt: '',
      contentBlocks,
      systemPrompt: plan.systemPrompt,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      noTools: plan.noTools,
      permissionMode: sandboxMode,
      readRoots: [...extraRoots],
      writeRoots: permissionMode === 'plan' ? [] : [...extraRoots],
      onToolPermission: async request => decideMatOSToolPermission(policy, request),
      signal: controller.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      keepAlive: true,
      onNotification,
    })
    await Promise.all(pending)
    if (!finalText && result.finalText) finalText = result.finalText
    if (interactive) io.stdout(streamedText ? '\n' : `${finalText}\n`)
    else if (args.outputFormat === 'text' && finalText) io.stdout(finalText.endsWith('\n') ? finalText : `${finalText}\n`)
    const maxTurnsReached = Boolean(result.error?.includes('maximum steps reached'))
    const isError = result.exitCode !== 0
    if (isError && result.error && !stream) io.stderr(`${result.error}\n`)
    if (isError && stream) {
      // Surface the failure as an assistant error message, as stream-json consumers expect.
      write({ type: 'assistant', parent_tool_use_id: null, error: maxTurnsReached ? 'max_turns' : 'unknown', message: {
        id: randomUUID(), type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: result.error ?? 'DeepSeek Harness turn failed' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: dshUsageToAnthropic(undefined),
      } })
    }
    const resultMessage: RecordValue = {
      type: 'result',
      subtype: !isError ? 'success' : maxTurnsReached ? 'error_max_turns' : 'error_during_execution',
      is_error: isError,
      duration_ms: Date.now() - started,
      duration_api_ms: Date.now() - started,
      num_turns: steps,
      result: isError && !finalText ? (result.error ?? 'DeepSeek Harness turn failed') : finalText,
      stop_reason: isError ? null : 'end_turn',
      total_cost_usd: costUsd(model, usage),
      usage: dshUsageToAnthropic({ ...usage }),
      modelUsage: { [model]: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadTokens, cacheCreationInputTokens: usage.cacheWriteTokens, costUSD: costUsd(model, usage) } },
      permission_denials: [],
      ...(result.aborted ? { terminal_reason: 'aborted' } : {}),
      ...(result.timedOut ? { terminal_reason: 'timeout' } : {}),
      ...(isError && result.error ? { errors: [result.error] } : {}),
    }
    write(resultMessage)
    if (recordTurnEvents) await recordEvent({
      type: 'matos.transcript.linked',
      traceContext: { turnId },
      data: { source: 'deepseek-harness.session-events', sessionId: result.sessionId, path: result.eventLogPath },
    }).catch(() => undefined)
    if (recordTurnEvents) await recordEvent({
      type: 'matos.turn.completed',
      traceContext: { turnId },
      data: { exitCode: result.exitCode, agentEngine: 'deepseek-harness', numTurns: steps, totalCostUsd: resultMessage.total_cost_usd, durationMs: resultMessage.duration_ms, ...(result.error ? { error: preview(result.error, 2_000) } : {}) },
    }).catch(() => undefined)
    return { exitCode: result.aborted ? 143 : result.exitCode, result: resultMessage }
  }
}


function composePromptOverride(systemPrompt: string, append: readonly string[]): string {
  return [systemPrompt, ...append].map(part => part.trim()).filter(Boolean).join('\n\n')
}
