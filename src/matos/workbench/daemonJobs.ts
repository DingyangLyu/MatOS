import { existsSync,readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname,join } from 'node:path'
/** Read-only compatibility for historical execution records. The web daemon
 * remains active; the old multi-user execution daemon is not part of this edition. */
export type MatOSDaemonJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type MatOSDaemonJobMetadata = {
  traceId?: string
  sessionId?: string
  parentSessionId?: string
  turnId?: string
  userId?: string
  scopeRef?: string
  workspaceId?: string
  runtimeRef?: string
  roleRef?: string
  execution?: string
  projectId?: string
  conversationId?: string
  topicId?: string
  areaId?: string
  matosChatSessionId?: string
  upstreamSessionId?: string
  resumeCommand?: string
}

export type MatOSDaemonJobRecord = {
  jobId: string
  pid: number
  status: MatOSDaemonJobStatus
  jobClass?: 'interactive' | 'local-background'
  argvPreview: string[]
  cwd: string
  envKeys: string[]
  metadata?: MatOSDaemonJobMetadata
  startedAt: string
  completedAt?: string
  exitCode?: number
  signal?: string
  error?: string
}

export type MatOSDaemonJobLedgerFile={schemaVersion:1;updatedAt:string;jobs:MatOSDaemonJobRecord[]}
export function readMatOSDaemonJobLedgerFile(path: string): MatOSDaemonJobLedgerFile | undefined {
  if (!existsSync(path)) {
    return undefined
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as MatOSDaemonJobLedgerFile
    return value && value.schemaVersion === 1 && Array.isArray(value.jobs)
      ? value
      : undefined
  } catch {
    return undefined
  }
}

const DEFAULT_MATOS_DAEMON_IPC_DIR = '/workspace/ipc'

/**
 * Resolve the directory that holds per-job captured stdout/stderr for
 * background ("submit" mode) daemon jobs. The daemon writer and any reader
 * (workbench facade, CLI) must agree on this path, so the resolution order is
 * shared here:
 *   1. explicit `jobsOutputDir`
 *   2. `MATOS_DAEMON_JOB_OUTPUT_DIR`
 *   3. a `jobs/` directory next to the ledger file
 *   4. a `jobs/` directory next to the socket
 *   5. the default `/workspace/ipc/jobs`
 */
export function resolveMatOSDaemonJobsOutputDir(input: {
  jobsOutputDir?: string
  ledgerPath?: string
  socketPath?: string
} = {}): string {
  const explicit = input.jobsOutputDir?.trim()
  if (explicit) {
    return explicit
  }
  const envDir = process.env.MATOS_DAEMON_JOB_OUTPUT_DIR?.trim()
  if (envDir) {
    return envDir
  }
  const ledger = input.ledgerPath?.trim() || process.env.MATOS_DAEMON_JOB_LEDGER?.trim()
  if (ledger) {
    return join(dirname(ledger), 'jobs')
  }
  const socket = input.socketPath?.trim()
  if (socket) {
    return join(dirname(socket), 'jobs')
  }
  return join(DEFAULT_MATOS_DAEMON_IPC_DIR, 'jobs')
}

export function matosDaemonJobOutputPath(dir: string, jobId: string): string {
  const safeJobId = String(jobId).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(dir, `${safeJobId}.out`)
}

export type MatOSDaemonJobOutputSlice = {
  jobId: string
  exists: boolean
  offset: number
  nextOffset: number
  size: number
  content: string
}

/**
 * Read a captured daemon job output file from a character offset. The whole
 * file is decoded as UTF-8 and sliced on string (UTF-16) boundaries so live
 * polling never splits a multibyte character, at the cost of re-reading the
 * file each call. Job outputs are chat/log sized, so this stays cheap.
 */
export async function readMatOSDaemonJobOutputSlice(input: {
  dir: string
  jobId: string
  offset?: number
  endOffset?: number
  maxBytes?: number
}): Promise<MatOSDaemonJobOutputSlice> {
  const requestedOffset =
    Number.isInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 0
  const requestedEndOffset =
    Number.isInteger(input.endOffset) && Number(input.endOffset) > 0
      ? Number(input.endOffset)
      : undefined
  const requestedMaxBytes =
    Number.isInteger(input.maxBytes) && Number(input.maxBytes) > 0
      ? Number(input.maxBytes)
      : undefined
  const path = matosDaemonJobOutputPath(input.dir, input.jobId)
  let full: string
  try {
    full = await readFile(path, 'utf8')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return {
        jobId: input.jobId,
        exists: false,
        offset: requestedOffset,
        nextOffset: requestedOffset,
        size: 0,
        content: '',
      }
    }
    throw error
  }
  const offset = Math.min(requestedOffset, full.length)
  const boundedEndOffset =
    requestedEndOffset !== undefined
      ? Math.min(Math.max(offset, requestedEndOffset), full.length)
      : full.length
  const nextOffset =
    requestedMaxBytes !== undefined
      ? Math.min(boundedEndOffset, offset + requestedMaxBytes)
      : boundedEndOffset
  return {
    jobId: input.jobId,
    exists: true,
    offset,
    nextOffset,
    size: full.length,
    content: full.slice(offset, nextOffset),
  }
}

export const DEFAULT_MATOS_DAEMON_SOCKET = ''
export const DEFAULT_MATOS_DAEMON_TOKEN_FILE = ''
const UNAVAILABLE = 'Legacy workspace-daemon execution is unavailable; use MatOS web chat or matos run.'
export async function listMatOSDaemonJobs(_input?: unknown):Promise<{jobs:MatOSDaemonJobRecord[]}>{throw new Error(UNAVAILABLE)}
export async function submitMatOSDaemonCommand(_input:unknown):Promise<{jobId:string;pid:number}>{throw new Error(UNAVAILABLE)}
export async function cancelMatOSDaemonJob(_input:unknown):Promise<{job:MatOSDaemonJobRecord}>{throw new Error(UNAVAILABLE)}
export async function* streamMatOSDaemonChatTurn(_input:unknown):AsyncGenerator<Record<string,unknown>&{job?:MatOSDaemonJobRecord}>{throw new Error(UNAVAILABLE)}
