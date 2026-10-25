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

import {
MATOS_WORKFLOW_NODE_MANIFESTS,
workflowNodeManifestForType,
} from '../workflows/nodeManifests.js'
import type {
MatOSWorkflowDefinition,
MatOSWorkflowEdge,
MatOSWorkflowNode,
MatOSWorkflowNodeType,
MatOSWorkflowOutput,
MatOSWorkflowParameter,
MatOSWorkflowTransitionEdge,
} from '../workflows/types.js'
import type { MatOSWorkbenchWorkflowDraftIssue } from './types.js'

export const COZE_TO_MATOS_NODE_TYPE: Record<string, MatOSWorkflowNodeType> = {
  '3': 'agent',
  '4': 'backend',
  '5': 'exec',
  '8': 'guard',
  '9': 'subworkflow',
  '11': 'human',
  '18': 'human',
  '20': 'subworkflow',
  '21': 'loop',
}

export const MATOS_TO_COZE_NODE_TYPE: Partial<Record<MatOSWorkflowNodeType, string>> =
  Object.fromEntries(
    MATOS_WORKFLOW_NODE_MANIFESTS.map(manifest => [manifest.type, manifest.cozeNodeType]),
  ) as Partial<Record<MatOSWorkflowNodeType, string>>

export const STRUCTURAL_COZE_NODE_TYPES = new Set(['1', '2', 'start', 'end'])

/**
 * Keys on a canvas `data.matos` node record that are control/derived metadata
 * rather than native MatOS workflow node fields. Everything else round-trips
 * generically so canvas edits to any node field survive a draft apply.
 */
export const CANVAS_NODE_CONTROL_KEYS = new Set([
  'id',
  'type',
  'dependsOn',
  'description',
  'hasPrompt',
  'hasCommand',
  'incomingEdges',
  'runtimeType',
  'targetType',
])

/**
 * Node fields that derive from the workflow graph or compile output and must
 * never be inherited from the current definition into a canvas draft.
 */
export const NODE_INHERIT_SKIP_KEYS = new Set([
  'id',
  'type',
  'dependsOn',
  'incomingEdges',
  'runtimeType',
  'targetType',
])

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = optionalString(value)
    if (string) {
      return string
    }
  }
  return undefined
}

export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return value
  }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

export function parseNestedJsonRecord(value: unknown): Record<string, unknown> | undefined {
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    current = parseJsonMaybe(current)
    if (isRecord(current)) {
      return current
    }
    if (typeof current !== 'string') {
      return undefined
    }
  }
  return undefined
}

export function recordAt(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

export function valueAt(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return current
}

export function extractCozeSchema(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {}
  }
  const candidates: unknown[] = [
    input.schema_json,
    input.schemaJson,
    input.schema,
    input.workflow,
    recordAt(input, 'workflow')?.schema_json,
    recordAt(input, 'workflow')?.schema,
    recordAt(input, 'data', 'workflow')?.schema_json,
    recordAt(input, 'data', 'workflow')?.schema,
    recordAt(input, 'data')?.schema_json,
    recordAt(input, 'data')?.schema,
  ]
  for (const candidate of candidates) {
    const parsed = parseNestedJsonRecord(candidate)
    if (parsed && (Array.isArray(parsed.nodes) || Array.isArray(parsed.edges) || isRecord(parsed.matos))) {
      return parsed
    }
  }
  if (Array.isArray(input.nodes) || Array.isArray(input.edges)) {
    return input
  }
  return {}
}

export function cozeNodeType(node: Record<string, unknown>): string {
  return firstString(node.type, node.node_type, node.nodeType, recordAt(node, 'data', 'matos')?.type) ?? ''
}

/**
 * One executable-or-structural node from the canvas schema, with both ids:
 * `canvasId` is the FlowGram document node id (also the pre-rename MatOS id
 * for rendered nodes), `finalId` is the authoritative MatOS node id after a
 * possible form rename through `data.matos.id`.
 */
export type CanvasNodeEntry = {
  raw: Record<string, unknown>
  data: Record<string, unknown>
  matos: Record<string, unknown>
  index: number
  canvasId: string
  finalId: string
  position?: { x: number; y: number }
}

/**
 * Extracts a numeric {x,y} canvas position from a Coze node. Coze/FlowGram
 * versions store layout in different spots (top-level `position`, nested
 * `meta.position`, or `data.position`); accept any finite one so the builder
 * layout survives the save regardless of the editor's serialization shape.
 */
function canvasEntryPosition(
  node: Record<string, unknown>,
): { x: number; y: number } | undefined {
  for (const candidate of [
    node.position,
    recordAt(node, 'meta')?.position,
    recordAt(node, 'data')?.position,
  ]) {
    const pos = isRecord(candidate) ? candidate : undefined
    if (!pos) {
      continue
    }
    const x = Number(pos.x)
    const y = Number(pos.y)
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y }
    }
  }
  return undefined
}

export function canvasNodeEntries(schema: Record<string, unknown>): CanvasNodeEntry[] {
  const entries: CanvasNodeEntry[] = []
  asArray(schema.nodes).forEach((value, index) => {
    if (!isRecord(value)) {
      return
    }
    const data = isRecord(value.data) ? value.data : {}
    const matos = isRecord(data.matos) ? data.matos : {}
    const canvasId =
      firstString(value.id, value.node_id, value.nodeId) ?? `node_${index + 1}`
    const finalId =
      firstString(matos.id, value.id, value.node_id, value.nodeId) ?? `node_${index + 1}`
    entries.push({
      raw: value,
      data,
      matos,
      index,
      canvasId,
      finalId,
      position: canvasEntryPosition(value),
    })
  })
  return entries
}

