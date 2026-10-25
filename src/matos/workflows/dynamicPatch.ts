import { createHash } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowEdge,
  MatOSWorkflowNode,
  MatOSWorkflowOutput,
} from './types.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import { readJson, writeJson } from './jsonIo.js'

export type WorkflowGraphPatchOperation =
  | { op: 'add_node'; node: MatOSWorkflowNode }
  | { op: 'update_node'; nodeId: string; patch: Partial<MatOSWorkflowNode> }
  | { op: 'add_edge'; from: string; to: string; condition?: string; route?: string }
  | { op: 'remove_edge'; from: string; to: string }
  | { op: 'delete_node'; nodeId: string }
  | { op: 'set_outputs'; outputs: Record<string, MatOSWorkflowOutput> }
  | { type: 'add_node'; node: MatOSWorkflowNode }
  | { type: 'update_node'; nodeId: string; patch: Partial<MatOSWorkflowNode> }
  | { type: 'delete_node'; nodeId: string }
  | { type: 'connect'; from: string; to: string; condition?: string; route?: string }
  | { type: 'disconnect'; from: string; to: string }
  | { type: 'set_outputs'; outputs: Record<string, MatOSWorkflowOutput> }

export type WorkflowGraphPatchBudgetImpact = {
  addedNodes: number
  estimatedAgentCalls: number
  estimatedWallMinutes?: number
}

export type WorkflowGraphPatchRisk = 'low' | 'medium' | 'high'

export type WorkflowGraphPatchCandidate = {
  schemaVersion?: 1
  id?: string
  createdAt?: string
  sourceRunId?: string
  sourceNodeId?: string
  reason?: string
  operations: WorkflowGraphPatchOperation[]
  budgetImpact?: WorkflowGraphPatchBudgetImpact
  risk?: WorkflowGraphPatchRisk
  metadata?: Record<string, unknown>
}

export type WorkflowGraphPatchErrorCode =
  | 'invalid_patch'
  | 'unsupported_operation'
  | 'policy_limit'
  | 'restricted_patch_field'
  | 'undeclared_asset_reference'
  | 'invalid_scope'
  | 'validation_failed'

export type WorkflowGraphPatchError = {
  code: WorkflowGraphPatchErrorCode
  message: string
  path?: string
}

export type WorkflowGraphPatchValidationResult = {
  ok: boolean
  errors: WorkflowGraphPatchError[]
  patchedDefinition?: MatOSWorkflowDefinition
}

export type WorkflowGraphPatchDecisionStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'applied'

export type WorkflowGraphPatchDecision = {
  status: WorkflowGraphPatchDecisionStatus
  reason?: string
  decidedBy?: string
  decidedAt?: string
}

export type WorkflowGraphPatchValidationOptions = {
  allowedAssetRefs?: string[]
  knownParameterIds?: Iterable<string>
  limits?: Partial<WorkflowGraphPatchPolicyLimits>
  currentNestedWorkflowDepth?: number
}

export type WorkflowGraphPatchPolicyLimits = {
  maxNodes: number
  maxAddedNodesPerPatch: number
  maxFanOut: number
  maxLoopIterations: number
  maxNestedWorkflowDepth: number
}

export const DEFAULT_WORKFLOW_GRAPH_PATCH_LIMITS: WorkflowGraphPatchPolicyLimits = {
  maxNodes: 200,
  maxAddedNodesPerPatch: 30,
  maxFanOut: 64,
  maxLoopIterations: 10,
  maxNestedWorkflowDepth: 5,
}

const OPERATOR_PATCH_LIMIT_ENV_KEYS: Record<
  keyof WorkflowGraphPatchPolicyLimits,
  string
> = {
  maxNodes: 'MATOS_WORKFLOW_PATCH_MAX_NODES',
  maxAddedNodesPerPatch: 'MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH',
  maxFanOut: 'MATOS_WORKFLOW_PATCH_MAX_FAN_OUT',
  maxLoopIterations: 'MATOS_WORKFLOW_PATCH_MAX_LOOP_ITERATIONS',
  maxNestedWorkflowDepth: 'MATOS_WORKFLOW_PATCH_MAX_NESTED_WORKFLOW_DEPTH',
}

export type WorkflowGraphPatchOperatorPolicy = {
  limits: Partial<WorkflowGraphPatchPolicyLimits>
  requireApproval: boolean
}

/**
 * Site/operator-level dynamic patch policy hook. Deployment operators can
 * tighten patch limits and force every dynamic patch through human review
 * without editing individual workflow assets:
 * - `MATOS_WORKFLOW_PATCH_MAX_NODES`
 * - `MATOS_WORKFLOW_PATCH_MAX_ADDED_NODES_PER_PATCH`
 * - `MATOS_WORKFLOW_PATCH_MAX_FAN_OUT`
 * - `MATOS_WORKFLOW_PATCH_MAX_LOOP_ITERATIONS`
 * - `MATOS_WORKFLOW_PATCH_MAX_NESTED_WORKFLOW_DEPTH`
 * - `MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL=1|true|yes`
 * Operator limits take precedence over per-call options and defaults.
 */
export function workflowGraphPatchOperatorPolicy(
  env: Record<string, string | undefined> = process.env,
): WorkflowGraphPatchOperatorPolicy {
  const limits: Partial<WorkflowGraphPatchPolicyLimits> = {}
  for (const [key, envKey] of Object.entries(OPERATOR_PATCH_LIMIT_ENV_KEYS) as [
    keyof WorkflowGraphPatchPolicyLimits,
    string,
  ][]) {
    const raw = env[envKey]?.trim()
    if (!raw) {
      continue
    }
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) {
      limits[key] = Math.floor(value)
    }
  }
  const requireRaw = (env.MATOS_WORKFLOW_PATCH_REQUIRE_APPROVAL ?? '')
    .trim()
    .toLowerCase()
  return {
    limits,
    requireApproval:
      requireRaw === '1' || requireRaw === 'true' || requireRaw === 'yes',
  }
}

