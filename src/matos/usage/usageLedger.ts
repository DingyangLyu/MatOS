import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { mkdir, readdir, readFile, stat, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
// Small session-format constants are inlined so this module stays
// dependency-free.
const SYNTHETIC_MODEL = '<synthetic>'

function getTodayDateString(): string {
  const dateStr = new Date().toISOString().split('T')[0]
  if (!dateStr) {
    throw new Error('Invalid ISO date string')
  }
  return dateStr
}
import { readMatOSProjectConfig } from '../project.js'
import { resolveMatOSRuntimeScope } from '../runtime/scopes.js'
import {
  type MatOSSqliteDatabase,
  openMatOSSqliteDatabase,
} from '../storage/sqlite.js'
import {
  listEvolutionUsageFiles,
  parseEvolutionUsageFile,
} from './evolutionUsage.js'
import {
  parseUserActivity,
  summarizeUserActivity,
  type ActivityPoint,
} from './userActivity.js'

export type UsageBucket = 'day' | 'week' | 'month' | 'year'
export type UsageSourceFilter =
  | 'transcript'
  | 'session'
  | 'evolution'
  | 'combined'
  | 'all'
export type UsageSourceType =
  | 'cmatos-transcript'
  | 'matos-session'
  | 'matos-evolution'

export type UsageTokenMetrics = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalTokens: number
  totalCostUsd: number
  eventCount: number
}

export type UsageTokenBucket = UsageTokenMetrics & {
  start: string
  end: string
  models: Record<string, UsageTokenMetrics>
  sources: Record<string, UsageTokenMetrics>
}

export type UsageTokenQueryResult = {
  scopeRef: string
  userId?: string
  from: string
  to: string
  bucket: UsageBucket
  source: UsageSourceFilter
  sources: UsageSourceType[]
  generatedAt: string
  timeZone: 'UTC'
  coverage: {
    status: 'recorded-only'
    unavailableRecords: number
    costStatus: 'unverified-estimate'
  }
  cache: {
    dbPath: string
    scannedFiles: number
    reusedFiles: number
    removedFiles: number
  }
  totals: UsageTokenMetrics
  buckets: UsageTokenBucket[]
}

type UsageEventRow = {
  responseKey?: string
  stage?: string
  journal?: boolean
  unavailable?: boolean
  sourceType: UsageSourceType
  sourcePath: string
  eventIndex: number
  timestamp: string
  day: string
  scopeRef: string
  userId?: string
  sessionId?: string
  traceId?: string
  workflowRunId?: string
  roleRef?: string
  model: string
  metrics: Omit<UsageTokenMetrics, 'eventCount'>
}

type SourceFile = {
  sourceType: UsageSourceType
  path: string
}

type SourceCacheRow = {
  source_path: string
  source_type: string
  mtime_ms: number
  size_bytes: number
}

type DailyRollupRow = {
  day: string
  model: string
  source_type: UsageSourceType
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_tokens: number
  total_cost_usd: number | null
  event_count: number
}

function emptyMetrics(): UsageTokenMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    eventCount: 0,
  }
}

function addMetrics(
  target: UsageTokenMetrics,
  source: UsageTokenMetrics,
): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadInputTokens += source.cacheReadInputTokens
  target.cacheCreationInputTokens += source.cacheCreationInputTokens
  target.totalTokens += source.totalTokens
  target.totalCostUsd += source.totalCostUsd
  target.eventCount += source.eventCount
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function intValue(value: unknown): number {
  const number = numberValue(value)
  return number && number > 0 ? Math.floor(number) : 0
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = numberValue(value)
    if (number !== undefined) {
      return number
    }
  }
  return undefined
}

function normalizeUsage(value: unknown): Omit<UsageTokenMetrics, 'eventCount'> {
  const raw = objectValue(value)
  const inputTokens = intValue(raw.inputTokens ?? raw.input_tokens)
  const outputTokens = intValue(raw.outputTokens ?? raw.output_tokens)
  const cacheReadInputTokens = intValue(
    raw.cacheReadInputTokens ?? raw.cache_read_input_tokens,
  )
  const cacheCreationInputTokens = intValue(
    raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens,
  )
  const computedTotal =
    inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens
  const explicitTotal = intValue(raw.totalTokens ?? raw.total_tokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens: computedTotal > 0 ? computedTotal : explicitTotal,
    totalCostUsd:
      firstNumber(raw.totalCostUsd, raw.costUSD, raw.costUsd, raw.cost_usd) ??
      0,
  }
}

