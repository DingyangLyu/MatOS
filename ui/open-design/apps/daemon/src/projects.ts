// @ts-nocheck
// Project files registry. Each project is a folder under
// <projectRoot>/.od/projects/<projectId>/. The frontend's project list
// (localStorage) carries metadata; this module is the single owner of the
// on-disk content (HTML artifacts, sketches, uploaded images, pasted text).
//
// All paths flowing in from HTTP handlers are validated against the project
// directory to prevent path traversal — see resolveSafe().

import { link, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {
  inferLegacyManifest,
  parsePersistedManifest,
  validateArtifactManifestInput,
} from './artifacts/manifest.js';
import {
  ArtifactRegressionError,
  STUB_GUARDED_MANIFEST_KINDS,
  evaluateArtifactStubGuard,
  readArtifactStubGuardConfigFromEnv,
} from './artifacts/stub-guard.js';
import {
  assertArtifactPublicationAllowed,
  isPublicationGuardedArtifactKind,
} from './artifacts/publication-guard.js';
import { normalizeArtifactRuntimeImports } from './artifacts/runtime-compat.js';
import { isIgnoredProjectDirName } from './project-ignored-dirs.js';
import {
  isSandboxImportedProjectRootAllowed,
  isSandboxModeEnabled,
  SANDBOX_IMPORTED_PROJECT_UNAVAILABLE_MESSAGE,
} from './sandbox-mode.js';
import { isOrchestratorScratchWorkspace } from './workspace-contract.js';

const FORBIDDEN_SEGMENT = /^$|^\.\.?$/;
const RESERVED_PROJECT_FILE_SEGMENTS = new Set(['.file-versions']);
export const RUN_ARTIFACT_RECONCILE_MTIME_GRACE_MS = 1000;
export const projectFileRenameTestHooks = {
  beforeCommit: null as null | ((paths: { source: string; target: string }) => Promise<void> | void),
};
export const projectFileWriteTestHooks = {
  afterCommit: null as null | ((write: { safeName: string; target: string; body: Buffer | string }) => Promise<void> | void),
  afterBodyCommit: null as null | ((write: { name: string; target: string }) => Promise<void> | void),
};

export type WriteProjectFileOptions = {
  overwrite?: boolean;
  artifactManifest?: unknown;
  expectedEtag?: string | null;
};

export class ProjectFileConflictError extends Error {
  code = 'PROJECT_FILE_CONFLICT';
  expectedEtag: string | null;
  actualEtag: string | null;

  constructor(name: string, expectedEtag: string | null, actualEtag: string | null) {
    super(`project file changed since it was read: ${name}`);
    this.name = 'ProjectFileConflictError';
    this.expectedEtag = expectedEtag;
    this.actualEtag = actualEtag;
  }
}

const projectFileMutationTails = new Map<string, Promise<void>>();

function projectFileMutationLockDir(key: string): string {
  const digest = createHash('sha256').update(path.resolve(key)).digest('hex').slice(0, 20);
  return path.join(path.dirname(key), `.matos-file-lock-${digest}`);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

async function readProjectFileMutationLockOwner(ownerPath: string): Promise<any> {
  try {
    return JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch {
    return null;
  }
}

async function acquireProjectFileMutationLock(key: string): Promise<() => Promise<void>> {
  const lockDir = projectFileMutationLockDir(key);
  const ownerPath = path.join(lockDir, 'owner.json');
  const token = randomUUID();
  const timeoutAt = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, `${JSON.stringify({ token, pid: process.pid })}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        const owner = await readProjectFileMutationLockOwner(ownerPath);
        if (owner?.token === token) {
          await rm(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readProjectFileMutationLockOwner(ownerPath);
      const orphaned = owner?.pid
        ? !processIsAlive(Number(owner.pid))
        : await stat(lockDir).then(info => Date.now() - info.mtimeMs > 5_000, () => false);
      if (orphaned) {
        const stalePath = `${lockDir}.stale.${randomUUID()}`;
        try {
          await rename(lockDir, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 25));
          continue;
        }
      }
      if (Date.now() >= timeoutAt) {
        throw new Error(`timed out waiting for project file mutation lock: ${key}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function withProjectFileMutationLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = projectFileMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.then(() => current);
  projectFileMutationTails.set(key, tail);
  await previous;
  let releaseFilesystemLock: (() => Promise<void>) | null = null;
  try {
    releaseFilesystemLock = await acquireProjectFileMutationLock(key);
    return await run();
  } finally {
    await releaseFilesystemLock?.().catch(() => {});
    release();
    if (projectFileMutationTails.get(key) === tail) projectFileMutationTails.delete(key);
  }
}

async function withProjectFileMutationLocks<T>(
  keys: string[],
  run: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(keys.map(key => path.resolve(key)))].sort();
  const acquire = async (index: number): Promise<T> => {
    const key = ordered[index];
    if (!key) return run();
    return withProjectFileMutationLock(key, () => acquire(index + 1));
  };
  return acquire(0);
}

function projectFileEtag(name: string, body: Buffer | string): string {
  return createHash('sha256')
    .update(name)
    .update('\0')
    .update(body)
    .digest('hex')
    .slice(0, 32);
}

type ProjectFileCommitJournal = {
  version: 1;
  name: string;
  target: string;
  temporaryPath: string;
  bodyEtag: string;
  sidecarTarget: string;
  sidecarTemporaryPath: string;
  sidecarHash: string;
};

function contentHash(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function projectFileJournalPath(target: string): string {
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 20);
  return path.join(path.dirname(target), `.matos-write-${digest}.json`);
}

// commitProjectFile stages atomic writes as `<target>.tmp.<pid>.<uuid>`
// siblings (body, sidecar, and journal temps all share the suffix). Those
// names are neither dotfiles nor `.artifact.json`, so without this predicate
// they leak onto every listing surface: a scan racing an in-flight write, a
// chokidar `add` event, the project/batch archives — and a crash mid-write
// with no sidecar leaves the temp body orphaned forever (only sidecar writes
// get a recovery journal). The exact pid+uuid shape keeps user files like
// `notes.tmp` or `video.tmp.mp4` out of the match.
const PROJECT_FILE_COMMIT_INTERMEDIATE_RE =
  /\.tmp\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProjectFileCommitIntermediateName(name: string): boolean {
  return PROJECT_FILE_COMMIT_INTERMEDIATE_RE.test(name);
}

// Watcher-event variant: chokidar payloads carry relative (or, defensively,
// absolute) paths in either separator style; the intermediate check always
// applies to the basename.
export function isProjectFileCommitIntermediateEventPath(rawPath: unknown): boolean {
  const base = String(rawPath ?? '').split(/[\\/]/).at(-1) ?? '';
  return isProjectFileCommitIntermediateName(base);
}

// How old an unclaimed commit intermediate must be before the recovery pass
// deletes it. Live writes hold their temps for milliseconds; anything this
// stale is crash residue with no journal left to claim it.
const PROJECT_FILE_COMMIT_INTERMEDIATE_ORPHAN_GRACE_MS = 15 * 60_000;

async function fileExists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: any) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
}

async function recoverProjectFileCommitUnlocked(target: string, name?: string): Promise<boolean> {
  const journalPath = projectFileJournalPath(target);
  let journal: ProjectFileCommitJournal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8')) as ProjectFileCommitJournal;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw new Error(`invalid project file transaction journal: ${journalPath}`);
  }
  const expectedSidecar = `${target}.artifact.json`;
  if (
    journal.version !== 1 ||
    journal.target !== target ||
    journal.sidecarTarget !== expectedSidecar ||
    journal.temporaryPath === target ||
    !journal.temporaryPath.startsWith(`${target}.tmp.`) ||
    !journal.sidecarTemporaryPath.startsWith(`${expectedSidecar}.tmp.`) ||
    (name && journal.name !== name)
  ) {
    throw new Error(`unsafe project file transaction journal: ${journalPath}`);
  }
  if (await fileExists(journal.temporaryPath)) {
    await rename(journal.temporaryPath, journal.target);
  }
  const body = await readFile(journal.target);
  if (projectFileEtag(journal.name, body) !== journal.bodyEtag) {
    throw new Error(`project file transaction body verification failed: ${journal.name}`);
  }
  if (await fileExists(journal.sidecarTemporaryPath)) {
    await rename(journal.sidecarTemporaryPath, journal.sidecarTarget);
  }
  const sidecar = await readFile(journal.sidecarTarget);
  if (contentHash(sidecar) !== journal.sidecarHash) {
    throw new Error(`project file transaction manifest verification failed: ${journal.name}`);
  }
  await rm(journalPath, { force: true });
  return true;
}

async function recoverProjectFileCommit(target: string, name?: string): Promise<boolean> {
  return withProjectFileMutationLock(target, () =>
    recoverProjectFileCommitUnlocked(target, name));
}

async function recoverPendingProjectFileCommits(dir: string, entries): Promise<boolean> {
  let recovered = false;
  // Two phases per directory: journaled commits first, orphan sweep second.
  // A journal and its temps always live in the same directory, so once every
  // journal here has been recovered (its temp renamed onto the target), any
  // commit intermediate still on disk is either an in-flight write (fresh,
  // protected by the grace window) or journal-less crash residue.
  const intermediates: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!entry.isFile()) continue;
    if (isProjectFileCommitIntermediateName(entry.name)) {
      intermediates.push(full);
      continue;
    }
    if (!/^\.matos-write-[a-f0-9]{20}\.json$/.test(entry.name)) continue;
    let journal: ProjectFileCommitJournal;
    try {
      journal = JSON.parse(await readFile(full, 'utf8')) as ProjectFileCommitJournal;
    } catch (error: any) {
      // A healthy writer may finish and remove its journal between readdir and
      // readFile. Anything else is persistent corruption and must stay loud.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (projectFileJournalPath(journal.target) !== full) {
      throw new Error(`unsafe project file transaction journal: ${full}`);
    }
    await recoverProjectFileCommit(journal.target, journal.name);
    recovered = true;
  }
  for (const full of intermediates) {
    let info;
    try {
      info = await lstat(full);
    } catch (error: any) {
      // Recovery above (or the owning writer) may have renamed/removed it.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile()) continue;
    if (Date.now() - info.mtimeMs < PROJECT_FILE_COMMIT_INTERMEDIATE_ORPHAN_GRACE_MS) continue;
    // Best-effort: a failed unlink must not break the listing that runs this
    // recovery pass; the next scan simply retries.
    await rm(full, { force: true }).catch(() => {});
  }
  return recovered;
}

