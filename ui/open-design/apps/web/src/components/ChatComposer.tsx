'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import type { Dict, Locale } from '../i18n/types';
import {
  localizeSkillDescription,
  localizeSkillName,
} from '../i18n/content';
import { projectRawUrl, uploadProjectFiles, openFolderDialog, fetchRecentLinkedDirs, pushRecentLinkedDir, dirExists } from "../providers/registry";
import { WorkingDirPicker } from './WorkingDirPicker';
import { patchProject } from "../state/projects";
import { fetchMcpServers } from "../state/mcp";
import type { McpServerConfig, McpTemplate } from "../state/mcp";
import type { ChatAttachment, ChatCommentAttachment, Project, ProjectFile, ProjectMetadata, SkillSummary } from "../types";
import type {
  ChatMessageReplyRef,
  ChatSessionMode,
  ResearchOptions,
  RunContextSelection,
  WorkspaceContextItem,
} from '@open-design/contracts';
import { buildVisualAnnotationAttachment, commentTargetDisplayName } from '../comments';
import { Icon, type IconName } from "./Icon";
import { ComposerPlusMenu } from './ComposerPlusMenu';
import {
  ProjectReferenceModal,
  type ProjectReferenceSelection,
} from './ProjectReferenceModal';
import { SessionModeToggle } from './SessionModeToggle';
import {
  DESIGN_TOOLBOX_ACTIONS,
  designToolboxActionBadge,
  designToolboxActionDescription,
  designToolboxActionMatchesQuery,
  designToolboxActionTitle,
  findDesignToolboxSkill,
  getDesignToolboxAction,
  skillMatchesQuery,
  type DesignToolboxAction,
  type DesignToolboxActionId,
} from '../runtime/design-toolbox';
import { computeToolboxDetailPosition } from './composer-detail-position';
import { SkillDetailsModal } from './SkillDetailsModal';
import {
  inlineMentionToken,
  type InlineMentionEntity,
} from '../utils/inlineMentions';
import { workspaceContextLinkedDir, workspaceContextLinkedDirs } from './workspace-context';
import {
  LexicalComposerInput,
  type LexicalComposerInputHandle,
  type CaretRect,
} from './composer/LexicalComposerInput';
import { CaretFloatingLayer } from './composer/CaretFloatingLayer';
import { ANNOTATION_EVENT, type AnnotationEventDetail } from "./PreviewDrawOverlay";
import { PlaceholderCarousel } from './home-hero/PlaceholderCarousel';
import type { PlaceholderScenario } from './home-hero/placeholderScenarios';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

interface TrackedWorkspaceLinkedDir {
  dir: string;
  previousLinkedDirs: string[];
}

function dedupeWorkspaceContextItems(items: WorkspaceContextItem[]): WorkspaceContextItem[] {
  const out: WorkspaceContextItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function trackedWorkspaceLinkedDirsForContexts(
  items: WorkspaceContextItem[],
  linkedDirs: string[],
): Record<string, TrackedWorkspaceLinkedDir> {
  const out: Record<string, TrackedWorkspaceLinkedDir> = {};
  for (const item of items) {
    const dir = workspaceContextLinkedDir(item) ?? '';
    if (!dir || !linkedDirs.includes(dir)) continue;
    out[item.id] = {
      dir,
      previousLinkedDirs: linkedDirs.filter((linkedDir) => linkedDir !== dir),
    };
  }
  return out;
}


type MentionTab = 'all' | 'members' | 'tabs' | 'files' | 'skills' | 'mcp';

interface SlashCommand {
  id: string;
  // Visible label, e.g. `/mcp`. Shown in the popover row.
  label: string;
  // Text inserted into the draft when the user picks the entry. The
  // cursor is positioned at the end of `insert`, so a trailing space
  // is the difference between a "ready for argument" command and a
  // "submit immediately" one.
  insert: string;
  // i18n key of the short description shown next to the label.
  descKey?: keyof Dict;
  // Optional argument hint shown after the description.
  argHint?: string;
  // Icon glyph from the project Icon set.
  icon: 'sparkles' | 'eye' | 'sliders' | 'terminal';
}

type DesignToolboxResourceKind =
  | 'skill'
  | 'mcp'
  | 'mcp-template'
  | 'file';

interface DesignToolboxResourceIndex {
  skills: SkillSummary[];
  mcpServers: McpServerConfig[];
  mcpTemplates: McpTemplate[];
  projectFiles: ProjectFile[];
}

type DesignToolboxResourceBase = {
  key: string;
  kind: DesignToolboxResourceKind;
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  icon: IconName;
  searchText: string;
};

type DesignToolboxResource =
  | (DesignToolboxResourceBase & { kind: 'skill'; skill: SkillSummary })
  | (DesignToolboxResourceBase & { kind: 'mcp'; server: McpServerConfig })
  | (DesignToolboxResourceBase & { kind: 'mcp-template'; template: McpTemplate })
  | (DesignToolboxResourceBase & { kind: 'file'; file: ProjectFile });

interface Props {
  projectId: string | null;
  projectFiles: ProjectFile[];
  activeProjectFileName?: string | null;
  streaming: boolean;
  sessionMode?: ChatSessionMode;
  onSessionModeChange?: (mode: ChatSessionMode) => void;
  sendDisabled?: boolean;
  initialDraft?: string;
  composerPlaceholder?: string;
  placeholderScenarios?: ReadonlyArray<PlaceholderScenario>;
  draftStorageKey?: string;
  // Lazy ensure — the composer calls this before its first upload, so the
  // project folder exists on disk before files land in it. Returns the
  // project id when ready.
  onEnsureProject: () => Promise<string | null>;
  commentAttachments?: ChatCommentAttachment[];
  onRemoveCommentAttachment?: (id: string) => void;
  // Available skills the user can compose into a turn via @<skill>. The
  // chat layer already filters out disabled skills before passing them in
  // here, so the picker can render the list as-is. Keep this optional so
  // the composer still works on surfaces that don't show a skills picker
  // (e.g. tests, screenshot harnesses).
  skills?: SkillSummary[];
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    meta?: ChatSendMeta,
  ) => void;
  onStop: () => void;
  // Opens the global settings dialog (CLI / model / agent picker). The
  // composer's leading gear icon routes here so users can switch models
  // without leaving the chat.
  onOpenSettings?: () => void;
  // Opens settings on the External MCP tab. Wired from ChatPane → App.
  // The composer's `/mcp` slash command and the MCP picker button route here.
  onOpenMcpSettings?: () => void;
  // Web-local equivalents of interactive CLI commands. Each is optional: a
  // wired handler both lists the slash in the palette and intercepts it on
  // submit; an omitted handler leaves the slash out entirely so the palette
  // never advertises a command this surface cannot run.
  // `/clear` — the CLI clears context and starts over; the web equivalent is
  // starting a fresh conversation.
  onClearConversation?: () => void;
  // `/rename <title>` — renames the active conversation in place.
  onRenameActiveConversation?: (title: string) => void;
  // `/export` — exports the active conversation (the pane owns the format).
  onExportConversation?: () => void;
  // `/copy` — copies the last assistant reply to the clipboard.
  onCopyLastResponse?: () => void;
  // `/model <id>` — sets the conversation's provider-LLM override (the same
  // persistence the model pill drives); `/model default` clears it. Wired
  // only for MatOS-backed conversations.
  onSetProviderModel?: (id: string | null) => void;
  researchAvailable?: boolean;
  projectMetadata?: ProjectMetadata;
  onProjectMetadataChange?: (metadata: ProjectMetadata) => void;
  activeWorkspaceContext?: WorkspaceContextItem | null;
  initialWorkspaceContexts?: WorkspaceContextItem[];
  workspaceContexts?: WorkspaceContextItem[];
  currentSkillId?: string | null;
  onProjectSkillChange?: (skillId: string | null) => void;
  footerAccessory?: ReactNode;
  // Slot rendered in the composer's bottom toolbar, immediately right of the
  // "+" menu. Hosts the working-directory pill so the folder selector sits by
  // the composer (mirroring the home input) instead of the file-panel header.
  leadingAccessory?: ReactNode;
  // MatOS role picker slot rendered in the same staged-contexts position.
  // The conversations composer mirrors the Home composer: the picked role
  // drives which MatOS role (`matos --role <ref>`) executes the next run,
  // so ProjectView passes this instead of the upstream picker.
  matosRolePicker?: ReactNode;
  // MatOS provider-model picker pill (web `/model`), rendered next to the
  // role pill. A role decides prompts/tools composition; this decides the
  // underlying provider LLM (`matos --model <id>`).
  matosModelPicker?: ReactNode;
  // MatOS group chat roster for the active conversation. When present the @
  // mention popover surfaces a "members" section FIRST so a user can @-address
  // a teammate agent to do work (dispatch is parsed from the raw prompt in
  // ProjectView). Empty/omitted outside group chats. `{ref,id,name}` per member.
  groupMembers?: ReadonlyArray<{ ref: string; id: string; name: string; description?: string | null }>;
  // Optional transient banner sink. The composer emits one short message
  // here so the user
  // has explicit confirmation without re-opening the picker.
  onShowToast?: (message: string) => void;
}

// Imperative handle so ancestors (e.g. example chips in ChatPane) can
// push text into the composer without owning its draft state.
export interface ChatComposerDraftOptions {
  sessionMode?: ChatSessionMode;
}

export interface ChatComposerHandle {
  setDraft: (text: string, options?: ChatComposerDraftOptions) => void;
  restoreDraft: (draft: {
    text: string;
    attachments?: ChatAttachment[];
    commentAttachments?: ChatCommentAttachment[];
    /**
     * The queued turn's meta. When present, restoreDraft rebuilds the staged
     * skill / MCP context (and re-shows their chips) so editing a queued item
     * keeps its bindings instead of silently dropping them.
     */
    meta?: ChatSendMeta;
  }) => void;
  focus: () => void;
  /**
   * Run a design-toolbox action by id from outside the composer (e.g. the
   * assistant "next step" card). Resolves the action, matches its preferred
   * skill, and seeds the composer draft with the action prompt + `@skill`
   * mention — identical to picking the action inside the toolbox panel, so the
   * draft still waits for the user to send. No-op for an unknown id.
   */
  applyDesignToolboxAction: (id: DesignToolboxActionId) => void;
  /**
   * Seed the composer with a specific skill by id (same path as picking it in
   * the toolbox panel). Used by the next-step card's full skill list. No-op for
   * an unknown id.
   */
  applyDesignToolboxSkill: (skillId: string) => void;
  /** Legacy: open the standalone toolbox popover. Currently unused by callers. */
  openDesignToolbox: () => void;
}

export interface ChatSendMeta {
  queueOnly?: boolean;
  research?: ResearchOptions;
  context?: RunContextSelection;
  // Per-turn skill ids picked via the @-mention popover. The chat layer
  // forwards these to the daemon's `skillIds` field so the system prompt
  // for this run only is composed with the extra skill bodies, without
  // touching the project's persistent `skillId`.
  skillIds?: string[];
  /** One-shot run mode override for seeded follow-ups before parent state catches up. */
  sessionMode?: ChatSessionMode;
  /**
   * MatOS group chat: the @-addressed member (`role:<id>`) whose role should
   * run this turn. Set by ChatPane's group member bar; ProjectView validates
   * it against the conversation's roster before pinning the run to it.
   */
  memberRoleRef?: string;
  /**
   * Feishu-style quote-reply: the earlier message this send replies to.
   * Set by ChatPane's quote action; ProjectView persists it on the user
   * message so transcripts and the group log render the quote anchor.
   */
  replyTo?: ChatMessageReplyRef;
}

