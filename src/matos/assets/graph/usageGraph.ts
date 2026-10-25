import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMatOSDir, readMatOSProjectConfig } from '../../project.js'
import { observedAssetKey } from './historicalReferences.js'
import { archiveScopeAllowed, archiveSourceAllowed, isScopedAssetArchiveCaller, archiveOwnerScopeRef } from '../history/archive.js'
import { readIndexedUsageEvents } from './incrementalEvents.js'
import { parseMatOSAssetReference } from '../refs.js'
import { listMatOSAssetHistorySnapshots } from '../history/records.js'
import { shouldHideInternalAssetSource } from '../sourceVisibility.js'
import type { MatOSEvent, MatOSSessionSummary } from '../../sessions/eventTypes.js'
import type {
  MatOSWorkflowEvent,
  MatOSWorkflowRunSnapshot,
} from '../../workflows/types.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphNode,
  MatOSAssetGraphProvider,
  MatOSAssetGraphProviderContext,
  MatOSAssetGraphProviderResult,
} from './types.js'

type AssetUsageAggregate = {
  usageCount: number
  traceIds: Set<string>
  sessionIds: Set<string>
  workflowRunIds: Set<string>
  lastUsedAt?: string
}

type SessionUsageEdgeAggregate = {
  count: number
  evidenceRefs: Set<string>
  latestAt?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function assetReferenceCandidates(event: MatOSEvent): string[] {
  const data = event.data ?? {}
  const refs = [
    optionalString(data.assetKey),
    optionalString(data.reference),
    optionalString(data.ref),
    optionalString(data.role),
    optionalString(data.selectedRole),
    ...stringArray(data.assetKeys),
    ...stringArray(data.selectedAssetKeys),
    ...stringArray(data.refs),
  ].filter((item): item is string => Boolean(item))
  return refs.filter(reference => {
    const parsed = parseMatOSAssetReference(reference)
    return parsed.version || !refs.some(other => {
      const precise = parseMatOSAssetReference(other)
      return precise.version && precise.id === parsed.id && (!parsed.type || precise.type === parsed.type)
    })
  })
}

function ensureAggregate(
  aggregates: Map<string, AssetUsageAggregate>,
  assetKey: string,
): AssetUsageAggregate {
  const existing = aggregates.get(assetKey)
  if (existing) {
    return existing
  }
  const next: AssetUsageAggregate = {
    usageCount: 0,
    traceIds: new Set(),
    sessionIds: new Set(),
    workflowRunIds: new Set(),
  }
  aggregates.set(assetKey, next)
  return next
}

function traceNodeForSession(
  session: MatOSSessionSummary,
  usageCount: number,
): MatOSAssetGraphNode | undefined {
  const traceId = session.traceId ?? session.sessionId
  if (!traceId) {
    return undefined
  }
  return {
    id: `trace:${traceId}`,
    kind: 'trace',
    label: traceId,
    reference: traceId,
    createdAt: session.startedAt,
    metadata: {
      lastEventAt: session.lastEventAt,
      status: session.status,
      roleRef: session.roleRef,
      sessionCount: 1,
      usageCount,
    },
  }
}

function usageAssetNode(
  context: MatOSAssetGraphProviderContext,
  assetKey: string,
  aggregate: AssetUsageAggregate,
): MatOSAssetGraphNode | undefined {
  const asset = context.registry.resolve(assetKey)
  if (!asset) {
    return undefined
  }
  return {
    id: asset.canonicalKey,
    kind: 'asset',
    label: asset.name || asset.canonicalKey,
    canonicalKey: asset.canonicalKey,
    assetType: asset.type,
    metadata: {
      usage: {
        count: aggregate.usageCount,
        traceCount: aggregate.traceIds.size,
        sessionCount: aggregate.sessionIds.size,
        ...(aggregate.workflowRunIds.size > 0
          ? { workflowRunCount: aggregate.workflowRunIds.size }
          : {}),
        lastUsedAt: aggregate.lastUsedAt,
      },
    },
  }
}

export function matOSUsageWorkflowRunsDirs(cwd: string): string[] {
  return [
    process.env.MATOS_WORKFLOW_RUNS_DIR?.trim(),
    join(getMatOSDir(cwd), 'workflows', 'runs'),
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
}

export function matOSUsageSessionDirs(cwd: string): string[] {
  return [
    process.env.MATOS_SESSION_DIR?.trim(),
    join(getMatOSDir(cwd), 'sessions'),
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
}

type WorkflowRunUsageRecord = {
  runDir: string
  run: MatOSWorkflowRunSnapshot
  events: MatOSWorkflowEvent[]
  graphSnapshot?: unknown
  childWorkflowRefs: string[]
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function parseWorkflowEvents(raw: string): MatOSWorkflowEvent[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as MatOSWorkflowEvent)
}

function parseSessionEvents(raw: string): MatOSEvent[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as MatOSEvent)
}

function sessionSummaryFromEvents(input: {
  sessionId: string
  path: string
  events: MatOSEvent[]
}): MatOSSessionSummary {
  const first = input.events[0]
  const last = input.events.at(-1)
  const firstData = first?.data ?? {}
  const lastData = last?.data ?? {}
  return {
    sessionId: input.sessionId,
    path: input.path,
    traceId:
      optionalString(first?.traceId) ??
      optionalString(firstData.traceId) ??
      input.sessionId,
    userId: optionalString(first?.userId) ?? optionalString(firstData.userId),
    scopeRef: optionalString(first?.scopeRef) ?? optionalString(firstData.scopeRef),
    workspaceId:
      optionalString(first?.workspaceId) ?? optionalString(firstData.workspaceId),
    runtimeRef:
      optionalString(first?.runtimeRef) ?? optionalString(firstData.runtimeRef),
    execution:
      optionalString(first?.execution) ?? optionalString(firstData.execution),
    roleRef: optionalString(first?.roleRef) ?? optionalString(firstData.roleRef),
    command: optionalString(firstData.command),
    cwd: optionalString(firstData.cwd),
    startedAt: first?.timestamp,
    lastEventAt: last?.timestamp,
    lastEventType: last?.type,
    eventCount: input.events.length,
    turnCount: input.events.filter(event => event.type === 'matos.turn.started')
      .length,
    assetCount: input.events.filter(event => event.type === 'matos.asset.loaded')
      .length,
    assetUsageCount: input.events.filter(event => event.type === 'matos.asset.used')
      .length,
    toolCallCount: input.events.filter(event =>
      event.type === 'matos.tool.call.started' ||
      event.type === 'matos.tool.call.completed',
    ).length,
    status: input.events.some(event => event.type === 'matos.session.failed')
      ? 'failed'
      : input.events.some(event => event.type === 'matos.session.completed')
        ? 'completed'
        : input.events.length > 0
          ? 'running'
          : undefined,
    hidden:
      firstData.hidden === true && firstData.userVisible === false,
    totalCostUsd:
      optionalNumber(lastData.totalCostUsd) ?? optionalNumber(firstData.totalCostUsd),
    durationMs:
      optionalNumber(lastData.durationMs) ?? optionalNumber(firstData.durationMs),
    numTurns:
      optionalNumber(lastData.numTurns) ?? optionalNumber(firstData.numTurns),
  }
}

async function listUsageSessions(
  cwd: string,
): Promise<{
  sessions: MatOSSessionSummary[]
  eventsByPath: Map<string, MatOSEvent[]>
  issues: MatOSAssetGraphProviderResult['issues']
}> {
  const sessions: MatOSSessionSummary[] = []
  const eventsByPath = new Map<string, MatOSEvent[]>()
  const issues: MatOSAssetGraphProviderResult['issues'] = []
  for (const dir of matOSUsageSessionDirs(cwd)) {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue
      }
      const path = join(dir, entry.name)
      const sessionId = entry.name.slice(0, -'.jsonl'.length)
      if (eventsByPath.has(path)) {
        continue
      }
      try {
        const { events } = await readIndexedUsageEvents<MatOSEvent>(cwd, path)
        sessions.push(sessionSummaryFromEvents({ sessionId, path, events }))
        eventsByPath.set(path, events)
      } catch (error) {
        issues.push({
          code: 'invalid_usage_session_record',
          message: `${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'warning',
        })
      }
    }
  }

  return {
    sessions: sessions.sort((a, b) =>
      (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''),
    ),
    eventsByPath,
    issues,
  }
}

async function listWorkflowRunUsageRecords(
  cwd: string,
): Promise<{
  records: WorkflowRunUsageRecord[]
  issues: MatOSAssetGraphProviderResult['issues']
}> {
  const records: WorkflowRunUsageRecord[] = []
  const issues: MatOSAssetGraphProviderResult['issues'] = []
  const seenRunDirs = new Set<string>()
  for (const runsDir of matOSUsageWorkflowRunsDirs(cwd)) {
    let entries: string[]
    try {
      entries = await readdir(runsDir)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      const runDir = join(runsDir, entry)
      if (seenRunDirs.has(runDir)) {
        continue
      }
      seenRunDirs.add(runDir)
      try {
        const run = await readJsonFile<MatOSWorkflowRunSnapshot>(
          join(runDir, 'run.json'),
        )
        const { events } = await readIndexedUsageEvents<MatOSWorkflowEvent>(cwd, join(runDir, 'events.jsonl')).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [] as MatOSWorkflowEvent[] }
          throw error
        })
        const graphSnapshot = await readJsonFile<unknown>(
          join(runDir, run.graphSnapshotPath || 'graph.snapshot.json'),
        ).catch(() => undefined)
        const childWorkflowRefs = await listChildWorkflowRefs(runDir)
        records.push({ runDir, run, events, graphSnapshot, childWorkflowRefs })
      } catch (error) {
        issues.push({
          code: 'invalid_usage_workflow_run_record',
          message: `${entry}: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'warning',
        })
      }
    }
  }

  return { records, issues }
}

