import { createHash, randomUUID } from "crypto";
import { createClient, type RedisClientType } from "redis";
import {
  dispatchCacheInvalidation,
  registerCacheInvalidationPublisher,
  type CacheInvalidationTarget,
} from "./cacheInvalidation.js";
import { safeErrorMetadata } from "../util/safeLogging.js";

export type WsRedisTarget =
  | { kind: "staff"; schoolId: string }
  | { kind: "staff-user"; schoolId: string; userId: string }
  | { kind: "staff-session"; schoolId: string; sessionId: string }
  | { kind: "students"; schoolId: string; targetDeviceIds?: string[] }
  | { kind: "device"; schoolId: string; deviceId: string }
  | { kind: "student-disconnect"; schoolId: string; studentIds: string[] }
  | { kind: "role"; schoolId: string; role: "teacher" | "office_staff" | "school_admin" | "super_admin" | "student" }
  | CacheInvalidationTarget;

type WsRedisEnvelope = {
  instanceId: string;
  target: WsRedisTarget;
  message: unknown;
  includeSource?: boolean;
  orderedKey?: string;
  revision?: string;
};

type PublishWSOptions = {
  includeSource?: boolean;
  signal?: AbortSignal;
  orderedKey?: string;
  revision?: string;
};

export type OrderedPublishOutcome =
  | { status: "accepted"; subscriberCount: number }
  | { status: "stale"; subscriberCount: 0 }
  | { status: "failed"; subscriberCount: 0 };

export type PublishWSBatchItem = {
  target: WsRedisTarget;
  message: unknown;
  includeSource?: boolean;
};

export type CommandHotPathPhase =
  | "command_local_delivery"
  | "command_redis_batch"
  | "command_mark_sent"
  | "ack_target_update"
  | "ack_summary_refresh"
  | "ack_snapshot_publish"
  | "ack_redis_publish";

export const ORDERED_PUBLISH_TTL_SECONDS = 24 * 60 * 60;
export const ORDERED_PUBLISH_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then
  return -1