/**
 * Maps canvas document node ids to final MatOS node ids so a node rename
 * through the node form (`data.matos.id`) also rewrites edge endpoints,
 * dependsOn references, transition endpoints, and the state-machine initial
 * node instead of producing dangling references.
 */
export function canvasIdResolver(entries: CanvasNodeEntry[]): (id: string) => string {
  const aliases = new Map<string, string>()
  for (const entry of entries) {
    if (entry.canvasId && entry.canvasId !== entry.finalId && !aliases.has(entry.canvasId)) {
      aliases.set(entry.canvasId, entry.finalId)
    }
  }
  return id => aliases.get(id) ?? id
}

export function matosNodeTypeForCanvasEntry(
  entry: CanvasNodeEntry,
  currentNode: MatOSWorkflowNode | undefined,
  issues: MatOSWorkbenchWorkflowDraftIssue[],
): MatOSWorkflowNodeType | undefined {
  const matosType = firstString(entry.matos.type, entry.matos.targetType)
  if (
    matosType &&
    !STRUCTURAL_COZE_NODE_TYPES.has(matosType.toLowerCase()) &&
    workflowNodeManifestForType(matosType)
  ) {
    return matosType as MatOSWorkflowNodeType
  }
  const type = cozeNodeType(entry.raw)
  if (STRUCTURAL_COZE_NODE_TYPES.has(type.toLowerCase())) {
    return undefined
  }
  // Frontends may strip data.matos. Several generic MatOS types share one
  // Coze node type (map/loop/dynamic -> 21), so recover the precise type from
  // the current definition when its Coze projection matches the canvas type.
  if (currentNode && MATOS_TO_COZE_NODE_TYPE[currentNode.type] === type) {
    return currentNode.type
  }
  const mapped = COZE_TO_MATOS_NODE_TYPE[type]
  if (mapped) {
    return mapped
  }
  issues.push({
    severity: 'error',
    code: 'unsupported_coze_node_type',
    message: `Coze node type "${type || 'unknown'}" is not supported by the native MatOS workflow model; save is blocked until this node is removed or mapped explicitly.`,
    nodeId: firstString(entry.raw.id, entry.raw.node_id),
  })
  return undefined
}

export function nodeMetaTitle(node: Record<string, unknown>): string | undefined {
  return firstString(
    recordAt(node, 'data', 'nodeMeta')?.title,
    recordAt(node, 'data', 'nodeMeta')?.name,
    recordAt(node, 'data')?.name,
    recordAt(node, 'data')?.title,
  )
}

/**
 * The forward projection synthesizes "<type>: <id>" titles for nodes without
 * descriptions; reading those back as descriptions would pollute the native
 * definition with display junk.
 */
export function isGeneratedNodeTitle(
  title: string,
  entry: CanvasNodeEntry,
  type: string,
): boolean {
  const typeCandidates = new Set(
    [type, firstString(entry.matos.type) ?? ''].filter(Boolean),
  )
  const idCandidates = [entry.finalId, entry.canvasId].filter(Boolean)
  for (const candidateType of typeCandidates) {
    for (const candidateId of idCandidates) {
      if (
        title === `${candidateType}: ${candidateId}` ||
        title === `${candidateType.replace(/_/g, ' ')}: ${candidateId}`
      ) {
        return true
      }
    }
  }
  return false
}

export const CANVAS_DATA_NODE_FIELD_KEYS = [
  'role',
  'workflow',
  'backend',
  'tool',
  'api',
  'assetRef',
  'assetType',
  'command',
  'prompt',
  'parameters',
  'checks',
  'items',
  'itemParameter',
  'outputKeys',
  'outputSchema',
  'inputContract',
  'outputContract',
  'artifactContract',
  'policy',
  'responseSchema',
  'schema',
  'passthroughArgs',
  'timeoutMs',
  'timeoutSeconds',
  'systemPrompt',
  'batch',
  'metadata',
  'input',
  'toolInput',
  'code',
  'language',
]

