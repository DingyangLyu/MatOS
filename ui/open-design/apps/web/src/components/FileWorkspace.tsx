import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import { Button } from '@open-design/components';
import { useT } from '../i18n';
import { isMacPlatform } from '../utils/platform';
import {
  deleteProjectFile,
  fetchProjectFileText,
  fetchProjectFileMetadata,
  fetchProjectFiles,
  fetchProjectFolders,
  createProjectFolder,
  deleteProjectFolder,
  renameProjectFile,
  renameProjectFolder,
  type UploadProjectFilesResult,
  uploadProjectFiles,
  writeProjectBase64File,
  writeProjectTextFile,
} from '../providers/registry';
import type { Dict } from '../i18n/types';
import { deriveFileOps, type FileOpEntry } from '../runtime/file-ops';
import { latestTodosFromEvents, type TodoItem } from '../runtime/todos';
import { deliverableSlideNavForActiveFile, isSlideNavDeliverableNow } from '../runtime/slide-nav';
import {
  type AgentInfo,
  type AppConfig,
  type ChatCommentAttachment,
  type Conversation,
  conversationIdFromSideChatTabId,
  isSideChatTabId,
  isTerminalTabId,
  isMatterVizTabId,
  matterVizTabId,
  terminalIdFromTabId,
  type OpenTabsState,
  type PreviewComment,
  type PreviewCommentTarget,
  type ProjectFile,
  type ProjectFolder,
} from '../types';
import type { ChatSessionMode, WorkspaceContextItem } from '@open-design/contracts';
import { createTerminal, killTerminal } from '../state/projects';
import type { QuestionForm } from '../artifacts/question-form';
import { DesignFilesPanel, type DesignFilesNavState } from './DesignFilesPanel';
import type { ProjectFilePaging } from '../runtime/use-project-file-pages';
import { loadDesignFilesNavState, saveDesignFilesNavState } from '../state/designFilesNav';
import { APP_CHROME_FILE_ACTIONS_ID } from './AppChromeHeader';
import { FileViewer } from './FileViewer';
import { Icon, type IconName } from './Icon';
import { Toast } from './Toast';
import { TabLauncherMenu } from './workspace/TabLauncherMenu';
import { buildLauncherActions, type LauncherContext } from './workspace/tab-launcher';
import { SideChatTab, type ActiveConversationChatState } from './workspace/SideChatTab';
import { TerminalViewer } from './workspace/TerminalViewer';
import { MaterialsViewerTab } from './MaterialsViewerTab';
import { QuestionsPanel } from './QuestionsPanel';
import { PlanCanvasPanel, type PlanCanvasDoc } from './PlanCanvasPanel';
import { ProjectSearchPanel } from './ProjectSearchPanel';
import { QuickSwitcher } from './QuickSwitcher';
import { WorkflowEditor } from './WorkflowEditor';
import {
  emptyWorkflowDefinition,
  isWorkflowFileName,
  serializeWorkflowDocument,
} from './workflow-model';
import { AnimatePresence } from 'motion/react';
import type { ChatMessage } from '../types';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

type FileWorkspaceProjectKind =
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

interface Props {
  projectId: string;
  projectKind: FileWorkspaceProjectKind;
  // Basename of the project's chosen working directory (e.g. "openclaw").
  // Threaded to DesignFilesPanel as the breadcrumb root label. Undefined for
  // default-storage projects.
  rootDirName?: string;
  // True while a working-dir replace is reindexing; shows a loading state.
  reloading?: boolean;
  /** Absolute on-disk project directory (from GET /api/projects/:id). Used by
   * the Design Files panel's "copy absolute path" action. */
  resolvedDir?: string | null;
  files: ProjectFile[];
  filePaging?: ProjectFilePaging;
  filesRefreshKey?: number;
  onRefreshFiles: () => Promise<void> | void;
  isDeck: boolean;
  streaming?: boolean;
  commentQueueOnSend?: boolean;
  commentSendDisabled?: boolean;
  openRequest?: { name: string; nonce: number } | null;
  // Open the named file AND surface its Share/Export menu. Drives the chat-side
  // Open the named file AND surface its Download/Export menu. Drives the
  // chat-side "Download" next-step action.
  downloadRequest?: { name: string; nonce: number } | null;
  // Flip a deck preview to a given slide when a queued chat send starts. Mirrors
  // FileViewer consumes the nonce to navigate.
  slideNavRequest?: { name: string; slideIndex: number; nonce: number } | null;
  // Persisted set of open tabs + active tab. Owned by ProjectView so the
  // daemon's SQLite store can hold the source of truth and survive reloads.
  tabsState: OpenTabsState;
  onTabsStateChange: (next: OpenTabsState) => void;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[]) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[], images?: File[]) => Promise<boolean | void> | boolean | void;
  preferredPreviewFile?: string | null;
  autoPreviewDesignArtifacts?: boolean;
  focusMode?: boolean;
  onFocusModeChange?: (next: boolean) => void;
  onDuplicateProject?: () => void;
  duplicateProjectBusy?: boolean;
  commentPortalId?: string;
  onCommentModeChange?: (active: boolean) => void;
  // Side Chat (`chat:<conversationId>` tab) wiring. Threaded from ProjectView
  // so a secondary ChatPane can render an already-open conversation tab without
  // FileWorkspace owning any chat state. All optional: a workspace mounted
  // without these simply does not render restored side-chat tabs. There is no
  // launcher affordance to create new side chats — only persisted `chat:` tabs
  // are restored.
  chatConfig?: AppConfig;
  chatAgentsById?: Map<string, AgentInfo>;
  chatLocale?: string;
  projectMemberRefs?: readonly string[];
  projectMatosRoleRef?: string | null;
  renderMatosRolePicker?: (conversationId: string) => ReactNode;
  conversations?: Conversation[];
  /** The primary chat's active conversation. */
  activeConversationId?: string | null;
  onSelectConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void;
  onRenameConversation?: (id: string, title: string) => void;
  onConversationSessionModeChange?: (id: string, mode: ChatSessionMode) => void;
  onNewConversation?: () => void;
  activeConversationChat?: ActiveConversationChatState;
  onActiveContextChange?: (context: WorkspaceContextItem | null) => void;
  onWorkspaceContextsChange?: (contexts: WorkspaceContextItem[]) => void;
  messages?: ChatMessage[];
  artifactHtml?: string | null;
  conversationError?: string | null;
  onRetry?: (message: ChatMessage) => void;
  // Conversation id for the AMR promotion card.
  conversationId?: string | null;
  // Project-level actions (settings, handoff, avatar menu) rendered at the
  // right end of the Design Files tab row. The former standalone chrome header
  // row was removed; these moved here alongside the FileViewer present/Share
  // portal that targets the same actions container.
  headerActions?: ReactNode;
  // Active discovery question form, surfaced in the right-hand Questions tab
  // instead of inline in the chat. Owned by ProjectView (derived from the
  // latest assistant message).
  questionForm?: QuestionForm | null;
  // Tolerantly-parsed form shown while the block is still streaming, so the
  // panel renders a frame and fills questions in progressively.
  questionFormPreview?: QuestionForm | null;
  // Stable per-occurrence id so the panel can remember a completed reveal
  // across the streaming→persisted remount instead of re-animating.
  questionFormKey?: string | null;
  questionFormInteractive?: boolean;
  // The turn is busy (streaming/queued) — keep Continue/Skip disabled while the
  // form itself stays editable.
  questionFormSubmitDisabled?: boolean;
  questionFormSubmittedAnswers?: Record<string, string | string[]>;
  questionsGenerating?: boolean;
  onSubmitQuestionForm?: (text: string) => void;
  // Bumped nonce that focuses the Questions tab (banner click / new form).
  focusQuestionsRequest?: { nonce: number } | null;
  // MatOS plan canvas: the active conversation's latest plan-mode answer,
  // rendered as a document in the right-hand Plan tab (the CLI plan-mode
  // "review the plan" step, projected onto the workspace). Owned by
  // ProjectView; null hides the tab.
  planDoc?: PlanCanvasDoc | null;
  // Bumped nonce that focuses the Plan tab (a plan-mode run started).
  focusPlanRequest?: { nonce: number } | null;
  // "Approve & execute": switch the conversation to execute mode and send
  // the implementation turn. Disabled while a run is streaming.
  onApprovePlan?: () => void;
  planApproveDisabled?: boolean;
  // "Refine the plan": focus the composer so the user can talk the plan over.
  onRefinePlan?: () => void;
}

export const DESIGN_FILES_TAB = '__design_files__';
const QUESTIONS_TAB = '__questions__';
// MatOS plan canvas tab — transient like Questions: shown while the active
// conversation has a plan-mode answer to review, never persisted.
const PLAN_TAB = '__plan__';
const QUICK_SWITCHER_DOCUMENT_CLASS = 'od-quick-switcher-open';

