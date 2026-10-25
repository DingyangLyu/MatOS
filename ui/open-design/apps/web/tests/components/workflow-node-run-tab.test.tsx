// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { WorkflowNodeRunTab } from '../../src/components/workflow-node-run-tab';
import {
  fetchWorkflowRunNodeDetail,
  type WorkflowRunNodeSummary,
} from '../../src/components/matos-workflow-client';

vi.mock('../../src/components/matos-workflow-client', async (original) => ({
  ...(await original<typeof import('../../src/components/matos-workflow-client')>()),
  fetchWorkflowRunNodeDetail: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const pending: WorkflowRunNodeSummary = {
  nodeId: 'later',
  status: 'pending',
  attempts: 0,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  error: null,
};

it('shows unstarted nodes as waiting without requesting a nonexistent attempt', async () => {
  render(
    <I18nProvider>
      <WorkflowNodeRunTab runId="run-1" nodeId="later" liveNode={pending} />
    </I18nProvider>,
  );
  expect(screen.getByText('This step has not started yet.')).toBeTruthy();
  expect(fetchWorkflowRunNodeDetail).not.toHaveBeenCalled();
});

it('recovers a failed detail request while the node remains running', async () => {
  vi.useFakeTimers();
  const running = { ...pending, status: 'running', attempts: 1, startedAt: '2026-09-13T00:00:00Z' };
  vi.mocked(fetchWorkflowRunNodeDetail)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ...running, output: { stdout: 'recovered output' } });
  render(
    <I18nProvider>
      <WorkflowNodeRunTab runId="run-1" nodeId="later" liveNode={running} />
    </I18nProvider>,
  );
  await act(async () => {});
  expect(screen.getByText('offline')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(screen.queryByText('offline')).toBeNull();
  expect(screen.getByText('recovered output')).toBeTruthy();
});
