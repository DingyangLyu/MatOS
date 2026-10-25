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

import type {
MatOSWorkflowDefinition,
MatOSWorkflowNode,
MatOSWorkflowOutput,
MatOSWorkflowParameter,
} from '../workflows/types.js'
import type { MatOSWorkbenchWorkflowDraftIssue } from './types.js'

import { workflowNodeManifestForType } from '../workflows/nodeManifests.js'
import {
MATOS_TO_COZE_NODE_TYPE,
asArray,
canvasIdResolver,
canvasNodeEntries,
cozeEdgeEndpoint,
cozeNodeType,
extractCozeSchema,
extractEdges,
extractTransitions,
firstString,
isRecord,
matosNodeTypeForCanvasEntry,
nativeNodeFromCanvasEntry,
outputsFromCozeFields,
paramsFromCozeFields,
recordAt
} from './workflowDraftCanvasParse.js'

function workflowNodeCanvasMatosData(node: MatOSWorkflowNode): Record<string, unknown> {
  const manifest = workflowNodeManifestForType(node.type)
  return {
    ...node,
    ...(manifest ? { manifestType: manifest.type } : {}),
    runtimeType: node.runtimeType ?? manifest?.runtimeType,
    targetType: node.targetType ?? manifest?.targetType ?? node.type,
  }
}

export function workflowDefinitionToDraftSchema(definition: MatOSWorkflowDefinition): Record<string, unknown> {
  const transitions = definition.transitions ?? []
  const stateMachine =
    definition.policy?.executionModel === 'state_machine' ||
    isRecord(definition.policy?.stateMachine)
  return {
    matos: {
      source: 'native-workflow-definition',
      name: definition.name,
      version: definition.version,
      description: definition.description,
      ...(definition.policy ? { policy: definition.policy } : {}),
      ...(stateMachine
        ? {
            executionModel: 'state_machine',
            ...(isRecord(definition.policy?.stateMachine)
              ? { stateMachine: definition.policy?.stateMachine }
              : {}),
          }
        : {}),
    },
    nodes: definition.nodes.map(node => ({
      id: node.id,
      type: MATOS_TO_COZE_NODE_TYPE[node.type] ?? String(node.type),
      data: {
        nodeMeta: {
          title: typeof node.description === 'string' ? node.description : node.id,
          ...(workflowNodeManifestForType(node.type)
            ? {
                subTitle: workflowNodeManifestForType(node.type)?.title,
              }
            : {}),
        },
        matos: workflowNodeCanvasMatosData(node),
      },
    })),
    edges: [
      ...(definition.edges ?? []).map(edge => ({
        sourceNodeID: edge.from,
        targetNodeID: edge.to,
        ...(edge.condition ? { condition: edge.condition } : {}),
        ...(edge.route ? { route: edge.route } : {}),
      })),
      ...transitions.map(transition => ({
        sourceNodeID: transition.from,
        targetNodeID: transition.to,
        transition: true,
        data: { matos_transition: transition },
      })),
    ],
    ...(transitions.length > 0 ? { transitions } : {}),
  }
}


export function startNode(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  return asArray(schema.nodes).find(
    node => isRecord(node) && (String(node.id || '').toLowerCase() === 'start' || cozeNodeType(node) === '1'),
  ) as Record<string, unknown> | undefined
}

export function endNode(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  return asArray(schema.nodes).find(
    node => isRecord(node) && (String(node.id || '').toLowerCase() === 'end' || cozeNodeType(node) === '2'),
  ) as Record<string, unknown> | undefined
}

export function inferParameters(
  schema: Record<string, unknown>,
  request: Record<string, unknown>,
  currentDefinition?: MatOSWorkflowDefinition,
): Record<string, MatOSWorkflowParameter> {
  const start = startNode(schema)
  // data.outputs is the location the Coze start-node form actually edits;
  // trigger_parameters is the untouched mirror the forward projection writes.
  const candidates = [
    recordAt(start, 'data')?.outputs,
    recordAt(start, 'data')?.trigger_parameters,
    recordAt(schema, 'workflow')?.inputs,
    recordAt(schema, 'workflow')?.parameters,
    recordAt(schema, 'matos')?.inputs,
    recordAt(schema, 'matos')?.parameters,
    request.inputs,
    request.input,
    recordAt(request, 'workflow')?.inputs,
    recordAt(request, 'workflow')?.parameters,
  ]
  for (const candidate of candidates) {
    const params = paramsFromCozeFields(candidate, {
      ...(currentDefinition?.parameters ? { currentSpecs: currentDefinition.parameters } : {}),
    })
    if (Object.keys(params).length > 0) {
      return params
    }
  }
  return {}
}

