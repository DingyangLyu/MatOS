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

import { createHash, randomUUID } from 'node:crypto'
import { preflightEvolutionGiteaSources } from './evolutionGiteaPreflight.js'
import { evolutionInfrastructureFailureCode } from './evolutionInfrastructure.js'
import {
  MATOS_ASSET_BUILDER_TOOL_NAMES,
  MATOS_ASSET_DISCOVERY_TOOL_NAMES,
  MATOS_ROLE_BUILDER_TOOL_NAMES,
  MATOS_WORKFLOW_TOOL_NAMES,
} from '../tools/toolNames.js'
import type { MatOSEvent, MatOSEventSource } from '../sessions/eventTypes.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import { readMatOSSessionEventsFromPath } from '../sessions/sessionIndex.js'
import {
  recoverInterruptedMatOSDirectAssetEditorRuns,
  rebaselineMatOSDirectAssetEditorScope,
  runMatOSDirectAssetEditor,
  type MatOSDirectAssetEditor,
  type MatOSDirectAssetEditorScope,
  type MatOSDirectAssetEditorRebaseline,
  type MatOSDirectAssetEditorRebaselineResult,
  type MatOSDirectAssetEditorRunInput,
  type MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import {
  maintainMatOSExperienceAssetsForWorkflowEvidence,
  maintainMatOSExperienceAssetsForSession,
  type MatOSExperienceRefiner,
} from './experienceAssets.js'
import { refineMatOSExperienceWithLLM } from './experienceRefiner.js'
import {
  buildMatOSEvolutionSharedEvidencePrefix,
  createMatOSEvolutionSharedPromptCacheRunner,
  type MatOSEvolutionSharedPromptCacheRunner,
} from './evolutionSharedPromptCache.js'
import {
  boundMatOSEvolutionEventsForPrompt,
  compactMatOSEvolutionMonitorRecordsForPrompt,
} from './evolutionPromptBudget.js'
import {
  buildMatOSEvolutionTargetContract,
  type MatOSEvolutionTargetAssetType,
  type MatOSEvolutionTargetContract,
} from './evolutionTargetGovernance.js'
import { runMatOSSemanticAcceptanceJudge } from './semanticAcceptanceJudge.js'
import {
  classifyMatOSTurnFeedbackWithLLM,
  realtimeTurnFeedbackKinds,
  shouldSemanticallyClassifyTurnPrompt,
  turnSemanticClassifierEnabled,
  type MatOSTurnFeedbackClassifier,
} from './turnFeedbackClassifier.js'
import {
  directEditableFeedbackDecisions,
  runMatOSUserFeedbackAnalysisWithDiagnostics,
  type MatOSUserFeedbackAnalysis,
  type MatOSUserFeedbackAnalysisDiagnostics,
  type MatOSUserFeedbackAnalyzer,
} from './userFeedbackSignals.js'
import { claimMatOSEvolutionDailyBudget } from './evolutionDailyBudget.js'
import type { MatOSWorkflowEvidence } from './workflowEvidence.js'
import { withMatOSEvolutionTriggerClaim } from './evolutionTriggerClaim.js'
import { classifyPromptUserFeedbackSignal } from './evolutionMonitorFeedback.js'
import { shouldSkipTrivialSuccessfulSessionEvolution } from './evolutionMonitorSessionFilters.js'
import { isMatOSExpectedToolGuardEvent } from './evolutionExpectedToolGuards.js'
import {
  evaluateMatOSSelfEvolutionTriggerQualityGate,
  formatMatOSSelfEvolutionTriggerQualitySkipSummary,
} from './evolutionTriggerQualityGate.js'
import {
  evolutionWorkerSuppressedByEnv,
  spawnSessionTriggerEvolutionWorker,
} from './evolutionWorkerDispatch.js'
import {
  appendMonitorRecord,
  compactDirectEditorRunForMonitor,
  listMatOSSelfEvolutionMonitorRecordLedger,
  readMonitorRecordsForSession,
  readMatOSSelfEvolutionMonitorRecordFromLedger,
  type MatOSSelfEvolutionMonitorRecord,
  type MatOSSelfEvolutionMonitorStatus,
} from './evolutionMonitorRecords.js'
import {
  recordMatOSEvolutionTriggerConclusionInFailureLedger,
  suppressMatOSEvolutionTriggerForRepeatedFailures,
} from './evolutionCrossSessionSuppression.js'
import {
  accumulateMatOSEvolutionSpendFromMonitorRecord,
  gateMatOSEvolutionDailyBudget,
} from './evolutionBudgetGate.js'
import { syncGeneratedScopedAssetsToGitea } from './generatedScopedAssetSync.js'
import { resolveMatOSEvolutionApprovalMode } from './evolutionApprovalPolicy.js'
import {
  createMatOSEvolutionAlgorithmRuntime,
  evolutionAlgorithmSignals,
  selectEvolutionAlgorithmFeedback,
  type MatOSEvolutionAlgorithmRuntime,
} from './evolutionAlgorithmRuntime.js'
export { resolveMatOSSelfEvolutionMonitorRoots, safeMonitorSessionSegment } from './evolutionMonitorRecords.js'
export type {
  MatOSSelfEvolutionMonitorDirectEditorRun,
  MatOSSelfEvolutionMonitorRecord,
  MatOSSelfEvolutionMonitorStatus,
} from './evolutionMonitorRecords.js'

export type MatOSSelfEvolutionTriggerKind =
  | 'user-feedback'
  | 'tool-failure'
  | 'workflow-failure'
  | 'agent-repeated-action'
  | 'manual-evolve'
  | 'session-end'

export type MatOSSelfEvolutionTrigger = {
  kind: MatOSSelfEvolutionTriggerKind
  key: string
  eventId?: string
  summary: string
  targetAssetTypes?: MatOSEvolutionTargetAssetType[]
  targetAssetRefs?: string[]
  experienceOnly?: boolean
  // Realtime heuristic candidate (length/slash gate only). It must pass the
  // semantic turn classifier before the hidden pipeline is allowed to run;
  // untagged triggers already carry a confirmed signal.
  semanticCandidate?: boolean
}

function eventScopeRef(event: MatOSEventSource): string | undefined {
  const data =
    event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {}
  return (
    stringValue(event.scopeRef) ??
    stringValue(data.scopeRef) ??
    stringValue(data.scope)
  )
}

function eventUserId(event: MatOSEventSource): string | undefined {
  const data =
    event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {}
  return (
    stringValue(event.userId) ??
    stringValue(data.userId) ??
    stringValue(data.user) ??
    stringValue(data.accountId)
  )
}

function normalizedUserScopeRefFromUserId(userId: string | undefined): string | undefined {
  const id = userId?.trim()
  if (!id || id === 'local') {
    return undefined
  }
  return id.startsWith('user:') ? id : `user:${id}`
}

type MatOSDirectEditorScopeResolution =
  | { scope: MatOSDirectAssetEditorScope; scopeRef?: string }
  | { blockedReason: string }

function directEditorScopeFromScopeRef(
  scopeRef: string | undefined,
): MatOSDirectEditorScopeResolution {
  const ref = scopeRef?.trim()
  if (!ref) {
    return { blockedReason: 'missing_scope' }
  }
  if (ref === 'core' || ref === 'scope:core') {
    return { scope: 'core' }
  }
  if (ref.startsWith('user:')) {
    return { scope: 'user', scopeRef: ref }
  }
  if (ref.startsWith('team:')) {
    return { scope: 'team', scopeRef: ref }
  }
  if (ref.startsWith('project:')) {
    return { scope: 'project', scopeRef: ref }
  }
  return { blockedReason: `unsupported_scope:${ref}` }
}

function ownedSourceEventRefsForScope(
  events: MatOSEventSource[],
  scopeRef: string | undefined,
): string[] {
  const owner = scopeRef?.trim()
  if (!owner) {
    return []
  }
  const refs = new Set<string>()
  for (const event of events) {
    if (eventScopeRef(event) !== owner) {
      continue
    }
    refs.add(event.id)
    refs.add(`event:${event.id}`)
  }
  return [...refs].sort()
}

export function directEditorScopeForSelfEvolution(input: {
  events: MatOSEventSource[]
  env?: Record<string, string | undefined>
}): MatOSDirectEditorScopeResolution {
  // The evolution worker runs the monitor without deps.env; the standalone
  // service puts MATOS_SCOPE_REF=user:local in the process environment.
  const env = input.env ?? process.env
  const realUserScopeRef =
    normalizedUserScopeRefFromUserId(env.MATOS_USER_ID) ??
    normalizedUserScopeRefFromUserId(env.MATOS_GATEWAY_USER_ID) ??
    normalizedUserScopeRefFromUserId(env.MATOS_WORKSPACE_USER_ID) ??
    normalizedUserScopeRefFromUserId(env.MATOS_ACCOUNT_ID) ??
    input.events.map(eventUserId).map(normalizedUserScopeRefFromUserId).find(Boolean)
  const explicitScopeRef =
    stringValue(env.MATOS_SCOPE_REF) ??
    stringValue(env.MATOS_SCOPE_ID) ??
    input.events.map(eventScopeRef).find(Boolean)
  if (explicitScopeRef === 'user:local' && realUserScopeRef) {
    return directEditorScopeFromScopeRef(realUserScopeRef)
  }
  if (explicitScopeRef) {
    return directEditorScopeFromScopeRef(explicitScopeRef)
  }
  if (realUserScopeRef) {
    return directEditorScopeFromScopeRef(realUserScopeRef)
  }
  return directEditorScopeFromScopeRef(
    input.events.map(eventScopeRef).find(Boolean),
  )
}

function directEditorAssetCwd(input: {
  cwd: string
  env?: Record<string, string | undefined>
}): string {
  const env = input.env ?? process.env
  return stringValue(env.MATOS_ASSETS_CWD) ?? input.cwd
}

function hiddenEvolutionTraceEnv(input: {
  events: MatOSEventSource[]
  env?: Record<string, string | undefined>
}): Record<string, string> {
  const traceEnv: Record<string, string> = {}
  const scope = directEditorScopeForSelfEvolution(input)
  if (!('blockedReason' in scope)) {
    traceEnv.MATOS_SCOPE_REF = scope.scopeRef ?? 'core'
  }
  const userId =
    stringValue(input.env?.MATOS_USER_ID) ??
    stringValue(input.env?.MATOS_GATEWAY_USER_ID) ??
    stringValue(input.env?.MATOS_WORKSPACE_USER_ID) ??
    stringValue(input.env?.MATOS_ACCOUNT_ID) ??
    input.events.map(eventUserId).find(Boolean)
  if (userId) {
    traceEnv.MATOS_USER_ID = userId.startsWith('user:')
      ? userId.slice('user:'.length)
      : userId
  }
  return traceEnv
}

function directEditorScopeBlockedSummary(reason: string): string {
  return `Direct asset editor blocked_by_policy: ${reason}. A self-evolution direct edit requires an explicit MatOS scope.`
}

function targetContractModeFromEnv(
  env?: Record<string, string | undefined>,
): 'shadow' | 'advisory' | 'strict' | undefined {
  const raw =
    env?.MATOS_EVOLUTION_TARGET_CONTRACT_MODE ??
    process.env.MATOS_EVOLUTION_TARGET_CONTRACT_MODE
  return raw === 'shadow' || raw === 'advisory' || raw === 'strict'
    ? raw
    : undefined
}

function explicitTriggerTargetContract(input: {
  trigger: MatOSSelfEvolutionTrigger
  env?: Record<string, string | undefined>
}): MatOSEvolutionTargetContract | undefined {
  const expectedTypes = [...new Set(input.trigger.targetAssetTypes ?? [])].sort()
  const preferredRefs = [...new Set(input.trigger.targetAssetRefs ?? [])].sort()
  if (expectedTypes.length === 0 && preferredRefs.length === 0) {
    return undefined
  }
  const narrowTypes = expectedTypes.filter(type => type !== 'role')
  const behaviorTargeted = preferredRefs.some(
    ref => ref.startsWith('tool:') || ref.startsWith('mcp:'),
  )
  return {
    schemaVersion: 1,
    mode:
      targetContractModeFromEnv(input.env) ??
      (behaviorTargeted ? 'strict' : 'advisory'),
    expectedTypes,
    preferredRefs,
    roleFallbackAllowed: narrowTypes.length === 0,
    ...(narrowTypes.length > 0 ? { disallowedFallbackTypes: ['role'] } : {}),
    reason:
      input.trigger.kind === 'manual-evolve'
        ? 'Direct-edit target contract was selected explicitly by the user through /evolve.'
        : 'Direct-edit target contract was derived from the failing native MatOS tool.',
    source: 'explicit',
  }
}

function matOSExperienceLayerEnabled(input: {
  trigger: MatOSSelfEvolutionTrigger
  env?: Record<string, string | undefined>
}): boolean {
  if (input.trigger.experienceOnly === true) {
    return true
  }
  const raw =
    input.env?.MATOS_EVOLUTION_EXPERIENCE_LAYER ??
    process.env.MATOS_EVOLUTION_EXPERIENCE_LAYER
  return ['1', 'true', 'on', 'enabled', 'legacy'].includes(
    raw?.trim().toLowerCase() ?? '',
  )
}

function selfEvolutionShouldRunDirectEditor(input: {
  trigger: MatOSSelfEvolutionTrigger
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  events: MatOSEventSource[]
  env?: Record<string, string | undefined>
}): boolean {
  if (input.trigger.experienceOnly === true) {
    return false
  }
  const scope = directEditorScopeForSelfEvolution({
    events: input.events,
    env: input.env,
  })
  const scoped =
    !('blockedReason' in scope) &&
    (scope.scope === 'user' ||
      scope.scope === 'team' ||
      scope.scope === 'project')
  return (
    directEditableFeedbackDecisions(input.feedbackAnalysis, {
      scoped,
      ...(!('blockedReason' in scope) && scope.scopeRef
        ? {
            ownedSourceEventRefs: ownedSourceEventRefsForScope(
              input.events,
              scope.scopeRef,
            ),
          }
        : {}),
    }).length > 0
  )
}

export type MatOSSelfEvolutionRunInput = {
  cwd: string
  sessionId: string
  sessionPath: string
  trigger: MatOSSelfEvolutionTrigger
  hidden?: boolean
}

export type MatOSSelfEvolutionWorkflowInput = {
  cwd: string
  evidence: MatOSWorkflowEvidence
  hidden?: boolean
}

export type MatOSSelfEvolutionRunDeps = {
  feedbackAnalyzer?: MatOSUserFeedbackAnalyzer
  refiner?: MatOSExperienceRefiner
  directEditor?: MatOSDirectAssetEditor
  directEditorRecover?: typeof recoverInterruptedMatOSDirectAssetEditorRuns
  directEditorRebaseline?: MatOSDirectAssetEditorRebaseline
  generatedScopedAssetSync?: typeof syncGeneratedScopedAssetsToGitea
  turnFeedbackClassifier?: MatOSTurnFeedbackClassifier
  maintainWorkflow?: (input: {
    cwd: string
    evidence: MatOSWorkflowEvidence
    feedbackAnalysis?: MatOSUserFeedbackAnalysis
    refiner?: MatOSExperienceRefiner
  }) => Promise<string[]>
  env?: Record<string, string | undefined>
}

const activeTriggerKeys = new Set<string>()
const NOISY_TRIGGER_BUCKET_MS = 10 * 60 * 1000
const NOISY_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000
// User feedback keys on the event id, so every feedback-looking turn is a new
// exact key. Without a family cooldown a chatty session pays for one hidden
// pipeline run per turn, which can dominate the
// evolution bill. Session-end analysis still covers suppressed turns.
const DEFAULT_USER_FEEDBACK_TRIGGER_COOLDOWN_MS = 60 * 60 * 1000

function userFeedbackTriggerCooldownMs(
  env?: Record<string, string | undefined>,
): number {
  const raw =
    env?.MATOS_EVOLUTION_USER_FEEDBACK_COOLDOWN_MS ??
    process.env.MATOS_EVOLUTION_USER_FEEDBACK_COOLDOWN_MS
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_USER_FEEDBACK_TRIGGER_COOLDOWN_MS
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_USER_FEEDBACK_TRIGGER_COOLDOWN_MS
}

function nowIso(): string {
  return new Date().toISOString()
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function eventToolName(
  event: MatOSEvent,
  events: MatOSEvent[],
): string | undefined {
  const direct = stringValue(event.data.toolName)
  if (direct) {
    return direct
  }
  const toolUseId = stringValue(event.data.toolUseId)
  if (!toolUseId) {
    return undefined
  }
  for (const candidate of [...events].reverse()) {
    if (
      candidate.type === 'matos.tool.call.started' &&
      stringValue(candidate.data.toolUseId) === toolUseId
    ) {
      const startedName = stringValue(candidate.data.toolName)
      if (startedName) {
        return startedName
      }
    }
    if (candidate.type !== 'matos.agent.message') {
      continue
    }
    const toolUses = Array.isArray(candidate.data.toolUses)
      ? candidate.data.toolUses
      : []
    for (const toolUse of toolUses) {
      if (!toolUse || typeof toolUse !== 'object' || Array.isArray(toolUse)) {
        continue
      }
      const record = toolUse as Record<string, unknown>
      if (stringValue(record.toolUseId) === toolUseId) {
        const assistantName = stringValue(record.toolName)
        if (assistantName) {
          return assistantName
        }
      }
    }
  }
  return undefined
}

const MATOS_ASSET_SERVER_BUILTIN_TOOL_NAMES = new Set<string>([
  ...MATOS_ASSET_DISCOVERY_TOOL_NAMES,
  ...MATOS_ASSET_BUILDER_TOOL_NAMES,
  ...MATOS_ROLE_BUILDER_TOOL_NAMES,
  ...MATOS_WORKFLOW_TOOL_NAMES,
])

function nativeToolTargetRefs(toolName: string): string[] {
  const raw = toolName.trim()
  const assetToolName = raw.startsWith('mcp__matos_asset__')
    ? raw.slice('mcp__matos_asset__'.length)
    : undefined
  if (!assetToolName) {
    return []
  }
  // Built-in asset-server facade tools (asset_list, workflow_run, role_edit,
  // ...) are not editable tool assets; minting tool: refs for them creates
  // strict contracts that can only fail conformance.
  if (MATOS_ASSET_SERVER_BUILTIN_TOOL_NAMES.has(assetToolName)) {
    return []
  }
  const normalized = assetToolName
    .replace(/_/g, '-')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return normalized ? [`tool:${normalized}`] : []
}

function triggerSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown'
}

function eventTimestampMs(event: MatOSEvent): number {
  const parsed = Date.parse(event.timestamp)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function eventTimeBucket(event: MatOSEvent): string {
  return String(Math.floor(eventTimestampMs(event) / NOISY_TRIGGER_BUCKET_MS))
}

function normalizedFailureMaterial(event: MatOSEvent): string {
  const data = event.data ?? {}
  const candidates = [
    data.toolName,
    data.error,
    data.errorMessage,
    data.resultPreview,
    data.outputPreview,
    data.stderrPreview,
    data.exitCode,
  ]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value))
    .join('\n')
  const material = candidates || JSON.stringify(data)
  return material.replace(/\s+/g, ' ').trim().slice(0, 1000)
}

