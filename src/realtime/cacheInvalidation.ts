export type CacheInvalidationTarget = {
  kind: "cache-invalidation";
  schoolId: string;
  cache: "heartbeat-tracking-settings" | "classpilot-dashboard-school";
};

type CacheInvalidationHandler = (target: CacheInvalidationTarget) => void;
type CacheInvalidationPublisher = (
  target: CacheInvalidationTarget
) => Promise<boolean>;

const localHandlers = new Set<CacheInvalidationHandler>();
let publisher: CacheInvalidationPublisher | undefined;

export function registerCacheInvalidationHandler(
  handler: CacheInvalidationHandler
): () => void {
  localHandlers.add(handler);
  return () => localHandlers.delete(handler);
}

export function registerCacheInvalidationPublisher(
  nextPublisher: CacheInvalidationPublisher
): void {
  publisher = nextPublisher;
}

export function dispatchCacheInvalidation(target: CacheInvalidationTarget): void {
  for (const handler of localHandlers) handler(target);
}

export async function publishCacheInvalidation(
  target: CacheInvalidationTarget
): Promise<boolean> {
  return publisher ? publisher(target) : false;
}
