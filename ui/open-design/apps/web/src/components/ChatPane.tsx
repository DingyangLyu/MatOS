import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@open-design/components';
import { buildReplyExcerpt, type ChatMessageReplyRef } from '@open-design/contracts';
import { useT } from '../i18n';
import {
  FEATURED_DESIGN_TOOLBOX_ACTION_IDS,
  findDesignToolboxSkill,
  getDesignToolboxAction,
  type DesignToolboxActionId,
} from '../runtime/design-toolbox';
import type { Dict } from '../i18n/types';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { projectRawUrl } from '../providers/registry';
import type { TodoItem } from '../runtime/todos';
import type { ChatSessionMode, WorkspaceContextItem } from '@open-design/contracts';
import { isTodoWriteToolName, latestTodoWriteInputForPinnedCard } from '../runtime/todos';
import type { AppConfig, ChatAttachment, ChatCommentAttachment, ChatMessage, ChatMessageFeedbackChange, Conversation, PreviewComment, ProjectFile, ProjectMetadata, SkillSummary } from '../types';
import { agentDisplayName } from '../utils/agentLabels';
import { findByRoleRef, sameRoleRef } from '../utils/roleRefs';
import { commentTargetDisplayName, commentsToAttachments } from '../comments';
import { AssistantMessage, pickLatestPlanDocument, type QuestionFormOpenRequest } from './AssistantMessage';
import { MarkdownExportMenu } from './MarkdownExportMenu';
import { conversationExportText } from '../runtime/conversation-export';
import type { NextStepActionsVariant } from './NextStepActions';
import { resolveRunFailureUi } from '../runtime/run-failure-ui';
import { RESUME_CONTINUE_PROMPT } from '../runtime/resume';
import {
  ChatComposer,
  type ChatComposerHandle,
  type ChatSendMeta,
} from './ChatComposer';
import {
  MATOS_FOLLOW_UP_SCENARIO_DEFS,
  type PlaceholderScenario,
} from './home-hero/placeholderScenarios';
import { MATOS_CHAT_FOLLOW_UPS_VISIBLE } from '../features/matosChatFollowUps';
import { listDesignArtifactCandidates } from './design-files/designArtifacts';
import { Icon, type IconName } from './Icon';
import type { SettingsSection } from './SettingsDialog';
import {
  resolveProjectMembers,
  useMemberRoles,
  type ProjectMemberRole,
} from './ProjectConversationsSidebar';
import groupBarStyles from './ChatGroupMemberBar.module.css';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

// Featured starter prompts shown on the empty chat. Clicking one fills
// the composer (does not auto-send) so users can tweak before sending.
// The default set is MatOS materials-science tasks (DFT relaxation +
// bands, screening workflow, MD diffusion, surface adsorption): each
// prompt is a concrete, runnable compute/analysis brief rather than a
// generic design request.
//
// The starter set stays i18n-translated via existing chat.example* keys so
// the user-facing copy keeps its localizations.
type StarterPrompt = {
  icon: string;
  title: string;
  tag: string;
  prompt: string;
};

const DEFAULT_STARTER_KEYS: Array<{
  icon: string;
  titleKey: keyof Dict;
  tagKey: keyof Dict;
  promptKey: keyof Dict;
}> = [
  {
    icon: '▤',
    titleKey: 'chat.example1Title',
    tagKey: 'chat.example1Tag',
    promptKey: 'chat.example1Prompt',
  },
  {
    icon: '▦',
    titleKey: 'chat.example2Title',
    tagKey: 'chat.example2Tag',
    promptKey: 'chat.example2Prompt',
  },
  {
    icon: '◈',
    titleKey: 'chat.example3Title',
    tagKey: 'chat.example3Tag',
    promptKey: 'chat.example3Prompt',
  },
  {
    icon: '◆',
    titleKey: 'chat.example4Title',
    tagKey: 'chat.example4Tag',
    promptKey: 'chat.example4Prompt',
  },
];

const IMPORTED_ARTIFACTS_INITIAL_VISIBLE_COUNT = 5;
const IMPORTED_ARTIFACTS_REVEAL_COUNT = 5;

function pickStarters(
  metadata: ProjectMetadata | undefined,
  t: TranslateFn,
): StarterPrompt[] {
  return DEFAULT_STARTER_KEYS.map((entry) => ({
    icon: entry.icon,
    title: t(entry.titleKey),
    tag: t(entry.tagKey),
    prompt: t(entry.promptKey),
  }));
}

function sortArtifactsByModified(files: ProjectFile[]): ProjectFile[] {
  return [...files].sort(
    (a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name),
  );
}

