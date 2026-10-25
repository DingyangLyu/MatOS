import { describe, expect, it } from 'vitest';
import { producedProjectFilesFromSnapshots } from '../src/routes/project/conversations.js';

describe('project group task produced files', () => {
  it('keeps the complete ProjectFile contract for created and modified files', () => {
    const produced = producedProjectFilesFromSnapshots(
      [{ name: 'old.md', size: 3, mtime: 1, etag: 'old' }],
      [
        {
          name: 'old.md',
          path: 'old.md',
          size: 4,
          mtime: 2,
          etag: 'new',
          kind: 'text',
          mime: 'text/markdown',
        },
        {
          name: 'plot.png',
          path: 'plot.png',
          size: 128,
          mtime: 3,
          etag: 'plot',
          kind: 'image',
          mime: 'image/png',
        },
      ],
    );
    expect(produced).toEqual([
      expect.objectContaining({
        name: 'old.md',
        size: 4,
        kind: 'text',
        mime: 'text/markdown',
        traceObjectReason: 'modified',
      }),
      expect.objectContaining({
        name: 'plot.png',
        size: 128,
        kind: 'image',
        mime: 'image/png',
        traceObjectReason: 'new',
      }),
    ]);
  });
});
