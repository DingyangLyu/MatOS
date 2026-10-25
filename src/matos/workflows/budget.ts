import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type {
  MatOSWorkflowBudgetLedger,
  MatOSWorkflowBudgetPolicy,
  MatOSWorkflowBudgetViolation,
  MatOSWorkflowChildBudgetSummary,
  MatOSWorkflowBudgetTotals,
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
  MatOSWorkflowNodeBudgetSummary,
  MatOSWorkflowNodeStatus,
} from './types.js'
import { readJson } from './jsonIo.js'
import {
  readWorkflowRun,
  type MatOSWorkflowNodeAttemptSnapshot,
} from './workflowStore.js'

const ZERO_TOTALS: MatOSWorkflowBudgetTotals = {
  nodeAttempts: 0,
  agentCalls: 0,
  toolCalls: 0,
  backendJobs: 0,
  wallTimeMs: 0,
  elapsedWallTimeMs: 0,
  agentTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
}

type WorkflowAttemptWithNode = {
  nodeId: string
  attempt: MatOSWorkflowNodeAttemptSnapshot
}

type ChildWorkflowRef = {
  runId: string
  nodeId?: string
  status?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function budgetPath(runDir: string): string {
  return join(runDir, 'budget.json')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmpPath, path)
}

function cloneTotals(): MatOSWorkflowBudgetTotals {
  return { ...ZERO_TOTALS }
}

function addTotals(
  target: MatOSWorkflowBudgetTotals,
  source: MatOSWorkflowBudgetTotals,
): void {
  target.nodeAttempts += source.nodeAttempts
  target.agentCalls += source.agentCalls
  target.toolCalls += source.toolCalls
  target.backendJobs += source.backendJobs
  target.wallTimeMs += source.wallTimeMs
  // elapsedWallTimeMs is a per-run real-clock measure; summing it across child
  // runs would double count concurrent/nested elapsed time, so it is set
  // directly on the owning run's totals instead of accumulated here.
  target.agentTurns += source.agentTurns ?? 0
  target.inputTokens += source.inputTokens ?? 0
  target.outputTokens += source.outputTokens ?? 0
  target.totalTokens += source.totalTokens ?? 0
  target.totalCostUsd += source.totalCostUsd ?? 0
}

function sumTotals(
  left: MatOSWorkflowBudgetTotals,
  right: MatOSWorkflowBudgetTotals,
): MatOSWorkflowBudgetTotals {
  const result = cloneTotals()
  addTotals(result, left)
  addTotals(result, right)
  return result
}

function nodeById(
  definition: MatOSWorkflowDefinition | undefined,
): Map<string, MatOSWorkflowNode> {
  return new Map((definition?.nodes ?? []).map(node => [node.id, node]))
}

async function listAttemptManifests(
  runDir: string,
): Promise<WorkflowAttemptWithNode[]> {
  let nodeIds: string[]
  try {
    nodeIds = await readdir(join(runDir, 'node-runs'))
  } catch {
    return []
  }

  const attempts: WorkflowAttemptWithNode[] = []
  for (const nodeId of nodeIds.sort()) {
    let attemptIds: string[]
    try {
      attemptIds = await readdir(join(runDir, 'node-runs', nodeId, 'attempts'))
    } catch {
      continue
    }

    for (const attemptId of attemptIds.sort((left, right) => Number(left) - Number(right))) {
      try {
        attempts.push({
          nodeId,
          attempt: await readJson<MatOSWorkflowNodeAttemptSnapshot>(
            join(runDir, 'node-runs', nodeId, 'attempts', attemptId, 'attempt.json'),
          ),
        })
      } catch {
        continue
      }
    }
  }
  return attempts
}

function wallTimeMs(attempt: MatOSWorkflowNodeAttemptSnapshot): number {
  if (!attempt.startedAt || !attempt.finishedAt) {
    return 0
  }
  const startedAt = Date.parse(attempt.startedAt)
  const finishedAt = Date.parse(attempt.finishedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    return 0
  }
  return Math.max(0, finishedAt - startedAt)
}

function runElapsedWallTimeMs(createdAt: string | undefined, endedAt?: string): number {
  if (!createdAt) {
    return 0
  }
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) {
    return 0
  }
  const end = endedAt === undefined ? Date.now() : Date.parse(endedAt)
  return Number.isFinite(end) ? Math.max(0, end - created) : 0
}

