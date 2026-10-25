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

import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { getMatOSAssetsDir } from '../project.js'
import { toMatOSAssetKey } from '../assets/refs.js'
import { traceContextFromEnv } from '../sessions/traceContext.js'
import { notifyWorkflowRunPersisted } from './runObservers.js'
import {
  normalizeWorkflowDefinitionInput,
  parseWorkflowDefinition,
} from './schema.js'
import { readJson, writeJson } from './jsonIo.js'
import { withKeyedMutex } from './asyncMutex.js'
import { workflowIoDigest } from './workflowIo.js'
import { readWorkflowEventTail } from './workflowEventTail.js'
import {
  MATOS_WORKFLOW_RUN_SCHEMA_VERSION,
  writeWorkflowRuntimeReceipt,
} from './runtimeReceipt.js'
import type {
  MatOSWorkflowAttemptUsage,
  MatOSWorkflowDefinition,
  MatOSWorkflowDraftProvenanceEntry,
  MatOSWorkflowDraftSnapshot,
  MatOSWorkflowEdge,
  MatOSWorkflowEvent,
  MatOSWorkflowEventInput,
  MatOSWorkflowGuardCheck,
  MatOSWorkflowNode,
  MatOSWorkflowNodeStatus,
  MatOSWorkflowParameter,
  MatOSWorkflowRunProvenance,
  MatOSWorkflowRunSnapshot,
  MatOSWorkflowTransitionEdge,
  WorkflowAttemptSideEffectSummary,
} from './types.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import {
  extractWorkflowTemplateExpressions,
  parseWorkflowReferenceExpression,
} from './workflowReferences.js'

export type CreateWorkflowRunInput = {
  workflowsDir: string
  workflowRunsDir?: string
  workflowRef: string
  parameters?: Record<string, unknown>
  graphSnapshot: unknown
  projectCwd?: string
  workspaceDir?: string
  childDepth?: number
  provenance?: MatOSWorkflowRunProvenance
}

export type MatOSWorkflowRunHandle = {
  runId: string
  dir: string
}

export type WriteWorkflowNodeAttemptInput = {
  runDir: string
  nodeId: string
  attempt: number
  status?: MatOSWorkflowNodeStatus
  startedAt?: string
  finishedAt?: string
  idempotencyKey?: string
  input?: unknown
  output?: unknown
  error?: unknown
  contractValidation?: {
    ok: boolean
    errors?: string[]
  }
  sideEffect?: WorkflowAttemptSideEffectSummary
  stdout?: string
  stderr?: string
  usage?: MatOSWorkflowAttemptUsage
}

export type MatOSWorkflowNodeAttemptSnapshot = {
  nodeId: string
  attempt: number
  status: MatOSWorkflowNodeStatus
  startedAt: string
  finishedAt?: string
  idempotencyKey?: string
  inputPath?: string
  outputPath?: string
  errorPath?: string
  contractValidation?: {
    ok: boolean
    errors?: string[]
  }
  sideEffect?: WorkflowAttemptSideEffectSummary
  stdoutPath?: string
  stderrPath?: string
  usage?: MatOSWorkflowAttemptUsage
}

export type CreateWorkflowDraftInput = {
  workflowsDir: string
  draftId?: string
  name?: string
  version?: string
  description?: string
  definition?: MatOSWorkflowDefinition
  sourceRunId?: string
  sourceWorkflowRef?: string
}

export type MatOSWorkflowDraftHandle = {
  draftId: string
  dir: string
  workflowPath: string
  provenancePath: string
  validationPath: string
}

export type MatOSWorkflowDraftListItem = MatOSWorkflowDraftSnapshot & {
  draftDir: string
}

export type ImportWorkflowComponentInput = {
  draftDir: string
  componentRef: string
  definition: MatOSWorkflowDefinition
}

export type AddWorkflowDraftNodeInput = {
  draftDir: string
  node: MatOSWorkflowNode
}

export type UpdateWorkflowDraftNodeInput = {
  draftDir: string
  nodeId: string
  patch: Partial<MatOSWorkflowNode>
}

export type DeleteWorkflowDraftNodeInput = {
  draftDir: string
  nodeId: string
}

export type WorkflowDraftEdgeInput = {
  draftDir: string
  from: string
  to: string
}

export type ConnectWorkflowDraftTransitionInput = {
  draftDir: string
  transition: MatOSWorkflowTransitionEdge
}

export type DisconnectWorkflowDraftTransitionInput = {
  draftDir: string
  id?: string
  from?: string
  to?: string
}

export type SetWorkflowDraftStateMachineInput = {
  draftDir: string
  disable?: boolean
  initialNodeId?: string
  maxTransitions?: number
  maxFrames?: number
}

export type SetWorkflowDraftOutputsInput = {
  draftDir: string
  outputs: MatOSWorkflowDefinition['outputs']
}

export type SetWorkflowDraftParametersInput = {
  draftDir: string
  parameters: MatOSWorkflowDefinition['parameters']
  replace?: boolean
  remove?: string[]
}

export type ReplaceWorkflowDraftDefinitionInput = {
  draftDir: string
  definition: MatOSWorkflowDefinition
}

export type PublishWorkflowDraftInput = {
  cwd: string
  draftDir: string
  id: string
  name?: string
  version?: string
  description?: string
  expectedDefinition?: string
}

export type PublishWorkflowDraftResult = {
  assetKey: string
  assetDir: string
  manifestPath: string
  workflowPath: string
  definitionDigest: string
}

export type ForkWorkflowRunToDraftInput = {
  workflowsDir: string
  runDir: string
  draftId?: string
  name?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function runPath(runDir: string, file: string): string {
  return join(runDir, file)
}

function draftPath(draftDir: string, file: string): string {
  return join(draftDir, file)
}

export function resolveWorkflowDraftDir(
  workflowsDir: string,
  draftId: string | undefined,
): string {
  const id = (draftId ?? '').trim()
  if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    throw new Error('Workflow draft id must be a simple id')
  }
  const draftsDir = resolve(workflowsDir, 'drafts')
  const draftDir = resolve(draftsDir, id)
  const relativePath = relative(draftsDir, draftDir)
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\')
  ) {
    throw new Error('Workflow draft id must be a simple id')
  }
  return draftDir
}

