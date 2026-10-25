import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadMatOSRuntimeAssets as loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { readJson, writeJson } from './jsonIo.js'
import { loadWorkflowAsset } from './loadWorkflow.js'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from './types.js'

export type PinnedChildWorkflow = {
  schemaVersion: 1
  nodeId: string
  requestedRef: string
  workflowRef: string
  definition: MatOSWorkflowDefinition
}

function requestedWorkflowRef(node: MatOSWorkflowNode): string {
  if (typeof node.workflow !== 'string' || !node.workflow.trim()) {
    throw new Error(`Child workflow node requires workflow: ${node.id}`)
  }
  return node.workflow.trim()
}

function workflowRefFor(asset: {
  canonicalKey?: string
  type: string
  id: string
}): string {
  return asset.canonicalKey || `${asset.type}:${asset.id}`
}

function snapshotPath(input: {
  runDir: string
  nodeId: string
  requestedRef: string
}): string {
  const digest = createHash('sha256')
    .update(`${input.nodeId}\0${input.requestedRef}`)
    .digest('hex')
  return join(input.runDir, 'child-workflow-snapshots', `${digest}.json`)
}

function validSnapshot(
  value: unknown,
  expected: { nodeId: string; requestedRef: string },
): value is PinnedChildWorkflow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const snapshot = value as Partial<PinnedChildWorkflow>
  return (
    snapshot.schemaVersion === 1 &&
    snapshot.nodeId === expected.nodeId &&
    snapshot.requestedRef === expected.requestedRef &&
    typeof snapshot.workflowRef === 'string' &&
    snapshot.workflowRef.length > 0 &&
    Boolean(snapshot.definition) &&
    typeof snapshot.definition === 'object' &&
    snapshot.definition.schemaVersion === 1 &&
    Array.isArray(snapshot.definition.nodes)
  )
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT',
  )
}

/**
 * Pin a child workflow to the parent run before executing it. Map/loop nodes
 * may span hours and many child runs; resolving the mutable asset registry for
 * every item makes one node attempt observe multiple asset versions. The
 * persisted snapshot is also the recovery boundary after a process restart.
 */
export async function resolvePinnedChildWorkflow(input: {
  cwd: string
  runDir: string
  node: MatOSWorkflowNode
}): Promise<PinnedChildWorkflow> {
  const requestedRef = requestedWorkflowRef(input.node)
  const path = snapshotPath({
    runDir: input.runDir,
    nodeId: input.node.id,
    requestedRef,
  })

  try {
    const snapshot = await readJson<unknown>(path)
    if (!validSnapshot(snapshot, { nodeId: input.node.id, requestedRef })) {
      throw new Error(`Invalid child workflow snapshot: ${path}`)
    }
    return snapshot
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error
    }
  }

  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const child = await loadWorkflowAsset(registry, requestedRef)
  const snapshot: PinnedChildWorkflow = {
    schemaVersion: 1,
    nodeId: input.node.id,
    requestedRef,
    workflowRef: workflowRefFor(child.asset),
    definition: child.definition,
  }
  await mkdir(join(input.runDir, 'child-workflow-snapshots'), {
    recursive: true,
  })
  await writeJson(path, snapshot)
  return snapshot
}
