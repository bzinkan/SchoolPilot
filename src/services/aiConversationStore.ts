import crypto from "crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

export const AI_CONVERSATION_TTL_SECONDS = 30 * 60;
export const AI_CONVERSATION_MAX_MESSAGES = 40;
export const AI_CONVERSATION_MAX_BYTES = 128 * 1024;
const MAX_LOCAL_CONVERSATIONS = 1_024;

export type AiConversationContext = {
  userId: string;
  schoolId: string;
  schoolName: string;
  userName: string;
  userRole: string;
  licensedProducts: string[];
};

export type StoredAiConversation = {
  revision: number;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  systemPrompt: string;
  context: AiConversationContext;
  lastActivity: number;
  pendingToolUse?: {
    toolUseId: string;
    toolName: string;
    args: Record<string, unknown>;
    expiresAt: number;
  };
};

type RedisCommand = typeof redisCommand;
type LocalEntry = { value: StoredAiConversation; expiresAt: number };

export class AiConversationStoreError extends Error {
  constructor(public readonly code: "unavailable" | "conflict" | "too_large") {
    super(`AI conversation ${code}`);
  }
}

function storeSecret(): string {
  const configured = process.env.AI_CHAT_STATE_HMAC_SECRET || process.env.JWT_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("AI_CHAT_STATE_HMAC_SECRET is required in production");
  }
  return configured || "schoolpilot-development-ai-chat-state";
}

function keyFor(conversationId: string, context: Pick<AiConversationContext, "schoolId" | "userId">): string {
  const digest = crypto
    .createHmac("sha256", storeSecret())
    .update(context.schoolId)
    .update("\0")
    .update(context.userId)
    .update("\0")
    .update(conversationId)
    .digest("base64url");
  return `${process.env.REDIS_PREFIX ?? "schoolpilot"}:ai-chat:v1:${digest}`;
}

function matchesContext(
  value: StoredAiConversation,
  context: Pick<AiConversationContext, "schoolId" | "userId">
): boolean {
  return value.context.schoolId === context.schoolId && value.context.userId === context.userId;
}

function bounded(value: StoredAiConversation): StoredAiConversation {
  const next: StoredAiConversation = {
    ...value,
    messages: value.messages.slice(-AI_CONVERSATION_MAX_MESSAGES),
    context: { ...value.context, licensedProducts: value.context.licensedProducts.slice(0, 16) },
  };
  while (
    next.messages.length > 0
    && Buffer.byteLength(JSON.stringify(next), "utf8") > AI_CONVERSATION_MAX_BYTES
  ) next.messages.shift();
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > AI_CONVERSATION_MAX_BYTES) {
    throw new AiConversationStoreError("too_large");
  }
  return next;
}

function decode(raw: unknown): StoredAiConversation | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > AI_CONVERSATION_MAX_BYTES) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<StoredAiConversation>;
    if (
      !Number.isSafeInteger(value.revision)
      || Number(value.revision) < 0
      || !Array.isArray(value.messages)
      || typeof value.systemPrompt !== "string"
      || !value.context
      || typeof value.context.schoolId !== "string"
      || typeof value.context.userId !== "string"
      || typeof value.lastActivity !== "number"
    ) return null;
    return value as StoredAiConversation;
  } catch {
    return null;
  }
}

export function createAiConversationStore(command: RedisCommand = redisCommand) {
  const local = new Map<string, LocalEntry>();

  const pruneLocal = (now = Date.now()) => {
    for (const [key, entry] of local) if (entry.expiresAt <= now) local.delete(key);
    while (local.size >= MAX_LOCAL_CONVERSATIONS) {
      const oldest = local.keys().next().value as string | undefined;
      if (!oldest) break;
      local.delete(oldest);
    }
  };

  async function load(
    conversationId: string,
    context: Pick<AiConversationContext, "schoolId" | "userId">
  ): Promise<StoredAiConversation | null> {
    const key = keyFor(conversationId, context);
    if (process.env.REDIS_URL) {
      try {
        const raw = await command(["GET", key], { readyTimeoutMs: 500 });
        if (raw === null) return null;
        const value = decode(raw);
        if (!value || !matchesContext(value, context)) return null;
        return value;
      } catch {
        throw new AiConversationStoreError("unavailable");
      }
    }
    pruneLocal();
    const entry = local.get(key);
    return entry && matchesContext(entry.value, context) ? structuredClone(entry.value) : null;
  }

  async function save(
    conversationId: string,
    context: Pick<AiConversationContext, "schoolId" | "userId">,
    value: StoredAiConversation,
    expectedRevision: number
  ): Promise<StoredAiConversation> {
    const next = bounded({
      ...value,
      revision: expectedRevision + 1,
      lastActivity: Date.now(),
    });
    const key = keyFor(conversationId, context);
    if (process.env.REDIS_URL) {
      try {
        const result = await command([
          "EVAL",
          "local raw=redis.call('GET',KEYS[1]); if raw then local ok,current=pcall(cjson.decode,raw); if not ok or tonumber(current.revision)~=tonumber(ARGV[1]) then return -1 end elseif tonumber(ARGV[1])~=0 then return -1 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return tonumber(ARGV[4])",
          "1",
          key,
          String(expectedRevision),
          JSON.stringify(next),
          String(AI_CONVERSATION_TTL_SECONDS),
          String(next.revision),
        ], { readyTimeoutMs: 500 });
        if (Number(result) === -1) throw new AiConversationStoreError("conflict");
        if (Number(result) !== next.revision) throw new AiConversationStoreError("unavailable");
        return next;
      } catch (error) {
        if (error instanceof AiConversationStoreError) throw error;
        throw new AiConversationStoreError("unavailable");
      }
    }
    pruneLocal();
    const current = local.get(key)?.value;
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new AiConversationStoreError("conflict");
    }
    local.set(key, {
      value: structuredClone(next),
      expiresAt: Date.now() + AI_CONVERSATION_TTL_SECONDS * 1_000,
    });
    return next;
  }

  async function remove(
    conversationId: string,
    context: Pick<AiConversationContext, "schoolId" | "userId">
  ): Promise<boolean> {
    const key = keyFor(conversationId, context);
    if (process.env.REDIS_URL) {
      try {
        return Number(await command(["DEL", key], { readyTimeoutMs: 500 })) > 0;
      } catch {
        throw new AiConversationStoreError("unavailable");
      }
    }
    return local.delete(key);
  }

  return { load, save, remove };
}

export const aiConversationStore = createAiConversationStore();
