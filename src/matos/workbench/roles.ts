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

import { readFile } from 'node:fs/promises'
import {
buildMatOSAssetRegistry,
resolveMatOSRoleReference,
} from '../assets/registry.js'
import { composeMatOSRoleRuntime } from '../assets/runtimeComposition.js'
import { MATOS_ASSET_MOUNT_GROUPS,type MatOSAsset } from '../assets/types.js'
import { buildMatOSRunInvocation,normalizeRoleReference } from '../cli/run.js'
import { parseWorkflowDefinition } from '../workflows/schema.js'
import {
DEFAULT_MATOS_DAEMON_SOCKET,
DEFAULT_MATOS_DAEMON_TOKEN_FILE,
cancelMatOSDaemonJob,
listMatOSDaemonJobs,
readMatOSDaemonJobLedgerFile,
readMatOSDaemonJobOutputSlice,
resolveMatOSDaemonJobsOutputDir,
streamMatOSDaemonChatTurn,
submitMatOSDaemonCommand,
type MatOSDaemonJobRecord,
} from './daemonJobs.js'
import { listMatOSWorkbenchResources,showMatOSWorkbenchResource } from './resources.js'
import { loadMatOSWorkbenchRuntimeAssets } from './runtimeAssetView.js'
import { latestMatOSResumeLinkFromSessionEvents } from './sessionLinks.js'
import {
listMatOSWorkbenchTraces,
showMatOSWorkbenchTrace,
} from './traces.js'
import type {
MatOSWorkbenchAction,
MatOSWorkbenchContext,
MatOSWorkbenchRoleAttachment,
MatOSWorkbenchRoleDebugRunView,
MatOSWorkbenchRoleDebugView,
MatOSWorkbenchRoleDetail,
MatOSWorkbenchRoleJobCancelView,
MatOSWorkbenchRoleJobOutputView,
MatOSWorkbenchRoleJobsView,
MatOSWorkbenchRoleView,
} from './types.js'

export type MatOSWorkbenchRoleSummary = { ref: string; name: string }

export type MatOSWorkbenchRoleSummaryResolution = {
  summaries: Map<string, MatOSWorkbenchRoleSummary>
  missing: string[]
  fallback?: MatOSWorkbenchRoleSummary
}

const HIDDEN_FALLBACK_ROLE_IDS = new Set([
  'direct-asset-editor',
  'experience-refiner',
  'self-evolution-worker',
  'semantic-acceptance-judge',
  'turn-feedback-classifier',
  'user-feedback-critic',
])

function roleSummaryFromAsset(asset: MatOSAsset): MatOSWorkbenchRoleSummary {
  return { ref: asset.canonicalKey, name: asset.name }
}

function selectableFallbackRole(asset: MatOSAsset): boolean {
  return (
    asset.type === 'role' &&
    Boolean(asset.canonicalKey) &&
    asset.lifecycle.status === 'enabled' &&
    !asset.id.startsWith('admin-') &&
    !HIDDEN_FALLBACK_ROLE_IDS.has(asset.id)
  )
}

export async function listMatOSWorkbenchRoles(
  input: MatOSWorkbenchContext & {
    query?: string
    limit?: number
    offset?: number
    lightweight?: boolean
  },
) {
  return listMatOSWorkbenchResources({
    ...input,
    types: ['role'],
    query: input.query,
    limit: input.limit,
    offset: input.offset,
    includeLineage: input.lightweight ? false : true,
    lightweight: input.lightweight,
  })
}

/**
 * Resolve role refs to their canonical key and display name with one shared
 * asset load and no resource-graph construction. Project-group sync needs
 * exactly this pair per team member; the full `showMatOSWorkbenchRole`
 * (graph + detail) costs ~20s per call on container-scale registries, which
 * made every web project creation take twenty-plus seconds.
 */
export async function resolveMatOSWorkbenchRoleSummaryResolution(
  input: MatOSWorkbenchContext & {
    refs: readonly string[]
    fallbackRefs?: readonly string[]
  },
): Promise<MatOSWorkbenchRoleSummaryResolution> {
  const summaries = new Map<string, MatOSWorkbenchRoleSummary>()
  const missing: string[] = []
  const pending = [...new Set(input.refs)].filter(ref => !summaries.has(ref))
  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const registry = buildMatOSAssetRegistry(assets)
  for (const ref of pending) {
    const resolved = resolveMatOSRoleReference(registry, ref)
    if (!resolved) {
      missing.push(ref)
      continue
    }
    summaries.set(ref, roleSummaryFromAsset(resolved.asset))
  }

  let fallback: MatOSWorkbenchRoleSummary | undefined
  for (const ref of input.fallbackRefs ?? ['role:compute']) {
    const resolved = resolveMatOSRoleReference(registry, ref)
    if (resolved && selectableFallbackRole(resolved.asset)) {
      fallback = roleSummaryFromAsset(resolved.asset)
      break
    }
  }
  if (!fallback) {
    const candidate = assets
      .filter(selectableFallbackRole)
      .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey))
      .map(asset => resolveMatOSRoleReference(registry, asset.canonicalKey)?.asset)
      .find((asset): asset is MatOSAsset => Boolean(asset))
    if (candidate) {
      fallback = roleSummaryFromAsset(candidate)
    }
  }
  return { summaries, missing, ...(fallback ? { fallback } : {}) }
}

export async function resolveMatOSWorkbenchRoleSummaries(
  input: MatOSWorkbenchContext & {
    refs: readonly string[]
    allowMissing?: boolean
  },
): Promise<Map<string, MatOSWorkbenchRoleSummary>> {
  if (input.refs.length === 0) return new Map()
  const resolution = await resolveMatOSWorkbenchRoleSummaryResolution(input)
  if (!input.allowMissing && resolution.missing.length > 0) {
    throw new Error(`MatOS role asset not found: ${resolution.missing[0]}`)
  }
  return resolution.summaries
}

