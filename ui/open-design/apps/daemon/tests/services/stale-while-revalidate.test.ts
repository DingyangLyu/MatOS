import { describe, expect, it, vi } from 'vitest';
import { createStaleWhileRevalidateCache } from '../../src/services/stale-while-revalidate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('stale-while-revalidate cache', () => {
  it('single-flights concurrent cold reads', async () => {
    const pending = deferred<number>();
    const load = vi.fn(() => pending.promise);
    const cache = createStaleWhileRevalidateCache({
      load,
      freshMs: 100,
      staleMs: 1_000,
    });

    const first = cache.get();
    const second = cache.get();
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
  });

  it('serves stale data immediately while one background refresh runs', async () => {
    let now = 0;
    const refresh = deferred<number>();
    const load = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(() => refresh.promise);
    const cache = createStaleWhileRevalidateCache({
      load,
      freshMs: 100,
      staleMs: 1_000,
      now: () => now,
    });

    await expect(cache.get()).resolves.toBe(1);
    now = 101;
    await expect(Promise.all([cache.get(), cache.get()])).resolves.toEqual([1, 1]);
    expect(load).toHaveBeenCalledTimes(2);

    refresh.resolve(2);
    await refresh.promise;
    await Promise.resolve();
    expect(cache.peek()).toBe(2);
  });

  it('keeps the last usable value when a background refresh fails', async () => {
    let now = 0;
    const onBackgroundError = vi.fn();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('stable')
      .mockRejectedValueOnce(new Error('refresh failed'));
    const cache = createStaleWhileRevalidateCache({
      load,
      freshMs: 10,
      staleMs: 100,
      now: () => now,
      onBackgroundError,
    });

    await cache.get();
    now = 11;
    await expect(cache.get()).resolves.toBe('stable');
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledOnce());
    expect(cache.peek()).toBe('stable');
  });

  it('does not let a pre-invalidation refresh repopulate the cache', async () => {
    const oldLoad = deferred<string>();
    const newLoad = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => oldLoad.promise)
      .mockImplementationOnce(() => newLoad.promise);
    const cache = createStaleWhileRevalidateCache({
      load,
      freshMs: 100,
      staleMs: 1_000,
    });

    const oldRead = cache.get();
    cache.invalidate();
    const newRead = cache.get();
    expect(load).toHaveBeenCalledTimes(2);

    oldLoad.resolve('old');
    await expect(oldRead).resolves.toBe('old');
    expect(cache.peek()).toBeNull();

    newLoad.resolve('new');
    await expect(newRead).resolves.toBe('new');
    expect(cache.peek()).toBe('new');
  });
});