export function nativeNodeFromCanvasEntry(input: {
  entry: CanvasNodeEntry
  type: MatOSWorkflowNodeType
  resolveId: (id: string) => string
  currentNode?: MatOSWorkflowNode
}): { node: MatOSWorkflowNode; hasExplicitDependsOn: boolean } {
  const { entry, type, resolveId, currentNode } = input
  const node: MatOSWorkflowNode = {
    id: entry.finalId,
    type,
    dependsOn: asArray(entry.matos.dependsOn)
      .map(value => resolveId(String(value)))
      .filter(Boolean),
  }
  // Legacy hand-built canvas payloads may place known fields directly on
  // node.data; the matos record (below) always wins when both exist.
  for (const key of CANVAS_DATA_NODE_FIELD_KEYS) {
    if (entry.data[key] !== undefined) {
      node[key] = entry.data[key]
    }
  }
  // Generic field copy: every non-control key on data.matos is a native node
  // field. Empty string / null mark an explicit form deletion and also block
  // inheritance of the old value from the current definition.
  const deletedKeys = new Set<string>()
  const visibleInputs = nativeInputsFromCanvasData(entry.data)
  if (visibleInputs) {
    node.inputs = visibleInputs
  }
  const visibleOutputs = nativeOutputsFromCanvasData(entry.data)
  if (visibleOutputs) {
    node.outputs = visibleOutputs
  }
  if (type === 'backend') {
    applyCozeApiNodeFields(node, entry)
    applyCozeInputParameterValues(node, entry, ['input', 'toolInput'])
  }
  if (type === 'agent') {
    applyCozeLlmNodeFields(node, entry)
  }
  if (type === 'exec') {
    applyCozeCodeNodeFields(node, entry)
  }
  if (type === 'subworkflow' || type === 'supernode') {
    applyCozeSubWorkflowNodeFields(node, entry)
    applyCozeInputParameterValues(node, entry, ['parameters'])
  }
  if (type === 'map' || type === 'loop' || type === 'dynamic') {
    applyCozeLoopNodeFields(node, entry)
  }
  applyCozeCommonNodeFields(node, entry)
  for (const [key, value] of Object.entries(entry.matos)) {
    if (CANVAS_NODE_CONTROL_KEYS.has(key) || value === undefined) {
      continue
    }
    if (value === null || value === '') {
      deletedKeys.add(key)
      delete node[key]
      continue
    }
    node[key] = value
  }
  if ((type === 'human' || type === 'approval_gate') && node.responseSchema === undefined && node.schema !== undefined) {
    node.responseSchema = node.schema
    delete node.schema
  }
  if (Object.prototype.hasOwnProperty.call(entry.matos, 'description')) {
    const description = optionalString(entry.matos.description)
    if (description) {
      node.description = description
    } else {
      deletedKeys.add('description')
    }
  } else {
    const titled = nodeMetaTitle(entry.raw)
    if (
      titled &&
      titled !== entry.finalId &&
      titled !== entry.canvasId &&
      !isGeneratedNodeTitle(titled, entry, type)
    ) {
      node.description = titled
    }
  }
  // Fields the canvas never touched (stripped data.matos, partial saves)
  // inherit from the current definition node instead of being dropped.
  if (currentNode && currentNode.type === type) {
    for (const [key, value] of Object.entries(currentNode)) {
      if (NODE_INHERIT_SKIP_KEYS.has(key) || value === undefined) {
        continue
      }
      if (deletedKeys.has(key) || node[key] !== undefined) {
        continue
      }
      node[key] = value
    }
  }
  return { node, hasExplicitDependsOn: Array.isArray(entry.matos.dependsOn) }
}

export function nativeInputsFromCanvasData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const inputsRecord = recordAt(data, 'inputs')
  if (!inputsRecord || !Array.isArray(inputsRecord.inputParameters)) {
    return undefined
  }
  const inputParameters = inputsRecord.inputParameters
  const inputs: Record<string, unknown> = {}
  for (const raw of inputParameters) {
    if (!isRecord(raw)) {
      continue
    }
    const name = firstString(raw.name, raw.key)
    if (!name) {
      continue
    }
    const { name: _name, key: _key, ...rest } = raw
    if (Object.keys(rest).length > 0) {
      inputs[name] = rest
    }
  }
  return inputs
}

export function cozeBlockInputLiteralValue(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  return firstString(
    valueAt(raw, 'input', 'value', 'content'),
    valueAt(raw, 'input', 'content'),
    raw.value,
    raw.content,
  )
}

export function cozeBlockInputLiteralContent(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined
  }
  const candidates = [
    valueAt(raw, 'input', 'value', 'content'),
    valueAt(raw, 'input', 'content'),
    raw.value,
    raw.content,
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate
    }
  }
  return undefined
}

export function cozeBlockInputValueMap(raw: unknown): Record<string, unknown> {
  const map: Record<string, unknown> = {}
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) {
      continue
    }
    const name = firstString(entry.name, entry.key)
    if (!name) {
      continue
    }
    const value = cozeBlockInputLiteralContent(entry)
    if (value !== undefined) {
      map[name] = value
    }
  }
  return map
}

export function cozeBlockInputMap(raw: unknown): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) {
      continue
    }
    const name = firstString(entry.name, entry.key)
    const value = cozeBlockInputLiteralValue(entry)
    if (name && value !== undefined) {
      map[name] = value
    }
  }
  return map
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') {
      return true
    }
    if (normalized === 'false') {
      return false
    }
  }
  return undefined
}

function objectWithMetadata(node: MatOSWorkflowNode): Record<string, unknown> {
  const metadata = isRecord(node.metadata) ? { ...node.metadata } : {}
  node.metadata = metadata
  return metadata
}

function mergeNodePolicy(
  node: MatOSWorkflowNode,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const policy = isRecord(node.policy) ? { ...node.policy } : {}
  node.policy = {
    ...policy,
    ...patch,
  }
  return node.policy
}

function mergeNodeRetryPolicy(
  node: MatOSWorkflowNode,
  patch: Record<string, unknown>,
): void {
  const policy = isRecord(node.policy) ? { ...node.policy } : {}
  const retry = isRecord(policy.retry) ? { ...policy.retry } : {}
  node.policy = {
    ...policy,
    retry: {
      ...retry,
      ...patch,
    },
  }
}

function cozeInputParametersValueMap(entry: CanvasNodeEntry): Record<string, unknown> {
  return cozeBlockInputValueMap(valueAt(entry.data, 'inputs', 'inputParameters'))
}

function cozeLlmParamMap(entry: CanvasNodeEntry): Record<string, unknown> {
  return cozeBlockInputValueMap(valueAt(entry.data, 'inputs', 'llmParam'))
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() ? value : undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return undefined
}

function cozePromptValue(entry: CanvasNodeEntry, key: 'prompt' | 'systemPrompt'): string | undefined {
  const llmParams = cozeLlmParamMap(entry)
  return stringFromUnknown(llmParams[key]) ??
    firstString(
      valueAt(entry.data, '$$prompt_decorator$$', key === 'prompt' ? 'prompt' : 'systemPrompt'),
      valueAt(entry.data, 'inputs', key),
      entry.data[key],
    )
}

