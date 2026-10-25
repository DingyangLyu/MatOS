import { loadMatOSAssets } from '../assets/loadAssets.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import {
ingestionRecordForDocument,
listMatOSWorkbenchKnowledgeIngestionRecords,
} from './knowledgeIngestion.js'
import { listMatOSWorkbenchResources,showMatOSWorkbenchResource } from './resources.js'
import type {
MatOSWorkbenchContext,
MatOSWorkbenchKnowledgeDocument,
MatOSWorkbenchKnowledgeDocumentDetail,
MatOSWorkbenchKnowledgeDocumentList,
MatOSWorkbenchKnowledgeSlice,
MatOSWorkbenchKnowledgeSliceDetail,
MatOSWorkbenchKnowledgeSliceList,
MatOSWorkbenchKnowledgeView,
} from './types.js'

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function unknownArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value
    }
  }
  return []
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
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

function entryDocumentForAsset(asset: MatOSAsset): Record<string, unknown>[] {
  if (!asset.entryRelativePath) {
    return []
  }
  return [
    {
      id: `${asset.canonicalKey}:entry`,
      name: asset.entryRelativePath.split('/').at(-1) ?? asset.entryRelativePath,
      path: asset.entryRelativePath,
      sourceType: asset.source,
      role: 'entry',
    },
  ]
}

function rawDocumentsForAsset(asset: MatOSAsset): Record<string, unknown>[] {
  const metadata = objectRecord(asset.metadata)
  const documents = unknownArray(metadata.documents, metadata.files, metadata.sources)
    .map(objectRecord)
    .filter(document => Object.keys(document).length > 0)
  return documents.length ? documents : entryDocumentForAsset(asset)
}

function rawSlicesForAsset(asset: MatOSAsset): Array<{ slice: Record<string, unknown>; documentId?: string }> {
  const metadata = objectRecord(asset.metadata)
  const slices = unknownArray(metadata.slices, metadata.chunks, metadata.segments)
    .map(slice => ({ slice: objectRecord(slice) }))
  const documentSlices = unknownArray(metadata.documents, metadata.files, metadata.sources)
    .flatMap(document => {
      const record = objectRecord(document)
      const documentId = firstString(record.id, record.document_id, record.path, record.name)
      return unknownArray(record.slices, record.chunks, record.segments).map(slice => ({
        slice: objectRecord(slice),
        documentId,
      }))
    })
  return [...slices, ...documentSlices].filter(item => Object.keys(item.slice).length > 0)
}

function sliceContent(slice: Record<string, unknown>): string {
  return firstString(slice.content, slice.text, slice.summary, slice.body, slice.value) ?? ''
}

function documentStatus(value: unknown): MatOSWorkbenchKnowledgeDocument['status'] {
  const raw = firstString(value)?.toLowerCase()
  if (!raw) {
    return 'ready'
  }
  if (raw.includes('fail') || raw.includes('error')) {
    return 'failed'
  }
  if (raw.includes('index') || raw.includes('process') || raw.includes('pending') || raw.includes('running')) {
    return 'indexing'
  }
  if (raw.includes('ready') || raw.includes('complete') || raw.includes('done') || raw === '3') {
    return 'ready'
  }
  return 'unknown'
}

function documentProgress(document: Record<string, unknown>, status: MatOSWorkbenchKnowledgeDocument['status']): number {
  const explicit = numberValue(document.progress ?? document.percent ?? document.indexingProgress)
  if (explicit !== undefined) {
    return Math.max(0, Math.min(100, explicit))
  }
  if (status === 'failed') {
    return 0
  }
  if (status === 'indexing') {
    return 50
  }
  return 100
}

function documentIdentityKeys(document: MatOSWorkbenchKnowledgeDocument): Set<string> {
  return new Set(
    [document.id, document.path, document.uri, document.name]
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  )
}

