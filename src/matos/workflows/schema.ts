import { extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowEdge,
  MatOSWorkflowNode,
  MatOSWorkflowNodeType,
  MatOSWorkflowOutput,
  MatOSWorkflowParameter,
  MatOSWorkflowPolicy,
  MatOSWorkflowCanvas,
  MatOSWorkflowCanvasNodePosition,
  MatOSWorkflowTransitionEdge,
} from './types.js'

export const DEFAULT_WORKFLOW_POLICY: MatOSWorkflowPolicy = {
  approvalMode: 'bypass',
  defaultRisk: 'low',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function parseRawContent(content: string, sourcePath?: string): unknown {
  if (sourcePath && extname(sourcePath).toLowerCase() === '.json') {
    return JSON.parse(content) as unknown
  }
  return parseYaml(content, { logLevel: 'silent' }) as unknown
}

function normalizeParameters(
  value: unknown,
): Record<string, MatOSWorkflowParameter> {
  const parameters: Record<string, MatOSWorkflowParameter> = {}
  for (const [key, parameter] of Object.entries(asRecord(value))) {
    parameters[key] = asRecord(parameter) as MatOSWorkflowParameter
  }
  return parameters
}

function normalizeOutputs(value: unknown): Record<string, MatOSWorkflowOutput> {
  const outputs: Record<string, MatOSWorkflowOutput> = {}
  for (const [key, output] of Object.entries(asRecord(value))) {
    outputs[key] = asRecord(output) as MatOSWorkflowOutput
  }
  return outputs
}

function normalizeNode(id: string, value: unknown): MatOSWorkflowNode {
  const raw = asRecord(value)
  const type = optionalString(raw.type) ?? 'exec'
  return {
    ...raw,
    id,
    type: type as MatOSWorkflowNodeType,
    dependsOn: stringList(raw.dependsOn),
  }
}

function normalizeNodes(value: unknown): MatOSWorkflowNode[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const raw = asRecord(item)
      const id = optionalString(raw.id) ?? `node_${index + 1}`
      return normalizeNode(id, raw)
    })
  }

  return Object.entries(asRecord(value)).map(([id, node]) =>
    normalizeNode(id, node),
  )
}

function normalizeEdges(value: unknown): MatOSWorkflowEdge[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map(item => {
      const raw = asRecord(item)
      const from = optionalString(raw.from)
      const to = optionalString(raw.to)
      if (!from || !to) {
        return undefined
      }
      const edge: MatOSWorkflowEdge = { from, to }
      const condition = optionalString(raw.condition)
      const route = optionalString(raw.route)
      if (condition) {
        edge.condition = condition
      }
      if (route) {
        edge.route = route as MatOSWorkflowEdge['route']
      }
      return edge
    })
    .filter((edge): edge is MatOSWorkflowEdge => Boolean(edge))
}

function normalizeTransitions(value: unknown): MatOSWorkflowTransitionEdge[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map(item => {
      const raw = asRecord(item)
      const from = optionalString(raw.from)
      const to = optionalString(raw.to)
      if (!from || !to) {
        return undefined
      }

      const edge: MatOSWorkflowTransitionEdge = { from, to }
      const id = optionalString(raw.id)
      const guard = optionalString(raw.guard)
      const route = optionalString(raw.route)
      const reducer = asRecord(raw.reducer)

      if (id) {
        edge.id = id
      }
      if (guard) {
        edge.guard = guard
      }
      if (route) {
        edge.route = route as MatOSWorkflowTransitionEdge['route']
      }
      if (Object.keys(reducer).length > 0) {
        edge.reducer = reducer
      }
      if (Number.isInteger(raw.maxTraversals)) {
        edge.maxTraversals = Number(raw.maxTraversals)
      }
      return edge
    })
    .filter(
      (edge): edge is MatOSWorkflowTransitionEdge => Boolean(edge),
    )
}

function normalizeCanvas(value: unknown): MatOSWorkflowCanvas | undefined {
  const rawNodes = asRecord(asRecord(value).nodes)
  const nodes: Record<string, MatOSWorkflowCanvasNodePosition> = {}
  for (const [id, position] of Object.entries(rawNodes)) {
    const pos = asRecord(position)
    const x = Number(pos.x)
    const y = Number(pos.y)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      nodes[id] = { x, y }
    }
  }
  if (Object.keys(nodes).length === 0) {
    return undefined
  }
  return { nodes }
}

// Shared normalization for definitions arriving as parsed objects (CLI
// --definition-json/--definition-file, workflow_edit replace_definition,
// daemon canvas sync). Defaults every structural block the same way file
// loading does, so a definition without policy/parameters/outputs validates
// instead of crashing downstream property reads.
export function normalizeWorkflowDefinitionInput(
  value: unknown,
): MatOSWorkflowDefinition {
  const raw = asRecord(value)
  return {
    schemaVersion: 1,
    name: optionalString(raw.name) ?? '',
    version: optionalString(raw.version),
    description: optionalString(raw.description),
    parameters: normalizeParameters(raw.parameters),
    policy: {
      ...DEFAULT_WORKFLOW_POLICY,
      ...asRecord(raw.policy),
    },
    nodes: normalizeNodes(raw.nodes),
    edges: normalizeEdges(raw.edges),
    transitions: normalizeTransitions(raw.transitions),
    outputs: normalizeOutputs(raw.outputs),
    canvas: normalizeCanvas(raw.canvas),
  }
}

export function parseWorkflowDefinition(
  content: string,
  options: { sourcePath?: string } = {},
): MatOSWorkflowDefinition {
  const raw = parseRawContent(content, options.sourcePath)
  return {
    ...normalizeWorkflowDefinitionInput(raw),
    sourcePath: options.sourcePath,
  }
}
