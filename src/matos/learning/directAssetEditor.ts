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

import { randomBytes } from 'node:crypto'
import { withEvolutionSourceLease } from './evolutionSourceLease.js'
import type { MatOSEvolutionAlgorithmJournal } from '../algorithms/evolution/protocol.js'
import { createMatOSEvolutionAlgorithmRuntime } from './evolutionAlgorithmRuntime.js'
import { observeDirectEditorAssetChanges } from './directAssetEditorChanges.js'
import { recordEvolutionAlgorithmOutcome } from './evolutionAlgorithmOutcome.js'
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  createMatOSAssetHistorySnapshot,
  hasMatOSAssetHistoryWorkingTreeChanges,
  listMatOSAssetHistoryWorkingTreeChangedFiles,
  readMatOSAssetHistorySnapshot,
  restoreMatOSAssetHistorySnapshot,
  validateMatOSAssetHistorySnapshot,
  matOSAssetHistoryLatestRef,
  withMatOSAssetHistoryLock,
  type MatOSAssetHistorySnapshotRecord,
  type MatOSAssetHistoryValidationResult,
} from '../assets/history/index.js'
import {
  assertNoSymlinkPathComponent,
  matOSAssetHistoryLogicalPath,
  matOSAssetHistoryAllowedRoots,
  normalizeMatOSAssetHistoryRelativePath,
  resolveMatOSAssetHistoryRecordPath,
} from '../assets/history/policy.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { MATOS_GITEA_TOKEN_KEYS, matOSGiteaEnvValueWithProcessFallback } from '../assets/giteaOperatorEnv.js'
import { matOSGitAssetSourceCheckoutRoot } from '../assets/sourceAdapters.js'
import { matOSGitBranchName } from '../assets/giteaAcceptance.js'
import { matOSGiteaApiUrlFromSourceRepo, resolveMatOSGitAssetSourceRuntimeRepo } from '../assets/giteaRuntimeTransport.js'
import { preflightEvolutionGiteaSources } from './evolutionGiteaPreflight.js'
import { evolutionInfrastructureFailureCode } from './evolutionInfrastructure.js'
import { resolvedDirectEditorScopeRef } from './directAssetEditorScope.js'
import {
  resolveMatOSEvolutionApprovalMode,
  type MatOSEvolutionApprovalMode,
} from './evolutionApprovalPolicy.js'
import {
  type MatOSGitAssetSourceCommitResult,
} from '../assets/sourceAdapters.js'
import {
  readMatOSProjectConfig,
  type MatOSGitAssetSourceConfig,
  type MatOSProjectConfig,
} from '../project.js'
import type { MatOSEventSource } from '../sessions/eventTypes.js'
import {
  resolveEvolutionRoleTimeoutMs,
  runEvolutionRole,
  type EvolutionRoleInvocationInput,
  type EvolutionRoleRunResult,
  type MatOSEvolutionModelUsage,
  type MatOSEvolutionUsage,
} from './evolutionRoleRunner.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'
export type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'
import {
  assertDirectEditorWritableRoots,
  backupImportPath,
  captureDirectEditorWorkspaceGuard,
  captureImportPathEntry,
  captureProtectedCoreFiles,
  createDirectEditorIsolationWorkspace,
  directEditorScopedPermissionArgs,
  editableRoots,
  ensureCwdLocalCoreEditablePack,
  guardKeyForPath,
  pruneEmptyDirectoriesToBase,
  restoreDirectEditorImportBackups,
  restoreDirectEditorWorkspaceGuardChanges,
  restoreProtectedCoreFileChanges,
  writeImportedAssetEntry,
  type DirectEditorImportBackup,
  type DirectEditorIsolationWorkspace,
  type DirectEditorWorkspaceGuardSnapshot,
  type GuardedPathEntry,
  type ProtectedCoreFileSnapshot,
} from './directAssetEditorFilesystem.js'
export { ensureCwdLocalCoreEditablePack } from './directAssetEditorFilesystem.js'
import {
  assertPathStaysUnderRoot,
} from './evolutionRecordPaths.js'
import {
  createDirectEditorAfterSnapshot,
  createDirectEditorBeforeSnapshot,
  createDirectEditorRollbackSnapshot,
  rollbackDirectEditorToBefore,
  stableCommitForDirectEditorScope,
  stableSnapshotForDirectEditorScope,
  updateDirectEditorStableRef,
  writeDirectEditorDiffPatch,
} from './directAssetEditorTransaction.js'
import type {
  MatOSUserFeedbackAnalysis,
  MatOSUserFeedbackDecision,
} from './userFeedbackSignals.js'
import {
  runMatOSSemanticAcceptanceJudge,
  type MatOSSemanticAcceptanceJudge,
  type MatOSSemanticAcceptanceResult,
  type MatOSSemanticAcceptanceRisk,
  type MatOSSemanticAcceptanceVerdict,
} from './semanticAcceptanceJudge.js'
import {
  createMatOSGiteaBranch,
  createMatOSGiteaPullRequest,
  deleteMatOSGiteaFile,
  writeMatOSGiteaTextFile,
  type MatOSGiteaContentWriteResult,
} from '../assets/giteaClient.js'
import {
  commitAcceptedDirectEditorGitAssetSources,
  directEditorAssetSourceMatchesRunScope,
  directEditorSourceAcceptanceFailureMessage,
  restoreDirectEditorAcceptedSourceState,
} from './directAssetEditorSourceAcceptance.js'
import {
  buildPromptInput,
  directEditorPrompt,
  normalizeEditorOutput,
} from './directAssetEditorPrompt.js'
import {
  DirectEditorImportError,
  directEditorIsolationDiffersFromSnapshot,
  importDirectEditorAllowedRootsFromIsolation,
} from './directAssetEditorImport.js'
import {
  directEditorPendingMergeDir,
  directEditorRunDir,
  readMatOSDirectAssetEditorPendingMergeRecord,
  readMatOSDirectAssetEditorRunRecord,
  listMatOSDirectAssetEditorPendingMergeRecords,
  listMatOSDirectAssetEditorRunRecords,
  writeDirectEditorRunFile,
  writeMatOSDirectAssetEditorPendingMergeRecord,
  writeMatOSDirectAssetEditorRunRecord,
} from './directAssetEditorRecords.js'
import {
  buildPreviousAttemptFromRecord,
  resolveDirectEditorMaxAttempts,
  summarizeDirectEditorAttempt,
} from './directAssetEditorAttempts.js'
import { runMatOSDirectAssetEditorRetention } from './directAssetEditorRetention.js'
import {
  evaluateMatOSEvolutionHighRiskAssetPolicy,
  evaluateMatOSEvolutionTargetConformance,
  highRiskAssetPolicyBlocksAcceptance,
  targetConformanceBlocksAcceptance,
  type MatOSDirectAssetEditorAcceptanceEvidence,
  type MatOSDirectAssetEditorTargetDecision,
  type MatOSEvolutionTargetContract,
} from './evolutionTargetGovernance.js'

const DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS = 5 * 60_000

export type MatOSDirectAssetEditorExperienceSummary = {
  assetRef: string
  name: string
  description?: string
  manifestPath: string
  entryPath?: string
  recommendedActions: string[]
  scenario?: Record<string, unknown>
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  directEditFeedbackDecisions?: MatOSUserFeedbackDecision[]
  evidenceRefs: string[]
  targetAssetRefs?: string[]
  targetAssetTypes?: MatOSDirectAssetEditorTargetSummary['type'][]
  directEditRecommended?: boolean
  excerpt?: string
}

async function evolutionAlgorithmAcceptsCandidate(input: {
  cwd: string
  promptInput: MatOSDirectAssetEditorPromptInput
  semanticAcceptance: MatOSSemanticAcceptanceResult
  acceptanceEvidence: MatOSDirectAssetEditorAcceptanceEvidence
  env?: Record<string, string | undefined>
}): Promise<boolean> {
  const context = input.promptInput.currentEvolutionContext
  if (!context?.algorithm) return true // Operator/legacy transactions predate algorithm binding.
  const algorithm = await createMatOSEvolutionAlgorithmRuntime({
    cwd: input.cwd,
    scopeRef: input.promptInput.scopeRef ?? input.promptInput.scope,
    env: input.env,
    journal: context.algorithm,
  })
  const decision = await algorithm.decide({
    schemaVersion: 1,
    phase: 'evaluated',
    trigger: {
      kind: context.trigger?.kind ?? 'manual-evolve',
      key: context.trigger?.key ?? 'manual',
    },
    ...(input.promptInput.scopeRef
      ? { scopeRef: input.promptInput.scopeRef }
      : {}),
    constraints: { canAnalyze: false, canEdit: false, maxSignals: 0 },
    signals: [],
    candidate: {
      nativeGatesPassed: input.semanticAcceptance.verdict === 'accept',
      semanticVerdict: input.semanticAcceptance.verdict,
      changedAssetRefs: input.acceptanceEvidence.observedChanges?.actualRefs,
    },
  })
  context.algorithm = algorithm.journal()
  return decision.action === 'retain'
}

export type MatOSDirectAssetEditorTargetSummary = {
  assetRef: string
  type: 'role' | 'skill' | 'workflow' | 'tool' | 'mcp' | 'knowledge'
  name: string
  description?: string
  lifecycle: string
  manifestPath: string
  entryPath?: string
  editableFiles: string[]
  excerpt?: string
}

export type MatOSDirectAssetEditorPromptInput = {
  generatedAt: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  editableRoots: string[]
  targetAssetCreationRoots?: string[]
  currentEvolutionContext?: MatOSDirectAssetEditorRunContext
  targetContract?: MatOSEvolutionTargetContract
  experiences: MatOSDirectAssetEditorExperienceSummary[]
  targetAssets: MatOSDirectAssetEditorTargetSummary[]
  // When a previous attempt in the same self-evolution run was rolled back by a
  // post-edit gate, the bounded retry loop feeds the rejection evidence back to
  // the editor so the next attempt can correct it instead of repeating it.
  previousAttempts?: MatOSDirectAssetEditorPreviousAttempt[]
}

// Why an edit attempt was rejected/unusable, passed to the next attempt's editor.
export type MatOSDirectAssetEditorRejectionStage =
  | 'editor-failed'
  | 'no-op-no-edit'
  | 'gate1-validation'
  | 'gate2-semantic'
  | 'unknown'

// Compact, secret-free feedback the retry loop injects into the next attempt.
export type MatOSDirectAssetEditorPreviousAttempt = {
  attempt: number
  rejectionStage: MatOSDirectAssetEditorRejectionStage
  reason: string
  introducedValidationErrors?: string[]
  judgeReason?: string
  overfitRisk?: MatOSSemanticAcceptanceRisk
  assetPollutionRisk?: MatOSSemanticAcceptanceRisk
  missingEvidence?: string[]
  recommendedFollowup?: string[]
}

// Concrete on-disk paths injected into the editor prompt only (not persisted in
// the run record). The hidden editor runs inside an isolation workspace whose
// absolute path it does not otherwise know; without this it probes wrong paths
// (e.g. /workspace, /root) and can wrongly conclude it has no file-editing
// tools, producing a no-op instead of a real edit.
export type MatOSDirectAssetEditorPromptRuntime = {
  workingDirectory: string
  editableAbsoluteRoots: string[]
}

// Per-attempt provenance recorded on the decisive run record for multi-attempt
// runs so inspection surfaces can see the full edit -> reject -> re-edit chain.
export type MatOSDirectAssetEditorAttemptSummary = {
  attempt: number
  runId: string
  status: MatOSDirectAssetEditorRunRecord['status']
  rejectionStage?: MatOSDirectAssetEditorRejectionStage
  reason?: string
  introducedValidationErrorCount?: number
  judgeVerdict?: MatOSSemanticAcceptanceVerdict
  judgeReason?: string
  missingEvidence?: string[]
  recommendedFollowup?: string[]
}

export type MatOSDirectAssetEditorRunContext = {
  algorithm?: MatOSEvolutionAlgorithmJournal
  trigger?: {
    kind: string
    key: string
    eventId?: string
    summary: string
  }
  sessionPath?: string
  events?: MatOSEventSource[]
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  experienceRefs?: string[]
  monitorRecords?: unknown[]
  workflowEvidence?: unknown
  targetContract?: MatOSEvolutionTargetContract
}

export type MatOSDirectAssetEditorOutput = {
  summary: string
  targetDecision?: MatOSDirectAssetEditorTargetDecision
  modifiedFiles: string[]
  createdAssets: string[]
  updatedAssets: string[]
  disabledAssets: string[]
  evidenceRefs: string[]
  expectedBehaviorChange?: string
  nextSessionEffect?: string
}

export type MatOSDirectAssetEditorMergeMode =
  | 'clean'
  | 'dirty-auto'
  | 'dirty-three-way'
  | 'conflict'

export type MatOSDirectAssetEditorMergeConflict = {
  path: string
  reason: string
}

export type MatOSDirectAssetEditorGiteaReview = {
  provider: 'gitea'
  status: 'created' | 'disabled' | 'failed'
  owner: string
  repo: string
  branch: string
  baseBranch: string
  createdAt: string
  updatedAt: string
  pullRequest?: {
    number: number
    url?: string
    state?: string
  }
  files?: Array<{
    path: string
    action: MatOSGiteaContentWriteResult['action'] | 'skipped'
    reason?: string
  }>
  error?: string
}

export type MatOSDirectAssetEditorSourceCommitError = {
  sourceId: string
  error: string
}

export type MatOSDirectAssetEditorSourceAcceptance = {
  sourceId: string
  acceptedBranch: string
  commit: string
  ok: boolean
  pushed: boolean
  previousAcceptedCommit?: string
  validationOk: boolean
  validationErrors?: string[]
  statusWritten?: boolean
  audit?: {
    jsonPath: string
    summaryPath: string
    diffPath?: string
  }
  auditStatusWritten?: boolean
}

export type MatOSDirectAssetEditorSourceRollbackTarget = {
  sourceId: string
  acceptedBranch: string
  commit: string
  expectedRemoteCommit?: string
  pushed: boolean
}

export type MatOSDirectAssetEditorPendingMergeRecord = {
  schemaVersion: 1
  runId: string
  status: 'pending' | 'aborted'
  createdAt: string
  updatedAt: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  mergeMode: 'conflict'
  dirtyFilesAtStart: string[]
  conflicts: MatOSDirectAssetEditorMergeConflict[]
  files: Array<{
    path: string
    basePath: string
    baseKind?: 'file' | 'absent' | 'symlink' | 'dir'
    currentPath: string
    currentKind?: 'file' | 'absent' | 'symlink' | 'dir'
    editPath: string
    editKind?: 'file' | 'absent' | 'symlink' | 'dir'
  }>
  runRecordPath: string
  giteaReview?: MatOSDirectAssetEditorGiteaReview
}

export type MatOSDirectAssetEditorPendingMergeStrategy =
  | 'current'
  | 'edit'
  | 'base'

export type MatOSDirectAssetEditorPendingMergeApplyResult = {
  status: 'applied'
  strategy: MatOSDirectAssetEditorPendingMergeStrategy
  run: MatOSDirectAssetEditorRunRecord
  pendingMerge: MatOSDirectAssetEditorPendingMergeRecord
  afterSnapshot: string
  validation: MatOSAssetHistoryValidationResult
  introducedValidationErrors: unknown[]
}

export type MatOSDirectAssetEditorRoleRunner = (
  input: EvolutionRoleInvocationInput,
) => Promise<EvolutionRoleRunResult>

export type MatOSDirectAssetEditorRunInput = {
  cwd: string
  scope?: MatOSDirectAssetEditorScope
  scopeRef?: string
  evolutionContext?: MatOSDirectAssetEditorRunContext
  runId?: string
  roleRunner?: MatOSDirectAssetEditorRoleRunner
  semanticJudge?: MatOSSemanticAcceptanceJudge
  env?: Record<string, string | undefined>
}

export type MatOSDirectAssetEditor = (
  input: MatOSDirectAssetEditorRunInput,
) => Promise<MatOSDirectAssetEditorRunRecord | undefined>

export type MatOSDirectAssetEditorRunStatus =
  | 'edited'
  | 'noop'
  | 'failed'
  | 'validated'
  | 'accepted'
  | 'accepted_merged'
  | 'pending_merge'
  | 'blocked'
  | 'rolled_back'
  | 'rollback_failed'
  // Passed every gate under the manual approval mode; the live tree was put
  // back and the after snapshot waits for a human decision.
  | 'proposed'
  // A proposal a human declined.
  | 'rejected'

export type MatOSDirectAssetEditorProposal = {
  proposedAt: string
  approvalMode: MatOSEvolutionApprovalMode
  // Paths the approval re-applies; absent for non-isolation runs, which then
  // require an unchanged scope tree.
  touchedPaths?: string[]
  decision?: 'approved' | 'rejected'
  decidedAt?: string
  note?: string
  // The judged after snapshot; on approval afterSnapshot moves to the snapshot
  // taken of the live tree after the proposal was applied.
  proposedAfterSnapshot?: string
  lastApprovalError?: string
}

export type MatOSDirectAssetEditorRunRecord = {
  algorithmOutcomeRecorded?: boolean
  /** Live tree immediately before import, including concurrent non-conflicting edits. */
  rollbackBaseSnapshot?: string
  runId: string
  status: MatOSDirectAssetEditorRunStatus
  rawStatus?: MatOSDirectAssetEditorRunStatus
  statusReason?: string
  createdAt: string
  updatedAt: string
  scope: MatOSDirectAssetEditorScope
  input: MatOSDirectAssetEditorPromptInput
  editorOutput: MatOSDirectAssetEditorOutput
  modifiedFiles: string[]
  createdAssets: string[]
  updatedAssets: string[]
  disabledAssets: string[]
  evidenceRefs: string[]
  // Logical asset-history paths this run actually wrote during import (plus
  // relocation targets). Unlike editorOutput.modifiedFiles (LLM self-report),
  // this list is produced by the import machinery itself, so recovery and
  // rollback scoping can trust it.
  importedTouchedPaths?: string[]
  roleExitCode: number
  beforeSnapshot?: string
  afterSnapshot?: string
  rollbackSnapshot?: string
  diffPatchPath?: string
  validation?: MatOSAssetHistoryValidationResult
  validationBaseline?: MatOSAssetHistoryValidationResult
  introducedValidationErrors?: unknown[]
  acceptanceEvidence?: MatOSDirectAssetEditorAcceptanceEvidence
  semanticAcceptance?: MatOSSemanticAcceptanceResult
  // True when this run's content reached the tree through a path that never
  // ran the semantic acceptance judge (the pending-merge 'edit' strategy).
  semanticJudgeSkipped?: boolean
  rollback?: {
    reason: string
    restoredFromSnapshot?: string
    rollbackSnapshot?: string
  }
  // Present only on multi-attempt runs (bounded retry loop): the ordered list of
  // edit attempts, including the decisive final attempt, for provenance.
  attempts?: MatOSDirectAssetEditorAttemptSummary[]
  mergeMode?: MatOSDirectAssetEditorMergeMode
  dirtyFilesAtStart?: string[]
  pendingMerge?: string
  mergeConflicts?: MatOSDirectAssetEditorMergeConflict[]
  giteaReview?: MatOSDirectAssetEditorGiteaReview
  sourceCommits?: MatOSGitAssetSourceCommitResult[]
  sourceAcceptance?: MatOSDirectAssetEditorSourceAcceptance[]
  sourceRollback?: MatOSDirectAssetEditorSourceRollbackTarget[]
  sourceCommitErrors?: MatOSDirectAssetEditorSourceCommitError[]
  proposal?: MatOSDirectAssetEditorProposal
  stderr?: string
  upstreamSessionId?: string
  usage?: MatOSEvolutionUsage
  modelUsage?: MatOSEvolutionModelUsage
  totalCostUsd?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
}

function isRollbackableAcceptedGitSource(
  source: MatOSProjectConfig['assetSources'] extends Array<infer Item>
    ? Item
    : never,
): source is MatOSGitAssetSourceConfig & {
  runtimeRef: Extract<
    NonNullable<MatOSGitAssetSourceConfig['runtimeRef']>,
    { mode: 'accepted-ref' }
  >
} {
  return Boolean(
    source &&
      source.type === 'git' &&
      source.runtimeRef?.mode === 'accepted-ref' &&
      source.runtimeRef.ref?.trim() &&
      source.runtimeRef.commit?.trim(),
  )
}

function directEditorSourceRollbackTargetsFromConfig(input: {
  config: MatOSProjectConfig
  sourceAcceptance?: MatOSDirectAssetEditorSourceAcceptance[]
}): MatOSDirectAssetEditorSourceRollbackTarget[] {
  const acceptedSourceIds = new Set(
    (input.sourceAcceptance ?? []).map(item => item.sourceId),
  )
  const pushedBySource = new Map(
    (input.sourceAcceptance ?? []).map(item => [item.sourceId, item.pushed]),
  )
  const acceptedCommitBySource = new Map(
    (input.sourceAcceptance ?? []).map(item => [item.sourceId, item.commit]),
  )
  const previousAcceptedCommitBySource = new Map(
    (input.sourceAcceptance ?? [])
      .filter(item => Boolean(item.previousAcceptedCommit))
      .map(item => [item.sourceId, item.previousAcceptedCommit!]),
  )
  return (input.config.assetSources ?? [])
    .filter(isRollbackableAcceptedGitSource)
    .filter(source =>
      acceptedSourceIds.size > 0 ? acceptedSourceIds.has(source.id) : true,
    )
    .map(source => ({
      sourceId: source.id,
      acceptedBranch: source.runtimeRef.ref,
      commit:
        previousAcceptedCommitBySource.get(source.id) ??
        source.runtimeRef.commit,
      ...(acceptedCommitBySource.get(source.id)
        ? { expectedRemoteCommit: acceptedCommitBySource.get(source.id) }
        : {}),
      pushed: pushedBySource.get(source.id) === true,
    }))
}

