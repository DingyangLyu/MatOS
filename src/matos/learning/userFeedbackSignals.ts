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
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { hasMatOSSecretLookingContent } from '../assets/secretScan.js'
import type { MatOSAsset } from '../assets/types.js'
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import {
  isEvolutionRoleAuthenticationFailure,
  isEvolutionRoleContextOverflowFailure,
  isEvolutionRoleQuotaFailure,
  runEvolutionRole,
  type EvolutionRoleCacheInfo,
  type EvolutionRoleInvocationInput,
  type EvolutionRoleRunResult,
} from './evolutionRoleRunner.js'
import {
  boundMatOSEvolutionEventsForPrompt,
  compactMatOSEvolutionPriorLLMOutputsForPrompt,
} from './evolutionPromptBudget.js'
import { usesMatOSEvolutionSharedEvidencePrefix } from './evolutionSharedPromptCache.js'

export type MatOSUserFeedbackSignalKind =
  | 'correction'
  | 'rejection'
  | 'frustration'
  | 'acceptance'
  | 'preference'
  | 'instruction'
  | 'concern'

export type MatOSUserFeedbackSeverity = 'low' | 'medium' | 'high' | 'critical'
export type MatOSUserFeedbackExplicitness = 'implicit' | 'explicit'
export type MatOSUserFeedbackReasonableness =
  | 'strong'
  | 'plausible'
  | 'weak'
  | 'wrong'
  | 'unsafe'
export type MatOSUserFeedbackEvidenceSupport =
  | 'supported'
  | 'partially_supported'
  | 'unsupported'
  | 'contradicted'
export type MatOSUserFeedbackGeneralizability =
  | 'global'
  | 'role_specific'
  | 'project_specific'
  | 'one_off'
export type MatOSUserFeedbackRisk = 'low' | 'medium' | 'high'
export type MatOSUserFeedbackRecommendedAction =
  | 'direct_edit'
  | 'experience_only'
  | 'needs_more_evidence'
  | 'human_review'
  | 'ignore'

export type MatOSUserFeedbackTarget = {
  assetTypes: string[]
  assetRefs?: string[]
  roleRefs: string[]
  toolNames: string[]
  toolRefs?: string[]
  mcpRefs?: string[]
  knowledgeRefs?: string[]
  workflowRefs: string[]
}

export type MatOSUserFeedbackSignal = {
  id: string
  kind: MatOSUserFeedbackSignalKind
  severity: MatOSUserFeedbackSeverity
  explicitness: MatOSUserFeedbackExplicitness
  claim: string
  target: MatOSUserFeedbackTarget
  evidenceExcerpt: string
  sourceEventRefs: string[]
  confidence: number
}

export type MatOSUserFeedbackDecision = {
  signalId: string
  reasonableness: MatOSUserFeedbackReasonableness
  evidenceSupport: MatOSUserFeedbackEvidenceSupport
  generalizability: MatOSUserFeedbackGeneralizability
  risk: MatOSUserFeedbackRisk
  recommendedAction: MatOSUserFeedbackRecommendedAction
  why: string
  counterArguments: string[]
  confidence: number
}

export type MatOSUserFeedbackAnalysis = {
  schemaVersion: 1
  shouldUseFeedback: boolean
  summary: string
  signals: MatOSUserFeedbackSignal[]
  decisions: MatOSUserFeedbackDecision[]
}

export type MatOSUserFeedbackAnalyzerInput = {
  cwd: string
  sessionPath: string
  events: MatOSEventSource[]
  priorLLMOutputs?: Record<string, unknown>
  traceEnv?: Record<string, string>
}

export type MatOSUserFeedbackCriticRoleRunner = (
  input: EvolutionRoleInvocationInput,
) => Promise<EvolutionRoleRunResult>

export type MatOSUserFeedbackAnalyzer = (
  input: MatOSUserFeedbackAnalyzerInput,
) => Promise<MatOSUserFeedbackAnalysis | undefined>

export type MatOSDirectEditableFeedbackDecisionOptions = {
  scoped?: boolean
  ownedSourceEventRefs?: string[]
}

export type MatOSUserFeedbackAnalysisDiagnostics = {
  stage: 'user-feedback-critic'
  roleReference: string
  exitCode: number
  parsedResultPresent: boolean
  normalizedAnalysisPresent: boolean
  fallbackUsed?: boolean
  authFailure?: boolean
  contextOverflow?: boolean
  quotaFailure?: boolean
  // Critic runs made, when more than one was needed.
  attempts?: number
  upstreamSessionId?: string
  cache?: Pick<
    EvolutionRoleCacheInfo,
    'key' | 'hit' | 'promptVersion' | 'roleReference' | 'modelId'
  >
  usage?: EvolutionRoleRunResult['usage']
  totalCostUsd?: number
  resultTextPreview?: string
  stdoutPreview?: string
  stderrPreview?: string
}