function normalizeDocument(
  asset: MatOSAsset,
  raw: Record<string, unknown>,
  index: number,
  slices: MatOSWorkbenchKnowledgeSlice[],
): MatOSWorkbenchKnowledgeDocument {
  const id = firstString(raw.id, raw.document_id, raw.doc_id, raw.path, raw.uri, `${asset.canonicalKey}:doc:${index}`) ?? `${asset.canonicalKey}:doc:${index}`
  const name = firstString(raw.name, raw.document_name, raw.title, raw.path, raw.uri, `document-${index + 1}`) ?? `document-${index + 1}`
  const path = firstString(raw.path, raw.relativePath, raw.relative_path)
  const uri = firstString(raw.uri, raw.url, raw.href, path)
  const status = documentStatus(raw.status ?? raw.state ?? raw.indexingStatus)
  const metadata = objectRecord(redactMatOSAssetOutput(objectRecord(raw.metadata)))
  const sourceType = firstString(raw.sourceType, raw.source_type, raw.kind, raw.role)
  const size = numberValue(raw.size ?? raw.bytes)
  const document: MatOSWorkbenchKnowledgeDocument = {
    id,
    name,
    ...(path ? { path } : {}),
    ...(uri ? { uri } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(size !== undefined ? { size } : {}),
    status,
    progress: documentProgress(raw, status),
    sliceCount: 0,
    ...(Object.keys(metadata).length ? { metadata } : {}),
    matos: {
      ref: asset.canonicalKey,
      documentIndex: index,
    },
  }
  const keys = documentIdentityKeys(document)
  document.sliceCount = slices.filter(slice => {
    if (!slice.documentId) {
      return false
    }
    return keys.has(slice.documentId)
  }).length
  if (slices.length && document.sliceCount === 0 && rawDocumentsForAsset(asset).length === 1) {
    document.sliceCount = slices.length
  }
  return document
}

function applyIngestionOverlay(
  document: MatOSWorkbenchKnowledgeDocument,
  records: Awaited<ReturnType<typeof listMatOSWorkbenchKnowledgeIngestionRecords>>,
): MatOSWorkbenchKnowledgeDocument {
  const record = ingestionRecordForDocument(document, records)
  if (!record) {
    return document
  }
  const status = record.status === 'queued' || record.status === 'running'
    ? 'indexing'
    : record.status
  return {
    ...document,
    status,
    progress: record.progress,
    ingestion: record,
    matos: {
      ...document.matos,
      ingestionId: record.ingestionId,
    },
  }
}

function sliceMatchesQuery(slice: MatOSWorkbenchKnowledgeSlice, query: string): boolean {
  if (!query) {
    return true
  }
  return JSON.stringify(slice).toLowerCase().includes(query.toLowerCase())
}

function documentMatchesQuery(document: MatOSWorkbenchKnowledgeDocument, query: string): boolean {
  if (!query) {
    return true
  }
  return JSON.stringify(document).toLowerCase().includes(query.toLowerCase())
}

function normalizeSlice(
  asset: MatOSAsset,
  raw: { slice: Record<string, unknown>; documentId?: string },
  index: number,
): MatOSWorkbenchKnowledgeSlice {
  const redactedMetadata = objectRecord(redactMatOSAssetOutput(objectRecord(raw.slice.metadata)))
  const documentId = firstString(
    raw.slice.documentId,
    raw.slice.document_id,
    raw.slice.docId,
    raw.slice.doc_id,
    raw.documentId,
  )
  return {
    id: firstString(raw.slice.id, raw.slice.slice_id, raw.slice.chunk_id, `${asset.canonicalKey}:slice:${index}`) ?? `${asset.canonicalKey}:slice:${index}`,
    ...(documentId ? { documentId } : {}),
    index,
    content: sliceContent(raw.slice),
    ...(Object.keys(redactedMetadata).length ? { metadata: redactedMetadata } : {}),
    matos: {
      ref: asset.canonicalKey,
      sliceIndex: index,
    },
  }
}

export async function listMatOSWorkbenchKnowledge(
  input: MatOSWorkbenchContext & { query?: string; limit?: number; offset?: number },
): Promise<MatOSWorkbenchKnowledgeView> {
  const resources = await listMatOSWorkbenchResources({
    ...input,
    types: ['knowledge', 'data'],
    query: input.query,
    limit: input.limit,
    offset: input.offset,
    includeLineage: true,
  })
  return {
    resources: resources.resources,
    summary: {
      count: resources.summary.total,
      types: resources.summary.typeCounts,
    },
  }
}

export async function showMatOSWorkbenchKnowledgeResource(
  input: MatOSWorkbenchContext & { ref: string },
) {
  return showMatOSWorkbenchResource({
    ...input,
    ref: input.ref,
    includeGraph: true,
  })
}

export async function listMatOSWorkbenchKnowledgeSlices(
  input: MatOSWorkbenchContext & {
    ref: string
    query?: string
    limit?: number
    offset?: number
  },
): Promise<MatOSWorkbenchKnowledgeSliceList> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const asset = registry.resolve(input.ref)
  if (!asset) {
    throw new Error(`Unknown MatOS knowledge asset: ${input.ref}`)
  }
  const query = input.query?.trim() ?? ''
  const offset = input.offset ?? 0
  const limit = input.limit ?? 50
  const allSlices = rawSlicesForAsset(asset)
    .map((slice, index) => normalizeSlice(asset, slice, index))
  const filtered = allSlices.filter(slice => sliceMatchesQuery(slice, query))
  const page = filtered.slice(offset, offset + limit)
  return {
    dataset: {
      ref: asset.canonicalKey,
      id: asset.id,
      name: asset.name,
      ...(asset.description ? { description: asset.description } : {}),
    },
    slices: page,
    summary: {
      total: filtered.length,
      unfilteredTotal: allSlices.length,
      offset,
      limit,
      query,
      source: 'matos-asset-registry',
    },
  }
}