function directEditorSourceBaselineConfig(input: {
  config: MatOSProjectConfig
  sourceAcceptance?: MatOSDirectAssetEditorSourceAcceptance[]
}): MatOSProjectConfig {
  const previousAcceptedCommitBySource = new Map(
    (input.sourceAcceptance ?? [])
      .filter(item => Boolean(item.previousAcceptedCommit))
      .map(item => [item.sourceId, item.previousAcceptedCommit!]),
  )
  if (previousAcceptedCommitBySource.size === 0) {
    return input.config
  }
  return {
    ...input.config,
    assetSources: (input.config.assetSources ?? []).map(source => {
      const previousCommit = previousAcceptedCommitBySource.get(source.id)
      if (
        !previousCommit ||
        source.type !== 'git' ||
        source.runtimeRef?.mode !== 'accepted-ref'
      ) {
        return source
      }
      return {
        ...source,
        runtimeRef: {
          ...source.runtimeRef,
          commit: previousCommit,
        },
      }
    }),
  }
}

export type MatOSDirectAssetEditorRebaselineResult = {
  status: 'current' | 'updated' | 'failed'
  scope: MatOSDirectAssetEditorScope
  previousStableSnapshot?: string
  previousStableCommit?: string
  snapshot?: MatOSAssetHistorySnapshotRecord
  validation?: MatOSAssetHistoryValidationResult
  error?: string
}

export type MatOSDirectAssetEditorScopeHealth = {
  scope: MatOSDirectAssetEditorScope
  status: 'ready' | 'needs_rebaseline' | 'no_stable_baseline' | 'unknown'
  stableCommit?: string
  stableSnapshot?: string
  hasStableBaseline: boolean
  currentDiffersFromStable: boolean
  needsRebaseline: boolean
  summary: string
  error?: string
}

export type MatOSDirectAssetEditorRebaseline = (input: {
  cwd: string
  scope?: MatOSDirectAssetEditorScope
  reason?: string
  triggerKey?: string
  experienceRefs?: string[]
}) => Promise<MatOSDirectAssetEditorRebaselineResult>

export type MatOSDirectAssetEditorRecoveryResult = {
  recovered: MatOSDirectAssetEditorRunRecord[]
  skipped: MatOSDirectAssetEditorRunRecord[]
}

function nowIso(): string {
  return new Date().toISOString()
}

// Millisecond precision plus a random suffix. The legacy 10-second prefix let
// two concurrent runs collide on the same run id and silently overwrite each
// other's run directory, snapshot refs, and Gitea evolution branches. The
// timestamp stays first so ids remain time-sortable, and the charset stays
// within the assertSafeEvolutionRecordId constraints (no path separators or
// dot segments) and valid git ref-name characters.
export function defaultDirectEditorRunId(): string {
  const sortableTimestamp = nowIso().replace(/[^0-9A-Za-z]+/g, '')
  return `direct-editor-${sortableTimestamp}-${randomBytes(4).toString('hex')}`
}

function directEditorRunIsInterrupted(
  record: MatOSDirectAssetEditorRunRecord | undefined,
): record is MatOSDirectAssetEditorRunRecord & { beforeSnapshot: string } {
  return Boolean(
    record?.beforeSnapshot &&
      (record.status === 'edited' || record.status === 'validated'),
  )
}

function editorOutputReportsNoAssetEdits(
  output: Pick<
    MatOSDirectAssetEditorOutput,
    'modifiedFiles' | 'createdAssets' | 'updatedAssets' | 'disabledAssets'
  >,
): boolean {
  return (
    output.modifiedFiles.length === 0 &&
    output.createdAssets.length === 0 &&
    output.updatedAssets.length === 0 &&
    output.disabledAssets.length === 0
  )
}

const DIRECT_EDITOR_RUNTIME_ASSET_TYPES = new Set([
  'role',
  'skill',
  'workflow',
  'tool',
  'mcp',
  'knowledge',
])

function isScopedDirectEditorScope(scope: MatOSDirectAssetEditorScope): boolean {
  return scope === 'user' || scope === 'team' || scope === 'project'
}

function isGeneratedAssetHistoryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return (
    normalized === '.matos/assets/generated' ||
    normalized.startsWith('.matos/assets/generated/')
  )
}

function runtimeAssetTypeFromPath(path: string): string | undefined {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  for (const part of parts) {
    const singular = part.endsWith('s') ? part.slice(0, -1) : part
    if (DIRECT_EDITOR_RUNTIME_ASSET_TYPES.has(singular)) {
      return singular
    }
  }
  return undefined
}

async function nearestManifestTypeForHistoryPath(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  path: string
}): Promise<string | undefined> {
  const normalized = input.path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const manifestPath = `${parts.slice(0, index).join('/')}/asset.json`
    let resolved: string
    try {
      resolved = resolveMatOSAssetHistoryRecordPath({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        path: manifestPath,
      }).absolutePath
    } catch {
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(resolved, 'utf8')) as {
        type?: unknown
      }
      return typeof manifest.type === 'string' ? manifest.type : undefined
    } catch {
      continue
    }
  }
  return undefined
}

async function scopedGeneratedRuntimeAssetViolations(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  touchedPaths: string[]
}): Promise<string[]> {
  if (!isScopedDirectEditorScope(input.scope)) {
    return []
  }
  const violations: string[] = []
  for (const path of input.touchedPaths) {
    if (!isGeneratedAssetHistoryPath(path)) {
      continue
    }
    const assetType =
      runtimeAssetTypeFromPath(path) ??
      (await nearestManifestTypeForHistoryPath({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        path,
      }))
    if (assetType && DIRECT_EDITOR_RUNTIME_ASSET_TYPES.has(assetType)) {
      violations.push(`${path} (${assetType})`)
    }
  }
  return [...new Set(violations)].sort((a, b) => a.localeCompare(b))
}

type ScopedGeneratedRuntimeAssetRelocation = {
  from: string
  to: string
  assetRef: string
}

async function generatedRuntimeAssetDirForPath(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  path: string
}): Promise<
  | {
      logicalDir: string
      absoluteDir: string
      assetType: string
      assetId: string
      version?: string
    }
  | undefined
> {
  if (!isGeneratedAssetHistoryPath(input.path)) {
    return undefined
  }
  const normalized = input.path.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  for (let index = parts.length; index > 0; index -= 1) {
    const logicalDir = parts.slice(0, index).join('/')
    const manifestPath = `${logicalDir}/asset.json`
    let resolved: { absolutePath: string }
    try {
      resolved = resolveMatOSAssetHistoryRecordPath({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        path: manifestPath,
      })
    } catch {
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(resolved.absolutePath, 'utf8')) as {
        id?: unknown
        type?: unknown
        version?: unknown
      }
      const assetType = typeof manifest.type === 'string' ? manifest.type.trim() : ''
      const assetId = typeof manifest.id === 'string' ? manifest.id.trim() : ''
      if (
        assetId &&
        assetType &&
        DIRECT_EDITOR_RUNTIME_ASSET_TYPES.has(assetType)
      ) {
        return {
          logicalDir,
          absoluteDir: dirname(resolved.absolutePath),
          assetType,
          assetId,
          ...(typeof manifest.version === 'string' && manifest.version.trim()
            ? { version: manifest.version.trim() }
            : {}),
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

function resolvePromptCreationRoot(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  root: string
}): { logicalRoot: string; absoluteRoot: string } | undefined {
  if (isGeneratedAssetHistoryPath(input.root)) {
    return undefined
  }
  try {
    const resolved = resolveMatOSAssetHistoryRecordPath({
      cwd: input.cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      path: input.root,
    })
    return {
      logicalRoot: resolved.relativePath,
      absoluteRoot: resolved.absolutePath,
    }
  } catch {
    return undefined
  }
}

async function relocateScopedGeneratedRuntimeAssets(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  touchedPaths: string[]
  targetAssetCreationRoots?: string[]
}): Promise<ScopedGeneratedRuntimeAssetRelocation[]> {
  if (!isScopedDirectEditorScope(input.scope)) {
    return []
  }
  const creationRoot = (input.targetAssetCreationRoots ?? [])
    .map(root =>
      resolvePromptCreationRoot({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        root,
      }),
    )
    .find((root): root is { logicalRoot: string; absoluteRoot: string } =>
      Boolean(root),
    )
  if (!creationRoot) {
    return []
  }
  const generatedDirs = new Map<
    string,
    Awaited<ReturnType<typeof generatedRuntimeAssetDirForPath>>
  >()
  for (const path of input.touchedPaths) {
    const generated = await generatedRuntimeAssetDirForPath({
      cwd: input.cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      path,
    })
    if (generated) {
      generatedDirs.set(generated.logicalDir, generated)
    }
  }
  const relocations: ScopedGeneratedRuntimeAssetRelocation[] = []
  for (const generated of generatedDirs.values()) {
    if (!generated) {
      continue
    }
    const targetDir = join(
      creationRoot.absoluteRoot,
      generated.assetType,
      generated.assetId,
    )
    const targetManifest = join(targetDir, 'asset.json')
    const existingTarget = await captureImportPathEntry(targetManifest)
    if (existingTarget) {
      throw new Error(
        `target asset path policy failed: generated runtime asset ${generated.assetType}:${generated.assetId} cannot be relocated because ${targetManifest} already exists. Update the existing Gitea/source asset instead of creating a generated duplicate.`,
      )
    }
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(generated.absoluteDir, targetDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    await rm(generated.absoluteDir, { recursive: true, force: true })
    relocations.push({
      from: generated.logicalDir,
      // Logical (asset-history) path of the relocated directory so touched
      // paths can be remapped through the relocation exactly.
      to: `${creationRoot.logicalRoot}/${generated.assetType}/${generated.assetId}`,
      assetRef: `${generated.assetType}:${generated.assetId}${
        generated.version ? `@${generated.version}` : ''
      }`,
    })
  }
  return relocations
}

async function enableDirectEditorRuntimeAssets(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  // Only manifests actually written by this run (import operations plus
  // relocation targets) may be flipped draft -> enabled. A whole-tree delta
  // here would also enable drafts deliberately saved by concurrent third-party
  // writers during the unlocked Phase B editor window.
  touchedPaths: string[]
}): Promise<string[]> {
  const flippedPaths: string[] = []
  await Promise.all(
    [...new Set(input.touchedPaths)]
      .filter(path => path.endsWith('/asset.json'))
      .map(async path => {
        let resolved: { absolutePath: string }
        try {
          resolved = resolveMatOSAssetHistoryRecordPath({
            cwd: input.cwd,
            scope: input.scope,
            ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
            path,
          })
        } catch {
          return
        }
        let manifest: Record<string, unknown>
        try {
          manifest = JSON.parse(await readFile(resolved.absolutePath, 'utf8')) as
            Record<string, unknown>
        } catch {
          return
        }
        const type = typeof manifest.type === 'string' ? manifest.type : ''
        if (!DIRECT_EDITOR_RUNTIME_ASSET_TYPES.has(type)) {
          return
        }
        const lifecycle = metadataObject(manifest.lifecycle)
        if (lifecycle.status !== 'draft') {
          return
        }
        manifest.lifecycle = { ...lifecycle, status: 'enabled' }
        const metadata = metadataObject(manifest.metadata)
        if (metadata.lifecycle === 'draft') {
          manifest.metadata = { ...metadata, lifecycle: 'enabled' }
        }
        await writeFile(
          resolved.absolutePath,
          `${JSON.stringify(manifest, null, 2)}\n`,
          'utf8',
        )
        flippedPaths.push(resolved.absolutePath)
      }),
  )
  return flippedPaths
}

// Reverse of enableDirectEditorRuntimeAssets for the LIVE working tree only.
// The enabled state must exist when the after snapshot is taken (Gate 1 mount
// validation and the accepted stable ref both need it), but between that
// snapshot and the Gate 2 verdict the live tree is readable by concurrent
// sessions with no lock. Parking the flipped manifests back on draft keeps
// not-yet-accepted NEW assets out of every concurrent registry load; on accept
// the existing restore of the after snapshot re-applies the enabled state, and
// on rollback the before snapshot removes the created files entirely.
export async function parkDirectEditorRuntimeAssetsAsDraft(
  flippedManifestPaths: string[],
): Promise<void> {
  await Promise.all(
    flippedManifestPaths.map(async absolutePath => {
      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(await readFile(absolutePath, 'utf8')) as
          Record<string, unknown>
      } catch {
        return
      }
      const lifecycle = metadataObject(manifest.lifecycle)
      if (lifecycle.status !== 'enabled') {
        return
      }
      manifest.lifecycle = { ...lifecycle, status: 'draft' }
      const metadata = metadataObject(manifest.metadata)
      if (metadata.lifecycle === 'enabled') {
        manifest.metadata = { ...metadata, lifecycle: 'draft' }
      }
      await writeFile(
        absolutePath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      )
    }),
  )
}

function directEditorEnvFlagValue(
  env: Record<string, string | undefined> | undefined,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = env?.[key] ?? process.env[key]
    if (value === undefined) {
      continue
    }
    const normalized = value.trim().toLowerCase()
    return (
      normalized === '1' ||
      normalized === 'true' ||
      normalized === 'on' ||
      normalized === 'yes'
    )
  }
  return undefined
}

function directEditorRequiresGiteaSourceAcceptance(
  env: Record<string, string | undefined> | undefined,
  scope: MatOSDirectAssetEditorScope,
): boolean {
  const explicit = directEditorEnvFlagValue(env, [
    'MATOS_EVOLUTION_REQUIRE_GITEA_SOURCE_ACCEPTANCE',
    'MATOS_DIRECT_EDITOR_REQUIRE_GITEA_SOURCE_ACCEPTANCE',
  ])
  if (explicit !== undefined) {
    return explicit
  }
  return scope === 'user' || scope === 'team' || scope === 'project'
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

async function listChangedFilesSinceSnapshot(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  snapshotId: string
}): Promise<string[]> {
  const snapshot = await readMatOSAssetHistorySnapshot(
    input.cwd,
    input.snapshotId,
  )
  if (snapshot?.scope !== input.scope) {
    throw new Error(
      snapshot
        ? `MatOS asset history snapshot ${input.snapshotId} has scope ${snapshot.scope}, expected ${input.scope}`
        : `MatOS asset history snapshot not found: ${input.snapshotId}`,
    )
  }
  if (input.scopeRef && snapshot.scopeRef && snapshot.scopeRef !== input.scopeRef) {
    throw new Error(
      `MatOS asset history snapshot ${input.snapshotId} has scopeRef ${snapshot.scopeRef ?? '(legacy)'}, expected ${input.scopeRef}`,
    )
  }
  return listMatOSAssetHistoryWorkingTreeChangedFiles({
    cwd: input.cwd,
    snapshotId: input.snapshotId,
  })
}

function normalizeDirectEditorRecoveryPath(input: {
  cwd: string
  scope: MatOSDirectAssetEditorScope
  scopeRef?: string
  path: string
}): string | undefined {
  const raw = input.path.trim()
  if (!raw) {
    return undefined
  }
  try {
    if (isAbsolute(raw)) {
      return matOSAssetHistoryLogicalPath({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        absolutePath: raw,
      })
    }
    return resolveMatOSAssetHistoryRecordPath({
      cwd: input.cwd,
      scope: input.scope,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      path: normalizeMatOSAssetHistoryRelativePath(raw),
    }).relativePath
  } catch {
    return undefined
  }
}

function expectedDirectEditorRecoveryChangedFiles(input: {
  cwd: string
  record: MatOSDirectAssetEditorRunRecord
}): Set<string> {
  const expected = new Set<string>()
  // Prefer the import machinery's own touched-path checkpoint over the editor
  // LLM's self-reported file list; the latter is only a fallback for records
  // written before importedTouchedPaths was checkpointed.
  const paths =
    input.record.importedTouchedPaths &&
    input.record.importedTouchedPaths.length > 0
      ? input.record.importedTouchedPaths
      : [
          ...input.record.editorOutput.modifiedFiles,
          ...input.record.modifiedFiles,
        ]
  for (const path of paths) {
    const normalized = normalizeDirectEditorRecoveryPath({
      cwd: input.cwd,
      scope: input.record.scope,
      ...(input.record.input.scopeRef
        ? { scopeRef: input.record.input.scopeRef }
        : {}),
      path,
    })
    if (normalized) {
      expected.add(normalized)
    }
  }
  return expected
}

function unexpectedDirectEditorRecoveryChangedFiles(input: {
  cwd: string
  record: MatOSDirectAssetEditorRunRecord
  changedFiles: string[]
}): string[] {
  const expected = expectedDirectEditorRecoveryChangedFiles({
    cwd: input.cwd,
    record: input.record,
  })
  return input.changedFiles.filter(path => {
    const normalized =
      normalizeDirectEditorRecoveryPath({
        cwd: input.cwd,
        scope: input.record.scope,
        ...(input.record.input.scopeRef
          ? { scopeRef: input.record.input.scopeRef }
          : {}),
        path,
      }) ?? path
    return !expected.has(normalized)
  })
}

function directEditorGiteaReviewEnabled(
  env: Record<string, string | undefined> | undefined,
): boolean {
  const value =
    env?.MATOS_EVOLUTION_GITEA_REVIEW ??
    env?.MATOS_DIRECT_EDITOR_GITEA_REVIEW ??
    process.env.MATOS_EVOLUTION_GITEA_REVIEW ??
    process.env.MATOS_DIRECT_EDITOR_GITEA_REVIEW
  if (value !== undefined) {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'on'
  }
  const apiUrl =
    matOSGiteaEnvValueWithProcessFallback(['MATOS_GITEA_API_URL', 'MATOS_GITEA_API'], env) ??
    directEditorGiteaEnv(env, 'MATOS_GITEA_UPSTREAM')
  const token = matOSGiteaEnvValueWithProcessFallback(MATOS_GITEA_TOKEN_KEYS, env)
  return Boolean(apiUrl && token)
}

function directEditorGiteaEnv(
  env: Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  return matOSGiteaEnvValueWithProcessFallback([key], env)
}

function directEditorGiteaReviewConfig(input: {
  env?: Record<string, string | undefined>
  runId: string
  scope: MatOSDirectAssetEditorScope
}):
  | {
      apiUrl: string
      token?: string
      owner: string
      repo: string
      branch: string
      baseBranch: string
    }
  | undefined {
  if (!directEditorGiteaReviewEnabled(input.env)) {
    return undefined
  }
  const apiUrl =
    matOSGiteaEnvValueWithProcessFallback(['MATOS_GITEA_API_URL', 'MATOS_GITEA_API'], input.env) ??
    (directEditorGiteaEnv(input.env, 'MATOS_GITEA_UPSTREAM')
      ? `${directEditorGiteaEnv(input.env, 'MATOS_GITEA_UPSTREAM')!.replace(
          /\/+$/,
          '',
        )}/api/v1`
      : undefined)
  const owner =
    directEditorGiteaEnv(input.env, 'MATOS_EVOLUTION_GITEA_OWNER') ??
    directEditorGiteaEnv(input.env, 'MATOS_DIRECT_EDITOR_GITEA_OWNER') ??
    (input.scope === 'core' ? 'matos-core' : undefined)
  const repo =
    directEditorGiteaEnv(input.env, 'MATOS_EVOLUTION_GITEA_REPO') ??
    directEditorGiteaEnv(input.env, 'MATOS_DIRECT_EDITOR_GITEA_REPO') ??
    (input.scope === 'core' ? 'assets' : undefined)
  if (!apiUrl || !owner || !repo) {
    return undefined
  }
  return {
    apiUrl,
    token: matOSGiteaEnvValueWithProcessFallback(MATOS_GITEA_TOKEN_KEYS, input.env),
    owner,
    repo,
    branch:
      directEditorGiteaEnv(input.env, 'MATOS_EVOLUTION_GITEA_BRANCH') ??
      `evolution/${input.runId}`,
    baseBranch:
      directEditorGiteaEnv(input.env, 'MATOS_EVOLUTION_GITEA_BASE_BRANCH') ??
      directEditorGiteaEnv(input.env, 'MATOS_DIRECT_EDITOR_GITEA_BASE_BRANCH') ??
      'main',
  }
}

