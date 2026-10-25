// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../src/i18n';
import {
  WorkflowRunPanel,
  workflowStatusLabelKey,
} from '../../src/components/workflow-run-panel';
import type {
  WorkflowRunNodeSummary,
  WorkflowRunSummary,
} from '../../src/components/matos-workflow-client';

afterEach(() => {
  cleanup();
});

function node(nodeId: string, status: string): WorkflowRunNodeSummary {
  return {
    nodeId,
    status,
    attempts: 1,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
  };
}

function runWith(nodes: WorkflowRunNodeSummary[], overrides?: Partial<WorkflowRunSummary>): WorkflowRunSummary {
  return {
    runId: 'run-test',
    status: 'waiting_input',
    waitingNodeId: null,
    nodes,
    activeNodeIds: [],
    pendingApprovals: [],
    budget: null,
    outputs: null,
    ...overrides,
  };
}

function renderPanel(run: WorkflowRunSummary, onControl = vi.fn()) {
  render(
    <I18nProvider>
      <WorkflowRunPanel
        run={run}
        events={[]}
        busyAction={null}
        onControl={onControl}
        onSelectNode={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>,
  );
  return onControl;
}

describe('workflow run panel waiting_input', () => {
  it('maps waiting_input to a localized status label', () => {
    // Native human/dynamic nodes park in `waiting_input`; before the fix the
    // panel rendered the raw enum because the status was not in the known set.
    expect(workflowStatusLabelKey('waiting_input')).toBe('workflow.status.waiting_input');
    expect(workflowStatusLabelKey('WAITING_INPUT')).toBe('workflow.status.waiting_input');
  });

  it('offers a reply form for a waiting_input node and sends respond', () => {
    const onControl = renderPanel(
      runWith([node('ask', 'waiting_input')], { waitingNodeId: 'ask' }),
    );

    const form = screen.getByTestId('workflow-respond-ask');
    const input = form.querySelector('input');
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: 'yes, go ahead' } });
    fireEvent.submit(form);

    expect(onControl).toHaveBeenCalledWith('respond', {
      nodeId: 'ask',
      message: 'yes, go ahead',
    });
  });

  it('does not send empty replies', () => {
    const onControl = renderPanel(runWith([node('ask', 'waiting_input')]));
    fireEvent.submit(screen.getByTestId('workflow-respond-ask'));
    expect(onControl).not.toHaveBeenCalled();
  });

  it('keeps approve/deny (not the reply form) for waiting_approval nodes', () => {
    renderPanel(
      runWith([node('gate', 'waiting_approval')], {
        status: 'waiting_approval',
        waitingNodeId: 'gate',
        pendingApprovals: [
          { nodeId: 'gate', status: 'pending', fingerprint: null, requestedAt: null },
        ],
      }),
    );
    expect(screen.queryByTestId('workflow-respond-gate')).toBeNull();
  });
});
