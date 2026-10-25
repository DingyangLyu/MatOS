// Composed Home view — the top-down layout the entry view renders
// when the left nav rail's "Home" tab is active.
//
// Owns the prompt state + selected project-kind chip and stitches
// together the smaller pieces (HomeHero, RecentProjectsStrip).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ChatSessionMode,
  McpServerConfig,
  ProjectKind,
  ProjectMetadata,
  WorkspaceContextItem,
} from '@open-design/contracts';
import { createProject } from '../state/projects';
import { fetchMcpServers } from '../state/mcp';
import { useI18n } from '../i18n';
import {
  localizeSkillName,
  localizeSkillPrompt,
} from '../i18n/content';
import {
  dirExists,
  fetchRecentLinkedDirs,
  openFolderDialog,
  pushRecentLinkedDir,
} from '../providers/registry';
import { isOpenDesignHostAvailable, pickHostWorkingDir } from '@open-design/host';
import type { AgentModelOption } from '@open-design/contracts';
import type {
  Project,
  SkillSummary,
} from '../types';
import { inlineMentionToken, mentionTokenPresent } from '../utils/inlineMentions';
import { HomeHero, type ExamplePromptInfo, type HomeHeroHandle } from './HomeHero';
import { findChip, type HomeHeroChip } from './home-hero/chips';
import type { PlaceholderScenario } from './home-hero/placeholderScenarios';
import { consumePendingHomeChip, HOME_CHIP_INTENT_EVENT } from '../runtime/home-intent';
import { workspaceContextLinkedDirs } from './workspace-context';
import { SkillDetailsModal } from './SkillDetailsModal';
import { HomeTemplatesReveal } from './HomeTemplatesReveal';
import { MatOSAssetsHomeSection } from './MatOSAssetsHomeSection';
import { MATOS_HOME_TEMPLATES_VISIBLE } from '../features/matosHomeTemplates';
import { RecentProjectsStrip } from './RecentProjectsStrip';
import { AnimatePresence } from 'motion/react';

function homeSubmitErrorMessage(err: unknown): string {
  const message =
    err instanceof Error && err.message.trim()
      ? err.message.trim()
      : typeof err === 'string' && err.trim()
        ? err.trim()
        : '';
  if (message) return `Failed to start the run: ${message}`;
  return 'Failed to start the run. The project was not created or opened correctly. Refresh the page and try again.';
}

// Payload handed to the entry shell's project-creation path.
export interface HomeSubmitPayload {
  prompt: string;
  skillId: string | null;
  contextMcpServers: Array<{
    id: string;
    label?: string;
    transport?: string;
    url?: string;
    command?: string;
  }>;
  initialRunContext?: { workspaceItems: WorkspaceContextItem[] };
  // When the user picked a Home chip the rail tells the submit handler which
  // `ProjectKind` to stamp on the new project's metadata. Null means the
  // caller did not stamp an explicit kind.
  projectKind?: ProjectKind;
  projectMetadata?: ProjectMetadata;
  workingDir?: string | null;
  linkedDirs?: string[];
  // Single-use desktop token minted for `workingDir` when the folder was
  // chosen through the host's native picker. Spent (not persisted) on the
  // post-creation working-dir POST so the daemon's desktop-auth gate accepts
  // it. Null/absent for web picks (gate inactive) or no selection.
  workingDirToken?: string | null;
  conversationMode?: ChatSessionMode;
  // Files staged on Home before the project exists. App uploads them
  // into the created project's Design Files before the first auto-send.
  attachments?: File[];
  examplePromptContext?: { title: string; artifactType: string; brief: Record<string, string> };
}

// `inlineBacked` distinguishes a context inserted as an inline `@mention` pill
// (added through the mention picker / plus menu, which writes a token into the
// prompt) from a context-only selection made through the plain `Use` action
// (which stages the context without touching the prompt). Inline-backed
// contexts are dropped once their `@` token is deleted; context-only ones stay
// selected until explicitly removed. Conflating the two drops plain `Use`
// selections from the submit payload because they never carry a token.
interface SelectedMcpContext {
  server: McpServerConfig;
  inlineBacked: boolean;
}