export async function createGiteaReviewForPendingDirectEditorMerge(input: {
  cwd: string
  runId: string
  scope: MatOSDirectAssetEditorScope
  env?: Record<string, string | undefined>
  summary: string
  evidenceRefs: string[]
}): Promise<MatOSDirectAssetEditorGiteaReview | undefined> {
  const timestamp = nowIso()
  const pending = await readMatOSDirectAssetEditorPendingMergeRecord(input.cwd, input.runId)
  if (!pending) {
    return undefined
  }
  let config = input.scope === 'core' ? directEditorGiteaReviewConfig(input) : undefined
  const sourcePaths = new Map<string, string>()
  if (input.scope !== 'core') {
    const setting = input.env?.MATOS_EVOLUTION_GITEA_REVIEW ?? input.env?.MATOS_DIRECT_EDITOR_GITEA_REVIEW ??
      process.env.MATOS_EVOLUTION_GITEA_REVIEW ?? process.env.MATOS_DIRECT_EDITOR_GITEA_REVIEW
    if (setting !== undefined && !/^(1|true|yes|on)$/i.test(setting.trim())) return undefined
    const sources = (await readMatOSProjectConfig(input.cwd, { strict: true })).assetSources?.filter(
      (source): source is MatOSGitAssetSourceConfig => source.type === 'git' && Boolean(source.gitea) &&
        directEditorAssetSourceMatchesRunScope({ source, scope: input.scope, scopeRef: pending.scopeRef }),
    ) ?? []
    if (!sources.length) return undefined
    const matches = sources.filter(source => pending.files.every(file => {
      const path = relative(matOSGitAssetSourceCheckoutRoot(input.cwd, source), resolve(input.cwd, file.path))
      return path && path !== '..' && !path.startsWith('../') && !isAbsolute(path)
    }))
    const unresolved = (error: string): MatOSDirectAssetEditorGiteaReview => ({
      provider: 'gitea', status: 'failed', owner: 'scoped', repo: 'unresolved', branch: `evolution/${input.runId}`,
      baseBranch: '', createdAt: timestamp, updatedAt: timestamp, error,
    })
    if (matches.length !== 1) return unresolved('Pending files do not belong to exactly one scoped Gitea repository; resolve this multi-source merge locally.')
    const source = matches[0]!
    const repoUrl = resolveMatOSGitAssetSourceRuntimeRepo({ cwd: input.cwd, source, repo: source.repo })
    if (!/^https?:\/\//i.test(repoUrl)) return undefined
    try {
      const checked = await preflightEvolutionGiteaSources({ cwd: input.cwd, scope: input.scope,
        scopeRef: pending.scopeRef, env: input.env, checkVersion: false })
      if (checked.ok === false) return unresolved(`${checked.code}: ${checked.message}`)
      config = {
        apiUrl: matOSGiteaApiUrlFromSourceRepo(repoUrl, source), owner: source.gitea!.owner, repo: source.gitea!.repo,
        token: matOSGiteaEnvValueWithProcessFallback(MATOS_GITEA_TOKEN_KEYS, { ...input.env, MATOS_SCOPE_REF: pending.scopeRef }),
        branch: `evolution/${input.runId}`,
        baseBranch: matOSGitBranchName(source.runtimeRef?.mode === 'accepted-ref' ? source.runtimeRef.ref : source.ref ?? 'main'),
      }
      for (const file of pending.files) sourcePaths.set(file.path,
        relative(matOSGitAssetSourceCheckoutRoot(input.cwd, source), resolve(input.cwd, file.path)).replace(/\\/g, '/'))
    } catch { return unresolved('Gitea scoped review preflight could not be completed; the local pending merge remains authoritative.') }
  }
  if (!config) return undefined
  const failedReview = (error: unknown): MatOSDirectAssetEditorGiteaReview => ({
    provider: 'gitea',
    status: 'failed',
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    baseBranch: config.baseBranch,
    createdAt: timestamp,
    updatedAt: nowIso(),
    error: error instanceof Error ? error.message : String(error),
  })

  try {
    await createMatOSGiteaBranch({
      apiUrl: config.apiUrl,
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      fromRef: config.baseBranch,
    })
    const files: NonNullable<MatOSDirectAssetEditorGiteaReview['files']> = []
    for (const file of pending.files) {
      const repositoryPath = sourcePaths.get(file.path) ?? file.path
      const edit = await readPendingMergeVersionEntry({
        cwd: input.cwd,
        runId: input.runId,
        relativePath: file.editPath,
        kind: file.editKind,
      })
      if (!edit) {
        const deleted = await deleteMatOSGiteaFile({
          apiUrl: config.apiUrl,
          token: config.token,
          owner: config.owner,
          repo: config.repo,
          branch: config.branch,
          path: repositoryPath,
          message: `MatOS evolution ${input.runId}: delete ${file.path}`,
        })
        files.push({ path: repositoryPath, action: deleted.action })
        continue
      }
      if (edit.kind !== 'file') {
        files.push({
          path: file.path,
          action: 'skipped',
          reason: `pending edit kind ${edit.kind} cannot be materialized through Gitea content API`,
        })
        continue
      }
      const written = await writeMatOSGiteaTextFile({
        apiUrl: config.apiUrl,
        token: config.token,
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        path: repositoryPath,
        content: edit.content,
        message: `MatOS evolution ${input.runId}: update ${file.path}`,
      })
      files.push({ path: repositoryPath, action: written.action })
    }
    const pr = await createMatOSGiteaPullRequest({
      apiUrl: config.apiUrl,
      token: config.token,
      owner: config.owner,
      repo: config.repo,
      sourceBranch: config.branch,
      targetBranch: config.baseBranch,
      title: `MatOS evolution review ${input.runId}`,
      body: [
        input.summary,
        '',
        `Run: ${input.runId}`,
        input.evidenceRefs.length > 0
          ? `Evidence refs: ${input.evidenceRefs.join(', ')}`
          : 'Evidence refs: none',
        '',
        'This PR was generated by MatOS direct self-evolution. MatOS validation and local pending-merge fallback remain authoritative.',
      ].join('\n'),
    })
    const review: MatOSDirectAssetEditorGiteaReview = {
      provider: 'gitea',
      status: 'created',
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      baseBranch: config.baseBranch,
      createdAt: timestamp,
      updatedAt: nowIso(),
      pullRequest: {
        number: pr.number,
        ...(pr.url ? { url: pr.url } : {}),
        ...(pr.state ? { state: pr.state } : {}),
      },
      files,
    }
    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: input.cwd,
      record: {
        ...pending,
        updatedAt: review.updatedAt,
        giteaReview: review,
      },
    })
    return review
  } catch (error) {
    const review = failedReview(error)
    await writeMatOSDirectAssetEditorPendingMergeRecord({
      cwd: input.cwd,
      record: {
        ...pending,
        updatedAt: review.updatedAt,
        giteaReview: review,
      },
    })
    return review
  }
}

