// @vitest-environment jsdom
//
// Stale-chunk recovery contract: a failed dynamic import must trigger one
// full reload per guard window (self-heal after a static-export rebuild
// replaced the hashed chunks), and repeated failures inside the window must
// rethrow so a genuinely broken build still surfaces to the error screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverStaleChunkImport } from '../../src/utils/lazyWithReload';

function pendingProbe(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

describe('recoverStaleChunkImport', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    vi.useRealTimers();
  });

  it('reloads once and keeps the import promise pending', async () => {
    const reload = vi.fn();
    const promise = recoverStaleChunkImport(new Error('ChunkLoadError'), reload);
    const probe = pendingProbe(promise);

    expect(reload).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(probe.settled()).toBe(false);
  });

  it('rethrows instead of reload-looping while inside the guard window', () => {
    const reload = vi.fn();
    void recoverStaleChunkImport(new Error('first failure'), reload);
    expect(reload).toHaveBeenCalledTimes(1);

    const second = new Error('second failure');
    expect(() => recoverStaleChunkImport(second, reload)).toThrow(second);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('allows another reload after the guard window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00Z'));
    const reload = vi.fn();
    void recoverStaleChunkImport(new Error('first'), reload);
    expect(reload).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-07-09T00:00:31Z'));
    void recoverStaleChunkImport(new Error('later'), reload);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('still reloads when sessionStorage is unavailable', () => {
    const reload = vi.fn();
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('storage disabled');
      });
    try {
      void recoverStaleChunkImport(new Error('boom'), reload);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      getItem.mockRestore();
    }
  });
});
