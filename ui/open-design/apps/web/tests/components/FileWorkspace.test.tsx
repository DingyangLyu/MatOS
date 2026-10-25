// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESIGN_FILES_TAB,
  FileWorkspace,
  scrollWorkspaceTabsWithWheel,
} from '../../src/components/FileWorkspace';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { projectSplitClassName, projectSplitStyle } from '../../src/components/ProjectView';
import {
  fetchProjectFileText,
  fetchProjectFileMetadata,
  fetchProjectFiles,
  uploadProjectFiles,
  writeProjectTextFile,
  fetchProjectFolders,
} from '../../src/providers/registry';
import type { ChatMessage, ProjectFile, ProjectFolder } from '../../src/types';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchProjectFileText: vi.fn(),
    fetchProjectFileMetadata: vi.fn(),
    fetchProjectFiles: vi.fn(),
    uploadProjectFiles: vi.fn(),
    writeProjectBase64File: vi.fn(),
    writeProjectTextFile: vi.fn(),
    fetchProjectFolders: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../src/components/DesignBrowserPanel', () => ({
  DesignBrowserPanel: ({
    initialIconUrl,
    initialTitle,
    initialUrl,
    navigateRequest,
    onPageSnapshotToast,
  }: {
    initialIconUrl?: string;
    initialTitle?: string;
    initialUrl?: string;
    navigateRequest?: { url: string; nonce: number };
    onPageSnapshotToast?: (event: {
      actionFileName?: string;
      actionLabel?: string;
      actionTarget?: 'design-files' | 'file';
      elapsedSeconds?: number;
      message: string;
      status: 'loading' | 'success' | 'error' | 'canceled';
      tabId: string;
      ttlMs?: number;
    }) => void;
  }) => (
    <div
      data-testid="design-browser-panel"
      data-initial-icon-url={initialIconUrl ?? ''}
      data-initial-title={initialTitle ?? ''}
      data-initial-url={initialUrl ?? ''}
      data-navigate-url={navigateRequest?.url ?? ''}
      data-navigate-nonce={navigateRequest?.nonce ?? ''}
    >
      <button
        type="button"
        data-testid="emit-browser-snapshot-success"
        onClick={() => onPageSnapshotToast?.({
          actionFileName: 'browser-archive/example/manifest.json',
          actionLabel: 'View Design Files',
          actionTarget: 'design-files',
          elapsedSeconds: 0,
          message: 'Saved page snapshot (HTML + CSS).',
          status: 'success',
          tabId: '__browser__:1',
          ttlMs: 8000,
        })}
      >
        emit snapshot success
      </button>
    </div>
  ),
  labelFromUrl: (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '') || url;
    } catch {
      return url;
    }
  },
  normalizeBrowserAddress: (rawAddress: string) => {
    const value = rawAddress.trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (/^[\w.-]+\.[a-z]{2,}/i.test(value)) return `https://${value}`;
    return value || 'about:blank';
  },
}));

vi.mock('../../src/components/workspace/TerminalViewer', () => ({
  TerminalViewer: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-viewer">{terminalId}</div>
  ),
}));

const { createTerminalMock, killTerminalMock } = vi.hoisted(() => ({
  createTerminalMock: vi.fn(),
  killTerminalMock: vi.fn(),
}));
vi.mock('../../src/state/projects', () => ({
  createTerminal: createTerminalMock,
  killTerminal: killTerminalMock,
}));

const { excalidrawWorkspaceMock } = vi.hoisted(() => ({
  excalidrawWorkspaceMock: {
    lastProps: null as Record<string, any> | null,
  },
}));

vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react');
  const MainMenu = Object.assign(
    (props: Record<string, any>) => React.createElement('div', null, props.children),
    {
      Item: ({ children, disabled, icon, onClick, ...rest }: Record<string, any>) => React.createElement(
        'button',
        {
          ...rest,
          type: 'button',
          disabled,
          onClick,
        },
        icon,
        children,
      ),
      DefaultItems: {
        SearchMenu: () => null,
        Help: () => null,
        ClearCanvas: () => null,
        ChangeCanvasBackground: () => null,
      },
      Separator: () => null,
    },
  );
  return {
    Excalidraw: (props: Record<string, any>) => {
      excalidrawWorkspaceMock.lastProps = props;
      React.useEffect(() => {
        props.excalidrawAPI?.({
          getSceneElementsIncludingDeleted: () => [{ id: 'workspace-element', type: 'freedraw', isDeleted: false }],
          getAppState: () => ({ viewBackgroundColor: '#ffffff' }),
          getFiles: () => ({}),
          updateScene: vi.fn(),
          setOpenDialog: vi.fn(),
        });
      }, [props]);
      return React.createElement(
        'div',
        { 'data-testid': 'excalidraw' },
        React.createElement('canvas'),
        props.renderTopRightUI?.(false, {}),
        props.children,
      );
    },
    MainMenu,
    convertToExcalidrawElements: vi.fn((elements: unknown[]) => elements),
    exportToBlob: vi.fn(async () => new Blob(['mock image'], { type: 'image/png' })),
  };
});

