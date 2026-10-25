// Project / conversation / message / tab persistence — backed by the
// daemon's SQLite store. All writes round-trip through HTTP so projects
// stay coherent across multiple browser tabs and across restarts.
//
// These helpers fail soft (returning null / [] on transport errors) so
// the UI can stay rendered when the daemon is briefly unreachable.

import type {
  MessagesResponse,
  ChatSessionMode,
  CreateConversationRequest,
  DuplicateProjectResponse,
  CreateTerminalRequest,
  ImportFolderRequest,
  ImportFolderResponse,
  TerminalSession,
} from '@open-design/contracts';
import { randomUUID } from '../utils/uuid';
import { createSharedRequest } from '../utils/shared-request';
import type {
  ChatMessage,
  Conversation,
  OpenTabsState,
  Project,
  ProjectMetadata,
  ProjectTemplate,
} from '../types';


export async function listProjects(options?: { throwOnError?: boolean }): Promise<Project[]> {
  try {
    const resp = await fetch('/api/projects');
    if (!resp.ok) {
      if (options?.throwOnError) throw new Error(`projects ${resp.status}`);
      return [];
    }
    const json = (await resp.json()) as { projects: Project[] };
    return json.projects ?? [];
  } catch (err) {
    if (options?.throwOnError) throw err;
    return [];
  }
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project };
    return json.project;
  } catch {
    return null;
  }
}

export async function getProjectDetail(
  id: string,
  opts?: { ensureDir?: boolean },
): Promise<{ project: Project; resolvedDir: string | null } | null> {
  try {
    // `ensureDir` asks the daemon to materialize a managed project's folder
    // before resolving it, so referencing a brand-new (empty) project yields a
    // real on-disk directory instead of a path that fails existence checks.
    const query = opts?.ensureDir ? '?ensureDir=1' : '';
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}${query}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project; resolvedDir?: unknown };
    return {
      project: json.project,
      resolvedDir: typeof json.resolvedDir === 'string' ? json.resolvedDir : null,
    };
  } catch {
    return null;
  }
}

export async function createProject(input: {
  name: string;
  // MatOS new-project form passes an explicit slug id so the project's
  // folder under the chosen location gets a human-readable name. Every
  // other caller omits it and gets a random UUID.
  id?: string;
  projectLocationId?: string;
  skillId: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  conversationMode?: ChatSessionMode;
  allowInvalidLinkedDirs?: boolean;
}): Promise<{ project: Project; conversationId: string }> {
  try {
    // `randomUUID` falls back to `crypto.getRandomValues` / `Math.random`
    // when `crypto.randomUUID` is unavailable. MatOS served over
    // plain HTTP on a LAN IP (Docker / unRAID self-hosting) is a
    // non-secure context, where `crypto.randomUUID` is undefined and
    // calling it directly throws — the surrounding try/catch then turns
    // the Create button into a silent no-op (issue #849).
    const { id: explicitId, ...rest } = input;
    const id = explicitId && explicitId.trim() ? explicitId.trim() : randomUUID();
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        // Explicit MatOS slugs represent a folder name chosen in the project
        // form. Other callers let the daemon derive a Unicode-safe directory
        // from the visible project name while keeping the opaque id internal.
        ...(explicitId ? { folderName: explicitId } : {}),
        ...rest,
      }),
    });
    if (!resp.ok) {
      let message = 'Could not create project';
      try {
        const body = await resp.json() as { error?: unknown };
        if (
          body.error &&
          typeof body.error === 'object' &&
          'message' in body.error &&
          typeof body.error.message === 'string' &&
          body.error.message.trim()
        ) {
          message = body.error.message;
        }
      } catch {
        // Keep the generic fallback when the error body is absent or invalid.
      }
      throw new Error(message);
    }
    return (await resp.json()) as {
      project: Project;
      conversationId: string;
    };
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not create project');
  }
}

