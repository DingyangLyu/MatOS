// Map an Open Design native event onto the AG-UI canonical wire shape.
//
// The OD native union covers more than AG-UI cares about (e.g. internal
// daemon-control events). We project only what an external AG-UI client
// would meaningfully consume; unrecognised events return null and the
// daemon SSE relay drops them.

import type {
  AGUIAgentMessageEvent,
  AGUIEvent,
  AGUIRunLifecycleEvent,
  AGUIStateUpdateEvent,
  AGUIToolCallEvent,
} from './types.js';

// The PersistedAgentEvent variants OD emits on a run's SSE stream.
// We model the subset we map; the daemon may emit other shapes (errors,
// system messages, …) which the encoder drops.
export interface OdMessageChunkEvent {
  kind: 'message_chunk';
  runId?: string;
  text?: string;
  done?: boolean;
  ts?: number;
}

export interface OdToolCallEvent {
  kind: 'tool_call';
  runId?: string;
  toolName?: string;
  args?: unknown;
  callId?: string;
  status?: 'started' | 'completed' | 'failed';
  result?: unknown;
  ts?: number;
}

export interface OdStateUpdateEvent {
  kind: 'state_update';
  runId?: string;
  path?: string;
  value?: unknown;
  ts?: number;
}

export interface OdRunEndEvent {
  kind: 'end';
  runId?: string;
  status?: 'succeeded' | 'failed' | 'canceled' | 'completed';
  ts?: number;
}

export interface OdRunStartedEvent {
  kind: 'run_started';
  runId?: string;
  ts?: number;
}

export type OdNativeEvent =
  | OdMessageChunkEvent
  | OdToolCallEvent
  | OdStateUpdateEvent
  | OdRunEndEvent
  | OdRunStartedEvent;

export interface EncodeContext {
  // The run's id; OD may have it on the event already, but the daemon
  // SSE relay always knows it from the route, so we pass it in to keep
  // the encoder pure.
  runId: string;
  // Optional monotonic sequence the daemon assigns per-run. Phase 4's
  // SSE relay can pass design.runs.events[i].id directly.
  seq?: number;
  // Wall-clock fallback. The encoder uses this when the OD event
  // lacks `requestedAt` / `startedAt` / etc.
  now?: number;
}

export function encodeOdEventForAgui(
  event: OdNativeEvent,
  ctx: EncodeContext,
): AGUIEvent | null {
  const ts = ctx.now ?? Date.now();
  const base = { runId: ctx.runId, ts, ...(ctx.seq !== undefined ? { seq: ctx.seq } : {}) };
  switch (event.kind) {
    case 'message_chunk': {
      const out: AGUIAgentMessageEvent = {
        ...base,
        kind: 'agent.message',
        text: event.text ?? '',
      };
      if (event.done) out.done = true;
      return out;
    }
    case 'tool_call': {
      const out: AGUIToolCallEvent = {
        ...base,
        kind: 'tool_call',
        toolName: event.toolName ?? 'unknown',
        args: event.args ?? null,
      };
      if (event.callId) out.callId = event.callId;
      if (event.status) out.status = event.status;
      if (event.result !== undefined) out.result = event.result;
      return out;
    }
    case 'state_update': {
      const out: AGUIStateUpdateEvent = {
        ...base,
        kind: 'state_update',
        path: event.path ?? '',
        value: event.value ?? null,
      };
      return out;
    }
    case 'run_started': {
      const out: AGUIRunLifecycleEvent = { ...base, kind: 'run.lifecycle', status: 'started' };
      return out;
    }
    case 'end': {
      const status = event.status === 'failed' ? 'failed'
        : event.status === 'canceled' ? 'cancelled'
        : 'completed';
      const out: AGUIRunLifecycleEvent = { ...base, kind: 'run.lifecycle', status };
      return out;
    }
    default:
      return null;
  }
}
