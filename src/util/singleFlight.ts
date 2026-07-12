export type SingleFlightOptions = {
  maxPendingKeys?: number;
};

/**
 * Coalesces only currently pending work for an identical key. Results are
 * never retained after settlement, so authorization changes are visible to
 * the next request after the overlap settles instead of waiting for a TTL
 * cache to expire.
 */
export function createSingleFlight<K, V>(
  options: SingleFlightOptions = {}
): (key: K, work: () => Promise<V> | V) => Promise<V> {
  const maxPendingKeys = Math.max(1, options.maxPendingKeys ?? 4_096);
  const pending = new Map<K, Promise<V>>();

  return (key, work) => {
    const existing = pending.get(key);
    if (existing) return existing;

    // Preserve correctness under adversarial unique-key concurrency without
    // allowing this optimization map itself to grow without bound.
    if (pending.size >= maxPendingKeys) {
      return Promise.resolve().then(work);
    }

    let promise!: Promise<V>;
    promise = Promise.resolve().then(async () => {
      try {
        return await work();
      } finally {
        if (pending.get(key) === promise) pending.delete(key);
      }
    });
    pending.set(key, promise);
    return promise;
  };
}
