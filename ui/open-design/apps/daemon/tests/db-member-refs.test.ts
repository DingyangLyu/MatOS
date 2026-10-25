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
  normalizeConversationMemberRefs,
  openDatabase,
  updateConversation,
} from '../src/db.js';

describe('normalizeConversationMemberRefs', () => {
  it('keeps well-formed role refs, dedupes, and preserves order', () => {
    expect(
      normalizeConversationMemberRefs([
        'role:compute',
        'role:academic',
        'role:compute',
        ' role:modeling ',
      ]),
    ).toEqual(['role:compute', 'role:academic', 'role:modeling']);
  });

  it('drops malformed entries and returns null for empty rosters', () => {
    expect(normalizeConversationMemberRefs(['skill:x', 'not-a-ref', 42, null])).toBeNull();
    expect(normalizeConversationMemberRefs([])).toBeNull();
    expect(normalizeConversationMemberRefs(undefined)).toBeNull();
    expect(normalizeConversationMemberRefs('not-json')).toBeNull();
  });

  it('accepts the JSON-encoded column value read back from sqlite', () => {
    expect(normalizeConversationMemberRefs('["role:a","role:b"]')).toEqual([
      'role:a',
      'role:b',
    ]);
  });

  it('caps oversized rosters at 64 members', () => {
    const refs = Array.from({ length: 80 }, (_, i) => `role:r${i}`);
    expect(normalizeConversationMemberRefs(refs)).toHaveLength(64);
  });
});

describe('MatOS group chat memberRefs persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-member-refs-'));
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

  it('seeds a group conversation roster at creation and round-trips it', () => {
    const db = openDb();
    const now = seedProject(db);
    const created = insertConversation(db, {
      id: 'conv-group',
      projectId: 'proj-1',
      title: 'Group chat',
      roleRef: 'role:compute',
      memberRefs: ['role:compute', 'role:academic', 'bogus'],
      createdAt: now,
      updatedAt: now,
    });
    expect(created?.memberRefs).toEqual(['role:compute', 'role:academic']);
    expect(getConversation(db, 'conv-group')?.memberRefs).toEqual([
      'role:compute',
      'role:academic',
    ]);
    expect(listConversations(db, 'proj-1')[0]?.memberRefs).toEqual([
      'role:compute',
      'role:academic',
    ]);
  });

  it('leaves plain DMs without a roster and preserves it across patches', () => {
    const db = openDb();
    const now = seedProject(db);
    insertConversation(db, {
      id: 'conv-dm',
      projectId: 'proj-1',
      title: 'DM',
      roleRef: 'role:compute',
      createdAt: now,
      updatedAt: now,
    });
    expect(getConversation(db, 'conv-dm')?.memberRefs).toBeUndefined();

    insertConversation(db, {
      id: 'conv-g2',
      projectId: 'proj-1',
      title: 'G',
      memberRefs: ['role:a', 'role:b'],
      createdAt: now,
      updatedAt: now,
    });
    // Unrelated patches keep the roster; explicit patches replace or clear it.
    updateConversation(db, 'conv-g2', { title: 'Renamed' });
    expect(getConversation(db, 'conv-g2')?.memberRefs).toEqual(['role:a', 'role:b']);
    updateConversation(db, 'conv-g2', { memberRefs: ['role:c'] });
    expect(getConversation(db, 'conv-g2')?.memberRefs).toEqual(['role:c']);
    updateConversation(db, 'conv-g2', { memberRefs: [] });
    expect(getConversation(db, 'conv-g2')?.memberRefs).toBeUndefined();
  });
});