export async function duplicateProject(
  projectId: string,
  input: { name?: string } = {},
): Promise<DuplicateProjectResponse> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      let message = 'Could not duplicate project';
      try {
        const body = await resp.json() as { error?: unknown };
        if (
          body.error &&
          typeof body.error === 'object' &&
          'message' in body.error &&
          typeof body.error.message === 'string' &&
          body.error.message.trim()
        ) {
          message = body.error.message;
        } else if (typeof body.error === 'string' && body.error.trim()) {
          message = body.error;
        }
      } catch {
        // Keep the generic fallback when the error body is absent or invalid.
      }
      throw new Error(message);
    }
    return (await resp.json()) as DuplicateProjectResponse;
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not duplicate project');
  }
}

export async function pickLocalFolderPath(): Promise<string | null> {
  const resp = await fetch('/api/dialog/open-folder', {
    method: 'POST',
  });
  if (!resp.ok) {
    // Headless deployments have no native dialog; fall back to the server-side folder browser as openFolderDialog does.
    const { serverFolderBrowserAvailable, requestServerFolder } = await import('../components/ServerFolderPicker');
    if (await serverFolderBrowserAvailable()) return await requestServerFolder();
    let message = 'Could not open folder picker';
    try {
      const body = await resp.json() as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) {
        message = body.error;
      } else if (
        body.error
        && typeof body.error === 'object'
        && 'message' in body.error
        && typeof body.error.message === 'string'
        && body.error.message.trim()
      ) {
        message = body.error.message;
      }
    } catch { /* use default message */ }
    throw new Error(message);
  }

  const body = await resp.json() as { path?: unknown };
  if (body.path == null) return null;
  if (typeof body.path !== 'string') {
    throw new Error('Could not open folder picker');
  }
  return body.path.length > 0 ? body.path : null;
}

export async function importFolderProject(
  input: ImportFolderRequest,
): Promise<ImportFolderResponse> {
  const resp = await fetch('/api/import/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    let message = 'Failed to import folder';
    try {
      const body = await resp.json();
      if (body?.error?.message) message = body.error.message;
    } catch { /* use default message */ }
    throw new Error(message);
  }
  return (await resp.json()) as ImportFolderResponse;
}

// ---------- templates ----------

export async function listTemplates(): Promise<ProjectTemplate[]> {
  try {
    const resp = await fetch('/api/templates');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { templates: ProjectTemplate[] };
    return json.templates ?? [];
  } catch {
    return [];
  }
}

export async function getTemplate(id: string): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { template: ProjectTemplate };
    return json.template;
  } catch {
    return null;
  }
}

export async function saveTemplate(input: {
  name: string;
  description?: string;
  sourceProjectId: string;
}): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { template: ProjectTemplate };
    return json.template;
  } catch {
    return null;
  }
}

export async function deleteTemplate(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

type ProjectPatch = Omit<Partial<Project>, 'pendingPrompt' | 'customInstructions' | 'metadata'> & {
  metadata?: Partial<NonNullable<Project['metadata']>> | null;
  pendingPrompt?: Project['pendingPrompt'] | null;
  customInstructions?: string | null;
};

export async function patchProject(
  id: string,
  patch: ProjectPatch,
): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project };
    return json.project;
  } catch {
    return null;
  }
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- conversations ----------

async function conversationResponseError(
  resp: Response,
  fallback: string,
): Promise<Error> {
  let message = fallback;
  try {
    const payload = await resp.json() as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof payload.error === 'string' && payload.error.trim()) {
      message = payload.error.trim();
    } else if (
      payload.error &&
      typeof payload.error === 'object' &&
      'message' in payload.error &&
      typeof payload.error.message === 'string' &&
      payload.error.message.trim()
    ) {
      message = payload.error.message.trim();
    } else if (typeof payload.message === 'string' && payload.message.trim()) {
      message = payload.message.trim();
    }
  } catch {
    // Keep the status-bearing fallback when the daemon did not return JSON.
  }
  return new Error(message);
}

