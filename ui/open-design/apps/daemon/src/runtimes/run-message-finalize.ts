// Daemon-side run message persistence sink: create-time conversation-row
// scaffolding for API-only callers (scaffoldRunConversationMessages) plus
// run-terminal assistant-message finalization.
//
// Historically the pinned assistant message reached its final content through
// TWO writers: the daemon's live event persistence (server.ts `send()` ->
// `persistRunEventToAssistantMessage`) and the web client's finalize
// `PUT /api/projects/:id/conversations/:cid/messages/:mid` (content + events +
// `telemetryFinalized: true`). A client that only calls `POST /api/runs` and
// consumes SSE (mobile app, MCP/SDK callers) never does that PUT, which left
// two gaps: runs that failed before the agent stream existed had no persisted
// error event, and the native project-timeline outbox was only fed by the PUT
// route. This module closes both gaps at run terminal state.
//
// This file also owns the ONE projection from daemon run SSE events to
// `PersistedAgentEvent`s. Live persistence and terminal reconciliation must
// share it so a replayed history is byte-shaped the same regardless of which
// path persisted an event (mirrors the web's translateAgentEvent in
// apps/web/src/providers/daemon.ts).

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { appendMessageAgentEvents, upsertMessage } from '../db.js';
import { coalesceAdjacentStreamEvents } from '../message-payload.js';
import { enqueueProjectMessageAuthorityOutbox } from '../routes/project/message-authority-outbox.js';
import { messageAuthorityOutboxFlushHook } from '../routes/project/message-authority-flush-hook.js';
import { TERMINAL_RUN_STATUSES } from './runs.js';

type SqliteDb = Database.Database;

/** Loose persisted-event shape: `PersistedAgentEvent` plus daemon-only kinds
 *  such as `diagnostic` that the contract union does not carry. */
export type PersistedRunAgentEvent = { kind: string } & Record<string, unknown>;

export interface RunEventRecordLike {
  id?: number;
  event: string;
  data?: unknown;
  timestamp?: number;
}

export interface RunLikeForMessageFinalize {
  id?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  events?: RunEventRecordLike[] | null;
}

// Grace window between a daemon-triggered timeline enqueue and its delivery.
// An attached web client's finalize PUT usually lands within a second or two
// of the SSE `end` frame; its enqueue accelerates the same outbox record to
// "due now" (see enqueueProjectMessageAuthorityOutbox's earliest-wins
// conflict clause), and delivery always reads the CURRENT message row, so the
// client-assembled content is what reaches the native timeline — exactly as
// before this sink existed. Only when no client persists within the window
// does the daemon-accumulated row get delivered.
export const RUN_TERMINAL_TIMELINE_SYNC_GRACE_MS = 15_000;

// The legacy SSE-payload mappers below moved verbatim from server.ts (which
// is @ts-nocheck); they intentionally accept `any` because they normalize
// loosely-shaped runtime payloads defensively rather than trusting a type.

function normalizePersistedToolInput(input: any) {
  if (!input || typeof input !== 'object') return input;
  if ('filePath' in input && typeof input.filePath === 'string') {
    return { ...input, file_path: input.filePath };
  }
  return input;
}