function sanitizeId(value: string | undefined, fallbackPrefix: string): string {
  const sanitized = (value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || `${fallbackPrefix}_${randomUUID()}`
}

function sanitizeAssetId(
  type: string,
  value: string | undefined,
  fallbackPrefix: string,
): string {
  const raw = (value ?? '').trim()
  const unqualified = raw.startsWith(`${type}:`) ? raw.slice(type.length + 1) : raw
  return sanitizeId(unqualified, fallbackPrefix)
}

export function workflowPublicationAssetId(id: string): string {
  return sanitizeAssetId('workflow', id, 'workflow')
}

function workflowArtifactRoot(input: {
  workflowRef: string
  workspaceDir?: string
  runDir: string
  runId: string
}): string {
  if (!input.workspaceDir) {
    return runPath(input.runDir, 'artifacts-root')
  }
  const withoutType = input.workflowRef.startsWith('workflow:')
    ? input.workflowRef.slice('workflow:'.length)
    : input.workflowRef
  const workflowId = sanitizeId(withoutType.replace(/@.*$/, ''), 'workflow')
  return join(input.workspaceDir, 'matos-workflows', workflowId, input.runId)
}

function defaultDraftDefinition(
  input: CreateWorkflowDraftInput,
): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: input.name ?? input.draftId ?? 'MatOS Workflow Draft',
    version: input.version,
    description: input.description,
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    nodes: [],
    outputs: {},
  }
}

async function writeWorkflowDraftDefinition(
  draftDir: string,
  definition: MatOSWorkflowDefinition,
): Promise<void> {
  await writeJson(draftPath(draftDir, 'workflow.json'), definition)
  await writeJson(
    draftPath(draftDir, 'validation.json'),
    validateWorkflowDefinition(definition),
  )
}

async function appendWorkflowDraftProvenance(
  draftDir: string,
  type: string,
  data: Record<string, unknown> = {},
): Promise<MatOSWorkflowDraftProvenanceEntry> {
  const entries = await readWorkflowDraftProvenance(draftDir).catch(() => [])
  const entry: MatOSWorkflowDraftProvenanceEntry = {
    id: randomUUID(),
    timestamp: nowIso(),
    type,
    data,
  }
  await writeJson(draftPath(draftDir, 'provenance.json'), [...entries, entry])
  return entry
}

async function updateWorkflowDraft(
  draftDir: string,
  patch: Partial<MatOSWorkflowDraftSnapshot>,
): Promise<MatOSWorkflowDraftSnapshot> {
  const current = await readWorkflowDraft(draftDir)
  const next: MatOSWorkflowDraftSnapshot = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  }
  await writeJson(draftPath(draftDir, 'draft.json'), next)
  return next
}

function remapComponentNodes(
  currentNodes: MatOSWorkflowNode[],
  componentNodes: MatOSWorkflowNode[],
): { nodes: MatOSWorkflowNode[]; idMap: Record<string, string> } {
  const used = new Set(currentNodes.map(node => node.id))
  const idMap: Record<string, string> = {}

  for (const node of componentNodes) {
    let nextId = node.id
    let suffix = 2
    while (used.has(nextId)) {
      nextId = `${node.id}_${suffix}`
      suffix += 1
    }
    used.add(nextId)
    idMap[node.id] = nextId
  }

  const originalIds = new Set(componentNodes.map(node => node.id))
  return {
    idMap,
    nodes: componentNodes.map(node => ({
      ...node,
      id: idMap[node.id] ?? node.id,
      dependsOn: node.dependsOn.map(dependency =>
        originalIds.has(dependency) ? (idMap[dependency] ?? dependency) : dependency,
      ),
    })),
  }
}

function normalizeDraftNode(node: MatOSWorkflowNode): MatOSWorkflowNode {
  const config =
    node.config && typeof node.config === 'object' && !Array.isArray(node.config)
      ? (node.config as Record<string, unknown>)
      : {}
  const { config: _config, ...nativeNode } = node
  const normalized: MatOSWorkflowNode = {
    ...config,
    ...nativeNode,
    dependsOn: Array.isArray(node.dependsOn)
      ? node.dependsOn.filter(
          (dependency): dependency is string => typeof dependency === 'string',
        )
      : [],
  }
  return normalizeGuardCheckShorthand(normalized)
}

function normalizeGuardCheckShorthand(node: MatOSWorkflowNode): MatOSWorkflowNode {
  if (node.type !== 'guard' || Array.isArray(node.checks)) {
    return node
  }
  const guardType =
    typeof node.guardType === 'string' ? node.guardType : undefined
  if (!guardType) {
    return node
  }

  const check: Partial<MatOSWorkflowGuardCheck> = {
    type: guardType as MatOSWorkflowGuardCheck['type'],
  }
  if (typeof node.path === 'string') {
    check.path = node.path
  }
  if (typeof node.pattern === 'string') {
    check.pattern = node.pattern
  }
  if (typeof node.value !== 'undefined') {
    check.value = node.value
  }
  if (typeof node.min === 'number') {
    check.min = node.min
  }
  if (typeof node.max === 'number') {
    check.max = node.max
  }
  if (typeof node.schema !== 'undefined') {
    check.schema = node.schema
  }

  return {
    ...node,
    checks: [check as MatOSWorkflowGuardCheck],
  }
}

function assertDraftNodeId(value: string | undefined): string {
  const id = (value ?? '').trim()
  if (!id) {
    throw new Error('Workflow node id is required')
  }
  return id
}

function assertNodeExists(
  definition: MatOSWorkflowDefinition,
  nodeId: string,
): MatOSWorkflowNode {
  const node = definition.nodes.find(item => item.id === nodeId)
  if (!node) {
    throw new Error(`Workflow node not found: ${nodeId}`)
  }
  return node
}

// Cross-process + in-process exclusion for draft read-modify-write
// mutations. The Studio daemon (spawning CLI processes per click) and agent
// workflow_edit tools legitimately edit the same draft concurrently; an
// unguarded read→mutate→write loses whichever edit lands first.
const WORKFLOW_DRAFT_LOCK_STALE_MS = 15_000
const WORKFLOW_DRAFT_LOCK_TIMEOUT_MS = 8_000
const WORKFLOW_DRAFT_LOCK_POLL_MS = 25