function hasUsage(metrics: Omit<UsageTokenMetrics, 'eventCount'>): boolean {
  return (
    metrics.totalTokens > 0 ||
    metrics.inputTokens > 0 ||
    metrics.outputTokens > 0 ||
    metrics.cacheReadInputTokens > 0 ||
    metrics.cacheCreationInputTokens > 0
  )
}

function dayFromTimestamp(timestamp: unknown): string | undefined {
  const value = stringValue(timestamp)
  if (!value) {
    return undefined
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }
  return date.toISOString().slice(0, 10)
}

export class UsageQueryError extends Error {}

function normalizeDate(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new UsageQueryError('Invalid usage date; expected YYYY-MM-DD')
  return value
}

export function parseUsageBucket(value: string | undefined): UsageBucket {
  return value === 'week' || value === 'month' || value === 'year'
    ? value
    : 'day'
}

export function parseUsageSourceFilter(
  value: string | undefined,
): UsageSourceFilter {
  return value === 'all' ||
    value === 'session' ||
    value === 'evolution' ||
    value === 'combined'
    ? value
    : 'transcript'
}

function sourceTypesForFilter(filter: UsageSourceFilter): UsageSourceType[] {
  if (filter === 'all') {
    return ['cmatos-transcript', 'matos-session', 'matos-evolution']
  }
  if (filter === 'combined') return ['cmatos-transcript', 'matos-evolution']
  if (filter === 'evolution') return ['matos-evolution']
  if (filter === 'session') {
    return ['matos-session']
  }
  return ['cmatos-transcript']
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function bucketRange(
  day: string,
  bucket: UsageBucket,
): { start: string; end: string } {
  if (bucket === 'day') {
    return { start: day, end: day }
  }
  const date = new Date(`${day}T00:00:00.000Z`)
  if (bucket === 'month') {
    const start = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    )
    const end = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    )
    return { start: isoDate(start), end: isoDate(end) }
  }
  if (bucket === 'year') {
    return {
      start: `${date.getUTCFullYear()}-01-01`,
      end: `${date.getUTCFullYear()}-12-31`,
    }
  }
  const mondayOffset = (date.getUTCDay() + 6) % 7
  const start = new Date(date)
  start.setUTCDate(date.getUTCDate() - mondayOffset)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 6)
  return { start: isoDate(start), end: isoDate(end) }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function listJsonlFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return []
  }
  if (!(await lstat(root)).isDirectory()) return []
  const files: string[] = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(path)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path)
    }
  }
  return files.sort()
}

function parseJsonl(raw: string): unknown[] {
  const rows: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // A partially-written transcript line should not poison usage charts.
    }
  }
  return rows
}

function eventId(input: UsageEventRow): string {
  return createHash('sha256')
    .update(
      [
        input.scopeRef,
        input.sourceType,
        input.sourcePath,
        String(input.eventIndex),
        input.timestamp,
        input.sessionId ?? '',
        input.traceId ?? '',
        input.workflowRunId ?? '',
        input.roleRef ?? '',
        input.model,
        String(input.metrics.totalTokens),
      ].join('\0'),
    )
    .digest('hex')
}

