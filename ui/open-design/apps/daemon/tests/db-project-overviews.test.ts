import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, insertConversation, insertProject, listProjectConversationOverviews, openDatabase } from '../src/db.js';

describe('read-only project conversation overviews (real SQLite)', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-project-overviews-')); });
  afterEach(() => { closeDatabase(); rmSync(tempDir, { recursive: true, force: true }); });
  it('counts and selects the latest title per project without mixing project scopes', () => {
    const db = openDatabase(path.join(tempDir, 'test.sqlite'));
    for (const id of ['a', 'b', 'empty']) insertProject(db, { id, name: id, createdAt: 1, updatedAt: 1 });
    for (const [id, projectId, title, updatedAt] of [
      ['a-old', 'a', 'Older', 1], ['a-2', 'a', 'Tie second', 2], ['a-1', 'a', '  镍基合金  ', 2],
      ['b-1', 'b', 'Other project', 3],
    ] as const) insertConversation(db, { id, projectId, title, createdAt: 1, updatedAt });
    const result = listProjectConversationOverviews(db);
    expect(result.get('a')).toEqual({ conversationCount: 3, latestConversationTitle: '镍基合金' });
    expect(result.get('b')).toEqual({ conversationCount: 1, latestConversationTitle: 'Other project' });
    expect(result.has('empty')).toBe(false);
  });
  it('omits blank titles and bounds long display titles', () => {
    const db = openDatabase(path.join(tempDir, 'test.sqlite'));
    for (const id of ['a', 'b']) insertProject(db, { id, name: id, createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'a', projectId: 'a', title: '  ', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: 'b', projectId: 'b', title: '中'.repeat(400), createdAt: 1, updatedAt: 1 });
    const result = listProjectConversationOverviews(db);
    expect(result.get('a')).toEqual({ conversationCount: 1 });
    expect(result.get('b')?.latestConversationTitle).toHaveLength(240);
  });
});
