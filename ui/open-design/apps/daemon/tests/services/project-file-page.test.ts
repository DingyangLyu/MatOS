import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@open-design/contracts';
import { projectFilePage } from '../../src/services/project-file-page.js';

const file = (name: string, mtime = 1): ProjectFile => ({ name, path: name, mtime, size: 1, mime: 'text/plain', kind: 'text' });
describe('bounded project file pages', () => {
  it('returns recent files first and visits every same-timestamp file exactly once', () => {
    const files = Array.from({ length: 2307 }, (_, i) => file(`task/file-${String(i).padStart(5, '0')}.txt`, i % 3));
    let cursor: string | undefined;
    const names: string[] = [];
    do {
      const page = projectFilePage(files, 42, 200, cursor);
      expect(page.files.length).toBeLessThanOrEqual(200);
      expect(page.total).toBe(2307);
      names.push(...page.files.map(f => f.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(names).size).toBe(2307);
    expect(names.length).toBe(2307);
  });
  it('does not shift older pages when newer files arrive or the cursor file is deleted', () => {
    const first = projectFilePage([file('a', 3), file('b', 2), file('c')], 1, 2);
    const second = projectFilePage([file('new', 4), file('a', 3), file('c')], 2, 2, first.nextCursor!);
    expect(second.files.map(f => f.name)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
  });
  it('rejects invalid cursors and limits without expanding the response', () => {
    for (const limit of [0, 1001, NaN, 1.5]) expect(() => projectFilePage([], 1, limit)).toThrow();
    for (const cursor of ['bad', Buffer.from('["oops",1]').toString('base64url'), 'x'.repeat(8193)]) {
      expect(() => projectFilePage([], 1, 200, cursor)).toThrow('invalid file cursor');
    }
  });
});