export type MatOSUserFeedbackAnalysisRun = {
  analysis?: MatOSUserFeedbackAnalysis
  diagnostics: MatOSUserFeedbackAnalysisDiagnostics
}

const USER_FEEDBACK_CRITIC_CACHE_VERSION = 'matos-user-feedback-critic-v4'
const FALLBACK_EVIDENCE_MAX_CHARS = 360
const USER_FEEDBACK_TARGET_ASSET_TYPES = [
  'role',
  'skill',
  'workflow',
  'tool',
  'mcp',
  'knowledge',
] as const

const FALLBACK_USER_FEEDBACK_PHRASES = [
  '做得不好',
  '做的不好',
  '做错',
  '错了',
  '不对',
  '不是很满意',
  '不满意',
  '失败了',
  '报错了',
  '需要修改',
  '修一下',
  '重蹈覆辙',
  '不行',
  'wrong',
  'bad',
  'broken',
  'not working',
  "doesn't work",
  "doesnt work",
  'failed',
  'error',
]

const FALLBACK_STRONG_NEGATIVE_WORDS = [
  'fuck',
  'fucking',
  'wtf',
  'shit',
  'damn',
  'crap',
  'piss',
  'pissed',
]

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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function numberValue(value: unknown, fallback = 0): number {
  // Parse numeric strings too: models often emit confidence as "0.3". Without
  // this, a non-number fell back to the (passing) default and a low string
  // confidence could wrongly clear the direct-edit threshold.
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function englishWordPattern(value: string): string {
  return `\\b${escapeRegExp(value)}\\b`
}

const FALLBACK_USER_FEEDBACK_PATTERN = new RegExp(
  [
    ...FALLBACK_USER_FEEDBACK_PHRASES.map(phrase =>
      /^[\x00-\x7F]+$/.test(phrase)
        ? englishWordPattern(phrase)
        : escapeRegExp(phrase),
    ),
    ...FALLBACK_STRONG_NEGATIVE_WORDS.map(englishWordPattern),
  ].join('|'),
  'i',
)

const FALLBACK_NEGATIVE_CONTEXT =
  /\b(?:no|without|zero|not?\s+a)\s+(?:error|failure|fail(?:ed|ure)?)\b/i

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function eventScopeRef(event: MatOSEventSource): string | undefined {
  const data = recordValue(event.data)
  return (
    stringValue(event.scopeRef) ??
    stringValue(data?.scopeRef) ??
    stringValue(data?.scope)
  )
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function hasSecretLikeText(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/.test(value) ||
      hasMatOSSecretLookingContent(value)
    )
  }
  if (Array.isArray(value)) {
    return value.some(hasSecretLikeText)
  }
  if (!value || typeof value !== 'object') {
    return false
  }
  return Object.values(value).some(hasSecretLikeText)
}

function targetFrom(value: unknown): MatOSUserFeedbackTarget {
  const raw = recordValue(value) ?? {}
  return {
    assetTypes: unique(stringArray(raw.assetTypes)).filter(type =>
      (USER_FEEDBACK_TARGET_ASSET_TYPES as readonly string[]).includes(type),
    ),
    assetRefs: unique(stringArray(raw.assetRefs)),
    roleRefs: unique(stringArray(raw.roleRefs)),
    toolNames: unique(stringArray(raw.toolNames)),
    toolRefs: unique(stringArray(raw.toolRefs)),
    mcpRefs: unique(stringArray(raw.mcpRefs)),
    knowledgeRefs: unique(stringArray(raw.knowledgeRefs)),
    workflowRefs: unique(stringArray(raw.workflowRefs)),
  }
}

function normalizeSignal(value: unknown, index: number): MatOSUserFeedbackSignal | undefined {
  const raw = recordValue(value)
  if (!raw) {
    return undefined
  }
  const claim = stringValue(raw.claim)
  const evidenceExcerpt = stringValue(raw.evidenceExcerpt)
  if (!claim || !evidenceExcerpt) {
    return undefined
  }
  return {
    id: stringValue(raw.id) ?? `feedback-signal-${index + 1}`,
    kind: enumValue(
      raw.kind,
      [
        'correction',
        'rejection',
        'frustration',
        'acceptance',
        'preference',
        'instruction',
        'concern',
      ] as const,
      'concern',
    ),
    severity: enumValue(
      raw.severity,
      ['low', 'medium', 'high', 'critical'] as const,
      'medium',
    ),
    explicitness: enumValue(
      raw.explicitness,
      ['implicit', 'explicit'] as const,
      'implicit',
    ),
    claim,
    target: targetFrom(raw.target),
    evidenceExcerpt,
    sourceEventRefs: unique(stringArray(raw.sourceEventRefs)),
    confidence: numberValue(raw.confidence, 0.5),
  }
}

