import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSEvent } from './eventTypes.js'

// Session event JSONL is written by several cooperating writers: the in-process
// recorder, the inherited-env trace bridge in child MatOS processes, and the
// DSH host's event bridge. O_APPEND writes are not atomic across processes on
// FUSE/NFS filesystems (records can interleave on a single line), so
// cross-process appends need mutual exclusion. A per-append mkdir/rm lock is
// safe but costs two metadata mutations per append, which is slow on loaded
// network filesystems.
//
// The common case is a single writer process per session file, so appends use
// a writer registry with a solo fast path:
//
// - Every writer process registers one sentinel file in `<path>.writers/` the
//   first time it appends to that session file (one-time cost), refreshes it
//   with a low-frequency heartbeat, and removes it on process exit.
// - Before every unlocked append the writer re-lists the registry (~0.05ms
//   measured on this host). If its own sentinel is the only live one, the
//   append is a single bounded O_APPEND write with no filesystem lock; the
//   in-process queue already serializes same-process callers.
// - A process that registers into a registry that already has a live foreign
//   sentinel is a joiner: it always uses the cross-process mkdir lock
//   (learning/evolutionMonitorRecords.ts pattern: stale reclaim + timeout
//   fallback to a direct append) and waits a short grace period before its
//   first append so a solo incumbent's per-append probe is guaranteed to have
//   observed it before their writes can overlap. Cross-process sentinel
//   visibility measured <=25ms on this host; the default 750ms grace leaves
//   ~30x margin and also covers in-flight append tail latency.
// - Once any live foreign sentinel is visible, every writer takes the lock, so
//   two processes never perform unlocked appends concurrently.
//
// MATOS_SESSION_APPEND_LOCK=always restores the previous always-lock behavior
// (operator escape hatch; also the benchmark baseline).

const DEFAULT_MAX_EVENT_RECORD_BYTES = 256 * 1024
const MIN_EVENT_RECORD_BYTES = 4 * 1024
const MAX_EVENT_TEXT_CHARS = 4000
const MAX_EVENT_ARRAY_ITEMS = 100
const MAX_EVENT_OBJECT_KEYS = 100
const MAX_EVENT_JSON_DEPTH = 6
const FALLBACK_PREVIEW_CHARS = 2048

// Session files are product evidence (trace export, self-evolution input), so
// they are capped rather than rotated: rotation would silently hide earlier
// events from readers that hold the session path. Past the cap, non-lifecycle
// events are dropped and a single marker event records the truncation, while
// session lifecycle events still land so status resolution keeps working.
const DEFAULT_MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024

const APPEND_LOCK_TIMEOUT_MS = 5_000
const APPEND_LOCK_STALE_MS = 15_000
const FILE_SIZE_RESTAT_EVERY_APPENDS = 50

const WRITER_SENTINEL_SUFFIX = '.writer'
const WRITER_SENTINEL_STALE_MS = 5 * 60_000
const WRITER_HEARTBEAT_MS = 60_000
const DEFAULT_JOIN_GRACE_MS = 750

const CAP_EXEMPT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'matos.session.started',
  'matos.session.completed',
  'matos.session.failed',
  'matos.session.storage.capped',
])

export type MatOSSessionEventAppendOutcome = 'appended' | 'capped'

type WriterRegistration =
  | {
      status: 'registered'
      registryDir: string
      sentinelName: string
      sentinelPath: string
      // Epoch ms before which this process must not append (joiner grace).
      graceUntil: number
    }
  | { status: 'unavailable' }

type SessionAppendState = {
  queue: Promise<unknown>
  knownFileBytes: number | undefined
  appendsSinceStat: number
  capMarkerWritten: boolean
  registration: WriterRegistration | undefined
  lastAppendLocked: boolean | undefined
}

