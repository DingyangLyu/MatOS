import { createHash } from 'node:crypto'
import { mkdir,rm,stat,utimes,writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { MatOSWorkbenchContext } from './types.js'
import {
listMatOSWorkbenchWorkflowTriggers,
updateMatOSWorkbenchWorkflowTriggerScheduler,
workflowTriggerFiringLeasePath,
type MatOSWorkbenchWorkflowTriggerRecord,
type MatOSWorkbenchWorkflowTriggerSchedulerState,
} from './workflowTriggers.js'
import { runMatOSWorkbenchWorkflow } from './workflows.js'

const CRON_EVENT_ID = 'matos.schedule.cron'
const TRIGGER_STATUS_OPEN = 1
// Bound the next-fire search by whole days of real time. The longest gap
// between two matches of a valid cron is the Feb-29 case, which can span up to
// eight years across a non-leap century boundary (e.g. 2096 -> 2104), so the
// window must reach a full leap cycle plus margin. Date combinations that can
// never occur (e.g. Feb 30) are rejected before the walk, so this bound is the
// safety net for genuinely sparse schedules rather than a spin guard.
const MAX_SEARCH_DAYS = 366 * 8 + 16
// One tick fires due triggers concurrently so a long workflow run cannot
// starve the other due triggers, but bounded so a backlogged store cannot
// launch an unbounded number of workflow runs at once.
const MAX_CONCURRENT_FIRES = 4
// A fire attempt that loses the per-trigger lease reports this error instead
// of starting a duplicate workflow run.
export const WORKFLOW_TRIGGER_FIRING_IN_PROGRESS = 'trigger_firing_in_progress'
// A crashed firing process leaves its lease file behind; leases older than
// this are reclaimed.
const FIRING_LEASE_STALE_MS = 30 * 60 * 1000
// While a fire is in progress its lease is refreshed on this cadence so a
// workflow that runs longer than the stale window is never mistaken for a
// crashed holder and re-fired. Comfortably smaller than the stale bound.
const FIRING_LEASE_HEARTBEAT_MS = 10 * 60 * 1000

type CronField = { any: boolean; values: Set<number> }

export type ParsedCronExpression = {
  seconds: CronField
  minutes: CronField
  hours: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  source: string
}

function parseCronField(
  raw: string,
  min: number,
  max: number,
  normalize?: (value: number) => number,
): CronField | undefined {
  if (raw === '*') {
    return { any: true, values: new Set() }
  }
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    if (!part) {
      return undefined
    }
    const stepSplit = part.split('/')
    if (stepSplit.length > 2) {
      return undefined
    }
    const [rangeRaw, stepRaw] = stepSplit
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) {
      return undefined
    }
    let start: number
    let end: number
    if (rangeRaw === '*' || rangeRaw === '') {
      start = min
      end = max
    } else if (rangeRaw && rangeRaw.includes('-')) {
      const [lowRaw, highRaw] = rangeRaw.split('-')
      // Reject malformed ranges like "-5" or "5-": Number('') is 0, which
      // would silently turn "-5" into the range 0-5 on zero-based fields.
      if (!lowRaw || !highRaw) {
        return undefined
      }
      start = Number(lowRaw)
      end = Number(highRaw)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        return undefined
      }
    } else {
      start = Number(rangeRaw)
      end = stepRaw === undefined ? start : max
      if (!Number.isInteger(start)) {
        return undefined
      }
    }
    if (start < min || end > max) {
      return undefined
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize ? normalize(value) : value)
    }
  }
  return values.size ? { any: false, values } : undefined
}

// Accepts the Coze trigger form's 6-field seconds-first crontab as well as
// classic 5-field cron. Numeric fields only; names are not supported in V1.
export function parseCronExpression(expression: string): ParsedCronExpression | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length < 5 || fields.length > 6) {
    return undefined
  }
  const withSeconds = fields.length === 6
  const [secondsRaw, minutesRaw, hoursRaw, domRaw, monthRaw, dowRaw] = withSeconds
    ? fields
    : ['0', ...fields]
  const seconds = parseCronField(secondsRaw ?? '0', 0, 59)
  const minutes = parseCronField(minutesRaw ?? '*', 0, 59)
  const hours = parseCronField(hoursRaw ?? '*', 0, 23)
  const dayOfMonth = parseCronField(domRaw ?? '*', 1, 31)
  const month = parseCronField(monthRaw ?? '*', 1, 12)
  const dayOfWeek = parseCronField(dowRaw ?? '*', 0, 7, value => (value === 7 ? 0 : value))
  if (!seconds || !minutes || !hours || !dayOfMonth || !month || !dayOfWeek) {
    return undefined
  }
  return { seconds, minutes, hours, dayOfMonth, month, dayOfWeek, source: expression.trim() }
}

