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

import type { MatOSAsset } from '../assets/types.js'
import type { MatOSTraceContext } from '../sessions/traceContext.js'

export type MatOSWorkflowKind = 'executable' | 'component' | 'template'

export type MatOSWorkflowRuntimeNodeType =
  | 'agent'
  | 'exec'
  | 'guard'
  | 'human'
  | 'backend'
  | 'subworkflow'
  | 'map'
  | 'loop'
  | 'dynamic'

export type MatOSWorkflowTargetNodeType =
  | MatOSWorkflowRuntimeNodeType
  | 'compute'
  | 'instrument'
  | 'approval_gate'
  | 'validate'
  | 'supernode'
  | 'extension'

export type MatOSWorkflowNodeType = MatOSWorkflowTargetNodeType

export type MatOSWorkflowApprovalMode = 'bypass' | 'ask' | 'strict'

export type MatOSWorkflowExecutionModel = 'dag' | 'state_machine'

export type MatOSWorkflowTransitionRoute = 'success' | 'failure' | 'always'

export type MatOSWorkflowTransitionEdge = {
  id?: string
  from: string
  to: string
  guard?: string
  route?: MatOSWorkflowTransitionRoute
  reducer?: Record<string, unknown>
  maxTraversals?: number
}

export type MatOSWorkflowStateMachinePolicy = {
  initialNodeId: string
  maxTransitions: number
  maxFrames?: number
  stateContract?: Record<string, unknown>
}

export type MatOSWorkflowBudgetPolicy = {
  maxNodeAttempts?: number
  maxAgentCalls?: number
  maxToolCalls?: number
  maxBackendJobs?: number
  /**
   * Sum of active node-attempt durations (`finishedAt - startedAt`) across the
   * run and its child runs. Does not include idle time spent waiting for human
   * input/approval or an in-flight attempt that has not finished yet.
   */
  maxWallTimeMs?: number
  /**
   * Real elapsed wall-clock budget measured from the run's `createdAt` to now,
   * enforced at each scheduling round. Unlike `maxWallTimeMs` this includes
   * idle waiting time and stops a run that has been alive too long even while a
   * single long attempt is still in flight. Run-level only (not aggregated from
   * child runs, which each measure their own elapsed time).
   */
  maxElapsedWallTimeMs?: number
  maxAgentTurns?: number
  maxTotalTokens?: number
  maxTotalCostUsd?: number
  onExceeded?: 'fail' | 'pause'
}

/**
 * Node-level budget limits enforced against that node's accumulated budget
 * summary (`byNode`). Violations carry the node id and stop scheduling using
 * the workflow-level `onExceeded` policy.
 */
export type MatOSWorkflowNodeBudgetPolicy = Omit<
  MatOSWorkflowBudgetPolicy,
  'onExceeded'
>

export type MatOSWorkflowControllerPolicy = {
  enabled?: boolean
  mode?: 'active' | 'shadow'
  provider?: string
  version?: string
  config?: Record<string, unknown>
  objectiveRef?: string
  seed?: number
  bounds?: {
    maxActions?: number
    maxCandidates?: number
    maxDepth?: number
    maxWallTimeMs?: number
    maxCostUsd?: number
  }
  budget?: {
    actions?: number
    candidates?: number
    transitions?: number
    evaluations?: number
    maxDepth?: number
    wallTimeMs?: number
    costUsd?: number
  }
  onFailure?: 'baseline' | 'pause' | 'fail'
}

export type MatOSWorkflowPolicy = {
  approvalMode?: MatOSWorkflowApprovalMode
  defaultRisk?: 'low' | 'medium' | 'high' | string
  executionModel?: MatOSWorkflowExecutionModel
  stateMachine?: MatOSWorkflowStateMachinePolicy
  budget?: MatOSWorkflowBudgetPolicy
  controller?: MatOSWorkflowControllerPolicy
  [key: string]: unknown
}

export type MatOSWorkflowParameter = {
  type?: string
  required?: boolean
  default?: unknown
  description?: string
  [key: string]: unknown
}

export type MatOSWorkflowOutput = {
  value?: unknown
  [key: string]: unknown
}

export type WorkflowValueContract = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | string
  required?: boolean
  schema?: unknown
  description?: string
  [key: string]: unknown
}

