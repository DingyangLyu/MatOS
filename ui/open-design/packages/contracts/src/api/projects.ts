import type { ChatMessage, ChatRunStatus, ChatSessionMode } from './chat.js';
import type { OrchestratorWorkspace } from './workspaces.js';
import type { ProjectContextMcpServerRef } from './context.js';

export type ProjectKind =
  | 'prototype'
  | 'deck'
  | 'template'
  | 'other'
  | 'image'
  | 'video'
  | 'audio';

export type ProjectPlatform =
  | 'auto'
  | 'responsive'
  | 'web-desktop'
  | 'mobile-ios'
  | 'mobile-android'
  | 'tablet'
  | 'desktop-app';

export type ProjectDisplayStatus =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface ProjectStatusInfo {
  value: ProjectDisplayStatus;
  updatedAt?: number;
  runId?: string;
}

export interface ProjectMetadata {
  kind: ProjectKind;
  // MatOS asset-editing projects: the "+" create menu spawns a project per
  // asset draft (agent chat on the left, the asset file as the editable
  // artifact on the right). This tag lets lists and reopen flows recognize
  // and label those projects; absent for ordinary design projects.
  matosAssetType?: 'knowledge' | 'skill' | 'tool' | 'role' | 'workflow' | 'data';
  // MatOS LaTeX paper projects (the Papers rail destination): agent chat on
  // the left, the .tex source as the editable artifact with a live-compiled
  // PDF preview on the right. Lets the Papers list and reopen flows recognize
  // paper projects without introducing a new ProjectKind.
  matosPaperProject?: boolean;
  // Overleaf-style "Main document": the project-relative .tex entry that
  // compiles regardless of which source file is open. Set by ZIP import
  // auto-detection or the editor's "set as main" action.
  latexRoot?: string;
  // Per-project TeX engine preference (defaults to xelatex when absent).
  latexEngine?: 'xelatex' | 'pdflatex' | 'lualatex';
  // Overleaf's "Compile mode": draft runs one validation-only engine pass
  // (fast, no PDF output); normal/absent produces the PDF.
  latexCompileMode?: 'normal' | 'draft';
  // Overleaf's "Stop on first error" toggle. Absent means true (halt), the
  // historical behavior; false pushes through errors to still emit a PDF.
  latexStopOnFirstError?: boolean;
  // MatOS project-as-department roster: the `role:<id>` refs the user has
  // invited into this project. The conversations sidebar lists these as
  // "members" (each opens a DM or joins a group chat) instead of the full
  // role catalog. Absent/empty means no one has been invited yet.
  members?: string[];
  // Project-local MatOS role preference. Home keeps a separate global
  // preference; switching roles inside one project must not change another
  // project's next run. Null clears a stale selection when the roster empties.
  matosActiveRoleRef?: string | null;
  // Project-local provider-LLM override (web `/model` picker). Travels to the
  // MatOS CLI as `--model <id>` on each run; null/absent keeps the deployment
  // default. Distinct from `matosActiveRoleRef`, which picks the role asset.
  matosProviderModel?: string | null;
  // Projection of native project.json selections. The CLI loads that authority
  // directly, resolves accepted identities through the user's scoped registry,
  // and composes temporary role mounts. Stores references, never paths.
  matosAssetRefs?: string[];
  /** Native project policy; absence is the legacy picker follow-accepted default. */
  matosAssetVersionPolicy?: 'follow-accepted' | 'pinned';
  // MatOS project charter: the overall mission the user typed at create
  // time. Injected into every agent run's system prompt for this project so
  // all member roles work toward the same goal.
  goal?: string;
  // Per-member responsibility notes keyed by `role:<id>` ref (the "who does
  // what" the user wrote in the MatOS new-project form). Injected alongside
  // `goal` and shown under each member in the conversations sidebar.
  memberBriefs?: Record<string, string>;
  // Per-member custom display names keyed by `role:<id>` ref. A project can
  // rename an invited role for this department (e.g. call `role:compute`
  // "算力老王"); the alias is what the sidebar, group @-bar, group-chat
  // roster header, and auto-relay handoff parsing all use. Absent entries
  // fall back to the catalog role name. One alias per role (refs are deduped
  // per project — naming is an alias, not a second instance of the role).
  memberNames?: Record<string, string>;
  // `document`: resume/report/PDF projects from the Home `document` card, so
  // the workspace can pick the matching document template instead of the
  // generic `other` layout.
  intent?: 'document';
  fidelity?: 'wireframe' | 'high-fidelity';
  speakerNotes?: boolean;
  slideCount?: string;
  animations?: boolean;
  includeLandingPage?: boolean;
  includeOsWidgets?: boolean;
  templateId?: string;
  templateLabel?: string;
  /** Primary target surface selected at project creation. */
  platform?: ProjectPlatform;
  // Tracks whether the visible name was typed by the user or generated by
  // the create flow. First-prompt auto-naming may only replace generated
  // names so named imports/templates stay stable across conversations.
  // `untitled` requests a server-reserved numbered name. It is stable until
  // the user renames it; neither prompt summaries nor agent titles replace it.
  nameSource?: 'generated' | 'prompt' | 'agent' | 'user' | 'untitled';
  /** Concrete delivery surfaces the artifact must account for. `responsive` is a web breakpoint target, not a native app expansion. */
  platformTargets?: ProjectPlatform[];
  importedFrom?: 'claude-design' | 'folder' | string;
  entryFile?: string;
  sourceFileName?: string;
  // Folder-import (#597): when set, the project's files live under this
  // absolute path instead of .od/projects/<id>/. OD reads and writes
  // directly inside the user's folder. Stored as the realpath() result so
  // symlinks can't redirect writes after import time.
  baseDir?: string;
  // Project library location that owns baseDir when the project was created
  // under a configured project location root.
  projectLocationId?: string;
  // PR #974: marker stamped by the daemon's HMAC-gated import handler
  // when a folder import passed the desktop-main-process trust gate.
  // Only set on folder-imported projects (`baseDir` set) and only when
  // the import request carried a valid `X-OD-Desktop-Import-Token`
  // signed with the secret the desktop main process registered with the
  // daemon at startup. The desktop `shell.openPath` IPC refuses to
  // forward folder-imported projects whose metadata lacks this marker,
  // so a renderer cannot launder an attacker-chosen baseDir into a
  // file-manager reveal even if a future codepath inadvertently lets
  // it set `baseDir` outside the trusted flow. Privileged: rejected
  // by `POST /api/projects` and `PATCH /api/projects/:id`.
  fromTrustedPicker?: true;
  // Externally prepared scratch workspace provenance. OD may read/write
  // metadata.baseDir, but source authority and writeback stay outside OD.
  orchestratorWorkspace?: OrchestratorWorkspace;
  // Hint stamped by the Home composer working-directory chip. It records
  // where the user wanted the project to live without granting write access
  // to that path; actual filesystem roots still use baseDir/import flows.
  userWorkingDir?: string;
  // Absolute paths to local code folders the agent can read via --add-dir.
  linkedDirs?: string[];
  // Batch/API-created projects can opt out of the initial discovery form so
  // the first agent turn builds immediately from the submitted brief.
  skipDiscoveryBrief?: boolean;
  // Set when the user submits an unmodified curated example prompt from the
  // gallery. Skips discovery AND requests full-quality direct generation,
  // treating the curated title/brief as the complete creative brief. Honored
  // by both the daemon and contracts (API/BYOK) system-prompt composers so the
  // feature is not mode-dependent.
  examplePrompt?: boolean;
  examplePromptTitle?: string;
  examplePromptBrief?: Record<string, string>;
  contextMcpServers?: ProjectContextMcpServerRef[];
  sourceProjectId?: string;
  sourceProjectName?: string;
}

