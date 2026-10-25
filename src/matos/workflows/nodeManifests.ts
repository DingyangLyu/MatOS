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
  MatOSWorkflowNodeType,
  MatOSWorkflowRuntimeNodeType,
  MatOSWorkflowTargetNodeType,
  WorkflowValueContract,
} from './types.js'

export type MatOSWorkflowNodeFieldManifest = {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'asset-ref' | 'expression' | 'textarea' | 'select'
  required?: boolean
  default?: unknown
  options?: Array<{ label: string; value: string }>
  assetTypes?: string[]
  description?: string
}

export type MatOSWorkflowNodeManifestCategory =
  | 'agent'
  | 'code'
  | 'compute'
  | 'data'
  | 'knowledge'
  | 'control'
  | 'human'
  | 'artifact'
  | 'report'
  | 'advanced'

export type MatOSWorkflowNodePort = {
  id: string
  label: string
  type: WorkflowValueContract['type'] | 'artifact' | 'asset-ref' | 'run-ref'
  description?: string
}

export type MatOSWorkflowNodePolicyDefaults = {
  risk: 'low' | 'medium' | 'high'
  sideEffectClass:
    | 'none'
    | 'model_call'
    | 'local_process'
    | 'external_backend'
    | 'human_input'
    | 'child_workflow'
    | 'iteration_children'
    | 'graph_patch'
  replaySafe: boolean
}

export type MatOSWorkflowNodeDebugManifest = {
  supportsDryRun: boolean
  supportsSingleNodeTest: boolean
  resultViews: Array<'json' | 'markdown' | 'logs' | 'artifacts' | 'trace'>
}

export type MatOSWorkflowNodeManifestValueTypeMapping = {
  matosType: string
  cozeType: string
  lossless: boolean
  note?: string
}

export type MatOSWorkflowNodeManifestCozeAdapter = {
  nodeDTOType: string
  nodeMetaPath: string
  inputParametersPath: string
  outputsPath: string
  nativeProductField: 'matosProduct'
  variableTypeMap: MatOSWorkflowNodeManifestValueTypeMapping[]
  settingOnErrorMapping?: {
    nativePolicyPath: string
    uiOnly: boolean
    supportedModes: string[]
  }
  testRunMapping?: {
    endpoint: 'workflows.nodeDebug'
    inputPath: string
    resultViews: MatOSWorkflowNodeDebugManifest['resultViews']
  }
}

export type MatOSWorkflowNodeManifestCompile = {
  runtimeType: MatOSWorkflowRuntimeNodeType
  targetType: MatOSWorkflowTargetNodeType
  nativeProductField: 'matosProduct'
  policyPath: 'policy'
  contractPaths: {
    inputs: 'inputContract'
    outputs: 'outputContract'
    artifacts: 'artifactContract'
  }
}

export type MatOSWorkflowNodeManifest = {
  schemaVersion?: 1
  type: MatOSWorkflowNodeType
  id?: string
  version?: string
  title: string
  description: string
  display?: {
    title: string
    description: string
    iconKey: string
    category: MatOSWorkflowNodeManifestCategory
  }
  semanticType?: MatOSWorkflowTargetNodeType
  category?: MatOSWorkflowNodeManifestCategory
  runtimeType: MatOSWorkflowRuntimeNodeType
  targetType: MatOSWorkflowTargetNodeType
  cozeNodeType: string
  cozeAdapter?: MatOSWorkflowNodeManifestCozeAdapter
  iconKey: string
  palette: boolean
  advanced?: boolean
  fields: MatOSWorkflowNodeFieldManifest[]
  ports?: {
    inputs: MatOSWorkflowNodePort[]
    outputs: MatOSWorkflowNodePort[]
    error?: MatOSWorkflowNodePort
  }
  policyDefaults?: MatOSWorkflowNodePolicyDefaults
  debug?: MatOSWorkflowNodeDebugManifest
  form?: {
    fields: MatOSWorkflowNodeFieldManifest[]
    requiredFields: string[]
  }
  variables?: {
    inputs: MatOSWorkflowNodePort[]
    outputs: MatOSWorkflowNodePort[]
  }
  contracts?: {
    inputContractPath: 'inputContract'
    outputContractPath: 'outputContract'
    artifactContractPath: 'artifactContract'
  }
  compile?: MatOSWorkflowNodeManifestCompile
  matosProduct?: {
    semanticType: MatOSWorkflowTargetNodeType
    runtimeType: MatOSWorkflowRuntimeNodeType
    category: MatOSWorkflowNodeManifestCategory
    manifestType: MatOSWorkflowNodeType
  }
}

export type MatOSWorkflowNodeManifestSummary = MatOSWorkflowNodeManifest & {
  requiredFields: string[]
}

export type MatOSWorkflowNodeManifestIssue = {
  severity: 'error' | 'warning'
  type?: string
  code: string
  message: string
  path?: string
}

