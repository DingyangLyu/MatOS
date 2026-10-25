// Client-side export helpers used by the Share menu in the HTML viewer.
// Export formats run entirely in the browser:
//   - PDF  : open the artifact in a popup window and trigger window.print().
//            The user picks "Save as PDF" from the system print dialog.
//   - HTML : download the artifact as a single .html file via a Blob URL.
//   - ZIP  : pack the artifact with a coding handoff guide (see ./zip.ts).
//   - MD   : download the artifact's source verbatim with a `.md` extension
//            so it can be ingested by markdown-aware tooling (LLM context
//            windows, vault apps, etc.). No conversion is performed — the
//            file content is the same source the Source view shows. See
//            issue #279.

import { buildSrcdoc, type SrcdocOptions } from './srcdoc';
import { buildReactComponentSrcdoc } from './react-component';
import { buildZip } from './zip';
import { randomUUID } from '../utils/uuid';
import {
  captureHostPage,
  isOpenDesignHostAvailable,
  printHostPdf,
} from '@open-design/host';

// Re-exported so app components can gate desktop-only export paths without
// importing the host package directly.
export { isOpenDesignHostAvailable } from '@open-design/host';


function safeFilename(name: string, fallback: string): string {
  const slug = (name || fallback)
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function triggerHrefDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Pulls the attachment filename out of a Content-Disposition header,
// preferring the RFC 5987 UTF-8 form. Returns null when absent so callers
// can fall back to a locally derived name.
function filenameFromContentDisposition(resp: Response): string | null {
  const header = resp.headers.get('content-disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain && plain[1] ? plain[1] : null;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerHrefDownload(url, filename);
  // Revoke later — Safari sometimes hasn't finished reading the blob yet
  // when the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function exportAsHtml(html: string, title: string): void {
  const doc = buildSrcdoc(html);
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, `${safeFilename(title, 'artifact')}.html`);
}

export async function exportProjectAsHtml(opts: {
  projectId: string;
  filePath: string;
  fallbackHtml: string;
  fallbackTitle: string;
}): Promise<void> {
  const segments = opts.filePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `/api/projects/${encodeURIComponent(opts.projectId)}/export/${segments}?inline=1`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`html export request failed (${resp.status})`);
    const blob = await resp.blob();
    triggerDownload(blob, `${safeFilename(opts.fallbackTitle, 'artifact')}.html`);
  } catch (err) {
    console.warn('[exportProjectAsHtml] falling back to source HTML export:', err);
    exportAsHtml(opts.fallbackHtml, opts.fallbackTitle);
  }
}

export function exportAsZip(html: string, title: string): void {
  const doc = buildSrcdoc(html);
  const slug = safeFilename(title, 'artifact');
  const blob = buildZip([
    { path: `${slug}/index.html`, content: doc },
  ]);
  triggerDownload(blob, `${slug}.zip`);
}

