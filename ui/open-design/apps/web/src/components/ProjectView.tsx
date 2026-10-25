import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AnimatePresence } from 'motion/react';
import { createHtmlArtifactManifest, inferLegacyManifest } from '../artifacts/manifest';
import { resolveHtmlPointerArtifactTarget } from '../artifacts/pointer';
import { validateHtmlArtifact } from '../artifacts/validate';
import { recoverHtmlDocumentFromMarkdownFence, recoverStandaloneHtmlDocument, resolvePersistedArtifactHtml } from '../artifacts/recover';
import { createArtifactParser } from '../artifacts/parser';
import {
  findFirstQuestionForm,
  hasUnterminatedQuestionForm,
  parsePartialQuestionForm,
  type QuestionForm,
} from '../artifacts/question-form';
import { parseSubmittedAnswers } from './QuestionForm';
import { useI18n } from '../i18n';
import {
  fetchChatRunStatus,
  GENERIC_DAEMON_DISCONNECT_CODE,
  GENERIC_DAEMON_DISCONNECT_MESSAGE,
  listActiveChatRuns,
  listProjectRuns,
  parseUserGroupMentions,
  reattachDaemonRun,
  streamViaDaemon,
} from '../providers/daemon';
import {
  deletePreviewComment,
  fetchPreviewComments,
  fetchProjectFiles,
  fetchProjectFileText,
  patchPreviewCommentStatus,
  projectRawUrl,
  uploadProjectFiles,
  upsertPreviewComment,
  writeProjectTextFile,
} from '../providers/registry';
import { useProjectFileEvents, type ProjectEvent } from '../providers/project-events';
import { useCoalescedCallback } from '../hooks/useCoalescedCallback';
import { navigate } from '../router';
import { useProjectFilePages } from '../runtime/use-project-file-pages';
import { readOverlappingMessagePages } from '../runtime/message-page-refresh';
import { agentModelDisplayName } from '../utils/agentLabels';
import {
  canAutoRenameProjectFromPrompt,
  summarizeProjectNameFromPrompt,
} from '../utils/projectName';
import { playSound, showCompletionNotification } from '../utils/notifications';
import { randomUUID } from '../utils/uuid';
import {
  canonicalRosterRef,
  findByRoleRef,
  projectRoleRefsFromMetadata,
  projectRunnableRoleRefs,
  resolveProjectRoleSelection,
  roleRefIdentity,
  roleRefRecordValue,
  sameRoleRef,
} from '../utils/roleRefs';
import { DEFAULT_NOTIFICATIONS } from '../state/config';
import type { TodoItem } from '../runtime/todos';
import { appendErrorStatusEvent, removeErrorStatusEvent } from '../runtime/chat-events';
import { RESUME_CONTINUE_PROMPT } from '../runtime/resume';
import {
  createConversation,
  deleteConversation as deleteConversationApi,
  listConversations,
  listMessagesPage,
  listMessages,
  loadTabs,
  patchConversation,
  patchProject,
  saveMessage,
  cacheTabsLocally,
  persistTabsToDaemonNow,
  type SaveMessageOptions,
} from '../state/projects';
import type {
  ChatSessionMode,
  RunContextSelection,
  WorkspaceContextItem,
} from '@open-design/contracts';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  Artifact,
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
  ChatMessageFeedbackChange,
  Conversation,
  OpenTabsState,
  Project,
  ProjectMetadata,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentTarget,
  ProjectFile,
  SkillSummary,
} from '../types';
import {
  commentsToAttachments,
  historyWithCommentAttachmentContext,
  mergeAttachedComments,
  mergePreviewCommentAttachments,
  queuedSlideNavTarget,
  removeAttachedComment,
} from '../comments';
import { filterImplicitProducedFiles } from '../produced-files';
import { AvatarMenu } from './AvatarMenu';
import { EntrySettingsMenu } from './EntrySettingsMenu';
import { MatOSRolePicker } from './MatOSRolePicker';
import { MatOSModelPicker } from './MatOSModelPicker';
import { ChatPane } from './ChatPane';
import type { PlanCanvasDoc } from './PlanCanvasPanel';
import {
  ProjectConversationsSidebar,
  resolveProjectMembers,
  useMemberRoles,
} from './ProjectConversationsSidebar';
import { MemberInviteDialog } from './MemberInviteDialog';
import { ProjectAssetPickerDialog } from './ProjectAssetPickerDialog';
import type { QuestionFormOpenRequest } from './AssistantMessage';
import type { ChatSendMeta } from './ChatComposer';
import {
  EvolutionJuryMount,
  useEvolutionJuryEnabled,
} from './EvolutionJury';
import { useIframeKeepAlivePool } from './IframeKeepAlivePool';
import {
  decideAutoOpenAfterWrite,
  selectAutoOpenProducedArtifact,
} from './auto-open-file';
import { collectReferencedJsxNames } from '../runtime/jsx-module-refs';
import { DESIGN_FILES_TAB, FileWorkspace } from './FileWorkspace';
import { CenteredLoader } from './Loading';
import type { SettingsSection } from './SettingsDialog';
import { Toast } from './Toast';
import { useProjectDetail } from '../hooks/useProjectDetail';
import { effectiveAgentModelChoice } from './agentModelSelection';

type WorkspaceProjectKind =
  | 'prototype'
  | 'wireframe'
  | 'mobile'
  | 'slide_deck'
  | 'template'
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'other';

function workspaceProjectKind(
  metadata: ProjectMetadata | null | undefined,
): WorkspaceProjectKind {
  const mobile = (target: string | null | undefined): boolean =>
    target === 'mobile-ios' || target === 'mobile-android';
  const isMobile =
    mobile(metadata?.platform) ||
    (metadata?.platformTargets ?? []).some(mobile);
  switch (metadata?.kind) {
    case 'prototype':
      if (metadata.fidelity === 'wireframe') return 'wireframe';
      if (isMobile) return 'mobile';
      return 'prototype';
    case 'deck':
      return 'slide_deck';
    case 'other':
      return metadata.intent === 'document' ? 'document' : 'other';
    case 'template':
    case 'image':
    case 'video':
    case 'audio':
      return metadata.kind;
    default:
      return 'other';
  }
}

type ProjectChatSendMeta = ChatSendMeta & {
  queueOnly?: boolean;
  retryOfAssistantId?: string;
  sessionMode?: ChatSessionMode;
};

export function mergeSavedPreviewComment(current: PreviewComment[], saved: PreviewComment): PreviewComment[] {
  const existingIndex = current.findIndex((comment) => comment.id === saved.id);
  if (existingIndex < 0) return [...current, saved];
  return current.map((comment, index) => (index === existingIndex ? saved : comment));
}

function mergeServerMessageWithLocal(server: ChatMessage, local?: ChatMessage): ChatMessage {
  if (!local) return server;
  const merged: ChatMessage = { ...server };
  if (local.role === 'assistant' && server.role === 'assistant') {
    if ((local.content?.length ?? 0) > (server.content?.length ?? 0)) {
      merged.content = local.content;
    }
    if ((local.events?.length ?? 0) > (server.events?.length ?? 0)) {
      merged.events = local.events;
    }
  }
  if (!server.producedFiles?.length && local.producedFiles?.length) {
    merged.producedFiles = local.producedFiles;
  }
  if (!server.preTurnFileNames?.length && local.preTurnFileNames?.length) {
    merged.preTurnFileNames = local.preTurnFileNames;
  }
  if (!server.preTurnFileSnapshot?.length && local.preTurnFileSnapshot?.length) {
    merged.preTurnFileSnapshot = local.preTurnFileSnapshot;
  }
  if (!server.lastRunEventId && local.lastRunEventId) {
    merged.lastRunEventId = local.lastRunEventId;
  }
  if (!server.startedAt && local.startedAt) {
    merged.startedAt = local.startedAt;
  }
  if (!server.endedAt && local.endedAt) {
    merged.endedAt = local.endedAt;
  }
  if (!server.runStatus && local.runStatus) {
    merged.runStatus = local.runStatus;
  }
  return merged;
}

export function mergeServerMessagesIntoConversation(
  current: ChatMessage[],
  serverMessages: ChatMessage[],
  partial = false,
): ChatMessage[] {
  const currentById = new Map(current.map((message) => [message.id, message]));
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const overlap = partial ? current.findIndex(message => serverIds.has(message.id)) : -1;
  const older = overlap > 0 ? current.slice(0, overlap).filter(message => !serverIds.has(message.id)) : [];
  const olderIds = new Set(older.map(message => message.id));
  // The daemon owns durable order. Keep richer in-flight fields for matching
  // rows, but use the server sequence as the skeleton so a repaired ledger
  // immediately corrects an already-open tab. Local-only rows are the small
  // pre-persistence window (user + assistant placeholder) and remain appended
  // in their current causal order. A recent-page response is not the whole
  // ledger: preserve already loaded history BEFORE its overlapping rows.
  const merged = [...older, ...serverMessages.map((message) =>
    mergeServerMessageWithLocal(message, currentById.get(message.id)),
  )];
  for (const message of current) {
    if (!serverIds.has(message.id) && !olderIds.has(message.id)) merged.push(message);
  }
  return merged;
}

function ensureConversationPresent(
  conversations: Conversation[],
  conversationId: string,
  projectId: string,
): Conversation[] {
  if (conversations.some((conversation) => conversation.id === conversationId)) {
    return conversations;
  }
  const now = Date.now();
  return [
    {
      id: conversationId,
      projectId,
      title: null,
      createdAt: now,
      updatedAt: now,
    },
    ...conversations,
  ];
}

interface Props {
  project: Project;
  routeFileName: string | null;
  /**
   * Routed conversation id. When set (the URL is
   * `/projects/:id/conversations/:cid[/...]`), the project view picks
   * this conversation as active instead of defaulting to `list[0]`.
   * Falls through to the default picker if the conversation does not
   * exist (e.g. the run was deleted between the route landing and the
   * conversation list loading). Issue #1505. Optional so existing
   * test harnesses that mount ProjectView with a stub props bag do
   * not have to be updated; production callers in `App.tsx` always
   * pass the value from `useRoute()`.
   */
  routeConversationId?: string | null;
  config: AppConfig;
  agents: AgentInfo[];
  // Mentionable functional skills — already filtered by config.disabledSkills
  // upstream, so this drives only the chat composer's @-picker scope. For
  // resolving an existing project's `skillId` (which can also point at a
  // design template after the skills/design-templates split), use
  // `designTemplates` as a fallback in the skill-name / skill-mode lookups
  // below.
  skills: SkillSummary[];
  // All known design templates (unfiltered). Required so projects created
  // from the Templates surface keep composing the template body in API
  // mode even when the user later disables the template in Settings.
  designTemplates: SkillSummary[];
  daemonLive: boolean;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onRefreshAgents: () => void;
  onThemeChange?: (theme: AppConfig['theme']) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenMcpSettings?: () => void;
  onBack: () => void;
  onClearPendingPrompt: () => void;
  onTouchProject: () => void;
  onProjectChange: (next: Project) => void;
  onProjectsRefresh: () => void;
  onDuplicateProject?: (
    sourceProjectId: string,
    input?: { name?: string },
  ) => Promise<void> | void;
}

interface QueuedChatSend {
  id: string;
  conversationId: string;
  prompt: string;
  attachments: ChatAttachment[];
  commentAttachments: ChatCommentAttachment[];
  meta?: ProjectChatSendMeta;
  createdAt: number;
}

interface QueuedChatSendUpdate {
  prompt: string;
  attachments: ChatAttachment[];
  commentAttachments: ChatCommentAttachment[];
  meta?: ChatSendMeta;
}

const CHAT_PANEL_WIDTH_STORAGE_KEY = 'open-design.project.chatPanelWidth';
const DEFAULT_CHAT_PANEL_WIDTH = 460;
const MIN_CHAT_PANEL_WIDTH = 345;
const MAX_CHAT_PANEL_WIDTH = 720;
const COMMENT_INSPECTOR_PANEL_WIDTH = 320;
const MIN_WORKSPACE_PANEL_WIDTH = 400;
const SPLIT_RESIZE_HANDLE_WIDTH = 8;
const CHAT_PANEL_KEYBOARD_STEP = 16;
// Trailing-debounce window for the canonical (daemon + SQLite) tab-state write.
// Embedded-browser navigation bursts settle well within this; the local cache
// is written immediately so nothing is lost if the daemon write is coalesced.
const TAB_PERSIST_DEBOUNCE_MS = 400;
// The generic browser-side SSE reconnect-budget exhaustion message emitted by
// consumeDaemonRun when the daemon status fetch still shows the run as
// queued/running (providers/daemon.ts).  Both the live-stream onError and the
// reattach-stream onError share this message; neither constitutes an
// authoritative terminal failure.  Use isGenericDaemonDisconnect() at both
// sites so generic disconnects stay eligible for attachRecoverableRuns to
// re-query daemon authoritative status on the next tick.
function isGenericDaemonDisconnect(err: unknown): boolean {
  return err instanceof Error && (
    (err as Error & { code?: string }).code === GENERIC_DAEMON_DISCONNECT_CODE ||
    err.message === GENERIC_DAEMON_DISCONNECT_MESSAGE
  );
}

// A persisted status/error event represents a generic daemon disconnect when
// either its structured `code` matches GENERIC_DAEMON_DISCONNECT_CODE, OR
// (legacy rows persisted before this code was introduced) its `detail`
// equals the canonical GENERIC_DAEMON_DISCONNECT_MESSAGE with no code set.
// Mirrors isGenericDaemonDisconnect() above, which checks the equivalent
// code-or-message pair on live Error objects for the same reason.
function hasGenericDisconnectFailureEvent(message: ChatMessage): boolean {
  return (message.events ?? []).some(
    (event) =>
      event.kind === 'status' &&
      event.label === 'error' &&
      (event.code === GENERIC_DAEMON_DISCONNECT_CODE ||
        event.detail === GENERIC_DAEMON_DISCONNECT_MESSAGE),
  );
}
const MIN_NORMAL_SPLIT_WIDTH =
  MIN_CHAT_PANEL_WIDTH + SPLIT_RESIZE_HANDLE_WIDTH + MIN_WORKSPACE_PANEL_WIDTH;
function workspacePanelMinWidthForSplit(splitWidth: number): number {
  if (!Number.isFinite(splitWidth) || splitWidth <= 0) return MIN_WORKSPACE_PANEL_WIDTH;
  return splitWidth < MIN_NORMAL_SPLIT_WIDTH ? 0 : MIN_WORKSPACE_PANEL_WIDTH;
}

function maxChatPanelWidthForSplit(splitWidth: number): number {
  if (!Number.isFinite(splitWidth) || splitWidth <= 0) return MAX_CHAT_PANEL_WIDTH;
  const workspaceMinWidth = workspacePanelMinWidthForSplit(splitWidth);
  const viewportAwareMax = splitWidth - SPLIT_RESIZE_HANDLE_WIDTH - workspaceMinWidth;
  return Math.max(0, Math.min(MAX_CHAT_PANEL_WIDTH, Math.floor(viewportAwareMax)));
}

function clampPreferredChatPanelWidth(width: number): number {
  return Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, Math.round(width)));
}

function clampChatPanelWidth(width: number, maxWidth = MAX_CHAT_PANEL_WIDTH): number {
  const effectiveMax = Math.max(0, Math.min(MAX_CHAT_PANEL_WIDTH, Math.floor(maxWidth)));
  const effectiveMin = Math.min(MIN_CHAT_PANEL_WIDTH, effectiveMax);
  return Math.min(effectiveMax, Math.max(effectiveMin, Math.round(width)));
}

function chatAttachmentsFromPreviewCommentImages(
  images: PreviewCommentAttachment[] | undefined,
): ChatAttachment[] {
  if (!Array.isArray(images)) return [];
  const seen = new Set<string>();
  const out: ChatAttachment[] = [];
  for (const image of images) {
    const path = image.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      name: image.name.trim() || path.split('/').pop() || path,
      kind: 'image',
    });
  }
  return out;
}

function mergeChatAttachments(...groups: ChatAttachment[][]): ChatAttachment[] {
  const seen = new Set<string>();
  const out: ChatAttachment[] = [];
  for (const group of groups) {
    for (const attachment of group) {
      const path = attachment.path.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ ...attachment, path });
    }
  }
  return out;
}

function historyWithWorkspaceContext(
  history: ChatMessage[],
  messageId: string,
  context: ChatSendMeta['context'] | undefined,
): ChatMessage[] {
  const items = context?.workspaceItems ?? [];
  if (items.length === 0) return history;
  const block = [
    '',
    '',
    '<active-workspace-context>',
    'MatOS selected or inferred these workspace contexts for this turn. Treat absolute paths as reference context unless the user explicitly asks to edit them.',
    ...items.map((item, index) => {
      const details = [
        item.path ? `path: ${item.path}` : null,
        item.absolutePath ? `absolute: ${item.absolutePath}` : null,
        item.url ? `url: ${item.url}` : null,
        item.title ? `title: ${item.title}` : null,
        item.tabId ? `tab: ${item.tabId}` : null,
      ].filter(Boolean).join(' | ');
      return `${index + 1}. ${item.kind}: ${item.label}${details ? ` | ${details}` : ''}`;
    }),
    '</active-workspace-context>',
  ].join('\n');
  return history.map((message) =>
    message.id === messageId && message.role === 'user'
      ? { ...message, content: `${message.content}${block}` }
      : message,
  );
}

function commentTaskQuery(attachment: ChatCommentAttachment): string {
  return (attachment.comment ?? '').trim();
}

function commentTaskContextAttachment(attachment: ChatCommentAttachment): ChatCommentAttachment {
  return {
    ...attachment,
    comment: '',
    commentContext: 'query',
  };
}

function readSavedChatPanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_CHAT_PANEL_WIDTH;
  try {
    const raw = window.localStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed)
      ? clampPreferredChatPanelWidth(parsed)
      : DEFAULT_CHAT_PANEL_WIDTH;
  } catch {
    return DEFAULT_CHAT_PANEL_WIDTH;
  }
}

function saveChatPanelWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CHAT_PANEL_WIDTH_STORAGE_KEY,
      String(clampPreferredChatPanelWidth(width)),
    );
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

function autoSendFirstMessageKey(projectId: string): string {
  return `od:auto-send-first:${projectId}`;
}

function autoSendAttachmentsKey(projectId: string): string {
  return `od:auto-send-attachments:${projectId}`;
}

function autoSendContextKey(projectId: string): string {
  return `od:auto-send-context:${projectId}`;
}

function readAutoSendAttachments(projectId: string): ChatAttachment[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(autoSendAttachmentsKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredChatAttachment);
  } catch {
    return [];
  }
}

function readAutoSendContext(projectId: string): RunContextSelection | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(autoSendContextKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isStoredRunContextSelection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clearAutoSendSession(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(autoSendFirstMessageKey(projectId));
    window.sessionStorage.removeItem(autoSendAttachmentsKey(projectId));
    window.sessionStorage.removeItem(autoSendContextKey(projectId));
  } catch {
    /* ignore */
  }
}

function isStoredChatAttachment(value: unknown): value is ChatAttachment {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === 'string' &&
    record.path.length > 0 &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    (record.kind === 'image' || record.kind === 'file') &&
    (record.size === undefined || typeof record.size === 'number') &&
    (record.order === undefined || typeof record.order === 'number')
  );
}

function isStoredStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStoredWorkspaceContextItem(value: unknown): value is WorkspaceContextItem {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.kind === 'string' &&
    record.kind.length > 0 &&
    typeof record.label === 'string' &&
    record.label.length > 0 &&
    (record.tabId === undefined || typeof record.tabId === 'string') &&
    (record.path === undefined || typeof record.path === 'string') &&
    (record.absolutePath === undefined || typeof record.absolutePath === 'string') &&
    (record.url === undefined || typeof record.url === 'string') &&
    (record.title === undefined || typeof record.title === 'string')
  );
}

function isStoredRunContextSelection(value: unknown): value is RunContextSelection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.skillIds === undefined || isStoredStringArray(record.skillIds)) &&
    (record.mcpServerIds === undefined || isStoredStringArray(record.mcpServerIds)) &&
    (
      record.workspaceItems === undefined ||
      (Array.isArray(record.workspaceItems) &&
        record.workspaceItems.every(isStoredWorkspaceContextItem))
    )
  );
}

function workspaceContextItemEqual(
  a: WorkspaceContextItem | null,
  b: WorkspaceContextItem | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    (a.tabId ?? '') === (b.tabId ?? '') &&
    (a.path ?? '') === (b.path ?? '') &&
    (a.absolutePath ?? '') === (b.absolutePath ?? '') &&
    (a.url ?? '') === (b.url ?? '') &&
    (a.title ?? '') === (b.title ?? '')
  );
}

function workspaceContextItemsEqual(
  a: WorkspaceContextItem[],
  b: WorkspaceContextItem[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => workspaceContextItemEqual(item, b[index] ?? null));
}

export function projectSplitClassName(workspaceFocused: boolean): string {
  return workspaceFocused ? 'split split-focus' : 'split';
}

// React key for the on-screen question form. Deliberately does NOT include the
// form's parsed `id`: there is at most one (first) form per assistant message,
// so `${conversation}:${message}` is already a stable, unique identity for the
// occurrence. Folding the parsed id in would remount the panel mid-stream — the
// preview shows the `discovery` fallback until the body `id` streams in, and a
// form that emits answerable questions before its `id` would flip identity
// while the user is mid-answer, dropping their selections. A distinct later
// form lives in a different assistant message, so it still gets its own key
// (and replays the reveal) without relying on the id.
export function buildQuestionFormKey(
  conversationId: string | null,
  assistantMessageId: string | null,
  hasForm: boolean,
): string | null {
  return conversationId && assistantMessageId && hasForm
    ? `${conversationId}:${assistantMessageId}`
    : null;
}

type ProjectSplitStyle = CSSProperties & {
  '--project-chat-panel-width': string;
  '--project-workspace-panel-track': string;
};

export function projectSplitStyle(
  workspaceFocused: boolean,
  chatPanelWidth: number,
  workspacePanelTrack: string,
): ProjectSplitStyle | undefined {
  if (workspaceFocused) return undefined;
  return {
    '--project-chat-panel-width': `${chatPanelWidth}px`,
    '--project-workspace-panel-track': workspacePanelTrack,
    gridTemplateColumns: `${chatPanelWidth}px ${SPLIT_RESIZE_HANDLE_WIDTH}px ${workspacePanelTrack}`,
  };
}

export type GroupDispatchProbe = 'active' | 'idle' | 'failed';

export function nextGroupDispatchPollStep(input: {
  attempt: number;
  idleProbes: number;
  probe: GroupDispatchProbe;
}): { kind: 'settle' } | { kind: 'reschedule'; refresh: boolean; idleProbes: number } {
  const { attempt, idleProbes, probe } = input;
  if (attempt >= 900) return { kind: 'settle' };
  if (probe === 'active') return { kind: 'reschedule', refresh: true, idleProbes: 0 };
  if (probe === 'failed') return { kind: 'reschedule', refresh: false, idleProbes };
  if (idleProbes < 5) return { kind: 'reschedule', refresh: false, idleProbes: idleProbes + 1 };
  return { kind: 'settle' };
}

function applySplitChatPanelWidth(
  split: HTMLDivElement | null,
  width: number,
  workspacePanelTrack: string,
): void {
  if (!split) return;
  split.style.setProperty('--project-chat-panel-width', `${width}px`);
  split.style.gridTemplateColumns =
    `${width}px ${SPLIT_RESIZE_HANDLE_WIDTH}px ${workspacePanelTrack}`;
}

function artifactWithHtml(
  artifact: Artifact | null,
  fallbackIdentifier: string,
  html: string,
): Artifact {
  return artifact
    ? { ...artifact, html }
    : {
        identifier: fallbackIdentifier,
        title: '',
        html,
      };
}