export type MatOSWorkflowNodeManifestValidationResult = {
  ok: boolean
  manifestCount: number
  paletteCount: number
  advancedCount: number
  runtimeTypes: MatOSWorkflowRuntimeNodeType[]
  semanticTypes: MatOSWorkflowTargetNodeType[]
  issues: MatOSWorkflowNodeManifestIssue[]
}

export type MatOSWorkflowNodeManifestCoverageReport = {
  validation: MatOSWorkflowNodeManifestValidationResult
  samples: Array<{
    type: MatOSWorkflowNodeType
    title: string
    runtimeType: MatOSWorkflowRuntimeNodeType
    targetType: MatOSWorkflowTargetNodeType
    palette: boolean
    advanced: boolean
    node: MatOSWorkflowNode
    definition: MatOSWorkflowDefinition
  }>
}

export const MATOS_WORKFLOW_RUNTIME_NODE_TYPES: MatOSWorkflowRuntimeNodeType[] = [
  'agent',
  'exec',
  'guard',
  'human',
  'backend',
  'subworkflow',
  'map',
  'loop',
  'dynamic',
]

export const MATOS_WORKFLOW_SEMANTIC_NODE_TYPES: MatOSWorkflowTargetNodeType[] = [
  'compute',
  'instrument',
  'approval_gate',
  'validate',
  'supernode',
  'extension',
]

export const MATOS_WORKFLOW_TARGET_RUNTIME_TYPES: Partial<
  Record<MatOSWorkflowTargetNodeType, MatOSWorkflowRuntimeNodeType>
> = {
  approval_gate: 'human',
  compute: 'backend',
  instrument: 'backend',
  validate: 'guard',
  supernode: 'subworkflow',
}

export function workflowRuntimeTypeForNodeType(
  type: MatOSWorkflowNodeType,
): MatOSWorkflowRuntimeNodeType | undefined {
  if ((MATOS_WORKFLOW_RUNTIME_NODE_TYPES as string[]).includes(type)) {
    return type as MatOSWorkflowRuntimeNodeType
  }
  return MATOS_WORKFLOW_TARGET_RUNTIME_TYPES[type]
}

export function workflowTargetTypeForNodeType(
  type: MatOSWorkflowNodeType,
): MatOSWorkflowTargetNodeType {
  return type as MatOSWorkflowTargetNodeType
}

export function normalizeWorkflowValueType(
  type: unknown,
  fallback: WorkflowValueContract['type'] = 'object',
): WorkflowValueContract['type'] {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : ''
  switch (normalized) {
    case 'int':
    case 'integer':
    case 'float':
    case 'double':
      return 'number'
    case 'bool':
      return 'boolean'
    case 'list':
      return 'array'
    case 'map':
    case 'record':
      return 'object'
    case 'string':
    case 'number':
    case 'boolean':
    case 'object':
    case 'array':
    case 'null':
      return normalized
    default:
      return normalized || fallback
  }
}

const commonFields: MatOSWorkflowNodeFieldManifest[] = [
  { key: 'id', label: 'Node id', type: 'string', required: true },
  { key: 'dependsOn', label: 'Dependencies', type: 'array' },
  { key: 'inputContract', label: 'Input contract', type: 'object' },
  { key: 'outputContract', label: 'Output contract', type: 'object' },
  { key: 'artifactContract', label: 'Artifact contract', type: 'object' },
  { key: 'policy', label: 'Policy', type: 'object' },
]

