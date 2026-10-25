/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildMatOSChildEnv,
  buildMatOSRunInvocation,
  normalizeRoleReference,
} from '../cli/run.js'
import { configureMatOSEnvironment } from '../env.js'
import {
  resolveMatOSProviderEnv,
  type MatOSProviderEnvResolution,
} from '../provider/profile.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import { EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS } from './evolutionRoleSandbox.js'
import { HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS } from './evolutionWorkerDispatch.js'
import { getMatOSDir } from '../project.js'
import { parseRoleJsonResult } from './roleJson.js'
import { accountEvolutionResult } from '../usage/evolutionUsage.js'
import { accountEvolutionRoleSpend } from './evolutionBudgetGate.js'

type SDKMessage = Record<string, unknown>

export type MatOSEvolutionUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  [key: string]: unknown
}

export type MatOSEvolutionModelUsage = Record<string, Record<string, unknown>>

export type MatOSEvolutionSdkResult = {
  resultText?: string
  upstreamSessionId?: string
  isError?: boolean
  usage?: MatOSEvolutionUsage
  modelUsage?: MatOSEvolutionModelUsage
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
}

export type EvolutionRoleInvocationInput = {
  cwd: string
  role: string
  prompt: string
  cacheKeyMaterial?: unknown
  jobId: string
  maxTurns?: number
  extraArgs?: string[]
  traceEnv?: Record<string, string>
  hidden?: boolean
}

export type EvolutionRoleInvocation = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  roleReference: string
  agentArgs: string[]
  /**
   * Files materialized only for this invocation (cli-arg files, long-prompt
   * files). They can hold evolution evidence and must be removed once the run
   * settles; see cleanupEvolutionRoleInvocationFiles.
   */
  cleanupFiles: string[]
}

export type EvolutionRoleRunResult = {
  exitCode: number
  roleReference: string
  /** True when the run was terminated by the role timeout. */
  timedOut?: boolean
  resultText?: string
  parsedResult?: unknown
  stdout: string
  stderr: string
  upstreamSessionId?: string
  usage?: MatOSEvolutionUsage
  modelUsage?: MatOSEvolutionModelUsage
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
  cache?: EvolutionRoleCacheInfo
}

export const EVOLUTION_ROLE_CACHE_PROMPT_VERSION =
  'matos-evolution-role-cache-v1'

export type EvolutionRoleCacheInfo = {
  key: string
  hit: boolean
  path: string
  promptVersion: string
  roleReference: string
  modelId: string
  inputHash: string
}

type EvolutionRoleCacheRecord = {
  schemaVersion: 1
  cache: EvolutionRoleCacheInfo
  result: {
    exitCode: number
    roleReference: string
    resultText?: string
    parsedResult?: unknown
    stdout?: string
    stderr?: string
    upstreamSessionId?: string
    usage?: MatOSEvolutionUsage
    modelUsage?: MatOSEvolutionModelUsage
    totalCostUsd?: number
    durationMs?: number
    durationApiMs?: number
    numTurns?: number
  }
  createdAt: string
}

const CACHEABLE_EVOLUTION_ROLES = new Set([
  'role:user-feedback-critic',
  'role:experience-refiner',
  'role:turn-feedback-classifier',
  // Reused (JSON-only, single-turn) by the repo2asset / paper2asset intake
  // LLM-assist refiner; identical source samples should not re-call the model.
  'role:source-library-architect',
])

const JSON_ONLY_EVOLUTION_ROLES = new Set([
  'role:user-feedback-critic',
  'role:experience-refiner',
  'role:self-evolution-worker',
  'role:turn-feedback-classifier',
])

const FAST_DEFAULT_EVOLUTION_ROLES = new Set([
  'role:user-feedback-critic',
  'role:experience-refiner',
  'role:self-evolution-worker',
  'role:turn-feedback-classifier',
  'role:source-library-architect',
])

export const DEFAULT_EVOLUTION_ROLE_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_EVOLUTION_ROLE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function resolveEvolutionRoleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MATOS_EVOLUTION_ROLE_TIMEOUT_MS
  if (raw === undefined) {
    return DEFAULT_EVOLUTION_ROLE_TIMEOUT_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EVOLUTION_ROLE_TIMEOUT_MS
}

function getAgentEntrypointPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'entrypoints',
    'agent.ts',
  )
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function roleSpecificEvolutionModelEnvName(
  roleReference: string,
): string | undefined {
  switch (roleReference) {
    case 'role:user-feedback-critic':
      return 'MATOS_EVOLUTION_USER_FEEDBACK_CRITIC_MODEL'
    case 'role:experience-refiner':
      return 'MATOS_EVOLUTION_EXPERIENCE_REFINER_MODEL'
    case 'role:turn-feedback-classifier':
      return 'MATOS_EVOLUTION_TURN_CLASSIFIER_MODEL'
    case 'role:source-library-architect':
      return 'MATOS_EVOLUTION_SOURCE_LIBRARY_ARCHITECT_MODEL'
    default:
      return undefined
  }
}

