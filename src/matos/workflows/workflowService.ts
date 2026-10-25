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

import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadMatOSWorkbenchRuntimeAssets } from '../workbench/runtimeAssetView.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import { getMatOSDir, readMatOSProjectConfig } from '../project.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import { resolveMatOSEvolutionProvider } from '../learning/evolutionProvider.js'
import {
  buildWorkflowEvidenceFromRunDir,
  writeWorkflowEvidence,
} from '../learning/workflowEvidence.js'
import {
  generateMatOSWorkflowReplayCandidate,
  maintainMatOSStableImprovementCandidates,
  maintainMatOSWorkflowReplayClusters,
  verifyMatOSWorkflowReplayCandidate,
} from '../learning/replayCandidates.js'
import {
  materializeMatOSRuntimeScope,
  resolveMatOSRuntimeScope,
} from '../runtime/scopes.js'
import {
  envValue,
  withTemporaryMatOSEnv,
  type MatOSEnv,
} from '../runtime/runtimeEnv.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'
import {
  deleteMatOSWorkbenchWorkflowTrigger,
  getMatOSWorkbenchWorkflowTrigger,
  listMatOSWorkbenchWorkflowTriggerEvents,
  listMatOSWorkbenchWorkflowTriggers,
  saveMatOSWorkbenchWorkflowTrigger,
} from '../workbench/workflowTriggers.js'
import { loadWorkflowAsset } from './loadWorkflow.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import {
  compileMatOSWorkflowDefinition,
  type WorkflowCompileView,
} from './workflowCompile.js'
import {
  workflowArtifactContractStatuses,
  type WorkflowArtifactContractStatus,
} from './artifactContracts.js'
import {
  recoverWorkflowRun,
  workflowRecoveryReportDigest,
  workflowRecoverySafeAlternativeActions,
  type WorkflowRecoveryReport,
} from './recovery.js'
import { decideMatOSRecoveryPolicy } from '../algorithms/surfaces/recoveryPolicy.js'
import {
  matOSAlgorithmSurfacePinsFromManifest,
  requireMatOSAlgorithmRunManifest,
} from '../algorithms/manifest.js'
import { withMatOSWorkflowExecutionContext } from './executionContext.js'
import {
  drainWorkflowRemoteRecoveryQueue,
  refreshWorkflowRemoteRecoveryQueue,
  type DrainWorkflowRemoteRecoveryQueueResult,
  type RefreshWorkflowRemoteRecoveryQueueResult,
  type WorkflowRemoteRecoveryJob,
} from './recoveryQueue.js'
import {
  inspectWorkflowGraphPatchLedger,
  listWorkflowGraphPatchLedgers,
  proposeWorkflowGraphPatch,
  type WorkflowGraphPatchError,
  type WorkflowGraphPatchLedgerView,
  type WorkflowGraphPatchOperation,
} from './dynamicPatch.js'
import { withWorkflowRunLock } from './runLock.js'
import {
  waitForWorkflowRun,
  workflowRunPulse,
  type WorkflowRunPulse,
  type WorkflowRunWaitResult,
} from './runPulse.js'
import { viewFromSnapshot } from './runState.js'
import {
  approveWorkflowNode,
  approveWorkflowGraphPatchForRun,
  applyWorkflowGraphPatchForRun,
  applyWorkflowRecoveryRecommendation,
  denyWorkflowNode,
  inspectWorkflowApprovalStatus,
  inspectWorkflowRun,
  requestWorkflowRunCancel,
  requestWorkflowRunPause,
  reconcileWorkflowRunComputeJobs,
  respondToWorkflowNode,
  rejectWorkflowGraphPatchForRun,
  resumeWorkflowRun,
  retryWorkflowNode,
  skipWorkflowNode,
  startWorkflowSingleNodeRun,
  startWorkflowRun,
  type WorkflowRecoveryApplyResult,
  type WorkflowRunView,
} from './workflowRuntime.js'
import { ensureMatOSAlgorithmWorkflowIntegration } from '../algorithms/workflowIntegration.js'
import {
  addWorkflowDraftNode,
  connectWorkflowDraftNodes,
  connectWorkflowDraftTransition,
  createWorkflowDraft,
  deleteWorkflowDraftNode,
  disconnectWorkflowDraftNodes,
  disconnectWorkflowDraftTransition,
  listWorkflowDrafts,
  forkWorkflowRunToDraft,
  importWorkflowComponent,
  publishWorkflowDraft,
  readWorkflowDraft,
  readWorkflowDraftDefinition,
  readWorkflowDraftProvenance,
  readWorkflowRun,
  readWorkflowRunEvents,
  recordWorkflowDraftPublicationFailure,
  replaceWorkflowDraftDefinition,
  resolveWorkflowDraftDir,
  setWorkflowDraftOutputs,
  setWorkflowDraftParameters,
  setWorkflowDraftStateMachine,
  updateWorkflowDraftNode,
  workflowDraftDefinitionDigest,
  workflowPublicationAssetId,
  type MatOSWorkflowDraftListItem,
} from './workflowStore.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowDraftSnapshot,
  MatOSWorkflowEvent,
  MatOSWorkflowNode,
  MatOSWorkflowRunProvenance,
  MatOSWorkflowRunSnapshot,
  MatOSWorkflowTransitionEdge,
  WorkflowArtifactRef,
  WorkflowContractMap,
} from './types.js'
import {
  workflowReadinessForAsset,
  workflowRuntimeEngine,
  workflowRuntimeKind,
} from './workflowReadiness.js'
import {
  syncPublishedWorkflowDraftToScopedGitea,
  type MatOSWorkflowScopedGiteaSyncResult,
} from './workflowScopedAssetSync.js'
import {
  MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES,
  workflowNodeManifestCoverageReport,
  type MatOSWorkflowNodeManifestCoverageReport,
  type MatOSWorkflowNodeManifestSummary,
} from './nodeManifests.js'

export type { WorkflowArtifactContractStatus } from './artifactContracts.js'

export type MatOSWorkflowServiceContext = {
  cwd: string
  scopeRef?: string
  env?: MatOSEnv
}

export type MatOSWorkflowServiceRunInput = MatOSWorkflowServiceContext & {
  ref: string
  parameters?: Record<string, unknown>
  recordSession?: boolean
  provenance?: MatOSWorkflowRunProvenance
  // When false, create the run in `created` state and return without
  // executing (see StartWorkflowRunInput.advance). Callers then advance it
  // in a separate process via `matos workflow resume <runId>`.
  advance?: boolean
}

export type MatOSWorkflowServiceDraftRunInput = MatOSWorkflowServiceContext & {
  draftId: string
  parameters?: Record<string, unknown>
  recordSession?: boolean
  provenance?: MatOSWorkflowRunProvenance
  advance?: boolean
}

export type MatOSWorkflowServiceNodeDebugInput =
  MatOSWorkflowServiceRunInput & {
    nodeId: string
  }

export type MatOSWorkflowRunFilters = {
  workflowRef?: string
  status?: string
  traceId?: string
  sessionId?: string
  triggerId?: string
  source?: MatOSWorkflowRunProvenance['source']
  updatedAfter?: string
  updatedBefore?: string
}

export type MatOSWorkflowServiceRunListItem = {
  run: WorkflowRunView & {
    workflowRef?: string
    createdAt?: string
    updatedAt?: string
    parameters?: Record<string, unknown>
    projectCwd?: string
    workspaceDir?: string
    trace?: MatOSWorkflowRunSnapshot['trace']
    provenance?: MatOSWorkflowRunSnapshot['provenance']
  }
  snapshot: MatOSWorkflowRunSnapshot
  events: MatOSWorkflowEvent[]
}

export type MatOSWorkflowServiceRunList = {
  runs: MatOSWorkflowServiceRunListItem[]
  summary: {
    count: number
    total: number
    offset: number
    limit: number
    query: string
    filters?: MatOSWorkflowRunFilters
  }
  sources: {
    workflowRunsDir: string
  }
}

export type WorkflowContractView = {
  source: 'workflow' | 'draft' | 'run'
  workflowRef?: string
  draftId?: string
  runId?: string
  contracts: WorkflowContractMap
  artifacts: WorkflowArtifactContractStatus[]
}