interface Props {
  isActive?: boolean;
  /** Native MatOS owns routing; never synthesize a hidden default scenario. */
  nativeMatOSChat?: boolean;
  projects: Project[];
  projectsLoading?: boolean;
  // MatOS role selection for the composer row (replaces the home
  // role picker). EntryShell owns the state: the selection is the
  // matos agent's persisted model choice (`config.agentModels['matos']`),
  // so the run started from this composer executes `matos --role <ref>`.
  matosRoles?: AgentModelOption[];
  matosRolesLoading?: boolean;
  selectedMatosRoleId?: string | null;
  onMatosRoleChange?: (id: string | null) => void;
  onSubmit: (payload: HomeSubmitPayload) => Promise<boolean> | boolean | void;
  onOpenProject: (id: string, fileName?: string) => void;
  onViewAllProjects: () => void;
  onDeleteProject?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicateProject?: (id: string) => Promise<void> | void;
  onRenameProject?: (id: string, name: string) => void;
  onOpenMcp?: () => void;
  // Stage B: optional callbacks the rail's migration chips need.
  // HomeView itself never imports them; EntryShell threads them
  // through so the dispatcher can stay declarative.
  onOpenNewProject?: (tab: 'template') => void;
  onStartBlankProject?: () => Promise<void> | void;
  skills?: SkillSummary[];
  skillsLoading?: boolean;
  executionSwitcher?: ReactNode;
}

const EMPTY_MATOS_ROLES: AgentModelOption[] = [];
const EMPTY_SKILLS: SkillSummary[] = [];

// The Home composer lives inside EntryView, which App.tsx fully UNMOUNTS the
// moment the user opens a project tab (the single `appMain` slot swaps
// EntryView → ProjectView). Plain useState would therefore be discarded on
// every tab switch, so a half-typed prompt and the chosen design system vanish
// when the user steps away and comes back. Persist those two serializable,
// user-visible fields to localStorage so they survive the unmount/remount,
// mirroring ChatComposer's draft persistence. Object-valued selections (active
// template, skill, staged files, working directory) are intentionally NOT
// persisted here — they reference live catalogue records / File handles / a
// desktop auth token that cannot round-trip through JSON safely.
const HOME_COMPOSER_PROMPT_KEY = 'open-design:home-composer:prompt';

function readHomeComposerDraft(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeHomeComposerDraft(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode / quota exceeded) — degrade silently to
    // in-memory-only state; the composer still works for this session.
  }
}

// Drop the persisted draft once a run is actually created, so the just-sent
// prompt and pick don't resurrect the next time the Home tab mounts.
function clearHomeComposerDraft(): void {
  writeHomeComposerDraft(HOME_COMPOSER_PROMPT_KEY, null);
}

