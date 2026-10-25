import type { ChatSessionMode,RunContextSelection } from '@open-design/contracts';
import { AnimatePresence,MotionConfig } from 'motion/react';
import { lazy,Suspense,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { IntegrationTab } from './components/IntegrationsView';
import type { CreateInput } from './components/NewProjectPanel';

import { detectOpenDesignHostClientType, type OpenDesignHostProjectImportSuccess } from '@open-design/host';
import {
appRouteResourcePlan,
type AppRouteResource,
} from './app-resource-policy';
import {
IframeKeepAliveProvider,
useIframeKeepAlivePool,
} from './components/IframeKeepAlivePool';
import { CenteredLoader } from './components/Loading';
import type { SettingsSection } from './components/SettingsDialog';
import { Toast } from './components/Toast';
import { TooltipLayer } from './components/TooltipLayer';
import { openWorkspaceTab,WorkspaceTabsBar } from './components/WorkspaceTabsBar';
import { useModalWindowDragGuard } from './hooks/useModalWindowDragGuard';
import { useI18n } from './i18n';
import {
daemonIsLive,
fetchAgentsStream,
fetchAppVersionInfo,
fetchDesignTemplates,
fetchSkills,
replaceProjectWorkingDir,
uploadProjectFiles,
} from './providers/registry';
import { goBack,navigate,useRoute } from './router';
import { applyAppearanceToDocument } from './state/appearance';
import {
fetchDaemonConfig,
fetchMediaProvidersFromDaemon,
hasAnyConfiguredProvider,
loadConfig,
mergeDaemonConfig,
mergeDaemonMediaProviders,
saveConfig,
shouldSyncLocalMediaProvidersToDaemon,
syncConfigToDaemon,
syncMediaProvidersToDaemon,
} from './state/config';
import {
createProject,
deleteProject as deleteProjectApi,
deleteTemplate,
duplicateProject,
getProject,
importFolderProject,
listProjects,
listTemplates,
patchProject,
} from './state/projects';
import type {
AgentInfo,
AppConfig,
AppVersionInfo,
ChatAttachment,
Project,
ProjectMetadata,
ProjectTemplate,
SkillSummary,
} from './types';
import { isMacPlatform } from './utils/platform';

const EntryView = lazy(() =>
  import('./components/EntryView').then((mod) => ({ default: mod.EntryView })),
);
const ServerFolderPickerHost = lazy(() =>
  import('./components/ServerFolderPicker').then((mod) => ({
    default: mod.ServerFolderPickerHost,
  })),
);
const ProjectView = lazy(() =>
  import('./components/ProjectView').then((mod) => ({ default: mod.ProjectView })),
);
const SettingsDialog = lazy(() =>
  import('./components/SettingsDialog').then((mod) => ({ default: mod.SettingsDialog })),
);

type AppCreateProjectInput = Omit<CreateInput, 'metadata'> & {
  metadata?: CreateInput['metadata'];
  // MatOS new-project form: explicit slug id (doubles as the folder name
  // under the chosen project location) + the location the folder is
  // created in. Both optional — every other create path keeps random ids
  // and the built-in managed root.
  id?: string;
  projectLocationId?: string;
  pendingPrompt?: string;
  initialRunContext?: RunContextSelection | null;
  conversationMode?: ChatSessionMode;
  autoSendFirstMessage?: boolean;
  allowInvalidLinkedDirs?: boolean;
  pendingFiles?: File[];
  userWorkingDirToken?: string;
  linkedDirs?: string[] | null;
};

const APP_CONFIG_CHANGED_EVENT = 'open-design:app-config-changed';
const AGENT_FOCUS_REFRESH_THROTTLE_MS = 10_000;
const APP_DEFERRED_RESOURCE_DELAY_MS = 1_200;
const SETTINGS_RESOURCES: readonly AppRouteResource[] = [
  'agents',
  'projects',
];

function scheduleDeferredAppResources(work: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(work, { timeout: APP_DEFERRED_RESOURCE_DELAY_MS });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(work, APP_DEFERRED_RESOURCE_DELAY_MS);
  return () => window.clearTimeout(id);
}

export function shouldSyncMediaProvidersOnSave(
  mediaProviders: AppConfig['mediaProviders'],
  options?: { force?: boolean },
): boolean {
  return Boolean(options?.force) || hasAnyConfiguredProvider(mediaProviders);
}

function mergeLinkedDirsIntoMetadata(
  metadata: ProjectMetadata | undefined,
  linkedDirs?: string[] | null,
): ProjectMetadata | undefined {
  const nextDirs = (linkedDirs ?? []).map((dir) => dir.trim()).filter(Boolean);
  if (nextDirs.length === 0) return metadata;
  const baseMetadata = metadata ?? { kind: 'other' };
  return {
    ...baseMetadata,
    linkedDirs: Array.from(new Set([...(baseMetadata.linkedDirs ?? []), ...nextDirs])),
  };
}

type ProjectListRequest = {
  generation: number;
  mutationVersion: number;
};

export function buildPersistedConfig(next: AppConfig, current: AppConfig): AppConfig {
  return {
    ...next,
    onboardingCompleted: current.onboardingCompleted ? true : next.onboardingCompleted,
  };
}

/**
 * True when `next` and `last` produce an identical persisted shape —
 * i.e. the only diffs between them are fields that buildPersistedConfig
 * intentionally strips before disk/daemon writes.
 */
export function isAutosaveDraftOnlyChange(next: AppConfig, last: AppConfig): boolean {
  return (
    JSON.stringify(buildPersistedConfig(next, next))
    === JSON.stringify(buildPersistedConfig(last, last))
  );
}

export function resolveSettingsCloseConfig(
  rendered: AppConfig,
  latestPersisted: AppConfig,
): AppConfig {
  const base = latestPersisted === rendered ? rendered : latestPersisted;
  return base.onboardingCompleted ? base : { ...base, onboardingCompleted: true };
}

function upsertAgent(agents: AgentInfo[], agent: AgentInfo): AgentInfo[] {
  const index = agents.findIndex((item) => item.id === agent.id);
  if (index === -1) return [...agents, agent];
  const next = agents.slice();
  next[index] = agent;
  return next;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

export function App() {
  // `reducedMotion="user"` makes every motion/react component honor the OS
  // `prefers-reduced-motion` setting: transform/layout animations are zeroed
  // out while opacity-only changes are kept. The CSS `@media (prefers-reduced-
  // motion: reduce)` block covers the CSS-keyframe surfaces, but the dialogs,
  // toasts and popovers that moved to motion/react need this gate too — without
  // it they keep springing/sliding for users who asked us not to animate.
  return (
    <MotionConfig reducedMotion="user">
      <IframeKeepAliveProvider>
        <AppInner />
      </IframeKeepAliveProvider>
    </MotionConfig>
  );
}

function AppInner() {
  const { t } = useI18n();
  const iframeKeepAlivePool = useIframeKeepAlivePool();
  const clientType = useMemo(() => detectOpenDesignHostClientType(), []);
  useModalWindowDragGuard();
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.od-loading-shell').forEach((node) => node.remove());
    }
  }, []);
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const configRef = useRef(config);
  configRef.current = config;
  const latestPersistedConfigRef = useRef(config);
  latestPersistedConfigRef.current = config;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Surfaced when a Home-picked working dir could not be applied to a freshly
  // created project (expired/invalid desktop token, daemon rejection). Without
  // this the failure was swallowed and the user believed their folder was in
  // effect while the project actually stayed in the managed root.
  const [workingDirError, setWorkingDirError] = useState<string | null>(null);
  const [projectOpenError, setProjectOpenError] = useState<string | null>(null);
  const [settingsWelcome, setSettingsWelcome] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('execution');
  const [integrationInitialTab, setIntegrationInitialTab] = useState<IntegrationTab>('mcp');
  const [daemonLive, setDaemonLive] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const agentStreamRequestSeqRef = useRef(0);
  const agentFocusRefreshLastRunRef = useRef(Date.now());
  // Functional skills (capabilities the agent invokes mid-task) — stays
  // small and lives under the Settings → Skills surface.
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  // Design templates (rendering catalogue: decks, prototypes, image/video/
  // audio templates) — sourced from /api/design-templates and shown in the
  // EntryView Templates tab.
  const [designTemplates, setDesignTemplates] = useState<SkillSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const projectsRef = useRef<Project[]>(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  const pendingLocalProjectIdsRef = useRef<Set<string>>(new Set());
  const locallyDeletedProjectIdsRef = useRef<Map<string, number>>(new Map());
  const projectListMutationVersionRef = useRef(0);
  const projectListRequestGenerationRef = useRef(0);
  const latestAppliedProjectListGenerationRef = useRef(0);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionInfo | null>(
    null,
  );
  const [daemonMediaProviders, setDaemonMediaProviders] = useState<
    AppConfig['mediaProviders'] | null
  >(null);
  const [daemonMediaProvidersFetchState, setDaemonMediaProvidersFetchState] = useState<
    'idle' | 'ok' | 'error'
  >('idle');
  const [mediaProvidersNotice, setMediaProvidersNotice] = useState<string | null>(null);
  // Per-resource loading flags. Each goes false the moment its own fetch
  // resolves so each entry-view tab can render as its data lands instead of
  // every tab waiting on the slowest endpoint (typically `/api/agents`,
  // which probes CLI versions and can take seconds on cold start). The entry
  // view picks the right flag for whichever tab the user is currently on.
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const appResourceLoadedRef = useRef<Set<AppRouteResource>>(new Set());
  const appResourceInFlightRef = useRef<Map<AppRouteResource, Promise<void>>>(new Map());
  const bootstrapAgentAbortRef = useRef<AbortController | null>(null);
  // Goes true once the daemon-persisted config (agentId/etc.)
  // has merged into local state. Auto-selection effects below wait on this
  // so they don't race ahead of the daemon-stored choice and overwrite it
  // with a freshly picked first-available agent.
  const [daemonConfigLoaded, setDaemonConfigLoaded] = useState(false);
  const route = useRoute();

  const beginAgentStreamRequest = useCallback(() => {
    agentStreamRequestSeqRef.current += 1;
    return agentStreamRequestSeqRef.current;
  }, []);

  const isCurrentAgentStreamRequest = useCallback((requestId: number) => {
    return agentStreamRequestSeqRef.current === requestId;
  }, []);


  const rememberLocalProject = useCallback((projectId: string) => {
    pendingLocalProjectIdsRef.current.add(projectId);
    locallyDeletedProjectIdsRef.current.delete(projectId);
    projectListMutationVersionRef.current += 1;
  }, []);

  const clearLocalProject = useCallback((projectId: string, options?: { deleted?: boolean }) => {
    pendingLocalProjectIdsRef.current.delete(projectId);
    projectListMutationVersionRef.current += 1;
    if (options?.deleted) {
      locallyDeletedProjectIdsRef.current.set(
        projectId,
        projectListMutationVersionRef.current,
      );
    }
  }, []);

  const beginProjectListRequest = useCallback((): ProjectListRequest => {
    projectListRequestGenerationRef.current += 1;
    return {
      generation: projectListRequestGenerationRef.current,
      mutationVersion: projectListMutationVersionRef.current,
    };
  }, []);

  const reconcileFetchedProjects = useCallback((list: Project[], request: ProjectListRequest) => {
    const pendingLocalProjectIds = pendingLocalProjectIdsRef.current;
    const locallyDeletedProjectIds = locallyDeletedProjectIdsRef.current;
    const fetchedIds = new Set(list.map((project) => project.id));
    if (request.generation < latestAppliedProjectListGenerationRef.current) {
      const visibleList =
        locallyDeletedProjectIds.size > 0
          ? list.filter((project) => !locallyDeletedProjectIds.has(project.id))
          : list;
      if (visibleList.length === 0) return false;
      const hydratableProjects = visibleList.filter(
        (project) =>
          pendingLocalProjectIds.has(project.id),
      );
      if (hydratableProjects.length === 0) return false;
      const hydratableById = new Map(
        hydratableProjects.map((project) => [project.id, project]),
      );
      for (const project of hydratableProjects) {
        pendingLocalProjectIds.delete(project.id);
      }
      setProjects((current) => {
        let changed = false;
        const currentIds = new Set<string>();
        const next = current.map((project) => {
          currentIds.add(project.id);
          const hydrated = hydratableById.get(project.id);
          if (!hydrated) return project;
          changed = true;
          hydratableById.delete(project.id);
          return hydrated;
        });
        for (const project of hydratableById.values()) {
          if (currentIds.has(project.id)) continue;
          changed = true;
          next.push(project);
        }
        return changed ? next : current;
      });
      return true;
    }
    latestAppliedProjectListGenerationRef.current = request.generation;
    for (const id of fetchedIds) pendingLocalProjectIds.delete(id);
    for (const [id, deletedAtMutationVersion] of locallyDeletedProjectIds) {
      if (
        request.mutationVersion >= deletedAtMutationVersion
        && !fetchedIds.has(id)
      ) {
        locallyDeletedProjectIds.delete(id);
      }
    }
    const activeDeletedProjectIds = new Set(locallyDeletedProjectIds.keys());
    const visibleList =
      activeDeletedProjectIds.size > 0
        ? list.filter((project) => !activeDeletedProjectIds.has(project.id))
        : list;
    const visibleFetchedIds =
      activeDeletedProjectIds.size > 0
        ? new Set(visibleList.map((project) => project.id))
        : fetchedIds;
    setProjects((current) => {
      const preserved = current.filter(
        (project) =>
          pendingLocalProjectIds.has(project.id) &&
          !visibleFetchedIds.has(project.id) &&
          !activeDeletedProjectIds.has(project.id),
      );
      return preserved.length > 0 ? [...preserved, ...visibleList] : visibleList;
    });
    return true;
  }, []);

  const loadAppResource = useCallback((resource: AppRouteResource): Promise<void> => {
    if (appResourceLoadedRef.current.has(resource)) return Promise.resolve();
    const existing = appResourceInFlightRef.current.get(resource);
    if (existing) return existing;

    let work: Promise<void> = Promise.resolve();
    switch (resource) {
      case 'agents': {
        setAgentsLoading(true);
        const requestId = beginAgentStreamRequest();
        const controller = new AbortController();
        bootstrapAgentAbortRef.current = controller;
        work = fetchAgentsStream({
          signal: controller.signal,
          onAgent: (agent) => {
            if (!isCurrentAgentStreamRequest(requestId)) return;
            setAgents((current) =>
              upsertAgent(current, agent),
            );
          },
        })
          .then((list) => {
            if (!isCurrentAgentStreamRequest(requestId)) return;
            setAgents(
              list,
            );
          })
          .catch((err) => {
            if (isAbortError(err) || !isCurrentAgentStreamRequest(requestId)) return;
            setAgents([]);
          })
          .finally(() => {
            if (bootstrapAgentAbortRef.current === controller) {
              bootstrapAgentAbortRef.current = null;
            }
            if (isCurrentAgentStreamRequest(requestId)) setAgentsLoading(false);
          });
        break;
      }
      case 'skills':
        setSkillsLoading(true);
        work = fetchSkills().then((list) => {
          setSkills(list);
        });
        break;
      case 'designTemplates':
        setSkillsLoading(true);
        work = fetchDesignTemplates().then((list) => {
          setDesignTemplates(list);
        });
        break;
      case 'projects': {
        setProjectsLoading(true);
        const projectRequest = beginProjectListRequest();
        work = listProjects().then((list) => {
          reconcileFetchedProjects(list, projectRequest);
          setProjectsLoading(false);
        });
        break;
      }
      case 'templates':
        work = listTemplates().then((list) => {
          setTemplates(list);
        });
        break;
    }

    const tracked = work.finally(() => {
      appResourceLoadedRef.current.add(resource);
      if (appResourceInFlightRef.current.get(resource) === tracked) {
        appResourceInFlightRef.current.delete(resource);
      }
      if (
        (resource === 'skills' || resource === 'designTemplates')
        && appResourceLoadedRef.current.has('skills')
        && appResourceLoadedRef.current.has('designTemplates')
      ) {
        setSkillsLoading(false);
      }
    });
    appResourceInFlightRef.current.set(resource, tracked);
    return tracked;
  }, [
    beginAgentStreamRequest,
    beginProjectListRequest,
    isCurrentAgentStreamRequest,
    reconcileFetchedProjects,
  ]);

  // Sync theme preference to the <html> element so CSS variables pick it up.
  // useLayoutEffect (vs useEffect) fires before the browser paints, so a
  // live theme switch in Settings applies atomically — no 1-frame flash of
  // the old theme. Safe here because the component tree is ssr:false.
  useLayoutEffect(() => {
    applyAppearanceToDocument({
      theme: config.theme ?? 'system',
      accentColor: config.accentColor,
    });
  }, [config.theme, config.accentColor]);

  // Tell the daemon what the user is currently looking at, so the MCP
  // server can surface it as `get_active_context` to a coding agent in
  // another repo. Best-effort fire-and-forget; the daemon holds it in
  // memory with a short TTL and the MCP layer falls back to
  // {active:false} if this hasn't run.
  const activeProjectId = route.kind === 'project' ? route.projectId : null;
  const activeFileName = route.kind === 'project' ? route.fileName : null;
  useEffect(() => {
    const body = activeProjectId
      ? { projectId: activeProjectId, fileName: activeFileName }
      : { active: false };
    fetch('/api/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // Daemon down or transient network — not worth surfacing.
    });
  }, [activeProjectId, activeFileName]);




  // Bootstrap only the daemon-owned config that is global to every route.
  // Catalogue reads are scheduled separately below from the active route, so
  // opening Ops/Schedules/Assets cannot accidentally compete with seven
  // unrelated registry scans before that page receives its own response.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const alive = await daemonIsLive();
      if (cancelled) return;
      setDaemonLive(alive);
      if (!alive) {
        // No daemon — clear every loading flag so empty states render
        // instead of the entry view sitting on indefinite spinners.
        setAgentsLoading(false);
        setSkillsLoading(false);
        setProjectsLoading(false);
        setDaemonConfigLoaded(true);
        return;
      }

      // Daemon-persisted config + media provider config land together so
      // the welcome-modal decision and daemon-backed settings apply in one
      // merge, avoiding a flash where local-only state is shown before
      // daemon overrides it.
      void Promise.all([
        fetchDaemonConfig(),
        fetchMediaProvidersFromDaemon(),
      ]).then(([
        daemonConfig,
        daemonMediaProvidersResult,
      ]) => {
        if (cancelled) return;
        const daemonMediaProvidersLoaded =
          daemonMediaProvidersResult.status === 'ok'
            ? daemonMediaProvidersResult.providers
            : null;
        setDaemonMediaProviders(daemonMediaProvidersLoaded);
        setDaemonMediaProvidersFetchState(daemonMediaProvidersResult.status);
        setMediaProvidersNotice(
          daemonMediaProvidersResult.status === 'error'
            ? t('settings.mediaProviderLoadError')
            : null,
        );
        // Compute the next config outside the setConfig updater so we can
        // both (a) call navigate() after setConfig returns — calling it
        // inside the updater would trigger a Router setState during React's
        // render phase — and (b) read next.onboardingCompleted synchronously,
        // since React batches setConfig and the updater doesn't run until
        // the next render. latestPersistedConfigRef is kept in sync with
        // the rendered config and is safe to read here.
        const baseConfig = latestPersistedConfigRef.current;
        const migratedLocalMediaProviders = shouldSyncLocalMediaProvidersToDaemon(
          baseConfig.mediaProviders,
          daemonMediaProvidersLoaded,
        );
        const next = mergeDaemonMediaProviders(
          mergeDaemonConfig(baseConfig, daemonConfig),
          daemonMediaProvidersLoaded,
        );
        saveConfig(next);
        if (
          daemonMediaProvidersResult.status === 'ok' &&
          migratedLocalMediaProviders &&
          hasAnyConfiguredProvider(next.mediaProviders)
        ) {
          void syncMediaProvidersToDaemon(next.mediaProviders, {
            daemonProviders: daemonMediaProvidersLoaded,
          });
        }
        // Migrate localStorage prefs to daemon on first boot with the new
        // endpoint. If daemon already had values the merge above used them;
        // writing back is idempotent and keeps both sides in sync.
        void syncConfigToDaemon(next);
        latestPersistedConfigRef.current = next;
        setConfig(next);

        // Route first-run users through the global onboarding panel.
        if (!next.onboardingCompleted) {
          navigate({ kind: 'home', view: 'onboarding' }, { replace: true });
        }
        setDaemonConfigLoaded(true);
      });
    })();
    return () => {
      cancelled = true;
      bootstrapAgentAbortRef.current?.abort();
    };
  }, []);

  const routeResourceKey =
    route.kind === 'home' ? `home:${route.view}` : route.kind;
  useEffect(() => {
    if (!daemonLive) return;
    const plan = appRouteResourcePlan(route);
    // Loading flags for catalogues this route never plans must not stay
    // raised: EntryShell/HomeHero gate rendering on them, and a resource that
    // no plan (nor Settings) loads anymore would otherwise spin forever.
    // A later real load re-raises its flag before fetching.
    const planned = new Set([...plan.immediate, ...plan.deferred]);
    if (!planned.has('skills') && !planned.has('designTemplates')) {
      setSkillsLoading(false);
    }
    for (const resource of plan.immediate) void loadAppResource(resource);
    if (plan.deferred.length === 0) return;
    return scheduleDeferredAppResources(() => {
      for (const resource of plan.deferred) void loadAppResource(resource);
    });
    // The key is the resource-relevant route projection; project ids and file
    // names do not change which global catalogues are needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonLive, loadAppResource, routeResourceKey]);

  // Settings is the only App consumer of this duplicate version read. Keep
  // About accurate without adding `/api/version` to every page's startup burst.
  useEffect(() => {
    if (!settingsOpen || appVersionInfo !== null || !daemonLive) return;
    let cancelled = false;
    void fetchAppVersionInfo().then((info) => {
      if (!cancelled) setAppVersionInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [appVersionInfo, daemonLive, settingsOpen]);

  // Global Settings can be opened from routes whose own resource plan is
  // intentionally empty (repo import) or minimal (Ops). Hydrate
  // its complete catalogue surface only after that explicit user gesture.
  useEffect(() => {
    if (!settingsOpen || !daemonLive) return;
    for (const resource of SETTINGS_RESOURCES) void loadAppResource(resource);
  }, [daemonLive, loadAppResource, settingsOpen]);

  // Auto-pick the first available agent once both the daemon-stored config
  // and the agents listing have landed. Splitting this out of bootstrap
  // avoids racing the local-config initial value against a slow agents
  // probe — by the time this runs, daemonConfig has already overlaid the
  // user's previous choice, so we only fill an empty slot.
  //
  // First-run onboarding owns the initial agent pick, so this only backfills
  // an empty slot for returning users.
  useEffect(() => {
    if (!daemonConfigLoaded || agentsLoading) return;
    if (config.onboardingCompleted !== true) return;
    // A stored agentId the registry no longer exposes is treated as an empty
    // slot instead of letting runs fail on a retired agent id.
    const stillRegistered =
      config.agentId && agents.some((a) => a.id === config.agentId);
    if (config.agentId && (stillRegistered || agents.length === 0)) return;
    const firstAvailable = agents.find((a) => a.available) ?? agents[0];
    if (!firstAvailable) return;
    setConfig((prev) => {
      if (prev.agentId === firstAvailable.id) return prev;
      const next: AppConfig = { ...prev, agentId: firstAvailable.id };
      saveConfig(next);
      void syncConfigToDaemon(next);
      return next;
    });
  }, [
    daemonConfigLoaded,
    agentsLoading,
    agents,
    config.agentId,
    config.onboardingCompleted,
  ]);

  const refreshProjects = useCallback(async () => {
    const request = beginProjectListRequest();
    const list = await listProjects();
    reconcileFetchedProjects(list, request);
  }, [beginProjectListRequest, reconcileFetchedProjects]);

  const refreshProjectsStrict = useCallback(async () => {
    const request = beginProjectListRequest();
    const list = await listProjects({ throwOnError: true });
    reconcileFetchedProjects(list, request);
  }, [beginProjectListRequest, reconcileFetchedProjects]);

  const refreshSkills = useCallback(async () => {
    const list = await fetchSkills();
    setSkills(list);
  }, []);

  const refreshTemplates = useCallback(async () => {
    const list = await listTemplates();
    setTemplates(list);
  }, []);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    const ok = await deleteTemplate(id);
    if (ok) await refreshTemplates();
    return ok;
  }, [refreshTemplates]);

  const reloadMediaProvidersFromDaemon = useCallback(async () => {
    const result = await fetchMediaProvidersFromDaemon();
    if (result.status !== 'ok') {
      setDaemonMediaProvidersFetchState('error');
      setMediaProvidersNotice(
        t('settings.mediaProviderLoadError'),
      );
      return null;
    }
    setDaemonMediaProviders(result.providers);
    setDaemonMediaProvidersFetchState('ok');
    setMediaProvidersNotice(null);
    setConfig((prev) => {
      const merged = mergeDaemonMediaProviders(prev, result.providers);
      saveConfig(merged);
      return merged;
    });
    return result.providers;
  }, []);

  /**
   * Autosave-driven persistence path. The settings dialog calls this on
   * every committed edit (via a debounced effect) so localStorage and
   * the daemon stay in lock-step with the user's draft. Onboarding is
   * left alone; the dialog's close path is the canonical "I'm done" signal.
   */
  const handleConfigPersist = useCallback(async (
    next: AppConfig,
    options?: { forceMediaProviderSync?: boolean },
  ) => {
    // If the dialog is closing, preserve any onboarding completion that
    // the close gesture already committed so an unmount autosave cannot
    // re-open the welcome flow.
    const persisted = buildPersistedConfig(next, configRef.current);
    latestPersistedConfigRef.current = persisted;
    saveConfig(persisted);
    setConfig(persisted);
    const shouldSyncMediaProviders =
      daemonMediaProvidersFetchState === 'ok'
      && shouldSyncMediaProvidersOnSave(persisted.mediaProviders, {
        force: options?.forceMediaProviderSync,
      });
    await Promise.all([
      shouldSyncMediaProviders
        ? syncMediaProvidersToDaemon(persisted.mediaProviders, {
            force: options?.forceMediaProviderSync,
            daemonProviders: daemonMediaProviders,
            throwOnError: options?.forceMediaProviderSync,
          })
        : Promise.resolve(),
      syncConfigToDaemon(persisted, { throwOnError: true }),
    ]);
  }, [daemonMediaProviders, daemonMediaProvidersFetchState]);

  // Quick theme switch from the settings dropdown in the entry view.
  // Skips the full SettingsDialog round-trip so the appearance flip
  // feels instantaneous; the live preview comes for free because the
  // `useLayoutEffect` above re-runs `applyAppearanceToDocument` the
  // moment `config.theme` changes. We still persist to localStorage
  // and the daemon so the choice survives reloads.
  const handleThemeChange = useCallback(
    (theme: AppConfig['theme']) => {
      const next = { ...config, theme };
      // Apply to the DOM synchronously inside the click handler so the theme
      // flips instantly. Otherwise the visible switch waits on the (heavier)
      // React re-render of the whole tree before the layout effect re-applies
      // it — which reads as a perceptible lag after the click.
      applyAppearanceToDocument({
        theme: theme ?? 'system',
        accentColor: config.accentColor,
      });
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [config],
  );

  const handleAgentChange = useCallback(
    (agentId: string) => {
      const next = { ...latestPersistedConfigRef.current, agentId };
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  const handleAgentModelChange = useCallback(
    (agentId: string, choice: { model?: string; reasoning?: string }) => {
      const current = latestPersistedConfigRef.current;
      const prev = current.agentModels?.[agentId] ?? {};
      const merged = { ...prev, ...choice };
      const nextAgentModels = {
        ...(current.agentModels ?? {}),
        [agentId]: merged,
      };
      const next = { ...current, agentModels: nextAgentModels };
      latestPersistedConfigRef.current = next;
      saveConfig(next);
      void syncConfigToDaemon(next);
      setConfig(next);
    },
    [],
  );

  const refreshAgents = useCallback(
    async (options?: { throwOnError?: boolean; agentCliEnv?: AppConfig['agentCliEnv'] }) => {
      if (options && Object.prototype.hasOwnProperty.call(options, 'agentCliEnv')) {
        const nextConfig = {
          ...config,
          agentCliEnv: options.agentCliEnv ?? {},
        };
        saveConfig(nextConfig);
        await syncConfigToDaemon(nextConfig);
        setConfig(nextConfig);
      }
      const agentRequestId = beginAgentStreamRequest();
      setAgentsLoading(true);
      try {
        const next = await fetchAgentsStream({
          onAgent: (agent) => {
            if (!isCurrentAgentStreamRequest(agentRequestId)) return;
            setAgents((current) =>
              upsertAgent(current, agent),
            );
          },
        });
        const ordered = next;
        if (isCurrentAgentStreamRequest(agentRequestId)) {
          setAgents(ordered);
          setAgentsLoading(false);
        }
        return ordered;
      } catch (err) {
        if (!isCurrentAgentStreamRequest(agentRequestId)) return [];
        setAgentsLoading(false);
        if (options?.throwOnError) throw err;
        setAgents([]);
        return [];
      }
    },
    [beginAgentStreamRequest, config, isCurrentAgentStreamRequest],
  );

  useEffect(() => {
    if (!daemonLive || agentsLoading) return;

    const refreshIfDue = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - agentFocusRefreshLastRunRef.current < AGENT_FOCUS_REFRESH_THROTTLE_MS) return;
      agentFocusRefreshLastRunRef.current = now;
      void refreshAgents();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshIfDue();
    };

    window.addEventListener('focus', refreshIfDue);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshIfDue);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [agentsLoading, daemonLive, refreshAgents]);

  useEffect(() => {
    const handleAppConfigChanged = () => {
      void fetchDaemonConfig().then((daemonConfig) => {
        const next = mergeDaemonConfig(latestPersistedConfigRef.current, daemonConfig);
        latestPersistedConfigRef.current = next;
        saveConfig(next);
        setConfig(next);
        void refreshAgents();
      });
    };
    window.addEventListener(APP_CONFIG_CHANGED_EVENT, handleAppConfigChanged);
    return () => window.removeEventListener(APP_CONFIG_CHANGED_EVENT, handleAppConfigChanged);
  }, [refreshAgents]);

  const handleCreateProject = useCallback(
    async (
      input: AppCreateProjectInput,
    ): Promise<boolean> => {
      const derivedPendingPrompt = input.pendingPrompt;

      const metadata = mergeLinkedDirsIntoMetadata(input.metadata, input.linkedDirs);
      let result;
      try {
        result = await createProject({
          name: input.name,
          skillId: input.skillId,
          pendingPrompt: derivedPendingPrompt,
          metadata,
          ...(input.id ? { id: input.id } : {}),
          ...(input.projectLocationId ? { projectLocationId: input.projectLocationId } : {}),
          ...(input.conversationMode ? { conversationMode: input.conversationMode } : {}),
          ...(input.allowInvalidLinkedDirs ? { allowInvalidLinkedDirs: true } : {}),
        });
      } catch (err) {
        const errorCode =
          err instanceof Error && err.message.trim()
            ? err.message
            : 'CREATE_REQUEST_FAILED';
        throw err;
      }
      const pendingFiles = Array.isArray(input.pendingFiles)
        ? input.pendingFiles.filter((file): file is File => file instanceof File)
        : [];
      // Flip the project onto the user-picked working directory BEFORE
      // uploading staged Home attachments. `replaceProjectWorkingDir` changes
      // `metadata.baseDir`, so the project starts reading from the external
      // folder. If we uploaded first, the staged files would land in the
      // temporary managed `.od/projects/<id>` root and then silently vanish
      // from Design Files and the first auto-send context once the working
      // dir flips. Doing the handoff first means the initial upload lands in
      // the final tree.
      const userWorkingDir = metadata?.userWorkingDir;
      let workingDirHandoffFailed = false;
      if (userWorkingDir) {
        try {
          await replaceProjectWorkingDir(
            result.project.id,
            userWorkingDir,
            input.userWorkingDirToken,
          );
        } catch (err) {
          // The desktop working-dir token is short-lived (~60s TTL); if the
          // user lingered on Home or the POST was otherwise rejected, the
          // handoff fails AFTER the project already exists. Do NOT swallow
          // this and do NOT proceed: uploading staged attachments or
          // auto-sending the first message would target the managed
          // `.od/projects/<id>` root the user did not choose. Mark the
          // handoff as failed so the upload + auto-send branches below are
          // skipped, then surface a create-time error so the user can
          // re-pick the working directory from inside the project.
          console.warn('Failed to set working directory for new project', userWorkingDir, err);
          workingDirHandoffFailed = true;
          setWorkingDirError(
            `Couldn't apply the chosen folder "${userWorkingDir}". The project was created in the default location — re-pick the working directory from the project before uploading files or sending a message.`,
          );
        }
      }
      let firstMessageAttachments: ChatAttachment[] = [];
      if (!workingDirHandoffFailed && pendingFiles.length > 0) {
        const uploadResult = await uploadProjectFiles(result.project.id, pendingFiles);
        firstMessageAttachments = uploadResult.uploaded;
        if (uploadResult.failed.length > 0) {
          console.warn('Some Home attachments failed to upload', uploadResult.failed);
        }
      }
      // The user already typed (or accepted) the first message on Home.
      // Mark this project so ProjectView fires
      // sendMessage(pendingPrompt) once on mount instead of just
      // pre-filling the composer. Scoped to sessionStorage so a page
      // reload after the run has started does not refire.
      if (
        !workingDirHandoffFailed &&
        input.autoSendFirstMessage &&
        (derivedPendingPrompt !== undefined || firstMessageAttachments.length > 0)
      ) {
        try {
          window.sessionStorage.setItem(
            `od:auto-send-first:${result.project.id}`,
            '1',
          );
          if (firstMessageAttachments.length > 0) {
            window.sessionStorage.setItem(
              `od:auto-send-attachments:${result.project.id}`,
              JSON.stringify(firstMessageAttachments),
            );
          } else {
            window.sessionStorage.removeItem(
              `od:auto-send-attachments:${result.project.id}`,
            );
          }
          if (input.initialRunContext && Object.keys(input.initialRunContext).length > 0) {
            window.sessionStorage.setItem(
              `od:auto-send-context:${result.project.id}`,
              JSON.stringify(input.initialRunContext),
            );
          } else {
            window.sessionStorage.removeItem(
              `od:auto-send-context:${result.project.id}`,
            );
          }
        } catch {
          /* sessionStorage may be unavailable (e.g. SSR / private mode); fall
             back to manual send. */
        }
      }
      const project = result.project;
      rememberLocalProject(project.id);
      flushSync(() => {
        setProjects((curr) => [
          project,
          ...curr.filter((p) => p.id !== project.id),
        ]);
      });
      const projectRoute = {
        kind: 'project',
        projectId: project.id,
        fileName: null,
      } as const;
      try {
        openWorkspaceTab(projectRoute);
        navigate(projectRoute);
      } catch (err) {
        // The project already exists and the first-message auto-send marker is
        // staged. A browser-local tab/navigation failure must not make Home
        // report that the daemon failed to start the run.
        console.warn('Project created, but failed to open the project route', err);
        try {
          window.location.assign(`/projects/${encodeURIComponent(project.id)}`);
        } catch {
          // Leave the project in the list; a refresh or manual open can recover.
        }
      }
      return true;
    },
    [rememberLocalProject],
  );

  const handleDuplicateProject = useCallback(
    async (sourceProjectId: string, input: { name?: string } = {}) => {
      const result = await duplicateProject(sourceProjectId, input);
      rememberLocalProject(result.project.id);
      setProjects((curr) => [
        result.project,
        ...curr.filter((p) => p.id !== result.project.id),
      ]);
      navigate({
        kind: 'project',
        projectId: result.project.id,
        conversationId: result.conversationId,
        fileName: null,
      });
    },
    [rememberLocalProject],
  );


  const handleImportFolder = useCallback(async (baseDir: string) => {
    const result = await importFolderProject({ baseDir });
    rememberLocalProject(result.project.id);
    setProjects((curr) => [result.project, ...curr.filter((p) => p.id !== result.project.id)]);
    navigate({
      kind: 'project',
      projectId: result.project.id,
      fileName: null,
    });
  }, [rememberLocalProject]);

  // PR #974: on desktop, the host bridge owns the picker and import POST
  // atomically. The renderer never sees the path, token, or daemon DTO;
  // it receives host-owned project identifiers and refreshes project state
  // through the normal daemon API.
  const handleImportFolderResponse = useCallback(async (result: OpenDesignHostProjectImportSuccess) => {
    rememberLocalProject(result.projectId);
    const project = await getProject(result.projectId);
    if (project != null) {
      setProjects((curr) => [project, ...curr.filter((p) => p.id !== project.id)]);
    } else {
      // Daemon hasn't materialized the full record yet (race between the
      // host's import POST and our /api/projects read). Seed a minimal
      // placeholder so the route stays alive and ProjectView mounts; the
      // pending-local id keeps reconcileFetchedProjects from evicting the
      // stub until a project-list snapshot actually includes it, and the
      // next refresh swaps it for the real Project record. Without the
      // stub, a stale `[]` list response would replace `projects` with `[]`
      // and the route-guard effect would bounce the user back to Home.
      const stub: Project = {
        id: result.projectId,
        name: '',
        skillId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setProjects((curr) => [stub, ...curr.filter((p) => p.id !== stub.id)]);
      const request = beginProjectListRequest();
      const list = await listProjects();
      reconcileFetchedProjects(list, request);
    }
    navigate({
      kind: 'project',
      projectId: result.projectId,
      fileName: null,
    });
  }, [beginProjectListRequest, rememberLocalProject, reconcileFetchedProjects]);

  const handleOpenProject = useCallback(async (id: string, fileName?: string): Promise<boolean> => {
    const routeFileName = fileName ?? null;
    if (projectsRef.current.some((project) => project.id === id)) {
      navigate({ kind: 'project', projectId: id, fileName: routeFileName });
      return true;
    }
    try {
      const project = await getProject(id);
      if (project) {
        setProjects((curr) => [project, ...curr.filter((candidate) => candidate.id !== project.id)]);
        navigate({ kind: 'project', projectId: id, fileName: routeFileName });
        return true;
      }
      const request = beginProjectListRequest();
      const list = await listProjects();
      reconcileFetchedProjects(list, request);
      const fetchedProject = locallyDeletedProjectIdsRef.current.has(id)
        ? undefined
        : list.find((candidate) => candidate.id === id);
      if (fetchedProject) {
        navigate({ kind: 'project', projectId: id, fileName: routeFileName });
        return true;
      }
    } catch {
      // Fall through to the same visible missing-project state. The daemon can
      // return 404 or transiently fail while reconciling a deleted backing
      // project; either way the user needs feedback instead of a silent bounce.
    }
    setProjectOpenError(t('project.missing'));
    return false;
  }, [beginProjectListRequest, reconcileFetchedProjects, t]);

  const handleDeleteProject = useCallback(async (id: string) => {
    const ok = await deleteProjectApi(id);
    if (!ok) return false;
    clearLocalProject(id, { deleted: true });
    iframeKeepAlivePool.evictProject(id, { includeActive: true });
    setProjects((curr) => curr.filter((p) => p.id !== id));
    if (route.kind === 'project' && route.projectId === id) {
      navigate({ kind: 'home', view: 'home' });
    }
    return true;
  }, [clearLocalProject, iframeKeepAlivePool, route]);

  const handleRenameProject = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await patchProject(id, { name: trimmed, metadata: { nameSource: 'user' } });
    if (!updated) {
      setProjectOpenError(t('project.renameFailed'));
      return;
    }
    setProjects((curr) => curr.map((p) => p.id === id ? updated : p));
  }, [t]);

  // Return to wherever the user opened this project from (Projects, Tasks, a
  // design system, …) by popping the history stack. Falls back to the Projects
  // list only when there is no in-app history behind us (a deep link / fresh
  // load straight onto the project URL) — see `goBack`.
  const handleBack = useCallback(() => {
    goBack({ kind: 'home', view: 'projects' });
  }, []);

  const handleClearPendingPrompt = useCallback(() => {
    const projectId = route.kind === 'project' ? route.projectId : null;
    if (!projectId) return;
    setProjects((curr) =>
      curr.map((p) =>
        p.id === projectId ? { ...p, pendingPrompt: undefined } : p,
      ),
    );
    void patchProject(projectId, { pendingPrompt: null });
  }, [route]);

  const handleTouchProject = useCallback(() => {
    const projectId = route.kind === 'project' ? route.projectId : null;
    if (!projectId) return;
    const updatedAt = Date.now();
    setProjects((curr) =>
      curr.map((p) => (p.id === projectId ? { ...p, updatedAt } : p)),
    );
    void patchProject(projectId, { updatedAt });
  }, [route]);

  const handleProjectChange = useCallback((updated: Project) => {
    setProjects((curr) => {
      const previous = curr.find((p) => p.id === updated.id);
      if (
        previous
        && (
          previous.skillId !== updated.skillId
          || previous.customInstructions !== updated.customInstructions
        )
      ) {
        iframeKeepAlivePool.evictProject(updated.id, { includeActive: true });
      }
      return curr.map((p) => (p.id === updated.id ? updated : p));
    });
  }, [iframeKeepAlivePool]);

  // ProjectView's prompt-context signature derives from SkillSummary fields,
  // so a body-only registry edit (same name, description, etc.) leaves every
  // signature unchanged and the active preview keeps serving stale prompt
  // context. Settings → Skills calls back through these handlers after every
  // successful mutation; we drop any pool entry whose project depends on the
  // affected id — active or parked — so the next mount
  // recomposes the system prompt with the new body.

  const handleSkillsChanged = useCallback(
    (affectedSkillId?: string) => {
      void fetchSkills().then((list) => setSkills(list));
      void fetchDesignTemplates().then((list) => setDesignTemplates(list));
      iframeKeepAlivePool.evictMatching(
        (entry) => {
          const proj = projectsRef.current.find((p) => p.id === entry.projectId);
          if (!proj) return false;
          if (affectedSkillId) return proj.skillId === affectedSkillId;
          return proj.skillId != null;
        },
        { includeActive: true },
      );
    },
    [iframeKeepAlivePool],
  );

  const loadedActiveProject =
    route.kind === 'project'
      ? (projects.find((p) => p.id === route.projectId) ?? null)
      : null;
  const routeProjectPlaceholder = useMemo<Project | null>(() => {
    if (route.kind !== 'project') return null;
    const now = Date.now();
    return {
      id: route.projectId,
      name: 'Untitled',
      skillId: null,
      createdAt: now,
      updatedAt: now,
    };
  }, [route]);
  const activeProject = loadedActiveProject ?? routeProjectPlaceholder;

  // Deep-linked route to a project we don't have yet (e.g. after a refresh
  // that finishes after the project list comes back). Fetch it in the
  // background so the view can render rather than bouncing to home.
  useEffect(() => {
    if (route.kind !== 'project') return;
    if (loadedActiveProject) return;
    if (!projects.length && !daemonLive) return;
    if (projects.some((p) => p.id === route.projectId)) return;
    let cancelled = false;
    (async () => {
      const project = await getProject(route.projectId).catch(() => null);
      if (cancelled) return;
      if (project) {
        setProjects((curr) => {
          const existingIndex = curr.findIndex((candidate) => candidate.id === project.id);
          if (existingIndex < 0) {
            return [...curr, project];
          }
          return curr.map((candidate) => (candidate.id === project.id ? project : candidate));
        });
        return;
      }
      const request = beginProjectListRequest();
      const list = await listProjects().catch(() => []);
      if (cancelled) return;
      const applied = reconcileFetchedProjects(list, request);
      if (!applied) return;
      const fetchedProject = locallyDeletedProjectIdsRef.current.has(route.projectId)
        ? undefined
        : list.find((p) => p.id === route.projectId);
      const staleRequest = request.mutationVersion < projectListMutationVersionRef.current;
      const knownLocalProject =
        staleRequest && pendingLocalProjectIdsRef.current.has(route.projectId);
      if (!fetchedProject && !knownLocalProject) {
        setProjectOpenError(t('project.missing'));
        navigate({ kind: 'home', view: 'home' }, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, loadedActiveProject, projects, daemonLive, beginProjectListRequest, reconcileFetchedProjects, t]);

  const openSettings = useCallback((
    section: SettingsSection = 'execution',
  ) => {
    if (section === 'mcpClient') {
      setIntegrationInitialTab('mcp');
      navigate({ kind: 'home', view: 'integrations' });
      return;
    }
    setSettingsWelcome(false);
    setSettingsInitialSection(section);
    setSettingsOpen(true);
  }, []);


  const openMcpSettings = useCallback(() => {
    setIntegrationInitialTab('mcp');
    navigate({ kind: 'home', view: 'integrations' });
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    const current = latestPersistedConfigRef.current;
    if (current.onboardingCompleted) return;
    const next: AppConfig = { ...current, onboardingCompleted: true };
    latestPersistedConfigRef.current = next;
    saveConfig(next);
    void syncConfigToDaemon(next);
    setConfig(next);
  }, []);

  // Cmd+, (mac) / Ctrl+, (win/linux) opens Settings. Capture phase so we
  // beat the browser's default Preferences dialog. Platform-gated so
  // meta/ctrl don't conflict across OS.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.shiftKey && !e.altKey && e.key === ',') {
        if (e.isComposing) return;
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [openSettings]);

  // Revalidate templates/design systems only when returning from a standalone
  // surface that could have changed them. The old effect also ran on initial
  // Home mount, duplicating both requests already started by bootstrap.
  const previousRouteKindRef = useRef(route.kind);
  useEffect(() => {
    const previousKind = previousRouteKindRef.current;
    previousRouteKindRef.current = route.kind;
    if (route.kind !== 'home' || previousKind === 'home') return;
    if (appResourceLoadedRef.current.has('templates')) void refreshTemplates();
  }, [route.kind, refreshTemplates]);

  // Existing card grids (DesignsTab, ProjectView), pickers (NewProjectPanel,
  // ChatComposer mention) all look skills up by id without caring whether
  // the id resolves to a functional skill or a design template. Pass them
  // the union so the post-split refactor stays invisible to those callers.
  const allSkillSummaries = useMemo(
    () => [...skills, ...designTemplates],
    [skills, designTemplates],
  );
  const enabledSkills = useMemo(
    () =>
      allSkillSummaries.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [allSkillSummaries, config.disabledSkills],
  );
  // Functional-skills-only enabled subset — what ProjectView's chat
  // composer @-picker should see. Without this, a skill the user has
  // disabled in Settings still appears in an existing project's @-mention
  // popover and can ride along to the daemon via skillIds, breaking the
  // Library toggle for projects opened on the post-split branch.
  const enabledFunctionalSkills = useMemo(
    () =>
      skills.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [skills, config.disabledSkills],
  );
  // Templates-only enabled subset — what the EntryView Templates gallery
  // actually renders. Filtering in App keeps the EntryView prop surface
  // narrow ("here are the templates the user has not disabled").
  const enabledDesignTemplates = useMemo(
    () =>
      designTemplates.filter(
        (s) => !(config.disabledSkills ?? []).includes(s.id),
      ),
    [designTemplates, config.disabledSkills],
  );
  let appMain: ReactNode;
  const pendingFirstRunOnboardingRoute =
    route.kind === 'home' &&
    route.view === 'home' &&
    config.onboardingCompleted !== true &&
    !daemonConfigLoaded;
  if (pendingFirstRunOnboardingRoute) {
    appMain = (
      <div className="entry-shell entry-shell--no-header">
        <CenteredLoader label={t('entry.loadingWorkspace')} />
      </div>
    );
  } else if (activeProject) {
    appMain = (
      <ProjectView
        key={activeProject.id}
        project={activeProject}
        routeFileName={route.kind === 'project' ? route.fileName : null}
        routeConversationId={route.kind === 'project' ? route.conversationId : null}
        config={config}
        agents={agents}
        skills={enabledFunctionalSkills}
        designTemplates={designTemplates}
        daemonLive={daemonLive}
        onAgentChange={handleAgentChange}
        onAgentModelChange={handleAgentModelChange}
        onRefreshAgents={refreshAgents}
        onThemeChange={handleThemeChange}
        onOpenSettings={openSettings}
        onOpenMcpSettings={openMcpSettings}
        onBack={handleBack}
        onClearPendingPrompt={handleClearPendingPrompt}
        onTouchProject={handleTouchProject}
        onProjectChange={handleProjectChange}
        onProjectsRefresh={refreshProjects}
        onDuplicateProject={handleDuplicateProject}
      />
    );
  } else {
    appMain = (
      <EntryView
        skills={enabledSkills}
        designTemplates={enabledDesignTemplates}
        projects={projects}
        templates={templates}
        onDeleteTemplate={handleDeleteTemplate}
        onDeleteProject={handleDeleteProject}
        agents={agents}
        agentsLoading={agentsLoading}
        config={config}
        integrationInitialTab={integrationInitialTab}
        daemonLive={daemonLive}
        onAgentChange={handleAgentChange}
        onAgentModelChange={handleAgentModelChange}
        onConfigPersist={handleConfigPersist}
        onSkillsRefresh={refreshSkills}
        onSkillsChanged={handleSkillsChanged}
        onRefreshAgents={refreshAgents}
        onThemeChange={handleThemeChange}
        skillsLoading={skillsLoading}
        projectsLoading={projectsLoading}
        onCreateProject={handleCreateProject}
        onImportFolder={handleImportFolder}
        onImportFolderResponse={handleImportFolderResponse}
        onOpenProject={handleOpenProject}
        onDuplicateProject={handleDuplicateProject}
        onRenameProject={handleRenameProject}
        onProjectsRefresh={refreshProjectsStrict}
        onOpenSettings={openSettings}
        onCompleteOnboarding={handleCompleteOnboarding}
      />
    );
  }
  return (
    <>
      <div
        className={`workspace-shell workspace-shell--${clientType}`}
        data-client-type={clientType}
      >
        <WorkspaceTabsBar
          route={route}
          projects={projects}
          onboardingCompleted={config.onboardingCompleted === true}
        />
        <div className="workspace-shell__body">
          <Suspense fallback={<CenteredLoader label={t('entry.loadingWorkspace')} />}>
            {appMain}
          </Suspense>
        </div>
      </div>
      <TooltipLayer />
      <AnimatePresence>
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog
            initial={config}
            agents={agents}
            agentsLoading={agentsLoading}
            daemonLive={daemonLive}
            appVersionInfo={appVersionInfo}
            welcome={settingsWelcome}
            initialSection={settingsInitialSection}
                onPersist={handleConfigPersist}
                onClose={() => {
              // Closing the dialog is the canonical "I'm done" gesture
              // now that there is no global Save button. We mark
              // onboardingCompleted on close so the welcome modal stops
              // re-prompting on every refresh, regardless of whether
              // the user changed anything during the session.
              const next = resolveSettingsCloseConfig(config, latestPersistedConfigRef.current);
              if (!next.onboardingCompleted || !config.onboardingCompleted) {
                latestPersistedConfigRef.current = next;
                saveConfig(next);
                void syncConfigToDaemon(next);
                setConfig(next);
              }
              setSettingsOpen(false);
            }}
            onRefreshAgents={refreshAgents}
            daemonMediaProviders={daemonMediaProviders}
            daemonMediaProvidersFetchState={daemonMediaProvidersFetchState}
            mediaProvidersNotice={mediaProvidersNotice}
            onReloadMediaProviders={reloadMediaProvidersFromDaemon}
            onProjectsRefresh={refreshProjects}
            onSkillsChanged={handleSkillsChanged}
          />
        </Suspense>
      ) : null}
      </AnimatePresence>

      {workingDirError ? (
        <Toast
          message={workingDirError}
          role="alert"
          onDismiss={() => setWorkingDirError(null)}
        />
      ) : null}
      {projectOpenError ? (
        <Toast
          message={projectOpenError}
          role="alert"
          tone="error"
          onDismiss={() => setProjectOpenError(null)}
        />
      ) : null}
      {/* MatOS server-side folder picker: imperative host for gateway
          deployments where the native OS dialog cannot exist. */}
      <Suspense fallback={null}>
        <ServerFolderPickerHost />
      </Suspense>
    </>
  );
}