// Records the `folders` prop DesignFilesPanel receives on EVERY render (still
// renders the real component). Lets a test observe the first render after a
// project switch — the pre-paint frame RTL's post-rerender DOM assertion can't
// see — to prove no stale folders ever reach the new panel.
const { designFilesPanelRenders } = vi.hoisted(() => ({
  designFilesPanelRenders: [] as { projectId: string; folderCount: number }[],
}));
vi.mock('../../src/components/DesignFilesPanel', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/DesignFilesPanel')>(
    '../../src/components/DesignFilesPanel',
  );
  const Real = actual.DesignFilesPanel;
  return {
    ...actual,
    DesignFilesPanel: (props: Parameters<typeof Real>[0]) => {
      designFilesPanelRenders.push({
        projectId: props.projectId,
        folderCount: props.folders?.length ?? 0,
      });
      return <Real {...props} />;
    },
  };
});

const mockedFetchProjectFileText = vi.mocked(fetchProjectFileText);
const labModule = vi.hoisted(() => ({ imports: 0, mounts: vi.fn(), disposes: vi.fn() }));

const mockedUploadProjectFiles = vi.mocked(uploadProjectFiles);
const mockedWriteProjectTextFile = vi.mocked(writeProjectTextFile);
const chatCss = readFileSync(join(process.cwd(), 'src/styles/chat.css'), 'utf8');
const routinesCss = readFileSync(join(process.cwd(), 'src/styles/viewer/routines.css'), 'utf8');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let composerCssStyle: HTMLStyleElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

beforeEach(() => {
  mockedFetchProjectFileText.mockResolvedValue('');
  createTerminalMock.mockResolvedValue({
    id: 'term-new',
    projectId: 'project-1',
    cwd: '/tmp/open-design/project-1',
    shell: '/bin/bash',
    cols: 80,
    rows: 24,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    exitCode: null,
    signal: null,
  });
});

afterEach(() => {
  cleanup();
  excalidrawWorkspaceMock.lastProps = null;
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.classList.remove('od-quick-switcher-open');
  document.querySelectorAll('.chat-composer-fixed-layer').forEach((node) => node.remove());
  composerCssStyle?.remove();
  composerCssStyle = null;
  host?.remove();
  host = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function baseFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'mock.png',
    path: 'mock.png',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'image',
    mime: 'image/png',
    ...overrides,
  };
}

function workspaceFile(name: string): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 100,
    mtime: 1700000000,
    kind: name.endsWith('.html') ? 'html' : 'text',
    mime: name.endsWith('.html') ? 'text/html' : 'text/plain',
  };
}

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function installComposerIsolationCss() {
  const rules = [
    ['.chat-composer-fixed-layer', chatCss],
    ['.chat-composer-fixed-layer .composer', chatCss],
    ['.composer-input-wrap', chatCss],
    ['.composer-input-wrap:focus-within', chatCss],
    ['.composer-input-editor .composer-editable', chatCss],
    ['.composer-input-placeholder', chatCss],
    ['.chat-composer-fixed-layer .composer-shell', routinesCss],
    ['.chat-composer-fixed-layer .composer.drag-active .composer-shell', routinesCss],
    ['.chat-composer-fixed-layer .composer-input-wrap', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-shell', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer.drag-active .composer-shell', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-input-wrap', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-input-wrap:focus-within', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-input-editor .composer-editable', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-input-placeholder', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-context-row', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-context-picker--design-system .project-ds-picker-trigger', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-chip', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-context', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-order', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-comment button', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-name', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-comment .staged-name strong', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-comment .staged-name span', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-context .staged-icon', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-chip .staged-icon', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .staged-chip .staged-remove', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-active-file', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-row .icon-btn', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-row .session-mode-toggle__trigger', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-row .avatar-agent-trigger', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-row .avatar-btn', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-send', routinesCss],
    ['body.od-quick-switcher-open .chat-composer-fixed-layer .composer-send:disabled', routinesCss],
  ] as const;
  composerCssStyle = document.createElement('style');
  composerCssStyle.textContent = rules
    .map(([selector, css]) => `${selector} {${cssDeclarations(css, selector)}}`)
    .join('\n');
  document.head.appendChild(composerCssStyle);
}

