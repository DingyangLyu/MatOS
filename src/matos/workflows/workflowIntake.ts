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
  MatOSWorkflowParameter,
} from './types.js'
import { resolveWorkflowParameters } from './runState.js'
import {
  buildWorkflowRunIoProtocol,
  buildWorkflowRunPreflight,
  workflowParameterContract,
  type MatOSWorkflowRunIoProtocol,
  type MatOSWorkflowRunPreflight,
} from './workflowIo.js'

export type MatOSWorkflowIntakeField = {
  key: string
  label: string
  type: string
  required: boolean
  widget:
    | 'text'
    | 'textarea'
    | 'number'
    | 'checkbox'
    | 'json'
    | 'select'
    | 'multiSelect'
    | 'path'
    | 'assetPicker'
    | 'materialPicker'
  description?: string
  placeholder?: string
  help?: string
  advanced?: boolean
  sourceHints?: string[]
  defaultValue?: unknown
  providedValue?: unknown
  resolvedValue?: unknown
  missing: boolean
  options?: unknown[]
  schema?: unknown
  format?: string
  contract?: {
    type: string
    required?: boolean
    description?: string
    schema?: unknown
  }
  valueSource: 'provided' | 'default' | 'missing' | 'unresolved'
  provenance: {
    source: 'user' | 'manifest_default' | 'missing' | 'resolver'
    reason: string
  }
  question: string
  sourceCandidates: Array<{
    kind:
      | 'manual'
      | 'default'
      | 'workspace_file'
      | 'asset'
      | 'data_center'
      | 'previous_trace'
    label: string
    enabled: boolean
    reason: string
    query?: string
  }>
}

export type MatOSWorkflowIntakeView = {
  mode: 'native-workflow-intake'
  schemaVersion: 1
  workflowRef: string
  fields: MatOSWorkflowIntakeField[]
  providedParameters: Record<string, unknown>
  resolvedParameters?: Record<string, unknown>
  missingRequired: string[]
  errors: Array<{ code: string; message: string; field?: string }>
  canRun: boolean
  io: MatOSWorkflowRunIoProtocol
  preflight: MatOSWorkflowRunPreflight
  runSummary: MatOSWorkflowRunPreflight['summary']
  inputPlan: {
    missingQuestions: Array<{
      field: string
      question: string
      widget: MatOSWorkflowIntakeField['widget']
      sourceCandidates: MatOSWorkflowIntakeField['sourceCandidates']
    }>
    prefilledFieldCount: number
    missingFieldCount: number
    agentAssistRecommended: boolean
    firstAgentWaitingInputExpected: boolean
    riskSummary: {
      level: 'low' | 'medium' | 'high'
      reasons: string[]
    }
  }
  executionPreview: {
    firstNodeIds: string[]
    agentFirst: boolean
    containsAgentNodes: boolean
    containsHumanInput: boolean
    containsApprovalGate: boolean
    containsBackendNodes: boolean
  }
  actions: {
    run: {
      endpoint: 'workflows.run'
      params: {
        workflowRef: string
        parameters: Record<string, unknown>
      }
      enabled: boolean
    }
    askAgent: {
      endpoint: 'workflows.intake.assist'
      enabled: true
      reason: string
    }
  }
}

function titleCaseFromKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

function parameterType(parameter: MatOSWorkflowParameter): string {
  return typeof parameter.type === 'string' && parameter.type.trim()
    ? parameter.type.trim()
    : 'string'
}

function arrayOption(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function parameterOptions(parameter: MatOSWorkflowParameter): unknown[] | undefined {
  return (
    arrayOption(parameter.enum) ??
    arrayOption(parameter.options) ??
    arrayOption((parameter.ui as { options?: unknown } | undefined)?.options)
  )
}

function parameterUi(parameter: MatOSWorkflowParameter): Record<string, unknown> | undefined {
  return parameter.ui && typeof parameter.ui === 'object' && !Array.isArray(parameter.ui)
    ? (parameter.ui as Record<string, unknown>)
    : undefined
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim())
    : undefined
}

function parameterFormat(parameter: MatOSWorkflowParameter): string | undefined {
  return trimmedString(parameter.format) ?? trimmedString(parameterUi(parameter)?.format)
}

function parameterTitle(key: string, parameter: MatOSWorkflowParameter): string {
  return (
    trimmedString(parameter.label) ??
    trimmedString(parameter.title) ??
    trimmedString(parameterUi(parameter)?.label) ??
    titleCaseFromKey(key)
  )
}

function parameterDescription(parameter: MatOSWorkflowParameter): string | undefined {
  return trimmedString(parameter.description)
}

function parameterHelp(parameter: MatOSWorkflowParameter): string | undefined {
  return trimmedString(parameterUi(parameter)?.help)
}

