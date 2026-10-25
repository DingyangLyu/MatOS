// @vitest-environment jsdom

// The MatOS role picker replaced the Home composer's design-system card. It
// binds to the matos agent's model-option catalog (`role:<id>` refs plus a
// synthetic `default` row) and lazily hydrates the right-hand preview from
// `/api/matos/roles` on first open. These specs lock the selection contract:
// `onChange(id | null)` where null = "Default role (MatOS env)".

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatOSRolePicker } from '../../src/components/MatOSRolePicker';
import { resetMatOSRolesCacheForTests } from '../../src/runtime/matos-roles';
import { I18nProvider } from '../../src/i18n';

const ROLE_OPTIONS = [
  { id: 'default', label: 'Default role (MatOS env)' },
  { id: 'role:compute', label: 'Compute' },
  { id: 'role:academic', label: 'Academic Research' },
];

const ROLE_DETAILS = {
  roles: [
    {
      ref: 'role:compute',
      id: 'compute',
      name: 'Compute',
      description: 'DFT / MD compute role with VASP, QE, and LAMMPS toolchains.',
      tags: ['materials', 'compute'],
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

function isMatOSRolesUrl(url: RequestInfo | URL): boolean {
  const value = String(url);
  return value === '/api/matos/roles' || value === '/api/matos/roles?refresh=1';
}

beforeEach(() => {
  resetMatOSRolesCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (isMatOSRolesUrl(url)) {
      return new Response(JSON.stringify(ROLE_DETAILS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderPicker(props: Partial<ComponentProps<typeof MatOSRolePicker>> = {}) {
  return render(
    <I18nProvider initial="en">
      <MatOSRolePicker
        roles={ROLE_OPTIONS}
        selectedRoleId="role:compute"
        onChange={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

describe('MatOSRolePicker', () => {
  it('shows the selected role label on the trigger and checks it in the list', async () => {
    renderPicker();

    expect(screen.getByTestId('home-hero-matos-role-trigger').textContent).toContain('Compute');

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const option = await screen.findByTestId('matos-role-picker-option-compute');
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('matos-role-picker-option-compute-check')).toBeTruthy();
    // The default row is not checked while a concrete role is selected.
    expect(screen.queryByTestId('matos-role-picker-option-default-check')).toBeNull();
  });

  it('falls back to the default-role label when nothing is selected', () => {
    renderPicker({ selectedRoleId: null });
    expect(screen.getByTestId('home-hero-matos-role-trigger').textContent).toContain('Default role');
  });

  it('reports the picked role ref and closes; the default row reports null', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    fireEvent.mouseDown(await screen.findByTestId('matos-role-picker-option-academic'));
    expect(onChange).toHaveBeenCalledWith('role:academic');
    await waitFor(() => {
      expect(screen.queryByTestId('matos-role-picker-popover')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    fireEvent.mouseDown(await screen.findByTestId('matos-role-picker-option-default'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('selects a role with keyboard activation', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const option = await screen.findByTestId('matos-role-picker-option-academic');
    option.focus();
    fireEvent.keyDown(option, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('role:academic');
  });

  it('hydrates the preview pane from /api/matos/roles on first open', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));

    // The selected role previews by default; its rich description arrives
    // from the lazy details fetch.
    const preview = await screen.findByTestId('matos-role-picker-preview');
    await waitFor(() => {
      expect(preview.textContent).toContain('DFT / MD compute role');
    });
    expect(preview.textContent).toContain('role:compute');
    // Tags render as individual capability chips in the scene-banner preview.
    expect(preview.textContent).toContain('materials');
    expect(preview.textContent).toContain('compute');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/matos/roles?refresh=1', expect.anything());
  });

  it('filters roles by search text against label and fetched description', async () => {
    renderPicker();

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const popover = await screen.findByTestId('matos-role-picker-popover');
    // Wait for details so description-based matching is loaded.
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    fireEvent.change(within(popover).getByTestId('matos-role-picker-search'), {
      target: { value: 'literature' },
    });
    await waitFor(() => {
      expect(within(popover).getByTestId('matos-role-picker-option-academic')).toBeTruthy();
      expect(within(popover).queryByTestId('matos-role-picker-option-compute')).toBeNull();
    });

    fireEvent.change(within(popover).getByTestId('matos-role-picker-search'), {
      target: { value: 'no-such-role' },
    });
    expect(within(popover).queryByTestId('matos-role-picker-option-academic')).toBeNull();
  });

  it('merges registry-only roles from /api/matos/roles into the selectable list', async () => {
    // The agent's model options can lag the MatOS asset registry (static
    // fallback on a cold probe, registry growing via self-evolution / user
    // packs). Roles present in the registry catalog but missing from the
    // options must still be selectable.
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (isMatOSRolesUrl(url)) {
        return new Response(JSON.stringify({
          roles: [
            ...ROLE_DETAILS.roles,
            {
              ref: 'role:battery-lab',
              id: 'battery-lab',
              name: 'Battery Lab',
              description: 'Fresh registry role not in the probed options.',
              tags: ['battery'],
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const popover = await screen.findByTestId('matos-role-picker-popover');

    // Probed options render as before…
    expect(within(popover).getByTestId('matos-role-picker-option-compute')).toBeTruthy();
    // …and the registry-only role appears once details land, and is pickable.
    const merged = await within(popover).findByTestId('matos-role-picker-option-battery-lab');
    fireEvent.mouseDown(merged);
    expect(onChange).toHaveBeenCalledWith('role:battery-lab');
  });

  it('limits project conversations to invited roster roles', async () => {
    renderPicker({
      selectedRoleId: 'role:compute@1.0.0',
      allowedRoleRefs: ['role:compute@1.0.0'],
    });

    expect(screen.getByTestId('home-hero-matos-role-trigger').textContent).toContain('Compute');
    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const popover = await screen.findByTestId('matos-role-picker-popover');

    expect(within(popover).getByTestId('matos-role-picker-option-compute')).toBeTruthy();
    expect(within(popover).queryByTestId('matos-role-picker-option-academic')).toBeNull();
    expect(within(popover).queryByTestId('matos-role-picker-option-default')).toBeNull();
    expect(within(popover).queryByTestId('matos-role-picker-clear')).toBeNull();
  });

  it('keeps a project-bound private role selectable when the global role probe omits it', async () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      selectedRoleId: 'role:compute@1.0.0',
      allowedRoleRefs: [
        'role:compute@1.0.0',
        'role:private-alloy-agent@1.0.0',
      ],
    });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const privateRole = await screen.findByTestId(
      'matos-role-picker-option-private-alloy-agent@1.0.0',
    );
    expect(privateRole.textContent).toContain('private-alloy-agent');
    fireEvent.mouseDown(privateRole);
    expect(onChange).toHaveBeenCalledWith('role:private-alloy-agent@1.0.0');
  });

  it('labels a persisted registry-only selection on the trigger without opening', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (isMatOSRolesUrl(url)) {
        return new Response(JSON.stringify({
          roles: [
            {
              ref: 'role:battery-lab',
              id: 'battery-lab',
              name: 'Battery Lab',
              description: null,
              tags: [],
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    renderPicker({ selectedRoleId: 'role:battery-lab' });

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-matos-role-trigger').textContent).toContain('Battery Lab');
    });
  });

  it('summarizes role runtime overrides in the preview pane when present', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (isMatOSRolesUrl(url)) {
        return new Response(JSON.stringify({
          roles: [
            {
              ref: 'role:compute',
              id: 'compute',
              name: 'Compute',
              description: 'Compute role.',
              tags: [],
              runtime: {
                model: 'deepseek-v4-flash',
                effort: 'high',
                permissionMode: 'plan',
                maxTurns: 12,
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    renderPicker({ selectedRoleId: 'role:compute' });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    const runtime = await screen.findByTestId('matos-role-picker-preview-runtime');
    expect(runtime.textContent).toContain('deepseek-v4-flash');
    expect(runtime.textContent).toContain('high');
    expect(runtime.textContent).toContain('plan');
    expect(runtime.textContent).toContain('12');
  });

  it('keeps working when the details fetch fails (options still selectable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('daemon offline');
    }));
    const onChange = vi.fn();
    renderPicker({ onChange });

    fireEvent.click(screen.getByTestId('home-hero-matos-role-trigger'));
    fireEvent.mouseDown(await screen.findByTestId('matos-role-picker-option-compute'));
    expect(onChange).toHaveBeenCalledWith('role:compute');
  });
});
