import { dirname, join } from 'node:path'
import { resolvePinnedChildWorkflow } from '../childWorkflowSnapshot.js'
import { readJson } from '../jsonIo.js'
import { readWorkflowRun } from '../workflowStore.js'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from '../types.js'
import type { ResumeChildWorkflowRun, WorkflowRunView } from '../runtimeTypes.js'

export type SubworkflowRunInput = {
  workflowsDir: string
  workflowRef: string
  parameters?: Record<string, unknown>
  definition: MatOSWorkflowDefinition
  workspaceDir: string
  cwd?: string
  onCreated?: (run: { runId: string; runDir: string }) => void | Promise<void>
}

export type SubworkflowNodeResult = {
  childRun: WorkflowRunView
  workflowRef: string
  output: {
    childRunId: string
    status: string
    outputs: Record<string, unknown>
  }
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  return []
}

function selectedOutputs(
  outputs: Record<string, unknown>,
  selection: string[],
): Record<string, unknown> {
  if (selection.length === 0) {
    return outputs
  }
  const selected: Record<string, unknown> = {}
  for (const key of selection) {
    if (key in outputs) {
      selected[key] = outputs[key]
    }
  }
  return selected
}

/**
 * Build the subworkflow node output for a child run outcome. Shared by the
 * normal blocking executor and by crash recovery (resumeWorkflowRun), which
 * adopts the result of an already-persisted child run instead of starting a
 * duplicate one, so both paths shape outputs identically.
 */
export function workflowSubworkflowNodeOutputForChildRun(
  node: MatOSWorkflowNode,
  child: {
    runId: string
    status: string
    outputs: Record<string, unknown> | undefined
  },
): SubworkflowNodeResult['output'] {
  return {
    childRunId: child.runId,
    status: child.status,
    outputs: selectedOutputs(
      metadataObject(child.outputs),
      stringList(node.outputKeys ?? node.outputs),
    ),
  }
}

const NON_TERMINAL_CHILD_RUN_STATUSES = new Set([
  'created',
  'running',
  'paused',
  'waiting_input',
  'waiting_approval',
])

type PersistedChildRunMarker = {
  childRunId?: unknown
  workflowRef?: unknown
}

/**
 * The child run this node already spawned, when its persisted marker points
 * at a readable run directory. A re-executed node (explicit retry_node after
 * the child parked on a human gate, or a reset after crash recovery) must
 * adopt this run instead of spawning a duplicate: a duplicate repeats every
 * side effect the first child already performed and orphans it mid-flight.
 */
async function existingChildRunForNode(
  node: MatOSWorkflowNode,
  runDir: string,
  expectedWorkflowRef?: string,
): Promise<
  | { childRunDir: string; runId: string; status: string; outputs: Record<string, unknown> }
  | undefined
> {
  let marker: PersistedChildRunMarker
  try {
    marker = await readJson<PersistedChildRunMarker>(
      join(runDir, 'child-runs', `${node.id}.json`),
    )
  } catch {
    return undefined
  }
  const childRunId =
    typeof marker.childRunId === 'string' && marker.childRunId.trim()
      ? marker.childRunId.trim()
      : undefined
  if (!childRunId) {
    return undefined
  }
  const childRunDir = join(dirname(runDir), childRunId)
  try {
    const snapshot = await readWorkflowRun(childRunDir)
    // The marker only records "this node spawned that run". If the node's
    // workflow reference changed since (dynamic patch, republished draft),
    // adopting the old child would silently consume outputs from a different
    // workflow. Fall through to a fresh start instead.
    if (
      expectedWorkflowRef &&
      snapshot.workflowRef &&
      snapshot.workflowRef !== expectedWorkflowRef
    ) {
      return undefined
    }
    return {
      childRunDir,
      runId: snapshot.runId,
      status: snapshot.status,
      outputs: snapshot.outputs ?? {},
    }
  } catch {
    return undefined
  }
}

export async function runWorkflowSubworkflowNode(
  node: MatOSWorkflowNode,
  options: {
    cwd: string
    runDir: string
    workflowsDir: string
    workspaceDir: string
    startChildRun: (input: SubworkflowRunInput) => Promise<WorkflowRunView>
    resumeChildRun?: ResumeChildWorkflowRun
    onChildCreated?: (input: {
      childRunId: string
      childRunDir: string
      workflowRef: string
    }) => void | Promise<void>
  },
): Promise<SubworkflowNodeResult> {
  if (typeof node.workflow !== 'string' || node.workflow.trim().length === 0) {
    throw new Error(`Subworkflow node requires workflow: ${node.id}`)
  }

  const child = await resolvePinnedChildWorkflow({
    cwd: options.cwd,
    runDir: options.runDir,
    node,
  })

  // Adopt the persisted child run before starting a new one. A completed
  // child is consumed as-is; a still-active child (waiting on human
  // input/approval, paused, or interrupted) is advanced through resume —
  // which re-enters its own recovery — and its resulting state is consumed.
  // Only failed/cancelled children fall through to a fresh start: for them,
  // retrying the node means a new attempt.
  const existing = await existingChildRunForNode(
    node,
    options.runDir,
    child.workflowRef,
  )
  if (existing) {
    const outcome =
      NON_TERMINAL_CHILD_RUN_STATUSES.has(existing.status) && options.resumeChildRun
        ? await options.resumeChildRun(existing.childRunDir)
        : existing.status === 'completed'
          ? {
              runId: existing.runId,
              runDir: existing.childRunDir,
              status: existing.status,
              outputs: existing.outputs,
            }
          : undefined
    if (outcome) {
      return {
        childRun: outcome as WorkflowRunView,
        workflowRef: child.workflowRef,
        output: workflowSubworkflowNodeOutputForChildRun(node, {
          runId: outcome.runId,
          status: outcome.status,
          outputs: outcome.outputs,
        }),
      }
    }
  }

  const childRun = await options.startChildRun({
    workflowsDir: options.workflowsDir,
    workflowRef: child.workflowRef,
    parameters: metadataObject(node.parameters),
    definition: child.definition,
    workspaceDir: options.workspaceDir,
    cwd: options.cwd,
    onCreated: options.onChildCreated
      ? run =>
          options.onChildCreated?.({
            childRunId: run.runId,
            childRunDir: run.runDir,
            workflowRef: child.workflowRef,
          })
      : undefined,
  })
  return {
    childRun,
    workflowRef: child.workflowRef,
    output: workflowSubworkflowNodeOutputForChildRun(node, {
      runId: childRun.runId,
      status: childRun.status,
      outputs: childRun.outputs,
    }),
  }
}
