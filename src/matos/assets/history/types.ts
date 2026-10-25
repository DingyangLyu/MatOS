export type MatOSAssetHistoryScope =
  | 'core'
  | 'project'
  | 'user'
  | 'team'
  | 'shared'
  | 'global'

export type MatOSAssetHistorySnapshotKind =
  | 'manual'
  | 'direct-editor-before'
  | 'direct-editor-after'
  | 'direct-editor-rollback'
  | 'release'

export type MatOSAssetHistoryFileRecord = {
  path: string
  sha256: string
  sizeBytes: number
}

export type MatOSAssetHistoryGiteaSourceProvenance = {
  owner?: string
  repo?: string
  url?: string
  pullRequestUrl?: string
  pullRequestNumber?: number
}

export type MatOSAssetHistorySourceProvenance = {
  sourceId?: string
  provider?: string
  repo?: string
  ref?: string
  commit?: string
  currentRemote?: string
  currentCommit?: string
  gitea?: MatOSAssetHistoryGiteaSourceProvenance
}

export type MatOSAssetHistorySnapshotRecord = {
  schemaVersion: 1
  snapshotId: string
  kind: MatOSAssetHistorySnapshotKind
  scope: MatOSAssetHistoryScope
  /** Exact owner for user/team/project snapshots. Older single-owner records may omit it. */
  scopeRef?: string
  fullScope?: boolean
  gitDir: string
  commit: string
  parentCommit?: string
  ref?: string
  createdAt: string
  cwd: string
  assetRefs: string[]
  files: MatOSAssetHistoryFileRecord[]
  provenance?: Record<string, unknown>
}

export type MatOSAssetHistorySecretFinding = {
  path: string
  reason: string
}

export type MatOSAssetHistoryValidationResult = {
  ok: boolean
  gateProfile: 'structural' | 'smoke' | 'full'
  assetValidation: {
    ok: boolean
    errors: unknown[]
  }
  secretScan: {
    ok: boolean
    findings: MatOSAssetHistorySecretFinding[]
  }
  workflowValidation: unknown[]
  /**
   * Present when the gate profile ran asset-type smoke checks. Smoke errors
   * are merged into assetValidation.errors so differential baselines apply;
   * this summary exists for run-record observability.
   */
  smoke?: {
    checkedAssets: number
    checkedByType: Record<string, number>
    errorCount: number
  }
}

export type MatOSAssetHistoryDiff = {
  from: string
  to: string
  fromCommit: string
  toCommit: string
  patch: string
}

export type MatOSAssetHistoryReleaseRecord = {
  schemaVersion: 1
  releaseId: string
  name: string
  createdAt: string
  sourceRef: string
  commit: string
  validation?: MatOSAssetHistoryValidationResult
  previousStableCommit?: string
  provenance?: Record<string, unknown>
}