/**
 * The chat composer: textarea + paste/drop/attach buttons + @-mention
 * picker. Attachments are uploaded into the active project's folder so
 * the agent can reference them by relative path on its next turn.
 *
 * `@` typed at a word boundary opens a popover listing project files.
 * Selecting one inserts `@<path>` into the prompt and stages it as an
 * attachment so the daemon also includes it explicitly.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, Props>(
  function ChatComposer(
    {
      projectId,
      projectFiles,
      activeProjectFileName = null,
      streaming,
      sessionMode = 'design',
      onSessionModeChange,
      sendDisabled = false,
      initialDraft,
      composerPlaceholder,
      placeholderScenarios = [],
      draftStorageKey,
      onEnsureProject,
      commentAttachments = [],
      onRemoveCommentAttachment,
      skills = [],
      onSend,
      onStop,
      onOpenMcpSettings,
      onClearConversation,
      onRenameActiveConversation,
      onExportConversation,
      onCopyLastResponse,
      onSetProviderModel,
      researchAvailable = false,
      projectMetadata,
      onProjectMetadataChange,
      activeWorkspaceContext = null,
      initialWorkspaceContexts = [],
      workspaceContexts = [],
      currentSkillId = null,
      onProjectSkillChange,
      footerAccessory,
      leadingAccessory,
      matosRolePicker,
      matosModelPicker,
      groupMembers,
      onShowToast,
    },
    ref
  ) {
    const { locale, t } = useI18n();
    const activeFileContext =
      projectMetadata?.importedFrom === 'folder' && activeProjectFileName
        ? activeProjectFileName
        : null;
    const activeFileDisplayName = activeFileContext ? lastPathSegment(activeFileContext) : null;
    const [draft, setDraft] = useState(() => initialDraft ?? loadComposerDraft(draftStorageKey) ?? "");
    const [placeholderScenario, setPlaceholderScenario] = useState<PlaceholderScenario | null>(null);
    const composerRootRef = useRef<HTMLDivElement | null>(null);
    const pendingSessionModeRef = useRef<ChatSessionMode | null>(null);
    // Synchronous mirror of `draft`. Event handlers that mutate the draft off
    // a captured render closure (notably the annotation listener, where two
    // uploads can resolve concurrently) read/write this ref so their edits
    // compose instead of clobbering one another. Kept in lockstep with `draft`
    // by handleEditorChange (the editor is the single source for typing) and by
    // the programmatic-set paths below.
    const draftRef = useRef(draft);
    const previousSessionModeRef = useRef(sessionMode);

    useEffect(() => {
      if (previousSessionModeRef.current === sessionMode) return;
      if (pendingSessionModeRef.current && pendingSessionModeRef.current !== sessionMode) {
        pendingSessionModeRef.current = null;
      }
      previousSessionModeRef.current = sessionMode;
    }, [sessionMode]);

    // chat_panel page_view fires from ProjectView (which outlives
    // conversation switches) so the event measures real chat-panel
    // entries rather than ChatComposer remounts. See PR #2285 review
    // 2026-05-20 04:08 for the rationale.
    const [staged, setStaged] = useState<ChatAttachment[]>([]);
    const nextAttachmentOrderRef = useRef(0);
    const [projectReferenceOpen, setProjectReferenceOpen] = useState(false);
    const [stagedVisualComments, setStagedVisualComments] = useState<ChatCommentAttachment[]>([]);
    const streamingAnnotationSendPendingRef = useRef(false);
    const [streamingAnnotationSendPending, setStreamingAnnotationSendPendingState] = useState(false);
    // Skills the user has @-mentioned for this turn. We dedupe on id and
    // strip the chip when the user removes the corresponding `@<skill>`
    // token from the draft, keeping draft and chips in sync.
    const [stagedSkills, setStagedSkills] = useState<SkillSummary[]>([]);
    // Legacy standalone design-toolbox popover. The next-step card now renders
    // its own cascading skill menu, so nothing opens this anymore; kept compiling
    // behind `openDesignToolbox` until the panel subsystem is removed wholesale.
    const [designToolboxOpen, setDesignToolboxOpen] = useState(false);
    const [stagedMcpServers, setStagedMcpServers] = useState<McpServerConfig[]>([]);
    const linkedDirs = projectMetadata?.linkedDirs ?? [];
    const [stagedWorkspaceContexts, setStagedWorkspaceContexts] = useState<WorkspaceContextItem[]>(
      () => dedupeWorkspaceContextItems(initialWorkspaceContexts),
    );
    const [workspaceLinkedDirAdds, setWorkspaceLinkedDirAdds] = useState<Record<string, TrackedWorkspaceLinkedDir>>(
      () => trackedWorkspaceLinkedDirsForContexts(initialWorkspaceContexts, linkedDirs),
    );
    const [promotedWorkspaceContextDir, setPromotedWorkspaceContextDir] = useState<string | null>(null);
    const [dismissedWorkspaceContextId, setDismissedWorkspaceContextId] = useState<string | null>(null);
    const activeWorkspaceContextId = activeWorkspaceContext?.id ?? null;
    const previousWorkspaceContextIdRef = useRef<string | null>(activeWorkspaceContextId);
    const [dragActive, setDragActive] = useState(false);
    // Lexical owns the caret, so the mention/slash trigger state only carries
    // the typed query — no cursor offset.
    const [mention, setMention] = useState<{ q: string } | null>(null);
    // Active-row index for the @-popover's visible union (files → tabs →
    // skills → mcp). Resets to 0 whenever the query identity or tab changes;
    // drives the visual highlight + Enter/Tab target.
    const [mentionIndex, setMentionIndex] = useState(0);
    const [mentionTab, setMentionTab] = useState<MentionTab>('all');
    // Viewport caret box the floating popover anchors against. Sampled by the
    // editor at trigger-detection time; null when no trigger is live.
    const [caretRect, setCaretRect] = useState<CaretRect | null>(null);
    // Slash-command popover state — when the draft starts with `/` and the
    // cursor is still inside that token (no space committed yet), we show a
    // small palette of supported commands. The query is the text after `/`
    // so the user can type-to-filter.
    const [slash, setSlash] = useState<{ q: string } | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);
    // Native MatOS slash-command vocabulary (headless/chat-safe commands from
    // `matos workbench commands list --mode web`). Lazily fetched the first
    // time the user opens the `/` palette so a fresh chat never pays for the
    // registry walk up front; the client caches across composer mounts and
    // degrades to `[]` when the bridge is unavailable.
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    // External MCP servers configured by the user. Fetched lazily on mount;
    // shown in the slash-command palette so `/mcp <id>` inserts a hint into
    // the prompt that nudges the model to use that server's tools.
    const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
    const [mcpTemplates, setMcpTemplates] = useState<McpTemplate[]>([]);
    const [detailsSkill, setDetailsSkill] = useState<{
      id: string;
      summary?: SkillSummary | null;
    } | null>(null);
    // Consolidated "tools" popover — a single dropdown anchored to the
    // leading sliders icon that hosts project context, MCP, Import actions,
    // and a shortcut to open the full Settings dialog. Replaces the previous
    // row of three standalone buttons (which overflowed in narrow chats).
    // The "+" menu (ComposerPlusMenu) owns its own open / submenu state.
    // Defer the MCP fetches until the composer is actually used — first focus,
    // the tools popover opening, an @/slash trigger, or a pre-seeded draft. An
    // untouched empty composer (e.g. a home surface the user bounces off, or a
    // background chat) never pays for the MCP server list. Latches once true
    // and never resets.
    const [composerEngaged, setComposerEngaged] = useState(
      () => (draft ?? '').trim().length > 0,
    );
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    // The Lexical editor handle — drives text/mention/clear/focus from the
    // host. Replaces the old textareaRef + manual selection plumbing. IME
    // composition guarding now lives inside the editor's command handlers.
    const editorRef = useRef<LexicalComposerInputHandle | null>(null);
    // Always points at the latest `applyDesignToolboxAction` closure so the
    // imperative handle (whose deps array doesn't track `draft`/`t`) never seeds
    // the composer from a stale draft when the next-step card fires an action.
    const applyDesignToolboxActionRef = useRef<(action: DesignToolboxAction) => void>(() => {});
    // Same latest-closure trick for picking a skill by id from the next-step card.
    const applyDesignToolboxSkillByIdRef = useRef<(skillId: string) => void>(() => {});
    const [recentDirs, setRecentDirs] = useState<string[]>([]);
    useEffect(() => {
      let cancelled = false;
      void fetchRecentLinkedDirs().then((dirs) => {
        if (!cancelled) setRecentDirs(dirs);
      });
      return () => {
        cancelled = true;
      };
    }, []);
    const rememberRecentDir = useCallback(async (dir: string) => {
      setRecentDirs((prev) => [dir, ...prev.filter((d) => d !== dir)].slice(0, 5));
      const persisted = await pushRecentLinkedDir(dir);
      setRecentDirs(persisted);
    }, []);
    const visibleWorkspaceContext =
      activeWorkspaceContext && activeWorkspaceContext.id !== dismissedWorkspaceContextId
        ? activeWorkspaceContext
        : null;
    const selectedWorkspaceContexts = useMemo(() => {
      const out: WorkspaceContextItem[] = [];
      const seen = new Set<string>();
      const push = (item: WorkspaceContextItem | null | undefined) => {
        if (!item) return;
        const key = `${item.kind}:${item.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(item);
      };
      push(visibleWorkspaceContext);
      for (const item of stagedWorkspaceContexts) push(item);
      return out;
    }, [stagedWorkspaceContexts, visibleWorkspaceContext]);
    const selectedWorkspaceContextDirs = useMemo<string[]>(
      () => workspaceContextLinkedDirs(selectedWorkspaceContexts),
      [selectedWorkspaceContexts],
    );
    const workspaceContextMetadataLinkedDirList = useMemo<string[]>(
      () =>
        Array.from(new Set([
          ...Object.values(workspaceLinkedDirAdds).map((tracked) => tracked.dir),
          ...selectedWorkspaceContextDirs,
        ])),
      [selectedWorkspaceContextDirs, workspaceLinkedDirAdds],
    );
    const workspaceContextLinkedDirList = useMemo<string[]>(
      () =>
        workspaceContextMetadataLinkedDirList.filter((dir) => dir !== promotedWorkspaceContextDir),
      [promotedWorkspaceContextDir, workspaceContextMetadataLinkedDirList],
    );
    const workspaceContextLinkedDirSet = useMemo<Set<string>>(
      () => new Set(workspaceContextLinkedDirList),
      [workspaceContextLinkedDirList],
    );
    // The project's working directory: the local folder the agent can read
    // (via `linkedDirs` → `--add-dir`). Shown in the WorkingDirPicker below
    // the input, mirroring Home. Context-only folders are still linked for
    // agent read access, but they should not become the displayed primary dir.
    const workingDir = linkedDirs.find((dir) => !workspaceContextLinkedDirSet.has(dir)) ?? null;
    // Live-check whether the selected working directory still exists, so a
    // folder deleted from disk turns the picker red without a page reload.
    // Re-checked when the dir changes, when the window/tab regains focus
    // (e.g. after deleting it in Finder), and when the picker is opened.
    const [workingDirMissing, setWorkingDirMissing] = useState(false);
    const checkWorkingDir = useCallback(async () => {
      if (!workingDir) {
        setWorkingDirMissing(false);
        return;
      }
      const ok = await dirExists(workingDir);
      setWorkingDirMissing(!ok);
    }, [workingDir]);
    useEffect(() => {
      void checkWorkingDir();
      const onFocus = () => void checkWorkingDir();
      const onVisible = () => {
        if (document.visibilityState === 'visible') void checkWorkingDir();
      };
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }, [checkWorkingDir]);
    // initialDraft is only honored on the first non-empty value the parent
    // hands us. After we seed once, the composer is fully under user control
    // — re-renders that pass the same prompt back must not reseed. If the
    // initial useState above already consumed a non-empty initialDraft we
    // mark it seeded immediately, so an early clear by the user (typing or
    // backspace before the parent stops passing initialDraft) does not get
    // overwritten by the effect.
    const seededRef = useRef(Boolean(initialDraft));

    useEffect(() => {
      if (seededRef.current) return;
      if (initialDraft && initialDraft !== draft) {
        setDraft(initialDraft);
        seededRef.current = true;
      } else if (initialDraft === undefined) {
        seededRef.current = true;
      }
    }, [initialDraft, draft]);

    useEffect(() => {
      saveComposerDraft(draftStorageKey, draft);
    }, [draftStorageKey, draft]);

    useEffect(() => {
      if (previousWorkspaceContextIdRef.current === activeWorkspaceContextId) return;
      previousWorkspaceContextIdRef.current = activeWorkspaceContextId;
      setDismissedWorkspaceContextId(null);
      setPromotedWorkspaceContextDir(null);
    }, [activeWorkspaceContextId]);

    // Latch `composerEngaged` true on the first real interaction so the
    // deferred fetches below run exactly once, when they are actually needed.
    useEffect(() => {
      if (composerEngaged) return;
      if (draft.trim().length > 0 || mention || slash) {
        setComposerEngaged(true);
      }
    }, [composerEngaged, draft, mention, slash]);

    // Lazy-fetch the user's external MCP servers list (once engaged) so the
    // `/mcp …` slash palette and the composer's MCP button popover have
    // something to render. We deliberately do not reactively re-fetch when
    // the user toggles servers from Settings — the dialog refreshes itself,
    // and the chat composer rehydrates next time the user re-opens it. A
    // background poll would be cheap but unnecessary for the typical
    // edit-once-then-chat workflow.
    useEffect(() => {
      if (!composerEngaged) return;
      let cancelled = false;
      void (async () => {
        const data = await fetchMcpServers();
        if (cancelled || !data) return;
        setMcpServers(data.servers);
        setMcpTemplates(data.templates);
      })();
      return () => {
        cancelled = true;
      };
    }, [composerEngaged]);

    // Skills now come from the parent (App.tsx → ProjectView → ChatPane → ChatComposer)
    // pre-filtered by enabled/disabled state. We no longer fetch a fresh list
    // here to avoid showing skills the user has disabled via Settings.

    const enabledMcpServers = useMemo(
      () => mcpServers.filter((s) => s.enabled),
      [mcpServers],
    );

    const designToolboxResourceIndex = useMemo<DesignToolboxResourceIndex>(
      () => ({
        skills,
        mcpServers: enabledMcpServers,
        mcpTemplates,
        projectFiles,
      }),
      [enabledMcpServers, mcpTemplates, projectFiles, skills],
    );
    const groupMemberList = useMemo(
      () => (Array.isArray(groupMembers) ? groupMembers : []),
      [groupMembers],
    );
    const composerMentionEntities = useMemo(
      () => {
        const base = buildComposerMentionEntities({
          files: projectFiles,
          mcpServers: enabledMcpServers,
          skills,
          staged,
          workspaceContexts: selectedWorkspaceContexts,
        });
        // Group members go FIRST so a `@MemberName` pill wins over a same-named
        // file/skill token when the conversation is a department group chat.
        const memberEntities: InlineMentionEntity[] = groupMemberList.map((member) => ({
          id: member.ref,
          kind: 'member',
          label: member.name,
          token: inlineMentionToken(member.name),
          title: `Member: ${member.name}`,
        }));
        return memberEntities.length > 0 ? [...memberEntities, ...base] : base;
      },
      [enabledMcpServers, groupMemberList, projectFiles, selectedWorkspaceContexts, skills, staged],
    );
    // Catalog of supported slash commands. Each entry shows up in the
    // popover when the user types `/` in the composer. The `insert`
    // value is what we drop into the draft when the user picks the
    // entry — usually the canonical command form with a trailing space
    // ready for an argument.
    const slashCommands = useMemo<SlashCommand[]>(() => {
      const list: SlashCommand[] = [];
      // External MCP servers — `/mcp` opens settings, `/mcp <id>` inserts a
      // prompt-side hint nudging the model to use that server's tools. The
      // hint flows through to the agent verbatim; the daemon already wired
      // the MCP config into the agent's launch so the tools are callable.
      if (onOpenMcpSettings) {
        list.push({
          id: 'mcp',
          label: '/mcp',
          insert: '/mcp ',
          descKey: 'pet.slashPet',
          icon: 'sliders',
          argHint: 'open settings · <server-id> to insert hint',
        });
      }
      for (const s of enabledMcpServers) {
        list.push({
          id: `mcp-${s.id}`,
          label: `/mcp ${s.id}`,
          insert: `Use the \`${s.id}\` MCP server tools. `,
          descKey: 'pet.slashPet',
          icon: 'sparkles',
          argHint: s.label || s.transport,
        });
      }
      if (researchAvailable) {
        list.push({
          id: 'search',
          label: '/search',
          insert: '/search ',
          descKey: 'pet.slashSearch',
          icon: 'sparkles',
          argHint: t('pet.slashSearchArg'),
        });
      }
      // Web-local equivalents of interactive CLI commands (/clear, /rename,
      // /export, /copy). Each entry is listed only when its handler is wired,
      // and wins the slash-collision dedup below so the web behavior stays
      // authoritative over the CLI launcher projection of the same name.
      if (onClearConversation) {
        list.push({
          id: 'clear',
          label: '/clear',
          insert: '/clear',
          descKey: 'chat.slashClear',
          icon: 'sliders',
        });
      }
      if (onRenameActiveConversation) {
        list.push({
          id: 'rename',
          label: '/rename',
          insert: '/rename ',
          descKey: 'chat.slashRename',
          icon: 'sliders',
          argHint: t('chat.slashRenameArg'),
        });
      }
      if (onExportConversation) {
        list.push({
          id: 'export',
          label: '/export',
          insert: '/export',
          descKey: 'chat.slashExport',
          icon: 'sliders',
        });
      }
      if (onCopyLastResponse) {
        list.push({
          id: 'copy',
          label: '/copy',
          insert: '/copy',
          descKey: 'chat.slashCopy',
          icon: 'sliders',
        });
      }
      if (onSessionModeChange) {
        list.push({
          id: 'plan',
          label: '/plan',
          insert: '/plan ',
          descKey: 'chat.slashPlan',
          icon: 'eye',
          argHint: t('chat.slashPlanArg'),
        });
      }
      if (onSetProviderModel) {
        list.push({
          id: 'model',
          label: '/model',
          insert: '/model ',
          descKey: 'chat.slashModel',
          icon: 'sliders',
          argHint: t('chat.slashModelArg'),
        });
      }
      return list;
    }, [
      researchAvailable,
      t,
      enabledMcpServers,
      onOpenMcpSettings,
      onClearConversation,
      onRenameActiveConversation,
      onExportConversation,
      onCopyLastResponse,
      onSessionModeChange,
      onSetProviderModel,
    ]);

    const filteredSlash = useMemo(() => {
      if (!slash) return [] as SlashCommand[];
      const q = slash.q.toLowerCase();
      if (!q) return slashCommands;
      return slashCommands.filter((c) => c.label.toLowerCase().includes(q));
    }, [slash, slashCommands]);

    function pickSlash(cmd: SlashCommand) {
      if (!slash) return;
      // Replace the in-flight `/<query>` trigger with the picked command's
      // canonical insertion text. Lexical owns the caret afterwards.
      editorRef.current?.replaceActiveTrigger(cmd.insert);
      editorRef.current?.focus();
      setSlash(null);
    }

    // `/mcp` (no arg) opens settings on the External MCP tab — pure UX hook,
    // never sent to the agent. `/mcp <id>` is intentionally NOT intercepted
    // here: the slash palette already replaces it with a natural-language
    // hint sentence ("Use the `<id>` MCP server tools."), and the user is
    // expected to keep typing the rest of the prompt before sending.
    function tryHandleMcpSlash(): boolean {
      if (!onOpenMcpSettings) return false;
      const trimmed = draft.trim();
      if (!/^\/mcp\s*$/i.test(trimmed)) return false;
      onOpenMcpSettings();
      setDraft('');
      editorRef.current?.clear();
      return true;
    }

    // Web-local equivalents of interactive CLI commands. Each maps the CLI
    // command's intent onto the web's own affordance (`/clear` → fresh
    // conversation, `/rename` → retitle, `/export` → download, `/copy` →
    // clipboard) instead of sending the slash to the agent. Unwired handlers
    // fall through so the draft is sent as a plain message — matching the
    // palette, which only lists wired commands.
    function tryHandleWebUxSlash(): boolean {
      const trimmed = draft.trim();
      const clearEditor = () => {
        setDraft('');
        editorRef.current?.clear();
      };
      if (onClearConversation && /^\/clear$/i.test(trimmed)) {
        onClearConversation();
        clearEditor();
        return true;
      }
      if (onRenameActiveConversation) {
        const m = /^\/rename(?:\s+([\s\S]*))?$/i.exec(trimmed);
        if (m) {
          const title = (m[1] ?? '').trim();
          if (title) {
            onRenameActiveConversation(title);
          } else {
            onShowToast?.(t('chat.slashRenameUsage'));
          }
          clearEditor();
          return true;
        }
      }
      if (onExportConversation && /^\/export$/i.test(trimmed)) {
        onExportConversation();
        clearEditor();
        return true;
      }
      if (onCopyLastResponse && /^\/copy$/i.test(trimmed)) {
        onCopyLastResponse();
        clearEditor();
        return true;
      }
      // `/plan [task]` — switch this conversation into plan mode (read-only
      // planning tier). With a task, the task is sent immediately AS a plan
      // turn (meta.sessionMode pins the tier for this run even though the
      // persisted mode PATCH is still in flight).
      if (onSessionModeChange) {
        const planMatch = /^\/plan(?:\s+([\s\S]*))?$/i.exec(trimmed);
        if (planMatch) {
          const task = (planMatch[1] ?? '').trim();
          if (sessionMode !== 'plan') onSessionModeChange('plan');
          if (task) {
            if (streaming) return true;
            sendComposedTurn(task, staged, currentCommentAttachments(), {
              ...currentRunContextMeta(),
              sessionMode: 'plan',
            });
            return true;
          }
          clearEditor();
          return true;
        }
      }
      // `/model <id>` — provider-LLM override; `default` clears it. Bare
      // `/model` just nudges toward the pill (the picker lives right there).
      if (onSetProviderModel) {
        const modelMatch = /^\/model(?:\s+(\S+))?$/i.exec(trimmed);
        if (modelMatch) {
          const modelId = (modelMatch[1] ?? '').trim();
          if (!modelId) {
            onShowToast?.(t('chat.slashModelUsage'));
          } else if (/^default$/i.test(modelId)) {
            onSetProviderModel(null);
            onShowToast?.(t('chat.slashModelCleared'));
          } else {
            onSetProviderModel(modelId);
            onShowToast?.(t('chat.slashModelSet', { model: modelId }));
          }
          clearEditor();
          return true;
        }
      }
      return false;
    }

    function expandSearchCommand(input: string): { prompt: string; query: string } | null {
      const m = /^\/search(?:\s+([\s\S]*))?$/i.exec(input.trim());
      if (!m) return null;
      const query = m[1]?.trim() ?? '';
      if (!query) return null;
      return {
        query,
        prompt: [
          `Search for: ${query}`,
          '',
          'Before answering, your first tool action must be the OD research command for your shell.',
          'POSIX: "$OD_NODE_BIN" "$OD_BIN" research search --query "<search query>" --max-sources 5',
          'PowerShell: & $env:OD_NODE_BIN $env:OD_BIN research search --query "<search query>" --max-sources 5',
          'cmd.exe: "%OD_NODE_BIN%" "%OD_BIN%" research search --query "<search query>" --max-sources 5',
          'Use the canonical query below as the exact search query, with safe quoting for your shell.',
          '',
          'Canonical query:',
          '',
          '```text',
          query.replace(/```/g, '`\u200b`\u200b`'),
          '```',
          'If the OD command fails because Tavily is not configured or unavailable, report that error, then use your own search capability as fallback and label the fallback clearly.',
          'After the command returns JSON or fallback search results, write a reusable Markdown report into Design Files at `research/<safe-query-slug>.md` or another fresh project-relative path.',
          'The report must include the query, fetched time, short summary, key findings, source list with [1], [2] citations, and a note that source content is external untrusted evidence.',
          'Then summarize the findings with citations by source index and mention the Markdown report path.',
        ].join('\n'),
      };
    }

    useImperativeHandle(
      ref,
      () => ({
        setDraft: (text: string, options?: ChatComposerDraftOptions) => {
          pendingSessionModeRef.current = options?.sessionMode ?? null;
          setDraft(text);
          editorRef.current?.setText(text);
          editorRef.current?.focus();
          seededRef.current = true;
        },
        restoreDraft: ({ text, attachments = [], commentAttachments = [], meta }) => {
          setDraft(text);
          const orderedAttachments = normalizeChatAttachmentOrders(attachments);
          setStaged(orderedAttachments);
          nextAttachmentOrderRef.current = nextChatAttachmentOrder(orderedAttachments);
          setStagedVisualComments(commentAttachments);
          // Rebuild staged context from the queued turn's meta so the
          // skill / MCP / workspace-tab bindings (and their chips) come back
          // for editing instead of being dropped. Ids resolve against the
          // currently-loaded lists; ids that no longer resolve (uninstalled
          // since queueing) are skipped rather than crashing.
          const ctx = meta?.context;
          setStagedSkills(
            ctx?.skillIds
              ? ctx.skillIds
                  .map((id) => skills.find((s) => s.id === id))
                  .filter((s): s is SkillSummary => Boolean(s))
              : [],
          );
          setStagedMcpServers(
            ctx?.mcpServerIds
              ? ctx.mcpServerIds
                  .map((id) => mcpServers.find((s) => s.id === id))
                  .filter((s): s is McpServerConfig => Boolean(s))
              : [],
          );
          setStagedWorkspaceContexts(ctx?.workspaceItems ?? []);
          setUploadError(null);
          setMention(null);
          setSlash(null);
          editorRef.current?.setText(text);
          editorRef.current?.focus();
          seededRef.current = true;
        },
        focus: () => {
          editorRef.current?.focus();
        },
        applyDesignToolboxAction: (id: DesignToolboxActionId) => {
          const action = getDesignToolboxAction(id);
          if (!action) return;
          applyDesignToolboxActionRef.current(action);
        },
        applyDesignToolboxSkill: (skillId: string) => {
          applyDesignToolboxSkillByIdRef.current(skillId);
        },
        openDesignToolbox: () => {
          setComposerEngaged(true);
          setDesignToolboxOpen(true);
        },
      }),
      [mcpServers, skills]
    );

    function reset() {
      pendingSessionModeRef.current = null;
      const linkedWorkspaceContexts = stagedWorkspaceContexts.filter((item) => (
        Boolean(item.absolutePath?.trim()) && Boolean(workspaceLinkedDirAdds[item.id])
      ));
      const linkedWorkspaceContextIds = new Set(linkedWorkspaceContexts.map((item) => item.id));
      const nextWorkspaceLinkedDirAdds = Object.fromEntries(
        Object.entries(workspaceLinkedDirAdds).filter(([id]) => linkedWorkspaceContextIds.has(id)),
      );
      setDraft("");
      setStaged([]);
      nextAttachmentOrderRef.current = 0;
      setStagedVisualComments([]);
      setStagedSkills([]);
      setStagedMcpServers([]);
      setStagedWorkspaceContexts(linkedWorkspaceContexts);
      setWorkspaceLinkedDirAdds(nextWorkspaceLinkedDirAdds);
      if (
        promotedWorkspaceContextDir &&
        !linkedWorkspaceContexts.some((item) => item.absolutePath?.trim() === promotedWorkspaceContextDir)
      ) {
        setPromotedWorkspaceContextDir(null);
      }
      setUploadError(null);
      setMention(null);
      setMentionTab('all');
      setSlash(null);
      editorRef.current?.clear();
    }

    function currentCommentAttachments(extra: ChatCommentAttachment[] = []): ChatCommentAttachment[] {
      return sortChatCommentAttachmentsByOrder([...commentAttachments, ...stagedVisualComments, ...extra]);
    }

    function setStreamingAnnotationSendPending(value: boolean) {
      streamingAnnotationSendPendingRef.current = value;
      setStreamingAnnotationSendPendingState(value);
    }

    function currentRunContextMeta(): ChatSendMeta | undefined {
      const skillIds = stagedSkills.map((s) => s.id);
      const mcpServerIds = stagedMcpServers.map((s) => s.id);
      const workspaceItems = selectedWorkspaceContexts;
      const context: RunContextSelection = {
        ...(skillIds.length > 0 ? { skillIds } : {}),
        ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
        ...(workspaceItems.length > 0 ? { workspaceItems } : {}),
      };
      const meta: ChatSendMeta = {
        ...(skillIds.length > 0 ? { skillIds } : {}),
        ...(Object.keys(context).length > 0 ? { context } : {}),
      };
      return Object.keys(meta).length > 0 ? meta : undefined;
    }

    function sendComposedTurn(
      prompt: string,
      attachments: ChatAttachment[],
      nextCommentAttachments: ChatCommentAttachment[],
      meta?: ChatSendMeta,
    ): boolean {
      setStreamingAnnotationSendPending(false);
      if (!prompt && attachments.length === 0 && nextCommentAttachments.length === 0) return false;
      const nextAttachments =
        activeFileContext && !attachments.some((attachment) => attachment.path === activeFileContext)
          ? [
              {
                path: activeFileContext,
                name: activeFileDisplayName ?? activeFileContext,
                kind: 'file' as const,
              },
              ...attachments,
            ]
          : attachments;
      // Apply the pending run-mode override if the caller didn't set its own
      // field, then clear it so it only applies to the immediate next send.
      const pendingSessionMode = pendingSessionModeRef.current;
      pendingSessionModeRef.current = null;
      const effectiveMetaShape: ChatSendMeta = {
        ...(meta ?? {}),
        ...(pendingSessionMode && !meta?.sessionMode ? { sessionMode: pendingSessionMode } : {}),
      };
      const effectiveMeta =
        Object.keys(effectiveMetaShape).length > 0 ? effectiveMetaShape : undefined;
      onSend(prompt, nextAttachments, nextCommentAttachments, effectiveMeta);
      reset();
      return true;
    }

    function queueMeta(meta?: ChatSendMeta): ChatSendMeta {
      return { ...(meta ?? {}), queueOnly: true };
    }

    function reserveAttachmentOrders(count: number): number {
      const orderStart = Math.max(nextAttachmentOrderRef.current, nextChatAttachmentOrder(staged));
      nextAttachmentOrderRef.current = orderStart + count;
      return orderStart;
    }

    function appendOrderedStagedAttachments(attachments: ChatAttachment[]) {
      if (attachments.length === 0) return;
      setStaged((current) => {
        const knownPaths = new Set(current.map((attachment) => attachment.path));
        const nextAttachments = attachments.filter((attachment) => !knownPaths.has(attachment.path));
        if (nextAttachments.length === 0) return current;
        const next = sortChatAttachmentsByOrder([...current, ...nextAttachments]);
        nextAttachmentOrderRef.current = Math.max(
          nextAttachmentOrderRef.current,
          nextChatAttachmentOrder(next),
        );
        return next;
      });
    }

    function appendContextAttachment(filePath: string) {
      setStaged((current) => {
        if (current.some((item) => item.path === filePath)) return current;
        const order = Math.max(nextAttachmentOrderRef.current, nextChatAttachmentOrder(current));
        nextAttachmentOrderRef.current = order + 1;
        return sortChatAttachmentsByOrder([
          ...current,
          {
            path: filePath,
            name: filePath.split("/").pop() || filePath,
            kind: looksLikeImage(filePath) ? "image" : "file",
            order,
          },
        ]);
      });
    }

    function replaceEditorDraft(text: string) {
      draftRef.current = text;
      setDraft(text);
      editorRef.current?.setText(text);
    }

    function insertInlineMentionSeparator() {
      const current = editorRef.current?.getText() ?? draftRef.current;
      if (current.trim() && !/\s$/.test(current)) {
        editorRef.current?.insertText(' ');
      }
    }

    function appendWorkspacePrompt(item: WorkspaceContextItem) {
      setStagedWorkspaceContexts((current) =>
        current.some((candidate) => candidate.id === item.id)
          ? current
          : [...current, item],
      );
      insertInlineMentionSeparator();
      editorRef.current?.insertMention({
        token: inlineMentionToken(item.label),
        entity: { id: item.id, kind: 'workspace', label: item.label },
      });
      setMention(null);
      setSlash(null);
      setComposerEngaged(true);
    }

    async function addLinkedDirs(dirs: string[]): Promise<Map<string, TrackedWorkspaceLinkedDir | null> | false> {
      if (!projectId) return false;
      const trimmedDirs = Array.from(new Set(dirs.map((dir) => dir.trim()).filter(Boolean)));
      if (trimmedDirs.length === 0) return new Map();
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const existing = base.linkedDirs ?? [];
      const nextLinkedDirs = [...existing];
      const trackedByDir = new Map<string, TrackedWorkspaceLinkedDir | null>();
      let changed = false;
      for (const trimmed of trimmedDirs) {
        if (nextLinkedDirs.includes(trimmed)) {
          const ownedByWorkspaceContext = Object.values(workspaceLinkedDirAdds).some(
            (tracked) => tracked.dir === trimmed,
          );
          trackedByDir.set(trimmed, ownedByWorkspaceContext ? { dir: trimmed, previousLinkedDirs: existing } : null);
          continue;
        }
        nextLinkedDirs.push(trimmed);
        trackedByDir.set(trimmed, { dir: trimmed, previousLinkedDirs: existing });
        changed = true;
      }
      if (changed) {
        const metadata: ProjectMetadata = { ...base, linkedDirs: nextLinkedDirs };
        const result = await patchProject(projectId, { metadata });
        if (!result?.metadata) {
          onShowToast?.(t('homeWorkingDir.applyFailed'));
          return false;
        }
        onProjectMetadataChange?.(result.metadata);
        for (const trimmed of trimmedDirs) void rememberRecentDir(trimmed);
      }
      return trackedByDir;
    }

    async function addLinkedDir(dir: string): Promise<TrackedWorkspaceLinkedDir | null | false> {
      const trackedByDir = await addLinkedDirs([dir]);
      if (trackedByDir === false) return false;
      return trackedByDir.get(dir.trim()) ?? null;
    }

    async function handleReferenceProjects(selections: ProjectReferenceSelection[]) {
      const items = selections.map(({ project, resolvedDir }) => {
        const path = resolvedDir.trim();
        return {
          id: `project:${project.id}`,
          kind: 'project',
          label: project.name || project.id,
          title: project.name || project.id,
          path: project.id,
          ...(path ? { absolutePath: path } : {}),
        } satisfies WorkspaceContextItem;
      });
      const trackedByDir = await addLinkedDirs(items.map((item) => workspaceContextLinkedDir(item) ?? ''));
      if (trackedByDir === false) {
                return;
      }
      for (const item of items) {
        appendWorkspacePrompt(item);
      }
      setProjectReferenceOpen(false);
            const trackedAdds: Record<string, TrackedWorkspaceLinkedDir> = {};
      for (const item of items) {
        const path = workspaceContextLinkedDir(item);
        const trackedLinkedDir = path ? trackedByDir.get(path) ?? null : null;
        if (trackedLinkedDir) trackedAdds[item.id] = trackedLinkedDir;
      }
      if (Object.keys(trackedAdds).length > 0) {
        setWorkspaceLinkedDirAdds((current) => ({ ...current, ...trackedAdds }));
      }
    }

    async function handleLinkLocalCodeContext() {
      const selected = await openFolderDialog();
      if (!selected) {
                return;
      }
      const trackedLinkedDir = await addLinkedDir(selected);
      if (trackedLinkedDir === false) {
                return;
      }
      const label = selected.split(/[/\\]/).filter(Boolean).pop() || selected;
      const item: WorkspaceContextItem = {
        id: `local-code:${selected}`,
        kind: 'local-code',
        label,
        title: label,
        absolutePath: selected,
      };
      appendWorkspacePrompt(item);
      if (trackedLinkedDir) {
        setWorkspaceLinkedDirAdds((current) => ({ ...current, [item.id]: trackedLinkedDir }));
      }
          }

    async function insertSkillMention(skill: SkillSummary) {
      const applied = await applyProjectSkill(skill);
      if (!applied) return;
      // Stage the skill so it rides this turn's skillIds, then insert an
      // atomic `@<name>` pill carrying the skill's real id. The onChange
      // prune keys on `skill:<id>` being present in the editor text, so the
      // chip survives until the user deletes the pill.
      setStagedSkills((prev) =>
        prev.some((s) => s.id === skill.id) ? prev : [...prev, skill],
      );
      editorRef.current?.insertMention({
        token: inlineMentionToken(skill.name),
        entity: { id: skill.id, kind: 'skill', label: skill.name },
      });
      setMention(null);
    }

    function stageSkillForCurrentTurn(skill: SkillSummary) {
      setStagedSkills((prev) =>
        prev.some((s) => s.id === skill.id) ? prev : [...prev, skill],
      );
    }

    function applyDesignToolboxPrompt(
      prompt: string,
      skill: SkillSummary | null,
    ) {
      const nextPrompt = skill
        ? `${inlineMentionToken(skill.name)}\n${prompt}`
        : prompt;
      if (skill) stageSkillForCurrentTurn(skill);
      applyDesignToolboxDraft(nextPrompt);
    }

    function applyDesignToolboxDraft(prompt: string) {
      replaceEditorDraft(prompt);
      editorRef.current?.focus();
    }

    function applyDesignToolboxAction(action: DesignToolboxAction) {
      const skill = findDesignToolboxSkill(action, skills);
      applyDesignToolboxPrompt(
        designToolboxActionPrompt({
          action,
          skill,
          workspaceItem: visibleWorkspaceContext,
          activeDraft: draft,
          resourceIndex: designToolboxResourceIndex,
          t,
        }),
        skill,
      );
    }
    // Recreated each render, so this captures the latest draft/context closure
    // for the imperative handle (see applyDesignToolboxActionRef).
    applyDesignToolboxActionRef.current = applyDesignToolboxAction;

    function applyDesignToolboxSkill(skill: SkillSummary) {
      applyDesignToolboxPrompt(
        designToolboxSkillPrompt({
          skill,
          workspaceItem: visibleWorkspaceContext,
          activeDraft: draft,
          resourceIndex: designToolboxResourceIndex,
          t,
        }),
        skill,
      );
    }
    // Latest-closure bridge for the imperative handle (see the ref declaration).
    applyDesignToolboxSkillByIdRef.current = (skillId: string) => {
      const skill = skills.find((s) => s.id === skillId);
      if (skill) applyDesignToolboxSkill(skill);
    };

    function applyDesignToolboxResource(resource: DesignToolboxResource) {
      if (resource.kind === 'skill') {
        applyDesignToolboxSkill(resource.skill);
        return;
      }

      const prompt = designToolboxResourcePrompt({
        resource,
        workspaceItem: visibleWorkspaceContext,
        activeDraft: draft,
        resourceIndex: designToolboxResourceIndex,
        t,
      });

      if (resource.kind === 'mcp') {
        const label = resource.server.label || resource.server.id;
        setStagedMcpServers((current) =>
          current.some((item) => item.id === resource.server.id)
            ? current
            : [...current, resource.server],
        );
        applyDesignToolboxDraft(`${inlineMentionToken(label)}\n${prompt}`);
        return;
      }

      if (resource.kind === 'file') {
        const path = resource.file.path ?? resource.file.name;
        appendContextAttachment(path);
        applyDesignToolboxDraft(`${inlineMentionToken(path)}\n${prompt}`);
        return;
      }

      applyDesignToolboxDraft(prompt);
    }

    function removeStagedSkill(id: string) {
            const skill = stagedSkills.find((s) => s.id === id) ?? null;
      setStagedSkills((prev) => prev.filter((s) => s.id !== id));
      const labels = [id, skill?.name ?? ''];
      replaceEditorDraft(stripInlineMentionLabels(draft, labels));
    }

    function removeStagedMcpServer(id: string) {
            const server = stagedMcpServers.find((item) => item.id === id) ?? null;
      setStagedMcpServers((prev) => prev.filter((item) => item.id !== id));
      replaceEditorDraft(stripInlineMentionLabels(draft, [
        id,
        server?.label ?? '',
      ]));
    }

    function workspaceContextDirStillReferenced(id: string, dir: string): boolean {
      return Object.entries(workspaceLinkedDirAdds).some(
        ([candidateId, candidate]) => candidateId !== id && candidate.dir === dir,
      ) || selectedWorkspaceContexts.some((item) => (
        item.id !== id && workspaceContextLinkedDir(item) === dir
      )) || workingDir === dir;
    }

    async function removeTrackedWorkspaceLinkedDir(
      id: string,
      tracked: TrackedWorkspaceLinkedDir,
    ): Promise<boolean> {
      if (!projectId) return true;
      if (workspaceContextDirStillReferenced(id, tracked.dir)) {
        setWorkspaceLinkedDirAdds((current) => {
          const { [id]: _removed, ...rest } = current;
          return rest;
        });
        return true;
      }
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const currentLinkedDirs = base.linkedDirs ?? [...tracked.previousLinkedDirs, tracked.dir];
      const nextLinkedDirs = currentLinkedDirs.filter((dir) => dir !== tracked.dir);
      const metadata: ProjectMetadata = { ...base, linkedDirs: nextLinkedDirs };
      const result = await patchProject(projectId, { metadata });
      if (!result?.metadata) {
        onShowToast?.(t('homeWorkingDir.applyFailed'));
        return false;
      }
      onProjectMetadataChange?.(result.metadata);
      setWorkspaceLinkedDirAdds((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
      return true;
    }

    async function removeWorkspaceContext(id: string) {
            const workspaceItem = selectedWorkspaceContexts.find((item) => item.id === id) ?? null;
      const trackedLinkedDir = workspaceLinkedDirAdds[id] ?? null;
      if (trackedLinkedDir && !(await removeTrackedWorkspaceLinkedDir(id, trackedLinkedDir))) {
        return;
      }
      if (visibleWorkspaceContext?.id === id) setDismissedWorkspaceContextId(id);
      setStagedWorkspaceContexts((prev) => prev.filter((item) => item.id !== id));
      if (!trackedLinkedDir) {
        setWorkspaceLinkedDirAdds((current) => {
          const { [id]: _removed, ...rest } = current;
          return rest;
        });
      }
      if (workspaceItem) {
        replaceEditorDraft(stripInlineMentionLabels(draftRef.current, [
          workspaceItem.label,
          workspaceItem.id,
          workspaceItem.title ?? '',
          workspaceItem.path ?? '',
          workspaceItem.absolutePath ?? '',
          workspaceItem.url ?? '',
        ]));
      }
    }

    async function ensureProject(): Promise<string | null> {
      if (projectId) return projectId;
      return onEnsureProject();
    }

    async function uploadFiles(files: File[]) {
      if (files.length === 0) return;
      const id = await ensureProject();
      if (!id) return;
      setUploading(true);
      setUploadError(null);
      const orderStart = reserveAttachmentOrders(files.length);
      try {
        const result = await uploadProjectFiles(id, files);
        if (result.uploaded.length > 0) {
          const orderedUploaded = assignChatAttachmentOrders(result.uploaded, orderStart);
          appendOrderedStagedAttachments(orderedUploaded);
        }
        const partial = result.failed.length > 0;
        if (partial) {
          const failedCount = result.failed.length;
          const uploadedCount = result.uploaded.length;
          const detail = result.error ? ` (${result.error})` : '';
          setUploadError(
            uploadedCount > 0
              ? `Attached ${uploadedCount} file(s), but ${failedCount} failed${detail}.`
              : `Attachment upload failed for ${failedCount} file(s)${detail}.`,
          );
          console.warn('Some attachments failed to upload', result.failed);
        }
              } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setUploadError(`Attachment upload failed (${detail}).`);
              } finally {
        setUploading(false);
      }
    }


    async function uploadClipboardImagesFromAsyncClipboard() {
      if (!navigator.clipboard?.read) return false;
      try {
        const items = await navigator.clipboard.read();
        const files: File[] = [];
        const stamp = Date.now();
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          const extension = imageType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
          files.push(new File([blob], `clipboard-screenshot-${stamp}.${extension}`, { type: imageType }));
        }
        if (files.length === 0) return false;
        await uploadFiles(files);
        return true;
      } catch (err) {
        console.warn('Could not read image from clipboard', err);
        return false;
      }
    }

    useEffect(() => {
      function onAnnotation(e: Event) {
        const detail = (e as CustomEvent<AnnotationEventDetail>).detail;
        if (!detail) return;
        void (async () => {
          let acked = false;
          const ack = (result: { ok: boolean; message?: string }) => {
            if (acked) return;
            acked = true;
            detail.ack?.(result);
          };
          let uploaded: ChatAttachment[] = [];
          let visualAttachmentInput: Parameters<typeof buildVisualAnnotationAttachment>[0] | null = null;
          let visualAttachment: ChatCommentAttachment | null = null;
          try {
            // Upload the annotation screenshot together with any images the
            // user attached in the markup composer. The screenshot (when
            // present) is first so it keeps backing the structured visual
            // comment; the rest ride along as ordinary chat attachments.
            const annotationFiles = [detail.file, ...(detail.extraFiles ?? [])].filter(
              (f): f is File => Boolean(f),
            );
            if (annotationFiles.length > 0) {
              const orderStart = reserveAttachmentOrders(annotationFiles.length);
              const id = await ensureProject();
              if (!id) {
                ack({ ok: false, message: t('chat.annotationProjectCreateFailed') });
                return;
              }
              setUploading(true);
              const result = await uploadProjectFiles(id, annotationFiles);
              if (result.uploaded.length > 0) {
                uploaded = assignChatAttachmentOrders(result.uploaded, orderStart);
                const screenshot = detail.file ? uploaded[0] : null;
                if (screenshot && detail.markKind && detail.bounds) {
                  visualAttachmentInput = {
                    order: isFiniteAttachmentOrder(screenshot.order) ? screenshot.order : orderStart,
                    idSeed: screenshot.path,
                    screenshotPath: screenshot.path,
                    markKind: detail.markKind,
                    note: detail.note,
                    bounds: detail.bounds,
                    target: detail.target
                      ? {
                          filePath: detail.target.filePath || detail.filePath || screenshot.path,
                          elementId: detail.target.elementId,
                          selector: detail.target.selector,
                          label: detail.target.label,
                          text: detail.target.text,
                          position: detail.target.position,
                          htmlHint: detail.target.htmlHint,
                        }
                      : {
                          filePath: detail.filePath || screenshot.path,
                          position: detail.bounds,
                        },
                  };
                }
              }
              if (result.failed.length > 0) {
                const detailText = result.error ? ` (${result.error})` : '';
                setUploadError(`Attachment upload failed for ${result.failed.length} file(s)${detailText}.`);
                if (uploaded.length === 0) {
                  ack({ ok: false, message: t('chat.annotationUploadFailed') });
                  return;
                }
              }
            }
            setUploading(false);

            const appendAnnotationToComposer = () => {
              if (uploaded.length > 0) {
                appendOrderedStagedAttachments(uploaded);
              }
              if (visualAttachmentInput) {
                setStagedVisualComments((current) => [
                  ...current,
                  buildVisualAnnotationAttachment({
                    ...visualAttachmentInput!,
                  }),
                ]);
              }
              if (detail.note) {
                // Accumulate through draftRef so two annotations resolving
                // concurrently compose (each reads the other's write) instead
                // of both starting from the same stale closure. Mirror the
                // result into the editor with setText so the now-non-empty
                // editor does not fire an onChange('') that would clobber the
                // accumulated draft back to empty.
                const nextDraft = draftRef.current
                  ? `${draftRef.current}\n${detail.note}`
                  : detail.note;
                draftRef.current = nextDraft;
                setDraft(nextDraft);
                editorRef.current?.setText(nextDraft);
              }
              editorRef.current?.focus();
            };

            if (detail.action === 'queue') {
              if (visualAttachmentInput) {
                visualAttachment = buildVisualAnnotationAttachment({
                  ...visualAttachmentInput,
                });
              }
              const prompt = [draft.trim(), detail.note].filter(Boolean).join('\n');
              const attachments = sortChatAttachmentsByOrder([...staged, ...uploaded]);
              const nextCommentAttachments = currentCommentAttachments(visualAttachment ? [visualAttachment] : []);
              sendComposedTurn(prompt, attachments, nextCommentAttachments, queueMeta(currentRunContextMeta()));
              ack({ ok: true });
              return;
            }

            if (detail.action === 'send') {
              if (streaming) {
                appendAnnotationToComposer();
                setStreamingAnnotationSendPending(true);
                ack({ ok: true });
                return;
              }
              if (visualAttachmentInput) {
                visualAttachment = buildVisualAnnotationAttachment({
                  ...visualAttachmentInput,
                });
              }
              const prompt = [draft.trim(), detail.note].filter(Boolean).join('\n');
              const attachments = sortChatAttachmentsByOrder([...staged, ...uploaded]);
              const nextCommentAttachments = currentCommentAttachments(visualAttachment ? [visualAttachment] : []);
              sendComposedTurn(prompt, attachments, nextCommentAttachments, currentRunContextMeta());
              ack({ ok: true });
              return;
            }

            if (detail.action === 'draft') {
              appendAnnotationToComposer();
              ack({ ok: true });
              return;
            }

            ack({ ok: false, message: t('chat.annotationFailed') });
          } catch (err) {
            console.warn('Could not send annotation', err);
            setUploadError(err instanceof Error ? err.message : t('chat.annotationFailed'));
            ack({ ok: false, message: t('chat.annotationFailed') });
          } finally {
            setUploading(false);
          }
        })();
      }
      window.addEventListener(ANNOTATION_EVENT, onAnnotation);
      return () => window.removeEventListener(ANNOTATION_EVENT, onAnnotation);
    }, [
      commentAttachments,
      draft,
      onSend,
      projectId,
      selectedWorkspaceContexts,
      staged,
      stagedMcpServers,
      stagedSkills,
      stagedVisualComments,
      streaming,
      t,
    ]);

    useEffect(() => {
      if (!streamingAnnotationSendPending || !streamingAnnotationSendPendingRef.current) return;
      if (streaming || sendDisabled) return;
      // Read the ref, not the closed-over `draft`: the accumulating annotation
      // handler writes draftRef synchronously, so the ref is authoritative even
      // if this effect's render closure predates the last accumulation.
      const prompt = draftRef.current.trim();
      sendComposedTurn(prompt, staged, currentCommentAttachments(), currentRunContextMeta());
    }, [
      commentAttachments,
      draft,
      onSend,
      selectedWorkspaceContexts,
      sendDisabled,
      staged,
      stagedMcpServers,
      stagedSkills,
      stagedVisualComments,
      streaming,
      streamingAnnotationSendPending,
    ]);

    // Paste handler invoked by the editor's PastePlugin. `files` are the items
    // the clipboard exposed synchronously; when empty we fall back to the
    // async Clipboard API to recover pasted screenshots that some browsers
    // only surface through `navigator.clipboard.read()`.
    function handlePasteFiles(files: File[]) {
      if (files.length > 0) {
        void uploadFiles(files);
        return;
      }
      void uploadClipboardImagesFromAsyncClipboard();
    }

    function handleDrop(e: React.DragEvent<HTMLDivElement>) {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploadFiles(files);
    }


    function linkedDirsWithWorkspaceContext(primaryDir: string | null): string[] {
      const primary = primaryDir?.trim();
      const contextDirs = primary
        ? workspaceContextMetadataLinkedDirList.filter((dir) => dir !== primary)
        : workspaceContextMetadataLinkedDirList;
      return Array.from(new Set([
        ...(primary ? [primary] : []),
        ...contextDirs,
      ]));
    }

    // The WorkingDirPicker treats the project's working directory as a single
    // primary folder, so selecting one replaces the primary `linkedDirs` entry
    // while preserving staged workspace-context dirs. The folder is read-only
    // awareness for the agent (→ `--add-dir`), not a Design Files import, and
    // `baseDir` is never touched.
    async function setWorkingDirFolder(dir: string) {
      if (!projectId) return;
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const metadata: ProjectMetadata = {
        ...base,
        linkedDirs: linkedDirsWithWorkspaceContext(dir),
      };
      const result = await patchProject(projectId, { metadata });
      // The daemon rejects stale/inaccessible/system dirs with
      // INVALID_LINKED_DIR (patchProject → null). Only commit the selection
      // and promote it in recents when the project accepted it; otherwise
      // surface the failure and leave recents untouched so a rejected path
      // isn't re-promoted to the top of the menu.
      if (!result?.metadata) {
        onShowToast?.(t('homeWorkingDir.applyFailed'));
        return;
      }
      onProjectMetadataChange?.(result.metadata);
      const promotedDir = dir.trim();
      setPromotedWorkspaceContextDir(
        selectedWorkspaceContextDirs.includes(promotedDir) ? promotedDir : null,
      );
      setWorkspaceLinkedDirAdds((current) => {
        const nextEntries = Object.entries(current).filter(([, tracked]) => (
          tracked.dir !== promotedDir
        ));
        return nextEntries.length === Object.keys(current).length
          ? current
          : Object.fromEntries(nextEntries);
      });
      void rememberRecentDir(dir);
    }
    async function handlePickWorkingDir() {
      const selected = await openFolderDialog();
      if (selected) await setWorkingDirFolder(selected);
    }
    async function clearWorkingDir() {
      if (!projectId) return;
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const metadata: ProjectMetadata = {
        ...base,
        linkedDirs: linkedDirsWithWorkspaceContext(null),
      };
      const result = await patchProject(projectId, { metadata });
      if (result?.metadata) {
        setPromotedWorkspaceContextDir(null);
        onProjectMetadataChange?.(result.metadata);
      }
    }

    // Lexical drives every text change through this callback. `present` is the
    // entity list the editor's text currently references (MentionNodes plus
    // plain `@token`s matched against composerMentionEntities, deduped by
    // kind:id). We prune the staged skill/mcp chips to whatever the
    // text still references — generalizing the old skill-only regex prune so a
    // hand-deleted token also drops its chip and never leaks into the run
    // context. Workspace contexts that added linked dirs are kept visible until
    // the chip remove button clears the matching metadata access. `staged`
    // (files) is intentionally NOT pruned: users attach files via the upload
    // button without leaving an `@<path>` token.
    function handleEditorChange(text: string, present: InlineMentionEntity[]) {
      draftRef.current = text;
      setDraft(text);
      const set = new Set(present.map((e) => `${e.kind}:${e.id}`));
      setStagedSkills((prev) => prev.filter((s) => set.has(`skill:${s.id}`)));
      setStagedMcpServers((prev) => prev.filter((m) => set.has(`mcp:${m.id}`)));
      setStagedWorkspaceContexts((prev) =>
        prev.filter((item) => set.has(`workspace:${item.id}`) || Boolean(workspaceLinkedDirAdds[item.id])),
      );
    }

    // Lexical reports the active @/slash trigger derived from the caret. The
    // mention popover state collapses to `{ q }`; the slash state replicates
    // the old detection effect (reset the keyboard index on open). IME
    // suppression already happened in the editor (it bails while composing).
    function handleEditorTrigger({
      mention: nextMention,
      slash: nextSlash,
      anchorRect,
    }: {
      mention: { q: string } | null;
      slash: { q: string } | null;
      anchorRect: CaretRect | null;
    }) {
      setCaretRect(anchorRect);
      if (nextMention && !mention) {
        setMentionTab('all');
      } else if (!nextMention) {
        setMentionTab('all');
      }
      setMention((prev) => {
        // Reset the active row only when the query identity changes (mirror of
        // the slash reset) so re-renders from unrelated state don't snap it.
        if (nextMention && (!prev || prev.q !== nextMention.q)) setMentionIndex(0);
        return nextMention;
      });
      if (nextSlash) {
        setSlash(nextSlash);
        setSlashIndex(0);
      } else {
        setSlash(null);
      }
    }

    // Routes popover navigation keys lifted verbatim from the old textarea
    // onKeyDown. Returns true when the key was consumed so the editor can
    // preventDefault; false lets the editor handle it normally (e.g. plain
    // arrow keys when no popover is open).
    function handlePopoverKey(
      key: 'ArrowDown' | 'ArrowUp' | 'Tab' | 'Enter' | 'Escape',
    ): boolean {
      if (slash && filteredSlash.length > 0) {
        if (key === 'ArrowDown') {
          setSlashIndex((i) => (i + 1) % filteredSlash.length);
          return true;
        }
        if (key === 'ArrowUp') {
          setSlashIndex(
            (i) => (i - 1 + filteredSlash.length) % filteredSlash.length,
          );
          return true;
        }
        if (key === 'Tab' || key === 'Enter') {
          const safe = Math.min(slashIndex, filteredSlash.length - 1);
          pickSlash(filteredSlash[safe]!);
          return true;
        }
        if (key === 'Escape') {
          setSlash(null);
          return true;
        }
      }
      if (mention && key === 'Escape') {
        setMention(null);
        return true;
      }
      if (mention) {
        // Drive a single index over the visible section union. MentionPopover
        // renders the same members-first, then files-first section order and
        // highlights the matching row from activeIndex.
        const showMembers = mentionTab === 'all' || mentionTab === 'members';
        const showFiles = mentionTab === 'all' || mentionTab === 'files';
        const showTabs = mentionTab === 'all' || mentionTab === 'tabs';
        const showSkills = mentionTab === 'all' || mentionTab === 'skills';
        const showMcp = mentionTab === 'all' || mentionTab === 'mcp';
        const total =
          (showMembers ? filteredMembers.length : 0) +
          (showFiles ? filteredFiles.length : 0) +
          (showTabs ? filteredWorkspaceContexts.length : 0) +
          (showSkills ? filteredSkills.length : 0) +
          (showMcp ? filteredMcpServers.length : 0);
        if (total > 0) {
          if (key === 'ArrowDown') {
            setMentionIndex((i) => (i + 1) % total);
            return true;
          }
          if (key === 'ArrowUp') {
            setMentionIndex((i) => (i - 1 + total) % total);
            return true;
          }
          if (key === 'Tab' || key === 'Enter') {
            pickMentionByFlatIndex(Math.min(mentionIndex, total - 1));
            return true;
          }
        }
      }
      return false;
    }

    // Resolve a flat visible-section index to the right insert call. Section
    // order MUST match MentionPopover's render order (members→files→tabs→
    // skills→mcp); the activeIndex highlight and Enter target stay in lockstep
    // across "All" and individual tabs.
    function pickMentionByFlatIndex(flat: number) {
      let i = flat;
      if (mentionTab === 'all' || mentionTab === 'members') {
        if (i < filteredMembers.length) {
          insertMemberMention(filteredMembers[i]!);
          return;
        }
        i -= filteredMembers.length;
      }
      if (mentionTab === 'all' || mentionTab === 'files') {
        if (i < filteredFiles.length) {
          insertMention(filteredFiles[i]!.path ?? filteredFiles[i]!.name);
          return;
        }
        i -= filteredFiles.length;
      }
      if (mentionTab === 'all' || mentionTab === 'tabs') {
        if (i < filteredWorkspaceContexts.length) {
          insertWorkspaceMention(filteredWorkspaceContexts[i]!);
          return;
        }
        i -= filteredWorkspaceContexts.length;
      }
      if (mentionTab === 'all' || mentionTab === 'skills') {
        if (i < filteredSkills.length) {
          void insertSkillMention(filteredSkills[i]!);
          return;
        }
        i -= filteredSkills.length;
      }
      if (mentionTab === 'all' || mentionTab === 'mcp') {
        if (i < filteredMcpServers.length) {
          insertMcpMention(filteredMcpServers[i]!);
          return;
        }
        i -= filteredMcpServers.length;
      }
    }

    function insertMention(filePath: string) {
      editorRef.current?.insertMention({
        token: inlineMentionToken(filePath),
        entity: { id: filePath, kind: 'file', label: filePath },
      });
      if (!staged.some((s) => s.path === filePath)) {
        appendContextAttachment(filePath);
      }
      setMention(null);
    }

    // Group member mention: inserts a `@MemberName` pill. Unlike file/mcp
    // mentions it stages no context — the member's name is parsed straight
    // from the sent prompt in ProjectView to route/dispatch the run to that
    // teammate agent. A trailing space lets the user keep typing the task.
    function insertMemberMention(member: { ref: string; name: string }) {
      editorRef.current?.insertMention({
        token: inlineMentionToken(member.name),
        entity: { id: member.ref, kind: 'member', label: member.name },
      });
      setMention(null);
    }

    function insertMcpMention(server: McpServerConfig) {
      setStagedMcpServers((current) => (
        current.some((item) => item.id === server.id) ? current : [...current, server]
      ));
      editorRef.current?.insertMention({
        token: inlineMentionToken(server.label || server.id),
        entity: { id: server.id, kind: 'mcp', label: server.label || server.id },
      });
      setMention(null);
    }

    function insertWorkspaceMention(item: WorkspaceContextItem) {
      setStagedWorkspaceContexts((current) =>
        current.some((candidate) => candidate.id === item.id)
          ? current
          : [...current, item],
      );
      editorRef.current?.insertMention({
        token: inlineMentionToken(item.label),
        entity: { id: item.id, kind: 'workspace', label: item.label },
      });
      setMention(null);
    }

    async function applyProjectSkill(skill: SkillSummary): Promise<boolean> {
      if (!projectId) return false;
      const result = await patchProject(projectId, { skillId: skill.id });
      if (!result) return false;
      onProjectSkillChange?.(result.skillId ?? skill.id);
      return true;
    }

    function removeStaged(p: string) {
            setStaged((s) => s.filter((a) => a.path !== p));
      setStagedVisualComments((current) => current.filter((attachment) => attachment.screenshotPath !== p));
      // Strip the `@<path>` token from the draft and push the result back into
      // the editor so the pill disappears in lockstep with the chip.
      replaceEditorDraft(stripInlineMentionToken(draft, p));
    }

    function removeCommentAttachment(id: string) {
      setStagedVisualComments((current) => current.filter((attachment) => attachment.id !== id));
      if (!stagedVisualComments.some((attachment) => attachment.id === id)) {
        onRemoveCommentAttachment?.(id);
      }
    }

    async function submit() {
      const prompt = draft.trim();
      if (sendDisabled) return;
      // Intercept `/mcp` before sending so the slash command never hits the
      // agent — these are local UX hooks, not model prompts.
      if (tryHandleMcpSlash()) return;
      // `/btw` routes to the side-question bridge, not the conversation run.
      // Web-local CLI equivalents (/clear, /rename, /export, /copy) and
      // navigate-to-page surface commands (/assets, /workflows, …) execute
      // client-side; the slash never becomes a conversation turn.
      if (tryHandleWebUxSlash()) return;
      const contextMeta = currentRunContextMeta();
      const nextCommentAttachments = currentCommentAttachments();
      const search = researchAvailable ? expandSearchCommand(prompt) : null;
      if (search) {
        if (streaming) return;
        setStreamingAnnotationSendPending(false);
        onSend(search.prompt, staged, nextCommentAttachments, {
          ...contextMeta,
          research: { enabled: true, query: search.query },
        });
        reset();
        return;
      }
      if (!prompt && staged.length === 0 && nextCommentAttachments.length === 0) {
        const placeholderPrompt = placeholderSubmittable && placeholderScenario
          ? placeholderScenario.text.trim()
          : '';
        if (!placeholderPrompt) return;
        const placeholderMeta: ChatSendMeta | undefined = placeholderScenario?.sessionMode
          ? {
              ...(contextMeta ?? {}),
              sessionMode: placeholderScenario.sessionMode,
            }
          : contextMeta;
        sendComposedTurn(placeholderPrompt, [], [], placeholderMeta);
        return;
      }
      sendComposedTurn(prompt, staged, nextCommentAttachments, contextMeta);
    }

    // The @-picker offers a unified search across context surfaces:
    // workspace tabs first, then project files, skills, active MCP servers.
    // Picked entities keep an inline @ token for orientation while richer
    // context is still applied behind the scenes when available.
    const mentionQuery = mention ? mention.q.toLowerCase() : '';
    // The suggestion lists below only matter while the @-popover is open
    // (each is `[]` otherwise). Memoize them on `[mention, mentionQuery,
    // <source>]` so the filter/sort passes run only when the query or the
    // backing list actually changes — not on every unrelated composer render
    // (streaming flips, draft typing routed through Lexical, staged-chip churn).
    // `mention` is in the deps (not just `mentionQuery`) so the open/close gate
    // re-evaluates: a null→{q:''} transition keeps the query '' but must flip
    // the list from `[]` to live results.
    // Group members surface first in the popover so a user can @-address a
    // teammate agent to do work. Filtered by name / role id like the rest.
    const filteredMembers = useMemo(
      () =>
        mention
          ? groupMemberList
              .filter((member) => {
                if (!mentionQuery) return true;
                return `${member.name} ${member.ref} ${member.id}`
                  .toLowerCase()
                  .includes(mentionQuery);
              })
              .slice(0, 12)
          : [],
      [mention, mentionQuery, groupMemberList],
    );
    const filteredWorkspaceContexts = useMemo(
      () =>
        mention
          ? workspaceContexts
              .filter((item) => {
                if (!mentionQuery) return true;
                return workspaceContextSearchText(item).toLowerCase().includes(mentionQuery);
              })
              .slice(0, 12)
          : [],
      [mention, mentionQuery, workspaceContexts],
    );
    const filteredFiles = useMemo(
      () =>
        mention
          ? projectFiles
              .filter((f) => f.type === undefined || f.type === "file")
              .filter((f) => {
                const key = f.path ?? f.name;
                return key.toLowerCase().includes(mentionQuery);
              })
              .slice(0, 12)
          : [],
      [mention, mentionQuery, projectFiles],
    );
    const filteredMcpServers = useMemo(
      () =>
        mention
          ? enabledMcpServers
              .filter((s) => {
                if (!mentionQuery) return true;
                return [
                  s.id,
                  s.label ?? '',
                  s.transport,
                  s.url ?? '',
                  s.command ?? '',
                ]
                  .join(' ')
                  .toLowerCase()
                  .includes(mentionQuery);
              })
              .slice(0, 8)
          : [],
      [mention, mentionQuery, enabledMcpServers],
    );
    // Already-staged skills drop out of the suggestion list (carried over
    // from main) so the @-popover keeps moving forward as the user picks.
    const filteredSkills = useMemo(() => {
      if (!mention) return [];
      const stagedSkillIds = new Set(stagedSkills.map((s) => s.id));
      return skills
        .filter((s) => !stagedSkillIds.has(s.id))
        .filter((s) => skillMatchesQuery(s, mentionQuery))
        .sort((a, b) => skillMentionRank(a, mentionQuery) - skillMentionRank(b, mentionQuery));
    }, [mention, mentionQuery, skills, stagedSkills]);
    const liveCommentAttachments = currentCommentAttachments();
    const placeholderCarouselActive =
      !streaming
      && !sendDisabled
      && !activeFileContext
      && placeholderScenarios.length > 0
      && draft.trim().length === 0
      && staged.length === 0
      && liveCommentAttachments.length === 0
      && !mention
      && !slash;
    const placeholderSubmittable =
      placeholderCarouselActive && Boolean(placeholderScenario?.text.trim());
    const hasComposerPayload =
      draft.trim().length > 0
      || staged.length > 0
      || liveCommentAttachments.length > 0
      || placeholderSubmittable;
    const showStopButton = streaming && !hasComposerPayload;
    const showSendButton = !streaming || hasComposerPayload;

    return (
      <div
        className={[
          'composer',
          dragActive ? 'drag-active' : '',
          activeFileContext ? 'composer-active-file-mode' : '',
        ].filter(Boolean).join(' ')}
        data-testid="chat-composer"
        ref={composerRootRef}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="composer-shell">
          {matosRolePicker || matosModelPicker || selectedWorkspaceContexts.length > 0 || stagedSkills.length > 0 || stagedMcpServers.length > 0 || staged.length > 0 ? (
            <StagedRunContexts
              matosRolePicker={matosRolePicker}
              matosModelPicker={matosModelPicker}
              workspaceItems={selectedWorkspaceContexts}
              currentWorkspaceContextId={visibleWorkspaceContext?.id ?? null}
              skills={stagedSkills}
              mcpServers={stagedMcpServers}
              attachments={staged}
              projectId={projectId}
              onRemoveWorkspace={removeWorkspaceContext}
              onRemoveSkill={removeStagedSkill}
              onRemoveMcp={removeStagedMcpServer}
              onRemoveAttachment={removeStaged}
              onSkillDetails={(id) => {
                setDetailsSkill({
                  id,
                  summary: stagedSkills.find((skill) => skill.id === id)
                    ?? skills.find((skill) => skill.id === id)
                    ?? null,
                });
              }}
              t={t}
            />
          ) : null}
          {activeFileContext ? (
            <div
              className="composer-active-file"
              data-testid="composer-active-file"
              title={activeFileContext}
            >
              <span className="composer-active-file__label">{t('chat.activeFileEditingLabel')}</span>
              <span className="composer-active-file__name">{activeFileContext}</span>
            </div>
          ) : null}
          {currentCommentAttachments().length > 0 ? (
            <StagedCommentAttachments
              attachments={currentCommentAttachments()}
              onRemove={removeCommentAttachment}
              t={t}
            />
          ) : null}
          <div
            className="composer-input-wrap"
            onFocus={() => setComposerEngaged(true)}
          >
            <LexicalComposerInput
              ref={editorRef}
              draft={draft}
              placeholder={
                activeFileDisplayName
                  ? t('chat.activeFilePlaceholder', { file: activeFileDisplayName })
                  : placeholderCarouselActive
                    ? ''
                    : composerPlaceholder ?? t('chat.composerPlaceholder')
              }
              title={activeFileDisplayName ?? composerPlaceholder ?? t('chat.composerPlaceholder')}
              knownEntities={composerMentionEntities}
              onChange={handleEditorChange}
              onTrigger={handleEditorTrigger}
              onEnterSend={() => void submit()}
              onPasteFiles={handlePasteFiles}
              popoverOpen={Boolean(mention) || Boolean(slash && filteredSlash.length > 0)}
              onPopoverKey={handlePopoverKey}
              comboboxAria={{
                expanded: Boolean(mention),
                activeId: mention ? `mention-opt-${mentionIndex}` : null,
              }}
            />
            {placeholderScenarios.length > 0 ? (
              <PlaceholderCarousel
                scenarios={placeholderScenarios}
                active={placeholderCarouselActive}
                onScenarioChange={setPlaceholderScenario}
              />
            ) : null}
          </div>
          <CaretFloatingLayer
            caret={caretRect}
            open={Boolean(mention)}
            boundaryRef={composerRootRef}
          >
            <MentionPopover
              members={filteredMembers}
              files={filteredFiles}
              workspaceContexts={filteredWorkspaceContexts}
              skills={filteredSkills}
              mcpServers={filteredMcpServers}
              query={mention?.q ?? ''}
              tab={mentionTab}
              onTabChange={(nextTab) => {
                setMentionTab(nextTab);
                setMentionIndex(0);
              }}
              activeIndex={mentionIndex}
              currentSkillId={currentSkillId}
              onPickMember={insertMemberMention}
              onPickFile={insertMention}
              onPickWorkspaceContext={insertWorkspaceMention}
              onPickSkill={(skill) => void insertSkillMention(skill)}
              onPickMcp={insertMcpMention}
            />
          </CaretFloatingLayer>
          <CaretFloatingLayer
            caret={caretRect}
            open={Boolean(slash && filteredSlash.length > 0)}
            boundaryRef={composerRootRef}
          >
            <SlashPopover
              commands={filteredSlash}
              activeIndex={Math.min(slashIndex, filteredSlash.length - 1)}
              onPick={pickSlash}
              onHover={(i) => setSlashIndex(i)}
              t={t}
            />
          </CaretFloatingLayer>
          <div className="composer-row">
            <input
              ref={fileInputRef}
              data-testid="chat-file-input"
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                void uploadFiles(files);
                e.target.value = '';
              }}
            />
            <ComposerPlusMenu
              triggerTestId="chat-plus-trigger"
              placementPreference="up"
              onOpen={() => {
                                setComposerEngaged(true);
              }}
              skills={skills}
              onPickSkill={(skill) => {
                                void insertSkillMention(skill);
              }}
              mcpServers={enabledMcpServers}
              onPickMcp={(server) => {
                                insertMcpMention(server);
              }}
              onAddMcp={() => {
                                onOpenMcpSettings?.();
              }}
              onAttachFiles={() => {
                                fileInputRef.current?.click();
              }}
              onReferenceProject={() => {
                                                setProjectReferenceOpen(true);
              }}
              onLinkLocalCode={() => {
                                void handleLinkLocalCodeContext();
              }}
              attachLoading={uploading}
              toolboxLabel={t('chat.designToolbox.title')}
              renderToolbox={(close) => (
                <DesignToolboxPanel
                  actions={DESIGN_TOOLBOX_ACTIONS}
                  skills={skills}
                  mcpServers={enabledMcpServers}
                  mcpTemplates={mcpTemplates}
                  projectFiles={projectFiles}
                  activeSkillIds={stagedSkills.map((skill) => skill.id)}
                  activeMcpServerIds={stagedMcpServers.map((server) => server.id)}
                  activeFilePaths={staged.map((item) => item.path)}
                  onPickAction={(action) => {
                                        applyDesignToolboxAction(action);
                    close();
                  }}
                  onPickSkill={(skill) => {
                                        applyDesignToolboxSkill(skill);
                    close();
                  }}
                  onPickResource={(resource) => {
                                        applyDesignToolboxResource(resource);
                    close();
                  }}
                />
              )}
            />
            {designToolboxOpen ? (
              <div className="composer-toolbox-standalone">
                {/* Click-catcher backdrop. A <div> (not a <button>) so it never
                    inherits the app's global button:hover fill, which otherwise
                    painted the whole screen when the cursor crossed it. */}
                <div
                  className="composer-toolbox-standalone-backdrop"
                  aria-hidden="true"
                  onClick={() => setDesignToolboxOpen(false)}
                />
                <div
                  className="plus-menu__popup composer-toolbox-standalone-popup"
                  role="menu"
                >
                  <DesignToolboxPanel
                    actions={DESIGN_TOOLBOX_ACTIONS}
                    skills={skills}
                    mcpServers={enabledMcpServers}
                    mcpTemplates={mcpTemplates}
                      projectFiles={projectFiles}
                    activeSkillIds={stagedSkills.map((skill) => skill.id)}
                    activeMcpServerIds={stagedMcpServers.map((server) => server.id)}
                      activeFilePaths={staged.map((item) => item.path)}
                    onPickAction={(action) => {
                                            applyDesignToolboxAction(action);
                      setDesignToolboxOpen(false);
                    }}
                    onPickSkill={(skill) => {
                                            applyDesignToolboxSkill(skill);
                      setDesignToolboxOpen(false);
                    }}
                    onPickResource={(resource) => {
                                            applyDesignToolboxResource(resource);
                      setDesignToolboxOpen(false);
                    }}
                  />
                </div>
              </div>
            ) : null}
            {leadingAccessory}
            <span className="composer-spacer" />
            {footerAccessory}
            <SessionModeToggle
              mode={sessionMode}
              onChange={onSessionModeChange}
            />
            {showStopButton ? (
              <button
                type="button"
                className="composer-send stop od-tooltip"
                onClick={onStop}
                title={t('chat.stop')}
                data-tooltip={t('chat.stop')}
                aria-label={t('chat.stop')}
              >
                <Icon name="stop" size={16} />
                <span>{t('chat.stop')}</span>
              </button>
            ) : null}
            {showSendButton ? (
              <button
                type="button"
                className="composer-send od-tooltip"
                data-testid="chat-send"
                onClick={() => {
                                    void submit();
                }}
                disabled={sendDisabled || !hasComposerPayload}
                aria-label={t('chat.send')}
                title={t('chat.send')}
                data-tooltip={t('chat.send')}
              >
                <Icon name="send" size={16} />
                <span>{t('chat.send')}</span>
              </button>
            ) : null}
          </div>
        </div>
        {projectId ? (
          <div className="composer-workdir-row">
            <WorkingDirPicker
              placement="up"
              workingDir={workingDir}
              invalid={workingDirMissing}
              recentDirs={recentDirs}
              onOpen={() => void checkWorkingDir()}
              onPickDirectory={() => {
                // Fire on the click itself (intent), matching the home
                // composer's working_dir* elements so one dashboard counts the
                // action across both surfaces.
                                void handlePickWorkingDir();
              }}
              onSelectRecent={(dir) => {
                                void setWorkingDirFolder(dir);
              }}
              onClear={() => {
                                void clearWorkingDir();
              }}
            />
          </div>
        ) : null}
        {uploadError ? (
          <div className="composer-hint composer-upload-error" role="alert">
            <span className="composer-upload-error__msg">{uploadError}</span>
            <button
              type="button"
              className="composer-upload-error__retry"
              onClick={() => {
                setUploadError(null);
                fileInputRef.current?.click();
              }}
            >
              {t('preview.retry')}
            </button>
          </div>
        ) : null}
        {detailsSkill ? (
          <SkillDetailsModal
            skillId={detailsSkill.id}
            summary={detailsSkill.summary}
            onClose={() => setDetailsSkill(null)}
          />
        ) : null}
        {projectReferenceOpen ? (
          <ProjectReferenceModal
            currentProjectId={projectId}
            onClose={() => {
              // Only the dismiss paths (X / backdrop / Escape / Cancel) land
              // here — a confirmed pick closes via handleReferenceProjects,
              // which reports 'success' / 'failed'.
                            setProjectReferenceOpen(false);
            }}
            onSelect={(items) => void handleReferenceProjects(items)}
          />
        ) : null}
      </div>
    );
  }
);

