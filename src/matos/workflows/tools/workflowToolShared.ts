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

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMatOSAssetsDir } from '../../project.js'
import type { MatOSToolInputSchema } from '../../tools/matosToolRunner.js'
import type { MatOSWorkflowRunFilters } from '../workflowService.js'
import { matOSWorkflowService } from '../workflowService.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowGuardCheck,
  MatOSWorkflowNode,
  MatOSWorkflowParameter,
  MatOSWorkflowRunProvenance,
  MatOSWorkflowTransitionEdge,
} from '../types.js'
import {
  MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES,
  MATOS_WORKFLOW_RUNTIME_NODE_TYPES,
  MATOS_WORKFLOW_SEMANTIC_NODE_TYPES,
  workflowNodeManifestForType,
} from '../nodeManifests.js'

export type MatOSWorkflowToolResult = {
  text: string
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type MatOSWorkflowToolOutputSchema = MatOSToolInputSchema

export type MatOSWorkflowTool = {
  name: string
  description: string
  inputSchema: MatOSToolInputSchema
  outputSchema?: MatOSWorkflowToolOutputSchema
  call: (input: unknown, context?: { sessionId?: string }) => Promise<MatOSWorkflowToolResult>
}

export type MatOSWorkflowToolContext = {
  cwd: string
  selectedRole?: string
  workflowAccessMode?: 'unrestricted' | 'role-mounted'
  workflowStartPolicy?: 'normal' | 'tracked-cli-only'
  allowedWorkflowRefs?: string[]
  sessionWorkflowRefs?: string[]
}

type PersistedWorkflowSessionRefs = {
  version?: number
  roles?: Record<string, string[]>
}

export function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function optionalInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined
  }
  return value
}

export const WORKFLOW_TOOL_OUTPUT_SCHEMA: MatOSWorkflowToolOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: true,
}

export function withWorkflowToolResultSchemas(
  tools: MatOSWorkflowTool[],
): MatOSWorkflowTool[] {
  return tools.map(tool => ({
    ...tool,
    outputSchema: tool.outputSchema ?? WORKFLOW_TOOL_OUTPUT_SCHEMA,
  }))
}

export function jsonResult(value: Record<string, unknown>): MatOSWorkflowToolResult {
  // Coerce the success envelope: a tool payload carrying a non-boolean `ok`
  // must not override the declared boolean `ok` in the output schema, so the
  // injected `ok: true` goes after the spread rather than before it.
  const structured =
    typeof value.ok === 'boolean' ? value : { ...value, ok: true }
  return {
    text: `${JSON.stringify(structured)}\n`,
    structuredContent: structured,
  }
}

export function errorResult(message: string): MatOSWorkflowToolResult {
  return {
    text: `${message}\n`,
    structuredContent: { ok: false, error: message },
    isError: true,
  }
}

export function textSchema(
  properties: Record<string, object>,
  required: string[] = [],
): MatOSToolInputSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export function parseParams(value: unknown): Record<string, unknown> {
  return metadataObject(value)
}

function workflowRefBase(ref: string): string {
  const at = ref.indexOf('@')
  return at >= 0 ? ref.slice(0, at) : ref
}

function workflowRefHasVersion(ref: string): boolean {
  return ref.includes('@')
}

function workflowRefMatches(candidate: string, ref: string): boolean {
  if (candidate === ref) {
    return true
  }
  if (workflowRefBase(candidate) !== workflowRefBase(ref)) {
    return false
  }
  return !workflowRefHasVersion(ref) || !workflowRefHasVersion(candidate)
}

function workflowIdFromRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined
  }
  const base = workflowRefBase(ref.trim())
  const id = base.startsWith('workflow:') ? base.slice('workflow:'.length) : base
  if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    return undefined
  }
  return id
}

function workflowRefFromManifest(value: unknown): string | undefined {
  const manifest = metadataObject(value)
  if (manifest.type !== 'workflow') {
    return undefined
  }
  const id = optionalString(manifest.id)
  if (!id) {
    return undefined
  }
  const version = optionalString(manifest.version)
  return `workflow:${id}${version ? `@${version}` : ''}`
}

function mergeWorkflowRefs(...groups: Array<readonly string[] | undefined>): string[] {
  const refs: string[] = []
  for (const group of groups) {
    for (const ref of group ?? []) {
      if (typeof ref !== 'string' || ref.trim().length === 0) {
        continue
      }
      const normalized = ref.trim()
      if (!refs.some(candidate => workflowRefMatches(candidate, normalized))) {
        refs.push(normalized)
      }
    }
  }
  return refs
}

function workflowSessionRefsPath(context: MatOSWorkflowToolContext): string {
  return join(context.cwd, '.matos', 'runtime', 'workflow-session-refs.json')
}

function workflowSessionRoleKey(context: MatOSWorkflowToolContext): string {
  return context.selectedRole?.trim() || '__default__'
}

function readPersistedWorkflowSessionRefs(
  context: MatOSWorkflowToolContext,
): PersistedWorkflowSessionRefs {
  try {
    const parsed = JSON.parse(
      readFileSync(workflowSessionRefsPath(context), 'utf8'),
    ) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PersistedWorkflowSessionRefs)
      : {}
  } catch {
    return {}
  }
}