const appendStates = new Map<string, SessionAppendState>()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function positiveEnvInteger(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

export function maxMatOSSessionEventRecordBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = positiveEnvInteger(env.MATOS_SESSION_EVENT_MAX_RECORD_BYTES)
  return configured !== undefined
    ? Math.max(configured, MIN_EVENT_RECORD_BYTES)
    : DEFAULT_MAX_EVENT_RECORD_BYTES
}

export function maxMatOSSessionFileBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MATOS_SESSION_FILE_MAX_BYTES?.trim()
  if (raw === '0') {
    return Number.POSITIVE_INFINITY
  }
  return positiveEnvInteger(raw) ?? DEFAULT_MAX_SESSION_FILE_BYTES
}

function alwaysLockAppends(env: Record<string, string | undefined>): boolean {
  return env.MATOS_SESSION_APPEND_LOCK?.trim().toLowerCase() === 'always'
}

function joinGraceMs(env: Record<string, string | undefined>): number {
  return (
    positiveEnvInteger(env.MATOS_SESSION_APPEND_JOIN_GRACE_MS) ??
    DEFAULT_JOIN_GRACE_MS
  )
}

function truncateEventText(value: string, max = MAX_EVENT_TEXT_CHARS): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, Math.max(0, max - 32))}\n...[truncated ${value.length - max} chars]`
}

function compactEventDataValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'string') {
    return truncateEventText(value)
  }
  if (typeof value !== 'object') {
    return value
  }
  if (depth >= MAX_EVENT_JSON_DEPTH) {
    return Array.isArray(value)
      ? `[${value.length} items truncated]`
      : '[object truncated]'
  }
  if (Array.isArray(value)) {
    const trimmed = value
      .slice(0, MAX_EVENT_ARRAY_ITEMS)
      .map(item => compactEventDataValue(item, depth + 1))
    if (value.length > MAX_EVENT_ARRAY_ITEMS) {
      trimmed.push(`[${value.length - MAX_EVENT_ARRAY_ITEMS} items truncated]`)
    }
    return trimmed
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, MAX_EVENT_OBJECT_KEYS)) {
    result[key] = compactEventDataValue(item, depth + 1)
  }
  if (entries.length > MAX_EVENT_OBJECT_KEYS) {
    result.__truncatedKeys = entries.length - MAX_EVENT_OBJECT_KEYS
  }
  return result
}

// Keep one serialized event within the atomic single-write append range.
// Progressively: full record, then compacted data (long strings/arrays/deep
// objects trimmed), then an envelope-only fallback with a short preview. The
// envelope (ids, trace fields, type, timestamp) is always preserved. Callers
// redact secrets before this point, so the preview is built from already
// redacted data.
export function serializeBoundedMatOSSessionEvent(
  event: MatOSEvent,
  maxBytes: number = maxMatOSSessionEventRecordBytes(),
): string {
  const serialized = JSON.stringify(event)
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return serialized
  }
  const compacted: MatOSEvent = {
    ...event,
    data: {
      ...(compactEventDataValue(event.data) as Record<string, unknown>),
      storageTruncated: true,
    },
  }
  const compactedSerialized = JSON.stringify(compacted)
  if (Buffer.byteLength(compactedSerialized, 'utf8') <= maxBytes) {
    return compactedSerialized
  }
  return JSON.stringify({
    ...event,
    data: {
      storageTruncated: true,
      originalDataBytes: Buffer.byteLength(JSON.stringify(event.data), 'utf8'),
      preview: JSON.stringify(event.data).slice(0, FALLBACK_PREVIEW_CHARS),
    },
  } satisfies MatOSEvent)
}

// --- writer registry -------------------------------------------------------

const exitCleanupSentinels = new Set<string>()
const heartbeatSentinels = new Set<string>()
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) {
    return
  }
  exitHookInstalled = true
  process.once('exit', () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
    }
    for (const sentinelPath of exitCleanupSentinels) {
      try {
        unlinkSync(sentinelPath)
      } catch {
        // Best-effort cleanup; stale sentinels expire by mtime.
      }
    }
  })
}

function sentinelPayload(): string {
  return `${process.pid} ${new Date().toISOString()}\n`
}

// Staleness detection is mtime-based; rewrite the payload instead of relying
// on utimes(), which some network filesystems silently ignore (same defense as
// assets/history/lock.ts).
function startSentinelHeartbeat(sentinelPath: string): void {
  heartbeatSentinels.add(sentinelPath)
  if (heartbeatTimer) {
    return
  }
  heartbeatTimer = setInterval(() => {
    for (const path of heartbeatSentinels) {
      void writeFile(path, sentinelPayload(), 'utf8').catch(() => undefined)
    }
  }, WRITER_HEARTBEAT_MS)
  heartbeatTimer.unref?.()
}

function sentinelPid(name: string): number | undefined {
  const parsed = Number(name.split('.', 1)[0])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function pidLooksAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH')
  }
}

// A foreign sentinel counts as live while its heartbeat is fresh (this also
// covers writers in other pid namespaces, e.g. container-side processes
// appending through a shared mount) or while its pid is visibly alive in this
// namespace. Stale sentinels of dead writers are garbage-collected so crashed
// children do not permanently degrade a session to locked mode.
async function anyLiveForeignWriter(
  registryDir: string,
  foreignNames: string[],
): Promise<boolean> {
  let live = false
  for (const name of foreignNames) {
    const sentinelPath = `${registryDir}/${name}`
    const info = await stat(sentinelPath).catch(() => undefined)
    if (!info) {
      continue
    }
    if (Date.now() - info.mtimeMs < WRITER_SENTINEL_STALE_MS) {
      live = true
      continue
    }
    const pid = sentinelPid(name)
    if (pid !== undefined && pidLooksAlive(pid)) {
      live = true
      continue
    }
    await unlink(sentinelPath).catch(() => undefined)
  }
  return live
}

async function registerWriter(
  path: string,
  env: Record<string, string | undefined>,
): Promise<WriterRegistration> {
  const registryDir = `${path}.writers`
  const sentinelName = `${process.pid}.${randomUUID().slice(0, 8)}${WRITER_SENTINEL_SUFFIX}`
  const sentinelPath = `${registryDir}/${sentinelName}`
  try {
    await mkdir(registryDir, { recursive: true })
    await writeFile(sentinelPath, sentinelPayload(), 'utf8')
    installExitHook()
    exitCleanupSentinels.add(sentinelPath)
    startSentinelHeartbeat(sentinelPath)
    const names = await readdir(registryDir)
    const foreign = names.filter(
      name => name !== sentinelName && name.endsWith(WRITER_SENTINEL_SUFFIX),
    )
    const joiningActiveSession =
      foreign.length > 0 && (await anyLiveForeignWriter(registryDir, foreign))
    return {
      status: 'registered',
      registryDir,
      sentinelName,
      sentinelPath,
      graceUntil: joiningActiveSession ? Date.now() + joinGraceMs(env) : 0,
    }
  } catch {
    // No usable registry (read-only dir, invalid parent, ...): stay on the
    // always-locked path for this process; never fail the append here.
    return { status: 'unavailable' }
  }
}

// Decide whether this append must take the cross-process lock. Called before
// every append that could use the fast path; the registry re-list costs
// ~0.05ms on this host, far below the two metadata mutations of a lock cycle.
async function appendRequiresLock(
  state: SessionAppendState,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const registration = state.registration
  if (!registration || registration.status !== 'registered') {
    return true
  }
  let names: string[]
  try {
    names = await readdir(registration.registryDir)
  } catch {
    return true
  }
  if (!names.includes(registration.sentinelName)) {
    // Another writer judged us stale and garbage-collected our sentinel (e.g.
    // this process was suspended past the staleness window) and may now be
    // appending unlocked. Re-register and wait a fresh joiner grace before
    // this locked append so the solo writer's probe sees us again first.
    try {
      await writeFile(registration.sentinelPath, sentinelPayload(), 'utf8')
      registration.graceUntil = Date.now() + joinGraceMs(env)
    } catch {
      // Keep going on the locked path.
    }
    return true
  }
  const foreign = names.filter(
    name =>
      name !== registration.sentinelName &&
      name.endsWith(WRITER_SENTINEL_SUFFIX),
  )
  if (foreign.length === 0) {
    return false
  }
  return anyLiveForeignWriter(registration.registryDir, foreign)
}

// --- append path -----------------------------------------------------------

// Serialize appends to one session file across processes. Same shape as the
// monitor-records lock: mkdir is the atomic acquire, stale locks (crashed
// holders) are reclaimed by mtime, and a timeout degrades to an unlocked
// append instead of losing the event.
async function withSessionAppendLock(
  path: string,
  run: () => Promise<void>,
): Promise<void> {
  const lockDir = `${path}.lock`
  const start = Date.now()
  let locked = false
  while (Date.now() - start < APPEND_LOCK_TIMEOUT_MS) {
    try {
      await mkdir(lockDir)
      locked = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Missing/invalid parent: let the append itself surface the error.
        break
      }
      const info = await stat(lockDir).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > APPEND_LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      await sleep(25)
    }
  }
  try {
    await run()
  } finally {
    if (locked) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function appendState(path: string): SessionAppendState {
  let state = appendStates.get(path)
  if (!state) {
    state = {
      queue: Promise.resolve(),
      knownFileBytes: undefined,
      appendsSinceStat: 0,
      capMarkerWritten: false,
      registration: undefined,
      lastAppendLocked: undefined,
    }
    appendStates.set(path, state)
  }
  return state
}

async function refreshKnownFileBytes(
  path: string,
  state: SessionAppendState,
): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  state.knownFileBytes = info?.size ?? 0
  state.appendsSinceStat = 0
}

async function appendLine(
  path: string,
  state: SessionAppendState,
  serialized: string,
  useLock: boolean,
): Promise<void> {
  if (useLock) {
    await withSessionAppendLock(path, async () => {
      await appendFile(path, `${serialized}\n`, 'utf8')
    })
  } else {
    await appendFile(path, `${serialized}\n`, 'utf8')
  }
  // Only advance an already-established size; a fabricated count before the
  // first stat would hide pre-existing file content from cap enforcement.
  if (state.knownFileBytes !== undefined) {
    state.knownFileBytes += Buffer.byteLength(serialized, 'utf8') + 1
  }
  state.appendsSinceStat += 1
}

function buildCapMarkerEvent(droppedEvent: MatOSEvent, cap: number): MatOSEvent {
  return {
    ...droppedEvent,
    id: randomUUID(),
    type: 'matos.session.storage.capped',
    timestamp: new Date().toISOString(),
    data: {
      maxFileBytes: cap,
      firstDroppedEventType: droppedEvent.type,
      note: 'session event file reached its size cap; further non-lifecycle events are not persisted',
    },
  }
}

async function performAppend(
  path: string,
  state: SessionAppendState,
  event: MatOSEvent,
  env: Record<string, string | undefined>,
): Promise<MatOSSessionEventAppendOutcome> {
  let useLock = true
  if (!alwaysLockAppends(env)) {
    if (!state.registration) {
      state.registration = await registerWriter(path, env)
    }
    useLock = await appendRequiresLock(state, env)
    const registration = state.registration
    if (registration.status === 'registered') {
      const graceRemaining = registration.graceUntil - Date.now()
      if (graceRemaining > 0) {
        await sleep(graceRemaining)
      }
    }
  }
  // Lockedness changed since the last append: another process may have been
  // writing meanwhile, so the local byte accounting can be stale.
  if (state.lastAppendLocked !== undefined && state.lastAppendLocked !== useLock) {
    state.knownFileBytes = undefined
  }
  state.lastAppendLocked = useLock

  const serialized = serializeBoundedMatOSSessionEvent(
    event,
    maxMatOSSessionEventRecordBytes(env),
  )
  const cap = maxMatOSSessionFileBytes(env)
  if (Number.isFinite(cap) && !CAP_EXEMPT_EVENT_TYPES.has(event.type)) {
    if (
      state.knownFileBytes === undefined ||
      state.appendsSinceStat >= FILE_SIZE_RESTAT_EVERY_APPENDS
    ) {
      await refreshKnownFileBytes(path, state)
    }
    const lineBytes = Buffer.byteLength(serialized, 'utf8') + 1
    if ((state.knownFileBytes ?? 0) + lineBytes > cap) {
      if (!state.capMarkerWritten) {
        state.capMarkerWritten = true
        await appendLine(
          path,
          state,
          serializeBoundedMatOSSessionEvent(
            buildCapMarkerEvent(event, cap),
            maxMatOSSessionEventRecordBytes(env),
          ),
          useLock,
        )
      }
      return 'capped'
    }
  }
  await appendLine(path, state, serialized, useLock)
  return 'appended'
}

// Append one already-redacted event to a session JSONL file. In-process calls
// against the same path are chained on a queue so a burst of record() calls
// can never interleave partial lines; the writer registry + cross-process lock
// inside performAppend covers writers in other processes appending to the same
// inherited session.
export async function appendMatOSSessionEvent(
  path: string,
  event: MatOSEvent,
  env: Record<string, string | undefined> = process.env,
): Promise<MatOSSessionEventAppendOutcome> {
  const state = appendState(path)
  const run = state.queue
    .catch(() => undefined)
    .then(() => performAppend(path, state, event, env))
  state.queue = run
  return run
}

// --- stale lock / writer-registry residue sweep -----------------------------

// A crash during a session's final append can orphan `<session>.jsonl.lock`
// dirs and `<session>.jsonl.writers/` registries. Both are invisible to
// session listings (which only look at `*.jsonl` files) and are otherwise
// reclaimed only when a later append touches the same session — which never
// happens for a finished session, so they accumulate forever.
//
// The sweeper is bounded (entry cap per run), best-effort (every failure is
// swallowed), and double-gated per artifact:
//   - lock dirs: removed only when far older than the append path's own
//     stale-reclaim window, so a live locked append is never raced.
//   - writer registries: sentinels are removed only when their heartbeat is
//     stale AND their pid is not visibly alive (the same liveness rule the
//     append path uses), and the directory itself is removed with a
//     non-recursive rmdir so a concurrently created sentinel keeps it alive.

// Sweeper-side age floor for orphaned lock dirs: comfortably beyond
// APPEND_LOCK_STALE_MS (15s), so only crash residue qualifies, never a lock
// currently being contended or reclaimed by an active appender.
const RESIDUE_SWEEP_LOCK_MIN_AGE_MS = 10 * 60_000
const RESIDUE_SWEEP_DEFAULT_MAX_ENTRIES = 200
const RESIDUE_SWEEP_MIN_INTERVAL_MS = 5 * 60_000

const SESSION_LOCK_DIR_SUFFIX = '.jsonl.lock'
const SESSION_WRITERS_DIR_SUFFIX = '.jsonl.writers'

export type MatOSSessionAppendResidueSweepResult = {
  scannedEntries: number
  removedLockDirs: string[]
  removedWriterDirs: string[]
  removedSentinels: number
}

export async function sweepStaleMatOSSessionAppendResidue(
  sessionsDir: string,
  options: {
    now?: number
    maxEntries?: number
    lockMinAgeMs?: number
    sentinelStaleMs?: number
  } = {},
): Promise<MatOSSessionAppendResidueSweepResult> {
  const result: MatOSSessionAppendResidueSweepResult = {
    scannedEntries: 0,
    removedLockDirs: [],
    removedWriterDirs: [],
    removedSentinels: 0,
  }
  const now = options.now ?? Date.now()
  const maxEntries = Math.max(
    1,
    options.maxEntries ?? RESIDUE_SWEEP_DEFAULT_MAX_ENTRIES,
  )
  const lockMinAgeMs = options.lockMinAgeMs ?? RESIDUE_SWEEP_LOCK_MIN_AGE_MS
  const sentinelStaleMs = options.sentinelStaleMs ?? WRITER_SENTINEL_STALE_MS
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch {
    return result
  }
  for (const name of names) {
    if (result.scannedEntries >= maxEntries) {
      break
    }
    const isLockDir = name.endsWith(SESSION_LOCK_DIR_SUFFIX)
    const isWritersDir = name.endsWith(SESSION_WRITERS_DIR_SUFFIX)
    if (!isLockDir && !isWritersDir) {
      continue
    }
    result.scannedEntries += 1
    const path = join(sessionsDir, name)
    try {
      const info = await stat(path)
      if (!info.isDirectory()) {
        continue
      }
      if (isLockDir) {
        if (now - info.mtimeMs < lockMinAgeMs) {
          continue
        }
        // Same removal shape as the append path's stale-lock reclaim.
        await rm(path, { recursive: true, force: true })
        result.removedLockDirs.push(name)
        continue
      }
      // Freshness gate: sentinel create/remove updates the registry dir
      // mtime, so a recently active registry is left entirely alone.
      if (now - info.mtimeMs < sentinelStaleMs) {
        continue
      }
      const entries = await readdir(path)
      let liveOrForeign = false
      for (const entry of entries) {
        if (!entry.endsWith(WRITER_SENTINEL_SUFFIX)) {
          // Unknown file in the registry: never remove the directory.
          liveOrForeign = true
          continue
        }
        const sentinelPath = join(path, entry)
        const sentinelInfo = await stat(sentinelPath).catch(() => undefined)
        if (!sentinelInfo) {
          continue
        }
        // Same liveness rule as anyLiveForeignWriter: fresh heartbeat OR a
        // visibly alive pid keeps the sentinel (covers container-side writers
        // in other pid namespaces via the heartbeat half).
        if (now - sentinelInfo.mtimeMs < sentinelStaleMs) {
          liveOrForeign = true
          continue
        }
        const pid = sentinelPid(entry)
        if (pid !== undefined && pidLooksAlive(pid)) {
          liveOrForeign = true
          continue
        }
        try {
          await unlink(sentinelPath)
          result.removedSentinels += 1
        } catch {
          liveOrForeign = true
        }
      }
      if (liveOrForeign) {
        continue
      }
      // Non-recursive on purpose: a writer registering concurrently recreates
      // its sentinel and the rmdir fails with ENOTEMPTY instead of deleting a
      // live registration.
      await rmdir(path)
      result.removedWriterDirs.push(name)
    } catch {
      // Best-effort: concurrent appends/registrations win every race.
    }
  }
  return result
}

const residueSweepLastRunAt = new Map<string, number>()

// Fire-and-forget, per-process throttled trigger for callers that sit off the
// append hot path (session listings). Never throws, never blocks the caller.
export function maybeSweepMatOSSessionAppendResidue(
  sessionsDir: string,
  options: { minIntervalMs?: number } = {},
): void {
  const minIntervalMs =
    options.minIntervalMs ?? RESIDUE_SWEEP_MIN_INTERVAL_MS
  const now = Date.now()
  const lastRunAt = residueSweepLastRunAt.get(sessionsDir) ?? 0
  if (now - lastRunAt < minIntervalMs) {
    return
  }
  residueSweepLastRunAt.set(sessionsDir, now)
  void sweepStaleMatOSSessionAppendResidue(sessionsDir).catch(() => undefined)
}
