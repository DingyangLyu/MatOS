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

import { basename } from 'node:path'
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import {
  runEvolutionRole,
  type EvolutionRoleInvocationInput,
  type EvolutionRoleRunResult,
} from './evolutionRoleRunner.js'
import { boundMatOSEvolutionEventsForPrompt } from './evolutionPromptBudget.js'
import { stableMatOSEvolutionPriorLLMOutputs } from './userFeedbackSignals.js'
import { usesMatOSEvolutionSharedEvidencePrefix } from './evolutionSharedPromptCache.js'
import type {
  MatOSExperienceRefinerInput,
  MatOSExperienceRefinerResult,
} from './experienceAssets.js'

export type MatOSExperienceRoleRunner = (
  input: EvolutionRoleInvocationInput,
) => Promise<EvolutionRoleRunResult>

const EXPERIENCE_REFINER_CACHE_VERSION = 'matos-experience-refiner-v2'

type TrajectoryEvent = {
  id: string
  timestamp?: string
  type: string
  roleRef?: string
  turnId?: string
  data: Record<string, unknown>
}

function cleanValue(value: unknown): unknown {
  const redacted = redactTraceValue(value)
  if (Array.isArray(redacted)) {
    return redacted.map(cleanValue)
  }
  if (!redacted || typeof redacted !== 'object') {
    return redacted
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(redacted)) {
    output[key] = cleanValue(item)
  }
  return output
}

function eventForTrajectory(event: MatOSEventSource): TrajectoryEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    ...(event.roleRef ? { roleRef: event.roleRef } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    data: cleanValue(event.data) as Record<string, unknown>,
  }
}

export function buildMatOSExperienceTrajectoryPackage(input: {
  sessionPath: string
  events: MatOSEventSource[]
  feedbackAnalysis?: unknown
}): Record<string, unknown> {
  const first = input.events[0]
  const last = input.events.at(-1)
  // Recency-biased budget: unbounded long-session trajectories previously
  // exceeded the provider context limit and failed the refiner stage outright.
  const bounded = boundMatOSEvolutionEventsForPrompt(
    input.events.filter(event => !event.type.startsWith('matos.learning.')),
  )
  return {
    session: {
      sessionId: first?.sessionId ?? basename(input.sessionPath, '.jsonl'),
      traceId: first?.traceId,
      roleRefs: [
        ...new Set(input.events.map(event => event.roleRef).filter(Boolean)),
      ],
      eventCount: input.events.length,
      firstEventType: first?.type,
      lastEventType: last?.type,
      outcome:
        last?.type === 'matos.session.completed'
          ? 'completed'
          : last?.type === 'matos.session.failed'
            ? 'failed'
            : 'unknown',
      ...(bounded.elidedEventCount > 0
        ? { trajectoryElidedEventCount: bounded.elidedEventCount }
        : {}),
      ...(bounded.truncatedEventCount > 0
        ? { trajectoryTruncatedEventCount: bounded.truncatedEventCount }
        : {}),
    },
    trajectory: bounded.events.map(eventForTrajectory),
    previousLLMOutputs: {
      ...(input.feedbackAnalysis ? { feedbackAnalysis: input.feedbackAnalysis } : {}),
    },
  }
}

export function promptForMatOSExperienceRefiner(input: {
  trajectoryPackage: Record<string, unknown>
}): string {
  return [
    'You are the MatOS experience refiner for a hidden self-evolution run.',
    'Do not call tools. Use only the trajectory package in this prompt.',
    'Your job is to condense the trajectory into a reusable experience asset for future MatOS agents.',
    'Return JSON only. No markdown, no commentary, no code fences.',
    'If there is no reusable experience, return {"shouldWrite":false,"reason":"..."}',
    'If there is reusable experience, return exactly this JSON shape:',
    '{"shouldWrite":true,"id":"filesystem-safe-id","mergeKey":"domain:task:failure","name":"...","summary":"...","scenario":{"domain":"...","taskType":"...","failureMode":"...","appliesWhen":["..."],"doesNotApplyWhen":["..."]},"problemSignals":["..."],"failureModes":[{"name":"...","symptoms":["..."],"rootCause":"...","avoidance":["..."]}],"recommendedActions":["..."],"avoidRepeating":["..."],"checklist":["..."],"targetAssetRefs":["tool:asset-id","mcp:asset-id"],"targetAssetTypes":["tool","mcp"],"directEditRecommended":true,"examples":[{"outcome":"...","excerpt":"short redacted example","errorSummary":"...","recoverySummary":"..."}]}',
    'Quality requirements:',
    '- Explain the background and applicability, not just what happened.',
    '- Include detailed error cases and how to avoid them.',
    '- When a stable lesson clearly belongs in an existing MatOS role, skill, workflow, tool, MCP, or knowledge asset, include targetAssetRefs / targetAssetTypes so the direct editor can route to that asset.',
    '- Treat previousLLMOutputs.feedbackAnalysis as prior LLM critic output. Preserve its useful signal, but do not blindly obey unsupported user feedback.',
    '- Generalize the lesson without overfitting to private user paths or one-off transient ids.',
    '- Do not generate skills, tools, workflows, benchmarks, or promotion proposals.',
    '- Do not include API keys, tokens, passwords, credentials, or raw secret-looking values.',
    '- Do not copy the full raw transcript. Keep examples short.',
    `TrajectoryPackage: ${JSON.stringify(input.trajectoryPackage)}`,
  ].join('\n')
}

