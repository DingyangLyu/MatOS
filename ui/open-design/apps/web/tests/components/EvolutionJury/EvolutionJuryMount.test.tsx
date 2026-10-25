// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvolutionJuryMount } from '../../../src/components/EvolutionJury/EvolutionJuryMount';
import type {
  EvolutionPanelView,
  EvolutionReviewCase,
} from '../../../src/components/matos-evolution-client';

afterEach(() => cleanup());

function panelWith(cases: EvolutionReviewCase[]): EvolutionPanelView {
  return {
    sessionId: 'session-1',
    generatedAt: '2026-07-09T12:00:00.000Z',
    cases,
  };
}

function reviewingCase(overrides: Partial<EvolutionReviewCase> = {}): EvolutionReviewCase {
  return {
    caseId: 'user-feedback:evt-1',
    sessionId: 'session-1',
    triggerKind: 'user-feedback',
    phase: 'reviewing',
    status: 'analysis-complete',
    summary: 'user corrected the tool call twice',
    createdAt: '2026-07-09T11:58:00.000Z',
    updatedAt: '2026-07-09T11:59:00.000Z',
    stages: [
      { role: 'scout', state: 'done' },
      { role: 'critic', state: 'done' },
      { role: 'refiner', state: 'pending' },
      { role: 'editor', state: 'active' },
      { role: 'judge', state: 'pending' },
    ],
    critic: {
      shouldUseFeedback: true,
      signalCount: 1,
      decisionCount: 1,
      topAction: 'update-skill',
      summary: 'user corrected the tool call twice',
    },
    editor: null,
    judge: null,
    experienceRefs: [],
    ...overrides,
  };
}

describe('<EvolutionJuryMount>', () => {
  it('renders nothing and never polls while disabled', () => {
    const fetchPanel = vi.fn(async () => panelWith([reviewingCase()]));
    const { container } = render(
      <EvolutionJuryMount enabled={false} fetchPanel={fetchPanel} />,
    );
    expect(container.firstChild).toBeNull();
    expect(fetchPanel).not.toHaveBeenCalled();
  });

  it('renders nothing when the panel has no recent cases', async () => {
    const fetchPanel = vi.fn(async () => panelWith([]));
    const { container } = render(<EvolutionJuryMount enabled fetchPanel={fetchPanel} />);
    await waitFor(() => expect(fetchPanel).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('projects an in-flight review with pipeline steps and focus bubble', async () => {
    const fetchPanel = vi.fn(async () => panelWith([reviewingCase()]));
    render(<EvolutionJuryMount enabled fetchPanel={fetchPanel} />);

    const region = await screen.findByRole('region', { name: 'Self-Evolution Jury' });
    expect(region).toHaveAttribute('data-phase', 'reviewing');
    expect(region).toHaveAttribute('data-deliberating', 'true');

    const steps = region.querySelectorAll('.evo-jury-step');
    expect(steps).toHaveLength(5);
    expect(steps[0]).toHaveAttribute('data-role', 'scout');
    expect(steps[3]).toHaveAttribute('data-role', 'editor');
    expect(steps[3]).toHaveAttribute('data-state', 'active');
    expect(steps[3]).toHaveAttribute('data-flow', 'true');

    expect(screen.getByText('Adopted as an evolution signal')).toBeTruthy();
    expect(region.querySelector('.evo-jury-focus')).toBeTruthy();
    expect(screen.getByText('3/5 stages')).toBeTruthy();
  });

  it('collapses settled reviews by default and expands on demand', async () => {
    const settled = reviewingCase({
      phase: 'accepted',
      status: 'direct-edit-complete',
      stages: [
        { role: 'scout', state: 'done' },
        { role: 'critic', state: 'done' },
        { role: 'refiner', state: 'skipped' },
        { role: 'editor', state: 'done' },
        { role: 'judge', state: 'done' },
      ],
      editor: {
        status: 'accepted',
        updatedAssets: ['skill:compute-runbook@0.1.0'],
        createdAssets: [],
        disabledAssets: [],
      },
      judge: {
        verdict: 'accept',
        confidence: 0.86,
        reason: 'edit matches the observed failure',
        overfitRisk: 'low',
        pollutionRisk: 'low',
      },
    });
    const fetchPanel = vi.fn(async () => panelWith([settled]));
    render(<EvolutionJuryMount enabled fetchPanel={fetchPanel} />);

    const collapsed = await screen.findByRole('status', { name: 'Self-Evolution Jury' });
    expect(collapsed).toHaveClass('evo-jury-collapsed');
    expect(collapsed).toHaveAttribute('data-phase', 'accepted');
    expect(collapsed.closest('.evo-jury-stack')).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByText('86%')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Self-Evolution Jury' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Show review details'));
    const region = await screen.findByRole('region', { name: 'Self-Evolution Jury' });
    expect(region).toHaveAttribute('data-phase', 'accepted');
    expect(region.closest('.evo-jury-stack')).toHaveAttribute('data-expanded', 'true');
    expect(region.querySelector('.evo-jury-confidence')).not.toBeNull();
    expect(screen.getByText('skill:compute-runbook')).toBeTruthy();
  });

  it('lists older settled cases as compact recent entries', async () => {
    const older = reviewingCase({
      caseId: 'session-end:session-0',
      triggerKind: 'session-end',
      phase: 'skipped',
      status: 'skipped-low-quality-trigger',
      summary: 'no meaningful agent behavior',
    });
    const fetchPanel = vi.fn(async () => panelWith([reviewingCase(), older]));
    render(<EvolutionJuryMount enabled fetchPanel={fetchPanel} />);

    const recent = await waitFor(() => {
      const list = document.querySelector('.evo-jury-recent');
      expect(list).not.toBeNull();
      return list!;
    });
    expect(recent.querySelectorAll('.evo-jury-recent-item')).toHaveLength(1);
    expect(recent.textContent).toContain('Session end');
  });

  it('hides failed retries superseded by an accepted feedback case', async () => {
    const accepted = reviewingCase({
      caseId: 'user-feedback:evt-1:accepted-retry',
      phase: 'accepted',
      status: 'direct-edit-complete',
    });
    const superseded = reviewingCase({
      caseId: 'user-feedback:evt-1:failed-retry',
      phase: 'failed',
      status: 'failed',
    });
    const unrelated = reviewingCase({
      caseId: 'session-end:session-0',
      triggerKind: 'session-end',
      phase: 'skipped',
      status: 'skipped-low-quality-trigger',
    });
    const fetchPanel = vi.fn(async () => panelWith([accepted, superseded, unrelated]));
    render(<EvolutionJuryMount enabled fetchPanel={fetchPanel} />);

    const recent = await waitFor(() => {
      const list = document.querySelector('.evo-jury-recent');
      expect(list).not.toBeNull();
      return list!;
    });
    expect(recent.querySelectorAll('.evo-jury-recent-item')).toHaveLength(1);
    expect(recent.textContent).toContain('Session end');
    expect(recent.textContent).not.toContain('Failed');
  });
});
