import { matOSWorkflowService } from '../workflows/workflowService.js'
import { buildMatOSWorkbenchRunActions } from './actions.js'
import {
statusMatOSWorkbenchCompute,
type MatOSWorkbenchComputeOptions,
} from './compute.js'
import { redactMatOSWorkbenchValue } from './redaction.js'
import { listMatOSWorkbenchTraces,showMatOSWorkbenchTrace } from './traces.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchResource,
MatOSWorkbenchResourceDetail,
MatOSWorkbenchResourceList,
MatOSWorkbenchResourceQuery,
MatOSWorkbenchResourceShow,
MatOSWorkbenchResourceType,
} from './types.js'
import { workflowTraceRefsFromRunAndEvents } from './workflowTraceRefs.js'

function command(argv: string[]): { argv: string[]; command: string } {
  return {
    argv,
    command: `matos ${argv.map(arg => JSON.stringify(arg)).join(' ')}`,
  }
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

function redactWorkbenchValue(value: unknown): unknown {
  return redactMatOSWorkbenchValue(value).value
}

function redactWorkbenchArray(value: unknown): unknown[] {
  return unknownArray(value).map(redactWorkbenchValue)
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function dynamicTypeRequested(
  requested: Set<string>,
  type: MatOSWorkbenchResourceType,
  input?: { includeByDefault?: boolean },
): boolean {
  return requested.has(type) || (requested.size === 0 && input?.includeByDefault !== false)
}

function resourceMatchesQuery(resource: MatOSWorkbenchResource, query?: string): boolean {
  const needle = query?.trim().toLowerCase()
  if (!needle) {
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
  ].some(value => stringValue(value)?.toLowerCase().includes(needle))
}

function detailTab(input: {
  key: MatOSWorkbenchResourceDetail['tabs'][number]['key']
  label: string
  items?: unknown[]
  summary?: string
}): MatOSWorkbenchResourceDetail['tabs'][number] {
  const items = input.items ?? []
  return {
    key: input.key,
    label: input.label,
    status: items.length ? 'ready' : 'empty',
    count: items.length,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(items.length ? { items } : {}),
  }
}

function dynamicResourceDetail(input: {
  resource: MatOSWorkbenchResource
  related?: unknown[]
  raw?: unknown[]
  workflowRuns?: unknown[]
  traces?: unknown[]
  computeJobs?: unknown[]
  artifacts?: unknown[]
  historyEvents?: unknown[]
}): MatOSWorkbenchResourceDetail {
  const related = input.related ?? []
  const workflowRuns = input.workflowRuns ?? []
  const traces = input.traces ?? []
  const computeJobs = input.computeJobs ?? []
  const artifacts = input.artifacts ?? []
  const historyEvents = input.historyEvents ?? []
  const raw = input.raw ?? []
  return {
    canonicalRef: input.resource.ref,
    type: input.resource.type,
    name: input.resource.name,
    ...(input.resource.scopeRef ? { scopeRef: input.resource.scopeRef } : {}),
    overview: {
      ...(input.resource.description ? { description: input.resource.description } : {}),
      ...(input.resource.source ? { source: input.resource.source } : {}),
      tags: input.resource.tags ?? [],
      metadata: input.resource.metadata ?? {},
      actions: input.resource.actions,
    },
    relationships: {
      dependencies: input.resource.dependencies ?? [],
      consumers: [],
      related,
    },
    history: {
      eventCount: historyEvents.length,
      rollbackTargets: [],
      events: historyEvents,
    },
    evidence: {
      workflowRuns,
      traces,
      benchmarks: [],
      evaluations: [],
      computeJobs,
      ...(artifacts.length ? { artifacts } : {}),
    },
    tabs: [
      detailTab({
        key: 'overview',
        label: 'Overview',
        items: [
          { label: 'Ref', value: input.resource.ref },
          { label: 'Type', value: input.resource.type },
          ...(input.resource.status ? [{ label: 'Status', value: input.resource.status }] : []),
        ],
        summary: input.resource.description || input.resource.status || input.resource.type,
      }),
      detailTab({
        key: 'dependencies',
        label: 'Dependencies',
        items: input.resource.dependencies ?? [],
      }),
      detailTab({
        key: 'consumers',
        label: 'Consumers',
        items: [],
      }),
      detailTab({
        key: 'runs',
        label: 'Runs & Traces',
        items: [...workflowRuns, ...traces, ...artifacts],
      }),
      detailTab({
        key: 'benchmarks',
        label: 'Benchmarks',
        items: computeJobs,
      }),
      detailTab({
        key: 'evolution',
        label: 'Evolution',
        items: [],
      }),
      detailTab({
        key: 'history',
        label: 'History & Rollback',
        items: historyEvents,
      }),
      detailTab({
        key: 'raw',
        label: 'Raw',
        items: raw.length ? raw : [input.resource.metadata ?? {}],
      }),
    ],
  }
}

function artifactActions(runId: string) {
  return [
    {
      key: 'inspect' as const,
      label: 'Inspect Run',
      enabled: true,
      maturity: 'route-only' as const,
      command: command(['workbench', 'workflows', 'inspect', runId, '--json']),
    },
    {
      key: 'view-trace' as const,
      label: 'Run Events',
      enabled: true,
      maturity: 'route-only' as const,
      command: command(['workbench', 'workflows', 'events', runId, '--json']),
    },
  ]
}

function workflowRunResource(input: {
  run: Record<string, unknown>
  snapshot: Record<string, unknown>
  events: unknown[]
}): MatOSWorkbenchResource {
  const runId = stringValue(input.run.runId ?? input.snapshot.runId) ?? 'unknown-run'
  const workflowRef = stringValue(input.run.workflowRef ?? input.snapshot.workflowRef)
  const status = stringValue(input.run.status ?? input.snapshot.status)
  const eventCount = input.events.length
  const artifactCount = unknownArray(input.run.artifacts).length
  const trace = objectRecord(input.run.trace ?? input.snapshot.trace)
  const provenance = objectRecord(input.run.provenance ?? input.snapshot.provenance)
  return {
    id: runId,
    ref: `workflow-run:${runId}`,
    type: 'workflow-run',
    name: workflowRef || runId,
    description: [
      status ? `status=${status}` : undefined,
      workflowRef ? `workflow=${workflowRef}` : undefined,
      `${eventCount} events`,
      `${artifactCount} artifacts`,
    ].filter(Boolean).join(' · '),
    ...(status ? { status } : {}),
    ...(stringValue(input.run.updatedAt ?? input.snapshot.updatedAt)
      ? { updatedAt: stringValue(input.run.updatedAt ?? input.snapshot.updatedAt) }
      : {}),
    dependencies: workflowRef ? [workflowRef] : [],
    metadata: {
      runId,
      workflowRef,
      eventCount,
      artifactCount,
      traceRefs: workflowTraceRefsFromRunAndEvents(
        input.run,
        input.events,
        input.snapshot,
      ),
      ...(Object.keys(trace).length ? { trace } : {}),
      ...(Object.keys(provenance).length ? { provenance } : {}),
    },
    actions: buildMatOSWorkbenchRunActions({
      runId,
      status,
      waitingNodeId: stringValue(input.run.waitingNodeId),
    }),
  }
}

function workflowRunEvidenceItem(input: {
  run: unknown
  snapshot?: unknown
  events?: unknown[]
}): Record<string, unknown> {
  const run = objectRecord(input.run)
  const snapshot = objectRecord(input.snapshot)
  const runId = stringValue(run.runId ?? snapshot.runId)
  const workflowRef = stringValue(run.workflowRef ?? snapshot.workflowRef)
  const status = stringValue(run.status ?? snapshot.status)
  const trace = objectRecord(run.trace ?? snapshot.trace)
  const provenance = objectRecord(run.provenance ?? snapshot.provenance)
  return {
    ...(runId ? { runId, id: `workflow-run:${runId}` } : {}),
    ...(workflowRef ? { workflowRef } : {}),
    ...(status ? { status } : {}),
    traceRefs: workflowTraceRefsFromRunAndEvents(
      run,
      input.events ?? [],
      snapshot,
    ),
    ...(Object.keys(trace).length ? { trace } : {}),
    ...(Object.keys(provenance).length ? { provenance } : {}),
  }
}

async function listWorkflowRunResources(
  input: MatOSWorkbenchContext & { query?: string; limit?: number },
): Promise<MatOSWorkbenchResource[]> {
  const list = await matOSWorkflowService.listRuns({
    ...input,
    query: input.query,
    limit: input.limit ?? 500,
    offset: 0,
  })
  return list.runs
    .map(item => workflowRunResource({
      run: objectRecord(item.run),
      snapshot: objectRecord(item.snapshot),
      events: unknownArray(item.events),
    }))
    .filter(resource => resourceMatchesQuery(resource, input.query))
}

function artifactResource(input: {
  run: Record<string, unknown>
  snapshot: Record<string, unknown>
  artifact: unknown
  index: number
}): MatOSWorkbenchResource {
  const artifact = objectRecord(input.artifact)
  const runId = stringValue(input.run.runId ?? input.snapshot.runId) ?? 'unknown-run'
  const workflowRef = stringValue(input.run.workflowRef ?? input.snapshot.workflowRef)
  const artifactId =
    stringValue(artifact.id) ??
    stringValue(artifact.path) ??
    `${runId}:artifact:${input.index}`
  const kind = stringValue(artifact.kind)
  const mediaType = stringValue(artifact.mediaType)
  const nodeId = stringValue(artifact.nodeId)
  const path = stringValue(artifact.path)
  const updatedAt = stringValue(input.run.updatedAt ?? input.snapshot.updatedAt)
  return {
    id: `${runId}:${artifactId}`,
    ref: `artifact:${runId}:${artifactId}`,
    type: 'artifact',
    name: artifactId,
    description: [
      kind ? `kind=${kind}` : undefined,
      mediaType ? `media=${mediaType}` : undefined,
      nodeId ? `node=${nodeId}` : undefined,
      workflowRef ? `workflow=${workflowRef}` : undefined,
    ].filter(Boolean).join(' · '),
    ...(updatedAt ? { updatedAt } : {}),
    dependencies: [
      workflowRef,
      `workflow-run:${runId}`,
    ].filter((value): value is string => Boolean(value)),
    metadata: {
      artifactId,
      runId,
      workflowRef,
      kind,
      mediaType,
      nodeId,
      path,
      resourceRefs: [
        workflowRef,
        `workflow-run:${runId}`,
        nodeId ? `workflow-node:${nodeId}` : undefined,
        `artifact:${runId}:${artifactId}`,
      ].filter((value): value is string => Boolean(value)),
    },
    actions: artifactActions(runId),
  }
}

async function listArtifactResources(
  input: MatOSWorkbenchContext & { query?: string; limit?: number },
): Promise<MatOSWorkbenchResource[]> {
  const {
    query: _artifactQuery,
    limit: _artifactLimit,
    ...contextInput
  } = input
  const list = await matOSWorkflowService.listRuns({
    ...contextInput,
    limit: input.limit ?? 500,
    offset: 0,
  })
  return list.runs
    .flatMap(item => unknownArray(item.run.artifacts).map((artifact, index) =>
      artifactResource({
        run: objectRecord(item.run),
        snapshot: objectRecord(item.snapshot),
        artifact,
        index,
      }),
    ))
    .filter(resource => resourceMatchesQuery(resource, input.query))
}

function computeProcessesFromGpuStatus(gpu: Record<string, unknown>): unknown[] {
  const processList =
    unknownArray(gpu.computeProcesses).length > 0 ? gpu.computeProcesses :
      unknownArray(gpu.processes).length > 0 ? gpu.processes :
        gpu.process_list
  return unknownArray(processList)
}

function computeActions() {
  return [
    {
      key: 'inspect' as const,
      label: 'Refresh GPU Status',
      enabled: true,
      maturity: 'route-only' as const,
      command: command(['workbench', 'compute', 'status', '--json']),
    },
    {
      key: 'validate' as const,
      label: 'Run Dry-Run Conflict Check',
      enabled: true,
      maturity: 'route-only' as const,
      command: command(['workbench', 'compute', 'check', '--dry-run', '--json']),
    },
  ]
}

function computeJobResource(processValue: unknown, index: number): MatOSWorkbenchResource {
  const process = objectRecord(processValue)
  const pid = numberValue(process.pid)
  const gpuIndex = numberValue(process.gpuIndex ?? process.gpu_index)
  const memoryUsedMiB = numberValue(
    process.memory_used_mib ??
      process.usedMemoryMiB ??
      process.usedGpuMemoryMiB ??
      process.memoryUsedMiB,
  )
  const username = stringValue(process.username ?? process.user)
  const commandText = stringValue(process.command ?? process.cmdline)
  const processName = stringValue(process.processName)
  const ownerKind = stringValue(process.ownerKind ?? process.owner_kind)
  const container = stringValue(process.container ?? process.containerName)
  const external = process.external === true
  const actionable = process.actionable === true
  const status = stringValue(process.classification) ?? (external ? 'external' : ownerKind || 'workspace')
  const jobId =
    stringValue(process.jobId ?? process.job_id) ??
    (pid !== undefined ? `pid:${pid}` : `process:${index}`)
  const dependencies = [
    gpuIndex !== undefined ? `gpu:${gpuIndex}` : undefined,
    container ? `runtime:${container}` : undefined,
  ].filter((value): value is string => Boolean(value))
  return {
    id: jobId,
    ref: `compute-job:${jobId}`,
    type: 'compute-job',
    name: commandText || (processName === '[Not Found]' ? undefined : processName) || username || jobId,
    description: [
      pid !== undefined ? `pid=${pid}` : undefined,
      gpuIndex !== undefined ? `gpu=${gpuIndex}` : undefined,
      memoryUsedMiB !== undefined ? `memory=${memoryUsedMiB} MiB` : undefined,
      username ? `user=${username}` : undefined,
      external ? 'external' : 'matos',
    ].filter(Boolean).join(' · '),
    status,
    dependencies,
    metadata: {
      jobId,
      pid,
      username,
      command: commandText,
      gpuIndex,
      memoryUsedMiB,
      ownerKind,
      container,
      external,
      actionable,
      resourceRefs: [`compute-job:${jobId}`, ...dependencies],
    },
    actions: computeActions(),
  }
}

async function listComputeJobResources(
  input: MatOSWorkbenchResourceQuery,
): Promise<MatOSWorkbenchResource[]> {
  const compute = await statusMatOSWorkbenchCompute({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    env: input.env,
    scriptRunner: input.scriptRunner as MatOSWorkbenchComputeOptions['scriptRunner'],
  })
  const resources = computeProcessesFromGpuStatus(objectRecord(compute.gpu))
    .map(computeJobResource)
    .filter(resource => resourceMatchesQuery(resource, input.query))
  return resources
}

export async function listMatOSWorkbenchDynamicResources(
  input: MatOSWorkbenchResourceQuery,
): Promise<MatOSWorkbenchResourceList> {
  const requested = new Set(input.types ?? [])
  const lookups: Array<Promise<MatOSWorkbenchResource[]>> = []
  if (dynamicTypeRequested(requested, 'trace')) {
    lookups.push(
      listMatOSWorkbenchTraces({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        query: input.query,
        includeHidden: input.includeHidden,
        limit: 500,
        offset: 0,
      })
        .then(result => result.resources)
        .catch(() => []),
    )
  }
  if (dynamicTypeRequested(requested, 'workflow-run')) {
    lookups.push(listWorkflowRunResources(input).catch(() => []))
  }
  if (dynamicTypeRequested(requested, 'artifact', { includeByDefault: false })) {
    lookups.push(listArtifactResources(input).catch(() => []))
  }
  if (dynamicTypeRequested(requested, 'compute-job', { includeByDefault: false })) {
    lookups.push(listComputeJobResources(input).catch(() => []))
  }
  const resources = (await Promise.all(lookups)).flat()
  const visible = resources
    .filter(resource => resourceMatchesQuery(resource, input.query))
    .sort((left, right) => left.ref.localeCompare(right.ref))
  const typeCounts: Record<string, number> = {}
  for (const resource of visible) {
    typeCounts[resource.type] = (typeCounts[resource.type] ?? 0) + 1
  }
  return {
    resources: visible,
    groups: Object.entries(
      visible.reduce<Record<string, MatOSWorkbenchResource[]>>((groups, resource) => {
        groups[resource.type] = [...(groups[resource.type] ?? []), resource]
        return groups
      }, {}),
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, grouped]) => ({
        type: type as MatOSWorkbenchResourceType,
        count: grouped.length,
        resources: grouped,
      })),
    summary: {
      count: visible.length,
      total: visible.length,
      offset: 0,
      limit: input.limit ?? 100,
      typeCounts,
    },
  }
}

