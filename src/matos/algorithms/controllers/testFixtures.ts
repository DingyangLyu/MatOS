import {
  createMatOSControllerBudget,
  createMatOSControllerBudgetUsage,
  createMatOSControllerObservation,
  createMatOSControllerSearchBounds,
  type MatOSControllerBudgetSnapshot,
  type MatOSControllerObservation,
  type MatOSControllerObservationStatus,
} from './protocol.js'

export const controllerTestBounds = createMatOSControllerSearchBounds({
  maxActions: 8,
  maxCandidates: 128,
  maxDepth: 8,
  maxWallTimeMs: 10_000,
  maxCostUsd: 100,
})

export function controllerTestBudget(
  used: Parameters<typeof createMatOSControllerBudgetUsage>[0] = {},
): MatOSControllerBudgetSnapshot {
  return createMatOSControllerBudget({
    limits: createMatOSControllerBudgetUsage({
      actions: 128,
      candidates: 128,
      transitions: 128,
      evaluations: 128,
      maxDepth: 8,
      wallTimeMs: 10_000,
      costUsd: 100,
    }),
    used,
  })
}

export function controllerTestObservation(input: {
  runRef?: string
  scopeRef?: string
  eventCursor?: string
  status?: MatOSControllerObservationStatus
  manifestRef?: string
  manifestDigest?: string
  graphSnapshotRef?: string
  graphDigest?: string
  graphVersion?: number
  readyNodeRefs?: readonly string[]
  runningNodeRefs?: readonly string[]
  completedNodeRefs?: readonly string[]
  failedNodeRefs?: readonly string[]
  artifactRefs?: readonly string[]
  validationRefs?: readonly string[]
  budget?: MatOSControllerBudgetSnapshot
} = {}): MatOSControllerObservation {
  return createMatOSControllerObservation({
    runRef: input.runRef ?? 'workflow-run:1',
    scopeRef: input.scopeRef ?? 'user:alice',
    eventCursor: input.eventCursor ?? 'event:1',
    status: input.status ?? 'running',
    manifest: {
      ref: input.manifestRef ?? 'algorithm-manifest:1',
      digest: input.manifestDigest ?? 'manifest-digest-1',
    },
    graph: {
      snapshotRef: input.graphSnapshotRef ?? 'graph-snapshot:1',
      digest: input.graphDigest ?? 'graph-digest-1',
      version: input.graphVersion ?? 1,
    },
    readyNodeRefs: input.readyNodeRefs ?? ['node:z', 'node:a', 'node:m'],
    runningNodeRefs: input.runningNodeRefs ?? [],
    completedNodeRefs: input.completedNodeRefs ?? [],
    failedNodeRefs: input.failedNodeRefs ?? [],
    artifactRefs: input.artifactRefs ?? [],
    validationRefs: input.validationRefs ?? [],
    budget: input.budget ?? controllerTestBudget(),
  })
}