export function resolveEvolutionRoleModelEnv(input: {
  roleReference: string
  env?: Record<string, string | undefined>
  traceEnv?: Record<string, string | undefined>
}): Record<string, string> {
  const env = input.env ?? process.env
  if (nonEmptyEnv(input.traceEnv?.MATOS_DSH_MODEL)) {
    return {}
  }
  const roleSpecificName = roleSpecificEvolutionModelEnvName(input.roleReference)
  const roleSpecific = roleSpecificName
    ? nonEmptyEnv(env[roleSpecificName])
    : undefined
  const explicit =
    roleSpecific ??
    nonEmptyEnv(env.MATOS_EVOLUTION_ROLE_MODEL)
  if (explicit) {
    return { MATOS_DSH_MODEL: explicit }
  }
  if (!FAST_DEFAULT_EVOLUTION_ROLES.has(input.roleReference)) {
    return {}
  }
  const fastModel =
    nonEmptyEnv(env.MATOS_EVOLUTION_FAST_MODEL) ??
    nonEmptyEnv(env.MATOS_EVOLUTION_ROLE_FAST_MODEL)
  return fastModel ? { MATOS_DSH_MODEL: fastModel } : {}
}

function modelOverrideFromEnv(env: Record<string, string>): string | undefined {
  return env.MATOS_DSH_MODEL
}

function modelOverrideFromTraceEnv(
  traceEnv: Record<string, string | undefined> | undefined,
): string | undefined {
  return nonEmptyEnv(traceEnv?.MATOS_DSH_MODEL)
}

function argsContainModelOverride(args: string[] | undefined): boolean {
  return Boolean(
    args?.some(arg => arg === '--model' || arg.startsWith('--model=')),
  )
}

function providerScopeRefFromTraceEnv(
  traceEnv: Record<string, string | undefined> | undefined,
): string | undefined {
  return (
    nonEmptyEnv(traceEnv?.MATOS_SCOPE_REF) ??
    nonEmptyEnv(traceEnv?.MATOS_SCOPE_ID)
  )
}

