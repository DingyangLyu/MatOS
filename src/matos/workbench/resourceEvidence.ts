import type { MatOSAsset } from '../assets/types.js'
import { listMatOSDirectAssetEditorRuns } from '../learning/directAssetEditor.js'
import { matOSWorkflowService } from '../workflows/workflowService.js'
import { listMatOSWorkbenchTraces } from './traces.js'
import type { MatOSWorkbenchResource } from './types.js'
import { workflowTraceRefsFromRunAndEvents } from './workflowTraceRefs.js'

export type MatOSWorkbenchResourceRelatedEvidence = {
  workflowRuns: unknown[]
  traces: unknown[]
  evolutionRecords: unknown[]
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function unknownArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value
    }
  }
  return []
}

function stringArray(...values: unknown[]): string[] {
  return unknownArray(...values)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
}

function mergedStringArray(...values: unknown[]): string[] {
  return values
    .flatMap(value => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
    .filter((value, index, array) => array.indexOf(value) === index)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return undefined
}

function normalizeRefForMatch(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref.trim()) {
    return undefined
  }
  const trimmed = ref.trim()
  const colon = trimmed.indexOf(':')
  const at = trimmed.lastIndexOf('@')
  if (colon >= 0 && at > colon) {
    return trimmed.slice(0, at)
  }
  return trimmed
}

