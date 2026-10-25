// Minimal in-process keyed async mutex. Serializes async critical sections that
// share a key so concurrent in-process work (for example the workflow parallel
// scheduler batch) cannot interleave read-modify-write updates to the same run
// file or interleave appends to the same log. Cross-process exclusion is handled
// separately by the run lock; this only orders work inside one process.
const tails = new Map<string, Promise<void>>()

export async function withKeyedMutex<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let releaseNext: () => void = () => {}
  const next = new Promise<void>(resolve => {
    releaseNext = resolve
  })
  const chained = previous.then(() => next)
  tails.set(key, chained)
  // Wait for the prior holder to finish before entering the critical section. A
  // rejected predecessor must not block the queue, so swallow its error here;
  // the predecessor's own caller still observes its rejection.
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    releaseNext()
    // Drop the key once we are the last in line so the map stays bounded.
    if (tails.get(key) === chained) {
      tails.delete(key)
    }
  }
}