async function withWorkflowDraftLock<T>(
  draftDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedMutex(`draft:${resolve(draftDir)}`, async () => {
    const lockDir = draftPath(draftDir, '.draft.lock')
    const deadline = Date.now() + WORKFLOW_DRAFT_LOCK_TIMEOUT_MS
    for (;;) {
      try {
        await mkdir(lockDir, { recursive: false })
        break
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : ''
        if (code === 'ENOENT') {
          // Draft directory does not exist yet (fresh create) — the caller's
          // own mkdir establishes it; nothing to serialize against.
          return fn()
        }
        if (code !== 'EEXIST') {
          throw error
        }
        try {
          const info = await stat(lockDir)
          if (Date.now() - info.mtimeMs > WORKFLOW_DRAFT_LOCK_STALE_MS) {
            await reclaimStaleBreakerLock(lockDir)
            continue
          }
        } catch {
          continue
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Workflow draft is being modified by another process: ${draftDir}. Retry the edit in a moment.`,
          )
        }
        await new Promise(resolveDelay =>
          setTimeout(resolveDelay, WORKFLOW_DRAFT_LOCK_POLL_MS),
        )
      }
    }
    try {
      return await fn()
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

/**
 * Rewrite `{{ nodes.<oldId>... }}` template references throughout a
 * definition after a node rename, so prompts/commands/conditions/outputs that
 * reference the renamed node keep resolving. Without this, a rename left
 * dangling references that either failed validation (confusing "rename
 * refused") or silently resolved to empty strings at runtime.
 */
function renameWorkflowNodeTemplateRefs<T>(
  value: T,
  oldId: string,
  newId: string,
): T {
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(\\{\\{\\s*nodes\\.)${escaped}(?=[.\\s}])`,
    'g',
  )
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return item.replace(pattern, `$1${newId}`)
    }
    if (Array.isArray(item)) {
      return item.map(walk)
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, entry]) => [
          key,
          walk(entry),
        ]),
      )
    }
    return item
  }
  return walk(value) as T
}

async function persistWorkflowDraftMutation(
  draftDir: string,
  definition: MatOSWorkflowDefinition,
  provenanceType: string,
  provenanceData: Record<string, unknown>,
): Promise<MatOSWorkflowDefinition> {
  const validation = validateWorkflowDefinition(definition)
  if (!validation.ok) {
    const message = validation.errors.map(error => error.message).join('; ')
    throw new Error(
      `Invalid workflow draft mutation: ${message || 'workflow validation failed'}`,
    )
  }
  await writeWorkflowDraftDefinition(draftDir, definition)
  await updateWorkflowDraft(draftDir, { status: 'draft' })
  await appendWorkflowDraftProvenance(draftDir, provenanceType, provenanceData)
  return definition
}

// Event-log context budget. The event log is observability and provenance
// (ids, timestamps, types, compact payloads) — durable full payloads live in
// node-run.json and the attempt input/output/error files. Without a cap, one
// chatty exec node used to push its whole stdout into `node.completed` events
// and every consumer (agent status tools, UI event feeds, receipt hashing)
// paid for it forever after.
const WORKFLOW_EVENT_STRING_HEAD_CHARS = 4_096
const WORKFLOW_EVENT_STRING_TAIL_CHARS = 1_024
const WORKFLOW_EVENT_ARRAY_MAX_ITEMS = 500
const WORKFLOW_EVENT_VALUE_MAX_DEPTH = 12

function compactWorkflowEventValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const max =
      WORKFLOW_EVENT_STRING_HEAD_CHARS + WORKFLOW_EVENT_STRING_TAIL_CHARS + 200
    if (value.length <= max) {
      return value
    }
    const omitted =
      value.length -
      WORKFLOW_EVENT_STRING_HEAD_CHARS -
      WORKFLOW_EVENT_STRING_TAIL_CHARS
    return `${value.slice(0, WORKFLOW_EVENT_STRING_HEAD_CHARS)}…[event payload truncated: ${omitted} chars omitted; full value persisted in the node run/attempt files]…${value.slice(-WORKFLOW_EVENT_STRING_TAIL_CHARS)}`
  }
  if (Array.isArray(value)) {
    if (depth >= WORKFLOW_EVENT_VALUE_MAX_DEPTH) {
      return `[array depth-capped: ${value.length} items]`
    }
    const items = value
      .slice(0, WORKFLOW_EVENT_ARRAY_MAX_ITEMS)
      .map(item => compactWorkflowEventValue(item, depth + 1))
    if (value.length > WORKFLOW_EVENT_ARRAY_MAX_ITEMS) {
      items.push(
        `…[event payload truncated: ${value.length - WORKFLOW_EVENT_ARRAY_MAX_ITEMS} more items]`,
      )
    }
    return items
  }
  if (value && typeof value === 'object') {
    if (depth >= WORKFLOW_EVENT_VALUE_MAX_DEPTH) {
      return `[object depth-capped: ${Object.keys(value as object).length} keys]`
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        compactWorkflowEventValue(item, depth + 1),
      ]),
    )
  }
  return value
}

export async function appendWorkflowEvent(
  runDir: string,
  event: MatOSWorkflowEventInput,
): Promise<MatOSWorkflowEvent> {
  const trace = traceContextFromEnv()
  const fullEvent: MatOSWorkflowEvent = {
    id: randomUUID(),
    timestamp: nowIso(),
    ...(trace ? { trace } : {}),
    ...event,
    data: compactWorkflowEventValue(event.data ?? {}) as Record<string, unknown>,
  }
  // Serialize appends per run: the keyed mutex orders work inside this
  // process (the parallel scheduler batch), and the cross-process file lock
  // orders this worker against other writers (a cancel/control CLI, a
  // concurrent detached worker) — O_APPEND write atomicity is not guaranteed
  // on network filesystems, so unserialized appends can interleave and
  // corrupt lines.
  await withKeyedMutex(`events:${runDir}`, async () => {
    await withWorkflowEventsFileLock(runDir, async () => {
      // Torn-tail isolation: a crash/ENOSPC mid-append can leave a partial
      // line without a trailing newline. Appending directly after it would
      // merge THIS (valid) event into the torn line, so the tolerant reader
      // silently drops both. A leading newline confines the damage to the
      // torn line itself.
      const eventsPath = runPath(runDir, 'events.jsonl')
      let needsLeadingNewline = false
      try {
        const info = await stat(eventsPath)
        if (info.size > 0) {
          const handle = await open(eventsPath, 'r')
          try {
            const tail = Buffer.alloc(1)
            await handle.read(tail, 0, 1, info.size - 1)
            needsLeadingNewline = tail[0] !== 0x0a
          } finally {
            await handle.close()
          }
        }
      } catch {
        // Missing file (first event) or unreadable tail: append as-is.
      }
      await appendFile(
        eventsPath,
        `${needsLeadingNewline ? '\n' : ''}${JSON.stringify(fullEvent)}\n`,
        'utf8',
      )
      // Keep the receipt synchronized with the append-only event chain. Several
      // terminal/control transitions append a semantic event after writing the
      // status snapshot; refreshing only on status writes would leave the receipt
      // one event behind and make an otherwise native run fail provenance checks.
      await writeWorkflowRuntimeReceipt(runDir)
    })
  })
  return fullEvent
}

