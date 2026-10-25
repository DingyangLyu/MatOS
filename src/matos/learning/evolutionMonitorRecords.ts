import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { basename, join } from 'node:path'
import { getMatOSDir } from '../project.js'
import { redactTraceValue } from '../sessions/traceContext.js'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'
import type { MatOSSelfEvolutionTriggerKind } from './evolutionMonitor.js'
import type { MatOSEvolutionAlgorithmJournal } from '../algorithms/evolution/protocol.js'
import type {
  MatOSUserFeedbackAnalysis,
  MatOSUserFeedbackAnalysisDiagnostics,
} from './userFeedbackSignals.js'

const MAX_MONITOR_RECORD_BYTES = 128 * 1024
const MAX_MONITOR_TEXT_CHARS = 4000
const MAX_MONITOR_ARRAY_ITEMS = 50
const MAX_MONITOR_OBJECT_KEYS = 80
const MAX_MONITOR_JSON_DEPTH = 5

export type MatOSSelfEvolutionMonitorStatus =
  | 'detected'
  | 'analysis-complete'
  | 'experience-written'
  | 'direct-edit-complete'
  // The edit passed every gate but the approval mode keeps it as a proposal
  // until a human approves it.
  | 'direct-edit-proposed'
  | 'direct-edit-blocked'
  | 'direct-edit-import-blocked'
  | 'skipped-low-quality-trigger'
  // Terminal conclusion when the daily hidden-run budget denied the trigger
  // before any LLM stage ran. Counted as concluded (never pseudo-active) and
  // distinguishable from a genuine 'noop' analysis conclusion.
  | 'budget-denied'
  | 'noop'
  | 'failed'

export type MatOSSelfEvolutionMonitorDirectEditorRun = {
  runId: string
  status: MatOSDirectAssetEditorRunRecord['status']
  statusReason?: string
  createdAt: string
  updatedAt: string
  scope: MatOSDirectAssetEditorRunRecord['scope']
  input?: {
    generatedAt?: string
    scope?: string
    editableRoots?: string[]
    experienceCount?: number
    targetAssetCount?: number
  }
  editorOutput: MatOSDirectAssetEditorRunRecord['editorOutput']
  modifiedFiles: string[]
  createdAssets: string[]
  updatedAssets: string[]
  disabledAssets: string[]
  evidenceRefs: string[]
  roleExitCode: number
  beforeSnapshot?: string
  afterSnapshot?: string
  rollbackSnapshot?: string
  diffPatchPath?: string
  validation?: unknown
  validationBaseline?: unknown
  introducedValidationErrors?: unknown[]
  semanticAcceptance?: unknown
  rollback?: MatOSDirectAssetEditorRunRecord['rollback']
  attempts?: MatOSDirectAssetEditorRunRecord['attempts']
  stderr?: string
  upstreamSessionId?: string
  // Cost visibility for the spend ledger and operators; copied verbatim from
  // the full run record when present.
  usage?: MatOSDirectAssetEditorRunRecord['usage']
  totalCostUsd?: number
  truncated?: boolean
}

export type MatOSSelfEvolutionMonitorRecord = {
  algorithm?: MatOSEvolutionAlgorithmJournal
  recordId: string
  sessionId: string
  triggerKind: MatOSSelfEvolutionTriggerKind
  triggerKey: string
  status: MatOSSelfEvolutionMonitorStatus
  createdAt: string
  updatedAt: string
  summary: string
  eventId?: string
  feedbackAnalysis?: MatOSUserFeedbackAnalysis
  llmDiagnostics?: MatOSUserFeedbackAnalysisDiagnostics[]
  experienceRefs?: string[]
  directEditorRunId?: string
  directEditorRun?: MatOSSelfEvolutionMonitorDirectEditorRun
  priorRecordIds?: string[]
  error?: string
  // Set when a run was allowed despite an exhausted daily evolution budget
  // (manual operator-invoked triggers bypass the budget gate).
  budgetWarning?: string
  storageTruncated?: boolean
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function defaultMonitorRoot(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'monitor', 'sessions')
}