export function daemonAgentPayloadToPersistedAgentEvent(data: any): PersistedRunAgentEvent | null {
  const type = data?.type;
  if (type === 'status' && typeof data.label === 'string') {
    const detail =
      typeof data.detail === 'string'
        ? data.detail
        : typeof data.model === 'string'
          ? data.model
          : typeof data.ttftMs === 'number'
            ? `first token in ${Math.round(data.ttftMs / 100) / 10}s`
            : undefined;
    return { kind: 'status', label: data.label, ...(detail ? { detail } : {}) };
  }
  if (type === 'text_delta' && typeof data.delta === 'string') {
    return { kind: 'text', text: data.delta };
  }
  if (type === 'conversation_title' && typeof data.title === 'string') {
    return { kind: 'conversation_title', title: data.title };
  }
  if (type === 'thinking_delta' && typeof data.delta === 'string') {
    return { kind: 'thinking', text: data.delta };
  }
  if (type === 'thinking_start') return { kind: 'status', label: 'thinking' };
  if (type === 'tool_use' && typeof data.id === 'string' && typeof data.name === 'string') {
    return { kind: 'tool_use', id: data.id, name: data.name, input: normalizePersistedToolInput(data.input) };
  }
  // Live-only incremental tool-input fragments are for real-time display only.
  // Returning null skips persistence so history replay isn't polluted with
  // mid-token JSON shards; the full `tool_use` above is the persisted record.
  if (type === 'tool_input_delta') return null;
  if (type === 'tool_result' && typeof data.toolUseId === 'string') {
    return {
      kind: 'tool_result',
      toolUseId: data.toolUseId,
      content: String(data.content ?? ''),
      isError: Boolean(data.isError),
    };
  }
  if (type === 'usage') {
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    return {
      kind: 'usage',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(typeof data.costUsd === 'number' ? { costUsd: data.costUsd } : {}),
      ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
    };
  }
  if (type === 'diagnostic' && typeof data.name === 'string') {
    return {
      kind: 'diagnostic',
      name: data.name,
      ...(typeof data.source === 'string' ? { source: data.source } : {}),
      ...(typeof data.elapsedMs === 'number' ? { elapsedMs: data.elapsedMs } : {}),
      ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
      ...(typeof data.suppressedChars === 'number' ? { suppressedChars: data.suppressedChars } : {}),
      ...(typeof data.suppressedChunks === 'number' ? { suppressedChunks: data.suppressedChunks } : {}),
      ...(typeof data.openedBlocks === 'number' ? { openedBlocks: data.openedBlocks } : {}),
      ...(typeof data.closedBlocks === 'number' ? { closedBlocks: data.closedBlocks } : {}),
      ...(typeof data.fileCount === 'number' ? { fileCount: data.fileCount } : {}),
      ...(Array.isArray(data.files) ? { files: data.files.filter((file: unknown) => typeof file === 'string').slice(0, 8) } : {}),
      ...(typeof data.pendingCandidateChars === 'number'
        ? { pendingCandidateChars: data.pendingCandidateChars }
        : {}),
      ...(typeof data.suppressing === 'boolean' ? { suppressing: data.suppressing } : {}),
      ...(data.shape && typeof data.shape === 'object' ? { shape: data.shape } : {}),
    };
  }
  if (type === 'fabricated_role_marker' && typeof data.marker === 'string') {
    return {
      kind: 'status',
      label: 'warning',
      detail: `Model emitted fabricated role marker ("${data.marker}"). Response was truncated at this point to prevent unauthorized instruction injection. See issue #3247.`,
    };
  }
  // Persist tool-loop warnings/halts so the signal survives a reload or history
  // replay. Without this the event is transient-only, and in
  // OD_TOOL_LOOP_GUARD=warn (no terminal TOOL_LOOP_DETECTED error) the user
  // would lose the only record that a loop was detected. Mirrors the live
  // mapping in apps/web/src/providers/daemon.ts so replayed and live views match.
  if (type === 'tool_loop' && typeof data.toolName === 'string') {
    const toolName = data.toolName;
    const count = typeof data.count === 'number' ? data.count : 0;
    const detail =
      data.action === 'halt'
        ? `Run stopped: the agent repeated a failing ${toolName} call ${count}× without progress. Re-check the actual target before retrying.`
        : `Heads up — the agent has repeated a failing ${toolName} call ${count}× and may be stuck.`;
    return { kind: 'status', label: 'warning', detail };
  }
  if (type === 'raw' && typeof data.line === 'string') return { kind: 'raw', line: data.line };
  return null;
}

