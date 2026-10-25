import { redactMatOSAssetOutput } from '../assets/outputRedaction.js';
import { readMatOSProjectConfig } from '../project.js';
import { resolveMatOSRuntimeScope,type MatOSRuntimeScope } from '../runtime/scopes.js';
import type {
MatOSWorkbenchAction,
MatOSWorkbenchContext,
MatOSWorkbenchResource,
MatOSWorkbenchResourceDetail,
MatOSWorkbenchResourceList,
MatOSWorkbenchResourceQuery,
MatOSWorkbenchResourceShow,
} from './types.js';

function command(argv: string[]): { argv: string[]; command: string } {
  return {
    argv,
    command: `matos ${argv.map(arg => JSON.stringify(arg)).join(' ')}`,
  }
}

function runtimeScopeFromRef(ref: string): string | undefined {
  if (!ref.startsWith('runtime:')) {
    return undefined
  }
  const locator = ref.slice('runtime:'.length).trim()
  if (!locator) {
    return undefined
  }
  return locator.startsWith('user:') ? locator : `user:${locator}`
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
    JSON.stringify(resource.metadata ?? {}),
  ].some(value =>
    typeof value === 'string' &&
    value.toLowerCase().includes(needle),
  )
}

async function resolveRuntimeScope(input: MatOSWorkbenchContext & { scopeRef?: string }) {
  const config = await readMatOSProjectConfig(input.cwd)
  return resolveMatOSRuntimeScope(input.cwd, {
    scopeRef: input.scopeRef,
    runtimeDataDir: config.execution?.runtimeDataDir,
    env: input.env,
  })
}

function scopeDirs(scope: MatOSRuntimeScope): Record<string, string> {
  return {
    rootDir: scope.rootDir,
    homeDir: scope.homeDir,
    workspaceDir: scope.workspaceDir,
    sharedWorkspaceDir: scope.sharedWorkspaceDir,
    workspacesDir: scope.workspacesDir,
    logsDir: scope.logsDir,
    assetsDir: scope.assetsDir,
    sessionsDir: scope.sessionsDir,
    workflowsDir: scope.workflowsDir,
    workflowRunsDir: scope.workflowRunsDir,
    cachesDir: scope.cachesDir,
    tmpDir: scope.tmpDir,
    ipcDir: scope.ipcDir,
    containerStateDir: scope.containerStateDir,
  }
}

function runtimeActions(scope: MatOSRuntimeScope): MatOSWorkbenchAction[] {
  return [
    {
      key: 'open',
      label: 'Open Runtime Scope',
      enabled: true,
      maturity: 'route-only',
      command: command(['workbench', 'resources', 'show', `runtime:${scope.ref}`, '--json']),
    },
    {
      key: 'inspect',
      label: 'Inspect Runtime Scope',
      enabled: true,
      maturity: 'route-only',
      command: command(['runtime', 'scopes', 'show', scope.ref, '--json']),
    },
  ]
}

function runtimeResource(scope: MatOSRuntimeScope, cwd: string): MatOSWorkbenchResource {
  const resource: MatOSWorkbenchResource = {
    id: scope.ref,
    ref: `runtime:${scope.ref}`,
    type: 'runtime',
    name: scope.ref,
    description: `MatOS ${scope.kind} runtime scope ${scope.ref}`,
    scopeRef: scope.ref,
    status: 'resolved',
    tags: ['runtime-scope', scope.kind],
    metadata: {
      scopeRef: scope.ref,
      kind: scope.kind,
      id: scope.id,
      dirs: scopeDirs(scope),
      source: 'matos-runtime-scope',
    },
    actions: runtimeActions(scope),
  }
  return redactMatOSAssetOutput(resource, { cwd }) as MatOSWorkbenchResource
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

function runtimeDetail(
  resource: MatOSWorkbenchResource,
  scope: MatOSRuntimeScope,
  cwd: string,
): MatOSWorkbenchResourceDetail {
  const dirs = scopeDirs(scope)
  const detail: MatOSWorkbenchResourceDetail = {
    canonicalRef: resource.ref,
    type: 'runtime',
    name: resource.name,
    scopeRef: scope.ref,
    overview: {
      description: resource.description,
      source: 'matos-runtime-scope',
      tags: resource.tags ?? [],
      metadata: resource.metadata ?? {},
      actions: resource.actions,
    },
    relationships: {
      dependencies: [],
      consumers: [],
      related: [],
    },
    history: {
      eventCount: 0,
      rollbackTargets: [],
      events: [],
    },
    evidence: {
      workflowRuns: [],
      traces: [],
      benchmarks: [],
      evaluations: [],
      computeJobs: [],
      runtimeScopes: [scope],
    },
    tabs: [
      detailTab({
        key: 'overview',
        label: 'Overview',
        items: [
          { label: 'Ref', value: resource.ref },
          { label: 'Scope', value: scope.ref },
          { label: 'Kind', value: scope.kind },
        ],
        summary: resource.description,
      }),
      detailTab({
        key: 'dependencies',
        label: 'Dependencies',
        items: [],
      }),
      detailTab({
        key: 'consumers',
        label: 'Consumers',
        items: [],
      }),
      detailTab({
        key: 'runs',
        label: 'Runs & Traces',
        items: [
          { label: 'Sessions', value: scope.sessionsDir },
          { label: 'Workflow Runs', value: scope.workflowRunsDir },
        ],
      }),
      detailTab({
        key: 'benchmarks',
        label: 'Benchmarks',
        items: [],
      }),
      detailTab({
        key: 'evolution',
        label: 'Evolution',
        items: [],
      }),
      detailTab({
        key: 'history',
        label: 'History & Rollback',
        items: [],
      }),
      detailTab({
        key: 'raw',
        label: 'Raw',
        items: [{ scope, dirs }],
      }),
    ],
  }
  return redactMatOSAssetOutput(detail, { cwd }) as MatOSWorkbenchResourceDetail
}

export async function listMatOSWorkbenchRuntimeResources(
  input: MatOSWorkbenchResourceQuery,
): Promise<MatOSWorkbenchResourceList> {
  const requested = new Set(input.types ?? [])
  if (requested.size > 0 && !requested.has('runtime')) {
    return {
      resources: [],
      groups: [],
      summary: {
        count: 0,
        total: 0,
        offset: input.offset ?? 0,
        limit: input.limit ?? 100,
        typeCounts: {},
      },
    }
  }
  const scope = await resolveRuntimeScope(input)
  const resource = runtimeResource(scope, input.cwd)
  const visible = resourceMatchesQuery(resource, input.query) ? [resource] : []
  const offset = Math.max(0, input.offset ?? 0)
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const resources = visible.slice(offset, offset + limit)
  return {
    resources,
    groups: resources.length ? [{ type: 'runtime', count: resources.length, resources }] : [],
    summary: {
      count: resources.length,
      total: visible.length,
      offset,
      limit,
      typeCounts: visible.length ? { runtime: visible.length } : {},
    },
  }
}

export async function showMatOSWorkbenchRuntimeResource(
  input: MatOSWorkbenchResourceQuery & { ref: string },
): Promise<MatOSWorkbenchResourceShow | undefined> {
  const scopeRef = runtimeScopeFromRef(input.ref)
  if (!scopeRef) {
    return undefined
  }
  const scope = await resolveRuntimeScope({ ...input, scopeRef })
  const resource = runtimeResource(scope, input.cwd)
  return {
    resource,
    detail: runtimeDetail(resource, scope, input.cwd),
  }
}
