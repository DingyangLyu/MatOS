
import type {
MatOSWorkbenchAction,
MatOSWorkbenchCommandRoute,
MatOSWorkbenchResource,
MatOSWorkbenchResourceType,
MatOSWorkbenchWriteTransactionPreview
} from './typesCore.js'
import type {
MatOSWorkbenchAssetDraftApplyResult,
MatOSWorkbenchAssetDraftPreview
} from './typesRoleTool.js'

export type MatOSWorkbenchTableField = {
  id: string
  name: string
  type: string
  required?: boolean
  description?: string
}

export type MatOSWorkbenchTableRow = {
  id: string
  index: number
  values: Record<string, unknown>
  matos: {
    ref: string
    rowIndex: number
  }
}

export type MatOSWorkbenchTableQuery = {
  table: {
    ref: string
    id: string
    type: MatOSWorkbenchResourceType
    name: string
    description?: string
  }
  fields: MatOSWorkbenchTableField[]
  rows: MatOSWorkbenchTableRow[]
  summary: {
    total: number
    unfilteredTotal: number
    offset: number
    limit: number
    query: string
    sortBy?: string
    sortDirection: 'asc' | 'desc'
    source: 'matos-asset-registry' | 'matos-data-center-catalog'
  }
}

export type MatOSWorkbenchTableExportFormat = 'csv' | 'jsonl'

export type MatOSWorkbenchTableExportPreview = {
  mode: 'table-export-preview'
  readonly: true
  format: MatOSWorkbenchTableExportFormat
  table: MatOSWorkbenchTableQuery['table']
  fields: MatOSWorkbenchTableField[]
  rows: MatOSWorkbenchTableRow[]
  contentPreview: string
  preview: {
    content: string
    lineCount: number
    byteLength: number
    truncated: boolean
    maxBytes: number
  }
  summary: {
    total: number
    exportedRows: number
    unfilteredTotal: number
    offset: number
    limit: number
    query: string
    sortBy?: string
    sortDirection: 'asc' | 'desc'
    source: 'matos-asset-registry' | 'matos-data-center-catalog'
  }
  route: MatOSWorkbenchCommandRoute
  transaction: {
    mode: 'table-export-preview'
    readonly: true
    source: 'matos-table-export'
    requestedMutation: 'table-export'
    targetRef: string
    confirmationFingerprint: string
    contentSha256: string
  }
  download: {
    enabled: false
    reason: string
  }
  write: {
    enabled: false
    reason: string
  }
}

export type MatOSWorkbenchTableExportApplyResult = {
  mode: 'table-export-apply'
  readonly: false
  applied: true
  format: MatOSWorkbenchTableExportFormat
  table: MatOSWorkbenchTableQuery['table']
  fields: MatOSWorkbenchTableField[]
  rows: MatOSWorkbenchTableRow[]
  contentPreview: string
  preview: MatOSWorkbenchTableExportPreview
  summary: MatOSWorkbenchTableExportPreview['summary']
  exportFile: {
    path: string
    relativePath: string
    fileName: string
    byteLength: number
    sha256: string
  }
  transaction: {
    mode: 'table-export-apply'
    source: 'matos-table-export'
    requestedMutation: 'table-export'
    targetRef: string
    confirmationFingerprint: string
    contentSha256: string
    reason?: string
  }
  download: {
    enabled: true
    path: string
    relativePath: string
    reason: string
  }
  write: {
    enabled: true
    status: 'applied'
    reason: string
  }
}

export type MatOSWorkbenchTableRowCell = {
  fieldId: string
  name: string
  type: string
  value: unknown
  required?: boolean
  description?: string
}

export type MatOSWorkbenchTableRowDetail = {
  table: MatOSWorkbenchTableQuery['table']
  fields: MatOSWorkbenchTableField[]
  row: MatOSWorkbenchTableRow & {
    cells: MatOSWorkbenchTableRowCell[]
  }
  neighbors: {
    previous?: string
    next?: string
  }
  summary: {
    rowId: string
    index: number
    total: number
    source: 'matos-asset-registry'
  }
}

export type MatOSWorkbenchKnowledgeView = {
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    types: Record<string, number>
  }
}

export type MatOSWorkbenchKnowledgeDocument = {
  id: string
  name: string
  path?: string
  uri?: string
  sourceType?: string
  size?: number
  status: 'ready' | 'indexing' | 'failed' | 'unknown'
  progress: number
  sliceCount: number
  metadata?: Record<string, unknown>
  ingestion?: MatOSWorkbenchKnowledgeIngestionRecord
  matos: {
    ref: string
    documentIndex: number
    ingestionId?: string
  }
}

