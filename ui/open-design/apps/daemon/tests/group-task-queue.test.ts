import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
} from '../src/db.js';
import {
  claimNextProjectGroupTask,
  completeProjectGroupTaskOutbox,
  enqueueProjectGroupTaskOutbox,
  failProjectGroupTaskOutbox,
  findProjectGroupTaskByAssistantMessage,
  findProjectGroupTaskByClientRequest,
  getProjectGroupTask,
  insertProjectGroupTask,
  listProjectGroupTasks,
  listProjectGroupTaskOutbox,
  listRecoverableProjectGroupTasks,
  updateProjectGroupTask,
} from '../src/routes/project/group-task-queue.js';

describe('durable project group task queue', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-project-group-tasks-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'project-1', name: 'Project', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conversation-1',
      projectId: 'project-1',
      title: 'Group',
      createdAt: now,
      updatedAt: now,
    });
    return db;
  }

  it('persists queue records and recovers queued or interrupted tasks', () => {
    const db = seed();
    const created = insertProjectGroupTask(db, {
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      memberRef: 'role:compute',
      prompt: 'Run calculation',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      sourceMessageId: null,
      relayHop: 0,
    });
    expect(created.status).toBe('queued');
    expect(listProjectGroupTasks(db, { projectId: 'project-1' })).toHaveLength(1);

    const running = updateProjectGroupTask(db, 'task-1', {
      status: 'running',
      runId: 'run-1',
    });
    expect(running?.runId).toBe('run-1');
    expect(listRecoverableProjectGroupTasks(db).map(task => task.id)).toEqual(['task-1']);

    const requeued = updateProjectGroupTask(db, 'task-1', {
      status: 'queued',
      runId: null,
      error: 'daemon restarted',
    });
    expect(requeued).toMatchObject({ status: 'queued', runId: null, error: 'daemon restarted' });
  });

  it('keeps terminal tasks terminal and cascades project deletion', () => {
    const db = seed();
    insertProjectGroupTask(db, {
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      memberRef: 'role:compute',
      prompt: 'Run calculation',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      sourceMessageId: null,
      relayHop: 0,
    });
    updateProjectGroupTask(db, 'task-1', { status: 'running', runId: 'run-1' });
    updateProjectGroupTask(db, 'task-1', { status: 'succeeded' });
    expect(() => updateProjectGroupTask(db, 'task-1', { status: 'running' }))
      .toThrow('succeeded -> running');

    db.prepare('DELETE FROM projects WHERE id = ?').run('project-1');
    expect(getProjectGroupTask(db, 'task-1')).toBeNull();
  });

  it('enforces one durable task per client request key', () => {
    const db = seed();
    const task = {
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      memberRef: 'role:compute@1.0.0',
      prompt: 'Run once',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      sourceMessageId: 'source-1',
      relayHop: 0,
      clientRequestId: 'source-1:role:compute:0',
    };
    insertProjectGroupTask(db, task);
    expect(findProjectGroupTaskByClientRequest(db, {
      projectId: task.projectId,
      conversationId: task.conversationId,
      clientRequestId: task.clientRequestId,
    })?.id).toBe('task-1');
    expect(() => insertProjectGroupTask(db, {
      ...task,
      id: 'task-2',
      userMessageId: 'user-2',
      assistantMessageId: 'assistant-2',
    })).toThrow();
  });

  it('resolves a durable task from its assistant placeholder message', () => {
    // The daemon-owned dispatch continuation uses this lookup to learn the
    // relay hop of the turn that just finished (web turns have no task row).
    const db = seed();
    insertProjectGroupTask(db, {
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      memberRef: 'role:compute',
      prompt: 'Run calculation',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      sourceMessageId: null,
      relayHop: 2,
    });
    expect(findProjectGroupTaskByAssistantMessage(db, 'assistant-1')).toMatchObject({
      id: 'task-1',
      relayHop: 2,
    });
    expect(findProjectGroupTaskByAssistantMessage(db, 'assistant-none')).toBeNull();
  });

  it('adds idempotency storage when opening a pre-task-key database', () => {
    const file = path.join(tempDir, 'app.sqlite');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE project_group_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        member_ref TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        source_message_id TEXT,
        relay_hop INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    legacy.close();

    const db = openDatabase(tempDir, { dataDir: tempDir });
    const columns = db.prepare('PRAGMA table_info(project_group_tasks)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toContain('client_request_id');
  });

  it('claims one conversation task atomically and preserves enqueue order', () => {
    const db = seed();
    for (const id of ['task-1', 'task-2']) {
      insertProjectGroupTask(db, {
        id,
        projectId: 'project-1',
        conversationId: 'conversation-1',
        memberRef: 'role:compute',
        prompt: id,
        userMessageId: `user-${id}`,
        assistantMessageId: `assistant-${id}`,
        sourceMessageId: null,
        relayHop: 0,
        authorityState: 'ready',
      });
    }
    const first = claimNextProjectGroupTask(db, {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      workerId: 'worker-1',
      workerPid: process.pid,
      claimToken: 'claim-1',
      leaseMs: 60_000,
    });
    expect(first?.id).toBe('task-1');
    expect(claimNextProjectGroupTask(db, {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      workerId: 'worker-2',
      workerPid: process.pid,
      claimToken: 'claim-2',
      leaseMs: 60_000,
    })).toBeNull();
    expect(updateProjectGroupTask(db, 'task-1', {
      status: 'succeeded',
      expectedClaimToken: 'stale-claim',
    })).toBeNull();
    expect(getProjectGroupTask(db, 'task-1')?.status).toBe('running');
    updateProjectGroupTask(db, 'task-1', {
      status: 'succeeded',
      expectedClaimToken: 'claim-1',
    });
    expect(claimNextProjectGroupTask(db, {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      workerId: 'worker-2',
      workerPid: process.pid,
      claimToken: 'claim-2',
      leaseMs: 60_000,
    })?.id).toBe('task-2');
  });

  it('keeps native task synchronization in a durable idempotent outbox', () => {
    const db = seed();
    insertProjectGroupTask(db, {
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      memberRef: 'role:compute',
      prompt: 'run',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      sourceMessageId: null,
      relayHop: 0,
      authorityState: 'pending',
    });
    enqueueProjectGroupTaskOutbox(db, {
      taskId: 'task-1',
      operation: 'create',
      payload: { taskId: 'task-1' },
    });
    enqueueProjectGroupTaskOutbox(db, {
      taskId: 'task-1',
      operation: 'create',
      payload: { taskId: 'task-1', retry: true },
    });
    const records = listProjectGroupTaskOutbox(db, { taskId: 'task-1' });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ retry: true });
    completeProjectGroupTaskOutbox(db, records[0]!.id);
    expect(listProjectGroupTaskOutbox(db, { taskId: 'task-1' })).toHaveLength(0);
  });

  it('does not apply a later native status while an earlier status is backing off', () => {
    const db = seed();
    insertProjectGroupTask(db, {
      id: 'task-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      memberRef: 'role:compute',
      prompt: 'run',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      sourceMessageId: null,
      relayHop: 0,
    });
    enqueueProjectGroupTaskOutbox(db, {
      taskId: 'task-1',
      operation: 'status:running:1',
      payload: { status: 'running' },
    });
    enqueueProjectGroupTaskOutbox(db, {
      taskId: 'task-1',
      operation: 'status:succeeded:1',
      payload: { status: 'succeeded' },
    });
    const [running] = listProjectGroupTaskOutbox(db, { taskId: 'task-1' });
    expect(running?.operation).toBe('status:running:1');
    failProjectGroupTaskOutbox(db, running!.id, 'temporary native authority failure');
    expect(listProjectGroupTaskOutbox(db, { taskId: 'task-1' })).toEqual([]);
  });
});
