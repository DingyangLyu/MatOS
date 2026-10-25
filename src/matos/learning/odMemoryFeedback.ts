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

// Open Design memory -> MatOS self-evolution feedback bridge (MatOS side).
//
// The OD web memory panel captures structured user preferences (profile
// facts, reusable rules, explicit "remember this" requests). Those entries
// are strong user-feedback evidence for the always-on self-evolution
// pipeline, but they live in the OD daemon's private markdown store, not in
// a MatOS session transcript, so the session-event trigger classifier never
// sees them.
//
// This module gives that evidence a native ingress:
//   1. append a redacted `matos.feedback.recorded` event into a dedicated
//      per-day bridge session JSONL (so the hidden critic can read the
//      evidence exactly like any other session events), then
//   2. dispatch the standard session-trigger evolution worker with a
//      `user-feedback` trigger keyed by memory id + content hash.
//
// The critic/direct-editor/validation/judge/rollback chain stays untouched:
// whether an entry becomes a knowledge/role/skill asset is still the hidden
// critic's decision, not this bridge's.

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSEvent } from '../sessions/eventTypes.js'
import { resolveMatOSSessionsDir } from '../sessions/sessionPaths.js'
import { createMatOSTraceContext, redactTraceValue } from '../sessions/traceContext.js'
import {
  evolutionWorkerSuppressedByEnv,
  spawnSessionTriggerEvolutionWorker,
} from './evolutionWorkerDispatch.js'
import type { MatOSSelfEvolutionTrigger } from './evolutionMonitor.js'
import { listMatOSSelfEvolutionMonitorRecordLedger } from './evolutionMonitorRecords.js'
import { withMatOSEvolutionOpsFileLock } from './evolutionOpsLedger.js'

export const OD_MEMORY_FEEDBACK_TRIGGER_PREFIX = 'user-feedback:od-memory:'

const MEMORY_TYPES = new Set([
  'profile',
  'user',
  'feedback',
  'project',
  'reference',
  'rule',
])

const EXTRACTION_SOURCES = new Set(['heuristic', 'llm', 'manual', 'connector', 'brand'])

const MAX_TITLE_CHARS = 200
const MAX_DETAIL_CHARS = 4_000

export type MatOSOdMemoryFeedbackInput = {
  cwd: string
  /** OD memory entry id, e.g. `rule_dark_theme_charts`. */
  memoryId: string
  /** OD memory bucket: profile | user | feedback | project | reference | rule. */
  memoryType: string
  /** Entry name/short summary shown in the OD memory panel. */
  title: string
  /** Entry description + body (already concatenated by the caller). */
  detail: string
  /** How OD captured the entry: heuristic | llm | manual | connector | brand. */
  extractionSource?: string
  /** OD conversation id the entry was extracted from, when known. */
  conversationRef?: string
  /** OD project id the entry belongs to, when known. */
  projectRef?: string
  env?: NodeJS.ProcessEnv
}

export type MatOSOdMemoryFeedbackResult = {
  status: 'spawned' | 'duplicate' | 'suppressed' | 'invalid'
  triggerKey?: string
  sessionId?: string
  sessionPath?: string
  eventId?: string
  reason?: string
}

export type MatOSOdMemoryFeedbackDeps = {
  /** Test seam for the detached worker spawn; defaults to the real dispatcher. */
  spawnWorker?: typeof spawnSessionTriggerEvolutionWorker
  now?: () => Date
}

