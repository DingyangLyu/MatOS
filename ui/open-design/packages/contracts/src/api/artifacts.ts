import type { JsonValue } from '../common.js';

export type ArtifactKind =
  | 'html'
  | 'deck'
  | 'react-component'
  | 'markdown-document'
  | 'svg'
  | 'diagram'
  | 'code-snippet'
  | 'mini-app';

export type ArtifactRendererId =
  | 'html'
  | 'deck-html'
  | 'react-component'
  | 'markdown'
  | 'svg'
  | 'diagram'
  | 'code'
  | 'mini-app';

export type ArtifactExportKind = 'html' | 'pdf' | 'zip' | 'jsx' | 'md' | 'svg' | 'txt';

export type ArtifactStatus = 'streaming' | 'complete' | 'error';

export type ArtifactProvenanceTaskKind =
  | 'new-generation'
  | 'code-migration'
  | 'tune-collab';

export type ArtifactProvenanceArtifactKind =
  | 'html-prototype'
  | 'deck'
  | 'interactive-video'
  | 'code-diff'
  | 'production-app'
  | 'asset-pack';

export type ArtifactProvenanceRenderKind =
  | 'html'
  | 'jsx'
  | 'pptx'
  | 'markdown'
  | 'video'
  | 'image'
  | 'diff'
  | 'repo';

export type ArtifactExportSurface =
  | 'cli'
  | 'desktop'
  | 'web'
  | 'docker'
  | 'github'
  | 'code-agent';

export interface ArtifactExportTarget {
  surface:    ArtifactExportSurface;
  target:     string;
  exportedAt: number;
}

export interface ArtifactManifest {
  version: 1;
  kind: ArtifactKind;
  title: string;
  entry: string;
  renderer: ArtifactRendererId;
  /**
   * Optional for backward compatibility with pre-streaming artifacts.
   * Daemon/web manifest normalization defaults missing values to "complete".
  */
  status?: ArtifactStatus;
  exports: ArtifactExportKind[];
  /**
   * Optional primary entry hint for multi-file outputs. When omitted, clients
   * may fall back to renderable-file heuristics.
   */
  primary?: string | boolean;
  supportingFiles?: string[];
  createdAt?: string;
  updatedAt?: string;
  sourceSkillId?: string;
  metadata?: Record<string, JsonValue | undefined>;

  sourceTaskKind?: ArtifactProvenanceTaskKind;
  sourceRunId?: string;
  sourceProjectId?: string;
  parentArtifactId?: string;

  artifactKind?: ArtifactProvenanceArtifactKind;
  renderKind?:   ArtifactProvenanceRenderKind;
  exportTargets?: ArtifactExportTarget[];
}
