import { createHash, type Hash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readJson, writeJson } from './jsonIo.js'
import type { MatOSWorkflowRunSnapshot } from './types.js'

/**
 * Versioned runtime receipt for a native workflow run.
 *
 * The case-facing run.json is intentionally only a projection.  Benchmark
 * evidence must also see this receipt and the native event/graph/input/output
 * files produced by the runtime.  A future controller can move the receipt to
 * an append-only store or add a signature without changing the evidence
 * contract.
 */
export const MATOS_WORKFLOW_RUNTIME_RECEIPT_SCHEMA_VERSION = 1 as const
export const MATOS_WORKFLOW_RUN_SCHEMA_VERSION = 2 as const
export const MATOS_WORKFLOW_RUNTIME_RECEIPT_FILE = 'runtime-receipt.json'

export type MatOSWorkflowRuntimeReceipt = Readonly<{
  schemaVersion: typeof MATOS_WORKFLOW_RUNTIME_RECEIPT_SCHEMA_VERSION
  runSchemaVersion: typeof MATOS_WORKFLOW_RUN_SCHEMA_VERSION
  receiptId: string
  runtime: 'cmatos-native-workflow'
  runId: string
  workflowRef: string
  status: string
  createdAt: string
  updatedAt: string
  graphSnapshotPath: string
  graphSha256: string
  inputsSha256: string
  outputsSha256: string
  artifactsSha256: string
  eventsSha256: string
  eventCount: number
  traceId?: string
  sessionId?: string
  scopeRef?: string
  resource?: Readonly<{
    resourceClass: string
    requiresGpu: boolean
    gpuCount: number
    gpuMpiRanks: number
    cpuThreads: number
    cudaVisibleDevices?: string
  }>
}>

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Digest cache for the receipt's immutable-input files (graph snapshot,
 * inputs/outputs/artifacts). These are rewritten via temp+rename, so a
 * (inode, size, mtimeMs) triple identifies a specific content version; only
 * files that actually changed since the last receipt refresh are re-read.
 */
const fileDigestCache = new Map<
  string,
  { ino: number; size: number; mtimeMs: number; sha: string }
>()
const FILE_DIGEST_CACHE_MAX_ENTRIES = 512

async function fileSha256(path: string): Promise<string> {
  const key = resolve(path)
  let info
  try {
    info = await stat(key)
  } catch {
    // Preserve the historical behavior: a missing file surfaces as the
    // readFile error below rather than a fabricated digest.
    return sha256(await readFile(path))
  }
  const cached = fileDigestCache.get(key)
  if (
    cached &&
    cached.ino === Number(info.ino) &&
    cached.size === info.size &&
    cached.mtimeMs === info.mtimeMs
  ) {
    return cached.sha
  }
  const sha = sha256(await readFile(path))
  if (fileDigestCache.size >= FILE_DIGEST_CACHE_MAX_ENTRIES) {
    const oldest = fileDigestCache.keys().next().value
    if (oldest !== undefined) {
      fileDigestCache.delete(oldest)
    }
  }
  fileDigestCache.set(key, {
    ino: Number(info.ino),
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha,
  })
  return sha
}

/**
 * Incremental whole-file digest state for events.jsonl. The receipt refreshes
 * after every event append, and events.jsonl only ever grows in this process
 * (appends hold the events file lock), so instead of re-reading the entire
 * log each time we keep a running sha256 stream (`Hash.copy()` yields the
 * digest without finalizing the stream) plus the byte offset and line count
 * it covers. When another process appended concurrently the size no longer
 * matches our offset and the state is rebuilt from a full read — correctness
 * never depends on the cache, only the common-case cost does.
 *
 * The digest stays `sha256(<entire file bytes>)`, byte-identical to what
 * external verifiers can recompute using the canonical receipt fields.
 */
type EventDigestState = {
  bytes: number
  lineCount: number
  hash: Hash
  pendingPartialLine: string
}

const eventDigestStates = new Map<string, EventDigestState>()
const EVENT_DIGEST_CACHE_MAX_ENTRIES = 64

function countNonEmptyLines(chunk: string, state: { pending: string }): number {
  let count = 0
  let start = 0
  for (;;) {
    const index = chunk.indexOf('\n', start)
    if (index < 0) {
      state.pending += chunk.slice(start)
      return count
    }
    const line = state.pending + chunk.slice(start, index)
    if (line.trim()) {
      count += 1
    }
    state.pending = ''
    start = index + 1
  }
}

function rememberEventDigestState(key: string, state: EventDigestState): void {
  if (!eventDigestStates.has(key) && eventDigestStates.size >= EVENT_DIGEST_CACHE_MAX_ENTRIES) {
    const oldest = eventDigestStates.keys().next().value
    if (oldest !== undefined) {
      eventDigestStates.delete(oldest)
    }
  }
  eventDigestStates.set(key, state)
}

