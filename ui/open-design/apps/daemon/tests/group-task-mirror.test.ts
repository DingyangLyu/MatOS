import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  getConversation,
  getProject,
  insertConversation,
  insertProject,
  listConversations,
  listMessages,
  normalizeMessageGroupTask,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import {
  findDispatchUserMessage,
  findMemberDmConversation,
  groupTaskAssistantMirrorId,
  groupTaskUserMirrorId,
  mirrorGroupTaskToMemberDm,
  type GroupTaskMirrorDeps,
} from '../src/routes/project/group-task-mirror.js';

describe('normalizeMessageGroupTask', () => {
  it('keeps well-formed records and drops malformed ones', () => {
    const full = {
      sourceProjectId: 'proj-1',
      sourceConversationId: 'conv-g',
      sourceConversationTitle: '电池项目群',
      sourceMessageId: 'msg-1',
      memberRef: 'role:compute',
      memberName: '算力老王',
    };
    expect(normalizeMessageGroupTask(full)).toEqual(full);
    // JSON-encoded column value round-trips.
    expect(normalizeMessageGroupTask(JSON.stringify(full))).toEqual(full);
    // Missing required fields collapse to null.
    expect(normalizeMessageGroupTask({ ...full, sourceMessageId: '' })).toBeNull();
    expect(normalizeMessageGroupTask({ ...full, memberRef: 'skill:x' })).toBeNull();
    expect(normalizeMessageGroupTask('not-json')).toBeNull();
    expect(normalizeMessageGroupTask(null)).toBeNull();
  });
});

