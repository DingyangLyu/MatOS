import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactMatOSAssetOutput } from '../outputRedaction.js'
import { parseMatOSAssetReference } from '../refs.js'
import {
  isUserVisibleMatOSAsset,
  shouldHideInternalAssetSource,
  shouldHideAssetFromUserSurface,
} from '../sourceVisibility.js'
import {
  listMatOSExperienceAssets,
  type MatOSExperienceAssetSummary,
} from '../../learning/experienceAssets.js'
import { listMatOSSelfEvolutionMonitorRecordLedger } from '../../learning/evolutionMonitorRecords.js'
import {
  type MatOSSelfEvolutionMonitorRecord,
} from '../../learning/evolutionMonitor.js'
import { getMatOSDir, readMatOSProjectConfig } from '../../project.js'
import { archiveScopeAllowed, archiveSourceAllowed, isScopedAssetArchiveCaller, archiveOwnerScopeRef } from '../history/archive.js'
import { observedAssetKey } from './historicalReferences.js'
import {
  listMatOSAssetHistoryReleasesWithIssues,
  listMatOSAssetHistorySnapshotsWithIssues,
} from '../history/records.js'
import type {
  MatOSAssetHistoryReleaseRecord,
  MatOSAssetHistorySnapshotRecord,
} from '../history/types.js'
import type {
  MatOSAssetGraphEdge,
  MatOSAssetGraphEdgeKind,
  MatOSAssetGraphNode,
  MatOSAssetGraphProvider,
  MatOSAssetGraphProviderContext,
  MatOSAssetGraphProviderResult,
} from './types.js'

type DirectEditorRunRecordLike = {
  scope?: string
  scopeRef?: string
  input?: { scope?: string; scopeRef?: string }
  runId?: string
  status?: string
  createdAt?: string
  updatedAt?: string
  updatedAssets?: string[]
  createdAssets?: string[]
  disabledAssets?: string[]
  evidenceRefs?: string[]
  beforeSnapshot?: string
  afterSnapshot?: string
  rollbackSnapshot?: string
}

const EXPERIENCE_EVENT_PREFIX = 'experience-event:'
const MONITOR_EVENT_PREFIX = 'self-evolution-monitor:'

function redactLineageMetadataValue(value: unknown): unknown {
  return redactMatOSAssetOutput(value)
}

function redactLineageMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined
  }
  return redactLineageMetadataValue(value) as Record<string, unknown>
}

function directEditorRunsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'direct-editor', 'runs')
}

function snapshotNode(record: MatOSAssetHistorySnapshotRecord): MatOSAssetGraphNode {
  const provenanceValidation = record.provenance?.validation
  return {
    id: `snapshot:${record.snapshotId}`,
    kind: 'snapshot',
    label: record.snapshotId,
    reference: record.snapshotId,
    createdAt: record.createdAt,
    metadata: {
      snapshotKind: record.kind,
      scope: record.scope,
      scopeRef: archiveOwnerScopeRef(record),
      commit: record.commit,
      parentCommit: record.parentCommit,
      ref: record.ref,
      ...(provenanceValidation &&
      typeof provenanceValidation === 'object' &&
      typeof (provenanceValidation as { ok?: unknown }).ok === 'boolean'
        ? { validationOk: (provenanceValidation as { ok: boolean }).ok }
        : {}),
      provenance: redactLineageMetadata(record.provenance),
    },
  }
}

function releaseNode(record: MatOSAssetHistoryReleaseRecord): MatOSAssetGraphNode {
  return {
    id: `release:${record.releaseId}`,
    kind: 'release',
    label: record.name || record.releaseId,
    reference: record.releaseId,
    createdAt: record.createdAt,
    metadata: {
      sourceRef: record.sourceRef,
      commit: record.commit,
      previousStableCommit: record.previousStableCommit,
      validationOk: record.validation?.ok,
      provenance: redactLineageMetadata(record.provenance),
    },
  }
}

function directEditorRunNode(record: DirectEditorRunRecordLike): MatOSAssetGraphNode | undefined {
  if (!record.runId) {
    return undefined
  }
  return {
    id: `direct-editor-run:${record.runId}`,
    kind: 'direct-editor-run',
    label: record.runId,
    reference: record.runId,
    createdAt: record.createdAt,
    metadata: {
      status: record.status,
      updatedAt: record.updatedAt,
    },
  }
}

function experienceEventNodeId(ref: string): string {
  return `${EXPERIENCE_EVENT_PREFIX}${ref}`
}

