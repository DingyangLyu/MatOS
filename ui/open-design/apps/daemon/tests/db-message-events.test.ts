import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendMessageAgentEvent,
  appendMessageStatusEvent,
  closeDatabase,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  reconcileMessageTurnOrder,
  upsertMessage,
} from '../src/db.js';

describe('message event persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-message-events-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends deduplicated failure status events to assistant messages', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'proj-1',
      name: 'Routine project',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'Routine run',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'agent-run-1',
      runStatus: 'running',
      events: [{ kind: 'status', label: 'starting', detail: 'Codex' }],
      startedAt: now,
    });

    appendMessageStatusEvent(db, 'assistant-1', {
      label: 'error',
      detail: 'Agent stalled without emitting any new output for 1s.',
    });
    appendMessageStatusEvent(db, 'assistant-1', {
      label: 'error',
      detail: 'Agent stalled without emitting any new output for 1s.',
    });

    expect(listMessages(db, 'conv-1')[0]?.events).toEqual([
      { kind: 'status', label: 'starting', detail: 'Codex' },
      {
        kind: 'status',
        label: 'error',
        detail: 'Agent stalled without emitting any new output for 1s.',
      },
    ]);
  });

  it('persists explicit message createdAt values on insert', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    const createdAt = now - 5_000;
    insertProject(db, {
      id: 'proj-1',
      name: 'Timestamp project',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'Timestamp run',
      createdAt: now,
      updatedAt: now,
    });

    upsertMessage(db, 'conv-1', {
      id: 'message-1',
      role: 'user',
      content: 'started earlier',
      createdAt,
    });

    expect(listMessages(db, 'conv-1')[0]?.createdAt).toBe(createdAt);
  });

  it('orders a concurrently persisted user turn before its assistant response', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'proj-1',
      name: 'Concurrent message project',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'Concurrent turn',
      createdAt: now,
      updatedAt: now,
    });

    // Reproduce the production race: the assistant PUT reaches SQLite first.
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'MatOS',
      createdAt: now,
      runStatus: 'succeeded',
    });
    upsertMessage(db, 'conv-1', {
      id: 'user-1',
      role: 'user',
      content: 'Who are you?',
      createdAt: now,
    });

    expect(listMessages(db, 'conv-1').map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
  });

  it('repairs legacy reversed positions when reopening an existing database', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'proj-1',
      name: 'Legacy order project',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'Legacy order',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conv-1', {
      id: 'user-1', role: 'user', content: 'Prompt', createdAt: now,
    });
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1', role: 'assistant', content: 'Response', createdAt: now,
    });
    db.prepare(`UPDATE messages SET position = CASE id WHEN 'assistant-1' THEN 0 ELSE 1 END`)
      .run();
    closeDatabase();

    const reopened = openDatabase(tempDir, { dataDir: tempDir });
    expect(listMessages(reopened, 'conv-1').map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
  });

  it('uses an explicit turn link when the browser clock is ahead of the daemon', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const daemonNow = Date.now();
    const browserNow = daemonNow + 2_000;
    insertProject(db, {
      id: 'proj-clock-skew',
      name: 'Clock skew project',
      createdAt: daemonNow,
      updatedAt: daemonNow,
    });
    insertConversation(db, {
      id: 'conv-clock-skew',
      projectId: 'proj-clock-skew',
      title: 'Clock skew turn',
      createdAt: daemonNow,
      updatedAt: daemonNow,
    });
    upsertMessage(db, 'conv-clock-skew', {
      id: 'user-clock-skew',
      role: 'user',
      content: 'Continue',
      createdAt: browserNow,
    });
    upsertMessage(db, 'conv-clock-skew', {
      id: 'assistant-clock-skew',
      role: 'assistant',
      content: 'Done',
      createdAt: daemonNow,
      startedAt: browserNow,
      turnUserMessageId: 'user-clock-skew',
      runStatus: 'succeeded',
    });

    expect(listMessages(db, 'conv-clock-skew').map((message) => message.id)).toEqual([
      'user-clock-skew',
      'assistant-clock-skew',
    ]);
    expect(listMessages(db, 'conv-clock-skew')[1]?.turnUserMessageId).toBe(
      'user-clock-skew',
    );
  });

  it('resequences when an existing assistant receives its turn link after the user row', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const daemonNow = Date.now();
    const browserNow = daemonNow + 2_000;
    insertProject(db, {
      id: 'proj-late-link',
      name: 'Late turn link project',
      createdAt: daemonNow,
      updatedAt: daemonNow,
    });
    insertConversation(db, {
      id: 'conv-late-link',
      projectId: 'proj-late-link',
      title: 'Late turn link',
      createdAt: daemonNow,
      updatedAt: daemonNow,
    });
    upsertMessage(db, 'conv-late-link', {
      id: 'assistant-late-link',
      role: 'assistant',
      content: 'Done',
      createdAt: daemonNow,
      startedAt: browserNow,
      runStatus: 'running',
    });
    upsertMessage(db, 'conv-late-link', {
      id: 'user-late-link',
      role: 'user',
      content: 'Continue',
      createdAt: browserNow,
    });

    expect(listMessages(db, 'conv-late-link').map((message) => message.id)).toEqual([
      'assistant-late-link',
      'user-late-link',
    ]);

    upsertMessage(db, 'conv-late-link', {
      id: 'assistant-late-link',
      role: 'assistant',
      content: 'Done',
      createdAt: daemonNow,
      startedAt: browserNow,
      turnUserMessageId: 'user-late-link',
      runStatus: 'succeeded',
    });

    expect(listMessages(db, 'conv-late-link').map((message) => message.id)).toEqual([
      'user-late-link',
      'assistant-late-link',
    ]);
  });

  it('resequences when a later user row satisfies an assistant future turn link', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const daemonNow = Date.now();
    const browserNow = daemonNow + 2_000;
    insertProject(db, {
      id: 'proj-future-link',
      name: 'Future turn link project',
      createdAt: daemonNow,
      updatedAt: daemonNow,
    });
    insertConversation(db, {
      id: 'conv-future-link',
      projectId: 'proj-future-link',
      title: 'Future turn link',
      createdAt: daemonNow,
      updatedAt: daemonNow,
    });
    upsertMessage(db, 'conv-future-link', {
      id: 'assistant-future-link',
      role: 'assistant',
      content: 'Done',
      createdAt: daemonNow,
      startedAt: browserNow,
      turnUserMessageId: 'user-future-link',
      runStatus: 'succeeded',
    });
    upsertMessage(db, 'conv-future-link', {
      id: 'user-future-link',
      role: 'user',
      content: 'Continue',
      createdAt: browserNow,
    });

    expect(listMessages(db, 'conv-future-link').map((message) => message.id)).toEqual([
      'user-future-link',
      'assistant-future-link',
    ]);
  });

  it('repairs an imported shared timeline using its causal event order', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'proj-shared-order',
      name: 'Shared order project',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-shared-order',
      projectId: 'proj-shared-order',
      title: 'Shared order',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conv-shared-order', {
      id: 'assistant-shared',
      role: 'assistant',
      content: 'Answer',
      createdAt: now - 500,
      startedAt: now - 500,
      runStatus: 'succeeded',
    });
    upsertMessage(db, 'conv-shared-order', {
      id: 'user-shared',
      role: 'user',
      content: 'Question',
      createdAt: now,
    });

    reconcileMessageTurnOrder(db, 'conv-shared-order', [{
      userMessageId: 'user-shared',
      assistantMessageId: 'assistant-shared',
    }]);

    expect(listMessages(db, 'conv-shared-order').map((message) => message.id)).toEqual([
      'user-shared',
      'assistant-shared',
    ]);
  });

  it('appends agent events and mirrors text deltas into message content', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, {
      id: 'proj-1',
      name: 'Video project',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'Video project run',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'agent-run-1',
      runStatus: 'running',
      events: [],
      startedAt: now,
    });

    appendMessageAgentEvent(db, 'assistant-1', { kind: 'text', text: 'Rendering ' });
    appendMessageAgentEvent(db, 'assistant-1', {
      kind: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'od research search' },
    });
    appendMessageAgentEvent(db, 'assistant-1', { kind: 'text', text: 'done.' });

    const message = listMessages(db, 'conv-1')[0];
    expect(message?.content).toBe('Rendering done.');
    expect(message?.events).toEqual([
      { kind: 'text', text: 'Rendering ' },
      {
        kind: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'od research search' },
      },
      { kind: 'text', text: 'done.' },
    ]);
  });
});