export type MatOSWorkflowService = {
  list(input: MatOSWorkflowServiceContext): Promise<{ workflows: Record<string, unknown>[] }>
  show(input: MatOSWorkflowServiceContext & { ref: string }): Promise<{
    workflow: Record<string, unknown>
    kind: string
    definition: unknown
    validation: ReturnType<typeof validateWorkflowDefinition>
    nodeManifests: MatOSWorkflowNodeManifestSummary[]
    nodeManifestReport: MatOSWorkflowNodeManifestCoverageReport
  }>
  validate(input: MatOSWorkflowServiceContext & { ref: string }): Promise<{
    workflow: string
    ok: boolean
    errors: ReturnType<typeof validateWorkflowDefinition>['errors']
    warnings?: ReturnType<typeof validateWorkflowDefinition>['warnings']
  }>
  compile(input: MatOSWorkflowServiceContext & { ref: string }): Promise<WorkflowCompileView>
  compileInspect(input: MatOSWorkflowServiceContext & { runId: string }): Promise<WorkflowCompileView>
  contracts(input: MatOSWorkflowServiceContext & { ref?: string; draftId?: string; runId?: string }): Promise<WorkflowContractView>
  listRuns(input: MatOSWorkflowServiceContext & {
    query?: string
    limit?: number
    offset?: number
    filter?: MatOSWorkflowRunFilters
    detail?: 'summary' | 'full'
    /**
     * Access predicate applied BEFORE pagination. Filtering after the slice
     * (as tool callers used to) skews page sizes and makes offset-based
     * paging skip or repeat rows for restricted contexts.
     */
    refAllowed?: (workflowRef: string | undefined) => boolean
  }): Promise<MatOSWorkflowServiceRunList>
  run(input: MatOSWorkflowServiceRunInput): Promise<{ run: WorkflowRunView }>
  runDraft(input: MatOSWorkflowServiceDraftRunInput): Promise<{ run: WorkflowRunView }>
  nodeDebug(input: MatOSWorkflowServiceNodeDebugInput): Promise<{ run: WorkflowRunView }>
  status(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ run: WorkflowRunView }>
  /** Compact liveness/progress snapshot with heartbeat + next-step guidance. */
  pulse(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ pulse: WorkflowRunPulse }>
  /**
   * Bounded long-poll: block until the run reaches a terminal/waiting/paused/
   * stalled state or the timeout elapses. One call replaces a status-poll loop.
   */
  wait(input: MatOSWorkflowServiceContext & {
    runId: string
    timeoutSeconds?: number
    sinceEventId?: string
  }): Promise<WorkflowRunWaitResult>
  inspect(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ run: WorkflowRunView }>
  events(input: MatOSWorkflowServiceContext & { runId: string; tail?: number }): Promise<{ events: MatOSWorkflowEvent[] }>
  recover(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ recovery: WorkflowRecoveryReport }>
  recoverApply(input: MatOSWorkflowServiceContext & { runId: string }): Promise<WorkflowRecoveryApplyResult>
  recoverQueue(input: MatOSWorkflowServiceContext & { allowedWorkflowRefs?: string[] }): Promise<RefreshWorkflowRemoteRecoveryQueueResult>
  recoverDrain(input: MatOSWorkflowServiceContext & { allowedWorkflowRefs?: string[] }): Promise<DrainWorkflowRemoteRecoveryQueueResult>
  reconcile(input: MatOSWorkflowServiceContext & { runId: string }): ReturnType<typeof reconcileWorkflowRunComputeJobs>
  patches(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ patches: WorkflowGraphPatchLedgerView[] }>
  patchPropose(input: MatOSWorkflowServiceContext & { runId: string; operations: WorkflowGraphPatchOperation[]; reason?: string; risk?: 'low' | 'medium' | 'high'; sourceNodeId?: string; decidedBy?: string }): Promise<{ ok: boolean; errors: WorkflowGraphPatchError[]; patch?: WorkflowGraphPatchLedgerView }>
  patchInspect(input: MatOSWorkflowServiceContext & { runId: string; patchId: string }): Promise<{ patch: WorkflowGraphPatchLedgerView }>
  patchApprove(input: MatOSWorkflowServiceContext & { runId: string; patchId: string; reason?: string; decidedBy?: string }): Promise<{ run: WorkflowRunView; patch: WorkflowGraphPatchLedgerView }>
  patchReject(input: MatOSWorkflowServiceContext & { runId: string; patchId: string; reason?: string; decidedBy?: string }): Promise<{ run: WorkflowRunView; patch: WorkflowGraphPatchLedgerView }>
  patchApply(input: MatOSWorkflowServiceContext & { runId: string; patchId: string; reason?: string; decidedBy?: string }): Promise<{ run: WorkflowRunView; patch: WorkflowGraphPatchLedgerView }>
  artifacts(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{
    runId: string
    artifacts: WorkflowArtifactRef[]
  }>
  approvalStatus(input: MatOSWorkflowServiceContext & { runId: string }): Promise<unknown>
  respond(input: MatOSWorkflowServiceContext & { runId: string; nodeId: string; response: unknown }): Promise<{ run: WorkflowRunView }>
  approve(input: MatOSWorkflowServiceContext & { runId: string; nodeId: string; fingerprint?: string; response?: unknown }): Promise<{ run: WorkflowRunView }>
  deny(input: MatOSWorkflowServiceContext & { runId: string; nodeId: string; reason?: string }): Promise<{ run: WorkflowRunView }>
  cancel(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ run: WorkflowRunView }>
  pause(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ run: WorkflowRunView }>
  resume(input: MatOSWorkflowServiceContext & { runId: string }): Promise<{ run: WorkflowRunView }>
  retryNode(input: MatOSWorkflowServiceContext & { runId: string; nodeId: string; failedChildrenOnly?: boolean }): Promise<{ run: WorkflowRunView }>
  skipNode(input: MatOSWorkflowServiceContext & { runId: string; nodeId: string; reason?: string }): Promise<{ run: WorkflowRunView }>
  drafts(input: MatOSWorkflowServiceContext): Promise<{ drafts: MatOSWorkflowDraftListItem[] }>
  showDraft(input: MatOSWorkflowServiceContext & { draftId: string }): Promise<{
    draft: MatOSWorkflowDraftSnapshot & { draftDir: string }
    definition: MatOSWorkflowDefinition
    provenance: Awaited<ReturnType<typeof readWorkflowDraftProvenance>>
    validation: ReturnType<typeof validateWorkflowDefinition>
  }>
  createDraft(input: MatOSWorkflowServiceContext & { id?: string; name?: string; version?: string; description?: string }): Promise<{ draft: MatOSWorkflowDraftSnapshot & { draftDir: string }; definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  forkWorkflow(input: MatOSWorkflowServiceContext & { ref: string; id?: string; name?: string; version?: string; description?: string }): Promise<{
    draft: MatOSWorkflowDraftSnapshot & { draftDir: string }
    source: Record<string, unknown>
    definition: MatOSWorkflowDefinition
    validation: ReturnType<typeof validateWorkflowDefinition>
  }>
  compileDraft(input: MatOSWorkflowServiceContext & { draftId: string }): Promise<WorkflowCompileView>
  addDraftNode(input: MatOSWorkflowServiceContext & { draftId: string; node: MatOSWorkflowNode }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  updateDraftNode(input: MatOSWorkflowServiceContext & { draftId: string; nodeId: string; patch: Partial<MatOSWorkflowNode> }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  deleteDraftNode(input: MatOSWorkflowServiceContext & { draftId: string; nodeId: string }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  connectDraftNodes(input: MatOSWorkflowServiceContext & { draftId: string; from: string; to: string }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  disconnectDraftNodes(input: MatOSWorkflowServiceContext & { draftId: string; from: string; to: string }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  connectDraftTransition(input: MatOSWorkflowServiceContext & { draftId: string; transition: MatOSWorkflowTransitionEdge }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  disconnectDraftTransition(input: MatOSWorkflowServiceContext & { draftId: string; id?: string; from?: string; to?: string }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  setDraftStateMachine(input: MatOSWorkflowServiceContext & { draftId: string; disable?: boolean; initialNodeId?: string; maxTransitions?: number; maxFrames?: number }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  setDraftOutputs(input: MatOSWorkflowServiceContext & { draftId: string; outputs: MatOSWorkflowDefinition['outputs'] }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  setDraftParameters(input: MatOSWorkflowServiceContext & { draftId: string; parameters: MatOSWorkflowDefinition['parameters']; replace?: boolean; remove?: string[] }): Promise<{ definition: MatOSWorkflowDefinition; validation: ReturnType<typeof validateWorkflowDefinition> }>
  replaceDraftDefinition(input: MatOSWorkflowServiceContext & { draftId: string; definition: MatOSWorkflowDefinition }): Promise<{ definition: MatOSWorkflowDefinition; definitionDigest: string; validation: ReturnType<typeof validateWorkflowDefinition> }>
  importComponent(input: MatOSWorkflowServiceContext & { draftId: string; ref: string }): Promise<{
    draft: MatOSWorkflowDraftSnapshot & { draftDir: string }
    component: Record<string, unknown>
    definition: MatOSWorkflowDefinition
    validation: ReturnType<typeof validateWorkflowDefinition>
  }>
  /**
   * One-call authoring: create (or reset) the draft named after the workflow
   * id, replace its definition (validating), and publish it as an asset.
   * The single-call path keeps full definitions out of repeated tool-call
   * round trips — the agent writes the JSON once and submits it once.
   */
  author(input: MatOSWorkflowServiceContext & {
    id: string
    definition: MatOSWorkflowDefinition
    name?: string
    version?: string
    description?: string
    publish?: boolean
  }): Promise<{
    draftId: string
    validation: ReturnType<typeof validateWorkflowDefinition>
    published: Awaited<ReturnType<typeof publishWorkflowDraft>> | null
    workflowRef: string | null
  }>
  publishDraft(input: MatOSWorkflowServiceContext & { draftId: string; id?: string; name?: string; version?: string; description?: string; expectedDefinition?: string }): Promise<{
    published: Awaited<ReturnType<typeof publishWorkflowDraft>>
    draft: MatOSWorkflowDraftSnapshot & { draftDir: string }
    scopedGiteaSync?: MatOSWorkflowScopedGiteaSyncResult
  }>
  forkRun(input: MatOSWorkflowServiceContext & { runId: string; id?: string; name?: string }): Promise<{
    draft: MatOSWorkflowDraftSnapshot & { draftDir: string }
    definition: MatOSWorkflowDefinition
    validation: ReturnType<typeof validateWorkflowDefinition>
  }>
  triggerEvents(input: MatOSWorkflowServiceContext): ReturnType<typeof listMatOSWorkbenchWorkflowTriggerEvents>
  triggers(input: MatOSWorkflowServiceContext & { workflowRef?: string }): ReturnType<typeof listMatOSWorkbenchWorkflowTriggers>
  trigger(input: MatOSWorkflowServiceContext & { workflowRef?: string; triggerId?: string }): ReturnType<typeof getMatOSWorkbenchWorkflowTrigger>
  saveTrigger(input: MatOSWorkflowServiceContext & { workflowRef: string; request?: unknown }): ReturnType<typeof saveMatOSWorkbenchWorkflowTrigger>
  deleteTrigger(input: MatOSWorkflowServiceContext & { workflowRef?: string; triggerId: string; request?: unknown }): ReturnType<typeof deleteMatOSWorkbenchWorkflowTrigger>
}

function workflowKind(asset: MatOSAsset): string {
  return workflowRuntimeKind(asset)
}

function workflowKey(asset: MatOSAsset): string {
  return asset.canonicalKey || `${asset.type}:${asset.id}`
}

function generatedDraftId(id: string): boolean {
  return /^draft_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function serializeWorkflowAsset(asset: MatOSAsset): Record<string, unknown> {
  return {
    id: asset.id,
    name: asset.name,
    version: asset.version,
    description: asset.description,
    canonicalKey: asset.canonicalKey,
    path: asset.relativePath,
    entry: asset.entryRelativePath,
    source: asset.source,
    packId: asset.packId,
    tags: asset.tags,
    kind: workflowKind(asset),
    engine: workflowRuntimeEngine(asset),
    readiness: workflowReadinessForAsset(asset),
    lifecycle: asset.lifecycle,
  }
}

async function resolveWorkflowScope(input: MatOSWorkflowServiceContext) {
  const config = await readMatOSProjectConfig(input.cwd)
  const env = input.env ?? process.env
  const ambientScopeRef = env.MATOS_SCOPE_REF ?? env.MATOS_SCOPE_ID
  const runtimeAmbientScopeRef =
    ambientScopeRef &&
    (!ambientScopeRef.includes(':') || ambientScopeRef.startsWith('user:'))
      ? ambientScopeRef
      : undefined
  const scope = resolveMatOSRuntimeScope(input.cwd, {
    scopeRef:
      input.scopeRef ??
      runtimeAmbientScopeRef,
    runtimeDataDir: config.execution?.runtimeDataDir,
    env,
  })
  const runsDir = envValue(env, 'MATOS_WORKFLOW_RUNS_DIR')
  if (!runsDir) {
    return scope
  }
  return {
    ...scope,
    workflowsDir: dirname(runsDir),
    workflowRunsDir: runsDir,
  }
}

async function materializedWorkflowScope(input: MatOSWorkflowServiceContext) {
  const scope = await resolveWorkflowScope(input)
  await materializeMatOSRuntimeScope(scope)
  return scope
}

async function runDirForRunId(
  input: MatOSWorkflowServiceContext & { runId: string },
): Promise<string> {
  const scope = await resolveWorkflowScope(input)
  const runDir = join(scope.workflowRunsDir, input.runId)
  if (workflowProjectCwd(input) && !workflowRunMatchesProject(await readWorkflowRun(runDir), input)) {
    throw new Error('Workflow run unavailable in the selected project')
  }
  return runDir
}

function workflowProjectCwd(input: MatOSWorkflowServiceContext): string | undefined {
  return envValue(input.env ?? process.env, 'MATOS_WORKFLOW_PROJECT_CWD')
}

function workflowRunMatchesProject(snapshot: MatOSWorkflowRunSnapshot, input: MatOSWorkflowServiceContext): boolean {
  const projectCwd = workflowProjectCwd(input)
  return !projectCwd || Boolean(snapshot.projectCwd && resolve(snapshot.projectCwd) === resolve(projectCwd))
}

function workflowRefBase(ref: string): string {
  const at = ref.indexOf('@')
  return at >= 0 ? ref.slice(0, at) : ref
}

function workflowRefHasVersion(ref: string): boolean {
  return ref.includes('@')
}

function workflowRefAllowedByList(
  allowed: readonly string[] | undefined,
  ref: string | undefined,
): boolean {
  if (!allowed || allowed.length === 0 || !ref) {
    return true
  }
  const base = workflowRefBase(ref)
  const refHasVersion = workflowRefHasVersion(ref)
  return allowed.some(candidate => {
    if (candidate === ref) {
      return true
    }
    if (workflowRefBase(candidate) !== base) {
      return false
    }
    return !refHasVersion || !workflowRefHasVersion(candidate)
  })
}

function filterRecoveryQueueForAllowedRefs<T extends { jobs?: WorkflowRemoteRecoveryJob[] }>(
  value: T,
  allowed: readonly string[] | undefined,
): T {
  if (!allowed || allowed.length === 0 || !Array.isArray(value.jobs)) {
    return value
  }
  return {
    ...value,
    jobs: value.jobs.filter(job => workflowRefAllowedByList(allowed, job.workflowRef)),
    removed: [],
  } as T
}

function filterRecoveryDrainForAllowedRefs(
  value: DrainWorkflowRemoteRecoveryQueueResult,
  allowed: readonly string[] | undefined,
): DrainWorkflowRemoteRecoveryQueueResult {
  if (!allowed || allowed.length === 0) {
    return value
  }
  return {
    ran: value.ran.filter(job => workflowRefAllowedByList(allowed, job.workflowRef)),
    skipped: value.skipped.filter(job => workflowRefAllowedByList(allowed, job.workflowRef)),
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

function workflowRunMatchesQuery(
  snapshot: MatOSWorkflowRunSnapshot,
  query?: string,
): boolean {
  const needle = query?.trim().toLowerCase()
  if (!needle) {
    return true
  }
  return [
    snapshot.runId,
    snapshot.workflowRef,
    snapshot.status,
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.waitingNodeId,
    snapshot.projectCwd,
    snapshot.workspaceDir,
    snapshot.trace?.traceId,
    snapshot.trace?.sessionId,
    snapshot.provenance?.source,
    snapshot.provenance?.triggerId,
    snapshot.provenance?.triggerEventId,
    snapshot.provenance?.payloadDigest,
  ].some(value => stringValue(value)?.toLowerCase().includes(needle))
}

function isoTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

function workflowRunMatchesFilters(
  snapshot: MatOSWorkflowRunSnapshot,
  filter?: MatOSWorkflowRunFilters,
): boolean {
  if (!filter) {
    return true
  }
  if (filter.workflowRef && snapshot.workflowRef !== filter.workflowRef) {
    return false
  }
  if (filter.status && snapshot.status !== filter.status) {
    return false
  }
  if (filter.traceId && snapshot.trace?.traceId !== filter.traceId) {
    return false
  }
  if (filter.sessionId && snapshot.trace?.sessionId !== filter.sessionId) {
    return false
  }
  if (filter.source && snapshot.provenance?.source !== filter.source) {
    return false
  }
  if (filter.triggerId && snapshot.provenance?.triggerId !== filter.triggerId) {
    return false
  }
  const updatedAt = isoTime(snapshot.updatedAt)
  const updatedAfter = isoTime(filter.updatedAfter)
  if (
    updatedAfter !== undefined &&
    (updatedAt === undefined || updatedAt < updatedAfter)
  ) {
    return false
  }
  const updatedBefore = isoTime(filter.updatedBefore)
  if (
    updatedBefore !== undefined &&
    (updatedAt === undefined || updatedAt > updatedBefore)
  ) {
    return false
  }
  return true
}

function normalizedRunFilters(
  filter?: MatOSWorkflowRunFilters,
): MatOSWorkflowRunFilters | undefined {
  if (!filter) {
    return undefined
  }
  const normalized: MatOSWorkflowRunFilters = {}
  for (const key of [
    'workflowRef',
    'status',
    'traceId',
    'sessionId',
    'triggerId',
    'source',
    'updatedAfter',
    'updatedBefore',
  ] as const) {
    const value = filter[key]
    if (typeof value === 'string' && value.trim()) {
      normalized[key] = value.trim() as never
    }
  }
  return Object.keys(normalized).length ? normalized : undefined
}

function workflowRunSortKey(snapshot: MatOSWorkflowRunSnapshot): string {
  return snapshot.updatedAt || snapshot.createdAt || snapshot.runId
}

async function listWorkflowRunSnapshots(input: MatOSWorkflowServiceContext & {
  query?: string
  filter?: MatOSWorkflowRunFilters
}): Promise<{
  workflowRunsDir: string
  rows: Array<{ runDir: string; snapshot: MatOSWorkflowRunSnapshot }>
}> {
  const scope = await resolveWorkflowScope(input)
  const filter = normalizedRunFilters(input.filter)
  let entries: Dirent[]
  try {
    entries = await readdir(scope.workflowRunsDir, { withFileTypes: true })
  } catch {
    return { workflowRunsDir: scope.workflowRunsDir, rows: [] }
  }
  const rows = (await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const runDir = join(scope.workflowRunsDir, entry.name)
        try {
          const snapshot = await readWorkflowRun(runDir)
          return workflowRunMatchesProject(snapshot, input) &&
            workflowRunMatchesQuery(snapshot, input.query) &&
            workflowRunMatchesFilters(snapshot, filter)
            ? { runDir, snapshot }
            : undefined
        } catch {
          return undefined
        }
      }),
  )).filter((row): row is { runDir: string; snapshot: MatOSWorkflowRunSnapshot } =>
    Boolean(row),
  )
  rows.sort((left, right) =>
    workflowRunSortKey(right.snapshot).localeCompare(workflowRunSortKey(left.snapshot)),
  )
  return { workflowRunsDir: scope.workflowRunsDir, rows }
}

async function draftDirForDraftId(
  input: MatOSWorkflowServiceContext & { draftId: string },
): Promise<string> {
  const scope = await materializedWorkflowScope(input)
  return resolveWorkflowDraftDir(scope.workflowsDir, input.draftId)
}

async function runDefinitionForRunId(
  input: MatOSWorkflowServiceContext & { runId: string },
): Promise<{
  run: Awaited<ReturnType<typeof readWorkflowRun>>
  runDir: string
  definition: MatOSWorkflowDefinition
}> {
  const runDir = await runDirForRunId(input)
  const run = await readWorkflowRun(runDir)
  const definition = JSON.parse(
    await readFile(join(runDir, run.graphSnapshotPath ?? 'graph.snapshot.json'), 'utf8'),
  ) as MatOSWorkflowDefinition
  return { run, runDir, definition }
}

function workflowCompileViewFromRunDefinition(input: {
  workflowRef: string
  definition: MatOSWorkflowDefinition
}): WorkflowCompileView {
  return compileMatOSWorkflowDefinition(input.definition, {
    workflowRef: input.workflowRef,
  })
}

async function draftMutationResult(
  input: MatOSWorkflowServiceContext,
  definition: MatOSWorkflowDefinition,
): Promise<{
  definition: MatOSWorkflowDefinition
  definitionDigest: string
  validation: ReturnType<typeof validateWorkflowDefinition>
}> {
  return {
    definition,
    definitionDigest: workflowDraftDefinitionDigest(definition),
    validation: await validateWorkflowDefinitionForCwd(input, definition),
  }
}

async function withWorkflowPublicationLock<T>(cwd: string, id: string, fn: () => Promise<T>): Promise<T> {
  // A publication owns the asset files until scoped sync finishes. A draft-only
  // lock is insufficient when different drafts publish the same asset id.
  const key = createHash('sha256').update(workflowPublicationAssetId(id)).digest('hex')
  const dir = join(getMatOSDir(cwd), 'workflows', 'publications', key)
  await mkdir(dir, { recursive: true })
  return withWorkflowRunLock(dir, fn,
    { owner: 'workflow.publish', timeoutMs: 90_000 })
}

async function syncWorkflowPublication(input: Parameters<typeof syncPublishedWorkflowDraftToScopedGitea>[0] & { draftDir: string }) {
  let result: MatOSWorkflowScopedGiteaSyncResult
  try {
    result = await syncPublishedWorkflowDraftToScopedGitea(input)
  } catch (error) {
    result = { ok: false, action: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) {
    const reason = String(redactTraceValue(result.reason ?? 'Scoped asset source is unavailable')).slice(0, 1500)
    await recordWorkflowDraftPublicationFailure({ draftDir: input.draftDir, published: input.published, reason })
    throw new Error(`Workflow publication failed: ${reason}. Draft ${input.draftId} is retained; repair the asset source access and retry publication.`)
  }
  return result
}

async function validateWorkflowDefinitionForCwd(
  input: { cwd: string; env?: MatOSEnv },
  definition: MatOSWorkflowDefinition,
): Promise<ReturnType<typeof validateWorkflowDefinition>> {
  const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
  return validateWorkflowDefinition(definition, {
    assetResolver: reference => registry.resolve(reference),
  })
}

async function withRunMutationLock<T>(
  input: MatOSWorkflowServiceContext & { runId: string },
  owner: string,
  fn: (runDir: string) => Promise<T>,
): Promise<T> {
  const runDir = await runDirForRunId(input)
  return withWorkflowRunLock(runDir, () => fn(runDir), { owner })
}

function remoteRecoveryQueueDir(workflowsDir: string): string {
  return join(workflowsDir, 'remote-recovery-queue')
}

async function loadWorkflow(input: MatOSWorkflowServiceContext & { ref: string }) {
  const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
  return loadWorkflowAsset(registry, input.ref)
}

async function workflowDefinitionWithDraftFallback(input: {
  scope: Awaited<ReturnType<typeof materializedWorkflowScope>>
  asset: MatOSAsset
  definition: MatOSWorkflowDefinition
}): Promise<MatOSWorkflowDefinition> {
  if (Array.isArray(input.definition.nodes) && input.definition.nodes.length > 0) {
    return input.definition
  }
  const draftId =
    typeof input.asset.metadata.draftId === 'string' &&
    input.asset.metadata.draftId.trim()
      ? input.asset.metadata.draftId.trim()
      : undefined
  if (!draftId) {
    return input.definition
  }
  try {
    const draftDefinition = await readWorkflowDraftDefinition(
      resolveWorkflowDraftDir(input.scope.workflowsDir, draftId),
    )
    if (
      Array.isArray(draftDefinition.nodes) &&
      draftDefinition.nodes.length > 0
    ) {
      return draftDefinition
    }
  } catch {
    // Published workflow assets remain the authority. The draft fallback is
    // only for freshly published assets whose entry was not materialized yet.
  }
  return input.definition
}

function replayVerificationDir(cwd: string, candidateId: string): string {
  return join(
    getMatOSDir(cwd),
    'evolution',
    'replay-candidates',
    candidateId,
    'verification',
  )
}

function replayVerificationRunnerFor(candidateId: string) {
  // Replay verification must never execute inside the project's shared
  // workspace: exec nodes write files, so a background replay would mutate
  // user data and race foreground runs (and their tests). The replay runs the
  // recorded graph snapshot directly through the workflow runtime in a
  // disposable workspace under the candidate's own verification directory.
  // Bypassing the service entry point also means no session recording, no new
  // workflow evidence, and no recursive replay-candidate generation.
  return async function runReplayWorkflowForVerification(input: {
    cwd: string
    workflowRef: string
    parameters: Record<string, unknown>
  }): Promise<{ runId: string; status: string; failedNodeIds: string[] }> {
    const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
    const loaded = await loadWorkflowAsset(registry, input.workflowRef)
    const verificationDir = replayVerificationDir(input.cwd, candidateId)
    const workspaceDir = join(verificationDir, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const run = await startWorkflowRun({
      cwd: input.cwd,
      workflowsDir: verificationDir,
      workflowRef: input.workflowRef,
      workspaceDir,
      parameters: input.parameters,
      definition: loaded.definition,
    })
    return {
      runId: run.runId,
      status: run.status,
      failedNodeIds: (run.nodes ?? [])
        .filter(node => node.status === 'failed')
        .map(node => node.nodeId)
        .sort(),
    }
  }
}

function definedRuntimeEnv(env?: MatOSEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') {
      result[key] = value
    }
  }
  return result
}

function runWithRuntimeEnv<T>(
  env: MatOSEnv | undefined,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const defined = definedRuntimeEnv(env)
  return Object.keys(defined).length > 0
    ? withTemporaryMatOSEnv(defined, fn)
    : fn()
}

async function maintainReplayClosure(input: {
  cwd: string
  candidateId: string
  workflowRef: string
}): Promise<void> {
  try {
    let definition:
      | { nodes?: Array<{ type?: unknown; runtimeType?: unknown; targetType?: unknown }> }
      | undefined
    try {
      const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
      const loaded = await loadWorkflowAsset(registry, input.workflowRef)
      definition = loaded.definition
    } catch {
      definition = undefined
    }
    // The verifier owns the safety decision. Missing or unloadable definitions
    // must be recorded as skipped-unsafe instead of silently leaving candidates
    // unmarked.
    await verifyMatOSWorkflowReplayCandidate({
      cwd: input.cwd,
      candidateId: input.candidateId,
      runWorkflow: replayVerificationRunnerFor(input.candidateId),
      definition,
    })
    await maintainMatOSStableImprovementCandidates(input.cwd)
  } catch {
    // Replay closure is best-effort background maintenance.
  }
}

// Replay closure work is serialized through one in-process queue so
// concurrent failed runs cannot stampede verification replays.
let replayClosureTail: Promise<void> = Promise.resolve()

function enqueueReplayClosureMaintenance(input: {
  cwd: string
  candidateId: string
  workflowRef: string
}): void {
  replayClosureTail = replayClosureTail
    .then(() => maintainReplayClosure(input))
    .catch(() => {
      // maintainReplayClosure already swallows its own errors.
    })
}

export async function awaitMatOSWorkflowReplayClosureIdle(): Promise<void> {
  await replayClosureTail
}

async function recordWorkflowEvolutionEvidence(input: {
  cwd: string
  run: WorkflowRunView
}): Promise<void> {
  try {
    const evidence = await buildWorkflowEvidenceFromRunDir({
      cwd: input.cwd,
      runDir: input.run.runDir,
    })
    const replayCandidate = await generateMatOSWorkflowReplayCandidate({
      cwd: input.cwd,
      evidence,
      runDir: input.run.runDir,
    }).catch(() => undefined)
    const written = await writeWorkflowEvidence(input.cwd, {
      ...evidence,
      ...(replayCandidate
        ? { replayCandidateIds: [replayCandidate.candidateId] }
        : {}),
    })
    if (replayCandidate) {
      await maintainMatOSWorkflowReplayClusters(input.cwd).catch(() => [])
      enqueueReplayClosureMaintenance({
        cwd: input.cwd,
        candidateId: replayCandidate.candidateId,
        workflowRef: replayCandidate.workflowRef,
      })
    }
    await resolveMatOSEvolutionProvider().createWorkflowEvidenceJobs({
      cwd: input.cwd,
      evidence: written,
    })
  } catch {
    // Background evolution evidence must not interrupt workflow execution.
  }
}

export function createMatOSWorkflowService(): MatOSWorkflowService {
  ensureMatOSAlgorithmWorkflowIntegration()
  return {
    async list(input) {
      const workflows = (await loadMatOSWorkbenchRuntimeAssets(input))
        .filter(asset => asset.type === 'workflow')
        .map(serializeWorkflowAsset)
      return { workflows }
    },

    async show(input) {
      const loaded = await loadWorkflow(input)
      return {
        workflow: serializeWorkflowAsset(loaded.asset),
        kind: loaded.kind,
        definition: loaded.definition,
        validation: await validateWorkflowDefinitionForCwd(
          input,
          loaded.definition,
        ),
        nodeManifests: MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES,
        nodeManifestReport: workflowNodeManifestCoverageReport(),
      }
    },

    async validate(input) {
      const loaded = await loadWorkflow(input)
      const result = await validateWorkflowDefinitionForCwd(
        input,
        loaded.definition,
      )
      return {
        workflow: workflowKey(loaded.asset),
        ok: result.ok,
        errors: result.errors,
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      }
    },

    async compile(input) {
      const loaded = await loadWorkflow(input)
      return compileMatOSWorkflowDefinition(loaded.definition, {
        workflowRef: workflowKey(loaded.asset),
      })
    },

    async compileInspect(input) {
      const { run, definition } = await runDefinitionForRunId(input)
      return workflowCompileViewFromRunDefinition({
        workflowRef: run.workflowRef,
        definition,
      })
    },

    async contracts(input) {
      if (input.runId) {
        const { run, runDir, definition } = await runDefinitionForRunId({
          ...input,
          runId: input.runId,
        })
        const compiled = workflowCompileViewFromRunDefinition({
          workflowRef: run.workflowRef,
          definition,
        })
        const inspected = await inspectWorkflowRun(runDir)
        return {
          source: 'run',
          workflowRef: run.workflowRef,
          runId: input.runId,
          contracts: compiled.contracts,
          artifacts: workflowArtifactContractStatuses(
            compiled.contracts,
            inspected.artifacts ?? [],
          ),
        }
      }
      if (input.draftId) {
        const definition = await readWorkflowDraftDefinition(
          await draftDirForDraftId({ ...input, draftId: input.draftId }),
        )
        const compiled = compileMatOSWorkflowDefinition(definition, {
          workflowRef: `draft:${input.draftId}`,
        })
        return {
          source: 'draft',
          workflowRef: compiled.workflowRef,
          draftId: input.draftId,
          contracts: compiled.contracts,
          artifacts: workflowArtifactContractStatuses(compiled.contracts),
        }
      }
      if (input.ref) {
        const loaded = await loadWorkflow({ ...input, ref: input.ref })
        const compiled = compileMatOSWorkflowDefinition(loaded.definition, {
          workflowRef: workflowKey(loaded.asset),
        })
        return {
          source: 'workflow',
          workflowRef: compiled.workflowRef,
          contracts: compiled.contracts,
          artifacts: workflowArtifactContractStatuses(compiled.contracts),
        }
      }
      throw new Error('Workflow contracts require ref, draftId, or runId')
    },

    async listRuns(input) {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
      const offset = Math.max(0, input.offset ?? 0)
      const filter = normalizedRunFilters(input.filter)
      const listed = await listWorkflowRunSnapshots(input)
      const workflowRunsDir = listed.workflowRunsDir
      const rows = input.refAllowed
        ? listed.rows.filter(row => input.refAllowed!(row.snapshot.workflowRef))
        : listed.rows
      const page = rows.slice(offset, offset + limit)
      // detail 'summary' skips the per-row full inspect (all node-runs,
      // budget rollup including child runs, recovery classification) and the
      // full event-log read. A default page of 100 rows used to cost 100
      // inspects + 100 whole events.jsonl reads for what callers render as
      // one table row each; list surfaces (CLI runs table, Studio run picker,
      // access checks) only need the snapshot projection.
      const summaryOnly = input.detail === 'summary'
      const runs = await Promise.all(
        page.map(async ({ runDir, snapshot }) => {
          const fallbackView = (): WorkflowRunView => ({
            runId: snapshot.runId,
            runDir,
            status: snapshot.status,
            ...(snapshot.artifactRoot ? { artifactRoot: snapshot.artifactRoot } : {}),
            ...(snapshot.waitingNodeId ? { waitingNodeId: snapshot.waitingNodeId } : {}),
            ...(snapshot.trace ? { trace: snapshot.trace } : {}),
            ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}),
            outputs: snapshot.outputs,
          })
          const [inspected, events] = summaryOnly
            ? [fallbackView(), [] as MatOSWorkflowEvent[]]
            : await Promise.all([
                inspectWorkflowRun(runDir).catch(fallbackView),
                readWorkflowRunEvents(runDir).catch(() => []),
              ])
          return {
            snapshot,
            events,
            run: {
              ...inspected,
              workflowRef: snapshot.workflowRef,
              createdAt: snapshot.createdAt,
              updatedAt: snapshot.updatedAt,
              parameters: snapshot.parameters,
              ...(snapshot.trace ? { trace: snapshot.trace } : {}),
              ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}),
              ...(snapshot.projectCwd ? { projectCwd: snapshot.projectCwd } : {}),
              ...(snapshot.workspaceDir ? { workspaceDir: snapshot.workspaceDir } : {}),
            },
          }
        }),
      )
      return {
        runs,
        summary: {
          count: runs.length,
          total: rows.length,
          offset,
          limit,
          query: input.query?.trim() ?? '',
          ...(filter ? { filters: filter } : {}),
        },
        sources: {
          workflowRunsDir,
        },
      }
    },

    async drafts(input) {
      const scope = await materializedWorkflowScope(input)
      return { drafts: await listWorkflowDrafts(scope.workflowsDir) }
    },

    async showDraft(input) {
      const draftDir = await draftDirForDraftId(input)
      const definition = await readWorkflowDraftDefinition(draftDir)
      return {
        draft: { ...(await readWorkflowDraft(draftDir)), draftDir },
        definition,
        provenance: await readWorkflowDraftProvenance(draftDir),
        validation: await validateWorkflowDefinitionForCwd(input, definition),
      }
    },

    async createDraft(input) {
      const scope = await materializedWorkflowScope(input)
      const draft = await createWorkflowDraft({
        workflowsDir: scope.workflowsDir,
        draftId: input.id,
        name: input.name,
        version: input.version,
        description: input.description,
      })
      const snapshot = await readWorkflowDraft(draft.dir)
      const definition = await readWorkflowDraftDefinition(draft.dir)
      return {
        draft: { ...snapshot, draftDir: draft.dir },
        ...(await draftMutationResult(input, definition)),
      }
    },

    async forkWorkflow(input) {
      const scope = await materializedWorkflowScope(input)
      const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
      const source = await loadWorkflowAsset(registry, input.ref)
      const sourceRef = workflowKey(source.asset)
      const sourceDefinition = await workflowDefinitionWithDraftFallback({
        scope,
        asset: source.asset,
        definition: source.definition,
      })
      const definition: MatOSWorkflowDefinition = {
        ...sourceDefinition,
        name: input.name ?? sourceDefinition.name,
        ...(input.version ? { version: input.version } : {}),
        ...(input.description ? { description: input.description } : {}),
        sourcePath: undefined,
      }
      const draft = await createWorkflowDraft({
        workflowsDir: scope.workflowsDir,
        draftId: input.id,
        name: input.name ?? definition.name,
        version: input.version,
        description: input.description,
        definition,
        sourceWorkflowRef: sourceRef,
      })
      const snapshot = await readWorkflowDraft(draft.dir)
      const draftDefinition = await readWorkflowDraftDefinition(draft.dir)
      return {
        draft: { ...snapshot, draftDir: draft.dir },
        source: serializeWorkflowAsset(source.asset),
        definition: draftDefinition,
        validation: await validateWorkflowDefinitionForCwd(
          input,
          draftDefinition,
        ),
      }
    },

    async compileDraft(input) {
      const definition = await readWorkflowDraftDefinition(
        await draftDirForDraftId(input),
      )
      return compileMatOSWorkflowDefinition(definition, {
        workflowRef: `draft:${input.draftId}`,
      })
    },

    async addDraftNode(input) {
      const definition = await addWorkflowDraftNode({
        draftDir: await draftDirForDraftId(input),
        node: input.node,
      })
      return draftMutationResult(input, definition)
    },

    async updateDraftNode(input) {
      const definition = await updateWorkflowDraftNode({
        draftDir: await draftDirForDraftId(input),
        nodeId: input.nodeId,
        patch: input.patch,
      })
      return draftMutationResult(input, definition)
    },

    async deleteDraftNode(input) {
      const definition = await deleteWorkflowDraftNode({
        draftDir: await draftDirForDraftId(input),
        nodeId: input.nodeId,
      })
      return draftMutationResult(input, definition)
    },

    async connectDraftNodes(input) {
      const definition = await connectWorkflowDraftNodes({
        draftDir: await draftDirForDraftId(input),
        from: input.from,
        to: input.to,
      })
      return draftMutationResult(input, definition)
    },

    async disconnectDraftNodes(input) {
      const definition = await disconnectWorkflowDraftNodes({
        draftDir: await draftDirForDraftId(input),
        from: input.from,
        to: input.to,
      })
      return draftMutationResult(input, definition)
    },

    async connectDraftTransition(input) {
      const definition = await connectWorkflowDraftTransition({
        draftDir: await draftDirForDraftId(input),
        transition: input.transition,
      })
      return draftMutationResult(input, definition)
    },

    async disconnectDraftTransition(input) {
      const definition = await disconnectWorkflowDraftTransition({
        draftDir: await draftDirForDraftId(input),
        ...(input.id ? { id: input.id } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
      })
      return draftMutationResult(input, definition)
    },

    async setDraftStateMachine(input) {
      const definition = await setWorkflowDraftStateMachine({
        draftDir: await draftDirForDraftId(input),
        ...(input.disable !== undefined ? { disable: input.disable } : {}),
        ...(input.initialNodeId ? { initialNodeId: input.initialNodeId } : {}),
        ...(input.maxTransitions !== undefined
          ? { maxTransitions: input.maxTransitions }
          : {}),
        ...(input.maxFrames !== undefined ? { maxFrames: input.maxFrames } : {}),
      })
      return draftMutationResult(input, definition)
    },

    async setDraftOutputs(input) {
      const definition = await setWorkflowDraftOutputs({
        draftDir: await draftDirForDraftId(input),
        outputs: input.outputs,
      })
      return draftMutationResult(input, definition)
    },

    async setDraftParameters(input) {
      const definition = await setWorkflowDraftParameters({
        draftDir: await draftDirForDraftId(input),
        parameters: input.parameters,
        replace: input.replace,
        remove: input.remove,
      })
      return draftMutationResult(input, definition)
    },

    async replaceDraftDefinition(input) {
      const definition = await replaceWorkflowDraftDefinition({
        draftDir: await draftDirForDraftId(input),
        definition: input.definition,
      })
      return draftMutationResult(input, definition)
    },

    async importComponent(input) {
      const draftDir = await draftDirForDraftId(input)
      const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
      const component = await loadWorkflowAsset(registry, input.ref)
      const definition = await importWorkflowComponent({
        draftDir,
        componentRef: workflowKey(component.asset),
        definition: component.definition,
      })
      return {
        draft: { ...(await readWorkflowDraft(draftDir)), draftDir },
        component: serializeWorkflowAsset(component.asset),
        definition,
        validation: await validateWorkflowDefinitionForCwd(input, definition),
      }
    },

    async author(input) {
      return withWorkflowPublicationLock(input.cwd, input.id, async () => {
        const scope = await materializedWorkflowScope(input)
        // Reuse the workflow id as the draft id so re-running author after a
        // repair is idempotent: the draft is reset, replaced, and republished.
        const draft = await createWorkflowDraft({
          workflowsDir: scope.workflowsDir,
          draftId: input.id,
          name: input.name ?? input.definition.name,
          version: input.version,
          description: input.description,
        })
        // Store-level replace enforces the always-valid draft invariant and
        // throws actionable messages for structurally invalid definitions.
        const definition = await replaceWorkflowDraftDefinition({
          draftDir: draft.dir,
          definition: input.definition,
        })
        // The cwd-aware pass additionally resolves asset references (roles,
        // child workflows); failures here return a verdict instead of throwing
        // so the draft survives for repair.
        const validation = await validateWorkflowDefinitionForCwd(input, definition)
        if (input.publish === false || !validation.ok) {
          return {
            draftId: draft.draftId,
            validation,
            published: null,
            workflowRef: null,
          }
        }
        const published = await publishWorkflowDraft({
          cwd: input.cwd,
          draftDir: draft.dir,
          id: input.id,
          name: input.name,
          version: input.version,
          description: input.description,
          expectedDefinition: workflowDraftDefinitionDigest(definition),
        })
        await syncWorkflowPublication({
          cwd: input.cwd,
          scopeRef: input.scopeRef,
          env: input.env,
          draftId: draft.draftId,
          draftDir: draft.dir,
          published,
        })
        return {
          draftId: draft.draftId,
          validation,
          published,
          workflowRef: published.assetKey.startsWith('workflow:')
            ? published.assetKey
            : `workflow:${published.assetKey}`,
        }
      })
    },

    async publishDraft(input) {
      return withWorkflowPublicationLock(input.cwd, input.id ?? input.draftId, async () => {
        const draftDir = await draftDirForDraftId(input)
        const draftDefinition = await readWorkflowDraftDefinition(draftDir)
        const definitionDigest = workflowDraftDefinitionDigest(draftDefinition)
        if (input.expectedDefinition !== undefined && input.expectedDefinition !== definitionDigest) {
          throw new Error('WORKFLOW_DRAFT_CONFLICT: Workflow draft changed after validation. Validate the current definition and retry publication.')
        }
        const validation = await validateWorkflowDefinitionForCwd(
          input,
          draftDefinition,
        )
        if (!validation.ok) {
          throw new Error(
            `Workflow validation failed: ${validation.errors.map(error => error.message).join('; ')}`,
          )
        }
        if (!input.id && generatedDraftId(input.draftId)) {
          throw new Error(
            'Publishing an auto-generated workflow draft requires a semantic id, for example id="my-workflow".',
          )
        }
        const published = await publishWorkflowDraft({
          cwd: input.cwd,
          draftDir,
          id: input.id ?? input.draftId,
          name: input.name,
          version: input.version,
          description: input.description,
          expectedDefinition: definitionDigest,
        })
        const scopedGiteaSync = await syncWorkflowPublication({
          cwd: input.cwd,
          scopeRef: input.scopeRef,
          env: input.env,
          draftId: input.draftId,
          draftDir,
          published,
        })
        return {
          published,
          draft: { ...(await readWorkflowDraft(draftDir)), draftDir },
          ...(scopedGiteaSync.action !== 'skipped' ? { scopedGiteaSync } : {}),
        }
      })
    },

    async forkRun(input) {
      const scope = await materializedWorkflowScope(input)
      const draft = await forkWorkflowRunToDraft({
        workflowsDir: scope.workflowsDir,
        runDir: await runDirForRunId(input),
        draftId: input.id,
        name: input.name,
      })
      const definition = await readWorkflowDraftDefinition(draft.dir)
      return {
        draft: { ...(await readWorkflowDraft(draft.dir)), draftDir: draft.dir },
        definition,
        validation: await validateWorkflowDefinitionForCwd(input, definition),
      }
    },

    triggerEvents(_input) {
      return listMatOSWorkbenchWorkflowTriggerEvents()
    },

    triggers(input) {
      return listMatOSWorkbenchWorkflowTriggers({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        env: input.env,
        workflowRef: input.workflowRef,
      })
    },

    trigger(input) {
      return getMatOSWorkbenchWorkflowTrigger({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        env: input.env,
        workflowRef: input.workflowRef ?? '',
        triggerId: input.triggerId,
      })
    },

    saveTrigger(input) {
      return saveMatOSWorkbenchWorkflowTrigger({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        env: input.env,
        workflowRef: input.workflowRef,
        request: input.request,
      })
    },

    deleteTrigger(input) {
      return deleteMatOSWorkbenchWorkflowTrigger({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        env: input.env,
        workflowRef: input.workflowRef ?? '',
        triggerId: input.triggerId,
        request: input.request,
      })
    },

    async run(input) {
      const loaded = await loadWorkflow(input)
      const validation = await validateWorkflowDefinitionForCwd(
        input,
        loaded.definition,
      )
      if (!validation.ok) {
        throw new Error(
          `Workflow validation failed: ${validation.errors.map(error => error.message).join('; ')}`,
        )
      }

      const scope = await materializedWorkflowScope(input)
      const workflowRef = workflowKey(loaded.asset)
      const runWorkflow = async (): Promise<WorkflowRunView> =>
        startWorkflowRun({
          cwd: input.cwd,
          workflowsDir: scope.workflowsDir,
          workflowRunsDir: scope.workflowRunsDir,
          workspaceDir: scope.sharedWorkspaceDir,
          workflowRef,
          parameters: input.parameters,
          definition: loaded.definition,
          provenance: input.provenance,
          advance: input.advance,
        })

      if (input.recordSession === false) {
        return { run: await runWithRuntimeEnv(input.env, runWorkflow) }
      }

      const recorder = await createMatOSEventRecorder(
        input.cwd,
        {
          command: `matos workflow run ${JSON.stringify(input.ref)}`,
          cwd: input.cwd,
          execution: 'workflow',
          scopeRef: scope.ref,
        },
        { env: input.env },
      )
      try {
        const run = await withTemporaryMatOSEnv(recorder.traceEnv, runWorkflow)
        await recordWorkflowEvolutionEvidence({ cwd: input.cwd, run })
        await recorder.record({
          type:
            run.status === 'failed'
              ? 'matos.session.failed'
              : 'matos.session.completed',
          data: {
            workflowRef,
            runId: run.runId,
            status: run.status,
            exitCode: run.status === 'failed' ? 1 : 0,
          },
        })
        return { run }
      } catch (error) {
        await recorder.record({
          type: 'matos.session.failed',
          data: {
            workflowRef,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      } finally {
        await recorder.close()
      }
    },

    async runDraft(input) {
      const definition = await readWorkflowDraftDefinition(
        await draftDirForDraftId(input),
      )
      const validation = await validateWorkflowDefinitionForCwd(
        input,
        definition,
      )
      if (!validation.ok) {
        throw new Error(
          `Workflow validation failed: ${validation.errors.map(error => error.message).join('; ')}`,
        )
      }

      const scope = await materializedWorkflowScope(input)
      const workflowRef = `draft:${input.draftId}`
      const runWorkflow = async (): Promise<WorkflowRunView> =>
        startWorkflowRun({
          cwd: input.cwd,
          workflowsDir: scope.workflowsDir,
          workflowRunsDir: scope.workflowRunsDir,
          workspaceDir: scope.sharedWorkspaceDir,
          workflowRef,
          parameters: input.parameters,
          definition,
          provenance: input.provenance,
          advance: input.advance,
        })

      if (input.recordSession === false) {
        return { run: await runWithRuntimeEnv(input.env, runWorkflow) }
      }

      const recorder = await createMatOSEventRecorder(
        input.cwd,
        {
          command: `matos workflow run draft:${JSON.stringify(input.draftId)}`,
          cwd: input.cwd,
          execution: 'workflow',
          scopeRef: scope.ref,
        },
        { env: input.env },
      )
      try {
        const run = await withTemporaryMatOSEnv(recorder.traceEnv, runWorkflow)
        await recordWorkflowEvolutionEvidence({ cwd: input.cwd, run })
        await recorder.record({
          type:
            run.status === 'failed'
              ? 'matos.session.failed'
              : 'matos.session.completed',
          data: {
            workflowRef,
            runId: run.runId,
            status: run.status,
            exitCode: run.status === 'failed' ? 1 : 0,
          },
        })
        return { run }
      } catch (error) {
        await recorder.record({
          type: 'matos.session.failed',
          data: {
            workflowRef,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      } finally {
        await recorder.close()
      }
    },

    async nodeDebug(input) {
      const loaded = await loadWorkflow(input)
      const validation = await validateWorkflowDefinitionForCwd(
        input,
        loaded.definition,
      )
      if (!validation.ok) {
        throw new Error(
          `Workflow validation failed: ${validation.errors.map(error => error.message).join('; ')}`,
        )
      }

      const scope = await materializedWorkflowScope(input)
      const workflowRef = workflowKey(loaded.asset)
      const runWorkflow = async (): Promise<WorkflowRunView> =>
        startWorkflowSingleNodeRun({
          cwd: input.cwd,
          workflowsDir: scope.workflowsDir,
          workflowRunsDir: scope.workflowRunsDir,
          workspaceDir: scope.sharedWorkspaceDir,
          workflowRef,
          nodeId: input.nodeId,
          parameters: input.parameters,
          definition: loaded.definition,
          provenance: input.provenance,
        })

      if (input.recordSession === false) {
        return { run: await runWithRuntimeEnv(input.env, runWorkflow) }
      }

      const recorder = await createMatOSEventRecorder(
        input.cwd,
        {
          command: `matos workflow node-debug ${JSON.stringify(input.ref)} --node ${JSON.stringify(input.nodeId)}`,
          cwd: input.cwd,
          execution: 'workflow',
          scopeRef: scope.ref,
        },
        { env: input.env },
      )
      try {
        const run = await withTemporaryMatOSEnv(recorder.traceEnv, runWorkflow)
        await recordWorkflowEvolutionEvidence({ cwd: input.cwd, run })
        await recorder.record({
          type:
            run.status === 'failed'
              ? 'matos.session.failed'
              : 'matos.session.completed',
          data: {
            workflowRef,
            runId: run.runId,
            nodeId: input.nodeId,
            status: run.status,
            exitCode: run.status === 'failed' ? 1 : 0,
          },
        })
        return { run }
      } catch (error) {
        await recorder.record({
          type: 'matos.session.failed',
          data: {
            workflowRef,
            nodeId: input.nodeId,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      } finally {
        await recorder.close()
      }
    },

    async status(input) {
      const runDir = await runDirForRunId(input)
      return { run: viewFromSnapshot(runDir, await readWorkflowRun(runDir)) }
    },

    async pulse(input) {
      const runDir = await runDirForRunId(input)
      return { pulse: await workflowRunPulse(runDir) }
    },

    async wait(input) {
      const runDir = await runDirForRunId(input)
      return waitForWorkflowRun({
        runDir,
        timeoutSeconds: input.timeoutSeconds,
        sinceEventId: input.sinceEventId,
      })
    },

    async inspect(input) {
      return { run: await inspectWorkflowRun(await runDirForRunId(input)) }
    },

    async events(input) {
      return { events: await readWorkflowRunEvents(await runDirForRunId(input), { tail: input.tail }) }
    },

    async recover(input) {
      return { recovery: await recoverWorkflowRun(await runDirForRunId(input)) }
    },

    async recoverApply(input) {
      const runDir = await runDirForRunId(input)
      const [observed, snapshot] = await Promise.all([
        recoverWorkflowRun(runDir),
        readWorkflowRun(runDir),
      ])
      const manifest = await requireMatOSAlgorithmRunManifest(runDir, {
        runId: snapshot.runId,
        workflowRef: snapshot.workflowRef,
      })
      const selected = await withMatOSWorkflowExecutionContext(
        {
          runId: snapshot.runId,
          runDir,
          ...(observed.nodeId ? { workflowNodeId: observed.nodeId } : {}),
          projectCwd: snapshot.projectCwd ?? input.cwd,
          ...(snapshot.trace?.scopeRef ?? input.scopeRef
            ? { scopeRef: snapshot.trace?.scopeRef ?? input.scopeRef }
            : {}),
          algorithmSurfacePins:
            matOSAlgorithmSurfacePinsFromManifest(manifest),
        },
        () =>
          decideMatOSRecoveryPolicy({
            report: observed,
            candidateActions: workflowRecoverySafeAlternativeActions(observed),
            env: input.env,
            cwd: input.cwd,
          }),
      )
      return withWorkflowRunLock(
        runDir,
        () =>
          applyWorkflowRecoveryRecommendation(runDir, {
            recommendedAction: selected.decision.action,
            expectedRecoveryDigest: workflowRecoveryReportDigest(observed),
          }),
        { owner: 'workflow.recoverApply' },
      )
    },

    async recoverQueue(input) {
      if (workflowProjectCwd(input)) throw new Error('Whole-workspace recovery requires the workspace view')
      const scope = await materializedWorkflowScope(input)
      return filterRecoveryQueueForAllowedRefs(
        await refreshWorkflowRemoteRecoveryQueue({
          workflowRunsDir: scope.workflowRunsDir,
          queueDir: remoteRecoveryQueueDir(scope.workflowsDir),
        }),
        input.allowedWorkflowRefs,
      )
    },

    async recoverDrain(input) {
      if (workflowProjectCwd(input)) throw new Error('Whole-workspace recovery requires the workspace view')
      const scope = await materializedWorkflowScope(input)
      await refreshWorkflowRemoteRecoveryQueue({
        workflowRunsDir: scope.workflowRunsDir,
        queueDir: remoteRecoveryQueueDir(scope.workflowsDir),
      })
      return filterRecoveryDrainForAllowedRefs(
        await drainWorkflowRemoteRecoveryQueue({
          queueDir: remoteRecoveryQueueDir(scope.workflowsDir),
          shouldApplyJob: job =>
            workflowRefAllowedByList(input.allowedWorkflowRefs, job.workflowRef),
          applyJob: job =>
            withWorkflowRunLock(
              job.runDir,
              () => applyWorkflowRecoveryRecommendation(job.runDir),
              { owner: 'workflow.recoverDrain' },
            ),
        }),
        input.allowedWorkflowRefs,
      )
    },

    async reconcile(input) {
      return withRunMutationLock(input, 'workflow.reconcile', runDir =>
        reconcileWorkflowRunComputeJobs(runDir),
      )
    },

    async patches(input) {
      return {
        patches: await listWorkflowGraphPatchLedgers(await runDirForRunId(input)),
      }
    },

    async patchPropose(input) {
      return withRunMutationLock(input, 'workflow.patchPropose', async runDir => {
        const run = await readWorkflowRun(runDir)
        const definition = JSON.parse(
          await readFile(
            join(runDir, run.graphSnapshotPath ?? 'graph.snapshot.json'),
            'utf8',
          ),
        ) as MatOSWorkflowDefinition
        return proposeWorkflowGraphPatch({
          runDir,
          runId: run.runId,
          definition,
          operations: input.operations,
          reason: input.reason,
          risk: input.risk,
          sourceNodeId: input.sourceNodeId,
          decidedBy: input.decidedBy,
        })
      })
    },

    async patchInspect(input) {
      return {
        patch: await inspectWorkflowGraphPatchLedger(
          await runDirForRunId(input),
          input.patchId,
        ),
      }
    },

    async patchApprove(input) {
      return withRunMutationLock(input, 'workflow.patchApprove', runDir =>
        approveWorkflowGraphPatchForRun({
          runDir,
          patchId: input.patchId,
          reason: input.reason,
          decidedBy: input.decidedBy,
        }),
      )
    },

    async patchReject(input) {
      return withRunMutationLock(input, 'workflow.patchReject', runDir =>
        rejectWorkflowGraphPatchForRun({
          runDir,
          patchId: input.patchId,
          reason: input.reason,
          decidedBy: input.decidedBy,
        }),
      )
    },

    async patchApply(input) {
      return withRunMutationLock(input, 'workflow.patchApply', runDir =>
        applyWorkflowGraphPatchForRun({
          runDir,
          patchId: input.patchId,
          reason: input.reason,
          decidedBy: input.decidedBy,
        }),
      )
    },

    async artifacts(input) {
      const run = await inspectWorkflowRun(await runDirForRunId(input))
      return { runId: run.runId, artifacts: run.artifacts ?? [] }
    },

    async approvalStatus(input) {
      return inspectWorkflowApprovalStatus(await runDirForRunId(input))
    },

    async respond(input) {
      return {
        run: await withRunMutationLock(input, 'workflow.respond', runDir =>
          respondToWorkflowNode({
            runDir,
            nodeId: input.nodeId,
            response: input.response,
          }),
        ),
      }
    },

    async approve(input) {
      return {
        run: await withRunMutationLock(input, 'workflow.approve', runDir =>
          approveWorkflowNode({
            runDir,
            nodeId: input.nodeId,
            approvedFingerprint: input.fingerprint,
            response: input.response,
          }),
        ),
      }
    },

    async deny(input) {
      return {
        run: await withRunMutationLock(input, 'workflow.deny', runDir =>
          denyWorkflowNode({
            runDir,
            nodeId: input.nodeId,
            reason: input.reason,
          }),
        ),
      }
    },

    async cancel(input) {
      // Cancel must reach a run that is actively advancing under the run lock,
      // so it uses the cooperative request path (apply-if-idle, else leave a
      // control marker) instead of blocking on the mutation lock.
      return { run: await requestWorkflowRunCancel(await runDirForRunId(input)) }
    },

    async pause(input) {
      return { run: await requestWorkflowRunPause(await runDirForRunId(input)) }
    },

    async resume(input) {
      return {
        run: await withRunMutationLock(input, 'workflow.resume', runDir =>
          resumeWorkflowRun(runDir),
        ),
      }
    },

    async retryNode(input) {
      return {
        run: await withRunMutationLock(input, 'workflow.retryNode', runDir =>
          retryWorkflowNode({
            runDir,
            nodeId: input.nodeId,
            failedChildrenOnly: input.failedChildrenOnly,
          }),
        ),
      }
    },

    async skipNode(input) {
      return {
        run: await withRunMutationLock(input, 'workflow.skipNode', runDir =>
          skipWorkflowNode({
            runDir,
            nodeId: input.nodeId,
            reason: input.reason,
          }),
        ),
      }
    },
  }
}

export const matOSWorkflowService = createMatOSWorkflowService()