function cozeModelValue(entry: CanvasNodeEntry): string | undefined {
  const llmParams = cozeLlmParamMap(entry)
  const candidate = firstString(
    llmParams.model,
    llmParams.modelId,
    llmParams.model_id,
    llmParams.modelName,
    llmParams.modleName,
    valueAt(entry.data, 'model', 'modelId'),
    valueAt(entry.data, 'model', 'model_id'),
    valueAt(entry.data, 'model', 'modelName'),
    entry.data.model,
  )
  if (
    !candidate ||
    /^matos role default model$/i.test(candidate) ||
    /^matos-role-default$/i.test(candidate)
  ) {
    const modelType = stringFromUnknown(llmParams.modelType)
    return modelType && !/^\d+$/.test(modelType) ? modelType : undefined
  }
  return candidate
}

function mergeModelPassthroughArgs(
  node: MatOSWorkflowNode,
  model: string | undefined,
): void {
  if (!model) {
    return
  }
  node.model = node.model ?? model
  const existing = asArray(node.passthroughArgs).map(String)
  const next: string[] = []
  for (let index = 0; index < existing.length; index += 1) {
    const arg = existing[index]
    if (arg === '--model') {
      index += 1
      continue
    }
    if (arg?.startsWith('--model=')) {
      continue
    }
    next.push(arg)
  }
  node.passthroughArgs = [...next, '--model', model]
}

export function applyCozeLlmNodeFields(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
): void {
  const prompt = cozePromptValue(entry, 'prompt')
  const systemPrompt = cozePromptValue(entry, 'systemPrompt')
  const model = cozeModelValue(entry)
  const fcParam = valueAt(entry.data, 'inputs', 'fcParam')
  if (prompt && node.prompt === undefined) {
    node.prompt = prompt
  }
  if (systemPrompt && node.systemPrompt === undefined) {
    node.systemPrompt = systemPrompt
  }
  if (model) {
    mergeModelPassthroughArgs(node, model)
  }
  const metadata = objectWithMetadata(node)
  const llmParam = valueAt(entry.data, 'inputs', 'llmParam')
  if (Array.isArray(llmParam) || fcParam !== undefined) {
    metadata.cozeLlmNode = {
      ...(isRecord(metadata.cozeLlmNode) ? metadata.cozeLlmNode : {}),
      ...(Array.isArray(llmParam) ? { llmParam } : {}),
      ...(fcParam !== undefined ? { fcParam } : {}),
    }
  }
}

export function applyCozeInputParameterValues(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
  targetKeys: string[],
): void {
  const values = cozeInputParametersValueMap(entry)
  if (Object.keys(values).length === 0) {
    return
  }
  for (const key of targetKeys) {
    if (node[key] === undefined) {
      node[key] = values
    }
  }
}

export function applyCozeCodeNodeFields(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
): void {
  const code = firstString(
    cozeBlockInputLiteralContent(valueAt(entry.data, 'inputs', 'code')),
    valueAt(entry.data, 'inputs', 'code'),
    entry.data.code,
  )
  const language = firstString(
    cozeBlockInputLiteralContent(valueAt(entry.data, 'inputs', 'language')),
    valueAt(entry.data, 'inputs', 'language'),
    entry.data.language,
  )
  if (code && node.code === undefined) {
    node.code = code
  }
  if (language && node.language === undefined) {
    node.language = language
  }
  if (!code || node.command !== undefined) {
    return
  }
  const normalized = (language || 'shell').toLowerCase()
  if (['sh', 'shell', 'bash', 'zsh'].includes(normalized)) {
    node.command = code
  } else if (['python', 'python3', 'py'].includes(normalized)) {
    node.command = `python3 <<'PY'\n${code}\nPY`
  } else {
    const metadata = objectWithMetadata(node)
    metadata.cozeCodeNode = {
      ...(isRecord(metadata.cozeCodeNode) ? metadata.cozeCodeNode : {}),
      language: language || 'unknown',
      code,
      unsupportedRuntimeLanguage: true,
    }
  }
}

export function applyCozeLoopNodeFields(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
): void {
  const inputs = recordAt(entry.data, 'inputs')
  if (!inputs) {
    return
  }
  const inputValues = cozeInputParametersValueMap(entry)
  if (Object.keys(inputValues).length > 0 && node.parameters === undefined) {
    node.parameters = inputValues
  }
  const loopType = firstString(inputs.loopType, inputs.loop_type)
  const loopCount = numericValue(inputs.loopCount ?? inputs.loop_count)
  if (
    node.type === 'loop' &&
    node.maxIterations === undefined &&
    loopCount !== undefined &&
    loopCount >= 1 &&
    (!loopType || ['count', 'fixed', 'for'].includes(loopType.toLowerCase()))
  ) {
    node.maxIterations = Math.floor(loopCount)
  }
  const metadata = objectWithMetadata(node)
  metadata.cozeIterationNode = {
    ...(isRecord(metadata.cozeIterationNode) ? metadata.cozeIterationNode : {}),
    ...(loopType ? { loopType } : {}),
    ...(loopCount !== undefined ? { loopCount } : {}),
    ...(inputs.variableParameters !== undefined
      ? { variableParameters: inputs.variableParameters }
      : {}),
    ...(inputs.concurrentSize !== undefined ? { concurrentSize: inputs.concurrentSize } : {}),
    ...(inputs.batchSize !== undefined ? { batchSize: inputs.batchSize } : {}),
  }
}