export function ProjectView({
  project,
  routeFileName,
  routeConversationId = null,
  config,
  agents,
  skills,
  designTemplates,
  daemonLive,
  onAgentChange,
  onAgentModelChange,
  onRefreshAgents,
  onThemeChange,
  onOpenSettings,
  onOpenMcpSettings,
  onBack,
  onClearPendingPrompt,
  onTouchProject,
  onProjectChange,
  onProjectsRefresh,
  onDuplicateProject,
}: Props) {
  const { locale, t } = useI18n();
  const iframeKeepAlivePool = useIframeKeepAlivePool();
  const handleThemeChange = onThemeChange ?? (() => {});
  const projectDetail = useProjectDetail(project.id);
  const detailedProject = projectDetail.project?.id === project.id ? projectDetail.project : null;
  const currentProject =
    detailedProject && detailedProject.updatedAt >= project.updatedAt ? detailedProject : project;
  // P0 page_view page_name=chat_panel — fire once per project mount.
  // ProjectView outlives conversation switches (ChatPane is keyed by
  // activeConversationId so it remounts when the user switches chats,
  // but this component does not), so page_view stays a "chat-panel
  // entry" metric instead of becoming a "conversation switch" count.
  // Reviewer #2285 (mrcfps, 2026-05-20 04:08) flagged the previous
  // ChatComposer-level emit for skewing the funnel.
  const mountedRef = useRef(true);
  const trackedTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of trackedTimeoutsRef.current) clearTimeout(timer);
      trackedTimeoutsRef.current.clear();
    };
  }, []);

  const scheduleProjectTimeout = useCallback((callback: () => void, delayMs: number) => {
    if (!mountedRef.current) return null;
    const timer = setTimeout(() => {
      trackedTimeoutsRef.current.delete(timer);
      if (!mountedRef.current) return;
      callback();
    }, delayMs);
    trackedTimeoutsRef.current.add(timer);
    return timer;
  }, []);

  const clearProjectTimeout = useCallback((timer: ReturnType<typeof setTimeout> | null) => {
    if (timer == null) return;
    clearTimeout(timer);
    trackedTimeoutsRef.current.delete(timer);
  }, []);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );
  const activeSessionMode = activeConversation?.sessionMode ?? 'design';
  const [messagesConversationId, setMessagesConversationId] = useState<string | null>(null);
  const [failedMessagesConversationId, setFailedMessagesConversationId] = useState<string | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState<string | null>(null);
  const [conversationBootstrapRetryNonce, setConversationBootstrapRetryNonce] = useState(0);
  const conversationBootstrapRetriesRef = useRef<Map<string, number>>(new Map());
  const [messageLoadRetryNonce, setMessageLoadRetryNonce] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [olderMessageCursor, setOlderMessageCursor] = useState<string | null>(null);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const olderMessagesRequestRef = useRef<symbol | null>(null);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  // Ephemeral, live-only accumulation of a tool call's streaming JSON input,
  // keyed by tool-use id (globally unique per run). Fed by `onToolInputDelta`
  // while the model is still emitting `input_json_delta`; dropped per-id once
  // the full `tool_use` lands and wiped when the run ends. Never persisted —
  // see daemon `daemonAgentPayloadToPersistedAgentEvent` (returns null).
  // `seq` records how many persisted events existed when the tool started
  // streaming, so the renderer can place the live card at the tool call's
  // position in the message (text before it = preamble, after it = hedging).
  const [liveToolInput, setLiveToolInput] = useState<Record<string, { name: string; text: string; seq: number }>>({});
  // True once the initial DB read for the active conversation has settled.
  // Auto-send gates on this so it can't fire before listMessages resolves and
  // race-clobber the freshly-pushed user + assistant placeholder. Without
  // this, the auto-send writes [user, assistant] into state, then the still
  // in-flight listMessages PUT response arrives, runs setMessages(list), and
  // wipes both — leaving the daemon's run with no client-side message to
  // attach the runId to.
  const [messagesInitialized, setMessagesInitialized] = useState(false);
  const [previewComments, setPreviewComments] = useState<PreviewComment[]>([]);
  // Mirror so the send-now interrupt path can read the current statuses
  // synchronously without re-creating its callback on every comment change.
  const previewCommentsRef = useRef<PreviewComment[]>([]);
  useEffect(() => {
    previewCommentsRef.current = previewComments;
  }, [previewComments]);
  const [attachedComments, setAttachedComments] = useState<PreviewComment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingConversationId, setStreamingConversationId] = useState<string | null>(null);
  // Safety net: drop any live tool-input partials whose tool never produced a
  // full `tool_use` (run errored/canceled mid-call) once streaming settles.
  useEffect(() => {
    if (!streaming) setLiveToolInput((prev) => (Object.keys(prev).length ? {} : prev));
  }, [streaming]);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [filesRefresh, setFilesRefresh] = useState(0);
  // True while a working-dir replace is reindexing the new folder. Surfaced
  // to the Design Files panel so the file list shows a loading state instead
  // of silently sitting on the old tree for the few seconds the scan takes.
  const { files: projectFiles, refresh: refreshFilePage, paging: filePaging } = useProjectFilePages(project.id);
  const projectFilesRef = useRef<ProjectFile[]>([]);
  // Landing default is the classic chat+workspace split: the most recent (or
  // freshly seeded) conversation opens on the left with the file workspace
  // alongside, so the project never renders as a mostly-blank canvas that only
  // "expands" after picking a conversation. The sidebar's pinned Files entry
  // (and the maximize toggle) still switch to the full-width file manager.
  const [workspaceFocused, setWorkspaceFocused] = useState(false);
  const [commentInspectorActive, setCommentInspectorActive] = useState(false);
  const commentInspectorPortalId = useId();
  const leftInspectorActive = commentInspectorActive;
  const [projectActionsToast, setProjectActionsToast] = useState<{
    message: string;
    details: string | null;
    code?: string | null;
    tone?: 'default' | 'success' | 'error' | 'loading';
    ttlMs?: number;
  } | null>(null);
  const [chatPanelWidth, setChatPanelWidth] = useState(readSavedChatPanelWidth);
  const [chatPanelMaxWidth, setChatPanelMaxWidth] = useState(MAX_CHAT_PANEL_WIDTH);
  const [workspacePanelMinWidth, setWorkspacePanelMinWidth] = useState(MIN_WORKSPACE_PANEL_WIDTH);
  const [resizingChatPanel, setResizingChatPanel] = useState(false);
  const splitRef = useRef<HTMLDivElement | null>(null);
  // Phone pager (<=640px): the split becomes a horizontal snap pager and
  // gains a leading "project hub" page (conversations / members / assets) —
  // the phone-reachable home of group chats, member DMs, and invites, since
  // the desktop sidebar is display:none at that width. Chat stays the landing
  // page; the hub is one swipe right, the canvas one swipe left.
  const [isPhonePager, setIsPhonePager] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 640px)');
    const sync = () => setIsPhonePager(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const splitChatSlotRef = useRef<HTMLDivElement | null>(null);
  // Land on (or return to) the chat page of the phone pager. Smooth for
  // user-triggered hops (picking a conversation on the hub page), instant
  // for the initial mount positioning.
  const swipeToChatPage = useCallback((smooth: boolean) => {
    splitChatSlotRef.current?.scrollIntoView({
      ...(smooth ? { behavior: 'smooth' as const } : {}),
      inline: 'start',
      block: 'nearest',
    });
  }, []);
  // Which pager page is in view (0 hub | 1 chat | 2 canvas), for the phone
  // page-position dots (styles/mobile2/project-pager.css). Without them the
  // hub/canvas pages are undiscoverable — nothing on the chat page says the
  // project is horizontally swipeable. Math.abs() keeps the index correct
  // under RTL, where Blink reports negative scrollLeft.
  const [pagerPage, setPagerPage] = useState(1);
  useEffect(() => {
    if (!isPhonePager || workspaceFocused) return;
    const split = splitRef.current;
    if (!split) return;
    let frame: number | null = null;
    const sync = () => {
      frame = null;
      const width = split.clientWidth;
      if (width <= 0) return;
      const next = Math.min(2, Math.max(0, Math.round(Math.abs(split.scrollLeft) / width)));
      setPagerPage((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (frame == null) frame = requestAnimationFrame(sync);
    };
    sync();
    split.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      split.removeEventListener('scroll', onScroll);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [isPhonePager, workspaceFocused]);
  useLayoutEffect(() => {
    if (!isPhonePager || workspaceFocused) return;
    swipeToChatPage(false);
    // Only when the pager appears (mount / crossing the breakpoint / leaving
    // focus mode): conversation switches must not yank an intentional swipe.
    // Layout effect so inserting the hub page (position 0) and landing on the
    // chat page happen before the same paint — no hub flash.
  }, [isPhonePager, workspaceFocused, swipeToChatPage]);
  const chatPanelWidthRef = useRef(chatPanelWidth);
  const preferredChatPanelWidthRef = useRef(chatPanelWidth);
  const resizeStartPreferredWidthRef = useRef(chatPanelWidth);
  const chatPanelMaxWidthRef = useRef(chatPanelMaxWidth);
  const resizeStateRef = useRef<{
    startClientX: number;
    startWidth: number;
    isRtl: boolean;
    hasMoved: boolean;
  } | null>(null);
  const pointerCleanupRef = useRef<(() => void) | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerClientXRef = useRef<number | null>(null);
  // The persisted set of open tabs + active tab. Persisted via PUT on every
  // change; loaded once when the project mounts.
  const [openTabsState, setOpenTabsState] = useState<OpenTabsState>({
    tabs: [],
    active: null,
  });
  const routeFileNameRef = useRef(routeFileName);
  routeFileNameRef.current = routeFileName;
  const [activeWorkspaceContext, setActiveWorkspaceContext] =
    useState<WorkspaceContextItem | null>(null);
  const [workspaceContexts, setWorkspaceContexts] = useState<WorkspaceContextItem[]>([]);
  const tabsLoadedRef = useRef(false);
  const tabsHydratedFromSavedStateRef = useRef(false);
  const [tabsHydrationVersion, setTabsHydrationVersion] = useState(0);
  const hasAppliedInitialPrimaryOpenRef = useRef(false);
  // Routed to FileWorkspace — bumped whenever the user clicks "open" on a
  // tool card, an attachment chip, or a produced-file chip in chat. We
  // include a nonce so re-clicking the same name after the user closed the
  // tab still focuses it.
  const [openRequest, setOpenRequest] = useState<{ name: string; nonce: number } | null>(null);
  // Like `openRequest`, but additionally asks the preview workspace to open the
  // file's Download/Export menu.
  const [downloadRequest, setDownloadRequest] = useState<{ name: string; nonce: number } | null>(null);
  // When a queued chat send starts processing, ask the workspace to flip the
  // deck preview to the slide its marked element lives on, so the user watches
  // the edit land in context instead of staying parked on slide 1.
  const [slideNavRequest, setSlideNavRequest] = useState<
    { name: string; slideIndex: number; nonce: number } | null
  >(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  // Runs explicitly superseded by a "send now" interrupt. Their abort
  // controller is recorded here synchronously — before handleStop() clears the
  // active refs — so the run's late terminal callbacks (which the daemon still
  // delivers for a canceled run) can be recognized as stale and skip every
  // current-run side effect, independent of abortRef churn. A WeakSet so a
  // finished run's controller is collected once nothing else references it.
  const supersededRunsRef = useRef<WeakSet<AbortController>>(new WeakSet());
  const streamingConversationIdRef = useRef<string | null>(null);
  const [queuedChatSends, setQueuedChatSends] = useState<QueuedChatSend[]>([]);
  const queuedChatSendsRef = useRef<QueuedChatSend[]>([]);
  const sendTextBufferRef = useRef<BufferedTextUpdates | null>(null);
  const reattachTextBuffersRef = useRef<Set<BufferedTextUpdates>>(new Set());
  const reattachControllersRef = useRef<Map<string, AbortController>>(new Map());
  const reattachCancelControllersRef = useRef<Map<string, AbortController>>(new Map());
  const completedReattachRunsRef = useRef<Set<string>>(new Set());
  // Tracks transient null-status retry attempts per runId; bounded by
  // MAX_TRANSIENT_RETRIES so we never spin indefinitely on a persistently
  // missing run.
  const transientFailedRetriesRef = useRef<Map<string, number>>(new Map());
  // Tracks generic-disconnect retry attempts per runId independently of the
  // null-status path so the two transient error classes don't share one budget
  // and cause premature sealing when both fire on the same run.
  const genericDisconnectRetriesRef = useRef<Map<string, number>>(new Map());
  // Cooldown window for active generic-disconnect retries after the transient
  // budget is exhausted, so a flapping SSE endpoint does not trigger an
  // immediate reattach loop while the daemon still reports the run as active.
  const genericDisconnectBackoffUntilRef = useRef<Map<string, number>>(new Map());
  // Timer handles for pending transient-retry callbacks; cleared on cleanup.
  const transientRetryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [recoveryTick, setRecoveryTick] = useState(0);
  const recoveredArtifactMessagesRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessage[]>([]);
  const startingQueuedChatSendIdRef = useRef<string | null>(null);
  // Queued sends whose handleSend dispatch is currently in flight. A queued
  // row only leaves the strip once its dispatch resolves, so during that
  // async window the same item is still clickable (send-now) and still
  // discoverable by the auto-start effect — and `startingQueuedChatSendIdRef`
  // alone can't guard it because the busy flip clears that ref mid-dispatch.
  // Both dispatch paths must check this set before starting an item, or the
  // user message is sent twice.
  const inFlightQueuedSendIdsRef = useRef<Set<string>>(new Set());
  const [queuedAutoStartTick, setQueuedAutoStartTick] = useState(0);
  // We auto-save the most recent artifact to the project folder. Track the
  // last name we persisted so re-renders during streaming don't spawn
  // duplicate writes.
  const savedArtifactRef = useRef<string | null>(null);
  // Track which conversation the current messages belong to, so we can
  // correctly gate new-conversation creation even during async loads.
  const messagesConversationIdRef = useRef<string | null>(null);
  const creatingConversationRef = useRef(false);
  // Last conversation id this view pushed into the URL. Lets the
  // route -> active-conversation sync tell a genuine external navigation
  // apart from the URL merely lagging a local conversation switch.
  const lastSyncedConversationIdRef = useRef<string | null>(null);
  // Live mirror of the currently-viewed project id. Used to bail out of
  // the conversation-created async refresh (#1361) if the user switches
  // projects while the refetch is in flight — the existing project-load
  // effects use the same kind of cancellation guard.
  const projectIdRef = useRef(project.id);
  useEffect(() => {
    projectIdRef.current = project.id;
  }, [project.id]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    const restored = loadQueuedChatSends(project.id);
    queuedChatSendsRef.current = restored;
    setQueuedChatSends(restored);
  }, [project.id]);
  // Monotonic token bumped on every `conversation-created` refresh dispatch.
  // Two rapid events (e.g. concurrent routine runs against the same reused
  // project, #1502) can start overlapping `listConversations` calls; if the
  // later request resolves first with N+1 conversations and the earlier
  // request resolves afterwards with only N, an unconditional
  // `setConversations(list)` would drop the newest conversation. Each
  // dispatch captures the token at start; only the dispatch whose token
  // still equals `conversationsRefreshTokenRef.current` at await-return is
  // allowed to apply its result.
  const conversationsRefreshTokenRef = useRef(0);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const currentConversationHasActiveRun = useMemo(
    () => messages.some((m) => m.role === 'assistant' && isActiveRunStatus(m.runStatus)),
    [messages],
  );
  const currentConversationHasRecoverableArtifact = useMemo(
    () => messages.some((message) => hasRecoverableArtifactMessage(message)),
    [messages],
  );
  const currentConversationLoading = Boolean(
    activeConversationId
      && messagesConversationId !== activeConversationId
      && failedMessagesConversationId !== activeConversationId,
  );
  const currentConversationStreaming = streaming && streamingConversationId === activeConversationId;
  const currentConversationControlStreaming = currentConversationStreaming;
  const currentConversationBusy = currentConversationLoading
    || currentConversationStreaming
    || currentConversationHasActiveRun;
  const currentConversationAwaitingActiveRunAttach =
    currentConversationHasActiveRun
    && !currentConversationStreaming;
  const currentConversationSendDisabled = currentConversationLoading
    || failedMessagesConversationId === activeConversationId
    || currentConversationAwaitingActiveRunAttach;
  const currentConversationActionDisabled = currentConversationBusy || currentConversationSendDisabled;
  const currentConversationQueueDisabled = currentConversationLoading
    || failedMessagesConversationId === activeConversationId;

  // The discovery question form lives in the right-hand Questions tab. We
  // derive it from the latest assistant message: if that message embeds a
  // <question-form> block, the panel renders it. The form is interactive
  // only while it's the most recent turn and the user hasn't answered yet
  // (an answer arrives as a following "[form answers …]" user message).
  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') return i;
    }
    return -1;
  }, [messages]);
  const lastAssistantContent =
    lastAssistantIndex >= 0 ? messages[lastAssistantIndex]?.content ?? '' : '';
  const lastAssistantMessageId =
    lastAssistantIndex >= 0 ? messages[lastAssistantIndex]?.id ?? null : null;
  const questionForm: QuestionForm | null = useMemo(
    () => findFirstQuestionForm(lastAssistantContent)?.form ?? null,
    [lastAssistantContent],
  );
  const questionFormSubmittedAnswers = useMemo(() => {
    if (!questionForm) return undefined;
    for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m?.role !== 'user') continue;
      const parsed = parseSubmittedAnswers(questionForm, m.content ?? '');
      if (parsed) return parsed;
    }
    return undefined;
  }, [questionForm, lastAssistantIndex, messages]);
  const questionsGenerating =
    currentConversationStreaming && hasUnterminatedQuestionForm(lastAssistantContent);
  // While the form is still streaming, parse it tolerantly so the Questions tab
  // can show a frame (title) immediately and fill questions in as they arrive.
  const questionFormPreview = useMemo(
    () => (questionsGenerating ? parsePartialQuestionForm(lastAssistantContent) : null),
    [questionsGenerating, lastAssistantContent],
  );
  // The active (latest, unanswered) form stays editable the whole time it's on
  // screen — while it streams in AND while the turn is still busy — so it never
  // flickers between the locked (grey) and interactive (accent) styles.
  // Submission is gated separately by the panel via `submitDisabled`/generating.
  const questionFormActive =
    (!!questionForm || questionsGenerating) && questionFormSubmittedAnswers === undefined;
  // Mirror `questionFormActive`'s unanswered gate: once the user answers, the
  // Questions tab closes, so the auto-focus nonce must not treat an answered
  // form as a freshly appeared one.
  const hasQuestions =
    Boolean(questionForm || questionsGenerating) && questionFormSubmittedAnswers === undefined;
  // Stable identity for the current form occurrence, used to remember that its
  // one-by-one reveal already played. Keyed on the conversation + the hosting
  // assistant message id (not the message index, and NOT the parsed form id —
  // see buildQuestionFormKey). The assistant message id is allocated once and
  // kept in place across the streaming→persisted swap (same `assistantId`
  // throughout), so it survives the brief unmount/re-focus of the Questions tab
  // without replaying the animation, yet differs for every distinct form
  // occurrence (each lives in its own assistant message).
  const questionFormKey = useMemo(
    () =>
      buildQuestionFormKey(
        activeConversationId,
        lastAssistantMessageId,
        Boolean(questionForm ?? questionFormPreview),
      ),
    [activeConversationId, lastAssistantMessageId, questionForm, questionFormPreview],
  );

  // Release #3661: let a past question form be manually re-opened in the
  // Questions panel. Layered on top of main's stable questionFormKey (#3644) —
  // the `displayed*` values fall back to the live form when nothing is manually
  // pinned, so both fixes coexist.
  const [manualQuestionFormRequest, setManualQuestionFormRequest] =
    useState<QuestionFormOpenRequest | null>(null);
  useEffect(() => {
    setManualQuestionFormRequest(null);
  }, [project.id, activeConversationId]);
  useEffect(() => {
    if (hasQuestions && questionFormKey) setManualQuestionFormRequest(null);
  }, [hasQuestions, questionFormKey]);
  const displayedQuestionForm = manualQuestionFormRequest?.form ?? questionForm;
  const displayedQuestionFormPreview = manualQuestionFormRequest ? null : questionFormPreview;
  const displayedQuestionFormSubmittedAnswers =
    manualQuestionFormRequest?.submittedAnswers ?? questionFormSubmittedAnswers;
  const displayedQuestionFormActive = manualQuestionFormRequest ? false : questionFormActive;
  const displayedQuestionsGenerating = manualQuestionFormRequest ? false : questionsGenerating;
  const displayedQuestionFormKey = manualQuestionFormRequest
    ? `${activeConversationId ?? 'conversation'}:${manualQuestionFormRequest.messageId}:${manualQuestionFormRequest.form.id}:manual`
    : questionFormKey;

  // Auto-switch the workspace to the Questions tab when a new discovery form
  // first appears, and let the chat banner re-focus it on click. The nonce
  // bump is what FileWorkspace listens to.
  const [questionsFocusNonce, setQuestionsFocusNonce] = useState(0);
  const prevHasQuestionsRef = useRef(false);
  useEffect(() => {
    if (hasQuestions && !prevHasQuestionsRef.current) {
      setQuestionsFocusNonce((n) => n + 1);
    }
    prevHasQuestionsRef.current = hasQuestions;
  }, [hasQuestions]);
  const focusQuestionsRequest = useMemo(
    () => (questionsFocusNonce > 0 ? { nonce: questionsFocusNonce } : null),
    [questionsFocusNonce],
  );
  // ---- MatOS plan canvas (right-hand workspace Plan tab) ----
  // The active conversation's latest answer, when that turn ran in plan mode
  // (`/plan` or the 规划 tier), projected as a reviewable document. Latest-
  // answer-only on purpose: the canvas mirrors "the plan currently under
  // review", not a plan archive — older plans stay readable in the chat log.
  const planCanvasDoc = useMemo<PlanCanvasDoc | null>(() => {
    if (config.agentId !== 'matos') return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== 'assistant') continue;
      let isPlanTurn = message.sessionMode === 'plan';
      if (!isPlanTurn && message.sessionMode == null) {
        // Older assistant rows predate the sessionMode stamp; fall back to
        // the turn's user message, which has carried it for longer.
        for (let j = i - 1; j >= 0; j--) {
          const prev = messages[j]!;
          if (prev.role !== 'user') continue;
          isPlanTurn = prev.sessionMode === 'plan';
          break;
        }
      }
      if (!isPlanTurn) return null;
      const markdown = planMarkdownOfMessage(message);
      const streaming = message.runStatus === 'running' || message.runStatus === 'queued';
      if (!markdown.trim() && !streaming) return null;
      return {
        markdown,
        status: streaming ? 'streaming' : 'ready',
        messageId: message.id,
      };
    }
    return null;
  }, [messages, config.agentId]);
  // Auto-focus the Plan tab once per plan answer (keyed by the assistant
  // message id, so streaming updates don't re-yank the tab).
  const [planFocusNonce, setPlanFocusNonce] = useState(0);
  const lastPlanFocusMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = planCanvasDoc?.messageId ?? null;
    if (!id || lastPlanFocusMessageIdRef.current === id) return;
    lastPlanFocusMessageIdRef.current = id;
    setPlanFocusNonce((n) => n + 1);
  }, [planCanvasDoc?.messageId]);
  const focusPlanRequest = useMemo(
    () => (planFocusNonce > 0 ? { nonce: planFocusNonce } : null),
    [planFocusNonce],
  );

  const submittedAnswersForQuestionFormRequest = useCallback((request: QuestionFormOpenRequest) => {
    const assistantIndex = messages.findIndex((m) => m.id === request.messageId);
    if (assistantIndex < 0) return null;
    for (let i = assistantIndex + 1; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'assistant') break;
      if (m.role !== 'user') continue;
      const parsed = parseSubmittedAnswers(request.form, m.content ?? '');
      if (parsed) return parsed;
    }
    return null;
  }, [messages]);
  const openQuestionsTab = useCallback((request?: QuestionFormOpenRequest) => {
    if (request) {
      const opensCurrentLiveForm =
        request.messageId === lastAssistantMessageId
        && questionForm?.id === request.form.id
        && questionFormSubmittedAnswers === undefined;
      if (opensCurrentLiveForm) {
        setManualQuestionFormRequest(null);
      } else {
        setManualQuestionFormRequest({
          ...request,
          submittedAnswers:
            request.submittedAnswers ?? submittedAnswersForQuestionFormRequest(request) ?? undefined,
        });
      }
    }
    setQuestionsFocusNonce((n) => n + 1);
  }, [
    lastAssistantMessageId,
    questionForm,
    questionFormSubmittedAnswers,
    submittedAnswersForQuestionFormRequest,
  ]);

  const currentConversationQueuedItems = activeConversationId
    ? queuedChatSends
        .filter((item) => item.conversationId === activeConversationId)
        .map((item) => {
          const queuedItem = {
            id: item.id,
            prompt: item.prompt,
            attachments: item.attachments,
            commentAttachments: item.commentAttachments,
          };
          if (item.meta === undefined) return queuedItem;
          return { ...queuedItem, meta: item.meta };
        })
    : [];
  const newConversationDisabled = creatingConversation;
  const activeCompletionNotificationRunsRef = useRef<Set<string>>(new Set());
  const completedNotificationRunsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // A new project gets its own bounded recovery budget. Retrying the same
    // project increments the nonce only, so this reset does not turn a
    // persistent failure into an unbounded polling loop.
    conversationBootstrapRetriesRef.current.delete(project.id);
  }, [project.id]);

  // Load conversations on project switch. If none exist (older projects
  // pre-conversations, or a freshly created one whose default seed got
  // dropped), create one on the fly.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setConversations([]);
    setActiveConversationId(null);
    setMessagesConversationId(null);
    setFailedMessagesConversationId(null);
    setMessageLoadRetryNonce(0);
    setConversationLoadError(null);
    setMessages([]);
    setPreviewComments([]);
    setAttachedComments([]);
    setStreaming(false);
    streamingConversationIdRef.current = null;
    setStreamingConversationId(null);
    setError(null);
    setArtifact(null);
    savedArtifactRef.current = null;
    (async () => {
      try {
        // A failed list request is not an empty project. Preserve the daemon's
        // error and retry the bootstrap instead of attempting a blind create
        // against the same restarting service.
        const list = await listConversations(project.id, { throwOnError: true });
        if (cancelled) return;
        if (list.length === 0) {
          const fresh = await createConversation(project.id, undefined, {
            throwOnError: true,
          });
          if (cancelled) return;
          if (fresh) {
            setConversations([fresh]);
            setActiveConversationId(fresh.id);
          } else {
            throw new Error('Could not create a conversation for this project.');
          }
        } else {
          setConversations(list);
          // Issue #1505: when the URL deep-links to a specific
          // conversation, prefer that one. Falls through to list[0]
          // when the routed id is null or no longer present (the
          // routine row may have been deleted between the route
          // landing and the conversation list loading).
          const routedMatch = routeConversationId
            ? list.find((c) => c.id === routeConversationId) ?? null
            : null;
          setActiveConversationId(routedMatch ? routedMatch.id : list[0]!.id);
        }
        conversationBootstrapRetriesRef.current.delete(project.id);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not load conversations for this project.';
        setConversations([]);
        setActiveConversationId(null);
        setConversationLoadError(message);
        setError(message);
        // Deploy/restart windows are normally short. Re-listing first makes
        // retries safe even if the previous create committed but its response
        // was lost: the persisted conversation is discovered before another
        // create is attempted.
        const retryDelaysMs = [300, 1_000, 2_500, 5_000];
        const retryIndex = conversationBootstrapRetriesRef.current.get(project.id) ?? 0;
        const retryDelay = retryDelaysMs[retryIndex];
        if (retryDelay !== undefined) {
          conversationBootstrapRetriesRef.current.set(project.id, retryIndex + 1);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            setConversationBootstrapRetryNonce((nonce) => nonce + 1);
          }, retryDelay);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [project.id, conversationBootstrapRetryNonce]);

  // Issue #1505: when the URL changes the routed conversation id while
  // we are already inside the project (e.g. the user clicks "Open
  // project" on a different routine history row in the same project),
  // switch the active conversation without re-fetching the list.
  // Guards: only acts when the routed id is non-null AND present in
  // the already-loaded list, and only when it differs from the current
  // active id. Falls through to a no-op for stale / missing routes so
  // the default picker above keeps its result.
  useEffect(() => {
    if (!routeConversationId) {
      lastSeenRouteConversationIdRef.current = null;
      return;
    }
    if (conversations.length === 0) return;
    if (routeConversationId === activeConversationId) return;
    // When the route still points at the conversation this view last
    // pushed to the URL, the mismatch means a local switch (new
    // conversation, history pick) moved activeConversationId ahead and
    // the URL sync below has not caught up yet. Following the stale
    // route here would fight that sync and remount ChatPane in a loop,
    // so only react to a genuinely external navigation.
    if (routeConversationId === lastSyncedConversationIdRef.current) return;
    if (lastSeenRouteConversationIdRef.current === routeConversationId) return;
    lastSeenRouteConversationIdRef.current = routeConversationId;
    const match = conversations.find((c) => c.id === routeConversationId);
    if (!match) return;
    setActiveConversationId(routeConversationId);
  }, [routeConversationId, conversations, activeConversationId]);

  // Entering (or switching to) a project always starts in the classic
  // chat+workspace split. The most recent conversation is auto-selected by the
  // conversations loader, so the left pane is never a dead column — and the
  // right side is populated instead of waiting for a conversation click. The
  // full-width file manager remains one click away (sidebar Files entry).
  useEffect(() => {
    setWorkspaceFocused(false);
  }, [project.id]);

  // Native MatOS resumes its authoritative CLI session.
  const readConversationPage = useCallback(async (conversationId: string) =>
    config.agentId === 'matos'
      ? listMessagesPage(project.id, conversationId)
      : { messages: await listMessages(project.id, conversationId), nextBefore: null },
  [project.id, config.agentId]);

  // Load messages whenever the active conversation changes. This happens
  // on project mount (after conversations load) and on user-triggered
  // conversation switches.
  useEffect(() => {
    setOlderMessageCursor(null);
    setOlderMessagesLoading(false);
    olderMessagesRequestRef.current = null;
    if (!activeConversationId) {
      setMessages([]);
      setMessagesInitialized(false);
      setPreviewComments([]);
      setAttachedComments([]);
      setMessagesConversationId(null);
      setFailedMessagesConversationId(null);
      messagesConversationIdRef.current = null;
      setStreaming(false);
      streamingConversationIdRef.current = null;
      setStreamingConversationId(null);
      return;
    }
    // Reset the initialized flag so auto-send waits for the new
    // conversation's DB read to settle before checking messages.length.
    setMessagesInitialized(false);
    let cancelled = false;
    setMessages([]);
    setPreviewComments([]);
    setAttachedComments([]);
    setArtifact(null);
    setMessagesConversationId(null);
    setFailedMessagesConversationId(null);
    setStreaming(false);
    streamingConversationIdRef.current = null;
    setStreamingConversationId(null);
    savedArtifactRef.current = null;
    if (messagesConversationIdRef.current !== activeConversationId) {
      messagesConversationIdRef.current = null;
    }
    // The conversation transcript is the primary surface. Do not make it
    // wait for auxiliary comments: a slow or unavailable preview-comments
    // request must not leave the whole chat stuck in its loading skeleton.
    void readConversationPage(activeConversationId)
      .then(({ messages: list, nextBefore }) => {
        if (cancelled) return;
        setOlderMessageCursor(nextBefore ?? null);
        setMessages(list);
        setMessagesInitialized(true);
        setAttachedComments([]);
        setArtifact(null);
        setError(null);
        savedArtifactRef.current = null;
        messagesConversationIdRef.current = activeConversationId;
        setMessagesConversationId(activeConversationId);
        setFailedMessagesConversationId(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not load messages for this conversation.';
        setMessages([]);
        setAttachedComments([]);
        setArtifact(null);
        setError(message);
        savedArtifactRef.current = null;
        messagesConversationIdRef.current = null;
        setMessagesConversationId(null);
        setFailedMessagesConversationId(activeConversationId);
      });

    void fetchPreviewComments(project.id, activeConversationId)
      .then((comments) => {
        if (cancelled) return;
        setPreviewComments(comments);
      })
      .catch(() => {
        // Comments are supplementary context. Keep the transcript usable when
        // the preview-comments service is slow or unavailable.
        if (!cancelled) setPreviewComments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, activeConversationId, messageLoadRetryNonce, readConversationPage]);

  const loadOlderMessages = useCallback(async () => {
    if (!activeConversationId || !olderMessageCursor || olderMessagesRequestRef.current) return;
    const conversationId = activeConversationId;
    const request = Symbol('older messages');
    olderMessagesRequestRef.current = request;
    setOlderMessagesLoading(true);
    try {
      const page = await listMessagesPage(project.id, conversationId, olderMessageCursor);
      if (messagesConversationIdRef.current !== conversationId || olderMessagesRequestRef.current !== request) return;
      setMessages(current => {
        const ids = new Set(current.map(message => message.id));
        return [...page.messages.filter(message => !ids.has(message.id)), ...current];
      });
      setOlderMessageCursor(page.nextBefore ?? null);
    } catch (err) {
      if (messagesConversationIdRef.current === conversationId && olderMessagesRequestRef.current === request) setError(String(err));
    } finally {
      if (messagesConversationIdRef.current === conversationId && olderMessagesRequestRef.current === request) {
        olderMessagesRequestRef.current = null;
        setOlderMessagesLoading(false);
      }
    }
  }, [project.id, activeConversationId, olderMessageCursor]);

  useEffect(() => {
    return () => {
      sendTextBufferRef.current?.cancel();
      sendTextBufferRef.current = null;
      // Unmounts / conversation switches should only detach local stream
      // consumers. Aborting the daemon cancel controllers here turns routine
      // cleanup into an explicit POST /api/runs/:id/cancel, which can mark a
      // live run canceled even when the user never clicked Stop.
      abortRef.current?.abort();
      abortRef.current = null;
      cancelRef.current = null;
      for (const textBuffer of reattachTextBuffersRef.current) textBuffer.cancel();
      reattachTextBuffersRef.current.clear();
      for (const controller of reattachControllersRef.current.values()) {
        if (abortRef.current === controller) abortRef.current = null;
        controller.abort();
      }
      for (const controller of reattachCancelControllersRef.current.values()) {
        // Route changes should only detach the browser-side SSE listener.
        // Aborting this signal maps to POST /cancel, so leave the daemon run alive.
        if (cancelRef.current === controller) cancelRef.current = null;
      }
      reattachControllersRef.current.clear();
      reattachCancelControllersRef.current.clear();
    };
  }, [project.id, activeConversationId]);

  const cancelSendTextBuffer = useCallback((flushPending = false) => {
    if (flushPending) sendTextBufferRef.current?.flush();
    sendTextBufferRef.current?.cancel();
    sendTextBufferRef.current = null;
  }, []);

  const cancelReattachTextBuffers = useCallback((flushPending = false) => {
    for (const textBuffer of reattachTextBuffersRef.current) {
      if (flushPending) textBuffer.flush();
      textBuffer.cancel();
    }
    reattachTextBuffersRef.current.clear();
  }, []);

  const notifyCompletedRun = useCallback((last: ChatMessage) => {
    const status = last.runStatus;
    if (status !== 'succeeded' && status !== 'failed') return;

    const cfg = config.notifications ?? DEFAULT_NOTIFICATIONS;
    if (cfg.soundEnabled) {
      playSound(status === 'succeeded' ? cfg.successSoundId : cfg.failureSoundId);
    }

    if (cfg.desktopEnabled) {
      // Successes only interrupt when the user is on another tab/window.
      // Failures alert regardless — losing a long agent run silently is
      // worse than a small interruption when the page is in focus.
      const isHidden = typeof document !== 'undefined' && document.hidden;
      const isFocused = typeof document === 'undefined' ? true : document.hasFocus();
      if (status === 'failed' || isHidden || !isFocused) {
        const title = status === 'succeeded'
          ? t('notify.successTitle')
          : t('notify.failureTitle');
        const fallbackBody = status === 'succeeded'
          ? t('notify.successBody')
          : t('notify.failureBody');
        const trimmed = (last.content ?? '').trim();
        const body = trimmed ? trimmed.slice(0, 80) : fallbackBody;
        void showCompletionNotification({
          status,
          title,
          body,
          onClick: () => {
            if (typeof window !== 'undefined') window.focus();
          },
        });
      }
    }
  }, [config.notifications, t]);

  // Fire completion feedback from assistant run-status transitions rather than
  // from the local SSE listener state. A run can finish while its conversation
  // is detached; when the user returns, the terminal status should still produce
  // the one completion notification for runs this view previously saw active.
  useEffect(() => {
    const completedMessages: ChatMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const keys = message.runId ? [message.runId, message.id] : [message.id];
      if (isActiveRunStatus(message.runStatus)) {
        for (const key of keys) activeCompletionNotificationRunsRef.current.add(key);
        continue;
      }
      if (message.runStatus !== 'succeeded' && message.runStatus !== 'failed') continue;
      if (!keys.some((key) => activeCompletionNotificationRunsRef.current.has(key))) continue;
      if (keys.some((key) => completedNotificationRunsRef.current.has(key))) continue;
      for (const key of keys) completedNotificationRunsRef.current.add(key);
      completedMessages.push(message);
    }

    for (const message of completedMessages) notifyCompletedRun(message);
  }, [messages, notifyCompletedRun]);

  // Hydrate the open-tabs state once per project. After this initial
  // load, every mutation flows through saveTabsState() which keeps DB +
  // local state coherent.
  useEffect(() => {
    let cancelled = false;
    tabsLoadedRef.current = false;
    tabsHydratedFromSavedStateRef.current = false;
    hasAppliedInitialPrimaryOpenRef.current = false;
    setOpenTabsState({ tabs: [], active: null });
    (async () => {
      const state = await loadTabs(project.id);
      if (cancelled) return;
      const routeActive = routeFileNameRef.current;
      let nextState = routeActive
        ? {
            ...state,
            tabs: state.tabs.includes(routeActive)
              ? state.tabs
              : [...state.tabs, routeActive],
            active: routeActive,
          }
        : state;
      if (routeActive) {
        nextState = cacheTabsLocally(project.id, nextState);
        void persistTabsToDaemonNow(project.id, nextState);
      }
      tabsHydratedFromSavedStateRef.current = state.hasSavedState === true;
      setOpenTabsState(nextState);
      tabsLoadedRef.current = true;
      setTabsHydrationVersion((version) => version + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Debounce the canonical (daemon + SQLite) tab-state write. Tab activation
  // and reorder bursts used to trigger a localStorage write + HTTP PUT +
  // SQLite UPDATE + re-render each. We keep React state and the local cache
  // IMMEDIATE (so the UI and a reload are never stale) and coalesce only the
  // daemon PUT.
  const tabsDaemonSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDaemonTabsRef = useRef<OpenTabsState | null>(null);
  const flushTabsDaemonSave = useCallback(() => {
    if (tabsDaemonSaveTimerRef.current != null) {
      clearTimeout(tabsDaemonSaveTimerRef.current);
      tabsDaemonSaveTimerRef.current = null;
    }
    const pending = pendingDaemonTabsRef.current;
    pendingDaemonTabsRef.current = null;
    if (pending) void persistTabsToDaemonNow(project.id, pending);
  }, [project.id]);

  const persistTabsState = useCallback(
    (next: OpenTabsState) => {
      setOpenTabsState(next);
      if (!tabsLoadedRef.current) return;
      // Immediate, cheap, synchronous — keeps the cache canonical for reload.
      const stamped = cacheTabsLocally(project.id, next);
      pendingDaemonTabsRef.current = stamped;
      if (tabsDaemonSaveTimerRef.current != null) {
        clearTimeout(tabsDaemonSaveTimerRef.current);
      }
      tabsDaemonSaveTimerRef.current = setTimeout(() => {
        tabsDaemonSaveTimerRef.current = null;
        const pending = pendingDaemonTabsRef.current;
        pendingDaemonTabsRef.current = null;
        if (pending) void persistTabsToDaemonNow(project.id, pending);
      }, TAB_PERSIST_DEBOUNCE_MS);
    },
    [project.id],
  );

  // Flush any pending tab write when the project changes or the view unmounts,
  // so a fast project switch / close doesn't leave the daemon a debounce behind.
  useEffect(() => flushTabsDaemonSave, [flushTabsDaemonSave]);

  const handleActiveWorkspaceContextChange = useCallback((next: WorkspaceContextItem | null) => {
    setActiveWorkspaceContext((current) =>
      workspaceContextItemEqual(current, next) ? current : next,
    );
  }, []);

  const handleWorkspaceContextsChange = useCallback((next: WorkspaceContextItem[]) => {
    setWorkspaceContexts((current) =>
      workspaceContextItemsEqual(current, next) ? current : next,
    );
  }, []);

  const refreshProjectFiles = useCallback(async (): Promise<ProjectFile[]> => {
    // Run recovery/completion needs a full authoritative inventory. Do not
    // publish this full snapshot to React's browsing state.
    const [complete] = await Promise.all([fetchProjectFiles(project.id), refreshFilePage()]);
    return complete;
  }, [project.id, refreshFilePage]);

  useEffect(() => {
    projectFilesRef.current = projectFiles;
  }, [projectFiles]);

  // Cache HTML file contents so the auto-open module check (issue #2744) does
  // not re-fetch unchanged entries on every Write. Keyed by file name with the
  // mtime stored alongside, so a rewrite REPLACES the file's single entry
  // rather than accreting a new key. Bounded by the project's HTML file count.
  const htmlContentCacheRef = useRef<Map<string, { mtime: number; text: string | null }>>(
    new Map(),
  );
  const readProjectHtml = useCallback(
    async (name: string): Promise<string | null> => {
      const file = projectFilesRef.current.find((entry) => entry.name === name);
      const mtime = file?.mtime ?? 0;
      const cached = htmlContentCacheRef.current.get(name);
      if (cached && cached.mtime === mtime) return cached.text;
      try {
        const response = await fetch(projectRawUrl(project.id, name));
        const text = response.ok ? await response.text() : null;
        htmlContentCacheRef.current.set(name, { mtime, text });
        return text;
      } catch {
        htmlContentCacheRef.current.set(name, { mtime, text: null });
        return null;
      }
    },
    [project.id],
  );

  const refreshWorkspaceItems = useCallback(async (): Promise<ProjectFile[]> => {
    return refreshFilePage();
  }, [refreshFilePage]);

  useEffect(() => {
    if (!tabsLoadedRef.current) return;
    if (hasAppliedInitialPrimaryOpenRef.current) return;
    if (routeFileName) return;
    if (openTabsState.active || openTabsState.tabs.length > 0) {
      hasAppliedInitialPrimaryOpenRef.current = true;
      return;
    }
    if (tabsHydratedFromSavedStateRef.current) {
      hasAppliedInitialPrimaryOpenRef.current = true;
      return;
    }
    const primaryFile = selectPrimaryProjectFile(projectFiles);
    if (!primaryFile) return;
    hasAppliedInitialPrimaryOpenRef.current = true;
    persistTabsState({ tabs: [primaryFile.name], active: primaryFile.name });
  }, [openTabsState.active, openTabsState.tabs.length, persistTabsState, projectFiles, routeFileName]);

  const requestOpenFile = useCallback((name: string) => {
    if (!name) return;
    setOpenRequest({ name, nonce: Date.now() });
  }, []);

  const persistArtifact = useCallback(
    async (
      art: Artifact,
      projectFilesSnapshot?: ProjectFile[],
      sourceText?: string,
      options: { pointerMinMtime?: number } = {},
    ) => {
      const persistedHtml = resolvePersistedArtifactHtml({
        artifactHtml: art.html,
        identifier: art.identifier,
        sourceText,
      });
      const artifactToPersist = persistedHtml === art.html ? art : { ...art, html: persistedHtml };
      const baseName = artifactBaseNameFor(art);
      const ext = artifactExtensionFor(art);
      // Pick a name that doesn't collide with an existing project file.
      // The first run uses `<base>.<ext>`; subsequent runs append `-2`, `-3`…
      // so prior artifacts aren't silently overwritten.
      const currentProjectFiles = projectFilesSnapshot ?? projectFilesRef.current;
      const existing = new Set(currentProjectFiles.map((f) => f.name));
      let fileName = `${baseName}${ext}`;
      let n = 2;
      while (existing.has(fileName) && savedArtifactRef.current !== fileName) {
        fileName = `${baseName}-${n}${ext}`;
        n += 1;
      }
      if (ext === '.html') {
        const pointerProjectFiles = filterProjectFilesByMinMtime(
          currentProjectFiles,
          options.pointerMinMtime,
        );
        const pointerTarget = resolveHtmlPointerArtifactTarget({
          content: artifactToPersist.html,
          candidateFileName: fileName,
          projectFiles: pointerProjectFiles,
        });
        if (pointerTarget) {
          if (savedArtifactRef.current === pointerTarget) return;
          savedArtifactRef.current = pointerTarget;
          requestOpenFile(pointerTarget);
          return;
        }
      }
      // Pre-write structural gate for HTML artifacts (#50, #1143). Reject
      // bodies that obviously aren't a complete document — usually a one-line
      // prose summary the model emitted inside `<artifact type="text/html">`
      // when only Edit-tool changes happened this turn. Without this guard,
      // such content lands as a phantom HTML file in the project panel.
      if (ext === '.html') {
        const validation = validateHtmlArtifact(artifactToPersist.html);
        if (!validation.ok) {
          setError(`Refused to save artifact "${art.identifier || art.title || 'untitled'}": ${validation.reason}`);
          return;
        }
      }
      if (savedArtifactRef.current === fileName) return;
      const title = art.title || art.identifier || fileName;
      const metadata = {
        identifier: art.identifier,
        artifactType: art.artifactType,
        inferred: false,
      };
      const manifest =
        ext === '.html'
          ? createHtmlArtifactManifest({
              entry: fileName,
              title,
              sourceSkillId: project.skillId ?? undefined,
              metadata,
            })
          : inferLegacyManifest({
              entry: fileName,
              title,
              metadata: {
                ...metadata,
                sourceSkillId: project.skillId ?? undefined,
              },
            });
      const file = await writeProjectTextFile(project.id, fileName, artifactToPersist.html, {
        artifactManifest: manifest ?? undefined,
      });
      if (file) {
        savedArtifactRef.current = file.name;
        setFilesRefresh((n) => n + 1);
        // Surface the daemon's stub-guard warning when it fires in `warn`
        // mode (the default). Without this the warning would land in the
        // file metadata silently and the user would never see that the
        // model shipped a placeholder.
        if (file.stubGuardWarning) {
          setError(
            `Saved "${file.name}", but the model may have shipped a placeholder: ` +
              `${file.stubGuardWarning.message}`,
          );
        }
        // Auto-open the freshly-persisted artifact as a tab so the user
        // sees it without an extra click. The Write-tool path already does
        // this for tool-emitted files; this handles the artifact-tag path.
        requestOpenFile(file.name);
      } else {
        // writeProjectTextFile collapses all failure paths (non-OK HTTP
        // responses, network errors, and stub-guard 422s) to null — the
        // helper's return contract would need to be widened to distinguish
        // them, which is out of scope here.  Show a generic banner so the
        // failure is observable rather than silent; the daemon logs carry
        // the structured details for any specific error type.
        // Clear the saved-artifact ref so the user can retry.
        savedArtifactRef.current = '';
        setError(
          `Couldn't save artifact "${fileName}". The write failed — ` +
            'check the daemon logs for details.',
        );
      }
    },
    [project.id, project.skillId, requestOpenFile],
  );

  const artifactFromStandaloneHtml = useCallback(
    (sourceText: string): Artifact | null => artifactFromRecoverableSourceText(sourceText),
    [],
  );

  // Set of project file names that the chat surface uses to decide whether
  // a tool card's path is openable as a tab. Recomputed on every file-list
  // change; tool cards just read from the set.
  const projectFileNames = useMemo(
    () => new Set(projectFiles.map((f) => f.name)),
    [projectFiles],
  );
  const activeProjectFileName = useMemo(
    () => (
      openTabsState.active && projectFileNames.has(openTabsState.active)
        ? openTabsState.active
        : null
    ),
    [openTabsState.active, projectFileNames],
  );
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  // Keep the @-picker's source of truth fresh: every refreshSignal bump
  // (artifact saved, image uploaded) refetches. On first mount,
  // wait for the conversation transcript to settle before walking the
  // workspace tree. Imported folders can contain tens of thousands of files;
  // their index must not delay the primary chat surface.
  useEffect(() => {
    if (!messagesInitialized) return;
    void refreshWorkspaceItems().catch(() => {
      // The daemon probe can briefly lag behind a just-started local
      // runtime. Retry when daemonLive flips or the explicit refresh key
      // changes instead of leaving the project view in its empty shell.
    });
  }, [daemonLive, filesRefresh, messagesInitialized, refreshWorkspaceItems]);

  // Live-reload: when the daemon's chokidar watcher reports a file change,
  // bump filesRefresh so the file list refetches with new mtimes — which
  // propagates through to FileViewer iframes via PR #384's ?v=${mtime}
  // cache-bust, triggering an automatic preview reload without a click.
  //
  // Coalesce the refresh: agent rewrites surface to chokidar as an
  // `unlink` + `add` (+ later `change`) burst within a single tick (#2195).
  // Refreshing the file list on the intermediate `unlink` makes the open
  // tab's active file vanish for one frame before the `add` restores it,
  // and FileWorkspace's "tab no longer on disk" path then drops the user
  // out of their preview. A short trailing wait absorbs the burst; the
  // maxWait cap stops a sustained edit storm from starving the UI.
  const refreshFilesSoon = useCallback(() => {
    setFilesRefresh((n) => n + 1);
  }, []);
  const coalescedFileChangedRefresh = useCoalescedCallback(
    refreshFilesSoon,
    // Scientific jobs can continuously rewrite logs/checkpoints. Refreshing
    // their index four times per second makes browsing compete with the job.
    // Explicit saves/refreshes remain immediate; OD preview timing is unchanged.
    config.agentId === 'matos'
      ? { wait: 500, maxWait: 2000 }
      : { wait: 80, maxWait: 250 },
  );
  const handleProjectEvent = useCallback((evt: ProjectEvent) => {
    if (evt.type === 'file-changed') {
      iframeKeepAlivePool.evictProject(project.id);
      coalescedFileChangedRefresh();
      return;
    }
    if (evt.type === 'conversation-created') {
      // A new conversation was inserted into this project by a path the
      // open project view can't observe through its own state (currently:
      // Routines "Run now" in reuse-an-existing-project mode, #1361).
      // Refetch the conversation list so the new entry becomes visible
      // without requiring the user to leave and re-enter the project.
      // Deliberately do NOT change the active conversation here — the
      // user keeps their current context. Auto-switch is a separate UX
      // decision tracked in #1361.
      if (evt.projectId !== project.id) return;
      const capturedProjectId = project.id;
      const myToken = ++conversationsRefreshTokenRef.current;
      void (async () => {
        try {
          const list = await listConversations(capturedProjectId);
          // Bail if the user switched projects while this request was in
          // flight (#1361 review, Codex P1). The captured project id is the
          // one we asked the daemon about; the live ref is the one the
          // user is looking at right now. If they don't match, applying
          // the list would overwrite the new project's sidebar with
          // stale data from the old one.
          if (projectIdRef.current !== capturedProjectId) return;
          // Bail if a newer conversation-created event already dispatched
          // its own refresh after us (#1361 review, lefarcen P2). With two
          // rapid events the later request may resolve first; if this
          // earlier request resolves afterwards it would drop the newer
          // conversation. Only the latest dispatch is allowed to apply.
          if (conversationsRefreshTokenRef.current !== myToken) return;
          setConversations(list);
        } catch {
          // Defensive: refresh failed (network blip, daemon gone). The
          // next project mount or another conversation-created event
          // will retry; no need to surface an error here.
        }
      })();
      return;
    }  }, [coalescedFileChangedRefresh, iframeKeepAlivePool, onProjectsRefresh, project.id]);
  useProjectFileEvents(project.id, daemonLive, handleProjectEvent);

  const activePromptContextSignature = useMemo(() => {
    const skill = project.skillId
      ? (skills.find((s) => s.id === project.skillId) ??
        designTemplates.find((s) => s.id === project.skillId))
      : null;
    return JSON.stringify({
      skill: skill
        ? {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            mode: skill.mode,
            source: skill.source ?? null,
            upstream: skill.upstream,
          }
        : null,
    });
  }, [designTemplates, project.skillId, skills]);
  const previousPromptContextSignatureRef = useRef(activePromptContextSignature);
  useEffect(() => {
    if (previousPromptContextSignatureRef.current === activePromptContextSignature) return;
    previousPromptContextSignatureRef.current = activePromptContextSignature;
    iframeKeepAlivePool.evictProject(project.id, { includeActive: true });
  }, [activePromptContextSignature, iframeKeepAlivePool, project.id]);

  // When the URL points at a specific file, fire an open request so the
  // FileWorkspace promotes it to an active tab. We watch routeFileName
  // (the parsed segment) so back/forward navigation triggers the same path.
  useEffect(() => {
    if (!routeFileName) return;
    requestOpenFile(routeFileName);
  }, [routeFileName, requestOpenFile]);

  // Sync the URL when the active tab changes, so reload + share-link both
  // land back on the same view. Replace (not push) on tab activation so the
  // history stack doesn't fill with every tab click.
  // Composite sync key: tracks BOTH the active file target AND the active
  // conversation id, so a conversation-only change (e.g. `listConversations`
  // resolves after `loadTabs` hydrated the active tab, or the user picks a
  // different conversation under the same tab) still triggers the navigate
  // and pushes `/conversations/:cid` into the URL. Keying only on the file
  // target lost that update because the early-return saw `target` unchanged
  // and skipped the navigate (lefarcen P1 on PR #1508).
  const lastSyncedRouteKeyRef = useRef<string | null>(null);
  const lastSeenRouteConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    const target = openTabsState.active && (
      openTabsState.tabs.includes(openTabsState.active)
      || projectFileNames.has(openTabsState.active)
    )
      ? openTabsState.active
      : null;
    const nextKey = `${activeConversationId ?? ''}:${target ?? ''}`;
    if (nextKey === lastSyncedRouteKeyRef.current) return;
    lastSyncedRouteKeyRef.current = nextKey;
    lastSyncedConversationIdRef.current = activeConversationId;
    // PerishCode + Codex P1 on PR #1508: the prior version of this
    // sync stripped any `/conversations/:cid` segment from the URL as
    // soon as a tab became active, which regressed the deep-link
    // behavior the parent commit was meant to add (reload / share
    // would fall back to `list[0]` instead of the routed run's
    // conversation). Thread the active conversation id so the URL
    // always reflects the conversation the project view is actually
    // showing, matching how `fileName` already tracks the active tab.
    navigate(
      {
        kind: 'project',
        projectId: project.id,
        conversationId: activeConversationId,
        fileName: target,
      },
      { replace: true },
    );
  }, [openTabsState.active, projectFileNames, project.id, activeConversationId]);

  const handleEnsureProject = useCallback(async (): Promise<string | null> => {
    return project.id;
  }, [project.id]);

  const persistMessage = useCallback(
    (m: ChatMessage, options?: SaveMessageOptions) => {
      if (!activeConversationId) return;
      // Source-level guard against the "Working 24m+ / Waiting for first
      // output" UI: never write a daemon assistant row that is still
      // queued/running but has no runId. Until POST /api/runs returns the
      // runId, the message is purely in-flight on the client; persisting it
      // here creates a row that nothing can ever reattach to (daemon never
      // saw the runId, client lost the response). Once onRunCreated assigns
      // a runId — or the run finishes terminally — this guard lets the row
      // through normally.
      if (isPhantomDaemonRunMessage(m)) return;
      void saveMessage(project.id, activeConversationId, m, options);
    },
    [project.id, activeConversationId],
  );

  const persistMessageById = useCallback(
    (messageId: string, options?: SaveMessageOptions) => {
      if (!activeConversationId) return;
      setMessages((curr) => {
        const found = curr.find((m) => m.id === messageId);
        if (found && !isPhantomDaemonRunMessage(found)) {
          void saveMessage(project.id, activeConversationId, found, options);
        }
        return curr;
      });
    },
    [project.id, activeConversationId],
  );

  const updateMessageById = useCallback(
    (
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
      persist = false,
      persistOptions?: SaveMessageOptions,
    ) => {
      setMessages((curr) => {
        let saved: ChatMessage | null = null;
        const next = curr.map((m) => {
          if (m.id !== messageId) return m;
          const updated = updater(m);
          saved = updated;
          return updated;
        });
        // Same phantom guard as persistMessage: skip writes for a daemon
        // assistant row that is still in-flight (active runStatus, no runId).
        // The runId-arriving update from onRunCreated passes through because
        // the updater sets runId before this check runs.
        if (persist && saved && activeConversationId && !isPhantomDaemonRunMessage(saved)) {
          void saveMessage(project.id, activeConversationId, saved, persistOptions);
        }
        return next;
      });
    },
    [project.id, activeConversationId],
  );

  const appendConversationMessage = useCallback(
    (
      conversationId: string,
      message: ChatMessage,
      options?: SaveMessageOptions,
      persist = true,
    ) => {
      if (
        activeConversationId === conversationId
        || messagesConversationIdRef.current === conversationId
      ) {
        setMessages((curr) => [...curr, message]);
      }
      if (persist) void saveMessage(project.id, conversationId, message, options);
    },
    [activeConversationId, project.id],
  );

  const replaceConversationMessage = useCallback(
    (
      conversationId: string,
      message: ChatMessage,
      options?: SaveMessageOptions,
      persist = true,
    ) => {
      if (
        activeConversationId === conversationId
        || messagesConversationIdRef.current === conversationId
      ) {
        setMessages((curr) => curr.map((item) => (item.id === message.id ? message : item)));
      }
      if (persist) void saveMessage(project.id, conversationId, message, options);
    },
    [activeConversationId, project.id],
  );

  const refreshConversationMessagesFromServer = useCallback(
    async (conversationId: string) => {
      if (messagesConversationIdRef.current !== conversationId) return;
      try {
        const recent = await readConversationPage(conversationId);
        if (messagesConversationIdRef.current !== conversationId) return;
        const page = await readOverlappingMessagePages(recent, messagesRef.current,
          before => listMessagesPage(project.id, conversationId, before),
          () => messagesConversationIdRef.current === conversationId);
        if (messagesConversationIdRef.current !== conversationId) return;
        setMessages((current) => mergeServerMessagesIntoConversation(current, page.messages, Boolean(page.nextBefore)));
        setMessagesInitialized(true);
        setMessagesConversationId(conversationId);
        setFailedMessagesConversationId(null);
      } catch (err) {
        console.warn('Failed to refresh conversation messages after run completion', err);
      }
    },
    [project.id, readConversationPage],
  );

  const scheduleConversationMessageRefresh = useCallback(
    (conversationId: string) => {
      scheduleProjectTimeout(() => {
        void refreshConversationMessagesFromServer(conversationId);
      }, 150);
    },
    [refreshConversationMessagesFromServer, scheduleProjectTimeout],
  );

  const markStreamingConversation = useCallback((conversationId: string) => {
    streamingConversationIdRef.current = conversationId;
    setStreaming(true);
    setStreamingConversationId(conversationId);
  }, []);

  const clearStreamingMarker = useCallback((conversationId?: string | null) => {
    const next = clearStreamingConversationMarker(
      streamingConversationIdRef.current,
      conversationId,
    );
    if (next === streamingConversationIdRef.current) return;
    streamingConversationIdRef.current = next;
    setStreamingConversationId(next);
    setStreaming(next !== null);
  }, []);

  const clearActiveRunRefs = useCallback((
    conversationId: string,
    controller: AbortController,
    cancelController: AbortController,
  ) => {
    if (!shouldClearActiveRunRefs(streamingConversationIdRef.current, conversationId)) {
      return false;
    }
    if (abortRef.current !== controller || cancelRef.current !== cancelController) {
      return false;
    }
    abortRef.current = null;
    cancelRef.current = null;
    return true;
  }, []);

  const clearCurrentRunStreamingMarker = useCallback((
    conversationId: string,
    controller: AbortController,
    cancelController: AbortController,
  ) => {
    if (!clearActiveRunRefs(conversationId, controller, cancelController)) return false;
    clearStreamingMarker(conversationId);
    return true;
  }, [clearActiveRunRefs, clearStreamingMarker]);

  const handleAssistantFeedback = useCallback(
    (assistantMessage: ChatMessage, change: ChatMessageFeedbackChange) => {
      const now = Date.now();
      updateMessageById(
        assistantMessage.id,
        (prev) =>
          change
            ? {
                ...prev,
                feedback: {
                  rating: change.rating,
                  reasonCodes: change.reasonCodes,
                  customReason: change.customReason,
                  reasonsSubmittedAt: change.reasonsSubmittedAt,
                  createdAt:
                    prev.feedback?.rating === change.rating
                      ? prev.feedback.createdAt
                      : now,
                  updatedAt: now,
                },
              }
            : {
                ...prev,
                feedback: undefined,
              },
        true,
      );
    },
    [updateMessageById, activeConversationId, project.id],
  );

  // `code` is the structured API error code (e.g. AGENT_AUTH_REQUIRED); it
  // rides along on the error status event so AssistantMessage can render the
  // hosted-AMR nudge for model/auth/quota failures on non-AMR agents.
  const appendAssistantErrorEvent = useCallback(
    (messageId: string, message: string, code?: string) => {
      if (!message) return;
      updateMessageById(
        messageId,
        (prev) => appendErrorStatusEvent(prev, message, code),
        true,
      );
    },
    [updateMessageById],
  );

  const refreshPreviewComments = useCallback(async () => {
    if (!activeConversationId) return;
    const next = await fetchPreviewComments(project.id, activeConversationId);
    setPreviewComments(next);
    setAttachedComments((current) =>
      current
        .map((attached) => next.find((comment) => comment.id === attached.id))
        .filter((comment): comment is PreviewComment => Boolean(comment)),
    );
  }, [project.id, activeConversationId]);

  const savePreviewComment = useCallback(
    async (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images: File[] = []) => {
      if (!activeConversationId) return null;
      // Upload any attached images first so the saved comment carries durable
      // file paths — this is what lets the comment list / re-opened popover
      // re-display the images instead of losing them on echo.
      let uploadedAttachments: PreviewCommentAttachment[] | undefined;
      if (images.length > 0) {
        const result = await uploadProjectFiles(project.id, images);
        if (result.uploaded.length !== images.length) return null;
        uploadedAttachments = result.uploaded.map((file) => ({ path: file.path, name: file.name }));
      }
      const existing = previewComments.find(
        (comment) => comment.filePath === target.filePath && comment.elementId === target.elementId,
      );
      const attachments = mergePreviewCommentAttachments(existing?.attachments, uploadedAttachments);
      const saved = await upsertPreviewComment(project.id, activeConversationId, {
        target,
        note,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (!saved) return null;
      setPreviewComments((current) => mergeSavedPreviewComment(current, saved));
      setAttachedComments((current) =>
        attachAfterSave ? mergeAttachedComments(current, saved) : current.map((comment) => comment.id === saved.id ? saved : comment),
      );
      return saved;
    },
    [project.id, activeConversationId, previewComments],
  );

  const removePreviewComment = useCallback(
    async (commentId: string) => {
      if (!activeConversationId) return;
      const ok = await deletePreviewComment(project.id, activeConversationId, commentId);
      if (!ok) return;
      setPreviewComments((current) => current.filter((comment) => comment.id !== commentId));
      setAttachedComments((current) => removeAttachedComment(current, commentId));
    },
    [project.id, activeConversationId],
  );

  const attachPreviewComment = useCallback((comment: PreviewComment) => {
    setAttachedComments((current) => mergeAttachedComments(current, comment));
  }, []);

  const detachPreviewComment = useCallback((commentId: string) => {
    setAttachedComments((current) => removeAttachedComment(current, commentId));
  }, []);

  const patchAttachedStatuses = useCallback(
    async (attachments: ChatCommentAttachment[], status: PreviewComment['status']) => {
      if (!activeConversationId || attachments.length === 0) return;
      const persistedAttachments = attachments.filter(
        (attachment) => attachment.source !== 'board-batch',
      );
      if (persistedAttachments.length === 0) return;
      setPreviewComments((current) =>
        current.map((comment) =>
          persistedAttachments.some((attachment) => attachment.id === comment.id)
            ? { ...comment, status }
            : comment,
        ),
      );
      await Promise.all(
        persistedAttachments.map((attachment) =>
          patchPreviewCommentStatus(project.id, activeConversationId, attachment.id, status),
        ),
      );
      void refreshPreviewComments();
    },
    [project.id, activeConversationId, refreshPreviewComments],
  );

  // Maximum number of times we will retry fetching a null status for a
  // spuriouslyFailedPending run before treating the absence as authoritative
  // completion.  Transient null-status retries are bounded; after
  // MAX_TRANSIENT_RETRIES we add to completedReattachRunsRef to avoid spinning.
  const MAX_TRANSIENT_RETRIES = 2;

  // Reset transient retry counts when the conversation or daemon connection
  // changes so stale counts from a previous session do not bleed in.  This
  // must be a separate effect keyed only on those two values; placing the
  // reset inside the reattach effect (which also depends on recoveryTick and
  // messages) would zero the counts every time the timer-driven recoveryTick
  // bumped, preventing attempts >= MAX_TRANSIENT_RETRIES from ever holding.
  useEffect(() => {
    transientFailedRetriesRef.current = new Map();
    genericDisconnectRetriesRef.current = new Map();
    genericDisconnectBackoffUntilRef.current = new Map();
  }, [activeConversationId, daemonLive]);

  useEffect(() => {
    if (!daemonLive || !activeConversationId || streaming) return;
    let cancelled = false;
    const reattachConversationId = activeConversationId;

    const attachRecoverableRuns = async () => {
      const missingRunIdMessages = messages.filter((m) => {
        if (m.role !== 'assistant' || m.runId) return false;
        return isActiveRunStatus(m.runStatus);
      });
      const activeRuns = missingRunIdMessages.length > 0
        ? await listActiveChatRuns(project.id, reattachConversationId)
        : [];
      const historicalRuns = missingRunIdMessages.length > 0
        ? (await listProjectRuns()).filter(
            (run) => run.projectId === project.id && run.conversationId === reattachConversationId,
          )
        : [];
      if (cancelled) return;
      const activeByMessage = new Map(
        activeRuns
          .filter((run) => run.assistantMessageId)
          .map((run) => [run.assistantMessageId!, run]),
      );
      const historicalByMessage = new Map(
        historicalRuns
          .filter((run) => run.assistantMessageId)
          .map((run) => [run.assistantMessageId!, run]),
      );

      for (const message of messages) {
        if (cancelled) return;
        if (message.role !== 'assistant') continue;

        // A message whose run_status was spuriously written as 'failed' before
        // the page reloaded (e.g. the SSE reconnect fallback fired while the
        // daemon run was still in flight) must still be reattached when the
        // actual daemon run succeeded.  Detect this by checking for a 'failed'
        // message that has a runId but no content and no produced files — the
        // daemon's authoritative status is fetched below and the message is
        // updated to reflect it.
        //
        // NOTE: `spuriouslyFailedPending` is kept separate from the other two
        // branches because the recovery action is gated on the fetched daemon
        // status; genuine failures (onError of a live stream) must not enter
        // the reattach path and must never have their persisted failure context
        // cleared or their resumable flag overwritten.
        const spuriouslyFailedPending =
          message.runStatus === 'failed' &&
          !!message.runId &&
          !message.content &&
          !(message.producedFiles?.length);
        const recoverableGenericDisconnectFailed =
          message.runStatus === 'failed' &&
          !!message.runId &&
          hasGenericDisconnectFailureEvent(message);
        const replayingTerminalRun =
          shouldReplayTerminalRunMessage(message) || spuriouslyFailedPending;
        const needsFullReplay =
          isActiveRunStatus(message.runStatus) ||
          replayingTerminalRun ||
          spuriouslyFailedPending ||
          recoverableGenericDisconnectFailed;
        if (!needsFullReplay) continue;
        const fallbackRun = !message.runId
          ? activeByMessage.get(message.id) ?? historicalByMessage.get(message.id) ?? null
          : null;
        const runId = message.runId ?? fallbackRun?.id;
        // Self-heal phantom 'running' rows: when the message has no runId
        // and the daemon has no active run mapped to it, the original send
        // POST was lost (daemon restart mid-flight, the user navigated
        // away before /api/runs returned, or a network blip). Leaving the
        // message as 'running' is what produces the "Waiting for first
        // output — Working 24m+" UI the user reported. Mark it failed so
        // the composer is interactive again and the user can re-send.
        if (!runId) {
          updateMessageById(
            message.id,
            (prev) => ({
              ...prev,
              runStatus: 'failed',
              endedAt: prev.endedAt ?? Date.now(),
            }),
            true,
          );
          continue;
        }
        if (reattachControllersRef.current.has(runId)) continue;
        if (completedReattachRunsRef.current.has(runId)) continue;
        const genericDisconnectBackoffUntil =
          genericDisconnectBackoffUntilRef.current.get(runId) ?? 0;
        if (genericDisconnectBackoffUntil > Date.now()) continue;
        genericDisconnectBackoffUntilRef.current.delete(runId);

        if (fallbackRun && !message.runId) {
          updateMessageById(
            message.id,
            (prev) => ({ ...prev, runId, runStatus: fallbackRun.status }),
            true,
          );
        }

        const status = fallbackRun ?? await fetchChatRunStatus(runId);
        if (cancelled) return;
        if (!status) {
          // `fetchChatRunStatus` returns null on ANY non-OK response or fetch
          // exception (providers/daemon.ts:686), not only when the daemon has
          // permanently forgotten the run.  For a spuriously-failed pending
          // message we must keep this path retryable: a transient network or
          // daemon hiccup during reload must not permanently suppress the
          // reattach attempt for the rest of the session.
          //
          // Transient null-status retries are bounded; after MAX_TRANSIENT_RETRIES
          // we treat the absence as authoritative completion to avoid spinning.
          // Timers are tracked in transientRetryTimersRef and cleared on cleanup.
          //
          // For other message states (phantom running rows with no runId),
          // fall through to the original mark-failed behaviour and seal the
          // runId so we don't loop indefinitely.
          if (spuriouslyFailedPending) {
            const attempts = transientFailedRetriesRef.current.get(runId) ?? 0;
            if (attempts >= MAX_TRANSIENT_RETRIES) {
              // Cap reached — treat as authoritative completion so we stop retrying.
              // Clear the Map entry so it doesn't accumulate stale entries.
              transientFailedRetriesRef.current.delete(runId);
              genericDisconnectRetriesRef.current.delete(runId);
              completedReattachRunsRef.current.add(runId);
            } else {
              transientFailedRetriesRef.current.set(runId, attempts + 1);
              const handle = setTimeout(() => {
                transientRetryTimersRef.current.delete(handle);
                setRecoveryTick((t) => t + 1);
              }, 3000);
              transientRetryTimersRef.current.add(handle);
            }
          } else {
            updateMessageById(
              message.id,
              (prev) => ({ ...prev, runStatus: 'failed', endedAt: prev.endedAt ?? Date.now() }),
              true,
            );
            completedReattachRunsRef.current.add(runId);
          }
          continue;
        }
        // When the daemon authoritative status is 'failed', the run ended in a
        // genuine failure.  For spuriously-failed pending messages this means
        // the client-side heuristic was wrong — the daemon did not succeed.
        // Leave the message alone so its persisted error content/events/producedFiles
        // survive, but still apply the daemon's authoritative `resumable` flag so
        // ChatPane's Continue affordance reflects the daemon's view after a reload.
        if (spuriouslyFailedPending && status.status === 'failed') {
          if (typeof status.resumable !== 'undefined') {
            updateMessageById(
              message.id,
              (prev) => ({ ...prev, resumable: status.resumable }),
              true,
            );
          }
          // Clear stale retry count — this run is authoritatively done.
          transientFailedRetriesRef.current.delete(runId);
          genericDisconnectRetriesRef.current.delete(runId);
          genericDisconnectBackoffUntilRef.current.delete(runId);
          completedReattachRunsRef.current.add(runId);
          continue;
        }
        if (spuriouslyFailedPending && status.status === 'canceled') {
          setError(null);
          // Route through the shared invariant helper: `status` is already
          // terminal here, so this resolves to `status.updatedAt` directly.
          const endedAt = await resolveTerminalEndedAt(runId, status);
          updateMessageById(
            message.id,
            (prev) => ({
              ...prev,
              runStatus: 'canceled',
              endedAt,
              ...(status.resumable !== undefined ? { resumable: status.resumable } : {}),
            }),
            true,
          );
          transientFailedRetriesRef.current.delete(runId);
          genericDisconnectRetriesRef.current.delete(runId);
          genericDisconnectBackoffUntilRef.current.delete(runId);
          completedReattachRunsRef.current.add(runId);
          continue;
        }
        if (spuriouslyFailedPending && status.status === 'succeeded') {
          setError(null);
          transientFailedRetriesRef.current.delete(runId);
          genericDisconnectRetriesRef.current.delete(runId);
          genericDisconnectBackoffUntilRef.current.delete(runId);
        }
        if (!(spuriouslyFailedPending && status.status === 'succeeded')) {
          updateMessageById(
            message.id,
            (prev) => ({
              ...prev,
              runStatus: status.status,
              ...(status.resumable !== undefined ? { resumable: status.resumable } : {}),
            }),
            true,
          );
        }

        if (shouldReplayTerminalRunMessage(message)) {
          const replayedContent = textContentFromAgentEvents(message.events);
          if (replayedContent.trim().length > 0) {
            const parser = createArtifactParser();
            let parsedArtifact: Artifact | null = null;
            let liveHtml = '';
            for (const ev of [...parser.feed(replayedContent), ...parser.flush()]) {
              if (ev.type === 'artifact:start') {
                liveHtml = '';
                parsedArtifact = {
                  identifier: ev.identifier,
                  artifactType: ev.artifactType,
                  title: ev.title,
                  html: '',
                };
                setArtifact(parsedArtifact);
              } else if (ev.type === 'artifact:chunk') {
                liveHtml += ev.delta;
                parsedArtifact = artifactWithHtml(parsedArtifact, ev.identifier, liveHtml);
                setArtifact((prev) =>
                  artifactWithHtml(prev, ev.identifier, liveHtml),
                );
              } else if (ev.type === 'artifact:end') {
                parsedArtifact = artifactWithHtml(parsedArtifact, ev.identifier, ev.fullContent);
                setArtifact((prev) =>
                  prev ? artifactWithHtml(prev, ev.identifier, ev.fullContent) : null,
                );
              }
            }

            // Legacy rows persisted before `endedAt` existed reach this
            // branch with no stored `endedAt` at all — fall back to the
            // daemon's authoritative terminal timestamp (already fetched
            // above as `status`) rather than the reload's wall-clock time.
            const legacyReplayEndedAt = await resolveTerminalEndedAt(runId, status);
            updateMessageById(
              message.id,
              (prev) => ({
                ...prev,
                content: replayedContent,
                runStatus: resolveSucceededRunStatus(prev.runStatus),
                endedAt: prev.endedAt ?? legacyReplayEndedAt,
              }),
              true,
              { telemetryFinalized: true },
            );

            let nextFiles = await refreshProjectFiles();
            const beforeFileNames = new Set(
              message.preTurnFileNames ?? nextFiles.map((f) => f.name),
            );
            const artifactToPersist = parsedArtifact?.html
              ? parsedArtifact
              : artifactFromStandaloneHtml(replayedContent);
            let recoveredExistingArtifact: ProjectFile | null = null;
            if (artifactToPersist?.html) {
              const runStartedAt = status.createdAt || message.startedAt || message.createdAt;
              recoveredExistingArtifact = findExistingArtifactProjectFile(
                artifactToPersist,
                nextFiles,
                { minMtime: runStartedAt },
              );
              if (recoveredExistingArtifact) {
                savedArtifactRef.current = recoveredExistingArtifact.name;
                requestOpenFile(recoveredExistingArtifact.name);
              } else {
                savedArtifactRef.current = null;
                await persistArtifact(
                  artifactToPersist,
                  nextFiles,
                  replayedContent,
                  { pointerMinMtime: runStartedAt },
                );
                nextFiles = await refreshProjectFiles();
              }
            }
            const diff = computeProducedFiles(
              beforeFileNames,
              nextFiles,
              message.preTurnFileSnapshot,
            ) ?? [];
            const produced = mergeRecoveredArtifact(diff, recoveredExistingArtifact);
            const producedArtifactToOpen = selectAutoOpenProducedArtifact(produced);
            if (producedArtifactToOpen) requestOpenFile(producedArtifactToOpen);
            if (produced.length > 0) {
              updateMessageById(
                message.id,
                (prev) => ({ ...prev, producedFiles: produced }),
                true,
                { telemetryFinalized: true },
              );
            }
            // Clear stale retry count for successfully recovered run.
            transientFailedRetriesRef.current.delete(runId);
            genericDisconnectRetriesRef.current.delete(runId);
            completedReattachRunsRef.current.add(runId);
            onProjectsRefresh();
            continue;
          }
        }

        const controller = new AbortController();
        const cancelController = new AbortController();
        reattachControllersRef.current.set(runId, controller);
        reattachCancelControllersRef.current.set(runId, cancelController);
        if (!isTerminalRunStatus(status.status)) {
          abortRef.current = controller;
          cancelRef.current = cancelController;
          markStreamingConversation(reattachConversationId);
        }
        // Only blank content/events/producedFiles when the daemon confirms the run
        // is still recoverable (queued/running/succeeded).  A genuinely failed run
        // already carries diagnostic information in `events`; clearing it before
        // re-running the reattach path would erase the error context and loop the
        // message through reattach even when the daemon still reports `failed`.
        const daemonStatusIsRecoverable =
          status.status === 'queued' ||
          status.status === 'running' ||
          status.status === 'succeeded';
        if (needsFullReplay && daemonStatusIsRecoverable) {
          updateMessageById(
            message.id,
            // Clear endedAt only for spuriously-failed pending messages so the
            // replay finalizers stamp Date.now() on real completion instead of
            // preserving the SSE-disconnect timestamp that onError set when the
            // browser-side reconnect loop gave up.  Already-succeeded rows
            // reaching needsFullReplay via shouldReplayTerminalRunMessage must
            // keep their original terminal timestamp; resetting it here causes
            // prev.endedAt ?? Date.now() to re-stamp to reload time and drifts
            // persisted run durations forward.
            (prev) => ({ ...prev, content: '', events: [], producedFiles: undefined, ...(spuriouslyFailedPending ? { endedAt: undefined } : {}) }),
          );
          // When the failed-message recovery moves back to running/succeeded,
          // clear any stale "daemon stream disconnected" error banner that the
          // original onError path may have set, so the chat does not show a
          // stale error after the reattach succeeds.
          setError(null);
        }

        let persistTimer: ReturnType<typeof setTimeout> | null = null;
        const persistSoon = () => {
          if (persistTimer) return;
          persistTimer = scheduleProjectTimeout(() => {
            persistTimer = null;
            persistMessageById(message.id);
          }, 500);
        };
        const persistNow = (options?: SaveMessageOptions) => {
          if (persistTimer) {
            clearProjectTimeout(persistTimer);
            persistTimer = null;
          }
          textBuffer.flush();
          persistMessageById(message.id, options);
        };
        const parser = createArtifactParser();
        let parsedArtifact: Artifact | null = null;
        let liveHtml = '';
        let replayedContent = needsFullReplay ? '' : message.content;
        let replayedEvents: AgentEvent[] = needsFullReplay ? [] : [...(message.events ?? [])];
        let latestReattachRunStatus: ChatMessage['runStatus'] = status.status;
        const applyContentDelta = (delta: string) => {
          for (const ev of parser.feed(delta)) {
            if (ev.type === 'artifact:start') {
              liveHtml = '';
              parsedArtifact = {
                identifier: ev.identifier,
                artifactType: ev.artifactType,
                title: ev.title,
                html: '',
              };
              setArtifact(parsedArtifact);
            } else if (ev.type === 'artifact:chunk') {
              liveHtml += ev.delta;
              parsedArtifact = parsedArtifact
                ? { ...parsedArtifact, html: liveHtml }
                : {
                    identifier: ev.identifier,
                    title: '',
                    html: liveHtml,
                  };
              setArtifact((prev) =>
                prev
                  ? { ...prev, html: liveHtml }
                  : {
                      identifier: ev.identifier,
                      title: '',
                      html: liveHtml,
                    },
              );
            } else if (ev.type === 'artifact:end') {
              parsedArtifact = parsedArtifact
                ? { ...parsedArtifact, html: ev.fullContent }
                : {
                    identifier: ev.identifier,
                    title: '',
                    html: ev.fullContent,
                  };
              setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
            }
          }
        };
        if (!needsFullReplay && message.content) {
          applyContentDelta(message.content);
        }
        const textBuffer = createBufferedTextUpdates({
          updateMessage: (updater) => updateMessageById(message.id, updater),
          persistSoon,
          flushAndPersistNow: () => persistNow({ keepalive: true }),
          onContentDelta: applyContentDelta,
        });
        reattachTextBuffersRef.current.add(textBuffer);
        const unregisterTextBuffer = () => {
          reattachTextBuffersRef.current.delete(textBuffer);
        };

        void reattachDaemonRun({
          runId,
          signal: controller.signal,
          cancelSignal: cancelController.signal,
          initialLastEventId: needsFullReplay ? null : message.lastRunEventId ?? null,
          handlers: {
            onDelta: (delta) => {
              // First payload from the resumed stream is real recovery — the daemon is
              // sending data, not just answering REST status probes.  Reset the
              // transient retry budgets so a future disconnect starts from zero, but
              // only on genuine stream progress (not on a status fetch or queued→running
              // transition). Terminal replay recovery is the exception: if a
              // replay-only reconnect delivers partial output and then disconnects
              // again, we must preserve the generic-disconnect retry budget long
              // enough to status-probe and force a clean full replay instead of
              // persisting that truncated transcript.
              transientFailedRetriesRef.current.delete(runId);
              if (!(replayingTerminalRun && !(message.producedFiles?.length))) {
                genericDisconnectRetriesRef.current.delete(runId);
              }
              genericDisconnectBackoffUntilRef.current.delete(runId);
              replayedContent += delta;
              textBuffer.appendContent(delta);
            },
            onAgentEvent: (ev) => {
              transientFailedRetriesRef.current.delete(runId);
              if (!(replayingTerminalRun && !(message.producedFiles?.length))) {
                genericDisconnectRetriesRef.current.delete(runId);
              }
              genericDisconnectBackoffUntilRef.current.delete(runId);
              replayedEvents = [...replayedEvents, ev];
              textBuffer.appendEvent(ev);
            },
            onDone: async () => {
              // A reattached run interrupted by a "send now" still receives a
              // late onDone from the daemon. Decide ownership first, then bail
              // BEFORE any current-run side effect (committing buffered text,
              // repainting the artifact preview via setArtifact, re-finalizing
              // the message) — only release this run's bookkeeping. See the
              // streamViaDaemon onDone for the ownership rationale.
              const runMayFinalize =
                !supersededRunsRef.current.has(controller);
              if (runMayFinalize) textBuffer.flush();
              textBuffer.cancel();
              unregisterTextBuffer();
              // Clear stale retry count for successfully recovered run.
              transientFailedRetriesRef.current.delete(runId);
              genericDisconnectRetriesRef.current.delete(runId);
              completedReattachRunsRef.current.add(runId);
              reattachControllersRef.current.delete(runId);
              reattachCancelControllersRef.current.delete(runId);
              clearCurrentRunStreamingMarker(reattachConversationId, controller, cancelController);
              // Clear any stale error banner set by the original onError path
              // (e.g. "daemon stream disconnected") so the chat does not show it
              // after the spuriously-failed message reattaches and succeeds.
              if (runMayFinalize && spuriouslyFailedPending) setError(null);
              if (!runMayFinalize) return;
              for (const ev of parser.flush()) {
                if (ev.type === 'artifact:end') {
                  parsedArtifact = parsedArtifact
                    ? { ...parsedArtifact, html: ev.fullContent }
                    : {
                        identifier: ev.identifier,
                        title: '',
                        html: ev.fullContent,
                      };
                  setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
                }
              }
              // `status` is the pre-reattach snapshot fetched before
              // reattachDaemonRun started — on a reload-while-running it is
              // still 'running' (a near-run-start heartbeat), not the
              // daemon's terminal time. Re-probe now, at the end of
              // recovery, for the authoritative terminal `updatedAt`.
              const endedAt = await resolveTerminalEndedAt(runId, status);
              updateMessageById(
                message.id,
                (prev) => ({
                  ...prev,
                  content: needsFullReplay ? replayedContent : prev.content,
                  events: needsFullReplay ? replayedEvents : prev.events,
                  runStatus:
                    latestReattachRunStatus === 'canceled' ? 'canceled' : 'succeeded',
                  endedAt,
                }),
                true,
                latestReattachRunStatus === 'canceled'
                  ? { telemetryFinalized: true }
                  : undefined,
              );
              if (latestReattachRunStatus === 'canceled') return;
              void (async () => {
                const preTurn = message.preTurnFileNames;
                let nextFiles = await refreshProjectFiles();
                // Use the turn-start snapshot when available so reload
                // recovers files produced before the artifact write too;
                // fall back to the current list for legacy messages.
                const beforeFileNames = new Set(preTurn ?? nextFiles.map((f) => f.name));
                let recoveredExistingArtifact: ProjectFile | null = null;
                const artifactToPersist = parsedArtifact?.html
                  ? parsedArtifact
                  : artifactFromStandaloneHtml(replayedContent);
                if (artifactToPersist?.html) {
                  const producedBeforeFallback = computeProducedFiles(
                    beforeFileNames,
                    nextFiles,
                    message.preTurnFileSnapshot,
                  ) ?? [];
                  const runStartedAt = status.createdAt || message.startedAt || message.createdAt;
                  recoveredExistingArtifact = findExistingArtifactProjectFile(
                    artifactToPersist,
                    nextFiles,
                    { minMtime: runStartedAt },
                  ) ?? await findSameTurnHtmlWriteForRecoveredArtifact({
                    artifactHtml: resolvePersistedArtifactHtml({
                      artifactHtml: artifactToPersist.html,
                      identifier: artifactToPersist.identifier,
                      sourceText: replayedContent,
                    }),
                    producedFiles: producedBeforeFallback,
                    readProjectHtml,
                  });
                  if (recoveredExistingArtifact) {
                    savedArtifactRef.current = recoveredExistingArtifact.name;
                    requestOpenFile(recoveredExistingArtifact.name);
                  } else {
                    savedArtifactRef.current = null;
                    await persistArtifact(
                      artifactToPersist,
                      nextFiles,
                      replayedContent,
                      { pointerMinMtime: runStartedAt },
                    );
                    nextFiles = await refreshProjectFiles();
                  }
                }
                const diff = computeProducedFiles(
                  beforeFileNames,
                  nextFiles,
                  message.preTurnFileSnapshot,
                ) ?? [];
                const produced = mergeRecoveredArtifact(diff, recoveredExistingArtifact);
                const traceObjectFiles = mergeRecoveredTraceObjectFile(
                  computeTraceObjectFiles(
                    beforeFileNames,
                    nextFiles,
                    extractTouchedFilePathsFromEvents(
                      needsFullReplay ? replayedEvents : message.events,
                    ),
                  ) ?? [],
                  recoveredExistingArtifact,
                );
                const producedArtifactToOpen = selectAutoOpenProducedArtifact(produced);
                if (producedArtifactToOpen) requestOpenFile(producedArtifactToOpen);
                updateMessageById(
                  message.id,
                  (prev) => ({ ...prev, producedFiles: produced, traceObjectFiles }),
                  true,
                  { telemetryFinalized: true },
                );
              })();
              onProjectsRefresh();
            },
            onError: async (err) => {
              const errorCode = (err as Error & { code?: string }).code;
              const resumable = (err as Error & { resumable?: boolean }).resumable === true;
              let skipFinalPersistNow = false;
              let retryFullReplayAfterCleanup = false;
              const genericDisconnect = isGenericDaemonDisconnect(err);
              // A superseded reattached run must not paint a global failure
              // banner or re-finalize its message over the replacement run.
              const runMayFinalize =
                !supersededRunsRef.current.has(controller);
              textBuffer.flush();
              textBuffer.cancel();
              unregisterTextBuffer();
              if (runMayFinalize) {
                setError(err.message);
                appendAssistantErrorEvent(message.id, err.message, errorCode);
                updateMessageById(
                  message.id,
                  (prev) => ({
                    ...prev,
                    runStatus: 'failed',
                    endedAt: prev.endedAt ?? Date.now(),
                    resumable,
                  }),
                  true,
                );
                if (!genericDisconnect && artifactFromRecoverableSourceText(replayedContent)) {
                  void (async () => {
                    if (recoveredArtifactMessagesRef.current.has(message.id)) return;
                    const latestRunStatus = await fetchChatRunStatus(runId).catch(() => null);
                    const artifactToPersist = parsedArtifact?.html
                      ? parsedArtifact
                      : artifactFromStandaloneHtml(replayedContent);
                    if (!artifactToPersist?.html) return;
                    let nextFiles = await refreshProjectFiles();
                    const beforeFileNames = new Set(
                      message.preTurnFileNames ?? nextFiles.map((f) => f.name),
                    );
                    const runStartedAt =
                      latestRunStatus?.createdAt || message.startedAt || message.createdAt;
                    let recoveredExistingArtifact = findExistingArtifactProjectFile(
                      artifactToPersist,
                      nextFiles,
                      { minMtime: runStartedAt },
                    );
                    if (recoveredExistingArtifact) {
                      savedArtifactRef.current = recoveredExistingArtifact.name;
                      requestOpenFile(recoveredExistingArtifact.name);
                    } else {
                      savedArtifactRef.current = null;
                      await persistArtifact(
                        artifactToPersist,
                        nextFiles,
                        replayedContent,
                        { pointerMinMtime: runStartedAt },
                      );
                      nextFiles = await refreshProjectFiles();
                      recoveredExistingArtifact = findExistingArtifactProjectFile(
                        artifactToPersist,
                        nextFiles,
                        { minMtime: runStartedAt },
                      );
                    }
                    const diff = computeProducedFiles(
                      beforeFileNames,
                      nextFiles,
                      message.preTurnFileSnapshot,
                    ) ?? [];
                    const produced = mergeRecoveredArtifact(diff, recoveredExistingArtifact);
                    if (produced.length > 0) {
                      recoveredArtifactMessagesRef.current.add(message.id);
                    }
                    const producedArtifactToOpen = selectAutoOpenProducedArtifact(produced);
                    if (producedArtifactToOpen) requestOpenFile(producedArtifactToOpen);
                    if (latestRunStatus?.status === 'succeeded') setError(null);
                    // Unlike the recoverArtifacts sibling below, this row's
                    // endedAt was already stamped synchronously above (~4041)
                    // at disconnect time — `prev.endedAt` is never null here,
                    // so a `prev.endedAt ?? ...` fallback would never fire.
                    // Overwrite it, but ONLY when the daemon just confirmed
                    // succeeded (the same condition gating the runStatus
                    // upgrade below) — `latestRunStatus` is already the fresh,
                    // confirmed-terminal probe from above, so its `updatedAt`
                    // is authoritative directly, with no extra re-probe.
                    // Otherwise this row is still not terminal and must keep
                    // its existing endedAt.
                    updateMessageById(
                      message.id,
                      (prev) => ({
                        ...prev,
                        content: replayedContent,
                        producedFiles: produced.length > 0 ? produced : prev.producedFiles,
                        runStatus: latestRunStatus?.status === 'succeeded' ? 'succeeded' : prev.runStatus,
                        endedAt:
                          latestRunStatus?.status === 'succeeded'
                            ? latestRunStatus.updatedAt
                            : prev.endedAt,
                      }),
                      true,
                      { telemetryFinalized: true },
                    );
                    onProjectsRefresh();
                  })();
                }
              }
              // Clear stale retry count for the run.  Generic disconnects
              // (browser SSE reconnect-budget exhaustion) are NOT authoritative
              // terminal failures — the daemon may still report the run as
              // queued/running/succeeded on the next attachRecoverableRuns tick.
              // Only seal completedReattachRunsRef for real terminal errors so
              // generic disconnects stay eligible for re-query.
              // Generic disconnects share the transient-retry budget with the
              // null-status path. Even once the generic-disconnect retry budget
              // is exhausted, we must not seal on a transient status-probe miss:
              // fetchChatRunStatus() returns null for any network/non-OK failure,
              // not only when the daemon has truly forgotten the run. Treat
              // null the same as an active retryable state and keep the row
              // eligible for future refresh/reattach. Only authoritative
              // terminal statuses seal completedReattachRunsRef.
              if (genericDisconnect) {
                const attempts = (genericDisconnectRetriesRef.current.get(runId) ?? 0) + 1;
                if (attempts >= MAX_TRANSIENT_RETRIES) {
                  const backoffUntil = Date.now() + 3000;
                  genericDisconnectRetriesRef.current.set(runId, attempts);
                  genericDisconnectBackoffUntilRef.current.set(runId, backoffUntil);
                  // consumeDaemonRun invokes async error handlers without
                  // awaiting them. Clear the streaming marker before the status
                  // probe yields so the surrounding finally block cannot clear
                  // the refs first and strand the conversation in streaming.
                  clearCurrentRunStreamingMarker(
                    reattachConversationId,
                    controller,
                    cancelController,
                  );
                  const backoffTimer = scheduleProjectTimeout(() => {
                    const currentBackoffUntil =
                      genericDisconnectBackoffUntilRef.current.get(runId) ?? 0;
                    if (currentBackoffUntil <= Date.now()) {
                      genericDisconnectBackoffUntilRef.current.delete(runId);
                    }
                    setRecoveryTick((t) => t + 1);
                  }, 3000);
                  const latestRunStatus = await fetchChatRunStatus(runId).catch(() => null);
                  if (!latestRunStatus || isActiveRunStatus(latestRunStatus.status)) {
                  } else if (latestRunStatus.status === 'succeeded') {
                    clearProjectTimeout(backoffTimer);
                    setError(null);
                    // If the resumed stream already replayed some content/events
                    // before disconnecting again, finalizing this row as
                    // succeeded would persist a truncated transcript. Clear the
                    // partial local replay and trigger one immediate full replay
                    // from the daemon's terminal event log instead.
                    if (
                      needsFullReplay
                      && !(message.producedFiles?.length)
                      && (replayedContent.trim().length > 0 || replayedEvents.length > 0)
                    ) {
                      updateMessageById(
                        message.id,
                        (prev) => ({
                          ...removeErrorStatusEvent(prev, err.message, errorCode),
                          content: '',
                          events: [],
                          runStatus: 'succeeded',
                          // Adopt the daemon's authoritative terminal timestamp rather
                          // than the stale disconnect-time stamp taken when the generic
                          // disconnect first fired.
                          endedAt: latestRunStatus.updatedAt,
                          ...(latestRunStatus.resumable !== undefined
                            ? { resumable: latestRunStatus.resumable }
                            : {}),
                        }),
                        true,
                        { telemetryFinalized: true },
                      );
                      retryFullReplayAfterCleanup = true;
                    } else {
                      updateMessageById(
                        message.id,
                        (prev) => ({
                          ...removeErrorStatusEvent(prev, err.message, errorCode),
                          runStatus: 'succeeded',
                          endedAt: latestRunStatus.updatedAt,
                          ...(latestRunStatus.resumable !== undefined
                            ? { resumable: latestRunStatus.resumable }
                            : {}),
                        }),
                        true,
                        { telemetryFinalized: true },
                      );
                    }
                    skipFinalPersistNow = true;
                    genericDisconnectRetriesRef.current.delete(runId);
                    genericDisconnectBackoffUntilRef.current.delete(runId);
                  } else {
                    clearProjectTimeout(backoffTimer);
                    if (latestRunStatus.status === 'canceled') setError(null);
                    updateMessageById(
                      message.id,
                      (prev) => ({
                        ...prev,
                        runStatus: latestRunStatus.status,
                        endedAt: latestRunStatus.updatedAt,
                        ...(latestRunStatus.resumable !== undefined
                          ? { resumable: latestRunStatus.resumable }
                          : {}),
                      }),
                      true,
                      { telemetryFinalized: true },
                    );
                    skipFinalPersistNow = true;
                    completedReattachRunsRef.current.add(runId);
                    genericDisconnectRetriesRef.current.delete(runId);
                    genericDisconnectBackoffUntilRef.current.delete(runId);
                  }
                } else {
                  genericDisconnectRetriesRef.current.set(runId, attempts);
                }
              } else {
                transientFailedRetriesRef.current.delete(runId);
                genericDisconnectRetriesRef.current.delete(runId);
                genericDisconnectBackoffUntilRef.current.delete(runId);
                completedReattachRunsRef.current.add(runId);
              }
              reattachControllersRef.current.delete(runId);
              reattachCancelControllersRef.current.delete(runId);
              clearCurrentRunStreamingMarker(reattachConversationId, controller, cancelController);
              if (!skipFinalPersistNow) persistNow({ telemetryFinalized: true });
              if (retryFullReplayAfterCleanup) setRecoveryTick((t) => t + 1);
              scheduleConversationMessageRefresh(reattachConversationId);
            },
          },
          onRunStatus: (runStatus) => {
            textBuffer.flush();
            updateMessageById(
              message.id,
              (prev) => ({
                ...prev,
                runStatus,
                endedAt: isTerminalRunStatus(runStatus) ? prev.endedAt ?? Date.now() : prev.endedAt,
              }),
              true,
            );
            latestReattachRunStatus = runStatus;
            if (runStatus === 'canceled') {
              textBuffer.cancel();
              unregisterTextBuffer();
              // Clear stale retry count for canceled run.
              transientFailedRetriesRef.current.delete(runId);
              genericDisconnectRetriesRef.current.delete(runId);
              genericDisconnectBackoffUntilRef.current.delete(runId);
              completedReattachRunsRef.current.add(runId);
              reattachControllersRef.current.delete(runId);
              reattachCancelControllersRef.current.delete(runId);
              clearCurrentRunStreamingMarker(reattachConversationId, controller, cancelController);
            }
            if (isTerminalRunStatus(runStatus)) {
              scheduleConversationMessageRefresh(reattachConversationId);
            }
          },
          onRunEventId: (lastRunEventId) => {
            textBuffer.flush();
            updateMessageById(message.id, (prev) => ({ ...prev, lastRunEventId }));
            persistSoon();
          },
        })
          .catch((err) => {
            // Skip AbortError (expected on interrupt) and any error from a run
            // that was tagged superseded by a send-now interrupt — it must not
            // surface a global failure over the replacement.
            const runMayFinalize =
              !supersededRunsRef.current.has(controller);
            if ((err as Error).name !== 'AbortError' && runMayFinalize) {
              const msg = err instanceof Error ? err.message : String(err);
              setError(msg);
              appendAssistantErrorEvent(message.id, msg);
              updateMessageById(
                message.id,
                (prev) => ({ ...prev, runStatus: 'failed', endedAt: prev.endedAt ?? Date.now() }),
                true,
                { telemetryFinalized: true },
              );
            }
          })
          .finally(() => {
            textBuffer.flush();
            textBuffer.cancel();
            unregisterTextBuffer();
            if (persistTimer) clearProjectTimeout(persistTimer);
            reattachControllersRef.current.delete(runId);
            reattachCancelControllersRef.current.delete(runId);
            clearActiveRunRefs(reattachConversationId, controller, cancelController);
          });
      }
    };

    void attachRecoverableRuns();
    return () => {
      cancelled = true;
      // Clear any pending transient-retry timers so they don't fire after
      // unmount or after the effect re-enters for a different conversation.
      for (const handle of transientRetryTimersRef.current) {
        clearTimeout(handle);
      }
      transientRetryTimersRef.current = new Set();
    };
  }, [
    daemonLive,
    activeConversationId,
    currentProject.metadata,
    streaming,
    messages,
    project.id,
    updateMessageById,
    persistMessageById,
    markStreamingConversation,
    clearStreamingMarker,
    clearActiveRunRefs,
    clearCurrentRunStreamingMarker,
    clearProjectTimeout,
    refreshProjectFiles,
    readProjectHtml,
    persistArtifact,
    requestOpenFile,
    onProjectsRefresh,
    scheduleProjectTimeout,
    scheduleConversationMessageRefresh,
    recoveryTick,
  ]);

  useEffect(() => {
    if (!daemonLive || !activeConversationId) return;
    if (!currentConversationHasRecoverableArtifact) return;
    let cancelled = false;
    let recovering = false;

    const recoverArtifacts = async () => {
      if (recovering) return;
      recovering = true;
      try {
        const serverMessages = await readConversationPage(activeConversationId).then(page => page.messages).catch(() => []);
        if (cancelled) return;
        const recoveryMessages = serverMessages.length > 0 ? serverMessages : messagesRef.current;
        for (const message of recoveryMessages) {
          if (cancelled) return;
          if (!hasRecoverableArtifactMessage(message)) continue;
          if (recoveredArtifactMessagesRef.current.has(message.id)) continue;
          const runId = message.runId;
          if (!runId) continue;

          const sourceText = message.content.trim().length > 0
            ? message.content
            : textContentFromAgentEvents(message.events);

          const parser = createArtifactParser();
          let parsedArtifact: Artifact | null = null;
          let liveHtml = '';
          for (const ev of [...parser.feed(sourceText), ...parser.flush()]) {
            if (ev.type === 'artifact:start') {
              liveHtml = '';
              parsedArtifact = {
                identifier: ev.identifier,
                artifactType: ev.artifactType,
                title: ev.title,
                html: '',
              };
              setArtifact(parsedArtifact);
            } else if (ev.type === 'artifact:chunk') {
              liveHtml += ev.delta;
              parsedArtifact = artifactWithHtml(parsedArtifact, ev.identifier, liveHtml);
              setArtifact((prev) =>
                artifactWithHtml(prev, ev.identifier, liveHtml),
              );
            } else if (ev.type === 'artifact:end') {
              parsedArtifact = artifactWithHtml(parsedArtifact, ev.identifier, ev.fullContent);
              setArtifact((prev) =>
                prev ? artifactWithHtml(prev, ev.identifier, ev.fullContent) : null,
              );
            }
          }

          const artifactToPersist = parsedArtifact?.html
            ? parsedArtifact
            : artifactFromStandaloneHtml(sourceText);
          if (!artifactToPersist?.html) continue;
          const latestRunStatus = await fetchChatRunStatus(runId).catch(() => null);
          let nextFiles = await refreshProjectFiles();
          if (cancelled) return;
          const beforeFileNames = new Set(
            message.preTurnFileNames ?? nextFiles.map((f) => f.name),
          );
          const runStartedAt =
            latestRunStatus?.createdAt || message.startedAt || message.createdAt;
          let recoveredExistingArtifact = findExistingArtifactProjectFile(
            artifactToPersist,
            nextFiles,
            { minMtime: runStartedAt },
          );
          if (recoveredExistingArtifact) {
            savedArtifactRef.current = recoveredExistingArtifact.name;
            requestOpenFile(recoveredExistingArtifact.name);
          } else {
            savedArtifactRef.current = null;
            await persistArtifact(
              artifactToPersist,
              nextFiles,
              sourceText,
              { pointerMinMtime: runStartedAt },
            );
            nextFiles = await refreshProjectFiles();
            recoveredExistingArtifact = findExistingArtifactProjectFile(
              artifactToPersist,
              nextFiles,
              { minMtime: runStartedAt },
            );
          }
          if (cancelled) return;
          const diff = computeProducedFiles(
            beforeFileNames,
            nextFiles,
            message.preTurnFileSnapshot,
          ) ?? [];
          const produced = mergeRecoveredArtifact(diff, recoveredExistingArtifact);
          if (produced.length === 0) {
            continue;
          }
          recoveredArtifactMessagesRef.current.add(message.id);
          const producedArtifactToOpen = selectAutoOpenProducedArtifact(produced);
          if (producedArtifactToOpen) requestOpenFile(producedArtifactToOpen);
          // This message's persisted runStatus was already terminal (a
          // precondition of hasRecoverableArtifactMessage); when it has no
          // stored endedAt, fall back to the daemon's authoritative terminal
          // timestamp (already fetched above as latestRunStatus) instead of
          // this reload/poll's wall-clock time.
          const recoveredArtifactEndedAt = await resolveTerminalEndedAt(runId, latestRunStatus);
          updateMessageById(
            message.id,
            (prev) => ({
              ...prev,
              content: sourceText,
              producedFiles: produced,
              runStatus:
                latestRunStatus?.status === 'succeeded'
                  ? 'succeeded'
                  : prev.runStatus,
              endedAt: prev.endedAt ?? recoveredArtifactEndedAt,
            }),
            true,
            { telemetryFinalized: true },
          );
          scheduleConversationMessageRefresh(activeConversationId);
          onProjectsRefresh();
        }
      } finally {
        recovering = false;
      }
    };

    void recoverArtifacts();
    const interval = window.setInterval(() => {
      void recoverArtifacts();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    daemonLive,
    activeConversationId,
    project.id,
    currentConversationHasRecoverableArtifact,
    readConversationPage,
    artifactFromStandaloneHtml,
    refreshProjectFiles,
    persistArtifact,
    requestOpenFile,
    updateMessageById,
    scheduleConversationMessageRefresh,
    onProjectsRefresh,
  ]);

  const commitQueuedChatSends = useCallback((next: QueuedChatSend[]) => {
    queuedChatSendsRef.current = next;
    setQueuedChatSends(next);
    saveQueuedChatSends(project.id, next);
  }, [project.id]);

  const enqueueChatSend = useCallback((item: QueuedChatSend) => {
    const next = [...queuedChatSendsRef.current, item];
    commitQueuedChatSends(next);
  }, [commitQueuedChatSends]);

  const removeQueuedChatSend = useCallback((id: string) => {
    const next = queuedChatSendsRef.current.filter((item) => item.id !== id);
    commitQueuedChatSends(next);
  }, [commitQueuedChatSends]);

  const updateQueuedChatSend = useCallback((id: string, update: QueuedChatSendUpdate) => {
    const next = queuedChatSendsRef.current.map((item) => {
      if (item.id !== id) return item;
      const meta = stripQueueOnlyFromMeta(update.meta);
      const updated: QueuedChatSend = {
        ...item,
        prompt: update.prompt,
        attachments: update.attachments,
        commentAttachments: update.commentAttachments,
      };
      if (meta === undefined) delete updated.meta;
      else updated.meta = meta;
      return updated;
    });
    commitQueuedChatSends(next);
  }, [commitQueuedChatSends]);

  const prioritizeQueuedChatSend = useCallback((id: string) => {
    const item = queuedChatSendsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    const next = [item, ...queuedChatSendsRef.current.filter((candidate) => candidate.id !== id)];
    commitQueuedChatSends(next);
  }, [commitQueuedChatSends]);

  const reorderCurrentConversationQueuedChatSends = useCallback((orderedIds: string[]) => {
    if (!activeConversationId || orderedIds.length === 0) return;
    const order = new Map(orderedIds.map((id, index) => [id, index]));
    const current = queuedChatSendsRef.current;
    const originalConversationItems = current.filter(
      (item) => item.conversationId === activeConversationId,
    );
    const sortedConversationItems = [...originalConversationItems].sort((a, b) => {
      const aOrder = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
    if (
      sortedConversationItems.every((item, index) => item.id === originalConversationItems[index]?.id)
    ) {
      return;
    }
    let cursor = 0;
    const next = current.map((item) => {
      if (item.conversationId !== activeConversationId) return item;
      return sortedConversationItems[cursor++] ?? item;
    });
    commitQueuedChatSends(next);
  }, [activeConversationId, commitQueuedChatSends]);

  const queueChatSendForCurrentConversation = useCallback((input: {
    attachments: ChatAttachment[];
    commentAttachments: ChatCommentAttachment[];
    conversationId: string;
    meta?: ProjectChatSendMeta;
    prompt: string;
  }) => {
    const queuedMeta = stripQueueOnlyFromMeta(input.meta);
    enqueueChatSend({
      id: randomUUID(),
      conversationId: input.conversationId,
      prompt: input.prompt,
      attachments: input.attachments,
      commentAttachments: input.commentAttachments,
      ...(queuedMeta === undefined ? {} : { meta: queuedMeta }),
      createdAt: Date.now(),
    });
    if (input.commentAttachments.length > 0) {
      const reservedCommentIds = new Set(
        input.commentAttachments
          .filter((attachment) => attachment.source !== 'board-batch')
          .map((attachment) => attachment.id),
      );
      setAttachedComments((current) =>
        current.filter((comment) => !reservedCommentIds.has(comment.id)),
      );
      if (reservedCommentIds.size > 0) {
        setPreviewComments((current) =>
          current.map((comment) =>
            reservedCommentIds.has(comment.id)
              ? { ...comment, status: 'applying' }
              : comment,
          ),
        );
        void Promise.all(
          Array.from(reservedCommentIds, (commentId) =>
            patchPreviewCommentStatus(project.id, input.conversationId, commentId, 'applying'),
          ),
        ).catch(() => {});
      }
    }
  }, [enqueueChatSend, project.id]);

  // MatOS project-as-department roster. The invited members live on the
  // project's own metadata (a subset of the full role catalog); the sidebar
  // lists these instead of every role, and the group chat is seeded from
  // them. Declared ahead of handleSend, which reads the catalog to build the
  // group transcript context.
  const roleCatalog = useMemberRoles();
  const projectMemberRefs = useMemo<string[]>(
    () => projectRoleRefsFromMetadata(currentProject.metadata),
    [currentProject.metadata],
  );
  // Per-member custom names (`metadata.memberNames`). Passed to the sidebar,
  // group @-bar, group-chat roster header, and auto-relay parsing so an
  // aliased member shows and dispatches by its project name everywhere.
  const projectMemberNames = useMemo<Record<string, string>>(() => {
    const raw = currentProject.metadata?.memberNames;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [ref, value] of Object.entries(raw)) {
      if (typeof ref === 'string' && ref.startsWith('role:') && typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) out[ref] = trimmed;
      }
    }
    return out;
  }, [currentProject.metadata?.memberNames]);
  // Per-member responsibility notes (`metadata.memberBriefs`): the "who does
  // what" the user wrote in the new-project form. Injected into the group
  // roster header so each member knows its teammates' remits.
  const projectMemberBriefs = useMemo<Record<string, string>>(() => {
    const raw = currentProject.metadata?.memberBriefs;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [ref, value] of Object.entries(raw)) {
      if (typeof ref === 'string' && ref.startsWith('role:') && typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) out[ref] = trimmed;
      }
    }
    return out;
  }, [currentProject.metadata?.memberBriefs]);
  const [memberInviteOpen, setMemberInviteOpen] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [savingProjectAssets, setSavingProjectAssets] = useState(false);
  // MatOS group auto-relay: when a member's reply ends with "@NAME: <task>"
  // handoff lines, the DAEMON dispatches those members automatically (bounded
  // by GROUP_RELAY_MAX_HOPS per user turn). The @-bar toggle is therefore a
  // persisted per-conversation setting — the daemon reads it from the
  // conversation record at continuation time, so it holds across reloads and
  // for runs that finish after this tab is gone. Unset means enabled.
  const groupAutoRelay = useMemo(() => {
    const conversation = conversations.find((c) => c.id === activeConversationId);
    return conversation?.groupAutoRelay !== false;
  }, [conversations, activeConversationId]);
  const handleGroupAutoRelayChange = useCallback(
    (enabled: boolean) => {
      const conversationId = activeConversationId;
      if (!conversationId) return;
      setConversations((curr) =>
        curr.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, groupAutoRelay: enabled }
            : conversation,
        ),
      );
      void patchConversation(project.id, conversationId, { groupAutoRelay: enabled });
    },
    [activeConversationId, project.id],
  );
  // After a group member's run settles, its work is mirrored into the
  // member's DM by the daemon. If the user is currently reading that DM,
  // pull the fresh ledger rows in; the sidebar list is refreshed by the
  // caller. Reads refs (not state) because it fires from run callbacks.
  const refreshMemberDmViewIfActive = useCallback(
    (memberRef: string) => {
      const currentViewId = messagesConversationIdRef.current;
      if (!currentViewId) return;
      const viewConversation = conversationsRef.current.find(
        (conversation) => conversation.id === currentViewId,
      );
      if (!viewConversation) return;
      const isMemberDm =
        sameRoleRef(viewConversation.roleRef, memberRef) &&
        !(Array.isArray(viewConversation.memberRefs) && viewConversation.memberRefs.length > 1);
      if (isMemberDm) scheduleConversationMessageRefresh(currentViewId);
    },
    [scheduleConversationMessageRefresh],
  );

  // MatOS group chat: fan-out and auto-relay dispatch are daemon-owned (they
  // continue even when this tab closes mid-run). The web's job is only to
  // NOTICE the daemon's queued tasks and pull their stub/progress rows into
  // the open conversation. Polls the durable group-task ledger while any task
  // is queued/running, plus a few idle probes so a handoff the daemon parses
  // a moment after the finished turn is still picked up before the watcher
  // stops. One watcher per conversation at a time.
  const groupDispatchWatchTokens = useRef(new Map<string, number>());
  const watchGroupDispatch = useCallback((conversationId: string) => {
    const token = Date.now() + Math.random();
    groupDispatchWatchTokens.current.set(conversationId, token);
    let idleProbes = 0;
    const poll = async (attempt: number) => {
      if (groupDispatchWatchTokens.current.get(conversationId) !== token) return;
      let probe: GroupDispatchProbe = 'failed';
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(project.id)}/group-tasks?conversationId=${encodeURIComponent(conversationId)}`,
        );
        if (response.ok) {
          const payload = await response.json() as { tasks?: Array<{ status?: string }> };
          probe = (payload.tasks ?? []).some(
            (task) => task.status === 'queued' || task.status === 'running',
          )
            ? 'active'
            : 'idle';
        }
      } catch {
        probe = 'failed';
      }
      if (groupDispatchWatchTokens.current.get(conversationId) !== token) return;
      const step = nextGroupDispatchPollStep({ attempt, idleProbes, probe });
      if (step.kind === 'settle') {
        // Final settle refresh so the last task's terminal rows land.
        scheduleConversationMessageRefresh(conversationId);
        groupDispatchWatchTokens.current.delete(conversationId);
        return;
      }
      idleProbes = step.idleProbes;
      if (step.refresh) scheduleConversationMessageRefresh(conversationId);
      scheduleProjectTimeout(() => void poll(attempt + 1), 1_000);
    };
    scheduleProjectTimeout(() => void poll(0), 500);
  }, [
    project.id,
    scheduleConversationMessageRefresh,
    scheduleProjectTimeout,
  ]);
  // Opening (or reloading into) a group conversation picks up any daemon-side
  // dispatch chain already in flight — the chain no longer depends on the tab
  // that started it, so a fresh tab must look for work it didn't start. The
  // group-ness boolean (not the conversation list) keys the effect so routine
  // list refreshes don't spawn watcher after watcher.
  const activeConversationIsGroup = useMemo(() => {
    const conversation = conversations.find((c) => c.id === activeConversationId);
    return Array.isArray(conversation?.memberRefs) && conversation.memberRefs.length > 1;
  }, [conversations, activeConversationId]);
  useEffect(() => {
    if (!activeConversationId || !activeConversationIsGroup) return;
    watchGroupDispatch(activeConversationId);
  }, [activeConversationId, activeConversationIsGroup, watchGroupDispatch]);

  // Project-local provider-LLM override (web `/model`). Persisted on project
  // metadata like the role pick; sent to the daemon as `providerModel` and
  // reaches the CLI as `--model <id>`. Null = deployment default. Declared
  // before handleSend so the dependency array can reference it.
  const matosProviderModel =
    typeof currentProject.metadata?.matosProviderModel === 'string' &&
    currentProject.metadata.matosProviderModel
      ? currentProject.metadata.matosProviderModel
      : null;
  const projectAssetRefs = useMemo(() => {
    const raw = currentProject.metadata?.matosAssetRefs;
    if (!Array.isArray(raw)) return [];
    return Array.from(new Set(raw.filter((value): value is string =>
      typeof value === 'string' &&
      /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*(?:@[A-Za-z0-9.+-]+)?$/.test(value),
    ))).slice(0, 64);
  }, [currentProject.metadata?.matosAssetRefs]);
  // A selected role asset is part of this project's runnable boundary even
  // when it was not separately added through the member dialog. Project
  // sharing forks that role under the same canonical ref for the recipient,
  // so keeping it here makes shared private roles immediately selectable.
  const projectRunnableRoles = useMemo(
    () => projectRunnableRoleRefs(projectMemberRefs, projectAssetRefs),
    [projectAssetRefs, projectMemberRefs],
  );

  const handleSend = useCallback(
    async (
      prompt: string,
      attachments: ChatAttachment[],
      commentAttachments: ChatCommentAttachment[] = commentsToAttachments(attachedComments),
      meta?: ProjectChatSendMeta,
      baseMessages?: ChatMessage[],
    ) => {
      if (!activeConversationId) return false;
      if (messagesConversationIdRef.current !== activeConversationId) return false;
      const runSessionMode = meta?.sessionMode ?? activeSessionMode;
      const retryTarget = meta?.retryOfAssistantId
        ? resolveRetryTarget(messages, meta.retryOfAssistantId)
        : null;
      if (meta?.retryOfAssistantId && !retryTarget) return false;
      const runContext = meta?.context ?? retryTarget?.userMsg.runContext;
      const historyBase = retryTarget ? retryTarget.priorMessages : baseMessages ?? messages;
      // MatOS group chat routing: when the conversation has a multi-member
      // roster, resolve which member answers this turn — a retry keeps the
      // original addressed member; a typed "@Name" in the message body wins
      // next (Feishu-style, the strongest explicit signal); then the @-bar
      // pick from meta; falling back to the conversation's bound role / first
      // member. Every path still executes ONE native `matos --role` run for
      // that member — extra typed mentions fan out as queued dispatches below.
      const conversationForRun = conversationsRef.current.find(
        (c) => c.id === activeConversationId,
      );
      const groupMemberRefsForRun =
        Array.isArray(conversationForRun?.memberRefs) && conversationForRun.memberRefs.length > 1
          ? conversationForRun.memberRefs
          : null;
      const groupMembersForRun = groupMemberRefsForRun
        ? resolveProjectMembers(groupMemberRefsForRun, roleCatalog, projectMemberNames).map(
            (member) => {
              const brief = roleRefRecordValue(projectMemberBriefs, member.ref);
              return {
                ref: member.ref,
                name: member.name,
                ...(brief ? { brief } : {}),
              };
            },
          )
        : null;
      // Typed @-mentions only count for real user turns: retries keep their
      // member. (Relay/fan-out stubs never pass through here anymore — the
      // daemon runs them as durable queue tasks.)
      const typedGroupMentions =
        groupMembersForRun && !retryTarget
          ? parseUserGroupMentions(prompt, groupMembersForRun)
          : [];
      // Every candidate (retry attribution, typed @, @-bar pick, bound role)
      // resolves version-agnostically to the ROSTER's spelling of the ref, so
      // a role version bump does not knock a member out of "addressable" and
      // downstream memberNames/memberBriefs key lookups stay aligned.
      const groupResponderRef = (() => {
        if (!groupMemberRefsForRun) return null;
        const retryMemberRef = canonicalRosterRef(
          groupMemberRefsForRun,
          retryTarget?.userMsg.roleRef,
        );
        if (retryMemberRef) return retryMemberRef;
        const firstTypedMention = typedGroupMentions[0];
        if (firstTypedMention) {
          return canonicalRosterRef(groupMemberRefsForRun, firstTypedMention.ref)
            ?? firstTypedMention.ref;
        }
        const pickedMemberRef = canonicalRosterRef(groupMemberRefsForRun, meta?.memberRoleRef);
        if (pickedMemberRef) return pickedMemberRef;
        const bound = canonicalRosterRef(groupMemberRefsForRun, conversationForRun?.roleRef);
        if (bound) return bound;
        return groupMemberRefsForRun[0] ?? null;
      })();
      if (
        !retryTarget &&
        !prompt.trim() &&
        attachments.length === 0 &&
        commentAttachments.length === 0
      ) return false;
      const effectiveAttachments = mergeChatAttachments(
        attachments,
        ...commentAttachments.map((attachment) =>
          chatAttachmentsFromPreviewCommentImages(attachment.imageAttachments),
        ),
      );
      if (!retryTarget && meta?.queueOnly) {
        queueChatSendForCurrentConversation({
          conversationId: activeConversationId,
          prompt,
          attachments: effectiveAttachments,
          commentAttachments,
          meta: { ...(meta ?? {}), sessionMode: runSessionMode },
        });
        return false;
      }
      if (currentConversationBusy) {
        queueChatSendForCurrentConversation({
          conversationId: activeConversationId,
          prompt,
          attachments: effectiveAttachments,
          commentAttachments,
          meta: { ...(meta ?? {}), sessionMode: runSessionMode },
        });
        return false;
      }
      const runConversationId = activeConversationId;
      setError(null);
      const startedAt = Date.now();
      const userMsg: ChatMessage = retryTarget?.userMsg ?? {
        id: randomUUID(),
        role: 'user',
        content: prompt,
        createdAt: startedAt,
        sessionMode: runSessionMode,
        // Group chat: record whom this turn was addressed to so retries and
        // the group transcript can attribute it (`## user (@NAME)`).
        ...(groupResponderRef ? { roleRef: groupResponderRef } : {}),
        // Quote-reply anchor from the composer's quote bar; persists on the
        // message so the transcript renders `[in reply to …]` and the group
        // log shows the quote chip.
        ...(meta?.replyTo ? { replyTo: meta.replyTo } : {}),
        ...(runContext ? { runContext } : {}),
        attachments: effectiveAttachments.length > 0 ? effectiveAttachments : undefined,
        commentAttachments: commentAttachments.length > 0 ? commentAttachments : undefined,
      };
      const runCommentAttachments = userMsg.commentAttachments ?? [];
      const runAttachments = mergeChatAttachments(
        userMsg.attachments ?? [],
        ...runCommentAttachments.map((attachment) =>
          chatAttachmentsFromPreviewCommentImages(attachment.imageAttachments),
        ),
      );
      const selectedAgent = config.agentId
        ? agentsById.get(config.agentId)
        : null;
      const selectedAgentChoice = config.agentId
        ? config.agentModels?.[config.agentId]
        : undefined;
      const effectiveSelectedAgentChoice = effectiveAgentModelChoice(
        selectedAgent,
        selectedAgentChoice,
      );
      const conversationBoundRoleRef = conversationsRef.current.find(
        (conversation) => conversation.id === runConversationId,
      )?.roleRef;
      const projectRunRoleRef = config.agentId === 'matos'
        ? resolveProjectRoleSelection(projectRunnableRoles, [
            groupResponderRef,
            conversationBoundRoleRef,
            currentProject.metadata?.matosActiveRoleRef,
            effectiveSelectedAgentChoice?.model,
          ])
        : null;
      const assistantAgentId = config.agentId ?? undefined;
      const assistantAgentName = agentModelDisplayName(
        config.agentId,
        selectedAgent?.name,
        effectiveSelectedAgentChoice?.model,
      );
      // Browsing is partial; recovery must retain an authoritative full baseline.
      // Fetch it only when starting a turn, never merely when opening a project.
      const baselineFiles = await fetchProjectFiles(project.id);
      const preTurnFileNames = baselineFiles.map((f) => f.name);
      const preTurnFileSnapshot = baselineFiles.map((f) => ({
        name: f.name,
        size: f.size,
        mtime: f.mtime,
        ...(f.etag ? { etag: f.etag } : {}),
      }));
      // MatOS member attribution: the role this turn will run with — the
      // group's @-addressed member first, then the conversation's member
      // binding, else a picked role that belongs to the project roster.
      const assistantRoleRef = (() => {
        if (projectRunRoleRef) return projectRunRoleRef;
        if (typeof conversationBoundRoleRef === 'string' && conversationBoundRoleRef.startsWith('role:')) {
          return conversationBoundRoleRef;
        }
        const picked = effectiveSelectedAgentChoice?.model;
        return typeof picked === 'string' && picked.startsWith('role:') ? picked : undefined;
      })();
      const assistantId = randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        agentId: assistantAgentId,
        agentName: assistantAgentName,
        roleRef: assistantRoleRef,
        events: [],
        createdAt: startedAt,
        runStatus: 'running',
        startedAt,
        // Tier stamp for downstream projections (e.g. the plan canvas detects
        // plan-mode answers by this); persisted with the message.
        sessionMode: runSessionMode,
        preTurnFileNames,
        preTurnFileSnapshot,
      };
      let latestAssistantMsg: ChatMessage = assistantMsg;
      // Tracks the runId once POST /api/runs returns so that the live stream
      // onError handler can mark the run as completed in completedReattachRunsRef.
      // This prevents attachRecoverableRuns from attempting to reattach a run
      // that just failed in the current session (the daemon status fetch is only
      // needed on reload, not for runs that are already known to have failed).
      let currentRunId: string | undefined = undefined;
      const updateConversationLatestRun = (
        status: NonNullable<ChatMessage['runStatus']>,
        endedAt?: number,
      ) => {
        setConversations((curr) =>
          curr.map((conversation) =>
            conversation.id === runConversationId
              ? {
                  ...conversation,
                  updatedAt: endedAt ?? startedAt,
                  latestRun: {
                    status,
                    startedAt,
                    ...(endedAt === undefined
                      ? {}
                      : {
                          endedAt,
                          durationMs: Math.max(0, endedAt - startedAt),
                        }),
                  },
                }
              : conversation,
          ),
        );
      };
      activeCompletionNotificationRunsRef.current.add(assistantId);
      const nextHistory = retryTarget
        ? [...retryTarget.priorMessages, userMsg]
        : [...historyBase, userMsg];
      const nextVisibleMessages = retryTarget
        ? [...nextHistory, ...retryTarget.preservedAttempts, assistantMsg]
        : [...nextHistory, assistantMsg];
      setMessages(nextVisibleMessages);
      if (!retryTarget) {
        try {
          // Ordering barrier: do not create or persist an assistant run until
          // the corresponding user row is durably accepted by the authority.
          await saveMessage(project.id, runConversationId, userMsg, { required: true });
        } catch (caught) {
          setMessages(historyBase);
          setError(caught instanceof Error ? caught.message : 'Could not save your message.');
          return false;
        }
      }
      markStreamingConversation(runConversationId);
      updateConversationLatestRun('running');
      setArtifact(null);
      savedArtifactRef.current = null;
      onTouchProject();
      // Intentionally do NOT persist `assistantMsg` here. It starts as
      // runStatus='running' with no runId, which the source-level guard treats
      // as a phantom — the first DB write happens inside `onRunCreated`
      // (below) once POST /api/runs returns a runId.
      // as soon as the first delta lands.
      persistMessage(assistantMsg);
      if (runCommentAttachments.length > 0) {
        void patchAttachedStatuses(runCommentAttachments, 'applying');
        const consumedCommentIds = new Set(runCommentAttachments.map((attachment) => attachment.id));
        setAttachedComments((current) =>
          current.filter((comment) => !consumedCommentIds.has(comment.id)),
        );
      }
      const isFirstTurn = !retryTarget && historyBase.length === 0;
      const fallbackFirstTurnTitle =
        summarizeProjectNameFromPrompt(prompt) || prompt.slice(0, 60).trim();
      const fallbackProjectName = summarizeProjectNameFromPrompt(prompt);
      // If this is the first turn, derive a working title from the prompt
      // so the conversation is identifiable in the dropdown without a
      // round-trip through the agent.
      if (isFirstTurn) {
        const title = fallbackFirstTurnTitle;
        if (title) {
          setConversations((curr) =>
            curr.map((c) =>
              c.id === runConversationId ? { ...c, title } : c,
            ),
          );
          void patchConversation(project.id, runConversationId, { title });
        }
        const projectName = fallbackProjectName;
        if (
          projectName &&
          projectName !== project.name &&
          canAutoRenameProjectFromPrompt(project, prompt)
        ) {
          const metadata = project.metadata
            ? { ...project.metadata, nameSource: 'prompt' as const }
            : undefined;
          const updated: Project = {
            ...project,
            name: projectName,
            ...(metadata ? { metadata } : {}),
            updatedAt: Date.now(),
          };
          onProjectChange(updated);
          void patchProject(project.id, {
            name: projectName,
            ...(metadata ? { metadata } : {}),
          });
        }
      }
      const canReplaceConversationTitle = (title: string | null | undefined) => {
        const trimmed = (title ?? '').trim();
        return (
          !trimmed ||
          trimmed === fallbackFirstTurnTitle ||
          trimmed === prompt.slice(0, 60).trim()
        );
      };
      const applyAgentGeneratedTitle = (rawTitle: string) => {
        if (!isFirstTurn) return;
        const agentTitle = rawTitle.trim();
        if (!agentTitle) return;
        const currentConversationTitle = conversationsRef.current.find(
          (conversation) => conversation.id === runConversationId,
        )?.title;
        const shouldPatchConversation = canReplaceConversationTitle(currentConversationTitle);
        setConversations((curr) =>
          curr.map((conversation) => {
            if (conversation.id !== runConversationId) return conversation;
            if (!canReplaceConversationTitle(conversation.title)) return conversation;
            return { ...conversation, title: agentTitle };
          }),
        );
        if (shouldPatchConversation) {
          void patchConversation(project.id, runConversationId, { title: agentTitle });
        }
        if (
          agentTitle !== project.name &&
          canAutoRenameProjectFromPrompt(project, prompt)
        ) {
          const metadata = project.metadata
            ? { ...project.metadata, nameSource: 'agent' as const }
            : undefined;
          const updated: Project = {
            ...project,
            name: agentTitle,
            ...(metadata ? { metadata } : {}),
            updatedAt: Date.now(),
          };
          onProjectChange(updated);
          void patchProject(project.id, {
            name: agentTitle,
            ...(metadata ? { metadata } : {}),
          });
        }
      };

      // Snapshot the file list at turn-start so we can diff after the
      // agent finishes and surface anything new (e.g. a generated .pptx)
      // as download chips on the assistant message.
      const beforeFileNames = new Set(preTurnFileNames);
      // Pending Write/Edit tool invocations for this run: tool_use_id -> path.
      // Keeping this local prevents a superseded stream's late tool_result from
      // consuming a replacement run's colliding tool id.
      const pendingWrites = new Map<string, string>();
      const traceTouchedFilePaths = new Set<string>();
      const clearTraceTouchedFilePaths = () => {
        pendingWrites.clear();
        traceTouchedFilePaths.clear();
      };

      const parser = createArtifactParser();
      let parsedArtifact: Artifact | null = null;
      let liveHtml = '';
      let streamedText = '';

      const updateAssistant = (updater: (prev: ChatMessage) => ChatMessage) => {
        setMessages((curr) =>
          curr.map((m) => {
            if (m.id !== assistantId) return m;
            const updated = updater(m);
            latestAssistantMsg = updated;
            return updated;
          }),
        );
      };
      let persistTimer: ReturnType<typeof setTimeout> | null = null;
      const persistAssistantSoon = () => {
        if (persistTimer) return;
        persistTimer = scheduleProjectTimeout(() => {
          persistTimer = null;
          persistMessageById(assistantId);
        }, 500);
      };
      const persistAssistantNowKeepalive = () => {
        if (persistTimer) {
          clearProjectTimeout(persistTimer);
          persistTimer = null;
        }
        persistMessageById(assistantId, { keepalive: true });
      };
      const pushEvent = (ev: AgentEvent) => {
        textBuffer.flush();
        updateAssistant((prev) => ({
          ...prev,
          events: appendCoalescedAgentEvent(prev.events, ev),
        }));
        persistAssistantSoon();
        persistAssistantSoon();
        // Track Write tool invocations so we can auto-open the destination
        // file the moment the agent finishes writing it. The file-creating
        // tools we care about: Write (new file), Edit (existing file —
        // surfacing the freshly-modified file is also useful).
        if (ev.kind === 'tool_use') {
          // The authoritative input has landed; drop the live partial so the
          // card renders from the parsed `tool_use.input` instead of the
          // mid-token JSON fragment.
          setLiveToolInput((prev) => {
            if (!(ev.id in prev)) return prev;
            const next = { ...prev };
            delete next[ev.id];
            return next;
          });
        }
        if (ev.kind === 'tool_use' && isFileWriteToolName(ev.name)) {
          const filePath = extractFileWriteToolPath(ev.input);
          if (typeof filePath === 'string' && filePath.length > 0) {
            // Preserve the full path so decideAutoOpenAfterWrite can do a
            // path-suffix match against the project's relative file paths.
            // Reducing to a basename here would lose the segment alignment
            // we need to disambiguate same-basename collisions across the
            // project tree and outside it.
            pendingWrites.set(ev.id, filePath);
          }
        }
        if (ev.kind === 'tool_result') {
          const filePath = pendingWrites.get(ev.toolUseId);
          if (filePath) {
            pendingWrites.delete(ev.toolUseId);
            if (!ev.isError) {
              traceTouchedFilePaths.add(filePath);
              // Refresh first so FileWorkspace's file list (and the tab
              // body) sees the new content before we ask it to focus.
              // Only auto-open if the file actually landed in the project's
              // file list — otherwise an out-of-project Write (e.g. an
              // upstream repo edit) would spawn a permanent placeholder tab.
              void refreshProjectFiles().then(async (nextFiles) => {
                // A .jsx/.tsx loaded by a sibling HTML entry is a module of a
                // multi-file React prototype, not a standalone page — don't
                // strand the user on a dead-end preview tab. Issue #2744.
                const moduleFileNames = /\.(jsx|tsx)$/i.test(filePath)
                  ? await collectReferencedJsxNames(nextFiles, readProjectHtml)
                  : undefined;
                const decision = decideAutoOpenAfterWrite(filePath, nextFiles, {
                  moduleFileNames,
                });
                if (decision.shouldOpen && decision.fileName) {
                  requestOpenFile(decision.fileName);
                }
              });
            }
          }
        }
      };

      const applyContentDelta = (delta: string) => {
        for (const ev of parser.feed(delta)) {
          if (ev.type === 'artifact:start') {
            liveHtml = '';
            parsedArtifact = {
              identifier: ev.identifier,
              artifactType: ev.artifactType,
              title: ev.title,
              html: '',
            };
            setArtifact(parsedArtifact);
          } else if (ev.type === 'artifact:chunk') {
            liveHtml += ev.delta;
            parsedArtifact = parsedArtifact
              ? { ...parsedArtifact, html: liveHtml }
              : {
                  identifier: ev.identifier,
                  title: '',
                  html: liveHtml,
                };
            setArtifact((prev) =>
              prev
                ? { ...prev, html: liveHtml }
                : {
                    identifier: ev.identifier,
                    title: '',
                    html: liveHtml,
                  },
            );
          } else if (ev.type === 'artifact:end') {
            parsedArtifact = parsedArtifact
              ? { ...parsedArtifact, html: ev.fullContent }
              : {
                  identifier: ev.identifier,
                  title: '',
                  html: ev.fullContent,
                };
            setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
          }
        }
      };

      const textBuffer = createBufferedTextUpdates({
        updateMessage: updateAssistant,
        persistSoon: persistAssistantSoon,
        flushAndPersistNow: persistAssistantNowKeepalive,
        onContentDelta: applyContentDelta,
      });
      sendTextBufferRef.current = textBuffer;

      const controller = new AbortController();
      const cancelController = new AbortController();
      abortRef.current = controller;
      cancelRef.current = cancelController;
      const handlers = {
        onDelta: (delta: string) => {
          // See reattach-path comment above for rationale.  PR #4651 round 9.
          if (currentRunId) {
            transientFailedRetriesRef.current.delete(currentRunId);
            genericDisconnectRetriesRef.current.delete(currentRunId);
            genericDisconnectBackoffUntilRef.current.delete(currentRunId);
          }
          streamedText += delta;
          textBuffer.appendContent(delta);
        },
        onAgentEvent: (ev: AgentEvent) => {
          if (currentRunId) {
            transientFailedRetriesRef.current.delete(currentRunId);
            genericDisconnectRetriesRef.current.delete(currentRunId);
            genericDisconnectBackoffUntilRef.current.delete(currentRunId);
          }
          if (ev.kind === 'conversation_title') {
            applyAgentGeneratedTitle(ev.title);
            return;
          }
          if (ev.kind === 'text') textBuffer.appendTextEvent(ev.text);
          else pushEvent(ev);
        },
        onToolInputDelta: (id: string, name: string, delta: string) => {
          setLiveToolInput((prev) => ({
            ...prev,
            [id]: {
              name,
              text: (prev[id]?.text ?? '') + delta,
              // Pin the tool's stream position the first time we see it: the
              // count of events already on the message is everything the model
              // emitted before the tool call (its preamble). Buffered text
              // (appendTextEvent) isn't flushed into `events` until the next
              // frame, so add 1 for any still-pending preamble chunk — it will
              // commit as one text event just before this tool's position.
              seq:
                prev[id]?.seq ??
                ((latestAssistantMsg.events?.length ?? 0) + (textBuffer.hasPendingText() ? 1 : 0)),
            },
          }));
        },
        onDone: async (fullText = '') => {
          // The daemon delivers onDone even for a canceled run, so a run
          // superseded by a "send now" interrupt can still land here and must
          // not apply its completion side effects over the replacement. A run
          // may finalize unless it was tagged superseded at interrupt time
          // (recorded before handleStop cleared the refs), which is reliable
          // even before the replacement send attaches — unlike abortRef, whose
          // terminal onRunStatus / handleStop churn make it ambiguous here.
          const runMayFinalize =
            !supersededRunsRef.current.has(controller);
          if (!runMayFinalize) {
            textBuffer.cancel();
            cancelSendTextBuffer();
            clearTraceTouchedFilePaths();
            return;
          }
          textBuffer.flush();
          textBuffer.cancel();
          cancelSendTextBuffer();
          for (const ev of parser.flush()) {
            if (ev.type === 'artifact:end') {
              parsedArtifact = parsedArtifact
                ? { ...parsedArtifact, html: ev.fullContent }
                : {
                    identifier: ev.identifier,
                    title: '',
                    html: ev.fullContent,
                  };
              setArtifact((prev) => (prev ? { ...prev, html: ev.fullContent } : null));
            }
          }
          const endedAt = Date.now();
          let finalRunStatus: ChatMessage['runStatus'] = 'succeeded';
          updateAssistant((prev) => {
            finalRunStatus = resolveSucceededRunStatus(prev.runStatus);
            return {
              ...prev,
              endedAt,
              runStatus: finalRunStatus,
            };
          });
          if (runCommentAttachments.length > 0) {
            void patchAttachedStatuses(runCommentAttachments, 'needs_review');
          }
          const ownsCurrentRun = clearCurrentRunStreamingMarker(
            runConversationId,
            controller,
            cancelController,
          );
          if (ownsCurrentRun) updateConversationLatestRun(finalRunStatus ?? 'succeeded', endedAt);
          // Group continuation (fan-out to extra @-mentioned members and
          // auto-relay of trailing "@NAME: <task>" handoffs) is daemon-owned:
          // it fires off the daemon's own run-finalization path, so chains
          // survive this tab closing or reloading mid-run. Here the web only
          // watches the durable task ledger and pulls new stub/progress rows
          // into the open conversation as the daemon dispatches them.
          if (groupMemberRefsForRun && groupResponderRef) {
            watchGroupDispatch(runConversationId);
          }
          // The daemon mirrors this finished group turn into the member's DM
          // (their work ledger). Refresh the sidebar ordering, and pull the
          // fresh rows in when the user is currently reading that member's DM.
          if (groupMemberRefsForRun && groupResponderRef) {
            void refreshConversationsAfterRun(runConversationId);
            refreshMemberDmViewIfActive(groupResponderRef);
          }
          // Refetch the file list directly (rather than just bumping the
          // refresh signal) so we can diff against the pre-turn snapshot
          // and attach the new files to the assistant message as download
          // chips.
          void (async () => {
            try {
              let nextFiles = await refreshProjectFiles();
              const finalText = streamedText || fullText;
              const artifactToPersist = parsedArtifact?.html
                ? parsedArtifact
                : artifactFromStandaloneHtml(finalText);
              if (artifactToPersist?.html) {
                const producedBeforeFallback = computeProducedFiles(
                  beforeFileNames,
                  nextFiles,
                  preTurnFileSnapshot,
                ) ?? [];
                const sameTurnHtmlWrite = await findSameTurnHtmlWriteForRecoveredArtifact({
                  artifactHtml: resolvePersistedArtifactHtml({
                    artifactHtml: artifactToPersist.html,
                    identifier: artifactToPersist.identifier,
                    sourceText: finalText,
                  }),
                  producedFiles: producedBeforeFallback,
                  readProjectHtml,
                });
                if (sameTurnHtmlWrite) {
                  savedArtifactRef.current = sameTurnHtmlWrite.name;
                  requestOpenFile(sameTurnHtmlWrite.name);
                } else {
                  await persistArtifact(artifactToPersist, nextFiles, finalText);
                  nextFiles = await refreshProjectFiles();
                }
              }
              const produced = computeProducedFiles(
                beforeFileNames,
                nextFiles,
                preTurnFileSnapshot,
              ) ?? [];
              const traceObjectFiles = computeTraceObjectFiles(
                beforeFileNames,
                nextFiles,
                traceTouchedFilePaths,
              ) ?? [];
              const producedArtifactToOpen = selectAutoOpenProducedArtifact(produced);
              if (producedArtifactToOpen) requestOpenFile(producedArtifactToOpen);
              setMessages((curr) => {
                const updated = curr.map((m) =>
                  m.id === assistantId
                    ? { ...m, producedFiles: produced, traceObjectFiles }
                    : m,
                );
                const finalized = updated.find((m) => m.id === assistantId);
                if (finalized) persistMessage(finalized, { telemetryFinalized: true });
                return updated;
              });
              // The finalize persist above also refreshed the member's DM
              // mirror with produced files; if the user is reading that DM,
              // pull the completed ledger row (with its file chips) in.
              if (groupMemberRefsForRun && groupResponderRef) {
                refreshMemberDmViewIfActive(groupResponderRef);
              }
            } finally {
              clearTraceTouchedFilePaths();
            }
          })();
          onProjectsRefresh();
        },
        onError: async (err: Error) => {
          // Disconnect-time stamp, used as-is for non-generic-disconnect
          // failures. When the generic-disconnect retry-cap probe below
          // resolves a terminal daemon status, this is advanced to that
          // authoritative `updatedAt` so BOTH the assistant message row and
          // updateConversationLatestRun() (which drives the sidebar/dropdown
          // sort + duration) reflect the daemon's terminal time rather than
          // this stale pre-probe timestamp.
          let endedAt = Date.now();
          const errorCode = (err as Error & { code?: string }).code;
          const resumable = (err as Error & { resumable?: boolean }).resumable === true;
          let finalRunStatusAfterError: ChatMessage['runStatus'] = 'failed';
          let refreshConversationAfterError = false;
          // The final onError invocation whose retry-cap probe turns terminal
          // may arrive AFTER an earlier invocation already consumed
          // ownership via clearCurrentRunStreamingMarker (abortRef/cancelRef
          // are nulled out the first time, so a later call with the same
          // controller reads ownsCurrentRun as false). Track whether the
          // terminal-probe branches below already stamped the conversation
          // directly, so the unconditional call at the bottom does not need
          // (and must not double-apply) that same update.
          let conversationFinalizedInline = false;
          // A run superseded by a "send now" interrupt can still surface a
          // late disconnect error (e.g. a canceled stream that lost its
          // terminal SSE). It must not paint a global failure banner or
          // re-finalize its already-canceled assistant message once it was
          // tagged superseded. See the onDone above for the ownership rationale.
          const runMayFinalize =
            !supersededRunsRef.current.has(controller);
          textBuffer.flush();
          textBuffer.cancel();
          cancelSendTextBuffer();
          if (runMayFinalize) {
            setError(err.message);
            appendAssistantErrorEvent(assistantId, err.message, errorCode);
            updateAssistant((prev) => ({
              ...prev,
              endedAt,
              runStatus: prev.runId || isActiveRunStatus(prev.runStatus)
                ? 'failed'
                : prev.runStatus,
              resumable,
            }));
            if (runCommentAttachments.length > 0) {
              void patchAttachedStatuses(runCommentAttachments, 'failed');
            }
          }
          // Mark the run as completed in the reattach registry so that
          // attachRecoverableRuns does not race it after streaming ends.
          // Without this guard, the spuriouslyFailedPending heuristic would
          // match a freshly-failed live run (no content, no producedFiles) and
          // attempt a daemon status fetch on a run the client already knows
          // failed — overwriting the assistant message's resumable flag with
          // the fetched status before the ChatPane has had a chance to render.
          //
          // EXCEPTION: the generic "daemon stream disconnected before run
          // completed" error is a browser-side SSE reconnect-budget exhaustion,
          // NOT an authoritative terminal failure.  The daemon may still report
          // the run as queued/running on the next tick, so we must leave the
          // runId eligible for attachRecoverableRuns to re-query.  Only seal
          // the registry entry on authoritative terminal failures (any error
          // that is NOT the generic disconnect message).
          // Generic disconnects share the transient-retry budget with the
          // reattach null-status path. As with the reattach path above, a null
          // status probe is not authoritative — it may be a transient fetch or
          // daemon hiccup — so keep the run eligible for future re-query unless
          // the daemon explicitly reports a terminal status.
          if (currentRunId) {
            if (isGenericDaemonDisconnect(err)) {
              const runIdForGenericDisconnect = currentRunId;
              const attempts =
                (genericDisconnectRetriesRef.current.get(runIdForGenericDisconnect) ?? 0) + 1;
              if (attempts >= MAX_TRANSIENT_RETRIES) {
                const backoffUntil = Date.now() + 3000;
                genericDisconnectRetriesRef.current.set(runIdForGenericDisconnect, attempts);
                genericDisconnectBackoffUntilRef.current.set(runIdForGenericDisconnect, backoffUntil);
                const backoffTimer = scheduleProjectTimeout(() => {
                  const currentBackoffUntil =
                    genericDisconnectBackoffUntilRef.current.get(runIdForGenericDisconnect) ?? 0;
                  if (currentBackoffUntil <= Date.now()) {
                    genericDisconnectBackoffUntilRef.current.delete(runIdForGenericDisconnect);
                  }
                  setRecoveryTick((t) => t + 1);
                }, 3000);
                const latestRunStatus = await fetchChatRunStatus(runIdForGenericDisconnect).catch(() => null);
                if (!latestRunStatus || isActiveRunStatus(latestRunStatus.status)) {
                } else if (latestRunStatus.status === 'succeeded') {
                  clearProjectTimeout(backoffTimer);
                  // Advance the outer endedAt so updateConversationLatestRun()
                  // below adopts this same authoritative terminal timestamp,
                  // matching the message row's endedAt set further down.
                  endedAt = latestRunStatus.updatedAt;
                  if (runMayFinalize) {
                    setError(null);
                    updateAssistant((prev) => {
                      const recovered = removeErrorStatusEvent(prev, err.message, errorCode);
                      if (
                        !prev.producedFiles?.length
                        && (prev.content.trim().length > 0 || (prev.events?.length ?? 0) > 0)
                      ) {
                        return {
                          ...recovered,
                          content: '',
                          events: [],
                          // Adopt the daemon's authoritative terminal timestamp rather
                          // than the stale disconnect-time stamp taken when the generic
                          // disconnect first fired.
                          endedAt: latestRunStatus.updatedAt,
                          runStatus: 'succeeded',
                          ...(latestRunStatus.resumable !== undefined
                            ? { resumable: latestRunStatus.resumable }
                            : {}),
                        };
                      }
                      return {
                        ...recovered,
                        endedAt: latestRunStatus.updatedAt,
                        runStatus: 'succeeded',
                        ...(latestRunStatus.resumable !== undefined
                          ? { resumable: latestRunStatus.resumable }
                          : {}),
                      };
                    });
                    updateConversationLatestRun('succeeded', endedAt);
                    conversationFinalizedInline = true;
                  }
                  if (runCommentAttachments.length > 0) {
                    void patchAttachedStatuses(runCommentAttachments, 'needs_review');
                  }
                  finalRunStatusAfterError = 'succeeded';
                  refreshConversationAfterError = true;
                  genericDisconnectRetriesRef.current.delete(runIdForGenericDisconnect);
                  genericDisconnectBackoffUntilRef.current.delete(runIdForGenericDisconnect);
                } else {
                  clearProjectTimeout(backoffTimer);
                  // Same rationale as the succeeded branch above: keep the
                  // conversation-level stamp in step with the message row.
                  endedAt = latestRunStatus.updatedAt;
                  if (runMayFinalize) {
                    if (latestRunStatus.status === 'canceled') setError(null);
                    updateAssistant((prev) => ({
                      ...prev,
                      endedAt: latestRunStatus.updatedAt,
                      runStatus: latestRunStatus.status,
                      ...(latestRunStatus.resumable !== undefined
                        ? { resumable: latestRunStatus.resumable }
                        : {}),
                    }));
                    updateConversationLatestRun(latestRunStatus.status, endedAt);
                    conversationFinalizedInline = true;
                  }
                  finalRunStatusAfterError = latestRunStatus.status;
                  refreshConversationAfterError = true;
                  completedReattachRunsRef.current.add(runIdForGenericDisconnect);
                  genericDisconnectRetriesRef.current.delete(runIdForGenericDisconnect);
                  genericDisconnectBackoffUntilRef.current.delete(runIdForGenericDisconnect);
                }
              } else {
                genericDisconnectRetriesRef.current.set(runIdForGenericDisconnect, attempts);
              }
            } else {
              genericDisconnectRetriesRef.current.delete(currentRunId);
              genericDisconnectBackoffUntilRef.current.delete(currentRunId);
              completedReattachRunsRef.current.add(currentRunId);
            }
          }
          const ownsCurrentRun = clearCurrentRunStreamingMarker(
            runConversationId,
            controller,
            cancelController,
          );
          if (ownsCurrentRun && !conversationFinalizedInline) {
            updateConversationLatestRun(finalRunStatusAfterError, endedAt);
          }
          setMessages((curr) => {
            const finalized = curr.find((m) => m.id === assistantId);
            if (finalized) persistMessage(finalized, { telemetryFinalized: true });
            return curr;
          });
          if (refreshConversationAfterError) {
            scheduleConversationMessageRefresh(runConversationId);
          }
          void refreshProjectFiles();
          clearTraceTouchedFilePaths();
        },
      };

        if (!config.agentId) {
          handlers.onError(new Error('Pick a local agent first (top bar).'));
          return true;
        }
        const choice = effectiveSelectedAgentChoice;
        // MatOS member DM / group chat: a role-bound conversation pins every
        // run to its member role (group turns pin to the @-addressed member),
        // overriding the global agent-model pick. Roles project as models, so
        // the binding rides the existing `model` field.
        // `projectRunRoleRef` already applies group/conversation precedence
        // and returns the project roster's canonical spelling. Do not map it
        // back through the global catalog: that would discard a pinned roster
        // version and reintroduce cross-project role inheritance.
        const boundRoleRef = projectRunRoleRef;
        // Group mutual-discovery context: roster + who is answering. The
        // daemon transcript builder turns this into an attributed transcript
        // (each member's turns are labeled) plus a roster header, so every
        // member can read the others' work — the "agents see each other"
        // mechanism, carried entirely by the shared conversation.
        const groupContext =
          groupMembersForRun && groupResponderRef
            ? {
                members: groupMembersForRun,
                respondingRef: groupResponderRef,
                respondingName:
                  roleRefRecordValue(projectMemberNames, groupResponderRef) ??
                  findByRoleRef(roleCatalog, groupResponderRef)?.name ??
                  groupResponderRef.replace(/^role:/, ''),
              }
            : undefined;
        void streamViaDaemon({
          agentId: config.agentId,
          history: nextHistory,
          signal: controller.signal,
          cancelSignal: cancelController.signal,
          handlers,
          projectId: project.id,
          projectRoleRefs: projectRunnableRoles,
          conversationId: runConversationId,
          assistantMessageId: assistantId,
          clientRequestId: randomUUID(),
          skillId: project.skillId ?? null,
          skillIds: Array.isArray(meta?.skillIds) ? meta.skillIds : [],
          context: runContext,
          attachments: runAttachments.map((a) => a.path),
          commentAttachments: runCommentAttachments,
          sessionMode: runSessionMode,
          research: meta?.research,
          model: boundRoleRef ?? choice?.model ?? null,
          reasoning: choice?.reasoning ?? null,
          ...(config.agentId === 'matos' && matosProviderModel
            ? { providerModel: matosProviderModel }
            : {}),
          ...(config.agentId === 'matos' && projectAssetRefs.length > 0
            ? { assetRefs: projectAssetRefs }
            : {}),
          ...(groupContext ? { groupContext } : {}),
          titleGeneration: isFirstTurn ? { enabled: true } : undefined,
          locale,
          onRunCreated: (runId) => {
            const pinnedAssistant = {
              ...latestAssistantMsg,
              runId,
              runStatus: 'queued' as const,
            };
            latestAssistantMsg = pinnedAssistant;
            currentRunId = runId;
            // The view may already be on a different project/conversation;
            // pin the daemon run to the original row so returning can reattach.
            void saveMessage(project.id, runConversationId, pinnedAssistant);
            updateMessageById(assistantId, (prev) => ({ ...prev, runId, runStatus: 'queued' }));
          },
          onRunStatus: (runStatus) => {
            const endedAt = isTerminalRunStatus(runStatus) ? Date.now() : undefined;
            const runMayFinalize =
              !supersededRunsRef.current.has(controller);
            updateMessageById(
              assistantId,
              (prev) => ({
                ...prev,
                runStatus,
                endedAt: endedAt === undefined ? prev.endedAt : prev.endedAt ?? endedAt,
              }),
              true,
              runStatus === 'canceled' ? { telemetryFinalized: true } : undefined,
            );
            if (!runMayFinalize) return;
            updateConversationLatestRun(runStatus, endedAt);
            if (isTerminalRunStatus(runStatus)) {
              clearCurrentRunStreamingMarker(runConversationId, controller, cancelController);
              scheduleConversationMessageRefresh(runConversationId);
              if (runStatus !== 'succeeded') clearTraceTouchedFilePaths();
            }
          },
          onRunEventId: (lastRunEventId) => {
            updateMessageById(assistantId, (prev) => ({ ...prev, lastRunEventId }));
            persistAssistantSoon();
          },
        });
        return true;
      return true;
    },
    [
      attachedComments,
      activeConversationId,
      activeSessionMode,
      currentConversationBusy,
      queueChatSendForCurrentConversation,
      messages,
      config,
      locale,
      agentsById,
      onTouchProject,
      project.id,
      project.name,
      projectFiles,
      refreshProjectFiles,
      readProjectHtml,
      requestOpenFile,
      persistMessage,
      persistMessageById,
        patchAttachedStatuses,
      updateMessageById,
      markStreamingConversation,
      clearStreamingMarker,
      clearCurrentRunStreamingMarker,
      clearProjectTimeout,
      scheduleConversationMessageRefresh,
      scheduleProjectTimeout,
      onProjectsRefresh,
      onProjectChange,
      roleCatalog,
      projectMemberRefs,
      projectRunnableRoles,
      projectMemberNames,
      projectMemberBriefs,
      currentProject.metadata?.matosActiveRoleRef,
      matosProviderModel,
      projectAssetRefs,
      refreshMemberDmViewIfActive,
      watchGroupDispatch,
    ],
  );

  // Cancel every in-flight run for the current conversation (the user's own
  // streaming turn plus any reattached runs), mark their assistant messages
  // canceled, and drop the streaming state. Defined here — ahead of the
  // queued-send handlers — because "send now" interrupts the active run to
  // make room for the prioritized send.
  const handleStop = useCallback(() => {
    const stoppedAt = Date.now();
    cancelSendTextBuffer(true);
    cancelReattachTextBuffers(true);
    cancelRef.current?.abort();
    cancelRef.current = null;
    for (const controller of reattachCancelControllersRef.current.values()) {
      controller.abort();
    }
    reattachCancelControllersRef.current.clear();
    abortRef.current?.abort();
    abortRef.current = null;
    for (const controller of reattachControllersRef.current.values()) {
      controller.abort();
    }
    reattachControllersRef.current.clear();
    setStreaming(false);
    streamingConversationIdRef.current = null;
    setStreamingConversationId(null);
    setMessages((curr) => {
      const { messages: next, finalized } = finalizeActiveAssistantMessagesOnStop(curr, stoppedAt);
      for (const message of finalized) persistMessage(message, { telemetryFinalized: true });
      return next;
    });
  }, [
    cancelSendTextBuffer,
    cancelReattachTextBuffers,
    persistMessage,
  ]);

  // Flip the deck preview to the slide a queued send's marked element lives on
  // the moment that send starts processing. No-op for plain prompts or marks
  // without a slide index; FileWorkspace/FileViewer ignore it unless the named
  // file is the open deck.
  const armSlideNavForQueuedSend = useCallback((item: QueuedChatSend) => {
    const target = queuedSlideNavTarget(item.commentAttachments);
    if (!target) return;
    setSlideNavRequest({ name: target.filePath, slideIndex: target.slideIndex, nonce: Date.now() });
  }, []);

  const sendQueuedChatSendNow = useCallback((id: string) => {
    const item = queuedChatSendsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    // This item's dispatch is already in flight (auto-start or an earlier
    // send-now click); its row just hasn't left the strip yet. Dispatching
    // again — or interrupting the run it just started — would duplicate the
    // user message, so treat the click as a no-op.
    if (inFlightQueuedSendIdsRef.current.has(id)) return;
    if (currentConversationBusy) {
      // "Send now" while the agent is still working: the user has explicitly
      // chosen this turn over the in-flight one, so interrupt the running run
      // and move this item to the front. Stopping flips the conversation out
      // of its busy state, and the auto-start effect below then flushes the
      // now-first queued send — reusing the same path as a natural completion,
      // so runs never overlap.
      //
      // Record the runs we're superseding BEFORE handleStop() clears the active
      // refs. The daemon still delivers a late terminal callback for the
      // canceled run; tagging its controller here lets those callbacks be
      // recognized as stale and skip every current-run side effect, even if the
      // replacement send hasn't attached yet.
      if (abortRef.current) supersededRunsRef.current.add(abortRef.current);
      for (const controller of reattachControllersRef.current.values()) {
        supersededRunsRef.current.add(controller);
      }
      // The interrupted turn moved its preview-comment attachments to
      // 'applying' when it started; since we now suppress its terminal
      // callbacks, reset them to 'open' so they don't stay stuck mid-apply.
      // Reset ONLY the in-flight run's comments: queued sends (including the
      // one being prioritized) also hold their attachments in 'applying', and
      // those must stay reserved — the replacement run re-applies them. The
      // in-flight run's comments are exactly the 'applying' ones not owned by
      // any queued send.
      const queuedCommentIds = new Set(
        queuedChatSendsRef.current.flatMap((send) =>
          send.commentAttachments.map((attachment) => attachment.id),
        ),
      );
      const stuckApplying = previewCommentsRef.current.filter(
        (comment) => comment.status === 'applying' && !queuedCommentIds.has(comment.id),
      );
      if (stuckApplying.length > 0) {
        const resetIds = new Set(stuckApplying.map((comment) => comment.id));
        setPreviewComments((current) =>
          current.map((comment) =>
            resetIds.has(comment.id) ? { ...comment, status: 'open' } : comment,
          ),
        );
        void Promise.all(
          stuckApplying.map((comment) =>
            patchPreviewCommentStatus(project.id, comment.conversationId, comment.id, 'open'),
          ),
        ).catch(() => {});
      }
      prioritizeQueuedChatSend(id);
      handleStop();
      return;
    }
    inFlightQueuedSendIdsRef.current.add(id);
    void (async () => {
      try {
        armSlideNavForQueuedSend(item);
        const started = await handleSend(
          item.prompt,
          item.attachments,
          item.commentAttachments,
          item.meta,
        );
        if (started) removeQueuedChatSend(id);
      } finally {
        inFlightQueuedSendIdsRef.current.delete(id);
      }
    })();
  }, [armSlideNavForQueuedSend, currentConversationBusy, handleSend, handleStop, prioritizeQueuedChatSend, project.id, removeQueuedChatSend]);

  useEffect(() => {
    if (currentConversationBusy) {
      startingQueuedChatSendIdRef.current = null;
      return;
    }
    if (startingQueuedChatSendIdRef.current) return;
    if (!activeConversationId) return;
    if (messagesConversationIdRef.current !== activeConversationId) return;
    const next = queuedChatSendsRef.current.find(
      (item) => item.conversationId === activeConversationId,
    );
    if (!next) return;
    // A send-now click may already be dispatching this exact item (its row
    // stays in the strip until handleSend resolves); starting it again here
    // would duplicate the user message.
    if (inFlightQueuedSendIdsRef.current.has(next.id)) return;
    startingQueuedChatSendIdRef.current = next.id;
    inFlightQueuedSendIdsRef.current.add(next.id);
    armSlideNavForQueuedSend(next);
    void (async () => {
      try {
        const started = await handleSend(
          next.prompt,
          next.attachments,
          next.commentAttachments,
          next.meta,
        );
        if (!started) {
          if (startingQueuedChatSendIdRef.current === next.id) {
            startingQueuedChatSendIdRef.current = null;
          }
          return;
        }
        removeQueuedChatSend(next.id);
        scheduleProjectTimeout(() => {
          if (startingQueuedChatSendIdRef.current !== next.id) return;
          startingQueuedChatSendIdRef.current = null;
          setQueuedAutoStartTick((tick) => tick + 1);
        }, 0);
      } finally {
        inFlightQueuedSendIdsRef.current.delete(next.id);
      }
    })();
  }, [
    activeConversationId,
    armSlideNavForQueuedSend,
    currentConversationBusy,
    queuedAutoStartTick,
    queuedChatSends,
    handleSend,
    removeQueuedChatSend,
    scheduleProjectTimeout,
  ]);

  const handleRetry = useCallback(
    (assistantMessage: ChatMessage) => {
      if (currentConversationActionDisabled) return;
      void handleSend('', [], [], { retryOfAssistantId: assistantMessage.id });
    },
    [currentConversationActionDisabled, handleSend],
  );

  // "Continue" on a resumable failed run: send a fresh turn in the same
  // conversation. For a session-resuming runtime (Claude) the daemon persisted
  // the failed run's CLI session, so this turn resumes it (`--resume`) and the
  // agent continues from its committed work instead of restarting. Mirrors the
  // "Continue remaining tasks" affordance; unlike Retry it does not replay the
  // prior turn from scratch.
  // run_created / run_finished can quantify how often resume fires and whether
  // it recovers (the whole point is to show the mechanism lowers failure rate).
  const handleResumeRun = useCallback(
    (_assistantMessage: ChatMessage) => {
      if (currentConversationActionDisabled) return;
      void handleSend(RESUME_CONTINUE_PROMPT, [], []);
    },
    [currentConversationActionDisabled, handleSend],
  );

  // "Switch to AMR & retry" from the failed-run card: switch the run to AMR,
  // open Settings on the AMR controls so the user can sign in / authorize /
  // top up, and arm an auto-retry that fires once AMR is selected AND signed
  // in (see the effect below).
  const [pendingAmrRetry, setPendingAmrRetry] = useState<ChatMessage | null>(null);
  // Poll the AMR login status while a retry is armed, rather than only reacting
  // to the AmrLoginPill's status event — the user may close Settings (which
  // unmounts the pill and stops its polling) before finishing sign-in in the
  // browser. Polling here keeps working regardless of the pill's lifecycle.
  // Fires once AMR is the selected agent AND the account is signed in.
  useEffect(() => {
    if (!pendingAmrRetry) return;
    let cancelled = false;
    const tryRetry = async () => {
      if (cancelled) return;
      return;
    };
    void tryRetry();
    const interval = setInterval(() => void tryRetry(), 2000);
    // Give up after a few minutes so we never poll forever.
    const stop = setTimeout(() => {
      if (!cancelled) setPendingAmrRetry(null);
    }, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [pendingAmrRetry, config.agentId, handleRetry]);

  const handleSendBoardCommentAttachments = useCallback(
    async (commentAttachments: ChatCommentAttachment[], images: File[] = []) => {
      if (currentConversationQueueDisabled) return false;
      if (commentAttachments.length === 0 && images.length === 0) return false;
      setWorkspaceFocused(false);
      setCommentInspectorActive(false);
      // Upload any attached images once, then queue. Each comment becomes its
      // own task (so multiple notes => multiple queued tasks); the images ride
      // along the first task rather than being duplicated across every note.
      let uploaded: ChatAttachment[] = [];
      if (images.length > 0) {
        const result = await uploadProjectFiles(project.id, images);
        uploaded = result.uploaded;
      }
      if (commentAttachments.length === 0) {
        if (uploaded.length > 0) await handleSend('', uploaded, [], { queueOnly: true });
        return true;
      }
      for (let i = 0; i < commentAttachments.length; i++) {
        const commentAttachment = commentAttachments[i]!;
        const savedImages = chatAttachmentsFromPreviewCommentImages(commentAttachment.imageAttachments);
        const prompt = commentTaskQuery(commentAttachment);
        // Comment/board pin → run: tag entry_from='comment' so the dashboard
        // separates annotation-driven runs from plain composer sends.
        await handleSend(
          prompt,
          mergeChatAttachments(i === 0 ? uploaded : [], savedImages),
          [commentTaskContextAttachment(commentAttachment)],
          { queueOnly: true },
        );
      }
      return true;
    },
    [handleSend, project.id, currentConversationQueueDisabled],
  );
  const commentQueueOnSend = currentConversationBusy && !currentConversationQueueDisabled;

  const handleContinueRemainingTasks = useCallback(
    (_assistantMessage: ChatMessage, todos: TodoItem[]) => {
      if (currentConversationActionDisabled || todos.length === 0) return;
      const remainingList = todos
        .map((todo, i) => {
          const label =
            todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
          return `${i + 1}. [${todo.status}] ${label}`;
        })
        .join('\n');
      const prompt =
        'Continue the remaining unfinished tasks from the previous run. ' +
        'Do not redo completed work. Focus only on these unfinished todos:\n\n' +
        `${remainingList}\n\n` +
        'Before making changes, inspect the current project files as needed. ' +
        'Update TodoWrite as you complete each remaining task.';
      void handleSend(prompt, [], []);
    },
    [currentConversationActionDisabled, handleSend],
  );

  const handleNewConversation = useCallback(async () => {
    if (creatingConversationRef.current) return;
    // Only block if we're sure the current conversation is empty:
    // messages must be loaded AND match the active conversation.
    if (
      messagesConversationIdRef.current === activeConversationId &&
      messages.length === 0
    ) {
      return;
    }
    creatingConversationRef.current = true;
    setCreatingConversation(true);
    setConversationLoadError(null);
    try {
      const fresh = await createConversation(project.id, undefined, {
        throwOnError: true,
      });
      if (!fresh) throw new Error('Could not create a conversation for this project.');
      // Eagerly clear messages and update ref so rapid clicks don't create
      // duplicate empty conversations before the effect resolves.
      setMessages([]);
      setStreaming(false);
      streamingConversationIdRef.current = null;
      setStreamingConversationId(null);
      setMessagesConversationId(null);
      messagesConversationIdRef.current = fresh.id;
      setConversations((curr) => [fresh, ...curr]);
      setActiveConversationId(fresh.id);
      // Push the new conversation id into the URL synchronously so the
      // route-sync effect sees a matching `routeConversationId` before
      // it can revert `activeConversationId`. Without this, the route-sync
      // effect can fight the conversation switch, preventing users from
      // switching back to older conversations after creating a new one.
      navigate(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: fresh.id,
          fileName: openTabsState.active ?? null,
        },
        { replace: true },
      );
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create a conversation for this project.';
      setConversationLoadError(message);
      setError(message);
    } finally {
      creatingConversationRef.current = false;
      setCreatingConversation(false);
    }
  }, [project.id, activeConversationId, messages.length, navigate, openTabsState.active]);

  const handleSaveMembers = useCallback(
    async (refs: string[], names: Record<string, string>) => {
      const seen = new Set<string>();
      const cleaned = refs.filter((ref) => {
        if (typeof ref !== 'string' || !ref.startsWith('role:') || seen.has(ref)) return false;
        seen.add(ref);
        return true;
      });
      // Keep aliases only for members that survived the roster clean, trimmed
      // and capped, so a removed member can't leave an orphan name behind.
      const cleanedNames: Record<string, string> = {};
      for (const ref of cleaned) {
        const alias = typeof names[ref] === 'string' ? names[ref].trim().slice(0, 40) : '';
        if (alias) cleanedNames[ref] = alias;
      }
      setSavingMembers(true);
      try {
        const nextActiveRoleRef = cleaned.length > 0
          ? resolveProjectRoleSelection(cleaned, [
              currentProject.metadata?.matosActiveRoleRef,
              config.agentModels?.matos?.model,
            ])
          : null;
        const baseMetadata: ProjectMetadata = {
          kind: currentProject.metadata?.kind ?? 'other',
          ...currentProject.metadata,
          members: cleaned,
          memberNames: cleanedNames,
          matosActiveRoleRef: nextActiveRoleRef,
        };
        onProjectChange({ ...currentProject, metadata: baseMetadata });
        await patchProject(project.id, { metadata: baseMetadata });
        void projectDetail.refresh();
        onProjectsRefresh();
        setMemberInviteOpen(false);
      } finally {
        setSavingMembers(false);
      }
    },
    [
      currentProject,
      onProjectChange,
      onProjectsRefresh,
      project.id,
      projectDetail,
      config.agentModels?.matos?.model,
    ],
  );

  const handleSaveProjectAssets = useCallback(
    async (refs: string[]) => {
      const cleaned = Array.from(new Set(refs.filter((value) =>
        /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*(?:@[A-Za-z0-9.+-]+)?$/.test(value),
      ))).slice(0, 64);
      setSavingProjectAssets(true);
      try {
        const metadata: ProjectMetadata = {
          kind: currentProject.metadata?.kind ?? 'other',
          ...currentProject.metadata,
          matosAssetRefs: cleaned,
        };
        const updated = await patchProject(project.id, { metadata });
        if (!updated) throw new Error('Failed to save project assets');
        onProjectChange(updated);
        await projectDetail.refresh();
        onProjectsRefresh();
        setAssetPickerOpen(false);

      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSavingProjectAssets(false);
      }
    },
    [currentProject, onProjectChange, onProjectsRefresh, project.id, projectDetail],
  );

  // MatOS group chat: one conversation shared by every invited member, each
  // @-addressable. Reuses the first invited member as the default binding so a
  // plain send (no @) still runs a real role through the native CLI path.
  const handleStartGroupChat = useCallback(async () => {
    if (projectMemberRefs.length === 0) {
      setMemberInviteOpen(true);
      return;
    }
    // Feishu-style project group: the sidebar entry OPENS the project's group
    // chat, it does not mint a new one per click. Reuse the newest group
    // conversation whose roster (version-agnostic) matches the current member
    // roster — repeated clicks and role version bumps land in the same group
    // instead of stacking duplicate "Project group chat" rows.
    const wantedRoster = new Set(projectMemberRefs.map(roleRefIdentity));
    const existingGroup = conversationsRef.current.find((conversation) => {
      const roster = Array.isArray(conversation.memberRefs) ? conversation.memberRefs : [];
      if (roster.length <= 1) return false;
      const rosterIds = new Set(roster.map(roleRefIdentity));
      if (rosterIds.size !== wantedRoster.size) return false;
      for (const id of rosterIds) if (!wantedRoster.has(id)) return false;
      return true;
    });
    if (existingGroup) {
      setWorkspaceFocused(false);
      handleSelectConversationRef.current?.(existingGroup.id);
      return;
    }
    if (creatingConversationRef.current) return;
    creatingConversationRef.current = true;
    setCreatingConversation(true);
    try {
      const title = t('project.groupChatTitle');
      const fresh = await createConversation(project.id, title, {
        roleRef: projectMemberRefs[0],
        memberRefs: projectMemberRefs,
        throwOnError: true,
      });
      if (!fresh) throw new Error('Could not create a group conversation.');
      // The daemon may return an existing canonical conversation instead of a
      // new row; filtering by id keeps the sidebar list duplicate-free either
      // way.
      setConversations((curr) => [fresh, ...curr.filter((c) => c.id !== fresh.id)]);
      setWorkspaceFocused(false);
      handleSelectConversationRef.current?.(fresh.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not create a group conversation.';
      setConversationLoadError(message);
      setError(message);
    } finally {
      creatingConversationRef.current = false;
      setCreatingConversation(false);
    }
  }, [projectMemberRefs, project.id, t]);

  // MatOS member DM: open the conversation bound to a role, creating (and
  // titling) it on first contact. One DM per member per project — repeat
  // clicks land in the same thread, like a chat app's direct message.
  const handleOpenMemberChat = useCallback(
    async (roleRef: string, roleName: string) => {
      // A group chat also carries roleRef (its default responder), so a DM
      // lookup must skip multi-member conversations or clicking a member
      // would land in the group instead of their direct thread. Match the
      // bound role version-agnostically: a role version bump must not orphan
      // the member's existing DM (that is exactly how duplicate DMs and
      // "member chat lost its history" reports happened).
      const existing = conversationsRef.current.find(
        (conversation) =>
          sameRoleRef(conversation.roleRef, roleRef) &&
          !(Array.isArray(conversation.memberRefs) && conversation.memberRefs.length > 1),
      );
      if (existing) {
        setWorkspaceFocused(false);
        handleSelectConversationRef.current?.(existing.id);
        return;
      }
      if (creatingConversationRef.current) return;
      creatingConversationRef.current = true;
      setCreatingConversation(true);
      try {
        const fresh = await createConversation(project.id, roleName, {
          roleRef,
          throwOnError: true,
        });
        if (!fresh) throw new Error('Could not create a member conversation.');
        // The daemon dedupes member DMs (`canonical: true` returns the
        // existing thread), so guard the prepend by id or the same
        // conversation would show up twice in the sidebar.
        setConversations((curr) => [fresh, ...curr.filter((c) => c.id !== fresh.id)]);
        setWorkspaceFocused(false);
        handleSelectConversationRef.current?.(fresh.id);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Could not create a member conversation.';
        setConversationLoadError(message);
        setError(message);
      } finally {
        creatingConversationRef.current = false;
        setCreatingConversation(false);
      }
    },
    [project.id],
  );

  const handleSelectConversation = useCallback((id: string) => {
    if (id === activeConversationId && failedMessagesConversationId !== id) return;
    setMessages([]);
    setPreviewComments([]);
    setAttachedComments([]);
    setArtifact(null);
    setStreaming(false);
    streamingConversationIdRef.current = null;
    setStreamingConversationId(null);
    setMessagesConversationId(null);
    setFailedMessagesConversationId(null);
    setConversationLoadError(null);
    messagesConversationIdRef.current = null;
    setActiveConversationId(id);
    // Push the new conversation id into the URL synchronously so the
    // route-sync effect at L512 sees a matching `routeConversationId`
    // before it can find the previous conversation in the list and
    // revert `activeConversationId` to it. Without this, the same
    // effect that fights handleNewConversation also fights chat
    // switching, ping-ponging until React's nested-update guard fires.
    navigate(
      {
        kind: 'project',
        projectId: project.id,
        conversationId: id,
        fileName: openTabsState.active ?? null,
      },
      { replace: true },
    );
    setMessageLoadRetryNonce((nonce) => nonce + 1);
  }, [activeConversationId, failedMessagesConversationId, project.id, openTabsState.active]);

  // Late-bound ref so handleOpenMemberChat (declared above for readability)
  // can reuse the full conversation-switch reset without hook-order gymnastics.
  const handleSelectConversationRef = useRef<typeof handleSelectConversation | null>(null);
  handleSelectConversationRef.current = handleSelectConversation;

  const refreshConversationsAfterRun = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const capturedProjectId = project.id;
      const myToken = ++conversationsRefreshTokenRef.current;
      try {
        const list = await listConversations(capturedProjectId);
        if (projectIdRef.current !== capturedProjectId) return false;
        if (conversationsRefreshTokenRef.current !== myToken) return false;
        setConversations(ensureConversationPresent(list, conversationId, capturedProjectId));
        return true;
      } catch (err) {
        if (projectIdRef.current !== capturedProjectId) return false;
        if (conversationsRefreshTokenRef.current !== myToken) return false;
        console.warn('Failed to refresh conversations after run completion', err);
        setConversations((curr) =>
          ensureConversationPresent(curr, conversationId, capturedProjectId),
        );
        return true;
      }
    },
    [project.id],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const ok = await deleteConversationApi(project.id, id);
      if (!ok) return;
      // The deleted conversation may have owned an unanswered
      // `<question-form>`, which the daemon counts toward the project's
      // `needsInput` flag in `/api/projects`. Home cards render that
      // flag from the cached projects payload, so without refreshing
      // it here the `Needs input` badge survives the deletion until
      // the next manual reload.
      onProjectsRefresh();
      setConversations((curr) => {
        const next = curr.filter((c) => c.id !== id);
        if (next.length === 0) {
          // Re-seed so the project always has at least one conversation
          // to write into.
          void createConversation(project.id).then((fresh) => {
            if (fresh) {
              setConversations([fresh]);
              setActiveConversationId(fresh.id);
            }
          });
        } else if (id === activeConversationId) {
          setActiveConversationId(next[0]!.id);
        }
        return next;
      });
    },
    [project.id, activeConversationId, onProjectsRefresh],
  );

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim() || null;
      setConversations((curr) =>
        curr.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
      );
      await patchConversation(project.id, id, { title: trimmed });
    },
    [project.id],
  );

  const handleConversationSessionModeChange = useCallback(
    async (id: string, sessionMode: ChatSessionMode) => {
      setConversations((curr) =>
        curr.map((conversation) =>
          conversation.id === id ? { ...conversation, sessionMode } : conversation,
        ),
      );
      const updated = await patchConversation(project.id, id, { sessionMode });
      if (updated) {
        setConversations((curr) =>
          curr.map((conversation) =>
            conversation.id === id ? { ...conversation, ...updated } : conversation,
          ),
        );
      }
    },
    [project.id],
  );

  const handleActiveConversationSessionModeChange = useCallback(
    (sessionMode: ChatSessionMode) => {
      if (!activeConversationId) return;
      void handleConversationSessionModeChange(activeConversationId, sessionMode);
    },
    [activeConversationId, handleConversationSessionModeChange],
  );

  // Plan canvas "Approve & execute": flip the conversation into the execute
  // tier and send the implementation turn. The meta.sessionMode pin makes the
  // run itself execute-mode even though the persisted PATCH is still in
  // flight; the plan is already in the session transcript, so the prompt only
  // needs to point at it.
  const handleApprovePlan = useCallback(() => {
    if (!activeConversationId) return;
    handleActiveConversationSessionModeChange('design');
    void handleSend(t('planCanvas.approvePrompt'), [], [], {
      sessionMode: 'design',
    });
  }, [activeConversationId, handleActiveConversationSessionModeChange, handleSend, t]);

  // Plan canvas "Refine": seed the composer with a refine opener and hand the
  // keyboard back — refinement is just the next plan-mode turn.
  const handleRefinePlan = useCallback(() => {
    setComposerDraftSignal({ text: t('planCanvas.refineDraft'), nonce: Date.now() });
  }, [t]);

  const handleForkFromMessage = useCallback(
    async (assistantMessage: ChatMessage) => {
      if (!activeConversationId || forkingMessageId) return;
      setForkingMessageId(assistantMessage.id);
      setConversationLoadError(null);
      try {
        const sourceTitle = activeConversation?.title?.trim();
        const forkTitle = sourceTitle
          ? t('chat.forkedConversationTitle', { title: sourceTitle })
          : undefined;
        // Seed the fork from the messages the user is actually looking at,
        // up to and including the fork point. A run that errored or had its
        // connection reset before its assistant message was persisted leaves
        // that message in memory only; copying from the database by id would
        // 404 and silently drop the fork. Sending the in-memory snapshot makes
        // the fork resilient to that gap.
        const forkIndex = messages.findIndex((m) => m.id === assistantMessage.id);
        const seedMessages =
          forkIndex >= 0 ? messages.slice(0, forkIndex + 1) : [...messages, assistantMessage];
        const fresh = await createConversation(project.id, forkTitle, {
          seedFromConversationId: activeConversationId,
          forkAfterMessageId: assistantMessage.id,
          sessionMode: activeSessionMode,
          seedMessages,
        });
        if (!fresh) throw new Error(t('chat.forkConversationFailed'));
        setMessages([]);
        setPreviewComments([]);
        setAttachedComments([]);
        setArtifact(null);
        setStreaming(false);
        streamingConversationIdRef.current = null;
        setStreamingConversationId(null);
        setMessagesConversationId(null);
        messagesConversationIdRef.current = null;
        setFailedMessagesConversationId(null);
        setConversations((curr) => [fresh, ...curr.filter((c) => c.id !== fresh.id)]);
        setActiveConversationId(fresh.id);
        navigate(
          {
            kind: 'project',
            projectId: project.id,
            conversationId: fresh.id,
            fileName: openTabsState.active ?? null,
          },
          { replace: true },
        );
        onProjectsRefresh();
        setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('chat.forkConversationFailed');
        setConversationLoadError(message);
        setError(message);
      } finally {
        setForkingMessageId(null);
      }
    },
    [
      activeConversationId,
      activeConversation?.title,
      activeSessionMode,
      forkingMessageId,
      messages,
      navigate,
      onProjectsRefresh,
      openTabsState.active,
      project.id,
      t,
    ],
  );

  const handleProjectRename = useCallback(
    async (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || trimmed === project.name) return;
      const updated = await patchProject(project.id, {
        name: trimmed,
        metadata: { nameSource: 'user' },
      });
      if (!updated) {
        setError(t('project.renameFailed'));
        return;
      }
      onProjectChange(updated);
    },
    [project, onProjectChange, t],
  );

  const activeConversationChatState = useMemo(
    () =>
      activeConversationId
        ? {
	            conversationId: activeConversationId,
	            messages,
	            streaming: currentConversationControlStreaming,
	            loading: currentConversationLoading,
	            sendDisabled: currentConversationSendDisabled,
            queuedItems: currentConversationQueuedItems,
            error: conversationLoadError ?? error,
            onSend: handleSend,
            onRetry: handleRetry,
            onStop: handleStop,
            onRemoveQueuedSend: removeQueuedChatSend,
            onUpdateQueuedSend: updateQueuedChatSend,
            onReorderQueuedSends: reorderCurrentConversationQueuedChatSends,
            onSendQueuedNow: sendQueuedChatSendNow,
            onAssistantFeedback: handleAssistantFeedback,
          }
        : undefined,
    [
      activeConversationId,
      conversationLoadError,
      currentConversationActionDisabled,
	      currentConversationQueuedItems,
	      currentConversationSendDisabled,
	      currentConversationLoading,
	      currentConversationControlStreaming,
      error,
      handleAssistantFeedback,
      handleRetry,
      handleSend,
      handleStop,
      messages,
      removeQueuedChatSend,
      reorderCurrentConversationQueuedChatSends,
      sendQueuedChatSendNow,
      updateQueuedChatSend,
    ],
  );

  // Home owns the global MatOS preference; each project owns its active role.
  // This prevents switching project A from changing project B or the next Home
  // run while still letting legacy projects inherit the Home preference once.
  const matosAgent = useMemo(
    () => agents.find((agent) => agent.id === 'matos') ?? null,
    [agents],
  );
  const projectScopedAgents = useMemo(() => {
    if (projectRunnableRoles.length === 0) return agents;
    return agents.map((agent) => {
      if (agent.id !== 'matos') return agent;
      const models = projectRunnableRoles.map((roleRef) => {
        const existing = agent.models?.find((model) => sameRoleRef(model.id, roleRef));
        if (existing) return { ...existing, id: roleRef };
        return {
          id: roleRef,
          label: findByRoleRef(roleCatalog, roleRef)?.name ?? roleRef.replace(/^role:/, ''),
        };
      });
      return { ...agent, models };
    });
  }, [agents, projectRunnableRoles, roleCatalog]);
  const matosConfiguredRole = config.agentModels?.matos?.model ?? null;
  const selectedMatosRoleId =
    matosConfiguredRole && matosConfiguredRole !== 'default' ? matosConfiguredRole : null;
  const selectedProjectMatosRoleId = resolveProjectRoleSelection(
    projectRunnableRoles,
    [currentProject.metadata?.matosActiveRoleRef, selectedMatosRoleId],
  );
  const projectScopedConfig = useMemo<AppConfig>(() => ({
    ...config,
    agentModels: {
      ...(config.agentModels ?? {}),
      matos: {
        ...(config.agentModels?.matos ?? {}),
        model: selectedProjectMatosRoleId ?? 'default',
      },
    },
  }), [config, selectedProjectMatosRoleId]);
  const matosModelSelectionSaveRef = useRef(0);
  const handleMatosProviderModelChange = useCallback((nextModelId: string | null) => {
    const previousProject = currentProject;
    const metadata: ProjectMetadata = {
      kind: currentProject.metadata?.kind ?? 'other',
      ...currentProject.metadata,
      matosProviderModel: nextModelId,
    };
    const optimisticProject = {
      ...currentProject,
      metadata,
      updatedAt: Date.now(),
    };
    const saveId = ++matosModelSelectionSaveRef.current;
    onProjectChange(optimisticProject);
    void patchProject(project.id, { metadata }).then((saved) => {
      if (saveId !== matosModelSelectionSaveRef.current) return;
      if (saved) {
        onProjectChange(saved);
      } else {
        onProjectChange(previousProject);
        setError('Could not save the model selection. The previous model is still active.');
      }
    });
  }, [currentProject, onProjectChange, project.id]);
  const matosRoleSelectionSaveRef = useRef(0);
  const matosRoleMigrationAttemptRef = useRef<string | null>(null);
  const persistProjectMatosRole = useCallback((nextRoleRef: string) => {
    const previousProject = currentProject;
    const metadata: ProjectMetadata = {
      kind: currentProject.metadata?.kind ?? 'other',
      ...currentProject.metadata,
      // Native project authority requires a runnable role to be a project
      // agent member. Promote selected role assets when the user actually
      // picks one; this keeps subsequent daemon checks and reloads aligned.
      members: projectRunnableRoles,
      matosActiveRoleRef: nextRoleRef,
    };
    const optimisticProject = {
      ...currentProject,
      metadata,
      updatedAt: Date.now(),
    };
    const saveId = ++matosRoleSelectionSaveRef.current;
    onProjectChange(optimisticProject);
    void patchProject(project.id, { metadata }).then((saved) => {
      if (saveId !== matosRoleSelectionSaveRef.current) return;
      if (saved) {
        onProjectChange(saved);
      } else {
        onProjectChange(previousProject);
        setError('Could not save the project role. The previous role is still active.');
      }
      void projectDetail.refresh();
    });
  }, [currentProject, onProjectChange, project.id, projectDetail, projectRunnableRoles]);
  const handleMatosRoleChange = useCallback(
    (roleId: string | null) => {
      if (config.agentId !== 'matos') onAgentChange('matos');
      const nextRoleRef = resolveProjectRoleSelection(projectRunnableRoles, [
        roleId,
        currentProject.metadata?.matosActiveRoleRef,
        selectedMatosRoleId,
      ]);
      if (!nextRoleRef) return;
      if (sameRoleRef(currentProject.metadata?.matosActiveRoleRef, nextRoleRef)) return;
      persistProjectMatosRole(nextRoleRef);
    },
    [
      config.agentId,
      currentProject,
      onAgentChange,
      persistProjectMatosRole,
      projectRunnableRoles,
      selectedMatosRoleId,
    ],
  );
  useEffect(() => {
    if (
      currentProject.metadata?.matosActiveRoleRef ||
      !selectedProjectMatosRoleId ||
      projectRunnableRoles.length === 0
    ) return;
    const migrationKey = `${project.id}:${selectedProjectMatosRoleId}`;
    if (matosRoleMigrationAttemptRef.current === migrationKey) return;
    matosRoleMigrationAttemptRef.current = migrationKey;
    persistProjectMatosRole(selectedProjectMatosRoleId);
  }, [
    currentProject.metadata?.matosActiveRoleRef,
    persistProjectMatosRole,
    project.id,
    projectRunnableRoles.length,
    selectedProjectMatosRoleId,
  ]);
  // Member-DM role lock: a conversation bound to a single member (its
  // `roleRef` set, not a multi-member group) always runs as that member's
  // role — the run already pins to it in handleSend. Lock the composer's
  // role picker to that role so the UI can't imply the run uses a different
  // one. Other project conversations can select members plus role assets
  // explicitly bound to this project.
  const lockedRoleForConversation = useCallback((conversationId: string | null | undefined) => {
    const conversation = conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) return null;
    const isGroup =
      Array.isArray(conversation.memberRefs) && conversation.memberRefs.length > 1;
    const roleRef = conversation.roleRef;
    if (isGroup || typeof roleRef !== 'string' || !roleRef.startsWith('role:')) return null;
    // Version-agnostic lookups: the DM may be bound to an older pinned
    // version of the role than the catalog/name map now carries.
    const name =
      roleRefRecordValue(projectMemberNames, roleRef) ??
      findByRoleRef(roleCatalog, roleRef)?.name ??
      roleRef.replace(/^role:/, '');
    return { id: roleRef, name };
  }, [conversations, projectMemberNames, roleCatalog]);
  const renderProjectMatosRolePicker = useCallback(
    (conversationId: string | null | undefined) => (
      matosAgent || agents.length === 0
        ? (
            <MatOSRolePicker
              roles={matosAgent?.models ?? []}
              selectedRoleId={selectedProjectMatosRoleId}
              loading={agents.length === 0}
              onChange={handleMatosRoleChange}
              lockedRole={lockedRoleForConversation(conversationId)}
              allowedRoleRefs={projectRunnableRoles}
            />
          )
        : undefined
    ),
    [
      agents.length,
      handleMatosRoleChange,
      lockedRoleForConversation,
      matosAgent,
      projectRunnableRoles,
      selectedProjectMatosRoleId,
    ],
  );

  // Provider-model pill next to the role pill (web `/model`). Only rendered
  // for MatOS-backed conversations; the picker hides itself when the native
  // model catalog is unavailable.
  const matosModelPickerSlot = useMemo(
    () =>
      config.agentId === 'matos' ? (
        <MatOSModelPicker
          selectedModelId={matosProviderModel}
          onChange={handleMatosProviderModelChange}
        />
      ) : undefined,
    [config.agentId, matosProviderModel, handleMatosProviderModelChange],
  );

  // Canonical project-type chip shown next to the editable title. We label
  // by the resolved skill/template `mode` (the real type taxonomy) rather
  // than the skill's display name, so every project kind reads as one
  // consistent, short type. Returns null for freeform projects (no
  // resolvable type), which hides the chip.
  const projectTypeLabel = useMemo<string | null>(() => {
    const summary =
      skills.find((s) => s.id === project.skillId) ??
      designTemplates.find((s) => s.id === project.skillId);
    switch (summary?.mode) {
      case 'prototype':
        return t('project.typePrototype');
      case 'deck':
        return t('project.typeDeck');
      case 'template':
        return t('project.typeTemplate');
      case 'image':
        return t('project.typeImage');
      case 'video':
        return t('project.typeVideo');
      case 'audio':
        return t('project.typeAudio');
      default:
        return null;
    }
  }, [skills, designTemplates, project.skillId, t]);

  // Signal that pushes a draft into the chat composer (the "Import repo" CTA).
  const [composerDraftSignal, setComposerDraftSignal] = useState<{ text: string; nonce: number }>();

  // Opens the workspace's Download/Export menu (PDF / image /
  // zip / standalone HTML / save-as-template) instead of a bare file download.
  const handleArtifactDownload = useCallback(
    (fileName: string) => {
      requestOpenFile(fileName);
      setDownloadRequest({ name: fileName, nonce: Date.now() });
    },
    [requestOpenFile],
  );

  const isDeck = useMemo(
    () =>
      (skills.find((s) => s.id === project.skillId) ??
        designTemplates.find((s) => s.id === project.skillId))?.mode === 'deck',
    [skills, designTemplates, project.skillId],
  );
  const chatResizeLabel = t('project.resizeChatPanel');
  const workspacePanelTrack =
    workspacePanelMinWidth === 0
      ? 'minmax(0, 1fr)'
      : `minmax(${workspacePanelMinWidth}px, 1fr)`;
  const splitLeftPanelWidth = leftInspectorActive
    ? COMMENT_INSPECTOR_PANEL_WIDTH
    : chatPanelWidthRef.current;
  const chatPanelAriaMinWidth = Math.min(MIN_CHAT_PANEL_WIDTH, chatPanelMaxWidth);

  const renderPreferredChatPanelWidth = useCallback((
    preferredWidth: number,
    maxWidth = chatPanelMaxWidthRef.current,
    options: { commitState?: boolean } = {},
  ): number => {
    const next = clampChatPanelWidth(preferredWidth, maxWidth);
    chatPanelWidthRef.current = next;
    applySplitChatPanelWidth(splitRef.current, next, workspacePanelTrack);
    if (options.commitState !== false) setChatPanelWidth(next);
    return next;
  }, [workspacePanelTrack]);

  const applyChatPanelWidth = useCallback((
    width: number,
    options: { commitState?: boolean } = {},
  ): number => {
    const nextPreferred = clampPreferredChatPanelWidth(
      clampChatPanelWidth(width, chatPanelMaxWidthRef.current),
    );
    preferredChatPanelWidthRef.current = nextPreferred;
    return renderPreferredChatPanelWidth(nextPreferred, chatPanelMaxWidthRef.current, options);
  }, [renderPreferredChatPanelWidth]);

  const finishChatPanelResize = useCallback((saveFinalWidth = true) => {
    pointerCleanupRef.current?.();
    pointerCleanupRef.current = null;
    if (pointerFrameRef.current !== null) {
      cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    pendingPointerClientXRef.current = null;
    resizeStateRef.current = null;
    setResizingChatPanel(false);
    if (saveFinalWidth) {
      const finalWidth = renderPreferredChatPanelWidth(preferredChatPanelWidthRef.current);
      saveChatPanelWidth(finalWidth);
    }
  }, [renderPreferredChatPanelWidth]);

  useEffect(() => {
    chatPanelWidthRef.current = chatPanelWidth;
    applySplitChatPanelWidth(splitRef.current, chatPanelWidth, workspacePanelTrack);
  }, [chatPanelWidth, workspacePanelTrack]);

  useEffect(() => {
    chatPanelMaxWidthRef.current = chatPanelMaxWidth;
  }, [chatPanelMaxWidth]);

  useLayoutEffect(() => {
    const split = splitRef.current;
    if (!split) return undefined;

    const updateAllowedWidth = () => {
      const splitWidth = split.clientWidth;
      const nextWorkspaceMin = workspacePanelMinWidthForSplit(splitWidth);
      const nextMax = maxChatPanelWidthForSplit(splitWidth);
      chatPanelMaxWidthRef.current = nextMax;
      setWorkspacePanelMinWidth(nextWorkspaceMin);
      setChatPanelMaxWidth(nextMax);
      renderPreferredChatPanelWidth(preferredChatPanelWidthRef.current, nextMax);
    };

    updateAllowedWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateAllowedWidth);
      observer.observe(split);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateAllowedWidth);
    return () => window.removeEventListener('resize', updateAllowedWidth);
  }, [renderPreferredChatPanelWidth]);

  useEffect(() => () => finishChatPanelResize(false), [finishChatPanelResize]);

  const handleChatResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const split = splitRef.current;
    if (!split) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerCleanupRef.current?.();
    setResizingChatPanel(true);
    resizeStartPreferredWidthRef.current = preferredChatPanelWidthRef.current;

    const updateWidthFromClientX = (clientX: number) => {
      const state = resizeStateRef.current;
      if (!state) return;
      const delta = clientX - state.startClientX;
      if (delta === 0 && !state.hasMoved) return;
      state.hasMoved = true;
      const rawWidth = state.startWidth + (state.isRtl ? -delta : delta);
      applyChatPanelWidth(rawWidth, { commitState: false });
    };

    const flushPendingPointerMove = () => {
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }
      const clientX = pendingPointerClientXRef.current;
      pendingPointerClientXRef.current = null;
      if (clientX !== null) updateWidthFromClientX(clientX);
    };

    resizeStateRef.current = {
      startClientX: event.clientX,
      startWidth: chatPanelWidthRef.current,
      isRtl: window.getComputedStyle(split).direction === 'rtl',
      hasMoved: false,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      pendingPointerClientXRef.current = moveEvent.clientX;
      if (pointerFrameRef.current !== null) return;
      pointerFrameRef.current = requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        flushPendingPointerMove();
      });
    };
    const handlePointerEnd = () => {
      flushPendingPointerMove();
      finishChatPanelResize(true);
    };
    const handlePointerCancel = () => {
      flushPendingPointerMove();
      preferredChatPanelWidthRef.current = resizeStartPreferredWidthRef.current;
      renderPreferredChatPanelWidth(resizeStartPreferredWidthRef.current);
      finishChatPanelResize(false);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handlePointerCancel);
    };

    pointerCleanupRef.current = cleanup;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handlePointerCancel);
  }, [applyChatPanelWidth, finishChatPanelResize, renderPreferredChatPanelWidth]);

  const handleChatResizeBlur = useCallback(() => {
    if (!pointerCleanupRef.current) return;
    preferredChatPanelWidthRef.current = resizeStartPreferredWidthRef.current;
    renderPreferredChatPanelWidth(resizeStartPreferredWidthRef.current);
    finishChatPanelResize(false);
  }, [finishChatPanelResize, renderPreferredChatPanelWidth]);

  const handleChatResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    const split = splitRef.current;
    const isRtl = split ? window.getComputedStyle(split).direction === 'rtl' : false;
    if (event.key === 'ArrowLeft') {
      nextWidth = chatPanelWidthRef.current + (isRtl ? 1 : -1) * CHAT_PANEL_KEYBOARD_STEP;
    } else if (event.key === 'ArrowRight') {
      nextWidth = chatPanelWidthRef.current + (isRtl ? -1 : 1) * CHAT_PANEL_KEYBOARD_STEP;
    } else if (event.key === 'Home') {
      nextWidth = MIN_CHAT_PANEL_WIDTH;
    } else if (event.key === 'End') {
      nextWidth = chatPanelMaxWidthRef.current;
    }
    if (nextWidth === null) return;
    event.preventDefault();
    const next = applyChatPanelWidth(nextWidth);
    saveChatPanelWidth(next);
  }, [applyChatPanelWidth]);

  // Hand the pending prompt to ChatPane exactly once per project. The local
  // project-scoped snapshot survives the conversation-id remount, while the
  // persisted pendingPrompt is cleared so refreshes and later entries do not
  // re-seed the composer.
  //
  // Auto-send case: when the project was created with
  // `autoSendFirstMessage`, app.tsx left a sessionStorage flag telling us
  // to fire the prompt as a real user message immediately. We must NOT
  // seed initialDraft in that case — otherwise the textarea echoes the
  // prompt while it is also streaming as the first user message. The ref
  // captures the prompt independently so downstream effects can still
  // dispatch the auto-send without going through initialDraft.
  const autoSendSeedRef = useRef<string | null>(null);
  const autoSendAttachmentsRef = useRef<ChatAttachment[] | null>(null);
  const autoSendContextRef = useRef<RunContextSelection | null>(null);
  const autoSendFirstMessageRef = useRef(false);
  if (autoSendSeedRef.current === null) {
    let isAutoSend = false;
    try {
      isAutoSend = Boolean(
        window.sessionStorage.getItem(autoSendFirstMessageKey(project.id)),
      );
    } catch {
      /* sessionStorage may be unavailable; treat as manual flow. */
    }
    autoSendFirstMessageRef.current = isAutoSend;
    autoSendSeedRef.current = isAutoSend ? (project.pendingPrompt ?? '') : '';
    autoSendAttachmentsRef.current = isAutoSend ? readAutoSendAttachments(project.id) : [];
    autoSendContextRef.current = isAutoSend ? readAutoSendContext(project.id) : null;
  }
  const initialWorkspaceContexts = autoSendContextRef.current?.workspaceItems ?? [];
  const [initialDraft, setInitialDraft] = useState<
    { projectId: string; value: string } | undefined
  >(
    autoSendSeedRef.current || !project.pendingPrompt
      ? undefined
      : { projectId: project.id, value: project.pendingPrompt },
  );
  useEffect(() => {
    const pendingPrompt = project.pendingPrompt;
    if (!pendingPrompt) return;
    if (autoSendFirstMessageRef.current) {
      autoSendSeedRef.current = pendingPrompt;
      onClearPendingPrompt();
      return;
    }
    setInitialDraft((current) =>
      current?.projectId === project.id
        ? current
        : { projectId: project.id, value: pendingPrompt },
    );
    onClearPendingPrompt();
  }, [project.id, project.pendingPrompt, onClearPendingPrompt]);
  const chatInitialDraft =
    initialDraft?.projectId === project.id ? initialDraft.value : undefined;
  const [projectDuplicateStarting, setProjectDuplicateStarting] = useState(false);
  const handleDuplicateProject = useCallback(() => {
    if (projectDuplicateStarting || !onDuplicateProject) return;
    setProjectDuplicateStarting(true);
    void Promise.resolve(onDuplicateProject(currentProject.id, {}))
      .catch((err) => {
        setProjectActionsToast({
          message: err instanceof Error ? err.message : String(err),
          details: null,
          tone: 'error',
        });
      })
      .finally(() => {
        setProjectDuplicateStarting(false);
      });
  }, [
    currentProject.id,
    onDuplicateProject,
    projectDuplicateStarting,
  ]);

  // Defensive: if the conversation already has messages once they
  // hydrate, the pendingPrompt that seeded the composer is stale (the
  // user sent it earlier but onClearPendingPrompt did not get a chance
  // to patch the server before the page reloaded). Drop the seed so the
  // textarea does not echo a prompt the user already submitted.
  useEffect(() => {
    if (initialDraft && messages.length > 0) {
      setInitialDraft(undefined);
    }
  }, [initialDraft, messages.length]);

  // Auto-send: when the user submits on Home, app.tsx
  // sets `sessionStorage['od:auto-send-first:<projectId>']` and routes
  // through createProject. Once the conversation id resolves and the
  // composer is mounted, fire handleSend(pendingPrompt) exactly once so
  // the user lands inside a running pipeline without an extra click.
  // We gate on `messages.length === 0` so a refresh after the run is
  // mid-flight never double-fires; the sessionStorage flag is cleared
  // immediately after the first dispatch.
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!activeConversationId) return;
    // Wait for the initial listMessages DB read to land. Without this gate
    // the auto-send fires before the in-flight DB response, which then
    // arrives with `setMessages([])` and wipes the freshly-pushed user +
    // assistant placeholder out of React state — leaving the daemon's run
    // with no in-memory message to attach the runId to.
    if (!messagesInitialized) return;
    if (streaming) return;
    if (messages.length > 0) return;
    let flag: string | null = null;
    try {
      flag = window.sessionStorage.getItem(autoSendFirstMessageKey(project.id));
    } catch {
      flag = null;
    }
    if (!flag) return;
    // Prefer the seed captured at mount (autoSendSeedRef) — it survives
    // even after onClearPendingPrompt wipes project.pendingPrompt on the
    // server. Fall back to the live values for any edge case where the
    // ref was not populated (e.g. sessionStorage error path).
    const seed = (
      autoSendSeedRef.current ||
      (initialDraft?.projectId === project.id ? initialDraft.value : '') ||
      project.pendingPrompt ||
      ''
    ).trim();
    const attachments = autoSendAttachmentsRef.current ?? [];
    const context = autoSendContextRef.current ?? readAutoSendContext(project.id);
    if (!seed && attachments.length === 0) {
      return;
    }
    autoSentRef.current = true;
    clearAutoSendSession(project.id);
    autoSendAttachmentsRef.current = [];
    void handleSend(seed, attachments, [], context ? { context } : undefined);
  }, [
    activeConversationId,
    messagesInitialized,
    streaming,
    messages.length,
    project.id,
    initialDraft,
    project.pendingPrompt,
    handleSend,
  ]);

  const evolutionJuryEnabled = useEvolutionJuryEnabled();

  // CLI / agent selector lives below the chat conversation (composer footer),
  // not in the top-right header.
  const executionControls = (
    <>
      <AvatarMenu
        config={projectScopedConfig}
        agents={projectScopedAgents}
        onOpen={() => {
                  }}
        onAgentChange={(id) => {
                    onAgentChange(id);
        }}
        onAgentModelChange={(agentId, choice) => {
                    if (agentId === 'matos') {
            handleMatosRoleChange(
              choice.model && choice.model !== 'default' ? choice.model : null,
            );
            return;
          }
          onAgentModelChange(agentId, choice);
        }}
        onOpenSettings={onOpenSettings}
        onRefreshAgents={onRefreshAgents}
        placement="up"
      />
    </>
  );

  return (
    <div className="app app-with-chats">
      <EvolutionJuryMount
        enabled={evolutionJuryEnabled}
        projectId={project.id}
        recentMinutes={24 * 60}
      />
      <ProjectConversationsSidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        filesActive={workspaceFocused}
        creatingConversation={creatingConversation}
        projectFiles={projectFiles}
        onSelectConversation={(id) => {
          setWorkspaceFocused(false);
          handleSelectConversation(id);
        }}
        onNewConversation={() => {
          setWorkspaceFocused(false);
          void handleNewConversation();
        }}
        onDeleteConversation={(id) => void handleDeleteConversation(id)}
        onRenameConversation={(id, title) => void handleRenameConversation(id, title)}
        onOpenFiles={() => {
          // The file manager lives on the workspace's Design Files tab. Flip to
          // the full-width workspace AND force that tab active — otherwise a
          // project whose last-open tab was a preview/artifact would land on
          // that tab instead of the file list, which reads as "the file
          // manager didn't open".
          setWorkspaceFocused(true);
          requestOpenFile(DESIGN_FILES_TAB);
        }}
        onInviteMembers={() => setMemberInviteOpen(true)}
        onManageAssets={() => setAssetPickerOpen(true)}
        selectedAssetCount={projectAssetRefs.length}
        onStartGroupChat={() => void handleStartGroupChat()}
        projectMemberRefs={projectMemberRefs}
        memberNames={projectMemberNames}
        {...(currentProject.metadata?.memberBriefs
          ? { memberBriefs: currentProject.metadata.memberBriefs }
          : {})}
        onOpenMemberChat={(roleRef, roleName) => void handleOpenMemberChat(roleRef, roleName)}
        onOpenAssetFile={(name) => {
          if (!activeConversationId) return;
          setWorkspaceFocused(true);
          navigate({
            kind: 'project',
            projectId: project.id,
            conversationId: activeConversationId,
            fileName: name,
          });
        }}
      />
      {memberInviteOpen ? (
        <MemberInviteDialog
          catalog={roleCatalog}
          invitedRefs={projectMemberRefs}
          invitedNames={projectMemberNames}
          saving={savingMembers}
          onSave={(refs, names) => void handleSaveMembers(refs, names)}
          onClose={() => setMemberInviteOpen(false)}
        />
      ) : null}
      {assetPickerOpen ? (
        <ProjectAssetPickerDialog
          projectId={project.id}
          selectedRefs={projectAssetRefs}
          versionPolicy={currentProject.metadata?.matosAssetVersionPolicy === 'pinned' ? 'pinned' : 'follow-accepted'}
          saving={savingProjectAssets}
          onSave={(refs) => void handleSaveProjectAssets(refs)}
          onClose={() => setAssetPickerOpen(false)}
        />
      ) : null}


      <div
        ref={splitRef}
        className={[
          projectSplitClassName(workspaceFocused),
          leftInspectorActive && !workspaceFocused ? 'split-manual-edit' : '',
          resizingChatPanel && !workspaceFocused ? 'is-resizing-chat' : '',
        ].filter(Boolean).join(' ')}
        style={projectSplitStyle(workspaceFocused, splitLeftPanelWidth, workspacePanelTrack)}
      >
        {isPhonePager && !workspaceFocused ? (
          // Phone pager page 1 — the project hub (conversations incl. group
          // chats, members with DM entry, invite, asset drafts). The desktop
          // sidebar is display:none at this width, so without this page group
          // chat simply has no phone entry point. Picking anything hops the
          // pager back to the chat page.
          <div className="split-hub-slot" data-testid="project-hub-page">
            <ProjectConversationsSidebar
              variant="page"
              conversations={conversations}
              activeConversationId={activeConversationId}
              filesActive={workspaceFocused}
              creatingConversation={creatingConversation}
              projectFiles={projectFiles}
              onSelectConversation={(id) => {
                handleSelectConversation(id);
                swipeToChatPage(true);
              }}
              onNewConversation={() => {
                void handleNewConversation().then(() => swipeToChatPage(true));
              }}
              onDeleteConversation={(id) => void handleDeleteConversation(id)}
              onRenameConversation={(id, title) => void handleRenameConversation(id, title)}
              onOpenFiles={() => {
                setWorkspaceFocused(true);
                requestOpenFile(DESIGN_FILES_TAB);
              }}
              onInviteMembers={() => setMemberInviteOpen(true)}
              onManageAssets={() => setAssetPickerOpen(true)}
              selectedAssetCount={projectAssetRefs.length}
              onStartGroupChat={() => {
                void handleStartGroupChat().then(() => swipeToChatPage(true));
              }}
              projectMemberRefs={projectMemberRefs}
              memberNames={projectMemberNames}
              {...(currentProject.metadata?.memberBriefs
                ? { memberBriefs: currentProject.metadata.memberBriefs }
                : {})}
              onOpenMemberChat={(roleRef, roleName) => {
                void handleOpenMemberChat(roleRef, roleName).then(() => swipeToChatPage(true));
              }}
              onOpenAssetFile={(name) => {
                if (!activeConversationId) return;
                setWorkspaceFocused(true);
                navigate({
                  kind: 'project',
                  projectId: project.id,
                  conversationId: activeConversationId,
                  fileName: name,
                });
              }}
            />
          </div>
        ) : null}
        <div className="split-chat-slot" ref={splitChatSlotRef} hidden={workspaceFocused}>
          {commentInspectorActive ? (
            <div
              id={commentInspectorPortalId}
              className="comment-left-host"
              aria-label="Comments"
            />
          ) : activeConversationId || conversationLoadError ? (
            <ChatPane
              // The conversation id is part of the key so switching conversations
              // resets internal scroll/draft state inside ChatPane and ChatComposer.
              key={`${project.id}:${activeConversationId ?? 'conversation-unavailable'}`}
              messages={messages}
              streaming={currentConversationControlStreaming}
              liveToolInput={liveToolInput}
              loading={currentConversationLoading}
              hasOlderMessages={olderMessageCursor !== null}
              olderMessagesLoading={olderMessagesLoading}
              onLoadOlderMessages={loadOlderMessages}
              sendDisabled={currentConversationSendDisabled}
              queuedItems={currentConversationQueuedItems}
              error={conversationLoadError ?? error}
              projectId={project.id}
              sessionMode={activeSessionMode}
              onSessionModeChange={handleActiveConversationSessionModeChange}
              projectFiles={projectFiles}
              activeProjectFileName={activeProjectFileName}
              projectFileNames={projectFileNames}
              skills={skills}
              onEnsureProject={handleEnsureProject}
              previewComments={previewComments}
              attachedComments={attachedComments}
              onAttachComment={attachPreviewComment}
              onDetachComment={detachPreviewComment}
              onDeleteComment={(commentId) => void removePreviewComment(commentId)}
              onSend={handleSend}
              onRetry={handleRetry}
              onResumeRun={handleResumeRun}
              onStop={handleStop}
              onRemoveQueuedSend={removeQueuedChatSend}
              onUpdateQueuedSend={updateQueuedChatSend}
              onReorderQueuedSends={reorderCurrentConversationQueuedChatSends}
              onSendQueuedNow={sendQueuedChatSendNow}
              onRequestOpenFile={requestOpenFile}
              initialDraft={chatInitialDraft}
              onOpenQuestions={openQuestionsTab}
              onContinueRemainingTasks={handleContinueRemainingTasks}
              onAssistantFeedback={handleAssistantFeedback}
              onArtifactDownload={handleArtifactDownload}
              onForkFromMessage={handleForkFromMessage}
              forkingMessageId={forkingMessageId}
              onNewConversation={handleNewConversation}
              newConversationDisabled={newConversationDisabled}
              conversations={conversations}
              activeConversationId={activeConversationId}
              messagesConversationId={messagesConversationId}
              onSelectConversation={handleSelectConversation}
              onDeleteConversation={handleDeleteConversation}
              onRenameConversation={(id, title) => void handleRenameConversation(id, title)}
              onManageGroupMembers={() => setMemberInviteOpen(true)}
              groupAutoRelay={groupAutoRelay}
              onGroupAutoRelayChange={handleGroupAutoRelayChange}
              groupMemberNames={projectMemberNames}
              config={config}
              onOpenSettings={onOpenSettings}
              onOpenMcpSettings={onOpenMcpSettings}
              composerDraftSignal={composerDraftSignal}
              researchAvailable
              projectMetadata={currentProject.metadata}
              onProjectMetadataChange={(metadata) => {
                onProjectChange({ ...project, metadata });
              }}
              activeWorkspaceContext={activeWorkspaceContext}
              initialWorkspaceContexts={initialWorkspaceContexts}
              workspaceContexts={workspaceContexts}
              currentSkillId={project.skillId}
              onProjectSkillChange={(skillId) => {
                onProjectChange({ ...project, skillId });
              }}
              onShowToast={(message) => {
                setProjectActionsToast({ message, details: null });
              }}
              onBack={onBack}
              backLabel={t('project.backToProjects')}
              composerFooterAccessory={executionControls}
              projectHeader={(
                <span className="chat-project-title-line">
                  <span
                    className="title editable"
                    data-testid="project-title"
                    title={project.name}
                    tabIndex={0}
                    role="textbox"
                    suppressContentEditableWarning
                    contentEditable
                    onBlur={(e) => handleProjectRename(e.currentTarget.textContent ?? '')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.currentTarget as HTMLElement).blur();
                      }
                    }}
                  >
                    {project.name}
                  </span>
                  {projectTypeLabel ? (
                    <span className="meta" data-testid="project-meta">{projectTypeLabel}</span>
                  ) : null}
                </span>
              )}
              matosRolePicker={
                renderProjectMatosRolePicker(activeConversationId)
              }
              matosModelPicker={matosModelPickerSlot}
              onSetMatosProviderModel={
                config.agentId === 'matos'
                  ? handleMatosProviderModelChange
                  : undefined
              }
            />
          ) : (
            <div className="pane" data-testid="chat-pane-loading">
              <CenteredLoader />
            </div>
          )}
        </div>
        {!workspaceFocused ? (
          leftInspectorActive ? (
            <div className="split-edit-divider" aria-hidden />
          ) : (
            <div
              className="split-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label={chatResizeLabel}
              aria-valuemin={chatPanelAriaMinWidth}
              aria-valuemax={chatPanelMaxWidth}
              aria-valuenow={chatPanelWidth}
              tabIndex={0}
              title={chatResizeLabel}
              onPointerDown={handleChatResizePointerDown}
              onKeyDown={handleChatResizeKeyDown}
              onBlur={handleChatResizeBlur}
            />
          )
        ) : null}
        <FileWorkspace
          projectId={project.id}
          projectKind={workspaceProjectKind(currentProject.metadata)}
          rootDirName={(() => {
            const baseDir = currentProject.metadata?.baseDir;
            return typeof baseDir === 'string'
              ? baseDir.split(/[/\\]/).filter(Boolean).pop()
              : undefined;
          })()}
          reloading={false}
          resolvedDir={projectDetail.resolvedDir}
          files={projectFiles}
          filePaging={filePaging}
          filesRefreshKey={filesRefresh}
          onRefreshFiles={() => {
            return refreshWorkspaceItems().then(() => undefined);
          }}
          isDeck={isDeck}
          streaming={currentConversationActionDisabled}
          commentQueueOnSend={commentQueueOnSend}
          commentSendDisabled={currentConversationQueueDisabled}
          openRequest={openRequest}
          downloadRequest={downloadRequest}
          slideNavRequest={slideNavRequest}
          tabsState={openTabsState}
          onTabsStateChange={persistTabsState}
          previewComments={previewComments}
          onSavePreviewComment={savePreviewComment}
          onRemovePreviewComment={removePreviewComment}
          onSendBoardCommentAttachments={handleSendBoardCommentAttachments}
          preferredPreviewFile={currentProject.metadata?.entryFile ?? null}
          autoPreviewDesignArtifacts={currentProject.metadata?.importedFrom === 'folder'}
          focusMode={workspaceFocused}
          onFocusModeChange={setWorkspaceFocused}
          onDuplicateProject={onDuplicateProject ? handleDuplicateProject : undefined}
          duplicateProjectBusy={projectDuplicateStarting}
          commentPortalId={commentInspectorPortalId}
          onCommentModeChange={setCommentInspectorActive}
          chatConfig={config}
          chatAgentsById={agentsById}
          chatLocale={locale}
          projectMemberRefs={projectMemberRefs}
          projectMatosRoleRef={selectedProjectMatosRoleId}
          renderMatosRolePicker={renderProjectMatosRolePicker}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          onConversationSessionModeChange={handleConversationSessionModeChange}
          onNewConversation={handleNewConversation}
          activeConversationChat={activeConversationChatState}
          onActiveContextChange={handleActiveWorkspaceContextChange}
          onWorkspaceContextsChange={handleWorkspaceContextsChange}
          messages={messages}
          artifactHtml={artifact?.html}
          conversationError={error}
          onRetry={handleRetry}
          conversationId={activeConversationId}
          headerActions={(
            <>
              <EntrySettingsMenu
                config={config}
                onThemeChange={handleThemeChange}
                onOpenSettings={onOpenSettings}
              />
            </>
          )}
          questionForm={displayedQuestionForm}
          questionFormPreview={displayedQuestionFormPreview}
          questionFormKey={displayedQuestionFormKey}
          questionFormInteractive={displayedQuestionFormActive}
          questionFormSubmitDisabled={currentConversationActionDisabled}
          questionFormSubmittedAnswers={displayedQuestionFormSubmittedAnswers}
          questionsGenerating={displayedQuestionsGenerating}
          focusQuestionsRequest={focusQuestionsRequest}
          onSubmitQuestionForm={(text) => {
            if (currentConversationActionDisabled) return;
            // Submitting question-form answers is a clarification turn, not a
            // fresh create/edit — tag entry_from so the dashboard can separate it.
            void handleSend(text, [], []);
          }}
          planDoc={planCanvasDoc}
          focusPlanRequest={focusPlanRequest}
          onApprovePlan={handleApprovePlan}
          planApproveDisabled={currentConversationActionDisabled}
          onRefinePlan={handleRefinePlan}
        />
      </div>
      {isPhonePager && !workspaceFocused ? (
        // Phone pager position dots (hub | chat | canvas). Presentation-only:
        // swiping is the navigation, the dots just make the side pages
        // discoverable. Styled by styles/mobile2/project-pager.css.
        <div className="split-pager-dots" data-page={pagerPage} aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      ) : null}
      <AnimatePresence>
        {projectActionsToast ? (
          <Toast
            message={projectActionsToast.message}
            details={projectActionsToast.details}
            code={projectActionsToast.code}
            tone={projectActionsToast.tone}
            ttlMs={projectActionsToast.ttlMs}
            onDismiss={() => setProjectActionsToast(null)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function artifactExtensionFor(art: Artifact): '.html' | '.jsx' | '.tsx' {
  const type = (art.artifactType || '').toLowerCase();
  const identifier = (art.identifier || '').toLowerCase();
  if (type.includes('tsx') || identifier.endsWith('.tsx')) return '.tsx';
  if (type.includes('jsx') || type.includes('react') || identifier.endsWith('.jsx')) {
    return '.jsx';
  }
  return '.html';
}

function artifactBaseNameFor(art: Artifact): string {
  return (
    (art.identifier || art.title || 'artifact')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact'
  );
}

export function findExistingArtifactProjectFile(
  art: Artifact,
  projectFiles: ProjectFile[],
  options: { minMtime?: number } = {},
): ProjectFile | null {
  const ext = artifactExtensionFor(art);
  const baseName = artifactBaseNameFor(art);
  const candidateFileName = `${baseName}${ext}`;
  const currentRunFiles = filterProjectFilesByMinMtime(projectFiles, options.minMtime);

  if (ext === '.html') {
    const pointerTarget = resolveHtmlPointerArtifactTarget({
      content: art.html,
      candidateFileName,
      projectFiles: currentRunFiles,
    });
    const pointerFile = pointerTarget
      ? currentRunFiles.find((file) => file.name === pointerTarget || file.path === pointerTarget)
      : null;
    if (pointerFile) return pointerFile;
  }

  const identifier = art.identifier || '';
  if (identifier) {
    const manifestMatches = currentRunFiles
      .filter((file) => file.artifactManifest?.metadata?.identifier === identifier)
      .sort((a, b) => b.mtime - a.mtime);
    if (manifestMatches[0]) return manifestMatches[0];
  }

  return currentRunFiles.find((file) => file.name === candidateFileName) ?? null;
}

function filterProjectFilesByMinMtime(
  projectFiles: readonly ProjectFile[],
  minMtime?: number,
): ProjectFile[] {
  return typeof minMtime === 'number' && Number.isFinite(minMtime)
    ? projectFiles.filter((file) => file.mtime >= minMtime)
    : [...projectFiles];
}

export function selectPrimaryProjectFile(files: ProjectFile[]): ProjectFile | null {
  const candidates = files
    .filter((file) => !isProcessArtifactFile(file.name))
    .map((file) => ({ file, rank: primaryProjectFileRank(file) }))
    .filter((candidate) => Number.isFinite(candidate.rank));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.rank - b.rank || b.file.mtime - a.file.mtime);
  return candidates[0]?.file ?? null;
}

function isProcessArtifactFile(name: string): boolean {
  const base = name.split('/').pop()?.toLowerCase() ?? name.toLowerCase();
  return (
    base.endsWith('.log')
    || base.endsWith('.meta.json')
    || base.endsWith('.artifact.json')
    || base.endsWith('.map')
  );
}

function primaryProjectFileRank(file: ProjectFile): number {
  if (manifestDeclaresPrimary(file)) return 0;
  if (file.artifactManifest && file.artifactManifest.metadata?.inferred !== true) return 1;
  if (file.kind === 'html') return 2;
  if (file.kind === 'image') return 3;
  if (file.kind === 'video') return 4;
  if (file.kind === 'pdf') return 6;
  if (file.kind === 'presentation') return 7;
  if (file.kind === 'document') return 8;
  if (file.kind === 'spreadsheet') return 9;
  return Number.POSITIVE_INFINITY;
}

function manifestDeclaresPrimary(file: ProjectFile): boolean {
  const manifest = file.artifactManifest;
  if (!manifest) return false;
  if (primaryValueTargetsFile(manifest.primary, file.name)) return true;
  const metadata = manifest.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  if (primaryValueTargetsFile(metadata.primary, file.name)) return true;
  const outputs = metadata.outputs;
  if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) {
    return primaryValueTargetsFile(
      (outputs as { primary?: unknown }).primary,
      file.name,
    );
  }
  return false;
}

function primaryValueTargetsFile(value: unknown, fileName: string): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return normalizeProjectFileName(value) === normalizeProjectFileName(fileName);
}