function isAgentAttempt(node: MatOSWorkflowNode | undefined): boolean {
  return (
    node?.type === 'agent' ||
    node?.runtimeType === 'agent' ||
    node?.targetType === 'agent'
  )
}

function isBackendAttempt(node: MatOSWorkflowNode | undefined): boolean {
  return (
    node?.type === 'backend' ||
    node?.runtimeType === 'backend' ||
    node?.targetType === 'backend' ||
    node?.type === 'compute' ||
    node?.targetType === 'compute'
  )
}

function isToolAttempt(node: MatOSWorkflowNode | undefined): boolean {
  const types = [node?.type, node?.runtimeType, node?.targetType]
  return types.some(type =>
    [
      'exec',
      'guard',
      'backend',
      'dynamic',
      'validate',
      'compute',
      'map',
      'loop',
    ].includes(String(type)),
  )
}

function emptyNodeSummary(
  nodeId: string,
  node: MatOSWorkflowNode | undefined,
): MatOSWorkflowNodeBudgetSummary {
  return {
    nodeId,
    ...cloneTotals(),
    ...(node?.type ? { type: node.type } : {}),
    ...(node?.runtimeType ? { runtimeType: node.runtimeType } : {}),
    ...(node?.targetType ? { targetType: node.targetType } : {}),
  }
}

function usageNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function addAttemptToTotals(
  totals: MatOSWorkflowBudgetTotals,
  node: MatOSWorkflowNode | undefined,
  attempt: MatOSWorkflowNodeAttemptSnapshot,
): void {
  totals.nodeAttempts += 1
  totals.wallTimeMs += wallTimeMs(attempt)
  if (isAgentAttempt(node)) {
    totals.agentCalls += 1
  }
  if (isToolAttempt(node)) {
    totals.toolCalls += 1
  }
  if (isBackendAttempt(node)) {
    totals.backendJobs += 1
  }
  const usage = attempt.usage
  if (usage) {
    const inputTokens =
      usageNumber(usage.inputTokens) +
      usageNumber(usage.cacheCreationInputTokens) +
      usageNumber(usage.cacheReadInputTokens)
    const outputTokens = usageNumber(usage.outputTokens)
    totals.agentTurns += usageNumber(usage.agentTurns)
    totals.inputTokens += inputTokens
    totals.outputTokens += outputTokens
    totals.totalTokens += usageNumber(usage.totalTokens) || inputTokens + outputTokens
    totals.totalCostUsd += usageNumber(usage.totalCostUsd)
  }
}

function validStatus(
  status: MatOSWorkflowNodeAttemptSnapshot['status'],
): MatOSWorkflowNodeStatus | undefined {
  return status
}

async function workflowDefinitionFromRun(
  runDir: string,
  graphSnapshotPath: string,
): Promise<MatOSWorkflowDefinition | undefined> {
  try {
    return await readJson<MatOSWorkflowDefinition>(join(runDir, graphSnapshotPath))
  } catch {
    return undefined
  }
}

function nodeIdHintForPath(runDir: string, filePath: string): string | undefined {
  const parts = relative(runDir, filePath).split('/')
  if (
    (parts[0] === 'iterations' || parts[0] === 'rounds') &&
    typeof parts[1] === 'string' &&
    parts[1]
  ) {
    return parts[1]
  }
  return undefined
}

function rememberChildRef(
  refs: Map<string, ChildWorkflowRef>,
  ref: ChildWorkflowRef,
): void {
  const current = refs.get(ref.runId)
  refs.set(ref.runId, {
    runId: ref.runId,
    nodeId: current?.nodeId ?? ref.nodeId,
    status: current?.status ?? ref.status,
  })
}

function collectChildRefsFromValue(
  value: unknown,
  refs: Map<string, ChildWorkflowRef>,
  nodeIdHint?: string,
): void {
  if (!value || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectChildRefsFromValue(item, refs, nodeIdHint)
    }
    return
  }

  const record = value as Record<string, unknown>
  if (typeof record.childRunId === 'string' && record.childRunId.trim()) {
    rememberChildRef(refs, {
      runId: record.childRunId,
      nodeId: typeof record.nodeId === 'string' ? record.nodeId : nodeIdHint,
      status: typeof record.status === 'string' ? record.status : undefined,
    })
  }
  for (const item of Object.values(record)) {
    collectChildRefsFromValue(item, refs, nodeIdHint)
  }
}