const WORKFLOW_GRAPH_PATCH_RISK_RANK: Record<WorkflowGraphPatchRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

function maxWorkflowGraphPatchRisk(
  left: WorkflowGraphPatchRisk,
  right: WorkflowGraphPatchRisk,
): WorkflowGraphPatchRisk {
  return WORKFLOW_GRAPH_PATCH_RISK_RANK[right] > WORKFLOW_GRAPH_PATCH_RISK_RANK[left]
    ? right
    : left
}

const RESTRICTED_FIELD_NAMES = new Set([
  'allowedTools',
  'disallowedTools',
  'toolAllowlist',
  'mcp',
  'mcpServers',
  'pluginDirs',
  'addDir',
  'permissionMode',
  'env',
  'secrets',
  'apiKey',
  'authToken',
  'password',
])

function cloneWorkflowDefinition(
  definition: MatOSWorkflowDefinition,
): MatOSWorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as MatOSWorkflowDefinition
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function pushError(
  errors: WorkflowGraphPatchError[],
  code: WorkflowGraphPatchErrorCode,
  message: string,
  path?: string,
): void {
  errors.push({ code, message, ...(path ? { path } : {}) })
}

function sanitizedPatchId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  // A segment of only dots ('.', '..', '...') survives the charset filter
  // but is empty-or-traversal as a directory name — '..' would resolve the
  // patch ledger to the run directory itself. Never allow it.
  if (!cleaned || /^\.+$/.test(cleaned)) {
    return 'patch'
  }
  return cleaned
}

function nowIso(): string {
  return new Date().toISOString()
}

async function nextGraphSnapshotName(runDir: string): Promise<string> {
  let maxVersion = 1
  try {
    const entries = await readdir(runDir)
    for (const entry of entries) {
      const match = entry.match(/^graph\.snapshot\.v([0-9]+)\.json$/)
      if (match) {
        maxVersion = Math.max(maxVersion, Number(match[1] ?? 1))
      }
    }
  } catch {
    maxVersion = 1
  }
  return `graph.snapshot.v${maxVersion + 1}.json`
}

function assertObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function findRestrictedFields(
  value: unknown,
  path: string,
  errors: WorkflowGraphPatchError[],
): void {
  if (!assertObject(value)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        findRestrictedFields(item, `${path}[${index}]`, errors),
      )
    }
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (RESTRICTED_FIELD_NAMES.has(key)) {
      pushError(
        errors,
        'restricted_patch_field',
        `Dynamic workflow patches cannot introduce restricted field "${key}"`,
        childPath,
      )
    }
    findRestrictedFields(child, childPath, errors)
  }
}

function checkDeclaredAssetReference(
  ref: unknown,
  path: string,
  allowedRefs: Set<string>,
  errors: WorkflowGraphPatchError[],
): void {
  if (typeof ref !== 'string' || !ref.includes(':')) {
    return
  }
  if (!allowedRefs.has(ref)) {
    pushError(
      errors,
      'undeclared_asset_reference',
      `Dynamic workflow patch references undeclared asset ${ref}`,
      path,
    )
  }
}

function operationName(operation: Record<string, unknown>): string | undefined {
  const op = operation.op
  if (typeof op === 'string') {
    return op
  }
  const legacy = operation.type
  if (legacy === 'connect') {
    return 'add_edge'
  }
  if (legacy === 'disconnect') {
    return 'remove_edge'
  }
  return typeof legacy === 'string' ? legacy : undefined
}

function canonicalOperation(
  operation: Record<string, unknown>,
): WorkflowGraphPatchOperation | undefined {
  const op = operationName(operation)
  if (op === 'add_node' && assertObject(operation.node)) {
    return {
      op,
      node: operation.node as unknown as MatOSWorkflowNode,
    }
  }
  if (op === 'update_node' && typeof operation.nodeId === 'string') {
    return {
      op,
      nodeId: operation.nodeId,
      patch: metadataObject(operation.patch) as Partial<MatOSWorkflowNode>,
    }
  }
  if (
    op === 'add_edge' &&
    typeof operation.from === 'string' &&
    typeof operation.to === 'string'
  ) {
    return {
      op,
      from: operation.from,
      to: operation.to,
      ...(typeof operation.condition === 'string'
        ? { condition: operation.condition }
        : {}),
      ...(typeof operation.route === 'string'
        ? { route: operation.route }
        : {}),
    }
  }
  if (
    op === 'remove_edge' &&
    typeof operation.from === 'string' &&
    typeof operation.to === 'string'
  ) {
    return { op, from: operation.from, to: operation.to }
  }
  if (op === 'delete_node' && typeof operation.nodeId === 'string') {
    return { op, nodeId: operation.nodeId }
  }
  if (op === 'set_outputs' && assertObject(operation.outputs)) {
    return {
      op,
      outputs: operation.outputs as Record<string, MatOSWorkflowOutput>,
    }
  }
  return undefined
}

function metadataObject(value: unknown): Record<string, unknown> {
  return assertObject(value) ? value : {}
}

/**
 * Every shell command a patched-in node would execute (exec `command`, guard
 * command checks, nested payload commands). Recursive by design: risk scoring
 * must err toward flagging, since a missed command is auto-executed shell.
 */
function collectWorkflowGraphPatchNodeCommands(
  value: unknown,
  commands: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWorkflowGraphPatchNodeCommands(item, commands)
    }
    return commands
  }
  if (!assertObject(value)) {
    return commands
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'command' && typeof child === 'string' && child.trim().length > 0) {
      commands.push(child.trim())
    }
    collectWorkflowGraphPatchNodeCommands(child, commands)
  }
  return commands
}

