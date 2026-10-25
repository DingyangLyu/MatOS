import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJson, writeJson as writeJsonAtomic } from '../jsonIo.js'
import type { PinnedChildWorkflow } from '../childWorkflowSnapshot.js'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from '../types.js'
import type {
  ResumeChildWorkflowRun,
  WorkflowRunView,
} from '../runtimeTypes.js'

export type IterationWorkflowRunInput = {
  workflowsDir: string
  workflowRef: string
  parameters?: Record<string, unknown>
  definition: MatOSWorkflowDefinition
  workspaceDir: string
  cwd?: string
  onCreated?: (run: { runId: string; runDir: string }) => void | Promise<void>
}

export type IterationNodeResult = {
  output: Record<string, unknown>
  failureMessage?: string
  /**
   * True when a run cancel request stopped the iteration between child
   * rounds; the executor settles the node as cancelled instead of
   * completed/failed and the scheduler applies the pending cancel marker.
   */
  cancelled?: boolean
}

export type IterationNodeRunOptions = {
  cwd: string
  runDir: string
  workflowsDir: string
  workspaceDir: string
  startChildRun: (input: IterationWorkflowRunInput) => Promise<WorkflowRunView>
  /**
   * Lock-holding resume for adopting a persisted, still-active iteration
   * child (crash recovery / node retry) instead of spawning a duplicate.
   * Optional so direct adapter callers keep working; without it, only
   * completed persisted iterations can be consumed.
   */
  resumeChildRun?: ResumeChildWorkflowRun
}

/** Child-run statuses an iteration may adopt by resuming (not re-spawning). */
export const NON_TERMINAL_ITERATION_CHILD_STATUSES = new Set([
  'created',
  'running',
  'paused',
  'waiting_input',
  'waiting_approval',
])

export function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  return []
}

export function selectedOutputs(
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

// Atomic (temp+rename) like every other run-state write: iteration records
// feed crash recovery, cancel propagation (child-run refs), and budget
// rollups — a torn write mid-crash must not corrupt them.
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeJsonAtomic(path, value)
}

export async function writeIteration(input: {
  runDir: string
  nodeId: string
  index: number
  value: unknown
}): Promise<void> {
  await writeJson(
    join(
      input.runDir,
      'iterations',
      input.nodeId,
      String(input.index),
      'iteration.json',
    ),
    input.value,
  )
}

/**
 * Read a persisted iteration record (undefined when absent or unreadable).
 * Lets a re-executed map node adopt children that already completed instead
 * of re-launching every item.
 */
export async function readIteration(input: {
  runDir: string
  nodeId: string
  index: number
}): Promise<unknown> {
  try {
    return await readJson<unknown>(
      join(
        input.runDir,
        'iterations',
        input.nodeId,
        String(input.index),
        'iteration.json',
      ),
    )
  } catch {
    return undefined
  }
}

export async function writeIterationRetry(input: {
  runDir: string
  nodeId: string
  index: number
  retryAttempt: number
  value: unknown
}): Promise<void> {
  await writeJson(
    join(
      input.runDir,
      'iterations',
      input.nodeId,
      String(input.index),
      `retry-${String(input.retryAttempt).padStart(2, '0')}.json`,
    ),
    input.value,
  )
}

function roundId(index: number): string {
  return String(index).padStart(4, '0')
}

export async function writeRoundState(input: {
  runDir: string
  nodeId: string
  index: number
  inputs: Record<string, unknown>
  childRun: WorkflowRunView
  outputs: Record<string, unknown>
  decision: 'continue' | 'fail' | 'stop'
  reason: string
  retryAttempt?: number
}): Promise<void> {
  const baseDir = join(input.runDir, 'rounds', input.nodeId, roundId(input.index))
  const dir =
    input.retryAttempt === undefined
      ? baseDir
      : join(baseDir, `retry-${String(input.retryAttempt).padStart(2, '0')}`)
  await writeJson(join(dir, 'inputs.json'), {
    nodeId: input.nodeId,
    index: input.index,
    ...(input.retryAttempt === undefined ? {} : { retryAttempt: input.retryAttempt }),
    ...input.inputs,
  })
  await writeJson(join(dir, 'agent_outputs.json'), {
    childRunId: input.childRun.runId,
    status: input.childRun.status,
    outputs: input.outputs,
  })
  await writeJson(join(dir, 'validation.json'), {
    ok: input.childRun.status === 'completed',
    status: input.childRun.status,
  })
  await writeJson(join(dir, 'decision.json'), {
    decision: input.decision,
    reason: input.reason,
  })
  await writeFile(
    join(dir, 'summary.md'),
    [
      `# ${input.nodeId} round ${input.index}`,
      '',
      `status: ${input.childRun.status}`,
      `decision: ${input.decision}`,
      `reason: ${input.reason}`,
      `childRunId: ${input.childRun.runId}`,
      '',
    ].join('\n'),
    'utf8',
  )
}

export async function runIterationChild(input: {
  node: MatOSWorkflowNode
  child: PinnedChildWorkflow
  cwd: string
  workflowsDir: string
  workspaceDir: string
  parameters: Record<string, unknown>
  startChildRun: (child: IterationWorkflowRunInput) => Promise<WorkflowRunView>
  onCreated?: (run: { runId: string; runDir: string }) => void | Promise<void>
}): Promise<WorkflowRunView> {
  if (typeof input.node.workflow !== 'string' || !input.node.workflow.trim()) {
    throw new Error(`Iteration node requires workflow: ${input.node.id}`)
  }
  return input.startChildRun({
    cwd: input.cwd,
    workflowsDir: input.workflowsDir,
    workflowRef: input.child.workflowRef,
    parameters: input.parameters,
    definition: input.child.definition,
    workspaceDir: input.workspaceDir,
    onCreated: input.onCreated,
  })
}
