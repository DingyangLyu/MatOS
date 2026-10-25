// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOpenDesignHostAvailable, pickHostWorkingDir } from '@open-design/host';
import { NewProjectPanel } from '../../src/components/NewProjectPanel';
import { openFolderDialog } from '../../src/providers/registry';
import type {  ProjectTemplate, SkillSummary } from '../../src/types';

vi.mock('@open-design/host', async () => {
  const actual = await vi.importActual<typeof import('@open-design/host')>('@open-design/host');
  return {
    ...actual,
    isOpenDesignHostAvailable: vi.fn(),
    pickHostWorkingDir: vi.fn(),
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    openFolderDialog: vi.fn(),
  };
});

const mockedIsHostAvailable = vi.mocked(isOpenDesignHostAvailable);
const mockedPickHostWorkingDir = vi.mocked(pickHostWorkingDir);
const mockedOpenFolderDialog = vi.mocked(openFolderDialog);

const skills: SkillSummary[] = [
  {
    id: 'prototype-skill',
    name: 'Prototype',
    description: 'Build prototypes',
    mode: 'prototype',
    surface: 'web',
    previewType: 'html',
    defaultFor: ['prototype'],
    triggers: [],
    upstream: null,
    hasBody: true,
    examplePrompt: 'Build a prototype.',
    aggregatesExamples: false,
  },
];

const templates: ProjectTemplate[] = [
  {
    id: 'tmpl-landing',
    name: 'Landing Page',
    description: 'A saved landing page starter.',
    files: [{ name: 'prototype/App.jsx', content: '<div>App</div>' }],
    createdAt: 0,
  },
];

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  mockedIsHostAvailable.mockReturnValue(false);
  mockedOpenFolderDialog.mockResolvedValue(null);
});

describe('NewProjectPanel creation', () => {
  it('preserves prototype fidelity across tab switches and saves it into the create payload', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={skills}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Wireframe fidelity payload' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Wireframe' }));
    expect(screen.getByRole('button', { name: 'Wireframe' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: 'Slide deck' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Prototype' }));
    expect(screen.getByRole('button', { name: 'Wireframe' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Wireframe fidelity payload',
        metadata: expect.objectContaining({
          kind: 'prototype',
          fidelity: 'wireframe',
        }),
      }),
    );
  });

  it('does not persist OS widgets metadata for web-only platform targets', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={skills}
        templates={[]}
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Responsive web payload' },
    });
    // CompactToggle renders as a `<button aria-pressed>` so screen readers
    // announce it as a toggle button; the role is `button`, not `checkbox`.
    fireEvent.click(screen.getByRole('button', { name: /OS widgets/i }));
    fireEvent.click(screen.getByTestId('create-project'));

    const payload = onCreate.mock.calls[0]?.[0];
    expect(payload.metadata).toEqual(
      expect.objectContaining({
        platform: 'responsive',
        platformTargets: ['responsive'],
      }),
    );
    expect(payload.metadata).not.toHaveProperty('includeOsWidgets');
  });

  it('marks the target platform dropdown as a multi-select listbox', () => {
    render(
      <NewProjectPanel
        skills={skills}
        templates={[]}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Responsive web/i }));

    expect(screen.getByRole('listbox', { name: 'Target platforms' }).getAttribute('aria-multiselectable')).toBe(
      'true',
    );
  });

  it('falls back to the generated default title when the prototype name is blank', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={skills}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^Prototype\b/),
        metadata: expect.objectContaining({
          kind: 'prototype',
          fidelity: 'high-fidelity',
        }),
      }),
    );
  });

  it('saves deck creation with speaker notes metadata when the toggle is enabled', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={skills}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Slide deck' }));
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Deck speaker notes payload' },
    });
    fireEvent.click(screen.getByRole('button', { name: /use speaker notes/i }));
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Deck speaker notes payload',
        metadata: expect.objectContaining({
          kind: 'deck',
          speakerNotes: true,
        }),
      }),
    );
    const payload = onCreate.mock.calls[0]?.[0];
    expect(payload.metadata).not.toHaveProperty('platform');
    expect(payload.metadata).not.toHaveProperty('platformTargets');
  });

  it('prevents template creation when there are no saved templates and enables creation once one exists', () => {
    const emptyOnCreate = vi.fn();
    const first = render(
      <NewProjectPanel
        skills={skills}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        onCreate={emptyOnCreate}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'From template' }));
    const createFromTemplate = screen.getByTestId('create-project') as HTMLButtonElement;
    expect(createFromTemplate.disabled).toBe(true);
    fireEvent.click(createFromTemplate);
    expect(emptyOnCreate).not.toHaveBeenCalled();
    first.unmount();

    const templateOnCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={vi.fn()}
        onCreate={templateOnCreate}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'From template' }));
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Template creation payload' },
    });
    const createReady = screen.getByTestId('create-project') as HTMLButtonElement;
    expect(createReady.disabled).toBe(false);
    fireEvent.click(createReady);

    expect(templateOnCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Template creation payload',
        metadata: expect.objectContaining({
          kind: 'template',
          templateId: 'tmpl-landing',
          templateLabel: 'Landing Page',
        }),
      }),
    );
  });

  it('includes a browser-picked working directory in the create payload', async () => {
    const onCreate = vi.fn();
    mockedIsHostAvailable.mockReturnValue(false);
    mockedOpenFolderDialog.mockResolvedValue('/Users/me/product-designs');

    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Local storage' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /product-designs/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          userWorkingDir: '/Users/me/product-designs',
        }),
      }),
    );
    expect(mockedPickHostWorkingDir).not.toHaveBeenCalled();
  });

  it('threads the desktop host working-dir token into the create payload', async () => {
    const onCreate = vi.fn();
    mockedIsHostAvailable.mockReturnValue(true);
    mockedPickHostWorkingDir.mockResolvedValue({
      ok: true,
      baseDir: '/Users/me/host-designs',
      token: 'host-token',
    });

    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={vi.fn()}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Local storage' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /host-designs/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkingDirToken: 'host-token',
        metadata: expect.objectContaining({
          userWorkingDir: '/Users/me/host-designs',
        }),
      }),
    );
    expect(mockedOpenFolderDialog).not.toHaveBeenCalled();
  });

  it('surfaces host picker failures without falling back to an untokened browser path', async () => {
    mockedIsHostAvailable.mockReturnValue(true);
    mockedPickHostWorkingDir.mockResolvedValue({
      ok: false,
      reason: 'host build does not support pickWorkingDir',
    });

    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Local storage' }));

    expect(await screen.findByText(/Couldn't open the folder picker/i)).toBeTruthy();
    expect(mockedOpenFolderDialog).not.toHaveBeenCalled();
  });

  it('surfaces browser picker daemon failures with localized copy and native details', async () => {
    mockedIsHostAvailable.mockReturnValue(false);
    mockedOpenFolderDialog.mockRejectedValue(new Error('Could not open folder picker: zenity is not installed'));

    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Local storage' }));

    expect(await screen.findByText('Could not open folder picker')).toBeTruthy();
    expect(await screen.findByText('zenity is not installed')).toBeTruthy();
    expect(screen.queryByText('Could not open folder picker: zenity is not installed')).toBeNull();
    expect(mockedOpenFolderDialog).toHaveBeenCalledWith({ throwOnError: true });
  });
});

