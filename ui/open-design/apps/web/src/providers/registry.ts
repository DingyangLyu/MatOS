import { projectUploadBatches } from './upload-batches';
import type {
  ReplaceProjectWorkingDirResponse,
  ProjectFileVersion,
  ProjectFilesPageResponse,
  ProjectFileVersionSource,
  ProjectFileVersionResponse,
  ProjectFileVersionsResponse,
  RestoreProjectFileVersionResponse,
} from '@open-design/contracts';
import type {
  AgentInfo,
  AppVersionInfo,
  AppVersionResponse,
  ChatAttachment,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentUpsertRequest,
  Project,
  ProjectFile,
  ProjectFolder,
  RenameProjectFileResponse,
  SkillDetail,
  SkillSummary,
} from '../types';
import type { ArtifactManifest } from '../artifacts/types';
import {
  isOpenDesignHostAvailable,
  openHostExternalUrl,
} from '@open-design/host';

export async function fetchAgents(options?: { throwOnError?: boolean }): Promise<AgentInfo[]> {
  try {
    const resp = await fetch('/api/agents', { cache: 'no-store' });
    if (!resp.ok) {
      if (options?.throwOnError) throw new Error(`agents ${resp.status}`);
      return [];
    }
    const json = (await resp.json()) as { agents: AgentInfo[] };
    return json.agents ?? [];
  } catch (err) {
    if (options?.throwOnError) throw err;
    return [];
  }
}

// Incremental agent detection over Server-Sent Events: `onAgent` fires once
// per agent the moment its probe settles (completion order, not registry
// order), so a caller can paint cards as they resolve instead of waiting for
// the slowest CLI. Resolves with every agent collected once the stream's
// terminal `done` event arrives. This is additive: callers that don't need
// incremental delivery keep using `fetchAgents()` (whose batch probe is now
// parallelized per-agent and so is itself faster). Pass an AbortSignal to
// cancel the underlying request.
export async function fetchAgentsStream(args: {
  onAgent: (agent: AgentInfo) => void;
  signal?: AbortSignal;
}): Promise<AgentInfo[]> {
  const { onAgent, signal } = args;
  const resp = await fetch('/api/agents?stream=1', {
    cache: 'no-store',
    headers: { Accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`agents stream ${resp.status}`);
  }
  const collected: AgentInfo[] = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const errorMessageFromData = (data: string): string => {
    if (!data.trim()) return 'agents stream error';
    try {
      const parsed = JSON.parse(data) as { error?: unknown; message?: unknown };
      const message = parsed.error ?? parsed.message;
      if (typeof message === 'string' && message.trim()) return message;
    } catch {
      // Fall through to the raw data string below.
    }
    return data;
  };

  const handleEvent = (rawEvent: string) => {
    // Each SSE record is `event: <name>\ndata: <json>`; we act on `agent`
    // (one AgentInfo), `error` (terminal failure), and `done` (terminal
    // success). Unknown events are ignored so the protocol can grow without
    // breaking older clients.
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('\n');
    if (eventName === 'done') {
      done = true;
      return;
    }
    if (eventName === 'error') {
      throw new Error(errorMessageFromData(data));
    }
    if (eventName === 'agent' && data) {
      try {
        const agent = JSON.parse(data) as AgentInfo;
        collected.push(agent);
        onAgent(agent);
      } catch {
        // Ignore a malformed record rather than aborting the whole stream.
      }
    }
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE records are separated by a blank line ("\n\n").
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (rawEvent.trim().length > 0) handleEvent(rawEvent);
        if (done) break;
      }
    }
    if (!done && buffer.trim().length > 0) {
      handleEvent(buffer);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed; nothing to do.
    }
  }
  if (!done) {
    throw new Error('agents stream ended before done');
  }
  return collected;
}

export async function fetchSkills(): Promise<SkillSummary[]> {
  try {
    const resp = await fetch('/api/skills');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { skills: SkillSummary[] };
    return json.skills ?? [];
  } catch {
    return [];
  }
}