async function writeFailedDirectEditorPreflightRecord(input: {
  cwd: string
  runId: string
  promptInput: MatOSDirectAssetEditorPromptInput
  summary: string
  stderr: string
  status?: MatOSDirectAssetEditorRunRecord['status']
  statusReason?: string
  roleExitCode?: number
}): Promise<MatOSDirectAssetEditorRunRecord> {
  const timestamp = nowIso()
  const record: MatOSDirectAssetEditorRunRecord = {
    runId: input.runId,
    status: input.status ?? 'failed',
    ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    scope: input.promptInput.scope,
    input: input.promptInput,
    editorOutput: {
      summary: input.summary,
      modifiedFiles: [],
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
    },
    modifiedFiles: [],
    createdAssets: [],
    updatedAssets: [],
    disabledAssets: [],
    evidenceRefs: [],
    roleExitCode: input.roleExitCode ?? 1,
    stderr: input.stderr.slice(0, 2000),
  }
  try {
    await writeMatOSDirectAssetEditorRunRecord(input.cwd, record)
  } catch (error) {
    return {
      ...record,
      status: 'blocked',
      rawStatus: record.status,
      statusReason: 'preflight_record_write_failed',
      stderr: `${record.stderr ?? ''}\nFailed to persist direct-editor preflight record: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 2000),
    }
  }
  return record
}

export async function rebaselineMatOSDirectAssetEditorScope(input: {
  cwd: string
  scope?: MatOSDirectAssetEditorScope
  scopeRef?: string
  reason?: string
  triggerKey?: string
  experienceRefs?: string[]
}): Promise<MatOSDirectAssetEditorRebaselineResult> {
  const scope = input.scope ?? 'core'
  return await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-rebaseline',
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    () => withEvolutionSourceLease(input, async () => {
      const previousStableCommit = await stableCommitForDirectEditorScope(
        input.cwd,
        scope,
        input.scopeRef,
      )
      const previousStableSnapshot = await stableSnapshotForDirectEditorScope(
        input.cwd,
        scope,
        input.scopeRef,
      )
      if (
        previousStableSnapshot &&
        !(await hasMatOSAssetHistoryWorkingTreeChanges({
          cwd: input.cwd,
          snapshotId: previousStableSnapshot,
        }))
      ) {
        const snapshot = await readMatOSAssetHistorySnapshot(
          input.cwd,
          previousStableSnapshot,
        )
        return {
          status: 'current',
          scope,
          ...(previousStableSnapshot ? { previousStableSnapshot } : {}),
          ...(previousStableCommit ? { previousStableCommit } : {}),
          ...(snapshot ? { snapshot } : {}),
        }
      }

      const snapshot = await createMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        kind: 'manual',
        scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        ref: matOSAssetHistoryLatestRef(scope, input.scopeRef),
        ...(previousStableCommit ? { parentCommit: previousStableCommit } : {}),
        provenance: {
          source: 'direct-editor-rebaseline',
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.triggerKey ? { triggerKey: input.triggerKey } : {}),
          ...(input.experienceRefs ? { experienceRefs: input.experienceRefs } : {}),
        },
      })
      let validationBaselineError: string | undefined
      const validationBaseline = previousStableSnapshot
        ? await validateMatOSAssetHistorySnapshot({
            cwd: input.cwd,
            snapshotId: previousStableSnapshot,
          }).catch((error: unknown) => {
            validationBaselineError =
              error instanceof Error ? error.message : String(error)
            return undefined
          })
        : undefined
      const validation = await validateMatOSAssetHistorySnapshot({
        cwd: input.cwd,
        snapshotId: snapshot.snapshotId,
      })
      const usability = evaluateDirectEditorUsability(
        validationBaseline,
        validation,
        { baselineUnavailable: Boolean(validationBaselineError) },
      )
      if (!usability.usable) {
        return {
          status: 'failed',
          scope,
          ...(previousStableSnapshot ? { previousStableSnapshot } : {}),
          ...(previousStableCommit ? { previousStableCommit } : {}),
          snapshot,
          validation,
          error: `MatOS direct editor rebaseline validation failed: ${usability.introducedErrors.length} new validation error(s)`,
        }
      }
      await updateDirectEditorStableRef({
        cwd: input.cwd,
        scope,
        ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
        commit: snapshot.commit,
      })
      return {
        status: 'updated',
        scope,
        ...(previousStableSnapshot ? { previousStableSnapshot } : {}),
        ...(previousStableCommit ? { previousStableCommit } : {}),
        snapshot,
        validation,
      }
    }),
  )
}

export async function inspectMatOSDirectAssetEditorScope(input: {
  cwd: string
  scope?: MatOSDirectAssetEditorScope
  scopeRef?: string
}): Promise<MatOSDirectAssetEditorScopeHealth> {
  const scope = input.scope ?? 'core'
  const stableCommit = await stableCommitForDirectEditorScope(
    input.cwd,
    scope,
    input.scopeRef,
  )
  const stableSnapshot = await stableSnapshotForDirectEditorScope(
    input.cwd,
    scope,
    input.scopeRef,
  )
  if (!stableCommit || !stableSnapshot) {
    return {
      scope,
      ...(stableCommit ? { stableCommit } : {}),
      ...(stableSnapshot ? { stableSnapshot } : {}),
      hasStableBaseline: false,
      currentDiffersFromStable: false,
      needsRebaseline: false,
      status: 'no_stable_baseline',
      summary:
        'Direct asset editor has no stable baseline yet; the next direct edit can create before/after snapshots from current assets.',
    }
  }
  try {
    const currentDiffersFromStable = await hasMatOSAssetHistoryWorkingTreeChanges({
      cwd: input.cwd,
      snapshotId: stableSnapshot,
    })
    return {
      scope,
      stableCommit,
      stableSnapshot,
      hasStableBaseline: true,
      currentDiffersFromStable,
      needsRebaseline: currentDiffersFromStable,
      status: currentDiffersFromStable ? 'needs_rebaseline' : 'ready',
      summary: currentDiffersFromStable
        ? 'Current editable assets differ from the direct-editor stable baseline; direct edits will attempt a dirty-tree merge, and sync/rebaseline is still recommended before deployment checkpoints.'
        : 'Current editable assets match the direct-editor stable baseline.',
    }
  } catch (error) {
    return {
      scope,
      stableCommit,
      stableSnapshot,
      hasStableBaseline: true,
      currentDiffersFromStable: false,
      needsRebaseline: true,
      status: 'unknown',
      summary:
        'Direct asset editor could not compare current editable assets with the stable baseline.',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// Gate 1 fingerprint for a single asset-validation error. We deliberately drop
// the volatile temp validation-root path (each validation pass uses a fresh
// mkdtemp dir, so manifestPath differs run to run) and the asset version (a
// legitimate editor version bump must not re-key pre-existing environmental
// errors as newly introduced; genuinely new breakage still differs by code or
// message). Only the stable code + unversioned asset key + message remain so
// before/after baselines can be compared.
function validationErrorFingerprint(error: unknown): string {
  const record = metadataObject(error)
  const code = typeof record.code === 'string' ? record.code : ''
  const rawAssetKey =
    typeof record.assetKey === 'string'
      ? record.assetKey
      : typeof record.assetId === 'string'
        ? record.assetId
        : ''
  const assetKey = rawAssetKey.replace(/@[^@]*$/, '')
  const message =
    typeof record.message === 'string'
      ? record.message
          .replace(/[^\s"']*matos-asset-history-validation-[^\s"']*/g, '<validation-root>')
          .trim()
      : ''
  if (!code && !assetKey && !message) {
    return `raw\u0000${compactJson(error)}`
  }
  return `${code}\u0000${assetKey}\u0000${message}`
}

// Gate 1 usability is differential: a direct edit is only blocked when it
// INTRODUCES new asset-validation breakage relative to the pre-edit baseline.
// Pre-existing, environmental failures (e.g. core assets that depend on mounted
// `data:` assets which are not part of the editable core pack) must not block an
// otherwise-correct edit, otherwise no direct edit can ever be accepted. Secret
// findings always hard-fail regardless of baseline.
export function evaluateDirectEditorUsability(
  before: MatOSAssetHistoryValidationResult | undefined,
  after: MatOSAssetHistoryValidationResult,
  options?: {
    // True when the baseline validation THREW (as opposed to producing an
    // empty baseline). Diffing against a crashed baseline would classify every
    // pre-existing environmental error as introduced, degrading the
    // differential gate into an absolute gate no edit can ever pass.
    baselineUnavailable?: boolean
  },
): { usable: boolean; introducedErrors: unknown[] } {
  if (!after.secretScan.ok) {
    return {
      usable: false,
      introducedErrors: after.secretScan.findings.map(finding => ({
        code: 'secret_finding',
        path: finding.path,
        message: finding.reason,
      })),
    }
  }
  if (!before && options?.baselineUnavailable) {
    // A missing baseline cannot prove an invalid candidate is pre-existing.
    // A fully valid candidate is still independently usable.
    return after.ok
      ? { usable: true, introducedErrors: [] }
      : { usable: false, introducedErrors: [{ code: 'baseline_validation_unavailable', message: 'Cannot establish differential usability because baseline validation failed.' }, ...after.assetValidation.errors] }
  }
  const baselineFingerprints = new Set(
    (before?.assetValidation.errors ?? []).map(validationErrorFingerprint),
  )
  const introducedErrors = after.assetValidation.errors.filter(
    error => !baselineFingerprints.has(validationErrorFingerprint(error)),
  )
  return { usable: introducedErrors.length === 0, introducedErrors }
}

type DirectAssetEditorPreparation =
  | { kind: 'skip'; record: MatOSDirectAssetEditorRunRecord | undefined }
  | {
      kind: 'prepared'
      promptInput: MatOSDirectAssetEditorPromptInput
      beforeSnapshot: Awaited<ReturnType<typeof createDirectEditorBeforeSnapshot>>
      baseSnapshotId: string
      dirtyFilesAtStart: string[]
      protectedCoreFiles: ProtectedCoreFileSnapshot
      isolation: DirectEditorIsolationWorkspace | undefined
      isolatedProtectedCoreFiles: ProtectedCoreFileSnapshot | undefined
      isolatedGuardedWorkspaceFiles: DirectEditorWorkspaceGuardSnapshot | undefined
      shouldImportFromIsolation: boolean
      prepareError: string | undefined
    }

// Bounded edit -> validate -> judge -> (reject) -> re-edit loop. Each attempt is
// a full single pass with its own isolation workspace, before/after snapshots,
// gates, and rollback. When a gate rolls an attempt back, its rejection evidence
// is fed into the next attempt's editor prompt. The loop stops on accept, on a
// non-retryable outcome (noop/failed/judge-failure), or when attempts run out.
// The decisive (final) record is returned; for multi-attempt runs it is re-keyed
// to the base run id and carries the full attempt chain for provenance.
export async function runMatOSDirectAssetEditor(
  input: MatOSDirectAssetEditorRunInput,
): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  input = { ...input, scopeRef: resolvedDirectEditorScopeRef(input) }
  if (input.scopeRef) input.env = { ...input.env, MATOS_SCOPE_REF: input.scopeRef }
  const baseRunId = input.runId ?? defaultDirectEditorRunId()
  const maxAttempts = resolveDirectEditorMaxAttempts(input.env)
  const previousAttempts: MatOSDirectAssetEditorPreviousAttempt[] = []
  const attemptSummaries: MatOSDirectAssetEditorAttemptSummary[] = []
  let decisive: MatOSDirectAssetEditorRunRecord | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptRunId =
      attempt === 1 ? baseRunId : `${baseRunId}-attempt-${attempt}`
    const record = await runDirectAssetEditorSinglePass(
      input,
      attemptRunId,
      previousAttempts.length > 0 ? previousAttempts : undefined,
    )
    // No prepared run at all (no experiences/targets): nothing to retry.
    if (!record) {
      return undefined
    }
    const feedback = buildPreviousAttemptFromRecord(record, attempt)
    attemptSummaries.push(
      summarizeDirectEditorAttempt(record, attempt, feedback),
    )
    decisive = record
    if (feedback === undefined || attempt >= maxAttempts) {
      break
    }
    previousAttempts.push(feedback)
  }

  if (!decisive) {
    return undefined
  }
  // Single-attempt runs keep the exact legacy record already written to disk by
  // the single pass. Multi-attempt runs re-key the decisive record to the base
  // run id and attach the full attempt chain for inspection/provenance.
  if (attemptSummaries.length <= 1) {
    if (decisive.input.currentEvolutionContext?.algorithm) {
      decisive.algorithmOutcomeRecorded = await recordEvolutionAlgorithmOutcome(input.cwd, decisive, input.env)
      await writeMatOSDirectAssetEditorRunRecord(input.cwd, decisive)
    }
    scheduleAlgorithmRegressionForAcceptedRun(input.cwd, decisive, input.env)
    return decisive
  }
  const consolidated: MatOSDirectAssetEditorRunRecord = {
    ...decisive,
    runId: baseRunId,
    attempts: attemptSummaries,
    updatedAt: nowIso(),
  }
  consolidated.algorithmOutcomeRecorded = await recordEvolutionAlgorithmOutcome(input.cwd, consolidated, input.env)
  await writeMatOSDirectAssetEditorRunRecord(input.cwd, consolidated)
  scheduleAlgorithmRegressionForAcceptedRun(input.cwd, consolidated, input.env)
  return consolidated
}

async function runDirectAssetEditorSinglePass(
  input: MatOSDirectAssetEditorRunInput,
  runId: string,
  previousAttempts?: MatOSDirectAssetEditorPreviousAttempt[],
): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  const timeoutMs = resolveEvolutionRoleTimeoutMs(input.env)

  // Phase A (short, locked): build the prompt, run the dirty preflight, capture
  // the before snapshot and protected/guard baselines, and create the isolation
  // workspace. The lock is intentionally released before the multi-minute
  // isolated role run (Phase B) so concurrent user-facing asset-history writers
  // (workbench applies, releases, intake) are not starved for the whole run.
  const prepared = await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-prepare',
      runId,
      timeoutMs,
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    () => withEvolutionSourceLease(input, () => prepareDirectAssetEditorRun(input, runId)),
  )
  if (prepared.kind === 'skip') {
    return prepared.record
  }
  // Feed prior in-run rejection evidence to the editor so a retry can correct
  // the specific gate failure instead of repeating it.
  if (previousAttempts && previousAttempts.length > 0) {
    prepared.promptInput.previousAttempts = previousAttempts
  }

  // Phase B (long, unlocked): the hidden editor role only writes inside its
  // isolation workspace, never the real asset tree, so it does not need the
  // global lock. Concurrent edits to the real tree during this window are
  // detected against the before snapshot in Phase C and cause a safe skip.
  let result: EvolutionRoleRunResult
  if (prepared.isolation && !prepared.prepareError) {
    const isolationCwd = prepared.isolation.cwd
    try {
      result = await (input.roleRunner ?? runEvolutionRole)({
        cwd: isolationCwd,
        role: 'direct-asset-editor',
        prompt: directEditorPrompt(prepared.promptInput, {
          workingDirectory: isolationCwd,
          editableAbsoluteRoots: editableRoots(
            isolationCwd,
            prepared.promptInput.scope,
            prepared.promptInput.scopeRef,
          ),
        }),
        jobId: `direct-asset-editor-${runId}`,
        // No fixed turn cap: the editor edits a variable number of files and must
        // be able to finish and emit its result JSON. A fixed cap truncated valid
        // edits as error_max_turns and rolled back otherwise-good work. The hidden
        // role stays bounded by scoped permissions, the isolation workspace, and
        // post-edit validation/judge instead of an arbitrary turn limit.
        maxTurns: 0,
        extraArgs: directEditorScopedPermissionArgs(
          isolationCwd,
          prepared.promptInput.scope,
          prepared.promptInput.scopeRef,
        ),
        hidden: true,
      })
    } catch (error) {
      result = {
        exitCode: 1,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        parsedResult: undefined,
      }
    }
  } else {
    result = {
      exitCode: 1,
      roleReference: 'role:direct-asset-editor',
      stdout: '',
      stderr:
        prepared.prepareError ??
        'direct asset editor isolation workspace was not created',
      parsedResult: undefined,
    }
  }

  // Phase C (locked): import the isolation changes, validate, judge, and
  // commit or roll back against the real asset tree.
  return await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-finalize',
      runId,
      timeoutMs,
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    () => withEvolutionSourceLease(input, () =>
      finalizeDirectAssetEditorRun({
        input,
        promptInput: prepared.promptInput,
        runId,
        result,
        beforeSnapshot: prepared.beforeSnapshot,
        baseSnapshotId: prepared.baseSnapshotId,
        dirtyFilesAtStart: prepared.dirtyFilesAtStart,
        protectedCoreFiles: prepared.protectedCoreFiles,
        isolation: prepared.isolation,
        isolatedProtectedCoreFiles: prepared.isolatedProtectedCoreFiles,
        isolatedGuardedWorkspaceFiles: prepared.isolatedGuardedWorkspaceFiles,
        shouldImportFromIsolation: prepared.shouldImportFromIsolation,
      })),
  )
}

async function prepareDirectAssetEditorRun(
  input: MatOSDirectAssetEditorRunInput,
  runId: string,
): Promise<DirectAssetEditorPreparation> {
  await readMatOSProjectConfig(input.cwd, { strict: true })
  let promptInput = await buildPromptInput(input)
  const scopedEmptySourceCanCreateFirstAsset =
    promptInput.scope !== 'core' &&
    promptInput.editableRoots.length > 0 &&
    promptInput.targetAssets.length === 0
  const hasRoutedEvolutionTarget = Boolean(
    promptInput.targetContract &&
      (promptInput.targetContract.expectedTypes.length > 0 ||
        promptInput.targetContract.preferredRefs.length > 0),
  )
  if (promptInput.experiences.length === 0 && !hasRoutedEvolutionTarget) {
    return { kind: 'skip', record: undefined }
  }
  if (
    promptInput.targetAssets.length === 0 &&
    !scopedEmptySourceCanCreateFirstAsset
  ) {
    return { kind: 'skip', record: undefined }
  }
  try {
    await assertDirectEditorWritableRoots({
      cwd: input.cwd,
      scope: promptInput.scope,
      ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
    })
  } catch (error) {
    return {
      kind: 'skip',
      record: await writeFailedDirectEditorPreflightRecord({
        cwd: input.cwd,
        runId,
        promptInput,
        summary:
          'Direct asset editor skipped because editable asset roots are not writable.',
        stderr: `Refusing direct asset editor run before modification: ${
          error instanceof Error ? error.message : String(error)
        }`,
        status: 'blocked',
        statusReason: 'direct_editor_writable_root_unavailable',
      }),
    }
  }
  // Runs that require Gitea source acceptance cannot succeed without a
  // matching git-backed source: the editor, validation, and semantic judge
  // would all run only for the acceptance gate to fail and roll everything
  // back. Project scope is the expensive case: its `.matos/assets` root always
  // exists, so unlike user/team it passes the writable-roots preflight and
  // previously burned the full hidden-LLM chain before the guaranteed
  // rollback. Block cheaply before the editor instead.
  if (
    directEditorRequiresGiteaSourceAcceptance(input.env, promptInput.scope)
  ) {
    const config = await readMatOSProjectConfig(input.cwd)
    const hasMatchingGitSource = (config.assetSources ?? []).some(
      source =>
        source.type === 'git' &&
        directEditorAssetSourceMatchesRunScope({
          source,
          scope: promptInput.scope,
          ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        }),
    )
    if (!hasMatchingGitSource) {
      return {
        kind: 'skip',
        record: await writeFailedDirectEditorPreflightRecord({
          cwd: input.cwd,
          runId,
          promptInput,
          summary:
            'Direct asset editor skipped because no matching Gitea-backed asset source is configured for this scope.',
          stderr: `Refusing direct asset editor run before modification: Gitea source acceptance is required for scope ${promptInput.scope}${
            promptInput.scopeRef ? ` (${promptInput.scopeRef})` : ''
          }, but no matching git asset source is configured. Provision the scoped source (matos assets git provision-scope, matos gateway users provision-assets) or set MATOS_DIRECT_EDITOR_REQUIRE_GITEA_SOURCE_ACCEPTANCE=0 for an explicit local-only recovery run.`,
          status: 'blocked',
          statusReason: 'direct_editor_scoped_source_unavailable',
        }),
      }
    }
  }

  const publicationPreflight = await preflightEvolutionGiteaSources({
    cwd: input.cwd, scope: promptInput.scope, scopeRef: promptInput.scopeRef, env: input.env,
    refreshAccepted: true,
  })
  if (publicationPreflight.ok === false) {
    return { kind: 'skip', record: await writeFailedDirectEditorPreflightRecord({
      cwd: input.cwd, runId, promptInput, status: 'blocked',
      statusReason: publicationPreflight.code,
      summary: 'Direct asset editor blocked by Gitea publication infrastructure preflight.',
      stderr: `${publicationPreflight.sourceId}: ${publicationPreflight.message}`,
    }) }
  }
  if (publicationPreflight.refreshed) promptInput = await buildPromptInput(input)

  const stableSnapshotId = await stableSnapshotForDirectEditorScope(
    input.cwd,
    promptInput.scope,
    promptInput.scopeRef,
  )
  let dirtyFilesAtStart: string[] = []
  if (stableSnapshotId) {
    try {
      dirtyFilesAtStart = await listChangedFilesSinceSnapshot({
        cwd: input.cwd,
        scope: promptInput.scope,
        ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        snapshotId: stableSnapshotId,
      })
    } catch (error) {
      return {
        kind: 'skip',
        record: await writeFailedDirectEditorPreflightRecord({
          cwd: input.cwd,
          runId,
          promptInput,
          summary: 'Direct asset editor skipped because dirty preflight failed.',
          stderr: `Refusing dirty direct asset editor run: ${
            error instanceof Error ? error.message : String(error)
          }`,
          statusReason: 'dirty_preflight_failed',
        }),
      }
    }
  }
  await ensureCwdLocalCoreEditablePack(input.cwd, input.env)
  const beforeSnapshot = await createDirectEditorBeforeSnapshot({
    cwd: input.cwd,
    scope: promptInput.scope,
    ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
    runId,
    triggerKey: input.evolutionContext?.trigger?.key,
    experienceRefs: input.evolutionContext?.experienceRefs,
  })
  const protectedCoreFiles = await captureProtectedCoreFiles(input.cwd)
  // The role runs inside the isolation workspace, so only the isolation cwd is
  // workspace-guarded (captured below). The real cwd must NOT be workspace-guarded:
  // doing so would revert other processes' concurrent writes made during the
  // multi-minute run (e.g. live .matos/sessions logs), causing data loss. The
  // role's own out-of-scope writes are caught by the isolation workspace guard,
  // and hidden/non-editable real assets are covered by the protected-core guard.
  let isolation: DirectEditorIsolationWorkspace | undefined
  let isolatedProtectedCoreFiles: ProtectedCoreFileSnapshot | undefined
  let isolatedGuardedWorkspaceFiles: DirectEditorWorkspaceGuardSnapshot | undefined
  let shouldImportFromIsolation = false
  let prepareError: string | undefined
  try {
    isolation = await createDirectEditorIsolationWorkspace({
      cwd: input.cwd,
      scope: promptInput.scope,
      ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
      runId,
      env: input.env,
    })
    isolatedProtectedCoreFiles = await captureProtectedCoreFiles(isolation.cwd)
    isolatedGuardedWorkspaceFiles = await captureDirectEditorWorkspaceGuard({
      cwd: isolation.cwd,
      scope: promptInput.scope,
      ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
    })
    shouldImportFromIsolation = true
  } catch (error) {
    prepareError = error instanceof Error ? error.message : String(error)
  }

  return {
    kind: 'prepared',
    promptInput,
    beforeSnapshot,
    baseSnapshotId: stableSnapshotId ?? beforeSnapshot.snapshotId,
    dirtyFilesAtStart,
    protectedCoreFiles,
    isolation,
    isolatedProtectedCoreFiles,
    isolatedGuardedWorkspaceFiles,
    shouldImportFromIsolation,
    prepareError,
  }
}

async function finalizeDirectAssetEditorRun(params: {
  input: MatOSDirectAssetEditorRunInput
  promptInput: MatOSDirectAssetEditorPromptInput
  runId: string
  result: EvolutionRoleRunResult
  beforeSnapshot: Awaited<ReturnType<typeof createDirectEditorBeforeSnapshot>>
  baseSnapshotId: string
  dirtyFilesAtStart: string[]
  protectedCoreFiles: ProtectedCoreFileSnapshot
  isolation: DirectEditorIsolationWorkspace | undefined
  isolatedProtectedCoreFiles: ProtectedCoreFileSnapshot | undefined
  isolatedGuardedWorkspaceFiles: DirectEditorWorkspaceGuardSnapshot | undefined
  shouldImportFromIsolation: boolean
}): Promise<MatOSDirectAssetEditorRunRecord> {
  const {
    input,
    promptInput,
    runId,
    beforeSnapshot,
    baseSnapshotId,
    dirtyFilesAtStart,
    protectedCoreFiles,
    isolation,
    isolatedProtectedCoreFiles,
    isolatedGuardedWorkspaceFiles,
    shouldImportFromIsolation,
  } = params
  let result = params.result
  const editorOutput =
    result.exitCode === 0
      ? normalizeEditorOutput(result.parsedResult)
      : {
          summary: 'Direct asset editor role failed.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        }
  const editorReportedNoAssetEdits =
    result.exitCode === 0 && editorOutputReportsNoAssetEdits(editorOutput)
  let editorProducedNoAssetEdits = editorReportedNoAssetEdits
  let afterSnapshot: string | undefined
  let rollbackSnapshot: string | undefined
  let diffPatchPath: string | undefined
  let validation: MatOSAssetHistoryValidationResult | undefined
  let validationBaseline: MatOSAssetHistoryValidationResult | undefined
  let introducedValidationErrors: unknown[] | undefined
  let acceptanceEvidence: MatOSDirectAssetEditorAcceptanceEvidence | undefined
  let semanticAcceptance: MatOSSemanticAcceptanceResult | undefined
  let rollback: MatOSDirectAssetEditorRunRecord['rollback']
  let finalStatus: MatOSDirectAssetEditorRunRecord['status'] = 'noop'
  let statusReason: string | undefined
  let validationBaselineError: string | undefined
  let hasActualChanges = false
  let importBackups: DirectEditorImportBackup[] = []
  let rollbackBaseSnapshot = beforeSnapshot
  let generatedRuntimeRelocations: ScopedGeneratedRuntimeAssetRelocation[] = []
  let mergeMode: MatOSDirectAssetEditorMergeMode | undefined =
    dirtyFilesAtStart.length > 0 ? 'dirty-auto' : undefined
  let pendingMerge: string | undefined
  let mergeConflicts: MatOSDirectAssetEditorMergeConflict[] | undefined
  let giteaReview: MatOSDirectAssetEditorGiteaReview | undefined
  let importedTouchedPaths: string[] = []
  let enabledRuntimeManifestPaths: string[] = []
  let sourceCommits: MatOSGitAssetSourceCommitResult[] | undefined
  let sourceAcceptance: MatOSDirectAssetEditorSourceAcceptance[] | undefined
  let sourceRollback: MatOSDirectAssetEditorSourceRollbackTarget[] | undefined
  let sourceCommitErrors: MatOSDirectAssetEditorSourceCommitError[] | undefined
  let sourceAcceptanceOriginalConfig: MatOSProjectConfig | undefined
  let proposal: MatOSDirectAssetEditorProposal | undefined
  const sourceAcceptancePushedSourceIds = new Set<string>()
  const sourceAcceptancePushedCommits = new Map<string, string>()
  const createdAt = nowIso()

  const writeCheckpoint = async (
    status: Extract<MatOSDirectAssetEditorRunStatus, 'edited' | 'validated'>,
    checkpointReason: string,
  ): Promise<void> => {
    const timestamp = nowIso()
    await writeMatOSDirectAssetEditorRunRecord(input.cwd, {
      runId,
      status,
      statusReason: checkpointReason,
      createdAt,
      updatedAt: timestamp,
      scope: promptInput.scope,
      input: promptInput,
      editorOutput,
      modifiedFiles: editorOutput.modifiedFiles,
      createdAssets: editorOutput.createdAssets,
      updatedAssets: editorOutput.updatedAssets,
      disabledAssets: editorOutput.disabledAssets,
      evidenceRefs: editorOutput.evidenceRefs,
      // Persisted at every checkpoint so interrupted-run recovery can trust
      // the import machinery's own touched-path list instead of the editor
      // LLM's self-reported file list.
      ...(importedTouchedPaths.length > 0 ? { importedTouchedPaths } : {}),
      roleExitCode: result.exitCode,
      beforeSnapshot: beforeSnapshot.snapshotId,
      rollbackBaseSnapshot: rollbackBaseSnapshot.snapshotId,
      ...(afterSnapshot ? { afterSnapshot } : {}),
      ...(diffPatchPath ? { diffPatchPath } : {}),
      ...(validation ? { validation } : {}),
      ...(validationBaseline ? { validationBaseline } : {}),
      ...(introducedValidationErrors
        ? { introducedValidationErrors }
        : {}),
      ...(acceptanceEvidence ? { acceptanceEvidence } : {}),
      ...(semanticAcceptance ? { semanticAcceptance } : {}),
      ...(mergeMode ? { mergeMode } : {}),
      ...(dirtyFilesAtStart.length > 0 ? { dirtyFilesAtStart } : {}),
      ...(pendingMerge ? { pendingMerge } : {}),
      ...(mergeConflicts && mergeConflicts.length > 0
        ? { mergeConflicts }
        : {}),
      ...(giteaReview ? { giteaReview } : {}),
      ...(sourceAcceptance ? { sourceAcceptance } : {}),
      ...(sourceRollback ? { sourceRollback } : {}),
      ...(result.stderr ? { stderr: result.stderr.slice(0, 2000) } : {}),
      ...(result.upstreamSessionId ? { upstreamSessionId: result.upstreamSessionId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.modelUsage ? { modelUsage: result.modelUsage } : {}),
      ...(result.totalCostUsd !== undefined
        ? { totalCostUsd: result.totalCostUsd }
        : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result.durationApiMs !== undefined
        ? { durationApiMs: result.durationApiMs }
        : {}),
      ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
    })
  }

  // Path set the run actually wrote (import operations, backed-up paths, and
  // relocation source/target directories). Rejection rollbacks are scoped to
  // this set so concurrent third-party writes made while the lock was released
  // during Phase B survive; without a trustworthy set (non-isolation runs) the
  // legacy whole-tree rollback is kept.
  const runTouchedRollbackPaths = (): string[] | undefined => {
    if (!shouldImportFromIsolation || !isolation) {
      return undefined
    }
    const paths = new Set<string>(importedTouchedPaths)
    for (const backup of importBackups) {
      paths.add(
        guardKeyForPath(
          input.cwd,
          backup.absolutePath,
          promptInput.scope,
          promptInput.scopeRef,
        ),
      )
    }
    for (const relocation of generatedRuntimeRelocations) {
      paths.add(relocation.from)
      paths.add(relocation.to)
    }
    return [...paths]
  }

  try {
    await writeCheckpoint('edited', 'finalize_started')
    if (editorReportedNoAssetEdits && shouldImportFromIsolation && isolation) {
      editorProducedNoAssetEdits = !(await directEditorIsolationDiffersFromSnapshot({
        realCwd: input.cwd,
        isolatedCwd: isolation.cwd,
        scope: promptInput.scope,
        ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        snapshotId: beforeSnapshot.snapshotId,
      }))
    }
    if (editorProducedNoAssetEdits) {
      finalStatus = 'noop'
      statusReason = 'editor_reported_no_asset_edits'
    } else if (
      shouldImportFromIsolation &&
      isolation &&
      isolatedProtectedCoreFiles &&
      isolatedGuardedWorkspaceFiles
    ) {
      const isolatedProtectedChanges = await restoreProtectedCoreFileChanges({
        cwd: isolation.cwd,
        before: isolatedProtectedCoreFiles,
      })
      if (isolatedProtectedChanges.length > 0) {
        throw new Error(
          `protected core asset files modified outside direct-editor scope: ${isolatedProtectedChanges.join(', ')}`,
        )
      }
      const isolatedWorkspaceGuardChanges = await restoreDirectEditorWorkspaceGuardChanges({
        cwd: isolation.cwd,
        scope: promptInput.scope,
        ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        before: isolatedGuardedWorkspaceFiles,
      })
      if (isolatedWorkspaceGuardChanges.length > 0) {
        throw new Error(
          `files modified outside direct-editor writable scope: ${isolatedWorkspaceGuardChanges.join(', ')}`,
        )
      }
      if (await hasMatOSAssetHistoryWorkingTreeChanges({ cwd: input.cwd, snapshotId: beforeSnapshot.snapshotId })) {
        rollbackBaseSnapshot = await createMatOSAssetHistorySnapshot({
          cwd: input.cwd, scope: promptInput.scope, scopeRef: promptInput.scopeRef,
          kind: 'direct-editor-before', ref: `refs/matos/evolution/direct-editor/${runId}/import-base`,
          provenance: { runId, purpose: 'rollback-import-base' },
        })
        await writeCheckpoint('edited', 'pre_import_snapshot_created')
      }
      const importResult = await importDirectEditorAllowedRootsFromIsolation({
        realCwd: input.cwd,
        isolatedCwd: isolation.cwd,
        scope: promptInput.scope,
        ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        runId,
        beforeSnapshotId: beforeSnapshot.snapshotId,
        baseSnapshotId,
        dirtyFilesAtStart,
      })
      importedTouchedPaths = importResult.touchedPaths
      importBackups = importResult.backups
      if (importResult.mergeMode === 'dirty-three-way') {
        mergeMode = 'dirty-three-way'
      } else if (!mergeMode && importResult.mergeMode) {
        mergeMode = importResult.mergeMode
      }
      if (importResult.pendingMerge) {
        pendingMerge = importResult.pendingMerge
        mergeConflicts = importResult.mergeConflicts ?? []
        mergeMode = 'conflict'
        finalStatus = 'pending_merge'
        statusReason = 'import_conflict_pending_merge'
        giteaReview = await createGiteaReviewForPendingDirectEditorMerge({
          cwd: input.cwd,
          runId,
          scope: promptInput.scope,
          ...(input.env ? { env: input.env } : {}),
          summary: editorOutput.summary,
          evidenceRefs: editorOutput.evidenceRefs,
        })
      }
    }
    if (editorProducedNoAssetEdits) {
      hasActualChanges = false
    } else if (pendingMerge) {
      hasActualChanges = false
    } else {
      generatedRuntimeRelocations =
        await relocateScopedGeneratedRuntimeAssets({
          cwd: input.cwd,
          scope: promptInput.scope,
          ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
          touchedPaths: importedTouchedPaths,
          targetAssetCreationRoots: promptInput.targetAssetCreationRoots,
        })
      if (generatedRuntimeRelocations.length > 0) {
        // Remap the run's own touched paths through the relocation instead of
        // re-listing the whole working-tree delta: a whole-tree listing would
        // fold concurrent third-party Phase B writes into this run's path set.
        const remapped = new Set<string>()
        for (const path of importedTouchedPaths) {
          const relocation = generatedRuntimeRelocations.find(
            item => path === item.from || path.startsWith(`${item.from}/`),
          )
          remapped.add(
            relocation
              ? `${relocation.to}${path.slice(relocation.from.length)}`
              : path,
          )
        }
        importedTouchedPaths = [...remapped].sort((a, b) => a.localeCompare(b))
      }
      const generatedRuntimeAssetViolations =
        await scopedGeneratedRuntimeAssetViolations({
          cwd: input.cwd,
          scope: promptInput.scope,
          ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
          touchedPaths: importedTouchedPaths,
        })
      if (generatedRuntimeAssetViolations.length > 0) {
        throw new Error(
          `target asset path policy failed: scoped direct editor wrote runtime assets under generated evidence roots (${generatedRuntimeAssetViolations.join(', ')}). Create or update role/skill/workflow/tool/MCP/knowledge assets under targetAssetCreationRoots / the Gitea source-cache root instead; generated roots are for experience evidence only.`,
        )
      }
      enabledRuntimeManifestPaths = await enableDirectEditorRuntimeAssets({
        cwd: input.cwd,
        scope: promptInput.scope,
        ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        touchedPaths: [
          ...importedTouchedPaths,
          // Relocated generated runtime assets are re-homed wholesale, so
          // their manifests may not appear in the per-operation touched list.
          ...generatedRuntimeRelocations.map(item => `${item.to}/asset.json`),
        ],
      })
      const protectedChanges = shouldImportFromIsolation ? [] : await restoreProtectedCoreFileChanges({
        cwd: input.cwd,
        before: protectedCoreFiles,
      })
      if (protectedChanges.length > 0) {
        throw new Error(
          `protected core asset files modified outside direct-editor scope: ${protectedChanges.join(', ')}`,
        )
      }
      hasActualChanges = await hasMatOSAssetHistoryWorkingTreeChanges({
        cwd: input.cwd,
        snapshotId: rollbackBaseSnapshot.snapshotId,
      })
      if (!hasActualChanges) {
        finalStatus = result.exitCode === 0 ? 'noop' : 'failed'
        statusReason =
          result.exitCode === 0
            ? 'no_working_tree_changes'
            : 'editor_role_failed'
      } else {
        const afterRecord = await createDirectEditorAfterSnapshot({
          cwd: input.cwd,
          scope: promptInput.scope,
          ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
          runId,
          parentCommit: rollbackBaseSnapshot.commit,
          triggerKey: input.evolutionContext?.trigger?.key,
          experienceRefs: editorOutput.evidenceRefs,
        })
        afterSnapshot = afterRecord.snapshotId
        const diff = await writeDirectEditorDiffPatch({
          cwd: input.cwd,
          runId,
          beforeSnapshot: rollbackBaseSnapshot.snapshotId,
          afterSnapshot,
        })
        diffPatchPath = diff.path
        // The after snapshot (and everything derived from it: Gate 1
        // validation, the judge diff, the accepted stable ref and Gitea
        // commit) carries the enabled state. Park newly created runtime
        // assets back on draft in the LIVE tree for the duration of the
        // gates so concurrent registry loads never see a not-yet-accepted
        // asset as enabled; the accept path restores the after snapshot,
        // which re-applies the enabled manifests.
        if (enabledRuntimeManifestPaths.length > 0) {
          await parkDirectEditorRuntimeAssetsAsDraft(enabledRuntimeManifestPaths)
        }
        await writeCheckpoint('edited', 'post_edit_snapshot_created')
        if (result.exitCode !== 0) {
          const touchedPaths = runTouchedRollbackPaths()
          const rollbackResult = await rollbackDirectEditorToBefore({
            cwd: input.cwd,
            runId,
            scope: promptInput.scope,
            ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
            beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
            beforeCommit: rollbackBaseSnapshot.commit,
            compareSnapshotId: afterSnapshot,
            ...(touchedPaths ? { runTouchedPaths: touchedPaths } : {}),
            reason: `role failed after modifying files: ${result.stderr || 'non-zero exit'}`,
          })
          finalStatus = rollbackResult.status
          statusReason = 'editor_role_failed'
          rollbackSnapshot = rollbackResult.rollbackSnapshot
          rollback = rollbackResult.rollback
        } else {
          // Gate 1 is differential: capture the pre-edit baseline so that
          // environmental, pre-existing validation failures (e.g. core assets
          // depending on mounted `data:` assets absent from the editable pack)
          // do not block an otherwise-correct edit. Only NEW breakage rolls back.
          validationBaseline = await validateMatOSAssetHistorySnapshot({
            cwd: input.cwd,
            snapshotId: rollbackBaseSnapshot.snapshotId,
            gateProfile: 'smoke',
          }).catch((error: unknown) => {
            // Preserve the cause. Without a baseline only a fully valid after
            // snapshot can pass; unknown errors are not presumed pre-existing.
            validationBaselineError =
              error instanceof Error ? error.message : String(error)
            return undefined
          })
          // A broken edit can make snapshot validation throw outright (for
          // example unparseable asset.json). Treat that as an introduced
          // validation error instead of escaping to the generic catch path,
          // so Gate 1 still records differential evidence and rolls back.
          validation = await validateMatOSAssetHistorySnapshot({
            cwd: input.cwd,
            snapshotId: afterSnapshot,
            gateProfile: 'smoke',
          }).catch((error: unknown) => ({
            ok: false,
            gateProfile: 'smoke' as const,
            assetValidation: {
              ok: false,
              errors: [
                {
                  code: 'validation_exception',
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              ],
            },
            secretScan: { ok: true, findings: [] },
            workflowValidation: [],
          }))
          const usability = evaluateDirectEditorUsability(
            validationBaseline,
            validation,
            { baselineUnavailable: Boolean(validationBaselineError) },
          )
          introducedValidationErrors = usability.introducedErrors
          const observedChanges = usability.usable
            ? await observeDirectEditorAssetChanges({ cwd: input.cwd, beforeSnapshot: rollbackBaseSnapshot.snapshotId, afterSnapshot, onlyPaths: runTouchedRollbackPaths() })
            : { changedPaths: [], actualRefs: [], createdAssets: [], updatedAssets: [], disabledAssets: [] }
          acceptanceEvidence = {
            schemaVersion: 1,
            observedChanges,
            targetConformance: evaluateMatOSEvolutionTargetConformance({
              contract: promptInput.targetContract,
              editorOutput,
              actualRefs: observedChanges.actualRefs,
            }),
          }
          acceptanceEvidence.highRiskAssetPolicy =
            evaluateMatOSEvolutionHighRiskAssetPolicy({
              contract: promptInput.targetContract,
              targetConformance: acceptanceEvidence.targetConformance,
              editorOutput: { ...editorOutput, ...observedChanges },
            })
          await writeCheckpoint(
            'validated',
            usability.usable
              ? 'gate1_validation_passed'
              : 'gate1_validation_failed_pending_rollback',
          )
          if (usability.usable) {
            if (
              targetConformanceBlocksAcceptance(
                acceptanceEvidence.targetConformance,
              ) ||
              highRiskAssetPolicyBlocksAcceptance(
                acceptanceEvidence.highRiskAssetPolicy,
              )
            ) {
              const touchedPaths = runTouchedRollbackPaths()
              const highRiskBlocked = highRiskAssetPolicyBlocksAcceptance(
                acceptanceEvidence.highRiskAssetPolicy,
              )
              const rollbackResult = await rollbackDirectEditorToBefore({
                cwd: input.cwd,
                runId,
                scope: promptInput.scope,
                ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
                beforeCommit: rollbackBaseSnapshot.commit,
                compareSnapshotId: afterSnapshot,
                ...(touchedPaths ? { runTouchedPaths: touchedPaths } : {}),
                reason: highRiskBlocked
                  ? `high-risk asset policy ${acceptanceEvidence.highRiskAssetPolicy?.status}: ${acceptanceEvidence.highRiskAssetPolicy?.reason}`
                  : `target conformance ${acceptanceEvidence.targetConformance.status}: ${acceptanceEvidence.targetConformance.reason}`,
              })
              finalStatus = rollbackResult.status
              statusReason = highRiskBlocked
                ? 'high_risk_asset_policy_rejected'
                : 'target_conformance_rejected'
              rollbackSnapshot = rollbackResult.rollbackSnapshot
              rollback = rollbackResult.rollback
            } else {
              semanticAcceptance = await (input.semanticJudge ??
                runMatOSSemanticAcceptanceJudge)({
                cwd: input.cwd,
                runId,
                scope: promptInput.scope,
                ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                beforeSnapshot: rollbackBaseSnapshot.snapshotId,
                afterSnapshot,
                ...(diffPatchPath ? { diffPatchPath } : {}),
                promptInput,
                editorOutput,
                acceptanceEvidence,
                validation,
                modifiedFiles: editorOutput.modifiedFiles,
                createdAssets: editorOutput.createdAssets,
                updatedAssets: editorOutput.updatedAssets,
                disabledAssets: editorOutput.disabledAssets,
                evidenceRefs: editorOutput.evidenceRefs,
                ...(input.env ? { env: input.env } : {}),
              })
              const policyAccepted = await evolutionAlgorithmAcceptsCandidate({ cwd: input.cwd, promptInput, semanticAcceptance, acceptanceEvidence, env: input.env })
              const approvalMode = semanticAcceptance.verdict === 'accept' && policyAccepted
                ? (await resolveMatOSEvolutionApprovalMode({ cwd: input.cwd, env: input.env })).mode
                : undefined
              await writeCheckpoint(
                'validated',
                semanticAcceptance.verdict === 'accept'
                  ? policyAccepted
                    ? 'semantic_acceptance_passed_pending_source_acceptance'
                    : 'evolution_algorithm_rejected_pending_rollback'
                  : 'semantic_acceptance_rejected_pending_rollback',
              )
              if (approvalMode && approvalMode !== 'auto') {
                // Human approval: keep the judged after snapshot as a proposal
                // and put the live tree back, so no session sees the change
                // until someone approves it.
                const touchedPaths = runTouchedRollbackPaths()
                const rollbackResult = await rollbackDirectEditorToBefore({
                  cwd: input.cwd,
                  runId,
                  scope: promptInput.scope,
                  ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                  beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
                  beforeCommit: rollbackBaseSnapshot.commit,
                  compareSnapshotId: afterSnapshot,
                  ...(touchedPaths ? { runTouchedPaths: touchedPaths } : {}),
                  reason: 'Passed every gate; parked as a proposal awaiting human approval.',
                })
                rollbackSnapshot = rollbackResult.rollbackSnapshot
                if (rollbackResult.status === 'rolled_back') {
                  finalStatus = 'proposed'
                  statusReason = 'awaiting_human_approval'
                  proposal = {
                    proposedAt: nowIso(),
                    approvalMode,
                    ...(touchedPaths ? { touchedPaths } : {}),
                  }
                } else {
                  finalStatus = rollbackResult.status
                  statusReason = 'proposal_rollback_failed'
                  rollback = rollbackResult.rollback
                }
              } else if (semanticAcceptance.verdict === 'accept' && policyAccepted) {
                // The semantic judge may load/materialize assets while evaluating
                // the diff. For accepted edits, re-apply the validated after
                // snapshot before committing scoped Git/Gitea sources so the
                // runtime authority advances with the same content the judge saw.
                await restoreMatOSAssetHistorySnapshot({
                  cwd: input.cwd,
                  snapshotId: afterSnapshot,
                  removeCreatedFiles: true,
                  compareSnapshotId: rollbackBaseSnapshot.snapshotId,
                })
                sourceAcceptanceOriginalConfig = await readMatOSProjectConfig(input.cwd)
                const commitResult = await commitAcceptedDirectEditorGitAssetSources({
                  cwd: input.cwd,
                  runId,
                  scope: promptInput.scope,
                  ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                  summary: editorOutput.summary,
                  // Non-isolation runs cannot attribute changed paths reliably;
                  // omit changedPaths there so acceptance stays conservative.
                  ...(shouldImportFromIsolation && isolation
                    ? { changedPaths: importedTouchedPaths }
                    : {}),
                  ...(input.env ? { env: input.env } : {}),
                  // Ledger every pushed accepted ref the moment the push
                  // lands: if the commit call throws later (config write,
                  // runtime validation), the catch path below still knows
                  // which remote refs to roll back and to which lease commit.
                  onAcceptedRefPushed: async pushed => {
                    sourceAcceptancePushedSourceIds.add(pushed.sourceId)
                    sourceAcceptancePushedCommits.set(
                      pushed.sourceId,
                      pushed.commit,
                    )
                    sourceAcceptance = [...(sourceAcceptance ?? []), {
                      sourceId: pushed.sourceId, acceptedBranch: pushed.acceptedBranch,
                      commit: pushed.commit, previousAcceptedCommit: pushed.previousAcceptedCommit,
                      ok: false, pushed: true, validationOk: true,
                    }]
                    sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({ config: sourceAcceptanceOriginalConfig!, sourceAcceptance })
                    sourceRollback = directEditorSourceRollbackTargetsFromConfig({ config: sourceAcceptanceOriginalConfig, sourceAcceptance })
                    await writeCheckpoint('validated', 'accepted_ref_pushed_pending_runtime_confirmation')
                  },
                  audit: {
                    schemaVersion: 1,
                    runId,
                    scope: promptInput.scope,
                    ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                    status: 'accepted',
                    summary: editorOutput.summary,
                    promptInput,
                    editorOutput,
                    ...(acceptanceEvidence ? { acceptanceEvidence } : {}),
                    semanticAcceptance,
                    validation,
                    ...(validationBaseline ? { validationBaseline } : {}),
                    introducedValidationErrorCount:
                      introducedValidationErrors?.length ?? 0,
                    beforeSnapshot: beforeSnapshot.snapshotId,
                    afterSnapshot,
                    ...(diffPatchPath ? { diffPatchPath } : {}),
                  },
                })
                sourceCommits = commitResult.sourceCommits
                sourceAcceptance = commitResult.sourceAcceptance
                if (sourceAcceptanceOriginalConfig) {
                  sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({
                    config: sourceAcceptanceOriginalConfig,
                    sourceAcceptance,
                  })
                }
                sourceRollback =
                  sourceAcceptanceOriginalConfig && sourceAcceptance
                    ? directEditorSourceRollbackTargetsFromConfig({
                        config: sourceAcceptanceOriginalConfig,
                        sourceAcceptance,
                      })
                    : undefined
                sourceCommitErrors = commitResult.sourceCommitErrors
                if (
                  (directEditorRequiresGiteaSourceAcceptance(
                    input.env,
                    promptInput.scope,
                  ) ||
                    commitResult.matchedGitSourceCount > 0) &&
                  // Runs whose accepted changes live entirely outside the
                  // matched source checkouts (for example experience evidence
                  // in local generated roots) have nothing to advance and must
                  // not be rolled back for missing acceptance.
                  commitResult.sourceRootChangesDetected !== false &&
                  (!sourceAcceptance || sourceAcceptance.length === 0)
                ) {
                  sourceCommitErrors ??= []
                  sourceCommitErrors.push({
                    sourceId: 'gitea-native',
                    error:
                      'Gitea source acceptance is required for this direct editor run, but no matching Gitea asset source accepted ref was advanced.',
                  })
                }
                const sourceAcceptanceFailure =
                  directEditorSourceAcceptanceFailureMessage(sourceCommitErrors)
                if (sourceAcceptanceFailure) {
                  throw new Error(sourceAcceptanceFailure)
                }
                await updateDirectEditorStableRef({
                  cwd: input.cwd,
                  scope: promptInput.scope,
                  ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                  commit: afterRecord.commit,
                })
                finalStatus = mergeMode ? 'accepted_merged' : 'accepted'
                // Surfaced as a warning: the differential gate was skipped
                // because baseline validation crashed (secret scan still ran).
                statusReason = validationBaselineError
                  ? 'baseline_validation_unavailable_differential_gate_skipped'
                  : undefined
              } else {
                const touchedPaths = runTouchedRollbackPaths()
                const rollbackResult = await rollbackDirectEditorToBefore({
                  cwd: input.cwd,
                  runId,
                  scope: promptInput.scope,
                  ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
                  beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
                  beforeCommit: rollbackBaseSnapshot.commit,
                  compareSnapshotId: afterSnapshot,
                  ...(touchedPaths ? { runTouchedPaths: touchedPaths } : {}),
                  reason: semanticAcceptance.verdict === 'accept' && !policyAccepted
                    ? 'Rejected by the pinned evolution algorithm after native gates passed.'
                    : `semantic acceptance ${semanticAcceptance.verdict}: ${semanticAcceptance.reason}`,
                })
                finalStatus = rollbackResult.status
                // A judge infrastructure failure is fail-closed like a
                // rejection, but must stay distinguishable for operations and
                // statistics (retry feedback already skips judgeFailed runs).
                statusReason = !policyAccepted && semanticAcceptance.verdict === 'accept'
                  ? 'evolution_algorithm_rejected'
                  : semanticAcceptance.judgeFailed
                  ? 'semantic_judge_unavailable'
                  : 'semantic_acceptance_rejected'
                rollbackSnapshot = rollbackResult.rollbackSnapshot
                rollback = rollbackResult.rollback
              }
            }
          } else {
            const touchedPaths = runTouchedRollbackPaths()
            const rollbackResult = await rollbackDirectEditorToBefore({
              cwd: input.cwd,
              runId,
              scope: promptInput.scope,
              ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
              beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
              beforeCommit: rollbackBaseSnapshot.commit,
              compareSnapshotId: afterSnapshot,
              ...(touchedPaths ? { runTouchedPaths: touchedPaths } : {}),
              reason: `asset validation failed: edit introduced ${
                introducedValidationErrors?.length ?? 0
              } new validation error(s)`,
            })
            finalStatus = rollbackResult.status
            statusReason = 'gate1_validation_failed'
            rollbackSnapshot = rollbackResult.rollbackSnapshot
            rollback = rollbackResult.rollback
          }
        }
      }
    }
  } catch (error) {
    const caughtReason = error instanceof Error ? error.message : String(error)
    // A mid-application import failure carries backups for the operations it
    // already applied; importBackups is otherwise only populated on a fully
    // successful import, so without adopting these the partially imported
    // files would survive the rollback below as residue.
    if (error instanceof DirectEditorImportError && importBackups.length === 0) {
      importBackups = error.appliedBackups
    }
    let importRestoreError: string | undefined
    let importSkippedRemovals: string[] = []
    if (importBackups.length > 0) {
      try {
        const restoreResult = await restoreDirectEditorImportBackups({
          cwd: input.cwd,
          backups: importBackups,
        })
        importSkippedRemovals = restoreResult.skippedRemovals
      } catch (restoreError) {
        importRestoreError =
          restoreError instanceof Error ? restoreError.message : String(restoreError)
      }
    }
    if (sourceAcceptanceOriginalConfig) {
      sourceCommitErrors ??= []
      const sourceRestore = await restoreDirectEditorAcceptedSourceState({
        cwd: input.cwd,
        scope: promptInput.scope,
        ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
        config: sourceAcceptanceOriginalConfig,
        pushedSourceIds: sourceAcceptancePushedSourceIds,
        pushedSourceCommits: sourceAcceptancePushedCommits,
        ...(shouldImportFromIsolation && isolation ? { changedPaths: importedTouchedPaths } : {}),
        ...(input.env ? { env: input.env } : {}),
        sourceCommitErrors,
      })
      if (!sourceRestore.ok) {
        importRestoreError ??= 'one or more remote accepted refs could not be restored'
      }
    }
    // Scope the exception rollback to the paths this run actually touched,
    // exactly like the gate-rejection rollbacks above. Finalize exceptions
    // frequently fire AFTER the judge accepted (post-accept bookkeeping such
    // as Gitea pushes); a whole-tree restore here erased concurrent
    // third-party writes made during the unlocked Phase B window.
    const exceptionTouchedPaths = runTouchedRollbackPaths()
    const rollbackResult = await rollbackDirectEditorToBefore({
      cwd: input.cwd,
      runId,
      scope: promptInput.scope,
      ...(promptInput.scopeRef ? { scopeRef: promptInput.scopeRef } : {}),
      beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
      beforeCommit: rollbackBaseSnapshot.commit,
      ...(afterSnapshot ? { compareSnapshotId: afterSnapshot } : {}),
      ...(exceptionTouchedPaths ? { runTouchedPaths: exceptionTouchedPaths } : {}),
      reason: importRestoreError
        ? `${caughtReason}; import backup restore failed: ${importRestoreError}`
        : importSkippedRemovals.length > 0
          ? `${caughtReason}; import restore skipped ${importSkippedRemovals.length} undeletable residue path(s)`
          : caughtReason,
    })
    finalStatus = importRestoreError ? 'rollback_failed' : rollbackResult.status
    // Failed/blocked/rolled-back records must always carry a machine-readable
    // reason; the human-readable cause stays in rollback.reason.
    statusReason = evolutionInfrastructureFailureCode({ sourceCommitErrors }) ??
      (finalStatus === 'rollback_failed'
        ? 'finalize_exception_rollback_failed'
        : 'finalize_exception_rolled_back')
    rollbackSnapshot = rollbackResult.rollbackSnapshot
    rollback = rollbackResult.rollback
  } finally {
    await isolation?.cleanup().catch(() => undefined)
  }
  const timestamp = nowIso()
  const record: MatOSDirectAssetEditorRunRecord = {
    runId,
    status: finalStatus,
    ...(statusReason ? { statusReason } : {}),
    createdAt,
    updatedAt: timestamp,
    scope: promptInput.scope,
    input: promptInput,
    editorOutput,
    modifiedFiles: editorOutput.modifiedFiles,
    createdAssets: acceptanceEvidence?.observedChanges?.createdAssets ?? editorOutput.createdAssets,
    updatedAssets: acceptanceEvidence?.observedChanges?.updatedAssets ?? editorOutput.updatedAssets,
    disabledAssets: acceptanceEvidence?.observedChanges?.disabledAssets ?? editorOutput.disabledAssets,
    evidenceRefs: editorOutput.evidenceRefs,
    ...(importedTouchedPaths.length > 0 ? { importedTouchedPaths } : {}),
    roleExitCode: result.exitCode,
    beforeSnapshot: beforeSnapshot.snapshotId,
    rollbackBaseSnapshot: rollbackBaseSnapshot.snapshotId,
    ...(afterSnapshot ? { afterSnapshot } : {}),
    ...(rollbackSnapshot ? { rollbackSnapshot } : {}),
    ...(diffPatchPath ? { diffPatchPath } : {}),
    ...(validation ? { validation } : {}),
    ...(validationBaseline ? { validationBaseline } : {}),
    ...(introducedValidationErrors
      ? { introducedValidationErrors }
      : {}),
    ...(acceptanceEvidence ? { acceptanceEvidence } : {}),
    ...(semanticAcceptance ? { semanticAcceptance } : {}),
    ...(rollback ? { rollback } : {}),
    ...(mergeMode ? { mergeMode } : {}),
    ...(dirtyFilesAtStart.length > 0 ? { dirtyFilesAtStart } : {}),
    ...(pendingMerge ? { pendingMerge } : {}),
    ...(mergeConflicts && mergeConflicts.length > 0
      ? { mergeConflicts }
      : {}),
    ...(giteaReview ? { giteaReview } : {}),
    ...(sourceCommits && sourceCommits.length > 0 ? { sourceCommits } : {}),
    ...(sourceAcceptance && sourceAcceptance.length > 0
      ? { sourceAcceptance }
      : {}),
    ...(sourceRollback && sourceRollback.length > 0
      ? { sourceRollback }
      : {}),
    ...(sourceCommitErrors && sourceCommitErrors.length > 0
      ? { sourceCommitErrors }
      : {}),
    ...(proposal && finalStatus === 'proposed' ? { proposal } : {}),
    ...(result.stderr ? { stderr: result.stderr.slice(0, 2000) } : {}),
    ...(result.upstreamSessionId ? { upstreamSessionId: result.upstreamSessionId } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.modelUsage ? { modelUsage: result.modelUsage } : {}),
    ...(result.totalCostUsd !== undefined
      ? { totalCostUsd: result.totalCostUsd }
      : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(result.durationApiMs !== undefined
      ? { durationApiMs: result.durationApiMs }
      : {}),
    ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
  }
  await writeMatOSDirectAssetEditorRunRecord(input.cwd, record)
  scheduleDirectEditorRetentionAfterRun(input.cwd, input.env)
  return record
}

/**
 * Post-acceptance probation decision: a completed regression whose matched
 * benchmarks got WORSE is the only outcome-level signal the pipeline has after
 * Gate 2, and by default it is evidence-only. With
 * MATOS_EVOLUTION_REGRESSION_AUTO_ROLLBACK enabled it closes the loop: the
 * accepted run is rolled back through the same machinery as
 * `matos evolve direct-editor rollback`. 'no-benchmarks' runs never roll back
 * (absence of coverage is not evidence of regression).
 */
export function shouldAutoRollbackAcceptedRunForRegression(
  record: { status: string; overallOk: boolean } | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  if (!record || record.status !== 'completed' || record.overallOk) {
    return false
  }
  return (
    directEditorEnvFlagValue(env, [
      'MATOS_EVOLUTION_REGRESSION_AUTO_ROLLBACK',
    ]) === true
  )
}

/**
 * Accepted edits that touched Algorithm Layer strategy tool assets trigger a
 * background algo-compare regression. Evidence-only by default; with the
 * auto-rollback flag a failed regression rolls the accepted run back (see
 * shouldAutoRollbackAcceptedRunForRegression). Fire-and-forget: failures are
 * swallowed so the self-evolution path is never blocked by regression
 * scheduling.
 */
function scheduleAlgorithmRegressionForAcceptedRun(
  cwd: string,
  record: MatOSDirectAssetEditorRunRecord,
  env?: Record<string, string | undefined>,
): void {
  if (record.status !== 'accepted' && record.status !== 'accepted_merged') {
    return
  }
  const changedAssetRefs = [...record.createdAssets, ...record.updatedAssets]
    .filter(ref => ref.startsWith('tool:'))
  if (changedAssetRefs.length === 0) {
    return
  }
  void import('../algorithms/regression.js')
    .then(module =>
      module.scheduleMatOSAlgorithmRegressionForDirectEditorRun({
        cwd,
        runId: record.runId,
        status: record.status,
        changedAssetRefs,
      }),
    )
    .then(regression => {
      if (!shouldAutoRollbackAcceptedRunForRegression(regression, env)) {
        return undefined
      }
      return rollbackMatOSDirectAssetEditorRun({
        cwd,
        runId: record.runId,
      })
    })
    .catch(() => undefined)
}

async function recoverInterruptedDirectAssetEditorRunLocked(input: {
  cwd: string
  record: MatOSDirectAssetEditorRunRecord & { beforeSnapshot: string }
  semanticJudge?: MatOSSemanticAcceptanceJudge
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorRunRecord> {
  const existing = input.record
  const beforeSnapshotId = existing.beforeSnapshot
  const beforeSnapshot = await readMatOSAssetHistorySnapshot(
    input.cwd,
    beforeSnapshotId,
  )
  if (!beforeSnapshot) {
    throw new Error(
      `Cannot recover interrupted direct editor run ${existing.runId}: before snapshot ${beforeSnapshotId} is missing`,
    )
  }
  const rollbackBaseSnapshot = existing.rollbackBaseSnapshot
    ? await readMatOSAssetHistorySnapshot(input.cwd, existing.rollbackBaseSnapshot)
    : beforeSnapshot
  if (!rollbackBaseSnapshot) throw new Error('Interrupted evolution is missing its import rollback base.')
  let afterSnapshot = existing.afterSnapshot
  let rollbackSnapshot = existing.rollbackSnapshot
  let diffPatchPath = existing.diffPatchPath
  let validation = existing.validation
  let validationBaseline = existing.validationBaseline
  let introducedValidationErrors = existing.introducedValidationErrors
  let acceptanceEvidence = existing.acceptanceEvidence
  let semanticAcceptance = existing.semanticAcceptance
  let rollback = existing.rollback
  let sourceCommits = existing.sourceCommits
  let sourceAcceptance = existing.sourceAcceptance
  let sourceRollback = existing.sourceRollback
  let sourceCommitErrors = existing.sourceCommitErrors
  let sourceAcceptanceOriginalConfig: MatOSProjectConfig | undefined
  const sourceAcceptancePushedSourceIds = new Set<string>()
  const sourceAcceptancePushedCommits = new Map<string, string>()
  if (sourceAcceptance?.some(item => item.pushed)) {
    sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({
      config: await readMatOSProjectConfig(input.cwd, { strict: true }), sourceAcceptance,
    })
    for (const item of sourceAcceptance) {
      if (item.pushed) {
        sourceAcceptancePushedSourceIds.add(item.sourceId)
        sourceAcceptancePushedCommits.set(item.sourceId, item.commit)
      }
    }
  }
  let sourceRestoreAttempted = false
  let finalStatus: MatOSDirectAssetEditorRunRecord['status'] = existing.status
  let statusReason: string | undefined
  let proposal: MatOSDirectAssetEditorProposal | undefined
  let dirtyFilesAtStart = existing.dirtyFilesAtStart
  let stderr = existing.stderr
  // Same contract as runTouchedRollbackPaths in the live finalize path: scope
  // recovery rollbacks to the import machinery's persisted touched-path
  // checkpoint. Recovery re-validates and judges for minutes after its
  // unexpected-dirty-files gate, and a whole-tree restore at the end of that
  // window erased concurrent third-party writes (workbench saves, releases,
  // intake) landed since the gate. Records checkpointed before
  // importedTouchedPaths existed keep the legacy whole-tree rollback.
  const recoveryTouchedPaths =
    existing.importedTouchedPaths && existing.importedTouchedPaths.length > 0
      ? existing.importedTouchedPaths
      : undefined

  const writeRecoveredRecord = async (): Promise<MatOSDirectAssetEditorRunRecord> => {
    if (!sourceRestoreAttempted && sourceAcceptanceOriginalConfig &&
      ['rolled_back', 'rollback_failed', 'blocked', 'failed'].includes(finalStatus)) {
      sourceRestoreAttempted = true
      sourceCommitErrors ??= []
      const restored = await restoreDirectEditorAcceptedSourceState({
        cwd: input.cwd, scope: existing.scope, scopeRef: existing.input.scopeRef,
        config: sourceAcceptanceOriginalConfig, pushedSourceIds: sourceAcceptancePushedSourceIds,
        pushedSourceCommits: sourceAcceptancePushedCommits, changedPaths: recoveryTouchedPaths,
        env: input.env, sourceCommitErrors,
      })
      if (!restored.ok) finalStatus = 'rollback_failed'
    }
    const updated: MatOSDirectAssetEditorRunRecord = {
      ...existing,
      status: finalStatus,
      updatedAt: nowIso(),
    }
    delete updated.statusReason
    delete updated.afterSnapshot
    delete updated.rollbackSnapshot
    delete updated.diffPatchPath
    delete updated.validation
    delete updated.validationBaseline
    delete updated.introducedValidationErrors
    delete updated.acceptanceEvidence
    delete updated.semanticAcceptance
    delete updated.rollback
    delete updated.sourceCommits
    delete updated.sourceAcceptance
    delete updated.sourceRollback
    delete updated.sourceCommitErrors
    delete updated.dirtyFilesAtStart
    delete updated.stderr
    delete updated.proposal
    if (statusReason) {
      updated.statusReason = statusReason
    }
    if (proposal) {
      updated.proposal = proposal
    }
    if (afterSnapshot) {
      updated.afterSnapshot = afterSnapshot
    }
    if (rollbackSnapshot) {
      updated.rollbackSnapshot = rollbackSnapshot
    }
    if (diffPatchPath) {
      updated.diffPatchPath = diffPatchPath
    }
    if (validation) {
      updated.validation = validation
    }
    if (validationBaseline) {
      updated.validationBaseline = validationBaseline
    }
    if (introducedValidationErrors) {
      updated.introducedValidationErrors = introducedValidationErrors
    }
    if (acceptanceEvidence) {
      updated.acceptanceEvidence = acceptanceEvidence
      if (acceptanceEvidence.observedChanges) {
        updated.createdAssets = acceptanceEvidence.observedChanges.createdAssets
        updated.updatedAssets = acceptanceEvidence.observedChanges.updatedAssets
        updated.disabledAssets = acceptanceEvidence.observedChanges.disabledAssets
      }
    }
    if (semanticAcceptance) {
      updated.semanticAcceptance = semanticAcceptance
    }
    if (rollback) {
      updated.rollback = rollback
    }
    if (sourceCommits && sourceCommits.length > 0) {
      updated.sourceCommits = sourceCommits
    }
    if (sourceAcceptance && sourceAcceptance.length > 0) {
      updated.sourceAcceptance = sourceAcceptance
    }
    if (sourceRollback && sourceRollback.length > 0) {
      updated.sourceRollback = sourceRollback
    }
    if (sourceCommitErrors && sourceCommitErrors.length > 0) {
      updated.sourceCommitErrors = sourceCommitErrors
    }
    if (dirtyFilesAtStart && dirtyFilesAtStart.length > 0) {
      updated.dirtyFilesAtStart = dirtyFilesAtStart
    }
    if (stderr) {
      updated.stderr = stderr.slice(0, 2000)
    }
    updated.algorithmOutcomeRecorded = await recordEvolutionAlgorithmOutcome(input.cwd, updated, input.env)
    await writeMatOSDirectAssetEditorRunRecord(input.cwd, updated)
    return updated
  }

  const changedFiles = await listChangedFilesSinceSnapshot({
    cwd: input.cwd,
    scope: existing.scope,
    ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
    snapshotId: rollbackBaseSnapshot.snapshotId,
  })
  if (changedFiles.length === 0 && sourceAcceptancePushedSourceIds.size === 0) {
    finalStatus = 'noop'
    statusReason = 'interrupted_finalize_recovered_no_changes'
    return writeRecoveredRecord()
  }
  const unexpectedFiles = unexpectedDirectEditorRecoveryChangedFiles({
    cwd: input.cwd,
    record: existing,
    changedFiles,
  })
  if (unexpectedFiles.length > 0) {
    finalStatus = 'blocked'
    statusReason = 'interrupted_finalize_recovery_unexpected_dirty_files'
    dirtyFilesAtStart = changedFiles
    stderr = [
      'Interrupted direct-editor recovery refused to finalize because the current asset working tree contains changes not declared by the interrupted run.',
      `Unexpected changed files: ${unexpectedFiles.slice(0, 20).join(', ')}`,
    ].join('\n')
    return writeRecoveredRecord()
  }

  try {
    const afterRecord = await createDirectEditorAfterSnapshot({
      cwd: input.cwd,
      scope: existing.scope,
      ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
      runId: existing.runId,
      parentCommit: rollbackBaseSnapshot.commit,
      triggerKey: existing.input.currentEvolutionContext?.trigger?.key,
      experienceRefs: existing.evidenceRefs,
    })
    afterSnapshot = afterRecord.snapshotId
    const diff = await writeDirectEditorDiffPatch({
      cwd: input.cwd,
      runId: existing.runId,
      beforeSnapshot: rollbackBaseSnapshot.snapshotId,
      afterSnapshot,
    })
    diffPatchPath = diff.path
    let validationBaselineError: string | undefined
    validationBaseline = await validateMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      snapshotId: rollbackBaseSnapshot.snapshotId,
      gateProfile: 'smoke',
    }).catch((error: unknown) => {
      validationBaselineError =
        error instanceof Error ? error.message : String(error)
      return undefined
    })
    validation = await validateMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      snapshotId: afterSnapshot,
      gateProfile: 'smoke',
    }).catch((error: unknown) => ({
      ok: false,
      gateProfile: 'smoke' as const,
      assetValidation: {
        ok: false,
        errors: [
          {
            code: 'validation_exception',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
      secretScan: { ok: true, findings: [] },
      workflowValidation: [],
    }))
    const usability = evaluateDirectEditorUsability(
      validationBaseline,
      validation,
      { baselineUnavailable: Boolean(validationBaselineError) },
    )
    introducedValidationErrors = usability.introducedErrors
    const observedChanges = usability.usable
      ? await observeDirectEditorAssetChanges({ cwd: input.cwd, beforeSnapshot: rollbackBaseSnapshot.snapshotId, afterSnapshot, onlyPaths: recoveryTouchedPaths })
      : { changedPaths: [], actualRefs: [], createdAssets: [], updatedAssets: [], disabledAssets: [] }
    acceptanceEvidence = {
      schemaVersion: 1,
      observedChanges,
      targetConformance: evaluateMatOSEvolutionTargetConformance({
        contract: existing.input.targetContract,
        editorOutput: existing.editorOutput,
        actualRefs: observedChanges.actualRefs,
      }),
    }
    acceptanceEvidence.highRiskAssetPolicy =
      evaluateMatOSEvolutionHighRiskAssetPolicy({
        contract: existing.input.targetContract,
        targetConformance: acceptanceEvidence.targetConformance,
        editorOutput: { ...existing.editorOutput, ...observedChanges },
      })
    if (!usability.usable) {
      const rollbackResult = await rollbackDirectEditorToBefore({
        cwd: input.cwd,
        runId: existing.runId,
        scope: existing.scope,
        ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
        beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
        beforeCommit: rollbackBaseSnapshot.commit,
        compareSnapshotId: afterSnapshot,
        ...(recoveryTouchedPaths ? { runTouchedPaths: recoveryTouchedPaths } : {}),
        reason: `interrupted direct-editor recovery validation failed: edit introduced ${
          introducedValidationErrors.length
        } new validation error(s)`,
      })
      finalStatus = rollbackResult.status
      statusReason = 'interrupted_finalize_recovered_validation_failed'
      rollbackSnapshot = rollbackResult.rollbackSnapshot
      rollback = rollbackResult.rollback
      return writeRecoveredRecord()
    }

    if (
      targetConformanceBlocksAcceptance(
        acceptanceEvidence.targetConformance,
      ) ||
      highRiskAssetPolicyBlocksAcceptance(
        acceptanceEvidence.highRiskAssetPolicy,
      )
    ) {
      const rollbackResult = await rollbackDirectEditorToBefore({
        cwd: input.cwd,
        runId: existing.runId,
        scope: existing.scope,
        ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
        beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
        beforeCommit: rollbackBaseSnapshot.commit,
        compareSnapshotId: afterSnapshot,
        ...(recoveryTouchedPaths ? { runTouchedPaths: recoveryTouchedPaths } : {}),
        reason: highRiskAssetPolicyBlocksAcceptance(
          acceptanceEvidence.highRiskAssetPolicy,
        )
          ? `interrupted direct-editor recovery high-risk asset policy ${acceptanceEvidence.highRiskAssetPolicy?.status}: ${acceptanceEvidence.highRiskAssetPolicy?.reason}`
          : `interrupted direct-editor recovery target conformance ${acceptanceEvidence.targetConformance.status}: ${acceptanceEvidence.targetConformance.reason}`,
      })
      finalStatus = rollbackResult.status
      statusReason = 'interrupted_finalize_recovered_target_conformance_failed'
      rollbackSnapshot = rollbackResult.rollbackSnapshot
      rollback = rollbackResult.rollback
      return writeRecoveredRecord()
    }

    semanticAcceptance = await (input.semanticJudge ??
      runMatOSSemanticAcceptanceJudge)({
      cwd: input.cwd,
      runId: existing.runId,
      scope: existing.scope,
      ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
      beforeSnapshot: rollbackBaseSnapshot.snapshotId,
      afterSnapshot,
      ...(diffPatchPath ? { diffPatchPath } : {}),
      promptInput: existing.input,
      editorOutput: existing.editorOutput,
      acceptanceEvidence,
      validation,
      modifiedFiles: existing.editorOutput.modifiedFiles,
      createdAssets: existing.editorOutput.createdAssets,
      updatedAssets: existing.editorOutput.updatedAssets,
      disabledAssets: existing.editorOutput.disabledAssets,
      evidenceRefs: existing.editorOutput.evidenceRefs,
      ...(input.env ? { env: input.env } : {}),
    })
    const policyAccepted = await evolutionAlgorithmAcceptsCandidate({ cwd: input.cwd, promptInput: existing.input, semanticAcceptance, acceptanceEvidence, env: input.env })
    if (semanticAcceptance.verdict !== 'accept' || !policyAccepted) {
      const rollbackResult = await rollbackDirectEditorToBefore({
        cwd: input.cwd,
        runId: existing.runId,
        scope: existing.scope,
        ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
        beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
        beforeCommit: rollbackBaseSnapshot.commit,
        compareSnapshotId: afterSnapshot,
        ...(recoveryTouchedPaths ? { runTouchedPaths: recoveryTouchedPaths } : {}),
        reason: semanticAcceptance.verdict === 'accept' && !policyAccepted
          ? 'interrupted direct-editor recovery rejected by the pinned evolution algorithm'
          : `interrupted direct-editor recovery semantic acceptance ${semanticAcceptance.verdict}: ${semanticAcceptance.reason}`,
      })
      finalStatus = rollbackResult.status
      statusReason = !policyAccepted && semanticAcceptance.verdict === 'accept'
        ? 'evolution_algorithm_rejected'
        : semanticAcceptance.judgeFailed
        ? 'interrupted_finalize_semantic_judge_unavailable'
        : 'interrupted_finalize_recovered_semantic_rejected'
      rollbackSnapshot = rollbackResult.rollbackSnapshot
      rollback = rollbackResult.rollback
      return writeRecoveredRecord()
    }

    // Same approval gate as the live finalize path. A run interrupted after it
    // already pushed an accepted ref was published under auto mode and keeps
    // finishing that acceptance.
    const approvalMode = (await resolveMatOSEvolutionApprovalMode({ cwd: input.cwd, env: input.env })).mode
    if (approvalMode !== 'auto' && sourceAcceptancePushedSourceIds.size === 0) {
      const rollbackResult = await rollbackDirectEditorToBefore({
        cwd: input.cwd,
        runId: existing.runId,
        scope: existing.scope,
        ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
        beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
        beforeCommit: rollbackBaseSnapshot.commit,
        compareSnapshotId: afterSnapshot,
        ...(recoveryTouchedPaths ? { runTouchedPaths: recoveryTouchedPaths } : {}),
        reason: 'Interrupted run passed every gate on recovery; parked as a proposal awaiting human approval.',
      })
      rollbackSnapshot = rollbackResult.rollbackSnapshot
      if (rollbackResult.status === 'rolled_back') {
        finalStatus = 'proposed'
        statusReason = 'awaiting_human_approval'
        proposal = {
          proposedAt: nowIso(),
          approvalMode,
          ...(recoveryTouchedPaths ? { touchedPaths: recoveryTouchedPaths } : {}),
        }
      } else {
        finalStatus = rollbackResult.status
        statusReason = 'proposal_rollback_failed'
        rollback = rollbackResult.rollback
      }
      return writeRecoveredRecord()
    }

    await restoreMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      snapshotId: afterSnapshot,
      removeCreatedFiles: true,
      compareSnapshotId: rollbackBaseSnapshot.snapshotId,
    })
    sourceAcceptanceOriginalConfig ??= await readMatOSProjectConfig(input.cwd, { strict: true })
    const commitResult = await commitAcceptedDirectEditorGitAssetSources({
      cwd: input.cwd,
      runId: existing.runId,
      scope: existing.scope,
      ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
      summary: existing.editorOutput.summary,
      ...(input.env ? { env: input.env } : {}),
      allowAlreadyAccepted: true,
      changedPaths: recoveryTouchedPaths,
      // Ledger pushed accepted refs immediately so a post-push throw inside
      // the commit call cannot orphan already-advanced remote refs.
      onAcceptedRefPushed: async pushed => {
        sourceAcceptancePushedSourceIds.add(pushed.sourceId)
        sourceAcceptancePushedCommits.set(pushed.sourceId, pushed.commit)
        sourceAcceptance = [...(sourceAcceptance ?? []).filter(item => item.sourceId !== pushed.sourceId), {
          ...pushed, ok: false, pushed: true, validationOk: true,
        }]
        sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({ config: sourceAcceptanceOriginalConfig!, sourceAcceptance })
        sourceRollback = directEditorSourceRollbackTargetsFromConfig({ config: sourceAcceptanceOriginalConfig, sourceAcceptance })
        await writeMatOSDirectAssetEditorRunRecord(input.cwd, { ...existing, updatedAt: nowIso(),
          statusReason: 'accepted_ref_pushed_pending_runtime_confirmation', sourceAcceptance, sourceRollback,
          afterSnapshot, validation, acceptanceEvidence, semanticAcceptance,
        })
      },
      audit: {
        schemaVersion: 1,
        runId: existing.runId,
        scope: existing.scope,
        ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
        status: 'accepted',
        summary: existing.editorOutput.summary,
        promptInput: existing.input,
        editorOutput: existing.editorOutput,
        acceptanceEvidence,
        semanticAcceptance,
        validation,
        ...(validationBaseline ? { validationBaseline } : {}),
        introducedValidationErrorCount:
          introducedValidationErrors.length,
        beforeSnapshot: beforeSnapshotId,
        afterSnapshot,
        ...(diffPatchPath ? { diffPatchPath } : {}),
      },
    })
    sourceCommits = commitResult.sourceCommits
    sourceAcceptance = commitResult.sourceAcceptance?.map(item => {
      const prior = sourceAcceptance?.find(previous => previous.sourceId === item.sourceId && previous.pushed)
      return prior && prior.commit === item.commit ? { ...item, pushed: true, previousAcceptedCommit: prior.previousAcceptedCommit } : item
    }) ?? sourceAcceptance
    if (sourceAcceptanceOriginalConfig) {
      sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({
        config: sourceAcceptanceOriginalConfig,
        sourceAcceptance,
      })
    }
    sourceRollback =
      sourceAcceptanceOriginalConfig && sourceAcceptance
        ? directEditorSourceRollbackTargetsFromConfig({
            config: sourceAcceptanceOriginalConfig,
            sourceAcceptance,
          })
        : undefined
    sourceCommitErrors = commitResult.sourceCommitErrors
    if (sourceAcceptanceOriginalConfig) {
      sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({
        config: sourceAcceptanceOriginalConfig,
        sourceAcceptance: commitResult.sourceAcceptance,
      })
    }
    if (
      (directEditorRequiresGiteaSourceAcceptance(input.env, existing.scope) ||
        commitResult.matchedGitSourceCount > 0) &&
      (!sourceAcceptance || sourceAcceptance.length === 0)
    ) {
      sourceCommitErrors ??= []
      sourceCommitErrors.push({
        sourceId: 'gitea-native',
        error:
          'Gitea source acceptance is required for this interrupted direct editor recovery, but no matching Gitea asset source accepted ref was advanced.',
      })
    }
    const sourceAcceptanceFailure =
      directEditorSourceAcceptanceFailureMessage(sourceCommitErrors)
    if (sourceAcceptanceFailure) {
      throw new Error(sourceAcceptanceFailure)
    }
    await updateDirectEditorStableRef({
      cwd: input.cwd,
      scope: existing.scope,
      ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
      commit: afterRecord.commit,
    })
    finalStatus = existing.mergeMode ? 'accepted_merged' : 'accepted'
    statusReason = 'interrupted_finalize_recovered'
    return writeRecoveredRecord()
  } catch (error) {
    if (sourceAcceptanceOriginalConfig) {
      sourceRestoreAttempted = true
      sourceCommitErrors ??= []
      const sourceRestore = await restoreDirectEditorAcceptedSourceState({
        cwd: input.cwd,
        scope: existing.scope,
        ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
        config: sourceAcceptanceOriginalConfig,
        pushedSourceIds: sourceAcceptancePushedSourceIds,
        pushedSourceCommits: sourceAcceptancePushedCommits,
        changedPaths: recoveryTouchedPaths,
        ...(input.env ? { env: input.env } : {}),
        sourceCommitErrors,
      })
      if (!sourceRestore.ok) {
        finalStatus = 'rollback_failed'
      }
    }
    const rollbackResult = await rollbackDirectEditorToBefore({
      cwd: input.cwd,
      runId: existing.runId,
      scope: existing.scope,
      ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
      beforeSnapshotId: rollbackBaseSnapshot.snapshotId,
      beforeCommit: rollbackBaseSnapshot.commit,
      ...(afterSnapshot ? { compareSnapshotId: afterSnapshot } : {}),
      ...(recoveryTouchedPaths ? { runTouchedPaths: recoveryTouchedPaths } : {}),
      reason: `interrupted direct-editor recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    if (finalStatus !== 'rollback_failed') {
      finalStatus = rollbackResult.status
    }
    statusReason = 'interrupted_finalize_recovery_failed'
    rollbackSnapshot = rollbackResult.rollbackSnapshot
    rollback = rollbackResult.rollback
    return writeRecoveredRecord()
  }
}

export async function recoverInterruptedMatOSDirectAssetEditorRun(input: {
  cwd: string
  runId: string
  semanticJudge?: MatOSSemanticAcceptanceJudge
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  const existing = await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId)
  if (!directEditorRunIsInterrupted(existing)) {
    return undefined
  }
  const recovered = await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-recover',
      runId: input.runId,
      timeoutMs: resolveEvolutionRoleTimeoutMs(input.env),
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    async () => {
      // The candidate was selected from a lock-free read. By the time this
      // lock is acquired another process (a finishing finalize, a concurrent
      // recover, a manual rollback) may already have terminated the run;
      // re-finalizing it would fork local tree, remote accepted refs, and the
      // run record. Re-read and re-verify under the lock, or abandon.
      const current = await readMatOSDirectAssetEditorRunRecord(
        input.cwd,
        input.runId,
      )
      if (!directEditorRunIsInterrupted(current)) {
        return undefined
      }
      return withEvolutionSourceLease({ cwd: input.cwd, scope: current.scope, scopeRef: current.input.scopeRef }, () => recoverInterruptedDirectAssetEditorRunLocked({
        cwd: input.cwd,
        record: current,
        ...(input.semanticJudge ? { semanticJudge: input.semanticJudge } : {}),
        ...(input.env ? { env: input.env } : {}),
      }))
    },
  )
  if (recovered) scheduleAlgorithmRegressionForAcceptedRun(input.cwd, recovered, input.env)
  return recovered
}