async function listChildWorkflowRefs(runDir: string): Promise<string[]> {
  const refs = new Set<string>()
  const childRunIds = new Set<string>()
  for (const relativeDir of ['child-runs', 'iterations', 'rounds']) {
    await collectChildWorkflowRefs(join(runDir, relativeDir), refs, childRunIds, 3)
  }
  await collectChildWorkflowRefsFromRunIds(dirname(runDir), childRunIds, refs)
  return [...refs].sort()
}

async function collectChildWorkflowRefsFromRunIds(
  runsDir: string,
  childRunIds: Set<string>,
  refs: Set<string>,
): Promise<void> {
  for (const runId of childRunIds) {
    const childRun = await readJsonFile<MatOSWorkflowRunSnapshot>(
      join(runsDir, runId, 'run.json'),
    ).catch(() => undefined)
    const workflowRef = optionalString(childRun?.workflowRef)
    if (workflowRef) {
      refs.add(workflowRef)
    }
  }
}

async function collectChildWorkflowRefs(
  dir: string,
  refs: Set<string>,
  childRunIds: Set<string>,
  depth: number,
): Promise<void> {
  if (depth < 0) {
    return
  }
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectChildWorkflowRefs(path, refs, childRunIds, depth - 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    try {
      collectChildWorkflowRefsFromValue(await readJsonFile<unknown>(path), refs, childRunIds)
    } catch {
      // Best-effort usage indexing should not fail because a child-run sidecar is malformed.
    }
  }
}