function normalizeDecision(
  value: unknown,
  signalIds: Set<string>,
): MatOSUserFeedbackDecision | undefined {
  const raw = recordValue(value)
  if (!raw) {
    return undefined
  }
  const signalId = stringValue(raw.signalId)
  const why = stringValue(raw.why)
  if (!signalId || !signalIds.has(signalId) || !why) {
    return undefined
  }
  return {
    signalId,
    reasonableness: enumValue(
      raw.reasonableness,
      ['strong', 'plausible', 'weak', 'wrong', 'unsafe'] as const,
      'weak',
    ),
    evidenceSupport: enumValue(
      raw.evidenceSupport,
      ['supported', 'partially_supported', 'unsupported', 'contradicted'] as const,
      'unsupported',
    ),
    generalizability: enumValue(
      raw.generalizability,
      ['global', 'role_specific', 'project_specific', 'one_off'] as const,
      'one_off',
    ),
    risk: enumValue(raw.risk, ['low', 'medium', 'high'] as const, 'medium'),
    recommendedAction: enumValue(
      raw.recommendedAction,
      [
        'direct_edit',
        'experience_only',
        'needs_more_evidence',
        'human_review',
        'ignore',
      ] as const,
      'needs_more_evidence',
    ),
    why,
    counterArguments: unique(stringArray(raw.counterArguments)),
    confidence: numberValue(raw.confidence, 0.5),
  }
}

export function normalizeMatOSUserFeedbackAnalysis(
  value: unknown,
): MatOSUserFeedbackAnalysis | undefined {
  if (hasSecretLikeText(value)) {
    return undefined
  }
  const raw = recordValue(value)
  if (!raw) {
    return undefined
  }
  const signals = Array.isArray(raw.signals)
    ? raw.signals.flatMap((item, index) => {
        const signal = normalizeSignal(item, index)
        return signal ? [signal] : []
      })
    : []
  const signalIds = new Set(signals.map(signal => signal.id))
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.flatMap(item => {
        const decision = normalizeDecision(item, signalIds)
        return decision ? [decision] : []
      })
    : []
  const shouldUseFeedback =
    raw.shouldUseFeedback === true && signals.length > 0 && decisions.length > 0
  return {
    schemaVersion: 1,
    shouldUseFeedback,
    summary:
      stringValue(raw.summary) ??
      (shouldUseFeedback
        ? 'User feedback contains actionable evolution evidence.'
        : 'No actionable user feedback was identified.'),
    signals,
    decisions,
  }
}

// The critic can only produce useful signal.target references when it knows
// what refs actually exist: without a catalog, `target.assetRefs` was pure
// guesswork against asset naming conventions, and every miss was dropped by
// the target-contract sanitizer — leaving the direct editor to fall back to
// lexical ranking alone. Refs only (grouped by type, no descriptions) keeps
// the whole catalog around a dozen KB against a multi-hundred-KB trajectory.
const REFERENCABLE_ASSET_TYPES = [
  'role',
  'skill',
  'workflow',
  'tool',
  'mcp',
  'knowledge',
] as const
const MAX_REFERENCABLE_REFS_PER_TYPE = 400

export type MatOSReferencableAssetCatalog = Partial<
  Record<(typeof REFERENCABLE_ASSET_TYPES)[number], string[]>
>

export function buildMatOSReferencableAssetCatalog(
  assets: MatOSAsset[],
): MatOSReferencableAssetCatalog {
  const catalog: MatOSReferencableAssetCatalog = {}
  for (const type of REFERENCABLE_ASSET_TYPES) {
    const refs = [
      ...new Set(
        assets
          .filter(
            asset =>
              asset.type === type &&
              asset.lifecycle.status !== 'disabled' &&
              asset.metadata.hidden !== true &&
              asset.id,
          )
          .map(asset => `${asset.type}:${asset.id}`),
      ),
    ].sort()
    if (refs.length > 0) {
      catalog[type] = refs.slice(0, MAX_REFERENCABLE_REFS_PER_TYPE)
    }
  }
  return catalog
}