function ImportedFolderArtifacts({
  projectId,
  files,
  onOpenFile,
  t,
}: {
  projectId: string | null;
  files: ProjectFile[];
  onOpenFile?: (name: string) => void;
  t: TranslateFn;
}) {
  const [visibleCount, setVisibleCount] = useState(IMPORTED_ARTIFACTS_INITIAL_VISIBLE_COUNT);

  useEffect(() => {
    setVisibleCount(IMPORTED_ARTIFACTS_INITIAL_VISIBLE_COUNT);
  }, [files]);

  if (files.length === 0) {
    return (
      <div className="chat-design-artifacts-empty" data-testid="chat-design-artifacts-empty">
        {t('designFiles.empty')}
      </div>
    );
  }

  const visibleFiles = files.slice(0, visibleCount);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const revealCount = Math.min(IMPORTED_ARTIFACTS_REVEAL_COUNT, hiddenCount);
  const revealLabel = t('chat.designArtifactsShowMore', { count: revealCount });

  return (
    <div className="chat-design-artifacts" data-testid="chat-design-artifacts">
      {visibleFiles.map((file, index) => {
        const openable = Boolean(onOpenFile);
        const openLabel = `${t('designFiles.previewOpen')} ${file.name}`;
        const openFile = () => {
          onOpenFile?.(file.name);
        };
        return (
          <div
            key={file.name}
            className="chat-design-artifact"
            data-kind={file.kind}
            data-file-name={file.name}
            data-testid={`chat-design-artifact-${index}`}
            role={openable ? 'button' : 'listitem'}
            tabIndex={openable ? 0 : undefined}
            title={openLabel}
            aria-label={openLabel}
            onDoubleClick={openable ? openFile : undefined}
            onKeyDown={
              openable
                ? (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openFile();
                  }
                : undefined
            }
          >
            <div className="chat-design-artifact-preview" aria-hidden>
              <ChatArtifactPreview projectId={projectId} file={file} />
            </div>
            <div className="chat-design-artifact-meta">
              <span className="chat-design-artifact-name" title={file.name}>
                {file.name}
              </span>
              <span className="chat-design-artifact-kind">
                {chatArtifactKindLabel(file.kind, t)}
              </span>
            </div>
          </div>
        );
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="chat-design-artifact chat-design-artifact-more"
          data-testid="chat-design-artifacts-more"
          aria-label={revealLabel}
          title={revealLabel}
          onClick={() => {
            setVisibleCount((current) =>
              Math.min(files.length, current + IMPORTED_ARTIFACTS_REVEAL_COUNT),
            );
          }}
        >
          <span className="chat-design-artifact-more-icon" aria-hidden>
            +
          </span>
          <span className="chat-design-artifact-more-count">
            {revealLabel}
          </span>
        </button>
      ) : null}
    </div>
  );
}

function ChatArtifactPreview({
  projectId,
  file,
}: {
  projectId: string | null;
  file: ProjectFile;
}) {
  if (!projectId) {
    return <ChatArtifactFallback kind={file.kind} />;
  }

  const url = `${projectRawUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  if (file.kind === 'image') {
    return <img src={url} alt="" loading="lazy" />;
  }
  if (file.kind === 'html') {
    return (
      <iframe
        title={file.name}
        src={url}
        sandbox="allow-scripts allow-downloads"
        loading="lazy"
      />
    );
  }
  if (file.kind === 'video') {
    return <video src={url} muted playsInline preload="metadata" />;
  }
  return <ChatArtifactFallback kind={file.kind} />;
}

function ChatArtifactFallback({ kind }: { kind: ProjectFile['kind'] }) {
  return (
    <span className="chat-design-artifact-fallback">
      <Icon name={chatArtifactIcon(kind)} size={28} />
      <span>{chatArtifactShortKind(kind)}</span>
    </span>
  );
}

function chatArtifactIcon(kind: ProjectFile['kind']): IconName {
  if (kind === 'html' || kind === 'code') return 'file-code';
  if (kind === 'image') return 'image';
  if (kind === 'video' || kind === 'audio') return 'play';
  if (kind === 'presentation') return 'present';
  return 'file';
}

function chatArtifactShortKind(kind: ProjectFile['kind']): string {
  if (kind === 'html') return 'HTML';
  if (kind === 'image') return 'IMG';
  if (kind === 'video') return 'VIDEO';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'presentation') return 'PPT';
  if (kind === 'document') return 'DOC';
  return 'FILE';
}

function chatArtifactKindLabel(kind: ProjectFile['kind'], t: TranslateFn): string {
  if (kind === 'html') return t('designFiles.kindHtml');
  if (kind === 'image') return t('designFiles.kindImage');
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  if (kind === 'pdf') return t('designFiles.kindPdf');
  if (kind === 'document') return t('designFiles.kindDocument');
  if (kind === 'presentation') return t('designFiles.kindPresentation');
  if (kind === 'spreadsheet') return t('designFiles.kindSpreadsheet');
  return t('designFiles.kindBinary');
}

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  hasOlderMessages?: boolean;
  olderMessagesLoading?: boolean;
  onLoadOlderMessages?: () => Promise<void>;
  error: string | null;
  projectId: string | null;
  sessionMode?: ChatSessionMode;
  onSessionModeChange?: (mode: ChatSessionMode) => void;
  projectFiles: ProjectFile[];
  activeProjectFileName?: string | null;
  sendDisabled?: boolean;
  queuedItems?: QueuedSendItem[];
  onRemoveQueuedSend?: (id: string) => void;
  onUpdateQueuedSend?: (id: string, update: QueuedSendUpdate) => void;
  onReorderQueuedSends?: (orderedIds: string[]) => void;
  onSendQueuedNow?: (id: string) => void;
  // Names that exist in the project folder. Tool cards and chips use this
  // set to decide whether a path can be opened as a tab.
  projectFileNames?: Set<string>;
  onEnsureProject: () => Promise<string | null>;
  previewComments?: PreviewComment[];
  attachedComments?: PreviewComment[];
  onAttachComment?: (comment: PreviewComment) => void;
  onDetachComment?: (commentId: string) => void;
  onDeleteComment?: (commentId: string) => void;
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    meta?: ChatSendMeta,
  ) => void;
  onRetry?: (assistantMessage: ChatMessage) => void;
  onResumeRun?: (assistantMessage: ChatMessage) => void;
  onStop: () => void;
  // Skills available for @-mention assembly. ProjectView filters out the
  // user's disabled set before passing them in here.
  skills?: SkillSummary[];
  // Click-to-open chain: passes a basename up to ProjectView, which sets
  // FileWorkspace's openRequest. Tool cards, attachment chips, and
  // produced-file chips all call this.
  onRequestOpenFile?: (name: string) => void;
  forceStreamingMessageIds?: Set<string>;
  // Live-only streaming tool-input partials keyed by tool-use id. Threaded to
  // AssistantMessage so an in-flight Write/Edit can render its code in real
  // time before the full `tool_use` arrives. Never persisted.
  liveToolInput?: Record<string, { name: string; text: string; seq?: number }>;
  initialDraft?: string;
  composerPlaceholder?: string;
  // Focus the right-hand Questions tab from the chat banner.
  onOpenQuestions?: (request?: QuestionFormOpenRequest) => void;
  onContinueRemainingTasks?: (assistantMessage: ChatMessage, todos: TodoItem[]) => void;
  onAssistantFeedback?: (assistantMessage: ChatMessage, change: ChatMessageFeedbackChange) => void;
  // "Next step" affordance handlers forwarded to the last assistant message.
  // The featured design-toolbox rows are driven directly off the composer ref
  // owned here, so they need no handler from ProjectView.
  onArtifactDownload?: (fileName: string) => void;
  onForkFromMessage?: (assistantMessage: ChatMessage) => void;
  forkingMessageId?: string | null;
  // Header "+" button — kicks off ProjectView's create-conversation flow.
  onNewConversation?: () => void;
  newConversationDisabled?: boolean;
  // Conversation list that used to live in the topbar. The chat tab now
  // owns the list so users can browse + switch conversations without
  // leaving the pane.
  conversations: Conversation[];
  activeConversationId: string | null;
  // The conversation whose history the live `messages` array currently
  // reflects. Null while a switch is mid-flight (or after a load failure),
  // which is exactly when `messages.length` must NOT be trusted as the active
  // conversation's count — see `conversationMessageCount`. Callers that do not
  // track this (mounts whose loader resets/retags `messages` asynchronously)
  // leave it undefined and fall back to the persisted `conversation.messageCount`
  // for a stable list count.
  messagesConversationId?: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  /** Rename a conversation (drives the group-chat header's inline title edit). */
  onRenameConversation?: (id: string, title: string) => void;
  /** Open the member invite dialog from the group-chat header. */
  onManageGroupMembers?: () => void;
  // MatOS group auto-relay: whether a member reply ending in "@NAME: <task>"
  // auto-dispatches that member. The relay itself runs in ProjectView; the
  // @-member bar only renders the toggle.
  groupAutoRelay?: boolean;
  onGroupAutoRelayChange?: (enabled: boolean) => void;
  // MatOS per-member custom names (`metadata.memberNames`) so the group @-bar
  // chips show the project alias instead of the bare role name.
  groupMemberNames?: Record<string, string>;
  // Composer settings/CLI button forwards to here. The dialog lives in App
  // (it owns the AppConfig lifecycle) so we just pass the open trigger.
  onOpenSettings?: (section?: SettingsSection) => void;
  // Same dialog, but landing on the External MCP tab. Forwarded to the
  // composer's `/mcp` slash and MCP picker button.
  onOpenMcpSettings?: () => void;
  // Bumped by the parent to push a draft into the composer (used by the
  // "Import repo" CTA). The nonce lets the same text fire more than once.
  composerDraftSignal?: { text: string; nonce: number };
  projectMetadata?: ProjectMetadata;
  onProjectMetadataChange?: (metadata: ProjectMetadata) => void;
  activeWorkspaceContext?: WorkspaceContextItem | null;
  initialWorkspaceContexts?: WorkspaceContextItem[];
  workspaceContexts?: WorkspaceContextItem[];
  currentSkillId?: string | null;
  onProjectSkillChange?: (skillId: string | null) => void;
  researchAvailable?: boolean;
  composerFooterAccessory?: ReactNode;
  // Slot rendered next to the composer's "+" menu (e.g. the working-dir pill).
  composerLeadingAccessory?: ReactNode;
  onShowToast?: (message: string) => void;
  // Project header slot. The former standalone chrome header row was removed;
  // its back button and project title (editable) moved into the top of the
  // chat pane. ProjectView owns the project record so it renders these as
  // slots rather than ChatPane re-deriving the data.
  onBack?: () => void;
  backLabel?: string;
  projectHeader?: ReactNode;
  // MatOS role picker slot; ProjectView passes it so the conversations
  // composer mirrors the Home composer's role selection.
  matosRolePicker?: ReactNode;
  // MatOS provider-model picker pill (web `/model`), rendered next to the
  // role pill. ProjectView owns persistence; omitted for non-MatOS agents.
  matosModelPicker?: ReactNode;
  // `/model <id>` slash-command handler — the same persistence the pill
  // drives. Omitted → the composer leaves `/model` out of its palette.
  onSetMatosProviderModel?: (id: string | null) => void;
  config?: AppConfig;
}


type Tab = 'chat' | 'comments';

const CHAT_MESSAGE_VIRTUALIZE_THRESHOLD = 80;
const CHAT_MESSAGE_OVERSCAN_PX = 900;
const CHAT_VIRTUAL_ROW_GAP_PX = 14;
const CHAT_VIRTUAL_MIN_ROW_HEIGHT = 36;
const CHAT_VIRTUAL_DEFAULT_VIEWPORT_PX = 640;
const CHAT_VIRTUAL_INITIAL_TAIL_ROWS = 16;

interface RunErrorDiagnosticInput {
  message: string;
  rawMessage?: string | null;
  errorCode?: string;
  traceId?: string;
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string;
  agentId?: string;
}

interface QueuedSendItem {
  id: string;
  prompt: string;
  attachments?: ChatAttachment[];
  commentAttachments?: ChatCommentAttachment[];
  meta?: ChatSendMeta;
}

interface QueuedSendUpdate {
  prompt: string;
  attachments: ChatAttachment[];
  commentAttachments: ChatCommentAttachment[];
  meta?: ChatSendMeta;
}

export function ChatPane({
  messages,
  streaming,
  loading = false,
  hasOlderMessages = false,
  olderMessagesLoading = false,
  onLoadOlderMessages,
  sendDisabled = false,
  queuedItems = [],
  error,
  projectId,
  sessionMode = 'design',
  onSessionModeChange,
  projectFiles,
  activeProjectFileName = null,
  projectFileNames,
  onEnsureProject,
  previewComments = [],
  attachedComments = [],
  onAttachComment,
  onDetachComment,
  onDeleteComment,
  onSend,
  onRetry,
  onResumeRun,
  onStop,
  onRemoveQueuedSend,
  onUpdateQueuedSend,
  onReorderQueuedSends,
  onSendQueuedNow,
  onRequestOpenFile,
  forceStreamingMessageIds,
  liveToolInput,
  initialDraft,
  composerPlaceholder,
  onOpenQuestions,
  onContinueRemainingTasks,
  onAssistantFeedback,
  onArtifactDownload,
  onForkFromMessage,
  forkingMessageId = null,
  onNewConversation,
  newConversationDisabled = false,
  conversations,
  activeConversationId,
  messagesConversationId = null,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onManageGroupMembers,
  groupAutoRelay = true,
  onGroupAutoRelayChange,
  groupMemberNames,
  onOpenSettings,
  onOpenMcpSettings,
  composerDraftSignal,
  projectMetadata,
  onProjectMetadataChange,
  activeWorkspaceContext,
  initialWorkspaceContexts = [],
  workspaceContexts = [],
  currentSkillId = null,
  onProjectSkillChange,
  researchAvailable,
  skills = [],
  composerLeadingAccessory,
  composerFooterAccessory,
  onShowToast,
  onBack,
  backLabel,
  projectHeader,
  matosRolePicker,
  matosModelPicker,
  onSetMatosProviderModel,
  config,
}: Props) {
  const t = useT();
  const displayMessages = messages;
  const logRef = useRef<HTMLDivElement | null>(null);
  const chatLogScrollIdleTimerRef = useRef<number | null>(null);
  const historyWrapRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const composerSlotRef = useRef<HTMLDivElement | null>(null);
  const composerLayerRef = useRef<HTMLDivElement | null>(null);
  const queuedSendStripRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  // Tracks whether the user is glued close enough to the bottom that
  // streamed content should auto-follow. Distinct from the jump-button
  // state below, which uses a wider threshold (120px) so the affordance
  // stays visible for short scroll-ups. Auto-follow needs the tighter
  // 80px cutoff: scrolling ~90px up is an intentional pause that
  // shouldn't be yanked back the moment the next chunk streams in.
  const pinnedToBottomRef = useRef(true);
  const scrolledToFormRef = useRef<Set<string>>(new Set());

  // MatOS group chat: when the active conversation has a multi-member roster,
  // the composer grows an @-member bar. The picked member is the turn's
  // responder — ProjectView pins the run's role to it (still one native
  // `matos --role` execution per turn; the bar only routes WHO answers).
  const activeGroupConversation = useMemo(() => {
    const conversation = conversations.find((c) => c.id === activeConversationId) ?? null;
    return conversation &&
      Array.isArray(conversation.memberRefs) &&
      conversation.memberRefs.length > 1
      ? conversation
      : null;
  }, [conversations, activeConversationId]);
  const memberRoleCatalog = useMemberRoles();
  const groupMembers = useMemo(
    () =>
      activeGroupConversation
        ? resolveProjectMembers(
            activeGroupConversation.memberRefs ?? [],
            memberRoleCatalog,
            groupMemberNames,
          )
        : [],
    [activeGroupConversation, memberRoleCatalog, groupMemberNames],
  );
  const [addressedMemberRef, setAddressedMemberRef] = useState<string | null>(null);
  // Feishu-style quote-reply draft: set by a message row's quote action,
  // shown as a bar above the composer, attached to the next send's meta.
  const [replyDraft, setReplyDraft] = useState<ChatMessageReplyRef | null>(null);
  useEffect(() => {
    // Reset the @-selection when switching conversations; the default
    // responder falls back to the conversation's bound role / first member.
    setAddressedMemberRef(null);
    setReplyDraft(null);
  }, [activeConversationId]);
  const handleQuoteReply = useCallback(
    (message: ChatMessage) => {
      // Assistant turns quote their speaking member; user turns quote the
      // human (roleRef on a user row is the ADDRESSEE, not the author).
      const speakingMember =
        message.role === 'assistant' && message.roleRef
          ? findByRoleRef(groupMembers, message.roleRef) ?? null
          : null;
      setReplyDraft({
        messageId: message.id,
        ...(message.role === 'assistant' && message.roleRef
          ? { roleRef: message.roleRef }
          : {}),
        authorName:
          message.role === 'assistant'
            ? speakingMember?.name ??
              (message.roleRef ? message.roleRef.replace(/^role:/, '').split('@')[0]! : null)
            : null,
        excerpt: buildReplyExcerpt(message.content ?? ''),
      });
      composerRef.current?.focus?.();
    },
    [groupMembers],
  );

  const getConversationExport = useCallback(() => {
    const conversation = conversations.find((c) => c.id === activeConversationId) ?? null;
    return conversationExportText(projectId, activeConversationId, messages, hasOlderMessages, conversation?.title);
  }, [projectId, conversations, activeConversationId, messages, hasOlderMessages]);

  // Keep the native /export Markdown behavior, including unloaded history.
  const handleExportConversation = useCallback(async () => {
    try {
      const conversation = conversations.find((c) => c.id === activeConversationId) ?? null;
      const markdown = await getConversationExport();
      if (!markdown) {
        onShowToast?.(t('chat.exportEmpty'));
        return;
      }
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${exportFileStem(conversation?.title)}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      onShowToast?.(t('fileViewer.exportFailed'));
    }
  }, [conversations, activeConversationId, getConversationExport, onShowToast, t]);

  // `/copy` — copy the last assistant reply to the clipboard, mirroring the
  // CLI command's default (last response) form.
  const handleCopyLastResponse = useCallback(() => {
    const last = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim());
    if (!last) {
      onShowToast?.(t('chat.copyLastEmpty'));
      return;
    }
    void navigator.clipboard?.writeText(last.content).then(
      () => onShowToast?.(t('chat.copyLastDone')),
      () => onShowToast?.(t('chat.copyLastFailed')),
    );
  }, [messages, onShowToast, t]);
  const effectiveAddressedMemberRef = useMemo(() => {
    if (!activeGroupConversation) return null;
    const roster = activeGroupConversation.memberRefs ?? [];
    // Version-agnostic roster resolution: the bound roleRef may be pinned to
    // an older role version than the roster now lists.
    const inRoster = (ref: string | null | undefined) =>
      roster.find((entry) => sameRoleRef(entry, ref)) ?? null;
    const picked = inRoster(addressedMemberRef);
    if (picked) return picked;
    const bound = inRoster(activeGroupConversation.roleRef);
    if (bound) return bound;
    return roster[0] ?? null;
  }, [activeGroupConversation, addressedMemberRef]);



  // AssistantMessage's interaction callbacks are re-created per render and
  // excluded from its memo comparison (so streaming doesn't re-render every
  // message). Route them through this ref so a memoized message still calls the
  // LATEST handler. See areAssistantMessagePropsEqual in AssistantMessage.tsx.
  const assistantCallbacksRef = useRef<AssistantCallbacks>({
    onContinueRemainingTasks,
    onAssistantFeedback,
    onForkFromMessage,
  });
  assistantCallbacksRef.current = {
    onContinueRemainingTasks,
    onAssistantFeedback,
    onForkFromMessage,
  };
  // Featured design-toolbox follow-up rows on the assistant "next step" card.
  // The toolbox left the "+" menu, so these route straight into the composer
  // we own here: seeding an action's prompt+skill, or opening the full panel.
  // Both stay stable (composer ref + no deps) so AssistantMessage stays memoized.
  const handleToolboxAction = useCallback((id: DesignToolboxActionId) => {
    composerRef.current?.applyDesignToolboxAction(id);
  }, []);
  const handleNextStepPromptAction = useCallback((
    prompt: string,
    options?: { sessionMode?: ChatSessionMode },
  ) => {
    if (options?.sessionMode && options.sessionMode !== sessionMode) {
      onSessionModeChange?.(options.sessionMode);
    }
    composerRef.current?.setDraft(prompt, {
      sessionMode: options?.sessionMode,
    });
  }, [onSessionModeChange, sessionMode]);
  const handlePickSkill = useCallback((skillId: string) => {
    composerRef.current?.applyDesignToolboxSkill(skillId);
  }, []);
  const nextStepVariant: NextStepActionsVariant = sessionMode === 'plan' ? 'plan' : 'default';
  // The `@skill` shown in each featured row's hover detail — matched the same
  // way the composer matches it, using the raw skill name (what gets inlined
  // into the draft). Recomputed only when the skill list changes.
  const featuredToolboxSkillNames = useMemo<Partial<Record<DesignToolboxActionId, string | null>>>(() => {
    const map: Partial<Record<DesignToolboxActionId, string | null>> = {};
    for (const id of FEATURED_DESIGN_TOOLBOX_ACTION_IDS) {
      const action = getDesignToolboxAction(id);
      map[id] = action ? (findDesignToolboxSkill(action, skills)?.name ?? null) : null;
    }
    return map;
  }, [skills]);
  const blankProjectComposerScenarios = useMemo<PlaceholderScenario[]>(
    () => pickStarters(projectMetadata, t).map((starter, index) => ({
      id: `blank-${projectMetadata?.kind ?? 'prototype'}-${index}`,
      text: starter.prompt,
      chipId: 'project',
    })),
    [projectMetadata, t],
  );
  const followUpComposerScenarios = useMemo<PlaceholderScenario[]>(() => {
    if (nextStepVariant === 'plan') {
      // Both prompts embed the plan document via {file}; without vars the
      // literal "{file}" leaked into the composer placeholder/draft.
      const planFile = pickLatestPlanDocument(projectFiles) ?? 'plan.md';
      return [
        {
          id: 'plan-generate-from-doc',
          text: t('nextStep.planGeneratePrompt', { file: planFile }),
          chipId: 'plan',
          sessionMode: 'design',
        },
        {
          id: 'plan-improve-doc',
          text: t('nextStep.planImprovePrompt', { file: planFile }),
          chipId: 'plan',
          sessionMode: 'plan',
        },
      ];
    }
    // MatOS conversations get materials-science follow-ups; the upstream
    // design-toolbox polish prompts read as irrelevant there (issue: "润色
    // 动效节奏" suggested mid compute session).
    if (MATOS_CHAT_FOLLOW_UPS_VISIBLE) {
      return MATOS_FOLLOW_UP_SCENARIO_DEFS.map((def) => ({
        id: `follow-up-${def.id}`,
        text: t(def.textKey),
        chipId: def.chipId,
      }));
    }
    const promptPairs: Array<[string, string]> = [
      ['auto-match', t('chat.designToolbox.prompt.autoMatchIntro')],
      ['visual-polish', t('chat.designToolbox.prompt.visualPolish')],
      ['asset-search', t('chat.designToolbox.prompt.assetSearch')],
      ['icon-workflow', t('chat.designToolbox.prompt.iconWorkflow')],
      ['anti-ai-polish', t('chat.designToolbox.prompt.antiAiPolish')],
      ['motion-polish', t('chat.designToolbox.prompt.motionPolish')],
      ['chart-gen', t('chat.designToolbox.prompt.chartGen')],
    ];
    return promptPairs.map(([id, text]) => ({
      id: `follow-up-${id}`,
      text,
      chipId: 'design-toolbox',
    }));
  }, [nextStepVariant, projectFiles, t]);
  const composerPlaceholderScenarios = useMemo<PlaceholderScenario[]>(() => {
    if (loading || initialDraft?.trim()) return [];
    if (displayMessages.length === 0 && queuedItems.length === 0) return blankProjectComposerScenarios;
    if (displayMessages.length > 0) return followUpComposerScenarios;
    return [];
  }, [
    blankProjectComposerScenarios,
    displayMessages.length,
    followUpComposerScenarios,
    initialDraft,
    loading,
    queuedItems.length,
  ]);
  const [tab, setTab] = useState<Tab>('chat');
  const [showConvList, setShowConvList] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const deferredConversationSearch = useDeferredValue(conversationSearch);
  const [scrolledFromBottom, setScrolledFromBottom] = useState(false);
  const [chatLogScrollable, setChatLogScrollable] = useState(false);
  const [chatLogScrolling, setChatLogScrolling] = useState(false);
  const [composerPortalTarget, setComposerPortalTarget] = useState<HTMLElement | null>(null);
  const [composerPortalRect, setComposerPortalRect] = useState<{
    left: number;
    width: number;
    bottom: number;
  } | null>(null);
  const [composerSlotHeight, setComposerSlotHeight] = useState(0);
  const [editingQueuedSendId, setEditingQueuedSendId] = useState<string | null>(null);
  // Reverse scan (no array copy) + memo so this and the maps below don't
  // recompute on every non-`messages` render (scroll, hover, toggles).
  const lastAssistantId = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i]!.role === 'assistant') return displayMessages[i]!.id;
    }
    return undefined;
  }, [displayMessages]);
  const retryAssistant = retryableAssistantMessage(displayMessages, lastAssistantId, streaming);
  // The failed run's error event lives on the (persisted) assistant message, so
  // the error card survives a reload — unlike the ephemeral global
  // `error` state. Drive both off this event.
  const failedRunErrorEvent = (() => {
    const evs = retryAssistant?.events ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev?.kind === 'status' && ev.label === 'error') return ev;
    }
    return null;
  })();
  // Per-case failure copy. Only meaningful for a failed run (retryAssistant
  // present).
  const runFailureUi = retryAssistant
    ? resolveRunFailureUi(failedRunErrorEvent?.code, error ?? failedRunErrorEvent?.detail ?? null)
    : null;
  // Offer Continue (resume) when the failed run is resumable AND the active
  // agent still matches the agent that produced it. The daemon stores a
  // resumable session per (conversation, agent); after an agent switch the new
  // agent has no id for that session, so a resume would silently start fresh —
  // fall back to the from-scratch Retry instead. We do NOT require `onResumeRun`
  // here: because the daemon persists the resumable session, the plain Retry
  // path (which re-sends the original prompt) would itself silently resume that
  // session and double the work. So every ChatPane surface must offer Continue
  // for a resumable failure — `onResumeRun` when wired, otherwise a plain
  // `onSend` of the canonical
  // continue prompt (resumes the session without re-sending the original turn).
  const canResumeFailedRun =
    !!retryAssistant?.resumable &&
    !!retryAssistant?.agentId &&
    retryAssistant.agentId === config?.agentId;
  // Prefer a case-specific message over the raw upstream
  // string; fall back to the live global error (also covers conversation-load
  // / audio errors) then the persisted run error so a reload still shows it.
  const rawError = error ?? failedRunErrorEvent?.detail ?? null;
  // Friendly agent name for {agent} interpolation in failure copy (e.g. the
  // sign-in messages). Falls back to a neutral word when unreadable, never null.
  const failedAgentLabel =
    agentDisplayName(retryAssistant?.agentId, retryAssistant?.agentName) ??
    t('chat.runError.agentFallback');
  const displayError = runFailureUi?.messageKey
    ? t(runFailureUi.messageKey, { agent: failedAgentLabel })
    : rawError;
  const errorDiagnosticText = displayError
    ? buildRunErrorDiagnosticText({
        message: displayError,
        rawMessage: rawError,
        errorCode: failedRunErrorEvent?.code,
        traceId: retryAssistant?.runId,
        projectId,
        conversationId: activeConversationId,
        assistantMessageId: retryAssistant?.id,
        agentId: retryAssistant?.agentId,
      })
    : null;
  // First non-empty line of the diagnostics — shown as the one-line peek when
  // the error-source area is collapsed.
  const errorSourcePeek =
    errorDiagnosticText?.split('\n').find((line) => line.trim().length > 0)?.trim() ?? null;
  // Status-dot tone for the unified card: warn (amber) for the self-healing
  // connection drop, error (red) for everything else. Purely visual.
  const runErrorTone: 'error' | 'warn' =
    failedRunErrorEvent?.code === 'AGENT_CONNECTION_DROPPED' ? 'warn' : 'error';
  const [copiedErrorDiagnostic, setCopiedErrorDiagnostic] = useState(false);
  // Collapsed by default: the error source area shows one line until expanded.
  const [errorSourceOpen, setErrorSourceOpen] = useState(false);
  const errorDiagnosticCopyTimerRef = useRef<number | null>(null);
  const copyErrorDiagnostic = useCallback(async () => {
    if (!errorDiagnosticText) return;
    const ok = await copyToClipboard(errorDiagnosticText);
    if (!ok) return;
    if (errorDiagnosticCopyTimerRef.current != null) {
      window.clearTimeout(errorDiagnosticCopyTimerRef.current);
    }
    setCopiedErrorDiagnostic(true);
    errorDiagnosticCopyTimerRef.current = window.setTimeout(() => {
      errorDiagnosticCopyTimerRef.current = null;
      setCopiedErrorDiagnostic(false);
    }, 1600);
  }, [errorDiagnosticText]);
  useEffect(() => () => {
    if (errorDiagnosticCopyTimerRef.current != null) {
      window.clearTimeout(errorDiagnosticCopyTimerRef.current);
      errorDiagnosticCopyTimerRef.current = null;
    }
  }, []);
  // The failed run whose error this top-level card represents. AssistantMessage
  // suppresses only THIS message's per-message error pill (to avoid the
  // duplicate); other failed turns — older history, or once a follow-up makes
  // this no longer the last assistant — keep their pill so the error survives.
  const errorCardOwnerId =
    retryAssistant && failedRunErrorEvent ? retryAssistant.id : null;
  const showErrorActions =
    Boolean(retryAssistant && onRetry && runFailureUi);
  const importedFolderArtifacts = useMemo(
    () =>
      projectMetadata?.importedFrom === 'folder'
        ? sortArtifactsByModified(
            listDesignArtifactCandidates(projectFiles, projectMetadata.entryFile),
          )
        : [],
    [projectFiles, projectMetadata?.entryFile, projectMetadata?.importedFrom],
  );
  const showImportedFolderArtifacts = projectMetadata?.importedFrom === 'folder';
  const composerDraftStorageKey = projectId && activeConversationId
    ? `od:chat-composer:draft:${projectId}:${activeConversationId}`
    : undefined;
  const firstUserMessageId = useMemo(
    () => displayMessages.find((m) => m.role === 'user')?.id,
    [displayMessages],
  );
  const shouldBalanceTranscript = !loading && displayMessages.length > 0;
  // Map each assistant message id to the user message that follows it (if any)
  // so the chat-side Questions banner can reopen that exact answered form in
  // the right-hand panel later.
  const nextUserContentByAssistantId = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < displayMessages.length - 1; i++) {
      const m = displayMessages[i]!;
      const next = displayMessages[i + 1]!;
      if (m.role === 'assistant' && next.role === 'user') {
        map.set(m.id, next.content);
      }
    }
    return map;
  }, [displayMessages]);

  useLayoutEffect(() => {
    didInitialScrollRef.current = false;
    // New conversations start at their own latest message, never at another
    // conversation's saved offset. Subsequent manual scrollback is preserved.
    pinnedToBottomRef.current = true;
    savedChatScrollRef.current = null;
    scrolledToFormRef.current = new Set();
  }, [activeConversationId]);

  // ChatComposer's internal `seededRef` latches after the first
  // non-empty `initialDraft`, so a parent setting `initialDraft` back
  // to `undefined` will not flow into the composer's draft state. When
  // the parent does that transition (because the seed is now stale —
  // e.g. ProjectView discovered the conversation already has a sent
  // user message after a reload), reach into the composer and clear
  // the textarea so the user does not see the prompt they already
  // submitted.
  const lastSeenInitialDraftRef = useRef<string | undefined>(initialDraft);
  useEffect(() => {
    const previous = lastSeenInitialDraftRef.current;
    lastSeenInitialDraftRef.current = initialDraft;
    if (previous && initialDraft === undefined) {
      composerRef.current?.setDraft('');
    }
  }, [initialDraft]);

  // Parent-driven composer prefill (the "Import repo" CTA). Reuse the same
  // imperative setDraft the starter cards use; the nonce guards against
  // re-applying the same signal on unrelated re-renders.
  const lastDraftSignalNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!composerDraftSignal) return;
    if (lastDraftSignalNonceRef.current === composerDraftSignal.nonce) return;
    lastDraftSignalNonceRef.current = composerDraftSignal.nonce;
    composerRef.current?.setDraft(composerDraftSignal.text);
  }, [composerDraftSignal]);

  useEffect(() => {
    if (!editingQueuedSendId) return;
    if (queuedItems.some((item) => item.id === editingQueuedSendId)) return;
    setEditingQueuedSendId(null);
  }, [editingQueuedSendId, queuedItems]);

  const restoreQueuedSendToComposer = (item: QueuedSendItem) => {
    setEditingQueuedSendId(item.id);
    composerRef.current?.restoreDraft({
      text: item.prompt,
      attachments: item.attachments ?? [],
      commentAttachments: item.commentAttachments ?? [],
      meta: item.meta,
    });
  };

  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el || loading || didInitialScrollRef.current || displayMessages.length === 0) return;
    didInitialScrollRef.current = true;
    // If the last assistant message contains a question form, scroll to
    // the form instead of the bottom, so the user sees the form first.
    const lastAssistantMsg = [...displayMessages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistantMsg?.content.includes('<question-form')) {
      const assistantEls = el.querySelectorAll('.msg.assistant');
      const lastAssistantEl = assistantEls[assistantEls.length - 1];
      const formEl = lastAssistantEl?.querySelector<HTMLElement>('[data-form-id]');
      if (formEl && !scrolledToFormRef.current.has(formEl.dataset.formId!)) {
        scrolledToFormRef.current.add(formEl.dataset.formId!);
        formEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
        pinnedToBottomRef.current = false;
        setScrolledFromBottom(true);
        return;
      }
      // Already handled by the auto-scroll effect — don't bottom-scroll.
      if (formEl) return;
    }
    // Initial content can still change size after this layout effect (markdown,
    // images, virtual-row measurements, or the composer portal). Pin once now
    // and twice after paint so the first frame cannot leave a fresh transcript
    // at scrollTop 0 with a large blank area underneath.
    pinnedToBottomRef.current = true;
    const pinToLatest = () => {
      const target = logRef.current;
      // A user scroll between paint frames cancels the initial bottom pin.
      if (!target || !pinnedToBottomRef.current) return;
      target.scrollTop = target.scrollHeight;
      setScrolledFromBottom(false);
      pinnedToBottomRef.current = true;
    };
    pinToLatest();
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    const scheduleSecondFrame = () => {
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        pinToLatest();
      });
    };
    firstFrame = requestAnimationFrame(() => {
      firstFrame = null;
      pinToLatest();
      scheduleSecondFrame();
    });
    // `tab` is in the deps so that switching conversations while
    // Comments is open doesn't strand the new conversation at scrollTop:
    // 0. The activeConversationId-reset effect above clears
    // didInitialScrollRef while the chat-log is unmounted; this effect
    // then re-runs when the user returns to Chat and the element is
    // available, scrolling the new conversation to its initial bottom.
    return () => {
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  }, [activeConversationId, displayMessages, loading, tab]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // Auto-scroll only when the user was already pinned near the bottom,
    // so a scrollback session reading earlier output isn't yanked to the
    // latest message. We key off the pre-content `pinnedToBottomRef`
    // (a ref so it doesn't itself re-fire this effect on scroll) instead
    // of recomputing distance from the just-grown scrollHeight: a single
    // streamed chunk can add 100+ px in one render, which made the
    // post-content distance check skip auto-scroll even when the user
    // was glued to the bottom. We deliberately use the tighter 80px
    // cutoff tracked by the ref (not the wider 120px jump-button
    // threshold) so a deliberate ~90px scroll-up isn't snapped back the
    // next time content streams in. Issue #983.

    if (pinnedToBottomRef.current) {
      // If the last assistant message contains a question form, scroll to
      // the form instead of the bottom, so the user lands on the form.
      const lastAssistantMsg = [...displayMessages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistantMsg?.content.includes('<question-form')) {
        const assistantEls = el.querySelectorAll('.msg.assistant');
        const lastAssistantEl = assistantEls[assistantEls.length - 1];
        const formEl = lastAssistantEl?.querySelector<HTMLElement>('[data-form-id]');
        if (formEl && !scrolledToFormRef.current.has(formEl.dataset.formId!)) {
          scrolledToFormRef.current.add(formEl.dataset.formId!);
          formEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
          pinnedToBottomRef.current = false;
          setScrolledFromBottom(true);
          return;
        }
        // Form tag in content but the DOM element isn't ready yet (partial
        // stream) — skip bottom-scroll to avoid a jarring jump that gets
        // undone when the form finishes rendering.
        if (streaming) return;
      }
      // Streaming bottom-pin must be instant — smooth scrollTo emits
      // intermediate scroll events that flip pinnedToBottomRef to false,
      // breaking auto-follow for subsequent chunks.
      el.scrollTop = el.scrollHeight;
    }
  }, [displayMessages, error, streaming]);

  // Saved chat-log scroll state, preserved across tab switches. The
  // chat-log <div> is conditionally rendered so it unmounts when the
  // user switches to Comments. On remount it would default to
  // scrollTop: 0 and the initial-bottom-scroll effect skips because
  // didInitialScrollRef is already true. We capture either the absolute
  // scrollTop or a "pinned to bottom" flag while Chat is visible, so
  // bottom-followers stay pinned even when new messages stream in
  // off-tab. Issue #790.
  const savedChatScrollRef = useRef<
    { pinnedToBottom: true } | { pinnedToBottom: false; scrollTop: number } | null
  >(null);
  useEffect(() => {
    if (tab !== 'chat') return;
    const el = logRef.current;
    if (!el) return;

    function syncScrollable(target: HTMLDivElement) {
      const next = target.scrollHeight - target.clientHeight > 1;
      setChatLogScrollable((prev) => (prev === next ? prev : next));
      if (!next) setChatLogScrolling(false);
    }

    function markScrolling() {
      setChatLogScrolling(true);
      if (chatLogScrollIdleTimerRef.current !== null) {
        window.clearTimeout(chatLogScrollIdleTimerRef.current);
      }
      chatLogScrollIdleTimerRef.current = window.setTimeout(() => {
        chatLogScrollIdleTimerRef.current = null;
        setChatLogScrolling(false);
      }, 650);
    }

    // Restore previously-saved position on remount. Defer to the next
    // frame so the conditional <> contents finish layout before the
    // scrollTop write lands.
    const saved = savedChatScrollRef.current;
    if (saved !== null) {
      requestAnimationFrame(() => {
        const target = logRef.current;
        if (!target) return;
        if (saved.pinnedToBottom) {
          target.scrollTop = target.scrollHeight;
        } else {
          target.scrollTop = saved.scrollTop;
        }
        syncScrollable(target);
        // Resync the jump-to-latest affordance with the restored
        // position. Without this, a user who left Chat ~60px from the
        // bottom and returns to find new messages stacked underneath
        // would land hundreds of pixels above the latest turn while
        // scrolledFromBottom remained false until they scrolled.
        const distance =
          target.scrollHeight - target.scrollTop - target.clientHeight;
        setScrolledFromBottom(distance > 120);
        pinnedToBottomRef.current = distance < 80;
      });
    }

    function snapshot(target: HTMLDivElement) {
      const distance =
        target.scrollHeight - target.scrollTop - target.clientHeight;
      savedChatScrollRef.current =
        distance < 50
          ? { pinnedToBottom: true }
          : { pinnedToBottom: false, scrollTop: target.scrollTop };
    }

    function onScroll() {
      const target = logRef.current;
      if (!target) return;
      syncScrollable(target);
      markScrolling();
      snapshot(target);
      const distance =
        target.scrollHeight - target.scrollTop - target.clientHeight;
      // Functional updater bails out when the value is unchanged so a flood
      // of scroll events (e.g. programmatic scrollTop + ResizeObserver
      // follow-up during streaming) does not schedule a re-render per tick
      // and trip React's "Maximum update depth exceeded" guard.
      const next = distance > 120;
      setScrolledFromBottom((prev) => (prev === next ? prev : next));
      pinnedToBottomRef.current = distance < 80;
    }
    syncScrollable(el);
    el.addEventListener('scroll', onScroll);
    return () => {
      // Capture final scroll state before unmount; the ref normally
      // tracks via onScroll, but programmatic scrolls or layout shifts
      // right before unmount can leave it stale.
      snapshot(el);
      el.removeEventListener('scroll', onScroll);
      if (chatLogScrollIdleTimerRef.current !== null) {
        window.clearTimeout(chatLogScrollIdleTimerRef.current);
        chatLogScrollIdleTimerRef.current = null;
      }
      setChatLogScrolling(false);
    };
  }, [tab]);

  useEffect(() => {
    if (tab !== 'chat') return;
    const el = logRef.current;
    if (!el) return;

    let followFrame: number | null = null;
    const followLatestIfPinned = () => {
      if (!pinnedToBottomRef.current || followFrame !== null) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = null;
        const target = logRef.current;
        if (!target || !pinnedToBottomRef.current) return;
        target.scrollTop = target.scrollHeight;
        setScrolledFromBottom(false);
      });
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const target = logRef.current;
            if (target) {
              const next = target.scrollHeight - target.clientHeight > 1;
              setChatLogScrollable((prev) => (prev === next ? prev : next));
              if (!next) setChatLogScrolling(false);
            }
            followLatestIfPinned();
          })
        : null;
    const observedChildren = new Set<Element>();
    const syncObservedChildren = () => {
      if (!resizeObserver) return;
      const currentChildren = new Set(Array.from(el.children));
      for (const child of currentChildren) {
        if (observedChildren.has(child)) continue;
        resizeObserver.observe(child);
        observedChildren.add(child);
      }
      for (const child of observedChildren) {
        if (currentChildren.has(child)) continue;
        resizeObserver.unobserve(child);
        observedChildren.delete(child);
      }
    };

    let observedQueuedSendStrip: Element | null = null;
    const syncQueuedSendStrip = () => {
      if (!resizeObserver) return;
      const queuedEl = queuedSendStripRef.current;
      if (queuedEl && observedQueuedSendStrip !== queuedEl) {
        if (observedQueuedSendStrip) {
          resizeObserver.unobserve(observedQueuedSendStrip);
        }
        resizeObserver.observe(queuedEl);
        observedQueuedSendStrip = queuedEl;
      } else if (!queuedEl && observedQueuedSendStrip) {
        resizeObserver.unobserve(observedQueuedSendStrip);
        observedQueuedSendStrip = null;
      }
    };

    // Composer growth and viewport changes resize the log without changing
    // any message. Bottom followers must follow those resizes as well.
    resizeObserver?.observe(el);
    syncObservedChildren();
    syncQueuedSendStrip();

    const mutationObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            syncObservedChildren();
            syncQueuedSendStrip();
            followLatestIfPinned();
          })
        : null;
    // childList + subtree only — NOT characterData. Auto-follow during
    // streaming is driven by the ResizeObserver on each message child (text
    // growth changes height), so observing per-character text mutations would
    // re-run the full sync sweep on every streamed frame for no extra benefit.
    mutationObserver?.observe(el, {
      childList: true,
      subtree: true,
    });
    // QueuedSendStrip lives outside the chat-log subtree (it is a sibling of
    // .chat-log-wrap inside .pane). The MutationObserver above only fires for
    // changes inside el, so it cannot detect that surface mounting or
    // unmounting. Watch the nearest common ancestor (.pane) with childList-only
    // to keep its observer current.
    const paneEl = el.parentElement?.parentElement ?? null;
    if (paneEl && mutationObserver) {
      mutationObserver.observe(paneEl, { childList: true });
    }

    return () => {
      if (followFrame !== null) cancelAnimationFrame(followFrame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [tab]);

  // Close the conversation history dropdown on outside click / Escape.
  useEffect(() => {
    if (!showConvList) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (historyWrapRef.current?.contains(target)) return;
      setShowConvList(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowConvList(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [showConvList]);

  useEffect(() => {
    if (showConvList) return;
    setConversationSearch('');
  }, [showConvList]);

  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? null;
  const filteredConversations = useMemo(
    () => filterConversations(conversations, deferredConversationSearch, t),
    [conversations, deferredConversationSearch, t],
  );

  function jumpToBottom() {
    const el = logRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    // Smooth scrolling emits intermediate scroll events. Those events mark
    // the transcript as intentionally scrolled away from the bottom while a
    // stream may still be growing, so Jump to latest can immediately lose its
    // follow mode. A direct write is deterministic and the next observer tick
    // keeps it pinned if layout expands after the click.
    el.scrollTop = el.scrollHeight;
    setScrolledFromBottom(false);
  }

  useEffect(() => {
    if (typeof document === 'undefined') return;
    setComposerPortalTarget(document.body);
  }, []);

  useLayoutEffect(() => {
    if (tab !== 'chat') {
      setComposerPortalRect(null);
      return;
    }
    const slot = composerSlotRef.current;
    if (!slot || typeof window === 'undefined') return;

    let frame: number | null = null;
    const updateRect = () => {
      frame = null;
      const rect = slot.getBoundingClientRect();
      // Phone soft keyboard (iOS WKWebView / Android resizes-visual mode):
      // the layout viewport (innerHeight) keeps its size while only the
      // visual viewport shrinks/pans, so a bottom computed from innerHeight
      // leaves the fixed composer hidden behind the keyboard. Clamp the
      // anchor to the visual viewport's bottom edge (in layout-viewport
      // coords); with no keyboard up this equals the old math exactly.
      const vv = window.visualViewport;
      const visualBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const anchorBottom = Math.min(rect.bottom, visualBottom);
      setComposerPortalRect((prev) => {
        const next = {
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          bottom: Math.max(0, Math.round(window.innerHeight - anchorBottom)),
        };
        if (
          prev
          && prev.left === next.left
          && prev.width === next.width
          && prev.bottom === next.bottom
        ) {
          return prev;
        }
        return next;
      });
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateRect);
    };

    updateRect();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleUpdate)
        : null;
    resizeObserver?.observe(slot);
    const pane = slot.closest('.pane');
    if (pane) resizeObserver?.observe(pane);
    window.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('resize', scheduleUpdate);
    // Keyboard-open pans move vv.offsetTop without a resize; track them or
    // the composer drifts off the visible bottom while the user scrolls.
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);
    // Phone pager: the project split is a horizontal snap scroller (chat page
    // ↔ canvas page). The portaled fixed layer positions off this slot's rect,
    // so it must re-measure as the pager scrolls or the composer stays glued
    // to the viewport, floating over the canvas page. Desktop splits never
    // scroll horizontally, so this listener stays silent there.
    const pagerHost = slot.closest('.split');
    pagerHost?.addEventListener('scroll', scheduleUpdate, { passive: true });
    // Project members sidebar collapse: the chat column keeps a FIXED pixel
    // track (projectSplitStyle), so collapsing the .pcs sidebar SHIFTS the
    // chat pane sideways without resizing slot or pane — only the .split grid
    // host changes size. Observe it, or the portaled composer stays glued to
    // its stale left offset.
    if (pagerHost) resizeObserver?.observe(pagerHost);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
      pagerHost?.removeEventListener('scroll', scheduleUpdate);
    };
  }, [tab]);

  useLayoutEffect(() => {
    if (tab !== 'chat' || !composerPortalTarget || !composerPortalRect) return;
    const layer = composerLayerRef.current;
    if (!layer || typeof window === 'undefined') return;

    let frame: number | null = null;
    const updateHeight = () => {
      frame = null;
      const nextHeight = Math.ceil(layer.getBoundingClientRect().height);
      setComposerSlotHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateHeight);
    };

    updateHeight();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleUpdate)
        : null;
    resizeObserver?.observe(layer);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
    };
  }, [composerPortalRect, composerPortalTarget, tab]);

  const composerNode = (
    <>
      {groupMembers.length > 0 ? (
        <div
          className={groupBarStyles.bar}
          data-testid="chat-group-member-bar"
          role="toolbar"
          aria-label={t('chat.groupReplyAs')}
        >
          <span className={groupBarStyles.label}>
            <Icon name="users" size={12} />
            {t('chat.groupReplyAs')}
          </span>
          <div className={groupBarStyles.chips}>
            {groupMembers.map((member) => {
              const active = member.ref === effectiveAddressedMemberRef;
              return (
                <button
                  key={member.ref}
                  type="button"
                  className={`${groupBarStyles.chip}${active ? ` ${groupBarStyles.chipActive}` : ''}`}
                  title={member.description ?? member.ref}
                  aria-pressed={active}
                  data-testid={`chat-group-member-${member.id}`}
                  onClick={() => setAddressedMemberRef(member.ref)}
                >
                  @{member.name}
                </button>
              );
            })}
          </div>
          {onGroupAutoRelayChange ? (
            <label className={groupBarStyles.autoRelay} title={t('chat.groupAutoRelay')}>
              <input
                type="checkbox"
                checked={groupAutoRelay}
                onChange={(event) => onGroupAutoRelayChange(event.target.checked)}
                data-testid="chat-group-auto-relay"
              />
              {t('chat.groupAutoRelay')}
            </label>
          ) : null}
        </div>
      ) : null}
      {replyDraft ? (
        <div className={groupBarStyles.bar} data-testid="chat-reply-quote-bar">
          <span className={groupBarStyles.label}>
            <Icon name="comment" size={12} />
            {t('chat.replyQuoteComposing', {
              author: replyDraft.authorName ?? t('chat.replyQuoteUser'),
            })}
          </span>
          <span className={groupBarStyles.replyQuoteText}>{replyDraft.excerpt}</span>
          <button
            type="button"
            className={groupBarStyles.replyQuoteClose}
            onClick={() => setReplyDraft(null)}
            title={t('common.close')}
            aria-label={t('common.close')}
            data-testid="chat-reply-quote-clear"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}
    <ChatComposer
      ref={composerRef}
      matosRolePicker={matosRolePicker}
      matosModelPicker={matosModelPicker}
      groupMembers={groupMembers.map((member) => ({
        ref: member.ref,
        id: member.id,
        name: member.name,
        description: member.description ?? null,
      }))}
      projectId={projectId}
      projectFiles={projectFiles}
      activeProjectFileName={activeProjectFileName}
      sessionMode={sessionMode}
      onSessionModeChange={onSessionModeChange}
      skills={skills}
      streaming={streaming}
      sendDisabled={sendDisabled}
      initialDraft={initialDraft}
      composerPlaceholder={composerPlaceholder}
      placeholderScenarios={composerPlaceholderScenarios}
      draftStorageKey={composerDraftStorageKey}
      onEnsureProject={onEnsureProject}
      commentAttachments={commentsToAttachments(attachedComments)}
      onRemoveCommentAttachment={onDetachComment}
      onSend={(prompt, attachments, commentAttachments, meta) => {
        pinnedToBottomRef.current = true;
        scrolledToFormRef.current = new Set();
        if (editingQueuedSendId && onUpdateQueuedSend) {
          const original = queuedItems.find((item) => item.id === editingQueuedSendId);
          const update: QueuedSendUpdate = {
            prompt,
            attachments,
            commentAttachments,
          };
          const nextMeta = meta ?? original?.meta;
          if (nextMeta !== undefined) update.meta = nextMeta;
          onUpdateQueuedSend(editingQueuedSendId, update);
          setEditingQueuedSendId(null);
          return;
        }
        setScrolledFromBottom(false);
        // Group chat: stamp the @-addressed member so this turn runs with
        // that member's role. Only group conversations get the stamp.
        const sendMeta =
          effectiveAddressedMemberRef !== null
            ? { ...(meta ?? {}), memberRoleRef: effectiveAddressedMemberRef }
            : meta;
        // Quote-reply: attach the drafted quote to this send and clear the
        // bar — a quote anchors exactly one turn.
        const sendMetaWithReply = replyDraft
          ? { ...(sendMeta ?? {}), replyTo: replyDraft }
          : sendMeta;
        if (replyDraft) setReplyDraft(null);
        onSend(prompt, attachments, commentAttachments, sendMetaWithReply);
      }}
      onStop={onStop}
      onOpenSettings={onOpenSettings}
      onOpenMcpSettings={onOpenMcpSettings}
      onClearConversation={onNewConversation}
      onRenameActiveConversation={
        onRenameConversation && activeConversationId
          ? (title) => onRenameConversation(activeConversationId, title)
          : undefined
      }
      onExportConversation={handleExportConversation}
      onCopyLastResponse={handleCopyLastResponse}
      onSetProviderModel={onSetMatosProviderModel}
      researchAvailable={researchAvailable}
      projectMetadata={projectMetadata}
      onProjectMetadataChange={onProjectMetadataChange}
      activeWorkspaceContext={activeWorkspaceContext}
      initialWorkspaceContexts={initialWorkspaceContexts}
      workspaceContexts={workspaceContexts}
      currentSkillId={currentSkillId}
      onProjectSkillChange={onProjectSkillChange}
      footerAccessory={composerFooterAccessory}
      leadingAccessory={composerLeadingAccessory}
      onShowToast={onShowToast}
    />
    </>
  );
  const shouldPortalComposer =
    tab === 'chat'
    && composerPortalTarget !== null
    && composerPortalRect !== null
    && composerPortalRect.width > 0;
  const composerSlotStyle: CSSProperties | undefined = shouldPortalComposer
    ? { minHeight: composerSlotHeight > 0 ? composerSlotHeight : undefined }
    : undefined;

  return (
    <div className="pane">
      <div className="chat-project-header">
        {onBack ? (
          <button
            type="button"
            className="chat-project-back"
            onClick={onBack}
            title={backLabel}
            aria-label={backLabel}
          >
            <Icon name="arrow-left" size={16} />
          </button>
        ) : null}
        {projectHeader ? (
          <span className="chat-project-header-title">{projectHeader}</span>
        ) : null}
        <MarkdownExportMenu
          markdown={messages.some(message => message.content.trim()) ? 'conversation' : ''}
          title={activeConversation?.title || (typeof projectHeader === 'string' ? projectHeader : 'MatOS')}
          projectId={projectId ?? undefined}
          getMarkdown={getConversationExport}
          disabled={loading}
        />
        <div
          className={`chat-history-wrap chat-session-switcher${showConvList ? ' open' : ''}`}
          ref={historyWrapRef}
        >
          <button
            type="button"
            className="chat-session-trigger icon-only"
            data-testid="conversation-history-trigger"
            title={
              activeConversation?.title
                ? `${t('chat.conversationsTitle')} · ${activeConversation.title}`
                : t('chat.conversationsTitle')
            }
            aria-label={t('chat.conversationsAria')}
            aria-haspopup="menu"
            aria-expanded={showConvList}
            onClick={() => {
              setShowConvList((v) => {
                const next = !v;
                if (next) {
                                  }
                return next;
              });
            }}
          >
            <Icon name="comment" size={16} />
          </button>
          {showConvList ? (
            <div className="chat-history-menu" role="menu" data-testid="conversation-history-menu">
              <div className="chat-history-menu-head">
                <span className="chat-history-menu-title">
                  {t('chat.conversationsHeading')}
                </span>
                <span className="chat-history-menu-count">
                  <span data-testid="conversation-history-count">
                  {filteredConversations.length === conversations.length
                    ? compactCount(conversations.length)
                    : `${compactCount(filteredConversations.length)} / ${compactCount(conversations.length)}`}
                  </span>
                </span>
                {onNewConversation ? (
                  <button
                    type="button"
                    className="chat-history-new"
                    data-testid="conversation-history-new"
                    disabled={newConversationDisabled}
                    onClick={() => {
                      if (newConversationDisabled) return;
                                            onNewConversation();
                      setShowConvList(false);
                    }}
                  >
                    <Icon name="plus" size={11} />
                    <span>{t('chat.new')}</span>
                  </button>
                ) : null}
              </div>
              <label className="chat-history-search">
                <Icon name="search" size={12} />
                <input
                  type="search"
                  value={conversationSearch}
                  onChange={(event) => setConversationSearch(event.currentTarget.value)}
                  placeholder="Search conversations"
                  data-testid="conversation-history-search"
                />
                {conversationSearch ? (
                  <button
                    type="button"
                    className="chat-history-search-clear"
                    onClick={() => setConversationSearch('')}
                    aria-label={t('chat.comments.clear')}
                  >
                    <Icon name="close" size={10} />
                  </button>
                ) : null}
              </label>
              <div className="chat-history-list" data-testid="conversation-list">
                {conversations.length === 0 ? (
                  <div className="chat-history-empty">
                    {t('chat.emptyConversations')}
                  </div>
                ) : filteredConversations.length === 0 ? (
                  <div className="chat-history-empty">
                    No conversations match.
                  </div>
                ) : (
                  filteredConversations.map((c) => (
                    <ConversationRow
                      key={c.id}
                      conversation={c}
                      active={c.id === activeConversationId}
                      messageCount={conversationMessageCount(c, activeConversationId, messagesConversationId, messages.length, hasOlderMessages)}
                      onSelect={() => {
                        onSelectConversation(c.id);
                        setShowConvList(false);
                      }}
                      onDelete={() => onDeleteConversation(c.id)}
                      t={t}
                    />
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {activeGroupConversation ? (
        <GroupChatHeader
          conversation={activeGroupConversation}
          members={groupMembers}
          onRename={onRenameConversation}
          onManageMembers={onManageGroupMembers}
          t={t}
        />
      ) : null}
      {tab === 'chat' ? (
        <>
          <div className="chat-log-wrap">
            <div
              className={[
                'chat-log',
                loading ? 'is-loading' : '',
                chatLogScrollable ? 'is-scrollable' : '',
                chatLogScrolling ? 'is-scrolling' : '',
                shouldBalanceTranscript ? 'is-balanced-transcript' : '',
              ].filter(Boolean).join(' ')}
              ref={logRef}
              aria-busy={loading}
              onClickCapture={(e) => {
                // Expanding an accordion (tool card / thinking block) should
                // grow downward with the clicked header staying put. While a
                // run is glued to the bottom, the ResizeObserver would re-pin
                // to the bottom on the height change and push the header up,
                // so unpin the moment the user toggles one open.
                const toggle = (e.target as HTMLElement).closest(
                  '.thinking-toggle, .action-card-toggle, button.op-card-head, [aria-expanded]',
                );
                if (toggle && logRef.current?.contains(toggle)) {
                  pinnedToBottomRef.current = false;
                  setScrolledFromBottom(true);
                }
              }}
            >
              {loading ? <ChatConversationLoading t={t} /> : null}
              {hasOlderMessages && !loading ? (
                <Button variant="ghost" data-testid="chat-load-older" disabled={olderMessagesLoading}
                  onClick={() => {
                    pinnedToBottomRef.current = false;
                    setScrolledFromBottom(true);
                    const node = logRef.current;
                    const anchor = node?.querySelector<HTMLElement>('.msg');
                    const top = anchor?.getBoundingClientRect().top;
                    void onLoadOlderMessages?.().then(() => {
                      requestAnimationFrame(() => {
                        if (node && anchor?.isConnected && top !== undefined) {
                          node.scrollTop += anchor.getBoundingClientRect().top - top;
                        }
                      });
                    });
                  }}>
                  {olderMessagesLoading ? t('common.loading') : t('chat.loadOlder')}
                </Button>
              ) : null}
              {displayMessages.length === 0 && !loading ? (
                <div className="chat-empty-wrap">
                  {showImportedFolderArtifacts ? (
                    <ImportedFolderArtifacts
                      projectId={projectId}
                      files={importedFolderArtifacts}
                      onOpenFile={onRequestOpenFile}
                      t={t}
                    />
                  ) : (
                    <>
                      <div className="chat-empty">
                        <span className="chat-empty-title">
                          {t('chat.startTitle')}
                        </span>
                      </div>
                      <div className="chat-examples" role="list">
                        {pickStarters(projectMetadata, t).map((ex, i) => (
                          <button
                            key={`${ex.title}-${i}`}
                            type="button"
                            role="listitem"
                            className="chat-example"
                            style={{ animationDelay: `${i * 70}ms` }}
                            onClick={() => {
                                                            composerRef.current?.setDraft(ex.prompt);
                            }}
                            title={t('chat.fillInputTitle')}
                          >
                            <span className="chat-example-icon" aria-hidden>
                              {ex.icon}
                            </span>
                            <span className="chat-example-body">
                              <span className="chat-example-head">
                                <span className="chat-example-title">{ex.title}</span>
                                <span className="chat-example-tag">{ex.tag}</span>
                              </span>
                              <span className="chat-example-prompt">{ex.prompt}</span>
                            </span>
                            <span className="chat-example-cta" aria-hidden>
                              ↵
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              <ChatRows
                messages={displayMessages}
                streaming={streaming}
                liveToolInput={liveToolInput}
                projectId={projectId}
                activeConversationId={activeConversationId}
                activeConversationKey={activeConversationId ?? 'no-conversation'}
                groupMembers={groupMembers}
                onQuoteReply={activeGroupConversation ? handleQuoteReply : undefined}
                onOpenConversation={onSelectConversation}
                projectFiles={projectFiles}
                projectMetadata={projectMetadata}
                projectFileNames={projectFileNames}
                onRequestOpenFile={onRequestOpenFile}
                forceStreamingMessageIds={forceStreamingMessageIds}
                lastAssistantId={lastAssistantId}
                firstUserMessageId={firstUserMessageId}
                errorCardOwnerId={errorCardOwnerId}
                nextUserContentByAssistantId={nextUserContentByAssistantId}
                assistantCallbacksRef={assistantCallbacksRef}
                onContinueRemainingTasks={onContinueRemainingTasks}
                onToolboxAction={handleToolboxAction}
                onNextStepPromptAction={handleNextStepPromptAction}
                onPickSkill={handlePickSkill}
                onArtifactDownload={onArtifactDownload}
                nextStepSkills={skills}
                toolboxSkillNames={featuredToolboxSkillNames}
                nextStepVariant={nextStepVariant}
                onForkFromMessage={onForkFromMessage}
                onAssistantFeedback={onAssistantFeedback}
                forkingMessageId={forkingMessageId}
                t={t}
                onOpenQuestions={onOpenQuestions}
                scrollContainerRef={logRef}
              />
              {displayError ? (
                <div className="run-error" data-tone={runErrorTone}>
                  {/* ① type title + ② detail */}
                  <div className="run-error__main">
                    <span className="run-error__icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.4" />
                        <path d="M8 4.5v4M8 11h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </span>
                    <div className="run-error__copy">
                      {runFailureUi ? (
                        <p className="run-error__title">{t(runFailureUi.titleKey)}</p>
                      ) : null}
                      <p className="run-error__desc">{displayError}</p>
                    </div>
                  </div>
                  {/* ④ collapsible error source */}
                  {errorDiagnosticText ? (
                    <div className={`run-error__source${errorSourceOpen ? ' is-open' : ''}`}>
                      <div className="run-error__source-head">
                        <button
                          type="button"
                          className="run-error__source-bar"
                          aria-expanded={errorSourceOpen}
                          aria-label={
                            errorSourceOpen
                              ? t('chat.runError.sourceCollapseAria')
                              : t('chat.runError.sourceExpandAria')
                          }
                          onClick={() => setErrorSourceOpen((open) => !open)}
                        >
                          <svg className="run-error__source-chevron" viewBox="0 0 12 12" fill="none">
                            <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="run-error__source-label">{t('chat.runError.sourceLabel')}</span>
                          {errorSourcePeek ? (
                            <span className="run-error__source-peek">{errorSourcePeek}</span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          className="run-error__source-copy"
                          onClick={() => void copyErrorDiagnostic()}
                          aria-label={copiedErrorDiagnostic ? t('chat.copyDone') : t('chat.copyErrorDiagnostic')}
                          title={copiedErrorDiagnostic ? t('chat.copyDone') : t('chat.copyErrorDiagnostic')}
                        >
                          <Icon name={copiedErrorDiagnostic ? 'check' : 'copy'} size={13} />
                        </button>
                      </div>
                      <div className="run-error__source-full">
                        <pre>{errorDiagnosticText}</pre>
                      </div>
                    </div>
                  ) : null}
                  {/* ③ fix actions */}
                  {showErrorActions || (retryAssistant && onRetry && runFailureUi) ? (
                    <div className="run-error__actions">
                      {retryAssistant && onRetry && runFailureUi ? (
                        <>
                          {canResumeFailedRun ? (
                            // Resumable failure: continue the agent's existing
                            // CLI session instead of restarting from scratch, so
                            // partial work is kept. Replaces the from-scratch
                            // Retry as the single primary recovery action. Use
                            // the wired resume handler when present, otherwise a
                            // plain send of the continue prompt — never the
                            // re-sending Retry path, which would resume + repeat.
                            <button
                              type="button"
                              className="ghost chat-error-retry"
                              onClick={() =>
                                onResumeRun
                                  ? onResumeRun(retryAssistant)
                                  : onSend(RESUME_CONTINUE_PROMPT, [], [])
                              }
                            >
                              {t('chat.resumeRunCta')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost chat-error-retry"
                              onClick={() => onRetry(retryAssistant)}
                            >
                              {t('preview.retry')}
                            </button>
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {/* Always mounted so the CSS transition can play in both
                directions; the `chat-jump-btn-active` class flips the
                slide + opacity, and `aria-hidden` + `tabIndex={-1}`
                keep it out of the a11y tree when it's not visible.
                Also suppressed while the conversation-history dropdown is
                open: the dropdown sits in a separate stacking context, so
                without this the button bleeds through it (#4123). */}
            <button
              type="button"
              className={`chat-jump-btn${scrolledFromBottom && !showConvList ? ' chat-jump-btn-active' : ''}`}
              onClick={jumpToBottom}
              title={t('chat.scrollToLatest')}
              aria-hidden={!scrolledFromBottom || showConvList}
              tabIndex={scrolledFromBottom && !showConvList ? 0 : -1}
            >
              <Icon name="arrow-up" size={12} style={{ transform: 'rotate(180deg)' }} />
              <span>{t('chat.jumpToLatest')}</span>
            </button>
          </div>
          <QueuedSendStrip
            containerRef={queuedSendStripRef}
            items={queuedItems}
            editingId={editingQueuedSendId}
            onEdit={(item) => {
                            restoreQueuedSendToComposer(item);
            }}
            onRemove={onRemoveQueuedSend
              ? (id) => {
                                    onRemoveQueuedSend(id);
                }
              : undefined}
            onReorder={onReorderQueuedSends}
            onSendNow={onSendQueuedNow
              ? (id) => {
                                    onSendQueuedNow(id);
                }
              : undefined}
          />
          <div
            className="chat-composer-slot"
            ref={composerSlotRef}
            style={composerSlotStyle}
            aria-hidden={shouldPortalComposer ? true : undefined}
          >
            {shouldPortalComposer ? null : composerNode}
          </div>
          {shouldPortalComposer && composerPortalTarget && composerPortalRect
            ? createPortal(
                <div
                  className="chat-composer-fixed-layer"
                  ref={composerLayerRef}
                  style={{
                    left: composerPortalRect.left,
                    bottom: composerPortalRect.bottom,
                    width: composerPortalRect.width,
                  }}
                >
                  {composerNode}
                </div>,
                composerPortalTarget,
              )
            : null}
        </>
      ) : null}
    </div>
  );
}

interface AssistantCallbacks {
  onContinueRemainingTasks:
    | ((assistantMessage: ChatMessage, todos: TodoItem[]) => void)
    | undefined;
  onAssistantFeedback:
    | ((message: ChatMessage, change: ChatMessageFeedbackChange) => void)
    | undefined;
  onForkFromMessage: ((message: ChatMessage) => void) | undefined;
}

type ChatRenderItem = {
  kind: 'message';
  key: string;
  message: ChatMessage;
};

function ChatConversationLoading({ t }: { t: TranslateFn }) {
  return (
    <div className="chat-loading-state" role="status" aria-live="polite">
      <span className="chat-loading-mark" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="chat-loading-copy">{t('common.loading')}</span>
      <span className="chat-loading-lines" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function ChatRows({
  messages,
  streaming,
  liveToolInput,
  projectId,
  activeConversationId,
  activeConversationKey,
  groupMembers,
  onQuoteReply,
  onOpenConversation,
  projectFiles,
  projectMetadata,
  projectFileNames,
  onRequestOpenFile,
  forceStreamingMessageIds,
  lastAssistantId,
  firstUserMessageId,
  errorCardOwnerId,
  nextUserContentByAssistantId,
  assistantCallbacksRef,
  onContinueRemainingTasks,
  onToolboxAction,
  onNextStepPromptAction,
  onPickSkill,
  onArtifactDownload,
  nextStepSkills,
  toolboxSkillNames,
  nextStepVariant,
  onForkFromMessage,
  onAssistantFeedback,
  forkingMessageId,
  t,
  onOpenQuestions,
  scrollContainerRef,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  liveToolInput?: Record<string, { name: string; text: string; seq?: number }>;
  projectId: string | null;
  activeConversationId: string | null;
  activeConversationKey: string;
  /** Group-chat roster (resolved names) when the active conversation is a
   *  group; drives the "@member" attribution row on dispatched user turns. */
  groupMembers?: ProjectMemberRole[];
  /** Quote-reply action (group conversations only): drafts a quote of the
   *  clicked message into the composer's reply bar. */
  onQuoteReply?: (message: ChatMessage) => void;
  /** Switch to another conversation (group-task provenance chip target). */
  onOpenConversation?: (conversationId: string) => void;
  projectFiles: ProjectFile[];
  projectMetadata?: ProjectMetadata;
  projectFileNames?: Set<string>;
  onRequestOpenFile?: (name: string) => void;
  forceStreamingMessageIds?: Set<string>;
  lastAssistantId: string | undefined;
  firstUserMessageId: string | undefined;
  errorCardOwnerId: string | null;
  nextUserContentByAssistantId: Map<string, string>;
  assistantCallbacksRef: MutableRefObject<AssistantCallbacks>;
  onContinueRemainingTasks?: (assistantMessage: ChatMessage, todos: TodoItem[]) => void;
  onToolboxAction?: (id: DesignToolboxActionId) => void;
  onNextStepPromptAction?: (
    prompt: string,
    options?: { sessionMode?: ChatSessionMode },
  ) => void;
  onPickSkill?: (skillId: string) => void;
  onArtifactDownload?: (fileName: string) => void;
  nextStepSkills?: SkillSummary[];
  toolboxSkillNames?: Partial<Record<DesignToolboxActionId, string | null>>;
  nextStepVariant?: NextStepActionsVariant;
  onForkFromMessage?: (message: ChatMessage) => void;
  onAssistantFeedback?: (message: ChatMessage, change: ChatMessageFeedbackChange) => void;
  forkingMessageId?: string | null;
  t: TranslateFn;
  onOpenQuestions?: (request?: QuestionFormOpenRequest) => void;
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const conversationTodoInput = useMemo(
    () => latestTodoWriteInputForPinnedCard(messages),
    [messages],
  );
  const conversationTodoAnchorMessageId = useMemo(
    () => firstTodoWriteAssistantMessageId(messages),
    [messages],
  );
  const items = useMemo(
    () => buildChatRenderItems(messages),
    [messages],
  );
  const virtualized = items.length > CHAT_MESSAGE_VIRTUALIZE_THRESHOLD;
  const virtualWindow = useMeasuredVirtualWindow(items, {
    enabled: virtualized,
    containerRef: scrollContainerRef,
    estimateSize: estimateChatRenderItemHeight,
    overscanPx: CHAT_MESSAGE_OVERSCAN_PX,
    resetKey: activeConversationKey,
    initialTailRows: CHAT_VIRTUAL_INITIAL_TAIL_ROWS,
    alwaysIncludeKey:
      conversationTodoInput != null && conversationTodoAnchorMessageId
        ? `message:${conversationTodoAnchorMessageId}`
        : undefined,
  });

  const renderItem = (item: ChatRenderItem) => {
    const m = item.message;
    const messageStreaming = isAssistantMessageStreaming(
      m,
      streaming,
      lastAssistantId,
      forceStreamingMessageIds,
    );
    // MatOS group dispatch notices: daemon-posted system rows explaining why
    // a written handoff did NOT dispatch (unknown member, relay off, hop cap,
    // enqueue failure). Rendered as a subtle inline notice, not a bubble —
    // they are operational feedback, not a member's turn.
    if (m.role === 'system') {
      return (
        <div className="msg-group-addressed-row" data-testid="msg-group-dispatch-notice">
          <span className="msg-group-addressed-chip" title={m.id}>
            <Icon name="info" size={10} />
            <span style={{ whiteSpace: 'pre-line' }}>{m.content}</span>
          </span>
        </div>
      );
    }
    // MatOS group-task provenance: DM rows the daemon mirrored from a group
    // chat carry `groupTask`; render a chip above the row that names the
    // source group (and jumps to it) so the member's DM reads as their work
    // ledger. Kept outside UserMessage/AssistantMessage so their memoization
    // is untouched.
    const groupTaskChip = m.groupTask ? (
      <GroupTaskProvenanceChip
        groupTask={m.groupTask}
        role={m.role}
        t={t}
        onOpenConversation={onOpenConversation}
      />
    ) : null;
    // Feishu-style quote chip: which earlier message this turn replies to.
    // Dispatch stubs carry it from the daemon; user turns carry it from the
    // composer's quote bar.
    const replyQuoteChip = m.replyTo ? (
      <div
        className={`msg-group-addressed-row${m.role === 'assistant' ? ' is-assistant' : ''}`}
        data-testid="msg-reply-quote"
      >
        <span className="msg-group-addressed-chip msg-reply-quote-chip" title={m.replyTo.messageId}>
          <Icon name="comment" size={10} />
          {(m.replyTo.authorName ?? t('chat.replyQuoteUser')) +
            (m.replyTo.excerpt ? `: ${m.replyTo.excerpt}` : '')}
        </span>
      </div>
    ) : null;
    // Quote action (group conversations only): drafts this message into the
    // composer's reply bar.
    const quoteActionChip =
      onQuoteReply && String(m.content ?? '').trim()
        ? (
          <button
            type="button"
            className="msg-group-addressed-chip msg-quote-reply-btn"
            onClick={() => onQuoteReply(m)}
            title={t('chat.replyQuoteAction')}
            data-testid={`msg-quote-reply-${m.id}`}
          >
            <Icon name="comment" size={10} />
            {t('chat.replyQuoteAction')}
          </button>
        )
        : null;
    if (m.role === 'user') {
      // Group chat: name whom this turn was addressed to (Feishu-style),
      // matching the `## user (@NAME)` attribution the agents see.
      const addressedMember =
        !m.groupTask && groupMembers && groupMembers.length > 0 && m.roleRef
          ? findByRoleRef(groupMembers, m.roleRef) ?? null
          : null;
      return (
        <>
          {groupTaskChip}
          {replyQuoteChip}
          {addressedMember || quoteActionChip ? (
            <div
              className="msg-group-addressed-row"
              {...(addressedMember ? { 'data-testid': 'msg-group-addressed' } : {})}
            >
              {addressedMember ? (
                <span className="msg-group-addressed-chip" title={addressedMember.ref}>
                  <Icon name="users" size={10} />
                  {t('chat.groupAddressedTo', { member: addressedMember.name })}
                </span>
              ) : null}
              {quoteActionChip}
            </div>
          ) : null}
          <UserMessage
            message={m}
            projectId={projectId}
            projectFileNames={projectFileNames}
            onRequestOpenFile={onRequestOpenFile}
            t={t}
          />
        </>
      );
    }
    // Group chat: name which member produced this assistant turn, mirroring
    // the `## assistant (member: NAME)` attribution the agents see.
    const speakingMember =
      !m.groupTask && groupMembers && groupMembers.length > 0 && m.roleRef
        ? findByRoleRef(groupMembers, m.roleRef) ?? null
        : null;
    if (groupTaskChip || speakingMember || replyQuoteChip || quoteActionChip) {
      return (
        <>
          {groupTaskChip}
          {replyQuoteChip}
          {speakingMember || quoteActionChip ? (
            <div
              className="msg-group-addressed-row is-assistant"
              {...(speakingMember ? { 'data-testid': 'msg-group-speaker' } : {})}
            >
              {speakingMember ? (
                <span className="msg-group-addressed-chip" title={speakingMember.ref}>
                  <Icon name="sparkles" size={10} />
                  @{speakingMember.name}
                </span>
              ) : null}
              {quoteActionChip}
            </div>
          ) : null}
          {renderAssistantRow(m, messageStreaming)}
        </>
      );
    }
    return renderAssistantRow(m, messageStreaming);
  };

  const renderAssistantRow = (m: ChatMessage, messageStreaming: boolean) => {
    return (
      <AssistantMessage
        message={m}
        streaming={messageStreaming}
        // Only the streaming row consumes live tool input. Non-streaming rows
        // get a stable `undefined`, so adding `liveToolInput` to the memo
        // comparator re-renders just this row per `tool_input_delta`, not all N.
        liveToolInput={messageStreaming ? liveToolInput : undefined}
        showConversationTodoCard={m.id === conversationTodoAnchorMessageId}
        conversationTodoInput={conversationTodoInput}
        projectId={projectId}
        conversationId={activeConversationId}
        projectFiles={projectFiles}
        projectMetadata={projectMetadata}
        projectFileNames={projectFileNames}
        onRequestOpenFile={onRequestOpenFile}
        isLast={m.id === lastAssistantId}
        errorCardOwnerId={errorCardOwnerId}
        nextUserContent={nextUserContentByAssistantId.get(m.id)}
        onOpenQuestions={onOpenQuestions}
        onContinueRemainingTasks={
          m.id === lastAssistantId && onContinueRemainingTasks
            ? (todos) => assistantCallbacksRef.current.onContinueRemainingTasks?.(m, todos)
            : undefined
        }
        onForkFromMessage={
          onForkFromMessage
            ? () => assistantCallbacksRef.current.onForkFromMessage?.(m)
            : undefined
        }
        forking={forkingMessageId === m.id}
        onFeedback={
          onAssistantFeedback
            ? (rating) => assistantCallbacksRef.current.onAssistantFeedback?.(m, rating)
            : undefined
        }
        onToolboxAction={onToolboxAction}
        onNextStepPromptAction={onNextStepPromptAction}
        onPickSkill={onPickSkill}
        onArtifactDownload={onArtifactDownload}
        nextStepSkills={nextStepSkills}
        toolboxSkillNames={toolboxSkillNames}
        nextStepVariant={nextStepVariant}
      />
    );
  };

  if (items.length === 0) return null;

  if (!virtualized) {
    return (
      <>
        {items.map((item) => (
          <Fragment key={item.key}>{renderItem(item)}</Fragment>
        ))}
      </>
    );
  }

  return (
    <div
      className="chat-virtual-spacer"
      data-testid="chat-virtual-spacer"
      style={{ height: virtualWindow.totalHeight }}
    >
      {virtualWindow.rows.map((row) => (
        <VirtualChatRow
          key={row.item.key}
          itemKey={row.item.key}
          top={row.top}
          onMeasure={virtualWindow.onMeasure}
        >
          {renderItem(row.item)}
        </VirtualChatRow>
      ))}
    </div>
  );
}