export function HomeView({
  isActive = true,
  nativeMatOSChat = false,
  projects,
  projectsLoading,
  matosRoles = EMPTY_MATOS_ROLES,
  matosRolesLoading = false,
  selectedMatosRoleId = null,
  onMatosRoleChange,
  onSubmit,
  onOpenProject,
  onViewAllProjects,
  onDeleteProject,
  onDuplicateProject,
  onRenameProject,
  onOpenMcp,
  onOpenNewProject,
  onStartBlankProject,
  skills = EMPTY_SKILLS,
  skillsLoading = false,
  executionSwitcher,
}: Props) {
  const { locale, t } = useI18n();
  const [activeChipId, setActiveChipId] = useState<string | null>(null);
  const [activeChipProjectKind, setActiveChipProjectKind] = useState<ProjectKind | null>(null);
  const [activeChipProjectMetadata, setActiveChipProjectMetadata] =
    useState<ProjectMetadata | null>(null);
  // A placeholder-carousel scenario the user submitted on an empty composer.
  // We seed the prompt + select the template synchronously, then let an effect
  // fire submit() once both have committed (submit() reads state, not args).
  const [pendingCarouselSubmit, setPendingCarouselSubmit] = useState<{
    text: string;
    chipId: string | null;
  } | null>(null);
  const [sessionMode, setSessionMode] = useState<ChatSessionMode>('design');
  const [activeSkill, setActiveSkill] = useState<SkillSummary | null>(null);
  const [selectedMcpContexts, setSelectedMcpContexts] = useState<SelectedMcpContext[]>([]);
  const [contextWorkspaceItems, setContextWorkspaceItems] = useState<WorkspaceContextItem[]>([]);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [workingDir, setWorkingDir] = useState<string | null>(null);
  // Token paired with `workingDir` when picked through the desktop host's
  // native dialog. Spent on the post-creation working-dir POST so the
  // daemon's desktop-auth gate accepts the path. Null for web picks.
  const [workingDirToken, setWorkingDirToken] = useState<string | null>(null);
  // Read the persisted composer draft exactly once per mount (see the module
  // note above). Restoring here is what makes the prompt survive a tab switch,
  // since the whole view is torn down on every switch.
  const restoredDraftRef = useRef<{ prompt: string } | null>(null);
  if (restoredDraftRef.current === null) {
    restoredDraftRef.current = {
      prompt: readHomeComposerDraft(HOME_COMPOSER_PROMPT_KEY) ?? '',
    };
  }
  const restoredDraft = restoredDraftRef.current;
  // Global most-recently-used working directories, surfaced in the picker's
  // "Recent folders" submenu. Loaded from the daemon's app-config and bumped
  // whenever the user picks a folder.
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
    // Optimistically promote the dir to the front so the submenu updates
    // immediately; the daemon also trims/de-dupes/caps the persisted list.
    setRecentDirs((prev) => [dir, ...prev.filter((d) => d !== dir)].slice(0, 5));
    const persisted = await pushRecentLinkedDir(dir);
    setRecentDirs(persisted);
  }, []);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpLoading, setMcpLoading] = useState(!MATOS_HOME_TEMPLATES_VISIBLE);
  const [prompt, setPrompt] = useState(() => restoredDraft.prompt);
  // Persist the composer draft on every change so it survives the unmount that
  // a tab switch triggers (see the module note above). Empty values clear the
  // key rather than storing "".
  useEffect(() => {
    writeHomeComposerDraft(HOME_COMPOSER_PROMPT_KEY, prompt);
  }, [prompt]);
  // MatOS surfaces (e.g. the repository import flow) can hand a task to the
  // composer while Home stays mounted behind another entry tab: they persist
  // the draft (covers remounts) and broadcast this event (covers the mounted
  // case, where the draft restore above would never re-run).
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: unknown }>).detail;
      if (typeof detail?.prompt === 'string' && detail.prompt.trim()) {
        setPrompt(detail.prompt);
      }
    };
    window.addEventListener('matos:prefill-prompt', onPrefill);
    return () => window.removeEventListener('matos:prefill-prompt', onPrefill);
  }, []);
  const examplePromptInfoRef = useRef<ExamplePromptInfo | null>(null);
  const handleExamplePromptStatusChange = useCallback((info: ExamplePromptInfo | null) => {
    examplePromptInfoRef.current = info;
  }, []);
  const [error, setError] = useState<string | null>(null);
  // Composer in-flight guard: disables the send button, shows Sending…, and
  // swallows repeat clicks across the whole async create tail.
  const [sending, setSending] = useState(false);
  const [detailsSkill, setDetailsSkill] = useState<SkillSummary | null>(null);
  const inputRef = useRef<HomeHeroHandle | null>(null);
  const homeViewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (MATOS_HOME_TEMPLATES_VISIBLE) return;
    let cancelled = false;
    void fetchMcpServers().then((result) => {
      if (cancelled) return;
      setMcpServers(result?.servers ?? []);
      setMcpLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inline-backed contexts are already represented in the composer as `@mention`
  // pills, so they must NOT also drive the active context row — otherwise
  // selecting only an inline-mentioned resource mounts an empty row (count
  // label, no visible children) above the editor. Context-only `Use` selections
  // have no inline representation, so they are the only ones the row should
  // surface (and count).
  const contextItemCount = useMemo(() => {
    const contextOnlyMcp = selectedMcpContexts.filter(
      (item) => !item.inlineBacked,
    ).length;
    return (
      contextOnlyMcp +
      contextWorkspaceItems.length +
      stagedFiles.length
    );
  }, [
    contextWorkspaceItems.length,
    selectedMcpContexts,
    stagedFiles.length,
  ]);

  const selectableSkills = useMemo(
    () => skills.filter((skill) => !skill.aggregatesExamples),
    [skills],
  );

  const enabledMcpServers = useMemo(
    () => mcpServers.filter((server) => server.enabled),
    [mcpServers],
  );

  function focusPromptAtEnd() {
    requestAnimationFrame(() => {
      inputRef.current?.focusEnd();
    });
  }

  // "…or start a blank project": create an empty project directly — no dialog,
  // no template or prompt — and enter it.
  async function startBlankProject() {
    setError(null);
    try {
      if (onStartBlankProject) {
        await onStartBlankProject();
        return;
      }
      const { project } = await createProject({
        name: t('newproj.untitledName'),
        metadata: { kind: 'prototype', nameSource: 'untitled' },
        skillId: null,
      });
      onOpenProject(project.id);
    } catch {
      setError('Could not create a blank project. Make sure the daemon is reachable.');
    }
  }

  function handlePromptChange(nextPrompt: string) {
    setPrompt(nextPrompt);
  }

  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    setStagedFiles((current) => [...current, ...files]);
    setError(null);
    focusPromptAtEnd();
  }

  function removeStagedFile(index: number) {
    setStagedFiles((current) => current.filter((_, i) => i !== index));
  }

  function addWorkspaceContext(item: WorkspaceContextItem) {
    setContextWorkspaceItems((current) =>
      current.some((candidate) => candidate.id === item.id)
        ? current
        : [...current, item],
    );
    setError(null);
  }

  function removeWorkspaceContext(id: string) {
    setContextWorkspaceItems((current) => current.filter((item) => item.id !== id));
  }

  async function handlePickWorkingDir() {
    // On desktop the working-dir POST is gated behind a host-minted token, so
    // pick through the host bridge to capture { baseDir, token } together.
    if (isOpenDesignHostAvailable()) {
      const result = await pickHostWorkingDir();
      if (result.ok) {
        setWorkingDir(result.baseDir);
        setWorkingDirToken(result.token);
        void rememberRecentDir(result.baseDir);
        return result.baseDir;
      }
      // The user explicitly cancelled the host picker — respect that and do
      // not pop a second dialog.
      if ('canceled' in result && result.canceled) return null;
      // The host is present but could not service the pick (mixed-version
      // upgrade where the preload lacks `project.pickWorkingDir`, or a host
      // error). We must NOT fall back to openFolderDialog() here: the browser
      // dialog yields a raw path with no host-minted token, so the later
      // POST /api/projects/:id/working-dir would be rejected by the desktop
      // auth gate and surface as a confusing late create-time failure.
      // Surface the host error instead and keep the existing working dir.
      setError(
        `Couldn't open the folder picker (${'reason' in result ? result.reason : 'host unavailable'}). Please update MatOS and try again.`,
      );
      return null;
    }
    // Pure web path: no desktop host, so there is no token gate — the raw
    // browser folder path is the expected, working input.
    const picked = await openFolderDialog();
    if (picked) {
      setWorkingDir(picked);
      setWorkingDirToken(null);
      void rememberRecentDir(picked);
      return picked;
    }
    return null;
  }

  async function handlePickLocalCodeDir() {
    if (isOpenDesignHostAvailable()) {
      const result = await pickHostWorkingDir();
      if (result.ok) {
        void rememberRecentDir(result.baseDir);
        return result.baseDir;
      }
      if ('canceled' in result && result.canceled) return null;
      setError(
        `Couldn't open the folder picker (${'reason' in result ? result.reason : 'host unavailable'}). Please update MatOS and try again.`,
      );
      return null;
    }
    const picked = await openFolderDialog();
    if (picked) {
      void rememberRecentDir(picked);
      return picked;
    }
    return null;
  }

  function selectChip(chip: HomeHeroChip) {
    if (chip.action.kind !== 'create-project') return;
    setActiveSkill(null);
    setActiveChipId(chip.id);
    setActiveChipProjectKind(chip.action.projectKind);
    setActiveChipProjectMetadata(chip.action.projectMetadata ?? null);
    setError(null);
    focusPromptAtEnd();
  }

  function clearActiveChipSelection() {
    setActiveChipId(null);
    setActiveChipProjectKind(null);
    setActiveChipProjectMetadata(null);
    setError(null);
    focusPromptAtEnd();
  }

  function useSkill(skill: SkillSummary, nextPrompt: string | null) {
    clearActiveChipSelection();
    setActiveSkill(skill);
    setError(null);
    const replacement = nextPrompt ?? localizeSkillPrompt(locale, skill) ?? '';
    if (replacement.trim().length > 0) {
      setPrompt(replacement);
    }
    focusPromptAtEnd();
  }

  function useMcpServer(_server: McpServerConfig, nextPrompt: string) {
    setSelectedMcpContexts((current) => (
      current.some((item) => item.server.id === _server.id)
        ? current
        : [...current, { server: _server, inlineBacked: true }]
    ));
    setPrompt(nextPrompt);
    setError(null);
    focusPromptAtEnd();
  }

  function removeMcpContext(serverId: string) {
    const server = selectedMcpContexts.find((item) => item.server.id === serverId)?.server ?? null;
    setSelectedMcpContexts((current) => current.filter((item) => item.server.id !== serverId));
    if (server) {
      setPrompt((current) => removeContextMentionsFromPrompt(current, [
        server.label || server.id,
        server.id,
      ]));
    }
  }

  // The chip rail dispatcher. Pure UI-state mapping — the heavy lifting is
  // delegated back to existing handlers. Migration chips that don't select a
  // project kind (`open-template-picker`) forward to callbacks threaded in from
  // EntryShell.
  function pickChip(chip: HomeHeroChip) {
    setError(null);
    switch (chip.action.kind) {
      case 'create-project': {
        selectChip(chip);
        return;
      }
      case 'open-template-picker': {
        if (!onOpenNewProject) {
          setError('Template picker is not available in this shell.');
          return;
        }
        onOpenNewProject('template');
        return;
      }
    }
  }

  // Consume a one-shot Home composer chip intent. The entry shell keeps
  // HomeView mounted across view switches, so we react to the intent event
  // rather than to mount. Consuming the chip inside the event listener could
  // run `pickChip` before React commits the config change that produced the
  // intent, so we only bump a tick from the listener and consume the chip in a
  // separate effect.
  const [chipIntentTick, setChipIntentTick] = useState(0);
  useEffect(() => {
    function bumpChipIntent() {
      setChipIntentTick((tick) => tick + 1);
    }
    window.addEventListener(HOME_CHIP_INTENT_EVENT, bumpChipIntent);
    return () => window.removeEventListener(HOME_CHIP_INTENT_EVENT, bumpChipIntent);
  }, []);
  useEffect(() => {
    const chipId = consumePendingHomeChip();
    if (!chipId) return;
    const chip = findChip(chipId);
    if (chip) pickChip(chip);
    // pickChip is recreated each render; this effect runs after the commit
    // that bumped the tick, so the closure captures the latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipIntentTick]);

  // Send pressed on an empty composer while the placeholder carousel showed a
  // scenario. Select that scenario's project kind exactly as a rail pick would
  // and seed its text, then defer the create to submit().
  function submitScenario(scenario: PlaceholderScenario) {
    if (sending) return;
    setError(null);
    const chip = scenario.chipId ? findChip(scenario.chipId) : null;
    const createChip = chip?.action.kind === 'create-project' ? chip : null;
    // When the user already picked this template (the carousel-over-a-selected-
    // template case), its selection is live -- reuse it instead of re-selecting,
    // which would re-fire the chip selection.
    const alreadySelected = Boolean(createChip && activeChipId === createChip.id);
    if (createChip && !alreadySelected) {
      selectChip(createChip);
    }
    setPrompt(scenario.text);
    setPendingCarouselSubmit({
      text: scenario.text,
      chipId: createChip ? scenario.chipId : null,
    });
  }

  // Fire the deferred carousel submit once the seeded prompt AND the selected
  // chip have landed in state, so submit()'s closure reads the real values.
  useEffect(() => {
    const pending = pendingCarouselSubmit;
    if (!pending || sending) return;
    if (prompt.trim() !== pending.text.trim()) return;
    if (pending.chipId !== null && activeChipId !== pending.chipId) return;
    setPendingCarouselSubmit(null);
    void submit();
    // submit() is a stable in-component declaration; depending on it would add
    // churn without changing behavior (mirrors the chip-intent effect above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCarouselSubmit, prompt, activeChipId, sending]);

  async function submit() {
    // The send button disables itself while sending, but the Enter-to-send
    // path lands here directly — swallow re-entry during the in-flight window.
    if (sending) return;
    const trimmed = prompt.trim();
    if (!trimmed && stagedFiles.length === 0) return;
    // P0 ui_click area=chat_composer element=send_button. Fires before the
    setError(null);
    setSending(true);
    try {
      // Reconcile each selected context against the serialized prompt text
      // before forwarding it. Inline-backed contexts (inserted as `@mention`
      // pills) are only sent while their token survives in the prompt — the
      // Lexical composer lets users delete a mention pill (backspace, edit),
      // and when they do that MCP should stop being sent. Context-only `Use`
      // selections never carry a token, so they stay in the payload until the
      // user explicitly clears them.
      const contextMcpServers = selectedMcpContexts
        .filter((item) => !item.inlineBacked || mentionTokenPresent(trimmed, item.server.label || item.server.id))
        .map((item) => ({
          id: item.server.id,
          ...(item.server.label ? { label: item.server.label } : {}),
          ...(item.server.transport ? { transport: item.server.transport } : {}),
          ...(item.server.url ? { url: item.server.url } : {}),
          ...(item.server.command ? { command: item.server.command } : {}),
        }));
      // Referenced project / local-code folders are required user-selected
      // inputs. If one disappears before submit, fail loudly instead of sending
      // workspace text the daemon cannot back with `--add-dir` access.
      const contextLinkedDirCandidates = workspaceContextLinkedDirs(contextWorkspaceItems);
      const missingContextLinkedDirs =
        contextLinkedDirCandidates.length === 0
          ? []
          : (
              await Promise.all(
                contextLinkedDirCandidates.map(async (dir) => ((await dirExists(dir)) ? null : dir)),
              )
            ).filter((dir): dir is string => Boolean(dir));
      if (missingContextLinkedDirs.length > 0) {
        setError('A selected reference folder is no longer available. Remove or re-pick it before starting the run.');
        return;
      }
      const contextLinkedDirs = contextLinkedDirCandidates;
      const submittedProjectKind =
        activeChipProjectKind ?? projectKindForSkill(activeSkill) ?? 'other';
      const submittedProjectMetadata = homeCreateProjectMetadata(
        submittedProjectKind,
        activeChipProjectMetadata,
      );
      const resolvedSkillId = activeSkill?.id ?? null;
      // The example-prompt override is a one-shot marker. Decide whether to
      // send it now, but defer spending the marker until the create is
      // accepted — a rejected attempt stays retryable and must resend it.
      const examplePromptKey = 'od:example-prompt-used';
      const examplePromptToSend =
        examplePromptInfoRef.current != null && localStorage.getItem(examplePromptKey) == null
          ? examplePromptInfoRef.current
          : null;
      const accepted = await onSubmit({
        prompt: trimmed,
        skillId: resolvedSkillId,
        projectKind: submittedProjectKind,
        projectMetadata: submittedProjectMetadata,
        contextMcpServers,
        ...(contextWorkspaceItems.length > 0
          ? { initialRunContext: { workspaceItems: contextWorkspaceItems } }
          : {}),
        attachments: stagedFiles,
        ...(workingDir ? { workingDir } : {}),
        ...(workingDirToken ? { workingDirToken } : {}),
        ...(contextLinkedDirs.length > 0 ? { linkedDirs: contextLinkedDirs } : {}),
        conversationMode: sessionMode,
        ...(examplePromptToSend ? { examplePromptContext: examplePromptToSend } : {}),
      });
      if (accepted === false) {
        setError('Failed to start the run. The project was not created or opened correctly. Refresh the page and try again.');
        return;
      }
      setError(null);
      // Create accepted — now it is safe to spend the one-shot marker.
      if (examplePromptToSend) localStorage.setItem(examplePromptKey, '1');
      // The draft has become a real run; drop it synchronously (before the
      // navigation unmounts us) so the sent prompt + pick don't reappear the
      // next time the Home tab mounts.
      clearHomeComposerDraft();
      // Only drop the staged contexts once the run actually started — a
      // rejected creation keeps them so the retry sends the same payload.
      setSelectedMcpContexts([]);
      setContextWorkspaceItems([]);
    } catch (err) {
      // A submit handler that throws (instead of resolving false) lands on
      // the same recovery path as a rejected creation.
      console.warn('Home composer submit failed', err);
      setError(homeSubmitErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="home-view"
      data-testid="home-view"
      ref={homeViewRef}
    >
      <HomeHero
        ref={inputRef}
        active={isActive}
        firstRunGuide={projectsLoading ? undefined : projects.length === 0}
        prompt={prompt}
        onPromptChange={handlePromptChange}
        onSubmit={submit}
        onSubmitScenario={submitScenario}
        sessionMode={sessionMode}
        onSessionModeChange={setSessionMode}
        submitting={sending}
        activeSkillId={activeSkill?.id ?? null}
        activeSkillTitle={activeSkill ? localizeSkillName(locale, activeSkill) : null}
        activeSkillRecord={activeSkill}
        activeChipId={activeChipId}
        onClearActiveChip={clearActiveChipSelection}
        onClearActiveSkill={() => setActiveSkill(null)}
        selectedMcpContexts={selectedMcpContexts.map((item) => item.server)}
        contextOnlyMcpServers={selectedMcpContexts.filter((item) => !item.inlineBacked).map((item) => item.server)}
        contextWorkspaceItems={contextWorkspaceItems}
        onRemoveMcpContext={removeMcpContext}
        onAddWorkspaceContext={addWorkspaceContext}
        onRemoveWorkspaceContext={removeWorkspaceContext}
        onAddMcp={onOpenMcp}
        onOpenSkillDetails={setDetailsSkill}
        matosRoles={matosRoles}
        matosRolesLoading={matosRolesLoading}
        selectedMatosRoleId={selectedMatosRoleId}
        onMatosRoleChange={onMatosRoleChange}
        stagedFiles={stagedFiles}
        onAddFiles={stageFiles}
        onRemoveFile={removeStagedFile}
        skillOptions={selectableSkills}
        skillsLoading={skillsLoading}
        mcpOptions={enabledMcpServers}
        mcpLoading={mcpLoading}
        onPickSkill={useSkill}
        onPickMcp={useMcpServer}
        onPickChip={pickChip}
        contextItemCount={contextItemCount}
        error={error}
        workingDir={workingDir}
        recentDirs={recentDirs}
        onPickWorkingDir={handlePickWorkingDir}
        onPickLocalCodeDir={handlePickLocalCodeDir}
        onSelectRecentWorkingDir={(dir) => {
          setWorkingDir(dir);
          // Recents come from the browser-side picker only; they carry no
          // desktop trust token (and linkedDirs don't need one).
          setWorkingDirToken(null);
          void rememberRecentDir(dir);
        }}
        onClearWorkingDir={() => {
          setWorkingDir(null);
          setWorkingDirToken(null);
        }}
        onExamplePromptStatusChange={handleExamplePromptStatusChange}
        onStartBlankProject={() => {
          void startBlankProject();
        }}
        executionSwitcher={executionSwitcher}
      />

      <RecentProjectsStrip
        nativeMatOSChat={nativeMatOSChat}
        projects={projects}
        {...(projectsLoading !== undefined ? { loading: projectsLoading } : {})}
        onOpen={(id) => {
          const project = projects.find((p) => p.id === id);
                    onOpenProject(id);
        }}
        onViewAll={() => {
                    onViewAllProjects();
        }}
        {...(onDeleteProject ? { onDelete: onDeleteProject } : {})}
        {...(onDuplicateProject ? { onDuplicate: onDuplicateProject } : {})}
        {...(onRenameProject ? { onRename: onRenameProject } : {})}
      />

      <HomeTemplatesReveal
        enabled={!projectsLoading && projects.length === 0}
      >
        <MatOSAssetsHomeSection />
      </HomeTemplatesReveal>

      <AnimatePresence>
        {detailsSkill ? (
          <SkillDetailsModal
            skillId={detailsSkill.id}
            summary={detailsSkill}
            onClose={() => setDetailsSkill(null)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function projectKindForSkill(skill: SkillSummary | null): ProjectKind | null {
  if (!skill) return null;
  if (skill.mode === 'deck') return 'deck';
  if (skill.mode === 'prototype') return 'prototype';
  if (skill.mode === 'template') return 'template';
  if (skill.mode === 'image' || skill.surface === 'image') return 'image';
  if (skill.mode === 'video' || skill.surface === 'video') return 'video';
  if (skill.mode === 'audio' || skill.surface === 'audio') return 'audio';
  return 'other';
}

function homeCreateProjectMetadata(
  projectKind: ProjectKind | null,
  existing: ProjectMetadata | null,
): ProjectMetadata {
  const kind = projectKind ?? existing?.kind ?? 'other';

  // Artifact-specific settings (fidelity, speaker notes, slide count, …) are
  // not collected in the home composer; the agent asks for them via
  // question-form, so we only seed `kind` here and let those fields stay
  // unset (the system prompt then marks them "unknown — ask").
  const next: ProjectMetadata = {
    ...(existing ?? {}),
    kind,
  };
  return next;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeContextMentionsFromPrompt(prompt: string, labels: string[]): string {
  const uniqueLabels = Array.from(new Set(labels.filter(Boolean)));
  return uniqueLabels.reduce((current, label) => {
    const token = inlineMentionToken(label);
    return current.replace(
      new RegExp(`(^|[\\s([{"'])${escapeRegExp(token)}(?=$|\\s|[.,;:!?)}\\]"'])([^\\S\\r\\n])?`, 'g'),
      '$1',
    );
  }, prompt);
}
