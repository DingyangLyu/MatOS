import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db.js';
import { changedProjectName, reserveUntitledProjectName, validatedProjectName } from '../src/services/project-names.js';

describe('durable untitled project name reservations', () => {
  it.each(['旧'.repeat(200), 'legacy\nname', 'old\tname', '  old name  '])('treats an echoed legacy name as no rename: %j', name => {
    expect(changedProjectName(name, name)).toBeUndefined();
  });
  it('does not replay a queued full-record save over a concurrent rename', () => {
    const original = '旧'.repeat(200);
    expect(changedProjectName(original, 'new name', original)).toBeUndefined();
    expect(() => changedProjectName(`${original}changed`, 'new name', original)).toThrow();
    expect(changedProjectName(' valid new name ', original, original)).toBe('valid new name');
  });
  it.each([null, '', ' ', 'bad\nname', 'x'.repeat(161)])('does not grandfather a new invalid name: %j', name => {
    expect(() => changedProjectName(name, 'saved name')).toThrow();
  });
  it('uses independent SQLite connections, survives reopen and does not recycle renamed/deleted names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'project-counter-'));
    let first: Database.Database | undefined;
    let second: Database.Database | undefined;
    try {
      first = openDatabase(root, { dataDir: root });
      second = new Database(first.name);
      expect(() => reserveUntitledProjectName(first!, 'x'.repeat(56))).toThrow('default project name is too long');
      expect(reserveUntitledProjectName(first, '未命名项目')).toBe('未命名项目（1）');
      expect(reserveUntitledProjectName(second, '未命名项目')).toBe('未命名项目（2）');
      second.close();
      second = new Database(first.name);
      expect(reserveUntitledProjectName(second, '未命名项目')).toBe('未命名项目（3）');
      // Existing/imported names must also be respected, including full-width punctuation.
      first.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)')
        .run('existing', 'Untitled project （1）');
      expect(reserveUntitledProjectName(second, 'Untitled project')).toBe('Untitled project (2)');
      first.prepare('DELETE FROM projects WHERE id = ?').run('existing');
      expect(reserveUntitledProjectName(first, 'Untitled project')).toBe('Untitled project (3)');
      second.close();
      second = undefined;
      closeDatabase();
      first = openDatabase(root, { dataDir: root });
      expect(reserveUntitledProjectName(first, 'Untitled project')).toBe('Untitled project (4)');
    } finally {
      second?.close();
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([null, '', '   ', 'bad\nname', 'bad\u0000name', 'x'.repeat(161)])('rejects invalid names: %j', name => {
    expect(() => validatedProjectName(name)).toThrow();
  });

  it('preserves Chinese names and counts Unicode codepoints, not UTF-16 units', () => {
    expect(validatedProjectName('  镍基合金研究  ')).toBe('镍基合金研究');
    expect(validatedProjectName('🧪'.repeat(160))).toBe('🧪'.repeat(160));
  });
});
