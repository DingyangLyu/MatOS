// Identity comes from the executing DSH session, never tool arguments or the
// long-lived MCP server's environment.
export function nativeMcpRequest(name, args, execution) {
  const sessionId = execution.agent?.session?.id
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Native MatOS MCP call requires its executing session')
  }
  return { name, arguments: args, _meta: { 'matos/nativeSessionId': sessionId } }
}