function parameterPlaceholder(parameter: MatOSWorkflowParameter): string | undefined {
  return trimmedString(parameterUi(parameter)?.placeholder)
}

function parameterSourceHints(parameter: MatOSWorkflowParameter): string[] | undefined {
  return stringArray(parameterUi(parameter)?.sourceHints)
}

function parameterAdvanced(parameter: MatOSWorkflowParameter): boolean | undefined {
  const value = parameterUi(parameter)?.advanced
  return typeof value === 'boolean' ? value : undefined
}

function sourceCandidateKindsFromHints(hints: string[] | undefined): Set<string> {
  return new Set((hints ?? []).map(hint => hint.trim().toLowerCase()).filter(Boolean))
}

function buildFieldQuestion(input: {
  key: string
  label: string
  parameter: MatOSWorkflowParameter
  widget: MatOSWorkflowIntakeField['widget']
  description?: string
}): string {
  const description = input.description ? ` ${input.description}` : ''
  switch (input.widget) {
    case 'path':
      return `请选择或填写 ${input.label} 的工作区可见路径。${description}`.trim()
    case 'assetPicker':
      return `请选择要用于 ${input.label} 的 MatOS 资产引用。${description}`.trim()
    case 'materialPicker':
      return `请选择 ${input.label} 对应的材料或数据集记录。${description}`.trim()
    case 'json':
      return `请补充 ${input.label} 的结构化 JSON 输入。${description}`.trim()
    case 'checkbox':
      return `请确认 ${input.label} 是否启用。${description}`.trim()
    default:
      return `请提供 ${input.label}。${description}`.trim()
  }
}

function buildSourceCandidates(input: {
  key: string
  widget: MatOSWorkflowIntakeField['widget']
  parameter: MatOSWorkflowParameter
  sourceHints?: string[]
  hasDefault: boolean
}): MatOSWorkflowIntakeField['sourceCandidates'] {
  const hints = sourceCandidateKindsFromHints(input.sourceHints)
  const candidates: MatOSWorkflowIntakeField['sourceCandidates'] = []
  const add = (
    kind: MatOSWorkflowIntakeField['sourceCandidates'][number]['kind'],
    label: string,
    reason: string,
    extra: Partial<MatOSWorkflowIntakeField['sourceCandidates'][number]> = {},
  ) => {
    if (candidates.some(candidate => candidate.kind === kind)) {
      return
    }
    candidates.push({
      kind,
      label,
      reason,
      enabled: true,
      ...extra,
    })
  }

  if (input.hasDefault) {
    add('default', 'Use workflow default', 'The workflow definition declares a default value for this field.')
  }
  if (input.widget === 'path' || hints.has('file') || hints.has('workspace')) {
    add('workspace_file', 'Pick workspace file', 'This field expects a path visible to the workflow runtime.', {
      query: input.key,
    })
  }
  if (input.widget === 'assetPicker' || hints.has('asset')) {
    add('asset', 'Pick MatOS asset', 'This field can be satisfied by a versioned MatOS asset reference.', {
      query: input.key,
    })
  }
  if (input.widget === 'materialPicker' || hints.has('data') || hints.has('dataset') || hints.has('material')) {
    add('data_center', 'Search Data Center', 'This field can be filled from a curated data or material record.', {
      query: input.key,
    })
  }
  add('previous_trace', 'Reuse previous run evidence', 'The assistant may suggest values from prior workflow traces when provenance matches.')
  add('manual', 'Enter manually', 'The user can provide an explicit value in the intake form or chat.')
  return candidates
}

function widgetForParameter(
  key: string,
  parameter: MatOSWorkflowParameter,
): MatOSWorkflowIntakeField['widget'] {
  const declaredWidget = trimmedString(parameterUi(parameter)?.widget)
  if (declaredWidget === 'assetPicker' || declaredWidget === 'materialPicker') {
    return declaredWidget
  }
  if (declaredWidget === 'file' || declaredWidget === 'directory' || declaredWidget === 'path') {
    return 'path'
  }
  if (declaredWidget === 'multiSelect') {
    return 'multiSelect'
  }
  if (
    declaredWidget === 'text' ||
    declaredWidget === 'textarea' ||
    declaredWidget === 'number' ||
    declaredWidget === 'select' ||
    declaredWidget === 'checkbox' ||
    declaredWidget === 'json'
  ) {
    return declaredWidget
  }
  const options = parameterOptions(parameter)
  if (options?.length) {
    return 'select'
  }
  const type = parameterType(parameter)
  const format = parameterFormat(parameter)
  const lowerKey = key.toLowerCase()
  if (
    format === 'path' ||
    format === 'file' ||
    format === 'directory' ||
    /(?:path|file|dir|workdir|folder)$/.test(lowerKey)
  ) {
    return 'path'
  }
  if (type === 'boolean') {
    return 'checkbox'
  }
  if (type === 'number' || type === 'integer') {
    return 'number'
  }
  if (type === 'object' || type === 'array') {
    return 'json'
  }
  const description = parameter.description
  if (typeof description === 'string' && description.length > 160) {
    return 'textarea'
  }
  return 'text'
}

