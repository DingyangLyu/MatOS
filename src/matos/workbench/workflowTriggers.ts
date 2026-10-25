import { mkdir,readFile,readdir,rename,rm,stat,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MatOSWorkbenchContext } from './types.js'

export type MatOSWorkbenchWorkflowTriggerEvent = {
  eventId: string
  eventName: string
  description: string
  inputSchema: Record<string, unknown>
}

export type MatOSWorkbenchWorkflowTriggerApp = {
  appId: string
  name: string
  description: string
  iconUrl: string
  events: MatOSWorkbenchWorkflowTriggerEvent[]
}

// Scheduler bookkeeping persisted alongside the trigger so cron firing
// survives process restarts. `cron` snapshots the expression the nextFireAt
// was computed from; when the stored config changes, the scheduler re-arms.
export type MatOSWorkbenchWorkflowTriggerSchedulerState = {
  cron?: string
  timezone?: string
  nextFireAt?: number
  lastFiredAt?: number
  lastRunId?: string
  lastError?: string
  updatedAt?: number
}

export type MatOSWorkbenchWorkflowTriggerRecord = {
  triggerId: string
  workflowRef: string
  appId: string
  eventId: string
  name: string
  config: Record<string, unknown>
  payload: Record<string, unknown>
  status: number
  createTime: number
  updateTime: number
  scheduler?: MatOSWorkbenchWorkflowTriggerSchedulerState
}

export type MatOSWorkbenchWorkflowTriggerCatalog = {
  mode: 'native-workflow-trigger-catalog'
  triggerApps: MatOSWorkbenchWorkflowTriggerApp[]
  total: number
}

export type MatOSWorkbenchWorkflowTriggerDetail = {
  mode: 'native-workflow-trigger-detail'
  workflowRef: string
  trigger: MatOSWorkbenchWorkflowTriggerRecord | null
  triggerApps: MatOSWorkbenchWorkflowTriggerApp[]
}

export type MatOSWorkbenchWorkflowTriggerMutationResult = {
  mode: 'native-workflow-trigger-mutation'
  applied: boolean
  workflowRef: string
  trigger: MatOSWorkbenchWorkflowTriggerRecord | null
  validation: { ok: boolean; errors: Array<{ code: string; message: string }> }
}

export type MatOSWorkbenchWorkflowTriggerList = {
  mode: 'native-workflow-trigger-list'
  workflowRef: string
  triggers: MatOSWorkbenchWorkflowTriggerRecord[]
  total: number
  triggerApps: MatOSWorkbenchWorkflowTriggerApp[]
}

// Coze start-node and trigger-upsert forms parse input_schema as
// schema.properties.{start_node,trigger_node} maps of FormItemMeta keyed by
// config field name, and only register the CronJobSelect and Timezone setters.
const COZE_CRON_FORM_PROPERTIES = {
  crontab: {
    order: 1,
    label: 'Schedule (cron)',
    required: true,
    setter: 'CronJobSelect',
    setterProps: { defaultValue: '0 0 0 * * *' },
  },
  timezone: {
    order: 2,
    label: 'Timezone',
    setter: 'Timezone',
    setterProps: { defaultValue: 'Asia/Shanghai' },
  },
}

// The schedule app must stay first: the Coze trigger form meta fetcher reads
// trigger_apps[0].events[0] as the schedulable event.
const BUILTIN_TRIGGER_APPS: MatOSWorkbenchWorkflowTriggerApp[] = [
  {
    appId: 'matos-schedule',
    name: 'MatOS Schedule',
    description: 'Schedule recurring or cron-based workflow execution inside MatOS.',
    iconUrl: '',
    events: [
      {
        eventId: 'matos.schedule.cron',
        eventName: 'Cron schedule',
        description: 'Run the workflow on a cron expression managed by MatOS.',
        inputSchema: {
          type: 'object',
          properties: {
            crontab: { type: 'string' },
            cron: { type: 'string' },
            timezone: { type: 'string' },
            parameters: { type: 'object' },
          },
          schema: {
            properties: {
              start_node: COZE_CRON_FORM_PROPERTIES,
              trigger_node: COZE_CRON_FORM_PROPERTIES,
            },
          },
        },
      },
    ],
  },
  {
    appId: 'matos-manual',
    name: 'MatOS Manual',
    description: 'Start the workflow from the MatOS CLI or the workspace.',
    iconUrl: '',
    events: [
      {
        eventId: 'matos.manual.run',
        eventName: 'Manual run',
        description: 'Run the workflow on demand through native MatOS workflow controls.',
        inputSchema: { type: 'object', properties: { parameters: { type: 'object' } } },
      },
    ],
  },
  {
    appId: 'matos-api',
    name: 'MatOS API',
    description: 'Expose a MatOS-managed webhook entry for workflow execution.',
    iconUrl: '',
    events: [
      {
        eventId: 'matos.api.webhook',
        eventName: 'Webhook',
        description: 'Invoke the workflow through a MatOS gateway webhook route.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            secretRef: { type: 'string' },
            parameters: { type: 'object' },
          },
        },
      },
    ],
  },
]

