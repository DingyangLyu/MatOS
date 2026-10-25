import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  WorkflowArtifactContract,
  WorkflowContractMap,
  WorkflowNodeContract,
  WorkflowValueContract,
} from './types.js'
import { normalizeWorkflowValueType } from './nodeManifests.js'

const VALUE_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function valueContract(
  type: WorkflowValueContract['type'],
  options: Omit<WorkflowValueContract, 'type'> = {},
): WorkflowValueContract {
  return { type, ...options }
}

function normalizeValueContract(
  value: unknown,
  fallbackType: WorkflowValueContract['type'] = 'object',
): WorkflowValueContract | undefined {
  if (typeof value === 'string') {
    return valueContract(value)
  }
  if (!isRecord(value)) {
    return undefined
  }
  const rawType = typeof value.type === 'string' ? value.type : fallbackType
  const type = normalizeWorkflowValueType(rawType || fallbackType, fallbackType)
  return {
    ...value,
    type,
    ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
  } as WorkflowValueContract
}

function normalizeArtifactContract(
  id: string,
  value: unknown,
): WorkflowArtifactContract | undefined {
  if (!isRecord(value)) {
    if (typeof value === 'string') {
      return { id, path: value }
    }
    return undefined
  }
  return {
    id: typeof value.id === 'string' ? value.id : id,
    ...value,
  } as WorkflowArtifactContract
}

function explicitValueContracts(value: unknown): Record<string, WorkflowValueContract> {
  const raw = isRecord(value) ? value : {}
  const source = isRecord(raw.outputs)
    ? (raw.outputs as Record<string, unknown>)
    : isRecord(raw.inputs)
      ? (raw.inputs as Record<string, unknown>)
      : raw
  const contracts: Record<string, WorkflowValueContract> = {}
  for (const [key, item] of Object.entries(source)) {
    const normalized = normalizeValueContract(item)
    if (normalized) {
      contracts[key] = normalized
    }
  }
  return contracts
}

function explicitArtifactContracts(
  value: unknown,
): Record<string, WorkflowArtifactContract> {
  const raw = isRecord(value) ? value : {}
  const source = isRecord(raw.artifacts)
    ? (raw.artifacts as Record<string, unknown>)
    : raw
  const contracts: Record<string, WorkflowArtifactContract> = {}
  for (const [key, item] of Object.entries(source)) {
    const normalized = normalizeArtifactContract(key, item)
    if (normalized) {
      contracts[key] = normalized
    }
  }
  return contracts
}

function defaultOutputsForNode(
  node: MatOSWorkflowNode,
): Record<string, WorkflowValueContract> {
  switch (node.type) {
    case 'agent':
      return {
        result: valueContract('string'),
        structured: valueContract('object'),
        role: valueContract('string'),
      }
    case 'exec':
      return {
        exitCode: valueContract('number', { required: true }),
        stdout: valueContract('string'),
        stderr: valueContract('string'),
      }
    case 'guard':
      return {
        ok: valueContract('boolean', { required: true }),
        severity: valueContract('string'),
        recommendation: valueContract('string'),
        checks: valueContract('array'),
      }
    case 'backend':
      return {
        ok: valueContract('boolean', { required: true }),
        backend: valueContract('string', { required: true }),
        operation: valueContract('string'),
        jobId: valueContract('string'),
        taskId: valueContract('string'),
        status: valueContract('string'),
        artifacts: valueContract('array'),
        diagnostics: valueContract('object'),
        payload: valueContract('object'),
      }
    case 'human':
      return {
        response: valueContract('object'),
      }
    case 'subworkflow':
      return {
        childRunId: valueContract('string', { required: true }),
        status: valueContract('string', { required: true }),
        outputs: valueContract('object'),
      }
    case 'map':
      return {
        count: valueContract('number', { required: true }),
        completedCount: valueContract('number'),
        failedCount: valueContract('number'),
        iterations: valueContract('array'),
        outputs: valueContract('array'),
        failures: valueContract('array'),
        summary: valueContract('object'),
      }
    case 'loop':
      return {
        count: valueContract('number', { required: true }),
        iterations: valueContract('array'),
        outputs: valueContract('object'),
        stoppedBy: valueContract('string'),
      }
    case 'dynamic':
      return {
        patchId: valueContract('string'),
        status: valueContract('string', { required: true }),
        validation: valueContract('object'),
        candidate: valueContract('object'),
      }
    default:
      return {}
  }
}