function fieldSchema(parameter: MatOSWorkflowParameter): unknown | undefined {
  if (parameter.schema !== undefined) {
    return parameter.schema
  }
  if (parameter.jsonSchema !== undefined) {
    return parameter.jsonSchema
  }
  return undefined
}

function missingRequiredFields(
  definition: MatOSWorkflowDefinition,
  parameters: Record<string, unknown>,
): string[] {
  return Object.entries(definition.parameters)
    .filter(([key, parameter]) => {
      if (parameter.required !== true || parameters[key] !== undefined) {
        return false
      }
      return !(
        Object.prototype.hasOwnProperty.call(parameter, 'default') &&
        parameter.default !== undefined
      )
    })
    .map(([key]) => key)
}

function nodeType(value: { type?: unknown; targetType?: unknown; runtimeType?: unknown }): string {
  return String(value.runtimeType ?? value.targetType ?? value.type ?? '')
}

function buildExecutionPreview(definition: MatOSWorkflowDefinition): MatOSWorkflowIntakeView['executionPreview'] {
  const firstNodes = definition.nodes.filter(node => node.dependsOn.length === 0)
  const firstTypes = firstNodes.map(nodeType)
  const nodeTypes = definition.nodes.map(nodeType)
  return {
    firstNodeIds: firstNodes.map(node => node.id),
    agentFirst: firstTypes.includes('agent'),
    containsAgentNodes: nodeTypes.includes('agent'),
    containsHumanInput: nodeTypes.includes('human'),
    containsApprovalGate: nodeTypes.includes('approval_gate'),
    containsBackendNodes: nodeTypes.some(type => type === 'backend' || type === 'compute'),
  }
}

function buildInputRiskSummary(input: {
  preflight: MatOSWorkflowRunPreflight
  missingRequired: string[]
  executionPreview: MatOSWorkflowIntakeView['executionPreview']
}): MatOSWorkflowIntakeView['inputPlan']['riskSummary'] {
  const reasons: string[] = []
  let level: 'low' | 'medium' | 'high' = 'low'
  if (
    input.preflight.summary.risk === 'high' ||
    input.preflight.summary.approvalMode === 'strict' ||
    input.preflight.summary.confirmationRecommended
  ) {
    level = 'high'
    reasons.push('Workflow contains high-risk or approval-gated side effects.')
  } else if (input.executionPreview.containsBackendNodes) {
    level = 'medium'
    reasons.push('Workflow contains backend or compute nodes that may call external systems.')
  }
  if (input.missingRequired.length) {
    level = level === 'high' ? 'high' : 'medium'
    reasons.push(`Missing required workflow inputs: ${input.missingRequired.join(', ')}.`)
  }
  if (input.executionPreview.containsHumanInput) {
    reasons.push('Workflow may pause for structured human input.')
  }
  if (input.executionPreview.agentFirst) {
    reasons.push('The first runnable node is an agent; intake should preserve the initial user goal and context.')
  }
  return {
    level,
    reasons: reasons.length ? reasons : ['Workflow input preflight has no obvious blocking risks.'],
  }
}

