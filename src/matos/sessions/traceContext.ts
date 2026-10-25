import { randomUUID } from 'node:crypto'

export const MATOS_TRACE_SCHEMA_VERSION = 1

export type MatOSTraceContext = {
  schemaVersion: 1
  traceId: string
  sessionId?: string
  parentSessionId?: string
  turnId?: string
  userId?: string
  scopeRef?: string
  workspaceId?: string
  runtimeRef?: string
  execution?: string
  roleRef?: string
}

export type MatOSTraceContextInput = Partial<MatOSTraceContext>

const SECRET_KEY_PATTERN =
  /(token|secret|password|api[-_]?key|auth|authorization|credential)/i

// Usage is telemetry, not a credential. Keep this an exact, numeric-only
// allowlist: a string (or a similarly named access_token) remains secret.
const USAGE_COUNTER_KEYS = new Set([
  'input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens',
  'cache_read_input_tokens', 'cache_creation_input_tokens',
  'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
  'ephemeral_1h_input_tokens', 'ephemeral_5m_input_tokens',
])

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function currentUserId(env: NodeJS.ProcessEnv): string | undefined {
  return nonEmpty(env.MATOS_USER_ID) ?? nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME)
}

export function createMatOSTraceContext(input: {
  sessionId: string
  env?: NodeJS.ProcessEnv
  metadata?: MatOSTraceContextInput
}): MatOSTraceContext {
  const env = input.env ?? process.env
  const metadata = input.metadata ?? {}
  return {
    schemaVersion: MATOS_TRACE_SCHEMA_VERSION,
    traceId:
      nonEmpty(metadata.traceId) ??
      nonEmpty(env.MATOS_TRACE_ID) ??
      input.sessionId ??
      randomUUID(),
    sessionId: input.sessionId,
    ...(nonEmpty(metadata.parentSessionId) ??
    nonEmpty(env.MATOS_PARENT_SESSION_ID)
      ? {
          parentSessionId:
            nonEmpty(metadata.parentSessionId) ??
            nonEmpty(env.MATOS_PARENT_SESSION_ID),
        }
      : {}),
    ...(nonEmpty(metadata.turnId) ?? nonEmpty(env.MATOS_TURN_ID)
      ? { turnId: nonEmpty(metadata.turnId) ?? nonEmpty(env.MATOS_TURN_ID) }
      : {}),
    ...(nonEmpty(metadata.userId) ?? currentUserId(env)
      ? { userId: nonEmpty(metadata.userId) ?? currentUserId(env) }
      : {}),
    ...(nonEmpty(metadata.scopeRef) ?? nonEmpty(env.MATOS_SCOPE_ID)
      ? { scopeRef: nonEmpty(metadata.scopeRef) ?? nonEmpty(env.MATOS_SCOPE_ID) }
      : {}),
    ...(nonEmpty(metadata.workspaceId) ?? nonEmpty(env.MATOS_PROJECT_ID)
      ? {
          workspaceId:
            nonEmpty(metadata.workspaceId) ?? nonEmpty(env.MATOS_PROJECT_ID),
        }
      : {}),
    ...(nonEmpty(metadata.runtimeRef) ?? nonEmpty(env.MATOS_RUNTIME_PROFILE_REF)
      ? {
          runtimeRef:
            nonEmpty(metadata.runtimeRef) ??
            nonEmpty(env.MATOS_RUNTIME_PROFILE_REF),
        }
      : {}),
    ...(nonEmpty(metadata.execution) ?? nonEmpty(env.MATOS_EXECUTION)
      ? {
          execution:
            nonEmpty(metadata.execution) ?? nonEmpty(env.MATOS_EXECUTION),
        }
      : {}),
    ...(nonEmpty(metadata.roleRef) ?? nonEmpty(env.MATOS_ROLE_REF)
      ? { roleRef: nonEmpty(metadata.roleRef) ?? nonEmpty(env.MATOS_ROLE_REF) }
      : {}),
  }
}

export function buildMatOSTraceEnv(
  context: MatOSTraceContext,
): Record<string, string> {
  const env: Record<string, string> = {
    MATOS_TRACE_ID: context.traceId,
  }
  if (context.sessionId) {
    env.MATOS_SESSION_ID = context.sessionId
    env.MATOS_PARENT_SESSION_ID = context.sessionId
  } else if (context.parentSessionId) {
    env.MATOS_PARENT_SESSION_ID = context.parentSessionId
  }
  if (context.turnId) env.MATOS_TURN_ID = context.turnId
  if (context.userId) env.MATOS_USER_ID = context.userId
  if (context.scopeRef) env.MATOS_SCOPE_ID = context.scopeRef
  if (context.workspaceId) env.MATOS_PROJECT_ID = context.workspaceId
  if (context.runtimeRef) env.MATOS_RUNTIME_PROFILE_REF = context.runtimeRef
  if (context.execution) env.MATOS_EXECUTION = context.execution
  if (context.roleRef) env.MATOS_ROLE_REF = context.roleRef
  return env
}

export function traceContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MatOSTraceContext | undefined {
  const traceId = nonEmpty(env.MATOS_TRACE_ID)
  if (!traceId) {
    return undefined
  }
  const sessionId =
    nonEmpty(env.MATOS_SESSION_ID) ??
    nonEmpty(env.MATOS_PARENT_SESSION_ID) ??
    traceId
  return createMatOSTraceContext({
    sessionId,
    env,
    metadata: { traceId },
  })
}

// Content-level scrubbers for secrets embedded inside ordinary string values.
// Each entry replaces only the matched secret substring so surrounding prose is
// preserved. Ordered so multi-line PEM blocks are removed before token scans.
const SECRET_CONTENT_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    '[redacted]',
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[redacted]'],
  [/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1[redacted]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/(:\/\/[^/\s:@]+:)[^/\s:@]+@/g, '$1[redacted]@'],
  [
    /(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:orization)?[-_]?token|bearer[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|credential|token)\b["']?\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#]+)/gi,
    '$1[redacted]',
  ],
]

export function scrubSecretsFromString(value: string): string {
  let scrubbed = value
  for (const [pattern, replacement] of SECRET_CONTENT_REPLACEMENTS) {
    scrubbed = scrubbed.replace(pattern, replacement)
  }
  return scrubbed
}

export function redactTraceValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>())
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return scrubSecretsFromString(value)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, seen))
  }

  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const safeCounter = USAGE_COUNTER_KEYS.has(key) &&
      typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
    redacted[key] = SECRET_KEY_PATTERN.test(key) && !safeCounter
      ? '[redacted]'
      : redactValue(item, seen)
  }
  return redacted
}
