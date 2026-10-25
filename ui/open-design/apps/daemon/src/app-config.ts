// Daemon-backed app preferences (onboarding state, agent/skill/DS selection).
//
// The web frontend pushes preferences here via PUT /api/app-config; the
// daemon persists them to <dataDir>/app-config.json (where dataDir defaults
// to <projectRoot>/.od but follows OD_DATA_DIR when set, keeping test and
// multi-namespace runs isolated). This survives browser storage resets and
// origin changes so onboarding and agent selection don't reappear unexpectedly.
//
// `agentCliEnv` is intentionally limited by allowlist below. It is the
// explicit low-level launch environment for Local CLI runs, separate from
// provider BYOK. API-key entries here configure the underlying CLI itself;
// BASE_URL is optional and, when omitted, the CLI uses its default endpoint.
// `agentCliEnvIntent` records when API-key entries were saved under that new
// CLI-override contract. Older builds labeled the same fields as proxy-only,
// so legacy standalone keys without a base URL are dropped unless this marker
// or a matching base URL proves that the user intended to activate them.
// These values are local-only and should not be logged or returned outside
// this machine.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { expandHomePrefix } from './home-expansion.js';


export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;
export type AgentCliEnvIntentPrefs = Record<string, { apiKeyOverride?: boolean }>;

export interface ProjectLocationPrefs {
  id: string;
  name: string;
  path: string;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  agentCliEnvIntent?: AgentCliEnvIntentPrefs;
  skillId?: string | null;
  disabledSkills?: string[];
  customInstructions?: string | null;
  projectLocations?: ProjectLocationPrefs[];
  defaultProjectLocationId?: string | null;
  // Most-recently-used local working directories the user granted the agent
  // read access to from the Home composer. Become a project's
  // `metadata.linkedDirs` (read-only `--add-dir` awareness, no Design Files
  // import). Stored most-recent-first; capped at RECENT_LINKED_DIRS_MAX.
  recentLinkedDirs?: string[];
}

// Cap on how many recent working directories we remember. Keeps the picker's
// "Recent" submenu short and the config file bounded.
export const RECENT_LINKED_DIRS_MAX = 5;

const ALLOWED_KEYS: ReadonlySet<keyof AppConfigPrefs> = new Set([
  'onboardingCompleted',
  'agentId',
  'agentModels',
  'agentCliEnv',
  'agentCliEnvIntent',
  'skillId',
  'disabledSkills',
  'customInstructions',
  'projectLocations',
  'defaultProjectLocationId',
  'recentLinkedDirs',
] as const);

function configFile(dataDir: string): string {
  return path.join(dataDir, 'app-config.json');
}

export function appConfigDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OD_DATA_DIR;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return path.join(projectRoot, '.od');
  }
  const expanded = expandHomePrefix(raw.trim());
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

const AGENT_MODEL_KEYS: ReadonlySet<string> = new Set(['model', 'reasoning']);
const RETIRED_AGENT_IDS: ReadonlySet<string> = new Set(['gemini']);

const AGENT_CLI_ENV_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['matos', new Set([
    'MATOS_BIN', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
    'MATOS_DSH_MODEL', 'MATOS_DSH_EFFORT', 'MATOS_DSH_TIMEOUT_MS',
  ])],
]);

const AGENT_CLI_AUTH_ENV_KEYS: ReadonlyMap<string, {
  auth: ReadonlySet<string>;
  baseUrl: ReadonlySet<string>;
}> = new Map([
  ['matos', {
    auth: new Set(['DEEPSEEK_API_KEY']),
    baseUrl: new Set(['DEEPSEEK_BASE_URL']),
  }],
]);

function isValidAgentModelEntry(v: unknown): v is AgentModelPrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!AGENT_MODEL_KEYS.has(k)) return false;
    if (obj[k] !== undefined && typeof obj[k] !== 'string') return false;
  }
  return true;
}

