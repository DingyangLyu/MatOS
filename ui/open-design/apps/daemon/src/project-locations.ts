import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectLocationPrefs } from './app-config.js';
import { expandHomePrefix } from './home-expansion.js';
import { isSafeId } from './projects.js';

export const BUILT_IN_PROJECT_LOCATION_ID = 'default';
export const ENV_PROJECT_LOCATION_ID = 'workspace';
export const SHARED_WORKSPACES_PROJECT_LOCATION_ID = 'shared-workspaces';
export const PROJECT_MANIFEST_RELATIVE_PATH = path.join('.open-design', 'project.json');

export interface ProjectLocation extends ProjectLocationPrefs {
  builtIn?: boolean;
}

export interface ProjectManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  skillId?: string | null;
  // Paper projects carry their identity in the folder manifest so a shared
  // directory imported by a collaborator's daemon (project-location scan of
  // /workspace/group/workspaces) lands in their Papers list with the main
  // document intact — the owner's SQLite metadata is not visible there.
  matosPaperProject?: boolean;
  latexRoot?: string;
}

export function builtInProjectLocation(projectsDir: string): ProjectLocation {
  return {
    id: BUILT_IN_PROJECT_LOCATION_ID,
    name: 'MatOS projects',
    path: projectsDir,
    builtIn: true,
  };
}

export function allProjectLocations(projectsDir: string, external: ProjectLocationPrefs[] | undefined): ProjectLocation[] {
  return [builtInProjectLocation(projectsDir), ...(external ?? []).filter(location => location.id !== SHARED_WORKSPACES_PROJECT_LOCATION_ID)];
}

/**
 * Deployment-provided default project location (MatOS lab deployments point
 * this at the user's workspace, e.g. `<workspace>/projects`, so "new project"
 * folders land inside the folder tree the user's agents already work in).
 * `OD_DEFAULT_PROJECT_LOCATION` is the absolute root (created on demand);
 * `OD_DEFAULT_PROJECT_LOCATION_NAME` optionally labels it in pickers. The
 * location is env-owned: it is merged into reads but never persisted into
 * app-config.json, so redeploys with a different path stay authoritative.
 */
export async function envDefaultProjectLocation(): Promise<ProjectLocation | null> {
  const raw = process.env.OD_DEFAULT_PROJECT_LOCATION;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const canonical = await ensureProjectLocation(raw);
    const name = process.env.OD_DEFAULT_PROJECT_LOCATION_NAME?.trim() || 'Workspace';
    return { id: ENV_PROJECT_LOCATION_ID, name, path: canonical };
  } catch {
    // Unreachable/permission-denied roots simply don't surface; the built-in
    // managed location keeps project creation working.
    return null;
  }
}

const MAX_PROJECT_DIRECTORY_CODEPOINTS = 72;

/**
 * Turn a user-facing project name into one safe filesystem segment while
 * preserving non-Latin names. Project ids remain opaque database identities;
 * the directory is the human-facing workspace users see in terminals.
 */
export function projectDirectoryName(name: string, fallbackProjectId: string): string {
  const normalized = name
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  const shortened = Array.from(normalized).slice(0, MAX_PROJECT_DIRECTORY_CODEPOINTS).join('');
  if (shortened && !/^\.+$/.test(shortened)) return shortened;
  const fallback = fallbackProjectId.replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 12);
  return `project-${fallback || 'untitled'}`;
}

function assertInsideLocation(locationRoot: string, projectDir: string): void {
  const relative = path.relative(locationRoot, projectDir);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('project directory escapes project location');
  }
}

export async function createLocationProjectDir(
  location: ProjectLocation,
  projectId: string,
  requestedFolderName?: string,
  options: { exactName?: boolean } = {},
): Promise<string> {
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  const root = await realpath(location.path);
  const baseName = requestedFolderName
    ? projectDirectoryName(requestedFolderName, projectId)
    : projectId;
  const candidates = requestedFolderName && !options.exactName
    ? [baseName, ...Array.from({ length: 98 }, (_, index) => `${baseName}-${index + 2}`)]
    : [baseName];
  for (const candidate of candidates) {
    const target = path.join(root, candidate);
    try {
      await mkdir(target, { recursive: false });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) {
        throw new Error('project directory must not be a symbolic link');
      }
      if (options.exactName) {
        throw Object.assign(new Error('project directory name is already in use'), { code: 'PROJECT_FOLDER_EXISTS' });
      }
      if (requestedFolderName) continue;
      throw error;
    }
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('project directory must be a real directory');
    }
    const canonical = await realpath(target);
    assertInsideLocation(root, canonical);
    return canonical;
  }
  throw new Error(`project directory name is already in use: ${baseName}`);
}

export async function canonicalLocationChildDir(location: ProjectLocation, childName: string): Promise<string> {
  const root = await realpath(location.path);
  if (!isSafeId(childName)) throw new Error('invalid project directory name');
  const target = path.join(root, childName);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('project directory must be a real directory');
  const canonical = await realpath(target);
  assertInsideLocation(root, canonical);
  return canonical;
}

export function manifestPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_MANIFEST_RELATIVE_PATH);
}

export async function ensureProjectLocation(locationPath: string): Promise<string> {
  const expanded = expandHomePrefix(locationPath.trim());
  if (!path.isAbsolute(expanded)) throw new Error(`project location must be an absolute path: ${locationPath}`);
  await mkdir(expanded, { recursive: true });
  return realpath(expanded);
}

export async function writeProjectManifest(projectDir: string, manifest: ProjectManifest): Promise<void> {
  const file = manifestPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

export async function readProjectManifest(projectDir: string): Promise<ProjectManifest | null> {
  try {
    const raw = await readFile(manifestPath(projectDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.schemaVersion !== 1) return null;
    if (typeof obj.id !== 'string' || !isSafeId(obj.id)) return null;
    if (typeof obj.name !== 'string' || !obj.name.trim()) return null;
    const createdAt = typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : Date.now();
    const updatedAt = typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : createdAt;
    return {
      schemaVersion: 1,
      id: obj.id,
      name: obj.name.trim(),
      createdAt,
      updatedAt,
      skillId: typeof obj.skillId === 'string' ? obj.skillId : null,
      ...(obj.matosPaperProject === true ? { matosPaperProject: true } : {}),
      ...(typeof obj.latexRoot === 'string' && obj.latexRoot.trim()
        ? { latexRoot: obj.latexRoot.trim() }
        : {}),
    };
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string };
    if (e.code === 'ENOENT' || e.name === 'SyntaxError') return null;
    throw err;
  }
}

export async function scanProjectLocation(location: ProjectLocation): Promise<Array<{ dir: string; manifest: ProjectManifest }>> {
  const entries = await readdir(location.path, { withFileTypes: true });
  const found: Array<{ dir: string; manifest: ProjectManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let dir: string;
    try {
      dir = await canonicalLocationChildDir(location, entry.name);
    } catch {
      continue;
    }
    const manifest = await readProjectManifest(dir);
    if (manifest) found.push({ dir, manifest });
  }
  return found;
}