export async function listConversations(
  projectId: string,
  options?: { throwOnError?: boolean },
): Promise<Conversation[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
    );
    if (!resp.ok) {
      if (!options?.throwOnError) return [];
      throw await conversationResponseError(
        resp,
        `Could not load conversations (${resp.status})`,
      );
    }
    const json = (await resp.json()) as { conversations: Conversation[] };
    return json.conversations ?? [];
  } catch (error) {
    if (options?.throwOnError) throw error;
    return [];
  }
}

export async function createConversation(
  projectId: string,
  title?: string,
  // Side Chat: seed the new conversation with another conversation's context
  // by copying its messages. `forkAfterMessageId` narrows that copy to a
  // specific point in the source history.
  opts?: {
    seedFromConversationId?: string | null;
    forkAfterMessageId?: string | null;
    sessionMode?: ChatSessionMode;
    /** MatOS member DM: bind the new conversation to a role ref. */
    roleRef?: string | null;
    /** MatOS group chat: seed the conversation's member roster. */
    memberRefs?: string[];
    /** Preserve the daemon's validation error for user-initiated creation. */
    throwOnError?: boolean;
    // Fork snapshot: the exact in-memory messages to copy (up to the fork
    // point). Lets the daemon fork from what the user sees even when the fork
    // point was never persisted (e.g. a run that errored before its assistant
    // message reached the database).
    seedMessages?: ChatMessage[];
  },
): Promise<Conversation | null> {
  try {
    const body: CreateConversationRequest = { title };
    if (opts?.sessionMode) {
      body.sessionMode = opts.sessionMode;
    }
    if (opts?.roleRef) {
      body.roleRef = opts.roleRef;
    }
    if (opts?.memberRefs && opts.memberRefs.length > 0) {
      body.memberRefs = opts.memberRefs;
    }
    if (opts?.seedFromConversationId) {
      body.seedFromConversationId = opts.seedFromConversationId;
    }
    if (opts?.forkAfterMessageId) {
      body.forkAfterMessageId = opts.forkAfterMessageId;
    }
    if (opts?.seedMessages && opts.seedMessages.length > 0) {
      body.seedMessages = opts.seedMessages;
    }
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      if (!opts?.throwOnError) return null;
      throw await conversationResponseError(
        resp,
        `Could not create conversation (${resp.status})`,
      );
    }
    const json = (await resp.json()) as { conversation: Conversation };
    return json.conversation;
  } catch (error) {
    if (opts?.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error('Could not create conversation');
    }
    return null;
  }
}

export async function patchConversation(
  projectId: string,
  conversationId: string,
  patch: Partial<Conversation>,
): Promise<Conversation | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { conversation: Conversation };
    return json.conversation;
  } catch {
    return null;
  }
}

export async function deleteConversation(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- messages ----------

/** Initial/older history is bounded in SQLite; failures must not look empty. */
export async function listMessagesPage(projectId: string, conversationId: string, before?: string): Promise<MessagesResponse> {
  const query = new URLSearchParams({ view: 'chat', limit: '40' });
  if (before) query.set('before', before);
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages?${query}`);
  if (!response.ok) throw new Error(`Could not load conversation messages (HTTP ${response.status}).`);
  return response.json() as Promise<MessagesResponse>;
}

export async function listMessages(
  projectId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages?view=chat`,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { messages: ChatMessage[] };
    return json.messages ?? [];
  } catch {
    return [];
  }
}

export interface SaveMessageOptions {
  telemetryFinalized?: boolean;
  /** User turns must be acknowledged before their assistant run can start. */
  required?: boolean;
  // Set during page-unload paths (pagehide / visibilitychange→hidden) so
  // the in-flight PUT survives even if the document tears down before the
  // response arrives. Without keepalive the browser cancels the fetch
  // and the daemon never sees the final buffered text chunk.
  keepalive?: boolean;
}

// Recovery baselines can contain thousands of file records. Send them until
// the daemon acknowledges the first write, then rely on PATCH-like DB preserve
// semantics instead of retransmitting megabytes with every streamed update.
const acknowledgedRecoveryBaselines = new Set<string>();