function validateAgentModels(
  raw: unknown,
): Record<string, AgentModelPrefs> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, AgentModelPrefs> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (isValidAgentModelEntry(v)) {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateAgentCliEnv(raw: unknown): AgentCliEnvPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: AgentCliEnvPrefs = Object.create(null);
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId === '__proto__' || agentId === 'constructor') continue;
    const allowed = AGENT_CLI_ENV_KEYS.get(agentId);
    if (!allowed || typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const env: Record<string, string> = Object.create(null);
    for (const [envKey, envValue] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(envKey)) continue;
      if (typeof envValue !== 'string') continue;
      const trimmed = envValue.trim();
      if (!trimmed) continue;
      env[envKey] = trimmed;
    }
    if (Object.keys(env).length > 0) result[agentId] = env;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateAgentCliEnvIntent(raw: unknown): AgentCliEnvIntentPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: AgentCliEnvIntentPrefs = Object.create(null);
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId === '__proto__' || agentId === 'constructor') continue;
    if (!AGENT_CLI_ENV_KEYS.has(agentId)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    if (obj.apiKeyOverride === true) {
      result[agentId] = { apiKeyOverride: true };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeLocationId(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9._-]{1,128}$/.test(trimmed) && trimmed !== 'default') {
    return trimmed;
  }
  return fallback;
}

function autoProjectLocationId(pathKey: string): string {
  return `loc_${createHash('sha256').update(pathKey).digest('base64url').slice(0, 16)}`;
}

function validateProjectLocations(raw: unknown): ProjectLocationPrefs[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const result: ProjectLocationPrefs[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.path !== 'string') continue;
    const expanded = expandHomePrefix(obj.path.trim());
    if (!expanded || !path.isAbsolute(expanded)) continue;
    const normalizedPath = path.normalize(expanded);
    const pathKey = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    if (seenPaths.has(pathKey)) continue;
    const id = normalizeLocationId(
      typeof obj.id === 'string' ? obj.id : '',
      autoProjectLocationId(pathKey),
    );
    if (seenIds.has(id)) continue;
    const rawName = typeof obj.name === 'string' ? obj.name.trim() : '';
    result.push({ id, name: rawName || path.basename(normalizedPath) || normalizedPath, path: normalizedPath });
    seenIds.add(id);
    seenPaths.add(pathKey);
  }
  return result;
}

export function agentCliEnvForAgent(
  prefs: AgentCliEnvPrefs | undefined,
  agentId: string,
): Record<string, string> {
  if (!prefs || typeof agentId !== 'string') return {};
  const env = prefs[agentId];
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return { ...env };
}

function normalizeAgentCliEnvPrefs(prefs: AppConfigPrefs): AppConfigPrefs {
  const agentCliEnv = prefs.agentCliEnv;
  if (!agentCliEnv) {
    if (!prefs.agentCliEnvIntent) return prefs;
    const next = { ...prefs };
    delete next.agentCliEnvIntent;
    return next;
  }

  let nextAgentCliEnv = agentCliEnv;
  let changed = false;

  for (const [agentId, keys] of AGENT_CLI_AUTH_ENV_KEYS) {
    const env = nextAgentCliEnv[agentId];
    if (!env) continue;
    const hasBaseUrl = Object.keys(env).some((key) => keys.baseUrl.has(key));
    const hasExplicitApiKeyIntent = prefs.agentCliEnvIntent?.[agentId]?.apiKeyOverride === true;
    if (hasBaseUrl || hasExplicitApiKeyIntent) continue;

    let nextEnv = env;
    for (const authKey of keys.auth) {
      if (!Object.prototype.hasOwnProperty.call(nextEnv, authKey)) continue;
      if (nextEnv === env) nextEnv = { ...env };
      delete nextEnv[authKey];
      changed = true;
    }
    if (nextEnv === env) continue;
    nextAgentCliEnv = { ...nextAgentCliEnv };
    if (Object.keys(nextEnv).length > 0) {
      nextAgentCliEnv[agentId] = nextEnv;
    } else {
      delete nextAgentCliEnv[agentId];
    }
  }

  let nextAgentCliEnvIntent = prefs.agentCliEnvIntent;
  if (nextAgentCliEnvIntent) {
    for (const agentId of Object.keys(nextAgentCliEnvIntent)) {
      if (nextAgentCliEnv[agentId]) continue;
      nextAgentCliEnvIntent = { ...nextAgentCliEnvIntent };
      delete nextAgentCliEnvIntent[agentId];
      changed = true;
    }
  }

  const normalizedAgentCliEnv = Object.keys(nextAgentCliEnv).length > 0 ? nextAgentCliEnv : undefined;
  const normalizedIntent = nextAgentCliEnvIntent && Object.keys(nextAgentCliEnvIntent).length > 0
    ? nextAgentCliEnvIntent
    : undefined;

  if (
    !changed &&
    normalizedAgentCliEnv === prefs.agentCliEnv &&
    normalizedIntent === prefs.agentCliEnvIntent
  ) {
    return prefs;
  }

  const next = { ...prefs };
  if (normalizedAgentCliEnv) {
    next.agentCliEnv = normalizedAgentCliEnv;
  } else {
    delete next.agentCliEnv;
  }
  if (normalizedIntent) {
    next.agentCliEnvIntent = normalizedIntent;
  } else {
    delete next.agentCliEnvIntent;
  }
  return next;
}

