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

import { workflowNodeManifestForType } from '../workflows/nodeManifests.js'
import type { MatOSWorkflowDefinition,MatOSWorkflowNode } from '../workflows/types.js'
import { isRecord } from './workbenchValues.js'

function workflowNodeDraftMatosData(node: MatOSWorkflowNode): Record<string, unknown> {
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
    nodes: definition.nodes.map(node => {
      const manifest = workflowNodeManifestForType(node.type)
      return {
        id: node.id,
        type: node.type,
        data: {
          nodeMeta: {
            title: typeof node.description === 'string' ? node.description : node.id,
            ...(manifest ? { subTitle: manifest.title } : {}),
          },
          matos: workflowNodeDraftMatosData(node),
        },
      }
    }),
    edges: [
      ...(definition.edges ?? []).map(edge => ({
        from: edge.from,
        to: edge.to,
        ...(edge.condition ? { condition: edge.condition } : {}),
        ...(edge.route ? { route: edge.route } : {}),
      })),
      ...transitions.map(transition => ({
        from: transition.from,
        to: transition.to,
        transition: true,
        data: { matos_transition: transition },
      })),
    ],
    ...(transitions.length > 0 ? { transitions } : {}),
  }
}
