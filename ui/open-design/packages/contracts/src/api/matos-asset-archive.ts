export interface MatOSAssetArchiveRevision {
  revisionId: string;
  assetRef: string;
  name: string;
  version: string;
  snapshotId: string;
  commit: string;
  scope: string;
  scopeRef?: string;
  createdAt: string;
  kind: string;
  state: string;
  sourceId?: string;
  sourceCommit?: string;
  fileCount: number;
  sizeBytes: number;
  configuredCurrent?: boolean;
  audit?: { runId: string; summary?: string; expectedBehaviorChange?: string; verdict?: string; beforeSnapshot?: string; afterSnapshot?: string };
}

export interface MatOSAssetArchiveList {
  revisions: MatOSAssetArchiveRevision[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  issues: string[];
  storage: string;
}

export interface MatOSAssetArchiveDetail {
  revision: MatOSAssetArchiveRevision;
  files: Array<{ path: string; sha256: string; sizeBytes: number; content?: string; unavailable?: string }>;
}

export interface MatOSAssetArchiveRestore {
  revision: MatOSAssetArchiveRevision;
  canRestore?: boolean;
  expectedCurrent?: string;
  reason?: string;
  mode: 'local' | 'candidate';
  files?: string[];
  ok?: boolean;
  action?: string;
  pullRequest?: { html_url?: string; url?: string; number?: number };
}