export async function showMatOSWorkbenchDynamicResource(
  input: MatOSWorkbenchResourceQuery & { ref: string },
): Promise<MatOSWorkbenchResourceShow | undefined> {
  if (input.ref.startsWith('trace:')) {
    const traceId = input.ref.slice('trace:'.length)
    const [list, detail] = await Promise.all([
      listMatOSWorkbenchTraces({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        includeHidden: input.includeHidden,
        limit: 500,
        offset: 0,
      }),
      showMatOSWorkbenchTrace({ cwd: input.cwd, scopeRef: input.scopeRef, id: traceId }).catch(() => undefined),
    ])
    const resource = list.resources.find(item => item.ref === input.ref || item.id === traceId)
    if (!resource || !detail) {
      return undefined
    }
    return {
      resource,
      detail: dynamicResourceDetail({
        resource,
        traces: [detail.trace],
        historyEvents: detail.messages,
        raw: [detail],
      }),
    }
  }
  if (input.ref.startsWith('workflow-run:')) {
    const runId = input.ref.slice('workflow-run:'.length)
    const result = await matOSWorkflowService.inspect({
      cwd: input.cwd,
      scopeRef: input.scopeRef,
      runId,
    }).catch(() => undefined)
    if (!result) {
      return undefined
    }
    const [events, artifacts, approvals] = await Promise.all([
      matOSWorkflowService.events({ cwd: input.cwd, scopeRef: input.scopeRef, runId }).catch(() => ({ events: [] })),
      matOSWorkflowService.artifacts({ cwd: input.cwd, scopeRef: input.scopeRef, runId }).catch(() => ({ artifacts: [] })),
      matOSWorkflowService.approvalStatus({ cwd: input.cwd, scopeRef: input.scopeRef, runId }).catch(() => undefined),
    ])
    const safeRun = redactWorkbenchValue(result.run)
    const safeEvents = redactWorkbenchArray(objectRecord(events).events)
    const safeArtifacts = redactWorkbenchArray(objectRecord(artifacts).artifacts)
    const safeApprovals = redactWorkbenchValue(approvals)
    const safeResult = { ...result, run: safeRun }
    const run = objectRecord(safeRun)
    const resource = workflowRunResource({
      run,
      snapshot: run,
      events: safeEvents,
    })
    return {
      resource,
      detail: dynamicResourceDetail({
        resource,
        workflowRuns: [
          workflowRunEvidenceItem({
            run: safeRun,
            events: safeEvents,
          }),
        ],
        related: [...safeArtifacts, safeApprovals].filter(Boolean),
        historyEvents: safeEvents,
        raw: [
          safeResult,
          { ...events, events: safeEvents },
          { ...artifacts, artifacts: safeArtifacts },
          safeApprovals,
        ],
      }),
    }
  }
  if (input.ref.startsWith('artifact:')) {
    const locator = input.ref.slice('artifact:'.length)
    const separator = locator.indexOf(':')
    if (separator <= 0) {
      return undefined
    }
    const runId = locator.slice(0, separator)
    const artifactId = locator.slice(separator + 1)
    const [result, events, artifacts, runList] = await Promise.all([
      matOSWorkflowService.inspect({ cwd: input.cwd, scopeRef: input.scopeRef, runId }).catch(() => undefined),
      matOSWorkflowService.events({ cwd: input.cwd, scopeRef: input.scopeRef, runId }).catch(() => ({ events: [] })),
      matOSWorkflowService.artifacts({ cwd: input.cwd, scopeRef: input.scopeRef, runId }).catch(() => ({ artifacts: [] })),
      matOSWorkflowService.listRuns({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        limit: 500,
        offset: 0,
      }).catch(() => undefined),
    ])
    if (!result) {
      return undefined
    }
    const safeRun = redactWorkbenchValue(result.run)
    const safeEvents = redactWorkbenchArray(objectRecord(events).events)
    const safeArtifacts = redactWorkbenchArray(objectRecord(artifacts).artifacts)
    const safeResult = { ...result, run: safeRun }
    const artifact = safeArtifacts
      .find(item => {
        const record = objectRecord(item)
        return stringValue(record.id) === artifactId ||
          stringValue(record.path) === artifactId ||
          `artifact:${runId}:${stringValue(record.id) ?? stringValue(record.path) ?? ''}` === input.ref
      })
    if (!artifact) {
      return undefined
    }
    const run = objectRecord(safeRun)
    const snapshot = objectRecord(
      runList?.runs.find(item =>
        stringValue(item.run.runId) === runId ||
        stringValue(item.snapshot.runId) === runId
      )?.snapshot,
    )
    const resource = artifactResource({
      run,
      snapshot,
      artifact,
      index: 0,
    })
    return {
      resource,
      detail: dynamicResourceDetail({
        resource,
        workflowRuns: [
          workflowRunEvidenceItem({
            run: safeRun,
            snapshot,
            events: safeEvents,
          }),
        ],
        artifacts: [artifact],
        historyEvents: safeEvents,
        raw: [artifact, safeResult, { ...events, events: safeEvents }],
      }),
    }
  }
  if (input.ref.startsWith('compute-job:')) {
    const list = await listComputeJobResources(input).catch(() => [])
    const resource = list.find(item => item.ref === input.ref || item.id === input.ref.slice('compute-job:'.length))
    if (!resource) {
      return undefined
    }
    return {
      resource,
      detail: dynamicResourceDetail({
        resource,
        computeJobs: [resource.metadata ?? {}],
        raw: [resource.metadata ?? {}],
      }),
    }
  }
  return undefined
}