describe('NewProjectPanel folder import feedback', () => {
  it('shows an error when folder picker import rejects with a daemon message', async () => {
    const onImportFolder = vi.fn().mockRejectedValue(new Error('folder not found'));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/dialog/open-folder') {
        return new Response(
          JSON.stringify({ path: '/missing/project' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={vi.fn()}
        onCreate={vi.fn()}
        onImportFolder={onImportFolder}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));

    await waitFor(() => {
      expect(onImportFolder).toHaveBeenCalledWith('/missing/project');
    });
    expect(await screen.findByText('folder not found')).toBeTruthy();
  });
});

describe('NewProjectPanel template deletion', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = () => {};
  });

  it('calls onDeleteTemplate only after the user confirms in the dialog', async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={onDelete}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'From template' }));
    fireEvent.click(screen.getByLabelText(/delete template/i));
    expect(onDelete).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Landing Page');

    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));
    expect(onDelete).toHaveBeenCalledWith('tmpl-landing');
  });

  it('does not call onDeleteTemplate when the user cancels the confirmation', async () => {
    const onDelete = vi.fn().mockResolvedValue(true);
    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={onDelete}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'From template' }));
    fireEvent.click(screen.getByLabelText(/delete template/i));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the confirm dialog open with an inline error when onDeleteTemplate returns false', async () => {
    const onDelete = vi.fn().mockResolvedValue(false);
    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={onDelete}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'From template' }));
    fireEvent.click(screen.getByLabelText(/delete template/i));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));

    await screen.findByText('Could not delete this template. Please try again.');
    expect(screen.queryByRole('alertdialog')).not.toBeNull();
    expect(onDelete).toHaveBeenCalledWith('tmpl-landing');
  });

  it('does not close the confirm dialog when the backdrop is clicked mid-delete', async () => {
    let resolveDelete: (value: boolean) => void = () => {};
    const onDelete = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveDelete = resolve; }),
    );
    render(
      <NewProjectPanel
        skills={skills}
        templates={templates}
        onDeleteTemplate={onDelete}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'From template' }));
    fireEvent.click(screen.getByLabelText(/delete template/i));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));

    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);

    expect(screen.queryByRole('alertdialog')).not.toBeNull();
    expect(onDelete).toHaveBeenCalledTimes(1);

    resolveDelete(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
