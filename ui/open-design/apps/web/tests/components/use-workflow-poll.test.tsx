// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkflowPoll } from '../../src/components/workflow-studio/use-workflow-poll';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('aborts in-flight reads when changing scope, refreshing or leaving the view', async () => {
  const signals: AbortSignal[] = [];
  const first = async (signal: AbortSignal) => { signals.push(signal); return 'a'; };
  const second = async (signal: AbortSignal) => { signals.push(signal); return 'b'; };
  const { result, rerender, unmount } = renderHook(({ load }) => useWorkflowPoll(load), {
    initialProps: { load: first },
  });
  await act(async () => {});
  rerender({ load: second });
  await act(async () => {});
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  await act(async () => { result.current.refresh(); });
  expect(signals[1]?.aborted).toBe(true);
  expect(signals[2]?.aborted).toBe(false);
  unmount();
  expect(signals[2]?.aborted).toBe(true);
});

it('never displays records from the previous project while a new one loads', async () => {
  const first = async () => ['private-a'];
  let finish!: (value: string[]) => void;
  const second = () =>
    new Promise<string[]>((resolve) => {
      finish = resolve;
    });
  const { result, rerender } = renderHook(({ load }) => useWorkflowPoll(load), {
    initialProps: { load: first },
  });
  await act(async () => {});
  expect(result.current.data).toEqual(['private-a']);
  rerender({ load: second });
  expect(result.current.data).toBeNull();
  await act(async () => {
    finish(['project-b']);
  });
  expect(result.current.data).toEqual(['project-b']);
});

it('retries after errors without overlapping requests and preserves the last known state', async () => {
  vi.useFakeTimers();
  const load = vi
    .fn<() => Promise<string[]>>()
    .mockResolvedValueOnce(['running'])
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(['completed']);
  const { result } = renderHook(() => useWorkflowPoll(load, 100));
  await act(async () => {});
  expect(result.current.data).toEqual(['running']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(result.current.error).toBe('offline');
  expect(result.current.data).toEqual(['running']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(result.current.error).toBeNull();
  expect(result.current.data).toEqual(['completed']);
  expect(load).toHaveBeenCalledTimes(3);
});

it('ignores an old request that completes after switching sources', async () => {
  let finish!: (value: string) => void;
  const first = () =>
    new Promise<string>((resolve) => {
      finish = resolve;
    });
  const second = async () => 'new';
  const { result, rerender } = renderHook(({ load }) => useWorkflowPoll(load), {
    initialProps: { load: first },
  });
  rerender({ load: second });
  await act(async () => {});
  await act(async () => {
    finish('old');
  });
  expect(result.current.data).toBe('new');
});
