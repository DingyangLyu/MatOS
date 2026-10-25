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

// Structured tool-error classification recorded at the event SOURCE.
//
// Expected-tool-failure guards and evolution trigger suppression previously
// had to re-derive the error class from rendered error text (JSON scraping +
// regex over `resultPreview`), which silently broke whenever a tool changed
// its error wording. This module classifies the failure once, at recording
// time, from the actual error object / exit info / full (untruncated) result
// text, and stores it as the optional `errorKind` field on
// `matos.tool.call.completed` event data. Readers (see
// evolutionExpectedToolGuards.ts) prefer the structured field and keep the
// legacy text fallback only for records written before this field existed.
//
// This module is intentionally dependency-free so both the DSH host
// (src/matos/host/agentCli.ts) and the MatOS stream mapper
// (src/matos/cli/run.ts) can import it without cycles.

// Well-known classifier outputs. Tools may additionally self-report richer
// embedded kinds (for example `active_task_collision` from the MatOS asset
// tool runner); those pass through verbatim and take precedence, so the field
// is typed as `string` at the event-schema boundary.
export const MATOS_TOOL_ERROR_KINDS = [
  'permission-denied',
  'not-found',
  'timeout',
  'invalid-args',
  'provider-auth',
  'cancelled',
  'unknown',
] as const

export type MatOSToolErrorKind = (typeof MATOS_TOOL_ERROR_KINDS)[number]

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Extract a tool-embedded structured errorKind from one rendered result/error
// text. Exactly mirrors the legacy per-text extraction the expected-tool
// guards perform: JSON payloads carry `errorKind` at the top level or under
// `submissionBlocked`; non-JSON text falls back to a quoted-field regex.
export function matOSEmbeddedToolErrorKindFromText(
  text: string,
): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const nestedBlock =
        record.submissionBlocked &&
        typeof record.submissionBlocked === 'object' &&
        !Array.isArray(record.submissionBlocked)
          ? (record.submissionBlocked as Record<string, unknown>)
          : undefined
      const parsedKind =
        nonEmptyString(record.errorKind) ??
        nonEmptyString(nestedBlock?.errorKind)
      if (parsedKind) {
        return parsedKind
      }
    }
  } catch {
    const match = /["']errorKind["']\s*:\s*["']([^"']+)["']/.exec(text)
    if (match?.[1]) {
      return match[1]
    }
  }
  return undefined
}

const ERRNO_CODE_KINDS: Record<string, MatOSToolErrorKind> = {
  EACCES: 'permission-denied',
  EPERM: 'permission-denied',
  ENOENT: 'not-found',
  ENOTDIR: 'not-found',
  ETIMEDOUT: 'timeout',
  ETIME: 'timeout',
  EINVAL: 'invalid-args',
  ECANCELED: 'cancelled',
  ABORT_ERR: 'cancelled',
}

const ERROR_NAME_KINDS: Record<string, MatOSToolErrorKind> = {
  AbortError: 'cancelled',
  TimeoutError: 'timeout',
  ZodError: 'invalid-args',
  McpAuthError: 'provider-auth',
}

function httpStatusKind(status: number): MatOSToolErrorKind | undefined {
  if (status === 401) {
    return 'provider-auth'
  }
  if (status === 403) {
    return 'permission-denied'
  }
  if (status === 404) {
    return 'not-found'
  }
  if (status === 408 || status === 504) {
    return 'timeout'
  }
  if (status === 400 || status === 422) {
    return 'invalid-args'
  }
  return undefined
}

// Classify from the structured error object (Node errno codes, stable error
// class names, HTTP-ish status fields) before touching any rendered text.
function structuredErrorKind(error: unknown): MatOSToolErrorKind | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }
  const record = error as Record<string, unknown>
  const code = nonEmptyString(record.code)?.toUpperCase()
  if (code && ERRNO_CODE_KINDS[code]) {
    return ERRNO_CODE_KINDS[code]
  }
  const name = nonEmptyString(record.name)
  if (name && ERROR_NAME_KINDS[name]) {
    return ERROR_NAME_KINDS[name]
  }
  for (const key of ['status', 'statusCode'] as const) {
    const status = record[key]
    if (typeof status === 'number' && Number.isInteger(status)) {
      const kind = httpStatusKind(status)
      if (kind) {
        return kind
      }
    }
  }
  return undefined
}

