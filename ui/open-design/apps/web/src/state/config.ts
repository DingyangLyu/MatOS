import type { AppConfigPrefs } from '@open-design/contracts';
import { RESEARCH_PROVIDERS } from '@open-design/contracts';
import type {
  AppConfig,
  MediaProviderCredentials,
  NotificationsConfig,
} from '../types';
import {
  DEFAULT_ACCENT_COLOR,
  normalizeAccentColor,
} from './appearance';
import {
  DEFAULT_FAILURE_SOUND_ID,
  DEFAULT_SUCCESS_SOUND_ID,
} from '../utils/notifications';

const STORAGE_KEY = 'open-design:config';

// Both switches default off so first-run users are not greeted by a
// surprise sound or a permission prompt; they can opt in from Settings →
// Notifications when they want it.
export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  soundEnabled: false,
  successSoundId: DEFAULT_SUCCESS_SOUND_ID,
  failureSoundId: DEFAULT_FAILURE_SOUND_ID,
  desktopEnabled: false,
};


export const DEFAULT_CONFIG: AppConfig = {
  agentId: null,
  skillId: null,
  onboardingCompleted: false,
  theme: 'system',
  accentColor: DEFAULT_ACCENT_COLOR,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
  agentCliEnvIntent: {},
  notifications: DEFAULT_NOTIFICATIONS,
  projectLocations: [],
  defaultProjectLocationId: 'default',
};

function normalizeNotifications(
  input: Partial<NotificationsConfig> | undefined,
): NotificationsConfig {
  return { ...DEFAULT_NOTIFICATIONS, ...(input ?? {}) };
}

const RETIRED_API_CONFIG_KEYS = [
  'mode',
  'apiKey',
  'baseUrl',
  'model',
  'apiProtocol',
  'apiVersion',
  'apiProtocolConfigs',
  'apiProviderBaseUrl',
  'byokProviderConfigDrafts',
  'configMigrationVersion',
  'maxTokens',
] as const;

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_CONFIG,
        notifications: normalizeNotifications(DEFAULT_NOTIFICATIONS),
      };
    }
    const parsed = JSON.parse(raw) as Partial<AppConfig> & Record<string, unknown>;
    for (const key of RETIRED_API_CONFIG_KEYS) {
      delete (parsed as Record<string, unknown>)[key];
    }
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      mediaProviders: { ...(parsed.mediaProviders ?? {}) },
      agentModels: { ...(parsed.agentModels ?? {}) },
      agentCliEnv: { ...(parsed.agentCliEnv ?? {}) },
      agentCliEnvIntent: { ...(parsed.agentCliEnvIntent ?? {}) },
      accentColor: normalizeAccentColor(parsed.accentColor) ?? DEFAULT_CONFIG.accentColor,
      notifications: normalizeNotifications(parsed.notifications),
    };
  } catch {
    return {
      ...DEFAULT_CONFIG,
      notifications: normalizeNotifications(DEFAULT_NOTIFICATIONS),
    };
  }
}

interface PublicMediaProviderConfigEntry {
  configured?: boolean;
  source?: string;
  apiKeyTail?: string;
  baseUrl?: string;
  model?: string;
}

interface PublicMediaProviderConfigResponse {
  providers?: Record<string, PublicMediaProviderConfigEntry>;
}

export type DaemonMediaProvidersFetchResult =
  | {
    status: 'ok';
    providers: AppConfig['mediaProviders'];
  }
  | {
    status: 'error';
  };

interface MediaProviderDaemonWriteEntry {
  apiKey?: string;
  preserveApiKey?: boolean;
  baseUrl?: string;
  model?: string;
}

interface MediaProviderDaemonWriteRequest {
  providers: Record<string, MediaProviderDaemonWriteEntry>;
  force: boolean;
}

function hasAnyDaemonManagedMediaProvider(
  providers: Record<string, MediaProviderCredentials> | null | undefined,
): boolean {
  if (!providers) return false;
  return Object.values(providers).some((entry) => isStoredMediaProviderEntryPresent(entry));
}

function hasRecoverableLocalMediaProviderFields(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return Boolean(
    entry?.apiKey?.trim()
    || entry?.baseUrl?.trim()
    || entry?.model?.trim(),
  );
}

function isMarkerOnlyMediaProviderEntry(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return isStoredMediaProviderEntryPresent(entry)
    && !hasRecoverableLocalMediaProviderFields(entry);
}

export function isStoredMediaProviderEntryPresent(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return Boolean(
    entry?.apiKey?.trim()
    || entry?.baseUrl?.trim()
    || entry?.model?.trim()
    || entry?.apiKeyConfigured
    || entry?.apiKeyTail?.trim(),
  );
}