async function eventDigest(runDir: string): Promise<{
  eventsSha256: string
  eventCount: number
}> {
  const path = join(runDir, 'events.jsonl')
  const key = resolve(path)
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    eventDigestStates.delete(key)
    return { eventsSha256: sha256(''), eventCount: 0 }
  }

  let state = eventDigestStates.get(key)
  if (state && (state.bytes > size)) {
    // The file shrank (tampering/reset) — the incremental state is invalid.
    state = undefined
    eventDigestStates.delete(key)
  }

  try {
    if (!state) {
      state = {
        bytes: 0,
        lineCount: 0,
        hash: createHash('sha256'),
        pendingPartialLine: '',
      }
    }
    if (size > state.bytes) {
      const handle = await open(path, 'r')
      try {
        let position = state.bytes
        const buffer = Buffer.alloc(Math.min(size - state.bytes, 1024 * 1024))
        while (position < size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, size - position),
            position,
          )
          if (bytesRead <= 0) {
            break
          }
          const chunk = buffer.subarray(0, bytesRead)
          state.hash.update(chunk)
          const pendingBox = { pending: state.pendingPartialLine }
          state.lineCount += countNonEmptyLines(
            chunk.toString('utf8'),
            pendingBox,
          )
          state.pendingPartialLine = pendingBox.pending
          position += bytesRead
        }
        state.bytes = position
      } finally {
        await handle.close()
      }
    }
    rememberEventDigestState(key, state)
    return {
      // Hash.copy() digests the bytes seen so far without consuming the
      // stream, so the next append only hashes its own delta.
      eventsSha256: state.hash.copy().digest('hex'),
      eventCount:
        state.lineCount + (state.pendingPartialLine.trim() ? 1 : 0),
    }
  } catch {
    // Any incremental-path failure falls back to the simple full read.
    eventDigestStates.delete(key)
    try {
      const raw = await readFile(path, 'utf8')
      return {
        eventsSha256: sha256(raw),
        eventCount: raw.split(/\r?\n/).filter(line => line.trim()).length,
      }
    } catch {
      return { eventsSha256: sha256(''), eventCount: 0 }
    }
  }
}

function receiptBody(
  snapshot: MatOSWorkflowRunSnapshot,
  files: {
    graphSha256: string
    inputsSha256: string
    outputsSha256: string
    artifactsSha256: string
    eventsSha256: string
    eventCount: number
  },
) {
  const resourceClass = process.env.MATOS_WORKFLOW_RESOURCE_CLASS?.trim()
  const parseCount = (name: string): number => {
    const value = Number.parseInt(process.env[name] ?? '', 10)
    return Number.isFinite(value) && value >= 0 ? value : 0
  }
  const resource = resourceClass
    ? {
        resourceClass,
        requiresGpu: process.env.MATOS_WORKFLOW_REQUIRES_GPU === '1',
        gpuCount: parseCount('MATOS_WORKFLOW_GPU_COUNT'),
        gpuMpiRanks: parseCount('MATOS_WORKFLOW_GPU_MPI_RANKS'),
        cpuThreads: parseCount('MATOS_WORKFLOW_CPU_THREADS'),
        ...(process.env.CUDA_VISIBLE_DEVICES !== undefined
          ? { cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES }
          : {}),
      }
    : undefined
  return {
    schemaVersion: MATOS_WORKFLOW_RUNTIME_RECEIPT_SCHEMA_VERSION,
    runSchemaVersion: MATOS_WORKFLOW_RUN_SCHEMA_VERSION,
    runtime: 'cmatos-native-workflow' as const,
    runId: snapshot.runId,
    workflowRef: snapshot.workflowRef,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    graphSnapshotPath: snapshot.graphSnapshotPath,
    ...files,
    ...(snapshot.trace?.traceId ? { traceId: snapshot.trace.traceId } : {}),
    ...(snapshot.trace?.sessionId ? { sessionId: snapshot.trace.sessionId } : {}),
    ...(snapshot.trace?.scopeRef ? { scopeRef: snapshot.trace.scopeRef } : {}),
    ...(resource ? { resource } : {}),
  }
}

/** Write the latest controller-owned projection after a runtime transition. */
export async function writeWorkflowRuntimeReceipt(
  runDir: string,
): Promise<MatOSWorkflowRuntimeReceipt> {
  const snapshot = await readJson<MatOSWorkflowRunSnapshot>(
    join(runDir, 'run.json'),
  )
  const files = {
    graphSha256: await fileSha256(join(runDir, snapshot.graphSnapshotPath)),
    inputsSha256: await fileSha256(join(runDir, 'inputs.json')),
    outputsSha256: await fileSha256(join(runDir, 'outputs.json')),
    artifactsSha256: await fileSha256(join(runDir, 'artifacts.json')),
    ...(await eventDigest(runDir)),
  }
  const body = receiptBody(snapshot, files)
  const receipt = {
    ...body,
    receiptId: `workflow-runtime-receipt:${sha256(JSON.stringify(body))}`,
  }
  await writeJson(join(runDir, MATOS_WORKFLOW_RUNTIME_RECEIPT_FILE), receipt)
  return receipt
}