export const MATOS_WORKFLOW_NODE_MANIFESTS: MatOSWorkflowNodeManifest[] = [
  {
    type: 'agent',
    title: 'Agent Role',
    description: 'Run a MatOS role through the native CLI-backed agent runtime.',
    runtimeType: 'agent',
    targetType: 'agent',
    cozeNodeType: '3',
    iconKey: 'agent',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'agent' },
      { key: 'role', label: 'Role asset ref', type: 'asset-ref', required: true, assetTypes: ['role'] },
      { key: 'prompt', label: 'Prompt', type: 'textarea' },
      {
        key: 'artifactContext',
        label: 'Artifact context',
        type: 'object',
        description:
          'Optional explicit upstream artifact refs or paths whose small text content should be appended to the agent prompt.',
      },
      {
        key: 'artifactContextMaxBytes',
        label: 'Artifact context max bytes',
        type: 'number',
        default: 12000,
      },
      { key: 'outputSchema', label: 'Structured output schema', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'exec',
    title: 'Code / Deterministic Transform',
    description: 'Run deterministic shell or Python code for parsing, transforms, plotting data, or artifact manifests.',
    runtimeType: 'exec',
    targetType: 'exec',
    cozeNodeType: '5',
    iconKey: 'exec',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'exec' },
      { key: 'command', label: 'Command', type: 'textarea', required: true },
      { key: 'args', label: 'Arguments', type: 'array' },
      { key: 'cwd', label: 'Working directory', type: 'string' },
      { key: 'env', label: 'Environment', type: 'object' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'compute',
    title: 'Compute Job',
    description: 'Submit, reconcile, and recover a real scientific compute job through MatOS backend adapters.',
    runtimeType: 'backend',
    targetType: 'compute',
    cozeNodeType: '4',
    iconKey: 'backend',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'compute' },
      { key: 'backend', label: 'Compute backend', type: 'string', required: true, default: 'local' },
      { key: 'tool', label: 'Adapter tool', type: 'string', required: true, default: 'tool:conda-environment-catalog' },
      { key: 'operation', label: 'Operation', type: 'string' },
      { key: 'input', label: 'Compute input', type: 'object' },
      { key: 'computeLifecycle', label: 'Compute lifecycle', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'instrument',
    title: 'Lab Instrument',
    description:
      'Operate a physical or simulated lab instrument through a MatOS instrument adapter tool. Physical operations require human approval before execution.',
    runtimeType: 'backend',
    targetType: 'instrument',
    cozeNodeType: '4',
    iconKey: 'backend',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'instrument' },
      { key: 'instrument', label: 'Instrument id', type: 'string', required: true },
      { key: 'operation', label: 'Operation', type: 'string' },
      // Validation requires an explicit adapter tool ref on instrument nodes
      // (no backend tool defaults for physical-world targets), so the builder
      // form marks it required too.
      {
        key: 'tool',
        label: 'Adapter tool asset ref',
        type: 'asset-ref',
        required: true,
        assetTypes: ['tool'],
      },
      { key: 'input', label: 'Instrument task input', type: 'object' },
      { key: 'computeLifecycle', label: 'Job lifecycle', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'validate',
    title: 'Scientific Validate',
    description: 'Evaluate deterministic validation checks and route based on structured validation results.',
    runtimeType: 'guard',
    targetType: 'validate',
    cozeNodeType: '8',
    iconKey: 'validate',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'validate' },
      { key: 'checks', label: 'Checks', type: 'array', required: true },
      { key: 'recommendation', label: 'Recommendation', type: 'select' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'human',
    title: 'Human Input / Review',
    description: 'Pause for structured human input or review without bypassing MatOS workflow state.',
    runtimeType: 'human',
    targetType: 'human',
    cozeNodeType: '18',
    iconKey: 'human',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'human' },
      { key: 'prompt', label: 'Prompt', type: 'textarea' },
      { key: 'responseSchema', label: 'Response schema', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'approval_gate',
    title: 'Approval Gate',
    description: 'Require an explicit human approval before high-risk or external side-effect steps continue.',
    runtimeType: 'human',
    targetType: 'approval_gate',
    cozeNodeType: '18',
    iconKey: 'human',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'approval_gate' },
      { key: 'prompt', label: 'Approval prompt', type: 'textarea' },
      { key: 'responseSchema', label: 'Approval response schema', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'subworkflow',
    title: 'Subworkflow',
    description: 'Run another MatOS workflow asset as a reusable child workflow.',
    runtimeType: 'subworkflow',
    targetType: 'subworkflow',
    cozeNodeType: '9',
    iconKey: 'subworkflow',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'subworkflow' },
      { key: 'workflow', label: 'Workflow asset ref', type: 'asset-ref', required: true, assetTypes: ['workflow'] },
      { key: 'parameters', label: 'Parameters', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'map',
    title: 'Map / Batch',
    description: 'Run a child workflow across a bounded item collection with explicit parallelism.',
    runtimeType: 'map',
    targetType: 'map',
    cozeNodeType: '21',
    iconKey: 'map',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'map' },
      { key: 'workflow', label: 'Workflow asset ref', type: 'asset-ref', required: true, assetTypes: ['workflow'] },
      { key: 'items', label: 'Items expression', type: 'expression', required: true },
      { key: 'maxParallel', label: 'Max parallel', type: 'number' },
      { key: 'maxItems', label: 'Max items', type: 'number' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'loop',
    title: 'Loop',
    description: 'Run a child workflow repeatedly with an explicit iteration bound and stop condition.',
    runtimeType: 'loop',
    targetType: 'loop',
    cozeNodeType: '21',
    iconKey: 'loop',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'loop' },
      { key: 'workflow', label: 'Workflow asset ref', type: 'asset-ref', required: true, assetTypes: ['workflow'] },
      { key: 'maxIterations', label: 'Max iterations', type: 'number', required: true },
      { key: 'until', label: 'Stop condition', type: 'expression' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'dynamic',
    title: 'Dynamic Planner',
    description: 'Let a workflow planner propose a bounded graph patch through MatOS validation and approval.',
    runtimeType: 'dynamic',
    targetType: 'dynamic',
    cozeNodeType: '21',
    iconKey: 'dynamic',
    palette: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'dynamic' },
      { key: 'role', label: 'Planner role asset ref', type: 'asset-ref', assetTypes: ['role'] },
      { key: 'prompt', label: 'Planner prompt', type: 'textarea' },
      { key: 'candidate', label: 'Graph patch candidate', type: 'object' },
      { key: 'input', label: 'Planner input', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'backend',
    title: 'Backend Action',
    description: 'Internal advanced backend action used by MatOS adapters; normal users should use Agent or Compute nodes.',
    runtimeType: 'backend',
    targetType: 'backend',
    cozeNodeType: '4',
    iconKey: 'backend',
    palette: false,
    advanced: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'backend' },
      { key: 'backend', label: 'Backend or adapter', type: 'string', required: true },
      { key: 'tool', label: 'Adapter tool', type: 'asset-ref', assetTypes: ['tool'], required: true, default: 'tool:conda-environment-catalog' },
      { key: 'operation', label: 'Operation', type: 'string' },
      { key: 'inputs', label: 'Inputs', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'guard',
    title: 'Guard',
    description: 'Internal deterministic guard; normal users should use Scientific Validate.',
    runtimeType: 'guard',
    targetType: 'guard',
    cozeNodeType: '8',
    iconKey: 'validate',
    palette: false,
    advanced: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'guard' },
      { key: 'checks', label: 'Checks', type: 'array', required: true },
      ...commonFields.slice(1),
    ],
  },
  {
    type: 'supernode',
    title: 'Subworkflow Component',
    description: 'Semantic component call compiled into the native subworkflow runtime.',
    runtimeType: 'subworkflow',
    targetType: 'supernode',
    cozeNodeType: '9',
    iconKey: 'subworkflow',
    palette: false,
    advanced: true,
    fields: [
      commonFields[0],
      { key: 'type', label: 'Node type', type: 'select', required: true, default: 'supernode' },
      { key: 'workflow', label: 'Workflow asset ref', type: 'asset-ref', required: true, assetTypes: ['workflow'] },
      { key: 'parameters', label: 'Parameters', type: 'object' },
      ...commonFields.slice(1),
    ],
  },
]

