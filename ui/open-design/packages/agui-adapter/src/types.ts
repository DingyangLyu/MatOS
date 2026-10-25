// AG-UI canonical event types (subset).
//
// These mirror the wire shape that CopilotKit / agent-protocol clients
// expect (see https://github.com/CopilotKit/CopilotKit). We pin the
// minimum surface OD currently needs:
//
//   - agent.message            run-level streaming text
//   - tool_call                run-level tool invocation
//   - state_update             keyed state delta the front-end stores
//   - run.lifecycle            run started / completed / cancelled
//
// OD's native PersistedAgentEvent union maps onto this set bidirectionally.

export type AGUIEventKind =
  | 'agent.message'
  | 'tool_call'
  | 'state_update'
  | 'run.lifecycle';

export interface AGUIEventBase {
  // Event kind discriminator. Stable across protocol versions.
  kind: AGUIEventKind;
  // The OD run id this event belongs to.
  runId: string;
  // Monotonic per-run sequence number. Lets a reconnecting client
  // resume from a specific point.
  seq?: number;
  // Wall-clock timestamp (unix ms) when the event was emitted.
  ts: number;
}

export interface AGUIAgentMessageEvent extends AGUIEventBase {
  kind: 'agent.message';
  // Streaming chunk text. Concatenate across consecutive
  // agent.message events to reconstruct the assistant turn.
  text: string;
  // True for the final chunk (other consumers can flush their buffer).
  done?: boolean;
}

export interface AGUIToolCallEvent extends AGUIEventBase {
  kind: 'tool_call';
  toolName: string;
  // The arguments the agent passed; pre-validation per the upstream
  // tool's schema. JSON values only.
  args: unknown;
  // Optional id correlating multiple tool_call events that resolve
  // to the same single call (start + result).
  callId?: string;
  status?: 'started' | 'completed' | 'failed';
  result?: unknown;
}

export interface AGUIStateUpdateEvent extends AGUIEventBase {
  kind: 'state_update';
  // Path the front-end should merge into its run-state cache.
  // Dot-segmented keys; the agent-protocol convention is that empty
  // path = replace whole state.
  path: string;
  value: unknown;
}

export interface AGUIRunLifecycleEvent extends AGUIEventBase {
  kind: 'run.lifecycle';
  status: 'started' | 'completed' | 'cancelled' | 'failed';
  message?: string;
}

export type AGUIEvent =
  | AGUIAgentMessageEvent
  | AGUIToolCallEvent
  | AGUIStateUpdateEvent
  | AGUIRunLifecycleEvent;
