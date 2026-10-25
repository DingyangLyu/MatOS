// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { I18nProvider } from '../../src/i18n';
import type { ProjectFile } from '../../src/types';

// VSCode-style file tree: right-click context menus (new file / new folder /
// rename / delete), inline creation editors, and keyboard-driven rename.
// The list mode owns the legacy flows; these tests pin the tree upgrade.

function file(name: string): ProjectFile {
  return {
    name,
    size: 10,
    mtime: Date.now(),
    kind: 'text',
    mime: 'text/plain',
  } as ProjectFile;
}

const BASE_PROPS = {
  projectId: 'p1',
  reloading: false,
  files: [file('README.md'), file('src/app.py'), file('src/util.py')] as ProjectFile[],
  folders: [{ name: 'data', path: 'data', type: 'dir' as const, size: 0 as const, mtime: 1 }],
  onRefreshFiles: () => {},
  onOpenFile: () => {},
  onDeleteFile: () => {},
  onDeleteFiles: () => {},
  onUpload: () => {},
  onUploadFiles: () => {},
  onPaste: () => {},
};

describe('DesignFilesPanel tree mode (VSCode explorer behaviors)', () => {
  beforeEach(() => {
    localStorage.setItem('od-design-files-view', 'tree');
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('offers new file / new folder from a directory context menu and commits inline', async () => {
    const onCreateFile = vi.fn().mockResolvedValue(file('src/new-note.md'));
    const onOpenFile = vi.fn();
    render(
      <I18nProvider initial="en">
        <DesignFilesPanel
          {...BASE_PROPS}
          onOpenFile={onOpenFile}
          onRenameFile={vi.fn()}
          onCreateFile={onCreateFile}
          onCreateFolder={vi.fn().mockResolvedValue(true)}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByTestId('design-tree-dir-src'));
    const menu = await screen.findByTestId('design-tree-menu-popover');
    expect(menu.textContent).toContain('New file');
    expect(menu.textContent).toContain('New folder');
    fireEvent.click(screen.getByTestId('design-tree-new-file'));

    const input = await screen.findByTestId('design-tree-editor-input');
    fireEvent.change(input, { target: { value: 'new-note.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(onCreateFile).toHaveBeenCalledWith('src/new-note.md');
    });
    // The created file opens immediately, VSCode-style.
    await waitFor(() => {
      expect(onOpenFile).toHaveBeenCalledWith('src/new-note.md');
    });
  });

  it('renames a file inline via the context menu, preserving its directory', async () => {
    const onRenameFile = vi.fn().mockResolvedValue(file('src/renamed.py'));
    render(
      <I18nProvider initial="en">
        <DesignFilesPanel {...BASE_PROPS} onRenameFile={onRenameFile} />
      </I18nProvider>,
    );

    // Expand the collapsed dir first — nested files render only when open.
    fireEvent.click(screen.getByTestId('design-tree-dir-src'));
    fireEvent.contextMenu(screen.getByTestId('design-tree-file-src/app.py'));
    fireEvent.click(await screen.findByTestId('design-tree-rename'));
    const input = screen.getByDisplayValue('app.py');
    fireEvent.change(input, { target: { value: 'renamed.py' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(onRenameFile).toHaveBeenCalledWith('src/app.py', 'src/renamed.py');
    });
  });

  it('deletes from the context menu and shows empty folders from the folder list', async () => {
    const onDeleteFile = vi.fn();
    render(
      <I18nProvider initial="en">
        <DesignFilesPanel {...BASE_PROPS} onRenameFile={vi.fn()} onDeleteFile={onDeleteFile} />
      </I18nProvider>,
    );
    // The persisted-but-empty folder renders as a tree dir.
    expect(screen.getByTestId('design-tree-dir-data')).toBeTruthy();

    fireEvent.contextMenu(screen.getByTestId('design-tree-file-README.md'));
    fireEvent.click(await screen.findByTestId('design-tree-delete'));
    expect(onDeleteFile).toHaveBeenCalledWith('README.md');
  });

  it('supports keyboard navigation: arrows select, F2 renames', async () => {
    const onRenameFile = vi.fn().mockResolvedValue(file('renamed.md'));
    render(
      <I18nProvider initial="en">
        <DesignFilesPanel {...BASE_PROPS} onRenameFile={onRenameFile} />
      </I18nProvider>,
    );
    const tree = screen.getByTestId('design-files-tree');
    // Rows: dir data, dir src, file README.md — ArrowDown x3 lands on the file.
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(
      screen.getByTestId('design-tree-file-README.md').className,
    ).toContain('is-selected');
    fireEvent.keyDown(tree, { key: 'F2' });
    const input = await screen.findByDisplayValue('README.md');
    fireEvent.change(input, { target: { value: 'renamed.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(onRenameFile).toHaveBeenCalledWith('README.md', 'renamed.md');
    });
  });
});
