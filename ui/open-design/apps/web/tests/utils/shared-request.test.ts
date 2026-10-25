import { describe, expect, it, vi } from 'vitest';

import { createSharedRequest } from '../../src/utils/shared-request';

describe('createSharedRequest', () => {
  it('coalesces concurrent callers and reuses the result inside the TTL', async () => {
    const load = vi.fn(async () => ['one']);
    const request = createSharedRequest<string[]>({ ttlMs: 1_000 });

    const [first, second] = await Promise.all([
      request.get(load),
      request.get(load),
    ]);
    const third = await request.get(load);

    expect(first).toEqual(['one']);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('joins an existing request even when a concurrent caller asks for fresh data', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((done) => {
      resolve = done;
    }));
    const request = createSharedRequest<string>({ ttlMs: 1_000 });

    const first = request.get(load);
    const second = request.get(load, { force: true });
    resolve('ready');

    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache rejected requests and supports explicit invalidation', async () => {
    const request = createSharedRequest<number>({ ttlMs: 10_000 });
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    await expect(request.get(load)).rejects.toThrow('offline');
    await expect(request.get(load)).resolves.toBe(1);
    request.invalidate();
    await expect(request.get(load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not let a pre-invalidation request absorb the mutation refresh', async () => {
    let resolveOld!: (value: string) => void;
    let resolveFresh!: (value: string) => void;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((done) => {
        resolveOld = done;
      }))
      .mockImplementationOnce(() => new Promise<string>((done) => {
        resolveFresh = done;
      }));
    const request = createSharedRequest<string>({ ttlMs: 10_000 });

    const oldRead = request.get(load);
    request.invalidate();
    const freshRead = request.get(load, { force: true });

    expect(load).toHaveBeenCalledTimes(2);
    resolveFresh('after mutation');
    await expect(freshRead).resolves.toBe('after mutation');
    resolveOld('before mutation');
    await expect(oldRead).resolves.toBe('before mutation');
    await expect(request.get(load)).resolves.toBe('after mutation');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
