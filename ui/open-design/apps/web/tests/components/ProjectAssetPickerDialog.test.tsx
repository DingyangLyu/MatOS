// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import {
  collapseProjectAssetPickerRows,
  ProjectAssetPickerDialog,
  resolvedProjectAssetSelections,
} from '../../src/components/ProjectAssetPickerDialog';
import {
  matOSAssetSelectionRef,
  type MatOSAssetSummary,
} from '../../src/runtime/matos-assets';

const { fetchMatOSAssets } = vi.hoisted(() => ({
  fetchMatOSAssets: vi.fn(),
}));
vi.mock('../../src/runtime/matos-assets', async () => {
  const actual = await vi.importActual('../../src/runtime/matos-assets');
  return { ...actual, fetchMatOSAssets };
});

function asset(input: Partial<MatOSAssetSummary> & Pick<MatOSAssetSummary, 'ref' | 'id' | 'type' | 'name'>): MatOSAssetSummary {
  return {
    source: 'pack',
    version: '1.0.0',
    description: null,
    tags: [],
    packId: 'test',
    entry: null,
    status: 'enabled',
    dependencies: [],
    runtime: null,
    git: { sourceId: null, scope: 'shared', webUrl: null },
    boundary: {
      visibility: 'public',
      owner: 'matos',
      editable: false,
      sharedCopy: false,
      selfEvolved: false,
      evolutionRuns: 0,
      latestEvolutionAt: null,
    },
    ...input,
  };
}