export function isStoredMediaProviderEntryEmpty(
  entry: MediaProviderCredentials | null | undefined,
): boolean {
  return !isStoredMediaProviderEntryPresent(entry);
}

function defaultBaseUrlForProvider(providerId: string): string {
  return RESEARCH_PROVIDERS.find((provider) => provider.id === providerId)?.defaultBaseUrl ?? '';
}

export function buildMediaProvidersForDaemonSave(
  currentProviders: Record<string, MediaProviderCredentials> | undefined,
  daemonProviders: Record<string, MediaProviderCredentials> | null | undefined,
  options?: { force?: boolean },
): MediaProviderDaemonWriteRequest {
  const providers: Record<string, MediaProviderDaemonWriteEntry> = {};
  for (const [providerId, currentEntry] of Object.entries(currentProviders ?? {})) {
    const daemonEntry = daemonProviders?.[providerId];
    const apiKey = currentEntry?.apiKey?.trim() ?? '';
    const hasStoredKeyMarker = Boolean(
      currentEntry?.apiKeyTail?.trim()
      || daemonEntry?.apiKeyTail?.trim(),
    );
    const preserveApiKey = !apiKey && Boolean(
      currentEntry?.apiKeyConfigured
      && hasStoredKeyMarker,
    );
    const explicitBaseUrl =
      currentEntry?.baseUrl?.trim()
      || daemonEntry?.baseUrl?.trim()
      || '';
    const model = currentEntry?.model?.trim() || daemonEntry?.model?.trim() || '';
    if (!apiKey && !preserveApiKey && !explicitBaseUrl && !model) continue;
    const baseUrl = explicitBaseUrl || defaultBaseUrlForProvider(providerId);
    providers[providerId] = {
      ...(apiKey ? { apiKey } : {}),
      ...(preserveApiKey ? { preserveApiKey: true } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    };
  }
  return {
    providers,
    force: Boolean(options?.force),
  };
}

export async function fetchMediaProvidersFromDaemon(): Promise<DaemonMediaProvidersFetchResult> {
  try {
    const response = await fetch('/api/media/config');
    if (!response.ok) return { status: 'error' };
    const payload = await response.json() as PublicMediaProviderConfigResponse;
    const rawProviders = payload.providers ?? {};
    const providers: AppConfig['mediaProviders'] = {};
    for (const [providerId, entry] of Object.entries(rawProviders)) {
      providers[providerId] = {
        apiKey: '',
        apiKeyConfigured: Boolean(entry?.configured),
        apiKeyTail: entry?.apiKeyTail ?? '',
        baseUrl: entry?.baseUrl ?? '',
        ...(typeof entry?.source === 'string' && entry.source.trim()
          ? { source: entry.source.trim() }
          : {}),
        ...(typeof entry?.model === 'string' && entry.model.trim()
          ? { model: entry.model.trim() }
          : {}),
      };
    }
    return {
      status: 'ok',
      providers,
    };
  } catch {
    return { status: 'error' };
  }
}

const AGENT_CLI_SECRET_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
]);

function sanitizeAgentCliEnv(agentCliEnv: AppConfig['agentCliEnv']): AppConfig['agentCliEnv'] {
  if (!agentCliEnv) return agentCliEnv;
  const sanitized: NonNullable<AppConfig['agentCliEnv']> = {};
  for (const [agentId, env] of Object.entries(agentCliEnv)) {
    const safeEnv = Object.fromEntries(
      Object.entries(env ?? {}).filter(([key]) => !AGENT_CLI_SECRET_ENV_KEYS.has(key)),
    );
    sanitized[agentId] = safeEnv;
  }
  return sanitized;
}

