import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { getMatOSDir } from '../../project.js'

type Event = Record<string, unknown> & { data?: Record<string, unknown> }
type Cache = { version: 1; signature: string; identity: string; size: number; offset: number; head: string; tail: string; events: Event[] }
const DATA_KEYS = new Set(['assetKey', 'reference', 'ref', 'role', 'selectedRole', 'assetKeys', 'selectedAssetKeys', 'refs', 'sourceId', 'sourceCommit', 'userId', 'scopeRef', 'traceId', 'workspaceId', 'runtimeRef', 'execution', 'roleRef', 'hidden', 'userVisible', 'totalCostUsd', 'durationMs', 'numTurns', 'workflowRef', 'nodeId', 'status'])
const EVENT_KEYS = new Set(['id', 'type', 'timestamp', 'sessionId', 'traceId', 'userId', 'scopeRef', 'workspaceId', 'runtimeRef', 'execution', 'roleRef', 'runId', 'nodeId'])
DATA_KEYS.add('toolRef')
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function project(value: unknown): Event {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage event')
  const event: Event = {}
  for (const [key, item] of Object.entries(value)) {
    if (EVENT_KEYS.has(key) && (typeof item === 'string' || typeof item === 'number')) event[key] = item
    if (key === 'data' && item && typeof item === 'object' && !Array.isArray(item)) {
      event.data = Object.fromEntries(Object.entries(item).filter(([name, field]) => DATA_KEYS.has(name) && (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean' || Array.isArray(field) && field.every(entry => typeof entry === 'string'))))
    }
  }
  return event
}

// Derived, disposable index: only usage metadata is retained, never transcript
// text/tool output. Complete newline offsets let interrupted writers resume.
export async function readIndexedUsageEvents<T>(cwd: string, path: string): Promise<{ events: T[]; bytesRead: number; cacheHit: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const dir = join(getMatOSDir(cwd), 'index', 'asset-usage-v1')
  const cachePath = join(dir, `${hash(path)}.json`)
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw new Error('Usage source is not a regular file')
    const size = Number(info.size)
    const identity = `${info.dev}:${info.ino}`
    const signature = `${identity}:${size}:${info.mtimeNs}:${info.ctimeNs}`
    let cache: Cache | undefined
    try {
      const value = JSON.parse(await readFile(cachePath, 'utf8')) as Cache
      if (value.version === 1 && value.identity === identity && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= value.size && value.size <= size && Array.isArray(value.events) && value.events.length <= 200_000) cache = value
    } catch { /* The source log remains authoritative if the cache is missing/corrupt. */ }
    let bytesRead = 0
    async function chunk(start: number, length: number): Promise<Buffer> {
      const buffer = Buffer.alloc(length)
      const result = await handle.read(buffer, 0, length, start)
      bytesRead += result.bytesRead
      return buffer.subarray(0, result.bytesRead)
    }
    if (cache?.signature === signature && cache.offset === size) return { events: cache.events as T[], bytesRead: 0, cacheHit: true }
    if (cache) {
      const head = hash(await chunk(0, Math.min(cache.offset, 4096)))
      const tail = hash(await chunk(Math.max(0, cache.offset - 4096), Math.min(cache.offset, 4096)))
      if (cache.head !== head || cache.tail !== tail || (cache.size === size && cache.signature !== signature)) cache = undefined
    }
    const events = cache ? [...cache.events] : []
    let position = cache?.offset ?? 0
    let offset = position
    let pending = Buffer.alloc(0)
    while (position < size) {
      const bytes = await chunk(position, Math.min(64 * 1024, size - position))
      if (!bytes.length) throw new Error('Usage log changed while being indexed')
      position += bytes.length
      const buffer = Buffer.concat([pending, bytes])
      let start = 0
      for (;;) {
        const newline = buffer.indexOf(10, start)
        if (newline < 0) break
        const line = buffer.subarray(start, newline).toString('utf8').trim()
        if (line) events.push(project(JSON.parse(line)))
        offset += newline - start + 1
        start = newline + 1
      }
      pending = buffer.subarray(start)
      if (pending.length > 8 * 1024 * 1024 || events.length > 200_000) throw new Error('Usage event index limit exceeded')
    }
    const next: Cache = { version: 1, signature, identity, size, offset,
      head: hash(await chunk(0, Math.min(offset, 4096))), tail: hash(await chunk(Math.max(0, offset - 4096), Math.min(offset, 4096))), events }
    const serialized = JSON.stringify(next)
    if (serialized.length <= 16 * 1024 * 1024) {
      const tmp = `${cachePath}.${randomUUID()}.tmp`
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const output = await open(tmp, 'wx', 0o600)
        try { await output.writeFile(serialized, 'utf8') } finally { await output.close() }
        await rename(tmp, cachePath)
      } catch { /* Disk pressure must not make otherwise readable usage disappear. */ }
      finally { await rm(tmp, { force: true }).catch(() => undefined) }
    }
    // A complete last JSON value without a newline is viewable, but not part
    // of the checkpoint: a writer may still append bytes to that line.
    if (pending.toString('utf8').trim()) {
      try { events.push(project(JSON.parse(pending.toString('utf8')))) } catch { /* incomplete tail */ }
    }
    return { events: events as T[], bytesRead, cacheHit: false }
  } finally { await handle.close() }
}