export type MatOSWorkbenchKnowledgeDocumentList = {
  dataset: {
    ref: string
    id: string
    name: string
    description?: string
  }
  documents: MatOSWorkbenchKnowledgeDocument[]
  summary: {
    total: number
    unfilteredTotal: number
    offset: number
    limit: number
    query: string
    source: 'matos-asset-registry'
  }
}

export type MatOSWorkbenchKnowledgeDocumentDetail = {
  dataset: MatOSWorkbenchKnowledgeDocumentList['dataset']
  document: MatOSWorkbenchKnowledgeDocument
  slices: MatOSWorkbenchKnowledgeSlice[]
  summary: {
    documentId: string
    sliceCount: number
    source: 'matos-asset-registry'
  }
}

export type MatOSWorkbenchKnowledgeImportIssue = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
  ref?: string
}

export type MatOSWorkbenchKnowledgeImportSourcePolicy = {
  kind: 'workspace-file' | 'url' | 'managed-upload' | 'unknown'
  allowed: boolean
  sourcePath?: string
  relativePath?: string
  uri?: string
  size?: number
  digest?: string
  contentEncoding?: 'utf8' | 'base64'
  reason?: string
}

export type MatOSWorkbenchKnowledgeIngestionRecord = {
  ingestionId: string
  datasetRef: string
  mutation: string
  source: 'coze-knowledge-import'
  status: 'queued' | 'running' | 'ready' | 'failed'
  progress: number
  document: {
    id: string
    name: string
    path?: string
    uri?: string
    sourceType?: string
  }
  sourcePolicy: MatOSWorkbenchKnowledgeImportSourcePolicy
  indexing?: MatOSWorkbenchKnowledgeIndexSummary
  createdAt: string
  updatedAt: string
  relativeRecordPath?: string
  reason?: string
}

export type MatOSWorkbenchKnowledgeIndexSummary = {
  source: 'matos-knowledge-indexer'
  strategy: 'text-window-v1'
  status: 'indexed' | 'skipped' | 'failed'
  documentId: string
  sliceCount: number
  byteCount?: number
  charCount?: number
  contentDigest?: string
  relativePath?: string
  skippedReason?: string
  error?: string
}

export type MatOSWorkbenchKnowledgeImportPreview = {
  datasetRef: string
  source: 'coze-knowledge-import'
  mode: 'import-preview'
  mutation: string
  document?: Record<string, unknown>
  sourcePolicy: MatOSWorkbenchKnowledgeImportSourcePolicy
  validation: {
    ok: boolean
    errors: MatOSWorkbenchKnowledgeImportIssue[]
  }
  issues: MatOSWorkbenchKnowledgeImportIssue[]
  summary: {
    documentCount: number
    sliceCount: number
    warningCount: number
    errorCount: number
  }
  write: {
    enabled: false
    reason: string
    nextAction: MatOSWorkbenchAction
  }
  draft?: MatOSWorkbenchAssetDraftPreview
  transaction?: MatOSWorkbenchWriteTransactionPreview
  indexing?: MatOSWorkbenchKnowledgeIndexSummary
  raw?: {
    request?: unknown
  }
}

export type MatOSWorkbenchKnowledgeImportApplyResult = {
  datasetRef: string
  source: 'coze-knowledge-import'
  mode: 'controlled-write'
  mutation: string
  applied: boolean
  readonly: false
  importPreview: MatOSWorkbenchKnowledgeImportPreview
  applyResult: MatOSWorkbenchAssetDraftApplyResult
  transaction?: MatOSWorkbenchWriteTransactionPreview
  ingestionRecord?: MatOSWorkbenchKnowledgeIngestionRecord
  indexing?: MatOSWorkbenchKnowledgeIndexSummary
  write: MatOSWorkbenchAssetDraftApplyResult['write']
  validation?: MatOSWorkbenchAssetDraftApplyResult['validation']
  snapshots: MatOSWorkbenchAssetDraftApplyResult['snapshots']
  after?: MatOSWorkbenchAssetDraftApplyResult['after']
}

export type MatOSWorkbenchKnowledgeSliceDetail = {
  dataset: MatOSWorkbenchKnowledgeSliceList['dataset']
  slice: MatOSWorkbenchKnowledgeSlice
  document?: MatOSWorkbenchKnowledgeDocument
  summary: {
    sliceId: string
    documentId?: string
    source: 'matos-asset-registry'
  }
}

export type MatOSWorkbenchKnowledgeSlice = {
  id: string
  documentId?: string
  index: number
  content: string
  metadata?: Record<string, unknown>
  matos: {
    ref: string
    sliceIndex: number
  }
}

export type MatOSWorkbenchKnowledgeSliceList = {
  dataset: {
    ref: string
    id: string
    name: string
    description?: string
  }
  slices: MatOSWorkbenchKnowledgeSlice[]
  summary: {
    total: number
    unfilteredTotal: number
    offset: number
    limit: number
    query: string
    source: 'matos-asset-registry'
  }
}
