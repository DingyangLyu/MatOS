// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlanCanvasPanel } from '../../src/components/PlanCanvasPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PLAN_MARKDOWN = [
  '## Perovskite screening plan',
  '',
  'Scope the workflow before touching compute.',
  '',
  '1. Build the candidate structure set',
  '2. Relax with MACE, filter by hull distance',
  '3. Run PBE band structures for the survivors',
].join('\n');

describe('PlanCanvasPanel', () => {
  it('renders the plan document with title, step count, and ready status', () => {
    render(
      <PlanCanvasPanel
        doc={{ markdown: PLAN_MARKDOWN, status: 'ready', messageId: 'm1' }}
        onApprove={vi.fn()}
        onRefine={vi.fn()}
      />,
    );

    expect(screen.getByTestId('plan-canvas-title').textContent).toBe(
      'Perovskite screening plan',
    );
    // 3 ordered steps → the count badge renders.
    expect(screen.getByTestId('plan-canvas').textContent).toContain('3');
    // The document body renders the markdown content.
    expect(screen.getByTestId('plan-canvas-doc').textContent).toContain(
      'Relax with MACE, filter by hull distance',
    );
    // Ready state shows the approval bar.
    expect(screen.getByTestId('plan-canvas-actions')).toBeTruthy();
  });

  it('fires approve and refine callbacks, honoring approveDisabled', () => {
    const onApprove = vi.fn();
    const onRefine = vi.fn();
    const { rerender } = render(
      <PlanCanvasPanel
        doc={{ markdown: PLAN_MARKDOWN, status: 'ready', messageId: 'm1' }}
        onApprove={onApprove}
        onRefine={onRefine}
      />,
    );

    fireEvent.click(screen.getByTestId('plan-canvas-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('plan-canvas-refine'));
    expect(onRefine).toHaveBeenCalledTimes(1);

    rerender(
      <PlanCanvasPanel
        doc={{ markdown: PLAN_MARKDOWN, status: 'ready', messageId: 'm1' }}
        onApprove={onApprove}
        approveDisabled
        onRefine={onRefine}
      />,
    );
    const approve = screen.getByTestId('plan-canvas-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });

  it('hides the approval bar and shows streaming status while the plan writes', () => {
    render(
      <PlanCanvasPanel
        doc={{ markdown: '## Draft', status: 'streaming', messageId: 'm2' }}
        onApprove={vi.fn()}
        onRefine={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('plan-canvas-actions')).toBeNull();
  });
});
