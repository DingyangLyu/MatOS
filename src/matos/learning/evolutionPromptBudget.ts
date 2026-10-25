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

import type { MatOSEventSource } from '../sessions/eventTypes.js'
import type { MatOSSelfEvolutionMonitorRecord } from './evolutionMonitorRecords.js'

// Long-lived MatOS sessions accumulate megabytes of session events and hundreds
// of evolution monitor records. Hidden self-evolution prompts (critic, refiner,
// shared evidence prefix, direct editor context) would otherwise embed all of
// it unbounded, exceed the provider context limit and fail every later
// trigger in that session. These helpers apply a recency-biased budget
// before any evolution payload is serialized into an LLM prompt. They must NOT
// be used for deterministic logic (trigger suppression, generated asset sync,
// owned-event scoping), which still needs the full record set.

export type MatOSEvolutionPromptBudget = {
  /** Per-event serialized cap before its data payload is truncated. */
  maxEventChars: number
  /** Total serialized budget for the trajectory event list. */
  maxTrajectoryChars: number
  /** Maximum prior monitor records included in prompt payloads. */
  maxMonitorRecords: number
  /** Cap for individual text fields inside compact monitor records. */
  maxMonitorRecordFieldChars: number
}

const DEFAULT_MAX_EVENT_CHARS = 6_000
const DEFAULT_MAX_TRAJECTORY_CHARS = 400_000
const DEFAULT_MAX_MONITOR_RECORDS = 30
const DEFAULT_MAX_MONITOR_RECORD_FIELD_CHARS = 400

