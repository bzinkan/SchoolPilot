/**
 * Maps `items` through `mapper` with at most `concurrency` mappers in flight,
 * preserving input order in the result. Rejections propagate as soon as any
 * mapper fails.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
