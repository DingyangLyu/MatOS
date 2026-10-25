// Server-side folder browsing for MatOS gateway deployments.
//
// The upstream folder picker shells out to a native OS dialog (zenity /
// PowerShell / osascript), which cannot work when the daemon runs headless
// behind the MatOS gateway. This route lets the web UI browse directories
// on the daemon host instead — strictly jailed to the user's own roots:
// the MatOS assets/workspace cwd plus any operator-listed extra roots.

import { mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, Response } from 'express';

export interface MatOSFsRoot {
  id: string;
  label: string;
  path: string;
}

function configuredRoots(): MatOSFsRoot[] {
  const roots: MatOSFsRoot[] = [];
  const cwd = process.env.MATOS_ASSETS_CWD?.trim();
  if (cwd) {
    roots.push({ id: 'workspace', label: 'Workspace', path: path.resolve(cwd) });
  }
  const extra = process.env.MATOS_FS_BROWSE_ROOTS?.trim();
  if (extra) {
    for (const entry of extra.split(':')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const resolved = path.resolve(trimmed);
      if (!roots.some((root) => root.path === resolved)) {
        roots.push({ id: `root-${roots.length}`, label: path.basename(resolved) || resolved, path: resolved });
      }
    }
  }
  if (roots.length === 0) {
    roots.push({ id: 'cwd', label: 'Project', path: process.cwd() });
  }
  return roots;
}

/** Resolve + jail-check: the target must stay inside one of the roots. */
export async function resolveWithinRoots(
  target: string,
  roots: MatOSFsRoot[],
): Promise<string | null> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(target));
  } catch {
    return null;
  }
  for (const root of roots) {
    let rootReal: string;
    try {
      rootReal = await realpath(root.path);
    } catch {
      continue;
    }
    if (resolved === rootReal || resolved.startsWith(`${rootReal}${path.sep}`)) {
      return resolved;
    }
  }
  return null;
}

const HIDDEN_DIRS = new Set(['node_modules', '.git', '__pycache__']);

export function isValidNewFolderName(value: string): boolean {
  if (!value || value.length > 120) return false;
  if (value === '.' || value === '..') return false;
  if (/[/\\\0]/.test(value)) return false;
  return true;
}

export function registerMatOSFsRoutes(app: Express): void {
  // Browse roots + one directory level. No file contents ever leave this
  // route — names and paths only, so the picker can navigate.
  app.get('/api/matos/fs/dirs', (req: Request, res: Response) => {
    void (async () => {
      const roots = configuredRoots();
      const requested = String(req.query.path ?? '').trim();
      if (!requested) {
        res.json({ roots, path: null, parent: null, dirs: [] });
        return;
      }
      const resolved = await resolveWithinRoots(requested, roots);
      if (!resolved) {
        res.status(403).json({ error: { code: 'MATOS_FS', message: 'path is outside the allowed roots' } });
        return;
      }
      let entries;
      try {
        entries = await readdir(resolved, { withFileTypes: true });
      } catch (error) {
        res.status(404).json({
          error: {
            code: 'MATOS_FS',
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      const dirs = entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('.') && !HIDDEN_DIRS.has(name))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 500)
        .map((name) => ({ name, path: path.join(resolved, name) }));
      const parentCandidate = path.dirname(resolved);
      const parent = await resolveWithinRoots(parentCandidate, roots);
      res.json({
        roots,
        path: resolved,
        parent: parent && parent !== resolved ? parent : null,
        dirs,
      });
    })().catch((error) => {
      res.status(502).json({
        error: {
          code: 'MATOS_FS',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });

  // Create one folder inside the jailed roots (the picker's "New folder").
  // The parent must already exist inside a root; the name is a single path
  // segment, so the new directory cannot escape the jail.
  app.post('/api/matos/fs/mkdir', (req: Request, res: Response) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parent = typeof body.parent === 'string' ? body.parent.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!isValidNewFolderName(name)) {
        res.status(400).json({ error: { code: 'MATOS_FS', message: 'invalid folder name' } });
        return;
      }
      const roots = configuredRoots();
      const resolvedParent = parent ? await resolveWithinRoots(parent, roots) : null;
      if (!resolvedParent) {
        res.status(403).json({ error: { code: 'MATOS_FS', message: 'parent is outside the allowed roots' } });
        return;
      }
      const target = path.join(resolvedParent, name);
      try {
        await mkdir(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        res.status(code === 'EEXIST' ? 409 : 502).json({
          error: {
            code: 'MATOS_FS',
            message:
              code === 'EEXIST'
                ? 'a file or folder with that name already exists'
                : error instanceof Error
                  ? error.message
                  : String(error),
          },
        });
        return;
      }
      res.json({ ok: true, path: target });
    })().catch((error) => {
      res.status(502).json({
        error: {
          code: 'MATOS_FS',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
}