// Design templates — the rendering catalogue (decks, prototypes, image/
// video/audio templates). Same SkillSummary shape as functional skills,
// fetched from a separate registry root so the EntryView Templates tab
// and Settings → Skills surface stay decoupled.
export async function fetchDesignTemplates(): Promise<SkillSummary[]> {
  try {
    const resp = await fetch('/api/design-templates');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { designTemplates: SkillSummary[] };
    return json.designTemplates ?? [];
  } catch {
    return [];
  }
}

// Body for POST /api/skills/import. Mirrors the contracts type but is
// repeated here so the registry module is self-describing for callers.
export interface SkillImportInput {
  name: string;
  description?: string;
  body: string;
  triggers?: string[];
}

export interface SkillImportError {
  code?: string;
  message: string;
}

// Update an existing skill's body. For built-in skills the daemon writes
// a "shadow" copy under the user-skills root; the next listSkills() pass
// surfaces it in place of the bundled copy. The id passed here must
// match the SKILL.md frontmatter `name` — the daemon refuses cross-id
// renames so callers can drop "edit" into the same surface they use for
// "edit my own draft".
export interface SkillUpdateInput {
  name?: string;
  description?: string;
  body: string;
  triggers?: string[];
}

export interface SkillFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}

export async function fetchSkill(id: string): Promise<SkillDetail | null> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as SkillDetail;
  } catch {
    return null;
  }
}

export async function daemonIsLive(): Promise<boolean> {
  try {
    const resp = await fetch('/api/health');
    return resp.ok;
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (isOpenDesignHostAvailable()) {
    const opened = await openHostExternalUrl(url);
    if (opened.ok) return true;
  }
  try {
    const resp = await fetch('/api/system/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (resp.ok) {
      const json = (await resp.json().catch(() => null)) as { ok?: unknown } | null;
      if (json?.ok === true) return true;
    }
  } catch {
    // Fall through to current-tab navigation below.
  }
  try {
    window.location.assign(url);
  } catch {
    return false;
  }
  return false;
}

function isAppVersionInfo(value: unknown): value is AppVersionInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppVersionInfo>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.channel === 'string' &&
    typeof candidate.packaged === 'boolean' &&
    typeof candidate.platform === 'string' &&
    typeof candidate.arch === 'string'
  );
}

export async function fetchAppVersionInfo(): Promise<AppVersionInfo | null> {
  try {
    const resp = await fetch('/api/version');
    if (!resp.ok) return null;
    const json = (await resp.json()) as Partial<AppVersionResponse>;
    return isAppVersionInfo(json.version) ? json.version : null;
  } catch {
    return null;
  }
}

export type SkillExampleResult =
  | { html: string }
  // The skill declares a non-HTML preview surface (image / markdown / …)
  // and the daemon's `/example` endpoint only ships HTML, so calling it
  // would 404 into a misleading "failed to fetch" state. The modal
  // renders a calm "no shipped preview" affordance instead. The `kind`
  // is the raw `od.preview.type` from SKILL.md so future preview kinds
  // can be picked up by name without a registry change. Issue #897.
  | { unavailable: true; kind: string }
  | { error: string };