function normalizeProjectFileName(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
}


function isTerminalRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function isActiveRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'queued' || status === 'running';
}

/** A daemon run-status snapshot, as returned by `fetchChatRunStatus`/`listActiveChatRuns`. */
type RunStatusSnapshot = Awaited<ReturnType<typeof fetchChatRunStatus>>;

/**
 * Resolves the authoritative `endedAt` for a terminal-recovery branch.
 *
 * Invariant: every terminal-recovery branch (reload reattach, generic
 * disconnect retry-cap probe, stale/legacy row replay) must stamp `endedAt`
 * from an authoritative TERMINAL `updatedAt` — a status snapshot whose
 * `status` is terminal (succeeded/canceled/failed), observed at the END of
 * recovery — never from a pre-reattach/heartbeat snapshot or a stale
 * disconnect-time value.
 *
 * `candidate` is whatever status snapshot the caller already has in hand
 * (e.g. fetched before `reattachDaemonRun` started, which may still read
 * 'running'/'queued' if the daemon only finished afterward). When it is
 * already terminal, its `updatedAt` IS the authoritative value and is
 * returned with no extra round trip. When it is missing or still active, a
 * fresh probe is taken via `fetchChatRunStatus` — the daemon may have
 * finished in the interim — and used if terminal. If the fresh probe is
 * also unavailable or non-terminal, `Date.now()` is the last-resort
 * fallback so `endedAt` is never left unset.
 */
