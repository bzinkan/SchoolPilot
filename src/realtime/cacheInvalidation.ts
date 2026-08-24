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
type CacheInvalidationPublishOptions = {
  signal?: AbortSignal;
};
type CacheInvalidationPublisher = (
  target: CacheInvalidationTarget,
  options?: CacheInvalidationPublishOptions
) => Promise<boolean>;
type CacheInvalidationPublisherDisposer = () => void | Promise<void>;
type PublisherOperation = {
  promise: Promise<boolean>;
  abort: () => void;
};

const localHandlers = new Set<CacheInvalidationHandler>();
let publisher: CacheInvalidationPublisher | undefined;
let publisherDisposer: CacheInvalidationPublisherDisposer | undefined;
let publisherLifecycle: "active" | "terminal" = "active";
let publisherDisposal: Promise<void> | undefined;
const publisherOperations = new Set<PublisherOperation>();
const publisherCleanupOperations = new Set<Promise<void>>();
const MAX_CACHE_INVALIDATION_PUBLICATIONS = 16;
const CACHE_INVALIDATION_PUBLISH_TIMEOUT_MS = 1_000;
const CACHE_INVALIDATION_DISPOSE_TIMEOUT_MS = 1_500;

function publisherIsTerminal(): boolean {
  return publisherLifecycle === "terminal";
}

async function settleWithin(
  operations: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<void> {
  if (operations.length === 0 || timeoutMs <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled(operations),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trackPublisherCleanup(
  dispose: CacheInvalidationPublisherDisposer
): Promise<void> {
  const cleanup = Promise.resolve()
    .then(() => dispose())
    .then(() => undefined, () => undefined)
    .finally(() => publisherCleanupOperations.delete(cleanup));
  publisherCleanupOperations.add(cleanup);
  return cleanup;
}

export function registerCacheInvalidationHandler(
  handler: CacheInvalidationHandler
): () => void {
  localHandlers.add(handler);
  return () => localHandlers.delete(handler);
}

export function registerCacheInvalidationPublisher(
  nextPublisher: CacheInvalidationPublisher,
  dispose?: CacheInvalidationPublisherDisposer
): void {
  if (publisherIsTerminal()) {
    if (dispose) void trackPublisherCleanup(dispose);
    return;
  }
  publisher = nextPublisher;
  publisherDisposer = dispose;
}

export function disposeCacheInvalidationPublisher(
  timeoutMs = CACHE_INVALIDATION_DISPOSE_TIMEOUT_MS
): Promise<void> {
  if (publisherDisposal) return publisherDisposal;

  publisherLifecycle = "terminal";
  const dispose = publisherDisposer;
  publisher = undefined;
  publisherDisposer = undefined;
  const startedAt = Date.now();
  const initialCleanup = dispose ? trackPublisherCleanup(dispose) : undefined;
  const activePublications = [...publisherOperations];
  for (const operation of activePublications) operation.abort();

  publisherDisposal = (async () => {
    await settleWithin(
      [
        ...activePublications.map((operation) => operation.promise),
        ...(initialCleanup ? [initialCleanup] : []),
      ],
      timeoutMs
    );
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
    await settleWithin([...publisherCleanupOperations], remainingMs);
    for (const operation of activePublications) {
      publisherOperations.delete(operation);
    }
  })();
  return publisherDisposal;
}

export function dispatchCacheInvalidation(target: CacheInvalidationTarget): void {
  for (const handler of localHandlers) handler(target);
}

export async function publishCacheInvalidation(
  target: CacheInvalidationTarget,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  if (publisherIsTerminal()) return false;
  // A paused Redis server can leave raw PUBLISH promises pending even after
  // callers take the best-effort timeout path. Keep those promises handled,
  // but refuse unbounded accumulation in a long-lived API process.
  if (publisherOperations.size >= MAX_CACHE_INVALIDATION_PUBLICATIONS) {
    return false;
  }

  const controller = new AbortController();
  const operationRecord: PublisherOperation = {
    promise: Promise.resolve(false),
    abort: () => controller.abort(),
  };
  const operation = (async () => {
    try {
      const registeredPublisher = publisher;
      if (registeredPublisher) {
        return await registeredPublisher(target, { signal: controller.signal });
      }

      // Migration/repair CLIs and worker-only entrypoints do not necessarily load
      // the WebSocket server modules that register the publisher as a side effect.
      // Lazily loading the transport here keeps credential invalidation
      // process-independent without making every storage consumer initialize it.
      const { publishWS } = await import("./ws-redis.js");
      if (publisherIsTerminal() || controller.signal.aborted) return false;
      return await publishWS(
        target,
        { type: "cache-invalidation" },
        { signal: controller.signal }
      );
    } catch {
      return false;
    }
  })().finally(() => publisherOperations.delete(operationRecord));
  operationRecord.promise = operation;
  publisherOperations.add(operationRecord);

  const timeoutMs = Math.max(1, options.timeoutMs ?? CACHE_INVALIDATION_PUBLISH_TIMEOUT_MS);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
