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
  MatOSWorkflowValidationError,
  WorkflowContractMap,
} from './types.js'
import {
  buildWorkflowContractMap,
  workflowContractHasOutputPath,
  workflowContractOutputTypeAtPath,
  workflowValueTypesCompatible,
} from './workflowContracts.js'
import {
  extractWorkflowTemplateExpressions,
  isSupportedLoopMetadataPath,
  isSupportedWorkflowMetadataPath,
  parseWorkflowReferenceExpression,
  type WorkflowTemplateExpression,
} from './workflowReferences.js'

type ReferenceScope = {
  path: string
  value: unknown
  targetNodeId?: string
  allowCurrentNode?: boolean
  allowLoopContext?: boolean
  outputId?: string
  /**
   * True for node input carriers (`input`, `toolInput`, `parameters`) where
   * an exact template reference preserves the producer value type and can be
   * checked against the consumer's declared inputContract.
   */
  typedInputCarrier?: boolean
}

export type WorkflowReferenceValidationOptions = {
  knownParameterIds?: Iterable<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pushError(
  errors: MatOSWorkflowValidationError[],
  code: MatOSWorkflowValidationError['code'],
  message: string,
  details: Pick<MatOSWorkflowValidationError, 'nodeId' | 'path'> = {},
): void {
  errors.push({ code, message, ...details })
}

function directDependencyGraph(
  definition: MatOSWorkflowDefinition,
): Map<string, Set<string>> {
  return new Map(
    definition.nodes.map(node => [node.id, new Set(node.dependsOn ?? [])]),
  )
}

function transitiveDependencies(
  graph: Map<string, Set<string>>,
  nodeId: string,
): Set<string> {
  const found = new Set<string>()
  const visit = (current: string) => {
    for (const dependency of graph.get(current) ?? []) {
      if (found.has(dependency)) {
        continue
      }
      found.add(dependency)
      visit(dependency)
    }
  }
  visit(nodeId)
  return found
}

function fieldScopesForNode(node: MatOSWorkflowNode): ReferenceScope[] {
  const scopes: ReferenceScope[] = []
	  const add = (
	    field: string,
	    value: unknown,
	    options: {
	      allowCurrentNode?: boolean
	      allowLoopContext?: boolean
	      typedInputCarrier?: boolean
	    } = {},
	  ) => {
    if (value !== undefined) {
      scopes.push({
        path: `nodes.${node.id}.${field}`,
        value,
        targetNodeId: node.id,
        allowCurrentNode: options.allowCurrentNode,
        allowLoopContext: options.allowLoopContext,
        typedInputCarrier: options.typedInputCarrier,
      })
    }
  }

  add('prompt', node.prompt)
  add('systemPrompt', node.systemPrompt)
  add('command', node.command)
  add('args', node.args)
  add('cwd', node.cwd)
  add('env', node.env)
  add('checks', node.checks)
  add('input', node.input, { typedInputCarrier: true })
  add('inputs', node.inputs, { typedInputCarrier: true })
  add('toolInput', node.toolInput, { typedInputCarrier: true })
  add('parameters', node.parameters, { typedInputCarrier: true })
  add('items', node.items)
  add('candidate', node.candidate)
  add('passthroughArgs', node.passthroughArgs)
  add('responseSchema', node.responseSchema)
  add('computeLifecycle', node.computeLifecycle)
  add('outputKeys', node.outputKeys)
  add('outputs', node.outputs)
  add('artifactContract', node.artifactContract)
  add('initialState', node.initialState)
  add('nextParameters', node.nextParameters, {
    allowCurrentNode: node.type === 'loop',
    allowLoopContext: node.type === 'loop',
    typedInputCarrier: true,
  })
  add('nextState', node.nextState, {
    allowCurrentNode: node.type === 'loop',
    allowLoopContext: node.type === 'loop',
  })
  add('until', node.until, {
    allowCurrentNode: node.type === 'loop',
    allowLoopContext: node.type === 'loop',
  })
  return scopes
}

function transitionScopes(definition: MatOSWorkflowDefinition): ReferenceScope[] {
  return (definition.transitions ?? []).flatMap((transition, index) => {
    const scopes: ReferenceScope[] = []
    if (typeof transition.guard === 'string') {
      scopes.push({
        path: `transitions[${index}].guard`,
        value: transition.guard,
        targetNodeId: transition.from,
      })
    }
    if (transition.reducer !== undefined) {
      scopes.push({
        path: `transitions[${index}].reducer`,
        value: transition.reducer,
        targetNodeId: transition.from,
      })
    }
    return scopes
  })
}

function edgeScopes(definition: MatOSWorkflowDefinition): ReferenceScope[] {
  return (definition.edges ?? [])
    .filter(edge => typeof edge.condition === 'string')
    .map(edge => ({
      path: `edges.${edge.from}->${edge.to}.condition`,
      value: edge.condition,
      targetNodeId: edge.to,
    }))
}

function outputScopes(definition: MatOSWorkflowDefinition): ReferenceScope[] {
  return Object.entries(definition.outputs).map(([outputId, output]) => ({
    path: `outputs.${outputId}`,
    value: output,
    outputId,
  }))
}

function outputLabel(scope: ReferenceScope): string {
  return scope.outputId ? `Output "${scope.outputId}"` : `Field "${scope.path}"`
}

function consumerDeclaredInputType(input: {
  definition: MatOSWorkflowDefinition
  contracts: WorkflowContractMap
  expression: WorkflowTemplateExpression
  scope: ReferenceScope
}): string | undefined {
  if (!input.scope.typedInputCarrier || input.expression.exact !== true) {
    return undefined
  }
  const targetNodeId = input.scope.targetNodeId
  if (!targetNodeId) {
    return undefined
  }
  const node = input.definition.nodes.find(item => item.id === targetNodeId)
  if (!node || !isRecord(node.inputContract)) {
    return undefined
  }
  const prefix = `${input.scope.path}.`
  if (!input.expression.path.startsWith(prefix)) {
    return undefined
  }
  const relativeKey = input.expression.path.slice(prefix.length)
  if (!relativeKey) {
    return undefined
  }
  return input.contracts.nodes[targetNodeId]?.inputs?.[relativeKey]?.type
}

function checkConsumerTypeCompatibility(input: {
  definition: MatOSWorkflowDefinition
  contracts: WorkflowContractMap
  expression: WorkflowTemplateExpression
  scope: ReferenceScope
  errors: MatOSWorkflowValidationError[]
  producerType: string | undefined
  producerLabel: string
}): void {
  const consumerType = consumerDeclaredInputType(input)
  if (!consumerType || !input.producerType) {
    return
  }
  if (workflowValueTypesCompatible(input.producerType, consumerType)) {
    return
  }
  pushError(
    input.errors,
    'contract_type_mismatch',
    `Node "${input.scope.targetNodeId ?? ''}" declares input type "${consumerType}" at "${input.expression.path}" but ${input.producerLabel} provides "${input.producerType}"`,
    {
      nodeId: input.scope.targetNodeId,
      path: input.expression.path || input.scope.path,
    },
  )
}

function workflowContractHasArtifact(
  contract: WorkflowContractMap['nodes'][string] | undefined,
  artifactId: string | undefined,
): boolean {
  if (!artifactId) {
    return true
  }
  return Object.entries(contract?.artifacts ?? {}).some(
    ([key, artifact]) => key === artifactId || artifact.id === artifactId,
  )
}

function validateReferenceExpression(input: {
  definition: MatOSWorkflowDefinition
  contracts: WorkflowContractMap
  expression: WorkflowTemplateExpression
  scope: ReferenceScope
  nodeIds: Set<string>
  parameterIds: Set<string>
  upstreamByNode: Map<string, Set<string>>
  errors: MatOSWorkflowValidationError[]
}): void {
  const reference = parseWorkflowReferenceExpression(input.expression.expression)
  const label = outputLabel(input.scope)

  if (reference.kind === 'unknown') {
    pushError(
      input.errors,
      input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
      `${label} uses unsupported template "${reference.expression}". Use {{ nodes.<nodeId>.outputs.<field> }}, {{ nodes.<nodeId>.artifacts.<artifactId>.path }}, {{ parameters.<name> }}, {{ workflow.artifactRoot }}, or {{ workflow.workspaceDir }}.`,
      {
        nodeId: input.scope.targetNodeId,
        path: input.expression.path || input.scope.path,
      },
    )
    return
  }

  if (reference.kind === 'parameter') {
    const parameterId = (reference.parameterPath ?? '').split('.')[0] ?? ''
    if (parameterId && !input.parameterIds.has(parameterId)) {
      pushError(
        input.errors,
        input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
        `${label} references missing parameter "${parameterId}"`,
        {
          nodeId: input.scope.targetNodeId,
          path: input.expression.path || input.scope.path,
        },
      )
      return
    }
    const declared = input.definition.parameters[parameterId]
    const isWholeParameter = reference.parameterPath === parameterId
    if (isWholeParameter && typeof declared?.type === 'string') {
      checkConsumerTypeCompatibility({
        ...input,
        producerType: declared.type,
        producerLabel: `parameter "${parameterId}"`,
      })
    }
    return
  }

  if (reference.kind === 'workflowMetadata') {
    if (!isSupportedWorkflowMetadataPath(reference.metadataPath)) {
      pushError(
        input.errors,
        input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
        `${label} references unsupported workflow metadata "${reference.metadataPath ?? ''}".`,
        {
          nodeId: input.scope.targetNodeId,
          path: input.expression.path || input.scope.path,
        },
      )
    }
    return
  }

  if (reference.kind === 'loopMetadata') {
    if (!input.scope.allowLoopContext) {
      pushError(
        input.errors,
        input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
        `${label} uses loop metadata outside a loop-local field.`,
        {
          nodeId: input.scope.targetNodeId,
          path: input.expression.path || input.scope.path,
        },
      )
      return
    }
    if (!isSupportedLoopMetadataPath(reference.metadataPath)) {
      pushError(
        input.errors,
        input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
        `${label} references unsupported loop metadata "${reference.metadataPath ?? ''}".`,
        {
          nodeId: input.scope.targetNodeId,
          path: input.expression.path || input.scope.path,
        },
      )
    }
    return
  }

  const referencedNodeId = reference.nodeId
  const currentNodeAllowed =
    referencedNodeId === 'current' && input.scope.allowCurrentNode
  if (!currentNodeAllowed && !input.nodeIds.has(referencedNodeId)) {
    pushError(
      input.errors,
      input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
      `${label} references missing node "${referencedNodeId}"`,
      {
        nodeId: input.scope.targetNodeId,
        path: input.expression.path || input.scope.path,
      },
    )
    return
  }

  if (
    input.scope.targetNodeId &&
    !currentNodeAllowed &&
    referencedNodeId !== input.scope.targetNodeId &&
    !input.upstreamByNode.get(input.scope.targetNodeId)?.has(referencedNodeId)
  ) {
    pushError(
      input.errors,
      'invalid_reference',
      `Node "${input.scope.targetNodeId}" references "${referencedNodeId}" before it is available`,
      {
        nodeId: input.scope.targetNodeId,
        path: input.expression.path || input.scope.path,
      },
    )
    return
  }

  if (reference.kind === 'nodeOutput' && !currentNodeAllowed) {
    const producerContract = input.contracts.nodes[referencedNodeId]
    if (
      !workflowContractHasOutputPath(producerContract, reference.outputPath)
    ) {
      // Listing what IS declared turns this from a guessing loop into a
      // one-shot repair: agents routinely reference intuitive-but-wrong keys
      // (e.g. `response` on an agent node whose contract exposes `result`).
      const declared = Object.keys(producerContract?.outputs ?? {})
      pushError(
        input.errors,
        input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
        `${label} references undeclared output "${reference.outputPath}" on node "${referencedNodeId}"` +
          (declared.length > 0
            ? ` (declared outputs: ${declared.join(', ')})`
            : '') +
          '. Reference a declared output, or declare the key on that node via outputContract (agent nodes may also declare structured keys via outputSchema).',
        {
          nodeId: input.scope.targetNodeId,
          path: input.expression.path || input.scope.path,
        },
      )
      return
    }
    checkConsumerTypeCompatibility({
      ...input,
      producerType: workflowContractOutputTypeAtPath(
        producerContract,
        reference.outputPath,
      ),
      producerLabel: `node "${referencedNodeId}" output "${reference.outputPath ?? ''}"`,
    })
  }

  if (reference.kind === 'nodeArtifact' && !currentNodeAllowed) {
    const producerContract = input.contracts.nodes[referencedNodeId]
    if (!workflowContractHasArtifact(producerContract, reference.artifactId)) {
      pushError(
        input.errors,
        input.scope.outputId ? 'invalid_output_reference' : 'invalid_reference',
        `${label} references undeclared artifact "${reference.artifactId ?? ''}" on node "${referencedNodeId}"`,
        {
          nodeId: input.scope.targetNodeId,
          path: input.expression.path || input.scope.path,
        },
      )
      return
    }
    checkConsumerTypeCompatibility({
      ...input,
      producerType: reference.artifactPath === 'path' ? 'string' : 'object',
      producerLabel: `node "${referencedNodeId}" artifact "${reference.artifactId ?? ''}"`,
    })
  }
}

export function validateWorkflowReferences(
  definition: MatOSWorkflowDefinition,
  options: WorkflowReferenceValidationOptions = {},
): MatOSWorkflowValidationError[] {
  const errors: MatOSWorkflowValidationError[] = []
  const contracts = buildWorkflowContractMap(definition)
  const nodeIds = new Set(definition.nodes.map(node => node.id))
  const parameterIds = new Set([
    ...Object.keys(definition.parameters),
    ...(options.knownParameterIds ?? []),
  ])
  const dependencyGraph = directDependencyGraph(definition)
  const upstreamByNode = new Map(
    definition.nodes.map(node => [
      node.id,
      transitiveDependencies(dependencyGraph, node.id),
    ]),
  )

  const scopes = [
    ...definition.nodes.flatMap(fieldScopesForNode),
    ...edgeScopes(definition),
    ...transitionScopes(definition),
    ...outputScopes(definition),
  ]

  for (const scope of scopes) {
    if (!isRecord(scope.value) && typeof scope.value !== 'string' && !Array.isArray(scope.value)) {
      continue
    }
    for (const expression of extractWorkflowTemplateExpressions(
      scope.value,
      scope.path,
    )) {
      validateReferenceExpression({
        definition,
        contracts,
        expression,
        scope,
        nodeIds,
        parameterIds,
        upstreamByNode,
        errors,
      })
    }
  }

  return errors
}