async function resolveTerminalEndedAt(
  runId: string,
  candidate: RunStatusSnapshot | null | undefined,
): Promise<number> {
  if (candidate && !isActiveRunStatus(candidate.status)) {
    return candidate.updatedAt;
  }
  const probed = await fetchChatRunStatus(runId).catch(() => null);
  if (probed && !isActiveRunStatus(probed.status)) {
    return probed.updatedAt;
  }
  return Date.now();
}

export function hasRecoverableArtifactMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (!message.runId) return false;
  if (!isTerminalRunStatus(message.runStatus)) return false;
  if (message.producedFiles?.length) return false;
  const sourceText = message.content.trim().length > 0
    ? message.content
    : textContentFromAgentEvents(message.events);
  return artifactFromRecoverableSourceText(sourceText) !== null;
}

function artifactFromRecoverableSourceText(sourceText: string): Artifact | null {
  const parser = createArtifactParser();
  let parsedArtifact: Artifact | null = null;
  let liveHtml = '';
  for (const ev of [...parser.feed(sourceText), ...parser.flush()]) {
    if (ev.type === 'artifact:start') {
      liveHtml = '';
      parsedArtifact = {
        identifier: ev.identifier,
        artifactType: ev.artifactType,
        title: ev.title,
        html: '',
      };
    } else if (ev.type === 'artifact:chunk') {
      liveHtml += ev.delta;
      parsedArtifact = artifactWithHtml(parsedArtifact, ev.identifier, liveHtml);
    } else if (ev.type === 'artifact:end') {
      parsedArtifact = artifactWithHtml(parsedArtifact, ev.identifier, ev.fullContent);
    }
  }
  if (parsedArtifact?.html) return parsedArtifact;

  const html = recoverStandaloneHtmlDocument(sourceText)
    ?? recoverHtmlDocumentFromMarkdownFence(sourceText);
  if (!html) return null;
  return {
    identifier: 'response',
    artifactType: 'text/html',
    title: 'Response',
    html,
  };
}

function shouldReplayTerminalRunMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (!message.runId) return false;
  if (message.runStatus !== 'succeeded') return false;
  if (message.content.trim().length > 0) return false;
  if (
    message.startedAt == null
    && !message.preTurnFileNames?.length
    && textContentFromAgentEvents(message.events).trim().length === 0
  ) {
    return false;
  }
  return !(message.producedFiles?.length);
}

function textContentFromAgentEvents(events?: AgentEvent[]): string {
  return (events ?? [])
    .filter((event): event is Extract<AgentEvent, { kind: 'text' }> => event.kind === 'text')
    .map((event) => event.text)
    .join('');
}

const QUEUED_CHAT_SENDS_STORAGE_VERSION = 1;

function queuedChatSendsStorageKey(projectId: string): string {
  return `od:chat-queued-sends:${projectId}:v${QUEUED_CHAT_SENDS_STORAGE_VERSION}`;
}

function loadQueuedChatSends(projectId: string): QueuedChatSend[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(queuedChatSendsStorageKey(projectId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedChatSend).slice(0, 100);
  } catch {
    return [];
  }
}

function saveQueuedChatSends(projectId: string, items: QueuedChatSend[]): void {
  if (typeof window === 'undefined') return;
  try {
    const key = queuedChatSendsStorageKey(projectId);
    if (items.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(items.slice(0, 100)));
  } catch {
    // Ignore private-mode/quota failures. The in-memory queue still works.
  }
}