// Cross-process exclusion for events.jsonl appends and the receipt refresh
// that must observe them. mkdir-based like the run lock, but with a much
// shorter staleness horizon: the critical section is one append plus one
// receipt write, so anything older than a few seconds is a dead holder.
const WORKFLOW_EVENTS_LOCK_STALE_MS = 10_000
const WORKFLOW_EVENTS_LOCK_TIMEOUT_MS = 5_000
const WORKFLOW_EVENTS_LOCK_POLL_MS = 15

// Single-winner reclaim for the short-lived breaker locks below: renaming
// the stale directory to a unique tombstone is atomic, so racing reclaimers
// cannot both "win" and one of them delete a freshly re-created live lock
// (the failure mode the run lock fixed with the same pattern).
async function reclaimStaleBreakerLock(lockDir: string): Promise<void> {
  const tombstone = `${lockDir}.reclaim.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`
  try {
    await rename(lockDir, tombstone)
  } catch {
    return
  }
  await rm(tombstone, { recursive: true, force: true }).catch(() => {})
}

async function withWorkflowEventsFileLock<T>(
  runDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = runPath(runDir, '.events.lock')
  const deadline = Date.now() + WORKFLOW_EVENTS_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'EEXIST') {
        // The run dir may be mid-creation or on a filesystem that rejects the
        // lock; losing serialization here is strictly no worse than before
        // the lock existed, while failing the append would lose the event.
        return fn()
      }
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > WORKFLOW_EVENTS_LOCK_STALE_MS) {
          await reclaimStaleBreakerLock(lockDir)
          continue
        }
      } catch {
        // Lock released between mkdir and stat — retry immediately.
        continue
      }
      if (Date.now() >= deadline) {
        // Never drop the event over lock contention; a rare unserialized
        // append is preferable to losing run history.
        return fn()
      }
      await new Promise(resolve =>
        setTimeout(resolve, WORKFLOW_EVENTS_LOCK_POLL_MS),
      )
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function createWorkflowRun(
  input: CreateWorkflowRunInput,
): Promise<MatOSWorkflowRunHandle> {
  const runId = `run_${randomUUID()}`
  const dir = join(input.workflowRunsDir ?? join(input.workflowsDir, 'runs'), runId)
  const createdAt = nowIso()
  const parameters = input.parameters ?? {}
  const trace = traceContextFromEnv()
  const artifactRoot = workflowArtifactRoot({
    workflowRef: input.workflowRef,
    workspaceDir: input.workspaceDir,
    runDir: dir,
    runId,
  })
  const snapshot: MatOSWorkflowRunSnapshot = {
    schemaVersion: MATOS_WORKFLOW_RUN_SCHEMA_VERSION,
    runId,
    workflowRef: input.workflowRef,
    status: 'created',
    createdAt,
    updatedAt: createdAt,
    parameters,
    outputs: {},
    graphSnapshotPath: 'graph.snapshot.json',
    artifactRoot,
    projectCwd: input.projectCwd,
    workspaceDir: input.workspaceDir,
    ...(typeof input.childDepth === 'number' && input.childDepth > 0
      ? { childDepth: Math.floor(input.childDepth) }
      : {}),
    ...(trace ? { trace } : {}),
    // Every new run carries an explicit provenance. Callers that do not
    // declare one get the least-privileged 'unknown' rather than an absent
    // field, so downstream trust decisions never have to guess whether a
    // missing provenance means "legacy record" or "undeclared creator".
    provenance: input.provenance ?? { source: 'unknown' },
  }

  await mkdir(dir, { recursive: true })
  await mkdir(runPath(dir, 'node-runs'), { recursive: true })
  await mkdir(runPath(dir, 'messages'), { recursive: true })
  await mkdir(runPath(dir, 'approvals'), { recursive: true })
  await mkdir(runPath(dir, 'child-runs'), { recursive: true })
  await mkdir(artifactRoot, { recursive: true })
  await writeJson(runPath(dir, 'run.json'), snapshot)
  await writeJson(runPath(dir, 'graph.snapshot.json'), input.graphSnapshot)
  await writeJson(runPath(dir, 'inputs.json'), parameters)
  await writeJson(runPath(dir, 'outputs.json'), {})
  await writeJson(runPath(dir, 'artifacts.json'), [])
  await appendWorkflowEvent(dir, {
    type: 'workflow.run.created',
    data: {
      runId,
      workflowRef: input.workflowRef,
      parameters,
      provenance: snapshot.provenance,
    },
  })
  await notifyWorkflowRunPersisted({
    runDir: dir,
    snapshot,
    phase: 'created',
  })

  return { runId, dir }
}

export async function createWorkflowDraft(
  input: CreateWorkflowDraftInput,
): Promise<MatOSWorkflowDraftHandle> {
  const draftId = sanitizeId(input.draftId, 'draft')
  const dir = resolveWorkflowDraftDir(input.workflowsDir, draftId)
  const createdAt = nowIso()
  const snapshot: MatOSWorkflowDraftSnapshot = {
    draftId,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
    workflowPath: 'workflow.json',
    provenancePath: 'provenance.json',
    validationPath: 'validation.json',
    sourceRunId: input.sourceRunId,
    sourceWorkflowRef: input.sourceWorkflowRef,
  }

  await mkdir(dir, { recursive: true })
  await writeJson(draftPath(dir, 'draft.json'), snapshot)
  await writeWorkflowDraftDefinition(
    dir,
    input.definition ?? defaultDraftDefinition({ ...input, draftId }),
  )
  await writeJson(draftPath(dir, 'provenance.json'), [])
  await appendWorkflowDraftProvenance(dir, 'draft.created', {
    draftId,
    sourceRunId: input.sourceRunId,
    sourceWorkflowRef: input.sourceWorkflowRef,
  })

  return {
    draftId,
    dir,
    workflowPath: draftPath(dir, 'workflow.json'),
    provenancePath: draftPath(dir, 'provenance.json'),
    validationPath: draftPath(dir, 'validation.json'),
  }
}

export async function readWorkflowDraft(
  draftDir: string,
): Promise<MatOSWorkflowDraftSnapshot> {
  return readJson<MatOSWorkflowDraftSnapshot>(draftPath(draftDir, 'draft.json'))
}