function positiveEnvNumber(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function resolveMatOSEvolutionPromptBudget(
  env: Record<string, string | undefined> = process.env,
): MatOSEvolutionPromptBudget {
  return {
    maxEventChars: positiveEnvNumber(
      env,
      'MATOS_EVOLUTION_PROMPT_EVENT_CHAR_LIMIT',
      DEFAULT_MAX_EVENT_CHARS,
    ),
    maxTrajectoryChars: positiveEnvNumber(
      env,
      'MATOS_EVOLUTION_PROMPT_TRAJECTORY_CHAR_BUDGET',
      DEFAULT_MAX_TRAJECTORY_CHARS,
    ),
    maxMonitorRecords: positiveEnvNumber(
      env,
      'MATOS_EVOLUTION_PROMPT_MONITOR_RECORD_LIMIT',
      DEFAULT_MAX_MONITOR_RECORDS,
    ),
    maxMonitorRecordFieldChars: positiveEnvNumber(
      env,
      'MATOS_EVOLUTION_PROMPT_MONITOR_RECORD_FIELD_CHAR_LIMIT',
      DEFAULT_MAX_MONITOR_RECORD_FIELD_CHARS,
    ),
  }
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, Math.max(0, max - 24))}...[truncated ${value.length - max} chars]`
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

// Fields preserved verbatim when an oversized event's data payload has to be
// truncated. `prompt` carries the user feedback text the critic exists to
// analyze; scope fields keep owned-event attribution working downstream.
const PRESERVED_EVENT_DATA_FIELDS = ['prompt', 'scopeRef', 'scope'] as const
const PRESERVED_EVENT_DATA_FIELD_CHARS = 2_000

function truncatedEventData(
  data: Record<string, unknown>,
  maxEventChars: number,
): Record<string, unknown> {
  const preview = truncateText(
    (() => {
      try {
        return JSON.stringify(data) ?? ''
      } catch {
        return String(data)
      }
    })(),
    Math.max(500, Math.floor(maxEventChars / 2)),
  )
  const preserved: Record<string, unknown> = {}
  for (const field of PRESERVED_EVENT_DATA_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value.trim()) {
      preserved[field] = truncateText(value, PRESERVED_EVENT_DATA_FIELD_CHARS)
    }
  }
  return {
    ...preserved,
    matosPromptTruncated: true,
    dataPreview: preview,
  }
}

export type MatOSBoundedEvolutionEvents = {
  events: MatOSEventSource[]
  elidedEventCount: number
  truncatedEventCount: number
}

/**
 * Apply the evolution prompt budget to a session event list: oversized event
 * data payloads are truncated to a preview (preserving user prompt text and
 * scope attribution), then the oldest events are elided until the serialized
 * trajectory fits the total budget. Order is preserved; the newest events
 * always survive because triggers reference recent activity.
 */
export function boundMatOSEvolutionEventsForPrompt(
  events: MatOSEventSource[],
  env: Record<string, string | undefined> = process.env,
): MatOSBoundedEvolutionEvents {
  const budget = resolveMatOSEvolutionPromptBudget(env)
  let truncatedEventCount = 0
  const shaped = events.map(event => {
    if (serializedSize(event) <= budget.maxEventChars) {
      return event
    }
    truncatedEventCount += 1
    return {
      ...event,
      data: truncatedEventData(event.data ?? {}, budget.maxEventChars),
    }
  })
  let total = 0
  const kept: MatOSEventSource[] = []
  for (let index = shaped.length - 1; index >= 0; index -= 1) {
    const size = serializedSize(shaped[index]) + 1
    if (kept.length > 0 && total + size > budget.maxTrajectoryChars) {
      break
    }
    total += size
    kept.push(shaped[index]!)
  }
  kept.reverse()
  return {
    events: kept,
    elidedEventCount: shaped.length - kept.length,
    truncatedEventCount,
  }
}

export type MatOSCompactMonitorRecordForPrompt = {
  recordId: string
  triggerKind: string
  triggerKey: string
  status: string
  createdAt: string
  summary: string
  feedbackSummary?: string
  recommendedActions?: string[]
  experienceRefs?: string[]
  directEditorRunId?: string
  error?: string
}

export type MatOSCompactMonitorRecords = {
  records: MatOSCompactMonitorRecordForPrompt[]
  elidedRecordCount: number
}

/**
 * Project prior evolution monitor records into compact prompt payloads. Full
 * records embed complete feedback analyses, LLM diagnostics, and direct-editor
 * run snapshots that grow without bound in long sessions; hidden LLM stages
 * only need the recent decision history.
 */
export function compactMatOSEvolutionMonitorRecordsForPrompt(
  records: MatOSSelfEvolutionMonitorRecord[],
  env: Record<string, string | undefined> = process.env,
): MatOSCompactMonitorRecords {
  const budget = resolveMatOSEvolutionPromptBudget(env)
  const ordered = [...records].sort((a, b) =>
    (a.createdAt || '').localeCompare(b.createdAt || ''),
  )
  const kept = ordered.slice(-budget.maxMonitorRecords)
  const fieldMax = budget.maxMonitorRecordFieldChars
  return {
    records: kept.map(record => {
      const recommendedActions = [
        ...new Set(
          (record.feedbackAnalysis?.decisions ?? [])
            .map(decision => decision.recommendedAction)
            .filter(Boolean),
        ),
      ].slice(0, 5)
      return {
        recordId: record.recordId,
        triggerKind: record.triggerKind,
        triggerKey: record.triggerKey,
        status: record.status,
        createdAt: record.createdAt,
        summary: truncateText(record.summary ?? '', fieldMax),
        ...(record.feedbackAnalysis?.summary
          ? {
              feedbackSummary: truncateText(
                record.feedbackAnalysis.summary,
                fieldMax,
              ),
            }
          : {}),
        ...(recommendedActions.length > 0 ? { recommendedActions } : {}),
        ...(record.experienceRefs?.length
          ? { experienceRefs: record.experienceRefs.slice(0, 5) }
          : {}),
        ...(record.directEditorRunId
          ? { directEditorRunId: record.directEditorRunId }
          : {}),
        ...(record.error ? { error: truncateText(record.error, fieldMax) } : {}),
      }
    }),
    elidedRecordCount: ordered.length - kept.length,
  }
}

/**
 * Compact the `priorLLMOutputs` payload passed to hidden evolution stages.
 * Replaces a full `monitorRecords` array with the compact recent projection
 * while leaving other fields (such as the trigger) untouched.
 */
export function compactMatOSEvolutionPriorLLMOutputsForPrompt(
  priorLLMOutputs: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (
    !priorLLMOutputs ||
    typeof priorLLMOutputs !== 'object' ||
    Array.isArray(priorLLMOutputs)
  ) {
    return priorLLMOutputs
  }
  const raw = priorLLMOutputs as Record<string, unknown>
  if (!Array.isArray(raw.monitorRecords)) {
    return priorLLMOutputs
  }
  const compact = compactMatOSEvolutionMonitorRecordsForPrompt(
    raw.monitorRecords as MatOSSelfEvolutionMonitorRecord[],
    env,
  )
  return {
    ...raw,
    monitorRecords: compact.records,
    ...(compact.elidedRecordCount > 0
      ? { elidedMonitorRecordCount: compact.elidedRecordCount }
      : {}),
  }
}
