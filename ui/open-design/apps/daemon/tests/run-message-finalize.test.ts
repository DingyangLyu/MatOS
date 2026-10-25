import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendMessageAgentEvents,
  closeDatabase,
  insertConversation,
  insertProject,
  listMessages,
  listMessagesForChat,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import {
  listProjectMessageAuthorityOutbox,
  nextProjectMessageAuthorityOutboxDelay,
} from '../src/routes/project/message-authority-outbox.js';
import { messageAuthorityOutboxFlushHook } from '../src/routes/project/message-authority-flush-hook.js';
import {
  assembleRunEventsMessageProjection,
  finalizeAssistantMessageFromRunEvents,
  RUN_TERMINAL_TIMELINE_SYNC_GRACE_MS,
  runSseEventToPersistedAgentEvent,
  scaffoldRunConversationMessages,
  type RunEventRecordLike,
} from '../src/runtimes/run-message-finalize.js';

// The daemon-side persistence sink for API-only clients (mobile app, MCP/SDK
// callers that POST /api/runs + consume SSE and never PUT the assembled
// message). At run terminal state the daemon must leave the pinned assistant
// message complete (content + events + terminal run status) and feed the
// native project-timeline outbox — without ever downgrading a web client's
// finalize PUT. See finalizeAssistantMessageFromRunEvents's
// client-PUT-priority rule.

type SqliteDb = ReturnType<typeof openDatabase>;

const PROJECT_ID = 'project-1';
const CONVERSATION_ID = 'conversation-1';
const MESSAGE_ID = 'assistant-1';
const RUN_ID = 'run-1';

function seedConversation(db: SqliteDb): void {
  const now = Date.now();
  insertProject(db, { id: PROJECT_ID, name: 'P', createdAt: now, updatedAt: now });
  insertConversation(db, {
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: 'C',
    createdAt: now,
    updatedAt: now,
  });
}

/** Mirrors pinAssistantMessageOnRunCreate: empty placeholder, run wired up. */
function pinAssistantMessage(db: SqliteDb): void {
  upsertMessage(db, CONVERSATION_ID, {
    id: MESSAGE_ID,
    role: 'assistant',
    content: '',
    events: [],
    runId: RUN_ID,
    runStatus: 'running',
    startedAt: Date.now(),
  });
}

/** Replays run SSE records through the live-persistence primitive, exactly
 *  like server.ts persistRunEventToAssistantMessage -> flushRunMessageEvents. */
function livePersist(db: SqliteDb, records: RunEventRecordLike[]): void {
  const events = records
    .map(record => runSseEventToPersistedAgentEvent(record.event, record.data))
    .filter((event): event is NonNullable<typeof event> => event !== null);
  if (events.length > 0) appendMessageAgentEvents(db, MESSAGE_ID, events);
}

function runFor(events: RunEventRecordLike[]) {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    assistantMessageId: MESSAGE_ID,
    events,
  };
}

function messageRow(db: SqliteDb) {
  const message = listMessages(db, CONVERSATION_ID).find((m: any) => m.id === MESSAGE_ID);
  expect(message).toBeDefined();
  return message as any;
}

function outboxRows(db: SqliteDb): Array<{ message_id: string; next_attempt_at: number }> {
  return db.prepare(
    `SELECT message_id, next_attempt_at FROM project_message_authority_outbox`,
  ).all() as Array<{ message_id: string; next_attempt_at: number }>;
}

const streamedRecords: RunEventRecordLike[] = [
  { id: 1, event: 'start', data: { bin: 'matos' } },
  { id: 2, event: 'agent', data: { type: 'status', label: 'running', model: 'role:compute' } },
  { id: 3, event: 'agent', data: { type: 'text_delta', delta: 'Hello ' } },
  { id: 4, event: 'agent', data: { type: 'text_delta', delta: 'world.' } },
  {
    id: 5,
    event: 'agent',
    data: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } },
  },
  {
    id: 6,
    event: 'agent',
    data: { type: 'tool_result', toolUseId: 'tool-1', content: 'ok', isError: false },
  },
  {
    id: 7,
    event: 'agent',
    data: { type: 'usage', usage: { input_tokens: 10, output_tokens: 4 } },
  },
];