type WallClock = {
  second: number
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>()

function wallClockFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
    wallClockFormatters.set(timezone, formatter)
  }
  return formatter
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function wallClockAt(instantMs: number, timezone?: string): WallClock | undefined {
  if (!timezone || timezone === 'UTC') {
    const date = new Date(instantMs)
    return {
      second: date.getUTCSeconds(),
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    }
  }
  try {
    const parts = wallClockFormatter(timezone).formatToParts(new Date(instantMs))
    const lookup: Record<string, string> = {}
    for (const part of parts) {
      lookup[part.type] = part.value
    }
    const weekday = WEEKDAY_INDEX[lookup.weekday ?? '']
    if (weekday === undefined) {
      return undefined
    }
    return {
      second: Number(lookup.second),
      minute: Number(lookup.minute),
      hour: Number(lookup.hour),
      dayOfMonth: Number(lookup.day),
      month: Number(lookup.month),
      dayOfWeek: weekday,
    }
  } catch {
    return undefined
  }
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value)
}

// Standard cron day matching: when both day-of-month and day-of-week are
// restricted, a timestamp matches if either restriction matches.
function dayMatches(cron: ParsedCronExpression, clock: WallClock): boolean {
  const domRestricted = !cron.dayOfMonth.any
  const dowRestricted = !cron.dayOfWeek.any
  if (domRestricted && dowRestricted) {
    return (
      cron.dayOfMonth.values.has(clock.dayOfMonth) || cron.dayOfWeek.values.has(clock.dayOfWeek)
    )
  }
  return fieldMatches(cron.dayOfMonth, clock.dayOfMonth) && fieldMatches(cron.dayOfWeek, clock.dayOfWeek)
}

function smallestMatchingSecond(field: CronField, from: number): number | undefined {
  for (let second = from; second <= 59; second += 1) {
    if (fieldMatches(field, second)) {
      return second
    }
  }
  return undefined
}

// Largest day number any year admits for each month (February uses its leap
// value so leap-only schedules are treated as possible).
const MAX_DAY_IN_MONTH: Record<number, number> = {
  1: 31,
  2: 29,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
}

// Whether the date fields can ever align with a real calendar day. Day-of-week
// restrictions use OR semantics with day-of-month, so any restricted weekday is
// always reachable; a restricted month+day pair such as Feb 30 is not.
function cronCanMatchCalendarDay(cron: ParsedCronExpression): boolean {
  if (!cron.dayOfWeek.any) {
    return true
  }
  if (cron.month.any || cron.dayOfMonth.any) {
    return true
  }
  for (const month of cron.month.values) {
    const maxDay = MAX_DAY_IN_MONTH[month]
    if (maxDay === undefined) {
      continue
    }
    for (const day of cron.dayOfMonth.values) {
      if (day <= maxDay) {
        return true
      }
    }
  }
  return false
}

// Compute the next instant strictly after `fromMs` that matches the cron
// expression in the given IANA timezone (default UTC).
export function computeNextCronFire(
  expression: string | ParsedCronExpression,
  fromMs: number,
  timezone?: string,
): number | undefined {
  const cron = typeof expression === 'string' ? parseCronExpression(expression) : expression
  if (!cron) {
    return undefined
  }
  // Reject impossible date combinations (e.g. Feb 30) up front so a sparse but
  // valid schedule like Feb 29 is the only case that ever walks the long
  // window below.
  if (!cronCanMatchCalendarDay(cron)) {
    return undefined
  }
  // Start at the next whole second, then scan forward. Days whose month/day
  // fields cannot match are skipped toward their end, so a multi-year gap such
  // as the next Feb 29 is reached without visiting every intervening minute.
  const startMs = Math.floor(fromMs / 1000) * 1000 + 1000
  let minuteStartMs = Math.floor(startMs / 60_000) * 60_000
  const searchUntilMs = minuteStartMs + MAX_SEARCH_DAYS * 24 * 60 * 60_000
  while (minuteStartMs < searchUntilMs) {
    const clock = wallClockAt(minuteStartMs, timezone)
    if (!clock) {
      return undefined
    }
    if (fieldMatches(cron.month, clock.month) && dayMatches(cron, clock)) {
      if (fieldMatches(cron.hours, clock.hour) && fieldMatches(cron.minutes, clock.minute)) {
        const fromSecond = minuteStartMs < startMs ? Math.ceil((startMs - minuteStartMs) / 1000) : 0
        if (fromSecond <= 59) {
          const second = smallestMatchingSecond(cron.seconds, fromSecond)
          if (second !== undefined) {
            return minuteStartMs + second * 1000
          }
        }
      }
      // Same matching day, advance one minute toward its first matching slot.
      minuteStartMs += 60_000
      continue
    }
    // Non-matching day: jump toward the next wall-clock midnight. The one-hour
    // cushion keeps a 23-hour spring-forward day from overshooting into (and
    // thus skipping) the first minutes of the following day.
    const minutesElapsedToday = clock.hour * 60 + clock.minute
    const minutesToCushionedMidnight = 24 * 60 - minutesElapsedToday - 60
    minuteStartMs +=
      (minutesToCushionedMidnight > 0 ? minutesToCushionedMidnight : 1) * 60_000
  }
  return undefined
}