export function inferOutputs(
  schema: Record<string, unknown>,
  request: Record<string, unknown>,
  currentDefinition?: MatOSWorkflowDefinition,
): Record<string, MatOSWorkflowOutput> {
  const end = endNode(schema)
  const candidates = [
    recordAt(end, 'data', 'inputs')?.inputParameters,
    recordAt(end, 'data')?.inputs,
    recordAt(schema, 'workflow')?.outputs,
    recordAt(schema, 'matos')?.outputs,
    request.outputs,
    recordAt(request, 'workflow')?.outputs,
  ]
  for (const candidate of candidates) {
    const outputs = outputsFromCozeFields(candidate, {
      ...(currentDefinition?.outputs ? { currentSpecs: currentDefinition.outputs } : {}),
    })
    if (Object.keys(outputs).length > 0) {
      return outputs
    }
  }
  return {}
}

export function canvasPolicy(
  schema: Record<string, unknown>,
  request: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const candidate of [
    recordAt(schema, 'matos', 'policy'),
    recordAt(schema, 'workflow', 'policy'),
    recordAt(schema, 'policy'),
    recordAt(request, 'policy'),
    recordAt(request, 'workflow', 'policy'),
  ]) {
    if (candidate && Object.keys(candidate).length > 0) {
      return candidate
    }
  }
  return undefined
}

/**
 * The executionModel the canvas explicitly declares, if any. An explicit
 * 'dag' must win over leftover stateMachine config blocks and over the
 * current definition so the canvas can toggle a state machine off.
 */
export function canvasDeclaredExecutionModel(
  schema: Record<string, unknown>,
  declaredPolicy: Record<string, unknown> | undefined,
): 'dag' | 'state_machine' | undefined {
  const declared = firstString(
    declaredPolicy?.executionModel,
    recordAt(schema, 'matos')?.executionModel,
    recordAt(schema, 'matos', 'policy')?.executionModel,
  )
  return declared === 'dag' || declared === 'state_machine' ? declared : undefined
}

export function isStateMachineCanvas(
  schema: Record<string, unknown>,
  policy: Record<string, unknown> | undefined,
): boolean {
  if (policy && String(policy.executionModel ?? '') === 'state_machine') {
    return true
  }
  if (
    policy &&
    isRecord(policy.stateMachine) &&
    String(policy.executionModel ?? '') !== 'dag'
  ) {
    return true
  }
  const matos = recordAt(schema, 'matos')
  if (matos && String(matos.executionModel ?? '') === 'state_machine') {
    return true
  }
  return Boolean(matos && isRecord(matos.stateMachine))
}

export function canvasStartTarget(
  schema: Record<string, unknown>,
  nodeIds: Set<string>,
  resolveId: (id: string) => string = id => id,
): string | undefined {
  for (const raw of asArray(schema.edges)) {
    if (!isRecord(raw)) {
      continue
    }
    const from = cozeEdgeEndpoint(raw, true)
    const to = resolveId(cozeEdgeEndpoint(raw, false) ?? '')
    if (from === 'start' && to && nodeIds.has(to)) {
      return to
    }
  }
  return undefined
}

