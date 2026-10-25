import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowTransitionEdge,
  MatOSWorkflowValidationError,
} from './types.js'
import { transitionId } from './stateMachineTypes.js'

const SUPPORTED_TRANSITION_ROUTES = new Set(['success', 'failure', 'always'])

function pushStateMachineError(
  errors: MatOSWorkflowValidationError[],
  message: string,
  path: string,
  nodeId?: string,
): void {
  errors.push({
    code: 'invalid_policy',
    message,
    path,
    ...(nodeId ? { nodeId } : {}),
  })
}

function nodeMap(
  definition: MatOSWorkflowDefinition,
): Map<string, MatOSWorkflowNode> {
  return new Map(definition.nodes.map(node => [node.id, node]))
}

function validateTransition(
  transition: MatOSWorkflowTransitionEdge,
  index: number,
  nodes: Map<string, MatOSWorkflowNode>,
  ids: Set<string>,
  errors: MatOSWorkflowValidationError[],
): void {
  const id = transitionId(transition)
  if (ids.has(id)) {
    pushStateMachineError(
      errors,
      `Duplicate state-machine transition id "${id}"`,
      `transitions[${index}].id`,
    )
  }
  ids.add(id)

  if (!nodes.has(transition.from)) {
    pushStateMachineError(
      errors,
      `Transition "${id}" source node "${transition.from}" does not exist`,
      `transitions[${index}].from`,
      transition.from,
    )
  }
  if (!nodes.has(transition.to)) {
    pushStateMachineError(
      errors,
      `Transition "${id}" target node "${transition.to}" does not exist`,
      `transitions[${index}].to`,
      transition.to,
    )
  }
  if (
    transition.route !== undefined &&
    !SUPPORTED_TRANSITION_ROUTES.has(transition.route)
  ) {
    pushStateMachineError(
      errors,
      `Unsupported state-machine transition route "${String(transition.route)}"`,
      `transitions[${index}].route`,
      transition.to,
    )
  }
  if (
    transition.maxTraversals !== undefined &&
    (!Number.isInteger(transition.maxTraversals) ||
      transition.maxTraversals < 1)
  ) {
    pushStateMachineError(
      errors,
      `Transition "${id}" maxTraversals must be greater than or equal to 1`,
      `transitions[${index}].maxTraversals`,
    )
  }
}

export function validateStateMachineWorkflow(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowValidationError[] {
  const errors: MatOSWorkflowValidationError[] = []
  const nodes = nodeMap(definition)
  const policy = definition.policy.stateMachine

  if (!policy) {
    pushStateMachineError(
      errors,
      'State-machine workflow requires policy.stateMachine',
      'policy.stateMachine',
    )
    return errors
  }

  if (!nodes.has(policy.initialNodeId)) {
    pushStateMachineError(
      errors,
      `State-machine initialNodeId "${policy.initialNodeId}" does not match a workflow node`,
      'policy.stateMachine.initialNodeId',
      policy.initialNodeId,
    )
  }

  if (!Number.isInteger(policy.maxTransitions) || policy.maxTransitions < 1) {
    pushStateMachineError(
      errors,
      'State-machine workflow requires maxTransitions greater than or equal to 1',
      'policy.stateMachine.maxTransitions',
    )
  }

  if (
    policy.maxFrames !== undefined &&
    (!Number.isInteger(policy.maxFrames) || policy.maxFrames < 1)
  ) {
    pushStateMachineError(
      errors,
      'State-machine workflow maxFrames must be greater than or equal to 1',
      'policy.stateMachine.maxFrames',
    )
  }

  const transitions = definition.transitions ?? []
  if (transitions.length === 0) {
    pushStateMachineError(
      errors,
      'State-machine workflow requires at least one transition',
      'transitions',
    )
  }

  const ids = new Set<string>()
  for (const [index, transition] of transitions.entries()) {
    validateTransition(transition, index, nodes, ids, errors)
  }

  return errors
}