export async function showMatOSWorkbenchRole(
  input: MatOSWorkbenchContext & {
    ref: string
    includeComposition?: boolean
    includeInactive?: boolean
  },
): Promise<MatOSWorkbenchRoleView> {
  const assets = await loadMatOSWorkbenchRuntimeAssets(input)
  const lookupRegistry = buildMatOSAssetRegistry(assets, {
    includeDisabled: input.includeInactive,
  })
  const resolved = resolveMatOSRoleReference(lookupRegistry, input.ref)
  if (!resolved) {
    throw new Error(`MatOS role asset not found: ${input.ref}`)
  }
  const asset = resolved.asset
  const runtimeRegistry = input.includeComposition
    ? buildMatOSAssetRegistry(assets)
    : lookupRegistry
  if (
    input.includeComposition &&
    !resolveMatOSRoleReference(runtimeRegistry, asset.canonicalKey)
  ) {
    throw new Error(
      `MatOS role asset is not enabled for runtime composition: ${asset.canonicalKey}`,
    )
  }
  const resource = await showMatOSWorkbenchResource({
    ...input,
    ref: asset.canonicalKey,
    includeGraph: true,
    includeDisabled: input.includeInactive,
    includeHidden: true,
  })
  const composition = input.includeComposition
    ? await composeMatOSRoleRuntime(runtimeRegistry, asset.canonicalKey, {
        projectCwd: input.cwd,
      })
    : undefined
  const detail = await buildMatOSWorkbenchRoleDetail({
    asset,
    composition,
    resource: resource.resource,
    resolveAsset: ref => lookupRegistry.resolve(ref),
  })
  if (!input.includeComposition) {
    return { resource: resource.resource, detail }
  }
  return {
    resource: resource.resource,
    detail,
    composition,
  }
}

export async function composeMatOSWorkbenchRole(
  input: MatOSWorkbenchContext & { ref: string },
) {
  const registry = buildMatOSAssetRegistry(await loadMatOSWorkbenchRuntimeAssets(input))
  const resolved = resolveMatOSRoleReference(registry, input.ref)
  if (!resolved) {
    throw new Error(`MatOS role asset not found: ${input.ref}`)
  }
  return composeMatOSRoleRuntime(registry, resolved.reference, { projectCwd: input.cwd })
}

function unversionedRef(value: string | undefined): string | undefined {
  return value?.replace(/@[^@]+$/, '')
}

function traceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function traceId(value: unknown): string | undefined {
  const record = traceRecord(value)
  return stringValue(record.traceId) ?? stringValue(record.id)
}

function traceRoleRef(value: unknown): string | undefined {
  return stringValue(traceRecord(value).roleRef)
}

function matchesRoleTrace(trace: unknown, refs: Set<string>): boolean {
  const roleRef = traceRoleRef(trace)
  return Boolean(roleRef && (refs.has(roleRef) || refs.has(unversionedRef(roleRef) ?? '')))
}

function roleDebugDaemonLedgerPath(env: Record<string, string | undefined> | undefined): string {
  return stringValue(env?.MATOS_DAEMON_JOB_LEDGER) ?? '/workspace/ipc/matos-daemon-jobs.json'
}

function matchesRoleDaemonJob(
  job: MatOSDaemonJobRecord,
  refs: Set<string>,
  selectedId?: string,
): boolean {
  const roleRef = job.metadata?.roleRef
  const roleMatches = Boolean(
    roleRef && (refs.has(roleRef) || refs.has(unversionedRef(roleRef) ?? '')),
  )
  if (!selectedId) {
    return roleMatches
  }
  return roleMatches && (job.jobId === selectedId || job.metadata?.traceId === selectedId)
}

function filterRoleDaemonJobs(input: {
  jobs: MatOSDaemonJobRecord[]
  refs: Set<string>
  selectedId?: string
}): MatOSDaemonJobRecord[] {
  return input.jobs.filter(job => matchesRoleDaemonJob(job, input.refs, input.selectedId))
}

async function resolveRoleDaemonJobs(input: {
  env?: Record<string, string | undefined>
  refs: Set<string>
  selectedId?: string
}): Promise<{
  jobs: MatOSDaemonJobRecord[]
  source: 'matos-daemon' | 'matos-daemon-ledger'
  daemonError?: string
}> {
  const endpoint = roleDebugRunDaemonEndpoint(input.env)
  try {
    const live = await listMatOSDaemonJobs(endpoint)
    return {
      jobs: filterRoleDaemonJobs({
        jobs: live.jobs,
        refs: input.refs,
        selectedId: input.selectedId,
      }),
      source: 'matos-daemon',
    }
  } catch (error) {
    const daemonError = error instanceof Error ? error.message : String(error)
    try {
      const ledger = readMatOSDaemonJobLedgerFile(roleDebugDaemonLedgerPath(input.env))
      return {
        jobs: filterRoleDaemonJobs({
          jobs: ledger?.jobs ?? [],
          refs: input.refs,
          selectedId: input.selectedId,
        }),
        source: 'matos-daemon-ledger',
        daemonError,
      }
    } catch {
      return {
        jobs: [],
        source: 'matos-daemon-ledger',
        daemonError,
      }
    }
  }
}

function roleJobsOutputDir(
  env: Record<string, string | undefined> | undefined,
): string {
  const explicit = stringValue(env?.MATOS_DAEMON_JOB_OUTPUT_DIR)
  const endpoint = roleDebugRunDaemonEndpoint(env)
  return resolveMatOSDaemonJobsOutputDir({
    ...(explicit ? { jobsOutputDir: explicit } : {}),
    ledgerPath: roleDebugDaemonLedgerPath(env),
    ...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : {}),
  })
}

/**
 * Resolve a single daemon job by id without loading the asset registry, so the
 * role chat stream can poll job status cheaply. Prefers the live daemon and
 * falls back to the persisted ledger.
 */
async function resolveDaemonJobById(
  env: Record<string, string | undefined> | undefined,
  jobId: string,
): Promise<{
  job?: MatOSDaemonJobRecord
  source: 'matos-daemon' | 'matos-daemon-ledger'
  daemonError?: string
}> {
  const matches = (job: MatOSDaemonJobRecord): boolean =>
    job.jobId === jobId || job.metadata?.traceId === jobId
  try {
    const live = await listMatOSDaemonJobs(roleDebugRunDaemonEndpoint(env))
    return { job: live.jobs.find(matches), source: 'matos-daemon' }
  } catch (error) {
    const daemonError = error instanceof Error ? error.message : String(error)
    try {
      const ledger = readMatOSDaemonJobLedgerFile(roleDebugDaemonLedgerPath(env))
      return {
        job: (ledger?.jobs ?? []).find(matches),
        source: 'matos-daemon-ledger',
        daemonError,
      }
    } catch {
      return { source: 'matos-daemon-ledger', daemonError }
    }
  }
}