export function stateMachinePolicyFromCanvas(input: {
  schema: Record<string, unknown>
  policy: Record<string, unknown> | undefined
  nodes: MatOSWorkflowNode[]
  nodeIds: Set<string>
  issues: MatOSWorkbenchWorkflowDraftIssue[]
  currentDefinition?: MatOSWorkflowDefinition
  resolveId?: (id: string) => string
}): Record<string, unknown> {
  const resolveId = input.resolveId ?? ((id: string) => id)
  const declared =
    (input.policy && isRecord(input.policy.stateMachine)
      ? input.policy.stateMachine
      : undefined) ??
    recordAt(input.schema, 'matos', 'stateMachine') ??
    (isRecord(input.currentDefinition?.policy?.stateMachine)
      ? (input.currentDefinition?.policy?.stateMachine as unknown as Record<string, unknown>)
      : undefined) ??
    {}
  const declaredInitialRaw = firstString(declared.initialNodeId)
  const declaredInitial = declaredInitialRaw ? resolveId(declaredInitialRaw) : undefined
  const initialNodeId =
    declaredInitial && input.nodeIds.has(declaredInitial)
      ? declaredInitial
      : canvasStartTarget(input.schema, input.nodeIds, resolveId) ?? input.nodes[0]?.id
  if (declaredInitial && !input.nodeIds.has(declaredInitial)) {
    input.issues.push({
      severity: 'warning',
      code: 'state_machine_initial_node_missing',
      message: `Declared state-machine initial node "${declaredInitial}" is not on the canvas; using "${initialNodeId ?? ''}" instead.`,
    })
  }
  const maxTransitions =
    typeof declared.maxTransitions === 'number' && Number.isInteger(declared.maxTransitions) && declared.maxTransitions > 0
      ? declared.maxTransitions
      : 16
  return {
    ...declared,
    ...(initialNodeId ? { initialNodeId } : {}),
    maxTransitions,
  }
}

export function currentDefinitionIsStateMachine(
  definition: MatOSWorkflowDefinition | undefined,
): boolean {
  if (!definition) {
    return false
  }
  if (definition.policy?.executionModel === 'dag') {
    return false
  }
  return (
    definition.policy?.executionModel === 'state_machine' ||
    isRecord(definition.policy?.stateMachine)
  )
}

