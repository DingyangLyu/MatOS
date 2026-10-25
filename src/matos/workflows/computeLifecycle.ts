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

import { setTimeout as delay } from 'node:timers/promises'
import { runWorkflowBackendNode } from './nodeAdapters/backendNode.js'
import {
  computeJobReceiptFromBackendOutput,
  computeJobSpecForNode,
} from './nodeAdapters/computeNode.js'
import { appendWorkflowEvent, readWorkflowRun } from './workflowStore.js'
import { readWorkflowRunControlAction } from './workflowControl.js'
import { readNodeRun } from './runState.js'
import type {
  ComputeJobReceipt,
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
} from './types.js'

const DEFAULT_COMPUTE_TERMINAL_STATUSES = [
  'finished',
  'success',
  'succeeded',
  'completed',
]
const DEFAULT_COMPUTE_FAILURE_STATUSES = [
  'failed',
  'failure',
  'error',
  'cancelled',
  'canceled',
  'killed',
]
const DEFAULT_REMOTE_RECOVERY_RETRY_AFTER_MS = 60 * 1000
// Default compute status-poll interval used when a node declares poll.maxPolls
// but omits (or gives an invalid) intervalMs, so an unspecified interval no
// longer silently becomes a 0ms no-delay loop that hammers the backend. An
// explicit intervalMs (including 0 for deliberately fast polling) is respected.
const DEFAULT_COMPUTE_POLL_INTERVAL_MS = 5000

type NormalizedComputeLifecycle = {
  cancelOnWorkflowCancel: boolean
  reconcileOnResume: boolean
  poll?: {
    intervalMs: number
    maxPolls: number
    terminalStatuses: string[]
    failureStatuses: string[]
  }
}

export type ComputeLifecycleResult = {
  output: ComputeJobReceipt
  failureMessage?: string
  cancelled?: boolean
}

export type CancelComputeJobsInput = {
  runDir: string
  definition: MatOSWorkflowDefinition
  projectCwd: string
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>
  source?: string
  updateNodeOutput: (
    node: MatOSWorkflowNode,
    nodeRun: MatOSWorkflowNodeRunSnapshot,
    output: ComputeJobReceipt,
  ) => Promise<void>
}

export type ReconcileComputeJobsInput = CancelComputeJobsInput & {
  source?: string
}

export type CancelledComputeJobSummary = {
  nodeId: string
  backend?: string
  taskId: string
  status?: string
  source: string
  error?: string
}

export type ReconciledComputeJobSummary = {
  nodeId: string
  backend?: string
  taskId: string
  status?: string
  logFetched: boolean
  source: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    : []
}

function normalizedStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : undefined
}

function normalizeStatusList(value: unknown, defaults: string[]): string[] {
  const normalized = normalizedStringList(value)
    .map(item => normalizedStatus(item))
    .filter((item): item is string => Boolean(item))
  return normalized.length > 0 ? normalized : defaults
}

function rawComputeLifecycle(
  node: MatOSWorkflowNode,
): Record<string, unknown> | undefined {
  if (isRecord(node.lifecycle)) {
    return node.lifecycle
  }
  if (isRecord(node.computeLifecycle)) {
    return node.computeLifecycle
  }
  return undefined
}

function nodeOperation(node: MatOSWorkflowNode): string {
  return typeof node.operation === 'string' ? node.operation.trim().toLowerCase() : ''
}

function nodeToolRef(node: MatOSWorkflowNode): string {
  return typeof node.tool === 'string' ? node.tool.trim().toLowerCase() : ''
}

function effectiveComputeLifecycle(
  node: MatOSWorkflowNode,
): Record<string, unknown> | undefined {
  const raw = rawComputeLifecycle(node)
  if (raw) {
    return raw
  }
  return undefined
}

/**
 * Remote cancel/reconcile applies to compute nodes,
 * and to generic `backend` nodes that declare a lifecycle block. Generic
 * backends opt in by setting `lifecycle.reconcileOnResume` /
 * `lifecycle.cancelOnWorkflowCancel` and may bind backend-specific
 * reconciliation adapter tools through `lifecycle.statusTool` /
 * `lifecycle.cancelTool` / `lifecycle.logsTool`.
 */
