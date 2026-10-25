// @vitest-environment jsdom

// The MatOS invite dialog is the "who is in this department" surface. A
// project = a department; its members are invited MatOS roles, and each can be
// given a per-project custom name (alias). These specs pin the two behaviors
// the feature hinges on: (1) toggling roles in/out of the roster, and (2) the
// save payload — the deduped `role:<id>` roster plus a MINIMAL alias map that
// drops blanks and aliases equal to the role name (those fall back to the
// catalog name everywhere: sidebar, group @-bar, roster header, auto-relay).
//
// It also guards the layout-regression fix: rows must not be bare <label>s, or
// the global `.modal label { flex-direction: column }` rule stacks them into a
// broken column. We assert the row/roster nodes are buttons/divs, not labels.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemberInviteDialog } from '../../src/components/MemberInviteDialog';
import type { ProjectMemberRole } from '../../src/components/ProjectConversationsSidebar';
import { I18nProvider } from '../../src/i18n';

function role(ref: string, name: string, description?: string): ProjectMemberRole {
  return {
    ref,
    id: ref.replace(/^role:/, ''),
    name,
    roleName: name,
    aliased: false,
    description: description ?? null,
  };
}

const CATALOG: ProjectMemberRole[] = [
  role('role:compute', 'Compute', 'DFT / MD compute role.'),
  role('role:academic', 'Academic Research', 'Literature-focused research role.'),
  role('role:battery', 'Battery Modeling', 'Cell-level battery modeling.'),
];

function renderDialog(props?: {
  invitedRefs?: string[];
  invitedNames?: Record<string, string>;
}) {
  const onSave = vi.fn<(refs: string[], names: Record<string, string>) => void>();
  const onClose = vi.fn();
  render(
    <I18nProvider initial="en">
      <MemberInviteDialog
        catalog={CATALOG}
        invitedRefs={props?.invitedRefs ?? []}
        invitedNames={props?.invitedNames}
        onSave={onSave}
        onClose={onClose}
      />
    </I18nProvider>,
  );
  return { onSave, onClose };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemberInviteDialog', () => {
  it('lists the whole catalog and seeds the roster from invited refs', () => {
    renderDialog({ invitedRefs: ['role:compute'] });

    // Every catalog role is a pickable row.
    expect(screen.getByTestId('member-invite-row-compute')).toBeTruthy();
    expect(screen.getByTestId('member-invite-row-academic')).toBeTruthy();
    expect(screen.getByTestId('member-invite-row-battery')).toBeTruthy();

    // The already-invited member starts in the roster with a name input.
    expect(screen.getByTestId('member-invite-selected-compute')).toBeTruthy();
    expect(screen.queryByTestId('member-invite-selected-academic')).toBeNull();
    // Its catalog row reads as selected for assistive tech.
    expect(
      screen.getByTestId('member-invite-row-compute').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('does not use bare <label> rows (guards the .modal label layout bug)', () => {
    renderDialog({ invitedRefs: ['role:compute'] });
    expect(screen.getByTestId('member-invite-row-compute').tagName).toBe('BUTTON');
    expect(screen.getByTestId('member-invite-selected-compute').tagName).toBe('DIV');
    // No <label> anywhere in the dialog — that element is what inherited the
    // global stacked-form rule and broke the row layout in the first version.
    expect(screen.getByTestId('member-invite-dialog').querySelector('label')).toBeNull();
  });

  it('toggles a role into and out of the roster', () => {
    renderDialog();
    expect(screen.queryByTestId('member-invite-selected-academic')).toBeNull();

    fireEvent.click(screen.getByTestId('member-invite-row-academic'));
    expect(screen.getByTestId('member-invite-selected-academic')).toBeTruthy();

    // Clicking the same catalog row again removes it.
    fireEvent.click(screen.getByTestId('member-invite-row-academic'));
    expect(screen.queryByTestId('member-invite-selected-academic')).toBeNull();
  });

  it('removes a member from the roster via its remove button', () => {
    renderDialog({ invitedRefs: ['role:compute', 'role:academic'] });
    expect(screen.getByTestId('member-invite-selected-compute')).toBeTruthy();

    const removeBtn = screen
      .getByTestId('member-invite-selected-compute')
      .querySelector('button');
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn!);

    expect(screen.queryByTestId('member-invite-selected-compute')).toBeNull();
    expect(screen.getByTestId('member-invite-selected-academic')).toBeTruthy();
    // Catalog row de-selects too.
    expect(
      screen.getByTestId('member-invite-row-compute').getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('prefills existing aliases and saves a minimal alias map', () => {
    const { onSave } = renderDialog({
      invitedRefs: ['role:compute'],
      invitedNames: { 'role:compute': '算力老王' },
    });

    // The saved alias shows in the name input.
    expect((screen.getByTestId('member-invite-name-compute') as HTMLInputElement).value).toBe(
      '算力老王',
    );

    // Invite academic and give it a department name.
    fireEvent.click(screen.getByTestId('member-invite-row-academic'));
    fireEvent.change(screen.getByTestId('member-invite-name-academic'), {
      target: { value: '论文侠' },
    });

    fireEvent.click(screen.getByTestId('member-invite-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [refs, names] = onSave.mock.calls[0]!;
    expect(refs).toEqual(['role:compute', 'role:academic']);
    expect(names).toEqual({ 'role:compute': '算力老王', 'role:academic': '论文侠' });
  });

  it('drops blank aliases and aliases equal to the role name', () => {
    const { onSave } = renderDialog({ invitedRefs: ['role:compute', 'role:academic'] });

    // Alias identical to the catalog name is meaningless → dropped.
    fireEvent.change(screen.getByTestId('member-invite-name-compute'), {
      target: { value: 'Compute' },
    });
    // Whitespace-only alias → dropped.
    fireEvent.change(screen.getByTestId('member-invite-name-academic'), {
      target: { value: '   ' },
    });

    fireEvent.click(screen.getByTestId('member-invite-save'));

    const [refs, names] = onSave.mock.calls[0]!;
    expect(refs).toEqual(['role:compute', 'role:academic']);
    expect(names).toEqual({});
  });

  it('filters the catalog by the search query', () => {
    renderDialog();
    const search = screen.getByPlaceholderText('Search roles…');

    fireEvent.change(search, { target: { value: 'battery' } });
    expect(screen.getByTestId('member-invite-row-battery')).toBeTruthy();
    expect(screen.queryByTestId('member-invite-row-compute')).toBeNull();
    expect(screen.queryByTestId('member-invite-row-academic')).toBeNull();
  });
});
