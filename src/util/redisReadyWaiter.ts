export interface RedisReadyEventSource {
  readonly isReady: boolean;
  on(event: "ready", listener: () => void): unknown;
  off(event: "ready", listener: () => void): unknown;
}

/**
 * Coalesces all Redis readiness waits in one bounded cycle. A settled cycle is
 * cleared synchronously so a later disconnect/reconnect starts a fresh wait.
 */
export function createRedisReadyWaiter(
  client: RedisReadyEventSource,
  defaultTimeoutMs = 2_000
): (timeoutMs?: number) => Promise<void> {
  let pending: Promise<void> | null = null;

  return function waitForReady(timeoutMs = defaultTimeoutMs): Promise<void> {
    if (client.isReady) return Promise.resolve();
    if (pending) return pending;

    let resolveWait!: () => void;
    let rejectWait!: (error: Error) => void;
    const wait = new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    pending = wait;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      client.off("ready", onReady);
      if (pending === wait) pending = null;
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWait();
    };
    const onTimeout = () => {
      if (settled) return;
      // Close the complementary race where readiness changes at the timeout
      // boundary but the event callback has not run yet.
      if (client.isReady) {
        onReady();
        return;
      }
      settled = true;
      cleanup();
      rejectWait(new Error("redis not ready"));
    };

    timer = setTimeout(onTimeout, timeoutMs);
    client.on("ready", onReady);
    // Redis may become ready after the first check but before the listener is
    // attached. Rechecking after registration prevents a missed event from
    // turning a healthy connection into a false timeout.
    if (client.isReady) onReady();

    return wait;
  };
}