export function workflowNodeSupportsRemoteLifecycle(
  node: MatOSWorkflowNode,
): boolean {
  if (node.targetType === 'compute' || node.type === 'compute') {
    return true
  }
  return node.type === 'backend' && effectiveComputeLifecycle(node) !== undefined
}

function lifecycleOperationTool(
  node: MatOSWorkflowNode,
  operation: string,
): string | undefined {
  const raw = effectiveComputeLifecycle(node)
  if (!raw) {
    return undefined
  }
  const key =
    operation === 'status'
      ? 'statusTool'
      : operation === 'cancel'
        ? 'cancelTool'
        : operation === 'logs'
          ? 'logsTool'
          : undefined
  const value = key ? raw[key] : undefined
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function computeLifecycleForNode(
  node: MatOSWorkflowNode,
): NormalizedComputeLifecycle | undefined {
  const raw = effectiveComputeLifecycle(node)
  if (!raw) {
    return undefined
  }
  const poll = isRecord(raw.poll) ? raw.poll : undefined
  const maxPolls =
    typeof poll?.maxPolls === 'number' &&
    Number.isFinite(poll.maxPolls) &&
    poll.maxPolls > 0
      ? Math.floor(poll.maxPolls)
      : undefined
  const intervalMs =
    poll?.intervalMs === undefined
      ? DEFAULT_COMPUTE_POLL_INTERVAL_MS
      : typeof poll.intervalMs === 'number' &&
          Number.isFinite(poll.intervalMs) &&
          poll.intervalMs >= 0
        ? Math.floor(poll.intervalMs)
        : DEFAULT_COMPUTE_POLL_INTERVAL_MS

  return {
    cancelOnWorkflowCancel: raw.cancelOnWorkflowCancel === true,
    reconcileOnResume: raw.reconcileOnResume === true,
    ...(poll && maxPolls
      ? {
          poll: {
            intervalMs,
            maxPolls,
            terminalStatuses: normalizeStatusList(
              poll.terminalStatuses,
              DEFAULT_COMPUTE_TERMINAL_STATUSES,
            ),
            failureStatuses: normalizeStatusList(
              poll.failureStatuses,
              DEFAULT_COMPUTE_FAILURE_STATUSES,
            ),
          },
        }
      : {}),
  }
}

function remoteRecoveryRetryAfterMs(
  node: MatOSWorkflowNode,
  kind: 'cancel' | 'reconcile',
): number {
  const lifecycle = rawComputeLifecycle(node) ?? {}
  const configured = Number(
    kind === 'cancel'
      ? lifecycle.cancelRetryAfterMs ??
          lifecycle.remoteRetryAfterMs ??
          lifecycle.retryAfterMs
      : lifecycle.reconcileRetryAfterMs ??
          lifecycle.remoteRetryAfterMs ??
          lifecycle.retryAfterMs,
  )
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_REMOTE_RECOVERY_RETRY_AFTER_MS
}

function nextRetryAtFromMs(retryAfterMs: number): string {
  return new Date(Date.now() + retryAfterMs).toISOString()
}

function computeReceiptReachedKnownStatus(
  receipt: ComputeJobReceipt,
  lifecycle?: NormalizedComputeLifecycle,
): boolean {
  return (
    receiptMatchesStatus(
      receipt,
      lifecycle?.poll?.terminalStatuses ?? DEFAULT_COMPUTE_TERMINAL_STATUSES,
    ) ||
    receiptMatchesStatus(
      receipt,
      lifecycle?.poll?.failureStatuses ?? DEFAULT_COMPUTE_FAILURE_STATUSES,
    )
  )
}

function receiptPayloadRecord(receipt: ComputeJobReceipt): Record<string, unknown> {
  return isRecord(receipt.payload) ? receipt.payload : {}
}

function computeReceiptStatusTokens(receipt: ComputeJobReceipt): string[] {
  const payload = receiptPayloadRecord(receipt)
  return [
    receipt.status,
    payload.status,
    payload.state,
    payload.phase,
    payload.taskStatus,
  ]
    .map(item => normalizedStatus(item))
    .filter((item): item is string => Boolean(item))
}

function receiptMatchesStatus(
  receipt: ComputeJobReceipt,
  statuses: string[],
): boolean {
  const expected = new Set(statuses)
  return computeReceiptStatusTokens(receipt).some(status => expected.has(status))
}

function computeReceiptTaskId(receipt: ComputeJobReceipt): string | undefined {
  return receipt.taskId ?? receipt.jobId
}

function computeStatusTimelineEntry(
  source: string,
  receipt: ComputeJobReceipt | undefined,
  fallbackStatus?: string,
): NonNullable<ComputeJobReceipt['statusTimeline']>[number] | undefined {
  if (!receipt && !fallbackStatus) {
    return undefined
  }
  return {
    at: new Date().toISOString(),
    source,
    ...(receipt?.status ?? fallbackStatus ? { status: receipt?.status ?? fallbackStatus } : {}),
    ...(receipt?.phase ? { phase: receipt.phase } : {}),
    ...(receipt?.toolRef ? { message: receipt.toolRef } : {}),
  }
}

function mergeStatusTimelines(
  ...groups: Array<ComputeJobReceipt['statusTimeline'] | undefined>
): NonNullable<ComputeJobReceipt['statusTimeline']> | undefined {
  const entries = groups.flatMap(group => group ?? [])
  return entries.length > 0 ? entries : undefined
}

function computeOperationNode(
  node: MatOSWorkflowNode,
  operation: string,
  input: Record<string, unknown>,
): MatOSWorkflowNode {
  const { tool: _tool, ...rest } = node
  const adapterTool = lifecycleOperationTool(node, operation)
  return {
    ...rest,
    ...(adapterTool ? { tool: adapterTool } : {}),
    operation,
    input,
  }
}

async function runComputeToolOperation(
  node: MatOSWorkflowNode,
  operation: string,
  input: Record<string, unknown>,
  options: { cwd: string },
): Promise<ComputeJobReceipt> {
  const operationNode = computeOperationNode(node, operation, input)
  const result = await runWorkflowBackendNode(operationNode, options)
  return computeJobReceiptFromBackendOutput(
    computeJobSpecForNode(operationNode),
    result.output,
  )
}

function mergeComputeLifecycleOutput(
  base: ComputeJobReceipt,
  patch: {
    statusReceipt?: ComputeJobReceipt
    logsReceipt?: ComputeJobReceipt
    statusHistory?: ComputeJobReceipt[]
    reconcile?: {
      source: string
      taskId: string
    }
  },
): ComputeJobReceipt {
  const statusReceipt = patch.statusReceipt
  const logsReceipt = patch.logsReceipt
  const lifecycle = isRecord(base.diagnostics.lifecycle)
    ? base.diagnostics.lifecycle
    : {}
  const statusHistoryTimeline = (patch.statusHistory ?? []).flatMap(receipt =>
    receipt.statusTimeline ?? [computeStatusTimelineEntry('status', receipt)].filter(
      (entry): entry is NonNullable<ComputeJobReceipt['statusTimeline']>[number] => Boolean(entry),
    ),
  )
  const logsTimeline = logsReceipt
    ? logsReceipt.statusTimeline ?? [computeStatusTimelineEntry('logs', logsReceipt, 'logs_fetched')].filter(
        (entry): entry is NonNullable<ComputeJobReceipt['statusTimeline']>[number] => Boolean(entry),
      )
    : undefined
  const reconcileTimeline = patch.reconcile
    ? [computeStatusTimelineEntry('reconcile', statusReceipt, statusReceipt?.status ?? 'reconciled')].filter(
        (entry): entry is NonNullable<ComputeJobReceipt['statusTimeline']>[number] => Boolean(entry),
      )
    : undefined
  return {
    ...base,
    ...(statusReceipt?.status ? { status: statusReceipt.status } : {}),
    ...(statusReceipt?.phase ? { phase: statusReceipt.phase } : {}),
    ...(statusReceipt?.jobId ? { jobId: statusReceipt.jobId } : {}),
    ...(statusReceipt?.taskId ? { taskId: statusReceipt.taskId } : {}),
    ...(statusReceipt?.artifacts && statusReceipt.artifacts.length > 0
      ? { artifacts: [...base.artifacts, ...statusReceipt.artifacts] }
      : {}),
    ...(mergeStatusTimelines(
      base.statusTimeline,
      statusReceipt?.statusTimeline,
      statusHistoryTimeline,
      logsTimeline,
      reconcileTimeline,
    )
      ? {
          statusTimeline: mergeStatusTimelines(
            base.statusTimeline,
            statusReceipt?.statusTimeline,
            statusHistoryTimeline,
            logsTimeline,
            reconcileTimeline,
          ),
        }
      : {}),
    ...(patch.reconcile
      ? { reconcileState: statusReceipt?.ok === false ? 'failed' as const : 'ok' as const }
      : {}),
    ...(logsReceipt?.logs ? { logs: logsReceipt.logs } : {}),
    ...(logsReceipt?.artifactBundles?.length
      ? { artifactBundles: [...(base.artifactBundles ?? []), ...logsReceipt.artifactBundles] }
      : {}),
    diagnostics: {
      ...base.diagnostics,
      lifecycle: {
        ...lifecycle,
        statusHistory: patch.statusHistory ?? [],
        ...(statusReceipt ? { terminalStatus: statusReceipt.status } : {}),
        ...(patch.reconcile
          ? {
              reconcile: {
                ok: statusReceipt?.ok ?? true,
                source: patch.reconcile.source,
                taskId: patch.reconcile.taskId,
                ...(statusReceipt?.status ? { status: statusReceipt.status } : {}),
                ...(statusReceipt?.toolRef ? { toolRef: statusReceipt.toolRef } : {}),
                recordedAt: new Date().toISOString(),
              },
            }
          : {}),
        ...(logsReceipt
          ? {
              logs: {
                ok: logsReceipt.ok,
                toolRef: logsReceipt.toolRef,
                payload: logsReceipt.payload,
              },
            }
          : {}),
      },
    },
    ...(statusReceipt?.payload
      ? {
          payload: {
            ...receiptPayloadRecord(base),
            latestStatus: statusReceipt.payload,
          },
        }
      : {}),
  }
}

async function fetchComputeLogsForReceipt(
  runDir: string,
  node: MatOSWorkflowNode,
  taskId: string,
  options: { cwd: string },
): Promise<ComputeJobReceipt | undefined> {
  // Logs are supplementary evidence. A transient logs-API failure must never
  // fail a node whose remote job already reached its terminal status.
  try {
    const logsReceipt = await runComputeToolOperation(
      node,
      'logs',
      { taskId },
      options,
    )
    await appendWorkflowEvent(runDir, {
      type: 'workflow.compute.logs',
      data: {
        nodeId: node.id,
        backend: node.backend,
        toolRef: logsReceipt.toolRef,
        output: logsReceipt,
      },
    })
    return logsReceipt
  } catch (error) {
    await appendWorkflowEvent(runDir, {
      type: 'workflow.compute.logs_error',
      data: {
        nodeId: node.id,
        backend: node.backend,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return undefined
  }
}

export async function runComputePostSubmitLifecycle(
  runDir: string,
  node: MatOSWorkflowNode,
  submitReceipt: ComputeJobReceipt,
  options: { cwd: string },
): Promise<ComputeLifecycleResult> {
  if (submitReceipt.operation !== 'submit') {
    return { output: submitReceipt }
  }
  const lifecycle = computeLifecycleForNode(node)
  if (!lifecycle?.poll) {
    return { output: submitReceipt }
  }
  const taskId = computeReceiptTaskId(submitReceipt)
  if (!taskId) {
    return { output: submitReceipt }
  }

  const statusHistory: ComputeJobReceipt[] = []
  let latestStatus: ComputeJobReceipt | undefined
  // Tolerate transient status-poll failures: one flaky poll must not fail
  // the node while the remote job is still running (a configured node retry
  // would then re-submit a duplicate job and orphan the live one). Only give
  // up after several consecutive failures, which indicates the backend
  // itself is broken rather than a blip.
  const maxConsecutiveStatusFailures = Math.max(
    1,
    Math.min(5, lifecycle.poll.maxPolls),
  )
  let consecutiveStatusFailures = 0
  for (let pollIndex = 0; pollIndex < lifecycle.poll.maxPolls; pollIndex += 1) {
    let remainingDelay = pollIndex > 0 ? lifecycle.poll.intervalMs : 0
    while (remainingDelay > 0) {
      if (await computeLifecycleCancellationRequested(runDir)) {
        break
      }
      const stepMs = Math.min(remainingDelay, 250)
      await delay(stepMs)
      remainingDelay -= stepMs
    }
    if (await computeLifecycleCancellationRequested(runDir)) {
      const persistedReceipt = computeReceiptFromNodeOutput(
        (await readNodeRun(runDir, node.id))?.output,
      )
      if (
        persistedReceipt?.cancelState === 'ok' ||
        (persistedReceipt &&
          receiptMatchesStatus(persistedReceipt, [
            'cancelled',
            'canceled',
            'killed',
          ]))
      ) {
        return { output: persistedReceipt, cancelled: true }
      }
      if (!lifecycle.cancelOnWorkflowCancel) {
        return { output: submitReceipt, cancelled: true }
      }
      try {
        const cancelReceipt = await runComputeToolOperation(
          node,
          'cancel',
          { taskId },
          options,
        )
        const output = mergeComputeCancelOutput(submitReceipt, cancelReceipt)
        await appendWorkflowEvent(runDir, {
          type: 'workflow.compute.cancelled',
          data: {
            nodeId: node.id,
            backend: node.backend,
            toolRef: cancelReceipt.toolRef,
            source: 'cooperative_cancel',
            output: cancelReceipt,
          },
        })
        return { output, cancelled: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const output = mergeComputeCancelFailureOutput(submitReceipt, {
          taskId,
          error: message,
          retryAfterMs: remoteRecoveryRetryAfterMs(node, 'cancel'),
        })
        await appendWorkflowEvent(runDir, {
          type: 'workflow.compute.cancel_failed',
          data: {
            nodeId: node.id,
            backend: node.backend,
            taskId,
            source: 'cooperative_cancel',
            error: message,
          },
        })
        return { output, cancelled: true }
      }
    }
    let polledStatus: ComputeJobReceipt
    try {
      polledStatus = await runComputeToolOperation(
        node,
        'status',
        { taskId },
        options,
      )
      consecutiveStatusFailures = 0
    } catch (error) {
      consecutiveStatusFailures += 1
      const message = error instanceof Error ? error.message : String(error)
      await appendWorkflowEvent(runDir, {
        type: 'workflow.compute.status_error',
        data: {
          nodeId: node.id,
          backend: node.backend,
          taskId,
          poll: pollIndex + 1,
          consecutiveFailures: consecutiveStatusFailures,
          error: message,
        },
      })
      if (consecutiveStatusFailures >= maxConsecutiveStatusFailures) {
        throw new Error(
          `Compute status poll failed ${consecutiveStatusFailures} times in a row for ${taskId}: ${message}. ` +
            'The remote job may still be running; inspect it before retrying this node (a retry submits a new job).',
        )
      }
      continue
    }
    latestStatus = polledStatus
    statusHistory.push(latestStatus)
    await appendWorkflowEvent(runDir, {
      type: 'workflow.compute.status',
      data: {
        nodeId: node.id,
        backend: node.backend,
        toolRef: latestStatus.toolRef,
        poll: pollIndex + 1,
        output: latestStatus,
      },
    })

    if (receiptMatchesStatus(latestStatus, lifecycle.poll.failureStatuses)) {
      const logsReceipt = await fetchComputeLogsForReceipt(
        runDir,
        node,
        taskId,
        options,
      )
      const output = mergeComputeLifecycleOutput(submitReceipt, {
        statusReceipt: latestStatus,
        logsReceipt,
        statusHistory,
      })
      await appendWorkflowEvent(runDir, {
        type: 'workflow.compute.failed',
        data: {
          nodeId: node.id,
          backend: node.backend,
          output,
        },
      })
      return {
        output,
        failureMessage: `Compute job failed: ${taskId} (${latestStatus.status ?? 'unknown status'})`,
      }
    }

    if (receiptMatchesStatus(latestStatus, lifecycle.poll.terminalStatuses)) {
      const logsReceipt = await fetchComputeLogsForReceipt(
        runDir,
        node,
        taskId,
        options,
      )
      const output = mergeComputeLifecycleOutput(submitReceipt, {
        statusReceipt: latestStatus,
        logsReceipt,
        statusHistory,
      })
      await appendWorkflowEvent(runDir, {
        type: 'workflow.compute.completed',
        data: {
          nodeId: node.id,
          backend: node.backend,
          output,
        },
      })
      return { output }
    }
  }

  const logsReceipt = await fetchComputeLogsForReceipt(
    runDir,
    node,
    taskId,
    options,
  )
  const output = mergeComputeLifecycleOutput(submitReceipt, {
    statusReceipt: latestStatus,
    logsReceipt,
    statusHistory,
  })
  await appendWorkflowEvent(runDir, {
    type: 'workflow.compute.failed',
    data: {
      nodeId: node.id,
      backend: node.backend,
      output,
      reason: 'poll timeout',
    },
  })
  return {
    output,
    failureMessage: `Compute job did not reach a terminal status after ${lifecycle.poll.maxPolls} polls: ${taskId}`,
  }
}

async function computeLifecycleCancellationRequested(
  runDir: string,
): Promise<boolean> {
  if ((await readWorkflowRunControlAction(runDir)) === 'cancel') {
    return true
  }
  return (await readWorkflowRun(runDir)).status === 'cancelled'
}

function computeReceiptFromNodeOutput(
  output: unknown,
): ComputeJobReceipt | undefined {
  if (!isRecord(output)) {
    return undefined
  }
  const payload = isRecord(output.payload) ? output.payload : {}
  const backend = typeof output.backend === 'string' ? output.backend : undefined
  const taskId =
    typeof output.taskId === 'string'
      ? output.taskId
      : typeof payload.taskId === 'string'
        ? payload.taskId
        : undefined
  const jobId =
    typeof output.jobId === 'string'
      ? output.jobId
      : typeof payload.jobId === 'string'
        ? payload.jobId
        : undefined
  if (!backend || (!taskId && !jobId)) {
    return undefined
  }
  return {
    ...(output as ComputeJobReceipt),
    ...(taskId ? { taskId } : {}),
    ...(jobId ? { jobId } : {}),
    artifacts: Array.isArray(output.artifacts)
      ? (output.artifacts as ComputeJobReceipt['artifacts'])
      : [],
    diagnostics: isRecord(output.diagnostics) ? output.diagnostics : {},
  }
}

function mergeComputeCancelOutput(
  base: ComputeJobReceipt,
  cancelReceipt: ComputeJobReceipt,
): ComputeJobReceipt {
  const lifecycle = isRecord(base.diagnostics.lifecycle)
    ? base.diagnostics.lifecycle
    : {}
  return {
    ...base,
    ...(cancelReceipt.status ? { status: cancelReceipt.status } : {}),
    ...(cancelReceipt.phase ? { phase: cancelReceipt.phase } : {}),
    cancelState: cancelReceipt.ok ? 'ok' : 'failed',
    ...(mergeStatusTimelines(
      base.statusTimeline,
      cancelReceipt.statusTimeline,
      [computeStatusTimelineEntry('cancel', cancelReceipt, cancelReceipt.status ?? 'cancelled')].filter(
        (entry): entry is NonNullable<ComputeJobReceipt['statusTimeline']>[number] => Boolean(entry),
      ),
    )
      ? {
          statusTimeline: mergeStatusTimelines(
            base.statusTimeline,
            cancelReceipt.statusTimeline,
            [computeStatusTimelineEntry('cancel', cancelReceipt, cancelReceipt.status ?? 'cancelled')].filter(
              (entry): entry is NonNullable<ComputeJobReceipt['statusTimeline']>[number] => Boolean(entry),
            ),
          ),
        }
      : {}),
    diagnostics: {
      ...base.diagnostics,
      lifecycle: {
        ...lifecycle,
        cancel: {
          ok: cancelReceipt.ok,
          toolRef: cancelReceipt.toolRef,
          payload: cancelReceipt.payload,
        },
      },
    },
    payload: {
      ...receiptPayloadRecord(base),
      cancellation: cancelReceipt.payload,
    },
  }
}

function mergeComputeCancelFailureOutput(
  base: ComputeJobReceipt,
  failure: {
    taskId: string
    error: string
    retryAfterMs: number
  },
): ComputeJobReceipt {
  const lifecycle = isRecord(base.diagnostics.lifecycle)
    ? base.diagnostics.lifecycle
    : {}
  const existingFailures = Array.isArray(lifecycle.cancelFailures)
    ? lifecycle.cancelFailures.filter(isRecord)
    : []
  return {
    ...base,
    cancelState: 'failed',
    ...(mergeStatusTimelines(
      base.statusTimeline,
      [{
        at: new Date().toISOString(),
        source: 'cancel',
        status: 'failed',
        message: failure.error,
      }],
    )
      ? {
          statusTimeline: mergeStatusTimelines(
            base.statusTimeline,
            [{
              at: new Date().toISOString(),
              source: 'cancel',
              status: 'failed',
              message: failure.error,
            }],
          ),
        }
      : {}),
    diagnostics: {
      ...base.diagnostics,
      lifecycle: {
        ...lifecycle,
        cancelFailures: [
          ...existingFailures,
          {
            taskId: failure.taskId,
            error: failure.error,
            recordedAt: new Date().toISOString(),
            retryAfterMs: failure.retryAfterMs,
            nextRetryAt: nextRetryAtFromMs(failure.retryAfterMs),
          },
        ],
      },
    },
  }
}

function mergeComputeReconcileFailureOutput(
  base: ComputeJobReceipt,
  failure: {
    source: string
    taskId: string
    error: string
    retryAfterMs: number
  },
): ComputeJobReceipt {
  const lifecycle = isRecord(base.diagnostics.lifecycle)
    ? base.diagnostics.lifecycle
    : {}
  const existingFailures = Array.isArray(lifecycle.reconcileFailures)
    ? lifecycle.reconcileFailures.filter(isRecord)
    : []
  return {
    ...base,
    reconcileState: 'failed',
    ...(mergeStatusTimelines(
      base.statusTimeline,
      [{
        at: new Date().toISOString(),
        source: 'reconcile',
        status: 'failed',
        message: failure.error,
      }],
    )
      ? {
          statusTimeline: mergeStatusTimelines(
            base.statusTimeline,
            [{
              at: new Date().toISOString(),
              source: 'reconcile',
              status: 'failed',
              message: failure.error,
            }],
          ),
        }
      : {}),
    diagnostics: {
      ...base.diagnostics,
      lifecycle: {
        ...lifecycle,
        reconcileFailures: [
          ...existingFailures,
          {
            source: failure.source,
            taskId: failure.taskId,
            error: failure.error,
            recordedAt: new Date().toISOString(),
            retryAfterMs: failure.retryAfterMs,
            nextRetryAt: nextRetryAtFromMs(failure.retryAfterMs),
          },
        ],
      },
    },
  }
}

export async function cancelComputeJobsForWorkflowRun(
  input: CancelComputeJobsInput,
): Promise<CancelledComputeJobSummary[]> {
  const cancelled: CancelledComputeJobSummary[] = []
  const source = input.source ?? 'workflow_cancel'
  for (const node of input.definition.nodes) {
    if (!workflowNodeSupportsRemoteLifecycle(node)) {
      continue
    }
    const lifecycle = computeLifecycleForNode(node)
    if (!lifecycle?.cancelOnWorkflowCancel) {
      continue
    }
    const nodeRun = input.nodeRuns.get(node.id)
    const receipt = computeReceiptFromNodeOutput(nodeRun?.output)
    const taskId = receipt ? computeReceiptTaskId(receipt) : undefined
    if (!nodeRun || !receipt || !taskId) {
      continue
    }
    if (
      receipt.cancelState === 'ok' ||
      receiptMatchesStatus(receipt, ['cancelled', 'canceled', 'killed'])
    ) {
      continue
    }

    try {
      const cancelReceipt = await runComputeToolOperation(
        node,
        'cancel',
        { taskId },
        { cwd: input.projectCwd },
      )
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.compute.cancelled',
        data: {
          nodeId: node.id,
          backend: node.backend,
          toolRef: cancelReceipt.toolRef,
          source,
          output: cancelReceipt,
        },
      })
      await input.updateNodeOutput(
        node,
        nodeRun,
        mergeComputeCancelOutput(receipt, cancelReceipt),
      )
      cancelled.push({
        nodeId: node.id,
        ...(typeof node.backend === 'string' ? { backend: node.backend } : {}),
        taskId,
        ...(cancelReceipt.status ? { status: cancelReceipt.status } : {}),
        source,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.compute.cancel_failed',
        data: {
          nodeId: node.id,
          backend: node.backend,
          taskId,
          source,
          error: message,
        },
      })
      await input.updateNodeOutput(
        node,
        nodeRun,
        mergeComputeCancelFailureOutput(receipt, {
          taskId,
          error: message,
          retryAfterMs: remoteRecoveryRetryAfterMs(node, 'cancel'),
        }),
      )
      cancelled.push({
        nodeId: node.id,
        ...(typeof node.backend === 'string' ? { backend: node.backend } : {}),
        taskId,
        source,
        error: message,
      })
    }
  }
  return cancelled
}

export async function reconcileComputeJobsForWorkflowRun(
  input: ReconcileComputeJobsInput,
): Promise<ReconciledComputeJobSummary[]> {
  const reconciled: ReconciledComputeJobSummary[] = []
  const source = input.source ?? 'resume_reconcile'
  for (const node of input.definition.nodes) {
    if (!workflowNodeSupportsRemoteLifecycle(node)) {
      continue
    }
    const lifecycle = computeLifecycleForNode(node)
    if (!lifecycle?.reconcileOnResume) {
      continue
    }
    const nodeRun = input.nodeRuns.get(node.id)
    const receipt = computeReceiptFromNodeOutput(nodeRun?.output)
    const taskId = receipt ? computeReceiptTaskId(receipt) : undefined
    // Compute receipts always carry `operation`; generic backend outputs may
    // not, so only skip when the receipt explicitly says it was not a submit.
    if (
      !nodeRun ||
      !receipt ||
      !taskId ||
      (receipt.operation !== undefined && receipt.operation !== 'submit') ||
      computeReceiptReachedKnownStatus(receipt, lifecycle)
    ) {
      continue
    }
    const backend = typeof node.backend === 'string' ? node.backend : undefined

    try {
      const statusReceipt = await runComputeToolOperation(
        node,
        'status',
        { taskId },
        { cwd: input.projectCwd },
      )
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.compute.status',
        data: {
          nodeId: node.id,
          backend,
          toolRef: statusReceipt.toolRef,
          output: statusReceipt,
          source,
        },
      })
      const logsReceipt = computeReceiptReachedKnownStatus(statusReceipt, lifecycle)
        ? await fetchComputeLogsForReceipt(
            input.runDir,
            node,
            taskId,
            { cwd: input.projectCwd },
          )
        : undefined
      const output = mergeComputeLifecycleOutput(receipt, {
        statusReceipt,
        logsReceipt,
        statusHistory: [statusReceipt],
        reconcile: { source, taskId },
      })
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.compute.reconciled',
        data: {
          nodeId: node.id,
          backend,
          taskId,
          output,
        },
      })
      await input.updateNodeOutput(node, nodeRun, output)
      reconciled.push({
        nodeId: node.id,
        backend,
        taskId,
        status: output.status,
        logFetched: Boolean(logsReceipt),
        source,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.compute.reconcile_failed',
        data: {
          nodeId: node.id,
          backend,
          taskId,
          error: message,
        },
      })
      await input.updateNodeOutput(
        node,
        nodeRun,
        mergeComputeReconcileFailureOutput(receipt, {
          source,
          taskId,
          error: message,
          retryAfterMs: remoteRecoveryRetryAfterMs(node, 'reconcile'),
        }),
      )
      reconciled.push({
        nodeId: node.id,
        backend,
        taskId,
        logFetched: false,
        source,
        error: message,
      })
    }
  }
  return reconciled
}
