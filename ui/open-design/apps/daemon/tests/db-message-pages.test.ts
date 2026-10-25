import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase, insertProject, insertConversation, upsertMessage, listMessagesForChat } from '../src/db.js';

let temp: string | undefined;
afterEach(() => { closeDatabase(); if (temp) rmSync(temp, { recursive: true, force: true }); });
describe('SQLite chat history paging', () => {
  it('selects only the newest page, preserves order, and isolates cursors by conversation', () => {
    temp = mkdtempSync(path.join(os.tmpdir(), 'message-pages-'));
    const db = openDatabase(temp, { dataDir: temp });
    insertProject(db, { id: 'p', name: 'Paging', createdAt: 1, updatedAt: 1 });
    for (const id of ['a', 'b']) insertConversation(db, { id, projectId: 'p', title: id, createdAt: 1, updatedAt: 1 });
    for (let i = 0; i < 103; i++) upsertMessage(db, 'a', { id: `m-${String(i).padStart(3, '0')}`, role: i % 2 ? 'assistant' : 'user', content: String(i) });
    upsertMessage(db, 'b', { id: 'foreign', role: 'user', content: 'must not be returned' });
    const latest = listMessagesForChat(db, 'a', { limit: 40 });
    const full = listMessagesForChat(db, 'a');
    expect(latest).toHaveLength(40);
    expect(latest).toEqual(full.slice(-40));
    const older = listMessagesForChat(db, 'a', { limit: 40, before: String(latest[0]?.id) });
    expect(older).toEqual(full.slice(-80, -40));
    expect(listMessagesForChat(db, 'a', { limit: 40, before: 'foreign' })).toEqual([]);
    expect(listMessagesForChat(db, 'a')).toHaveLength(103);
  });
});