function daemonJobStatusMessage(job: MatOSDaemonJobRecord): MatOSWorkbenchRoleDebugView['messages'][number] {
  return {
    id: `daemon-job:${job.jobId}`,
    role: 'system',
    type: 'matos.workspace.job.status',
    timestamp: job.completedAt ?? job.startedAt,
    summary: `MatOS role daemon job ${job.status}: ${job.jobId}`,
    payload: {
      job,
    },
  }
}

export async function listMatOSWorkbenchRoleJobs(
  input: MatOSWorkbenchContext & {
    ref: string
    jobId?: string
    traceId?: string
    limit?: number
    offset?: number
  },
): Promise<MatOSWorkbenchRoleJobsView> {
  const role = await showMatOSWorkbenchRole({
    ...input,
    ref: input.ref,
    includeComposition: true,
  })
  const roleRef = role.resource.ref
  const selectedId = stringValue(input.jobId) ?? stringValue(input.traceId)
  const resolved = await resolveRoleDaemonJobs({
    env: input.env,
    refs: acceptedRoleRefsFor({ ref: input.ref, roleRef }),
    selectedId,
  })
  const offset = Number.isInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 0
  const limit = Number.isInteger(input.limit) && Number(input.limit) > 0 ? Math.min(Number(input.limit), 100) : 50
  const selectedJob = selectedId
    ? resolved.jobs.find(job => job.jobId === selectedId || job.metadata?.traceId === selectedId)
    : undefined
  const jobs = resolved.jobs.slice(offset, offset + limit)
  return {
    mode: 'native-role-daemon-jobs',
    readonly: true,
    role,
    jobs,
    ...(selectedJob ? { selectedJob } : {}),
    summary: {
      source: resolved.source,
      roleRef,
      total: resolved.jobs.length,
      returned: jobs.length,
      runningCount: resolved.jobs.filter(job => job.status === 'running').length,
      ...(selectedId ? { selectedJobId: selectedId } : {}),
      ...(resolved.daemonError ? { daemonError: resolved.daemonError } : {}),
    },
    actions: selectedJob ? roleJobActions(roleRef, selectedJob) : [],
  }
}

export async function statusMatOSWorkbenchRoleJob(
  input: MatOSWorkbenchContext & {
    ref: string
    jobId: string
  },
): Promise<MatOSWorkbenchRoleJobsView> {
  const view = await listMatOSWorkbenchRoleJobs({
    ...input,
    jobId: input.jobId,
    limit: 1,
  })
  if (!view.selectedJob) {
    throw new Error(`MatOS role daemon job not found for ${view.role.resource.ref}: ${input.jobId}`)
  }
  return view
}

/**
 * Read incremental captured output for a background role daemon job. Designed
 * for cheap polling from the Agent IDE chat stream: it resolves the job by id
 * (live daemon, then ledger), tails the persisted job output file from a
 * character offset, and reports whether the job has terminated. It does not
 * load the asset registry.
 */
export async function readMatOSWorkbenchRoleJobOutput(
  input: MatOSWorkbenchContext & {
    ref?: string
    jobId: string
    offset?: number
  },
): Promise<MatOSWorkbenchRoleJobOutputView> {
  const jobId = stringValue(input.jobId)
  if (!jobId) {
    throw new Error('MatOS role job output requires a jobId')
  }
  const resolved = await resolveDaemonJobById(input.env, jobId)
  const job = resolved.job
  const status = job?.status
  const jobTerminal =
    status === 'completed' || status === 'failed' || status === 'cancelled'
  const slice = await readMatOSDaemonJobOutputSlice({
    dir: roleJobsOutputDir(input.env),
    jobId: job?.jobId ?? jobId,
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  })
  const roleRef =
    stringValue(job?.metadata?.roleRef) ?? stringValue(input.ref) ?? undefined
  const resume = job?.metadata?.sessionId
    ? await latestMatOSResumeLinkFromSessionEvents({
        cwd: job.cwd || input.cwd,
        env: input.env,
        matosSessionId: job.metadata.sessionId,
        roleRef,
      })
    : undefined
  return {
    mode: 'native-role-job-output',
    readonly: true,
    jobId: job?.jobId ?? jobId,
    ...(roleRef ? { roleRef } : {}),
    ...(status ? { status } : {}),
    output: slice.content,
    offset: slice.offset,
    nextOffset: slice.nextOffset,
    size: slice.size,
    exists: slice.exists,
    done: jobTerminal,
    ...(resume ? { resume } : {}),
    ...(job?.error ? { error: job.error } : {}),
    summary: {
      source: slice.exists ? 'matos-daemon-job-output' : resolved.source,
      ...(roleRef ? { roleRef } : {}),
      jobStatus: status ?? 'unknown',
      outputLength: slice.content.length,
      totalLength: slice.size,
      ...(resolved.daemonError ? { daemonError: resolved.daemonError } : {}),
    },
  }
}

export async function cancelMatOSWorkbenchRoleJob(
  input: MatOSWorkbenchContext & {
    ref: string
    jobId: string
    signal?: string
  },
): Promise<MatOSWorkbenchRoleJobCancelView> {
  const before = await statusMatOSWorkbenchRoleJob(input)
  const roleRef = before.role.resource.ref
  const signal = stringValue(input.signal) ?? 'SIGTERM'
  try {
    const cancelled = await cancelMatOSDaemonJob({
      ...roleDebugRunDaemonEndpoint(input.env),
      jobId: input.jobId,
      signal,
    })
    return {
      mode: 'native-role-daemon-job-control',
      readonly: false,
      appliedAction: 'cancel',
      ok: true,
      role: before.role,
      job: cancelled.job,
      summary: {
        source: 'matos-daemon',
        roleRef,
        jobId: input.jobId,
        status: cancelled.job.status,
        signal,
      },
      actions: roleJobActions(roleRef, cancelled.job),
    }
  } catch (error) {
    return {
      mode: 'native-role-daemon-job-control',
      readonly: false,
      appliedAction: 'cancel',
      ok: false,
      role: before.role,
      job: before.selectedJob,
      error: error instanceof Error ? error.message : String(error),
      summary: {
        source: 'matos-daemon',
        roleRef,
        jobId: input.jobId,
        status: before.selectedJob?.status,
        signal,
      },
      actions: before.selectedJob ? roleJobActions(roleRef, before.selectedJob) : [],
    }
  }
}

