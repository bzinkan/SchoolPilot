import { randomUUID } from "crypto";
import { createClient, type RedisClientType } from "redis";

export type SocketIoRedisMessage = {
  room: string;
  event: string;
  data: unknown;
};

type SocketIoRedisEnvelope = SocketIoRedisMessage & {
  instanceId: string;
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

function warnRedis(error?: unknown) {
  if (warned) return;
  warned = true;
  if (error) {
    console.warn("[Socket.io Redis] relay disabled; running local-only.", error);
  } else {
    console.warn("[Socket.io Redis] relay disabled; running local-only.");
  }
}

async function ensureReady(): Promise<void> {
  if (!redisUrl) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      publisher = createClient({ url: redisUrl });
      publisher.on("error", (err: unknown) => warnRedis(err));
      await publisher.connect();

      subscriber = publisher.duplicate();
      subscriber.on("error", (err: unknown) => warnRedis(err));
      await subscriber.connect();

      enabled = true;
      console.log("[Socket.io Redis] relay connected");
    } catch (error) {
      enabled = false;
      warnRedis(error);
    }
  })();

  return initPromise;
}

export async function subscribeSocketIoRedis(
  onMessage: (message: SocketIoRedisMessage) => void
): Promise<void> {
  if (!redisUrl) return;
  await ensureReady();
  if (!enabled || !subscriber || subscribed) return;

  subscribed = true;
  await subscriber.subscribe(redisChannel, (payload: string) => {
    try {
      const envelope = JSON.parse(payload) as SocketIoRedisEnvelope;
      if (!envelope || envelope.instanceId === instanceId) return;
      onMessage({
        room: envelope.room,
        event: envelope.event,
        data: envelope.data,
      });
    } catch (error) {
      warnRedis(error);
    }
  });
}

export async function publishSocketIoRedis(
  message: SocketIoRedisMessage
): Promise<void> {
  if (!redisUrl) return;
  await ensureReady();
  if (!enabled || !publisher) return;

  try {
    await publisher.publish(
      redisChannel,
      JSON.stringify({ ...message, instanceId } satisfies SocketIoRedisEnvelope)
    );
  } catch (error) {
    warnRedis(error);
  }
}
