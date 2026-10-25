// MatOS group chat: daemon-owned dispatch continuation hook.
//
// `reconcileAssistantMessageOnRunEnd` (server.ts) is the single choke point
// that observes EVERY run reaching a terminal state — streamed web runs whose
// tab is still open, web runs whose tab closed mid-run, and durable queued
// group tasks. The conversations route module owns the group-task queue and
// registers the continuation here at startup; server.ts fires it after the
// terminal message-status update without importing the queue machinery
// (which would be a server.ts -> routes/project -> server-context cycle).
//
// The continuation itself is idempotent (deterministic task ids keyed on the
// finished turn), so racing callers — this hook, the PUT message finalize
// route, and the durable-task completion handler — converge on one dispatch.

export interface GroupDispatchTerminalTurn {
  projectId: string | null | undefined;
  conversationId: string | null | undefined;
  assistantMessageId: string;
  runId: string | null | undefined;
  finalStatus: string;
}

export const projectGroupDispatchHook: {
  current: ((turn: GroupDispatchTerminalTurn) => void) | null;
} = { current: null };
