// OD Library — global asset registry contracts.
//
// The library is the system-wide asset registration center: every asset that
// enters Open Design (clipper capture, manual upload, agent-task upload or
// generation, asset staging) is indexed here through a single
// `registerLibraryAsset` hook. Each logical asset is deduped by content hash
// and may carry many source records (1 asset : N sources) so the same image
// used in two tasks collapses to one asset with two back-links.
//
// These DTOs are the shared web/daemon contract. Keep this file pure
// TypeScript — no Node, browser, or daemon imports.

/** What the asset fundamentally is. */
export type LibraryAssetKind =
  | 'image'
  | 'color'
  | 'font'
  | 'html'
  | 'text'
  | 'url'
  | 'video';

/**
 * Storage model:
 * - `owned`: the library holds its own content-addressed copy under
 *   LIBRARY_DIR (clipper capture, `od library import`, independent sources).
 * - `referenced`: the bytes already live inside a project directory; the library only stores a pointer + metadata + embedding.
 */
export type LibraryStorage = 'owned' | 'referenced';

/** Where a given source record came from — drives the back-link UI. */
export type LibrarySourceKind =
  | 'clipper'
  | 'manual-upload'
  | 'agent-task'
  | 'generated';

/** A single provenance record for an asset (1 asset : N sources). */
export interface LibraryAssetSource {
  id: string;
  assetId: string;
  sourceKind: LibrarySourceKind;
  /** Project the asset was captured/used in, when applicable. */
  projectId?: string;
  /** Conversation/run that produced or uploaded the asset (agent-task). */
  conversationId?: string;
  runId?: string;
  /** Path of the underlying file relative to its origin project, when referenced. */
  relPath?: string;
  createdAt: number;
}

export interface LibraryAsset {
  id: string;
  kind: LibraryAssetKind;
  storage: LibraryStorage;
  /** Originating page/resource URL (clipper / import). */
  sourceUrl?: string;
  /** Originating page/document title. */
  sourceTitle?: string;
  /** Host of `sourceUrl`, denormalized for cheap domain filtering. */
  sourceDomain?: string;
  /** Unix ms the asset was first captured/registered. */
  capturedAt: number;
  /** `YYYY-MM-DD` local date, drives the daily archive feed. */
  archivedDate: string;
  mime?: string;
  width?: number;
  height?: number;
  size?: number;
  contentHash: string;
  /** AI-enriched (vision) one-line description; absent until enriched. */
  caption?: string;
  /** AI-enriched OCR text; absent until enriched. */
  ocrText?: string;
  /** Programmatic dominant-color palette (hex strings). */
  palette?: string[];
  tags: string[];
  metadata?: Record<string, unknown>;
  /** referenced-only: project that physically owns the bytes. */
  originProjectId?: string;
  /** referenced-only: file path relative to the origin project root. */
  relPath?: string;
  sources: LibraryAssetSource[];
  createdAt: number;
  updatedAt: number;
}

export interface LibraryIngestResponse {
  asset: LibraryAsset;
  /** Enrichment task id (absent when nothing to enrich). */
  taskId?: string;
  /** True when the content hash already existed and a source was appended. */
  deduped: boolean;
}

export interface LibraryAssetListResponse {
  assets: LibraryAsset[];
}

export interface LibraryApplyResponse {
  relPath: string;
  /**
   * Project-relative path of the companion element-markup file, present only
   * when `includeElement` was requested for an element-pick capture.
   */
  elementRelPath?: string;
}

/**
 * Turn a captured `html` library asset into a brand-new, editable OD project.
 * The daemon copies the asset's self-contained HTML into a fresh project as an
 * `index.html` file, seeds a conversation, and records a project back-link on
 * the asset. The web client then opens the project on that file so the user can
 * edit it (srcDoc bridge + agent surgical edits) immediately — this is the
 * clipper "capture → editable OD page" exit, driven from the Library.
 */
export interface LibraryEditAsPageResponse {
  projectId: string;
  conversationId: string;
  /** Path of the editable HTML file relative to the project root. */
  relPath: string;
}

/**
 * Result of a Library reconcile pass (`POST /api/library/sync`, the web "Sync"
 * button, and `od library sync`). Reconcile registers *referenced* Library rows
 * for agent-produced project deliverables so the Library
 * mirrors everything a user has made, not just clips/uploads. It is idempotent —
 * re-running it does not duplicate rows — so the counts report what this pass
 * newly indexed (`*Added`) versus what was already present (`deduped`).
 */
