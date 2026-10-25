// Per-provider credentials for scientific-data APIs.
//
// The Settings dialog writes API keys here via PUT /api/research/config; the
// daemon persists them to media-config.json and reads them when injecting
// scientific-data credentials into the agent environment. The historical file
// name is retained so existing installations keep their stored keys.
//
// Storage location (precedence high → low):
//   1. OD_MEDIA_CONFIG_DIR=DIR   → <DIR>/media-config.json
//   2. OD_DATA_DIR=DIR           → <DIR>/media-config.json
//   3. (default)                 → <projectRoot>/.od/media-config.json

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RESEARCH_PROVIDERS } from '@open-design/contracts';
import { expandHomePrefix } from '../home-expansion.js';

const PROVIDER_IDS = [
  ...RESEARCH_PROVIDERS.map((p) => p.id),
  'tavily',
  'openai',
  'grok',
];
type ProviderEntry = { apiKey?: string; baseUrl?: string; model?: string };
type ProviderMap = Record<string, ProviderEntry>;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object';
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
}

const ENV_KEYS: Record<string, string[]> = {
  openai: [
    'OD_OPENAI_API_KEY',
    'OPENAI_API_KEY',
    'AZURE_API_KEY',
    'AZURE_OPENAI_API_KEY',
  ],
  grok: ['OD_GROK_API_KEY', 'XAI_API_KEY'],
  tavily: ['OD_TAVILY_API_KEY', 'TAVILY_API_KEY'],
  'materials-project': ['OD_MP_API_KEY', 'MP_API_KEY', 'PMG_MAPI_KEY'],
  openalex: ['OD_OPENALEX_API_KEY', 'OPENALEX_API_KEY'],
  nomad: ['OD_NOMAD_API_TOKEN', 'NOMAD_API_TOKEN'],
  'semantic-scholar': ['OD_S2_API_KEY', 'S2_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY'],
  'springer-nature': ['OD_SPRINGER_API_KEY', 'SPRINGER_API_KEY'],
  elsevier: ['OD_ELSEVIER_API_KEY', 'ELSEVIER_API_KEY'],
  mpds: ['OD_MPDS_KEY', 'MPDS_KEY'],
};

function resolveOverrideDir(raw: string, projectRoot: string): string {
  const expanded = expandHomePrefix(raw);
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(projectRoot, expanded);
}

function envOverrideDir(envName: string, projectRoot: string): string | null {
  const raw = process.env[envName];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? resolveOverrideDir(trimmed, projectRoot) : null;
}

/**
 * Resolve the directory media-config.json actually lives in. Precedence:
 * explicit media-config override > general data dir > default.
 */
export function providerConfigDir(projectRoot: string): string {
  return (
    envOverrideDir('OD_MEDIA_CONFIG_DIR', projectRoot)
    ?? envOverrideDir('OD_DATA_DIR', projectRoot)
    ?? path.join(projectRoot, '.od')
  );
}

function configFile(projectRoot: string): string {
  return path.join(providerConfigDir(projectRoot), 'media-config.json');
}

async function readStoredFile(projectRoot: string): Promise<JsonRecord> {
  try {
    const raw = await readFile(configFile(projectRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return {};
    throw err;
  }
}

async function readStored(projectRoot: string): Promise<ProviderMap> {
  const parsed = await readStoredFile(projectRoot);
  return isRecord(parsed.providers) ? (parsed.providers as ProviderMap) : {};
}

async function writeStored(projectRoot: string, providers: ProviderMap): Promise<void> {
  const file = configFile(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ providers }, null, 2), 'utf8');
}

function readEnvKey(providerId: string): string | null {
  const keys = ENV_KEYS[providerId];
  if (!keys) return null;
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function readNestedString(obj: unknown, keys: string[]): string {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isRecord(cur)) return '';
    cur = cur[key];
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : '';
}

/**
 * Resolve credentials for a provider. Env vars win, then stored config.
 */
export async function resolveProviderConfig(projectRoot: string, providerId: string): Promise<ProviderEntry> {
  const stored = await readStored(projectRoot);
  const entry = stored[providerId] || {};
  const envKey = readEnvKey(providerId);
  return {
    apiKey: envKey || entry.apiKey || '',
    baseUrl: entry.baseUrl || '',
    ...(typeof entry.model === 'string' && entry.model.trim()
      ? { model: entry.model.trim() }
      : {}),
  };
}

/**
 * Read the full config for the GET endpoint. API keys are masked so the
 * frontend can show "••••" + a "configured" indicator without leaking
 * the secret back into the DOM.
 */
export interface MaskedConfigResponse {
  providers: Record<string, { configured: boolean; source: string; apiKeyTail: string; baseUrl: string; model?: string }>;
}