export async function recoverInterruptedMatOSDirectAssetEditorRuns(input: {
  cwd: string
  scope?: MatOSDirectAssetEditorScope
  scopeRef?: string
  limit?: number
  semanticJudge?: MatOSSemanticAcceptanceJudge
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorRecoveryResult> {
  const limit = Math.max(1, input.limit ?? 5)
  const candidates = (await listMatOSDirectAssetEditorRunRecords(input.cwd))
    .filter(directEditorRunIsInterrupted)
    .filter(run => (input.scope ? run.scope === input.scope : true))
    .filter(run =>
      input.scopeRef ? run.input.scopeRef === input.scopeRef : true,
    )
    .slice(0, limit)
  const recovered: MatOSDirectAssetEditorRunRecord[] = []
  const skipped: MatOSDirectAssetEditorRunRecord[] = []
  for (const candidate of candidates) {
    const run = await recoverInterruptedMatOSDirectAssetEditorRun({
      cwd: input.cwd,
      runId: candidate.runId,
      ...(input.semanticJudge ? { semanticJudge: input.semanticJudge } : {}),
      ...(input.env ? { env: input.env } : {}),
    })
    if (run) {
      recovered.push(run)
    } else {
      skipped.push(candidate)
    }
  }
  return { recovered, skipped }
}

export async function rollbackMatOSDirectAssetEditorRun(input: {
  cwd: string
  runId: string
}): Promise<MatOSDirectAssetEditorRunRecord | undefined> {
  const existing = await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId)
  if (!existing?.beforeSnapshot) {
    return undefined
  }
  return await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-rollback',
      runId: input.runId,
      timeoutMs: resolveEvolutionRoleTimeoutMs(),
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    async () => {
      const current = await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId)
      if (!current?.beforeSnapshot) return undefined
      return withEvolutionSourceLease({ cwd: input.cwd, scope: current.scope, scopeRef: current.input.scopeRef }, () =>
        rollbackMatOSDirectAssetEditorRunLocked(input.cwd, current as MatOSDirectAssetEditorRunRecord & { beforeSnapshot: string }),
      )
    },
  )
}