function roleJobActions(
  roleRef: string,
  job: MatOSDaemonJobRecord,
): MatOSWorkbenchAction[] {
  return [
    {
      key: 'view-role-job',
      label: 'Inspect Job',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['workbench', 'roles', 'job', roleRef, job.jobId, '--json'],
        command: `matos "workbench" "roles" "job" ${JSON.stringify(roleRef)} ${JSON.stringify(job.jobId)} "--json"`,
      },
    },
    {
      key: 'view-role-job-chat',
      label: 'Inspect Job Messages',
      enabled: true,
      maturity: 'route-only',
      command: {
        argv: ['workbench', 'roles', 'debug', roleRef, '--trace-id', job.jobId, '--json'],
        command: `matos "workbench" "roles" "debug" ${JSON.stringify(roleRef)} "--trace-id" ${JSON.stringify(job.jobId)} "--json"`,
      },
    },
    {
      key: 'cancel-role-job',
      label: 'Cancel Job',
      enabled: job.status === 'running',
      maturity: 'controlled-mutation',
      reason: job.status === 'running'
        ? 'Cancels the native MatOS workspace daemon job for this role run.'
        : `Cannot cancel a role job in ${job.status} state.`,
      command: {
        argv: ['workbench', 'roles', 'cancel-job', roleRef, job.jobId, '--json'],
        command: `matos "workbench" "roles" "cancel-job" ${JSON.stringify(roleRef)} ${JSON.stringify(job.jobId)} "--json"`,
      },
    },
  ]
}

function acceptedRoleRefsFor(input: {
  ref: string
  roleRef: string
}): Set<string> {
  return new Set(
    [input.roleRef, unversionedRef(input.roleRef), input.ref, unversionedRef(input.ref)]
      .filter((value): value is string => Boolean(value)),
  )
}

function roleDebugActions(roleRef: string, selectedTraceId?: string): MatOSWorkbenchAction[] {
  return [
    {
      key: 'debug',
      label: 'Debug Role',
      enabled: false,
      maturity: 'controlled-mutation',
      reason:
        'Role debug execution is not started from this view. It is backed by existing MatOS traces.',
      command: {
        argv: ['workbench', 'roles', 'debug', roleRef, '--json'],
        command: `matos "workbench" "roles" "debug" ${JSON.stringify(roleRef)} "--json"`,
      },
    },
    ...(selectedTraceId
      ? [
          {
            key: 'view-trace' as const,
            label: 'Inspect Trace',
            enabled: true,
            maturity: 'route-only' as const,
            command: {
              argv: ['workbench', 'traces', 'show', selectedTraceId, '--json'],
              command: `matos "workbench" "traces" "show" ${JSON.stringify(selectedTraceId)} "--json"`,
            },
          },
        ]
      : []),
  ]
}

function quoteCommandArg(value: string): string {
  return JSON.stringify(value)
}

function summarizeProjection(projection: unknown): MatOSWorkbenchRoleDebugRunView['invocation']['projection'] | undefined {
  if (!projection || typeof projection !== 'object') {
    return undefined
  }
  const record = projection as Record<string, unknown>
  return {
    ...(stringValue(record.selectedAgent) ? { selectedAgent: stringValue(record.selectedAgent) } : {}),
    appendSystemPromptCount: stringArray(record.appendSystemPrompt).length,
    skillDirCount: stringArray(record.skillDirs).length,
    pluginDirCount: stringArray(record.pluginDirs).length,
    mcpConfigPathCount: stringArray(record.mcpConfigPaths).length,
    mcpConfigJsonCount: stringArray(record.mcpConfigJson).length,
    allowedTools: stringArray(record.allowedTools),
    disallowedTools: stringArray(record.disallowedTools),
    readablePathCount: stringArray(record.readablePaths).length,
    assetToolDirCount: stringArray(record.assetToolDirs).length,
  }
}

function roleRunActions(commandArgv: string[]): MatOSWorkbenchAction[] {
  return [
    {
      key: 'run',
      label: 'Run Role',
      enabled: true,
      maturity: 'route-only',
      reason:
        'This action is backed by a native MatOS run invocation. Submit it through the workspace job runner.',
      command: {
        argv: commandArgv.slice(1),
        command: commandArgv.map(quoteCommandArg).join(' '),
      },
    },
  ]
}

function roleDebugRunDaemonEndpoint(env: Record<string, string | undefined> | undefined): {
  socketPath?: string
  host?: string
  port?: number
  authTokenFile?: string
} {
  const host = stringValue(env?.MATOS_DAEMON_HOST)
  const port = numberValue(env?.MATOS_DAEMON_PORT)
  if (host && port !== undefined) {
    return {
      host,
      port,
      ...(stringValue(env?.MATOS_DAEMON_AUTH_TOKEN_FILE)
        ? { authTokenFile: stringValue(env?.MATOS_DAEMON_AUTH_TOKEN_FILE) }
        : {}),
    }
  }
  return {
    socketPath: stringValue(env?.MATOS_DAEMON_SOCKET) ?? DEFAULT_MATOS_DAEMON_SOCKET,
    authTokenFile:
      stringValue(env?.MATOS_DAEMON_AUTH_TOKEN_FILE) ?? DEFAULT_MATOS_DAEMON_TOKEN_FILE,
  }
}

function roleDebugRunDaemonEnv(input: {
  env?: Record<string, string | undefined>
  roleRef: string
  execution: 'local' | 'container'
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [
    'MATOS_TRACE_ID',
    'MATOS_SESSION_ID',
    'MATOS_SESSION_DIR',
    'MATOS_PARENT_SESSION_ID',
    'MATOS_TURN_ID',
    'MATOS_USER_ID',
    'MATOS_SCOPE_ID',
    'MATOS_PROJECT_ID',
    'MATOS_CONVERSATION_ID',
    'MATOS_PROJECT_CONVERSATION_ID',
    'MATOS_PROJECT_TOPIC_ID',
    'MATOS_PROJECT_AREA_ID',
    'MATOS_PROJECT_MEMBER_ID',
    'MATOS_CHAT_SESSION_ID',
    'MATOS_UPSTREAM_SESSION_ID',
    'MATOS_RESUME_COMMAND',
    'MATOS_RUNTIME_PROFILE_REF',
    'MATOS_BIN',
    'TERM',
    'COLORTERM',
    'FORCE_COLOR',
    'TERM_PROGRAM',
  ]) {
    const value = stringValue(input.env?.[key])
    if (value) {
      env[key] = value
    }
  }
  env.MATOS_ROLE_REF = input.roleRef
  env.MATOS_EXECUTION = input.execution
  env.MATOS_INHERIT_PARENT_RUN_TRACE = '1'
  // Background role runs stream their assistant output progressively so the
  // captured daemon job log can be tailed for live Agent IDE chat.
  env.MATOS_RUN_STREAM_STDOUT = '1'
  env.MATOS_RUN_STREAM_TOOL_EVENTS = '1'
  return env
}