export type ScientificDataSourceRef = {
  datasetRef?: string
  mathhubRef?: string
  sourceUrl?: string
  sourceCommit?: string
  runtimeRef?: string
  scopeRef?: string
  query?: Record<string, unknown>
  subset?: string
  splitManifest?: string
  license?: string
  materializedPath?: string
  digest?: string
  largeFilePolicy?: 'reference-only' | 'copy-on-write' | 'materialized-view'
  provenance?: Record<string, unknown>
}

export type ScientificPotentialProvenanceRef = {
  ref?: string
  family?: string
  functional?: string
  version?: string
  sourceUrl?: string
  path?: string
  digest?: string
  elements?: string[]
  speciesOrder?: string[]
  licenseScope?: string
  redacted?: boolean
  policyRef?: string
  approvalRef?: string
  notes?: string[]
}

export type WorkflowArtifactContract = {
  id?: string
  kind?: string
  path?: string
  mediaType?: string
  required?: boolean
  producerNodeId?: string
  description?: string
  [key: string]: unknown
}

export type WorkflowNodeContract = {
  inputs?: Record<string, WorkflowValueContract>
  outputs?: Record<string, WorkflowValueContract>
  artifacts?: Record<string, WorkflowArtifactContract>
}

export type WorkflowContractMap = {
  nodes: Record<string, WorkflowNodeContract>
}

export type WorkflowAttemptSideEffectSummary = {
  class:
    | 'none'
    | 'model_call'
    | 'local_process'
    | 'external_backend'
    | 'human_input'
    | 'child_workflow'
    | 'iteration_children'
    | 'graph_patch'
  replaySafe: boolean
  replayStrategy:
    | 'rerun'
    | 'skip_completed'
    | 'reconcile_before_resubmit'
    | 'wait_for_human'
    | 'manual_review'
  external?: boolean
  artifactWrites?: number
  childRuns?: number
  graphSnapshot?: boolean
  receipt?: {
    backend?: string
    operation?: string
    jobId?: string
    taskId?: string
    status?: string
  }
  notes?: string[]
}

export type WorkflowArtifactRef = {
  id?: string
  path?: string
  kind?: string
  mediaType?: string
  nodeId?: string
  attempt?: number
  sha256?: string
  sizeBytes?: number
  producerNodeId?: string
  scopeRef?: string
  runtimeRef?: string
  traceId?: string
  source?: 'input' | 'runtime' | 'output' | 'log' | 'validation' | 'provenance' | string
  bundleRef?: string
  redacted?: boolean
  metadata?: Record<string, unknown>
}

export type WorkflowArtifactBundleRef = {
  id: string
  kind:
    | 'input'
    | 'runtime'
    | 'output'
    | 'logs'
    | 'validation'
    | 'provenance'
    | string
  artifacts: WorkflowArtifactRef[]
  nodeId?: string
  attempt?: number
  digest?: string
  createdAt?: string
  metadata?: Record<string, unknown>
}

export type ComputeJobSpec = {
  backend: string
  operation?: string
  codeFamily?: 'vasp' | 'qe' | 'abinit' | 'cp2k' | 'lammps' | 'mlip' | string
  taskKind?: string
  workdir?: string
  remoteWorkdir?: string
  image?: string
  queue?: string
  flavor?: string
  command?: string
  inputManifestDigest?: string
  idempotencyKey?: string
  pseudopotentialRefs?: ScientificPotentialProvenanceRef[]
  potentialRefs?: ScientificPotentialProvenanceRef[]
  datasetRefs?: ScientificDataSourceRef[]
  inputs: Record<string, unknown>
  metadata: Record<string, unknown>
}

export type ComputeJobStatusTimelineEntry = {
  at: string
  source: 'submit' | 'status' | 'logs' | 'cancel' | 'reconcile' | 'runtime' | string
  status?: string
  phase?: string
  message?: string
  payload?: unknown
}

