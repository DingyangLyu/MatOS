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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = optionalString(value)
    if (string) {
      return string
    }
  }
  return undefined
}

export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return value
  }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

export function parseNestedJsonRecord(value: unknown): Record<string, unknown> | undefined {
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    current = parseJsonMaybe(current)
    if (isRecord(current)) {
      return current
    }
    if (typeof current !== 'string') {
      return undefined
    }
  }
  return undefined
}

export function recordAt(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

export function valueAt(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return current
}
