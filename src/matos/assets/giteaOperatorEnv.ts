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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GITEA_OPERATOR_ENV_KEYS = new Set([
  'MATOS_GITEA_ADMIN_USER',
  'MATOS_GITEA_TOKEN',
  'MATOS_GITEA_TOKEN_FILE',
  'MATOS_GATEWAY_GITEA_TOKEN',
  'MATOS_GATEWAY_GITEA_TOKEN_FILE',
  'MATOS_GITEA_API_URL',
  'MATOS_GITEA_API',
  'MATOS_GITEA_SOURCE_BASE_URL',
  'MATOS_GITEA_BASE_URL',
  'MATOS_GITEA_UPSTREAM',
  'MATOS_GITEA_PUBLIC_BASE_URL',
  'MATOS_OPTIMIZER_REVIEW_OPERATOR',
  'MATOS_OPTIMIZER_REVIEWER_PUBLIC_KEY_FILE',
])

const DEFAULT_WORKSPACE_GITEA_TOKEN_FILES = [
  '/workspace/ipc/matos-gitea.token',
  '/run/matos-gitea/token',
] as const

export const MATOS_GITEA_TOKEN_KEYS = ['MATOS_GITEA_TOKEN', 'MATOS_GATEWAY_GITEA_TOKEN']

function scopedRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.MATOS_USER_ID?.trim() ||
    /^(user|team|project):/.test(env.MATOS_SCOPE_REF?.trim() || env.MATOS_SCOPE_ID?.trim() || '') ||
    env.MATOS_WORKSPACE_DIR?.trim())
}

function hasExplicitValue(keys: string[], env: NodeJS.ProcessEnv): boolean {
  return keys.some(key => Boolean(env[key]?.trim() || env[`${key}_FILE`]?.trim()))
}

function runtimeUser(env: NodeJS.ProcessEnv): string | undefined {
  const user = env.MATOS_USER_ID?.trim()
  if (user) return user.replace(/^user:/, '')
  const scope = env.MATOS_SCOPE_REF?.trim() || env.MATOS_SCOPE_ID?.trim()
  return scope?.startsWith('user:') ? scope.slice(5) : undefined
}

function unquoteShellValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseMatOSGiteaOperatorEnvFile(
  content: string,
): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      continue
    }
    const [, key, rawValue] = match
    if (!key || !GITEA_OPERATOR_ENV_KEYS.has(key)) {
      continue
    }
    parsed[key] = unquoteShellValue(rawValue ?? '')
  }
  return parsed
}

export function matOSGiteaOperatorEnvFileCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (/^(1|true|yes|on)$/i.test(env.MATOS_GITEA_DISABLE_OPERATOR_ENV?.trim() ?? '')) {
    return []
  }
  return [
    env.MATOS_GITEA_OPERATOR_ENV_FILE?.trim(),
    env.MATOS_DEPLOY_ROOT?.trim()
      ? join(env.MATOS_DEPLOY_ROOT.trim(), 'gitea', 'secrets', 'operator.env')
      : undefined,
  ].filter((item): item is string => Boolean(item))
}

export function readMatOSGiteaOperatorEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  for (const candidate of matOSGiteaOperatorEnvFileCandidates(env)) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      return parseMatOSGiteaOperatorEnvFile(readFileSync(candidate, 'utf8'))
    } catch {
      return {}
    }
  }
  return {}
}

function readTokenFile(path: string | undefined): string | undefined {
  const candidate = path?.trim()
  if (!candidate || !existsSync(candidate)) {
    return undefined
  }
  try {
    const value = readFileSync(candidate, 'utf8').trim()
    return value || undefined
  } catch {
    return undefined
  }
}

function envValueOrFile(
  key: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const value = env[key]?.trim()
  if (value) {
    return value
  }
  return readTokenFile(env[`${key}_FILE`])
}

function defaultWorkspaceTokenFileValue(key: string): string | undefined {
  if (key !== 'MATOS_GITEA_TOKEN') {
    return undefined
  }
  for (const candidate of DEFAULT_WORKSPACE_GITEA_TOKEN_FILES) {
    const value = readTokenFile(candidate)
    if (value) {
      return value
    }
  }
  return undefined
}

export function matOSGiteaEnvValue(
  keys: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of keys) {
    const value = envValueOrFile(key, env)
    if (value || env[`${key}_FILE`]?.trim()) return value
  }
  // A private runtime must never acquire deployment-admin authority because
  // its own credential is absent. Non-secret endpoint defaults may still load.
  const credentialLookup = keys.some(key => MATOS_GITEA_TOKEN_KEYS.includes(key))
  if (credentialLookup && scopedRuntime(env)) return matOSScopedGiteaEnvValue(keys, env)
  const operatorEnv = readMatOSGiteaOperatorEnv(env)
  for (const key of keys) {
    const value = envValueOrFile(key, operatorEnv)
    if (value || operatorEnv[`${key}_FILE`]?.trim()) return value
  }
  for (const key of keys) {
    const value = env === process.env ? defaultWorkspaceTokenFileValue(key) : undefined
    if (value) {
      return value
    }
  }
  return undefined
}

/**
 * Resolve only credentials explicitly supplied by the current scoped runtime.
 * Unlike `matOSGiteaEnvValue`, this never reads the deployment operator env;
 * it is the required resolver for community-controlled write paths.
 */
export function matOSScopedGiteaEnvValue(
  keys: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of keys) {
    const value = envValueOrFile(key, env)
    if (value || env[`${key}_FILE`]?.trim()) return value
  }
  if (env === process.env) {
    for (const key of keys) {
      const value = defaultWorkspaceTokenFileValue(key)
      if (value) return value
    }
  }
  return undefined
}

/**
 * Resolve an explicitly supplied operation env first, then fall back to the
 * workspace process env. Self-evolution deliberately passes a narrow env for
 * scope/policy inputs, while the per-user Gitea credential is mounted as a
 * process-level token file. Callers must opt into this fallback explicitly so
 * the default `matOSGiteaEnvValue` isolation semantics remain unchanged.
 */
export function matOSGiteaEnvValueWithProcessFallback(
  keys: string[],
  env?: Record<string, string | undefined>,
): string | undefined {
  if (!env || env === process.env) return matOSGiteaEnvValue(keys)
  if (hasExplicitValue(keys, env)) return matOSScopedGiteaEnvValue(keys, env)
  if (keys.some(key => MATOS_GITEA_TOKEN_KEYS.includes(key))) {
    const requestedUser = runtimeUser(env)
    const ambientUser = runtimeUser(process.env)
    if (requestedUser && ambientUser && requestedUser !== ambientUser) return undefined
    // Apply the caller's scope/disable policy to discovery, not just the first
    // lookup; otherwise falling back silently re-enables operator discovery.
    const effective = { ...process.env, ...env }
    if (scopedRuntime(effective) || /^(1|true|yes|on)$/i.test(effective.MATOS_GITEA_DISABLE_OPERATOR_ENV?.trim() ?? '')) {
      return matOSScopedGiteaEnvValue(keys, effective) ??
        (!hasExplicitValue(keys, effective) && scopedRuntime(process.env)
          ? matOSScopedGiteaEnvValue(keys) : undefined)
    }
  }
  return matOSGiteaEnvValue(keys, env) ?? matOSGiteaEnvValue(keys, { ...process.env, ...env })
}
