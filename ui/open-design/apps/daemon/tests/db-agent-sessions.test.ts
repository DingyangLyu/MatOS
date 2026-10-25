import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearAgentSession,
  closeDatabase,
  getAgentSession,
  getAgentSessionRecord,
  insertConversation,
  insertProject,
  latestCompletedAssistantMessageId,
  latestMatOSAgentSession,
  openDatabase,
  updateAgentSessionStableHash,
  upsertAgentSession,
  upsertMessage,
} from '../src/db.js';

describe('agent_sessions persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-agent-sessions-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    return db;
  }

  it('returns null when no session is stored', () => {
    const db = seed();
    expect(getAgentSession(db, 'conv-1', 'matos')).toBeNull();
  });

  it('upserts and reads back a session id, scoped per agent', () => {
    const db = seed();
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-A' });
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'other-agent', sessionId: 'sess-B' });
    expect(getAgentSession(db, 'conv-1', 'matos')).toBe('sess-A');
    expect(getAgentSession(db, 'conv-1', 'other-agent')).toBe('sess-B');
  });

  it('upsert overwrites the prior id for the same (conversation, agent)', () => {
    const db = seed();
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-A' });
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-C' });
    expect(getAgentSession(db, 'conv-1', 'matos')).toBe('sess-C');
  });

  it('clearAgentSession removes only the targeted row', () => {
    const db = seed();
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-A' });
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'other-agent', sessionId: 'sess-B' });
    clearAgentSession(db, 'conv-1', 'matos');
    expect(getAgentSession(db, 'conv-1', 'matos')).toBeNull();
    expect(getAgentSession(db, 'conv-1', 'other-agent')).toBe('sess-B');
  });

  // The web `/btw` bridge wants "the conversation's freshest MatOS session"
  // regardless of which role variant (`matos` / `matos:<role>`) owns it.
  it('latestMatOSAgentSession picks the freshest matos row and ignores other agents', () => {
    const db = seed();
    expect(latestMatOSAgentSession(db, 'conv-1')).toBeNull();

    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'other-agent', sessionId: 'sess-other' });
    expect(latestMatOSAgentSession(db, 'conv-1')).toBeNull();

    upsertAgentSession(db, {
      conversationId: 'conv-1',
      agentId: 'matos:role:compute',
      sessionId: 'sess-old',
      model: 'role:compute',
      cwd: '/workspace/old',
    });
    upsertAgentSession(db, {
      conversationId: 'conv-1',
      agentId: 'matos',
      sessionId: 'sess-new',
      model: null,
      cwd: '/workspace/new',
    });
    // upserts within the same millisecond tie on updated_at; make the
    // ordering explicit the way real turns are (later turn, later stamp).
    db.prepare(`UPDATE agent_sessions SET updated_at = ? WHERE agent_id = 'matos:role:compute'`).run(1_000);
    db.prepare(`UPDATE agent_sessions SET updated_at = ? WHERE agent_id = 'matos'`).run(2_000);
    expect(latestMatOSAgentSession(db, 'conv-1')).toEqual({
      sessionId: 'sess-new',
      model: null,
      cwd: '/workspace/new',
    });

    db.prepare(`UPDATE agent_sessions SET updated_at = ? WHERE agent_id = 'matos:role:compute'`).run(3_000);
    expect(latestMatOSAgentSession(db, 'conv-1')).toEqual({
      sessionId: 'sess-old',
      model: 'role:compute',
      cwd: '/workspace/old',
    });
  });
});

describe('latestCompletedAssistantMessageId (resume-identity cursor)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-resume-cursor-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seed() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    return db;
  }

  function addAssistant(db: ReturnType<typeof seed>, id: string, runStatus: string | null) {
    upsertMessage(db, 'conv-1', { id, role: 'assistant', content: 'x', runStatus });
  }

  it('returns null when there is no prior completed assistant turn', () => {
    const db = seed();
    expect(latestCompletedAssistantMessageId(db, 'conv-1', 'in-flight')).toBeNull();
  });

  it('does NOT advance the cursor across an intervening failed/canceled assistant run', () => {
    const db = seed();
    // A resumable session was last produced by m-1 (a succeeded turn).
    addAssistant(db, 'm-1', 'succeeded');
    expect(latestCompletedAssistantMessageId(db, 'conv-1', 'in-flight')).toBe('m-1');

    // Another agent runs and FAILS, then one is CANCELED, before producing any
    // completed turn. These must not read as conversation advancement — the
    // stored session (m-1) is still the latest completed turn, so an otherwise
    // resumable session stays resumable. (Pre-fix this query ignored run_status
    // and returned the failed placeholder, forcing a needless cold reseed.)
    addAssistant(db, 'm-2-failed', 'failed');
    addAssistant(db, 'm-3-canceled', 'canceled');
    expect(latestCompletedAssistantMessageId(db, 'conv-1', 'in-flight')).toBe('m-1');

    // A genuinely completed intervening turn DOES advance the cursor.
    addAssistant(db, 'm-4', 'succeeded');
    expect(latestCompletedAssistantMessageId(db, 'conv-1', 'in-flight')).toBe('m-4');
  });

  it('excludes the current run in-flight placeholder (null run_status)', () => {
    const db = seed();
    addAssistant(db, 'm-1', 'succeeded');
    // The current turn's own placeholder is the latest by position but in-flight.
    addAssistant(db, 'm-current', null);
    expect(latestCompletedAssistantMessageId(db, 'conv-1', 'm-current')).toBe('m-1');
  });
});

describe('agent_sessions stable_prompt_hash', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-agent-sessions-hash-'));
  });
  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });
  function seed() {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1', projectId: 'proj-1', title: 'C', createdAt: now, updatedAt: now,
    });
    return db;
  }

  it('round-trips the stable hash through upsert + getAgentSessionRecord', () => {
    const db = seed();
    upsertAgentSession(db, {
      conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-A', stablePromptHash: 'hash-1',
    });
    expect(getAgentSessionRecord(db, 'conv-1', 'matos')).toMatchObject({
      sessionId: 'sess-A', stablePromptHash: 'hash-1',
    });
  });

  it('stores null stable hash when omitted', () => {
    const db = seed();
    upsertAgentSession(db, { conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-A' });
    expect(getAgentSessionRecord(db, 'conv-1', 'matos')).toMatchObject({
      sessionId: 'sess-A', stablePromptHash: null,
    });
  });

  it('updateAgentSessionStableHash changes only the hash, keeps the session id', () => {
    const db = seed();
    upsertAgentSession(db, {
      conversationId: 'conv-1', agentId: 'matos', sessionId: 'sess-A', stablePromptHash: 'hash-1',
    });
    updateAgentSessionStableHash(db, 'conv-1', 'matos', 'hash-2');
    expect(getAgentSessionRecord(db, 'conv-1', 'matos')).toMatchObject({
      sessionId: 'sess-A', stablePromptHash: 'hash-2',
    });
  });

  it('getAgentSessionRecord returns null when no row exists', () => {
    const db = seed();
    expect(getAgentSessionRecord(db, 'conv-1', 'matos')).toBeNull();
  });
});