function triggerStoreDir(cwd: string): string {
  return join(cwd, '.matos', 'workbench', 'workflow-triggers')
}

function triggerStorePath(cwd: string, workflowRef: string): string {
  const safe = workflowRef.replace(/[^a-zA-Z0-9._:@-]+/g, '_')
  return join(triggerStoreDir(cwd), `${safe}.json`)
}

// Firing-lease path for the trigger scheduler. Lease files share the store
// directory but never use the `.json` suffix that store readers scan for.
export function workflowTriggerFiringLeasePath(
  cwd: string,
  workflowRef: string,
  triggerId: string,
): string {
  const safeRef = workflowRef.replace(/[^a-zA-Z0-9._:@-]+/g, '_')
  const safeTrigger = triggerId.replace(/[^a-zA-Z0-9._:@-]+/g, '_')
  return join(triggerStoreDir(cwd), `${safeRef}.${safeTrigger}.firing.lock`)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// Coze save_trigger sends config/payload as JSON strings; native callers may
// send plain objects. Accept both without losing user-entered configuration,
// and treat blank/invalid strings as "not provided" so they cannot wipe the
// stored values. An explicit '{}' (string or object) still clears them.
function parseRecordish(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    if (!value.trim()) {
      return undefined
    }
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function parseSchedulerState(
  value: unknown,
): MatOSWorkbenchWorkflowTriggerSchedulerState | undefined {
  const record = asRecord(value)
  if (!Object.keys(record).length) {
    return undefined
  }
  const state: MatOSWorkbenchWorkflowTriggerSchedulerState = {}
  const cron = firstString(record.cron)
  const timezone = firstString(record.timezone)
  const lastRunId = firstString(record.lastRunId)
  const lastError = firstString(record.lastError)
  if (cron) state.cron = cron
  if (timezone) state.timezone = timezone
  if (lastRunId) state.lastRunId = lastRunId
  if (lastError) state.lastError = lastError
  for (const key of ['nextFireAt', 'lastFiredAt', 'updatedAt'] as const) {
    const numeric = Number(record[key])
    if (Number.isFinite(numeric) && numeric > 0) {
      state[key] = numeric
    }
  }
  return Object.keys(state).length ? state : undefined
}

function parseTriggerRecord(
  workflowRef: string,
  value: unknown,
): MatOSWorkbenchWorkflowTriggerRecord | null {
  const record = asRecord(value)
  const triggerId = firstString(record.triggerId, record.trigger_id, record.id)
  const eventId = firstString(record.eventId, record.event_id)
  if (!triggerId || !eventId) {
    return null
  }
  const now = Date.now()
  const scheduler = parseSchedulerState(record.scheduler)
  return {
    triggerId,
    workflowRef,
    appId: firstString(record.appId, record.app_id, 'matos-manual'),
    eventId,
    name: firstString(record.name, eventId),
    config: asRecord(record.config),
    payload: asRecord(record.payload),
    status: Number.isFinite(Number(record.status)) ? Number(record.status) : 1,
    createTime: Number.isFinite(Number(record.createTime ?? record.create_time))
      ? Number(record.createTime ?? record.create_time)
      : now,
    updateTime: Number.isFinite(Number(record.updateTime ?? record.update_time))
      ? Number(record.updateTime ?? record.update_time)
      : now,
    ...(scheduler ? { scheduler } : {}),
  }
}

async function readTriggerStore(
  cwd: string,
  workflowRef: string,
): Promise<MatOSWorkbenchWorkflowTriggerRecord[]> {
  try {
    const raw = await readFile(triggerStorePath(cwd, workflowRef), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const record = asRecord(parsed)
    const triggers = Array.isArray(record.triggers) ? record.triggers : []
    return triggers
      .map(item => parseTriggerRecord(workflowRef, item))
      .filter((item): item is MatOSWorkbenchWorkflowTriggerRecord => Boolean(item))
  } catch {
    return []
  }
}

let triggerStoreWriteSequence = 0

async function writeTriggerStore(
  cwd: string,
  workflowRef: string,
  triggers: MatOSWorkbenchWorkflowTriggerRecord[],
): Promise<void> {
  const dir = triggerStoreDir(cwd)
  await mkdir(dir, { recursive: true })
  const path = triggerStorePath(cwd, workflowRef)
  // Atomic replace: concurrent scheduler ticks and Coze panel saves must
  // never observe a torn store file. The sequence keeps tmp names unique for
  // same-millisecond writes inside one process.
  triggerStoreWriteSequence += 1
  const tmp = `${path}.${process.pid}.${triggerStoreWriteSequence}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify({ workflowRef, triggers }, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

// Serialize read-modify-write mutations to the trigger store. The store write
// itself is atomic (tmp + rename), but two callers that read the same snapshot,
// mutate different triggers, and write back would otherwise drop one update
// (for example a scheduler tick re-arming one trigger while a Coze panel save
// edits another in the same store file). A directory create is atomic on POSIX
// filesystems; a lock left by a crashed holder is reclaimed once it is older
// than the stale bound. The `.store.lock` directory shares the store dir but is
// skipped by the `.json`-only store readers.
const TRIGGER_STORE_LOCK_TIMEOUT_MS = 5000
const TRIGGER_STORE_LOCK_POLL_MS = 25
const TRIGGER_STORE_LOCK_STALE_MS = 60_000

async function withTriggerStoreLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const dir = triggerStoreDir(cwd)
  await mkdir(dir, { recursive: true })
  const lockDir = join(dir, '.store.lock')
  const metadataPath = join(lockDir, 'lock.json')
  const deadline = Date.now() + TRIGGER_STORE_LOCK_TIMEOUT_MS
  let acquired = false
  while (!acquired) {
    try {
      await mkdir(lockDir)
      acquired = true
      await writeFile(
        metadataPath,
        `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`,
        'utf8',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      let reclaimed = false
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > TRIGGER_STORE_LOCK_STALE_MS) {
          // Steal the stale lock atomically: rename it aside before removing it
          // so two processes racing to reclaim the same crashed lock cannot both
          // delete each other's fresh lock and end up both "holding" it. Only
          // one rename can succeed; the loser retries the create below.
          const stealPath = `${lockDir}.stale-${process.pid}-${Date.now()}`
          try {
            await rename(lockDir, stealPath)
            await rm(stealPath, { recursive: true, force: true })
          } catch {
            // Another acquirer won the steal; just retry the create.
          }
          reclaimed = true
        }
      } catch {
        // The lock vanished between the failed create and the stat; retry now.
        reclaimed = true
      }
      if (!reclaimed) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for workflow trigger store lock: ${dir}`)
        }
        await delay(TRIGGER_STORE_LOCK_POLL_MS)
      }
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function readAllTriggerStores(
  cwd: string,
): Promise<MatOSWorkbenchWorkflowTriggerRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(triggerStoreDir(cwd))
  } catch {
    return []
  }
  const records: MatOSWorkbenchWorkflowTriggerRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    try {
      const raw = await readFile(join(triggerStoreDir(cwd), entry), 'utf8')
      const parsed = asRecord(JSON.parse(raw))
      const workflowRef = firstString(parsed.workflowRef, parsed.workflow_ref)
      const triggers = Array.isArray(parsed.triggers) ? parsed.triggers : []
      for (const item of triggers) {
        const record = parseTriggerRecord(workflowRef, item)
        if (record) {
          records.push(record)
        }
      }
    } catch {
      continue
    }
  }
  return records
}