function renderWorkspace(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(element);
  });
  return host;
}

function getTabByName(container: HTMLElement, name: RegExp): HTMLElement {
  const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
  const tab = tabs.find((node) => name.test(node.textContent ?? ''));
  if (!tab) throw new Error(`Could not find tab matching ${name}`);
  return tab;
}

function renderedTabLabels(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent?.trim() ?? '');
}

function createDragDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    getData: vi.fn((type: string) => store.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
  };
}

function dispatchDragEvent(
  target: HTMLElement,
  type: string,
  dataTransfer = createDragDataTransfer(),
  clientX = 0,
  relatedTarget: EventTarget | null = null,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return dataTransfer;
}

function stubTabRect(tab: HTMLElement, left = 0, width = 100) {
  tab.getBoundingClientRect = vi.fn(() => ({
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 20,
    width,
    height: 20,
    toJSON: () => ({}),
  }));
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderDesignFilesPanel(overrides: Partial<React.ComponentProps<typeof DesignFilesPanel>> = {}) {
  const props: React.ComponentProps<typeof DesignFilesPanel> = {
    projectId: 'project-1',
    files: [],
    onRefreshFiles: vi.fn(),
    onOpenFile: vi.fn(),
    onRenameFile: vi.fn(),
    onDeleteFile: vi.fn(),
    onDeleteFiles: vi.fn(),
    onUpload: vi.fn(),
    onUploadFiles: vi.fn(),
    onPaste: vi.fn(),
    ...overrides,
  };
  return render(<DesignFilesPanel {...props} />);
}

describe('FileWorkspace partial file index', () => {
  const paging = () => ({ total: 10000, hasMore: true, loading: false, error: null, loadMore: vi.fn().mockResolvedValue(undefined) });
  it('uses the complete index and create-only CAS when choosing a new document name', async () => {
    vi.mocked(fetchProjectFiles).mockResolvedValue([baseFile({ name: 'document.md', path: 'document.md' })]);
    mockedWriteProjectTextFile.mockResolvedValue(null);
    render(<FileWorkspace projectId="project-1" projectKind="prototype" files={[]} filePaging={paging()}
      onRefreshFiles={vi.fn()} isDeck={false}
      tabsState={{ tabs: [], active: null }} onTabsStateChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create document' }));
    await waitFor(() => expect(mockedWriteProjectTextFile).toHaveBeenCalledWith(
      'project-1', 'document-2.md', expect.any(String), { expectedEtag: null },
    ));
  });
});

describe('FileWorkspace quick switcher visual isolation', () => {
  it('moves focus into quick search and marks the document while the overlay is open', async () => {
    installComposerIsolationCss();

    const composerLayer = document.createElement('div');
    composerLayer.className = 'chat-composer-fixed-layer';
    composerLayer.innerHTML = `
      <div class="composer drag-active">
        <div class="composer-shell">
          <div class="staged-row staged-context-row">
            <div class="staged-context-picker staged-context-picker--design-system">
              <button class="project-ds-picker-trigger picked" type="button">Choose design system</button>
            </div>
            <div class="staged-chip staged-context staged-context--workspace">
              <span class="staged-icon">F</span>
              <span class="staged-name">
                <span class="staged-context-kind">Current</span>manual-edit.html
              </span>
              <button class="staged-remove" type="button">x</button>
            </div>
            <div class="staged-chip staged-file">
              <span class="staged-order">1</span>
              <span class="staged-icon">F</span>
              <span class="staged-name">hero.png</span>
              <button class="staged-remove" type="button">x</button>
            </div>
            <div class="staged-chip staged-comment">
              <span class="staged-name"><strong>Hero</strong><span>Needs tweak</span></span>
              <button class="staged-remove" type="button">x</button>
            </div>
          </div>
          <div class="composer-active-file">
            <span class="composer-active-file__label">Current</span>
            <span class="composer-active-file__name">manual-edit.html</span>
          </div>
          <div class="composer-input-wrap">
            <div class="composer-input-editor">
              <div class="composer-editable" contenteditable="true" tabindex="0">Mock focused composer control</div>
              <div class="composer-input-placeholder">Describe what you want to generate...</div>
            </div>
          </div>
          <div class="composer-row">
            <button class="icon-btn" type="button">+</button>
            <button class="avatar-agent-trigger" type="button">
              <span class="avatar-btn">A</span>
            </button>
            <button class="session-mode-toggle__trigger" type="button">Design</button>
            <button class="composer-send" type="button" disabled>Send</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(composerLayer);

    const composer = composerLayer.querySelector<HTMLElement>('.composer');
    const composerShell = composerLayer.querySelector<HTMLElement>('.composer-shell');
    const composerInputWrap = composerLayer.querySelector<HTMLElement>('.composer-input-wrap');
    const composerControl = composerLayer.querySelector<HTMLElement>('.composer-editable');
    const composerPlaceholder = composerLayer.querySelector<HTMLElement>('.composer-input-placeholder');
    const designSystemTrigger = composerLayer.querySelector<HTMLElement>('.project-ds-picker-trigger');
    const stagedContext = composerLayer.querySelector<HTMLElement>('.staged-context');
    const stagedContextKind = composerLayer.querySelector<HTMLElement>('.staged-context-kind');
    const stagedIcon = composerLayer.querySelector<HTMLElement>('.staged-context .staged-icon');
    const stagedRemove = composerLayer.querySelector<HTMLElement>('.staged-context .staged-remove');
    const stagedFile = composerLayer.querySelector<HTMLElement>('.staged-file');
    const stagedOrder = composerLayer.querySelector<HTMLElement>('.staged-file .staged-order');
    const stagedFileIcon = composerLayer.querySelector<HTMLElement>('.staged-file > .staged-icon');
    const stagedFileRemove = composerLayer.querySelector<HTMLElement>('.staged-file > .staged-remove');
    const stagedFileName = composerLayer.querySelector<HTMLElement>('.staged-file .staged-name');
    const stagedComment = composerLayer.querySelector<HTMLElement>('.staged-comment');
    const stagedCommentButton = composerLayer.querySelector<HTMLElement>('.staged-comment button');
    const stagedCommentStrong = composerLayer.querySelector<HTMLElement>('.staged-comment .staged-name strong');
    const stagedCommentSpan = composerLayer.querySelector<HTMLElement>('.staged-comment .staged-name span');
    const activeFileChip = composerLayer.querySelector<HTMLElement>('.composer-active-file');
    const toolbarIcon = composerLayer.querySelector<HTMLElement>('.icon-btn');
    const toolbarAvatar = composerLayer.querySelector<HTMLElement>('.avatar-agent-trigger');
    const toolbarAvatarButton = composerLayer.querySelector<HTMLElement>('.avatar-btn');
    const toolbarMode = composerLayer.querySelector<HTMLElement>('.session-mode-toggle__trigger');
    const toolbarSend = composerLayer.querySelector<HTMLElement>('.composer-send');
    if (!composer) throw new Error('Missing mock composer');
    if (!composerShell) throw new Error('Missing mock composer shell');
    if (!composerInputWrap) throw new Error('Missing mock composer input wrapper');
    if (!composerControl) throw new Error('Missing mock composer control');
    if (!composerPlaceholder) throw new Error('Missing mock composer placeholder');
    if (!designSystemTrigger) throw new Error('Missing mock design-system trigger');
    if (!stagedContext) throw new Error('Missing mock staged context');
    if (!stagedContextKind) throw new Error('Missing mock staged context kind');
    if (!stagedIcon) throw new Error('Missing mock staged context icon');
    if (!stagedRemove) throw new Error('Missing mock staged context remove');
    if (!stagedFile) throw new Error('Missing mock staged file');
    if (!stagedOrder) throw new Error('Missing mock staged order');
    if (!stagedFileIcon) throw new Error('Missing mock staged file icon');
    if (!stagedFileRemove) throw new Error('Missing mock staged file remove');
    if (!stagedFileName) throw new Error('Missing mock staged file name');
    if (!stagedComment) throw new Error('Missing mock staged comment');
    if (!stagedCommentButton) throw new Error('Missing mock staged comment button');
    if (!stagedCommentStrong) throw new Error('Missing mock staged comment strong text');
    if (!stagedCommentSpan) throw new Error('Missing mock staged comment span text');
    if (!activeFileChip) throw new Error('Missing mock active file chip');
    if (!toolbarIcon) throw new Error('Missing mock toolbar icon');
    if (!toolbarAvatar) throw new Error('Missing mock toolbar avatar');
    if (!toolbarAvatarButton) throw new Error('Missing mock toolbar avatar button');
    if (!toolbarMode) throw new Error('Missing mock toolbar mode');
    if (!toolbarSend) throw new Error('Missing mock toolbar send');

    expect(getComputedStyle(composerLayer).pointerEvents).toBe('none');
    expect(getComputedStyle(composer).pointerEvents).toBe('auto');
    expect(getComputedStyle(composerControl).pointerEvents).toBe('auto');

    composerControl.focus();
    expect(document.activeElement).toBe(composerControl);

    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('index.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });

    await waitFor(() => {
      expect(document.body.classList.contains('od-quick-switcher-open')).toBe(true);
    });
    const quickSearchInput = screen.getByRole('textbox');
    await waitFor(() => {
      expect(document.activeElement).toBe(quickSearchInput);
    });
    await waitFor(() => {
      expect(getComputedStyle(composer).pointerEvents).toBe('none');
    });
    expect(getComputedStyle(composerLayer).pointerEvents).toBe('none');
    expect(getComputedStyle(composerLayer).opacity).toBe('0.58');
    expect(getComputedStyle(composerControl).pointerEvents).toBe('none');
    expect(getComputedStyle(composerShell).boxShadow).toBe('none');
    expect(getComputedStyle(composerShell).borderColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(composerInputWrap).background).toBe('var(--bg-fill-tertiary)');
    expect(getComputedStyle(composerInputWrap).borderColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(composerInputWrap).boxShadow).toBe('none');
    expect(getComputedStyle(composerControl).color).toBe('var(--text-muted)');
    expect(getComputedStyle(composerControl).caretColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(composerPlaceholder).color).toBe('color-mix(in srgb, var(--text-muted) 72%, transparent)');
    for (const toolbarControl of [
      designSystemTrigger,
      stagedContext,
      stagedIcon,
      stagedRemove,
      stagedFile,
      stagedOrder,
      stagedFileIcon,
      stagedFileRemove,
      stagedComment,
      stagedCommentButton,
      activeFileChip,
      toolbarIcon,
      toolbarAvatar,
      toolbarAvatarButton,
      toolbarMode,
      toolbarSend,
    ]) {
      expect(getComputedStyle(toolbarControl).backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(getComputedStyle(toolbarControl).borderColor).toBe('rgba(0, 0, 0, 0)');
      expect(getComputedStyle(toolbarControl).boxShadow).toBe('none');
    }
    expect(getComputedStyle(stagedContextKind).color).toBe('var(--text-muted)');
    expect(getComputedStyle(stagedFileName).color).toBe('var(--text-muted)');
    expect(getComputedStyle(stagedCommentStrong).color).toBe('var(--text-muted)');
    expect(getComputedStyle(stagedCommentSpan).color).toBe('var(--text-muted)');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(document.body.classList.contains('od-quick-switcher-open')).toBe(false);
    });
    await waitFor(() => {
      expect(getComputedStyle(composer).pointerEvents).toBe('auto');
    });
    expect(getComputedStyle(composerControl).pointerEvents).toBe('auto');
    expect(getComputedStyle(composerLayer).opacity).not.toBe('0.58');
    expect(getComputedStyle(composerInputWrap).background).toBe('var(--bg-panel)');
  });
});

function unreadableDropDataTransfer(fallbackFiles: File[] = []) {
  return {
    files: fallbackFiles,
    items: [
      {
        webkitGetAsEntry: () => ({
          isFile: true,
          isDirectory: false,
          name: 'stale.png',
          file: (_done: (file: File) => void, fail?: (error: DOMException) => void) => {
            fail?.(new DOMException('missing', 'NotFoundError'));
          },
        }),
      },
    ],
  };
}

describe('FileWorkspace upload input', () => {
  it('keeps the Design Files picker aligned with drag-and-drop file support', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="design-files-upload-input"');
    expect(markup).not.toContain('accept=');
  });

  it('hides upload failure details during in-panel preview and restores them after closing preview', async () => {
    mockedUploadProjectFiles.mockRejectedValueOnce(new Error('storage offline'));

    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[baseFile()]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('design-files-upload-input'), {
      target: { files: [new File(['mock'], 'mock.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'storage offline',
      );
    });

    const row = screen.getByTestId('design-file-row-mock.png');
    const nameButton = row.querySelector<HTMLButtonElement>('.df-row-name-btn');
    if (!nameButton) throw new Error('Could not find file name button');
    fireEvent.click(nameButton);

    expect(screen.getByTestId('design-file-preview')).toBeTruthy();
    expect(screen.queryByTestId('upload-error-banner')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'storage offline',
      );
    });

    fireEvent.click(screen.getByTestId('upload-error-dismiss'));

    expect(screen.queryByTestId('upload-error-banner')).toBeNull();
  });

  it('keeps partial upload failures visible after a successful file opens', async () => {
    mockedUploadProjectFiles.mockResolvedValueOnce({
      uploaded: [
        {
          path: 'uploaded.png',
          name: 'uploaded.png',
          kind: 'image',
          size: 1024,
        },
      ],
      failed: [{ name: 'failed.png', error: 'permission denied' }],
      error: 'permission denied',
    });

    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[baseFile({ name: 'uploaded.png', path: 'uploaded.png' })]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('design-files-upload-input'), {
      target: {
        files: [
          new File(['uploaded'], 'uploaded.png', { type: 'image/png' }),
          new File(['failed'], 'failed.png', { type: 'image/png' }),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'Uploaded 1 file(s), but 1 failed (permission denied).',
      );
    });
  });

  it('starts Design Files navigation fresh when switching projects', () => {
    const baseProps: React.ComponentProps<typeof FileWorkspace> = {
      projectId: 'project-a',
      projectKind: 'prototype',
      files: [
        workspaceFile('assets/logo.png'),
        workspaceFile('top.html'),
      ],
      onRefreshFiles: vi.fn(),
      isDeck: false,
      tabsState: { tabs: [], active: null },
      onTabsStateChange: vi.fn(),
    };

    const { container, rerender } = render(<FileWorkspace {...baseProps} />);

    fireEvent.click(container.querySelector('.df-dir-row .df-row-name-btn')!);
    expect(container.querySelector('.df-breadcrumb-current')?.textContent).toBe('assets');

    rerender(
      <FileWorkspace
        {...baseProps}
        projectId="project-b"
        files={[
          workspaceFile('beta-assets/logo.png'),
          workspaceFile('home.html'),
        ]}
      />,
    );

    expect(container.querySelector('.df-breadcrumb-current')?.textContent).toBe('Project');
    expect(screen.getByTestId('design-file-row-home.html')).toBeTruthy();
  });

  it('drops the previous project folders when switching, before the new fetch resolves', async () => {
    const folder = (path: string): ProjectFolder => ({
      name: path.split('/').pop() ?? path,
      path,
      type: 'dir',
      size: 0,
      mtime: 1700000000,
    });
    const mockedFolders = vi.mocked(fetchProjectFolders);
    // project-a has an empty persisted folder; project-b's fetch stays pending.
    // (One-time values take precedence over the factory default `[]`; no reset,
    // so later tests keep that default.)
    mockedFolders.mockResolvedValueOnce([folder('assets')]);
    mockedFolders.mockReturnValueOnce(new Promise<ProjectFolder[]>(() => {}));

    const baseProps: React.ComponentProps<typeof FileWorkspace> = {
      projectId: 'project-a',
      projectKind: 'prototype',
      files: [],
      onRefreshFiles: vi.fn(),
      isDeck: false,
      tabsState: { tabs: [], active: null },
      onTabsStateChange: vi.fn(),
    };
    const { container, rerender } = render(<FileWorkspace {...baseProps} />);
    // project-a's empty folder shows once its fetch resolves.
    await waitFor(() => {
      expect(
        [...container.querySelectorAll('.df-dir-row .df-row-name')].some(
          (e) => e.textContent === 'assets',
        ),
      ).toBe(true);
    });

    // Switch to project-b; its folder fetch is still pending. The previous
    // project's 'assets' folder must be gone immediately (reset synchronously),
    // not linger and suppress the new project's empty state.
    designFilesPanelRenders.length = 0;
    rerender(<FileWorkspace {...baseProps} projectId="project-b" files={[]} />);
    expect(
      [...container.querySelectorAll('.df-dir-row .df-row-name')].some(
        (e) => e.textContent === 'assets',
      ),
    ).toBe(false);

    // The reset happens during render, not in an effect — so the new panel's
    // FIRST render (and every render thereafter) already sees zero folders.
    // An effect-based reset would let project-b's first render observe the
    // stale 'assets' folder before the effect cleared it; RTL's post-rerender
    // DOM check above can't catch that frame, this can.
    const projectBRenders = designFilesPanelRenders.filter((r) => r.projectId === 'project-b');
    expect(projectBRenders.length).toBeGreaterThan(0);
    expect(projectBRenders.every((r) => r.folderCount === 0)).toBe(true);
  });

  it('clears a prior upload failure after a later successful upload', async () => {
    mockedUploadProjectFiles
      .mockRejectedValueOnce(new Error('storage offline'))
      .mockResolvedValueOnce({
        uploaded: [
          {
            path: 'retry.png',
            name: 'retry.png',
            kind: 'image',
            size: 1024,
          },
        ],
        failed: [],
      });

    const onRefreshFiles = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[baseFile({ name: 'retry.png', path: 'retry.png' })]}
        onRefreshFiles={onRefreshFiles}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const input = screen.getByTestId('design-files-upload-input');
    fireEvent.change(input, {
      target: { files: [new File(['failed'], 'failed.png', { type: 'image/png' })] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain('storage offline');
    });

    fireEvent.change(input, {
      target: { files: [new File(['retry'], 'retry.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(onRefreshFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('upload-error-banner')).toBeNull());
  });

  it('falls back to the browser file list when a dragged entry cannot be read', async () => {
    const fallbackFile = new File(['mock'], 'fallback.png', { type: 'image/png' });
    const onUploadFiles = vi.fn();
    const { container } = renderDesignFilesPanel({ onUploadFiles });

    fireEvent.drop(container.querySelector('.df-body')!, {
      dataTransfer: unreadableDropDataTransfer([fallbackFile]),
    });

    await waitFor(() => expect(onUploadFiles).toHaveBeenCalledWith([fallbackFile]));
    expect(screen.queryByTestId('upload-error-banner')).toBeNull();
  });

  it('uploads files pasted from the clipboard in Design Files', () => {
    const pastedFile = new File(['mock'], 'clipboard.png', { type: 'image/png' });
    const onUploadFiles = vi.fn();
    const onClearUploadError = vi.fn();
    renderDesignFilesPanel({ onUploadFiles, onClearUploadError });

    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [pastedFile],
        items: [],
      },
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClearUploadError).toHaveBeenCalledTimes(1);
    expect(onUploadFiles).toHaveBeenCalledWith([pastedFile]);
  });

  it('does not steal clipboard files from text inputs', () => {
    const pastedFile = new File(['mock'], 'clipboard.png', { type: 'image/png' });
    const onUploadFiles = vi.fn();
    renderDesignFilesPanel({ onUploadFiles });
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    try {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [pastedFile],
          items: [],
        },
      });
      textarea.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(onUploadFiles).not.toHaveBeenCalled();
    } finally {
      textarea.remove();
    }
  });

  it('shows a recoverable read error when a dragged entry disappears before import', async () => {
    const onUploadFiles = vi.fn();
    const { container } = renderDesignFilesPanel({ onUploadFiles });

    fireEvent.drop(container.querySelector('.df-body')!, {
      dataTransfer: unreadableDropDataTransfer(),
    });

    await waitFor(() => {
      expect(screen.getByTestId('upload-error-banner').textContent).toContain(
        'Could not read one or more dropped files or folders',
      );
    });
    expect(onUploadFiles).not.toHaveBeenCalled();
  });

  it('hides the workspace focus control while the chat pane is open', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode={false}
        onFocusModeChange={vi.fn()}
      />,
    );

    // While chat is visible the collapse trigger lives in ChatPane.
    // FileWorkspace only renders an expand control once chat is hidden.
    expect(markup).not.toContain('data-testid="workspace-focus-toggle"');
    // The phone-only maximize control renders (CSS hides it on desktop) so
    // the stacked mobile split can promote the workspace to full screen.
    expect(markup).toContain('data-testid="workspace-focus-enter"');
    expect(markup).toContain('ws-focus-enter');
  });

  it('renders the expand control on the LEFT of the tab bar while focused', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="ws-tabs-shell"');
    expect(markup).toContain('data-testid="workspace-focus-toggle"');
    // The expand control sits before the tabs bar (left side) so its
    // direction matches where the chat pane re-emerges from.
    expect(markup).toMatch(
      /<div class="ws-tabs-shell">\s*<button[^>]*data-testid="workspace-focus-toggle"[\s\S]*?<\/button>\s*<div class="ws-tabs-bar"/,
    );
  });

  it('keeps the Design Files tab as the first workspace tab before opened files', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('artifact.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['artifact.html'], active: 'artifact.html' }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="ws-tabs-bar"');
    expect(markup).toMatch(
      /role="tablist"[\s\S]*data-testid="design-files-tab"[\s\S]*artifact\.html/,
    );
  });

  it('labels the same workspace control as chat restore while focused', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Show chat');
  });
});

describe('FileWorkspace launcher tab creation', () => {
  it('does not report a Design Files context for an empty project', async () => {
    // A brand-new project has no files or folders. The
    // composer must not auto-stage a "Design files" chip that points at
    // nothing, so the active workspace context stays null.
    const onActiveContextChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        resolvedDir="/tmp/open-design/project-1"
        files={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        onActiveContextChange={onActiveContextChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveContextChange).toHaveBeenCalled();
    });
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);
  });

  it('reports the active Design Files tab as workspace context once files exist', async () => {
    const onActiveContextChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        resolvedDir="/tmp/open-design/project-1"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        onActiveContextChange={onActiveContextChange}
      />,
    );

    await waitFor(() => {
      expect(onActiveContextChange).toHaveBeenLastCalledWith({
        id: 'workspace:design-files',
        kind: 'design-files',
        label: 'Design Files',
        tabId: '__design_files__',
        absolutePath: '/tmp/open-design/project-1',
      });
    });
  });

  it('opens the Design Files tab launcher with the browser new-tab shortcut', async () => {
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const allowedDefault = fireEvent.keyDown(window, {
      key: 't',
      metaKey: true,
    });

    expect(allowedDefault).toBe(false);
    expect(screen.getByTestId('workspace-add-tab').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(await screen.findByRole('dialog', { name: /New tab/i })).toBeTruthy();
    expect(screen.getByTestId('tab-launcher-search')).toBe(document.activeElement);
  });

  it('closes the active Design Files workspace tab with the browser close-tab shortcut', () => {
    const onTabsStateChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['analysis.html', 'notes.html'], active: 'notes.html' }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const allowedDefault = fireEvent.keyDown(window, {
      key: 'w',
      ctrlKey: true,
    });

    expect(allowedDefault).toBe(false);
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: ['analysis.html'],
      active: 'analysis.html',
    });
  });

  it('switches Design Files workspace tabs with browser-style next and previous shortcuts', async () => {
    const onTabsStateChange = vi.fn();
    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['analysis.html', 'notes.html'], active: 'analysis.html' }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const nextAllowedDefault = fireEvent.keyDown(window, {
      key: 'Tab',
      ctrlKey: true,
    });

    expect(nextAllowedDefault).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /notes\.html/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: ['analysis.html', 'notes.html'],
      active: 'notes.html',
    });

    const previousAllowedDefault = fireEvent.keyDown(window, {
      key: 'Tab',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(previousAllowedDefault).toBe(false);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /analysis\.html/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
    expect(onTabsStateChange).toHaveBeenLastCalledWith({
      tabs: ['analysis.html', 'notes.html'],
      active: 'analysis.html',
    });
  });

  it('opens and activates the target file for a download request', async () => {
    const onTabsStateChange = vi.fn();

    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('cover.html'), workspaceFile('landing.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['cover.html'], active: 'cover.html' }}
        downloadRequest={{ name: 'landing.html', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['cover.html', 'landing.html'],
        active: 'landing.html',
      });
    });
  });

  it('focuses an already-open file tab without adding a duplicate tab', async () => {
    const onTabsStateChange = vi.fn();

    render(
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('Web Prototype mutuals-v2.html')]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['Web Prototype mutuals-v2.html'],
          active: 'notes.html',
        }}
        openRequest={{ name: 'Web Prototype mutuals-v2.html', nonce: 1 }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    await waitFor(() => {
      expect(onTabsStateChange).toHaveBeenCalledWith({
        tabs: ['Web Prototype mutuals-v2.html'],
        active: 'Web Prototype mutuals-v2.html',
      });
    });
  });
});
