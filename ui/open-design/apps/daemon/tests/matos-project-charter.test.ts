import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, renderMatOSProjectCharter } from '../src/prompts/system.js';

// The MatOS new-project form writes `metadata.goal` (mission) and
// `metadata.members` / `metadata.memberBriefs` (roster + division of labor).
// The composer must inject them as the "Project charter (MatOS)" block for
// every run in that project — that is the mechanism that makes all member
// roles work toward the same goal inside the shared project folder. These
// specs pin the render contract (present/absent, truncation, roster rows).

describe('renderMatOSProjectCharter', () => {
  it('renders mission + roster rows with briefs', () => {
    const out = renderMatOSProjectCharter({
      goal: 'Discover a stable solid-state electrolyte.',
      members: ['role:compute', 'role:academic'],
      memberBriefs: {
        'role:compute': 'Run DFT relaxations and report energies.',
        'role:academic': 'Survey prior art and keep the bibliography.',
      },
    });
    expect(out).toBeTruthy();
    expect(out).toContain('## Project charter (MatOS)');
    expect(out).toContain('**Mission**');
    expect(out).toContain('Discover a stable solid-state electrolyte.');
    expect(out).toContain('**Team roster & division of labor**');
    expect(out).toContain('- `role:compute` — Run DFT relaxations and report energies.');
    expect(out).toContain('- `role:academic` — Survey prior art and keep the bibliography.');
  });

  it('renders a bare roster row when a member has no brief', () => {
    const out = renderMatOSProjectCharter({
      goal: 'Ship it.',
      members: ['role:compute'],
    });
    expect(out).toContain('- `role:compute`');
    expect(out).not.toContain('- `role:compute` —');
  });

  it('renders per-member department names (aliases) in quotes', () => {
    const out = renderMatOSProjectCharter({
      goal: 'Ship it.',
      members: ['role:compute', 'role:academic'],
      memberNames: { 'role:compute': '算力老王' },
      memberBriefs: { 'role:compute': 'Run DFT relaxations.' },
    });
    // Aliased member: ref keeps its `role:` handle AND shows the alias.
    expect(out).toContain('- `role:compute` (“算力老王”) — Run DFT relaxations.');
    // Un-aliased member falls back to the bare ref row.
    expect(out).toContain('- `role:academic`');
    expect(out).not.toContain('role:academic` (');
    // The intro tells agents to hand off by the department name.
    expect(out).toContain('department name');
  });

  it('caps a runaway alias and ignores non-string aliases', () => {
    const out = renderMatOSProjectCharter({
      members: ['role:compute', 'role:academic'],
      memberNames: {
        'role:compute': 'n'.repeat(200),
        'role:academic': 5 as unknown as string,
      },
    });
    const aliasRun = /n{10,}/.exec(out ?? '')?.[0] ?? '';
    expect(aliasRun.length).toBe(80);
    expect(out).not.toContain('role:academic` (');
    expect(out).not.toContain('(“5”)');
  });

  it('renders mission-only and roster-only charters', () => {
    const missionOnly = renderMatOSProjectCharter({ goal: 'Mission only.' });
    expect(missionOnly).toContain('**Mission**');
    expect(missionOnly).not.toContain('**Team roster');

    const rosterOnly = renderMatOSProjectCharter({ members: ['role:compute'] });
    expect(rosterOnly).not.toContain('**Mission**');
    expect(rosterOnly).toContain('**Team roster');
  });

  it('returns null when there is no goal and no members', () => {
    expect(renderMatOSProjectCharter(undefined)).toBeNull();
    expect(renderMatOSProjectCharter({})).toBeNull();
    expect(renderMatOSProjectCharter({ goal: '   ' })).toBeNull();
    expect(renderMatOSProjectCharter({ members: [] })).toBeNull();
    // memberBriefs alone (orphaned briefs without a roster) do not render.
    expect(
      renderMatOSProjectCharter({ memberBriefs: { 'role:x': 'orphan' } }),
    ).toBeNull();
  });

  it('caps runaway goal and brief lengths', () => {
    const out = renderMatOSProjectCharter({
      goal: 'g'.repeat(5000),
      members: ['role:compute'],
      memberBriefs: { 'role:compute': 'b'.repeat(1000) },
    });
    expect(out).toBeTruthy();
    // Match the payload runs, not stray letters in the charter prose.
    const goalRun = /g{10,}/.exec(out ?? '')?.[0] ?? '';
    expect(goalRun.length).toBe(4000);
    const briefRun = /b{10,}/.exec(out ?? '')?.[0] ?? '';
    expect(briefRun.length).toBe(600);
  });

  it('skips non-string member refs and non-string briefs', () => {
    const out = renderMatOSProjectCharter({
      members: ['role:compute', '', 42 as unknown as string],
      memberBriefs: { 'role:compute': 7 as unknown as string },
    });
    expect(out).toContain('- `role:compute`');
    expect(out).not.toContain('42');
    expect(out).not.toContain('7');
  });
});

describe('composeSystemPrompt — project charter injection', () => {
  it('injects the charter block when metadata carries goal/members', () => {
    const out = composeSystemPrompt({
      metadata: {
        kind: 'other',
        goal: 'Build the MatOS battery screening pipeline.',
        members: ['role:compute'],
        memberBriefs: { 'role:compute': 'Own all DFT jobs.' },
      },
    });
    expect(out).toContain('## Project charter (MatOS)');
    expect(out).toContain('Build the MatOS battery screening pipeline.');
    expect(out).toContain('- `role:compute` — Own all DFT jobs.');
  });

  it('places the charter after project-level custom instructions', () => {
    const out = composeSystemPrompt({
      metadata: { kind: 'other', goal: 'Mission.' },
      projectInstructions: 'Use tabs.',
    });
    const instructionsAt = out.indexOf('Custom instructions (project-level)');
    const charterAt = out.indexOf('## Project charter (MatOS)');
    expect(instructionsAt).toBeGreaterThan(-1);
    expect(charterAt).toBeGreaterThan(instructionsAt);
  });

  it('emits no charter block for plain projects', () => {
    const out = composeSystemPrompt({ metadata: { kind: 'prototype' } });
    expect(out).not.toContain('## Project charter (MatOS)');
  });
});