function failureFingerprint(event: MatOSEvent): string {
  return createHash('sha256')
    .update(normalizedFailureMaterial(event))
    .digest('hex')
    .slice(0, 12)
}

function activeTriggerKey(input: {
  cwd: string
  sessionId: string
  triggerKey: string
}): string {
  return `${input.cwd}\u0000${input.sessionId}\u0000${input.triggerKey}`
}

function triggerFamilyKey(input: {
  kind?: MatOSSelfEvolutionTriggerKind
  key?: string
  triggerKind?: MatOSSelfEvolutionTriggerKind
  triggerKey?: string
}): string {
  const kind = input.kind ?? input.triggerKind
  const key = input.key ?? input.triggerKey ?? ''
  const parts = key.split(':')
  if (kind === 'agent-repeated-action' && parts.length >= 2) {
    return `${kind}:${parts[1]}`
  }
  // The exact key keeps the failure fingerprint, but the fingerprint hashes
  // volatile material (timestamps, paths, ports), so a fingerprinted family
  // never matched twice and the cooldown never engaged. Cool down per tool.
  if (kind === 'tool-failure' && parts.length >= 2) {
    return `${kind}:${parts[1]}`
  }
  // Records are already partitioned per session, so the kind alone gives a
  // session+kind family for user feedback.
  if (kind === 'user-feedback') {
    return kind
  }
  return key
}

function triggerCooldownMs(
  trigger: MatOSSelfEvolutionTrigger,
  env?: Record<string, string | undefined>,
): number {
  if (
    trigger.kind === 'agent-repeated-action' ||
    trigger.kind === 'tool-failure'
  ) {
    return NOISY_TRIGGER_COOLDOWN_MS
  }
  if (trigger.kind === 'user-feedback') {
    return userFeedbackTriggerCooldownMs(env)
  }
  return 0
}

function latestRecordForTriggerKey(
  records: MatOSSelfEvolutionMonitorRecord[],
  triggerKey: string,
): MatOSSelfEvolutionMonitorRecord | undefined {
  return records
    .filter(record => record.triggerKey === triggerKey)
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || right.createdAt) -
        Date.parse(left.updatedAt || left.createdAt),
    )[0]
}

// Only a concluded exact trigger suppresses that exact trigger forever.
// Intermediate statuses ('detected', 'analysis-complete') and
// 'experience-written' mean the run was interrupted before producing a final
// editor outcome; a crash there must not permanently suppress a stable trigger
// key (e.g. user-feedback:<eventId>). Noisy trigger families still get a short
// cooldown even after failed background processing so a live session cannot
// keep generating background failures for the same symptom.
const CONCLUDED_MONITOR_STATUSES = new Set<MatOSSelfEvolutionMonitorStatus>([
  'direct-edit-complete',
  'direct-edit-proposed',
  'direct-edit-blocked',
  'direct-edit-import-blocked',
  'skipped-low-quality-trigger',
  // Daily hidden-run budget denials are explicit terminal conclusions: the
  // record must not linger pseudo-active, and the exact trigger key must not
  // re-fire the pipeline (matching the previous 'noop' conclusion semantics
  // for these denials, now under an honest, distinguishable status).
  'budget-denied',
  'noop',
])