function normalizedString(value: unknown, maxChars: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

function safeMemoryId(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase()
  return /^[a-z0-9_]{1,96}$/.test(trimmed) ? trimmed : undefined
}

function contentHash(input: { memoryId: string; title: string; detail: string }): string {
  return createHash('sha256')
    .update(`${input.memoryId}\u0000${input.title}\u0000${input.detail}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * Stable dedupe key for one memory entry revision. Applies the same
 * whitespace normalization and length caps as `submitMatOSOdMemoryFeedback`
 * so external callers (OD daemon, tests) compute byte-identical keys.
 */
export function odMemoryFeedbackTriggerKey(input: {
  memoryId: string
  title: string
  detail: string
}): string {
  const memoryId = safeMemoryId(input.memoryId) ?? input.memoryId.trim().toLowerCase()
  return `${OD_MEMORY_FEEDBACK_TRIGGER_PREFIX}${memoryId}:${contentHash({
    memoryId,
    title: normalizedString(input.title, MAX_TITLE_CHARS),
    detail: normalizedString(input.detail, MAX_DETAIL_CHARS),
  })}`
}

/** Extract the OD memory id back out of a bridge trigger key, if it is one. */
export function odMemoryIdFromTriggerKey(triggerKey: string): string | undefined {
  if (!triggerKey.startsWith(OD_MEMORY_FEEDBACK_TRIGGER_PREFIX)) {
    return undefined
  }
  const rest = triggerKey.slice(OD_MEMORY_FEEDBACK_TRIGGER_PREFIX.length)
  const separator = rest.lastIndexOf(':')
  const memoryId = separator > 0 ? rest.slice(0, separator) : rest
  return safeMemoryId(memoryId)
}

function bridgeSessionIdForDate(date: Date): string {
  const day = date.toISOString().slice(0, 10)
  return `od-memory-feedback-${day}`
}

async function appendBridgeEvent(input: {
  cwd: string
  sessionId: string
  data: Record<string, unknown>
  env: NodeJS.ProcessEnv
}): Promise<{ sessionPath: string; event: MatOSEvent }> {
  const sessionsDir = resolveMatOSSessionsDir(input.cwd)
  const sessionPath = join(sessionsDir, `${input.sessionId}.jsonl`)
  const traceContext = createMatOSTraceContext({
    sessionId: input.sessionId,
    env: input.env,
    metadata: { execution: 'od-memory-bridge' },
  })
  const event: MatOSEvent = {
    id: randomUUID(),
    schemaVersion: traceContext.schemaVersion,
    traceId: traceContext.traceId,
    sessionId: input.sessionId,
    ...(traceContext.userId ? { userId: traceContext.userId } : {}),
    ...(traceContext.scopeRef ? { scopeRef: traceContext.scopeRef } : {}),
    ...(traceContext.runtimeRef ? { runtimeRef: traceContext.runtimeRef } : {}),
    execution: 'od-memory-bridge',
    timestamp: new Date().toISOString(),
    type: 'matos.feedback.recorded',
    data: redactTraceValue(input.data) as Record<string, unknown>,
  }
  await mkdir(sessionsDir, { recursive: true })
  // All bridge submissions for one UTC day share this JSONL, and concurrent
  // callers (OD daemon batches, parallel MatOS CLIs) can append at the same
  // moment. O_APPEND writes are not atomic across processes on FUSE/NFS
  // filesystems, so serialize appends the same way; a lock timeout falls back to a direct
  // append rather than dropping the evidence.
  await withMatOSEvolutionOpsFileLock(sessionPath, async () => {
    await appendFile(sessionPath, `${JSON.stringify(event)}\n`, 'utf8')
  })
  return { sessionPath, event }
}

async function triggerKeyAlreadyProcessed(
  cwd: string,
  triggerKey: string,
): Promise<boolean> {
  try {
    const records = await listMatOSSelfEvolutionMonitorRecordLedger(cwd)
    return records.some(record => record.triggerKey === triggerKey)
  } catch {
    // Missing/broken monitor ledger must not block new evidence.
    return false
  }
}

/**
 * Record one OD memory entry as user-feedback evidence and dispatch the
 * hidden self-evolution worker for it. Idempotent per memory id + content
 * hash: re-submitting an unchanged entry reports `duplicate` and does not
 * spawn another run.
 */
export async function submitMatOSOdMemoryFeedback(
  input: MatOSOdMemoryFeedbackInput,
  deps: MatOSOdMemoryFeedbackDeps = {},
): Promise<MatOSOdMemoryFeedbackResult> {
  const env = input.env ?? process.env
  const memoryId = safeMemoryId(input.memoryId ?? '')
  const memoryType = String(input.memoryType ?? '').trim().toLowerCase()
  const title = normalizedString(input.title, MAX_TITLE_CHARS)
  const detail = normalizedString(input.detail, MAX_DETAIL_CHARS)
  if (!memoryId) {
    return { status: 'invalid', reason: 'memoryId must match ^[a-z0-9_]{1,96}$' }
  }
  if (!MEMORY_TYPES.has(memoryType)) {
    return {
      status: 'invalid',
      reason: `memoryType must be one of ${[...MEMORY_TYPES].join('|')}`,
    }
  }
  if (!title || !detail) {
    return { status: 'invalid', reason: 'title and detail are required' }
  }
  const extractionSource = String(input.extractionSource ?? '').trim().toLowerCase()
  const triggerKey = odMemoryFeedbackTriggerKey({ memoryId, title, detail })

  if (evolutionWorkerSuppressedByEnv(env)) {
    return { status: 'suppressed', triggerKey, reason: 'self-evolution workers are disabled by env' }
  }
  if (await triggerKeyAlreadyProcessed(input.cwd, triggerKey)) {
    return { status: 'duplicate', triggerKey, reason: 'a monitor record already exists for this content' }
  }

  const now = deps.now?.() ?? new Date()
  const sessionId = bridgeSessionIdForDate(now)
  const { sessionPath, event } = await appendBridgeEvent({
    cwd: input.cwd,
    sessionId,
    env,
    data: {
      source: 'od-memory',
      memoryId,
      memoryType,
      title,
      detail,
      ...(EXTRACTION_SOURCES.has(extractionSource)
        ? { extractionSource }
        : {}),
      ...(input.conversationRef?.trim()
        ? { conversationRef: normalizedString(input.conversationRef, 128) }
        : {}),
      ...(input.projectRef?.trim()
        ? { projectRef: normalizedString(input.projectRef, 128) }
        : {}),
    },
  })

  const trigger: MatOSSelfEvolutionTrigger = {
    kind: 'user-feedback',
    key: triggerKey,
    eventId: event.id,
    summary:
      `Open Design memory captured a user ${memoryType} entry ` +
      `"${title}" (${memoryId}); analyze whether it should update user-scope assets.`,
  }
  const spawnWorker = deps.spawnWorker ?? spawnSessionTriggerEvolutionWorker
  const spawned = spawnWorker({
    cwd: input.cwd,
    sessionId,
    sessionPath,
    trigger,
  })
  return {
    status: spawned ? 'spawned' : 'suppressed',
    triggerKey,
    sessionId,
    sessionPath,
    eventId: event.id,
    ...(spawned ? {} : { reason: 'worker dispatch failed' }),
  }
}
