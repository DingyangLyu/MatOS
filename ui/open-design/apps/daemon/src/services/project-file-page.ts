import type { ProjectFile, ProjectFilesPageResponse } from '@open-design/contracts';

/** Keyset pages over the native cached file index, newest first. A cursor
 * does not depend on a mutable array offset: new files cannot duplicate or
 * skip unchanged older files between requests. No payload is read here. */
export function projectFilePage(
  files: ProjectFile[], snapshotAt: number, limit: number, cursor?: string,
): ProjectFilesPageResponse {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
  let after: [number, string] | undefined;
  if (cursor) {
    if (cursor.length > 8192) throw new Error('invalid file cursor');
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number'
        || !Number.isFinite(value[0]) || typeof value[1] !== 'string') throw new Error();
      after = value as [number, string];
    } catch { throw new Error('invalid file cursor'); }
  }
  const path = (file: ProjectFile) => file.path || file.name;
  const ordered = files.filter(file => !after || file.mtime < after[0]
    || (file.mtime === after[0] && path(file) > after[1]));
  ordered.sort((a, b) => b.mtime - a.mtime || (path(a) < path(b) ? -1 : path(a) > path(b) ? 1 : 0));
  const page = ordered.slice(0, limit);
  const last = page.at(-1);
  return { files: page, total: files.length, snapshotAt,
    nextCursor: ordered.length > limit && last
      ? Buffer.from(JSON.stringify([last.mtime, path(last)])).toString('base64url') : null };
}