function shouldSuppressEvolutionTrigger(
  priorRecords: MatOSSelfEvolutionMonitorRecord[],
  trigger: MatOSSelfEvolutionTrigger,
  env?: Record<string, string | undefined>,
): boolean {
  const latest = latestRecordForTriggerKey(priorRecords, trigger.key)
  if (latest && CONCLUDED_MONITOR_STATUSES.has(latest.status) && !evolutionInfrastructureFailureCode(latest.directEditorRun ?? {})) {
    return true
  }
  const cooldownMs = triggerCooldownMs(trigger, env)
  if (cooldownMs <= 0) {
    return false
  }
  const cutoff = Date.now() - cooldownMs
  return priorRecords.some(record => {
    if (record.triggerKind !== trigger.kind) {
      return false
    }
    // A rejected semantic candidate is not evidence that feedback was already
    // analyzed. Counting it toward the family cooldown suppressed REAL
    // corrections arriving shortly after a benign turn that merely contained
    // a weak keyword (a false-negative class).
    if (record.status === 'skipped-low-quality-trigger') {
      return false
    }
    if (triggerFamilyKey(record) !== triggerFamilyKey(trigger)) {
      return false
    }
    const recordMs = Date.parse(record.updatedAt || record.createdAt)
    return Number.isFinite(recordMs) && recordMs >= cutoff
  })
}

function sourceEvents(
  events: MatOSEvent[],
  sessionPath: string,
): MatOSEventSource[] {
  return events.map(event => ({ ...event, sourcePath: sessionPath }))
}

function workflowEvidenceSessionId(evidence: MatOSWorkflowEvidence): string {
  return evidence.traceId ?? evidence.runId
}

function workflowEvidenceSessionPath(evidence: MatOSWorkflowEvidence): string {
  return evidence.path ?? `workflow-evidence:${evidence.evidenceId}`
}

function workflowEvidenceEvents(evidence: MatOSWorkflowEvidence): MatOSEventSource[] {
  const sessionId = workflowEvidenceSessionId(evidence)
  return [
    {
      id: evidence.evidenceId,
      schemaVersion: 1,
      traceId: sessionId,
      sessionId,
      timestamp: evidence.createdAt,
      execution: 'workflow',
      roleRef: 'role:workflow',
      type:
        evidence.status === 'failed'
          ? 'matos.session.failed'
          : 'matos.session.completed',
      data: {
        workflowRef: evidence.workflowRef,
        runId: evidence.runId,
        status: evidence.status,
        nodeSummary: evidence.nodeSummary,
        eventTypes: evidence.eventTypes,
        artifactRefs: evidence.artifactRefs,
        recovery: evidence.recovery,
        occurrenceCount: evidence.occurrenceCount,
        relatedEvidenceIds: evidence.relatedEvidenceIds,
        relatedRunIds: evidence.relatedRunIds,
        suggestedAssetTypes: evidence.suggestedAssetTypes,
        sourceRefs: evidence.sourceRefs,
        fullWorkflowEvidence: evidence,
      },
      sourcePath: workflowEvidenceSessionPath(evidence),
    },
  ]
}

function monitorRecord(input: {
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  status: MatOSSelfEvolutionMonitorStatus
  summary: string
  priorRecords?: MatOSSelfEvolutionMonitorRecord[]
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  llmDiagnostics?: MatOSUserFeedbackAnalysisDiagnostics[]
  experienceRefs?: string[]
  directEditorRun?: MatOSDirectAssetEditorRunRecord
  error?: string
}): MatOSSelfEvolutionMonitorRecord {
  const timestamp = nowIso()
  return {
    recordId: `monitor-${randomUUID()}`,
    sessionId: input.sessionId,
    triggerKind: input.trigger.kind,
    triggerKey: input.trigger.key,
    status: input.status,
    createdAt: timestamp,
    updatedAt: timestamp,
    summary: input.summary,
    ...(input.trigger.eventId ? { eventId: input.trigger.eventId } : {}),
    ...(input.feedbackAnalysis
      ? {
          feedbackAnalysis: redactTraceValue(
            input.feedbackAnalysis,
          ) as MatOSUserFeedbackAnalysis,
        }
      : {}),
    ...(input.experienceRefs ? { experienceRefs: input.experienceRefs } : {}),
    ...(input.llmDiagnostics?.length
      ? {
          llmDiagnostics: redactTraceValue(
            input.llmDiagnostics,
          ) as MatOSUserFeedbackAnalysisDiagnostics[],
        }
      : {}),
    ...(input.directEditorRun?.runId
      ? { directEditorRunId: input.directEditorRun.runId }
      : {}),
    ...(input.directEditorRun?.input.currentEvolutionContext?.algorithm
      ? { algorithm: structuredClone(input.directEditorRun.input.currentEvolutionContext.algorithm) }
      : {}),
    ...(input.directEditorRun
      ? { directEditorRun: compactDirectEditorRunForMonitor(input.directEditorRun) }
      : {}),
    ...(input.priorRecords?.length
      ? { priorRecordIds: input.priorRecords.map(record => record.recordId) }
      : {}),
    ...(input.error ? { error: input.error } : {}),
  }
}

function repeatedToolTrigger(
  event: MatOSEvent,
  events: MatOSEvent[],
): MatOSSelfEvolutionTrigger | undefined {
  if (event.type !== 'matos.tool.call.completed') {
    return undefined
  }
  const toolName = eventToolName(event, events)
  if (!toolName) {
    return undefined
  }
  const recentSameTool = [...events]
    .reverse()
    .filter(item => item.type === 'matos.tool.call.completed')
    .slice(0, 6)
    .filter(item => eventToolName(item, events) === toolName)
  if (recentSameTool.length < 4) {
    return undefined
  }
  return {
    kind: 'agent-repeated-action',
    key: `agent-repeated-action:${triggerSegment(toolName)}:${eventTimeBucket(event)}`,
    eventId: event.id,
    summary: `Repeated ${toolName} calls were observed and should be checked for a loop or inefficient recovery.`,
  }
}

export function classifySelfEvolutionTrigger(
  event: MatOSEvent,
  events: MatOSEvent[] = [event],
): MatOSSelfEvolutionTrigger | undefined {
  if (event.type === 'matos.turn.started') {
    const prompt = stringValue(event.data.prompt ?? event.data.promptPreview) ?? ''
    const signal = classifyPromptUserFeedbackSignal(prompt)
    if (signal === 'confirmed') {
      return {
        kind: 'user-feedback',
        key: `user-feedback:${event.id}`,
        eventId: event.id,
        summary: 'User feedback, correction, or frustration should be analyzed for self-evolution.',
      }
    }
    if (signal === 'candidate') {
      // Weak technical keywords (error/failed/报错/不对...) also appear in
      // brand-new task prompts and pasted logs. They no longer confirm the
      // trigger directly; the cached semantic turn classifier must confirm
      // real feedback before the hidden pipeline may spend anything.
      return {
        kind: 'user-feedback',
        key: `user-feedback:${event.id}`,
        eventId: event.id,
        summary:
          'Potential user feedback matched a weak keyword and should be semantically classified before analysis.',
        semanticCandidate: true,
      }
    }
  }
  if (
    event.type === 'matos.tool.call.completed' &&
    booleanValue(event.data.isError)
  ) {
    if (isMatOSExpectedToolGuardEvent(event)) {
      return undefined
    }
    const toolName = eventToolName(event, events) ?? 'tool'
    const targetAssetRefs = nativeToolTargetRefs(toolName)
    return {
      kind: 'tool-failure',
      key: `tool-failure:${triggerSegment(toolName)}:${failureFingerprint(event)}:${eventTimeBucket(event)}`,
      eventId: event.id,
      summary: `${toolName} failed and should be analyzed for a reusable improvement.`,
      ...(targetAssetRefs.length > 0
        ? { targetAssetTypes: ['tool'], targetAssetRefs }
        : {}),
    }
  }
  if (
    event.type === 'matos.tool.call.completed' &&
    isMatOSExpectedToolGuardEvent(event)
  ) {
    return undefined
  }
  const repeated = repeatedToolTrigger(event, events)
  if (repeated) {
    return repeated
  }
  if (event.type === 'matos.session.failed') {
    return {
      kind: 'session-end',
      key: `session-end:${event.sessionId}`,
      eventId: event.id,
      summary: 'The session failed and should be analyzed before the next run.',
    }
  }
  if (event.type === 'matos.session.completed') {
    return {
      kind: 'session-end',
      key: `session-end:${event.sessionId}`,
      eventId: event.id,
      summary: 'The session completed and should be checked for reusable experience.',
    }
  }
  return undefined
}

// The 'off' approval mode stops automatic triggers before any LLM stage. An
// explicit /evolve still runs; the direct editor then parks its edit as a
// proposal because only 'auto' accepts on its own.
async function selfEvolutionDisabledForTrigger(input: {
  cwd: string
  trigger: MatOSSelfEvolutionTrigger
  env?: Record<string, string | undefined>
}): Promise<boolean> {
  if (input.trigger.kind === 'manual-evolve') {
    return false
  }
  const resolution = await resolveMatOSEvolutionApprovalMode({
    cwd: directEditorAssetCwd({ cwd: input.cwd, env: input.env }),
    env: input.env,
  })
  return resolution.mode === 'off'
}

function shouldRunHiddenLLM(
  deps: MatOSSelfEvolutionRunDeps,
): boolean {
  const env = deps.env ?? process.env
  return Boolean(deps.feedbackAnalyzer || deps.refiner || deps.directEditor) ||
    env.NODE_ENV !== 'test'
}

function shouldUseSharedPromptCacheRunner(
  deps: MatOSSelfEvolutionRunDeps,
): boolean {
  const env = deps.env ?? process.env
  return (
    !deps.feedbackAnalyzer &&
    !deps.refiner &&
    !deps.directEditor &&
    !deps.maintainWorkflow &&
    env.MATOS_EVOLUTION_SHARED_PROMPT_CACHE !== 'off' &&
    env.MATOS_EVOLUTION_SHARED_PROMPT_CACHE !== 'disabled'
  )
}

