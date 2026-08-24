export type CacheInvalidationTarget =
  | {
      kind: "cache-invalidation";
      schoolId: string;
      cache:
        | "heartbeat-tracking-settings"
        | "classpilot-dashboard-school"
        | "classpilot-passive-authorization";
    }
  | {
      kind: "cache-invalidation";
      cache: "user-credentials";
      userId: string;
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
  if (publisher) return publisher(target);

  // Migration/repair CLIs and worker-only entrypoints do not necessarily load
  // the WebSocket server modules that register the publisher as a side effect.
  // Lazily loading the transport here keeps credential invalidation
  // process-independent without making every storage consumer initialize it.
  const { publishWS } = await import("./ws-redis.js");
  return publishWS(target, { type: "cache-invalidation" });
}

/**
 * Invalidate already-authenticated realtime connections after auth_version is
 * incremented. Local dispatch closes sockets on this API task immediately;
 * the Redis-backed publisher delivers the same user-scoped signal to peers.
 */
export async function invalidateUserCredentialConnections(
  userId: string
): Promise<boolean> {
  const target = {
    kind: "cache-invalidation",
    cache: "user-credentials",
    userId,
  } as const;
  dispatchCacheInvalidation(target);
  return publishCacheInvalidation(target);
}
