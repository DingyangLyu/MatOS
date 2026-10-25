// EntryShell — the centered-hero entry layout.
//
// This component owns the entire JSX render and local UI state for
// the redesigned home view (left rail + sticky settings cog + hero +
// recent projects + assets section + new-project modal). It is
// intentionally a sibling of `EntryView` so that upstream `main`
// changes to `EntryView` (props, helper exports)
// can be rebased without touching this file. `EntryView` becomes a
// thin wrapper that passes data and callbacks through to this shell.

import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { lazyWithReload } from '../utils/lazyWithReload';
import type { ChatSessionMode, RunContextSelection } from '@open-design/contracts';
import type { OpenDesignHostProjectImportSuccess } from '@open-design/host';
import { useT } from '../i18n';
import { navigate, useRoute } from '../router';
import type {
  AgentInfo,
  AppConfig,
  AppTheme,
  Project,
  ProjectMetadata,
  ProjectTemplate,
  SkillSummary,
} from '../types';
import { CenteredLoader } from './Loading';
import { EntryNavRail, type EntryView as EntryViewKind } from './EntryNavRail';
import workflowStyles from './workflow-studio/WorkflowStudio.module.css';
import { Icon } from './Icon';
import type { IntegrationTab } from './IntegrationsView';
import { InlineModelSwitcher } from './InlineModelSwitcher';
import {
  EntrySettingsMenu,
  type EntrySettingsSection,
} from './EntrySettingsMenu';
import type { CreateInput, CreateTab } from './NewProjectPanel';
import { smoothScrollToTop } from '../utils/smoothScrollToTop';
import { summarizeProjectNameFromPrompt } from '../utils/projectName';
import { includeRoleRef } from '../utils/roleRefs';

// Persist the entry nav-rail open/collapsed state so it survives both a
// home -> project -> home navigation (EntryShell unmounts on the project
// route) and a full reload. Without this the rail always reset to its
// collapsed default on return.
const RAIL_OPEN_STORAGE_KEY = 'od.entry.railOpen';

// lazyWithReload instead of React.lazy: the daemon serves a static export
// whose hashed chunks are replaced on every rebuild, so a stale tab's first
// visit to one of these views would otherwise dead-end on Next's global
// "This page couldn't load" screen (see utils/lazyWithReload.ts).
const HomeView = lazyWithReload(() =>
  import('./HomeView').then((mod) => ({ default: mod.HomeView })),
);
const DesignsTab = lazyWithReload(() =>
  import('./DesignsTab').then((mod) => ({ default: mod.DesignsTab })),
);
const TasksView = lazyWithReload(() =>
  import('./TasksView').then((mod) => ({ default: mod.TasksView })),
);
const IntegrationsView = lazyWithReload(() =>
  import('./IntegrationsView').then((mod) => ({ default: mod.IntegrationsView })),
);
const AssetsView = lazyWithReload(() =>
  import('./AssetsView').then((mod) => ({ default: mod.AssetsView })),
);
const MatOSOnboardingView = lazyWithReload(() =>
  import('./MatOSOnboardingView').then((mod) => ({ default: mod.MatOSOnboardingView })),
);
const UserProfileView = lazyWithReload(() =>
  import('./UserProfileView').then((mod) => ({ default: mod.UserProfileView })),
);
const UserFeedbackView = lazyWithReload(() =>
  import('./UserFeedbackView').then((mod) => ({ default: mod.UserFeedbackView })),
);
const ReleaseNotesView = lazyWithReload(() =>
  import('./ReleaseNotesView').then((mod) => ({ default: mod.ReleaseNotesView })),
);
const WorkflowsView = lazyWithReload(() =>
  import('./workflow-studio/WorkflowStudio').then((mod) => ({ default: mod.WorkflowsView })),
);
const MatOSOpsView = lazyWithReload(() =>
  import('./MatOSOpsView').then((mod) => ({ default: mod.MatOSOpsView })),
);
const MatOSEvolutionView = lazyWithReload(() =>
  import('./MatOSEvolutionView').then((mod) => ({ default: mod.MatOSEvolutionView })),
);
const MatOSSchedulesView = lazyWithReload(() =>
  import('./MatOSSchedulesView').then((mod) => ({ default: mod.MatOSSchedulesView })),
);
const NewProjectModal = lazyWithReload(() =>
  import('./NewProjectModal').then((mod) => ({ default: mod.NewProjectModal })),
);
const MatOSNewProjectModal = lazyWithReload(() =>
  import('./MatOSNewProjectModal').then((mod) => ({ default: mod.MatOSNewProjectModal })),
);

function readStoredRailOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredRailOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    /* ignore quota / disabled storage */
  }
}

const ONBOARDING_DROPDOWN_OPEN_EVENT = 'open-design:onboarding-dropdown-open';

// The topbar chips (GitHub star, model switcher, Use everywhere)
// collapse into the settings dropdown when the viewport gets
// narrow. The transition is driven entirely by CSS @media queries
// in `entry-layout.css` so server and client render identical
// markup — both surfaces are always present, and CSS toggles
// `display` based on `--compact-topbar` breakpoint (900px).




type EntryCreateProjectInput = Omit<CreateInput, 'metadata'> & {
  metadata?: CreateInput['metadata'];
  // MatOS new-project form: explicit slug id (folder name under the chosen
  // project location) + the location to create the folder in.
  id?: string;
  projectLocationId?: string;
  pendingPrompt?: string;
  initialRunContext?: RunContextSelection | null;
  conversationMode?: ChatSessionMode;
  autoSendFirstMessage?: boolean;
  allowInvalidLinkedDirs?: boolean;
  requestId?: string;
  pendingFiles?: File[];
  userWorkingDirToken?: string;
  linkedDirs?: string[] | null;
};

interface Props {
  skills: SkillSummary[];
  designTemplates: SkillSummary[];
  projects: Project[];
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  integrationInitialTab?: IntegrationTab;
  skillsLoading?: boolean;
  projectsLoading?: boolean;
  // Execution / model-switching context. Threaded down from `App` so the
  // top-bar `InlineModelSwitcher` can render the active mode/agent/model
  // and persist changes through the same callbacks the project view uses.
  config: AppConfig;
  agents: AgentInfo[];
  // True while the cold-start agent detection stream is still in flight
  // (`fetchAgentsStream` has not reached its terminal `done`). Onboarding
  // uses this to show the AMR cloud card in a detecting/skeleton state
  // instead of hiding it during the seconds AMR's probe takes to settle.
  agentsLoading?: boolean;
  daemonLive: boolean;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onConfigPersist: (cfg: AppConfig) => Promise<void> | void;
  onSkillsRefresh?: () => Promise<void> | void;
  onSkillsChanged?: (affectedSkillId?: string) => void;
  onRefreshAgents: () => Promise<AgentInfo[]> | AgentInfo[];
  // Quick theme switch from the avatar-popover dropdown. Lets the user
  // flip between system / light / dark without opening the full Settings
  // dialog. App owns persistence; this component just calls the callback.
  onThemeChange: (theme: AppTheme) => void;
  onCreateProject: (input: EntryCreateProjectInput) => Promise<boolean> | boolean | void;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
  onOpenProject: (id: string, fileName?: string) => Promise<boolean> | boolean | void;
  onDeleteProject: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicateProject?: (id: string) => Promise<void> | void;
  onRenameProject: (id: string, name: string) => void;
  onProjectsRefresh?: () => Promise<void> | void;
  onOpenSettings: (section?: EntrySettingsSection) => void;
  onCompleteOnboarding: () => void;
}

// Tab views stay mounted (so previews/thumbnails survive a tab switch) but the
// inactive ones must leave layout, the accessibility tree, and tab order.
// `content-visibility: hidden` still reserves the hidden pane's block size,
// which pushes later sidebar destinations far below the sticky topbar.
function inactiveViewProps(active: boolean) {
  return {
    style: active ? undefined : ({ display: 'none' } as const),
    inert: !active,
    'aria-hidden': !active,
  };
}