function usableProviderSecretValue(
  value: string | undefined,
): string | undefined {
  const cleaned = value?.trim().replace(/^['"]|['"]$/g, '') ?? ''
  return cleaned ? cleaned : undefined
}

/**
 * Provider-type-aware "could the stage child authenticate at all" check.
 * Deliberately lenient (presence only): a wrong secret should still run and
 * surface the provider's own auth error, but a definitively missing secret
 * must not cost an LLM role run to discover.
 */
export function usableEvolutionProviderSecret(
  env: Record<string, string | undefined>,
): string | undefined {
  return usableProviderSecretValue(env.DEEPSEEK_API_KEY)
}

/**
 * Scope-aware provider resolution with a deployment-env fallback. A scoped
 * provider profile whose secret store is missing or unreadable resolves to an
 * env without any credential even when the ambient deployment env carries a
 * valid one, because resolveMatOSProviderEnv clears ambient provider keys on
 * the profile path. Hidden stages must prefer a usable deployment credential
 * over a credential-less profile env, mirroring the placeholder-secret
 * fallback that already exists inside resolveMatOSProviderEnv.
 */
export async function resolveEvolutionProviderEnv(input: {
  cwd: string
  traceEnv?: Record<string, string>
  env?: NodeJS.ProcessEnv
}): Promise<MatOSProviderEnvResolution> {
  const baseEnv = { ...(input.env ?? process.env), ...(input.traceEnv ?? {}) }
  return resolveMatOSProviderEnv({ cwd: input.cwd, env: baseEnv })
}

export type MatOSEvolutionProviderPreflight = {
  ok: boolean
  reason?: 'provider_credentials_unavailable'
  providerType: string
  scopeRef: string
  source: 'user' | 'deployment-default'
}

/**
 * Cheap pre-stage credential check for hidden evolution workers. Resolves the
 * same provider env a stage child would run with and reports only presence
 * metadata (never secret values), so a worker can conclude
 * provider_credentials_unavailable without starting any LLM stage.
 */
export async function evolutionProviderCredentialsPreflight(input: {
  cwd: string
  traceEnv?: Record<string, string>
  env?: NodeJS.ProcessEnv
}): Promise<MatOSEvolutionProviderPreflight> {
  const resolution = await resolveEvolutionProviderEnv(input)
  const ok = Boolean(usableEvolutionProviderSecret(resolution.env))
  return {
    ok,
    ...(ok ? {} : { reason: 'provider_credentials_unavailable' as const }),
    providerType: resolution.status.providerType,
    scopeRef: input.traceEnv?.MATOS_SCOPE_REF ?? input.env?.MATOS_SCOPE_REF ?? process.env.MATOS_SCOPE_REF ?? 'user:local',
    source: resolution.status.source === 'profile' ? 'user' : 'deployment-default',
  }
}

function normalizeUsage(value: unknown): MatOSEvolutionUsage | undefined {
  const raw = getObject(value)
  if (!raw) {
    return undefined
  }
  const inputTokens = getNumber(raw.input_tokens)
  const outputTokens = getNumber(raw.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined
  }
  return {
    ...raw,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens:
      getNumber(raw.cache_creation_input_tokens) ?? 0,
    cache_read_input_tokens: getNumber(raw.cache_read_input_tokens) ?? 0,
  }
}

function normalizeModelUsage(value: unknown): MatOSEvolutionModelUsage | undefined {
  const raw = getObject(value)
  if (!raw) {
    return undefined
  }
  const result: MatOSEvolutionModelUsage = {}
  for (const [model, usage] of Object.entries(raw)) {
    const usageObject = getObject(usage)
    if (usageObject) {
      result[model] = usageObject
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function extractEvolutionRoleSdkResult(
  message: SDKMessage,
): MatOSEvolutionSdkResult | undefined {
  if (message.type !== 'result') {
    return undefined
  }
  const usage = normalizeUsage(message.usage)
  const modelUsage = normalizeModelUsage(message.modelUsage)
  return {
    ...(getString(message.result) ? { resultText: getString(message.result) } : {}),
    ...(getString(message.session_id)
      ? { upstreamSessionId: getString(message.session_id) }
      : {}),
    ...(typeof message.is_error === 'boolean'
      ? { isError: message.is_error }
      : {}),
    ...(usage ? { usage } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(getNumber(message.total_cost_usd) !== undefined
      ? { totalCostUsd: getNumber(message.total_cost_usd) }
      : {}),
    ...(getNumber(message.duration_ms) !== undefined
      ? { durationMs: getNumber(message.duration_ms) }
      : {}),
    ...(getNumber(message.duration_api_ms) !== undefined
      ? { durationApiMs: getNumber(message.duration_api_ms) }
      : {}),
    ...(getNumber(message.num_turns) !== undefined
      ? { numTurns: getNumber(message.num_turns) }
      : {}),
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stableValue((value as Record<string, unknown>)[key])
  }
  return output
}

function roleCacheDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'role-run-cache')
}

function roleCachePath(cwd: string, key: string): string {
  return join(roleCacheDir(cwd), `${key}.json`)
}

export function resolveEvolutionRoleCacheTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
  if (raw === undefined) {
    return DEFAULT_EVOLUTION_ROLE_CACHE_TTL_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EVOLUTION_ROLE_CACHE_TTL_MS
}

export function evolutionRoleCacheExpired(
  createdAt: string | undefined,
  ttlMs: number,
): boolean {
  if (!createdAt) {
    return true
  }
  const createdMs = Date.parse(createdAt)
  if (!Number.isFinite(createdMs)) {
    return true
  }
  return Date.now() - createdMs > ttlMs
}

export const EVOLUTION_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000
const roleCacheLastPruneAt = new Map<string, number>()

/**
 * Prune scans read every cache entry (O(N) file reads) and previously ran on
 * every cache write. Throttle the scan per cache directory so steady-state
 * writes stay O(1).
 */
export function shouldPruneEvolutionCacheDir(
  lastPruneAt: Map<string, number>,
  dir: string,
  now: number = Date.now(),
): boolean {
  const last = lastPruneAt.get(dir)
  if (last !== undefined && now - last < EVOLUTION_CACHE_PRUNE_INTERVAL_MS) {
    return false
  }
  lastPruneAt.set(dir, now)
  return true
}

/**
 * Write-then-rename so a concurrent reader (or a crashed writer) can never
 * observe a truncated cache record.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tmpPath, content, 'utf8')
  try {
    await rename(tmpPath, path)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

const EVOLUTION_CACHE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Shared TTL prune for the flat evolution cache dirs (role-run cache and the
 * semantic acceptance cache). Removes `.json` entries past the cache TTL, and
 * also removes `.tmp` residue leaked when a writeFileAtomic writer died
 * between its tmp write and the rename: those names never end in `.json`, so
 * the old prune skipped them forever. The one-day age floor keeps any
 * legitimately in-flight write safe.
 */
export async function pruneEvolutionCacheDirEntries(dir: string): Promise<void> {
  const ttlMs = resolveEvolutionRoleCacheTtlMs()
  const entries = await readdir(dir).catch(() => [])
  await Promise.all(
    entries.map(async entry => {
      const path = join(dir, entry)
      if (entry.endsWith('.tmp')) {
        const info = await stat(path).catch(() => undefined)
        if (
          info?.isFile() &&
          Date.now() - info.mtimeMs > EVOLUTION_CACHE_TMP_MAX_AGE_MS
        ) {
          await rm(path, { force: true }).catch(() => {})
        }
        return
      }
      if (!entry.endsWith('.json')) {
        return
      }
      const info = await stat(path).catch(() => undefined)
      if (!info) {
        return
      }
      const raw = await readFile(path, 'utf8').catch(() => undefined)
      let createdAt: string | undefined
      if (raw) {
        try {
          createdAt = (JSON.parse(raw) as { createdAt?: string }).createdAt
        } catch {
          createdAt = undefined
        }
      }
      if (
        evolutionRoleCacheExpired(
          createdAt ?? new Date(info.mtimeMs).toISOString(),
          ttlMs,
        )
      ) {
        await rm(path, { force: true }).catch(() => {})
      }
    }),
  )
}

async function pruneEvolutionRoleCache(cwd: string): Promise<void> {
  await pruneEvolutionCacheDirEntries(roleCacheDir(cwd))
}

function isCacheableEvolutionRole(roleReference: string): boolean {
  return (
    CACHEABLE_EVOLUTION_ROLES.has(roleReference) &&
    process.env.MATOS_EVOLUTION_ROLE_CACHE !== 'off' &&
    process.env.MATOS_EVOLUTION_ROLE_CACHE !== 'disabled'
  )
}

export function roleModelId(env: Record<string, string | undefined> | undefined): string {
  const source = env ?? process.env
  return source.MATOS_EVOLUTION_ROLE_MODEL || source.MATOS_DSH_MODEL || 'default'
}

export function roleProviderFingerprint(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const source = env ?? process.env
  const baseUrl = source.DEEPSEEK_BASE_URL || ''
  const secret = source.DEEPSEEK_API_KEY || ''
  return {
    provider: 'deepseek',
    baseUrl,
    secretHash: secret ? digest(secret) : '',
  }
}

async function fileFingerprint(path: string): Promise<string> {
  return `file:${digest(await readFile(path))}`
}

async function dirFingerprint(path: string): Promise<string> {
  const root = resolve(path)
  const entries: string[] = []
  async function visit(current: string): Promise<void> {
    const info = await stat(current).catch(() => undefined)
    if (!info) {
      return
    }
    if (info.isDirectory()) {
      const children = await readdir(current).catch(() => [])
      for (const child of children.sort()) {
        await visit(join(current, child))
      }
      return
    }
    if (!info.isFile()) {
      return
    }
    const rel = relative(root, current).replace(/\\/g, '/')
    entries.push(`${rel}:${digest(await readFile(current))}`)
  }
  await visit(root)
  return `dir:${digest(entries.join('\n'))}`
}

async function fingerprintPathArg(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined)
  if (!info) {
    return `missing:${basename(path)}`
  }
  if (info.isDirectory()) {
    return dirFingerprint(path)
  }
  if (info.isFile()) {
    return fileFingerprint(path)
  }
  return `other:${basename(path)}`
}

async function fingerprintAgentArgs(
  args: string[],
  options: { prompt: string; useCacheKeyMaterial: boolean },
): Promise<unknown[]> {
  const pathOptions = new Set([
    '--agents-file',
    '--append-system-prompt-file',
    '--mcp-config',
    '--add-dir',
    '--plugin-dir',
  ])
  const output: unknown[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (options.useCacheKeyMaterial && arg === options.prompt) {
      output.push('prompt:<cache-key-material>')
      continue
    }
    output.push(arg)
    if (!pathOptions.has(arg)) {
      continue
    }
    // Path options can take several values (`--mcp-config a.json b.json`).
    // Every value must be fingerprinted by content, otherwise trailing values
    // enter the key as raw tmp/UUID paths and the cache can never hit.
    while (
      args[index + 1] &&
      !args[index + 1]!.startsWith('--') &&
      args[index + 1] !== options.prompt
    ) {
      const pathArg = args[index + 1]!
      output.push(
        options.useCacheKeyMaterial &&
          arg === '--append-system-prompt-file' &&
          basename(pathArg).startsWith('evolution-prompt-')
          ? 'file:<cache-key-material-prompt>'
          : await fingerprintPathArg(pathArg),
      )
      index += 1
    }
  }
  return output
}

export async function buildEvolutionRoleCacheInfo(input: {
  invocation: EvolutionRoleInvocation
  source: EvolutionRoleInvocationInput
}): Promise<EvolutionRoleCacheInfo | undefined> {
  if (!isCacheableEvolutionRole(input.invocation.roleReference)) {
    return undefined
  }
  const cacheInput = {
    roleReference: input.invocation.roleReference,
    promptHash: digest(
      input.source.cacheKeyMaterial === undefined
        ? input.source.prompt
        : stableJson(input.source.cacheKeyMaterial),
    ),
    maxTurns: input.source.maxTurns ?? 2,
    extraArgs: input.source.extraArgs ?? [],
    hidden: input.source.hidden === true,
    modelId: roleModelId(input.invocation.env),
    provider: roleProviderFingerprint(input.invocation.env),
    agentArgs: await fingerprintAgentArgs(input.invocation.agentArgs, {
      prompt: input.source.prompt,
      useCacheKeyMaterial: input.source.cacheKeyMaterial !== undefined,
    }),
    promptVersion: EVOLUTION_ROLE_CACHE_PROMPT_VERSION,
  }
  const inputHash = digest(stableJson(cacheInput))
  const key = `role-${inputHash.slice(0, 32)}`
  return {
    key,
    hit: false,
    path: join(
      '.matos',
      'evolution',
      'role-run-cache',
      `${key}.json`,
    ).replace(/\\/g, '/'),
    promptVersion: EVOLUTION_ROLE_CACHE_PROMPT_VERSION,
    roleReference: input.invocation.roleReference,
    modelId: cacheInput.modelId,
    inputHash,
  }
}

export async function readCachedEvolutionRoleRun(input: {
  cwd: string
  cache: EvolutionRoleCacheInfo
}): Promise<EvolutionRoleRunResult | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(roleCachePath(input.cwd, input.cache.key), 'utf8'),
    ) as EvolutionRoleCacheRecord
    if (
      raw.schemaVersion !== 1 ||
      raw.cache?.key !== input.cache.key ||
      raw.cache?.promptVersion !== input.cache.promptVersion ||
      raw.cache?.roleReference !== input.cache.roleReference ||
      raw.cache?.modelId !== input.cache.modelId ||
      raw.cache?.inputHash !== input.cache.inputHash ||
      raw.result?.roleReference !== input.cache.roleReference ||
      evolutionRoleCacheExpired(
        raw.createdAt,
        resolveEvolutionRoleCacheTtlMs(),
      )
    ) {
      return undefined
    }
    return {
      exitCode: raw.result.exitCode,
      roleReference: raw.result.roleReference,
      ...(raw.result.resultText ? { resultText: raw.result.resultText } : {}),
      ...(raw.result.parsedResult !== undefined
        ? { parsedResult: raw.result.parsedResult }
        : {}),
      stdout: raw.result.stdout ?? '',
      stderr: raw.result.stderr ?? '',
      ...(raw.result.upstreamSessionId
        ? { upstreamSessionId: raw.result.upstreamSessionId }
        : {}),
      ...(raw.result.usage ? { usage: raw.result.usage } : {}),
      ...(raw.result.modelUsage ? { modelUsage: raw.result.modelUsage } : {}),
      ...(raw.result.totalCostUsd !== undefined
        ? { totalCostUsd: raw.result.totalCostUsd }
        : {}),
      ...(raw.result.durationMs !== undefined
        ? { durationMs: raw.result.durationMs }
        : {}),
      ...(raw.result.durationApiMs !== undefined
        ? { durationApiMs: raw.result.durationApiMs }
        : {}),
      ...(raw.result.numTurns !== undefined
        ? { numTurns: raw.result.numTurns }
        : {}),
      cache: {
        ...raw.cache,
        hit: true,
      },
    }
  } catch {
    return undefined
  }
}

