import type { MatOSWorkflowNodeRunSnapshot } from './types.js'
import { resolveWorkflowTemplateValue } from './workflowExpressions.js'

export function reduceStateMachineState(input: {
  state: Record<string, unknown>
  reducer: Record<string, unknown> | undefined
  nodeId: string
  nodeRun: MatOSWorkflowNodeRunSnapshot
}): Record<string, unknown> {
  if (!input.reducer) {
    return input.state
  }

  const reduced = resolveWorkflowTemplateValue(input.reducer, {
    nodeRuns: new Map([[input.nodeId, input.nodeRun]]),
    parameters: input.state,
    workflow: { state: input.state },
  })
  return {
    ...input.state,
    ...(reduced && typeof reduced === 'object' && !Array.isArray(reduced)
      ? (reduced as Record<string, unknown>)
      : {}),
  }
}