function cronExpressionForTrigger(trigger: MatOSWorkbenchWorkflowTriggerRecord): string {
  const crontab = trigger.config.crontab ?? trigger.config.cron
  return typeof crontab === 'string' ? crontab.trim() : ''
}

function timezoneForTrigger(trigger: MatOSWorkbenchWorkflowTriggerRecord): string | undefined {
  const timezone = trigger.config.timezone
  return typeof timezone === 'string' && timezone.trim() ? timezone.trim() : undefined
}

function triggerRunParameters(
  trigger: MatOSWorkbenchWorkflowTriggerRecord,
): Record<string, unknown> | undefined {
  const payload = trigger.payload
  const parameters = payload.parameters
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>
  }
  return Object.keys(payload).length ? payload : undefined
}

function triggerPayloadDigest(trigger: MatOSWorkbenchWorkflowTriggerRecord): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(trigger.payload ?? {}))
    .digest('hex')}`
}

export type MatOSWorkflowTriggerFireResult = {
  triggerId: string
  workflowRef: string
  firedAt: number
  runId?: string
  runStatus?: string
  error?: string
}

// Cross-process at-most-once guard for one trigger firing. `wx` creation is
// atomic on POSIX filesystems; a fresh existing lease means another scheduler
// or manual fire already owns this trigger right now.
async function acquireFiringLease(path: string, now: number): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, `${JSON.stringify({ pid: process.pid, firedAt: now })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      try {
        const info = await stat(path)
        if (Date.now() - info.mtimeMs < FIRING_LEASE_STALE_MS) {
          return false
        }
        await rm(path, { force: true })
      } catch {
        return false
      }
    }
  }
  return false
}

async function releaseFiringLease(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // Lease cleanup is best-effort; a stale lease is reclaimed on expiry.
  }
}

// Bump the lease file's mtime so a long-running fire keeps ownership past the
// stale window. Returns false once the lease file is gone (already released) so
// the heartbeat can stop.
async function refreshFiringLease(path: string): Promise<boolean> {
  try {
    const now = new Date()
    await utimes(path, now, now)
    return true
  } catch {
    return false
  }
}

export type MatOSWorkflowTriggerSchedulerTick = {
  mode: 'native-workflow-trigger-scheduler-tick'
  now: number
  evaluated: number
  due: number
  fired: MatOSWorkflowTriggerFireResult[]
  armed: Array<{ triggerId: string; workflowRef: string; nextFireAt: number }>
  skipped: Array<{ triggerId: string; workflowRef: string; reason: string }>
  errors: Array<{ triggerId: string; workflowRef: string; error: string }>
  nextWakeAt?: number
}