// Returns a discriminated result so callers can distinguish a real
// failure (network error, daemon unreachable, server error) from a
// normal load or a missing shipped preview. Previously this collapsed
// every failure into `null`, which left the example preview modal stuck
// at its loading state with no recovery affordance. Issue #860.
//
// `previewType` is the skill's `od.preview.type` (defaults to `'html'`
// daemon-side). Anything other than `'html'` short-circuits to an
// `unavailable` result so we don't fire a network call against a
// daemon endpoint that only resolves HTML files. Issue #897.
export async function fetchSkillExample(
  id: string,
  previewType: string = 'html',
): Promise<SkillExampleResult> {
  if (previewType !== 'html') {
    return { unavailable: true, kind: previewType };
  }
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}/example`);
    if (!resp.ok) {
      if (resp.status === 404) {
        return { unavailable: true, kind: 'html' };
      }
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

// Project files — all paths are scoped under .od/projects/<id>/ on disk.
//
// Several views ask for the same list during one render (project view, recent
// strip, design cards, file viewer). Share that request and retain the daemon's
// snapshot token so subsequent refreshes transfer only changed entries.
const PROJECT_FILES_BROWSER_CACHE_MAX_ENTRIES = 32;
const projectFilesBrowserCache = new Map<string, {
  files: ProjectFile[];
  snapshotAt?: number;
}>();
const projectFilesBrowserInFlight = new Map<string, Promise<ProjectFile[]>>();

export function resetProjectFilesBrowserCacheForTests(): void {
  projectFilesBrowserCache.clear();
  projectFilesBrowserInFlight.clear();
}

function projectFileCachePath(file: ProjectFile): string {
  return file.path || file.name;
}

function storeProjectFilesBrowserSnapshot(
  projectId: string,
  snapshot: { files: ProjectFile[]; snapshotAt?: number },
): void {
  // Insertion order provides a tiny LRU. Cover-card views may inspect many
  // projects; retaining every large file tree for the browser lifetime would
  // trade daemon pressure for an unbounded client memory leak.
  projectFilesBrowserCache.delete(projectId);
  projectFilesBrowserCache.set(projectId, snapshot);
  while (projectFilesBrowserCache.size > PROJECT_FILES_BROWSER_CACHE_MAX_ENTRIES) {
    const oldest = projectFilesBrowserCache.keys().next().value;
    if (oldest === undefined) break;
    projectFilesBrowserCache.delete(oldest);
  }
}

function mergeProjectFileDelta(
  current: ProjectFile[],
  changed: ProjectFile[],
  removed: string[],
): ProjectFile[] {
  if (changed.length === 0 && removed.length === 0) return current;
  const byPath = new Map(current.map((file) => [projectFileCachePath(file), file]));
  for (const relPath of removed) byPath.delete(relPath);
  for (const file of changed) byPath.set(projectFileCachePath(file), file);
  return [...byPath.values()].sort((a, b) => Number(b.mtime) - Number(a.mtime));
}

/** Bounded browsing is separate from the full-index API used for recovery. */
export async function fetchProjectFilesPage(projectId: string, cursor?: string): Promise<ProjectFilesPageResponse> {
  const query = new URLSearchParams({ limit: '1000' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files?${query}`);
  if (!response.ok) throw new Error(`Could not load project files (HTTP ${response.status}).`);
  const result = await response.json() as ProjectFilesPageResponse;
  // Old daemons ignore limit. Keep their full result honest, with no fake cursor.
  return { files: result.files, total: result.total ?? result.files.length,
    nextCursor: result.nextCursor ?? null, snapshotAt: result.snapshotAt };
}

export async function fetchProjectCoverFiles(projectId: string): Promise<ProjectFile[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files?limit=20&kind=image`);
  if (!response.ok) return [];
  const result = await response.json() as ProjectFilesPageResponse;
  return result.files;
}

/** Legacy stable cards need HTML previews as well as images, never the full
 * scientific file inventory. Keep an older index.html as the preferred cover. */
export async function fetchProjectPreviewFiles(projectId: string): Promise<ProjectFile[]> {
  const [images, html, index] = await Promise.all([
    fetchProjectCoverFiles(projectId),
    fetch(`/api/projects/${encodeURIComponent(projectId)}/files?limit=20&kind=html`)
      .then(async response => response.ok ? ((await response.json()) as ProjectFilesPageResponse).files : []),
    fetchProjectFileMetadata(projectId, 'index.html'),
  ]);
  return [...new Map([...images, ...html, ...(index ? [index] : [])]
    .map(file => [file.path || file.name, file])).values()];
}

export async function fetchProjectFileMetadata(projectId: string, name: string): Promise<ProjectFile | null> {
  const query = new URLSearchParams({ limit: '1', path: name });
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files?${query}`);
  if (!response.ok) throw new Error(`Could not load file metadata (HTTP ${response.status}).`);
  const result = await response.json() as ProjectFilesPageResponse;
  // Old daemons ignore the filter and return their full index.
  return result.files.find(file => (file.path || file.name) === name) ?? null;
}

