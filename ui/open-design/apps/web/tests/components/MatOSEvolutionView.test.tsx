// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MatOSEvolutionView } from '../../src/components/MatOSEvolutionView';
import type {
  EvolutionOverview,
  EvolutionRunView,
} from '../../src/components/matos-evolution-client';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function proposal(overrides: Partial<EvolutionRunView> = {}): EvolutionRunView {
  return {
    runId: 'direct-editor-b',
    projectId: 'p1',
    projectName: 'Perovskites',
    status: 'proposed',
    statusReason: 'awaiting_human_approval',
    scope: 'project',
    scopeRef: 'project:p1',
    triggerKind: 'user-feedback',
    triggerSummary: 'The user asked for picometres as well.',
    summary: 'Report lattice constants in pm as well.',
    expectedBehaviorChange: 'Answers carry both units.',
    assetRefs: ['skill:answer-finalization@0.1.3'],
    changedFiles: ['.matos/assets/skills/answer-finalization/SKILL.md'],
    judge: { verdict: 'accept', confidence: 0.8, reason: 'explicit preference', overfitRisk: 'low', pollutionRisk: 'low' },
    proposal: { proposedAt: '2026-10-22T11:01:00.000Z', decision: null, decidedAt: null, note: null, lastApprovalError: null },
    createdAt: '2026-10-22T11:00:00.000Z',
    updatedAt: '2026-10-22T11:01:00.000Z',
    ...overrides,
  };
}

function overviewWith(proposals: EvolutionRunView[]): EvolutionOverview {
  const accepted = proposal({
    runId: 'direct-editor-a',
    status: 'accepted',
    statusReason: 'approved_by_user',
    assetRefs: ['skill:answer-finalization@0.1.2'],
    proposal: null,
  });
  return {
    generatedAt: '2026-10-22T11:05:00.000Z',
    proposals,
    history: [...proposals, accepted],
    lineage: [
      {
        assetKey: 'skill:answer-finalization',
        acceptedCount: 1,
        proposedCount: proposals.length,
        latestAt: '2026-10-22T11:01:00.000Z',
        branches: [
          {
            projectId: 'p1',
            projectName: 'Perovskites',
            scopeRef: 'project:p1',
            nodes: [
              { runId: null, version: '0.1.1', parentVersion: null, status: 'base', at: null, summary: null },
              { runId: 'direct-editor-a', version: '0.1.2', parentVersion: '0.1.1', status: 'accepted', at: null, summary: null },
              ...proposals.map((run) => ({
                runId: run.runId,
                version: '0.1.3',
                parentVersion: '0.1.2',
                status: 'proposed',
                at: null,
                summary: null,
              })),
            ],
          },
        ],
      },
    ],
  };
}

function stubDaemon() {
  let pending = [proposal()];
  let mode = 'manual';
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/matos/evolution/overview')) return json({ overview: overviewWith(pending) });
    if (url === '/api/matos/evolution/policy' && method === 'PUT') {
      mode = (body as { mode: string }).mode;
      return json({ policy: { mode, source: 'policy-file' } });
    }
    if (url === '/api/matos/evolution/policy') return json({ policy: { mode, source: 'default' } });
    if (url.endsWith('/approve') && method === 'POST') {
      pending = [];
      return json({ run: { ...proposal(), status: 'accepted' } });
    }
    if (url.includes('/diff')) return json({ diff: '+added line\n-removed line\n', truncated: false });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

describe('<MatOSEvolutionView>', () => {
  it('lists a proposal and approves it in its project', async () => {
    const { calls } = stubDaemon();
    render(<MatOSEvolutionView />);

    const card = await screen.findByTestId('evolution-proposal-direct-editor-b');
    expect(card.textContent).toContain('Report lattice constants in pm as well.');
    expect(card.textContent).toContain('Perovskites');

    fireEvent.click(screen.getByText('View changes'));
    expect((await screen.findByTestId('evolution-diff')).textContent).toContain('+added line');

    fireEvent.click(screen.getByTestId('evolution-approve-direct-editor-b'));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url === '/api/matos/evolution/runs/direct-editor-b/approve')).toBe(true),
    );
    const approval = calls.find((call) => call.url.endsWith('/approve'));
    expect(approval?.body).toEqual({ projectId: 'p1' });
    await waitFor(() => expect(screen.queryByTestId('evolution-proposal-direct-editor-b')).toBeNull());
    expect(screen.getByText('No edits are waiting for approval.')).toBeTruthy();
  });

  it('switches the approval mode', async () => {
    const { calls } = stubDaemon();
    render(<MatOSEvolutionView />);
    const manual = await screen.findByTestId('evolution-policy-manual');
    await waitFor(() => expect(manual.getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(screen.getByTestId('evolution-policy-auto'));
    await waitFor(() =>
      expect(screen.getByTestId('evolution-policy-auto').getAttribute('aria-checked')).toBe('true'),
    );
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ mode: 'auto' });
  });

  it('draws the evolution tree with the base, adopted and pending versions', async () => {
    stubDaemon();
    render(<MatOSEvolutionView />);
    const tree = await screen.findByTestId('evolution-tree-skill:answer-finalization');
    expect(tree.textContent).toContain('v0.1.1');
    expect(tree.textContent).toContain('v0.1.2');
    expect(tree.textContent).toContain('v0.1.3');
    expect(tree.querySelector('[data-status="proposed"]')).not.toBeNull();
  });
});