export async function writeCachedEvolutionRoleRun(input: {
  cwd: string
  cache: EvolutionRoleCacheInfo
  result: EvolutionRoleRunResult
}): Promise<void> {
  await mkdir(roleCacheDir(input.cwd), { recursive: true })
  const record: EvolutionRoleCacheRecord = {
    schemaVersion: 1,
    cache: input.cache,
    // Redact before persisting: cached output can echo user secrets/tokens and
    // is written to disk + replayed on later cache hits.
    result: {
      exitCode: input.result.exitCode,
      roleReference: input.result.roleReference,
      ...(input.result.resultText
        ? { resultText: redactTraceValue(input.result.resultText) as string }
        : {}),
      ...(input.result.parsedResult !== undefined
        ? { parsedResult: redactTraceValue(input.result.parsedResult) }
        : {}),
      stdout: redactTraceValue(input.result.stdout.slice(0, 2000)) as string,
      stderr: redactTraceValue(input.result.stderr.slice(0, 2000)) as string,
      ...(input.result.upstreamSessionId
        ? { upstreamSessionId: input.result.upstreamSessionId }
        : {}),
      ...(input.result.usage ? { usage: input.result.usage } : {}),
      ...(input.result.modelUsage ? { modelUsage: input.result.modelUsage } : {}),
      ...(input.result.totalCostUsd !== undefined
        ? { totalCostUsd: input.result.totalCostUsd }
        : {}),
      ...(input.result.durationMs !== undefined
        ? { durationMs: input.result.durationMs }
        : {}),
      ...(input.result.durationApiMs !== undefined
        ? { durationApiMs: input.result.durationApiMs }
        : {}),
      ...(input.result.numTurns !== undefined
        ? { numTurns: input.result.numTurns }
        : {}),
    },
    createdAt: nowIso(),
  }
  await writeFileAtomic(
    roleCachePath(input.cwd, input.cache.key),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  if (shouldPruneEvolutionCacheDir(roleCacheLastPruneAt, roleCacheDir(input.cwd))) {
    await pruneEvolutionRoleCache(input.cwd)
  }
}

function applySdkResult(
  message: SDKMessage,
  state: MatOSEvolutionSdkResult,
): boolean {
  const result = extractEvolutionRoleSdkResult(message)
  if (result) {
    Object.assign(state, result)
    return true
  }
  return false
}

const PROMPT_ARG_LIMIT = 16_000

async function materializeEvolutionPromptFile(
  cwd: string,
  prompt: string,
): Promise<string> {
  const dir = join(getMatOSDir(cwd), 'runtime', 'cli-args')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `evolution-prompt-${randomUUID()}.md`)
  await writeFile(path, prompt, { encoding: 'utf8', mode: 0o600 })
  return path
}