describe('finalizeAssistantMessageFromRunEvents', () => {
  let tempDir: string;
  let db: SqliteDb;
  let flushDelays: number[];

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-run-message-finalize-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    seedConversation(db);
    flushDelays = [];
    messageAuthorityOutboxFlushHook.current = (delayMs: number) => {
      flushDelays.push(delayMs);
    };
  });

  afterEach(() => {
    messageAuthorityOutboxFlushHook.current = null;
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('API-only success: keeps live-persisted content, stamps status, enqueues one delayed timeline delivery', () => {
    pinAssistantMessage(db);
    livePersist(db, streamedRecords);

    const before = Date.now();
    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor(streamedRecords),
      finalStatus: 'succeeded',
    });

    expect(outcome.decision).toBe('kept-live-persisted');
    expect(outcome.appendedErrorEvents).toBe(0);
    expect(outcome.timelineSyncEnqueued).toBe(true);
    expect(flushDelays).toEqual([RUN_TERMINAL_TIMELINE_SYNC_GRACE_MS]);

    const message = messageRow(db);
    expect(message.content).toBe('Hello world.');
    expect(message.runStatus).toBe('succeeded');
    expect(message.endedAt).toBeGreaterThanOrEqual(before - 1);
    const kinds = message.events.map((event: any) => event.kind);
    expect(kinds).toEqual(['status', 'status', 'text', 'tool_use', 'tool_result', 'usage']);
    expect(message.events[2]).toEqual({ kind: 'text', text: 'Hello world.' });

    // GET messages?view=chat serves this row through listMessagesForChat.
    const chatMessage = listMessagesForChat(db, CONVERSATION_ID)
      .find((m: any) => m.id === MESSAGE_ID) as any;
    expect(chatMessage.content).toBe('Hello world.');
    expect(chatMessage.events.some((event: any) => event.kind === 'tool_result')).toBe(true);

    // Exactly one enqueued timeline record, delayed by the client grace
    // window: not yet listed as due, surfaced through the outbox delay.
    const rows = outboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBe(MESSAGE_ID);
    expect(rows[0]!.next_attempt_at).toBeGreaterThan(before);
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(0);
    const delay = nextProjectMessageAuthorityOutboxDelay(db);
    expect(delay).not.toBeNull();
    expect(delay!).toBeGreaterThan(0);
    expect(delay!).toBeLessThanOrEqual(RUN_TERMINAL_TIMELINE_SYNC_GRACE_MS);

    // Idempotent: a second finalize changes nothing and coalesces the outbox.
    const eventsBefore = JSON.stringify(message.events);
    const second = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor(streamedRecords),
      finalStatus: 'succeeded',
    });
    expect(second.decision).toBe('kept-live-persisted');
    expect(second.appendedErrorEvents).toBe(0);
    const after = messageRow(db);
    expect(JSON.stringify(after.events)).toBe(eventsBefore);
    expect(after.content).toBe('Hello world.');
    expect(outboxRows(db)).toHaveLength(1);
  });

  it('API-only early failure: assembles the error projection, no misleading content, no timeline entry', () => {
    pinAssistantMessage(db);
    // runs.fail() emits the error record directly (never through the
    // agent-stream send()), so live persistence saw nothing.
    const errorRecord: RunEventRecordLike = {
      id: 1,
      event: 'error',
      data: {
        message: 'unknown agent: nope',
        error: { code: 'AGENT_UNAVAILABLE', message: 'unknown agent: nope' },
      },
    };

    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor([errorRecord]),
      finalStatus: 'failed',
    });

    expect(outcome.decision).toBe('assembled-from-run-events');
    expect(outcome.timelineSyncEnqueued).toBe(false);
    const message = messageRow(db);
    expect(message.content).toBe('');
    expect(message.runStatus).toBe('failed');
    expect(message.events).toEqual([
      {
        kind: 'status',
        label: 'error',
        detail: 'unknown agent: nope',
        code: 'AGENT_UNAVAILABLE',
      },
    ]);
    expect(outboxRows(db)).toHaveLength(0);
    expect(flushDelays).toEqual([]);
  });

  it('client already finalized: daemon neither overwrites nor re-enqueues', () => {
    pinAssistantMessage(db);
    livePersist(db, streamedRecords);
    // The web finalize PUT replaces content/events and stamps
    // telemetry_finalized_at (upsertMessage telemetryFinalized: true). Its
    // own route enqueue was already delivered and completed by the flush
    // loop, so the outbox is empty here.
    upsertMessage(db, CONVERSATION_ID, {
      id: MESSAGE_ID,
      role: 'assistant',
      content: 'web assembled answer',
      events: [{ kind: 'text', text: 'web assembled answer' }],
      runId: RUN_ID,
      runStatus: 'succeeded',
      endedAt: Date.now(),
      telemetryFinalized: true,
    });

    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor(streamedRecords),
      finalStatus: 'succeeded',
    });

    expect(outcome.decision).toBe('client-finalized');
    expect(outcome.timelineSyncEnqueued).toBe(false);
    const message = messageRow(db);
    expect(message.content).toBe('web assembled answer');
    expect(message.events).toEqual([{ kind: 'text', text: 'web assembled answer' }]);
    expect(outboxRows(db)).toHaveLength(0);
    expect(flushDelays).toEqual([]);
  });

  it('authoritative success repairs a client-side transport failure', () => {
    pinAssistantMessage(db);
    livePersist(db, streamedRecords);
    appendMessageAgentEvents(db, MESSAGE_ID, [{
      kind: 'status',
      label: 'error',
      detail: 'daemon 502: <html><title>502 Bad Gateway</title></html>',
    }]);
    db.prepare(
      `UPDATE messages
          SET run_status = 'failed', ended_at = ?, telemetry_finalized_at = ?
        WHERE id = ?`,
    ).run(Date.now() - 1_000, Date.now(), MESSAGE_ID);

    const finalizedAt = Date.now();
    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor(streamedRecords),
      finalStatus: 'succeeded',
      now: finalizedAt,
    });

    expect(outcome.decision).toBe('client-finalized');
    const message = messageRow(db);
    expect(message.runStatus).toBe('succeeded');
    expect(message.endedAt).toBe(finalizedAt);
    expect(message.content).toBe('Hello world.');
    expect(message.events.some(
      (event: any) => event.kind === 'status' && event.label === 'error',
    )).toBe(false);
    expect(outboxRows(db)).toHaveLength(0);
  });

  it('failure after streamed output: appends the missing terminal error, keeps truthful partial content', () => {
    pinAssistantMessage(db);
    const streamed = streamedRecords.slice(0, 4); // start + status + two text deltas
    livePersist(db, streamed);
    // Retry-path failures emit through design.runs.emit(run, 'error', ...)
    // without touching the live-persistence send() wrapper.
    const errorRecord: RunEventRecordLike = {
      id: 99,
      event: 'error',
      data: {
        message: 'spawn failed: ENOENT',
        error: { code: 'AGENT_EXECUTION_FAILED', message: 'spawn failed: ENOENT' },
      },
    };

    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor([...streamed, errorRecord]),
      finalStatus: 'failed',
    });

    expect(outcome.decision).toBe('kept-live-persisted');
    expect(outcome.appendedErrorEvents).toBe(1);
    const message = messageRow(db);
    expect(message.content).toBe('Hello world.');
    expect(message.runStatus).toBe('failed');
    expect(message.events.at(-1)).toEqual({
      kind: 'status',
      label: 'error',
      detail: 'spawn failed: ENOENT',
      code: 'AGENT_EXECUTION_FAILED',
    });
    // Partial content + terminal status is timeline-eligible — the same
    // predicate the client PUT route applies to failed runs today.
    expect(outcome.timelineSyncEnqueued).toBe(true);
    expect(outboxRows(db)).toHaveLength(1);

    // Second finalize does not duplicate the recovered error event.
    const again = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor([...streamed, errorRecord]),
      finalStatus: 'failed',
    });
    expect(again.appendedErrorEvents).toBe(0);
    const errorEvents = messageRow(db).events.filter(
      (event: any) => event.kind === 'status' && event.label === 'error',
    );
    expect(errorEvents).toHaveLength(1);
    expect(outboxRows(db)).toHaveLength(1);
  });

  it('canceled before any output: no content is fabricated and nothing reaches the timeline', () => {
    pinAssistantMessage(db);
    const startOnly: RunEventRecordLike[] = [{ id: 1, event: 'start', data: { bin: 'matos' } }];
    livePersist(db, startOnly);

    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor(startOnly),
      finalStatus: 'canceled',
    });

    expect(outcome.decision).toBe('kept-live-persisted');
    expect(outcome.timelineSyncEnqueued).toBe(false);
    const message = messageRow(db);
    expect(message.content).toBe('');
    expect(message.runStatus).toBe('canceled');
    expect(outboxRows(db)).toHaveLength(0);
  });

  it('does not resurrect a client-terminal status: only queued/running rows are stamped', () => {
    pinAssistantMessage(db);
    livePersist(db, streamedRecords);
    // A client marked the run canceled (e.g. cancel route wrote the terminal
    // status) but never finalized telemetry. The daemon must not flip the
    // status, only complete the remaining persistence work.
    db.prepare(`UPDATE messages SET run_status = 'canceled' WHERE id = ?`).run(MESSAGE_ID);

    const outcome = finalizeAssistantMessageFromRunEvents({
      db,
      run: runFor(streamedRecords),
      finalStatus: 'succeeded',
    });

    expect(outcome.decision).toBe('kept-live-persisted');
    expect(messageRow(db).runStatus).toBe('canceled');
  });
});