export async function listWorkflowDrafts(
  workflowsDir: string,
): Promise<MatOSWorkflowDraftListItem[]> {
  const draftsDir = join(workflowsDir, 'drafts')
  let entries: string[]
  try {
    entries = await readdir(draftsDir)
  } catch {
    return []
  }
  const drafts = await Promise.all(
    entries.map(async entry => {
      const draftDir = join(draftsDir, entry)
      try {
        return {
          ...(await readWorkflowDraft(draftDir)),
          draftDir,
        }
      } catch {
        return undefined
      }
    }),
  )
  return drafts
    .filter((draft): draft is MatOSWorkflowDraftListItem => Boolean(draft))
    .sort((a, b) => {
      const updated = String(b.updatedAt).localeCompare(String(a.updatedAt))
      return updated === 0 ? b.draftId.localeCompare(a.draftId) : updated
    })
}

export async function readWorkflowDraftDefinition(
  draftDir: string,
): Promise<MatOSWorkflowDefinition> {
  return readJson<MatOSWorkflowDefinition>(draftPath(draftDir, 'workflow.json'))
}

export async function readWorkflowDraftProvenance(
  draftDir: string,
): Promise<MatOSWorkflowDraftProvenanceEntry[]> {
  return readJson<MatOSWorkflowDraftProvenanceEntry[]>(
    draftPath(draftDir, 'provenance.json'),
  )
}

function remapWorkflowEdge(
  edge: MatOSWorkflowEdge,
  idMap: Record<string, string>,
): MatOSWorkflowEdge {
  return {
    ...edge,
    from: idMap[edge.from] ?? edge.from,
    to: idMap[edge.to] ?? edge.to,
  }
}

function addWorkflowDependencyEdge(
  edges: MatOSWorkflowEdge[] | undefined,
  from: string,
  to: string,
): MatOSWorkflowEdge[] {
  const current = edges ?? []
  if (current.some(edge => edge.from === from && edge.to === to)) {
    return current
  }
  return [...current, { from, to }]
}

function isPlainDependencyEdge(edge: MatOSWorkflowEdge): boolean {
  return (
    edge.condition === undefined &&
    (edge.route === undefined || edge.route === 'success')
  )
}

function syncWorkflowDependencyEdgesForNode(
  edges: MatOSWorkflowEdge[] | undefined,
  nodeId: string,
  dependsOn: string[],
): MatOSWorkflowEdge[] {
  const dependencies = new Set(dependsOn)
  let next = (edges ?? []).filter(edge => {
    if (edge.to !== nodeId || !isPlainDependencyEdge(edge)) {
      return true
    }
    return dependencies.has(edge.from)
  })
  for (const dependency of dependsOn) {
    next = addWorkflowDependencyEdge(next, dependency, nodeId)
  }
  return next
}

function removeWorkflowDependencyEdge(
  edges: MatOSWorkflowEdge[] | undefined,
  from: string,
  to: string,
): MatOSWorkflowEdge[] {
  return (edges ?? []).filter(edge => edge.from !== from || edge.to !== to)
}

export async function importWorkflowComponent(
  input: ImportWorkflowComponentInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const remapped = remapComponentNodes(current.nodes, input.definition.nodes)
  let edges = [
    ...(current.edges ?? []),
    ...(input.definition.edges ?? []).map(edge =>
      remapWorkflowEdge(edge, remapped.idMap),
    ),
  ]
  for (const node of remapped.nodes) {
    edges = syncWorkflowDependencyEdgesForNode(edges, node.id, node.dependsOn)
  }
  const definition: MatOSWorkflowDefinition = {
    ...current,
    parameters: {
      ...current.parameters,
      ...input.definition.parameters,
    },
    nodes: [...current.nodes, ...remapped.nodes],
    edges,
    outputs: {
      ...current.outputs,
      ...input.definition.outputs,
    },
  }

  await writeWorkflowDraftDefinition(input.draftDir, definition)
  await updateWorkflowDraft(input.draftDir, { status: 'draft' })
  await appendWorkflowDraftProvenance(
    input.draftDir,
    'draft.component.imported',
    {
      componentRef: input.componentRef,
      importedNodeIds: remapped.nodes.map(node => node.id),
      idMap: remapped.idMap,
    },
  )
  return definition
  })
}

export async function addWorkflowDraftNode(
  input: AddWorkflowDraftNodeInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const node = normalizeDraftNode(input.node)
  const nodeId = assertDraftNodeId(node.id)
  if (current.nodes.some(item => item.id === nodeId)) {
    throw new Error(`Workflow node already exists: ${nodeId}`)
  }
  const definition: MatOSWorkflowDefinition = {
    ...current,
    nodes: [...current.nodes, { ...node, id: nodeId }],
    edges: syncWorkflowDependencyEdgesForNode(
      current.edges,
      nodeId,
      node.dependsOn,
    ),
  }
  return persistWorkflowDraftMutation(input.draftDir, definition, 'draft.node.added', {
    nodeId,
    type: node.type,
  })
  })
}

export async function updateWorkflowDraftNode(
  input: UpdateWorkflowDraftNodeInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const existing = assertNodeExists(current, input.nodeId)
  const nextId = assertDraftNodeId(
    typeof input.patch.id === 'string' ? input.patch.id : existing.id,
  )
  if (
    nextId !== existing.id &&
    current.nodes.some(node => node.id === nextId)
  ) {
    throw new Error(`Workflow node already exists: ${nextId}`)
  }
  const renamed = nextId !== input.nodeId
  const updated = normalizeDraftNode({
    ...existing,
    ...input.patch,
    id: nextId,
  })
  let definition: MatOSWorkflowDefinition = {
    ...current,
    nodes: current.nodes.map(node => {
      if (node.id === input.nodeId) {
        return updated
      }
      if (renamed) {
        return {
          ...node,
          dependsOn: node.dependsOn.map(dependency =>
            dependency === input.nodeId ? nextId : dependency,
          ),
        }
      }
      return node
    }),
    edges: syncWorkflowDependencyEdgesForNode(
      (current.edges ?? []).map(edge => ({
        ...edge,
        from: edge.from === input.nodeId ? nextId : edge.from,
        to: edge.to === input.nodeId ? nextId : edge.to,
      })),
      nextId,
      updated.dependsOn,
    ),
    // A rename must follow every structural reference, not just
    // dependsOn/edges: state-machine transitions and template expressions
    // ({{ nodes.<id>... }} in prompts, commands, conditions, outputs) would
    // otherwise dangle and either fail validation or resolve to nothing.
    ...(renamed && current.transitions
      ? {
          transitions: current.transitions.map(transition => ({
            ...transition,
            from: transition.from === input.nodeId ? nextId : transition.from,
            to: transition.to === input.nodeId ? nextId : transition.to,
          })),
        }
      : {}),
  }
  if (renamed) {
    definition = renameWorkflowNodeTemplateRefs(
      definition,
      input.nodeId,
      nextId,
    )
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.node.updated',
    { nodeId: input.nodeId, nextNodeId: nextId },
  )
  })
}