function collectChildWorkflowRefsFromValue(
  value: unknown,
  refs: Set<string>,
  childRunIds: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectChildWorkflowRefsFromValue(item, refs, childRunIds)
    }
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'childRunId' && typeof item === 'string' && item.trim()) {
      childRunIds.add(item.trim())
    }
    if (key === 'workflowRef' && typeof item === 'string' && item.trim()) {
      refs.add(item.trim())
    }
    collectChildWorkflowRefsFromValue(item, refs, childRunIds)
  }
}

function workflowDefinitionReferenceCandidates(value: unknown): string[] {
  const refs = new Set<string>()
  collectWorkflowDefinitionReferences(value, refs)
  return [...refs].sort()
}

function collectWorkflowDefinitionReferences(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    if (/^(role|tool|workflow|skill|knowledge|data|mcp|plugin|benchmark|evaluation|runtime):/.test(value)) {
      refs.add(value)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWorkflowDefinitionReferences(item, refs)
    }
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(role|tool|workflow|skill|knowledge|data|mcp|plugin|benchmark|evaluation|runtime)(Ref|Refs)?$/i.test(key)
    ) {
      for (const reference of stringArray(item)) {
        refs.add(reference)
      }
      if (typeof item === 'string') {
        refs.add(item)
      }
    }
    collectWorkflowDefinitionReferences(item, refs)
  }
}

function workflowRunReferenceCandidates(
  run: MatOSWorkflowRunSnapshot,
  event: MatOSWorkflowEvent | undefined,
  graphSnapshot: unknown,
): string[] {
  const data = event?.data ?? {}
  return [
    optionalString(run.workflowRef),
    optionalString(data.workflowRef),
    optionalString(data.toolRef),
    optionalString(data.roleRef),
    optionalString(data.assetKey),
    optionalString(data.reference),
    optionalString(data.ref),
    ...stringArray(data.assetKeys),
    ...stringArray(data.refs),
    ...workflowDefinitionReferenceCandidates(graphSnapshot),
  ].filter((item): item is string => Boolean(item))
}

