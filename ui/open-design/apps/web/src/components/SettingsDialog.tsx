import { Button,VisuallyHidden } from '@open-design/components';
import { EvolutionPolicyControl } from './MatOSEvolutionView';
import { RESEARCH_PROVIDERS, type AgentModelOption, type ResearchProvider } from '@open-design/contracts';
import type { Dispatch,SetStateAction } from 'react';
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react';
import type { Locale } from '../i18n';
import { LOCALE_LABEL,LOCALES,useI18n } from '../i18n';
import type { Dict } from '../i18n/types';
import { testAgent } from '../providers/connection-test';
import {
openExternalUrl,
} from '../providers/registry';
import { navigate as navigateRoute } from '../router';
import {
DEFAULT_NOTIFICATIONS,
isStoredMediaProviderEntryEmpty,
isStoredMediaProviderEntryPresent,
mergeDaemonMediaProviders,
saveConfig,
syncConfigToDaemon,
syncMediaProvidersToDaemon,
} from '../state/config';
import type {
AgentInfo,
AppConfig,
AppTheme,
AppVersionInfo,
ConnectionTestResponse,
} from '../types';
import { isVisibleLocalCliAgent } from '../utils/visibleAgents';
import { isVisualStabilityMode } from '../utils/visualStability';
import { AgentDiagnosticRow } from './AgentDiagnosticRow';
import { AgentIcon } from './AgentIcon';
import { orderAgentsWithOpenDesignFirst } from './agentOrdering';
import { ExportDiagnosticsRow } from './ExportDiagnosticsButton';
import { Icon } from './Icon';
import { MatOSByokProviderCard } from './MatOSByokProviderCard';
import { McpClientSection } from './McpClientSection';
import {
CUSTOM_MODEL_SENTINEL,
SearchableModelSelect,
} from './modelOptions';
import { ProjectLocationsSection } from './ProjectLocationsSection';
import { RoutinesSection } from './RoutinesSection';


import { isAutosaveDraftOnlyChange } from '../App';
import {
ACCENT_SWATCHES,
applyAppearanceToDocument,
DEFAULT_ACCENT_COLOR,
normalizeAccentColor,
resolveAccentColor,
} from '../state/appearance';
import {
FAILURE_SOUNDS,
notificationPermission,
playSound,
requestNotificationPermission,
showCompletionNotification,
SUCCESS_SOUNDS,
} from '../utils/notifications';
import {
setEvolutionJuryEnabled,
useEvolutionJuryEnabled,
} from './EvolutionJury';

export type SettingsSection =
  | 'execution'
  | 'instructions'
  | 'media'
  | 'routines'
  | 'mcpClient'
  | 'language'
  | 'appearance'
  | 'evolutionJury'
  | 'notifications'
  | 'projectLocations'
  // 'library' is consumed by the EntryShell library route — App opens it
  // via this same openSettings entry point, so SettingsSection must
  // accept the token even though SettingsDialog itself has no Library
  // section. Reconcile follow-up: route library through a dedicated
  // navigate() call so openSettings only owns dialog-bound sections.
  | 'library'
  | 'about';



interface Props {
  initial: AppConfig;
  agents: AgentInfo[];
  agentsLoading?: boolean;
  daemonLive: boolean;
  appVersionInfo: AppVersionInfo | null;
  welcome?: boolean;
  initialSection?: SettingsSection;
  /**
   * Persist the current draft. Invoked by the dialog's autosave loop on
   * every committed edit. Returns a promise that resolves once both
   * localStorage and the daemon have caught up so the footer status
   * indicator can flip from "Saving…" to "Saved". Should NOT close the
   * dialog and should NOT mutate onboarding state — it represents an
   * incremental save, not a final commit.
   */
  onPersist: (cfg: AppConfig, options?: { forceMediaProviderSync?: boolean }) => Promise<void> | void;
  onClose: () => void;
  onRefreshAgents: (
    options?: AgentRefreshOptions,
  ) => AgentInfo[] | Promise<AgentInfo[] | void> | void;
  daemonMediaProviders?: AppConfig['mediaProviders'] | null;
  daemonMediaProvidersFetchState?: 'idle' | 'ok' | 'error';
  mediaProvidersNotice?: string | null;
  onReloadMediaProviders?: () => Promise<AppConfig['mediaProviders'] | null>;
  onProjectsRefresh?: () => Promise<void> | void;
  /** Same channel for skill registry mutations. */
  onSkillsChanged?: (affectedSkillId?: string) => void;
}

export interface AgentRefreshOptions {
  throwOnError?: boolean;
  agentCliEnv?: AppConfig['agentCliEnv'];
}



function sanitizeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

type RescanNotice =
  | { kind: 'success'; count: number }
  | { kind: 'error' };

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: ConnectionTestResponse };

// Map a test result to the visual severity of its inline status node so
// the same green/red/amber palette as the Rescan status applies.
export function testStatusVariant(
  result: ConnectionTestResponse,
): 'success' | 'error' {
  return result.ok ? 'success' : 'error';
}

export function shouldShowCustomModelInput(
  modelValue: string,
  knownModelIds: readonly string[],
  explicitCustomMode: boolean,
): boolean {
  return (
    explicitCustomMode ||
    !modelValue ||
    !knownModelIds.includes(modelValue)
  );
}

const AGENT_SHORT_DESCRIPTIONS: Record<string, string> = {
  claude: 'Anthropic official CLI',
  codex: 'OpenAI official CLI',
  'cursor-agent': 'Cursor command line',
  opencode: 'Open-source agent CLI',
  qwen: 'Qwen coding CLI',
  copilot: 'GitHub coding CLI',
  devin: 'Cognition terminal CLI',
  kimi: 'Moonshot Kimi CLI',
  qoder: 'Alibaba coding CLI',
  pi: 'Inflection chat CLI',
  kiro: 'Kiro agent CLI',
  kilo: 'Kilo Code CLI',
  vibe: 'Mistral open-source CLI',
  deepseek: 'DeepSeek terminal UI',
  hermes: 'ACP agent CLI',
  'grok-build': 'xAI coding CLI',
  reasonix: 'DeepSeek native coding CLI',
};

function cleanAgentVersionLabel(
  name: string,
  version: string | null | undefined,
): string {
  if (!version) return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return version
    .replace(new RegExp(`\\s*\\(${escapedName}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s+${escapedName}\\s*$`, 'i'), '')
    .trim();
}

function displayAgentName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.name;
}


const AGENT_CLI_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]);
const AGENT_CLI_BASE_URL_ENV_KEYS = new Set(['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']);

export function updateAgentCliEnvValue(
  config: AppConfig,
  agentId: string,
  envKey: string,
  rawValue: string,
): AppConfig {
  const value = rawValue.trim();
  const agentCliEnv = { ...(config.agentCliEnv ?? {}) };
  const agentCliEnvIntent = { ...(config.agentCliEnvIntent ?? {}) };
  const nextAgentEnv = { ...(agentCliEnv[agentId] ?? {}) };
  const nextAgentIntent = { ...(agentCliEnvIntent[agentId] ?? {}) };
  if (value) {
    nextAgentEnv[envKey] = value;
  } else {
    delete nextAgentEnv[envKey];
  }

  const hasAuthKey = Object.keys(nextAgentEnv).some((key) => AGENT_CLI_AUTH_ENV_KEYS.has(key));
  if (
    (AGENT_CLI_AUTH_ENV_KEYS.has(envKey) && value) ||
    (AGENT_CLI_BASE_URL_ENV_KEYS.has(envKey) && hasAuthKey)
  ) {
    nextAgentIntent.apiKeyOverride = true;
  } else if (AGENT_CLI_AUTH_ENV_KEYS.has(envKey) && !hasAuthKey) {
    delete nextAgentIntent.apiKeyOverride;
  }

  if (Object.keys(nextAgentEnv).length > 0) {
    agentCliEnv[agentId] = nextAgentEnv;
  } else {
    delete agentCliEnv[agentId];
  }

  if (Object.keys(nextAgentEnv).length > 0 && Object.keys(nextAgentIntent).length > 0) {
    agentCliEnvIntent[agentId] = nextAgentIntent;
  } else {
    delete agentCliEnvIntent[agentId];
  }

  return {
    ...config,
    agentCliEnv: Object.keys(agentCliEnv).length > 0 ? agentCliEnv : {},
    agentCliEnvIntent: Object.keys(agentCliEnvIntent).length > 0 ? agentCliEnvIntent : {},
  };
}

export function agentRefreshOptionsForConfig(cfg: AppConfig): AgentRefreshOptions {
  return {
    throwOnError: true,
    agentCliEnv: cfg.agentCliEnv ?? {},
  };
}

/**
 * Returns whether the modal's footer Save button should be enabled for the
 * currently active sidebar section.
 *
 * The execution-completeness check (a selected, available agent) only applies
 * to the execution section. Every other section may be saved even while that
 * draft is incomplete.
 */
export function shouldEnableSettingsSave(
  cfg: AppConfig,
  activeSection: SettingsSection,
  agents: ReadonlyArray<{ id: string; available: boolean }>,
): boolean {
  if (activeSection !== 'execution') return true;
  return Boolean(
    cfg.agentId && agents.find((a) => a.id === cfg.agentId)?.available,
  );
}

/**
 * Returns the config that should actually be persisted by `onSave`.
 *
 * When Save is enabled on a non-execution sidebar section but the draft
 * execution selection is incomplete, the raw `cfg` still carries that draft.
 * Persisting it would leave the app in an unusable execution state after the
 * modal closes, so this helper reverts the execution fields to their
 * `initial` values in that case.
 */