// Dedicated header bar for a MatOS group chat (Feishu-style department group):
// a users glyph, the inline-renamable group title, a member roster strip
// (avatars + names), and a manage-members affordance. Renders only when the
// active conversation is a multi-member group, giving the group its own page
// identity instead of looking like a plain conversation.
function GroupChatHeader({
  conversation,
  members,
  onRename,
  onManageMembers,
  t,
}: {
  conversation: Conversation;
  members: ProjectMemberRole[];
  onRename?: (id: string, title: string) => void;
  onManageMembers?: () => void;
  t: TranslateFn;
}) {
  const [renaming, setRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const title = conversation.title?.trim() || t('project.groupChatTitle');
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);
  const commitRename = (next: string) => {
    setRenaming(false);
    const trimmed = next.trim();
    if (trimmed && trimmed !== (conversation.title ?? '').trim()) {
      onRename?.(conversation.id, trimmed);
    }
  };
  const shown = members.slice(0, 6);
  const overflow = members.length - shown.length;
  return (
    <div className="chat-group-header" data-testid="chat-group-header">
      <span className="chat-group-header-icon" aria-hidden>
        <Icon name="users" size={15} />
      </span>
      <div className="chat-group-header-main">
        {renaming ? (
          <input
            ref={inputRef}
            className="chat-group-header-rename"
            defaultValue={conversation.title ?? ''}
            placeholder={t('project.groupChatTitle')}
            data-testid="chat-group-header-rename-input"
            onBlur={(event) => commitRename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              if (event.key === 'Escape') {
                (event.target as HTMLInputElement).value = conversation.title ?? '';
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="chat-group-header-title"
            title={onRename ? t('project.renameChat') : title}
            data-testid="chat-group-header-title"
            onClick={() => onRename && setRenaming(true)}
          >
            <span className="chat-group-header-title-text">{title}</span>
            {onRename ? <Icon name="pencil" size={11} /> : null}
          </button>
        )}
        <span className="chat-group-header-meta">
          {t('project.groupMemberCount', { count: members.length })}
        </span>
      </div>
      <div className="chat-group-header-roster">
        {shown.map((member) => (
          <span
            key={member.ref}
            className="chat-group-header-avatar"
            title={member.name}
            data-testid={`chat-group-header-avatar-${member.id}`}
          >
            {(member.name || member.id).slice(0, 1).toUpperCase()}
          </span>
        ))}
        {overflow > 0 ? (
          <span className="chat-group-header-avatar chat-group-header-avatar--more">
            +{overflow}
          </span>
        ) : null}
      </div>
      {onManageMembers ? (
        <button
          type="button"
          className="chat-group-header-manage"
          title={t('project.inviteMembers')}
          aria-label={t('project.inviteMembers')}
          data-testid="chat-group-header-manage"
          onClick={onManageMembers}
        >
          <Icon name="plus" size={14} />
        </button>
      ) : null}
    </div>
  );
}

// Provenance chip for DM work-ledger rows mirrored from a group chat: names
// the source group + member and jumps back to the group conversation. The
// user-side row is the dispatched task; the assistant-side row is the
// member's work record.
function GroupTaskProvenanceChip({
  groupTask,
  role,
  t,
  onOpenConversation,
}: {
  groupTask: NonNullable<ChatMessage['groupTask']>;
  role: ChatMessage['role'];
  t: TranslateFn;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const title = groupTask.sourceConversationTitle?.trim() || t('chat.untitledConversation');
  const member = groupTask.memberName?.trim() || groupTask.memberRef.replace(/^role:/, '');
  const label =
    role === 'user'
      ? t('chat.groupTaskDispatchLabel', { title })
      : t('chat.groupTaskRecordLabel', { member, title });
  const canOpen = Boolean(onOpenConversation);
  return (
    <div
      className={`msg-group-task-row${role === 'user' ? ' is-user' : ''}`}
      data-testid="msg-group-task-chip"
    >
      <button
        type="button"
        className="msg-group-task-chip"
        disabled={!canOpen}
        title={canOpen ? t('chat.groupTaskOpen') : label}
        onClick={() => onOpenConversation?.(groupTask.sourceConversationId)}
      >
        <Icon name="users" size={10} />
        <span className="msg-group-task-label">{label}</span>
        {canOpen ? <Icon name="chevron-right" size={9} /> : null}
      </button>
    </div>
  );
}

function VirtualChatRow({
  itemKey,
  top,
  onMeasure,
  children,
}: {
  itemKey: string;
  top: number;
  onMeasure: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      onMeasure(itemKey, height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [itemKey, onMeasure]);

  return (
    <div
      ref={rowRef}
      className="chat-virtual-row"
      style={{ transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}

function exportFileStem(title: string | null | undefined): string {
  const stem = (title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return stem || 'conversation';
}

function buildChatRenderItems(messages: ChatMessage[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    items.push({
      kind: 'message',
      key: `message:${message.id}`,
      message,
    });
  }
  return items;
}

function firstTodoWriteAssistantMessageId(messages: ChatMessage[]): string | null {
  const message = messages.find(
    (candidate) =>
      candidate.role === 'assistant' &&
      candidate.events?.some(
        (event) => event.kind === 'tool_use' && isTodoWriteToolName(event.name),
      ),
  );
  return message?.id ?? null;
}

function estimateChatRenderItemHeight(item: ChatRenderItem): number {
  const message = item.message;
  const contentLength = message.content?.length ?? 0;
  const attachmentCount = (message.attachments?.length ?? 0) + (message.commentAttachments?.length ?? 0);
  const eventCount = message.events?.length ?? 0;
  const fileCount = message.producedFiles?.length ?? 0;
  const base = message.role === 'user' ? 82 : 118;
  const contentRows = Math.min(18, Math.ceil(contentLength / 120));
  return (
    base
    + contentRows * 18
    + attachmentCount * 34
    + eventCount * 28
    + fileCount * 32
    + CHAT_VIRTUAL_ROW_GAP_PX
  );
}

function useMeasuredVirtualWindow<T extends { key: string }>(
  items: T[],
  {
    enabled,
    containerRef,
    estimateSize,
    overscanPx,
    resetKey,
    initialTailRows,
    alwaysIncludeKey,
  }: {
    enabled: boolean;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    estimateSize: (item: T) => number;
    overscanPx: number;
    resetKey: string;
    initialTailRows: number;
    alwaysIncludeKey?: string;
  },
) {
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  useEffect(() => {
    measuredHeightsRef.current.clear();
    setMeasureVersion((version) => version + 1);
    setViewport({ scrollTop: 0, height: 0 });
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    const el = containerRef.current;
    if (!el) return undefined;
    let frame: number | null = null;
    const readViewport = () => {
      frame = null;
      setViewport((current) => {
        const next = {
          scrollTop: el.scrollTop,
          height: el.clientHeight || CHAT_VIRTUAL_DEFAULT_VIEWPORT_PX,
        };
        return current.scrollTop === next.scrollTop && current.height === next.height
          ? current
          : next;
      });
    };
    const scheduleRead = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(readViewport);
    };
    scheduleRead();
    el.addEventListener('scroll', scheduleRead, { passive: true });
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleRead)
        : null;
    observer?.observe(el);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', scheduleRead);
      observer?.disconnect();
    };
  }, [containerRef, enabled]);

  const layout = useMemo(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    let cursor = 0;
    for (const item of items) {
      offsets.push(cursor);
      const measured = measuredHeightsRef.current.get(item.key);
      const size = Math.max(
        CHAT_VIRTUAL_MIN_ROW_HEIGHT,
        measured ?? estimateSize(item),
      );
      sizes.push(size);
      cursor += size;
    }
    return { offsets, sizes, totalHeight: cursor };
  }, [estimateSize, items, measureVersion]);

  const rows = useMemo(() => {
    if (!enabled || items.length === 0) return [];
    const height = viewport.height || CHAT_VIRTUAL_DEFAULT_VIEWPORT_PX;
    if (viewport.scrollTop === 0 && viewport.height === 0) {
      const start = Math.max(0, items.length - initialTailRows);
      const rows = items.slice(start).map((item, offset) => {
        const index = start + offset;
        return { item, index, top: layout.offsets[index] ?? 0 };
      });
      return includeVirtualRowByKey(rows, items, layout.offsets, alwaysIncludeKey);
    }
    const startTarget = Math.max(0, viewport.scrollTop - overscanPx);
    const endTarget = viewport.scrollTop + height + overscanPx;
    let start = 0;
    while (
      start < items.length - 1
      && (layout.offsets[start] ?? 0) + (layout.sizes[start] ?? 0) < startTarget
    ) {
      start += 1;
    }
    let end = start;
    while (end < items.length && (layout.offsets[end] ?? 0) <= endTarget) {
      end += 1;
    }
    const rows = items.slice(start, end).map((item, offset) => {
      const index = start + offset;
      return { item, index, top: layout.offsets[index] ?? 0 };
    });
    return includeVirtualRowByKey(rows, items, layout.offsets, alwaysIncludeKey);
  }, [
    alwaysIncludeKey,
    enabled,
    initialTailRows,
    items,
    layout.offsets,
    layout.sizes,
    overscanPx,
    viewport.height,
    viewport.scrollTop,
  ]);

  const onMeasure = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const next = Math.max(CHAT_VIRTUAL_MIN_ROW_HEIGHT, Math.ceil(height));
    const previous = measuredHeightsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - next) < 2) return;
    measuredHeightsRef.current.set(key, next);
    setMeasureVersion((version) => version + 1);
  }, []);

  return {
    rows,
    totalHeight: layout.totalHeight,
    onMeasure,
  };
}