export async function deleteWorkflowDraftNode(
  input: DeleteWorkflowDraftNodeInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  assertNodeExists(current, input.nodeId)
  const definition: MatOSWorkflowDefinition = {
    ...current,
    nodes: current.nodes
      .filter(node => node.id !== input.nodeId)
      .map(node => ({
        ...node,
        dependsOn: node.dependsOn.filter(
          dependency => dependency !== input.nodeId,
        ),
      })),
    edges: (current.edges ?? []).filter(
      edge => edge.from !== input.nodeId && edge.to !== input.nodeId,
    ),
    // Deleting a node must also drop state-machine transitions that touch
    // it; leaving them dangling turns every later draft mutation into a
    // baffling validation failure about a node that no longer exists.
    ...(current.transitions
      ? {
          transitions: current.transitions.filter(
            transition =>
              transition.from !== input.nodeId &&
              transition.to !== input.nodeId,
          ),
        }
      : {}),
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.node.deleted',
    { nodeId: input.nodeId },
  )
  })
}

export async function connectWorkflowDraftNodes(
  input: WorkflowDraftEdgeInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  assertNodeExists(current, input.from)
  assertNodeExists(current, input.to)
  const definition: MatOSWorkflowDefinition = {
    ...current,
    nodes: current.nodes.map(node =>
      node.id === input.to
        ? {
            ...node,
            dependsOn: [...new Set([...node.dependsOn, input.from])],
          }
        : node,
    ),
    edges: addWorkflowDependencyEdge(current.edges, input.from, input.to),
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.edge.connected',
    { from: input.from, to: input.to },
  )
  })
}

export async function disconnectWorkflowDraftNodes(
  input: WorkflowDraftEdgeInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  assertNodeExists(current, input.from)
  assertNodeExists(current, input.to)
  const definition: MatOSWorkflowDefinition = {
    ...current,
    nodes: current.nodes.map(node =>
      node.id === input.to
        ? {
            ...node,
            dependsOn: node.dependsOn.filter(
              dependency => dependency !== input.from,
            ),
          }
        : node,
    ),
    edges: removeWorkflowDependencyEdge(current.edges, input.from, input.to),
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.edge.disconnected',
    { from: input.from, to: input.to },
  )
  })
}

function draftTransitionMatches(
  transition: MatOSWorkflowTransitionEdge,
  selector: { id?: string; from?: string; to?: string },
): boolean {
  if (selector.id) {
    return transition.id === selector.id
  }
  return (
    (!selector.from || transition.from === selector.from) &&
    (!selector.to || transition.to === selector.to)
  )
}

function transitionParameterRefs(
  transition: MatOSWorkflowTransitionEdge,
): string[] {
  const found = new Set<string>()
  for (const [field, value] of Object.entries({
    guard: transition.guard,
    reducer: transition.reducer,
  })) {
    if (
      value === undefined ||
      (!Array.isArray(value) && typeof value !== 'object' && typeof value !== 'string')
    ) {
      continue
    }
    for (const expression of extractWorkflowTemplateExpressions(
      value,
      `transition.${field}`,
    )) {
      const reference = parseWorkflowReferenceExpression(expression.expression)
      if (reference.kind !== 'parameter') {
        continue
      }
      const parameterId = (reference.parameterPath ?? '').split('.')[0]
      if (parameterId) {
        found.add(parameterId)
      }
    }
  }
  return [...found]
}

function inferTransitionParameters(input: {
  definition: MatOSWorkflowDefinition
  transition: MatOSWorkflowTransitionEdge
}): MatOSWorkflowDefinition {
  const additions: Record<string, MatOSWorkflowParameter> = {}
  for (const parameterId of transitionParameterRefs(input.transition)) {
    if (input.definition.parameters[parameterId] !== undefined) {
      continue
    }
    additions[parameterId] = {
      description: `Inferred from state-machine transition ${input.transition.id ?? `${input.transition.from}->${input.transition.to}`}.`,
    }
  }
  if (Object.keys(additions).length === 0) {
    return input.definition
  }
  return {
    ...input.definition,
    parameters: {
      ...input.definition.parameters,
      ...additions,
    },
  }
}

export async function connectWorkflowDraftTransition(
  input: ConnectWorkflowDraftTransitionInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  assertNodeExists(current, input.transition.from)
  assertNodeExists(current, input.transition.to)
  const transitions = [...(current.transitions ?? [])]
  const replaceIndex = input.transition.id
    ? transitions.findIndex(item => item.id === input.transition.id)
    : transitions.findIndex(
        item =>
          !item.id &&
          item.from === input.transition.from &&
          item.to === input.transition.to &&
          (item.route ?? 'success') === (input.transition.route ?? 'success'),
      )
  if (replaceIndex >= 0) {
    transitions[replaceIndex] = input.transition
  } else {
    transitions.push(input.transition)
  }
  const definition = inferTransitionParameters({
    definition: {
      ...current,
      transitions,
    },
    transition: input.transition,
  })
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.transition.connected',
    {
      from: input.transition.from,
      to: input.transition.to,
      ...(input.transition.id ? { id: input.transition.id } : {}),
    },
  )
  })
}

export async function disconnectWorkflowDraftTransition(
  input: DisconnectWorkflowDraftTransitionInput,
): Promise<MatOSWorkflowDefinition> {
  if (!input.id && !input.from && !input.to) {
    throw new Error('Disconnecting a workflow draft transition requires id or from/to')
  }
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const transitions = current.transitions ?? []
  const remaining = transitions.filter(
    transition => !draftTransitionMatches(transition, input),
  )
  if (remaining.length === transitions.length) {
    throw new Error(
      `Workflow draft transition not found: ${input.id ?? `${input.from ?? '*'}->${input.to ?? '*'}`}`,
    )
  }
  const definition: MatOSWorkflowDefinition = {
    ...current,
    transitions: remaining,
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.transition.disconnected',
    {
      ...(input.id ? { id: input.id } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      removedCount: transitions.length - remaining.length,
    },
  )
  })
}