function resourceRefAliases(asset: MatOSAsset, resource: MatOSWorkbenchResource): Set<string> {
  return new Set(
    [
      asset.canonicalKey,
      resource.ref,
      `${asset.type}:${asset.id}`,
      normalizeRefForMatch(asset.canonicalKey),
      normalizeRefForMatch(resource.ref),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  )
}

function refMatchesAliases(ref: unknown, aliases: Set<string>): boolean {
  if (typeof ref !== 'string' || !ref.trim()) {
    return false
  }
  return aliases.has(ref.trim()) || aliases.has(normalizeRefForMatch(ref) ?? '')
}

function traceMatchesResource(trace: unknown, aliases: Set<string>): boolean {
  const record = objectRecord(trace)
  if (refMatchesAliases(record.roleRef, aliases)) {
    return true
  }
  if (refMatchesAliases(`trace:${firstString(record.traceId) ?? ''}`, aliases)) {
    return true
  }
  return stringArray(record.sessionIds).some(sessionId => refMatchesAliases(`trace:${sessionId}`, aliases))
}

function workflowRunTraceContexts(item: unknown): unknown[] {
  const record = objectRecord(item)
  const run = objectRecord(record.run)
  const snapshot = objectRecord(record.snapshot)
  const events = unknownArray(record.events)
  return [
    run,
    run.trace,
    snapshot,
    snapshot.trace,
    ...events.flatMap(event => {
      const eventRecord = objectRecord(event)
      return [eventRecord, eventRecord.trace]
    }),
  ]
}

function workflowRunMatchesResource(item: unknown, aliases: Set<string>): boolean {
  const record = objectRecord(item)
  const run = objectRecord(record.run)
  const snapshot = objectRecord(record.snapshot)
  const directMatch = [
    run.workflowRef,
    snapshot.workflowRef,
    firstString(run.runId) ? `workflow-run:${firstString(run.runId)}` : undefined,
    firstString(snapshot.runId) ? `workflow-run:${firstString(snapshot.runId)}` : undefined,
  ].some(ref => refMatchesAliases(ref, aliases))
  if (directMatch) {
    return true
  }
  return workflowRunTraceContexts(item).some(trace =>
    traceMatchesResource(trace, aliases),
  )
}

function summarizeWorkflowRun(item: unknown): Record<string, unknown> {
  const record = objectRecord(item)
  const run = objectRecord(record.run)
  const snapshot = objectRecord(record.snapshot)
  const events = unknownArray(record.events)
  const runId = firstString(run.runId, snapshot.runId)
  return {
    kind: 'workflow-run',
    ...(runId ? { id: `workflow-run:${runId}`, runId } : {}),
    ...(firstString(run.workflowRef, snapshot.workflowRef)
      ? { workflowRef: firstString(run.workflowRef, snapshot.workflowRef) }
      : {}),
    ...(firstString(run.status, snapshot.status) ? { status: firstString(run.status, snapshot.status) } : {}),
    ...(firstString(run.createdAt, snapshot.createdAt) ? { createdAt: firstString(run.createdAt, snapshot.createdAt) } : {}),
    ...(firstString(run.updatedAt, snapshot.updatedAt) ? { updatedAt: firstString(run.updatedAt, snapshot.updatedAt) } : {}),
    eventCount: events.length,
    traceRefs: workflowTraceRefsFromRunAndEvents(run, events, snapshot),
  }
}

function directEditorRunMatchesResource(run: unknown, aliases: Set<string>): boolean {
  const record = objectRecord(run)
  const editorOutput = objectRecord(record.editorOutput)
  return [
    ...mergedStringArray(record.createdAssets, editorOutput.createdAssets),
    ...mergedStringArray(record.updatedAssets, editorOutput.updatedAssets),
    ...mergedStringArray(record.disabledAssets, editorOutput.disabledAssets),
    ...mergedStringArray(record.evidenceRefs, editorOutput.evidenceRefs),
  ].some(ref => refMatchesAliases(ref, aliases))
}

function summarizeDirectEditorRun(run: unknown): Record<string, unknown> {
  const record = objectRecord(run)
  const editorOutput = objectRecord(record.editorOutput)
  const runId = firstString(record.runId)
  return {
    kind: 'direct-editor-run',
    ...(runId ? { id: `direct-editor-run:${runId}`, runId } : {}),
    ...(firstString(record.status) ? { status: firstString(record.status) } : {}),
    ...(firstString(record.createdAt) ? { createdAt: firstString(record.createdAt) } : {}),
    ...(firstString(record.updatedAt) ? { updatedAt: firstString(record.updatedAt) } : {}),
    summary: firstString(editorOutput.summary),
    changedAssets: {
      created: mergedStringArray(record.createdAssets, editorOutput.createdAssets),
      updated: mergedStringArray(record.updatedAssets, editorOutput.updatedAssets),
      disabled: mergedStringArray(record.disabledAssets, editorOutput.disabledAssets),
    },
    evidenceRefs: mergedStringArray(record.evidenceRefs, editorOutput.evidenceRefs),
    gates: {
      validation: objectRecord(record.validation),
      semanticAcceptance: objectRecord(record.semanticAcceptance),
    },
    ...(firstString(record.diffPatchPath) ? { diffPatchPath: firstString(record.diffPatchPath) } : {}),
    ...(firstString(record.beforeSnapshot) ? { beforeSnapshot: firstString(record.beforeSnapshot) } : {}),
    ...(firstString(record.afterSnapshot) ? { afterSnapshot: firstString(record.afterSnapshot) } : {}),
    ...(firstString(record.rollbackSnapshot) ? { rollbackSnapshot: firstString(record.rollbackSnapshot) } : {}),
  }
}

export async function buildMatOSWorkbenchRelatedEvidence(input: {
  cwd: string
  scopeRef?: string
  asset: MatOSAsset
  resource: MatOSWorkbenchResource
  includeHidden?: boolean
}): Promise<MatOSWorkbenchResourceRelatedEvidence> {
  const aliases = resourceRefAliases(input.asset, input.resource)
  const [traceList, workflowRunList, directEditorRuns] = await Promise.all([
    listMatOSWorkbenchTraces({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      includeHidden: input.includeHidden,
      limit: 200,
    }).catch(() => ({ traces: [] })),
    matOSWorkflowService.listRuns({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      limit: 200,
    }).catch(() => ({ runs: [] })),
    listMatOSDirectAssetEditorRuns(input.cwd).catch(() => []),
  ])
  return {
    traces: unknownArray(objectRecord(traceList).traces)
      .filter(trace => traceMatchesResource(trace, aliases)),
    workflowRuns: unknownArray(objectRecord(workflowRunList).runs)
      .filter(run => workflowRunMatchesResource(run, aliases))
      .map(summarizeWorkflowRun),
    evolutionRecords: unknownArray(directEditorRuns)
      .filter(run => directEditorRunMatchesResource(run, aliases))
      .map(summarizeDirectEditorRun),
  }
}