async function materializeLongPromptArgs(
  cwd: string,
  args: string[],
  prompt: string,
): Promise<{ args: string[]; promptFile?: string }> {
  if (prompt.length <= PROMPT_ARG_LIMIT) {
    return { args }
  }
  const promptFile = await materializeEvolutionPromptFile(cwd, prompt)
  const promptIndex = args.lastIndexOf(prompt)
  if (promptIndex < 0) {
    return {
      args: ['--append-system-prompt-file', promptFile, ...args],
      promptFile,
    }
  }
  const next = [...args]
  next[promptIndex] =
    'Use the MatOS evolution task context supplied in the appended system prompt file. Return only the requested JSON.'
  const insertionIndex = Math.max(0, promptIndex - 1)
  next.splice(insertionIndex, 0, '--append-system-prompt-file', promptFile)
  return { args: next, promptFile }
}

/**
 * Best-effort removal of files materialized for a single evolution role
 * invocation (cli-arg files, long-prompt files). They contain evolution
 * evidence/prompt material and must not accumulate under `.matos/runtime`
 * once the run has settled.
 */
export async function cleanupEvolutionRoleInvocationFiles(
  invocation: Pick<EvolutionRoleInvocation, 'cleanupFiles'>,
): Promise<void> {
  await Promise.all(
    invocation.cleanupFiles.map(path =>
      rm(path, { force: true }).catch(() => {}),
    ),
  )
}

