import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  getConversation,
  insertConversation,
  insertProject,
  listConversations,
  listMessages,
  openDatabase,
  updateConversation,
  upsertMessage,
} from '../src/db.js';

describe('MatOS roleRef persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-role-ref-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function openDb() {
    return openDatabase(path.join(tempDir, 'test.sqlite'));
  }

  function seedProject(db: ReturnType<typeof openDatabase>) {
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    return now;
  }

  it('binds a conversation to a role at creation and round-trips it', () => {
    const db = openDb();
    const now = seedProject(db);
    const created = insertConversation(db, {
      id: 'conv-dm',
      projectId: 'proj-1',
      title: 'Compute',
      roleRef: 'role:compute',
      createdAt: now,
      updatedAt: now,
    });
    expect(created?.roleRef).toBe('role:compute');
    expect(getConversation(db, 'conv-dm')?.roleRef).toBe('role:compute');
    expect(listConversations(db, 'proj-1')[0]?.roleRef).toBe('role:compute');
  });

  it('rejects malformed role refs and allows clearing via patch', () => {
    const db = openDb();
    const now = seedProject(db);
    insertConversation(db, {
      id: 'conv-x',
      projectId: 'proj-1',
      title: null,
      roleRef: 'not-a-role; DROP TABLE',
      createdAt: now,
      updatedAt: now,
    });
    expect(getConversation(db, 'conv-x')?.roleRef).toBeNull();
    updateConversation(db, 'conv-x', { roleRef: 'role:academic' });
    expect(getConversation(db, 'conv-x')?.roleRef).toBe('role:academic');
    updateConversation(db, 'conv-x', { roleRef: null });
    expect(getConversation(db, 'conv-x')?.roleRef).toBeNull();
    // Patches without roleRef leave the binding untouched.
    updateConversation(db, 'conv-x', { roleRef: 'role:modeling' });
    updateConversation(db, 'conv-x', { title: 'Renamed' });
    expect(getConversation(db, 'conv-x')?.roleRef).toBe('role:modeling');
  });

  it('stamps and preserves the message roleRef across later upserts', () => {
    const db = openDb();
    const now = seedProject(db);
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    // Placeholder stamped at run creation (pinAssistantMessageOnRunCreate).
    upsertMessage(db, 'conv-1', {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      agentId: 'matos',
      roleRef: 'role:deep-research',
      runId: 'run-1',
      runStatus: 'running',
    });
    // Final client persistence pass carries no roleRef — the stamp survives.
    upsertMessage(db, 'conv-1', {
      id: 'msg-1',
      role: 'assistant',
      content: 'done',
      agentId: 'matos',
      runId: 'run-1',
      runStatus: 'succeeded',
    });
    const messages = listMessages(db, 'conv-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.roleRef).toBe('role:deep-research');
    expect(messages[0]?.content).toBe('done');
  });
});
