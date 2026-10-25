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
  MatOSWorkflowEdge,
  MatOSWorkflowNode,
} from './types.js'
import {
  workflowNodeManifestForType,
  workflowRuntimeTypeForNodeType,
} from './nodeManifests.js'

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function compileWorkflowNode(node: MatOSWorkflowNode): MatOSWorkflowNode {
  const targetType = node.type
  const defaultRuntimeType = workflowRuntimeTypeForNodeType(targetType)
  const manifest = workflowNodeManifestForType(targetType)
  const matosProduct = {
    ...(metadataObject(node.matosProduct)),
    semanticType: node.targetType ?? manifest?.targetType ?? targetType,
    runtimeType: node.runtimeType ?? manifest?.runtimeType ?? defaultRuntimeType,
    ...(manifest?.category ? { category: manifest.category } : {}),
    ...(manifest?.type ? { manifestType: manifest.type } : {}),
    source: 'matos-workflow-compiler',
  }
  if (!defaultRuntimeType || defaultRuntimeType === targetType) {
    return {
      ...node,
      matosProduct,
    }
  }

  const runtime = metadataObject(node.runtime)
  const runtimeType = defaultRuntimeType
  const { type: _type, id: _id, dependsOn: _dependsOn, ...runtimeFields } = runtime

  return {
    ...node,
    ...runtimeFields,
    type: runtimeType,
    targetType,
    runtimeType,
    // Instrument nodes compile to backend nodes. The backend id defaults to
    // `instrument:<instrument-id>` so runtime records, approval fingerprints,
    // and validation identify the physical target without a separate field.
    ...(targetType === 'instrument' && !node.backend
      ? {
          backend:
            typeof node.instrument === 'string' && node.instrument.trim()
              ? `instrument:${node.instrument.trim()}`
              : undefined,
        }
      : {}),
    matosProduct: {
      ...matosProduct,
      semanticType: targetType,
      runtimeType,
    },
    prompt:
      targetType === 'approval_gate'
        ? node.prompt ?? runtime.prompt ?? `Approval required for ${node.id}`
        : node.prompt ?? runtime.prompt,
    checks:
      targetType === 'validate'
        ? node.checks ?? runtime.checks
        : node.checks ?? runtime.checks,
    workflow:
      targetType === 'supernode'
        ? node.workflow ?? runtime.workflow
        : node.workflow ?? runtime.workflow,
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function materializeWorkflowDependencyEdges(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowEdge[] {
  let edges = [...(definition.edges ?? [])]
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) {
      if (
        edges.some(edge => edge.from === dependency && edge.to === node.id)
      ) {
        continue
      }
      edges = [...edges, { from: dependency, to: node.id }]
    }
  }
  return edges
}

function attachWorkflowEdges(
  edges: MatOSWorkflowEdge[],
  nodes: MatOSWorkflowNode[],
): MatOSWorkflowNode[] {
  if (edges.length === 0) {
    return nodes
  }

  return nodes.map(node => {
    const incomingEdges = edges.filter(edge => edge.to === node.id)
    if (incomingEdges.length === 0) {
      return node
    }
    return {
      ...node,
      dependsOn: uniqueStrings([
        ...node.dependsOn,
        ...incomingEdges.map(edge => edge.from),
      ]),
      incomingEdges,
    }
  })
}

export function compileWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowDefinition {
  const nodes = definition.nodes.map(compileWorkflowNode)
  const edges = materializeWorkflowDependencyEdges(definition)
  return {
    ...definition,
    edges,
    nodes: attachWorkflowEdges(edges, nodes),
  }
}