export const MATOS_WORKFLOW_NODE_MANIFEST_BY_TYPE = new Map(
  MATOS_WORKFLOW_NODE_MANIFESTS.map(manifest => [manifest.type, manifest]),
)

const errorPort: MatOSWorkflowNodePort = {
  id: 'error',
  label: 'Error',
  type: 'object',
  description: 'Structured native MatOS workflow error and diagnostics.',
}

function categoryForManifest(
  manifest: MatOSWorkflowNodeManifest,
): MatOSWorkflowNodeManifestCategory {
  if (manifest.advanced === true) {
    return 'advanced'
  }
  switch (manifest.type) {
    case 'agent':
    case 'dynamic':
      return 'agent'
    case 'exec':
      return 'code'
    case 'compute':
    case 'backend':
      return 'compute'
    case 'human':
    case 'approval_gate':
      return 'human'
    case 'validate':
    case 'guard':
    case 'subworkflow':
    case 'supernode':
    case 'map':
    case 'loop':
      return 'control'
    default:
      return 'advanced'
  }
}

function policyDefaultsForManifest(
  manifest: MatOSWorkflowNodeManifest,
): MatOSWorkflowNodePolicyDefaults {
  switch (manifest.type) {
    case 'agent':
      return { risk: 'medium', sideEffectClass: 'model_call', replaySafe: false }
    case 'exec':
      return { risk: 'medium', sideEffectClass: 'local_process', replaySafe: false }
    case 'compute':
    case 'backend':
      return {
        risk: manifest.type === 'compute' ? 'high' : 'medium',
        sideEffectClass: 'external_backend',
        replaySafe: false,
      }
    case 'human':
    case 'approval_gate':
      return { risk: 'low', sideEffectClass: 'human_input', replaySafe: true }
    case 'subworkflow':
    case 'supernode':
      return { risk: 'medium', sideEffectClass: 'child_workflow', replaySafe: false }
    case 'map':
    case 'loop':
      return {
        risk: 'medium',
        sideEffectClass: 'iteration_children',
        replaySafe: false,
      }
    case 'dynamic':
      return { risk: 'high', sideEffectClass: 'graph_patch', replaySafe: false }
    case 'validate':
    case 'guard':
    default:
      return { risk: 'low', sideEffectClass: 'none', replaySafe: true }
  }
}