async function createSessionSharedPromptCacheRunner(input: {
  cwd: string
  sessionId: string
  sessionPath: string
  trigger: MatOSSelfEvolutionTrigger
  events: MatOSEventSource[]
  priorRecords: MatOSSelfEvolutionMonitorRecord[]
  deps: MatOSSelfEvolutionRunDeps
  traceEnv?: Record<string, string>
}): Promise<MatOSEvolutionSharedPromptCacheRunner | undefined> {
  if (!shouldUseSharedPromptCacheRunner(input.deps)) {
    return undefined
  }
  return createMatOSEvolutionSharedPromptCacheRunner({
    cwd: input.cwd,
    jobId: `self-evolution-${input.sessionId}-${input.trigger.key}`,
    evidence: buildMatOSEvolutionSharedEvidencePrefix({
      jobId: `self-evolution-${input.sessionId}-${input.trigger.key}`,
      trigger: input.trigger,
      sessionPath: input.sessionPath,
      // The shared prefix is serialized once into the hidden worker prompt;
      // budget it like every other evolution prompt payload so long sessions
      // cannot exceed the provider context limit.
      events: boundMatOSEvolutionEventsForPrompt(input.events).events,
      priorRecords: compactMatOSEvolutionMonitorRecordsForPrompt(
        input.priorRecords,
      ).records,
    }),
    traceEnv: input.traceEnv,
  })
}

async function createWorkflowSharedPromptCacheRunner(input: {
  cwd: string
  sessionId: string
  sessionPath: string
  trigger: MatOSSelfEvolutionTrigger
  events: MatOSEventSource[]
  workflowEvidence: MatOSWorkflowEvidence
  priorRecords: MatOSSelfEvolutionMonitorRecord[]
  deps: MatOSSelfEvolutionRunDeps
  traceEnv?: Record<string, string>
}): Promise<MatOSEvolutionSharedPromptCacheRunner | undefined> {
  if (!shouldUseSharedPromptCacheRunner(input.deps)) {
    return undefined
  }
  return createMatOSEvolutionSharedPromptCacheRunner({
    cwd: input.cwd,
    jobId: `self-evolution-${input.sessionId}-${input.trigger.key}`,
    evidence: buildMatOSEvolutionSharedEvidencePrefix({
      jobId: `self-evolution-${input.sessionId}-${input.trigger.key}`,
      trigger: input.trigger,
      sessionPath: input.sessionPath,
      events: boundMatOSEvolutionEventsForPrompt(input.events).events,
      priorRecords: compactMatOSEvolutionMonitorRecordsForPrompt(
        input.priorRecords,
      ).records,
      workflowEvidence: input.workflowEvidence,
    }),
    traceEnv: input.traceEnv,
  })
}

export function directEditorImportBlockedByConcurrentChange(
  run: Pick<MatOSDirectAssetEditorRunRecord, 'status' | 'stderr'>,
): boolean {
  return (
    run.status === 'failed' &&
    (run.stderr?.includes(
      'import skipped because editable assets changed during the isolated editor run',
    ) ??
      false)
  )
}

// Map a direct-editor run record to an honest monitor status. A returned record
// does NOT mean success: the editor returns a record for rolled_back/failed runs
// too. Only accepted/edited statuses actually applied a change.
function directEditMonitorOutcome(
  run: Awaited<ReturnType<typeof runMatOSDirectAssetEditor>>,
): { status: MatOSSelfEvolutionMonitorStatus; summary: string } {
  if (!run) {
    return {
      status: 'noop',
      summary: 'Direct asset editor had no applicable target.',
    }
  }
  if (
    run.status === 'accepted' ||
    run.status === 'accepted_merged' ||
    run.status === 'edited'
  ) {
    return {
      status: 'direct-edit-complete',
      summary:
        run.status === 'accepted_merged'
          ? 'Direct asset editor applied an accepted edit through a validated dirty-tree merge.'
          : 'Direct asset editor applied an accepted edit.',
    }
  }
  if (run.status === 'proposed') {
    return {
      status: 'direct-edit-proposed',
      summary:
        'Direct asset editor proposed an edit that passed every gate; it waits for human approval.',
    }
  }
  if (run.status === 'noop') {
    return {
      status: 'noop',
      summary: 'Direct asset editor had no applicable change.',
    }
  }
  if (run.status === 'blocked') {
    return {
      status: 'direct-edit-blocked',
      summary:
        evolutionInfrastructureFailureCode(run)
          ? `Direct asset editor is blocked by infrastructure (${run.statusReason}); repair the source or credential and retry.`
          : 'Direct asset editor is blocked because current editable assets differ from the stable baseline.',
    }
  }
  if (run.status === 'pending_merge') {
    return {
      status: 'direct-edit-blocked',
      summary:
        'Direct asset editor produced a reusable edit but left it pending because it conflicts with current editable assets.',
    }
  }
  if (directEditorImportBlockedByConcurrentChange(run)) {
    return {
      status: 'direct-edit-import-blocked',
      summary:
        'Direct asset editor finished in isolation but import was blocked because editable assets changed during the run.',
    }
  }
  return {
    status: 'failed',
    summary: `Direct asset editor did not apply changes (status: ${run.status}).`,
  }
}

function directEditorBlockedByStaleStableBaseline(
  run: Awaited<ReturnType<typeof runMatOSDirectAssetEditor>>,
): boolean {
  return (
    run?.status === 'blocked' &&
    (run.stderr?.includes(
      'current assets differ from the stable snapshot',
    ) ??
      false)
  )
}

function directEditorAutoRebaselineEnabled(
  env: Record<string, string | undefined> | undefined,
): boolean {
  const raw =
    env?.MATOS_EVOLUTION_DIRECT_EDITOR_AUTO_REBASELINE ??
    process.env.MATOS_EVOLUTION_DIRECT_EDITOR_AUTO_REBASELINE
  if (!raw) {
    return true
  }
  return !['0', 'false', 'off', 'disabled', 'no'].includes(
    raw.trim().toLowerCase(),
  )
}

function generatedScopedAssetSyncEnabled(
  env: Record<string, string | undefined> | undefined,
): boolean {
  const raw =
    env?.MATOS_EVOLUTION_GENERATED_SCOPE_SYNC ??
    process.env.MATOS_EVOLUTION_GENERATED_SCOPE_SYNC
  if (!raw) {
    return false
  }
  return ['1', 'true', 'on', 'enabled', 'yes'].includes(raw.trim().toLowerCase())
}

async function syncGeneratedScopedAssetsForSession(input: {
  cwd: string
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  events: MatOSEventSource[]
  deps: MatOSSelfEvolutionRunDeps
  priorRecords: MatOSSelfEvolutionMonitorRecord[]
  append: (record: MatOSSelfEvolutionMonitorRecord) => Promise<void>
}): Promise<void> {
  if (!generatedScopedAssetSyncEnabled(input.deps.env)) {
    return
  }
  const directScope = directEditorScopeForSelfEvolution({
    events: input.events,
    env: input.deps.env,
  })
  if ('blockedReason' in directScope || !directScope.scopeRef) {
    return
  }
  if (
    directScope.scope !== 'user' &&
    directScope.scope !== 'team' &&
    directScope.scope !== 'project'
  ) {
    return
  }
  const syncGeneratedScopedAssets =
    input.deps.generatedScopedAssetSync ?? syncGeneratedScopedAssetsToGitea
  const result = await syncGeneratedScopedAssets({
    cwd: directEditorAssetCwd({ cwd: input.cwd, env: input.deps.env }),
    scope: directScope.scope,
    scopeRef: directScope.scopeRef,
    runId: `generated-sync-${triggerSegment(input.sessionId)}-${triggerSegment(
      input.trigger.key,
    )}-${Date.now()}`,
    summary: `Sync generated scoped assets for ${directScope.scopeRef}`,
    env: input.deps.env,
  })
  if (result.copiedAssets.length === 0 && result.skippedAssets.length === 0) {
    return
  }
  await input.append(
    monitorRecord({
      sessionId: input.sessionId,
      trigger: input.trigger,
      status: result.ok ? 'experience-written' : 'failed',
      summary: result.ok
        ? `Generated scoped experience assets were accepted into ${directScope.scopeRef}: ${result.copiedAssets
            .map(asset => asset.canonicalRef)
            .join(', ')}.`
        : `Generated scoped asset sync failed for ${directScope.scopeRef}.`,
      priorRecords: input.priorRecords,
      ...(result.ok
        ? {}
        : {
            error:
              result.sourceCommitErrors
                ?.map(error => `${error.sourceId}: ${error.error}`)
                .join('; ') ??
              result.skippedAssets
                .map(item => `${item.generatedDir}: ${item.reason}`)
                .join('; '),
          }),
    }),
  )
}

async function recoverInterruptedDirectEditorRunsForSession(input: {
  cwd: string
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  events: MatOSEventSource[]
  deps: MatOSSelfEvolutionRunDeps
  priorRecords: MatOSSelfEvolutionMonitorRecord[]
  append: (record: MatOSSelfEvolutionMonitorRecord) => Promise<void>
}): Promise<void> {
  const directScope = directEditorScopeForSelfEvolution({
    events: input.events,
    env: input.deps.env,
  })
  if ('blockedReason' in directScope) {
    return
  }
  const recover =
    input.deps.directEditorRecover ??
    recoverInterruptedMatOSDirectAssetEditorRuns
  const recovery = await recover({
    cwd: directEditorAssetCwd({ cwd: input.cwd, env: input.deps.env }),
    scope: directScope.scope,
    ...(directScope.scopeRef ? { scopeRef: directScope.scopeRef } : {}),
    limit: 3,
    env: input.deps.env,
  })
  for (const run of recovery.recovered) {
    const outcome = directEditMonitorOutcome(run)
    await input.append(
      monitorRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        status: outcome.status,
        summary: `Recovered interrupted direct asset editor run ${run.runId}. ${outcome.summary}`,
        priorRecords: input.priorRecords,
        experienceRefs: run.evidenceRefs,
        directEditorRun: run,
      }),
    )
  }
}

async function runDirectEditorWithStaleBaselineRecovery(input: {
  request: MatOSDirectAssetEditorRunInput
  deps: MatOSSelfEvolutionRunDeps
  trigger: MatOSSelfEvolutionTrigger
  experienceRefs: string[]
}): Promise<{
  directEditorRun: Awaited<ReturnType<typeof runMatOSDirectAssetEditor>>
  rebaseline?: MatOSDirectAssetEditorRebaselineResult
  retriedAfterRebaseline: boolean
}> {
  const directEditor = input.deps.directEditor ?? runMatOSDirectAssetEditor
  const firstRun = await directEditor(input.request)
  if (
    !directEditorBlockedByStaleStableBaseline(firstRun) ||
    !directEditorAutoRebaselineEnabled(input.deps.env)
  ) {
    return { directEditorRun: firstRun, retriedAfterRebaseline: false }
  }
  const rebaseline = await (
    input.deps.directEditorRebaseline ?? rebaselineMatOSDirectAssetEditorScope
  )({
    cwd: input.request.cwd,
    scope: input.request.scope ?? 'core',
    reason:
      'self-evolution direct editor was blocked by a stale stable baseline',
    triggerKey: input.trigger.key,
    experienceRefs: input.experienceRefs,
  })
  if (rebaseline.status === 'failed') {
    return {
      directEditorRun: firstRun,
      rebaseline,
      retriedAfterRebaseline: false,
    }
  }
  const retryRun = await directEditor(input.request)
  return {
    directEditorRun: retryRun,
    rebaseline,
    retriedAfterRebaseline: true,
  }
}

