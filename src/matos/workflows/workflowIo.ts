/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'node:crypto'
import type { MatOSTraceContext } from '../sessions/traceContext.js'
import {
  buildWorkflowContractMap,
  normalizeWorkflowNodeContract,
} from './workflowContracts.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import {
  normalizeWorkflowValueType,
  workflowRuntimeTypeForNodeType,
  workflowTargetTypeForNodeType,
} from './nodeManifests.js'
import type {
  ComputeJobReceipt,
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeStatus,
  MatOSWorkflowRunProvenance,
  MatOSWorkflowRuntimeNodeType,
  MatOSWorkflowTargetNodeType,
  WorkflowArtifactContract,
  WorkflowArtifactRef,
  WorkflowContractMap,
  WorkflowNodeContract,
  WorkflowValueContract,
} from './types.js'

export type MatOSWorkflowArtifactReference = WorkflowArtifactRef

export type MatOSWorkflowNodeInputs = {
  parameters: Record<string, unknown>
  bindings: Record<string, unknown>
  contracts: Record<string, WorkflowValueContract>
  dependencyNodeIds: string[]
  missingRequiredKeys: string[]
}

export type MatOSWorkflowNodeValidationResult = {
  ok: boolean
  severity: 'info' | 'warning' | 'error'
  checks: Array<{
    id: string
    type: string
    ok: boolean
    observed?: unknown
    expected?: unknown
    evidence?: WorkflowArtifactRef[]
    error?: string
    code?: string
    message?: string
    hint?: string
    retryable?: boolean
    sourceNodeId?: string
  }>
  recommendation: 'continue' | 'retry' | 'reroute' | 'human_review' | 'fail'
}

export type MatOSWorkflowComputeJobReceipt = ComputeJobReceipt & {
  statusTimeline?: Array<{
    at: string
    state: string
    source: 'submit' | 'status' | 'logs' | 'cancel' | 'reconcile' | 'runtime'
  }>
  reconcileState?: 'not_needed' | 'pending' | 'ok' | 'failed'
  cancelState?: 'not_requested' | 'pending' | 'ok' | 'failed'
}

export type MatOSWorkflowNodeOutputs = {
  values: Record<string, unknown>
  contracts: Record<string, WorkflowValueContract>
  artifacts: WorkflowArtifactRef[]
  artifactContracts: Record<string, WorkflowArtifactContract>
  validation?: MatOSWorkflowNodeValidationResult
  computeReceipt?: MatOSWorkflowComputeJobReceipt
  diagnostics?: Record<string, unknown>
}

export type MatOSWorkflowNodeAttemptRecord = {
  nodeId: string
  attempt: number
  status: MatOSWorkflowNodeStatus
  startedAt?: string
  finishedAt?: string
  inputDigest?: string
  outputDigest?: string
  artifactRefs: WorkflowArtifactRef[]
  diagnostics?: Record<string, unknown>
  trace?: MatOSTraceContext
  provenance?: MatOSWorkflowRunProvenance
}

export type MatOSWorkflowNodeIoProtocol = {
  nodeId: string
  type: string
  runtimeType?: MatOSWorkflowRuntimeNodeType
  targetType?: MatOSWorkflowTargetNodeType
  dependsOn: string[]
  inputs: Record<string, WorkflowValueContract>
  outputs: Record<string, WorkflowValueContract>
  artifacts: Record<string, WorkflowArtifactContract>
  missingRequiredInputKeys: string[]
  sideEffectClass?:
    | 'none'
    | 'model_call'
    | 'local_process'
    | 'external_backend'
    | 'human_input'
    | 'child_workflow'
    | 'iteration_children'
    | 'graph_patch'
}

export type MatOSWorkflowRunIoProtocol = {
  schemaVersion: 1
  source: 'matos-workflow-io'
  parameterContract: Record<string, WorkflowValueContract>
  contracts: WorkflowContractMap
  nodes: MatOSWorkflowNodeIoProtocol[]
  artifactContracts: Array<{
    nodeId: string
    artifactId: string
    contract: WorkflowArtifactContract
  }>
}