export type ComputeJobReceipt = {
  ok: boolean
  backend: string
  operation?: string
  toolRef?: string
  toolId?: string
  exitCode?: number | null
  taskDigest?: string
  attemptId?: string
  idempotencyKey?: string
  jobId?: string
  taskId?: string
  workdir?: string
  remoteWorkdir?: string
  status?: string
  phase?: string
  statusTimeline?: ComputeJobStatusTimelineEntry[]
  logs?: Record<string, string>
  artifactBundleRef?: string
  artifactBundles?: WorkflowArtifactBundleRef[]
  validationResultRef?: string
  validation?: ValidationResult
  reconcileState?: 'not_needed' | 'pending' | 'ok' | 'failed'
  cancelState?: 'not_requested' | 'pending' | 'ok' | 'failed'
  costSummary?: Record<string, unknown>
  pseudopotentialRefs?: ScientificPotentialProvenanceRef[]
  potentialRefs?: ScientificPotentialProvenanceRef[]
  datasetRefs?: ScientificDataSourceRef[]
  artifacts: WorkflowArtifactRef[]
  diagnostics: Record<string, unknown>
  payload?: unknown
}

export type MatOSWorkflowComputeLifecycle = {
  submitNodeId?: string
  statusNodeId?: string
  logsNodeId?: string
  cancelOnWorkflowCancel?: boolean
  poll?: {
    intervalMs: number
    maxPolls: number
    terminalStatuses: string[]
    failureStatuses: string[]
  }
}

export type ValidationResult = {
  ok: boolean
  severity: 'info' | 'warning' | 'error'
  checks: Array<{
    id: string
    type: string
    ok: boolean
    observed?: unknown
    expected?: unknown
    evidence?: WorkflowArtifactRef[]
    error?: string
    /** Stable machine-readable failure identity supplied by the check author. */
    code?: string
    /** Concise user-facing explanation of why the check matters. */
    message?: string
    /** Concrete repair guidance for an agent or operator. */
    hint?: string
    /** Whether retrying can be useful after the input or configuration is repaired. */
    retryable?: boolean
    /** Optional producer node that should be inspected or repaired first. */
    sourceNodeId?: string
  }>
  recommendation: 'continue' | 'retry' | 'reroute' | 'human_review' | 'fail'
}

export type MatOSWorkflowRetryPolicy = {
  maxAttempts?: number
  backoffMs?: number
  retryableExitCodes?: number[]
  retryableErrorPatterns?: string[]
}

export type MatOSWorkflowNodePolicy = {
  risk?: 'low' | 'medium' | 'high' | string
  approval?: 'inherit' | 'bypass' | 'ask' | 'require'
  reviewedHighRiskBypass?: boolean
  retry?: MatOSWorkflowRetryPolicy
  [key: string]: unknown
}

export type MatOSWorkflowAlgorithmDecision = {
  protocol: 'json-v1'
  /** Exact tool asset reference used by this native backend node. */
  componentRef: string
  plane: 'policy' | 'controller' | 'optimizer'
  providerId: string
  providerVersion: string
  /** Static behavior configuration. Runtime inputs remain in input/toolInput. */
  config?: Record<string, unknown>
}

export type MatOSWorkflowGuardCheck = {
  type:
    | 'expression'
    | 'file_exists'
    | 'file_size'
    | 'grep'
    | 'regex'
    | 'numeric_range'
    | 'json_schema'
  value?: unknown
  path?: string
  pattern?: string
  flags?: string
  negate?: boolean
  min?: number
  max?: number
  minBytes?: number
  maxBytes?: number
  notEqual?: number
  schema?: unknown
  failureCode?: string
  failureMessage?: string
  repairHint?: string
  retryable?: boolean
  sourceNodeId?: string
  [key: string]: unknown
}

export type MatOSWorkflowNode = {
  id: string
  type: MatOSWorkflowNodeType
  targetType?: MatOSWorkflowTargetNodeType
  runtimeType?: MatOSWorkflowRuntimeNodeType
  matosProduct?: {
    semanticType?: MatOSWorkflowTargetNodeType | string
    runtimeType?: MatOSWorkflowRuntimeNodeType | string
    category?: string
    manifestType?: string
    displayType?: string
    source?: string
    [key: string]: unknown
  }
  incomingEdges?: MatOSWorkflowEdge[]
  dependsOn: string[]
  policy?: MatOSWorkflowNodePolicy
  /** Disable only for diagnostic/log-replay exec nodes that intentionally print fatal signatures. */
  detectKnownProcessFailures?: boolean
  algorithmDecision?: MatOSWorkflowAlgorithmDecision
  outputSchema?: Record<string, unknown>
  inputContract?: Record<string, WorkflowValueContract>
  outputContract?: Record<string, WorkflowValueContract>
  artifactContract?: Record<string, WorkflowArtifactContract>
  [key: string]: unknown
}

