import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowTransitionEdge,
} from './types.js'
import { transitionId } from './stateMachineTypes.js'
import { evaluateWorkflowCondition } from './workflowConditions.js'
import { routeMatchesStatus } from './scheduler.js'

export function nextStateMachineTransition(input: {
  definition: MatOSWorkflowDefinition
  activeNodeId: string
  nodeRun: MatOSWorkflowNodeRunSnapshot
  state: Record<string, unknown>
  transitionCounts: Map<string, number>
}): MatOSWorkflowTransitionEdge | undefined {
  for (const transition of input.definition.transitions ?? []) {
    if (transition.from !== input.activeNodeId) {
      continue
    }
    if (!routeMatchesStatus(transition.route, input.nodeRun.status)) {
      continue
    }
    const count = input.transitionCounts.get(transitionId(transition)) ?? 0
    if (
      transition.maxTraversals !== undefined &&
      count >= transition.maxTraversals
    ) {
      continue
    }
    if (
      transition.guard &&
      !evaluateWorkflowCondition(transition.guard, {
        nodeRuns: new Map([[input.activeNodeId, input.nodeRun]]),
        parameters: input.state,
        workflow: { state: input.state },
      })
    ) {
      continue
    }
    return transition
  }
  return undefined
}