async function restoreDirectEditorGiteaSourcesForManualRollback(
  cwd: string,
  existing: MatOSDirectAssetEditorRunRecord,
): Promise<MatOSDirectAssetEditorSourceCommitError[]> {
  if (!existing.sourceRollback || existing.sourceRollback.length === 0) {
    return []
  }
  const currentConfig = await readMatOSProjectConfig(cwd)
  const targets = new Map(
    existing.sourceRollback.map(target => [target.sourceId, target]),
  )
  let changed = false
  const assetSources = (currentConfig.assetSources ?? []).map(source => {
    if (source.type !== 'git') {
      return source
    }
    const target = targets.get(source.id)
    if (!target) {
      return source
    }
    changed = true
    return {
      ...source,
      runtimeRef: {
        mode: 'accepted-ref' as const,
        ref: target.acceptedBranch,
        commit: target.commit,
      },
    }
  })
  if (!changed) {
    return existing.sourceRollback.map(target => ({
      sourceId: target.sourceId,
      error: 'matching Gitea asset source is no longer registered in project config',
    }))
  }
  const sourceCommitErrors: MatOSDirectAssetEditorSourceCommitError[] = []
  await restoreDirectEditorAcceptedSourceState({
    cwd,
    scope: existing.scope,
    ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
    config: {
      ...currentConfig,
      assetSources,
    },
    pushedSourceIds: new Set(
      existing.sourceRollback
        .filter(target => target.pushed)
        .map(target => target.sourceId),
    ),
    pushedSourceCommits: new Map(
      existing.sourceRollback
        .filter(target => target.pushed && target.expectedRemoteCommit)
        .map(target => [target.sourceId, target.expectedRemoteCommit!] as const),
    ),
    sourceCommitErrors,
  })
  return sourceCommitErrors
}