export interface Project {
  id: string;
  name: string;
  skillId: string | null;
  createdAt: number;
  updatedAt: number;
  status?: ProjectStatusInfo;
  /** Read-only list projection. Never used as project/runtime authority. */
  overview?: {
    conversationCount: number;
    latestConversationTitle?: string;
    /** Server-resolved directory; not reconstructed from the display name. */
    projectDir: string;
  };
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  customInstructions?: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  sourceProjectId?: string;
  files: Array<{ name: string; content: string }>;
  description?: string;
  createdAt: number;
}

export interface ProjectBrowserWorkspaceTab {
  id: string;
  insertAfter?: string | null;
  label: string;
  title?: string;
  url?: string;
  iconUrl?: string;
}

export interface ProjectTabsState {
  tabs: string[];
  active: string | null;
  browserTabs?: ProjectBrowserWorkspaceTab[];
  hasSavedState?: boolean;
  updatedAt?: number;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  sessionMode?: ChatSessionMode;
  /**
   * MatOS role binding for member DMs (`role:<id>`). When set, every run in
   * this conversation executes with this role regardless of the global
   * agent-model pick; null/absent keeps the free-role "group chat" behavior.
   */
  roleRef?: string | null;
  /**
   * MatOS group chat roster (`role:<id>` refs). When present with more than
   * one member the conversation is a Feishu-style group: every invited member
   * can be @-addressed to answer a turn, and each run still executes through
   * the native `matos --role` CLI path for the addressed member. A one-member
   * group and a `roleRef` DM behave the same; `roleRef` stays the canonical
   * single-member binding.
   */
  memberRefs?: string[];
  /**
   * MatOS group chat auto-relay toggle. When false, a member's trailing
   * "@NAME: <task>" handoff lines are NOT dispatched automatically by the
   * daemon after that member's run settles. Absent/null means enabled (the
   * default). Persisted here (not client state) because relay continuation is
   * daemon-owned and must survive reloads and closed browser tabs.
   */
  groupAutoRelay?: boolean;
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
  totalDurationMs?: number;
  latestRun?: {
    status: ChatRunStatus;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
  };
}