function parseTranscriptUsageEvents(input: {
  scopeRef: string
  userId?: string
  sourcePath: string
  raw: string
  eventOffset?: number
}): UsageEventRow[] {
  const events: UsageEventRow[] = []
  // Streaming persists one assistant transcript record per content block
  // (parallel tool calls, thinking + text, ...), and every split repeats the
  // same message.id and the same usage object. Count each API response once
  // or multi-block turns inflate token/cost totals.
  const seenApiMessages = new Map<string, UsageEventRow>()
  let eventIndex = input.eventOffset ?? 0
  for (const row of parseJsonl(input.raw)) {
    const record = objectValue(row)
    if (record.type !== 'assistant') {
      continue
    }
    const message = objectValue(record.message)
    const model = stringValue(message.model) ?? 'unknown'
    if (model === SYNTHETIC_MODEL) {
      continue
    }
    const metrics = normalizeUsage(message.usage)
    if (!hasUsage(metrics)) {
      continue
    }
    const timestamp = stringValue(record.timestamp)
    const day = dayFromTimestamp(timestamp)
    if (!timestamp || !day) {
      continue
    }
    const apiMessageId = stringValue(message.id)
    if (apiMessageId) {
      const apiMessageKey = apiMessageId
      const previous = seenApiMessages.get(apiMessageKey)
      if (previous) {
        for (const key of [
          'inputTokens',
          'outputTokens',
          'cacheReadInputTokens',
          'cacheCreationInputTokens',
          'totalCostUsd',
        ] as const) {
          previous.metrics[key] = Math.max(previous.metrics[key], metrics[key])
        }
        previous.metrics.totalTokens =
          previous.metrics.inputTokens +
          previous.metrics.outputTokens +
          previous.metrics.cacheReadInputTokens +
          previous.metrics.cacheCreationInputTokens
        if (timestamp < previous.timestamp) {
          previous.timestamp = timestamp
          previous.day = day
        }
        continue
      }
    }
    const event: UsageEventRow = {
      ...(apiMessageId ? { responseKey: `api:${apiMessageId}` } : {}),
      sourceType: 'cmatos-transcript',
      sourcePath: input.sourcePath,
      eventIndex,
      timestamp,
      day,
      scopeRef: input.scopeRef,
      ...(input.userId ? { userId: input.userId } : {}),
      sessionId: stringValue(record.sessionId ?? record.session_id),
      traceId: stringValue(record.traceId ?? record.trace_id),
      model,
      metrics,
    }
    events.push(event)
    if (apiMessageId) seenApiMessages.set(apiMessageId, event)
    eventIndex += 1
  }
  return events
}

function parseSessionUsageEvents(input: {
  scopeRef: string
  userId?: string
  sourcePath: string
  raw: string
}): UsageEventRow[] {
  const events: UsageEventRow[] = []
  let eventIndex = 0
  for (const row of parseJsonl(input.raw)) {
    const record = objectValue(row)
    if (
      record.type !== 'matos.session.completed' &&
      record.type !== 'matos.session.failed'
    ) {
      continue
    }
    const timestamp = stringValue(record.timestamp)
    const day = dayFromTimestamp(timestamp)
    if (!timestamp || !day) {
      continue
    }
    const data = objectValue(record.data)
    const modelUsage = objectValue(data.modelUsage)
    const modelEntries = Object.entries(modelUsage)
    if (modelEntries.length > 0) {
      for (const [model, usage] of modelEntries) {
        const metrics = normalizeUsage(usage)
        if (!hasUsage(metrics)) {
          continue
        }
        events.push({
          sourceType: 'matos-session',
          sourcePath: input.sourcePath,
          eventIndex,
          timestamp,
          day,
          scopeRef: input.scopeRef,
          userId: stringValue(record.userId) ?? input.userId,
          sessionId: stringValue(record.sessionId),
          traceId: stringValue(record.traceId),
          roleRef: stringValue(record.roleRef),
          model,
          metrics,
        })
        eventIndex += 1
      }
      continue
    }
    const metrics = normalizeUsage(data.usage)
    if (!hasUsage(metrics)) {
      continue
    }
    events.push({
      sourceType: 'matos-session',
      sourcePath: input.sourcePath,
      eventIndex,
      timestamp,
      day,
      scopeRef: input.scopeRef,
      userId: stringValue(record.userId) ?? input.userId,
      sessionId: stringValue(record.sessionId),
      traceId: stringValue(record.traceId),
      roleRef: stringValue(record.roleRef),
      model: stringValue(data.model) ?? 'unknown',
      metrics,
    })
    eventIndex += 1
  }
  return events
}

