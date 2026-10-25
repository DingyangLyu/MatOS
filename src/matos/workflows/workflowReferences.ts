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

export type WorkflowReference =
  | {
      kind: 'nodeOutput'
      nodeId: string
      outputPath?: string
      expression: string
    }
  | {
      kind: 'nodeArtifact'
      nodeId: string
      artifactId?: string
      artifactPath?: string
      expression: string
    }
  | {
      kind: 'nodeMetadata'
      nodeId: string
      metadata: 'status' | 'attempts' | 'error'
      metadataPath?: string
      expression: string
    }
  | {
      kind: 'parameter'
      parameterPath?: string
      expression: string
    }
  | {
      kind: 'workflowMetadata'
      metadataPath?: string
      expression: string
    }
  | {
      kind: 'loopMetadata'
      metadataPath?: string
      expression: string
    }
  | {
      kind: 'unknown'
      expression: string
    }

export type WorkflowTemplateExpression = {
  expression: string
  path: string
  /**
   * True when the source string is exactly one template expression, so the
   * resolved value keeps the producer's type instead of becoming part of an
   * interpolated string.
   */
  exact?: boolean
}

const TEMPLATE_EXPRESSION = /\{\{\s*([^}]+?)\s*\}\}/g

const SUPPORTED_WORKFLOW_METADATA_ROOTS = new Set([
  'artifactRoot',
  'projectCwd',
  'runDir',
  'runId',
  'workspaceDir',
  'workflowRef',
  'state',
  'finalNodeId',
])

const SUPPORTED_LOOP_METADATA_ROOTS = new Set([
  'iteration',
  'count',
  'state',
  'previous',
  'outputs',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') {
    return `${parent}[${key}]`
  }
  return parent ? `${parent}.${key}` : key
}

export function isSupportedWorkflowMetadataPath(path: string | undefined): boolean {
  if (!path) {
    return true
  }
  const root = path.split('.')[0] ?? ''
  return Boolean(root) && SUPPORTED_WORKFLOW_METADATA_ROOTS.has(root)
}

export function isSupportedLoopMetadataPath(path: string | undefined): boolean {
  if (!path) {
    return true
  }
  const root = path.split('.')[0] ?? ''
  return Boolean(root) && SUPPORTED_LOOP_METADATA_ROOTS.has(root)
}

export function extractWorkflowTemplateExpressions(
  value: unknown,
  path = '',
): WorkflowTemplateExpression[] {
  if (typeof value === 'string') {
    const matches = [...value.matchAll(TEMPLATE_EXPRESSION)]
    return matches.map(match => ({
      expression: match[1]?.trim() ?? '',
      path,
      exact: matches.length === 1 && value.trim() === match[0],
    }))
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      extractWorkflowTemplateExpressions(item, childPath(path, index)),
    )
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) =>
      extractWorkflowTemplateExpressions(item, childPath(path, key)),
    )
  }
  return []
}

export function parseWorkflowReferenceExpression(
  expression: string,
): WorkflowReference {
  const trimmed = expression.trim()

  const nodeOutputMatch = trimmed.match(
    /^nodes\.([A-Za-z0-9_-]+)\.outputs(?:\.([A-Za-z0-9_.-]+))?$/,
  )
  if (nodeOutputMatch) {
    return {
      kind: 'nodeOutput',
      nodeId: nodeOutputMatch[1] ?? '',
      outputPath: nodeOutputMatch[2],
      expression: trimmed,
    }
  }

  const nodeArtifactMatch = trimmed.match(
    /^nodes\.([A-Za-z0-9_-]+)\.artifacts(?:\.([A-Za-z0-9_.-]+))?$/,
  )
  if (nodeArtifactMatch) {
    const artifactPath = nodeArtifactMatch[2]
    const [artifactId, ...rest] = artifactPath?.split('.').filter(Boolean) ?? []
    return {
      kind: 'nodeArtifact',
      nodeId: nodeArtifactMatch[1] ?? '',
      artifactId,
      artifactPath: rest.join('.') || undefined,
      expression: trimmed,
    }
  }

  const nodeMetadataMatch = trimmed.match(
    /^nodes\.([A-Za-z0-9_-]+)\.(status|attempts|error)(?:\.([A-Za-z0-9_.-]+))?$/,
  )
  if (nodeMetadataMatch) {
    return {
      kind: 'nodeMetadata',
      nodeId: nodeMetadataMatch[1] ?? '',
      metadata: nodeMetadataMatch[2] as 'status' | 'attempts' | 'error',
      metadataPath: nodeMetadataMatch[3],
      expression: trimmed,
    }
  }

  const parameterMatch = trimmed.match(/^parameters(?:\.([A-Za-z0-9_.-]+))?$/)
  if (parameterMatch) {
    return {
      kind: 'parameter',
      parameterPath: parameterMatch[1],
      expression: trimmed,
    }
  }

  const workflowMatch = trimmed.match(/^workflow(?:\.([A-Za-z0-9_.-]+))?$/)
  if (workflowMatch) {
    return {
      kind: 'workflowMetadata',
      metadataPath: workflowMatch[1],
      expression: trimmed,
    }
  }

  const loopMatch = trimmed.match(/^loop(?:\.([A-Za-z0-9_.-]+))?$/)
  if (loopMatch) {
    return {
      kind: 'loopMetadata',
      metadataPath: loopMatch[1],
      expression: trimmed,
    }
  }

  return { kind: 'unknown', expression: trimmed }
}
