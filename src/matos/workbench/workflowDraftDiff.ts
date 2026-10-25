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
} from '../workflows/types.js'
import type {
MatOSWorkbenchWorkflowDraftIssue,
MatOSWorkbenchWorkflowDraftPreview,
} from './types.js'

export function workflowDraftPreviewValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '(empty)'
  }
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim()
    return text.length > 160 ? `${text.slice(0, 157)}...` : text
  }
  try {
    const text = JSON.stringify(value)
    return text.length > 180 ? `${text.slice(0, 177)}...` : text
  } catch {
    return String(value)
  }
}

export function workflowNodeDiffValue(node: MatOSWorkflowNode): Record<string, unknown> {
  const value: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    dependsOn: node.dependsOn,
  }
  for (const key of [
    'role',
    'roleRef',
    'tool',
    'toolRef',
    'mcp',
    'plugin',
    'workflowRef',
    'adapter',
    'command',
    'prompt',
  ]) {
    if (node[key] !== undefined) {
      value[key] = node[key]
    }
  }
  return value
}

export function buildWorkflowDraftDiff(input: {
  definition: MatOSWorkflowDefinition
  summary: {
    nodeCount: number
    edgeCount: number
    ignoredNodeCount: number
    warningCount: number
    errorCount: number
  }
  issues: MatOSWorkbenchWorkflowDraftIssue[]
}): NonNullable<MatOSWorkbenchWorkflowDraftPreview['diff']> {
  const items: NonNullable<MatOSWorkbenchWorkflowDraftPreview['diff']>['items'] = []
  const add = (item: Omit<NonNullable<MatOSWorkbenchWorkflowDraftPreview['diff']>['items'][number], 'changed'>): void => {
    items.push({
      ...item,
      changed: true,
    })
  }

  add({
    path: 'workflow',
    label: 'Workflow definition',
    kind: 'workflow',
    after: {
      name: input.definition.name,
      version: input.definition.version,
      description: input.definition.description,
      policy: input.definition.policy,
    },
  })

  for (const node of [...input.definition.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    add({
      path: `nodes.${node.id}`,
      label: `Node ${node.id}`,
      kind: 'node',
      after: workflowNodeDiffValue(node),
    })
  }

  for (const edge of [...(input.definition.edges ?? [])].sort((left, right) =>
    `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`),
  )) {
    add({
      path: `edges.${edge.from}->${edge.to}`,
      label: `Edge ${edge.from} -> ${edge.to}`,
      kind: 'edge',
      after: edge,
    })
  }

  for (const transition of [...(input.definition.transitions ?? [])].sort((left, right) =>
    `${left.from}->${left.to}:${left.id ?? ''}`.localeCompare(`${right.from}->${right.to}:${right.id ?? ''}`),
  )) {
    add({
      path: `transitions.${transition.id ?? `${transition.from}->${transition.to}`}`,
      label: `Transition ${transition.from} -> ${transition.to}${transition.route ? ` (${transition.route})` : ''}`,
      kind: 'transition',
      after: transition,
    })
  }

  for (const [name, parameter] of Object.entries(input.definition.parameters).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    add({
      path: `parameters.${name}`,
      label: `Parameter ${name}`,
      kind: 'parameter',
      after: parameter,
    })
  }

  for (const [name, output] of Object.entries(input.definition.outputs).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    add({
      path: `outputs.${name}`,
      label: `Output ${name}`,
      kind: 'output',
      after: output,
    })
  }

  if (input.summary.ignoredNodeCount > 0) {
    add({
      path: 'summary.ignoredNodeCount',
      label: 'Ignored structural Coze nodes',
      kind: 'summary',
      after: input.summary.ignoredNodeCount,
    })
  }

  for (const issue of input.issues) {
    add({
      path: issue.path ?? (issue.nodeId ? `nodes.${issue.nodeId}` : `issues.${issue.code}`),
      label: `${issue.severity}: ${issue.code}`,
      kind: 'issue',
      after: issue,
    })
  }

  return {
    source: 'matos-workflow-draft',
    summary: {
      nodeCount: input.summary.nodeCount,
      edgeCount: input.summary.edgeCount,
      transitionCount: input.definition.transitions?.length ?? 0,
      parameterCount: Object.keys(input.definition.parameters).length,
      outputCount: Object.keys(input.definition.outputs).length,
      ignoredNodeCount: input.summary.ignoredNodeCount,
      issueCount: input.issues.length,
    },
    items,
    preview: items.slice(0, 12).map(item => `${item.label}: ${workflowDraftPreviewValue(item.after)}`),
  }
}
