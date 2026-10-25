import type {
MatOSAssetHistorySnapshotRecord,
MatOSAssetHistoryValidationResult
} from '../assets/history/types.js'

import type {
MatOSWorkbenchAction,
MatOSWorkbenchResource,
MatOSWorkbenchResourceShow,
MatOSWorkbenchResourceType,
MatOSWorkbenchSearchRanking,
MatOSWorkbenchWriteTransactionPreview
} from './typesCore.js'

export type MatOSWorkbenchMarketplaceFavoriteItem = {
  ref: string
  label?: string
  reason?: string
  favoritedAt?: string
  updatedAt?: string
  resource: MatOSWorkbenchResource
}

export type MatOSWorkbenchMarketplaceFavorites = {
  mode: 'native-marketplace-favorites'
  favorites: MatOSWorkbenchMarketplaceFavoriteItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    count: number
    total: number
    storedCount: number
    missingCount: number
    offset: number
    limit: number
    query: string
    source: 'native-workbench-store'
  }
  store: {
    mode: 'native-workbench-store'
    relativePath: string
    eventLogRelativePath: string
    updatedAt?: string
    missingRefs: string[]
  }
  raw?: unknown
}

export type MatOSWorkbenchMarketplaceFavoriteAction = {
  mode: 'matos-marketplace-favorite-action'
  action: 'favorite' | 'unfavorite' | 'toggle-favorite'
  ref: string
  favorited: boolean
  changed: boolean
  reason?: string
  resource: MatOSWorkbenchResource
  favorites: MatOSWorkbenchMarketplaceFavorites
  audit: {
    relativePath: string
    event: {
      timestamp: string
      action: 'favorite' | 'unfavorite' | 'toggle-favorite'
      ref: string
      changed: boolean
      favorited: boolean
      reason?: string
    }
  }
}


export type MatOSWorkbenchAssetSearch = {
  query: string
  results: MatOSWorkbenchResource[]
  summary: {
    query: string
    count: number
    total: number
    offset: number
    limit: number
    source: 'matos-asset-registry'
    typeCounts: Record<string, number>
    ranking: {
      mode: 'native-search-ranking'
      explain: true
      topScore: number
      scoredCount: number
    }
  }
}

export type MatOSWorkbenchAssetTemplateItem = {
  id: string
  templateId: string
  resourceRef: string
  type: MatOSWorkbenchResourceType
  title: string
  description?: string
  category: string
  tags: string[]
  dependencies: string[]
  status?: string
  source: 'matos-asset-registry'
  searchRanking?: MatOSWorkbenchSearchRanking
  actions: MatOSWorkbenchAction[]
  matos: MatOSWorkbenchResource
}

export type MatOSWorkbenchAssetTemplateSearch = {
  query: string
  templates: MatOSWorkbenchAssetTemplateItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    query: string
    count: number
    total: number
    offset: number
    limit: number
    source: 'matos-asset-registry'
    typeCounts: Record<string, number>
    ranking: {
      mode: 'native-search-ranking'
      explain: true
      topScore: number
      scoredCount: number
    }
    policy: {
      mode: 'native-readonly'
      remoteMarketplaceBackend: 'blocked'
      visibility: 'shared-global-only'
      allowedScopes: string[]
      filteredPrivateCount: number
    }
  }
}

export type MatOSWorkbenchExternalIntakeItem = {
  id: string
  intakeId: string
  resourceRef: string
  title: string
  description?: string
  kind: string
  repository?: string
  sourceUrl?: string
  status?: string
  tags: string[]
  source: 'matos-asset-registry'
  approval: {
    state: 'approved' | 'registered' | 'draft' | 'unknown'
    reason?: string
  }
  searchRanking?: MatOSWorkbenchSearchRanking
  actions: MatOSWorkbenchAction[]
  matos: MatOSWorkbenchResource
}

export type MatOSWorkbenchExternalIntakeSearch = {
  query: string
  intakes: MatOSWorkbenchExternalIntakeItem[]
  resources: MatOSWorkbenchResource[]
  summary: {
    query: string
    count: number
    total: number
    offset: number
    limit: number
    source: 'matos-asset-registry'
    kindCounts: Record<string, number>
    ranking: {
      mode: 'native-search-ranking'
      explain: true
      topScore: number
      scoredCount: number
    }
    policy: {
      mode: 'native-readonly'
      remoteMarketplaceBackend: 'blocked'
      mutation: 'controlled-import'
      visibility: 'shared-global-only'
      allowedScopes: string[]
      allowedApprovalStates: Array<'approved' | 'registered'>
      filteredPrivateCount: number
      filteredUnapprovedCount: number
    }
  }
}