function normalizeRetiredAgentPrefs(prefs: AppConfigPrefs): AppConfigPrefs {
  let changed = false;
  let next = prefs;

  if (typeof next.agentId === 'string' && RETIRED_AGENT_IDS.has(next.agentId)) {
    next = { ...next };
    delete next.agentId;
    changed = true;
  }

  if (next.agentModels) {
    let nextAgentModels = next.agentModels;
    for (const agentId of RETIRED_AGENT_IDS) {
      if (!Object.prototype.hasOwnProperty.call(nextAgentModels, agentId)) continue;
      if (nextAgentModels === next.agentModels) nextAgentModels = { ...next.agentModels };
      delete nextAgentModels[agentId];
      changed = true;
    }
    const normalizedAgentModels = Object.keys(nextAgentModels).length > 0 ? nextAgentModels : undefined;
    if (normalizedAgentModels !== next.agentModels) {
      next = next === prefs ? { ...next } : next;
      if (normalizedAgentModels) {
        next.agentModels = normalizedAgentModels;
      } else {
        delete next.agentModels;
      }
    }
  }

  return changed ? next : prefs;
}

function inferAgentCliEnvIntentForExplicitEnvWrite(prefs: AppConfigPrefs): AppConfigPrefs {
  if (!prefs.agentCliEnv) return prefs;
  let nextAgentCliEnvIntent = prefs.agentCliEnvIntent;
  let changed = false;

  for (const [agentId, keys] of AGENT_CLI_AUTH_ENV_KEYS) {
    const env = prefs.agentCliEnv[agentId];
    if (!env) continue;
    const hasBaseUrl = Object.keys(env).some((key) => keys.baseUrl.has(key));
    if (hasBaseUrl) continue;
    const hasAuthKey = Object.keys(env).some((key) => keys.auth.has(key));
    if (!hasAuthKey) continue;
    if (nextAgentCliEnvIntent?.[agentId]?.apiKeyOverride === true) continue;
    nextAgentCliEnvIntent = {
      ...(nextAgentCliEnvIntent ?? {}),
      [agentId]: { apiKeyOverride: true },
    };
    changed = true;
  }

  if (!changed || !nextAgentCliEnvIntent) return prefs;
  return { ...prefs, agentCliEnvIntent: nextAgentCliEnvIntent };
}