export async function setWorkflowDraftStateMachine(
  input: SetWorkflowDraftStateMachineInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const policy = { ...current.policy } as Record<string, unknown>
  if (input.disable) {
    delete policy.executionModel
    delete policy.stateMachine
  } else {
    const existing =
      policy.stateMachine && typeof policy.stateMachine === 'object' && !Array.isArray(policy.stateMachine)
        ? (policy.stateMachine as Record<string, unknown>)
        : {}
    const initialNodeId = input.initialNodeId ?? existing.initialNodeId
    if (typeof initialNodeId !== 'string' || !initialNodeId) {
      throw new Error('Workflow draft state machine requires --initial-node')
    }
    assertNodeExists(current, initialNodeId)
    const maxTransitions = input.maxTransitions ?? existing.maxTransitions
    if (
      typeof maxTransitions !== 'number' ||
      !Number.isInteger(maxTransitions) ||
      maxTransitions < 1
    ) {
      throw new Error('Workflow draft state machine requires a positive integer --max-transitions')
    }
    policy.executionModel = 'state_machine'
    policy.stateMachine = {
      ...existing,
      initialNodeId,
      maxTransitions,
      ...(input.maxFrames !== undefined ? { maxFrames: input.maxFrames } : {}),
    }
  }
  const definition: MatOSWorkflowDefinition = {
    ...current,
    policy: policy as MatOSWorkflowDefinition['policy'],
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.state_machine.set',
    input.disable
      ? { disabled: true }
      : {
          initialNodeId: String(input.initialNodeId ?? ''),
          ...(input.maxTransitions !== undefined
            ? { maxTransitions: input.maxTransitions }
            : {}),
        },
  )
  })
}

export async function setWorkflowDraftOutputs(
  input: SetWorkflowDraftOutputsInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const definition: MatOSWorkflowDefinition = {
    ...current,
    outputs: input.outputs,
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.outputs.set',
    { outputIds: Object.keys(input.outputs) },
  )
  })
}

export async function setWorkflowDraftParameters(
  input: SetWorkflowDraftParametersInput,
): Promise<MatOSWorkflowDefinition> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const current = await readWorkflowDraftDefinition(input.draftDir)
  const parameters: MatOSWorkflowDefinition['parameters'] = input.replace
    ? {}
    : { ...current.parameters }
  const removed = new Set(
    (input.remove ?? []).map(item => item.trim()).filter(Boolean),
  )
  for (const key of removed) {
    delete parameters[key]
  }
  for (const [key, parameter] of Object.entries(input.parameters)) {
    if (!key.trim()) {
      continue
    }
    parameters[key] = parameter
  }
  const definition: MatOSWorkflowDefinition = {
    ...current,
    parameters,
  }
  return persistWorkflowDraftMutation(
    input.draftDir,
    definition,
    'draft.parameters.set',
    {
      parameterIds: Object.keys(input.parameters),
      removedParameterIds: [...removed],
      replace: input.replace === true,
    },
  )
  })
}

export async function replaceWorkflowDraftDefinition(
  input: ReplaceWorkflowDraftDefinitionInput,
): Promise<MatOSWorkflowDefinition> {
  // Callers (CLI --definition-file/--definition-json, workflow_edit
  // action=replace_definition) hand over raw JSON. Normalize it exactly like
  // file loading does — defaulting policy/parameters/outputs/edges — so a
  // minimal definition validates instead of crashing downstream property
  // reads, then apply draft-specific node normalization on top.
  const normalized = normalizeWorkflowDefinitionInput(input.definition)
  const definition: MatOSWorkflowDefinition = {
    ...normalized,
    nodes: normalized.nodes.map(normalizeDraftNode),
  }
  return withWorkflowDraftLock(input.draftDir, () =>
    persistWorkflowDraftMutation(
      input.draftDir,
      definition,
      'draft.definition.replaced',
      {
        nodeIds: definition.nodes.map(node => node.id),
        outputIds: Object.keys(definition.outputs),
      },
    ),
  )
}

export function workflowDraftDefinitionDigest(definition: MatOSWorkflowDefinition): string {
  // Match the persisted JSON, where optional undefined properties are absent.
  return workflowIoDigest(JSON.parse(JSON.stringify(definition)))
}

export async function publishWorkflowDraft(
  input: PublishWorkflowDraftInput,
): Promise<PublishWorkflowDraftResult> {
  return withWorkflowDraftLock(input.draftDir, async () => {
  const snapshot = await readWorkflowDraft(input.draftDir)
  const draftDefinition = await readWorkflowDraftDefinition(input.draftDir)
  if (input.expectedDefinition !== undefined &&
      workflowDraftDefinitionDigest(draftDefinition) !== input.expectedDefinition) {
    throw new Error('WORKFLOW_DRAFT_CONFLICT: Workflow draft changed after validation. Validate the current definition and retry publication.')
  }
  const id = workflowPublicationAssetId(input.id)
  const version = input.version ?? draftDefinition.version ?? '0.1.0'
  const name = input.name ?? draftDefinition.name ?? id
  const description = input.description ?? draftDefinition.description
  const assetKey = toMatOSAssetKey('workflow', id, version)
  const assetDir = join(getMatOSAssetsDir(input.cwd), 'workflows', id)
  const workflowPath = join(assetDir, 'workflow.json')
  const manifestPath = join(assetDir, 'asset.json')
  const definition: MatOSWorkflowDefinition = {
    ...draftDefinition,
    name,
    version,
    description,
    sourcePath: undefined,
  }

  await mkdir(assetDir, { recursive: true })
  await writeJson(manifestPath, {
    schemaVersion: 1,
    id,
    type: 'workflow',
    name,
    version,
    description,
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
    metadata: {
      generatedBy: 'matos.workflow.draft',
      draftId: snapshot.draftId,
      sourceRunId: snapshot.sourceRunId,
      sourceWorkflowRef: snapshot.sourceWorkflowRef,
    },
  })
  await writeJson(workflowPath, definition)
  await writeWorkflowDraftDefinition(input.draftDir, definition)
  await updateWorkflowDraft(input.draftDir, {
    status: 'published',
    publishedAssetKey: assetKey,
  })
  await appendWorkflowDraftProvenance(input.draftDir, 'draft.published', {
    assetKey,
    manifestPath,
    workflowPath,
  })

  return { assetKey, assetDir, manifestPath, workflowPath, definitionDigest: workflowDraftDefinitionDigest(definition) }
  })
}