/**
 * Operator/author-declared shell commands a dynamic patch may introduce while
 * staying auto-applicable (`policy.dynamicCommandAllowlist`, exact match
 * after trimming). Patch operations cannot mutate `policy`, so reading the
 * allowlist off the patched definition is equivalent to the pre-patch one and
 * a patch cannot grant itself entries.
 */
function workflowGraphPatchCommandAllowlist(
  definition: MatOSWorkflowDefinition | undefined,
): Set<string> {
  const raw = definition?.policy?.dynamicCommandAllowlist
  if (!Array.isArray(raw)) {
    return new Set()
  }
  return new Set(
    raw
      .filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
      .map(item => item.trim()),
  )
}

function workflowGraphPatchNodeRisk(
  node: Partial<MatOSWorkflowNode> | undefined,
  patchedDefinition?: MatOSWorkflowDefinition,
): WorkflowGraphPatchRisk {
  switch (node?.type) {
    case 'backend':
    case 'compute':
    // Physical instrument actuation is force-approved in the normal compile
    // path (isPhysicalInstrumentOperation); a patched-in instrument node
    // must never rate below 'high' or the auto-apply gate could skip review.
    case 'instrument':
    case 'human':
    case 'approval_gate':
    case 'extension':
      return 'high'
    default:
      break
  }
  // Semantic targets can also ride on a generic node type (e.g. type
  // 'backend' handled above, but compiled nodes may carry targetType only).
  if (node?.targetType === 'instrument' || node?.targetType === 'compute') {
    return 'high'
  }
  // Command gating is opt-in: a workflow that declares
  // `policy.dynamicCommandAllowlist` is asking for strict control, so any
  // patch-introduced command outside that allowlist must take the 'medium'
  // review gate. When no allowlist is declared the prior low-risk behavior
  // is preserved, because auto-applying a planner-added exec node does not
  // escalate privilege in this runtime (the same agent could run the command
  // directly) and gating by default would break autonomous dynamic planners
  // whose commands are generated at run time and cannot be pre-declared.
  const commands = collectWorkflowGraphPatchNodeCommands(node)
  if (commands.length > 0) {
    const allowlist = workflowGraphPatchCommandAllowlist(patchedDefinition)
    if (allowlist.size > 0 && commands.some(command => !allowlist.has(command))) {
      return 'medium'
    }
  }
  return 'low'
}

// Gate nodes enforce quality/approval boundaries. Rewiring an edge that
// touches one can silently bypass the gate, so such edge operations must not
// stay auto-applicable.
const WORKFLOW_GRAPH_PATCH_GATE_NODE_TYPES = new Set<string>([
  'guard',
  'validate',
  'human',
  'approval_gate',
])

function workflowGraphPatchEdgeRisk(
  operation: WorkflowGraphPatchOperation,
  patchedDefinition?: MatOSWorkflowDefinition,
): WorkflowGraphPatchRisk {
  const from = 'from' in operation ? operation.from : undefined
  const to = 'to' in operation ? operation.to : undefined
  for (const nodeId of [from, to]) {
    if (!nodeId) {
      continue
    }
    const node = patchedDefinition?.nodes.find(item => item.id === nodeId)
    if (node && WORKFLOW_GRAPH_PATCH_GATE_NODE_TYPES.has(node.type)) {
      return 'medium'
    }
  }
  return 'low'
}

function workflowGraphPatchOperationRisk(
  operation: WorkflowGraphPatchOperation,
  patchedDefinition?: MatOSWorkflowDefinition,
): WorkflowGraphPatchRisk {
  const op = 'op' in operation ? operation.op : operationName(operation)
  switch (op) {
    case 'add_node':
      return workflowGraphPatchNodeRisk(
        'node' in operation ? operation.node : undefined,
        patchedDefinition,
      )
    case 'update_node': {
      const nodeId = 'nodeId' in operation ? operation.nodeId : undefined
      const patchedNode = patchedDefinition?.nodes.find(
        node => node.id === nodeId,
      )
      return maxWorkflowGraphPatchRisk(
        'medium',
        workflowGraphPatchNodeRisk(
          patchedNode ?? ('patch' in operation ? operation.patch : undefined),
          patchedDefinition,
        ),
      )
    }
    case 'delete_node':
      return 'high'
    case 'add_edge':
    case 'remove_edge':
      return workflowGraphPatchEdgeRisk(operation, patchedDefinition)
    case 'set_outputs':
      return 'low'
    default:
      return 'medium'
  }
}

export function workflowGraphPatchEffectiveRisk(
  candidate: WorkflowGraphPatchCandidate,
  patchedDefinition?: MatOSWorkflowDefinition,
): WorkflowGraphPatchRisk {
  let risk = candidate.risk ?? 'low'
  for (const operation of candidate.operations) {
    risk = maxWorkflowGraphPatchRisk(
      risk,
      workflowGraphPatchOperationRisk(operation, patchedDefinition),
    )
  }
  return risk
}