function isQueuedChatSend(value: unknown): value is QueuedChatSend {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
  const record = value as Partial<QueuedChatSend>;
  return (
    typeof record.id === 'string' &&
    typeof record.conversationId === 'string' &&
    typeof record.prompt === 'string' &&
    Array.isArray(record.attachments) &&
    Array.isArray(record.commentAttachments) &&
    typeof record.createdAt === 'number'
  );
}

// Plan body of a plan-mode assistant turn. When the CLI's plan loop reached
// ExitPlanMode, that tool call's normalized input carries the canonical plan
// document; otherwise (headless plan mode usually) the answer text IS the plan.
function planMarkdownOfMessage(message: ChatMessage): string {
  const events = Array.isArray(message.events) ? message.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'tool_use' && event.name === 'ExitPlanMode') {
      const input = event.input as { plan?: unknown } | null | undefined;
      if (input && typeof input.plan === 'string' && input.plan.trim()) {
        return input.plan;
      }
    }
  }
  return message.content ?? '';
}

function stripQueueOnlyFromMeta(meta: ChatSendMeta | undefined): ProjectChatSendMeta | undefined {
  if (!meta) return undefined;
  const { queueOnly: _queueOnly, ...rest } = meta;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export interface RetryTarget {
  failedAssistant: ChatMessage;
  userMsg: ChatMessage;
  priorMessages: ChatMessage[];
  preservedAttempts: ChatMessage[];
}

export function resolveRetryTarget(
  messages: ChatMessage[],
  failedAssistantId: string,
): RetryTarget | null {
  const failedIndex = messages.findIndex(
    (message) =>
      message.id === failedAssistantId &&
      message.role === 'assistant' &&
      message.runStatus === 'failed',
  );
  if (failedIndex <= 0 || failedIndex !== messages.length - 1) return null;

  let userIndex = failedIndex - 1;
  while (
    userIndex >= 0 &&
    messages[userIndex]?.role === 'assistant' &&
    messages[userIndex]?.runStatus === 'failed'
  ) {
    userIndex -= 1;
  }

  const userMsg = messages[userIndex];
  const failedAssistant = messages[failedIndex];
  if (!userMsg || userMsg.role !== 'user' || !failedAssistant) return null;

  return {
    failedAssistant,
    userMsg,
    priorMessages: messages.slice(0, userIndex),
    preservedAttempts: messages.slice(userIndex + 1, failedIndex + 1),
  };
}

// A daemon assistant message that is "queued/running" but has no runId yet
// is in-flight on the client: POST /api/runs has not returned. Persisting it
// in this state creates a phantom DB row that the reattach loop can never
// recover (the daemon either never saw the request or the response was lost),
// which is what produced the "Working 24m+" stuck UI. Treat the in-flight
// window as ephemeral and only write to DB once a runId pins the row to a
// real daemon run — or once the run reaches a terminal state.
function isPhantomDaemonRunMessage(m: ChatMessage): boolean {
  return (
    m.role === 'assistant' &&
    isActiveRunStatus(m.runStatus) &&
    !m.runId
  );
}

function isStoppableAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false;
  if (isActiveRunStatus(message.runStatus)) return true;
  return message.runStatus === undefined && message.endedAt === undefined && message.startedAt !== undefined;
}

