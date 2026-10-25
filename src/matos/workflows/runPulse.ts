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

// Workflow run "pulse": the agent-facing liveness layer over run.json /
// node-runs / events.jsonl.
//
// AutoMat trace mining showed agents burning turns polling raw
// `workflow_run action=status` in a loop, mistaking a dead detached worker
// for a slow run (run.json can sit in `running` forever after a SIGKILL),
// and never being told when a run finished or parked on human input. This
// module adds the three missing primitives:
//
//   heartbeat  -> the advancing process periodically stamps heartbeat.json,
//                 so observers can tell "still executing" from "worker died"
//                 even while a 20-minute exec node produces no state writes.
//   pulse      -> one compact, guidance-carrying progress snapshot (status,
//                 node progress, failures with repair hints, waiting detail,
//                 heartbeat age, next actions) shared by wait/status/watch.
//   wait/watch -> a bounded long-poll (one tool call instead of N status
//                 polls) and a registry of detached runs that an interactive
//                 session watches so terminal/waiting/stalled transitions are
//                 pushed into the agent as notifications.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scrubSecretsFromString } from '../sessions/traceContext.js'
import type {
  MatOSWorkflowEvent,
  MatOSWorkflowNodeRunSnapshot,
  MatOSWorkflowRunSnapshot,
} from './types.js'
import { listNodeRuns } from './runState.js'
import { readWorkflowRun, readWorkflowRunEvents } from './workflowStore.js'
import { workflowFailureSourceNodeIds } from './validationFailure.js'

export const WORKFLOW_HEARTBEAT_FILE = 'heartbeat.json'
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 30_000
// A worker stamps every 30s; two consecutive missed stamps plus slack means
// the process is very likely gone (or the host clock jumped, which resume
// handles safely anyway).
export const WORKFLOW_HEARTBEAT_STALL_SECONDS = 120

export type WorkflowRunHeartbeat = {
  pid: number
  at: string
  ageSeconds: number
  processAlive: boolean | null
}

type HeartbeatFile = {
  pid?: unknown
  at?: unknown
}

/**
 * Start stamping `heartbeat.json` in the run dir. Returns a stop function.
 * Failures are swallowed: a heartbeat must never break the run itself.
 */
export function startWorkflowRunHeartbeat(runDir: string): () => void {
  const stamp = () => {
    void writeFile(
      join(runDir, WORKFLOW_HEARTBEAT_FILE),
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      'utf8',
    ).catch(() => {})
  }
  stamp()
  const timer = setInterval(stamp, WORKFLOW_HEARTBEAT_INTERVAL_MS)
  // The heartbeat must not keep a finished process alive.
  timer.unref?.()
  return () => {
    clearInterval(timer)
    // Final stamp so observers see the freshest possible timestamp at the
    // moment the advancing segment handed control back.
    stamp()
  }
}

export async function readWorkflowRunHeartbeat(
  runDir: string,
): Promise<WorkflowRunHeartbeat | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDir, WORKFLOW_HEARTBEAT_FILE), 'utf8'),
    ) as HeartbeatFile
    const at = typeof raw.at === 'string' ? raw.at : undefined
    const pid = typeof raw.pid === 'number' ? raw.pid : undefined
    if (!at || !pid) {
      return null
    }
    const atMs = Date.parse(at)
    if (!Number.isFinite(atMs)) {
      return null
    }
    let processAlive: boolean | null = null
    try {
      process.kill(pid, 0)
      processAlive = true
    } catch (error) {
      processAlive =
        (error as NodeJS.ErrnoException).code === 'EPERM' ? true : false
    }
    return {
      pid,
      at,
      ageSeconds: Math.max(0, Math.round((Date.now() - atMs) / 1000)),
      processAlive,
    }
  } catch {
    return null
  }
}

const ACTIVE_RUN_STATUSES = new Set(['created', 'running'])