export function applyCozeCommonNodeFields(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
): void {
  const settingOnError =
    recordAt(entry.data, 'settingOnError') ??
    recordAt(entry.data, 'inputs', 'settingOnError')
  if (settingOnError) {
    const metadata = objectWithMetadata(node)
    metadata.cozeSettingOnError = settingOnError
    const enabled =
      booleanValue(settingOnError.settingOnErrorIsOpen) ??
      booleanValue(settingOnError.switch) ??
      true
    if (enabled) {
      const timeoutMs = numericValue(settingOnError.timeoutMs)
      if (timeoutMs !== undefined && timeoutMs > 0 && node.timeoutMs === undefined) {
        node.timeoutMs = timeoutMs
      }
      const retryTimes = numericValue(settingOnError.retryTimes)
      if (retryTimes !== undefined && retryTimes >= 0) {
        mergeNodeRetryPolicy(node, {
          maxAttempts: Math.max(1, Math.floor(retryTimes) + 1),
        })
      }
      const processType = firstString(settingOnError.processType, settingOnError.process_type)
      if (processType) {
        mergeNodePolicy(node, { onError: processType })
      }
      if (settingOnError.dataOnErr !== undefined) {
        mergeNodePolicy(node, { defaultOutput: settingOnError.dataOnErr })
      }
    }
  }

  const batch = recordAt(entry.data, 'batch') ?? recordAt(entry.data, 'inputs', 'batch')
  if (batch) {
    if (node.batch === undefined) {
      node.batch = batch
    }
    const metadata = objectWithMetadata(node)
    metadata.cozeBatch = batch
    const concurrentSize = numericValue(batch.concurrentSize)
    if ((node.type === 'map' || node.type === 'loop') && node.maxParallel === undefined && concurrentSize !== undefined && concurrentSize > 0) {
      node.maxParallel = Math.floor(concurrentSize)
    }
  }
}

export function applyCozeApiNodeFields(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
): void {
  const apiParam = cozeBlockInputMap(valueAt(entry.data, 'inputs', 'apiParam'))
  const pluginId = firstString(apiParam.pluginID, apiParam.pluginId, apiParam.plugin_id)
  const apiId = firstString(apiParam.apiID, apiParam.apiId, apiParam.api_id)
  const apiName = firstString(apiParam.apiName, apiParam.api_name)
  const pluginName = firstString(apiParam.pluginName, apiParam.plugin_name)
  const pluginVersion = firstString(apiParam.pluginVersion, apiParam.plugin_version)
  const resourceRef = firstString(pluginId, apiId)
  if (!resourceRef && !apiName && !pluginName) {
    return
  }
  if (!node.backend) {
    node.backend = firstString(pluginName, resourceRef, 'matos-tool')
  }
  if (!node.operation && apiName) {
    node.operation = apiName
  }
  if (!node.tool && resourceRef && /^(tool|plugin|mcp):/.test(resourceRef)) {
    node.tool = resourceRef
  }
  if (!node.api && apiId && apiId !== resourceRef) {
    node.api = apiId
  }
  const metadata = isRecord(node.metadata) ? { ...node.metadata } : {}
  node.metadata = {
    ...metadata,
    cozeApiNode: {
      ...(isRecord(metadata.cozeApiNode) ? metadata.cozeApiNode : {}),
      ...(pluginId ? { pluginID: pluginId } : {}),
      ...(apiId ? { apiID: apiId } : {}),
      ...(apiName ? { apiName } : {}),
      ...(pluginName ? { pluginName } : {}),
      ...(pluginVersion ? { pluginVersion } : {}),
    },
  }
}

export function applyCozeSubWorkflowNodeFields(
  node: MatOSWorkflowNode,
  entry: CanvasNodeEntry,
): void {
  const workflowId = firstString(
    valueAt(entry.data, 'inputs', 'workflowId'),
    valueAt(entry.data, 'inputs', 'workflow_id'),
  )
  const workflowVersion = firstString(
    valueAt(entry.data, 'inputs', 'workflowVersion'),
    valueAt(entry.data, 'inputs', 'workflow_version'),
  )
  const spaceId = firstString(
    valueAt(entry.data, 'inputs', 'spaceId'),
    valueAt(entry.data, 'inputs', 'space_id'),
  )
  if (!workflowId && !workflowVersion && !spaceId) {
    return
  }
  if (!node.workflow && workflowId) {
    node.workflow = workflowId
  }
  const metadata = isRecord(node.metadata) ? { ...node.metadata } : {}
  node.metadata = {
    ...metadata,
    cozeSubWorkflowNode: {
      ...(isRecord(metadata.cozeSubWorkflowNode) ? metadata.cozeSubWorkflowNode : {}),
      ...(workflowId ? { workflowID: workflowId } : {}),
      ...(workflowVersion ? { workflowVersion } : {}),
      ...(spaceId ? { spaceID: spaceId } : {}),
    },
  }
}

export function nativeOutputsFromCanvasData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, 'outputs') || !Array.isArray(data.outputs)) {
    return undefined
  }
  const outputRecords = data.outputs
  const outputs: Record<string, unknown> = {}
  for (const raw of outputRecords) {
    if (!isRecord(raw)) {
      continue
    }
    const name = firstString(raw.name, raw.key)
    if (!name) {
      continue
    }
    const { name: _name, key: _key, ...rest } = raw
    outputs[name] = Object.keys(rest).length > 0 ? rest : {}
  }
  return outputs
}

