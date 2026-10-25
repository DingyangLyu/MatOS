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

import { closeSync,openSync,readSync,statSync } from 'node:fs'
import { extname,relative,resolve,sep } from 'node:path'
import { buildMatOSAssetGraphIndex } from '../assets/graph/buildGraphIndex.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import {
redactInternalAssetPaths
} from '../assets/sourceVisibility.js'
import type { MatOSAsset } from '../assets/types.js'
import { workflowReadinessForAsset } from '../workflows/workflowReadiness.js'
import {
type MatOSWorkbenchResourceRelatedEvidence
} from './resourceEvidence.js'
import type {
MatOSWorkbenchGitGovernance,
MatOSWorkbenchResource,
MatOSWorkbenchResourceDetail,
MatOSWorkbenchResourceDetailTab,
MatOSWorkbenchResourceEntryContent,
MatOSWorkbenchResourceShow,
MatOSWorkbenchResourceType
} from './types.js'

const ENTRY_CONTENT_MAX_BYTES = 64 * 1024
const ENTRY_TEXT_EXTENSIONS = new Set([
  '.bash',
  '.cfg',
  '.conf',
  '.csv',
  '.ini',
  '.ipynb',
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])

export function normalizeResourceType(type: string): MatOSWorkbenchResourceType {
  if (
    type === 'role' ||
    type === 'workflow' ||
    type === 'tool' ||
    type === 'skill' ||
    type === 'plugin' ||
    type === 'mcp' ||
    type === 'knowledge' ||
    type === 'data' ||
    type === 'benchmark' ||
    type === 'benchmark-suite' ||
    type === 'evaluation' ||
    type === 'experience' ||
    type === 'evolution-proposal' ||
    type === 'runtime'
  ) {
    return type
  }
  return 'asset'
}

export function searchableText(asset: MatOSAsset): string {
  return [
    asset.id,
    asset.type,
    asset.name,
    asset.description,
    asset.canonicalKey,
    asset.packId,
    ...asset.tags,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase()
}

export function matchesQuery(asset: MatOSAsset, query: string | undefined): boolean {
  const trimmed = query?.trim().toLowerCase()
  if (!trimmed) {
    return true
  }
  return searchableText(asset).includes(trimmed)
}

export function matchesResourceTypeFilter(asset: MatOSAsset, types: Set<string>): boolean {
  return types.size === 0 || types.has(asset.type) || types.has(normalizeResourceType(asset.type))
}

export function resourceMatchesQuery(resource: MatOSWorkbenchResource, query: string | undefined): boolean {
  const trimmed = query?.trim().toLowerCase()
  if (!trimmed) {
    return true
  }
  return [
    resource.id,
    resource.ref,
    resource.type,
    resource.name,
    resource.description,
    resource.status,
    resource.scopeRef,
    ...(resource.tags ?? []),
    ...(resource.dependencies ?? []),
    JSON.stringify(resource.metadata ?? {}),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some(value => value.toLowerCase().includes(trimmed))
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

// Asset dependency lists can mix an unversioned manifest ref
// (`data:example-dataset`) with the versioned ref the graph index
// resolves (`data:example-dataset@1.0.0`). Collapse those to the
// versioned form so the UI does not show each dependency twice.
export function dedupeRefsPreferVersioned(values: string[]): string[] {
  const byBase = new Map<string, Set<string>>()
  for (const value of values) {
    if (!value) {
      continue
    }
    const base = value.split('@')[0]
    const set = byBase.get(base) ?? new Set<string>()
    set.add(value)
    byBase.set(base, set)
  }
  const result: string[] = []
  for (const [base, refs] of byBase) {
    const versioned = [...refs].filter(ref => ref.includes('@'))
    if (versioned.length) {
      result.push(...versioned)
    } else {
      result.push(base)
    }
  }
  return [...new Set(result)].sort()
}

export function uniqueByStableId(items: unknown[]): unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  for (const item of items) {
    const record = objectRecord(item)
    const key = firstString(
      record.id,
      record.ref,
      record.runId,
      record.traceId,
      record.recordId,
      record.key,
      JSON.stringify(record),
    )
    if (key && seen.has(key)) {
      continue
    }
    if (key) {
      seen.add(key)
    }
    result.push(item)
  }
  return result
}

export function graphNodeRefsForEdges(
  index: Awaited<ReturnType<typeof buildMatOSAssetGraphIndex>>,
  edges: Array<{ from: string; to: string }>,
  side: 'from' | 'to',
): string[] {
  return uniqueSorted(
    edges
      .map(edge => edge[side])
      .map(nodeId => index.nodes[nodeId])
      .filter(node => node?.kind === 'asset')
      .map(node => node.canonicalKey ?? node.id)
      .filter(Boolean),
  )
}

export function tab(input: {
  key: MatOSWorkbenchResourceDetailTab['key']
  label: string
  items?: unknown[]
  summary?: string
  disabled?: boolean
}): MatOSWorkbenchResourceDetailTab {
  const items = input.items ?? []
  return {
    key: input.key,
    label: input.label,
    status: input.disabled ? 'disabled' : items.length ? 'ready' : 'empty',
    count: items.length,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(items.length ? { items } : {}),
  }
}

export function resourcesByType(
  related: MatOSWorkbenchResourceDetail['relationships']['related'],
  type: string,
): unknown[] {
  return related.filter(item => {
    if (!item || typeof item !== 'object') {
      return false
    }
    const record = item as { node?: { assetType?: string } }
    return record.node?.assetType === type
  })
}

export function graphNodesByKind(
  graph: NonNullable<MatOSWorkbenchResourceShow['graph']> | undefined,
  kind: string,
): unknown[] {
  return (graph?.graph.nodes ?? []).filter(node => node.kind === kind)
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function unknownArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value
    }
  }
  return []
}