export function normalizeWorkflowNodeContract(
  node: MatOSWorkflowNode,
): WorkflowNodeContract {
  const outputs = {
    ...defaultOutputsForNode(node),
    ...explicitValueContracts(node.outputContract),
  }
  if (isRecord(node.outputSchema)) {
    outputs.structured = valueContract('object', {
      required: true,
      schema: node.outputSchema,
      description: 'Structured JSON output validated by outputSchema.',
    })
  }

  const inputs = explicitValueContracts(node.inputContract)
  const artifacts = explicitArtifactContracts(node.artifactContract)

  return {
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
    ...(Object.keys(artifacts).length > 0 ? { artifacts } : {}),
  }
}

export function buildWorkflowContractMap(
  definition: MatOSWorkflowDefinition,
): WorkflowContractMap {
  return {
    nodes: Object.fromEntries(
      definition.nodes.map(node => [node.id, normalizeWorkflowNodeContract(node)]),
    ),
  }
}

/**
 * Returns the declared output type for an exact contract key. Nested paths
 * into object/array outputs are intentionally not typed: the checker should
 * skip rather than guess.
 */
export function workflowContractOutputTypeAtPath(
  contract: WorkflowNodeContract | undefined,
  path: string | undefined,
): string | undefined {
  if (!path) {
    return undefined
  }
  return contract?.outputs?.[path]?.type
}

/**
 * Compare a producer type against a consumer declared type. Comparison only
 * fails when both sides are confidently comparable: two known primitives or
 * two identical-domain custom qualified types. Mixed primitive/custom pairs
 * are skipped because the runtime cannot reason about custom domains.
 */
export function workflowValueTypesCompatible(
  producerType: string | undefined,
  consumerType: string | undefined,
): boolean {
  if (!producerType || !consumerType) {
    return true
  }
  const producerKnown = VALUE_TYPES.has(producerType)
  const consumerKnown = VALUE_TYPES.has(consumerType)
  if (producerKnown && consumerKnown) {
    return producerType === consumerType
  }
  if (!producerKnown && !consumerKnown) {
    return producerType === consumerType
  }
  return true
}

export function workflowContractHasOutputPath(
  contract: WorkflowNodeContract | undefined,
  path: string | undefined,
): boolean {
  if (!path) {
    return true
  }
  const outputs = contract?.outputs ?? {}
  if (outputs[path]) {
    return true
  }
  const [root] = path.split('.')
  if (!root) {
    return false
  }
  const rootContract = outputs[root]
  if (!rootContract) {
    return false
  }
  return rootContract.type === 'object' || rootContract.type === 'array'
}

export function validateWorkflowNodeContractDefinition(
  node: MatOSWorkflowNode,
): string[] {
  const errors: string[] = []
  const checkContracts = (
    label: string,
    contracts: Record<string, WorkflowValueContract> | undefined,
  ) => {
    for (const [key, contract] of Object.entries(contracts ?? {})) {
      if (!contract || typeof contract !== 'object') {
        errors.push(`${label}.${key} must be an object contract`)
        continue
      }
      if (typeof contract.type !== 'string' || contract.type.trim().length === 0) {
        errors.push(`${label}.${key}.type is required`)
        continue
      }
      if (!VALUE_TYPES.has(contract.type) && !contract.type.includes(':')) {
        errors.push(`${label}.${key}.type "${contract.type}" is not a supported primitive or qualified custom type`)
      }
    }
  }

  checkContracts('inputContract', explicitValueContracts(node.inputContract))
  checkContracts('outputContract', explicitValueContracts(node.outputContract))
  return errors
}