async function commitProjectFile(input: {
  target: string;
  name: string;
  body: Buffer | string;
  overwrite: boolean;
  expectedEtag?: string | null;
  sidecar?: {
    target: string;
    body: Buffer | string;
  };
}): Promise<string> {
  return withProjectFileMutationLock(input.target, async () => {
    await recoverProjectFileCommitUnlocked(input.target, input.name);
    let actualEtag: string | null = null;
    let existingMode = 0o644;
    let exists = false;
    try {
      const info = await lstat(input.target);
      exists = true;
      if (info.isFile()) existingMode = info.mode & 0o777;
      if (input.expectedEtag !== undefined || !input.overwrite) {
        actualEtag = projectFileEtag(input.name, await readFile(input.target));
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (input.expectedEtag !== undefined && input.expectedEtag !== actualEtag) {
      throw new ProjectFileConflictError(input.name, input.expectedEtag, actualEtag);
    }
    if (!input.overwrite && exists) {
      const error: any = new Error('file already exists');
      error.code = 'EEXIST';
      throw error;
    }
    const temporaryPath = `${input.target}.tmp.${process.pid}.${randomUUID()}`;
    const sidecarTemporaryPath = input.sidecar
      ? `${input.sidecar.target}.tmp.${process.pid}.${randomUUID()}`
      : null;
    const journalPath = input.sidecar ? projectFileJournalPath(input.target) : null;
    let journalPublished = false;
    let committed = false;
    try {
      await writeFile(temporaryPath, input.body, { mode: existingMode });
      if (input.sidecar && sidecarTemporaryPath) {
        await mkdir(path.dirname(input.sidecar.target), { recursive: true });
        await writeFile(sidecarTemporaryPath, input.sidecar.body);
        const journal: ProjectFileCommitJournal = {
          version: 1,
          name: input.name,
          target: input.target,
          temporaryPath,
          bodyEtag: projectFileEtag(input.name, input.body),
          sidecarTarget: input.sidecar.target,
          sidecarTemporaryPath,
          sidecarHash: contentHash(input.sidecar.body),
        };
        const journalTemporaryPath = `${journalPath}.tmp.${process.pid}.${randomUUID()}`;
        try {
          await writeFile(journalTemporaryPath, `${JSON.stringify(journal)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
          await rename(journalTemporaryPath, journalPath!);
          journalPublished = true;
        } finally {
          await rm(journalTemporaryPath, { force: true }).catch(() => {});
        }
      }
      await rename(temporaryPath, input.target);
      await projectFileWriteTestHooks.afterBodyCommit?.({
        name: input.name,
        target: input.target,
      });
      if (input.sidecar && sidecarTemporaryPath) {
        // Keep the artifact body and its manifest under the same mutation
        // lock. Both files are staged before either is published, preventing
        // two concurrent writes from pairing one body with another manifest.
        await rename(sidecarTemporaryPath, input.sidecar.target);
      }
      if (journalPath) await rm(journalPath, { force: true });
      committed = true;
    } finally {
      if (committed || !journalPublished) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        if (sidecarTemporaryPath) {
          await rm(sidecarTemporaryPath, { force: true }).catch(() => {});
        }
      }
    }
    return projectFileEtag(input.name, input.body);
  });
}

export function isRunTouchedProjectFile(fileMtimeMs, runStartTimeMs) {
  if (!Number.isFinite(fileMtimeMs) || !Number.isFinite(runStartTimeMs)) return false;
  return fileMtimeMs + RUN_ARTIFACT_RECONCILE_MTIME_GRACE_MS >= runStartTimeMs;
}

function containsIgnoredProjectDirSegment(name: string): boolean {
  return name
    .split('/')
    .filter(Boolean)
    .some((segment) => isIgnoredProjectDirName(segment));
}

export function projectDir(projectsRoot, projectId) {
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return path.join(projectsRoot, projectId);
}

export class SandboxImportedProjectError extends Error {
  code = 'SANDBOX_IMPORTED_PROJECT_UNAVAILABLE';

  constructor() {
    super(SANDBOX_IMPORTED_PROJECT_UNAVAILABLE_MESSAGE);
    this.name = 'SandboxImportedProjectError';
  }
}

function hasExternalProjectRoot(metadata?) {
  if (typeof metadata?.baseDir !== 'string') return false;
  return path.isAbsolute(path.normalize(metadata.baseDir));
}

export function assertSandboxProjectRootAvailable(metadata?) {
  if (
    isSandboxModeEnabled(process.env) &&
    hasExternalProjectRoot(metadata) &&
    !isOrchestratorScratchWorkspace(metadata) &&
    !isSandboxImportedProjectRootAllowed(metadata.baseDir)
  ) {
    throw new SandboxImportedProjectError();
  }
}

function usesExternalProjectRoot(metadata?) {
  if (!hasExternalProjectRoot(metadata)) return false;
  if (isOrchestratorScratchWorkspace(metadata)) return true;
  if (!isSandboxModeEnabled(process.env)) return true;
  return isSandboxImportedProjectRootAllowed(metadata.baseDir);
}

// Returns the folder a project's files live in. For git-linked projects
// (metadata.baseDir set), this is the user's own folder. Otherwise falls
// back to the standard computed path under projectsRoot.
export function resolveProjectDir(projectsRoot, projectId, metadata?, opts = {}) {
  if (!opts.allowUnavailableSandboxImportedProject) {
    assertSandboxProjectRootAvailable(metadata);
  }
  if (usesExternalProjectRoot(metadata)) {
    return path.normalize(metadata.baseDir);
  }
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return path.join(projectsRoot, projectId);
}

export async function ensureProject(projectsRoot, projectId, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  // Git-linked folders already exist; skip mkdir to avoid side-effects.
  if (!usesExternalProjectRoot(metadata)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export async function listFiles(projectsRoot, projectId, opts = {}) {
  const metadata = opts?.metadata;
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  // Imported workspace folders can contain tens of thousands of source files.
  // Computing a content hash for every small file makes the first browser
  // index scan read the entire workspace before returning any metadata. The
  // editor still obtains a strong etag from read/write endpoints; omit the
  // eager hashes from this discovery-only path for external roots.
  const includeEtags = opts?.includeEtags ?? !hasExternalProjectRoot(metadata);
  const out = [];
  // Skip generated dependency/build trees for all project roots. Standard OD
  // projects can contain framework installs too; surfacing package HTML like
  // node_modules/tslib/*.html as artifacts produces blank previews.
  await collectFiles(dir, '', out, isIgnoredProjectDirName, dir, includeEtags);
  // Newest first — matches the visual order users expect after generating.
  out.sort((a, b) => b.mtime - a.mtime);
  const since = Number(opts.since);
  if (Number.isFinite(since) && since > 0) {
    return out.filter((f) => Number(f.mtime) > since);
  }
  return out;
}

// `/api/projects/:id/files` is a hot read path. Some imported workspaces contain
// tens of thousands of files, so recursively walking and stat'ing the complete
// tree for every browser refresh can occupy every libuv worker for minutes. Keep
// `listFiles()` as the uncached primitive for callers that explicitly need a
// point-in-time scan, and put the HTTP-oriented snapshot/singleflight layer here.
const PROJECT_FILES_CACHE_BASE_TTL_MS = 5_000;
const PROJECT_FILES_CACHE_MAX_TTL_MS = 5 * 60_000;
const PROJECT_FILES_CACHE_MAX_ENTRIES = 64;
const PROJECT_FILES_CACHE_MAX_CHANGES = 512;
const projectFilesListCache = new Map();
let projectFilesListScanCount = 0;
let lastProjectFilesSnapshot = 0;

export const projectFilesListCacheTestHooks = {
  beforeScan: null as null | (() => Promise<void> | void),
  ttlMs: null as null | number,
  getScanCount() {
    return projectFilesListScanCount;
  },
  reset() {
    projectFilesListCache.clear();
    projectFilesListScanCount = 0;
    lastProjectFilesSnapshot = 0;
    projectFilesListCacheTestHooks.beforeScan = null;
    projectFilesListCacheTestHooks.ttlMs = null;
  },
};

function cachedProjectFilesKey(projectsRoot, projectId, metadata?) {
  return path.resolve(resolveProjectDir(projectsRoot, projectId, metadata));
}

function evictIdleProjectFilesCacheEntry() {
  if (projectFilesListCache.size < PROJECT_FILES_CACHE_MAX_ENTRIES) return;
  const candidates = [...projectFilesListCache.values()]
    .filter((entry) => entry.watcherRefs === 0 && !entry.inFlight)
    .sort((a, b) => a.lastAccess - b.lastAccess);
  if (candidates[0]) projectFilesListCache.delete(candidates[0].key);
}

function cachedProjectFilesState(projectsRoot, projectId, metadata?) {
  const key = cachedProjectFilesKey(projectsRoot, projectId, metadata);
  let state = projectFilesListCache.get(key);
  if (!state) {
    evictIdleProjectFilesCacheEntry();
    state = {
      key,
      dir: key,
      filesByPath: new Map(),
      snapshotAt: 0,
      historyBase: 0,
      changes: [],
      ready: false,
      invalidated: true,
      invalidationRevision: 0,
      refreshAfter: 0,
      inFlight: null,
      pendingDuringScan: null,
      watcherRefs: 0,
      lastAccess: Date.now(),
    };
    projectFilesListCache.set(key, state);
  }
  state.lastAccess = Date.now();
  return state;
}

function nextProjectFilesSnapshot(state) {
  lastProjectFilesSnapshot = Math.max(
    Date.now(),
    lastProjectFilesSnapshot + 1,
    Number(state.snapshotAt || 0) + 1,
  );
  return lastProjectFilesSnapshot;
}

function visibleCachedProjectPath(raw) {
  let normalized;
  try {
    normalized = validateProjectPath(raw);
  } catch {
    return null;
  }
  const segments = normalized.split('/');
  // `.matos/assets/**` is user-authored runtime context and remains visible.
  // Every other root `.matos/**` path is internal authority, private state, or
  // runtime data and must only be exposed by the identity-aware MatOS APIs.
  if (
    segments[0]?.toLowerCase() === '.matos' &&
    segments[1]?.toLowerCase() !== 'assets'
  ) {
    return null;
  }
  const directorySegments = segments.slice(0, -1);
  if (segments.at(-1)?.startsWith('.')) return null;
  if (directorySegments.some((segment) => segment.startsWith('.') && segment.toLowerCase() !== '.matos')) {
    return null;
  }
  if (segments.slice(0, -1).some((segment) => isIgnoredProjectDirName(segment))) return null;
  if (segments.at(-1)?.endsWith('.artifact.json')) return null;
  if (isProjectFileCommitIntermediateName(segments.at(-1) ?? '')) return null;
  return normalized;
}

function cachedFilePath(file) {
  return visibleCachedProjectPath(String(file?.path || file?.name || ''));
}

function sortedCachedProjectFiles(state) {
  return [...state.filesByPath.values()].sort((a, b) => Number(b.mtime) - Number(a.mtime));
}

function projectFilesAreEqual(left, right) {
  if (!left || !right) return left === right;
  return left.path === right.path
    && left.localPath === right.localPath
    && Number(left.size) === Number(right.size)
    && Number(left.mtime) === Number(right.mtime)
    && left.etag === right.etag
    && left.kind === right.kind
    && left.mime === right.mime
    && left.artifactKind === right.artifactKind
    && JSON.stringify(left.artifactManifest ?? null) === JSON.stringify(right.artifactManifest ?? null);
}

function recordCachedProjectFileChange(state, relPath, file) {
  const previous = state.filesByPath.get(relPath) ?? null;
  if (projectFilesAreEqual(previous, file)) return false;
  if (file) state.filesByPath.set(relPath, file);
  else state.filesByPath.delete(relPath);

  const snapshotAt = nextProjectFilesSnapshot(state);
  state.snapshotAt = snapshotAt;
  state.changes.push({ snapshotAt, path: relPath, file });
  while (state.changes.length > PROJECT_FILES_CACHE_MAX_CHANGES) {
    const dropped = state.changes.shift();
    state.historyBase = dropped.snapshotAt;
  }
  return true;
}

function applyPendingProjectFileChanges(filesByPath, pending) {
  for (const change of pending || []) {
    if (!change.ready) continue;
    if (change.file) filesByPath.set(change.path, change.file);
    else filesByPath.delete(change.path);
  }
}

function adaptiveProjectFilesCacheTtl(scanDurationMs) {
  const override = projectFilesListCacheTestHooks.ttlMs;
  if (override !== null && Number.isFinite(Number(override)) && Number(override) >= 0) {
    return Number(override);
  }
  // A slow tree should not immediately trigger another expensive walk. Fast,
  // small projects still reconcile every few seconds when no watcher is open.
  return Math.min(
    PROJECT_FILES_CACHE_MAX_TTL_MS,
    Math.max(PROJECT_FILES_CACHE_BASE_TTL_MS, Math.ceil(scanDurationMs * 4)),
  );
}

function beginCachedProjectFilesScan(state, projectsRoot, projectId, metadata, scanner) {
  if (state.inFlight) return state.inFlight;
  const pending = [];
  const scanRevision = state.invalidationRevision;
  state.pendingDuringScan = pending;
  const startedAt = Date.now();

  const run = (async () => {
    projectFilesListScanCount += 1;
    await projectFilesListCacheTestHooks.beforeScan?.();
    const files = await scanner(projectsRoot, projectId, { metadata });
    const filesByPath = new Map();
    for (const file of Array.isArray(files) ? files : []) {
      const relPath = cachedFilePath(file);
      if (!relPath) continue;
      filesByPath.set(relPath, {
        ...file,
        name: relPath,
        path: relPath,
      });
    }
    applyPendingProjectFileChanges(filesByPath, pending);

    state.filesByPath = filesByPath;
    state.snapshotAt = nextProjectFilesSnapshot(state);
    state.historyBase = state.snapshotAt;
    state.changes = [];
    state.ready = true;
    // If a structural mutation happened while this scan was running, its
    // result may describe the pre-mutation tree. Leave the state invalidated
    // so the next freshness-required request performs one more scan.
    state.invalidated = state.invalidationRevision !== scanRevision;
    state.refreshAfter = Date.now() + adaptiveProjectFilesCacheTtl(Date.now() - startedAt);
    return state;
  })();

  let tracked;
  tracked = run.finally(() => {
    if (state.inFlight === tracked) state.inFlight = null;
    if (state.pendingDuringScan === pending) state.pendingDuringScan = null;
  });
  state.inFlight = tracked;
  return tracked;
}

function cachedProjectFilesResponse(state, since, stale) {
  const requestedSnapshot = Number(since);
  if (Number.isFinite(requestedSnapshot) && requestedSnapshot > 0) {
    const knownSnapshot = requestedSnapshot === state.historyBase
      || requestedSnapshot === state.snapshotAt
      || state.changes.some((change) => change.snapshotAt === requestedSnapshot);
    if (knownSnapshot) {
      const byPath = new Map();
      for (const change of state.changes) {
        if (change.snapshotAt > requestedSnapshot) byPath.set(change.path, change.file);
      }
      const files = [...byPath.values()]
        .filter(Boolean)
        .sort((a, b) => Number(b.mtime) - Number(a.mtime));
      const removed = [...byPath.entries()]
        .filter(([, file]) => !file)
        .map(([relPath]) => relPath);
      return {
        files,
        removed,
        complete: false,
        snapshotAt: state.snapshotAt,
        stale,
      };
    }
  }
  // No `since`, an expired delta token, or a token from a daemon restart all
  // receive the complete list. This preserves the route's historical default
  // semantics and lets incremental clients recover safely after cache loss.
  return {
    files: sortedCachedProjectFiles(state),
    removed: [],
    complete: true,
    snapshotAt: state.snapshotAt,
    stale,
  };
}

/**
 * Return a cached project-file snapshot for the HTTP list route.
 *
 * Concurrent cold/invalidated requests share exactly one recursive scan. A
 * watched project is updated by file events; an unwatched project uses a short,
 * adaptive stale-while-revalidate TTL so readers never queue behind routine
 * refresh scans.
 */
export async function listCachedProjectFiles(projectsRoot, projectId, opts = {}) {
  const metadata = opts?.metadata;
  const scanner = opts?.scanner || listFiles;
  const state = cachedProjectFilesState(projectsRoot, projectId, metadata);

  if (!state.ready) {
    await beginCachedProjectFilesScan(state, projectsRoot, projectId, metadata, scanner);
  }
  // Explicit structural invalidation is correctness-sensitive; unlike routine
  // TTL expiry it waits for the shared refresh before returning.
  while (state.invalidated) {
    await beginCachedProjectFilesScan(state, projectsRoot, projectId, metadata, scanner);
  }

  let stale = false;
  if (state.watcherRefs === 0 && Date.now() >= state.refreshAfter) {
    stale = true;
    void beginCachedProjectFilesScan(state, projectsRoot, projectId, metadata, scanner).catch(() => {
      // Keep the prior good snapshot and retry later; stale reads are preferable
      // to turning a transient filesystem failure into a request stampede.
      state.refreshAfter = Date.now() + PROJECT_FILES_CACHE_BASE_TTL_MS;
    });
  }
  return cachedProjectFilesResponse(state, opts?.since, stale);
}

async function readCachedProjectFileMetadata(projectDirPath, relPath) {
  const fullPath = path.join(projectDirPath, ...relPath.split('/'));
  let fileStat;
  try {
    fileStat = await lstat(fullPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  // Match collectFiles(): never follow or surface symlinks/special files.
  if (!fileStat.isFile()) return null;
  const manifest = await readManifestForPath(projectDirPath, relPath);
  const etag = fileStat.size <= 4 * 1024 * 1024
    ? await readFile(fullPath).then(body => projectFileEtag(relPath, body), () => undefined)
    : undefined;
  return {
    name: relPath,
    path: relPath,
    localPath: path.resolve(fullPath),
    type: 'file',
    size: fileStat.size,
    mtime: fileStat.mtimeMs,
    ...(etag ? { etag } : {}),
    kind: kindFor(relPath),
    mime: mimeFor(relPath),
    artifactKind: manifest?.kind,
    artifactManifest: manifest,
  };
}

/** Apply one chokidar/API mutation to an existing cached snapshot. */
export async function updateCachedProjectFilesFromEvent(projectsRoot, projectId, event, metadata?) {
  const key = cachedProjectFilesKey(projectsRoot, projectId, metadata);
  const state = projectFilesListCache.get(key);
  if (!state) return false;

  let rawPath = String(event?.path || '');
  const sidecar = rawPath.endsWith('.artifact.json');
  if (sidecar) rawPath = rawPath.slice(0, -'.artifact.json'.length);
  const relPath = visibleCachedProjectPath(rawPath);
  if (!relPath) return false;

  const pending = { path: relPath, file: null, ready: false };
  state.pendingDuringScan?.push(pending);
  let file = null;
  if (event?.kind !== 'unlink' || sidecar) {
    file = await readCachedProjectFileMetadata(state.dir, relPath);
  }
  pending.file = file;
  pending.ready = true;
  if (!state.ready) return false;
  return recordCachedProjectFileChange(state, relPath, file);
}

/** Mark structural changes (folder move/removal, root replacement) for rescan. */
export function invalidateCachedProjectFiles(projectsRoot, projectId, metadata?) {
  const key = cachedProjectFilesKey(projectsRoot, projectId, metadata);
  const state = projectFilesListCache.get(key);
  if (!state) return;
  state.invalidationRevision += 1;
  state.invalidated = true;
  state.refreshAfter = 0;
}

/** Forget a deleted/repointed project's snapshot immediately. */
export function dropCachedProjectFiles(projectsRoot, projectId, metadata?) {
  const key = cachedProjectFilesKey(projectsRoot, projectId, metadata);
  projectFilesListCache.delete(key);
}

/** Keep watcher-backed snapshots fresh without periodic full-tree rescans. */
export function retainCachedProjectFilesWatcher(projectsRoot, projectId, metadata?) {
  const state = cachedProjectFilesState(projectsRoot, projectId, metadata);
  state.watcherRefs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.watcherRefs = Math.max(0, state.watcherRefs - 1);
    if (state.watcherRefs === 0) {
      state.refreshAfter = Math.min(
        state.refreshAfter || Number.POSITIVE_INFINITY,
        Date.now() + PROJECT_FILES_CACHE_BASE_TTL_MS,
      );
    }
  };
}

export async function listProjectFolders(projectsRoot, projectId, opts = {}) {
  const metadata = opts?.metadata;
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const key = path.resolve(dir);
  const now = Date.now();
  const cached = projectFoldersListCache.get(key);
  if (cached?.folders && cached.expiresAt > now) {
    return cached.folders;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  if (!cached && projectFoldersListCache.size >= PROJECT_FOLDERS_CACHE_MAX_ENTRIES) {
    const oldestKey = projectFoldersListCache.keys().next().value;
    if (oldestKey) projectFoldersListCache.delete(oldestKey);
  }

  const inFlight = (async () => {
    projectFoldersListScanCount += 1;
    await projectFoldersListCacheTestHooks.beforeScan?.();
    const out = [];
    await collectFolders(dir, '', out, isIgnoredProjectDirName);
    out.sort((a, b) => a.name.localeCompare(b.name));
    projectFoldersListCache.set(key, {
      folders: out,
      expiresAt: Date.now() + (
        projectFoldersListCacheTestHooks.ttlMs ?? PROJECT_FOLDERS_CACHE_TTL_MS
      ),
      inFlight: null,
    });
    return out;
  })().catch((error) => {
    projectFoldersListCache.delete(key);
    throw error;
  });
  projectFoldersListCache.set(key, {
    folders: cached?.folders,
    expiresAt: cached?.expiresAt ?? 0,
    inFlight,
  });
  return inFlight;
}

const PROJECT_FOLDERS_CACHE_TTL_MS = 60_000;
const PROJECT_FOLDERS_CACHE_MAX_ENTRIES = 64;
const PROJECT_FOLDERS_SCAN_CONCURRENCY = 32;
const projectFoldersListCache = new Map();
let projectFoldersListScanCount = 0;

export const projectFoldersListCacheTestHooks = {
  beforeScan: null as null | (() => Promise<void> | void),
  ttlMs: null as null | number,
  getScanCount() {
    return projectFoldersListScanCount;
  },
  reset() {
    projectFoldersListCache.clear();
    projectFoldersListScanCount = 0;
    projectFoldersListCacheTestHooks.beforeScan = null;
    projectFoldersListCacheTestHooks.ttlMs = null;
  },
};

export function invalidateCachedProjectFolders(projectsRoot, projectId, metadata?) {
  projectFoldersListCache.delete(
    path.resolve(resolveProjectDir(projectsRoot, projectId, metadata)),
  );
}

async function collectFolders(dir, relDir, out, shouldSkipDir?: (name: string) => boolean) {
  let level = [{ full: dir, rel: relDir }];
  while (level.length > 0) {
    const next = [];
    for (let index = 0; index < level.length; index += PROJECT_FOLDERS_SCAN_CONCURRENCY) {
      const batch = level.slice(index, index + PROJECT_FOLDERS_SCAN_CONCURRENCY);
      const children = await Promise.all(batch.map(async current => {
        if (current.rel) {
          const st = await stat(current.full);
          out.push({
            name: current.rel,
            path: current.rel,
            type: 'dir',
            size: 0,
            mtime: st.mtimeMs,
          });
        }
        let entries = [];
        try {
          entries = await readdir(current.full, { withFileTypes: true });
        } catch (err) {
          if (err && err.code === 'ENOENT') return [];
          throw err;
        }
        return entries
          .filter(entry =>
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            !shouldSkipDir?.(entry.name))
          .map(entry => ({
            full: path.join(current.full, entry.name),
            rel: current.rel ? `${current.rel}/${entry.name}` : entry.name,
          }));
      }));
      next.push(...children.flat());
    }
    level = next;
  }
}

export async function createProjectFolder(projectsRoot, projectId, name, metadata?) {
  const dir = await ensureProject(projectsRoot, projectId, metadata);
  const safeName = sanitizePath(name);
  const target = await resolveSafeReal(dir, safeName);
  await mkdir(target, { recursive: true });
  const st = await stat(target);
  if (!st.isDirectory()) {
    const err = new Error('target path is not a folder');
    err.code = 'ENOTDIR';
    throw err;
  }
  invalidateCachedProjectFolders(projectsRoot, projectId, metadata);
  return {
    name: safeName,
    path: safeName,
    type: 'dir',
    size: 0,
    mtime: st.mtimeMs,
  };
}

// Resolve (and create) a subdirectory under a project root, confined to the
// project sandbox. Returns the absolute directory plus the sanitized,
// forward-slash relative path ('' when no subdir was requested). Used by the
// upload route so attachments dropped/picked while viewing a folder land in
// that folder instead of the project root.
export async function ensureProjectSubdir(projectsRoot, projectId, subdir, metadata?) {
  const dir = await ensureProject(projectsRoot, projectId, metadata);
  const raw = typeof subdir === 'string' ? subdir.trim() : '';
  if (!raw) return { absDir: dir, relDir: '' };
  const relDir = sanitizePath(raw);
  const target = await resolveSafeReal(dir, relDir);
  await mkdir(target, { recursive: true });
  invalidateCachedProjectFolders(projectsRoot, projectId, metadata);
  return { absDir: target, relDir };
}

// Recursively delete a folder (and everything under it) within the project
// sandbox. Refuses to delete the project root itself. resolveSafeReal confines
// the target to the project tree even across descendant symlinks.
export async function deleteProjectFolder(projectsRoot, projectId, name, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const safeName = sanitizePath(name);
  const target = await resolveSafeReal(dir, safeName);
  const dirReal = await realpath(dir).catch(() => dir);
  if (target === dirReal) {
    const err = new Error('cannot delete project root');
    err.code = 'EINVAL';
    throw err;
  }
  const st = await stat(target);
  if (!st.isDirectory()) {
    const err = new Error('target is not a folder');
    err.code = 'ENOTDIR';
    throw err;
  }
  await rm(target, { recursive: true, force: true });
  invalidateCachedProjectFolders(projectsRoot, projectId, metadata);
}

// Rename/move a folder (with everything under it) within the project sandbox.
// Refuses to touch the project root, to move a folder into its own subtree,
// and to overwrite an existing target. Open workspace tabs pointing at files
// under the old path are the caller's concern (the web client rewrites them).
export async function renameProjectFolder(projectsRoot, projectId, fromName, toName, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const oldName = sanitizePath(fromName);
  const newName = sanitizePath(toName);
  const source = await resolveSafeReal(dir, oldName);
  const dirReal = await realpath(dir).catch(() => dir);
  if (source === dirReal) {
    const err = new Error('cannot rename project root');
    err.code = 'EINVAL';
    throw err;
  }
  const st = await stat(source);
  if (!st.isDirectory()) {
    const err = new Error('source is not a folder');
    err.code = 'ENOTDIR';
    throw err;
  }
  if (oldName === newName) {
    return { name: newName, path: newName, type: 'dir', size: 0, mtime: st.mtimeMs };
  }
  if (newName.startsWith(`${oldName}/`)) {
    const err = new Error('cannot move a folder into itself');
    err.code = 'EINVAL';
    throw err;
  }
  const target = await resolveSafeReal(dir, newName);
  try {
    await stat(target);
    const err = new Error('target already exists');
    err.code = 'EEXIST';
    throw err;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  const stNew = await stat(target);
  invalidateCachedProjectFolders(projectsRoot, projectId, metadata);
  return { name: newName, path: newName, type: 'dir', size: 0, mtime: stNew.mtimeMs };
}

// Best-effort entry-file detector — looks for index.html at the root,
// then any *.html file. Returns null if nothing obvious is found, in
// which case the project simply opens to the file panel with no
// auto-selected tab.
export async function detectEntryFile(dir: string): Promise<string | null> {
  try {
    await stat(path.join(dir, 'index.html'));
    return 'index.html';
  } catch { /* not found */ }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const htmlFile = entries.find((e) => e.isFile() && /\.html?$/i.test(e.name));
    if (htmlFile) return htmlFile.name;
  } catch { /* ignore */ }
  return null;
}

async function collectFiles(
  dir,
  relDir,
  out,
  shouldSkipDir?: (name: string) => boolean,
  projectRoot = dir,
  includeEtags = true,
) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
    // Recover only the visible directories visited by this walk, rather than
    // recursively scanning dependency trees in a separate unfiltered pass.
    if (relDir.toLowerCase() !== '.matos' && await recoverPendingProjectFileCommits(dir, entries)) {
      entries = await readdir(dir, { withFileTypes: true });
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  const files = [];
  const sidecars = new Set(entries.filter(e => e.isFile() && e.name.endsWith('.artifact.json')).map(e => e.name));
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    const isMatOSDirectory = e.isDirectory() && e.name.toLowerCase() === '.matos';
    if (e.name.startsWith('.') && !isMatOSDirectory) continue;
    if (
      relDir.toLowerCase() === '.matos' &&
      e.name.toLowerCase() !== 'assets'
    ) continue;
    if (e.isDirectory()) {
      // Only root `.matos/assets` belongs in the generic project file view.
      // Private/member state and runtime authority are served separately.
      if (shouldSkipDir?.(e.name)) continue;
      await collectFiles(full, rel, out, shouldSkipDir, projectRoot, includeEtags);
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name.endsWith('.artifact.json')) continue;
    if (isProjectFileCommitIntermediateName(e.name)) continue;
    files.push({ rel, full, hasSidecar: sidecars.has(artifactManifestNameFor(e.name)) });
  }
  // Bound outstanding metadata I/O on shared filesystems. Missing sidecars are
  // already known from readdir, so do not issue one failing read per source file.
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(files.slice(offset, offset + 8).map(async ({ rel, full, hasSidecar }) => {
      let st;
      try {
        st = await lstat(full);
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      if (!st.isFile()) return null;
      const manifest = await readManifestForPath(projectRoot, rel, hasSidecar);
      const etag = includeEtags && st.size <= 4 * 1024 * 1024
        ? await readFile(full).then(body => projectFileEtag(rel, body), () => undefined)
        : undefined;
      return {
        name: rel,
        path: rel,
        localPath: path.resolve(full),
        type: 'file',
        size: st.size,
        mtime: st.mtimeMs,
        ...(etag ? { etag } : {}),
        kind: kindFor(rel),
        mime: mimeFor(rel),
        artifactKind: manifest?.kind,
        artifactManifest: manifest,
      };
    }));
    out.push(...batch.filter(Boolean));
  }
}

export async function buildBatchArchive(projectsRoot, projectId, fileNames, metadata?) {
  const projectRoot = resolveProjectDir(projectsRoot, projectId, metadata);
  const zip = new JSZip();
  let packed = 0;
  const rejected = [];

  for (const name of fileNames) {
    let filePath;
    try {
      filePath = resolveSafe(projectRoot, name);
    } catch (err) {
      rejected.push({ name, reason: `invalid path: ${err?.message || err}` });
      continue;
    }

    // Mirror the visible-file allowlist from collectFiles:
    // reject any hidden segment, .artifact.json sidecars, and symlinks at any
    // level of the path (not just the final basename).
    const relSegments = path.relative(projectRoot, filePath).split(path.sep);
    let hidden = false;
    for (const seg of relSegments) {
      if (seg.startsWith('.')) {
        hidden = true;
        break;
      }
    }
    if (hidden) {
      rejected.push({ name, reason: 'hidden segments are not eligible for archive' });
      continue;
    }
    if (path.basename(filePath).endsWith('.artifact.json')) {
      rejected.push({ name, reason: 'artifact sidecars are not eligible for archive' });
      continue;
    }
    if (isProjectFileCommitIntermediateName(path.basename(filePath))) {
      rejected.push({ name, reason: 'write intermediates are not eligible for archive' });
      continue;
    }

    // Walk each path segment from projectRoot to the target with lstat,
    // rejecting intermediate symlinks that could escape the project tree.
    let walk = projectRoot;
    let symlinkFound = false;
    for (const seg of relSegments) {
      walk = path.join(walk, seg);
      let segStat;
      try {
        segStat = await lstat(walk);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          rejected.push({ name, reason: `segment not found: ${seg}` });
          break;
        }
        throw err;
      }
      if (segStat.isSymbolicLink()) {
        symlinkFound = true;
        break;
      }
    }
    if (symlinkFound) {
      rejected.push({ name, reason: 'symlinks are not eligible for archive' });
      continue;
    }
    if (rejected.length > 0 && rejected[rejected.length - 1].name === name) continue;

    // Final stat on the resolved path (guards against TOCTOU between segment
    // walk and read, and catches non-regular files).
    let st;
    try {
      st = await lstat(filePath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        rejected.push({ name, reason: 'file not found' });
        continue;
      }
      throw err;
    }

    if (st.isSymbolicLink()) {
      rejected.push({ name, reason: 'symlinks are not eligible for archive' });
      continue;
    }
    if (!st.isFile()) {
      rejected.push({ name, reason: 'not a regular file' });
      continue;
    }

    const buf = await readFile(filePath);
    zip.file(name, buf, {
      date: new Date(st.mtimeMs),
      binary: true,
    });
    packed += 1;
  }

  // Fail-fast: any rejected entry means the request is invalid — mirror the
  // strict rejection semantics of the panel and full archive.
  if (rejected.length > 0) {
    const err = new Error(
      `${rejected.length} file(s) ineligible for archive: ${rejected.map((r) => r.name).join(', ')}`,
    );
    err.code = 'BAD_REQUEST';
    err.rejected = rejected;
    throw err;
  }

  if (packed === 0) {
    const err = new Error('no files could be packed');
    err.code = 'ENOENT';
    throw err;
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { buffer, baseName: '' };
}

export async function readProjectFile(projectsRoot, projectId, name, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const file = await resolveSafeReal(dir, name);
  await recoverProjectFileCommit(file, validateProjectPath(name));
  const buf = await readFile(file);
  const st = await stat(file);
  const rootReal = await realpath(dir).catch(() => dir);
  const rel = toProjectPath(path.relative(rootReal, file));
  const manifest = await readManifestForPath(dir, rel);
  return {
    buffer: buf,
    name: rel,
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    etag: projectFileEtag(rel, buf),
    mime: mimeFor(rel),
    kind: kindFor(rel),
    artifactKind: manifest?.kind,
    artifactManifest: manifest,
  };
}

// Like readProjectFile but skips loading the file content into memory.
// Used by the media streaming endpoint so large video files are never buffered.
export async function resolveProjectFilePath(projectsRoot, projectId, name, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const file = await resolveSafeReal(dir, name);
  await recoverProjectFileCommit(file, validateProjectPath(name));
  const st = await stat(file);
  const rootReal = await realpath(dir).catch(() => dir);
  const rel = toProjectPath(path.relative(rootReal, file));
  return {
    filePath: file,
    name: rel,
    size: st.size,
    mtime: st.mtimeMs,
    mime: mimeFor(rel),
    kind: kindFor(rel),
  };
}

export async function writeProjectFile(
  projectsRoot,
  projectId,
  name,
  body,
  options: WriteProjectFileOptions = {},
  metadata?,
) {
  const { overwrite = true, artifactManifest = null, expectedEtag } = options;
  const dir = await ensureProject(projectsRoot, projectId, metadata);
  const safeName = sanitizePath(name);
  const target = await resolveSafeReal(dir, safeName);
  body = normalizeArtifactRuntimeImports(safeName, body);
  await mkdir(path.dirname(target), { recursive: true });
  let stubGuardWarning = null;
  let validatedManifest = null;
  if (artifactManifest && typeof artifactManifest === 'object') {
    const validated = validateArtifactManifestInput(artifactManifest, safeName);
    if (validated.ok && validated.value) {
      validatedManifest = validated.value;
      // Publication guard: HTML/deck artifacts that still contain template
      // placeholders (e.g. pitch-deck `Name to confirm`, `$X.XM`) must not
      // land as published files. Runs at the write boundary so it covers
      // every artifact that flows through writeProjectFile, regardless of
      // which agent/atom produced the body. Throws
      // ArtifactPublicationBlockedError which the route layer maps to 422.
      if (isPublicationGuardedArtifactKind(validatedManifest.kind)) {
        assertArtifactPublicationAllowed(body);
      }
      const identifier = typeof validatedManifest.metadata?.identifier === 'string'
        ? validatedManifest.metadata.identifier
        : '';
      // Stub-guard applies to HTML-rendered manifest kinds (html, deck).
      // Other kinds (markdown, svg, code-snippet) can legitimately be small
      // and are skipped.
      if (identifier.length > 0 && STUB_GUARDED_MANIFEST_KINDS.has(validatedManifest.kind)) {
        // Scan the directory the new file actually lands in, not the project
        // root — writeProjectFile accepts nested paths like reports/X.html
        // and a root-only scan would miss prior siblings in subdirectories.
        const guard = await evaluateArtifactStubGuard({
          scanDir: path.dirname(target),
          identifier,
          newSize: Buffer.byteLength(body),
          config: readArtifactStubGuardConfigFromEnv(),
        });
        if ((guard.outcome === 'reject' || guard.outcome === 'warn') && guard.warning) {
          // Operator-visible signal regardless of mode, so on-call can see
          // how often the guard fires without combing through 422s.
          console.warn(
            `[stub-guard] ${guard.outcome} identifier=${guard.warning.identifier} ` +
              `newSize=${guard.warning.newSize} priorSize=${guard.warning.priorSize} ` +
              `priorName=${guard.warning.priorName} project=${projectId}`,
          );
        }
        if (guard.outcome === 'reject' && guard.warning) {
          throw new ArtifactRegressionError(guard.warning.message, {
            identifier: guard.warning.identifier,
            newSize: guard.warning.newSize,
            priorSize: guard.warning.priorSize,
            priorName: guard.warning.priorName,
          });
        }
        if (guard.outcome === 'warn' && guard.warning) {
          stubGuardWarning = guard.warning;
        }
      }
    }
  }
  const manifestTarget = validatedManifest
    ? await resolveSafeReal(dir, artifactManifestNameFor(safeName))
    : null;
  const etag = await commitProjectFile({
    target,
    name: safeName,
    body,
    overwrite,
    expectedEtag,
    ...(validatedManifest && manifestTarget
      ? {
          sidecar: {
            target: manifestTarget,
            body: JSON.stringify(validatedManifest, null, 2),
          },
        }
      : {}),
  });
  await projectFileWriteTestHooks.afterCommit?.({ safeName, target, body });
  const st = await stat(target);
  const persistedManifest = await readManifestForPath(dir, safeName);
  const result = {
    name: safeName,
    path: safeName,
    size: st.size,
    mtime: st.mtimeMs,
    etag,
    kind: kindFor(safeName),
    mime: mimeFor(safeName),
    artifactKind: persistedManifest?.kind,
    artifactManifest: persistedManifest,
  };
  if (stubGuardWarning) result.stubGuardWarning = stubGuardWarning;
  return result;
}

function artifactManifestNameFor(name) {
  return `${name}.artifact.json`;
}

export async function reconcileHtmlArtifactManifest(projectsRoot, projectId, name, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const safeName = validateProjectPath(name);
  if (containsIgnoredProjectDirSegment(safeName)) return null;
  const ext = path.extname(safeName).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') return null;

  let target;
  try {
    target = await resolveSafeReal(dir, safeName);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }

  let targetStat;
  try {
    targetStat = await stat(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!targetStat.isFile()) return null;
  if (await isViteDevHtmlEntry(dir, safeName, target)) return null;

  const manifestFileName = artifactManifestNameFor(safeName);
  const manifestTarget = await resolveSafeReal(dir, manifestFileName);
  try {
    const raw = await readFile(manifestTarget, 'utf8');
    return parseManifest(raw);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const inferred = inferLegacyManifest(safeName);
  if (!inferred) return null;
  const inferredMetadata =
    inferred.metadata && typeof inferred.metadata === 'object' && !Array.isArray(inferred.metadata)
      ? inferred.metadata
      : {};
  const validated = validateArtifactManifestInput(
    {
      ...inferred,
      createdAt: new Date(targetStat.mtimeMs).toISOString(),
      updatedAt: new Date(targetStat.mtimeMs).toISOString(),
      metadata: {
        ...inferredMetadata,
        inferred: true,
        reconciled: true,
      },
    },
    safeName,
    { preserveUpdatedAt: true },
  );
  if (!validated.ok || !validated.value) return null;
  await writeFile(manifestTarget, JSON.stringify(validated.value, null, 2));
  return validated.value;
}

async function readManifestForPath(projectDirPath, relPath, manifestExists = true) {
  if (containsIgnoredProjectDirSegment(relPath)) return null;
  const fullPath = path.join(projectDirPath, relPath);
  if (await isViteDevHtmlEntry(projectDirPath, relPath, fullPath)) return null;
  if (!manifestExists) return inferLegacyManifest(relPath);
  const manifestPath = path.join(projectDirPath, artifactManifestNameFor(relPath));
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = parseManifest(raw);
    if (parsed) return parsed;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      // ignore malformed/invalid manifests and fallback to inference
    }
  }
  return inferLegacyManifest(relPath);
}

function parseManifest(raw) {
  return parsePersistedManifest(raw, '');
}

export async function deleteProjectFile(
  projectsRoot,
  projectId,
  name,
  metadata?,
  expectedEtag?: string | null,
) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const file = await resolveSafeReal(dir, name);
  const safeName = validateProjectPath(name);
  const manifest = await resolveSafeReal(dir, artifactManifestNameFor(safeName));
  await withProjectFileMutationLock(file, async () => {
    await recoverProjectFileCommitUnlocked(file, safeName);
    let actualEtag: string | null = null;
    try {
      actualEtag = projectFileEtag(safeName, await readFile(file));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (expectedEtag !== undefined && expectedEtag !== actualEtag) {
      throw new ProjectFileConflictError(safeName, expectedEtag, actualEtag);
    }
    if (actualEtag === null) {
      const missing: any = new Error('file not found');
      missing.code = 'ENOENT';
      throw missing;
    }
    await unlink(file);
    await rm(manifest, { force: true });
  });
}

export async function renameProjectFile(
  projectsRoot,
  projectId,
  fromName,
  toName,
  metadata?,
  expectedEtag?: string | null,
) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const oldName = validateProjectPath(fromName);
  const newName = sanitizePath(toName);
  const source = await resolveSafeReal(dir, oldName);
  const target = await resolveSafeReal(dir, newName);
  await mkdir(path.dirname(target), { recursive: true });
  return withProjectFileMutationLocks([source, target], async () => {
    await recoverProjectFileCommitUnlocked(source, oldName);
    if (expectedEtag !== undefined) {
      let actualEtag: string | null = null;
      try {
        actualEtag = projectFileEtag(oldName, await readFile(source));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (expectedEtag !== actualEtag) {
        throw new ProjectFileConflictError(oldName, expectedEtag, actualEtag);
      }
    }
    return renameProjectFileUnlocked(projectsRoot, projectId, fromName, toName, metadata);
  });
}

async function renameProjectFileUnlocked(projectsRoot, projectId, fromName, toName, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const oldName = validateProjectPath(fromName);
  const newName = sanitizePath(toName);
  try {
    await stat(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const missing = new Error('source file not found');
      missing.code = 'ENOENT';
      throw missing;
    }
    throw err;
  }
  const source = await resolveSafeReal(dir, oldName);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) {
    const err = new Error('source is not a regular file');
    err.code = 'EISDIR';
    throw err;
  }

  if (oldName === newName) {
    const manifest = await readManifestForPath(dir, oldName);
    return {
      file: {
        name: oldName,
        path: oldName,
        size: sourceStat.size,
        mtime: sourceStat.mtimeMs,
        kind: kindFor(oldName),
        mime: mimeFor(oldName),
        artifactKind: manifest?.kind,
        artifactManifest: manifest,
      },
      oldName,
      newName: oldName,
    };
  }

  const target = await resolveSafeReal(dir, newName);
  const targetPath = source === target ? resolveSafe(dir, newName) : target;

  if (source !== target) {
    try {
      await stat(target);
      const err = new Error('target file already exists');
      err.code = 'EEXIST';
      throw err;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }

  const manifestRename = await prepareArtifactManifestRename(dir, oldName, newName);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await projectFileRenameTestHooks.beforeCommit?.({ source, target: targetPath });
  await renameFilePath(source, targetPath, { noOverwrite: true });
  await commitArtifactManifestRename(manifestRename, newName);
  await updateArtifactManifestRefsForRename(dir, oldName, newName);

  const st = await stat(targetPath);
  const manifest = await readManifestForPath(dir, newName);
  return {
    file: {
      name: newName,
      path: newName,
      size: st.size,
      mtime: st.mtimeMs,
      kind: kindFor(newName),
      mime: mimeFor(newName),
      artifactKind: manifest?.kind,
      artifactManifest: manifest,
    },
    oldName,
    newName,
  };
}

async function renameFilePath(source, target, opts = {}) {
  const { noOverwrite = false } = opts;
  if (source === target) return;
  const temp = await uniqueRenameTempPath(source);
  await rename(source, temp);
  try {
    if (noOverwrite) {
      await link(temp, target);
      try {
        await unlink(temp);
      } catch {
        // Preserve the target file even if cleanup of the temp link fails.
      }
    } else {
      await rename(temp, target);
    }
  } catch (err) {
    try {
      await rename(temp, source);
    } catch {
      // Preserve the original rename error even if restoring the source path fails.
    }
    throw err;
  }
}

async function uniqueRenameTempPath(source) {
  const dir = path.dirname(source);
  const base = path.basename(source);
  for (let i = 0; i < 10; i++) {
    const temp = path.join(dir, `.od-rename-${process.pid}-${Date.now()}-${i}-${base}.tmp`);
    try {
      await stat(temp);
    } catch (err) {
      if (err && err.code === 'ENOENT') return temp;
      throw err;
    }
  }
  const err = new Error('could not allocate temporary rename path');
  err.code = 'EEXIST';
  throw err;
}

async function prepareArtifactManifestRename(dir, oldName, newName) {
  const oldManifestName = artifactManifestNameFor(oldName);
  const oldManifestPath = await resolveSafeReal(dir, oldManifestName).catch((err) => {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  });
  if (!oldManifestPath) return null;

  let raw = null;
  try {
    raw = await readFile(oldManifestPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }

  const newManifestName = artifactManifestNameFor(newName);
  const newManifestPath = await resolveSafeReal(dir, newManifestName);
  const targetManifestPath = oldManifestPath === newManifestPath
    ? resolveSafe(dir, newManifestName)
    : newManifestPath;
  if (oldManifestPath !== newManifestPath) {
    try {
      await stat(newManifestPath);
      const err = new Error('target artifact manifest already exists');
      err.code = 'EEXIST';
      throw err;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }

  return { oldManifestPath, newManifestPath: targetManifestPath, raw, oldName };
}

async function commitArtifactManifestRename(manifestRename, newName) {
  if (!manifestRename) return;
  const { oldManifestPath, newManifestPath, raw, oldName } = manifestRename;
  await mkdir(path.dirname(newManifestPath), { recursive: true });
  const parsed = parseManifest(raw);
  if (parsed) {
    const parsedEntry = typeof parsed.entry === 'string'
      ? parsed.entry.replace(/\\/g, '/')
      : '';
    const renamedManifest = parsedEntry === oldName
      ? { ...parsed, entry: newName }
      : parsed;
    const validated = validateArtifactManifestInput(renamedManifest, newName);
    if (validated.ok && validated.value) {
      await writeFile(oldManifestPath, JSON.stringify(validated.value, null, 2));
      await renameFilePath(oldManifestPath, newManifestPath, { noOverwrite: true });
      return;
    }
  }
  await renameFilePath(oldManifestPath, newManifestPath, { noOverwrite: true });
}

async function updateArtifactManifestRefsForRename(dir, oldName, newName) {
  const manifests = [];
  await collectArtifactManifestFiles(dir, '', manifests);
  for (const manifestFile of manifests) {
    const ownerName = ownerNameForArtifactManifest(manifestFile.relPath);
    if (!ownerName) continue;
    let raw;
    try {
      raw = await readFile(manifestFile.fullPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    const parsed = parseManifest(raw);
    if (!parsed) continue;

    const updated = rewriteArtifactManifestRenameRefs(parsed, {
      ownerName,
      oldName,
      newName,
    });
    if (!updated.changed) continue;

    const validated = validateArtifactManifestInput(updated.manifest, ownerName);
    if (!validated.ok || !validated.value) continue;
    await writeFile(manifestFile.fullPath, JSON.stringify(validated.value, null, 2));
  }
}

async function collectArtifactManifestFiles(dir, relDir, out) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectArtifactManifestFiles(fullPath, relPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.artifact.json')) {
      out.push({ relPath, fullPath });
    }
  }
}

async function isViteDevHtmlEntry(projectDirPath, safeName, targetPath) {
  if (!/(^|\/)index\.html?$/i.test(safeName)) return false;
  let body = '';
  try {
    body = await readFile(targetPath, 'utf8');
  } catch {
    return false;
  }
  if (!/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/src\//i.test(body)) {
    return false;
  }
  const viteConfigCandidates = [
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.cts',
  ];
  for (const candidate of viteConfigCandidates) {
    try {
      const st = await stat(path.join(projectDirPath, candidate));
      if (st.isFile()) return true;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return false;
    }
  }
  try {
    const raw = await readFile(path.join(projectDirPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return Boolean(pkg?.dependencies?.vite || pkg?.devDependencies?.vite);
  } catch {
    return false;
  }
}

function ownerNameForArtifactManifest(manifestName) {
  const suffix = '.artifact.json';
  if (!manifestName.endsWith(suffix)) return null;
  return manifestName.slice(0, -suffix.length);
}

function rewriteArtifactManifestRenameRefs(manifest, { ownerName, oldName, newName }) {
  let changed = false;
  const next = { ...manifest };

  const entry = rewriteManifestRefForRename(next.entry, ownerName, oldName, newName, {
    preferProjectRoot: true,
  });
  if (entry.changed) {
    next.entry = entry.value;
    changed = true;
  }

  if (typeof next.primary === 'string') {
    const primary = rewriteManifestRefForRename(next.primary, ownerName, oldName, newName, {
      preferProjectRoot: true,
    });
    if (primary.changed) {
      next.primary = primary.value;
      changed = true;
    }
  }

  if (Array.isArray(next.supportingFiles)) {
    const supportingFiles = next.supportingFiles.map((ref) => {
      const updated = rewriteManifestRefForRename(ref, ownerName, oldName, newName);
      if (updated.changed) changed = true;
      return updated.value;
    });
    if (changed) next.supportingFiles = supportingFiles;
  }

  return { changed, manifest: next };
}

function rewriteManifestRefForRename(
  ref,
  ownerName,
  oldName,
  newName,
  options = {},
) {
  if (typeof ref !== 'string') return { changed: false, value: ref };
  const normalized = ref.replace(/\\/g, '/').trim();
  if (!normalized) return { changed: false, value: ref };

  if (options.preferProjectRoot && normalizeManifestProjectRootRef(normalized) === oldName) {
    return { changed: true, value: newName };
  }

  if (normalizeManifestProjectRef(normalized, ownerName) === oldName) {
    return {
      changed: true,
      value: relativeManifestRefForOwner(ownerName, newName),
    };
  }

  if (normalized === oldName) {
    return { changed: true, value: newName };
  }

  return { changed: false, value: ref };
}

function relativeManifestRefForOwner(ownerName, targetName) {
  const ownerDir = path.posix.dirname(ownerName);
  if (ownerDir === '.') return targetName;
  const relative = path.posix.relative(ownerDir, targetName);
  if (!relative || relative === '.' || relative.startsWith('../') || relative.includes('/../')) {
    return targetName;
  }
  return relative;
}

function normalizeManifestProjectRootRef(ref) {
  return normalizeManifestProjectRef(ref, '');
}

function normalizeManifestProjectRef(ref, ownerName) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const value = ref.trim().replace(/\\/g, '/');
  if (value.includes('\0') || value.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const ownerDir = path.posix.dirname(ownerName);
  const joined = ownerDir === '.' ? value : `${ownerDir}/${value}`;
  const normalized = path.posix.normalize(joined).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) return null;
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return normalized;
}

export async function removeProjectDir(projectsRoot, projectId) {
  const dir = projectDir(projectsRoot, projectId);
  await rm(dir, { recursive: true, force: true });
}

function resolveSafe(dir, name) {
  const safePath = validateProjectPath(name);
  const target = path.resolve(dir, safePath);
  if (!target.startsWith(dir + path.sep) && target !== dir) {
    throw new Error('path escapes project dir');
  }
  return target;
}

// Symlink-aware variant of resolveSafe. resolveSafe only does string-prefix
// validation, which is fooled by symlinks *inside* the project tree
// (a `assets/` symlink pointing at `/Users/me/.ssh` passes the prefix
// check because the literal path stays under dir, but the OS follows
// the link at open() time). This helper realpath()s the resolved
// candidate (or its existing prefix, for writes that haven't created
// the file yet) and re-validates against the realpath of dir, so
// descendant symlinks can't reach outside the project.
async function resolveSafeReal(dir, name) {
  const normalized = validateProjectPath(name);
  const assertPublicMatOSPath = (relativePath) => {
    const segments = toProjectPath(relativePath)
      .split('/')
      .map(segment => segment.toLowerCase());
    if (segments[0] !== '.matos' || segments[1] === 'assets') return;
    const error = new Error('path is internal MatOS project state');
    error.code = 'EPROJECTPRIVATE';
    throw error;
  };
  assertPublicMatOSPath(normalized);
  const candidate = resolveSafe(dir, name);
  const rootReal = await realpath(dir).catch(() => dir);
  let real;
  try {
    real = await realpath(candidate);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    // Write case: path doesn't exist yet. Realpath the longest existing
    // prefix and re-append the missing tail.
    real = await resolveExistingPrefix(candidate);
  }
  if (!real.startsWith(rootReal + path.sep) && real !== rootReal) {
    const e = new Error('path escapes project dir via symlink');
    e.code = 'EPATHESCAPE';
    throw e;
  }
  // A path that looks public can still traverse a symlink back into
  // `.matos/private` or another runtime directory. Re-apply the MatOS
  // visibility boundary to the canonical target, not only to user input.
  assertPublicMatOSPath(path.relative(rootReal, real));
  return real;
}

async function resolveExistingPrefix(p) {
  const parts = p.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = await realpath(prefix);
      const rest = parts.slice(i).join(path.sep);
      return rest ? path.join(real, rest) : real;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
  return p;
}

export function sanitizePath(raw) {
  const normalized = validateProjectPath(raw);
  const segments = normalized.split('/');
  // Preserve the root marker long enough for resolveSafeReal() to enforce the
  // MatOS boundary. Rewriting `.matos` to `_matos` silently bypassed that
  // check and created misleading shadow files.
  if (segments[0]?.toLowerCase() === '.matos') {
    return [
      '.matos',
      ...segments.slice(1).map(sanitizeName),
    ].join('/');
  }
  return segments.map(sanitizeName).join('/');
}

export function validateProjectPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('invalid file name');
  }
  const normalized = raw.replace(/\\/g, '/');
  if (raw.includes('\0') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) {
    throw new Error('invalid file name');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => FORBIDDEN_SEGMENT.test(p))) {
    throw new Error('invalid file name');
  }
  if (parts.some((part) => RESERVED_PROJECT_FILE_SEGMENTS.has(part))) {
    throw new Error('reserved project path');
  }
  return parts.join('/');
}

// Keep Unicode letters/digits as-is; replace path separators, control
// characters, and reserved punctuation with underscore. Spaces collapse
// to dashes (matches the kebab-case style used by the agent's slugs).
// The previous ASCII-only filter collapsed every non-ASCII character to
// '_', so a Chinese filename like '测试文档.docx' became '____.docx'
// (issue #144).
export function sanitizeName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || `file-${Date.now()}`;
}

// multer@1 decodes multipart filenames as latin1, which mangles any
// UTF-8 bytes (Chinese, Japanese, Cyrillic, ...) the user uploads. Re-
// decode as UTF-8 when the result round-trips back to the original
// bytes; otherwise the source was genuine latin1 and we leave it alone.
export function decodeMultipartFilename(name) {
  if (!name || typeof name !== 'string') return name ?? '';
  // If any code point exceeds 0xFF the source is already a properly
  // decoded Unicode string — for example, multer received an RFC 5987
  // `filename*` parameter and decoded it as UTF-8. Re-running latin1
  // -> utf8 here would corrupt those names, so exit early.
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xff) return name;
  }
  const buf = Buffer.from(name, 'latin1');
  const utf8 = buf.toString('utf8');
  return Buffer.from(utf8, 'utf8').equals(buf) ? utf8 : name;
}

function toProjectPath(raw) {
  return raw.split(path.sep).join('/');
}

// Validates an id string for use as a path segment under a daemon-managed
// directory (`.od/projects/<id>`, etc.). The character
// class allows dots so ids like `my-project.v2` work, but pure-dot ids
// (`.`, `..`, `...`) MUST be rejected — they pass the char-class check but
// resolve to the parent directory when fed into `path.join`. Without the
// pure-dot guard, an attacker could create a project row with id `..` (or
// reach this code via a percent-encoded URL like `/api/projects/%2e%2e/...`
// which Express decodes before the route handler sees it) and steer
// finalize / write operations outside `.od/projects/`.
export function isSafeId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 128) return false;
  if (/^\.+$/.test(id)) return false; // reject `.`, `..`, `...`, etc.
  return /^[A-Za-z0-9._-]+$/.test(id);
}

const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  // `.tsx` previously served as `text/typescript`, which browser module
  // loaders and strict CSPs do not accept as a JavaScript MIME. Multi-file
  // React prototypes that load `.tsx` via Babel-standalone (`<script
  // type="text/babel" src="…">`) need a JS-family Content-Type for the
  // browser fetch to succeed. Upstream of issue #336.
  '.tsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.ipynb': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

// Atomistic structure text formats (MatterViz viewer + text mode). Plain
// text mime keeps them visible to content search and text preview/edit.
const STRUCTURE_TEXT_EXTS = new Set(['.cif', '.mcif', '.xyz', '.extxyz', '.pdb', '.poscar', '.vasp']);
// Extension-less VASP structure files, matched by basename.
const STRUCTURE_TEXT_BASENAMES = new Set(['poscar', 'contcar', 'xdatcar']);

function isStructureTextFile(name) {
  const base = path.basename(name).toLowerCase();
  if (STRUCTURE_TEXT_BASENAMES.has(base) || STRUCTURE_TEXT_BASENAMES.has(base.split('.')[0])) {
    return true;
  }
  return STRUCTURE_TEXT_EXTS.has(path.extname(base));
}

// Scientific-computing / materials-science text formats. These are plain-text
// inputs, outputs, logs, and data files produced by DFT / MD / quantum-
// chemistry codes (VASP, Quantum ESPRESSO, LAMMPS, Gaussian, CP2K, SIESTA,
// ABINIT, GROMACS, NWChem, CASTEP, Wannier90, GULP, ORCA, …) plus common
// config/data/markup formats. They used to fall through `kindFor` to
// 'binary', so the web file viewer refused them as un-previewable binaries —
// the exact complaint about `.in` / `.out` not opening. Treat them as text so
// they open in the read-only/code viewer and show up in content search.
// Known-binary companions (WAVECAR, .chk, .npy, .h5, .traj, …) are
// intentionally excluded so they keep downloading instead of garbling.
const SCIENCE_TEXT_EXTS = new Set([
  // generic simulation input / output / logs / tabular data
  '.in', '.out', '.log', '.dat', '.err', '.res', '.restart', '.rst',
  '.inp', '.output', '.stdout', '.stderr',
  // Quantum ESPRESSO
  '.pwi', '.pwo', '.efi', '.efo', '.phi', '.pho',
  // SIESTA / ABINIT / NWChem / CP2K / CASTEP / Wannier90 / GULP / ORCA
  '.fdf', '.abi', '.abo', '.nw', '.nwo', '.cp2k',
  '.castep', '.cell', '.param', '.win', '.gin', '.got', '.orca',
  // Gaussian / other quantum-chemistry inputs
  '.gjf', '.gau', '.com',
  // LAMMPS / molecular dynamics
  '.lmp', '.lammps', '.dump', '.lammpstrj', '.data',
  // GROMACS
  '.gro', '.top', '.itp', '.mdp', '.ndx',
  // structures / grids / densities (ASCII)
  '.xsf', '.bxsf', '.cube', '.chg', '.rho', '.mol', '.mol2', '.sdf',
  '.pdbqt', '.xsd', '.arc', '.hkl', '.frac', '.gen',
  // spectra / curves
  '.band', '.dos', '.pdos', '.kpt', '.scf', '.spec',
  // config / data / markup / docs
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.config',
  '.env', '.csv', '.tsv', '.xml', '.properties', '.tex', '.bib',
  // Quantum ESPRESSO post-processing / pseudopotential text
  '.rap', '.gnu', '.upf', '.pdos_tot',
  // shell scripts / job schedulers
  '.sh', '.bash', '.zsh', '.slurm', '.sbatch', '.pbs', '.job', '.run',
]);

const CODE_TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonl',
  '.ndjson', '.ipynb', '.css', '.scss', '.sass', '.less', '.py', '.r',
  '.rb', '.php', '.java', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.hxx', '.go', '.rs', '.swift', '.kt', '.kts', '.scala', '.jl', '.lua',
  '.sql', '.graphql', '.gql', '.vue', '.svelte',
]);

const GENERIC_TEXT_EXTS = new Set([
  '.adoc', '.org', '.nfo', '.lock', '.diff', '.patch', '.tmpl',
  '.template', '.proto', '.gradle',
]);

const GENERIC_TEXT_BASENAMES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'license', 'licence', 'notice',
  'copying', 'authors', 'contributors', 'changelog',
]);

// Extension-less scientific input/output files, matched by basename. VASP is
// the classic case (INCAR / KPOINTS / OUTCAR / … carry no extension). CHGCAR /
// CHG / LOCPOT / ELFCAR / POTCAR are large but ASCII; WAVECAR is binary and is
// deliberately absent.
const SCIENCE_TEXT_BASENAMES = new Set([
  'incar', 'kpoints', 'outcar', 'oszicar', 'doscar', 'eigenval',
  'ibzkpt', 'procar', 'chgcar', 'chg', 'locpot', 'elfcar', 'potcar',
  'dynmat', 'pcdat', 'kpath',
]);

function isScienceTextFile(name) {
  const base = path.basename(name).toLowerCase();
  if (SCIENCE_TEXT_BASENAMES.has(base)) return true;
  // QE projwfc.x uses suffixes such as
  // `si.pdos_atm#1(Si)_wfc#2(p)` that path.extname cannot classify usefully.
  if (/\.pdos_(?:tot|atm#)/i.test(base)) return true;
  return SCIENCE_TEXT_EXTS.has(path.extname(base));
}

function isGenericTextFile(name) {
  const base = path.basename(name).toLowerCase();
  return GENERIC_TEXT_BASENAMES.has(base) || GENERIC_TEXT_EXTS.has(path.extname(base));
}

export function mimeFor(name) {
  if (isStructureTextFile(name) || isScienceTextFile(name)) {
    return 'text/plain; charset=utf-8';
  }
  const ext = path.extname(name).toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (CODE_TEXT_EXTS.has(ext) || isGenericTextFile(name)) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

// Parses an HTTP Range header (RFC 7233) for a single byte range.
// Returns { start, end } for a satisfiable range, 'unsatisfiable' for a
// 416-class range, or null if the header is absent/malformed/multi-range
// (callers fall back to a full 200 response in the null case).
export function parseByteRange(header, fileSize) {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6).trim();
  // Multi-range is valid RFC 7233 but uncommon for media; fall back to full.
  if (spec.includes(',')) return null;
  const dashIdx = spec.indexOf('-');
  if (dashIdx === -1) return null;
  const rawStart = spec.slice(0, dashIdx);
  const rawEnd = spec.slice(dashIdx + 1);
  let start, end;
  if (rawStart === '') {
    // Suffix range: bytes=-N → last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || !Number.isInteger(suffix) || suffix <= 0) {
      return 'unsatisfiable';
    }
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isFinite(start) || !Number.isInteger(start) || start < 0) return null;
    if (start >= fileSize) return 'unsatisfiable';
    if (rawEnd === '') {
      // Open-ended range: bytes=N- → from N to EOF.
      end = fileSize - 1;
    } else {
      end = Number(rawEnd);
      if (!Number.isFinite(end) || !Number.isInteger(end) || end < start) return null;
      end = Math.min(end, fileSize - 1); // clamp over-long end
    }
  }
  return { start, end };
}

export async function searchProjectFiles(projectsRoot, projectId, query, opts = {}) {
  const max = Math.min(Number(opts.max) || 200, 1000);
  const pattern = opts.pattern || null;
  const metadata = opts.metadata;
  const items = await listFiles(projectsRoot, projectId, { metadata });
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const escaped = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'i');
  const matches = [];
  for (const f of items) {
    if (!isTextualMime(f.mime)) continue;
    if (pattern && !globMatch(f.name, pattern)) continue;
    let content;
    try {
      content = await readFile(path.join(dir, f.name), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const snippet = lines[i].length > 220 ? lines[i].slice(0, 220) + '…' : lines[i];
        matches.push({ file: f.name, line: i + 1, snippet });
        if (matches.length >= max) return matches;
      }
    }
  }
  return matches;
}