// Ordered: earlier kinds win when one message matches several families
// ("api key not found" is provider-auth, not not-found; "EACCES: permission
// denied, open ..." is permission-denied, not not-found).
const TEXT_PATTERN_KINDS: Array<[MatOSToolErrorKind, RegExp]> = [
  [
    'provider-auth',
    /authentication[_\s-]?(?:error|failed)|invalid\s+(?:x-)?api[-_\s]?key|api[-_\s]?key\s+(?:is\s+)?(?:invalid|missing|expired|not\s+(?:set|found)|required)|\bunauthorized\b|oauth\s+token\s+(?:is\s+)?(?:invalid|expired|missing)|invalid\s+bearer\s+token/i,
  ],
  [
    'permission-denied',
    /permission[_\s-]?denied|\beacces\b|\beperm\b|operation\s+not\s+permitted|access\s+(?:is\s+)?denied|\bforbidden\b/i,
  ],
  [
    'invalid-args',
    /inputvalidationerror|invalid\s+(?:argument|input|param(?:eter)?)s?\b|\beinval\b|validation\s+(?:error|failed)|invalid_request_error/i,
  ],
  [
    'timeout',
    /timed?[\s-]?out\b|\betimedout\b|\btimeout\b|deadline\s+exceeded/i,
  ],
  [
    'not-found',
    /no\s+such\s+file\s+or\s+directory|\benoent\b|\benotdir\b|\bnot\s+found\b|no\s+such\s+tool|unknown\s+tool|does\s+not\s+exist/i,
  ],
  [
    'cancelled',
    /\bcancell?ed\b|\baborted\b|\binterrupted\b/i,
  ],
]

function textPatternKind(text: string): MatOSToolErrorKind | undefined {
  for (const [kind, pattern] of TEXT_PATTERN_KINDS) {
    if (pattern.test(text)) {
      return kind
    }
  }
  return undefined
}

export type MatOSToolErrorKindClassificationInput = {
  // Thrown error object when available, otherwise the rendered error message.
  error?: unknown
  // Full (untruncated) rendered tool result text.
  resultText?: string
  // Structured completion flags already recorded by the tool wrapper.
  interrupted?: boolean
  denied?: boolean
}

// Classify a FAILED tool completion into a structured errorKind.
// Precedence: tool-embedded self-classification (must keep winning so
// expected-failure guards like `active_task_collision` never regress) >
// structured wrapper flags > structured error object info > message/result
// text patterns > 'unknown'.
export function classifyMatOSToolErrorKind(
  input: MatOSToolErrorKindClassificationInput,
): string {
  const errorText =
    typeof input.error === 'string'
      ? nonEmptyString(input.error)
      : nonEmptyString((input.error as { message?: unknown } | undefined)?.message)
  for (const text of [input.resultText, errorText]) {
    const trimmed = nonEmptyString(text)
    if (!trimmed) {
      continue
    }
    const embedded = matOSEmbeddedToolErrorKindFromText(trimmed)
    if (embedded) {
      return embedded
    }
  }
  if (input.denied === true) {
    return 'permission-denied'
  }
  if (input.interrupted === true) {
    return 'cancelled'
  }
  const structured = structuredErrorKind(input.error)
  if (structured) {
    return structured
  }
  for (const text of [errorText, nonEmptyString(input.resultText)]) {
    if (!text) {
      continue
    }
    const kind = textPatternKind(text)
    if (kind) {
      return kind
    }
  }
  return 'unknown'
}

// Enrich a `matos.tool.call.completed` event data payload with a structured
// `errorKind` at recording time. No-op for successful completions and for
// payloads that already carry an errorKind (schema stays backward-compatible:
// the field is optional and legacy readers ignore it).
export function withMatOSToolCompletionErrorKind(
  data: Record<string, unknown>,
  thrownError?: unknown,
): Record<string, unknown> {
  if (data.isError !== true || nonEmptyString(data.errorKind)) {
    return data
  }
  return {
    ...data,
    errorKind: classifyMatOSToolErrorKind({
      error: thrownError ?? data.error,
      resultText: nonEmptyString(data.resultPreview),
      interrupted: data.interrupted === true,
      denied: data.denied === true,
    }),
  }
}