describe('ProjectAssetPickerDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('filters public/private/shared-copy/project/evolved assets and saves the clicked selection', async () => {
    fetchMatOSAssets.mockResolvedValue([
      asset({ ref: 'knowledge:shared-guide', id: 'shared-guide', type: 'knowledge', name: 'Shared guide' }),
      asset({
        ref: 'tool:my-helper',
        id: 'my-helper',
        type: 'tool',
        name: 'My helper',
        git: { sourceId: 'mine', scope: 'user', webUrl: null },
        boundary: {
          visibility: 'private',
          owner: 'current-scope',
          editable: true,
          sharedCopy: false,
          selfEvolved: true,
          evolutionRuns: 2,
          latestEvolutionAt: '2026-08-21T12:00:00.000Z',
        },
      }),
      asset({
        ref: 'skill:shared-copy',
        id: 'shared-copy',
        type: 'skill',
        name: 'Shared copy',
        git: { sourceId: 'mine', scope: 'user', webUrl: null },
        boundary: {
          visibility: 'private',
          owner: 'current-scope',
          editable: true,
          sharedCopy: true,
          selfEvolved: false,
          evolutionRuns: 0,
          latestEvolutionAt: null,
        },
      }),
      asset({
        ref: 'workflow:project-flow',
        id: 'project-flow',
        type: 'workflow',
        name: 'Project flow',
        source: 'project',
        git: { sourceId: null, scope: null, webUrl: null },
        boundary: {
          visibility: 'collaborative',
          owner: 'project',
          editable: false,
          sharedCopy: false,
          selfEvolved: false,
          evolutionRuns: 0,
          latestEvolutionAt: null,
        },
      }),
      asset({ ref: 'role:project-agent', id: 'project-agent', type: 'role', name: 'Project agent' }),
    ]);
    const onSave = vi.fn();
    render(
      <I18nProvider initial="en">
        <ProjectAssetPickerDialog
          projectId="project-a"
          selectedRefs={['knowledge:shared-guide']}
          saving={false}
          onSave={onSave}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await screen.findByText('Shared guide');
    expect(fetchMatOSAssets).toHaveBeenCalledWith({ projectId: 'project-a' });
    expect(screen.getByText('Project agent')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Public assets/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Imported assets/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Self-evolved 1$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /My assets/ }));
    expect(screen.getByText('My helper')).toBeTruthy();
    expect(screen.queryByText('Shared copy')).toBeNull();
    expect(screen.queryByText('Shared guide')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Imported assets/ }));
    expect(screen.getByRole('button', { name: /View details: Shared copy/ })).toBeTruthy();
    expect(screen.queryByText('My helper')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /My assets/ }));
    fireEvent.click(screen.getByRole('button', { name: 'View details: My helper' }));
    expect(within(screen.getByRole('region', { name: 'View details: My helper' }))
      .getByText('tool:my-helper@1.0.0', { selector: 'code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select asset: My helper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and use' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith([
      'knowledge:shared-guide',
      'tool:my-helper',
    ]));
  });

  it('counts and filters project assets from the selected canonical refs, including roles', async () => {
    const selectedAssets = [
      ['data', 'fixture-data'],
      ['knowledge', 'fixture-knowledge'],
      ['tool', 'fixture-tool'],
      ['mcp', 'fixture-mcp'],
      ['skill', 'fixture-skill'],
      ['workflow', 'fixture-workflow'],
      ['role', 'fixture-role'],
    ].map(([type, id]) => asset({
      ref: `${type}:${id}`,
      canonicalKey: `${type}:${id}@1.0.0`,
      id: id!,
      type: type!,
      name: `Selected ${type}`,
      git: { sourceId: 'recipient-copy', scope: 'user', webUrl: null },
      boundary: {
        visibility: 'private',
        owner: 'current-scope',
        editable: true,
        sharedCopy: true,
        selfEvolved: false,
        evolutionRuns: 0,
        latestEvolutionAt: null,
      },
    }));
    fetchMatOSAssets.mockResolvedValue([
      ...selectedAssets,
      asset({ ref: 'tool:not-selected', id: 'not-selected', type: 'tool', name: 'Not selected' }),
    ]);

    render(
      <I18nProvider initial="en">
        <ProjectAssetPickerDialog
          projectId="shared-project-a"
          selectedRefs={selectedAssets.map(matOSAssetSelectionRef)}
          saving={false}
          onSave={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await screen.findByText('Selected role');
    expect(screen.getByRole('button', { name: /^Project 7$/ })).toBeTruthy();
    expect(screen.getByText('7 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Project 7$/ }));
    for (const row of selectedAssets) {
      expect(screen.getByText(row.name)).toBeTruthy();
    }
    expect(screen.queryByText('Not selected')).toBeNull();
  });

  it('collapses version history to the newest canonical row and batch-saves into the project', async () => {
    fetchMatOSAssets.mockResolvedValue([
      asset({
        ref: 'workflow:duplicate',
        canonicalKey: 'workflow:duplicate@1.0.0',
        id: 'duplicate',
        type: 'workflow',
        name: 'Duplicate workflow',
        version: '1.0.0',
      }),
      asset({
        ref: 'workflow:duplicate',
        canonicalKey: 'workflow:duplicate@2.0.0',
        id: 'duplicate',
        type: 'workflow',
        name: 'Duplicate workflow',
        version: '2.0.0',
      }),
      asset({
        ref: 'tool:helper',
        canonicalKey: 'tool:helper@3.0.0',
        id: 'helper',
        type: 'tool',
        name: 'Helper',
        version: '3.0.0',
      }),
    ]);
    const onSave = vi.fn();
    render(
      <I18nProvider initial="en">
        <ProjectAssetPickerDialog
          projectId="project-a"
          selectedRefs={[]}
          saving={false}
          onSave={onSave}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await screen.findByText('Duplicate workflow');
    expect(screen.getAllByText('Duplicate workflow')).toHaveLength(1);
    expect(screen.getByText('v2.0.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View details: Duplicate workflow' }));
    expect(within(screen.getByRole('region', { name: 'View details: Duplicate workflow' }))
      .getByText('workflow:duplicate@2.0.0', { selector: 'code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select visible' }));
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save and use/ }));

    expect(onSave).toHaveBeenCalledWith([
      'workflow:duplicate',
      'tool:helper',
    ]);
  });

  it('keeps an older exact project pin when collapsing version history', () => {
    const older = asset({
      ref: 'workflow:pinned',
      canonicalKey: 'workflow:pinned@1.0.0',
      id: 'pinned',
      type: 'workflow',
      name: 'Pinned workflow',
      version: '1.0.0',
    });
    const newer = asset({
      ref: 'workflow:pinned',
      canonicalKey: 'workflow:pinned@2.0.0',
      id: 'pinned',
      type: 'workflow',
      name: 'Pinned workflow',
      version: '2.0.0',
    });
    expect(collapseProjectAssetPickerRows(
      [older, newer],
      new Set(['workflow:pinned@1.0.0']),
    ).map(matOSAssetSelectionRef)).toEqual(['workflow:pinned@1.0.0']);
  });

  it('normalizes shared-copy selections while preserving unavailable explicit pins', () => {
    const newer = asset({
      ref: 'tool:shared-copy', canonicalKey: 'tool:shared-copy@2.0.0',
      id: 'shared-copy', type: 'tool', name: 'Shared copy', version: '2.0.0',
      git: { sourceId: 'recipient-copy', scope: 'user', webUrl: null },
    });
    const selected = new Set(['tool:shared-copy@1.0.0']);
    expect(resolvedProjectAssetSelections(selected, [newer])).toEqual(['tool:shared-copy']);
    expect(resolvedProjectAssetSelections(selected, [newer], 'pinned')).toEqual(['tool:shared-copy@1.0.0']);
    expect(resolvedProjectAssetSelections(new Set(['tool:shared-copy']), [newer], 'pinned'))
      .toEqual(['tool:shared-copy@2.0.0']);
  });

  it('caps bulk project selection at 64 without silently truncating after save', async () => {
    fetchMatOSAssets.mockResolvedValue(Array.from({ length: 66 }, (_, index) => asset({
      ref: `tool:helper-${index}`,
      canonicalKey: `tool:helper-${index}@1.0.0`,
      id: `helper-${index}`,
      type: 'tool',
      name: `Helper ${index}`,
    })));
    const onSave = vi.fn();
    render(
      <I18nProvider initial="en">
        <ProjectAssetPickerDialog
          projectId="project-a"
          selectedRefs={[]}
          saving={false}
          onSave={onSave}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    await screen.findByText('Helper 0');
    fireEvent.click(screen.getByRole('button', { name: 'Select visible' }));
    expect(screen.getByText('64 selected')).toBeTruthy();
    expect(screen.getByText(/up to 64 root assets/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save and use/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toHaveLength(64);
  });
});