async function parseSourceFile(input: {
  source: SourceFile
  scopeRef: string
  userId?: string
  raw: string
}): Promise<UsageEventRow[]> {
  const raw = input.raw
  if (input.source.sourceType === 'matos-evolution') {
    return parseEvolutionUsageFile(input.source.path, raw).flatMap((row, i) => {
      const day = dayFromTimestamp(row.timestamp)
      if (!day) return []
      return [
        {
          sourceType: 'matos-evolution' as const,
          sourcePath: input.source.path,
          scopeRef: input.scopeRef,
          userId: input.userId,
          eventIndex: i,
          timestamp: new Date(row.timestamp).toISOString(),
          day,
          model: row.model,
          sessionId: row.sessionId,
          responseKey: `${row.journal ? 'journal' : 'legacy'}:${row.sessionId ?? row.id}:${row.stage}:${row.journal ? row.id : row.model}`,
          stage: row.stage,
          journal: row.journal,
          unavailable: row.unavailable,
          metrics: normalizeUsage(row.usage),
        },
      ]
    })
  }
  if (input.source.sourceType === 'matos-session') {
    return parseSessionUsageEvents({
      scopeRef: input.scopeRef,
      userId: input.userId,
      sourcePath: input.source.path,
      raw,
    })
  }
  return parseTranscriptUsageEvents({
    scopeRef: input.scopeRef,
    userId: input.userId,
    sourcePath: input.source.path,
    raw,
  })
}

function initializeUsageSchema(db: MatOSSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_sources (
      source_path TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      scanned_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_sources_scope
      ON usage_sources(scope_ref, source_type);

    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      user_id TEXT,
      day TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      session_id TEXT,
      trace_id TEXT,
      workflow_run_id TEXT,
      role_ref TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      total_cost_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_scope_day
      ON usage_events(scope_ref, day);
    CREATE INDEX IF NOT EXISTS idx_usage_events_source
      ON usage_events(source_path);

    CREATE TABLE IF NOT EXISTS usage_rollup_daily (
      scope_ref TEXT NOT NULL,
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      source_type TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      total_cost_usd REAL NOT NULL,
      event_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope_ref, day, model, source_type)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_rollup_daily_scope_day
      ON usage_rollup_daily(scope_ref, day);
  `)
  // Derived cache only: parser upgrades must invalidate old first-block and
  // per-file totals even if no transcript mtime changed. Never modify sources.
  db.exec(
    'CREATE TABLE IF NOT EXISTS usage_cache_meta (version INTEGER NOT NULL)',
  )
  db.transaction(() => {
    const columns = db.query('PRAGMA table_info(usage_events)').all() as {
      name: string
    }[]
    if (!columns.some((column) => column.name === 'response_key')) {
      db.exec('ALTER TABLE usage_events ADD COLUMN response_key TEXT')
    }
    for (const [name, definition] of [
      ['stage', "TEXT NOT NULL DEFAULT ''"],
      ['journal', 'INTEGER NOT NULL DEFAULT 0'],
      ['unavailable', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${definition}`)
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(scope_ref, source_type, session_id, stage, journal)',
    )
    const version = db
      .query('SELECT version FROM usage_cache_meta LIMIT 1')
      .get() as { version?: number } | undefined
    const sourceColumns = db
      .query('PRAGMA table_info(usage_sources)')
      .all() as { name: string }[]
    if (!sourceColumns.some((c) => c.name === 'activity_json'))
      db.exec(
        "ALTER TABLE usage_sources ADD COLUMN activity_json TEXT NOT NULL DEFAULT '[]'",
      )
    if (!sourceColumns.some((c) => c.name === 'malformed_rows'))
      db.exec(
        'ALTER TABLE usage_sources ADD COLUMN malformed_rows INTEGER NOT NULL DEFAULT 0',
      )
    if (version?.version !== 5) {
      db.exec(
        'DELETE FROM usage_sources; DELETE FROM usage_events; DELETE FROM usage_rollup_daily; DELETE FROM usage_cache_meta; INSERT INTO usage_cache_meta VALUES (5)',
      )
    }
  })
}

async function openUsageDb(path: string): Promise<MatOSSqliteDatabase> {
  await mkdir(dirname(path), { recursive: true })
  const db = await openMatOSSqliteDatabase(path)
  initializeUsageSchema(db)
  return db
}

