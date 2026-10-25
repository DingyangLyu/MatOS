import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import {
  completeProjectMessageAuthorityOutbox,
  enqueueProjectMessageAuthorityOutbox,
  failProjectMessageAuthorityOutbox,
  listProjectMessageAuthorityOutbox,
  nextProjectMessageAuthorityOutboxDelay,
} from '../src/routes/project/message-authority-outbox.js';

describe('project message authority outbox', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-message-outbox-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists, retries, coalesces, and completes timeline delivery', () => {
    let db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'project-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conversation-1', {
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: now,
    });
    enqueueProjectMessageAuthorityOutbox(db, {
      messageId: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
    });

    closeDatabase();
    db = openDatabase(tempDir, { dataDir: tempDir });
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(1);

    failProjectMessageAuthorityOutbox(db, 'message-1', 'temporary failure');
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(0);
    expect(nextProjectMessageAuthorityOutboxDelay(db)).toBeGreaterThan(0);

    enqueueProjectMessageAuthorityOutbox(db, {
      messageId: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
    });
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(1);
    completeProjectMessageAuthorityOutbox(db, 'message-1');
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(0);
  });

  it('delayed enqueues never postpone delivery: earliest attempt time wins on conflict', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'project-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conversation-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'answer',
      createdAt: now,
    });
    const nextAttemptAt = () => (db.prepare(
      `SELECT next_attempt_at AS nextAttemptAt
         FROM project_message_authority_outbox WHERE message_id = ?`,
    ).get('message-1') as { nextAttemptAt: number }).nextAttemptAt;

    // Daemon run-terminal reconcile enqueues with a grace delay.
    enqueueProjectMessageAuthorityOutbox(db, {
      messageId: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      delayMs: 60_000,
    });
    expect(nextAttemptAt()).toBeGreaterThan(now);
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(0);

    // A client finalize PUT enqueue accelerates the pending record to due-now.
    enqueueProjectMessageAuthorityOutbox(db, {
      messageId: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
    });
    expect(nextAttemptAt()).toBe(0);
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(1);

    // A later delayed enqueue must not push the due record back out.
    enqueueProjectMessageAuthorityOutbox(db, {
      messageId: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      delayMs: 60_000,
    });
    expect(nextAttemptAt()).toBe(0);
    expect(listProjectMessageAuthorityOutbox(db)).toHaveLength(1);
  });
});
