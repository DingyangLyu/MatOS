import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getMatOSDir } from '../project.js'

export type MatOSAlgorithmProviderSource =
  | 'explicit'
  | 'env'
  | 'role'
  | 'default'
  | 'shadow'

export type MatOSAlgorithmDecisionFallback =
  | 'provider-error'
  | 'async-not-supported'
  | 'unknown-provider'
  | 'empty-decision'
  | 'timeout'
  | 'circuit-open'

export type MatOSAlgorithmDecisionRecord = {
  schemaVersion: 1
  decisionId: string
  at: string
  surfaceId: string
  providerId: string
  source: MatOSAlgorithmProviderSource
  requested?: string
  fallback?: MatOSAlgorithmDecisionFallback
  latencyMs: number
  inputDigest?: string
  summary?: Record<string, unknown>
  traceId?: string
  sessionId?: string
  workflowRunId?: string
  workflowNodeId?: string
  attempt?: number
  scopeRef?: string
  /** False for a counterfactual shadow suggestion that never affected runtime. */
  applied?: boolean
  shadowOfDecisionId?: string
  differsFromApplied?: boolean
}

const RECENT_DECISION_LIMIT = 256
// Stop appending to the JSONL ledger once it grows past this size so a
// long-lived workspace cannot fill persistent storage with decision records.
const LEDGER_MAX_BYTES = 32 * 1024 * 1024

const recentDecisions: MatOSAlgorithmDecisionRecord[] = []

function telemetryLedgerDisabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = (env.MATOS_ALGO_TELEMETRY ?? process.env.MATOS_ALGO_TELEMETRY ?? '')
    .trim()
    .toLowerCase()
  if (['0', 'off', 'false', 'none'].includes(raw)) {
    return true
  }
  if (['1', 'on', 'true'].includes(raw)) {
    return false
  }
  // Default: keep test runs from appending ledger rows into the repo cwd.
  // Callers often pass a narrow custom env, so fall back to process.env for
  // the test detection instead of trusting the passed env alone.
  return (env.NODE_ENV ?? process.env.NODE_ENV) === 'test'
}

export function matOSAlgorithmTelemetryEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.MATOS_ALGO_TELEMETRY ?? process.env.MATOS_ALGO_TELEMETRY ?? '')
    .trim()
    .toLowerCase()
  return !['0', 'off', 'false', 'none'].includes(raw)
}

export function matOSAlgorithmDecisionLedgerPath(cwd: string): string {
  return join(getMatOSDir(cwd), 'algorithms', 'decisions.jsonl')
}

async function appendLedgerRecord(
  cwd: string,
  record: MatOSAlgorithmDecisionRecord,
): Promise<void> {
  const path = matOSAlgorithmDecisionLedgerPath(cwd)
  try {
    const existing = await stat(path).catch(() => undefined)
    if (existing && existing.size > LEDGER_MAX_BYTES) {
      return
    }
    await mkdir(join(getMatOSDir(cwd), 'algorithms'), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Telemetry must never fail or slow the decision path.
  }
}

export function recordMatOSAlgorithmDecision(
  record: MatOSAlgorithmDecisionRecord,
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
  } = {},
): void {
  recentDecisions.push(record)
  if (recentDecisions.length > RECENT_DECISION_LIMIT) {
    recentDecisions.splice(0, recentDecisions.length - RECENT_DECISION_LIMIT)
  }
  const env = options.env ?? process.env
  if (telemetryLedgerDisabled(env)) {
    return
  }
  void appendLedgerRecord(options.cwd ?? process.cwd(), record)
}

export function recentMatOSAlgorithmDecisions(
  limit = RECENT_DECISION_LIMIT,
): MatOSAlgorithmDecisionRecord[] {
  if (limit <= 0) {
    return []
  }
  return recentDecisions.slice(-limit)
}

export async function readMatOSAlgorithmDecisionRecords(
  cwd: string,
  filter: {
    workflowRunId?: string
    traceId?: string
    surfaceId?: string
    limit?: number
  } = {},
): Promise<MatOSAlgorithmDecisionRecord[]> {
  let content: string
  try {
    content = await readFile(matOSAlgorithmDecisionLedgerPath(cwd), 'utf8')
  } catch {
    return []
  }
  const records: MatOSAlgorithmDecisionRecord[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as MatOSAlgorithmDecisionRecord
      if (
        record?.schemaVersion !== 1 ||
        typeof record.decisionId !== 'string' ||
        typeof record.surfaceId !== 'string'
      ) {
        continue
      }
      if (filter.workflowRunId && record.workflowRunId !== filter.workflowRunId) {
        continue
      }
      if (filter.traceId && record.traceId !== filter.traceId) continue
      if (filter.surfaceId && record.surfaceId !== filter.surfaceId) continue
      records.push(record)
    } catch {
      // A truncated telemetry line must not make the rest of the ledger unreadable.
    }
  }
  const limit = filter.limit ?? records.length
  return limit > 0 ? records.slice(-limit) : []
}

export function clearMatOSAlgorithmDecisionLog(): void {
  recentDecisions.length = 0
}
