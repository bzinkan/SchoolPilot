export type CacheInvalidationTarget = {
  kind: "cache-invalidation";
  schoolId: string;
  cache: "heartbeat-tracking-settings";
};

type CacheInvalidationHandler = (target: CacheInvalidationTarget) => void;
type CacheInvalidationPublisher = (
  target: CacheInvalidationTarget
) => Promise<boolean>;

let localHandler: CacheInvalidationHandler | undefined;
let publisher: CacheInvalidationPublisher | undefined;

export function registerCacheInvalidationHandler(
  handler: CacheInvalidationHandler
): void {
  localHandler = handler;
}

export function registerCacheInvalidationPublisher(
  nextPublisher: CacheInvalidationPublisher
): void {
  publisher = nextPublisher;
}

export function dispatchCacheInvalidation(target: CacheInvalidationTarget): void {
  localHandler?.(target);
}

export async function publishCacheInvalidation(
  target: CacheInvalidationTarget
): Promise<boolean> {
  return publisher ? publisher(target) : false;
}
