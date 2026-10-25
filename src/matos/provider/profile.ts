import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * DeepSeek provider settings for DeepSeek Harness. A saved profile (from
 * `matos login set` or the web settings) overrides the deployment env.
 */
export type MatOSEnv = Record<string, string | undefined>

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'

export type MatOSProviderValidationStatus = 'untested' | 'validated' | 'failed'

export type MatOSProviderProfile = {
  schemaVersion: 1
  providerType: 'deepseek'
  baseUrl: string
  model: string
  apiKey: string
  status: MatOSProviderValidationStatus
  updatedAt: string
  validatedAt?: string
  lastValidationError?: string
}

export type MatOSProviderStatus = {
  providerType: 'deepseek'
  baseUrl: string
  model: string
  source: 'profile' | 'environment' | 'none'
  status: MatOSProviderValidationStatus
  hasSecret: boolean
  validatedAt?: string
  lastValidationError?: string
}

export type MatOSProviderEnvResolution = {
  /** The base env with the saved provider settings applied. */
  env: MatOSEnv
  status: MatOSProviderStatus
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^['"]|['"]$/g, '').trim()
  return trimmed ? trimmed : undefined
}

export function normalizeDeepSeekBaseUrl(value: string | undefined): string {
  const url = nonEmpty(value) ?? DEFAULT_DEEPSEEK_BASE_URL
  return url.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function matOSProviderProfilePath(env: MatOSEnv = process.env): string {
  const explicit = nonEmpty(env.MATOS_PROVIDER_FILE)
  if (explicit) return explicit
  const root = nonEmpty(env.MATOS_STATE_DIR) ?? nonEmpty(env.MATOS_RUNTIME_DATA_DIR) ?? join(homedir(), '.matos')
  return join(root, 'provider.json')
}

export async function readMatOSProviderProfile(env: MatOSEnv = process.env): Promise<MatOSProviderProfile | undefined> {
  let raw: string
  try {
    raw = await readFile(matOSProviderProfilePath(env), 'utf8')
  } catch {
    return undefined
  }
  const value = JSON.parse(raw) as Partial<MatOSProviderProfile>
  if (value.providerType !== 'deepseek' || typeof value.apiKey !== 'string' || !value.apiKey) return undefined
  return {
    schemaVersion: 1,
    providerType: 'deepseek',
    baseUrl: normalizeDeepSeekBaseUrl(value.baseUrl),
    model: nonEmpty(value.model) ?? DEFAULT_DEEPSEEK_MODEL,
    apiKey: value.apiKey,
    status: value.status === 'validated' || value.status === 'failed' ? value.status : 'untested',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    ...(typeof value.validatedAt === 'string' ? { validatedAt: value.validatedAt } : {}),
    ...(typeof value.lastValidationError === 'string' ? { lastValidationError: value.lastValidationError } : {}),
  }
}

async function writeProfile(env: MatOSEnv, profile: MatOSProviderProfile): Promise<void> {
  const path = matOSProviderProfilePath(env)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function writeMatOSProviderProfile(
  input: { apiKey: string; baseUrl?: string; model?: string },
  env: MatOSEnv = process.env,
): Promise<MatOSProviderProfile> {
  const apiKey = nonEmpty(input.apiKey)
  if (!apiKey) throw new Error('A DeepSeek API key is required')
  const profile: MatOSProviderProfile = {
    schemaVersion: 1,
    providerType: 'deepseek',
    baseUrl: normalizeDeepSeekBaseUrl(input.baseUrl),
    model: nonEmpty(input.model) ?? DEFAULT_DEEPSEEK_MODEL,
    apiKey,
    status: 'untested',
    updatedAt: new Date().toISOString(),
  }
  await writeProfile(env, profile)
  return profile
}

export async function resetMatOSProviderProfile(env: MatOSEnv = process.env): Promise<boolean> {
  const path = matOSProviderProfilePath(env)
  const existed = Boolean(await readMatOSProviderProfile(env))
  await rm(path, { force: true })
  return existed
}

export async function markMatOSProviderValidation(
  result: { ok: boolean; error?: string },
  env: MatOSEnv = process.env,
): Promise<void> {
  const profile = await readMatOSProviderProfile(env)
  if (!profile) return
  const now = new Date().toISOString()
  const { lastValidationError: _previous, ...rest } = profile
  await writeProfile(env, result.ok
    ? { ...rest, status: 'validated', validatedAt: now }
    : { ...rest, status: 'failed', lastValidationError: result.error ?? 'validation failed' })
}

export async function resolveMatOSProviderEnv(input: { env?: MatOSEnv; cwd?: string; scopeRef?: string } = {}): Promise<MatOSProviderEnvResolution> {
  const base = input.env ?? process.env
  const profile = await readMatOSProviderProfile(base)
  if (profile) {
    return {
      env: {
        ...base,
        DEEPSEEK_API_KEY: profile.apiKey,
        DEEPSEEK_BASE_URL: profile.baseUrl,
        MATOS_DSH_MODEL: profile.model,
      },
      status: {
        providerType: 'deepseek', baseUrl: profile.baseUrl, model: profile.model, source: 'profile',
        status: profile.status, hasSecret: true,
        ...(profile.validatedAt ? { validatedAt: profile.validatedAt } : {}),
        ...(profile.lastValidationError ? { lastValidationError: profile.lastValidationError } : {}),
      },
    }
  }
  const key = nonEmpty(base.DEEPSEEK_API_KEY)
  return {
    env: { ...base },
    status: {
      providerType: 'deepseek',
      baseUrl: normalizeDeepSeekBaseUrl(base.DEEPSEEK_BASE_URL),
      model: nonEmpty(base.MATOS_DSH_MODEL) ?? nonEmpty(base.DEEPSEEK_MODEL) ?? DEFAULT_DEEPSEEK_MODEL,
      source: key ? 'environment' : 'none',
      status: 'untested',
      hasSecret: Boolean(key),
    },
  }
}

export function applyMatOSProviderEnvToProcess(env: MatOSEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value
  }
}

/** One minimal Anthropic-compatible request against the configured endpoint. */
export async function validateMatOSProvider(
  settings: { apiKey: string; baseUrl: string; model: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetchImpl(`${normalizeDeepSeekBaseUrl(settings.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        authorization: `Bearer ${settings.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: settings.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.ok) return { ok: true }
    const text = (await response.text().catch(() => '')).slice(0, 300)
    return { ok: false, error: `HTTP ${response.status}${text ? `: ${text}` : ''}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
