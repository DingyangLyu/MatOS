import { AsyncLocalStorage } from 'node:async_hooks'

export type MatOSAlgorithmSurfacePin = {
  surfaceId: string
  providerId: string
  source: 'explicit' | 'env' | 'role' | 'default'
  requested?: string
  version: string
  assetRef?: string
  configDigest: string
  implementationDigest: string
  manifestDigest: string
  shadow?: {
    providerId: string
    source: 'explicit' | 'env' | 'role'
    version: string
    assetRef?: string
    configDigest: string
    implementationDigest: string
  }
}

/**
 * Immutable identity for an ordinary tool asset that is allowed to emit an
 * algorithm decision. The run manifest owns the pin; node execution only
 * receives this projection and must re-hash the asset before each attempt.
 */
export type MatOSAlgorithmComponentPin = {
  nodeId: string
  protocol: 'json-v1'
  plane: 'policy' | 'controller' | 'optimizer'
  providerId: string
  providerVersion: string
  assetRef: string
  configDigest: string
  assetManifestDigest: string
  entryDigest: string
  implementationDigest: string
  runtimeRefs: string[]
  /** Digest of the immutable run manifest that contains this component pin. */
  manifestDigest: string
}

export type MatOSWorkflowExecutionContext = {
  runId: string
  runDir: string
  workflowNodeId?: string
  attempt?: number
  projectCwd: string
  scopeRef?: string
  /** Durable workflow/node budget remaining at this attempt boundary. */
  remainingBudget?: Readonly<Record<string, number>>
  /**
   * Immutable provider selections captured when the workflow run was created.
   * Online decision surfaces consult these pins before mutable env/role input,
   * so resume and recovery cannot silently hot-swap an algorithm provider.
   */
  algorithmSurfacePins?: ReadonlyMap<string, MatOSAlgorithmSurfacePin>
  /** Algorithm-producing backend/tool nodes, keyed by workflow node id. */
  algorithmComponentPins?: ReadonlyMap<string, MatOSAlgorithmComponentPin>
}

const storage = new AsyncLocalStorage<MatOSWorkflowExecutionContext>()

export function currentMatOSWorkflowExecutionContext():
  | MatOSWorkflowExecutionContext
  | undefined {
  return storage.getStore()
}

export function withMatOSWorkflowExecutionContext<T>(
  context: MatOSWorkflowExecutionContext,
  fn: () => T,
): T {
  return storage.run(context, fn)
}
