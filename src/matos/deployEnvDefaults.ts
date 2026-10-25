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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSEnv } from './runtime/runtimeEnv.js'

export type MatOSDeployEnvDefaultsLoadResult = {
  path: string
  loaded: boolean
  appliedKeys: string[]
}

function stripInlineComment(value: string): string {
  let singleQuoted = false
  let doubleQuoted = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted
      continue
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted
      continue
    }
    if (
      char === '#' &&
      !singleQuoted &&
      !doubleQuoted &&
      (index === 0 || /\s/.test(value[index - 1] ?? ''))
    ) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value.trim()
}

function parseEnvValue(rawValue: string): string {
  const value = stripInlineComment(rawValue.trim())
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
      const inner = value.slice(1, -1)
      if (quote === "'") {
        return inner
      }
      return inner.replace(/\\(["\\$`nrt])/g, (_, escaped: string) => {
        if (escaped === 'n') {
          return '\n'
        }
        if (escaped === 'r') {
          return '\r'
        }
        if (escaped === 't') {
          return '\t'
        }
        return escaped
      })
    }
  }
  return value.replace(/\\([^\n])/g, '$1')
}

function resolveExactEnvAlias(value: string, env: MatOSEnv): string {
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(
    value,
  )
  const key = match?.[1] ?? match?.[2]
  return key && env[key] !== undefined ? env[key] : value
}

export function parseMatOSDeployEnvDefaults(text: string): MatOSEnv {
  const env: MatOSEnv = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      trimmed,
    )
    if (!match) {
      continue
    }
    const [, key, rawValue] = match
    if (!key) {
      continue
    }
    env[key] = resolveExactEnvAlias(parseEnvValue(rawValue ?? ''), env)
  }
  return env
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  )
}

export async function loadMatOSDeployEnvDefaults(input: {
  cwd: string
  env?: MatOSEnv
  envFile?: string
}): Promise<MatOSDeployEnvDefaultsLoadResult> {
  const env = input.env ?? process.env
  const path =
    input.envFile?.trim() ||
    env.MATOS_DEPLOY_ENV_FILE?.trim() ||
    join(input.cwd, '.env.deploy')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      return { path, loaded: false, appliedKeys: [] }
    }
    throw error
  }

  const parsed = parseMatOSDeployEnvDefaults(text)
  const appliedKeys: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined || value === undefined) {
      continue
    }
    env[key] = value
    appliedKeys.push(key)
  }
  return { path, loaded: true, appliedKeys }
}