export function sanitizeSettingsSavePayload(
  cfg: AppConfig,
  initial: AppConfig,
  activeSection: SettingsSection,
  agents: ReadonlyArray<{ id: string; available: boolean }>,
): AppConfig {
  if (activeSection === 'execution') return cfg;
  const executionValid = shouldEnableSettingsSave(cfg, 'execution', agents);
  if (executionValid) return cfg;
  return {
    ...cfg,
    agentId: initial.agentId,
    agentCliEnv: initial.agentCliEnv,
  };
}

export function SettingsDialog({
  initial,
  agents,
  agentsLoading = false,
  daemonLive,
  appVersionInfo,
  welcome,
  initialSection = 'execution',
  onPersist,
  onClose,
  onRefreshAgents,
  daemonMediaProviders,
  daemonMediaProvidersFetchState = 'idle',
  mediaProvidersNotice,
  onReloadMediaProviders,
  onProjectsRefresh,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const [cfg, setCfg] = useState<AppConfig>(initial);
  const [pendingMediaProviderEditIds, setPendingMediaProviderEditIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const lastSavedAppearanceRef = useRef({
    theme: initial.theme ?? 'system',
    accentColor: resolveAccentColor(initial.accentColor),
  });

  // settings_view — fire on dialog open and on every section switch so the
  // configuration funnel can see which section the user spent time in.
  // The fire is keyed on section so a section bounce (open → switch →
  // close) emits one event per surface.

  useEffect(() => {
    lastSavedAppearanceRef.current = {
      theme: initial.theme ?? 'system',
      accentColor: resolveAccentColor(initial.accentColor),
    };
  }, [initial.theme, initial.accentColor]);


  // Revert the live theme preview to the most recently persisted appearance.
  // That is the initial appearance until autosave succeeds; after autosave,
  // closing Settings must not roll the document back to stale colors.
  useLayoutEffect(() => {
    return () => {
      applyAppearanceToDocument(lastSavedAppearanceRef.current);
    };
  }, []);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [settingsSidebarCollapsed, setSettingsSidebarCollapsed] = useState(false);
  const [settingsFullscreen, setSettingsFullscreen] = useState(false);
  // Scroll the right-hand content pane back to the top whenever the user
  // picks a different settings section. Without this, switching from a
  // long section the user had scrolled (e.g. Library) into a short one
  // (About) keeps the previous scrollTop, so the new section's header
  // can land out of view and the panel reads as half-loaded. Issue #634.
  const settingsContentRef = useRef<HTMLDivElement | null>(null);
  const [agentRescanRunning, setAgentRescanRunning] = useState(false);
  const [agentRescanNotice, setAgentRescanNotice] =
    useState<RescanNotice | null>(null);
  const [agentTestState, setAgentTestState] = useState<TestState>({
    status: 'idle',
  });
  const [hoveredAgentCardId, setHoveredAgentCardId] = useState<string | null>(null);
  const agentTestAbortRef = useRef<AbortController | null>(null);
  const pendingAgentInstallRescanRef = useRef(false);
  const agentTestRevisionRef = useRef(0);
  const visualStabilityMode = isVisualStabilityMode();
  const [agentCustomModelIds, setAgentCustomModelIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // Precise inverse of App.handleCompleteOnboarding: flip
  // onboardingCompleted back to false, mirror it to localStorage and the
  // daemon through the same config-persist path, then route the user into
  // the first-run flow so they can replay setup (including brand extraction).
  const handleResetOnboarding = useCallback(() => {
    const next: AppConfig = { ...cfg, onboardingCompleted: false };
    setCfg(next);
    saveConfig(next);
    void syncConfigToDaemon(next);
    onClose();
    navigateRoute({ kind: 'home', view: 'onboarding' });
  }, [cfg, onClose]);

  // Imperative handle for the External MCP section. The dialog footer Save
  // routes through this when the MCP tab is active so the user can press the
  // single Save button at the bottom instead of hunting for the inner one.
  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    const el = settingsContentRef.current;
    if (el) el.scrollTop = 0;
  }, [activeSection]);
  // Phone layout turns the sidebar into a horizontal tab strip
  // (styles/mobile2/settings.css). Keep the active tab visible when the
  // section changes — e.g. opening the dialog directly on a late section
  // like "About" would otherwise land on a strip scrolled to the start.
  // No-ops on desktop where the sidebar has no horizontal overflow.
  const settingsSidebarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const sidebar = settingsSidebarRef.current;
    if (!sidebar || sidebar.scrollWidth <= sidebar.clientWidth) return;
    const active = sidebar.querySelector<HTMLElement>('.settings-nav-item.active');
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeSection]);


  const agentChoiceForTest = cfg.agentId
    ? cfg.agentModels?.[cfg.agentId]
    : null;
  useEffect(() => {
    agentTestRevisionRef.current += 1;
    setAgentTestState((state) =>
      state.status === 'running' ? state : { status: 'idle' },
    );
  }, [
    cfg.agentId,
    agentChoiceForTest?.model,
    agentChoiceForTest?.reasoning,
    cfg.agentCliEnv,
  ]);
  // Rescan notices are list-level feedback for a one-shot action and
  // shouldn't linger in the content stream. After 6s, fade them out so
  // repeated Rescan clicks don't pile up; the next click resets the
  // notice immediately, so this only affects "user moved on" cases.
  useEffect(() => {
    if (!agentRescanNotice) return;
    const id = window.setTimeout(() => setAgentRescanNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [agentRescanNotice]);
  const markAgentInstallIntent = () => {
    pendingAgentInstallRescanRef.current = true;
  };
  const handleRefreshAgents = async () => {
    if (agentRescanRunning) return;
    setAgentRescanRunning(true);
    setAgentRescanNotice(null);
    try {
      const refreshed = await onRefreshAgents(agentRefreshOptionsForConfig(cfg));
      const nextAgents = Array.isArray(refreshed) ? refreshed : agents;
      setAgentRescanNotice({
        kind: 'success',
        count: nextAgents.filter((a) => a.available).length,
      });
    } catch {
      setAgentRescanNotice({ kind: 'error' });
    } finally {
      setAgentRescanRunning(false);
    }
  };
  const openAgentFixUrl = (url: string | undefined) => {
    const href = sanitizeHttpsUrl(url);
    if (!href) return;
    markAgentInstallIntent();
    void openExternalUrl(href);
  };
  const diagnosticHandlersForAgent = (agent: AgentInfo) => {
    const docsUrl = sanitizeHttpsUrl(agent.docsUrl);
    const installUrl = sanitizeHttpsUrl(agent.installUrl);
    return {
      onRescan: () => void handleRefreshAgents(),
      ...(docsUrl ? { onOpenDocs: () => openAgentFixUrl(docsUrl) } : {}),
      ...(installUrl
        ? {
            onOpenInstall: () =>
              openAgentFixUrl(installUrl),
          }
        : {}),
    };
  };
  useEffect(() => {
    const handleReturnToSettings = () => {
      if (
        !pendingAgentInstallRescanRef.current ||
        agentRescanRunning ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      pendingAgentInstallRescanRef.current = false;
      void handleRefreshAgents();
    };
    document.addEventListener('visibilitychange', handleReturnToSettings);
    window.addEventListener('focus', handleReturnToSettings);
    return () => {
      document.removeEventListener('visibilitychange', handleReturnToSettings);
      window.removeEventListener('focus', handleReturnToSettings);
    };
  }, [agentRescanRunning, handleRefreshAgents]);


  const handleTestAgent = async () => {
    if (agentTestState.status === 'running') {
      return;
    }
    const selected = agents.find((a) => a.id === cfg.agentId && a.available);
    if (!selected) return;
    const choice = cfg.agentModels?.[selected.id] ?? {};
    const controller = new AbortController();
    const revision = agentTestRevisionRef.current;
    agentTestAbortRef.current = controller;
    setAgentTestState({ status: 'running' });
    const startedAt = performance.now();
    const clearIfStale = () => {
      if (agentTestAbortRef.current === controller) {
        setAgentTestState({ status: 'idle' });
      }
    };
    try {
      const result = await testAgent(
        {
          agentId: selected.id,
          model: choice.model || undefined,
          reasoning: choice.reasoning || undefined,
          agentCliEnv: cfg.agentCliEnv ?? {},
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (agentTestRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setAgentTestState({ status: 'done', result });
          } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (agentTestRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setAgentTestState({
        status: 'done',
        result: {
          ok: false,
          kind: 'unknown',
          latencyMs: 0,
          model: choice.model || 'default',
          detail: err instanceof Error ? err.message : 'Test request failed',
        },
      });
          } finally {
      if (agentTestAbortRef.current === controller) {
        agentTestAbortRef.current = null;
      }
    }
  };

  const renderTestMessage = (
    result: ConnectionTestResponse,
  ): string => {
    const ms = Math.max(0, Math.round(result.latencyMs));
    const sample = result.sample ?? '';
    const agentName = result.agentName ?? '';
    const testedModel = result.model ?? '';
    if (result.ok) {
      const baseMessage = t('settings.testSuccessCli', { agentName, ms, sample });
      return result.detail ? `${baseMessage} ${result.detail}` : baseMessage;
    }
    switch (result.kind) {
      case 'not_found_model':
        return t('settings.testNotFoundModel', { model: testedModel });
      case 'invalid_model_id':
        return t('settings.testInvalidModelId', { model: testedModel });
      case 'timeout':
        return t('settings.testTimeout', { ms });
      case 'agent_not_installed':
        return t('settings.testAgentMissing', { agentName });
      case 'agent_auth_required':
        return result.detail || 'Agent authentication is required.';
      case 'agent_spawn_failed':
        return t('settings.testAgentSpawn', {
          agentName,
          detail: result.detail ?? '',
        });
      default:
        return t('settings.testUnknown', { detail: result.detail ?? '' });
    }
  };



  // Autosave loop. Every committed edit to `cfg` schedules a debounced
  // sync to localStorage + the daemon. We keep a 400ms debounce so rapid
  // typing in text fields doesn't flood the daemon with PUTs while still
  // feeling near-instant for toggles/selects (which fire once and settle).
  // The status here drives the footer indicator: 'idle' = no draft to
  // flush, 'pending' = scheduled, 'saving' = request in flight, 'saved'
  // = recent successful sync, 'error' = recent failure.
  const [autosaveStatus, setAutosaveStatus] =
    useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  // Skip the very first effect tick so just opening the dialog doesn't
  // appear to "save" anything before the user has touched a field.
  const autosaveSkipFirstRef = useRef(true);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveSavedTimerRef = useRef<number | null>(null);
  const autosaveRetryTimerRef = useRef<number | null>(null);
  const autosavePendingFlushRef = useRef(false);
  const autosaveLatestRef = useRef<AppConfig>(cfg);
  // Baseline used by the draft-only detector: the snapshot at the most
  // recent successful autosave (or the initial cfg on mount). Compared
  // against the current snapshot to decide whether the persisted shape
  // is already on disk — in which case we must NOT flash "All changes
  // saved".
  const autosaveLastSavedRef = useRef<AppConfig>(cfg);
  const mediaProvidersChangeVersionRef = useRef(0);
  const lastSyncedMediaProvidersVersionRef = useRef(0);
  const [autosaveRetryTick, setAutosaveRetryTick] = useState(0);
  autosaveLatestRef.current = cfg;
  useEffect(() => {
    if (autosaveSkipFirstRef.current) {
      autosaveSkipFirstRef.current = false;
      autosaveLastSavedRef.current = cfg;
      return;
    }
    setAutosaveStatus('pending');
    if (autosaveSavedTimerRef.current != null) {
      window.clearTimeout(autosaveSavedTimerRef.current);
      autosaveSavedTimerRef.current = null;
    }
    if (autosaveRetryTimerRef.current != null) {
      window.clearTimeout(autosaveRetryTimerRef.current);
      autosaveRetryTimerRef.current = null;
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosavePendingFlushRef.current = true;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosavePendingFlushRef.current = false;
      autosaveTimerRef.current = null;
      const snapshot = autosaveLatestRef.current;
      const mediaProvidersVersion = mediaProvidersChangeVersionRef.current;
      const persistOptions = {
        forceMediaProviderSync: mediaProvidersVersion > lastSyncedMediaProvidersVersionRef.current,
      };
      // Draft-only edit: the persisted shape would be identical to what
      // is already on disk, so a save would be a no-op that mis-reports
      // "Saved". Skip the persist and settle the indicator to idle.
      // The forced media-provider sync path still runs because that
      // is a real outbound effect even when the persisted shape
      // hasn't changed.
      if (
        !persistOptions.forceMediaProviderSync
        && isAutosaveDraftOnlyChange(snapshot, autosaveLastSavedRef.current)
      ) {
        setAutosaveStatus('idle');
        return;
      }
      setAutosaveStatus('saving');
      void (async () => {
        try {
          await onPersist(snapshot, persistOptions);
          autosaveLastSavedRef.current = snapshot;
          lastSavedAppearanceRef.current = {
            theme: snapshot.theme ?? 'system',
            accentColor: resolveAccentColor(snapshot.accentColor),
          };
          // If a newer edit landed while the request was in flight,
          // leave the status as 'pending' so the next debounce tick
          // owns the indicator instead of flashing "Saved".
          if (autosaveLatestRef.current !== snapshot) {
            setAutosaveStatus('pending');
            return;
          }
          if (persistOptions.forceMediaProviderSync) {
            lastSyncedMediaProvidersVersionRef.current = mediaProvidersVersion;
            setPendingMediaProviderEditIds(new Set());
          }
          setAutosaveStatus('saved');
          autosaveSavedTimerRef.current = window.setTimeout(() => {
            autosaveSavedTimerRef.current = null;
            // Settle to idle after a moment so the indicator doesn't
            // stay on "Saved" forever and become noise.
            setAutosaveStatus((curr) => (curr === 'saved' ? 'idle' : curr));
          }, 1800);
        } catch {
          if (
            persistOptions.forceMediaProviderSync
            && autosaveLatestRef.current === snapshot
            && mediaProvidersChangeVersionRef.current === mediaProvidersVersion
            && lastSyncedMediaProvidersVersionRef.current < mediaProvidersVersion
          ) {
            setAutosaveStatus('pending');
            autosaveRetryTimerRef.current = window.setTimeout(() => {
              autosaveRetryTimerRef.current = null;
              if (
                autosaveLatestRef.current !== snapshot
                || mediaProvidersChangeVersionRef.current !== mediaProvidersVersion
                || lastSyncedMediaProvidersVersionRef.current >= mediaProvidersVersion
              ) {
                return;
              }
              setAutosaveRetryTick((tick) => tick + 1);
            }, 1500);
            return;
          }
          setAutosaveStatus('error');
        }
      })();
    }, 400);
    return () => {
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [cfg, onPersist, autosaveRetryTick]);
  // Flush any pending autosave on unmount so a fast-closing dialog
  // never strands an in-flight edit. We also clear the "Saved" toast
  // timer to avoid setState after unmount.
  useEffect(() => {
    return () => {
      if (autosavePendingFlushRef.current) {
        const mediaProvidersVersion = mediaProvidersChangeVersionRef.current;
        // Best-effort flush; if it rejects, localStorage already has
        // the latest copy from the synchronous saveConfig call inside
        // onPersist.
        autosavePendingFlushRef.current = false;
        void Promise.resolve(onPersist(autosaveLatestRef.current, {
          forceMediaProviderSync: mediaProvidersVersion > lastSyncedMediaProvidersVersionRef.current,
        })).catch(() => undefined);
      }
      if (autosaveSavedTimerRef.current != null) {
        window.clearTimeout(autosaveSavedTimerRef.current);
        autosaveSavedTimerRef.current = null;
      }
      if (autosaveRetryTimerRef.current != null) {
        window.clearTimeout(autosaveRetryTimerRef.current);
        autosaveRetryTimerRef.current = null;
      }
    };
  }, [onPersist]);

  // Global Escape closes the dialog. With no footer button anymore the
  // close affordances are: top-right X · backdrop click · Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Header title/subtitle follow the active sidebar section so the dialog
  // header always reflects what the user is looking at, instead of being
  // pinned to one section's copy.
  const sectionHeader: Record<SettingsSection, { title: string; subtitle: string }> = {
    execution: { title: t('settings.title'), subtitle: t('settings.subtitle') },
    instructions: {
      title: t('settings.instructionsTitle'),
      subtitle: t('settings.instructionsSubtitle'),
    },
    media: { title: t('settings.mediaProviders'), subtitle: t('settings.mediaProvidersHint') },
    routines: {
      title: t('routines.title'),
      subtitle: t('routines.subtitle'),
    },
    mcpClient: { title: t('settings.externalMcpTitle'), subtitle: t('settings.externalMcpHint') },
    language: { title: t('settings.language'), subtitle: t('settings.languageHint') },
    appearance: { title: t('settings.appearance'), subtitle: t('settings.appearanceHint') },
    evolutionJury: {
      title: t('evolutionJury.settingsNav'),
      subtitle: t('evolutionJury.settingsNavHint'),
    },
    notifications: { title: t('settings.notifications'), subtitle: t('settings.notificationsHint') },
    projectLocations: {
      title: t('settings.projectLocations'),
      subtitle: t('settings.projectLocationsHint'),
    },
    // 'library' is opened via EntryShell route — SettingsDialog doesn't
    // render it but SettingsSection must accept the token (see type def).
    library: { title: '', subtitle: '' },
    about: { title: t('settings.about'), subtitle: t('settings.aboutHint') },
  };
  const activeHeader = sectionHeader[activeSection];
  const visibleAgents = agents.filter((a) => isVisibleLocalCliAgent(a, {}));
  const installedAgents = orderAgentsWithOpenDesignFirst(
    visibleAgents.filter((a) => a.available || false),
  );
  const unavailableAgents = visibleAgents.filter((a) => !a.available && true);
  const initialAgentScanRunning = agentsLoading && agents.length === 0;
  const agentModelOptionLabel = (
    model: AgentModelOption | undefined,
    fallback: string,
  ) => {
    if (!model) return fallback;
    const label = model.label?.trim();
    const id = model.id.trim();
    if (label && label !== id) {
      return label.toLowerCase().includes(id.toLowerCase())
        ? label
        : `${label} (${id})`;
    }
    return label || id;
  };
  const agentModelSummary = (agent: AgentInfo) => {
    if (!Array.isArray(agent.models) || agent.models.length === 0) return null;
    const choice = cfg.agentModels?.[agent.id] ?? {};
    const modelValue = choice.model ?? agent.models[0]?.id ?? '';
    if (!modelValue) return t('settings.modelCustom');
    return agentModelOptionLabel(
      agent.models.find((m) => m.id === modelValue),
      modelValue,
    );
  };
  const renderAgentModelConfig = (selected: AgentInfo) => {
    const hasModels =
      Array.isArray(selected.models) && selected.models.length > 0;
    const selectedModel = selected.models?.find((model) =>
      model.id === (cfg.agentModels?.[selected.id]?.model ?? selected.models?.[0]?.id));
    const reasoningOptions = selected.reasoningOptions;
    const hasReasoning = Array.isArray(reasoningOptions) && reasoningOptions.length > 0;
    if (!hasModels && !hasReasoning) return null;
    const choice = cfg.agentModels?.[selected.id] ?? {};
    const knownModelIds = selected.models?.map((m) => m.id) ?? [];
    // Adapters opt out via `supportsCustomModel: false` on their
    // RuntimeAgentDef when free-text ids would fail at spawn. Undefined ===
    // allow.
    const allowCustomModel = selected.supportsCustomModel !== false;
    const configuredModel =
      typeof choice.model === 'string' && choice.model
        ? choice.model
        : null;
    const setChoice = (
      next: { model?: string; reasoning?: string },
    ) => {
      setCfg((c) => {
        const prev = c.agentModels?.[selected.id] ?? {};
        return {
          ...c,
          agentModels: {
            ...(c.agentModels ?? {}),
            [selected.id]: { ...prev, ...next },
          },
        };
      });
    };
    const modelValue =
      (configuredModel ?? selected.models?.[0]?.id ?? '');
    const reasoningValue =
      choice.reasoning ??
      reasoningOptions?.find((option) => option.default)?.id ?? reasoningOptions?.[0]?.id ?? '';
    const customActive =
      allowCustomModel &&
      hasModels &&
      shouldShowCustomModelInput(
        modelValue,
        knownModelIds,
        agentCustomModelIds.has(selected.id),
      );
    const selectValue = customActive
      ? CUSTOM_MODEL_SENTINEL
      : modelValue;
    const modelSource = selected.modelsSource ?? 'fallback';
    const modelSourceLabel =
      modelSource === 'live'
        ? t('settings.modelSourceLive')
        : t('settings.modelSourceFallback');
    const modelSourceHint =
      modelSource === 'live'
        ? selected.supportsCustomModel === false
          ? t('settings.modelPickerLiveCatalogOnlyHint')
          : t('settings.modelPickerLiveHint')
        : t('settings.modelPickerFallbackHint');
    return (
      <div className="agent-card-config">
        {hasModels ? (
          <>
            <label className="field">
              <span className="field-label">
                {t('settings.modelPicker')}
                <span
                  className={`agent-model-source-badge ${modelSource}`}
                  aria-hidden="true"
                >
                  {modelSourceLabel}
                </span>
              </span>
              <div className="agent-model-select-wrap">
                <SearchableModelSelect
                  className="inline-switcher__select settings-model-select"
                  value={selectValue}
                  aria-label={t('settings.modelPicker')}
                  searchPlaceholder={t('designs.searchPlaceholder')}
                  searchInputTestId={`settings-agent-model-search-${selected.id}`}
                  popoverTestId={`settings-agent-model-popover-${selected.id}`}
                  minSearchableOptions={5}
                  popoverMinWidth={340}
                  models={selected.models!}
                  onChange={(nextValue) => {
                    if (nextValue === CUSTOM_MODEL_SENTINEL) {
                      setAgentCustomModelIds((prev) => {
                        const next = new Set(prev);
                        next.add(selected.id);
                        return next;
                      });
                      setChoice({ model: '' });
                    } else {
                      setAgentCustomModelIds((prev) => {
                        if (!prev.has(selected.id)) return prev;
                        const next = new Set(prev);
                        next.delete(selected.id);
                        return next;
                      });
                      setChoice({ model: nextValue });
                    }
                  }}
                  additionalOptions={
                    allowCustomModel
                      ? [
                          {
                            value: CUSTOM_MODEL_SENTINEL,
                            label: t('settings.modelCustom'),
                          },
                        ]
                      : undefined
                  }
                />
              </div>
            </label>
            <p className="hint agent-model-row-hint">
              {modelSourceHint}
            </p>
          </>
        ) : null}
        {customActive ? (
          <label className="field">
            <span className="field-label">
              {t('settings.modelCustomLabel')}
            </span>
            <input
              type="text"
              value={modelValue}
              placeholder={t('settings.modelCustomPlaceholder')}
              onChange={(e) =>
                setChoice({ model: e.target.value.trim() })
              }
            />
          </label>
        ) : null}
        {hasReasoning ? (
          <label className="field">
            <span className="field-label">
              {t('settings.reasoningPicker')}
            </span>
            <div className="agent-model-select-wrap">
              <select
                value={reasoningValue}
                onChange={(e) =>
                  setChoice({ reasoning: e.target.value })
                }
              >
                {reasoningOptions!.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <Icon
                name="chevron-down"
                size={12}
                className="agent-model-select-chevron"
              />
            </div>
          </label>
        ) : null}
      </div>
    );
  };

  const settingsSidebarToggleLabel = settingsSidebarCollapsed
    ? 'Expand settings sidebar'
    : 'Collapse settings sidebar';
  const settingsFullscreenLabel = settingsFullscreen
    ? t('common.exitFullscreen')
    : t('common.fullscreen');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={
          'modal modal-settings' +
          (settingsSidebarCollapsed ? ' settings-sidebar-collapsed' : '') +
          (settingsFullscreen ? ' settings-fullscreen' : '')
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top-right chrome strip — anchored to the modal corner so the
            autosave indicator and the close button float above the
            sidebar/content rhythm without competing with the title.
            We use `position: absolute` instead of putting these inside
            `.modal-head` so the welcome variant's tall hero (kicker /
            title / subtitle) keeps its centred reading
            measure, and the close button always lands at the same
            optical location regardless of how much copy the header
            renders. */}
        <div className="settings-chrome" aria-hidden={false}>
          {/* Autosave status pill. Only renders something while a save
              is in flight or has just completed — idle = invisible so
              first-open feels calm. The chrome strip itself stays
              mounted so the close button never shifts when the pill
              appears, and the pill is announced via aria-live for
              assistive tech. */}
          <div
            className={`settings-autosave is-${autosaveStatus}`}
            role="status"
            aria-live="polite"
          >
            {autosaveStatus === 'saving' || autosaveStatus === 'pending' ? (
              <>
                <Icon name="spinner" size={12} className="icon-spin" />
                <span>{t('settings.autosaveSaving')}</span>
              </>
            ) : autosaveStatus === 'saved' ? (
              <>
                <Icon name="check" size={12} />
                <span>{t('settings.autosaveSaved')}</span>
              </>
            ) : autosaveStatus === 'error' ? (
              <>
                <Icon name="close" size={12} />
                <span>{t('settings.autosaveError')}</span>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="settings-chrome-btn settings-fullscreen-toggle"
            onClick={() => setSettingsFullscreen((current) => !current)}
            aria-label={settingsFullscreenLabel}
            aria-pressed={settingsFullscreen}
            title={settingsFullscreenLabel}
          >
            <Icon
              name={settingsFullscreen ? 'minimize' : 'maximize'}
              size={15}
              strokeWidth={2}
            />
          </button>
          <button
            type="button"
            className="settings-chrome-btn settings-close"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <Icon name="close" size={16} strokeWidth={2} />
          </button>
        </div>
        <header className="modal-head" id="settings-dialog-title">
          {welcome ? (
            <>
              <span className="kicker">{t('settings.welcomeKicker')}</span>
              <h2>{t('settings.welcomeTitle')}</h2>
              <p className="subtitle">{t('settings.welcomeSubtitle')}</p>
            </>
          ) : (
            <>
              <span className="kicker">{t('settings.kicker')}</span>
              <div className="modal-head-line">
                <h2>{activeHeader.title}</h2>
                <p className="subtitle">{activeHeader.subtitle}</p>
              </div>
            </>
          )}
        </header>

        <div className="modal-body">
          <button
            type="button"
            className="settings-sidebar-toggle"
            onClick={() => setSettingsSidebarCollapsed((current) => !current)}
            aria-label={settingsSidebarToggleLabel}
            aria-pressed={settingsSidebarCollapsed}
            aria-controls="settings-sidebar"
            title={settingsSidebarToggleLabel}
          >
            <Icon
              name={settingsSidebarCollapsed ? 'chevron-right' : 'chevron-left'}
              size={15}
              strokeWidth={2}
            />
          </button>
          <aside
            id="settings-sidebar"
            className="settings-sidebar"
            aria-label="Settings sections"
            aria-hidden={settingsSidebarCollapsed ? true : undefined}
            ref={settingsSidebarRef}
          >
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'execution' ? ' active' : ''}`}
              onClick={() => setActiveSection('execution')}
            >
              <Icon name="sliders" size={18} />
              <span>
                <strong>{t('settings.envConfigure')}</strong>
                <small>{t('settings.localCli')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'instructions' ? ' active' : ''}`}
              onClick={() => setActiveSection('instructions')}
            >
              <Icon name="edit" size={18} />
              <span>
                <strong>{t('settings.instructionsTitle')}</strong>
                <small>{t('settings.instructionsNavSub')}</small>
              </span>
            </button>

            <button
              type="button"
              className={`settings-nav-item${activeSection === 'media' ? ' active' : ''}`}
              onClick={() => setActiveSection('media')}
            >
              <Icon name="database" size={18} />
              <span>
                <strong>{t('settings.mediaProviders')}</strong>
                <small>{t('settings.mediaProvidersNavSub')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'mcpClient' ? ' active' : ''}`}
              onClick={() => setActiveSection('mcpClient')}
            >
              <Icon name="sparkles" size={18} />
              <span>
                <strong>{t('settings.externalMcpTitle')}</strong>
                <small>{t('settings.externalMcpHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'language' ? ' active' : ''}`}
              onClick={() => setActiveSection('language')}
            >
              <Icon name="languages" size={18} />
              <span>
                <strong>{t('settings.language')}</strong>
                <small>{t('settings.languageHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'appearance' ? ' active' : ''}`}
              onClick={() => setActiveSection('appearance')}
            >
              <Icon name="sun-moon" size={18} />
              <span>
                <strong>{t('settings.appearance')}</strong>
                <small>{t('settings.appearanceHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'evolutionJury' ? ' active' : ''}`}
              onClick={() => setActiveSection('evolutionJury')}
            >
              <Icon name="sparkles" size={18} />
              <span>
                <strong>{t('evolutionJury.settingsNav')}</strong>
                <small>{t('evolutionJury.settingsNavHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'notifications' ? ' active' : ''}`}
              onClick={() => setActiveSection('notifications')}
            >
              <Icon name="bell" size={18} />
              <span>
                <strong>{t('settings.notifications')}</strong>
                <small>{t('settings.notificationsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'projectLocations' ? ' active' : ''}`}
              onClick={() => setActiveSection('projectLocations')}
            >
              <Icon name="folder" size={18} />
              <span>
                <strong>{t('settings.projectLocations')}</strong>
                <small>{t('settings.projectLocationsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'about' ? ' active' : ''}`}
              onClick={() => setActiveSection('about')}
            >
              <Icon name="settings" size={18} />
              <span>
                <strong>{t('settings.about')}</strong>
                <small>{t('settings.aboutHint')}</small>
              </span>
            </button>
          </aside>
          <div className="settings-content" ref={settingsContentRef}>
          {activeSection === 'execution' ? (
            <>
          {(
            <section className="settings-section">
              <div className="section-head">
                <div>
                  <p className="hint">{t('settings.codeAgentHint')}</p>
                </div>
              </div>
              {initialAgentScanRunning ? (
                <div className="agent-scan-card" role="status" aria-live="polite">
                  <div className="agent-scan-card__stage">
                    <span className="agent-scan-card__ring" aria-hidden />
                    <strong>{t('settings.rescanRunning')}</strong>
                    <span>{t('settings.codeAgentHint')}</span>
                    <div className="agent-scan-card__progress" aria-hidden>
                      <span />
                    </div>
                  </div>
                  <div className="agent-scan-card__rows" aria-hidden>
                    <span><i /><b /><em /></span>
                    <span><i /><b /><em /></span>
                    <span><i /><b /><em /></span>
                  </div>
                </div>
              ) : agents.length === 0 ? (
                <div className="empty-card">
                  {t('settings.noAgentsDetected')}
                </div>
              ) : (
                <>
                  <div className="agent-group">
                    <div className="agent-group-head">
                      <h4>
                        {t('settings.agentInstalledGroup', {
                          count: installedAgents.length,
                        })}
                      </h4>
                      <div className="agent-group-head-actions">
                        {agentRescanNotice ? (
                          <span
                            className={
                              'settings-rescan-status settings-rescan-status-inline ' +
                              agentRescanNotice.kind
                            }
                            role={
                              agentRescanNotice.kind === 'error'
                                ? 'alert'
                                : 'status'
                            }
                          >
                            {agentRescanNotice.kind === 'success'
                              ? t('settings.rescanSuccess', {
                                  count: agentRescanNotice.count,
                                })
                              : t('settings.rescanFailed')}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={
                            'ghost icon-btn settings-rescan-btn agent-group-rescan-btn' +
                            (agentRescanRunning ? ' loading' : '')
                          }
                          onClick={() => void handleRefreshAgents()}
                          disabled={agentRescanRunning}
                          title={t('settings.rescanTitle')}
                        >
                          {agentRescanRunning ? (
                            <>
                              <Icon
                                name="spinner"
                                size={13}
                                className="icon-spin"
                              />
                              <span>{t('settings.rescanRunning')}</span>
                            </>
                          ) : (
                            t('settings.rescan')
                          )}
                        </button>
                      </div>
                    </div>
                    {installedAgents.length > 0 ? (
                      <div className="agent-grid agent-grid-installed">
                        {installedAgents.map((a) => {
                          const active = cfg.agentId === a.id;
                          const running =
                            active && agentTestState.status === 'running';
                          const description = AGENT_SHORT_DESCRIPTIONS[a.id];
                          const agentName = displayAgentName(a);
                          const diagnosticHandlers = diagnosticHandlersForAgent(a);
                          const modelSummary = agentModelSummary(a);
                          const versionLabel =
                            cleanAgentVersionLabel(a.name, a.version);
                          const metaLabel =
                            a.authStatus === 'missing'
                              ? t('settings.agentAuthRequired')
                              : a.authStatus === 'unknown'
                                ? t('settings.agentAuthUnknown')
                                : versionLabel
                                  ? versionLabel
                                  : t('common.installed');
                          const metaTitle =
                            a.authStatus === 'missing' ||
                            a.authStatus === 'unknown'
                              ? (a.authMessage ?? a.path ?? '')
                              : (a.path ?? '');
                          const cardEl = (
                            <div
                              key={a.id}
                              data-testid={`settings-agent-card-${a.id}`}
                              className={
                                'agent-card agent-card-installed' +
                                (active ? ' active' : '') +
                                ''
                              }
                              onMouseEnter={() => {
                                return;
                              }}
                              onMouseLeave={() => {
                                if (hoveredAgentCardId !== a.id) return;
                                setHoveredAgentCardId(null);
                              }}
                            >
                              <div className="agent-card-main">
                                <button
                                  type="button"
                                  className="agent-card-select"
                                  data-testid={`settings-agent-select-${a.id}`}
                                  onClick={() => {
                                                                        setCfg((c) => ({ ...c, agentId: a.id }));
                                  }}
                                  aria-pressed={active}
                                  >
                                    <AgentIcon id={a.id} size={32} />
                                    <div className="agent-card-body">
                                      <div
                                        className={
                                          'agent-card-name' +
                                          ''
                                        }
                                      >
                                        <span className="agent-card-title">
                                          {agentName}
                                        </span>
                                        {(description ? (
                                          <>
                                            <span
                                              className="agent-card-name-divider"
                                              aria-hidden="true"
                                            >
                                              ·
                                            </span>
                                            <span className="agent-card-tagline">
                                              {description}
                                            </span>
                                          </>
                                        ) : null)}
                                      </div>
                                      {(metaLabel ? (
                                        <div className="agent-card-meta">
                                          <span title={metaTitle}>
                                            {metaLabel}
                                          </span>
                                        </div>
                                      ) : null)}
                                      {!active && modelSummary ? (
                                        <div className="agent-card-model-summary">
                                          <span>{t('settings.modelPicker')}</span>
                                          <strong>{modelSummary}</strong>
                                        </div>
                                      ) : null}
                                  </div>
                                </button>
                                {active ? (
                                  <button
                                    type="button"
                                    className={
                                      'ghost icon-btn settings-test-btn agent-card-test-btn' +
                                      (running ? ' loading' : '')
                                    }
                                    onClick={() => void handleTestAgent()}
                                    disabled={running}
                                    title={t('settings.testTitle')}
                                  >
                                    {running ? (
                                      <>
                                        <Icon
                                          name="spinner"
                                          size={13}
                                          className="icon-spin"
                                        />
                                        <span>{t('settings.test')}</span>
                                      </>
                                    ) : (
                                      t('settings.test')
                                    )}
                                  </button>
                                ) : null}
                              </div>
                              {(a.diagnostics ?? []).map((diagnostic, i) => (
                                <AgentDiagnosticRow
                                  key={`${diagnostic.reason}-${i}`}
                                  diagnostic={diagnostic}
                                  handlers={diagnosticHandlers}
                                />
                              ))}
                              {active ? renderAgentModelConfig(a) : null}
                            </div>
                          );
                          if (active && agentTestState.status !== 'idle') {
                            const resultRow = (
                              <div
                                key={`${a.id}__test-result`}
                                className="agent-test-result-row"
                              >
                                {agentTestState.status === 'running' ? (
                                  <p
                                    className="settings-test-status running"
                                    role="status"
                                    aria-live="polite"
                                  >
                                    {t('settings.testRunning')}
                                  </p>
                                ) : (
                                  <>
                                    <p
                                      className={
                                        'settings-test-status ' +
                                        testStatusVariant(agentTestState.result)
                                      }
                                      role={
                                        agentTestState.result.ok
                                          ? 'status'
                                          : 'alert'
                                      }
                                    >
                                      {renderTestMessage(agentTestState.result)}
                                    </p>
                                    {!agentTestState.result.ok ? (
                                      <div className="settings-test-actions">
                                        <div className="settings-test-actions-row">
                                          <button
                                            type="button"
                                            className="ghost icon-btn settings-test-btn"
                                            onClick={() => void handleTestAgent()}
                                          >
                                            <Icon name="reload" size={13} />
                                            <span>{t('settings.testRetry')}</span>
                                          </button>
                                        </div>
                                      </div>
                                    ) : null}
                                  </>
                                )}
                              </div>
                            );
                            return [cardEl, resultRow];
                          }
                          return [cardEl];
                        })}
                      </div>
                    ) : (
                      <div className="empty-card">
                        {t('settings.noAgentsDetected')}
                      </div>
                    )}
                  </div>
                  {unavailableAgents.length > 0 ? (
                    <details
                      className="agent-install-collapse"
                      open={installedAgents.length > 0 ? undefined : true}
                    >
                      <summary className="agent-install-collapse-summary">
                        <span>
                          {t('settings.agentInstallGroup', {
                            count: unavailableAgents.length,
                          })}
                        </span>
                      </summary>
                      <div className="agent-grid agent-grid-unavailable">
                        {unavailableAgents.map((a) => {
                          const installUrl = sanitizeHttpsUrl(a.installUrl);
                          const docsUrl = sanitizeHttpsUrl(a.docsUrl);
                          const hasLinks = Boolean(installUrl || docsUrl);
                          const description = AGENT_SHORT_DESCRIPTIONS[a.id];
                          const agentName = displayAgentName(a);
                          const diagnosticHandlers = diagnosticHandlersForAgent(a);
                          const cardLabel = `${agentName} · ${t('common.notInstalled')}`;
                          return (
                            <div
                              key={a.id}
                              className="agent-card disabled agent-card-unavailable"
                              role="group"
                              aria-label={cardLabel}
                            >
                              <div className="agent-card-unavailable-row">
                                <AgentIcon id={a.id} size={30} />
                                <div className="agent-card-body">
                                  <div className="agent-card-name">
                                    {agentName}
                                  </div>
                                  {description ? (
                                    <div className="agent-card-description">
                                      {description}
                                    </div>
                                  ) : null}
                                </div>
                                {hasLinks ? (
                                  <div className="agent-card-actions agent-card-actions--inline">
                                    {docsUrl ? (
                                      <a
                                        href={docsUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="agent-card-link agent-card-link--muted agent-card-link--icon"
                                        onClick={markAgentInstallIntent}
                                        title={t('settings.agentInstall.docs')}
                                        aria-label={t('settings.agentInstall.docs')}
                                      >
                                        <Icon name="file" size={15} />
                                      </a>
                                    ) : null}
                                    {installUrl ? (
                                      <a
                                        href={installUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="agent-card-link agent-card-link--ghost"
                                        onClick={(event) => {
                                          markAgentInstallIntent();
                                        }}
                                      >
                                        {t('settings.agentInstall.install')}
                                      </a>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                              {/* Why is it unavailable? not-on-path vs a broken
                                  shim vs a bad *_BIN override each get a
                                  distinct, actionable line. It spans the full
                                  card width on its own row below the
                                  logo/name/links so it never crowds the inline
                                  Docs/Install actions. */}
                              {(a.diagnostics ?? []).map((diagnostic, i) => (
                                <AgentDiagnosticRow
                                  key={`${diagnostic.reason}-${i}`}
                                  diagnostic={diagnostic}
                                  handlers={diagnosticHandlers}
                                />
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                  {/*
                    Show the install guide only when the user has *no*
                    working agent picked yet. Older logic surfaced it
                    whenever any agent on the support list was missing,
                    which fired for almost everyone (few people install
                    all 14 supported CLIs) — the four-step quickstart
                    then sat between the agent grid and the model picker
                    forever, even after the user had successfully picked
                    Claude Code months ago. Once a working agent is
                    selected, the guide has done its job and only adds
                    noise.
                  */}
                  {!agents.find(
                    (a) => a.id === cfg.agentId && a.available,
                  ) ? (
                    <div className="agent-install-guide">
                      <p className="hint agent-install-path-hint">
                        {t('settings.agentInstall.pathHint')}
                      </p>
                      <ol className="agent-install-steps">
                        <li>{t('settings.agentInstall.stepOpenLinks')}</li>
                        <li>{t('settings.agentInstall.stepAuth')}</li>
                        <li>{t('settings.agentInstall.stepRescan')}</li>
                        <li>{t('settings.agentInstall.stepSelect')}</li>
                      </ol>
                    </div>
                  ) : null}
                </>
              )}

              {cfg.agentId === 'matos' ? (
                // The user's own DeepSeek key/model is stored as the native
                // `matos login` profile, which wins over deployment defaults.
                <MatOSByokProviderCard locale={locale} />
              ) : null}
            </section>
          )}
            </>
          ) : null}

          {activeSection === 'media' ? (
            <MediaProvidersSection
              cfg={cfg}
              setCfg={setCfg}
              mediaProvidersNotice={mediaProvidersNotice}
              onReloadMediaProviders={onReloadMediaProviders}
              pendingLocalProviderIds={pendingMediaProviderEditIds}
              onChange={(providerId) => {
                mediaProvidersChangeVersionRef.current += 1;
                setPendingMediaProviderEditIds((current) => {
                  if (current.has(providerId)) return current;
                  const next = new Set(current);
                  next.add(providerId);
                  return next;
                });
              }}
            />
          ) : null}
          {activeSection === 'mcpClient' ? <McpClientSection /> : null}

          {activeSection === 'routines' ? <RoutinesSection onClose={onClose} /> : null}

          {activeSection === 'language' ? (
          <section className="settings-section">
            <div className="settings-language-grid" role="radiogroup" aria-label={t('settings.language')}>
              {LOCALES.map((code) => {
                const active = locale === code;
                return (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`settings-language-tile${active ? ' active' : ''}`}
                    onClick={() => {
                      // P1 ui_click area=language — record the locale id
                      // that was picked, regardless of whether it differs
                      // from the current one (user clicked = signal).
                                            setLocale(code as Locale);
                    }}
                  >
                    <span className="settings-language-tile-text">
                      <span className="settings-language-tile-title">
                        {LOCALE_LABEL[code]}
                      </span>
                      <span className="settings-language-tile-code">
                        {code}
                      </span>
                    </span>
                    {active ? <Icon name="check" size={16} /> : null}
                  </button>
                );
              })}
            </div>
          </section>
          ) : null}

          {activeSection === 'appearance' ? (
            <AppearanceSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'evolutionJury' ? (
            <EvolutionJurySection />
          ) : null}

          {activeSection === 'notifications' ? (
            <NotificationsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'projectLocations' ? (
            <ProjectLocationsSection cfg={cfg} setCfg={setCfg} onProjectsRefresh={onProjectsRefresh} />
          ) : null}

          {activeSection === 'instructions' ? (
            <section className="settings-section settings-section-card instructions-rules-section">
              <div className="instructions-field-block instructions-rules-card">
                <div className="instructions-block-head">
                  <div>
                    <h4>{t('settings.customInstructionsTitle')}</h4>
                    <p className="hint">
                      {t('settings.customInstructionsDesc')}
                    </p>
                  </div>
                </div>
                <textarea
                  className="custom-instructions-input instructions-global-rules-input instructions-rules-input"
                  rows={5}
                  maxLength={5000}
                  placeholder={t('settings.customInstructionsPlaceholder')}
                  value={cfg.customInstructions ?? ''}
                  onChange={(event) =>
                    setCfg({
                      ...cfg,
                      customInstructions: event.target.value || undefined,
                    })
                  }
                />
              </div>
            </section>
          ) : null}




          {activeSection === 'about' ? (
            <section className="settings-section">
              {appVersionInfo ? (
                <dl className="settings-about-list">
                  <div className="settings-about-version-row">
                    <div className="settings-about-version-copy">
                      <div className="settings-about-version-left">
                        <dt>{t('settings.appVersion')}</dt>
                        <span className="settings-about-version-num">{appVersionInfo.version}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <dt>{t('settings.appChannel')}</dt>
                    <dd>{appVersionInfo.channel}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.appRuntime')}</dt>
                    <dd>
                      {appVersionInfo.packaged
                        ? t('settings.runtimePackaged')
                        : t('settings.runtimeDevelopment')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('settings.appPlatform')}</dt>
                    <dd>{appVersionInfo.platform}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.appArchitecture')}</dt>
                    <dd>{appVersionInfo.arch}</dd>
                  </div>
                </dl>
              ) : (
                <div className="empty-card">{t('settings.versionUnavailable')}</div>
              )}
              <div className="settings-about-diagnostics">
                <div className="settings-about-diagnostics-text">
                  <h4>{t('diagnostics.exportTitle')}</h4>
                  <p className="hint">{t('diagnostics.exportHint')}</p>
                </div>
                <ExportDiagnosticsRow />
              </div>
              <div className="settings-about-diagnostics">
                <div className="settings-about-diagnostics-text">
                  <h4>{t('settings.resetOnboarding')}</h4>
                  <p className="hint">{t('settings.resetOnboardingDesc')}</p>
                </div>
                <Button onClick={handleResetOnboarding}>
                  {t('settings.resetOnboardingButton')}
                </Button>
              </div>
            </section>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MediaProvidersSection({
  cfg,
  setCfg,
  mediaProvidersNotice,
  onReloadMediaProviders,
  pendingLocalProviderIds,
  onChange,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  mediaProvidersNotice?: string | null;
  onReloadMediaProviders?: () => Promise<AppConfig['mediaProviders'] | null>;
  pendingLocalProviderIds: ReadonlySet<string>;
  onChange: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const [reloadRunning, setReloadRunning] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [visibleApiKeys, setVisibleApiKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setVisibleApiKeys((current) => {
      const next = new Set<string>();
      for (const providerId of current) {
        const apiKey = cfg.mediaProviders?.[providerId]?.apiKey ?? '';
        if (apiKey.trim()) next.add(providerId);
      }
      return next.size === current.size ? current : next;
    });
  }, [cfg.mediaProviders]);
  // This section surfaces scientific-data API providers (Materials Project,
  // OpenAlex, ...) whose credentials are injected into the agent's environment.
  const visibleProviders = RESEARCH_PROVIDERS.filter(
    (p) => p.settingsVisible !== false,
  );
  // Split the catalog into two surfaces:
  //   - "Available" — daemon ships a real client, user can paste a key
  //     and it works. Rendered as full editable cards.
  //   - "Coming soon" — listed for transparency / roadmap signaling but
  //     the daemon has no client yet, so the form fields would be
  //     disabled placeholders. Hiding them behind a <details> keeps the
  //     primary list focused (was 16 cards, now 8) without dropping the
  //     informational value.
  const availableProviders = visibleProviders
    .filter((p) => p.integrated)
    .slice()
    .sort((a, b) => {
      const aEntry = cfg.mediaProviders?.[a.id];
      const bEntry = cfg.mediaProviders?.[b.id];
      const aConfigured = isStoredMediaProviderEntryPresent(aEntry);
      const bConfigured = isStoredMediaProviderEntryPresent(bEntry);
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  const comingSoonProviders = visibleProviders
    .filter((p) => !p.integrated)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));
  const updateProvider = (
    provider: ResearchProvider,
    patch: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      apiKeyConfigured?: boolean;
      apiKeyTail?: string;
    },
  ) => {
    onChange(provider.id);
    setCfg((curr) => {
      const prev = curr.mediaProviders?.[provider.id] ?? { apiKey: '', baseUrl: '', model: '' };
      const next = { ...prev, ...patch };
      const map = { ...(curr.mediaProviders ?? {}) };
      if (isStoredMediaProviderEntryEmpty(next)) {
        delete map[provider.id];
      } else {
        map[provider.id] = next;
      }
      return { ...curr, mediaProviders: map };
    });
  };
  const handleReload = async () => {
    if (!onReloadMediaProviders || reloadRunning) return;
    setReloadRunning(true);
    setReloadNotice(null);
    try {
      const next = await onReloadMediaProviders();
      if (!next) {
        setReloadNotice({ kind: 'error', message: t('settings.mediaProviderReloadError') });
        return;
      }
      setCfg((curr) => mergeDaemonMediaProviders(curr, next, {
        preserveLocalProviderIds: pendingLocalProviderIds,
      }));
      setReloadNotice({ kind: 'success', message: t('settings.mediaProviderReloadSuccess') });
    } finally {
      setReloadRunning(false);
    }
  };
  // Successful reload acknowledgement lives on the button (✓ Reloaded)
  // for ~2s then disappears. Keeping it as a permanent paragraph under
  // the section header was noise — the user just clicked a button and
  // got a visible state change, an extra "we did the thing" line is
  // redundant. Errors stay sticky because they actually require user
  // attention.
  useEffect(() => {
    if (reloadNotice?.kind !== 'success') return;
    const handle = window.setTimeout(() => setReloadNotice(null), 2000);
    return () => window.clearTimeout(handle);
  }, [reloadNotice]);

  const toggleApiKeyVisibility = (providerId: string) => {
    setVisibleApiKeys((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  return (
    <section className="settings-section">
      {mediaProvidersNotice ? (
        <p className="hint" role="alert">{mediaProvidersNotice}</p>
      ) : null}
      {reloadNotice && reloadNotice.kind === 'error' ? (
        // Errors only — successful reload feedback now rides on the
        // button (see is-success-flash above) and clears itself after
        // 2s, so the section header doesn't get colonised by a
        // permanent "yes I did the thing" paragraph.
        <p className="hint" role="alert">{reloadNotice.message}</p>
      ) : null}
      {reloadNotice && reloadNotice.kind === 'success' ? (
        // Off-screen announcement so assistive tech still hears the
        // success state even though the visible feedback collapses
        // into a transient button label change.
        <VisuallyHidden role="status">
          {reloadNotice.message}
        </VisuallyHidden>
      ) : null}
      {onReloadMediaProviders ? (
        <div className="media-provider-reload-row">
          <button
            type="button"
            className={`ghost media-provider-reload-btn${
              reloadNotice?.kind === 'success' ? ' is-success-flash' : ''
            }`}
            onClick={() => {
                            void handleReload();
            }}
            disabled={reloadRunning}
            aria-live="polite"
          >
            {reloadRunning ? (
              t('common.loading')
            ) : reloadNotice?.kind === 'success' ? (
              <>
                <Icon name="check" size={13} />
                <span style={{ marginLeft: 4 }}>Reloaded</span>
              </>
            ) : (
              <>
                <Icon name="refresh" size={13} />
                <span style={{ marginLeft: 4 }}>{t('settings.mediaProviderReload')}</span>
              </>
            )}
          </button>
        </div>
      ) : null}
      <div className="media-provider-list">
        {availableProviders.map((provider) => {
          const entry = cfg.mediaProviders?.[provider.id] ?? { apiKey: '', baseUrl: '', model: '' };
          const hasPendingEdit = Boolean(entry.apiKey.trim());
          const isSavedState = Boolean((hasPendingEdit || entry.apiKeyConfigured) && !hasPendingEdit);
          const tail = entry.apiKeyTail?.trim();
          // Every provider rendered in the main list is integrated by
          // construction (see availableProviders filter), so the inputs
          // are always editable here. Non-integrated entries live in
          // the "Coming soon" <details> below.
          const supportsCustomModel = provider.supportsCustomModel === true;
          const requiresCredentials = provider.credentialsRequired !== false;
          const clearable = isStoredMediaProviderEntryPresent(entry);
          const apiKeyVisible = visibleApiKeys.has(provider.id);
          return (
            <div key={provider.id} className="media-provider-row">
              <div className="media-provider-head">
                <div className="media-provider-meta">
                  {/*
                    Provider name + "Saved" badge sit on a single row.
                    The badge used to render below the name with a green
                    success-pill treatment, which clashed with the green
                    "Integrated" badge on the right of the same row and
                    pushed the model hint two lines down. Inline + a
                    neutral muted treatment keeps the row scannable: green
                    means "we support this", blue means "you configured
                    it", gray means "your key is persisted" — three
                    distinct hues, three distinct meanings.
                  */}
                  <div className="media-provider-name-row">
                    <span className="media-provider-name">{provider.label}</span>
                    {isSavedState ? (
                      <span
                        className="field-status-badge field-status-badge--inline"
                        title={t('settings.connectorsSavedTitle')}
                      >
                        {tail
                          ? t('settings.connectorsSavedWithTail', { tail })
                          : t('settings.connectorsSaved')}
                      </span>
                    ) : null}
                  </div>
                  <span className="media-provider-hint">{provider.hint}</span>
                </div>
                {/*
                  Right-side badges deliberately omitted now: every row
                  in this list is "Integrated" by definition and the
                  "Configured" pill duplicated the inline "Saved" chip
                  next to the provider name. Three pills per row read
                  as warnings; one chip reads as status.
                */}
              </div>
              {requiresCredentials ? (
                <div className="media-provider-body">
                  <div className="media-provider-secret-field">
                    <input
                      type={apiKeyVisible ? 'text' : 'password'}
                      value={entry.apiKey}
                      placeholder={isSavedState ? t('settings.connectorsReplaceKeyPlaceholder') : t('settings.mediaProviderPlaceholder')}
                      aria-label={`${provider.label} ${t('settings.mediaProviderApiKey')}`}
                      onFocus={() => {
                                              }}
                      onChange={(e) => updateProvider(provider, { apiKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="secret-visibility-button"
                      aria-label={
                        apiKeyVisible
                          ? `${provider.label} ${t('settings.hideKey')}`
                          : `${provider.label} ${t('settings.showKey')}`
                      }
                      aria-pressed={apiKeyVisible}
                      onClick={() => toggleApiKeyVisibility(provider.id)}
                    >
                        <Icon name={apiKeyVisible ? 'eye' : 'eye-off'} size={15} />
                      </button>
                    </div>
                  {provider.agentEnvVars && provider.agentEnvVars.length > 0 ? (
                    <p className="hint media-provider-env-hint">
                      {t('settings.mediaProviderAgentEnvHint', {
                        vars: provider.agentEnvVars.join(', '),
                      })}
                    </p>
                  ) : null}
                  <input
                    value={entry.baseUrl}
                    placeholder={provider.defaultBaseUrl || t('settings.mediaProviderBaseUrlPlaceholder')}
                    aria-label={`${provider.label} ${t('settings.mediaProviderBaseUrl')}`}
                    onFocus={() => {
                                          }}
                    onChange={(e) => updateProvider(provider, { baseUrl: e.target.value })}
                  />
                  {supportsCustomModel ? (
                    <input
                      value={entry.model ?? ''}
                      placeholder="gemini-3.1-flash-image-preview"
                      aria-label={`${provider.label} model`}
                      onChange={(e) => updateProvider(provider, { model: e.target.value })}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    disabled={!clearable}
                    onClick={() => {
                                            // Match the existing window.confirm guard the rest of
                      // the app uses for destructive actions (conversation
                      // delete, design delete, file delete in FileWorkspace).
                      // Without this a stray click on the row's Clear button
                      // wipes the saved key with no recovery. Issue #737.
                      if (
                        !confirm(
                          t('settings.mediaProviderClearConfirm', {
                            name: provider.label,
                          }),
                        )
                      ) {
                        return;
                      }
                      updateProvider(provider, {
                        apiKey: '',
                        baseUrl: '',
                        model: '',
                        apiKeyConfigured: false,
                        apiKeyTail: '',
                      });
                    }}
                  >
                    {t('settings.mediaProviderClear')}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {comingSoonProviders.length > 0 ? (
        // Roadmap drawer. We still want to advertise that we know
        // these providers exist (so users don't ask "where is Fal?"),
        // but disabled placeholder cards in the main list were noise.
        // Closed by default — opens to a compact name + hint + docs
        // link list, no inputs because there's nothing to wire up yet.
        // TODO(i18n): inline English placeholders; promote to locale
        // keys when we touch this section again.
        <details className="library-group media-provider-coming-soon">
          <summary className="library-details-summary">
            <span className="library-details-title">
              {t('settings.mediaProviderPublicSources')}
            </span>
            <span className="filter-pill-count">
              {comingSoonProviders.length}
            </span>
          </summary>
          <p className="hint" style={{ marginTop: 4, marginBottom: 8 }}>
            {t('settings.mediaProviderComingSoonHint')}
          </p>
          <ul className="media-provider-coming-soon-list">
            {comingSoonProviders.map((provider) => {
              const docsHref = sanitizeHttpsUrl(provider.docsUrl);
              return (
                <li
                  key={provider.id}
                  className="media-provider-coming-soon-item"
                >
                  <div className="media-provider-coming-soon-meta">
                    <span className="media-provider-name">
                      {provider.label}
                    </span>
                    <span className="media-provider-hint">
                      {provider.hint}
                    </span>
                  </div>
                  {docsHref ? (
                    <a
                      href={docsHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ghost-link"
                    >
                      {t('settings.agentInstall.docs')}
                      <Icon name="external-link" size={11} />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

const THEMES: Array<{ value: AppTheme; labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark'; icon?: 'sun' | 'moon' }> = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight', icon: 'sun' },
  { value: 'dark', labelKey: 'settings.themeDark', icon: 'moon' },
];

function AppearanceSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const current = cfg.theme ?? 'system';
  const currentAccent = normalizeAccentColor(cfg.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const accentLabel = t('pet.fieldAccent');
  const defaultAccentLabel = t('pet.fieldAccentDefault');
  const customAccentLabel = t('pet.fieldAccentCustom');

  // Apply the draft theme immediately so the user sees a live preview
  // before hitting Save. SettingsDialog's cleanup reverts this on cancel.
  useLayoutEffect(() => {
    applyAppearanceToDocument({
      theme: current,
      accentColor: currentAccent,
    });
  }, [current, currentAccent]);

  const setAccentColor = (color: string) => {
    setCfg((c) => ({ ...c, accentColor: normalizeAccentColor(color) ?? c.accentColor ?? DEFAULT_ACCENT_COLOR }));
  };

  return (
    <section className="settings-section">
      <div className="seg-control" role="group" aria-label={t('settings.appearance')} style={{ '--seg-cols': THEMES.length } as React.CSSProperties}>
        {THEMES.map(({ value, labelKey, icon }) => (
          <button
            key={value}
            type="button"
            className={'seg-btn' + (current === value ? ' active' : '')}
            aria-pressed={current === value}
            onClick={() => {
              // P1 ui_click area=appearance — `system|light|dark` only
              // emits from the segmented control; accent swatch picks
              // use `accent_color` with the swatch hex below.
              if (value === 'system' || value === 'light' || value === 'dark') {
                              }
              setCfg((c) => ({ ...c, theme: value }));
            }}
          >
            {icon ? <Icon name={icon} size={14} aria-hidden="true" /> : null}
            <span className="seg-title">{t(labelKey)}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <span className="field-label">{accentLabel}</span>
        <div className="accent-swatches" role="radiogroup" aria-label={accentLabel}>
          {ACCENT_SWATCHES.map((color) => {
            const active = currentAccent === color;
            return (
              <button
                key={color}
                type="button"
                className={`accent-swatch${active ? ' active' : ''}`}
                style={{ background: color }}
                aria-label={color === DEFAULT_ACCENT_COLOR ? defaultAccentLabel : color}
                aria-checked={active}
                role="radio"
                onClick={() => {
                                    setAccentColor(color);
                }}
              />
            );
          })}
          <input
            type="color"
            aria-label={customAccentLabel}
            className="accent-swatch-picker"
            value={currentAccent}
            onChange={(e) => setAccentColor(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Settings surface for the MatOS 自进化评审团 (Self-Evolution Jury).
 *
 * Unlike the Design Jury, this toggle is a pure browser-side *visibility*
 * switch. MatOS self-evolution runs always-on server-side (the hidden critic →
 * refiner → editor → judge pipeline learns from every user-visible run), so
 * there is no daemon gating or project-metadata round-trip to keep in
 * lockstep. The flag only decides whether the workspace renders the live
 * projection of that pipeline next to the chat. The hint states this plainly
 * so users do not read the "off" state as "self-evolution disabled".
 */
function EvolutionJurySection() {
  const { t } = useI18n();
  const enabled = useEvolutionJuryEnabled();
  return (
    <section className="settings-section">
      <div className="section-head">
        <div>
          <h3>{t('evolutionJury.settingsNav')}</h3>
          <p className="hint">{t('evolutionJury.settingsNavHint')}</p>
        </div>
      </div>
      <label className="field">
        <span className="field-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEvolutionJuryEnabled(e.target.checked)}
          />
          {' '}
          {t('evolutionJury.settingsEnabledLabel')}
        </span>
        <small className="hint">
          {t('evolutionJury.settingsEnabledDescription')}
        </small>
        <small className="hint">
          {t('evolutionJury.settingsAlwaysOnHint')}
        </small>
      </label>
      <div className="field">
        <span className="field-label">{t('evolutionPage.policyTitle')}</span>
        <small className="hint">{t('evolutionPage.policyHint')}</small>
        <EvolutionPolicyControl />
      </div>
    </section>
  );
}

function NotificationsSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const notif = cfg.notifications ?? DEFAULT_NOTIFICATIONS;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    () => notificationPermission(),
  );
  const [testStatus, setTestStatus] = useState<ReturnType<typeof testNotificationStatusText> | null>(null);

  const updateNotif = (
    patch: Partial<NonNullable<AppConfig['notifications']>>,
  ) => {
    setCfg((c) => ({
      ...c,
      notifications: { ...DEFAULT_NOTIFICATIONS, ...(c.notifications ?? {}), ...patch },
    }));
  };

  const toggleSound = () => {
    const next = !notif.soundEnabled;
    // P1 ui_click area=notifications element=completion_sound — the toggle
    // emits the post-click state on `completion_sound_status` so a single
    // event captures intent + outcome.
        updateNotif({ soundEnabled: next });
    // Give the user immediate audible feedback when turning the master
    // switch on so they know which sound they're signing up for. Resuming
    // the AudioContext also bakes in their gesture for later auto-plays.
    if (next) playSound(notif.successSoundId);
  };

  const toggleDesktop = async () => {
    if (notif.desktopEnabled) {
            updateNotif({ desktopEnabled: false });
      return;
    }
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
            updateNotif({ desktopEnabled: true });
    } else {
            updateNotif({ desktopEnabled: false });
    }
  };

  const sendTestNotification = async () => {
    const result = await showCompletionNotification({
      status: 'succeeded',
      title: t('notify.successTitle'),
      body: t('notify.successBody'),
    });
    setPermission(notificationPermission());
    setTestStatus(testNotificationStatusText(result));
  };

  return (
    <section className="settings-section">
      <div className="settings-subsection">
        <div className="settings-notify-card">
          <div className="settings-notify-card-header">
            <h4>{t('settings.notifyCompletionSound')}</h4>
            <div className="section-head-actions">
              <div className="seg-control" role="group" aria-label={t('settings.notifyCompletionSound')} style={{ '--seg-cols': 1 } as React.CSSProperties}>
                <button
                  type="button"
                  className={'seg-btn' + (notif.soundEnabled ? ' active' : '')}
                  aria-pressed={notif.soundEnabled}
                  onClick={toggleSound}
                >
                  <span className="seg-title">{notif.soundEnabled ? t('common.active') : t('common.offline')}</span>
                </button>
              </div>
            </div>
          </div>
          <p className="hint settings-notify-card-hint">{t('settings.notifyCompletionSoundHint')}</p>
        </div>

        {notif.soundEnabled ? (
          <>
            <div className="settings-field">
              <label>{t('settings.notifySuccessSound')}</label>
              <div className="seg-control" role="group" aria-label={t('settings.notifySuccessSound')} style={{ '--seg-cols': SUCCESS_SOUNDS.length } as React.CSSProperties}>
                {SUCCESS_SOUNDS.map((sound) => (
                  <button
                    key={sound.id}
                    type="button"
                    className={'seg-btn' + (notif.successSoundId === sound.id ? ' active' : '')}
                    aria-pressed={notif.successSoundId === sound.id}
                    onClick={() => {
                                            updateNotif({ successSoundId: sound.id });
                      playSound(sound.id);
                    }}
                  >
                    <span className="seg-title">{t(sound.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label>{t('settings.notifyFailureSound')}</label>
              <div className="seg-control" role="group" aria-label={t('settings.notifyFailureSound')} style={{ '--seg-cols': FAILURE_SOUNDS.length } as React.CSSProperties}>
                {FAILURE_SOUNDS.map((sound) => (
                  <button
                    key={sound.id}
                    type="button"
                    className={'seg-btn' + (notif.failureSoundId === sound.id ? ' active' : '')}
                    aria-pressed={notif.failureSoundId === sound.id}
                    onClick={() => {
                                            updateNotif({ failureSoundId: sound.id });
                      playSound(sound.id);
                    }}
                  >
                    <span className="seg-title">{t(sound.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="settings-subsection">
        <div className="settings-notify-card">
          <div className="settings-notify-card-header">
            <h4>{t('settings.notifyDesktop')}</h4>
            <div className="section-head-actions">
              <div className="seg-control" role="group" aria-label={t('settings.notifyDesktop')} style={{ '--seg-cols': 1 } as React.CSSProperties}>
                <button
                  type="button"
                  className={'seg-btn' + (notif.desktopEnabled ? ' active' : '')}
                  aria-pressed={notif.desktopEnabled}
                  disabled={permission === 'unsupported'}
                  onClick={() => { void toggleDesktop(); }}
                >
                  <span className="seg-title">{notif.desktopEnabled ? t('common.active') : t('common.offline')}</span>
                </button>
              </div>
            </div>
          </div>
          <p className="hint settings-notify-card-hint">{t('settings.notifyDesktopHint')}</p>
        </div>
        {permission === 'unsupported' ? (
          <p className="hint">{t('settings.notifyDesktopUnsupported')}</p>
        ) : null}
        {permission === 'denied' ? (
          <p className="hint">{t('settings.notifyDesktopBlocked')}</p>
        ) : null}
        {notif.desktopEnabled && permission === 'granted' ? (
          <>
            <Button variant="ghost" onClick={() => {
                            void sendTestNotification();
            }}>
              {t('settings.notifyTest')}
            </Button>
            {testStatus ? <p className="hint" role="status">{t(testStatus)}</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function testNotificationStatusText(
  result: Awaited<ReturnType<typeof showCompletionNotification>>,
):
  | 'settings.notifyTestSent'
  | 'settings.notifyDesktopBlocked'
  | 'settings.notifyDesktopUnsupported'
  | 'settings.notifyTestFailed' {
  if (result === 'shown') return 'settings.notifyTestSent';
  if (result === 'permission-denied') return 'settings.notifyDesktopBlocked';
  if (result === 'unsupported') return 'settings.notifyDesktopUnsupported';
  return 'settings.notifyTestFailed';
}
