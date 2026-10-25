import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  appendWorkflowEvent,
  readWorkflowRun,
  writeWorkflowRun,
} from './workflowStore.js'
import { nextStateMachineTransition } from './stateMachineScheduler.js'
import {
  appendWorkflowTransitionRecord,
  listWorkflowFrames,
  readFrameNodeRun,
  writeFrameNodeRun,
  writeWorkflowFrame,
} from './stateMachineStore.js'
import { reduceStateMachineState } from './stateMachineReducers.js'
import { frameId, transitionId } from './stateMachineTypes.js'
import { enforceWorkflowBudget } from './budget.js'
import { resolveWorkflowTemplateValue } from './workflowExpressions.js'
import {
  adviseWorkflowReadySet,
  redactWorkflowControllerFailureText,
} from './runObservers.js'
import { workflowControllerFailureMode } from '../algorithms/controllerBinding.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowFrameSnapshot,
  MatOSWorkflowFrameStatus,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowTransitionEdge,
} from './types.js'
import {
  cancelWorkflowRun,
  inspectWorkflowRun,
  pauseWorkflowRun,
  runWorkflowSingleNode,
  tickControllerAfterWorkflowFailure,
  type WorkflowDynamicPlannerRunner,
  type WorkflowRunView,
} from './workflowRuntime.js'
import {
  readWorkflowRunControlAction,
} from './workflowControl.js'
import { workflowRunLocalProcessCancelRequested } from './localProcessLifecycle.js'

function nowIso(): string {
  return new Date().toISOString()
}

function terminalFrameStatus(
  status: MatOSWorkflowNodeRunSnapshot['status'],
): MatOSWorkflowFrameStatus {
  if (status === 'waiting_input') {
    return 'waiting_input'
  }
  if (status === 'waiting_approval') {
    return 'waiting_approval'
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'failed'
  }
  if (status === 'completed' || status === 'skipped') {
    return 'completed'
  }
  return 'running'
}

function transitionById(
  definition: MatOSWorkflowDefinition,
  id: string | undefined,
): MatOSWorkflowTransitionEdge | undefined {
  if (!id) {
    return undefined
  }
  return (definition.transitions ?? []).find(
    transition => transitionId(transition) === id,
  )
}

function transitionCounts(
  frames: MatOSWorkflowFrameSnapshot[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const frame of frames) {
    if (!frame.transitionEdgeId) {
      continue
    }
    counts.set(frame.transitionEdgeId, (counts.get(frame.transitionEdgeId) ?? 0) + 1)
  }
  return counts
}

function selectedTransitionCount(frames: MatOSWorkflowFrameSnapshot[]): number {
  return frames.filter(frame => Boolean(frame.transitionEdgeId)).length
}

async function readLatestNodeRun(
  runDir: string,
  nodeId: string,
): Promise<MatOSWorkflowNodeRunSnapshot | undefined> {
  try {
    return JSON.parse(
      await readFile(join(runDir, 'node-runs', nodeId, 'node-run.json'), 'utf8'),
    ) as MatOSWorkflowNodeRunSnapshot
  } catch {
    return undefined
  }
}

async function readFrameOrLatestNodeRun(
  runDir: string,
  frame: MatOSWorkflowFrameSnapshot,
): Promise<MatOSWorkflowNodeRunSnapshot | undefined> {
  const latest = await readLatestNodeRun(runDir, frame.activeNodeId)
  if (latest) {
    return latest
  }
  try {
    const nodeRun = await readFrameNodeRun<MatOSWorkflowNodeRunSnapshot>(
      runDir,
      frame.index,
    )
    return {
      ...nodeRun,
      nodeId: frame.activeNodeId,
    }
  } catch {
    return undefined
  }
}