/**
 * The env an evolution role process actually runs with (provider profile
 * rewrite plus evolution model routing), for cache fingerprinting. Consumers
 * such as the semantic acceptance judge must derive modelId/provider
 * fingerprints from this env — not from raw process.env — or cached verdicts
 * survive model/provider changes for the full cache TTL.
 */
export async function resolveEvolutionRoleExecutionEnv(input: {
  cwd: string
  roleReference: string
  traceEnv?: Record<string, string>
}): Promise<Record<string, string | undefined>> {
  const roleReference = normalizeRoleReference(input.roleReference)
  const provider = await resolveEvolutionProviderEnv({
    cwd: input.cwd,
    traceEnv: input.traceEnv,
  })
  const roleModelEnv = resolveEvolutionRoleModelEnv({
    roleReference,
    env: provider.env,
    traceEnv: input.traceEnv,
  })
  return {
    ...provider.env,
    ...roleModelEnv,
    ...(input.traceEnv ?? {}),
  }
}

export async function buildEvolutionRoleInvocation(
  input: EvolutionRoleInvocationInput,
): Promise<EvolutionRoleInvocation> {
  const roleReference = normalizeRoleReference(input.role)
  const provider = await resolveEvolutionProviderEnv({
    cwd: input.cwd,
    traceEnv: input.traceEnv,
  })
  const roleModelEnv = resolveEvolutionRoleModelEnv({
    roleReference,
    env: provider.env,
    traceEnv: input.traceEnv,
  })
  const roleModelArg =
    modelOverrideFromTraceEnv(input.traceEnv) ?? modelOverrideFromEnv(roleModelEnv)
  const roleModelArgs =
    roleModelArg && !argsContainModelOverride(input.extraArgs)
      ? ['--model', roleModelArg]
      : []
  const turnLimit = input.maxTurns ?? 2
  const maxTurnArgs = turnLimit > 0 ? ['--max-turns', String(turnLimit)] : []
  const sandboxArgs = JSON_ONLY_EVOLUTION_ROLES.has(roleReference)
    ? [...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS]
    : []
  const run = await buildMatOSRunInvocation(
    [
      '--role',
      roleReference,
      ...sandboxArgs,
      ...roleModelArgs,
      ...(input.extraArgs ?? []),
      input.prompt,
      ...maxTurnArgs,
      '--no-session-persistence',
    ],
    input.cwd,
    input.hidden ? { projectAccessMode: 'internal-hidden' } : undefined,
  )
  const materializedPrompt = await materializeLongPromptArgs(
    input.cwd,
    run.agentArgs,
    input.prompt,
  )
  const agentArgs = materializedPrompt.args
  const env = buildMatOSChildEnv(provider.env as NodeJS.ProcessEnv, {
    ...roleModelEnv,
    ...(input.traceEnv ?? {}),
    MATOS_EVOLUTION_JOB_ID: input.jobId,
    ...(input.hidden
      ? {
          MATOS_INTERNAL_HIDDEN_RUN: '1',
          // Hidden self-evolution workers run inside transaction/permission
          // sandboxes. Generic algorithm telemetry is unrelated to the asset
          // edit and would otherwise create `.matos/algorithms/*` beside the
          // permitted asset roots, making a valid edit look like an escape.
          // The evolution run record remains the authoritative audit trail.
          MATOS_ALGO_TELEMETRY: '0',
          MATOS_ALGO_CAPTURE: '0',
        }
      : {}),
  })
  if (env.NODE_ENV === 'test') {
    delete env.NODE_ENV
  }
  if (input.hidden) {
    // Hidden internal runners are not project members: the member binding a
    // project session exports would re-trip project-member gates inside the
    // stage child and any of its descendants (see
    // HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS). Scope, user, project id,
    // and provider env stay intact for scoped provider resolution.
    for (const key of HIDDEN_EVOLUTION_STRIPPED_PROJECT_ENV_KEYS) {
      delete env[key]
    }
  }

  return {
    command: process.execPath,
    args: [getAgentEntrypointPath(), ...agentArgs],
    cwd: input.cwd,
    env,
    roleReference,
    agentArgs,
    cleanupFiles: [
      ...(run.cliArgFiles ?? []),
      ...(materializedPrompt.promptFile ? [materializedPrompt.promptFile] : []),
    ],
  }
}