export function runSseEventToPersistedAgentEvent(event: string, data: any): PersistedRunAgentEvent | null {
  if (event === 'start') {
    return {
      kind: 'status',
      label: 'starting',
      ...(typeof data?.bin === 'string' ? { detail: data.bin } : {}),
    };
  }
  if (event === 'stdout') {
    const chunk = typeof data?.chunk === 'string' ? data.chunk : '';
    return chunk ? { kind: 'text', text: chunk } : null;
  }
  if (event === 'error') {
    const message = typeof data?.error?.message === 'string'
      ? data.error.message
      : typeof data?.message === 'string'
        ? data.message
        : '';
    // `code` mirrors the web's persisted error-event shape
    // (apps/web/src/runtime/chat-events.ts appendErrorStatusEvent), so
    // API-only clients get the same error-specific affordance data a web
    // finalize PUT would have stored.
    const code = typeof data?.error?.code === 'string' ? data.error.code : '';
    return {
      kind: 'status',
      label: 'error',
      ...(message ? { detail: message } : {}),
      ...(code ? { code } : {}),
    };
  }
  if (event !== 'agent') return null;
  return daemonAgentPayloadToPersistedAgentEvent(data);
}

/** Final message projection assembled from a run's own SSE event records. */
export interface RunEventsMessageProjection {
  events: PersistedRunAgentEvent[];
  /** Concatenated visible text, byte-equal to what live persistence and the
   *  web client accumulate from the same stream (`stdout` chunks + agent
   *  `text_delta`s, in arrival order). */
  content: string;
}

export function assembleRunEventsMessageProjection(
  records: readonly RunEventRecordLike[] | null | undefined,
): RunEventsMessageProjection {
  const mapped: PersistedRunAgentEvent[] = [];
  for (const record of records ?? []) {
    if (!record || typeof record.event !== 'string') continue;
    const persisted = runSseEventToPersistedAgentEvent(record.event, record.data);
    if (persisted) mapped.push(persisted);
  }
  const events = (coalesceAdjacentStreamEvents(mapped) ?? []) as PersistedRunAgentEvent[];
  const content = mapped
    .filter(event => event.kind === 'text' && typeof event.text === 'string')
    .map(event => String(event.text))
    .join('');
  return { events, content };
}

export interface RunMessageScaffoldResult {
  /** The pinned assistant message id this run must use (caller-provided when
   *  present, otherwise daemon-generated). */
  assistantMessageId: string;
  /** Id of the user-turn row this call persisted, or null when the request
   *  carried no usable prompt text. */
  userMessageId: string | null;
}

/**
 * Create-time counterpart of the terminal finalize sink below: make sure the
 * conversation rows a run will write into actually exist for callers that
 * let the daemon own message persistence.
 *
 * `POST /api/runs` has two such populations (both route through this ONE
 * helper so the row shapes cannot drift):
 *   - MCP/SDK callers that send only `projectId` (the route resolves the
 *     project's default conversation first), and
 *   - API-only clients (mobile app, smoke scripts) that address an explicit
 *     `conversationId` but send no `assistantMessageId`.
 *
 * Behavior:
 *   - The assistant message id is the caller's when provided, else a fresh
 *     UUID; `pinAssistantMessageOnRunCreate` then creates the placeholder row
 *     that live persistence and `finalizeAssistantMessageFromRunEvents`
 *     write into, and the 202 response returns the id to the caller.
 *   - The user turn is persisted from `currentPrompt` first — contractually
 *     "the latest user turn only" (see ChatRequest) — falling back to
 *     `message`, which web-style callers overload with the whole rendered
 *     transcript but API-only callers use for single-turn text. Row shape
 *     mirrors the pre-existing MCP fallback: role 'user', raw content,
 *     startedAt/endedAt stamps.
 */
export function scaffoldRunConversationMessages(input: {
  db: SqliteDb;
  conversationId: string;
  requestedAssistantMessageId?: unknown;
  message?: unknown;
  currentPrompt?: unknown;
  now?: number;
}): RunMessageScaffoldResult {
  const assistantMessageId =
    typeof input.requestedAssistantMessageId === 'string' && input.requestedAssistantMessageId
      ? input.requestedAssistantMessageId
      : randomUUID();
  const turnPrompt =
    typeof input.currentPrompt === 'string' && input.currentPrompt.trim().length > 0
      ? input.currentPrompt
      : typeof input.message === 'string' && input.message.trim().length > 0
        ? input.message
        : null;
  let userMessageId: string | null = null;
  if (turnPrompt) {
    userMessageId = randomUUID();
    const now = input.now ?? Date.now();
    upsertMessage(input.db, input.conversationId, {
      id: userMessageId,
      role: 'user',
      content: turnPrompt,
      startedAt: now,
      endedAt: now,
    });
  }
  return { assistantMessageId, userMessageId };
}