function roleDebugRunMetadata(env: Record<string, string>, roleRef: string, execution: 'local' | 'container') {
  return {
    ...(env.MATOS_TRACE_ID ? { traceId: env.MATOS_TRACE_ID } : {}),
    ...(env.MATOS_SESSION_ID ? { sessionId: env.MATOS_SESSION_ID } : {}),
    ...(env.MATOS_PARENT_SESSION_ID ? { parentSessionId: env.MATOS_PARENT_SESSION_ID } : {}),
    ...(env.MATOS_TURN_ID ? { turnId: env.MATOS_TURN_ID } : {}),
    ...(env.MATOS_USER_ID ? { userId: env.MATOS_USER_ID } : {}),
    ...(env.MATOS_SCOPE_ID ? { scopeRef: env.MATOS_SCOPE_ID } : {}),
    ...(env.MATOS_PROJECT_ID ? { workspaceId: env.MATOS_PROJECT_ID } : {}),
    ...(env.MATOS_PROJECT_ID ? { projectId: env.MATOS_PROJECT_ID } : {}),
    ...(env.MATOS_CONVERSATION_ID || env.MATOS_PROJECT_CONVERSATION_ID
      ? { conversationId: env.MATOS_CONVERSATION_ID ?? env.MATOS_PROJECT_CONVERSATION_ID }
      : {}),
    ...(env.MATOS_PROJECT_TOPIC_ID ? { topicId: env.MATOS_PROJECT_TOPIC_ID } : {}),
    ...(env.MATOS_PROJECT_AREA_ID ? { areaId: env.MATOS_PROJECT_AREA_ID } : {}),
    ...(env.MATOS_CHAT_SESSION_ID
      ? { matosChatSessionId: env.MATOS_CHAT_SESSION_ID }
      : {}),
    ...(env.MATOS_UPSTREAM_SESSION_ID
      ? { upstreamSessionId: env.MATOS_UPSTREAM_SESSION_ID }
      : {}),
    ...(env.MATOS_RESUME_COMMAND ? { resumeCommand: env.MATOS_RESUME_COMMAND } : {}),
    ...(env.MATOS_RUNTIME_PROFILE_REF ? { runtimeRef: env.MATOS_RUNTIME_PROFILE_REF } : {}),
    roleRef,
    execution,
  }
}

function stableChatSessionKey(input: {
  roleRef: string
  chatSessionId: string
}): string {
  return `matos-role-chat:${input.roleRef}:${input.chatSessionId}`
    .replace(/\s+/g, '-')
    .slice(0, 220)
}

function roleChatSessionDaemonEnv(input: {
  env?: Record<string, string | undefined>
  roleRef: string
  conversationId?: string
  chatSessionId: string
  resumeSessionId?: string
}): Record<string, string> {
  const env = roleDebugRunDaemonEnv({
    env: input.env,
    roleRef: input.roleRef,
    execution: 'local',
  })
  env.MATOS_CHAT_SESSION_ID = input.chatSessionId
  if (input.conversationId) {
    env.MATOS_CONVERSATION_ID = input.conversationId
    env.MATOS_PROJECT_CONVERSATION_ID = input.conversationId
    env.MATOS_TRACE_ID = input.conversationId
  }
  if (input.resumeSessionId) {
    env.MATOS_UPSTREAM_SESSION_ID = input.resumeSessionId
  }
  return env
}

function roleDaemonMatOSBin(env: Record<string, string | undefined> | undefined): string {
  return stringValue(env?.MATOS_BIN) ?? stringValue(process.env.MATOS_BIN) ?? '/app/bin/matos'
}

function roleChatSessionDaemonArgv(input: {
  env?: Record<string, string | undefined>
  roleRef: string
  maxTurns?: number
  resumeSessionId?: string
}): string[] {
  return [
    roleDaemonMatOSBin(input.env),
    '--role',
    input.roleRef,
    ...(input.resumeSessionId ? ['--resume', input.resumeSessionId] : []),
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : []),
  ]
}

function roleDebugRunDaemonArgv(input: {
  env?: Record<string, string | undefined>
  roleRef: string
  prompt: string
  maxTurns?: number
  resumeSessionId?: string
}): string[] {
  return [
    roleDaemonMatOSBin(input.env),
    'run',
    '--execution',
    'local',
    '--role',
    input.roleRef,
    ...(input.resumeSessionId ? ['--resume', input.resumeSessionId] : []),
    input.prompt,
    ...(input.maxTurns !== undefined ? ['--max-turns', String(input.maxTurns)] : []),
  ]
}

