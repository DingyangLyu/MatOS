import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  MatOSAlgorithmDecisionFallback,
  MatOSAlgorithmProviderSource,
} from './telemetry.js'

export type MatOSAlgorithmRunDecisionReference = {
  schemaVersion: 1
  decisionId: string
  /** Untrusted provider-local identity retained only as bounded provenance. */
  providerDecisionId?: string
  at: string
  runId: string
  nodeId?: string
  attempt?: number
  /** Online policy surface, absent for an ordinary component tool receipt. */
  surfaceId?: string
  providerId: string
  source: MatOSAlgorithmProviderSource | 'asset-tool'
  fallback?: MatOSAlgorithmDecisionFallback
  inputDigest?: string
  applied?: boolean
  shadowOfDecisionId?: string
  differsFromApplied?: boolean
  algorithmPlane?: 'policy' | 'controller' | 'optimizer'
  providerVersion?: string
  assetRef?: string
  configDigest?: string
  implementationDigest?: string
  manifestDigest?: string
  receiptDigest?: string
  evaluationRefs?: string[]
  validationRefs?: string[]
  metricRefs?: string[]
}

const pendingByRunDir = new Map<string, Promise<void>>()
const MATOS_ALGORITHM_DECISION_REFS_MAX_BYTES = 4 * 1024 * 1024

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === code,
  )
}

async function appendDecisionReferenceSafely(
  runDir: string,
  serialized: string,
): Promise<void> {
  const directory = await lstat(runDir)
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Algorithm decision run directory is unsafe')
  }
  const realRunDir = await realpath(runDir)
  const path = join(realRunDir, 'algorithm-decisions.jsonl')
  let beforeSize = 0
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('Algorithm decision ledger is not a regular file')
    }
    beforeSize = before.size
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (beforeSize + bytes > MATOS_ALGORITHM_DECISION_REFS_MAX_BYTES) {
    throw new Error('Algorithm decision ledger exceeds its size limit')
  }
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size !== beforeSize ||
      opened.size + bytes > MATOS_ALGORITHM_DECISION_REFS_MAX_BYTES
    ) {
      throw new Error('Algorithm decision ledger changed before append')
    }
    await handle.chmod(0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function matOSAlgorithmRunDecisionReferencesPath(runDir: string): string {
  return join(runDir, 'algorithm-decisions.jsonl')
}

function enqueueMatOSAlgorithmRunDecisionReference(
  runDir: string,
  record: MatOSAlgorithmRunDecisionReference,
): Promise<void> {
  const previous = pendingByRunDir.get(runDir) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(() =>
      appendDecisionReferenceSafely(runDir, `${JSON.stringify(record)}\n`),
    )
    .then(() => undefined)
  const next = operation
    .catch(() => undefined)
    .finally(() => {
      if (pendingByRunDir.get(runDir) === next) pendingByRunDir.delete(runDir)
    })
  pendingByRunDir.set(runDir, next)
  return operation
}

export function recordMatOSAlgorithmRunDecisionReference(
  runDir: string,
  record: MatOSAlgorithmRunDecisionReference,
): void {
  void enqueueMatOSAlgorithmRunDecisionReference(runDir, record)
}

/** Component receipts are causal evidence, so their native JSONL append is awaited. */
export async function appendMatOSAlgorithmRunDecisionReference(
  runDir: string,
  record: MatOSAlgorithmRunDecisionReference,
): Promise<void> {
  await enqueueMatOSAlgorithmRunDecisionReference(runDir, record)
}

export async function flushMatOSAlgorithmRunDecisionReferences(
  runDir: string,
): Promise<void> {
  await pendingByRunDir.get(runDir)
}

export async function readMatOSAlgorithmRunDecisionReferences(
  runDir: string,
): Promise<MatOSAlgorithmRunDecisionReference[]> {
  await flushMatOSAlgorithmRunDecisionReferences(runDir)
  let content: string
  try {
    content = await readFile(matOSAlgorithmRunDecisionReferencesPath(runDir), 'utf8')
  } catch {
    return []
  }
  const records: MatOSAlgorithmRunDecisionReference[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as MatOSAlgorithmRunDecisionReference
      if (
        record?.schemaVersion === 1 &&
        typeof record.decisionId === 'string' &&
        typeof record.runId === 'string' &&
        (typeof record.surfaceId === 'string' ||
          (record.source === 'asset-tool' &&
            typeof record.nodeId === 'string' &&
            typeof record.assetRef === 'string'))
      ) {
        records.push(record)
      }
    } catch {
      // A partial final row does not invalidate earlier causal references.
    }
  }
  return records
}