async function resolveStateMachineOutputs(input: {
  definition: MatOSWorkflowDefinition
  frames: MatOSWorkflowFrameSnapshot[]
  parameters: Record<string, unknown>
  state: Record<string, unknown>
  finalNodeId: string
  runDir: string
  runId: string
  artifactRoot?: string
  workflowRef: string
}): Promise<Record<string, unknown>> {
  const nodeRuns = new Map<string, MatOSWorkflowNodeRunSnapshot>()
  for (const frame of input.frames) {
    try {
      const nodeRun = await readFrameNodeRun<MatOSWorkflowNodeRunSnapshot>(
        input.runDir,
        frame.index,
      )
      nodeRuns.set(frame.activeNodeId, {
        ...nodeRun,
        nodeId: frame.activeNodeId,
      })
    } catch {
      continue
    }
  }
  const workflow = {
    state: input.state,
    finalNodeId: input.finalNodeId,
    artifactRoot: input.artifactRoot,
    runDir: input.runDir,
    runId: input.runId,
    workflowRef: input.workflowRef,
  }
  const outputs: Record<string, unknown> = {}
  for (const [key, output] of Object.entries(input.definition.outputs)) {
    outputs[key] = resolveWorkflowTemplateValue(output.value ?? output, {
      nodeRuns,
      parameters: input.parameters,
      workflow,
    })
  }
  if (!Object.prototype.hasOwnProperty.call(outputs, 'state')) {
    outputs.state = input.state
  }
  if (!Object.prototype.hasOwnProperty.call(outputs, 'finalNodeId')) {
    outputs.finalNodeId = input.finalNodeId
  }
  return outputs
}

async function completeStateMachineRun(input: {
  runDir: string
  definition: MatOSWorkflowDefinition
  frames: MatOSWorkflowFrameSnapshot[]
  state: Record<string, unknown>
  finalNodeId: string
}): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(input.runDir)
  const outputs = await resolveStateMachineOutputs({
    definition: input.definition,
    frames: input.frames,
    parameters: snapshot.parameters,
    state: input.state,
    finalNodeId: input.finalNodeId,
    runDir: input.runDir,
    runId: snapshot.runId,
    artifactRoot: snapshot.artifactRoot,
    workflowRef: snapshot.workflowRef,
  })
  await writeFile(
    join(input.runDir, 'outputs.json'),
    `${JSON.stringify(outputs, null, 2)}\n`,
    'utf8',
  )
  await writeWorkflowRun(input.runDir, {
    ...snapshot,
    status: 'completed',
    waitingNodeId: undefined,
    outputs,
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.state_machine.completed',
    data: {
      runId: snapshot.runId,
      finalNodeId: input.finalNodeId,
      frameCount: input.frames.length,
    },
  })
  return inspectWorkflowRun(input.runDir)
}

async function failStateMachineRun(input: {
  runDir: string
  reason: string
  state: Record<string, unknown>
  finalNodeId?: string
  definition?: MatOSWorkflowDefinition
  controllerTick?: boolean
}): Promise<WorkflowRunView> {
  const snapshot = await readWorkflowRun(input.runDir)
  const controllerConfigured = Boolean(
    input.controllerTick &&
      input.definition?.policy.controller &&
      input.definition.policy.controller.enabled !== false,
  )
  const arm = controllerConfigured
    ? await appendWorkflowEvent(input.runDir, {
        type: 'workflow.controller.failure_tick_armed',
        data: {
          nodeIds: input.finalNodeId ? [input.finalNodeId] : [],
          executionModel: 'state_machine',
        },
      })
    : undefined
  await writeWorkflowRun(input.runDir, {
    ...snapshot,
    status: 'failed',
    waitingNodeId: undefined,
    outputs: {
      ...snapshot.outputs,
      state: input.state,
      error: input.reason,
      ...(input.finalNodeId ? { finalNodeId: input.finalNodeId } : {}),
    },
  })
  await appendWorkflowEvent(input.runDir, {
    type: 'workflow.state_machine.failed',
    data: { runId: snapshot.runId, reason: input.reason },
  })
  if (arm && input.definition) {
    await tickControllerAfterWorkflowFailure({
      runDir: input.runDir,
      snapshot: await readWorkflowRun(input.runDir),
      definition: input.definition,
      armEventId: arm.id,
      readyNodeIds: [],
    })
  }
  return inspectWorkflowRun(input.runDir)
}