function monitorEventNodeId(recordId: string): string {
  return `${MONITOR_EVENT_PREFIX}${recordId}`
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function assetLikeReference(type: string, value: string): string {
  return value.includes(':') ? value : `${type}:${value}`
}

function matchesExperienceRef(
  experience: MatOSExperienceAssetSummary,
  refOrId: string,
): boolean {
  return (
    experience.ref === refOrId ||
    experience.id === refOrId ||
    experience.ref.startsWith(`${refOrId}@`) ||
    experience.ref === `experience:${refOrId}@${experience.version}` ||
    experience.ref.startsWith(`experience:${refOrId}@`)
  )
}

function resolveExperienceEventNodeId(
  experiences: MatOSExperienceAssetSummary[],
  ref: string,
): string {
  const experience = experiences.find(item => matchesExperienceRef(item, ref))
  return experienceEventNodeId(experience?.ref ?? ref)
}

function resolveEvidenceNodeId(
  experiences: MatOSExperienceAssetSummary[],
  ref: string,
): string {
  if (ref.startsWith('experience:') || experiences.some(item => matchesExperienceRef(item, ref))) {
    return resolveExperienceEventNodeId(experiences, ref)
  }
  return ref
}

function experienceNode(experience: MatOSExperienceAssetSummary): MatOSAssetGraphNode {
  return {
    id: experienceEventNodeId(experience.ref),
    kind: 'experience',
    label: experience.name || experience.ref,
    reference: experience.ref,
    metadata: redactLineageMetadata({
      canonicalKey: experience.ref,
      lifecycle: experience.lifecycle,
      mergeKey: experience.mergeKey,
      evidenceCount: experience.evidenceCount,
      signalKinds: experience.signalKinds,
    }),
  }
}

function monitorNode(record: MatOSSelfEvolutionMonitorRecord): MatOSAssetGraphNode {
  return {
    id: monitorEventNodeId(record.recordId),
    kind: 'event',
    label: `${record.status} ${record.triggerKind}`,
    reference: record.recordId,
    createdAt: record.createdAt,
    metadata: redactLineageMetadata({
      sessionId: record.sessionId,
      triggerKind: record.triggerKind,
      triggerKey: record.triggerKey,
      status: record.status,
      summary: record.summary,
      eventId: record.eventId,
      updatedAt: record.updatedAt,
      error: record.error,
    }),
  }
}

function collectExperienceTargetRefs(experience: MatOSExperienceAssetSummary): string[] {
  const refs = new Set<string>()
  for (const role of stringArray(experience.metadata.roles)) {
    refs.add(assetLikeReference('role', role))
  }
  for (const tool of [
    ...stringArray(experience.metadata.tools),
    ...stringArray(experience.metadata.toolNames),
  ]) {
    refs.add(assetLikeReference('tool', tool))
  }

  const feedbackAnalysis = experience.metadata.feedbackAnalysis
  const signals =
    feedbackAnalysis &&
    typeof feedbackAnalysis === 'object' &&
    Array.isArray((feedbackAnalysis as { signals?: unknown }).signals)
      ? (feedbackAnalysis as { signals: unknown[] }).signals
      : []
  for (const signal of signals) {
    const target =
      signal && typeof signal === 'object'
        ? (signal as { target?: Record<string, unknown> }).target
        : undefined
    if (!target) {
      continue
    }
    for (const roleRef of stringArray(target.roleRefs)) {
      refs.add(assetLikeReference('role', roleRef))
    }
    for (const workflowRef of stringArray(target.workflowRefs)) {
      refs.add(assetLikeReference('workflow', workflowRef))
    }
    for (const toolName of stringArray(target.toolNames)) {
      refs.add(assetLikeReference('tool', toolName))
    }
  }

  return [...refs].sort()
}

function visibleExperienceAssets(
  context: MatOSAssetGraphProviderContext,
  experiences: MatOSExperienceAssetSummary[],
): MatOSExperienceAssetSummary[] {
  const visibleRefs = new Set(
    context.registry.experienceAssets
      .filter(asset => {
        if (context.options.includeHidden) {
          return true
        }
        return asset.type === 'experience'
          ? !shouldHideInternalAssetSource() || isUserVisibleMatOSAsset(asset)
          : !shouldHideAssetFromUserSurface(asset)
      })
      .map(asset => asset.canonicalKey),
  )
  return experiences.filter(experience => visibleRefs.has(experience.ref))
}

function resolveAssetKey(
  context: MatOSAssetGraphProviderContext,
  reference: string,
): string {
  return context.registry.resolve(reference)?.canonicalKey ?? reference
}

function snapshotEdgeKind(kind: MatOSAssetHistorySnapshotRecord['kind']): MatOSAssetGraphEdgeKind {
  switch (kind) {
    case 'direct-editor-before':
      return 'snapshot_before'
    case 'direct-editor-rollback':
      return 'rolled_back_to'
    case 'release':
    case 'manual':
    case 'direct-editor-after':
      return 'snapshot_after'
  }
}

function snapshotEdges(
  context: MatOSAssetGraphProviderContext,
  record: MatOSAssetHistorySnapshotRecord,
): MatOSAssetGraphEdge[] {
  const snapshotId = `snapshot:${record.snapshotId}`
  return record.assetRefs.map(reference => ({
    from: resolveAssetKey(context, reference),
    to: snapshotId,
    kind: snapshotEdgeKind(record.kind),
    source: 'history',
    reference: record.snapshotId,
    createdAt: record.createdAt,
    evidenceRefs: [
      ...(typeof record.provenance?.runId === 'string'
        ? [`direct-editor-run:${record.provenance.runId}`]
        : []),
      ...(Array.isArray(record.provenance?.experienceRefs)
        ? record.provenance.experienceRefs.filter(
            (item): item is string => typeof item === 'string',
          )
        : []),
    ],
  }))
}

function releaseEdges(
  snapshots: Map<string, MatOSAssetHistorySnapshotRecord>,
  context: MatOSAssetGraphProviderContext,
  record: MatOSAssetHistoryReleaseRecord,
): MatOSAssetGraphEdge[] {
  const releaseId = `release:${record.releaseId}`
  const sourceSnapshot = snapshots.get(record.sourceRef)
  const edges: MatOSAssetGraphEdge[] = []

  if (sourceSnapshot) {
    edges.push({
      from: `snapshot:${sourceSnapshot.snapshotId}`,
      to: releaseId,
      kind: 'released_as',
      source: 'history',
      reference: record.releaseId,
      createdAt: record.createdAt,
    })
    for (const assetRef of sourceSnapshot.assetRefs) {
      edges.push({
        from: resolveAssetKey(context, assetRef),
        to: releaseId,
        kind: 'released_as',
        source: 'history',
        reference: record.releaseId,
        createdAt: record.createdAt,
      })
    }
  }

  return edges
}

async function listDirectEditorRunRecords(cwd: string): Promise<DirectEditorRunRecordLike[]> {
  let entries: string[]
  try {
    entries = await readdir(directEditorRunsDir(cwd))
  } catch {
    return []
  }
  const records = await Promise.all(
    entries.map(async entry => {
      try {
        const raw = await readFile(
          join(directEditorRunsDir(cwd), entry, 'run.json'),
          'utf8',
        )
        return JSON.parse(raw) as DirectEditorRunRecordLike
      } catch {
        return undefined
      }
    }),
  )
  return records.filter((record): record is DirectEditorRunRecordLike => Boolean(record))
}

function edgeFromRunToSnapshot(
  runId: string,
  snapshotId: string | undefined,
  kind: MatOSAssetGraphEdgeKind,
  createdAt: string | undefined,
): MatOSAssetGraphEdge | undefined {
  if (!snapshotId) {
    return undefined
  }
  return {
    from: `direct-editor-run:${runId}`,
    to: `snapshot:${snapshotId}`,
    kind,
    source: 'evolution',
    reference: snapshotId,
    ...(createdAt ? { createdAt } : {}),
  }
}

function directEditorRunEdges(
  context: MatOSAssetGraphProviderContext,
  record: DirectEditorRunRecordLike,
  experiences: MatOSExperienceAssetSummary[] = [],
): MatOSAssetGraphEdge[] {
  const runId = record.runId
  if (!runId) {
    return []
  }
  const runNode = `direct-editor-run:${runId}`
  const edges: MatOSAssetGraphEdge[] = []

  for (const ref of record.updatedAssets ?? []) {
    edges.push({
      from: resolveAssetKey(context, ref),
      to: runNode,
      kind: 'updated_by',
      source: 'evolution',
      reference: runId,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    })
  }
  for (const ref of record.createdAssets ?? []) {
    edges.push({
      from: resolveAssetKey(context, ref),
      to: runNode,
      kind: 'created_by',
      source: 'evolution',
      reference: runId,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    })
  }
  for (const ref of record.disabledAssets ?? []) {
    edges.push({
      from: resolveAssetKey(context, ref),
      to: runNode,
      kind: 'disabled_by',
      source: 'evolution',
      reference: runId,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    })
  }
  for (const ref of record.evidenceRefs ?? []) {
    edges.push({
      from: resolveEvidenceNodeId(experiences, ref),
      to: runNode,
      kind: 'evidence_for',
      source: 'evolution',
      reference: runId,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    })
  }
  for (const edge of [
    edgeFromRunToSnapshot(runId, record.beforeSnapshot, 'snapshot_before', record.createdAt),
    edgeFromRunToSnapshot(runId, record.afterSnapshot, 'snapshot_after', record.createdAt),
    edgeFromRunToSnapshot(runId, record.rollbackSnapshot, 'rolled_back_to', record.createdAt),
  ]) {
    if (edge) {
      edges.push(edge)
    }
  }

  return edges
}

function experienceEdges(
  context: MatOSAssetGraphProviderContext,
  experience: MatOSExperienceAssetSummary,
): MatOSAssetGraphEdge[] {
  const experienceNodeId = experienceEventNodeId(experience.ref)
  return collectExperienceTargetRefs(experience).map(ref => ({
    from: experienceNodeId,
    to: resolveAssetKey(context, ref),
    kind: 'evidence_for',
    source: 'evolution',
    reference: experience.ref,
    evidenceRefs: [experience.ref],
  }))
}

function monitorRecordEdges(
  experiences: MatOSExperienceAssetSummary[],
  record: MatOSSelfEvolutionMonitorRecord,
): MatOSAssetGraphEdge[] {
  const monitorId = monitorEventNodeId(record.recordId)
  const edges: MatOSAssetGraphEdge[] = []

  for (const experienceRef of record.experienceRefs ?? []) {
    edges.push({
      from: resolveExperienceEventNodeId(experiences, experienceRef),
      to: monitorId,
      kind: 'created_by',
      source: 'evolution',
      reference: record.recordId,
      createdAt: record.createdAt,
      evidenceRefs: [experienceRef],
    })
  }

  if (record.directEditorRunId) {
    edges.push({
      from: monitorId,
      to: `direct-editor-run:${record.directEditorRunId}`,
      kind: 'evidence_for',
      source: 'evolution',
      reference: record.recordId,
      createdAt: record.createdAt,
    })
  }

  for (const priorRecordId of record.priorRecordIds ?? []) {
    edges.push({
      from: monitorEventNodeId(priorRecordId),
      to: monitorId,
      kind: 'derived_from',
      source: 'evolution',
      reference: record.recordId,
      createdAt: record.createdAt,
    })
  }

  return edges
}

export async function buildLineageGraphProviderResult(
  context: MatOSAssetGraphProviderContext,
): Promise<MatOSAssetGraphProviderResult> {
  if (!context.options.includeLineage) {
    return {}
  }

  const [
    snapshotResult,
    releaseResult,
    rawDirectEditorRuns,
    rawMonitorRecords,
    experienceAssets,
  ] = await Promise.all([
    listMatOSAssetHistorySnapshotsWithIssues(context.cwd),
    listMatOSAssetHistoryReleasesWithIssues(context.cwd),
    listDirectEditorRunRecords(context.cwd),
    listMatOSSelfEvolutionMonitorRecordLedger(context.cwd),
    listMatOSExperienceAssets(context.cwd),
  ])
  const visibleExperiences = visibleExperienceAssets(context, experienceAssets)
  const config = await readMatOSProjectConfig(context.cwd)
  snapshotResult.records = snapshotResult.records.filter(record => archiveSourceAllowed(record, config))
  const scoped = isScopedAssetArchiveCaller()
  if (scoped) {
    // Public asset access does not grant access to internal evolution evidence.
    snapshotResult.records = snapshotResult.records.flatMap(record => {
      if (archiveOwnerScopeRef(record)) return [record]
      const assetRefs = record.assetRefs.filter(reference => {
        const parsed = parseMatOSAssetReference(reference)
        return context.assets.some(asset => asset.type === parsed.type && asset.id === parsed.id &&
          (!record.provenance?.sourceId || (asset.metadata.sourceProvenance as Record<string, unknown> | undefined)?.sourceId === record.provenance.sourceId))
      })
      if (!assetRefs.length) return []
      const provenance = Object.fromEntries(Object.entries(record.provenance ?? {}).filter(([key]) =>
        ['sourceId', 'sourceCommit', 'acceptedBranch', 'archiveState', 'sourceCommittedAt'].includes(key)))
      return [{ ...record, assetRefs, provenance }]
    })
  }
  const scopedRunAllowed = (record: DirectEditorRunRecordLike): boolean => !scoped || Boolean(record.scope && ['user', 'team', 'project'].includes(record.scope) && archiveScopeAllowed({ scope: record.scope, scopeRef: record.input?.scopeRef ?? record.scopeRef }))
  const directEditorRuns = rawDirectEditorRuns.filter(scopedRunAllowed)
  const allowedRunIds = new Set(directEditorRuns.map(run => run.runId))
  const monitorRecords = rawMonitorRecords.filter(record => !scoped || (record.directEditorRunId && allowedRunIds.has(record.directEditorRunId)))
  const visibleSnapshots = new Set(snapshotResult.records.map(record => record.snapshotId))
  releaseResult.records = releaseResult.records.filter(record => !scoped || visibleSnapshots.has(record.sourceRef))
  if (scoped) {
    const ownedSnapshots = new Set(snapshotResult.records.filter(record => archiveOwnerScopeRef(record)).map(record => record.snapshotId))
    releaseResult.records = releaseResult.records.map(record => ownedSnapshots.has(record.sourceRef) ? record : { ...record, provenance: undefined })
  }
  const embeddedDirectEditorRuns: DirectEditorRunRecordLike[] = monitorRecords.flatMap(
    record => (record.directEditorRun?.runId && (!scoped || allowedRunIds.has(record.directEditorRun.runId)) ? [record.directEditorRun] : []),
  )
  const allDirectEditorRuns = [...directEditorRuns, ...embeddedDirectEditorRuns]
  const snapshots = new Map(
    snapshotResult.records.map(record => [record.snapshotId, record]),
  )
  const nodes: MatOSAssetGraphNode[] = [
    ...snapshotResult.records.map(snapshotNode),
    ...releaseResult.records.map(releaseNode),
    ...allDirectEditorRuns
      .map(directEditorRunNode)
      .filter((node): node is MatOSAssetGraphNode => Boolean(node)),
    ...monitorRecords.map(monitorNode),
    ...visibleExperiences.map(experienceNode),
  ]
  const edges: MatOSAssetGraphEdge[] = [
    ...snapshotResult.records.flatMap(record => snapshotEdges(context, record)),
    ...releaseResult.records.flatMap(record =>
      releaseEdges(snapshots, context, record),
    ),
    ...allDirectEditorRuns.flatMap(record =>
      directEditorRunEdges(context, record, visibleExperiences),
    ),
    ...monitorRecords.flatMap(record => monitorRecordEdges(visibleExperiences, record)),
    ...visibleExperiences.flatMap(record => experienceEdges(context, record)),
  ]
  const issues = [
    ...snapshotResult.issues.filter(issue => !scoped || issue.directory).map(issue => ({
      code: 'invalid_history_snapshot_record',
      message: `${issue.file}: ${issue.message}`,
      severity: 'warning' as const,
    })),
    ...releaseResult.issues.filter(issue => !scoped || issue.directory).map(issue => ({
      code: 'invalid_history_release_record',
      message: `${issue.file}: ${issue.message}`,
      severity: 'warning' as const,
    })),
  ]

  const historical = new Map<string, MatOSAssetGraphNode>()
  for (const snapshot of snapshotResult.records) {
    for (const reference of snapshot.assetRefs) {
      const archived = context.options.includeHidden || !shouldHideInternalAssetSource() || Boolean(archiveOwnerScopeRef(snapshot))
      const key = observedAssetKey(context, reference, historical, { sourceId: snapshot.provenance?.sourceId, sourceCommit: snapshot.commit }, archived)
      if (!key) continue
      const node = historical.get(key)
      if (node) node.metadata = { ...node.metadata, snapshotId: snapshot.snapshotId, contentAvailable: true, archiveCommit: snapshot.commit, sourceCommit: snapshot.provenance?.sourceCommit }
      edges.push({ from: key, to: `snapshot:${snapshot.snapshotId}`, kind: snapshotEdgeKind(snapshot.kind), source: 'history', createdAt: snapshot.createdAt })
      if (node && typeof node.metadata?.currentAssetKey === 'string') edges.push({ from: key, to: node.metadata.currentAssetKey, kind: 'revision_of', source: 'history' })
    }
  }
  nodes.push(...historical.values())

  return { nodes, edges, issues }
}

export const lineageProvider: MatOSAssetGraphProvider = {
  id: 'lineage',
  stage: 'lineage',
  build: buildLineageGraphProviderResult,
}