export function definitionFromCozeCanvas(
  request: Record<string, unknown>,
  issues: MatOSWorkbenchWorkflowDraftIssue[],
  currentDefinition?: MatOSWorkflowDefinition,
): {
  definition: MatOSWorkflowDefinition
  schema: Record<string, unknown>
  ignoredNodeCount: number
} {
  const schema = extractCozeSchema(request)
  const entries = canvasNodeEntries(schema)
  const resolveId = canvasIdResolver(entries)
  const currentNodeById = new Map(
    (currentDefinition?.nodes ?? []).map(node => [node.id, node]),
  )
  const nodes: MatOSWorkflowNode[] = []
  const canvasPositions: Record<string, { x: number; y: number }> = {}
  const explicitDependsOnIds = new Set<string>()
  for (const entry of entries) {
    const currentNode =
      currentNodeById.get(entry.finalId) ?? currentNodeById.get(entry.canvasId)
    const type = matosNodeTypeForCanvasEntry(entry, currentNode, issues)
    if (!type) {
      continue
    }
    const { node, hasExplicitDependsOn } = nativeNodeFromCanvasEntry({
      entry,
      type,
      resolveId,
      ...(currentNode ? { currentNode } : {}),
    })
    nodes.push(node)
    if (hasExplicitDependsOn) {
      explicitDependsOnIds.add(node.id)
    }
    if (entry.position) {
      canvasPositions[node.id] = entry.position
    }
  }
  const nodeIds = new Set(nodes.map(node => node.id))
  const declaredPolicy = canvasPolicy(schema, request)
  const declaredExecutionModel = canvasDeclaredExecutionModel(schema, declaredPolicy)
  const policyFromCanvas =
    declaredPolicy
      ? {
          ...declaredPolicy,
          ...(declaredExecutionModel ? { executionModel: declaredExecutionModel } : {}),
        }
      : declaredExecutionModel
        ? { executionModel: declaredExecutionModel }
        : (currentDefinition?.policy
          ? (currentDefinition.policy as unknown as Record<string, unknown>)
          : undefined)
  const stateMachine =
    declaredExecutionModel === 'dag'
      ? false
      : declaredExecutionModel === 'state_machine'
        ? true
        : isStateMachineCanvas(schema, policyFromCanvas) ||
          currentDefinitionIsStateMachine(currentDefinition)
  const canvasEdges = extractEdges(schema, nodeIds, { stateMachine, resolveId })
  // Canvas edges without explicit condition/route metadata inherit them from
  // the matching current-definition edge: frontends that strip edge data must
  // not silently drop routing. Explicitly annotated (or cleared) edges win.
  const currentEdgeByPair = new Map(
    (currentDefinition?.edges ?? []).map(edge => [
      `${resolveId(edge.from)}->${resolveId(edge.to)}`,
      edge,
    ]),
  )
  const edges = canvasEdges.map(({ edge, explicit }) => {
    if (explicit) {
      return edge
    }
    const inherited = currentEdgeByPair.get(`${edge.from}->${edge.to}`)
    if (!inherited) {
      return edge
    }
    return {
      ...edge,
      ...(inherited.condition !== undefined ? { condition: inherited.condition } : {}),
      ...(inherited.route !== undefined ? { route: inherited.route } : {}),
    }
  })
  const transitions = extractTransitions(schema, nodeIds, {
    stateMachine,
    resolveId,
    ...(currentDefinition ? { currentDefinition } : {}),
  })
  const dependsByTarget = new Map<string, Set<string>>()
  for (const edge of edges) {
    const deps = dependsByTarget.get(edge.to) ?? new Set<string>()
    deps.add(edge.from)
    dependsByTarget.set(edge.to, deps)
  }
  // With a live edge surface the canvas is authoritative for dependencies:
  // deleting an edge must actually remove the dependency, so stale rendered
  // `data.matos.dependsOn` entries are not resurrected. Node-only payloads
  // (no edge surface) keep the explicit form-declared dependsOn.
  const hasCanvasEdges = Array.isArray(schema.edges)
  const normalizedNodes = nodes.map(node => ({
    ...node,
    dependsOn: stateMachine
      ? []
      : hasCanvasEdges
        ? Array.from(dependsByTarget.get(node.id) ?? [])
        : explicitDependsOnIds.has(node.id)
          ? node.dependsOn
          : [...new Set([...node.dependsOn, ...Array.from(dependsByTarget.get(node.id) ?? [])])],
  }))
  const schemaMatos = recordAt(schema, 'matos')
  const name = firstString(
    request.name,
    recordAt(request, 'workflow')?.name,
    recordAt(request, 'data', 'workflow')?.name,
    schemaMatos?.name,
    recordAt(schema, 'matos')?.ref,
    request.workflow_id,
    'Coze draft workflow',
  ) ?? 'Coze draft workflow'
  const version = firstString(
    request.version,
    request.save_version,
    request.flow_version,
    recordAt(request, 'workflow')?.save_version,
    schemaMatos?.version,
  )
  const policy: Record<string, unknown> = {
    approvalMode: 'bypass',
    defaultRisk: 'low',
    ...(policyFromCanvas ?? {}),
  }
  if (stateMachine) {
    policy.executionModel = 'state_machine'
    policy.stateMachine = stateMachinePolicyFromCanvas({
      schema,
      policy: policyFromCanvas,
      nodes: normalizedNodes,
      nodeIds,
      issues,
      resolveId,
      ...(currentDefinition ? { currentDefinition } : {}),
    })
  } else if (declaredExecutionModel === 'dag') {
    policy.executionModel = 'dag'
    delete policy.stateMachine
  }
  const inferredParameters = inferParameters(schema, request)
  const parameters =
    Object.keys(inferredParameters).length === 0 &&
    currentDefinition &&
    Object.keys(currentDefinition.parameters ?? {}).length > 0
      ? currentDefinition.parameters
      : inferredParameters
  const inferredOutputs = inferOutputs(schema, request)
  const outputs =
    Object.keys(inferredOutputs).length === 0 &&
    currentDefinition &&
    Object.keys(currentDefinition.outputs ?? {}).length > 0
      ? currentDefinition.outputs
      : inferredOutputs
  return {
    schema,
    ignoredNodeCount: asArray(schema.nodes).length - nodes.length,
    definition: {
      schemaVersion: 1,
      name,
      ...(version ? { version } : {}),
      description: firstString(
        request.desc,
        request.description,
        recordAt(request, 'workflow')?.desc,
        schemaMatos?.description,
      ),
      parameters,
      policy: policy as MatOSWorkflowDefinition['policy'],
      nodes: normalizedNodes,
      edges: stateMachine ? [] : edges,
      ...(transitions.length > 0 ? { transitions } : {}),
      outputs,
      ...(Object.keys(canvasPositions).length > 0
        ? { canvas: { nodes: canvasPositions } }
        : {}),
    },
  }
}