describe('scaffoldRunConversationMessages', () => {
  let tempDir: string;
  let db: SqliteDb;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-run-message-scaffold-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    seedConversation(db);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists the user turn from currentPrompt first (message may carry a whole transcript)', () => {
    const result = scaffoldRunConversationMessages({
      db,
      conversationId: CONVERSATION_ID,
      message: '## user\nolder turn\n\n## assistant\nolder answer\n\n## user\nreal turn',
      currentPrompt: 'real turn',
    });
    expect(result.assistantMessageId).toMatch(/[0-9a-f-]{36}/);
    expect(result.userMessageId).toBeTruthy();
    const rows = listMessages(db, CONVERSATION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.userMessageId,
      role: 'user',
      content: 'real turn',
    });
    expect((rows[0] as any).startedAt).toBeTypeOf('number');
    expect((rows[0] as any).endedAt).toBeTypeOf('number');
  });

  it('falls back to message for single-turn API callers and keeps a provided assistant id', () => {
    const result = scaffoldRunConversationMessages({
      db,
      conversationId: CONVERSATION_ID,
      requestedAssistantMessageId: 'caller-assistant-1',
      message: '单轮文本',
    });
    expect(result.assistantMessageId).toBe('caller-assistant-1');
    const rows = listMessages(db, CONVERSATION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'user', content: '单轮文本' });
  });

  it('creates no user row when the request carries no usable prompt', () => {
    const result = scaffoldRunConversationMessages({
      db,
      conversationId: CONVERSATION_ID,
      message: '   ',
      currentPrompt: '',
    });
    expect(result.userMessageId).toBeNull();
    expect(result.assistantMessageId).toMatch(/[0-9a-f-]{36}/);
    expect(listMessages(db, CONVERSATION_ID)).toHaveLength(0);
  });
});

describe('assembleRunEventsMessageProjection', () => {
  it('mirrors the live-persistence projection: mapped kinds, coalesced text, concatenated content', () => {
    const projection = assembleRunEventsMessageProjection(streamedRecords);
    expect(projection.content).toBe('Hello world.');
    expect(projection.events.map(event => event.kind)).toEqual([
      'status',
      'status',
      'text',
      'tool_use',
      'tool_result',
      'usage',
    ]);
    expect(projection.events[2]).toEqual({ kind: 'text', text: 'Hello world.' });
  });

  it('drops non-persistable records (end frames, live-only tool input deltas)', () => {
    const projection = assembleRunEventsMessageProjection([
      { id: 1, event: 'end', data: { code: 0, status: 'succeeded' } },
      { id: 2, event: 'agent', data: { type: 'tool_input_delta', id: 't', name: 'Write', delta: '{' } },
      { id: 3, event: 'stdout', data: { chunk: 'plain output' } },
    ]);
    expect(projection.events).toEqual([{ kind: 'text', text: 'plain output' }]);
    expect(projection.content).toBe('plain output');
  });
});