const EVOLUTION_ROLE_KILL_GRACE_MS = 5_000
const EVOLUTION_ROLE_RESULT_CLOSE_GRACE_MS = 1_000

export async function runEvolutionRole(
  input: EvolutionRoleInvocationInput,
): Promise<EvolutionRoleRunResult> {
  const invocation = await buildEvolutionRoleInvocation(input)
  try {
    return await runEvolutionRoleInvocation(input, invocation)
  } finally {
    // Success and failure paths both drop the materialized prompt/cli-arg
    // files; they hold evolution evidence and otherwise leak per run.
    await cleanupEvolutionRoleInvocationFiles(invocation)
  }
}

export async function runEvolutionRoleInvocation(
  input: EvolutionRoleInvocationInput,
  invocation: EvolutionRoleInvocation,
): Promise<EvolutionRoleRunResult> {
  const cache = await buildEvolutionRoleCacheInfo({ invocation, source: input })
  if (cache) {
    const cached = await readCachedEvolutionRoleRun({
      cwd: input.cwd,
      cache,
    })
    if (cached) {
      return cached
    }
  }
  const result = await new Promise<EvolutionRoleRunResult>(resolve => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state: MatOSEvolutionSdkResult = {}
    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let resultCloseTimer: ReturnType<typeof setTimeout> | undefined
    // True once the runner starts terminating the child because a valid
    // result message already arrived on a JSON-only role.
    let resultCloseKillRequested = false
    const timeoutMs = resolveEvolutionRoleTimeoutMs()
    let timeout: ReturnType<typeof setTimeout>
    const clearTimers = () => {
      clearTimeout(timeout)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (resultCloseTimer) {
        clearTimeout(resultCloseTimer)
      }
    }
    const resolveFromState = (
      exitCode: number,
      extra?: { timedOut?: boolean },
    ) => {
      resolve({
        exitCode,
        roleReference: invocation.roleReference,
        ...(extra?.timedOut ? { timedOut: true } : {}),
        ...(state.resultText ? { resultText: state.resultText } : {}),
        ...(state.resultText
          ? { parsedResult: parseRoleJsonResult(state.resultText) }
          : {}),
        stdout,
        stderr,
        ...(state.upstreamSessionId
          ? { upstreamSessionId: state.upstreamSessionId }
          : {}),
        ...(state.usage ? { usage: state.usage } : {}),
        ...(state.modelUsage ? { modelUsage: state.modelUsage } : {}),
        ...(state.totalCostUsd !== undefined
          ? { totalCostUsd: state.totalCostUsd }
          : {}),
        ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
        ...(state.durationApiMs !== undefined
          ? { durationApiMs: state.durationApiMs }
          : {}),
        ...(state.numTurns !== undefined ? { numTurns: state.numTurns } : {}),
      })
    }
    const settleFromState = (exitCode: number) => {
      if (settled) {
        return
      }
      settled = true
      clearTimers()
      const trailing = stdoutBuffer.trim()
      if (trailing) {
        try {
          applySdkResult(JSON.parse(trailing) as SDKMessage, state)
        } catch {
          // Non-JSON trailing output is preserved in stdout.
        }
      }
      resolveFromState(exitCode)
    }
    const scheduleJsonOnlyResultClose = () => {
      if (
        !JSON_ONLY_EVOLUTION_ROLES.has(invocation.roleReference) ||
        resultCloseTimer ||
        settled
      ) {
        return
      }
      resultCloseTimer = setTimeout(() => {
        if (settled) {
          return
        }
        resultCloseKillRequested = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => {
          child.kill('SIGKILL')
          settleFromState(state.isError ? 1 : 0)
        }, EVOLUTION_ROLE_KILL_GRACE_MS)
        killTimer.unref?.()
      }, EVOLUTION_ROLE_RESULT_CLOSE_GRACE_MS)
      resultCloseTimer.unref?.()
    }
    timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      clearTimers()
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
      }, EVOLUTION_ROLE_KILL_GRACE_MS)
      killTimer.unref?.()
      // A timed-out run may already have streamed a complete result message
      // (for example when the CLI hangs after emitting it). Keep the parsed
      // result and usage so callers can still diagnose and account the run.
      const trailing = stdoutBuffer.trim()
      if (trailing) {
        try {
          applySdkResult(JSON.parse(trailing) as SDKMessage, state)
        } catch {
          // Non-JSON trailing output is preserved in stdout.
        }
      }
      const timeoutMessage = `evolution role timed out after ${timeoutMs}ms`
      stderr = stderr ? `${stderr}\n${timeoutMessage}` : timeoutMessage
      resolveFromState(1, { timedOut: true })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      const text = String(chunk)
      stdout += text
      stdoutBuffer += text
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }
        try {
          if (applySdkResult(JSON.parse(trimmed) as SDKMessage, state)) {
            scheduleJsonOnlyResultClose()
          }
        } catch {
          // Non-JSON stream output is preserved in stdout for diagnostics.
        }
      }
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('close', code => {
      // When the runner itself killed the child after a valid result message,
      // the SIGTERM-death exit code (null/143) must not overwrite the model
      // outcome: settle from the received result instead.
      if (resultCloseKillRequested) {
        settleFromState(state.isError ? 1 : 0)
        return
      }
      settleFromState(code ?? 1)
    })
    child.on('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimers()
      resolve({
        exitCode: 1,
        roleReference: invocation.roleReference,
        stdout,
        stderr: stderr || error.message,
      })
    })
  })
  if (input.hidden === true) {
    await accountEvolutionResult(input.cwd, invocation.roleReference, result, invocation.env)
    await accountEvolutionRoleSpend(input.cwd, invocation.roleReference, result)
  }
  if (cache) {
    const resultWithCache = {
      ...result,
      cache,
    }
    const hasParsedObject =
      result.parsedResult &&
      typeof result.parsedResult === 'object' &&
      !Array.isArray(result.parsedResult)
    if (result.exitCode === 0 && hasParsedObject) {
      await writeCachedEvolutionRoleRun({
        cwd: input.cwd,
        cache,
        result: resultWithCache,
      })
    }
    return resultWithCache
  }
  return result
}