function buildComposerMentionEntities({
  files,
  mcpServers,
  skills,
  staged,
  workspaceContexts,
}: {
  files: ProjectFile[];
  mcpServers: McpServerConfig[];
  skills: SkillSummary[];
  staged: ChatAttachment[];
  workspaceContexts: WorkspaceContextItem[];
}): InlineMentionEntity[] {
  const entities: InlineMentionEntity[] = [];
  const workspaceSeen = new Set<string>();
  for (const item of workspaceContexts) {
    if (!item.id || !item.label) continue;
    const key = `workspace:${item.id}`;
    if (workspaceSeen.has(key)) continue;
    workspaceSeen.add(key);
    entities.push({
      id: item.id,
      kind: 'workspace',
      label: item.label,
      token: inlineMentionToken(item.label),
      title: `Workspace: ${item.label}`,
    });
  }
  for (const skill of skills) {
    entities.push({
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      token: inlineMentionToken(skill.name),
      title: `Skill: ${skill.name}`,
    });
    if (skill.id !== skill.name) {
      entities.push({
        id: skill.id,
        kind: 'skill',
        label: skill.id,
        token: inlineMentionToken(skill.id),
        title: `Skill: ${skill.name}`,
      });
    }
  }
  for (const server of mcpServers) {
    const label = server.label || server.id;
    entities.push({
      id: server.id,
      kind: 'mcp',
      label,
      token: inlineMentionToken(label),
      title: `MCP: ${label}`,
    });
    if (server.id !== label) {
      entities.push({
        id: server.id,
        kind: 'mcp',
        label: server.id,
        token: inlineMentionToken(server.id),
        title: `MCP: ${label}`,
      });
    }
  }
  const filePaths = new Set<string>();
  for (const file of files) {
    const path = file.path ?? file.name;
    if (!path || filePaths.has(path)) continue;
    filePaths.add(path);
    entities.push({
      id: path,
      kind: 'file',
      label: path,
      token: inlineMentionToken(path),
      title: `File: ${path}`,
    });
  }
  for (const attachment of staged) {
    if (!attachment.path || filePaths.has(attachment.path)) continue;
    filePaths.add(attachment.path);
    entities.push({
      id: attachment.path,
      kind: 'file',
      label: attachment.path,
      token: inlineMentionToken(attachment.path),
      title: `File: ${attachment.path}`,
    });
  }
  return entities;
}

