import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowExecutionModel,
  MatOSWorkflowStateMachinePolicy,
  MatOSWorkflowTransitionEdge,
} from './types.js'

export function workflowExecutionModel(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowExecutionModel {
  return definition.policy.executionModel === 'state_machine'
    ? 'state_machine'
    : 'dag'
}

export function isStateMachineWorkflow(
  definition: MatOSWorkflowDefinition,
): boolean {
  return workflowExecutionModel(definition) === 'state_machine'
}

export function stateMachinePolicy(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowStateMachinePolicy | undefined {
  return definition.policy.stateMachine
}

export function transitionId(edge: MatOSWorkflowTransitionEdge): string {
  return edge.id ?? `${edge.from}->${edge.to}`
}

export function frameId(index: number): string {
  return `frame-${String(index).padStart(6, '0')}`
}