const SETTLED_NODE_STATUSES = new Set([
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

export type WorkflowRunPulse = {
  runId: string
  workflowRef: string
  status: string
  /** True when the run reached completed/failed/cancelled. */
  terminal: boolean
  /**
   * True when run.json still claims created/running but no live worker
   * heartbeat backs it — the detached worker very likely died.
   */
  stalled: boolean
  heartbeat: (WorkflowRunHeartbeat & { stale: boolean }) | null
  updatedAt: string
  progress: {
    totalNodes: number
    settledNodes: number
    running: Array<{ nodeId: string; elapsedSeconds: number | null }>
    failed: Array<{
      nodeId: string
      attempts: number
      error: string | null
      sourceNodeIds: string[]
    }>
  }
  waiting: { nodeId: string; kind: 'input' | 'approval' } | null
  guidance: string[]
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function errorSummary(error: unknown): string | null {
  if (error == null) {
    return null
  }
  if (typeof error === 'string') {
    return error.trim() ? truncate(scrubSecretsFromString(error), 300) : null
  }
  if (typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    const message =
      typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : undefined
    if (message) {
      const hint =
        typeof record.repairHint === 'string' && record.repairHint.trim()
          ? ` (repair hint: ${record.repairHint})`
          : ''
      return truncate(scrubSecretsFromString(`${message}${hint}`), 300)
    }
  }
  try {
    return truncate(scrubSecretsFromString(JSON.stringify(error)), 300)
  } catch {
    return null
  }
}

function elapsedSeconds(startedAt: string | undefined): number | null {
  if (!startedAt) {
    return null
  }
  const startedMs = Date.parse(startedAt)
  if (!Number.isFinite(startedMs)) {
    return null
  }
  return Math.max(0, Math.round((Date.now() - startedMs) / 1000))
}

function pulseGuidance(input: {
  runId: string
  status: string
  stalled: boolean
  waiting: WorkflowRunPulse['waiting']
  failed: WorkflowRunPulse['progress']['failed']
  running: WorkflowRunPulse['progress']['running']
}): string[] {
  if (input.stalled) {
    return [
      `Run is marked ${input.status} but has no live worker heartbeat — the detached worker likely died.`,
      `Continue it with workflow_run action=resume runId=${input.runId}, or inspect a recovery plan with action=recover.`,
    ]
  }
  switch (input.status) {
    case 'completed':
      return [
        'Run completed. Read outputs from this result (or action=status) and declared artifacts with action=artifacts.',
      ]
    case 'failed': {
      const failedIds = input.failed.map(node => node.nodeId).join(', ')
      const sourceIds = [
        ...new Set(input.failed.flatMap(node => node.sourceNodeIds)),
      ].join(', ')
      return [
        `Run failed${failedIds ? ` at node(s): ${failedIds}` : ''}. Inspect node errors above (action=inspect for full payloads).`,
        sourceIds
          ? `Validation identifies upstream producer node(s): ${sourceIds}. Repair and retry the causal producer; retrying it invalidates and recomputes only its affected downstream closure.`
          : 'Trace the failure through its dependency ancestry before choosing the repair target.',
        'After repairing the causal node/input, retry that node with workflow_run action=retry_node, or fork the run into an editable draft with workflow_edit action=fork_run. Preserve only completed nodes outside the affected dependency closure.',
      ]
    }
    case 'cancelled':
      return ['Run was cancelled.']
    case 'paused':
      return [`Run is paused. Continue with workflow_run action=resume runId=${input.runId}.`]
    case 'waiting_input':
      return [
        `Node ${input.waiting?.nodeId ?? '?'} is waiting for your reply. Answer with workflow_run action=respond runId=${input.runId} nodeId=${input.waiting?.nodeId ?? '<nodeId>'} response=...`,
      ]
    case 'waiting_approval':
      return [
        `Node ${input.waiting?.nodeId ?? '?'} is waiting for approval. Decide with workflow_run action=approve (or action=deny) runId=${input.runId} nodeId=${input.waiting?.nodeId ?? '<nodeId>'}.`,
      ]
    default: {
      const runningIds = input.running.map(node => node.nodeId).join(', ')
      return [
        `Run is executing${runningIds ? ` (active: ${runningIds})` : ''}. Block for the next transition with workflow_run action=wait runId=${input.runId} (timeoutSeconds up to 600) instead of polling status in a loop.`,
      ]
    }
  }
}

/** One compact liveness/progress snapshot of a run. */
export async function workflowRunPulse(runDir: string): Promise<WorkflowRunPulse> {
  const snapshot: MatOSWorkflowRunSnapshot = await readWorkflowRun(runDir)
  const nodeRuns = await listNodeRuns(runDir)
  const heartbeat = await readWorkflowRunHeartbeat(runDir)

  const nodes = [...nodeRuns.values()]
  const running = nodes
    .filter(node => node.status === 'running')
    .map((node: MatOSWorkflowNodeRunSnapshot) => ({
      nodeId: node.nodeId,
      elapsedSeconds: elapsedSeconds(node.startedAt),
    }))
  const failed = nodes
    .filter(node => node.status === 'failed')
    .map(node => ({
      nodeId: node.nodeId,
      attempts: node.attempts,
      error: errorSummary(node.error),
      sourceNodeIds: workflowFailureSourceNodeIds(node.error),
    }))
  const settledNodes = nodes.filter(node =>
    SETTLED_NODE_STATUSES.has(node.status),
  ).length

  const active = ACTIVE_RUN_STATUSES.has(snapshot.status)
  const heartbeatStale =
    heartbeat !== null &&
    (heartbeat.ageSeconds > WORKFLOW_HEARTBEAT_STALL_SECONDS ||
      heartbeat.processAlive === false)
  // Without a heartbeat file (runs from before this layer, or a worker that
  // died before the first stamp) fall back to the run's own updatedAt so a
  // dead `created` run does not look healthy forever.
  const updatedAgeSeconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(snapshot.updatedAt)) / 1000),
  )
  const stalled =
    active &&
    (heartbeat
      ? heartbeatStale
      : Number.isFinite(updatedAgeSeconds) &&
        updatedAgeSeconds > WORKFLOW_HEARTBEAT_STALL_SECONDS * 5)

  const waiting =
    snapshot.status === 'waiting_input' && snapshot.waitingNodeId
      ? ({ nodeId: snapshot.waitingNodeId, kind: 'input' } as const)
      : snapshot.status === 'waiting_approval' && snapshot.waitingNodeId
        ? ({ nodeId: snapshot.waitingNodeId, kind: 'approval' } as const)
        : null

  const terminal =
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'

  return {
    runId: snapshot.runId,
    workflowRef: snapshot.workflowRef,
    status: snapshot.status,
    terminal,
    stalled,
    heartbeat: heartbeat ? { ...heartbeat, stale: heartbeatStale } : null,
    updatedAt: snapshot.updatedAt,
    progress: {
      totalNodes: nodeRuns.size,
      settledNodes,
      running,
      failed,
    },
    waiting,
    guidance: pulseGuidance({
      runId: snapshot.runId,
      status: snapshot.status,
      stalled,
      waiting,
      failed,
      running,
    }),
  }
}