export function stringArray(...values: unknown[]): string[] {
  return unknownArray(...values)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function pathWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) {
    return true
  }
  const rel = relative(resolvedRoot, resolvedCandidate)
  return Boolean(rel) && !rel.startsWith('..') && rel !== '..' && !rel.startsWith(sep)
}

function entryContentFormat(entryPath: string): MatOSWorkbenchResourceEntryContent['format'] {
  const extension = extname(entryPath).toLowerCase()
  if (extension === '.md') {
    return 'markdown'
  }
  if (extension === '.json' || extension === '.jsonl') {
    return 'json'
  }
  if (extension === '.yaml' || extension === '.yml') {
    return 'yaml'
  }
  return 'text'
}

export function readMatOSAssetEntryContentForWorkbench(
  asset: MatOSAsset,
): MatOSWorkbenchResourceEntryContent | undefined {
  if (!asset.entryRelativePath || !asset.entryAbsolutePath) {
    return undefined
  }
  const root = resolve(asset.absolutePath)
  const entryPath = resolve(asset.entryAbsolutePath)
  if (!pathWithin(entryPath, root)) {
    return undefined
  }

  const extension = extname(entryPath).toLowerCase()
  if (extension && !ENTRY_TEXT_EXTENSIONS.has(extension)) {
    return undefined
  }

  let stat
  try {
    stat = statSync(entryPath)
  } catch {
    return undefined
  }
  if (!stat.isFile()) {
    return undefined
  }

  const bytesToRead = Math.min(stat.size, ENTRY_CONTENT_MAX_BYTES)
  const buffer = Buffer.alloc(bytesToRead)
  let fd: number | undefined
  try {
    fd = openSync(entryPath, 'r')
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0)
    const contentBuffer = buffer.subarray(0, bytesRead)
    if (contentBuffer.subarray(0, Math.min(contentBuffer.length, 4096)).includes(0)) {
      return undefined
    }
    return {
      path: asset.entryRelativePath,
      format: entryContentFormat(asset.entryRelativePath),
      content: contentBuffer.toString('utf8'),
      bytes: stat.size,
      truncated: stat.size > ENTRY_CONTENT_MAX_BYTES,
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

export function selectedAssetMetadata(asset: MatOSAsset): Record<string, unknown> {
  const metadata = objectRecord(asset.metadata)
  const external: Record<string, unknown> = {
    ...objectRecord(metadata.external),
  }
  for (const key of [
    'repository',
    'repositoryUrl',
    'sourceUrl',
    'url',
    'homepage',
    'license',
    'classification',
    'category',
    'kind',
    'approval',
    'approved',
    'intakeId',
    'intake',
  ]) {
    if (metadata[key] !== undefined) {
      external[key] = metadata[key]
    }
  }
  return {
    path: asset.relativePath,
    ...(asset.entryRelativePath ? { entry: asset.entryRelativePath } : {}),
    source: asset.source,
    originalType: asset.type,
    ...(asset.packName ? { packName: asset.packName } : {}),
    ...(asset.runtime.workflow ? { workflow: asset.runtime.workflow } : {}),
    ...(asset.type === 'role' && Array.isArray(asset.metadata.workflowMounts)
      ? { workflowMounts: asset.metadata.workflowMounts }
      : {}),
    ...(asset.type === 'workflow'
      ? { workflowReadiness: workflowReadinessForAsset(asset) }
      : {}),
    ...(asset.metadata.summary ? { summary: asset.metadata.summary } : {}),
    ...(Object.keys(objectRecord(asset.metadata.sourceProvenance)).length
      ? { sourceProvenance: objectRecord(asset.metadata.sourceProvenance) }
      : {}),
    ...(Object.keys(objectRecord(asset.metadata.marketplace)).length
      ? { marketplace: objectRecord(asset.metadata.marketplace) }
      : {}),
    ...(Object.keys(objectRecord(asset.metadata.template)).length
      ? { template: objectRecord(asset.metadata.template) }
      : {}),
    ...(firstString(asset.metadata.visibility, asset.metadata.scope, asset.metadata.scopeRef)
      ? { visibility: firstString(asset.metadata.visibility, asset.metadata.scope, asset.metadata.scopeRef) }
      : {}),
    ...(Object.keys(external).length ? { external } : {}),
  }
}

function command(argv: string[]): { argv: string[]; command: string } {
  return {
    argv,
    command: `matos ${argv.map(arg => JSON.stringify(arg)).join(' ')}`,
  }
}

export function buildMatOSWorkbenchGitGovernance(
  asset: MatOSAsset,
): MatOSWorkbenchGitGovernance | undefined {
  const sourceProvenance = objectRecord(asset.metadata.sourceProvenance)
  if (Object.keys(sourceProvenance).length === 0) {
    return undefined
  }
  const gitea = objectRecord(sourceProvenance.gitea)
  const provider = firstString(sourceProvenance.provider, Object.keys(gitea).length ? 'gitea' : undefined)
  const sourceId = firstString(sourceProvenance.sourceId)
  const webUrl = firstString(gitea.webUrl, gitea.url)
  const cloneUrl = firstString(gitea.cloneUrl)
  const ref = firstString(sourceProvenance.ref)
  const runtimeRefRecord = objectRecord(sourceProvenance.runtimeRef)
  const runtimeRef = Object.keys(runtimeRefRecord).length
    ? {
        ...(firstString(runtimeRefRecord.mode) ? { mode: firstString(runtimeRefRecord.mode) } : {}),
        ...(firstString(runtimeRefRecord.ref) ? { ref: firstString(runtimeRefRecord.ref) } : {}),
        ...(firstString(runtimeRefRecord.commit) ? { commit: firstString(runtimeRefRecord.commit) } : {}),
        ...(firstString(runtimeRefRecord.acceptedAt)
          ? { acceptedAt: firstString(runtimeRefRecord.acceptedAt) }
          : {}),
        ...(firstString(runtimeRefRecord.acceptedBy)
          ? { acceptedBy: firstString(runtimeRefRecord.acceptedBy) }
          : {}),
        ...(firstString(runtimeRefRecord.validationRecord)
          ? { validationRecord: firstString(runtimeRefRecord.validationRecord) }
          : {}),
      }
    : undefined
  const historyRef = firstString(runtimeRef?.ref, ref)
  const actions: MatOSWorkbenchGitGovernance['actions'] = []
  if (webUrl) {
    const baseWebUrl = webUrl.replace(/\/+$/, '')
    actions.push({
      key: 'open-gitea',
      label: 'Open Gitea',
      enabled: true,
      kind: 'external-link',
      url: webUrl,
    })
    if (historyRef) {
      actions.push({
        key: 'open-history',
        label: 'Open History',
        enabled: true,
        kind: 'external-link',
        url: `${baseWebUrl}/src/branch/${encodeURIComponent(historyRef)}`,
      })
    }
    actions.push({
      key: 'open-pulls',
      label: 'Open PRs',
      enabled: true,
      kind: 'external-link',
      url: `${baseWebUrl}/pulls`,
    })
  }
  if (sourceId) {
    actions.push(
      {
        key: 'validate-source',
        label: 'Validate Source',
        enabled: true,
        kind: 'matos-cli',
        command: command(['assets', 'sources', 'status', sourceId, '--json']),
      },
      {
        key: 'refresh-source',
        label: 'Refresh Source',
        enabled: true,
        kind: 'matos-cli',
        command: command(['assets', 'sources', 'refresh', sourceId, '--json']),
      },
      {
        key: 'commit-source',
        label: 'Commit Source',
        enabled: true,
        kind: 'matos-cli',
        command: command([
          'assets',
          'git',
          'commit-source',
          sourceId,
          '--message',
          'MatOS asset source update',
          '--push',
          '--json',
        ]),
      },
      {
        key: 'accept-source',
        label: 'Accept Source',
        enabled: true,
        kind: 'matos-cli',
        command: command([
          'assets',
          'git',
          'accept',
          sourceId,
          '--channel',
          'stable',
          '--push',
          '--json',
        ]),
      },
      {
        key: 'rollback-source',
        label: 'Rollback Source',
        enabled: Boolean(runtimeRef),
        kind: 'matos-cli',
        command: command(['assets', 'git', 'rollback-pr', sourceId, '--json']),
        ...(runtimeRef ? {} : { reason: 'No accepted runtime ref recorded' }),
      },
    )
  }
  const governance: MatOSWorkbenchGitGovernance = {
    ...(sourceId ? { sourceId } : {}),
    ...(provider ? { provider } : {}),
    ...(firstString(sourceProvenance.scope) ? { scope: firstString(sourceProvenance.scope) } : {}),
    ...(firstString(sourceProvenance.scopeRef)
      ? { scopeRef: firstString(sourceProvenance.scopeRef) }
      : {}),
    ...(firstString(sourceProvenance.repo) ? { repo: firstString(sourceProvenance.repo) } : {}),
    ...(ref ? { ref } : {}),
    ...(runtimeRef ? { runtimeRef } : {}),
    ...(firstString(sourceProvenance.subdir) ? { subdir: firstString(sourceProvenance.subdir) } : {}),
    ...(firstString(sourceProvenance.currentRemote)
      ? { currentRemote: firstString(sourceProvenance.currentRemote) }
      : {}),
    ...(firstString(sourceProvenance.currentCommit)
      ? { currentCommit: firstString(sourceProvenance.currentCommit) }
      : {}),
    ...(Object.keys(gitea).length
      ? {
          repository: {
            ...(firstString(gitea.owner) ? { owner: firstString(gitea.owner) } : {}),
            ...(firstString(gitea.repo) ? { repo: firstString(gitea.repo) } : {}),
            ...(firstString(gitea.visibility)
              ? { visibility: firstString(gitea.visibility) }
              : {}),
            ...(webUrl ? { webUrl } : {}),
            ...(cloneUrl ? { cloneUrl } : {}),
          },
        }
      : {}),
    actions,
  }
  if (!provider && !sourceId && actions.length === 0) {
    return undefined
  }
  return governance
}

export function entryDocumentForAsset(asset: MatOSAsset): unknown[] {
  if (!asset.entryRelativePath) {
    return []
  }
  return [
    {
      id: `${asset.canonicalKey}:entry`,
      name: asset.entryRelativePath.split('/').at(-1) ?? asset.entryRelativePath,
      path: asset.entryRelativePath,
      sourceType: asset.source,
      role: 'entry',
    },
  ]
}

export function defaultApiForToolAsset(asset: MatOSAsset): unknown {
  return {
    id: `${asset.canonicalKey}:default`,
    name: firstString(asset.metadata.apiName, asset.metadata.binding, asset.id) ?? asset.id,
    description: asset.description ?? asset.name,
    method: 'MATOS',
    path: asset.canonicalKey,
    input_schema: objectRecord(asset.metadata.inputSchema),
    output_schema: objectRecord(asset.metadata.outputSchema),
  }
}

export function buildResourceFacets(asset: MatOSAsset): MatOSWorkbenchResourceDetail['facets'] {
  const metadata = objectRecord(asset.metadata)
  const runtime = objectRecord(asset.runtime)
  const schema = objectRecord(metadata.schema)
  const facets: MatOSWorkbenchResourceDetail['facets'] = {}

  if (asset.type === 'knowledge') {
    const documents = unknownArray(
      metadata.documents,
      metadata.files,
      metadata.sources,
    )
    facets.knowledge = {
      ...(firstString(metadata.formatType, metadata.format_type, metadata.kind)
        ? { formatType: firstString(metadata.formatType, metadata.format_type, metadata.kind) }
        : {}),
      documents: documents.length ? documents : entryDocumentForAsset(asset),
      sources: unknownArray(metadata.sources, metadata.sourceRefs),
      ...(metadata.indexing ? { indexing: metadata.indexing } : {}),
      provenance: {
        source: asset.source,
        ...(asset.packId ? { packId: asset.packId } : {}),
        ...(asset.entryRelativePath ? { entry: asset.entryRelativePath } : {}),
      },
    }
  }

  if (
    asset.type === 'data' ||
    asset.type === 'benchmark' ||
    asset.type === 'benchmark-suite' ||
    asset.type === 'evaluation'
  ) {
    const records = unknownArray(metadata.records, metadata.rows, metadata.items)
    const fields = unknownArray(metadata.fields, metadata.columns, schema.fields, schema.columns)
    facets.data = {
      fields,
      recordsPreview: records.slice(0, 50),
      recordCount:
        typeof metadata.recordCount === 'number'
          ? metadata.recordCount
          : typeof metadata.rowCount === 'number'
            ? metadata.rowCount
            : records.length,
      ...(Object.keys(schema).length ? { schema } : {}),
      artifacts: unknownArray(metadata.artifacts, metadata.files),
    }
  }

  if (
    asset.type === 'tool' ||
    asset.type === 'skill' ||
    asset.type === 'plugin' ||
    asset.type === 'mcp'
  ) {
    const apis = unknownArray(metadata.apis, metadata.apiList, metadata.tools, metadata.commands)
    facets.tool = {
      ...(firstString(metadata.binding) ? { binding: firstString(metadata.binding) } : {}),
      ...(firstString(metadata.kind, runtime.kind) ? { kind: firstString(metadata.kind, runtime.kind) } : {}),
      builtinTools: stringArray(metadata.builtinTools),
      mcpServers: stringArray(metadata.mcpServers),
      apis: apis.length ? apis : [defaultApiForToolAsset(asset)],
      commands: unknownArray(metadata.commands, runtime.commands),
      examples: unknownArray(metadata.examples, metadata.samples),
      ...(metadata.runbook ? { runbook: metadata.runbook } : {}),
      ...(metadata.inputSchema ? { inputSchema: metadata.inputSchema } : {}),
      ...(metadata.outputSchema ? { outputSchema: metadata.outputSchema } : {}),
      permissionSummary: asset.permissions,
    }
  }

  return Object.keys(facets).length ? facets : undefined
}

export function buildMatOSWorkbenchResourceDetail(input: {
  asset: MatOSAsset
  cwd: string
  resource: MatOSWorkbenchResource
  graph?: NonNullable<MatOSWorkbenchResourceShow['graph']>
  graphIndex?: Awaited<ReturnType<typeof buildMatOSAssetGraphIndex>>
  relatedEvidence?: MatOSWorkbenchResourceRelatedEvidence
  includeDebug?: boolean
}): MatOSWorkbenchResourceDetail {
  const { asset, resource, graph, graphIndex, relatedEvidence, includeDebug = false } = input
  const selected = graph?.selectedAssetKey || resource.ref
  const outgoing = graphIndex?.edges.filter(edge => edge.from === selected) ?? []
  const incoming = graphIndex?.reverseEdges[selected] ?? []
  const dependencies = dedupeRefsPreferVersioned([
    ...(resource.dependencies ?? []),
    ...(graphIndex ? graphNodeRefsForEdges(graphIndex, outgoing, 'to') : []),
  ])
  const consumers = graphIndex ? graphNodeRefsForEdges(graphIndex, incoming, 'from') : []
  const related = graph?.related ?? []
  const lineage = graph?.lineage
  const workflowRuns = uniqueByStableId([
    ...graphNodesByKind(graph, 'workflow-run'),
    ...(relatedEvidence?.workflowRuns ?? []),
  ])
  const traces = uniqueByStableId([
    ...graphNodesByKind(graph, 'trace'),
    ...resourcesByType(related, 'trace'),
    ...(relatedEvidence?.traces ?? []),
  ])
  const benchmarks = resourcesByType(related, 'benchmark')
  const evaluations = resourcesByType(related, 'evaluation')
  const computeJobs = resourcesByType(related, 'compute-job')
  const historyEvents = lineage?.events ?? []
  const evolutionRecords = uniqueByStableId([
    ...historyEvents,
    ...(relatedEvidence?.evolutionRecords ?? []),
  ])
  const rollbackTargets = lineage?.rollbackTargets ?? []
  const facets = buildResourceFacets(asset)
  const gitGovernance = buildMatOSWorkbenchGitGovernance(asset)
  const entryContent = readMatOSAssetEntryContentForWorkbench(asset)
  const tabs = [
    tab({
      key: 'overview',
      label: 'Overview',
      items: [
        { label: 'Ref', value: resource.ref },
        { label: 'Type', value: resource.type },
        ...(resource.lifecycle ? [{ label: 'Lifecycle', value: resource.lifecycle }] : []),
        ...(resource.version ? [{ label: 'Version', value: resource.version }] : []),
        ...(resource.source ? [{ label: 'Source', value: resource.source }] : []),
      ],
      summary: resource.description || resource.status || resource.type,
    }),
    tab({
      key: 'dependencies',
      label: 'Dependencies',
      items: dependencies,
      summary: `${dependencies.length} upstream asset dependency refs`,
    }),
    tab({
      key: 'consumers',
      label: 'Consumers',
      items: consumers,
      summary: `${consumers.length} downstream asset consumers`,
    }),
    tab({
      key: 'runs',
      label: 'Runs & Traces',
      items: [...workflowRuns, ...traces],
      summary: 'Workflow run and trace evidence linked by the asset graph.',
    }),
    tab({
      key: 'benchmarks',
      label: 'Benchmarks',
      items: [...benchmarks, ...evaluations, ...computeJobs],
      summary: 'Benchmark, evaluation, and compute records related to this asset.',
    }),
    tab({
      key: 'evolution',
      label: 'Evolution',
      items: evolutionRecords,
      summary: lineage?.stableRelease
        ? `Stable release: ${lineage.stableRelease}`
        : 'Evolution and history events for this asset.',
    }),
    tab({
      key: 'history',
      label: 'History & Rollback',
      items: rollbackTargets,
      summary: `${rollbackTargets.length} rollback targets`,
    }),
    tab({
      key: 'raw',
      label: 'Raw',
      items: [
        resource.metadata,
        ...(includeDebug ? [graph?.inspector, graph?.raw] : []),
      ].filter(Boolean),
      summary: includeDebug
        ? 'Redacted MatOS workbench payloads for operator/debug use.'
        : 'Redacted MatOS resource metadata.',
    }),
  ]
  const detail: MatOSWorkbenchResourceDetail = {
    canonicalRef: resource.ref,
    type: resource.type,
    name: resource.name,
    ...(resource.scopeRef ? { scopeRef: resource.scopeRef } : {}),
    ...(resource.lifecycle ? { lifecycle: resource.lifecycle } : {}),
    ...(resource.version ? { version: resource.version } : {}),
    overview: {
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.source ? { source: resource.source } : {}),
      ...(resource.packId ? { packId: resource.packId } : {}),
      tags: resource.tags ?? [],
      metadata: resource.metadata ?? {},
      ...(gitGovernance ? { gitGovernance } : {}),
      actions: resource.actions,
    },
    relationships: {
      dependencies,
      consumers,
      related,
    },
    history: {
      eventCount: historyEvents.length,
      ...(lineage?.stableRelease ? { stableRelease: lineage.stableRelease } : {}),
      rollbackTargets,
      events: historyEvents,
    },
    evidence: {
      workflowRuns,
      traces,
      benchmarks,
      evaluations,
      computeJobs,
      ...(evolutionRecords.length ? { evolutionRecords } : {}),
    },
    ...(entryContent ? { entryContent } : {}),
    ...(facets ? { facets } : {}),
    tabs,
  }
  return redactMatOSAssetOutput(
    redactInternalAssetPaths(asset, detail as unknown as Record<string, unknown>),
    { cwd: input.cwd },
  ) as MatOSWorkbenchResourceDetail
}

export function lineageForAsset(
  asset: MatOSAsset,
  index: Awaited<ReturnType<typeof buildMatOSAssetGraphIndex>> | undefined,
): MatOSWorkbenchResource['lineage'] | undefined {
  if (!index) {
    return undefined
  }
  const summary = index.lineage[asset.canonicalKey]
  const parents = uniqueSorted(
    index.edges
      .filter(edge => edge.to === asset.canonicalKey)
      .map(edge => edge.from),
  )
  const children = uniqueSorted(
    index.edges
      .filter(edge => edge.from === asset.canonicalKey)
      .map(edge => edge.to),
  )
  const releases = uniqueSorted(
    index.edges
      .filter(edge => edge.from === asset.canonicalKey && edge.kind === 'released_as')
      .map(edge => edge.to),
  )
  if (!summary && parents.length === 0 && children.length === 0 && releases.length === 0) {
    return undefined
  }
  return {
    ...(summary?.eventCount !== undefined ? { eventCount: summary.eventCount } : {}),
    ...(summary?.latestEventAt ? { latestEventAt: summary.latestEventAt } : {}),
    ...(summary?.rollbackTargetCount !== undefined
      ? { rollbackTargetCount: summary.rollbackTargetCount }
      : {}),
    ...(parents.length ? { parents } : {}),
    ...(children.length ? { children } : {}),
    ...(releases.length ? { releases } : {}),
  }
}