export function resolveMatOSSelfEvolutionMonitorRoots(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configured = env.MATOS_EVOLUTION_MONITOR_DIR?.trim()
  const sessionDir = env.MATOS_SESSION_DIR?.trim()
  return uniqueStrings(
    [
      configured,
      sessionDir ? join(sessionDir, 'evolution-monitor', 'sessions') : undefined,
      defaultMonitorRoot(cwd),
    ].filter((root): root is string => Boolean(root)),
  )
}

function primaryMonitorRoot(cwd: string): string {
  return resolveMatOSSelfEvolutionMonitorRoots(cwd)[0] ?? defaultMonitorRoot(cwd)
}

export function safeMonitorSessionSegment(sessionId: string): string {
  const sanitized = sessionId
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 180)
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return 'invalid-session'
  }
  return sanitized
}

function monitorSessionDir(root: string, sessionId: string): string {
  return join(root, safeMonitorSessionSegment(sessionId))
}

export function parseMonitorRecordsJsonl(
  raw: string,
): MatOSSelfEvolutionMonitorRecord[] {
  const records: MatOSSelfEvolutionMonitorRecord[] = []
  for (const line of raw.split('\n').map(item => item.trim()).filter(Boolean)) {
    try {
      records.push(
        normalizeLegacyMonitorRecord(
          JSON.parse(line) as MatOSSelfEvolutionMonitorRecord,
        ),
      )
    } catch {
      // Skip corrupt/partial lines instead of dropping the whole file.
    }
  }
  return records
}

function isLegacyDirtyDirectEditorRun(
  run: MatOSSelfEvolutionMonitorDirectEditorRun,
): boolean {
  return Boolean(
    (run.status === 'failed' || run.status === 'blocked') &&
      run.editorOutput.summary ===
        'Direct asset editor skipped because current assets are dirty.' &&
      run.stderr?.includes('current assets differ from the stable snapshot'),
  )
}

function isLegacyImportBlockedDirectEditorRun(
  run: MatOSSelfEvolutionMonitorDirectEditorRun,
): boolean {
  return Boolean(
    (run.status === 'failed' || run.status === 'blocked') &&
      run.stderr?.includes(
        'import skipped because editable assets changed during the isolated editor run',
      ),
  )
}

function normalizeLegacyMonitorRecord(
  record: MatOSSelfEvolutionMonitorRecord,
): MatOSSelfEvolutionMonitorRecord {
  const directEditorRun = record.directEditorRun
  if (!directEditorRun) {
    return record
  }
  if (isLegacyDirtyDirectEditorRun(directEditorRun)) {
    return {
      ...record,
      status: 'direct-edit-blocked',
      summary:
        'Direct asset editor is blocked because current editable assets differ from the stable baseline.',
      directEditorRun: {
        ...directEditorRun,
        status: 'blocked',
      },
    }
  }
  if (isLegacyImportBlockedDirectEditorRun(directEditorRun)) {
    return {
      ...record,
      status: 'direct-edit-import-blocked',
      summary:
        'Direct asset editor finished in isolation but import was blocked because editable assets changed during the run.',
      directEditorRun: {
        ...directEditorRun,
        status: 'blocked',
      },
    }
  }
  return record
}

export function monitorRecordsPath(root: string, sessionId: string): string {
  return join(monitorSessionDir(root, sessionId), 'records.jsonl')
}