export function normalizeWorkflowGraphPatchCandidate(
  candidate: unknown,
): {
  candidate?: WorkflowGraphPatchCandidate
  errors: WorkflowGraphPatchError[]
} {
  const errors: WorkflowGraphPatchError[] = []
  if (!assertObject(candidate)) {
    return {
      errors: [
        {
          code: 'invalid_patch',
          message: 'Dynamic workflow patch candidate must be an object',
        },
      ],
    }
  }

  const raw = candidate as Record<string, unknown>
  const isSpecShape = raw.schemaVersion !== undefined
  if (isSpecShape && raw.schemaVersion !== 1) {
    pushError(errors, 'invalid_patch', 'Dynamic workflow patch schemaVersion must be 1', 'schemaVersion')
  }
  if (isSpecShape && typeof raw.sourceNodeId !== 'string') {
    pushError(errors, 'invalid_patch', 'Dynamic workflow patch requires sourceNodeId', 'sourceNodeId')
  }
  if (isSpecShape && typeof raw.reason !== 'string') {
    pushError(errors, 'invalid_patch', 'Dynamic workflow patch requires reason', 'reason')
  }
  if (
    isSpecShape &&
    (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high')
  ) {
    pushError(errors, 'invalid_patch', 'Dynamic workflow patch risk must be low, medium, or high', 'risk')
  }
  if (isSpecShape && !assertObject(raw.budgetImpact)) {
    pushError(errors, 'invalid_patch', 'Dynamic workflow patch requires budgetImpact', 'budgetImpact')
  }
  if (!isSpecShape && (typeof raw.id !== 'string' || !raw.id.trim())) {
    pushError(errors, 'invalid_patch', 'Dynamic workflow patch requires id', 'id')
  }
  if (!Array.isArray(raw.operations)) {
    pushError(
      errors,
      'invalid_patch',
      'Dynamic workflow patch requires operations',
      'operations',
    )
  }

  const operations: WorkflowGraphPatchOperation[] = []
  if (Array.isArray(raw.operations)) {
    raw.operations.forEach((operation, index) => {
      if (!assertObject(operation)) {
        pushError(
          errors,
          'invalid_patch',
          'Dynamic workflow patch operation must be an object',
          `operations[${index}]`,
        )
        return
      }
      const normalized = canonicalOperation(operation)
      if (!normalized) {
        pushError(
          errors,
          'invalid_patch',
          'Dynamic workflow patch operation has an unsupported or incomplete shape',
          `operations[${index}]`,
        )
        return
      }
      operations.push(normalized)
    })
  }

  if (errors.length > 0) {
    return { errors }
  }

  const sourceNodeId =
    typeof raw.sourceNodeId === 'string' ? raw.sourceNodeId : undefined
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : sanitizedPatchId(`${sourceNodeId ?? 'dynamic'}-${String(raw.reason ?? 'patch')}`)
  return {
    errors: [],
    candidate: {
      schemaVersion: 1,
      id,
      ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
      ...(typeof raw.sourceRunId === 'string'
        ? { sourceRunId: raw.sourceRunId }
        : {}),
      ...(sourceNodeId ? { sourceNodeId } : {}),
      reason:
        typeof raw.reason === 'string'
          ? raw.reason
          : String(raw.metadata ?? 'legacy workflow graph patch'),
      operations,
      budgetImpact: assertObject(raw.budgetImpact)
        ? {
            addedNodes: Number(raw.budgetImpact.addedNodes ?? 0),
            estimatedAgentCalls: Number(raw.budgetImpact.estimatedAgentCalls ?? 0),
            ...(raw.budgetImpact.estimatedWallMinutes !== undefined
              ? {
                  estimatedWallMinutes: Number(
                    raw.budgetImpact.estimatedWallMinutes,
                  ),
                }
              : {}),
          }
        : {
            addedNodes: operations.filter(
              operation => operationName(operation) === 'add_node',
            ).length,
            estimatedAgentCalls: 0,
          },
      risk:
        raw.risk === 'low' || raw.risk === 'medium' || raw.risk === 'high'
          ? raw.risk
          : 'low',
      ...(assertObject(raw.metadata) ? { metadata: raw.metadata } : {}),
    },
  }
}

function validateOperationSafety(
  operation: WorkflowGraphPatchOperation,
  index: number,
  options: WorkflowGraphPatchValidationOptions,
  errors: WorkflowGraphPatchError[],
): void {
  const allowedRefs = new Set(options.allowedAssetRefs ?? [])
  const basePath = `operations[${index}]`
  findRestrictedFields(operation, basePath, errors)

  const op = 'op' in operation ? operation.op : operationName(operation)
  if (op === 'add_node' && 'node' in operation) {
    checkDeclaredAssetReference(operation.node.tool, `${basePath}.node.tool`, allowedRefs, errors)
    checkDeclaredAssetReference(operation.node.role, `${basePath}.node.role`, allowedRefs, errors)
    checkDeclaredAssetReference(
      operation.node.workflow,
      `${basePath}.node.workflow`,
      allowedRefs,
      errors,
    )
  } else if (op === 'update_node' && 'patch' in operation) {
    checkDeclaredAssetReference(
      operation.patch.tool,
      `${basePath}.patch.tool`,
      allowedRefs,
      errors,
    )
    checkDeclaredAssetReference(
      operation.patch.role,
      `${basePath}.patch.role`,
      allowedRefs,
      errors,
    )
    checkDeclaredAssetReference(
      operation.patch.workflow,
      `${basePath}.patch.workflow`,
      allowedRefs,
      errors,
    )
  }
}

function hasActiveEdge(
  definition: MatOSWorkflowDefinition,
  from: string,
  to: string,
): boolean {
  const target = definition.nodes.find(node => node.id === to)
  if (target?.dependsOn.includes(from)) {
    return true
  }
  return Boolean(
    definition.edges?.some(edge => edge.from === from && edge.to === to),
  )
}

function validateOperationReferences(
  definition: MatOSWorkflowDefinition,
  operation: WorkflowGraphPatchOperation,
  index: number,
  errors: WorkflowGraphPatchError[],
): void {
  const op = 'op' in operation ? operation.op : operationName(operation)
  if (op !== 'remove_edge' || !('from' in operation) || !('to' in operation)) {
    return
  }
  if (!hasActiveEdge(definition, operation.from, operation.to)) {
    pushError(
      errors,
      'validation_failed',
      `Dynamic workflow patch cannot remove missing edge ${operation.from} -> ${operation.to}`,
      `operations[${index}]`,
    )
  }
}

function graphPatchLimits(
  options: WorkflowGraphPatchValidationOptions,
): WorkflowGraphPatchPolicyLimits {
  return {
    ...DEFAULT_WORKFLOW_GRAPH_PATCH_LIMITS,
    ...(options.limits ?? {}),
    ...workflowGraphPatchOperatorPolicy().limits,
  }
}

function dynamicAllowedAssetRefsFromPolicy(
  definition: MatOSWorkflowDefinition,
): string[] {
  const value =
    definition.policy.dynamicAllowedAssetRefs ??
    definition.policy.allowedDynamicAssetRefs
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function validatePatchPolicyLimits(input: {
  before: MatOSWorkflowDefinition
  after: MatOSWorkflowDefinition
  candidate: WorkflowGraphPatchCandidate
  options: WorkflowGraphPatchValidationOptions
  errors: WorkflowGraphPatchError[]
}): void {
  const limits = graphPatchLimits(input.options)
  const addedNodes = input.candidate.operations.filter(
    operation => ('op' in operation ? operation.op : operationName(operation)) === 'add_node',
  ).length
  if (input.after.nodes.length > limits.maxNodes) {
    pushError(
      input.errors,
      'policy_limit',
      `Dynamic workflow patch would create ${input.after.nodes.length} nodes, above max ${limits.maxNodes}`,
      'policy.maxNodes',
    )
  }
  if (addedNodes > limits.maxAddedNodesPerPatch) {
    pushError(
      input.errors,
      'policy_limit',
      `Dynamic workflow patch adds ${addedNodes} nodes, above max ${limits.maxAddedNodesPerPatch}`,
      'budgetImpact.addedNodes',
    )
  }
  if (
    input.candidate.budgetImpact &&
    input.candidate.budgetImpact.addedNodes > limits.maxAddedNodesPerPatch
  ) {
    pushError(
      input.errors,
      'policy_limit',
      `Dynamic workflow patch declares ${input.candidate.budgetImpact.addedNodes} added nodes, above max ${limits.maxAddedNodesPerPatch}`,
      'budgetImpact.addedNodes',
    )
  }
  for (const [index, operation] of input.candidate.operations.entries()) {
    if (('op' in operation ? operation.op : operationName(operation)) === 'delete_node') {
      pushError(
        input.errors,
        'unsupported_operation',
        'Dynamic workflow patches cannot delete nodes inside an active run',
        `operations[${index}].op`,
      )
      break
    }
  }
  for (const node of input.after.nodes) {
    if (
      node.type === 'map' &&
      Array.isArray(node.items) &&
      node.items.length > limits.maxFanOut
    ) {
      pushError(
        input.errors,
        'policy_limit',
        `Map node ${node.id} has fan-out ${node.items.length}, above max ${limits.maxFanOut}`,
        `nodes.${node.id}.items`,
      )
    }
    if (
      node.type === 'loop' &&
      Number.isInteger(node.maxIterations) &&
      Number(node.maxIterations) > limits.maxLoopIterations
    ) {
      pushError(
        input.errors,
        'policy_limit',
        `Loop node ${node.id} has maxIterations ${String(node.maxIterations)}, above max ${limits.maxLoopIterations}`,
        `nodes.${node.id}.maxIterations`,
      )
    }
  }
  if (
    input.options.currentNestedWorkflowDepth !== undefined &&
    input.options.currentNestedWorkflowDepth > limits.maxNestedWorkflowDepth
  ) {
    pushError(
      input.errors,
      'policy_limit',
      `Nested workflow depth ${input.options.currentNestedWorkflowDepth} is above max ${limits.maxNestedWorkflowDepth}`,
      'policy.maxNestedWorkflowDepth',
    )
  }
}

function addDependency(node: MatOSWorkflowNode, dependency: string): void {
  if (!node.dependsOn.includes(dependency)) {
    node.dependsOn.push(dependency)
  }
}

function removeDependency(node: MatOSWorkflowNode, dependency: string): void {
  node.dependsOn = node.dependsOn.filter(item => item !== dependency)
}

function upsertEdge(
  definition: MatOSWorkflowDefinition,
  edge: MatOSWorkflowEdge,
): void {
  const edges = definition.edges ?? []
  if (
    !edges.some(
      existing =>
        existing.from === edge.from &&
        existing.to === edge.to &&
        existing.condition === edge.condition &&
        existing.route === edge.route,
    )
  ) {
    edges.push(edge)
  }
  definition.edges = edges
}

function removeEdge(
  definition: MatOSWorkflowDefinition,
  from: string,
  to: string,
): void {
  definition.edges = (definition.edges ?? []).filter(
    edge => edge.from !== from || edge.to !== to,
  )
  if (definition.edges.length === 0) {
    delete definition.edges
  }
}

export function applyWorkflowGraphPatch(
  definition: MatOSWorkflowDefinition,
  candidate: WorkflowGraphPatchCandidate,
): MatOSWorkflowDefinition {
  const next = cloneWorkflowDefinition(definition)
  const normalized = normalizeWorkflowGraphPatchCandidate(candidate).candidate ?? candidate

  for (const operation of normalized.operations) {
    const op = 'op' in operation ? operation.op : operationName(operation)
    switch (op) {
      case 'add_node':
        if (!('node' in operation)) {
          break
        }
        next.nodes.push({
          ...operation.node,
          dependsOn: [...(operation.node.dependsOn ?? [])],
        })
        break
      case 'update_node': {
        if (!('nodeId' in operation) || !('patch' in operation)) {
          break
        }
        const node = next.nodes.find(item => item.id === operation.nodeId)
        if (node) {
          Object.assign(node, operation.patch, { id: node.id })
          node.dependsOn = Array.isArray(node.dependsOn) ? node.dependsOn : []
        }
        break
      }
      case 'delete_node':
        if (!('nodeId' in operation)) {
          break
        }
        next.nodes = next.nodes.filter(node => node.id !== operation.nodeId)
        for (const node of next.nodes) {
          removeDependency(node, operation.nodeId)
        }
        next.edges = (next.edges ?? []).filter(
          edge => edge.from !== operation.nodeId && edge.to !== operation.nodeId,
        )
        if (next.edges.length === 0) {
          delete next.edges
        }
        break
      case 'connect': {
        break
      }
      case 'add_edge': {
        if (!('from' in operation) || !('to' in operation)) {
          break
        }
        const target = next.nodes.find(node => node.id === operation.to)
        if (target) {
          addDependency(target, operation.from)
        }
        upsertEdge(next, {
          from: operation.from,
          to: operation.to,
          ...('condition' in operation && operation.condition
            ? { condition: operation.condition }
            : {}),
          ...('route' in operation && operation.route
            ? { route: operation.route as MatOSWorkflowEdge['route'] }
            : {}),
        })
        break
      }
      case 'disconnect': {
        break
      }
      case 'remove_edge': {
        if (!('from' in operation) || !('to' in operation)) {
          break
        }
        const target = next.nodes.find(node => node.id === operation.to)
        if (target) {
          removeDependency(target, operation.from)
        }
        removeEdge(next, operation.from, operation.to)
        break
      }
      case 'set_outputs':
        if (!('outputs' in operation)) {
          break
        }
        next.outputs = cloneWorkflowDefinition({
          ...next,
          outputs: operation.outputs,
        }).outputs
        break
    }
  }

  return next
}

export function validateWorkflowGraphPatchCandidate(
  definition: MatOSWorkflowDefinition,
  candidate: unknown,
  options: WorkflowGraphPatchValidationOptions = {},
): WorkflowGraphPatchValidationResult {
  const normalized = normalizeWorkflowGraphPatchCandidate(candidate)
  const errors: WorkflowGraphPatchError[] = [...normalized.errors]
  const typedCandidate = normalized.candidate
  const validationOptions = {
    ...options,
    allowedAssetRefs: [
      ...dynamicAllowedAssetRefsFromPolicy(definition),
      ...(options.allowedAssetRefs ?? []),
    ],
  }

  if (!typedCandidate || errors.length > 0) {
    return { ok: false, errors }
  }

  typedCandidate.operations.forEach((operation, index) =>
    validateOperationSafety(operation, index, validationOptions, errors),
  )
  typedCandidate.operations.forEach((operation, index) =>
    validateOperationReferences(definition, operation, index, errors),
  )
  if (errors.length > 0) {
    return { ok: false, errors }
  }
  const patchedDefinition = applyWorkflowGraphPatch(definition, typedCandidate)
  validatePatchPolicyLimits({
    before: definition,
    after: patchedDefinition,
    candidate: typedCandidate,
    options: validationOptions,
    errors,
  })
  if (errors.length > 0) {
    return { ok: false, errors, patchedDefinition }
  }
  const validation = validateWorkflowDefinition(patchedDefinition, {
    knownParameterIds: validationOptions.knownParameterIds,
  })
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors.map(error => ({
        code: 'validation_failed',
        message: error.message,
        path: error.path,
      })),
      patchedDefinition,
    }
  }

  return { ok: true, errors: [], patchedDefinition }
}

