import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@open-design/components';
import paginationStyles from './DesignFilesPagination.module.css';
import type { ProjectFilePaging } from '../runtime/use-project-file-pages';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { projectDownloadUrl, projectFileUrl, projectRawUrl } from '../providers/registry';
import { buildSrcdoc } from '../runtime/srcdoc';
import type { ProjectFile, ProjectFileKind, ProjectFolder } from '../types';
import {
  createFileSystemReadError,
  FILE_SYSTEM_READ_ERROR_MESSAGE,
  isFileSystemReadError,
} from '../utils/fileSystemErrors';
import { isVisualStabilityMode } from '../utils/visualStability';
import { selectInitialDesignPreviewFile } from './design-files/designArtifacts';
import { Icon } from './Icon';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;
const FILE_ROWS_PER_PAGE = 200;

/**
 * The panel's navigation memory, owned by the parent (and persisted per
 * project) because the panel unmounts whenever the user switches workspace
 * tabs. Restoring it keeps the user's place when they jump back.
 */
export interface DesignFilesNavState {
  /** List-view folder being browsed ('' = project root). */
  currentDir: string;
  /** Tree-view directory paths currently expanded. */
  expandedDirs: string[];
  /** Last row selected for preview (project-relative file name). */
  preview: string | null;
}

interface Props {
  projectId: string;
  // Basename of the project's working directory when the user has chosen a
  // real folder (e.g. "openclaw"). Shown as the breadcrumb root instead of
  // the generic "project" label. Undefined for default-storage projects.
  rootDirName?: string;
  // True while the host is reindexing a freshly replaced working dir. Drives
  // a loading overlay so the panel doesn't sit silently on the stale tree.
  reloading?: boolean;
  // True while the chat agent is generating. The footer swaps its idle
  // drop/upload hint for the typewriter "tip" line while a run is in flight.
  running?: boolean;
  files: ProjectFile[];
  filePaging?: ProjectFilePaging;
  // Persisted folders from `/api/projects/:id/folders`, including empty ones
  // that no file lives under. Without these, a folder only appears once a file
  // with a matching path prefix exists, so empty (user-created or imported)
  // folders would vanish from the tree.
  folders?: ProjectFolder[];
  onRefreshFiles: () => Promise<void> | void;
  onOpenFile: (name: string) => void;
  onRenameFile: (from: string, to: string) => Promise<ProjectFile | null> | ProjectFile | null;
  onDeleteFile: (name: string) => void;
  onDeleteFiles: (names: string[]) => Promise<void> | void;
  /** Create an empty text file at the given project-relative path (tree
   *  view's VSCode-style "New file"). Returns the created file. */
  onCreateFile?: (path: string) => Promise<ProjectFile | null> | ProjectFile | null;
  /** Create a folder at the given project-relative path. True on success. */
  onCreateFolder?: (path: string) => Promise<boolean> | boolean;
  /** Recursively delete a folder. The handler owns the confirm dialog. */
  onDeleteFolder?: (path: string) => Promise<boolean> | boolean;
  /** Rename/move a folder (from → to project-relative paths). */
  onRenameFolder?: (from: string, to: string) => Promise<boolean> | boolean;
  onUpload: () => void;
  onUploadFiles: (files: File[]) => void;
  onPaste: () => void;
  onOpenBrowser?: () => void;
  onDuplicateProject?: () => void;
  duplicateProjectBusy?: boolean;
  // Reports the folder the panel is currently viewing so the parent can create
  // new files (upload / paste / dropped files) under it instead
  // of the project root. Fires whenever the user navigates folders.
  onCurrentDirChange?: (dir: string) => void;
  uploadError?: string | null;
  onClearUploadError?: () => void;
  preferredPreviewFile?: string | null;
  autoPreviewDesignArtifacts?: boolean;
  navState?: DesignFilesNavState;
  onNavStateChange?: (state: DesignFilesNavState) => void;
  /** Opens the project-wide content search overlay (Cmd/Ctrl+Shift+F). */
  onOpenContentSearch?: () => void;
}

/** Tree-view directory node: nested dirs keyed by segment plus leaf files. */
interface TreeDirNode {
  path: string;
  name: string;
  dirs: Map<string, TreeDirNode>;
  files: ProjectFile[];
}

// Display-only refinement of ProjectFileKind. The contract `kind` lumps all
// source under `code`; the Design Files surface splits CSS/SCSS/etc. into a
// dedicated "Stylesheets" section to mirror Claude Design. Everything else
// maps 1:1 to its kind.
type FileCategory = ProjectFileKind | 'stylesheet';

// Section render order. Empty categories are skipped; the FOLDERS section is
// pinned above all of these from the directory list.
const SECTION_ORDER: FileCategory[] = [
  'html',
  'stylesheet',
  'code',
  'document',
  'text',
  'image',
  'pdf',
  'presentation',
  'spreadsheet',
  'video',
  'audio',
  'binary',
];

const STYLESHEET_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less']);

function fileCategory(file: ProjectFile): FileCategory {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (STYLESHEET_EXTENSIONS.has(ext)) return 'stylesheet';
  return file.kind;
}

type FileSystemEntryWithReader = FileSystemEntry & {
  createReader?: () => FileSystemDirectoryReader;
};
type FileSystemFileEntryWithFile = FileSystemFileEntry & {
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
};
type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

// Useful-info tips that rotate one at a time in the panel footer, ordered as
// a loose journey: file basics → feeding context → generating → iterating →
// exporting/sharing. A tip with a `url` renders its typed line as a link to
// that destination. MatOS has no public community/social channels, so the
// upstream Open Design follow-us tips (Discord/GitHub/X/Threads/Instagram/
// YouTube/LinkedIn/Xiaohongshu) are intentionally not listed here.
const USEFUL_TIPS: ReadonlyArray<{ key: keyof Dict; url?: string }> = [
  { key: 'designFiles.usefulInfoTip' },
  { key: 'designFiles.usefulInfoTip2' },
  { key: 'designFiles.usefulInfoTip9' },
  { key: 'designFiles.usefulInfoTip10' },
  { key: 'designFiles.usefulInfoTip4' },
  { key: 'designFiles.usefulInfoTip11' },
  { key: 'designFiles.usefulInfoTip12' },
  { key: 'designFiles.usefulInfoTip13' },
  { key: 'designFiles.usefulInfoTip14' },
  { key: 'designFiles.usefulInfoTip15' },
  { key: 'designFiles.usefulInfoTip5' },
];
const TIP_TYPE_MS = 32; // per-character typing speed
const TIP_HOLD_MS = 3800; // pause on a fully-typed tip before advancing

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Footer "tip" line that types out one tip at a time (typewriter), holds, then
// advances to the next — mirroring Claude Design's empty-state hint. Under
// prefers-reduced-motion the full tip is shown immediately and just cycles.
function RotatingTip() {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState('');
  // Resolve tips each render but read them through a ref so the typing effect
  // depends only on `index` — depending on the (re-created) array would reset
  // the typewriter on every render and never advance.
  const tipsRef = useRef<string[]>([]);
  tipsRef.current = USEFUL_TIPS.map(({ key }) => t(key));

  useEffect(() => {
    const tips = tipsRef.current;
    const full = tips[index] ?? '';
    if (isVisualStabilityMode()) {
      setIndex(0);
      setTyped(tips[0] ?? '');
      return;
    }
    if (prefersReducedMotion()) {
      setTyped(full);
      if (tips.length < 2) return;
      const hold = window.setTimeout(
        () => setIndex((i) => (i + 1) % tips.length),
        TIP_HOLD_MS,
      );
      return () => window.clearTimeout(hold);
    }
    setTyped('');
    let i = 0;
    let holdTimer = 0;
    const typeTimer = window.setInterval(() => {
      i += 1;
      setTyped(full.slice(0, i));
      if (i >= full.length) {
        window.clearInterval(typeTimer);
        if (tips.length < 2) return;
        holdTimer = window.setTimeout(
          () => setIndex((p) => (p + 1) % tips.length),
          TIP_HOLD_MS,
        );
      }
    }, TIP_TYPE_MS);
    return () => {
      window.clearInterval(typeTimer);
      window.clearTimeout(holdTimer);
    };
  }, [index]);

  return (
    <div className="df-useful-info">
      <div className="df-useful-info-head">
        <Icon name="sparkles" size={12} />
        <span className="df-useful-info-label">{t('designFiles.usefulInfoLabel')}</span>
      </div>
      <span className="df-useful-info-tip">
        {USEFUL_TIPS[index]?.url ? (
          <a className="df-tip-link" href={USEFUL_TIPS[index].url} target="_blank" rel="noreferrer">
            {typed}
          </a>
        ) : (
          typed
        )}
        <span className="df-tip-caret" aria-hidden />
      </span>
    </div>
  );
}

/**
 * Full-panel browser for a project's `.od/projects/<id>/` folder. Mirrors
 * Claude Design's "Design Files" surface: a single-line toolbar (up / refresh
 * / breadcrumbs + actions), semantic sections (Folders, Stylesheets, Scripts,
 * Documents, Images …), hover-revealed row checkbox + menu, a right-side
 * preview pane, and a static "useful info" footer. Triggered as a sticky
 * first tab in FileWorkspace.
 */