// Fire one trigger through the native workflow run path, recording scheduler
// provenance on the trigger record. Used by the cron tick and by manual
// `workflows fire-trigger` invocations (the webhook/manual event path).
export async function fireMatOSWorkbenchWorkflowTrigger(
  input: MatOSWorkbenchContext & {
    trigger: MatOSWorkbenchWorkflowTriggerRecord
    now?: number
    schedulerState?: MatOSWorkbenchWorkflowTriggerSchedulerState
  },
): Promise<MatOSWorkflowTriggerFireResult> {
  const { trigger } = input
  const now = input.now ?? Date.now()
  const result: MatOSWorkflowTriggerFireResult = {
    triggerId: trigger.triggerId,
    workflowRef: trigger.workflowRef,
    firedAt: now,
  }
  const leasePath = workflowTriggerFiringLeasePath(
    input.cwd,
    trigger.workflowRef,
    trigger.triggerId,
  )
  if (!(await acquireFiringLease(leasePath, now))) {
    return { ...result, error: WORKFLOW_TRIGGER_FIRING_IN_PROGRESS }
  }
  // Keep the lease fresh while the (possibly long) workflow runs so another
  // scheduler tick cannot treat it as a crashed holder and re-fire the same
  // trigger. Unref'd so the heartbeat never keeps the process alive on its own.
  const leaseHeartbeat = setInterval(() => {
    void refreshFiringLease(leasePath)
  }, FIRING_LEASE_HEARTBEAT_MS)
  ;(leaseHeartbeat as unknown as { unref?: () => void }).unref?.()
  let schedulerState: MatOSWorkbenchWorkflowTriggerSchedulerState = {
    ...(input.schedulerState ?? trigger.scheduler ?? {}),
    lastFiredAt: now,
  }
  try {
    try {
      const runView = await runMatOSWorkbenchWorkflow({
        cwd: input.cwd,
        scopeRef: input.scopeRef,
        env: input.env,
        ref: trigger.workflowRef,
        parameters: triggerRunParameters(trigger),
        provenance: {
          source: 'trigger',
          triggerId: trigger.triggerId,
          triggerEventId: trigger.eventId,
          triggerAppId: trigger.appId,
          firedAt: now,
          payloadDigest: triggerPayloadDigest(trigger),
        },
      })
      const run = (runView as { run?: { runId?: string; status?: string } }).run
      result.runId = run?.runId
      result.runStatus = run?.status
      schedulerState = {
        ...schedulerState,
        lastRunId: run?.runId,
        lastError: undefined,
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
      schedulerState = { ...schedulerState, lastError: result.error }
    }
    await updateMatOSWorkbenchWorkflowTriggerScheduler({
      cwd: input.cwd,
      workflowRef: trigger.workflowRef,
      triggerId: trigger.triggerId,
      scheduler: schedulerState,
    })
  } finally {
    clearInterval(leaseHeartbeat)
    await releaseFiringLease(leasePath)
  }
  return result
}

// Evaluate every saved cron trigger once. First sight of a trigger arms it
// (persists nextFireAt) without firing, so a freshly deployed scheduler does
// not replay historical schedules. A due trigger fires exactly once per tick
// with no backfill, then re-arms from the current instant.
export async function tickMatOSWorkflowTriggerScheduler(
  input: MatOSWorkbenchContext & { now?: number },
): Promise<MatOSWorkflowTriggerSchedulerTick> {
  const now = input.now ?? Date.now()
  const list = await listMatOSWorkbenchWorkflowTriggers({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    env: input.env,
    workflowRef: '',
  })
  const tick: MatOSWorkflowTriggerSchedulerTick = {
    mode: 'native-workflow-trigger-scheduler-tick',
    now,
    evaluated: 0,
    due: 0,
    fired: [],
    armed: [],
    skipped: [],
    errors: [],
  }
  let nextWakeAt: number | undefined
  const considerWake = (candidate?: number) => {
    if (candidate !== undefined && (nextWakeAt === undefined || candidate < nextWakeAt)) {
      nextWakeAt = candidate
    }
  }
  const due: Array<{
    trigger: MatOSWorkbenchWorkflowTriggerRecord
    schedulerState: MatOSWorkbenchWorkflowTriggerSchedulerState
  }> = []
  for (const trigger of list.triggers) {
    if (trigger.eventId !== CRON_EVENT_ID) {
      continue
    }
    tick.evaluated += 1
    const ref = { triggerId: trigger.triggerId, workflowRef: trigger.workflowRef }
    if (trigger.status !== TRIGGER_STATUS_OPEN) {
      tick.skipped.push({ ...ref, reason: 'trigger_closed' })
      continue
    }
    const cronSource = cronExpressionForTrigger(trigger)
    if (!cronSource) {
      tick.skipped.push({ ...ref, reason: 'missing_cron_expression' })
      continue
    }
    const cron = parseCronExpression(cronSource)
    if (!cron) {
      tick.errors.push({ ...ref, error: `Invalid cron expression ${JSON.stringify(cronSource)}.` })
      continue
    }
    const timezone = timezoneForTrigger(trigger)
    const stored = trigger.scheduler
    const armedForCurrentCron =
      stored?.nextFireAt !== undefined &&
      stored.cron === cronSource &&
      (stored.timezone ?? undefined) === timezone
    if (!armedForCurrentCron) {
      const nextFireAt = computeNextCronFire(cron, now, timezone)
      if (nextFireAt === undefined) {
        tick.errors.push({ ...ref, error: `Cron expression ${JSON.stringify(cronSource)} never matches.` })
        continue
      }
      await updateMatOSWorkbenchWorkflowTriggerScheduler({
        cwd: input.cwd,
        workflowRef: trigger.workflowRef,
        triggerId: trigger.triggerId,
        scheduler: {
          ...stored,
          cron: cronSource,
          timezone,
          nextFireAt,
          lastError: undefined,
        },
      })
      tick.armed.push({ ...ref, nextFireAt })
      considerWake(nextFireAt)
      continue
    }
    if (stored.nextFireAt !== undefined && stored.nextFireAt > now) {
      considerWake(stored.nextFireAt)
      continue
    }
    tick.due += 1
    // Re-arm from now: a long outage fires one catch-up run, not a backfill
    // burst per missed slot.
    const nextFireAt = computeNextCronFire(cron, now, timezone)
    const schedulerState: MatOSWorkbenchWorkflowTriggerSchedulerState = {
      ...stored,
      cron: cronSource,
      timezone,
      nextFireAt,
    }
    // Persist the re-arm before firing. At-most-once per slot beats replaying
    // a possibly expensive run: a concurrent ticker reading after this write
    // sees the trigger as not-due for the whole run duration, and a crash
    // mid-run skips to the next slot instead of double-submitting.
    await updateMatOSWorkbenchWorkflowTriggerScheduler({
      cwd: input.cwd,
      workflowRef: trigger.workflowRef,
      triggerId: trigger.triggerId,
      scheduler: schedulerState,
    })
    due.push({ trigger, schedulerState })
    considerWake(nextFireAt)
  }
  // Fire due triggers with bounded concurrency so one long workflow run does
  // not starve the other due triggers in the same tick.
  const results: MatOSWorkflowTriggerFireResult[] = new Array(due.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_FIRES, due.length) }, async () => {
      while (cursor < due.length) {
        const index = cursor
        cursor += 1
        const item = due[index]!
        results[index] = await fireMatOSWorkbenchWorkflowTrigger({
          cwd: input.cwd,
          scopeRef: input.scopeRef,
          env: input.env,
          trigger: item.trigger,
          now,
          schedulerState: item.schedulerState,
        })
      }
    }),
  )
  for (const fired of results) {
    if (!fired) {
      continue
    }
    if (fired.error === WORKFLOW_TRIGGER_FIRING_IN_PROGRESS) {
      tick.skipped.push({
        triggerId: fired.triggerId,
        workflowRef: fired.workflowRef,
        reason: 'firing_in_progress',
      })
      continue
    }
    tick.fired.push(fired)
    if (fired.error) {
      tick.errors.push({
        triggerId: fired.triggerId,
        workflowRef: fired.workflowRef,
        error: fired.error,
      })
    }
  }
  if (nextWakeAt !== undefined) {
    tick.nextWakeAt = nextWakeAt
  }
  return tick
}