function debugForManifest(
  manifest: MatOSWorkflowNodeManifest,
): MatOSWorkflowNodeDebugManifest {
  const views: MatOSWorkflowNodeDebugManifest['resultViews'] = ['json', 'trace']
  if (['exec', 'backend', 'compute'].includes(manifest.type)) {
    views.push('logs')
  }
  if (['exec', 'agent', 'compute', 'backend', 'subworkflow', 'supernode'].includes(manifest.type)) {
    views.push('artifacts')
  }
  if (['agent', 'human', 'approval_gate', 'dynamic'].includes(manifest.type)) {
    views.push('markdown')
  }
  return {
    supportsDryRun: ['exec', 'backend', 'compute', 'validate', 'guard'].includes(manifest.type),
    supportsSingleNodeTest: true,
    resultViews: [...new Set(views)],
  }
}

function variableTypeMapForManifest(): MatOSWorkflowNodeManifestValueTypeMapping[] {
  return [
    { matosType: 'string', cozeType: 'string', lossless: true },
    { matosType: 'number', cozeType: 'float', lossless: true },
    { matosType: 'integer', cozeType: 'integer', lossless: true },
    { matosType: 'float', cozeType: 'float', lossless: true },
    { matosType: 'boolean', cozeType: 'boolean', lossless: true },
    { matosType: 'object', cozeType: 'object', lossless: true },
    { matosType: 'array', cozeType: 'list', lossless: true },
    { matosType: 'list', cozeType: 'list', lossless: true },
    {
      matosType: 'asset-ref',
      cozeType: 'object',
      lossless: false,
      note: 'Native asset references keep full semantics in data.matos and matos_spec.',
    },
    {
      matosType: 'run-ref',
      cozeType: 'object',
      lossless: false,
      note: 'Native workflow run references keep full semantics in data.matos.',
    },
    {
      matosType: 'artifact',
      cozeType: 'object',
      lossless: false,
      note: 'Artifact bundles are native MatOS objects projected as Coze objects.',
    },
  ]
}

function cozeAdapterForManifest(
  manifest: MatOSWorkflowNodeManifest,
  debug: MatOSWorkflowNodeDebugManifest,
): MatOSWorkflowNodeManifestCozeAdapter {
  return {
    nodeDTOType: manifest.cozeNodeType,
    nodeMetaPath: 'data.matos',
    inputParametersPath: 'data.inputs.inputParameters',
    outputsPath: 'data.outputs',
    nativeProductField: 'matosProduct',
    variableTypeMap: variableTypeMapForManifest(),
    settingOnErrorMapping: {
      nativePolicyPath: 'policy',
      uiOnly: true,
      supportedModes: ['timeout', 'retry', 'fallback', 'exception_branch'],
    },
    testRunMapping: {
      endpoint: 'workflows.nodeDebug',
      inputPath: 'parameters',
      resultViews: debug.resultViews,
    },
  }
}

function compileForManifest(
  manifest: MatOSWorkflowNodeManifest,
): MatOSWorkflowNodeManifestCompile {
  return {
    runtimeType: manifest.runtimeType,
    targetType: manifest.targetType,
    nativeProductField: 'matosProduct',
    policyPath: 'policy',
    contractPaths: {
      inputs: 'inputContract',
      outputs: 'outputContract',
      artifacts: 'artifactContract',
    },
  }
}