// Coze operate_publish_trigger and delete_trigger requests carry only
// trigger_id (no workflow_id), so the store must support resolving the owning
// workflow from the trigger id alone.
async function findTriggerAcrossStores(
  cwd: string,
  triggerId: string,
): Promise<MatOSWorkbenchWorkflowTriggerRecord | undefined> {
  const records = await readAllTriggerStores(cwd)
  return records.find(item => item.triggerId === triggerId)
}

// Coze SaveTrigger requests carry event_id but no app_id, so the event must
// resolve across every builtin app and backfill the owning app id.
function resolveEventAcrossApps(
  requestedAppId: string,
  eventId: string,
): { appId: string; event: MatOSWorkbenchWorkflowTriggerEvent } | undefined {
  if (requestedAppId) {
    const app = BUILTIN_TRIGGER_APPS.find(item => item.appId === requestedAppId)
    const event = app?.events.find(item => item.eventId === eventId)
    return event ? { appId: requestedAppId, event } : undefined
  }
  for (const app of BUILTIN_TRIGGER_APPS) {
    const event = app.events.find(item => item.eventId === eventId)
    if (event) {
      return { appId: app.appId, event }
    }
  }
  return undefined
}

const CRON_FIELD_PATTERN = /^[0-9A-Za-z*,/?#LW-]+$/

// Lightweight cron shape check so broken schedules are rejected at save time
// instead of surfacing later when a scheduler consumes the trigger store.
// The Coze trigger form stores the expression as config.crontab (6-field,
// seconds-first) and auto-saves drafts before the user has typed anything, so
// a missing/empty value must stay accepted as a draft.
function validateTriggerConfig(
  eventId: string,
  config: Record<string, unknown>,
): Array<{ code: string; message: string }> {
  if (eventId !== 'matos.schedule.cron') {
    return []
  }
  const cronValue = config.crontab ?? config.cron
  if (cronValue === undefined || cronValue === null || cronValue === '') {
    return []
  }
  const cron = typeof cronValue === 'string' ? cronValue.trim() : ''
  const fields = cron ? cron.split(/\s+/) : []
  if (
    !cron ||
    fields.length < 5 ||
    fields.length > 6 ||
    !fields.every(field => CRON_FIELD_PATTERN.test(field))
  ) {
    return [
      {
        code: 'invalid_cron_expression',
        message: `Cron expression ${JSON.stringify(cronValue)} must use 5 or 6 whitespace-separated cron fields.`,
      },
    ]
  }
  return []
}

export function listMatOSWorkbenchWorkflowTriggerEvents(): MatOSWorkbenchWorkflowTriggerCatalog {
  return {
    mode: 'native-workflow-trigger-catalog',
    triggerApps: BUILTIN_TRIGGER_APPS,
    total: BUILTIN_TRIGGER_APPS.length,
  }
}

export async function listMatOSWorkbenchWorkflowTriggers(
  input: MatOSWorkbenchContext & {
    workflowRef?: string
  },
): Promise<MatOSWorkbenchWorkflowTriggerList> {
  // Coze list_triggers/list_publish_trigger requests carry project_id but no
  // workflow_id, so an empty workflowRef lists every stored trigger.
  const workflowRef = firstString(input.workflowRef)
  const triggers = workflowRef
    ? await readTriggerStore(input.cwd, workflowRef)
    : await readAllTriggerStores(input.cwd)
  return {
    mode: 'native-workflow-trigger-list',
    workflowRef,
    triggers,
    total: triggers.length,
    triggerApps: BUILTIN_TRIGGER_APPS,
  }
}

export async function getMatOSWorkbenchWorkflowTrigger(
  input: MatOSWorkbenchContext & {
    workflowRef: string
    triggerId?: string
  },
): Promise<MatOSWorkbenchWorkflowTriggerDetail> {
  let workflowRef = firstString(input.workflowRef)
  const triggerId = firstString(input.triggerId)
  const triggers = workflowRef ? await readTriggerStore(input.cwd, workflowRef) : []
  let trigger = triggerId
    ? triggers.find(item => item.triggerId === triggerId) ?? null
    : triggers[0] ?? null
  if (!trigger && triggerId) {
    // Coze get_publish_trigger style requests may carry only trigger_id, or a
    // workflow id that does not match the owning store; resolve across stores
    // like save/delete already do.
    const located = await findTriggerAcrossStores(input.cwd, triggerId)
    if (located) {
      trigger = located
      workflowRef = located.workflowRef
    }
  }
  return {
    mode: 'native-workflow-trigger-detail',
    workflowRef,
    trigger,
    triggerApps: BUILTIN_TRIGGER_APPS,
  }
}

function parseRequestStatus(request: Record<string, unknown>): number | undefined {
  for (const key of ['status', 'set_status', 'setStatus']) {
    const value = request[key]
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

export async function saveMatOSWorkbenchWorkflowTrigger(
  input: MatOSWorkbenchContext & {
    workflowRef: string
    request?: unknown
  },
): Promise<MatOSWorkbenchWorkflowTriggerMutationResult> {
  return withTriggerStoreLock(input.cwd, () =>
    saveMatOSWorkbenchWorkflowTriggerLocked(input),
  )
}

async function saveMatOSWorkbenchWorkflowTriggerLocked(
  input: MatOSWorkbenchContext & {
    workflowRef: string
    request?: unknown
  },
): Promise<MatOSWorkbenchWorkflowTriggerMutationResult> {
  const request = asRecord(input.request)
  const requestedTriggerId = firstString(request.trigger_id, request.triggerId, request.id)
  let workflowRef = firstString(input.workflowRef)
  let crossStoreExisting: MatOSWorkbenchWorkflowTriggerRecord | undefined
  if (!workflowRef && requestedTriggerId) {
    // Coze operate_publish_trigger requests carry trigger_id but no
    // workflow_id, so resolve the owning workflow from the stores.
    crossStoreExisting = await findTriggerAcrossStores(input.cwd, requestedTriggerId)
    workflowRef = crossStoreExisting?.workflowRef ?? ''
  }
  if (!workflowRef) {
    return {
      mode: 'native-workflow-trigger-mutation',
      applied: false,
      workflowRef: '',
      trigger: null,
      validation: {
        ok: false,
        errors: [
          requestedTriggerId
            ? {
                code: 'trigger_not_found',
                message: `Workflow trigger ${requestedTriggerId} was not found in any MatOS trigger store.`,
              }
            : {
                code: 'missing_workflow_ref',
                message: 'Workflow trigger save requires a workflow ref or an existing trigger_id.',
              },
        ],
      },
    }
  }
  const triggers = await readTriggerStore(input.cwd, workflowRef)
  const existing = requestedTriggerId
    ? triggers.find(item => item.triggerId === requestedTriggerId) ?? crossStoreExisting
    : undefined
  const requestedAppId = firstString(request.app_id, request.appId, existing?.appId)
  const eventId = firstString(request.event_id, request.eventId, existing?.eventId)
  const triggerId = requestedTriggerId || `trg-${Date.now()}`
  const resolved = eventId ? resolveEventAcrossApps(requestedAppId, eventId) : undefined
  if (!eventId || !resolved) {
    return {
      mode: 'native-workflow-trigger-mutation',
      applied: false,
      workflowRef,
      trigger: null,
      validation: {
        ok: false,
        errors: [
          {
            code: 'unknown_trigger_event',
            message: `Unknown MatOS trigger event ${eventId || '(missing)'}${requestedAppId ? ` for app ${requestedAppId}` : ''}.`,
          },
        ],
      },
    }
  }
  const appId = resolved.appId
  const event = resolved.event
  const now = Date.now()
  const requestConfig = parseRecordish(request.config)
  const requestPayload = parseRecordish(request.payload)
  const requestStatus = parseRequestStatus(request)
  const nextConfig = requestConfig ?? existing?.config ?? {}
  // Only validate config when it is newly created or explicitly provided.
  // Status-only operate updates inherit the stored config untouched and must
  // not start failing because of legacy data.
  if (!existing || requestConfig !== undefined) {
    const configErrors = validateTriggerConfig(eventId, nextConfig)
    if (configErrors.length) {
      return {
        mode: 'native-workflow-trigger-mutation',
        applied: false,
        workflowRef,
        trigger: null,
        validation: { ok: false, errors: configErrors },
      }
    }
  }
  const next: MatOSWorkbenchWorkflowTriggerRecord = {
    triggerId,
    workflowRef,
    appId,
    eventId,
    name: firstString(request.name, existing?.name, event.eventName),
    config: nextConfig,
    payload: requestPayload ?? existing?.payload ?? {},
    status: requestStatus ?? existing?.status ?? 1,
    createTime: existing?.createTime ?? now,
    updateTime: now,
    // Scheduler bookkeeping survives Coze status-only operates and config
    // edits; the scheduler re-arms itself when the cron snapshot mismatches.
    ...(existing?.scheduler ? { scheduler: existing.scheduler } : {}),
  }
  const index = triggers.findIndex(item => item.triggerId === triggerId)
  if (index >= 0) {
    triggers[index] = next
  } else {
    triggers.push(next)
  }
  await writeTriggerStore(input.cwd, workflowRef, triggers)
  return {
    mode: 'native-workflow-trigger-mutation',
    applied: true,
    workflowRef,
    trigger: next,
    validation: { ok: true, errors: [] },
  }
}

export async function deleteMatOSWorkbenchWorkflowTrigger(
  input: MatOSWorkbenchContext & {
    workflowRef: string
    triggerId?: string
    request?: unknown
  },
): Promise<MatOSWorkbenchWorkflowTriggerMutationResult> {
  return withTriggerStoreLock(input.cwd, () =>
    deleteMatOSWorkbenchWorkflowTriggerLocked(input),
  )
}

async function deleteMatOSWorkbenchWorkflowTriggerLocked(
  input: MatOSWorkbenchContext & {
    workflowRef: string
    triggerId?: string
    request?: unknown
  },
): Promise<MatOSWorkbenchWorkflowTriggerMutationResult> {
  const request = asRecord(input.request)
  const triggerId = firstString(input.triggerId, request.trigger_id, request.triggerId, request.id)
  let workflowRef = firstString(input.workflowRef)
  if (!triggerId) {
    return {
      mode: 'native-workflow-trigger-mutation',
      applied: false,
      workflowRef,
      trigger: null,
      validation: {
        ok: false,
        errors: [{ code: 'missing_trigger_id', message: 'Workflow trigger delete requires trigger_id.' }],
      },
    }
  }
  if (!workflowRef) {
    // Coze delete_trigger requests carry trigger_id but no workflow_id.
    const located = await findTriggerAcrossStores(input.cwd, triggerId)
    workflowRef = located?.workflowRef ?? ''
  }
  const triggers = workflowRef ? await readTriggerStore(input.cwd, workflowRef) : []
  const next = triggers.filter(item => item.triggerId !== triggerId)
  if (next.length === triggers.length) {
    return {
      mode: 'native-workflow-trigger-mutation',
      applied: false,
      workflowRef,
      trigger: null,
      validation: {
        ok: false,
        errors: [{ code: 'trigger_not_found', message: `Workflow trigger ${triggerId} was not found.` }],
      },
    }
  }
  await writeTriggerStore(input.cwd, workflowRef, next)
  return {
    mode: 'native-workflow-trigger-mutation',
    applied: true,
    workflowRef,
    trigger: null,
    validation: { ok: true, errors: [] },
  }
}

// Persist scheduler bookkeeping for one trigger without touching the
// user-facing trigger fields. Used by the trigger scheduler tick loop.
export async function updateMatOSWorkbenchWorkflowTriggerScheduler(input: {
  cwd: string
  workflowRef: string
  triggerId: string
  scheduler: MatOSWorkbenchWorkflowTriggerSchedulerState
}): Promise<MatOSWorkbenchWorkflowTriggerRecord | null> {
  return withTriggerStoreLock(input.cwd, () =>
    updateMatOSWorkbenchWorkflowTriggerSchedulerLocked(input),
  )
}

async function updateMatOSWorkbenchWorkflowTriggerSchedulerLocked(input: {
  cwd: string
  workflowRef: string
  triggerId: string
  scheduler: MatOSWorkbenchWorkflowTriggerSchedulerState
}): Promise<MatOSWorkbenchWorkflowTriggerRecord | null> {
  const triggers = await readTriggerStore(input.cwd, input.workflowRef)
  const index = triggers.findIndex(item => item.triggerId === input.triggerId)
  if (index < 0) {
    return null
  }
  const next: MatOSWorkbenchWorkflowTriggerRecord = {
    ...triggers[index],
    scheduler: { ...input.scheduler, updatedAt: Date.now() },
  }
  triggers[index] = next
  await writeTriggerStore(input.cwd, input.workflowRef, triggers)
  return next
}