function isTextualMime(mime) {
  if (!mime) return false;
  return (
    /^text\//i.test(mime) ||
    /^application\/(json|javascript|typescript|xml|x-(?:yaml|toml|httpd-php|sh))\b/i.test(mime) ||
    /\+(?:json|xml)\b/i.test(mime) ||
    /^image\/svg\+xml/i.test(mime)
  );
}

function globMatch(name, glob) {
  const re = new RegExp(
    '^' +
      glob
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return re.test(name);
}

// Coarse kind buckets the frontend uses to pick a viewer.
export function kindFor(name) {
  const lowerName = name.toLowerCase();
  // MatOS workflow definitions open in the Workflow Studio canvas tab —
  // JSON project drafts, YAML definitions, and bare asset entry files
  // (`workflow.json` / `workflow.yaml`, the native workflow asset layout).
  // The web side mirrors this in workflow-model.ts `isWorkflowFileName`.
  if (
    lowerName.endsWith('.workflow.json') ||
    lowerName.endsWith('.workflow.yaml') ||
    lowerName.endsWith('.workflow.yml')
  ) return 'workflow';
  {
    const workflowBase = lowerName.split('/').pop() ?? lowerName;
    if (
      workflowBase === 'workflow.json' ||
      workflowBase === 'workflow.yaml' ||
      workflowBase === 'workflow.yml'
    ) return 'workflow';
  }
  // Atomistic structure text files read as text (the web app routes them to
  // the MatterViz 3D viewer by filename before the text/code branch).
  if (isStructureTextFile(name)) return 'text';
  const ext = path.extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'image';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a'].includes(ext)) return 'audio';
  if (['.md', '.txt'].includes(ext) || isGenericTextFile(name)) return 'text';
  if (CODE_TEXT_EXTS.has(ext)) return 'code';
  // Scientific-computing / materials-science plain-text inputs, outputs,
  // logs, structures, and configs (VASP INCAR/OUTCAR, QE .pwi/.pwo,
  // LAMMPS, Gaussian .gjf, .in/.out/.log/.dat, …). Route to the text viewer
  // instead of falling through to the binary "cannot preview" bucket.
  if (isScienceTextFile(name)) return 'text';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'document';
  if (ext === '.pptx') return 'presentation';
  if (ext === '.xlsx') return 'spreadsheet';
  return 'binary';
}