function isFiniteAttachmentOrder(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}



function normalizeChatAttachmentOrders(attachments: ChatAttachment[]): ChatAttachment[] {
  let fallbackOrder = 0;
  return attachments.map((attachment) => {
    if (isFiniteAttachmentOrder(attachment.order)) {
      fallbackOrder = Math.max(fallbackOrder, Math.floor(attachment.order) + 1);
      return { ...attachment, order: Math.floor(attachment.order) };
    }
    const order = fallbackOrder;
    fallbackOrder += 1;
    return { ...attachment, order };
  });
}

function assignChatAttachmentOrders(
  attachments: ChatAttachment[],
  orderStart: number,
): ChatAttachment[] {
  return attachments.map((attachment, index) => ({
    ...attachment,
    order: orderStart + index,
  }));
}

function nextChatAttachmentOrder(attachments: ChatAttachment[]): number {
  return attachments.reduce(
    (max, attachment, index) =>
      Math.max(max, isFiniteAttachmentOrder(attachment.order) ? Math.floor(attachment.order) + 1 : index + 1),
    0,
  );
}

function sortChatAttachmentsByOrder(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments
    .map((attachment, index) => ({ attachment, index }))
    .sort((a, b) => {
      const aOrder = isFiniteAttachmentOrder(a.attachment.order) ? a.attachment.order : a.index;
      const bOrder = isFiniteAttachmentOrder(b.attachment.order) ? b.attachment.order : b.index;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.index - b.index;
    })
    .map((entry) => entry.attachment);
}