function portsForManifest(manifest: MatOSWorkflowNodeManifest): {
  inputs: MatOSWorkflowNodePort[]
  outputs: MatOSWorkflowNodePort[]
  error?: MatOSWorkflowNodePort
} {
  switch (manifest.type) {
    case 'agent':
      return {
        inputs: [
          { id: 'task', label: 'Task', type: 'string' },
          { id: 'context', label: 'Context refs', type: 'object' },
        ],
        outputs: [
          { id: 'response', label: 'Response', type: 'object' },
          { id: 'artifacts', label: 'Artifacts', type: 'artifact' },
        ],
        error: errorPort,
      }
    case 'exec':
      return {
        inputs: [
          { id: 'args', label: 'Arguments', type: 'array' },
          { id: 'files', label: 'Input files', type: 'artifact' },
        ],
        outputs: [
          { id: 'stdout', label: 'Stdout', type: 'string' },
          { id: 'stderr', label: 'Stderr', type: 'string' },
          { id: 'artifacts', label: 'Artifacts', type: 'artifact' },
        ],
        error: errorPort,
      }
    case 'compute':
    case 'backend':
      return {
        inputs: [
          { id: 'input', label: 'Backend input', type: 'object' },
          { id: 'files', label: 'Input files', type: 'artifact' },
        ],
        outputs: [
          { id: 'receipt', label: 'Receipt', type: 'object' },
          { id: 'status', label: 'Status', type: 'object' },
          { id: 'artifacts', label: 'Artifacts', type: 'artifact' },
        ],
        error: errorPort,
      }
    case 'human':
    case 'approval_gate':
      return {
        inputs: [
          { id: 'prompt', label: 'Prompt', type: 'string' },
          { id: 'evidence', label: 'Evidence', type: 'object' },
        ],
        outputs: [
          { id: 'response', label: 'Human response', type: 'object' },
          { id: 'decision', label: 'Decision', type: 'string' },
        ],
      }
    case 'subworkflow':
    case 'supernode':
      return {
        inputs: [
          { id: 'workflow', label: 'Workflow ref', type: 'asset-ref' },
          { id: 'parameters', label: 'Parameters', type: 'object' },
        ],
        outputs: [
          { id: 'childRun', label: 'Child run', type: 'run-ref' },
          { id: 'outputs', label: 'Child outputs', type: 'object' },
          { id: 'artifacts', label: 'Artifacts', type: 'artifact' },
        ],
        error: errorPort,
      }
    case 'map':
      return {
        inputs: [
          { id: 'items', label: 'Items', type: 'array' },
          { id: 'workflow', label: 'Workflow ref', type: 'asset-ref' },
        ],
        outputs: [
          { id: 'results', label: 'Child results', type: 'array' },
          { id: 'artifacts', label: 'Artifacts', type: 'artifact' },
        ],
        error: errorPort,
      }
    case 'loop':
      return {
        inputs: [
          { id: 'state', label: 'Initial state', type: 'object' },
          { id: 'workflow', label: 'Workflow ref', type: 'asset-ref' },
        ],
        outputs: [
          { id: 'state', label: 'Final state', type: 'object' },
          { id: 'iterations', label: 'Iterations', type: 'array' },
        ],
        error: errorPort,
      }
    case 'dynamic':
      return {
        inputs: [
          { id: 'goal', label: 'Goal', type: 'string' },
          { id: 'currentGraph', label: 'Current graph', type: 'object' },
        ],
        outputs: [
          { id: 'patch', label: 'Graph patch', type: 'object' },
          { id: 'validation', label: 'Validation', type: 'object' },
        ],
        error: errorPort,
      }
    case 'validate':
    case 'guard':
    default:
      return {
        inputs: [
          { id: 'checks', label: 'Checks', type: 'array' },
          { id: 'values', label: 'Values', type: 'object' },
        ],
        outputs: [
          { id: 'validation', label: 'Validation result', type: 'object' },
          { id: 'recommendation', label: 'Recommendation', type: 'string' },
        ],
      }
  }
}

export const MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES: MatOSWorkflowNodeManifestSummary[] =
  MATOS_WORKFLOW_NODE_MANIFESTS.map(manifest => {
    const category = manifest.category ?? categoryForManifest(manifest)
    const ports = manifest.ports ?? portsForManifest(manifest)
    const policyDefaults =
      manifest.policyDefaults ?? policyDefaultsForManifest(manifest)
    const debug = manifest.debug ?? debugForManifest(manifest)
    const requiredFields = manifest.fields
      .filter(field => field.required)
      .map(field => field.key)
    return {
      ...manifest,
      schemaVersion: manifest.schemaVersion ?? 1,
      id: manifest.id ?? `workflow-node:${manifest.type}@1.0.0`,
      version: manifest.version ?? '1.0.0',
      semanticType: manifest.semanticType ?? manifest.targetType,
      category,
      display: manifest.display ?? {
        title: manifest.title,
        description: manifest.description,
        iconKey: manifest.iconKey,
        category,
      },
      ports,
      policyDefaults,
      debug,
      cozeAdapter: manifest.cozeAdapter ?? cozeAdapterForManifest(manifest, debug),
      form: manifest.form ?? {
        fields: manifest.fields,
        requiredFields,
      },
      variables: manifest.variables ?? {
        inputs: ports.inputs,
        outputs: ports.outputs,
      },
      contracts: manifest.contracts ?? {
        inputContractPath: 'inputContract',
        outputContractPath: 'outputContract',
        artifactContractPath: 'artifactContract',
      },
      compile: manifest.compile ?? compileForManifest(manifest),
      matosProduct: manifest.matosProduct ?? {
        semanticType: manifest.targetType,
        runtimeType: manifest.runtimeType,
        category,
        manifestType: manifest.type,
      },
      requiredFields,
    }
  })

export function workflowNodeManifestForType(
  type: MatOSWorkflowNodeType | string | undefined,
): MatOSWorkflowNodeManifest | undefined {
  return type ? MATOS_WORKFLOW_NODE_MANIFEST_BY_TYPE.get(type as MatOSWorkflowNodeType) : undefined
}

const manifestFieldTypes = new Set<MatOSWorkflowNodeFieldManifest['type']>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'asset-ref',
  'expression',
  'textarea',
  'select',
])

const manifestPortTypes = new Set<MatOSWorkflowNodePort['type']>([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
  'artifact',
  'asset-ref',
  'run-ref',
])

function pushManifestIssue(
  issues: MatOSWorkflowNodeManifestIssue[],
  issue: MatOSWorkflowNodeManifestIssue,
): void {
  issues.push(issue)
}