export async function recordWorkflowDraftPublicationFailure(input: {
  draftDir: string
  published: PublishWorkflowDraftResult
  reason: string
}): Promise<void> {
  await withWorkflowDraftLock(input.draftDir, async () => {
    const snapshot = await readWorkflowDraft(input.draftDir)
    const definition = await readWorkflowDraftDefinition(input.draftDir)
    // Do not roll back another writer's newer edit or publication status.
    if (snapshot.publishedAssetKey === input.published.assetKey &&
        workflowDraftDefinitionDigest(definition) === input.published.definitionDigest) {
      await updateWorkflowDraft(input.draftDir, { status: 'draft', publishedAssetKey: undefined })
    }
    await appendWorkflowDraftProvenance(input.draftDir, 'draft.publication.failed', {
      assetKey: input.published.assetKey, definitionDigest: input.published.definitionDigest, reason: input.reason,
    })
  })
}

export async function forkWorkflowRunToDraft(
  input: ForkWorkflowRunToDraftInput,
): Promise<MatOSWorkflowDraftHandle> {
  const run = await readWorkflowRun(input.runDir)
  const graphSnapshot = await readJson<unknown>(
    runPath(input.runDir, run.graphSnapshotPath),
  )
  const definition = parseWorkflowDefinition(JSON.stringify(graphSnapshot), {
    sourcePath: run.graphSnapshotPath,
  })
  const draft = await createWorkflowDraft({
    workflowsDir: input.workflowsDir,
    draftId: input.draftId,
    name: input.name ?? definition.name,
    definition: {
      ...definition,
      name: input.name ?? definition.name,
      sourcePath: undefined,
    },
    sourceRunId: run.runId,
    sourceWorkflowRef: run.workflowRef,
  })
  await appendWorkflowDraftProvenance(draft.dir, 'draft.run.forked', {
    runId: run.runId,
    workflowRef: run.workflowRef,
  })
  return draft
}

export async function readWorkflowRun(
  runDir: string,
): Promise<MatOSWorkflowRunSnapshot> {
  return readJson<MatOSWorkflowRunSnapshot>(runPath(runDir, 'run.json'))
}

const DURABLE_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export async function writeWorkflowRun(
  runDir: string,
  snapshot: MatOSWorkflowRunSnapshot,
): Promise<void> {
  const persisted = {
    ...snapshot,
    updatedAt: nowIso(),
  }
  await writeJson(runPath(runDir, 'run.json'), persisted, {
    // Terminal transitions are the record other systems (benchmarks,
    // provenance, budget rollups) trust most; fsync them so an OS/power
    // failure right after completion cannot roll a finished run back to
    // running. Intermediate writes stay fast.
    durable: DURABLE_RUN_STATUSES.has(persisted.status),
  })
  await notifyWorkflowRunPersisted({
    runDir,
    snapshot: persisted,
    phase: 'updated',
  })
}

export async function readWorkflowRunEvents(
  runDir: string,
  options: { tail?: number } = {},
): Promise<MatOSWorkflowEvent[]> {
  if (options.tail !== undefined) return readWorkflowEventTail(runPath(runDir, 'events.jsonl'), options.tail)
  let content: string
  try {
    content = await readFile(runPath(runDir, 'events.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // No events yet (or the log was never created): treat as an empty history
    // instead of throwing so inspect/recovery still work on fresh/partial runs.
    return []
  }
  const events: MatOSWorkflowEvent[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      events.push(JSON.parse(trimmed) as MatOSWorkflowEvent)
    } catch {
      // Tolerate a truncated/garbled trailing line left by a crash mid-append
      // rather than failing the whole read.
      continue
    }
  }
  return events
}

export async function writeNodeAttempt(
  input: WriteWorkflowNodeAttemptInput,
): Promise<void> {
  const attemptDir = join(
    input.runDir,
    'node-runs',
    input.nodeId,
    'attempts',
    String(input.attempt),
  )
  await mkdir(attemptDir, { recursive: true })
  const manifestPath = join(attemptDir, 'attempt.json')
  let current: Partial<MatOSWorkflowNodeAttemptSnapshot> = {}
  try {
    current = await readJson<Partial<MatOSWorkflowNodeAttemptSnapshot>>(
      manifestPath,
    )
  } catch {
    current = {}
  }
  const timestamp = nowIso()
  const paths: Partial<MatOSWorkflowNodeAttemptSnapshot> = {}
  if (input.input !== undefined) {
    await writeJson(join(attemptDir, 'input.json'), input.input)
    paths.inputPath = 'input.json'
  }
  if (input.output !== undefined) {
    await writeJson(join(attemptDir, 'output.json'), input.output)
    paths.outputPath = 'output.json'
  }
  if (input.error !== undefined) {
    await writeJson(join(attemptDir, 'error.json'), input.error)
    paths.errorPath = 'error.json'
  }
  if (input.stdout !== undefined) {
    await writeFile(join(attemptDir, 'stdout.log'), input.stdout, 'utf8')
    paths.stdoutPath = 'stdout.log'
  }
  if (input.stderr !== undefined) {
    await writeFile(join(attemptDir, 'stderr.log'), input.stderr, 'utf8')
    paths.stderrPath = 'stderr.log'
  }
  const status =
    input.status ??
    current.status ??
    (input.error !== undefined
      ? 'failed'
      : input.output !== undefined
        ? 'completed'
        : 'running')
  await writeJson(manifestPath, {
    ...current,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...paths,
    status,
    startedAt: input.startedAt ?? current.startedAt ?? timestamp,
    ...(input.finishedAt ?? current.finishedAt
      ? { finishedAt: input.finishedAt ?? current.finishedAt }
      : {}),
    ...(input.idempotencyKey ?? current.idempotencyKey
      ? { idempotencyKey: input.idempotencyKey ?? current.idempotencyKey }
      : {}),
    ...(input.contractValidation ?? current.contractValidation
      ? { contractValidation: input.contractValidation ?? current.contractValidation }
      : {}),
    ...(input.sideEffect ?? current.sideEffect
      ? { sideEffect: input.sideEffect ?? current.sideEffect }
      : {}),
    ...(input.usage ?? current.usage
      ? { usage: input.usage ?? current.usage }
      : {}),
  } satisfies MatOSWorkflowNodeAttemptSnapshot)
}