export type MatOSWorkbenchExternalIntakeImportPreview = {
  mode: 'external-intake-import-preview'
  source: 'matos-asset-registry'
  intake: MatOSWorkbenchExternalIntakeItem
  resource: MatOSWorkbenchResource
  plan: {
    operation: 'external-intake-import'
    targetPack: {
      packId: string
      relativePath: string
      manifestRelativePath: string
    }
    proposedAssets: Array<{
      type: MatOSWorkbenchResourceType
      id: string
      ref: string
      version: string
      manifestRelativePath: string
      entryRelativePath?: string
    }>
    source: {
      repository?: string
      sourceUrl?: string
      kind: string
    }
    classification: {
      requestedType?: string
      selectedType: MatOSWorkbenchResourceType
      candidates: MatOSWorkbenchResourceType[]
    }
    provenance: {
      intakeRef: string
      approvalState: MatOSWorkbenchExternalIntakeItem['approval']['state']
    }
  }
  validation: {
    ok: boolean
    issues: Array<{
      code: string
      severity: 'error' | 'warning'
      message: string
    }>
  }
  write: {
    enabled: false
    reason: string
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
}

export type MatOSWorkbenchExternalIntakeImportApplyResult = {
  mode: 'external-intake-import-controlled-write'
  source: 'matos-asset-registry'
  applied: boolean
  readonly: false
  intake: MatOSWorkbenchExternalIntakeItem
  resource: MatOSWorkbenchResource
  preview: MatOSWorkbenchExternalIntakeImportPreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  plan: MatOSWorkbenchExternalIntakeImportPreview['plan']
  targetRef: string
  targetPackPath: string
  writtenPaths: string[]
  snapshots: {
    before: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    after?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    rollback?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
  }
  validation?: MatOSAssetHistoryValidationResult
  after?: MatOSWorkbenchResourceShow
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'search.intake-import'
    reason?: string
  }
}

export type MatOSWorkbenchExternalIntakeMaterializePreview = {
  mode: 'external-intake-materialize-preview'
  source: 'matos-asset-registry'
  intake: MatOSWorkbenchExternalIntakeItem
  resource: MatOSWorkbenchResource
  plan: {
    operation: 'external-intake-materialize'
    source: {
      repository?: string
      sourceUrl?: string
      cloneUrl: string
      protocol: 'https' | 'http' | 'file' | 'local'
      localPath?: string
      kind: string
    }
    target: {
      intakeId: string
      relativePath: string
      sourceRelativePath: string
      manifestRelativePath: string
      eventLogRelativePath: string
    }
    provenance: {
      intakeRef: string
      approvalState: MatOSWorkbenchExternalIntakeItem['approval']['state']
    }
  }
  validation: {
    ok: boolean
    issues: Array<{
      code: string
      severity: 'error' | 'warning'
      message: string
    }>
  }
  write: {
    enabled: false
    reason: string
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
}

export type MatOSWorkbenchExternalIntakeMaterializeApplyResult = {
  mode: 'external-intake-materialize-controlled-write'
  source: 'matos-asset-registry'
  applied: boolean
  readonly: false
  intake: MatOSWorkbenchExternalIntakeItem
  resource: MatOSWorkbenchResource
  preview: MatOSWorkbenchExternalIntakeMaterializePreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  plan: MatOSWorkbenchExternalIntakeMaterializePreview['plan']
  targetPath: string
  sourcePath: string
  writtenPaths: string[]
  git?: {
    head?: string
    remote?: string
  }
  validation: {
    ok: boolean
    gateProfile: 'materialize'
    checks: Array<{
      key: string
      ok: boolean
      message: string
    }>
  }
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-workbench-external-intake-ledger'
    operation: 'search.intake-materialize'
    manifestPath: string
    eventLogPath: string
    reason?: string
  }
}

export type MatOSWorkbenchMarketplaceDuplicatePreview = {
  mode: 'marketplace-duplicate-preview'
  source: 'matos-asset-registry'
  resource: MatOSWorkbenchResource
  plan: {
    operation: 'marketplace-duplicate'
    sourceRef: string
    targetPack: {
      packId: string
      relativePath: string
      manifestRelativePath: string
    }
    proposedAsset: {
      type: MatOSWorkbenchResourceType
      id: string
      ref: string
      version: string
      name: string
      manifestRelativePath: string
      entryRelativePath: string
    }
    source: {
      sourceType?: string
      sourcePath?: string
      packId?: string
      entryRelativePath?: string
      marketplaceVisibility?: string
    }
    provenance: {
      clonedFromRef: string
      clonedFromName: string
      clonedFromVersion?: string
    }
  }
  materialization: {
    strategy: 'copy-entry' | 'fallback-readme'
    copiedEntry: boolean
    reason?: string
  }
  validation: {
    ok: boolean
    issues: Array<{
      code: string
      severity: 'error' | 'warning'
      message: string
    }>
  }
  write: {
    enabled: false
    reason: string
  }
  transaction: MatOSWorkbenchWriteTransactionPreview
}

export type MatOSWorkbenchMarketplaceDuplicateApplyResult = {
  mode: 'marketplace-duplicate-controlled-write'
  source: 'matos-asset-registry'
  applied: boolean
  readonly: false
  resource: MatOSWorkbenchResource
  preview: MatOSWorkbenchMarketplaceDuplicatePreview
  transaction: MatOSWorkbenchWriteTransactionPreview
  plan: MatOSWorkbenchMarketplaceDuplicatePreview['plan']
  targetRef: string
  targetPackPath: string
  writtenPaths: string[]
  snapshots: {
    before: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    after?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
    rollback?: Pick<MatOSAssetHistorySnapshotRecord, 'snapshotId' | 'commit' | 'files' | 'assetRefs'>
  }
  validation?: MatOSAssetHistoryValidationResult
  after?: MatOSWorkbenchResourceShow
  write: {
    enabled: true
    status: 'applied' | 'rolled-back'
    reason?: string
  }
  audit: {
    target: 'matos-asset-history'
    operation: 'search.duplicate'
    reason?: string
  }
}
