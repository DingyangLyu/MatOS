import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowNodeStatus,
} from './types.js'
import { evaluateWorkflowCondition } from './workflowConditions.js'

export type WorkflowSchedulerInput = {
  definition: MatOSWorkflowDefinition
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>
  parameters: Record<string, unknown>
}

export function workflowNodeStatus(
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
  nodeId: string,
): MatOSWorkflowNodeStatus {
  return nodeRuns.get(nodeId)?.status ?? 'pending'
}

const WAITING_NODE_STATUSES = new Set<MatOSWorkflowNodeStatus>([
  'pending',
  'ready',
  'running',
  'waiting_input',
  'waiting_approval',
])

const TERMINAL_NODE_STATUSES = new Set<MatOSWorkflowNodeStatus>([
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

export function routeMatchesStatus(
  route: string | undefined,
  status: MatOSWorkflowNodeStatus,
): boolean {
  const normalized = (route ?? 'success').trim().toLowerCase()
  if (normalized === 'success') {
    return status === 'completed'
  }
  if (normalized === 'failure') {
    return status === 'failed'
  }
  if (normalized === 'always') {
    return TERMINAL_NODE_STATUSES.has(status)
  }
  return false
}

function edgeAllowsDependency(
  node: MatOSWorkflowNode,
  dependency: string,
  status: MatOSWorkflowNodeStatus,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
  parameters: Record<string, unknown>,
): boolean {
  // All edges from this dependency participate (OR semantics): a node may
  // declare both a success route and a failure route from the same producer
  // ("proceed either way, but only after it settled"). Taking only the first
  // matching edge silently ignored every other route.
  const edges = (node.incomingEdges ?? []).filter(
    candidate => candidate.from === dependency,
  )
  if (edges.length === 0) {
    return status === 'completed'
  }
  return edges.some(edge => {
    if (!routeMatchesStatus(edge.route, status)) {
      return false
    }
    if (
      edge.condition &&
      !evaluateWorkflowCondition(edge.condition, { nodeRuns, parameters })
    ) {
      return false
    }
    return true
  })
}

export function workflowNodeRunDecision(
  node: MatOSWorkflowNode,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
  parameters: Record<string, unknown>,
): 'ready' | 'wait' | 'skip' {
  for (const dependency of node.dependsOn) {
    const status = workflowNodeStatus(nodeRuns, dependency)
    if (WAITING_NODE_STATUSES.has(status)) {
      return 'wait'
    }
    if (
      !edgeAllowsDependency(
        node,
        dependency,
        status,
        nodeRuns,
        parameters,
      )
    ) {
      return 'skip'
    }
  }
  return 'ready'
}

export function readyWorkflowNodes(input: WorkflowSchedulerInput): MatOSWorkflowNode[] {
  return input.definition.nodes.filter(node => {
    if (workflowNodeStatus(input.nodeRuns, node.id) !== 'pending') {
      return false
    }
    return workflowNodeRunDecision(node, input.nodeRuns, input.parameters) === 'ready'
  })
}

export function allWorkflowNodesFinished(
  definition: MatOSWorkflowDefinition,
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>,
): boolean {
  return definition.nodes.every(node =>
    TERMINAL_NODE_STATUSES.has(workflowNodeStatus(nodeRuns, node.id)),
  )
}

export function downstreamWorkflowNodeIds(
  definition: MatOSWorkflowDefinition,
  nodeId: string,
): string[] {
  const found = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const node of definition.nodes) {
      if (found.has(node.id) || node.id === nodeId) {
        continue
      }
      const dependencyMatches = node.dependsOn.some(
        dependency => dependency === nodeId || found.has(dependency),
      )
      const edgeMatches = (node.incomingEdges ?? []).some(
        edge => edge.from === nodeId || found.has(edge.from),
      )
      if (dependencyMatches || edgeMatches) {
        found.add(node.id)
        changed = true
      }
    }
  }
  return definition.nodes
    .map(node => node.id)
    .filter(candidate => found.has(candidate))
}

export function blockedWorkflowNodeToSkip(
  input: WorkflowSchedulerInput,
): MatOSWorkflowNode | undefined {
  return input.definition.nodes.find(candidate => {
    if (workflowNodeStatus(input.nodeRuns, candidate.id) !== 'pending') {
      return false
    }
    return (
      workflowNodeRunDecision(
        candidate,
        input.nodeRuns,
        input.parameters,
      ) === 'skip'
    )
  })
}