function recoveryBaselineKey(
  projectId: string,
  conversationId: string,
  messageId: string,
): string {
  return `${projectId}\0${conversationId}\0${messageId}`;
}

async function messagePersistenceError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const payload = await response.json() as {
      error?: string | { message?: unknown };
    };
    detail = typeof payload.error === 'string'
      ? payload.error
      : typeof payload.error?.message === 'string'
        ? payload.error.message
        : '';
  } catch {
    detail = await response.text().catch(() => '');
  }
  return new Error(
    detail.trim() || `Could not save the conversation message (HTTP ${response.status}).`,
  );
}

export async function saveMessageRequired(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
  options: SaveMessageOptions = {},
): Promise<ChatMessage> {
  const baselineKey = recoveryBaselineKey(projectId, conversationId, message.id);
  const hasRecoveryBaseline = Boolean(
    message.preTurnFileNames?.length || message.preTurnFileSnapshot?.length,
  );
  const includeRecoveryBaseline =
    !options.telemetryFinalized &&
    hasRecoveryBaseline &&
    !acknowledgedRecoveryBaselines.has(baselineKey);
  const {
    preTurnFileNames: _preTurnFileNames,
    preTurnFileSnapshot: _preTurnFileSnapshot,
    ...messageWithoutRecoveryBaseline
  } = message;
  const messageBody = includeRecoveryBaseline ? message : messageWithoutRecoveryBaseline;
  const body = options.telemetryFinalized
    ? { ...messageBody, telemetryFinalized: true }
    : messageBody;
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.keepalive ? { keepalive: true } : {}),
    },
  );
  if (!response.ok) throw await messagePersistenceError(response);
  if (hasRecoveryBaseline) acknowledgedRecoveryBaselines.add(baselineKey);
  const payload = await response.json().catch(() => null) as { message?: ChatMessage } | null;
  if (!payload?.message || payload.message.id !== message.id) {
    throw new Error('The conversation service did not confirm the saved message.');
  }
  return payload.message;
}

export async function saveMessageRequiredWithRetry(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
  options: SaveMessageOptions = {},
  retryDelaysMs: readonly number[] = [0, 150, 500],
): Promise<ChatMessage> {
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await saveMessageRequired(projectId, conversationId, message, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not save the conversation message.');
}

export async function saveMessage(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
  options: SaveMessageOptions = {},
): Promise<void> {
  if (options.required) {
    await saveMessageRequiredWithRetry(projectId, conversationId, message, options);
    return;
  }
  try {
    await saveMessageRequired(projectId, conversationId, message, options);
  } catch {
    // Streaming deltas remain best-effort. New user turns use the required
    // retry path before a run starts, so refresh cannot silently drop them.
  }
}

// ---------- terminals ----------
//
// Interactive PTY sessions rooted at the project working directory. The daemon
// streams output down over SSE (`GET .../stream`) and accepts keystrokes /
// resizes back up over plain POST — see `packages/contracts/src/api/terminals.ts`.
// `<TerminalViewer>` drives `terminalStreamUrl` directly via EventSource; these
// helpers cover the request/response endpoints.

export async function createTerminal(
  projectId: string,
  init?: CreateTerminalRequest,
): Promise<TerminalSession | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(init ?? {}),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { terminal: TerminalSession };
    return json.terminal ?? null;
  } catch {
    return null;
  }
}