function includeVirtualRowByKey<T extends { key: string }>(
  rows: Array<{ item: T; index: number; top: number }>,
  items: T[],
  offsets: number[],
  key: string | undefined,
): Array<{ item: T; index: number; top: number }> {
  if (!key || rows.some((row) => row.item.key === key)) return rows;
  const index = items.findIndex((item) => item.key === key);
  if (index === -1) return rows;
  return [
    ...rows,
    {
      item: items[index]!,
      index,
      top: offsets[index] ?? 0,
    },
  ].sort((a, b) => a.index - b.index);
}

function QueuedSendStrip({
  containerRef,
  editingId,
  items,
  onEdit,
  onRemove,
  onReorder,
  onSendNow,
}: {
  containerRef?: MutableRefObject<HTMLDivElement | null>;
  editingId?: string | null;
  items: QueuedSendItem[];
  onEdit?: (item: QueuedSendItem) => void;
  onRemove?: (id: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onSendNow?: (id: string) => void;
}) {
  const t = useT();
  const [dragState, setDragState] = useState<QueuedSendDragState | null>(null);
  if (items.length === 0) return null;
  const canReorder = Boolean(onReorder && items.length > 1);
  const overflowCount = Math.max(0, items.length - QUEUED_SEND_VISIBLE_ROW_COUNT);

  const handleDragStart = (
    event: ReactDragEvent<HTMLButtonElement>,
    item: QueuedSendItem,
  ) => {
    if (!canReorder) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(QUEUED_SEND_DRAG_MIME, item.id);
    event.dataTransfer.setData('text/plain', item.id);
    setDragState({ draggingId: item.id, overId: item.id, edge: null });
  };

  const handleDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string,
  ) => {
    if (!canReorder) return;
    const draggingId = dragState?.draggingId || event.dataTransfer.getData(QUEUED_SEND_DRAG_MIME);
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingId === targetId) {
      if (dragState?.overId !== targetId || dragState.edge !== null) {
        setDragState({ draggingId, overId: targetId, edge: null });
      }
      return;
    }
    const edge = queuedDropEdgeForEvent(event);
    if (
      dragState?.draggingId !== draggingId
      || dragState.overId !== targetId
      || dragState.edge !== edge
    ) {
      setDragState({ draggingId, overId: targetId, edge });
    }
  };

  const handleDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string,
  ) => {
    if (!canReorder) return;
    event.preventDefault();
    const draggingId =
      dragState?.draggingId
      || event.dataTransfer.getData(QUEUED_SEND_DRAG_MIME)
      || event.dataTransfer.getData('text/plain');
    if (!draggingId || draggingId === targetId) {
      setDragState(null);
      return;
    }
    const edge = dragState?.overId === targetId && dragState.edge
      ? dragState.edge
      : queuedDropEdgeForEvent(event);
    const nextIds = reorderQueuedSendIds(items, draggingId, targetId, edge);
    if (nextIds.join('\0') !== items.map((item) => item.id).join('\0')) {
      onReorder?.(nextIds);
    }
    setDragState(null);
  };

  return (
    <div
      ref={containerRef}
      className="chat-queued-send-strip"
      data-testid="chat-queued-send-strip"
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        setDragState(null);
      }}
    >
      <div className="chat-queued-send-header">
        <div className="chat-queued-send-heading">
          <strong>
            {items.length} {t('chat.queuedHeader')}
          </strong>
          <span aria-hidden>↩</span>
          <span>{t('chat.queuedToSend')}</span>
        </div>
      </div>
      <div className={`chat-queued-send-list${overflowCount > 0 ? ' is-scrollable' : ''}`}>
        {items.map((item, index) => {
          const isDragging = dragState?.draggingId === item.id;
          const dropClass = dragState?.overId === item.id
            && dragState.draggingId !== item.id
            && dragState.edge
            ? ` chat-queued-send-row-drop-${dragState.edge}`
            : '';
          return (
            <div
              className={`chat-queued-send-row${index === 0 ? ' chat-queued-send-row-active' : ''}${
                editingId === item.id ? ' chat-queued-send-row-editing' : ''
              }${isDragging ? ' chat-queued-send-row-dragging' : ''}${dropClass}`}
              key={item.id}
              onDragOver={(event) => handleDragOver(event, item.id)}
              onDrop={(event) => handleDrop(event, item.id)}
            >
              <button
                type="button"
                className="chat-queued-send-drag-handle chat-queued-send-tooltip od-tooltip"
                title={t('chat.queuedReorder')}
                data-tooltip={t('chat.queuedReorder')}
                data-tooltip-placement="right"
                aria-label={t('chat.queuedReorder')}
                draggable={canReorder}
                disabled={!canReorder}
                onDragStart={(event) => handleDragStart(event, item)}
                onDragEnd={() => setDragState(null)}
              >
                <Icon name="grip-vertical" size={14} />
              </button>
              <div className="chat-queued-send-main">
                <span className="chat-queued-send-title">{summarizeQueuedPrompt(item, t)}</span>
                <QueuedSendMetaChips item={item} />
              </div>
              <div className="chat-queued-send-actions">
                {onEdit ? (
                  <button
                    type="button"
                    className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                    title={t('chat.queuedEdit')}
                    data-tooltip={t('chat.queuedEdit')}
                    data-tooltip-placement="top"
                    aria-label={t('chat.queuedEdit')}
                    onClick={() => onEdit(item)}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                  title={t('chat.send')}
                  data-tooltip={t('chat.send')}
                  data-tooltip-placement="top"
                  aria-label={t('chat.send')}
                  data-testid="chat-queued-send-now"
                  onClick={() => onSendNow?.(item.id)}
                  disabled={!onSendNow}
                >
                  <Icon name="arrow-up" size={13} />
                </button>
                {onRemove ? (
                  <button
                    type="button"
                    className="chat-queued-send-action chat-queued-send-tooltip od-tooltip"
                    onClick={() => onRemove(item.id)}
                    title={t('chat.comments.remove')}
                    data-tooltip={t('chat.comments.remove')}
                    data-tooltip-placement="top"
                    aria-label={t('chat.comments.remove')}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {overflowCount > 0 ? (
        <div className="chat-queued-send-overflow">
          +{overflowCount} {t('chat.queuedMore')}
        </div>
      ) : null}
    </div>
  );
}

const QUEUED_SEND_DRAG_MIME = 'application/x-open-design-queued-send';
const QUEUED_SEND_VISIBLE_ROW_COUNT = 4;

type QueuedSendDropEdge = 'before' | 'after';

interface QueuedSendDragState {
  draggingId: string;
  overId: string | null;
  edge: QueuedSendDropEdge | null;
}

function queuedDropEdgeForEvent(event: ReactDragEvent<HTMLElement>): QueuedSendDropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function reorderQueuedSendIds(
  items: QueuedSendItem[],
  draggingId: string,
  targetId: string,
  edge: QueuedSendDropEdge,
): string[] {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(draggingId);
  if (from < 0) return ids;
  const [draggedId] = ids.splice(from, 1);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex < 0 || !draggedId) return items.map((item) => item.id);
  ids.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId);
  return ids;
}

function summarizeQueuedPrompt(item: QueuedSendItem, t: TranslateFn): string {
  const normalized = item.prompt.replace(/\s+/g, ' ').trim();
  const text = normalized || t('chat.queuedFollowUpFallback');
  return text.length > 58 ? `${text.slice(0, 57)}...` : text;
}

// Surfaces what a queued turn carries — attachments, visual marks, and the
// staged skill / MCP context from its meta — as compact
// chips so the user can see (and trust) what will be sent without expanding it.
// Counts use the same plain-English style as the rest of this strip.
function QueuedSendMetaChips({ item }: { item: QueuedSendItem }) {
  const ctx = item.meta?.context;
  const files = item.attachments?.length ?? 0;
  const marks = item.commentAttachments?.length ?? 0;
  const skills = ctx?.skillIds?.length ?? 0;
  const mcp = ctx?.mcpServerIds?.length ?? 0;
  const workspace = ctx?.workspaceItems?.length ?? 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const chips: Array<{ key: string; label: string }> = [];
  if (files > 0) chips.push({ key: 'files', label: plural(files, 'file') });
  if (marks > 0) chips.push({ key: 'marks', label: plural(marks, 'mark') });
  if (skills > 0) chips.push({ key: 'skills', label: plural(skills, 'skill') });
  if (mcp > 0) chips.push({ key: 'mcp', label: `${mcp} MCP` });
  if (workspace > 0) chips.push({ key: 'workspace', label: plural(workspace, 'workspace context') });
  if (chips.length === 0) return null;
  return (
    <div className="chat-queued-send-chips">
      {chips.map((chip) => (
        <span key={chip.key} className="chat-queued-send-chip">
          {chip.label}
        </span>
      ))}
    </div>
  );
}



function isActiveRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'queued' || status === 'running';
}

function isTerminalRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export function retryableAssistantMessage(
  messages: ChatMessage[],
  lastAssistantId: string | null | undefined,
  paneStreaming: boolean,
): ChatMessage | null {
  if (paneStreaming) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (last.id !== lastAssistantId) return null;
  return last.runStatus === 'failed' ? last : null;
}

export function isAssistantMessageStreaming(
  message: ChatMessage,
  paneStreaming: boolean,
  lastAssistantId: string | null | undefined,
  forceStreamingMessageIds?: Set<string>,
): boolean {
  if (message.role !== 'assistant') return false;
  if (forceStreamingMessageIds?.has(message.id)) return true;
  if (isActiveRunStatus(message.runStatus)) return true;
  if (message.id !== lastAssistantId) return false;
  if (!paneStreaming) return false;
  if (message.endedAt !== undefined) return false;
  if (isTerminalRunStatus(message.runStatus)) return false;
  return true;
}

export function buildRunErrorDiagnosticText(input: RunErrorDiagnosticInput): string {
  const lines: string[] = [];
  const sourceText = input.rawMessage?.trim() || input.message.trim();
  if (sourceText) {
    lines.push(sourceText, '');
  }

  const hasRunContext = Boolean(
    input.traceId ||
    input.errorCode ||
    input.conversationId ||
    input.assistantMessageId ||
    input.agentId,
  );
  if (hasRunContext) {
    lines.push(
      'MatOS run error diagnostics',
      `trace_id: ${input.traceId ?? 'n/a'}`,
      `run_id: ${input.traceId ?? 'n/a'}`,
      `error_code: ${input.errorCode ?? 'n/a'}`,
      `project_id: ${input.projectId ?? 'n/a'}`,
      `conversation_id: ${input.conversationId ?? 'n/a'}`,
      `assistant_message_id: ${input.assistantMessageId ?? 'n/a'}`,
      `agent_id: ${input.agentId ?? 'n/a'}`,
    );
  } else {
    // Conversation bootstrap failures happen before a run, trace, assistant
    // message, or conversation exists. Calling those "run diagnostics" and
    // printing seven n/a fields obscures the actual project/API failure.
    lines.push(
      'MatOS project error diagnostics',
      `project_id: ${input.projectId ?? 'n/a'}`,
    );
  }

  return lines.join('\n');
}

function filterConversations(
  conversations: Conversation[],
  query: string,
  t: TranslateFn,
): Conversation[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return conversations;
  return conversations.filter((conversation) => {
    const title = conversation.title || t('chat.untitledConversation');
    const meta = conversationMetaLabel(conversation, t);
    return `${title} ${conversation.id} ${meta}`.toLocaleLowerCase().includes(normalized);
  });
}

function conversationMessageCount(
  conversation: Conversation,
  activeConversationId: string | null,
  messagesConversationId: string | null,
  activeMessageCount: number,
  partial = false,
): number | null {
  // The live `messages` array is authoritative for the active conversation —
  // it stays fresh as a run streams new turns in — but ONLY once it has
  // actually loaded for that conversation. While a switch is mid-flight (or a
  // load failed) `messages` is reset to [] and `messagesConversationId` no
  // longer matches the active id; trusting `messages.length` there renders a
  // phantom "0 msg". Fall back to the persisted server count until the live
  // array catches up.
  if (
    conversation.id === activeConversationId &&
    messagesConversationId === activeConversationId
  ) {
    // A recent page is not the total transcript. Keep the server total until
    // all history has actually been loaded, without hiding new local rows.
    return partial ? Math.max(conversation.messageCount ?? 0, activeMessageCount) : activeMessageCount;
  }
  return typeof conversation.messageCount === 'number' ? conversation.messageCount : null;
}

function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const compact = Math.floor(value / 100) / 10;
  return `${compact}k`;
}

function ConversationRow({
  conversation,
  active,
  messageCount,
  onSelect,
  onDelete,
  t,
}: {
  conversation: Conversation;
  active: boolean;
  messageCount: number | null;
  onSelect: () => void;
  onDelete: () => void;
  t: TranslateFn;
}) {
  const displayTitle =
    conversation.title || t('chat.untitledConversation');

  return (
    <div
      className={`chat-conv-item${active ? ' active' : ''}`}
      data-testid={`conversation-item-${conversation.id}`}
    >
      <button
        type="button"
        className="chat-conv-item-name"
        data-testid={`conversation-select-${conversation.id}`}
        style={{ background: 'transparent', border: 'none', padding: 0, textAlign: 'left' }}
        onClick={onSelect}
      >
        {displayTitle}
      </button>
      <span
        className="chat-conv-item-meta"
        data-testid={`conversation-meta-${conversation.id}`}
      >
        {messageCount !== null ? `${compactCount(messageCount)} msg · ` : ''}
        {conversationMetaLabel(conversation, t)}
      </span>
      <button
        type="button"
        className="chat-conv-item-del"
        data-testid={`conversation-delete-${conversation.id}`}
        title={t('chat.deleteConversation')}
        onClick={(e) => {
          e.stopPropagation();
          if (
            confirm(t('chat.deleteConversationConfirm', { title: displayTitle }))
          ) {
            onDelete();
          }
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

// Memoized (hoisted impl referenced below): a static user message has stable
// props, so it skips re-render while a later turn streams.
const UserMessage = memo(UserMessageImpl);

function UserMessageImpl({
  message,
  projectId,
  projectFileNames,
  onRequestOpenFile,
  t,
}: {
  message: ChatMessage;
  projectId: string | null;
  projectFileNames?: Set<string>;
  onRequestOpenFile?: (name: string) => void;
  t: TranslateFn;
}) {
  const attachments = sortChatAttachmentsForDisplay(message.attachments ?? []);
  const commentAttachments = message.commentAttachments ?? [];
  const workspaceItems = message.runContext?.workspaceItems ?? [];
  const hasRunContext = Boolean(
    message.sessionMode ||
      workspaceItems.length > 0
  );
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    if (!message.content) return;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    const ok = await copyToClipboard(message.content);
    if (!ok) return;
    setCopied(true);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = undefined;
    }, 2000);
  }

  return (
    <div className="msg user">
      <span className="sr-only">{t('chat.you')}</span>
      {hasRunContext ? (
        <div className="msg-run-context-row" data-testid="msg-run-context-row">
          {message.sessionMode ? (
            <MessageSessionModeChip mode={message.sessionMode} t={t} />
          ) : null}
          {workspaceItems.map((item) => (
            <ActiveWorkspaceContextChip
              key={`${item.kind}:${item.id}`}
              item={item}
              onOpen={onRequestOpenFile}
            />
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="user-attachments">
          {attachments.map((a, index) => {
            const baseName = a.path.split('/').pop() || a.path;
            const openable =
              !!onRequestOpenFile &&
              (projectFileNames ? projectFileNames.has(baseName) : true);
            const handleOpen = openable
              ? () => onRequestOpenFile?.(baseName)
              : undefined;
            return (
              <button
                type="button"
                key={a.path}
                className={`user-attachment staged-${a.kind}${openable ? ' openable' : ''}`}
                onClick={handleOpen}
                disabled={!openable}
                title={openable ? t('chat.openFile', { name: baseName }) : a.path}
              >
                <span className="staged-order" aria-label={`Attachment ${index + 1}`}>
                  {index + 1}
                </span>
                {a.kind === 'image' && projectId ? (
                  <img src={projectRawUrl(projectId, a.path)} alt={a.name} />
                ) : (
                  <Icon name="file" size={14} />
                )}
                <span className="staged-name">{a.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {commentAttachments.some((attachment) => attachment.selectionKind !== 'visual') ? (
        <div className="user-attachments comment-history-attachments">
          {commentAttachments.filter((attachment) => attachment.selectionKind !== 'visual').map((a) => (
            <span key={a.id} className="user-attachment staged-comment">
              <span className="staged-name" title={a.comment ? `${commentTargetDisplayName(a)}: ${a.comment}` : commentTargetDisplayName(a)}>
                <strong>{commentTargetDisplayName(a)}</strong>
                {a.comment ? <span>{a.comment}</span> : null}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {message.content ? (
        <div className="user-text-wrap">
          <div className="user-text user-bubble">{message.content}</div>
          <div className="user-actions">
            <button
              type="button"
              className="ghost user-copy-btn"
              onClick={handleCopy}
              aria-label={copied ? t('chat.copyDone') : t('chat.copyPrompt')}
              title={copied ? t('chat.copyDone') : t('chat.copyPrompt')}
            >
              <Icon name={copied ? 'check' : 'copy'} size={13} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MessageSessionModeChip({
  mode,
  t,
}: {
  mode: ChatSessionMode;
  t: TranslateFn;
}) {
  const label = mode === 'chat'
    ? t('chat.mode.chat.label')
    : mode === 'plan'
      ? t('chat.mode.plan.label')
      : t('chat.mode.design.label');
  const icon = mode === 'chat' ? 'comment' : mode === 'plan' ? 'file' : 'sparkles';
  return (
    <div
      className={`msg-mode-chip msg-mode-chip--${mode}`}
      data-testid="msg-session-mode-chip"
      title={label}
    >
      <Icon name={icon} size={12} />
      <span>{label}</span>
    </div>
  );
}

const WORKSPACE_DESIGN_FILES_TAB = '__design_files__';

function ActiveWorkspaceContextChip({
  item,
  onOpen,
}: {
  item: WorkspaceContextItem;
  onOpen?: (name: string) => void;
}) {
  const target = workspaceContextOpenTarget(item);
  const content = (
    <>
      <span className="msg-context-chip__icon" aria-hidden>
        <Icon name={workspaceContextIcon(item)} size={12} />
      </span>
      <span className="msg-context-chip__label">
        <span className="msg-context-chip__kind">Current</span>
        <span className="msg-context-chip__title">{item.label}</span>
      </span>
    </>
  );
  if (!target || !onOpen) {
    return (
      <div
        className={`msg-context-chip msg-context-chip--workspace msg-context-chip--workspace-${item.kind}`}
        data-testid="msg-workspace-context-chip"
        title={workspaceContextTitle(item)}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`msg-context-chip msg-context-chip--workspace msg-context-chip--workspace-${item.kind} msg-context-chip--action`}
      data-testid="msg-workspace-context-chip"
      title={workspaceContextTitle(item)}
      onClick={() => onOpen(target)}
    >
      {content}
    </button>
  );
}

function workspaceContextOpenTarget(item: WorkspaceContextItem): string | null {
  if (item.tabId) return item.tabId;
  if (item.kind === 'design-files') return WORKSPACE_DESIGN_FILES_TAB;
  if (item.kind === 'file') {
    return item.path ?? item.label;
  }
  return null;
}

function workspaceContextIcon(item: WorkspaceContextItem): IconName {
  if (item.kind === 'browser') return 'globe';
  if (item.kind === 'folder' || item.kind === 'design-files') return 'folder';
  if (item.kind === 'project') return 'folder';
  if (item.kind === 'local-code') return 'terminal';
  if (item.kind === 'terminal') return 'terminal';
  if (item.kind === 'side-chat') return 'comment';
  return 'file';
}

function workspaceContextTitle(item: WorkspaceContextItem): string {
  return [
    workspaceContextKindLabel(item.kind),
    item.path ? `path: ${item.path}` : null,
    item.absolutePath ? `absolute: ${item.absolutePath}` : null,
    item.url ? `url: ${item.url}` : null,
    item.title ? `title: ${item.title}` : null,
  ].filter(Boolean).join(' | ');
}

function workspaceContextKindLabel(kind: WorkspaceContextItem['kind']): string {
  switch (kind) {
    case 'browser':
      return 'Browser';
    case 'design-files':
      return 'Design files';
    case 'folder':
      return 'Folder';
    case 'project':
      return 'Project';
    case 'local-code':
      return 'Local code';
    case 'terminal':
      return 'Terminal';
    case 'side-chat':
      return 'Side chat';
    case 'file':
    default:
      return 'File';
  }
}

function sortChatAttachmentsForDisplay(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments
    .map((attachment, index) => ({ attachment, index }))
    .sort((a, b) => {
      const aOrder = typeof a.attachment.order === 'number' && Number.isFinite(a.attachment.order)
        ? a.attachment.order
        : a.index;
      const bOrder = typeof b.attachment.order === 'number' && Number.isFinite(b.attachment.order)
        ? b.attachment.order
        : b.index;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.index - b.index;
    })
    .map((entry) => entry.attachment);
}

function relTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.now');
  if (diff < hr) return t('common.minutesShort', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursShort', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysShort', { n: Math.floor(diff / day) });
  return new Date(ts).toLocaleDateString();
}

export function conversationMetaLabel(
  conversation: Conversation,
  t: TranslateFn,
): string {
  const latestRun = conversation.latestRun;
  if (
    latestRun &&
    (latestRun.status === 'succeeded' ||
      latestRun.status === 'failed' ||
      latestRun.status === 'canceled') &&
    typeof conversation.totalDurationMs === 'number' &&
    Number.isFinite(conversation.totalDurationMs)
  ) {
    return formatDurationShort(conversation.totalDurationMs);
  }
  if (
    latestRun &&
    (latestRun.status === 'succeeded' ||
      latestRun.status === 'failed' ||
      latestRun.status === 'canceled') &&
    typeof latestRun.durationMs === 'number' &&
    Number.isFinite(latestRun.durationMs)
  ) {
    return formatDurationShort(latestRun.durationMs);
  }
  return relTime(conversation.updatedAt, t);
}

function formatDurationShort(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}
