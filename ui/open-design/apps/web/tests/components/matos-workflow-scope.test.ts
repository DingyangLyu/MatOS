import { afterEach, expect, it, vi } from 'vitest';
import { controlWorkflowRun, fetchWorkflowRunEvents, fetchWorkflowRunNodeDetail, fetchWorkflowRuns,
  fetchWorkflowRunStatus, preflightWorkflowRef, publishWorkflowDefinition, runWorkflowRef, validateWorkflowDefinition,
} from '../../src/components/matos-workflow-client';

afterEach(() => vi.unstubAllGlobals());

it('keeps every workflow endpoint in the explicitly selected project', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
    validation: {}, published: {}, preflight: {}, run: {}, runs: [], events: [], node: { nodeId: 'node-1' },
  }));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const scope = { projectId: 'project-a', signal: controller.signal };
  await validateWorkflowDefinition({}, 'scene', scope);
  await publishWorkflowDefinition({ definition: {}, label: 'scene' }, scope);
  await preflightWorkflowRef('workflow:scene', {}, scope);
  await runWorkflowRef('workflow:scene', {}, scope);
  await fetchWorkflowRuns('scene v1', scope);
  await fetchWorkflowRunStatus('run-1', scope);
  await fetchWorkflowRunEvents('run-1', 25, scope);
  await fetchWorkflowRunNodeDetail('run-1', 'node-1', scope);
  await controlWorkflowRun('run-1', 'cancel', undefined, scope);
  expect(fetcher).toHaveBeenCalledTimes(9);
  for (const [url, init] of fetcher.mock.calls) {
    expect(new URL(url, 'http://localhost').searchParams.get('projectId')).toBe('project-a');
    if (init?.method !== 'POST') expect(init?.signal?.aborted).toBe(false);
  }
  controller.abort();
  for (const [, init] of fetcher.mock.calls) {
    // The client combines the caller signal with its timeout signal.
    if (init?.method !== 'POST') expect(init?.signal?.aborted).toBe(true);
  }
  expect(fetcher.mock.calls[4]?.[0]).toBe('/api/matos/workflow/runs?query=scene%20v1&projectId=project-a');
  expect(fetcher.mock.calls[6]?.[0]).toBe('/api/matos/workflow/run/run-1/events?tail=25&projectId=project-a');
});

it('rejects invalid project identities and preserves standalone callers', async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json({ run: {} }));
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchWorkflowRunStatus('run-1', { projectId: '../foreign' })).rejects.toThrow('Invalid project ID');
  expect(fetcher).not.toHaveBeenCalled();
  await fetchWorkflowRunStatus('run-1');
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/matos/workflow/run/run-1');
});