export function resolveSucceededRunStatus(status: ChatMessage['runStatus']): ChatMessage['runStatus'] {
  return status === 'failed' || status === 'canceled' ? status : 'succeeded';
}

export function computeProducedFiles(
  beforeNames: ReadonlySet<string> | readonly string[] | undefined,
  next: readonly ProjectFile[],
  beforeSnapshot: ReadonlyArray<Pick<ProjectFile, 'name' | 'size' | 'mtime' | 'etag'>> = [],
): ProjectFile[] | undefined {
  if (!beforeNames) return undefined;
  const set = beforeNames instanceof Set ? beforeNames : new Set(beforeNames);
  const previous = new Map(beforeSnapshot.map(file => [file.name, file]));
  return filterImplicitProducedFiles(next.filter((file) => {
    if (!set.has(file.name)) return true;
    const before = previous.get(file.name);
    if (!before) return false;
    if (before.etag && file.etag) return before.etag !== file.etag;
    return before.size !== file.size || before.mtime !== file.mtime;
  })).map(file => ({
    ...file,
    ...(set.has(file.name) ? { traceObjectReason: 'modified' as const } : {}),
  }));
}

export function computeTraceObjectFiles(
  beforeNames: ReadonlySet<string> | readonly string[] | undefined,
  next: readonly ProjectFile[],
  touchedPaths: Iterable<string> = [],
): ProjectFile[] | undefined {
  if (!beforeNames) return undefined;
  const set = beforeNames instanceof Set ? beforeNames : new Set(beforeNames);
  const byName = new Map<string, ProjectFile>();
  for (const file of filterImplicitProducedFiles(next.filter((f) => !set.has(f.name)))) {
    byName.set(file.name, { ...file, traceObjectReason: 'new' });
  }
  for (const rawPath of touchedPaths) {
    const file = findTouchedProjectFile(rawPath, next);
    if (!file) continue;
    byName.set(file.name, {
      ...file,
      traceObjectReason: set.has(file.name) ? 'modified' : 'new',
    });
  }
  return [...byName.values()];
}