export type MatOSWorkflowRunPreflight = {
  ok: boolean
  canRun: boolean
  validation: ReturnType<typeof validateWorkflowDefinition>
  missingRequiredParameters: string[]
  missingNodeInputs: Array<{
    nodeId: string
    key: string
    severity: 'warning' | 'error'
    reason: string
  }>
  summary: {
    nodeCount: number
    edgeCount: number
    firstNodeIds: string[]
    risk: string
    approvalMode: string
    agentNodeCount: number
    computeNodeCount: number
    humanNodeCount: number
    approvalGateCount: number
    backendNodeCount: number
    codeNodeCount: number
    artifactContractCount: number
    confirmationRecommended: boolean
  }
  prompts: Array<{
    kind: 'missing_parameter' | 'missing_node_input' | 'confirmation'
    message: string
    field?: string
    nodeId?: string
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function workflowIoDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function contractFromParameter(parameter: Record<string, unknown>): WorkflowValueContract {
  const type = typeof parameter.type === 'string' && parameter.type.trim()
    ? normalizeWorkflowValueType(parameter.type.trim(), 'string')
    : 'string'
  return {
    type,
    ...(typeof parameter.required === 'boolean' ? { required: parameter.required } : {}),
    ...(typeof parameter.description === 'string' ? { description: parameter.description } : {}),
    ...(parameter.schema !== undefined ? { schema: parameter.schema } : {}),
  }
}

export function workflowParameterContract(
  definition: MatOSWorkflowDefinition,
): Record<string, WorkflowValueContract> {
  return Object.fromEntries(
    Object.entries(definition.parameters).map(([key, parameter]) => [
      key,
      contractFromParameter(parameter),
    ]),
  )
}

function nodeRuntimeType(node: MatOSWorkflowNode): MatOSWorkflowRuntimeNodeType | undefined {
  return node.runtimeType ?? workflowRuntimeTypeForNodeType(node.type)
}

function nodeTargetType(node: MatOSWorkflowNode): MatOSWorkflowTargetNodeType | undefined {
  return node.targetType ?? workflowTargetTypeForNodeType(node.type)
}

function nodeSideEffectClass(node: MatOSWorkflowNode): MatOSWorkflowNodeIoProtocol['sideEffectClass'] {
  if (node.policy?.sideEffect && isRecord(node.policy.sideEffect)) {
    const sideEffectClass = node.policy.sideEffect.class
    if (typeof sideEffectClass === 'string') {
      return sideEffectClass as MatOSWorkflowNodeIoProtocol['sideEffectClass']
    }
  }
  if (nodeTargetType(node) === 'compute') {
    return 'external_backend'
  }
  switch (nodeRuntimeType(node)) {
    case 'agent':
      return 'model_call'
    case 'exec':
      return 'local_process'
    case 'backend':
      return 'external_backend'
    case 'human':
      return 'human_input'
    case 'subworkflow':
      return 'child_workflow'
    case 'map':
    case 'loop':
      return 'iteration_children'
    case 'dynamic':
      return 'graph_patch'
    default:
      return 'none'
  }
}

function nodeInputBindings(node: MatOSWorkflowNode): Record<string, unknown> {
  const bindings: Record<string, unknown> = {}
  for (const key of ['inputs', 'input', 'parameters']) {
    const value = node[key]
    if (isRecord(value)) {
      Object.assign(bindings, value)
    }
  }
  return bindings
}

export function workflowMissingRequiredNodeInputs(
  node: MatOSWorkflowNode,
  contract: WorkflowNodeContract = normalizeWorkflowNodeContract(node),
): string[] {
  const bindings = nodeInputBindings(node)
  return Object.entries(contract.inputs ?? {})
    .filter(([key, value]) => value.required === true && bindings[key] === undefined && node[key] === undefined)
    .map(([key]) => key)
}

export function workflowNodeIoProtocol(node: MatOSWorkflowNode): MatOSWorkflowNodeIoProtocol {
  const contract = normalizeWorkflowNodeContract(node)
  return {
    nodeId: node.id,
    type: node.type,
    ...(nodeRuntimeType(node) ? { runtimeType: nodeRuntimeType(node) } : {}),
    ...(nodeTargetType(node) ? { targetType: nodeTargetType(node) } : {}),
    dependsOn: [...node.dependsOn],
    inputs: contract.inputs ?? {},
    outputs: contract.outputs ?? {},
    artifacts: contract.artifacts ?? {},
    missingRequiredInputKeys: workflowMissingRequiredNodeInputs(node, contract),
    sideEffectClass: nodeSideEffectClass(node),
  }
}

export function buildWorkflowRunIoProtocol(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowRunIoProtocol {
  const nodes = definition.nodes.map(workflowNodeIoProtocol)
  return {
    schemaVersion: 1,
    source: 'matos-workflow-io',
    parameterContract: workflowParameterContract(definition),
    contracts: buildWorkflowContractMap(definition),
    nodes,
    artifactContracts: nodes.flatMap(node =>
      Object.entries(node.artifacts).map(([artifactId, contract]) => ({
        nodeId: node.nodeId,
        artifactId,
        contract,
      })),
    ),
  }
}

function firstNodeIds(definition: MatOSWorkflowDefinition): string[] {
  const targets = new Set<string>()
  for (const edge of definition.edges ?? []) {
    targets.add(edge.to)
  }
  for (const node of definition.nodes) {
    if (node.dependsOn.length > 0) {
      targets.add(node.id)
    }
  }
  return definition.nodes.filter(node => !targets.has(node.id)).map(node => node.id)
}

export function buildWorkflowRunPreflight(input: {
  definition: MatOSWorkflowDefinition
  missingRequiredParameters: string[]
}): MatOSWorkflowRunPreflight {
  const validation = validateWorkflowDefinition(input.definition)
  const io = buildWorkflowRunIoProtocol(input.definition)
  const nodeRuntimeTypes = input.definition.nodes.map(node => nodeRuntimeType(node) ?? node.type)
  const nodeTargetTypes = input.definition.nodes.map(node => nodeTargetType(node) ?? node.type)
  const missingNodeInputs: MatOSWorkflowRunPreflight['missingNodeInputs'] = io.nodes.flatMap(node =>
    node.missingRequiredInputKeys.map(key => ({
      nodeId: node.nodeId,
      key,
      severity: 'warning' as const,
      reason: 'Required node input contract has no explicit binding in the workflow definition.',
    })),
  )
  const risk = String(input.definition.policy.defaultRisk ?? 'low')
  const approvalMode = String(input.definition.policy.approvalMode ?? 'ask')
  const computeNodeCount = nodeTargetTypes.filter(type => type === 'compute').length
  const backendNodeCount = nodeRuntimeTypes.filter(type => type === 'backend').length
  const approvalGateCount = nodeTargetTypes.filter(type => type === 'approval_gate').length
  const humanNodeCount = nodeRuntimeTypes.filter(type => type === 'human').length
  const confirmationRecommended =
    risk === 'high' ||
    approvalMode === 'strict' ||
    approvalGateCount > 0 ||
    computeNodeCount > 0 ||
    backendNodeCount > 0
  const prompts: MatOSWorkflowRunPreflight['prompts'] = [
    ...input.missingRequiredParameters.map(field => ({
      kind: 'missing_parameter' as const,
      field,
      message: `Workflow parameter "${field}" is required before run.`,
    })),
    ...missingNodeInputs.map(item => ({
      kind: 'missing_node_input' as const,
      field: item.key,
      nodeId: item.nodeId,
      message: `Node "${item.nodeId}" declares required input "${item.key}" without an explicit binding.`,
    })),
    ...(confirmationRecommended
      ? [{
          kind: 'confirmation' as const,
          message: 'Confirm workflow run because it includes compute/backend, approval, or elevated-risk steps.',
        }]
      : []),
  ]
  const canRun = validation.ok && input.missingRequiredParameters.length === 0
  return {
    ok: canRun && missingNodeInputs.every(item => item.severity !== 'error'),
    canRun,
    validation,
    missingRequiredParameters: input.missingRequiredParameters,
    missingNodeInputs,
    summary: {
      nodeCount: input.definition.nodes.length,
      edgeCount: input.definition.edges?.length ?? 0,
      firstNodeIds: firstNodeIds(input.definition),
      risk,
      approvalMode,
      agentNodeCount: nodeRuntimeTypes.filter(type => type === 'agent').length,
      computeNodeCount,
      humanNodeCount,
      approvalGateCount,
      backendNodeCount,
      codeNodeCount: nodeRuntimeTypes.filter(type => type === 'exec').length,
      artifactContractCount: io.artifactContracts.length,
      confirmationRecommended,
    },
    prompts,
  }
}
