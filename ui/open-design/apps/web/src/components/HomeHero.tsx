// Lovart-style centered hero for the entry Home view.
//
// The prompt textarea is the canonical creation surface: the user
// either types freely or selects a type below to reveal matching
// starters, then presses Run / Enter to spawn a project. The hero is
// kept dependency-free (no project list) so it can be composed with the
// recent-projects strip without owning that data lifecycle.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  ReactNode,
  RefObject,
} from 'react';
import type {
  AgentModelOption,
  ChatSessionMode,
  McpServerConfig,
  WorkspaceContextItem,
} from '@open-design/contracts';
import { MatOSRolePicker } from './MatOSRolePicker';
import type { SkillSummary } from '../types';
import { Icon, type IconName } from './Icon';
import {
  chipsForGroup,
  orderedCreateChips,
  type ChipGroup,
  type HomeHeroChip,
} from './home-hero/chips';
import { homeHeroChipLabel } from './home-hero/chip-labels';
import { MATOS_TEMPLATE_CHIPS, type MatOSTemplateChip } from './home-hero/matos-chips';
import { MATOS_HOME_TEMPLATES_VISIBLE } from '../features/matosHomeTemplates';
import { createMatOSAssetProject } from '../matos-asset-projects';
import { ScenarioArt } from './home-hero/ScenarioArt';
import { useEdgeAutoScroll, EdgeScrollZones } from './home-hero/EdgeAutoScroll';
import {
  inlineMentionToken,
  type InlineMentionEntity,
} from '../utils/inlineMentions';
import { useI18n, useT } from '../i18n';
import { MATOS_PRODUCT_NAME } from '../branding';
import type { Locale } from '../i18n/types';
import {
  localizeSkillDescription,
  localizeSkillName,
} from '../i18n/content';
import { readHomeGuideStage, writeHomeGuideStage } from './home-hero/firstRunGuide';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { ContextChipHoverCard } from './ContextChipHoverCard';
import { workspaceContextDetailLine, workspaceContextKindLabel } from './workspace-context';
import { TemplatePicker } from './home-hero/TemplatePicker';
import { SessionModeToggle } from './SessionModeToggle';
import { WorkingDirPicker } from './WorkingDirPicker';
import {
  ProjectReferenceModal,
  type ProjectReferenceSelection,
} from './ProjectReferenceModal';
import {
  LexicalComposerInput,
  type LexicalComposerInputHandle,
  type CaretRect,
} from './composer/LexicalComposerInput';
import { CaretFloatingLayer } from './composer/CaretFloatingLayer';
import { PlaceholderCarousel } from './home-hero/PlaceholderCarousel';
import {
  buildPlaceholderScenarios,
  MATOS_PLACEHOLDER_BASE_HINT_KEY,
  MATOS_PLACEHOLDER_SCENARIO_DEFS,
  PLACEHOLDER_BASE_HINT_KEY,
  type PlaceholderScenario,
} from './home-hero/placeholderScenarios';

// MatOS product mode swaps the composer's rotating example lines from the
// upstream design scenarios to materials-science task lines, and swaps the
// idle hint away from "link your design system" wording. Upstream tests mock
// the feature flag to false, keeping the original rotation covered.
const CAROUSEL_BASE_HINT_KEY = MATOS_HOME_TEMPLATES_VISIBLE
  ? MATOS_PLACEHOLDER_BASE_HINT_KEY
  : PLACEHOLDER_BASE_HINT_KEY;

export interface HomeHeroSubmitHandler {
  (): void;
}

// The homepage prompt input now shares the project composer's Lexical
// editor, so the forwarded handle is a small focus surface rather than a
// raw <textarea>. HomeView drives `focusEnd()` after seeding a prompt
// example.
export interface HomeHeroHandle {
  focus(): void;
  focusEnd(): void;
  // Flash the send button twice — fired after an example-prompt card seeds
  // the composer, to pull the eye to the next step.
  pulseSend(): void;
}

export interface ExamplePromptInfo {
  title: string;
  artifactType: string;
  brief: Record<string, string>;
}

