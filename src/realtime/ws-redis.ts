import { createHash, randomUUID } from "crypto";
import { createClient, type RedisClientType } from "redis";
import {
  dispatchCacheInvalidation,
  registerCacheInvalidationPublisher,
  type CacheInvalidationTarget,
} from "./cacheInvalidation.js";
import { safeErrorMetadata } from "../util/safeLogging.js";
import { correlateClasspilotSessionMessage, correlateClasspilotContextMessage } from "../services/classpilotSessionSubscription.js";
import { BoundedRedisPublication, REDIS_PUBLICATION_LIMITS, type RedisPublicationOutcome,
  type PublicationDiagnostic } from "./boundedRedisPublication.js";

export type WsRedisTarget =
  | { kind: "staff"; schoolId: string }
  | { kind: "staff-user"; schoolId: string; userId: string }
  | { kind: "staff-session"; schoolId: string; sessionId: string }
  | { kind: "staff-context"; schoolId: string; supervisionContextId: string; assignedStaffId: string; contextAuthorityRevision: string; audience?: "owner-and-observers" }
  | { kind: "live-view-authority"; schoolId: string; studentIds: string[] }
  | { kind: "students"; schoolId: string; targetDeviceIds?: string[] }
  | { kind: "device"; schoolId: string; deviceId: string }
  | {
      kind: "student-binding";
      schoolId: string;
      studentId: string;
      studentSessionId: string;
      deviceId: string;
      requiredCapability?:
        | "lateSignInRestrictionSsoV1"
        | "restrictionAuthPassThroughV1"
        | "preciseRestrictionResourcesV1"
        | "focusTabV1"
        | "screenshotActiveObservationCadenceV1";
      requiredCapabilities?: Array<
        | "lateSignInRestrictionSsoV1"
        | "restrictionAuthPassThroughV1"
        | "preciseRestrictionResourcesV1"
        | "focusTabV1"
        | "screenshotActiveObservationCadenceV1"
      >;
    }
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
  | { status: "not_admitted" | "unknown"; subscriberCount: 0; reason: string };

export type PublishWSBatchItem = {
  target: WsRedisTarget;
  message: unknown;
  includeSource?: boolean;
};

function messageForTarget(target: WsRedisTarget, message: unknown): unknown {
  return target.kind === "staff-session"
    ? correlateClasspilotSessionMessage(target.sessionId, message)
    : target.kind === "staff-context"
      ? correlateClasspilotContextMessage(target.supervisionContextId, message)
      : message;
}

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
export const PUBLICATION_LATENCY_BUCKETS_MS = [25, 50, 100, 200, 250, 500, 1_000, 2_000, 5_000] as const;
const OBSERVATION_NOT_ADMITTED_LABELS = Object.freeze({
  not_ready: "not_admitted_not_ready",
  queue_full: "not_admitted_queue_full",
  circuit_open: "not_admitted_circuit_open",
  shutdown: "not_admitted_shutdown",
  aborted: "not_admitted_aborted",
  not_configured: "not_admitted_not_configured",
} as const);
const OBSERVATION_UNKNOWN_LABELS = Object.freeze({
  timeout: "unknown_timeout",
  transport_lost: "unknown_transport_lost",
  shutdown: "unknown_shutdown",
  aborted: "unknown_aborted",
} as const);
type ObservationStatusDiagnostic = "accepted"
  | typeof OBSERVATION_NOT_ADMITTED_LABELS[keyof typeof OBSERVATION_NOT_ADMITTED_LABELS]
  | typeof OBSERVATION_UNKNOWN_LABELS[keyof typeof OBSERVATION_UNKNOWN_LABELS];

