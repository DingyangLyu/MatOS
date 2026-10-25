export interface SharedRequestOptions {
  force?: boolean;
}

export interface SharedRequest<T> {
  get: (load: () => Promise<T>, options?: SharedRequestOptions) => Promise<T>;
  invalidate: () => void;
}

/**
 * Coalesces identical browser-side reads and keeps a very short-lived value
 * cache. Mutation paths retain control through `force` / `invalidate`; failed
 * reads are never cached, so a transient daemon outage remains retryable.
 */
export function createSharedRequest<T>(options: { ttlMs: number }): SharedRequest<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: { promise: Promise<T>; generation: number } | null = null;
  let generation = 0;

  return {
    get(load, requestOptions = {}) {
      // A forced caller should bypass an old value, but must still join work
      // that has already started. This is what collapses two simultaneous
      // visible/includeHidden list reads into one large response.
      if (inFlight?.generation === generation) return inFlight.promise;
      if (
        !requestOptions.force
        && cached !== null
        && cached.expiresAt > Date.now()
      ) {
        return Promise.resolve(cached.value);
      }

      const requestGeneration = generation;
      let loaded: Promise<T>;
      try {
        loaded = load();
      } catch (error) {
        loaded = Promise.reject(error);
      }
      const request = loaded
        .then((value) => {
          if (requestGeneration === generation) {
            cached = { value, expiresAt: Date.now() + options.ttlMs };
          }
          return value;
        })
        .finally(() => {
          if (inFlight?.promise === request) inFlight = null;
        });
      inFlight = { promise: request, generation: requestGeneration };
      return request;
    },

    invalidate() {
      generation += 1;
      cached = null;
    },
  };
}
