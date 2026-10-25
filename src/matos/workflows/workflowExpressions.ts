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
  MatOSWorkflowNodeRunSnapshot,
  WorkflowArtifactRef,
} from './types.js'

export type WorkflowExpressionContext = {
  nodeRuns: Map<string, MatOSWorkflowNodeRunSnapshot>
  artifacts?: WorkflowArtifactRef[]
  parameters: Record<string, unknown>
  workflow?: Record<string, unknown>
  loop?: Record<string, unknown>
}

export function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) {
    return value
  }
  const segments = path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(segment => segment.length > 0)
  return segments.reduce<unknown>((current, part) => {
    if (current === null || current === undefined) {
      return undefined
    }
    if (Array.isArray(current)) {
      const index = Number(part)
      return Number.isInteger(index) && index >= 0
        ? current[index]
        : undefined
    }
    if (typeof current !== 'object') {
      return undefined
    }
    return (current as Record<string, unknown>)[part]
  }, value)
}

// Preserve structured values when templates are embedded in agent prompts or commands.
function templateString(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "object") {
    try { return JSON.stringify(value) } catch { return "" }
  }
  return String(value)
}

function artifactsForNode(
  context: WorkflowExpressionContext,
  nodeId: string,
): WorkflowArtifactRef[] {
  return (context.artifacts ?? []).filter(
    artifact =>
      artifact.nodeId === nodeId ||
      artifact.producerNodeId === nodeId ||
      (typeof artifact.id === 'string' && artifact.id.startsWith(`${nodeId}:`)),
  )
}

function artifactSelectorMatches(
  artifact: WorkflowArtifactRef,
  nodeId: string,
  selector: string,
): boolean {
  return (
    artifact.id === selector ||
    artifact.id === `${nodeId}:${selector}` ||
    artifact.id?.endsWith(`.${selector}`) === true ||
    artifact.kind === selector
  )
}

function nodeArtifactValue(
  context: WorkflowExpressionContext,
  nodeId: string,
  path: string | undefined,
): unknown {
  const artifacts = artifactsForNode(context, nodeId)
  if (!path) {
    return artifacts
  }
  const [selector, ...rest] = path.split('.').filter(Boolean)
  if (!selector) {
    return artifacts
  }
  const index = Number(selector)
  const artifact = Number.isInteger(index)
    ? artifacts[index]
    : artifacts.find(item => artifactSelectorMatches(item, nodeId, selector))
  return valueAtPath(artifact, rest.join('.'))
}

export function resolveWorkflowTemplateValue(
  value: unknown,
  context: WorkflowExpressionContext,
): unknown {
  if (typeof value === 'string') {
    const exactNodeStatus = value.match(
      /^\{\{\s*nodes\.([A-Za-z0-9_-]+)\.status\s*\}\}$/,
    )
    if (exactNodeStatus) {
      return context.nodeRuns.get(exactNodeStatus[1] ?? '')?.status
    }
    const exactNodeAttempts = value.match(
      /^\{\{\s*nodes\.([A-Za-z0-9_-]+)\.attempts\s*\}\}$/,
    )
    if (exactNodeAttempts) {
      return context.nodeRuns.get(exactNodeAttempts[1] ?? '')?.attempts
    }
    const exactNodeError = value.match(
      /^\{\{\s*nodes\.([A-Za-z0-9_-]+)\.error(?:\.([A-Za-z0-9_.-]+))?\s*\}\}$/,
    )
    if (exactNodeError) {
      return valueAtPath(
        context.nodeRuns.get(exactNodeError[1] ?? '')?.error,
        exactNodeError[2],
      )
    }
    const exactNodeArtifact = value.match(
      /^\{\{\s*nodes\.([A-Za-z0-9_-]+)\.artifacts(?:\.([A-Za-z0-9_.-]+))?\s*\}\}$/,
    )
    if (exactNodeArtifact) {
      return nodeArtifactValue(context, exactNodeArtifact[1] ?? '', exactNodeArtifact[2])
    }
    const exactNode = value.match(
      /^\{\{\s*nodes\.([A-Za-z0-9_-]+)\.outputs(?:\.([A-Za-z0-9_.-]+))?\s*\}\}$/,
    )
    if (exactNode) {
      return valueAtPath(context.nodeRuns.get(exactNode[1] ?? '')?.output, exactNode[2])
    }
    const exactParameter = value.match(
      /^\{\{\s*parameters(?:\.([A-Za-z0-9_.-]+))?\s*\}\}$/,
    )
    if (exactParameter) {
      return valueAtPath(context.parameters, exactParameter[1])
    }
    const exactWorkflow = value.match(
      /^\{\{\s*workflow(?:\.([A-Za-z0-9_.-]+))?\s*\}\}$/,
    )
    if (exactWorkflow) {
      return valueAtPath(context.workflow, exactWorkflow[1])
    }
    const exactLoop = value.match(
      /^\{\{\s*loop(?:\.([A-Za-z0-9_.-]+))?\s*\}\}$/,
    )
    if (exactLoop) {
      return valueAtPath(context.loop, exactLoop[1])
    }
    return value.replace(
      /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.outputs(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
      (_match, nodeId: string, path: string | undefined) =>
        templateString(valueAtPath(context.nodeRuns.get(nodeId)?.output, path) ?? ''),
    ).replace(
      /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.status\s*\}\}/g,
      (_match, nodeId: string) =>
        String(context.nodeRuns.get(nodeId)?.status ?? ''),
    ).replace(
      /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.attempts\s*\}\}/g,
      (_match, nodeId: string) =>
        String(context.nodeRuns.get(nodeId)?.attempts ?? ''),
    ).replace(
      /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.error(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
      (_match, nodeId: string, path: string | undefined) =>
        String(valueAtPath(context.nodeRuns.get(nodeId)?.error, path) ?? ''),
    ).replace(
      /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.artifacts(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
      (_match, nodeId: string, path: string | undefined) =>
        templateString(nodeArtifactValue(context, nodeId, path) ?? ''),
    ).replace(
      /\{\{\s*parameters(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
      (_match, path: string | undefined) =>
        templateString(valueAtPath(context.parameters, path) ?? ''),
    ).replace(
      /\{\{\s*workflow(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
      (_match, path: string | undefined) =>
        templateString(valueAtPath(context.workflow, path) ?? ''),
    ).replace(
      /\{\{\s*loop(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
      (_match, path: string | undefined) =>
        templateString(valueAtPath(context.loop, path) ?? ''),
    )
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveWorkflowTemplateValue(item, context))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveWorkflowTemplateValue(item, context),
      ]),
    )
  }
  return value
}