function applyConfigValue(
  target: Record<string, unknown>,
  key: keyof AppConfigPrefs,
  value: unknown,
): void {
  if (key === 'onboardingCompleted') {
    if (typeof value === 'boolean') target[key] = value;
    return;
  }
  if (key === 'agentId' || key === 'skillId') {
    if (typeof value === 'string' || value === null) target[key] = value;
    return;
  }
  if (key === 'agentModels') {
    const validated = validateAgentModels(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'agentCliEnv') {
    const validated = validateAgentCliEnv(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'agentCliEnvIntent') {
    const validated = validateAgentCliEnvIntent(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'disabledSkills') {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      target[key] = value;
    } else {
      delete target[key];
    }
  }
  if (key === 'customInstructions') {
    if (typeof value === 'string') {
      target[key] = value.slice(0, 5000);
    } else if (value === null) {
      target[key] = value;
    }
    return;
  }
  if (key === 'projectLocations') {
    const validated = validateProjectLocations(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
    return;
  }
  if (key === 'defaultProjectLocationId') {
    if (typeof value === 'string') {
      target[key] = normalizeLocationId(value, 'default');
    } else if (value === null) {
      target[key] = null;
    } else {
      delete target[key];
    }
    return;
  }
  if (key === 'recentLinkedDirs') {
    if (Array.isArray(value)) {
      // Keep non-empty strings, trim, de-dupe preserving most-recent-first
      // order, and cap the list. Path existence/safety is enforced later by
      // validateLinkedDirs when the dir is actually attached to a project, so
      // a folder that was since deleted simply drops out at use time rather
      // than corrupting the whole config write here.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
        if (cleaned.length >= RECENT_LINKED_DIRS_MAX) break;
      }
      target[key] = cleaned;
    } else {
      delete target[key];
    }
    return;
  }
}

function filterAllowedKeys(obj: Record<string, unknown>): AppConfigPrefs {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (ALLOWED_KEYS.has(key as keyof AppConfigPrefs)) {
      applyConfigValue(result, key as keyof AppConfigPrefs, obj[key]);
    }
  }
  return normalizeRetiredAgentPrefs(normalizeAgentCliEnvPrefs(result as AppConfigPrefs));
}

export async function readAppConfig(dataDir: string): Promise<AppConfigPrefs> {
  return readAppConfigFileOnly(dataDir);
}


async function readAppConfigFileOnly(dataDir: string): Promise<AppConfigPrefs> {
  try {
    const raw = await readFile(configFile(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return filterAllowedKeys(parsed as Record<string, unknown>);
    }
    console.warn('[app-config] Invalid shape in config file, returning empty');
    return {};
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return {};
    if (e.name === 'SyntaxError') {
      console.error('[app-config] Corrupted JSON, returning empty:', e.message);
      return {};
    }
    throw err;
  }
}

// Serialize concurrent writes to the same dataDir so the read-modify-write
// cycle doesn't lose updates when two PUT requests overlap.
const writeLocks = new Map<string, Promise<unknown>>();

export async function writeAppConfig(
  dataDir: string,
  partial: Record<string, unknown>,
): Promise<AppConfigPrefs> {
  const prev = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(() => doWrite(dataDir, partial));
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

async function doWrite(
  dataDir: string,
  partial: Record<string, unknown>,
): Promise<AppConfigPrefs> {
  const existing = await readAppConfig(dataDir);
  const next: Record<string, unknown> = { ...existing };
  for (const key of Object.keys(partial)) {
    if (!ALLOWED_KEYS.has(key as keyof AppConfigPrefs)) continue;
    applyConfigValue(next, key as keyof AppConfigPrefs, partial[key]);
  }
  const nextWithInferredIntent = Object.prototype.hasOwnProperty.call(partial, 'agentCliEnv')
    ? inferAgentCliEnvIntentForExplicitEnvWrite(next as AppConfigPrefs)
    : next as AppConfigPrefs;
  const normalizedNext = normalizeAgentCliEnvPrefs(nextWithInferredIntent);
  const normalizedNextWithoutRetiredAgents = normalizeRetiredAgentPrefs(normalizedNext);
  const file = configFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(normalizedNextWithoutRetiredAgents, null, 2), 'utf8');
  await rename(tmp, file);
  return normalizedNextWithoutRetiredAgents;
}
