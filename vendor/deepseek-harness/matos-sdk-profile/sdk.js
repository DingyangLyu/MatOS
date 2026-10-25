// MatOS additions to DSH's supported SDK server. The upstream server remains
// responsible for the agent loop, sessions, attachments, and lifecycle events.
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

export const name = 'matos-sdk'
export const inject = ['agents', 'workingDirectory', 'sessionPersistence']

let activePolicy
let activeTransport

export function currentMatOSTurnPolicy() { return activePolicy }

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Invalid MatOS turn ${field}`)
  }
  return [...value]
}

function configure(params) {
  if (!object(params) || typeof params.sessionId !== 'string' || !params.sessionId.trim()) {
    throw new Error('MatOS turn requires a session id')
  }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(params.permissionMode)) {
    throw new Error('Invalid MatOS turn permission mode')
  }
  if (params.maxTurns !== undefined && (!Number.isSafeInteger(params.maxTurns) || params.maxTurns <= 0)) {
    throw new Error('Invalid MatOS turn step limit')
  }
  if (activePolicy && activePolicy.sessionId !== params.sessionId) {
    throw new Error('MatOS SDK runtime is bound to a different session')
  }
  if (typeof params.systemPrompt !== 'string') throw new Error('Invalid MatOS turn system prompt')
  return Object.freeze({
    sessionId: params.sessionId,
    systemPrompt: params.systemPrompt,
    permissionMode: params.permissionMode,
    noTools: params.noTools === true,
    nativePermissions: params.nativePermissions === true,
    nativeExecutionTools: stringList(params.nativeExecutionTools, 'nativeExecutionTools'),
    allowedTools: stringList(params.allowedTools, 'allowedTools'),
    disallowedTools: stringList(params.disallowedTools, 'disallowedTools'),
    readRoots: stringList(params.readRoots, 'readRoots'),
    writeRoots: stringList(params.writeRoots, 'writeRoots'),
    ...(params.maxTurns === undefined ? {} : { maxTurns: params.maxTurns }),
  })
}

function nativeRequestParams(execution) {
  return {
    sessionId: String(execution.agent.session.id),
    rootSessionId: activePolicy?.sessionId,
    callId: execution.callId,
    name: execution.name,
    arguments: execution.arguments,
  }
}

export async function requestMatOSNativePermission(execution) {
  if (!activePolicy?.nativePermissions || !activeTransport) {
    return { behavior: 'deny', reason: 'Native MatOS permission channel is unavailable' }
  }
  const response = await activeTransport.request('matos/tool/permission', nativeRequestParams(execution), execution.signal)
  if (!object(response) || (response.behavior !== 'allow' && response.behavior !== 'deny')) {
    throw new Error('Invalid native MatOS permission response')
  }
  return response
}

export async function executeMatOSNativeTool(execution) {
  if (!activePolicy?.nativePermissions || !activeTransport ||
      !activePolicy.nativeExecutionTools.includes(execution.name)) {
    throw new Error('Native MatOS tool execution channel is unavailable')
  }
  const result = await activeTransport.request('matos/tool/execute', nativeRequestParams(execution), execution.signal)
  if (!object(result) || !Array.isArray(result.content) || typeof result.isError !== 'boolean') {
    throw new Error('Invalid native MatOS tool execution result')
  }
  return result
}

export function apply(ctx) {
  if (activeTransport) throw new Error('Only one MatOS SDK transport may own stdio')
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  activeTransport = transport
  const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false })
  const activeAgents = new Set()
  const removeStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' || status === 'stopped' || status === 'disposed') activeAgents.delete(String(agent.session.id))
    else activeAgents.add(String(agent.session.id))
  })
  const removeStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    transport.notify('session.stream', { sessionId: String(agent.session.id), frame })
  })
  let closing
  const close = () => {
    closing ??= (async () => {
      await transport.flush().catch(() => {})
      await ctx.root.fiber.dispose()
      process.exit(0)
    })()
    return closing
  }
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
      const initialized = await server.handleRequest(method, params)
      return { ...initialized, matosCapabilities: { turnContext: true, nativePermissions: true, nativeToolExecution: true, assistantStream: true, waitForSession: true, nativeHistory: true } }
    }
    if (method === 'matos/session/configure') {
      if (activeAgents.size) throw new Error('Cannot change MatOS policy during an active turn')
      activePolicy = configure(params)
      const stored = await ctx.sessionPersistence.stat(activePolicy.sessionId)
      return { configured: true, sessionId: activePolicy.sessionId, hasStoredSession: Boolean(stored) }
    }
    if (method === 'session/prompt' && (!activePolicy || params.sessionId !== activePolicy.sessionId)) {
      throw new Error('MatOS turn must be configured before submitting its prompt')
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') setImmediate(() => { void close() })
    return result
  })
  ctx.effect(() => {
    transport.start()
    return async () => {
      removeStatus()
      removeStream()
      await server.shutdown()
      transport.close()
      activeTransport = undefined
      activePolicy = undefined
    }
  }, 'matos.sdk.serve')
}
