// Native MatOS uses per-call ownership metadata, which the generic DSH MCP
// plugin does not currently transmit. Keep DSH's canonical tool/result adapter
// and the MCP transport; only this internal, fixed tool server uses this bridge.
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { nativeMcpRequest } from './nativeMcpRequest.js'

export const name = 'matos-native-mcp'
export const inject = ['tools']

export async function apply(ctx, config) {
  if (config.serverName !== 'matos_asset' || config.transport !== 'stdio') {
    throw new Error('The native MatOS MCP bridge requires the internal stdio server')
  }
  let client
  let closed = false
  let connecting
  const connect = () => connecting ??= (async () => {
    if (closed) throw new Error('Native MatOS MCP bridge is disposed')
    if (client) return client
    const candidate = new Client({ name: 'matos-dsh-native', version: '1.0.0' }, {
      capabilities: {}, versionNegotiation: { mode: 'auto' },
    })
    const transport = new StdioClientTransport({
      command: config.command, args: config.args, cwd: config.cwd,
      env: { ...scrubbedParentEnv(), ...config.env },
    })
    let disconnected = false
    candidate.onclose = () => { disconnected = true; if (client === candidate) client = undefined }
    try {
      await candidate.connect(transport)
      if (closed || disconnected) throw new Error('Native MatOS MCP connection closed during startup')
      client = candidate
      return candidate
    } catch (error) {
      await candidate.close().catch(() => {})
      await transport.close().catch(() => {})
      throw error
    }
  })().finally(() => { connecting = undefined })
  // Reconnect on the next invocation after transport loss. Never retry a call
  // already sent: workflow start is a mutation and must not be duplicated.
  const dispose = async () => {
    closed = true
    await connecting?.catch(() => {})
    const previous = client
    client = undefined
    await previous?.close()
  }
  ctx.on('internal/plugin', fiber => {
    if (fiber === ctx.fiber && fiber.uid === null) return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'matos-native-mcp.connection')
  const initial = await connect()
  const { tools } = await initial.listTools()
  for (const tool of tools) {
    const publicName = 'mcp__matos_asset__' + tool.name
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(publicName)) throw new Error('Invalid native MatOS MCP tool name')
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: publicName, rawName: tool.name, description: tool.description ?? '',
      inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
      taskRequired: tool.execution?.taskSupport === 'required',
      async call(args, execution) {
        const request = nativeMcpRequest(tool.name, args, execution)
        const active = await connect()
        return active.callTool(request, {
          signal: execution.signal, timeout: config.toolCallTimeoutMs ?? 60_000, toolDefinition: tool,
        })
      },
    }))
  }
}