export async function readMaskedConfig(projectRoot: string): Promise<MaskedConfigResponse> {
  const stored = await readStored(projectRoot);
  const providers: MaskedConfigResponse['providers'] = {};
  for (const id of PROVIDER_IDS) {
    const entry = stored[id] || {};
    const envKey = readEnvKey(id);
    const hasStoredKey = typeof entry.apiKey === 'string' && entry.apiKey.length > 0;
    providers[id] = {
      configured: Boolean(envKey || hasStoredKey),
      source: envKey ? 'env' : hasStoredKey ? 'stored' : 'unset',
      apiKeyTail: hasStoredKey && entry.apiKey ? entry.apiKey.slice(-4) : '',
      baseUrl: entry.baseUrl || '',
      ...(typeof entry.model === 'string' && entry.model.trim()
        ? { model: entry.model.trim() }
        : {}),
    };
  }
  return { providers };
}

/**
 * Write the supplied {providerId: {apiKey, baseUrl}} map. Empty
 * apiKey deletes the entry. Unknown provider IDs are ignored. We
 * deliberately replace the whole map rather than merging so the
 * UI's "clear key" affordance just sends an empty string.
 */
export async function writeConfig(projectRoot: string, body: unknown) {
  const incoming = isRecord(body) && isRecord(body.providers) ? body.providers : {};
  const force = Boolean(isRecord(body) && body.force === true);
  const prior = await readStored(projectRoot);
  const next: ProviderMap = {};
  for (const id of PROVIDER_IDS) {
    const entry = incoming[id];
    if (!isRecord(entry)) continue;
    const incomingApiKey =
      typeof entry.apiKey === 'string' && entry.apiKey.trim()
        ? entry.apiKey.trim()
        : '';
    const preserveApiKey = entry.preserveApiKey === true;
    const priorApiKey =
      typeof prior[id]?.apiKey === 'string' && prior[id].apiKey.trim()
        ? prior[id].apiKey.trim()
        : '';
    const apiKey = incomingApiKey || (preserveApiKey ? priorApiKey : '');
    const baseUrl =
      typeof entry.baseUrl === 'string' && entry.baseUrl.trim()
        ? entry.baseUrl.trim()
        : '';
    const model =
      typeof entry.model === 'string' && entry.model.trim()
        ? entry.model.trim()
        : '';
    if (!apiKey && !baseUrl && !model) continue;
    next[id] = {
      apiKey,
      baseUrl,
      ...(model ? { model } : {}),
    };
  }
  if (Object.keys(next).length === 0) {
    const priorIds = Object.keys(prior).filter(
      (id) => prior[id] && (prior[id].apiKey || prior[id].baseUrl),
    );
    if (priorIds.length > 0) {
      if (!force) {
        const err = new Error(
          `refusing to wipe ${priorIds.length} configured provider(s) without force=true: ${priorIds.join(', ')}`,
        ) as Error & { status: number };
        err.status = 409;
        throw err;
      }
      try {
        console.error(
          `[provider-config] WARN: incoming PUT empty, would wipe ${priorIds.length} configured provider(s): ${priorIds.join(', ')}`,
        );
      } catch {
        // best-effort logging only
      }
    }
  }
  await writeStored(projectRoot, next);
  return readMaskedConfig(projectRoot);
}

const RESEARCH_PROVIDER_ENTRIES = RESEARCH_PROVIDERS.filter(
  (p): p is typeof p & { agentEnvVars: string[] } =>
    Array.isArray(p.agentEnvVars) &&
    p.agentEnvVars.length > 0,
);

/**
 * Resolve every configured scientific-data API credential and expand it into
 * the env variables agent code expects (e.g. `{ MP_API_KEY, PMG_MAPI_KEY }`).
 * Values come from `resolveProviderConfig`, so an env-var already present in
 * the daemon process wins over the on-disk Settings value and the result is
 * idempotent (re-exporting the same value the child would already inherit).
 * Providers without a stored/env credential are skipped so we never overwrite
 * an inherited variable with an empty string. Never logs values.
 */
export async function resolveResearchApiAgentEnv(
  projectRoot: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const provider of RESEARCH_PROVIDER_ENTRIES) {
    let apiKey = '';
    try {
      apiKey = (await resolveProviderConfig(projectRoot, provider.id)).apiKey ?? '';
    } catch {
      apiKey = '';
    }
    if (!apiKey) continue;
    for (const envName of provider.agentEnvVars) {
      out[envName] = apiKey;
    }
  }
  return out;
}

/**
 * Names (never values) of the scientific-data API env variables that are
 * currently configured, so the agent runtime prompt can disclose which
 * credentials are available without echoing secrets. Deduplicated, sorted.
 */
export async function listConfiguredResearchApiEnvNames(
  projectRoot: string,
): Promise<string[]> {
  const env = await resolveResearchApiAgentEnv(projectRoot);
  return Object.keys(env).sort();
}
