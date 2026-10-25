import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendMessageAgentEvents,
  closeDatabase,
  insertConversation,
  insertProject,
  listMessagesForChat,
  listMessages,
  openDatabase,
  upsertMessage,
} from '../src/db.js';

describe('preTurnFileNames persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-pre-turn-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedConversation(db: ReturnType<typeof openDatabase>) {
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    return now;
  }

  it('round-trips preTurnFileNames through upsert and listMessages', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'running',
      startedAt: now,
      preTurnFileNames: ['existing.html', 'README.md'],
    });

    const reloaded = listMessages(db, 'conv-1');
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.preTurnFileNames).toEqual(['existing.html', 'README.md']);
  });

  it('preserves preTurnFileNames across a subsequent UPDATE upsert that omits the field', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'running',
      startedAt: now,
      preTurnFileNames: ['existing.html'],
    });
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'streamed chunk',
      runId: 'run-1',
      runStatus: 'running',
      startedAt: now,
    });

    const [msg] = listMessages(db, 'conv-1');
    expect(msg).toBeDefined();
    expect(msg!.preTurnFileNames).toEqual(['existing.html']);
  });

  it('drops finalized recovery baselines and serves a compact chat event projection', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    const events = [
      { kind: 'thinking', text: 'one' },
      { kind: 'thinking', text: ' two' },
      { kind: 'tool_result', toolUseId: 'tool-1', content: 'x'.repeat(100_000), isError: false },
    ];
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      runId: 'run-1',
      runStatus: 'succeeded',
      startedAt: now,
      endedAt: now + 1,
      events,
      preTurnFileNames: ['existing.html'],
      preTurnFileSnapshot: [{ name: 'existing.html', size: 10, mtime: now }],
      telemetryFinalized: true,
    });

    const [full] = listMessages(db, 'conv-1');
    const [chat] = listMessagesForChat(db, 'conv-1');
    expect(full!.preTurnFileNames).toBeUndefined();
    expect(full!.preTurnFileSnapshot).toBeUndefined();
    expect(full!.events).toEqual(events);
    expect(chat!.events).toHaveLength(2);
    expect((chat!.events![0] as { text: string }).text).toBe('one two');
    expect((chat!.events![1] as { content: string }).content)
      .toContain('Full output remains in persisted run evidence.');
  });

  it('drops stale terminal baselines even when legacy telemetry was never finalized', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-legacy-terminal',
      role: 'assistant',
      content: 'done',
      runStatus: 'succeeded',
      preTurnFileNames: Array.from({ length: 500 }, (_, index) => `file-${index}.txt`),
      preTurnFileSnapshot: Array.from(
        { length: 500 },
        (_, index) => ({ name: `file-${index}.txt`, size: index, mtime: now }),
      ),
    });

    const [full] = listMessages(db, 'conv-1');
    const [chat] = listMessagesForChat(db, 'conv-1');
    expect(full!.preTurnFileNames).toHaveLength(500);
    expect(chat!.preTurnFileNames).toBeUndefined();
    expect(chat!.preTurnFileSnapshot).toBeUndefined();
  });

  it('keeps recovery baselines for active runs', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-running',
      role: 'assistant',
      content: '',
      runStatus: 'running',
      preTurnFileNames: ['before.txt'],
      preTurnFileSnapshot: [{ name: 'before.txt', size: 10, mtime: now }],
    });

    const [chat] = listMessagesForChat(db, 'conv-1');
    expect(chat!.preTurnFileNames).toEqual(['before.txt']);
    expect(chat!.preTurnFileSnapshot).toEqual([
      { name: 'before.txt', size: 10, mtime: now },
    ]);
  });

  it('scrubs legacy finalized baselines when the database is reopened', () => {
    let db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      runStatus: 'succeeded',
      events: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }],
      telemetryFinalized: true,
    });
    db.prepare(
      `UPDATE messages
          SET pre_turn_file_names_json = '["legacy.html"]',
              pre_turn_files_json = '[{"name":"legacy.html"}]',
              events_chat_json = NULL
        WHERE id = 'assistant-1'`,
    ).run();
    closeDatabase();

    db = openDatabase(tempDir, { dataDir: tempDir });
    const [message] = listMessagesForChat(db, 'conv-1');
    expect(message!.preTurnFileNames).toBeUndefined();
    expect(message!.preTurnFileSnapshot).toBeUndefined();
    expect(message!.events).toEqual([{ kind: 'text', text: 'ab' }]);
  });

  it('returns undefined when no baseline was ever written (legacy messages)', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runStatus: 'running',
      startedAt: now,
    });

    const [msg] = listMessages(db, 'conv-1');
    expect(msg).toBeDefined();
    expect(msg!.preTurnFileNames).toBeUndefined();
  });

  it('persists a stream batch as coalesced text and thinking events', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      events: [],
    });

    appendMessageAgentEvents(db, 'assistant-1', [
      ...Array.from({ length: 1_000 }, () => ({ kind: 'thinking', text: 'x' })),
      { kind: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);

    const [message] = listMessages(db, 'conv-1');
    expect(message!.events).toHaveLength(3);
    expect(message!.events![0]).toEqual({ kind: 'thinking', text: 'x'.repeat(1_000) });
    expect(message!.events![2]).toEqual({ kind: 'text', text: 'ab' });
    expect(message!.content).toBe('ab');
  });
});