export type MatOSWorkflowEdgeRoute = 'success' | 'failure' | 'always'

export type MatOSWorkflowEdge = {
  from: string
  to: string
  condition?: string
  route?: MatOSWorkflowEdgeRoute
}

/**
 * Canvas layout metadata for the Coze workflow builder. Positions are pure UI
 * state: they are not part of workflow execution semantics and must not affect
 * validation or compile. They round-trip through the native definition so a
 * user-arranged canvas layout survives save/reload.
 */
export type MatOSWorkflowCanvasNodePosition = {
  x: number
  y: number
}

export type MatOSWorkflowCanvas = {
  nodes?: Record<string, MatOSWorkflowCanvasNodePosition>
}

export type MatOSWorkflowDefinition = {
  schemaVersion: 1
  name: string
  version?: string
  description?: string
  parameters: Record<string, MatOSWorkflowParameter>
  policy: MatOSWorkflowPolicy
  nodes: MatOSWorkflowNode[]
  edges?: MatOSWorkflowEdge[]
  transitions?: MatOSWorkflowTransitionEdge[]
  outputs: Record<string, MatOSWorkflowOutput>
  canvas?: MatOSWorkflowCanvas
  sourcePath?: string
  compiled?: Record<string, unknown>
}

export type LoadedMatOSWorkflow = {
  asset: MatOSAsset
  kind: MatOSWorkflowKind
  definition: MatOSWorkflowDefinition
}

export type MatOSWorkflowValidationErrorCode =
  | 'missing_field'
  | 'invalid_node_type'
  | 'duplicate_node_id'
  | 'missing_node_dependency'
  | 'workflow_cycle'
  | 'invalid_policy'
  | 'invalid_node_config'
  | 'invalid_output_schema'
  | 'invalid_output_reference'
  | 'invalid_reference'
  | 'contract_type_mismatch'

export type MatOSWorkflowValidationError = {
  code: MatOSWorkflowValidationErrorCode
  message: string
  nodeId?: string
  path?: string
}

export type MatOSWorkflowValidationWarningCode =
  | 'budget_worst_case_attempts'
  | 'node_budget_below_retry'

export type MatOSWorkflowValidationWarning = {
  code: MatOSWorkflowValidationWarningCode
  message: string
  nodeId?: string
  path?: string
}

export type MatOSWorkflowValidationResult = {
  ok: boolean
  errors: MatOSWorkflowValidationError[]
  warnings?: MatOSWorkflowValidationWarning[]
}

export type MatOSWorkflowRunStatus =
  | 'created'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type MatOSWorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type MatOSWorkflowFrameStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_input'
  | 'waiting_approval'

export type MatOSWorkflowFrameSnapshot = {
  frameId: string
  index: number
  activeNodeId: string
  status: MatOSWorkflowFrameStatus
  state: Record<string, unknown>
  transitionFromFrameId?: string
  transitionEdgeId?: string
  nodeRunPath?: string
  createdAt: string
  updatedAt: string
}

export type MatOSWorkflowEventInput = {
  type: string
  data?: Record<string, unknown>
}

export type MatOSWorkflowEvent = MatOSWorkflowEventInput & {
  id: string
  timestamp: string
  trace?: MatOSTraceContext
}

export type MatOSWorkflowRunProvenance = {
  source:
    | 'manual'
    | 'agent_tool'
    | 'trigger'
    | 'workflow'
    | 'scheduler'
    | 'replay'
    | 'debug'
    | 'unknown'
  triggerId?: string
  triggerEventId?: string
  triggerAppId?: string
  firedAt?: number
  payloadDigest?: string
  schedulerTickId?: string
  parentRunId?: string
  parentWorkflowRef?: string
  reason?: string
  metadata?: Record<string, unknown>
}