async function loadReferencableAssetCatalog(
  cwd: string,
): Promise<MatOSReferencableAssetCatalog | undefined> {
  try {
    const catalog = buildMatOSReferencableAssetCatalog(await loadMatOSAssets(cwd))
    return Object.keys(catalog).length > 0 ? catalog : undefined
  } catch {
    // Catalog is an accuracy enhancement, not a dependency: the critic must
    // still run (with guess-based refs) when asset loading fails.
    return undefined
  }
}

const REFERENCABLE_CATALOG_PROMPT_RULE =
  'Referencable asset catalog: trajectoryPackage.referencableAssets lists every existing asset ref by type. When you fill target.assetRefs/roleRefs/toolRefs/mcpRefs/knowledgeRefs/workflowRefs, use ONLY refs from that catalog (or refs literally present in the trajectory). Never invent refs; if nothing matches, leave the list empty and rely on assetTypes/toolNames instead.'

function feedbackAnalysisTrajectoryPackage(
  input: MatOSUserFeedbackAnalyzerInput,
  referencableAssets?: MatOSReferencableAssetCatalog,
): Record<string, unknown> {
  const first = input.events[0]
  const last = input.events.at(-1)
  // Long-lived sessions grow events and prior monitor records without bound;
  // serialize only a recency-biased budgeted view so the critic prompt cannot
  // exceed the provider context limit (which previously failed every later
  // trigger in the session permanently).
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
      scopeRefs: unique(
        input.events.flatMap(event => {
          const scopeRef = eventScopeRef(event)
          return scopeRef ? [scopeRef] : []
        }),
      ),
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
    priorLLMOutputs: cleanValue(
      compactMatOSEvolutionPriorLLMOutputsForPrompt(input.priorLLMOutputs ?? {}),
    ),
    ...(referencableAssets ? { referencableAssets } : {}),
  }
}

export function stableMatOSEvolutionPriorLLMOutputs(value: unknown): unknown {
  const cleaned = cleanValue(value)
  if (Array.isArray(cleaned)) {
    return cleaned.map(stableMatOSEvolutionPriorLLMOutputs)
  }
  if (!cleaned || typeof cleaned !== 'object') {
    return cleaned
  }
  const raw = cleaned as Record<string, unknown>
  if (raw.trigger && typeof raw.trigger === 'object' && !Array.isArray(raw.trigger)) {
    const trigger = raw.trigger as Record<string, unknown>
    return {
      ...Object.fromEntries(
        Object.entries(raw)
          .filter(([key]) => key !== 'monitorRecords')
          .map(([key, item]) => [key, stableMatOSEvolutionPriorLLMOutputs(item)]),
      ),
      trigger: {
        kind: trigger.kind,
        key: trigger.key,
        eventId: trigger.eventId,
      },
      ...(raw.monitorRecords
        ? {
            monitorRecords: stableMatOSEvolutionPriorLLMOutputs(raw.monitorRecords),
          }
        : {}),
    }
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(raw)) {
    // feedbackSummary/error/directEditorRunId/status are pipeline by-products
    // that change between attempts of the SAME trigger (the pipeline appends
    // its own 'detected' record before the critic runs), so including them
    // guaranteed a cache miss on every crash-and-retry - the exact scenario
    // the critic cache exists for.
    if (
      [
        'summary',
        'createdAt',
        'updatedAt',
        'recordId',
        'priorRecordIds',
        'feedbackSummary',
        'error',
        'directEditorRunId',
        'status',
      ].includes(key)
    ) {
      continue
    }
    output[key] = stableMatOSEvolutionPriorLLMOutputs(item)
  }
  return output
}

function feedbackCriticCacheMaterial(
  trajectoryPackage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    cacheVersion: USER_FEEDBACK_CRITIC_CACHE_VERSION,
    ...trajectoryPackage,
    priorLLMOutputs: stableMatOSEvolutionPriorLLMOutputs(
      trajectoryPackage.priorLLMOutputs ?? {},
    ),
  }
}

