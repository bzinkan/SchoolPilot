import { randomUUID } from "crypto";
import { createClient, type RedisClientType } from "redis";

export type SocketIoRedisMessage = {
  room: string;
  event: string;
  data: unknown;
  messageId?: string;
};

type SocketIoRedisEnvelope = SocketIoRedisMessage & {
  instanceId: string;
  messageId: string;
};

const instanceId = randomUUID();
const redisUrl = process.env.REDIS_URL;
const redisPrefix = process.env.REDIS_PREFIX ?? "schoolpilot";
const redisChannel = `${redisPrefix}:socketio:broadcast`;

let publisher: RedisClientType | null = null;
let subscriber: RedisClientType | null = null;
let enabled = false;
let initPromise: Promise<void> | null = null;
let subscribed = false;
let warned = false;
let lastConnectedAt: string | null = null;
let lastErrorAt: string | null = null;
let publishFailures = 0;
let published = 0;
let received = 0;
let lastMetricState: boolean | null = null;
let messageHandler: ((message: SocketIoRedisMessage) => void) | null = null;
let nextRetryAt = 0;
let retryTimer: NodeJS.Timeout | null = null;
const seenMessageIds = new Map<string, number>();
const MESSAGE_DEDUPE_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 750;
const PUBLISH_TIMEOUT_MS = 250;
const RETRY_BACKOFF_MS = 5_000;

export type SocketIoRedisHealth = {
  configured: boolean;
  mode: "redis" | "local";
  healthy: boolean;
  connected: boolean;
  subscribed: boolean;
  lastConnectedAt: string | null;
  lastErrorAt: string | null;
  published: number;
  received: number;
  publishFailures: number;
};

function emitRelayMetric(healthy: boolean, publishFailure = false) {
  if (!publishFailure && lastMetricState === healthy) return;
  lastMetricState = healthy;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/GoPilot",
        Dimensions: [["Environment", "Service"]],
        Metrics: [
          { Name: "RedisRelayHealthy", Unit: "Count" },
          { Name: "RedisRelayPublishFailure", Unit: "Count" },
        ],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    Service: "socketio-relay",
    RedisRelayHealthy: healthy ? 1 : 0,
    RedisRelayPublishFailure: publishFailure ? 1 : 0,
  }));
}

function markRelayError() {
  enabled = false;
  lastErrorAt = new Date().toISOString();
  nextRetryAt = Math.max(nextRetryAt, Date.now() + RETRY_BACKOFF_MS);
  emitRelayMetric(false);
  scheduleRetry();
}

function warnRedis(error?: unknown) {
  markRelayError();
  if (warned) return;
  warned = true;
  if (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "REDIS_RELAY_ERROR")
      : "REDIS_RELAY_ERROR";
    console.warn(`[Socket.io Redis] relay disabled; running local-only (code=${code}).`);
  } else {
    console.warn("[Socket.io Redis] relay disabled; running local-only.");
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
    timeout.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function scheduleRetry() {
  if (!redisUrl || retryTimer || !messageHandler) return;
  const delay = Math.max(0, nextRetryAt - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureReady();
  }, delay);
  retryTimer.unref?.();
}

async function disposeClients() {
  const clients = [subscriber, publisher];
  subscriber = null;
  publisher = null;
  subscribed = false;
  await Promise.allSettled(clients.map(async (client) => {
    if (!client) return;
    try {
      if (client.isOpen) await client.disconnect();
    } catch {
      // Already closed.
    }
  }));
}

