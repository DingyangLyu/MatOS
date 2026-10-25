import { createHash } from 'node:crypto'
import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises'
import { dirname,join } from 'node:path'
import type {
MatOSWorkbenchKnowledgeDocument,
MatOSWorkbenchKnowledgeImportSourcePolicy,
MatOSWorkbenchKnowledgeIngestionRecord,
} from './types.js'

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'record'
}

function recordRoot(cwd: string, datasetRef: string): string {
  return join(cwd, '.matos', 'workbench', 'knowledge-ingestions', safeSlug(datasetRef))
}

function recordDigest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return undefined
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function ingestionDocumentFromRecord(record: Record<string, unknown>): MatOSWorkbenchKnowledgeIngestionRecord['document'] {
  const document = objectRecord(record.document)
  return {
    id: firstString(document.id, record.documentId) ?? 'document',
    name: firstString(document.name) ?? firstString(document.id, record.documentId) ?? 'document',
    ...(firstString(document.path) ? { path: firstString(document.path) } : {}),
    ...(firstString(document.uri) ? { uri: firstString(document.uri) } : {}),
    ...(firstString(document.sourceType) ? { sourceType: firstString(document.sourceType) } : {}),
  }
}

export async function writeMatOSWorkbenchKnowledgeIngestionRecord(input: {
  cwd: string
  datasetRef: string
  mutation: string
  document: Record<string, unknown>
  sourcePolicy: MatOSWorkbenchKnowledgeImportSourcePolicy
  indexing?: MatOSWorkbenchKnowledgeIngestionRecord['indexing']
  status?: MatOSWorkbenchKnowledgeIngestionRecord['status']
  progress?: number
  reason?: string
}): Promise<MatOSWorkbenchKnowledgeIngestionRecord> {
  const now = new Date().toISOString()
  const documentId = firstString(input.document.id, input.document.document_id, input.document.path) ?? 'document'
  const digest = recordDigest({
    datasetRef: input.datasetRef,
    mutation: input.mutation,
    documentId,
    path: input.document.path,
    uri: input.document.uri,
    digest: input.sourcePolicy.digest,
  })
  const ingestionId = `ingest-${safeSlug(documentId)}-${digest}`
  const relativeRecordPath = [
    '.matos',
    'workbench',
    'knowledge-ingestions',
    safeSlug(input.datasetRef),
    safeSlug(documentId),
    `${ingestionId}.json`,
  ].join('/')
  const record: MatOSWorkbenchKnowledgeIngestionRecord = {
    ingestionId,
    datasetRef: input.datasetRef,
    mutation: input.mutation,
    source: 'coze-knowledge-import',
    status: input.status ?? 'ready',
    progress: Math.max(0, Math.min(100, input.progress ?? 100)),
    document: {
      id: documentId,
      name: firstString(input.document.name, input.document.document_name, documentId) ?? documentId,
      ...(firstString(input.document.path) ? { path: firstString(input.document.path) } : {}),
      ...(firstString(input.document.uri) ? { uri: firstString(input.document.uri) } : {}),
      ...(firstString(input.document.sourceType, input.document.source_type) ? { sourceType: firstString(input.document.sourceType, input.document.source_type) } : {}),
    },
    sourcePolicy: input.sourcePolicy,
    ...(input.indexing ? { indexing: input.indexing } : {}),
    createdAt: now,
    updatedAt: now,
    relativeRecordPath,
    ...(input.reason ? { reason: input.reason } : {}),
  }
  const absolute = join(input.cwd, relativeRecordPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

export async function listMatOSWorkbenchKnowledgeIngestionRecords(input: {
  cwd: string
  datasetRef: string
}): Promise<MatOSWorkbenchKnowledgeIngestionRecord[]> {
  const root = recordRoot(input.cwd, input.datasetRef)
  const records: MatOSWorkbenchKnowledgeIngestionRecord[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      try {
        const raw = JSON.parse(await readFile(absolute, 'utf8')) as Record<string, unknown>
        if (firstString(raw.datasetRef) !== input.datasetRef) {
          continue
        }
        records.push({
          ingestionId: firstString(raw.ingestionId) ?? entry.name.replace(/\.json$/, ''),
          datasetRef: input.datasetRef,
          mutation: firstString(raw.mutation) ?? 'import-document',
          source: 'coze-knowledge-import',
          status: ingestionStatus(raw.status),
          progress: boundedProgress(raw.progress),
          document: ingestionDocumentFromRecord(raw),
          sourcePolicy: objectRecord(raw.sourcePolicy) as MatOSWorkbenchKnowledgeImportSourcePolicy,
          ...(objectRecord(raw.indexing).source ? { indexing: objectRecord(raw.indexing) as MatOSWorkbenchKnowledgeIngestionRecord['indexing'] } : {}),
          createdAt: firstString(raw.createdAt) ?? '',
          updatedAt: firstString(raw.updatedAt) ?? '',
          ...(firstString(raw.relativeRecordPath) ? { relativeRecordPath: firstString(raw.relativeRecordPath) } : {}),
          ...(firstString(raw.reason) ? { reason: firstString(raw.reason) } : {}),
        })
      } catch {
        // Ignore corrupt ledger records; asset validation remains the source of truth.
      }
    }
  }
  await walk(root)
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function boundedProgress(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 100
}

function ingestionStatus(value: unknown): MatOSWorkbenchKnowledgeIngestionRecord['status'] {
  const raw = firstString(value)?.toLowerCase()
  if (raw === 'queued' || raw === 'running' || raw === 'ready' || raw === 'failed') {
    return raw
  }
  return 'ready'
}

export function ingestionRecordForDocument(
  document: MatOSWorkbenchKnowledgeDocument,
  records: MatOSWorkbenchKnowledgeIngestionRecord[],
): MatOSWorkbenchKnowledgeIngestionRecord | undefined {
  const keys = new Set(
    [document.id, document.path, document.uri, document.name]
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  )
  return records.find(record =>
    [record.document.id, record.document.path, record.document.uri, record.document.name]
      .some(value => typeof value === 'string' && keys.has(value)),
  )
}