export function promptForMatOSExperienceRefinerSharedEvidence(input: {
  feedbackAnalysis?: unknown
}): string {
  return [
    'You are the MatOS experience refiner for a hidden self-evolution run.',
    'Use the earlier matos-evolution-shared-evidence-prefix as the complete trajectory package.',
    'Do not call tools. Do not ask for the trajectory to be repeated.',
    'Your job is to condense the trajectory into a reusable experience asset for future MatOS agents.',
    'Return JSON only. No markdown, no commentary, no code fences.',
    'If there is no reusable experience, return {"shouldWrite":false,"reason":"..."}',
    'If there is reusable experience, return exactly this JSON shape:',
    '{"shouldWrite":true,"id":"filesystem-safe-id","mergeKey":"domain:task:failure","name":"...","summary":"...","scenario":{"domain":"...","taskType":"...","failureMode":"...","appliesWhen":["..."],"doesNotApplyWhen":["..."]},"problemSignals":["..."],"failureModes":[{"name":"...","symptoms":["..."],"rootCause":"...","avoidance":["..."]}],"recommendedActions":["..."],"avoidRepeating":["..."],"checklist":["..."],"targetAssetRefs":["tool:asset-id","mcp:asset-id"],"targetAssetTypes":["tool","mcp"],"directEditRecommended":true,"examples":[{"outcome":"...","excerpt":"short redacted example","errorSummary":"...","recoverySummary":"..."}]}',
    'Quality requirements:',
    '- Explain the background and applicability, not just what happened.',
    '- Include detailed error cases and how to avoid them.',
    '- When a stable lesson clearly belongs in an existing MatOS role, skill, workflow, tool, MCP, or knowledge asset, include targetAssetRefs / targetAssetTypes so the direct editor can route to that asset.',
    '- Treat the critic output from the previous hidden stage as prior LLM critic output. Preserve its useful signal, but do not blindly obey unsupported user feedback.',
    '- Generalize the lesson without overfitting to private user paths or one-off transient ids.',
    '- Do not generate skills, tools, workflows, benchmarks, or promotion proposals.',
    '- Do not include API keys, tokens, passwords, credentials, or raw secret-looking values.',
    '- Do not copy the full raw transcript. Keep examples short.',
    input.feedbackAnalysis
      ? `CriticOutput: ${JSON.stringify(input.feedbackAnalysis)}`
      : '',
  ].filter(Boolean).join('\n')
}

export async function refineMatOSExperienceWithLLM(
  input: MatOSExperienceRefinerInput & {
    roleRunner?: MatOSExperienceRoleRunner
  },
): Promise<MatOSExperienceRefinerResult | undefined> {
  const trajectoryPackage = buildMatOSExperienceTrajectoryPackage({
    sessionPath: input.sessionPath,
    events: input.events,
    feedbackAnalysis: input.feedbackAnalysis,
  })
  const roleRunner = input.roleRunner ?? runEvolutionRole
  const usesSharedEvidencePrefix =
    usesMatOSEvolutionSharedEvidencePrefix(roleRunner)
  const sessionId =
    input.events[0]?.sessionId ?? basename(input.sessionPath, '.jsonl')
  const result = await roleRunner({
    cwd: input.cwd,
    role: 'experience-refiner',
    jobId: `experience-refiner-${sessionId}`,
    prompt: usesSharedEvidencePrefix
      ? promptForMatOSExperienceRefinerSharedEvidence({
          feedbackAnalysis: input.feedbackAnalysis,
        })
      : promptForMatOSExperienceRefiner({ trajectoryPackage }),
    cacheKeyMaterial: {
      cacheVersion: EXPERIENCE_REFINER_CACHE_VERSION,
      trajectoryPackage: {
        ...trajectoryPackage,
        priorLLMOutputs: stableMatOSEvolutionPriorLLMOutputs(
          trajectoryPackage.priorLLMOutputs ?? {},
        ),
      },
    },
    traceEnv: input.traceEnv,
    hidden: true,
    // Do not cap turns here. Refiner inputs can include long trajectories and
    // critic output; timeout and JSON normalization are the correct boundaries.
    maxTurns: 0,
  })
  if (result.exitCode !== 0) {
    return undefined
  }
  const parsed = result.parsedResult
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  return parsed as MatOSExperienceRefinerResult
}
