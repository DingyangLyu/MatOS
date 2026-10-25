import type { OkResponse } from '../common.js';
import type { ArtifactKind, ArtifactManifest } from './artifacts.js';

export type ProjectFileKind =
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'workflow'
  | 'text'
  | 'code'
  | 'pdf'
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'binary';

// Surfaced when the daemon's stub-guard runs in `warn` mode and detects a
// likely regression (the agent emitted a placeholder body that is much
// smaller than a prior artifact sharing the same `metadata.identifier`).
// In `reject` mode the daemon returns `422 ARTIFACT_REGRESSION` instead and
// no `ProjectFile` is produced.
export interface ProjectFileStubGuardWarning {
  code: 'ARTIFACT_REGRESSION';
  message: string;
  identifier: string;
  newSize: number;
  priorSize: number;
  priorName: string;
}

export interface ProjectFile {
  name: string;
  path?: string;
  localPath?: string;
  type?: 'file' | 'dir';
  size: number;
  mtime: number;
  /** Strong content revision used for optimistic file writes. */
  etag?: string;
  kind: ProjectFileKind;
  mime: string;
  artifactKind?: ArtifactKind;
  artifactManifest?: ArtifactManifest;
  stubGuardWarning?: ProjectFileStubGuardWarning;
  traceObjectReason?: 'new' | 'modified' | 'recovered';
}

export interface ProjectFolder {
  name: string;
  path: string;
  type: 'dir';
  size: 0;
  mtime: number;
}

export interface ProjectFilesResponse {
  files: ProjectFile[];
  /** Paths removed after the requested snapshot; empty for a complete list. */
  removed?: string[];
  /** False when `files` contains only entries changed since the requested token. */
  complete?: boolean;
  /** Opaque monotonic token accepted by the next `?since=` list request. */
  snapshotAt?: number;
  /** The returned snapshot is usable while a background reconciliation runs. */
  stale?: boolean;
}

/** Explicit page, never mistaken for a complete file index or a delta. */
export interface ProjectFilesPageResponse {
  files: ProjectFile[];
  total: number;
  nextCursor: string | null;
  snapshotAt: number;
}

export type ProjectFileVersionSource = 'ai' | 'manual' | 'restore';
export type ProjectFileVersionPromptSource = 'message' | 'project' | 'manual' | 'restore';

export interface ProjectFileVersion {
  id: string;
  fileName: string;
  version: number;
  label: string;
  createdAt: number;
  source: ProjectFileVersionSource;
  prompt: string | null;
  promptSource?: ProjectFileVersionPromptSource;
  restoreFromVersionId?: string;
  size: number;
  mime: string;
  kind: ProjectFileKind;
  current: boolean;
}

export interface ProjectFileVersionsResponse {
  file: ProjectFile;
  versions: ProjectFileVersion[];
}

export interface ProjectFileVersionResponse {
  version: ProjectFileVersion;
  content: string;
}

export interface CreateProjectFileVersionResponse {
  version: ProjectFileVersion;
}

export interface ProjectFileVersionWarning {
  code: 'PROJECT_FILE_VERSION_CAPTURE_FAILED';
  message: string;
}

export interface RestoreProjectFileVersionResponse {
  file: ProjectFile;
  version: ProjectFileVersion | null;
  versionWarning?: ProjectFileVersionWarning;
}

export interface ProjectFoldersResponse {
  folders: ProjectFolder[];
}

export interface ProjectPreviewUrlResponse {
  url: string;
  file: string;
  csp: string;
  iframeSandbox: string;
  opaqueOrigin: true;
}

export interface ProjectFileResponse {
  file: ProjectFile;
  versionWarning?: ProjectFileVersionWarning;
}

export interface ProjectFolderResponse {
  folder: ProjectFolder;
}

export interface UploadProjectFilesResponse extends ProjectFilesResponse {}

export interface DeleteProjectFileResponse extends OkResponse {}

export interface DeleteProjectFolderResponse extends OkResponse {}

export interface RenameProjectFileResponse {
  file: ProjectFile;
  oldName: string;
  newName: string;
}

export function buildProjectRawFileUrl(
  baseUrl: string,
  projectId: string,
  filePath: unknown,
): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const segments = filePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
  if (segments.length === 0) return null;

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  return `${normalizedBaseUrl}/api/projects/${encodeURIComponent(projectId)}/raw/${segments}`;
}
