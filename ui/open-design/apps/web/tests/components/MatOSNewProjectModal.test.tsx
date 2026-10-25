// @vitest-environment jsdom

// The MatOS new-project modal replaced the OD create panel on the "+" →
// Project path. A MatOS project = name + mission + member-role roster (with
// per-role chat names + briefs) + one working folder shared by every agent.
// These specs pin the create payload contract (metadata.goal / members /
// memberBriefs / memberNames / skipDiscoveryBrief, slug id +
// projectLocationId) and the slug/collision behavior — that payload is what
// the daemon turns into the project charter prompt block and the on-disk
// project folder.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MatOSNewProjectModal,
  projectFolderSlug,
  type MatOSCreateProjectInput,
} from '../../src/components/MatOSNewProjectModal';
import { resetMatOSRolesCacheForTests } from '../../src/runtime/matos-roles';
import { I18nProvider } from '../../src/i18n';

const ROLES = {
  roles: [
    {
      ref: 'role:compute',
      id: 'compute',
      name: 'Compute',
      description: 'DFT / MD compute role.',
      tags: ['materials'],
    },
    {
      ref: 'role:academic',
      id: 'academic',
      name: 'Academic Research',
      description: 'Literature-focused research role.',
      tags: ['research'],
    },
  ],
};

const LOCATIONS = {
  locations: [
    { id: 'default', name: 'MatOS projects', path: '/data/projects', builtIn: true },
    { id: 'workspace', name: 'Workspace', path: '/workspace/group/shared/projects' },
  ],
};

