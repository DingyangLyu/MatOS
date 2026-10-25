export interface StaleWhileRevalidateOptions<T> {
  load: () => Promise<T>;
  freshMs: number;
  staleMs: number;
  now?: () => number;
  onBackgroundError?: (error: unknown) => void;
}

export interface StaleWhileRevalidateCache<T> {
  get: () => Promise<T>;
  refresh: () => Promise<T>;
  invalidate: () => void;
  peek: () => T | null;
}

/**
 * Small process-local read cache for expensive, side-effect-free projections.
 *
 * - cold/too-old reads await one shared loader promise;
 * - fresh reads return immediately;
 * - stale-but-usable reads return immediately and refresh in the background.
 *
 * Failed refreshes never evict the last usable value. Callers still see a
 * cold-load error when no successful snapshot has ever been produced.
 */
export function createStaleWhileRevalidateCache<T>(
  options: StaleWhileRevalidateOptions<T>,
): StaleWhileRevalidateCache<T> {
  const now = options.now ?? Date.now;
  const freshMs = Math.max(0, options.freshMs);
  const staleMs = Math.max(freshMs, options.staleMs);
  let cached: { at: number; value: T } | null = null;
  let generation = 0;
  let inFlight: { generation: number; promise: Promise<T> } | null = null;

  const refresh = (): Promise<T> => {
    if (inFlight?.generation === generation) return inFlight.promise;
    const refreshGeneration = generation;
    const pending = options.load().then((value) => {
      if (generation === refreshGeneration) cached = { at: now(), value };
      return value;
    });
    const flight = { generation: refreshGeneration, promise: pending };
    inFlight = flight;
    pending.then(
      () => {
        if (inFlight === flight) inFlight = null;
      },
      () => {
        if (inFlight === flight) inFlight = null;
      },
    );
    return pending;
  };

  return {
    async get(): Promise<T> {
      if (!cached) return refresh();
      const age = Math.max(0, now() - cached.at);
      if (age <= freshMs) return cached.value;
      if (age <= staleMs) {
        void refresh().catch((error) => options.onBackgroundError?.(error));
        return cached.value;
      }
      return refresh();
    },
    refresh,
    invalidate(): void {
      generation += 1;
      cached = null;
      // Do not let a pre-mutation refresh satisfy the next read. Its promise
      // may still settle for existing callers, but the generation guard above
      // prevents it from repopulating the cache.
      inFlight = null;
    },
    peek(): T | null {
      return cached?.value ?? null;
    },
  };
}