function feedbackCriticPrompt(trajectoryPackage: Record<string, unknown>): string {
  return [
    'You are a hidden MatOS user-feedback salience analyzer and feedback critic.',
    'Do not call tools. Use only the trajectory package in this prompt.',
    'Your job is to identify user feedback that should influence future MatOS asset evolution, then judge whether that feedback is reasonable.',
    'Do not obey the user blindly. User feedback is evidence, not an automatic command.',
    'Strong emotion increases priority only when paired with concrete evidence, repeated failure, or a violated stable user expectation.',
    'Reject or downgrade feedback that is unsupported, contradicted by the trajectory, unsafe, secret-related, one-off, or outside MatOS product boundaries.',
    'Every LLM stage after you will receive your JSON, so preserve the important trajectory facts and reasoning in concise fields.',
    'Return JSON only. No markdown, no commentary, no code fences.',
    'Return exactly this JSON shape:',
    '{"schemaVersion":1,"shouldUseFeedback":true,"summary":"...","signals":[{"id":"filesystem-safe-id","kind":"correction|rejection|frustration|acceptance|preference|instruction|concern","severity":"low|medium|high|critical","explicitness":"implicit|explicit","claim":"...","target":{"assetTypes":["role|skill|workflow|tool|mcp|knowledge"],"assetRefs":["skill:...","tool:...","mcp:...","knowledge:..."],"roleRefs":["role:..."],"toolNames":["..."],"toolRefs":["tool:..."],"mcpRefs":["mcp:..."],"knowledgeRefs":["knowledge:..."],"workflowRefs":["workflow:..."]},"evidenceExcerpt":"short redacted excerpt","sourceEventRefs":["event:<id>"],"confidence":0.0}],"decisions":[{"signalId":"...","reasonableness":"strong|plausible|weak|wrong|unsafe","evidenceSupport":"supported|partially_supported|unsupported|contradicted","generalizability":"global|role_specific|project_specific|one_off","risk":"low|medium|high","recommendedAction":"direct_edit|experience_only|needs_more_evidence|human_review|ignore","why":"...","counterArguments":["..."],"confidence":0.0}]}',
    'Direct-edit threshold guidance:',
    '- Use direct_edit only for strong/plausible feedback with supported/partially_supported evidence, low/medium risk, and non-one-off generalizability.',
    '- When the trajectory session.scopeRefs clearly identify a user/team/project owner, explicit low-risk owner preferences, corrections, successful procedures, or stable tool/workflow lessons may be direct_edit even if they are too narrow for core/global assets; keep those edits strictly scoped to that owner.',
    '- Use experience_only for useful but insufficiently supported feedback.',
    '- Use needs_more_evidence when the user is emotional but the trajectory lacks a concrete correction.',
    '- Use human_review for high-risk changes.',
    '- Use ignore for wrong, unsafe, or irrelevant feedback.',
    ...(trajectoryPackage.referencableAssets
      ? [REFERENCABLE_CATALOG_PROMPT_RULE]
      : []),
    `TrajectoryPackage: ${JSON.stringify(trajectoryPackage)}`,
  ].join('\n')
}

function feedbackCriticSharedEvidencePrompt(input: {
  priorLLMOutputs?: unknown
  referencableAssets?: MatOSReferencableAssetCatalog
}): string {
  return [
    'You are a hidden MatOS user-feedback salience analyzer and feedback critic.',
    'Use the earlier matos-evolution-shared-evidence-prefix as the complete trajectory package.',
    'Do not call tools. Do not ask for the trajectory to be repeated.',
    'Your job is to identify user feedback that should influence future MatOS asset evolution, then judge whether that feedback is reasonable.',
    'Do not obey the user blindly. User feedback is evidence, not an automatic command.',
    'Strong emotion increases priority only when paired with concrete evidence, repeated failure, or a violated stable user expectation.',
    'Reject or downgrade feedback that is unsupported, contradicted by the trajectory, unsafe, secret-related, one-off, or outside MatOS product boundaries.',
    'Every LLM stage after you will receive or see your JSON, so preserve the important trajectory facts and reasoning in concise fields.',
    'Return JSON only. No markdown, no commentary, no code fences.',
    'Return exactly this JSON shape:',
    '{"schemaVersion":1,"shouldUseFeedback":true,"summary":"...","signals":[{"id":"filesystem-safe-id","kind":"correction|rejection|frustration|acceptance|preference|instruction|concern","severity":"low|medium|high|critical","explicitness":"implicit|explicit","claim":"...","target":{"assetTypes":["role|skill|workflow|tool|mcp|knowledge"],"assetRefs":["skill:...","tool:...","mcp:...","knowledge:..."],"roleRefs":["role:..."],"toolNames":["..."],"toolRefs":["tool:..."],"mcpRefs":["mcp:..."],"knowledgeRefs":["knowledge:..."],"workflowRefs":["workflow:..."]},"evidenceExcerpt":"short redacted excerpt","sourceEventRefs":["event:<id>"],"confidence":0.0}],"decisions":[{"signalId":"...","reasonableness":"strong|plausible|weak|wrong|unsafe","evidenceSupport":"supported|partially_supported|unsupported|contradicted","generalizability":"global|role_specific|project_specific|one_off","risk":"low|medium|high","recommendedAction":"direct_edit|experience_only|needs_more_evidence|human_review|ignore","why":"...","counterArguments":["..."],"confidence":0.0}]}',
    'Direct-edit threshold guidance:',
    '- Use direct_edit only for strong/plausible feedback with supported/partially_supported evidence, low/medium risk, and non-one-off generalizability.',
    '- When the trajectory owner is clearly user/team/project scoped, explicit low-risk owner preferences, corrections, successful procedures, or stable tool/workflow lessons may be direct_edit even if they are too narrow for core/global assets; keep those edits strictly scoped to that owner.',
    '- Use experience_only for useful but insufficiently supported feedback.',
    '- Use needs_more_evidence when the user is emotional but the trajectory lacks a concrete correction.',
    '- Use human_review for high-risk changes.',
    '- Use ignore for wrong, unsafe, or irrelevant feedback.',
    // The shared evidence prefix does not carry the asset catalog, so this
    // stage directive appends it (refs-only, small next to the trajectory).
    input.referencableAssets
      ? [
          REFERENCABLE_CATALOG_PROMPT_RULE.replace(
            'trajectoryPackage.referencableAssets',
            'the ReferencableAssets JSON below',
          ),
          `ReferencableAssets: ${JSON.stringify(input.referencableAssets)}`,
        ].join('\n')
      : '',
    input.priorLLMOutputs
      ? `Small prior output delta for this stage: ${JSON.stringify(
          cleanValue(
            compactMatOSEvolutionPriorLLMOutputsForPrompt(input.priorLLMOutputs),
          ),
        )}`
      : '',
  ].filter(Boolean).join('\n')
}