type HotPathActivity = {
  publicationOutcomes: Partial<Record<PublicationDiagnostic, number>>;
  publicationLatency: Partial<Record<PublicationDiagnostic, {
    count: number; totalMs: number; maxMs: number; buckets: number[];
  }>>;
  coordinationOutcomes: Partial<Record<PublicationDiagnostic, number>>;
  coordinationLatency: HotPathActivity["publicationLatency"];
  observationStatusOutcomes: Partial<Record<ObservationStatusDiagnostic, number>>;
  redisMessagesPublished: number;
  redisSubscriberDeliveries: number;
  redisMessagesReceived: number;
  screenshotUploads: number;
  screenshotPayloadBytes: number;
  screenshotRedisStores: number;
  screenshotMemoryFallbacks: number;
  screenshotStoreUnavailable: number;
  screenshotDiscardedUploads: number;
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
    publicationOutcomes: {},
    publicationLatency: {},
    coordinationOutcomes: {},
    coordinationLatency: {},
    observationStatusOutcomes: {},
    redisMessagesPublished: 0,
    redisSubscriberDeliveries: 0,
    redisMessagesReceived: 0,
    screenshotUploads: 0,
    screenshotPayloadBytes: 0,
    screenshotRedisStores: 0,
    screenshotMemoryFallbacks: 0,
    screenshotStoreUnavailable: 0,
    screenshotDiscardedUploads: 0,
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
    Object.keys(activity.publicationOutcomes).length === 0 &&
    Object.keys(activity.coordinationOutcomes).length === 0 &&
    Object.keys(activity.observationStatusOutcomes).length === 0 &&
    Object.keys(activity.commandPhases).length === 0
  ) {
    return;
  }

  // Deliberately contains only process-level counts: no school, user, device,
  // URL, title, message payload, or Redis key data.
  console.log(JSON.stringify({
    event: "realtime_hot_path_summary",
    intervalSeconds: HOT_PATH_LOG_INTERVAL_MS / 1_000,
    publicationLatencyBoundsMs: PUBLICATION_LATENCY_BUCKETS_MS,
    ...activity,
  }));
}

const hotPathLogTimer = setInterval(flushHotPathActivity, HOT_PATH_LOG_INTERVAL_MS);
hotPathLogTimer.unref?.();