export function cozeEdgeEndpoint(edge: Record<string, unknown>, source: boolean): string | undefined {
  if (source) {
    return firstString(edge.from, edge.source, edge.sourceNodeID, edge.sourceNodeId, edge.source_node_id)
  }
  return firstString(edge.to, edge.target, edge.targetNodeID, edge.targetNodeId, edge.target_node_id)
}

export function isTransitionCanvasEdge(raw: Record<string, unknown>): boolean {
  if (raw.transition === true || raw.is_transition === true) {
    return true
  }
  const kind = firstString(raw.kind, raw.edgeKind, raw.edge_kind, raw.edgeType, raw.edge_type)
  if (kind && kind.toLowerCase() === 'transition') {
    return true
  }
  const data = recordAt(raw, 'data')
  return Boolean(data && data.matos_transition !== undefined && data.matos_transition !== false)
}

export function transitionFromCanvasValue(input: {
  from: string
  to: string
  raw: Record<string, unknown>
  allowRawId?: boolean
}): MatOSWorkflowTransitionEdge {
  const explicitMeta = isRecord(recordAt(input.raw, 'data')?.matos_transition)
    ? (recordAt(input.raw, 'data')?.matos_transition as Record<string, unknown>)
    : isRecord(input.raw.matos_transition)
      ? (input.raw.matos_transition as Record<string, unknown>)
      : undefined
  const meta = explicitMeta ?? input.raw
  const transition: MatOSWorkflowTransitionEdge = { from: input.from, to: input.to }
  // Plain canvas edges may carry frontend-generated edge ids; only trust ids
  // from explicit transition metadata or transition-array entries.
  const id = explicitMeta
    ? firstString(explicitMeta.id, input.raw.transitionId, input.raw.transition_id)
    : input.allowRawId
      ? firstString(input.raw.id, input.raw.transitionId, input.raw.transition_id)
      : firstString(input.raw.transitionId, input.raw.transition_id)
  if (id) {
    transition.id = id
  }
  const route = firstString(meta.route, input.raw.route)
  if (route === 'success' || route === 'failure' || route === 'always') {
    transition.route = route
  }
  const guard = firstString(meta.guard, input.raw.guard)
  if (guard) {
    transition.guard = guard
  }
  const reducer = isRecord(meta.reducer)
    ? meta.reducer
    : isRecord(input.raw.reducer)
      ? (input.raw.reducer as Record<string, unknown>)
      : undefined
  if (reducer && Object.keys(reducer).length > 0) {
    transition.reducer = reducer
  }
  const maxTraversals = meta.maxTraversals ?? input.raw.maxTraversals
  if (typeof maxTraversals === 'number' && Number.isInteger(maxTraversals)) {
    transition.maxTraversals = maxTraversals
  }
  return transition
}

export function transitionKey(transition: MatOSWorkflowTransitionEdge): string {
  return [
    transition.id ?? '',
    transition.from,
    transition.to,
    transition.route ?? '',
    transition.guard ?? '',
    JSON.stringify(transition.reducer ?? {}),
    transition.maxTraversals ?? '',
  ].join('|')
}

export function transitionHasMetadata(transition: MatOSWorkflowTransitionEdge): boolean {
  return Boolean(
    transition.id ||
      transition.route ||
      transition.guard ||
      transition.reducer ||
      transition.maxTraversals !== undefined,
  )
}

export function extractTransitions(
  schema: Record<string, unknown>,
  nodeIds: Set<string>,
  options: {
    stateMachine: boolean
    currentDefinition?: MatOSWorkflowDefinition
    resolveId?: (id: string) => string
  },
): MatOSWorkflowTransitionEdge[] {
  const resolveId = options.resolveId ?? ((id: string) => id)
  const hasCanvasEdges = Array.isArray(schema.edges)
  const transitions: MatOSWorkflowTransitionEdge[] = []
  const seen = new Set<string>()
  const seenIds = new Set<string>()
  const push = (transition: MatOSWorkflowTransitionEdge): void => {
    const key = transitionKey(transition)
    if (!seen.has(key)) {
      seen.add(key)
      transitions.push(transition)
      if (transition.id) {
        seenIds.add(transition.id)
      }
    }
  }
  const arrayTransitions: MatOSWorkflowTransitionEdge[] = []
  for (const raw of asArray(schema.transitions)) {
    if (!isRecord(raw)) {
      continue
    }
    const from = resolveId(cozeEdgeEndpoint(raw, true) ?? '')
    const to = resolveId(cozeEdgeEndpoint(raw, false) ?? '')
    if (!from || !to || from === 'start' || to === 'end') {
      continue
    }
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      continue
    }
    arrayTransitions.push(transitionFromCanvasValue({ from, to, raw, allowRawId: true }))
  }
  // Canvas transition edges are the user-edited surface; they take priority
  // over the top-level transitions array, which frontends keep as an
  // untouched (and therefore possibly stale) copy of the rendered schema.
  const bareCandidates: MatOSWorkflowTransitionEdge[] = []
  for (const raw of asArray(schema.edges)) {
    if (!isRecord(raw)) {
      continue
    }
    const from = resolveId(cozeEdgeEndpoint(raw, true) ?? '')
    const to = resolveId(cozeEdgeEndpoint(raw, false) ?? '')
    if (!from || !to || from === 'start' || to === 'end') {
      continue
    }
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      continue
    }
    if (!isTransitionCanvasEdge(raw) && !options.stateMachine) {
      continue
    }
    const transition = transitionFromCanvasValue({ from, to, raw })
    if (transitionHasMetadata(transition)) {
      push(transition)
    } else {
      bareCandidates.push(transition)
    }
  }
  // Frontends may strip transition metadata from canvas edges on save. A bare
  // from->to edge must not duplicate or shadow a metadata-rich transition for
  // the same pair; recover metadata from the untouched top-level transitions
  // array first, then from the current asset definition, before falling back
  // to an unguarded transition.
  const knownPairs = new Set(
    transitions.map(transition => `${transition.from}->${transition.to}`),
  )
  for (const bare of bareCandidates) {
    const pair = `${bare.from}->${bare.to}`
    if (knownPairs.has(pair)) {
      continue
    }
    const fromArray = arrayTransitions.filter(
      transition =>
        transition.from === bare.from &&
        transition.to === bare.to &&
        (!transition.id || !seenIds.has(transition.id)),
    )
    const inherited = (options.currentDefinition?.transitions ?? [])
      .map(transition => ({
        ...transition,
        from: resolveId(transition.from),
        to: resolveId(transition.to),
      }))
      .filter(
        transition =>
          transition.from === bare.from &&
          transition.to === bare.to &&
          (!transition.id || !seenIds.has(transition.id)),
      )
    const recovered = fromArray.length > 0 ? fromArray : inherited
    if (recovered.length > 0) {
      for (const transition of recovered) {
        push({ ...transition })
      }
    } else {
      push(bare)
    }
    knownPairs.add(pair)
  }
  if (!hasCanvasEdges) {
    // Node-only canvas payloads have no edge surface; the transitions array
    // is authoritative there (legacy behavior).
    for (const transition of arrayTransitions) {
      push(transition)
    }
  }
  // With a live edge surface, array entries whose pair has no surviving
  // canvas edge belong to transitions the user deleted on the canvas; do not
  // resurrect them.
  return transitions
}