function truncateMonitorText(
  value: string | undefined,
  max = MAX_MONITOR_TEXT_CHARS,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, Math.max(0, max - 32))}\n...[truncated ${value.length - max} chars]`
}

function truncateMonitorArray<T>(
  values: T[] | undefined,
  max = MAX_MONITOR_ARRAY_ITEMS,
): T[] | undefined {
  if (!values) {
    return undefined
  }
  return values.slice(0, max)
}

function compactMonitorJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'string') {
    return truncateMonitorText(value)
  }
  if (typeof value !== 'object') {
    return value
  }
  if (depth >= MAX_MONITOR_JSON_DEPTH) {
    return Array.isArray(value)
      ? `[${value.length} items truncated]`
      : '[object truncated]'
  }
  if (Array.isArray(value)) {
    const trimmed = value
      .slice(0, MAX_MONITOR_ARRAY_ITEMS)
      .map(item => compactMonitorJsonValue(item, depth + 1))
    if (value.length > MAX_MONITOR_ARRAY_ITEMS) {
      trimmed.push(`[${value.length - MAX_MONITOR_ARRAY_ITEMS} items truncated]`)
    }
    return trimmed
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, MAX_MONITOR_OBJECT_KEYS)) {
    result[key] = compactMonitorJsonValue(item, depth + 1)
  }
  if (entries.length > MAX_MONITOR_OBJECT_KEYS) {
    result.__truncatedKeys = entries.length - MAX_MONITOR_OBJECT_KEYS
  }
  return result
}

export function compactDirectEditorRunForMonitor(
  run: MatOSDirectAssetEditorRunRecord,
): MatOSSelfEvolutionMonitorDirectEditorRun {
  const input = run.input
  return {
    runId: run.runId,
    status: run.status,
    ...(run.statusReason ? { statusReason: run.statusReason } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    scope: run.scope,
    input: {
      generatedAt: input.generatedAt,
      scope: input.scope,
      editableRoots: truncateMonitorArray(input.editableRoots),
      experienceCount: input.experiences.length,
      targetAssetCount: input.targetAssets.length,
    },
    editorOutput: {
      ...run.editorOutput,
      summary: truncateMonitorText(run.editorOutput.summary) ?? '',
      modifiedFiles: truncateMonitorArray(run.editorOutput.modifiedFiles) ?? [],
      createdAssets: truncateMonitorArray(run.editorOutput.createdAssets) ?? [],
      updatedAssets: truncateMonitorArray(run.editorOutput.updatedAssets) ?? [],
      disabledAssets: truncateMonitorArray(run.editorOutput.disabledAssets) ?? [],
      evidenceRefs: truncateMonitorArray(run.editorOutput.evidenceRefs) ?? [],
      expectedBehaviorChange: truncateMonitorText(
        run.editorOutput.expectedBehaviorChange,
      ),
      nextSessionEffect: truncateMonitorText(run.editorOutput.nextSessionEffect),
    },
    modifiedFiles: truncateMonitorArray(run.modifiedFiles) ?? [],
    createdAssets: truncateMonitorArray(run.createdAssets) ?? [],
    updatedAssets: truncateMonitorArray(run.updatedAssets) ?? [],
    disabledAssets: truncateMonitorArray(run.disabledAssets) ?? [],
    evidenceRefs: truncateMonitorArray(run.evidenceRefs) ?? [],
    roleExitCode: run.roleExitCode,
    ...(run.beforeSnapshot ? { beforeSnapshot: run.beforeSnapshot } : {}),
    ...(run.afterSnapshot ? { afterSnapshot: run.afterSnapshot } : {}),
    ...(run.rollbackSnapshot ? { rollbackSnapshot: run.rollbackSnapshot } : {}),
    ...(run.diffPatchPath ? { diffPatchPath: run.diffPatchPath } : {}),
    ...(run.validation
      ? { validation: compactMonitorJsonValue(run.validation) }
      : {}),
    ...(run.validationBaseline
      ? { validationBaseline: compactMonitorJsonValue(run.validationBaseline) }
      : {}),
    ...(run.introducedValidationErrors
      ? {
          introducedValidationErrors:
            compactMonitorJsonValue(run.introducedValidationErrors) as unknown[],
        }
      : {}),
    ...(run.semanticAcceptance
      ? { semanticAcceptance: compactMonitorJsonValue(run.semanticAcceptance) }
      : {}),
    ...(run.rollback
      ? {
          rollback: compactMonitorJsonValue(
            run.rollback,
          ) as MatOSDirectAssetEditorRunRecord['rollback'],
        }
      : {}),
    ...(run.attempts
      ? { attempts: truncateMonitorArray(run.attempts.slice(-5)) }
      : {}),
    ...(run.stderr ? { stderr: truncateMonitorText(run.stderr) } : {}),
    ...(run.upstreamSessionId ? { upstreamSessionId: run.upstreamSessionId } : {}),
    ...(run.usage ? { usage: run.usage } : {}),
    ...(run.totalCostUsd !== undefined ? { totalCostUsd: run.totalCostUsd } : {}),
    truncated: true,
  }
}

function compactMonitorRecordForStorage(
  record: MatOSSelfEvolutionMonitorRecord,
): MatOSSelfEvolutionMonitorRecord {
  return {
    ...record,
    summary: truncateMonitorText(record.summary) ?? record.summary,
    ...(record.feedbackAnalysis
      ? {
          feedbackAnalysis: compactMonitorJsonValue(
            redactTraceValue(record.feedbackAnalysis),
          ) as MatOSUserFeedbackAnalysis,
        }
      : {}),
    ...(record.error ? { error: truncateMonitorText(record.error) } : {}),
    ...(record.llmDiagnostics
      ? {
          llmDiagnostics: compactMonitorJsonValue(
            redactTraceValue(record.llmDiagnostics),
          ) as MatOSUserFeedbackAnalysisDiagnostics[],
        }
      : {}),
    ...(record.priorRecordIds
      ? { priorRecordIds: truncateMonitorArray(record.priorRecordIds) }
      : {}),
    ...(record.directEditorRun
      ? {
          directEditorRun: compactMonitorJsonValue(
            record.directEditorRun,
          ) as MatOSSelfEvolutionMonitorDirectEditorRun,
        }
      : {}),
  }
}

function serializeMonitorRecord(record: MatOSSelfEvolutionMonitorRecord): string {
  const compact = compactMonitorRecordForStorage(record)
  const serialized = JSON.stringify(compact)
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_MONITOR_RECORD_BYTES) {
    return serialized
  }
  const capped: MatOSSelfEvolutionMonitorRecord = {
    ...compact,
    feedbackAnalysis: compact.feedbackAnalysis
      ? ({
          schemaVersion: 1,
          shouldUseFeedback: Boolean(compact.feedbackAnalysis.shouldUseFeedback),
          summary:
            truncateMonitorText(compact.feedbackAnalysis.summary, 1000) ??
            'feedback analysis truncated',
          signals: [],
          decisions: [],
        } as MatOSUserFeedbackAnalysis)
      : undefined,
    directEditorRun: compact.directEditorRun
      ? {
          runId: compact.directEditorRun.runId,
          status: compact.directEditorRun.status,
          createdAt: compact.directEditorRun.createdAt,
          updatedAt: compact.directEditorRun.updatedAt,
          scope: compact.directEditorRun.scope,
          editorOutput: compact.directEditorRun.editorOutput,
          modifiedFiles: compact.directEditorRun.modifiedFiles,
          createdAssets: compact.directEditorRun.createdAssets,
          updatedAssets: compact.directEditorRun.updatedAssets,
          disabledAssets: compact.directEditorRun.disabledAssets,
          evidenceRefs: compact.directEditorRun.evidenceRefs,
          roleExitCode: compact.directEditorRun.roleExitCode,
          ...(compact.directEditorRun.diffPatchPath
            ? { diffPatchPath: compact.directEditorRun.diffPatchPath }
            : {}),
          ...(compact.directEditorRun.beforeSnapshot
            ? { beforeSnapshot: compact.directEditorRun.beforeSnapshot }
            : {}),
          ...(compact.directEditorRun.afterSnapshot
            ? { afterSnapshot: compact.directEditorRun.afterSnapshot }
            : {}),
          ...(compact.directEditorRun.rollbackSnapshot
            ? { rollbackSnapshot: compact.directEditorRun.rollbackSnapshot }
            : {}),
          ...(compact.directEditorRun.upstreamSessionId
            ? { upstreamSessionId: compact.directEditorRun.upstreamSessionId }
            : {}),
          truncated: true,
        }
      : undefined,
    error: truncateMonitorText(compact.error, 1000),
    ...(compact.llmDiagnostics
      ? {
          llmDiagnostics: compact.llmDiagnostics.map(diagnostic => ({
            stage: diagnostic.stage,
            roleReference: diagnostic.roleReference,
            exitCode: diagnostic.exitCode,
            parsedResultPresent: diagnostic.parsedResultPresent,
            normalizedAnalysisPresent: diagnostic.normalizedAnalysisPresent,
            ...(diagnostic.fallbackUsed ? { fallbackUsed: true } : {}),
            ...(diagnostic.upstreamSessionId
              ? { upstreamSessionId: diagnostic.upstreamSessionId }
              : {}),
            ...(diagnostic.cache ? { cache: diagnostic.cache } : {}),
            ...(diagnostic.resultTextPreview
              ? {
                  resultTextPreview: truncateMonitorText(
                    diagnostic.resultTextPreview,
                    1000,
                  ),
                }
              : {}),
            ...(diagnostic.stderrPreview
              ? {
                  stderrPreview: truncateMonitorText(
                    diagnostic.stderrPreview,
                    1000,
                  ),
                }
              : {}),
          })),
        }
      : {}),
    storageTruncated: true,
  }
  const cappedSerialized = JSON.stringify(capped)
  if (Buffer.byteLength(cappedSerialized, 'utf8') <= MAX_MONITOR_RECORD_BYTES) {
    return cappedSerialized
  }
  return JSON.stringify({
    ...capped,
    feedbackAnalysis: undefined,
    directEditorRun: undefined,
    storageTruncated: true,
  })
}

export async function readMonitorRecordsForSession(
  cwd: string,
  sessionId: string,
): Promise<MatOSSelfEvolutionMonitorRecord[]> {
  const recordsById = new Map<string, MatOSSelfEvolutionMonitorRecord>()
  for (const root of resolveMatOSSelfEvolutionMonitorRoots(cwd)) {
    try {
      const raw = await readFile(monitorRecordsPath(root, sessionId), 'utf8')
      for (const record of parseMonitorRecordsJsonl(raw)) {
        if (!recordsById.has(record.recordId)) {
          recordsById.set(record.recordId, record)
        }
      }
    } catch {
      // Missing roots are normal when upgrading from cwd-local monitor storage.
    }
  }
  return [...recordsById.values()]
}

export async function listMatOSSelfEvolutionMonitorRecordLedger(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<MatOSSelfEvolutionMonitorRecord[]> {
  const recordsById = new Map<string, MatOSSelfEvolutionMonitorRecord>()
  for (const root of resolveMatOSSelfEvolutionMonitorRoots(cwd, env)) {
    let sessionIds: string[]
    try {
      sessionIds = await readdir(root)
    } catch {
      continue
    }
    const records = (
      await Promise.all(
        sessionIds.map(async sessionId => {
          try {
            const raw = await readFile(monitorRecordsPath(root, sessionId), 'utf8')
            return parseMonitorRecordsJsonl(raw)
          } catch {
            return []
          }
        }),
      )
    ).flat()
    for (const record of records) {
      if (!recordsById.has(record.recordId)) {
        recordsById.set(record.recordId, record)
      }
    }
  }
  return [...recordsById.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )
}

export async function readMatOSSelfEvolutionMonitorRecordFromLedger(
  cwd: string,
  recordId: string,
): Promise<MatOSSelfEvolutionMonitorRecord | undefined> {
  return (await listMatOSSelfEvolutionMonitorRecordLedger(cwd)).find(
    record =>
      record.recordId === recordId ||
      record.triggerKey === recordId ||
      basename(record.recordId) === recordId,
  )
}

const MONITOR_APPEND_LOCK_TIMEOUT_MS = 5_000
const MONITOR_APPEND_LOCK_STALE_MS = 15_000
const DEFAULT_MONITOR_RECORDS_MAX_BYTES = 2_000_000
const DEFAULT_MONITOR_RECORDS_KEEP = 200
const DEFAULT_MONITOR_ARCHIVE_MAX_BYTES = 8_000_000

function monitorRecordsMaxBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.MATOS_EVOLUTION_MONITOR_RECORDS_MAX_BYTES)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MONITOR_RECORDS_MAX_BYTES
}

function monitorArchiveMaxBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.MATOS_EVOLUTION_MONITOR_ARCHIVE_MAX_BYTES)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MONITOR_ARCHIVE_MAX_BYTES
}

function monitorRecordsKeepCount(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.MATOS_EVOLUTION_MONITOR_RECORDS_KEEP)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MONITOR_RECORDS_KEEP
}

// Serialize concurrent appends/compaction per records file. Multiple detached
// evolution workers can finish at the same moment, and O_APPEND writes are not
// atomic across processes on FUSE/NFS filesystems, which can leave
// two interleaved half-records on a single line. On lock timeout we fall back
// to a direct append - a rare interleave is better than dropping the record.
async function withMonitorRecordsLock(
  sessionDir: string,
  run: () => Promise<void>,
): Promise<void> {
  const lockDir = join(sessionDir, 'records.jsonl.lock')
  const start = Date.now()
  let locked = false
  while (Date.now() - start < MONITOR_APPEND_LOCK_TIMEOUT_MS) {
    try {
      await mkdir(lockDir)
      locked = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        break
      }
      const info = await stat(lockDir).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > MONITOR_APPEND_LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      await sleep(50)
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

// Trigger kinds whose keys are stable identities that can legitimately fire
// again much later (`session-end:<sessionId>`, `workflow-failure:<evidenceId>`,
// `workflow-session-end:<evidenceId>`). Their latest record must survive
// compaction so concluded-status suppression keeps working. Every other kind
// keys on event ids or time buckets that cannot recur outside the recent
// window covered by the newest-N retention.
const STABLE_TRIGGER_KIND_RETENTION = new Set<MatOSSelfEvolutionTriggerKind>([
  'session-end',
  'workflow-failure',
])

function serializedMonitorRecordLineBytes(
  record: MatOSSelfEvolutionMonitorRecord,
): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
}

export function selectMonitorRecordsToKeep(
  records: MatOSSelfEvolutionMonitorRecord[],
  keepCount: number,
  maxBytes?: number,
): {
  kept: MatOSSelfEvolutionMonitorRecord[]
  archived: MatOSSelfEvolutionMonitorRecord[]
} {
  const ordered = [...records].sort((a, b) =>
    (a.createdAt || '').localeCompare(b.createdAt || ''),
  )
  const keepIds = new Set<string>()
  const latestByStableTriggerKey = new Map<string, string>()
  for (const record of ordered) {
    if (STABLE_TRIGGER_KIND_RETENTION.has(record.triggerKind)) {
      latestByStableTriggerKey.set(record.triggerKey, record.recordId)
    }
  }
  const stableIds = new Set(latestByStableTriggerKey.values())
  for (const recordId of stableIds) {
    keepIds.add(recordId)
  }
  for (const record of ordered.slice(-keepCount)) {
    keepIds.add(record.recordId)
  }
  if (maxBytes !== undefined) {
    // Individual records can reach MAX_MONITOR_RECORD_BYTES, so a pure record
    // count does not bound the hot file. Walk newest-to-oldest and stop keeping
    // once the byte budget is spent; stable-retention records and the newest
    // record always survive so suppression semantics are preserved.
    let usedBytes = 0
    for (const record of ordered) {
      if (stableIds.has(record.recordId)) {
        usedBytes += serializedMonitorRecordLineBytes(record)
      }
    }
    let overBudget = false
    let keptNewest = false
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const record = ordered[index]!
      if (!keepIds.has(record.recordId) || stableIds.has(record.recordId)) {
        continue
      }
      const lineBytes = serializedMonitorRecordLineBytes(record)
      if (overBudget || (keptNewest && usedBytes + lineBytes > maxBytes)) {
        overBudget = true
        keepIds.delete(record.recordId)
        continue
      }
      usedBytes += lineBytes
      keptNewest = true
    }
  }
  return {
    kept: ordered.filter(record => keepIds.has(record.recordId)),
    archived: ordered.filter(record => !keepIds.has(record.recordId)),
  }
}

// Nothing else ever prunes the archive, so it must bound itself: rotate the
// file aside once at the cap (at most one rotated generation is kept) instead
// of growing without limit.
async function appendArchivedMonitorRecords(
  sessionDir: string,
  archived: MatOSSelfEvolutionMonitorRecord[],
): Promise<void> {
  const archivePath = join(sessionDir, 'records-archive.jsonl')
  const payload = `${archived.map(record => JSON.stringify(record)).join('\n')}\n`
  const info = await stat(archivePath).catch(() => undefined)
  if (
    info &&
    info.size + Buffer.byteLength(payload, 'utf8') > monitorArchiveMaxBytes()
  ) {
    await rename(
      archivePath,
      join(sessionDir, 'records-archive.1.jsonl'),
    ).catch(() => undefined)
  }
  await appendFile(archivePath, payload, 'utf8')
}

const MONITOR_COMPACT_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

// A compactor that dies between its tmp write and the rename leaves
// `records.jsonl.compact-*` files that nothing else cleans; because the crash
// also left the source file oversized, the next append re-enters compaction,
// which is exactly where this sweep runs. One-day age floor so a concurrent
// live compactor's fresh tmp is never touched.
async function removeStaleCompactTmpFiles(sessionDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(sessionDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.includes('.compact-')) {
      continue
    }
    const path = join(sessionDir, name)
    const info = await stat(path).catch(() => undefined)
    if (
      !info?.isFile() ||
      Date.now() - info.mtimeMs < MONITOR_COMPACT_TMP_MAX_AGE_MS
    ) {
      continue
    }
    await rm(path, { force: true }).catch(() => undefined)
  }
}

export async function compactMonitorRecordsFileIfOversized(
  sessionDir: string,
  path: string,
  hooks: { beforeRename?: () => Promise<void> } = {},
): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (!info || info.size <= monitorRecordsMaxBytes()) {
    return
  }
  await removeStaleCompactTmpFiles(sessionDir)
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) {
    return
  }
  const readBytes = Buffer.byteLength(raw, 'utf8')
  const records = parseMonitorRecordsJsonl(raw)
  const { kept, archived } = selectMonitorRecordsToKeep(
    records,
    monitorRecordsKeepCount(),
    monitorRecordsMaxBytes(),
  )
  if (archived.length === 0) {
    return
  }
  await appendArchivedMonitorRecords(sessionDir, archived)
  const tmpPath = `${path}.compact-${process.pid}-${Date.now()}`
  await writeFile(
    tmpPath,
    kept.length > 0
      ? `${kept.map(record => JSON.stringify(record)).join('\n')}\n`
      : '',
    'utf8',
  )
  await hooks.beforeRename?.()
  // Lock timeouts fall back to lockless appends (see withMonitorRecordsLock),
  // so the source file may have grown after our read. Re-stat and splice the
  // appended tail into the compacted file before the rename; otherwise the
  // rename would silently drop those records. A single retry is enough — a
  // second concurrent append in this window is the rare accepted race.
  const current = await stat(path).catch(() => undefined)
  if (!current || current.size < readBytes) {
    // The file disappeared or shrank (another compactor won); abort ours.
    await rm(tmpPath, { force: true }).catch(() => undefined)
    return
  }
  if (current.size > readBytes) {
    const latest = await readFile(path).catch(() => undefined)
    if (!latest) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
      return
    }
    const tail = latest.subarray(readBytes)
    if (tail.length > 0) {
      await appendFile(tmpPath, tail)
    }
  }
  await rename(tmpPath, path)
}

export async function appendMonitorRecord(
  cwd: string,
  record: MatOSSelfEvolutionMonitorRecord,
): Promise<void> {
  const root = primaryMonitorRoot(cwd)
  const sessionDir = monitorSessionDir(root, record.sessionId)
  const path = monitorRecordsPath(root, record.sessionId)
  await mkdir(sessionDir, { recursive: true })
  await withMonitorRecordsLock(sessionDir, async () => {
    await appendFile(path, `${serializeMonitorRecord(record)}\n`, 'utf8')
    // Long-lived sessions previously grew records.jsonl to multiple MB, which
    // made every trigger re-read and re-serialize the whole history. Compact
    // best-effort; a failed compaction must not lose the appended record.
    await compactMonitorRecordsFileIfOversized(sessionDir, path).catch(
      () => undefined,
    )
  })
}