export function recordScreenshotUpload(
  payloadBytes: number,
  outcome: "redis" | "local_fallback" | "unavailable" | "discarded"
): void {
  hotPathActivity.screenshotUploads += 1;
  hotPathActivity.screenshotPayloadBytes += Math.max(0, payloadBytes);
  if (outcome === "redis") {
    hotPathActivity.screenshotRedisStores += 1;
  } else if (outcome === "local_fallback") {
    hotPathActivity.screenshotMemoryFallbacks += 1;
  } else if (outcome === "unavailable") {
    hotPathActivity.screenshotStoreUnavailable += 1;
  } else {
    hotPathActivity.screenshotDiscardedUploads += 1;
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
let redisSubscriptionRetryTimer: NodeJS.Timeout | undefined;

function recordRedisDiagnostic(stream: "publication" | "coordination", event: PublicationDiagnostic, durationMs?: number) {
  const outcomes = stream === "publication" ? hotPathActivity.publicationOutcomes : hotPathActivity.coordinationOutcomes;
  const latencies = stream === "publication" ? hotPathActivity.publicationLatency : hotPathActivity.coordinationLatency;
  outcomes[event] = (outcomes[event] ?? 0) + 1;
  if (durationMs === undefined || !Number.isFinite(durationMs)) return;
  const histogram = latencies[event] ?? { count: 0, totalMs: 0, maxMs: 0,
    buckets: Array(PUBLICATION_LATENCY_BUCKETS_MS.length + 1).fill(0) };
  const duration = Math.max(0, durationMs);
  const index = PUBLICATION_LATENCY_BUCKETS_MS.findIndex(bound => duration <= bound);
  histogram.buckets[index < 0 ? PUBLICATION_LATENCY_BUCKETS_MS.length : index]!++;
  histogram.count++;
  histogram.totalMs += duration;
  histogram.maxMs = Math.max(histogram.maxMs, duration);
  latencies[event] = histogram;
}

function recordObservationStatusOutcome(outcome: RedisPublicationOutcome<unknown>): void {
  try {
    const label = outcome.status === "accepted" ? "accepted"
      : outcome.status === "not_admitted" && Object.hasOwn(OBSERVATION_NOT_ADMITTED_LABELS, outcome.reason)
        ? OBSERVATION_NOT_ADMITTED_LABELS[outcome.reason]
        : outcome.status === "unknown" && Object.hasOwn(OBSERVATION_UNKNOWN_LABELS, outcome.reason)
          ? OBSERVATION_UNKNOWN_LABELS[outcome.reason] : undefined;
    if (label) hotPathActivity.observationStatusOutcomes[label] = (hotPathActivity.observationStatusOutcomes[label] ?? 0) + 1;
  } catch { /* Fixed diagnostics cannot change a coordination operation's disposition. */ }
}

const coordinationRuntime = new BoundedRedisPublication({
  create: () => {
    const client = createClient({ url: redisUrl, disableOfflineQueue: true,
      commandsQueueMaxLength: 2_048, socket: { connectTimeout: 1_000 } });
    redisPublisher = client;
    client.on("error", error => { warnRedis(error); });
    return client;
  },
  onDiagnostic: (event, durationMs) => recordRedisDiagnostic("coordination", event, durationMs),
});

// Dedicated publication socket: a stalled write must never pin the subscriber
// or advisory coordination/presence connection. Do not queue effects offline.
const publicationRuntime = new BoundedRedisPublication({
  create: () => {
    const client = createClient({ url: redisUrl, disableOfflineQueue: true,
      commandsQueueMaxLength: 2_048, socket: { connectTimeout: 1_000 } });
    client.on("error", error => { warnRedis(error); });
    return client;
  },
  onDiagnostic: (event, durationMs) => recordRedisDiagnostic("publication", event, durationMs),
});

export function getRedisPublicationSnapshot() { return publicationRuntime.snapshot(); }
export function getRedisCoordinationSnapshot() { return coordinationRuntime.snapshot(); }

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
  publicationRuntime.warmup();
  coordinationRuntime.warmup();
  if (redisInitPromise) {
    return redisInitPromise;
  }

  redisInitPromise = (async () => {
    try {
      console.log(`[Redis] Instance ${instanceShortId} connecting to Redis...`);
      const coordination = await coordinationRuntime.publish(client => client.ping(), { budgetMs: 500 });
      if (coordination.status !== "accepted") return;
      if (redisDisposed) return;
      console.log(`[Redis] Instance ${instanceShortId} publisher connected`);

      // Rebuilding a wedged coordination generation must not leak or replace
      // a healthy subscriber. node-redis owns resubscription on its reconnects.
      if (!redisSubscriber) {
      redisSubscriber = createClient({ url: redisUrl });
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
      }
      if (!redisSubscriber.isOpen) await redisSubscriber.connect();
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
  })().finally(() => { redisInitPromise = null; });

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
  const outcome = await coordinationRuntime.publish(client => client.sendCommand<T>(command), { budgetMs: timeoutMs });
  // Advisory presence/refresh claims fail closed. An uncertain SET is not
  // retried; its frozen timestamps/NX lease remain bounded if it executes late.
  return outcome.status === "accepted" ? outcome.value : undefined;
}

/** Bounded coordination reply plus its transport disposition. An AbortSignal
 * bounds only the caller, never corrupts the Redis delayed-reply queue. */
export async function realtimeRedisCommandOutcome(
  args: string[], options: { readyTimeoutMs?: number; signal?: AbortSignal; diagnosticOperation?: "observation_status" } = {},
): Promise<RedisPublicationOutcome<unknown>> {
  const outcome: RedisPublicationOutcome<unknown> = !redisUrl
    ? { status: "not_admitted", reason: "not_configured" }
    : await coordinationRuntime.publish(client => client.sendCommand(args), {
      budgetMs: 250, signal: options.signal,
    });
  if (options.diagnosticOperation === "observation_status") recordObservationStatusOutcome(outcome);
  return outcome;
}

/** Preserve the compatibility value contract; callers needing diagnostics can
 * retain the bounded disposition without repeating the command. */
export async function realtimeRedisCommand(
  args: string[], options: { readyTimeoutMs?: number; signal?: AbortSignal; diagnosticOperation?: "observation_status" } = {},
): Promise<unknown | undefined> {
  const outcome = await realtimeRedisCommandOutcome(args, options);
  return outcome.status === "accepted" ? outcome.value : undefined;
}

export async function subscribeWS(
  onMessage: (target: WsRedisTarget, message: unknown) => void
): Promise<void> {
  if (!redisUrl) {
    return;
  }
  await ensureRedisReady();
  if (!redisEnabled || !redisSubscriber) {
    if (!redisDisposed && !redisSubscriptionRetryTimer) {
      redisSubscriptionRetryTimer = setTimeout(() => {
        redisSubscriptionRetryTimer = undefined;
        void subscribeWS(onMessage);
      }, 1_000);
      redisSubscriptionRetryTimer.unref?.();
    }
    return;
  }
  if (subscriptionStarted) {
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

export type WsPublicationOutcome = RedisPublicationOutcome<number>;

function publicationEnvelope(target: WsRedisTarget, message: unknown, options: PublishWSOptions = {}): WsRedisEnvelope {
  return { instanceId, target, message: messageForTarget(target, message),
    includeSource: options.includeSource || undefined, orderedKey: options.orderedKey, revision: options.revision };
}

/** Explicit uncertainty is retained for callers that need transport evidence.
 * Legacy boolean helpers below remain advisory; they never mutate targets. */
export async function publishWSOutcome(
  target: WsRedisTarget, message: unknown, options: PublishWSOptions = {},
): Promise<WsPublicationOutcome> {
  if (!redisUrl) return { status: "not_admitted", reason: "not_configured" };
  const serialized = JSON.stringify(publicationEnvelope(target, message, options));
  const ordered = Boolean(options.orderedKey && options.revision);
  const result = await publicationRuntime.publish(client => ordered
    ? client.sendCommand<number>(["EVAL", ORDERED_PUBLISH_SCRIPT, "1",
        `${redisPrefix}:ws:ordered:${options.orderedKey}`, options.revision!,
        String(ORDERED_PUBLISH_TTL_SECONDS), redisChannel, serialized])
    : client.publish(redisChannel, serialized), { signal: options.signal });
  if (result.status === "accepted" && result.value >= 0) {
    hotPathActivity.redisMessagesPublished++;
    hotPathActivity.redisSubscriberDeliveries += result.value;
  }
  return result;
}

export async function publishWS(
  target: WsRedisTarget, message: unknown, options: PublishWSOptions = {},
): Promise<boolean> {
  const result = await publishWSOutcome(target, message, options);
  return result.status === "accepted" && (result.value > 0 || result.value === -1);
}

/** Only an accepted global revision claim permits source-local fan-out. A late
 * unknown publication can be superseded by a fresh authoritative snapshot; it
 * must never cause an unordered local fallback or a target failure. */
export async function publishOrderedWS(target: WsRedisTarget, message: unknown, options: {
  orderedKey: string; revision: string; includeSource?: boolean; signal?: AbortSignal;
}): Promise<OrderedPublishOutcome> {
  if (!redisUrl) return { status: "not_admitted", subscriberCount: 0, reason: "not_configured" };
  const serialized = JSON.stringify(publicationEnvelope(target, message, options));
  const result = await publicationRuntime.publish(client => client.sendCommand<number>([
    "EVAL", ORDERED_PUBLISH_SCRIPT, "1", `${redisPrefix}:ws:ordered:${options.orderedKey}`,
    options.revision, String(ORDERED_PUBLISH_TTL_SECONDS), redisChannel, serialized,
  ]), { signal: options.signal, budgetMs: REDIS_PUBLICATION_LIMITS.orderedMs });
  if (result.status !== "accepted") return { status: result.status, subscriberCount: 0, reason: result.reason };
  if (result.value === -1) return { status: "stale", subscriberCount: 0 };
  hotPathActivity.redisMessagesPublished++;
  hotPathActivity.redisSubscriberDeliveries += result.value;
  return { status: "accepted", subscriberCount: result.value };
}

/** Bounded cohorts retain input ordering. Each raw MULTI is tracked through
 * terminal settlement; no timeout retries an ambiguous one-shot publication. */
export async function publishWSBatchOutcomes(items: readonly PublishWSBatchItem[]): Promise<WsPublicationOutcome[]> {
  if (!redisUrl) return items.map(() => ({ status: "not_admitted", reason: "not_configured" }));
  // Capture every post-commit envelope before readiness or an earlier cohort
  // yields. Callers may reuse their mutable target/message objects afterward.
  const serialized = items.map(({ target, message, includeSource }) =>
    JSON.stringify(publicationEnvelope(target, message, { includeSource })));
  const results: WsPublicationOutcome[] = [];
  const deadline = performance.now() + REDIS_PUBLICATION_LIMITS.ordinaryMs;
  for (let start = 0; start < serialized.length; start += 40) {
    const cohort = serialized.slice(start, start + 40);
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      results.push(...serialized.slice(start).map(() => ({ status: "not_admitted" as const, reason: "not_ready" as const })));
      break;
    }
    const outcome = await publicationRuntime.publish(async client => {
      const pipeline = client.multi();
      for (const envelope of cohort) pipeline.publish(redisChannel, envelope);
      const replies = await pipeline.exec();
      const counts = replies.map(value => Number(value));
      if (counts.length !== cohort.length || counts.some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Invalid Redis publication batch reply");
      }
      return counts;
    }, { budgetMs: remaining });
    if (outcome.status === "accepted") {
      hotPathActivity.redisMessagesPublished += outcome.value.length;
      hotPathActivity.redisSubscriberDeliveries += outcome.value.reduce((total, count) => total + count, 0);
      results.push(...outcome.value.map(value => ({ status: "accepted" as const, value })));
    } else results.push(...cohort.map(() => outcome));
  }
  return results;
}

export async function publishWSBatch(items: readonly PublishWSBatchItem[]): Promise<boolean[]> {
  return (await publishWSBatchOutcomes(items)).map(result => result.status === "accepted" && result.value > 0);
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
  if (redisSubscriptionRetryTimer) clearTimeout(redisSubscriptionRetryTimer);
  await Promise.all([publicationRuntime.dispose(), coordinationRuntime.dispose()]);
  await closeRedisRuntimeForShutdown({
    initialization: redisInitPromise,
    clients: () => [redisSubscriber],
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
  teachingSessionId?: string;
  supervisionContextId?: string;
  controlRevision?: number;
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

export type ClassBoundScreenshotBinding = ScreenshotBinding & {
  teachingSessionId: string;
  controlRevision: number;
};

export type ClassBoundScreenshotData = BoundScreenshotData & ClassBoundScreenshotBinding;

/**
 * A supervision-claimed student has no teaching session by construction: the
 * control-state CHECK constraint makes class scope and supervision scope
 * mutually exclusive. Its pixels bind to the supervision context and control
 * revision instead, and live in their own key namespace.
 */
export type SupervisionBoundScreenshotBinding = ScreenshotBinding & {
  supervisionContextId: string;
  controlRevision: number;
};

export type SupervisionBoundScreenshotData =
  BoundScreenshotData & SupervisionBoundScreenshotBinding;

export type ScreenshotBatchReadResult =
  | { status: "ok"; screenshots: (ScreenshotData | null)[] }
  | { status: "unavailable" };

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

function classBoundScreenshotBindingDigest(binding: ClassBoundScreenshotBinding): string {
  return createHash("sha256")
    .update(binding.schoolId)
    .update("\0")
    .update(binding.deviceId)
    .update("\0")
    .update(binding.studentId)
    .update("\0")
    .update(binding.studentSessionId)
    .update("\0")
    .update(binding.teachingSessionId)
    .update("\0")
    .update(String(binding.controlRevision))
    .digest("hex");
}

export function screenshotBindingVersion(binding: ScreenshotBinding): string {
  return `v1:${screenshotBindingDigest(binding)}`;
}

export function screenshotBindingCacheKey(binding: ScreenshotBinding): string {
  return `${SCREENSHOT_KEY_PREFIX}bound:${screenshotBindingDigest(binding)}`;
}

export function classBoundScreenshotBindingVersion(
  binding: ClassBoundScreenshotBinding
): string {
  return `v2:${classBoundScreenshotBindingDigest(binding)}`;
}

export function classBoundScreenshotBindingCacheKey(
  binding: ClassBoundScreenshotBinding
): string {
  return `${SCREENSHOT_KEY_PREFIX}class-bound:${classBoundScreenshotBindingDigest(binding)}`;
}

// Domain-separated from the class digest so identical binding material cannot
// produce a colliding key across the two namespaces.
const SUPERVISION_BOUND_SCREENSHOT_DOMAIN = "classpilot:screenshot:supervision-bound:v1";

function supervisionBoundScreenshotBindingDigest(
  binding: SupervisionBoundScreenshotBinding
): string {
  return createHash("sha256")
    .update(SUPERVISION_BOUND_SCREENSHOT_DOMAIN)
    .update("\0")
    .update(binding.schoolId)
    .update("\0")
    .update(binding.deviceId)
    .update("\0")
    .update(binding.studentId)
    .update("\0")
    .update(binding.studentSessionId)
    .update("\0")
    .update(binding.supervisionContextId)
    .update("\0")
    .update(String(binding.controlRevision))
    .digest("hex");
}

export function supervisionBoundScreenshotBindingVersion(
  binding: SupervisionBoundScreenshotBinding
): string {
  return `v3:${supervisionBoundScreenshotBindingDigest(binding)}`;
}

export function supervisionBoundScreenshotBindingCacheKey(
  binding: SupervisionBoundScreenshotBinding
): string {
  return `${SCREENSHOT_KEY_PREFIX}supervision-bound:${supervisionBoundScreenshotBindingDigest(binding)}`;
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
    ...(typeof candidate.teachingSessionId === "string"
      ? { teachingSessionId: candidate.teachingSessionId }
      : {}),
    ...(typeof candidate.supervisionContextId === "string"
      ? { supervisionContextId: candidate.supervisionContextId }
      : {}),
    ...(Number.isSafeInteger(candidate.controlRevision)
      ? { controlRevision: candidate.controlRevision }
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

export function classBoundScreenshotMatchesBinding(
  data: ScreenshotData | null,
  binding: ClassBoundScreenshotBinding
): boolean {
  if (!data) return false;
  const capturedAtMs = typeof data.capturedAt === "string"
    ? Date.parse(data.capturedAt)
    : Number.NaN;
  return data.schoolId === binding.schoolId
    && data.deviceId === binding.deviceId
    && data.studentId === binding.studentId
    && data.studentSessionId === binding.studentSessionId
    && data.teachingSessionId === binding.teachingSessionId
    && data.supervisionContextId === undefined
    && data.controlRevision === binding.controlRevision
    && data.bindingVersion === classBoundScreenshotBindingVersion(binding)
    && Number.isFinite(capturedAtMs)
    && Math.abs(capturedAtMs - data.timestamp) <= 1_000;
}

/**
 * The mirror of the class matcher. The two are mutually exclusive by field
 * presence as well as by key namespace and binding-version prefix, so a pixel
 * captured under one authority can never satisfy a read under the other.
 */
export function supervisionBoundScreenshotMatchesBinding(
  data: ScreenshotData | null,
  binding: SupervisionBoundScreenshotBinding
): boolean {
  if (!data) return false;
  const capturedAtMs = typeof data.capturedAt === "string"
    ? Date.parse(data.capturedAt)
    : Number.NaN;
  return data.schoolId === binding.schoolId
    && data.deviceId === binding.deviceId
    && data.studentId === binding.studentId
    && data.studentSessionId === binding.studentSessionId
    && data.supervisionContextId === binding.supervisionContextId
    && data.teachingSessionId === undefined
    && data.controlRevision === binding.controlRevision
    && data.bindingVersion === supervisionBoundScreenshotBindingVersion(binding)
    && Number.isFinite(capturedAtMs)
    && Math.abs(capturedAtMs - data.timestamp) <= 1_000;
}

// A delayed cache write may complete after its HTTP caller timed out. Compare
// capture timestamps atomically so it cannot replace a newer authorized image.
export const SET_SCREENSHOT_IF_NEWER_SCRIPT = `
local timestamp = tonumber(ARGV[2])
for _, key in ipairs(KEYS) do
  local current = redis.call('GET', key)
  local newer = false
  if current then
    local ok, value = pcall(cjson.decode, current)
    newer = ok and type(value) == 'table' and tonumber(value.timestamp) and tonumber(value.timestamp) > timestamp
  end
  if not newer then redis.call('SET', key, ARGV[1], 'EX', ARGV[3]) end
end
return 1
`;

async function storeScreenshot(keys: string[], data: ScreenshotData): Promise<boolean> {
  if (!redisUrl) return false;
  const result = await executeRealtimeRedisCommand<number>(["EVAL", SET_SCREENSHOT_IF_NEWER_SCRIPT,
    String(keys.length), ...keys, JSON.stringify(data), String(data.timestamp), String(SCREENSHOT_TTL_SECONDS)], { timeoutMs: 250 });
  return result === 1;
}

export async function setScreenshot(binding: ScreenshotBinding, data: BoundScreenshotData): Promise<boolean> {
  if (!screenshotMatchesBinding(data, binding)) return false;
  return storeScreenshot([screenshotBindingCacheKey(binding), `${SCREENSHOT_KEY_PREFIX}${binding.deviceId}`], data);
}

export async function setClassBoundScreenshot(binding: ClassBoundScreenshotBinding, data: ClassBoundScreenshotData): Promise<boolean> {
  if (!classBoundScreenshotMatchesBinding(data, binding)) return false;
  return storeScreenshot([classBoundScreenshotBindingCacheKey(binding)], data);
}

export async function setSupervisionBoundScreenshot(binding: SupervisionBoundScreenshotBinding, data: SupervisionBoundScreenshotData): Promise<boolean> {
  if (!supervisionBoundScreenshotMatchesBinding(data, binding)) return false;
  return storeScreenshot([supervisionBoundScreenshotBindingCacheKey(binding)], data);
}

export async function getScreenshot(
  binding: ScreenshotBinding
): Promise<
  | { status: "ok"; screenshot: ScreenshotData | null }
  | { status: "unavailable" }
> {
  const batch = await getScreenshots([binding]);
  return batch.status === "unavailable"
    ? batch
    : { status: "ok", screenshot: batch.screenshots[0] ?? null };
}

export async function getClassBoundScreenshot(
  binding: ClassBoundScreenshotBinding
): Promise<
  | { status: "ok"; screenshot: ScreenshotData | null }
  | { status: "unavailable" }
> {
  const batch = await getClassBoundScreenshots([binding]);
  return batch.status === "unavailable"
    ? batch
    : { status: "ok", screenshot: batch.screenshots[0] ?? null };
}

export function decodeScreenshotBatchRead(
  bindings: readonly ScreenshotBinding[],
  result: unknown
): ScreenshotBatchReadResult {
  if (!Array.isArray(result) || result.length !== bindings.length * 2) {
    return { status: "unavailable" };
  }
  const values = result as unknown[];
  return {
    status: "ok",
    screenshots: bindings.map((binding, index) => {
      const exact = decodeScreenshotData(values[index]);
      if (screenshotMatchesBinding(exact, binding)) return exact;
      const legacy = decodeScreenshotData(values[index + bindings.length]);
      return screenshotMatchesBinding(legacy, binding, { allowLegacy: true })
        ? legacy
        : null;
    }),
  };
}

export function decodeClassBoundScreenshotBatchRead(
  bindings: readonly ClassBoundScreenshotBinding[],
  result: unknown
): ScreenshotBatchReadResult {
  if (!Array.isArray(result) || result.length !== bindings.length) {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    screenshots: bindings.map((binding, index) => {
      const screenshot = decodeScreenshotData(result[index]);
      return classBoundScreenshotMatchesBinding(screenshot, binding) ? screenshot : null;
    }),
  };
}

export function decodeSupervisionBoundScreenshotBatchRead(
  bindings: readonly SupervisionBoundScreenshotBinding[],
  result: unknown
): ScreenshotBatchReadResult {
  if (!Array.isArray(result) || result.length !== bindings.length) {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    screenshots: bindings.map((binding, index) => {
      const screenshot = decodeScreenshotData(result[index]);
      return supervisionBoundScreenshotMatchesBinding(screenshot, binding) ? screenshot : null;
    }),
  };
}

/**
 * Fetch a dashboard cohort with one Redis MGET. A successful read keeps
 * missing, expired, mismatched, or corrupt rows isolated as null. Transport
 * and protocol failures are distinct so callers can retain the last known
 * authorized preview instead of presenting a false cache miss.
 */
export async function getScreenshots(
  bindings: readonly ScreenshotBinding[]
): Promise<ScreenshotBatchReadResult> {
  if (bindings.length === 0) return { status: "ok", screenshots: [] };
  if (!redisUrl) {
    return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production"
      ? { status: "unavailable" }
      : { status: "ok", screenshots: bindings.map(() => null) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  timeout.unref?.();
  try {
    // Keep the API rate-limiter Redis client out of lightweight one-off
    // processes that import this module only to publish an invalidation.
    const redisCommand = realtimeRedisCommand;
    const result = await redisCommand(
      [
        "MGET",
        ...bindings.map(screenshotBindingCacheKey),
        ...bindings.map((binding) => `${SCREENSHOT_KEY_PREFIX}${binding.deviceId}`),
      ],
      { readyTimeoutMs: 100, signal: controller.signal }
    );
    return decodeScreenshotBatchRead(bindings, result);
  } catch (error) {
    console.warn("[Screenshot] Redis mGet failed:", safeErrorMetadata(error));
    return { status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

/** V2 class reads never consult V1 or device-only compatibility keys. */
export async function getClassBoundScreenshots(
  bindings: readonly ClassBoundScreenshotBinding[]
): Promise<ScreenshotBatchReadResult> {
  if (bindings.length === 0) return { status: "ok", screenshots: [] };
  if (!redisUrl) {
    return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production"
      ? { status: "unavailable" }
      : { status: "ok", screenshots: bindings.map(() => null) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  timeout.unref?.();
  try {
    const redisCommand = realtimeRedisCommand;
    const result = await redisCommand(
      ["MGET", ...bindings.map(classBoundScreenshotBindingCacheKey)],
      { readyTimeoutMs: 100, signal: controller.signal }
    );
    return decodeClassBoundScreenshotBatchRead(bindings, result);
  } catch (error) {
    console.warn("[Screenshot] Redis class-bound mGet failed:", safeErrorMetadata(error));
    return { status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Supervision reads never consult class, V1, or device-only keys. */
export async function getSupervisionBoundScreenshots(
  bindings: readonly SupervisionBoundScreenshotBinding[]
): Promise<ScreenshotBatchReadResult> {
  if (bindings.length === 0) return { status: "ok", screenshots: [] };
  if (!redisUrl) {
    return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production"
      ? { status: "unavailable" }
      : { status: "ok", screenshots: bindings.map(() => null) };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  timeout.unref?.();
  try {
    const redisCommand = realtimeRedisCommand;
    const result = await redisCommand(
      ["MGET", ...bindings.map(supervisionBoundScreenshotBindingCacheKey)],
      { readyTimeoutMs: 100, signal: controller.signal }
    );
    return decodeSupervisionBoundScreenshotBatchRead(bindings, result);
  } catch (error) {
    console.warn(
      "[Screenshot] Redis supervision-bound mGet failed:",
      safeErrorMetadata(error)
    );
    return { status: "unavailable" };
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
  const key = `${FLIGHT_PATH_KEY_PREFIX}${deviceId}`;
  const result = await executeRealtimeRedisCommand(data.active
    ? ["SETEX", key, String(FLIGHT_PATH_TTL_SECONDS), JSON.stringify(data)] : ["DEL", key]);
  return result !== undefined;
}

export async function getFlightPathStatus(deviceId: string): Promise<FlightPathStatus | null> {
  const data = await executeRealtimeRedisCommand<string | null>(["GET", `${FLIGHT_PATH_KEY_PREFIX}${deviceId}`]);
  if (typeof data !== "string") return null;
  try { return JSON.parse(data) as FlightPathStatus; } catch { return null; }
}

const DEVICE_LASTSEEN_KEY_PREFIX = `${redisPrefix}:lastseen:`;
const DEVICE_LASTSEEN_TTL_SECONDS = 300;
export async function setDeviceLastSeen(deviceId: string, timestamp: number): Promise<boolean> {
  return (await executeRealtimeRedisCommand(["SETEX", `${DEVICE_LASTSEEN_KEY_PREFIX}${deviceId}`,
    String(DEVICE_LASTSEEN_TTL_SECONDS), String(timestamp)])) !== undefined;
}
export async function getDeviceLastSeen(deviceId: string): Promise<number | null> {
  const data = await executeRealtimeRedisCommand<string | null>(["GET", `${DEVICE_LASTSEEN_KEY_PREFIX}${deviceId}`]);
  if (typeof data !== "string") return null;
  const value = Number(data);
  return Number.isFinite(value) ? value : null;
}