function findTouchedProjectFile(rawPath: string, files: readonly ProjectFile[]): ProjectFile | null {
  const normalized = normalizeComparableFilePath(rawPath);
  if (!normalized) return null;
  const hasPathSeparator = normalized.includes('/');
  const basename = normalized.split('/').pop() ?? normalized;
  const normalizedFiles = files.map((file) => ({
    file,
    candidates: [
      normalizeComparableFilePath(file.path ?? ''),
      normalizeComparableFilePath(file.name),
    ].filter(Boolean),
  }));

  const matches = (predicate: (candidate: string) => boolean): ProjectFile[] => {
    const matched: ProjectFile[] = [];
    for (const { file, candidates } of normalizedFiles) {
      if (candidates.some(predicate)) matched.push(file);
    }
    return matched;
  };

  const exact = matches((candidate) => candidate === normalized);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;

  const suffix = matches((candidate) =>
    candidate.includes('/') &&
    (candidate.endsWith(`/${normalized}`) || normalized.endsWith(`/${candidate}`)),
  );
  if (suffix.length === 1) return suffix[0]!;
  if (suffix.length > 1) return null;

  if (hasPathSeparator) return null;

  const basenameMatches = normalizedFiles.filter(({ candidates }) =>
    candidates.some((candidate) => candidate.split('/').pop() === basename),
  );
  return basenameMatches.length === 1 ? basenameMatches[0]!.file : null;
}

function normalizeComparableFilePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

// Reattach with a recovered (on-disk) artifact must still include any
// other files the turn produced before the artifact write — replacing
// the diff with a single file was the regression noted on PR #2383.
export function mergeRecoveredArtifact(
  diff: readonly ProjectFile[],
  recovered: ProjectFile | null,
): ProjectFile[] {
  if (!recovered) return [...diff];
  if (diff.some((f) => f.name === recovered.name)) return [...diff];
  return [...diff, recovered];
}

export async function findSameTurnHtmlWriteForRecoveredArtifact({
  artifactHtml,
  producedFiles,
  readProjectHtml,
}: {
  artifactHtml: string;
  producedFiles: readonly ProjectFile[];
  readProjectHtml: (name: string) => Promise<string | null>;
}): Promise<ProjectFile | null> {
  const recovered = normalizeHtmlForRecoveredArtifactComparison(artifactHtml);
  if (!recovered) return null;
  const candidates = producedFiles.filter(isHtmlProjectFile);
  if (candidates.length === 0) return null;
  const contents = await Promise.all(candidates.map((file) => readProjectHtml(file.name)));
  const normalized = contents.map(normalizeHtmlForRecoveredArtifactComparison);
  // Bind only on an exact normalized-content match. This is inherently
  // agent-agnostic (#4308): whenever a filesystem-backed CLI writes an HTML
  // file and echoes the same document as an artifact, the normalized contents
  // are equal and we suppress the duplicate — no Claude-specific gate needed.
  //
  // We deliberately do NOT bind on a content *mismatch*. A differing same-turn
  // HTML file is a genuinely different document and must persist on its own.
  // A blind single-file bind also mis-fired across queued runs: the pre-turn
  // file snapshot for a queued run can predate the previous run's persist, so
  // computeProducedFiles() reports that earlier artifact as "produced this
  // turn" and we'd bind the echo to the wrong, unrelated file.
  const exact = candidates.find((_file, i) => normalized[i] === recovered);
  return exact ?? null;
}

function isHtmlProjectFile(file: ProjectFile): boolean {
  const name = (file.path || file.name).toLowerCase();
  return file.kind === 'html' || /\.(?:html?|xhtml)$/u.test(name);
}

function normalizeHtmlForRecoveredArtifactComparison(value: string | null | undefined): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function mergeRecoveredTraceObjectFile(
  files: readonly ProjectFile[],
  recovered: ProjectFile | null,
): ProjectFile[] {
  const out = [...files];
  if (!recovered) return out;
  const existing = out.findIndex((file) => file.name === recovered.name);
  const tagged = { ...recovered, traceObjectReason: 'recovered' as const };
  if (existing >= 0) {
    out[existing] = { ...out[existing]!, traceObjectReason: out[existing]!.traceObjectReason ?? 'recovered' };
    return out;
  }
  return [...out, tagged];
}

export function extractTouchedFilePathsFromEvents(events: ChatMessage['events']): string[] {
  if (!Array.isArray(events)) return [];
  const pending = new Map<string, string>();
  const touched: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const rec = event as Record<string, unknown>;
    if (rec.kind === 'tool_use' && isFileWriteToolName(rec.name)) {
      const filePath = extractFileWriteToolPath(rec.input);
      if (typeof rec.id === 'string' && typeof filePath === 'string' && filePath) {
        pending.set(rec.id, filePath);
      }
    }
    if (rec.kind === 'tool_result') {
      const toolUseId = typeof rec.toolUseId === 'string'
        ? rec.toolUseId
        : typeof rec.tool_use_id === 'string'
          ? rec.tool_use_id
          : '';
      const filePath = pending.get(toolUseId);
      if (!filePath) continue;
      pending.delete(toolUseId);
      if (rec.isError !== true) touched.push(filePath);
    }
  }
  return touched;
}

function isFileWriteToolName(value: unknown): boolean {
  return (
    value === 'Write'
    || value === 'write'
    || value === 'create_file'
    || value === 'Edit'
    || value === 'str_replace_edit'
    || value === 'MultiEdit'
    || value === 'multi_edit'
  );
}

function extractFileWriteToolPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const filePath = rec.file_path ?? rec.filePath ?? rec.path;
  return typeof filePath === 'string' && filePath ? filePath : null;
}

export function clearStreamingConversationMarker(
  currentConversationId: string | null,
  completedConversationId?: string | null,
): string | null {
  if (
    completedConversationId !== undefined
    && completedConversationId !== null
    && currentConversationId !== completedConversationId
  ) {
    return currentConversationId;
  }
  return null;
}

export function shouldClearActiveRunRefs(
  currentConversationId: string | null,
  completedConversationId: string,
): boolean {
  return currentConversationId === completedConversationId;
}

export function finalizeActiveAssistantMessagesOnStop(
  messages: ChatMessage[],
  stoppedAt: number,
): { messages: ChatMessage[]; finalized: ChatMessage[] } {
  const finalized: ChatMessage[] = [];
  const next = messages.map((message) => {
    if (!isStoppableAssistantMessage(message)) {
      return message;
    }
    const updated = {
      ...message,
      runStatus: 'canceled' as const,
      endedAt: message.endedAt ?? stoppedAt,
    };
    finalized.push(updated);
    return updated;
  });
  return { messages: next, finalized };
}

type BufferedTextUpdates = ReturnType<typeof createBufferedTextUpdates>;

export function appendCoalescedAgentEvent(
  events: AgentEvent[] | undefined,
  event: AgentEvent,
): AgentEvent[] {
  const current = events ?? [];
  const last = current[current.length - 1];
  if (
    (event.kind === 'text' || event.kind === 'thinking') &&
    last?.kind === event.kind
  ) {
    return [
      ...current.slice(0, -1),
      { ...last, text: last.text + event.text },
    ];
  }
  return [...current, event];
}

export function createBufferedTextUpdates({
  updateMessage,
  persistSoon,
  flushAndPersistNow,
  onContentDelta,
}: {
  updateMessage: (updater: (prev: ChatMessage) => ChatMessage) => void;
  persistSoon: () => void;
  // Synchronous flush + persist with a transport that survives page
  // unload (PUT with keepalive). Invoked by the pagehide handler so the
  // last buffered chunk isn't lost when the user reloads mid-stream.
  flushAndPersistNow?: () => void;
  onContentDelta?: (delta: string) => void;
}) {
  let pendingContentDelta = '';
  let pendingTextEventDelta = '';
  let flushFrame: number | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let flushing = false;
  let needsFlush = false;
  const hasDocument = typeof document !== 'undefined';
  const hasWindow = typeof window !== 'undefined';

  const cancelScheduledFlush = () => {
    if (flushFrame !== null) {
      cancelAnimationFrame(flushFrame);
      flushFrame = null;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = () => {
    if (disposed) return;
    if (flushing) {
      needsFlush = true;
      return;
    }
    cancelScheduledFlush();
    if (!pendingContentDelta && !pendingTextEventDelta && !needsFlush) return;
    flushing = true;
    needsFlush = false;
    const contentDelta = pendingContentDelta;
    const textEventDelta = pendingTextEventDelta;
    pendingContentDelta = '';
    pendingTextEventDelta = '';
    try {
      updateMessage((prev) => ({
        ...prev,
        content: prev.content + contentDelta,
        events: textEventDelta
          ? appendCoalescedAgentEvent(prev.events, { kind: 'text', text: textEventDelta })
          : prev.events,
      }));
      persistSoon();
      if (contentDelta) onContentDelta?.(contentDelta);
    } finally {
      flushing = false;
    }
    if (pendingContentDelta || pendingTextEventDelta || needsFlush) {
      needsFlush = false;
      scheduleFlush();
    }
  };

  const scheduleFlush = () => {
    if (disposed || flushFrame !== null || flushTimer !== null) return;
    flushFrame = requestAnimationFrame(() => {
      flushFrame = null;
      flush();
    });
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 250);
  };

  const appendContent = (delta: string) => {
    if (disposed) return;
    pendingContentDelta += delta;
    needsFlush = true;
    scheduleFlush();
  };

  const appendTextEvent = (delta: string) => {
    if (disposed) return;
    pendingTextEventDelta += delta;
    needsFlush = true;
    scheduleFlush();
  };

  const appendEvent = (ev: AgentEvent) => {
    if (disposed) return;
    if (ev.kind === 'text') {
      appendTextEvent(ev.text);
      return;
    }
    flush();
    updateMessage((prev) => ({
      ...prev,
      events: appendCoalescedAgentEvent(prev.events, ev),
    }));
    persistSoon();
  };

  const cancel = () => {
    disposed = true;
    cancelScheduledFlush();
    pendingContentDelta = '';
    pendingTextEventDelta = '';
    needsFlush = false;
    if (hasDocument) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (hasWindow) {
      window.removeEventListener('pagehide', onPageHide);
    }
  };

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  }

  function onPageHide() {
    flush();
    // persistSoon's 500ms debounce never fires once the document tears
    // down, so synchronously PUT with keepalive instead.
    flushAndPersistNow?.();
  }

  if (hasDocument) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (hasWindow) {
    window.addEventListener('pagehide', onPageHide);
  }

  // True when text has been appended but not yet flushed into a `text` event.
  // Callers that need the soon-to-be-committed event count (e.g. pinning a live
  // tool's stream position) add 1 for this still-buffered preamble.
  const hasPendingText = () => pendingTextEventDelta.length > 0;

  return { appendContent, appendTextEvent, appendEvent, flush, cancel, hasPendingText };
}