export async function* streamMatOSWorkbenchRoleChatSessionTurn(
  input: MatOSWorkbenchContext & {
    ref: string
    prompt?: string
    message?: string
    maxTurns?: number
    conversationId?: string
    chatSessionId?: string
    turnId?: string
    resumeSessionId?: string
  },
): AsyncGenerator<Record<string, unknown>> {
  const roleRef = normalizeRoleReference(input.ref)
  const prompt = stringValue(input.prompt) ?? stringValue(input.message)
  if (!prompt) {
    throw new Error('MatOS role chat session stream requires a message')
  }
  const chatSessionId =
    stringValue(input.chatSessionId) ??
    stringValue(input.conversationId) ??
    `matos-role-chat:${roleRef}`
  const sessionKey = stableChatSessionKey({ roleRef, chatSessionId })
  const maxTurns = Number.isInteger(input.maxTurns) && Number(input.maxTurns) > 0
    ? Number(input.maxTurns)
    : undefined
  const daemonEndpoint = roleDebugRunDaemonEndpoint(input.env)
  const daemonEnv = roleChatSessionDaemonEnv({
    env: input.env,
    roleRef,
    chatSessionId,
    conversationId: input.conversationId,
    resumeSessionId: input.resumeSessionId,
  })
  const daemonArgv = roleChatSessionDaemonArgv({
    env: input.env,
    roleRef,
    maxTurns,
    resumeSessionId: input.resumeSessionId,
  })
  const cwd = stringValue(input.env?.MATOS_WORKSPACE_DIR) ?? input.cwd
  for await (const frame of streamMatOSDaemonChatTurn({
    ...daemonEndpoint,
    sessionKey,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    cwd,
    argv: daemonArgv,
    env: daemonEnv,
    message: prompt,
    metadata: roleDebugRunMetadata(daemonEnv, roleRef, 'local'),
    allowedCwdPrefixes: [input.cwd],
  })) {
    if (frame.kind === 'chatStreamAck') {
      const job = frame.job
      yield {
        mode: 'native-role-chat-session-stream',
        type: 'ack',
        executed: true,
        submitted: true,
        readonly: false,
        session: {
          sessionKey,
          turnId: frame.turnId,
          pid: frame.pid,
          roleRef,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          chatSessionId,
          outputOffset: frame.outputOffset,
          status: frame.status,
          ...(frame.upstreamSessionId || input.resumeSessionId
            ? { upstreamSessionId: frame.upstreamSessionId ?? input.resumeSessionId }
            : {}),
        },
        invocation: {
          prompt,
          roleReference: roleRef,
          execution: 'local',
          passthroughArgs: daemonArgv.slice(3),
          selectedAssetKeys: [],
          agentArgCount: daemonArgv.length,
          command: {
            argv: daemonArgv,
            command: daemonArgv.map(quoteCommandArg).join(' '),
          },
          daemon: {
            ...(daemonEndpoint.socketPath ? { socketPath: daemonEndpoint.socketPath } : {}),
            ...(daemonEndpoint.host ? { host: daemonEndpoint.host } : {}),
            ...(daemonEndpoint.port !== undefined ? { port: daemonEndpoint.port } : {}),
          },
        },
        summary: {
          source: 'matos-persistent-cli-session-push-stream',
          promptLength: prompt.length,
          selectedAssetCount: 0,
          agentArgCount: daemonArgv.length,
        },
        job: {
          jobId: sessionKey,
          pid: frame.pid,
          status: frame.status,
          cwd,
          argvPreview: job?.argvPreview ?? daemonArgv.slice(0, 32),
          envKeys: job?.envKeys ?? Object.keys(daemonEnv),
          metadata: job?.metadata ?? roleDebugRunMetadata(daemonEnv, roleRef, 'local'),
        },
        actions: roleRunActions([
          daemonArgv[0] ?? roleDaemonMatOSBin(input.env),
          ...daemonArgv.slice(1),
        ]),
      }
      continue
    }
    if (frame.kind === 'chatStreamEvent') {
      yield {
        mode: 'native-role-chat-session-stream',
        type: 'event',
        sessionKey,
        roleRef,
        chatSessionId,
        turnId: frame.turnId,
        sequence: frame.sequence,
        event: frame.event,
      }
      continue
    }
    yield {
      mode: 'native-role-chat-session-stream',
      type: 'done',
      sessionKey,
      roleRef,
      chatSessionId,
      turnId: frame.turnId,
      status: frame.status,
      outputOffset: frame.outputOffset,
      eventSequence: frame.eventSequence,
      ...(frame.upstreamSessionId ? { upstreamSessionId: frame.upstreamSessionId } : {}),
      ...(frame.error ? { error: frame.error } : {}),
    }
  }
}

export async function prepareMatOSWorkbenchRoleDebugRun(
  input: MatOSWorkbenchContext & {
    ref: string
    prompt?: string
    message?: string
    maxTurns?: number
    execution?: 'local' | 'container'
    submit?: boolean
    resumeSessionId?: string
  },
): Promise<MatOSWorkbenchRoleDebugRunView> {
  const role = await showMatOSWorkbenchRole({
    ...input,
    ref: input.ref,
    includeComposition: true,
  })
  const roleRef = role.resource.ref
  const prompt = stringValue(input.prompt) ?? stringValue(input.message) ?? 'Debug this MatOS role.'
  const maxTurns = Number.isInteger(input.maxTurns) && Number(input.maxTurns) > 0
    ? Number(input.maxTurns)
    : undefined
  const runArgs = [
    '--role',
    roleRef,
    ...(input.execution ? ['--execution', input.execution] : []),
    ...(input.resumeSessionId ? ['--resume', input.resumeSessionId] : []),
    prompt,
    ...(maxTurns !== undefined ? ['--max-turns', String(maxTurns)] : []),
  ]
  const invocation = await buildMatOSRunInvocation(runArgs, input.cwd)
  const commandArgv = ['matos', 'run', ...runArgs]
  const projectionSummary = summarizeProjection(invocation.projection)
  const submitExecution = 'local' as const
  const daemonEndpoint = input.submit ? roleDebugRunDaemonEndpoint(input.env) : undefined
  const daemonEnv = input.submit
    ? roleDebugRunDaemonEnv({
        env: input.env,
        roleRef,
        execution: submitExecution,
      })
    : undefined
  const daemonArgv = input.submit
    ? roleDebugRunDaemonArgv({
        env: input.env,
        roleRef,
        prompt,
        maxTurns,
        resumeSessionId: input.resumeSessionId,
      })
    : undefined
  const submitted = input.submit && daemonEndpoint && daemonEnv && daemonArgv
    ? await submitMatOSDaemonCommand({
        ...daemonEndpoint,
        cwd: stringValue(input.env?.MATOS_WORKSPACE_DIR) ?? input.cwd,
        argv: daemonArgv,
        env: daemonEnv,
        allowedCwdPrefixes: [input.cwd],
      })
    : undefined
  return {
    mode: 'native-role-run-invocation',
    executed: Boolean(submitted),
    ...(submitted ? { submitted: true } : {}),
    readonly: false,
    role,
    invocation: {
      prompt: invocation.prompt,
      roleReference: invocation.roleReference ?? roleRef,
      execution: invocation.execution,
      ...(invocation.containerMode ? { containerMode: invocation.containerMode } : {}),
      ...(invocation.runtimeReference ? { runtimeReference: invocation.runtimeReference } : {}),
      ...(invocation.scopeReference ? { scopeReference: invocation.scopeReference } : {}),
      passthroughArgs: invocation.passthroughArgs,
      selectedAssetKeys: invocation.selectedAssetKeys,
      agentArgCount: invocation.agentArgs.length,
      command: {
        argv: commandArgv,
        command: commandArgv.map(quoteCommandArg).join(' '),
      },
      ...(daemonEndpoint
        ? {
            daemon: {
              ...(daemonEndpoint.socketPath ? { socketPath: daemonEndpoint.socketPath } : {}),
              ...(daemonEndpoint.host ? { host: daemonEndpoint.host } : {}),
              ...(daemonEndpoint.port !== undefined ? { port: daemonEndpoint.port } : {}),
            },
          }
        : {}),
      ...(projectionSummary ? { projection: projectionSummary } : {}),
    },
    summary: {
      source: 'matos-run-invocation',
      selectedAssetCount: invocation.selectedAssetKeys.length,
      agentArgCount: invocation.agentArgs.length,
      promptLength: prompt.length,
    },
    ...(submitted && daemonEnv && daemonArgv
      ? {
          job: {
            jobId: submitted.jobId,
            pid: submitted.pid,
            status: 'running',
            cwd: stringValue(input.env?.MATOS_WORKSPACE_DIR) ?? input.cwd,
            argvPreview: daemonArgv.slice(0, 32),
            envKeys: Object.keys(daemonEnv),
            metadata: roleDebugRunMetadata(daemonEnv, roleRef, submitExecution),
          },
        }
      : {}),
    actions: roleRunActions(commandArgv),
  }
}