export function exportAsMd(source: string, title: string): void {
  // Pass-through download: the file body is the artifact source verbatim,
  // only the extension and Content-Type are flipped to markdown. No
  // HTML→markdown conversion happens here — users who pipe the file into
  // markdown-aware tooling (LLM context windows, vault apps) get the same
  // bytes the Source view displays.
  const blob = new Blob([source], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${safeFilename(title, 'artifact')}.md`);
}

// ---------------------------------------------------------------------------
// Image screenshot export
// ---------------------------------------------------------------------------

/**
 * Request a PNG screenshot of the current viewport from the snapshot bridge
 * injected into a srcdoc preview iframe. Returns null if the bridge is not
 * present (e.g. URL-load mode) or the capture times out.
 */
export type PreviewSnapshot = { dataUrl: string; w: number; h: number };

export type PreviewSnapshotResult =
  | { ok: true; snapshot: PreviewSnapshot }
  | { ok: false; reason: 'loading' | 'post-message-error' | 'render-error' | 'timeout'; error?: string };

export function requestPreviewSnapshotResult(
  iframe: HTMLIFrameElement,
  timeout = 8000,
): Promise<PreviewSnapshotResult> {
  const win = iframe.contentWindow;
  if (!win) return Promise.resolve({ ok: false, reason: 'loading' });
  const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let done = false;
    function onMsg(ev: MessageEvent) {
      if (ev.source !== win) return;
      const d = ev.data as {
        type?: string;
        id?: string;
        dataUrl?: string;
        w?: number;
        h?: number;
        error?: string;
      } | null;
      if (!d || d.type !== 'od:snapshot:result' || d.id !== id) return;
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      if (d.dataUrl && d.w && d.h) resolve({ ok: true, snapshot: { dataUrl: d.dataUrl, w: d.w, h: d.h } });
      else resolve({ ok: false, reason: 'render-error', error: d.error });
    }
    window.addEventListener('message', onMsg);
    try {
      win.postMessage({ type: 'od:snapshot', id }, '*');
    } catch {
      done = true;
      window.removeEventListener('message', onMsg);
      resolve({ ok: false, reason: 'post-message-error' });
    }
    setTimeout(() => {
      if (!done) {
        done = true;
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, reason: 'timeout' });
      }
    }, timeout);
  });
}

export async function requestPreviewSnapshot(
  iframe: HTMLIFrameElement,
  timeout = 8000,
): Promise<PreviewSnapshot | null> {
  const result = await requestPreviewSnapshotResult(iframe, timeout);
  return result.ok ? result.snapshot : null;
}

/**
 * Capture a rectangle of the on-screen window via the desktop host's
 * compositor (Electron `webContents.capturePage`). Unlike the in-iframe
 * SVG-foreignObject bridge, this returns the REAL rendered pixels — fonts,
 * external CSS, gradients, cross-origin images and embedded <webview> content
 * all paint faithfully and the canvas is never tainted, so it cannot produce
 * the black/blank frames the foreignObject path does. Returns null when no
 * desktop host is present (pure web), so callers fall back to the bridge.
 *
 * `clipRect` is in CSS pixels relative to the viewport (e.g. an iframe's
 * getBoundingClientRect()); capturePage expects DIP page coordinates, which
 * match 1:1 for the top-level window (it never scrolls).
 */
export async function captureHostRegionSnapshot(
  clipRect: { left: number; top: number; width: number; height: number } | null,
): Promise<PreviewSnapshot | null> {
  if (!isOpenDesignHostAvailable()) return null;
  const clip = clipRect && clipRect.width >= 1 && clipRect.height >= 1
    ? {
        x: Math.max(0, Math.round(clipRect.left)),
        y: Math.max(0, Math.round(clipRect.top)),
        width: Math.max(1, Math.round(clipRect.width)),
        height: Math.max(1, Math.round(clipRect.height)),
      }
    : undefined;
  try {
    const result = await captureHostPage(clip ? { clip } : undefined);
    if (result.ok && result.dataUrl && result.w >= 1 && result.h >= 1) {
      return { dataUrl: result.dataUrl, w: result.w, h: result.h };
    }
  } catch {
    /* fall through to null so the caller can use the bridge */
  }
  return null;
}

/**
 * Capture an iframe's on-screen region through the desktop compositor.
 * Convenience wrapper over captureHostRegionSnapshot using the iframe's
 * current bounding rect.
 */
export async function captureHostIframeSnapshot(
  iframe: HTMLIFrameElement | null,
): Promise<PreviewSnapshot | null> {
  if (!iframe) return null;
  const rect = iframe.getBoundingClientRect();
  return captureHostRegionSnapshot({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  });
}

/** Convert a data-URL to a Blob without re-encoding through canvas. */
function dataUrlToBlob(dataUrl: string): Blob {
  if (!dataUrl.startsWith('data:')) {
    throw new Error('Invalid data URL');
  }
  const [header, base64] = dataUrl.split(',');
  const mime = header?.match(/:(.*?);/)?.[1] ?? 'image/png';
  const bytes = atob(base64 ?? '');
  if (bytes.length <= 0) {
    throw new Error('Image snapshot is empty');
  }
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

type ClipboardItemCtor = new (
  items: Record<string, Blob | Promise<Blob>>,
) => ClipboardItem;

/**
 * Copy a PNG (or other image) data-URL onto the system clipboard as a real
 * image item, so it can be pasted into the chat composer or any other app.
 * Returns 'copied' on success, 'denied' when the clipboard API is missing or
 * the browser refuses the write for permission/security reasons, and 'failed'
 * for any other error (e.g. a malformed data-URL).
 */
export async function copyImageDataUrlToClipboard(
  dataUrl: string,
): Promise<'copied' | 'denied' | 'failed'> {
  const clipboard = navigator.clipboard;
  const ClipboardItemRef = (globalThis as { ClipboardItem?: ClipboardItemCtor })
    .ClipboardItem;
  if (!clipboard || typeof clipboard.write !== 'function' || !ClipboardItemRef) {
    return 'denied';
  }
  try {
    const blob = dataUrlToBlob(dataUrl);
    // Safari only honours clipboard.write() inside the original user gesture,
    // so prefer the Promise<Blob> ClipboardItem form when supported — it lets
    // the browser resolve the blob lazily without losing the gesture context.
    let item: ClipboardItem;
    try {
      item = new ClipboardItemRef({ [blob.type]: Promise.resolve(blob) });
    } catch {
      item = new ClipboardItemRef({ [blob.type]: blob });
    }
    await clipboard.write([item]);
    return 'copied';
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'denied';
    }
    return 'failed';
  }
}

export type ImageExportFormat = 'png' | 'jpeg' | 'webp';

type ImageExportSpec = {
  extension: string;
  mime: `image/${string}`;
  pickerLabel: string;
};

const IMAGE_EXPORT_SPECS: Record<ImageExportFormat, ImageExportSpec> = {
  png: {
    extension: 'png',
    mime: 'image/png',
    pickerLabel: 'PNG image',
  },
  jpeg: {
    extension: 'jpg',
    mime: 'image/jpeg',
    pickerLabel: 'JPEG image',
  },
  webp: {
    extension: 'webp',
    mime: 'image/webp',
    pickerLabel: 'WebP image',
  },
};

type FileSystemWritableFileStreamLike = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type FileSystemFileHandleLike = {
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
};

type SaveFilePickerOptionsLike = {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
};

type WindowWithSaveFilePicker = Window & {
  showSaveFilePicker?: (options?: SaveFilePickerOptionsLike) => Promise<FileSystemFileHandleLike>;
};

export type ImageExportTarget = {
  filename: string;
  method: 'download' | 'picker';
  save: (blob: Blob) => Promise<void> | void;
};

type ImageExportTargetOptions = {
  useNativePicker?: boolean;
};

function imageExportFilename(title: string, format: ImageExportFormat): string {
  const spec = IMAGE_EXPORT_SPECS[format];
  return `${safeFilename(title, 'artifact')}.${spec.extension}`;
}

function downloadImageExportTarget(filename: string): ImageExportTarget {
  return {
    filename,
    method: 'download',
    save: (blob) => {
      triggerDownload(blob, filename);
    },
  };
}

export function downloadImageDataUrl(dataUrl: string, filename: string): void {
  // Validate the snapshot without converting the actual download path to a blob URL.
  dataUrlToBlob(dataUrl);
  triggerHrefDownload(dataUrl, filename);
}

function isDomExceptionNamed(err: unknown, names: ReadonlySet<string>): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return names.has(err.name);
  }
  if (!err || typeof err !== 'object' || !('name' in err)) return false;
  return typeof err.name === 'string' && names.has(err.name);
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image snapshot'));
    img.src = dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(`Could not encode snapshot as ${mime}`));
        return;
      }
      if (blob.type && blob.type !== mime) {
        reject(new Error(`Browser encoded ${blob.type} instead of ${mime}`));
        return;
      }
      resolve(blob);
    }, mime, quality);
  });
}

export async function imageDataUrlToBlob(
  dataUrl: string,
  format: ImageExportFormat,
): Promise<Blob> {
  const spec = IMAGE_EXPORT_SPECS[format];
  if (format === 'png') {
    const blob = dataUrlToBlob(dataUrl);
    if (blob.type === spec.mime) return blob;
  }

  const img = await loadImageFromDataUrl(dataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (width <= 0 || height <= 0) {
    throw new Error('Image snapshot is empty');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  if (format === 'jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  return canvasToBlob(canvas, spec.mime, format === 'jpeg' ? 0.92 : undefined);
}

export async function prepareImageExportTarget(
  title: string,
  format: ImageExportFormat,
  options: ImageExportTargetOptions = {},
): Promise<ImageExportTarget | null> {
  const spec = IMAGE_EXPORT_SPECS[format];
  const filename = imageExportFilename(title, format);
  const picker = (window as WindowWithSaveFilePicker).showSaveFilePicker;
  if (options.useNativePicker !== false && typeof picker === 'function') {
    try {
      const handle = await picker.call(window, {
        suggestedName: filename,
        types: [
          {
            description: spec.pickerLabel,
            accept: {
              [spec.mime]: [`.${spec.extension}`],
            },
          },
        ],
      });
      return {
        filename,
        method: 'picker',
        save: async (blob) => {
          const writable = await handle.createWritable();
          try {
            await writable.write(blob);
          } finally {
            await writable.close();
          }
        },
      };
    } catch (err) {
      if (isDomExceptionNamed(err, new Set(['AbortError']))) return null;
      if (isDomExceptionNamed(err, new Set(['NotAllowedError', 'SecurityError']))) {
        return downloadImageExportTarget(filename);
      }
      throw err;
    }
  }

  return downloadImageExportTarget(filename);
}

/** Download a snapshot data-URL as a PNG file. */
export function exportAsImage(dataUrl: string, title: string): void {
  try {
    const blob = dataUrlToBlob(dataUrl);
    triggerDownload(blob, `${safeFilename(title, 'artifact')}.png`);
  } catch (err) {
    console.warn('[exportAsImage] failed to convert snapshot:', err);
    // Re-throw the error to allow the caller to handle UI feedback
    throw err;
  }
}

export type ProjectPdfExportResult = 'desktop' | 'fallback' | 'cancelled';

export async function exportProjectAsPdf(opts: {
  deck: boolean;
  fallbackPdf: () => void | Promise<void>;
  filePath: string;
  projectId: string;
  title: string;
}): Promise<ProjectPdfExportResult> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(opts.projectId)}/export/pdf`, {
      body: JSON.stringify({
        deck: opts.deck,
        fileName: opts.filePath,
        title: opts.title,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (!resp.ok) throw new Error(`desktop PDF export unavailable (${resp.status})`);
    const body = await resp.json().catch(() => ({}));
    if (body?.canceled === true) return 'cancelled';
    if (body && body.ok === false) throw new Error(body.error || 'desktop PDF export failed');
    return 'desktop';
  } catch (err) {
    console.warn('[exportProjectAsPdf] falling back to programmatic PDF:', err);
    await opts.fallbackPdf();
    return 'fallback';
  }
}

type ReactSourceExtension = '.jsx' | '.tsx';

export function exportAsJsx(
  source: string,
  title: string,
  extension: ReactSourceExtension = '.jsx',
): void {
  const blob = new Blob([source], { type: 'text/jsx;charset=utf-8' });
  triggerDownload(blob, `${safeFilename(title, 'component')}${extension}`);
}

export function exportReactComponentAsHtml(source: string, title: string): void {
  const doc = buildReactComponentSrcdoc(source, { title });
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, `${safeFilename(title, 'component')}.html`);
}

export function exportReactComponentAsZip(
  source: string,
  title: string,
  extension: ReactSourceExtension = '.jsx',
): void {
  const slug = safeFilename(title, 'component');
  const componentFile = `${slug}${extension}`;
  const blob = buildZip([
    { path: `${slug}/${componentFile}`, content: source },
  ]);
  triggerDownload(blob, `${slug}.zip`);
}

// Tri-state, mirroring exportProjectImageDataUrl: callers must distinguish a
// genuinely-unavailable off-screen renderer (no desktop host / 501 / transport
// failure) — where falling back to the vector/browser PDF is correct — from a
// SEMANTIC export failure (bad deck routing, unreadable renderer output, a
// renderer-side 502, "page too tall", …), which must be surfaced rather than
// silently masked by the old vector path (which can reintroduce the CJK-glyph /
// fidelity bugs this screenshot path exists to avoid).
export type ProjectScreenshotExportResult =
  | { ok: true }
  | { ok: false; unavailable: true }
  | { ok: false; error: string };

// Programmatic screenshot-based PPTX export. POSTs to the daemon, which renders
// each deck slide to a pixel-perfect PNG (via the desktop's Electron Chromium)
// and assembles a one-image-per-slide .pptx, then streams the bytes back for a
// blob download. Replaces the old "send a prompt and let the agent run
// python-pptx" path. `format: 'pdf'` produces the raster (screenshot) PDF.
export async function exportProjectAsPptx(opts: {
  projectId: string;
  fileName: string;
  title?: string;
  format?: 'pptx' | 'pdf';
  deck?: boolean;
  // pptx only: produce an editable deck (native shapes/text) instead of a
  // screenshot one (one image per slide).
  editable?: boolean;
}): Promise<ProjectScreenshotExportResult> {
  const format = opts.format ?? 'pptx';
  const path = format === 'pdf' ? 'export/pdf-image' : 'export/pptx';
  const url = `/api/projects/${encodeURIComponent(opts.projectId)}/${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: opts.fileName,
        ...(opts.title ? { title: opts.title } : {}),
        ...(format === 'pptx'
          ? { deck: true, ...(opts.editable ? { editable: true } : {}) }
          : typeof opts.deck === 'boolean'
            ? { deck: opts.deck }
            : {}),
      }),
    });
  } catch {
    // Transport-level failure (offline, daemon down) — genuinely unavailable, so
    // the caller may fall back to the vector/browser PDF.
    return { ok: false, unavailable: true };
  }
  if (!resp.ok) {
    // 501 = this runtime has no off-screen renderer → caller may fall back to
    // the vector/browser PDF. Everything else is a real (semantic) failure that
    // must surface, not be masked by the vector path.
    if (resp.status === 501) return { ok: false, unavailable: true };
    let message = `export request failed (${resp.status})`;
    try {
      const err = await resp.json();
      if (err?.error?.message) message = String(err.error.message);
    } catch {
      // non-JSON error body; keep the status-based message
    }
    return { ok: false, error: message };
  }
  // The renderer already produced bytes — a failure reading the body or
  // triggering the download is a real (post-response) export failure, NOT
  // "renderer unavailable". Returning `error` (not `unavailable`) keeps the
  // caller from silently downgrading to the lower-fidelity vector path.
  try {
    const blob = await resp.blob();
    const base = opts.fileName.replace(/^.*\//, '').replace(/\.html?$/i, '');
    const slug = safeFilename(opts.title || base, 'deck');
    const fromHeader = filenameFromContentDisposition(resp);
    triggerDownload(blob, fromHeader || `${slug}.${format}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'export download failed' };
  }
}