async function collectJsonChildRefs(input: {
  runDir: string
  dir: string
  refs: Map<string, ChildWorkflowRef>
  depth?: number
}): Promise<void> {
  if ((input.depth ?? 0) > 8) {
    return
  }
  let entries: string[]
  try {
    entries = await readdir(input.dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const path = join(input.dir, entry)
    const info = await lstat(path).catch(() => undefined)
    if (!info) {
      continue
    }
    if (info.isDirectory()) {
      await collectJsonChildRefs({
        runDir: input.runDir,
        dir: path,
        refs: input.refs,
        depth: (input.depth ?? 0) + 1,
      })
      continue
    }
    if (!info.isFile() || !entry.endsWith('.json')) {
      continue
    }
    try {
      collectChildRefsFromValue(
        await readJson<unknown>(path),
        input.refs,
        nodeIdHintForPath(input.runDir, path),
      )
    } catch {
      continue
    }
  }
}

async function listChildWorkflowRefs(
  runDir: string,
): Promise<ChildWorkflowRef[]> {
  const refs = new Map<string, ChildWorkflowRef>()
  for (const childRefDir of ['child-runs', 'iterations', 'rounds']) {
    await collectJsonChildRefs({
      runDir,
      dir: join(runDir, childRefDir),
      refs,
    })
  }
  return [...refs.values()].sort((left, right) => left.runId.localeCompare(right.runId))
}

export async function readWorkflowBudgetLedger(
  runDir: string,
): Promise<MatOSWorkflowBudgetLedger> {
  return readJson<MatOSWorkflowBudgetLedger>(budgetPath(runDir))
}

function budgetLimitValue(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

const BUDGET_LIMIT_KEYS = [
  'maxNodeAttempts',
  'maxAgentCalls',
  'maxToolCalls',
  'maxBackendJobs',
  'maxWallTimeMs',
  'maxElapsedWallTimeMs',
  'maxAgentTurns',
  'maxTotalTokens',
  'maxTotalCostUsd',
] as const

type BudgetLimitKey = (typeof BUDGET_LIMIT_KEYS)[number]

const LIMIT_TO_TOTAL: Record<BudgetLimitKey, keyof MatOSWorkflowBudgetTotals> = {
  maxNodeAttempts: 'nodeAttempts',
  maxAgentCalls: 'agentCalls',
  maxToolCalls: 'toolCalls',
  maxBackendJobs: 'backendJobs',
  maxWallTimeMs: 'wallTimeMs',
  maxElapsedWallTimeMs: 'elapsedWallTimeMs',
  maxAgentTurns: 'agentTurns',
  maxTotalTokens: 'totalTokens',
  maxTotalCostUsd: 'totalCostUsd',
}

function limitsFromRecord(
  record: Record<string, unknown>,
): Partial<Record<BudgetLimitKey, number>> {
  const limits: Partial<Record<BudgetLimitKey, number>> = {}
  for (const key of BUDGET_LIMIT_KEYS) {
    const value = budgetLimitValue(record[key])
    if (value !== undefined) {
      limits[key] = value
    }
  }
  return limits
}

export function resolveWorkflowBudgetPolicy(
  definition: MatOSWorkflowDefinition | undefined,
): MatOSWorkflowBudgetPolicy | undefined {
  const raw = definition?.policy?.budget
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const limits = limitsFromRecord(record)
  if (Object.keys(limits).length === 0) {
    return undefined
  }
  return {
    ...limits,
    onExceeded: record.onExceeded === 'pause' ? 'pause' : 'fail',
  }
}

export function resolveWorkflowNodeBudgetPolicy(
  node: MatOSWorkflowNode | undefined,
): Partial<Record<BudgetLimitKey, number>> | undefined {
  const raw = node?.budget
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const limits = limitsFromRecord(raw as Record<string, unknown>)
  return Object.keys(limits).length > 0 ? limits : undefined
}

/**
 * Projects the durable workflow/node ledger into the remaining-budget shape
 * consumed by online inference routing. Only configured limits are exposed;
 * values are exact limit-minus-observed quantities and may be zero/negative.
 */
export function workflowRemainingBudget(input: {
  definition: MatOSWorkflowDefinition
  ledger: MatOSWorkflowBudgetLedger
  nodeId?: string
}): Record<string, number> | undefined {
  const remaining: Record<string, number> = {}
  const workflowPolicy = resolveWorkflowBudgetPolicy(input.definition)
  const node = input.nodeId
    ? input.definition.nodes.find(item => item.id === input.nodeId)
    : undefined
  const nodePolicy = resolveWorkflowNodeBudgetPolicy(node)
  const nodeTotals = input.nodeId ? input.ledger.byNode[input.nodeId] : undefined
  for (const limit of BUDGET_LIMIT_KEYS) {
    const candidates: number[] = []
    const workflowLimit = workflowPolicy?.[limit]
    if (workflowLimit !== undefined) {
      candidates.push(workflowLimit - input.ledger.totals[LIMIT_TO_TOTAL[limit]])
    }
    const nodeLimit = nodePolicy?.[limit]
    if (nodeLimit !== undefined) {
      candidates.push(nodeLimit - (nodeTotals?.[LIMIT_TO_TOTAL[limit]] ?? 0))
    }
    if (candidates.length > 0) remaining[limit] = Math.min(...candidates)
  }
  return Object.keys(remaining).length > 0 ? remaining : undefined
}

export function evaluateWorkflowBudget(
  totals: MatOSWorkflowBudgetTotals,
  policy: MatOSWorkflowBudgetPolicy,
): MatOSWorkflowBudgetViolation[] {
  const violations: MatOSWorkflowBudgetViolation[] = []
  for (const limit of BUDGET_LIMIT_KEYS) {
    const max = policy[limit]
    if (max === undefined) {
      continue
    }
    const observed = totals[LIMIT_TO_TOTAL[limit]]
    if (observed >= max) {
      violations.push({ limit, max, observed })
    }
  }
  return violations
}

/**
 * Node-level budget gate: checks every node that declares `budget` limits
 * against its accumulated per-node summary. Violations carry the node id and
 * stop scheduling with the workflow-level `onExceeded` policy.
 */
export function evaluateWorkflowNodeBudgets(
  byNode: Record<string, MatOSWorkflowNodeBudgetSummary>,
  definition: MatOSWorkflowDefinition | undefined,
): MatOSWorkflowBudgetViolation[] {
  const violations: MatOSWorkflowBudgetViolation[] = []
  for (const node of definition?.nodes ?? []) {
    const limits = resolveWorkflowNodeBudgetPolicy(node)
    const summary = byNode[node.id]
    if (!limits || !summary) {
      continue
    }
    for (const limit of BUDGET_LIMIT_KEYS) {
      const max = limits[limit]
      if (max === undefined) {
        continue
      }
      const observed = summary[LIMIT_TO_TOTAL[limit]] ?? 0
      if (observed >= max) {
        violations.push({ limit, max, observed, nodeId: node.id })
      }
    }
  }
  return violations
}

export type WorkflowBudgetEnforcement = {
  ledger: MatOSWorkflowBudgetLedger
  policy: MatOSWorkflowBudgetPolicy
  violations: MatOSWorkflowBudgetViolation[]
  onExceeded: 'fail' | 'pause'
}

/**
 * Scheduler-side budget gate. Returns undefined when the workflow declares no
 * budget policy (zero overhead) or when the current durable ledger stays
 * within every declared limit. Otherwise returns the refreshed ledger plus
 * the violated limits so the runtime can stop scheduling new node attempts.
 */
export async function enforceWorkflowBudget(input: {
  runDir: string
  definition: MatOSWorkflowDefinition
}): Promise<WorkflowBudgetEnforcement | undefined> {
  const policy = resolveWorkflowBudgetPolicy(input.definition)
  const hasNodeBudgets = (input.definition.nodes ?? []).some(
    node => resolveWorkflowNodeBudgetPolicy(node) !== undefined,
  )
  if (!policy && !hasNodeBudgets) {
    return undefined
  }
  const ledger = await refreshWorkflowBudgetLedger(input.runDir, input.definition)
  const violations = [
    ...(policy ? evaluateWorkflowBudget(ledger.totals, policy) : []),
    ...evaluateWorkflowNodeBudgets(ledger.byNode, input.definition),
  ]
  if (violations.length === 0) {
    return undefined
  }
  return {
    ledger,
    policy: policy ?? { onExceeded: 'fail' },
    violations,
    onExceeded: policy?.onExceeded === 'pause' ? 'pause' : 'fail',
  }
}

export async function refreshWorkflowBudgetLedger(
  runDir: string,
  definition?: MatOSWorkflowDefinition,
): Promise<MatOSWorkflowBudgetLedger> {
  return refreshWorkflowBudgetLedgerInternal(runDir, definition, new Set())
}

async function refreshWorkflowBudgetLedgerInternal(
  runDir: string,
  definition: MatOSWorkflowDefinition | undefined,
  visitedRunDirs: Set<string>,
): Promise<MatOSWorkflowBudgetLedger> {
  const normalizedRunDir = resolve(runDir)
  visitedRunDirs.add(normalizedRunDir)
  const run = await readWorkflowRun(runDir)
  const effectiveDefinition =
    definition ?? (await workflowDefinitionFromRun(runDir, run.graphSnapshotPath))
  const nodes = nodeById(effectiveDefinition)
  const ownTotals = cloneTotals()
  const byNode: Record<string, MatOSWorkflowNodeBudgetSummary> = {}

  for (const { nodeId, attempt } of await listAttemptManifests(runDir)) {
    const node = nodes.get(nodeId)
    byNode[nodeId] ??= emptyNodeSummary(nodeId, node)
    addAttemptToTotals(ownTotals, node, attempt)
    addAttemptToTotals(byNode[nodeId], node, attempt)
    byNode[nodeId].lastStatus = validStatus(attempt.status)
  }

  const childWorkflowTotals = cloneTotals()
  const childWorkflowRuns: MatOSWorkflowChildBudgetSummary[] = []
  for (const child of await listChildWorkflowRefs(runDir)) {
    const childRunDir = join(dirname(runDir), child.runId)
    const normalizedChildRunDir = resolve(childRunDir)
    if (visitedRunDirs.has(normalizedChildRunDir)) {
      childWorkflowRuns.push({
        ...child,
        runDir: childRunDir,
        totals: cloneTotals(),
        error: 'cycle detected while aggregating workflow budget',
      })
      continue
    }
    try {
      const childLedger = await refreshWorkflowBudgetLedgerInternal(
        childRunDir,
        undefined,
        visitedRunDirs,
      )
      addTotals(childWorkflowTotals, childLedger.totals)
      childWorkflowRuns.push({
        ...child,
        runDir: childRunDir,
        totals: childLedger.totals,
      })
    } catch (error) {
      childWorkflowRuns.push({
        ...child,
        runDir: childRunDir,
        totals: cloneTotals(),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Inspecting a finished run must not keep charging elapsed time. Terminal
  // snapshots carry their final persisted timestamp; active/waiting runs use now.
  const endedAt = ['completed', 'failed', 'cancelled'].includes(run.status)
    ? run.updatedAt ?? run.createdAt
    : undefined
  const elapsedWallTimeMs = runElapsedWallTimeMs(run.createdAt, endedAt)
  ownTotals.elapsedWallTimeMs = elapsedWallTimeMs
  const totals = sumTotals(ownTotals, childWorkflowTotals)
  totals.elapsedWallTimeMs = elapsedWallTimeMs
  const policy = resolveWorkflowBudgetPolicy(effectiveDefinition)
  const nodeViolations = evaluateWorkflowNodeBudgets(byNode, effectiveDefinition)
  const violations = [
    ...(policy ? evaluateWorkflowBudget(totals, policy) : []),
    ...nodeViolations,
  ]
  const ledger: MatOSWorkflowBudgetLedger = {
    schemaVersion: 1,
    runId: run.runId,
    workflowRef: run.workflowRef,
    generatedAt: nowIso(),
    source: 'node-attempts',
    totals,
    ownTotals,
    childWorkflowTotals,
    childWorkflowRuns,
    byNode,
    ...(policy ? { policy } : {}),
    ...(policy || nodeViolations.length > 0 ? { violations } : {}),
  }
  await writeJson(budgetPath(runDir), ledger)
  return ledger
}