export function validateMatOSWorkflowNodeManifests(
  manifests: MatOSWorkflowNodeManifestSummary[] = MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES,
): MatOSWorkflowNodeManifestValidationResult {
  const issues: MatOSWorkflowNodeManifestIssue[] = []
  const seen = new Set<string>()
  const expectedTypes = new Set<string>([
    ...MATOS_WORKFLOW_RUNTIME_NODE_TYPES,
    ...Object.keys(MATOS_WORKFLOW_TARGET_RUNTIME_TYPES),
  ])

  for (const manifest of manifests) {
    const path = `nodeManifests.${manifest.type}`
    if (seen.has(manifest.type)) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'duplicate_manifest_type',
        message: `Duplicate workflow node manifest type: ${manifest.type}`,
        path,
      })
    }
    seen.add(manifest.type)

    if (!expectedTypes.has(manifest.type)) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'unsupported_manifest_type',
        message: `Manifest type ${manifest.type} is not supported by the native workflow compiler.`,
        path,
      })
    }

    const expectedRuntimeType = workflowRuntimeTypeForNodeType(manifest.type)
    if (manifest.runtimeType !== expectedRuntimeType) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'runtime_type_mismatch',
        message: `Manifest runtimeType ${manifest.runtimeType} does not match compiler runtime ${expectedRuntimeType ?? 'undefined'}.`,
        path: `${path}.runtimeType`,
      })
    }

    const fieldKeys = new Set(manifest.fields.map(field => field.key))
    for (const required of ['id', 'type']) {
      if (!fieldKeys.has(required) || !manifest.requiredFields.includes(required)) {
        pushManifestIssue(issues, {
          severity: 'error',
          type: manifest.type,
          code: 'missing_required_field_manifest',
          message: `Manifest ${manifest.type} must expose required ${required} field.`,
          path: `${path}.fields.${required}`,
        })
      }
    }

    const typeField = manifest.fields.find(field => field.key === 'type')
    if (typeField?.default !== manifest.type) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'type_field_default_mismatch',
        message: `Manifest ${manifest.type} type field default must equal the node type.`,
        path: `${path}.fields.type.default`,
      })
    }

    for (const field of manifest.fields) {
      if (!manifestFieldTypes.has(field.type)) {
        pushManifestIssue(issues, {
          severity: 'error',
          type: manifest.type,
          code: 'invalid_field_type',
          message: `Field ${field.key} has unsupported manifest field type ${field.type}.`,
          path: `${path}.fields.${field.key}.type`,
        })
      }
      if (field.type === 'select' && field.options && !Array.isArray(field.options)) {
        pushManifestIssue(issues, {
          severity: 'error',
          type: manifest.type,
          code: 'invalid_select_options',
          message: `Select field ${field.key} options must be an array.`,
          path: `${path}.fields.${field.key}.options`,
        })
      }
    }

    const ports = manifest.ports
    if (!ports || !Array.isArray(ports.inputs) || !Array.isArray(ports.outputs)) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'missing_ports',
        message: `Manifest ${manifest.type} must declare native input/output ports.`,
        path: `${path}.ports`,
      })
    } else {
      for (const [direction, directionPorts] of [
        ['inputs', ports.inputs],
        ['outputs', ports.outputs],
      ] as const) {
        for (const port of directionPorts) {
          if (!port.id || !port.label || !manifestPortTypes.has(port.type)) {
            pushManifestIssue(issues, {
              severity: 'error',
              type: manifest.type,
              code: 'invalid_port',
              message: `Manifest ${manifest.type} has invalid ${direction} port ${port.id || '<missing>'}.`,
              path: `${path}.ports.${direction}.${port.id || '<missing>'}`,
            })
          }
        }
      }
    }

    if (!manifest.policyDefaults) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'missing_policy_defaults',
        message: `Manifest ${manifest.type} must expose policy defaults.`,
        path: `${path}.policyDefaults`,
      })
    }
    if (!manifest.debug) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: manifest.type,
        code: 'missing_debug_manifest',
        message: `Manifest ${manifest.type} must expose debug capabilities.`,
        path: `${path}.debug`,
      })
    }
    if (manifest.palette && (!manifest.title.trim() || !manifest.description.trim())) {
      pushManifestIssue(issues, {
        severity: 'warning',
        type: manifest.type,
        code: 'weak_palette_copy',
        message: `Palette node ${manifest.type} should have title and description copy.`,
        path,
      })
    }
  }

  for (const expected of expectedTypes) {
    if (!seen.has(expected)) {
      pushManifestIssue(issues, {
        severity: 'error',
        type: expected,
        code: 'missing_manifest_type',
        message: `Missing workflow node manifest for supported type ${expected}.`,
        path: `nodeManifests.${expected}`,
      })
    }
  }

  return {
    ok: !issues.some(issue => issue.severity === 'error'),
    manifestCount: manifests.length,
    paletteCount: manifests.filter(manifest => manifest.palette).length,
    advancedCount: manifests.filter(manifest => manifest.advanced === true).length,
    runtimeTypes: MATOS_WORKFLOW_RUNTIME_NODE_TYPES,
    semanticTypes: MATOS_WORKFLOW_SEMANTIC_NODE_TYPES,
    issues,
  }
}

