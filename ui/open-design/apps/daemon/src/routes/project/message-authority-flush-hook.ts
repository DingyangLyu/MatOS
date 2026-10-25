// Daemon-side assistant-message timeline sync: outbox flush scheduling hook.
//
// `finalizeAssistantMessageFromRunEvents` (src/runtimes/run-message-finalize.ts)
// runs at every run terminal state and may enqueue a
// `project_message_authority_outbox` record so API-only clients (mobile app,
// MCP/SDK callers) get the same native project-timeline delivery a web PUT
// triggers. The outbox flush loop — its timer, in-flight guard, and the matos
// CLI delivery — is owned by `registerProjectConversationRoutes`
// (routes/project/conversations.ts), which registers the scheduler here at
// startup. This mirrors `group-dispatch-hook.ts`: server.ts-side run finalize
// code fires the hook without importing the conversations route closure
// (which would create a server.ts -> routes/project -> server-context cycle).
//
// If the hook has not been registered yet (impossible in practice: routes are
// registered before any run can be created), the enqueued record is still
// durable in SQLite and is picked up by the next scheduled outbox flush.

export const messageAuthorityOutboxFlushHook: {
  current: ((delayMs: number) => void) | null;
} = { current: null };
