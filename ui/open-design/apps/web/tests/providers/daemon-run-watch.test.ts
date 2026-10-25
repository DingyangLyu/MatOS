// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRunStatusResponse } from '@open-design/contracts';
import { watchDaemonRunTerminal } from '../../src/providers/daemon-run-watch';

const succeeded = { status: 'succeeded' } as ChatRunStatusResponse;

describe('daemon terminal reconciliation lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('probes on foreground return without waiting for the idle interval', async () => {
    const reconnect = vi.fn();
    const probe = vi.fn(async () => succeeded);
    const watch = watchDaemonRunTerminal({ probe, reconnect });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(probe).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('does not interrupt replay when progress arrives during a status probe', async () => {
    let resolve!: (value: ChatRunStatusResponse) => void;
    const probe = vi.fn(() => new Promise<ChatRunStatusResponse>(done => { resolve = done; }));
    const reconnect = vi.fn();
    const watch = watchDaemonRunTerminal({ probe, reconnect });
    document.dispatchEvent(new Event('visibilitychange'));
    watch.progress();
    resolve(succeeded);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnect).not.toHaveBeenCalled();
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off while application events are arriving', async () => {
    const probe = vi.fn(async () => succeeded);
    const watch = watchDaemonRunTerminal({ probe, reconnect: vi.fn() });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      watch.progress();
    }
    expect(probe).not.toHaveBeenCalled();
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts stalled probes and never overlaps them', async () => {
    const signals: AbortSignal[] = [];
    const probe = vi.fn((signal: AbortSignal) => new Promise<null>((resolve) => {
      signals.push(signal);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }));
    const reconnect = vi.fn();
    const watch = watchDaemonRunTerminal({ probe, reconnect });
    await vi.advanceTimersByTimeAsync(15_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(2);
    watch.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[1]?.aborted).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
