import type {
  WorkflowArtifactContract,
  WorkflowArtifactRef,
  WorkflowContractMap,
} from './types.js'

export type WorkflowArtifactContractStatus = {
  nodeId: string
  contractId: string
  contract: WorkflowArtifactContract
  status: 'present' | 'missing' | 'declared'
  required: boolean
  artifact?: WorkflowArtifactRef
}

function normalizePath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function pathMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizePath(left)
  const normalizedRight = normalizePath(right)
  if (!normalizedLeft || !normalizedRight) {
    return false
  }
  if (normalizedLeft === normalizedRight) {
    return true
  }
  return (
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  )
}

export function artifactMatchesWorkflowContract(
  artifact: WorkflowArtifactRef,
  nodeId: string,
  contractId: string,
  contract: WorkflowArtifactContract,
): boolean {
  const producerNodeId = contract.producerNodeId ?? nodeId
  if (artifact.nodeId && artifact.nodeId !== producerNodeId) {
    return false
  }
  if (contract.id && artifact.id === contract.id) {
    return true
  }
  if (!contract.id && artifact.id === contractId) {
    return true
  }
  if (pathMatches(artifact.path, contract.path)) {
    return true
  }
  if (contract.kind && artifact.kind === contract.kind && artifact.nodeId === producerNodeId) {
    return true
  }
  return false
}

export function workflowArtifactContractStatuses(
  contracts: WorkflowContractMap,
  artifacts: WorkflowArtifactRef[] = [],
): WorkflowArtifactContractStatus[] {
  const statuses: WorkflowArtifactContractStatus[] = []
  for (const [nodeId, nodeContract] of Object.entries(contracts.nodes ?? {})) {
    for (const [contractId, contract] of Object.entries(
      nodeContract.artifacts ?? {},
    )) {
      const required = contract.required === true
      const artifact = artifacts.find(item =>
        artifactMatchesWorkflowContract(item, nodeId, contractId, contract),
      )
      statuses.push({
        nodeId,
        contractId,
        contract,
        required,
        status: artifact ? 'present' : required ? 'missing' : 'declared',
        ...(artifact ? { artifact } : {}),
      })
    }
  }
  return statuses
}