async function rollbackMatOSDirectAssetEditorRunLocked(
  cwd: string,
  existing: MatOSDirectAssetEditorRunRecord & { beforeSnapshot: string },
): Promise<MatOSDirectAssetEditorRunRecord> {
  if (existing.afterSnapshot) {
    const after = await readMatOSAssetHistorySnapshot(cwd, existing.afterSnapshot)
    const stableCommit = await stableCommitForDirectEditorScope(
      cwd,
      existing.scope,
      existing.input.scopeRef,
    )
    if (after && stableCommit && stableCommit !== after.commit) {
      throw new Error(
        `Refusing stale direct editor rollback for ${existing.runId}: stable ref no longer points at the run after snapshot`,
      )
    }
  }
  const sourceRollbackErrors =
    await restoreDirectEditorGiteaSourcesForManualRollback(cwd, existing)
  if (sourceRollbackErrors.length > 0) {
    throw new Error(
      `Gitea-backed source rollback failed: ${sourceRollbackErrors
        .map(error => `${error.sourceId}: ${error.error}`)
        .join('; ')}`,
    )
  }
  await restoreMatOSAssetHistorySnapshot({
    cwd,
    snapshotId: existing.rollbackBaseSnapshot ?? existing.beforeSnapshot,
    removeCreatedFiles: true,
    ...(existing.afterSnapshot ? { compareSnapshotId: existing.afterSnapshot } : {}),
    ...(existing.importedTouchedPaths ? { onlyPaths: existing.importedTouchedPaths } : {}),
  })
  const rollbackRecord = await createDirectEditorRollbackSnapshot({
    cwd,
    scope: existing.scope,
    ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
    runId: existing.runId,
    reason: 'manual rollback',
  })
  await updateDirectEditorStableRef({
    cwd,
    scope: existing.scope,
    ...(existing.input.scopeRef ? { scopeRef: existing.input.scopeRef } : {}),
    commit: rollbackRecord.commit,
  })
  const timestamp = nowIso()
  const updated: MatOSDirectAssetEditorRunRecord = {
    ...existing,
    status: 'rolled_back',
    updatedAt: timestamp,
    rollbackSnapshot: rollbackRecord.snapshotId,
    rollback: {
      reason: 'manual rollback',
      restoredFromSnapshot: existing.rollbackBaseSnapshot ?? existing.beforeSnapshot,
      rollbackSnapshot: rollbackRecord.snapshotId,
    },
  }
  await writeMatOSDirectAssetEditorRunRecord(cwd, updated)
  return updated
}

type DirectEditorProposalRecord = MatOSDirectAssetEditorRunRecord & {
  beforeSnapshot: string
  afterSnapshot: string
}

function assertDirectEditorProposal(
  record: MatOSDirectAssetEditorRunRecord | undefined,
  runId: string,
): asserts record is DirectEditorProposalRecord {
  if (!record) {
    throw new Error(`Direct editor run not found: ${runId}`)
  }
  if (record.status !== 'proposed') {
    throw new Error(`Direct editor run ${runId} is ${record.status}, not a pending proposal`)
  }
  if (!record.beforeSnapshot || !record.afterSnapshot) {
    throw new Error(`Direct editor proposal ${runId} is missing its snapshots`)
  }
}

function directEditorProposalDecision(
  existing: MatOSDirectAssetEditorRunRecord,
  decision: 'approved' | 'rejected',
  note?: string,
): MatOSDirectAssetEditorProposal {
  const { lastApprovalError: _lastApprovalError, ...proposal } = existing.proposal ?? {
    proposedAt: existing.updatedAt,
    approvalMode: 'manual' as const,
  }
  return {
    ...proposal,
    decision,
    decidedAt: nowIso(),
    ...(note?.trim() ? { note: note.trim() } : {}),
  }
}

/**
 * Apply a pending proposal: re-apply the judged after snapshot to the paths the
 * run touched, then publish it through the same source acceptance and stable
 * ref update an auto-accepted run uses. The gates already ran when the
 * proposal was made, so they are not re-run; instead the approval refuses when
 * any touched path changed after the proposal.
 */
export async function approveMatOSDirectAssetEditorProposal(input: {
  cwd: string
  runId: string
  note?: string
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorRunRecord> {
  assertDirectEditorProposal(
    await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId),
    input.runId,
  )
  const approved = await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-approve',
      runId: input.runId,
      timeoutMs: resolveEvolutionRoleTimeoutMs(input.env),
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    async () => {
      const current = await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId)
      assertDirectEditorProposal(current, input.runId)
      // Same scope environment the editor run used for source acceptance.
      const scopeRef = current.input.scopeRef
      const env = scopeRef ? { ...input.env, MATOS_SCOPE_REF: scopeRef } : input.env
      return withEvolutionSourceLease(
        { cwd: input.cwd, scope: current.scope, scopeRef },
        () => approveMatOSDirectAssetEditorProposalLocked({
          ...input,
          ...(env ? { env } : {}),
          existing: current,
        }),
      )
    },
  )
  scheduleAlgorithmRegressionForAcceptedRun(input.cwd, approved, input.env)
  scheduleDirectEditorRetentionAfterRun(input.cwd, input.env)
  return approved
}

async function approveMatOSDirectAssetEditorProposalLocked(input: {
  cwd: string
  runId: string
  note?: string
  env?: Record<string, string | undefined>
  existing: DirectEditorProposalRecord
}): Promise<MatOSDirectAssetEditorRunRecord> {
  const { cwd, existing } = input
  const scopeRef = existing.input.scopeRef
  const baseSnapshotId = existing.rollbackBaseSnapshot ?? existing.beforeSnapshot
  const touchedPaths = existing.proposal?.touchedPaths
  const changedPaths =
    touchedPaths && existing.importedTouchedPaths?.length
      ? existing.importedTouchedPaths
      : undefined
  const changedSinceProposal = await listChangedFilesSinceSnapshot({
    cwd,
    scope: existing.scope,
    ...(scopeRef ? { scopeRef } : {}),
    snapshotId: baseSnapshotId,
  })
  const conflicts = touchedPaths
    ? changedSinceProposal.filter(path =>
        touchedPaths.some(root => path === root || path.startsWith(`${root}/`)),
      )
    : changedSinceProposal
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot approve evolution proposal ${existing.runId}: ${conflicts.length} file(s) it edits changed after it was proposed (${conflicts.slice(0, 5).join(', ')}). Reject it; the next evolution run proposes against the current assets.`,
    )
  }

  let sourceAcceptanceOriginalConfig: MatOSProjectConfig | undefined
  let sourceAcceptance: MatOSDirectAssetEditorSourceAcceptance[] | undefined
  let sourceRollback: MatOSDirectAssetEditorSourceRollbackTarget[] | undefined
  let sourceCommits: MatOSGitAssetSourceCommitResult[] | undefined
  let sourceCommitErrors: MatOSDirectAssetEditorSourceCommitError[] | undefined
  const pushedSourceIds = new Set<string>()
  const pushedSourceCommits = new Map<string, string>()
  let applied = false
  try {
    await restoreMatOSAssetHistorySnapshot({
      cwd,
      snapshotId: existing.afterSnapshot,
      removeCreatedFiles: true,
      compareSnapshotId: baseSnapshotId,
      ...(touchedPaths ? { onlyPaths: touchedPaths } : {}),
    })
    applied = true
    // Other edits may have landed since the proposal, so the accepted state is
    // the live tree now, not the proposal's after snapshot.
    const parentCommit =
      (await stableCommitForDirectEditorScope(cwd, existing.scope, scopeRef)) ??
      (await readMatOSAssetHistorySnapshot(cwd, baseSnapshotId))?.commit
    const approvedSnapshot = await createMatOSAssetHistorySnapshot({
      cwd,
      kind: 'direct-editor-after',
      scope: existing.scope,
      ...(scopeRef ? { scopeRef } : {}),
      ref: `refs/matos/evolution/direct-editor/${existing.runId}/approved`,
      ...(parentCommit ? { parentCommit } : {}),
      provenance: {
        runId: existing.runId,
        purpose: 'approved-proposal',
        proposedAfterSnapshot: existing.afterSnapshot,
      },
    })
    sourceAcceptanceOriginalConfig = await readMatOSProjectConfig(cwd)
    const commitResult = await commitAcceptedDirectEditorGitAssetSources({
      cwd,
      runId: existing.runId,
      scope: existing.scope,
      ...(scopeRef ? { scopeRef } : {}),
      summary: existing.editorOutput.summary,
      ...(changedPaths ? { changedPaths } : {}),
      ...(input.env ? { env: input.env } : {}),
      onAcceptedRefPushed: async pushed => {
        pushedSourceIds.add(pushed.sourceId)
        pushedSourceCommits.set(pushed.sourceId, pushed.commit)
        sourceAcceptance = [...(sourceAcceptance ?? []), {
          sourceId: pushed.sourceId, acceptedBranch: pushed.acceptedBranch,
          commit: pushed.commit, previousAcceptedCommit: pushed.previousAcceptedCommit,
          ok: false, pushed: true, validationOk: true,
        }]
        sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({ config: sourceAcceptanceOriginalConfig!, sourceAcceptance })
      },
      audit: {
        schemaVersion: 1,
        runId: existing.runId,
        scope: existing.scope,
        ...(scopeRef ? { scopeRef } : {}),
        status: 'accepted',
        summary: existing.editorOutput.summary,
        promptInput: existing.input,
        editorOutput: existing.editorOutput,
        ...(existing.acceptanceEvidence ? { acceptanceEvidence: existing.acceptanceEvidence } : {}),
        ...(existing.semanticAcceptance ? { semanticAcceptance: existing.semanticAcceptance } : {}),
        ...(existing.validation ? { validation: existing.validation } : {}),
        ...(existing.validationBaseline ? { validationBaseline: existing.validationBaseline } : {}),
        introducedValidationErrorCount: existing.introducedValidationErrors?.length ?? 0,
        beforeSnapshot: existing.beforeSnapshot,
        afterSnapshot: approvedSnapshot.snapshotId,
        ...(existing.diffPatchPath ? { diffPatchPath: existing.diffPatchPath } : {}),
      },
    })
    sourceCommits = commitResult.sourceCommits
    sourceAcceptance = commitResult.sourceAcceptance
    sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({
      config: sourceAcceptanceOriginalConfig,
      sourceAcceptance,
    })
    sourceRollback = sourceAcceptance
      ? directEditorSourceRollbackTargetsFromConfig({
          config: sourceAcceptanceOriginalConfig,
          sourceAcceptance,
        })
      : undefined
    sourceCommitErrors = commitResult.sourceCommitErrors
    if (
      (directEditorRequiresGiteaSourceAcceptance(input.env, existing.scope) ||
        commitResult.matchedGitSourceCount > 0) &&
      commitResult.sourceRootChangesDetected !== false &&
      (!sourceAcceptance || sourceAcceptance.length === 0)
    ) {
      sourceCommitErrors ??= []
      sourceCommitErrors.push({
        sourceId: 'gitea-native',
        error:
          'Gitea source acceptance is required for this direct editor run, but no matching Gitea asset source accepted ref was advanced.',
      })
    }
    const sourceAcceptanceFailure =
      directEditorSourceAcceptanceFailureMessage(sourceCommitErrors)
    if (sourceAcceptanceFailure) {
      throw new Error(sourceAcceptanceFailure)
    }
    await updateDirectEditorStableRef({
      cwd,
      scope: existing.scope,
      ...(scopeRef ? { scopeRef } : {}),
      commit: approvedSnapshot.commit,
    })
    const updated: MatOSDirectAssetEditorRunRecord = {
      ...existing,
      status: existing.mergeMode ? 'accepted_merged' : 'accepted',
      statusReason: 'approved_by_user',
      updatedAt: nowIso(),
      afterSnapshot: approvedSnapshot.snapshotId,
      proposal: {
        ...directEditorProposalDecision(existing, 'approved', input.note),
        proposedAfterSnapshot: existing.afterSnapshot,
      },
      ...(sourceCommits && sourceCommits.length > 0 ? { sourceCommits } : {}),
      ...(sourceAcceptance && sourceAcceptance.length > 0 ? { sourceAcceptance } : {}),
      ...(sourceRollback && sourceRollback.length > 0 ? { sourceRollback } : {}),
    }
    updated.algorithmOutcomeRecorded = await recordEvolutionAlgorithmOutcome(cwd, updated, input.env)
    await writeMatOSDirectAssetEditorRunRecord(cwd, updated)
    return updated
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const cleanupErrors: string[] = []
    if (sourceAcceptanceOriginalConfig) {
      const restoreErrors: MatOSDirectAssetEditorSourceCommitError[] = []
      const restored = await restoreDirectEditorAcceptedSourceState({
        cwd,
        scope: existing.scope,
        ...(scopeRef ? { scopeRef } : {}),
        config: sourceAcceptanceOriginalConfig,
        pushedSourceIds,
        pushedSourceCommits,
        ...(changedPaths ? { changedPaths } : {}),
        ...(input.env ? { env: input.env } : {}),
        sourceCommitErrors: restoreErrors,
      }).catch((restoreError: unknown) => {
        restoreErrors.push({
          sourceId: 'source-restore',
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        })
        return { ok: false }
      })
      if (!restored.ok) {
        cleanupErrors.push(
          `source restore failed: ${restoreErrors.map(item => `${item.sourceId}: ${item.error}`).join('; ')}`,
        )
      }
    }
    if (applied) {
      await restoreMatOSAssetHistorySnapshot({
        cwd,
        snapshotId: baseSnapshotId,
        removeCreatedFiles: true,
        compareSnapshotId: existing.afterSnapshot,
        ...(touchedPaths ? { onlyPaths: touchedPaths } : {}),
      }).catch((restoreError: unknown) => {
        cleanupErrors.push(
          `live tree restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        )
      })
    }
    const message = cleanupErrors.length > 0 ? `${reason}; ${cleanupErrors.join('; ')}` : reason
    await writeMatOSDirectAssetEditorRunRecord(cwd, {
      ...existing,
      updatedAt: nowIso(),
      proposal: {
        ...(existing.proposal ?? { proposedAt: existing.updatedAt, approvalMode: 'manual' }),
        lastApprovalError: message.slice(0, 2000),
      },
    })
    throw new Error(message)
  }
}