function directEditMonitorSummary(input: {
  outcome: ReturnType<typeof directEditMonitorOutcome>
  rebaseline?: MatOSDirectAssetEditorRebaselineResult
  retriedAfterRebaseline: boolean
}): string {
  if (!input.rebaseline) {
    return input.outcome.summary
  }
  if (input.retriedAfterRebaseline) {
    return `${input.outcome.summary} Automatic rebaseline status=${input.rebaseline.status} completed before retry after rebaselining.`
  }
  if (input.rebaseline.status === 'failed') {
    return `${input.outcome.summary} Automatic rebaseline failed: ${
      input.rebaseline.error ?? 'unknown error'
    }`
  }
  return `${input.outcome.summary} Automatic rebaseline status=${input.rebaseline.status}.`
}

export async function runMatOSSelfEvolutionForSession(
  input: MatOSSelfEvolutionRunInput,
  deps: MatOSSelfEvolutionRunDeps = {},
): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  const runningKey = activeTriggerKey({
    cwd: input.cwd,
    sessionId: input.sessionId,
    triggerKey: input.trigger.key,
  })
  if (activeTriggerKeys.has(runningKey)) {
    return undefined
  }
  activeTriggerKeys.add(runningKey)
  try {
    return await runMatOSSelfEvolutionForSessionUnlocked(input, deps)
  } finally {
    activeTriggerKeys.delete(runningKey)
  }
}

async function runMatOSSelfEvolutionForSessionUnlocked(
  input: MatOSSelfEvolutionRunInput,
  deps: MatOSSelfEvolutionRunDeps = {},
): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  if (input.hidden || !shouldRunHiddenLLM(deps)) {
    return undefined
  }
  if (await selfEvolutionDisabledForTrigger({ cwd: input.cwd, trigger: input.trigger, env: deps.env })) {
    return undefined
  }
  return await withMatOSEvolutionTriggerClaim(
    {
      cwd: input.cwd,
      sessionId: input.sessionId,
      triggerKey: input.trigger.key,
    },
    async () => {
      const priorRecords = await readMonitorRecordsForSession(
        input.cwd,
        input.sessionId,
      )
      if (shouldSuppressEvolutionTrigger(priorRecords, input.trigger, deps.env)) {
        return undefined
      }
      // Cross-session failure-loop suppression: the per-session records above
      // cannot see the same trigger key concluding failed in other sessions,
      // so deterministic failures re-fired the full pipeline from every new
      // session. The per-cwd failure ledger closes that gap.
      const crossSessionSuppression =
        await suppressMatOSEvolutionTriggerForRepeatedFailures({
          cwd: input.cwd,
          sessionId: input.sessionId,
          trigger: input.trigger,
          env: deps.env,
        })
      if (crossSessionSuppression.suppressed) {
        return crossSessionSuppression.noticeRecord
          ? [crossSessionSuppression.noticeRecord]
          : undefined
      }
      // Global daily budget gate, concluded before the semantic turn
      // classifier and the critic/shared-prefix stage so an exhausted budget
      // spends nothing further today. Manual triggers pass with a warning.
      const entryBudgetGate = await gateMatOSEvolutionDailyBudget({
        cwd: input.cwd,
        sessionId: input.sessionId,
        trigger: input.trigger,
        stage: 'pipeline-entry',
        priorRecords,
        env: deps.env,
      })
      if (entryBudgetGate.blocked) {
        return entryBudgetGate.skipRecord
          ? [entryBudgetGate.skipRecord]
          : undefined
      }
      if (input.trigger.semanticCandidate === true) {
        // Candidate triggers only cleared the cheap length/slash heuristic
        // (typically in a parent process that could not afford the inline
        // classifier). They must pass the same semantic classification the
        // inline path applies before the hidden pipeline may spend anything.
        const confirmed = await confirmSemanticCandidateTriggerFromSession(
          input,
          deps,
        )
        if (!confirmed) {
          const skipped = monitorRecord({
            sessionId: input.sessionId,
            trigger: input.trigger,
            status: 'skipped-low-quality-trigger',
            summary:
              'Semantic turn-feedback classification did not confirm the realtime user-feedback candidate, so the hidden evolution pipeline was skipped.',
            priorRecords,
          })
          await appendMonitorRecord(input.cwd, skipped)
          return [skipped]
        }
        return await runMatOSSelfEvolutionForSessionClaimed(
          { ...input, trigger: confirmed },
          deps,
          priorRecords,
        )
      }
      return await runMatOSSelfEvolutionForSessionClaimed(input, deps, priorRecords)
    },
  )
}

// Re-derive the semantic verdict for a realtime candidate from the persisted
// session events. Returns the confirmed (untagged) trigger, or undefined when
// the source event is missing/unreadable or the classifier does not confirm
// actionable feedback; session-end analysis still covers those turns.
async function confirmSemanticCandidateTriggerFromSession(
  input: MatOSSelfEvolutionRunInput,
  deps: MatOSSelfEvolutionRunDeps,
): Promise<MatOSSelfEvolutionTrigger | undefined> {
  const trigger = input.trigger
  const eventId =
    trigger.eventId ??
    (trigger.key.startsWith('user-feedback:')
      ? trigger.key.slice('user-feedback:'.length)
      : undefined)
  if (!eventId) {
    return undefined
  }
  let events: MatOSEvent[]
  try {
    events = await readMatOSSessionEventsFromPath(input.sessionPath)
  } catch {
    return undefined
  }
  const event = events.find(item => item.id === eventId)
  if (!event) {
    return undefined
  }
  return await semanticTurnFeedbackTriggerForEvent({
    cwd: input.cwd,
    sessionId: input.sessionId,
    event,
    deps,
  })
}