// Stable empty folder list so the render-phase project-switch reset is
// idempotent (passing a fresh `[]` each render would re-trigger the reset).
const EMPTY_PROJECT_FOLDERS: ProjectFolder[] = [];
type TabDropEdge = 'before' | 'after';
function consumeFileWorkspaceTabShortcut(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function joinDisplayPath(root: string, child: string): string {
  const cleanRoot = root.replace(/[\\/]+$/u, '');
  const cleanChild = child.replace(/^[\\/]+/u, '');
  return cleanChild ? `${cleanRoot}/${cleanChild}` : cleanRoot;
}

export function FileWorkspace({
  projectId,
  projectKind,
  rootDirName,
  reloading,
  resolvedDir,
  files,
  filePaging,
  filesRefreshKey = 0,
  onRefreshFiles,
  isDeck,
  streaming,
  commentQueueOnSend = false,
  commentSendDisabled = false,
  openRequest,
  downloadRequest,
  slideNavRequest,
  tabsState,
  onTabsStateChange,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  preferredPreviewFile = null,
  autoPreviewDesignArtifacts = false,
  focusMode = false,
  onFocusModeChange,
  onDuplicateProject,
  duplicateProjectBusy = false,
  commentPortalId,
  onCommentModeChange,
  chatConfig,
  chatAgentsById,
  chatLocale,
  projectMemberRefs = [],
  projectMatosRoleRef = null,
  renderMatosRolePicker,
  conversations = [],
  activeConversationId = null,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onConversationSessionModeChange,
  onNewConversation,
  activeConversationChat,
  onActiveContextChange,
  onWorkspaceContextsChange,
  messages = [],
  conversationId,
  headerActions,
  questionForm = null,
  questionFormPreview = null,
  questionFormKey = null,
  questionFormInteractive = false,
  questionFormSubmitDisabled = false,
  questionFormSubmittedAnswers,
  questionsGenerating = false,
  onSubmitQuestionForm,
  focusQuestionsRequest = null,
  planDoc = null,
  focusPlanRequest = null,
  onApprovePlan,
  planApproveDisabled = false,
  onRefinePlan,
}: Props) {
  const t = useT();
  // The chat column only shows a compact Questions banner; the form itself
  // lives here, including after submission when a banner click can reopen the
  // answered preview.
  const showQuestionsTab = Boolean(questionForm || questionFormPreview || questionsGenerating);
  // Plan canvas mirrors the Questions pattern: a transient right-hand tab that
  // exists only while the active conversation has a plan to review.
  const showPlanTab = Boolean(planDoc);
  const defaultRootTab = DESIGN_FILES_TAB;
  // Persisted tabs come from the parent.
  const persistedTabs = tabsState.tabs;
  // Launcher "create" actions (New Terminal / Side Chat) resolve
  // asynchronously; keep the latest committed tab state out of render
  // closures so opening the new tab appends to the freshest list instead of
  // replaying a stale closure and dropping tabs added in the meantime.
  const tabsStateRef = useRef(tabsState);
  const lastTabsStatePropRef = useRef(tabsState);
  if (lastTabsStatePropRef.current !== tabsState) {
    tabsStateRef.current = tabsState;
    lastTabsStatePropRef.current = tabsState;
  }
  const [activeTab, setActiveTab] = useState<string>(
    tabsState.active ?? defaultRootTab,
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The folder the Design Files panel is currently viewing (synced via
  // onCurrentDirChange). New files — uploads, pastes, dropped files —
  // are created under this folder instead of the project root.
  const [uploadDir, setUploadDir] = useState<string>('');
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [contentSearchOpen, setContentSearchOpen] = useState(false);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>(EMPTY_PROJECT_FOLDERS);
  // Reset the folder list during render — NOT in an effect — when the project
  // changes. DesignFilesPanel is keyed by `projectId`, so an effect-based reset
  // would let the new panel mount once with the previous project's folders and
  // briefly suppress the new project's empty state (the exact regression this
  // fix removes). Adjusting state during render discards this render before the
  // child commits, so the new panel never sees stale folders. Mirrors the
  // designFilesNav ref reset above. The stable empty constant keeps this
  // idempotent (no re-entrant render loop).
  const projectFoldersProjectIdRef = useRef(projectId);
  if (projectFoldersProjectIdRef.current !== projectId) {
    projectFoldersProjectIdRef.current = projectId;
    setProjectFolders(EMPTY_PROJECT_FOLDERS);
  }
  // "+" launcher (file search + registry-driven create-new actions:
  // Side Chat, Terminal).
  const [launcherOpen, setLauncherOpen] = useState(false);
  // Transient feedback when a launcher "create" action (e.g. New Terminal)
  // fails on the daemon side, so the click is never a silent no-op.
  const [launcherToast, setLauncherToast] = useState<string | null>(null);
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const [draggedTabName, setDraggedTabName] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<{
    name: string;
    edge: TabDropEdge;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const launcherBtnRef = useRef<HTMLButtonElement | null>(null);
  const tabsBarRef = useRef<HTMLDivElement | null>(null);
  const draggedTabNameRef = useRef<string | null>(null);
  const matterVizSequenceRef = useRef(0);
  const openFileRef = useRef<(name: string) => void>(() => {});
  // File-manager navigation memory: hydrated from the per-project cache so a
  // remount (tab switch, Home-and-back, reload) restores the user's place, and
  // written through on every change. Lazily loaded — reading localStorage on
  // every render of this component would be wasteful.
  const designFilesNavProjectIdRef = useRef(projectId);
  const designFilesNavRef = useRef<DesignFilesNavState | null>(null);
  if (designFilesNavRef.current === null || designFilesNavProjectIdRef.current !== projectId) {
    designFilesNavProjectIdRef.current = projectId;
    designFilesNavRef.current = loadDesignFilesNavState(projectId);
  }
  const onDesignFilesNavStateChange = useCallback((state: DesignFilesNavState) => {
    designFilesNavRef.current = state;
    saveDesignFilesNavState(designFilesNavProjectIdRef.current, state);
  }, []);

  // Maps a terminal tab's original session id (the `terminal:<id>` suffix) to
  // the PTY session it is CURRENTLY bound to. Restart rebinds the surface to a
  // fresh session while the tab id stays constant, and the surface is unmounted
  // whenever its tab isn't active — so this ref (which survives the child's
  // unmount) is the only place that knows which PTY to kill on an explicit
  // Close. `<TerminalViewer onSessionIdChange>` keeps it current.
  const terminalLiveSessionsRef = useRef<Map<string, string>>(new Map());
  const handleTerminalSessionChange = useCallback(
    (originalId: string, sessionId: string) => {
      terminalLiveSessionsRef.current.set(originalId, sessionId);
    },
    [],
  );

  const [lookedUpFile, setLookedUpFile] = useState<{ projectId: string; name: string; file: ProjectFile | null } | null>(null);
  const visibleFiles = useMemo(() => {
    const visible = files;
    if (lookedUpFile?.projectId === projectId && lookedUpFile.name === activeTab && lookedUpFile.file
      && !visible.some(file => file.name === activeTab)) {
      return [...visible, lookedUpFile.file];
    }
    return visible;
  }, [files, lookedUpFile, projectId, activeTab]);

  const refreshProjectFolders = useCallback(async (): Promise<ProjectFolder[]> => {
    const next = await fetchProjectFolders(projectId);
    setProjectFolders(next);
    return next;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    // The synchronous clear happens during render (see projectFoldersProjectIdRef
    // above); here we only fetch the new project's folders.
    void fetchProjectFolders(projectId).then((next) => {
      if (!cancelled) setProjectFolders(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // True when the Design Files tab has nothing to attach: no files and no
  // folders. Mirrors DesignFilesPanel's own empty-state gate so the "Design
  // files" composer context and the empty placeholder agree on when the tab is
  // actually empty. Reused below to suppress the auto-attached workspace
  // context for a brand-new/empty project.
  const designFilesTabIsEmpty =
    visibleFiles.length === 0
    && projectFolders.length === 0;

  // Pull the persisted active tab in when the parent's hydration completes
  // (or on project switch). Fall back to the Design Files browser so a
  // fresh project lands in a useful place.
  useEffect(() => {
    setActiveTab(tabsState.active ?? defaultRootTab);
  }, [tabsState.active, defaultRootTab]);

  useEffect(() => {
    setLauncherOpen(false);
  }, [projectId]);

  function workspaceTabsState(
    tabs: string[],
    active: string | null,
  ): OpenTabsState {
    return { tabs, active };
  }

  // Single entry point for committing tab state: mirror it into the ref so
  // async launcher actions read the freshest tabs, then notify the parent.
  function commitTabsState(next: OpenTabsState) {
    tabsStateRef.current = next;
    onTabsStateChange(next);
  }

  function setPersistedActive(name: string | null) {
    const nextActive = name ?? defaultRootTab;
    setActiveTab(nextActive);
    commitTabsState(workspaceTabsState(persistedTabs, name));
  }

  // When the persisted tab list changes and the active tab is gone, fall
  // back to the last remaining tab. Skip transient activeTab values
  // (DESIGN_FILES_TAB) since those aren't in persistedTabs.
  useEffect(() => {
    if (
      activeTab === DESIGN_FILES_TAB
      || activeTab === QUESTIONS_TAB
      || activeTab === PLAN_TAB

    ) return;
    if (!persistedTabs.includes(activeTab)) {
      setPersistedActive(persistedTabs[persistedTabs.length - 1] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedTabs, activeTab]);

  // External open requests from chat (tool cards, produced-file chips,
  // deep-linked URL, or the parent's auto-open after an agent Write) —
  // add the file to the open-tabs set and focus it.
  useEffect(() => {
    if (!openRequest) return;
    const name = openRequest.name;
    if (!name) return;
    if (name === DESIGN_FILES_TAB) {
      onTabsStateChange(workspaceTabsState(persistedTabs, name));
      setActiveTab(name);
      return;
    }
    onTabsStateChange(workspaceTabsState(
      persistedTabs.includes(name) ? persistedTabs : [...persistedTabs, name],
      name,
    ));
    setActiveTab(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  // Download request: ensure the target file is open + active so the FileViewer
  // below opens its
  // Download/Export menu. Without this, Download did nothing whenever the target
  // artifact was not already the active tab (it forwards only on a name match).
  useEffect(() => {
    if (!downloadRequest) return;
    const name = downloadRequest.name;
    if (!name) return;
    commitTabsState(workspaceTabsState(
      persistedTabs.includes(name) ? persistedTabs : [...persistedTabs, name],
      name,
    ));
    setActiveTab(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadRequest]);

  // Slide-nav request: decide deliverability once, at fire time. Only if the
  // named deck is already an open tab do we mark this nonce deliverable and
  // bring it forward so the matching FileViewer is mounted and flips. We never
  // open a closed file — auto-flipping is a follow-along, not a reason to yank
  // the user into a tab they never opened. Recording the deliverable nonce in
  // state (not a ref) also means a request for a closed deck stays undeliverable
  // forever: opening that file later matches the name but not the nonce, so the
  // stale request can't resurface and jump the preview.
  const [slideNavDeliverableNonce, setSlideNavDeliverableNonce] = useState<number | null>(null);
  useEffect(() => {
    if (!isSlideNavDeliverableNow(slideNavRequest, persistedTabs)) return;
    setSlideNavDeliverableNonce(slideNavRequest!.nonce);
    setActiveTab(slideNavRequest!.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideNavRequest]);

  // Focus the Questions tab when the parent bumps the nonce (banner click in
  // chat, or a freshly generated form). The tab is transient — not added to
  // the persisted tab list.
  useEffect(() => {
    if (!focusQuestionsRequest) return;
    setActiveTab(QUESTIONS_TAB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusQuestionsRequest?.nonce]);

  // Focus the Plan tab when the parent bumps the nonce (a plan-mode run
  // started streaming, or the chat's "view plan" affordance was clicked).
  useEffect(() => {
    if (!focusPlanRequest) return;
    setActiveTab(PLAN_TAB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPlanRequest?.nonce]);

  // If the Plan tab is active but the plan is gone (conversation switched or
  // cleared), fall back to the default root tab.
  useEffect(() => {
    if (activeTab === PLAN_TAB && !showPlanTab) {
      setActiveTab(defaultRootTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, showPlanTab]);

  // Submitting from the right-hand panel should close the preview once. The
  // answered form remains available, so a later chat-banner click can reopen
  // the same Questions tab without this effect immediately closing it again.
  const previousQuestionFormSubmittedAnswersRef = useRef(questionFormSubmittedAnswers);
  useEffect(() => {
    const wasAnswered = previousQuestionFormSubmittedAnswersRef.current !== undefined;
    const isAnswered = questionFormSubmittedAnswers !== undefined;
    previousQuestionFormSubmittedAnswersRef.current = questionFormSubmittedAnswers;
    if (activeTab === QUESTIONS_TAB && !wasAnswered && isAnswered) {
      setActiveTab(defaultRootTab);
    }
  }, [activeTab, defaultRootTab, questionFormSubmittedAnswers]);

  // If the Questions tab is active but the form is gone because a new assistant
  // turn has no form, fall back to the default root tab.
  useEffect(() => {
    if (activeTab === QUESTIONS_TAB && !showQuestionsTab) {
      setActiveTab(defaultRootTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, showQuestionsTab]);

  function openFile(name: string) {
    setUploadError(null);
    // Read from the ref, not the `persistedTabs` prop closure: this path is
    // reached asynchronously from launcher "create" actions (after the daemon
    // resolves a new terminal/side-chat id), so the closure could be stale and
    // clobber tabs added in the meantime.
    const currentTabs = tabsStateRef.current.tabs;
    const nextTabs = currentTabs.includes(name) ? currentTabs : [...currentTabs, name];
    commitTabsState(workspaceTabsState(nextTabs, name));
    setActiveTab(name);
  }
  openFileRef.current = openFile;

  // Open a MatterViz materials-visualization tab. Like terminal / side-chat
  // tabs, it lives in `persistedTabs` as a prefixed id (`matterviz:<n>`) so it
  // drags, closes, and restores like any other workspace tab; the id carries no
  // file binding — the tab picks its structure file in its own state. The `<n>`
  // sequence keeps multiple viewers distinct.
  function openMaterialsViewer() {
    setUploadError(null);
    // Derive the next index from both the in-memory sequence AND any restored
    // `matterviz:<n>` tabs, so a viewer opened after a reload never collides
    // with a persisted one (which would silently re-focus it instead of
    // creating a new tab).
    const existingMax = tabsStateRef.current.tabs.reduce((max, tabName) => {
      if (!isMatterVizTabId(tabName)) return max;
      const n = Number(tabName.slice('matterviz:'.length));
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    const nextIndex = Math.max(matterVizSequenceRef.current, existingMax) + 1;
    matterVizSequenceRef.current = nextIndex;
    openFile(matterVizTabId(nextIndex));
  }

  function focusWorkspaceTab(tabId: string) {
    setUploadError(null);
    if (tabId === DESIGN_FILES_TAB) {
      setPersistedActive(DESIGN_FILES_TAB);
      return;
    }
    openFile(tabId);
  }

  function activateWorkspaceTab(tabId: string) {
    if (tabId === QUESTIONS_TAB || tabId === PLAN_TAB) {
      setUploadError(null);
      setActiveTab(tabId);
      return;
    }
    focusWorkspaceTab(tabId);
  }

  function activateWorkspaceTabByOffset(offset: number) {
    if (workspaceTabIds.length === 0) return;
    const activeIndex = workspaceTabIds.indexOf(activeTab);
    const startIndex = activeIndex >= 0 ? activeIndex : 0;
    const targetIndex =
      (startIndex + offset + workspaceTabIds.length) % workspaceTabIds.length;
    activateWorkspaceTab(workspaceTabIds[targetIndex]!);
  }

  function activateWorkspaceTabByIndex(index: number) {
    if (index < 0 || index >= workspaceTabIds.length) return;
    activateWorkspaceTab(workspaceTabIds[index]!);
  }

  function openWorkspaceTabLauncher() {
    setLauncherOpen(true);
    launcherBtnRef.current?.focus();
  }

  function closeActiveWorkspaceTab() {
    if (!workspaceTabIds.includes(activeTab)) return;
    if (activeTab === DESIGN_FILES_TAB) return;
    if (activeTab === QUESTIONS_TAB || activeTab === PLAN_TAB) {
      setActiveTab(defaultRootTab);
      return;
    }
    closeTab(activeTab);
  }

  // Open `openName` (focusing it) and close `closeName` in a single tab-state
  // update. Used by the React module pointer (issue #2744): once the user
  // jumps to the HTML entry that renders a module, the dead-end module tab is
  // dropped. Done atomically because calling openFile() then closeTab() would
  // each read the same stale `persistedTabs` prop and the second would clobber
  // the first.
  function openFileReplacing(openName: string, closeName: string) {
    setUploadError(null);
    const withoutClosed = persistedTabs.filter((tabName) => tabName !== closeName);
    const nextTabs = withoutClosed.includes(openName)
      ? withoutClosed
      : [...withoutClosed, openName];
    onTabsStateChange(workspaceTabsState(nextTabs, openName));
    setActiveTab(openName);
  }

  function closeTab(name: string) {
    // Terminal tabs own a daemon PTY that now outlives unmount (so tab switches
    // reattach cheaply). An explicit Close is the one place we terminate it —
    // kill the LIVE session (which may differ from the tab's original id after
    // a Restart), falling back to the tab id when the surface never reported.
    if (isTerminalTabId(name)) {
      const originalId = terminalIdFromTabId(name);
      const liveId = terminalLiveSessionsRef.current.get(originalId) ?? originalId;
      void killTerminal(projectId, liveId, { keepalive: true });
      terminalLiveSessionsRef.current.delete(originalId);
    }
    const nextTabs = persistedTabs.filter((n) => n !== name);
    const nextActive =
      tabsState.active === name
        ? nextTabs[nextTabs.length - 1] ?? null
        : tabsState.active;
    onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
    setActiveTab(nextActive ?? DESIGN_FILES_TAB);
  }

  function reorderPersistedTab(
    draggedName: string,
    targetName: string,
    edge: TabDropEdge,
  ) {
    if (draggedName === targetName) return;
    if (!persistedTabs.includes(draggedName)) return;
    if (!persistedTabs.includes(targetName)) return;

    const nextTabs = persistedTabs.filter((name) => name !== draggedName);
    const targetIndex = nextTabs.indexOf(targetName);
    if (targetIndex === -1) return;
    nextTabs.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedName);
    if (arraysEqual(nextTabs, persistedTabs)) return;
    onTabsStateChange(workspaceTabsState(nextTabs, tabsState.active));
  }

  function clearTabDragState() {
    draggedTabNameRef.current = null;
    setDraggedTabName(null);
    setDragOverTab(null);
  }

  async function handleFilePicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    await uploadFiles(picked);
  }

  async function uploadFiles(picked: File[]) {
    if (picked.length === 0) return;

    setUploadError(null);
    let result: UploadProjectFilesResult;
    try {
      result = await uploadProjectFiles(projectId, picked, uploadDir);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setUploadError(`Upload failed for ${picked.length} file(s) (${detail}).`);
            return;
    }
    if (result.uploaded.length > 0) {
      await onRefreshFiles();
      const lastUploaded = result.uploaded[result.uploaded.length - 1];
      if (lastUploaded?.path) openFile(lastUploaded.path);
    }

    if (result.failed.length > 0) {
      const failedCount = result.failed.length;
      const uploadedCount = result.uploaded.length;
      const detail = result.error ? ` (${result.error})` : '';
      setUploadError(
        uploadedCount > 0
          ? `Uploaded ${uploadedCount} file(s), but ${failedCount} failed${detail}.`
          : `Upload failed for ${failedCount} file(s)${detail}.`,
      );
      console.warn('Project upload had failures', result.failed);
    }
  }

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const isAllowedDropTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest('.df-panel, .composer'));
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e) || isAllowedDropTarget(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || isAllowedDropTarget(e.target)) return;
      e.preventDefault();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    const tabBar = tabsBarRef.current;
    if (!tabBar) return;

    const onWheel = (event: globalThis.WheelEvent) => {
      scrollWorkspaceTabsWithWheel(tabBar, event);
    };
    tabBar.addEventListener('wheel', onWheel, { passive: false });
    return () => tabBar.removeEventListener('wheel', onWheel);
  }, []);

  // Browser-style tab bar: when the active tab changes (open from a chat
  // file chip, switch via Cmd+P, etc.), scroll it into view so the user
  // can always see what they have selected even when the strip overflows.
  // The Design Files entry is already sticky-pinned, so we only scroll
  // for real workspace tabs. Issue #775.
  useEffect(() => {
    if (activeTab === DESIGN_FILES_TAB || activeTab === QUESTIONS_TAB || activeTab === PLAN_TAB) return;
    const tabBar = tabsBarRef.current;
    if (!tabBar) return;
    const el = tabBar.querySelector<HTMLElement>('.ws-tab.active');
    if (!el) return;
    // The Design Files tab is sticky-pinned to the scrollport's left
    // edge (index.css:.ws-tab.design-files-tab), so a naive scrollIntoView
    // with inline: 'nearest' would slide a leftward-jumped active tab
    // flush with that edge and leave it hidden underneath the sticky
    // panel. Compute scrollLeft manually instead, treating the sticky
    // tab's right edge as the effective visible-left boundary.
    const tabRect = el.getBoundingClientRect();
    const barRect = tabBar.getBoundingClientRect();
    const stickyEl = tabBar.querySelector<HTMLElement>('.ws-tab.design-files-tab');
    const stickyWidth = stickyEl ? stickyEl.getBoundingClientRect().width : 0;
    const visibleLeft = barRect.left + stickyWidth;
    const visibleRight = barRect.right;
    if (tabRect.left < visibleLeft) {
      tabBar.scrollLeft += tabRect.left - visibleLeft;
    } else if (tabRect.right > visibleRight) {
      tabBar.scrollLeft += tabRect.right - visibleRight;
    }
  }, [activeTab]);

  // Browser-style shortcuts for the high-frequency Design Files workspace
  // tabs. Capture phase prevents the host browser/Electron shell from opening
  // or closing its own top-level tab before the workspace handles the command.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const key = e.key;
      const lowerKey = key.toLowerCase();
      const primaryModifier = (e.metaKey || e.ctrlKey) && !e.altKey;
      const ctrlWithoutPlatformModifiers = e.ctrlKey && !e.metaKey && !e.altKey;
      const commandOption = e.metaKey && e.altKey && !e.ctrlKey;

      if (primaryModifier && !e.shiftKey && lowerKey === 't') {
        consumeFileWorkspaceTabShortcut(e);
        openWorkspaceTabLauncher();
        return;
      }

      if (primaryModifier && !e.shiftKey && lowerKey === 'w') {
        consumeFileWorkspaceTabShortcut(e);
        closeActiveWorkspaceTab();
        return;
      }

      if (ctrlWithoutPlatformModifiers && key === 'Tab') {
        consumeFileWorkspaceTabShortcut(e);
        activateWorkspaceTabByOffset(e.shiftKey ? -1 : 1);
        return;
      }

      if (
        (ctrlWithoutPlatformModifiers && !e.shiftKey && key === 'PageDown')
        || (commandOption && !e.shiftKey && key === 'ArrowRight')
      ) {
        consumeFileWorkspaceTabShortcut(e);
        activateWorkspaceTabByOffset(1);
        return;
      }

      if (
        (ctrlWithoutPlatformModifiers && !e.shiftKey && key === 'PageUp')
        || (commandOption && !e.shiftKey && key === 'ArrowLeft')
      ) {
        consumeFileWorkspaceTabShortcut(e);
        activateWorkspaceTabByOffset(-1);
        return;
      }

      if (primaryModifier && !e.shiftKey && /^[1-9]$/u.test(key)) {
        consumeFileWorkspaceTabShortcut(e);
        const index = key === '9' ? workspaceTabIds.length - 1 : Number(key) - 1;
        activateWorkspaceTabByIndex(index);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  });

  // Cmd+P (mac) / Ctrl+P (win/linux) opens the file palette. Capture phase
  // so we beat the browser's default print dialog. Platform-gated so on
  // macOS we don't steal Ctrl+P from native readline ("previous line") in
  // text fields, and on win/linux we don't steal Cmd+P (rare but possible
  // on remapped keyboards). Shift+Mod+F opens the project-wide content
  // search on the same capture path (before the browser find dialog).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        if (e.isComposing) return;
        e.preventDefault();
        setQuickSwitcherOpen((open) => !open);
      } else if (primary && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (e.isComposing) return;
        e.preventDefault();
        setContentSearchOpen((open) => !open);
      } else if (e.key === 'Escape' && quickSwitcherOpen) {
        // The palette handles Esc itself, but also catch it here for the
        // case where focus has drifted off the palette input.
        setQuickSwitcherOpen(false);
      } else if (e.key === 'Escape' && contentSearchOpen) {
        setContentSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [quickSwitcherOpen, contentSearchOpen]);

  useEffect(() => {
    document.body.classList.toggle(QUICK_SWITCHER_DOCUMENT_CLASS, quickSwitcherOpen);
    return () => {
      document.body.classList.remove(QUICK_SWITCHER_DOCUMENT_CLASS);
    };
  }, [quickSwitcherOpen]);

  async function handleDelete(name: string) {
    if (!confirm(t('workspace.deleteFileConfirm', { name }))) return;
    const expectedEtag = files.find(file => (file.path ?? file.name) === name)?.etag;
    const ok = await deleteProjectFile(projectId, name, expectedEtag);
    if (ok) {
      await onRefreshFiles();
      const nextTabs = persistedTabs.filter((n) => n !== name);
      if (activeTab === name) {
        // User is viewing the file being deleted: fall back to another
        // open tab (or the Design Files panel if none remain).
        const nextActive = nextTabs[nextTabs.length - 1] ?? null;
        onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
        setActiveTab(nextActive ?? DESIGN_FILES_TAB);
      } else {
        // Deletion was triggered from the Design Files panel (or another
        // tab). We preserve `activeTab` because the user is viewing a
        // different context (Design Files or another tab) and shouldn't
        // be navigated away. Only clear the persisted active reference
        // when it points at the deleted file so we don't leave a dangling
        // pointer behind.
        const nextActive = tabsState.active === name ? null : tabsState.active;
        onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
      }
    }
  }

  async function handleDeleteMany(names: string[]) {
    if (names.length === 0) return;
    if (!confirm(t('workspace.deleteSelectedFilesConfirm', { n: names.length }))) return;
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const name of names) {
      const expectedEtag = files.find(file => (file.path ?? file.name) === name)?.etag;
      const ok = await deleteProjectFile(projectId, name, expectedEtag);
      if (ok) deleted.push(name);
      else failed.push(name);
    }
    if (deleted.length > 0) {
      await onRefreshFiles();
      const deletedSet = new Set(deleted);
      const nextTabs = persistedTabs.filter((n) => !deletedSet.has(n));
      if (activeTab && deletedSet.has(activeTab)) {
        const nextActive = nextTabs[nextTabs.length - 1] ?? null;
        onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
        setActiveTab(nextActive ?? DESIGN_FILES_TAB);
      } else {
        const nextActive =
          tabsState.active && deletedSet.has(tabsState.active) ? null : tabsState.active;
        onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
      }
    }
    if (failed.length > 0) {
      alert(t('workspace.deleteSelectedFilesPartial', { n: failed.length }));
    }
  }

  async function handleRename(oldName: string, nextName: string): Promise<ProjectFile | null> {
    const expectedEtag = files.find(file => (file.path ?? file.name) === oldName)?.etag;
    const result = await renameProjectFile(projectId, oldName, nextName, expectedEtag);
    const renamed = result.file;
    await onRefreshFiles();
    await refreshProjectFolders();

    const nextTabs = persistedTabs.map((name) => (name === oldName ? renamed.name : name));
    const nextActive = tabsState.active === oldName ? renamed.name : tabsState.active;
    onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
    if (activeTab === oldName) setActiveTab(renamed.name);

    return renamed;
  }

  async function handleCreateFolder(folderPath: string): Promise<boolean> {
    const folder = await createProjectFolder(projectId, folderPath);
    if (!folder) return false;
    await refreshProjectFolders();
    return true;
  }

  async function handleDeleteFolder(folderPath: string): Promise<boolean> {
    if (!confirm(t('designFiles.deleteFolderConfirm', { name: folderPath }))) return false;
    const ok = await deleteProjectFolder(projectId, folderPath);
    if (!ok) return false;
    await onRefreshFiles();
    await refreshProjectFolders();
    // Close any open tabs pointing at files that lived under the folder.
    const prefix = `${folderPath}/`;
    const nextTabs = persistedTabs.filter((n) => !n.startsWith(prefix));
    if (nextTabs.length !== persistedTabs.length) {
      const activeGone = activeTab != null && activeTab.startsWith(prefix);
      const nextActive = activeGone
        ? nextTabs[nextTabs.length - 1] ?? null
        : tabsState.active && tabsState.active.startsWith(prefix)
          ? null
          : tabsState.active;
      onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
      if (activeGone) setActiveTab(nextActive ?? DESIGN_FILES_TAB);
    }
    return true;
  }

  async function handleRenameFolder(from: string, to: string): Promise<boolean> {
    const folder = await renameProjectFolder(projectId, from, to);
    if (!folder) return false;
    await onRefreshFiles();
    await refreshProjectFolders();
    // Rewrite open tabs so files under the old path keep their tabs.
    const prefix = `${from}/`;
    const rewrite = (name: string) =>
      name.startsWith(prefix) ? `${folder.path}/${name.slice(prefix.length)}` : name;
    const nextTabs = persistedTabs.map(rewrite);
    if (nextTabs.some((name, i) => name !== persistedTabs[i])) {
      const nextActive = tabsState.active ? rewrite(tabsState.active) : tabsState.active;
      onTabsStateChange(workspaceTabsState(nextTabs, nextActive));
      if (activeTab && activeTab.startsWith(prefix)) setActiveTab(rewrite(activeTab));
    }
    return true;
  }

  async function createMarkdownDocument() {
    const namingFiles = filePaging ? await fetchProjectFiles(projectId) : files;
    const target = nextMarkdownDocumentPath(namingFiles, uploadDir);
    const content = initialMarkdownDocument(target, projectKind, t);
    const file = filePaging
      ? await writeProjectTextFile(projectId, target, content, { expectedEtag: null })
      : await writeProjectTextFile(projectId, target, content);
    if (!file) return;
    await onRefreshFiles();
    await refreshProjectFolders();
    openFile(file.name);
  }

  async function startNewWorkflow() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `workflow-${stamp}.workflow.json`;
    const name = uploadDir ? `${uploadDir}/${base}` : base;
    const definition = emptyWorkflowDefinition(base.replace(/\.workflow\.json$/i, ''));
    const file = filePaging
      ? await writeProjectTextFile(projectId, name, serializeWorkflowDocument(definition), { expectedEtag: null })
      : await writeProjectTextFile(projectId, name, serializeWorkflowDocument(definition));
    if (!file) return;
    await onRefreshFiles();
    openFile(file.name);
  }

  useEffect(() => {
    if (!filePaging || files.some(file => file.name === activeTab)
      || activeTab === DESIGN_FILES_TAB || activeTab === QUESTIONS_TAB
      || activeTab === PLAN_TAB
      || isTerminalTabId(activeTab) || isSideChatTabId(activeTab) || isMatterVizTabId(activeTab)) return;
    let cancelled = false;
    void fetchProjectFileMetadata(projectId, activeTab).then(file => {
      if (!cancelled) setLookedUpFile({ projectId, name: activeTab, file });
    }).catch(error => { if (!cancelled) setUploadError(String(error)); });
    return () => { cancelled = true; };
  }, [projectId, activeTab, files, filesRefreshKey, Boolean(filePaging)]);

  const activeFile = useMemo<ProjectFile | null>(() => {
    if (
      activeTab === DESIGN_FILES_TAB
      || activeTab === QUESTIONS_TAB
      || activeTab === PLAN_TAB
    ) return null;
    const onDisk = visibleFiles.find((f) => f.name === activeTab);
    if (onDisk) return onDisk;
    return null;
  }, [activeTab, visibleFiles]);

  const activeWorkspaceContext = useMemo<WorkspaceContextItem | null>(() => {
    if (activeTab === DESIGN_FILES_TAB) {
      // Nothing to reference yet — don't auto-stage an empty "Design files" chip.
      if (designFilesTabIsEmpty) return null;
      const trimmedDir = uploadDir.trim();
      const label = trimmedDir.split('/').filter(Boolean).pop() || t('workspace.designFiles');
      return {
        id: trimmedDir ? `folder:${trimmedDir}` : 'workspace:design-files',
        kind: trimmedDir ? 'folder' : 'design-files',
        label,
        tabId: activeTab,
        ...(trimmedDir ? { path: trimmedDir } : {}),
        ...(resolvedDir ? { absolutePath: joinDisplayPath(resolvedDir, trimmedDir) } : {}),
      };
    }
    if (isTerminalTabId(activeTab)) {
      const terminalId = terminalIdFromTabId(activeTab);
      return {
        id: `terminal:${terminalId}`,
        kind: 'terminal',
        label: t('workspace.newTerminal'),
        tabId: activeTab,
      };
    }
    if (isSideChatTabId(activeTab)) {
      const conversationId = conversationIdFromSideChatTabId(activeTab);
      const conversation = conversations.find((item) => item.id === conversationId);
      return {
        id: `side-chat:${conversationId}`,
        kind: 'side-chat',
        label: conversation?.title?.trim() || t('workspace.sideChatDefaultTitle'),
        tabId: activeTab,
      };
    }
    if (activeFile) {
      const filePath = activeFile.path ?? activeFile.name;
      return {
        id: `file:${filePath}`,
        kind: 'file',
        label: filePath.split('/').filter(Boolean).pop() || filePath,
        tabId: activeTab,
        path: filePath,
        ...(resolvedDir ? { absolutePath: joinDisplayPath(resolvedDir, filePath) } : {}),
      };
    }
    return null;
  }, [
    activeFile,
    activeTab,
    conversations,
    designFilesTabIsEmpty,
    resolvedDir,
    t,
    uploadDir,
  ]);

  useEffect(() => {
    onActiveContextChange?.(activeWorkspaceContext);
  }, [activeWorkspaceContext, onActiveContextChange]);

  const tabNames = persistedTabs;

  const orderedWorkspaceTabs = useMemo(
    () => tabNames.map((name) => ({ id: name, name })),
    [tabNames],
  );

  const workspaceTabIds = useMemo(() => {
    const ids: string[] = [];
    ids.push(DESIGN_FILES_TAB);
    if (showQuestionsTab) ids.push(QUESTIONS_TAB);
    if (showPlanTab) ids.push(PLAN_TAB);
    for (const entry of orderedWorkspaceTabs) {
      ids.push(entry.name);
    }
    return ids;
  }, [orderedWorkspaceTabs, showQuestionsTab, showPlanTab]);

  const workspaceContexts = useMemo<WorkspaceContextItem[]>(() => {
    const out: WorkspaceContextItem[] = [];
    const seen = new Set<string>();
    const push = (item: WorkspaceContextItem | null | undefined) => {
      if (!item) return;
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    const trimmedDir = uploadDir.trim();
    const designFilesLabel = trimmedDir.split('/').filter(Boolean).pop() || t('workspace.designFiles');
    push({
      id: trimmedDir ? `folder:${trimmedDir}` : 'workspace:design-files',
      kind: trimmedDir ? 'folder' : 'design-files',
      label: designFilesLabel,
      tabId: DESIGN_FILES_TAB,
      ...(trimmedDir ? { path: trimmedDir } : {}),
      ...(resolvedDir ? { absolutePath: joinDisplayPath(resolvedDir, trimmedDir) } : {}),
    });

    const filesByName = new Map(visibleFiles.map((file) => [file.name, file] as const));
    const terminalTabNames = tabNames.filter(isTerminalTabId);

    for (const entry of orderedWorkspaceTabs) {
      const name = entry.name;
      if (isTerminalTabId(name)) {
        const terminalId = terminalIdFromTabId(name);
        const ordinal = terminalTabNames.indexOf(name) + 1;
        push({
          id: `terminal:${terminalId}`,
          kind: 'terminal',
          label: ordinal > 1 ? `${t('workspace.newTerminal')} ${ordinal}` : t('workspace.newTerminal'),
          tabId: name,
        });
        continue;
      }

      if (isSideChatTabId(name)) {
        const conversationId = conversationIdFromSideChatTabId(name);
        const conversation = conversations.find((item) => item.id === conversationId);
        push({
          id: `side-chat:${conversationId}`,
          kind: 'side-chat',
          label: conversation?.title?.trim() || t('workspace.sideChatDefaultTitle'),
          tabId: name,
        });
        continue;
      }

      const file = filesByName.get(name);
      if (file) {
        const filePath = file?.path ?? file?.name ?? name;
        push({
          id: `file:${filePath}`,
          kind: 'file',
          label: filePath.split('/').filter(Boolean).pop() || filePath,
          tabId: name,
          path: filePath,
          ...(resolvedDir ? { absolutePath: joinDisplayPath(resolvedDir, filePath) } : {}),
        });
      }
    }

    return out;
  }, [
    conversations,
    orderedWorkspaceTabs,
    resolvedDir,
    t,
    tabNames,
    uploadDir,
    visibleFiles,
  ]);

  useEffect(() => {
    onWorkspaceContextsChange?.(workspaceContexts);
  }, [onWorkspaceContextsChange, workspaceContexts]);

  useEffect(() => {
    const tabBar = tabsBarRef.current;
    if (!tabBar) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setTabsOverflowing(tabBar.scrollWidth > tabBar.clientWidth + 1);
    };
    const requestMeasure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    requestMeasure();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestMeasure);
    if (resizeObserver) {
      resizeObserver.observe(tabBar);
      Array.from(tabBar.children).forEach((child) => resizeObserver.observe(child));
    }
    window.addEventListener('resize', requestMeasure);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', requestMeasure);
    };
  }, [tabNames.length]);

  const isActiveWorkflow = activeFile?.kind === 'workflow' && isWorkflowFileName(activeFile.name);
  // Role asset refs for the Workflow Studio agent-node inspector. The MatOS
  // agent projects role assets into its models list (role:<id> ids), so the
  // canvas can reuse that catalog without a second API surface.
  const workflowRoleOptions = useMemo(() => {
    const matos = chatAgentsById?.get('matos');
    if (!matos?.models) return [];
    return matos.models
      .map((model) => model.id)
      .filter((id) => typeof id === 'string' && id.startsWith('role:'));
  }, [chatAgentsById]);
  // The "+" launcher's create-new actions come from the registry. `openTab`
  // reuses the same tab-state path as opening a file so a new terminal:<id>
  // tab is focused. The terminal action routes through `openFile` (ref-based),
  // so freshness here is cheap and only matters while the launcher is open.
  const launcherContext: LauncherContext = {
    projectId,
    openTab: openFile,
    createWorkflow: () => void startNewWorkflow(),
    createDocument: () => void createMarkdownDocument(),
    createMaterialsViewer: () => openMaterialsViewer(),
    uploadDesignFiles: () => fileInputRef.current?.click(),
    // Terminal needs only the project id — spawn the PTY here and hand the
    // resulting session id back so the launcher opens a terminal:<id> tab.
    // Surface a toast when the daemon can't start one (e.g. node-pty not
    // compiled) instead of silently no-opping the launcher action.
    createTerminal: async () => {
      const term = await createTerminal(projectId);
      if (!term) {
        setLauncherToast(t('workspace.terminalStartFailed'));
        return null;
      }
      return term.id;
    },
  };
  const launcherActions = buildLauncherActions(launcherContext);

  return (
    <div className="workspace" data-testid="file-workspace">
      <div className="ws-tabs-shell">
        {onFocusModeChange && focusMode ? (
          <button
            type="button"
            className="icon-only ws-focus-expand od-tooltip"
            data-testid="workspace-focus-toggle"
            aria-pressed={focusMode}
            title={t('workspace.showChat')}
            data-tooltip={t('workspace.showChat')}
            data-tooltip-placement="bottom"
            aria-label={t('workspace.showChat')}
            onClick={() => onFocusModeChange(false)}
          >
            <Icon name="chevron-right" size={15} />
          </button>
        ) : null}
        {onFocusModeChange && !focusMode ? (
          // Enter-focus control for phone layouts: the stacked split gives the
          // workspace less than half the screen, so this maximizes it. Hidden
          // on desktop via CSS (.ws-focus-enter) where the chat pane already
          // has room and the divider handles resizing.
          <button
            type="button"
            className="icon-only ws-focus-enter od-tooltip"
            data-testid="workspace-focus-enter"
            aria-pressed={focusMode}
            title={t('workspace.focusMode')}
            data-tooltip={t('workspace.focusMode')}
            data-tooltip-placement="bottom"
            aria-label={t('workspace.focusMode')}
            onClick={() => onFocusModeChange(true)}
          >
            <Icon name="maximize" size={14} />
          </button>
        ) : null}
        <div
          ref={tabsBarRef}
          className={`ws-tabs-bar${tabsOverflowing ? ' is-overflowing' : ''}`}
          role="tablist"
          aria-label={t('workspace.designFiles')}
          onWheel={(event) => {
            // Translate vertical wheel into horizontal tab scroll so Windows
            // mouse-wheel users (no horizontal wheel/trackpad) can reach
            // overflowed tabs. Only act when there's actually horizontal
            // overflow and the gesture is predominantly vertical.
            const el = event.currentTarget;
            if (el.scrollWidth <= el.clientWidth) return;
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
            el.scrollLeft += event.deltaY;
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragOverTab(null);
          }}
          onDrop={(event) => {
            if (event.target !== event.currentTarget) return;
            clearTabDragState();
          }}
        >
          <button
            type="button"
            className={`ws-tab design-files-tab ${activeTab === DESIGN_FILES_TAB ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === DESIGN_FILES_TAB}
            tabIndex={0}
            data-testid="design-files-tab"
            onClick={() => setPersistedActive(DESIGN_FILES_TAB)}
            title={t('workspace.designFiles')}
          >
            <span className="tab-icon" aria-hidden>
              <Icon name="grid" size={13} />
            </span>
            <span className="ws-tab-label">{t('workspace.designFiles')}</span>
          </button>
          {showQuestionsTab ? (
            <button
              type="button"
              className={`ws-tab questions-tab ${activeTab === QUESTIONS_TAB ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === QUESTIONS_TAB}
              tabIndex={0}
              data-testid="questions-tab"
              onClick={() => setActiveTab(QUESTIONS_TAB)}
              title={t('questions.tabLabel')}
            >
              <span className="tab-icon" aria-hidden>
                <Icon name="help-circle" size={13} />
              </span>
              <span className="ws-tab-label">{t('questions.tabLabel')}</span>
            </button>
          ) : null}
          {showPlanTab ? (
            <button
              type="button"
              className={`ws-tab plan-tab ${activeTab === PLAN_TAB ? 'active' : ''}`}
              role="tab"
              aria-selected={activeTab === PLAN_TAB}
              tabIndex={0}
              data-testid="plan-tab"
              onClick={() => setActiveTab(PLAN_TAB)}
              title={t('planCanvas.tabLabel')}
            >
              <span className="tab-icon" aria-hidden>
                <Icon name="kanban" size={13} />
              </span>
              <span className="ws-tab-label">{t('planCanvas.tabLabel')}</span>
              {planDoc?.status === 'streaming' ? (
                <span className="plan-tab__live" aria-hidden />
              ) : null}
            </button>
          ) : null}
          {orderedWorkspaceTabs.map((entry) => {
            const name = entry.name;
            const onDisk = visibleFiles.find((f) => f.name === name);
            const kind = onDisk?.kind ?? 'text';
            const isTerminal = isTerminalTabId(name);
            const isSideChat = isSideChatTabId(name);
            const isMatterViz = isMatterVizTabId(name);
            // Terminal / side-chat / materials-viewer tabs are not files: give
            // them a friendly label + glyph instead of the raw prefixed id.
            let label: string;
            if (isTerminal) {
              // Number multiple terminals so the tabs stay distinguishable.
              const ordinal = tabNames.filter(isTerminalTabId).indexOf(name) + 1;
              label =
                ordinal > 1
                  ? `${t('workspace.newTerminal')} ${ordinal}`
                  : t('workspace.newTerminal');
            } else if (isSideChat) {
              const conv = conversations.find(
                (c) => c.id === conversationIdFromSideChatTabId(name),
              );
              label = conv?.title?.trim() || t('workspace.sideChatDefaultTitle');
            } else if (isMatterViz) {
              const ordinal = tabNames.filter(isMatterVizTabId).indexOf(name) + 1;
              label =
                ordinal > 1
                  ? `${t('materialsViewer.title')} ${ordinal}`
                  : t('materialsViewer.title');
            } else {
              label = name;
            }
            const iconNameOverride: IconName | undefined = isTerminal
              ? 'terminal'
              : isSideChat
                ? 'comment'
                : isMatterViz
                  ? 'atom'
                  : undefined;
            return (
              <Tab
                key={name}
                label={label}
                iconNameOverride={iconNameOverride}
                active={activeTab === name}
                onActivate={() => setPersistedActive(name)}
                onClose={() => closeTab(name)}
                kind={kind}
                draggable={persistedTabs.includes(name)}
                dragging={draggedTabName === name}
                dragOverEdge={
                  dragOverTab?.name === name && draggedTabName !== name
                    ? dragOverTab.edge
                    : null
                }
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', name);
                  draggedTabNameRef.current = name;
                  setDraggedTabName(name);
                }}
                onDragOver={(event) => {
                  const currentDraggedName = draggedTabNameRef.current ?? draggedTabName;
                  if (!currentDraggedName || currentDraggedName === name) return;
                  if (!persistedTabs.includes(currentDraggedName)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const edge = tabDropEdgeFromEvent(event);
                  setDragOverTab((current) =>
                    current?.name === name && current.edge === edge
                      ? current
                      : { name, edge },
                  );
                }}
                onDragLeave={() => {
                  setDragOverTab((current) => (current?.name === name ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedName = draggedTabNameRef.current || draggedTabName;
                  if (draggedName) {
                    reorderPersistedTab(draggedName, name, tabDropEdgeFromEvent(event));
                  }
                  clearTabDragState();
                }}
                onDragEnd={clearTabDragState}
              />
            );
          })}
        </div>
        <div className="ws-add-tab">
          <button
            ref={launcherBtnRef}
            type="button"
            className="icon-only ws-tab-add od-tooltip"
            data-testid="workspace-add-tab"
            aria-haspopup="dialog"
            aria-expanded={launcherOpen}
            title={t('workspace.newTab')}
            data-tooltip={t('workspace.newTab')}
            data-tooltip-placement="bottom"
            aria-label={t('workspace.newTab')}
            onClick={() => setLauncherOpen((v) => !v)}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {/* Pinned to the right for project/file actions; the tab launcher sits
            next to the file tabs so its spatial relationship stays clear. */}
        <div className="ws-tabs-actions">
          <div
            id={APP_CHROME_FILE_ACTIONS_ID}
            className="ws-tabs-file-actions"
            data-app-chrome-file-actions="true"
          />
          {headerActions ? (
            <div className="ws-tabs-project-actions">{headerActions}</div>
          ) : null}
        </div>
      </div>
      {launcherOpen ? (
        <TabLauncherMenu
          anchor={launcherBtnRef.current}
          files={visibleFiles}
          workspaceContexts={workspaceContexts}
          openTabNames={tabNames}
          actions={launcherActions}
          launcherContext={launcherContext}
          onOpenFile={openFile}
          onOpenTab={focusWorkspaceTab}
          onClose={() => setLauncherOpen(false)}
        />
      ) : null}
      {launcherToast ? (
        <Toast
          message={launcherToast}
          role="alert"
          onDismiss={() => setLauncherToast(null)}
        />
      ) : null}
      <div className="ws-body">
        {/* Banner moved into DesignFilesPanel for the Design Files tab so
            single-click preview (which keeps activeTab on DESIGN_FILES_TAB)
            no longer leaves a stale banner mounted above the preview.
            Keep a fallback here that fires only when activeTab is not the
            Design Files tab, which preserves visibility for the
            partial-upload case where the last successful file auto-opens
            into a viewer surface. */}
        {uploadError && activeTab !== DESIGN_FILES_TAB ? (
          <div className="df-upload-banner" data-testid="upload-error-banner">
            <span>{uploadError}</span>
            <button
              type="button"
              data-testid="upload-error-dismiss"
              onClick={() => setUploadError(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {activeTab === PLAN_TAB && planDoc ? (
          <PlanCanvasPanel
            doc={planDoc}
            onApprove={onApprovePlan}
            approveDisabled={planApproveDisabled}
            onRefine={onRefinePlan}
          />
        ) : activeTab === QUESTIONS_TAB ? (
          <QuestionsPanel
            key={questionFormKey ?? undefined}
            projectId={projectId}
            formKey={questionFormKey}
            form={questionForm ?? questionFormPreview}
            interactive={questionFormInteractive}
            submitDisabled={questionFormSubmitDisabled}
            submittedAnswers={questionFormSubmittedAnswers}
            generating={questionsGenerating}
            onSubmit={(text) => onSubmitQuestionForm?.(text)}
          />
        ) : activeTab === DESIGN_FILES_TAB ? (
          <DesignFilesPanel
            filePaging={filePaging}
            key={projectId}
            projectId={projectId}
            rootDirName={rootDirName}
            reloading={reloading}
            running={Boolean(streaming)}
            files={visibleFiles}
            folders={projectFolders}
            onRefreshFiles={onRefreshFiles}
            onCurrentDirChange={setUploadDir}
            navState={designFilesNavRef.current ?? undefined}
            onNavStateChange={onDesignFilesNavStateChange}
            onOpenContentSearch={() => setContentSearchOpen(true)}
            onOpenFile={openFile}
            onRenameFile={handleRename}
            onCreateFile={async (path: string) => {
              // VSCode-style "New file" from the tree: an empty text file the
              // editor opens immediately.
              const file = filePaging
                ? await writeProjectTextFile(projectId, path, '', { expectedEtag: null })
                : await writeProjectTextFile(projectId, path, '');
              if (!file) return null;
              await onRefreshFiles();
              await refreshProjectFolders();
              return file;
            }}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={(folderPath) => {
                            return handleDeleteFolder(folderPath);
            }}
            onRenameFolder={handleRenameFolder}
            onDeleteFile={(name) => {
                            void handleDelete(name);
            }}
            onDeleteFiles={(names) => {
                            return handleDeleteMany(names);
            }}
            onUpload={() => {
                            fileInputRef.current?.click();
            }}
            onUploadFiles={(picked) => void uploadFiles(picked)}
            onPaste={() => {
                            void createMarkdownDocument();
            }}
            onDuplicateProject={onDuplicateProject}
            duplicateProjectBusy={duplicateProjectBusy}
            uploadError={uploadError}
            onClearUploadError={() => setUploadError(null)}
            preferredPreviewFile={preferredPreviewFile}
            autoPreviewDesignArtifacts={autoPreviewDesignArtifacts}
          />
        ) : isActiveWorkflow && activeFile ? (
          <WorkflowEditor
            key={`${projectId}:${activeFile.name}`}
            projectId={projectId}
            file={activeFile}
            roleOptions={workflowRoleOptions}
            onSaved={onRefreshFiles}
            focusMode={focusMode}
            onFocusModeChange={onFocusModeChange}
          />
        ) : isSideChatTabId(activeTab) && chatConfig && chatAgentsById ? (
          <SideChatTab
            key={`${projectId}:${activeTab}`}
            projectId={projectId}
            conversationId={conversationIdFromSideChatTabId(activeTab)}
            config={chatConfig}
            agentsById={chatAgentsById}
            locale={chatLocale ?? 'en'}
            projectMemberRefs={projectMemberRefs}
            projectMatosRoleRef={projectMatosRoleRef}
            matosRolePicker={renderMatosRolePicker?.(
              conversationIdFromSideChatTabId(activeTab),
            )}
            projectFiles={visibleFiles}
            conversations={conversations}
            onSelectConversation={onSelectConversation ?? (() => {})}
            onDeleteConversation={onDeleteConversation ?? (() => {})}
            onRenameConversation={onRenameConversation}
            onSessionModeChange={onConversationSessionModeChange}
            onNewConversation={onNewConversation}
            activeConversationChat={activeConversationChat}
            onRequestOpenFile={openFile}
          />
        ) : isTerminalTabId(activeTab) ? (
          <TerminalViewer
            key={activeTab}
            projectId={projectId}
            terminalId={terminalIdFromTabId(activeTab)}
            onClose={() => closeTab(activeTab)}
            onSessionIdChange={handleTerminalSessionChange}
          />
        ) : isMatterVizTabId(activeTab) ? (
          <MaterialsViewerTab
            key={activeTab}
            projectId={projectId}
            files={visibleFiles}
            onUpload={() => fileInputRef.current?.click()}
          />
        ) : activeFile ? (
          <FileViewer
            projectId={projectId}
            projectKind={projectKind}
            file={activeFile}
            filesRefreshKey={filesRefreshKey}
            isDeck={isDeck}
            streaming={streaming}
            commentQueueOnSend={commentQueueOnSend}
            commentSendDisabled={commentSendDisabled}
            previewComments={previewComments.filter((comment) => comment.filePath === activeFile.name)}
            onSavePreviewComment={onSavePreviewComment}
            onRemovePreviewComment={onRemovePreviewComment}
            onSendBoardCommentAttachments={onSendBoardCommentAttachments}
            onFileSaved={onRefreshFiles}
            onOpenFileReplacing={openFileReplacing}
            commentPortalId={commentPortalId}
            onCommentModeChange={onCommentModeChange}
            downloadRequest={
              downloadRequest && downloadRequest.name === activeFile.name
                ? { nonce: downloadRequest.nonce }
                : null
            }
            slideNavRequest={deliverableSlideNavForActiveFile(
              slideNavRequest,
              activeFile.name,
              slideNavDeliverableNonce,
            )}
          />
        ) : (
          <div className="viewer-empty">
            {t('workspace.openFromDesignFiles')}{' '}
            <a
              className="link"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab(DESIGN_FILES_TAB);
              }}
            >
              {t('workspace.designFilesLink')}
            </a>
            .
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="design-files-upload-input"
        style={{ display: 'none' }}
        onChange={handleFilePicked}
      />
      <AnimatePresence>
      </AnimatePresence>
      <AnimatePresence>
        {quickSwitcherOpen ? (
          <QuickSwitcher
            projectId={projectId}
            files={visibleFiles}
            workspaceContexts={workspaceContexts}
            onOpenFile={(name) => {
              openFile(name);
              setQuickSwitcherOpen(false);
            }}
            onOpenTab={(tabId) => {
              focusWorkspaceTab(tabId);
              setQuickSwitcherOpen(false);
            }}
            onClose={() => setQuickSwitcherOpen(false)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {contentSearchOpen ? (
          <ProjectSearchPanel
            projectId={projectId}
            onOpenFile={(name) => {
              openFile(name);
              setContentSearchOpen(false);
            }}
            onClose={() => setContentSearchOpen(false)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function normalizeProjectFilePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function joinProjectFilePath(dir: string, name: string): string {
  const normalizedDir = normalizeProjectFilePath(dir);
  return normalizedDir ? `${normalizedDir}/${name}` : name;
}

function nextMarkdownDocumentPath(files: ProjectFile[], dir: string): string {
  const existing = new Set(files.map((file) => normalizeProjectFilePath(file.name).toLowerCase()));
  for (let index = 1; index < 1000; index += 1) {
    const name = index === 1 ? 'document.md' : `document-${index}.md`;
    const candidate = joinProjectFilePath(dir, name);
    if (!existing.has(normalizeProjectFilePath(candidate).toLowerCase())) return candidate;
  }
  return joinProjectFilePath(dir, `document-${Date.now()}.md`);
}

function initialMarkdownDocument(
  path: string,
  projectKind: FileWorkspaceProjectKind,
  t: TranslateFn,
): string {
  const title = normalizeProjectFilePath(path)
    .split('/')
    .pop()
    ?.replace(/\.mdx?$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase()) || t('designFiles.documentTemplate.titleFallback');
  return `# ${title}

## ${t('designFiles.documentTemplate.goalHeading')}

${t('designFiles.documentTemplate.goalBody')}

## ${t('designFiles.documentTemplate.capabilitiesHeading')}

- ${t('designFiles.documentTemplate.capabilityMarkdown')}
- ${t('designFiles.documentTemplate.capabilityAgent')}
- ${t('designFiles.documentTemplate.capabilityImages')}

## ${t('designFiles.documentTemplate.scenarioHeading')}

${t(documentTemplateScenarioKey(projectKind))}

## ${t('designFiles.documentTemplate.nextHeading')}

${t('designFiles.documentTemplate.nextBody')}
`;
}

function documentTemplateScenarioKey(projectKind: FileWorkspaceProjectKind): keyof Dict {
  switch (projectKind) {
    case 'prototype':
      return 'designFiles.documentTemplate.scenario.prototype';
    case 'wireframe':
      return 'designFiles.documentTemplate.scenario.wireframe';
    case 'mobile':
      return 'designFiles.documentTemplate.scenario.mobile';
    case 'slide_deck':
      return 'designFiles.documentTemplate.scenario.slideDeck';
    case 'document':
      return 'designFiles.documentTemplate.scenario.document';
    case 'image':
      return 'designFiles.documentTemplate.scenario.image';
    case 'video':
      return 'designFiles.documentTemplate.scenario.video';
    case 'audio':
      return 'designFiles.documentTemplate.scenario.audio';
    case 'template':
    default:
      return 'designFiles.documentTemplate.scenario.default';
  }
}

function Tab({
  testId,
  label,
  meta,
  title,
  active,
  onActivate,
  onClose,
  closable = true,
  kind,
  iconNameOverride,
  draggable = false,
  dragging = false,
  dragOverEdge,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  testId?: string;
  label: string;
  meta?: string;
  title?: string;
  active: boolean;
  onActivate: () => void;
  onClose?: () => void;
  closable?: boolean;
  kind?: ProjectFile['kind'];
  /** Force a specific icon (e.g. non-file tabs like terminal:<id> / chat:<id>). */
  iconNameOverride?: IconName;
  draggable?: boolean;
  dragging?: boolean;
  dragOverEdge?: TabDropEdge | null;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}) {
  const t = useT();
  const iconName = iconNameOverride ?? kindIconName(kind);
  const tabTitle = title ?? (meta ? `${label} ${meta}` : label);
  return (
    <div
      data-testid={testId}
      className={[
        'ws-tab',
        'od-tooltip',
        meta ? 'has-meta' : '',
        active ? 'active' : '',
        draggable ? 'draggable' : '',
        dragging ? 'dragging' : '',
        dragOverEdge ? `drag-over-${dragOverEdge}` : '',
      ].filter(Boolean).join(' ')}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={tabTitle}
      data-tooltip={tabTitle}
      data-tooltip-placement="bottom"
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? onDragOver : undefined}
      onDragLeave={draggable ? onDragLeave : undefined}
      onDrop={draggable ? onDrop : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      {iconName ? (
        <span className="tab-icon" aria-hidden>
          <Icon name={iconName} size={13} />
        </span>
      ) : null}
      <span className="ws-tab-text">
        <span className="ws-tab-label">{label}</span>
        {meta ? <span className="ws-tab-meta">{meta}</span> : null}
      </span>
      {closable && onClose ? (
        <button
          type="button"
          className="ws-tab-close od-tooltip"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={t('workspace.closeTab')}
          data-tooltip={t('workspace.closeTab')}
          data-tooltip-placement="bottom"
          aria-label={t('workspace.closeTab')}
        >
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </div>
  );
}

function tabDropEdgeFromEvent(event: ReactDragEvent<HTMLDivElement>): TabDropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function scrollWorkspaceTabsWithWheel(
  tabBar: Pick<HTMLDivElement, 'clientWidth' | 'scrollLeft' | 'scrollWidth'>,
  event: Pick<globalThis.WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY' | 'preventDefault'>,
) {
  if (event.ctrlKey) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  if (tabBar.scrollWidth <= tabBar.clientWidth) return;

  const before = tabBar.scrollLeft;
  tabBar.scrollLeft += wheelDeltaToPixels(event.deltaY, event.deltaMode);
  if (tabBar.scrollLeft === before) return;

  event.preventDefault();
}

function wheelDeltaToPixels(delta: number, deltaMode: number): number {
  const WHEEL_DELTA_LINE = 1;
  const WHEEL_DELTA_PAGE = 2;

  if (deltaMode === WHEEL_DELTA_LINE) return delta * 16;
  if (deltaMode === WHEEL_DELTA_PAGE) return delta * 160;
  return delta;
}

function kindIconName(
  kind?: string,
):
  | 'file-code'
  | 'globe'
  | 'image'
  | 'pencil'
  | 'file'
  | null {
  if (kind === 'html') return 'file-code';
  if (kind === 'image') return 'image';
  if (kind === 'code') return 'file-code';
  if (kind === 'text') return 'file';
  return 'file';
}