export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const cached = projectFilesBrowserCache.get(projectId);
  const existing = projectFilesBrowserInFlight.get(projectId);
  if (existing) return existing;

  const request = (async () => {
    try {
      const since = Number(cached?.snapshotAt);
      const query = Number.isFinite(since) && since > 0 ? `?since=${encodeURIComponent(since)}` : '';
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files${query}`);
      if (!resp.ok) return cached?.files ?? [];
      const json = (await resp.json()) as {
        files?: ProjectFile[];
        removed?: string[];
        complete?: boolean;
        snapshotAt?: number;
      };
      const changed = Array.isArray(json.files) ? json.files : [];
      const files = json.complete === false && cached
        ? mergeProjectFileDelta(cached.files, changed, Array.isArray(json.removed) ? json.removed : [])
        : changed;
      const snapshotAt = Number(json.snapshotAt);
      storeProjectFilesBrowserSnapshot(projectId, {
        files,
        snapshotAt: Number.isFinite(snapshotAt) && snapshotAt > 0 ? snapshotAt : undefined,
      });
      return files;
    } catch {
      return cached?.files ?? [];
    }
  })();
  projectFilesBrowserInFlight.set(projectId, request);
  try {
    return await request;
  } finally {
    if (projectFilesBrowserInFlight.get(projectId) === request) {
      projectFilesBrowserInFlight.delete(projectId);
    }
  }
}

export async function fetchProjectFolders(projectId: string): Promise<ProjectFolder[]> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { folders?: ProjectFolder[] };
    return json.folders ?? [];
  } catch {
    return [];
  }
}

export async function createProjectFolder(
  projectId: string,
  name: string,
): Promise<ProjectFolder | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { folder?: ProjectFolder };
    return json.folder ?? null;
  } catch {
    return null;
  }
}

export async function deleteProjectFolder(
  projectId: string,
  folderPath: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function renameProjectFolder(
  projectId: string,
  from: string,
  to: string,
): Promise<ProjectFolder | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/folders/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      },
    );
    if (!resp.ok) {
      const err = (await resp.json().catch(() => null)) as { message?: string } | null;
      throw new Error(err?.message || `rename failed (${resp.status})`);
    }
    const json = (await resp.json()) as { folder?: ProjectFolder };
    return json.folder ?? null;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function readApiErrorBody(resp: Response): Promise<{ message: string; code?: string }> {
  try {
    const json = (await resp.json()) as { error?: { code?: string; message?: string } | string; message?: string };
    const message = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message;
    return {
      message: typeof message === 'string' && message.length > 0 ? message : `Request failed (${resp.status}).`,
      ...(typeof json.error === 'object' && typeof json.error?.code === 'string' ? { code: json.error.code } : {}),
    };
  } catch {
    return { message: `Request failed (${resp.status}).` };
  }
}

export function projectFileUrl(projectId: string, name: string): string {
  return projectRawUrl(projectId, name);
}

/** Download the original bytes without HTML preview transforms. */
export function projectDownloadUrl(projectId: string, name: string): string {
  return `${projectRawUrl(projectId, name)}?download=1`;
}

export interface ProjectFilePreviewSection {
  title: string;
  lines: string[];
}

export interface ProjectFilePreview {
  kind: 'pdf' | 'document' | 'presentation' | 'spreadsheet';
  title: string;
  sections: ProjectFilePreviewSection[];
}

export async function fetchProjectFilePreview(
  projectId: string,
  name: string,
): Promise<ProjectFilePreview | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(name)}/preview`,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFilePreview;
  } catch {
    return null;
  }
}

export async function fetchProjectFileText(
  projectId: string,
  name: string,
  options?: { cache?: RequestCache; cacheBustKey?: string | number },
): Promise<string | null> {
  const url = projectFileUrl(projectId, name);
  const cacheBustKey = options?.cacheBustKey;
  const requestUrl =
    cacheBustKey == null
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}cacheBust=${encodeURIComponent(String(cacheBustKey))}`;
  const init: RequestInit = {};
  if (options?.cache) init.cache = options.cache;

  try {
    const resp = await fetch(requestUrl, init);
    if (!resp.ok) {
      console.warn('[fetchProjectFileText] failed:', {
        name,
        projectId,
        status: resp.status,
        statusText: resp.statusText,
        url: requestUrl,
      });
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn('[fetchProjectFileText] failed:', {
      error: err,
      name,
      projectId,
      url: requestUrl,
    });
    return null;
  }
}

/** Content and its strong write revision must come from the same read. */
export async function fetchProjectFileSnapshot(projectId: string, name: string): Promise<{ text: string; etag: string }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(name)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`File unavailable (${response.status}): ${name}`);
  const etag = response.headers.get('X-MatOS-File-Revision');
  if (!etag) throw new Error(`File revision unavailable: ${name}`);
  return { text: await response.text(), etag };
}

function projectFileVersionsUrl(projectId: string, name: string): string {
  const safePath = name
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/files/${safePath}/versions`;
}