async function beginEvolutionAlgorithm(input: {
  cwd: string
  sessionId: string
  trigger: MatOSSelfEvolutionTrigger
  events: MatOSEventSource[]
  env?: Record<string, string | undefined>
  priorRecords: MatOSSelfEvolutionMonitorRecord[]
  append: (record: MatOSSelfEvolutionMonitorRecord) => Promise<void>
}): Promise<MatOSEvolutionAlgorithmRuntime | undefined> {
  const scope = directEditorScopeForSelfEvolution(input)
  try {
    if (!('blockedReason' in scope)) {
      const preflight = await preflightEvolutionGiteaSources({
        cwd: directEditorAssetCwd(input), ...scope, env: input.env, checkVersion: false,
      })
      if (preflight.ok === false) {
        await input.append(monitorRecord({ ...input, status: 'failed',
          summary: 'Self-evolution deferred before model analysis because Gitea publication is unavailable.',
          error: `${preflight.code}: ${preflight.message}`,
        }))
        return undefined
      }
    }
    const algorithm = await createMatOSEvolutionAlgorithmRuntime({
      cwd: directEditorAssetCwd(input),
      ...(!('blockedReason' in scope)
        ? { scopeRef: scope.scopeRef ?? scope.scope }
        : {}),
      env: input.env,
    })
    const decision = await algorithm.decide({
      schemaVersion: 1,
      phase: 'observed',
      trigger: { kind: input.trigger.kind, key: input.trigger.key },
      ...(!('blockedReason' in scope) && scope.scopeRef
        ? { scopeRef: scope.scopeRef }
        : {}),
      constraints: {
        canAnalyze: true,
        canEdit: !('blockedReason' in scope),
        maxSignals: 8,
      },
      signals: [],
    })
    if (decision.action === 'analyze') return algorithm
    await input.append({
      ...monitorRecord({
        ...input,
        status: 'noop',
        summary:
          decision.reason ?? 'Evolution algorithm deferred this trigger.',
      }),
      algorithm: algorithm.journal(),
    })
  } catch (error) {
    await input.append(
      monitorRecord({
        ...input,
        status: 'failed',
        summary: 'Evolution algorithm could not be resolved safely.',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  return undefined
}

async function selectFeedbackWithEvolutionAlgorithm(input: {
  algorithm: MatOSEvolutionAlgorithmRuntime
  trigger: MatOSSelfEvolutionTrigger
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  events: MatOSEventSource[]
  env?: Record<string, string | undefined>
}): Promise<MatOSUserFeedbackAnalysis | undefined> {
  const scope = directEditorScopeForSelfEvolution(input)
  const signals = evolutionAlgorithmSignals({
    analysis: input.feedbackAnalysis,
    scoped: !('blockedReason' in scope) && scope.scope !== 'core',
    ownedSourceEventRefs: ownedSourceEventRefsForScope(
      input.events,
      'blockedReason' in scope ? undefined : scope.scopeRef,
    ),
  })
  const decision = await input.algorithm.decide({
    schemaVersion: 1,
    phase: 'analyzed',
    trigger: { kind: input.trigger.kind, key: input.trigger.key },
    ...(!('blockedReason' in scope) && scope.scopeRef
      ? { scopeRef: scope.scopeRef }
      : {}),
    constraints: {
      canAnalyze: true,
      canEdit: selfEvolutionShouldRunDirectEditor(input),
      maxSignals: 8,
    },
    signals,
  })
  return selectEvolutionAlgorithmFeedback(
    input.feedbackAnalysis,
    decision.action === 'edit' ? decision.signalIds : [],
  )
}

async function runMatOSSelfEvolutionForSessionClaimed(
  input: MatOSSelfEvolutionRunInput,
  deps: MatOSSelfEvolutionRunDeps,
  priorRecords: MatOSSelfEvolutionMonitorRecord[],
): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  const written: MatOSSelfEvolutionMonitorRecord[] = []
  let algorithm: MatOSEvolutionAlgorithmRuntime | undefined
  const append = async (record: MatOSSelfEvolutionMonitorRecord) => {
    if (algorithm && !record.algorithm) record.algorithm = algorithm.journal()
    written.push(record)
    await appendMonitorRecord(input.cwd, record)
    // Feed the cross-session failure ledger: failed conclusions arm the
    // repeated-failure suppression, successful conclusions clear the streak.
    // No-op (zero I/O) for intermediate statuses.
    await recordMatOSEvolutionTriggerConclusionInFailureLedger({
      cwd: input.cwd,
      record,
      familyKey: triggerFamilyKey(record),
      env: deps.env,
    })
    // Feed the daily spend ledger from stage cost diagnostics so the budget
    // gate sees today's accumulated hidden LLM spend. No-op for records
    // without cost data.
    await accumulateMatOSEvolutionSpendFromMonitorRecord({
      cwd: input.cwd,
      record,
    }).catch(() => undefined)
  }

  const appendGeneratedScopedAssetSyncFailure = async (error: unknown) =>
    append(
      monitorRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        status: 'failed',
        summary: 'Generated scoped asset sync failed before self-evolution analysis.',
        priorRecords,
        error: error instanceof Error ? error.message : String(error),
      }),
    )

  let events: MatOSEventSource[]
  try {
    events = sourceEvents(
      await readMatOSSessionEventsFromPath(input.sessionPath),
      input.sessionPath,
    )
  } catch (err) {
    await append(
      monitorRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        status: 'failed',
        summary: 'Could not read session events for self-evolution.',
        priorRecords,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return written
  }

  await recoverInterruptedDirectEditorRunsForSession({
    cwd: input.cwd,
    sessionId: input.sessionId,
    trigger: input.trigger,
    events,
    deps,
    priorRecords,
    append,
  }).catch(error =>
    append(
      monitorRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        status: 'failed',
        summary:
          'Interrupted direct asset editor recovery failed before self-evolution analysis.',
        priorRecords,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  )

  if (
    shouldSkipTrivialSuccessfulSessionEvolution({
      trigger: input.trigger,
      events,
    })
  ) {
    await syncGeneratedScopedAssetsForSession({
      cwd: input.cwd,
      sessionId: input.sessionId,
      trigger: input.trigger,
      events,
      deps,
      priorRecords,
      append,
    }).catch(appendGeneratedScopedAssetSyncFailure)
    return written.length > 0 ? written : undefined
  }

  await syncGeneratedScopedAssetsForSession({
    cwd: input.cwd,
    sessionId: input.sessionId,
    trigger: input.trigger,
    events,
    deps,
    priorRecords,
    append,
  }).catch(appendGeneratedScopedAssetSyncFailure)

  const triggerQuality = evaluateMatOSSelfEvolutionTriggerQualityGate({
    trigger: input.trigger,
    events,
    env: deps.env,
  })
  if (triggerQuality.decision === 'skip') {
    await append(
      monitorRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        status: 'skipped-low-quality-trigger',
        summary: formatMatOSSelfEvolutionTriggerQualitySkipSummary(triggerQuality),
        priorRecords,
      }),
    )
    return written
  }

  algorithm = await beginEvolutionAlgorithm({ ...input, events, env: deps.env, priorRecords, append })
  if (!algorithm) return written

  const dailyBudget = await claimMatOSEvolutionDailyBudget({
    cwd: input.cwd,
    sessionId: input.sessionId,
    triggerKey: input.trigger.key,
    triggerKind: input.trigger.kind,
    env: deps.env,
  })
  if (!dailyBudget.allowed) {
    await append(
      monitorRecord({
        sessionId: input.sessionId,
        trigger: input.trigger,
        status: 'budget-denied',
        summary:
          dailyBudget.reason === 'exhausted'
            ? `Daily hidden self-evolution limit reached (${dailyBudget.limit} automatic runs); evidence remains in the session for later analysis.`
            : 'Daily hidden self-evolution budget could not be claimed safely; the automatic LLM pipeline was skipped.',
        priorRecords,
      }),
    )
    return written
  }

  await append(
    monitorRecord({
      sessionId: input.sessionId,
      trigger: input.trigger,
      status: 'detected',
      summary: input.trigger.summary,
      priorRecords,
    }),
  )

  const roleTraceEnv = hiddenEvolutionTraceEnv({
    events,
    env: deps.env,
  })
  const sharedPromptCache = await createSessionSharedPromptCacheRunner({
    cwd: input.cwd,
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    trigger: input.trigger,
    events,
    priorRecords,
    deps,
    traceEnv: roleTraceEnv,
  }).catch(() => undefined)
  const sharedRoleRunner = sharedPromptCache?.roleRunner
  const sharedRefiner: MatOSExperienceRefiner | undefined = sharedRoleRunner
    ? refinerInput =>
        refineMatOSExperienceWithLLM({
          ...refinerInput,
          roleRunner: sharedRoleRunner,
        })
    : undefined

  try {
    let feedbackAnalysis: MatOSUserFeedbackAnalysis | undefined
    let feedbackDiagnostics: MatOSUserFeedbackAnalysisDiagnostics | undefined
    try {
      if (deps.feedbackAnalyzer) {
        feedbackAnalysis = await deps.feedbackAnalyzer({
            cwd: input.cwd,
            sessionPath: input.sessionPath,
            events,
            priorLLMOutputs: {
              trigger: input.trigger,
              monitorRecords: priorRecords,
            },
          })
      } else {
        const analysisRun = await runMatOSUserFeedbackAnalysisWithDiagnostics(
          {
            cwd: input.cwd,
            sessionPath: input.sessionPath,
            events,
            priorLLMOutputs: {
              trigger: input.trigger,
              monitorRecords: priorRecords,
            },
            traceEnv: roleTraceEnv,
          },
          sharedRoleRunner,
        )
        feedbackAnalysis = analysisRun.analysis
        feedbackDiagnostics = analysisRun.diagnostics
      }
      if (feedbackDiagnostics?.quotaFailure) {
        await append(
          monitorRecord({
            sessionId: input.sessionId,
            trigger: input.trigger,
            status: 'failed',
            summary: 'The self-evolution model provider rejected the request due to insufficient balance or quota.',
            priorRecords,
            llmDiagnostics: [feedbackDiagnostics],
          }),
        )
        return written
      }
      if (feedbackDiagnostics?.authFailure) {
        await append(
          monitorRecord({
            sessionId: input.sessionId,
            trigger: input.trigger,
            status: 'failed',
            summary: 'The self-evolution critic could not authenticate with the configured model provider.',
            priorRecords,
            llmDiagnostics: [feedbackDiagnostics],
          }),
        )
        return written
      }
      // Redact once at the source so the editor prompt, experience assets, and
      // monitor record all receive scrubbed feedback (claim/why/evidenceExcerpt
      // are raw user text that can contain secrets/host paths).
      if (feedbackAnalysis) {
        feedbackAnalysis = redactTraceValue(
          feedbackAnalysis,
        ) as MatOSUserFeedbackAnalysis
      }
      await append(
        monitorRecord({
          sessionId: input.sessionId,
          trigger: input.trigger,
          status: 'analysis-complete',
          summary: feedbackAnalysis
            ? feedbackAnalysis.summary ??
              'The self-evolution critic returned an analysis without a summary.'
            : 'The self-evolution critic returned no parseable analysis (LLM failure or unparseable output).',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          ...(feedbackDiagnostics
            ? { llmDiagnostics: [feedbackDiagnostics] }
            : {}),
        }),
      )
    } catch (err) {
      await append(
        monitorRecord({
          sessionId: input.sessionId,
          trigger: input.trigger,
          status: 'failed',
          summary: 'The self-evolution critic failed.',
          priorRecords,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      return written
    }

    let experienceRefs: string[] = []
    if (matOSExperienceLayerEnabled({ trigger: input.trigger, env: deps.env })) {
      try {
        experienceRefs = await maintainMatOSExperienceAssetsForSession({
          cwd: input.cwd,
          sessionPath: input.sessionPath,
          traceEnv: roleTraceEnv,
          feedbackAnalyzer: async () => feedbackAnalysis,
          ...(deps.refiner
            ? { refiner: deps.refiner }
            : sharedRefiner
              ? { refiner: sharedRefiner }
              : {}),
        })
        await append(
          monitorRecord({
            sessionId: input.sessionId,
            trigger: input.trigger,
            status: experienceRefs.length > 0 ? 'experience-written' : 'noop',
            summary:
              experienceRefs.length > 0
                ? 'Reusable experience assets were written.'
                : 'No reusable experience asset was written for this trigger.',
            priorRecords,
            ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
            experienceRefs,
          }),
        )
      } catch (err) {
        await append(
          monitorRecord({
            sessionId: input.sessionId,
            trigger: input.trigger,
            status: 'failed',
            summary: 'Experience asset maintenance failed.',
            priorRecords,
            ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        return written
      }

      if (experienceRefs.length > 0) {
        await syncGeneratedScopedAssetsForSession({
          cwd: input.cwd,
          sessionId: input.sessionId,
          trigger: input.trigger,
          events,
          deps,
          priorRecords,
          append,
        }).catch(error =>
          append(
            monitorRecord({
              sessionId: input.sessionId,
              trigger: input.trigger,
              status: 'failed',
              summary:
                'Generated scoped asset sync failed after writing experience assets.',
              priorRecords,
              ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
              experienceRefs,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        )
      }

      if (input.trigger.experienceOnly === true) {
        return written
      }
    }

    feedbackAnalysis = await selectFeedbackWithEvolutionAlgorithm({ algorithm, trigger: input.trigger, feedbackAnalysis, events, env: deps.env })
    if (!feedbackAnalysis?.shouldUseFeedback) {
      await append(
        monitorRecord({
          sessionId: input.sessionId,
          trigger: input.trigger,
          status: 'noop',
          summary:
            'The critic and evolution algorithm did not select eligible evidence for an asset edit.',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
        }),
      )
      return written
    }

    // Re-check the daily budget before the expensive editor/judge stage: the
    // critic above (or concurrent sessions) may have exhausted a budget that
    // still had headroom at pipeline entry.
    const editorBudgetGate = await gateMatOSEvolutionDailyBudget({
      cwd: input.cwd,
      sessionId: input.sessionId,
      trigger: input.trigger,
      stage: 'direct-editor',
      priorRecords,
      env: deps.env,
      append,
    })
    if (editorBudgetGate.blocked) {
      return written
    }

    try {
      const directScope = directEditorScopeForSelfEvolution({
        events,
        env: deps.env,
      })
      if ('blockedReason' in directScope) {
        await append(
          monitorRecord({
            sessionId: input.sessionId,
            trigger: input.trigger,
            status: 'direct-edit-blocked',
            summary: directEditorScopeBlockedSummary(directScope.blockedReason),
            priorRecords,
            ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
            experienceRefs,
          }),
        )
        return written
      }
      const targetContract =
        explicitTriggerTargetContract({
          trigger: input.trigger,
          env: deps.env,
        }) ??
        buildMatOSEvolutionTargetContract({
          feedbackAnalysis,
          env: deps.env,
          scope: directScope.scope,
          ownedSourceEventRefs: ownedSourceEventRefsForScope(
            events,
            directScope.scopeRef,
          ),
        })
      const directEditorRequest: MatOSDirectAssetEditorRunInput = {
        cwd: directEditorAssetCwd({ cwd: input.cwd, env: deps.env }),
        scope: directScope.scope,
        ...(directScope.scopeRef ? { scopeRef: directScope.scopeRef } : {}),
        evolutionContext: {
          trigger: input.trigger,
          algorithm: algorithm.journal(),
          sessionPath: input.sessionPath,
          // The editor prompt serializes this context verbatim; keep it inside
          // the evolution prompt budget so long sessions cannot overflow the
          // provider context limit.
          events: boundMatOSEvolutionEventsForPrompt(events).events,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
          monitorRecords:
            compactMatOSEvolutionMonitorRecordsForPrompt(priorRecords).records,
          ...(targetContract ? { targetContract } : {}),
        },
        env: deps.env,
        ...(sharedRoleRunner
          ? {
              roleRunner: sharedRoleRunner,
              semanticJudge: judgeInput =>
                runMatOSSemanticAcceptanceJudge({
                  ...judgeInput,
                  roleRunner: sharedRoleRunner,
                }),
            }
          : {}),
      }
      const {
        directEditorRun,
        rebaseline,
        retriedAfterRebaseline,
      } = await runDirectEditorWithStaleBaselineRecovery({
        request: directEditorRequest,
        deps,
        trigger: input.trigger,
        experienceRefs,
      })
      const sessionEditOutcome = directEditMonitorOutcome(directEditorRun)
      await append(
        monitorRecord({
          sessionId: input.sessionId,
          trigger: input.trigger,
          status: sessionEditOutcome.status,
          summary: directEditMonitorSummary({
            outcome: sessionEditOutcome,
            rebaseline,
            retriedAfterRebaseline,
          }),
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
          ...(directEditorRun ? { directEditorRun } : {}),
        }),
      )
    } catch (err) {
      await append(
        monitorRecord({
          sessionId: input.sessionId,
          trigger: input.trigger,
          status: 'failed',
          summary: 'Direct asset editor failed.',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    return written
  } catch (error) {
    await append(monitorRecord({
      sessionId: input.sessionId,
      trigger: input.trigger,
      status: 'failed',
      summary: 'Self-evolution algorithm or pipeline failed before completion.',
      priorRecords,
      error: error instanceof Error ? error.message : String(error),
    }))
    return written
  } finally {
    await sharedPromptCache?.close()
  }
}

function workflowEvidenceTrigger(
  evidence: MatOSWorkflowEvidence,
): MatOSSelfEvolutionTrigger {
  const hasFailure =
    evidence.status === 'failed' ||
    evidence.nodeSummary.some(node => node.hasError || node.status === 'failed')
  if (hasFailure) {
    return {
      kind: 'workflow-failure',
      key: `workflow-failure:${evidence.evidenceId}`,
      eventId: evidence.evidenceId,
      summary: `Workflow ${evidence.workflowRef} run ${evidence.runId} failed or recovered from node errors and should be analyzed for self-evolution.`,
    }
  }
  return {
    kind: 'session-end',
    key: `workflow-session-end:${evidence.evidenceId}`,
    eventId: evidence.evidenceId,
    summary: `Workflow ${evidence.workflowRef} run ${evidence.runId} completed and should be checked for reusable experience.`,
  }
}

export async function runMatOSSelfEvolutionForWorkflowEvidence(
  input: MatOSSelfEvolutionWorkflowInput,
  deps: MatOSSelfEvolutionRunDeps = {},
): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  const sessionId = workflowEvidenceSessionId(input.evidence)
  const trigger = workflowEvidenceTrigger(input.evidence)
  const runningKey = activeTriggerKey({
    cwd: input.cwd,
    sessionId,
    triggerKey: trigger.key,
  })
  if (activeTriggerKeys.has(runningKey)) {
    return undefined
  }
  activeTriggerKeys.add(runningKey)
  try {
    return await runMatOSSelfEvolutionForWorkflowEvidenceUnlocked(
      input,
      trigger,
      sessionId,
      deps,
    )
  } finally {
    activeTriggerKeys.delete(runningKey)
  }
}

async function runMatOSSelfEvolutionForWorkflowEvidenceUnlocked(
  input: MatOSSelfEvolutionWorkflowInput,
  trigger: MatOSSelfEvolutionTrigger,
  sessionId: string,
  deps: MatOSSelfEvolutionRunDeps = {},
): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  if (input.hidden || !shouldRunHiddenLLM(deps)) {
    return undefined
  }
  if (await selfEvolutionDisabledForTrigger({ cwd: input.cwd, trigger, env: deps.env })) {
    return undefined
  }
  return await withMatOSEvolutionTriggerClaim(
    {
      cwd: input.cwd,
      sessionId,
      triggerKey: trigger.key,
    },
    async () => {
      const priorRecords = await readMonitorRecordsForSession(
        input.cwd,
        sessionId,
      )
      if (shouldSuppressEvolutionTrigger(priorRecords, trigger, deps.env)) {
        return undefined
      }
      // Same cross-session failure suppression and daily budget gate as the
      // session path (see runMatOSSelfEvolutionForSessionUnlocked).
      const crossSessionSuppression =
        await suppressMatOSEvolutionTriggerForRepeatedFailures({
          cwd: input.cwd,
          sessionId,
          trigger,
          env: deps.env,
        })
      if (crossSessionSuppression.suppressed) {
        return crossSessionSuppression.noticeRecord
          ? [crossSessionSuppression.noticeRecord]
          : undefined
      }
      const entryBudgetGate = await gateMatOSEvolutionDailyBudget({
        cwd: input.cwd,
        sessionId,
        trigger,
        stage: 'pipeline-entry',
        priorRecords,
        env: deps.env,
      })
      if (entryBudgetGate.blocked) {
        return entryBudgetGate.skipRecord
          ? [entryBudgetGate.skipRecord]
          : undefined
      }
      return await runMatOSSelfEvolutionForWorkflowEvidenceClaimed(
        input,
        trigger,
        sessionId,
        deps,
        priorRecords,
      )
    },
  )
}

async function runMatOSSelfEvolutionForWorkflowEvidenceClaimed(
  input: MatOSSelfEvolutionWorkflowInput,
  trigger: MatOSSelfEvolutionTrigger,
  sessionId: string,
  deps: MatOSSelfEvolutionRunDeps,
  priorRecords: MatOSSelfEvolutionMonitorRecord[],
): Promise<MatOSSelfEvolutionMonitorRecord[] | undefined> {
  const written: MatOSSelfEvolutionMonitorRecord[] = []
  let algorithm: MatOSEvolutionAlgorithmRuntime | undefined
  const append = async (record: MatOSSelfEvolutionMonitorRecord) => {
    if (algorithm && !record.algorithm) record.algorithm = algorithm.journal()
    written.push(record)
    await appendMonitorRecord(input.cwd, record)
    await recordMatOSEvolutionTriggerConclusionInFailureLedger({
      cwd: input.cwd,
      record,
      familyKey: triggerFamilyKey(record),
      env: deps.env,
    })
    await accumulateMatOSEvolutionSpendFromMonitorRecord({
      cwd: input.cwd,
      record,
    }).catch(() => undefined)
  }

  const events = workflowEvidenceEvents(input.evidence)
  const sessionPath = workflowEvidenceSessionPath(input.evidence)
  const triggerQuality = evaluateMatOSSelfEvolutionTriggerQualityGate({
    trigger,
    events,
    env: deps.env,
  })
  if (triggerQuality.decision === 'skip') {
    await append(
      monitorRecord({
        sessionId,
        trigger,
        status: 'skipped-low-quality-trigger',
        summary: formatMatOSSelfEvolutionTriggerQualitySkipSummary(triggerQuality),
        priorRecords,
      }),
    )
    return written
  }

  algorithm = await beginEvolutionAlgorithm({ cwd: input.cwd, sessionId, trigger, events, env: deps.env, priorRecords, append })
  if (!algorithm) return written

  const dailyBudget = await claimMatOSEvolutionDailyBudget({
    cwd: input.cwd,
    sessionId,
    triggerKey: trigger.key,
    triggerKind: trigger.kind,
    env: deps.env,
  })
  if (!dailyBudget.allowed) {
    await append(
      monitorRecord({
        sessionId,
        trigger,
        status: 'budget-denied',
        summary:
          dailyBudget.reason === 'exhausted'
            ? `Daily hidden self-evolution limit reached (${dailyBudget.limit} automatic runs); evidence remains in the workflow record for later analysis.`
            : 'Daily hidden self-evolution budget could not be claimed safely; the automatic workflow LLM pipeline was skipped.',
        priorRecords,
      }),
    )
    return written
  }

  await append(
    monitorRecord({
      sessionId,
      trigger,
      status: 'detected',
      summary: trigger.summary,
      priorRecords,
    }),
  )

  // Same scope/user propagation as the session path: without it the hidden
  // stage children resolved provider credentials against the worker process
  // env only, which loses scoped provider profiles for workflow runs.
  const roleTraceEnv = hiddenEvolutionTraceEnv({ events, env: deps.env })
  const sharedPromptCache = await createWorkflowSharedPromptCacheRunner({
    cwd: input.cwd,
    sessionId,
    sessionPath,
    trigger,
    events,
    workflowEvidence: input.evidence,
    priorRecords,
    deps,
    traceEnv: roleTraceEnv,
  }).catch(() => undefined)
  const sharedRoleRunner = sharedPromptCache?.roleRunner
  const sharedRefiner: MatOSExperienceRefiner | undefined = sharedRoleRunner
    ? refinerInput =>
        refineMatOSExperienceWithLLM({
          ...refinerInput,
          roleRunner: sharedRoleRunner,
        })
    : undefined

  try {
    let feedbackAnalysis: MatOSUserFeedbackAnalysis | undefined
    let feedbackDiagnostics: MatOSUserFeedbackAnalysisDiagnostics | undefined
    try {
      if (deps.feedbackAnalyzer) {
        feedbackAnalysis = await deps.feedbackAnalyzer({
            cwd: input.cwd,
            sessionPath,
            events,
            priorLLMOutputs: {
              trigger,
              workflowEvidence: input.evidence,
              monitorRecords: priorRecords,
            },
          })
      } else {
        const analysisRun = await runMatOSUserFeedbackAnalysisWithDiagnostics(
          {
            cwd: input.cwd,
            sessionPath,
            events,
            priorLLMOutputs: {
              trigger,
              workflowEvidence: input.evidence,
              monitorRecords: priorRecords,
            },
            traceEnv: roleTraceEnv,
          },
          sharedRoleRunner,
        )
        feedbackAnalysis = analysisRun.analysis
        feedbackDiagnostics = analysisRun.diagnostics
      }
      // Redact once at the source (see session path) before the analysis flows
      // into the editor prompt, experience assets, and monitor record.
      if (feedbackAnalysis) {
        feedbackAnalysis = redactTraceValue(
          feedbackAnalysis,
        ) as MatOSUserFeedbackAnalysis
      }
      await append(
        monitorRecord({
          sessionId,
          trigger,
          status: 'analysis-complete',
          summary: feedbackAnalysis
            ? feedbackAnalysis.summary ??
              'The self-evolution critic returned an analysis without a summary.'
            : 'The self-evolution critic returned no parseable workflow analysis (LLM failure or unparseable output).',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          ...(feedbackDiagnostics
            ? { llmDiagnostics: [feedbackDiagnostics] }
            : {}),
        }),
      )
    } catch (err) {
      await append(
        monitorRecord({
          sessionId,
          trigger,
          status: 'failed',
          summary: 'The self-evolution critic failed on workflow evidence.',
          priorRecords,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      return written
    }

    let experienceRefs: string[] = []
    if (matOSExperienceLayerEnabled({ trigger, env: deps.env })) {
      try {
        experienceRefs = await (deps.maintainWorkflow ??
          maintainMatOSExperienceAssetsForWorkflowEvidence)({
          cwd: input.cwd,
          evidence: input.evidence,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          ...(deps.refiner
            ? { refiner: deps.refiner }
            : sharedRefiner
              ? { refiner: sharedRefiner }
              : {}),
        })
        await append(
          monitorRecord({
            sessionId,
            trigger,
            status: experienceRefs.length > 0 ? 'experience-written' : 'noop',
            summary:
              experienceRefs.length > 0
                ? 'Reusable workflow experience assets were written.'
                : 'No reusable workflow experience asset was written for this trigger.',
            priorRecords,
            ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
            experienceRefs,
          }),
        )
      } catch (err) {
        await append(
          monitorRecord({
            sessionId,
            trigger,
            status: 'failed',
            summary: 'Workflow experience asset maintenance failed.',
            priorRecords,
            ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        return written
      }

      if (experienceRefs.length > 0) {
        await syncGeneratedScopedAssetsForSession({
          cwd: input.cwd,
          sessionId,
          trigger,
          events,
          deps,
          priorRecords,
          append,
        }).catch(error =>
          append(
            monitorRecord({
              sessionId,
              trigger,
              status: 'failed',
              summary:
                'Generated scoped asset sync failed after writing workflow experience assets.',
              priorRecords,
              ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
              experienceRefs,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        )
      }

      if (trigger.experienceOnly === true) {
        return written
      }
    }

    feedbackAnalysis = await selectFeedbackWithEvolutionAlgorithm({ algorithm, trigger, feedbackAnalysis, events, env: deps.env })
    if (!feedbackAnalysis?.shouldUseFeedback) {
      await append(
        monitorRecord({
          sessionId,
          trigger,
          status: 'noop',
          summary:
            'The critic and evolution algorithm did not select eligible workflow evidence for an asset edit.',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
        }),
      )
      return written
    }

    // Same editor-stage budget re-check as the session path.
    const editorBudgetGate = await gateMatOSEvolutionDailyBudget({
      cwd: input.cwd,
      sessionId,
      trigger,
      stage: 'direct-editor',
      priorRecords,
      env: deps.env,
      append,
    })
    if (editorBudgetGate.blocked) {
      return written
    }

    try {
      const directScope = directEditorScopeForSelfEvolution({
        events,
        env: deps.env,
      })
      if ('blockedReason' in directScope) {
        await append(
          monitorRecord({
            sessionId,
            trigger,
            status: 'direct-edit-blocked',
            summary: directEditorScopeBlockedSummary(directScope.blockedReason),
            priorRecords,
            ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
            experienceRefs,
          }),
        )
        return written
      }
      const targetContract =
        explicitTriggerTargetContract({
          trigger,
          env: deps.env,
        }) ??
        buildMatOSEvolutionTargetContract({
          feedbackAnalysis,
          workflowEvidence: input.evidence,
          env: deps.env,
          scope: directScope.scope,
          ownedSourceEventRefs: ownedSourceEventRefsForScope(
            events,
            directScope.scopeRef,
          ),
        })
      const directEditorRequest: MatOSDirectAssetEditorRunInput = {
        cwd: directEditorAssetCwd({ cwd: input.cwd, env: deps.env }),
        scope: directScope.scope,
        ...(directScope.scopeRef ? { scopeRef: directScope.scopeRef } : {}),
        evolutionContext: {
          trigger,
          algorithm: algorithm.journal(),
          sessionPath,
          events: boundMatOSEvolutionEventsForPrompt(events).events,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
          monitorRecords:
            compactMatOSEvolutionMonitorRecordsForPrompt(priorRecords).records,
          workflowEvidence: input.evidence,
          ...(targetContract ? { targetContract } : {}),
        },
        env: deps.env,
        ...(sharedRoleRunner
          ? {
              roleRunner: sharedRoleRunner,
              semanticJudge: judgeInput =>
                runMatOSSemanticAcceptanceJudge({
                  ...judgeInput,
                  roleRunner: sharedRoleRunner,
                }),
            }
          : {}),
      }
      const {
        directEditorRun,
        rebaseline,
        retriedAfterRebaseline,
      } = await runDirectEditorWithStaleBaselineRecovery({
        request: directEditorRequest,
        deps,
        trigger,
        experienceRefs,
      })
      const workflowEditOutcome = directEditMonitorOutcome(directEditorRun)
      await append(
        monitorRecord({
          sessionId,
          trigger,
          status: workflowEditOutcome.status,
          summary: directEditorRun
            ? directEditMonitorSummary({
                outcome: workflowEditOutcome,
                rebaseline,
                retriedAfterRebaseline,
              })
            : 'Direct asset editor had no applicable workflow target.',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
          ...(directEditorRun ? { directEditorRun } : {}),
        }),
      )
    } catch (err) {
      await append(
        monitorRecord({
          sessionId,
          trigger,
          status: 'failed',
          summary: 'Direct asset editor failed on workflow evidence.',
          priorRecords,
          ...(feedbackAnalysis ? { feedbackAnalysis } : {}),
          experienceRefs,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    return written
  } catch (error) {
    await append(monitorRecord({
      sessionId,
      trigger,
      status: 'failed',
      summary: 'Workflow self-evolution algorithm or pipeline failed before completion.',
      priorRecords,
      error: error instanceof Error ? error.message : String(error),
    }))
    return written
  } finally {
    await sharedPromptCache?.close()
  }
}

// Semantic fallback for turn-level user feedback that the keyword fast path
// missed. Runs one cached hidden LLM classification per non-keyword user turn;
// session-end analysis still covers anything this path skips.
async function semanticTurnFeedbackTriggerForEvent(input: {
  cwd: string
  sessionId: string
  event: MatOSEvent
  deps: MatOSSelfEvolutionRunDeps
}): Promise<MatOSSelfEvolutionTrigger | undefined> {
  if (input.event.type !== 'matos.turn.started') {
    return undefined
  }
  const env = input.deps.env ?? process.env
  if (!turnSemanticClassifierEnabled(env)) {
    return undefined
  }
  const prompt =
    stringValue(input.event.data.prompt ?? input.event.data.promptPreview) ?? ''
  if (!shouldSemanticallyClassifyTurnPrompt(prompt)) {
    return undefined
  }
  if (!input.deps.turnFeedbackClassifier && env.NODE_ENV === 'test') {
    return undefined
  }
  const classify =
    input.deps.turnFeedbackClassifier ?? classifyMatOSTurnFeedbackWithLLM
  const classification = await classify({
    cwd: input.cwd,
    sessionId: input.sessionId,
    eventId: input.event.id,
    prompt,
  }).catch(() => undefined)
  const kinds = realtimeTurnFeedbackKinds(classification)
  if (kinds.length === 0) {
    return undefined
  }
  return {
    kind: 'user-feedback',
    key: `user-feedback:${input.event.id}`,
    eventId: input.event.id,
    summary: `User feedback (${kinds.join(', ')}) was detected by the semantic turn classifier and should be analyzed for self-evolution.`,
  }
}

function observedSelfEvolutionShouldRunInline(
  deps: MatOSSelfEvolutionRunDeps,
): boolean {
  return Object.keys(deps).length > 0
}

function realtimeTurnFeedbackCandidateTriggerForEvent(input: {
  event: MatOSEvent
  deps: MatOSSelfEvolutionRunDeps
}): MatOSSelfEvolutionTrigger | undefined {
  if (input.event.type !== 'matos.turn.started') {
    return undefined
  }
  const env = input.deps.env ?? process.env
  if (!turnSemanticClassifierEnabled(env)) {
    return undefined
  }
  const prompt =
    stringValue(input.event.data.prompt ?? input.event.data.promptPreview) ?? ''
  if (!shouldSemanticallyClassifyTurnPrompt(prompt)) {
    return undefined
  }
  return {
    kind: 'user-feedback',
    key: `user-feedback:${input.event.id}`,
    eventId: input.event.id,
    summary:
      'Potential user feedback matched the realtime turn-feedback heuristic and should be analyzed for self-evolution.',
    // Only a length/slash heuristic ran here. The receiving run (worker or
    // scheduled fallback) must re-run the semantic classifier before starting
    // the hidden pipeline; see confirmSemanticCandidateTriggerFromSession.
    semanticCandidate: true,
  }
}

function scheduleObservedSelfEvolutionFallback(input: {
  cwd: string
  sessionId: string
  sessionPath: string
  trigger: MatOSSelfEvolutionTrigger
  hidden?: boolean
  deps: MatOSSelfEvolutionRunDeps
}): void {
  if (evolutionWorkerSuppressedByEnv()) {
    return
  }
  const rawDelay = Number(process.env.MATOS_BACKGROUND_EVOLUTION_DELAY_MS)
  const delayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1000
  const timer = setTimeout(() => {
    void runMatOSSelfEvolutionForSession(
      {
        cwd: input.cwd,
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        trigger: input.trigger,
        hidden: input.hidden,
      },
      input.deps,
    ).catch(() => {
      // Background self-evolution must never fail the foreground user path.
    })
  }, delayMs)
  timer.unref?.()
}

export async function observeMatOSSelfEvolutionEvent(input: {
  cwd: string
  sessionId: string
  sessionPath: string
  event: MatOSEvent
  hidden?: boolean
  deps?: MatOSSelfEvolutionRunDeps
}): Promise<void> {
  if (evolutionWorkerSuppressedByEnv()) {
    return
  }
  if (input.hidden) {
    return
  }
  let events: MatOSEvent[] = [input.event]
  // Only the repeated-tool-call detector needs prior history. Reading the whole
  // session JSONL on every observed event is O(n^2) over a long session, so
  // restrict the full read to tool-call completions.
  if (input.event.type === 'matos.tool.call.completed') {
    try {
      const read = await readMatOSSessionEventsFromPath(input.sessionPath)
      events = read.some(event => event.id === input.event.id)
        ? read
        : [...read, input.event]
    } catch {
      // The just-appended event is still enough for non-repetition triggers.
    }
  }
  const deps = input.deps ?? {}
  const runInline = observedSelfEvolutionShouldRunInline(deps)
  let trigger = classifySelfEvolutionTrigger(input.event, events)
  if (!trigger) {
    trigger = runInline
      ? await semanticTurnFeedbackTriggerForEvent({
          cwd: input.cwd,
          sessionId: input.sessionId,
          event: input.event,
          deps,
        })
      : realtimeTurnFeedbackCandidateTriggerForEvent({
          event: input.event,
          deps,
        })
  }
  if (!trigger) {
    return
  }
  // Session-close worker owns session-end triggers; avoid duplicate runs with observe.
  if (trigger.kind === 'session-end') {
    return
  }
  if (!runInline) {
    if (
      spawnSessionTriggerEvolutionWorker({
        cwd: input.cwd,
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        trigger,
        hidden: input.hidden,
      })
    ) {
      return
    }
    scheduleObservedSelfEvolutionFallback({
      cwd: input.cwd,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      trigger,
      hidden: input.hidden,
      deps,
    })
    return
  }
  await runMatOSSelfEvolutionForSession(
    {
      cwd: input.cwd,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      trigger,
      hidden: input.hidden,
    },
    deps,
  )
}

export async function listMatOSSelfEvolutionMonitorRecords(
  cwd: string,
): Promise<MatOSSelfEvolutionMonitorRecord[]> {
  return listMatOSSelfEvolutionMonitorRecordLedger(cwd)
}

export async function readMatOSSelfEvolutionMonitorRecord(
  cwd: string,
  recordId: string,
): Promise<MatOSSelfEvolutionMonitorRecord | undefined> {
  return readMatOSSelfEvolutionMonitorRecordFromLedger(cwd, recordId)
}