function writePersistedWorkflowSessionRefs(
  context: MatOSWorkflowToolContext,
  refs: PersistedWorkflowSessionRefs,
): void {
  try {
    const file = workflowSessionRefsPath(context)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, ...refs }, null, 2)}\n`)
  } catch {
    // Losing this cache should not make workflow authoring fail; it only
    // affects whether a later MCP call remembers newly published refs.
  }
}

export function persistedSessionWorkflowRefs(
  context: MatOSWorkflowToolContext,
): string[] {
  const refs = readPersistedWorkflowSessionRefs(context)
  const roles = refs.roles ?? {}
  return mergeWorkflowRefs(
    roles[workflowSessionRoleKey(context)],
    roles.__default__,
    ...Object.values(roles),
  )
}

export function effectiveSessionWorkflowRefs(
  context: MatOSWorkflowToolContext,
): string[] {
  return mergeWorkflowRefs(context.sessionWorkflowRefs, persistedSessionWorkflowRefs(context))
}

export function effectiveAllowedWorkflowRefs(
  context: MatOSWorkflowToolContext,
): string[] {
  return mergeWorkflowRefs(
    context.allowedWorkflowRefs,
    effectiveSessionWorkflowRefs(context),
    workflowAccessRestricted(context) ? projectLocalWorkflowRefs(context) : [],
  )
}

export function workflowAccessRestricted(
  context: MatOSWorkflowToolContext,
): boolean {
  return context.workflowAccessMode === 'role-mounted'
}

export function workflowRefAllowed(
  context: MatOSWorkflowToolContext,
  ref: string | undefined,
): boolean {
  const allowed = effectiveAllowedWorkflowRefs(context)
  if (!ref) {
    return true
  }
  // Drafts are authored inside this workspace (workflow_edit is not gated by
  // role-mounted access, and workflow_run action=start accepts a bare
  // draftId, bypassing the ref check). Denying `draft:` refs here made a
  // draft run start successfully and then become invisible and
  // uncontrollable to the very agent that started it: inspect/events/cancel
  // all resolve the run's workflowRef to `draft:<id>` and were rejected.
  // Role-mounted access restricts which *published* workflows may run; it is
  // not a data barrier within the workspace.
  if (ref.startsWith('draft:')) {
    return true
  }
  if (allowed.length === 0) {
    return !workflowAccessRestricted(context)
  }
  return allowed.some(candidate => workflowRefMatches(candidate, ref))
}

function projectLocalWorkflowRefs(context: MatOSWorkflowToolContext): string[] {
  const workflowsDir = join(getMatOSAssetsDir(context.cwd), 'workflows')
  try {
    return mergeWorkflowRefs(
      readdirSync(workflowsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          try {
            return workflowRefFromManifest(
              JSON.parse(
                readFileSync(join(workflowsDir, entry.name, 'asset.json'), 'utf8'),
              ) as unknown,
            )
          } catch {
            return undefined
          }
        })
        .filter((ref): ref is string => typeof ref === 'string'),
    )
  } catch {
    return []
  }
}

function projectLocalWorkflowRefExists(
  context: MatOSWorkflowToolContext,
  ref: string | undefined,
): boolean {
  const id = workflowIdFromRef(ref)
  if (!id) {
    return false
  }
  try {
    const manifestRef = workflowRefFromManifest(
      JSON.parse(
        readFileSync(
          join(getMatOSAssetsDir(context.cwd), 'workflows', id, 'asset.json'),
          'utf8',
        ),
      ) as unknown,
    )
    return Boolean(manifestRef && workflowRefMatches(manifestRef, ref ?? ''))
  } catch {
    return false
  }
}

export function rememberSessionWorkflowRef(
  context: MatOSWorkflowToolContext,
  ref: string | undefined,
): void {
  if (!ref) {
    return
  }
  const existing = effectiveSessionWorkflowRefs(context)
  if (existing.some(candidate => workflowRefMatches(candidate, ref))) {
    context.sessionWorkflowRefs = existing
    return
  }
  const next = mergeWorkflowRefs(existing, [ref])
  context.sessionWorkflowRefs = next
  const persisted = readPersistedWorkflowSessionRefs(context)
  const roleKey = workflowSessionRoleKey(context)
  const defaultRefs = mergeWorkflowRefs(persisted.roles?.__default__, [ref])
  writePersistedWorkflowSessionRefs(context, {
    ...persisted,
    roles: {
      ...(persisted.roles ?? {}),
      __default__: defaultRefs,
      [roleKey]: next,
    },
  })
}

export function rememberPublishedWorkflowResult(
  context: MatOSWorkflowToolContext,
  value: unknown,
): void {
  const published = metadataObject(metadataObject(value).published)
  rememberSessionWorkflowRef(context, optionalString(published.assetKey))
}

export function workflowRefDeniedMessage(
  context: MatOSWorkflowToolContext,
  ref: string,
): string {
  return [
    `Workflow ${ref} is not mounted on the selected role`,
    context.selectedRole ? ` (${context.selectedRole})` : '',
    '. Use workflow_query action=context to inspect mounted workflow refs, or attach the workflow to the role first.',
  ].join('')
}

function workflowRefFromRunListItem(item: unknown): string | undefined {
  const record = metadataObject(item)
  const snapshot = metadataObject(record.snapshot)
  const run = metadataObject(record.run)
  return optionalString(snapshot.workflowRef ?? run.workflowRef)
}

function workflowRefFromWorkflowListItem(item: unknown): string | undefined {
  const record = metadataObject(item)
  return (
    optionalString(record.canonicalKey) ??
    optionalString(record.workflowRef) ??
    optionalString(record.ref)
  )
}

function workflowRefSourceForContext(
  context: MatOSWorkflowToolContext,
  ref: string | undefined,
): 'session' | 'role-mounted' | 'project' | 'unrestricted' | 'denied' {
  if (!ref) {
    return workflowAccessRestricted(context) ? 'denied' : 'unrestricted'
  }
  if (effectiveSessionWorkflowRefs(context).some(candidate => workflowRefMatches(candidate, ref))) {
    return 'session'
  }
  if ((context.allowedWorkflowRefs ?? []).some(candidate => workflowRefMatches(candidate, ref))) {
    return 'role-mounted'
  }
  if (
    workflowAccessRestricted(context) &&
    projectLocalWorkflowRefExists(context, ref)
  ) {
    return 'project'
  }
  return workflowRefAllowed(context, ref) ? 'unrestricted' : 'denied'
}

function annotateWorkflowListItemForAccess(
  context: MatOSWorkflowToolContext,
  item: unknown,
): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return item
  }
  const record = item as Record<string, unknown>
  const ref = workflowRefFromWorkflowListItem(record)
  const kind = optionalString(record.kind)
  const allowedToRun = workflowRefAllowed(context, ref)
  const executable = !kind || kind === 'executable'
  return {
    ...record,
    executable,
    allowedToRun: allowedToRun && executable,
    workflowAccess: {
      allowed: allowedToRun,
      executable,
      source: workflowRefSourceForContext(context, ref),
    },
  }
}

export function filterWorkflowListForAllowedRefs(
  context: MatOSWorkflowToolContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(value.workflows)) {
    return value
  }
  if (
    !workflowAccessRestricted(context) &&
    effectiveAllowedWorkflowRefs(context).length === 0
  ) {
    const workflows = value.workflows.map(item => annotateWorkflowListItemForAccess(context, item))
    return {
      ...value,
      workflows,
      total: workflows.length,
    }
  }
  const workflows = value.workflows.filter(item =>
    workflowRefAllowed(context, workflowRefFromWorkflowListItem(item)),
  ).map(item => annotateWorkflowListItemForAccess(context, item))
  return {
    ...value,
    workflows,
    total: workflows.length,
  }
}

// Context budget for workflow list rows sent back to the model. Full rows
// (complete descriptions + provenance + lifecycle + access annotations)
// measured ~1.9KB each under role-mounted access, so a 30-workflow role paid
// 8-16K tokens per bare list call. Compact rows keep the call contract —
// ref, name, capped description, kind, readiness, run permission — and leave
// full rows behind detail=full.
const WORKFLOW_LIST_DEFAULT_LIMIT = 50
const WORKFLOW_LIST_MAX_LIMIT = 500
const WORKFLOW_LIST_DESCRIPTION_MAX_CHARS = 240
const WORKFLOW_LIST_COMPACT_FIELDS = [
  'canonicalKey',
  'name',
  'description',
  'kind',
  'readiness',
  'executable',
  'allowedToRun',
  'tags',
] as const

export type WorkflowListViewOptions = {
  detail?: string | undefined
  fields?: unknown
  limit?: unknown
  offset?: unknown
  query?: string | undefined
}

function workflowListFieldSelection(fields: unknown): string[] | undefined {
  const items = Array.isArray(fields)
    ? fields
    : typeof fields === 'string'
      ? fields.split(',')
      : []
  const selected = items
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
  return selected.length > 0 ? selected : undefined
}

function boundedListNumber(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  return Math.min(Math.floor(parsed), max)
}

function workflowListRowMatchesQuery(
  row: Record<string, unknown>,
  query: string,
): boolean {
  const haystacks = [
    row.id,
    row.name,
    row.canonicalKey,
    row.description,
    ...(Array.isArray(row.tags) ? row.tags : []),
  ]
  return haystacks.some(
    value =>
      typeof value === 'string' && value.toLowerCase().includes(query),
  )
}

function compactWorkflowListRow(
  row: Record<string, unknown>,
  fields: readonly string[],
  capDescription: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (!(field in row) || row[field] === undefined) {
      continue
    }
    let value = row[field]
    if (
      capDescription &&
      field === 'description' &&
      typeof value === 'string' &&
      value.length > WORKFLOW_LIST_DESCRIPTION_MAX_CHARS
    ) {
      value =
        value.slice(0, WORKFLOW_LIST_DESCRIPTION_MAX_CHARS - 1).trimEnd() + '…'
    }
    if (
      capDescription &&
      field === 'readiness' &&
      value &&
      typeof value === 'object' &&
      'status' in (value as Record<string, unknown>)
    ) {
      value = (value as Record<string, unknown>).status
    }
    out[field] = value
  }
  return out
}

/**
 * Apply query filtering, pagination, and compact row projection to a
 * workflow list result. Runs after access filtering/annotation so compact
 * rows still carry allowedToRun/executable.
 */
export function compactWorkflowListResult(
  value: Record<string, unknown>,
  options: WorkflowListViewOptions = {},
): Record<string, unknown> {
  if (!Array.isArray(value.workflows)) {
    return value
  }
  let rows = value.workflows.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  )
  const query = options.query?.trim().toLowerCase()
  if (query) {
    rows = rows.filter(row => workflowListRowMatchesQuery(row, query))
  }
  const total = rows.length
  const offset = boundedListNumber(options.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = boundedListNumber(
    options.limit,
    WORKFLOW_LIST_DEFAULT_LIMIT,
    WORKFLOW_LIST_MAX_LIMIT,
  )
  const page = rows.slice(offset, offset + limit)
  const detailFull = options.detail === 'full'
  const explicitFields = workflowListFieldSelection(options.fields)
  const projected =
    detailFull && !explicitFields
      ? page
      : page.map(row =>
          compactWorkflowListRow(
            row,
            explicitFields ?? WORKFLOW_LIST_COMPACT_FIELDS,
            !detailFull && !explicitFields,
          ),
        )
  return {
    ...value,
    workflows: projected,
    total,
    count: projected.length,
    offset,
    limit,
    hasMore: offset + page.length < total,
    ...(detailFull || explicitFields
      ? {}
      : {
          note:
            'Compact rows (capped descriptions). Use detail=full for complete rows, fields=... for explicit columns, offset/limit to paginate, query to filter.',
        }),
  }
}

// ---------------------------------------------------------------------------
// Run-view context compaction for agent tool results.
//
// Run views embed full node outputs and errors (exec stdout windows, agent
// transcripts, compute receipts). CLI/daemon consumers need that fidelity;
// an agent polling status/inspect between turns does not, and repeatedly
// paying tens of KB per call is exactly the "workflow state queries as
// context burden" failure mode. Compact rows keep everything an agent acts
// on (ids, statuses, attempts, timings, bounded error text, small outputs)
// and leave full payloads behind `detail=full` or per-node inspect.
// ---------------------------------------------------------------------------

const WORKFLOW_TOOL_STRING_HEAD_CHARS = 1_600
const WORKFLOW_TOOL_STRING_TAIL_CHARS = 200
const WORKFLOW_TOOL_ARRAY_MAX_ITEMS = 100
const WORKFLOW_TOOL_VALUE_MAX_DEPTH = 10
const WORKFLOW_TOOL_NODE_OUTPUT_INLINE_CHARS = 800
const WORKFLOW_TOOL_ERROR_SUMMARY_CHARS = 600
const WORKFLOW_TOOL_FRAMES_TAIL = 10

function truncateToolString(value: string): string {
  const max = WORKFLOW_TOOL_STRING_HEAD_CHARS + WORKFLOW_TOOL_STRING_TAIL_CHARS + 100
  if (value.length <= max) {
    return value
  }
  const omitted =
    value.length - WORKFLOW_TOOL_STRING_HEAD_CHARS - WORKFLOW_TOOL_STRING_TAIL_CHARS
  return `${value.slice(0, WORKFLOW_TOOL_STRING_HEAD_CHARS)}…[${omitted} chars omitted]…${value.slice(-WORKFLOW_TOOL_STRING_TAIL_CHARS)}`
}

export function compactWorkflowToolValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateToolString(value)
  }
  if (Array.isArray(value)) {
    if (depth >= WORKFLOW_TOOL_VALUE_MAX_DEPTH) {
      return `[array depth-capped: ${value.length} items]`
    }
    const items = value
      .slice(0, WORKFLOW_TOOL_ARRAY_MAX_ITEMS)
      .map(item => compactWorkflowToolValue(item, depth + 1))
    if (value.length > WORKFLOW_TOOL_ARRAY_MAX_ITEMS) {
      items.push(`…[${value.length - WORKFLOW_TOOL_ARRAY_MAX_ITEMS} more items]`)
    }
    return items
  }
  if (value && typeof value === 'object') {
    if (depth >= WORKFLOW_TOOL_VALUE_MAX_DEPTH) {
      return `[object depth-capped: ${Object.keys(value as object).length} keys]`
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        compactWorkflowToolValue(item, depth + 1),
      ]),
    )
  }
  return value
}

function workflowToolErrorSummary(error: unknown): unknown {
  if (error == null) {
    return undefined
  }
  if (typeof error === 'string') {
    return error.length > WORKFLOW_TOOL_ERROR_SUMMARY_CHARS
      ? `${error.slice(0, WORKFLOW_TOOL_ERROR_SUMMARY_CHARS)}…`
      : error
  }
  if (typeof error !== 'object' || Array.isArray(error)) {
    return error
  }
  const record = error as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : undefined
  const details = metadataObject(record.details)
  const keep: Record<string, unknown> = {}
  for (const key of ['code', 'exitCode', 'retryable', 'sameInputRetrySafe'] as const) {
    if (record[key] !== undefined) {
      keep[key] = record[key]
    }
  }
  for (const key of ['hint', 'action', 'category', 'signatureId'] as const) {
    if (typeof details[key] === 'string') {
      keep[key] = details[key]
    }
  }
  // Contract/validation failures carry their actionable detail in
  // failedChecks; dropping it left repair loops with only a generic message.
  if (Array.isArray(details.failedChecks) && details.failedChecks.length > 0) {
    const MAX_FAILED_CHECKS = 10
    keep.failedChecks = compactWorkflowToolValue(
      details.failedChecks.slice(0, MAX_FAILED_CHECKS),
    )
    if (details.failedChecks.length > MAX_FAILED_CHECKS) {
      keep.failedChecksTotal = details.failedChecks.length
    }
  }
  return {
    ...(message !== undefined
      ? {
          message:
            message.length > WORKFLOW_TOOL_ERROR_SUMMARY_CHARS
              ? `${message.slice(0, WORKFLOW_TOOL_ERROR_SUMMARY_CHARS)}…`
              : message,
        }
      : {}),
    ...keep,
  }
}

function compactWorkflowNodeRunForAgent(
  node: Record<string, unknown>,
  runId: string | undefined,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {}
  for (const key of [
    'nodeId',
    'status',
    'attempts',
    'startedAt',
    'finishedAt',
  ] as const) {
    if (node[key] !== undefined) {
      compact[key] = node[key]
    }
  }
  const sideEffect = metadataObject(node.sideEffect)
  if (typeof sideEffect.class === 'string') {
    compact.sideEffectClass = sideEffect.class
  }
  const errorSummary = workflowToolErrorSummary(node.error)
  if (errorSummary !== undefined) {
    compact.error = errorSummary
  }
  if (node.output !== undefined) {
    let serialized: string
    try {
      serialized = JSON.stringify(node.output) ?? ''
    } catch {
      serialized = String(node.output)
    }
    if (serialized.length <= WORKFLOW_TOOL_NODE_OUTPUT_INLINE_CHARS) {
      compact.output = node.output
    } else {
      compact.outputPreview = `${serialized.slice(0, WORKFLOW_TOOL_NODE_OUTPUT_INLINE_CHARS)}…`
      compact.outputChars = serialized.length
      compact.outputNote = `Full payload: workflow_run action=inspect runId=${runId ?? '<runId>'} nodeId=${String(node.nodeId ?? '<nodeId>')}`
    }
  }
  return compact
}

/**
 * Compact a WorkflowRunView for agent consumption. Structure, statuses,
 * diagnostics, budget, approvals, and guidance survive; bulky node payloads
 * are replaced with bounded previews plus a pointer to the per-node inspect.
 */
export function compactWorkflowRunViewForAgent(run: unknown): unknown {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return run
  }
  const view = run as Record<string, unknown>
  const runId = typeof view.runId === 'string' ? view.runId : undefined
  const compact: Record<string, unknown> = { ...view }
  if (Array.isArray(view.nodes)) {
    compact.nodes = view.nodes.map(node =>
      node && typeof node === 'object' && !Array.isArray(node)
        ? compactWorkflowNodeRunForAgent(node as Record<string, unknown>, runId)
        : node,
    )
  }
  if (view.outputs !== undefined) {
    compact.outputs = compactWorkflowToolValue(view.outputs)
  }
  if (view.diagnostics && typeof view.diagnostics === 'object') {
    const diagnostics = { ...(view.diagnostics as Record<string, unknown>) }
    if (Array.isArray(diagnostics.failedNodes)) {
      diagnostics.failedNodes = diagnostics.failedNodes.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return entry
        }
        const failed = entry as Record<string, unknown>
        const errorSummary = workflowToolErrorSummary(failed.error)
        return {
          ...failed,
          ...(errorSummary !== undefined ? { error: errorSummary } : {}),
        }
      })
    }
    compact.diagnostics = diagnostics
  }
  const stateMachine = metadataObject(view.stateMachine)
  if (Array.isArray(stateMachine.frames)) {
    const frames = stateMachine.frames
    compact.stateMachine = {
      ...stateMachine,
      totalFrames: frames.length,
      frames:
        frames.length > WORKFLOW_TOOL_FRAMES_TAIL
          ? frames.slice(-WORKFLOW_TOOL_FRAMES_TAIL)
          : frames,
      ...(frames.length > WORKFLOW_TOOL_FRAMES_TAIL
        ? { framesNote: `showing last ${WORKFLOW_TOOL_FRAMES_TAIL} of ${frames.length} frames` }
        : {}),
    }
  }
  return compact
}

/**
 * Compact every run view inside a tool payload (`run`, `runs`) unless the
 * caller asked for full detail. Non-run fields pass through untouched.
 */
export function compactWorkflowRunEnvelopeForAgent<
  T extends Record<string, unknown>,
>(payload: T, options: { detail?: unknown } = {}): Record<string, unknown> {
  if (options.detail === 'full') {
    return payload
  }
  const compact: Record<string, unknown> = { ...payload }
  if (compact.run !== undefined) {
    compact.run = compactWorkflowRunViewForAgent(compact.run)
  }
  if (Array.isArray(compact.runs)) {
    compact.runs = compact.runs.map(item => compactWorkflowRunViewForAgent(item))
  }
  return compact
}

export function filterWorkflowRunListForAllowedRefs(
  context: MatOSWorkflowToolContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !workflowAccessRestricted(context) &&
    effectiveAllowedWorkflowRefs(context).length === 0
  ) {
    return value
  }
  if (!Array.isArray(value.runs)) {
    return value
  }
  const runs = value.runs.filter(item => workflowRefAllowed(context, workflowRefFromRunListItem(item)))
  const summary = metadataObject(value.summary)
  const dropped = value.runs.length - runs.length
  return {
    ...value,
    runs,
    summary: {
      ...summary,
      count: runs.length,
      // `total` is the service's post-access-filter row count (callers pass
      // refAllowed to listRuns); rewriting it to the page size broke paging
      // math. Only annotate when this defense-in-depth filter still dropped
      // rows the service did not exclude.
      ...(dropped > 0 ? { accessFiltered: dropped } : {}),
    },
  }
}

export async function workflowRunDeniedMessage(input: {
  context: MatOSWorkflowToolContext
  scopeRef?: string
  runId: string
}): Promise<string | undefined> {
  if (
    !workflowAccessRestricted(input.context) &&
    effectiveAllowedWorkflowRefs(input.context).length === 0
  ) {
    return undefined
  }
  const list = await matOSWorkflowService.listRuns({
    cwd: input.context.cwd,
    scopeRef: input.scopeRef,
    query: input.runId,
    limit: 500,
    offset: 0,
    // Access checks only need runId/workflowRef from the snapshot; a full
    // per-row inspect turned every gated run action into 500 inspects.
    detail: 'summary',
  })
  const match = list.runs.find(
    item => item.snapshot.runId === input.runId || item.run.runId === input.runId,
  )
  if (!match) {
    // A wrong or truncated run id is a lookup miss, not an access denial.
    // Reporting it as a role-mount problem sends agents into role/mount
    // debugging; instead say not-found and suggest close ids when available.
    const candidates = list.runs
      .map(item => item.snapshot.runId || item.run.runId)
      .filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.length > 0 &&
          id !== input.runId &&
          (id.startsWith(input.runId) || input.runId.startsWith(id)),
      )
      .slice(0, 3)
    return [
      `Workflow run "${input.runId}" was not found`,
      candidates.length > 0 ? ` — did you mean: ${candidates.join(', ')}?` : '.',
      ' Use workflow_query action=runs to list recent runs with exact run ids.',
    ].join('')
  }
  const workflowRef = workflowRefFromRunListItem(match)
  if (workflowRef && workflowRefAllowed(input.context, workflowRef)) {
    return undefined
  }
  return workflowRefDeniedMessage(input.context, workflowRef ?? input.runId)
}

export function filterWorkflowTriggerListForAllowedRefs(
  context: MatOSWorkflowToolContext,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !workflowAccessRestricted(context) &&
    effectiveAllowedWorkflowRefs(context).length === 0
  ) {
    return value
  }
  if (!Array.isArray(value.triggers)) {
    return value
  }
  const triggers = value.triggers.filter(trigger => {
    const ref = optionalString(metadataObject(trigger).workflowRef)
    return workflowRefAllowed(context, ref)
  })
  return {
    ...value,
    triggers,
    total: triggers.length,
  }
}

export function workflowTriggerDeniedMessage(
  context: MatOSWorkflowToolContext,
  value: Record<string, unknown>,
): string | undefined {
  if (
    !workflowAccessRestricted(context) &&
    effectiveAllowedWorkflowRefs(context).length === 0
  ) {
    return undefined
  }
  const workflowRef =
    optionalString(value.workflowRef) ??
    optionalString(metadataObject(value.trigger).workflowRef)
  if (!workflowRef && workflowAccessRestricted(context)) {
    return workflowRefDeniedMessage(context, 'unknown workflow trigger')
  }
  if (!workflowRef || workflowRefAllowed(context, workflowRef)) {
    return undefined
  }
  return workflowRefDeniedMessage(context, workflowRef)
}

export function parseResponse(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const WORKFLOW_NATIVE_GUARD_CHECK_TYPES = new Set<
  MatOSWorkflowGuardCheck['type']
>([
  'expression',
  'file_exists',
  'file_size',
  'grep',
  'regex',
  'numeric_range',
  'json_schema',
])

function normalizeGuardCheckType(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_')
}

function normalizeWorkflowAuthoringString(value: string): string {
  return value
    .replace(/\$\{\s*(?:workspace|MATOS_WORKSPACE_DIR)\s*\}/g, '{{ workflow.workspaceDir }}')
    .replace(
      /\$\{\s*nodes?\.([A-Za-z0-9_-]+)\.outputs(?:\.([A-Za-z0-9_.-]+))?\s*\}/g,
      (_match, nodeId: string, path: string | undefined) =>
        `{{ nodes.${nodeId}.outputs${path ? `.${path}` : ''} }}`,
    )
    .replace(
      /\$\{\s*nodes?\.([A-Za-z0-9_-]+)\.status\s*\}/g,
      (_match, nodeId: string) => `{{ nodes.${nodeId}.status }}`,
    )
}

function normalizeWorkflowAuthoringAliases(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeWorkflowAuthoringString(value)
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeWorkflowAuthoringAliases(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeWorkflowAuthoringAliases(item),
      ]),
    )
  }
  return value
}

function checkWithType(
  value: Record<string, unknown>,
  type: MatOSWorkflowGuardCheck['type'],
): MatOSWorkflowGuardCheck {
  const normalized: Record<string, unknown> = { ...value, type }
  delete normalized.check
  return normalized as MatOSWorkflowGuardCheck
}

function normalizeNativeGuardCheck(
  value: Record<string, unknown>,
  type: MatOSWorkflowGuardCheck['type'],
): MatOSWorkflowGuardCheck {
  const normalized = checkWithType(value, type)
  if (type === 'file_exists' || type === 'file_size') {
    normalized.path =
      optionalString(normalized.path) ?? optionalString(normalized.value)
  } else if (type === 'grep') {
    normalized.pattern =
      optionalString(normalized.pattern) ??
      optionalString(value.expect) ??
      optionalString(value.expected) ??
      optionalString(normalized.value)
  } else if (type === 'regex') {
    normalized.pattern =
      optionalString(normalized.pattern) ??
      optionalString(value.expect) ??
      optionalString(value.expected)
  } else if (type === 'expression') {
    normalized.value =
      optionalString(normalized.value) ?? optionalString(value.expression)
    delete normalized.expression
  }
  return normalized
}

function normalizeStdoutGuardCheck(
  value: Record<string, unknown>,
  dependsOn: string[],
  negate: boolean,
): MatOSWorkflowGuardCheck {
  const marker = value.expect ?? value.expected ?? value.pattern ?? value.value
  const sourceNode =
    optionalString(value.nodeId) ??
    optionalString(value.sourceNodeId) ??
    optionalString(value.source) ??
    optionalString(value.from) ??
    dependsOn[dependsOn.length - 1]
  const normalized = checkWithType(value, 'expression')
  if (sourceNode && marker !== undefined) {
    normalized.value = [
      `{{ nodes.${sourceNode}.outputs.stdout }}`,
      negate ? 'not contains' : 'contains',
      JSON.stringify(String(marker)),
    ].join(' ')
  }
  delete normalized.expect
  delete normalized.expected
  delete normalized.pattern
  delete normalized.nodeId
  delete normalized.sourceNodeId
  delete normalized.source
  delete normalized.from
  return normalized
}

function normalizeGuardCheckInput(
  value: unknown,
  dependsOn: string[],
): MatOSWorkflowGuardCheck | undefined {
  const check = metadataObject(value)
  const rawType = optionalString(check.type) ?? optionalString(check.check)
  if (!rawType) {
    return undefined
  }
  const normalizedType = normalizeGuardCheckType(rawType)
  if (
    WORKFLOW_NATIVE_GUARD_CHECK_TYPES.has(
      normalizedType as MatOSWorkflowGuardCheck['type'],
    )
  ) {
    return normalizeNativeGuardCheck(
      check,
      normalizedType as MatOSWorkflowGuardCheck['type'],
    )
  }
  if (
    normalizedType === 'stdout_contains' ||
    normalizedType === 'stdout_include' ||
    normalizedType === 'stdout_includes'
  ) {
    return normalizeStdoutGuardCheck(check, dependsOn, false)
  }
  if (
    normalizedType === 'stdout_not_contains' ||
    normalizedType === 'stdout_excludes'
  ) {
    return normalizeStdoutGuardCheck(check, dependsOn, true)
  }
  return undefined
}

function normalizeGuardChecksInput(
  value: unknown,
  dependsOn: string[],
): MatOSWorkflowGuardCheck[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  // Keep unrecognized entries instead of silently dropping them: a dropped
  // check either weakens the guard the agent thought it authored or turns a
  // fixable "unsupported check type" into a baffling "requires checks".
  const checks = value
    .map(
      check =>
        normalizeGuardCheckInput(check, dependsOn) ??
        (metadataObject(check) as MatOSWorkflowGuardCheck),
    )
    .filter(check => Object.keys(check).length > 0)
  return checks.length > 0 ? checks : undefined
}

export function workflowNodeFromInput(value: unknown): MatOSWorkflowNode | undefined {
  const node = metadataObject(normalizeWorkflowAuthoringAliases(value))
  const id = optionalString(node.id)
  const type = optionalString(node.type)
  if (!id || !type) {
    return undefined
  }
  const manifest = workflowNodeManifestForType(type)
  const runtimeType = (
    optionalString(node.runtimeType) ?? manifest?.runtimeType
  ) as MatOSWorkflowNode['runtimeType'] | undefined
  const targetType = (
    optionalString(node.targetType) ?? manifest?.targetType
  ) as MatOSWorkflowNode['targetType'] | undefined
  const dependsOn = Array.isArray(node.dependsOn)
    ? node.dependsOn.filter(
        (dependency): dependency is string => typeof dependency === 'string',
      )
    : []
  const checks =
    type === 'guard' ? normalizeGuardChecksInput(node.checks, dependsOn) : undefined
  return {
    ...node,
    id,
    type: type as MatOSWorkflowNode['type'],
    runtimeType,
    targetType,
    matosProduct: {
      ...metadataObject(node.matosProduct),
      ...(targetType ? { semanticType: targetType } : {}),
      ...(runtimeType ? { runtimeType } : {}),
      ...(manifest?.type ? { manifestType: manifest.type } : {}),
      source: 'workflow-tool-input',
    },
    dependsOn,
    ...(checks ? { checks } : {}),
  }
}

export function workflowManifestNodeFromInput(input: {
  id?: string
  nodeType?: string
  fields?: unknown
  dependsOn?: unknown
}): { node?: MatOSWorkflowNode; error?: string } {
  const nodeType = optionalString(input.nodeType)
  if (!nodeType) {
    return { error: 'manifest node requires nodeType' }
  }
  const manifest = workflowNodeManifestForType(nodeType)
  if (!manifest) {
    return { error: `Unknown workflow node manifest: ${nodeType}` }
  }
  const fields = metadataObject(input.fields)
  const missing = manifest.fields
    .filter(field => field.required)
    .map(field => field.key)
    .filter(field => {
    if (field === 'id' || field === 'type') {
      return false
    }
    return fields[field] === undefined || fields[field] === null || fields[field] === ''
    })
  if (missing.length) {
    return {
      error: `workflow manifest node ${nodeType} is missing required fields: ${missing.join(', ')}`,
    }
  }
  const id =
    input.id ??
    optionalString(fields.id) ??
    `${nodeType.replace(/[^A-Za-z0-9_]/g, '_')}_${Date.now()}`
  const node = workflowNodeFromInput({
    ...Object.fromEntries(
      manifest.fields
        .filter(field => field.default !== undefined)
        .map(field => [field.key, field.default]),
    ),
    ...fields,
    id,
    type: nodeType,
    dependsOn: Array.isArray(input.dependsOn)
      ? input.dependsOn.filter(
          (dependency): dependency is string => typeof dependency === 'string',
        )
      : Array.isArray(fields.dependsOn)
        ? fields.dependsOn.filter(
            (dependency): dependency is string => typeof dependency === 'string',
          )
        : [],
  })
  return node ? { node } : { error: `Invalid workflow manifest node: ${nodeType}` }
}

export function workflowOutputsFromInput(
  value: unknown,
): MatOSWorkflowDefinition['outputs'] | undefined {
  const outputs = metadataObject(value)
  return outputs as MatOSWorkflowDefinition['outputs']
}

export function workflowParametersFromInput(
  value: unknown,
): MatOSWorkflowDefinition['parameters'] | undefined {
  const raw = metadataObject(value)
  const parameters: Record<string, MatOSWorkflowParameter> = {}
  for (const [key, parameter] of Object.entries(raw)) {
    if (!key.trim()) {
      continue
    }
    if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter)) {
      return undefined
    }
    parameters[key] = parameter as MatOSWorkflowParameter
  }
  return parameters
}

export function workflowDefinitionFromInput(
  value: unknown,
): MatOSWorkflowDefinition | undefined {
  const definition = metadataObject(value)
  return Object.keys(definition).length > 0
    ? (definition as MatOSWorkflowDefinition)
    : undefined
}

export function workflowTransitionFromInput(
  value: unknown,
): MatOSWorkflowTransitionEdge | undefined {
  const transition = metadataObject(value)
  const from = optionalString(transition.from)
  const to = optionalString(transition.to)
  if (!from || !to) {
    return undefined
  }
  return {
    ...transition,
    from,
    to,
  } as MatOSWorkflowTransitionEdge
}

export function workflowRunFiltersFromInput(
  raw: Record<string, unknown>,
): MatOSWorkflowRunFilters {
  const nested = metadataObject(raw.filter ?? raw.filters)
  const source = optionalString(nested.source ?? raw.source)
  const filter: MatOSWorkflowRunFilters = {
    workflowRef: optionalString(nested.workflowRef ?? raw.workflowRef ?? raw.ref),
    status: optionalString(nested.status ?? raw.status),
    traceId: optionalString(nested.traceId ?? raw.traceId),
    sessionId: optionalString(nested.sessionId ?? raw.sessionId),
    triggerId: optionalString(nested.triggerId ?? raw.triggerId),
    updatedAfter: optionalString(nested.updatedAfter ?? raw.updatedAfter),
    updatedBefore: optionalString(nested.updatedBefore ?? raw.updatedBefore),
  }
  if (
    source === 'manual' ||
    source === 'agent_tool' ||
    source === 'trigger' ||
    source === 'workflow' ||
    source === 'scheduler' ||
    source === 'replay' ||
    source === 'unknown'
  ) {
    filter.source = source
  }
  return filter
}

export function workflowRunProvenanceFromInput(
  value: unknown,
  fallbackSource: MatOSWorkflowRunProvenance['source'],
): MatOSWorkflowRunProvenance {
  const provenance = metadataObject(value)
  const source = optionalString(provenance.source)
  const normalizedSource =
    source === 'manual' ||
    source === 'agent_tool' ||
    source === 'trigger' ||
    source === 'workflow' ||
    source === 'scheduler' ||
    source === 'replay' ||
    source === 'unknown'
      ? source
      : fallbackSource
  return {
    source: normalizedSource,
    triggerId: optionalString(provenance.triggerId),
    triggerEventId: optionalString(provenance.triggerEventId),
    triggerAppId: optionalString(provenance.triggerAppId),
    payloadDigest: optionalString(provenance.payloadDigest),
    schedulerTickId: optionalString(provenance.schedulerTickId),
    parentRunId: optionalString(provenance.parentRunId),
    parentWorkflowRef: optionalString(provenance.parentWorkflowRef),
    reason: optionalString(provenance.reason),
    ...(typeof provenance.firedAt === 'number' && Number.isFinite(provenance.firedAt)
      ? { firedAt: provenance.firedAt }
      : {}),
    ...(Object.keys(metadataObject(provenance.metadata)).length
      ? { metadata: metadataObject(provenance.metadata) }
      : {}),
  }
}

export const WORKFLOW_RUNTIME_NODE_TYPES = MATOS_WORKFLOW_RUNTIME_NODE_TYPES

export const WORKFLOW_SEMANTIC_NODE_TYPES = MATOS_WORKFLOW_SEMANTIC_NODE_TYPES

export const WORKFLOW_NODE_MANIFEST_SUMMARIES = MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES.map(
  manifest => ({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    type: manifest.type,
    title: manifest.title,
    description: manifest.description,
    display: manifest.display,
    semanticType: manifest.semanticType,
    category: manifest.category,
    runtimeType: manifest.runtimeType,
    targetType: manifest.targetType,
    cozeNodeType: manifest.cozeNodeType,
    cozeAdapter: manifest.cozeAdapter,
    iconKey: manifest.iconKey,
    palette: manifest.palette,
    advanced: manifest.advanced === true,
    requiredFields: manifest.fields
      .filter(field => field.required)
      .map(field => field.key),
    ports: manifest.ports,
    policyDefaults: manifest.policyDefaults,
    debug: manifest.debug,
    fields: manifest.fields.map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required === true,
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.assetTypes ? { assetTypes: field.assetTypes } : {}),
    })),
    form: manifest.form,
    variables: manifest.variables,
    contracts: manifest.contracts,
    compile: manifest.compile,
    matosProduct: manifest.matosProduct,
  }),
)