function writeEvents(db: MatOSSqliteDatabase, events: UsageEventRow[]): void {
  const insert = db.query(`
    INSERT OR REPLACE INTO usage_events (
      event_id,
      scope_ref,
      user_id,
      day,
      timestamp,
      source_type,
      source_path,
      event_index,
      session_id,
      trace_id,
      workflow_run_id,
      role_ref,
      model,
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
      total_tokens,
      total_cost_usd
      , response_key, stage, journal, unavailable
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const event of events) {
    insert.run(
      eventId(event),
      event.scopeRef,
      event.userId ?? null,
      event.day,
      event.timestamp,
      event.sourceType,
      event.sourcePath,
      event.eventIndex,
      event.sessionId ?? null,
      event.traceId ?? null,
      event.workflowRunId ?? null,
      event.roleRef ?? null,
      event.model,
      event.metrics.inputTokens,
      event.metrics.outputTokens,
      event.metrics.cacheCreationInputTokens,
      event.metrics.cacheReadInputTokens,
      event.metrics.totalTokens,
      event.metrics.totalCostUsd,
      event.responseKey ?? eventId(event),
      event.stage ?? '',
      event.journal ? 1 : 0,
      event.unavailable ? 1 : 0,
    )
  }
}

function rebuildDailyRollups(
  db: MatOSSqliteDatabase,
  scopeRef: string,
  selected: UsageSourceType[],
): void {
  const now = new Date().toISOString()
  db.query('DELETE FROM usage_rollup_daily WHERE scope_ref = ?').run(scopeRef)
  db.query(
    `
    INSERT INTO usage_rollup_daily (
      scope_ref,
      day,
      model,
      source_type,
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
      total_tokens,
      total_cost_usd,
      event_count,
      updated_at
    )
    SELECT
      scope_ref,
      day,
      model,
      source_type,
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(cache_creation_input_tokens),
      SUM(cache_read_input_tokens),
      SUM(total_tokens),
      SUM(COALESCE(total_cost_usd, 0)),
      COUNT(*),
      ?
    FROM (
      SELECT scope_ref, MIN(day) AS day, model, source_type,
        MAX(input_tokens) AS input_tokens, MAX(output_tokens) AS output_tokens,
        MAX(cache_creation_input_tokens) AS cache_creation_input_tokens,
        MAX(cache_read_input_tokens) AS cache_read_input_tokens,
        MAX(MAX(total_tokens), MAX(input_tokens) + MAX(output_tokens) + MAX(cache_creation_input_tokens) + MAX(cache_read_input_tokens)) AS total_tokens,
        MAX(total_cost_usd) AS total_cost_usd
      FROM usage_events AS current WHERE scope_ref = ?
        AND NOT (source_type = 'matos-evolution' AND journal = 0 AND session_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM usage_events AS durable WHERE durable.scope_ref = current.scope_ref
            AND durable.source_type = 'matos-evolution' AND durable.journal = 1
            AND durable.session_id = current.session_id AND durable.stage = current.stage
        ))
        AND NOT (${selected.includes('cmatos-transcript') ? 1 : 0} AND source_type = 'matos-session' AND session_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM usage_events AS native WHERE native.scope_ref = current.scope_ref
            AND native.source_type = 'cmatos-transcript' AND native.session_id = current.session_id
            AND native.model = current.model
        ))
        AND NOT (${selected.includes('matos-evolution') ? 1 : 0} AND source_type = 'cmatos-transcript' AND session_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM usage_events AS hidden WHERE hidden.scope_ref = current.scope_ref
            AND hidden.source_type = 'matos-evolution' AND hidden.session_id = current.session_id AND hidden.unavailable = 0
        ))
      GROUP BY scope_ref, source_type, response_key, model
    )
    GROUP BY scope_ref, day, model, source_type
  `,
  ).run(now, scopeRef)
}

async function refreshUsageCache(input: {
  db: MatOSSqliteDatabase
  scopeRef: string
  userId?: string
  sources: SourceFile[]
  selectedSourceTypes: UsageSourceType[]
}): Promise<UsageTokenQueryResult['cache']> {
  let scannedFiles = 0
  let reusedFiles = 0
  let removedFiles = 0
  const currentPaths = new Set(input.sources.map((source) => source.path))

  for (const sourceType of input.selectedSourceTypes) {
    const known = input.db
      .query(
        `
      SELECT source_path, source_type, mtime_ms, size_bytes
      FROM usage_sources
      WHERE scope_ref = ? AND source_type = ?
    `,
      )
      .all(input.scopeRef, sourceType) as SourceCacheRow[]
    for (const row of known) {
      if (!currentPaths.has(row.source_path)) {
        input.db.transaction(() => {
          input.db
            .query('DELETE FROM usage_events WHERE source_path = ?')
            .run(row.source_path)
          input.db
            .query('DELETE FROM usage_sources WHERE source_path = ?')
            .run(row.source_path)
        })
        removedFiles += 1
      }
    }
  }

  for (const source of input.sources) {
    let stats
    try {
      stats = await stat(source.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const mtimeMs = Math.floor(stats.mtimeMs)
    const cached = input.db
      .query(
        `
      SELECT source_path, source_type, mtime_ms, size_bytes
      FROM usage_sources
      WHERE source_path = ?
    `,
      )
      .get(source.path) as SourceCacheRow | undefined
    if (
      cached &&
      cached.source_type === source.sourceType &&
      cached.mtime_ms === mtimeMs &&
      cached.size_bytes === stats.size
    ) {
      reusedFiles += 1
      continue
    }

    const parsed = await readUsageSource(source, input.scopeRef, input.userId)
    const { events, activity, malformed } = parsed
    input.db.transaction(() => {
      input.db
        .query('DELETE FROM usage_events WHERE source_path = ?')
        .run(source.path)
      writeEvents(input.db, events)
      input.db
        .query(
          `
        INSERT OR REPLACE INTO usage_sources
          (source_path, source_type, scope_ref, mtime_ms, size_bytes, scanned_at, activity_json, malformed_rows)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          source.path,
          source.sourceType,
          input.scopeRef,
          mtimeMs,
          stats.size,
          new Date().toISOString(),
          JSON.stringify(activity),
          malformed,
        )
    })
    scannedFiles += 1
  }

  return {
    dbPath: '',
    scannedFiles,
    reusedFiles,
    removedFiles,
  }
}