export type WorkflowRunWaitResult = {
  pulse: WorkflowRunPulse
  /** False when the wait timed out with the run still in its initial state. */
  changed: boolean
  timedOut: boolean
  waitedSeconds: number
  newEvents: Array<{
    id: string | null
    timestamp: string | null
    type: string
    nodeId: string | null
  }>
  /** Pass back as sinceEventId on the next wait to keep the event cursor. */
  nextSinceEventId: string | null
}

function eventCursorSlice(
  events: MatOSWorkflowEvent[],
  sinceEventId: string | undefined,
  cap: number,
): { slice: MatOSWorkflowEvent[]; nextSinceEventId: string | null } {
  let startIndex = 0
  if (sinceEventId) {
    const cursor = events.findIndex(event => event.id === sinceEventId)
    if (cursor >= 0) {
      startIndex = cursor + 1
    }
  }
  const fresh = events.slice(startIndex)
  return {
    slice: fresh.slice(-cap),
    nextSinceEventId: events.length > 0 ? (events[events.length - 1]?.id ?? null) : null,
  }
}

function compactEvent(event: MatOSWorkflowEvent): WorkflowRunWaitResult['newEvents'][number] {
  const data =
    event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : undefined
  return {
    id: event.id ?? null,
    timestamp: event.timestamp ?? null,
    type: event.type,
    nodeId: data && typeof data.nodeId === 'string' ? data.nodeId : null,
  }
}