export async function debugMatOSWorkbenchRole(
  input: MatOSWorkbenchContext & {
    ref: string
    traceId?: string
    query?: string
    limit?: number
    offset?: number
    lightweight?: boolean
  },
): Promise<MatOSWorkbenchRoleDebugView> {
  const role = await showMatOSWorkbenchRole({
    ...input,
    ref: input.ref,
    includeComposition: input.lightweight ? false : true,
  })
  const roleRef = role.resource.ref
  const acceptedRoleRefs = acceptedRoleRefsFor({ ref: input.ref, roleRef })
  const traceList = await listMatOSWorkbenchTraces({
    ...input,
    query: input.query,
    limit: input.limit ?? 100,
    offset: input.offset,
  })
  const traces = traceList.traces.filter(trace => matchesRoleTrace(trace, acceptedRoleRefs))
  const daemonJobView = await resolveRoleDaemonJobs({
    env: input.env,
    refs: acceptedRoleRefs,
    selectedId: input.traceId,
  })
  const daemonJobs = daemonJobView.jobs.slice(0, 50)
  const selectedSummary = input.traceId
    ? traces.find(trace => traceId(trace) === input.traceId)
    : traces[0]
  const selectedTraceId = traceId(selectedSummary)
  const selectedTraceFull = selectedTraceId
    ? await showMatOSWorkbenchTrace({
        ...input,
        id: selectedTraceId,
      })
    : undefined
  const selectedJob = input.traceId
    ? daemonJobs.find(job => job.jobId === input.traceId || job.metadata?.traceId === input.traceId)
    : undefined
  const messageLimit = input.lightweight
    ? Math.max(1, Math.min(input.limit ?? 50, 50))
    : undefined
  const selectedMessages = selectedTraceFull?.messages ?? []
  const lightweightMessageWindow = messageLimit
    ? Math.max(messageLimit, Math.min(messageLimit * 10, 500))
    : undefined
  const messages = selectedTraceFull
    ? lightweightMessageWindow && selectedMessages.length > lightweightMessageWindow
      ? selectedMessages.slice(selectedMessages.length - lightweightMessageWindow)
      : selectedMessages
    : selectedJob ? [daemonJobStatusMessage(selectedJob)] : []
  const toolCalls = input.lightweight ? [] : selectedTraceFull?.toolCalls ?? []
  const transcriptLinks = selectedTraceFull?.transcriptLinks ?? []
  const artifactLinks = selectedTraceFull?.artifactLinks ?? []
  const selectedTrace = selectedTraceFull && input.lightweight
    ? {
        ...selectedTraceFull,
        sessions: [],
        events: [],
        workflowEvents: [],
        messages,
        toolCalls,
      }
    : selectedTraceFull
  return {
    mode: 'trace-backed-debug',
    executed: false,
    readonly: true,
    role,
    traces,
    ...(daemonJobs.length ? { daemonJobs } : {}),
    ...(selectedTrace ? { selectedTrace } : {}),
    messages,
    toolCalls,
    transcriptLinks,
    artifactLinks,
    summary: {
      traceCount: traces.length,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      transcriptLinkCount: transcriptLinks.length,
      artifactLinkCount: artifactLinks.length,
      ...(daemonJobs.length ? { daemonJobCount: daemonJobs.length } : {}),
      ...(selectedTraceId ? { selectedTraceId } : {}),
      source: 'matos-trace-index',
    },
    actions: roleDebugActions(roleRef, selectedTraceId),
  }
}