async function executeFrame(input: {
  runDir: string
  definition: MatOSWorkflowDefinition
  frameIndex: number
  activeNodeId: string
  state: Record<string, unknown>
  transitionFromFrameId?: string
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
}): Promise<MatOSWorkflowNodeRunSnapshot | undefined> {
  const snapshot = await readWorkflowRun(input.runDir)
  const node = input.definition.nodes.find(item => item.id === input.activeNodeId)
  if (!node) {
    throw new Error(`State-machine active node not found: ${input.activeNodeId}`)
  }
  if (!snapshot.workspaceDir) {
    throw new Error(`Workflow run is missing workspaceDir: ${snapshot.runId}`)
  }

  const startedAt = nowIso()
  const currentFrameId = frameId(input.frameIndex)
  await writeWorkflowFrame(input.runDir, {
    frameId: currentFrameId,
    index: input.frameIndex,
    activeNodeId: input.activeNodeId,
    status: 'running',
    state: input.state,
    ...(input.transitionFromFrameId
      ? { transitionFromFrameId: input.transitionFromFrameId }
      : {}),
    createdAt: startedAt,
    updatedAt: startedAt,
  })

  const result = await runWorkflowSingleNode({
    runDir: input.runDir,
    node,
    runId: snapshot.runId,
    artifactRoot: snapshot.artifactRoot ?? join(input.runDir, 'artifacts-root'),
    projectCwd: snapshot.projectCwd ?? snapshot.workspaceDir,
    scopeRef: snapshot.trace?.scopeRef,
    workspaceDir: snapshot.workspaceDir,
    workflowsDir: dirname(dirname(input.runDir)),
    definition: input.definition,
    parameters: input.state,
    idempotencyScope: { frameId: currentFrameId, frameIndex: input.frameIndex },
    dynamicPlannerRunner: input.dynamicPlannerRunner,
  })
  const nodeRun = await readLatestNodeRun(input.runDir, input.activeNodeId)
  if (nodeRun) {
    await writeFrameNodeRun({
      runDir: input.runDir,
      frameIndex: input.frameIndex,
      nodeRun: {
        ...nodeRun,
        nodeId: input.activeNodeId,
      },
    })
  }
  if (result === 'waiting' || result === 'failed') {
    await writeWorkflowFrame(input.runDir, {
      frameId: currentFrameId,
      index: input.frameIndex,
      activeNodeId: input.activeNodeId,
      status: nodeRun ? terminalFrameStatus(nodeRun.status) : 'failed',
      state: input.state,
      ...(input.transitionFromFrameId
        ? { transitionFromFrameId: input.transitionFromFrameId }
        : {}),
      nodeRunPath: 'node-run.json',
      createdAt: startedAt,
      updatedAt: nowIso(),
    })
  }
  return nodeRun
}

async function finalizeExistingWaitingFrame(input: {
  runDir: string
  frame: MatOSWorkflowFrameSnapshot
}): Promise<MatOSWorkflowNodeRunSnapshot | undefined> {
  const nodeRun = await readLatestNodeRun(input.runDir, input.frame.activeNodeId)
  if (
    nodeRun &&
    ['completed', 'failed', 'skipped', 'cancelled'].includes(nodeRun.status)
  ) {
    await writeFrameNodeRun({
      runDir: input.runDir,
      frameIndex: input.frame.index,
      nodeRun: { ...nodeRun, nodeId: input.frame.activeNodeId },
    })
    // Advance the frame snapshot itself so the resume path sees a terminal
    // frame instead of a stale waiting/running one. Without this, a human
    // response completes the node run but the state machine restarts from the
    // initial node because the latest frame never reaches `completed`.
    await writeWorkflowFrame(input.runDir, {
      ...input.frame,
      status:
        nodeRun.status === 'completed' || nodeRun.status === 'skipped'
          ? 'completed'
          : 'failed',
      nodeRunPath: 'node-run.json',
      updatedAt: nowIso(),
    })
    return nodeRun
  }
  return undefined
}