// Whether an HTML artifact carries a structured deck runtime for EXPORT
// purposes, beyond explicit project/file metadata. Runtime-managed decks render
// slides through a custom element (e.g. `<deck-stage>` with slotted
// `<section data-screen-label="...">` children toggled via `data-deck-active`)
// and can carry no literal `class="slide"`, so metadata-only checks can miss
// them. Older html-ppt templates use `.slide` together with deck-specific
// structure such as `data-title` or a `.deck` wrapper. Deliberately DO NOT treat
// a plain `.slide` class as proof of a deck: ordinary pages often use that token
// for carousels/testimonials and still need full-page/scroll-stitch capture.
export function sourceLooksLikeExportableDeck(source: string | null | undefined): boolean {
  if (!source) return false;
  return (
    /<deck-stage[\s/>]|\bdata-screen-label\s*=|class\s*=\s*['"](?:[^'"]*\s)?(?:deck-slide|ppt-slide)(?:\s|['"])/i.test(
      source,
    ) ||
    /<[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])[^>]*\bdata-title\s*=|<[^>]*\bdata-title\s*=[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])/i.test(
      source,
    ) ||
    /<[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?deck(?:\s|['"])[^>]*>\s*<[^>]*\bclass\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])/i.test(
      source,
    )
  );
}