export function saveConfig(config: AppConfig): void {
  const sanitized: AppConfig = { ...config, agentCliEnv: sanitizeAgentCliEnv(config.agentCliEnv) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
}

export function mergeDaemonConfig(
  localConfig: AppConfig,
  daemonConfig: AppConfigPrefs | null,
): AppConfig {
  const next = { ...localConfig };
  if (!daemonConfig) return next;

  if (daemonConfig.onboardingCompleted != null) {
    next.onboardingCompleted = daemonConfig.onboardingCompleted;
  }
  if (daemonConfig.agentId !== undefined) {
    next.agentId = daemonConfig.agentId;
  }
  if (daemonConfig.skillId !== undefined) {
    next.skillId = daemonConfig.skillId;
  }
  if (daemonConfig.agentModels) {
    next.agentModels = {
      ...(next.agentModels ?? {}),
      ...daemonConfig.agentModels,
    };
  }
  next.agentCliEnv = daemonConfig.agentCliEnv ?? {};
  next.agentCliEnvIntent = daemonConfig.agentCliEnvIntent ?? {};
  if (daemonConfig.disabledSkills !== undefined) {
    next.disabledSkills = daemonConfig.disabledSkills;
  }
  if (daemonConfig.customInstructions !== undefined) {
    next.customInstructions = daemonConfig.customInstructions ?? undefined;
  }
  if (daemonConfig.projectLocations !== undefined) {
    next.projectLocations = daemonConfig.projectLocations;
  }
  if (daemonConfig.defaultProjectLocationId !== undefined) {
    next.defaultProjectLocationId = daemonConfig.defaultProjectLocationId ?? 'default';
  }
  return next;
}

export function mergeDaemonMediaProviders(
  localConfig: AppConfig,
  daemonProviders: AppConfig['mediaProviders'] | null,
  options?: {
    preserveLocalProviderIds?: ReadonlySet<string>;
  },
): AppConfig {
  if (daemonProviders == null) {
    return { ...localConfig };
  }

  if (!hasAnyDaemonManagedMediaProvider(daemonProviders)) {
    return {
      ...localConfig,
      mediaProviders: Object.fromEntries(
        Object.entries(localConfig.mediaProviders ?? {}).filter(([, entry]) => !isMarkerOnlyMediaProviderEntry(entry)),
      ),
    };
  }

  const mediaProviders = { ...(localConfig.mediaProviders ?? {}) };
  for (const [providerId, daemonEntry] of Object.entries(daemonProviders ?? {})) {
    if (!isStoredMediaProviderEntryPresent(daemonEntry)) continue;
    const localEntry = mediaProviders[providerId];
    const preserveLocalPendingEdit = Boolean(
      options?.preserveLocalProviderIds?.has(providerId)
      && hasRecoverableLocalMediaProviderFields(localEntry),
    );
    mediaProviders[providerId] = preserveLocalPendingEdit
      ? { ...daemonEntry, ...localEntry }
      : { ...daemonEntry };
  }

  return {
    ...localConfig,
    mediaProviders,
  };
}

export function hasAnyConfiguredProvider(
  providers: Record<string, MediaProviderCredentials> | undefined,
): boolean {
  if (!providers) return false;
  return Object.values(providers).some((entry) => isStoredMediaProviderEntryPresent(entry));
}

export function shouldSyncLocalMediaProvidersToDaemon(
  localProviders: Record<string, MediaProviderCredentials> | undefined,
  daemonProviders: Record<string, MediaProviderCredentials> | null | undefined,
): boolean {
  return daemonProviders != null
    && Object.values(localProviders ?? {}).some((entry) => hasRecoverableLocalMediaProviderFields(entry))
    && !hasAnyDaemonManagedMediaProvider(daemonProviders);
}

export async function syncMediaProvidersToDaemon(
  providers: Record<string, MediaProviderCredentials> | undefined,
  options?: {
    force?: boolean;
    daemonProviders?: Record<string, MediaProviderCredentials> | null;
    throwOnError?: boolean;
  },
): Promise<void> {
  if (!providers) return;
  try {
    const payload = buildMediaProvidersForDaemonSave(
      providers,
      options?.daemonProviders,
      { force: options?.force },
    );
    const response = await fetch('/api/media/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Failed to sync media config (${response.status})`);
  } catch {
    if (options?.throwOnError) throw new Error('Media config save failed');
    // Daemon offline; localStorage keeps the user's copy for the next save.
  }
}

export async function fetchDaemonConfig(): Promise<AppConfigPrefs | null> {
  try {
    const res = await fetch('/api/app-config');
    if (!res.ok) return null;
    const data = await res.json();
    return data?.config ?? null;
  } catch {
    return null;
  }
}

export async function syncConfigToDaemon(
  config: AppConfig,
  options?: { throwOnError?: boolean },
): Promise<void> {
  const prefs: AppConfigPrefs = {
    onboardingCompleted: config.onboardingCompleted,
    agentId: config.agentId,
    agentModels: config.agentModels,
    agentCliEnv: config.agentCliEnv,
    agentCliEnvIntent: config.agentCliEnvIntent,
    skillId: config.skillId,
    disabledSkills: config.disabledSkills,
    customInstructions: config.customInstructions ?? null,
    projectLocations: config.projectLocations ?? [],
    defaultProjectLocationId: config.defaultProjectLocationId ?? 'default',
  };
  try {
    const response = await fetch('/api/app-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    if (!response.ok) throw new Error(`Failed to sync app config (${response.status})`);
  } catch (error) {
    if (options?.throwOnError) throw error;
    // Daemon offline; localStorage keeps the user's copy for the next save.
  }
}