export async function advanceStateMachineWorkflowRun(input: {
  runDir: string
  definition: MatOSWorkflowDefinition
  dynamicPlannerRunner?: WorkflowDynamicPlannerRunner
}): Promise<WorkflowRunView> {
  let snapshot = await readWorkflowRun(input.runDir)
  const policy = input.definition.policy.stateMachine
  if (!policy) {
    throw new Error('State-machine workflow is missing policy.stateMachine')
  }
  if (snapshot.status === 'created' || snapshot.status === 'paused') {
    await writeWorkflowRun(input.runDir, {
      ...snapshot,
      status: 'running',
      waitingNodeId: undefined,
    })
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.run.status_changed',
      data: { runId: snapshot.runId, status: 'running' },
    })
    snapshot = await readWorkflowRun(input.runDir)
  }
  if (snapshot.status !== 'running') {
    return inspectWorkflowRun(input.runDir)
  }

  let frames = await listWorkflowFrames(input.runDir)
  let activeNodeId = policy.initialNodeId
  let state: Record<string, unknown> = { ...snapshot.parameters }
  let transitionFromFrameId: string | undefined
  let resumeFrameIndex: number | undefined

  const latest = frames.at(-1)
  if (latest) {
    if (
      latest.status === 'waiting_input' ||
      latest.status === 'waiting_approval' ||
      latest.status === 'running'
    ) {
      const nodeRun = await finalizeExistingWaitingFrame({
        runDir: input.runDir,
        frame: latest,
      })
      if (!nodeRun) {
        const latestNodeRun = await readLatestNodeRun(
          input.runDir,
          latest.activeNodeId,
        )
        const stillWaiting =
          latestNodeRun?.status === 'waiting_input' ||
          latestNodeRun?.status === 'waiting_approval'
        if (latest.status !== 'running' || stillWaiting) {
          return inspectWorkflowRun(input.runDir)
        }
        // The process died mid-frame: the frame says running but no node
        // attempt reached a terminal or waiting state. Re-execute the current
        // frame from its persisted state (resume_current_frame recovery).
        activeNodeId = latest.activeNodeId
        state = latest.state
        transitionFromFrameId = latest.transitionFromFrameId
        resumeFrameIndex = latest.index
      }
      frames = await listWorkflowFrames(input.runDir)
    }

    const completedLatest = frames.at(-1)
    if (
      resumeFrameIndex === undefined &&
      completedLatest &&
      (completedLatest.status === 'completed' || completedLatest.status === 'failed')
    ) {
      let transition = transitionById(
        input.definition,
        completedLatest.transitionEdgeId,
      )
      let nextState = completedLatest.state
      if (!transition && !completedLatest.transitionEdgeId) {
        // The frame was completed out of band (for example a human response
        // finalized the waiting frame) or failed/cancelled without a recorded
        // failure transition. Compute it now from the persisted node run so the
        // machine can keep moving or fail deterministically.
        const latestNodeRun = await readFrameOrLatestNodeRun(
          input.runDir,
          completedLatest,
        )
        if (latestNodeRun) {
          transition = nextStateMachineTransition({
            definition: input.definition,
            activeNodeId: completedLatest.activeNodeId,
            nodeRun: latestNodeRun,
            state: completedLatest.state,
            transitionCounts: transitionCounts(frames),
          })
          if (transition) {
            nextState = reduceStateMachineState({
              state: completedLatest.state,
              reducer: transition.reducer,
              nodeId: completedLatest.activeNodeId,
              nodeRun: latestNodeRun,
            })
            await writeWorkflowFrame(input.runDir, {
              ...completedLatest,
              status: 'completed',
              state: nextState,
              transitionEdgeId: transitionId(transition),
              updatedAt: nowIso(),
            })
            await appendWorkflowTransitionRecord({
              runDir: input.runDir,
              frameId: completedLatest.frameId,
              transition,
              status: 'selected',
            })
            await appendWorkflowEvent(input.runDir, {
              type: 'workflow.state_machine.transition_selected',
              data: {
                frameId: completedLatest.frameId,
                transitionId: transitionId(transition),
                from: transition.from,
                to: transition.to,
              },
            })
          }
        }
      }
      if (!transition) {
        if (completedLatest.status === 'failed') {
          return failStateMachineRun({
            runDir: input.runDir,
            reason: `No state-machine transition matched failed node "${completedLatest.activeNodeId}"`,
            state: completedLatest.state,
            finalNodeId: completedLatest.activeNodeId,
            definition: input.definition,
            controllerTick: true,
          })
        }
        return completeStateMachineRun({
          runDir: input.runDir,
          definition: input.definition,
          frames,
          state: completedLatest.state,
          finalNodeId: completedLatest.activeNodeId,
        })
      }
      activeNodeId = transition.to
      state = nextState
      transitionFromFrameId = completedLatest.frameId
    }
  }

  const maxFrames = policy.maxFrames ?? policy.maxTransitions + 1
  while (snapshot.status === 'running') {
    // Honor cooperative cancel/pause markers at frame boundaries, mirroring
    // the DAG advance loop. Without this, a healthy state machine whose
    // frames keep succeeding never observed a requested cancel/pause until
    // it finished or a node happened to fail.
    const controlAction = await readWorkflowRunControlAction(input.runDir)
    if (
      controlAction === 'cancel' ||
      (await workflowRunLocalProcessCancelRequested(input.runDir))
    ) {
      return cancelWorkflowRun(input.runDir)
    }
    if (controlAction === 'pause') {
      return pauseWorkflowRun(input.runDir)
    }
    frames = await listWorkflowFrames(input.runDir)
    const nextFrameIndex = resumeFrameIndex ?? frames.length + 1
    if (nextFrameIndex > maxFrames) {
      return failStateMachineRun({
        runDir: input.runDir,
        reason: 'state_machine_maxFrames_exhausted',
        state,
        finalNodeId: activeNodeId,
      })
    }

    const budgetEnforcement = await enforceWorkflowBudget({
      runDir: input.runDir,
      definition: input.definition,
    })
    if (budgetEnforcement) {
      await appendWorkflowEvent(input.runDir, {
        type: 'workflow.budget.exceeded',
        data: {
          violations: budgetEnforcement.violations,
          totals: budgetEnforcement.ledger.totals,
          onExceeded: budgetEnforcement.onExceeded,
        },
      })
      const violationSummary = budgetEnforcement.violations
        .map(
          violation =>
            `${violation.limit}=${violation.max} observed=${violation.observed}`,
        )
        .join('; ')
      if (budgetEnforcement.onExceeded === 'pause') {
        const current = await readWorkflowRun(input.runDir)
        await writeWorkflowRun(input.runDir, {
          ...current,
          status: 'paused',
          waitingNodeId: undefined,
        })
        await appendWorkflowEvent(input.runDir, {
          type: 'workflow.run.paused',
          data: {
            runId: current.runId,
            reason: `budget exhausted: ${violationSummary}`,
          },
        })
        return inspectWorkflowRun(input.runDir)
      }
      return failStateMachineRun({
        runDir: input.runDir,
        reason: `budget exhausted: ${violationSummary}`,
        state,
        finalNodeId: activeNodeId,
      })
    }

    const frameIndex = nextFrameIndex
    resumeFrameIndex = undefined
    const currentFrameId = frameId(frameIndex)
    if (
      input.definition.policy.controller &&
      input.definition.policy.controller.enabled !== false
    ) {
      const nodeRuns = new Map<string, MatOSWorkflowNodeRunSnapshot>()
      for (const node of input.definition.nodes) {
        const nodeRun = await readLatestNodeRun(input.runDir, node.id)
        if (nodeRun) nodeRuns.set(node.id, nodeRun)
      }
      try {
        const advice = await adviseWorkflowReadySet({
          runDir: input.runDir,
          snapshot,
          definition: input.definition,
          nodeRuns,
          readyNodeIds: [activeNodeId],
        })
        if (advice.directive) {
          await writeWorkflowRun(input.runDir, {
            ...snapshot,
            status: advice.directive.status,
            waitingNodeId: undefined,
          })
          await appendWorkflowEvent(input.runDir, {
            type: `workflow.controller.run_${advice.directive.status}`,
            data: {
              runId: snapshot.runId,
              reason: advice.directive.reason,
              frameId: currentFrameId,
            },
          })
          return inspectWorkflowRun(input.runDir)
        }
      } catch (error) {
        const policy = input.definition.policy.controller
        const onFailure = workflowControllerFailureMode(input.definition)
        const message = redactWorkflowControllerFailureText(error, 500)
        await appendWorkflowEvent(input.runDir, {
          type: 'workflow.controller.failed',
          data: {
            runId: snapshot.runId,
            frameId: currentFrameId,
            message,
          },
        })
        if (policy.mode !== 'shadow' && onFailure !== 'baseline') {
          await writeWorkflowRun(input.runDir, {
            ...snapshot,
            status: onFailure === 'fail' ? 'failed' : 'paused',
            waitingNodeId: undefined,
          })
          return inspectWorkflowRun(input.runDir)
        }
      }
    }
    const nodeRun = await executeFrame({
      runDir: input.runDir,
      definition: input.definition,
      frameIndex,
      activeNodeId,
      state,
      transitionFromFrameId,
      dynamicPlannerRunner: input.dynamicPlannerRunner,
    })
    snapshot = await readWorkflowRun(input.runDir)
    // A cancel/pause marker written while the frame executed (for example the
    // frame's exec node was killed by the cooperative cancel watcher) must
    // settle the run as cancelled/paused, not fall through to transition
    // selection and fail with "no transition matched".
    const postFrameControl = await readWorkflowRunControlAction(input.runDir)
    if (postFrameControl === 'cancel') {
      return cancelWorkflowRun(input.runDir)
    }
    if (postFrameControl === 'pause') {
      return pauseWorkflowRun(input.runDir)
    }
    if (!nodeRun || nodeRun.status === 'waiting_input' || nodeRun.status === 'waiting_approval') {
      return inspectWorkflowRun(input.runDir)
    }

    frames = await listWorkflowFrames(input.runDir)
    const transition = nextStateMachineTransition({
      definition: input.definition,
      activeNodeId,
      nodeRun,
      state,
      transitionCounts: transitionCounts(frames),
    })
    if (!transition) {
      if (nodeRun.status === 'completed' || nodeRun.status === 'skipped') {
        const completedFrame: MatOSWorkflowFrameSnapshot = {
          frameId: currentFrameId,
          index: frameIndex,
          activeNodeId,
          status: 'completed',
          state,
          ...(transitionFromFrameId ? { transitionFromFrameId } : {}),
          nodeRunPath: 'node-run.json',
          createdAt: frames.at(-1)?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        }
        await writeWorkflowFrame(input.runDir, completedFrame)
        frames = await listWorkflowFrames(input.runDir)
        return completeStateMachineRun({
          runDir: input.runDir,
          definition: input.definition,
          frames,
          state,
          finalNodeId: activeNodeId,
        })
      }
      await writeWorkflowFrame(input.runDir, {
        frameId: currentFrameId,
        index: frameIndex,
        activeNodeId,
        status: 'failed',
        state,
        ...(transitionFromFrameId ? { transitionFromFrameId } : {}),
        nodeRunPath: 'node-run.json',
        createdAt: frames.at(-1)?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      })
      return failStateMachineRun({
        runDir: input.runDir,
        reason: `No state-machine transition matched failed node "${activeNodeId}"`,
        state,
        finalNodeId: activeNodeId,
        definition: input.definition,
        controllerTick: true,
      })
    }

    if (selectedTransitionCount(frames) >= policy.maxTransitions) {
      return failStateMachineRun({
        runDir: input.runDir,
        reason: 'state_machine_maxTransitions_exhausted',
        state,
        finalNodeId: activeNodeId,
      })
    }

    const nextState = reduceStateMachineState({
      state,
      reducer: transition.reducer,
      nodeId: activeNodeId,
      nodeRun,
    })
    const completedFrame: MatOSWorkflowFrameSnapshot = {
      frameId: currentFrameId,
      index: frameIndex,
      activeNodeId,
      status: 'completed',
      state: nextState,
      ...(transitionFromFrameId ? { transitionFromFrameId } : {}),
      transitionEdgeId: transitionId(transition),
      nodeRunPath: 'node-run.json',
      createdAt: frames.at(-1)?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    }
    await writeWorkflowFrame(input.runDir, completedFrame)
    await appendWorkflowTransitionRecord({
      runDir: input.runDir,
      frameId: currentFrameId,
      transition,
      status: 'selected',
    })
    await appendWorkflowEvent(input.runDir, {
      type: 'workflow.state_machine.transition_selected',
      data: {
        frameId: currentFrameId,
        transitionId: transitionId(transition),
        from: transition.from,
        to: transition.to,
      },
    })

    activeNodeId = transition.to
    state = nextState
    transitionFromFrameId = currentFrameId
    snapshot = await readWorkflowRun(input.runDir)
  }

  return inspectWorkflowRun(input.runDir)
}
