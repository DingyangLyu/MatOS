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

import type { WorkflowAgentNodeRunResult } from './nodeAdapters/agentNode.js'
import type {
  MatOSWorkflowBudgetLedger,
  MatOSWorkflowDefinition,
  MatOSWorkflowFrameSnapshot,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunProvenance,
  MatOSWorkflowRunGraph,
  MatOSWorkflowRunStatus,
  WorkflowArtifactRef,
} from './types.js'
import type { WorkflowRecoveryReport } from './recovery.js'
import type { WorkflowRunLockInspection } from './runLock.js'
import type { MatOSTraceContext } from '../sessions/traceContext.js'

export type StartWorkflowRunInput = {
  workflowsDir: string
  workflowRunsDir?: string
  workflowRef: string
  parameters?: Record<string, unknown>
  definition: MatOSWorkflowDefinition
  workspaceDir: string
  cwd?: string
  provenance?: MatOSWorkflowRunProvenance
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
  trustedReviewedHighRiskBypass?: boolean
  // When false, persist the compiled run in `created` state and return
  // without executing any node. A detached worker (e.g. `matos workflow
  // resume <runId>`) advances it later. Long-running workflows started from
  // agent tool calls use this so the tool result returns immediately instead
  // of blocking the agent turn until the whole DAG finishes.
  advance?: boolean
  /** Child-run nesting depth (set by the runtime's child-run starter). */
  childDepth?: number
  onCreated?: (run: { runId: string; runDir: string }) => void | Promise<void>
}

export type StartWorkflowSingleNodeRunInput = StartWorkflowRunInput & {
  nodeId: string
}

export type WorkflowDynamicPlannerRunner = (
  node: MatOSWorkflowNode,
  options: {
    cwd: string
    scopeRef?: string
    runDir: string
    attempt: number
    idempotencyKey: string
  },
) => Promise<WorkflowAgentNodeRunResult>

// Starts a child workflow run. Injected into node execution so executor
// modules do not need a static import back into the runtime entry module.
export type StartChildWorkflowRun = (
  input: StartWorkflowRunInput,
) => Promise<WorkflowRunView>

// Resumes an existing (persisted) child workflow run by its run directory.
// Injected alongside StartChildWorkflowRun so a re-executed subworkflow,
// map, or loop node can adopt/advance the child it already spawned instead
// of starting a duplicate run. The optional context carries the adopting
// parent node id so lock-contention failures can name it in their guidance.
export type ResumeChildWorkflowRun = (
  childRunDir: string,
  context?: { nodeId?: string },
) => Promise<WorkflowRunView>

export type WorkflowRunView = {
  runId: string
  workflowRef?: string
  workflowName?: string
  runDir: string
  status: MatOSWorkflowRunStatus
  artifactRoot?: string
  waitingNodeId?: string
  trace?: MatOSTraceContext
  provenance?: MatOSWorkflowRunProvenance
  outputs: Record<string, unknown>
  nodes?: MatOSWorkflowNodeRunSnapshot[]
  artifacts?: WorkflowArtifactRef[]
  approvals?: WorkflowApprovalRequest[]
  pendingApprovals?: WorkflowApprovalRequest[]
  budget?: MatOSWorkflowBudgetLedger
  graph?: MatOSWorkflowRunGraph
  recovery?: WorkflowRecoveryReport
  runtimeState?: {
    lock?: WorkflowRunLockInspection
  }
  stateMachine?: {
    frames: MatOSWorkflowFrameSnapshot[]
  }
  diagnostics?: {
    nodeCount: number
    completedCount: number
    failedCount: number
    runningCount: number
    waitingCount: number
    pendingCount: number
    totalFinishedDurationMs?: number
    activeNodeIds: string[]
    failedNodes: Array<{
      nodeId: string
      attempts: number
      durationMs?: number
      error?: unknown
      remediation?: {
        scope: 'node' | 'workflow'
        action: string
        hint: string
        options?: string[]
      }
    }>
    timeline: Array<{
      nodeId: string
      status: MatOSWorkflowNodeRunSnapshot['status']
      attempts: number
      startedAt?: string
      finishedAt?: string
      durationMs?: number
    }>
  }
}

export type WorkflowApprovalAction = {
  nodeId: string
  type: string
  backend?: string
  toolRef?: string
  operation?: string
  input: unknown
}

export type WorkflowApprovalRequest = {
  nodeId: string
  status: 'pending' | 'approved' | 'denied'
  backend?: string
  toolRef?: string
  actionFingerprint: string
  action?: WorkflowApprovalAction
  requestedAt: string
  decidedAt?: string
  response?: unknown
  reason?: string
}