export function DesignFilesPanel({
  projectId,
  rootDirName,
  reloading,
  running = false,
  files,
  filePaging,
  folders,
  onOpenFile,
  onRenameFile,
  onDeleteFile,
  onDeleteFiles,
  onCreateFile,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  onUpload,
  onUploadFiles,
  onPaste,
  onOpenBrowser,
  onDuplicateProject,
  duplicateProjectBusy = false,
  uploadError = null,
  onClearUploadError,
  preferredPreviewFile = null,
  autoPreviewDesignArtifacts = false,
  onCurrentDirChange,
  navState,
  onNavStateChange,
  onOpenContentSearch,
}: Props) {
  const t = useT();
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [dropReadError, setDropReadError] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const [hover, setHover] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ name: string; top: number; left: number } | null>(null);
  const MENU_ESTIMATED_HEIGHT = 180;
  const MENU_SAFE_PADDING = 8;
  const [preview, setPreview] = useState<string | null>(() => navState?.preview ?? null);
  // A restored selection counts as "already applied" so auto-preview never
  // clobbers the row the user had picked before jumping away.
  const autoPreviewAppliedRef = useRef(Boolean(navState?.preview));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastKeyPress = useRef<Map<string, number>>(new Map());
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<{ name: string; draft: string; saving: boolean } | null>(null);
  const [copiedLocalPath, setCopiedLocalPath] = useState<string | null>(null);
  // Inline "new folder" input row (toolbar 新建文件夹). Created under currentDir.
  const [creatingFolder, setCreatingFolder] = useState<{ draft: string; saving: boolean } | null>(null);
  // Folder-row context menu + inline folder rename state.
  const [dirMenuPos, setDirMenuPos] = useState<{ path: string; top: number; left: number } | null>(null);
  const [renamingDir, setRenamingDir] = useState<{ path: string; draft: string; saving: boolean } | null>(null);
  // "Move to folder" dialog for one or more files.
  const [moveDialog, setMoveDialog] = useState<{
    names: string[];
    dest: string;
    newFolder: string;
    saving: boolean;
    error: string | null;
  } | null>(null);
  const [currentDir, setCurrentDir] = useState<string>(() => navState?.currentDir ?? '');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  // 'list' keeps the semantic sections + folder navigation; 'tree' renders a
  // VSCode-style expandable directory tree of the whole project. Sticky per
  // browser (not per project) — it is a working-style preference.
  const [viewMode, setViewMode] = useState<'list' | 'tree'>(() => {
    try {
      return localStorage.getItem('od-design-files-view') === 'tree' ? 'tree' : 'list';
    } catch {
      return 'list';
    }
  });
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(navState?.expandedDirs ?? []),
  );
  const [filePage, setFilePage] = useState({ scope: '', index: 0 });
  // ---- VSCode-style tree state ------------------------------------------
  // Single selection (file or dir path) — drives keyboard nav + F2/Delete.
  const [treeSelection, setTreeSelection] = useState<
    { kind: 'file' | 'dir'; path: string } | null
  >(null);
  // Right-click context menu; kind 'root' = empty-area menu (new file/folder
  // at project root).
  const [treeMenu, setTreeMenu] = useState<
    { kind: 'file' | 'dir' | 'root'; path: string; top: number; left: number } | null
  >(null);
  // One inline editor at a time: creating (under `parent`) or renaming.
  const [treeEditor, setTreeEditor] = useState<
    | { mode: 'new-file' | 'new-dir'; parent: string; draft: string; saving: boolean }
    | { mode: 'rename-file' | 'rename-dir'; path: string; draft: string; saving: boolean }
    | null
  >(null);
  // Directory (or '' = root) currently hovered as a drag-move drop target.
  const [treeDropTarget, setTreeDropTarget] = useState<string | null>(null);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const treeEditorInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (treeEditor && !treeEditor.saving) treeEditorInputRef.current?.select();
    // Re-select only when a NEW editor opens, not on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeEditor?.mode, (treeEditor as { path?: string } | null)?.path]);
  // Dismiss the tree context menu on any outside click / Escape.
  useEffect(() => {
    if (!treeMenu) return;
    const dismiss = () => setTreeMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTreeMenu(null);
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [treeMenu]);

  const toggleViewMode = () => {
    setViewMode((current) => {
      const next = current === 'tree' ? 'list' : 'tree';
      try {
        localStorage.setItem('od-design-files-view', next);
      } catch {
        // preference persistence is best-effort
      }
      return next;
    });
  };

  // Keep the parent's create-target in sync with the folder being viewed, so
  // uploads / pastes / new sketches / dropped files land in the open folder
  // rather than the project root.
  useEffect(() => {
    onCurrentDirChange?.(currentDir);
  }, [currentDir, onCurrentDirChange]);

  useEffect(() => {
    onNavStateChange?.({
      currentDir,
      expandedDirs: [...expandedDirs],
      preview,
    });
  }, [currentDir, expandedDirs, preview, onNavStateChange]);

  // Derive immediate subdirectories and files at the current directory level
  // from the flat files list. Files with names like "a/b/c.html" contribute
  // "a" as a directory when currentDir is '' and "b" when currentDir is "a".
  const { dirsAtCurrentDir, filesAtCurrentDir } = useMemo(() => {
    const prefix = currentDir === '' ? '' : `${currentDir}/`;
    const dirs = new Set<string>();
    const localFiles: ProjectFile[] = [];
    for (const f of files) {
      if (!f.name.startsWith(prefix)) continue;
      const remainder = f.name.slice(prefix.length);
      const slashIdx = remainder.indexOf('/');
      if (slashIdx === -1) {
        localFiles.push(f);
      } else {
        dirs.add(remainder.slice(0, slashIdx));
        if (currentDir === '') localFiles.push(f);
      }
    }
    // Also surface persisted folders (including empty ones with no files under
    // them) as immediate children of the current directory.
    for (const folder of folders ?? []) {
      if (!folder.path.startsWith(prefix)) continue;
      const remainder = folder.path.slice(prefix.length);
      if (!remainder) continue; // the current directory itself
      const slashIdx = remainder.indexOf('/');
      dirs.add(slashIdx === -1 ? remainder : remainder.slice(0, slashIdx));
    }
    return {
      dirsAtCurrentDir: [...dirs].sort((a, b) => a.localeCompare(b)),
      filesAtCurrentDir: localFiles,
    };
  }, [files, folders, currentDir]);

  // Group files at the current level into semantic sections, ordered by
  // SECTION_ORDER. Files within a section sort most-recently-modified first.
  const sections = useMemo(() => {
    const grouped = new Map<FileCategory, ProjectFile[]>();
    for (const f of filesAtCurrentDir) {
      const category = fileCategory(f);
      const bucket = grouped.get(category) ?? [];
      bucket.push(f);
      grouped.set(category, bucket);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => b.mtime - a.mtime);
    }
    return SECTION_ORDER.filter((category) => grouped.has(category)).map(
      (category) => [category, grouped.get(category)!] as const,
    );
  }, [filesAtCurrentDir]);

  // Reset selection and renaming state when the user navigates into or out of
  // a directory.
  useEffect(() => {
    setSelected(new Set());
    setRenaming(null);
    setCreatingFolder(null);
    setRenamingDir(null);
    setDirMenuPos(null);
  }, [currentDir]);

  // Navigate up to the nearest ancestor that still exists when the current
  // directory disappears (e.g. after deleting the last file in a subfolder).
  // A directory "exists" if it has files under it OR is a persisted folder
  // (possibly empty) — otherwise navigating into an empty folder would bounce
  // straight back to the root.
  useEffect(() => {
    if (currentDir === '') return;
    const dirExists = (dir: string) =>
      files.some((f) => f.name.startsWith(`${dir}/`)) ||
      (folders ?? []).some((fo) => fo.path === dir || fo.path.startsWith(`${dir}/`));
    if (dirExists(currentDir)) return;
    const parts = currentDir.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('/');
      if (dirExists(ancestor)) {
        setCurrentDir(ancestor);
        return;
      }
    }
    setCurrentDir('');
  }, [files, folders, currentDir]);

  // Prune selections that no longer exist in the current file list
  // (e.g. after a refresh or delete within the same project).
  // Cross-project leaks are handled by the parent remounting this
  // component via key={projectId}.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const names = new Set(files.map((f) => f.name));
      const next = new Set(prev);
      let changed = false;
      for (const n of next) {
        if (!names.has(n)) {
          next.delete(n);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [files]);

  const previewFile = useMemo(
    () => files.find((f) => f.name === preview) ?? null,
    [preview, files],
  );

  const initialPreviewFile = useMemo(
    () =>
      autoPreviewDesignArtifacts
        ? selectInitialDesignPreviewFile(files, preferredPreviewFile)
        : null,
    [autoPreviewDesignArtifacts, files, preferredPreviewFile],
  );

  useEffect(() => {
    if (autoPreviewAppliedRef.current) return;
    if (!initialPreviewFile) return;
    autoPreviewAppliedRef.current = true;
    setPreview(initialPreviewFile.name);
  }, [initialPreviewFile]);

  useEffect(() => {
    if (!preview) return;
    if (files.some((f) => f.name === preview)) return;
    if (filePaging?.hasMore || filePaging?.error) return;
    setPreview(null);
  }, [files, preview, filePaging?.hasMore, filePaging?.error]);

  // After a remount with a restored selection, bring that row back into view
  // once its DOM row exists (files may still be streaming in on early passes).
  // One-shot: user-driven selection afterwards never triggers scrolling.
  const restoredSelectionScrolledRef = useRef(false);
  useEffect(() => {
    if (restoredSelectionScrolledRef.current) return;
    if (!preview) {
      restoredSelectionScrolledRef.current = true;
      return;
    }
    const row = panelRef.current?.querySelector<HTMLElement>('.df-row.active');
    if (!row) return;
    restoredSelectionScrolledRef.current = true;
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [preview, files, viewMode, currentDir, expandedDirs]);

  useEffect(() => {
    if (!menuPos) return;
    const close = () => setMenuPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuPos]);

  useEffect(() => {
    if (!dirMenuPos) return;
    const close = () => setDirMenuPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [dirMenuPos]);

  useEffect(() => {
    const onClipboardPaste = (event: ClipboardEvent) => {
      if (shouldIgnoreClipboardFilePaste(event.target)) return;
      const pastedFiles = filesFromClipboardData(event.clipboardData);
      if (pastedFiles.length === 0) return;
      event.preventDefault();
      setDropReadError(null);
      onClearUploadError?.();
      onUploadFiles(pastedFiles);
    };
    window.addEventListener('paste', onClipboardPaste);
    return () => window.removeEventListener('paste', onClipboardPaste);
  }, [onClearUploadError, onUploadFiles]);
  useEffect(() => {
    if (!projectMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && projectMenuRef.current?.contains(target)) return;
      setProjectMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setProjectMenuOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [projectMenuOpen]);

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function openMenuFor(name: string, el: HTMLElement) {
    const rect = el.closest('.df-row-menu')?.getBoundingClientRect();
    if (!rect) return;

    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    let top: number;
    if (spaceBelow >= MENU_ESTIMATED_HEIGHT + MENU_SAFE_PADDING) {
      top = rect.bottom + 4;
    } else if (spaceAbove >= MENU_ESTIMATED_HEIGHT + MENU_SAFE_PADDING) {
      top = rect.top - MENU_ESTIMATED_HEIGHT - 4;
    } else {
      top = Math.max(
        MENU_SAFE_PADDING,
        viewportHeight - MENU_ESTIMATED_HEIGHT - MENU_SAFE_PADDING,
      );
    }

    const left = Math.max(MENU_SAFE_PADDING, rect.right - 160);

    setMenuPos({ name, top, left });
  }

  async function copyLocalPath(fileName: string) {
    const localPath = files.find((file) => file.name === fileName)?.localPath;
    if (!localPath) return;
    const copied = await copyToClipboard(localPath);
    if (copied) {
      setCopiedLocalPath(fileName);
      window.setTimeout(() => {
        setCopiedLocalPath((current) => (current === fileName ? null : current));
      }, 1600);
    }
  }

  function startRename(name: string) {
    setMenuPos(null);
    setPreview(name);
    const draft = currentDir === '' ? name : name.slice(currentDir.length + 1);
    setRenaming({ name, draft, saving: false });
  }

  async function commitRename(name: string, draft: string) {
    const nextBasename = draft.trim();
    if (!nextBasename) {
      setRenaming(null);
      return;
    }
    const nextName = currentDir === '' ? nextBasename : `${currentDir}/${nextBasename}`;
    if (nextName === name) {
      setRenaming(null);
      return;
    }
    setRenaming({ name, draft, saving: true });
    try {
      const renamed = await onRenameFile(name, nextName);
      if (!renamed) throw new Error('Rename failed');
      setPreview((curr) => (curr === name ? renamed.name : curr));
      setSelected((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Set(prev);
        next.delete(name);
        next.add(renamed.name);
        return next;
      });
      setRenaming(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setRenaming({ name, draft, saving: false });
    }
  }

  async function commitCreateFolder() {
    const state = creatingFolder;
    if (!state || state.saving) return;
    const base = state.draft.trim();
    if (!base) {
      setCreatingFolder(null);
      return;
    }
    const full = currentDir === '' ? base : `${currentDir}/${base}`;
    setCreatingFolder({ ...state, saving: true });
    try {
      const ok = await onCreateFolder?.(full);
      if (!ok) throw new Error(`${t('designFiles.newFolderTitle')}: ${base}`);
      setCreatingFolder(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setCreatingFolder({ draft: state.draft, saving: false });
    }
  }

  function openDirMenuFor(dirPath: string, el: HTMLElement) {
    const rect = el.closest('.df-row-menu')?.getBoundingClientRect();
    if (!rect) return;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    let top: number;
    if (spaceBelow >= MENU_ESTIMATED_HEIGHT + MENU_SAFE_PADDING) {
      top = rect.bottom + 4;
    } else {
      top = Math.max(MENU_SAFE_PADDING, rect.top - MENU_ESTIMATED_HEIGHT - 4);
    }
    const left = Math.max(MENU_SAFE_PADDING, rect.right - 160);
    setDirMenuPos({ path: dirPath, top, left });
  }

  function startDirRename(dirPath: string) {
    setDirMenuPos(null);
    const base = dirPath.split('/').pop() ?? dirPath;
    setRenamingDir({ path: dirPath, draft: base, saving: false });
  }

  async function commitDirRename(dirPath: string, draft: string) {
    const nextBase = draft.trim();
    const oldBase = dirPath.split('/').pop() ?? dirPath;
    if (!nextBase || nextBase === oldBase) {
      setRenamingDir(null);
      return;
    }
    const parent = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
    const nextPath = parent === '' ? nextBase : `${parent}/${nextBase}`;
    setRenamingDir({ path: dirPath, draft, saving: true });
    try {
      const ok = await onRenameFolder?.(dirPath, nextPath);
      if (!ok) throw new Error('Rename failed');
      setRenamingDir(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setRenamingDir({ path: dirPath, draft, saving: false });
    }
  }

  async function handleDeleteDir(dirPath: string) {
    setDirMenuPos(null);
    // The parent handler owns the confirm dialog + tab cleanup.
    await onDeleteFolder?.(dirPath);
  }

  function openMoveDialog(names: string[]) {
    setMenuPos(null);
    setMoveDialog({ names, dest: '', newFolder: '', saving: false, error: null });
  }

  // All known folder paths (persisted folders + prefixes implied by files),
  // sorted, for the move-destination dropdown.
  const allFolderPaths = useMemo(() => {
    const out = new Set<string>();
    for (const folder of folders ?? []) {
      if (folder.path) out.add(folder.path);
    }
    for (const f of files) {
      const parts = f.name.split('/');
      let walked = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] ?? '';
        walked = walked ? `${walked}/${part}` : part;
        out.add(walked);
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }, [files, folders]);

  async function commitMove() {
    const dialog = moveDialog;
    if (!dialog || dialog.saving) return;
    const wantsNewFolder = dialog.dest === '__new__';
    const newFolderName = dialog.newFolder.trim();
    if (wantsNewFolder && !newFolderName) {
      setMoveDialog({ ...dialog, error: t('designFiles.newFolderLabel') });
      return;
    }
    const destDir = wantsNewFolder ? newFolderName : dialog.dest;
    setMoveDialog({ ...dialog, saving: true, error: null });
    try {
      if (wantsNewFolder && onCreateFolder) {
        const created = await onCreateFolder(destDir);
        if (!created) throw new Error(`${t('designFiles.newFolderTitle')}: ${destDir}`);
      }
      const moved: string[] = [];
      for (const name of dialog.names) {
        const base = name.split('/').pop() ?? name;
        const target = destDir === '' ? base : `${destDir}/${base}`;
        if (target === name) continue;
        const renamed = await onRenameFile(name, target);
        if (!renamed) throw new Error(`Move failed: ${name}`);
        moved.push(renamed.name);
      }
      setSelected(new Set());
      setPreview((curr) => (curr && dialog.names.includes(curr) ? null : curr));
      setMoveDialog(null);
    } catch (err) {
      setMoveDialog({
        ...dialog,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleBatchDelete() {
    if (deleting) return;
    const fileList = [...selected];
    if (fileList.length === 0) return;
    setDeleting(true);
    try {
      await onDeleteFiles(fileList);
      // Don't clear `selected` here: confirm-cancel and all-fail paths
      // should leave the user's selection intact for retry. The
      // `useEffect` above prunes successfully-deleted names automatically
      // once `files` refreshes.
    } finally {
      setDeleting(false);
    }
  }

  function renderFileRow(f: ProjectFile, category: FileCategory) {
    const active = preview === f.name;
    const isSelected = selected.has(f.name);
    const isHovered = hover === f.name;
    const renameState = renaming?.name === f.name ? renaming : null;
    return (
      <div
        key={f.name}
        data-testid={`design-file-row-${f.name}`}
        className={`df-row df-file-row ${active ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
        onMouseEnter={() => setHover(f.name)}
        onMouseLeave={() => setHover((c) => (c === f.name ? null : c))}
      >
        <span
          className="df-row-check"
          onClick={(e) => {
            e.stopPropagation();
            toggleSelect(f.name);
          }}
          role="checkbox"
          aria-checked={isSelected}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              toggleSelect(f.name);
            }
          }}
        >
          <span className="df-row-check-box" aria-hidden>
            {isSelected ? <Icon name="check" size={12} /> : null}
          </span>
        </span>
        <span
          className="df-row-icon df-row-openable"
          data-kind={category}
          aria-hidden
          onClick={() => setPreview(f.name)}
          onDoubleClick={() => onOpenFile(f.name)}
        >
          {categoryGlyph(category)}
        </span>
        <div className="df-row-name-wrap">
          {renameState ? (
            <input
              autoFocus
              className="df-rename-input"
              value={renameState.draft}
              disabled={renameState.saving}
              onChange={(e) => setRenaming({ ...renameState, draft: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                if (e.currentTarget.dataset.skipRenameCommit === '1') return;
                void commitRename(f.name, renameState.draft);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.dataset.skipRenameCommit = '1';
                  void commitRename(f.name, renameState.draft);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.currentTarget.dataset.skipRenameCommit = '1';
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="df-row-name-btn"
              onClick={() => setPreview(f.name)}
              onDoubleClick={() => onOpenFile(f.name)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  const now = Date.now();
                  const last = lastKeyPress.current.get(f.name) ?? 0;
                  if (now - last < 300) {
                    lastKeyPress.current.delete(f.name);
                    onOpenFile(f.name);
                  } else {
                    lastKeyPress.current.set(f.name, now);
                    setPreview(f.name);
                  }
                }
              }}
            >
              <span className="df-row-name-wrap">
                <span
                  className="df-row-name"
                  title={currentDir === '' ? f.name : f.name.slice(currentDir.length + 1)}
                >
                  {currentDir === '' ? f.name : f.name.slice(currentDir.length + 1)}
                </span>
                <span className="df-row-sub">{categoryLabel(category, t)}</span>
              </span>
            </button>
          )}
        </div>
        <span
          className="df-row-size df-row-openable"
          onClick={() => setPreview(f.name)}
          onDoubleClick={() => onOpenFile(f.name)}
        >
          {humanBytes(f.size)}
        </span>
        <span
          className="df-row-time df-row-openable"
          onClick={() => setPreview(f.name)}
          onDoubleClick={() => onOpenFile(f.name)}
        >
          {relativeTime(f.mtime, t)}
        </span>
        <span
          data-testid={`design-file-menu-${f.name}`}
          className="df-row-menu"
          style={isHovered || active ? { opacity: 1 } : undefined}
          role="button"
          tabIndex={0}
          aria-label={t('designFiles.rowMenu')}
          onClick={(e) => {
            e.stopPropagation();
            openMenuFor(f.name, e.target as HTMLElement);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openMenuFor(f.name, e.currentTarget as HTMLElement);
            }
          }}
        >
          ⋯
        </span>
      </div>
    );
  }

  function renderDirRow(dirName: string) {
    const fullPath = currentDir === '' ? dirName : `${currentDir}/${dirName}`;
    const prefix = `${fullPath}/`;
    const count = files.filter((f) => f.name.startsWith(prefix)).length;
    const renameState = renamingDir?.path === fullPath ? renamingDir : null;
    const hasDirActions = Boolean(onRenameFolder || onDeleteFolder);
    return (
      <div
        key={`dir:${fullPath}`}
        className="df-row df-dir-row"
        data-testid={`design-dir-row-${fullPath}`}
        onClick={renameState ? undefined : () => setCurrentDir(fullPath)}
      >
        <span className="df-row-check" aria-hidden />
        <span className="df-row-icon" data-kind="folder" aria-hidden>
          <Icon name="folder" size={14} />
        </span>
        <div className="df-row-name-wrap">
          {renameState ? (
            <input
              autoFocus
              className="df-rename-input"
              value={renameState.draft}
              disabled={renameState.saving}
              onChange={(e) => setRenamingDir({ ...renameState, draft: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                if (e.currentTarget.dataset.skipRenameCommit === '1') return;
                void commitDirRename(fullPath, renameState.draft);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.dataset.skipRenameCommit = '1';
                  void commitDirRename(fullPath, renameState.draft);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.currentTarget.dataset.skipRenameCommit = '1';
                  setRenamingDir(null);
                }
              }}
            />
          ) : (
            <button type="button" className="df-row-name-btn" onClick={() => setCurrentDir(fullPath)}>
              <span className="df-row-name-wrap">
                <span className="df-row-name" title={dirName}>{dirName}</span>
                {!filePaging?.hasMore ? <span className="df-row-sub">{t('designFiles.folderCount', { n: count })}</span> : null}
              </span>
            </button>
          )}
        </div>
        <span className="df-row-size" />
        <span className="df-row-time" />
        {hasDirActions ? (
          <span
            data-testid={`design-dir-menu-${fullPath}`}
            className="df-row-menu"
            role="button"
            tabIndex={0}
            aria-label={t('designFiles.rowMenu')}
            onClick={(e) => {
              e.stopPropagation();
              openDirMenuFor(fullPath, e.target as HTMLElement);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                openDirMenuFor(fullPath, e.currentTarget as HTMLElement);
              }
            }}
          >
            ⋯
          </span>
        ) : (
          <span className="df-row-menu df-row-menu-placeholder" aria-hidden />
        )}
      </div>
    );
  }

  async function handleBatchDownload() {
    const fileList = [...selected];
    if (fileList.length === 0) return;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/archive/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: fileList }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.message || `request failed (${resp.status})`);
      }
      const blob = await resp.blob();
      const header = resp.headers.get('content-disposition') || '';
      const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
      let filename = 'project.zip';
      if (star && star[1]) {
        try {
          filename = decodeURIComponent(star[1]);
        } catch {
          filename = star[1];
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.warn('[batchDownload] failed:', err);
    }
  }

  async function handleDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    setDropReadError(null);
    try {
      const dropped = await filesFromDataTransfer(ev.dataTransfer);
      if (dropped.length > 0) onUploadFiles(dropped);
    } catch (error) {
      if (!isFileSystemReadError(error)) throw error;
      setDropReadError(FILE_SYSTEM_READ_ERROR_MESSAGE);
    }
  }

  // Full nested directory tree (tree view mode). Dirs sort before files,
  // both alphabetically — the VSCode convention — while the list mode keeps
  // its recency-first semantic sections.
  const fileTree = useMemo(() => {
    const root: TreeDirNode = { path: '', name: '', dirs: new Map(), files: [] };
    const dirFor = (dirPath: string): TreeDirNode => {
      if (!dirPath) return root;
      let node = root;
      let walked = '';
      for (const segment of dirPath.split('/')) {
        walked = walked ? `${walked}/${segment}` : segment;
        let child = node.dirs.get(segment);
        if (!child) {
          child = { path: walked, name: segment, dirs: new Map(), files: [] };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      return node;
    };
    for (const folder of folders ?? []) dirFor(folder.path);
    for (const f of files) {
      const slash = f.name.lastIndexOf('/');
      const dir = slash >= 0 ? f.name.slice(0, slash) : '';
      dirFor(dir).files.push(f);
    }
    const sortNode = (node: TreeDirNode) => {
      node.files.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of node.dirs.values()) sortNode(child);
    };
    sortNode(root);
    return root;
  }, [files, folders]);

  // ---- VSCode-style tree behaviors ------------------------------------------

  /** Expand every ancestor dir so `path` is visible in the tree. */
  const revealTreePath = (path: string) => {
    const parts = path.split('/');
    if (parts.length <= 1) return;
    setExpandedDirs((current) => {
      const next = new Set(current);
      let walked = '';
      for (const segment of parts.slice(0, -1)) {
        walked = walked ? `${walked}/${segment}` : segment;
        next.add(walked);
      }
      return next;
    });
  };

  // Reveal the previewed file whenever it changes while the tree is showing —
  // the VSCode "reveal active file in explorer" behavior.
  useEffect(() => {
    if (viewMode === 'tree' && preview) revealTreePath(preview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, preview]);

  const toggleDirExpanded = (dirPath: string, force?: boolean) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      const open = force ?? !next.has(dirPath);
      if (open) next.add(dirPath);
      else next.delete(dirPath);
      return next;
    });
  };

  /** Flattened visible rows in render order — the keyboard-nav model. */
  const visibleTreeRows = useMemo(() => {
    const rows: Array<{ kind: 'file' | 'dir'; path: string }> = [];
    const walk = (node: TreeDirNode) => {
      for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        rows.push({ kind: 'dir', path: dir.path });
        if (expandedDirs.has(dir.path)) walk(dir);
      }
      for (const f of node.files) rows.push({ kind: 'file', path: f.name });
    };
    walk(fileTree);
    return rows;
  }, [fileTree, expandedDirs]);

  // The root's flat view is useful for finding nested deliverables, but must
  // not mount an entire scientific source tree into the DOM. Keep the full
  // index and all existing actions; page only the rows being rendered.
  const rowKeys = useMemo(() => viewMode === 'tree'
    ? visibleTreeRows.map(row => `${row.kind}:${row.path}`)
    : [
        ...dirsAtCurrentDir.map(dir => `dir:${dir}`),
        ...sections.flatMap(([, entries]) => entries.map(file => `file:${file.name}`)),
      ], [viewMode, visibleTreeRows, dirsAtCurrentDir, sections]);
  const pageScope = `${projectId}\n${viewMode}\n${currentDir}`;
  const lastPage = Math.max(0, Math.ceil(rowKeys.length / FILE_ROWS_PER_PAGE) - 1);
  const pageIndex = Math.min(filePage.scope === pageScope ? filePage.index : 0, lastPage);
  const pageKeys = useMemo(() => new Set(rowKeys.slice(pageIndex * FILE_ROWS_PER_PAGE, (pageIndex + 1) * FILE_ROWS_PER_PAGE)), [rowKeys, pageIndex]);
  const lastRevealedRow = useRef('');
  useEffect(() => {
    const key = viewMode === 'tree' && treeSelection ? `${treeSelection.kind}:${treeSelection.path}` : preview ? `file:${preview}` : '';
    const request = `${pageScope}\n${key}`;
    if (!key || lastRevealedRow.current === request) return;
    const index = rowKeys.indexOf(key);
    if (index < 0) return; // A restored selection can precede the file index.
    lastRevealedRow.current = request;
    setFilePage({ scope: pageScope, index: Math.floor(index / FILE_ROWS_PER_PAGE) });
  }, [pageScope, preview, treeSelection, viewMode, rowKeys]);

  const openTreeMenu = (
    event: ReactMouseEvent,
    target: { kind: 'file' | 'dir' | 'root'; path: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (target.kind !== 'root') setTreeSelection({ kind: target.kind, path: target.path });
    const MENU_WIDTH = 180;
    setTreeMenu({
      ...target,
      top: Math.min(event.clientY, window.innerHeight - MENU_ESTIMATED_HEIGHT - MENU_SAFE_PADDING),
      left: Math.min(event.clientX, window.innerWidth - MENU_WIDTH - MENU_SAFE_PADDING),
    });
  };

  const startTreeCreate = (mode: 'new-file' | 'new-dir', parent: string) => {
    setTreeMenu(null);
    if (parent) toggleDirExpanded(parent, true);
    setTreeEditor({ mode, parent, draft: '', saving: false });
  };

  const startTreeRename = (target: { kind: 'file' | 'dir'; path: string }) => {
    setTreeMenu(null);
    setTreeEditor({
      mode: target.kind === 'file' ? 'rename-file' : 'rename-dir',
      path: target.path,
      draft: target.path.split('/').pop() ?? target.path,
      saving: false,
    });
  };

  const commitTreeEditor = async () => {
    const editor = treeEditor;
    if (!editor || editor.saving) return;
    const base = editor.draft.trim();
    if (!base) {
      setTreeEditor(null);
      return;
    }
    if (base.includes('/')) {
      alert(t('designFiles.treeNameNoSlash'));
      return;
    }
    setTreeEditor({ ...editor, saving: true });
    try {
      if (editor.mode === 'new-file') {
        const full = editor.parent ? `${editor.parent}/${base}` : base;
        if (files.some((file) => file.name === full)) {
          throw new Error(t('designFiles.treeNameTaken', { name: full }));
        }
        const created = await onCreateFile?.(full);
        if (!created) throw new Error(`${t('designFiles.treeNewFile')}: ${full}`);
        setTreeEditor(null);
        setTreeSelection({ kind: 'file', path: created.name });
        setPreview(created.name);
        onOpenFile(created.name);
      } else if (editor.mode === 'new-dir') {
        const full = editor.parent ? `${editor.parent}/${base}` : base;
        const ok = await onCreateFolder?.(full);
        if (!ok) throw new Error(`${t('designFiles.newFolderTitle')}: ${full}`);
        setTreeEditor(null);
        setTreeSelection({ kind: 'dir', path: full });
        toggleDirExpanded(full, true);
      } else if (editor.mode === 'rename-file') {
        const dir = editor.path.includes('/')
          ? editor.path.slice(0, editor.path.lastIndexOf('/'))
          : '';
        const next = dir ? `${dir}/${base}` : base;
        if (next !== editor.path) {
          const renamed = await onRenameFile(editor.path, next);
          if (!renamed) throw new Error('Rename failed');
          setPreview((curr) => (curr === editor.path ? renamed.name : curr));
          setTreeSelection({ kind: 'file', path: renamed.name });
        }
        setTreeEditor(null);
      } else if (editor.mode === 'rename-dir') {
        const parent = editor.path.includes('/')
          ? editor.path.slice(0, editor.path.lastIndexOf('/'))
          : '';
        const next = parent ? `${parent}/${base}` : base;
        if (next !== editor.path) {
          const ok = await onRenameFolder?.(editor.path, next);
          if (!ok) throw new Error('Rename failed');
          setTreeSelection({ kind: 'dir', path: next });
        }
        setTreeEditor(null);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setTreeEditor({ ...editor, saving: false });
    }
  };

  /** Drag-move: drop a file/dir row onto a dir row (or the root background). */
  const commitTreeMove = async (
    source: { kind: 'file' | 'dir'; path: string },
    destDir: string,
  ) => {
    const parent = source.path.includes('/')
      ? source.path.slice(0, source.path.lastIndexOf('/'))
      : '';
    if (destDir === parent || destDir === source.path) return;
    // A folder cannot move into its own subtree.
    if (source.kind === 'dir' && `${destDir}/`.startsWith(`${source.path}/`)) return;
    const baseName = source.path.split('/').pop() ?? source.path;
    const target = destDir ? `${destDir}/${baseName}` : baseName;
    try {
      if (source.kind === 'file') {
        const renamed = await onRenameFile(source.path, target);
        if (!renamed) throw new Error(`Move failed: ${source.path}`);
        setPreview((curr) => (curr === source.path ? renamed.name : curr));
        setTreeSelection({ kind: 'file', path: renamed.name });
      } else {
        const ok = await onRenameFolder?.(source.path, target);
        if (!ok) throw new Error(`Move failed: ${source.path}`);
        setTreeSelection({ kind: 'dir', path: target });
      }
      if (destDir) toggleDirExpanded(destDir, true);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const treeDragPayload = (event: ReactDragEvent): { kind: 'file' | 'dir'; path: string } | null => {
    try {
      const raw = event.dataTransfer.getData('application/x-od-tree-entry');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { kind?: string; path?: string };
      if ((parsed.kind === 'file' || parsed.kind === 'dir') && typeof parsed.path === 'string') {
        return { kind: parsed.kind, path: parsed.path };
      }
    } catch {
      // not a tree entry drag (e.g. OS file drop) — handled elsewhere
    }
    return null;
  };

  /** VSCode explorer keys: ↑/↓ walk, ←/→ collapse/expand, Enter open,
   *  F2 rename, Delete delete. */
  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (treeEditor) return;
    const rows = visibleTreeRows;
    if (rows.length === 0) return;
    const index = treeSelection
      ? rows.findIndex((row) => row.kind === treeSelection.kind && row.path === treeSelection.path)
      : -1;
    const select = (next: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (!row) return;
      setTreeSelection(row);
      setFilePage({ scope: pageScope, index: Math.floor(rows.indexOf(row) / FILE_ROWS_PER_PAGE) });
      if (row.kind === 'file') setPreview(row.path);
      requestAnimationFrame(() => treeContainerRef.current
        ?.querySelector(`[data-tree-path="${CSS.escape(`${row.kind}:${row.path}`)}"]`)
        ?.scrollIntoView({ block: 'nearest' }));
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        select(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        select(index <= 0 ? 0 : index - 1);
        break;
      case 'ArrowRight':
        if (!treeSelection) break;
        event.preventDefault();
        if (treeSelection.kind === 'dir' && !expandedDirs.has(treeSelection.path)) {
          toggleDirExpanded(treeSelection.path, true);
        } else {
          select(index + 1);
        }
        break;
      case 'ArrowLeft': {
        if (!treeSelection) break;
        event.preventDefault();
        if (treeSelection.kind === 'dir' && expandedDirs.has(treeSelection.path)) {
          toggleDirExpanded(treeSelection.path, false);
        } else {
          const parent = treeSelection.path.includes('/')
            ? treeSelection.path.slice(0, treeSelection.path.lastIndexOf('/'))
            : '';
          if (parent) {
            setTreeSelection({ kind: 'dir', path: parent });
          }
        }
        break;
      }
      case 'Enter':
        if (!treeSelection) break;
        event.preventDefault();
        if (treeSelection.kind === 'file') onOpenFile(treeSelection.path);
        else toggleDirExpanded(treeSelection.path);
        break;
      case 'F2':
        if (!treeSelection) break;
        event.preventDefault();
        startTreeRename(treeSelection);
        break;
      case 'Delete':
      case 'Backspace':
        if (!treeSelection) break;
        event.preventDefault();
        if (treeSelection.kind === 'file') onDeleteFile(treeSelection.path);
        else void onDeleteFolder?.(treeSelection.path);
        break;
      default:
        break;
    }
  };

  const treeEditorRow = (depth: number) => (
    <div className="df-row df-tree-row df-tree-editor" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="df-tree-chevron" aria-hidden />
      <span className="df-row-icon" aria-hidden>
        <Icon
          name={treeEditor?.mode === 'new-dir' || treeEditor?.mode === 'rename-dir' ? 'folder' : 'file'}
          size={13}
        />
      </span>
      <input
        ref={treeEditorInputRef}
        value={treeEditor?.draft ?? ''}
        disabled={treeEditor?.saving}
        placeholder={
          treeEditor?.mode === 'new-dir'
            ? t('designFiles.newFolderLabel')
            : t('designFiles.treeNewFilePlaceholder')
        }
        onChange={(event) =>
          setTreeEditor((curr) => (curr ? { ...curr, draft: event.target.value } : curr))
        }
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') void commitTreeEditor();
          if (event.key === 'Escape') setTreeEditor(null);
        }}
        onBlur={() => {
          if (treeEditor && !treeEditor.saving) void commitTreeEditor();
        }}
        data-testid="design-tree-editor-input"
      />
    </div>
  );

  function renderTree(node: TreeDirNode, depth: number): JSX.Element[] {
    const rows: JSX.Element[] = [];
    const indent = { paddingLeft: 8 + depth * 14 };
    const editorForDir = (dirPath: string) =>
      treeEditor && (treeEditor.mode === 'new-file' || treeEditor.mode === 'new-dir') &&
      treeEditor.parent === dirPath;
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const expanded = expandedDirs.has(dir.path);
      const selected = treeSelection?.kind === 'dir' && treeSelection.path === dir.path;
      const renamingThis = treeEditor?.mode === 'rename-dir' &&
        (treeEditor as { path?: string }).path === dir.path;
      if (pageKeys.has(`dir:${dir.path}`)) rows.push(
        <div
          key={`dir:${dir.path}`}
          role="treeitem"
          aria-expanded={expanded}
          tabIndex={-1}
          className={[
            'df-row df-tree-row df-tree-dir',
            selected ? 'is-selected' : '',
            treeDropTarget === dir.path ? 'is-drop-target' : '',
          ].filter(Boolean).join(' ')}
          style={indent}
          data-testid={`design-tree-dir-${dir.path}`}
          data-tree-path={`dir:${dir.path}`}
          draggable={!renamingThis}
          onClick={() => {
            setTreeSelection({ kind: 'dir', path: dir.path });
            toggleDirExpanded(dir.path);
          }}
          onContextMenu={(event) => openTreeMenu(event, { kind: 'dir', path: dir.path })}
          onDragStart={(event) => {
            event.dataTransfer.setData(
              'application/x-od-tree-entry',
              JSON.stringify({ kind: 'dir', path: dir.path }),
            );
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('application/x-od-tree-entry')) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setTreeDropTarget(dir.path);
          }}
          onDragLeave={() => {
            setTreeDropTarget((curr) => (curr === dir.path ? null : curr));
          }}
          onDrop={(event) => {
            const payload = treeDragPayload(event);
            setTreeDropTarget(null);
            if (!payload) return;
            event.preventDefault();
            event.stopPropagation();
            void commitTreeMove(payload, dir.path);
          }}
        >
          <span className={`df-tree-chevron${expanded ? ' is-open' : ''}`} aria-hidden>
            <Icon name="chevron-right" size={12} />
          </span>
          <span className="df-row-icon" data-kind="folder" aria-hidden>
            <Icon name={expanded ? 'folder' : 'folder-filled'} size={13} />
          </span>
          {renamingThis ? (
            <input
              ref={treeEditorInputRef}
              className="df-tree-rename-input"
              value={treeEditor?.draft ?? ''}
              disabled={treeEditor?.saving}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setTreeEditor((curr) => (curr ? { ...curr, draft: event.target.value } : curr))
              }
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') void commitTreeEditor();
                if (event.key === 'Escape') setTreeEditor(null);
              }}
              onBlur={() => {
                if (treeEditor && !treeEditor.saving) void commitTreeEditor();
              }}
            />
          ) : (
            <span className="df-tree-name" title={dir.path}>{dir.name}</span>
          )}
        </div>,
      );
      if (expanded && editorForDir(dir.path)) rows.push(
        <div key={`editor:${dir.path}`}>{treeEditorRow(depth + 1)}</div>,
      );
      if (expanded) rows.push(...renderTree(dir, depth + 1));
    }
    for (const f of node.files) {
      if (!pageKeys.has(`file:${f.name}`)) continue;
      const base = f.name.split('/').pop() ?? f.name;
      const active = preview === f.name;
      const selected = treeSelection?.kind === 'file' && treeSelection.path === f.name;
      const renamingThis = treeEditor?.mode === 'rename-file' &&
        (treeEditor as { path?: string }).path === f.name;
      rows.push(
        <div
          key={`file:${f.name}`}
          role="treeitem"
          tabIndex={-1}
          className={[
            'df-row df-tree-row df-tree-file',
            active ? 'active' : '',
            selected ? 'is-selected' : '',
          ].filter(Boolean).join(' ')}
          style={indent}
          data-testid={`design-tree-file-${f.name}`}
          data-tree-path={`file:${f.name}`}
          draggable={!renamingThis}
          onClick={() => {
            setTreeSelection({ kind: 'file', path: f.name });
            setPreview(f.name);
          }}
          onDoubleClick={() => onOpenFile(f.name)}
          onContextMenu={(event) => openTreeMenu(event, { kind: 'file', path: f.name })}
          onDragStart={(event) => {
            event.dataTransfer.setData(
              'application/x-od-tree-entry',
              JSON.stringify({ kind: 'file', path: f.name }),
            );
            event.dataTransfer.effectAllowed = 'move';
          }}
        >
          <span className="df-tree-chevron" aria-hidden />
          <span className="df-row-icon" data-kind={fileCategory(f)} aria-hidden>
            {categoryGlyph(fileCategory(f))}
          </span>
          {renamingThis ? (
            <input
              ref={treeEditorInputRef}
              className="df-tree-rename-input"
              value={treeEditor?.draft ?? ''}
              disabled={treeEditor?.saving}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setTreeEditor((curr) => (curr ? { ...curr, draft: event.target.value } : curr))
              }
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') void commitTreeEditor();
                if (event.key === 'Escape') setTreeEditor(null);
              }}
              onBlur={() => {
                if (treeEditor && !treeEditor.saving) void commitTreeEditor();
              }}
            />
          ) : (
            <span className="df-tree-name" title={f.name}>{base}</span>
          )}
          <span className="df-row-time">{relativeTime(f.mtime, t)}</span>
        </div>,
      );
    }
    return rows;
  }

  const fileActions = (
    <div className="df-actions">
      <button
        type="button"
        data-testid="df-view-mode-toggle"
        onClick={toggleViewMode}
        title={viewMode === 'tree' ? t('designFiles.viewList') : t('designFiles.viewTree')}
      >
        <Icon name={viewMode === 'tree' ? 'grid' : 'fork'} size={13} />
        <span>{viewMode === 'tree' ? t('designFiles.viewList') : t('designFiles.viewTree')}</span>
      </button>
      {onOpenContentSearch ? (
        <button
          type="button"
          data-testid="df-content-search"
          onClick={onOpenContentSearch}
          title={t('projectSearch.buttonTitle')}
        >
          <Icon name="search" size={13} />
          <span>{t('projectSearch.buttonLabel')}</span>
        </button>
      ) : null}
      {onCreateFolder ? (
        <button
          type="button"
          data-testid="design-files-new-folder"
          onClick={() => {
                        setCreatingFolder({ draft: '', saving: false });
          }}
          title={t('designFiles.newFolderTitle')}
        >
          <Icon name="folder" size={13} />
          <span>{t('designFiles.newFolderTitle')}</span>
        </button>
      ) : null}
      <button type="button" onClick={onPaste} title={t('designFiles.paste.title')}>
        <Icon name="file" size={13} />
        <span>{t('designFiles.paste.label')}</span>
      </button>
      <button
        type="button"
        data-testid="design-files-upload-trigger"
        onClick={onUpload}
        title={t('designFiles.upload.title')}
      >
        <Icon name="upload" size={13} />
        <span>{t('designFiles.upload.label')}</span>
      </button>
      {onDuplicateProject ? (
        <div className="df-project-menu-anchor" ref={projectMenuRef}>
          <button
            type="button"
            className="df-project-menu-trigger"
            aria-label={t('designFiles.projectMenu')}
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            title={t('designFiles.projectMenu')}
            onClick={() => setProjectMenuOpen((current) => !current)}
          >
            <Icon name="more-horizontal" size={14} />
          </button>
          {projectMenuOpen ? (
            <div className="df-project-menu" role="menu">
              {onDuplicateProject ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={duplicateProjectBusy}
                  onClick={() => {
                                        setProjectMenuOpen(false);
                    onDuplicateProject();
                  }}
                >
                  <Icon name={duplicateProjectBusy ? 'spinner' : 'copy'} size={13} />
                  <span>{t('designFiles.duplicateProject')}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const breadcrumbs = (
    <nav className="df-breadcrumbs" aria-label={t('designFiles.crumbs')}>
      {currentDir === '' ? (
        <span className="df-breadcrumb-current">
          {rootDirName ?? t('designFiles.crumbs')}
        </span>
      ) : (
        <button
          type="button"
          className="df-breadcrumb-btn"
          onClick={() => setCurrentDir('')}
        >
          {rootDirName ?? t('designFiles.crumbs')}
        </button>
      )}
      {currentDir.split('/').filter(Boolean).map((segment, idx, parts) => {
        const path = parts.slice(0, idx + 1).join('/');
        const isLast = idx === parts.length - 1;
        return (
          <span key={path} className="df-breadcrumb-segment">
            <span className="df-breadcrumb-sep" aria-hidden>/</span>
            {isLast ? (
              <span className="df-breadcrumb-current">{segment}</span>
            ) : (
              <button
                type="button"
                className="df-breadcrumb-btn"
                onClick={() => setCurrentDir(path)}
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );

  const visibleUploadError = uploadError ?? dropReadError;
  const hasSelection = selected.size > 0;

  return (
    <div
      ref={panelRef}
      className={`df-panel ${previewFile ? '' : 'no-preview'} ${hasSelection ? 'has-selection' : ''}`}
    >
      {reloading ? (
        <div className="df-reloading-overlay" data-testid="design-files-reloading">
          <span className="loading-spinner">
            <Icon name="spinner" size={16} />
            <span className="loading-spinner-label">{t('common.loading')}</span>
          </span>
        </div>
      ) : null}
      <div className="df-main">
        <div className="df-topbar">
          <div className="df-topbar-left">
            {viewMode === 'tree' ? (
              <nav className="df-breadcrumbs" aria-label={t('designFiles.crumbs')}>
                <span className="df-breadcrumb-current">
                  {rootDirName ?? t('designFiles.crumbs')}
                </span>
              </nav>
            ) : (
              breadcrumbs
            )}
          </div>
          <div className="df-topbar-right">{fileActions}</div>
        </div>
        <div
          className="df-body"
          onDragEnter={(ev) => {
            ev.preventDefault();
            dragDepthRef.current += 1;
            setDraggingFiles(true);
          }}
          onDragOver={(ev) => {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={(ev) => {
            if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) {
              dragDepthRef.current = 0;
              setDraggingFiles(false);
              return;
            }
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDraggingFiles(false);
          }}
          onDrop={handleDrop}
        >
          {visibleUploadError && !preview ? (
            <div className="df-upload-banner" data-testid="upload-error-banner">
              <span>{visibleUploadError}</span>
              {onClearUploadError || dropReadError ? (
                <button
                  type="button"
                  data-testid="upload-error-dismiss"
                  onClick={() => {
                    setDropReadError(null);
                    onClearUploadError?.();
                  }}
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          ) : null}
          {hasSelection ? (
            <div className="df-batch-bar" data-testid="design-files-batch-bar">
              <span className="df-batch-count">
                {t('designFiles.downloadSelected', { n: selected.size })}
              </span>
              <div className="df-batch-actions">
                <button
                  type="button"
                  onClick={() => {
                                        void handleBatchDownload();
                  }}
                  title={t('designFiles.downloadSelected', { n: selected.size })}
                >
                  <Icon name="download" size={13} />
                  <span>{t('designFiles.download')}</span>
                </button>
                <button
                  type="button"
                  data-testid="design-files-batch-move"
                  onClick={() => openMoveDialog([...selected])}
                  title={t('designFiles.moveTitle')}
                >
                  <Icon name="folder" size={13} />
                  <span>{t('designFiles.move')}</span>
                </button>
                <button
                  type="button"
                  className="danger"
                  data-testid="design-files-batch-delete"
                  disabled={deleting}
                  onClick={() => void handleBatchDelete()}
                  title={t('designFiles.deleteSelected', { n: selected.size })}
                >
                  <span>{t('designFiles.delete')}</span>
                </button>
                <button type="button" className="df-batch-clear" onClick={clearSelection}>
                  {t('designFiles.clearSelection')}
                </button>
              </div>
            </div>
          ) : null}
          {creatingFolder ? (
            <div className="df-section" key="new-folder">
              <div className="df-section-label">{t('designFiles.newFolderTitle')}</div>
              <div className="df-row df-dir-row" data-testid="design-files-new-folder-row">
                <span className="df-row-check" aria-hidden />
                <span className="df-row-icon" data-kind="folder" aria-hidden>
                  <Icon name="folder" size={14} />
                </span>
                <div className="df-row-name-wrap">
                  <input
                    autoFocus
                    className="df-rename-input"
                    data-testid="design-files-new-folder-input"
                    placeholder={t('designFiles.newFolderLabel')}
                    value={creatingFolder.draft}
                    disabled={creatingFolder.saving}
                    onChange={(e) =>
                      setCreatingFolder({ draft: e.target.value, saving: false })
                    }
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      if (e.currentTarget.dataset.skipCommit === '1') return;
                      void commitCreateFolder();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.dataset.skipCommit = '1';
                        void commitCreateFolder();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.currentTarget.dataset.skipCommit = '1';
                        setCreatingFolder(null);
                      }
                    }}
                  />
                </div>
                <span className="df-row-size" />
                <span className="df-row-time" />
                <span className="df-row-menu df-row-menu-placeholder" aria-hidden />
              </div>
            </div>
          ) : null}
          {files.length === 0 && (folders?.length ?? 0) === 0 && !creatingFolder && !filePaging?.error && !filePaging?.hasMore ? (
            <div className="df-empty" data-testid="design-files-empty">
              <div className="df-empty-pill">
                <span className="df-empty-title">
                  {t('designFiles.empty')}
                </span>
                <div className="df-empty-actions">
                  {onOpenBrowser ? (
                    <button
                      type="button"
                      className="df-empty-cta df-empty-cta-secondary"
                      data-testid="design-files-empty-open-browser"
                      onClick={onOpenBrowser}
                      aria-label={t('workspace.newBrowserDescription')}
                      title={t('workspace.newBrowserDescription')}
                    >
                      <Icon name="globe" size={13} />
                      <span>{t('workspace.newBrowser')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="df-empty-cta df-empty-cta-tertiary"
                    data-testid="design-files-empty-create-document"
                    onClick={onPaste}
                    title={t('designFiles.paste.title')}
                  >
                    <Icon name="file" size={13} />
                    <span>{t('designFiles.paste.label')}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : viewMode === 'tree' ? (
            <div
              ref={treeContainerRef}
              className={`df-tree${treeDropTarget === '' ? ' is-drop-target' : ''}`}
              data-testid="design-files-tree"
              role="tree"
              tabIndex={0}
              onKeyDown={handleTreeKeyDown}
              onContextMenu={(event) => {
                // Row handlers stopPropagation; reaching here = empty area.
                openTreeMenu(event, { kind: 'root', path: '' });
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('application/x-od-tree-entry')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setTreeDropTarget('');
              }}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) {
                  setTreeDropTarget((curr) => (curr === '' ? null : curr));
                }
              }}
              onDrop={(event) => {
                const payload = treeDragPayload(event);
                setTreeDropTarget(null);
                if (!payload) return;
                event.preventDefault();
                void commitTreeMove(payload, '');
              }}
            >
              {treeEditor &&
              (treeEditor.mode === 'new-file' || treeEditor.mode === 'new-dir') &&
              treeEditor.parent === ''
                ? treeEditorRow(0)
                : null}
              {renderTree(fileTree, 0)}
            </div>
          ) : (
            <>
              {dirsAtCurrentDir.some(dir => pageKeys.has(`dir:${dir}`)) ? (
                <div className="df-section" key="folders">
                  <div className="df-section-label">
                    {t('designFiles.sectionFolders')}
                    <span className="df-section-count">{dirsAtCurrentDir.length}</span>
                  </div>
                  {dirsAtCurrentDir.filter(dir => pageKeys.has(`dir:${dir}`)).map((d) => renderDirRow(d))}
                </div>
              ) : null}
              {sections.filter(([, entries]) => entries.some(file => pageKeys.has(`file:${file.name}`))).map(([category, sectionFiles]) => (
                <div className="df-section" key={`cat:${category}`}>
                  <div className="df-section-label">
                    {sectionLabel(category, t)}
                    <span className="df-section-count">{sectionFiles.length}</span>
                  </div>
                  {sectionFiles.filter(file => pageKeys.has(`file:${file.name}`)).map((f) => renderFileRow(f, category))}
                </div>
              ))}
            </>
          )}
          <div className={paginationStyles.footer} data-testid="design-files-paging-footer">
          {filePaging && (filePaging.hasMore || filePaging.error) ? (
            <div className={paginationStyles.pagination} data-testid="design-files-load-more">
              <span>{t('designFiles.loadedCount', { loaded: files.length, total: filePaging.total })}</span>
              <Button variant="ghost" disabled={filePaging.loading} onClick={() => void filePaging.loadMore()}>
                {filePaging.loading ? t('common.loading') : t('designFiles.loadMore')}
              </Button>
              {filePaging.error ? <span role="alert">{filePaging.error}</span> : null}
            </div>
          ) : null}
          {lastPage > 0 ? (
            <nav className={paginationStyles.pagination} data-testid="design-files-pagination">
              <Button size="icon" variant="ghost" aria-label={t('designFiles.previousPage')} title={t('designFiles.previousPage')}
                data-testid="design-files-previous-page" disabled={pageIndex === 0}
                onClick={() => setFilePage({ scope: pageScope, index: pageIndex - 1 })}>
                <Icon name="chevron-left" size={16} />
              </Button>
              <span aria-live="polite">{pageIndex * FILE_ROWS_PER_PAGE + 1}–{Math.min((pageIndex + 1) * FILE_ROWS_PER_PAGE, rowKeys.length)} / {rowKeys.length}</span>
              <Button size="icon" variant="ghost" aria-label={t('designFiles.nextPage')} title={t('designFiles.nextPage')}
                data-testid="design-files-next-page" disabled={pageIndex === lastPage}
                onClick={() => setFilePage({ scope: pageScope, index: pageIndex + 1 })}>
                <Icon name="chevron-right" size={16} />
              </Button>
            </nav>
          ) : null}
          </div>
          <div className="df-footer-info">
            {running ? (
              <RotatingTip />
            ) : (
              <div className="df-drop-hint">
                <span className="df-drop-hint-label">
                  <Icon name="upload" size={12} />
                  {t('designFiles.dropLabel')}
                </span>
                <span className="df-drop-hint-desc">{t('designFiles.dropDesc')}</span>
              </div>
            )}
          </div>
        </div>
        {draggingFiles ? (
          <div className="df-drop-overlay" aria-hidden>
            <div className="df-drop-overlay-card">
              <Icon name="upload" size={22} />
              <span className="label">{t('designFiles.dropTitle')}</span>
              <span className="desc">{t('designFiles.dropDesc')}</span>
            </div>
          </div>
        ) : null}
      </div>
      {preview && previewFile ? (
        // Key on the file name so React unmounts the previous DfPreview
        // (and its iframe / image element) when the user clicks a
        // different file. Without this, React diffing reuses the same
        // iframe DOM node and the browser keeps showing the first
        // file's contents — only the `src` prop changes but the iframe
        // never actually navigates.
        <DfPreview
          key={previewFile.name}
          projectId={projectId}
          file={previewFile}
          onOpen={() => onOpenFile(previewFile.name)}
          onClose={() => setPreview(null)}
        />
      ) : null}
      {/* Row popovers and the move dialog are position:fixed with viewport
          coordinates. In focus mode `.split.split-focus .workspace` gets
          `contain: layout paint`, which turns the workspace into their
          containing block and paint-clips them — the menu would render
          off-screen. Portal to <body> so fixed really means the viewport. */}
      {menuPos ? createPortal(
        <div
          data-testid="design-file-menu-popover"
          className="df-row-popover"
          style={{ top: menuPos.top, left: menuPos.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const name = menuPos.name;
              setMenuPos(null);
              onOpenFile(name);
            }}
          >
            {t('designFiles.openInTab')}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              startRename(menuPos.name);
            }}
          >
            {t('common.rename')}
          </button>
          <button
            type="button"
            data-testid={`design-file-move-${menuPos.name}`}
            onClick={(e) => {
              e.stopPropagation();
              openMoveDialog([menuPos.name]);
            }}
          >
            {t('designFiles.moveTitle')}
          </button>
          <button
            type="button"
            disabled={!files.some((file) => file.name === menuPos.name && file.localPath)}
            onClick={(e) => {
              e.stopPropagation();
              const name = menuPos.name;
              setMenuPos(null);
              void copyLocalPath(name);
            }}
          >
            {copiedLocalPath === menuPos.name
              ? t('designFiles.copiedLocalPath')
              : t('designFiles.copyLocalPath')}
          </button>
          <a
            href={projectDownloadUrl(projectId, menuPos.name)}
            download={menuPos.name}
            style={{ textDecoration: 'none' }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuPos(null);
              }}
            >
              {t('designFiles.download')}
            </button>
          </a>
          <button
            type="button"
            className="danger"
            data-testid={`design-file-delete-${menuPos.name}`}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const name = menuPos.name;
              setMenuPos(null);
              onDeleteFile(name);
            }}
          >
            {t('designFiles.delete')}
          </button>
        </div>,
        document.body,
      ) : null}
      {dirMenuPos ? createPortal(
        <div
          data-testid="design-dir-menu-popover"
          className="df-row-popover"
          style={{ top: dirMenuPos.top, left: dirMenuPos.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {onRenameFolder ? (
            <button
              type="button"
              data-testid={`design-dir-rename-${dirMenuPos.path}`}
              onClick={(e) => {
                e.stopPropagation();
                startDirRename(dirMenuPos.path);
              }}
            >
              {t('common.rename')}
            </button>
          ) : null}
          {onDeleteFolder ? (
            <button
              type="button"
              className="danger"
              data-testid={`design-dir-delete-${dirMenuPos.path}`}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                void handleDeleteDir(dirMenuPos.path);
              }}
            >
              {t('designFiles.delete')}
            </button>
          ) : null}
        </div>,
        document.body,
      ) : null}
      {treeMenu ? createPortal(
        <div
          data-testid="design-tree-menu-popover"
          className="df-row-popover"
          style={{ top: treeMenu.top, left: treeMenu.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {treeMenu.kind !== 'file' && onCreateFile ? (
            <button
              type="button"
              data-testid="design-tree-new-file"
              onClick={() => startTreeCreate('new-file', treeMenu.path)}
            >
              {t('designFiles.treeNewFile')}
            </button>
          ) : null}
          {treeMenu.kind !== 'file' && onCreateFolder ? (
            <button
              type="button"
              data-testid="design-tree-new-folder"
              onClick={() => startTreeCreate('new-dir', treeMenu.path)}
            >
              {t('designFiles.newFolderTitle')}
            </button>
          ) : null}
          {treeMenu.kind === 'file' ? (
            <button
              type="button"
              onClick={() => {
                const path = treeMenu.path;
                setTreeMenu(null);
                onOpenFile(path);
              }}
            >
              {t('designFiles.openInTab')}
            </button>
          ) : null}
          {treeMenu.kind !== 'root' ? (
            <button
              type="button"
              data-testid="design-tree-rename"
              onClick={() => startTreeRename({ kind: treeMenu.kind as 'file' | 'dir', path: treeMenu.path })}
            >
              {t('common.rename')}
            </button>
          ) : null}
          {treeMenu.kind !== 'root' ? (
            <button
              type="button"
              onClick={() => {
                const path = treeMenu.path;
                setTreeMenu(null);
                void copyToClipboard(path);
              }}
            >
              {t('designFiles.copyPath')}
            </button>
          ) : null}
          {treeMenu.kind === 'file' ? (
            <a
              href={projectDownloadUrl(projectId, treeMenu.path)}
              download={treeMenu.path}
              style={{ textDecoration: 'none' }}
            >
              <button type="button" onClick={() => setTreeMenu(null)}>
                {t('designFiles.download')}
              </button>
            </a>
          ) : null}
          {treeMenu.kind !== 'root' ? (
            <button
              type="button"
              className="danger"
              data-testid="design-tree-delete"
              onClick={() => {
                const target = treeMenu;
                setTreeMenu(null);
                if (target.kind === 'file') onDeleteFile(target.path);
                else void onDeleteFolder?.(target.path);
              }}
            >
              {t('designFiles.delete')}
            </button>
          ) : null}
        </div>,
        document.body,
      ) : null}
      {moveDialog ? createPortal(
        <div
          className="df-move-overlay"
          data-testid="design-files-move-dialog"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !moveDialog.saving) setMoveDialog(null);
          }}
        >
          <div className="df-move-card" role="dialog" aria-label={t('designFiles.moveTitle')}>
            <div className="df-move-title">{t('designFiles.moveTitle')}</div>
            <div className="df-move-files">
              {moveDialog.names.length === 1
                ? moveDialog.names[0]
                : t('designFiles.folderCount', { n: moveDialog.names.length })}
            </div>
            <label className="df-move-label">
              <span>{t('designFiles.moveLabel')}</span>
              <select
                data-testid="design-files-move-dest"
                value={moveDialog.dest}
                disabled={moveDialog.saving}
                onChange={(e) =>
                  setMoveDialog({ ...moveDialog, dest: e.target.value, error: null })
                }
              >
                <option value="">{t('designFiles.moveRoot')}</option>
                {allFolderPaths.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                {onCreateFolder ? (
                  <option value="__new__">{t('designFiles.moveNewFolder')}</option>
                ) : null}
              </select>
            </label>
            {moveDialog.dest === '__new__' ? (
              <label className="df-move-label">
                <span>{t('designFiles.newFolderLabel')}</span>
                <input
                  autoFocus
                  data-testid="design-files-move-new-folder"
                  value={moveDialog.newFolder}
                  disabled={moveDialog.saving}
                  placeholder={t('designFiles.newFolderLabel')}
                  onChange={(e) =>
                    setMoveDialog({ ...moveDialog, newFolder: e.target.value, error: null })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitMove();
                    }
                  }}
                />
              </label>
            ) : null}
            {moveDialog.error ? <div className="df-move-error">{moveDialog.error}</div> : null}
            <div className="df-move-actions">
              <button
                type="button"
                disabled={moveDialog.saving}
                onClick={() => setMoveDialog(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="df-move-confirm"
                data-testid="design-files-move-confirm"
                disabled={moveDialog.saving}
                onClick={() => void commitMove()}
              >
                {moveDialog.saving ? <Icon name="spinner" size={12} /> : null}
                <span>{t('designFiles.move')}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function DfPreview({
  projectId,
  file,
  onOpen,
  onClose,
}: {
  projectId: string;
  file: ProjectFile;
  onOpen: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const url = projectFileUrl(projectId, file.name);
  const openPreviewLabel = `${t('designFiles.previewOpen')} ${file.name}`;
  const thumbCanOpen = file.kind !== 'audio' && file.kind !== 'video';
  return (
    <aside className="df-preview">
      <button
        type="button"
        className="df-preview-close"
        onClick={onClose}
        title={t('designFiles.previewClose')}
        aria-label={t('designFiles.previewClose')}
      >
        <Icon name="close" size={13} />
      </button>
      <div className={`df-preview-thumb${thumbCanOpen ? ' is-openable' : ''}`}>
        {file.kind === 'image' ? (
          <img src={`${url}?v=${Math.round(file.mtime)}`} alt={file.name} />
        ) : file.kind === 'html' ? (
          <HtmlPreviewThumbnail projectId={projectId} file={file} />
        ) : file.kind === 'video' ? (
          <video
            src={`${url}?v=${Math.round(file.mtime)}`}
            controls
            playsInline
            preload="metadata"
          />
        ) : file.kind === 'audio' ? (
          <audio src={`${url}?v=${Math.round(file.mtime)}`} controls preload="metadata" />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              fontSize: 38,
            }}
          >
            {categoryGlyph(fileCategory(file))}
          </div>
        )}
        {thumbCanOpen ? (
          <button
            type="button"
            className="df-preview-thumb-open"
            onClick={onOpen}
            title={openPreviewLabel}
            aria-label={openPreviewLabel}
          />
        ) : null}
      </div>
      <div className="df-preview-meta" data-testid="design-file-preview">
        <button type="button" className="df-preview-open-cta" onClick={onOpen}>
          <Icon name="eye" size={14} />
          <span>{t('designFiles.previewOpen')}</span>
        </button>
        <div className="df-preview-name">{file.name}</div>
        <div className="df-preview-kind">{categoryLabel(fileCategory(file), t)}</div>
        <div className="df-preview-stats">
          {t('designFiles.modifiedExt', {
            time: relativeTime(file.mtime, t),
            size: humanBytes(file.size),
            ext: fileExtensionLabel(file.name),
          })}
        </div>
        <a className="df-preview-download" href={projectDownloadUrl(projectId, file.name)} download={file.name}>
          <Icon name="download" size={13} />
          <span>{t('designFiles.download')}</span>
        </a>
      </div>
    </aside>
  );
}

function HtmlPreviewThumbnail({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const url = projectFileUrl(projectId, file.name);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${url}?v=${Math.round(file.mtime)}`)
      .then((response) => (response.ok ? response.text() : null))
      .then((html) => {
        if (cancelled || html === null) return;
        setSrcDoc(buildSrcdoc(html, { baseHref: projectRawUrl(projectId, baseDirForFile(file.name)) }));
      })
      .catch(() => {
        if (!cancelled) setSrcDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file.mtime, file.name, projectId, url]);

  return (
    <iframe
      title={file.name}
      src={srcDoc ? undefined : url}
      srcDoc={srcDoc ?? undefined}
      sandbox="allow-scripts allow-downloads"
    />
  );
}

function baseDirForFile(name: string): string {
  const index = name.lastIndexOf('/');
  return index >= 0 ? name.slice(0, index + 1) : '';
}

function fileExtensionLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toUpperCase();
}

// Plural section header for a category. Reuses existing plural labels where a
// dedicated one exists; otherwise falls back to the singular type label so
// each category gets a distinct, readable header.
function sectionLabel(category: FileCategory, t: TranslateFn): string {
  switch (category) {
    case 'html':
      return t('designFiles.sectionPages');
    case 'stylesheet':
      return t('designFiles.sectionStylesheets');
    case 'code':
      return t('designFiles.sectionScripts');
    case 'document':
      return t('designFiles.sectionDocuments');
    case 'image':
      return t('designFiles.sectionImages');
    case 'binary':
      return t('designFiles.sectionOther');
    default:
      return categoryLabel(category, t);
  }
}

// Singular row subtitle for a category.
function categoryLabel(category: FileCategory, t: TranslateFn): string {
  if (category === 'stylesheet') return t('designFiles.kindStylesheet');
  return kindLabel(category, t);
}

function categoryGlyph(category: FileCategory): string {
  if (category === 'stylesheet') return '#';
  return kindGlyph(category);
}

function filesFromClipboardData(clipboardData: DataTransfer | null): File[] {
  const files = Array.from(clipboardData?.files ?? []);
  if (files.length > 0) return files.map(normalizePastedFile);
  const items = Array.from(clipboardData?.items ?? []);
  return items
    .filter((item) => item.kind === 'file')
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [normalizePastedFile(file)] : [];
    });
}

function normalizePastedFile(file: File): File {
  if (file.name.trim()) return file;
  const extension = extensionForMimeType(file.type);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new File([file], `pasted-${stamp}${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/svg+xml') return '.svg';
  if (mimeType === 'text/html') return '.html';
  if (mimeType === 'text/plain') return '.txt';
  return '';
}

function shouldIgnoreClipboardFilePaste(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[contenteditable="true"]')) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const fallbackFiles = Array.from(dataTransfer.files ?? []);
  if (items.length === 0) return fallbackFiles;

  const results = await Promise.allSettled(items.map(filesFromDataTransferItem));
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) {
    if (fallbackFiles.length > 0) return fallbackFiles;
    throw rejected.reason;
  }
  const files = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  return files.length > 0 ? files : fallbackFiles;
}

async function filesFromDataTransferItem(item: DataTransferItem): Promise<File[]> {
  const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.();
  if (!entry) {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  }
  return filesFromFileSystemEntry(entry);
}

async function filesFromFileSystemEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) return [await fileFromEntry(entry as FileSystemFileEntryWithFile)];
  if (!entry.isDirectory) return [];

  const reader = (entry as FileSystemEntryWithReader).createReader?.();
  if (!reader) return [];

  const files: File[] = [];
  for (;;) {
    const entries = await readEntryBatch(reader);
    if (entries.length === 0) break;
    const nested = await Promise.all(entries.map(filesFromFileSystemEntry));
    files.push(...nested.flat());
  }
  return files;
}

function fileFromEntry(entry: FileSystemFileEntryWithFile): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, (error) => {
      reject(createFileSystemReadError('Could not read dropped file', error));
    });
  });
}

function readEntryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, (error) => {
      reject(createFileSystemReadError('Could not read dropped folder', error));
    });
  });
}

function kindGlyph(kind: ProjectFileKind): string {
  if (kind === 'html') return '⟨⟩';
  if (kind === 'image') return '▣';
  if (kind === 'workflow') return '⌥';
  if (kind === 'text') return '¶';
  if (kind === 'code') return '{}';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'document') return 'DOC';
  if (kind === 'presentation') return 'PPT';
  if (kind === 'spreadsheet') return 'XLS';
  return '·';
}

function kindLabel(kind: ProjectFileKind, t: TranslateFn): string {
  if (kind === 'html') return t('designFiles.kindHtml');
  if (kind === 'image') return t('designFiles.kindImage');
  if (kind === 'workflow') return t('designFiles.kindWorkflow');
  if (kind === 'text') return t('designFiles.kindText');
  if (kind === 'code') return t('designFiles.kindCode');
  if (kind === 'pdf') return t('designFiles.kindPdf');
  if (kind === 'document') return t('designFiles.kindDocument');
  if (kind === 'presentation') return t('designFiles.kindPresentation');
  if (kind === 'spreadsheet') return t('designFiles.kindSpreadsheet');
  return t('designFiles.kindBinary');
}

function relativeTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.justNow');
  if (diff < hr) return t('common.minutesAgo', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursAgo', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.floor(diff / day) });
  if (diff < 30 * day)
    return t('designFiles.weeksAgo', { n: Math.floor(diff / (7 * day)) });
  return new Date(ts).toLocaleDateString();
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