end
-- Reserve the revision even when no subscriber is currently attached. ACK
-- snapshot callbacks run after their database lock is released, so an older
-- delayed callback must never become publishable merely because a newer
-- callback observed zero subscribers. The newer state will take a fresh
-- database revision on its bounded retry.
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
local subscribers = redis.call('PUBLISH', ARGV[3], ARGV[4])
return subscribers
`;
const MAX_ORDERED_DELIVERY_REVISIONS = 10_000;
const orderedDeliveryRevisions = new Map<string, bigint>();

function recordOrderedDelivery(orderedKey: string, revision: string): boolean {
  let next: bigint;
  try {
    next = BigInt(revision);
  } catch {
    return false;
  }
  const current = orderedDeliveryRevisions.get(orderedKey);
  if (current !== undefined && next <= current) return false;
  orderedDeliveryRevisions.set(orderedKey, next);
  if (orderedDeliveryRevisions.size > MAX_ORDERED_DELIVERY_REVISIONS) {
    const oldest = orderedDeliveryRevisions.keys().next().value;
    if (oldest) orderedDeliveryRevisions.delete(oldest);
  }
  return true;
}

export function recordLocalOrderedDelivery(orderedKey: string, revision: string): boolean {
  return recordOrderedDelivery(orderedKey, revision);
}

const instanceId = randomUUID();
const instanceShortId = instanceId.slice(0, 8); // Short ID for logging
const redisUrl = process.env.REDIS_URL;
const redisPrefix = process.env.REDIS_PREFIX ?? "schoolpilot";
const redisChannel = `${redisPrefix}:ws:broadcast`;
const HOT_PATH_LOG_INTERVAL_MS = 60_000;
const REDIS_INITIALIZATION_SHUTDOWN_GRACE_MS = 500;
const REDIS_DISCONNECT_GRACE_MS = 250;

type HotPathActivity = {
  redisMessagesPublished: number;
  redisSubscriberDeliveries: number;
  redisMessagesReceived: number;
  screenshotUploads: number;
  screenshotPayloadBytes: number;
  screenshotRedisStores: number;
  screenshotMemoryFallbacks: number;
  commandPhases: Partial<Record<CommandHotPathPhase, {
    count: number;
    failures: number;
    items: number;
    totalDurationMs: number;
    maxDurationMs: number;
  }>>;
};

function emptyHotPathActivity(): HotPathActivity {
  return {
    redisMessagesPublished: 0,
    redisSubscriberDeliveries: 0,
    redisMessagesReceived: 0,
    screenshotUploads: 0,
    screenshotPayloadBytes: 0,
    screenshotRedisStores: 0,
    screenshotMemoryFallbacks: 0,
    commandPhases: {},
  };
}

let hotPathActivity = emptyHotPathActivity();

function flushHotPathActivity(): void {
  const activity = hotPathActivity;
  hotPathActivity = emptyHotPathActivity();
  if (
    activity.redisMessagesPublished === 0 &&
    activity.redisMessagesReceived === 0 &&
    activity.screenshotUploads === 0 &&
    Object.keys(activity.commandPhases).length === 0
  ) {
    return;
  }

  // Deliberately contains only process-level counts: no school, user, device,
  // URL, title, message payload, or Redis key data.
  console.log(JSON.stringify({
    event: "realtime_hot_path_summary",
    intervalSeconds: HOT_PATH_LOG_INTERVAL_MS / 1_000,
    ...activity,
  }));
}

const hotPathLogTimer = setInterval(flushHotPathActivity, HOT_PATH_LOG_INTERVAL_MS);
hotPathLogTimer.unref?.();

export function recordScreenshotUpload(payloadBytes: number, storedInRedis: boolean): void {
  hotPathActivity.screenshotUploads += 1;
  hotPathActivity.screenshotPayloadBytes += Math.max(0, payloadBytes);
  if (storedInRedis) {
    hotPathActivity.screenshotRedisStores += 1;
  } else {
    hotPathActivity.screenshotMemoryFallbacks += 1;
  }
}

export function recordCommandHotPathPhase(
  phase: CommandHotPathPhase,
  durationMs: number,
  options: { success?: boolean; items?: number } = {}
): void {
  const metric = hotPathActivity.commandPhases[phase] ?? {
    count: 0,
    failures: 0,
    items: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  const boundedDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  metric.count += 1;
  metric.failures += options.success === false ? 1 : 0;
  metric.items += Math.max(0, Math.trunc(options.items ?? 1));
  metric.totalDurationMs += boundedDurationMs;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, boundedDurationMs);
  hotPathActivity.commandPhases[phase] = metric;
}

console.log(`[Redis] Instance ${instanceShortId} starting, Redis URL: ${redisUrl ? 'configured' : 'NOT configured'}`);

let redisPublisher: RedisClientType | null = null;
let redisSubscriber: RedisClientType | null = null;
let redisEnabled = false;
let redisWarned = false;
let redisInitPromise: Promise<void> | null = null;
let subscribed = false;
let subscriptionStarted = false;
let redisDisposed = false;

function warnRedis(error?: unknown) {
  if (redisWarned) {
    return;
  }
  redisWarned = true;
  if (error) {
    console.warn(
      "[WebSocket] Redis pub/sub disabled; running single-instance mode.",
      safeErrorMetadata(error)
    );
    return;
  }
  console.warn("[WebSocket] Redis pub/sub disabled; running single-instance mode.");
}

async function ensureRedisReady(): Promise<void> {
  if (!redisUrl || redisDisposed) {
    return;
  }
  if (redisInitPromise) {
    return redisInitPromise;
  }

  redisInitPromise = (async () => {
    try {
      console.log(`[Redis] Instance ${instanceShortId} connecting to Redis...`);
      redisPublisher = createClient({ url: redisUrl });
      redisPublisher.on("error", (err: unknown) => {
        console.error(
          `[Redis] Instance ${instanceShortId} publisher error:`,
          safeErrorMetadata(err)
        );
        warnRedis(err);
      });
      await redisPublisher.connect();
      if (redisDisposed) return;
      console.log(`[Redis] Instance ${instanceShortId} publisher connected`);

      redisSubscriber = redisPublisher.duplicate();
      redisSubscriber.on("error", (err: unknown) => {
        subscribed = false;
        console.error(
          `[Redis] Instance ${instanceShortId} subscriber error:`,
          safeErrorMetadata(err)
        );
        warnRedis(err);
      });
      redisSubscriber.on("reconnecting", () => { subscribed = false; });
      redisSubscriber.on("end", () => { subscribed = false; });
      redisSubscriber.on("ready", () => {
        if (subscriptionStarted) subscribed = true;
      });
      await redisSubscriber.connect();
      if (redisDisposed) return;
      console.log(`[Redis] Instance ${instanceShortId} subscriber connected`);

      redisEnabled = true;
      console.log(`[Redis] Instance ${instanceShortId} fully initialized`);
    } catch (error) {
      redisEnabled = false;
      console.error(
        `[Redis] Instance ${instanceShortId} initialization failed:`,
        safeErrorMetadata(error)
      );
      warnRedis(error);
    }
  })();

  return redisInitPromise;
}

export function isRedisEnabled(): boolean {
  return redisEnabled;
}

export function isRedisBroadcastReady(): boolean {
  return Boolean(redisEnabled && subscribed && redisSubscriber?.isReady);
}

export function isRedisPublisherReady(): boolean {
  return Boolean(redisEnabled && redisPublisher?.isReady);
}

export function getRedisPublisher(): RedisClientType | null {
  return redisPublisher;
}

/**
 * Run a small realtime coordination command on the shared Redis publisher.
 * `undefined` means Redis is not configured/ready or the command failed; Redis
 * replies such as `0` remain authoritative values. Callers must fail closed
 * when this returns `undefined`.
 */
export async function executeRealtimeRedisCommand<T = unknown>(
  command: string[],
  options: { timeoutMs?: number } = {}
): Promise<T | undefined> {
  if (!redisUrl) return undefined;
  const timeoutMs = Math.max(50, options.timeoutMs ?? 500);
  let readyTimer: NodeJS.Timeout | undefined;
  const ready = await Promise.race([
    ensureRedisReady().then(() => true, () => false),
    new Promise<boolean>((resolve) => {
      readyTimer = setTimeout(() => resolve(false), timeoutMs);
      readyTimer.unref?.();
    }),
  ]);
  if (readyTimer) clearTimeout(readyTimer);
  if (!ready) return undefined;
  if (!redisEnabled || !redisPublisher?.isReady) return undefined;
  const controller = new AbortController();
  const commandTimer = setTimeout(() => controller.abort(), timeoutMs);
  commandTimer.unref?.();
  try {
    return await redisPublisher.sendCommand<T>(command, { signal: controller.signal });
  } catch (error) {
    // Do not log the command because coordination keys can contain scoped
    // identifiers. The shared Redis warning already reports infrastructure
    // health without exposing tenant or user data.
    console.warn("[WebSocket] Redis coordination command failed");
    warnRedis(error);
    return undefined;
  } finally {
    clearTimeout(commandTimer);
  }
}

export async function subscribeWS(
  onMessage: (target: WsRedisTarget, message: unknown) => void
): Promise<void> {
  if (!redisUrl) {
    return;
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisSubscriber || subscriptionStarted) {
    return;
  }

  subscriptionStarted = true;
  console.log(`[Redis] Instance ${instanceShortId} subscribing to channel: ${redisChannel}`);
  try {
    await redisSubscriber.subscribe(redisChannel, (payload: string) => {
      try {
        subscribed = true;
        const envelope = JSON.parse(payload) as WsRedisEnvelope;
        if (!envelope) {
          return;
        }
        // Skip messages from this instance (they were already handled locally)
        if (envelope.instanceId === instanceId && !envelope.includeSource) {
          return;
        }
        if (envelope.target.kind === "cache-invalidation") {
          dispatchCacheInvalidation(envelope.target);
          hotPathActivity.redisMessagesReceived += 1;
          return;
        }
        if (
          envelope.orderedKey &&
          envelope.revision &&
          !recordOrderedDelivery(envelope.orderedKey, envelope.revision)
        ) {
          return;
        }
        hotPathActivity.redisMessagesReceived += 1;
        onMessage(envelope.target, envelope.message);
      } catch (error) {
        console.error(
          `[Redis] Instance ${instanceShortId} message parse error:`,
          safeErrorMetadata(error)
        );
        warnRedis(error);
      }
    });
    subscribed = true;
    console.log(`[Redis] Instance ${instanceShortId} successfully subscribed to ${redisChannel}`);
  } catch (error) {
    subscribed = false;
    subscriptionStarted = false;
    console.error(
      `[Redis] Instance ${instanceShortId} subscription failed:`,
      safeErrorMetadata(error)
    );
    warnRedis(error);
  }
}

export async function publishWS(
  target: WsRedisTarget,
  message: unknown,
  options: PublishWSOptions = {}
): Promise<boolean> {
  if (!redisUrl) {
    return false;
  }
  if (options.signal) {
    if (options.signal.aborted) return false;
    let removeAbortListener: (() => void) | undefined;
    const ready = await Promise.race([
      ensureRedisReady().then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        const onAbort = () => resolve(false);
        options.signal!.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal!.removeEventListener("abort", onAbort);
        if (options.signal!.aborted) onAbort();
      }),
    ]);
    removeAbortListener?.();
    if (!ready || options.signal.aborted) return false;
  } else {
    await ensureRedisReady();
  }
  if (!redisEnabled || !redisPublisher) {
    return false;
  }

  const payload: WsRedisEnvelope = {
    instanceId,
    target,
    message,
    includeSource: options.includeSource || undefined,
    orderedKey: options.orderedKey,
    revision: options.revision,
  };

  try {
    const serialized = JSON.stringify(payload);
    const ordered = Boolean(options.orderedKey && options.revision);
    const command = ordered
      ? [
          "EVAL",
          ORDERED_PUBLISH_SCRIPT,
          "1",
          `${redisPrefix}:ws:ordered:${options.orderedKey}`,
          options.revision!,
          String(ORDERED_PUBLISH_TTL_SECONDS),
          redisChannel,
          serialized,
        ]
      : ["PUBLISH", redisChannel, serialized];
    // Do not attach AbortSignal to an already-sent node-redis command. In
    // node-redis 4.7.x an aborted queued PUBLISH can corrupt delayed-reply
    // bookkeeping and leave its TCP socket alive. The cache layer bounds the
    // caller wait while retaining this raw promise for terminal disposal.
    const numSubscribers = ordered
      ? await redisPublisher.sendCommand<number>(
          command
        )
      : await redisPublisher.publish(redisChannel, serialized);
    if (numSubscribers === -1) return true;
    hotPathActivity.redisMessagesPublished += 1;
    hotPathActivity.redisSubscriberDeliveries += numSubscribers;
    return numSubscribers > 0;
  } catch (error) {
    console.error(`[Redis] Instance ${instanceShortId} publish failed:`, safeErrorMetadata(error));
    warnRedis(error);
    return false;
  }
}

/**
 * Atomically claim and publish a revisioned WebSocket snapshot.
 *
 * Callers that also fan out locally must wait for this result and perform the
 * local fan-out only when status is "accepted". That global Redis decision
 * prevents a delayed callback on another API task from broadcasting an older
 * snapshot locally before Redis rejects it as stale.
 */
export async function publishOrderedWS(
  target: WsRedisTarget,
  message: unknown,
  options: {
    orderedKey: string;
    revision: string;
    includeSource?: boolean;
    signal?: AbortSignal;
  }
): Promise<OrderedPublishOutcome> {
  if (!redisUrl) return { status: "failed", subscriberCount: 0 };
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return { status: "failed", subscriberCount: 0 };
  }

  const payload: WsRedisEnvelope = {
    instanceId,
    target,
    message,
    includeSource: options.includeSource || undefined,
    orderedKey: options.orderedKey,
    revision: options.revision,
  };

  try {
    const serialized = JSON.stringify(payload);
    const subscriberCount = await redisPublisher.sendCommand<number>([
      "EVAL",
      ORDERED_PUBLISH_SCRIPT,
      "1",
      `${redisPrefix}:ws:ordered:${options.orderedKey}`,
      options.revision,
      String(ORDERED_PUBLISH_TTL_SECONDS),
      redisChannel,
      serialized,
    ], options.signal ? { signal: options.signal } : undefined);
    if (subscriberCount === -1) {
      return { status: "stale", subscriberCount: 0 };
    }
    hotPathActivity.redisMessagesPublished += 1;
    hotPathActivity.redisSubscriberDeliveries += subscriberCount;
    return { status: "accepted", subscriberCount };
  } catch (error) {
    console.error(
      `[Redis] Instance ${instanceShortId} ordered publish failed:`,
      safeErrorMetadata(error)
    );
    warnRedis(error);
    return { status: "failed", subscriberCount: 0 };
  }
}

/**
 * Publish an ordered input list in one Redis round trip. Redis executes the
 * queued PUBLISH commands in input order, so remote tasks observe the same
 * target/message order used for local delivery. This intentionally supports
 * only ordinary (non-revisioned) publications; revisioned command snapshots
 * continue to use publishWS and its compare-and-publish script.
 */
export async function publishWSBatch(
  items: readonly PublishWSBatchItem[]
): Promise<boolean[]> {
  if (items.length === 0) return [];
  if (!redisUrl) return items.map(() => false);
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) return items.map(() => false);

  try {
    const serialized = items.map(({ target, message, includeSource }) => JSON.stringify({
      instanceId,
      target,
      message,
      includeSource: includeSource || undefined,
    } satisfies WsRedisEnvelope));
    const pipeline = redisPublisher.multi();
    for (const payload of serialized) {
      pipeline.publish(redisChannel, payload);
    }
    const results = await pipeline.exec();
    const subscriberCounts = results.map((value) => Number(value ?? 0));
    hotPathActivity.redisMessagesPublished += subscriberCounts.length;
    hotPathActivity.redisSubscriberDeliveries += subscriberCounts.reduce(
      (total, count) => total + Math.max(0, count),
      0
    );
    return subscriberCounts.map((count) => count > 0);
  } catch (error) {
    console.error(
      `[Redis] Instance ${instanceShortId} batch publish failed:`,
      safeErrorMetadata(error)
    );
    warnRedis(error);
    return items.map(() => false);
  }
}

export type RedisShutdownClient = {
  disconnect(): Promise<unknown> | unknown;
};

type RedisRuntimeShutdownOptions = {
  initialization?: Promise<unknown> | null;
  clients: () => readonly (RedisShutdownClient | null)[];
  initializationGraceMs?: number;
  disconnectGraceMs?: number;
};

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeRedisClient(
  client: RedisShutdownClient | null,
  disconnectGraceMs: number
): Promise<void> {
  if (!client) return;
  // This is terminal one-off teardown, so destroy the socket directly. A
  // stalled QUIT makes node-redis report isOpen=false before the server reply,
  // after which disconnect() refuses to destroy the still-live socket.
  await settlesWithin(
    Promise.resolve().then(() => client.disconnect()),
    disconnectGraceMs
  );
}

export async function closeRedisRuntimeForShutdown(
  options: RedisRuntimeShutdownOptions
): Promise<void> {
  if (options.initialization) {
    await settlesWithin(
      options.initialization,
      options.initializationGraceMs ?? REDIS_INITIALIZATION_SHUTDOWN_GRACE_MS
    );
  }
  await Promise.allSettled(
    options.clients().map((client) =>
      closeRedisClient(
        client,
        options.disconnectGraceMs ?? REDIS_DISCONNECT_GRACE_MS
      )
    )
  );
}

/**
 * Release the long-lived realtime transport when a one-off process lazily
 * imports this module only to broadcast a cache invalidation.
 */
export async function disposeWSRedis(): Promise<void> {
  redisDisposed = true;
  clearInterval(hotPathLogTimer);
  await closeRedisRuntimeForShutdown({
    initialization: redisInitPromise,
    clients: () => [redisSubscriber, redisPublisher],
  });
  redisPublisher = null;
  redisSubscriber = null;
  redisEnabled = false;
  subscribed = false;
  subscriptionStarted = false;
  redisInitPromise = null;
}

registerCacheInvalidationPublisher(
  (target, options) => publishWS(
    target,
    { type: "cache-invalidation" },
    { signal: options?.signal }
  ),
  disposeWSRedis
);

// Screenshot storage in Redis (for multi-instance deployments)
const SCREENSHOT_KEY_PREFIX = `${redisPrefix}:screenshot:`;
const SCREENSHOT_TTL_SECONDS = 120; // 120 seconds — must outlive both the 30s capture interval and 30s dashboard poll

export type ScreenshotData = {
  screenshot: string;
  timestamp: number;
  capturedAt?: string;
  tabTitle?: string;
  tabUrl?: string;
  tabFavicon?: string;
  // Internal authority binding. Public tile responses strip these fields.
  schoolId?: string;
  deviceId?: string;
  studentId?: string;
  studentSessionId?: string;
  bindingVersion?: string;
};

export type ScreenshotBinding = {
  schoolId: string;
  deviceId: string;
  studentId: string;
  studentSessionId: string;
};

export type BoundScreenshotData = ScreenshotData & ScreenshotBinding & {
  capturedAt: string;
  bindingVersion: string;
};

function screenshotBindingDigest(binding: ScreenshotBinding): string {
  return createHash("sha256")
    .update(binding.schoolId)
    .update("\0")
    .update(binding.deviceId)
    .update("\0")
    .update(binding.studentId)
    .update("\0")
    .update(binding.studentSessionId)
    .digest("hex");
}

export function screenshotBindingVersion(binding: ScreenshotBinding): string {
  return `v1:${screenshotBindingDigest(binding)}`;
}

export function screenshotBindingCacheKey(binding: ScreenshotBinding): string {
  return `${SCREENSHOT_KEY_PREFIX}bound:${screenshotBindingDigest(binding)}`;
}

const SCREENSHOT_MAX_CLOCK_SKEW_MS = 30_000;

export function decodeScreenshotData(value: unknown): ScreenshotData | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<ScreenshotData>;
  if (
    typeof candidate.screenshot !== "string" ||
    typeof candidate.timestamp !== "number" ||
    !Number.isFinite(candidate.timestamp)
  ) {
    return null;
  }
  const ageMs = Date.now() - candidate.timestamp;
  if (
    ageMs > SCREENSHOT_TTL_SECONDS * 1_000 ||
    ageMs < -SCREENSHOT_MAX_CLOCK_SKEW_MS
  ) {
    return null;
  }
  return {
    screenshot: candidate.screenshot,
    timestamp: candidate.timestamp,
    ...(typeof candidate.capturedAt === "string" ? { capturedAt: candidate.capturedAt } : {}),
    ...(typeof candidate.tabTitle === "string" ? { tabTitle: candidate.tabTitle } : {}),
    ...(typeof candidate.tabUrl === "string" ? { tabUrl: candidate.tabUrl } : {}),
    ...(typeof candidate.tabFavicon === "string" ? { tabFavicon: candidate.tabFavicon } : {}),
    ...(typeof candidate.schoolId === "string" ? { schoolId: candidate.schoolId } : {}),
    ...(typeof candidate.deviceId === "string" ? { deviceId: candidate.deviceId } : {}),
    ...(typeof candidate.studentId === "string" ? { studentId: candidate.studentId } : {}),
    ...(typeof candidate.studentSessionId === "string"
      ? { studentSessionId: candidate.studentSessionId }
      : {}),
    ...(typeof candidate.bindingVersion === "string"
      ? { bindingVersion: candidate.bindingVersion }
      : {}),
  };
}

export function screenshotMatchesBinding(
  data: ScreenshotData | null,
  binding: ScreenshotBinding,
  options: { allowLegacy?: boolean } = {}
): boolean {
  if (!data) return false;
  if (
    data.studentId !== binding.studentId
    || data.studentSessionId !== binding.studentSessionId
  ) return false;

  const expectedVersion = screenshotBindingVersion(binding);
  const hasCompleteBinding = Boolean(
    data.schoolId && data.deviceId && data.bindingVersion && data.capturedAt
  );
  if (!hasCompleteBinding) return options.allowLegacy === true;
  if (
    data.schoolId !== binding.schoolId
    || data.deviceId !== binding.deviceId
    || data.bindingVersion !== expectedVersion
  ) return false;
  const capturedAtMs = Date.parse(data.capturedAt!);
  return Number.isFinite(capturedAtMs)
    && Math.abs(capturedAtMs - data.timestamp) <= 1_000;
}

export async function setScreenshot(
  binding: ScreenshotBinding,
  data: BoundScreenshotData
): Promise<boolean> {
  if (!screenshotMatchesBinding(data, binding)) return false;
  if (!redisUrl) {
    return false; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return false;
  }

  try {
    const exactKey = screenshotBindingCacheKey(binding);
    const legacyKey = `${SCREENSHOT_KEY_PREFIX}${binding.deviceId}`;
    const serialized = JSON.stringify(data);
    await redisPublisher
      .multi()
      .setEx(exactKey, SCREENSHOT_TTL_SECONDS, serialized)
      // One-TTL compatibility bridge for API tasks that still read the old
      // device-only key. The payload itself carries the complete binding.
      .setEx(legacyKey, SCREENSHOT_TTL_SECONDS, serialized)
      .exec();
    return true;
  } catch (error) {
    console.warn("[Screenshot] Redis setEx failed:", safeErrorMetadata(error));
    return false;
  }
}

export async function getScreenshot(
  binding: ScreenshotBinding
): Promise<ScreenshotData | null> {
  if (!redisUrl) {
    return null; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return null;
  }

  try {
    const [exactRaw, legacyRaw] = await redisPublisher.mGet([
      screenshotBindingCacheKey(binding),
      `${SCREENSHOT_KEY_PREFIX}${binding.deviceId}`,
    ]);
    const exact = decodeScreenshotData(exactRaw);
    if (screenshotMatchesBinding(exact, binding)) return exact;
    const legacy = decodeScreenshotData(legacyRaw);
    return screenshotMatchesBinding(legacy, binding, { allowLegacy: true })
      ? legacy
      : null;
  } catch (error) {
    console.warn("[Screenshot] Redis get failed:", safeErrorMetadata(error));
    return null;
  }
}

/**
 * Fetch a dashboard cohort with one Redis MGET. Missing/corrupt entries remain
 * null so the caller can use the existing per-process in-memory fallback
 * without issuing per-device Redis GETs.
 */
export async function getScreenshots(
  bindings: readonly ScreenshotBinding[]
): Promise<(ScreenshotData | null)[]> {
  if (bindings.length === 0) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  timeout.unref?.();
  try {
    // Keep the API rate-limiter Redis client out of lightweight one-off
    // processes that import this module only to publish an invalidation.
    const { redisCommand } = await import("../middleware/rateLimiter.js");
    const result = await redisCommand(
      [
        "MGET",
        ...bindings.map(screenshotBindingCacheKey),
        ...bindings.map((binding) => `${SCREENSHOT_KEY_PREFIX}${binding.deviceId}`),
      ],
      { readyTimeoutMs: 100, signal: controller.signal }
    );
    if (!Array.isArray(result) || result.length !== bindings.length * 2) {
      return bindings.map(() => null);
    }
    const values = result as unknown[];
    return bindings.map((binding, index) => {
      const exact = decodeScreenshotData(values[index]);
      if (screenshotMatchesBinding(exact, binding)) return exact;
      const legacy = decodeScreenshotData(values[index + bindings.length]);
      return screenshotMatchesBinding(legacy, binding, { allowLegacy: true })
        ? legacy
        : null;
    });
  } catch (error) {
    console.warn("[Screenshot] Redis mGet failed:", safeErrorMetadata(error));
    return bindings.map(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

// Flight path status storage in Redis (for multi-instance deployments)
const FLIGHT_PATH_KEY_PREFIX = `${redisPrefix}:flightpath:`;
const FLIGHT_PATH_TTL_SECONDS = 3600; // 1 hour TTL (flight paths persist for the session)

export type FlightPathStatus = {
  active: boolean;
  flightPathName?: string;
  flightPathId?: string;
  appliedAt: number;
};

export async function setFlightPathStatus(deviceId: string, data: FlightPathStatus): Promise<boolean> {
  if (!redisUrl) {
    return false; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return false;
  }

  try {
    const key = `${FLIGHT_PATH_KEY_PREFIX}${deviceId}`;
    if (data.active) {
      await redisPublisher.setEx(key, FLIGHT_PATH_TTL_SECONDS, JSON.stringify(data));
    } else {
      // When removing flight path, delete the key
      await redisPublisher.del(key);
    }
    return true;
  } catch (error) {
    console.warn("[FlightPath] Redis set failed:", safeErrorMetadata(error));
    return false;
  }
}

export async function getFlightPathStatus(deviceId: string): Promise<FlightPathStatus | null> {
  if (!redisUrl) {
    return null; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return null;
  }

  try {
    const key = `${FLIGHT_PATH_KEY_PREFIX}${deviceId}`;
    const data = await redisPublisher.get(key);
    if (!data) {
      return null;
    }
    return JSON.parse(data) as FlightPathStatus;
  } catch (error) {
    console.warn("[FlightPath] Redis get failed:", safeErrorMetadata(error));
    return null;
  }
}

// Device lastSeenAt storage in Redis (for multi-instance deployments)
// This ensures all ECS instances see the same lastSeenAt timestamp
const DEVICE_LASTSEEN_KEY_PREFIX = `${redisPrefix}:lastseen:`;
const DEVICE_LASTSEEN_TTL_SECONDS = 300; // 5 minutes TTL

export async function setDeviceLastSeen(deviceId: string, timestamp: number): Promise<boolean> {
  if (!redisUrl) {
    return false; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return false;
  }

  try {
    const key = `${DEVICE_LASTSEEN_KEY_PREFIX}${deviceId}`;
    await redisPublisher.setEx(key, DEVICE_LASTSEEN_TTL_SECONDS, timestamp.toString());
    return true;
  } catch (error) {
    console.warn("[LastSeen] Redis set failed:", safeErrorMetadata(error));
    return false;
  }
}

export async function getDeviceLastSeen(deviceId: string): Promise<number | null> {
  if (!redisUrl) {
    return null; // Fallback to in-memory
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisPublisher) {
    return null;
  }

  try {
    const key = `${DEVICE_LASTSEEN_KEY_PREFIX}${deviceId}`;
    const data = await redisPublisher.get(key);
    if (!data) {
      return null;
    }
    return parseInt(data, 10);
  } catch (error) {
    console.warn("[LastSeen] Redis get failed:", safeErrorMetadata(error));
    return null;
  }
}