export type RunMessageFinalizeDecision =
  | 'no-assistant-message'
  | 'missing-row'
  | 'client-finalized'
  | 'assembled-from-run-events'
  | 'kept-live-persisted';

export interface RunMessageFinalizeOutcome {
  decision: RunMessageFinalizeDecision;
  /** Terminal error events recovered from the run record that live
   *  persistence had missed (emitted outside the agent-stream `send()`). */
  appendedErrorEvents: number;
  /** True when this finalize enqueued a native project-timeline delivery. */
  timelineSyncEnqueued: boolean;
}

function parseEventsJson(value: unknown): PersistedRunAgentEvent[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Finalize the pinned assistant message when its run reaches a terminal
 * state, so clients that never PUT the assembled message (mobile app,
 * MCP/SDK callers) still read complete history from GET messages and the
 * native project timeline.
 *
 * Client-PUT-priority rule (the daemon must never downgrade a client write):
 *
 * 1. `messages.telemetry_finalized_at` is set ONLY by a client's finalize
 *    `PUT .../messages/:mid` carrying `telemetryFinalized: true` (see
 *    upsertMessage). When it is set, the client owns the final content and
 *    events, except that authoritative run success removes stale terminal
 *    error statuses and repairs a client-side `failed` stamp caused by a
 *    transient gateway/SSE disconnect. The daemon does not enqueue a timeline
 *    delivery for a client-finalized row (the PUT route already enqueued one).
 *    A client PUT that lands AFTER this finalize simply replaces the row and
 *    re-enqueues; the outbox delivers whatever the row holds at flush time, so
 *    the client's content still wins the native timeline.
 * 2. When the row already holds live-persisted (or client-streamed) content
 *    or events, the daemon never replaces them — the run's in-memory event
 *    record is capped (createChatRunService maxEvents) and could only lose
 *    information. It appends at most the terminal `error` status events that
 *    were emitted outside the agent stream (runs.fail / direct emits) and
 *    are therefore missing from the row.
 * 3. Only a row with no content AND no events (a run that failed before the
 *    agent stream produced anything, or whose live persistence failed) gets
 *    the full projection assembled from the run event record.
 * 4. Failed/canceled runs keep their truthful partial content — nothing
 *    synthesizes a complete-looking answer; the persisted error status event
 *    plus `run_status` carry the failure. Timeline delivery follows the same
 *    predicate as the client PUT route (assistant + terminal status +
 *    non-empty content), so an empty failed/canceled turn never produces a
 *    misleading native-timeline entry.
 *
 * Must stay synchronous: SQLite access is serialized on the JS thread, so a
 * read-decide-write with no awaits cannot interleave with a concurrent
 * client PUT.
 */
export function finalizeAssistantMessageFromRunEvents(input: {
  db: SqliteDb;
  run: RunLikeForMessageFinalize;
  finalStatus: string;
  now?: number;
  timelineSyncDelayMs?: number;
}): RunMessageFinalizeOutcome {
  const { db, run, finalStatus } = input;
  const messageId = typeof run.assistantMessageId === 'string' ? run.assistantMessageId : '';
  if (!messageId) {
    return { decision: 'no-assistant-message', appendedErrorEvents: 0, timelineSyncEnqueued: false };
  }
  // The run record is authoritative. A browser can temporarily stamp the
  // message failed when its SSE reconnect receives an nginx 502 even though
  // the daemon keeps running and later succeeds. Repair that false failure on
  // success, while preserving an explicit client cancellation.
  const finalizedAt = input.now ?? Date.now();
  if (finalStatus === 'succeeded') {
    db.prepare(
      `UPDATE messages
          SET run_status = 'succeeded', ended_at = ?
        WHERE id = ? AND run_status IN ('queued', 'running', 'failed')`,
    ).run(finalizedAt, messageId);
  } else {
    db.prepare(
      `UPDATE messages
          SET run_status = ?, ended_at = COALESCE(ended_at, ?)
        WHERE id = ? AND run_status IN ('queued', 'running')`,
    ).run(finalStatus, finalizedAt, messageId);
  }

  const row = db.prepare(
    `SELECT role, content, events_json AS eventsJson, run_status AS runStatus,
            telemetry_finalized_at AS telemetryFinalizedAt
       FROM messages WHERE id = ?`,
  ).get(messageId) as {
    role?: string;
    content?: string | null;
    eventsJson?: string | null;
    runStatus?: string | null;
    telemetryFinalizedAt?: number | null;
  } | undefined;
  if (!row) {
    return { decision: 'missing-row', appendedErrorEvents: 0, timelineSyncEnqueued: false };
  }
  let rowEvents = parseEventsJson(row.eventsJson);
  if (finalStatus === 'succeeded') {
    const recoveredEvents = rowEvents.filter(
      event => !(event.kind === 'status' && event.label === 'error'),
    );
    if (recoveredEvents.length !== rowEvents.length) {
      db.prepare(`UPDATE messages SET events_json = ? WHERE id = ?`)
        .run(JSON.stringify(recoveredEvents), messageId);
      rowEvents = recoveredEvents;
    }
  }
  if (row.telemetryFinalizedAt != null) {
    return { decision: 'client-finalized', appendedErrorEvents: 0, timelineSyncEnqueued: false };
  }

  const rowContent = typeof row.content === 'string' ? row.content : '';
  const projection = assembleRunEventsMessageProjection(run.events);

  let decision: RunMessageFinalizeDecision = 'kept-live-persisted';
  let appendedErrorEvents = 0;
  if (rowContent.length === 0 && rowEvents.length === 0 && projection.events.length > 0) {
    // appendMessageAgentEvents is the live-persistence primitive: it appends
    // the text deltas to `content` and coalesces stream events, so the
    // reconciled row is byte-shaped exactly like a live-persisted one.
    appendMessageAgentEvents(db, messageId, projection.events);
    decision = 'assembled-from-run-events';
  } else {
    const missingErrorEvents = (run.events ?? [])
      .filter(record => record?.event === 'error')
      .map(record => runSseEventToPersistedAgentEvent('error', record.data))
      .filter((event): event is PersistedRunAgentEvent => event !== null)
      .filter(event => {
        const serialized = JSON.stringify(event);
        return !rowEvents.some(existing => JSON.stringify(existing) === serialized);
      });
    if (missingErrorEvents.length > 0) {
      appendMessageAgentEvents(db, messageId, missingErrorEvents);
      appendedErrorEvents = missingErrorEvents.length;
    }
  }

  // Native project-timeline sync. Same eligibility the client PUT route uses
  // (shouldPersistMessageToProjectTimeline): assistant role, terminal run
  // status, non-empty content. The flush loop re-validates with the
  // authoritative predicate before delivering, and the native timeline
  // dedupes by the deterministic `od-message-<id>` event id, so a client PUT
  // that also enqueues this message cannot double-deliver.
  let timelineSyncEnqueued = false;
  const projectId = typeof run.projectId === 'string' ? run.projectId : '';
  const conversationId = typeof run.conversationId === 'string' ? run.conversationId : '';
  if (projectId && conversationId && row.role === 'assistant') {
    const finalRow = db.prepare(
      `SELECT content, run_status AS runStatus FROM messages WHERE id = ?`,
    ).get(messageId) as { content?: string | null; runStatus?: string | null } | undefined;
    if (
      finalRow &&
      String(finalRow.content ?? '').trim().length > 0 &&
      TERMINAL_RUN_STATUSES.has(String(finalRow.runStatus ?? ''))
    ) {
      const delayMs = input.timelineSyncDelayMs ?? RUN_TERMINAL_TIMELINE_SYNC_GRACE_MS;
      enqueueProjectMessageAuthorityOutbox(db, {
        messageId,
        projectId,
        conversationId,
        delayMs,
      });
      messageAuthorityOutboxFlushHook.current?.(delayMs);
      timelineSyncEnqueued = true;
    }
  }
  return { decision, appendedErrorEvents, timelineSyncEnqueued };
}