function stubFetch(overrides?: { locations?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u === '/api/matos/roles') {
      return new Response(JSON.stringify(ROLES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u === '/api/project-locations') {
      return new Response(JSON.stringify(overrides?.locations ?? LOCATIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
}

beforeEach(() => {
  resetMatOSRolesCacheForTests();
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderModal(onCreate: (input: MatOSCreateProjectInput) => Promise<boolean> | boolean) {
  return render(
    <I18nProvider initial="en">
      <MatOSNewProjectModal open onCreate={onCreate} onClose={vi.fn()} />
    </I18nProvider>,
  );
}

describe('projectFolderSlug', () => {
  it('slugs names into daemon-safe folder ids', () => {
    expect(projectFolderSlug('Battery Screening 2026')).toBe('battery-screening-2026');
    expect(projectFolderSlug('  固态电解质!!  ')).toBe('');
    expect(projectFolderSlug('a'.repeat(80)).length).toBe(48);
    expect(projectFolderSlug('--weird__name--')).toBe('weird__name');
  });
});

describe('MatOSNewProjectModal', () => {
  it('submits mission, roster briefs, slug id and location in the payload', async () => {
    const onCreate = vi.fn<(input: MatOSCreateProjectInput) => Promise<boolean>>(
      async () => true,
    );
    renderModal(onCreate);

    // The workspace (non-built-in) location is preselected once locations
    // load, which reveals the folder-name input.
    await waitFor(() => {
      expect((screen.getByTestId('matos-np-location') as HTMLSelectElement).value).toBe('workspace');
    });

    fireEvent.change(screen.getByTestId('matos-np-name'), {
      target: { value: 'Battery Screening' },
    });
    fireEvent.change(screen.getByTestId('matos-np-goal'), {
      target: { value: 'Screen 200 cathode candidates.' },
    });

    // First member row: pick a role, give it a chat name + responsibility.
    const roleSelect = await screen.findByTestId('matos-np-member-role-0');
    await waitFor(() => {
      expect(roleSelect.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    // Name/brief stay disabled until a role is picked.
    expect((screen.getByTestId('matos-np-member-name-0') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(roleSelect, { target: { value: 'role:compute' } });
    fireEvent.change(screen.getByTestId('matos-np-member-name-0'), {
      target: { value: ' 算力老王 ' },
    });
    fireEvent.change(screen.getByTestId('matos-np-member-brief-0'), {
      target: { value: 'Run all DFT jobs.' },
    });

    // Add a second member without a brief; naming it exactly the catalog role
    // name is not a rename, so it must not land in metadata.memberNames.
    fireEvent.click(screen.getByTestId('matos-np-add-member'));
    fireEvent.change(screen.getByTestId('matos-np-member-role-1'), {
      target: { value: 'role:academic' },
    });
    fireEvent.change(screen.getByTestId('matos-np-member-name-1'), {
      target: { value: 'Academic Research' },
    });

    // Folder name mirrors the project name; the preview shows the full path.
    expect((screen.getByTestId('matos-np-folder-name') as HTMLInputElement).value).toBe(
      'battery-screening',
    );
    expect(screen.getByTestId('matos-np-folder-preview').textContent).toBe(
      '/workspace/group/shared/projects/battery-screening',
    );

    fireEvent.click(screen.getByTestId('matos-np-create'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    const input = onCreate.mock.calls[0]![0]!;
    expect(input.name).toBe('Battery Screening');
    expect(input.id).toBe('battery-screening');
    expect(input.projectLocationId).toBe('workspace');
    expect(input.skillId).toBeNull();
    expect(input.metadata).toMatchObject({
      kind: 'other',
      nameSource: 'user',
      skipDiscoveryBrief: true,
      goal: 'Screen 200 cathode candidates.',
      members: ['role:compute', 'role:academic'],
      memberBriefs: { 'role:compute': 'Run all DFT jobs.' },
      // Trimmed chat name lands in memberNames — the group chat, @-bar and
      // charter prompt all address this member as 算力老王.
      memberNames: { 'role:compute': '算力老王' },
    });
    // No brief for academic → no key (charter renders a bare roster row).
    expect(input.metadata.memberBriefs).not.toHaveProperty('role:academic');
    // Name equal to the catalog role name is not a rename → no alias entry.
    expect(input.metadata.memberNames).not.toHaveProperty('role:academic');
  });

  it('omits slug/location and folder input for the managed built-in store', async () => {
    stubFetch({
      locations: { locations: [LOCATIONS.locations[0]] },
    });
    const onCreate = vi.fn<(input: MatOSCreateProjectInput) => Promise<boolean>>(
      async () => true,
    );
    renderModal(onCreate);

    await waitFor(() => {
      expect((screen.getByTestId('matos-np-location') as HTMLSelectElement).value).toBe('default');
    });
    expect(screen.queryByTestId('matos-np-folder-name')).toBeNull();
    expect(screen.queryByTestId('matos-np-folder-preview')).toBeNull();

    fireEvent.change(screen.getByTestId('matos-np-name'), { target: { value: 'Demo' } });
    fireEvent.click(screen.getByTestId('matos-np-create'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    const input = onCreate.mock.calls[0]![0]!;
    expect(input.id).toBeUndefined();
    expect(input.projectLocationId).toBeUndefined();
    expect(input.metadata.goal).toBeUndefined();
    expect(input.metadata.members).toBeUndefined();
  });

  it('retries with a numeric suffix when the slug id already exists', async () => {
    const onCreate = vi
      .fn<(input: MatOSCreateProjectInput) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('project already exists'))
      .mockResolvedValueOnce(true);
    renderModal(onCreate);

    await waitFor(() => {
      expect((screen.getByTestId('matos-np-location') as HTMLSelectElement).value).toBe('workspace');
    });
    fireEvent.change(screen.getByTestId('matos-np-name'), { target: { value: 'Demo' } });
    fireEvent.click(screen.getByTestId('matos-np-create'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[0]![0]!.id).toBe('demo');
    expect(onCreate.mock.calls[1]![0]!.id).toBe('demo-2');
  });

  it('surfaces non-collision errors instead of retrying', async () => {
    const onCreate = vi
      .fn<(input: MatOSCreateProjectInput) => Promise<boolean>>()
      .mockRejectedValue(new Error('disk full'));
    renderModal(onCreate);

    await waitFor(() => {
      expect((screen.getByTestId('matos-np-location') as HTMLSelectElement).value).toBe('workspace');
    });
    fireEvent.change(screen.getByTestId('matos-np-name'), { target: { value: 'Demo' } });
    fireEvent.click(screen.getByTestId('matos-np-create'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('disk full');
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('requires a project name', async () => {
    const onCreate = vi.fn<(input: MatOSCreateProjectInput) => Promise<boolean>>(
      async () => true,
    );
    renderModal(onCreate);

    // Create stays disabled with an empty name.
    expect((screen.getByTestId('matos-np-create') as HTMLButtonElement).disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
