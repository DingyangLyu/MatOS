// pdf.js page renderer for project PDF files.
//
// Replaces the browser-native PDF iframe so scroll position and zoom survive
// reloads, which an iframe reload cannot guarantee.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { useT } from '../i18n';
import styles from './PdfViewer.module.css';

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsModulePromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist')
      .then((pdfjs) => {
        try {
          pdfjs.GlobalWorkerOptions.workerPort = new Worker(
            new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
            { type: 'module' },
          );
        } catch {
          // No bundler worker support: pdf.js falls back to its inline "fake
          // worker" (slower, still correct).
        }
        return pdfjs;
      })
      .catch((err: unknown) => {
        // A transient chunk-load failure (offline blip mid-session) must not
        // stay cached forever — that would brick every PDF preview until a
        // full page reload. Drop the memo so the next render retries.
        pdfjsModulePromise = null;
        throw err;
      });
  }
  return pdfjsModulePromise;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PAGE_GAP_PX = 12;
const FIT_PADDING_PX = 28;

export function PdfViewer({
  src,
}: {
  /** Raw PDF URL; change (including cache-bust query) triggers a reload. */
  src: string;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  // Cleanup goes through the loading task (v6 typings drop doc.destroy()).
  const loadingTaskRef = useRef<{ destroy: () => Promise<void> } | null>(null);
  // null zoom = fit-width (recomputed on container resize).
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const scrollKeepRef = useRef(0);
  const baseWidthRef = useRef(612); // US Letter fallback until page 1 loads

  const scale = zoom ?? fitScale;

  // Load / reload the document. Preserve the scroll offset across reloads so
  // a recompile does not yank the reader back to page 1.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    scrollKeepRef.current = containerRef.current?.scrollTop ?? 0;
    void (async () => {
      // Held outside the try so the catch can destroy it: a loading task
      // whose promise rejected (404 PDF, truncated write) still owns
      // worker-side resources, and repeated failed reloads would leak them.
      let task: ReturnType<PdfjsModule['getDocument']> | null = null;
      try {
        const pdfjs = await loadPdfjs();
        task = pdfjs.getDocument({ url: src });
        const next = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        const first = await next.getPage(1);
        if (cancelled) {
          void task.destroy();
          return;
        }
        baseWidthRef.current = first.getViewport({ scale: 1 }).width;
        setError(null);
        const previousTask = loadingTaskRef.current;
        loadingTaskRef.current = task;
        if (previousTask) void previousTask.destroy().catch(() => undefined);
        setDoc(next);
      } catch (err) {
        if (task && loadingTaskRef.current !== task) {
          void task.destroy().catch(() => undefined);
        }
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, retry]);

  useEffect(() => () => {
    void loadingTaskRef.current?.destroy().catch(() => undefined);
  }, []);

  // Fit-width scale follows the pane size.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const compute = () => {
      const width = container.clientWidth - FIT_PADDING_PX;
      if (width > 50) setFitScale(width / baseWidthRef.current);
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [doc]);

  // Render every page at the current scale. Papers are small enough that
  // rendering all pages beats bookkeeping a virtualization window.
  useEffect(() => {
    const host = pagesRef.current;
    const container = containerRef.current;
    if (!doc || !host || !container) return;
    let cancelled = false;
    const tasks: Array<{ cancel: () => void }> = [];
    // Zoom re-renders rebuild the page stack; keep the reading position by
    // restoring the proportional scroll offset (content height changes with
    // scale, so the absolute scrollTop would land elsewhere).
    const previousRange = Math.max(1, container.scrollHeight - container.clientHeight);
    const previousRatio = container.scrollTop / previousRange;
    // The whole pass is best-effort: a reload can destroy this document
    // mid-loop (getPage/render then reject), which must not surface as an
    // unhandled rejection — the effect for the fresh document rebuilds.
    void (async () => {
      host.textContent = '';
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        if (cancelled) return;
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const wrapper = document.createElement('div');
        wrapper.className = styles.page ?? 'latex-pdf-page';
        wrapper.dataset.page = String(pageNumber);
        wrapper.style.width = `${Math.floor(viewport.width)}px`;
        wrapper.style.height = `${Math.floor(viewport.height)}px`;
        wrapper.style.marginBottom = `${PAGE_GAP_PX}px`;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        wrapper.appendChild(canvas);
        host.appendChild(wrapper);
        const context = canvas.getContext('2d');
        if (!context) continue;
        const task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        } as Parameters<typeof page.render>[0]);
        tasks.push(task);
        try {
          await task.promise;
        } catch {
          // Cancelled mid-render (zoom change / reload) — expected.
        }
        if (cancelled) return;
        // Selectable text layer (Overleaf parity: copy text out of the PDF).
        // Best-effort — a failure leaves the canvas page fully usable.
        try {
          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = styles.textLayer ?? 'latex-pdf-textlayer';
          textLayerDiv.style.setProperty('--scale-factor', String(scale));
          wrapper.appendChild(textLayerDiv);
          const textLayer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport,
          });
          await textLayer.render();
          // Selection landing zone below the last glyph (pdf.js viewer parity).
          const endOfContent = document.createElement('div');
          endOfContent.className = 'endOfContent';
          textLayerDiv.appendChild(endOfContent);
        } catch {
          // Text extraction unsupported for this page — selection just
          // stays unavailable there.
        }
      }
      if (cancelled || !containerRef.current) return;
      if (scrollKeepRef.current > 0) {
        // Document reload (recompile): same content shape, absolute offset.
        containerRef.current.scrollTop = scrollKeepRef.current;
        scrollKeepRef.current = 0;
      } else if (previousRatio > 0) {
        const nextRange = Math.max(1, containerRef.current.scrollHeight - containerRef.current.clientHeight);
        containerRef.current.scrollTop = previousRatio * nextRange;
      }
    })().catch(() => {
      // Destroyed/cancelled mid-render — expected during rapid reloads.
    });
    return () => {
      cancelled = true;
      for (const task of tasks) task.cancel();
    };
  }, [doc, scale]);

  const zoomLabel = useMemo(() => `${Math.round(scale * 100)}%`, [scale]);

  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const effective = current ?? fitScale;
      if (direction === 1) {
        return ZOOM_STEPS.find((step) => step > effective + 0.01) ?? effective;
      }
      return [...ZOOM_STEPS].reverse().find((step) => step < effective - 0.01) ?? effective;
    });
  }, [fitScale]);

  return (
    <div className={styles.root} data-testid="latex-pdf-viewer">
      {loading ? <div role="status" className={styles.loading}>{t('common.loading')}</div> : null}
      <div className={styles.zoomBar}>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => stepZoom(-1)}
          aria-label={t('latex.zoomOut')}
          title={t('latex.zoomOut')}
        >
          <Icon name="zoom-out" size={13} />
        </button>
        <button
          type="button"
          className={styles.zoomFit}
          onClick={() => setZoom(null)}
          aria-label={t('latex.zoomFit')}
          title={t('latex.zoomFit')}
        >
          {zoom === null ? t('latex.zoomFit') : zoomLabel}
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => stepZoom(1)}
          aria-label={t('latex.zoomIn')}
          title={t('latex.zoomIn')}
        >
          <Icon name="zoom-in" size={13} />
        </button>
      </div>
      <div
        ref={containerRef}
        className={styles.scroll}
        data-testid="pdf-pages"
      >
        {error ? (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <Button variant="ghost" disabled={loading} onClick={() => setRetry(value => value + 1)}>
              <Icon name="refresh" size={14} />{t('preview.retry')}
            </Button>
          </div>
        ) : (
          <div ref={pagesRef} className={styles.pages} />
        )}
      </div>
    </div>
  );
}