function sampleValueForField(
  manifest: MatOSWorkflowNodeManifestSummary,
  field: MatOSWorkflowNodeFieldManifest,
): unknown {
  if (field.default !== undefined) {
    return field.default
  }
  switch (field.key) {
    case 'id':
      return `sample_${manifest.type.replace(/[^A-Za-z0-9_]/g, '_')}`
    case 'type':
      return manifest.type
    case 'role':
      // Unversioned: sample nodes are copied verbatim by agents/UI, and a
      // pinned version stops resolving as soon as the bundled role is bumped.
      return 'role:compute'
    case 'prompt':
      return `Use MatOS to execute the ${manifest.title} step and return concise structured evidence.`
    case 'command':
      return 'printf "matos workflow sample\\n"'
    case 'backend':
      return 'local'
    case 'operation':
      return 'profile'
    case 'input':
    case 'inputs':
    case 'toolInput':
      return {}
    case 'checks':
      return [{ type: 'expression', value: 'true' }]
    case 'recommendation':
      return 'continue'
    case 'workflow':
      return 'workflow:sample-child@0.1.0'
    case 'parameters':
      return {}
    case 'items':
      return '{{ parameters.items }}'
    case 'maxIterations':
      return 2
    case 'maxParallel':
    case 'maxItems':
      return 1
    case 'candidate':
      return { nodes: [] }
    case 'responseSchema':
    case 'outputSchema':
      return { type: 'object' }
    case 'outputContract':
      return { result: { type: 'object' } }
    case 'artifactContract':
      return {}
    case 'policy':
      return {}
    default:
      break
  }
  switch (field.type) {
    case 'number':
      return 1
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    case 'asset-ref':
      return field.assetTypes?.includes('workflow')
        ? 'workflow:sample-child@0.1.0'
        : field.assetTypes?.includes('role')
          ? 'role:compute'
          : 'asset:sample@0.1.0'
    case 'expression':
      return '{{ parameters.value }}'
    case 'select':
      return field.options?.[0]?.value ?? String(field.default ?? '')
    case 'textarea':
      return `${field.label} sample`
    case 'string':
    default:
      return `${field.key}-sample`
  }
}

export function sampleWorkflowNodeForManifest(
  manifest: MatOSWorkflowNodeManifestSummary,
): MatOSWorkflowNode {
  const alwaysSampleFields = new Set([
    'prompt',
    'operation',
    'input',
    'parameters',
    'candidate',
    'responseSchema',
  ])
  const node: Record<string, unknown> = {
    id: `sample_${manifest.type.replace(/[^A-Za-z0-9_]/g, '_')}`,
    type: manifest.type,
    dependsOn: [],
  }
  for (const field of manifest.fields) {
    if (field.key === 'dependsOn') {
      continue
    }
    if (field.required || field.default !== undefined || alwaysSampleFields.has(field.key)) {
      node[field.key] = sampleValueForField(manifest, field)
    }
  }
  return node as MatOSWorkflowNode
}

export function sampleWorkflowDefinitionForManifest(
  manifest: MatOSWorkflowNodeManifestSummary,
): MatOSWorkflowDefinition {
  const node = sampleWorkflowNodeForManifest(manifest)
  return {
    schemaVersion: 1,
    name: `sample-${manifest.type}`,
    version: '0.1.0',
    description: `Generated sample workflow for ${manifest.title}.`,
    parameters:
      manifest.type === 'map'
        ? { items: { type: 'array', required: true } }
        : {},
    policy: { approvalMode: 'bypass', defaultRisk: manifest.policyDefaults?.risk ?? 'low' },
    nodes: [node],
    outputs: {},
  }
}

export function workflowNodeManifestCoverageReport(
  manifests: MatOSWorkflowNodeManifestSummary[] = MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES,
): MatOSWorkflowNodeManifestCoverageReport {
  return {
    validation: validateMatOSWorkflowNodeManifests(manifests),
    samples: manifests.map(manifest => ({
      type: manifest.type,
      title: manifest.title,
      runtimeType: manifest.runtimeType,
      targetType: manifest.targetType,
      palette: manifest.palette,
      advanced: manifest.advanced === true,
      node: sampleWorkflowNodeForManifest(manifest),
      definition: sampleWorkflowDefinitionForManifest(manifest),
    })),
  }
}
