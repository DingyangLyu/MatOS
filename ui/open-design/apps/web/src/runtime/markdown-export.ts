import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { projectFileUrl } from '../providers/registry';

export interface MarkdownExportOptions {
  title: string;
  projectId?: string;
  fileName?: string;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const MARKDOWN_PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm; }
html, body { margin: 0; background: #fff; color: #202124; color-scheme: light; }
.matos-report { font: 15px/1.7 Arial, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; color: #202124; background: #fff; box-sizing: border-box; width: 794px; max-width: 100%; margin: 0 auto; padding: 48px; overflow-wrap: anywhere; }
.matos-report h1 { font-size: 28px; line-height: 1.3; } .matos-report h2 { font-size: 21px; } .matos-report h3 { font-size: 17px; }
.matos-report h1, .matos-report h2, .matos-report h3 { break-after: avoid; }
.matos-report [data-matos-heading-group] { display: flow-root; break-inside: avoid; }
.matos-report p { margin: 0 0 12px; } .matos-report a { color: #166890; }
.matos-report pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: #f3f4f5; border: 1px solid #ddd; }
.matos-report code { font-family: "DejaVu Sans Mono", monospace; font-size: 12px; }
.matos-report table { border-collapse: collapse; width: 100%; font-size: 13px; }
.matos-report th, .matos-report td { border: 1px solid #ccc; padding: 7px 10px; text-align: left; }
.matos-report thead { display: table-header-group; } .matos-report tr { break-inside: avoid; }
.matos-report img { display: block; max-width: 100%; height: auto; break-inside: avoid; }
.matos-report blockquote { margin: 16px 0; padding-left: 16px; border-left: 3px solid #b7c1cc; }
.md-math-display { display: block; overflow-x: auto; max-width: 100%; break-inside: avoid; }
.matos-report .katex { font-size: 1.08em; } .matos-report .katex-display { margin: 0.8em 0; }
@media print { .matos-report { width: auto; padding: 0; max-width: none; } a { text-decoration: none; } }
@media screen and (max-width: 600px) { .matos-report { padding: 24px 18px; } }
`;

/** HTML contains only safe Markdown and KaTeX output. Relative images stay in
 * the same project, including when this document is opened through a blob URL.
 */
export function markdownExportHtml(markdown: string, options: MarkdownExportOptions, mathCss = ''): string {
  let body = renderMarkdownToSafeHtml(markdown);
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(body, 'text/html');
    // html2pdf handles break-inside, but not break-after: avoid. Keep each
    // heading with its first content block rather than orphaning or slicing it.
    for (const heading of Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).reverse()) {
      const next = heading.nextElementSibling;
      if (!next?.matches('p, pre, table, ul, ol, blockquote, [data-matos-heading-group]')) continue;
      const group = doc.createElement('div');
      group.dataset.matosHeadingGroup = 'true';
      heading.before(group);
      group.append(heading, next);
    }
    for (const image of doc.querySelectorAll('img')) {
      if (!options.projectId) continue;
      const src = image.getAttribute('src') ?? '';
      if (/^(https?:|data:|blob:|\/\/)/i.test(src)) continue;
      if (src.startsWith('/')) {
        image.src = new URL(src, location.origin).href;
        continue;
      }
      const base = (options.fileName ?? '').split('/').slice(0, -1);
      for (const segment of src.split('/')) {
        if (segment === '..') base.pop();
        else if (segment && segment !== '.') base.push(segment);
      }
      image.src = new URL(projectFileUrl(options.projectId, base.join('/')), location.origin).href;
      image.loading = 'eager';
    }
    body = doc.body.innerHTML;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(options.title)}</title><style>${mathCss.replace(/<\/style/gi, '<\\/style')}\n${MARKDOWN_PRINT_CSS}</style></head><body><article class="matos-report">${body}</article></body></html>`;
}

/** Copy only the installed KaTeX rules, not application layout/theme CSS. */
export function installedMathCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!/katex|KaTeX_/.test(rule.cssText)) continue;
        rules.push(rule.cssText.replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (_match, _quote, url: string) =>
          `url("${new URL(url, sheet.href ?? location.href).href}")`));
      }
    } catch { /* Cross-origin stylesheets are not required for local KaTeX. */ }
  }
  return rules.join('\n');
}