// Decides how a current-slide / whole-deck / page image capture should run.
// The off-screen renderer needs a concrete slide `index` for a CURRENT-slide
// capture (Copy screenshot / annotation), but we only know the active slide when
// the viewer tracks it (`trackedActive`). Runtime-managed decks (`<deck-stage>` /
// `data-screen-label`) are deliberately kept out of the viewer's nav signal, so
// they have no active-slide bridge (`trackedActive === null`); a current-slide
// off-screen render would then always grab slide 0, exporting slide 1 instead of
// the slide on screen. For that case the caller must skip the off-screen path and
// use the visible host snapshot (which IS the current slide). Whole-deck (Export
// as image, omits index → stitches all), ordinary pages, and tracked `.slide`
// decks still use the off-screen renderer.
export function planDeckImageCapture(opts: {
  deck: boolean;
  wholeDeck: boolean;
  trackedActive: number | null;
}): { useOffscreen: boolean; index: number | undefined } {
  // Export as image: the whole page / whole deck, off-screen and
  // viewport-independent.
  if (opts.wholeDeck) return { useOffscreen: true, index: undefined };
  // A current-view capture (Copy screenshot / annotation) must stay
  // viewport-based: an ordinary page uses the visible host snapshot, NOT an
  // off-screen full-page render (which would copy the whole document instead of
  // what the user is looking at, and break captureViewport annotations). A deck
  // current-slide uses the off-screen renderer at the active slide ONLY when the
  // viewer tracks it; a runtime-managed deck with no tracked active slide also
  // falls back to the visible snapshot (we can't tell which slide it's on).
  if (!opts.deck || opts.trackedActive === null) return { useOffscreen: false, index: undefined };
  return { useOffscreen: true, index: opts.trackedActive };
}

// Programmatic image export: render a single pixel-perfect PNG via the daemon
// (off-screen Electron Chromium), independent of the preview pane size. For a
// deck pass the current slide `index` (Copy screenshot); omit it to stitch the
// WHOLE deck top-to-bottom into one long image (Export as image) or to capture an
// ordinary page at natural size. Returns a {dataUrl,w,h} snapshot compatible with
// the existing image-export pipeline, or null if unavailable.
// Discriminates a genuinely-unavailable off-screen renderer (no desktop host /
// 501 / network) — where the caller may fall back to a visible-preview capture —
// from a SEMANTIC export failure (e.g. "page is too tall — export as PDF"), which
// must be surfaced rather than silently downgraded to a partial viewport shot.
export type ProjectImageExportResult =
  | { ok: true; snapshot: PreviewSnapshot }
  | { ok: false; unavailable: true }
  | { ok: false; error: string };

export async function exportProjectImageDataUrl(opts: {
  projectId: string;
  fileName: string;
  index?: number;
  deck?: boolean;
}): Promise<ProjectImageExportResult> {
  const url = `/api/projects/${encodeURIComponent(opts.projectId)}/export/image`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: opts.fileName,
        ...(typeof opts.index === 'number' ? { index: opts.index } : {}),
        ...(typeof opts.deck === 'boolean' ? { deck: opts.deck } : {}),
      }),
    });
  } catch {
    // Transport-level failure (offline, daemon down) — genuinely unavailable, so
    // the caller may fall back to a visible-preview capture.
    return { ok: false, unavailable: true };
  }
  if (!resp.ok) {
    // 501 = this runtime has no off-screen renderer → caller may fall back.
    if (resp.status === 501) return { ok: false, unavailable: true };
    let message = `image export failed (${resp.status})`;
    try {
      const err = await resp.json();
      if (err?.error?.message) message = String(err.error.message);
    } catch {
      // non-JSON body; keep the status-based message
    }
    return { ok: false, error: message };
  }
  // A 200 with an unreadable/corrupt payload is a real export failure, NOT
  // "renderer unavailable" — surface it instead of silently downgrading to the
  // viewport screenshot.
  try {
    const blob = await resp.blob();
    const dataUrl = await blobToDataUrl(blob);
    const img = await loadImageFromDataUrl(dataUrl);
    return { ok: true, snapshot: { dataUrl, w: img.naturalWidth, h: img.naturalHeight } };
  } catch {
    return { ok: false, error: 'image export returned an unreadable response' };
  }
}