export type MatOSWorkflowRunSnapshot = {
  /** Native runtime run record schema. Legacy records may omit this field. */
  schemaVersion?: 2
  runId: string
  workflowRef: string
  status: MatOSWorkflowRunStatus
  createdAt: string
  updatedAt: string
  parameters: Record<string, unknown>
  outputs: Record<string, unknown>
  graphSnapshotPath: string
  artifactRoot?: string
  projectCwd?: string
  workspaceDir?: string
  waitingNodeId?: string
  /**
   * Nesting depth for child runs spawned by subworkflow/map/loop nodes
   * (absent/0 for top-level runs). Bounds cross-workflow recursion: static
   * validation only catches direct self-references, so mutual recursion
   * (A -> B -> A) must be stopped at child-run creation time.
   */
  childDepth?: number
  trace?: MatOSTraceContext
  provenance?: MatOSWorkflowRunProvenance
}

export type MatOSWorkflowNodeRunSnapshot = {
  nodeId: string
  status: MatOSWorkflowNodeStatus
  attempts: number
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  idempotencyKey?: string
  sideEffect?: WorkflowAttemptSideEffectSummary
  output?: unknown
  error?: unknown
}

export type MatOSWorkflowBudgetTotals = {
  nodeAttempts: number
  agentCalls: number
  toolCalls: number
  backendJobs: number
  wallTimeMs: number
  /**
   * Real elapsed wall-clock time from the run's `createdAt` to ledger refresh.
   * Run-level measure; not summed across child runs (each child records its
   * own elapsed time).
   */
  elapsedWallTimeMs: number
  agentTurns: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  totalCostUsd: number
}

/**
 * Normalized model usage captured from one agent node attempt. Parsed from the
 * headless SDK result envelope (`usage`, `num_turns`, `total_cost_usd`) and
 * persisted on the attempt manifest so budget accounting can be recomputed
 * from durable run state.
 */
export type MatOSWorkflowAttemptUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  totalTokens?: number
  agentTurns?: number
  totalCostUsd?: number
}

export type MatOSWorkflowNodeBudgetSummary = MatOSWorkflowBudgetTotals & {
  nodeId: string
  type?: MatOSWorkflowNodeType
  runtimeType?: MatOSWorkflowRuntimeNodeType
  targetType?: MatOSWorkflowTargetNodeType
  lastStatus?: MatOSWorkflowNodeStatus
}

export type MatOSWorkflowChildBudgetSummary = {
  runId: string
  runDir?: string
  nodeId?: string
  status?: string
  totals: MatOSWorkflowBudgetTotals
  error?: string
}

export type MatOSWorkflowBudgetViolation = {
  limit: keyof MatOSWorkflowBudgetPolicy & `max${string}`
  max: number
  observed: number
  /** Present when a node-level `budget` limit was violated. */
  nodeId?: string
}

export type MatOSWorkflowBudgetLedger = {
  schemaVersion: 1
  runId: string
  workflowRef: string
  generatedAt: string
  source: 'node-attempts'
  totals: MatOSWorkflowBudgetTotals
  ownTotals: MatOSWorkflowBudgetTotals
  childWorkflowTotals: MatOSWorkflowBudgetTotals
  childWorkflowRuns: MatOSWorkflowChildBudgetSummary[]
  byNode: Record<string, MatOSWorkflowNodeBudgetSummary>
  policy?: MatOSWorkflowBudgetPolicy
  violations?: MatOSWorkflowBudgetViolation[]
}

export type MatOSWorkflowRunGraphNode = {
  id: string
  label?: string
  type: MatOSWorkflowNodeType
  runtimeType?: MatOSWorkflowRuntimeNodeType
  targetType?: MatOSWorkflowTargetNodeType
  dependsOn: string[]
}

export type MatOSWorkflowRunGraphEdge = {
  from: string
  to: string
  route?: MatOSWorkflowEdgeRoute
  condition?: string
}

export type MatOSWorkflowRunGraph = {
  nodes: MatOSWorkflowRunGraphNode[]
  edges: MatOSWorkflowRunGraphEdge[]
}

export type MatOSWorkflowDraftStatus = 'draft' | 'published'

export type MatOSWorkflowDraftSnapshot = {
  draftId: string
  status: MatOSWorkflowDraftStatus
  createdAt: string
  updatedAt: string
  workflowPath: string
  provenancePath: string
  validationPath: string
  sourceRunId?: string
  sourceWorkflowRef?: string
  publishedAssetKey?: string
}

export type MatOSWorkflowDraftProvenanceEntry = {
  id: string
  timestamp: string
  type: string
  data?: Record<string, unknown>
}
