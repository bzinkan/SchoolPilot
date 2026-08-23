import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_CONVERSATION_MAX_MESSAGES,
  AiConversationStoreError,
  createAiConversationStore,
  type StoredAiConversation,
} from "../src/services/aiConversationStore.js";

const context = {
  userId: "user-a",
  schoolId: "school-a",
  schoolName: "current school",
  userName: "current user",
  userRole: "teacher",
  licensedProducts: ["CLASSPILOT"],
};

function conversation(): StoredAiConversation {
  return {
    revision: 0,
    messages: [],
    systemPrompt: "bounded prompt",
    context,
    lastActivity: Date.now(),
  };
}

describe("AI conversation state", () => {
  it("is exact user/school scoped and bounded to forty messages", async () => {
    const previousRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const store = createAiConversationStore();
      const value = conversation();
      value.messages = Array.from({ length: 50 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `message-${index}`,
      }));
      const saved = await store.save("conversation", context, value, 0);
      assert.equal(saved.messages.length, AI_CONVERSATION_MAX_MESSAGES);
      assert.equal((await store.load("conversation", context))?.revision, 1);
      assert.equal(await store.load("conversation", { ...context, userId: "user-b" }), null);
    } finally {
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
    }
  });

  it("optimistically claims a revision exactly once", async () => {
    const previousRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const store = createAiConversationStore();
      const initial = await store.save("confirm", context, conversation(), 0);
      const first = structuredClone(initial);
      const second = structuredClone(initial);
      await store.save("confirm", context, first, first.revision);
      await assert.rejects(
        () => store.save("confirm", context, second, second.revision),
        (error: unknown) => error instanceof AiConversationStoreError && error.code === "conflict"
      );
    } finally {
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
    }
  });

  it("rejects state that cannot fit within 128 KiB after message trimming", async () => {
    const previousRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const store = createAiConversationStore();
      const value = conversation();
      value.systemPrompt = "x".repeat(140 * 1024);
      await assert.rejects(
        () => store.save("oversized", context, value, 0),
        (error: unknown) => error instanceof AiConversationStoreError && error.code === "too_large"
      );
    } finally {
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
    }
  });
});