export interface ProjectsResponse {
  projects: Project[];
}

export interface ProjectEditorWorkspaceResponse {
  /** Container/local daemon-visible .code-workspace file; project root is unchanged. */
  workspacePath: string;
}

export interface ProjectResponse {
  project: Project;
}

// Response body for `GET /api/projects/:id`. Carries the same `project`
// payload as `ProjectResponse` plus a derived `resolvedDir` so the web
// client can address the on-disk working directory directly (e.g. for
// `shell.openPath` from the desktop bridge). For folder-imported projects
// `resolvedDir === metadata.baseDir`; for native projects it is
// `path.join(<daemon projects root>, project.id)`. Computed server-side via
// `resolveProjectDir(...)` so the web client never reconstructs the path.
export interface ProjectDetailResponse extends ProjectResponse {
  resolvedDir: string;
}

export interface CreateProjectResponse extends ProjectResponse {
  conversationId?: string;
}

export interface DuplicateProjectResponse extends ProjectResponse {
  conversationId: string;
  copiedFiles: string[];
}

export interface ProjectLocation {
  id: string;
  name: string;
  path: string;
  builtIn?: boolean;
}

export interface ProjectLocationsResponse {
  locations: ProjectLocation[];
  removedProjectIds?: string[];
}

export interface UpdateProjectLocationsRequest {
  locations: Array<{ id?: string; name?: string; path: string }>;
}

export interface ProjectManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  skillId?: string | null;
}

export interface ScanProjectLocationsResponse {
  scanned: number;
  imported: Project[];
  existing: string[];
  skipped: Array<{ path: string; reason: string }>;
}

// POST /api/import/folder — create a project rooted at an existing local
// folder. The submitted baseDir is stored as the project's metadata.baseDir
// (after realpath canonicalization) and OD reads/writes directly inside it.
// The user owns version control; OD does not snapshot or copy.
export interface ImportFolderRequest {
  baseDir: string;
  name?: string;
  skillId?: string | null;
  orchestratorWorkspace?: OrchestratorWorkspace;
}

export interface ImportFolderResponse {
  project: Project;
  conversationId: string;
  entryFile: string | null;
}

export interface ReplaceProjectWorkingDirResponse {
  project: Project;
  baseDir: string;
  entryFile: string | null;
}

export interface CreateConversationRequest {
  title?: string | null;
  sessionMode?: ChatSessionMode;
  /** MatOS member DM: bind the new conversation to a `role:<id>` ref. */
  roleRef?: string | null;
  /** MatOS group chat: seed the conversation with a roster of `role:<id>`
   *  members that can each be @-addressed. */
  memberRefs?: string[];
  /**
   * Seed the new conversation with another conversation's context by copying
   * its messages. The source must belong to the same project; a missing or
   * foreign id is ignored and an empty conversation is created. Powers the
   * "Side Chat" launcher, which forks the current chat's context into a new
   * conversation.
   */
  seedFromConversationId?: string | null;
  /**
   * When paired with `seedFromConversationId`, copy only source messages up to
   * and including this message. Used by the chat "Fork" action so the new
   * conversation resumes from a specific assistant turn instead of inheriting
   * future follow-ups from the source conversation.
   */
  forkAfterMessageId?: string | null;
  /**
   * Client-supplied snapshot of the messages to seed the fork with, in order,
   * up to and including the fork point. When present, the daemon copies these
   * instead of reading the source conversation from the database by id. This
   * makes "Fork" resilient to a fork point that was never persisted — e.g. an
   * assistant turn whose run errored or had its connection reset before the
   * message reached the database. Without it, such a fork would 404 on
   * `forkAfterMessageId` and silently fail. When absent, the daemon falls back
   * to copying from `seedFromConversationId` (the original Side Chat path).
   */
  seedMessages?: ChatMessage[];
}

export interface MessagesResponse {
  messages: ChatMessage[];
  /** Present for a bounded chat-history request. Null means no older rows. */
  nextBefore?: string | null;
}
