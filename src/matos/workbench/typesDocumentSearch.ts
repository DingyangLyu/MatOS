
import type {
MatOSWorkbenchResource,
MatOSWorkbenchSearchRanking
} from './typesCore.js'
import type {
MatOSWorkbenchKnowledgeDocument,
MatOSWorkbenchKnowledgeDocumentList,
} from './typesTableKnowledge.js'

export type MatOSWorkbenchDocumentSearchItem = {
  id: string
  documentId: string
  datasetRef: string
  datasetName: string
  title: string
  path?: string
  uri?: string
  sourceType?: string
  status: MatOSWorkbenchKnowledgeDocument['status']
  progress: number
  sliceCount: number
  source: 'matos-asset-registry'
  searchRanking?: MatOSWorkbenchSearchRanking
  sliceMatches?: MatOSWorkbenchDocumentSearchSliceMatch[]
  matos: {
    dataset: MatOSWorkbenchKnowledgeDocumentList['dataset']
    document: MatOSWorkbenchKnowledgeDocument
    resource: MatOSWorkbenchResource
  }
}

export type MatOSWorkbenchDocumentSearchSliceMatch = {
  sliceId: string
  documentId?: string
  index: number
  contentPreview: string
  score: number
  searchRanking: MatOSWorkbenchSearchRanking
  metadata?: Record<string, unknown>
  matos: {
    datasetRef: string
    sliceRef: string
    sliceIndex: number
  }
}

export type MatOSWorkbenchDocumentSearch = {
  query: string
  documents: MatOSWorkbenchDocumentSearchItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    query: string
    count: number
    total: number
    offset: number
    limit: number
    source: 'matos-asset-registry'
    datasetCounts: Record<string, number>
    ranking: {
      mode: 'native-search-ranking'
      explain: true
      topScore: number
      scoredCount: number
    }
    policy: {
      mode: 'native-readonly'
      remoteKnowledgeBackend: 'blocked'
    }
  }
}