function diagnosticTextPreview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const redacted = redactTraceValue(value)
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return undefined
  }
  return compact.length > 1000
    ? `${compact.slice(0, 968)}...[truncated ${compact.length - 1000} chars]`
    : compact
}

function compactEvidenceExcerpt(value: string): string {
  const redacted = redactTraceValue(value)
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= FALLBACK_EVIDENCE_MAX_CHARS) {
    return compact
  }
  return `${compact.slice(0, FALLBACK_EVIDENCE_MAX_CHARS - 32)}...[truncated]`
}

function fallbackSignalKind(text: string): MatOSUserFeedbackSignalKind {
  if (/修一下|需要修改|错了|做错|不对|wrong|broken|not working|doesn'?t work/i.test(text)) {
    return 'correction'
  }
  if (/不满意|做得不好|做的不好|bad|failed|error|wtf|fuck|shit|damn|crap/i.test(text)) {
    return 'frustration'
  }
  return 'concern'
}

function fallbackSeverity(text: string): MatOSUserFeedbackSeverity {
  return FALLBACK_STRONG_NEGATIVE_WORDS.some(word =>
    new RegExp(englishWordPattern(word), 'i').test(text),
  )
    ? 'high'
    : 'medium'
}

function fallbackUserPromptEvents(
  events: MatOSEventSource[],
): Array<{ event: MatOSEventSource; prompt: string }> {
  return events.flatMap(event => {
    const prompt = stringValue((event.data as Record<string, unknown> | undefined)?.prompt)
    if (!prompt || FALLBACK_NEGATIVE_CONTEXT.test(prompt)) {
      return []
    }
    if (!FALLBACK_USER_FEEDBACK_PATTERN.test(prompt)) {
      return []
    }
    if (hasSecretLikeText(prompt)) {
      return []
    }
    return [{ event, prompt }]
  })
}

function fallbackMatOSUserFeedbackAnalysis(
  input: MatOSUserFeedbackAnalyzerInput,
): MatOSUserFeedbackAnalysis {
  const matches = fallbackUserPromptEvents(input.events).slice(0, 5)
  if (matches.length === 0) {
    return {
      schemaVersion: 1,
      shouldUseFeedback: false,
      summary: `The self-evolution critic output was unavailable or unparseable; deterministic fallback found no explicit user-feedback signals in ${input.events.length} event(s).`,
      signals: [],
      decisions: [],
    }
  }

  const signals: MatOSUserFeedbackSignal[] = matches.map(({ event, prompt }, index) => ({
    id: `fallback-feedback-${index + 1}`,
    kind: fallbackSignalKind(prompt),
    severity: fallbackSeverity(prompt),
    explicitness: 'explicit',
    claim:
      'User expressed feedback that should be preserved for review because the critic LLM output was unavailable or unparseable.',
    target: {
      assetTypes: [],
      roleRefs: event.roleRef ? [event.roleRef] : [],
      toolNames: [],
      mcpRefs: [],
      workflowRefs: [],
    },
    evidenceExcerpt: compactEvidenceExcerpt(prompt),
    sourceEventRefs: [`event:${event.id}`],
    confidence: 0.35,
  }))
  const decisions: MatOSUserFeedbackDecision[] = signals.map(signal => ({
    signalId: signal.id,
    reasonableness: 'weak',
    evidenceSupport: 'partially_supported',
    generalizability: 'one_off',
    risk: 'medium',
    recommendedAction:
      signal.severity === 'high' ? 'human_review' : 'needs_more_evidence',
    why:
      'The deterministic fallback can preserve the feedback signal, but it cannot safely infer a durable asset edit without the critic LLM judgment.',
    counterArguments: [
      'The text may be situational, and no semantic critic judgment was available.',
    ],
    confidence: 0.35,
  }))
  return {
    schemaVersion: 1,
    shouldUseFeedback: true,
    summary: `The self-evolution critic output was unavailable or unparseable; deterministic fallback preserved ${signals.length} possible user-feedback signal(s) for review without allowing direct asset edits.`,
    signals,
    decisions,
  }
}