export function buildMatOSWorkflowIntakeView(input: {
  workflowRef: string
  definition: MatOSWorkflowDefinition
  parameters?: Record<string, unknown>
}): MatOSWorkflowIntakeView {
  const providedParameters = input.parameters ?? {}
  let resolvedParameters: Record<string, unknown> | undefined
  const errors: MatOSWorkflowIntakeView['errors'] = []
  const missingRequired = missingRequiredFields(input.definition, providedParameters)
  const parameterContracts = workflowParameterContract(input.definition)

  if (missingRequired.length === 0) {
    try {
      resolvedParameters = resolveWorkflowParameters(input.definition, providedParameters)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const match = message.match(/^Workflow parameter "([^"]+)"/)
      errors.push({
        code: 'parameter_validation_failed',
        message,
        ...(match?.[1] ? { field: match[1] } : {}),
      })
    }
  }

  const fields = Object.entries(input.definition.parameters).map(
    ([key, parameter]): MatOSWorkflowIntakeField => {
      const hasDefault = Object.prototype.hasOwnProperty.call(parameter, 'default')
      const hasProvided = Object.prototype.hasOwnProperty.call(providedParameters, key)
      const resolvedValue = resolvedParameters?.[key]
      const contract = parameterContracts[key]
      const options = parameterOptions(parameter)
      const schema = fieldSchema(parameter)
      const format = parameterFormat(parameter)
      const description = parameterDescription(parameter)
      const placeholder = parameterPlaceholder(parameter)
      const help = parameterHelp(parameter)
      const sourceHints = parameterSourceHints(parameter)
      const advanced = parameterAdvanced(parameter)
      const widget = widgetForParameter(key, parameter)
      const hasUsableDefault = hasDefault && parameter.default !== undefined
      const missing =
        parameter.required === true &&
        providedParameters[key] === undefined &&
        !hasUsableDefault
      const valueSource: MatOSWorkflowIntakeField['valueSource'] =
        hasProvided
          ? 'provided'
          : hasUsableDefault
            ? 'default'
            : missing
              ? 'missing'
              : resolvedValue !== undefined
                ? 'unresolved'
                : 'unresolved'
      const provenance: MatOSWorkflowIntakeField['provenance'] =
        valueSource === 'provided'
          ? { source: 'user', reason: 'Parameter was provided by the run request.' }
          : valueSource === 'default'
            ? { source: 'manifest_default', reason: 'Parameter default came from the workflow definition.' }
            : valueSource === 'missing'
              ? { source: 'missing', reason: 'Required parameter has no provided value or default.' }
              : { source: 'resolver', reason: 'Parameter is optional and unresolved for this run intake.' }
      return {
        key,
        label: parameterTitle(key, parameter),
        type: parameterType(parameter),
        required: parameter.required === true,
        widget,
        ...(description ? { description } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(help ? { help } : {}),
        ...(advanced !== undefined ? { advanced } : {}),
        ...(sourceHints?.length ? { sourceHints } : {}),
        ...(hasDefault ? { defaultValue: parameter.default } : {}),
        ...(hasProvided ? { providedValue: providedParameters[key] } : {}),
        ...(resolvedValue !== undefined ? { resolvedValue } : {}),
        missing,
        ...(options?.length ? { options } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...(format ? { format } : {}),
        ...(contract
          ? {
              contract: {
                type: contract.type,
                ...(typeof contract.required === 'boolean'
                  ? { required: contract.required }
                  : {}),
                ...(typeof contract.description === 'string'
                  ? { description: contract.description }
                  : {}),
                ...(contract.schema !== undefined ? { schema: contract.schema } : {}),
              },
            }
          : {}),
        valueSource,
        provenance,
        question: buildFieldQuestion({
          key,
          label: parameterTitle(key, parameter),
          parameter,
          widget,
          description,
        }),
        sourceCandidates: buildSourceCandidates({
          key,
          widget,
          parameter,
          sourceHints,
          hasDefault: hasUsableDefault,
        }),
      }
    },
  )

  const io = buildWorkflowRunIoProtocol(input.definition)
  const preflight = buildWorkflowRunPreflight({
    definition: input.definition,
    missingRequiredParameters: missingRequired,
  })
  const canRun = errors.length === 0 && preflight.canRun
  const executionPreview = buildExecutionPreview(input.definition)
  const missingQuestions = fields
    .filter(field => field.missing)
    .map(field => ({
      field: field.key,
      question: field.question,
      widget: field.widget,
      sourceCandidates: field.sourceCandidates,
    }))
  return {
    mode: 'native-workflow-intake',
    schemaVersion: 1,
    workflowRef: input.workflowRef,
    fields,
    providedParameters,
    ...(resolvedParameters ? { resolvedParameters } : {}),
    missingRequired,
    errors,
    canRun,
    io,
    preflight: {
      ...preflight,
      canRun,
      ok: canRun && preflight.missingNodeInputs.every(item => item.severity !== 'error'),
    },
    runSummary: preflight.summary,
    inputPlan: {
      missingQuestions,
      prefilledFieldCount: fields.filter(field => !field.missing && field.valueSource !== 'unresolved').length,
      missingFieldCount: missingQuestions.length,
      agentAssistRecommended: missingQuestions.length > 0 || executionPreview.agentFirst,
      firstAgentWaitingInputExpected: executionPreview.agentFirst && missingQuestions.length > 0,
      riskSummary: buildInputRiskSummary({
        preflight,
        missingRequired,
        executionPreview,
      }),
    },
    executionPreview,
    actions: {
      run: {
        endpoint: 'workflows.run',
        params: {
          workflowRef: input.workflowRef,
          parameters: resolvedParameters ?? providedParameters,
        },
        enabled: canRun,
      },
      askAgent: {
        endpoint: 'workflows.intake.assist',
        enabled: true,
        reason: canRun
          ? 'Agent can review or refine the prepared workflow input before run.'
          : 'Agent can help collect or infer missing workflow input fields.',
      },
    },
  }
}
