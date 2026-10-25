import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Button, Input, Select } from '@open-design/components';
import { APP_CHROME_FILE_ACTIONS_ID, APP_CHROME_FILE_ACTIONS_SELECTOR } from './AppChromeHeader';
import {
  type ProjectFileVersion,
} from '@open-design/contracts';
type ViewerProjectKind =
  | 'prototype'
  | 'wireframe'
  | 'mobile'
  | 'slide_deck'
  | 'template'
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'brand'
  | 'design_system'
  | 'other';

import { MarkdownRenderer, artifactRendererRegistry } from '../artifacts/renderer-registry';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { MarkdownExportMenu } from './MarkdownExportMenu';
import {
  buildScrollAnchors,
  extractMarkdownBlockLines,
  mapScrollPosition,
  measureEditorBlockOffsets,
  measurePreviewBlockOffsets,
} from './markdown-scroll-sync';
import { useT, useI18n } from '../i18n';
import type { Dict, Locale } from '../i18n/types';
import {
  fetchProjectFileVersion,
  fetchProjectFileVersions,
  fetchProjectFilePreview,
  fetchProjectFiles,
  fetchProjectFileText,
  uploadProjectFiles,
  projectDownloadUrl,
  projectFileUrl,
  projectRawUrl,
  restoreProjectFileVersion,
  writeProjectTextFile,
  writeProjectTextFileDetailed,
} from '../providers/registry';
import type { ProjectFilePreview } from '../providers/registry';
import {
  downloadImageDataUrl,
  exportAsJsx,
  exportAsMd,
  exportAsPdf,
  exportProjectAsHtml,
  exportProjectAsPdf,
  exportProjectAsPptx,
  exportProjectImageDataUrl,
  exportProjectScreenshotPdf,
  copyImageDataUrlToClipboard,
  exportReactComponentAsHtml,
  exportReactComponentAsZip,
  captureHostIframeSnapshot,
  imageDataUrlToBlob,
  isOpenDesignHostAvailable,
  openSandboxedPreviewInNewTab,
  prepareImageExportTarget,
  planDeckImageCapture,
  requestPreviewSnapshot,
  sourceLooksLikeExportableDeck,
  type ExportProgress,
  type ImageExportFormat,
} from '../runtime/exports';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { buildReactComponentSrcdoc } from '../runtime/react-component';
import { shouldConsumeSlideNav } from '../runtime/slide-nav';
import { findHtmlEntriesReferencing } from '../runtime/jsx-module-refs';
import {
  isProbablyUtf8Text,
  shouldAutodetectTextFile,
  TEXT_SNIFF_BYTES,
} from '../runtime/file-content-detection';
import { buildLazySrcdocTransport, buildSrcdoc, canActivateSrcDocTransport } from '../runtime/srcdoc';
import {
  hasUrlModeBridge,
  htmlNeedsFocusGuard,
  htmlNeedsSandboxShim,
  parseForceInline,
  shouldUrlLoadHtmlPreview,
  type UrlLoadDecision,
} from './file-viewer-render-mode';
import { saveTemplate } from '../state/projects';
import type {
  ProjectFile,
} from '../types';
import { CodeEditor } from './CodeEditor';
import { PdfViewer } from './PdfViewer';
import { Icon } from './Icon';
import { MatterVizPane } from './MatterVizPane';
import { RemixIcon } from './RemixIcon';
import {
  structureFileHasTextMode,
  structureViewKind,
  type StructureViewKind,
} from './structure-files';
import { Toast } from './Toast';
import { PreviewDrawOverlay, type DrawToolbarElement } from './PreviewDrawOverlay';
import {
  buildBoardCommentAttachments,
  commentSnapshotEqual,
  commentTargetDisplayName,
  commentVisibleOnDeckSlide,
  commentsToAttachments,
  isValidCommentOverlayPosition,
  liveCommentTargetMapsEqual,
  liveSnapshotForComment,
  overlayBoundsFromSnapshot,
  targetFromSnapshot,
  type PreviewCommentSnapshot,
} from '../comments';
import { applyPodMemberRemoval } from '../lib/pod-members';
import { AnnotationHoverPopover, BoardComposerPopover } from './BoardComposerPopover';
import {
  OD_PREVIEW_KEEP_ALIVE,
  PooledIframe,
  previewIframeKeepAliveKey,
} from './IframeKeepAlivePool';
import type {
  ChatCommentAttachment,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentMember,
  PreviewCommentTarget,
} from '../types';
import { ManualEditPanel, emptyManualEditDraft, type ManualEditDraft } from './ManualEditPanel';
import {
  applyManualEditPatch,
  isManualEditFullHtmlDocument,
  readManualEditAttributes,
  readManualEditFields,
  readManualEditOuterHtml,
  readManualEditStyles,
} from '../edit-mode/source-patches';
import { MANUAL_EDIT_STYLE_PROPS, type ManualEditBridgeMessage, type ManualEditHistoryEntry, type ManualEditPatch, type ManualEditStyles, type ManualEditTarget } from '../edit-mode/types';

function resolveChromeActionsHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(APP_CHROME_FILE_ACTIONS_SELECTOR)
    ?? document.getElementById(APP_CHROME_FILE_ACTIONS_ID);
}

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;
type SlideState = { active: number; count: number };
type BoardTool = 'inspect' | 'pod';
type StrokePoint = { x: number; y: number };
export type ManualEditPendingStyleSave = {
  id: string;
  styles: Partial<ManualEditStyles>;
  label: string;
  version: number;
};
type PreviewViewportId = 'desktop' | 'tablet' | 'mobile';
type PreviewCanvasSize = { width: number; height: number; scrollLeft?: number; scrollTop?: number };
type CommentPreviewCanvasOptions = {
  boardMode: boolean;
  sidePanelCollapsed: boolean;
  viewport?: PreviewViewportId;
};
type PreviewScaleOptions = {
  canvasPadding?: number;
};
type PreviewViewportPreset = {
  id: PreviewViewportId;
  width: number | null;
  height: number | null;
  labelKey: keyof Dict;
  titleKey: keyof Dict;
};
const IMAGE_EXPORT_FORMAT_OPTIONS: Array<{
  value: ImageExportFormat;
  label: string;
  extension: string;
}> = [
  { value: 'png', label: 'PNG', extension: '.png' },
  { value: 'jpeg', label: 'JPEG', extension: '.jpg' },
  { value: 'webp', label: 'WebP', extension: '.webp' },
];
const MAX_BRIDGE_COORDINATE = 1_000_000;
const PREVIEW_VIEWPORT_PRESETS: PreviewViewportPreset[] = [
  {
    id: 'desktop',
    width: null,
    height: null,
    labelKey: 'fileViewer.viewportDesktop',
    titleKey: 'fileViewer.viewportDesktopTitle',
  },
  {
    id: 'tablet',
    width: 820,
    height: 1180,
    labelKey: 'fileViewer.viewportTablet',
    titleKey: 'fileViewer.viewportTabletTitle',
  },
  {
    id: 'mobile',
    width: 390,
    height: 844,
    labelKey: 'fileViewer.viewportMobile',
    titleKey: 'fileViewer.viewportMobileTitle',
  },
];

function previewViewportIcon(viewport: PreviewViewportId): string {
  if (viewport === 'tablet') return 'tablet-line';
  if (viewport === 'mobile') return 'smartphone-line';
  return 'computer-line';
}

const EXPORT_READY_NUDGE_STORAGE_PREFIX = 'open-design:export-ready-nudge:';
const COMMENT_SIDE_DOCK_WIDTH = 320;
const COMMENT_SIDE_DOCK_RAIL_WIDTH = 42;
const COMMENT_SIDE_DOCK_GAP = 12;
const COMMENT_SIDE_DOCK_PADDING = 8;
const COMMENT_SIDE_DOCK_NON_DESKTOP_PADDING = 24;
const COMMENT_SIDE_DOCK_MIN_CANVAS_WIDTH = 280;
const COMMENT_SIDE_DOCK_STACKED_PANEL_HEIGHT = 220;
const COMMENT_SIDE_DOCK_STACKED_RAIL_HEIGHT = 48;
const COMMENT_SIDE_DOCK_STACKED_HEIGHT_DEDUCTION =
  (COMMENT_SIDE_DOCK_PADDING * 2) + COMMENT_SIDE_DOCK_GAP + COMMENT_SIDE_DOCK_STACKED_PANEL_HEIGHT;
const COMMENT_SIDE_DOCK_STACKED_COLLAPSED_HEIGHT_DEDUCTION =
  (COMMENT_SIDE_DOCK_PADDING * 2) + COMMENT_SIDE_DOCK_GAP + COMMENT_SIDE_DOCK_STACKED_RAIL_HEIGHT;

// The five basic style facets the inspect panel exposes. Kept narrow on
// purpose — open-slide's design tokens panel only edits global tokens, so
// the per-element delta is small + obvious + cheap to read back from
// getComputedStyle on the iframe side.
type InspectStyleSnapshot = {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontWeight?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  borderRadius?: string;
  textAlign?: string;
  fontFamily?: string;
  lineHeight?: string;
};

type InspectClickedDescendant = {
  label: string;
  text: string;
};

type InspectTarget = {
  elementId: string;
  selector: string;
  label: string;
  text: string;
  style: InspectStyleSnapshot;
  clickedDescendant?: InspectClickedDescendant;
};

const MAX_CACHED_SLIDE_STATES = 64;
const htmlPreviewSlideState = new Map<string, SlideState>();
const MAX_CACHED_PREVIEW_VIEWPORTS = 128;
// Grace window before the inspect hover card is torn down. Long enough to absorb
// the async iframe mouseout (od:comment-leave) that fires when the pointer slides
// onto the card or hops back onto the element under it, short enough to read as
// an immediate dismiss when the pointer really leaves.
const HOVER_CARD_DISMISS_DELAY_MS = 80;
const htmlPreviewViewportState = new Map<string, PreviewViewportId>();
const MARKDOWN_CODE_BLOCK_ATTR = 'data-markdown-code-block';
const MARKDOWN_CODE_LANGUAGE_ATTR = 'data-code-language';
const MARKDOWN_COPY_BLOCK_ATTR = 'data-copy-code-block';
const MARKDOWN_COPY_BUTTON_CLASS = 'markdown-code-copy';
const MARKDOWN_COPY_TOAST_CLASS = 'markdown-code-toast';
const ABSOLUTE_MARKDOWN_IMAGE_SOURCE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;


function mergeManualEditInspectorStyles(
  sourceStyles: ManualEditStyles,
  previewStyles: ManualEditStyles,
): ManualEditStyles {
  return MANUAL_EDIT_STYLE_PROPS.reduce<ManualEditStyles>((acc, key) => {
    const sourceValue = sourceStyles[key]?.trim();
    const previewValue = previewStyles[key]?.trim();
    const value = sourceValue || previewValue || '';
    acc[key] = manualEditInspectorStyleValue(key, value);
    return acc;
  }, {} as ManualEditStyles);
}

function manualEditInspectorStyleValue(key: keyof ManualEditStyles, value: string): string {
  if (!value) return '';
  if (key === 'color' || key === 'backgroundColor' || key === 'borderColor') {
    return normalizeManualEditInspectorColor(value);
  }
  return value;
}

function normalizeManualEditInspectorColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const r = trimmed[1]!, g = trimmed[2]!, b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgba = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) return trimmed;
  if (rgba[4] !== undefined && Number(rgba[4]) === 0) return '';
  const toHex = (raw: string) => Math.max(0, Math.min(255, Math.round(Number(raw))))
    .toString(16)
    .padStart(2, '0');
  return `#${toHex(rgba[1]!)}${toHex(rgba[2]!)}${toHex(rgba[3]!)}`;
}

function manualEditPersistedValueMatchesSavedSnapshot(
  key: keyof ManualEditStyles,
  persistedValue: string,
  savedValue: string,
): boolean {
  return canonicalManualEditStyleValue(key, persistedValue) === canonicalManualEditStyleValue(key, savedValue);
}

function canonicalManualEditStyleValue(key: keyof ManualEditStyles, value: string): string {
  const normalized = manualEditInspectorStyleValue(key, value).trim();
  if (!normalized) return '';
  return normalized.toLowerCase();
}


async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
      if (priorFocus?.isConnected) {
        try {
          priorFocus.focus({ preventScroll: true });
        } catch {
          priorFocus.focus();
        }
      }
    }
  }
}

function decorateMarkdownCodeBlocks(html: string): string {
  let blockIndex = 0;
  return html.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/g, (_match, attrs: string, content: string) => {
    const blockId = String(blockIndex++);
    const language = markdownCodeBlockLanguage(content);
    const languageAttr = language ? ` ${MARKDOWN_CODE_LANGUAGE_ATTR}="${escapeHtmlAttribute(language.label)}"` : '';
    return `<div class="markdown-code-block" ${MARKDOWN_CODE_BLOCK_ATTR}="${blockId}"${languageAttr}><pre${attrs}>${content}</pre></div>`;
  });
}

type MarkdownCodeLanguage = {
  lang: string;
  label: string;
};

function markdownCodeBlockLanguage(content: string): MarkdownCodeLanguage | null {
  const codeMatch = content.match(/<code\b([^>]*)>/);
  if (!codeMatch) return null;
  const classMatch = codeMatch[1]?.match(/\bclass=(["'])(.*?)\1/);
  const className = classMatch?.[2] ?? '';
  const languageClass = className
    .split(/\s+/)
    .map((item) => item.trim())
    .find((item) => /^(?:language|lang)-/i.test(item));
  if (!languageClass) return null;
  const raw = languageClass.replace(/^(?:language|lang)-/i, '').replace(/[^a-z0-9+#.-]/gi, '');
  if (!raw) return null;
  const aliases: Record<string, MarkdownCodeLanguage> = {
    bash: { lang: 'bash', label: 'Bash' },
    c: { lang: 'c', label: 'C' },
    cpp: { lang: 'cpp', label: 'C++' },
    css: { lang: 'css', label: 'CSS' },
    diff: { lang: 'diff', label: 'Diff' },
    dockerfile: { lang: 'dockerfile', label: 'Dockerfile' },
    go: { lang: 'go', label: 'Go' },
    graphql: { lang: 'graphql', label: 'GraphQL' },
    html: { lang: 'html', label: 'HTML' },
    java: { lang: 'java', label: 'Java' },
    js: { lang: 'javascript', label: 'JS' },
    javascript: { lang: 'javascript', label: 'JS' },
    json: { lang: 'json', label: 'JSON' },
    jsx: { lang: 'jsx', label: 'JSX' },
    markdown: { lang: 'markdown', label: 'Markdown' },
    md: { lang: 'markdown', label: 'Markdown' },
    php: { lang: 'php', label: 'PHP' },
    py: { lang: 'python', label: 'Python' },
    python: { lang: 'python', label: 'Python' },
    rb: { lang: 'ruby', label: 'Ruby' },
    ruby: { lang: 'ruby', label: 'Ruby' },
    rust: { lang: 'rust', label: 'Rust' },
    shell: { lang: 'shell', label: 'Shell' },
    sh: { lang: 'shell', label: 'Shell' },
    sql: { lang: 'sql', label: 'SQL' },
    swift: { lang: 'swift', label: 'Swift' },
    toml: { lang: 'toml', label: 'TOML' },
    ts: { lang: 'typescript', label: 'TS' },
    tsx: { lang: 'tsx', label: 'TSX' },
    typescript: { lang: 'typescript', label: 'TS' },
    xml: { lang: 'xml', label: 'XML' },
    yaml: { lang: 'yaml', label: 'YAML' },
    yml: { lang: 'yaml', label: 'YAML' },
  };
  return aliases[raw.toLowerCase()] ?? { lang: raw.toLowerCase(), label: raw.toUpperCase() };
}

async function highlightMarkdownCodeBlocks(html: string): Promise<string> {
  if (typeof document === 'undefined') return html;
  const root = document.createElement('div');
  root.innerHTML = html;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(`[${MARKDOWN_CODE_BLOCK_ATTR}]`));
  if (blocks.length === 0) return html;
  const { highlightCode } = await import('../runtime/shiki');
  let changed = false;
  await Promise.all(blocks.map(async (block) => {
    const code = block.querySelector<HTMLElement>('pre > code');
    if (!code) return;
    const language = markdownCodeBlockLanguage(code.outerHTML);
    if (!language) return;
    const source = (code.textContent ?? '').replace(/\n$/, '');
    const highlighted = await highlightCode(source, language.lang);
    if (!highlighted) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = highlighted;
    const highlightedPre = wrapper.firstElementChild;
    if (!(highlightedPre instanceof HTMLElement)) return;
    highlightedPre.classList.add('markdown-shiki');
    highlightedPre.setAttribute('data-lang', language.label);
    code.closest('pre')?.replaceWith(highlightedPre);
    block.setAttribute(MARKDOWN_CODE_LANGUAGE_ATTR, language.label);
    changed = true;
  }));
  return changed ? root.innerHTML : html;
}

function rewriteMarkdownImageSources(html: string, projectId: string, markdownPath: string): string {
  return html.replace(/<img\b([^>]*?)\bsrc="([^"]*)"([^>]*)>/g, (match, before: string, src: string, after: string) => {
    const resolved = markdownImageSourceUrl(projectId, markdownPath, decodeHtmlAttribute(src));
    if (!resolved) return match;
    const attrs = `${before}${after}`;
    const loadingAttr = /\sloading=/.test(attrs) ? '' : ' loading="lazy"';
    return `<img${before}src="${escapeHtmlAttribute(resolved)}"${loadingAttr}${after}>`;
  });
}

export function markdownImageSourceUrl(projectId: string, markdownPath: string, src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (ABSOLUTE_MARKDOWN_IMAGE_SOURCE_RE.test(trimmed)) return trimmed;
  const relativePath = trimmed.startsWith('/')
    ? normalizeMarkdownProjectPath(trimmed.slice(1))
    : normalizeMarkdownProjectPath(`${markdownDirectory(markdownPath)}/${trimmed}`);
  return relativePath ? projectFileUrl(projectId, relativePath) : null;
}

function markdownDirectory(path: string): string {
  const normalized = normalizeMarkdownProjectPath(path);
  const slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : '';
}

function normalizeMarkdownProjectPath(path: string): string {
  const parts: string[] = [];
  for (const raw of path.replace(/\\/g, '/').split('/')) {
    const part = raw.trim();
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function markdownRelativeProjectPath(fromPath: string, targetPath: string): string {
  const fromDir = markdownDirectory(fromPath);
  const target = normalizeMarkdownProjectPath(targetPath);
  if (!fromDir) return target;
  if (target.startsWith(`${fromDir}/`)) return target.slice(fromDir.length + 1);
  const fromParts = fromDir.split('/').filter(Boolean);
  const targetParts = target.split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) {
    common += 1;
  }
  const up = Array.from({ length: fromParts.length - common }, () => '..');
  const down = targetParts.slice(common);
  return [...up, ...down].join('/') || target;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setMarkdownCodeBlockCopiedState(block: HTMLElement, copied: boolean, t: TranslateFn) {
  const button = block.querySelector<HTMLButtonElement>(`.${MARKDOWN_COPY_BUTTON_CLASS}`);
  if (!button) return;
  const label = copied ? t('fileViewer.copied') : t('fileViewer.copy');
  button.textContent = label;
  button.setAttribute('aria-label', label);
  button.title = t('fileViewer.copyTitle');

  const existingToast = block.querySelector(`.${MARKDOWN_COPY_TOAST_CLASS}`);
  if (copied) {
    if (existingToast instanceof HTMLElement) {
      existingToast.textContent = t('fileViewer.copied');
      return;
    }
    const toast = document.createElement('span');
    toast.className = MARKDOWN_COPY_TOAST_CLASS;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = t('fileViewer.copied');
    button.insertAdjacentElement('afterend', toast);
    return;
  }

  existingToast?.remove();
}

function PreviewViewportControls({
  viewport,
  onViewport,
  t,
  tabIndex,
}: {
  viewport: PreviewViewportId;
  onViewport: (viewport: PreviewViewportId) => void;
  t: TranslateFn;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const activePreset =
    PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === viewport) ?? PREVIEW_VIEWPORT_PRESETS[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="viewer-viewport-switcher" ref={menuRef}>
      <button
        type="button"
        className={`viewer-action viewer-viewport-trigger${open ? '' : ' od-tooltip'}`}
        aria-label={t('fileViewer.viewportAria')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={t(activePreset.titleKey)}
        data-tooltip={open ? undefined : t(activePreset.titleKey)}
        data-tooltip-placement="bottom"
        tabIndex={tabIndex}
        onClick={() => setOpen((value) => !value)}
      >
        <RemixIcon
          name={previewViewportIcon(activePreset.id)}
          size={14}
          className="viewer-viewport-icon"
        />
        <span>{t(activePreset.labelKey)}</span>
        <RemixIcon name="arrow-down-s-line" size={14} />
      </button>
      {open ? (
        <div className="viewer-viewport-menu" id={listboxId} role="listbox" aria-label={t('fileViewer.viewportAria')}>
          {PREVIEW_VIEWPORT_PRESETS.map((preset) => {
            const selected = viewport === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`viewer-viewport-menu-item${selected ? ' active' : ''}`}
                role="option"
                aria-selected={selected}
                title={t(preset.titleKey)}
                onClick={() => {
                  onViewport(preset.id);
                  setOpen(false);
                }}
              >
                <span className="viewer-viewport-menu-label">
                  <RemixIcon name={previewViewportIcon(preset.id)} size={14} />
                  <span>{t(preset.labelKey)}</span>
                </span>
                {selected ? <Icon name="check" size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function FileVersionViewportControls({
  viewport,
  onViewport,
  t,
}: {
  viewport: PreviewViewportId;
  onViewport: (viewport: PreviewViewportId) => void;
  t: TranslateFn;
}) {
  return (
    <div className="file-version-viewport-toggle" role="group" aria-label={t('fileViewer.viewportAria')}>
      {PREVIEW_VIEWPORT_PRESETS.map((preset) => {
        const selected = viewport === preset.id;
        const label = t(preset.titleKey);
        return (
          <button
            key={preset.id}
            type="button"
            className={`file-version-viewport-button od-tooltip${selected ? ' active' : ''}`}
            aria-label={label}
            aria-pressed={selected}
            title={label}
            data-tooltip={label}
            data-tooltip-placement="bottom"
            onClick={() => onViewport(preset.id)}
          >
            <RemixIcon name={previewViewportIcon(preset.id)} size={14} />
          </button>
        );
      })}
    </div>
  );
}

function previewViewportStyle(
  viewport: PreviewViewportId,
  previewScale = 1,
  canvasSize?: PreviewCanvasSize,
  options?: PreviewScaleOptions,
): CSSProperties & Record<string, string | number> {
  const preset = PREVIEW_VIEWPORT_PRESETS.find((item) => item.id === viewport) ?? PREVIEW_VIEWPORT_PRESETS[0]!;
  if (!preset.width) return {};
  const effectiveScale = effectivePreviewScale(viewport, previewScale, canvasSize, options);
  return {
    '--preview-viewport-width': `${preset.width}px`,
    '--preview-viewport-height': `${preset.height}px`,
    '--preview-scale': effectiveScale,
    '--preview-user-scale': previewScale,
  };
}

export function commentPreviewCanvasSize(
  canvasSize: PreviewCanvasSize | undefined,
  options: CommentPreviewCanvasOptions,
): PreviewCanvasSize | undefined {
  if (!canvasSize || !options.boardMode) return canvasSize;
  const dockPadding = options.viewport && options.viewport !== 'desktop'
    ? COMMENT_SIDE_DOCK_NON_DESKTOP_PADDING
    : COMMENT_SIDE_DOCK_PADDING;
  const sideDockWidth = options.sidePanelCollapsed ? COMMENT_SIDE_DOCK_RAIL_WIDTH : COMMENT_SIDE_DOCK_WIDTH;
  const dockedWidth = canvasSize.width - (dockPadding * 2) - COMMENT_SIDE_DOCK_GAP - sideDockWidth;
  if (usesStackedCommentSideDock(canvasSize, options)) {
    const stackedHeightDeduction = options.sidePanelCollapsed
      ? COMMENT_SIDE_DOCK_STACKED_COLLAPSED_HEIGHT_DEDUCTION
      : COMMENT_SIDE_DOCK_STACKED_HEIGHT_DEDUCTION;
    return {
      width: Math.max(1, canvasSize.width - (COMMENT_SIDE_DOCK_PADDING * 2)),
      height: Math.max(1, canvasSize.height - stackedHeightDeduction),
    };
  }
  return {
    width: Math.max(1, dockedWidth),
    height: Math.max(1, canvasSize.height - (dockPadding * 2)),
  };
}

function usesStackedCommentSideDock(
  canvasSize: PreviewCanvasSize | undefined,
  options: CommentPreviewCanvasOptions,
) {
  if (!canvasSize || !options.boardMode) return false;
  const dockPadding = options.viewport && options.viewport !== 'desktop'
    ? COMMENT_SIDE_DOCK_NON_DESKTOP_PADDING
    : COMMENT_SIDE_DOCK_PADDING;
  const sideDockWidth = options.sidePanelCollapsed ? COMMENT_SIDE_DOCK_RAIL_WIDTH : COMMENT_SIDE_DOCK_WIDTH;
  const dockedWidth = canvasSize.width - (dockPadding * 2) - COMMENT_SIDE_DOCK_GAP - sideDockWidth;
  return dockedWidth < COMMENT_SIDE_DOCK_MIN_CANVAS_WIDTH;
}

export function effectivePreviewScale(
  viewport: PreviewViewportId,
  previewScale: number,
  canvasSize?: PreviewCanvasSize,
  options?: PreviewScaleOptions,
) {
  if (viewport === 'desktop') return previewScale;
  const preset = PREVIEW_VIEWPORT_PRESETS.find((item) => item.id === viewport);
  if (!preset?.width || !preset.height || !canvasSize?.width || !canvasSize.height) return previewScale;
  const canvasPadding = options?.canvasPadding ?? 48;
  const availableWidth = Math.max(1, canvasSize.width - canvasPadding);
  const availableHeight = Math.max(1, canvasSize.height - canvasPadding);
  const fitScale = Math.min(1, availableWidth / preset.width, availableHeight / preset.height);
  return Math.min(previewScale, fitScale);
}

type PreviewOverlayTransform = { scale: number; offsetX: number; offsetY: number };

export function previewOverlayTransform(
  viewport: PreviewViewportId,
  previewScale: number,
  canvasSize?: PreviewCanvasSize,
): PreviewOverlayTransform {
  const scale = effectivePreviewScale(viewport, previewScale, canvasSize);
  if (viewport === 'desktop') return { scale, offsetX: 0, offsetY: 0 };
  const preset = PREVIEW_VIEWPORT_PRESETS.find((item) => item.id === viewport);
  const pad = 24;
  if (!preset?.width || !preset.height) return { scale, offsetX: pad, offsetY: pad };
  const availableWidth = Math.max(1, (canvasSize?.width ?? preset.width * scale + pad * 2) - pad * 2);
  const scaledWidth = preset.width * scale;
  return {
    scale,
    offsetX: pad + Math.max(0, (availableWidth - scaledWidth) / 2),
    offsetY: pad,
  };
}

function previewScaleShellStyle(
  viewport: PreviewViewportId,
  previewScale: number,
): CSSProperties & Record<string, string | number> {
  if (viewport === 'desktop') {
    return {
      width: `${100 / previewScale}%`,
      height: `${100 / previewScale}%`,
      transform: `scale(${previewScale})`,
      transformOrigin: '0 0',
    };
  }
  return {
    width: 'var(--preview-viewport-width)',
    height: 'var(--preview-viewport-height)',
    transform: 'scale(var(--preview-scale, 1))',
    transformOrigin: '0 0',
  };
}

function manualEditPreviewShellStyle(
  viewport: PreviewViewportId,
  previewScale: number,
  frozenWidth: number | null,
): CSSProperties & Record<string, string | number> {
  if (viewport === 'desktop' && frozenWidth) {
    return {
      width: `${frozenWidth / previewScale}px`,
      height: `${100 / previewScale}%`,
      transform: `scale(${previewScale})`,
      transformOrigin: '0 0',
    };
  }
  return previewScaleShellStyle(viewport, previewScale);
}

function manualEditFloatingPanelStyle(
  target: ManualEditTarget,
  previewScale: number,
  canvasSize: PreviewCanvasSize | undefined,
): CSSProperties {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  const panelWidth = 320;
  const preferredPanelHeight = 380;
  const pad = 12;
  const canvasWidth = canvasSize?.width ?? 1200;
  const canvasHeight = canvasSize?.height ?? 800;
  const panelHeight = Math.min(preferredPanelHeight, Math.max(260, canvasHeight - pad * 2));
  const targetLeft = target.rect.x * scale;
  const targetTop = target.rect.y * scale;
  const targetRight = (target.rect.x + target.rect.width) * scale;
  let left = targetRight + pad;
  if (left + panelWidth > canvasWidth - pad) {
    left = Math.max(pad, targetLeft - panelWidth - pad);
  }
  const top = Math.max(
    pad,
    Math.min(targetTop, Math.max(pad, canvasHeight - panelHeight - pad)),
  );
  // Height is left to the content (auto): a short inspector (e.g. typography
  // only) should be a compact card, not a tall half-empty panel. The cap only
  // engages for long inspectors, at which point the scroll body takes over.
  return {
    left,
    top,
    width: panelWidth,
    maxHeight: panelHeight,
  };
}

// Anchors the hover "edit params" affordance to the top-right corner of the
// hovered element, just inside its bounds so moving the cursor from the
// element onto the icon does not drop the hover. Uses the same iframe→canvas
// coordinate basis as the floating inspector panel.
function manualEditHoverIconStyle(
  target: ManualEditTarget,
  previewScale: number,
  canvasSize: PreviewCanvasSize | undefined,
): CSSProperties {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  const iconSize = 26;
  const inset = 4;
  const canvasWidth = canvasSize?.width ?? 1200;
  const canvasHeight = canvasSize?.height ?? 800;
  const targetTop = target.rect.y * scale;
  const targetRight = (target.rect.x + target.rect.width) * scale;
  const left = Math.max(
    inset,
    Math.min(targetRight - iconSize - inset, canvasWidth - iconSize - inset),
  );
  const top = Math.max(
    inset,
    Math.min(targetTop + inset, canvasHeight - iconSize - inset),
  );
  return { left, top, width: iconSize, height: iconSize };
}

export function cancelManualEditPendingStyleSnapshot(
  pending: ManualEditPendingStyleSave | null,
  id: string,
  keys: Array<keyof ManualEditStyles>,
): ManualEditPendingStyleSave | null {
  if (!pending || pending.id !== id || keys.length === 0) return pending;
  const nextStyles = { ...pending.styles };
  for (const key of keys) delete nextStyles[key];
  if (Object.keys(nextStyles).length === 0) return null;
  return { ...pending, styles: nextStyles };
}

function usePreviewCanvasSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<PreviewCanvasSize | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: rect.width,
        height: rect.height,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      });
    };
    measure();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  return [ref, size] as const;
}

function ensureMarkdownCodeBlockControls(root: HTMLElement, t: TranslateFn) {
  for (const block of root.querySelectorAll<HTMLElement>(`[${MARKDOWN_CODE_BLOCK_ATTR}]`)) {
    let button = block.querySelector<HTMLButtonElement>(`.${MARKDOWN_COPY_BUTTON_CLASS}`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = MARKDOWN_COPY_BUTTON_CLASS;
      const blockId = block.getAttribute(MARKDOWN_CODE_BLOCK_ATTR) ?? '';
      button.setAttribute(MARKDOWN_COPY_BLOCK_ATTR, blockId);
      block.prepend(button);
    }
    setMarkdownCodeBlockCopiedState(block, false, t);
  }
}

function setSlideStateCached(key: string, state: SlideState) {
  htmlPreviewSlideState.set(key, state);
  if (htmlPreviewSlideState.size > MAX_CACHED_SLIDE_STATES) {
    const oldest = htmlPreviewSlideState.keys().next().value;
    if (oldest != null) htmlPreviewSlideState.delete(oldest);
  }
}

function waitForIframeLoadOrTimeout(iframe: HTMLIFrameElement, timeout = 750): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      iframe.removeEventListener('load', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeout);
    iframe.addEventListener('load', finish, { once: true });
  });
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function temporarilyExposeIframeForSnapshot(iframe: HTMLIFrameElement): () => void {
  const previousVisibility = iframe.style.visibility;
  const previousOpacity = iframe.style.opacity;
  const previousPointerEvents = iframe.style.pointerEvents;
  iframe.style.visibility = 'visible';
  iframe.style.opacity = '0.001';
  iframe.style.pointerEvents = 'none';
  return () => {
    iframe.style.visibility = previousVisibility;
    iframe.style.opacity = previousOpacity;
    iframe.style.pointerEvents = previousPointerEvents;
  };
}

async function requestPreviewSnapshotWithRetry(iframe: HTMLIFrameElement): Promise<Awaited<ReturnType<typeof requestPreviewSnapshot>>> {
  const timeouts = [1500, 3000, 6000];
  for (const timeout of timeouts) {
    const snapshot = await requestPreviewSnapshot(iframe, timeout);
    if (snapshot) return snapshot;
    await waitForAnimationFrame();
  }
  return null;
}

function previewViewportStateKey(projectId: string, file: Pick<ProjectFile, 'name' | 'path'>): string {
  return `${projectId}:${file.path || file.name}`;
}

function setPreviewViewportCached(key: string, viewport: PreviewViewportId) {
  htmlPreviewViewportState.set(key, viewport);
  if (htmlPreviewViewportState.size > MAX_CACHED_PREVIEW_VIEWPORTS) {
    const oldest = htmlPreviewViewportState.keys().next().value;
    if (oldest != null) htmlPreviewViewportState.delete(oldest);
  }
}

interface Props {
  projectId: string;
  projectKind: ViewerProjectKind;
  file: ProjectFile;
  liveHtml?: string;
  filesRefreshKey?: number;
  isDeck?: boolean;
  streaming?: boolean;
  commentQueueOnSend?: boolean;
  commentSendDisabled?: boolean;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[]) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[], images?: File[]) => Promise<boolean | void> | boolean | void;
  onFileSaved?: () => Promise<void> | void;
  // Open `openName` as a tab (focusing it) and close `closeName` in one
  // atomic tab-state update. The React module pointer uses this to jump to the
  // HTML entry that renders a module and drop the dead-end module tab.
  onOpenFileReplacing?: (openName: string, closeName: string) => void;
  commentPortalId?: string;
  onCommentModeChange?: (active: boolean) => void;
  // Bumped nonce asking this viewer to open its Download/Export menu (chat-side
  // "Download" next-step action).
  downloadRequest?: { nonce: number } | null;
  // Bumped nonce asking a deck preview to flip to `slideIndex` (a queued chat
  // send for this file just started processing).
  slideNavRequest?: { slideIndex: number; nonce: number } | null;
}

export function FileViewer({
  projectId,
  projectKind,
  file,
  liveHtml,
  filesRefreshKey = 0,
  isDeck,
  streaming,
  commentQueueOnSend = false,
  commentSendDisabled = false,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  onFileSaved,
  onOpenFileReplacing,
  commentPortalId,
  onCommentModeChange,
  downloadRequest,
  slideNavRequest,
}: Props) {
  const rendererMatch = artifactRendererRegistry.resolve({
    file,
    isDeckHint: Boolean(isDeck),
  });

  if (rendererMatch?.renderer.id === 'html' || rendererMatch?.renderer.id === 'deck-html') {
    return (
      <HtmlViewer
        projectId={projectId}
        projectKind={projectKind}
        file={file}
        liveHtml={liveHtml}
        filesRefreshKey={filesRefreshKey}
        isDeck={rendererMatch.renderer.id === 'deck-html'}
        streaming={Boolean(streaming)}
        commentQueueOnSend={commentQueueOnSend}
        commentSendDisabled={commentSendDisabled}
        previewComments={previewComments}
        onSavePreviewComment={onSavePreviewComment}
        onRemovePreviewComment={onRemovePreviewComment}
        onSendBoardCommentAttachments={onSendBoardCommentAttachments}
        onFileSaved={onFileSaved}
        commentPortalId={commentPortalId}
        onCommentModeChange={onCommentModeChange}
        downloadRequest={downloadRequest}
        slideNavRequest={slideNavRequest}
      />
    );
  }
  if (rendererMatch?.renderer.id === 'react-component') {
    return (
      <ReactComponentViewer
        projectId={projectId}
        file={file}
        onOpenFileReplacing={onOpenFileReplacing}
      />
    );
  }
  if (rendererMatch?.renderer.id === 'markdown') {
    return (
      <MarkdownViewer
        projectId={projectId}
        file={file}
        onFileSaved={onFileSaved}
      />
    );
  }
  if (rendererMatch?.renderer.id === 'svg') {
    return <SvgViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'image') {
    return <ImageViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'video') {
    return <VideoViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'audio') {
    return <AudioViewer projectId={projectId} file={file} />;
  }
  // Atomistic structure / trajectory files (.cif, .xyz, POSCAR, .traj, …)
  // default to the MatterViz 3D viewer with a text-mode toggle. Checked
  // before the text/code branch because these are mostly plain-text formats.
  {
    const structureKind = structureViewKind(file.name);
    if (structureKind) {
      return <StructureFileViewer projectId={projectId} file={file} viewKind={structureKind} />;
    }
  }
  // Workflow definitions get their interactive canvas only as the ACTIVE
  // workspace tab (FileWorkspace renders WorkflowEditor there); any other
  // surface that lands here shows the raw JSON read-only.
  if (file.kind === 'text' || file.kind === 'code' || file.kind === 'workflow') {
    return <TextViewer projectId={projectId} file={file} />;
  }
  // PDFs render for real (pdf.js canvas + selectable text layer + zoom),
  // reader-style — not the text-extraction outline used for office docs.
  if (file.kind === 'pdf') {
    return <PdfFileViewer projectId={projectId} file={file} />;
  }
  if (
    file.kind === 'document' ||
    file.kind === 'presentation' ||
    file.kind === 'spreadsheet'
  ) {
    return <DocumentPreviewViewer projectId={projectId} file={file} />;
  }
  return (
    <AutodetectingBinaryViewer
      key={`${projectId}:${file.name}:${file.size}:${file.mtime}`}
      projectId={projectId}
      file={file}
    />
  );
}

function exportReadyNudgeKey(projectId: string, fileName: string): string {
  return `${EXPORT_READY_NUDGE_STORAGE_PREFIX}${projectId}:${fileName}`;
}

function hasSeenExportReadyNudge(projectId: string, fileName: string): boolean {
  try {
    return window.sessionStorage.getItem(exportReadyNudgeKey(projectId, fileName)) === '1';
  } catch {
    return false;
  }
}

function markExportReadyNudgeSeen(projectId: string, fileName: string) {
  try {
    window.sessionStorage.setItem(exportReadyNudgeKey(projectId, fileName), '1');
  } catch {
    // Ignore storage-denied contexts; the in-memory state still prevents loops.
  }
}

interface RefreshStatusDescriptor {
  label: string;
  tone: 'neutral' | 'running' | 'success' | 'warning' | 'error';
  description: string;
}

function FileActions({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  return (
    <div className="viewer-toolbar-actions">
      <a
        className="ghost-link"
        href={projectDownloadUrl(projectId, file.name)}
        download={file.name}
      >
        {t('fileViewer.download')}
      </a>
      <a
        className="ghost-link"
        href={projectFileUrl(projectId, file.name)}
        target="_blank"
        rel="noreferrer noopener"
      >
        {t('fileViewer.open')}
      </a>
    </div>
  );
}

function formatVersionDateTime(value: number | undefined, locale: Locale): string {
  const date = new Date(Number(value) || Date.now());
  try {
    return date.toLocaleString(locale, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toLocaleString();
  }
}

function isHtmlVersionableFile(file: ProjectFile): boolean {
  return file.kind === 'html' || /\.html?$/i.test(file.name);
}

function fileVersionSourceLabel(version: ProjectFileVersion, t: TranslateFn): string {
  if (version.source === 'manual') return t('fileViewer.versions.sourceManual');
  if (version.source === 'restore') return t('fileViewer.versions.sourceRestore');
  return t('fileViewer.versions.sourceAi');
}

function fileVersionSourceClassName(version: ProjectFileVersion): string {
  if (version.source === 'manual') return 'manual';
  if (version.source === 'restore') return 'restore';
  return 'ai';
}


export function fileVersionPreviewOptions(
  projectId: string,
  fileName: string,
  source: string | null | undefined,
) {
  return {
    deck: sourceLooksLikeExportableDeck(source),
    baseHref: projectRawUrl(projectId, baseDirFor(fileName)),
  };
}

function FileVersionManagerModal({
  projectId,
  file,
  currentSource,
  onClose,
  onRestored,
}: {
  projectId: string;
  file: ProjectFile;
  currentSource: string | null;
  onClose: () => void;
  onRestored: (content: string, version: ProjectFileVersion) => Promise<void> | void;
}) {
  const { locale, t } = useI18n();
  const tRef = useRef(t);
  const [versions, setVersions] = useState<ProjectFileVersion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(currentSource);
  const [selectedContentVersionId, setSelectedContentVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [previewViewport, setPreviewViewport] = useState<PreviewViewportId>('desktop');
  const [search, setSearch] = useState('');
  const [promptOpen, setPromptOpen] = useState(false);
  const promptWrapRef = useRef<HTMLDivElement | null>(null);
  const promptPopoverId = useId();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const restoreWrapRef = useRef<HTMLDivElement | null>(null);
  const restorePopoverId = useId();
  const [previewFrameRef, previewFrameSize] = usePreviewCanvasSize<HTMLDivElement>();
  // Track which srcDoc the iframe has finished rendering. Deriving readiness by
  // comparing to the current srcDoc during render (rather than toggling a bool
  // in a post-paint effect) keeps the overlay up across a switch with no
  // one-frame flicker while the new document reparses.
  const [loadedSrcDoc, setLoadedSrcDoc] = useState<string | null>(null);
  // Client-side cache of fetched version HTML keyed by version id. Revisiting a
  // version is then zero-fetch (and, because the srcDoc string value is stable,
  // zero-reparse). `inFlightRef` dedupes concurrent hover-prefetch + click.
  const contentCacheRef = useRef<Map<string, string>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const versionById = useMemo(() => {
    const map = new Map<string, ProjectFileVersion>();
    for (const version of versions) map.set(version.id, version);
    return map;
  }, [versions]);
  const selectedVersion =
    (selectedId ? versionById.get(selectedId) : undefined) ??
    versions.find((version) => version.current) ??
    versions[0] ??
    null;
  const versionCountLabel = versions.length === 1
    ? t('fileViewer.versions.countOne')
    : t('fileViewer.versions.countMany', { count: versions.length });
  // Show the filter box only once the list is long enough to need it.
  const showSearch = versions.length > 3;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleVersions = useMemo(() => {
    if (!showSearch || !normalizedSearch) return versions;
    return versions.filter((version) => {
      const restoredFrom = version.restoreFromVersionId
        ? versionById.get(version.restoreFromVersionId)
        : null;
      const haystack = [
        `v${version.version}`,
        `version ${version.version}`,
        version.prompt ?? '',
        version.label ?? '',
        fileVersionSourceLabel(version, t),
        formatVersionDateTime(version.createdAt, locale),
        restoredFrom ? `v${restoredFrom.version}` : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [showSearch, normalizedSearch, versions, versionById, t, locale]);
  // Decks are 16:9; the desktop preview centers them in an aspect box (see the
  // `.preview-viewport-deck` CSS) instead of letting the slide bottom-anchor in
  // a taller pane. Cheap source sniff, memoized on the selected content.
  const isDeckPreview = useMemo(
    () =>
      Boolean(
        selectedContent && fileVersionPreviewOptions(projectId, file.name, selectedContent).deck,
      ),
    [selectedContent, projectId, file.name],
  );
  const selectedPrompt = selectedVersion?.prompt?.trim() ?? '';
  const selectedDate = selectedVersion ? formatVersionDateTime(selectedVersion.createdAt, locale) : file.name;
  const selectedRestoredFrom = selectedVersion?.restoreFromVersionId
    ? versionById.get(selectedVersion.restoreFromVersionId)
    : null;
  const selectedContentMatchesVersion = Boolean(selectedId && selectedContentVersionId === selectedId && selectedContent);
  const restoreDisabled =
    !selectedVersion || selectedVersion.current || restoring || loadingContent || !selectedContentMatchesVersion;
  const srcDoc = useMemo(() => {
    if (!selectedContent) return '';
    const previewOptions = fileVersionPreviewOptions(projectId, file.name, selectedContent);
    return buildSrcdoc(selectedContent, {
      ...previewOptions,
      previewFocusGuard: true,
    });
  }, [file.name, projectId, selectedContent]);
  const frameReady = loadedSrcDoc === srcDoc;

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Fetch a single version's HTML into the cache exactly once. Reused by the
  // selection effect and by hover/focus prefetch so a click lands on warm data.
  const primeVersionContent = useCallback((versionId: string): Promise<void> => {
    if (contentCacheRef.current.has(versionId)) return Promise.resolve();
    const pending = inFlightRef.current.get(versionId);
    if (pending) return pending;
    const request = fetchProjectFileVersion(projectId, file.name, versionId)
      .then((result) => {
        if (result) contentCacheRef.current.set(versionId, result.content);
      })
      .catch(() => {})
      .finally(() => {
        inFlightRef.current.delete(versionId);
      });
    inFlightRef.current.set(versionId, request);
    return request;
  }, [file.name, projectId]);

  const loadVersions = useCallback(async (preferredId?: string | null) => {
    setLoading(true);
    setError(null);
    const result = await fetchProjectFileVersions(projectId, file.name);
    if (!result) {
      setError(tRef.current('fileViewer.versions.loadFailed'));
      setLoading(false);
      return;
    }
    const nextVersions = [...result.versions].sort((a, b) => b.version - a.version);
    setVersions(nextVersions);
    // Seed the cache with the live document so opening the modal renders the
    // current version instantly — no round-trip for the version you're on.
    const currentVersion = nextVersions.find((version) => version.current);
    if (currentVersion && currentSource != null && !contentCacheRef.current.has(currentVersion.id)) {
      contentCacheRef.current.set(currentVersion.id, currentSource);
    }
    const nextSelected =
      (preferredId ? nextVersions.find((version) => version.id === preferredId) : null) ??
      currentVersion ??
      nextVersions[0] ??
      null;
    setSelectedId(nextSelected?.id ?? null);
    setLoading(false);
  }, [currentSource, file.name, projectId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  useEffect(() => {
    setCopied(false);
    setConfirmRestore(false);
    setPromptOpen(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedContent(null);
      setSelectedContentVersionId(null);
      return;
    }
    // Cache hit: swap instantly with no fetch, no flash.
    const cached = contentCacheRef.current.get(selectedId);
    if (cached !== undefined) {
      setSelectedContent(cached);
      setSelectedContentVersionId(selectedId);
      setLoadingContent(false);
      setError(null);
      return;
    }
    // Cache miss: keep the previous preview mounted under the loading overlay
    // (do NOT clear selectedContent) so switching never blanks to white.
    let cancelled = false;
    setLoadingContent(true);
    setError(null);
    void primeVersionContent(selectedId).then(() => {
      if (cancelled) return;
      const next = contentCacheRef.current.get(selectedId);
      if (next === undefined) {
        setSelectedContent(null);
        setSelectedContentVersionId(null);
        setError(tRef.current('fileViewer.versions.previewFailed'));
      } else {
        setSelectedContent(next);
        setSelectedContentVersionId(selectedId);
      }
      setLoadingContent(false);
    });
    return () => {
      cancelled = true;
    };
  }, [primeVersionContent, selectedId]);

  // Safety net: if the iframe's load event is ever missed, clear the overlay
  // after a grace period so it can't get stuck over a rendered document.
  useEffect(() => {
    if (!srcDoc || loadedSrcDoc === srcDoc) return;
    const fallback = window.setTimeout(() => setLoadedSrcDoc(srcDoc), 6000);
    return () => window.clearTimeout(fallback);
  }, [srcDoc, loadedSrcDoc]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmRestore) {
        setConfirmRestore(false);
        return;
      }
      if (promptOpen) {
        setPromptOpen(false);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, promptOpen, confirmRestore]);

  useEffect(() => {
    if (!promptOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!promptWrapRef.current) return;
      if (!promptWrapRef.current.contains(event.target as Node)) setPromptOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [promptOpen]);

  useEffect(() => {
    if (!confirmRestore) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!restoreWrapRef.current) return;
      if (!restoreWrapRef.current.contains(event.target as Node)) setConfirmRestore(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [confirmRestore]);

  async function copyPrompt() {
    if (!selectedPrompt) return;

    const ok = await copyToClipboard(selectedPrompt);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function openVersionInNewTab() {
    if (loadingContent || !selectedContentMatchesVersion || !selectedContent || !selectedVersion) return;

    openSandboxedPreviewInNewTab(
      selectedContent,
      `${file.name} · v${selectedVersion.version}`,
      fileVersionPreviewOptions(projectId, file.name, selectedContent),
    );
  }

  async function restoreVersion() {
    if (restoreDisabled || !selectedVersion || !selectedContentMatchesVersion || !selectedContent) return;
    setRestoring(true);
    setError(null);
    let closingAfterRestore = false;
    // `versions` is sorted newest-first, so the index is "how many versions
    // back from the newest" the restore target sits.
    const fireRestoreResult = (result: 'success' | 'failed', errorCode?: string) => {

    };
    try {
      const result = await restoreProjectFileVersion(projectId, file.name, selectedVersion);
      if (!result) {

        setError(t('fileViewer.versions.restoreFailed'));
        return;
      }

      const restoredVersion = result.version ?? selectedVersion;
      await onRestored(selectedContent, restoredVersion);
      if (result.versionWarning) {
        await loadVersions(result.version?.id ?? selectedVersion.id);
        setError(result.versionWarning.message);
        return;
      }
      closingAfterRestore = true;
      onClose();
    } finally {
      if (!closingAfterRestore) setRestoring(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop viewer-modal-backdrop file-version-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="file-version-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('fileViewer.versions.title')}
      >
        <div className="file-version-sidebar">
          <div className="file-version-sidebar-head">
            <span className="file-version-count">{versionCountLabel}</span>
          </div>
          {showSearch ? (
            <div className="file-version-search">
              <RemixIcon name="search-line" size={14} />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('common.searchEllipsis')}
                aria-label={t('common.searchEllipsis')}
              />
              {search ? (
                <button
                  type="button"
                  className="file-version-search-clear"
                  aria-label={t('common.clear')}
                  onClick={() => setSearch('')}
                >
                  <RemixIcon name="close-line" size={14} />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="file-version-list" role="listbox" aria-label={t('fileViewer.versions.listAria')}>
            {loading ? (
              <div
                className="file-version-skeleton-list"
                role="status"
                aria-label={t('fileViewer.versions.loading')}
              >
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="file-version-skeleton-item" aria-hidden="true">
                    <div className="file-version-skeleton-row">
                      <span className="file-version-skeleton-line badge" />
                      <span className="file-version-skeleton-line time" />
                    </div>
                    <span className="file-version-skeleton-line title" />
                    <span className="file-version-skeleton-line meta" />
                  </div>
                ))}
              </div>
            ) : versions.length === 0 ? (
              <div className="file-version-empty">{t('fileViewer.versions.empty')}</div>
            ) : visibleVersions.length === 0 ? (
              <div className="file-version-empty">{t('homeHero.noResults', { query: search.trim() })}</div>
            ) : (
              visibleVersions.map((version) => {
                const selected = version.id === selectedVersion?.id;
                const itemRestoredFrom = version.restoreFromVersionId
                  ? versionById.get(version.restoreFromVersionId)
                  : null;
                const prefetch = () => {
                  void primeVersionContent(version.id);
                };
                return (
                  <button
                    key={version.id}
                    type="button"
                    className={`file-version-item${selected ? ' active' : ''}`}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      if (!selected) {

                      }
                      setSelectedId(version.id);
                    }}
                    onMouseEnter={prefetch}
                    onFocus={prefetch}
                  >
                    <span className="file-version-item-top">
                      {version.current ? (
                        <span className="file-version-current-badge">{t('fileViewer.versions.current')}</span>
                      ) : null}
                      <span className={`file-version-source-badge ${fileVersionSourceClassName(version)}`}>
                        {fileVersionSourceLabel(version, t)}
                      </span>
                      <span className="file-version-time">
                        {formatVersionDateTime(version.createdAt, locale)}
                      </span>
                    </span>
                    <span className="file-version-item-title">
                      {version.prompt || version.label || t('fileViewer.versions.versionLabel', { version: version.version })}
                    </span>
                    <span className="file-version-item-meta">
                      {t('fileViewer.versions.versionLabel', { version: version.version })}
                      {itemRestoredFrom ? (
                        <span className="file-version-item-restored">
                          {t('fileViewer.versions.restoredFrom', { version: itemRestoredFrom.version })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="file-version-main">
          <header className="file-version-head">
            <div className="file-version-meta">
              <div className="file-version-meta-row">
                {selectedVersion?.current ? (
                  <span className="file-version-current-badge">{t('fileViewer.versions.current')}</span>
                ) : null}
                {selectedVersion ? (
                  <span className={`file-version-source-badge ${fileVersionSourceClassName(selectedVersion)}`}>
                    {fileVersionSourceLabel(selectedVersion, t)}
                  </span>
                ) : null}
                <span className="file-version-selected-date">{selectedDate}</span>
                {selectedRestoredFrom ? (
                  <span className="file-version-restored-from">
                    {t('fileViewer.versions.restoredFrom', { version: selectedRestoredFrom.version })}
                  </span>
                ) : null}
                <div
                  className="file-version-prompt-popover-wrap"
                  ref={promptWrapRef}
                >
                  <button
                    type="button"
                    className={`file-version-prompt-toggle${promptOpen ? ' active' : ''}`}
                    aria-expanded={promptOpen}
                    aria-controls={promptOpen ? promptPopoverId : undefined}
                    disabled={!selectedVersion}
                    onClick={() => {
                      if (!promptOpen) {

                      }
                      setPromptOpen((value) => !value);
                    }}
                  >
                    <RemixIcon name="chat-3-line" size={15} />
                    <span>{t('fileViewer.versions.promptTitle')}</span>
                    <RemixIcon name="arrow-down-s-line" size={14} />
                  </button>
                  {promptOpen ? (
                    <section
                      className="file-version-prompt-popover"
                      id={promptPopoverId}
                      role="region"
                      aria-label={t('fileViewer.versions.promptTitle')}
                    >
                      <div className="file-version-prompt-head">
                        <h3>{t('fileViewer.versions.promptTitle')}</h3>
                        <button
                          type="button"
                          className="viewer-action file-version-copy-prompt"
                          disabled={!selectedPrompt}
                          onClick={copyPrompt}
                        >
                          <RemixIcon name="file-copy-line" size={14} />
                          <span>{copied ? t('fileViewer.copied') : t('fileViewer.versions.copyPrompt')}</span>
                        </button>
                      </div>
                      <p>{selectedPrompt || t('fileViewer.versions.noPromptBody')}</p>
                    </section>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="file-version-actions">
              {selectedVersion && !selectedVersion.current ? (
                <div className="file-version-restore-wrap" ref={restoreWrapRef}>
                  <button
                    type="button"
                    className={`viewer-action primary file-version-restore-action${confirmRestore ? ' active' : ''}`}
                    disabled={restoreDisabled}
                    aria-haspopup="dialog"
                    aria-expanded={confirmRestore}
                    aria-controls={confirmRestore ? restorePopoverId : undefined}
                    onClick={() => {
                      if (!confirmRestore) {

                      }
                      setConfirmRestore((value) => !value);
                    }}
                  >
                    <RemixIcon name={restoring ? 'loader-4-line' : 'git-branch-line'} size={14} />
                    <span>
                      {restoring
                        ? t('fileViewer.versions.restoring')
                        : t('fileViewer.versions.restore')}
                    </span>
                  </button>
                  {confirmRestore ? (
                    <div
                      className="file-version-restore-confirm"
                      id={restorePopoverId}
                      role="dialog"
                      aria-label={t('fileViewer.versions.restoreConfirmTitle')}
                    >
                      <h3>{t('fileViewer.versions.restoreConfirmTitle')}</h3>
                      <p>{t('fileViewer.versions.restoreHelp')}</p>
                      <div className="file-version-restore-confirm-actions">
                        <button
                          type="button"
                          className="viewer-action"
                          onClick={() => {

                            setConfirmRestore(false);
                          }}
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          className="viewer-action primary"
                          disabled={restoreDisabled}
                          onClick={() => {

                            setConfirmRestore(false);
                            void restoreVersion();
                          }}
                        >
                          {t('fileViewer.versions.restoreConfirmCta')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <FileVersionViewportControls
                viewport={previewViewport}
                onViewport={(viewport) => {
                  if (viewport !== previewViewport) {

                  }
                  setPreviewViewport(viewport);
                }}
                t={t}
              />
              <button
                type="button"
                className="viewer-action viewer-action-icon od-tooltip"
                aria-label={t('fileViewer.versions.open')}
                title={t('fileViewer.versions.open')}
                data-tooltip={t('fileViewer.versions.open')}
                data-tooltip-placement="bottom"
                disabled={!selectedContentMatchesVersion || loadingContent}
                onClick={openVersionInNewTab}
              >
                <RemixIcon name="external-link-line" size={15} />
              </button>
              <button
                type="button"
                className="viewer-action viewer-action-icon od-tooltip"
                aria-label={t('common.close')}
                title={t('common.close')}
                data-tooltip={t('common.close')}
                data-tooltip-placement="bottom"
                onClick={onClose}
              >
                <RemixIcon name="close-line" size={16} />
              </button>
            </div>
          </header>
          <div className="file-version-preview" ref={previewFrameRef}>
            {error ? (
              <div className="viewer-empty" role="alert">{error}</div>
            ) : (
              <>
                {srcDoc ? (
                  <div
                    className={`preview-viewport preview-viewport-${previewViewport}${isDeckPreview ? ' preview-viewport-deck' : ''}`}
                    style={previewViewportStyle(previewViewport, 1, previewFrameSize, { canvasPadding: 24 })}
                  >
                    <div className="preview-frame-clip">
                      <div style={previewScaleShellStyle(previewViewport, 1)}>
                        <iframe
                          title={selectedVersion ? `${file.name} v${selectedVersion.version}` : file.name}
                          sandbox="allow-scripts allow-downloads"
                          srcDoc={srcDoc}
                          onLoad={() => setLoadedSrcDoc(srcDoc)}
                        />
                      </div>
                    </div>
                  </div>
                ) : !loading && !loadingContent ? (
                  <div className="viewer-empty">{t('fileViewer.versions.previewLoading')}</div>
                ) : null}
                {loading || loadingContent || (srcDoc && !frameReady) ? (
                  <div
                    className="file-version-preview-overlay"
                    role="status"
                    aria-label={t('fileViewer.versions.previewLoading')}
                  >
                    <span className="file-version-preview-spinner" aria-hidden="true" />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatCommentTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('common.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t('common.minutesAgo', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('common.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('common.daysAgo', { n: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t('common.weeksAgo', { n: weeks });
  return new Date(ts).toLocaleDateString();
}

function commentActivityAt(comment: PreviewComment): number {
  return Math.max(
    Number.isFinite(comment.updatedAt) ? comment.updatedAt : 0,
    Number.isFinite(comment.createdAt) ? comment.createdAt : 0,
  );
}

function commentCreatedAt(comment: PreviewComment): number {
  return Number.isFinite(comment.createdAt) ? comment.createdAt : commentActivityAt(comment);
}

function commentTargetIntersectsPreview(
  target: PreviewCommentSnapshot | null,
  scale: number,
  offset: { x: number; y: number },
  bounds?: PreviewCanvasSize,
): boolean {
  if (!target || !bounds?.width || !bounds.height) return true;
  const rect = overlayBoundsFromSnapshot(target, scale, offset);
  const margin = 8;
  return (
    rect.left + rect.width > margin &&
    rect.top + rect.height > margin &&
    rect.left < bounds.width - margin &&
    rect.top < bounds.height - margin
  );
}

function commentDisplayLabel(comment: PreviewComment, t: TranslateFn): string {
  if (comment.elementId.startsWith('pin-')) return t('chat.comments.pin');
  const label = String(comment.label || '').trim().toLowerCase();
  const htmlHint = String(comment.htmlHint || '').trim().toLowerCase();
  const elementId = String(comment.elementId || '').trim().toLowerCase();
  const source = `${label} ${htmlHint} ${elementId}`;
  if (/\b(?:img|picture|video|canvas|svg)\b/.test(source)) return t('chat.comments.targetImage');
  if (/\b(?:button|input|textarea|select|label)\b/.test(source)) return t('chat.comments.targetControl');
  if (/^<a\b/.test(htmlHint)) return t('chat.comments.targetLink');
  if (/\b(?:h1|h2|h3|h4|h5|h6|p|span|strong|em|small|li|dt|dd)\b/.test(source)) return t('chat.comments.targetText');
  if (/\b(?:section|main|header|footer|nav|article|aside)\b/.test(source)) return t('chat.comments.targetSection');
  if (label.endsWith('.html') || elementId.startsWith('file-comment-')) return t('chat.comments.targetPage');
  if (comment.text.trim()) return t('chat.comments.targetText');
  return t('chat.comments.targetArea');
}

export function CommentSidePanel({
  comments,
  projectId,
  selectedIds,
  activeCommentId,
  collapsed,
  onCollapsedChange,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onReorder,
  onReply,
  onSendSelected,
  onCreateComment,
  sending,
  queueOnSend = false,
  sendDisabled = false,
  renderCreateForm = true,
  t,
  composer,
}: {
  comments: PreviewComment[];
  projectId?: string;
  selectedIds: Set<string>;
  activeCommentId: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onToggleSelect: (commentId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onReorder?: (orderedIds: string[]) => void;
  onReply: (comment: PreviewComment) => void;
  onSendSelected: () => void | Promise<void>;
  onCreateComment?: (note: string) => boolean | Promise<boolean>;
  sending: boolean;
  queueOnSend?: boolean;
  sendDisabled?: boolean;
  renderCreateForm?: boolean;
  t: TranslateFn;
  composer?: ReactNode;
}) {
  const [newCommentDraft, setNewCommentDraft] = useState('');
  const [dragState, setDragState] = useState<CommentSideDragState | null>(null);
  const sorted = comments;
  const visibleSelectedIds = new Set(comments.filter((comment) => selectedIds.has(comment.id)).map((comment) => comment.id));
  const selectedCount = visibleSelectedIds.size;
  const allSelected = comments.length > 0 && selectedCount === comments.length;
  const commentsLabel = t('chat.tabComments');
  const canCreateComment = Boolean(onCreateComment) && newCommentDraft.trim().length > 0 && !sending && !sendDisabled;
  const canReorder = Boolean(onReorder && sorted.length > 1);
  const collapsedRailRef = useRef<HTMLButtonElement | null>(null);
  const expandedToggleRef = useRef<HTMLButtonElement | null>(null);
  const pendingToggleFocusRef = useRef<'collapsed' | 'expanded' | null>(null);
  const panelId = useId();
  const handleDragStart = (event: ReactDragEvent<HTMLButtonElement>, comment: PreviewComment) => {
    if (!canReorder) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(COMMENT_SIDE_DRAG_MIME, comment.id);
    event.dataTransfer.setData('text/plain', comment.id);
    setDragState({ draggingId: comment.id, overId: comment.id, edge: null });
  };
  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    if (!canReorder) return;
    const draggingId = dragState?.draggingId || event.dataTransfer.getData(COMMENT_SIDE_DRAG_MIME);
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingId === targetId) {
      if (dragState?.overId !== targetId || dragState.edge !== null) {
        setDragState({ draggingId, overId: targetId, edge: null });
      }
      return;
    }
    const edge = commentSideDropEdgeForEvent(event);
    if (
      dragState?.draggingId !== draggingId ||
      dragState.overId !== targetId ||
      dragState.edge !== edge
    ) {
      setDragState({ draggingId, overId: targetId, edge });
    }
  };
  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    if (!canReorder) return;
    event.preventDefault();
    const draggingId =
      dragState?.draggingId ||
      event.dataTransfer.getData(COMMENT_SIDE_DRAG_MIME) ||
      event.dataTransfer.getData('text/plain');
    if (!draggingId || draggingId === targetId) {
      setDragState(null);
      return;
    }
    const edge = dragState?.overId === targetId && dragState.edge
      ? dragState.edge
      : commentSideDropEdgeForEvent(event);
    const nextIds = reorderPreviewCommentIds(sorted, draggingId, targetId, edge);
    if (nextIds.join('\0') !== sorted.map((comment) => comment.id).join('\0')) {
      onReorder?.(nextIds);
    }
    setDragState(null);
  };
  const submitNewComment = async () => {
    if (!onCreateComment || !newCommentDraft.trim()) return;
    const saved = await onCreateComment(newCommentDraft.trim());
    if (saved) setNewCommentDraft('');
  };

  useEffect(() => {
    const target =
      pendingToggleFocusRef.current === 'collapsed'
        ? collapsedRailRef.current
        : pendingToggleFocusRef.current === 'expanded'
          ? expandedToggleRef.current
          : null;
    if (!target) return;
    pendingToggleFocusRef.current = null;
    target.focus();
  }, [collapsed]);

  const handleCollapsedChange = (
    nextCollapsed: boolean,
    nextFocusTarget: 'collapsed' | 'expanded',
  ) => {
    pendingToggleFocusRef.current = nextFocusTarget;
    onCollapsedChange(nextCollapsed);
  };

  if (collapsed) {
    return (
      <button
        ref={collapsedRailRef}
        type="button"
        className="comment-side-rail"
        data-testid="comment-side-collapsed-rail"
        aria-label={t('preview.showSidebar', { label: commentsLabel })}
        aria-expanded={false}
        title={t('preview.showSidebar', { label: commentsLabel })}
        onClick={() => handleCollapsedChange(false, 'expanded')}
      >
        <RemixIcon name="message-3-line" size={15} />
        <span>{commentsLabel}</span>
        {comments.length > 0 ? <strong>{comments.length}</strong> : null}
      </button>
    );
  }

  return (
    <aside id={panelId} className="comment-side-panel" data-testid="comment-side-panel" aria-label={commentsLabel}>
      <div className="comment-side-header">
        <div className="comment-side-title">
          <RemixIcon name="message-3-line" size={15} />
          <span>{commentsLabel}</span>
        </div>
        <div className="comment-side-header-actions">
          {comments.length > 0 ? (
            <button
              type="button"
              className="comment-side-select-all"
              disabled={allSelected}
              onClick={onSelectAll}
            >
              {t('chat.comments.selectAll')}
            </button>
          ) : null}
          <button
            ref={expandedToggleRef}
            type="button"
            className="comment-side-collapse"
            aria-label={t('preview.hideSidebar', { label: commentsLabel })}
            aria-controls={panelId}
            aria-expanded={true}
            title={t('preview.hideSidebar', { label: commentsLabel })}
            onClick={() => handleCollapsedChange(true, 'collapsed')}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </div>
      <div
        className="comment-side-list"
        onDragLeave={(event) => {
          const related = event.relatedTarget;
          if (related instanceof Node && event.currentTarget.contains(related)) return;
          setDragState(null);
        }}
      >
        {sorted.length === 0 ? (
          <div className="comment-side-empty">
            {t('chat.comments.emptySaved')}
          </div>
        ) : sorted.map((comment, index) => {
          const selected = visibleSelectedIds.has(comment.id);
          const active = comment.id === activeCommentId;
          const isDragging = dragState?.draggingId === comment.id;
          const dropClass = dragState?.overId === comment.id &&
            dragState.draggingId !== comment.id &&
            dragState.edge
            ? ` comment-side-item-drop-${dragState.edge}`
            : '';
          return (
            <div
              key={comment.id}
              className={`comment-side-item${selected ? ' selected' : ''}${active ? ' active' : ''}${isDragging ? ' dragging' : ''}${dropClass}`}
              data-testid="comment-side-item"
              data-comment-id={comment.id}
              aria-current={active ? 'true' : undefined}
              role="button"
              tabIndex={0}
              onDragOver={(event) => handleDragOver(event, comment.id)}
              onDrop={(event) => handleDrop(event, comment.id)}
              onClick={() => onReply(comment)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onReply(comment);
              }}
            >
              <div className="comment-side-item-head">
                <button
                  type="button"
                  className="comment-side-drag-handle"
                  title={t('chat.queuedReorder')}
                  aria-label={t('chat.queuedReorder')}
                  draggable={canReorder}
                  disabled={!canReorder}
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => handleDragStart(event, comment)}
                  onDragEnd={() => setDragState(null)}
                >
                  <Icon name="grip-vertical" size={13} />
                </button>
                <span className="comment-side-author">
                  <strong>{`${index + 1}. ${commentDisplayLabel(comment, t)}`}</strong>
                </span>
                <span className="comment-side-time">{formatCommentTime(commentActivityAt(comment), t)}</span>
                <button
                  type="button"
                  className={`comment-side-check${selected ? ' checked' : ''}`}
                  aria-label={selected ? t('chat.comments.deselect') : t('chat.comments.select')}
                  aria-pressed={selected}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleSelect(comment.id);
                  }}
                >
                  {selected ? <Icon name="check" size={11} /> : null}
                </button>
              </div>
              <div className="comment-side-body">{comment.note}</div>
              {projectId && comment.attachments && comment.attachments.length > 0 ? (
                <div className="comment-side-attachments">
                  {comment.attachments.map((attachment) => {
                    const url = projectRawUrl(projectId, attachment.path);
                    return (
                      <a
                        key={attachment.path}
                        className="comment-side-attachment"
                        data-testid="comment-side-attachment"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={attachment.name}
                        title={attachment.name}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <img src={url} alt={attachment.name} />
                      </a>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {selectedCount > 0 ? (
        <div className="comment-side-selectbar" data-testid="comment-side-selectbar">
          <span className="comment-side-selectcount">{t('chat.comments.nSelected', { n: selectedCount })}</span>
          <Button variant="ghost" onClick={onClearSelection}>
            {t('chat.comments.clear')}
          </Button>
          <Button
            variant="primary"
            data-testid="comment-side-send-claude"
            disabled={sending || sendDisabled}
            onClick={() => void onSendSelected()}
          >
            {sending
              ? t('chat.comments.sending')
              : queueOnSend
                ? t('chat.annotationQueue')
                : t('chat.comments.sendToChat')}
          </Button>
        </div>
      ) : null}
      {composer ? <div className="comment-side-composer">{composer}</div> : null}
      {renderCreateForm && onCreateComment ? (
        <form
          className="comment-side-new-comment composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNewComment();
          }}
        >
          <div className="composer-shell comment-side-new-comment-shell">
            <div className="composer-input-wrap">
              <div className="composer-textarea-layer">
                <textarea
                  value={newCommentDraft}
                  placeholder={t('chat.comments.placeholder')}
                  aria-label={t('chat.comments.placeholder')}
                  onChange={(event) => setNewCommentDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void submitNewComment();
                    }
                  }}
                />
              </div>
            </div>
            <div className="composer-row comment-side-new-comment-actions">
              <button
                type="button"
                className="icon-btn"
                title={t('chat.attachTitle')}
                aria-label={t('chat.attachAria')}
                disabled
              >
                <Icon name="attach" size={15} />
              </button>
              <span className="composer-spacer" />
              <button
                type="submit"
                className={`composer-send${sending ? ' is-sending' : ''}`}
                disabled={!canCreateComment}
              >
                <Icon name="send" size={13} />
                <span>{sending ? t('chat.comments.sending') : t('chat.send')}</span>
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </aside>
  );
}

const COMMENT_SIDE_DRAG_MIME = 'application/x-open-design-preview-comment';

type CommentSideDropEdge = 'before' | 'after';

interface CommentSideDragState {
  draggingId: string;
  overId: string | null;
  edge: CommentSideDropEdge | null;
}

function commentSideDropEdgeForEvent(event: ReactDragEvent<HTMLElement>): CommentSideDropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function reorderPreviewCommentIds(
  comments: PreviewComment[],
  draggingId: string,
  targetId: string,
  edge: CommentSideDropEdge,
): string[] {
  const ids = comments.map((comment) => comment.id);
  const from = ids.indexOf(draggingId);
  if (from < 0) return ids;
  const [draggedId] = ids.splice(from, 1);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex < 0 || !draggedId) return comments.map((comment) => comment.id);
  ids.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId);
  return ids;
}

export function appendSavedPreviewCommentOrder(
  currentOrderIds: string[],
  visibleComments: Array<Pick<PreviewComment, 'id'>>,
  savedId: string,
): string[] {
  if (!savedId) return currentOrderIds;
  const visibleIds = visibleComments.map((comment) => comment.id);
  if (currentOrderIds.includes(savedId) || visibleIds.includes(savedId)) {
    return currentOrderIds;
  }
  const visibleIdSet = new Set(visibleIds);
  const kept = currentOrderIds.filter((id) => visibleIdSet.has(id));
  const missingVisibleIds = visibleIds.filter((id) => !kept.includes(id));
  const base = currentOrderIds.length > 0 ? [...kept, ...missingVisibleIds] : visibleIds;
  const next = [...base, savedId];
  return next.join('\0') === currentOrderIds.join('\0') ? currentOrderIds : next;
}

function CommentSideDock({
  comments,
  projectId,
  selectedIds,
  activeCommentId,
  collapsed,
  onCollapsedChange,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onReorder,
  onReply,
  onSendSelected,
  onCreateComment,
  sending,
  queueOnSend = false,
  sendDisabled = false,
  renderCreateForm = true,
  t,
  composer,
}: {
  comments: PreviewComment[];
  projectId?: string;
  selectedIds: Set<string>;
  activeCommentId: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onToggleSelect: (commentId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onReorder?: (orderedIds: string[]) => void;
  onReply: (comment: PreviewComment) => void;
  onSendSelected: () => void | Promise<void>;
  onCreateComment?: (note: string) => boolean | Promise<boolean>;
  sending: boolean;
  queueOnSend?: boolean;
  sendDisabled?: boolean;
  renderCreateForm?: boolean;
  t: TranslateFn;
  composer?: ReactNode;
}) {
  return (
    <div
      className={`comment-side-dock${collapsed ? ' collapsed' : ''}`}
      data-testid="comment-side-dock"
    >
      <CommentSidePanel
        comments={comments}
        projectId={projectId}
        selectedIds={selectedIds}
        activeCommentId={activeCommentId}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        onToggleSelect={onToggleSelect}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        onReorder={onReorder}
        onReply={onReply}
        onSendSelected={onSendSelected}
        onCreateComment={onCreateComment}
        sending={sending}
        queueOnSend={queueOnSend}
        sendDisabled={sendDisabled}
        renderCreateForm={renderCreateForm}
        t={t}
        composer={composer}
      />
    </div>
  );
}

// Maps a CSS computed value (e.g. "rgb(40, 50, 60)" or "16px") to a form
// input value. Browsers return colors as rgb()/rgba(); HTML <input type=color>
// only accepts "#rrggbb". Lengths come back as "12px" or "0px"; we strip
// units for slider binding and re-append on emit.
//
// Note: <input type=color> has no alpha channel, so an rgba() with alpha < 1
// is collapsed to its opaque RGB equivalent here. Most agent-generated HTML
// uses opaque colors, so this is a known cosmetic limitation — a
// semi-transparent source value will display in the panel as fully opaque.
function rgbToHex(value: string | undefined): string {
  if (!value) return '#000000';
  const v = value.trim();
  if (v.startsWith('#') && (v.length === 7 || v.length === 4)) {
    if (v.length === 4) {
      return '#' + [1, 2, 3].map((i) => {
        const c = v.charAt(i);
        return c + c;
      }).join('');
    }
    return v;
  }
  const m = v.match(/rgba?\(\s*([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i);
  if (!m) return '#000000';
  const toHex = (n: string) => {
    const x = Math.max(0, Math.min(255, Math.round(Number(n))));
    return x.toString(16).padStart(2, '0');
  };
  return '#' + toHex(m[1] ?? '0') + toHex(m[2] ?? '0') + toHex(m[3] ?? '0');
}

// Parse a CSS length to a number. Inspect's current sliders all clamp to a
// non-negative range (padding, font-size, border-radius), so we reject
// negatives at parse time too — otherwise a `-12px` source value would be
// silently floored to 0 by the slider clamp without the regex agreeing.
// If a future control needs negative values (e.g. margin), thread an
// explicit `allowNegative` flag rather than reintroducing `-?` here.
function pxToNumber(value: string | undefined): number {
  if (!value) return 0;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function InspectPanel({
  target,
  onApply,
  onResetElement,
  onSaveToSource,
  onClose,
  saving,
  savedAt,
  error,
}: {
  target: InspectTarget;
  onApply: (prop: string, value: string) => void;
  onResetElement: (elementId: string) => void;
  onSaveToSource: () => void;
  onClose: () => void;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
}) {
  // Local "draft" mirror of the most recent value the user picked, so
  // sliders/colors keep responding even before the iframe echoes back the
  // computed result. Reset whenever the selected element changes.
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft({});
  }, [target.elementId]);

  const value = (prop: string, fallback: string): string =>
    draft[prop] ?? fallback;

  function setVal(prop: string, raw: string) {
    setDraft((d) => ({ ...d, [prop]: raw }));
    onApply(prop, raw);
  }

  // Padding is exposed as a single shared slider that emits the `padding`
  // shorthand; the browser fans the value out to all four sides internally.
  // When per-side control becomes useful, switch to emitting explicit
  // padding-top / padding-right / padding-bottom / padding-left props
  // (the bridge already allow-lists those long-hand names).
  const initialPadding = pxToNumber(target.style.paddingTop);
  const initialFontSize = pxToNumber(target.style.fontSize);
  const initialRadius = pxToNumber(target.style.borderRadius);

  // Color / length controls all read through `draft` first so the input
  // tracks the most recent user pick even before getComputedStyle catches
  // up. Without this the picker would snap back to the initial computed
  // snapshot on every change and feel non-editable.
  const colorHex = value('color', rgbToHex(target.style.color));
  const bgHex = value('background-color', rgbToHex(target.style.backgroundColor));
  const padding = value('padding', String(initialPadding));
  const fontSize = value('font-size', String(initialFontSize));
  const radius = value('border-radius', String(initialRadius));
  const textAlign = value('text-align', target.style.textAlign || 'left');
  const fontWeight = value('font-weight', target.style.fontWeight || '400');
  // Parse once: `pxToNumber(...) || initial...` would treat a legitimate
  // `0px` draft as missing and snap the slider back to the original
  // computed value, making it impossible to remove padding/radius from an
  // element whose initial value is nonzero. `pxToNumber` already returns
  // 0 for unparseable input, so its result is safe to consume directly
  // and zero is preserved.
  const paddingNum = pxToNumber(padding);
  const fontSizeNum = pxToNumber(fontSize);
  const radiusNum = pxToNumber(radius);

  const justSaved = savedAt && Date.now() - savedAt < 4000;

  return (
    <aside className="inspect-panel" data-testid="inspect-panel">
      <header className="inspect-panel-head">
        <div className="inspect-panel-title">
          <strong title={target.label || target.elementId}>{target.label || target.elementId}</strong>
          <code title={target.selector}>{target.elementId}</code>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close inspect">
          ×
        </Button>
      </header>

      {target.clickedDescendant ? (
        <div className="inspect-ancestor-notice" data-testid="inspect-ancestor-notice">
          <div className="inspect-ancestor-notice-icon" aria-hidden>
            i
          </div>
          <div className="inspect-ancestor-notice-text">
            You clicked <strong>{target.clickedDescendant.label}</strong>
            {target.clickedDescendant.text
              ? ` ("${target.clickedDescendant.text.slice(0, 40)}${target.clickedDescendant.text.length > 40 ? '...' : ''}")`
              : ''}
            , but it has no <code>data-od-id</code> annotation. Editing{' '}
            <strong>{target.label || target.elementId}</strong> instead, the nearest annotated ancestor.
          </div>
        </div>
      ) : null}

      <section className="inspect-section">
        <div className="inspect-section-label">Colors</div>
        <div className="inspect-row">
          <label htmlFor="ip-color">Text</label>
          <Input
            id="ip-color"
            data-testid="inspect-color"
            type="color"
            value={colorHex}
            onChange={(e) => setVal('color', e.target.value)}
          />
          <Input
            type="text"
            value={colorHex}
            onChange={(e) => setVal('color', e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-bg">Background</label>
          <Input
            id="ip-bg"
            data-testid="inspect-bg"
            type="color"
            value={bgHex}
            onChange={(e) => setVal('background-color', e.target.value)}
          />
          <Input
            type="text"
            value={bgHex}
            onChange={(e) => setVal('background-color', e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">Typography</div>
        <div className="inspect-row">
          <label htmlFor="ip-fs">Size</label>
          <input
            id="ip-fs"
            data-testid="inspect-font-size"
            type="range"
            min={8}
            max={160}
            step={1}
            value={clamp(fontSizeNum, 8, 160)}
            onChange={(e) => setVal('font-size', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(fontSizeNum)}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-fw">Weight</label>
          <Select
            id="ip-fw"
            value={fontWeight}
            onChange={(e) => setVal('font-weight', e.target.value)}
          >
            {['100', '300', '400', '500', '600', '700', '800', '900'].map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </Select>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-ta">Align</label>
          <Select
            id="ip-ta"
            value={textAlign}
            onChange={(e) => setVal('text-align', e.target.value)}
          >
            {['left', 'center', 'right', 'justify'].map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">Spacing &amp; Shape</div>
        <div className="inspect-row">
          <label htmlFor="ip-pad">Padding</label>
          <input
            id="ip-pad"
            data-testid="inspect-padding"
            type="range"
            min={0}
            max={120}
            step={1}
            value={clamp(paddingNum, 0, 120)}
            onChange={(e) => setVal('padding', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(paddingNum)}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-rad">Radius</label>
          <input
            id="ip-rad"
            data-testid="inspect-radius"
            type="range"
            min={0}
            max={120}
            step={1}
            value={clamp(radiusNum, 0, 120)}
            onChange={(e) => setVal('border-radius', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(radiusNum)}px</span>
        </div>
      </section>

      <footer className="inspect-panel-footer">
        <Button
          variant="ghost"
          onClick={() => {
            setDraft({});
            onResetElement(target.elementId);
          }}
        >
          Reset element
        </Button>
        <Button
          variant="primary"
          data-testid="inspect-save"
          disabled={saving}
          onClick={onSaveToSource}
        >
          {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save to source'}
        </Button>
      </footer>
      {error ? <div className="inspect-panel-error">{error}</div> : null}
    </aside>
  );
}

// Inspect-mode override entry as held in the host's authoritative map and as
// it travels in od:inspect-overrides messages. The host's persisted map is
// owned and mutated only by host-driven onApply / reset actions plus the
// initial parse of the source's <style data-od-inspect-overrides> block;
// inbound iframe messages are treated as preview acknowledgements, never as
// save input. Artifact code rendered with scripts enabled can call
// window.parent.postMessage with a forged payload — ev.source still points
// at iframe.contentWindow — so any field arriving from the iframe is
// untrusted. Even the structured `overrides` field could be tampered with
// to flip allow-listed properties on elements the user never edited, which
// is why we no longer ingest it on save.
type InspectOverridePayload = {
  selector?: unknown;
  props?: unknown;
};

// Authoritative host-side override map: elementId → { selector, props }.
// Mirrors the in-iframe shape so serializeInspectOverrides can consume it.
export type InspectOverrideEntry = {
  selector: string;
  props: Record<string, string>;
};
export type InspectOverrideMap = Record<string, InspectOverrideEntry>;

// Allow-list of CSS properties the host will persist on Save. Mirrors the
// in-iframe ALLOWED_PROPS list so the host doesn't accept properties that
// the bridge itself would reject.
const HOST_ALLOWED_INSPECT_PROPS = new Set([
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-family',
  'line-height',
  'text-align',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-radius',
]);

// Reject values that could break out of `prop: value` and into the
// surrounding <style> block — semicolons, braces, angle brackets, and
// newlines. Mirrors the bridge's UNSAFE_VALUE regex.
const HOST_UNSAFE_INSPECT_VALUE = /[;{}<>\n\r]/;

// Reject elementIds whose characters could break out of `[attr="..."]`
// inside a <style> block. Forbidden:
//   - `"` and `\` would close the attribute string or smuggle CSS
//     escapes the host didn't pre-process;
//   - `<` and `>` would close the surrounding <style> tag;
//   - C0/C1 controls (newline, etc.) end the CSS rule under string
//     tokenization — kept in as defense-in-depth against parser quirks.
// Everything else — including ASCII whitespace and leading digits — is
// allowed, so deck labels like `01 Cover` survive instead of being
// dropped on the way to the persisted overrides block.
const HOST_UNSAFE_INSPECT_ID = /["\\<>\u0000-\u001f\u007f]/;

// Build the inspect overrides CSS body the host will persist, from the
// structured `overrides` field of an od:inspect-overrides message. The host
// MUST NOT trust the sibling `css` string — it is attacker-controlled when
// artifact JS forges the message. The selector is re-derived from each
// elementId; only allow-listed properties with safe values survive.
//
// Exported so unit tests can exercise the validator with hostile payloads.
export function serializeInspectOverrides(overrides: unknown): string {
  if (!overrides || typeof overrides !== 'object') return '';
  const map = overrides as Record<string, unknown>;
  const lines: string[] = [];
  for (const elementId of Object.keys(map)) {
    if (!elementId || HOST_UNSAFE_INSPECT_ID.test(elementId)) continue;
    const entry = map[elementId] as InspectOverridePayload | null | undefined;
    if (!entry || typeof entry !== 'object') continue;
    const props = entry.props;
    if (!props || typeof props !== 'object') continue;
    // Trust only the *kind* of selector the bridge built, not the value
    // it carried. The bridge runs CSS.escape over the elementId, so a raw
    // equality check against `[data-screen-label="${elementId}"]` would
    // miss legitimate deck labels like `01 Cover` (whitespace, leading
    // digit) and silently downgrade them to `[data-od-id="..."]`. The
    // elementId itself was sanitized above, so embedding it verbatim into
    // the re-derived selector is safe inside an attribute value string.
    const inboundSelector = typeof entry.selector === 'string' ? entry.selector : '';
    const attr = inboundSelector.startsWith('[data-screen-label="')
      ? 'data-screen-label'
      : 'data-od-id';
    const safeSelector = `[${attr}="${elementId}"]`;
    const decls: string[] = [];
    for (const [rawName, rawValue] of Object.entries(props as Record<string, unknown>)) {
      if (typeof rawName !== 'string' || typeof rawValue !== 'string') continue;
      const name = rawName.toLowerCase();
      if (!HOST_ALLOWED_INSPECT_PROPS.has(name)) continue;
      const value = rawValue.trim();
      if (!value || HOST_UNSAFE_INSPECT_VALUE.test(value)) continue;
      decls.push(`${name}: ${value} !important`);
    }
    if (!decls.length) continue;
    lines.push(`${safeSelector} { ${decls.join('; ')} }`);
  }
  return lines.join('\n');
}

// Apply a single host-driven prop change to the authoritative override map.
// Returns a new map (or the same reference if no-op so React skips renders).
// Empty value clears the prop; clearing the last prop drops the elementId.
// Mirrors the iframe bridge's applyOverride sanitization so the host map and
// the live preview stay in lock-step under the same rules.
export function updateInspectOverride(
  map: InspectOverrideMap,
  elementId: string,
  selector: string,
  prop: string,
  value: string,
): InspectOverrideMap {
  if (!elementId || HOST_UNSAFE_INSPECT_ID.test(elementId)) return map;
  const propName = String(prop || '').toLowerCase();
  if (!HOST_ALLOWED_INSPECT_PROPS.has(propName)) return map;
  const trimmed = String(value ?? '').trim();
  if (trimmed && HOST_UNSAFE_INSPECT_VALUE.test(trimmed)) return map;
  const existing = map[elementId];
  const nextProps: Record<string, string> = { ...(existing?.props ?? {}) };
  if (!trimmed) {
    if (!(propName in nextProps)) return map;
    delete nextProps[propName];
  } else if (nextProps[propName] === trimmed && existing?.selector === selector) {
    return map;
  } else {
    nextProps[propName] = trimmed;
  }
  const nextMap: InspectOverrideMap = { ...map };
  if (Object.keys(nextProps).length === 0) {
    delete nextMap[elementId];
  } else {
    nextMap[elementId] = { selector: selector || existing?.selector || '', props: nextProps };
  }
  return nextMap;
}

// Parse any persisted <style data-od-inspect-overrides> blocks in the
// artifact source into the host's authoritative override map. The host owns
// this map and only mutates it from onApply / reset actions plus this
// initial hydration step — inbound iframe od:inspect-overrides messages are
// not ingested. Without this step, opening a file that already carries an
// override block would leave the host map empty, so a Save-to-source after
// any subsequent edit could splice a CSS body that drops every previously
// saved rule for elements the user did not touch in this session.
//
// Mirrors the iframe bridge's hydrateOverridesFromDom: same allow-list,
// same value sanitizer, same selector kinds, so what the iframe applies and
// what the host persists stay in lock-step. Pure string transform; no DOM.
//
// HTML-aware: enumerates `<style data-od-inspect-overrides>` elements via
// the same walker used by the splicer, so a `<style data-od-inspect-overrides>`
// literal living inside a `<script>`, `<style>` (e.g. CSS comment), `<textarea>`,
// `<title>`, or HTML comment is not mistaken for a real override block. Without
// that exclusion, useEffect would seed the host map from forged/quoted text and
// a later Save-to-source would persist phantom CSS the user never created.
export function parseInspectOverridesFromSource(source: string): InspectOverrideMap {
  const map: InspectOverrideMap = {};
  if (!source) return map;
  for (const body of stripInspectOverridesAndIndex(source).bodies) {
    const ruleRe = /(\[data-(?:od-id|screen-label)="([^"]*)"\])\s*\{\s*([^}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(body)) !== null) {
      const selector = ruleMatch[1] ?? '';
      const elementId = ruleMatch[2] ?? '';
      const declBody = ruleMatch[3] ?? '';
      if (!selector || !elementId || HOST_UNSAFE_INSPECT_ID.test(elementId)) continue;
      const props: Record<string, string> = {};
      for (const raw of declBody.split(';')) {
        if (!raw) continue;
        const colon = raw.indexOf(':');
        if (colon <= 0) continue;
        const name = raw.slice(0, colon).trim().toLowerCase();
        if (!HOST_ALLOWED_INSPECT_PROPS.has(name)) continue;
        const value = raw.slice(colon + 1).replace(/!important/gi, '').trim();
        if (!value || HOST_UNSAFE_INSPECT_VALUE.test(value)) continue;
        props[name] = value;
      }
      if (Object.keys(props).length) {
        map[elementId] = { selector, props };
      }
    }
  }
  return map;
}

// HTML5 raw-text and escapable-raw-text elements: the parser does not
// interpret markup inside their contents, so a literal `</head>` or
// `<style data-od-inspect-overrides>` written as text inside one of them
// must NOT be treated as a real tag. Without this exclusion, a regex-only
// splicer can match `</head>` inside an inline <script> string literal or
// a CSS comment and inject the override block into the middle of
// JavaScript/CSS instead of the actual document head, corrupting the
// artifact on Save to source.
const RAW_TEXT_INSPECT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

// Decide whether a `<style ...>` opening tag actually carries a real
// `data-od-inspect-overrides` attribute, as opposed to merely mentioning
// the marker text inside another attribute name or value. The naive
// `\bdata-od-inspect-overrides\b` test against the whole tag text is
// over-broad in two cases:
//
//   1. A longer attribute name that has the marker as a prefix, e.g.
//      `<style data-od-inspect-overrides-note="docs">`. The `-` after
//      `overrides` is a non-word character, so `\b` matches and the tag
//      gets mis-stripped on save / mis-parsed on hydration.
//   2. The marker spelled inside an attribute value, e.g.
//      `<style title="data-od-inspect-overrides">`. The whole tag text
//      contains the literal, so the regex matches even though the actual
//      attribute names are `title` only.
//
// Both shapes occur in real artifacts (notes, documentation, fixtures)
// and would either silently drop the user's CSS on save or seed phantom
// overrides into the host map even though the artifact has no real
// override block. So we walk attributes proper, lower-casing each name
// and skipping any quoted value, and report a hit only when one of those
// names is exactly `data-od-inspect-overrides` (boolean attribute or
// assigned value, both legal HTML for our marker).
function styleTagIsInspectOverrideBlock(tagText: string): boolean {
  const start = /^<style/i.exec(tagText);
  if (!start) return false;
  let i = start[0].length;
  const end = tagText.length;
  while (i < end) {
    const ch = tagText.charAt(i);
    if (ch === '>') return false;
    if (ch === '/' || /\s/.test(ch)) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < end) {
      const c = tagText.charAt(i);
      if (c === '=' || c === '/' || c === '>' || /\s/.test(c)) break;
      i++;
    }
    const name = tagText.slice(nameStart, i).toLowerCase();
    while (i < end && /\s/.test(tagText.charAt(i))) i++;
    if (i < end && tagText.charAt(i) === '=') {
      i++;
      while (i < end && /\s/.test(tagText.charAt(i))) i++;
      const quote = tagText.charAt(i);
      if (quote === '"' || quote === "'") {
        i++;
        const close = tagText.indexOf(quote, i);
        i = close < 0 ? end : close + 1;
      } else {
        while (i < end) {
          const c = tagText.charAt(i);
          if (c === '>' || /\s/.test(c)) break;
          i++;
        }
      }
    }
    if (name === 'data-od-inspect-overrides') return true;
  }
  return false;
}

// Find the start (`<` position) of the matching close tag for a raw-text
// element, scanning case-insensitively. The close tag must be followed by
// a tag-name boundary (whitespace, `/`, or `>`) so a longer name like
// `</scripted>` doesn't accidentally close a `<script>`.
function findInspectRawTextEnd(source: string, start: number, name: string): number {
  const lower = source.toLowerCase();
  const needle = '</' + name.toLowerCase();
  let p = start;
  while (p < source.length) {
    const idx = lower.indexOf(needle, p);
    if (idx < 0) return -1;
    const after = source.charAt(idx + needle.length);
    if (after === '' || after === '>' || after === '/' || /\s/.test(after)) return idx;
    p = idx + needle.length;
  }
  return -1;
}

type InspectSpliceScan = {
  out: string;
  // Position in `out` immediately after the first top-level `<head ...>`
  // open tag, or -1 if no head was found outside raw-text content.
  headOpenEnd: number;
  // Position in `out` at the first top-level `</head>` close tag, or -1.
  headCloseStart: number;
  // Raw inner-text of every real `<style data-od-inspect-overrides>` element
  // discovered during the walk, in source order. Excludes occurrences inside
  // raw-text element contents and HTML comments. Hydration parses these
  // bodies for the host map; the splicer ignores them.
  bodies: string[];
};

// Walk `source` and produce a copy with every existing
// `<style data-od-inspect-overrides>...</style>` block removed, while
// remembering where the real (non-raw-text) `<head>` boundaries land in
// the output. The walker honours HTML comment, doctype/processing
// instruction, and raw-text element boundaries so the splicer can ignore
// tag-shaped literals inside scripts/styles/textareas/titles. Pure string
// transform — no DOM dependency, safe to run during SSR/tests.
function stripInspectOverridesAndIndex(source: string): InspectSpliceScan {
  const parts: string[] = [];
  const bodies: string[] = [];
  let outLen = 0;
  let headOpenEnd = -1;
  let headCloseStart = -1;
  let i = 0;
  function emit(text: string): void {
    if (!text) return;
    parts.push(text);
    outLen += text.length;
  }
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      emit(source.slice(i));
      break;
    }
    if (lt > i) emit(source.slice(i, lt));
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end < 0 ? source.length : end + 3;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
      const end = source.indexOf('>', i + 2);
      const stop = end < 0 ? source.length : end + 1;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    const tagEnd = source.indexOf('>', i + 1);
    if (tagEnd < 0) {
      emit(source.slice(i));
      break;
    }
    const tagText = source.slice(i, tagEnd + 1);
    const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagText);
    if (closeMatch) {
      const name = closeMatch[1]!.toLowerCase();
      if (name === 'head' && headCloseStart < 0) headCloseStart = outLen;
      emit(tagText);
      i = tagEnd + 1;
      continue;
    }
    const openMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagText);
    if (!openMatch) {
      emit(tagText);
      i = tagEnd + 1;
      continue;
    }
    const name = openMatch[1]!.toLowerCase();
    const isSelfClose = /\/\s*>$/.test(tagText);
    if (name === 'head' && headOpenEnd < 0) headOpenEnd = outLen + tagText.length;
    if (name === 'style' && styleTagIsInspectOverrideBlock(tagText)) {
      // Strip the entire override block. A self-closing <style /> is a
      // degenerate authoring case; treat it as nothing to skip past.
      if (isSelfClose) {
        i = tagEnd + 1;
        continue;
      }
      const closeStart = findInspectRawTextEnd(source, tagEnd + 1, 'style');
      if (closeStart < 0) {
        // Unterminated override block — drop the rest of the document
        // rather than silently reflowing later content into a dangling
        // <style>. Matches the "stop" behaviour of the previous regex.
        i = source.length;
        continue;
      }
      bodies.push(source.slice(tagEnd + 1, closeStart));
      const closeEnd = source.indexOf('>', closeStart);
      let stop = closeEnd < 0 ? source.length : closeEnd + 1;
      while (stop < source.length && /\s/.test(source.charAt(stop))) stop++;
      i = stop;
      continue;
    }
    if (!isSelfClose && RAW_TEXT_INSPECT_ELEMENTS.has(name)) {
      const closeStart = findInspectRawTextEnd(source, tagEnd + 1, name);
      if (closeStart < 0) {
        emit(source.slice(i));
        i = source.length;
        continue;
      }
      const closeEnd = source.indexOf('>', closeStart);
      const stop = closeEnd < 0 ? source.length : closeEnd + 1;
      // Copy the entire raw-text element (open tag, body, close tag) to
      // the output verbatim so its contents pass through unmodified.
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    emit(tagText);
    i = tagEnd + 1;
  }
  return { out: parts.join(''), headOpenEnd, headCloseStart, bodies };
}

// Splice (or remove) the inspect overrides <style> block in an HTML
// document. Idempotent: calling with the same css produces the same
// document. Empty css strips the block entirely.
//
// HTML-aware: the underlying scan ignores comments and raw-text element
// contents (script / style / textarea / title), so a literal `</head>` or
// `<style data-od-inspect-overrides>` written inside an inline script or
// style block does not trick the splicer into stripping user code or
// inserting the override block in the middle of JavaScript/CSS.
//
// Exported (via the module) so a unit test can drive it without a live
// browser. Pure string transform — no DOM, no parser dependency.
export function applyInspectOverridesToSource(source: string, css: string): string {
  const trimmed = css.trim();
  const { out, headOpenEnd, headCloseStart } = stripInspectOverridesAndIndex(source);
  if (!trimmed) return out;
  const block = `<style data-od-inspect-overrides>\n${trimmed}\n</style>\n`;
  if (headCloseStart >= 0) {
    return out.slice(0, headCloseStart) + block + out.slice(headCloseStart);
  }
  if (headOpenEnd >= 0) {
    return out.slice(0, headOpenEnd) + block + out.slice(headOpenEnd);
  }
  return block + out;
}

function CommentPreviewOverlays({
  comments,
  liveTargets,
  hoveredTarget,
  hoveredPodMemberId,
  activeTarget,
  activeExistingCommentId = null,
  boardTool,
  showActivePin = false,
  scale,
  offsetX,
  offsetY,
  strokePoints,
  activeSlideIndex = null,
  onOpenComment,
}: {
  comments: PreviewComment[];
  liveTargets: Map<string, PreviewCommentSnapshot>;
  hoveredTarget: PreviewCommentSnapshot | null;
  hoveredPodMemberId: string | null;
  activeTarget: PreviewCommentSnapshot | null;
  activeExistingCommentId?: string | null;
  boardTool: BoardTool;
  showActivePin?: boolean;
  scale: number;
  offsetX: number;
  offsetY: number;
  strokePoints: StrokePoint[];
  activeSlideIndex?: number | null;
  onOpenComment: (comment: PreviewComment, snapshot: PreviewCommentSnapshot) => void;
}) {
  const overlayOffset = useMemo(() => ({ x: offsetX, y: offsetY }), [offsetX, offsetY]);
  const visibleComments = useMemo(
    () =>
      comments
        .map((comment, globalIndex) => ({
          comment,
          markerNumber: globalIndex + 1,
          snapshot: liveSnapshotForComment(comment, liveTargets),
        }))
        .filter((item): item is { comment: PreviewComment; markerNumber: number; snapshot: PreviewCommentSnapshot } =>
          Boolean(item.snapshot),
        )
        .filter(({ comment }) => commentVisibleOnDeckSlide(comment, activeSlideIndex)),
    [comments, liveTargets, activeSlideIndex],
  );
  // `onOpenComment` is an inline arrow from the parent (new identity every
  // render), so read it through a ref to keep the saved-marker memo below from
  // busting. The closure only calls stable state setters, so a current ref read
  // is always correct.
  const onOpenCommentRef = useRef(onOpenComment);
  onOpenCommentRef.current = onOpenComment;
  // Memoize the saved-marker subtree. While the user draws a pod lasso,
  // `strokePoints` updates on every pointermove and re-renders this overlay;
  // without this, every saved marker (bounds + JSX) was rebuilt each frame.
  // Keyed only on the marker inputs (NOT strokePoints), so a steady set of
  // comments reuses the whole subtree and React skips reconciling it.
  const savedMarkers = useMemo(
    () =>
      visibleComments.map(({ comment, markerNumber, snapshot }) => {
        const bounds = overlayBoundsFromSnapshot(snapshot, scale, overlayOffset);
        const label = commentTargetDisplayName(comment);
        return (
          <div
            key={comment.id}
            className="comment-saved-marker"
            style={{
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            }}
            data-testid={`comment-saved-marker-${comment.elementId}`}
            onClick={() => onOpenCommentRef.current(comment, snapshot)}
          >
            <div className="comment-saved-outline" />
            <button
              type="button"
              className="comment-saved-pin"
              onClick={(event) => {
                event.stopPropagation();
                onOpenCommentRef.current(comment, snapshot);
              }}
              title={`${markerNumber}. ${label}: ${comment.note}`}
              aria-label={`Open comment for ${label}`}
            >
              {markerNumber}
            </button>
          </div>
        );
      }),
    [visibleComments, scale, overlayOffset],
  );
  const activeSavedIndex = activeExistingCommentId
    ? comments.findIndex((comment) => comment.id === activeExistingCommentId)
    : -1;
  const activePinNumber = activeSavedIndex >= 0
    ? activeSavedIndex + 1
    : comments.length + 1;
  const targetOverlay = activeTarget ?? hoveredTarget;
  return (
    <div className="comment-overlay-layer" aria-hidden={false}>
      {savedMarkers}
      {targetOverlay ? (
        <CommentTargetOverlay
          snapshot={targetOverlay}
          scale={scale}
          offset={overlayOffset}
          selected={Boolean(activeTarget)}
          hoveredMemberId={hoveredPodMemberId}
        />
      ) : null}
      {showActivePin && activeTarget ? (
        <div
          className="comment-active-pin"
          style={activeCommentPinStyle(activeTarget, scale, overlayOffset)}
          data-testid="comment-active-pin"
          aria-hidden="true"
        >
          {activePinNumber}
        </div>
      ) : null}
      {boardTool === 'pod' && strokePoints.length > 1 ? (
        <svg className="board-pod-stroke">
          <polyline
            points={strokePoints.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(' ')}
          />
        </svg>
      ) : null}
    </div>
  );
}

function activeCommentPinStyle(
  target: PreviewCommentSnapshot,
  scale: number,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): CSSProperties {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const anchor = target.hoverPoint ?? {
    x: target.position.x,
    y: target.position.y,
  };
  return {
    left: Math.round(offset.x + anchor.x * safeScale),
    top: Math.round(offset.y + anchor.y * safeScale),
  };
}

export function CommentTargetOverlay({
  snapshot,
  scale,
  offset,
  selected,
  hoveredMemberId,
}: {
  snapshot: PreviewCommentSnapshot;
  scale: number;
  offset?: { x: number; y: number };
  selected: boolean;
  hoveredMemberId?: string | null;
}) {
  const overlayOffset = offset ?? { x: 0, y: 0 };
  const displayMembers = podDisplayMembers(snapshot);
  if (displayMembers.length > 0) {
    const overlayWeights = podOverlayWeights(displayMembers);
    return (
      <>
        {displayMembers.map((member, index) => {
          const bounds = overlayBoundsFromSnapshot(member, scale, overlayOffset);
          const width = Math.round(member.position.width);
          const height = Math.round(member.position.height);
          const overlayWeight = overlayWeights[index] ?? {
            backgroundOpacity: 0.24,
            outlineOpacity: 0.72,
            ringOpacity: 0.18,
          };
          const overlayStyle: CSSProperties & Record<string, string | number> = {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            '--comment-overlay-bg': `rgba(22, 119, 255, ${overlayWeight.backgroundOpacity})`,
            '--comment-overlay-ring': `rgba(22, 119, 255, ${overlayWeight.ringOpacity})`,
            '--comment-overlay-border': `rgba(22, 119, 255, ${overlayWeight.outlineOpacity})`,
          };
          const isHoverFocused = hoveredMemberId === member.elementId;
          return (
            <div
              key={`${member.elementId}-${index}`}
              className={`comment-target-overlay comment-target-overlay--member${selected ? ' selected' : ''}${isHoverFocused ? ' is-hover-focused' : ''}`}
              style={overlayStyle}
              data-testid="comment-target-overlay"
            >
              <span className="comment-target-overlay-label">{snapshot.elementId}</span>
            </div>
          );
        })}
      </>
    );
  }
  // Non-member fallback: single-element snapshots have no per-member chips,
  // so the hover-focus channel never reaches this branch — no is-hover-focused
  // class needed here.
  const bounds = overlayBoundsFromSnapshot(snapshot, scale, overlayOffset);
  return (
    <div
      className={`comment-target-overlay${selected ? ' selected' : ''}`}
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      }}
      data-testid="comment-target-overlay"
    >
      <span className="comment-target-overlay-label">{snapshot.elementId}</span>
    </div>
  );
}

function podDisplayMembers(snapshot: PreviewCommentSnapshot): PreviewCommentSnapshot[] {
  if (snapshot.selectionKind !== 'pod' || !Array.isArray(snapshot.podMembers)) return [];
  const memberSnapshots = snapshot.podMembers.map((member) => ({
    filePath: snapshot.filePath,
    elementId: member.elementId,
    selector: member.selector,
    label: member.label,
    text: member.text,
    position: member.position,
    htmlHint: member.htmlHint,
    selectionKind: 'element' as const,
  }));
  const refined = pruneContainerSelections(memberSnapshots);
  return refined.length > 0 ? refined : memberSnapshots;
}

function podOverlayWeights(
  members: PreviewCommentSnapshot[],
): Array<{ backgroundOpacity: number; outlineOpacity: number; ringOpacity: number }> {
  const areas = members.map((member) =>
    Math.max(1, member.position.width * member.position.height),
  );
  const maxArea = Math.max(...areas);
  const minArea = Math.min(...areas);
  return areas.map((area) => {
    const normalized =
      maxArea === minArea ? 1 : 1 - (area - minArea) / (maxArea - minArea);
    const emphasis = Math.pow(normalized, 0.9);
    return {
      backgroundOpacity: roundOverlayOpacity(0.1 + emphasis * 0.6),
      outlineOpacity: roundOverlayOpacity(0.34 + emphasis * 0.36),
      ringOpacity: roundOverlayOpacity(0.08 + emphasis * 0.18),
    };
  });
}

function roundOverlayOpacity(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildPodSnapshot(input: {
  filePath: string;
  strokePoints: StrokePoint[];
  liveTargets: Map<string, PreviewCommentSnapshot>;
}): PreviewCommentSnapshot | null {
  if (input.strokePoints.length < 2) return null;
  const closedLoop = isClosedLoop(input.strokePoints);
  const intersected = Array.from(input.liveTargets.values()).filter((snapshot) =>
    selectionHitsSnapshot({
      points: input.strokePoints,
      snapshot,
      closedLoop,
    }),
  );
  const refined = pruneContainerSelections(intersected);
  const selected = refined.length > 0 ? refined : intersected;
  if (selected.length === 0) return null;
  const bounds = selected.reduce(
    (acc, snapshot) => {
      const rect = snapshot.position;
      return {
        left: Math.min(acc.left, rect.x),
        top: Math.min(acc.top, rect.y),
        right: Math.max(acc.right, rect.x + rect.width),
        bottom: Math.max(acc.bottom, rect.y + rect.height),
      };
    },
    {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
  const podMembers: PreviewCommentMember[] = selected.map((snapshot) => ({
    elementId: snapshot.elementId,
    selector: snapshot.selector,
    label: snapshot.label,
    text: snapshot.text,
    position: snapshot.position,
    htmlHint: snapshot.htmlHint,
    style: snapshot.style,
  }));
  const summary = selected
    .slice(0, 3)
    .map((snapshot) => summarizeSnapshot(snapshot))
    .join(' · ');
  const htmlHint = selected
    .slice(0, 4)
    .map((snapshot) => snapshot.htmlHint)
    .filter(Boolean)
    .join(' ');
  const combinedSelector = selected
    .slice(0, 8)
    .map((snapshot) => snapshot.selector)
    .filter(Boolean)
    .join(', ');
  return {
    filePath: input.filePath,
    elementId: `pod-${Date.now()}`,
    selector: combinedSelector || 'body *',
    label: summary || `Pod of ${intersected.length} items`,
    text: intersected
      .slice(0, 4)
      .map((snapshot) => snapshot.text)
      .filter(Boolean)
      .join(' · '),
    position: {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.max(1, Math.round(bounds.right - bounds.left)),
      height: Math.max(1, Math.round(bounds.bottom - bounds.top)),
    },
    htmlHint: htmlHint.slice(0, 180),
    selectionKind: 'pod',
    memberCount: selected.length,
    podMembers,
  };
}

function pruneContainerSelections(
  snapshots: PreviewCommentSnapshot[],
): PreviewCommentSnapshot[] {
  if (snapshots.length < 2) return snapshots;
  return snapshots.filter((candidate) => {
    const candidateArea = Math.max(1, candidate.position.width * candidate.position.height);
    const contained = snapshots.filter(
      (other) =>
        other.elementId !== candidate.elementId &&
        rectContains(candidate.position, other.position),
    );
    if (contained.length === 0) return true;
    const union = contained.reduce(
      (acc, other) => ({
        left: Math.min(acc.left, other.position.x),
        top: Math.min(acc.top, other.position.y),
        right: Math.max(acc.right, other.position.x + other.position.width),
        bottom: Math.max(acc.bottom, other.position.y + other.position.height),
      }),
      {
        left: Number.POSITIVE_INFINITY,
        top: Number.POSITIVE_INFINITY,
        right: Number.NEGATIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY,
      },
    );
    const unionArea = Math.max(1, (union.right - union.left) * (union.bottom - union.top));
    return !(contained.length >= 2 && candidateArea > unionArea * 2.4);
  });
}

function summarizeSnapshot(snapshot: PreviewCommentSnapshot): string {
  const text = snapshot.text.trim();
  if (text) {
    const trimmed = text.length > 28 ? `${text.slice(0, 25)}...` : text;
    return `${snapshot.label || snapshot.elementId} · ${trimmed}`;
  }
  return snapshot.label || snapshot.elementId;
}

function selectionHitsSnapshot(input: {
  points: StrokePoint[];
  snapshot: PreviewCommentSnapshot;
  closedLoop: boolean;
}): boolean {
  const bounds = {
    left: input.snapshot.position.x,
    top: input.snapshot.position.y,
    width: input.snapshot.position.width,
    height: input.snapshot.position.height,
  };
  if (pathIntersectsRect(input.points, bounds)) return true;
  if (!input.closedLoop) return false;
  const center = {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
  if (pointInPolygon(center, input.points)) return true;
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top + bounds.height },
    { x: bounds.left, y: bounds.top + bounds.height },
  ];
  return corners.some((corner) => pointInPolygon(corner, input.points));
}

function isClosedLoop(points: StrokePoint[]): boolean {
  if (points.length < 4) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.hypot(first.x - last.x, first.y - last.y) <= 28;
}

function rectContains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function pathIntersectsRect(
  points: StrokePoint[],
  rect: { left: number; top: number; width: number; height: number },
): boolean {
  if (points.length === 0) return false;
  const x1 = rect.left;
  const y1 = rect.top;
  const x2 = rect.left + rect.width;
  const y2 = rect.top + rect.height;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
      return true;
    }
    const next = points[index + 1];
    if (!next) continue;
    if (
      lineIntersectsLine(point, next, { x: x1, y: y1 }, { x: x2, y: y1 }) ||
      lineIntersectsLine(point, next, { x: x2, y: y1 }, { x: x2, y: y2 }) ||
      lineIntersectsLine(point, next, { x: x2, y: y2 }, { x: x1, y: y2 }) ||
      lineIntersectsLine(point, next, { x: x1, y: y2 }, { x: x1, y: y1 })
    ) {
      return true;
    }
  }
  return false;
}

function pointInPolygon(point: StrokePoint, polygon: StrokePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x <
        ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || Number.EPSILON) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function lineIntersectsLine(a1: StrokePoint, a2: StrokePoint, b1: StrokePoint, b2: StrokePoint): boolean {
  const denominator =
    (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (denominator === 0) return false;
  const ua =
    ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / denominator;
  const ub =
    ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / denominator;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

function finiteBridgeInteger(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return clampBridgeCoordinate(value);
}

function normalizeAnnotationStyle(input: unknown): PreviewCommentSnapshot['style'] {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const style: NonNullable<PreviewCommentSnapshot['style']> = {};
  for (const key of ANNOTATION_STYLE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed) style[key] = trimmed.slice(0, 120);
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

const ANNOTATION_STYLE_KEYS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'fontFamily',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderRadius',
] as const;

function clampBridgeCoordinate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-MAX_BRIDGE_COORDINATE, Math.min(MAX_BRIDGE_COORDINATE, Math.round(numeric)));
}

// Shown instead of the React runtime when a .jsx/.tsx is a module loaded by a
// sibling HTML entry (issue #2744): such a file has no standalone component to
// render, so point the user at the page(s) that do. Clicking an entry opens
// (or focuses) that page and closes the now-useless module tab.
function ReactModulePointer({
  entries,
  onOpenEntry,
}: {
  entries: string[];
  onOpenEntry?: (name: string) => void;
}) {
  const t = useT();
  return (
    <div className="viewer-module-pointer" role="note">
      <Icon name="info" size={20} />
      <h2 className="viewer-module-pointer__title">{t('fileViewer.jsxModuleTitle')}</h2>
      <p className="viewer-module-pointer__body">{t('fileViewer.jsxModuleBody')}</p>
      <p className="viewer-module-pointer__cta">{t('fileViewer.jsxModuleCta')}</p>
      <ul className="viewer-module-pointer__entries">
        {entries.map((name) => (
          <li key={name}>
            <button
              type="button"
              className="viewer-module-pointer__link"
              onClick={() => onOpenEntry?.(name)}
              disabled={!onOpenEntry}
            >
              <Icon name="external-link" size={14} />
              <span>{name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReactComponentViewer({
  projectId,
  file,
  onOpenFileReplacing,
}: {
  projectId: string;
  file: ProjectFile;
  onOpenFileReplacing?: (openName: string, closeName: string) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [source, setSource] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement | null>(null);
  // HTML entries that load this file as a Babel module. `null` = still
  // checking; `[]` = standalone artifact; non-empty = a module of a
  // multi-file React prototype, which has no standalone preview. Issue #2744.
  const [moduleEntries, setModuleEntries] = useState<string[] | null>(null);
  const isModule = (moduleEntries?.length ?? 0) > 0;

  useEffect(() => {
    setSource(null);
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((text) => {
      if (!cancelled) setSource(text ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, reloadKey]);

  // Detect whether this .jsx/.tsx is a module loaded by a sibling HTML entry.
  // Runs before any srcdoc is built so a module never flashes the raw
  // "No React component export found" error from the React runtime.
  useEffect(() => {
    setModuleEntries(null);
    let cancelled = false;
    void (async () => {
      try {
        const files = await fetchProjectFiles(projectId);
        const htmlNames = files
          .filter((entry) => /\.html?$/i.test(entry.name))
          .map((entry) => entry.name);
        const htmlSources = new Map<string, string>();
        await Promise.all(
          htmlNames.map(async (name) => {
            const text = await fetchProjectFileText(projectId, name).catch(() => null);
            if (text != null) htmlSources.set(name, text);
          }),
        );
        if (cancelled) return;
        setModuleEntries(findHtmlEntriesReferencing(file.name, htmlSources));
      } catch {
        if (!cancelled) setModuleEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, reloadKey]);

  useEffect(() => {
    if (!shareMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!shareRef.current) return;
      if (!shareRef.current.contains(e.target as Node)) setShareMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [shareMenuOpen]);

  const exportTitle = file.name.replace(/\.(jsx|tsx)$/i, '') || file.name;
  const sourceExtension = file.name.toLowerCase().endsWith('.tsx') ? '.tsx' : '.jsx';

  useEffect(() => {
    if (source === null || moduleEntries === null || isModule) {
      // No source yet, still checking module status, or this file is a module
      // with no standalone preview — never build the React runtime srcdoc.
      setSrcDoc('');
      return;
    }

    let cancelled = false;
    const buildSrcDoc = () => {
      const nextSrcDoc = buildReactComponentSrcdoc(source, { title: exportTitle });
      if (!cancelled) setSrcDoc(nextSrcDoc);
    };

    if (source.length > 100_000) {
      setSrcDoc('');
      const timeout = window.setTimeout(buildSrcDoc, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
      };
    }

    buildSrcDoc();
    return () => {
      cancelled = true;
    };
  }, [source, exportTitle, moduleEntries, isModule]);

  return (
    <div className="viewer react-component-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <button
            type="button"
            className="icon-only od-tooltip"
            onClick={() => setReloadKey((n) => n + 1)}
            title={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip-placement="bottom"
            aria-label={`${t('fileViewer.reloadAria')} ${t('fileViewer.preview')}`}
          >
            <Icon name="reload" size={14} />
          </button>
          <span className="viewer-meta">
            {t('fileViewer.reactMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <div className="viewer-toolbar-actions">
          <div className="viewer-tabs">
            <button
              type="button"
              className={`viewer-tab ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
            >
              {t('fileViewer.preview')}
            </button>
            <button
              type="button"
              className={`viewer-tab ${mode === 'source' ? 'active' : ''}`}
              onClick={() => setMode('source')}
            >
              {t('fileViewer.source')}
            </button>
          </div>
          {source !== null ? (
            <>
              <span className="viewer-divider" aria-hidden />
              <div className="share-menu" ref={shareRef}>
                <button
                  type="button"
                  className="viewer-action primary viewer-action-export od-tooltip"
                  aria-haspopup="menu"
                  aria-expanded={shareMenuOpen}
                  title={t('fileViewer.shareLabel')}
                  data-tooltip={t('fileViewer.shareLabel')}
                  data-tooltip-placement="bottom"
                  onClick={() => setShareMenuOpen((v) => !v)}
                >
                  <span className="export-action-spacer" aria-hidden />
                  <span>{t('fileViewer.shareLabel')}</span>
                  <RemixIcon name="arrow-down-s-line" size={14} />
                </button>
                {shareMenuOpen ? (
                  <div className="share-menu-popover" role="menu">
                    <div className="share-menu-section-label" role="presentation">
                      {t('common.share')}
                    </div>
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        exportAsJsx(source, exportTitle, sourceExtension);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-code-line" size={15} /></span>
                      <span>{t('fileViewer.exportJsx')}</span>
                    </button>
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        exportReactComponentAsHtml(source, exportTitle);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                      <span>{t('fileViewer.exportReactHtml')}</span>
                    </button>
                    <div className="share-menu-divider" />
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        exportReactComponentAsZip(source, exportTitle, sourceExtension);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-zip-line" size={15} /></span>
                      <span>{t('fileViewer.exportZip')}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="viewer-body">
        {isModule && mode === 'preview' ? (
          // Module of a multi-file prototype: no standalone preview, so the
          // Preview tab shows a pointer to the HTML entry. The Source tab still
          // renders the raw code below. Issue #2744.
          <ReactModulePointer
            entries={moduleEntries ?? []}
            onOpenEntry={(htmlName) => onOpenFileReplacing?.(htmlName, file.name)}
          />
        ) : source === null || (mode === 'preview' && !srcDoc) ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : mode === 'preview' ? (
          <PreviewDrawOverlay>
            <iframe
              data-testid="react-component-preview-frame"
              title={file.name}
              sandbox="allow-scripts allow-downloads"
              srcDoc={srcDoc}
              style={{ width: '100%', height: '100%', border: 0 }}
            />
          </PreviewDrawOverlay>
        ) : (
          <CodeWithLines text={source} />
        )}
      </div>
    </div>
  );
}

function AutodetectingBinaryViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const canDetect = shouldAutodetectTextFile(file);
  const [mode, setMode] = useState<'checking' | 'text' | 'binary'>(() =>
    canDetect ? (file.size === 0 ? 'text' : 'checking') : 'binary',
  );

  useEffect(() => {
    if (!canDetect) {
      setMode('binary');
      return;
    }
    if (file.size === 0) {
      setMode('text');
      return;
    }

    const controller = new AbortController();
    setMode('checking');
    void fetch(projectRawUrl(projectId, file.name), {
      cache: 'no-store',
      headers: { Range: `bytes=0-${TEXT_SNIFF_BYTES - 1}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return false;
        return isProbablyUtf8Text(await response.arrayBuffer());
      })
      .then((isText) => {
        if (!controller.signal.aborted) setMode(isText ? 'text' : 'binary');
      })
      .catch(() => {
        if (!controller.signal.aborted) setMode('binary');
      });
    return () => controller.abort();
  }, [canDetect, file.mtime, file.name, file.size, projectId]);

  if (mode === 'text') return <TextViewer projectId={projectId} file={file} />;
  if (mode === 'checking') {
    return (
      <div className="viewer binary-viewer" data-testid="binary-text-detecting">
        <div className="viewer-toolbar">
          <div className="viewer-toolbar-left">
            <span className="viewer-meta">{humanSize(file.size)}</span>
          </div>
          <FileActions projectId={projectId} file={file} />
        </div>
        <div className="viewer-body">
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        </div>
      </div>
    );
  }
  return <BinaryViewer projectId={projectId} file={file} />;
}

function BinaryViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  return (
    <div className="viewer binary-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.binaryMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body">
        <div className="viewer-empty">
          {t('fileViewer.binaryNote', { size: file.size })}
        </div>
      </div>
    </div>
  );
}

// Real PDF rendering for project files: pdf.js canvas pages with a selectable
// text layer, fit-width zoom, and scroll preservation (the same viewer the
// paper editor's preview pane uses). Replaces the old text-extraction outline
// for kind === 'pdf'.
function PdfFileViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const src = useMemo(
    () => `${projectFileUrl(projectId, file.name)}?v=${Number(file.mtime) || 0}`,
    [projectId, file.name, file.mtime],
  );
  return (
    <div className="viewer pdf-file-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.pdfMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body pdf-file-viewer-body">
        <PdfViewer key={`${projectId}:${file.name}`} src={src} />
      </div>
    </div>
  );
}

function DocumentPreviewViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    void fetchProjectFilePreview(projectId, file.name).then((next) => {
      if (!cancelled) {
        setPreview(next);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  return (
    <div className="viewer document-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {documentMetaLabel(file, t)} · {humanSize(file.size)}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body">
        {loading ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : preview ? (
          <div className="document-preview">
            <h2>{preview.title}</h2>
            {preview.sections.map((section, idx) => (
              <section key={`${section.title}-${idx}`}>
                <h3>{section.title}</h3>
                {section.lines.map((line, lineIdx) => (
                  <p key={`${lineIdx}-${line}`}>{line}</p>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="viewer-empty">{t('fileViewer.previewUnavailable')}</div>
        )}
      </div>
    </div>
  );
}

function HtmlViewer({
  projectId,
  projectKind,
  file,
  liveHtml,
  filesRefreshKey = 0,
  isDeck,
  streaming,
  commentQueueOnSend = false,
  commentSendDisabled = false,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  onFileSaved,
  commentPortalId,
  onCommentModeChange,
  downloadRequest,
  slideNavRequest,
}: {
  projectId: string;
  projectKind: ViewerProjectKind;
  file: ProjectFile;
  liveHtml?: string;
  filesRefreshKey?: number;
  isDeck: boolean;
  streaming: boolean;
  commentQueueOnSend?: boolean;
  commentSendDisabled?: boolean;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[]) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[], images?: File[]) => Promise<boolean | void> | boolean | void;
  onFileSaved?: () => Promise<void> | void;
  commentPortalId?: string;
  onCommentModeChange?: (active: boolean) => void;
  downloadRequest?: { nonce: number } | null;
  slideNavRequest?: { slideIndex: number; nonce: number } | null;
}) {
  const { locale, t } = useI18n();
  const fileEtagRef = useRef<string | null | undefined>(file.etag);
  useEffect(() => {
    fileEtagRef.current = file.etag;
  }, [file.name, file.etag]);
  // Latest per-slide capture progress for the programmatic exporters, read by
  // the loading-toast ticker in fireShareExport to render elapsed time + ETA.
  const exportProgressRef = useRef<{ done: number; total: number } | null>(null);
  // Shared helper for the share menu: show progress and completion toasts.
  const fireShareExport = (
    format:
      | 'pdf'
      | 'pptx'
      | 'zip'
      | 'html'
      | 'image'
      | 'markdown'
      | 'template',
    fn: () => Promise<unknown> | unknown,
  ) => {
    const toastFormats = new Set(['pdf', 'pptx', 'zip', 'html', 'image', 'markdown']);
    // Programmatic exports compute in-browser and can take a while (one render
    // per deck slide), so the loading toast ticks every second with elapsed time
    // and — once at least one slide is captured — a live ETA derived from the
    // average time per completed slide. onExportProgress (passed into the export
    // call by the menu item) feeds slide progress into exportProgressRef.
    exportProgressRef.current = null;
    const startedAt = performance.now();
    let ticker: ReturnType<typeof setInterval> | null = null;
    const renderLoadingToast = () => {
      if (!toastFormats.has(format)) return;
      const elapsedS = Math.max(0, Math.round((performance.now() - startedAt) / 1000));
      const p = exportProgressRef.current;
      let message: string;
      if (p && p.total > 1 && p.done > 0) {
        const remainingS = Math.max(
          1,
          Math.round(((performance.now() - startedAt) / p.done) * (p.total - p.done) / 1000),
        );
        message = t('fileViewer.exportSlideEta', { current: p.done, total: p.total, seconds: remainingS });
      } else if (p && p.total > 1) {
        message = t('fileViewer.exportSlideProgress', { current: p.done, total: p.total });
      } else {
        message = elapsedS > 0
          ? t('fileViewer.exportingElapsed', { seconds: elapsedS })
          : t('fileViewer.exportingProgress');
      }
      setExportToast({ message, tone: 'loading' });
    };
    const stopTicker = () => {
      if (ticker != null) {
        clearInterval(ticker);
        ticker = null;
      }
    };
    if (toastFormats.has(format)) {
      renderLoadingToast();
      ticker = setInterval(renderLoadingToast, 1000);
    }
    const failToast = (err?: unknown) => {
      stopTicker();
      const message = err instanceof Error && err.message ? err.message : t('fileViewer.exportFailed');
      if (toastFormats.has(format)) setExportToast({ message, tone: 'error' });
    };
    try {
      const out = fn();
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).then(
          (result) => {
            stopTicker();
            if (result === 'cancelled') {
              if (toastFormats.has(format)) setExportToast(null);
              return;
            }
            if (toastFormats.has(format)) setExportToast({ message: t('fileViewer.exportDone'), tone: 'success' });
          },
          (err) => {
            failToast(err);
          },
        );
      } else {
        stopTicker();
        if (out === 'cancelled') {
          if (toastFormats.has(format)) setExportToast(null);
          return;
        }
        if (toastFormats.has(format)) setExportToast({ message: t('fileViewer.exportDone'), tone: 'success' });
      }
    } catch (err) {
      failToast(err);
    }
  };
  // Feeds per-slide capture progress into the ref the loading-toast ticker reads
  // (apps/web/src/runtime/exports.ts drives this for the PDF exporter).
  const onExportProgress: ExportProgress = (done, total) => {
    exportProgressRef.current = { done, total };
  };
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [source, setSource] = useState<string | null>(liveHtml ?? null);
  const [inlinedSource, setInlinedSource] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const fileViewportKey = previewViewportStateKey(projectId, file);
  const [previewViewport, setPreviewViewportState] = useState<PreviewViewportId>(
    () => htmlPreviewViewportState.get(fileViewportKey) ?? 'desktop',
  );
  const setPreviewViewport = useCallback((viewport: PreviewViewportId) => {
    setPreviewViewportCached(fileViewportKey, viewport);
    setPreviewViewportState(viewport);
  }, [fileViewportKey]);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement | null>(null);
  const [presentMenuOpen, setPresentMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  // False when closed; otherwise records which entry opened the modal so the
  // surface_view impression can carry entry_from.
  const [versionModalOpen, setVersionModalOpen] = useState<false | 'toolbar' | 'more_menu'>(false);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
  const toolbarMoreRef = useRef<HTMLDivElement | null>(null);
  const [exportReadyNudge, setExportReadyNudge] = useState(false);
  const exportReadyNudgeSeenRef = useRef<Set<string>>(new Set());
  // Template save UX. We surface a transient "Saved" pill in the share
  // menu so the user gets feedback without a noisy toast layer.
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const templateNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (templateNoteTimerRef.current !== null) clearTimeout(templateNoteTimerRef.current);
  }, []);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');

  useEffect(() => {
    setPreviewViewportState(htmlPreviewViewportState.get(fileViewportKey) ?? 'desktop');
  }, [fileViewportKey]);
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [inTabPresent, setInTabPresent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Set to true permanently once `source` has been populated for the first
  // time. After the first load, we never show the "loading" skeleton again —
  // even if a reload temporarily clears `source` to null (issue #4650).
  const sourceEverLoadedRef = useRef(false);
  const [boardMode, setBoardMode] = useState(false);
  const [commentPanelOpen, setCommentPanelOpen] = useState(false);
  const [commentCreateMode, setCommentCreateMode] = useState(false);
  const [boardTool, setBoardTool] = useState<BoardTool>('inspect');
  const [inspectMode, setInspectMode] = useState(false);
  const [agentToolsOpen, setAgentToolsOpen] = useState(false);
  const [drawOverlayOpen, setDrawOverlayOpen] = useState(false);
  // for hint managing hint box state
  const [openHintBox, setOpenHintBox] = useState(true);
  const [manualEditMode, setManualEditModeRaw] = useState(false);
  const [manualEditSrcDocActive, setManualEditSrcDocActive] = useState(false);
  const [manualEditFrozenSource, setManualEditFrozenSource] = useState<string | null>(null);
  // Source snapshot frozen while a non-edit annotation pass (Mark/Draw,
  // Comment, Inspect) is open. The file-watcher live-reload (chokidar →
  // filesRefresh → preview refresh) would otherwise re-render the iframe
  // mid-annotation whenever the agent rewrites the file — wiping in-progress
  // strokes, the picked element, scroll, and focus. We hold the snapshot
  // captured at mode entry and release it on exit, so the latest content
  // flushes in exactly once when the user is done. Manual Edit keeps its own
  // freeze (manualEditFrozenSource) because it also streams live style
  // patches over postMessage. NOTE: this intentionally pauses the
  // comment-mode agent-edit live refresh added with the §5162 cache-bust —
  // the user reported that mid-comment refresh as disruptive; eventual
  // consistency is preserved by the flush on close.
  const [annotationFrozenSource, setAnnotationFrozenSource] = useState<string | null>(null);
  const [manualEditViewportWidth, setManualEditViewportWidth] = useState<number | null>(null);
  const [commentPortalHost, setCommentPortalHost] = useState<HTMLElement | null>(null);
  const [previewBodyRef, previewBodySize] = usePreviewCanvasSize<HTMLDivElement>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const urlPreviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const srcDocPreviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const activatedSrcDocTransportHtmlRef = useRef<string | null>(null);
  // Tracks the iframe DOM node whose dedupe ref was last reset by the
  // srcDoc onLoad handler. We reset the dedupe exactly once per freshly
  // mounted iframe (the first load is the shell HTML), and skip every
  // subsequent load on the same node (those are our own
  // document.open/write/close inside the shell). See onLoad below for
  // the infinite-loop story (issue #2361).
  const srcDocFrameDedupeResetForRef = useRef<HTMLIFrameElement | null>(null);
  const isActivePreviewIframeSource = useCallback((source: MessageEventSource | null) => {
    return !!source && source === iframeRef.current?.contentWindow;
  }, []);
  const isOurPreviewIframeSource = useCallback((source: MessageEventSource | null) => {
    if (!source) return false;
    return (
      source === iframeRef.current?.contentWindow ||
      source === urlPreviewIframeRef.current?.contentWindow ||
      source === srcDocPreviewIframeRef.current?.contentWindow
    );
  }, []);
  const previewScrollRestoreRef = useRef<{
    hostLeft: number;
    hostTop: number;
    frameLeft: number;
    frameTop: number;
    canvasLeft: number;
    canvasTop: number;
    expiresAt: number;
  } | null>(null);
  const previewScrollPositionRef = useRef({
    frameLeft: 0,
    frameTop: 0,
    canvasLeft: 0,
    canvasTop: 0,
  });
  const previewScrollRequestAtRef = useRef(0);
  const dcViewportRef = useRef({
    x: 0,
    y: 0,
    scale: 1,
  });
  const dcViewportRestoreAtRef = useRef(0);
  const setManualEditMode = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setManualEditModeRaw((prev) => {
      const value = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next;
      if (value !== prev && !value) {
        setManualEditViewportWidth(null);
      }
      return value;
    });
  }, []);
  useEffect(() => {
    setManualEditSrcDocActive(false);
    setManualEditFrozenSource(null);
  }, [projectId, file.name]);
  useEffect(() => {
    onCommentModeChange?.(commentPanelOpen);
  }, [commentPanelOpen, onCommentModeChange]);
  useEffect(() => () => {
    onCommentModeChange?.(false);
  }, [onCommentModeChange]);
  useEffect(() => {
    if (!commentPanelOpen || !commentPortalId) {
      setCommentPortalHost(null);
      return;
    }
    let cancelled = false;
    let raf = 0;
    const findHost = () => {
      if (cancelled) return;
      const host = document.getElementById(commentPortalId);
      setCommentPortalHost(host);
      if (!host) raf = window.requestAnimationFrame(findHost);
    };
    findHost();
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      setCommentPortalHost(null);
    };
  }, [commentPanelOpen, commentPortalId]);
  const capturePreviewScrollPosition = useCallback(() => {
    const host = previewBodyRef.current;
    let frameLeft = 0;
    let frameTop = 0;
    let canvasLeft = 0;
    let canvasTop = 0;
    try {
      const frameDocument = iframeRef.current?.contentWindow?.document;
      const frameScroll = frameDocument?.scrollingElement;
      const canvasScroll = frameDocument?.querySelector<HTMLElement>('.design-canvas');
      frameLeft = frameScroll?.scrollLeft ?? 0;
      frameTop = frameScroll?.scrollTop ?? 0;
      canvasLeft = canvasScroll?.scrollLeft ?? 0;
      canvasTop = canvasScroll?.scrollTop ?? 0;
    } catch {
      frameLeft = 0;
      frameTop = 0;
      canvasLeft = 0;
      canvasTop = 0;
    }
    previewScrollRestoreRef.current = {
      hostLeft: host?.scrollLeft ?? 0,
      hostTop: host?.scrollTop ?? 0,
      frameLeft: frameLeft || previewScrollPositionRef.current.frameLeft,
      frameTop: frameTop || previewScrollPositionRef.current.frameTop,
      canvasLeft: canvasLeft || previewScrollPositionRef.current.canvasLeft,
      canvasTop: canvasTop || previewScrollPositionRef.current.canvasTop,
      expiresAt: Date.now() + 5000,
    };
  }, []);
  const restorePreviewScrollPosition = useCallback(() => {
    const snapshot = previewScrollRestoreRef.current;
    if (!snapshot) return;
    if (Date.now() > snapshot.expiresAt) {
      previewScrollRestoreRef.current = null;
      return;
    }
    const apply = () => {
      const previewBody = previewBodyRef.current;
      if (typeof previewBody?.scrollTo === 'function') {
        previewBody.scrollTo(snapshot.hostLeft, snapshot.hostTop);
      }
      try {
        const frameDocument = iframeRef.current?.contentWindow?.document;
        frameDocument?.scrollingElement?.scrollTo(snapshot.frameLeft, snapshot.frameTop);
        frameDocument?.querySelector<HTMLElement>('.design-canvas')?.scrollTo(snapshot.canvasLeft, snapshot.canvasTop);
        iframeRef.current?.contentWindow?.postMessage({
          type: 'od:preview-scroll-restore',
          frameLeft: snapshot.frameLeft,
          frameTop: snapshot.frameTop,
          canvasLeft: snapshot.canvasLeft,
          canvasTop: snapshot.canvasTop,
        }, '*');
      } catch {}
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        apply();
        window.setTimeout(apply, 80);
        window.setTimeout(() => {
          if (previewScrollRestoreRef.current === snapshot) {
            apply();
          }
        }, 260);
      });
    });
  }, []);
  const [manualEditTargets, setManualEditTargets] = useState<ManualEditTarget[]>([]);
  const [selectedManualEditTarget, setSelectedManualEditTarget] = useState<ManualEditTarget | null>(null);
  const [manualEditHoverTarget, setManualEditHoverTarget] = useState<ManualEditTarget | null>(null);
  const [manualEditPageStylesOpen, setManualEditPageStylesOpen] = useState(false);
  const [manualEditPanelPosition, setManualEditPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const [manualEditDraftDirty, setManualEditDraftDirty] = useState(false);
  const selectedManualEditTargetIdRef = useRef<string | null>(null);
  const manualEditSelectionDraftRef = useRef<{ id: string; draft: ManualEditDraft } | null>(null);
  // Tracks the iframe's in-flight inline text edit. `finishManualEditTextSession`
  // posts the explicit finish and resolves only after the iframe acks AND the
  // resulting commit has been applied, so exit/dismiss/cancel never tear down
  // mid-round-trip and drop the final edit (the #3647 exit-path regression).
  const manualEditTextSessionIdRef = useRef<string | null>(null);
  const manualEditTextFinishRef = useRef<(() => void) | null>(null);
  const manualEditTextCommitInFlightRef = useRef<Promise<unknown> | null>(null);
  const [manualEditDraft, setManualEditDraft] = useState<ManualEditDraft>(() => emptyManualEditDraft());
  const [manualEditHistory, setManualEditHistory] = useState<ManualEditHistoryEntry[]>([]);
  const [manualEditUndone, setManualEditUndone] = useState<ManualEditHistoryEntry[]>([]);
  const [manualEditError, setManualEditError] = useState<string | null>(null);
  const [manualEditSaving, setManualEditSaving] = useState(false);
  const manualEditSavingRef = useRef(false);
  const manualEditPendingStyleRef = useRef<ManualEditPendingStyleSave | null>(null);
  const manualEditStyleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualEditPreviewVersionRef = useRef(0);
  const sourceRef = useRef<string | null>(source);
  // Holds the last-good source snapshot taken just before reloadHtmlPreview
  // clears source to null on the srcDoc path.  The fetch effect restores this
  // value if fetchProjectFileText returns null (non-2xx / transient network
  // error), so the iframe never goes blank on a failed reload attempt.
  //
  // The snapshot is keyed by projectId + fileName so that:
  //   (a) a rapid second Reload click — which sees source===null from the
  //       first click's setSource(null) — does not overwrite the ref with null
  //       and destroy the fallback (double-click race, PR #4652 review);
  //   (b) switching to a different file while a reload fetch is in flight
  //       does not restore the previous file's HTML into the new preview
  //       (file-switch contamination race, PR #4652 review).
  const prevSourceBeforeReloadRef = useRef<{
    source: string;
    projectId: string;
    fileName: string;
  } | null>(null);
  // Holds the most recently fetched non-null source for routing-predicate
  // stability.  Content-derived predicates (needsSandboxShim, needsFocusGuard,
  // looksLikeDeck) fall back to this ref when source is null (i.e. during the
  // reload window between setSource(null) and the fetch resolving), so
  // urlLoadDecision stays stable and the srcDoc iframe does not briefly flip
  // to URL-load (Codex P2, issue #4650).  Cleared on file/project switch so
  // a new file never inherits the previous file's routing predicates.
  const lastGoodSourceForRoutingRef = useRef<string | null>(null);
  const sourceFileKeyRef = useRef<string | null>(null);
  const templateNameId = useId();
  const templateDescriptionId = useId();
  const imageExportTitleId = useId();
  const pptxExportTitleId = useId();
  // Opt back into the legacy inline-asset srcDoc path via `?forceInline=1`
  // on the host page. Lets users escape-hatch around the URL-load default
  // for non-deck HTML that depends on the in-iframe localStorage shim.
  const forceInline = useMemo(
    () => (typeof window === 'undefined' ? false : parseForceInline(window.location.search)),
    [],
  );
  const [activeCommentTarget, setActiveCommentTarget] = useState<PreviewCommentSnapshot | null>(null);
  const [hoveredCommentTarget, setHoveredCommentTarget] = useState<PreviewCommentSnapshot | null>(null);
  // True while the pointer is physically over the floating hover card. The card
  // sits on top of the preview iframe, so reaching it makes the iframe fire a
  // mouseout -> od:comment-leave. We ignore that leave while pinned so the card
  // (and its selectable values) stays put instead of unmounting and flickering.
  // The pointer cannot be over the iframe and the host card at once, so a fresh
  // od:comment-hover never races this; only the card's own leave clears it.
  const hoverCardPinnedRef = useRef(false);
  // Tearing the card down is always deferred by a beat rather than done
  // synchronously. The iframe's mouseout (od:comment-leave) arrives async via
  // postMessage; the card's own mouseenter and the next od:comment-hover are the
  // signals that the pointer actually landed on the card or back on the element
  // it overlaps. Deferring lets those cancel the dismiss before it lands.
  // Synchronous teardown raced ahead of them: the card flickered on the way in
  // and vanished the moment you moved off it back onto the element it described.
  const hoverCardDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverCardDismiss = useCallback(() => {
    if (hoverCardDismissTimerRef.current !== null) {
      clearTimeout(hoverCardDismissTimerRef.current);
      hoverCardDismissTimerRef.current = null;
    }
  }, []);
  const scheduleHoverCardDismiss = useCallback(() => {
    if (hoverCardDismissTimerRef.current !== null) clearTimeout(hoverCardDismissTimerRef.current);
    hoverCardDismissTimerRef.current = setTimeout(() => {
      hoverCardDismissTimerRef.current = null;
      // hoverCardPinnedRef tracks "pointer is physically over the card". If it
      // got (re-)pinned while we waited, this now-stale dismiss must not fire.
      if (!hoverCardPinnedRef.current) setHoveredCommentTarget(null);
    }, HOVER_CARD_DISMISS_DELAY_MS);
  }, []);
  const [hoveredPodMemberId, setHoveredPodMemberId] = useState<string | null>(null);
  // If the card unmounts for any other reason while the pointer is still over
  // it (its onMouseLeave never fires), drop the pin so later leaves dismiss
  // normally instead of being swallowed forever.
  useEffect(() => {
    if (!hoveredCommentTarget) hoverCardPinnedRef.current = false;
  }, [hoveredCommentTarget]);
  // Don't let a pending dismiss outlive the component.
  useEffect(() => cancelHoverCardDismiss, [cancelHoverCardDismiss]);
  const [activePreviewCommentId, setActivePreviewCommentId] = useState<string | null>(null);
  const [liveCommentTargets, setLiveCommentTargets] = useState<Map<string, PreviewCommentSnapshot>>(() => new Map());
  const liveCommentTargetsRef = useRef(liveCommentTargets);
  const [commentOrderIds, setCommentOrderIds] = useState<string[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  // Inspect mode shares the iframe selection bridge with comment mode but
  // routes the picked element to a side panel that mutates per-element CSS
  // overrides via postMessage. The host owns the authoritative override map:
  // it is hydrated from the artifact's persisted <style> block on load and
  // mutated only by host-driven onApply / reset actions. Save-to-source
  // serializes that host map directly — iframe od:inspect-overrides messages
  // are preview acknowledgements and never feed save input, so artifact JS
  // forging a postMessage cannot tamper with what gets persisted.
  const [activeInspectTarget, setActiveInspectTarget] = useState<InspectTarget | null>(null);
  const [inspectOverrides, setInspectOverrides] = useState<InspectOverrideMap>(() =>
    typeof source === 'string' ? parseInspectOverridesFromSource(source) : {},
  );
  // Track which `source` value the host map was last hydrated from so the
  // setState-during-render hydration below only fires when the artifact
  // text actually changes (file switch, save round-trip, live edits). The
  // ref is initialised to `source` so the matching useState initialiser
  // above counts as the first hydration.
  const inspectHydratedSourceRef = useRef<string | null | undefined>(source);
  const [savingInspect, setSavingInspect] = useState(false);
  const [inspectSavedAt, setInspectSavedAt] = useState<number | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [queuedBoardNotes, setQueuedBoardNotes] = useState<string[]>([]);
  // Images attached to an element comment ("评论此元素"). Kept as raw Files
  // (uploaded on send) with object-URL thumbnails for preview/remove, mirroring
  // the markup overlay's image tray.
  const [boardImages, setBoardImages] = useState<File[]>([]);
  const [activeCommentExistingAttachments, setActiveCommentExistingAttachments] =
    useState<PreviewCommentAttachment[]>([]);
  const [boardImagePreviews, setBoardImagePreviews] = useState<{ file: File; url: string }[]>([]);
  const [boardPreviewIndex, setBoardPreviewIndex] = useState<number | null>(null);
  const [sendingBoardBatch, setSendingBoardBatch] = useState(false);
  useEffect(() => {
    const next = boardImages.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setBoardImagePreviews(next);
    return () => {
      next.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [boardImages]);
  const [commentSavedToast, setCommentSavedToast] = useState<string | null>(null);
  const [templateSavedToast, setTemplateSavedToast] = useState<string | null>(null);
  const [versionRestoredToast, setVersionRestoredToast] = useState<{ id: number; message: string } | null>(null);
  const versionRestoredToastIdRef = useRef(0);
  const [imageExportModalOpen, setImageExportModalOpen] = useState(false);
  const [imageExportFormat, setImageExportFormat] = useState<ImageExportFormat>('png');
  const [imageExportError, setImageExportError] = useState<string | null>(null);
  const [pptxExportModalOpen, setPptxExportModalOpen] = useState(false);
  const [pptxExportMode, setPptxExportMode] = useState<'editable' | 'screenshot'>('editable');
  const imageExportSnapshotDataUrlRef = useRef<string | null>(null);
  const screenshotInFlightRef = useRef(false);
  const imageExportInFlightRef = useRef(false);
  const [exportToast, setExportToast] = useState<
    { message: string; tone: 'default' | 'success' | 'error' | 'loading' } | null
  >(null);
  const [selectedSideCommentIds, setSelectedSideCommentIds] = useState<Set<string>>(() => new Set());
  const [commentSidePanelCollapsed, setCommentSidePanelCollapsed] = useState(false);
  const [strokePoints, setStrokePoints] = useState<StrokePoint[]>([]);
  const previewStateKey = `${projectId}:${file.name}`;
  const previewScale = zoom / 100;
  const localCommentSideDockActive = commentPanelOpen && !commentPortalHost;
  const boardPreviewCanvasSize = commentPreviewCanvasSize(previewBodySize, {
    boardMode: localCommentSideDockActive,
    sidePanelCollapsed: commentSidePanelCollapsed,
    viewport: previewViewport,
  });
  const boardSideDockStacked = usesStackedCommentSideDock(previewBodySize, {
    boardMode: localCommentSideDockActive,
    sidePanelCollapsed: commentSidePanelCollapsed,
    viewport: previewViewport,
  });


  // Slide deck nav state: the iframe posts the active index + total count
  // back to the host every time a slide settles. Host renders prev/next
  // controls in the toolbar and reflects the count beside them.
  const [slideState, setSlideState] = useState<SlideState | null>(
    () => htmlPreviewSlideState.get(previewStateKey) ?? null,
  );
  const boardPreviewScaleOptions = localCommentSideDockActive ? { canvasPadding: 0 } : undefined;
  const overlayPreviewScale = effectivePreviewScale(
    previewViewport,
    previewScale,
    boardPreviewCanvasSize,
    boardPreviewScaleOptions,
  );
  const overlayPreviewTransform: PreviewOverlayTransform = {
    scale: overlayPreviewScale,
    offsetX: 0,
    offsetY: 0,
  };
  const shareRef = useRef<HTMLDivElement | null>(null);
  const [chromeActionsHost, setChromeActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    setChromeActionsHost(resolveChromeActionsHost());
  }, []);

  useEffect(() => {
    liveCommentTargetsRef.current = liveCommentTargets;
  }, [liveCommentTargets]);

  useEffect(() => {
    const sourceFileKey = `${projectId}\0${file.name}\0${liveHtml === undefined ? 'raw' : 'live'}`;
    if (liveHtml !== undefined) {
      sourceFileKeyRef.current = sourceFileKey;
      sourceEverLoadedRef.current = true;
      setSource(liveHtml);
      sourceRef.current = liveHtml;
      return;
    }
    const fileChanged = sourceFileKeyRef.current !== sourceFileKey;
    sourceFileKeyRef.current = sourceFileKey;
    if (fileChanged) {
      setSource(null);
      sourceRef.current = null;
      // Note: prevSourceBeforeReloadRef is cleared by the [projectId,
      // file.name] reset effect that runs on file/project switch.  The
      // identity check in the null-restore branch below is defense-in-depth
      // for races where an in-flight async callback fires after the file
      // switches but before the effect has run.
    }
    let cancelled = false;
    // Cache-bust the fetch on every mtime / reload / files-refresh bump.
    // Without this, an agent edit during Comment mode (srcDoc path) gets
    // stale HTML from the browser HTTP cache — the source state ends up
    // identical to the previous value, srcDoc is byte-equal to the last
    // activated HTML, canActivateSrcDocTransport bails on the dedupe
    // check, and the preview only refreshes when Comment closes and the
    // url-load iframe takes over with its own ?v=mtime cache-bust.
    void fetchProjectFileText(projectId, file.name, {
      cacheBustKey: `${file.mtime}-${reloadKey}-${filesRefreshKey}`,
    }).then((text) => {
      if (cancelled) return;
      // Chokidar emits agent rewrites as unlink+add+change bursts; a
      // transient null mid-burst would blank source → srcDoc empty →
      // shell stays on prior frame. Keep the last good text instead.
      if (text == null) {
        // A srcDoc Reload may have cleared source to null just before this
        // fetch resolved.  If the fetch failed (non-2xx, network error),
        // restore the pre-reload source so the iframe doesn't go blank.
        // prevSourceBeforeReloadRef is null on a normal file-change fetch,
        // so this branch is a no-op outside of the Reload failure case.
        //
        // Guard: only restore if the snapshot was taken for the current
        // file.  A file-switch clears the ref (see fileChanged block above),
        // but we double-check the identity here to prevent cross-file
        // contamination in case the ref was not yet cleared by the time this
        // async callback fires (file-switch race, PR #4652 review).
        const snap = prevSourceBeforeReloadRef.current;
        if (
          snap != null &&
          snap.projectId === projectId &&
          snap.fileName === file.name
        ) {
          setSource(snap.source);
          sourceRef.current = snap.source;
          prevSourceBeforeReloadRef.current = null;
        } else if (snap != null) {
          // Identity mismatch: the snapshot belongs to a different file or
          // project. Clear it now so it cannot leak forward and be consumed by
          // a later normal failed load on the original file (PR #4652
          // third-pass review, Codex P2 finding).
          prevSourceBeforeReloadRef.current = null;
        }
        return;
      }
      prevSourceBeforeReloadRef.current = null;
      sourceEverLoadedRef.current = true;
      lastGoodSourceForRoutingRef.current = text;
      setSource(text);
      sourceRef.current = text;
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, liveHtml, reloadKey, filesRefreshKey]);

  // Detect deck-shaped HTML even when the project's skill didn't declare
  // `mode: deck`. Freeform projects often produce a deck because the user
  // asked for one in plain prose; without this, prev/next and Present
  // never surface and the deck becomes a static, unnavigable preview.
  const looksLikeDeck = useMemo(() => {
    const s = source ?? lastGoodSourceForRoutingRef.current;
    if (!s) return false;
    return /class\s*=\s*['"](?:[^'"]*\s)?slide(?:\s|['"])/i.test(s);
  }, [source]);
  const effectiveDeck = isDeck || looksLikeDeck;
  const showDeckNavigation = effectiveDeck && (slideState === null || slideState.count > 0);
  // Extra deck signal for EXPORT only. Runtime-managed decks (`<deck-stage>` /
  // `data-screen-label`) need deck capture even when the viewer's nav bridge
  // cannot drive them. Plain `.slide` is intentionally excluded: ordinary pages
  // use it for carousels/testimonials and must export as full pages.
  const structuredDeckExportSignal = sourceLooksLikeExportableDeck(source);
  const livePreviewSource = inlinedSource ?? source;
  // Annotation modes that should hold the preview still while open. Manual
  // Edit is handled by its own freeze just below; these are the non-edit
  // passes (Mark/Draw, Comment, Inspect) that also must not be yanked out
  // from under the user by a background file change.
  const annotationFreezeActive = drawOverlayOpen || boardMode || inspectMode;
  // Freeze the iframe input on the snapshot taken at Edit-mode entry. Any
  // source rewrite during edit (1.5s debounced set-style patches) stays
  // invisible to the iframe — live updates flow through od-edit-preview-style
  // postMessage instead, so the canvas never has to reload.
  useEffect(() => {
    if (manualEditMode && manualEditFrozenSource === null && livePreviewSource != null) {
      setManualEditFrozenSource(livePreviewSource);
    }
  }, [manualEditMode, manualEditFrozenSource, livePreviewSource]);
  // Capture / release the annotation snapshot at mode entry / exit. Captured
  // once (the `=== null` guard), so a mid-pass file change can't slip a fresh
  // snapshot in; cleared on exit so `previewSource` falls back to the latest
  // live source and the deferred update lands in one clean render.
  useEffect(() => {
    if (annotationFreezeActive) {
      if (annotationFrozenSource === null && livePreviewSource != null) {
        setAnnotationFrozenSource(livePreviewSource);
      }
    } else if (annotationFrozenSource !== null) {
      setAnnotationFrozenSource(null);
    }
  }, [annotationFreezeActive, annotationFrozenSource, livePreviewSource]);
  const previewSource = (manualEditMode && manualEditFrozenSource !== null)
    ? manualEditFrozenSource
    : (annotationFreezeActive && annotationFrozenSource !== null)
      ? annotationFrozenSource
      : livePreviewSource;
  const manualEditPageStylesEnabled = typeof source === 'string' && isManualEditFullHtmlDocument(source);
  const urlModeBridge = hasUrlModeBridge(source);
  const manualEditRequiresSrcDoc = manualEditMode || manualEditSrcDocActive;
  // When we URL-load the iframe directly, skip every in-host inlining /
  // srcDoc-rebuilding step. The browser does the asset resolution itself,
  // which is the whole point of the URL-load path.
  // Auto-fall back to the srcDoc path when the artifact will crash under
  // the URL-load iframe's bare `sandbox="allow-scripts"` — Babel-standalone
  // React prototypes and any HTML that reads Web Storage at mount throw
  // SecurityError without `allow-same-origin`. The srcDoc path runs
  // `injectSandboxShim` before any user script, so those artifacts render.
  // Memoized on `source` so HtmlViewer's frequent re-renders (board/inspect/
  // edit mode toggles, slide nav) don't re-scan the HTML each time.
  const needsSandboxShim = useMemo(() => {
    const s = source ?? lastGoodSourceForRoutingRef.current;
    return s != null && htmlNeedsSandboxShim(s);
  }, [source]);
  const needsFocusGuard = useMemo(() => {
    const s = source ?? lastGoodSourceForRoutingRef.current;
    return s != null && htmlNeedsFocusGuard(s);
  }, [source]);
  const [urlSelectionBridgeReady, setUrlSelectionBridgeReady] = useState(false);
  const urlLoadDecision: UrlLoadDecision = {
    mode,
    isDeck: effectiveDeck,
    commentMode: boardMode,
    urlCommentBridge: urlSelectionBridgeReady,
    urlSnapshotBridge: urlSelectionBridgeReady,
    editMode: manualEditMode,
    urlModeBridge,
    inspectMode,
    drawMode: drawOverlayOpen,
    forceInline: forceInline || needsSandboxShim,
    needsFocusGuard,
  };
  const useUrlLoadPreview = shouldUrlLoadHtmlPreview(urlLoadDecision) && !manualEditRequiresSrcDoc;
  const basePreviewSrcUrl = useMemo(
    () => `${projectRawUrl(projectId, file.name)}?v=${Math.round(file.mtime)}&r=${reloadKey}&odPreviewBridge=scroll&odPreviewBridge=selection&odPreviewBridge=snapshot`,
    [projectId, file.name, file.mtime, reloadKey],
  );
  const [previewSrcUrl, setPreviewSrcUrl] = useState(basePreviewSrcUrl);
  // Hold the iframe URL still (it carries file.mtime) while the user is mid
  // annotation/edit, mirroring the source freeze above. Otherwise a
  // background file change bumps mtime → basePreviewSrcUrl → a URL-load
  // reload right under an active mark/comment/edit/inspect. Captured once at
  // mode entry via a ref and released on exit, so the deferred reload lands
  // exactly once when the user is done.
  const interactivePreviewModeActive = annotationFreezeActive || manualEditMode;
  const frozenPreviewSrcUrlRef = useRef<string | null>(null);
  if (interactivePreviewModeActive) {
    if (frozenPreviewSrcUrlRef.current === null) {
      frozenPreviewSrcUrlRef.current = basePreviewSrcUrl;
    }
  } else {
    frozenPreviewSrcUrlRef.current = null;
  }
  const effectiveBasePreviewSrcUrl = frozenPreviewSrcUrlRef.current ?? basePreviewSrcUrl;
  // Switching to a different file/project while an annotation tool is still
  // open must NOT keep the viewer pinned to the previous artifact. The
  // per-file annotation data is already reset on file.name change, but the
  // freeze snapshots and the mode flags would otherwise survive — leaving the
  // frozen source/URL stuck on the old file until the user manually closes the
  // tool (and clearing the freeze alone would just re-freeze the old source
  // before the new file's fetch lands). Close the per-file tools and drop both
  // freezes on a file/project switch so the new artifact renders live, the way
  // manualEditFrozenSource is reset just above.
  useEffect(() => {
    frozenPreviewSrcUrlRef.current = null;
    setAnnotationFrozenSource(null);
    setDrawOverlayOpen(false);
    setBoardMode(false);
    setInspectMode(false);
    setSrcDocMaterialized(false);
    // Closing boardMode alone is not enough: the comment dock renders off
    // `commentPanelOpen` and a panel save reuses `activeCommentTarget` /
    // `activePreviewCommentId`, both file-scoped. Left open across a file swap
    // the dock stays visible and the next save would post back to the previous
    // file/element. Fully tear the comment tool down here. (The composer data —
    // activeCommentTarget, drafts, queued notes — is cleared by the file.name
    // reset effect below; these are the UI-open flags it doesn't touch.)
    setCommentPanelOpen(false);
    setCommentCreateMode(false);
    setActivePreviewCommentId(null);
    // Reset the "ever loaded" sentinel so the loading skeleton is shown again
    // while the new file's source is being fetched. Without this reset the
    // sentinel stays true from the previous file, the render guard skips the
    // skeleton, and a slow fetch leaves the user staring at a blank iframe
    // instead of the loading indicator (codex P2 finding, issue #4650).
    //
    // The snapshot ref (prevSourceBeforeReloadRef) is the restore branch only —
    // it must NOT gate this sentinel. Keeping the guard caused a new file's
    // preview to bypass the loading skeleton entirely and mount an empty srcDoc
    // iframe when a reload snapshot was non-null at switch time (PR #4652
    // third-pass review, PerishCode finding).
    sourceEverLoadedRef.current = false;
    lastGoodSourceForRoutingRef.current = null;
    prevSourceBeforeReloadRef.current = null;
  }, [projectId, file.name]);
  const activePreviewSrcUrl = (
    previewSrcUrl === effectiveBasePreviewSrcUrl ||
    previewSrcUrl.startsWith(`${effectiveBasePreviewSrcUrl}&`)
  )
    ? previewSrcUrl
    : effectiveBasePreviewSrcUrl;
  useEffect(() => {
    setPreviewSrcUrl(effectiveBasePreviewSrcUrl);
    setUrlSelectionBridgeReady(false);
  }, [effectiveBasePreviewSrcUrl]);
  useEffect(() => {
    iframeRef.current = useUrlLoadPreview ? urlPreviewIframeRef.current : srcDocPreviewIframeRef.current;
  }, [useUrlLoadPreview]);

  useEffect(() => {
    if (filesRefreshKey === 0) return;
    // Defer the file-watcher live-reload while annotating; the effect re-runs
    // when the mode closes (interactivePreviewModeActive flips) and applies
    // the now-current URL in one pass.
    if (interactivePreviewModeActive) return;
    const nextSrc = `${effectiveBasePreviewSrcUrl}&fr=${filesRefreshKey}`;
    const timeout = window.setTimeout(() => {
      if (useUrlLoadPreview && urlPreviewIframeRef.current?.contentWindow) {
        urlPreviewIframeRef.current.contentWindow.location.replace(nextSrc);
      } else {
        setPreviewSrcUrl(nextSrc);
      }
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [effectiveBasePreviewSrcUrl, filesRefreshKey, useUrlLoadPreview, interactivePreviewModeActive]);

  useEffect(() => {
    setInlinedSource(null);
    if (useUrlLoadPreview) return;
    if (!source || effectiveDeck || !hasRelativeAssetRefs(source)) return;
    let cancelled = false;
    void inlineRelativeAssets(source, projectId, file.name).then((next) => {
      if (!cancelled) setInlinedSource(next);
    });
    return () => {
      cancelled = true;
    };
  }, [source, effectiveDeck, projectId, file.name, reloadKey, useUrlLoadPreview]);

  const srcDoc = useMemo(
    () => (previewSource ? buildSrcdoc(previewSource, {
      deck: effectiveDeck,
      baseHref: projectRawUrl(projectId, baseDirFor(file.name)),
      initialSlideIndex: htmlPreviewSlideState.get(previewStateKey)?.active ?? 0,
      selectionBridge: true,
      // Always inject the manual-edit bridge into the PREVIEW srcDoc (not the
      // export path), so the document is byte-identical across preview /
      // comment / draw / edit. The bridge boots dormant (`enabled=false`) and
      // only acts on the host's `od-edit-mode {enabled:true}` postMessage
      // (sent by syncBridgeModes), with all its handlers gated on `enabled`
      // and its styles scoped to `html[data-od-edit-mode]`. Gating injection on
      // edit mode instead changed the srcdoc string on entering Edit, which
      // re-parses the whole document — the "reload from scratch on switch" the
      // user hit. Mirrors the always-on tweaks bridge rationale above.
      editBridge: true,
      paletteBridge: false,
      previewFocusGuard: true,
      // Embed the reload counter so the srcdoc string differs across reloads
      // even when the fetched HTML bytes are identical (issue #4650).
      reloadKey,
    }) : ''),
    [previewSource, effectiveDeck, projectId, file.name, previewStateKey, reloadKey],
  );
  const lazySrcDocTransport = useMemo(() => buildLazySrcdocTransport(), []);
  const [srcDocTransportResetKey, setSrcDocTransportResetKey] = useState(0);
  const [srcDocShellReady, setSrcDocShellReady] = useState(false);
  // Sticky once the srcDoc iframe has materialized the real artifact for the
  // first time (i.e. the first entry into Mark/Edit/Comment/Inspect). Until
  // then the srcDoc iframe stays on the lazy shell — so passive preview never
  // runs a hidden second copy of the artifact (no double mount, and no white:
  // we only materialize while the iframe is VISIBLE, where scroll/reveal
  // animations fire correctly). Once materialized it stays real even back in
  // URL-load mode (hidden), so every later mode toggle is an instant
  // visibility swap with no re-load. Reset on file/project change.
  const [srcDocMaterialized, setSrcDocMaterialized] = useState(false);
  const wasUrlLoadPreviewRef = useRef(useUrlLoadPreview);
  const urlPreviewKeepAliveKey = previewIframeKeepAliveKey(projectId, file.name);
  // Reset the shell-ready latch whenever the srcDoc iframe re-mounts. The
  // next shell will post `od:srcdoc-transport-ready` (or fire onLoad) and
  // flip this back to true. See #2253.
  useEffect(() => {
    setSrcDocShellReady(false);
  }, [srcDocTransportResetKey]);
  // Listen for the shell's ready handshake. Gating activation on this is
  // what fixes the #2253 race: opening Tweaks right after a key-driven
  // re-mount used to post `activate` before the shell's listener was
  // installed, dropping the message and stranding the iframe on the empty
  // 536-byte body.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== srcDocPreviewIframeRef.current?.contentWindow) return;
      const data = ev.data as { type?: string } | null;
      if (data?.type !== 'od:srcdoc-transport-ready') return;
      setSrcDocShellReady(true);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const frame = urlPreviewIframeRef.current;
      if (ev.source !== frame?.contentWindow) return;
      if (frame.getAttribute('src') === 'about:blank') return;
      const data = ev.data as { type?: string } | null;
      if (data?.type !== 'od:url-selection-bridge-ready') return;
      setUrlSelectionBridgeReady(true);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  // Lazy transport preloads an empty shell only while URL-load is the active
  // transport. Once srcdoc becomes active (sandbox shim, Draw, Screenshot,
  // Tweaks, etc.), mount the real artifact HTML directly so we do not depend on
  // a postMessage activation that can race (#2253) and strand the iframe blank
  // (#2361, #2791).
  const captureModeActive = drawOverlayOpen;
  // Once `srcDocMaterialized` is set (after the first mode entry), keep the
  // srcDoc iframe on the real artifact even when hidden behind URL-load, so
  // re-entering a mode is an instant visibility swap rather than a re-mount +
  // re-load. Direct-mount path (no #2361/#2791 postMessage race).
  const useLazySrcDocTransport =
    !manualEditRequiresSrcDoc && !captureModeActive && useUrlLoadPreview && !srcDocMaterialized;
  const srcDocTransportContent = useLazySrcDocTransport ? lazySrcDocTransport : srcDoc;
  // Materialize the srcDoc iframe the first time it actually becomes the active
  // (visible) transport — i.e. the first Mark/Edit/Comment/Inspect entry. We do
  // NOT pre-render it while hidden/idle: that ran a second live copy during
  // passive preview (double mount) and rendered scroll/reveal-animated content
  // while invisible, which left it stuck blank (the white-on-enter bug). Doing
  // it on first visible entry means the one materialization paints correctly,
  // and the sticky flag keeps it warm for every subsequent toggle.
  useEffect(() => {
    if (!useUrlLoadPreview && !srcDocMaterialized) setSrcDocMaterialized(true);
  }, [useUrlLoadPreview, srcDocMaterialized]);
  // When the srcDoc switch is driven ONLY by Draw/annotation mode — an
  // artifact that would otherwise URL-load — keep the URL-load iframe warm
  // instead of parking it at about:blank. Draw is a quick "mark → screenshot →
  // close" round-trip; parking forces a full artifact re-fetch the moment the
  // overlay closes, which users see as a jarring black → loading → reload right
  // after every screenshot. Sticky srcDoc modes (inspect / edit / palette /
  // tweaks / comment / deck / focus-guard / sandbox-shim) keep parking, so two
  // live copies never linger beyond the brief annotation pass.
  const srcDocForcedOnlyByDraw =
    drawOverlayOpen &&
    !manualEditRequiresSrcDoc &&
    shouldUrlLoadHtmlPreview({ ...urlLoadDecision, drawMode: false });
  const urlTransportSrc =
    useUrlLoadPreview || srcDocForcedOnlyByDraw ? activePreviewSrcUrl : 'about:blank';
  const activateSrcDocTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    if (!canActivateSrcDocTransport({
      srcDoc,
      useUrlLoadPreview,
      useLazySrcDocTransport,
      shellReady: srcDocShellReady,
      activatedHtml: activatedSrcDocTransportHtmlRef.current,
    })) return false;
    // A SECOND activation while Comment mode is on would document.open +
    // write over the iframe's existing document. The window-level message
    // listener survives, but iframe.onLoad does NOT refire for
    // document.write, so host-side re-init (slide nav sync, scroll
    // restore, bridge replay) is silently skipped — the visible page can
    // drift out of sync with the host's tracked state (e.g. the page
    // indicator shows 3 while the iframe rendered page 4 of the freshly
    // edited deck). Force a fresh shell mount under Comment so onLoad
    // fires and the full re-init pipeline runs against the new HTML.
    //
    // Skip the remount path in Manual Edit, where the postMessage
    // activate carries the patched HTML and host-side scroll/slide
    // state intentionally stays put across the patch.
    if (boardMode && activatedSrcDocTransportHtmlRef.current !== null) {
      activatedSrcDocTransportHtmlRef.current = null;
      setSrcDocTransportResetKey((key) => key + 1);
      return true;
    }
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'od:srcdoc-transport-activate', html: srcDoc }, '*');
    activatedSrcDocTransportHtmlRef.current = srcDoc;
    return true;
  }, [srcDoc, useLazySrcDocTransport, useUrlLoadPreview, srcDocShellReady, boardMode]);
  const activateLoadedSrcDocTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    if (!canActivateSrcDocTransport({
      srcDoc,
      useUrlLoadPreview,
      useLazySrcDocTransport,
      shellReady: true,
      activatedHtml: activatedSrcDocTransportHtmlRef.current,
    })) return false;
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'od:srcdoc-transport-activate', html: srcDoc }, '*');
    activatedSrcDocTransportHtmlRef.current = srcDoc;
    return true;
  }, [srcDoc, useLazySrcDocTransport, useUrlLoadPreview]);
  const activateSrcDocSnapshotTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    if (!srcDoc) return false;
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'od:srcdoc-transport-activate', html: srcDoc }, '*');
    return true;
  }, [srcDoc]);
  useEffect(() => {
    if (useUrlLoadPreview) {
      activatedSrcDocTransportHtmlRef.current = null;
      // Remounting the srcDoc iframe on a render-mode flip resets it to a fresh
      // lazy shell — needed ONLY for the lazy postMessage-activation path
      // (#2253 shell-ready handshake). When the srcDoc iframe is direct-mounted
      // (prewarmed, or an annotation mode), its content lives in the srcdoc
      // attribute, so a remount would just throw away the warm render and force
      // a reload. That is exactly the thrash users saw toggling Comment
      // (URL-load) ↔ Mark (srcDoc): each flip remounted and reloaded. Keep the
      // iframe alive in the direct-mount case so the toggle is a pure
      // visibility swap.
      if (!wasUrlLoadPreviewRef.current && useLazySrcDocTransport) {
        setSrcDocTransportResetKey((key) => key + 1);
      }
      wasUrlLoadPreviewRef.current = true;
      return;
    }
    if (wasUrlLoadPreviewRef.current && useLazySrcDocTransport) {
      setSrcDocTransportResetKey((key) => key + 1);
      activatedSrcDocTransportHtmlRef.current = null;
    }
    wasUrlLoadPreviewRef.current = false;
    activateSrcDocTransport();
  }, [activateSrcDocTransport, useUrlLoadPreview, useLazySrcDocTransport]);

  useEffect(() => {
    restorePreviewScrollPosition();
  }, [boardMode, drawOverlayOpen, manualEditMode, srcDoc, restorePreviewScrollPosition]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as {
        type?: string;
        frameLeft?: number;
        frameTop?: number;
        canvasLeft?: number;
        canvasTop?: number;
      } | null;
      if (!data || data.type !== 'od:preview-scroll') return;
      if (previewScrollRestoreRef.current && Number(data.canvasLeft || 0) === 0 && Number(data.canvasTop || 0) === 0) return;
      if (
        previewScrollPositionRef.current.canvasLeft !== 0 ||
        previewScrollPositionRef.current.canvasTop !== 0
      ) {
        const isInitialZeroReport = Number(data.canvasLeft || 0) === 0 && Number(data.canvasTop || 0) === 0;
        if (isInitialZeroReport && Date.now() - previewScrollRequestAtRef.current < 1200) return;
      }
      previewScrollPositionRef.current = {
        frameLeft: Number(data.frameLeft || 0),
        frameTop: Number(data.frameTop || 0),
        canvasLeft: Number(data.canvasLeft || 0),
        canvasTop: Number(data.canvasTop || 0),
      };
    }
    function onRestoreRequest(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as { type?: string } | null;
      if (!data || data.type !== 'od:preview-scroll-request') return;
      previewScrollRequestAtRef.current = Date.now();
      const snapshot = previewScrollRestoreRef.current;
      const scroll = snapshot ?? {
        frameLeft: previewScrollPositionRef.current.frameLeft,
        frameTop: previewScrollPositionRef.current.frameTop,
        canvasLeft: previewScrollPositionRef.current.canvasLeft,
        canvasTop: previewScrollPositionRef.current.canvasTop,
      };
      iframeRef.current?.contentWindow?.postMessage({
        type: 'od:preview-scroll-restore',
        frameLeft: scroll.frameLeft,
        frameTop: scroll.frameTop,
        canvasLeft: scroll.canvasLeft,
        canvasTop: scroll.canvasTop,
      }, '*');
    }
    function onDcViewportMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as {
        type?: string;
        x?: number;
        y?: number;
        scale?: number;
      } | null;
      if (!data || !data.type) return;
      if (data.type === '__dc_viewport') {
        const x = Number(data.x || 0);
        const y = Number(data.y || 0);
        const scale = Number(data.scale || 1);
        const hasExistingPosition = dcViewportRef.current.x !== 0 || dcViewportRef.current.y !== 0;
        const isInitialZeroReport = x === 0 && y === 0 && scale === 1;
        if (hasExistingPosition && isInitialZeroReport && Date.now() - dcViewportRestoreAtRef.current < 1500) return;
        dcViewportRef.current = {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        };
        return;
      }
      if (data.type === '__dc_viewport_request') {
        dcViewportRestoreAtRef.current = Date.now();
        iframeRef.current?.contentWindow?.postMessage({
          type: '__dc_set_viewport',
          ...dcViewportRef.current,
        }, '*');
      }
    }
    window.addEventListener('message', onMessage);
    window.addEventListener('message', onRestoreRequest);
    window.addEventListener('message', onDcViewportMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('message', onRestoreRequest);
      window.removeEventListener('message', onDcViewportMessage);
    };
  }, [isActivePreviewIframeSource, isOurPreviewIframeSource]);

  useEffect(() => {
    if (!effectiveDeck) {
      setSlideState(null);
      return;
    }
    setSlideState(htmlPreviewSlideState.get(previewStateKey) ?? null);
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev?.data as
        | { type?: string; active?: number; count?: number }
        | null;
      if (!data || data.type !== 'od:slide-state') return;
      if (typeof data.active !== 'number' || typeof data.count !== 'number') return;
      const next = { active: data.active, count: data.count };
      setSlideStateCached(previewStateKey, next);
      setSlideState(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [effectiveDeck, isActivePreviewIframeSource, isOurPreviewIframeSource, previewStateKey]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({
      type: 'od:comment-mode',
      enabled: boardMode,
      mode: boardTool,
    }, '*');
  }, [boardMode, boardTool, srcDoc, useUrlLoadPreview]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od-edit-mode', enabled: manualEditMode }, '*');
    postSelectedManualEditTargetToIframe(manualEditMode ? selectedManualEditTarget?.id ?? null : null);
  }, [manualEditMode, selectedManualEditTarget?.id, srcDoc, useUrlLoadPreview]);

  const previewStyleToIframe = useCallback((id: string, styles: Partial<ManualEditStyles>, version: number) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'od-edit-preview-style', id, styles, version }, '*');
    return true;
  }, []);

  function postSelectedManualEditTargetToIframe(id: string | null, target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od-edit-selected-target', id }, '*');
  }

  function syncBridgeModes(target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    win.postMessage({
      type: 'od:comment-mode',
      enabled: boardMode,
      mode: boardTool,
    }, '*');
    win.postMessage({ type: 'od-edit-mode', enabled: manualEditMode }, '*');
    postSelectedManualEditTargetToIframe(manualEditMode ? selectedManualEditTarget?.id ?? null : null, target);
    win.postMessage({ type: 'od:inspect-mode', enabled: inspectMode }, '*');
  }

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od:inspect-mode', enabled: inspectMode }, '*');
  }, [inspectMode, srcDoc, useUrlLoadPreview]);

  // Mirror the bridge's `od:comment-targets` broadcast into
  // `liveCommentTargets` whenever EITHER Inspect or Comments mode is
  // active. The boardMode-only useEffect below still handles its
  // own comment-specific events (hover / click target / pod), but
  // the targets list itself is mode-agnostic — it's just "which
  // elements on the page carry data-od-id / data-screen-label".
  // Without this listener Inspect mode never learns the artifact's
  // annotation count, and the empty-state hint added for #890 would
  // misfire (always firing in Inspect mode, even on annotated
  // artifacts) because the comment-mode listener short-circuits on
  // `!boardMode`. Issue #890.
  useEffect(() => {
    if (!inspectMode && !boardMode) {
      setLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      return;
    }
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as
        | {
            type?: string;
            targets?: Array<Partial<PreviewCommentSnapshot>>;
          }
        | null;
      if (data?.type !== 'od:comment-targets' || !Array.isArray(data.targets)) return;
      const next = new Map<string, PreviewCommentSnapshot>();
      data.targets.forEach((item) => {
        const elementId = String(item?.elementId || '');
        if (!elementId) return;
        const position = {
          x: clampBridgeCoordinate(item?.position?.x),
          y: clampBridgeCoordinate(item?.position?.y),
          width: clampBridgeCoordinate(item?.position?.width),
          height: clampBridgeCoordinate(item?.position?.height),
        };
        if (!isValidCommentOverlayPosition(position)) return;
        next.set(elementId, {
          filePath: file.name,
          elementId,
          selector: String(item?.selector || ''),
          label: String(item?.label || ''),
          text: String(item?.text || ''),
          position,
          htmlHint: String(item?.htmlHint || ''),
          style: normalizeAnnotationStyle(item?.style),
          selectionKind: 'element',
          memberCount: undefined,
          ...(typeof item?.slideIndex === 'number' ? { slideIndex: item.slideIndex } : {}),
        });
      });
      setLiveCommentTargets((current) => (
        liveCommentTargetMapsEqual(current, next) ? current : next
      ));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inspectMode, boardMode, file.name, isOurPreviewIframeSource]);

  useEffect(() => {
    setActiveCommentTarget(null);
    setHoveredCommentTarget(null);
    setLiveCommentTargets(new Map());
    setCommentDraft('');
    setActiveCommentExistingAttachments([]);
    setActiveInspectTarget(null);
    setInspectOverrides({});
    setInspectSavedAt(null);
    setInspectError(null);
    setQueuedBoardNotes([]);
    setStrokePoints([]);
    setManualEditFrozenSource(null);
    setManualEditViewportWidth(null);
    setManualEditTargets([]);
    setSelectedManualEditTarget(null);
    setManualEditPanelPosition(null);
    selectedManualEditTargetIdRef.current = null;
    setManualEditDraft(emptyManualEditDraft());
    setManualEditDraftDirty(false);
    setManualEditHistory([]);
    setManualEditUndone([]);
    setManualEditError(null);
    manualEditPendingStyleRef.current = null;
    clearManualEditStyleTimer();
  }, [file.name]);

  // Selecting a new file or turning inspect/comment-inspect off resets the panel target.
  useEffect(() => {
    if (!inspectMode && !(boardMode && boardTool === 'inspect')) {
      setActiveInspectTarget(null);
      setInspectError(null);
    }
  }, [inspectMode, boardMode, boardTool]);

  // Hydrate the host-authoritative override map from the artifact source
  // synchronously, *before* React commits a render that carries a new
  // `srcDoc` to the iframe. A `useEffect([source])` would commit the new
  // source first and only re-render with the parsed map afterwards — if
  // the iframe finishes loading the new srcDoc in that window, its
  // `onLoad` handler captures the previous file's empty/stale map in its
  // closure and posts that map back over the bridge's freshly DOM-hydrated
  // overrides, leaving the preview without saved inspect styles until the
  // next reload or mode toggle. Setting state during render is React's
  // documented escape hatch for "store a value derived from props"
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // the in-flight render is discarded and React re-renders with the
  // updated state before commit, so the new `srcDoc` and the new
  // `inspectOverrides` always commit together. After hydration the map
  // only mutates from host-driven onApply / reset callbacks below, so
  // artifact JS forging an od:inspect-overrides message cannot tamper
  // with what saveInspectToSource will persist.
  if (inspectHydratedSourceRef.current !== source) {
    inspectHydratedSourceRef.current = source;
    setInspectOverrides(typeof source === 'string' ? parseInspectOverridesFromSource(source) : {});
  }

  useEffect(() => {
    sourceRef.current = source;
    if (source == null) return;
    setManualEditDraft((current) => (
      current.fullSource === source ? current : { ...current, fullSource: source }
    ));
  }, [source]);

  useEffect(() => {
    selectedManualEditTargetIdRef.current = selectedManualEditTarget?.id ?? null;
  }, [selectedManualEditTarget?.id]);

  useEffect(() => {
    if (!boardMode) {
      setCommentCreateMode(false);
      setActiveCommentTarget((current) => (current ? null : current));
      setHoveredCommentTarget((current) => (current ? null : current));
      setActivePreviewCommentId((current) => (current ? null : current));
      setLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      setQueuedBoardNotes((current) => (current.length > 0 ? [] : current));
      setStrokePoints((current) => (current.length > 0 ? [] : current));
      return;
    }
    const snapshotFromData = (data: Partial<PreviewCommentSnapshot>): PreviewCommentSnapshot => ({
      filePath: file.name,
      elementId: String(data.elementId || ''),
      selector: String(data.selector || ''),
      label: String(data.label || ''),
      text: String(data.text || ''),
      position: {
        x: clampBridgeCoordinate(data.position?.x),
        y: clampBridgeCoordinate(data.position?.y),
        width: clampBridgeCoordinate(data.position?.width),
        height: clampBridgeCoordinate(data.position?.height),
      },
      hoverPoint: data.hoverPoint
        ? {
            x: clampBridgeCoordinate(data.hoverPoint.x),
            y: clampBridgeCoordinate(data.hoverPoint.y),
          }
        : undefined,
      htmlHint: String(data.htmlHint || ''),
      style: normalizeAnnotationStyle(data.style),
      selectionKind: data.selectionKind === 'pod' ? 'pod' : 'element',
      memberCount: finiteBridgeInteger(data.memberCount),
      podMembers: Array.isArray(data.podMembers) ? data.podMembers : undefined,
      ...(typeof data.slideIndex === 'number' ? { slideIndex: data.slideIndex } : {}),
    });
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as (Partial<PreviewCommentSnapshot> & {
        type?: string;
        targets?: Array<Partial<PreviewCommentSnapshot>>;
        points?: StrokePoint[];
      }) | null;
      if (!data?.type) return;
      if (data.type === 'od:comment-targets' && Array.isArray(data.targets)) {
        const next = new Map<string, PreviewCommentSnapshot>();
        data.targets.forEach((item) => {
          const snapshot = snapshotFromData(item);
          if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
          next.set(snapshot.elementId, snapshot);
        });
        setLiveCommentTargets((current) => (
          liveCommentTargetMapsEqual(current, next) ? current : next
        ));
        setActiveCommentTarget((current) => {
          if (!current) return null;
          if (current.selectionKind === 'pod') return current;
          const updated = next.get(current.elementId);
          if (!updated || !isValidCommentOverlayPosition(updated.position)) return null;
          return commentSnapshotEqual(current, updated) ? current : updated;
        });
        setHoveredCommentTarget((current) => {
          if (!current) return null;
          if (current.selectionKind === 'pod') return current;
          const updated = next.get(current.elementId);
          if (!updated || !isValidCommentOverlayPosition(updated.position)) return null;
          return commentSnapshotEqual(current, updated) ? current : updated;
        });
        return;
      }
      if (data.type === 'od:comment-active-target-update') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
        // Fires on every pointermove while a target is active — skip the Map
        // clone and the active/hovered state writes when nothing changed, so a
        // steady hover doesn't re-render the whole overlay each frame.
        setLiveCommentTargets((current) => {
          const existing = current.get(snapshot.elementId);
          if (existing && commentSnapshotEqual(existing, snapshot)) return current;
          return new Map(current).set(snapshot.elementId, snapshot);
        });
        setActiveCommentTarget((current) =>
          current && current.elementId === snapshot.elementId && !commentSnapshotEqual(current, snapshot)
            ? snapshot
            : current,
        );
        setHoveredCommentTarget((current) =>
          current && current.elementId === snapshot.elementId && !commentSnapshotEqual(current, snapshot)
            ? snapshot
            : current,
        );
        return;
      }
      if (data.type === 'od:comment-leave') {
        // Already firmly on the card — nothing to dismiss.
        if (hoverCardPinnedRef.current) return;
        // The pointer left the element. It may be sliding onto the floating card
        // (which overlaps the iframe) or hopping toward an adjacent element —
        // both should keep the card up. Defer the dismiss so the card's
        // mouseenter or the next comment-hover can cancel it; only a leave with
        // nothing following actually tears the card down.
        scheduleHoverCardDismiss();
        return;
      }
      if (data.type === 'od:comment-hover') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
        // Pointer landed on an element — cancel any deferred dismiss so moving
        // from the card back onto the element it describes keeps the card.
        cancelHoverCardDismiss();
        // Hover repeats the same snapshot per pointermove frame — keep the
        // existing state object (and skip the Map clone) when it is unchanged.
        setHoveredCommentTarget((current) =>
          current && current.elementId === snapshot.elementId && commentSnapshotEqual(current, snapshot)
            ? current
            : snapshot,
        );
        setLiveCommentTargets((current) => {
          const existing = current.get(snapshot.elementId);
          if (existing && commentSnapshotEqual(existing, snapshot)) return current;
          return new Map(current).set(snapshot.elementId, snapshot);
        });
        return;
      }
      if (data.type === 'od:comment-target') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
        const shouldOpenComposer = boardMode || commentCreateMode;
        cancelHoverCardDismiss();
        setActiveCommentTarget((current) => (shouldOpenComposer ? snapshot : current));
        setHoveredCommentTarget(snapshot);
        setLiveCommentTargets((current) => {
          const existing = current.get(snapshot.elementId);
          if (existing && commentSnapshotEqual(existing, snapshot)) return current;
          return new Map(current).set(snapshot.elementId, snapshot);
        });
        if (shouldOpenComposer) {
          setActivePreviewCommentId(null);
          setCommentDraft('');
          setQueuedBoardNotes([]);
          setActiveCommentExistingAttachments([]);
        }
        return;
      }
      if (data.type === 'od:pod-clear') {
        setStrokePoints([]);
        return;
      }
      if (data.type === 'od:pod-stroke' && Array.isArray(data.points)) {
        setStrokePoints(
          data.points.map((point) => ({
            x: clampBridgeCoordinate(point.x),
            y: clampBridgeCoordinate(point.y),
          })),
        );
        return;
      }
      if (data.type === 'od:pod-select' && Array.isArray(data.points)) {
        const points = data.points.map((point) => ({
          x: clampBridgeCoordinate(point.x),
          y: clampBridgeCoordinate(point.y),
        }));
        setStrokePoints(points);
        const nextTarget = buildPodSnapshot({
          filePath: file.name,
          strokePoints: points,
          liveTargets: liveCommentTargetsRef.current,
        });
        if (!nextTarget) {
          setStrokePoints([]);
          return;
        }
        setActiveCommentTarget(nextTarget);
        setHoveredCommentTarget(nextTarget);
        setActivePreviewCommentId(null);
        setQueuedBoardNotes([]);
        setCommentDraft('');
        setActiveCommentExistingAttachments([]);
        setStrokePoints([]);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeCommentTarget, boardMode, boardTool, cancelHoverCardDismiss, commentPortalHost, file.name, isOurPreviewIframeSource, previewComments, scheduleHoverCardDismiss]);

  useEffect(() => {
    if (!boardMode || !activeCommentTarget || activeCommentTarget.selectionKind === 'pod') return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'od:comment-active-target',
      elementId: activeCommentTarget.elementId,
      selector: activeCommentTarget.selector,
    }, '*');
  }, [activeCommentTarget?.elementId, activeCommentTarget?.selector, activeCommentTarget?.selectionKind, boardMode]);

  useEffect(() => {
    if (!manualEditMode) {
      setManualEditTargets([]);
      setSelectedManualEditTarget(null);
      setManualEditHoverTarget(null);
      setManualEditPageStylesOpen(false);
      setManualEditPanelPosition(null);
      setManualEditDraftDirty(false);
      selectedManualEditTargetIdRef.current = null;
      manualEditSelectionDraftRef.current = null;
      manualEditTextSessionIdRef.current = null;
      manualEditTextFinishRef.current = null;
      manualEditTextCommitInFlightRef.current = null;
      setManualEditError(null);
      manualEditPendingStyleRef.current = null;
      if (manualEditStyleTimerRef.current) {
        clearTimeout(manualEditStyleTimerRef.current);
        manualEditStyleTimerRef.current = null;
      }
      return;
    }
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as ManualEditBridgeMessage | null;
      if (!data?.type) return;
      if (data.type === 'od-edit-targets' && Array.isArray(data.targets)) {
        setManualEditTargets(data.targets);
        // Target broadcasts can be briefly empty while the iframe/save path is
        // settling; keep the user's inspector selection unless a fresh copy is
        // available to update its metadata.
        setSelectedManualEditTarget((current) =>
          current ? data.targets.find((target) => target.id === current.id) ?? current : current,
        );
        const selectedId = selectedManualEditTargetIdRef.current;
        if (selectedId) setTimeout(() => postSelectedManualEditTargetToIframe(selectedId), 0);
        return;
      }
      if (data.type === 'od-edit-select') {
        setManualEditHoverTarget(null);
        void selectManualEditTarget(data.target);
        return;
      }
      if (data.type === 'od-edit-hover') {
        // While an inline text edit is live, hovering must not surface or switch
        // any affordance — that instability is the other half of #3646.
        if (manualEditTextSessionIdRef.current) return;
        // Hover only surfaces a lightweight "edit params" affordance; it must
        // NOT switch the pinned inspector. The panel changes only when the
        // user clicks that affordance (or a container/image body), so moving
        // the cursor across the canvas never yanks the panel away mid-edit.
        setManualEditHoverTarget(
          data.target.id === selectedManualEditTargetIdRef.current ? null : data.target,
        );
        return;
      }
      if (data.type === 'od-edit-background') {
        // Clicking empty canvas deselects and opens the compact page-styles
        // card — only meaningful for full HTML documents.
        setManualEditHoverTarget(null);
        if (typeof source === 'string' && isManualEditFullHtmlDocument(source)) {
          void clearManualEditTargetSelection();
          setManualEditPageStylesOpen(true);
        }
        return;
      }
      if (data.type === 'od-edit-text-commit') {
        // Keep the apply promise reachable so any teardown (host- or
        // iframe-initiated) can await it and honor a failed save before tearing
        // down. It self-clears once resolved, keyed to identity so a newer
        // commit is never clobbered.
        const commit = applyManualEdit({
          id: String(data.id),
          kind: 'set-text',
          value: String(data.value),
        }, 'Edit text');
        manualEditTextCommitInFlightRef.current = commit;
        void (async () => {
          try { await commit; } catch { /* failure honored by teardown / surfaced by applyManualEdit */ }
          if (manualEditTextCommitInFlightRef.current === commit) {
            manualEditTextCommitInFlightRef.current = null;
          }
        })();
        return;
      }
      if (data.type === 'od-edit-text-session') {
        const sessionId = String(data.id || '');
        if (data.active) {
          manualEditTextSessionIdRef.current = sessionId;
          return;
        }
        if (manualEditTextSessionIdRef.current === sessionId) {
          manualEditTextSessionIdRef.current = null;
        }
        const pending = manualEditTextFinishRef.current;
        if (pending) {
          // settle() awaits the in-flight commit before resolving the caller's
          // teardown, so the final edit is never dropped.
          pending();
        }
        // Iframe-driven finishes (Enter / clicking another target) leave the
        // commit promise in place; it self-clears on resolution, and any later
        // teardown still awaits it via settlePendingManualEditCommit so a failed
        // save is never silently torn down.
        return;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isOurPreviewIframeSource, manualEditMode, source]);

  function nextManualEditPreviewVersion(): number {
    manualEditPreviewVersionRef.current += 1;
    return manualEditPreviewVersionRef.current;
  }

  function inspectorManualEditStyles(target: ManualEditTarget, baseSource: string): ManualEditStyles {
    const inlineStyles = readManualEditStyles(baseSource, target.id);
    return mergeManualEditInspectorStyles(inlineStyles, target.styles);
  }

  function reconcileManualEditStyleSave(
    id: string,
    savedStyles: Partial<ManualEditStyles>,
    savedSource: string,
  ) {
    if (id !== '__body__' && !readManualEditOuterHtml(savedSource, id)) {
      setManualEditError('The selected target no longer exists in the saved source. Refreshing the preview.');
      setSelectedManualEditTarget(null);
      setManualEditFrozenSource(null);
      setReloadKey((key) => key + 1);
      return;
    }
    const sourceStyles = readManualEditStyles(savedSource, id);
    const supersededStyles = manualEditPendingStyleRef.current?.id === id
      ? manualEditPendingStyleRef.current.styles
      : {};
    const repairStyles: Partial<ManualEditStyles> = {};
    for (const key of Object.keys(savedStyles) as Array<keyof ManualEditStyles>) {
      if (Object.prototype.hasOwnProperty.call(supersededStyles, key)) continue;
      const sourceValue = manualEditInspectorStyleValue(key, sourceStyles[key] ?? '');
      const savedValue = savedStyles[key] ?? '';
      if (manualEditPersistedValueMatchesSavedSnapshot(key, sourceValue, savedValue)) continue;
      repairStyles[key] = sourceValue;
    }
    if (Object.keys(repairStyles).length === 0) return;
    previewStyleToIframe(id, repairStyles, nextManualEditPreviewVersion());
    setManualEditDraft((current) => ({
      ...current,
      styles: { ...current.styles, ...repairStyles },
    }));
    setManualEditError('Saved styles differed from the active preview. Reconciled the selected target from source.');
  }

  function clearManualEditStyleTimer() {
    if (!manualEditStyleTimerRef.current) return;
    clearTimeout(manualEditStyleTimerRef.current);
    manualEditStyleTimerRef.current = null;
  }

  function cancelManualEditPendingStyles(id: string, keys: Array<keyof ManualEditStyles>) {
    const nextPending = cancelManualEditPendingStyleSnapshot(manualEditPendingStyleRef.current, id, keys);
    if (!nextPending) {
      manualEditPendingStyleRef.current = null;
      clearManualEditStyleTimer();
      return;
    }
    manualEditPendingStyleRef.current = nextPending;
  }

  async function handleManualEditStyleChange(id: string, styles: Partial<ManualEditStyles>, label: string) {
    const version = nextManualEditPreviewVersion();
    const currentPending = manualEditPendingStyleRef.current;
    const pendingStyles = currentPending?.id === id
      ? { ...currentPending.styles, ...styles }
      : styles;
    const pending: ManualEditPendingStyleSave = { id, styles: pendingStyles, label, version };
    manualEditPendingStyleRef.current = pending;
    setManualEditError(null);
    previewStyleToIframe(id, styles, version);
  }

  async function flushManualEditStyleSave(): Promise<boolean> {
    const pending = manualEditPendingStyleRef.current;
    if (!pending) return true;
    if (manualEditSavingRef.current) return false;
    manualEditPendingStyleRef.current = null;
    return applyManualEdit({ id: pending.id, kind: 'set-style', styles: pending.styles }, pending.label);
  }

  function cancelManualEditStyleDraft() {
    const pending = manualEditPendingStyleRef.current;
    if (!pending) return;
    clearManualEditStyleTimer();
    manualEditPendingStyleRef.current = null;
    const base = sourceRef.current ?? '';
    const target = pending.id === '__body__'
      ? null
      : selectedManualEditTarget?.id === pending.id
        ? selectedManualEditTarget
        : manualEditTargets.find((item) => item.id === pending.id) ?? null;
    const sourceStyles = target
      ? inspectorManualEditStyles(target, base)
      : readManualEditStyles(base, pending.id);
    const resetStyles = MANUAL_EDIT_STYLE_PROPS.reduce<Partial<ManualEditStyles>>((acc, key) => {
      acc[key] = sourceStyles[key] ?? '';
      return acc;
    }, {});
    previewStyleToIframe(pending.id, resetStyles, nextManualEditPreviewVersion());
    if (!target || target.id === selectedManualEditTarget?.id) {
      setManualEditDraft((current) => ({
        ...current,
        styles: target ? sourceStyles : current.styles,
        fullSource: base,
      }));
    }
    setManualEditError(null);
  }

  // Ends the iframe's inline text edit and resolves only once it acks (and any
  // resulting commit has been applied). Callers that tear down edit state must
  // await this so the final edit is never dropped — the #3647 exit-path bug.
  // A timeout backstops a detached iframe so teardown can never hang.
  // Resolves to whether the session ended cleanly: true when there was nothing
  // to commit or the commit succeeded, false when the pending text commit
  // failed (applyManualEdit returned false / threw). Callers that tear down
  // edit state must honor a false result — keep edit mode open and preserve the
  // error so a failed save never looks like a successful one (#4291 review).
  function finishManualEditTextSession(commit: boolean): Promise<boolean> {
    const win = iframeRef.current?.contentWindow;
    if (!win || !manualEditTextSessionIdRef.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        // Mark the session ended even on the timeout path, so a follow-up
        // clearManualEditTargetSelection (e.g. from cancel) does not see a live
        // session and re-finish it with commit:true — turning cancel into save.
        manualEditTextSessionIdRef.current = null;
        if (manualEditTextFinishRef.current === settle) manualEditTextFinishRef.current = null;
        // Wait out the in-flight commit before resolving, so the final edit is
        // persisted before teardown even if the timeout backstop won the race
        // against the iframe's ack. The commit clears its own ref on resolution.
        const commitInFlight = manualEditTextCommitInFlightRef.current;
        void (async () => {
          let committed = true;
          try {
            // applyManualEdit resolves false when the save fails (or the source
            // changed externally); surface that so callers can abort teardown.
            if ((await commitInFlight) === false) committed = false;
          } catch {
            committed = false;
          }
          resolve(committed);
        })();
      };
      manualEditTextFinishRef.current = settle;
      win.postMessage({ type: 'od-edit-text-finish', commit }, '*');
      // Backstop a detached iframe so teardown can never hang; the ack path
      // clears this timer when it wins.
      timer = setTimeout(settle, 1500);
    });
  }

  // Settles whatever inline text edit is still pending before teardown and
  // reports whether it committed cleanly: the live session if one is active,
  // otherwise an in-flight commit left by an iframe-driven finish (Enter /
  // click-another-target). Returns false on a failed commit so callers keep
  // edit mode open with the error rather than tearing down through it (#4291).
  async function settlePendingManualEditCommit(): Promise<boolean> {
    if (manualEditTextSessionIdRef.current) {
      return finishManualEditTextSession(true);
    }
    const commitInFlight = manualEditTextCommitInFlightRef.current;
    if (!commitInFlight) return true;
    try {
      return (await commitInFlight) !== false;
    } catch {
      return false;
    }
  }

  async function exitManualEditModeAfterFlush(): Promise<boolean> {
    // A failed text commit must keep edit mode open with its error visible,
    // rather than tearing down (which would clear the error) and looking saved.
    if (!(await settlePendingManualEditCommit())) {
      return false;
    }
    const ok = await flushManualEditStyleSave();
    if (!ok) return false;
    setManualEditPanelPosition(null);
    setManualEditMode(false);
    return true;
  }

  // Clears the hover affordance and re-arms the iframe's per-element hover
  // dedupe so re-entering the same element re-announces it. Called from the
  // workspace's own mouseleave (host-side), NOT the iframe's mouseleave — the
  // affordance overlays the iframe, so reacting to the iframe leaving would
  // yank it out from under the cursor and strobe on/off.
  function clearManualEditHover() {
    setManualEditHoverTarget(null);
    const win = iframeRef.current?.contentWindow;
    if (win) win.postMessage({ type: 'od-edit-hover-reset' }, '*');
  }

  async function selectManualEditTarget(target: ManualEditTarget) {
    setManualEditPageStylesOpen(false);
    if (manualEditPendingStyleRef.current?.id !== target.id) cancelManualEditStyleDraft();
    const base = sourceRef.current ?? '';
    const nextDraft = manualEditDraftForTarget(target, base);
    selectedManualEditTargetIdRef.current = target.id;
    manualEditSelectionDraftRef.current = { id: target.id, draft: nextDraft };
    setSelectedManualEditTarget(target);
    setManualEditDraft(nextDraft);
    setManualEditDraftDirty(false);
    setManualEditError(null);
  }

  function manualEditDraftForTarget(target: ManualEditTarget, base: string): ManualEditDraft {
    const fields = readManualEditFields(base, target.id);
    return {
      text: fields.text ?? target.fields.text ?? target.text,
      href: fields.href ?? target.fields.href ?? '',
      src: fields.src ?? target.fields.src ?? '',
      alt: fields.alt ?? target.fields.alt ?? '',
      styles: inspectorManualEditStyles(target, base),
      attributesText: JSON.stringify(readManualEditAttributes(base, target.id), null, 2),
      outerHtml: readManualEditOuterHtml(base, target.id) || target.outerHtml,
      fullSource: base,
    };
  }

  async function clearManualEditTargetSelection() {
    // If an inline edit is still live (e.g. clearing the selection from the
    // panel mid-edit), commit it first so it is not lost. Keep the selection
    // and the error if that commit fails.
    if (!(await settlePendingManualEditCommit())) {
      return;
    }
    cancelManualEditStyleDraft();
    selectedManualEditTargetIdRef.current = null;
    manualEditSelectionDraftRef.current = null;
    manualEditTextSessionIdRef.current = null;
    setSelectedManualEditTarget(null);
    setManualEditPanelPosition(null);
    setManualEditDraft(emptyManualEditDraft(sourceRef.current ?? ''));
    setManualEditDraftDirty(false);
    setManualEditError(null);
  }

  // The inspector is scoped to one element (or the page). Closing it should
  // only collapse the panel and keep the user in edit mode — exiting edit is
  // the toolbar toggle's job. Dismiss flushes any in-flight tweak first so
  // nothing is lost; cancel reverts the in-flight unsaved tweak instead.
  async function dismissManualEditPanel() {
    // Closing the panel must not swallow a failed text commit: keep it open
    // with the error if the pending edit could not be saved.
    if (!(await settlePendingManualEditCommit())) {
      return;
    }
    const ok = await flushManualEditStyleSave();
    if (!ok) return;
    if (selectedManualEditTarget) void clearManualEditTargetSelection();
    else setManualEditPageStylesOpen(false);
  }

  function manualEditContentPatchForDraft(
    target: ManualEditTarget,
    draft: ManualEditDraft,
    base: string,
  ): { patch: ManualEditPatch; label: string } | null {
    const fields = readManualEditFields(base, target.id);
    if (target.kind === 'text' || target.kind === 'token') {
      const currentText = fields.text ?? target.fields.text ?? target.text;
      if (draft.text !== currentText) {
        return { patch: { id: target.id, kind: 'set-text', value: draft.text }, label: t('manualEdit.applyContent') };
      }
      return null;
    }
    if (target.kind === 'link') {
      const currentText = fields.text ?? target.fields.text ?? target.text;
      const currentHref = fields.href ?? target.fields.href ?? '';
      if (draft.text !== currentText || draft.href !== currentHref) {
        return { patch: { id: target.id, kind: 'set-link', text: draft.text, href: draft.href }, label: t('manualEdit.applyContent') };
      }
      return null;
    }
    if (target.kind === 'image') {
      const currentSrc = fields.src ?? target.fields.src ?? '';
      const currentAlt = fields.alt ?? target.fields.alt ?? '';
      if (draft.src !== currentSrc || draft.alt !== currentAlt) {
        return { patch: { id: target.id, kind: 'set-image', src: draft.src, alt: draft.alt }, label: t('manualEdit.applyContent') };
      }
      return null;
    }
    const currentOuterHtml = readManualEditOuterHtml(base, target.id) || target.outerHtml;
    if (draft.outerHtml !== currentOuterHtml) {
      return { patch: { id: target.id, kind: 'set-outer-html', html: draft.outerHtml }, label: t('manualEdit.applyHtml') };
    }
    return null;
  }

  async function saveManualEditPanelDraft() {
    const hadTextSession = Boolean(manualEditTextSessionIdRef.current || manualEditTextCommitInFlightRef.current);
    if (!(await settlePendingManualEditCommit())) return;
    if (selectedManualEditTarget && !hadTextSession) {
      const base = sourceRef.current ?? '';
      const contentPatch = manualEditContentPatchForDraft(selectedManualEditTarget, manualEditDraft, base);
      if (contentPatch && !(await applyManualEdit(contentPatch.patch, contentPatch.label))) return;
    }
    const ok = await flushManualEditStyleSave();
    if (!ok) return;
    if (selectedManualEditTarget) void clearManualEditTargetSelection();
    else setManualEditPageStylesOpen(false);
  }

  async function resetManualEditPanelDraft() {
    if (manualEditTextSessionIdRef.current) await finishManualEditTextSession(false);
    cancelManualEditStyleDraft();
    if (!selectedManualEditTarget) {
      setManualEditDraft(emptyManualEditDraft(sourceRef.current ?? ''));
      setManualEditError(null);
      return;
    }
    const snapshot = manualEditSelectionDraftRef.current?.id === selectedManualEditTarget.id
      ? manualEditSelectionDraftRef.current.draft
      : manualEditDraftForTarget(selectedManualEditTarget, sourceRef.current ?? '');
    const base = sourceRef.current ?? '';
    const currentOuterHtml = readManualEditOuterHtml(base, selectedManualEditTarget.id);
    if (snapshot.outerHtml && currentOuterHtml && snapshot.outerHtml !== currentOuterHtml) {
      const ok = await applyManualEdit(
        { id: selectedManualEditTarget.id, kind: 'set-outer-html', html: snapshot.outerHtml },
        'Reset element',
      );
      if (!ok) return;
    }
    const refreshedBase = sourceRef.current ?? base;
    setManualEditDraft({
      ...snapshot,
      fullSource: refreshedBase,
      styles: inspectorManualEditStyles(selectedManualEditTarget, refreshedBase),
    });
    setManualEditDraftDirty(false);
    setManualEditError(null);
    postSelectedManualEditTargetToIframe(selectedManualEditTarget.id);
  }

  async function cancelManualEditPanel() {
    if (manualEditTextSessionIdRef.current) await finishManualEditTextSession(false);
    if (selectedManualEditTarget) {
      void clearManualEditTargetSelection();
    } else {
      cancelManualEditStyleDraft();
      setManualEditPageStylesOpen(false);
    }
  }

  async function applyManualEdit(patch: ManualEditPatch, label: string): Promise<boolean> {
    if (manualEditSavingRef.current) return false;
    if (sourceRef.current == null) return false;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    setManualEditError(null);
    try {
      const baseSource = sourceRef.current;
      const result = applyManualEditPatch(baseSource, patch);
      if (!result.ok) {
        setManualEditError(result.error ?? 'Could not apply edit.');
        return false;
      }
      if (!(await confirmManualEditHistorySource(
        baseSource,
        'The file changed outside manual edit mode. Refreshing before applying manual edits.',
      ))) return false;
      const saved = await writeProjectTextFileDetailed(projectId, file.name, result.source, {
        artifactManifest: file.artifactManifest,
        versionSource: 'manual',
        versionLabel: label,
        expectedEtag: fileEtagRef.current,
      });
      if (!saved.ok) {
        const status = 'status' in saved ? saved.status : undefined;
        const code = 'code' in saved ? saved.code : undefined;
        const message = 'message' in saved ? saved.message : 'Unknown save error';
        setManualEditError(
          `Could not save the edited file${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`,
        );
        return false;
      }
      fileEtagRef.current = saved.file.etag ?? fileEtagRef.current;
      const entry: ManualEditHistoryEntry = {
        id: `${Date.now()}-${manualEditHistory.length}`,
        label,
        patch,
        beforeSource: baseSource,
        afterSource: result.source,
        createdAt: Date.now(),
      };
      setSource(result.source);
      sourceRef.current = result.source;
      setInlinedSource(null);
      if (patch.kind !== 'set-style') {
        setManualEditFrozenSource(result.source);
      }
      setManualEditHistory((current) => [entry, ...current]);
      setManualEditUndone([]);
      setManualEditDraft((current) => ({ ...current, fullSource: result.source }));
      if (patch.kind === 'set-text') {
        setSelectedManualEditTarget((current) => current?.id === patch.id
          ? { ...current, text: patch.value, fields: { ...current.fields, text: patch.value } }
          : current);
        setManualEditDraft((current) => ({ ...current, text: patch.value, fullSource: result.source }));
      } else if (patch.kind === 'set-link') {
        setSelectedManualEditTarget((current) => current?.id === patch.id
          ? { ...current, text: patch.text, fields: { ...current.fields, text: patch.text, href: patch.href } }
          : current);
        setManualEditDraft((current) => ({ ...current, text: patch.text, href: patch.href, fullSource: result.source }));
      } else if (patch.kind === 'set-image') {
        setSelectedManualEditTarget((current) => current?.id === patch.id
          ? { ...current, fields: { ...current.fields, src: patch.src, alt: patch.alt } }
          : current);
        setManualEditDraft((current) => ({ ...current, src: patch.src, alt: patch.alt, fullSource: result.source }));
      } else if (patch.kind === 'remove-element') {
        if (manualEditPendingStyleRef.current?.id === patch.id) {
          manualEditPendingStyleRef.current = null;
          clearManualEditStyleTimer();
        }
        selectedManualEditTargetIdRef.current = null;
        manualEditSelectionDraftRef.current = null;
        setSelectedManualEditTarget(null);
        setManualEditTargets((current) => current.filter((target) => target.id !== patch.id));
        setManualEditDraft(emptyManualEditDraft(result.source));
        setManualEditDraftDirty(false);
        postSelectedManualEditTargetToIframe(null);
      } else {
        setManualEditDraft((current) => ({ ...current, fullSource: result.source }));
      }
      if (
        patch.kind !== 'remove-element' &&
        patch.kind !== 'set-token' &&
        patch.kind !== 'set-full-source' &&
        selectedManualEditTargetIdRef.current === patch.id
      ) {
        setManualEditDraftDirty(true);
      }
      if (patch.kind === 'set-style') {
        reconcileManualEditStyleSave(patch.id, patch.styles, result.source);
      }
      setManualEditError(null);
      await onFileSaved?.();
      return true;
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
    }
  }

  async function confirmManualEditHistorySource(expectedSource: string, message: string): Promise<boolean> {
    const persisted = await fetchProjectFileText(projectId, file.name, {
      cache: 'no-store',
      cacheBustKey: Date.now(),
    });
    if (persisted == null || persisted === expectedSource) return true;
    setSource(persisted);
    sourceRef.current = persisted;
    setInlinedSource(null);
    setManualEditHistory([]);
    setManualEditUndone([]);
    manualEditPendingStyleRef.current = null;
    setManualEditDraft((current) => ({ ...current, fullSource: persisted }));
    setManualEditError(message);
    return false;
  }

  async function undoManualEdit() {
    if (manualEditSavingRef.current) return;
    const [latest, ...rest] = manualEditHistory;
    if (!latest) return;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    try {
      if (!(await confirmManualEditHistorySource(
        latest.afterSource,
        'The file changed outside manual edit mode. History was cleared to avoid overwriting newer content.',
      ))) return;
      const saved = await writeProjectTextFile(projectId, file.name, latest.beforeSource, {
        artifactManifest: file.artifactManifest,
        versionSource: 'manual',
        versionLabel: `Undo ${latest.label}`,
        expectedEtag: fileEtagRef.current,
      });
      if (!saved) {
        setManualEditError('Could not save the undo result.');
        return;
      }
      fileEtagRef.current = saved.etag ?? fileEtagRef.current;
      setSource(latest.beforeSource);
      sourceRef.current = latest.beforeSource;
      setInlinedSource(null);
      setManualEditFrozenSource(latest.beforeSource);
      setManualEditHistory(rest);
      setManualEditUndone((current) => [latest, ...current]);
      setManualEditDraft((current) => ({ ...current, fullSource: latest.beforeSource }));
      await onFileSaved?.();
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
    }
  }

  async function redoManualEdit() {
    if (manualEditSavingRef.current) return;
    const [latest, ...rest] = manualEditUndone;
    if (!latest) return;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    try {
      if (!(await confirmManualEditHistorySource(
        latest.beforeSource,
        'The file changed outside manual edit mode. History was cleared to avoid overwriting newer content.',
      ))) return;
      const saved = await writeProjectTextFile(projectId, file.name, latest.afterSource, {
        artifactManifest: file.artifactManifest,
        versionSource: 'manual',
        versionLabel: `Redo ${latest.label}`,
        expectedEtag: fileEtagRef.current,
      });
      if (!saved) {
        setManualEditError('Could not save the redo result.');
        return;
      }
      fileEtagRef.current = saved.etag ?? fileEtagRef.current;
      setSource(latest.afterSource);
      sourceRef.current = latest.afterSource;
      setInlinedSource(null);
      setManualEditFrozenSource(latest.afterSource);
      setManualEditUndone(rest);
      setManualEditHistory((current) => [latest, ...current]);
      setManualEditDraft((current) => ({ ...current, fullSource: latest.afterSource }));
      await onFileSaved?.();
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
    }
  }

  // Inspect-mode picker: same `od:comment-target` payload, different sink.
  // The bridge tags the message with a computed-style snapshot so the panel
  // can show real starting values for color / typography / spacing / radius.
  useEffect(() => {
    if (!inspectMode) return;
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as
        | {
            type?: string;
            elementId?: string;
            selector?: string;
            label?: string;
            text?: string;
            style?: InspectStyleSnapshot;
            clickedDescendant?: Partial<InspectClickedDescendant>;
          }
        | null;
      if (!data || data.type !== 'od:comment-target') return;
      if (!data.elementId || !data.selector) return;
      const clickedDescendant =
        data.clickedDescendant && typeof data.clickedDescendant === 'object'
          ? {
              label: String(data.clickedDescendant.label || ''),
              text: String(data.clickedDescendant.text || ''),
            }
          : null;
      setActiveInspectTarget({
        elementId: String(data.elementId),
        selector: String(data.selector),
        label: String(data.label || ''),
        text: String(data.text || ''),
        style: data.style && typeof data.style === 'object' ? data.style : {},
        ...(clickedDescendant ? { clickedDescendant } : {}),
      });
      setInspectError(null);
      setInspectSavedAt(null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inspectMode, isOurPreviewIframeSource]);

  function postSlide(action: 'next' | 'prev' | 'first' | 'last') {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od:slide', action }, '*');
  }

  function syncCachedSlideStateToIframe(target: HTMLIFrameElement | null = iframeRef.current) {
    const active = htmlPreviewSlideState.get(previewStateKey)?.active;
    const win = target?.contentWindow;
    if (!win || typeof active !== 'number') return;
    win.postMessage({ type: 'od:slide', action: 'go', index: active }, '*');
  }

  function postInspectSet(elementId: string, selector: string, prop: string, value: string) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      { type: 'od:inspect-set', elementId, selector, prop, value },
      '*',
    );
  }

  function postInspectReset(elementId?: string) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od:inspect-reset', elementId }, '*');
  }

  // Replay the host's authoritative override map into the freshly loaded
  // iframe. The bridge inside the iframe only sees rules persisted in the
  // artifact source via its own hydrateOverridesFromDom() — any unsaved
  // edit lives on the host side until Save-to-source. Without this replay,
  // toggling Inspect off/on, switching to Comment mode, or any other
  // srcdoc rebuild reloads the iframe from previewSource without the
  // unsaved style block, so the preview drops the live edits while
  // saveInspectToSource() can still persist them later from the stale
  // host map. The bridge re-validates each entry under its own allow-list,
  // so a parent that posted a hostile replay can only land overrides the
  // bridge would also have accepted via od:inspect-set.
  //
  // The render-time hydration above keeps `inspectOverrides` aligned with
  // the current `source` whenever React commits, but the iframe `onLoad`
  // callback fires from a separate event-loop turn after the new srcDoc
  // is parsed; if it ever races a stale closure (e.g. an interleaved
  // remount), reading React state would post the previous file's map over
  // the bridge's DOM-hydrated one and silently strip the persisted styles
  // from preview. Re-derive synchronously from `source` whenever the
  // hydration ref disagrees so onLoad never sends a stale snapshot.
  function replayInspectOverridesToIframe(target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    const overrides = inspectHydratedSourceRef.current === source
      ? inspectOverrides
      : (typeof source === 'string' ? parseInspectOverridesFromSource(source) : {});
    win.postMessage({ type: 'od:inspect-replay', overrides }, '*');
  }

  // Persist accumulated inspect overrides into the artifact source: replace
  // (or insert) a single <style data-od-inspect-overrides> block in <head>.
  // The CSS body is serialized from the host's own override map, hydrated
  // from source on load and updated only by host-driven onApply / reset
  // callbacks. We deliberately do NOT round-trip through the iframe at save
  // time: artifact JS rendered inside the preview shares the same
  // contentWindow as the bridge and could forge an od:inspect-overrides
  // reply that flips allow-listed properties on elements the user never
  // touched. POSTing to /api/projects/:id/files upserts the file via
  // writeProjectFile (multipart-or-JSON; we use JSON).
  async function saveInspectToSource() {
    if (!source) return;
    setSavingInspect(true);
    setInspectError(null);
    try {
      const css = serializeInspectOverrides(inspectOverrides).trim();
      const next = applyInspectOverridesToSource(source, css);
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          content: next,
          versionSource: 'manual',
          versionLabel: t('fileViewer.edit'),
          expectedEtag: fileEtagRef.current,
        }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(payload?.error || payload?.message || `Save failed (${resp.status})`);
      }
      const saved = await resp.json().catch(() => null) as { file?: ProjectFile } | null;
      fileEtagRef.current = saved?.file?.etag ?? fileEtagRef.current;
      setSource(next);
      setInspectSavedAt(Date.now());
      setReloadKey((k) => k + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setInspectError(msg);
      // The error banner inside the inspect panel is easy to miss when the
      // user is focused on the iframe preview — surface failures in the
      // console as well so quota/network errors aren't silently lost.
      console.error('[inspect] saveToSource failed:', err);
    } finally {
      setSavingInspect(false);
    }
  }

  // Keyboard nav on the host, so the user can press ←/→ even when focus
  // is on the chat composer or any other host control.
  useEffect(() => {
    if (!effectiveDeck || mode !== 'preview') return;
    function onKey(e: KeyboardEvent) {
      if (document.activeElement === iframeRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        postSlide('next');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        postSlide('prev');
      } else if (e.key === 'Home') {
        e.preventDefault();
        postSlide('first');
      } else if (e.key === 'End') {
        e.preventDefault();
        postSlide('last');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveDeck, mode]);

  useEffect(() => {
    if (!presentMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.present-wrap')) return;
      setPresentMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresentMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [presentMenuOpen]);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!zoomMenuRef.current) return;
      if (!zoomMenuRef.current.contains(e.target as Node)) setZoomMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [zoomMenuOpen]);

  useEffect(() => {
    if (!toolbarMoreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!toolbarMoreRef.current) return;
      if (!toolbarMoreRef.current.contains(e.target as Node)) setToolbarMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setToolbarMoreOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [toolbarMoreOpen]);

  useEffect(() => {
    if (!agentToolsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.artifact-tool-menu-anchor')) return;
      closeArtifactToolMenus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArtifactToolMenus();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [agentToolsOpen]);

  useEffect(() => {
    if (!downloadMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!shareRef.current) return;
      if (shareRef.current.contains(e.target as Node)) return;
      setDownloadMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDownloadMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [downloadMenuOpen]);

  useEffect(() => {
    if (!inTabPresent) return;
    const bodyStyle = document.body.style;
    const previousChromeHeight = bodyStyle.getPropertyValue('--workspace-tabs-chrome-height');
    const updateChromeHeight = () => {
      const chrome = document.querySelector<HTMLElement>('.workspace-tabs-chrome.app-chrome-header');
      const height = chrome?.getBoundingClientRect().height ?? 0;
      if (height > 0) {
        bodyStyle.setProperty('--workspace-tabs-chrome-height', `${Math.round(height)}px`);
      } else {
        bodyStyle.removeProperty('--workspace-tabs-chrome-height');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInTabPresent(false);
    };
    updateChromeHeight();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updateChromeHeight);
    const chrome = document.querySelector<HTMLElement>('.workspace-tabs-chrome.app-chrome-header');
    const observer = chrome && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateChromeHeight) : null;
    if (observer && chrome) observer.observe(chrome);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updateChromeHeight);
      observer?.disconnect();
      if (previousChromeHeight) {
        bodyStyle.setProperty('--workspace-tabs-chrome-height', previousChromeHeight);
      } else {
        bodyStyle.removeProperty('--workspace-tabs-chrome-height');
      }
    };
  }, [inTabPresent]);

  function openInNewTab() {
    if (!source) return;
    openSandboxedPreviewInNewTab(source, exportTitle, {
      deck: effectiveDeck,
      baseHref: projectRawUrl(projectId, baseDirFor(file.name)),
      initialSlideIndex: htmlPreviewSlideState.get(previewStateKey)?.active ?? 0,
    });
  }

  // Snapshot this project as a reusable template. The daemon snapshots
  // EVERY html/text/code file in the project (not just the file open in
  // the viewer), so the template captures the whole design, not a single
  // page. Surfaced here in the Download menu because templates are saved
  // from the same artifact output surface as files.
  function openSaveAsTemplateModal() {
    setDownloadMenuOpen(false);

    const defaultName =
      file.name.replace(/\.html?$/i, '') || t('fileViewer.templateNameDefault');
    setTemplateName(defaultName);
    setTemplateDescription('');
    setTemplateSaveError(null);
    setTemplateModalOpen(true);
  }

  async function handleSaveAsTemplate() {
    const name = templateName.trim();
    if (!name) return;
    setSavingTemplate(true);
    setTemplateNote(null);
    setTemplateSaveError(null);
    let savedName: string | null = null;
    // Default to failed; flips to success only when the save resolves. The
    // finally block reports exactly one artifact_export_result(template),
    // covering the !tpl branch and any thrown error too.
    let templateOutcome: 'success' | 'failed' = 'failed';
    let templateErrorCode: string | undefined = 'UNKNOWN';
    try {
      const tpl = await saveTemplate({
        name,
        description: templateDescription.trim() || undefined,
        sourceProjectId: projectId,
      });
      if (!tpl) {
        setTemplateSaveError(t('fileViewer.savedTemplateFail'));
        templateErrorCode = 'SAVE_FAILED';
        return;
      }
      savedName = tpl.name;
      setTemplateModalOpen(false);
      setTemplateName('');
      setTemplateDescription('');
      setTemplateNote(t('fileViewer.savedTemplate', { name: tpl.name }));
      // Show success toast
      setTemplateSavedToast(t('fileViewer.savedTemplate', { name: tpl.name }));
      templateOutcome = 'success';
      templateErrorCode = undefined;
    } finally {
      setSavingTemplate(false);

      if (savedName) {
        // Auto-clear the note so the menu doesn't keep stale state next open.
        if (templateNoteTimerRef.current !== null) clearTimeout(templateNoteTimerRef.current);
        templateNoteTimerRef.current = setTimeout(() => {
          templateNoteTimerRef.current = null;
          setTemplateNote(null);
        }, 4000);
      }
    }
  }

  function presentInThisTab() {
    setPresentMenuOpen(false);
    setMode('preview');
    setInTabPresent(true);
  }

  function presentFullscreen() {
    setPresentMenuOpen(false);
    const el = previewBodyRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      el.requestFullscreen().catch(() => setInTabPresent(true));
    } else {
      setInTabPresent(true);
    }
  }

  function presentNewTab() {
    setPresentMenuOpen(false);
    openInNewTab();
  }

  function reloadHtmlPreview() {

    capturePreviewScrollPosition();
    imageExportSnapshotDataUrlRef.current = null;
    setInlinedSource(null);
    setReloadKey((key) => key + 1);
    if (!useUrlLoadPreview) {
      // Capture the current source so the fetch effect can restore it if
      // fetchProjectFileText returns null (non-2xx / transient network error).
      // Without this, a failed reload leaves source null and the iframe blank
      // because the existing keep-last-good guard in the fetch effect has
      // nothing to fall back to (PR #4652).
      //
      // Only overwrite the ref when source is non-null: if a rapid second
      // Reload click fires while source is already null (cleared by the first
      // click), we must NOT overwrite the ref — doing so would discard the
      // genuine last-good snapshot that the first click stored, and the
      // restore path would have nothing to fall back to (double-click race,
      // PR #4652 review).  The snapshot is keyed with the current file
      // identity so the restore guard can reject stale cross-file snapshots.
      if (source !== null) {
        prevSourceBeforeReloadRef.current = {
          source,
          projectId,
          fileName: file.name,
        };
      }
      // Clear source synchronously so previewSource becomes null and the
      // srcDoc memo recomputes to '' before the async re-fetch resolves.
      // Without this, the remounted iframe carries stale srcdoc content
      // until the fetch completes (issue #4650).
      //
      // Skip the synchronous clear when Manual Edit is active
      // (manualEditFrozenSource !== null).  Nulling source here also nulls
      // sourceRef.current (via the [source] useEffect at ~line 5962), which
      // causes applyManualEdit to hit its null guard and silently drop the
      // save before the reload fetch resolves (PR #4652 Codex P2 / issue #4650).
      // The reload still re-fetches via the reloadKey increment above; source
      // stays at the last-good frozen value until the fetch resolves, so
      // applyManualEdit continues to work throughout the reload window.
      if (!manualEditFrozenSource) {
        setSource(null);
      }
      // Clear the annotation-freeze snapshot so previewSource is not pinned
      // to the stale V1 content while annotationFreezeActive is true.  The
      // annotation-freeze useEffect (deps: annotationFreezeActive,
      // annotationFrozenSource, livePreviewSource) re-captures from
      // livePreviewSource on the next render once the fresh `source` lands,
      // so the frozen source updates to the new V2 content automatically
      // (PR #4652 / issue #4650 mrcfps review).
      setAnnotationFrozenSource(null);
      activatedSrcDocTransportHtmlRef.current = null;
      setSrcDocShellReady(false);
      setSrcDocTransportResetKey((key) => key + 1);
    }
  }

  async function handleVersionRestored(content: string) {
    setSource(content);
    sourceRef.current = content;
    setInlinedSource(null);
    setReloadKey((key) => key + 1);
    await onFileSaved?.();
    setVersionRestoredToast({
      id: (versionRestoredToastIdRef.current += 1),
      message: t('fileViewer.versions.restoreSuccess'),
    });
  }

  function selectMode(nextMode: 'preview' | 'source') {
    if (nextMode === 'source') setDrawOverlayOpen(false);
    setMode(nextMode);
  }

  function activateBoard(nextTool?: BoardTool) {
    setMode('preview');
    setBoardMode(true);
    if (nextTool) setBoardTool(nextTool);
  }


  function clearBoardComposer() {
    setActiveCommentTarget(null);
    setHoveredCommentTarget(null);
    setHoveredPodMemberId(null);
    setActivePreviewCommentId(null);
    setCommentDraft('');
    setQueuedBoardNotes([]);
    setBoardImages([]);
    setActiveCommentExistingAttachments([]);
    setBoardPreviewIndex(null);
    setStrokePoints([]);
  }

  function addBoardImages(files: File[]) {
    const imgs = files.filter((file) => file.type.startsWith('image/'));
    if (imgs.length > 0) setBoardImages((current) => [...current, ...imgs]);
  }

  function removeBoardImage(index: number) {
    setBoardImages((current) => current.filter((_, i) => i !== index));
    setBoardPreviewIndex(null);
  }

  function closeArtifactToolMenus() {
    setAgentToolsOpen(false);
  }

  function activateDrawTool() {

    const next = !drawOverlayOpen;
    if (!next) {
      setDrawOverlayOpen(false);
      setAgentToolsOpen(false);
      return;
    }
    capturePreviewScrollPosition();
    const activateDraw = () => {
      setCommentPanelOpen(false);
      setCommentCreateMode(false);
      setBoardMode(false);
      clearBoardComposer();
      setInspectMode(false);
      setMode('preview');
      setDrawOverlayOpen(true);
      closeArtifactToolMenus();
    };
    if (manualEditMode) {
      void exitManualEditModeAfterFlush().then((ok) => {
        if (ok) activateDraw();
      });
      return;
    }
    activateDraw();
  }

  function activateCommentTool() {

    capturePreviewScrollPosition();
    if (boardMode && !commentCreateMode && boardTool === 'inspect') {
      setBoardMode(false);
      setCommentCreateMode(false);
      clearBoardComposer();
      setAgentToolsOpen(false);
      return;
    }
    const activateComment = () => {
      setCommentPanelOpen(false);
      setCommentCreateMode(false);
      clearBoardComposer();
      setInspectMode(false);
      setDrawOverlayOpen(false);
      setMode('preview');
      activateBoard('inspect');
      closeArtifactToolMenus();
    };
    if (manualEditMode) {
      void exitManualEditModeAfterFlush().then((ok) => {
        if (ok) activateComment();
      });
      return;
    }
    activateComment();
  }

  function activateCommentCreateTool() {

    capturePreviewScrollPosition();
    if (boardMode && commentCreateMode) {
      setBoardMode(false);
      setCommentCreateMode(false);
      setCommentPanelOpen(false);
      clearBoardComposer();
      closeArtifactToolMenus();
      return;
    }
    const activateCommentCreate = () => {
      setCommentPanelOpen(true);
      setCommentSidePanelCollapsed(false);
      setCommentCreateMode(true);
      if (!activeCommentTarget) clearBoardComposer();
      setInspectMode(false);
      setDrawOverlayOpen(false);
      setMode('preview');
      activateBoard('inspect');
      closeArtifactToolMenus();
    };
    if (manualEditMode) {
      void exitManualEditModeAfterFlush().then((ok) => {
        if (ok) activateCommentCreate();
      });
      return;
    }
    activateCommentCreate();
  }

  function activateManualEditTool() {

    capturePreviewScrollPosition();
    if (!manualEditMode) {
      setCommentPanelOpen(false);
      setCommentCreateMode(false);
      setBoardMode(false);
      clearBoardComposer();
      setInspectMode(false);
      setDrawOverlayOpen(false);
      setMode('preview');
      setManualEditViewportWidth(previewBodyRef.current?.clientWidth ?? null);
      setManualEditSrcDocActive(true);
      setManualEditMode(true);
      closeArtifactToolMenus();
      return;
    }
    closeArtifactToolMenus();
    void exitManualEditModeAfterFlush();
  }

  function queueCurrentDraft() {
    const note = commentDraft.trim();
    if (!note) return;
    setQueuedBoardNotes((current) => [...current, note]);
    setCommentDraft('');
  }

  function currentActiveComposerComment(): PreviewComment | null {
    if (!activePreviewCommentId) return null;
    return previewComments.find((comment) => (
      comment.id === activePreviewCommentId &&
      comment.filePath === file.name &&
      comment.status === 'open'
    )) ?? null;
  }

  function currentActiveComposerAttachments(): PreviewCommentAttachment[] {
    return currentActiveComposerComment()?.attachments ?? activeCommentExistingAttachments;
  }

  function withDeckSlideIndex(target: PreviewCommentTarget): PreviewCommentTarget {
    if (!effectiveDeck || typeof slideState?.active !== 'number') return target;
    if (typeof target.slideIndex === 'number') return target;
    return { ...target, slideIndex: slideState.active };
  }

  async function sendBoardBatch() {
    if (!activeCommentTarget || !onSendBoardCommentAttachments) return;
    const nextNotes = [...queuedBoardNotes];
    if (commentDraft.trim()) nextNotes.push(commentDraft.trim());
    if (nextNotes.length === 0 && boardImages.length === 0) {
      const existingComment = currentActiveComposerComment();
      if (existingComment) {
        setSendingBoardBatch(true);
        try {
          await onSendBoardCommentAttachments(commentsToAttachments([existingComment]));
          clearBoardComposer();
        } finally {
          setSendingBoardBatch(false);
        }
      }
      return;
    }
    setSendingBoardBatch(true);
    try {
      const existingAttachments = currentActiveComposerAttachments();
      const attachments = buildBoardCommentAttachments({
        target: withDeckSlideIndex(targetFromSnapshot(activeCommentTarget)),
        notes: nextNotes,
        includeImageOnly: boardImages.length > 0,
        imageAttachmentCount: boardImages.length,
      }).map((attachment) => (
        existingAttachments.length > 0
          ? { ...attachment, imageAttachments: existingAttachments }
          : attachment
      ));
      const accepted = await onSendBoardCommentAttachments(
        attachments,
        boardImages,
      );
      if (accepted === false) return;
      clearBoardComposer();
    } finally {
      setSendingBoardBatch(false);
    }
  }

  async function savePersistentComment() {
    if (!activeCommentTarget || !onSavePreviewComment) return;
    // Allow saving when there is text OR an attached image (image-only notes).
    if (!commentDraft.trim() && boardImages.length === 0 && currentActiveComposerAttachments().length === 0) return;
    const isFreePin = activeCommentTarget.elementId.startsWith('pin-');
    setSendingBoardBatch(true);
    try {
      const target = withDeckSlideIndex(targetFromSnapshot(activeCommentTarget));
      const saved = await onSavePreviewComment(
        target,
        commentDraft.trim(),
        false,
        boardImages,
      );
      if (saved) {
        rememberSavedPreviewCommentOrder(saved.id);
        clearBoardComposer();
        setActiveCommentExistingAttachments(saved.attachments ?? []);
        setBoardMode(true);
        setCommentCreateMode(true);
        setCommentPanelOpen(true);
        setCommentSidePanelCollapsed(false);
        setActivePreviewCommentId(saved.id);
        setCommentSavedToast(isFreePin ? t('chat.comments.pinSavedToast') : t('chat.comments.savedToast'));
      }
    } finally {
      setSendingBoardBatch(false);
    }
  }

  async function savePanelComment(note: string) {
    if (!onSavePreviewComment) return false;
    const cleanNote = note.trim();
    if (!cleanNote) return false;
    const idSeed = Date.now().toString(36);
    const target: PreviewCommentTarget = activeCommentTarget
      ? targetFromSnapshot(activeCommentTarget)
      : {
          filePath: file.name,
          elementId: `file-comment-${idSeed}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          selector: 'html',
          label: file.name,
          text: '',
          position: { x: 0, y: 0, width: 0, height: 0 },
          htmlHint: '',
          selectionKind: 'element',
        };
    setSendingBoardBatch(true);
    try {
      const saved = await onSavePreviewComment(target, cleanNote, false);
      if (saved) {
        rememberSavedPreviewCommentOrder(saved.id);
        setCommentSavedToast(t('chat.comments.savedToast'));
        if (activeCommentTarget) clearBoardComposer();
      }
      return Boolean(saved);
    } finally {
      setSendingBoardBatch(false);
    }
  }

  const showPresent = source !== null;
  const exportTitle = file.name.replace(/\.html?$/i, '') || file.name;
  const artifactKind = file.artifactManifest?.kind ?? file.artifactKind ?? null;
  const rendererId = file.artifactManifest?.renderer ?? null;
  const isDeckArtifact =
    isDeck ||
    projectKind === 'slide_deck' ||
    artifactKind === 'deck' ||
    rendererId === 'deck-html' ||
    file.kind === 'presentation';
  const deckExportSignal = isDeckArtifact || structuredDeckExportSignal;
  const isMarkdownArtifact =
    artifactKind === 'markdown-document' ||
    rendererId === 'markdown' ||
    file.kind === 'text' && /\.mdx?$/i.test(file.name);
  const isShareableArtifact =
    file.kind === 'html' ||
    isDeckArtifact ||
    artifactKind === 'html' ||
    rendererId === 'html';
  const canShare = source !== null && isShareableArtifact;
  const canDownload = source !== null && (isShareableArtifact || isMarkdownArtifact);
  // PPTX export is slide-based, so show it only for explicit decks plus
  // structured deck runtimes. Do not key this off plain `.slide`: ordinary
  // parallax/long pages may use that class but must remain page-mode exports.
  const showPptxExport = canShare && deckExportSignal;
  const canPptx = showPptxExport && !streaming;
  const showMarkdownExport = source !== null && isMarkdownArtifact;
  const showImageExport = canShare;

  useEffect(() => {
    const nudgeKey = `${projectId}\n${file.name}`;
    if (!canShare || exportReadyNudgeSeenRef.current.has(nudgeKey)) return;
    exportReadyNudgeSeenRef.current.add(nudgeKey);
    if (hasSeenExportReadyNudge(projectId, file.name)) return;
    markExportReadyNudgeSeen(projectId, file.name);
    setExportReadyNudge(true);
    const timeout = window.setTimeout(() => setExportReadyNudge(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [canShare, file.name, projectId]);

  // Opens the Download / Export menu — the
  // assistant "next step" card's Download row routes here so it surfaces the same
  // PDF / image / zip / standalone-HTML / template options the toolbar exposes.
  const consumedDownloadNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const nonce = downloadRequest?.nonce;
    if (nonce == null) return;
    if (consumedDownloadNonceRef.current === nonce) return;
    if (!canShare) return;
    consumedDownloadNonceRef.current = nonce;
    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setDownloadMenuOpen(true);
  }, [downloadRequest?.nonce, canShare, projectId, file.name]);

  // A queued chat send for this deck just started: flip the preview to the
  // slide its marked element lives on. We write the cached slide state first so
  // a freshly-mounted iframe (the tab may have just been activated) restores to
  // the target on load via syncCachedSlideStateToIframe(), then post directly
  // to cover the already-loaded iframe. The consume-once guard lives in
  // `shouldConsumeSlideNav` (keyed by file outside this component) so it holds
  // across remounts — switching away from and back to the deck must not replay
  // the stale request and yank the preview off wherever the user navigated.
  useEffect(() => {
    const nonce = slideNavRequest?.nonce;
    if (nonce == null) return;
    if (!effectiveDeck) return;
    const requested = slideNavRequest?.slideIndex;
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) return;
    if (!shouldConsumeSlideNav(previewStateKey, nonce)) return;
    const target = Math.floor(requested);
    const cachedCount = htmlPreviewSlideState.get(previewStateKey)?.count;
    const count = slideState?.count ?? cachedCount ?? target + 1;
    setSlideStateCached(previewStateKey, { active: target, count });
    setSlideState({ active: target, count });
    syncCachedSlideStateToIframe();
  }, [slideNavRequest?.nonce, slideNavRequest?.slideIndex, effectiveDeck, previewStateKey, slideState?.count]);

  const openDownloadMenu = () => {

    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setDownloadMenuOpen((v) => !v);
  };
  const captureExportImageSnapshot = useCallback(async (
    options?: { wholeDeck?: boolean },
  ) => {
    // The host compositor grabs on-screen pixels, so any transient hover chrome
    // over the preview leaks into the capture. The screenshot control's own
    // tooltip is already dismissed by TooltipLayer's pointerdown/click listener,
    // but that setState(null) has not repainted yet when capture starts. Wait
    // two frames so the dismissal commits first — mirrors the double-rAF guard
    // in the browser screenshot flow (DesignBrowserPanel).
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    // Prefer the daemon's off-screen render (desktop only): viewport-independent
    // and, rendering the artifact alone in a hidden window, it can never capture
    // MatOS's own UI. `wholeDeck` (Export as image) stitches every slide
    // top-to-bottom into one long image — matching the slide count the viewer
    // reports; otherwise (Copy screenshot, Mark/Draw capture) it grabs the
    // CURRENT slide, mirroring what's on screen. An ordinary page is its
    // full-page capture either way.
    if (isOpenDesignHostAvailable() && projectId && file.name) {
      // Deck-vs-page uses `deckExportSignal` — broader than the viewer's nav
      // signal — so runtime-managed decks (`<deck-stage>` / `data-screen-label`,
      // no literal `.slide`) export as a deck instead of a single page-mode shot
      // of slide 1. The vector-PDF fallback below uses the SAME signal, so an
      // artifact exports identically with or without a desktop host.
      const wholeDeck = options?.wholeDeck === true;
      // For a CURRENT-slide capture we need the active slide index, which only
      // exists when the viewer tracks it. Runtime-managed decks have no
      // active-slide bridge (slideState===null); for those the off-screen path
      // would always grab slide 0, so plan to skip it and fall through to the
      // visible host snapshot (= the slide on screen). Whole-deck / pages /
      // tracked `.slide` decks still render off-screen.
      const trackedActive = slideState?.active ?? htmlPreviewSlideState.get(previewStateKey)?.active ?? null;
      const plan = planDeckImageCapture({ deck: deckExportSignal, wholeDeck, trackedActive });
      if (plan.useOffscreen) {
        const rendered = await exportProjectImageDataUrl({
          projectId,
          fileName: file.name,
          deck: deckExportSignal,
          ...(plan.index != null ? { index: plan.index } : {}),
        });
        if (rendered.ok) return rendered.snapshot;
        // A semantic failure (e.g. "page is too tall — export as PDF") must surface,
        // NOT silently downgrade to a partial visible-viewport screenshot. Only when
        // the off-screen renderer is genuinely unavailable do we fall through.
        if ('error' in rendered) throw new Error(rendered.error);
      }
    }

    // Fallback: desktop compositor screenshot of the visible preview region.
    // Returns real rendered pixels and is never tainted, unlike the in-iframe
    // SVG-foreignObject bridge. Used on pure web (no host) or if the render
    // above is unavailable. Works for both srcDoc and URL-load previews.
    const visibleIframe = iframeRef.current ?? srcDocPreviewIframeRef.current;
    const hostSnapshot = await captureHostIframeSnapshot(visibleIframe);
    if (hostSnapshot) return hostSnapshot;

    if (!useUrlLoadPreview) {
      const activeIframe = srcDocPreviewIframeRef.current ?? iframeRef.current;
      if (!activeIframe) return null;
      await waitForIframeLoadOrTimeout(activeIframe, 250);
      await waitForAnimationFrame();
      return requestPreviewSnapshotWithRetry(activeIframe);
    }

    const urlIframe = iframeRef.current ?? urlPreviewIframeRef.current;
    if (urlIframe) {
      await waitForIframeLoadOrTimeout(urlIframe, 250);
      await waitForAnimationFrame();
      const urlSnapshot = await requestPreviewSnapshotWithRetry(urlIframe);
      if (urlSnapshot) return urlSnapshot;
    }

    const srcDocIframe = srcDocPreviewIframeRef.current;
    if (!srcDocIframe) {
      const activeIframe = iframeRef.current;
      if (!activeIframe) return null;
      return requestPreviewSnapshotWithRetry(activeIframe);
    }

    if (useLazySrcDocTransport && !srcDocShellReady) {
      await waitForIframeLoadOrTimeout(srcDocIframe, 500);
    }
    if (useLazySrcDocTransport && activateSrcDocSnapshotTransport(srcDocIframe)) {
      await waitForIframeLoadOrTimeout(srcDocIframe);
    }
    const restoreVisibility = temporarilyExposeIframeForSnapshot(srcDocIframe);
    try {
      await waitForAnimationFrame();
      return requestPreviewSnapshotWithRetry(srcDocIframe);
    } finally {
      restoreVisibility();
    }
  }, [
    activateSrcDocSnapshotTransport,
    srcDocShellReady,
    useLazySrcDocTransport,
    useUrlLoadPreview,
    deckExportSignal,
    slideState?.active,
    previewStateKey,
    projectId,
    file.name,
  ]);

  const handleCopyScreenshot = useCallback(async () => {

    if (screenshotInFlightRef.current) return;
    screenshotInFlightRef.current = true;
    setExportToast({ message: t('fileViewer.screenshotCopying'), tone: 'loading' });
    try {
      const snap = await captureExportImageSnapshot();
      if (!snap) {
        setExportToast({ message: t('fileViewer.screenshotPreviewLoading'), tone: 'error' });
        return;
      }
      const result = await copyImageDataUrlToClipboard(snap.dataUrl);
      setExportToast(
        result === 'copied'
          ? { message: t('fileViewer.screenshotCopied'), tone: 'success' }
          : {
              message: t(
                result === 'denied'
                  ? 'fileViewer.screenshotClipboardDenied'
                  : 'fileViewer.screenshotCaptureFailed',
              ),
              tone: 'error',
            },
      );
    } catch (err) {
      console.warn('[handleCopyScreenshot] failed:', err);
      // Surface a semantic failure message (e.g. "page is too tall — export as
      // PDF") rather than a generic one when the renderer gave us a reason.
      const message = err instanceof Error && err.message ? err.message : t('fileViewer.screenshotCaptureFailed');
      setExportToast({ message, tone: 'error' });
    } finally {
      screenshotInFlightRef.current = false;
    }
  }, [captureExportImageSnapshot, t]);

  const openImageExportModal = async () => {
    // Don't reopen while an export is still running.
    if (imageExportInFlightRef.current) return;
    flushSync(() => {
      setDownloadMenuOpen(false);
    });

    setImageExportError(null);
    imageExportSnapshotDataUrlRef.current = null;
    // Just open the modal. Rendering happens on Save, after the user picks a
    // format — not eagerly on open.
    setImageExportModalOpen(true);
  };

  const changeImageExportFormat = (format: ImageExportFormat) => {
    setImageExportFormat(format);
  };

  async function handleImageExportSave() {
    // Single-shot guard: closing the modal is async, so a fast double-click /
    // Enter-repeat on Save could otherwise enqueue two concurrent exports
    // (duplicate captures, downloads, and result bookkeeping) before the first
    // re-render removes the button.
    if (imageExportInFlightRef.current) return;
    imageExportInFlightRef.current = true;
    // Unify with the PPTX/PDF flow: close the modal and surface progress through
    // the same portaled, viewport-centered export toast instead of an in-modal
    // spinner + a separate (non-portaled, off-center) saved toast.
    setImageExportError(null);
    setImageExportModalOpen(false);
    setExportToast({ message: t('fileViewer.exportStarted'), tone: 'loading' });
    // Let the modal unmount before capturing so the web-only host-compositor
    // snapshot can't catch the overlay (the desktop off-screen renderer ignores
    // it either way).
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    try {
      let dataUrl = imageExportSnapshotDataUrlRef.current;
      if (!dataUrl) {
        // Export as image of a deck = the whole deck stitched into one long
        // image (every slide), matching the count the viewer reports. Copy
        // screenshot keeps the current slide.
        const snap = await captureExportImageSnapshot({ wholeDeck: true });
        if (!snap) {
          setExportToast({ message: t('fileViewer.exportImageFailed'), tone: 'error' });

          return;
        }
        dataUrl = snap.dataUrl;
        imageExportSnapshotDataUrlRef.current = dataUrl;
      }
      const blob = await imageDataUrlToBlob(dataUrl, imageExportFormat);
      if (blob.size <= 0) {
        setExportToast({ message: t('fileViewer.exportImageFailed'), tone: 'error' });

        return;
      }
      const target = await prepareImageExportTarget(exportTitle, imageExportFormat, { useNativePicker: false });
      if (!target) {
        // User dismissed the save picker — clear the loading toast.
        setExportToast(null);

        return;
      }
      if (target.method === 'download' && imageExportFormat === 'png' && dataUrl) {
        downloadImageDataUrl(dataUrl, target.filename);
      } else {
        await target.save(blob);
      }

      setExportToast({
        message:
          target.method === 'picker'
            ? t('fileViewer.exportImageSaved')
            : t('fileViewer.exportImageDownloadStarted'),
        tone: 'success',
      });
    } catch (err) {
      console.warn('[exportAsImage] failed to save snapshot:', err);
      const message = err instanceof Error && err.message ? err.message : t('fileViewer.exportImageFailed');
      setExportToast({ message, tone: 'error' });

    } finally {
      imageExportInFlightRef.current = false;
    }
  }
  const creationSortedSideComments = useMemo(
    () => previewComments
      .filter((comment) => comment.filePath === file.name && comment.status === 'open')
      .sort((a, b) => commentCreatedAt(a) - commentCreatedAt(b)),
    [file.name, previewComments],
  );
  useEffect(() => {
    const creationIds = creationSortedSideComments.map((comment) => comment.id);
    setCommentOrderIds((current) => {
      const visible = new Set(creationIds);
      const kept = current.filter((id) => visible.has(id));
      const added = creationIds.filter((id) => !kept.includes(id));
      const next = [...kept, ...added];
      return next.join('\0') === current.join('\0') ? current : next;
    });
  }, [creationSortedSideComments]);
  const visibleSideComments = useMemo(() => {
    if (commentOrderIds.length === 0) return creationSortedSideComments;
    const byId = new Map(creationSortedSideComments.map((comment) => [comment.id, comment]));
    const ordered = commentOrderIds
      .map((id) => byId.get(id))
      .filter((comment): comment is PreviewComment => Boolean(comment));
    const orderedIds = new Set(ordered.map((comment) => comment.id));
    const missing = creationSortedSideComments.filter((comment) => !orderedIds.has(comment.id));
    return [...ordered, ...missing];
  }, [creationSortedSideComments, commentOrderIds]);
  function rememberSavedPreviewCommentOrder(savedId: string) {
    setCommentOrderIds((current) =>
      appendSavedPreviewCommentOrder(current, visibleSideComments, savedId),
    );
  }
  const activeSideCommentId = activePreviewCommentId;
  const activeCommentTargetVisible = commentTargetIntersectsPreview(
    activeCommentTarget,
    overlayPreviewScale,
    { x: overlayPreviewTransform.offsetX, y: overlayPreviewTransform.offsetY },
    previewBodySize,
  );
  useEffect(() => {
    if (!boardMode || !activePreviewCommentId) return;
    const stillOpen = visibleSideComments.some((comment) => comment.id === activePreviewCommentId);
    if (!stillOpen) clearBoardComposer();
  }, [activePreviewCommentId, boardMode, visibleSideComments]);
  useEffect(() => {
    if (!effectiveDeck || slideState == null || !boardMode) return;
    if (!activePreviewCommentId) return;
    const activeComment = visibleSideComments.find((comment) => comment.id === activePreviewCommentId);
    if (activeComment && !commentVisibleOnDeckSlide(activeComment, slideState.active)) {
      clearBoardComposer();
    }
  }, [activePreviewCommentId, boardMode, effectiveDeck, slideState?.active, visibleSideComments]);
  const showPreviewToolbarControls = mode === 'preview';
  const versioningAvailable = isHtmlVersionableFile(file);
  const commentPreviewLayoutClass = [
    'comment-preview-layer',
    localCommentSideDockActive ? 'comment-preview-layer-with-side-dock' : '',
    localCommentSideDockActive && commentSidePanelCollapsed ? 'comment-preview-layer-dock-collapsed' : '',
    boardSideDockStacked ? 'comment-preview-layer-side-dock-stacked' : '',
  ].filter(Boolean).join(' ');
  // Edit mode opens clean: the inspector only appears once the user pins an
  // element (click its hover affordance / a container) or opens page styles by
  // clicking the empty canvas. No more full-height panel popping on toggle.
  const manualEditPageCardActive =
    manualEditMode && !selectedManualEditTarget && manualEditPageStylesOpen;
  const manualEditPanelActive =
    manualEditMode && (!!selectedManualEditTarget || manualEditPageCardActive);
  const manualEditResetAvailable = selectedManualEditTarget ? manualEditDraftDirty : false;
  const manualEditPanel = manualEditPanelActive ? (
    <ManualEditPanel
      targets={manualEditTargets}
      selectedTarget={selectedManualEditTarget}
      draft={manualEditDraft}
      history={manualEditHistory}
      error={manualEditError}
      canUndo={manualEditHistory.length > 0}
      canRedo={manualEditUndone.length > 0}
      busy={manualEditSaving}
      resetAvailable={manualEditResetAvailable}
      pageStylesEnabled={manualEditPageStylesEnabled}
      onSelectTarget={(target) => {
        void selectManualEditTarget(target);
      }}
      onDraftChange={(draft) => {
        setManualEditDraft(draft);
        setManualEditDraftDirty(Boolean(selectedManualEditTarget));
      }}
      onStyleChange={(id, styles, label) => {
        void handleManualEditStyleChange(id, styles, label);
      }}
      onInvalidStyle={cancelManualEditPendingStyles}
      onApplyPatch={(patch, label) => {
        void applyManualEdit(patch, label);
      }}
      onError={setManualEditError}
      onClearSelection={() => {
        void clearManualEditTargetSelection();
      }}
      onExit={() => {
        void dismissManualEditPanel();
      }}
      onCancelDraft={() => {
        void cancelManualEditPanel();
      }}
      onSaveDraft={() => {
        void saveManualEditPanelDraft();
      }}
      onResetDraft={() => {
        void resetManualEditPanelDraft();
      }}
      onUndo={() => {
        void undoManualEdit();
      }}
      onRedo={() => {
        void redoManualEdit();
      }}
      floatingClassName={manualEditPageCardActive ? 'manual-edit-page-card' : undefined}
      floatingStyle={selectedManualEditTarget
        ? {
            ...manualEditFloatingPanelStyle(
              selectedManualEditTarget,
              overlayPreviewScale,
              previewBodySize,
            ),
            ...(manualEditPanelPosition ?? {}),
          }
        : { top: 12, right: 12, width: 320 }}
      onFloatingPositionChange={selectedManualEditTarget ? setManualEditPanelPosition : undefined}
      onPickImage={async (pickedFile) => {
        const result = await uploadProjectFiles(projectId, [pickedFile]);
        const uploaded = result.uploaded[0];
        if (!uploaded?.path) {
          setManualEditError(result.error ?? t('manualEdit.uploadImageFailed'));
          return null;
        }
        setManualEditError(null);
        return toOwnerRelativePath(file.name, uploaded.path);
      }}
    />
  ) : null;
  const manualEditHoverAffordance =
    manualEditMode &&
    manualEditHoverTarget &&
    manualEditHoverTarget.id !== selectedManualEditTarget?.id ? (
      <button
        type="button"
        className="manual-edit-hover-action"
        data-testid="manual-edit-hover-open"
        aria-label={t('manualEdit.editParams')}
        title={t('manualEdit.editParams')}
        style={manualEditHoverIconStyle(
          manualEditHoverTarget,
          overlayPreviewScale,
          previewBodySize,
        )}
        onClick={() => {
          const target = manualEditHoverTarget;
          setManualEditHoverTarget(null);
          void selectManualEditTarget(target);
        }}
      >
        <Icon name="sliders" size={15} />
      </button>
    ) : null;
  const activeComposerComment = activePreviewCommentId
    ? visibleSideComments.find((comment) => comment.id === activePreviewCommentId) ?? null
    : null;
  const activeComposerAttachments =
    activeComposerComment?.attachments ?? activeCommentExistingAttachments;
  const commentComposer = boardMode && activeCommentTarget && activeCommentTargetVisible ? (
    <BoardComposerPopover
      target={activeCommentTarget}
      existing={activeComposerComment}
      draft={commentDraft}
      notes={queuedBoardNotes}
      onDraft={setCommentDraft}
      onAddDraft={queueCurrentDraft}
      onRemoveQueuedNote={(index) =>
        setQueuedBoardNotes((current) => current.filter((_, currentIndex) => currentIndex !== index))
      }
      onClose={clearBoardComposer}
      onSaveComment={() => { return savePersistentComment(); }}
      onSendBatch={() => { return sendBoardBatch(); }}
      images={boardImagePreviews}
      existingImages={
        activeComposerAttachments.map((attachment) => ({
          url: projectRawUrl(projectId, attachment.path),
          name: attachment.name,
        }))
      }
      onAttachImages={addBoardImages}
      onRemoveImage={removeBoardImage}
      onPreviewImage={setBoardPreviewIndex}
      onRemoveMember={(elementId) => {
        setActiveCommentTarget((current) => {
          const { next, shouldClose } = applyPodMemberRemoval(current, elementId);
          if (shouldClose) clearBoardComposer();
          return next;
        });
        setHoveredPodMemberId((current) => (current === elementId ? null : current));
      }}
      onHoverMember={setHoveredPodMemberId}
      onDeleteComment={onRemovePreviewComment ? async (commentId) => {
        await onRemovePreviewComment(commentId);
        clearBoardComposer();
        setSelectedSideCommentIds((current) => {
          if (!current.has(commentId)) return current;
          const next = new Set(current);
          next.delete(commentId);
          return next;
        });
        setActivePreviewCommentId((current) => (current === commentId ? null : current));
      } : undefined}
      sending={sendingBoardBatch}
      queueOnSend={commentQueueOnSend}
      sendDisabled={commentSendDisabled}
      t={t}
      scale={overlayPreviewScale}
      offset={{ x: overlayPreviewTransform.offsetX, y: overlayPreviewTransform.offsetY }}
      bounds={previewBodySize}
      docked={false}
      commenting
    />
  ) : null;
  const boardPreviewImage =
    boardPreviewIndex !== null ? boardImagePreviews[boardPreviewIndex] ?? null : null;
  const boardImagePreviewPortal = boardPreviewImage
    ? createPortal(
        <div
          className="staged-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={boardPreviewImage.file.name}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBoardPreviewIndex(null);
          }}
        >
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={boardPreviewImage.file.name}>{boardPreviewImage.file.name}</span>
              <button
                type="button"
                className="icon-only od-tooltip"
                onClick={() => setBoardPreviewIndex(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
                data-tooltip={t('common.close')}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <img src={boardPreviewImage.url} alt={boardPreviewImage.file.name} />
          </div>
        </div>,
        document.body,
      )
    : null;
  const commentSidePanel = commentPanelOpen ? (
    <CommentSideDock
      comments={visibleSideComments}
      projectId={projectId}
      selectedIds={selectedSideCommentIds}
      activeCommentId={activeSideCommentId}
      collapsed={commentPortalHost ? false : commentSidePanelCollapsed}
      onCollapsedChange={setCommentSidePanelCollapsed}
      onToggleSelect={(commentId) => {
        setSelectedSideCommentIds((current) => {
          const next = new Set(current);
          if (next.has(commentId)) next.delete(commentId);
          else next.add(commentId);
          return next;
        });
      }}
      onSelectAll={() => setSelectedSideCommentIds(new Set(visibleSideComments.map((comment) => comment.id)))}
      onClearSelection={() => setSelectedSideCommentIds(new Set())}
      onReorder={(orderedIds) => setCommentOrderIds(orderedIds)}
      onReply={(comment) => {
        // Reply == edit on a flat-thread model: prefill the
        // popover with the existing note so the user sees and
        // mutates the current text. Save runs through the
        // same upsert path; matching project/conv/file/element
        // updates note in place rather than creating a new row.
        const snapshot = liveSnapshotForComment(comment, liveCommentTargets) ?? {
          filePath: comment.filePath,
          elementId: comment.elementId,
          selector: comment.selector,
          label: comment.label,
          text: comment.text,
          position: comment.position,
          htmlHint: comment.htmlHint,
          style: comment.style,
          selectionKind: comment.selectionKind ?? 'element',
          memberCount: comment.memberCount,
          podMembers: comment.podMembers,
          ...(typeof comment.slideIndex === 'number' ? { slideIndex: comment.slideIndex } : {}),
        };
        setActiveCommentTarget(snapshot);
        setHoveredCommentTarget(snapshot);
        setActivePreviewCommentId(comment.id);
        setCommentDraft(comment.note);
        setQueuedBoardNotes([]);
        setActiveCommentExistingAttachments(comment.attachments ?? []);
        setBoardMode(true);
        setCommentCreateMode(true);
        setCommentPanelOpen(true);
        setCommentSidePanelCollapsed(false);
      }}
      onSendSelected={async () => {
        if (!onSendBoardCommentAttachments) return;
        const selected = visibleSideComments.filter(
          (comment) => selectedSideCommentIds.has(comment.id),
        );
        if (selected.length === 0) return;

        const sentIds = new Set(selected.map((comment) => comment.id));
        setSendingBoardBatch(true);
        try {
          const accepted = await onSendBoardCommentAttachments(commentsToAttachments(selected));
          if (accepted !== false) {
            setSelectedSideCommentIds(new Set());
            setCommentOrderIds((current) => current.filter((id) => !sentIds.has(id)));
            setActivePreviewCommentId((current) => current && sentIds.has(current) ? null : current);
          }
        } finally {
          setSendingBoardBatch(false);
        }
      }}
      onCreateComment={savePanelComment}
      sending={sendingBoardBatch}
      queueOnSend={commentQueueOnSend}
      sendDisabled={commentSendDisabled}
      renderCreateForm={!commentPortalHost}
      t={t}
      composer={null}
    />
  ) : null;

  return (
    <div className={`viewer html-viewer${inTabPresent ? ' is-tab-present' : ''}`}>
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <button
            type="button"
            className="icon-only od-tooltip"
            onClick={reloadHtmlPreview}
            title={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip-placement="bottom"
            aria-label={`${t('fileViewer.reloadAria')} ${t('fileViewer.preview')}`}
          >
            <Icon name="reload" size={14} />
          </button>
          <div className="viewer-tabs viewer-mode-tabs" role="tablist" aria-label="View mode">
            {([
              ['preview', t('fileViewer.preview'), 'eye-line'],
              ['source', t('fileViewer.source'), 'code-line'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={`viewer-tab od-tooltip ${mode === id ? 'active' : ''}`}
                aria-label={label}
                aria-selected={mode === id}
                title={label}
                data-tooltip={label}
                data-tooltip-placement="bottom"
                onClick={() => {

                  selectMode(id);
                }}
              >
                <RemixIcon name={id === 'preview' ? 'eye-line' : 'code-line'} size={14} className="viewer-tab-icon" />
                <span className="viewer-tab-label">{label}</span>
              </button>
            ))}
          </div>
          {versioningAvailable ? (
            <button
              type="button"
              className="viewer-action file-version-trigger od-tooltip"
              disabled={source === null}
              title={t('fileViewer.versions.title')}
              aria-label={t('fileViewer.versions.title')}
              data-tooltip={t('fileViewer.versions.title')}
              data-tooltip-placement="bottom"
              onClick={() => {

                setVersionModalOpen('toolbar');
              }}
            >
              <RemixIcon name="history-line" size={14} />
              <span>{t('fileViewer.versions.entry')}</span>
            </button>
          ) : null}
          {showPreviewToolbarControls ? (
            <span className="viewer-preview-toolbar-inline">
              <span className="viewer-divider" aria-hidden />
              <PreviewViewportControls
                viewport={previewViewport}
                onViewport={setPreviewViewport}
                t={t}
              />
            </span>
          ) : null}
          {showPreviewToolbarControls && showDeckNavigation ? (
            <span
              className="deck-nav viewer-deck-nav-inline"
              role="group"
              aria-label={t('fileViewer.slideNavAria')}
            >
              <button
                type="button"
                className="icon-only od-tooltip"
                onClick={() => postSlide('prev')}
                title={t('fileViewer.previousSlide')}
                data-tooltip={t('fileViewer.previousSlide')}
                data-tooltip-placement="bottom"
                aria-label={t('fileViewer.previousSlide')}
                disabled={slideState !== null && slideState.active <= 0}
              >
                <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="deck-nav-counter">
                {slideState
                  ? `${slideState.active + 1} / ${slideState.count}`
                  : '— / —'}
              </span>
              <button
                type="button"
                className="icon-only od-tooltip"
                onClick={() => postSlide('next')}
                title={t('fileViewer.nextSlide')}
                data-tooltip={t('fileViewer.nextSlide')}
                data-tooltip-placement="bottom"
                aria-label={t('fileViewer.nextSlide')}
                disabled={
                  slideState !== null &&
                  slideState.active >= slideState.count - 1
                }
              >
                <Icon name="chevron-right" size={14} />
              </button>
            </span>
          ) : null}
        </div>
        <div className="viewer-toolbar-actions">
          {showPreviewToolbarControls ? (
            <div className="viewer-toolbar-inline-actions">
              {mode === 'preview' ? (
                <button
                  type="button"
                  className="viewer-action viewer-action-icon od-tooltip"
                  data-testid="screenshot-copy-button"
                  data-tooltip={t('fileViewer.screenshot')}
                  data-tooltip-placement="bottom"
                  title={t('fileViewer.screenshot')}
                  aria-label={t('fileViewer.screenshot')}
                  onClick={handleCopyScreenshot}
                >
                  <RemixIcon name="screenshot-2-line" size={15} />
                </button>
              ) : null}
              <div className="artifact-tool-menu-anchor">
                <button
                  type="button"
                  className={`viewer-action viewer-action-icon viewer-comment-toggle od-tooltip${boardMode && !commentCreateMode && boardTool === 'inspect' ? ' active' : ''}`}
                  data-testid="board-mode-toggle"
                  data-tooltip={t('fileViewer.comment')}
                  data-tooltip-placement="bottom"
                  title={t('fileViewer.comment')}
                  aria-label={t('fileViewer.comment')}
                  aria-pressed={boardMode && !commentCreateMode && boardTool === 'inspect'}
                  onClick={activateCommentTool}
                >
                  <RemixIcon name="chat-new-line" size={15} />
                </button>
              </div>
              <button
                className={`viewer-action viewer-action-icon od-tooltip${drawOverlayOpen ? ' active' : ''}`}
                type="button"
                data-testid="draw-overlay-toggle"
                data-tooltip={t('fileViewer.mark')}
                data-tooltip-placement="bottom"
                title={t('fileViewer.mark')}
                aria-label={t('fileViewer.mark')}
                aria-pressed={drawOverlayOpen}
                onClick={activateDrawTool}
              >
                <RemixIcon name="mark-pen-line" size={15} />
              </button>
              <span className="viewer-toolbar-tool-divider" aria-hidden />
              <button
                className={`viewer-action viewer-action-icon od-tooltip${manualEditMode ? ' active' : ''}`}
                type="button"
                data-testid="manual-edit-mode-toggle"
                data-tooltip={t('fileViewer.edit')}
                data-tooltip-placement="bottom"
                title={t('fileViewer.edit')}
                aria-label={t('fileViewer.edit')}
                aria-pressed={manualEditMode}
                onClick={activateManualEditTool}
              >
                <RemixIcon name="edit-line" size={15} />
              </button>
              <span className="viewer-toolbar-tool-divider" aria-hidden />
              <button
                type="button"
                className={`viewer-action viewer-comment-count-trigger viewer-comment-toggle od-tooltip${boardMode && commentCreateMode ? ' active' : ''}`}
                data-testid="comment-panel-toggle"
                data-tooltip={t('chat.tabComments')}
                data-tooltip-placement="bottom"
                title={t('chat.tabComments')}
                aria-label={`${t('chat.tabComments')} (${visibleSideComments.length})`}
                aria-pressed={boardMode && commentCreateMode}
                onClick={activateCommentCreateTool}
              >
                <RemixIcon name="message-3-line" size={15} />
                <span className="viewer-comment-count" aria-hidden>{visibleSideComments.length}</span>
              </button>
              {source !== null && mode === 'preview' ? (
                <div className="zoom-menu viewer-toolbar-zoom" ref={zoomMenuRef}>
                  <button
                    type="button"
                    className="viewer-action zoom-trigger od-tooltip"
                    aria-haspopup="menu"
                    aria-expanded={zoomMenuOpen}
                    title={t('fileViewer.resetZoom')}
                    data-tooltip={t('fileViewer.resetZoom')}
                    data-tooltip-placement="bottom"
                    onClick={() => {

                      setZoomMenuOpen((v) => !v);
                    }}
                  >
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{zoom}%</span>
                  </button>
                  {zoomMenuOpen ? (
                    <div className="zoom-menu-popover" role="menu">
                      {[50, 75, 100, 125, 150, 200].map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`zoom-menu-item${zoom === level ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            setZoom(level);
                            setZoomMenuOpen(false);
                          }}
                        >
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{level}%</span>
                          {zoom === level ? (
                            <Icon name="check" size={13} />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="viewer-toolbar-more" ref={toolbarMoreRef}>
            <button
              type="button"
              className="viewer-action viewer-action-icon od-tooltip"
              aria-label={t('nextStep.more')}
              aria-haspopup="menu"
              aria-expanded={toolbarMoreOpen}
              data-tooltip={t('nextStep.more')}
              data-tooltip-placement="bottom"
              title={t('nextStep.more')}
              onClick={() => setToolbarMoreOpen((value) => !value)}
            >
              <RemixIcon name="more-2-line" size={16} />
            </button>
            {toolbarMoreOpen ? (
              <div className="viewer-toolbar-more-menu" role="menu">
                {([
                  ['preview', t('fileViewer.preview'), 'eye-line'],
                  ['source', t('fileViewer.source'), 'code-line'],
                ] as const).map(([id, label, icon]) => (
                  <button
                    key={id}
                    type="button"
                    className={`viewer-toolbar-more-item${mode === id ? ' active' : ''}`}
                    role="menuitem"
                    onClick={() => {

                      selectMode(id);
                      setToolbarMoreOpen(false);
                    }}
                  >
                    <RemixIcon name={icon} size={15} />
                    <span>{label}</span>
                    {mode === id ? <Icon name="check" size={13} /> : null}
                  </button>
                ))}
                {versioningAvailable ? (
                  <button
                    type="button"
                    className="viewer-toolbar-more-item"
                    role="menuitem"
                    disabled={source === null}
                    onClick={() => {

                      setVersionModalOpen('more_menu');
                      setToolbarMoreOpen(false);
                    }}
                  >
                    <RemixIcon name="history-line" size={15} />
                    <span>{t('fileViewer.versions.entry')}</span>
                  </button>
                ) : null}
                {showPreviewToolbarControls ? (
                  <>
                    <div className="viewer-toolbar-more-separator" role="separator" />
                    {PREVIEW_VIEWPORT_PRESETS.map((preset) => {
                      const selected = previewViewport === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`viewer-toolbar-more-item${selected ? ' active' : ''}`}
                          role="menuitem"
                          title={t(preset.titleKey)}
                          onClick={() => {
                            setPreviewViewport(preset.id);
                            setToolbarMoreOpen(false);
                          }}
                        >
                          <RemixIcon name={previewViewportIcon(preset.id)} size={15} />
                          <span>{t(preset.labelKey)}</span>
                          {selected ? <Icon name="check" size={13} /> : null}
                        </button>
                      );
                    })}
                    {showDeckNavigation ? (
                      <>
                        <div className="viewer-toolbar-more-separator" role="separator" />
                        <button
                          type="button"
                          className="viewer-toolbar-more-item"
                          role="menuitem"
                          disabled={slideState !== null && slideState.active <= 0}
                          onClick={() => {
                            postSlide('prev');
                            setToolbarMoreOpen(false);
                          }}
                        >
                          <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
                          <span>{t('fileViewer.previousSlide')}</span>
                        </button>
                        <button
                          type="button"
                          className="viewer-toolbar-more-item"
                          role="menuitem"
                          disabled={slideState !== null && slideState.active >= slideState.count - 1}
                          onClick={() => {
                            postSlide('next');
                            setToolbarMoreOpen(false);
                          }}
                        >
                          <Icon name="chevron-right" size={14} />
                          <span>{t('fileViewer.nextSlide')}</span>
                        </button>
                      </>
                    ) : null}
                    <div className="viewer-toolbar-more-separator" role="separator" />
                    {mode === 'preview' ? (
                      <button
                        type="button"
                        className="viewer-toolbar-more-item"
                        role="menuitem"
                        onClick={() => {
                          handleCopyScreenshot();
                          setToolbarMoreOpen(false);
                        }}
                      >
                        <RemixIcon name="screenshot-2-line" size={15} />
                        <span>{t('fileViewer.screenshot')}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`viewer-toolbar-more-item${boardMode && !commentCreateMode && boardTool === 'inspect' ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => {
                        activateCommentTool();
                        setToolbarMoreOpen(false);
                      }}
                    >
                      <RemixIcon name="chat-new-line" size={15} />
                      <span>{t('fileViewer.comment')}</span>
                    </button>
                    <button
                      type="button"
                      className={`viewer-toolbar-more-item${drawOverlayOpen ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => {
                        activateDrawTool();
                        setToolbarMoreOpen(false);
                      }}
                    >
                      <RemixIcon name="mark-pen-line" size={15} />
                      <span>{t('fileViewer.mark')}</span>
                    </button>
                    <button
                      type="button"
                      className={`viewer-toolbar-more-item${manualEditMode ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => {
                        activateManualEditTool();
                        setToolbarMoreOpen(false);
                      }}
                    >
                      <RemixIcon name="edit-line" size={15} />
                      <span>{t('fileViewer.edit')}</span>
                    </button>
                    <button
                      type="button"
                      className={`viewer-toolbar-more-item${boardMode && commentCreateMode ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => {
                        activateCommentCreateTool();
                        setToolbarMoreOpen(false);
                      }}
                    >
                      <RemixIcon name="message-3-line" size={15} />
                      <span>{t('chat.tabComments')} ({visibleSideComments.length})</span>
                    </button>
                    {source !== null && mode === 'preview' ? (
                      <>
                        <div className="viewer-toolbar-more-separator" role="separator" />
                        {[50, 75, 100, 125, 150, 200].map((level) => (
                          <button
                            key={level}
                            type="button"
                            className={`viewer-toolbar-more-item${zoom === level ? ' active' : ''}`}
                            role="menuitem"
                            onClick={() => {
                              setZoom(level);
                              setToolbarMoreOpen(false);
                            }}
                          >
                            <RemixIcon name="zoom-in-line" size={15} />
                            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{level}%</span>
                            {zoom === level ? <Icon name="check" size={13} /> : null}
                          </button>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {((filePrimaryActions: ReactNode) => (
        chromeActionsHost ? createPortal(filePrimaryActions, chromeActionsHost) : filePrimaryActions
      ))(<>
          {showPresent ? (
            <div className="present-wrap chrome-present-wrap">
              <button
                className="chrome-action chrome-action-secondary chrome-action-icon present-trigger od-tooltip"
                aria-haspopup="menu"
                aria-expanded={presentMenuOpen}
                aria-label={t('fileViewer.present')}
                data-tooltip={t('fileViewer.present')}
                data-tooltip-placement="bottom"
                title={t('fileViewer.present')}
                onClick={() => {

                  setPresentMenuOpen((v) => !v);
                }}
              >
                <RemixIcon name="slideshow-3-line" size={15} />
              </button>
              {presentMenuOpen ? (
                <div className="present-menu" role="menu">
                  <button role="menuitem" onClick={() => { presentInThisTab(); }}>
                    <span className="present-icon"><RemixIcon name="eye-line" size={14} /></span>{' '}
                    {t('fileViewer.presentInTab')}
                  </button>
                  <button role="menuitem" onClick={() => { presentFullscreen(); }}>
                    <span className="present-icon"><RemixIcon name="play-line" size={14} /></span>{' '}
                    {t('fileViewer.presentFullscreen')}
                  </button>
                  <button role="menuitem" onClick={() => { presentNewTab(); }}>
                    <span className="present-icon"><RemixIcon name="share-forward-line" size={14} /></span>{' '}
                    {t('fileViewer.presentNewTab')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {canShare || canDownload ? (
            <div className="chrome-file-action-menus" ref={shareRef}>
              {canDownload ? (
                <div className="share-menu chrome-share-menu">
                  <button
                    type="button"
                    className={
                      'chrome-action chrome-action-primary chrome-action-export' +
                      (exportReadyNudge ? ' export-ready-nudge' : '')
                    }
                    aria-haspopup="menu"
                    aria-expanded={downloadMenuOpen}
                    onClick={openDownloadMenu}
                  >
                    <span>{t('fileViewer.download')}</span>
                  </button>
                  {downloadMenuOpen ? (
                    <div className="share-menu-popover" role="menu">
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setDownloadMenuOpen(false);
                      // Pixel-perfect screenshot PDF (matches the preview, same
                      // renderer as image/PPTX). Chosen over Chromium's vector
                      // printToPDF because that path drops CJK glyphs in the
                      // packaged runtime (no embedded fonts) — unacceptable for a
                      // Chinese-first product. Falls back to the vector/browser
                      // print path on web or on failure.
                      fireShareExport('pdf', async () => {
                        if (isOpenDesignHostAvailable()) {
                          const res = await exportProjectScreenshotPdf({
                            projectId,
                            fileName: file.name,
                            title: exportTitle,
                            // Broader deck signal than the viewer's nav so
                            // runtime-managed decks (<deck-stage>) paginate per
                            // slide; the vector fallback below uses the SAME
                            // signal, so an artifact exports identically with or
                            // without a desktop host (no per-host divergence).
                            deck: deckExportSignal,
                          });
                          if (res.ok) return;
                          // A SEMANTIC failure (bad deck routing, unreadable
                          // renderer output, renderer 502, …) must surface — NOT
                          // silently downgrade to the vector PDF, which can
                          // reintroduce the CJK-glyph / fidelity bugs the
                          // screenshot path exists to avoid. Only a genuinely
                          // unavailable renderer (no host / 501 / transport)
                          // falls through to the vector path below.
                          if (!('unavailable' in res)) throw new Error(res.error);
                        }
                        await exportProjectAsPdf({
                          deck: deckExportSignal,
                          fallbackPdf: () => exportAsPdf(source ?? '', exportTitle, { deck: deckExportSignal, onProgress: onExportProgress }),
                          filePath: file.name,
                          projectId,
                          title: exportTitle,
                        });
                      });
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                    <span>{t('fileViewer.exportPdf')}</span>
                  </button>
                  {showPptxExport ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      disabled={!canPptx}
                      title={
                        streaming
                          ? t('fileViewer.exportPptxBusy')
                          : t('fileViewer.exportPptxHint')
                      }
                      onClick={() => {
                        setDownloadMenuOpen(false);
                        setPptxExportMode('editable');
                        setPptxExportModalOpen(true);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-ppt-line" size={15} /></span>
                      <span>{t('fileViewer.exportPptx')}</span>
                    </button>
                  ) : null}
                  {showImageExport ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={openImageExportModal}
                    >
                      <span className="share-menu-icon"><RemixIcon name="image-line" size={15} /></span>
                      <span>{t('fileViewer.exportImage')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setDownloadMenuOpen(false);
                      fireShareExport('html', () => exportProjectAsHtml({
                        projectId,
                        filePath: file.name,
                        fallbackHtml: source ?? '',
                        fallbackTitle: exportTitle,
                      }));
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-code-line" size={15} /></span>
                    <span>{t('fileViewer.exportHtml')}</span>
                  </button>
                  {showMarkdownExport ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setDownloadMenuOpen(false);
                        fireShareExport('markdown', () => exportAsMd(source ?? '', exportTitle));
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                      <span>{t('fileViewer.exportMd')}</span>
                    </button>
                  ) : null}
                  <div className="share-menu-divider" />
                  <div className="share-menu-section-label" role="presentation">
                    {t('fileViewer.shareMenuSave')}
                  </div>
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    disabled={savingTemplate}
                    onClick={() => {
                      openSaveAsTemplateModal();
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-copy-line" size={15} /></span>
                    <span>
                      {savingTemplate
                        ? t('fileViewer.savingTemplate')
                        : templateNote
                          ? templateNote
                          : t('fileViewer.saveAsTemplate')}
                    </span>
                  </button>
                </div>
                ) : null}
              </div>
              ) : null}
            </div>
          ) : null}
        </>)}
      <div className="viewer-body" ref={previewBodyRef}>
        {source === null && !sourceEverLoadedRef.current ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : mode === 'preview' ? (
          <div
            className={`${manualEditMode ? 'manual-edit-workspace' : commentPreviewLayoutClass} preview-viewport preview-viewport-${previewViewport}${drawOverlayOpen ? ' preview-draw-active' : ''}`}
            data-testid={manualEditMode ? undefined : 'comment-preview-layout'}
            style={previewViewportStyle(previewViewport, previewScale, boardPreviewCanvasSize, boardPreviewScaleOptions)}
            onMouseLeave={manualEditMode ? clearManualEditHover : undefined}
          >
            {manualEditPanel}
            {manualEditHoverAffordance}
            <div
              className={manualEditMode ? 'manual-edit-canvas' : 'comment-preview-canvas'}
              data-testid={manualEditMode ? undefined : 'comment-preview-canvas'}
            >
              <div className={manualEditMode ? undefined : 'comment-frame-clip'} style={manualEditMode ? { height: '100%' } : undefined}>
                <div
                  style={
                    manualEditMode
                      ? manualEditPreviewShellStyle(previewViewport, previewScale, manualEditViewportWidth)
                      : previewScaleShellStyle(previewViewport, previewScale)
                  }
                >
                  <PreviewDrawOverlay
                    active={drawOverlayOpen}
                    onActiveChange={setDrawOverlayOpen}
                    captureViewport
                    captureSnapshot={captureExportImageSnapshot}
                    captureTarget={null}
                    filePath={file.name}
                    sendDisabled={streaming}
                    sendDisabledReason={t('chat.annotationSendDisabledReason')}
                  >
                    <div className="artifact-preview-transport-stack">
                      {OD_PREVIEW_KEEP_ALIVE ? (
                        <PooledIframe
                          ref={urlPreviewIframeRef}
                          cacheKey={urlPreviewKeepAliveKey}
                          data-testid={useUrlLoadPreview ? 'artifact-preview-frame' : 'artifact-preview-frame-url-load'}
                          data-od-render-mode="url-load"
                          data-od-active={useUrlLoadPreview ? 'true' : 'false'}
                          aria-hidden={useUrlLoadPreview ? undefined : true}
                          tabIndex={useUrlLoadPreview ? 0 : -1}
                          title={file.name}
                          sandbox="allow-scripts allow-downloads"
                          src={urlTransportSrc}
                          onLoad={() => {
                            const frame = urlPreviewIframeRef.current;
                            if (useUrlLoadPreview) iframeRef.current = frame;
                            setUrlSelectionBridgeReady(false);
                            dcViewportRestoreAtRef.current = Date.now();
                            frame?.contentWindow?.postMessage({
                              type: '__dc_set_viewport',
                              ...dcViewportRef.current,
                            }, '*');
                            frame?.contentWindow?.postMessage({ type: 'od:url-selection-bridge-probe' }, '*');
                            syncBridgeModes(frame);
                            if (useUrlLoadPreview) restorePreviewScrollPosition();
                          }}
                        />
                      ) : (
                        <iframe
                          ref={urlPreviewIframeRef}
                          data-testid={useUrlLoadPreview ? 'artifact-preview-frame' : 'artifact-preview-frame-url-load'}
                          data-od-render-mode="url-load"
                          data-od-active={useUrlLoadPreview ? 'true' : 'false'}
                          aria-hidden={useUrlLoadPreview ? undefined : true}
                          tabIndex={useUrlLoadPreview ? 0 : -1}
                          title={file.name}
                          sandbox="allow-scripts allow-downloads"
                          src={urlTransportSrc}
                          onLoad={() => {
                            const frame = urlPreviewIframeRef.current;
                            if (useUrlLoadPreview) iframeRef.current = frame;
                            setUrlSelectionBridgeReady(false);
                            dcViewportRestoreAtRef.current = Date.now();
                            frame?.contentWindow?.postMessage({
                              type: '__dc_set_viewport',
                              ...dcViewportRef.current,
                            }, '*');
                            frame?.contentWindow?.postMessage({ type: 'od:url-selection-bridge-probe' }, '*');
                            syncBridgeModes(frame);
                            if (useUrlLoadPreview) restorePreviewScrollPosition();
                          }}
                        />
                      )}
                      <iframe
                        key={srcDocTransportResetKey}
                        ref={srcDocPreviewIframeRef}
                        data-testid={useUrlLoadPreview ? 'artifact-preview-frame-srcdoc' : 'artifact-preview-frame'}
                        data-od-render-mode="srcdoc"
                        data-od-active={useUrlLoadPreview ? 'false' : 'true'}
                        aria-hidden={useUrlLoadPreview ? true : undefined}
                        tabIndex={useUrlLoadPreview ? -1 : 0}
                        title={file.name}
                        sandbox="allow-scripts allow-downloads"
                        srcDoc={srcDocTransportContent}
                        onLoad={() => {
                          const frame = srcDocPreviewIframeRef.current;
                          if (!useUrlLoadPreview) iframeRef.current = frame;
                          // Reset the activation dedupe exactly ONCE per
                          // freshly mounted iframe DOM node, never on the
                          // subsequent load events that the same node
                          // emits during normal srcDoc rendering.
                          //
                          // The iframe's load event fires twice for one
                          // successful activation: once when the lazy
                          // transport shell HTML loads, and again when
                          // our own document.open/write/close inside the
                          // shell finishes. PR #2699 reset the dedupe on
                          // every load so that switching
                          // preview -> source -> preview (which remounts
                          // this iframe as a fresh DOM node) would
                          // re-activate the new shell. But resetting on
                          // every load also re-activated on the SECOND
                          // load of a non-remounted frame, which
                          // re-triggered document.open/write/close, which
                          // re-fired the load event, ad infinitum. The
                          // dedupe ref oscillated between null and the
                          // current srcDoc thousands of times per render
                          // and each iteration restarted every CSS
                          // animation from its `from` keyframe. Designs
                          // using `animation-fill-mode: both` with
                          // `from { opacity: 0 }` stayed at opacity 0
                          // forever and the preview read as blank.
                          // That is issue #2361.
                          //
                          // Tracking the last frame we reset for lets us
                          // keep PR #2699's "remount after Source toggle"
                          // fix while breaking the loop on plain renders.
                          if (frame && srcDocFrameDedupeResetForRef.current !== frame) {
                            srcDocFrameDedupeResetForRef.current = frame;
                            activatedSrcDocTransportHtmlRef.current = null;
                          }
                          if (useLazySrcDocTransport) setSrcDocShellReady(true);
                          activateLoadedSrcDocTransport(frame);
                          dcViewportRestoreAtRef.current = Date.now();
                          frame?.contentWindow?.postMessage({
                            type: '__dc_set_viewport',
                            ...dcViewportRef.current,
                          }, '*');
                          replayInspectOverridesToIframe(frame);
                          syncBridgeModes(frame);
                          syncCachedSlideStateToIframe(frame);
                          if (!useUrlLoadPreview) restorePreviewScrollPosition();
                        }}
                      />
                    </div>
                  </PreviewDrawOverlay>
                </div>
              </div>
              {boardMode ? (
                <CommentPreviewOverlays
                  comments={commentCreateMode ? visibleSideComments : []}
                  liveTargets={liveCommentTargets}
                  hoveredTarget={hoveredCommentTarget}
                  hoveredPodMemberId={hoveredPodMemberId}
                  activeTarget={activeCommentTarget}
                  activeExistingCommentId={activeComposerComment?.id ?? null}
                  boardTool={boardTool}
                  showActivePin={commentCreateMode}
                  scale={overlayPreviewScale}
                  offsetX={overlayPreviewTransform.offsetX}
                  offsetY={overlayPreviewTransform.offsetY}
                  strokePoints={strokePoints}
                  activeSlideIndex={effectiveDeck ? slideState?.active ?? null : null}
                  onOpenComment={(comment, snapshot) => {
                    setCommentPanelOpen(true);
                    setCommentSidePanelCollapsed(false);
                    setCommentCreateMode(true);
                    setBoardMode(true);
                    setActiveCommentTarget(snapshot);
                    setHoveredCommentTarget(snapshot);
                    setActivePreviewCommentId(comment.id);
                    setCommentDraft(comment.note);
                    setQueuedBoardNotes([]);
                    setActiveCommentExistingAttachments(comment.attachments ?? []);
                  }}
                />
              ) : null}
              {/* Portaled to <body> so the screenshot/export toast escapes the
                  preview pane's transform + overflow:hidden. */}
              {exportToast
                ? createPortal(
                    <Toast
                      message={exportToast.message}
                      tone={exportToast.tone}
                      role={exportToast.tone === 'error' ? 'alert' : 'status'}
                      ttlMs={exportToast.tone === 'loading' ? 60000 : 2200}
                      placement="top"
                      onDismiss={() => setExportToast(null)}
                    />,
                    document.body,
                  )
                : null}
              {commentSavedToast ? (
                <div className="comment-toast-anchor">
                  <Toast
                    message={commentSavedToast}
                    ttlMs={2200}
                    onDismiss={() => setCommentSavedToast(null)}
                  />
                </div>
              ) : null}
              {templateSavedToast ? (
                <div className="comment-toast-anchor">
                  <Toast
                    message={templateSavedToast}
                    ttlMs={2200}
                    onDismiss={() => setTemplateSavedToast(null)}
                  />
                </div>
              ) : null}
              {commentComposer}
              {boardMode && !commentCreateMode && hoveredCommentTarget && (!activeCommentTarget || commentPortalHost) ? (
                <AnnotationHoverPopover
                  target={hoveredCommentTarget}
                  scale={overlayPreviewScale}
                  bounds={previewBodySize}
                  offset={{ x: overlayPreviewTransform.offsetX, y: overlayPreviewTransform.offsetY }}
                  onMouseEnter={() => {
                    hoverCardPinnedRef.current = true;
                    cancelHoverCardDismiss();
                  }}
                  onMouseLeave={() => {
                    hoverCardPinnedRef.current = false;
                    scheduleHoverCardDismiss();
                  }}
                />
              ) : null}
              {/*
                Hint banner for Inspect / Picker modes. The bridge in
                `apps/web/src/runtime/srcdoc.ts` posts `od:comment-targets`
                with every element annotated with `data-od-id` /
                `data-screen-label`, so `liveCommentTargets.size` is the
                authoritative annotation count for the current artifact.

                Two states:
                - "has targets": the existing copy ("Click any element with
                  `data-od-id` to tune its style.") for users who just don't
                  see the crosshair cursor.
                - "no targets" (issue #890): a freeform-generated artifact
                  (e.g. PRD → HTML through a Claude-Code-compatible CLI
                  without a skill) ships zero `data-od-id` annotations. The
                  bridge's click handler walks up to <html>, finds nothing,
                  and bails — clicks no-op silently. The static copy made
                  this look broken; the empty-state copy explains what's
                  missing and how to fix it. Mirrored across Inspect and
                  element-pick annotation mode because the failure surface is identical.
              */}
              {inspectMode
                && openHintBox
                && !activeInspectTarget
                && !activeCommentTarget ? (
                <div
                  className="inspect-empty-hint-container"
                  data-testid="inspect-empty-hint-container"
                >
                  {liveCommentTargets.size === 0 ? (
                    <div
                      className="inspect-empty-hint"
                      data-testid="inspect-empty-hint-no-targets"
                    >
                      {inspectMode
                        ? t('chat.inspect.noEditableTargets')
                        : t('chat.inspect.noCommentTargets')}
                    </div>
                  ) : (
                    <div
                      className="inspect-empty-hint"
                      data-testid="inspect-empty-hint"
                    >
                      {inspectMode ? t('chat.inspect.editHint') : t('chat.inspect.commentHint')}
                    </div>
                  )}
                  <button
                    type="button"
                    title="Close Inspect Hint"
                    aria-label="Close Inspect Hint"
                    onClick={() => setOpenHintBox(false)}
                    className="orbit-artifact-ghost"
                  >
                    <Icon className="" name="close" size={12} />
                  </button>
                </div>
              ) : null}
            </div>
            {boardImagePreviewPortal}
            {commentPortalHost && commentSidePanel
              ? createPortal(commentSidePanel, commentPortalHost)
              : commentPortalId
                ? null
                : commentSidePanel}
            {inspectMode && activeInspectTarget ? (
              <InspectPanel
                target={activeInspectTarget}
                onApply={(prop, value) => {
                  const target = activeInspectTarget;
                  setInspectOverrides((current) =>
                    updateInspectOverride(current, target.elementId, target.selector, prop, value),
                  );
                  postInspectSet(target.elementId, target.selector, prop, value);
                }}
                onResetElement={(elementId) => {
                  setInspectOverrides((current) => {
                    if (!(elementId in current)) return current;
                    const next = { ...current };
                    delete next[elementId];
                    return next;
                  });
                  postInspectReset(elementId);
                  setActiveInspectTarget((current) => current && current.elementId === elementId
                    ? current
                    : current);
                }}
                onSaveToSource={() => {
                  void saveInspectToSource();
                }}
                onClose={() => {
                  setActiveInspectTarget(null);
                  if (boardMode && boardTool === 'inspect') {
                    setActiveCommentTarget(null);
                    setHoveredCommentTarget(null);
                  }
                }}
                saving={savingInspect}
                savedAt={inspectSavedAt}
                error={inspectError}
              />
            ) : null}
          </div>
        ) : (
          <pre className="viewer-source">{source}</pre>
        )}
      </div>
      {inTabPresent && source && typeof document !== 'undefined' ? createPortal(
        <div
          className="present-overlay"
          role="dialog"
          aria-label={t('fileViewer.exitPresentation')}
        >
          <button
            className="present-exit"
            onClick={() => setInTabPresent(false)}
            aria-label={t('fileViewer.exitPresentation')}
          >
            <Icon name="close" size={13} /> {t('fileViewer.exitPresentation')}
          </button>
          {useUrlLoadPreview ? (
            <iframe
              title="present"
              sandbox="allow-scripts allow-downloads"
              data-od-render-mode="url-load"
              src={activePreviewSrcUrl}
            />
          ) : (
            <iframe
              title="present"
              sandbox="allow-scripts allow-downloads"
              data-od-render-mode="srcdoc"
              srcDoc={srcDoc}
            />
          )}
        </div>,
        document.body,
      ) : null}
      {versionModalOpen && versioningAvailable && typeof document !== 'undefined' ? (
        <FileVersionManagerModal
          projectId={projectId}
          file={file}
          currentSource={source}
          onClose={() => setVersionModalOpen(false)}
          onRestored={handleVersionRestored}
        />
      ) : null}
      {pptxExportModalOpen && typeof document !== 'undefined' ? createPortal(
        <div className="modal-backdrop viewer-modal-backdrop image-export-backdrop" role="presentation">
          <div
            className="modal deploy-modal image-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={pptxExportTitleId}
          >
            <div className="modal-head">
              <div className="kicker">PPTX</div>
              <h2 id={pptxExportTitleId}>{t('fileViewer.exportPptx')}</h2>
              <p className="subtitle">{t('fileViewer.exportPptxModalSubtitle')}</p>
            </div>
            <div className="deploy-form image-export-form">
              <fieldset className="image-export-format-field">
                <legend>{t('fileViewer.exportImageFormatLabel')}</legend>
                <div className="pptx-export-mode-options">
                  {([
                    {
                      value: 'editable' as const,
                      title: t('fileViewer.exportPptxEditable'),
                      hint: t('fileViewer.exportPptxEditableHint'),
                      recommended: true,
                    },
                    {
                      value: 'screenshot' as const,
                      title: t('fileViewer.exportPptxScreenshot'),
                      hint: t('fileViewer.exportPptxScreenshotHint'),
                      recommended: false,
                    },
                  ]).map((opt) => (
                    <label
                      key={opt.value}
                      className={`pptx-export-mode-option${pptxExportMode === opt.value ? ' active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="pptx-export-mode"
                        value={opt.value}
                        checked={pptxExportMode === opt.value}
                        onChange={() => setPptxExportMode(opt.value)}
                      />
                      <span className="pptx-export-mode-head">
                        <span className="pptx-export-mode-title">{opt.title}</span>
                        {opt.recommended ? (
                          <span className="pptx-export-mode-badge">{t('fileViewer.exportPptxRecommended')}</span>
                        ) : null}
                      </span>
                      <span className="pptx-export-mode-desc">{opt.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                onClick={() => setPptxExportModalOpen(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={!canPptx}
                onClick={() => {
                  const editable = pptxExportMode === 'editable';
                  setPptxExportModalOpen(false);
                  fireShareExport('pptx', async () => {
                    const res = await exportProjectAsPptx({
                      projectId,
                      fileName: file.name,
                      title: exportTitle,
                      deck: true,
                      editable,
                    });
                    if (!res.ok) throw new Error('error' in res ? res.error : t('fileViewer.exportPptxNa'));
                  });
                }}
              >
                {t('fileViewer.exportPptxConfirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {imageExportModalOpen && typeof document !== 'undefined' ? createPortal(
        <div
          className="modal-backdrop viewer-modal-backdrop image-export-backdrop"
          role="presentation"
        >
          <div
            className="modal deploy-modal image-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={imageExportTitleId}
          >
            <div className="modal-head">
              <div className="kicker">IMAGE</div>
              <h2 id={imageExportTitleId}>{t('fileViewer.exportImage')}</h2>
              <p className="subtitle">{t('fileViewer.exportImageModalSubtitle')}</p>
            </div>
            <div className="deploy-form image-export-form">
              <fieldset className="image-export-format-field">
                <legend>{t('fileViewer.exportImageFormatLabel')}</legend>
                <div className="image-export-format-options">
                  {IMAGE_EXPORT_FORMAT_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`image-export-format-option${imageExportFormat === option.value ? ' active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="image-export-format"
                        value={option.value}
                        aria-label={option.label}
                        checked={imageExportFormat === option.value}
                        onChange={() => changeImageExportFormat(option.value)}
                      />
                      <span className="image-export-format-text">
                        <strong>{option.label}</strong>
                        <span aria-hidden="true">{option.extension}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {imageExportError ? (
                <p className="deploy-error" role="alert">{imageExportError}</p>
              ) : null}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                onClick={() => {
                  // User dismissed the image export modal without saving —
                  // close the ui_click(image)→result funnel as cancelled.

                  setImageExportModalOpen(false);
                  setImageExportError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                onClick={() => {
                  void handleImageExportSave();
                }}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {templateModalOpen && typeof document !== 'undefined' ? createPortal(
        <div className="modal-backdrop viewer-modal-backdrop" role="presentation">
          <div className="modal deploy-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="kicker">TEMPLATE</div>
              <h2>{t('fileViewer.saveAsTemplate')}</h2>
              <p className="subtitle">{t('fileViewer.templateDescPrompt')}</p>
            </div>
            <div className="deploy-form">
              <label className="field" htmlFor={templateNameId}>
                <span className="field-label">{t('fileViewer.templateNamePrompt')}</span>
                <input
                  id={templateNameId}
                  type="text"
                  value={templateName}
                  placeholder={t('fileViewer.templateNameDefault')}
                  autoFocus
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </label>
              <label className="field" htmlFor={templateDescriptionId}>
                <span className="field-label">{t('fileViewer.templateDescPrompt')}</span>
                <textarea
                  id={templateDescriptionId}
                  rows={3}
                  value={templateDescription}
                  placeholder={t('fileViewer.optional')}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                />
              </label>
              {templateSaveError ? <p className="deploy-error">{templateSaveError}</p> : null}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                disabled={savingTemplate}
                onClick={() => {
                  // Dismissed without saving — close the ui_click(template)→
                  // result funnel as cancelled.

                  setTemplateModalOpen(false);
                  setTemplateSaveError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={savingTemplate || !templateName.trim()}
                onClick={() => {
                  void handleSaveAsTemplate();
                }}
              >
                {savingTemplate ? t('fileViewer.savingTemplate') : t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {versionRestoredToast && typeof document !== 'undefined' ? createPortal(
        <Toast
          key={versionRestoredToast.id}
          message={versionRestoredToast.message}
          tone="success"
          placement="top"
          ttlMs={2400}
          onDismiss={() => setVersionRestoredToast(null)}
        />,
        document.body,
      ) : null}
    </div>
  );
}

function baseDirFor(fileName: string): string {
  const idx = fileName.lastIndexOf('/');
  return idx >= 0 ? fileName.slice(0, idx + 1) : '';
}

function toOwnerRelativePath(ownerFileName: string, targetPath: string): string {
  const normalize = (value: string) => decodeURIComponent(value).replace(/^\/+/, '');
  const squash = (parts: string[]) => {
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (out.length > 0) out.pop();
        continue;
      }
      out.push(part);
    }
    return out;
  };
  const ownerDirPath = normalize(baseDirFor(ownerFileName));
  const targetFilePath = normalize(targetPath);
  const ownerParts = squash(ownerDirPath.split('/'));
  const targetParts = squash(targetFilePath.split('/'));

  let common = 0;
  while (
    common < ownerParts.length &&
    common < targetParts.length &&
    ownerParts[common] === targetParts[common]
  ) {
    common += 1;
  }

  const up = new Array(ownerParts.length - common).fill('..');
  const down = targetParts.slice(common);
  const rel = [...up, ...down].join('/');
  return rel || '.';
}

function isBlockedPreviewAssetScheme(assetRef: string): boolean {
  const clean = assetRef.replace(/[\s\u0000-\u001F\u007F-\u009F]/g, '');
  return /^(?:javascript|data):/i.test(clean);
}

function hasRelativeAssetRefs(html: string): boolean {
  const attr = /\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(html)) !== null) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/)/i.test(value)) continue;
    return true;
  }
  return false;
}

async function inlineRelativeAssets(
  html: string,
  projectId: string,
  fileName: string,
): Promise<string> {
  const replacements: Array<Promise<{ from: string; to: string } | null>> = [];
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    const rel = readHtmlAttr(tag, 'rel');
    const href = readHtmlAttr(tag, 'href');
    if (!rel || !/\bstylesheet\b/i.test(rel) || !href) continue;
    replacements.push(
      fetchProjectRelativeText(projectId, fileName, href).then((css) =>
        css == null
          ? null
          : {
              from: tag,
              to:
                `<style data-od-inline-asset="${escapeHtmlAttr(href)}">\n` +
                `${css.replace(/<\/style/gi, '<\\/style')}\n</style>`,
            },
      ),
    );
  }

  const scripts = html.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi) ?? [];
  for (const tag of scripts) {
    const src = readHtmlAttr(tag, 'src');
    if (!src) continue;
    replacements.push(
      fetchProjectRelativeText(projectId, fileName, src).then((js) => {
        if (js == null) return null;
        const open = tag.match(/^<script\b[^>]*>/i)?.[0] ?? '<script>';
        const attrs = open
          .replace(/^<script/i, '')
          .replace(/>$/i, '')
          .replace(/\ssrc\s*=\s*(['"])[\s\S]*?\1/i, '');
        return {
          from: tag,
          to: `<script${attrs}>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`,
        };
      }),
    );
  }

  const resolved = (await Promise.all(replacements)).filter(
    (item): item is { from: string; to: string } => item !== null,
  );
  return resolved.reduce((next, { from, to }) => next.replace(from, () => to), html);
}

async function fetchProjectRelativeText(
  projectId: string,
  ownerFileName: string,
  assetRef: string,
): Promise<string | null> {
  const filePath = resolveProjectRelativePath(ownerFileName, assetRef);
  if (!filePath) return null;
  try {
    const resp = await fetch(projectRawUrl(projectId, filePath));
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function resolveProjectRelativePath(ownerFileName: string, assetRef: string): string | null {
  if (isBlockedPreviewAssetScheme(assetRef)) return null;
  if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/)/i.test(assetRef)) return null;
  try {
    const url = new URL(assetRef, `https://od.local/${baseDirFor(ownerFileName)}`);
    if (url.origin !== 'https://od.local') return null;
    const decodedPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const parts = decodedPath.split(/[/\\]/);
    if (parts.some((part) => part === '..' || part.trim() === '..')) return null;
    return decodedPath;
  } catch {
    return null;
  }
}

function readHtmlAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] ?? null;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ImageViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  return (
    <div className="viewer image-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.imageMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <div className="viewer-toolbar-actions">
          <a
            className="ghost-link"
            href={projectDownloadUrl(projectId, file.name)}
            download={file.name}
          >
            {t('fileViewer.download')}
          </a>
          <a
            className="ghost-link"
            href={projectFileUrl(projectId, file.name)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('fileViewer.open')}
          </a>
        </div>
      </div>
      <div className="viewer-body image-body">
        <img alt={file.name} src={url} />
      </div>
    </div>
  );
}

function VideoViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  return (
    <div className="viewer video-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.videoMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body video-body">
        <video src={url} controls playsInline preload="metadata" />
      </div>
    </div>
  );
}

function AudioViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  return (
    <div className="viewer audio-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.audioMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body audio-body">
        <div className="audio-card">
          <Icon name="mic" size={28} />
          <div className="audio-card-name">{file.name}</div>
          <audio src={url} controls preload="metadata" />
        </div>
      </div>
    </div>
  );
}

type SvgViewerMode = 'preview' | 'source';

interface SvgViewerProps {
  projectId: string;
  file: ProjectFile;
  initialMode?: SvgViewerMode;
  initialSource?: string | null | undefined;
}

export function SvgViewer({
  projectId,
  file,
  initialMode = 'preview',
  initialSource,
}: SvgViewerProps) {
  const t = useT();
  const [mode, setMode] = useState<SvgViewerMode>(initialMode);
  const [source, setSource] = useState<string | null>(initialSource ?? null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceError, setSourceError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}&r=${reloadKey}`;

  useEffect(() => {
    if (mode !== 'source') return;
    if (initialSource !== undefined && reloadKey === 0) return;
    let cancelled = false;
    setLoadingSource(true);
    setSourceError(false);
    void fetchProjectFileText(projectId, file.name, {
      cache: 'no-store',
      cacheBustKey: `${Math.round(file.mtime)}-${reloadKey}`,
    }).then((next) => {
      if (cancelled) return;
      if (next === null) {
        setSource('');
        setSourceError(true);
      } else {
        setSource(next);
      }
      setLoadingSource(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, initialSource, mode, reloadKey]);

  return (
    <div className="viewer svg-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.imageMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <div className="viewer-toolbar-actions">
          <div className="viewer-tabs">
            <button
              type="button"
              className={`viewer-tab ${mode === 'preview' ? 'active' : ''}`}
              aria-pressed={mode === 'preview'}
              onClick={() => setMode('preview')}
            >
              {t('fileViewer.preview')}
            </button>
            <button
              type="button"
              className={`viewer-tab ${mode === 'source' ? 'active' : ''}`}
              aria-pressed={mode === 'source'}
              onClick={() => setMode('source')}
            >
              {t('fileViewer.source')}
            </button>
          </div>
          <span className="viewer-divider" aria-hidden />
          <button
            type="button"
            className="viewer-action"
            onClick={() => setReloadKey((n) => n + 1)}
            title={t('fileViewer.reloadDisk')}
          >
            <Icon name="reload" size={13} />
            <span>{t('fileViewer.reload')}</span>
          </button>
          <a
            className="ghost-link"
            href={projectDownloadUrl(projectId, file.name)}
            download={file.name}
          >
            {t('fileViewer.download')}
          </a>
          <a
            className="ghost-link"
            href={projectFileUrl(projectId, file.name)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('fileViewer.open')}
          </a>
        </div>
      </div>
      <div className={`viewer-body ${mode === 'preview' ? 'image-body' : ''}`}>
        {mode === 'preview' ? (
          <img alt={file.name} src={url} />
        ) : loadingSource ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : sourceError ? (
          <div className="viewer-empty">{t('fileViewer.previewUnavailable')}</div>
        ) : (
          <pre className="viewer-source">{source ?? ''}</pre>
        )}
      </div>
    </div>
  );
}

/**
 * Structure/trajectory files: MatterViz 3D visualization by default, with a
 * toggle into the plain text editor for the text-based formats (binary
 * trajectory containers like .traj/.h5 stay visualization-only).
 */
function StructureFileViewer({
  projectId,
  file,
  viewKind,
}: {
  projectId: string;
  file: ProjectFile;
  viewKind: StructureViewKind;
}) {
  const t = useT();
  const [mode, setMode] = useState<'viz' | 'text'>('viz');
  const textAvailable = structureFileHasTextMode(file.name);
  useEffect(() => {
    setMode('viz');
  }, [projectId, file.name]);
  return (
    <div className="structure-viewer" data-testid="structure-viewer">
      <div className="structure-viewer__bar">
        <span className="structure-viewer__label">
          {viewKind === 'trajectory'
            ? t('structureViewer.kindTrajectory')
            : t('structureViewer.kindStructure')}
        </span>
        {textAvailable ? (
          <div className="structure-viewer__modes" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'viz'}
              className={`structure-viewer__mode${mode === 'viz' ? ' is-active' : ''}`}
              onClick={() => setMode('viz')}
              data-testid="structure-viewer-viz"
            >
              {t('structureViewer.modeViz')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'text'}
              className={`structure-viewer__mode${mode === 'text' ? ' is-active' : ''}`}
              onClick={() => setMode('text')}
              data-testid="structure-viewer-text"
            >
              {t('structureViewer.modeText')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="structure-viewer__body">
        {mode === 'viz' ? (
          <MatterVizPane projectId={projectId} file={file} viewKind={viewKind} />
        ) : (
          <TextViewer projectId={projectId} file={file} />
        )}
      </div>
    </div>
  );
}

function TextViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  // MatOS: text/markdown project files are editable in place — asset-editing
  // projects keep the draft (KNOWLEDGE.md / SKILL.md / ...) as the live
  // artifact, so the user can hand-edit what the agent wrote. External
  // changes (agent writes) still flow through the mtime-driven reload; an
  // open editing session is not clobbered because the draft state is local.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setText(null);
    setEditing(false);
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((t) => {
      if (!cancelled) setText(t ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, reloadKey]);
  // Agent writes bump mtime: refresh the read view without dropping an
  // in-progress manual edit.
  useEffect(() => {
    if (editing) return;
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((t) => {
      if (!cancelled && t != null) setText(t);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.mtime]);

  async function saveDraft() {
    setSaving(true);
    try {
      await writeProjectTextFile(projectId, file.name, draft);
      setText(draft);
      setEditing(false);
    } catch {
      // Keep the editor open so the draft is not lost.
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (text == null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  const displayText = useMemo(
    () => (text == null ? null : formatJsonFileTextForDisplay(file, text)),
    [file.name, file.mime, text],
  );
  const lineCount = displayText ? displayText.split('\n').length : 0;

  return (
    <div className="viewer text-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left" />
        <div className="viewer-toolbar-actions">
          <button
            type="button"
            className="viewer-action"
            onClick={() => setReloadKey((n) => n + 1)}
            title={t('fileViewer.reloadDisk')}
          >
            <Icon name="reload" size={13} />
            <span>{t('fileViewer.reload')}</span>
          </button>
          {editing ? (
            <>
              <button
                type="button"
                className="viewer-action"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                <Icon name="close" size={13} />
                <span>{t('repoImport.cancel')}</span>
              </button>
              <button
                type="button"
                className="viewer-action viewer-action--primary"
                onClick={() => void saveDraft()}
                disabled={saving}
                data-testid="text-viewer-save"
              >
                <Icon name={saving ? 'spinner' : 'check'} size={13} />
                <span>{t('fileViewer.save')}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="viewer-action"
              onClick={() => {
                setDraft(text ?? '');
                setEditing(true);
              }}
              disabled={text === null}
              data-testid="text-viewer-edit"
            >
              <Icon name="edit" size={13} />
              <span>{t('fileViewer.edit')}</span>
            </button>
          )}
          <button
            type="button"
            className="viewer-action"
            onClick={() => void copy()}
            title={t('fileViewer.copyTitle')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            <span>{copied ? t('fileViewer.copied') : t('fileViewer.copy')}</span>
          </button>
        </div>
      </div>
      <div className="viewer-body">
        {text === null ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : editing ? (
          <CodeEditor
            key={`${projectId}:${file.name}`}
            initialValue={draft}
            fileName={file.name}
            onChange={setDraft}
            onSave={() => void saveDraft()}
            testId="text-viewer-editor"
          />
        ) : displayText !== null && lineCount > 0 ? (
          <CodeWithLines text={displayText} />
        ) : (
          <pre className="viewer-source">{displayText}</pre>
        )}
      </div>
    </div>
  );
}

function formatJsonFileTextForDisplay(file: ProjectFile, text: string): string {
  if (!isJsonFile(file)) return text;
  try {
    if (hasPrecisionSensitiveJsonNumberText(text)) return text;
    const parsed = JSON.parse(text) as unknown;
    if (hasUnsafeJsonNumber(parsed)) return text;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function hasPrecisionSensitiveJsonNumberText(text: string): boolean {
  let inString = false;
  let escaped = false;
  const numberTokenPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      i += 1;
      continue;
    }

    numberTokenPattern.lastIndex = i;
    const match = numberTokenPattern.exec(text);
    if (!match) {
      i += 1;
      continue;
    }

    const token = match[0];
    if (isSignedNegativeZeroJsonNumberToken(token)) return true;
    if (/[.eE]/.test(token) && isPrecisionSensitiveJsonNumberToken(token)) return true;
    i = numberTokenPattern.lastIndex;
  }
  return false;
}

function isSignedNegativeZeroJsonNumberToken(token: string): boolean {
  return /^-0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(token);
}

function isPrecisionSensitiveJsonNumberToken(token: string): boolean {
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return true;
  const rendered = JSON.stringify(parsed);
  if (!rendered) return true;
  const originalValue = parseJsonNumberTokenAsDecimal(token);
  const renderedValue = parseJsonNumberTokenAsDecimal(rendered);
  return (
    !originalValue ||
    !renderedValue ||
    originalValue.coefficient !== renderedValue.coefficient ||
    originalValue.exponent !== renderedValue.exponent
  );
}

function parseJsonNumberTokenAsDecimal(token: string): { coefficient: bigint; exponent: number } | null {
  const match = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return null;
  const [, sign, integerPart, fractionPart = '', exponentPart = '0'] = match;
  const coefficient = BigInt(`${sign ?? ''}${integerPart}${fractionPart}`);
  const exponent = Number(exponentPart) - fractionPart.length;
  return normalizeDecimalParts(coefficient, exponent);
}

function normalizeDecimalParts(coefficient: bigint, exponent: number): { coefficient: bigint; exponent: number } {
  if (coefficient === 0n) return { coefficient: 0n, exponent: 0 };
  let normalizedCoefficient = coefficient;
  let normalizedExponent = exponent;
  while (normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedExponent += 1;
  }
  return { coefficient: normalizedCoefficient, exponent: normalizedExponent };
}

function hasUnsafeJsonNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
  }
  if (Array.isArray(value)) return value.some(hasUnsafeJsonNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasUnsafeJsonNumber);
  return false;
}

function isJsonFile(file: ProjectFile): boolean {
  return file.name.toLowerCase().endsWith('.json') || file.mime.toLowerCase().startsWith('application/json');
}

type MarkdownViewerMode = 'edit' | 'split' | 'preview';
type MarkdownSaveState = 'idle' | 'saving' | 'saved' | 'error';
type MarkdownScrollPane = 'editor' | 'preview';
type MarkdownSaveOptions = {
  refreshFiles?: boolean;
  showSaving?: boolean;
};

function markdownScrollRange(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function markdownScrollRatio(element: HTMLElement): number {
  const range = markdownScrollRange(element);
  return range > 0 ? element.scrollTop / range : 0;
}

function markdownScrollTopForRatio(element: HTMLElement, ratio: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return markdownScrollRange(element) * clamped;
}

function mergeMarkdownSaveOptions(a: MarkdownSaveOptions, b: MarkdownSaveOptions): MarkdownSaveOptions {
  return {
    refreshFiles: a.refreshFiles !== false || b.refreshFiles !== false,
    showSaving: a.showSaving !== false || b.showSaving !== false,
  };
}

function MarkdownViewer({
  projectId,
  file,
  onFileSaved,
}: {
  projectId: string;
  file: ProjectFile;
  onFileSaved?: () => Promise<void> | void;
}) {
  const { t, locale } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<MarkdownViewerMode>('split');
  const [saveState, setSaveState] = useState<MarkdownSaveState>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<{ source: string; html: string; themeRevision: number } | null>(null);
  const [highlightThemeRevision, setHighlightThemeRevision] = useState(0);
  const [, bumpSavedRevision] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const markdownPreviewPaneRef = useRef<HTMLElement | null>(null);
  const markdownArticleRef = useRef<HTMLElement | null>(null);
  const copyBlockTimerRef = useRef<number | null>(null);
  const copiedMarkdownBlockRef = useRef<HTMLElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const programmaticScrollClearFrameRef = useRef<number | null>(null);
  const pendingScrollSyncRef = useRef<{ sourcePane: MarkdownScrollPane; targetPane: MarkdownScrollPane } | null>(null);
  const programmaticScrollRef = useRef<{ pane: MarkdownScrollPane; top: number } | null>(null);
  const activeMarkdownScrollPaneRef = useRef<MarkdownScrollPane>('editor');
  const editorBlockOffsetsRef = useRef<{ width: number; offsets: number[] } | null>(null);
  const previousModeRef = useRef<MarkdownViewerMode>('split');
  const saveInFlightRef = useRef(false);
  const pendingSaveAfterFlightRef = useRef<MarkdownSaveOptions | null>(null);
  const textRef = useRef('');
  const lastSavedTextRef = useRef<string | null>(null);
  const loadedFileKeyRef = useRef<string | null>(null);
  const markdownFileKey = `${projectId}::${file.name}`;
  const status = file.artifactManifest?.status ?? 'complete';
  const isStreaming = status === 'streaming';
  const isError = status === 'error';
  const exportTitle = file.name.replace(/\.mdx?$/i, '') || file.name;

  useEffect(() => {
    const sameLoadedFile = loadedFileKeyRef.current === markdownFileKey;
    if (
      sameLoadedFile &&
      lastSavedTextRef.current !== null &&
      textRef.current !== lastSavedTextRef.current
    ) {
      return undefined;
    }
    if (!sameLoadedFile) setText(null);
    copiedMarkdownBlockRef.current = null;
    if (copyBlockTimerRef.current) {
      window.clearTimeout(copyBlockTimerRef.current);
      copyBlockTimerRef.current = null;
    }
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((next) => {
      if (cancelled) return;
      if (
        loadedFileKeyRef.current === markdownFileKey &&
        lastSavedTextRef.current !== null &&
        textRef.current !== lastSavedTextRef.current
      ) {
        return;
      }
      const loaded = next ?? '';
      if (
        sameLoadedFile &&
        lastSavedTextRef.current !== null &&
        textRef.current === lastSavedTextRef.current &&
        loaded === lastSavedTextRef.current
      ) {
        loadedFileKeyRef.current = markdownFileKey;
        pendingSaveAfterFlightRef.current = null;
        setSaveState((current) => current === 'saved' ? current : 'idle');
        return;
      }
      textRef.current = loaded;
      lastSavedTextRef.current = loaded;
      loadedFileKeyRef.current = markdownFileKey;
      pendingSaveAfterFlightRef.current = null;
      setSaveState('idle');
      setText(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, markdownFileKey]);

  useEffect(() => {
    return () => {
      copiedMarkdownBlockRef.current = null;
      if (copyBlockTimerRef.current) {
        window.clearTimeout(copyBlockTimerRef.current);
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (scrollSyncFrameRef.current) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
        scrollSyncFrameRef.current = null;
      }
      if (programmaticScrollClearFrameRef.current) {
        window.cancelAnimationFrame(programmaticScrollClearFrameRef.current);
        programmaticScrollClearFrameRef.current = null;
      }
      pendingScrollSyncRef.current = null;
      programmaticScrollRef.current = null;
      activeMarkdownScrollPaneRef.current = 'editor';
    };
  }, []);

  const saveMarkdownText = useCallback(
    (value: string, options: MarkdownSaveOptions = {}) => {
      const run = async (nextValue: string, saveOptions: MarkdownSaveOptions): Promise<void> => {
        if (lastSavedTextRef.current === nextValue) {
          const showSaving = saveOptions.showSaving !== false;
          if (textRef.current === nextValue) setSaveState(showSaving ? 'saved' : 'idle');
          if (saveOptions.refreshFiles !== false && onFileSaved) {
            void Promise.resolve(onFileSaved()).catch(() => undefined);
          }
          return;
        }
        if (saveInFlightRef.current) {
          pendingSaveAfterFlightRef.current = pendingSaveAfterFlightRef.current
            ? mergeMarkdownSaveOptions(pendingSaveAfterFlightRef.current, saveOptions)
            : saveOptions;
          return;
        }
        saveInFlightRef.current = true;
        const showSaving = saveOptions.showSaving !== false;
        if (showSaving) setSaveState('saving');
        try {
          const saved = await writeProjectTextFile(projectId, file.name, nextValue);
          if (!saved) throw new Error('write failed');
          lastSavedTextRef.current = nextValue;
          bumpSavedRevision((n) => n + 1);
          setSavedAt(Date.now());
          if (textRef.current === nextValue) setSaveState(showSaving ? 'saved' : 'idle');
          if (saveOptions.refreshFiles !== false && onFileSaved) {
            void Promise.resolve(onFileSaved()).catch(() => undefined);
          }
        } catch {
          if (textRef.current === nextValue) setSaveState('error');
        } finally {
          saveInFlightRef.current = false;
          const pending = pendingSaveAfterFlightRef.current;
          if (pending) {
            pendingSaveAfterFlightRef.current = null;
            const latest = textRef.current;
            if (latest !== lastSavedTextRef.current) {
              void run(latest, pending);
            } else {
              const showPendingSaving = pending.showSaving !== false;
              if (textRef.current === latest) setSaveState(showPendingSaving ? 'saved' : 'idle');
              if (pending.refreshFiles !== false && onFileSaved) {
                void Promise.resolve(onFileSaved()).catch(() => undefined);
              }
            }
          }
        }
      };
      void run(value, options);
    },
    [file.name, onFileSaved, projectId],
  );

  const flushPendingMarkdownSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const latest = textRef.current;
    if (lastSavedTextRef.current !== null && latest !== lastSavedTextRef.current) {
      saveMarkdownText(latest, { refreshFiles: false, showSaving: false });
    }
  }, [saveMarkdownText]);

  useEffect(() => {
    return () => {
      flushPendingMarkdownSave();
    };
  }, [flushPendingMarkdownSave]);

  useEffect(() => {
    if (text === null) return undefined;
    textRef.current = text;
    if (text === lastSavedTextRef.current) return undefined;
    setSaveState((current) => current === 'saved' ? 'idle' : current);
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveMarkdownText(textRef.current, { refreshFiles: false, showSaving: false });
    }, 700);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [saveMarkdownText, text]);

  useEffect(() => {
    const root = document.documentElement;
    const bump = () => setHighlightThemeRevision((revision) => revision + 1);
    const observer = new MutationObserver(bump);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', bump);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', bump);
    };
  }, []);

  async function copy() {
    if (text == null) return;
    const didCopy = await copyTextToClipboard(text);
    if (didCopy) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  const insertTextAtSelection = useCallback((insert: string) => {
    setText((current) => {
      if (current === null) return current;
      const editor = editorRef.current;
      if (!editor) return `${current}${insert}`;
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const next = `${current.slice(0, start)}${insert}${current.slice(end)}`;
      window.requestAnimationFrame(() => {
        const nextCursor = start + insert.length;
        editor.focus();
        editor.setSelectionRange(nextCursor, nextCursor);
      });
      return next;
    });
  }, []);

  const insertImageFiles = useCallback(
    async (files: File[]): Promise<boolean> => {
      const images = files.filter((item) => isMarkdownImageFile(item));
      if (images.length === 0) return false;
      const targetDir = markdownDirectory(file.name);
      const result = await uploadProjectFiles(projectId, images, targetDir);
      if (result.uploaded.length > 0) {
        await onFileSaved?.();
        const snippet = result.uploaded
          .map((item) => {
            const alt = markdownImageAlt(item.name);
            const path = markdownRelativeProjectPath(file.name, item.path);
            return `![${alt}](${path})`;
          })
          .join('\n');
        insertTextAtSelection(`\n${snippet}\n`);
      }
      return true;
    },
    [file.name, insertTextAtSelection, onFileSaved, projectId],
  );

  function handleEditorPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (!files.some(isMarkdownImageFile)) return;
    event.preventDefault();
    void insertImageFiles(files);
  }

  function handleEditorDrop(event: ReactDragEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.some(isMarkdownImageFile)) return;
    event.preventDefault();
    void insertImageFiles(files);
  }

  // The markdown doc auto-saves on a debounce, so the toolbar shows a passive
  // status (when it last auto-saved) instead of a manual Save button that is
  // disabled almost all the time. Typing stays quiet: the indicator keeps the
  // last auto-saved time and only refreshes once the debounced save lands, so
  // there is no per-keystroke "Saving…" flicker. `saving` is reserved for an
  // explicit, foreground write (the error-retry path).
  const autoSaveStatus: 'error' | 'saving' | 'saved' | 'idle' =
    saveState === 'error'
      ? 'error'
      : saveState === 'saving'
        ? 'saving'
        : savedAt != null
          ? 'saved'
          : 'idle';
  const autoSaveTime =
    savedAt != null
      ? new Date(savedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : null;
  const autoSaveLabel =
    autoSaveStatus === 'error'
      ? t('fileViewer.markdownSaveFailed')
      : autoSaveStatus === 'saving'
        ? t('fileViewer.markdownSaving')
        : autoSaveStatus === 'saved' && autoSaveTime
          ? t('fileViewer.markdownAutoSaved', { time: autoSaveTime })
          : t('fileViewer.markdownAutoSaveHint');
  const showEditor = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  const baseHtml = useMemo(() => {
    if (text === null) return null;
    const renderPartial = MarkdownRenderer.renderPartial ?? renderMarkdownToSafeHtml;
    return rewriteMarkdownImageSources(decorateMarkdownCodeBlocks(renderPartial(text)), projectId, file.name);
  }, [file.name, projectId, text]);
  const html = highlightedHtml?.source === baseHtml && highlightedHtml.themeRevision === highlightThemeRevision
    ? highlightedHtml.html
    : baseHtml;
  const markdownBlockLines = useMemo(() => extractMarkdownBlockLines(text ?? ''), [text]);

  // The cached editor block offsets become stale whenever the source text
  // changes (line positions move) — drop them so the next sync remeasures.
  useEffect(() => {
    editorBlockOffsetsRef.current = null;
  }, [text]);

  useEffect(() => {
    if (!baseHtml) {
      setHighlightedHtml(null);
      return undefined;
    }
    let cancelled = false;
    highlightMarkdownCodeBlocks(baseHtml).then((nextHtml) => {
      if (cancelled) return;
      setHighlightedHtml(nextHtml === baseHtml ? null : { source: baseHtml, html: nextHtml, themeRevision: highlightThemeRevision });
    }).catch(() => {
      if (!cancelled) setHighlightedHtml(null);
    });
    return () => {
      cancelled = true;
    };
  }, [baseHtml, highlightThemeRevision]);

  const clearProgrammaticScrollSoon = useCallback(() => {
    if (programmaticScrollClearFrameRef.current) {
      window.cancelAnimationFrame(programmaticScrollClearFrameRef.current);
    }
    programmaticScrollClearFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollClearFrameRef.current = window.requestAnimationFrame(() => {
        programmaticScrollRef.current = null;
        programmaticScrollClearFrameRef.current = null;
      });
    });
  }, []);

  const getEditorBlockOffsets = useCallback((): number[] | null => {
    const editor = editorRef.current;
    if (!editor || markdownBlockLines.length === 0) return null;
    const width = editor.clientWidth;
    const cached = editorBlockOffsetsRef.current;
    if (cached && cached.width === width && cached.offsets.length === markdownBlockLines.length) {
      return cached.offsets;
    }
    const offsets = measureEditorBlockOffsets(editor, markdownBlockLines, textRef.current);
    if (!offsets) return null;
    editorBlockOffsetsRef.current = { width, offsets };
    return offsets;
  }, [markdownBlockLines]);

  // Align the panes by matching each top-level markdown block's source line to
  // its rendered element, then interpolating scroll position between those
  // anchors. Falls back to proportional (ratio) sync when block anchors are
  // unavailable (e.g. raw-HTML blocks change the rendered child count).
  const computeMarkdownSyncTarget = useCallback(
    (sourcePane: MarkdownScrollPane, source: HTMLElement, target: HTMLElement): number => {
      const previewPane = markdownPreviewPaneRef.current;
      if (markdownBlockLines.length > 0 && previewPane) {
        const editorOffsets = getEditorBlockOffsets();
        const previewOffsets = editorOffsets
          ? measurePreviewBlockOffsets(previewPane, markdownBlockLines.length)
          : null;
        if (editorOffsets && previewOffsets) {
          const isEditorSource = sourcePane === 'editor';
          const sourceOffsets = isEditorSource ? editorOffsets : previewOffsets;
          const targetOffsets = isEditorSource ? previewOffsets : editorOffsets;
          const sourceAnchors = buildScrollAnchors(sourceOffsets, source.scrollHeight);
          const targetAnchors = buildScrollAnchors(targetOffsets, target.scrollHeight);
          const mapped = mapScrollPosition(source.scrollTop, sourceAnchors, targetAnchors);
          return Math.max(0, Math.min(markdownScrollRange(target), mapped));
        }
      }
      return markdownScrollTopForRatio(target, markdownScrollRatio(source));
    },
    [getEditorBlockOffsets, markdownBlockLines],
  );

  const applyMarkdownScrollSync = useCallback(
    (sourcePane: MarkdownScrollPane, targetPane: MarkdownScrollPane) => {
      const source = sourcePane === 'editor' ? editorRef.current : markdownPreviewPaneRef.current;
      const target = targetPane === 'editor' ? editorRef.current : markdownPreviewPaneRef.current;
      if (mode !== 'split' || !source || !target) return;
      const targetTop = computeMarkdownSyncTarget(sourcePane, source, target);
      if (Math.abs(target.scrollTop - targetTop) < 1) return;
      programmaticScrollRef.current = { pane: targetPane, top: targetTop };
      target.scrollTop = targetTop;
      clearProgrammaticScrollSoon();
    },
    [clearProgrammaticScrollSoon, computeMarkdownSyncTarget, mode],
  );

  const scheduleMarkdownScrollSync = useCallback(
    (sourcePane: MarkdownScrollPane, targetPane: MarkdownScrollPane) => {
      if (mode !== 'split') {
        pendingScrollSyncRef.current = null;
        return;
      }
      pendingScrollSyncRef.current = { sourcePane, targetPane };
      if (scrollSyncFrameRef.current !== null) return;
      scrollSyncFrameRef.current = window.requestAnimationFrame(() => {
        scrollSyncFrameRef.current = null;
        const pending = pendingScrollSyncRef.current;
        pendingScrollSyncRef.current = null;
        if (!pending) return;
        applyMarkdownScrollSync(pending.sourcePane, pending.targetPane);
      });
    },
    [applyMarkdownScrollSync, mode],
  );

  const shouldIgnoreMarkdownScroll = useCallback((pane: MarkdownScrollPane, element: HTMLElement): boolean => {
    const programmatic = programmaticScrollRef.current;
    if (programmatic?.pane !== pane) return false;
    if (Math.abs(element.scrollTop - programmatic.top) > 1 && activeMarkdownScrollPaneRef.current === pane) {
      return false;
    }
    programmaticScrollRef.current = null;
    return true;
  }, []);

  const handleMarkdownEditorScroll = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || shouldIgnoreMarkdownScroll('editor', editor)) return;
    activeMarkdownScrollPaneRef.current = 'editor';
    scheduleMarkdownScrollSync('editor', 'preview');
  }, [scheduleMarkdownScrollSync, shouldIgnoreMarkdownScroll]);

  const handleMarkdownPreviewScroll = useCallback(() => {
    const previewPane = markdownPreviewPaneRef.current;
    if (!previewPane || shouldIgnoreMarkdownScroll('preview', previewPane)) return;
    if (activeMarkdownScrollPaneRef.current !== 'preview') return;
    scheduleMarkdownScrollSync('preview', 'editor');
  }, [scheduleMarkdownScrollSync, shouldIgnoreMarkdownScroll]);

  const activateMarkdownScrollPane = useCallback((pane: MarkdownScrollPane) => {
    activeMarkdownScrollPaneRef.current = pane;
  }, []);

  useEffect(() => {
    const article = markdownArticleRef.current;
    if (!article) return;
    ensureMarkdownCodeBlockControls(article, t);
    if (copiedMarkdownBlockRef.current?.isConnected) {
      setMarkdownCodeBlockCopiedState(copiedMarkdownBlockRef.current, true, t);
    }
  }, [html, t]);

  useEffect(() => {
    if (mode !== 'split') {
      if (scrollSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollSyncFrameRef.current);
        scrollSyncFrameRef.current = null;
      }
      if (programmaticScrollClearFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollClearFrameRef.current);
        programmaticScrollClearFrameRef.current = null;
      }
      pendingScrollSyncRef.current = null;
      programmaticScrollRef.current = null;
      activeMarkdownScrollPaneRef.current = 'editor';
      previousModeRef.current = mode;
      return;
    }
    const sourcePane = activeMarkdownScrollPaneRef.current ?? (previousModeRef.current === 'preview' ? 'preview' : 'editor');
    const targetPane = sourcePane === 'preview' ? 'editor' : 'preview';
    scheduleMarkdownScrollSync(sourcePane, targetPane);
    previousModeRef.current = mode;
  }, [html, mode, scheduleMarkdownScrollSync]);

  async function handleMarkdownBodyClick(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(`button[${MARKDOWN_COPY_BLOCK_ATTR}]`);
    if (!button) return;
    const block = button.closest('.markdown-code-block');
    if (!(block instanceof HTMLElement)) return;
    const pre = block.querySelector('pre');
    if (!pre) return;
    const didCopy = await copyTextToClipboard((pre.textContent ?? '').replace(/\n$/, ''));
    if (!didCopy) return;
    if (copiedMarkdownBlockRef.current && copiedMarkdownBlockRef.current !== block) {
      setMarkdownCodeBlockCopiedState(copiedMarkdownBlockRef.current, false, t);
    }
    copiedMarkdownBlockRef.current = block;
    setMarkdownCodeBlockCopiedState(block, true, t);
    if (copyBlockTimerRef.current) {
      window.clearTimeout(copyBlockTimerRef.current);
    }
    copyBlockTimerRef.current = window.setTimeout(() => {
      if (copiedMarkdownBlockRef.current) {
        setMarkdownCodeBlockCopiedState(copiedMarkdownBlockRef.current, false, t);
      }
      copiedMarkdownBlockRef.current = null;
      copyBlockTimerRef.current = null;
    }, 1800);
  }

  return (
    <div className="viewer text-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          {isStreaming ? <span className="viewer-meta">{t('fileViewer.markdownStreamingMeta')}</span> : null}
          {isError ? <span className="viewer-meta">{t('fileViewer.markdownErrorMeta')}</span> : null}
          <div className="viewer-tabs markdown-mode-tabs" role="tablist" aria-label={t('fileViewer.markdownViewMode')}>
            {(['edit', 'split', 'preview'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                className={`viewer-tab ${mode === item ? 'active' : ''}`}
                onClick={() => setMode(item)}
              >
                {item === 'edit'
                  ? t('fileViewer.source')
                  : item === 'split'
                    ? t('fileViewer.split')
                    : t('fileViewer.preview')}
              </button>
            ))}
          </div>
        </div>
        <div className="viewer-toolbar-actions">
          {autoSaveStatus === 'error' ? (
            <button
              type="button"
              className="viewer-action markdown-autosave markdown-autosave-error"
              onClick={() => {
                if (text !== null) saveMarkdownText(text);
              }}
              title={t('fileViewer.save')}
            >
              <Icon name="alert-triangle" size={13} />
              <span>{autoSaveLabel}</span>
            </button>
          ) : (
            <span
              className={`viewer-meta markdown-autosave markdown-autosave-${autoSaveStatus}`}
            >
              {autoSaveStatus === 'saving' ? (
                <Icon name="spinner" size={13} className="icon-spin" />
              ) : autoSaveStatus === 'saved' ? (
                <Icon name="check" size={13} />
              ) : null}
              <span>{autoSaveLabel}</span>
            </span>
          )}
          <button
            type="button"
            className="viewer-action"
            onClick={() => void copy()}
            title={t('fileViewer.copyTitle')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            <span>{copied ? t('fileViewer.copied') : t('fileViewer.copy')}</span>
          </button>
          {text !== null ? (
            <MarkdownExportMenu markdown={text} title={exportTitle} projectId={projectId} fileName={file.name} disabled={isStreaming} />
          ) : null}
        </div>
      </div>
      <div className={`viewer-body markdown-workbench markdown-workbench-${mode}`}>
        {text === null || html === null ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : (
          <>
            {showEditor ? (
              <section className="markdown-editor-pane" aria-label={t('fileViewer.markdownEditor')}>
                <textarea
                  ref={editorRef}
                  className="markdown-editor"
                  value={text}
                  aria-label={t('fileViewer.markdownEditor')}
                  placeholder={t('fileViewer.markdownEditorPlaceholder')}
                  spellCheck
                  autoFocus
                  onFocus={() => activateMarkdownScrollPane('editor')}
                  onChange={(event) => {
                    activateMarkdownScrollPane('editor');
                    setText(event.currentTarget.value);
                  }}
                  onScroll={handleMarkdownEditorScroll}
                  onPaste={handleEditorPaste}
                  onDrop={handleEditorDrop}
                />
              </section>
            ) : null}
            {showPreview ? (
              <div className="markdown-preview-pane-wrap">
                <section
                  ref={markdownPreviewPaneRef}
                  className="markdown-preview-pane"
                  aria-label={t('fileViewer.markdownPreview')}
                  onPointerDown={() => activateMarkdownScrollPane('preview')}
                  onWheel={() => activateMarkdownScrollPane('preview')}
                  onTouchStart={() => activateMarkdownScrollPane('preview')}
                  onKeyDown={() => activateMarkdownScrollPane('preview')}
                  onFocus={() => activateMarkdownScrollPane('preview')}
                  onScroll={handleMarkdownPreviewScroll}
                >
                  {isStreaming ? <div className="markdown-status">{t('fileViewer.markdownStreamingStatus')}</div> : null}
                  {isError ? <div className="markdown-status markdown-status-error">{t('fileViewer.markdownErrorStatus')}</div> : null}
                  {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML and rejects unsafe link protocols. */}
                  <article
                    ref={markdownArticleRef}
                    className="markdown-rendered"
                    onClick={(event) => void handleMarkdownBodyClick(event)}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </section>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function isMarkdownImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
}

function markdownImageAlt(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'image';
}

function CodeWithLines({ text }: { text: string }) {
  const lines = text.split('\n');
  // Trailing newline produces a phantom empty line — keep gutter aligned.
  const gutter = lines.map((_, i) => `${i + 1}`).join('\n');
  return (
    <pre className="code-viewer">
      <code className="gutter" aria-hidden>
        {gutter}
      </code>
      <code className="lines">{text}</code>
    </pre>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function documentMetaLabel(file: ProjectFile, t: TranslateFn): string {
  if (file.kind === 'document') return t('fileViewer.documentMeta');
  if (file.kind === 'presentation') return t('fileViewer.presentationMeta');
  if (file.kind === 'spreadsheet') return t('fileViewer.spreadsheetMeta');
  return t('fileViewer.binaryMeta', { size: humanSize(file.size) });
}