export type MatOSWorkflowTriggerSchedulerServeOptions = MatOSWorkbenchContext & {
  intervalMs?: number
  maxTicks?: number
  signal?: AbortSignal
  onTick?: (tick: MatOSWorkflowTriggerSchedulerTick) => void
}

const MIN_SERVE_INTERVAL_MS = 5_000
const DEFAULT_SERVE_INTERVAL_MS = 30_000

// Long-running scheduler loop for `matos workbench workflows trigger-scheduler
// serve`. Runs inside the user's existing runtime (CLI process or workspace
// daemon job); it must not spawn extra containers.
export async function serveMatOSWorkflowTriggerScheduler(
  options: MatOSWorkflowTriggerSchedulerServeOptions,
): Promise<{ ticks: number }> {
  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_SERVE_INTERVAL_MS, MIN_SERVE_INTERVAL_MS)
  let ticks = 0
  while (!options.signal?.aborted) {
    const tick = await tickMatOSWorkflowTriggerScheduler(options)
    ticks += 1
    options.onTick?.(tick)
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
      break
    }
    const waitMs = tick.nextWakeAt !== undefined
      ? Math.min(Math.max(tick.nextWakeAt - Date.now(), MIN_SERVE_INTERVAL_MS), intervalMs)
      : intervalMs
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, waitMs)
      const onAbort = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  return { ticks }
}
