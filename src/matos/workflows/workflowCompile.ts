import { createHash } from 'node:crypto'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  WorkflowContractMap,
} from './types.js'
import { buildWorkflowContractMap } from './workflowContracts.js'
import { compileWorkflowDefinition } from './workflowCompiler.js'
import { workflowExecutionModel } from './stateMachineTypes.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'

export type WorkflowCompileDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  nodeId?: string
  path?: string
}

export type WorkflowCompileMetadata = {
  schemaVersion: 1
  compilerVersion: 'matos-workflow-compile-v1'
  compiledAt: string
  workflowRef?: string
  sourceDigest: string
  snapshotDigest: string
  nodeCount: number
  edgeCount: number
  transitionCount: number
  executionModel: ReturnType<typeof workflowExecutionModel>
  contractNodeCount: number
  budgetEstimate: WorkflowCompileBudgetEstimate
  risk: 'low' | 'medium' | 'high'
  reviewedHighRiskBypassTrusted?: boolean
}

export type WorkflowCompileBudgetEstimate = {
  agentCalls: number
  toolCalls: number
  backendJobs: number
  childRuns: number
  dynamicPatches: number
}

export type WorkflowCompileView = {
  ok: boolean
  workflowRef?: string
  definition: MatOSWorkflowDefinition
  metadata: WorkflowCompileMetadata
  contracts: WorkflowContractMap
  diagnostics: WorkflowCompileDiagnostic[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nodeRisk(node: MatOSWorkflowNode): 'low' | 'medium' | 'high' {
  const risk = node.policy?.risk
  if (risk === 'high' || risk === 'medium' || risk === 'low') {
    return risk
  }
  if (node.type === 'backend' || node.type === 'dynamic') {
    return 'medium'
  }
  if (node.type === 'human') {
    return 'low'
  }
  return 'low'
}

function workflowPolicyRisk(
  definition: MatOSWorkflowDefinition,
): 'low' | 'medium' | 'high' {
  const risk = definition.policy.defaultRisk
  return risk === 'high' || risk === 'medium' || risk === 'low' ? risk : 'low'
}

function maxRisk(values: Array<'low' | 'medium' | 'high'>): 'low' | 'medium' | 'high' {
  if (values.includes('high')) {
    return 'high'
  }
  if (values.includes('medium')) {
    return 'medium'
  }
  return 'low'
}

function estimateBudget(
  definition: MatOSWorkflowDefinition,
): WorkflowCompileBudgetEstimate {
  return definition.nodes.reduce<WorkflowCompileBudgetEstimate>(
    (totals, node) => {
      if (node.type === 'agent') {
        totals.agentCalls += 1
      }
      if (node.type === 'exec' || node.type === 'guard') {
        totals.toolCalls += 1
      }
      if (node.type === 'backend') {
        totals.backendJobs += 1
      }
      if (node.type === 'subworkflow' || node.type === 'map' || node.type === 'loop') {
        totals.childRuns += 1
      }
      if (node.type === 'dynamic') {
        totals.dynamicPatches += 1
      }
      return totals
    },
    {
      agentCalls: 0,
      toolCalls: 0,
      backendJobs: 0,
      childRuns: 0,
      dynamicPatches: 0,
    },
  )
}

export function workflowCompileDiagnosticsForValidation(
  validation: ReturnType<typeof validateWorkflowDefinition>,
): WorkflowCompileDiagnostic[] {
  return validation.errors.map(error => ({
    severity: 'error',
    code: error.code,
    message: error.message,
    ...(error.nodeId ? { nodeId: error.nodeId } : {}),
    ...(error.path ? { path: error.path } : {}),
  }))
}

export function compileMatOSWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
  options: {
    workflowRef?: string
    compiledAt?: string
    allowReviewedHighRiskBypass?: boolean
    /**
     * Extra parameter ids known to be valid at runtime (e.g. the keys of an
     * active run's resolved parameters). Without them, recompiling a live
     * run's patched graph can flag legitimate parameter references as
     * unknown and produce a spurious `ok: false`.
     */
    knownParameterIds?: Iterable<string>
  } = {},
): WorkflowCompileView {
  const compiled = compileWorkflowDefinition(definition)
  const validation = validateWorkflowDefinition(compiled, {
    allowReviewedHighRiskBypass: options.allowReviewedHighRiskBypass,
    knownParameterIds: options.knownParameterIds,
  })
  const contracts = buildWorkflowContractMap(compiled)
  const metadata: WorkflowCompileMetadata = {
    schemaVersion: 1,
    compilerVersion: 'matos-workflow-compile-v1',
    compiledAt: options.compiledAt ?? new Date().toISOString(),
    ...(options.workflowRef ? { workflowRef: options.workflowRef } : {}),
    sourceDigest: sha256Json(definition),
    snapshotDigest: sha256Json(compiled),
    nodeCount: compiled.nodes.length,
    edgeCount: compiled.edges?.length ?? 0,
    transitionCount: compiled.transitions?.length ?? 0,
    executionModel: workflowExecutionModel(compiled),
    contractNodeCount: Object.keys(contracts.nodes).length,
    budgetEstimate: estimateBudget(compiled),
    risk: maxRisk([workflowPolicyRisk(compiled), ...compiled.nodes.map(nodeRisk)]),
    ...(options.allowReviewedHighRiskBypass
      ? { reviewedHighRiskBypassTrusted: true }
      : {}),
  }

  const diagnostics = workflowCompileDiagnosticsForValidation(validation)
  return {
    ok: validation.ok,
    ...(options.workflowRef ? { workflowRef: options.workflowRef } : {}),
    definition: {
      ...compiled,
      compiled: {
        ...cloneJson(metadata),
        ok: validation.ok,
        diagnostics: cloneJson(diagnostics),
        contracts: cloneJson(contracts),
      },
    },
    metadata,
    contracts,
    diagnostics,
  }
}