async function readUsageSource(
  source: SourceFile,
  scopeRef: string,
  userId?: string,
) {
  const events: UsageEventRow[] = [],
    activity: ActivityPoint[] = []
  let malformed = 0
  if (source.sourceType !== 'cmatos-transcript') {
    const raw = await readFile(source.path, 'utf8')
    try {
      events.push(...(await parseSourceFile({ source, scopeRef, userId, raw })))
    } catch (error) {
      if (error instanceof SyntaxError) malformed++
      else throw error
    }
    return { events, activity, malformed }
  }
  // No 64 MiB cutoff. Stream each file and retain only numeric/activity metadata.
  const stream = createReadStream(source.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let index = 0
  try {
    for await (const line of lines) {
      index++
      if (!line.trim()) continue
      try {
        JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      const rows = parseTranscriptUsageEvents({
        sourcePath: source.path,
        scopeRef,
        userId,
        raw: line,
        eventOffset: index,
      })
      events.push(...rows)
      activity.push(...parseUserActivity(line, source.path, index))
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return { events, activity, malformed }
}

async function resolveUsageContext(input: {
  cwd: string
  scopeRef?: string
  cacheDbPath?: string
}): Promise<{
  scopeRef: string
  userId?: string
  runtimeDataDir: string
  cacheDbPath: string
  transcriptDir: string
  sessionsDir: string
  workspaceDir: string
}> {
  const config = await readMatOSProjectConfig(input.cwd)
  const ambientScope =
    process.env.MATOS_SCOPE_REF?.trim() || process.env.MATOS_SCOPE_ID?.trim()
  // Operator cross-scope reads must not inherit another user's mounted HOME,
  // sessions or workspace overrides from the gateway environment.
  const useAmbientPaths = !input.scopeRef || input.scopeRef === ambientScope
  const scope = resolveMatOSRuntimeScope(input.cwd, {
    scopeRef: input.scopeRef ?? ambientScope,
    runtimeDataDir: config.execution?.runtimeDataDir,
    env: useAmbientPaths ? process.env : {},
  })
  const runtimeDataDir = dirname(dirname(dirname(scope.rootDir)))
  return {
    scopeRef: scope.ref,
    userId: scope.id,
    runtimeDataDir,
    cacheDbPath:
      input.cacheDbPath ??
      (useAmbientPaths && process.env.MATOS_SESSION_DIR
        ? join(scope.sessionsDir, 'usage', 'usage.sqlite')
        : join(runtimeDataDir, 'usage', 'usage.sqlite')),
    transcriptDir: join(scope.homeDir, 'projects'),
    sessionsDir: scope.sessionsDir,
    workspaceDir: scope.sharedWorkspaceDir,
  }
}

async function collectSourceFiles(input: {
  transcriptDir: string
  sessionsDir: string
  workspaceDir: string
  selectedSourceTypes: UsageSourceType[]
}): Promise<SourceFile[]> {
  const sources: SourceFile[] = []
  if (input.selectedSourceTypes.includes('matos-evolution')) {
    sources.push(
      ...(
        await listEvolutionUsageFiles(input.workspaceDir, input.sessionsDir)
      ).map((path) => ({ sourceType: 'matos-evolution' as const, path })),
    )
  }
  if (input.selectedSourceTypes.includes('cmatos-transcript')) {
    sources.push(
      ...(await listJsonlFiles(input.transcriptDir)).map((path) => ({
        sourceType: 'cmatos-transcript' as const,
        path,
      })),
    )
  }
  if (input.selectedSourceTypes.includes('matos-session')) {
    sources.push(
      ...(await listJsonlFiles(input.sessionsDir)).map((path) => ({
        sourceType: 'matos-session' as const,
        path,
      })),
    )
  }
  return sources
}

function rowToMetrics(row: DailyRollupRow): UsageTokenMetrics {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd ?? 0,
    eventCount: row.event_count,
  }
}

function aggregateBuckets(input: {
  rows: DailyRollupRow[]
  bucket: UsageBucket
  selectedSourceTypes: UsageSourceType[]
}): { totals: UsageTokenMetrics; buckets: UsageTokenBucket[] } {
  const selected = new Set(input.selectedSourceTypes)
  const bucketMap = new Map<string, UsageTokenBucket>()
  const totals = emptyMetrics()

  for (const row of input.rows) {
    if (!selected.has(row.source_type)) {
      continue
    }
    const metrics = rowToMetrics(row)
    addMetrics(totals, metrics)
    const range = bucketRange(row.day, input.bucket)
    const key = `${range.start}/${range.end}`
    const bucket = bucketMap.get(key) ?? {
      ...emptyMetrics(),
      start: range.start,
      end: range.end,
      models: {},
      sources: {},
    }
    addMetrics(bucket, metrics)

    const modelMetrics = bucket.models[row.model] ?? emptyMetrics()
    addMetrics(modelMetrics, metrics)
    bucket.models[row.model] = modelMetrics

    const sourceMetrics = bucket.sources[row.source_type] ?? emptyMetrics()
    addMetrics(sourceMetrics, metrics)
    bucket.sources[row.source_type] = sourceMetrics

    bucketMap.set(key, bucket)
  }

  return {
    totals,
    buckets: [...bucketMap.values()].sort((a, b) =>
      a.start.localeCompare(b.start),
    ),
  }
}

export async function collectMatOSUsageTokens(input: {
  cwd: string
  scopeRef?: string
  from?: string
  to?: string
  bucket?: UsageBucket | string
  source?: UsageSourceFilter | string
  cacheDbPath?: string
}): Promise<UsageTokenQueryResult> {
  const bucket = parseUsageBucket(input.bucket)
  const source = parseUsageSourceFilter(input.source)
  const selectedSourceTypes = sourceTypesForFilter(source)
  const from = normalizeDate(input.from, '1970-01-01')
  const to = normalizeDate(input.to, getTodayDateString())
  if (from > to)
    throw new UsageQueryError('Usage from date must not be after to date')
  const context = await resolveUsageContext({
    cwd: input.cwd,
    scopeRef: input.scopeRef,
    cacheDbPath: input.cacheDbPath,
  })
  const db = await openUsageDb(context.cacheDbPath)
  try {
    const sources = await collectSourceFiles({
      transcriptDir: context.transcriptDir,
      sessionsDir: context.sessionsDir,
      workspaceDir: context.workspaceDir,
      selectedSourceTypes,
    })
    const cache = await refreshUsageCache({
      db,
      scopeRef: context.scopeRef,
      userId: context.userId,
      sources,
      selectedSourceTypes,
    })
    const rows = db.transaction(() => {
      // Source-overlap policy is query-local. Querying `all` must not change
      // a subsequent explicit `session` report via leftover rollup state.
      rebuildDailyRollups(db, context.scopeRef, selectedSourceTypes)
      return db
        .query(
          `
      SELECT
        day,
        model,
        source_type,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_tokens,
        total_cost_usd,
        event_count
      FROM usage_rollup_daily
      WHERE scope_ref = ? AND day >= ? AND day <= ?
      ORDER BY day ASC, model ASC, source_type ASC
    `,
        )
        .all(context.scopeRef, from, to) as DailyRollupRow[]
    })
    const aggregated = aggregateBuckets({
      rows,
      bucket,
      selectedSourceTypes,
    })
    return {
      scopeRef: context.scopeRef,
      userId: context.userId,
      from,
      to,
      bucket,
      source,
      sources: selectedSourceTypes,
      generatedAt: new Date().toISOString(),
      timeZone: 'UTC',
      coverage: {
        status: 'recorded-only',
        costStatus: 'unverified-estimate',
        unavailableRecords:
          Number(
            (
              db
                .query(
                  `SELECT COALESCE(SUM(malformed_rows), 0) AS n FROM usage_sources WHERE scope_ref = ? AND source_type IN (${selectedSourceTypes.map(() => '?').join(',')})`,
                )
                .get(context.scopeRef, ...selectedSourceTypes) as { n: number }
            ).n,
          ) +
          (selectedSourceTypes.includes('matos-evolution')
            ? Number(
                (
                  db
                    .query(
                      `SELECT COUNT(DISTINCT response_key) AS n FROM usage_events AS current WHERE scope_ref = ? AND day >= ? AND day <= ? AND unavailable = 1
          AND NOT (journal = 0 AND session_id IS NOT NULL AND EXISTS (SELECT 1 FROM usage_events AS durable
            WHERE durable.scope_ref = current.scope_ref AND durable.journal = 1 AND durable.session_id = current.session_id AND durable.stage = current.stage))`,
                    )
                    .get(context.scopeRef, from, to) as { n: number }
                ).n,
              )
            : 0),
      },
      cache: { ...cache, dbPath: context.cacheDbPath },
      totals: aggregated.totals,
      buckets: aggregated.buckets,
    }
  } finally {
    db.close()
  }
}

/** User-facing projection: no cache paths, hidden job identifiers or transcript content. */
export async function collectMatOSUsageProfile(input: {
  cwd: string
  scopeRef?: string
  from?: string
  to?: string
  cacheDbPath?: string
}) {
  const usage = await collectMatOSUsageTokens({
    ...input,
    source: 'combined',
    bucket: 'day',
  })
  const context = await resolveUsageContext(input)
  const db = await openUsageDb(context.cacheDbPath)
  try {
    const hiddenSessions = new Set(
      (
        db
          .query(
            "SELECT DISTINCT session_id FROM usage_events WHERE scope_ref = ? AND source_type = 'matos-evolution' AND session_id IS NOT NULL",
          )
          .all(context.scopeRef) as { session_id: string }[]
      ).map((r) => r.session_id),
    )
    const rows = db
      .query(
        "SELECT activity_json FROM usage_sources WHERE scope_ref = ? AND source_type = 'cmatos-transcript'",
      )
      .all(context.scopeRef) as { activity_json: string }[]
    function* points() {
      for (const row of rows)
        for (const point of JSON.parse(row.activity_json) as ActivityPoint[])
          if (!hiddenSessions.has(point.session)) yield point
    }
    const activity = summarizeUserActivity(
      points(),
      usage.from,
      usage.to,
      getTodayDateString(),
    )
    const t = usage.totals
    const foregroundTokens = usage.buckets.reduce(
      (sum, b) => sum + (b.sources['cmatos-transcript']?.totalTokens ?? 0),
      0,
    )
    return {
      schemaVersion: 1,
      generatedAt: usage.generatedAt,
      timeZone: usage.timeZone,
      from: usage.from,
      to: usage.to,
      coverage: usage.coverage,
      totalTokens: t.totalTokens,
      foregroundTokens,
      backgroundTokens: t.totalTokens - foregroundTokens,
      tokensByKind: {
        input: t.inputTokens,
        output: t.outputTokens,
        cacheRead: t.cacheReadInputTokens,
        cacheCreation: t.cacheCreationInputTokens,
      },
      peakDayTokens: usage.buckets.reduce(
        (max, b) => Math.max(max, b.totalTokens),
        0,
      ),
      daily: Object.fromEntries(
        usage.buckets.map((b) => [b.start, b.totalTokens]),
      ),
      ...activity,
    }
  } finally {
    db.close()
  }
}