export function EntryShell({
  skills,
  designTemplates,
  projects,
  templates,
  onDeleteTemplate,
  integrationInitialTab = 'mcp',
  skillsLoading = false,
  projectsLoading = false,
  config,
  agents,
  agentsLoading = false,
  daemonLive,
  onAgentChange,
  onAgentModelChange,
  onConfigPersist,
  onSkillsRefresh,
  onSkillsChanged,
  onRefreshAgents,
  onThemeChange,
  onCreateProject,
  onImportFolder,
  onImportFolderResponse,
  onOpenProject,
  onDeleteProject,
  onDuplicateProject,
  onRenameProject,
  onProjectsRefresh,
  onOpenSettings,
  onCompleteOnboarding,
}: Props) {
  const t = useT();
  // Each entry sub-view (home / projects) is its own URL now, so the
  // browser back/forward buttons work and a deep link lands on that
  // section. We derive the active view from the route rather than keeping
  // it in component state.
  const route = useRoute();
  const view: EntryViewKind = route.kind === 'home' ? route.view : 'home';
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // MatOS project creation (the "+" → Project entry). The legacy OD panel
  // (`newProjectOpen`) stays reachable only from flows that request an
  // explicit OD create tab (e.g. Templates gallery).
  const [matosProjectOpen, setMatosProjectOpen] = useState(false);
  // The entry nav rail is collapsed by default (Manus-style) so the entry
  // view opens clean and full-width; the panel toggle in the topbar opens it
  // as an overlay that dismisses on selection / backdrop click / Escape.
  // Its open/collapsed state is persisted (localStorage) so it survives a
  // home -> project -> home round trip (EntryShell unmounts on the project
  // route) and a reload, instead of snapping back to collapsed.
  const [railOpen, setRailOpen] = useState<boolean>(readStoredRailOpen);
  useEffect(() => {
    writeStoredRailOpen(railOpen);
  }, [railOpen]);
  // On phones the left icon rail is re-laid-out as a permanent top bar (see the
  // `max-width: 640px` block in entry-layout.css). The CSS handles the visual
  // switch, but the rail's controls are made `inert` / `pointer-events:none`
  // while collapsed, so we also force the rail `open` on phones — otherwise the
  // top-bar icons would render but not be tappable. Desktop/tablet keep the
  // collapsible left rail exactly as before (isMobile stays false there).
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia('(max-width: 640px)');
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const railEffectiveOpen = railOpen || isMobile;
  const [newProjectInitialTab, setNewProjectInitialTab] =
    useState<CreateTab>('prototype');
  const [integrationTab, setIntegrationTab] = useState<IntegrationTab>(integrationInitialTab);
  const entryMainScrollRef = useRef<HTMLElement | null>(null);
  function changeView(next: EntryViewKind) {
    navigate({ kind: 'home', view: next });
  }


  useEffect(() => {
    setIntegrationTab(integrationInitialTab);
  }, [integrationInitialTab]);

  function openIntegrationTab(tab: IntegrationTab) {
    setIntegrationTab(tab);
    changeView('integrations');
  }

  // No-tab callers (the "+" create menu, the projects list) get the MatOS
  // project form; flows that ask for a specific OD create tab (Templates
  // gallery, media cards) keep the legacy panel.
  function openNewProject(tab?: CreateTab) {
    if (!tab) {
      setMatosProjectOpen(true);
      return;
    }
    setNewProjectInitialTab(tab);
    setNewProjectOpen(true);
  }

  function startBlankProjectFromRail() {
    void Promise.resolve(
      onCreateProject({
        name: t('newproj.untitledName'),
        metadata: { kind: 'prototype', nameSource: 'untitled' },
        skillId: null,
      }),
    ).catch((err) => {
      console.warn('Failed to create blank project from entry rail', err);
    });
  }

  function handleCreate(input: CreateInput) {
    return onCreateProject(input);
  }

  function handleHomeSubmit(payload: {
    prompt: string;
    attachments?: File[];
    workingDir?: string | null;
    linkedDirs?: string[];
    projectMetadata?: ProjectMetadata;
    projectKind?: ProjectMetadata['kind'];
    skillId?: string | null;
    initialRunContext?: RunContextSelection | null;
    conversationMode?: ChatSessionMode;
    examplePromptContext?: { title: string; brief: Record<string, string> };
    contextMcpServers?: Array<{ id: string }>;
  }) {
    const summarizedName = summarizeProjectNameFromPrompt(payload.prompt);
    const head = payload.prompt.trim().split(/\s+/).slice(0, 8).join(' ');
    const firstAttachmentName = payload.attachments?.[0]?.name ?? '';
    const fallbackName =
      summarizedName || (head.length > 0 ? head : firstAttachmentName || 'Untitled');
    const name = nativeMatOSChat ? t('newproj.untitledName') : fallbackName;
    const linkedDirs = Array.from(
      new Set(
        [
          ...(payload.workingDir ? [payload.workingDir] : []),
          ...(payload.linkedDirs ?? []),
        ].map((dir) => dir.trim()).filter(Boolean),
      ),
    );
    const projectMembers = includeRoleRef(
      payload.projectMetadata?.members,
      selectedMatosRoleId,
    );
    const metadata: ProjectMetadata = {
      ...(payload.projectMetadata ?? {}),
      kind: payload.projectKind ?? payload.projectMetadata?.kind ?? 'prototype',
      nameSource: nativeMatOSChat ? 'untitled' : 'prompt',
      ...(projectMembers.length > 0 ? { members: projectMembers } : {}),
      ...(selectedMatosRoleId ? { matosActiveRoleRef: selectedMatosRoleId } : {}),
      ...(payload.contextMcpServers && payload.contextMcpServers.length > 0
        ? { contextMcpServers: payload.contextMcpServers }
        : {}),
      // The Home working-directory picker grants the agent read-only
      // awareness of a local folder (via `--add-dir`), it does NOT import
      // that folder into Design Files. So the picked path becomes the new
      // project's `linkedDirs` rather than its `baseDir`/`userWorkingDir`:
      // Design Files stays the managed `.od/projects/<id>` artifact store,
      // independent of the user's local files.
      ...(linkedDirs.length > 0 ? { linkedDirs } : {}),
      ...(payload.examplePromptContext ? {
        examplePrompt: true,
        examplePromptTitle: payload.examplePromptContext.title,
        examplePromptBrief: payload.examplePromptContext.brief,
      } : {}),
    };
    return onCreateProject({
      name,
      skillId: payload.skillId ?? null,
      metadata,
      pendingPrompt: payload.prompt,
      ...(payload.initialRunContext ? { initialRunContext: payload.initialRunContext } : {}),
      ...(payload.conversationMode ? { conversationMode: payload.conversationMode } : {}),
      ...(linkedDirs.length > 0 ? { allowInvalidLinkedDirs: true } : {}),
      ...(payload.attachments && payload.attachments.length > 0
        ? { pendingFiles: payload.attachments }
        : {}),
      // No `userWorkingDirToken`: linkedDirs grant read-only `--add-dir`
      // access and are validated by the daemon at create time, so they do
      // not need the desktop main-process trust token that baseDir imports
      // require for write access.
      autoSendFirstMessage: true,
    });
  }

  // MatOS role selection for the home composer row. The selection IS the
  // matos agent's persisted
  // model choice — `config.agentModels['matos'].model` carries the
  // `role:<id>` ref that the daemon forwards as `matos --role <ref>` — so
  // the composer picker, the top-bar model switcher, and every run stay on
  // one source of truth. Picking a role also switches the active agent to
  // matos so the conversation started from Home actually runs through it.
  const matosAgent = agents.find((agent) => agent.id === 'matos') ?? null;
  const matosRoleOptions = useMemo(
    () => matosAgent?.models ?? [],
    [matosAgent],
  );
  const matosConfiguredRole = config.agentModels?.matos?.model ?? null;
  const selectedMatosRoleId =
    matosConfiguredRole && matosConfiguredRole !== 'default' ? matosConfiguredRole : null;
  const nativeMatOSChat =
    config.agentId === 'matos'
    || (matosAgent !== null && agents.every((agent) => agent.id === 'matos'));
  function handleMatosRoleChange(roleId: string | null) {
    if (config.agentId !== 'matos') onAgentChange('matos');
    onAgentModelChange('matos', { model: roleId ?? 'default' });
  }
  // Hide the picker entirely when the deployment has no matos runtime at all
  // (upstream Open Design dev shells); while agents are still being detected
  // the picker renders in its disabled loading state instead of flashing out.
  const matosRolePickerAvailable = matosAgent !== null || agentsLoading;

  const avatarMenu = (
    <EntrySettingsMenu
      config={config}
      onThemeChange={onThemeChange}
      onOpenSettings={onOpenSettings}
    />
  );


  if (view === 'onboarding') {
    // MatOS first-run welcome replaces the upstream runtime-connection
    // wizard (OnboardingView stays in-tree but unrouted): the gateway
    // preprovisions the matos runtime, so new users get orientation cards
    // instead of provider setup.
    return (
      <div className="entry-shell entry-shell--no-header entry-shell--onboarding">
        <main className="entry-onboarding-modal" aria-label={t('settings.welcomeTitle')}>
          <Suspense fallback={null}>
            <MatOSOnboardingView
              config={config}
              agents={agents}
                      onAgentChange={onAgentChange}
              onThemeChange={onThemeChange}
              onComplete={(target) => {
                onCompleteOnboarding();
                if (target) {
                  navigate(target);
                  return;
                }
                changeView('home');
              }}
            />
          </Suspense>
        </main>
      </div>
    );
  }

  const executionSwitcher = (
    <InlineModelSwitcher
      config={config}
      agents={agents}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
    />
  );
  const homeExecutionSwitcher = (
    <InlineModelSwitcher
      compact
      config={config}
      agents={agents}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
    />
  );
  const entryViewFallback = <CenteredLoader label={t('common.loading')} />;

  return (
    <div className="entry-shell entry-shell--no-header">
      <div className={`entry${railOpen ? ' entry--rail-open' : ''}`}>
        <EntryNavRail
          view={view}
          onViewChange={changeView}
          onNewProject={() => {
                        openNewProject();
          }}
          open={railEffectiveOpen}
          onClose={() => setRailOpen(false)}
          // Phones: the settings gear joins the feedback destination at the
          // end of the horizontal top bar. The sticky topbar row below (the
          // gear's desktop home) is hidden by entry-layout.css.
          settingsSlot={isMobile ? avatarMenu : undefined}
        />
        <main
          className={`entry-main entry-main--scroll${view === 'workflows' ? ` ${workflowStyles.workbenchMain}` : ''}`}
          ref={entryMainScrollRef}
        >
          <div className="entry-main__topbar">
            <button
              type="button"
              className="entry-rail-toggle"
              onClick={() => setRailOpen((prev) => !prev)}
              aria-label={t('entry.navExpand')}
              aria-expanded={railOpen}
              data-testid="entry-rail-toggle"
            >
              <Icon name="panel-left" size={20} />
            </button>
            <div className="entry-main__topbar-chips entry-main__topbar-chips--icon-only">
              {view === 'home' || view === 'blog' ? null : executionSwitcher}
              <button
                type="button"
                className="use-everywhere-chip od-tooltip"
                onClick={() => {
                                    openIntegrationTab('use-everywhere');
                }}
                data-tooltip={t('entry.useEverywhereTitle')}
                data-tooltip-placement="bottom"
                aria-label={t('entry.useEverywhereAria')}
                data-testid="entry-use-everywhere-button"
              >
                <span className="use-everywhere-chip__icon" aria-hidden>
                  <Icon name="hammer" size={13} />
                </span>
                <span className="use-everywhere-chip__label">
                  {t('entry.useEverywhereTitle')}
                </span>
              </button>
            </div>
            {/* On phones the gear lives in the nav rail (settingsSlot above);
                the topbar row itself is display:none'd by entry-layout.css. */}
            {isMobile ? null : avatarMenu}
          </div>
          <div
            className={`entry-main__inner${
              view === 'home' ? '' : ' entry-main__inner--wide'
            }${view === 'workflows' ? ` ${workflowStyles.workbenchInner}` : ''}`}
          >
            <Suspense fallback={entryViewFallback}>
            <div data-testid="entry-view-home" data-active={view === 'home' ? 'true' : 'false'} {...inactiveViewProps(view === 'home')}>
              {view === 'home' ? (
                <HomeView
                  isActive
                  nativeMatOSChat={nativeMatOSChat}
                  projects={projects}
                  projectsLoading={projectsLoading}
                  matosRoles={matosRoleOptions}
                  matosRolesLoading={agentsLoading && matosRoleOptions.length === 0}
                  selectedMatosRoleId={selectedMatosRoleId}
                  onMatosRoleChange={matosRolePickerAvailable ? handleMatosRoleChange : undefined}
                  onSubmit={handleHomeSubmit}
                  onOpenProject={onOpenProject}
                  onViewAllProjects={() => changeView('projects')}
                  onDeleteProject={onDeleteProject}
                  onDuplicateProject={onDuplicateProject}
                  onRenameProject={onRenameProject}
                  onOpenMcp={() => openIntegrationTab('mcp')}
                  onOpenNewProject={(tab) => {
                    openNewProject(tab);
                  }}
                  onStartBlankProject={startBlankProjectFromRail}
                  skills={skills}
                  skillsLoading={skillsLoading}
                  executionSwitcher={homeExecutionSwitcher}
                />
              ) : null}
            </div>
            <div data-testid="entry-view-projects" data-active={view === 'projects' ? 'true' : 'false'} {...inactiveViewProps(view === 'projects')}>
              {view === 'projects' ? (
                projectsLoading || skillsLoading ? (
                  <CenteredLoader label={t('common.loading')} />
                ) : (
                  <div className="entry-section">
                    <header className="entry-section__head">
                      <h1 className="entry-section__title">{t('entry.navProjects')}</h1>
                    </header>
                    <DesignsTab
                      nativeMatOSChat={nativeMatOSChat}
                      projects={projects}
                      skills={skills}
                      onOpen={onOpenProject}
                      onDelete={onDeleteProject}
                      onDuplicate={onDuplicateProject}
                      onRename={onRenameProject}
                      onRefresh={onProjectsRefresh}
                      isActive
                      onNewProject={() => {
                        openNewProject();
                      }}
                    />
                  </div>
                )
              ) : null}
            </div>
            {/* /automations — scheduled automations (upstream TasksView:
                routines, schedules, run history). The runtime operations
                monitor lives on its own /ops view below. */}
            <div data-testid="entry-view-tasks" data-active={view === 'tasks' ? 'true' : 'false'} {...inactiveViewProps(view === 'tasks')}>
              {view === 'tasks' ? <TasksView /> : null}
            </div>
            <div data-testid="entry-view-ops" data-active={view === 'ops' ? 'true' : 'false'} {...inactiveViewProps(view === 'ops')}>
              {view === 'ops' ? <MatOSOpsView /> : null}
            </div>
            <div data-testid="entry-view-evolution" data-active={view === 'evolution' ? 'true' : 'false'} {...inactiveViewProps(view === 'evolution')}>
              {view === 'evolution' ? <MatOSEvolutionView /> : null}
            </div>
            {view === 'workflows' && route.kind === 'home' ? (
              <WorkflowsView runId={route.workflowRunId} projectId={route.workflowProjectId} />
            ) : null}
            {/* /schedules — native cron workflow scheduler (MatOS scheduled
                tasks), distinct from the /automations agent-conversation
                routines above. */}
            <div data-testid="entry-view-schedules" data-active={view === 'schedules' ? 'true' : 'false'} {...inactiveViewProps(view === 'schedules')}>
              {view === 'schedules' ? <MatOSSchedulesView /> : null}
            </div>

            {view === 'integrations' ? (
              <IntegrationsView
                config={config}
                initialTab={integrationTab}
                onConfigPersist={onConfigPersist}
                onSkillsRefresh={onSkillsRefresh}
                onSkillsChanged={onSkillsChanged}
              />
            ) : null}
            {view === 'assets' ? (
              <AssetsView
                assetRef={route.kind === 'home' ? route.assetRef ?? null : null}
              />
            ) : null}
            {view === 'blog' ? <ReleaseNotesView /> : null}
            {view === 'feedback' ? <UserFeedbackView /> : null}
            {view === 'profile' ? <UserProfileView /> : null}
            </Suspense>
          </div>
        </main>
      </div>
      {matosProjectOpen ? (
        <Suspense fallback={null}>
          <MatOSNewProjectModal
            open
            onCreate={(input) => onCreateProject(input)}
            onClose={() => setMatosProjectOpen(false)}
          />
        </Suspense>
      ) : null}
      {newProjectOpen ? (
        <Suspense fallback={null}>
          <NewProjectModal
            open
            initialTab={newProjectInitialTab}
            skills={skills}
            templates={templates}
            {...(onDeleteTemplate ? { onDeleteTemplate } : {})}
            loading={skillsLoading}
            onCreate={handleCreate}
            {...(onImportFolder ? { onImportFolder } : {})}
            {...(onImportFolderResponse ? { onImportFolderResponse } : {})}
            onClose={() => setNewProjectOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

















type OnboardingDropdownBaseProps = {
  label: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  placement?: 'bottom' | 'top';
  searchable?: boolean;
  searchPlaceholder?: string;
  sourceTone?: string;
};

type OnboardingDropdownProps =
  | (OnboardingDropdownBaseProps & {
      value: string;
      onChange: (value: string) => void;
      multiple?: false;
    })
  | (OnboardingDropdownBaseProps & {
      value: string[];
      onChange: (value: string[]) => void;
      multiple: true;
    });

export function OnboardingDropdown(props: OnboardingDropdownProps) {
  const t = useT();
  const {
    label,
    placeholder,
    value,
    options,
    placement = 'bottom',
    multiple = false,
    searchable = false,
    searchPlaceholder,
    sourceTone,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [resolvedPlacement, setResolvedPlacement] = useState(placement);
  const [menuMaxHeight, setMenuMaxHeight] = useState(240);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dropdownIdRef = useRef(`onboarding-dropdown-${Math.random().toString(36).slice(2)}`);
  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];
  const selectedOptions = options.filter((option) => selectedValues.includes(option.value));
  const selectedOption = selectedOptions[0];
  const hasValue = selectedOptions.length > 0;
  const selectedLabel = multiple
    ? selectedOptions.map((option) => option.label).join(', ')
    : selectedOption?.label;
  const triggerLabel = selectedLabel || placeholder;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions =
    searchable && normalizedQuery
      ? options.filter((option) =>
          `${option.label} ${option.value}`.toLowerCase().includes(normalizedQuery),
        )
      : options;
  const emptyMessage = searchable ? t('homeHero.footer.noMatches') : t('settings.fetchModelsEmpty');

  useLayoutEffect(() => {
    if (!open) return;

    function measureMenu() {
      const root = rootRef.current;
      if (!root) return;

      const rect = root.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      const nextPlacement =
        placement === 'top' || (spaceBelow < 260 && spaceAbove > spaceBelow)
          ? 'top'
          : 'bottom';
      const availableSpace = nextPlacement === 'top' ? spaceAbove : spaceBelow;
      setResolvedPlacement(nextPlacement);
      setMenuMaxHeight(Math.max(48, Math.min(240, availableSpace - 16)));
    }

    measureMenu();
    window.addEventListener('resize', measureMenu);
    window.addEventListener('scroll', measureMenu, true);
    return () => {
      window.removeEventListener('resize', measureMenu);
      window.removeEventListener('scroll', measureMenu, true);
    };
  }, [open, placement, options.length]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    function handlePeerOpen(event: Event) {
      if ((event as CustomEvent<string>).detail !== dropdownIdRef.current) {
        setOpen(false);
      }
    }

    window.addEventListener(ONBOARDING_DROPDOWN_OPEN_EVENT, handlePeerOpen);
    return () => {
      window.removeEventListener(ONBOARDING_DROPDOWN_OPEN_EVENT, handlePeerOpen);
    };
  }, []);

  function toggleOpen() {
    setOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        window.dispatchEvent(
          new CustomEvent(ONBOARDING_DROPDOWN_OPEN_EVENT, {
            detail: dropdownIdRef.current,
          }),
        );
      }
      return nextOpen;
    });
  }

  return (
    <div
      className="onboarding-view__select-field"
      data-placement={resolvedPlacement}
      data-open={open || undefined}
      ref={rootRef}
    >
      <span
        className="onboarding-view__select-label"
        data-source-tone={sourceTone || undefined}
      >
        {label}
      </span>
      <button
        type="button"
        className={`onboarding-view__select-trigger${open ? ' is-open' : ''}${
          hasValue ? ' has-value' : ''
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={triggerLabel}
        onClick={toggleOpen}
      >
        <span>{triggerLabel}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div
          className="onboarding-view__select-menu"
          data-searchable={searchable || undefined}
          style={{ '--onboarding-select-menu-max-height': `${menuMaxHeight}px` } as CSSProperties}
        >
          {searchable ? (
            <label
              className="onboarding-view__select-search"
              onClick={(event) => event.stopPropagation()}
            >
              <Icon name="search" size={14} />
              <input
                type="search"
                value={query}
                placeholder={searchPlaceholder || placeholder}
                aria-label={searchPlaceholder || label}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') {
                    event.stopPropagation();
                  }
                }}
              />
            </label>
          ) : null}
          <div
            className="onboarding-view__select-options"
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple || undefined}
          >
            {visibleOptions.map((option) => {
              const selected = selectedValues.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`onboarding-view__select-option${selected ? ' is-selected' : ''}`}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    if (props.multiple) {
                      props.onChange(
                        selected
                          ? selectedValues.filter((selectedValue) => selectedValue !== option.value)
                          : [...selectedValues, option.value],
                      );
                      return;
                    }
                    props.onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {selected ? <Icon name="check" size={15} /> : null}
                </button>
              );
            })}
            {visibleOptions.length === 0 ? (
              <div className="onboarding-view__select-empty">{emptyMessage}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}