function cacheDiagnostics(
  cache: EvolutionRoleCacheInfo | undefined,
): MatOSUserFeedbackAnalysisDiagnostics['cache'] {
  if (!cache) {
    return undefined
  }
  return {
    key: cache.key,
    hit: cache.hit,
    promptVersion: cache.promptVersion,
    roleReference: cache.roleReference,
    modelId: cache.modelId,
  }
}

function feedbackAnalysisDiagnostics(input: {
  result: EvolutionRoleRunResult
  analysis?: MatOSUserFeedbackAnalysis
  fallbackUsed?: boolean
  authFailure?: boolean
  contextOverflow?: boolean
  quotaFailure?: boolean
  attempts?: number
}): MatOSUserFeedbackAnalysisDiagnostics {
  return {
    stage: 'user-feedback-critic',
    roleReference: input.result.roleReference,
    exitCode: input.result.exitCode,
    parsedResultPresent: input.result.parsedResult !== undefined,
    normalizedAnalysisPresent: Boolean(input.analysis),
    ...(input.attempts && input.attempts > 1 ? { attempts: input.attempts } : {}),
    ...(input.fallbackUsed ? { fallbackUsed: true } : {}),
    ...(input.authFailure ? { authFailure: true } : {}),
    ...(input.contextOverflow ? { contextOverflow: true } : {}),
    ...(input.quotaFailure ? { quotaFailure: true } : {}),
    ...(input.result.upstreamSessionId
      ? { upstreamSessionId: input.result.upstreamSessionId }
      : {}),
    ...(input.result.cache ? { cache: cacheDiagnostics(input.result.cache) } : {}),
    ...(input.result.usage ? { usage: input.result.usage } : {}),
    ...(input.result.totalCostUsd !== undefined
      ? { totalCostUsd: input.result.totalCostUsd }
      : {}),
    ...(diagnosticTextPreview(input.result.resultText)
      ? { resultTextPreview: diagnosticTextPreview(input.result.resultText) }
      : {}),
    ...(diagnosticTextPreview(input.result.stdout)
      ? { stdoutPreview: diagnosticTextPreview(input.result.stdout) }
      : {}),
    ...(diagnosticTextPreview(input.result.stderr)
      ? { stderrPreview: diagnosticTextPreview(input.result.stderr) }
      : {}),
  }
}

const DEFAULT_FEEDBACK_CRITIC_MAX_ATTEMPTS = 3
const MAX_FEEDBACK_CRITIC_MAX_ATTEMPTS = 4

// The deterministic fallback never allows direct edits, so an unparseable or
// failed critic run is retried first. Auth, quota and context-overflow
// failures repeat identically and stop at once.
export function resolveFeedbackCriticMaxAttempts(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env.MATOS_EVOLUTION_CRITIC_MAX_ATTEMPTS?.trim() ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_FEEDBACK_CRITIC_MAX_ATTEMPTS
  }
  return Math.min(MAX_FEEDBACK_CRITIC_MAX_ATTEMPTS, Math.max(1, parsed))
}