async function subscribeReadyClient(): Promise<void> {
  if (!subscriber?.isReady || subscribed || !messageHandler) return;
  await withTimeout(
    subscriber.subscribe(redisChannel, (payload: string) => {
      try {
        const envelope = JSON.parse(payload) as SocketIoRedisEnvelope;
        if (!envelope || envelope.instanceId === instanceId) return;
        const now = Date.now();
        for (const [messageId, seenAt] of seenMessageIds) {
          if (now - seenAt > MESSAGE_DEDUPE_TTL_MS) seenMessageIds.delete(messageId);
        }
        if (!envelope.messageId || seenMessageIds.has(envelope.messageId)) return;
        seenMessageIds.set(envelope.messageId, now);
        received += 1;
        messageHandler?.({
          room: envelope.room,
          event: envelope.event,
          data: envelope.data,
          messageId: envelope.messageId,
        });
      } catch (error) {
        warnRedis(error);
      }
    }),
    CONNECT_TIMEOUT_MS,
    "Redis relay subscribe"
  );
  subscribed = true;
}

async function ensureReady(): Promise<void> {
  if (!redisUrl) return;
  if (enabled && publisher?.isReady && subscriber?.isReady) {
    if (messageHandler && !subscribed) await subscribeReadyClient();
    return;
  }
  if (initPromise) return initPromise;
  if (Date.now() < nextRetryAt) {
    scheduleRetry();
    return;
  }

  initPromise = (async () => {
    try {
      await disposeClients();
      publisher = createClient({
        url: redisUrl,
        socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
      });
      publisher.on("error", (err: unknown) => warnRedis(err));
      publisher.on("ready", () => {
        enabled = true;
        lastConnectedAt = new Date().toISOString();
        warned = false;
        emitRelayMetric(true);
      });
      publisher.on("end", markRelayError);
      await withTimeout(publisher.connect(), CONNECT_TIMEOUT_MS, "Redis relay publisher connect");

      subscriber = publisher.duplicate();
      subscriber.on("error", (err: unknown) => warnRedis(err));
      subscriber.on("end", markRelayError);
      await withTimeout(subscriber.connect(), CONNECT_TIMEOUT_MS, "Redis relay subscriber connect");
      await subscribeReadyClient();

      enabled = true;
      nextRetryAt = 0;
      lastConnectedAt = new Date().toISOString();
      emitRelayMetric(true);
      console.log("[Socket.io Redis] relay connected");
    } catch (error) {
      enabled = false;
      nextRetryAt = Date.now() + RETRY_BACKOFF_MS;
      warnRedis(error);
      await disposeClients();
      scheduleRetry();
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export async function subscribeSocketIoRedis(
  onMessage: (message: SocketIoRedisMessage) => void
): Promise<void> {
  if (!redisUrl) return;
  messageHandler = onMessage;
  await ensureReady();
}

export async function publishSocketIoRedis(
  message: SocketIoRedisMessage
): Promise<boolean> {
  if (!redisUrl) return false;
  await withTimeout(ensureReady(), CONNECT_TIMEOUT_MS, "Redis relay readiness").catch((error) => {
    warnRedis(error);
  });
  if (!enabled || !publisher) return false;

  try {
    const messageId = message.messageId ?? randomUUID();
    await withTimeout(
      publisher.publish(
        redisChannel,
        JSON.stringify({ ...message, instanceId, messageId } satisfies SocketIoRedisEnvelope)
      ),
      PUBLISH_TIMEOUT_MS,
      "Redis relay publish"
    );
    published += 1;
    emitRelayMetric(true);
    return true;
  } catch (error) {
    publishFailures += 1;
    emitRelayMetric(false, true);
    warnRedis(error);
    return false;
  }
}

export async function closeSocketIoRedis(): Promise<void> {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  messageHandler = null;
  nextRetryAt = 0;
  enabled = false;
  initPromise = null;
  await disposeClients();
}

export function getSocketIoRedisHealth(): SocketIoRedisHealth {
  const configured = Boolean(redisUrl);
  return {
    configured,
    mode: configured ? "redis" : "local",
    healthy: !configured || (
      enabled
      && subscribed
      && Boolean(publisher?.isReady)
      && Boolean(subscriber?.isReady)
    ),
    connected: enabled && Boolean(publisher?.isReady),
    subscribed,
    lastConnectedAt,
    lastErrorAt,
    published,
    received,
    publishFailures,
  };
}
