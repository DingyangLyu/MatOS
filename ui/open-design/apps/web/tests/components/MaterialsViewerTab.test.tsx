// @vitest-environment jsdom

// The materials viewer tab (`matterviz:<n>`) is the discoverable MatterViz entry
// point opened from the workspace "+" launcher. These specs pin the two states
// that matter: (1) when the project has structure/trajectory files it shows the
// file picker (and mounts the MatterViz surface), and (2) when it has none it
// shows the upload guidance instead of an empty 3D canvas. Detection reuses the
// same name-based `structure-files` rules the FileViewer uses.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MaterialsViewerTab } from '../../src/components/MaterialsViewerTab';
import { I18nProvider } from '../../src/i18n';
import type { ProjectFile } from '../../src/types';

function file(name: string, mtime = 1): ProjectFile {
  return { name, size: 100, mtime, kind: 'binary', mime: 'application/octet-stream' };
}

function renderTab(files: ProjectFile[], onUpload = vi.fn()) {
  render(
    <I18nProvider initial="en">
      <MaterialsViewerTab projectId="proj-1" files={files} onUpload={onUpload} />
    </I18nProvider>,
  );
  return { onUpload };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MaterialsViewerTab', () => {
  it('shows the structure-file picker and mounts the viewer when structures exist', () => {
    renderTab([
      file('notes.md'),
      file('LiFePO4.cif', 2),
      file('POSCAR', 3),
      file('index.html'),
    ]);

    const select = screen.getByTestId('materials-viewer-select') as HTMLSelectElement;
    // Only the two structure files are offered, newest (POSCAR, mtime 3) first.
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['POSCAR', 'LiFePO4.cif']);
    expect(select.value).toBe('POSCAR');

    // The MatterViz surface is mounted (not the empty state).
    expect(screen.getByTestId('matterviz-pane')).toBeTruthy();
    expect(screen.queryByTestId('materials-viewer-empty')).toBeNull();

    // Switching the picker swaps the selected structure.
    fireEvent.change(select, { target: { value: 'LiFePO4.cif' } });
    expect((screen.getByTestId('materials-viewer-select') as HTMLSelectElement).value).toBe(
      'LiFePO4.cif',
    );
  });

  it('shows upload guidance instead of a picker when there are no structure files', () => {
    const { onUpload } = renderTab([file('notes.md'), file('deck.html')]);

    expect(screen.queryByTestId('materials-viewer-select')).toBeNull();
    expect(screen.getByTestId('materials-viewer-empty')).toBeTruthy();

    fireEvent.click(screen.getByTestId('materials-viewer-upload'));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });
});