describe('group task mirroring into member DMs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-group-task-mirror-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function openDb() {
    return openDatabase(path.join(tempDir, 'test.sqlite'));
  }

  let nextId = 0;
  const randomId = () => `gen-${++nextId}`;

  function deps(db: ReturnType<typeof openDatabase>): GroupTaskMirrorDeps {
    return {
      db,
      randomId,
      getProject: getProject as GroupTaskMirrorDeps['getProject'],
      listConversations: listConversations as GroupTaskMirrorDeps['listConversations'],
      insertConversation: insertConversation as GroupTaskMirrorDeps['insertConversation'],
      listMessages: listMessages as GroupTaskMirrorDeps['listMessages'],
      upsertMessage: upsertMessage as GroupTaskMirrorDeps['upsertMessage'],
    };
  }

  function seedGroupTurn(db: ReturnType<typeof openDatabase>, options?: {
    memberNames?: Record<string, string>;
    runStatus?: string;
  }) {
    const now = Date.now();
    insertProject(db, {
      id: 'proj-1',
      name: 'P',
      createdAt: now,
      updatedAt: now,
      ...(options?.memberNames
        ? { metadata: { kind: 'other', memberNames: options.memberNames } }
        : {}),
    });
    const group = insertConversation(db, {
      id: 'conv-group',
      projectId: 'proj-1',
      title: '电池项目群',
      roleRef: 'role:compute',
      memberRefs: ['role:compute', 'role:academic'],
      createdAt: now,
      updatedAt: now,
    });
    upsertMessage(db, 'conv-group', {
      id: 'u1',
      role: 'user',
      content: '@Compute 跑一下弛豫',
      roleRef: 'role:compute',
      sessionMode: 'design',
      attachments: [{ path: 'POSCAR', name: 'POSCAR', kind: 'file' }],
      replyTo: {
        messageId: 'a0',
        roleRef: 'role:academic',
        authorName: 'Academic',
        excerpt: '结构文件已经准备好了',
      },
      createdAt: now,
    });
    const assistant = upsertMessage(db, 'conv-group', {
      id: 'a1',
      role: 'assistant',
      content: '弛豫已完成，能量 -123 eV。',
      agentId: 'matos',
      agentName: 'MatOS · role:compute',
      roleRef: 'role:compute',
      runStatus: options?.runStatus ?? 'succeeded',
      events: [{ kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'vasp' } }],
      producedFiles: [{ name: 'CONTCAR' }],
      startedAt: now,
      endedAt: now + 5,
      createdAt: now,
    });
    return { group: group!, assistant: assistant! };
  }

  it('creates the member DM and mirrors the dispatch + work record', () => {
    const db = openDb();
    const { group, assistant } = seedGroupTurn(db, {
      memberNames: { 'role:compute': '算力老王' },
    });

    const result = mirrorGroupTaskToMemberDm(deps(db), {
      projectId: 'proj-1',
      conversation: group,
      message: assistant,
    });

    expect(result).not.toBeNull();
    expect(result!.createdDm).toBe(true);
    const dm = getConversation(db, result!.dmConversationId);
    expect(dm?.roleRef).toBe('role:compute');
    expect(dm?.title).toBe('算力老王');
    expect(dm?.memberRefs).toBeUndefined();

    const rows = listMessages(db, result!.dmConversationId);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      groupTaskUserMirrorId('a1'),
      groupTaskAssistantMirrorId('a1'),
    ]);
    const [dispatch, record] = rows as Array<Record<string, unknown>>;
    expect(dispatch!.role).toBe('user');
    expect(dispatch!.content).toBe('@Compute 跑一下弛豫');
    // The dispatch turn's quote-reply anchor rides into the ledger row, so
    // the DM shows which message the group task was anchored to.
    expect(dispatch!.replyTo).toEqual({
      messageId: 'a0',
      roleRef: 'role:academic',
      authorName: 'Academic',
      excerpt: '结构文件已经准备好了',
    });
    expect((dispatch!.groupTask as Record<string, unknown>).sourceConversationId).toBe(
      'conv-group',
    );
    expect((dispatch!.groupTask as Record<string, unknown>).sourceMessageId).toBe('u1');
    expect((dispatch!.groupTask as Record<string, unknown>).memberName).toBe('算力老王');
    expect(record!.role).toBe('assistant');
    expect(record!.content).toBe('弛豫已完成，能量 -123 eV。');
    expect(record!.runStatus).toBe('succeeded');
    expect(record!.events).toEqual([
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'vasp' } },
    ]);
    expect(record!.producedFiles).toEqual([{ name: 'CONTCAR' }]);
    // Mirrors are inert ledger rows: no live run wiring.
    expect(record!.runId).toBeUndefined();
    expect((record!.groupTask as Record<string, unknown>).sourceMessageId).toBe('a1');
    expect((record!.groupTask as Record<string, unknown>).sourceConversationTitle).toBe(
      '电池项目群',
    );
  });

  it('is idempotent across repeated finalize persists and reuses the DM', () => {
    const db = openDb();
    const { group, assistant } = seedGroupTurn(db);

    const first = mirrorGroupTaskToMemberDm(deps(db), {
      projectId: 'proj-1',
      conversation: group,
      message: assistant,
    });
    // Second finalize (e.g. producedFiles arrived) refreshes the same rows.
    const updated = upsertMessage(db, 'conv-group', {
      id: 'a1',
      role: 'assistant',
      content: '弛豫已完成，能量 -123 eV。',
      roleRef: 'role:compute',
      runStatus: 'succeeded',
      producedFiles: [{ name: 'CONTCAR' }, { name: 'OUTCAR' }],
    });
    const second = mirrorGroupTaskToMemberDm(deps(db), {
      projectId: 'proj-1',
      conversation: group,
      message: updated!,
    });

    expect(second!.dmConversationId).toBe(first!.dmConversationId);
    expect(second!.createdDm).toBe(false);
    const rows = listMessages(db, first!.dmConversationId);
    expect(rows).toHaveLength(2);
    expect((rows[1] as Record<string, unknown>).producedFiles).toEqual([
      { name: 'CONTCAR' },
      { name: 'OUTCAR' },
    ]);
  });

  it('appends to an existing member DM instead of creating a second one', () => {
    const db = openDb();
    const { group, assistant } = seedGroupTurn(db);
    const now = Date.now();
    insertConversation(db, {
      id: 'conv-dm',
      projectId: 'proj-1',
      title: 'Compute',
      roleRef: 'role:compute@0.9.0',
      createdAt: now,
      updatedAt: now,
    });
    // The user DMed the member BEFORE the group work happened. Mirrored
    // ledger rows keep their original group-turn timestamps and the message
    // order is canonicalized chronologically, so the earlier DM turn stays
    // above the appended dispatch + work-record pair.
    upsertMessage(db, 'conv-dm', {
      id: 'dm-u1',
      role: 'user',
      content: '早',
      createdAt: now - 60_000,
    });

    const result = mirrorGroupTaskToMemberDm(deps(db), {
      projectId: 'proj-1',
      conversation: group,
      message: assistant,
    });

    expect(result!.dmConversationId).toBe('conv-dm');
    expect(result!.createdDm).toBe(false);
    const rows = listMessages(db, 'conv-dm');
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      'dm-u1',
      groupTaskUserMirrorId('a1'),
      groupTaskAssistantMirrorId('a1'),
    ]);
  });

  it('rejects a terminal assistant identity outside the group roster', () => {
    const db = openDb();
    const { group } = seedGroupTurn(db);
    const spoofed = upsertMessage(db, 'conv-group', {
      id: 'a-spoofed',
      role: 'assistant',
      content: 'spoofed',
      roleRef: 'role:workflow-builder',
      runStatus: 'succeeded',
    });
    expect(mirrorGroupTaskToMemberDm(deps(db), {
      projectId: 'proj-1',
      conversation: group,
      message: spoofed!,
    })).toBeNull();
  });

  it('skips non-group conversations, non-terminal runs, and mirror rows', () => {
    const db = openDb();
    const { group } = seedGroupTurn(db, { runStatus: 'running' });
    const running = listMessages(db, 'conv-group').find(
      (m: { id: string }) => m.id === 'a1',
    );
    expect(
      mirrorGroupTaskToMemberDm(deps(db), {
        projectId: 'proj-1',
        conversation: group,
        message: running!,
      }),
    ).toBeNull();

    // Terminal but in a plain DM conversation: never mirrors.
    const now = Date.now();
    const dm = insertConversation(db, {
      id: 'conv-plain',
      projectId: 'proj-1',
      title: 'Compute',
      roleRef: 'role:compute',
      createdAt: now,
      updatedAt: now,
    });
    const dmAssistant = upsertMessage(db, 'conv-plain', {
      id: 'a2',
      role: 'assistant',
      content: 'hi',
      roleRef: 'role:compute',
      runStatus: 'succeeded',
    });
    expect(
      mirrorGroupTaskToMemberDm(deps(db), {
        projectId: 'proj-1',
        conversation: dm!,
        message: dmAssistant!,
      }),
    ).toBeNull();

    // A mirrored row itself (carries groupTask) is never re-mirrored.
    const mirrored = upsertMessage(db, 'conv-plain', {
      id: 'a3',
      role: 'assistant',
      content: 'ledger',
      roleRef: 'role:compute',
      runStatus: 'succeeded',
      groupTask: {
        sourceProjectId: 'proj-1',
        sourceConversationId: 'conv-group',
        sourceMessageId: 'a1',
        memberRef: 'role:compute',
      },
    });
    expect(
      mirrorGroupTaskToMemberDm(deps(db), {
        projectId: 'proj-1',
        conversation: group,
        message: mirrored!,
      }),
    ).toBeNull();
  });

  it('mirrors failed turns too (a real ledger records failures)', () => {
    const db = openDb();
    const { group, assistant } = seedGroupTurn(db, { runStatus: 'failed' });
    const result = mirrorGroupTaskToMemberDm(deps(db), {
      projectId: 'proj-1',
      conversation: group,
      message: assistant,
    });
    expect(result).not.toBeNull();
    const rows = listMessages(db, result!.dmConversationId);
    expect((rows[1] as Record<string, unknown>).runStatus).toBe('failed');
  });

  it('helpers: DM lookup skips groups; dispatch is nearest user above', () => {
    const conversations = [
      {
        id: 'g',
        projectId: 'p',
        title: null,
        roleRef: 'role:compute',
        memberRefs: ['role:compute', 'role:academic'],
        createdAt: 1,
        updatedAt: 9,
      },
      {
        id: 'dm',
        projectId: 'p',
        title: 'Compute',
        roleRef: 'role:compute',
        createdAt: 1,
        updatedAt: 5,
      },
    ];
    expect(findMemberDmConversation(conversations, 'role:compute', 'g')?.id).toBe('dm');
    expect(findMemberDmConversation(conversations, 'role:academic', 'g')).toBeNull();

    const messages = [
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a0', role: 'assistant', content: 'earlier' },
      { id: 'u2', role: 'user', content: 'dispatch' },
      { id: 'a1', role: 'assistant', content: 'work' },
    ];
    expect(findDispatchUserMessage(messages, 'a1')?.id).toBe('u2');
    expect(findDispatchUserMessage(messages, 'missing')).toBeNull();
  });
});
