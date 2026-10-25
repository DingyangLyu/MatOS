import { evaluateWorkflowCondition } from '../workflowConditions.js'
import { resolveWorkflowTemplateValue } from '../workflowExpressions.js'
import type { MatOSWorkflowNode, MatOSWorkflowNodeRunSnapshot } from '../types.js'
import { readWorkflowRunControlAction } from '../workflowControl.js'
import { resolvePinnedChildWorkflow } from '../childWorkflowSnapshot.js'
import {
  metadataObject,
  runIterationChild,
  selectedOutputs,
  stringList,
  writeIteration,
  writeRoundState,
  type IterationNodeResult,
  type IterationNodeRunOptions,
} from './iterationNodeCommon.js'

function currentNodeRun(outputs: Record<string, unknown>): MatOSWorkflowNodeRunSnapshot {
  return {
    nodeId: 'current',
    status: 'completed',
    attempts: 1,
    updatedAt: new Date().toISOString(),
    output: outputs,
  }
}

function optionalIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function loopContext(input: {
  index: number
  state: Record<string, unknown>
  previous: Record<string, unknown> | undefined
  outputs?: Record<string, unknown>
  parameters: Record<string, unknown>
}) {
  return {
    nodeRuns: input.outputs
      ? new Map([['current', currentNodeRun(input.outputs)]])
      : new Map<string, MatOSWorkflowNodeRunSnapshot>(),
    parameters: input.parameters,
    loop: {
      iteration: input.index,
      count: Math.max(0, input.index - 1),
      state: input.state,
      previous: input.previous,
      outputs: input.outputs ?? input.previous?.outputs ?? {},
    },
  }
}

function resolveLoopRecord(
  value: unknown,
  context: ReturnType<typeof loopContext>,
): Record<string, unknown> {
  return recordOrEmpty(resolveWorkflowTemplateValue(value, context))
}

export async function runWorkflowLoopNode(
  node: MatOSWorkflowNode,
  options: IterationNodeRunOptions,
): Promise<IterationNodeResult> {
  if (node.type !== 'loop') {
    throw new Error(`Loop node runner requires a loop node: ${node.id}`)
  }
  const baseParameters = metadataObject(node.parameters)
  const outputKeys = stringList(node.outputKeys ?? node.outputs)
  const maxIterations = Number(node.maxIterations)
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`Loop node requires maxIterations: ${node.id}`)
  }
  const iterationParameter =
    typeof node.iterationParameter === 'string' && node.iterationParameter.trim()
      ? node.iterationParameter
      : 'iteration'
  const stateParameter = optionalIdentifier(node.stateParameter)
  const previousParameter = optionalIdentifier(node.previousParameter)
  const until = typeof node.until === 'string' ? node.until : undefined
  const iterations = []
  let lastOutputs: Record<string, unknown> = {}
  let previousIteration: Record<string, unknown> | undefined
  let currentParameters = baseParameters
  let state = resolveLoopRecord(
    node.initialState,
    loopContext({
      index: 0,
      state: {},
      previous: undefined,
      parameters: baseParameters,
    }),
  )
  let stoppedBy = 'maxIterations'
  let cancelRequested = false
  const child = await resolvePinnedChildWorkflow({
    cwd: options.cwd,
    runDir: options.runDir,
    node,
  })

  for (let index = 1; index <= maxIterations; index += 1) {
    // A run cancel request must stop the loop from starting further child
    // workflow rounds; fresh children carry no cancel marker of their own,
    // so without this check a cancelled run keeps looping to maxIterations.
    if ((await readWorkflowRunControlAction(options.runDir)) === 'cancel') {
      stoppedBy = 'run_cancel_requested'
      cancelRequested = true
      break
    }
    const stateBefore = state
    const parameters = {
      ...currentParameters,
      [iterationParameter]: index,
      ...(stateParameter ? { [stateParameter]: stateBefore } : {}),
      ...(previousParameter ? { [previousParameter]: previousIteration ?? null } : {}),
    }
    const childRun = await runIterationChild({
      node,
      child,
      cwd: options.cwd,
      workflowsDir: options.workflowsDir,
      workspaceDir: options.workspaceDir,
      parameters,
      startChildRun: options.startChildRun,
      onCreated: async run => {
        await writeIteration({
          runDir: options.runDir,
          nodeId: node.id,
          index,
          value: {
            index,
            childRunId: run.runId,
            status: 'running',
            parameters,
            stateBefore,
            outputs: {},
          },
        })
      },
    })
    const outputs = selectedOutputs(childRun.outputs, outputKeys)
    const nextContext = loopContext({
      index,
      state: stateBefore,
      previous: previousIteration,
      outputs,
      parameters,
    })
    const nextStatePatch = resolveLoopRecord(node.nextState, nextContext)
    const stateAfter = { ...stateBefore, ...nextStatePatch }
    const nextParametersPatch = resolveLoopRecord(node.nextParameters, {
      ...nextContext,
      loop: {
        ...nextContext.loop,
        count: index,
        state: stateAfter,
        outputs,
      },
    })
    currentParameters = { ...currentParameters, ...nextParametersPatch }
    let shouldStop = false
    if (
      childRun.status === 'completed' &&
      until &&
      evaluateWorkflowCondition(until, {
        nodeRuns: new Map([['current', currentNodeRun(outputs)]]),
        parameters,
        loop: {
          iteration: index,
          count: index,
          state: stateAfter,
          previous: previousIteration,
          outputs,
        },
      })
    ) {
      stoppedBy = 'until'
      shouldStop = true
    }
    const iteration = {
      index,
      childRunId: childRun.runId,
      status: childRun.status,
      parameters,
      stateBefore,
      stateAfter,
      outputs,
    }
    await writeIteration({
      runDir: options.runDir,
      nodeId: node.id,
      index,
      value: iteration,
    })
    await writeRoundState({
      runDir: options.runDir,
      nodeId: node.id,
      index,
      inputs: { parameters, stateBefore, previous: previousIteration ?? null },
      childRun,
      outputs,
      decision:
        childRun.status !== 'completed' ? 'fail' : shouldStop ? 'stop' : 'continue',
      reason:
        childRun.status !== 'completed'
          ? 'child_failed'
          : shouldStop
            ? 'until'
            : 'child_completed',
    })
    if (childRun.status !== 'completed') {
      throw new Error(
        `Loop child workflow did not complete: ${node.id} (${childRun.status})`,
      )
    }
    iterations.push(iteration)
    lastOutputs = outputs
    previousIteration = iteration
    state = stateAfter
    if (shouldStop) {
      break
    }
  }

  return {
    output: {
      count: iterations.length,
      stoppedBy,
      iterations,
      state,
      parameters: currentParameters,
      outputs: lastOutputs,
    },
    ...(cancelRequested ? { cancelled: true } : {}),
  }
}