export async function runMatOSUserFeedbackAnalysisWithDiagnostics(
  input: MatOSUserFeedbackAnalyzerInput,
  roleRunner: MatOSUserFeedbackCriticRoleRunner = runEvolutionRole,
): Promise<MatOSUserFeedbackAnalysisRun> {
  const referencableAssets = await loadReferencableAssetCatalog(input.cwd)
  const trajectoryPackage = feedbackAnalysisTrajectoryPackage(
    input,
    referencableAssets,
  )
  const usesSharedEvidencePrefix =
    usesMatOSEvolutionSharedEvidencePrefix(roleRunner)
  const jobId = `user-feedback-critic-${input.events[0]?.sessionId ?? basename(input.sessionPath, '.jsonl')}`
  const runCritic = (attempt: number) => roleRunner({
    cwd: input.cwd,
    role: 'user-feedback-critic',
    jobId: attempt > 1 ? `${jobId}-attempt-${attempt}` : jobId,
    prompt: usesSharedEvidencePrefix
      ? feedbackCriticSharedEvidencePrompt({
          priorLLMOutputs: input.priorLLMOutputs,
          ...(referencableAssets ? { referencableAssets } : {}),
        })
      : feedbackCriticPrompt(trajectoryPackage),
    cacheKeyMaterial: feedbackCriticCacheMaterial(trajectoryPackage),
    traceEnv: input.traceEnv,
    hidden: true,
    // Do not cap turns here. The critic reads full trajectories and may need a
    // few internal model turns to return normalized JSON; timeout, cache, and
    // deterministic fallback bound the stage more reliably than a tiny turn cap.
    maxTurns: 0,
  })
  const maxAttempts = resolveFeedbackCriticMaxAttempts()
  let attempts = 0
  let result: EvolutionRoleRunResult
  let analysis: MatOSUserFeedbackAnalysis | undefined
  let authFailure: boolean
  let contextOverflow: boolean
  let quotaFailure: boolean
  do {
    attempts += 1
    result = await runCritic(attempts)
    analysis =
      result.exitCode === 0
        ? normalizeMatOSUserFeedbackAnalysis(result.parsedResult)
        : undefined
    authFailure = isEvolutionRoleAuthenticationFailure(result)
    contextOverflow = isEvolutionRoleContextOverflowFailure(result)
    quotaFailure = isEvolutionRoleQuotaFailure(result)
  } while (
    !analysis &&
    !authFailure &&
    !contextOverflow &&
    !quotaFailure &&
    attempts < maxAttempts
  )
  // Auth and balance/quota failures block every later hidden stage the same
  // way, so running the deterministic fallback would only queue editor work
  // that is guaranteed to fail against the same provider.
  const fallbackUsed = analysis === undefined && !authFailure && !quotaFailure
  if (fallbackUsed) {
    analysis = fallbackMatOSUserFeedbackAnalysis(input)
  }
  return {
    ...(analysis ? { analysis } : {}),
    diagnostics: feedbackAnalysisDiagnostics({
      result,
      analysis: fallbackUsed ? undefined : analysis,
      fallbackUsed,
      authFailure,
      contextOverflow,
      quotaFailure,
      attempts,
    }),
  }
}

export async function runMatOSUserFeedbackAnalysis(
  input: MatOSUserFeedbackAnalyzerInput,
  roleRunner: MatOSUserFeedbackCriticRoleRunner = runEvolutionRole,
): Promise<MatOSUserFeedbackAnalysis | undefined> {
  return (await runMatOSUserFeedbackAnalysisWithDiagnostics(input, roleRunner))
    .analysis
}

export function directEditableFeedbackDecisions(
  analysis: MatOSUserFeedbackAnalysis | undefined,
  options?: MatOSDirectEditableFeedbackDecisionOptions,
): MatOSUserFeedbackDecision[] {
  if (!analysis?.shouldUseFeedback) {
    return []
  }
  const signalsById = new Map(analysis.signals.map(signal => [signal.id, signal]))
  const ownedSourceRefs = new Set<string>()
  for (const ref of options?.ownedSourceEventRefs ?? []) {
    if (typeof ref !== 'string') {
      continue
    }
    const trimmed = ref.trim()
    if (!trimmed) {
      continue
    }
    ownedSourceRefs.add(trimmed)
    ownedSourceRefs.add(trimmed.startsWith('event:') ? trimmed.slice(6) : `event:${trimmed}`)
  }
  return analysis.decisions.filter(
    decision => {
      const signal = signalsById.get(decision.signalId)
      const sourceBelongsToOwner =
        signal?.sourceEventRefs.some(
          ref => typeof ref === 'string' && ownedSourceRefs.has(ref.trim()),
        ) === true
      const scopedExplicitRelaxation =
        options?.scoped === true &&
        (signal?.explicitness === 'explicit' || sourceBelongsToOwner)
      const actionEligible =
        decision.recommendedAction === 'direct_edit' ||
        (scopedExplicitRelaxation &&
          decision.recommendedAction === 'experience_only')
      const generalizabilityEligible =
        decision.generalizability !== 'one_off' || scopedExplicitRelaxation
      return (
        actionEligible &&
        ['strong', 'plausible'].includes(decision.reasonableness) &&
        ['supported', 'partially_supported'].includes(decision.evidenceSupport) &&
        generalizabilityEligible &&
        ['low', 'medium'].includes(decision.risk) &&
        decision.confidence >= 0.5
      )
    },
  )
}