interface Props {
  active?: boolean;
  // Arms the first-run guidance trail (prototype chip → first preset
  // card sheen). Tri-state: true = brand-new user (no projects), false =
  // existing user, undefined = projects still loading — the guide neither
  // arms nor completes until the answer is known.
  firstRunGuide?: boolean;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: HomeHeroSubmitHandler;
  // Send pressed on an EMPTY composer while the placeholder carousel is
  // showing: the host seeds the prompt with `scenario.text`, binds the
  // scenario's template, and creates the project -- one-click "just start".
  onSubmitScenario?: (scenario: PlaceholderScenario) => void;
  sessionMode?: ChatSessionMode;
  onSessionModeChange?: (mode: ChatSessionMode) => void;
  activeChipId: string | null;
  onClearActiveChip?: () => void;
  activeSkillId?: string | null;
  activeSkillTitle?: string | null;
  activeSkillRecord?: SkillSummary | null;
  onClearActiveSkill?: () => void;
  selectedMcpContexts?: McpServerConfig[];
  // Context-only selections (staged through the plain `Use` action, no inline
  // @mention pill). These have no in-prompt representation, so the active row
  // renders a removable chip for each — otherwise a kept-in-payload context
  // would be invisible and unremovable (silent context drift).
  contextOnlyMcpServers?: McpServerConfig[];
  contextWorkspaceItems?: WorkspaceContextItem[];
  onRemoveMcpContext?: (serverId: string) => void;
  onAddWorkspaceContext?: (item: WorkspaceContextItem) => void;
  onRemoveWorkspaceContext?: (id: string) => void;
  onAddMcp?: () => void;
  onOpenSkillDetails?: (skill: SkillSummary) => void;
  // MatOS role selection, surfaced as a borderless picker in the row below
  // the composer (next to the working-directory picker). Replaces the
  // upstream design-system picker on Home: the choice drives which MatOS
  // role (`matos --role <ref>`) executes the conversation started here.
  // `null` = "Default role (MatOS env)".
  matosRoles?: AgentModelOption[];
  matosRolesLoading?: boolean;
  selectedMatosRoleId?: string | null;
  onMatosRoleChange?: (id: string | null) => void;
  stagedFiles?: File[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  skillOptions?: SkillSummary[];
  skillsLoading?: boolean;
  mcpOptions?: McpServerConfig[];
  mcpLoading?: boolean;
  submitDisabled?: boolean;
  // True while the submitted run is still creating its project/conversation
  // (#4082). Distinct from `submitDisabled`: it swaps the send button into a
  // visible Sending… state instead of leaving it silently idle.
  submitting?: boolean;
  onPickSkill?: (skill: SkillSummary, nextPrompt: string | null) => void;
  onPickMcp?: (server: McpServerConfig, nextPrompt: string) => void;
  onPickChip: (chip: HomeHeroChip) => void;
  contextItemCount: number;
  error: string | null;
  workingDir?: string | null;
  recentDirs?: string[];
  onPickWorkingDir?: () => Promise<string | null> | string | null | void;
  onPickLocalCodeDir?: () => Promise<string | null> | string | null | void;
  onSelectRecentWorkingDir?: (dir: string) => void;
  onClearWorkingDir?: () => void;
  onExamplePromptStatusChange?: (info: ExamplePromptInfo | null) => void;
  // "…or start a blank project" — creates an empty project directly (no dialog,
  // no design system / template / prompt) and enters it. Omit to hide the link.
  onStartBlankProject?: () => void;
  executionSwitcher?: ReactNode;
}

type HomeMentionTab = 'all' | 'files' | 'skills' | 'mcp';

// In the combined "All" overview, every surface is capped to a handful of top
// matches so no single section floods the picker. The dedicated "Design files"
// tab is exempt: staged files are the user's own finite content, so that tab
// lists every match (the results panel scrolls) and its count reflects the true
// total rather than the truncated preview.
const HOME_MENTION_ALL_TAB_PREVIEW = 6;

interface HomeMentionOption {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  meta: string;
  onPick: () => void;
}

interface HomeMentionSection {
  id: Exclude<HomeMentionTab, 'all'>;
  label: string;
  options: HomeMentionOption[];
}

interface SelectedPromptExample {
  label: string;
  promptText: string;
}

const EMPTY_MATOS_ROLES: AgentModelOption[] = [];
const EMPTY_STAGED_FILES: File[] = [];
const EMPTY_SKILLS: SkillSummary[] = [];
const EMPTY_MCP_OPTIONS: McpServerConfig[] = [];
const EMPTY_WORKSPACE_ITEMS: WorkspaceContextItem[] = [];

export const HomeHero = forwardRef<HomeHeroHandle, Props>(function HomeHero(
  {
    active = true,
    prompt,
    onPromptChange,
    onSubmit,
    onSubmitScenario = () => undefined,
    sessionMode = 'design',
    onSessionModeChange,
    firstRunGuide,
    activeSkillId = null,
    activeSkillTitle = null,
    activeSkillRecord = null,
    activeChipId,
    onClearActiveChip = () => undefined,
    onClearActiveSkill = () => undefined,
    contextOnlyMcpServers = EMPTY_MCP_OPTIONS,
    contextWorkspaceItems = EMPTY_WORKSPACE_ITEMS,
    onRemoveMcpContext = () => undefined,
    onAddWorkspaceContext = () => undefined,
    onRemoveWorkspaceContext = () => undefined,
    onAddMcp = () => undefined,
    onOpenSkillDetails = () => undefined,
    matosRoles = EMPTY_MATOS_ROLES,
    matosRolesLoading = false,
    selectedMatosRoleId = null,
    onMatosRoleChange,
    stagedFiles = EMPTY_STAGED_FILES,
    onAddFiles = () => undefined,
    onRemoveFile = () => undefined,
    skillOptions = EMPTY_SKILLS,
    skillsLoading = false,
    mcpOptions = EMPTY_MCP_OPTIONS,
    mcpLoading = false,
    submitDisabled = false,
    submitting = false,
    onPickSkill = () => undefined,
    onPickMcp = () => undefined,
    onPickChip,
    contextItemCount,
    error,
    workingDir = null,
    recentDirs = [],
    onPickWorkingDir,
    onPickLocalCodeDir,
    onSelectRecentWorkingDir,
    onClearWorkingDir,
    onExamplePromptStatusChange,
    onStartBlankProject,
    executionSwitcher,
  },
  ref,
) {
  const { locale, t } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionTab, setMentionTab] = useState<HomeMentionTab>('all');
  const [dragActive, setDragActive] = useState(false);
  const [projectReferenceOpen, setProjectReferenceOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const homeHeroRef = useRef<HTMLElement | null>(null);
  // Two-flash attention pulse on the send button; armed via the
  // imperative `pulseSend()` handle, cleared when the animation ends.
  const [sendAttention, setSendAttention] = useState(false);
  // First-run guidance trail (see home-hero/firstRunGuide.ts): which rail
  // chip is pulsing, and whether the first example-prompt card is pulsing.
  const [guidePulseChipId, setGuidePulseChipId] = useState<string | null>(null);
  const [guidePulseFirstPreset, setGuidePulseFirstPreset] = useState(false);
  // Footer Template pill preview: the create-rail card the pointer is over,
  // so hovering a card below previews it in the pill (cleared on rail-leave).
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);
  // A committed pick or Clear must win over a lingering hover-preview. The rail
  // that sets previewTemplateId unmounts the instant a template becomes active,
  // so its onMouseLeave never fires; without this reset the stale preview keeps
  // the pill showing the old template even after Clear nulls the value.
  useEffect(() => {
    setPreviewTemplateId(null);
  }, [activeChipId]);
  const [selectedPromptExample, setSelectedPromptExample] = useState<SelectedPromptExample | null>(null);
  const [previewHomeFileKey, setPreviewHomeFileKey] = useState<string | null>(null);
  const [stagedFilePreviewUrls, setStagedFilePreviewUrls] = useState<Map<string, string>>(() => new Map());
  // Lexical-driven @-trigger state (replaces the old end-anchored
  // getContextMention regex) + the caret box the popover anchors to.
  const [mentionTrigger, setMentionTrigger] = useState<{ query: string } | null>(null);
  const [caretRect, setCaretRect] = useState<CaretRect | null>(null);
  // The scenario the placeholder carousel is currently showing. A Send on an
  // empty composer submits THIS scenario's text + template (see handleSend).
  const [carouselScenario, setCarouselScenario] = useState<PlaceholderScenario | null>(null);
  const editorRef = useRef<LexicalComposerInputHandle | null>(null);
  const promptEditorRef = useRef<HTMLDivElement | null>(null);
  const mentionPickerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shortcutsMenuRef = useRef<HTMLDivElement>(null);
  const canSubmit =
    (prompt.trim().length > 0 || stagedFiles.length > 0) && !submitDisabled && !submitting;
  const previewHomeFile = useMemo(() => {
    if (!previewHomeFileKey) return null;
    return stagedFiles.find((file, index) => homeFileKey(file, index) === previewHomeFileKey) ?? null;
  }, [previewHomeFileKey, stagedFiles]);
  const previewHomeFileUrl = previewHomeFileKey ? stagedFilePreviewUrls.get(previewHomeFileKey) ?? null : null;
  const placeholder = activeSkillTitle
    ? t('homeHero.placeholderActive')
    : t('homeHero.placeholder');
  const mentionActive = Boolean(mentionTrigger);
  const mentionQuery = mentionTrigger?.query ?? '';
  // Scenarios the carousel cycles, with copy resolved through `t()` so the
  // typed placeholder AND the submitted query follow the locale. With a
  // create-template chip selected we narrow to that template's scenarios (so
  // the suggestions match the picked output and a submit keeps that template);
  // with nothing bound we cycle the full set. Memoised by chip + locale so the
  // reference only changes on a real switch, which restarts the carousel.
  const carouselScenarios = useMemo<PlaceholderScenario[]>(() => {
    return buildPlaceholderScenarios({
      activeChipId,
      resolveTextKey: (key) => t(key),
      examplesForChip: (chipId) => homeHeroChipPromptExamples(chipId, locale),
      fallbackForChip: (chipId) => fallbackPlaceholderScenarioText(chipId, locale, t),
      // MatOS mode rotates materials-science task lines instead of the
      // upstream design scenarios (see MATOS_PLACEHOLDER_SCENARIO_DEFS).
      ...(MATOS_HOME_TEMPLATES_VISIBLE
        ? { scenarioDefs: MATOS_PLACEHOLDER_SCENARIO_DEFS }
        : {}),
    });
  }, [activeChipId, locale, t]);
  // The placeholder carousel runs while the composer is empty and nothing
  // OTHER than a create-template chip is bound. A selected template keeps it
  // alive (showing that template's scenarios); only an explicit skill pick —
  // which owns its own placeholder — or a non-empty composer stops it.
  // Template types without curated carousel lines fall back to their localized
  // prompt examples, then to a localized chip-label prompt. That keeps every
  // create template submittable from an empty composer instead of silently
  // disabling Send.
  const carouselActive =
    active &&
    !submitting &&
    !submitDisabled &&
    prompt.trim().length === 0 &&
    stagedFiles.length === 0 &&
    !activeSkillTitle &&
    !mentionActive &&
    carouselScenarios.length > 0;
  // Empty composer, but the carousel is offering a runnable scenario from the
  // CURRENT pool: Send stays highlighted and submits that scenario instead of
  // sitting disabled. The membership check guards the brief window after a
  // template switch before the carousel reports the new pool's first scenario.
  const carouselSubmittable =
    carouselActive &&
    carouselScenario !== null &&
    carouselScenarios.some((scenario) => scenario.id === carouselScenario.id);
  const sendEnabled = canSubmit || carouselSubmittable;
  function handleSend() {
    if (submitting || submitDisabled) return;
    if (canSubmit) {
      onSubmit();
      return;
    }
    if (carouselSubmittable && carouselScenario) onSubmitScenario(carouselScenario);
  }
  const fileMatches = useMemo(
    () =>
      mentionActive
        ? stagedFiles
            .map((file, index) => ({ file, index }))
            .filter(({ file }) => fileMatchesQuery(file, mentionQuery))
        : [],
    [mentionActive, mentionQuery, stagedFiles],
  );
  const skillMatches = useMemo(
    () =>
      mentionActive
        ? skillOptions.filter((skill) => skillMatchesQuery(skill, mentionQuery, locale))
        : [],
    [locale, mentionActive, mentionQuery, skillOptions],
  );
  const mcpMatches = useMemo(
    () =>
      mentionActive
        ? mcpOptions.filter((server) => mcpServerMatchesQuery(server, mentionQuery)).slice(0, 6)
        : [],
    [mcpOptions, mentionActive, mentionQuery],
  );
  const pickerOpen = active && mentionActive;
  const tabs: Array<{ id: HomeMentionTab; label: string; count: number }> = [
    // The All overview previews at most HOME_MENTION_ALL_TAB_PREVIEW files, so
    // its badge counts the previewed slice — not the full staged total — to keep
    // the count aligned with what that tab actually renders. The dedicated files
    // tab below lists every match and reports the true total.
    { id: 'all', label: t('common.all'), count: Math.min(fileMatches.length, HOME_MENTION_ALL_TAB_PREVIEW) + skillMatches.length + mcpMatches.length },
    { id: 'files', label: t('chat.mentionTabFiles'), count: fileMatches.length },
    { id: 'skills', label: t('homeHero.skills'), count: skillMatches.length },
    { id: 'mcp', label: 'MCP', count: mcpMatches.length },
  ];
  const showFiles = mentionTab === 'all' || mentionTab === 'files';
  const showSkills = mentionTab === 'all' || mentionTab === 'skills';
  const showMcp = mentionTab === 'all' || mentionTab === 'mcp';
  const visibleSections: HomeMentionSection[] = [
    showFiles
      ? {
          id: 'files',
          label: t('chat.mentionSectionFiles'),
          options: (mentionTab === 'files' ? fileMatches : fileMatches.slice(0, HOME_MENTION_ALL_TAB_PREVIEW)).map(({ file, index }) => ({
            id: `file-${index}-${file.name}`,
            icon: isImageFile(file) ? 'image' : 'file',
            title: file.name,
            description: file.type || t('chat.mentionTabFiles'),
            meta: formatFileSize(file.size),
            onPick: () => pickFile(file),
          })),
        }
      : null,
    showSkills
      ? {
          id: 'skills',
          label: t('homeHero.skills'),
          options: skillMatches.map((skill) => ({
            id: `skill-${skill.id}`,
            icon: skill.id === activeSkillId ? 'check' : 'file',
            title: localizeSkillName(locale, skill),
            description: localizeSkillDescription(locale, skill) || skill.id,
            meta: skill.id === activeSkillId ? t('common.active') : skill.mode,
            onPick: () => pickSkill(skill),
          })),
        }
      : null,
    showMcp
      ? {
          id: 'mcp',
          label: 'MCP',
          options: mcpMatches.map((server) => ({
            id: `mcp-${server.id}`,
            icon: 'link',
            title: server.label || server.id,
            description: server.url || server.command || server.id,
            meta: server.transport,
            onPick: () => pickMcp(server),
          })),
        }
      : null,
  ].filter((section): section is HomeMentionSection => Boolean(section?.options.length));
  const visiblePickerOptions = visibleSections.flatMap((section) => section.options);
  const visibleLoading =
    (mentionTab === 'all' && (skillsLoading || mcpLoading)) ||
    (mentionTab === 'skills' && skillsLoading) ||
    (mentionTab === 'mcp' && mcpLoading);
  const promptMentionEntities = useMemo(
    () =>
      buildHomeMentionEntities({
        activeSkillId,
        activeSkillTitle,
        mcpOptions,
        contextWorkspaceItems,
        stagedFiles,
        skillOptions,
      }),
    [
      activeSkillId,
      activeSkillTitle,
      mcpOptions,
      contextWorkspaceItems,
      stagedFiles,
      skillOptions,
    ],
  );
  const activeCreateChip = useMemo(
    () => activeChipId
      ? chipsForGroup('create').find((chip) => chip.id === activeChipId) ?? null
      : null,
    [activeChipId],
  );
  // Footer Template picker options: the ordered create-scenario chips (pure
  // project-type templates — Slides / Prototype / Wireframe / Document / …).
  // Excludes action chips that navigate away instead of selecting a project
  // kind, so the dropdown matches the rail's template set.
  const templateChips = useMemo(
    () => orderedCreateChips().filter((chip) => chip.action.kind === 'create-project'),
    [],
  );

  // First-run guide, beat 1: pulse the Prototype chip for brand-new users.
  // The settle delay lets the hero finish its entrance before the sheen.
  useEffect(() => {
    if (firstRunGuide !== true) return;
    if (readHomeGuideStage() !== 'chip') return;
    const arm = window.setTimeout(() => setGuidePulseChipId('prototype'), 900);
    const disarm = window.setTimeout(() => setGuidePulseChipId(null), 3600);
    return () => {
      window.clearTimeout(arm);
      window.clearTimeout(disarm);
    };
  }, [firstRunGuide]);

  // Users with existing projects never see the trail — complete ANY
  // unfinished stage silently. A chip pick during the loading window can
  // move the stage to 'card' before we know the user is not new, so 'chip'
  // alone is not enough to close off.
  useEffect(() => {
    if (firstRunGuide !== false) return;
    if (readHomeGuideStage() !== 'done') writeHomeGuideStage('done');
  }, [firstRunGuide]);

  const activePromptExamples = useMemo(
    () => activeChipId
      ? homeHeroChipPromptExamples(activeChipId, locale)
      : [],
    [activeChipId, locale],
  );

  // Beat 2: once the picked chip's example cards render, pulse the first
  // card exactly once, then the trail is done (the send pulse takes over
  // after a card pick).
  useEffect(() => {
    if (firstRunGuide !== true) return;
    if (readHomeGuideStage() !== 'card') return;
    if (!activeChipId || activePromptExamples.length === 0) return;
    const arm = window.setTimeout(() => {
      setGuidePulseFirstPreset(true);
      writeHomeGuideStage('done');
    }, 500);
    const disarm = window.setTimeout(() => setGuidePulseFirstPreset(false), 3200);
    return () => {
      window.clearTimeout(arm);
      window.clearTimeout(disarm);
    };
  }, [firstRunGuide, activeChipId, activePromptExamples.length]);
  const inputCardStyle = {
    '--home-hero-prompt-max-height': `${HOME_HERO_PROMPT_MAX_HEIGHT}px`,
  } as CSSProperties;

  useEffect(() => {
    if (selectedIndex >= visiblePickerOptions.length) setSelectedIndex(0);
  }, [selectedIndex, visiblePickerOptions.length]);

  useEffect(() => {
    if (!pickerOpen) return;
    const isInsideMentionSurface = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return (
        promptEditorRef.current?.contains(target) ||
        mentionPickerRef.current?.contains(target)
      );
    };
    const closePicker = () => {
      setMentionTrigger(null);
      setMentionTab('all');
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!isInsideMentionSurface(event.target)) closePicker();
    };
    const closeOnOutsideMouse = (event: MouseEvent) => {
      if (!isInsideMentionSurface(event.target)) closePicker();
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      if (!isInsideMentionSurface(event.target)) closePicker();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('mousedown', closeOnOutsideMouse, true);
    document.addEventListener('focusin', closeOnOutsideFocus);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('mousedown', closeOnOutsideMouse, true);
      document.removeEventListener('focusin', closeOnOutsideFocus);
    };
  }, [pickerOpen]);

  useEffect(() => {
    setSelectedPromptExample(null);
  }, [activeChipId]);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shortcutsMenuRef.current?.contains(target)) return;
      // The dropdown is portaled to <body>, so it's outside shortcutsMenuRef;
      // recognize it explicitly or a click on a menu item would close the menu
      // before the item's handler runs.
      if (target instanceof Element && target.closest('[data-shortcuts-panel]')) return;
      setShortcutsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [shortcutsOpen]);

  useEffect(() => {
    const urls = new Map<string, string>();
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      stagedFiles.forEach((file, index) => {
        if (isImageFile(file)) urls.set(homeFileKey(file, index), URL.createObjectURL(file));
      });
    }
    setStagedFilePreviewUrls(urls);
    return () => {
      if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stagedFiles]);

  useEffect(() => {
    if (previewHomeFileKey && !previewHomeFile) setPreviewHomeFileKey(null);
  }, [previewHomeFileKey, previewHomeFile]);

  useEffect(() => {
    if (!previewHomeFileKey) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreviewHomeFileKey(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewHomeFileKey]);

  // Shared by the imperative pulseSend() handle and the component-internal
  // static prompt-example path — every "composer just got seeded" flow shows
  // the same Send cue.
  function triggerSendAttention() {
    // Drop the class for a frame so a pulse requested mid-animation
    // restarts instead of being swallowed.
    setSendAttention(false);
    requestAnimationFrame(() => setSendAttention(true));
  }

  useImperativeHandle(
    ref,
    (): HomeHeroHandle => ({
      focus() {
        editorRef.current?.focus();
      },
      focusEnd() {
        editorRef.current?.focus();
      },
      pulseSend() {
        triggerSendAttention();
      },
    }),
    [],
  );

  // Insert an atomic @mention pill at the active trigger and return the
  // editor's new serialized text. The pill replaces the in-flight `@query`
  // (Lexical's insertMention handles the range), so callers can forward the
  // resulting text to the host pick handler without computing offsets.
  function insertHomeMention(token: string, entity: InlineMentionEntity): string {
    editorRef.current?.insertMention({ token, entity });
    return editorRef.current?.getText() ?? prompt;
  }

  function pickFile(file: File) {
    const token = inlineMentionToken(file.name);
    insertHomeMention(token, { id: file.name, kind: 'file', label: file.name, token });
    setSelectedIndex(0);
    // The file is already staged; the editor's onChange has updated the
    // prompt text, so there is nothing else to forward to the host.
  }

  function pickSkill(skill: SkillSummary) {
    const token = inlineMentionToken(skill.name);
    const next = insertHomeMention(token, {
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      token,
    });
    onPickSkill(skill, next);
  }

  function pickMcp(server: McpServerConfig) {
    const label = server.label || server.id;
    const token = inlineMentionToken(label);
    const next = insertHomeMention(token, { id: server.id, kind: 'mcp', label, token });
    onPickMcp(server, next);
  }

  function insertInlineMentionSeparator() {
    const current = editorRef.current?.getText() ?? prompt;
    if (current.trim() && !/\s$/.test(current)) {
      editorRef.current?.insertText(' ');
    }
  }

  function appendWorkspacePrompt(item: WorkspaceContextItem) {
    onAddWorkspaceContext(item);
    insertInlineMentionSeparator();
    editorRef.current?.insertMention({
      token: inlineMentionToken(item.label),
      entity: { id: item.id, kind: 'workspace', label: item.label },
    });
    onPromptChange(editorRef.current?.getText() ?? prompt);
    dismissMentionPicker();
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  function handleReferenceProjects(selections: ProjectReferenceSelection[]) {
    for (const selection of selections) {
      const path = selection.resolvedDir.trim();
      const label = selection.project.name || selection.project.id;
      appendWorkspacePrompt(
        {
          id: `project:${selection.project.id}`,
          kind: 'project',
          label,
          title: label,
          path: selection.project.id,
          ...(path ? { absolutePath: path } : {}),
        }
      );
    }
    setProjectReferenceOpen(false);
      }

  async function handleLinkLocalCodeContext() {
    const selected = await onPickLocalCodeDir?.();
    if (!selected) {
            return;
    }
    const label = selected.split(/[/\\]/).filter(Boolean).pop() || selected;
    appendWorkspacePrompt(
      {
        id: `local-code:${selected}`,
        kind: 'local-code',
        label,
        title: label,
        path: selected,
        absolutePath: selected,
      }
    );
      }

  // Lexical reports the active @-trigger derived from the caret. HomeHero
  // has no slash surface, so only the mention branch is wired.
  function handleTrigger({
    mention: nextMention,
    anchorRect,
  }: {
    mention: { q: string } | null;
    slash: { q: string } | null;
    anchorRect: CaretRect | null;
  }) {
    if (!active) {
      setCaretRect(null);
      setMentionTrigger(null);
      setMentionTab('all');
      return;
    }
    setCaretRect(anchorRect);
    if (nextMention) {
      setMentionTrigger((prev) => {
        if (!prev || prev.query !== nextMention.q) setSelectedIndex(0);
        return { query: nextMention.q };
      });
    } else {
      setMentionTrigger(null);
      setMentionTab('all');
    }
  }

  function dismissMentionPicker() {
    setMentionTrigger(null);
    setMentionTab('all');
    setSelectedIndex(0);
  }

  useEffect(() => {
    if (!active) dismissMentionPicker();
  }, [active]);

  // Routes popover navigation keys from the Lexical editor over the visible
  // picker option union. Returns true when consumed so the editor can
  // preventDefault.
  function handlePopoverKey(
    key: 'ArrowDown' | 'ArrowUp' | 'Tab' | 'Enter' | 'Escape',
  ): boolean {
    if (!mentionActive) return false;
    if (key === 'Escape') {
      setMentionTrigger(null);
      return true;
    }
    if (visiblePickerOptions.length === 0) return false;
    if (key === 'ArrowDown') {
      setSelectedIndex((idx) => (idx + 1) % visiblePickerOptions.length);
      return true;
    }
    if (key === 'ArrowUp') {
      setSelectedIndex(
        (idx) => (idx - 1 + visiblePickerOptions.length) % visiblePickerOptions.length,
      );
      return true;
    }
    if (key === 'Tab' || key === 'Enter') {
      const selected = visiblePickerOptions[selectedIndex] ?? visiblePickerOptions[0];
      if (selected) selected.onPick();
      return true;
    }
    return false;
  }

  function handleFiles(files: File[]) {
    if (files.length === 0) return;
    onAddFiles(files);
  }


  function removeFileChip(index: number, file: File) {
    const nextPrompt = stripHomeMentionToken(prompt, file.name);
    if (nextPrompt !== prompt) onPromptChange(nextPrompt);
    onRemoveFile(index);
  }

  function usePromptExample(example: string) {
        setSelectedPromptExample({
      label: promptExampleChipLabel(example),
      promptText: example,
    });
    onExamplePromptStatusChange?.({
      title: promptExampleChipLabel(example),
      artifactType: activeChipId ?? 'prototype',
      brief: briefForChipId(activeChipId ?? 'prototype'),
    });
    onPromptChange(example);
    editorRef.current?.setText(example);
    setSelectedIndex(0);
    requestAnimationFrame(() => editorRef.current?.focus());
    triggerSendAttention();
  }

  // MatOS template rail dispatcher: asset templates spawn an asset-editing
  // project (agent chat + seeded draft), project templates pre-fill the
  // composer or jump to the import workbench.
  function handlePickMatOSTemplate(chip: MatOSTemplateChip) {
        switch (chip.action.kind) {
      case 'asset': {
        void createMatOSAssetProject(chip.action.assetType, t);
        return;
      }
      case 'prompt': {
        const prompt = t(chip.action.promptKey);
        onPromptChange(prompt);
        editorRef.current?.setText(prompt);
        requestAnimationFrame(() => editorRef.current?.focus());
        triggerSendAttention();
        return;
      }
    }
  }

  // The task-type rail (prototype / slide deck / live artifact / …). Records which
  // task type the user picked before delegating to the host's chip handler.
  function handlePickTaskChip(chip: HomeHeroChip) {
    // First chip pick completes the guide's first beat; the prompt-example
    // pulse arms once the example cards for this chip render.
    if (readHomeGuideStage() === 'chip') {
      writeHomeGuideStage('card');
      setGuidePulseChipId(null);
    }
    onPickChip(chip);
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    setDragActive(false);
    handleFiles(files);
  }

  function openActiveSkillDetails() {
    if (activeSkillRecord) onOpenSkillDetails(activeSkillRecord);
  }

  // Inline-backed MCP contexts already render as @mention pills in the editor.
  // This row should mount only for content that has a visible chip here; the
  // aggregate context count is just an aria label when the row exists.
  const showActiveContextRow =
    stagedFiles.length > 0 ||
    Boolean(activeSkillTitle) ||
    contextOnlyMcpServers.length > 0 ||
    contextWorkspaceItems.length > 0;

  let optionRenderIndex = 0;

  return (
    <section ref={homeHeroRef} className="home-hero" data-testid="home-hero">
      <div className="home-hero__brand" aria-label={MATOS_PRODUCT_NAME}>
        <span className="home-hero__brand-mark">
          <img src="/app-icon.svg" alt="" draggable={false} />
        </span>
        <span className="home-hero__brand-name">
          MatOS<span className="home-hero__brand-domain">.ai</span>
        </span>
      </div>
      <h1 className="home-hero__title">{t('homeHero.title')}</h1>
      <p className="home-hero__subtitle">
        {t('homeHero.subtitlePrefix')}
      </p>

      <div
        className={`home-hero__input-card${dragActive ? ' is-drag-active' : ''}`}
        style={inputCardStyle}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files')) setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {showActiveContextRow ? (
          <div
            className="home-hero__active"
            aria-label={
              contextItemCount > 0
                ? t('homeHero.contextItemsResolved', { n: contextItemCount })
                : undefined
            }
          >
            {stagedFiles.length > 0 ? (
              <span className="home-hero__active-file-group" data-testid="home-hero-staged-files">
                {stagedFiles.map((file, index) => {
                  const key = homeFileKey(file, index);
                  const previewUrl = stagedFilePreviewUrls.get(key) ?? null;
                  const fileBody = (
                    <>
                      {previewUrl ? (
                        <img
                          className="home-hero__active-thumb"
                          src={previewUrl}
                          alt=""
                          aria-hidden
                          draggable={false}
                        />
                      ) : (
                        <span className="home-hero__active-icon" aria-hidden>
                          <Icon name={isImageFile(file) ? 'image' : 'file'} size={12} />
                        </span>
                      )}
                      <span className="home-hero__active-label">{file.name}</span>
                      <span className="home-hero__active-meta">{formatFileSize(file.size)}</span>
                    </>
                  );
                  return (
                    <span
                      key={key}
                      className="home-hero__active-chip home-hero__active-chip--context home-hero__active-chip--file"
                      title={`${file.name} · ${formatFileSize(file.size)}`}
                    >
                      <span className="home-hero__active-order" aria-label={`Attachment ${index + 1}`}>
                        {index + 1}
                      </span>
                      {previewUrl ? (
                        <button
                          type="button"
                          className="home-hero__active-chip-body home-hero__active-file-body"
                          onClick={() => setPreviewHomeFileKey(key)}
                          aria-label={`Preview ${file.name}`}
                        >
                          {fileBody}
                        </button>
                      ) : (
                        <span className="home-hero__active-file-body">
                          {fileBody}
                        </span>
                      )}
                      <button
                        type="button"
                        className="home-hero__active-clear od-tooltip"
                        onClick={() => removeFileChip(index, file)}
                        aria-label={t('chat.removeAria', { name: file.name })}
                        title={t('homeHero.removeFile')}
                        data-tooltip={t('homeHero.removeFile')}
                      >
                        <Icon name="close" size={9} />
                      </button>
                    </span>
                  );
                })}
              </span>
            ) : null}
            {activeSkillTitle ? (
              <span
                className="home-hero__active-chip home-hero__active-chip--skill"
                data-testid="home-hero-active-skill"
              >
                <button
                  type="button"
                  className="home-hero__active-chip-body"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    openActiveSkillDetails();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    openActiveSkillDetails();
                  }}
                  onClick={openActiveSkillDetails}
                  disabled={!activeSkillRecord}
                  title={activeSkillRecord ? activeSkillRecord.description || activeSkillTitle : undefined}
                >
                  <span className="home-hero__active-icon" aria-hidden>
                    <Icon name="sparkles" size={12} />
                  </span>
                  <span className="home-hero__active-label">{t('homeHero.skillPrefix', { title: activeSkillTitle })}</span>
                </button>
                <button
                  type="button"
                  className="home-hero__active-clear od-tooltip"
                  onClick={onClearActiveSkill}
                  aria-label={t('homeHero.clearActiveSkill')}
                  title={t('homeHero.clearActiveSkill')}
                  data-tooltip={t('homeHero.clearActiveSkill')}
                >
                  <Icon name="close" size={9} />
                </button>
              </span>
            ) : null}
            {contextOnlyMcpServers.map((server) => {
              const label = server.label || server.id;
              return (
                <ContextChipHoverCard
                  key={`ctx-mcp-${server.id}`}
                  className="home-hero__active-chip home-hero__active-chip--context"
                  data-testid={`home-hero-context-mcp-${server.id}`}
                  typeLabel="MCP server"
                  detail={server.url || server.id}
                >
                  <span className="home-hero__active-icon" aria-hidden>
                    <Icon name="sliders" size={12} />
                  </span>
                  <span className="home-hero__active-label">{label}</span>
                  <button
                    type="button"
                    className="home-hero__active-clear od-tooltip"
                    onClick={() => {
                                            onRemoveMcpContext(server.id);
                    }}
                    aria-label={t('chat.removeAria', { name: label })}
                    title={t('common.close')}
                    data-tooltip={t('common.close')}
                    data-testid={`home-hero-context-clear-${server.id}`}
                  >
                    <Icon name="close" size={9} />
                  </button>
                </ContextChipHoverCard>
              );
            })}
            {contextWorkspaceItems.map((item) => (
              <ContextChipHoverCard
                key={`ctx-workspace-${item.id}`}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-workspace-${item.id}`}
                typeLabel={workspaceContextKindLabel(item.kind)}
                detail={workspaceContextDetailLine(item)}
              >
                <span className="home-hero__active-icon" aria-hidden>
                  <Icon name={item.kind === 'local-code' ? 'terminal' : 'folder'} size={12} />
                </span>
                <span className="home-hero__active-label">{item.label}</span>
                <button
                  type="button"
                  className="home-hero__active-clear od-tooltip"
                  onClick={() => {
                                        const nextPrompt = stripHomeMentionToken(prompt, item.label);
                    if (nextPrompt !== prompt) onPromptChange(nextPrompt);
                    onRemoveWorkspaceContext(item.id);
                  }}
                  aria-label={t('chat.removeAria', { name: item.label })}
                  title={t('common.close')}
                  data-tooltip={t('common.close')}
                  data-testid={`home-hero-context-clear-${item.id}`}
                >
                  <Icon name="close" size={9} />
                </button>
              </ContextChipHoverCard>
            ))}
          </div>
        ) : null}
        <div className="home-hero__prompt-surface">
          <div ref={promptEditorRef} className="home-hero__prompt-editor home-hero__lexical">
            <LexicalComposerInput
              ref={editorRef}
              testId="home-hero-input"
              draft={prompt}
              // While the carousel animates, blank the editor's own placeholder
              // so it doesn't double under the overlay; keep the base hint as
              // the accessible/tooltip label.
              placeholder={carouselActive ? '' : placeholder}
              title={carouselActive ? t(CAROUSEL_BASE_HINT_KEY) : placeholder}
              knownEntities={promptMentionEntities}
              onChange={(plainText) => {
                // A programmatic seed (host setPrompt → draft prop) echoes
                // back through Lexical's onChange. The old <textarea> never
                // fired onChange for a controlled-value change, so skip the
                // echo here: otherwise seeding would run the host's
                // handlePromptChange and flip promptEditedByUser with a
                // spurious "replace prompt?" dialog. Real user edits always
                // differ from the current prompt.
                if (plainText === prompt) return;
                onPromptChange(plainText);
                if (selectedPromptExample && plainText !== selectedPromptExample.promptText) {
                  setSelectedPromptExample(null);
                  onExamplePromptStatusChange?.(null);
                }
              }}
              onTrigger={handleTrigger}
              onEnterSend={handleSend}
              onPasteFiles={handleFiles}
              popoverOpen={pickerOpen && visiblePickerOptions.length > 0}
              onPopoverKey={handlePopoverKey}
              comboboxAria={{
                expanded: pickerOpen,
                activeId: pickerOpen ? `home-hero-option-${selectedIndex}` : null,
              }}
            />
            <PlaceholderCarousel
              active={carouselActive}
              scenarios={carouselScenarios}
              onScenarioChange={setCarouselScenario}
            />
          </div>
        </div>
        <CaretFloatingLayer caret={caretRect} open={pickerOpen}>
          <div
            ref={mentionPickerRef}
            id="home-hero-context-picker"
            className="home-hero__context-picker home-hero__context-picker--floating"
            role="listbox"
            aria-label={t('homeHero.contextSearchResults')}
            data-testid="home-hero-context-picker"
          >
            <div className="home-hero__mention-tabs" role="tablist" aria-label={t('homeHero.contextSurfaces')}>
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={mentionTab === item.id}
                  className={`home-hero__mention-tab${mentionTab === item.id ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMentionTab(item.id);
                    setSelectedIndex(0);
                  }}
                >
                  <span>{item.label}</span>
                  {item.count > 0 ? <span>{item.count}</span> : null}
                </button>
              ))}
            </div>
            <div className="home-hero__context-picker-results">
              {visibleLoading && visiblePickerOptions.length === 0 ? (
                <div className="home-hero__context-picker-empty">{t('homeHero.loadingContext')}</div>
              ) : null}
              {!visibleLoading && visiblePickerOptions.length === 0 ? (
                <div className="home-hero__context-picker-empty">
                  {mentionQuery ? (
                    <>{t('homeHero.noResults', { query: mentionQuery })}</>
                  ) : (
                    <>{t('homeHero.searchPrompt')}</>
                  )}
                </div>
              ) : null}
              {visibleSections.map((section) => (
                <div key={section.id} className="home-hero__mention-section">
                  <div className="home-hero__mention-section-label">{section.label}</div>
                  {section.options.map((item) => {
                    const optionIndex = optionRenderIndex;
                    optionRenderIndex += 1;
                    return (
                      <button
                        key={item.id}
                        id={`home-hero-option-${optionIndex}`}
                        type="button"
                        role="option"
                        aria-selected={optionIndex === selectedIndex}
                        className={`home-hero__context-option${
                          optionIndex === selectedIndex ? ' is-active' : ''
                        }`}
                        onMouseEnter={() => {
                          setSelectedIndex(optionIndex);
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          item.onPick();
                        }}
                      >
                        <span className="home-hero__context-option-icon" aria-hidden>
                          <Icon name={item.icon} size={13} />
                        </span>
                        <span className="home-hero__context-option-main">
                          <span>{item.title}</span>
                          <span>{item.description}</span>
                        </span>
                        <span className="home-hero__context-option-meta">
                          {item.meta}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </CaretFloatingLayer>
        <div className="home-hero__input-foot">
          <input
            ref={fileInputRef}
            data-testid="home-hero-file-input"
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              handleFiles(files);
              event.target.value = '';
            }}
          />
          <div className="home-hero__foot-left">
            <ComposerPlusMenu
              triggerTestId="home-hero-plus-trigger"
              placementPreference="down"
              skills={skillOptions}
              onPickSkill={(skill) => {
                                pickSkill(skill);
              }}
              mcpServers={mcpOptions}
              onPickMcp={(server) => {
                                pickMcp(server);
              }}
              onAddMcp={() => {
                                onAddMcp();
              }}
              onAttachFiles={() => {
                                fileInputRef.current?.click();
              }}
              onReferenceProject={() => {
                                                setProjectReferenceOpen(true);
              }}
              onLinkLocalCode={onPickLocalCodeDir ? () => {
                                void handleLinkLocalCodeContext();
              } : undefined}
            />
            {projectReferenceOpen ? (
              <ProjectReferenceModal
                onClose={() => {
                  // Only the dismiss paths (X / backdrop / Escape / Cancel)
                  // land here — a confirmed pick closes via
                  // handleReferenceProjects, which reports 'success'.
                                    setProjectReferenceOpen(false);
                }}
                onSelect={handleReferenceProjects}
              />
            ) : null}
            {MATOS_HOME_TEMPLATES_VISIBLE ? (
              // MatOS product mode: the composer Template pill offers the same
              // MatOS catalog as the rail below (asset drafts / compute task /
              // repo import). Cards fire an immediate action instead of
              // selecting a template, so there is never a committed selection.
              <TemplatePicker
                templates={MATOS_TEMPLATE_CHIPS}
                activeChipId={null}
                groupLabel={t('homeHero.templatePicker.matosGroup')}
                labelFor={(id) => matosTemplateChipLabel(id, t)}
                descriptionFor={(id) => matosTemplateChipDescription(id, t)}
                onPick={handlePickMatOSTemplate}
                onClear={() => setPreviewTemplateId(null)}
              />
            ) : (
              <TemplatePicker
                templates={templateChips}
                activeChipId={activeChipId}
                previewChipId={previewTemplateId}
                labelFor={(id) => homeHeroChipLabel(id, t)}
                descriptionFor={(id) => homeHeroChipDescription(id, t)}
                onPick={handlePickTaskChip}
                onClear={() => {
                  // Drop any lingering hover-preview too: when the rail card was
                  // hovered but the active chip is still null, clearing the chip
                  // alone is a no-op and the pill would stay on the preview.
                  setPreviewTemplateId(null);
                  onClearActiveChip();
                }}
              />
            )}
          </div>
          <div className="home-hero__foot-right">
            <div className="home-hero__mode-switcher">
              <SessionModeToggle
                mode={sessionMode}
                onChange={onSessionModeChange}
              />
            </div>
            {executionSwitcher ? (
              <div className="home-hero__execution-switcher">
                {executionSwitcher}
              </div>
            ) : null}
            <button
              type="button"
              className={`home-hero__submit od-tooltip${sendAttention ? ' home-hero__attention-sheen' : ''}${submitting ? ' is-sending' : ''}`}
              data-testid="home-hero-submit"
              onClick={handleSend}
              onAnimationEnd={() => setSendAttention(false)}
              disabled={!sendEnabled}
              title={submitting ? t('chat.comments.sending') : sendEnabled ? t('homeHero.run') : t('homeHero.typeSomethingToRun')}
              data-tooltip={submitting ? t('chat.comments.sending') : sendEnabled ? t('homeHero.run') : t('homeHero.typeSomethingToRun')}
              aria-label={submitting ? t('chat.comments.sending') : t('homeHero.run')}
              aria-busy={submitting}
            >
              <Icon name="send" size={16} />
              <span>{submitting ? t('chat.comments.sending') : t('chat.send')}</span>
            </button>
          </div>
        </div>
      </div>

      {onMatosRoleChange || onPickWorkingDir ? (
        <div className="home-hero__workdir-row">
          {onMatosRoleChange ? (
            <MatOSRolePicker
              roles={matosRoles}
              selectedRoleId={selectedMatosRoleId}
              loading={matosRolesLoading}
              onChange={onMatosRoleChange}
            />
          ) : null}
          {onMatosRoleChange && onPickWorkingDir ? (
            <span className="home-hero__workdir-divider" aria-hidden />
          ) : null}
          {onPickWorkingDir ? (
            <WorkingDirPicker
              workingDir={workingDir}
              recentDirs={recentDirs}
              onPickDirectory={() => {
                                void onPickWorkingDir();
              }}
              onSelectRecent={(dir) => {
                                onSelectRecentWorkingDir?.(dir);
              }}
              onClear={() => {
                                onClearWorkingDir?.();
              }}
            />
          ) : null}
        </div>
      ) : null}

      {activeCreateChip ? null : (
        <div className="home-hero__template-section" data-testid="home-hero-template-section">
          <div className="home-hero__template-heading">
            {t('homeHero.startWithTemplate')}
          </div>
          {/* MatOS replaces the upstream OD create rail (deck / prototype /
              wireframe / …) with MatOS-native starters: asset draft templates
              and project kick-off templates. Same illustrated-card visuals,
              MatOS semantics (see home-hero/matos-chips.ts). The upstream
              RailGroup/ShortcutsMenu path stays gated (not deleted) so its
              scenario-rail behavior and tests remain intact. */}
          {MATOS_HOME_TEMPLATES_VISIBLE ? (
            <MatOSTemplateRail onPick={handlePickMatOSTemplate} />
          ) : (
            <RailGroup
              group="create"
              activeChipId={activeChipId}
              onPickChip={handlePickTaskChip}
              variant="tabs"
              pulseChipId={guidePulseChipId}
              onHoverChip={setPreviewTemplateId}
            >
              <ShortcutsMenu
                activeChipId={activeChipId}
                open={shortcutsOpen}
                refNode={shortcutsMenuRef}
                onOpenChange={setShortcutsOpen}
                onPickChip={(chip) => {
                  setShortcutsOpen(false);
                  handlePickTaskChip(chip);
                }}
              />
            </RailGroup>
          )}
          {onStartBlankProject ? (
            <button
              type="button"
              className="home-hero__blank-project"
              data-testid="home-hero-blank-project"
              onClick={onStartBlankProject}
            >
              {t('homeHero.startBlankProject')}
              <Icon name="chevron-right" size={13} aria-hidden />
            </button>
          ) : null}
        </div>
      )}

      {activePromptExamples.length > 0 ? (
        <div
          className="home-hero__prompt-examples"
          data-testid="home-hero-prompt-examples"
        >
          <div className="home-hero__prompt-examples-title">
            {t('homeHero.promptExamples')}
          </div>
          <div className="home-hero__prompt-examples-grid">
            {activePromptExamples.map((example, index) => (
              <button
                key={example}
                type="button"
                className={`home-hero__prompt-example${guidePulseFirstPreset && index === 0 ? ' home-hero__attention-sheen' : ''}`}
                data-testid="home-hero-prompt-example"
                onClick={() => usePromptExample(example)}
              >
                <span>{example}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="home-hero__error">
          {error}
        </div>
      ) : null}
      {previewHomeFile && previewHomeFileUrl ? createPortal(
        <div
          className="staged-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={previewHomeFile.name}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewHomeFileKey(null);
          }}
        >
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={previewHomeFile.name}>{previewHomeFile.name}</span>
              <button
                type="button"
                className="icon-only od-tooltip"
                onClick={() => setPreviewHomeFileKey(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
                data-tooltip={t('common.close')}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <img src={previewHomeFileUrl} alt={previewHomeFile.name} />
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
});

function promptExampleChipLabel(example: string): string {
  const normalized = example.replace(/\s+/g, ' ').trim();
  const [beforeDash] = normalized.split(/\s[—-]\s/u, 1);
  const candidate = beforeDash?.trim() || normalized;
  return candidate.length > 64 ? `${candidate.slice(0, 61).trimEnd()}...` : candidate;
}

function homeFileKey(file: File, index: number): string {
  return `${file.name}-${file.size}-${file.lastModified}-${index}`;
}



function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

const HOME_HERO_PROMPT_MAX_HEIGHT = 180;

function buildHomeMentionEntities({
  activeSkillId,
  activeSkillTitle,
  contextWorkspaceItems,
  mcpOptions,
  stagedFiles,
  skillOptions,
}: {
  activeSkillId: string | null;
  activeSkillTitle: string | null;
  contextWorkspaceItems: WorkspaceContextItem[];
  mcpOptions: McpServerConfig[];
  stagedFiles: File[];
  skillOptions: SkillSummary[];
}): InlineMentionEntity[] {
  const entities: InlineMentionEntity[] = [];
  for (const item of contextWorkspaceItems) {
    entities.push({
      id: item.id,
      kind: 'workspace',
      label: item.label,
      token: inlineMentionToken(item.label),
      title: `Workspace: ${item.label}`,
    });
  }
  const fileSeen = new Set<string>();
  for (const file of stagedFiles) {
    if (fileSeen.has(file.name)) continue;
    fileSeen.add(file.name);
    entities.push({
      id: file.name,
      kind: 'file',
      label: file.name,
      token: inlineMentionToken(file.name),
      title: `File: ${file.name}`,
    });
  }
  const skillSeen = new Set<string>();
  for (const skill of skillOptions) {
    if (skillSeen.has(skill.id)) continue;
    skillSeen.add(skill.id);
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
  if (activeSkillId && activeSkillTitle && !skillSeen.has(activeSkillId)) {
    entities.push({
      id: activeSkillId,
      kind: 'skill',
      label: activeSkillTitle,
      token: inlineMentionToken(activeSkillTitle),
      title: `Skill: ${activeSkillTitle}`,
    });
  }
  for (const server of mcpOptions) {
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
  return entities;
}

function stripHomeMentionToken(value: string, label: string): string {
  const token = inlineMentionToken(label);
  return value.replace(
    new RegExp(`(^|[\\s([{"'])${escapeRegExp(token)}(?=$|\\s|[.,;:!?)}\\]"'])([^\\S\\r\\n])?`, 'g'),
    '$1',
  );
}

function fileMatchesQuery(file: File, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [file.name, file.type || '']
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function skillMatchesQuery(skill: SkillSummary, query: string, locale: Locale): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    skill.id,
    skill.name,
    localizeSkillName(locale, skill),
    skill.description,
    localizeSkillDescription(locale, skill),
    skill.mode,
    skill.surface ?? '',
    ...skill.triggers,
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function mcpServerMatchesQuery(server: McpServerConfig, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    server.id,
    server.label ?? '',
    server.transport,
    server.url ?? '',
    server.command ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}



function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RailGroupProps {
  group: ChipGroup;
  activeChipId: string | null;
  onPickChip: (chip: HomeHeroChip) => void;
  variant?: 'rail' | 'tabs';
  // First-run guide: this chip carries the attention sheen.
  pulseChipId?: string | null;
  // Hover-preview hook: the create rail reports which chip the pointer is over
  // (or null on leave) so the footer Template picker can preview it.
  onHoverChip?: (chipId: string | null) => void;
  children?: ReactNode;
}

// The MatOS "start from a template" rail: same illustrated scenario-card
// markup/classes as the tabs-variant RailGroup below, but backed by the
// MatOS template catalog. Cards fire an immediate action (spawn an asset
// draft project / prefill the composer / jump to import) instead of
// toggling a scenario mode, so there is no active/pending chip state.
function MatOSTemplateRail({
  onPick,
}: {
  onPick: (chip: MatOSTemplateChip) => void;
}) {
  const t = useT();
  const edgeScroll = useEdgeAutoScroll(MATOS_TEMPLATE_CHIPS.length);
  return (
    <div className="home-hero__scenario-cards-wrap">
      <div
        ref={edgeScroll.scrollRef}
        className="home-hero__type-tabs home-hero__type-tabs--create home-hero__scenario-cards"
        data-testid="home-hero-type-tabs"
        data-rail-group="matos"
        role="tablist"
        aria-label={t('homeHero.railAria')}
      >
        {MATOS_TEMPLATE_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="home-hero__type-tab home-hero__type-tab--create home-hero__scenario-card"
            data-chip-id={chip.id}
            data-testid={`home-hero-rail-${chip.id}`}
            onClick={() => onPick(chip)}
            role="tab"
            aria-selected={false}
            title={t(chip.descKey)}
          >
            <span className="home-hero__scenario-card-art" aria-hidden>
              <ScenarioArt chipId={chip.id} fallbackIcon={chip.icon} />
            </span>
            <span className="home-hero__scenario-card-body">
              <span className="home-hero__scenario-card-title home-hero__type-tab-label">
                {t(chip.labelKey)}
              </span>
              <span className="home-hero__scenario-card-desc">{t(chip.descKey)}</span>
            </span>
          </button>
        ))}
      </div>
      <EdgeScrollZones {...edgeScroll} />
    </div>
  );
}

function RailGroup({
  group,
  activeChipId,
  onPickChip,
  variant = 'rail',
  pulseChipId = null,
  onHoverChip,
  children,
}: RailGroupProps) {
  const t = useT();
  // The inline create rail leads with the slide deck and runs through the core
  // build scenarios in a fixed order (see `orderedCreateChips`); every other
  // group renders in catalog order.
  const chips = useMemo(
    () => (group === 'create' ? orderedCreateChips() : chipsForGroup(group)),
    [group],
  );
  const isTabs = variant === 'tabs';

  // Edge auto-scroll so the overflowing scenario rail stays reachable without a
  // trackpad (see EdgeAutoScroll). Only the tabs variant scrolls; for the
  // legacy rail variant scrollRef stays unattached and the hook is inert.
  const edgeScroll = useEdgeAutoScroll(chips.length);

  const cards = chips.map((chip) => {
    const isActive = activeChipId === chip.id;
    const nextStep = homeHeroChipTitle(chip, t);
    // Card variant (the default create rail): an illustrated scenario card —
    // an intent thumbnail (ScenarioArt) + title + one-line description. The
    // full "what happens next" sentence stays on the native `title` tooltip
    // instead of an inline line that resized the card on hover. The legacy
    // `rail`/pill markup is kept for any caller that still asks for `variant="rail"`.
    if (isTabs) {
      const description = homeHeroChipDescription(chip.id, t);
      const cardCls = ['home-hero__type-tab', `home-hero__type-tab--${group}`, 'home-hero__scenario-card'];
      if (isActive) cardCls.push('is-active');
      if (pulseChipId === chip.id) cardCls.push('home-hero__attention-sheen');
      return (
        <button
          key={chip.id}
          type="button"
          className={cardCls.join(' ')}
          data-chip-id={chip.id}
          data-testid={`home-hero-rail-${chip.id}`}
          onClick={() => onPickChip(chip)}
          onMouseEnter={() => onHoverChip?.(chip.id)}
          role="tab"
          aria-selected={isActive}
          title={nextStep}
        >
          <span className="home-hero__scenario-card-art" aria-hidden>
            <ScenarioArt chipId={chip.id} fallbackIcon={chip.icon} />
          </span>
          <span className="home-hero__scenario-card-body">
            <span className="home-hero__scenario-card-title home-hero__type-tab-label">
              {homeHeroChipLabel(chip.id, t)}
            </span>
            {description ? (
              <span className="home-hero__scenario-card-desc">{description}</span>
            ) : null}
          </span>
        </button>
      );
    }
    const cls = ['home-hero__rail-chip', `home-hero__rail-chip--${group}`];
    if (isActive) cls.push('is-active');
    if (pulseChipId === chip.id) cls.push('home-hero__attention-sheen');
    return (
      <button
        key={chip.id}
        type="button"
        className={cls.join(' ')}
        data-chip-id={chip.id}
        data-testid={`home-hero-rail-${chip.id}`}
        onClick={() => onPickChip(chip)}
        aria-pressed={isActive}
        title={nextStep}
      >
        <Icon
          name={chip.icon}
          size={14}
          className="home-hero__rail-chip-icon"
        />
        <span className="home-hero__rail-chip-label">
          {homeHeroChipLabel(chip.id, t)}
        </span>
      </button>
    );
  });

  if (isTabs) {
    return (
      <div
        className="home-hero__scenario-cards-wrap"
        onMouseLeave={() => onHoverChip?.(null)}
      >
        <div
          ref={edgeScroll.scrollRef}
          className={`home-hero__type-tabs home-hero__type-tabs--${group} home-hero__scenario-cards`}
          data-testid="home-hero-type-tabs"
          data-rail-group={group}
          role="tablist"
          aria-label={t('homeHero.railAria')}
        >
          {cards}
          {children}
        </div>
        <EdgeScrollZones {...edgeScroll} />
      </div>
    );
  }

  return (
    <div
      className={`home-hero__rail-group home-hero__rail-group--${group}`}
      data-rail-group={group}
    >
      {cards}
      {children}
    </div>
  );
}

interface ShortcutsMenuProps {
  activeChipId: string | null;
  open: boolean;
  refNode: RefObject<HTMLDivElement>;
  onOpenChange: (open: boolean) => void;
  onPickChip: (chip: HomeHeroChip) => void;
}

function ShortcutsMenu({
  activeChipId,
  open,
  refNode,
  onOpenChange,
  onPickChip,
}: ShortcutsMenuProps) {
  const t = useT();
  const shortcuts = useMemo(() => chipsForGroup('migrate'), []);
  const hasActiveShortcut = shortcuts.some((chip) => chip.id === activeChipId);
  const triggerClass = [
    'home-hero__type-tab',
    'home-hero__type-tab--more',
    hasActiveShortcut ? 'is-active' : '',
  ].filter(Boolean).join(' ');

  // The trigger lives inside the horizontally-scrolling rail, whose
  // `overflow-x: auto` also clips vertically — so an in-flow dropdown gets
  // truncated. Portal the panel to the body with fixed positioning anchored to
  // the trigger, and keep it aligned as the rail scrolls or the window resizes.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<
    { top: number; right: number; maxHeight: number } | null
  >(null);
  useEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Viewport clamp: the rail scrolls horizontally, so the trigger (and a
      // right-anchored 210px panel) can sit near either edge; keep the panel
      // inside [8, vw-8] and cap its height so it never spills past the
      // bottom on short/mobile viewports (panel scrolls internally instead).
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panelWidth = 210;
      const top = Math.round(Math.min(rect.bottom + 6, Math.max(8, vh - 268)));
      setPanelPos({
        top,
        right: Math.round(
          Math.min(Math.max(8, vw - rect.right), Math.max(8, vw - panelWidth - 8)),
        ),
        maxHeight: Math.max(160, vh - top - 12),
      });
    };
    update();
    window.addEventListener('resize', update);
    // Capture phase: scroll events don't bubble, so this is how the panel
    // follows the trigger when the rail itself scrolls.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  return (
    <div
      ref={refNode}
      className="home-hero__shortcut-menu"
      data-testid="home-hero-shortcuts"
      data-rail-group="migrate"
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        data-testid="home-hero-shortcuts-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('homeHero.moreShortcuts')}
        title={t('homeHero.moreShortcuts')}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="more-horizontal" size={16} className="home-hero__type-tab-icon" />
      </button>
      {open && panelPos
        ? createPortal(
        <div
          className="home-hero__shortcut-menu-panel"
          role="menu"
          aria-label={t('homeHero.moreShortcuts')}
          data-testid="home-hero-shortcuts-menu"
          data-shortcuts-panel=""
          data-rail-group="migrate"
          style={{
            position: 'fixed',
            top: panelPos.top,
            right: panelPos.right,
            maxHeight: panelPos.maxHeight,
            overflowY: 'auto',
          }}
        >
          {shortcuts.map((chip) => {
            const isActive = activeChipId === chip.id;
            const cls = ['home-hero__shortcut-menu-item'];
            if (isActive) cls.push('is-active');
            return (
              <button
                key={chip.id}
                type="button"
                role="menuitem"
                className={cls.join(' ')}
                data-chip-id={chip.id}
                data-testid={`home-hero-rail-${chip.id}`}
                title={homeHeroChipTitle(chip, t)}
                onClick={() => onPickChip(chip)}
              >
                <Icon name={chip.icon} size={14} className="home-hero__shortcut-menu-icon" />
                <span>{homeHeroChipLabel(chip.id, t)}</span>
              </button>
            );
          })}
        </div>,
          document.body,
        )
        : null}
    </div>
  );
}

// MatOS template card copy for the composer Template pill — same Dict keys
// the MatOS rail cards render, resolved through the chip catalog so the pill
// and the rail can never drift apart.
function matosTemplateChipLabel(chipId: string, t: ReturnType<typeof useT>): string {
  const chip = MATOS_TEMPLATE_CHIPS.find((item) => item.id === chipId);
  return chip ? t(chip.labelKey) : chipId;
}

function matosTemplateChipDescription(chipId: string, t: ReturnType<typeof useT>): string {
  const chip = MATOS_TEMPLATE_CHIPS.find((item) => item.id === chipId);
  return chip ? t(chip.descKey) : '';
}

// Scenario subtitle shown under the title on the illustrated card rail.
function homeHeroChipDescription(chipId: string, t: ReturnType<typeof useT>): string {
  switch (chipId) {
    case 'prototype': return t('homeHero.chip.prototypeDesc');
    case 'wireframe': return t('homeHero.chip.wireframeDesc');
    case 'mobile': return t('homeHero.chip.mobileDesc');
    case 'deck': return t('homeHero.chip.deckDesc');
    case 'document': return t('homeHero.chip.documentDesc');
    default: return '';
  }
}

type PromptLocaleKind = 'zh' | 'ja' | 'en';

// Locale families with their own connectives in the fallback chip copy.
function promptLocaleKind(locale: Locale): PromptLocaleKind {
  if (locale === 'zh-CN' || locale === 'zh-TW') return 'zh';
  if (locale === 'ja') return 'ja';
  return 'en';
}

function fallbackPlaceholderScenarioText(
  chipId: string,
  locale: Locale,
  t: ReturnType<typeof useT>,
): string | null {
  const label = homeHeroChipLabel(chipId, t).trim();
  if (!label || label === chipId) return null;
  const description = homeHeroChipDescription(chipId, t).trim();
  const kind = promptLocaleKind(locale);
  if (kind === 'zh') {
    return description ? `创建一个${label}：${description}` : `创建一个${label}`;
  }
  if (kind === 'ja') {
    return description ? `${label}を作成する：${description}` : `${label}を作成する`;
  }
  return description
    ? `Create ${englishArticle(label)} ${label}: ${description}`
    : `Create ${englishArticle(label)} ${label}`;
}

function englishArticle(noun: string): 'a' | 'an' {
  return /^[aeiou]/iu.test(noun) ? 'an' : 'a';
}

// The hover "what happens next" line — describes how the scenario will be
// consumed once picked (e.g. "Open a chat that builds a clickable prototype").
function homeHeroChipTitle(chip: HomeHeroChip, t: ReturnType<typeof useT>): string {
  switch (chip.id) {
    case 'prototype': return t('homeHero.chip.prototypeNext');
    case 'wireframe': return t('homeHero.chip.wireframeNext');
    case 'mobile': return t('homeHero.chip.mobileNext');
    case 'deck': return t('homeHero.chip.deckNext');
    case 'document': return t('homeHero.chip.documentNext');
    case 'template': return t('homeHero.chip.templateHint');
    default: return homeHeroChipLabel(chip.id, t);
  }
}

const HOME_PROMPT_EXAMPLES: Record<Locale, Record<string, string[]>> = {
  "en": {
    prototype: [
      "Design a high-converting website for an AI CRM with a clear hero, feature story, proof points, and trial CTA",
      "Create a desktop dashboard for a team knowledge base with search, recent updates, permissions, and collaboration entry points",
      "Redesign onboarding for a financial SaaS product so new users can connect data, finish setup, and see first value fast",
      "Prototype a mobile fitness coaching app covering goal setup, weekly plans, workout check-ins, and progress review",
    ],
    wireframe: [
      "Wireframe a SaaS dashboard with navigation, key metrics, a data table, and an empty state",
      "Sketch the lo-fi flow for a checkout: cart, shipping, payment, and confirmation screens",
      "Lay out a content management screen with list, detail, and edit states in greybox fidelity",
      "Wireframe an onboarding wizard covering account, workspace, invite, and first-run steps",
    ],
    mobile: [
      "Design a mobile banking app with home balance, transactions, transfer, and card management screens",
      "Lay out a food delivery app covering browse, restaurant detail, cart, and order tracking",
      "Prototype a habit-tracker app with today view, streak detail, add-habit, and stats screens",
      "Design a messaging app with chat list, conversation, profile, and settings screens",
    ],
    document: [
      "Draft a one-page resume for a senior product designer with summary, experience, skills, and selected work",
      "Write a polished project proposal with problem, approach, timeline, and budget sections",
      "Create a product one-pager covering the pitch, key features, pricing, and a call to action",
      "Generate a tidy meeting brief with agenda, decisions, owners, and next steps",
    ],
    deck: [
      "Research the market opportunity for a product launch, including competitors, target users, pricing hypotheses, and launch narrative",
      "Generate a weekly team status report with progress, risks, metric changes, and next-week priorities",
      "Design an investor pitch with market sizing, growth model, product advantage, and three-year forecast data",
      "Create a strategic business review deck covering quarterly performance, root causes, opportunities, and next actions",
    ],
  },
  "id": {
    prototype: [
      "Desain website berkonversi tinggi untuk AI CRM dengan hero yang jelas, alur cerita fitur, bukti pendukung, dan CTA uji coba",
      "Buat dashboard desktop untuk basis pengetahuan tim dengan pencarian, pembaruan terbaru, perizinan, dan titik masuk kolaborasi",
      "Rancang ulang onboarding untuk produk SaaS finansial agar pengguna baru bisa menghubungkan data, menyelesaikan setup, dan merasakan manfaat pertama dengan cepat",
      "Buat prototype app coaching kebugaran mobile yang mencakup penetapan tujuan, rencana mingguan, check-in latihan, dan tinjauan progres",
    ],
    deck: [
      "Riset peluang pasar untuk peluncuran produk, termasuk kompetitor, target pengguna, hipotesis harga, dan narasi peluncuran",
      "Buat laporan status tim mingguan berisi progres, risiko, perubahan metrik, dan prioritas minggu depan",
      "Desain pitch investor dengan ukuran pasar, model pertumbuhan, keunggulan produk, dan data proyeksi tiga tahun",
      "Buat deck tinjauan bisnis strategis yang mencakup kinerja kuartalan, akar masalah, peluang, dan langkah selanjutnya",
    ],
  },
  "de": {
    prototype: [
      "Entwirf eine konversionsstarke Website für ein AI CRM mit klarer Hero-Sektion, Feature-Story, Belegen und Trial-CTA",
      "Erstelle ein Desktop-Dashboard für eine Team-Wissensdatenbank mit Suche, aktuellen Updates, Berechtigungen und Einstiegspunkten für die Zusammenarbeit",
      "Gestalte das Onboarding für ein Finanz-SaaS-Produkt neu, damit neue Nutzer Daten verbinden, die Einrichtung abschließen und schnell den ersten Mehrwert erleben",
      "Prototype eine mobile Fitness-Coaching-App mit Zielsetzung, Wochenplänen, Workout-Check-ins und Fortschrittsübersicht",
    ],
    deck: [
      "Recherchiere die Marktchance für einen Produktlaunch, einschließlich Wettbewerbern, Zielnutzern, Preishypothesen und Launch-Narrativ",
      "Erstelle einen wöchentlichen Team-Statusbericht mit Fortschritt, Risiken, Kennzahlenänderungen und Prioritäten für die nächste Woche",
      "Entwirf ein Investoren-Pitch mit Marktgröße, Wachstumsmodell, Produktvorteil und Drei-Jahres-Prognosedaten",
      "Erstelle ein strategisches Business-Review-Deck mit Quartalsleistung, Ursachenanalyse, Chancen und nächsten Schritten",
    ],
  },
  "zh-CN": {
    prototype: [
      "为 AI CRM 设计一个高转化官网，包含首屏、功能卖点、客户案例和清晰的试用入口",
      "为团队知识库做一个桌面端仪表盘，突出搜索、最近更新、权限状态和协作入口",
      "重构金融 SaaS 的 onboarding 流程，让新用户能快速完成开户、连接数据和看到首个洞察",
      "设计一个移动端健身教练 App 原型，覆盖目标设定、训练计划、打卡反馈和进度复盘",
    ],
    deck: [
      "研究一个新产品发布的市场机会，输出竞品格局、目标用户、定价假设和上市叙事",
      "生成每周团队状态报告，汇总进展、风险、关键指标变化和下周优先级",
      "设计一份投资者推介材料，包含市场规模、增长模型、产品优势和三年预测数据",
      "创建战略业务复盘演示文稿，讲清本季度表现、问题原因、机会判断和下一步行动",
    ],
  },
  "zh-TW": {
    prototype: [
      "為 AI CRM 設計一個高轉換率的網站，包含清晰的主視覺、功能故事、佐證亮點與試用 CTA",
      "為團隊知識庫打造桌面儀表板，包含搜尋、近期更新、權限管理與協作入口",
      "重新設計金融 SaaS 產品的引導流程，讓新使用者能快速串接資料、完成設定並體驗到首次價值",
      "為行動健身教練 app 製作原型，涵蓋目標設定、每週計畫、運動打卡與進度回顧",
    ],
    deck: [
      "研究產品上市的市場機會，包含競品、目標客群、定價假設與上市敘事",
      "產生每週團隊進度報告，包含進展、風險、指標變化與下週優先事項",
      "設計一份投資人簡報，包含市場規模、成長模型、產品優勢與三年預測數據",
      "製作策略性業務檢討簡報，涵蓋季度績效、根本原因、機會點與後續行動",
    ],
  },
  "pt-BR": {
    prototype: [
      "Crie um site de alta conversão para um AI CRM com um hero claro, narrativa de recursos, provas sociais e CTA de teste grátis",
      "Crie um dashboard desktop para uma base de conhecimento de equipe com busca, atualizações recentes, permissões e pontos de entrada para colaboração",
      "Redesenhe o onboarding de um produto SaaS financeiro para que novos usuários conectem dados, concluam a configuração e vejam o primeiro valor rápido",
      "Prototipe um app mobile de coaching fitness cobrindo definição de metas, planos semanais, check-ins de treino e acompanhamento de progresso",
    ],
    deck: [
      "Pesquise a oportunidade de mercado para o lançamento de um produto, incluindo concorrentes, público-alvo, hipóteses de preço e narrativa de lançamento",
      "Gere um relatório semanal de status da equipe com progresso, riscos, variações de métricas e prioridades da próxima semana",
      "Crie um pitch para investidores com tamanho de mercado, modelo de crescimento, diferencial do produto e projeções de três anos",
      "Crie um deck de revisão estratégica de negócios cobrindo desempenho trimestral, causas raiz, oportunidades e próximos passos",
    ],
  },
  "es-ES": {
    prototype: [
      "Diseña una web de alta conversión para un AI CRM con un hero claro, narrativa de funciones, pruebas de valor y un CTA de prueba gratuita",
      "Crea un panel de escritorio para una base de conocimiento de equipo con búsqueda, novedades recientes, permisos y accesos a la colaboración",
      "Rediseña el onboarding de un producto SaaS financiero para que los nuevos usuarios conecten sus datos, completen la configuración y vean valor rápido",
      "Prototipa una app móvil de entrenamiento físico que cubra el establecimiento de objetivos, planes semanales, registro de entrenamientos y revisión del progreso",
    ],
    deck: [
      "Investiga la oportunidad de mercado para el lanzamiento de un producto, incluyendo competidores, usuarios objetivo, hipótesis de precios y narrativa de lanzamiento",
      "Genera un informe semanal de estado del equipo con avances, riesgos, cambios en las métricas y prioridades de la próxima semana",
      "Diseña un pitch para inversores con dimensionamiento de mercado, modelo de crecimiento, ventaja del producto y previsiones a tres años",
      "Crea una presentación de revisión estratégica del negocio que cubra el rendimiento trimestral, causas de fondo, oportunidades y próximas acciones",
    ],
  },
  "ru": {
    prototype: [
      "Спроектируйте конверсионный сайт для AI CRM с понятным hero-блоком, рассказом о возможностях, аргументами и CTA на пробный период",
      "Создайте десктопный дашборд для командной базы знаний с поиском, недавними обновлениями, правами доступа и точками входа для совместной работы",
      "Переработайте онбординг финансового SaaS-продукта, чтобы новые пользователи быстро подключали данные, завершали настройку и видели первую ценность",
      "Сделайте прототип мобильного приложения для фитнес-тренировок с постановкой целей, недельными планами, отметками о тренировках и просмотром прогресса",
    ],
    deck: [
      "Исследуйте рыночные возможности для запуска продукта: конкуренты, целевая аудитория, гипотезы по ценам и нарратив запуска",
      "Подготовьте еженедельный отчёт команды с прогрессом, рисками, изменениями метрик и приоритетами на следующую неделю",
      "Соберите инвесторскую презентацию с оценкой рынка, моделью роста, преимуществом продукта и прогнозом на три года",
      "Создайте презентацию стратегического бизнес-обзора: квартальные результаты, причины, возможности и следующие шаги",
    ],
  },
  "fa": {
    prototype: [
      "یک وب‌سایت پربازده برای یک AI CRM طراحی کن با بخش معرفی شفاف، روایت ویژگی‌ها، نکات اثبات‌کننده و CTA برای آزمایش رایگان",
      "یک داشبورد دسکتاپ برای پایگاه دانش تیمی بساز با جست‌وجو، به‌روزرسانی‌های اخیر، دسترسی‌ها و نقاط ورود به همکاری",
      "فرایند آنبوردینگ یک محصول SaaS مالی را بازطراحی کن تا کاربران جدید بتوانند داده‌ها را متصل کنند، راه‌اندازی را کامل کنند و سریع به ارزش اولیه برسند",
      "یک app مربی تناسب اندام موبایلی نمونه‌سازی کن که تعیین هدف، برنامه‌های هفتگی، ثبت تمرین‌ها و مرور پیشرفت را پوشش بدهد",
    ],
    deck: [
      "فرصت بازار برای عرضه یک محصول را بررسی کن، شامل رقبا، کاربران هدف، فرضیه‌های قیمت‌گذاری و روایت عرضه",
      "یک گزارش وضعیت هفتگی تیم بساز با پیشرفت‌ها، ریسک‌ها، تغییرات معیارها و اولویت‌های هفته بعد",
      "یک ارائه جذب سرمایه طراحی کن با اندازه‌گیری بازار، مدل رشد، مزیت محصول و داده‌های پیش‌بینی سه‌ساله",
      "یک ارائه بازبینی استراتژیک کسب‌وکار بساز که عملکرد فصلی، ریشه‌ها، فرصت‌ها و اقدامات بعدی را پوشش بدهد",
    ],
  },
  "ar": {
    prototype: [
      "صمّم موقعًا عالي التحويل لمنتج AI CRM مع قسم رئيسي واضح وقصة للميزات ونقاط إثبات وزر CTA لتجربة المنتج",
      "أنشئ لوحة تحكم لسطح المكتب لقاعدة معرفة جماعية تتضمن البحث والتحديثات الأخيرة والصلاحيات ونقاط دخول للتعاون",
      "أعد تصميم تجربة الانضمام لمنتج SaaS مالي ليتمكن المستخدمون الجدد من ربط بياناتهم وإكمال الإعداد وإدراك القيمة الأولى بسرعة",
      "صمّم نموذجًا أوليًا لتطبيق لياقة بدنية على الهاتف يغطي تحديد الأهداف والخطط الأسبوعية وتسجيل التمارين ومراجعة التقدم",
    ],
    deck: [
      "ابحث في فرصة السوق لإطلاق منتج، بما في ذلك المنافسون والمستخدمون المستهدفون وفرضيات التسعير وسردية الإطلاق",
      "أنشئ تقريرًا أسبوعيًا عن حالة الفريق يتضمن التقدم والمخاطر وتغيّرات المؤشرات وأولويات الأسبوع المقبل",
      "صمّم عرضًا تقديميًا للمستثمرين يشمل حجم السوق ونموذج النمو وميزة المنتج وبيانات توقعات الثلاث سنوات",
      "أنشئ عرضًا للمراجعة الاستراتيجية للأعمال يغطي الأداء الفصلي والأسباب الجذرية والفرص والخطوات التالية",
    ],
  },
  "ja": {
    prototype: [
      "AI CRM 向けに、ヒーロー・機能ストーリー・実績・トライアル CTA を備えた高コンバージョンの Web サイトをデザインして",
      "チームのナレッジベース向けに、検索・最近の更新・権限状態・コラボ導線を備えたデスクトップのダッシュボードを作って",
      "金融 SaaS のオンボーディングを再設計して、新規ユーザーがデータ連携・初期設定・最初の価値体験まで素早く到達できるようにして",
      "目標設定・週次プラン・チェックイン・進捗レビューをカバーする、モバイルのフィットネスコーチ App のプロトタイプを作って",
    ],
    deck: [
      "新製品ローンチの市場機会をリサーチして、競合状況・ターゲットユーザー・価格仮説・ローンチの物語をまとめて",
      "進捗・リスク・主要指標の変化・来週の優先事項を盛り込んだ週次チームステータスレポートを生成して",
      "市場規模・成長モデル・製品の強み・3 年分の予測データを含む投資家向けピッチをデザインして",
      "四半期の実績・原因・機会・次のアクションをまとめた戦略的なビジネスレビューのデッキを作って",
    ],
  },
  "ko": {
    prototype: [
      "명확한 히어로, 기능 스토리, 신뢰 지표, 체험판 CTA를 갖춘 AI CRM용 고전환 website를 디자인해 줘",
      "검색, 최근 업데이트, 권한 관리, 협업 진입점을 담은 팀 지식 베이스용 데스크톱 대시보드를 만들어 줘",
      "신규 사용자가 데이터를 연결하고 설정을 마쳐 첫 가치를 빠르게 체감하도록 금융 SaaS 제품의 온보딩을 새로 디자인해 줘",
      "목표 설정, 주간 플랜, 운동 체크인, 진행 상황 리뷰를 아우르는 모바일 피트니스 코칭 app을 프로토타입으로 만들어 줘",
    ],
    deck: [
      "경쟁사, 타깃 사용자, 가격 가설, 출시 내러티브를 포함해 제품 출시의 시장 기회를 리서치해 줘",
      "진행 상황, 리스크, 지표 변화, 다음 주 우선순위를 담은 주간 팀 현황 보고서를 만들어 줘",
      "시장 규모, 성장 모델, 제품 경쟁력, 3년 전망 데이터를 담은 투자자 피치를 디자인해 줘",
      "분기 실적, 근본 원인, 기회 요소, 다음 액션을 다루는 전략 비즈니스 리뷰 deck을 만들어 줘",
    ],
  },
  "pl": {
    prototype: [
      "Zaprojektuj skuteczną sprzedażowo stronę dla AI CRM z czytelną sekcją hero, opowieścią o funkcjach, dowodami skuteczności i CTA do wersji próbnej",
      "Stwórz desktopowy dashboard dla zespołowej bazy wiedzy z wyszukiwarką, ostatnimi aktualizacjami, uprawnieniami i punktami wejścia do współpracy",
      "Przeprojektuj onboarding produktu finansowego SaaS, aby nowi użytkownicy mogli podłączyć dane, dokończyć konfigurację i szybko zobaczyć pierwszą wartość",
      "Zbuduj prototyp mobilnej aplikacji do treningu fitness obejmującej ustawianie celów, plany tygodniowe, odznaczanie treningów i przegląd postępów",
    ],
    deck: [
      "Zbadaj szansę rynkową dla premiery produktu, uwzględniając konkurencję, docelowych użytkowników, hipotezy cenowe i narrację premiery",
      "Wygeneruj tygodniowy raport statusu zespołu z postępami, ryzykami, zmianami wskaźników i priorytetami na kolejny tydzień",
      "Zaprojektuj prezentację dla inwestorów z szacowaniem rynku, modelem wzrostu, przewagą produktu i prognozą na trzy lata",
      "Stwórz prezentację strategicznego przeglądu biznesowego obejmującą wyniki kwartalne, przyczyny źródłowe, szanse i kolejne działania",
    ],
  },
  "hu": {
    prototype: [
      "Tervezz magas konverziójú weboldalt egy AI CRM számára, jól látható hero szekcióval, funkciókat bemutató történettel, bizonyítékokkal és próbaverziós CTA-val",
      "Készíts asztali irányítópultot egy csapat tudásbázisához kereséssel, friss frissítésekkel, jogosultságokkal és együttműködési belépési pontokkal",
      "Tervezd újra egy pénzügyi SaaS termék bevezetését, hogy az új felhasználók gyorsan összekapcsolhassák az adatokat, befejezhessék a beállítást és megtapasztalhassák az első értéket",
      "Készíts prototípust egy mobil fitneszedző alkalmazáshoz, amely lefedi a célok kitűzését, a heti terveket, az edzések bejelentkezését és a haladás áttekintését",
    ],
    deck: [
      "Kutasd fel egy termékbevezetés piaci lehetőségeit, beleértve a versenytársakat, a célközönséget, az árazási hipotéziseket és a bevezetési narratívát",
      "Készíts heti csapatállapot-jelentést a haladással, kockázatokkal, metrikák változásaival és a következő heti prioritásokkal",
      "Tervezz befektetői prezentációt piacméretezéssel, növekedési modellel, termékelőnyökkel és hároméves előrejelzési adatokkal",
      "Készíts stratégiai üzleti áttekintő prezentációt, amely lefedi a negyedéves teljesítményt, a kiváltó okokat, a lehetőségeket és a következő lépéseket",
    ],
  },
  "fr": {
    prototype: [
      "Concevez un site web à fort taux de conversion pour un AI CRM, avec un hero clair, un récit des fonctionnalités, des preuves concrètes et un CTA d'essai",
      "Créez un dashboard desktop pour une base de connaissances d'équipe, avec recherche, mises à jour récentes, permissions et points d'entrée vers la collaboration",
      "Repensez l'onboarding d'un produit SaaS financier pour que les nouveaux utilisateurs puissent connecter leurs données, terminer la configuration et constater rapidement une première valeur",
      "Prototypez une app mobile de coaching fitness couvrant la définition des objectifs, les plans hebdomadaires, le suivi des séances et le bilan de progression",
    ],
    deck: [
      "Étudiez l'opportunité de marché d'un lancement de produit, avec les concurrents, les utilisateurs cibles, les hypothèses de prix et le récit de lancement",
      "Générez un rapport d'avancement hebdomadaire de l'équipe avec les progrès, les risques, l'évolution des métriques et les priorités de la semaine prochaine",
      "Concevez un pitch investisseurs avec le dimensionnement du marché, le modèle de croissance, l'avantage produit et des prévisions sur trois ans",
      "Créez un deck de revue stratégique couvrant la performance trimestrielle, les causes profondes, les opportunités et les prochaines actions",
    ],
  },
  "uk": {
    prototype: [
      "Створіть вебсайт із високою конверсією для AI CRM із чітким hero-блоком, історією про функції, доказами цінності та CTA для пробного доступу",
      "Створіть десктопний дашборд для командної бази знань із пошуком, останніми оновленнями, правами доступу та точками входу для співпраці",
      "Переробіть онбординг для фінансового SaaS-продукту, щоб нові користувачі могли підключити дані, завершити налаштування та швидко побачити першу цінність",
      "Зробіть прототип мобільного застосунку для фітнес-коучингу з постановкою цілей, тижневими планами, відмітками тренувань і переглядом прогресу",
    ],
    deck: [
      "Дослідіть ринкову можливість для запуску продукту, включно з конкурентами, цільовою аудиторією, гіпотезами щодо цін і наративом запуску",
      "Згенеруйте щотижневий звіт про стан команди з прогресом, ризиками, змінами метрик і пріоритетами на наступний тиждень",
      "Створіть інвесторську презентацію з оцінкою ринку, моделлю зростання, перевагами продукту та прогнозом на три роки",
      "Створіть презентацію стратегічного огляду бізнесу з квартальними результатами, першопричинами, можливостями та наступними кроками",
    ],
  },
  "tr": {
    prototype: [
      "AI CRM için net bir hero alanı, özellik hikayesi, kanıt noktaları ve deneme CTA'sı içeren, dönüşümü yüksek bir website tasarla",
      "Bir ekip bilgi tabanı için arama, son güncellemeler, izinler ve iş birliği giriş noktaları içeren bir masaüstü kontrol paneli oluştur",
      "Finansal bir SaaS ürününün onboarding sürecini, yeni kullanıcılar verilerini bağlayabilsin, kurulumu tamamlayabilsin ve ilk değeri hızla görebilsin diye yeniden tasarla",
      "Hedef belirleme, haftalık planlar, antrenman check-in'leri ve ilerleme takibini kapsayan bir mobil fitness koçluğu app'i prototiple",
    ],
    deck: [
      "Bir ürün lansmanı için rakipler, hedef kullanıcılar, fiyatlandırma hipotezleri ve lansman anlatısı dahil olmak üzere pazar fırsatını araştır",
      "İlerleme, riskler, metrik değişimleri ve gelecek haftanın önceliklerini içeren haftalık bir ekip durum raporu oluştur",
      "Pazar büyüklüğü, büyüme modeli, ürün avantajı ve üç yıllık tahmin verilerini içeren bir yatırımcı sunumu tasarla",
      "Çeyreklik performans, kök nedenler, fırsatlar ve sonraki adımları kapsayan stratejik bir iş değerlendirme sunumu oluştur",
    ],
  },
  "th": {
    prototype: [
      "ออกแบบเว็บไซต์ที่กระตุ้นการเปลี่ยนเป็นลูกค้าสำหรับ AI CRM พร้อม hero ที่ชัดเจน เรื่องราวฟีเจอร์ จุดพิสูจน์ความน่าเชื่อถือ และ CTA ทดลองใช้",
      "สร้างแดชบอร์ดบนเดสก์ท็อปสำหรับฐานความรู้ของทีม พร้อมการค้นหา อัปเดตล่าสุด สิทธิ์การเข้าถึง และจุดเริ่มต้นการทำงานร่วมกัน",
      "ออกแบบขั้นตอนเริ่มต้นใช้งานใหม่สำหรับผลิตภัณฑ์ SaaS ด้านการเงิน เพื่อให้ผู้ใช้ใหม่เชื่อมต่อข้อมูล ตั้งค่าให้เสร็จ และเห็นคุณค่าแรกได้อย่างรวดเร็ว",
      "ทำต้นแบบ app โค้ชฟิตเนสบนมือถือ ครอบคลุมการตั้งเป้าหมาย แผนรายสัปดาห์ การเช็กอินการออกกำลังกาย และการทบทวนความคืบหน้า",
    ],
    deck: [
      "วิจัยโอกาสทางการตลาดสำหรับการเปิดตัวผลิตภัณฑ์ รวมถึงคู่แข่ง กลุ่มผู้ใช้เป้าหมาย สมมติฐานด้านราคา และเรื่องราวการเปิดตัว",
      "สร้างรายงานสถานะของทีมรายสัปดาห์ พร้อมความคืบหน้า ความเสี่ยง การเปลี่ยนแปลงของตัวชี้วัด และสิ่งที่ต้องทำในสัปดาห์หน้า",
      "ออกแบบ pitch สำหรับนักลงทุน พร้อมการประเมินขนาดตลาด โมเดลการเติบโต จุดเด่นของผลิตภัณฑ์ และข้อมูลคาดการณ์สามปี",
      "สร้างเด็คทบทวนกลยุทธ์ธุรกิจ ครอบคลุมผลงานรายไตรมาส สาเหตุที่แท้จริง โอกาส และสิ่งที่ต้องทำต่อไป",
    ],
  },
  "it": {
    prototype: [
      "Progetta un sito web ad alta conversione per un AI CRM con una hero chiara, lo storytelling delle funzionalità, prove concrete e una CTA per la prova gratuita",
      "Crea una dashboard desktop per la knowledge base di un team con ricerca, aggiornamenti recenti, permessi e punti di accesso alla collaborazione",
      "Riprogetta l'onboarding di un prodotto SaaS finanziario per far sì che i nuovi utenti colleghino i dati, completino la configurazione e vedano subito il primo valore",
      "Prototipa una app mobile di coaching fitness che copra l'impostazione degli obiettivi, i piani settimanali, il check-in degli allenamenti e la revisione dei progressi",
    ],
    deck: [
      "Analizza l'opportunità di mercato per il lancio di un prodotto, inclusi concorrenti, utenti target, ipotesi di prezzo e narrativa di lancio",
      "Genera un report settimanale sullo stato del team con avanzamenti, rischi, variazioni delle metriche e priorità per la prossima settimana",
      "Progetta un pitch per investitori con dimensionamento del mercato, modello di crescita, vantaggio del prodotto e previsioni a tre anni",
      "Crea una deck di business review strategica che copra le performance trimestrali, le cause profonde, le opportunità e le prossime azioni",
    ],
  },
};

export const HOME_PROMPT_EXAMPLE_CHIP_IDS = [
  'prototype',
  'deck',
] as const;

// Every supported locale must resolve its own localized example prompts; a
// missing locale entry would silently bleed English into the home composer,
// which is the regression this table exists to prevent.
export function homeHeroChipPromptExamplesForLocale(chipId: string, locale: Locale): string[] {
  return HOME_PROMPT_EXAMPLES[locale]?.[chipId] ?? HOME_PROMPT_EXAMPLES.en[chipId] ?? [];
}

function homeHeroChipPromptExamples(chipId: string, locale: Locale): string[] {
  return homeHeroChipPromptExamplesForLocale(chipId, locale);
}


function briefForChipId(chipId: string): Record<string, string> {
  switch (chipId) {
    case 'prototype':
      return { artifact_type: 'web prototype', audience: 'product evaluators', fidelity: 'high-fidelity' };
    case 'wireframe':
      return { artifact_type: 'lo-fi wireframe', audience: 'product team', fidelity: 'wireframe' };
    case 'mobile':
      return { artifact_type: 'mobile app prototype', audience: 'product evaluators', platform: 'iOS & Android' };
    case 'document':
      return { artifact_type: 'document (resume / report / PDF)', audience: 'readers' };
    case 'deck':
      return { artifact_type: 'pitch deck / presentation', audience: 'decision makers', slide_count: '10-15 pages' };
    default:
      return { artifact_type: chipId };
  }
}
