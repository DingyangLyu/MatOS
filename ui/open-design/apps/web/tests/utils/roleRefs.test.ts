import { describe, expect, it } from 'vitest';

import {
  canonicalRosterRef,
  findByRoleRef,
  includeRoleRef,
  projectRoleRefsFromMetadata,
  projectRunnableRoleRefs,
  resolveProjectRoleSelection,
  resolveProjectRunRoleRef,
  roleRefIdentity,
  roleRefRecordValue,
  sameRoleRef,
} from '../../src/utils/roleRefs';

describe('MatOS role ref identity', () => {
  it('keeps chat binding stable when an asset version changes', () => {
    expect(roleRefIdentity(' role:compute@0.1.0 ')).toBe('role:compute');
    expect(sameRoleRef('role:compute@0.1.0', 'role:compute@2.0.0')).toBe(true);
    expect(sameRoleRef('role:compute', 'role:workflow-builder')).toBe(false);
  });

  it('resolves catalog, metadata, and roster values version-insensitively', () => {
    const catalog = [
      { ref: 'role:compute@2.0.0', label: 'Compute' },
      { ref: 'role:workflow-builder@1.0.0', label: 'Workflow Builder' },
    ];
    expect(findByRoleRef(catalog, 'role:compute@0.1.0')?.label).toBe('Compute');
    expect(roleRefRecordValue(
      { 'role:compute@0.1.0': 'Materials expert' },
      'role:compute@2.0.0',
    )).toBe('Materials expert');
    expect(canonicalRosterRef(
      ['role:compute@2.0.0', 'role:workflow-builder@1.0.0'],
      'role:compute@0.1.0',
    )).toBe('role:compute@2.0.0');
  });

  it('keeps Home-selected roles in the roster without duplicating pinned versions', () => {
    expect(includeRoleRef(['role:compute@1.0.0'], 'role:compute@2.0.0')).toEqual([
      'role:compute@1.0.0',
    ]);
    expect(includeRoleRef(['role:compute'], 'role:deep-research')).toEqual([
      'role:compute',
      'role:deep-research',
    ]);
  });

  it('fails a stale global role pick back to a project member', () => {
    expect(resolveProjectRunRoleRef(
      ['role:compute@1.0.0'],
      'role:deep-research',
    )).toBe('role:compute@1.0.0');
    expect(resolveProjectRunRoleRef(
      ['role:compute@1.0.0', 'role:deep-research@2.0.0'],
      'role:deep-research',
    )).toBe('role:deep-research@2.0.0');
    expect(resolveProjectRunRoleRef([], 'role:deep-research')).toBe('role:deep-research');
  });

  it('dedupes project roster versions and applies ordered inheritance', () => {
    const roster = projectRoleRefsFromMetadata({
      members: [
        'role:compute@1.0.0',
        'role:compute@2.0.0',
        'invalid',
        'role:deep-research@0.2.0',
      ],
    });
    expect(roster).toEqual([
      'role:compute@1.0.0',
      'role:deep-research@0.2.0',
    ]);
    expect(resolveProjectRoleSelection(roster, [
      'role:removed-conversation-member',
      'role:deep-research',
      'role:compute',
    ])).toBe('role:deep-research@0.2.0');
    expect(resolveProjectRoleSelection(roster, [null, 'default'])).toBe(
      'role:compute@1.0.0',
    );
  });

  it('adds selected role assets to the runnable project boundary', () => {
    expect(projectRunnableRoleRefs(
      ['role:compute@1.0.0'],
      [
        'skill:fixture@1.0.0',
        'role:compute@2.0.0',
        'role:private-alloy-agent@1.0.0',
      ],
    )).toEqual([
      'role:compute@1.0.0',
      'role:private-alloy-agent@1.0.0',
    ]);
  });
});