export async function rejectMatOSDirectAssetEditorProposal(input: {
  cwd: string
  runId: string
  note?: string
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorRunRecord> {
  assertDirectEditorProposal(
    await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId),
    input.runId,
  )
  return await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-reject',
      runId: input.runId,
      timeoutMs: resolveEvolutionRoleTimeoutMs(input.env),
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    async () => {
      const current = await readMatOSDirectAssetEditorRunRecord(input.cwd, input.runId)
      assertDirectEditorProposal(current, input.runId)
      // The live tree went back to the base when the proposal was made, so a
      // rejection only records the decision.
      const updated: MatOSDirectAssetEditorRunRecord = {
        ...current,
        status: 'rejected',
        statusReason: 'rejected_by_user',
        updatedAt: nowIso(),
        proposal: directEditorProposalDecision(current, 'rejected', input.note),
      }
      updated.algorithmOutcomeRecorded = await recordEvolutionAlgorithmOutcome(input.cwd, updated, input.env)
      await writeMatOSDirectAssetEditorRunRecord(input.cwd, updated)
      return updated
    },
  )
}

export async function listMatOSDirectAssetEditorProposals(
  cwd: string,
): Promise<MatOSDirectAssetEditorRunRecord[]> {
  return (await listMatOSDirectAssetEditorRunRecords(cwd)).filter(
    record => record.status === 'proposed',
  )
}

function pendingMergeVersionForStrategy(
  file: MatOSDirectAssetEditorPendingMergeRecord['files'][number],
  strategy: MatOSDirectAssetEditorPendingMergeStrategy,
): { path: string; kind?: 'file' | 'absent' | 'symlink' | 'dir' } {
  if (strategy === 'base') {
    return { path: file.basePath, kind: file.baseKind }
  }
  if (strategy === 'current') {
    return { path: file.currentPath, kind: file.currentKind }
  }
  return { path: file.editPath, kind: file.editKind }
}

async function readPendingMergeVersionEntry(input: {
  cwd: string
  runId: string
  relativePath: string
  kind: 'file' | 'absent' | 'symlink' | 'dir' | undefined
}): Promise<GuardedPathEntry | undefined> {
  const dir = directEditorPendingMergeDir(input.cwd, input.runId)
  const path = assertPathStaysUnderRoot(dir, join(dir, input.relativePath))
  const kind = input.kind ?? 'file'
  if (kind === 'absent') {
    return undefined
  }
  if (kind !== 'file') {
    throw new Error(
      `Cannot apply pending merge version ${input.relativePath}: ${kind} entries require manual resolution`,
    )
  }
  return { kind: 'file', content: await readFile(path) }
}

function directEditorAttemptRunIdPattern(baseRunId: string): RegExp {
  return new RegExp(
    `^${baseRunId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-attempt-(\\d+)$`,
  )
}

// Multi-attempt runs write their pending merge under the attempt-suffixed run
// id, while the consolidated run record is re-keyed to the base run id that
// operators actually see. Resolve a base id to the newest matching attempt
// record (preferring one that is still pending) so merge show/apply/abort work
// with either id.
export async function findMatOSDirectAssetEditorPendingMerge(
  cwd: string,
  runId: string,
): Promise<MatOSDirectAssetEditorPendingMergeRecord | undefined> {
  const direct = await readMatOSDirectAssetEditorPendingMergeRecord(cwd, runId)
  if (direct) {
    return direct
  }
  const pattern = directEditorAttemptRunIdPattern(runId)
  const attemptNumber = (candidate: string): number =>
    Number(pattern.exec(candidate)?.[1] ?? 0)
  const candidates = (await listMatOSDirectAssetEditorPendingMergeRecords(cwd))
    .filter(record => pattern.test(record.runId))
    .sort((a, b) => attemptNumber(b.runId) - attemptNumber(a.runId))
  return candidates.find(record => record.status === 'pending') ?? candidates[0]
}

export async function applyMatOSDirectAssetEditorPendingMerge(input: {
  cwd: string
  runId: string
  strategy: MatOSDirectAssetEditorPendingMergeStrategy
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorPendingMergeApplyResult | undefined> {
  if (!['current', 'edit', 'base'].includes(input.strategy)) {
    throw new Error(
      `Unsupported MatOS direct editor pending merge strategy: ${input.strategy}`,
    )
  }
  return await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-pending-merge-apply',
      runId: input.runId,
      timeoutMs: resolveEvolutionRoleTimeoutMs(),
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    async () => {
      const pending = await findMatOSDirectAssetEditorPendingMerge(input.cwd, input.runId)
      if (!pending) return undefined
      return withEvolutionSourceLease({ cwd: input.cwd, scope: pending.scope, scopeRef: pending.scopeRef }, () => applyMatOSDirectAssetEditorPendingMergeLocked(input))
    },
  )
}

async function applyMatOSDirectAssetEditorPendingMergeLocked(input: {
  cwd: string
  runId: string
  strategy: MatOSDirectAssetEditorPendingMergeStrategy
  env?: Record<string, string | undefined>
}): Promise<MatOSDirectAssetEditorPendingMergeApplyResult | undefined> {
  const pendingMerge = await findMatOSDirectAssetEditorPendingMerge(
    input.cwd,
    input.runId,
  )
  if (!pendingMerge || pendingMerge.status !== 'pending') {
    return undefined
  }
  // Multi-attempt runs record the pending merge under the attempt-suffixed run
  // id; address the record's own id from here on.
  const pendingRunId = pendingMerge.runId
  const existing = await readMatOSDirectAssetEditorRunRecord(input.cwd, pendingRunId)
  if (!existing?.beforeSnapshot) {
    throw new Error(
      `Cannot apply pending merge ${pendingRunId}: matching direct-editor run or before snapshot is missing`,
    )
  }
  const beforeSnapshot = await readMatOSAssetHistorySnapshot(
    input.cwd,
    existing.beforeSnapshot,
  )
  if (!beforeSnapshot) {
    throw new Error(
      `Cannot apply pending merge ${pendingRunId}: before snapshot ${existing.beforeSnapshot} is missing`,
    )
  }
  const mergeScopeRef = pendingMerge.scopeRef ?? existing.input.scopeRef

  const backups = new Map<string, DirectEditorImportBackup>()
  let afterSnapshotId: string | undefined
  let sourceAcceptanceOriginalConfig: MatOSProjectConfig | undefined
  let sourceAcceptancePushedSourceIds = new Set<string>()
  let sourceAcceptancePushedCommits = new Map<string, string>()
  let sourceCommitErrors: MatOSDirectAssetEditorSourceCommitError[] | undefined
  let mergeSourceAcceptance: MatOSDirectAssetEditorSourceAcceptance[] = []
  let mergeSourceRollback: MatOSDirectAssetEditorSourceRollbackTarget[] = []
  try {
    // The pending merge captured the CURRENT tree at conflict time. If the
    // tree advanced since (later runs, workbench saves), applying now would
    // silently downgrade the newer content; refuse and let the operator re-run
    // the direct editor or abort this pending merge instead.
    for (const file of pendingMerge.files) {
      const recordedKind = file.currentKind ?? 'file'
      if (recordedKind !== 'file' && recordedKind !== 'absent') {
        continue
      }
      const recorded = await readPendingMergeVersionEntry({
        cwd: input.cwd,
        runId: pendingRunId,
        relativePath: file.currentPath,
        kind: file.currentKind,
      })
      const { absolutePath } = resolveMatOSAssetHistoryRecordPath({
        cwd: input.cwd,
        scope: pendingMerge.scope,
        ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
        path: file.path,
      })
      const actual = await captureImportPathEntry(absolutePath)
      const unchanged = recorded
        ? recorded.kind === 'file' &&
          actual?.kind === 'file' &&
          actual.content.equals(recorded.content)
        : actual === undefined
      if (!unchanged) {
        throw new Error(
          `Cannot apply pending merge ${pendingRunId}: current assets changed since the conflict was recorded (${file.path}). Re-run the direct editor or abort this pending merge.`,
        )
      }
    }
    for (const file of pendingMerge.files) {
      const version = pendingMergeVersionForStrategy(file, input.strategy)
      const entry = await readPendingMergeVersionEntry({
        cwd: input.cwd,
        runId: pendingRunId,
        relativePath: version.path,
        kind: version.kind,
      })
      const { absolutePath } = resolveMatOSAssetHistoryRecordPath({
        cwd: input.cwd,
        scope: pendingMerge.scope,
        ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
        path: file.path,
      })
      await assertNoSymlinkPathComponent({
        cwd: input.cwd,
        absolutePath,
        includeTarget: false,
        baseRoots: matOSAssetHistoryAllowedRoots(
          input.cwd,
          pendingMerge.scope,
          mergeScopeRef,
        ),
      })
      await backupImportPath({ absolutePath, backups })
      if (!entry) {
        await rm(absolutePath, { recursive: true, force: true })
        await pruneEmptyDirectoriesToBase(input.cwd, dirname(absolutePath))
      } else {
        await writeImportedAssetEntry({
          cwd: input.cwd,
          path: absolutePath,
          entry,
        })
      }
    }

    const afterRecord = await createDirectEditorAfterSnapshot({
      cwd: input.cwd,
      scope: pendingMerge.scope,
      ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
      runId: pendingRunId,
      parentCommit: beforeSnapshot.commit,
      triggerKey: existing.input.currentEvolutionContext?.trigger?.key,
      experienceRefs: existing.evidenceRefs,
    })
    afterSnapshotId = afterRecord.snapshotId
    const diff = await writeDirectEditorDiffPatch({
      cwd: input.cwd,
      runId: pendingRunId,
      beforeSnapshot: existing.beforeSnapshot,
      afterSnapshot: afterRecord.snapshotId,
    })
    let validationBaselineError: string | undefined
    const validationBaseline = await validateMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      snapshotId: existing.beforeSnapshot,
      gateProfile: 'smoke',
    }).catch((error: unknown) => {
      validationBaselineError =
        error instanceof Error ? error.message : String(error)
      return undefined
    })
    const validation = await validateMatOSAssetHistorySnapshot({
      cwd: input.cwd,
      snapshotId: afterRecord.snapshotId,
      gateProfile: 'smoke',
    })
    const usability = evaluateDirectEditorUsability(validationBaseline, validation, {
      baselineUnavailable: Boolean(validationBaselineError),
    })
    if (!usability.usable) {
      throw new Error(
        `Cannot apply pending merge ${pendingRunId}: resolved assets introduce ${usability.introducedErrors.length} validation error(s)`,
      )
    }
    sourceAcceptanceOriginalConfig = await readMatOSProjectConfig(input.cwd)
    const commitResult = await commitAcceptedDirectEditorGitAssetSources({
      cwd: input.cwd,
      runId: pendingRunId,
      scope: pendingMerge.scope,
      ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
      summary: existing.editorOutput.summary,
      changedPaths: pendingMerge.files.map(file => file.path),
      ...(input.env ? { env: input.env } : {}),
      // Ledger pushed accepted refs immediately so a post-push throw inside
      // the commit call cannot orphan already-advanced remote refs.
      onAcceptedRefPushed: async pushed => {
        sourceAcceptancePushedSourceIds.add(pushed.sourceId)
        sourceAcceptancePushedCommits.set(pushed.sourceId, pushed.commit)
        mergeSourceAcceptance.push({ ...pushed, ok: false, pushed: true, validationOk: true })
        sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({ config: sourceAcceptanceOriginalConfig!, sourceAcceptance: mergeSourceAcceptance })
        mergeSourceRollback = directEditorSourceRollbackTargetsFromConfig({ config: sourceAcceptanceOriginalConfig, sourceAcceptance: mergeSourceAcceptance })
        await writeMatOSDirectAssetEditorRunRecord(input.cwd, { ...existing, updatedAt: nowIso(),
          statusReason: 'pending_merge_accepted_ref_pushed_pending_confirmation',
          sourceAcceptance: mergeSourceAcceptance, sourceRollback: mergeSourceRollback,
        })
      },
      audit: {
        schemaVersion: 1,
        runId: pendingRunId,
        scope: pendingMerge.scope,
        ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
        status: 'accepted_merged',
        summary: existing.editorOutput.summary,
        promptInput: existing.input,
        editorOutput: existing.editorOutput,
        ...(existing.acceptanceEvidence
          ? { acceptanceEvidence: existing.acceptanceEvidence }
          : {}),
        ...(existing.semanticAcceptance
          ? { semanticAcceptance: existing.semanticAcceptance }
          : {}),
        validation,
        ...(validationBaseline ? { validationBaseline } : {}),
        introducedValidationErrorCount: usability.introducedErrors.length,
        ...(existing.beforeSnapshot ? { beforeSnapshot: existing.beforeSnapshot } : {}),
        afterSnapshot: afterRecord.snapshotId,
        diffPatchPath: diff.path,
      },
    })
    sourceCommitErrors = commitResult.sourceCommitErrors
    sourceAcceptanceOriginalConfig = directEditorSourceBaselineConfig({ config: sourceAcceptanceOriginalConfig!, sourceAcceptance: commitResult.sourceAcceptance })
    mergeSourceRollback = directEditorSourceRollbackTargetsFromConfig({ config: sourceAcceptanceOriginalConfig, sourceAcceptance: commitResult.sourceAcceptance })
    if (
      (directEditorRequiresGiteaSourceAcceptance(input.env, pendingMerge.scope) ||
        commitResult.matchedGitSourceCount > 0) &&
      (!commitResult.sourceAcceptance || commitResult.sourceAcceptance.length === 0)
    ) {
      sourceCommitErrors ??= []
      sourceCommitErrors.push({
        sourceId: 'gitea-native',
        error:
          'Gitea source acceptance is required for this pending merge apply, but no matching Gitea asset source accepted ref was advanced.',
      })
    }
    const sourceAcceptanceFailure =
      directEditorSourceAcceptanceFailureMessage(sourceCommitErrors)
    if (sourceAcceptanceFailure) {
      throw new Error(sourceAcceptanceFailure)
    }
    await updateDirectEditorStableRef({
      cwd: input.cwd,
      scope: pendingMerge.scope,
      ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
      commit: afterRecord.commit,
    })
    const timestamp = nowIso()
    const resolvedStatus: MatOSDirectAssetEditorRunStatus =
      input.strategy === 'edit' ? 'accepted_merged' : 'noop'
    const resolvedRun: MatOSDirectAssetEditorRunRecord = {
      ...existing,
      status: resolvedStatus,
      statusReason: `pending_merge_applied_${input.strategy}`,
      updatedAt: timestamp,
      afterSnapshot: afterRecord.snapshotId,
      diffPatchPath: diff.path,
      validation,
      validationBaseline,
      introducedValidationErrors: usability.introducedErrors,
      mergeMode: 'conflict',
      dirtyFilesAtStart: pendingMerge.dirtyFilesAtStart,
      mergeConflicts: pendingMerge.conflicts,
      // The 'edit' strategy lands the editor's content without a semantic
      // judge pass; record that explicitly for audit and statistics.
      ...(input.strategy === 'edit' ? { semanticJudgeSkipped: true } : {}),
      ...(commitResult.sourceCommits ? { sourceCommits: commitResult.sourceCommits } : {}),
      ...(commitResult.sourceAcceptance
        ? { sourceAcceptance: commitResult.sourceAcceptance }
        : {}),
      ...(mergeSourceRollback.length ? { sourceRollback: mergeSourceRollback } : {}),
      ...(commitResult.sourceCommitErrors
        ? { sourceCommitErrors: commitResult.sourceCommitErrors }
        : {}),
    }
    delete resolvedRun.pendingMerge
    await writeMatOSDirectAssetEditorRunRecord(input.cwd, resolvedRun)
    await writeDirectEditorRunFile(directEditorRunDir(input.cwd, pendingRunId), 'merge-resolution.json', {
      schemaVersion: 1,
      runId: pendingRunId,
      strategy: input.strategy,
      status: 'applied',
      appliedAt: timestamp,
      afterSnapshot: afterRecord.snapshotId,
    })
    await rm(directEditorPendingMergeDir(input.cwd, pendingRunId), { recursive: true, force: true })
    return {
      status: 'applied',
      strategy: input.strategy,
      run: resolvedRun,
      pendingMerge,
      afterSnapshot: afterRecord.snapshotId,
      validation,
      introducedValidationErrors: usability.introducedErrors,
    }
  } catch (error) {
    await restoreDirectEditorImportBackups({
      cwd: input.cwd,
      backups: [...backups.values()],
    }).catch(() => undefined)
    if (sourceAcceptanceOriginalConfig) {
      sourceCommitErrors ??= []
      const sourceRestore = await restoreDirectEditorAcceptedSourceState({
        cwd: input.cwd,
        scope: pendingMerge.scope,
        ...(mergeScopeRef ? { scopeRef: mergeScopeRef } : {}),
        config: sourceAcceptanceOriginalConfig,
        pushedSourceIds: sourceAcceptancePushedSourceIds,
        pushedSourceCommits: sourceAcceptancePushedCommits,
        changedPaths: pendingMerge.files.map(file => file.path),
        env: input.env,
        sourceCommitErrors,
      })
      if (!sourceRestore.ok) {
        throw new Error(
          'failed pending merge apply and one or more remote accepted refs could not be restored',
        )
      }
    }
    throw error instanceof Error && afterSnapshotId
      ? new Error(`${error.message}; rolled back filesystem changes from failed pending merge apply`)
      : error
  }
}

export type MatOSDirectAssetEditorPendingMergeAbortResult = {
  status: 'aborted'
  pendingMerge: MatOSDirectAssetEditorPendingMergeRecord
  run?: MatOSDirectAssetEditorRunRecord
}

// Terminal escape hatch for conflicts that should never be applied (for
// example after the stale-apply guard fired): the current tree stays as-is,
// the run record is closed out, and the pending-merge directory is removed so
// the conflict cannot be applied later.
export async function abortMatOSDirectAssetEditorPendingMerge(input: {
  cwd: string
  runId: string
  // Optional resolution marker recorded as the run's statusReason and in
  // merge-resolution.json so operators can distinguish automatic TTL expiry
  // ('pending_merge_ttl_expired') from the default manual abort.
  reason?: string
}): Promise<MatOSDirectAssetEditorPendingMergeAbortResult | undefined> {
  return await withMatOSAssetHistoryLock(
    {
      cwd: input.cwd,
      operation: 'direct-editor-pending-merge-abort',
      runId: input.runId,
      timeoutMs: resolveEvolutionRoleTimeoutMs(),
      foreignHostStaleMs: DIRECT_EDITOR_FOREIGN_HOST_LOCK_STALE_MS,
    },
    async () => {
      const pendingMerge = await findMatOSDirectAssetEditorPendingMerge(
        input.cwd,
        input.runId,
      )
      if (!pendingMerge || pendingMerge.status !== 'pending') {
        return undefined
      }
      const pendingRunId = pendingMerge.runId
      const timestamp = nowIso()
      const aborted: MatOSDirectAssetEditorPendingMergeRecord = {
        ...pendingMerge,
        status: 'aborted',
        updatedAt: timestamp,
      }
      // Persist the aborted state before any cleanup so a crash in between
      // can never leave an applicable 'pending' record behind.
      await writeMatOSDirectAssetEditorPendingMergeRecord({
        cwd: input.cwd,
        record: aborted,
      })
      let run: MatOSDirectAssetEditorRunRecord | undefined
      const existing = await readMatOSDirectAssetEditorRunRecord(
        input.cwd,
        pendingRunId,
      )
      if (existing) {
        run = {
          ...existing,
          // The current tree is untouched by an abort, so the run resolves to
          // a no-op rather than staying actionable as pending_merge.
          status: 'noop',
          rawStatus: existing.rawStatus ?? existing.status,
          statusReason: input.reason ?? 'pending_merge_aborted',
          updatedAt: timestamp,
        }
        delete run.pendingMerge
        await writeMatOSDirectAssetEditorRunRecord(input.cwd, run)
      }
      await writeDirectEditorRunFile(
        directEditorRunDir(input.cwd, pendingRunId),
        'merge-resolution.json',
        {
          schemaVersion: 1,
          runId: pendingRunId,
          status: 'aborted',
          abortedAt: timestamp,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      )
      await rm(directEditorPendingMergeDir(input.cwd, pendingRunId), {
        recursive: true,
        force: true,
      })
      return {
        status: 'aborted',
        pendingMerge: aborted,
        ...(run ? { run } : {}),
      }
    },
  )
}

// Opportunistic post-run maintenance: pending-merge TTL auto-expiry (through
// the real abort path above) plus run-directory retention. Fire-and-forget
// with every error swallowed — finalizing a run record must never block on or
// fail because of cleanup. Invoked after the finalize path writes the terminal
// run record; the sweep itself is bounded and re-entrancy-guarded per cwd.
function scheduleDirectEditorRetentionAfterRun(
  cwd: string,
  env: Record<string, string | undefined> | undefined,
): void {
  void runMatOSDirectAssetEditorRetention({
    cwd,
    ...(env ? { env } : {}),
    abortPendingMerge: abortMatOSDirectAssetEditorPendingMerge,
  }).catch(() => undefined)
}

export {
  listMatOSDirectAssetEditorPendingMergeRecords as listMatOSDirectAssetEditorPendingMerges,
  listMatOSDirectAssetEditorRunRecords as listMatOSDirectAssetEditorRuns,
  readMatOSDirectAssetEditorPendingMergeRecord as readMatOSDirectAssetEditorPendingMerge,
  readMatOSDirectAssetEditorRunRecord as readMatOSDirectAssetEditorRun,
} from './directAssetEditorRecords.js'