export function isEvolutionRoleAuthenticationFailure(
  result: Pick<
    EvolutionRoleRunResult,
    'exitCode' | 'resultText' | 'stdout' | 'stderr'
  >,
): boolean {
  // Successful role output may legitimately quote authentication failures from
  // the trajectory it is analyzing. Only inspect error text when the role
  // process itself failed; otherwise evidence such as a remote API 401 becomes a
  // false provider-auth failure and discards a valid critic result.
  if (result.exitCode === 0) {
    return false
  }
  // Do not treat provider 400 invalid_request_error responses as auth failures:
  // context-length overflows also return invalid_request_error, and classifying
  // them as auth skipped the deterministic fallback and permanently failed
  // every later trigger in long sessions with a misleading "could not
  // authenticate" summary.
  if (isEvolutionRoleContextOverflowFailure(result)) {
    return false
  }
  // Balance/quota exhaustion (DeepSeek 402 "Insufficient Balance", OpenAI
  // "exceeded your current quota") is a billing state, not a credential
  // problem. Keep it out of the auth class so operator-facing summaries say
  // what actually needs fixing.
  if (isEvolutionRoleQuotaFailure(result)) {
    return false
  }
  const text = [result.resultText, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
  return /(?:\b401\b|authentication[_ -]?(?:failed|error|fails)|api key[^\n]{0,80}invalid|invalid api key|invalid x-api-key|apikey[^\n]{0,40}invalid)/i.test(
    text,
  )
}

export function isEvolutionRoleQuotaFailure(
  result: Pick<
    EvolutionRoleRunResult,
    'exitCode' | 'resultText' | 'stdout' | 'stderr'
  >,
): boolean {
  if (result.exitCode === 0) {
    return false
  }
  const text = [result.resultText, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
  return /(?:api error:?\s*402\b|\bstatus(?:\s+code)?:?\s*402\b|insufficient[_ ]balance|insufficient_quota|exceeded your current quota|quota[_ -]exceeded|billing[_ -]hard[_ -]limit)/i.test(
    text,
  )
}

export function isEvolutionRoleContextOverflowFailure(
  result: Pick<
    EvolutionRoleRunResult,
    'exitCode' | 'resultText' | 'stdout' | 'stderr'
  >,
): boolean {
  if (result.exitCode === 0) {
    return false
  }
  const text = [result.resultText, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
  return /(?:maximum context length|context[_ -]length[_ -]exceeded|reduce the length of the messages|prompt is too long)/i.test(
    text,
  )
}

export function isEvolutionRoleRateLimitFailure(
  result: Pick<
    EvolutionRoleRunResult,
    'exitCode' | 'resultText' | 'stdout' | 'stderr'
  >,
): boolean {
  // Successful role output may quote rate-limit errors from the trajectory it
  // analyzes; like the auth classifier, only failed runs count.
  if (result.exitCode === 0) {
    return false
  }
  // 429s that report exhausted billing quota are a quota state, not transient
  // throttling; keep them out of the retryable class.
  if (isEvolutionRoleQuotaFailure(result)) {
    return false
  }
  const text = [result.resultText, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
  return /(?:api error:?\s*(?:429|529)\b|\bstatus(?:\s+code)?:?\s*(?:429|529)\b|rate[_ -]?limit(?:ed|[_ -]error)?\b|too many requests|overloaded[_ -]error|\boverloaded\b)/i.test(
    text,
  )
}
