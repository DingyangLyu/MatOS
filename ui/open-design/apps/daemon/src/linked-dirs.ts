import path from 'node:path';
import fs from 'node:fs';

const BLOCKED_CANONICAL = (() => {
  const raw =
    process.platform === 'win32'
      ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
      : ['/etc', '/proc', '/sys', '/dev', '/boot'];
  const set = new Set<string>(raw);
  for (const p of raw) {
    try { set.add(fs.realpathSync.native(p)); } catch { /* not resolvable, keep as-is */ }
  }
  return [...set];
})();

const WIN_ROOT_RE = /^[A-Za-z]:\\?$/;

function isFilesystemRoot(p: string): boolean {
  if (process.platform === 'win32') return WIN_ROOT_RE.test(p);
  return p === '/';
}

export function isBlocked(realPath: string): boolean {
  if (isFilesystemRoot(realPath)) return true;
  return BLOCKED_CANONICAL.some(
    (p: string) =>
      realPath === p ||
      realPath.startsWith(p + path.sep) ||
      p.startsWith(realPath + path.sep),
  );
}

export function validateLinkedDirs(
  dirs: unknown,
): { dirs: string[]; error?: undefined } | { error: string; dirs?: undefined } {
  const filtered = filterValidLinkedDirs(dirs);
  if (typeof filtered.error === 'string') return { error: filtered.error };
  if (filtered.rejected.length > 0) return { error: filtered.rejected[0]?.error ?? 'invalid linked dir' };
  return { dirs: filtered.dirs };
}

export function filterValidLinkedDirs(
  dirs: unknown,
): { dirs: string[]; rejected: Array<{ value: unknown; error: string }>; error?: undefined } | { error: string; dirs?: undefined; rejected?: undefined } {
  if (!Array.isArray(dirs)) return { error: 'linkedDirs must be an array' };
  const validated: string[] = [];
  const rejected: Array<{ value: unknown; error: string }> = [];
  for (const d of dirs) {
    if (typeof d !== 'string' || !d.trim()) {
      rejected.push({ value: d, error: 'each linked dir must be a non-empty string' });
      continue;
    }
    if (!path.isAbsolute(d)) {
      rejected.push({ value: d, error: `linked dir must be an absolute path: ${d}` });
      continue;
    }
    let realPath: string;
    try {
      realPath = fs.realpathSync.native(path.resolve(d));
    } catch {
      rejected.push({ value: d, error: `directory does not exist or is not accessible: ${d}` });
      continue;
    }
    try {
      const stat = fs.statSync(realPath);
      if (!stat.isDirectory()) {
        rejected.push({ value: d, error: `not a directory: ${d}` });
        continue;
      }
    } catch {
      rejected.push({ value: d, error: `directory does not exist or is not accessible: ${d}` });
      continue;
    }
    if (isBlocked(realPath)) {
      rejected.push({ value: d, error: `system directory not allowed: ${d}` });
      continue;
    }
    validated.push(realPath);
  }
  return { dirs: [...new Set(validated)], rejected };
}