export async function fetchProjectFileVersions(
  projectId: string,
  name: string,
): Promise<ProjectFileVersionsResponse | null> {
  try {
    const resp = await fetch(projectFileVersionsUrl(projectId, name), { cache: 'no-store' });
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFileVersionsResponse;
  } catch {
    return null;
  }
}

export async function fetchProjectFileVersion(
  projectId: string,
  name: string,
  versionId: string,
): Promise<ProjectFileVersionResponse | null> {
  try {
    const resp = await fetch(
      `${projectFileVersionsUrl(projectId, name)}/${encodeURIComponent(versionId)}`,
      { cache: 'no-store' },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFileVersionResponse;
  } catch {
    return null;
  }
}

export async function restoreProjectFileVersion(
  projectId: string,
  name: string,
  version: Pick<ProjectFileVersion, 'id'>,
): Promise<RestoreProjectFileVersionResponse | null> {
  try {
    const resp = await fetch(
      `${projectFileVersionsUrl(projectId, name)}/${encodeURIComponent(version.id)}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as RestoreProjectFileVersionResponse;
  } catch {
    return null;
  }
}

export async function fetchPreviewComments(
  projectId: string,
  conversationId: string,
): Promise<PreviewComment[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments`,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { comments: PreviewComment[] };
    return json.comments ?? [];
  } catch {
    return [];
  }
}

export async function upsertPreviewComment(
  projectId: string,
  conversationId: string,
  input: PreviewCommentUpsertRequest,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

export async function patchPreviewCommentStatus(
  projectId: string,
  conversationId: string,
  commentId: string,
  status: PreviewCommentStatus,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

export async function deletePreviewComment(
  projectId: string,
  conversationId: string,
  commentId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function writeProjectTextFile(
  projectId: string,
  name: string,
  content: string,
  options?: {
    artifactManifest?: ArtifactManifest;
    versionSource?: ProjectFileVersionSource;
    versionLabel?: string;
    versionPrompt?: string | null;
    expectedEtag?: string | null;
  },
): Promise<ProjectFile | null> {
  const result = await writeProjectTextFileDetailed(projectId, name, content, options);
  return result.ok ? result.file : null;
}

export type WriteProjectTextFileResult =
  | { ok: true; file: ProjectFile }
  | { ok: false; status?: number; code?: string; message: string };

export async function writeProjectTextFileDetailed(
  projectId: string,
  name: string,
  content: string,
  options?: {
    artifactManifest?: ArtifactManifest;
    versionSource?: ProjectFileVersionSource;
    versionLabel?: string;
    versionPrompt?: string | null;
    expectedEtag?: string | null;
  },
): Promise<WriteProjectTextFileResult> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        content,
        artifactManifest: options?.artifactManifest,
        versionSource: options?.versionSource,
        versionLabel: options?.versionLabel,
        versionPrompt: options?.versionPrompt,
        expectedEtag: options?.expectedEtag,
      }),
    });
    if (!resp.ok) {
      const body = await readApiErrorBody(resp);
      return {
        ok: false,
        status: resp.status,
        code: body.code,
        message: body.message || resp.statusText || 'Save failed',
      };
    }
    const json = (await resp.json()) as { file: ProjectFile };
    return { ok: true, file: json.file };
  } catch {
    return { ok: false, message: 'Network error while saving the file' };
  }
}