export async function listMatOSWorkbenchKnowledgeDocuments(
  input: MatOSWorkbenchContext & {
    ref: string
    query?: string
    limit?: number
    offset?: number
  },
): Promise<MatOSWorkbenchKnowledgeDocumentList> {
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(input.cwd))
  const asset = registry.resolve(input.ref)
  if (!asset) {
    throw new Error(`Unknown MatOS knowledge asset: ${input.ref}`)
  }
  const query = input.query?.trim() ?? ''
  const offset = input.offset ?? 0
  const limit = input.limit ?? 50
  const slices = rawSlicesForAsset(asset).map((slice, index) => normalizeSlice(asset, slice, index))
  const ingestionRecords = await listMatOSWorkbenchKnowledgeIngestionRecords({
    cwd: input.cwd,
    datasetRef: asset.canonicalKey,
  })
  const allDocuments = rawDocumentsForAsset(asset).map((document, index) =>
    applyIngestionOverlay(
      normalizeDocument(asset, document, index, slices),
      ingestionRecords,
    ),
  )
  const filtered = allDocuments.filter(document => documentMatchesQuery(document, query))
  const page = filtered.slice(offset, offset + limit)
  return {
    dataset: {
      ref: asset.canonicalKey,
      id: asset.id,
      name: asset.name,
      ...(asset.description ? { description: asset.description } : {}),
    },
    documents: page,
    summary: {
      total: filtered.length,
      unfilteredTotal: allDocuments.length,
      offset,
      limit,
      query,
      source: 'matos-asset-registry',
    },
  }
}

export async function showMatOSWorkbenchKnowledgeDocument(
  input: MatOSWorkbenchContext & {
    ref: string
    documentId: string
  },
): Promise<MatOSWorkbenchKnowledgeDocumentDetail> {
  const documents = await listMatOSWorkbenchKnowledgeDocuments({
    ...input,
    query: '',
    limit: 1000,
    offset: 0,
  })
  const requested = input.documentId.trim()
  const document = documents.documents.find(item =>
    item.id === requested ||
    item.name === requested ||
    item.path === requested ||
    item.uri === requested,
  )
  if (!document) {
    throw new Error(`Unknown MatOS knowledge document ${input.documentId} in ${input.ref}`)
  }
  const slices = await listMatOSWorkbenchKnowledgeSlices({
    ...input,
    query: '',
    limit: 1000,
    offset: 0,
  })
  const documentKeys = documentIdentityKeys(document)
  const documentSlices = slices.slices.filter(slice => {
    if (!slice.documentId) {
      return documents.documents.length === 1
    }
    return documentKeys.has(slice.documentId)
  })
  return {
    dataset: documents.dataset,
    document,
    slices: documentSlices,
    summary: {
      documentId: document.id,
      sliceCount: documentSlices.length,
      source: 'matos-asset-registry',
    },
  }
}

export async function showMatOSWorkbenchKnowledgeSlice(
  input: MatOSWorkbenchContext & {
    ref: string
    sliceId: string
  },
): Promise<MatOSWorkbenchKnowledgeSliceDetail> {
  const slices = await listMatOSWorkbenchKnowledgeSlices({
    ...input,
    query: '',
    limit: 1000,
    offset: 0,
  })
  const requested = input.sliceId.trim()
  const slice = slices.slices.find(item =>
    item.id === requested ||
    String(item.index) === requested ||
    String(item.matos.sliceIndex) === requested,
  )
  if (!slice) {
    throw new Error(`Unknown MatOS knowledge slice ${input.sliceId} in ${input.ref}`)
  }

  const documents = await listMatOSWorkbenchKnowledgeDocuments({
    ...input,
    query: '',
    limit: 1000,
    offset: 0,
  })
  const document = documents.documents.find(item => {
    if (!slice.documentId) {
      return documents.documents.length === 1
    }
    return documentIdentityKeys(item).has(slice.documentId)
  })

  return {
    dataset: slices.dataset,
    slice,
    ...(document ? { document } : {}),
    summary: {
      sliceId: slice.id,
      ...(document ? { documentId: document.id } : {}),
      source: 'matos-asset-registry',
    },
  }
}