// Pixel-perfect screenshot PDF (one raster page per deck slide, or the whole
// page for a website) via the same off-screen renderer as image/PPTX. Used as
// the default UI PDF because Chromium's vector printToPDF drops CJK glyphs in
// the packaged runtime.
export function exportProjectScreenshotPdf(opts: {
  projectId: string;
  fileName: string;
  title?: string;
  deck?: boolean;
}): Promise<ProjectScreenshotExportResult> {
  return exportProjectAsPptx({ ...opts, format: 'pdf' });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}


function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Blob documents inherit the origin of the page that created them. For
// generated preview HTML, opening the artifact itself as the top-level Blob
// document would bypass the preview contract: the untrusted code must run in
// an iframe sandbox without `allow-same-origin`. This wrapper is same-origin,
// but it contains no generated script; the generated document lives in an
// opaque-origin child.
export function buildSandboxedPreviewDocument(
  doc: string,
  title: string,
  opts?: { allowModals?: boolean },
): string {
  const safeTitle = escapeHtmlAttribute(title || 'Preview');
  const sandbox = opts?.allowModals ? 'allow-scripts allow-modals' : 'allow-scripts';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden;background:#fff}</style>
</head>
<body>
  <iframe title="${safeTitle}" sandbox="${sandbox}" srcdoc="${escapeHtmlAttribute(doc)}"></iframe>
</body>
</html>`;
}

function currentOriginBaseHref(): string | undefined {
  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
    return `${window.location.origin.replace(/\/+$/, '')}/`;
  }
  const base =
    typeof document !== 'undefined' && typeof document.baseURI === 'string'
      ? document.baseURI
      : typeof window !== 'undefined' && typeof window.location?.href === 'string'
        ? window.location.href
        : undefined;
  if (!base) return undefined;
  try {
    return new URL('/', base).href;
  } catch {
    return undefined;
  }
}

function buildBlobSafeSrcdoc(html: string, options?: SrcdocOptions): string {
  const baseHref =
    typeof options?.baseHref === 'string' ? options.baseHref : currentOriginBaseHref();
  return buildSrcdoc(html, {
    ...options,
    ...(baseHref ? { baseHref } : {}),
  });
}

export function openSandboxedPreviewInNewTab(
  html: string,
  title: string,
  srcdocOptions?: SrcdocOptions,
): void {
  const doc = buildSandboxedPreviewDocument(buildBlobSafeSrcdoc(html, srcdocOptions), title);
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Open the artifact in a new tab via a Blob URL with a self-printing
// script injected. Going through a Blob URL (rather than `window.open('')`
// + `document.write`) avoids two failure modes we hit before:
//   - `noopener` makes `window.open` return null, leaving an empty popup
//     and triggering a duplicate fallback tab.
//   - Cross-document writes are flaky in some browsers and don't always
//     fire load events the way an inline script tied to the document does.
// The injected script also sets the document title so "Save as PDF" picks
// a sensible default filename.
//
// `deck: true` injects an extra print stylesheet that lays every `.slide`
// section out one-per-page top-to-bottom. The deck framework already ships
// equivalent print rules; this is a safety net for older / partially
// regenerated decks where the framework was stripped — without it,
// horizontal-snap decks print only the visible slide.
export async function exportAsPdf(
  html: string,
  title: string,
  opts?: SrcdocOptions & { sandboxedPreview?: boolean; onProgress?: ExportProgress },
): Promise<void> {
  const sandboxedPreview = opts?.sandboxedPreview ?? true;
  // Generate a per-export nonce so the print-ready handshake is resistant to
  // spoofing by untrusted scripts inside the exported artifact.
  const nonce = randomUUID();
  let doc = buildBlobSafeSrcdoc(html, opts);
  if (opts?.deck) doc = injectDeckPrintStylesheet(doc);
  doc = injectPrintReadyHandshake(doc, nonce);

  // Desktop native PDF bridge — the main process runs a direct
  // Save-as-PDF flow: a native Save dialog, then Electron's
  // webContents.printToPDF() straight to the chosen file (issue #1774;
  // see apps/desktop/src/main/pdf-export.ts). The sandboxed wrapper
  // omits allow-modals here because the native flow never calls
  // window.print(); granting it would let untrusted artifact code call
  // alert()/confirm() and stall the hidden Electron window indefinitely.
  if (isOpenDesignHostAvailable()) {
    if (sandboxedPreview) {
      doc = buildSandboxedPreviewDocument(doc, title);
    }
    doc = injectParentPrintReadyCache(doc, nonce);
    try {
      const result = await printHostPdf(doc, nonce, opts?.deck ? { deck: true } : undefined);
      if (result.ok) return;
      if (typeof alert !== 'undefined') {
        alert('Print failed. Please try Export PDF again or use the browser version.');
      }
    } catch {
      if (typeof alert !== 'undefined') {
        alert('Print failed. Please try Export PDF again or use the browser version.');
      }
    }
    return;
  }

  // Browser fallback (pure web): assemble the PDF programmatically — capture
  // each slide (deck) or the full page through the export-capture bridge, then
  // build it with jsPDF. No print dialog, no agent. The window.print() popup
  // below is kept only as a last-resort fallback if the capture path throws.
  try {
    await exportArtifactAsPdf(html, title, { deck: !!opts?.deck, onProgress: opts?.onProgress });
    return;
  } catch (err) {
    console.warn('[exportAsPdf] programmatic PDF failed, falling back to print popup:', err);
  }

  // Last-resort: wrap with allow-modals so the injected script can call
  // window.print(), then inject the self-printing script and open a popup.
  if (sandboxedPreview) {
    doc = buildSandboxedPreviewDocument(doc, title, { allowModals: true });
  }
  // Even in the non-sandboxed browser fallback we keep the same readiness
  // cache contract as the desktop bridge so the popup can wait for actual
  // rendered content instead of printing after a blind fixed delay.
  doc = injectParentPrintReadyCache(doc, nonce);
  doc = injectPrintScript(doc, title);

  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  // Open an empty tab synchronously (without noopener) to reliably detect popup blocking.
  // Since window.open with 'noopener' returns null on success by specification,
  // this approach allows us to distinguish between a successful export and a blocked popup.
  const win = window.open('', '_blank');

  if (!win) {
    if (typeof alert !== 'undefined') {
      alert('Popup blocked! Click the popup-blocked icon in your browser address bar (or browser menu), choose "Always allow pop-ups" for this site, then retry Export PDF.');
    }
    URL.revokeObjectURL(url);
    return;
  }

  if (sandboxedPreview) {
    try {
      win.opener = null;
    } catch (e) {
      // Guard against potential context environment restrictions
    }
  }

  // Navigate the verified window to the generated Blob URL then release
  // the Blob URL after the tab has had time to start loading it.
  win.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A reported print size is only usable when both dimensions are positive,
 * finite numbers. The desktop bridge (apps/desktop/src/main/pdf-export.ts
 * inferPageSize) sizes the PDF page to this; a zero/invalid size makes it
 * fall back to measuring the wrapper viewport, which — per that function's
 * own docs — blanks artifacts whose visible content sits below the fold.
 * Exported so the injected handshake/cache scripts and unit tests share one
 * definition. See issue #4458.
 */
export function isUsablePrintSize(width: unknown, height: unknown): boolean {
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

/**
 * Poll `measure` once per animation frame until it returns a usable
 * (positive, finite) size, then call `report` with it. Bounded by
 * `maxFrames`: a genuinely empty artifact never gains a usable size, so the
 * last measurement is reported best-effort rather than hanging the desktop
 * readiness handshake forever.
 *
 * This fixes one #4458 blank-PDF path: the in-iframe handshake used to
 * report the content size after a fixed two animation frames, which can fire
 * before a heavier artifact has finished layout (size still 0). The desktop
 * bridge then has no usable `__odPrintSize`, falls back to the wrapper
 * viewport, and prints a blank page. Waiting for a non-zero size avoids that.
 *
 * Injected into the handshake via `toString()`; the function is self-contained
 * (no references to other module symbols) so production minification cannot
 * break the injected copy. The `raf` seam keeps it unit-testable.
 */
export function reportPrintSizeWhenStable(
  measure: () => { width: number; height: number },
  report: (size: { width: number; height: number }) => void,
  maxFrames: number,
  raf: (cb: () => void) => void = (cb) => requestAnimationFrame(() => cb()),
): void {
  const usable = (w: number, h: number): boolean =>
    typeof w === 'number' &&
    typeof h === 'number' &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0;
  const step = (remaining: number): void => {
    const size = measure();
    if (usable(size.width, size.height) || remaining <= 0) {
      report(size);
      return;
    }
    raf(() => step(remaining - 1));
  };
  step(maxFrames);
}

function injectPrintScript(doc: string, title: string): string {
  const safeTitle = JSON.stringify(title || 'artifact');
  // Browser fallback PDF export shares the same print-readiness signal as the
  // desktop native path. When the cache is present, wait for it so the popup
  // prints only after fonts, images, CSS image URLs, and final layout have
  // settled. If the handshake script is blocked entirely (for example by a
  // CSP that forbids inline scripts), fall back to the historical load+delay
  // behavior instead of waiting for the full ready deadline.
  const script = `<script>(function(){try{document.title=${safeTitle}}catch(e){}function doPrint(){try{window.focus();window.print()}catch(e){}}function afterStableFrames(fn){requestAnimationFrame(function(){requestAnimationFrame(fn)})}window.addEventListener('load',function(){if(typeof window.__odPrintReady!=='boolean'){setTimeout(doPrint,300);return}var deadline=Date.now()+30000;var handshakeStartDeadline=Date.now()+1000;(function waitForReady(){if(window.__odPrintReady===true){afterStableFrames(doPrint);return}if(window.__odPrintReadyStarted===false&&Date.now()>=handshakeStartDeadline){setTimeout(doPrint,300);return}if(Date.now()>=deadline){afterStableFrames(doPrint);return}setTimeout(waitForReady,50)})()})})();</script>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${script}</head>`);
  if (/<\/body>/i.test(doc)) return doc.replace(/<\/body>/i, `${script}</body>`);
  return doc + script;
}

function injectPrintReadyHandshake(doc: string, nonce: string): string {
  // Wait for fonts, the window load event (which covers initial images), and
  // any images that are still loading after load fires (dynamically added or
  // slow images that weren't complete by the time this script ran). Also wait
  // for CSS image URLs and two animation frames so background/list/border
  // images and final layout are settled before the desktop bridge prints.
  // This mirrors the safety of the legacy waitForPrintableContent() helper and
  // prevents image-heavy exports from printing with blank images.
  //
  // Once settled, the message also carries the artifact's own content
  // dimensions (scroll/offset size of its documentElement). This script runs
  // inside the sandboxed preview iframe, which the parent wrapper cannot
  // measure directly (sandbox="allow-scripts" has no allow-same-origin, so
  // iframe.contentDocument is null). Reporting the size from here lets the
  // desktop bridge size the PDF page to the real content instead of the
  // wrapper's viewport, which otherwise clips — or blanks — taller artifacts
  // (issue #4067). The parent caches it via injectParentPrintReadyCache and
  // inferPageSize() in apps/desktop/src/main/pdf-export.ts consumes it.
  //
  // The nonce is a per-export random UUID that verifies the readiness signal
  // came from our injected handshake, not a spoofed message from untrusted
  // artifact code.
  const script = `<script data-od-print-ready>(function(){window.parent.postMessage({type:'OD_PRINT_READY_STARTED',nonce:'${nonce}'},'*');function waitForImages(){var imgs=Array.from(document.images).filter(function(img){if(img.loading==='lazy')img.loading='eager';return !img.complete});return Promise.all(imgs.map(function(img){return new Promise(function(r){img.addEventListener('load',r,{once:true});img.addEventListener('error',r,{once:true});if(img.complete)r()})}))}function cssUrlValues(value){var urls=[];if(!value||value==='none')return urls;value.replace(/url\\((['"]?)(.*?)\\1\\)/g,function(_,q,rawUrl){if(rawUrl&&!/^data:/i.test(rawUrl))urls.push(rawUrl);return''});return urls}function waitForCssBackgroundImages(){var urls=new Set();Array.from(document.querySelectorAll('*')).forEach(function(el){var style=window.getComputedStyle(el);cssUrlValues(style.backgroundImage).forEach(function(url){urls.add(url)});cssUrlValues(style.borderImageSource).forEach(function(url){urls.add(url)});cssUrlValues(style.listStyleImage).forEach(function(url){urls.add(url)})});return Promise.all(Array.from(urls).map(function(url){return new Promise(function(r){var img=new Image();img.onload=r;img.onerror=r;img.src=url})}))}function nextFrame(){return new Promise(function(r){requestAnimationFrame(function(){r(true)})})}Promise.all([document.fonts&&document.fonts.ready?document.fonts.ready.catch(function(){}):Promise.resolve(),new Promise(function(r){if(document.readyState==='complete')r();else window.addEventListener('load',r,{once:true})})]).then(function(){return Promise.all([waitForImages(),waitForCssBackgroundImages()])}).then(nextFrame).then(nextFrame).then(function(){var __odReport=${reportPrintSizeWhenStable.toString()};function measure(){var de=document.documentElement;var b=document.body||de;return {width:Math.max(de.scrollWidth,b.scrollWidth,de.offsetWidth,b.offsetWidth),height:Math.max(de.scrollHeight,b.scrollHeight,de.offsetHeight,b.offsetHeight)}}__odReport(measure,function(size){window.parent.postMessage({type:'OD_PRINT_READY',nonce:'${nonce}',width:size.width,height:size.height},'*')},30)})})();<\/script>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${script}</head>`);
  if (/<\/body>/i.test(doc)) return doc.replace(/<\/body>/i, `${script}</body>`);
  return doc + script;
}

function injectParentPrintReadyCache(doc: string, nonce: string): string {
  // Cache the readiness flag and the content size the artifact reports through
  // the handshake. window.__odPrintSize is read by inferPageSize() in
  // apps/desktop/src/main/pdf-export.ts to size the PDF page to the real
  // artifact rather than the wrapper viewport (issue #4067). Width/height are
  // validated as positive finite numbers so a malformed message cannot poison
  // the page size; the nonce + source check keep untrusted frames from spoofing
  // either signal. window.__odPrintReadyStarted distinguishes a live handshake
  // from a CSP-blocked one so the browser fallback can preserve the historical
  // quick print path when the inner script never runs.
  const script = `<script>window.__odPrintReady=false;window.__odPrintReadyStarted=false;window.__odPrintSize=null;var __odUsable=${isUsablePrintSize.toString()};window.addEventListener('message',function(e){if(e.data&&e.data.nonce==='${nonce}'&&(e.source===window||(window.frames&&e.source===window.frames[0]))){if(e.data.type==='OD_PRINT_READY_STARTED'){window.__odPrintReadyStarted=true;return}if(e.data.type==='OD_PRINT_READY'){window.__odPrintReady=true;if(__odUsable(e.data.width,e.data.height))window.__odPrintSize={width:e.data.width,height:e.data.height}}}});<\/script>`;
  if (/<head>/i.test(doc)) return doc.replace(/<head>/i, `<head>${script}`);
  return script + doc;
}

// Stitches every .slide into a vertical multi-page PDF: 1920×1080 per page,
// no margins, scroll-snap and horizontal flex disabled. `!important` guards
// override skill-specific styles that pin the deck to `display: flex` /
// `overflow: hidden` for on-screen swiping.
const DECK_PRINT_CSS = `
@media print {
  @page { size: 1920px 1080px; margin: 0; }
  html, body {
    width: 1920px !important;
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }
  body {
    display: block !important;
    scroll-snap-type: none !important;
    transform: none !important;
  }
  .slide, [data-screen-label], section.slide, .deck-slide, .ppt-slide {
    flex: none !important;
    width: 1920px !important;
    height: 1080px !important;
    min-height: 1080px !important;
    max-height: 1080px !important;
    page-break-after: always;
    break-after: page;
    scroll-snap-align: none !important;
    transform: none !important;
    position: relative !important;
    overflow: hidden !important;
    /* Decks commonly show one slide at a time via opacity; without this the
       inactive slides print as blank pages. Force every slide visible (and
       freeze entrance animations) so each becomes a real page. */
    opacity: 1 !important;
    visibility: visible !important;
    animation: none !important;
    transition: none !important;
  }
  .slide:last-child, [data-screen-label]:last-child { page-break-after: auto; break-after: auto; }
  .deck-counter, .deck-hint, .deck-nav,
  [aria-label="Previous slide"], [aria-label="Next slide"] {
    display: none !important;
  }
}
`;

function injectDeckPrintStylesheet(doc: string): string {
  const tag = `<style data-deck-print="injected">${DECK_PRINT_CSS}</style>`;
  if (/<\/head>/i.test(doc)) return doc.replace(/<\/head>/i, `${tag}</head>`);
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  return tag + doc;
}

// ===========================================================================
// Programmatic client-side capture + PDF assembly.
//
// The in-iframe capture half lives in ./srcdoc.ts (injectExportCaptureBridge).
// Here we drive it: spin up a hidden, full-resolution export iframe, collect
// one image per slide, then assemble the output with jsPDF — entirely in the
// browser, with no print dialog and no agent/model call. The library is
// dynamically imported so it stays out of the
// main bundle until an export actually runs.
// ===========================================================================

export type CapturedSlide = {
  index: number;
  dataUrl?: string;
  w: number;
  h: number;
  notes?: string;
};

/** Progress callback: `(slidesDone, totalSlides)`. */
export type ExportProgress = (done: number, total: number) => void;

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForIframeWindow(iframe: HTMLIFrameElement, timeout = 15_000): Promise<Window> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const win = iframe.contentWindow;
      if (win) resolve(win);
      else reject(new Error('export iframe window unavailable'));
    };
    const timer = setTimeout(finish, timeout);
    iframe.addEventListener('load', finish, { once: true });
  });
}

type CaptureRequest = {
  id: string;
  mode: 'image';
  deck: boolean;
  single?: boolean;
  delay: number;
};

/**
 * Drive the in-iframe export-capture bridge for one window, invoking `onSlide`
 * for each captured slide. Resolves on the bridge's `done`, rejects on its
 * `error` or an inactivity timeout (so a wedged capture never hangs forever).
 */
function runExportCapture(
  win: Window,
  req: CaptureRequest,
  onSlide: (slide: CapturedSlide, total: number) => void,
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let lastActivity = Date.now();
    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      clearInterval(watchdog);
    };
    function onMsg(ev: MessageEvent) {
      if (ev.source !== win) return;
      const d = ev.data as {
        type?: string; id?: string; index?: number; total?: number;
        dataUrl?: string; w?: number; h?: number;
        notes?: string; error?: string;
      } | null;
      if (!d || d.id !== req.id) return;
      if (d.type === 'od:export-capture:slide') {
        lastActivity = Date.now();
        onSlide(
          {
            index: d.index ?? 0,
            dataUrl: d.dataUrl,
            w: d.w ?? 0,
            h: d.h ?? 0,
            notes: typeof d.notes === 'string' ? d.notes : '',
          },
          d.total ?? 1,
        );
      } else if (d.type === 'od:export-capture:done') {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      } else if (d.type === 'od:export-capture:error') {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(String(d.error || 'export capture failed')));
      }
    }
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > timeoutMs) {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error('export capture timed out'));
      }
    }, 2_000);
    window.addEventListener('message', onMsg);
    try {
      win.postMessage({ type: 'od:export-capture', ...req }, '*');
    } catch (err) {
      finished = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Capture every slide of a deck (or the full page, for a non-deck artifact) by
 * rendering the HTML in a hidden, full-resolution export iframe and driving the
 * export-capture bridge. Returns the slides ordered by index.
 */
async function captureArtifactSlides(
  html: string,
  opts: {
    deck: boolean;
    mode: 'image';
    width?: number;
    height?: number;
    onProgress?: ExportProgress;
  },
): Promise<CapturedSlide[]> {
  const width = opts.width ?? (opts.deck ? 1920 : 1440);
  const height = opts.height ?? (opts.deck ? 1080 : 900);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;border:0;background:#fff;`;
  iframe.srcdoc = buildSrcdoc(html, { deck: opts.deck });
  document.body.appendChild(iframe);

  const slides: CapturedSlide[] = [];
  try {
    const win = await waitForIframeWindow(iframe);
    // Give the deck bridge time to fit fixed-canvas (transform: scale) layouts
    // to the iframe before the first capture.
    await delayMs(opts.deck ? 600 : 150);
    await runExportCapture(
      win,
      {
        id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: opts.mode,
        deck: opts.deck,
        delay: 350,
      },
      (slide, total) => {
        slides.push(slide);
        opts.onProgress?.(slides.length, total);
      },
      45_000,
    );
  } finally {
    iframe.remove();
  }
  slides.sort((a, b) => a.index - b.index);
  return slides;
}

/** Programmatic, client-side PDF: image-per-slide (deck) or paginated full page. */
export async function exportArtifactAsPdf(
  html: string,
  title: string,
  opts: { deck: boolean; onProgress?: ExportProgress },
): Promise<void> {
  const slides = await captureArtifactSlides(html, {
    deck: opts.deck,
    mode: 'image',
    onProgress: opts.onProgress,
  });
  const images = slides.filter((s) => s.dataUrl && s.w > 0 && s.h > 0);
  if (!images.length) throw new Error('Nothing was captured for PDF export');

  const { jsPDF } = await import('jspdf');
  const filename = `${safeFilename(title, 'artifact')}.pdf`;

  if (opts.deck) {
    const first = images[0]!;
    const pdf = new jsPDF({
      orientation: first.w >= first.h ? 'landscape' : 'portrait',
      unit: 'px',
      format: [first.w, first.h],
      compress: true,
    });
    images.forEach((s, i) => {
      if (i > 0) pdf.addPage([s.w, s.h], s.w >= s.h ? 'landscape' : 'portrait');
      pdf.addImage(s.dataUrl!, 'PNG', 0, 0, s.w, s.h);
    });
    triggerDownload(pdf.output('blob'), filename);
    return;
  }

  // Non-deck: slice the tall full-page capture into A4-proportioned pages.
  const img = images[0]!;
  const pageW = img.w;
  const pageH = Math.max(1, Math.round(pageW * Math.SQRT2)); // A4 portrait ≈ 1:1.414
  const pages = Math.max(1, Math.ceil(img.h / pageH));
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [pageW, pageH], compress: true });
  for (let p = 0; p < pages; p++) {
    if (p > 0) pdf.addPage([pageW, pageH], 'portrait');
    pdf.addImage(img.dataUrl!, 'PNG', 0, -p * pageH, img.w, img.h);
  }
  triggerDownload(pdf.output('blob'), filename);
}

export function archiveFilenameFrom(resp: Response, fallbackTitle: string, root: string): string {
  const header = resp.headers.get('content-disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through to the legacy filename= or local fallback
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  if (plain && plain[1]) return plain[1];
  const slug = safeFilename(root || fallbackTitle, 'project');
  return `${slug}.zip`;
}