function sortChatCommentAttachmentsByOrder(attachments: ChatCommentAttachment[]): ChatCommentAttachment[] {
  return attachments
    .map((attachment, index) => ({ attachment, index }))
    .sort((a, b) => {
      const aOrder = isFiniteAttachmentOrder(a.attachment.order) ? a.attachment.order : a.index;
      const bOrder = isFiniteAttachmentOrder(b.attachment.order) ? b.attachment.order : b.index;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.index - b.index;
    })
    .map((entry) => entry.attachment);
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

function workspaceContextDescription(item: WorkspaceContextItem): string {
  if (item.kind === 'design-files') return item.path || 'Project files';
  if (item.kind === 'project') return item.absolutePath || item.path || item.title || item.id;
  if (item.kind === 'local-code') return item.absolutePath || item.path || item.title || item.id;
  if (item.kind === 'terminal') return item.title || 'Terminal session';
  return item.url || item.path || item.absolutePath || item.title || item.tabId || item.id;
}

function lastPathSegment(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || path;
}

function projectFileMentionTitle(file: ProjectFile, fallback: string): string {
  return file.name || lastPathSegment(fallback);
}

function projectFileMentionDescription(file: ProjectFile, fallback: string): string {
  const label = projectFileMentionTitle(file, fallback);
  if (fallback && fallback !== label) return fallback;
  return [file.kind, file.mime].filter(Boolean).join(' · ');
}

function workspaceContextSearchText(item: WorkspaceContextItem): string {
  return [
    item.id,
    item.kind,
    item.label,
    item.tabId ?? '',
    item.path ?? '',
    item.absolutePath ?? '',
    item.url ?? '',
    item.title ?? '',
  ].join(' ');
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

function StagedRunContexts({
  matosRolePicker,
  matosModelPicker,
  workspaceItems,
  currentWorkspaceContextId,
  skills,
  mcpServers,
  attachments,
  projectId,
  onRemoveWorkspace,
  onRemoveSkill,
  onRemoveMcp,
  onRemoveAttachment,
  onSkillDetails,
  t,
}: {
  matosRolePicker?: ReactNode;
  matosModelPicker?: ReactNode;
  workspaceItems: WorkspaceContextItem[];
  currentWorkspaceContextId: string | null;
  skills: SkillSummary[];
  mcpServers: McpServerConfig[];
  attachments: ChatAttachment[];
  projectId: string | null;
  onRemoveWorkspace: (id: string) => void;
  onRemoveSkill: (id: string) => void;
  onRemoveMcp: (id: string) => void;
  onRemoveAttachment: (path: string) => void;
  onSkillDetails?: (id: string) => void;
  t: TranslateFn;
}) {
  // Attachment thumbnails preview in a portal modal; keep that state here so the
  // file chips can live in the same wrap row as other context chips and
  // other run-context chips (so files flow to the picker's right, wrapping to a
  // new line only when the row fills) instead of forcing a separate row below.
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  const previewUrl = preview && projectId ? projectRawUrl(projectId, preview.path) : null;
  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPreview(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);
  return (
    <>
    <div
      className="staged-row staged-context-row"
      data-testid="staged-contexts"
    >
      {matosRolePicker ? (
        <div className="staged-context-picker staged-context-picker--matos-role">
          {matosRolePicker}
        </div>
      ) : null}
      {matosModelPicker ? (
        <div className="staged-context-picker staged-context-picker--matos-model">
          {matosModelPicker}
        </div>
      ) : null}
      {workspaceItems.map((workspaceItem) => {
        const kindLabel =
          workspaceItem.id === currentWorkspaceContextId
            ? 'Current'
            : workspaceContextKindLabel(workspaceItem.kind);
        return (
          <div
            key={workspaceItem.id}
            className={`staged-chip staged-context staged-context--workspace staged-context--workspace-${workspaceItem.kind}`}
          >
            <span className="staged-icon" aria-hidden>
              <Icon name={workspaceContextIcon(workspaceItem)} size={12} />
            </span>
            <span className="staged-name" title={workspaceContextTitle(workspaceItem)}>
              <span className="staged-context-kind">{kindLabel}</span>
              {workspaceItem.label}
            </span>
            <button
              type="button"
              className="staged-remove od-tooltip"
              onClick={() => onRemoveWorkspace(workspaceItem.id)}
              title={t('common.delete')}
              data-tooltip={t('common.delete')}
              aria-label={t('chat.removeAria', { name: workspaceItem.label })}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
      {skills.map((s) => (
        <div
          key={s.id}
          className={`staged-chip staged-context staged-context--skill staged-skill-${s.source ?? 'built-in'}`}
        >
          <button
            type="button"
            className="staged-context-open"
            onClick={() => onSkillDetails?.(s.id)}
            title={s.description || s.name}
            aria-label={s.name}
          >
            <span className="staged-icon" aria-hidden>
              <Icon name="sparkles" size={12} />
            </span>
            <span className="staged-name">@{s.name}</span>
          </button>
          <button
            type="button"
            className="staged-remove od-tooltip"
            onClick={() => onRemoveSkill(s.id)}
            title={t('common.delete')}
            data-tooltip={t('common.delete')}
            aria-label={t('chat.removeAria', { name: s.name })}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
      {mcpServers.map((server) => {
        const label = server.label || server.id;
        return (
          <div
            key={server.id}
            className="staged-chip staged-context staged-context--mcp"
          >
            <span className="staged-icon" aria-hidden>
              <Icon name="link" size={12} />
            </span>
            <span className="staged-name" title={server.command || server.url || server.id}>
              @{label}
            </span>
            <button
              type="button"
              className="staged-remove od-tooltip"
              onClick={() => onRemoveMcp(server.id)}
              title={t('common.delete')}
              data-tooltip={t('common.delete')}
              aria-label={t('chat.removeAria', { name: label })}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
      {attachments.map((a, index) => {
        const canPreview = a.kind === 'image' && Boolean(projectId);
        const imageUrl = canPreview ? projectRawUrl(projectId!, a.path) : null;
        return (
          <div key={a.path} className={`staged-chip staged-${a.kind}`}>
            <span className="staged-order" aria-label={`Attachment ${index + 1}`}>
              {index + 1}
            </span>
            {canPreview && imageUrl ? (
              <button
                type="button"
                className="staged-preview-trigger"
                onClick={() => setPreview(a)}
                title={a.path}
                aria-label={`Preview ${a.name}`}
              >
                <img src={imageUrl} alt="" aria-hidden />
                <span className="staged-name">{a.name}</span>
              </button>
            ) : (
              <>
                <span className="staged-icon" aria-hidden>
                  <Icon name="file" size={13} />
                </span>
                <span className="staged-name" title={a.path}>
                  {a.name}
                </span>
              </>
            )}
            <button
              type="button"
              className="staged-remove od-tooltip"
              onClick={() => onRemoveAttachment(a.path)}
              title={t('common.delete')}
              data-tooltip={t('common.delete')}
              aria-label={t('chat.removeAria', { name: a.name })}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
    </div>
    {preview && previewUrl ? createPortal(
      <div
        className="staged-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={preview.name}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setPreview(null);
        }}
      >
        <div className="staged-preview-card">
          <div className="staged-preview-head">
            <span title={preview.path}>{preview.name}</span>
            <button
              type="button"
              className="icon-only od-tooltip"
              onClick={() => setPreview(null)}
              aria-label={t('common.close')}
              title={t('common.close')}
              data-tooltip={t('common.close')}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <img src={previewUrl} alt={preview.name} />
        </div>
      </div>,
      document.body
    ) : null}
    </>
  );
}

function StagedCommentAttachments({
  attachments,
  onRemove,
  t,
}: {
  attachments: ChatCommentAttachment[];
  onRemove: (id: string) => void;
  t: TranslateFn;
}) {
  const visibleAttachments = attachments.filter((attachment) => attachment.selectionKind !== 'visual');
  if (visibleAttachments.length === 0) return null;
  return (
    <div className="staged-row comment-staged-row" data-testid="staged-comment-attachments">
      {visibleAttachments.map((a) => (
        <div key={a.id} className="staged-chip staged-comment">
          <span
            className="staged-name"
            title={`${a.screenshotPath ? `${a.screenshotPath}: ` : ''}${commentTargetDisplayName(a)}${a.comment ? `: ${a.comment}` : ''}`}
          >
            <strong>{commentTargetDisplayName(a)}</strong>
            {a.comment ? <span>{a.comment}</span> : null}
          </span>
          <button
            type="button"
            className="staged-remove od-tooltip"
            onClick={() => onRemove(a.id)}
            title={t('chat.comments.removeAttachment')}
            data-tooltip={t('chat.comments.removeAttachment')}
            aria-label={t('chat.comments.removeAttachmentAria', { name: a.elementId })}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}



function DesignToolboxPanel({
  actions,
  skills,
  mcpServers,
  mcpTemplates,
  projectFiles,
  activeSkillIds,
  activeMcpServerIds,
  activeFilePaths,
  onPickAction,
  onPickSkill,
  onPickResource,
  onOpened,
}: {
  actions: DesignToolboxAction[];
  skills: SkillSummary[];
  mcpServers: McpServerConfig[];
  mcpTemplates: McpTemplate[];
  projectFiles: ProjectFile[];
  activeSkillIds: string[];
  activeMcpServerIds: string[];
  activeFilePaths: string[];
  onPickAction: (action: DesignToolboxAction) => void;
  onPickSkill: (skill: SkillSummary) => void;
  onPickResource: (resource: DesignToolboxResource) => void;
  onOpened?: () => void;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState('');
  // Fire once when the toolbox panel mounts (i.e. the user opened it).
  useEffect(() => {
    onOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const activeSkillSet = useMemo(() => new Set(activeSkillIds), [activeSkillIds]);
  const activeMcpServerSet = useMemo(() => new Set(activeMcpServerIds), [activeMcpServerIds]);
  const activeFileSet = useMemo(() => new Set(activeFilePaths), [activeFilePaths]);
  const resources = useMemo(
    () =>
      buildDesignToolboxResources({
        skills,
        mcpServers,
        mcpTemplates,
        projectFiles,
        locale,
        t,
      }),
    [locale, mcpServers, mcpTemplates, projectFiles, skills, t],
  );
  const visibleActions = useMemo(
    () =>
      actions.filter((action) => {
        const skill = findDesignToolboxSkill(action, skills);
        return designToolboxActionMatchesQuery(
          action,
          query,
          skill,
          t,
          skill ? [localizeSkillName(locale, skill), localizeSkillDescription(locale, skill)] : [],
        );
      }),
    [actions, query, skills, locale, t],
  );
  const visibleResources = useMemo(
    () => {
      const source = query
        ? resources.filter((resource) => designToolboxResourceMatchesQuery(resource, query))
        : designToolboxDefaultResources(actions, resources);
      return source.slice(0, query ? 14 : 8);
    },
    [actions, query, resources],
  );

  // One shared hover-detail panel for the whole list — swapping a single
  // portaled panel as the cursor sweeps rows, instead of one panel per row
  // (which ghosted: the close delay left several stacked on screen at once).
  const [toolboxDetail, setToolboxDetail] = useState<{
    key: string;
    left: number;
    top: number;
    node: ReactNode;
  } | null>(null);
  const detailCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelDetailClose() {
    if (detailCloseTimer.current) {
      clearTimeout(detailCloseTimer.current);
      detailCloseTimer.current = null;
    }
  }
  function showToolboxDetail(key: string, rect: DOMRect, node: ReactNode) {
    cancelDetailClose();
    // The helper clamps both axes into the viewport so the fixed panel never
    // lands off-screen on a narrow pane (see computeToolboxDetailPosition).
    const { left, top } = computeToolboxDetailPosition(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { detailWidth: 264, gap: 8, margin: 8, estimatedHeight: 340 },
    );
    setToolboxDetail({ key, left, top, node });
  }
  function scheduleToolboxDetailClose(key: string) {
    cancelDetailClose();
    detailCloseTimer.current = setTimeout(() => {
      setToolboxDetail((cur) => (cur?.key === key ? null : cur));
      detailCloseTimer.current = null;
    }, 160);
  }
  useEffect(() => () => cancelDetailClose(), []);

  return (
    <>
      <div className="composer-design-toolbox-head">
        <div className="composer-design-toolbox-title">
          <Icon name="lightbulb" size={14} />
          <span>{t('chat.designToolbox.title')}</span>
        </div>
      </div>
      <div className="plus-menu__search">
        <Icon name="search" size={13} />
        <input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={t('chat.designToolbox.searchPlaceholder')}
          aria-label={t('chat.designToolbox.searchAria')}
        />
      </div>
      {visibleActions.length > 0 || visibleResources.length > 0 ? (
        <div className="plus-menu__list">
          {visibleActions.length > 0 ? (
            <div className="plus-menu__section-label">
              {t('chat.designToolbox.followupSection')}
            </div>
          ) : null}
          {visibleActions.map((action) => {
            const skill = findDesignToolboxSkill(action, skills);
            const actionTitle = designToolboxActionTitle(action, t);
            const actionDescription = designToolboxActionDescription(action, t);
            const skillName = skill ? localizeSkillName(locale, skill) : null;
            return (
              <ToolboxItemRow
                key={action.id}
                detailKey={action.id}
                icon={action.icon}
                name={actionTitle}
                onHover={showToolboxDetail}
                onLeave={scheduleToolboxDetailClose}
                onPick={() => onPickAction(action)}
                detail={
                  <>
                    <div className="plus-menu__detail-title">{actionTitle}</div>
                    {actionDescription ? (
                      <div className="plus-menu__detail-desc">{actionDescription}</div>
                    ) : null}
                    {skillName ? (
                      <div className="plus-menu__detail-skill">@{skillName}</div>
                    ) : null}
                    <div className="plus-menu__detail-badge">
                      {designToolboxActionBadge(action, t)}
                    </div>
                  </>
                }
              />
            );
          })}
          {visibleResources.length > 0 ? (
            <div className="plus-menu__section-label">
              {t('chat.designToolbox.resourcesSection')}
            </div>
          ) : null}
          {visibleResources.map((resource) => {
            const active = designToolboxResourceIsActive(resource, {
              skillIds: activeSkillSet,
              mcpServerIds: activeMcpServerSet,
              filePaths: activeFileSet,
            });
            return (
              <ToolboxItemRow
                key={resource.key}
                detailKey={resource.key}
                icon={resource.icon}
                name={resource.title}
                active={active}
                onHover={showToolboxDetail}
                onLeave={scheduleToolboxDetailClose}
                onPick={() => {
                  if (resource.kind === 'skill') {
                    onPickSkill(resource.skill);
                  } else {
                    onPickResource(resource);
                  }
                }}
                detail={
                  <>
                    <div className="plus-menu__detail-title">{resource.title}</div>
                    {resource.subtitle ? (
                      <div className="plus-menu__detail-desc">{resource.subtitle}</div>
                    ) : null}
                    <div className="plus-menu__detail-skill">
                      {designToolboxResourceKindLabel(resource.kind, t)}
                    </div>
                    <div className="plus-menu__detail-badge">
                      {active ? t('chat.designToolbox.selected') : resource.badge}
                    </div>
                  </>
                }
              />
            );
          })}
        </div>
      ) : (
        <div className="plus-menu__empty">
          {t('chat.designToolbox.noResources', { query })}
        </div>
      )}
      {toolboxDetail
        ? createPortal(
            <div
              className="plus-menu__detail"
              style={{ left: toolboxDetail.left, top: toolboxDetail.top }}
              onMouseEnter={cancelDetailClose}
              onMouseLeave={() => scheduleToolboxDetailClose(toolboxDetail.key)}
            >
              {toolboxDetail.node}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// A single toolbox row (single line: icon + name). Clicking applies the entry;
// hovering shows a third-level detail panel (title / description / @skill /
// badge). The detail
// panel is PORTALED to <body> because the parent flyout uses `overflow-y: auto`
// (height-capped scroll) which would otherwise clip a nested panel.
// The hover detail panel is owned by the PARENT
// (DesignToolboxPanel) as ONE shared panel — not per-row — so sweeping across
// rows swaps the single panel in place instead of stacking several portaled
// panels that briefly coexist (the close delay would otherwise leave 2-4 of
// them on screen at once, reading as ghosting). The row just reports hover
// enter/leave with its rect + detail node.
function ToolboxItemRow({
  icon,
  name,
  active,
  detailKey,
  detail,
  onHover,
  onLeave,
  onPick,
}: {
  icon: IconName;
  name: string;
  active?: boolean;
  detailKey: string;
  detail: ReactNode;
  onHover: (key: string, rect: DOMRect, detail: ReactNode) => void;
  onLeave: (key: string) => void;
  onPick: () => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={rowRef}
      className="plus-menu__subitem"
      onMouseEnter={() => {
        const r = rowRef.current?.getBoundingClientRect();
        if (r) onHover(detailKey, r, detail);
      }}
      onMouseLeave={() => onLeave(detailKey)}
    >
      <button
        type="button"
        role="menuitem"
        className={`plus-menu__item${active ? ' is-active' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
      >
        <Icon name={icon} size={14} className="plus-menu__item-icon" />
        <span>{name}</span>
      </button>
    </div>
  );
}




function buildDesignToolboxResources({
  skills,
  mcpServers,
  mcpTemplates,
  projectFiles,
  locale,
  t,
}: DesignToolboxResourceIndex & { locale: Locale; t: TranslateFn }): DesignToolboxResource[] {
  const resources: DesignToolboxResource[] = [];

  for (const skill of skills) {
    const title = localizeSkillName(locale, skill);
    const subtitle = localizeSkillDescription(locale, skill);
    resources.push({
      key: `skill:${skill.id}`,
      kind: 'skill',
      id: skill.id,
      title,
      subtitle,
      badge: designToolboxSkillBadge(skill, t),
      icon: designToolboxSkillIcon(skill),
      searchText: [
        'skill',
        skill.id,
        skill.name,
        title,
        subtitle,
        skill.mode,
        skill.surface ?? '',
        skill.category ?? '',
        ...skill.triggers,
      ].join(' '),
      skill,
    });
  }

  for (const server of mcpServers) {
    const title = server.label || server.id;
    const subtitle = server.command || server.url || server.transport;
    resources.push({
      key: `mcp:${server.id}`,
      kind: 'mcp',
      id: server.id,
      title,
      subtitle,
      badge: 'MCP',
      icon: 'link',
      searchText: [
        'mcp',
        server.id,
        title,
        subtitle,
        server.transport,
        server.templateId ?? '',
      ].join(' '),
      server,
    });
  }

  for (const template of mcpTemplates) {
    resources.push({
      key: `mcp-template:${template.id}`,
      kind: 'mcp-template',
      id: template.id,
      title: template.label,
      subtitle: template.description,
      badge: template.category,
      icon: 'plus',
      searchText: [
        'mcp template',
        template.id,
        template.label,
        template.description,
        template.transport,
        template.category,
        template.homepage ?? '',
        template.example ?? '',
      ].join(' '),
      template,
    });
  }

  const seenFiles = new Set<string>();
  for (const file of projectFiles) {
    if (file.type === 'dir') continue;
    const path = file.path ?? file.name;
    if (!path || seenFiles.has(path)) continue;
    seenFiles.add(path);
    resources.push({
      key: `file:${path}`,
      kind: 'file',
      id: path,
      title: path,
      subtitle: [file.kind, file.mime, file.artifactKind ?? ''].filter(Boolean).join(' · '),
      badge: file.artifactKind ?? file.kind,
      icon: looksLikeImage(path) ? 'image' : 'file',
      searchText: [
        'file',
        'design file',
        path,
        file.name,
        file.kind,
        file.mime,
        file.artifactKind ?? '',
      ].join(' '),
      file,
    });
  }

  return resources;
}

function designToolboxResourceMatchesQuery(
  resource: DesignToolboxResource,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return resource.searchText.toLowerCase().includes(q);
}

function designToolboxDefaultResources(
  actions: DesignToolboxAction[],
  resources: DesignToolboxResource[],
): DesignToolboxResource[] {
  const out: DesignToolboxResource[] = [];
  const seen = new Set<string>();
  function add(resource: DesignToolboxResource | null | undefined) {
    if (!resource || seen.has(resource.key)) return;
    seen.add(resource.key);
    out.push(resource);
  }
  function addByKindId(kind: DesignToolboxResourceKind, id: string) {
    add(resources.find((resource) => resource.kind === kind && resource.id === id));
  }

  // Materials-first defaults, with the upstream design orchestrator kept as a
  // legacy fallback for deployments that still ship the design skill set.
  addByKindId('skill', 'materials-compute');
  addByKindId('skill', 'compute');
  addByKindId('skill', 'creative-director');
  for (const action of actions) {
    const skill = resources.find((resource) =>
      resource.kind === 'skill'
      && action.preferredSkillIds.some((id) => resource.skill.id === id || resource.skill.name === id),
    );
    add(skill);
  }
  for (const term of ['dft', 'molecular dynamics', 'workflow', 'structure', 'analysis', 'materials']) {
    for (const resource of resources) {
      if (out.length >= 8) return out;
      if (resource.kind !== 'skill' && designToolboxResourceMatchesQuery(resource, term)) {
        add(resource);
      }
    }
  }
  return out;
}

function designToolboxResourceKindLabel(
  kind: DesignToolboxResourceKind,
  t: TranslateFn,
): string {
  switch (kind) {
    case 'skill':
      return t('chat.designToolbox.kind.skill');
    case 'mcp':
      return t('chat.designToolbox.kind.mcp');
    case 'mcp-template':
      return t('chat.designToolbox.kind.mcpTemplate');
    case 'file':
      return t('chat.designToolbox.kind.designFile');
  }
}

function designToolboxResourceIsActive(
  resource: DesignToolboxResource,
  active: {
    skillIds: Set<string>;
    mcpServerIds: Set<string>;
    filePaths: Set<string>;
  },
): boolean {
  switch (resource.kind) {
    case 'skill':
      return active.skillIds.has(resource.skill.id);
    case 'mcp':
      return active.mcpServerIds.has(resource.server.id);
    case 'file':
      return active.filePaths.has(resource.file.path ?? resource.file.name);
    case 'mcp-template':
      return false;
  }
}




function designToolboxSkillBadge(skill: SkillSummary, t: TranslateFn): string {
  if (skill.mode === 'video' || skill.category === 'video-generation') return t('chat.designToolbox.badge.video');
  if (skill.mode === 'image' || skill.category === 'image-generation') return t('chat.designToolbox.badge.image');
  if (skill.category === 'animation-motion') return t('chat.designToolbox.badge.motion');
  if (skill.category === 'creative-direction') return t('chat.designToolbox.badge.polish');
  return skill.mode;
}

function designToolboxSkillIcon(skill: SkillSummary): IconName {
  if (skill.mode === 'video' || skill.category === 'video-generation') return 'play';
  if (skill.mode === 'image' || skill.category === 'image-generation') return 'image';
  if (skill.category === 'animation-motion') return 'sliders';
  if (skill.category === 'creative-direction') return 'sparkles';
  return 'file';
}

function designToolboxContextLine(
  workspaceItem: WorkspaceContextItem | null,
  t: TranslateFn,
): string {
  if (!workspaceItem) {
    return t('chat.designToolbox.prompt.contextGeneric');
  }
  const label = workspaceItem.label || workspaceItem.path || workspaceItem.title || workspaceItem.id;
  return t('chat.designToolbox.prompt.contextSpecific', {
    kind: designToolboxWorkspaceKindLabel(workspaceItem.kind, t),
    label,
  });
}

function designToolboxDraftLine(activeDraft: string, t: TranslateFn): string {
  const trimmed = activeDraft.trim();
  if (!trimmed) return '';
  return t('chat.designToolbox.prompt.preserveDraft', { draft: trimmed });
}

function designToolboxWorkspaceKindLabel(
  kind: WorkspaceContextItem['kind'],
  t: TranslateFn,
): string {
  switch (kind) {
    case 'browser':
      return t('chat.designToolbox.context.browser');
    case 'design-files':
      return t('chat.designToolbox.context.designFiles');
    case 'folder':
    case 'project':
    case 'local-code':
      return t('chat.designToolbox.context.folder');
    case 'terminal':
      return t('chat.designToolbox.context.terminal');
    case 'side-chat':
      return t('chat.designToolbox.context.sideChat');
    case 'file':
    default:
      return t('chat.designToolbox.context.file');
  }
}

function designToolboxActionPrompt({
  action,
  skill,
  workspaceItem,
  activeDraft,
  resourceIndex,
  t,
}: {
  action: DesignToolboxAction;
  skill: SkillSummary | null;
  workspaceItem: WorkspaceContextItem | null;
  activeDraft: string;
  resourceIndex: DesignToolboxResourceIndex;
  t: TranslateFn;
}): string {
  const skillLine = skill
    ? t('chat.designToolbox.prompt.selectedSkill', { skill: skill.name })
    : t('chat.designToolbox.prompt.noSkill');
  const resourceLines = designToolboxResourceIndexLines(resourceIndex, t);
  const draftLine = designToolboxDraftLine(activeDraft, t);
  const base = [
    designToolboxContextLine(workspaceItem, t),
    skillLine,
    ...resourceLines,
    draftLine,
  ].filter(Boolean);

  switch (action.id) {
    case 'auto-match':
      return [
        ...base,
        t('chat.designToolbox.prompt.autoMatchIntro'),
        t('chat.designToolbox.prompt.autoMatchStep1'),
        t('chat.designToolbox.prompt.autoMatchStep2'),
        t('chat.designToolbox.prompt.autoMatchStep3'),
        t('chat.designToolbox.prompt.autoMatchStep4'),
      ].join('\n');
    case 'asset-search':
      return [
        ...base,
        t('chat.designToolbox.prompt.assetSearch'),
      ].join('\n');
    case 'icon-workflow':
      return [
        ...base,
        t('chat.designToolbox.prompt.iconWorkflow'),
      ].join('\n');
    case 'image-replace':
      return [
        ...base,
        t('chat.designToolbox.prompt.imageReplace'),
      ].join('\n');
    case 'reference-extract':
      return [
        ...base,
        t('chat.designToolbox.prompt.referenceExtract'),
      ].join('\n');
    case 'motion':
      return [
        ...base,
        t('chat.designToolbox.prompt.motion'),
      ].join('\n');
    case 'motion-polish':
      return [
        ...base,
        t('chat.designToolbox.prompt.motionPolish'),
      ].join('\n');
    case 'transition-motion':
      return [
        ...base,
        t('chat.designToolbox.prompt.transitionMotion'),
      ].join('\n');
    case 'plan-outline':
      return [
        ...base,
        t('chat.designToolbox.prompt.planOutline'),
      ].join('\n');
    case 'threejs-scene':
      return [
        ...base,
        t('chat.designToolbox.prompt.threejsScene'),
      ].join('\n');
    case 'anti-ai-polish':
      return [
        ...base,
        t('chat.designToolbox.prompt.antiAiPolish'),
      ].join('\n');
    case 'visual-polish':
      return [
        ...base,
        t('chat.designToolbox.prompt.visualPolish'),
      ].join('\n');
    case 'image-gen':
      return [
        ...base,
        t('chat.designToolbox.prompt.imageGen'),
      ].join('\n');
    case 'chart-gen':
      return [
        ...base,
        t('chat.designToolbox.prompt.chartGen'),
      ].join('\n');
    case 'logo-gen':
      return [
        ...base,
        t('chat.designToolbox.prompt.logoGen'),
      ].join('\n');
    case 'video-gen':
      return [
        ...base,
        t('chat.designToolbox.prompt.videoGen'),
      ].join('\n');
  }

  return [
    ...base,
    t('chat.designToolbox.prompt.autoMatchIntro'),
  ].join('\n');
}

function designToolboxSkillPrompt({
  skill,
  workspaceItem,
  activeDraft,
  resourceIndex,
  t,
}: {
  skill: SkillSummary;
  workspaceItem: WorkspaceContextItem | null;
  activeDraft: string;
  resourceIndex: DesignToolboxResourceIndex;
  t: TranslateFn;
}): string {
  return [
    designToolboxContextLine(workspaceItem, t),
    t('chat.designToolbox.prompt.useSkill', { skill: skill.name }),
    ...designToolboxResourceIndexLines(resourceIndex, t),
    designToolboxDraftLine(activeDraft, t),
    t('chat.designToolbox.prompt.skillInstruction'),
  ].filter(Boolean).join('\n');
}

function designToolboxResourcePrompt({
  resource,
  workspaceItem,
  activeDraft,
  resourceIndex,
  t,
}: {
  resource: Exclude<DesignToolboxResource, { kind: 'skill' }>;
  workspaceItem: WorkspaceContextItem | null;
  activeDraft: string;
  resourceIndex: DesignToolboxResourceIndex;
  t: TranslateFn;
}): string {
  const base = [
    designToolboxContextLine(workspaceItem, t),
    t('chat.designToolbox.prompt.selectedResource', {
      kind: designToolboxResourceKindLabel(resource.kind, t),
      title: resource.title,
      id: resource.id,
    }),
    resource.subtitle ? t('chat.designToolbox.prompt.resourceDescription', { description: resource.subtitle }) : '',
    ...designToolboxResourceIndexLines(resourceIndex, t),
    designToolboxDraftLine(activeDraft, t),
  ].filter(Boolean);

  switch (resource.kind) {
    case 'mcp':
      return [
        ...base,
        t('chat.designToolbox.prompt.mcpResource'),
      ].join('\n');
    case 'mcp-template':
      return [
        ...base,
        t('chat.designToolbox.prompt.mcpTemplateResource'),
      ].join('\n');
    case 'file':
      return [
        ...base,
        t('chat.designToolbox.prompt.fileResource'),
      ].join('\n');
  }
}

function designToolboxResourceIndexLines(
  index: DesignToolboxResourceIndex,
  t: TranslateFn,
): string[] {
  const files = index.projectFiles
    .filter((file) => file.type !== 'dir')
    .map((file) => file.path ?? file.name);
  return [
    designToolboxCompactLine(t('chat.designToolbox.prompt.searchableSkills'), index.skills.map((skill) => skill.name), 60, t),
    designToolboxCompactLine(t('chat.designToolbox.prompt.availableMcp'), [
      ...index.mcpServers.map((server) => server.label || server.id),
      ...index.mcpTemplates.map((template) => t('chat.designToolbox.prompt.mcpTemplateName', { name: template.label })),
    ], 40, t),
    designToolboxCompactLine(t('chat.designToolbox.prompt.referenceDesignFiles'), files, 40, t),
    t('chat.designToolbox.prompt.processRule'),
  ].filter(Boolean);
}

function designToolboxCompactLine(
  label: string,
  values: string[],
  limit: number,
  t: TranslateFn,
): string {
  const clean = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  if (clean.length === 0) return '';
  const shown = clean.slice(0, limit);
  const suffix = clean.length > shown.length
    ? t('chat.designToolbox.prompt.moreSuffix', { count: clean.length - shown.length })
    : '';
  return t('chat.designToolbox.prompt.compactLine', {
    label,
    values: shown.join(', '),
    suffix,
  });
}

function skillMentionRank(skill: SkillSummary, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const id = skill.id.toLowerCase();
  const name = skill.name.toLowerCase();
  if (id.startsWith(q) || name.startsWith(q)) return 0;
  return 1;
}



function SlashPopover({
  commands,
  activeIndex,
  onPick,
  onHover,
  t,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
  t: TranslateFn;
}) {
  return (
    <div
      className="slash-popover"
      data-testid="slash-popover"
      role="listbox"
      aria-label={t('pet.slashPopoverAria')}
    >
      <div className="slash-popover-head">
        <span>{t('pet.slashPopoverTitle')}</span>
        <span className="slash-popover-hint">{t('pet.slashPopoverHint')}</span>
      </div>
      {commands.map((cmd, idx) => {
        const active = idx === activeIndex;
        return (
          <button
            key={cmd.id}
            id={`slash-opt-${idx}`}
            type="button"
            role="option"
            aria-selected={active}
            className={`slash-item${active ? ' active' : ''}`}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before the click
              // handler fires — otherwise selectionStart resets and the
              // pick replacement targets the wrong substring.
              e.preventDefault();
            }}
            onMouseEnter={() => onHover(idx)}
            onClick={() => onPick(cmd)}
          >
            <span className="slash-item-icon" aria-hidden>
              <Icon name={cmd.icon} size={13} />
            </span>
            <span className="slash-item-body">
              <span className="slash-item-row">
                <code className="slash-item-label">{cmd.label}</code>
                {cmd.argHint ? (
                  <span className="slash-item-arg">{cmd.argHint}</span>
                ) : null}
              </span>
              <span className="slash-item-desc">
                {cmd.descKey ? t(cmd.descKey) : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MentionPopover({
  members,
  files,
  workspaceContexts,
  skills,
  mcpServers,
  query,
  tab,
  onTabChange,
  activeIndex,
  currentSkillId,
  onPickMember,
  onPickFile,
  onPickWorkspaceContext,
  onPickSkill,
  onPickMcp,
}: {
  members: ReadonlyArray<{ ref: string; id: string; name: string; description?: string | null }>;
  files: ProjectFile[];
  workspaceContexts: WorkspaceContextItem[];
  skills: SkillSummary[];
  mcpServers: McpServerConfig[];
  query: string;
  tab: MentionTab;
  onTabChange: (tab: MentionTab) => void;
  activeIndex: number;
  currentSkillId: string | null;
  onPickMember: (member: { ref: string; id: string; name: string }) => void;
  onPickFile: (path: string) => void;
  onPickWorkspaceContext: (item: WorkspaceContextItem) => void;
  onPickSkill: (skill: SkillSummary) => void;
  onPickMcp: (server: McpServerConfig) => void;
}) {
  const { locale, t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const hasMembers = members.length > 0;
  const tabs: Array<{ id: MentionTab; label: string }> = [
    { id: 'all', label: t('chat.mentionTabAll') },
    // Members tab only exists in a group chat (roster non-empty).
    ...(hasMembers ? [{ id: 'members' as MentionTab, label: t('chat.mentionTabMembers') }] : []),
    { id: 'files', label: t('chat.mentionTabFiles') },
    { id: 'tabs', label: t('chat.mentionTabTabs') },
    { id: 'skills', label: t('chat.mentionTabSkills') },
    { id: 'mcp', label: t('chat.mentionTabMcp') },
  ];
  const showMembers = tab === 'all' || tab === 'members';
  const showTabs = tab === 'all' || tab === 'tabs';
  const showFiles = tab === 'all' || tab === 'files';
  const showSkills = tab === 'all' || tab === 'skills';
  const showMcp = tab === 'all' || tab === 'mcp';
  const hasVisibleResults =
    (showMembers && members.length > 0) ||
    (showFiles && files.length > 0) ||
    (showTabs && workspaceContexts.length > 0) ||
    (showSkills && skills.length > 0) ||
    (showMcp && mcpServers.length > 0);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [files, members, skills, mcpServers, tab, workspaceContexts]);
  let optionIndex = 0;
  return (
    <div className="mention-popover" data-testid="mention-popover">
      <div className="mention-tabs" role="tablist" aria-label={t('chat.mentionTabsAria')}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`mention-tab${tab === item.id ? ' active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onTabChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="mention-results" ref={ref} role="listbox" id="mention-listbox">
        {!hasVisibleResults ? (
          <div className="mention-empty">
            {query ? (
              <>{t('chat.mentionNoResults', { query })}</>
            ) : (
              <>{t('chat.mentionSearchPrompt')}</>
            )}
          </div>
        ) : null}
        {showMembers && members.length > 0 ? (
          <>
            <div className="mention-section-label">{t('chat.mentionSectionMembers')}</div>
            {members.map((member) => {
              const flat = optionIndex;
              optionIndex += 1;
              const active = flat === activeIndex;
              return (
                <button
                  key={`member-${member.ref}`}
                  id={`mention-opt-${flat}`}
                  role="option"
                  aria-selected={active}
                  className={`mention-item mention-item--member${active ? ' is-active' : ''}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPickMember(member)}
                  title={member.description ?? member.ref}
                >
                  <span className="mention-member-avatar" aria-hidden>
                    {(member.name || member.id).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="mention-item-body">
                    <strong>{member.name}</strong>
                    <span className="mention-meta mention-meta--desc">
                      {member.description?.trim() || member.ref}
                    </span>
                  </span>
                  <span className="mention-meta mention-item-kind">
                    {t('chat.mentionMemberKind')}
                  </span>
                </button>
              );
            })}
          </>
        ) : null}
        {showFiles && files.length > 0 ? (
          <>
            <div className="mention-section-label">{t('chat.mentionSectionFiles')}</div>
            {files.map((f) => {
              const key = f.path ?? f.name;
              const flat = optionIndex;
              optionIndex += 1;
              const active = flat === activeIndex;
              return (
                <button
                  key={`file-${key}`}
                  id={`mention-opt-${flat}`}
                  role="option"
                  aria-selected={active}
                  className={`mention-item${active ? ' is-active' : ''}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPickFile(key)}
                >
                  <Icon name="file" size={12} />
                  <span className="mention-item-body">
                    <strong>{projectFileMentionTitle(f, key)}</strong>
                    <span className="mention-meta mention-meta--desc mention-meta--path">
                      {projectFileMentionDescription(f, key)}
                    </span>
                  </span>
                  {f.size != null ? (
                    <span className="mention-meta mention-item-kind">{prettySize(f.size)}</span>
                  ) : null}
                </button>
              );
            })}
          </>
        ) : null}
        {showTabs && workspaceContexts.length > 0 ? (
          <>
            <div className="mention-section-label">{t('chat.mentionSectionTabs')}</div>
            {workspaceContexts.map((item) => {
              const flat = optionIndex;
              optionIndex += 1;
              const active = flat === activeIndex;
              return (
                <button
                  key={`workspace-${item.kind}-${item.id}`}
                  id={`mention-opt-${flat}`}
                  role="option"
                  aria-selected={active}
                  className={`mention-item mention-item--workspace${active ? ' is-active' : ''}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPickWorkspaceContext(item)}
                  title={workspaceContextTitle(item)}
                >
                  <Icon name={workspaceContextIcon(item)} size={12} />
                  <span className="mention-item-body">
                    <strong>{item.label}</strong>
                    <span className="mention-meta mention-meta--desc">
                      {workspaceContextDescription(item)}
                    </span>
                  </span>
                  <span className="mention-meta mention-item-kind">{workspaceContextKindLabel(item.kind)}</span>
                </button>
              );
            })}
          </>
        ) : null}
        {showSkills && skills.length > 0 ? (
          <>
            <div className="mention-section-label">{t('chat.mentionSectionSkills')}</div>
            {skills.map((skill) => {
              const flat = optionIndex;
              optionIndex += 1;
              const rowActive = flat === activeIndex;
              const isCurrent = skill.id === currentSkillId;
              return (
                <button
                  key={`skill-${skill.id}`}
                  id={`mention-opt-${flat}`}
                  role="option"
                  aria-selected={rowActive}
                  className={`mention-item${rowActive ? ' is-active' : ''}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPickSkill(skill)}
                  title={localizeSkillDescription(locale, skill)}
                >
                  <Icon name={isCurrent ? 'check' : 'file'} size={12} />
                  <span className="mention-item-body">
                    <strong>{localizeSkillName(locale, skill)}</strong>
                    <span className="mention-meta mention-meta--desc">
                      {localizeSkillDescription(locale, skill) || skill.id}
                    </span>
                  </span>
                  <span className="mention-meta mention-item-kind">{isCurrent ? t('chat.mentionActiveSkill') : skill.mode}</span>
                </button>
              );
            })}
          </>
        ) : null}
        {showMcp && mcpServers.length > 0 ? (
          <>
            <div className="mention-section-label">{t('chat.mentionSectionMcp')}</div>
            {mcpServers.map((server) => {
              const flat = optionIndex;
              optionIndex += 1;
              const active = flat === activeIndex;
              return (
                <button
                  key={`mcp-${server.id}`}
                  id={`mention-opt-${flat}`}
                  role="option"
                  aria-selected={active}
                  className={`mention-item${active ? ' is-active' : ''}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPickMcp(server)}
                  title={t('chat.mentionUseMcpTitle', { name: server.label || server.id })}
                >
                  <Icon name="link" size={12} />
                  <span className="mention-item-body">
                    <strong>{server.label || server.id}</strong>
                    <span className="mention-meta mention-meta--desc">
                      {server.url || server.command || server.id}
                    </span>
                  </span>
                  <span className="mention-meta mention-item-kind">{server.transport}</span>
                </button>
              );
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripInlineMentionToken(text: string, label: string): string {
  const token = inlineMentionToken(label);
  return text.replace(
    new RegExp(`(^|[\\s([{"'])${escapeRegExp(token)}(?=$|\\s|[.,;:!?)}\\]"'])([^\\S\\r\\n])?`, 'g'),
    '$1',
  );
}

function stripInlineMentionLabels(text: string, labels: string[]): string {
  const uniqueLabels = Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean)));
  return uniqueLabels.reduce(
    (current, label) => stripInlineMentionToken(current, label),
    text,
  );
}

function loadComposerDraft(key?: string): string | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveComposerDraft(key: string | undefined, draft: string) {
  if (!key || typeof window === 'undefined') return;
  try {
    if (draft) {
      window.localStorage.setItem(key, draft);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in privacy modes; the composer should still work.
  }
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