function workflowRunNode(
  run: MatOSWorkflowRunSnapshot,
  usageCount: number,
): MatOSAssetGraphNode {
  return {
    id: `workflow-run:${run.runId}`,
    kind: 'workflow-run',
    label: run.runId,
    reference: run.runId,
    createdAt: run.createdAt,
    metadata: {
      workflowRef: run.workflowRef,
      status: run.status,
      updatedAt: run.updatedAt,
      usageCount,
    },
  }
}

export async function buildUsageGraphProviderResult(
  context: MatOSAssetGraphProviderContext,
): Promise<MatOSAssetGraphProviderResult> {
  if (!context.options.includeUsage) {
    return {}
  }

  const nodes = new Map<string, MatOSAssetGraphNode>()
  const edges: MatOSAssetGraphEdge[] = []
  const aggregates = new Map<string, AssetUsageAggregate>()
  const issues: MatOSAssetGraphProviderResult['issues'] = []
  const usageSessions = await listUsageSessions(context.cwd)
  issues.push(...(usageSessions.issues ?? []))
  const sessions = usageSessions.sessions
  const config = await readMatOSProjectConfig(context.cwd)
  const snapshots = (await listMatOSAssetHistorySnapshots(context.cwd))
    .filter(snapshot => archiveSourceAllowed(snapshot, config) && (context.options.includeHidden || !shouldHideInternalAssetSource() || Boolean(archiveOwnerScopeRef(snapshot))))
  const archivedRefs = new Set(snapshots.flatMap(snapshot => snapshot.assetRefs))
  const archiveSourcesByRef = new Map<string, Set<unknown>>()
  for (const snapshot of snapshots) for (const ref of snapshot.assetRefs) {
    const sources = archiveSourcesByRef.get(ref) ?? new Set<unknown>()
    sources.add(snapshot.provenance?.sourceId)
    archiveSourcesByRef.set(ref, sources)
  }
  const eventScopeAllowed = (scopeRef: string | undefined) => scopeRef
    ? archiveScopeAllowed({ scope: scopeRef.split(':')[0]!, scopeRef }) : !isScopedAssetArchiveCaller()
  for (const session of sessions) {
    if (!eventScopeAllowed(session.scopeRef)) continue
    if (session.hidden && !context.options.includeHidden) {
      continue
    }
    const events = usageSessions.eventsByPath.get(session.path) ?? []
    const traceId = session.traceId ?? session.sessionId
    const traceNodeId = `trace:${traceId}`
    let sessionUsageCount = 0
    const sessionEdgeAggregates = new Map<string, SessionUsageEdgeAggregate>()

    for (const event of events) {
      if (event.type !== 'matos.asset.used') {
        continue
      }
      if (!eventScopeAllowed(optionalString(event.scopeRef) ?? optionalString(event.data?.scopeRef) ?? session.scopeRef)) continue
      const seenAssetKeys = new Set<string>()
      for (const reference of assetReferenceCandidates(event)) {
        const archived = archivedRefs.has(reference) && (!event.data?.sourceId || archiveSourcesByRef.get(reference)?.has(event.data.sourceId))
        const key = observedAssetKey(context, reference, nodes, event.data ?? {}, archived)
        if (key) seenAssetKeys.add(key)
      }
      if (seenAssetKeys.size === 0) {
        continue
      }
      sessionUsageCount += seenAssetKeys.size
      for (const assetKey of seenAssetKeys) {
        const aggregate = ensureAggregate(aggregates, assetKey)
        aggregate.usageCount += 1
        aggregate.traceIds.add(traceId)
        aggregate.sessionIds.add(session.sessionId)
        if (event.timestamp && (!aggregate.lastUsedAt || event.timestamp > aggregate.lastUsedAt)) {
          aggregate.lastUsedAt = event.timestamp
        }
        const current = sessionEdgeAggregates.get(assetKey) ?? {
          count: 0,
          evidenceRefs: new Set<string>(),
        }
        current.count += 1
        if (event.id) {
          current.evidenceRefs.add(event.id)
        }
        if (event.timestamp && (!current.latestAt || event.timestamp > current.latestAt)) {
          current.latestAt = event.timestamp
        }
        sessionEdgeAggregates.set(assetKey, current)
      }
    }

    for (const [assetKey, sessionEdge] of sessionEdgeAggregates) {
      edges.push({
        from: assetKey,
        to: traceNodeId,
        kind: 'used_in_session',
        source: 'trace',
        reference: session.sessionId,
        evidenceRefs: [...sessionEdge.evidenceRefs].sort(),
        ...(sessionEdge.latestAt ? { createdAt: sessionEdge.latestAt } : {}),
        weight: sessionEdge.count,
      })
    }

    const traceNode = traceNodeForSession(session, sessionUsageCount)
    if (traceNode && sessionUsageCount > 0) {
      nodes.set(traceNode.id, traceNode)
    }
  }

  const workflowRuns = await listWorkflowRunUsageRecords(context.cwd)
  issues.push(...(workflowRuns.issues ?? []))
  for (const { run, events, graphSnapshot, childWorkflowRefs } of workflowRuns.records) {
    if (!eventScopeAllowed(run.trace?.scopeRef)) continue
    const runNodeId = `workflow-run:${run.runId}`
    let runUsageCount = 0
    const perRunReferences = new Map<
      string,
      {
        eventIds: string[]
        latestAt?: string
        countInUsageAggregate?: boolean
      }
    >()
    const eventsOrRun = events.length > 0 ? events : [undefined]

    for (const event of eventsOrRun) {
      const eventReferences = new Set<string>()
      for (const reference of workflowRunReferenceCandidates(
        run,
        event,
        graphSnapshot,
      )) {
        const key = observedAssetKey(context, reference, nodes, {}, archivedRefs.has(reference))
        if (key) eventReferences.add(key)
      }
      for (const assetKey of eventReferences) {
        const current = perRunReferences.get(assetKey) ?? { eventIds: [] }
        if (event?.id) {
          current.eventIds.push(event.id)
        }
        const timestamp = event?.timestamp ?? run.updatedAt ?? run.createdAt
        if (timestamp && (!current.latestAt || timestamp > current.latestAt)) {
          current.latestAt = timestamp
        }
        perRunReferences.set(assetKey, current)
      }
    }
    for (const reference of childWorkflowRefs) {
      const key = observedAssetKey(context, reference, nodes, {}, archivedRefs.has(reference))
      if (!key) continue
      const current = perRunReferences.get(key) ?? {
        eventIds: [],
        latestAt: run.updatedAt ?? run.createdAt,
        countInUsageAggregate: false,
      }
      current.countInUsageAggregate = current.countInUsageAggregate === true
      perRunReferences.set(key, current)
    }

    for (const [assetKey, reference] of perRunReferences) {
      if (reference.countInUsageAggregate !== false) {
        const aggregate = ensureAggregate(aggregates, assetKey)
        aggregate.usageCount += 1
        aggregate.workflowRunIds.add(run.runId)
        if (reference.latestAt && (!aggregate.lastUsedAt || reference.latestAt > aggregate.lastUsedAt)) {
          aggregate.lastUsedAt = reference.latestAt
        }
      }
      runUsageCount += 1
      edges.push({
        from: assetKey,
        to: runNodeId,
        kind: 'used_in_workflow_run',
        source: 'workflow',
        reference: run.runId,
        ...(reference.eventIds.length > 0
          ? { evidenceRefs: [...new Set(reference.eventIds)].sort() }
          : {}),
        ...(reference.latestAt ? { createdAt: reference.latestAt } : {}),
        weight: 1,
      })
    }

    if (runUsageCount > 0) {
      nodes.set(runNodeId, workflowRunNode(run, runUsageCount))
    }
  }

  for (const [assetKey, aggregate] of aggregates) {
    const node = usageAssetNode(context, assetKey, aggregate)
    if (node) {
      nodes.set(node.id, node)
    } else if (nodes.has(assetKey)) {
      const historical = nodes.get(assetKey)!
      historical.metadata = { ...historical.metadata, usage: { count: aggregate.usageCount, lastUsedAt: aggregate.lastUsedAt } }
    }
  }
  for (const node of nodes.values()) {
    if (node.kind === 'asset-revision' && typeof node.metadata?.currentAssetKey === 'string') edges.push({ from: node.id, to: node.metadata.currentAssetKey, kind: 'revision_of', source: 'trace' })
  }

  return {
    nodes: [...nodes.values()],
    edges,
    issues,
  }
}

export const usageProvider: MatOSAssetGraphProvider = {
  id: 'usage',
  stage: 'usage',
  build: buildUsageGraphProviderResult,
}