/**
 * Authoritative proposal path shared by human/service and controller callers.
 * It validates and records a proposal only; approval and application remain
 * separate native workflow operations.
 */
export async function proposeWorkflowGraphPatch(input: {
  runDir: string
  runId: string
  definition: MatOSWorkflowDefinition
  operations: WorkflowGraphPatchOperation[]
  reason?: string
  risk?: WorkflowGraphPatchRisk
  sourceNodeId?: string
  decidedBy?: string
}): Promise<{
  ok: boolean
  errors: WorkflowGraphPatchError[]
  patch?: WorkflowGraphPatchLedgerView
}> {
  const addedNodes = input.operations.filter(operation => {
    const op =
      'op' in operation
        ? operation.op
        : (operation as { type?: string }).type
    return op === 'add_node'
  }).length
  const sourceNodeId = input.sourceNodeId ?? 'agent-repair'
  const reason = input.reason ?? 'agent-proposed patch'
  const risk = input.risk ?? 'low'
  const proposalToken = createHash('sha256')
    .update(JSON.stringify({ operations: input.operations, reason, risk }))
    .digest('hex')
    .slice(0, 10)
  const rawCandidate: WorkflowGraphPatchCandidate = {
    schemaVersion: 1,
    id: `proposed-${sourceNodeId}-${proposalToken}`,
    sourceRunId: input.runId,
    sourceNodeId,
    reason,
    operations: input.operations,
    risk,
    budgetImpact: { addedNodes, estimatedAgentCalls: 0 },
  }
  const normalized = normalizeWorkflowGraphPatchCandidate(rawCandidate)
  if (!normalized.candidate || normalized.errors.length > 0) {
    return { ok: false, errors: normalized.errors }
  }
  const candidate = normalized.candidate
  const validation = validateWorkflowGraphPatchCandidate(
    input.definition,
    candidate,
  )
  if (!validation.ok || !validation.patchedDefinition) {
    return { ok: false, errors: validation.errors }
  }
  candidate.risk = workflowGraphPatchEffectiveRisk(
    candidate,
    validation.patchedDefinition,
  )
  await writeWorkflowGraphPatchLedger({
    runDir: input.runDir,
    candidate,
    before: input.definition,
    after: validation.patchedDefinition,
    validation,
    decision: {
      status: 'proposed',
      decidedBy: input.decidedBy ?? 'agent',
      decidedAt: nowIso(),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  return {
    ok: true,
    errors: [],
    patch: await inspectWorkflowGraphPatchLedger(
      input.runDir,
      candidate.id ?? sourceNodeId,
    ),
  }
}

function dynamicScopeAllowed(scopeRef: string | undefined): boolean {
  if (!scopeRef) {
    return false
  }
  return (
    scopeRef === 'user:local' ||
    scopeRef === 'local' ||
    scopeRef.startsWith('project:') ||
    scopeRef === 'project'
  )
}

export async function writeWorkflowGraphPatchApplication(input: {
  runDir: string
  candidate: WorkflowGraphPatchCandidate
  before: MatOSWorkflowDefinition
  after: MatOSWorkflowDefinition
  scopeRef?: string
  allowDynamicMutation: boolean
  decidedBy?: string
  reason?: string
}): Promise<{
  patchDir: string
  candidatePath: string
  validationPath: string
  decisionPath: string
  beforePath: string
  afterPath: string
  graphSnapshotPath: string
  graphHash: string
}> {
  if (!input.allowDynamicMutation) {
    throw new Error('dynamic workflow graph mutation is disabled')
  }
  if (!dynamicScopeAllowed(input.scopeRef)) {
    throw new Error(`dynamic workflow graph mutation is not allowed for ${input.scopeRef}`)
  }

  const normalized =
    normalizeWorkflowGraphPatchCandidate(input.candidate).candidate ??
    input.candidate
  const written = await writeWorkflowGraphPatchLedger({
    runDir: input.runDir,
    candidate: normalized,
    before: input.before,
    after: input.after,
    validation: { ok: true, errors: [], patchedDefinition: input.after },
    decision: {
      status: 'applied',
      graphHash: sha256Json(input.after),
      decidedBy: input.decidedBy ?? 'policy:auto',
      decidedAt: nowIso(),
      ...(input.reason ? { reason: input.reason } : {}),
    } as WorkflowGraphPatchDecision & { graphHash: string },
    writeGraphSnapshot: true,
  })
  if (!written.afterPath || !written.graphSnapshotPath || !written.graphHash) {
    throw new Error('dynamic workflow graph patch application was not written')
  }
  return {
    patchDir: written.patchDir,
    candidatePath: written.candidatePath,
    validationPath: written.validationPath,
    decisionPath: written.decisionPath,
    beforePath: written.beforePath,
    afterPath: written.afterPath,
    graphSnapshotPath: written.graphSnapshotPath,
    graphHash: written.graphHash,
  }
}

export async function writeWorkflowGraphPatchLedger(input: {
  runDir: string
  candidate: WorkflowGraphPatchCandidate
  before: MatOSWorkflowDefinition
  after?: MatOSWorkflowDefinition
  validation: WorkflowGraphPatchValidationResult
  decision: WorkflowGraphPatchDecision & {
    graphHash?: string
    graphSnapshotPath?: string
  }
  writeGraphSnapshot?: boolean
}): Promise<{
  patchDir: string
  candidatePath: string
  validationPath: string
  decisionPath: string
  beforePath: string
  afterPath?: string
  graphSnapshotPath?: string
  graphHash?: string
}> {
  const normalized =
    normalizeWorkflowGraphPatchCandidate(input.candidate).candidate ??
    input.candidate
  const patchDir = join(
    input.runDir,
    'dynamic-patches',
    sanitizedPatchId(
      normalized.id ?? normalized.sourceNodeId ?? 'patch',
    ),
  )
  await mkdir(patchDir, { recursive: true })
  const candidatePath = join(patchDir, 'candidate.json')
  const validationPath = join(patchDir, 'validation.json')
  const decisionPath = join(patchDir, 'decision.json')
  const beforePath = join(patchDir, 'graph.before.json')
  const afterPath = input.after ? join(patchDir, 'graph.after.json') : undefined
  const graphSnapshotName =
    input.after && input.writeGraphSnapshot
      ? await nextGraphSnapshotName(input.runDir)
      : undefined
  const graphSnapshotPath = graphSnapshotName
    ? join(input.runDir, graphSnapshotName)
    : undefined
  const graphHash = input.after ? sha256Json(input.after) : input.decision.graphHash
  await writeJson(candidatePath, normalized)
  await writeJson(validationPath, {
    ok: input.validation.ok,
    errors: input.validation.errors,
  })
  await writeJson(decisionPath, {
    ...input.decision,
    graphHash,
    ...(graphSnapshotName ? { graphSnapshotPath: graphSnapshotName } : {}),
  })
  await writeJson(beforePath, input.before)
  if (afterPath && input.after) {
    await writeJson(afterPath, input.after)
  }
  if (graphSnapshotPath && input.after) {
    await writeJson(graphSnapshotPath, input.after)
  }
  return {
    patchDir,
    candidatePath,
    validationPath,
    decisionPath,
    beforePath,
    ...(afterPath ? { afterPath } : {}),
    ...(graphSnapshotPath ? { graphSnapshotPath } : {}),
    ...(graphHash ? { graphHash } : {}),
  }
}

export type WorkflowGraphPatchLedgerView = {
  patchId: string
  patchDir: string
  candidate?: WorkflowGraphPatchCandidate
  validation?: WorkflowGraphPatchValidationResult
  decision?: WorkflowGraphPatchDecision & {
    graphHash?: string
    graphSnapshotPath?: string
  }
  paths: {
    candidate?: string
    validation?: string
    decision?: string
    before?: string
    after?: string
  }
}

export type WorkflowGraphPatchLedgerPayload = WorkflowGraphPatchLedgerView & {
  before: MatOSWorkflowDefinition
  after?: MatOSWorkflowDefinition
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path)
  } catch {
    return undefined
  }
}

async function workflowGraphPatchLedgerView(
  runDir: string,
  patchId: string,
): Promise<WorkflowGraphPatchLedgerView> {
  const patchDir = join(runDir, 'dynamic-patches', sanitizedPatchId(patchId))
  const candidatePath = join(patchDir, 'candidate.json')
  const validationPath = join(patchDir, 'validation.json')
  const decisionPath = join(patchDir, 'decision.json')
  const beforePath = join(patchDir, 'graph.before.json')
  const afterPath = join(patchDir, 'graph.after.json')
  return {
    patchId: sanitizedPatchId(patchId),
    patchDir,
    candidate: await readOptionalJson<WorkflowGraphPatchCandidate>(candidatePath),
    validation: await readOptionalJson<WorkflowGraphPatchValidationResult>(
      validationPath,
    ),
    decision: await readOptionalJson<
      WorkflowGraphPatchDecision & {
        graphHash?: string
        graphSnapshotPath?: string
      }
    >(decisionPath),
    paths: {
      candidate: candidatePath,
      validation: validationPath,
      decision: decisionPath,
      before: beforePath,
      after: afterPath,
    },
  }
}

export async function readWorkflowGraphPatchLedgerPayload(
  runDir: string,
  patchId: string,
): Promise<WorkflowGraphPatchLedgerPayload> {
  const view = await inspectWorkflowGraphPatchLedger(runDir, patchId)
  if (!view.candidate) {
    throw new Error(`Workflow graph patch candidate missing: ${view.patchId}`)
  }
  if (!view.validation) {
    throw new Error(`Workflow graph patch validation missing: ${view.patchId}`)
  }
  const before = await readOptionalJson<MatOSWorkflowDefinition>(
    view.paths.before ?? join(view.patchDir, 'graph.before.json'),
  )
  if (!before) {
    throw new Error(`Workflow graph patch before snapshot missing: ${view.patchId}`)
  }
  const after = await readOptionalJson<MatOSWorkflowDefinition>(
    view.paths.after ?? join(view.patchDir, 'graph.after.json'),
  )
  return {
    ...view,
    before,
    ...(after ? { after } : {}),
  }
}

export async function writeWorkflowGraphPatchDecision(input: {
  runDir: string
  patchId: string
  status: Exclude<WorkflowGraphPatchDecisionStatus, 'applied'>
  reason?: string
  decidedBy?: string
}): Promise<WorkflowGraphPatchLedgerView> {
  const ledger = await readWorkflowGraphPatchLedgerPayload(
    input.runDir,
    input.patchId,
  )
  if (ledger.decision?.status === 'applied') {
    throw new Error(`Workflow graph patch is already applied: ${ledger.patchId}`)
  }
  await writeWorkflowGraphPatchLedger({
    runDir: input.runDir,
    candidate: ledger.candidate!,
    before: ledger.before,
    after: ledger.after,
    validation: ledger.validation!,
    decision: {
      status: input.status,
      decidedBy: input.decidedBy,
      decidedAt: nowIso(),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  })
  return inspectWorkflowGraphPatchLedger(input.runDir, input.patchId)
}

export async function listWorkflowGraphPatchLedgers(
  runDir: string,
): Promise<WorkflowGraphPatchLedgerView[]> {
  let entries: string[]
  try {
    entries = await readdir(join(runDir, 'dynamic-patches'))
  } catch {
    return []
  }
  const patches = await Promise.all(
    entries
      .filter(entry => entry.trim().length > 0)
      .sort()
      .map(entry => workflowGraphPatchLedgerView(runDir, entry)),
  )
  return patches
}

export async function inspectWorkflowGraphPatchLedger(
  runDir: string,
  patchId: string,
): Promise<WorkflowGraphPatchLedgerView> {
  const view = await workflowGraphPatchLedgerView(runDir, patchId)
  if (!view.candidate && !view.validation && !view.decision) {
    throw new Error(`Workflow graph patch not found: ${sanitizedPatchId(patchId)}`)
  }
  return view
}

/**
 * Hash of a graph definition in the exact encoding patch ledgers use for
 * `decision.graphHash` (sha256 over JSON.stringify). Snapshots are persisted
 * and re-read through JSON, which preserves key order, so hashing a re-read
 * snapshot reproduces the hash recorded when it was written.
 */
export function workflowGraphPatchGraphHash(
  definition: MatOSWorkflowDefinition,
): string {
  return sha256Json(definition)
}

function ledgerDecidedAtMs(view: WorkflowGraphPatchLedgerView): number {
  const decidedAt = view.decision?.decidedAt
  const parsed = decidedAt ? Date.parse(decidedAt) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Latest ledger entry a given dynamic node produced with the requested
 * decision status. This is the crash-recovery source of truth: a dynamic
 * node found `running` after a restart is disambiguated by what its ledger
 * says actually happened (patch applied / proposed / nothing persisted).
 */
export async function latestWorkflowGraphPatchForSourceNode(
  runDir: string,
  sourceNodeId: string,
  status: WorkflowGraphPatchDecisionStatus,
): Promise<WorkflowGraphPatchLedgerView | undefined> {
  const ledgers = await listWorkflowGraphPatchLedgers(runDir)
  return ledgers
    .filter(
      view =>
        view.candidate?.sourceNodeId === sourceNodeId &&
        view.decision?.status === status,
    )
    .sort((left, right) => ledgerDecidedAtMs(left) - ledgerDecidedAtMs(right))
    .at(-1)
}