/** SSE endpoint a `<TerminalViewer>` subscribes to for raw PTY output. */
export function terminalStreamUrl(projectId: string, terminalId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/stream`;
}

export async function sendTerminalStdin(
  projectId: string,
  terminalId: string,
  data: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/stdin`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function resizeTerminal(
  projectId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/resize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function killTerminal(
  projectId: string,
  terminalId: string,
  // Page-unload paths set keepalive so the kill survives document teardown,
  // mirroring `saveMessage`. Without it the browser cancels the fetch and the
  // PTY leaks until the daemon GCs it.
  options: { keepalive?: boolean } = {},
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/kill`,
      {
        method: 'POST',
        ...(options.keepalive ? { keepalive: true } : {}),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- tabs ----------

const PROJECT_TABS_CACHE_PREFIX = 'open-design:project-tabs:v1:';

function tabsCacheKey(projectId: string): string {
  return `${PROJECT_TABS_CACHE_PREFIX}${projectId}`;
}

function normalizeTabsState(value: unknown): OpenTabsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs) || !record.tabs.every((tab) => typeof tab === 'string')) {
    return null;
  }
  const browserTabs = Array.isArray(record.browserTabs)
    ? record.browserTabs.filter(
        (tab) =>
          Boolean(tab) &&
          typeof tab === 'object' &&
          !Array.isArray(tab) &&
          typeof (tab as Record<string, unknown>).id === 'string' &&
          typeof (tab as Record<string, unknown>).label === 'string',
      ) as OpenTabsState['browserTabs']
    : undefined;
  const state: OpenTabsState = {
    tabs: record.tabs.slice() as string[],
    active: typeof record.active === 'string' ? record.active : null,
  };
  if (browserTabs && browserTabs.length > 0) state.browserTabs = browserTabs;
  if (record.hasSavedState === true) state.hasSavedState = true;
  if (typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)) {
    state.updatedAt = record.updatedAt;
  }
  return state;
}

function readCachedTabs(projectId: string): OpenTabsState | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeTabsState(JSON.parse(window.localStorage.getItem(tabsCacheKey(projectId)) ?? 'null'));
  } catch {
    return null;
  }
}

function writeCachedTabs(projectId: string, state: OpenTabsState): OpenTabsState {
  const next: OpenTabsState = {
    ...state,
    updatedAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(tabsCacheKey(projectId), JSON.stringify(next));
    } catch {
      // Ignore quota/private-mode failures. The daemon save below is canonical.
    }
  }
  return next;
}

function newestTabsState(
  first: OpenTabsState | null,
  second: OpenTabsState | null,
): OpenTabsState {
  if (!first && !second) return { tabs: [], active: null };
  if (!first) return second!;
  if (!second) return first;
  return (second.updatedAt ?? 0) > (first.updatedAt ?? 0) ? second : first;
}

async function persistTabsToDaemon(projectId: string, state: OpenTabsState): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(projectId)}/tabs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
    keepalive: true,
  });
}

export async function loadTabs(projectId: string): Promise<OpenTabsState> {
  const cached = readCachedTabs(projectId);
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/tabs`,
    );
    if (!resp.ok) return cached ?? { tabs: [], active: null };
    const saved = normalizeTabsState(await resp.json());
    const latest = newestTabsState(cached, saved);
    if (cached && latest === cached && (cached.updatedAt ?? 0) > (saved?.updatedAt ?? 0)) {
      void persistTabsToDaemon(projectId, cached).catch(() => {});
    }
    return latest;
  } catch {
    return cached ?? { tabs: [], active: null };
  }
}

export async function saveTabs(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  const next = writeCachedTabs(projectId, state);
  try {
    await persistTabsToDaemon(projectId, next);
  } catch {
    // best-effort
  }
}

/**
 * Write tab state to the local cache ONLY (synchronous localStorage), returning
 * the `updatedAt`-stamped state. Callers that debounce the canonical daemon
 * write use this so the cache is always current — `loadTabs` reconciles cache
 * vs daemon by `updatedAt`, so a debounced (or dropped) daemon PUT never loses
 * data: a newer cache is re-pushed on next load.
 */
export function cacheTabsLocally(projectId: string, state: OpenTabsState): OpenTabsState {
  return writeCachedTabs(projectId, state);
}

/** Persist already-stamped tab state to the daemon (the debounced write). */
export async function persistTabsToDaemonNow(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  try {
    await persistTabsToDaemon(projectId, state);
  } catch {
    // best-effort; the local cache (written via cacheTabsLocally) is canonical
    // and will re-push on the next loadTabs reconciliation.
  }
}