export interface LibrarySyncResponse {
  /** Project deliverable assets newly registered this pass. */
  projectAssets: number;
  /** Referenced rows skipped because their origin file was already indexed. */
  deduped: number;
  /** Total Library rows newly registered this pass (`projectAssets`). */
  total: number;
}

// ---------------------------------------------------------------------------
// Manual-upload format policy
// ---------------------------------------------------------------------------
//
// The Library is a design-asset registry, so manual uploads (the web upload UI
// and `od library import`) are restricted to design-relevant resources —
// images, fonts, and the text family (plain text, HTML, CSS, Markdown, CSV…)
// plus JSON / design data. Audio and video are explicitly turned away. This is
// the single shared policy: the daemon ingest route enforces it as the source
// of truth, and the web upload UI runs the same checks for a pre-flight `accept`
// filter and instant per-file feedback. Clipper captures bypass it entirely —
// the extension curates its own payloads (including page video) over a trusted
// origin.

/**
 * Largest manual upload accepted, in bytes. The web UI sends file bytes inline
 * as a base64 `data:` URI through `/api/library/ingest`, which rides the
 * daemon's 4 MB JSON body limit; base64 inflates payloads by ~33%, so the raw
 * ceiling sits at ~3 MB. Enforced on both surfaces so an oversized file fails
 * with a clear message instead of a generic body-parser 413.
 */
export const LIBRARY_UPLOAD_MAX_BYTES = 3_000_000;

/** MIME families accepted for manual upload (prefix match). */
export const LIBRARY_UPLOAD_MIME_PREFIXES = ['image/', 'font/', 'text/'] as const;

/**
 * Exact MIME types accepted beyond the prefixes — JSON / design data and the
 * `application/*`-namespaced font and XML types. Any `application/*+json` or
 * `application/*+xml` subtype is also accepted via the suffix check in
 * {@link isLibraryUploadMimeAllowed}.
 */
export const LIBRARY_UPLOAD_MIME_EXACT = [
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/font-woff',
  'application/font-sfnt',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/vnd.ms-opentype',
  'image/vnd.microsoft.icon',
] as const;

/**
 * MIME families explicitly rejected. Audio and video are not useful as design
 * assets, so they are refused even though some future accepted prefix could
 * otherwise sweep them in.
 */
export const LIBRARY_UPLOAD_REJECT_PREFIXES = ['audio/', 'video/'] as const;

/**
 * File extensions accepted for manual upload, driving the file-picker `accept`
 * attribute and the drag-drop / paste pre-filter, and the daemon's extension
 * fallback when a file arrives without a usable MIME type. Kept in sync with the
 * MIME policy above; the MIME policy stays authoritative.
 */
export const LIBRARY_UPLOAD_EXTENSIONS = [
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico', '.tiff', '.tif',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf',
  // text & markup
  '.txt', '.md', '.markdown', '.csv', '.html', '.htm', '.css', '.xml',
  // data
  '.json', '.json5', '.geojson',
] as const;

function libraryUploadExtensionOf(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  return filename.slice(dot).toLowerCase();
}

/**
 * Whether a `(mime, filename)` pair may be manually uploaded to the Library.
 *
 * The MIME type is authoritative: an `audio/*` or `video/*` type is rejected
 * outright; an accepted prefix / `+json` / `+xml` / exact type passes; anything
 * else is refused. When the MIME is missing or a generic
 * `application/octet-stream` (the daemon's sniff fallback, or a browser that
 * reports no type), the file extension is consulted so a known design extension
 * still gets through.
 *
 * Pure string logic — safe to run in the browser pre-flight and in the daemon
 * ingest guard from this one shared definition.
 */
export function isLibraryUploadMimeAllowed(mime: string | undefined, filename?: string): boolean {
  const m = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (LIBRARY_UPLOAD_REJECT_PREFIXES.some((p) => m.startsWith(p))) return false;
  if (m && m !== 'application/octet-stream') {
    if (LIBRARY_UPLOAD_MIME_PREFIXES.some((p) => m.startsWith(p))) return true;
    if (m.endsWith('+json') || m.endsWith('+xml')) return true;
    return (LIBRARY_UPLOAD_MIME_EXACT as readonly string[]).includes(m);
  }
  // No usable MIME — fall back to the file extension.
  const ext = libraryUploadExtensionOf(filename);
  return ext ? (LIBRARY_UPLOAD_EXTENSIONS as readonly string[]).includes(ext) : false;
}

/** `accept` attribute value for a Library upload file-picker. */
export function libraryUploadAcceptAttr(): string {
  return [
    ...LIBRARY_UPLOAD_MIME_PREFIXES.map((p) => `${p}*`),
    ...LIBRARY_UPLOAD_EXTENSIONS,
  ].join(',');
}