export async function exportMarkdownPdf(markdown: string, options: MarkdownExportOptions): Promise<void> {
  // The upstream prebundle embeds its own older jsPDF/DOMPurify copies.
  // Use the source entry so the workspace lockfile controls these dependencies.
  const { default: html2pdf } = await import('html2pdf.js/src/index.js');
  const parsed = new DOMParser().parseFromString(markdownExportHtml(markdown, options), 'text/html');
  const article = parsed.querySelector<HTMLElement>('.matos-report')!;
  for (const element of article.querySelectorAll('[class]')) {
    if (!element.closest('.md-math')) element.removeAttribute('class');
  }
  const style = document.createElement('style');
  style.dataset.matosReportStyle = 'true';
  // Scope print layout to the cloned report: never restyle the live application.
  // Pagination happens in the live DOM before html2canvas clones it. Reset the
  // report there as well, so application typography cannot change line heights
  // or heading margins between pagination and capture.
  style.textContent = '.matos-report, .matos-report * { all: revert; }\n'
    + installedMathCss() + MARKDOWN_PRINT_CSS.replace(/html, body \{[^}]*\}/, '')
    + '\n.matos-report { width: 100%; padding: 0 !important; }';
  article.prepend(style);
  const filename = (options.title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 100) || 'MatOS') + '.pdf';
  const canvasOptions = {
    scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff', windowWidth: window.innerWidth,
    onclone: (clone: Document) => {
      // Application themes use color-mix/oklab, which html2canvas cannot parse.
      // The export owns its stylesheet; unrelated application CSS stays out.
      clone.querySelectorAll('link[rel="stylesheet"], style:not([data-matos-report-style])').forEach(node => node.remove());
      clone.documentElement.style.cssText = 'color: #202124; background: #fff; color-scheme: light;';
      clone.body.style.cssText = 'margin: 0; color: #202124; background: #fff;';
    },
  };
  const settings = {
    filename, margin: [18, 16] as [number, number], image: { type: 'png' as const, quality: 1 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const, compress: true },
    html2canvas: canvasOptions,
    pagebreak: { mode: 'css', avoid: ['p', 'pre', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '.md-math-display'] },
  };
  const staging = document.createElement('div');
  staging.style.cssText = 'position:fixed;top:0;left:0;width:178mm;opacity:0;pointer-events:none;z-index:-1;';
  staging.setAttribute('aria-hidden', 'true');
  staging.append(article);
  document.body.append(staging);
  let overlay: HTMLElement | undefined;
  try {
    // Warm fonts/images before the page-break plugin measures the clone.
    // Otherwise a late chart or font can shift already-computed page breaks.
    article.getBoundingClientRect();
    await document.fonts.ready;
    const imageReady = Array.from(article.querySelectorAll('img')).map(image => image.decode().catch(() => undefined));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(imageReady), new Promise<void>(resolve => { timeout = setTimeout(resolve, 15_000); })]);
    } finally {
      clearTimeout(timeout);
    }
    const worker = html2pdf().set(settings).from(article).toContainer();
    overlay = await worker.get('overlay') as HTMLElement;
    const container = await worker.get('container') as HTMLElement;
    await document.fonts.ready;
    // Avoid browser canvas limits producing a silent, blank long-document PDF.
    const height = container.scrollHeight;
    if (height > 30_000) throw new Error('Document exceeds direct PDF canvas limit; open the document and print to PDF instead');
    worker.set({ html2canvas: { ...canvasOptions, scale: Math.min(2, 30_000 / Math.max(1, height)) } });
    await worker.save();
  } finally {
    overlay?.remove();
    staging.remove();
  }
}

export function openMarkdownDocument(markdown: string, options: MarkdownExportOptions, target?: Window): void {
  const popup = target ?? window.open('', '_blank');
  if (!popup) throw new Error('Popup blocked');
  popup.opener = null;
  const blob = new Blob([markdownExportHtml(markdown, options, installedMathCss())], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  popup.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