function singularAttachmentType(group: string): MatOSWorkbenchRoleAttachment['type'] {
  if (group === 'skills') {
    return 'skill'
  }
  if (group === 'tools') {
    return 'tool'
  }
  if (group === 'workflows') {
    return 'workflow'
  }
  if (group === 'plugins') {
    return 'plugin'
  }
  if (group === 'roles') {
    return 'role'
  }
  if (group === 'knowledge') {
    return 'knowledge'
  }
  if (group === 'data') {
    return 'data'
  }
  if (group === 'mcp') {
    return 'mcp'
  }
  return 'asset'
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function selectedAgentRecord(composition: unknown): Record<string, unknown> | undefined {
  if (!composition || typeof composition !== 'object') {
    return undefined
  }
  const selected = stringValue((composition as { selectedAgent?: unknown }).selectedAgent)
  const agents = (composition as { agents?: unknown }).agents
  if (!agents || typeof agents !== 'object') {
    return undefined
  }
  const agentMap = agents as Record<string, unknown>
  const agent = selected ? agentMap[selected] : Object.values(agentMap)[0]
  return agent && typeof agent === 'object' ? (agent as Record<string, unknown>) : undefined
}

async function workflowAttachmentParameters(
  asset: MatOSAsset | undefined,
): Promise<MatOSWorkbenchRoleAttachment['workflowParameters'] | undefined> {
  if (!asset || asset.type !== 'workflow' || !asset.entryAbsolutePath) {
    return undefined
  }
  try {
    const definition = parseWorkflowDefinition(await readFile(asset.entryAbsolutePath, 'utf8'), {
      sourcePath: asset.entryAbsolutePath,
    })
    const parameters = Object.entries(definition.parameters).map(([key, parameter]) => ({
      key,
      name:
        typeof parameter.title === 'string' && parameter.title.trim()
          ? parameter.title.trim()
          : key,
      ...(typeof parameter.type === 'string' && parameter.type.trim()
        ? { type: parameter.type.trim() }
        : {}),
      ...(typeof parameter.description === 'string' && parameter.description.trim()
        ? { description: parameter.description.trim() }
        : {}),
      ...(typeof parameter.required === 'boolean' ? { required: parameter.required } : {}),
      ...(Object.prototype.hasOwnProperty.call(parameter, 'default')
        ? { defaultValue: parameter.default }
        : {}),
      ...(parameter.schema !== undefined ? { schema: parameter.schema } : {}),
    }))
    return parameters.length ? parameters : undefined
  } catch {
    return undefined
  }
}

async function buildRoleAttachments(input: {
  asset: MatOSAsset
  resolveAsset: (ref: string) => MatOSAsset | undefined
}): Promise<MatOSWorkbenchRoleAttachment[]> {
  const attachments: MatOSWorkbenchRoleAttachment[] = []
  for (const group of MATOS_ASSET_MOUNT_GROUPS) {
    for (const ref of input.asset.mounts[group] ?? []) {
      const resolved = ref.includes(':') ? input.resolveAsset(ref) : undefined
      attachments.push({
        group,
        ref,
        ...(resolved?.canonicalKey ? { resolvedRef: resolved.canonicalKey } : {}),
        type: resolved ? (resolved.type as MatOSWorkbenchRoleAttachment['type']) : singularAttachmentType(group),
        name: resolved?.name ?? ref.replace(/^[^:]+:/, '').replace(/@.*$/, ''),
        ...(resolved?.description ? { description: resolved.description } : {}),
        ...(resolved?.lifecycle.status ? { lifecycle: resolved.lifecycle.status } : {}),
        missing: ref.includes(':') ? !resolved : false,
        ...(group === 'workflows'
          ? { workflowParameters: await workflowAttachmentParameters(resolved) }
          : {}),
      })
    }
  }
  return attachments
}

function groupRoleAttachments(
  attachments: MatOSWorkbenchRoleAttachment[],
): MatOSWorkbenchRoleDetail['attachmentGroups'] {
  const groups: MatOSWorkbenchRoleDetail['attachmentGroups'] = {}
  for (const attachment of attachments) {
    groups[attachment.group] = groups[attachment.group] ?? []
    groups[attachment.group]?.push(attachment)
  }
  return groups
}

async function buildMatOSWorkbenchRoleDetail(input: {
  asset: MatOSAsset
  composition: unknown
  resource: MatOSWorkbenchRoleView['resource']
  resolveAsset: (ref: string) => MatOSAsset | undefined
}): Promise<MatOSWorkbenchRoleDetail> {
  const { asset, composition, resource } = input
  const selectedAgentId =
    composition && typeof composition === 'object'
      ? stringValue((composition as { selectedAgent?: unknown }).selectedAgent)
      : undefined
  const selectedAgent = selectedAgentRecord(composition)
  const attachments = await buildRoleAttachments(input)
  const runtime = composition && typeof composition === 'object'
    ? (composition as Record<string, unknown>)
    : {}
  return {
    roleRef: asset.canonicalKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(selectedAgent
      ? {
          selectedAgent: {
            id: selectedAgentId ?? asset.id,
            name: asset.name,
            ...(stringValue(selectedAgent.description) ? { description: stringValue(selectedAgent.description) } : {}),
            ...(stringValue(selectedAgent.prompt) ? { prompt: stringValue(selectedAgent.prompt) } : {}),
            ...(stringValue(selectedAgent.model) ? { model: stringValue(selectedAgent.model) } : {}),
            ...(selectedAgent.effort !== undefined &&
            (typeof selectedAgent.effort === 'string' || typeof selectedAgent.effort === 'number')
              ? { effort: selectedAgent.effort }
              : {}),
            ...(stringValue(selectedAgent.permissionMode)
              ? { permissionMode: stringValue(selectedAgent.permissionMode) }
              : {}),
            ...(numberValue(selectedAgent.maxTurns) !== undefined
              ? { maxTurns: numberValue(selectedAgent.maxTurns) }
              : {}),
            ...(stringValue(selectedAgent.initialPrompt)
              ? { initialPrompt: stringValue(selectedAgent.initialPrompt) }
              : {}),
            ...(stringValue(selectedAgent.memory) ? { memory: stringValue(selectedAgent.memory) } : {}),
            tools: stringArray(selectedAgent.tools),
            disallowedTools: stringArray(selectedAgent.disallowedTools),
            skills: stringArray(selectedAgent.skills),
            mcpServerCount: Array.isArray(selectedAgent.mcpServers)
              ? selectedAgent.mcpServers.length
              : 0,
          },
        }
      : {}),
    attachments,
    attachmentGroups: groupRoleAttachments(attachments),
    ...(Array.isArray(asset.metadata.workflowMounts)
      ? { workflowMounts: asset.metadata.workflowMounts as MatOSWorkbenchRoleDetail['workflowMounts'] }
      : {}),
    runtime: {
      appendSystemPromptCount: stringArray(runtime.appendSystemPrompt).length,
      skillDirCount: stringArray(runtime.skillDirs).length,
      pluginDirCount: stringArray(runtime.pluginDirs).length,
      mcpConfigPathCount: stringArray(runtime.mcpConfigPaths).length,
      mcpConfigJsonCount: stringArray(runtime.mcpConfigJson).length,
      allowedTools: stringArray(runtime.allowedTools),
      disallowedTools: stringArray(runtime.disallowedTools),
      readablePathCount: stringArray(runtime.readablePaths).length,
      assetToolDirCount: stringArray(runtime.assetToolDirs).length,
      assetEvents: Array.isArray(runtime.assetEvents) ? runtime.assetEvents : [],
    },
    actions: resource.actions,
    ...(resource.warnings ? { warnings: resource.warnings } : {}),
  }
}