export async function writeProjectBase64File(
  projectId: string,
  name: string,
  base64: string,
): Promise<ProjectFile | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content: base64, encoding: 'base64' }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { file: ProjectFile };
    return json.file;
  } catch {
    return null;
  }
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
  desiredName?: string,
): Promise<ProjectFile | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    if (desiredName) form.append('name', desiredName);
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { file: ProjectFile };
    return json.file;
  } catch {
    return null;
  }
}

// Multi-file project upload used by the chat composer's paste / drop /
// picker. Each file lands flat in the project folder; the response is
// reshaped into ChatAttachments so the composer can stage them without a
// follow-up listFiles round-trip.

export interface ProjectUploadFailure {
  name: string;
  code?: string;
  error?: string;
}

export interface UploadProjectFilesResult {
  uploaded: ChatAttachment[];
  failed: ProjectUploadFailure[];
  error?: string;
}

export async function uploadProjectFiles(
  projectId: string,
  files: File[],
  dir?: string,
): Promise<UploadProjectFilesResult> {
  if (files.length === 0) return { uploaded: [], failed: [] };

  const uploaded: ChatAttachment[] = [];
  const failed: ProjectUploadFailure[] = [];
  let error: string | undefined;
  const targetDir = dir?.trim() ?? '';

  for (const batch of projectUploadBatches(files)) {
    const form = new FormData();
    // The `dir` field MUST be appended before the file parts: the daemon's
    // multer destination resolver reads req.body.dir as each file streams in,
    // and busboy only exposes fields parsed earlier in the multipart body.
    if (targetDir) form.append('dir', targetDir);
    for (const f of batch) form.append('files', f);

    try {
      const resp = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/upload`,
        { method: 'POST', body: form },
      );

      if (!resp.ok) {
        const payload = (await resp.json().catch(() => null)) as
          | { code?: string; error?: string }
          | null;
        error = payload?.error ?? `upload failed (${resp.status})`;
        for (const f of batch) {
          failed.push({ name: f.name, code: payload?.code, error: error });
        }
        continue;
      }

      const json = (await resp.json()) as {
        files: { name: string; path: string; size?: number; originalName?: string }[];
      };
      const responseFiles = json.files ?? [];
      uploaded.push(
        ...responseFiles.map((f) => ({
          path: f.path,
          name: f.originalName ?? f.name,
          kind: looksLikeImage(f.name) ? ('image' as const) : ('file' as const),
          size: f.size,
        })),
      );
      // Server preserves request order; any dropped files are unmatched at the batch tail.
      if (responseFiles.length < batch.length) {
        error ??= 'some files could not be stored';
        for (const f of batch.slice(responseFiles.length)) {
          failed.push({
            name: f.name,
            error: error ?? 'some files could not be stored',
          });
        }
      }
    } catch {
      error = 'upload request failed';
      for (const f of batch) {
        failed.push({ name: f.name, error });
      }
    }
  }

  return { uploaded, failed, error };
}

// Stable URL that serves a project file with its original mime — for
// thumbnails in the staged-attachment chips and for any preview iframe
// that needs to point at the live file (not a srcDoc).
export function projectRawUrl(projectId: string, filePath: string): string {
  // Encode each path segment individually so a slash inside the file
  // path stays a path separator, not %2F.
  const safePath = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${safePath}`;
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}

export interface ProjectContentMatch {
  file: string;
  line: number;
  snippet: string;
}

/** Server-side content grep across the project's text files. */
export async function searchProjectContent(
  projectId: string,
  query: string,
  options?: { pattern?: string; max?: number },
): Promise<ProjectContentMatch[]> {
  const params = new URLSearchParams({ q: query });
  if (options?.pattern) params.set('pattern', options.pattern);
  if (options?.max) params.set('max', String(options.max));
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/search?${params.toString()}`,
      { cache: 'no-store' },
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { matches?: ProjectContentMatch[] };
    return json.matches ?? [];
  } catch {
    return [];
  }
}

export async function deleteProjectFile(
  projectId: string,
  name: string,
  expectedEtag?: string,
): Promise<boolean> {
  try {
    const url = `${projectRawUrl(projectId, name)}${
      expectedEtag ? `?expectedEtag=${encodeURIComponent(expectedEtag)}` : ''
    }`;
    const resp = await fetch(
      url,
      { method: 'DELETE' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function renameProjectFile(
  projectId: string,
  from: string,
  to: string,
  expectedEtag?: string,
): Promise<RenameProjectFileResponse> {
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, ...(expectedEtag ? { expectedEtag } : {}) }),
  });
  if (!resp.ok) {
    const errorBody = await readApiErrorBody(resp);
    throw new Error(errorBody.message);
  }
  return (await resp.json()) as RenameProjectFileResponse;
}

export async function openFolderDialog(options: { throwOnError?: boolean } = {}): Promise<string | null> {
  try {
    const resp = await fetch('/api/dialog/open-folder', { method: 'POST' });
    if (!resp.ok) {
      // Headless/gateway deployments cannot pop a native OS dialog (no
      // display on the daemon host, and the browser is remote). Fall back
      // to the MatOS server-side folder browser, which navigates the
      // user's jailed workspace roots instead.
      const { serverFolderBrowserAvailable, requestServerFolder } = await import(
        '../components/ServerFolderPicker'
      );
      if (await serverFolderBrowserAvailable()) {
        return await requestServerFolder();
      }
      if (options.throwOnError) {
        const errorBody = await readApiErrorBody(resp);
        throw new Error(errorBody.message);
      }
      return null;
    }
    const data = await resp.json();
    return typeof data.path === 'string' && data.path.length > 0 ? data.path : null;
  } catch (err) {
    if (options.throwOnError) {
      throw err instanceof Error ? err : new Error('Could not open folder picker');
    }
    return null;
  }
}

// Probe whether a local directory still exists on disk. Used by the composer
// to flag a working directory in red the moment its folder is deleted.
export async function dirExists(path: string): Promise<boolean> {
  try {
    const resp = await fetch('/api/dir-exists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!resp.ok) return true; // can't tell → don't false-flag
    const data = await resp.json();
    return data?.exists !== false;
  } catch {
    return true; // daemon unreachable → don't false-flag
  }
}

// Global most-recently-used working directories (the local folders the user
// grants the agent read-only awareness of). Persisted in the daemon's
// app-config so they survive browser resets and are shared across projects
// and the `od` CLI. Returns most-recent-first.
export async function fetchRecentLinkedDirs(): Promise<string[]> {
  try {
    // `/api/recent-dirs` returns the list pruned to folders that still exist
    // on disk (and persists the pruning), so deleted folders never linger.
    const resp = await fetch('/api/recent-dirs');
    if (!resp.ok) return [];
    const data = await resp.json();
    const list = data?.dirs;
    return Array.isArray(list) ? list.filter((d: unknown): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

// Record `dir` as the most-recently-used working directory and return the
// updated list. PUT /api/app-config merges per-key, so sending only
// `recentLinkedDirs` leaves every other preference untouched. The daemon
// also trims/de-dupes/caps the list, but we do it client-side too so the
// optimistic UI matches what gets persisted.
export async function pushRecentLinkedDir(dir: string): Promise<string[]> {
  const existing = await fetchRecentLinkedDirs();
  const next = [dir, ...existing.filter((d) => d !== dir)].slice(0, 5);
  try {
    await fetch('/api/app-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recentLinkedDirs: next }),
    });
  } catch {
    // Daemon offline — the picked dir still applies to this project; the
    // recents list just won't persist for next time.
  }
  return next;
}

// "Replace working directory" — points an existing project at a new
// folder. Mirrors the import-folder trust gate but updates the current
// project record instead of creating a new project.
export async function replaceProjectWorkingDir(
  projectId: string,
  baseDir: string,
  desktopImportToken?: string,
): Promise<ReplaceProjectWorkingDirResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (desktopImportToken) {
    headers['x-od-desktop-import-token'] = desktopImportToken;
  }
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/working-dir`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseDir }),
    },
  );
  if (!resp.ok) {
    const body = await readApiErrorBody(resp);
    throw new Error(body.message);
  }
  return (await resp.json()) as ReplaceProjectWorkingDirResponse;
}