const WAIT_POLL_MS = 1_500
export const WORKFLOW_WAIT_DEFAULT_TIMEOUT_SECONDS = 60
export const WORKFLOW_WAIT_MAX_TIMEOUT_SECONDS = 600

/**
 * Bounded long-poll: block until the run leaves its current
 * active/running state (terminal, waiting_*, paused, stalled) or the timeout
 * elapses. Replaces the status-poll loops agents burned turns on.
 */
export async function waitForWorkflowRun(input: {
  runDir: string
  timeoutSeconds?: number
  sinceEventId?: string
  pollMs?: number
}): Promise<WorkflowRunWaitResult> {
  const timeoutSeconds = Math.min(
    Math.max(input.timeoutSeconds ?? WORKFLOW_WAIT_DEFAULT_TIMEOUT_SECONDS, 1),
    WORKFLOW_WAIT_MAX_TIMEOUT_SECONDS,
  )
  const pollMs = Math.max(input.pollMs ?? WAIT_POLL_MS, 100)
  const startedAt = Date.now()
  const deadline = startedAt + timeoutSeconds * 1000

  const initial = await workflowRunPulse(input.runDir)
  let pulse = initial
  let timedOut = false
  for (;;) {
    if (pulse.terminal || pulse.waiting || pulse.stalled || pulse.status === 'paused') {
      break
    }
    if (Date.now() >= deadline) {
      timedOut = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
    pulse = await workflowRunPulse(input.runDir)
  }

  const events = await readWorkflowRunEvents(input.runDir).catch(
    () => [] as MatOSWorkflowEvent[],
  )
  const { slice, nextSinceEventId } = eventCursorSlice(events, input.sinceEventId, 20)
  const changed =
    pulse.status !== initial.status ||
    pulse.progress.settledNodes !== initial.progress.settledNodes ||
    slice.length > 0
  return {
    pulse,
    changed,
    timedOut,
    waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
    newEvents: slice.map(compactEvent),
    nextSinceEventId,
  }
}

// ---------------------------------------------------------------------------
// Watch registry: detached runs an interactive session should push-notify on.
// ---------------------------------------------------------------------------

const WATCH_DIR = ['.matos', 'runtime', 'workflow-run-watch'] as const

export type WorkflowRunWatchEntry = {
  runId: string
  runDir: string
  workflowRef?: string
  registeredAt: string
  /** Stable native chat identity; unowned legacy records are inspection-only. */
  sessionId?: string
  /** Last status class already pushed, to avoid duplicate notifications. */
  lastNotifiedStatus?: string
}

function watchDirFor(cwd: string): string {
  return join(cwd, ...WATCH_DIR)
}

function watchFileFor(cwd: string, runId: string): string {
  // Run ids are validated (`run_<uuid>`), but keep the filename safe anyway.
  return join(watchDirFor(cwd), `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

/**
 * Register a detached run for push notification. Best-effort: watch loss only
 * degrades back to polling, so registration failures are swallowed.
 */
export async function registerWorkflowRunWatch(input: {
  cwd: string
  runId: string
  runDir: string
  workflowRef?: string
  sessionId?: string
}): Promise<void> {
  try {
    await mkdir(watchDirFor(input.cwd), { recursive: true })
    const entry: WorkflowRunWatchEntry = {
      runId: input.runId,
      runDir: input.runDir,
      workflowRef: input.workflowRef,
      registeredAt: new Date().toISOString(),
      sessionId: watchSessionId(input.sessionId),
    }
    await writeFile(
      watchFileFor(input.cwd, input.runId),
      `${JSON.stringify(entry, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // Best-effort by design.
  }
}

export async function listWorkflowRunWatches(
  cwd: string,
): Promise<WorkflowRunWatchEntry[]> {
  let files: string[]
  try {
    files = await readdir(watchDirFor(cwd))
  } catch {
    return []
  }
  const entries: WorkflowRunWatchEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    try {
      const parsed = JSON.parse(
        await readFile(join(watchDirFor(cwd), file), 'utf8'),
      ) as WorkflowRunWatchEntry
      if (parsed && typeof parsed.runId === 'string' && typeof parsed.runDir === 'string') {
        entries.push(parsed)
      }
    } catch {
      // Skip unreadable entries; they will be retried or cleaned up later.
    }
  }
  return entries
}

async function updateWorkflowRunWatch(
  cwd: string,
  entry: WorkflowRunWatchEntry,
): Promise<void> {
  try {
    await writeFile(
      watchFileFor(cwd, entry.runId),
      `${JSON.stringify(entry, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // Best-effort by design.
  }
}

async function removeWorkflowRunWatch(cwd: string, runId: string): Promise<void> {
  await rm(watchFileFor(cwd, runId), { force: true }).catch(() => {})
}

export type WorkflowRunNotification = {
  runId: string
  workflowRef?: string
  statusClass: string
  message: string
}

function notificationFor(
  entry: WorkflowRunWatchEntry,
  pulse: WorkflowRunPulse,
): { statusClass: string; message: string } | null {
  const statusClass = pulse.stalled ? 'stalled' : pulse.status
  if (
    !pulse.terminal &&
    !pulse.waiting &&
    !pulse.stalled &&
    pulse.status !== 'paused'
  ) {
    return null
  }
  if (entry.lastNotifiedStatus === statusClass) {
    return null
  }
  const failedLines = pulse.progress.failed
    .slice(0, 3)
    .map(node => `- node ${node.nodeId}: ${node.error ?? 'failed'}`)
  const header = pulse.stalled
    ? `Workflow run ${pulse.runId} (${pulse.workflowRef}) appears STALLED: still marked ${pulse.status} with no live worker heartbeat.`
    : `Workflow run ${pulse.runId} (${pulse.workflowRef}) is now ${pulse.status} (${pulse.progress.settledNodes}/${pulse.progress.totalNodes} nodes settled).`
  const message = [
    '<workflow-notification>',
    header,
    ...failedLines,
    ...pulse.guidance,
    '</workflow-notification>',
  ].join('\n')
  return { statusClass, message }
}

export type WorkflowRunWatcher = {
  /** One scan over the registry; safe to call on a timer. */
  tick: () => Promise<WorkflowRunNotification[]>
  /** Active runs owned by this native session need a future turn, including on resume. */
  hasPendingRuns: () => boolean
  start: () => void
  stop: () => void
}

/**
 * Watch registered detached runs and emit one notification per status-class
 * transition (terminal, waiting_input, waiting_approval, paused, stalled).
 * Terminal runs leave the registry; waiting/stalled runs stay registered so
 * their eventual terminal transition is still pushed.
 */
export function createWorkflowRunWatcher(input: {
  cwd: string
  sessionId: string | (() => string | undefined)
  onNotification: (notification: WorkflowRunNotification) => void
  intervalMs?: number
}): WorkflowRunWatcher {
  let timer: ReturnType<typeof setInterval> | null = null
  let scanPromise: Promise<WorkflowRunNotification[]> | undefined
  let pendingRuns = false
  let pendingSessionId: string | undefined
  let stopped = false
  const currentSession = () => watchSessionId(typeof input.sessionId === 'function' ? input.sessionId() : input.sessionId)
  const stillOwnsScan = (sessionId: string) => !stopped && currentSession() === sessionId

  const scan = async (): Promise<WorkflowRunNotification[]> => {
    let nextPendingRuns = false
    const sessionId = currentSession()
    try {
      if (stopped || !sessionId || !existsSync(watchDirFor(input.cwd))) {
        return []
      }
      const emitted: WorkflowRunNotification[] = []
      const entries = await listWorkflowRunWatches(input.cwd)
      for (const entry of entries) {
        if (!stillOwnsScan(sessionId)) return emitted
        // Never consume, clean up or wait on another chat's records. Unknown
        // legacy ownership cannot be inferred from cwd or registration time.
        if (entry.sessionId !== sessionId) continue
        if (!existsSync(entry.runDir)) {
          await removeWorkflowRunWatch(input.cwd, entry.runId)
          continue
        }
        let pulse: WorkflowRunPulse
        try {
          pulse = await workflowRunPulse(entry.runDir)
        } catch {
          continue
        }
        if (!stillOwnsScan(sessionId)) return emitted
        // Ownership survives a process restart or same-session resume. Only
        // active owned runs hold the drain; parked runs notify once instead.
        if (
          !pulse.terminal &&
          !pulse.waiting &&
          !pulse.stalled &&
          pulse.status !== 'paused'
        ) {
          nextPendingRuns = true
        }
        const notification = notificationFor(entry, pulse)
        if (notification) {
          const event = {
            runId: entry.runId,
            workflowRef: entry.workflowRef ?? pulse.workflowRef,
            statusClass: notification.statusClass,
            message: notification.message,
          }
          // Enqueue synchronously before marking delivery; a stopped/switched
          // watcher or throwing consumer must not delete an undelivered event.
          input.onNotification(event)
          emitted.push(event)
          if (pulse.terminal) {
            await removeWorkflowRunWatch(input.cwd, entry.runId)
          } else {
            await updateWorkflowRunWatch(input.cwd, {
              ...entry,
              lastNotifiedStatus: notification.statusClass,
            })
          }
        } else if (
          entry.lastNotifiedStatus &&
          !pulse.terminal &&
          !pulse.waiting &&
          !pulse.stalled &&
          pulse.status !== 'paused'
        ) {
          // The run moved back to active execution (respond/resume) — rearm
          // so the next waiting/terminal transition notifies again.
          await updateWorkflowRunWatch(input.cwd, {
            ...entry,
            lastNotifiedStatus: undefined,
          })
        }
      }
      return emitted
    } finally {
      pendingSessionId = sessionId
      pendingRuns = Boolean(sessionId && stillOwnsScan(sessionId) && nextPendingRuns)
    }
  }
  // The turn-boundary scan must await an already running interval scan;
  // returning early here can falsely declare idle just before notification.
  const tick = (): Promise<WorkflowRunNotification[]> => {
    if (stopped) return Promise.resolve([])
    scanPromise ??= scan().finally(() => {
      scanPromise = undefined
    })
    return scanPromise
  }

  return {
    tick,
    hasPendingRuns: () => !stopped && pendingSessionId === currentSession() && pendingRuns,
    start: () => {
      stopped = false
      if (timer) {
        return
      }
      timer = setInterval(() => {
        void tick().catch(() => {
          // scan errors must never take down the host session
        })
      }, input.intervalMs ?? 5_000)
      // Intentionally not unref'd: under Bun, unref'd intervals can stop
      // firing once the event loop's referenced work quiesces mid-session,
      // which silently kills the watcher while an agent turn is running.
      // Lifecycle is owned by stop() (REPL unmount / headless shutdown).
      // Headless mode additionally ticks deterministically at every turn
      // boundary (see runHeadlessStreaming's drain loop) because busy turns
      // can starve timers entirely.
    },
    stop: () => {
      stopped = true
      pendingRuns = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

function watchSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined
}