export type ExtractedCanvasEdge = {
  edge: MatOSWorkflowEdge
  /** Condition/route metadata was explicitly present on the canvas edge. */
  explicit: boolean
}

export function extractEdges(
  schema: Record<string, unknown>,
  nodeIds: Set<string>,
  options: {
    stateMachine: boolean
    resolveId?: (id: string) => string
  } = { stateMachine: false },
): ExtractedCanvasEdge[] {
  const resolveId = options.resolveId ?? ((id: string) => id)
  const edges: ExtractedCanvasEdge[] = []
  const seen = new Set<string>()
  for (const raw of asArray(schema.edges)) {
    if (!isRecord(raw)) {
      continue
    }
    if (isTransitionCanvasEdge(raw) || options.stateMachine) {
      continue
    }
    const from = resolveId(cozeEdgeEndpoint(raw, true) ?? '')
    const to = resolveId(cozeEdgeEndpoint(raw, false) ?? '')
    if (!from || !to || from === to || from === 'start' || to === 'end') {
      continue
    }
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      continue
    }
    const data = recordAt(raw, 'data')
    const edge: MatOSWorkflowEdge = { from, to }
    const condition = firstString(raw.condition, data?.matos_condition)
    if (condition) {
      edge.condition = condition
    }
    const route = firstString(raw.route, data?.matos_route, data?.route)
    if (route === 'success' || route === 'failure' || route === 'always') {
      edge.route = route
    }
    // Present-but-empty condition/route keys mean the user explicitly cleared
    // the field on the canvas, which must not fall back to inheritance.
    const explicit =
      raw.condition !== undefined ||
      raw.route !== undefined ||
      (data ? data.matos_condition !== undefined : false) ||
      (data ? data.matos_route !== undefined : false) ||
      (data ? data.route !== undefined : false)
    const key = `${edge.from}->${edge.to}:${edge.condition ?? ''}:${edge.route ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      edges.push({ edge, explicit })
    }
  }
  return edges
}

export function fieldType(value: unknown): string | undefined {
  const type = firstString(recordAt(value, 'schema')?.type, isRecord(value) ? value.type : undefined)
  if (!type) {
    return undefined
  }
  switch (type.toLowerCase()) {
    case 'int':
    case 'integer':
      return 'integer'
    case 'float':
    case 'double':
    case 'number':
      return 'number'
    case 'bool':
      return 'boolean'
    case 'list':
    case 'array':
      return 'array'
    default:
      return type
  }
}

/** Mirror of the forward adapter's cozeFieldTypeFromMatOS display mapping. */
export function renderedCozeFieldType(spec: Record<string, unknown>): string {
  const type = String(spec.type ?? '').toLowerCase()
  if (type === 'integer' || type === 'int') {
    return 'integer'
  }
  if (type === 'number' || type === 'float' || type === 'double') {
    return 'number'
  }
  if (type === 'boolean' || type === 'bool') {
    return 'boolean'
  }
  if (type === 'object') {
    return 'object'
  }
  if (type === 'array' || type === 'list') {
    return 'list'
  }
  return 'string'
}

/**
 * Synthetic display-only entries the forward projection invents when a
 * workflow has no parameters/outputs (so the Coze start/end forms render).
 * Unedited placeholders must not become real native fields on save.
 */
export const CANVAS_FIELD_PLACEHOLDERS: Record<'parameter' | 'output', {
  name: string
  type: string
  required: boolean
  description: string
}> = {
  parameter: {
    name: 'objective',
    type: 'string',
    required: true,
    description: 'MatOS workflow objective.',
  },
  output: {
    name: 'result',
    type: 'string',
    required: false,
    description: 'MatOS workflow result.',
  },
}

export function isUneditedCanvasPlaceholder(
  name: string,
  raw: unknown,
  kind: 'parameter' | 'output',
): boolean {
  if (!isRecord(raw) || raw.is_matos_placeholder !== true) {
    return false
  }
  const placeholder = CANVAS_FIELD_PLACEHOLDERS[kind]
  if (name !== placeholder.name) {
    return false
  }
  if ((fieldType(raw) ?? 'string') !== placeholder.type) {
    return false
  }
  if (raw.required !== undefined && Boolean(raw.required) !== placeholder.required) {
    return false
  }
  if (
    raw.description !== undefined &&
    String(raw.description ?? '') !== placeholder.description
  ) {
    return false
  }
  return raw.default === undefined && raw.default_value === undefined
}

export function canvasFieldEntries(value: unknown): Array<readonly [string | undefined, unknown]> {
  return Array.isArray(value)
    ? value.map(
        (item, index) =>
          [
            firstString(
              recordAt(item, 'data')?.name,
              isRecord(item) ? item.name : undefined,
              `param_${index + 1}`,
            ),
            item,
          ] as const,
      )
    : Object.entries(isRecord(value) ? value : {})
}

export function canvasFieldBaseSpec(
  raw: unknown,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const fromCanvas = isRecord(raw) ? parseNestedJsonRecord(raw.matos_spec) : undefined
  return fromCanvas ?? current
}

/**
 * Merges one canvas form entry over its native spec. Core display fields
 * (type/required/description/default) only overwrite the native value when
 * the canvas value differs from what the forward projection rendered, so an
 * untouched save keeps the native spec byte-identical (integer types, extra
 * keys, undefined-vs-rendered required) while real edits stick.
 */
export function mergeCanvasFieldSpec(input: {
  raw: unknown
  base?: Record<string, unknown>
  kind: 'parameter' | 'output'
}): Record<string, unknown> {
  const raw = isRecord(input.raw) ? input.raw : {}
  const base = input.base
  if (!base) {
    const rawDefault = raw.default !== undefined ? raw.default : raw.default_value
    return {
      ...(fieldType(raw) ? { type: fieldType(raw) } : {}),
      ...(input.kind === 'parameter' && raw.required !== undefined
        ? { required: Boolean(raw.required) }
        : {}),
      ...(optionalString(raw.description)
        ? { description: optionalString(raw.description) }
        : {}),
      ...(input.kind === 'parameter' && rawDefault !== undefined && rawDefault !== '' && rawDefault !== null
        ? { default: typeof rawDefault === 'string' ? parseJsonMaybe(rawDefault) : rawDefault }
        : {}),
    }
  }
  const merged: Record<string, unknown> = { ...base }
  const canvasType = fieldType(raw)
  if (canvasType !== undefined && canvasType !== renderedCozeFieldType(base)) {
    merged.type = canvasType
  }
  if (input.kind === 'parameter' && raw.required !== undefined) {
    const renderedRequired = base.required === false ? false : true
    if (Boolean(raw.required) !== renderedRequired) {
      merged.required = Boolean(raw.required)
    }
  }
  if (raw.description !== undefined) {
    const canvasDescription = String(raw.description ?? '')
    const renderedDescription = String(base.description ?? '')
    if (canvasDescription !== renderedDescription) {
      if (canvasDescription.trim()) {
        merged.description = canvasDescription.trim()
      } else {
        delete merged.description
      }
    }
  }
  if (input.kind === 'parameter') {
    const rawDefault = raw.default !== undefined ? raw.default : raw.default_value
    if (rawDefault !== undefined) {
      if (rawDefault === '' || rawDefault === null) {
        delete merged.default
      } else {
        const canvasDefault =
          typeof rawDefault === 'string' ? parseJsonMaybe(rawDefault) : rawDefault
        if (JSON.stringify(canvasDefault) !== JSON.stringify(base.default)) {
          merged.default = canvasDefault
        }
      }
    }
  }
  return merged
}

export function paramsFromCozeFields(
  value: unknown,
  options: { currentSpecs?: Record<string, MatOSWorkflowParameter> } = {},
): Record<string, MatOSWorkflowParameter> {
  const params: Record<string, MatOSWorkflowParameter> = {}
  for (const [rawName, rawSpec] of canvasFieldEntries(value)) {
    const name = optionalString(rawName)
    if (!name || isUneditedCanvasPlaceholder(name, rawSpec, 'parameter')) {
      continue
    }
    const base = canvasFieldBaseSpec(
      rawSpec,
      options.currentSpecs?.[name] as Record<string, unknown> | undefined,
    )
    params[name] = mergeCanvasFieldSpec({
      raw: rawSpec,
      ...(base ? { base } : {}),
      kind: 'parameter',
    }) as MatOSWorkflowParameter
  }
  return params
}

export function outputsFromCozeFields(
  value: unknown,
  options: { currentSpecs?: Record<string, MatOSWorkflowOutput> } = {},
): Record<string, MatOSWorkflowOutput> {
  const outputs: Record<string, MatOSWorkflowOutput> = {}
  for (const [rawName, rawSpec] of canvasFieldEntries(value)) {
    const name = optionalString(rawName)
    if (!name || isUneditedCanvasPlaceholder(name, rawSpec, 'output')) {
      continue
    }
    const base = canvasFieldBaseSpec(
      rawSpec,
      options.currentSpecs?.[name] as Record<string, unknown> | undefined,
    )
    outputs[name] = mergeCanvasFieldSpec({
      raw: rawSpec,
      ...(base ? { base } : {}),
      kind: 'output',
    }) as MatOSWorkflowOutput
  }
  return outputs
}
