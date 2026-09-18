import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { nextTeacherChatDeliveryState, parseTeacherChatAckStatus } from "../src/services/classpilotStudentChat.js";
import { CLASSPILOT_CHAT_SEEN_STATE_SQL, classpilotChatSeenStateMigration } from "../src/db/classpilotChatSeenStateMigration.js";
import { schoolPilot27Migrations } from "../src/db/migrations27.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const t0 = new Date("2026-09-18T14:00:00.000Z");
const t1 = new Date("2026-09-18T14:00:05.000Z");
const t2 = new Date("2026-09-18T14:00:09.000Z");

describe("teacher chat delivery state", () => {
  it("only moves forward: sent -> delivered -> seen, and seen is terminal", () => {
    const fresh = { deliveryStatus: "sent", deliveredAt: null, seenAt: null };
    assert.deepEqual(nextTeacherChatDeliveryState(fresh, { status: "delivered", at: t1 }), {
      changed: true, outboxState: "delivered",
      message: { deliveryStatus: "delivered", deliveredAt: t1, failedAt: null, errorMessage: null },
    });
    const delivered = { deliveryStatus: "delivered", deliveredAt: t1, seenAt: null };
    assert.deepEqual(nextTeacherChatDeliveryState(delivered, { status: "delivered", at: t2 }), { changed: false }, "a repeat delivered ack is a no-op");
    assert.deepEqual(nextTeacherChatDeliveryState(delivered, { status: "failed", at: t2, errorMessage: "late" }), { changed: false }, "a late failure never regresses delivered");
    assert.deepEqual(nextTeacherChatDeliveryState(delivered, { status: "seen", at: t2 }), {
      changed: true, outboxState: "delivered",
      message: { deliveryStatus: "seen", deliveredAt: t1, seenAt: t2, failedAt: null, errorMessage: null },
    }, "seen keeps the original deliveredAt");
    const seen = { deliveryStatus: "seen", deliveredAt: t1, seenAt: t2 };
    for (const status of ["delivered", "failed", "seen"] as const) {
      assert.deepEqual(nextTeacherChatDeliveryState(seen, { status, at: new Date(t2.getTime() + 1000) }), { changed: false }, `${status} after seen`);
    }
  });

  it("backfills delivery when a message is seen before it was acknowledged, and keeps a failed ack retryable", () => {
    assert.deepEqual(nextTeacherChatDeliveryState({ deliveryStatus: "sent", deliveredAt: null, seenAt: null }, { status: "seen", at: t1 }), {
      changed: true, outboxState: "delivered",
      message: { deliveryStatus: "seen", deliveredAt: t1, seenAt: t1, failedAt: null, errorMessage: null },
    });
    assert.deepEqual(nextTeacherChatDeliveryState({ deliveryStatus: "failed", deliveredAt: null, seenAt: null }, { status: "seen", at: t1 }).changed, true);
    const failed = nextTeacherChatDeliveryState({ deliveryStatus: "sent", deliveredAt: null, seenAt: null }, { status: "failed", at: t1, errorMessage: "x".repeat(600) });
    assert.equal(failed.changed, true);
    if (failed.changed) {
      assert.equal(failed.outboxState, "retry");
      assert.equal(failed.message.deliveryStatus, "sent");
      assert.equal(failed.message.errorMessage?.length, 500);
      assert.equal("deliveredAt" in failed.message, false, "a failure never touches delivery timestamps");
    }
    const defaulted = nextTeacherChatDeliveryState({ deliveryStatus: "sent", deliveredAt: null, seenAt: null }, { status: "failed", at: t0 });
    assert.equal(defaulted.changed && defaulted.message.errorMessage, "Device reported delivery failure");
  });

  it("parses only the three acknowledgement statuses", () => {
    assert.equal(parseTeacherChatAckStatus("seen"), "seen");
    assert.equal(parseTeacherChatAckStatus(" delivered "), "delivered");
    assert.equal(parseTeacherChatAckStatus("failed"), "failed");
    for (const value of ["read", "SEEN", "", undefined, null, 1, {}]) assert.equal(parseTeacherChatAckStatus(value), null);
  });

  it("registers an additive migration and mirrors it in Drizzle", async () => {
    assert.match(CLASSPILOT_CHAT_SEEN_STATE_SQL, /ALTER TABLE chat_messages\s+ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ,\s+ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,\s+ADD COLUMN IF NOT EXISTS read_by TEXT;/);
    assert.doesNotMatch(CLASSPILOT_CHAT_SEEN_STATE_SQL, /DROP|DELETE|UPDATE|NOT NULL/);
    assert.equal(classpilotChatSeenStateMigration.mode, "transactional");
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    assert.ok(ids.indexOf("classpilot-chat-channel-control-20260918") < ids.indexOf(classpilotChatSeenStateMigration.id));
    assert.equal(ids.at(-1), "20260824_staff_identity_integrity_contract");
    const [schema, index] = await Promise.all([source("src/schema/classpilot.ts"), source("src/index.ts")]);
    assert.match(schema, /\$type<"sent" \| "delivered" \| "failed" \| "seen">\(\)/);
    assert.match(schema, /seenAt: timestamp\("seen_at", \{ withTimezone: true \}\)/);
    assert.match(schema, /readAt: timestamp\("read_at", \{ withTimezone: true \}\),\s+readBy: text\("read_by"\)/);
    assert.match(index, /await pool\.query\(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL\);\s+await pool\.query\(CLASSPILOT_CHAT_SEEN_STATE_SQL\);/);
  });

  it("accepts a seen ack on both intake paths, fans seenAt to staff, and tells the device why an ack was refused", async () => {
    const [chat, websocket, storage] = await Promise.all([
      source("src/routes/classpilot/chat.ts"),
      source("src/realtime/websocket.ts"),
      source("src/services/storage.ts"),
    ]);
    const httpIntake = chat.slice(chat.indexOf('router.post("/device/chat-acks"'), chat.indexOf('router.get("/teacher/messages"'));
    assert.match(httpIntake, /parseTeacherChatAckStatus\(raw\?\.deliveryStatus \?\? raw\?\.status\)/);
    assert.match(httpIntake, /code: "INVALID_CHAT_ACK"/);
    assert.match(httpIntake, /code: await classpilotTeacherChatAckRejection\(\{ schoolId, chatMessageId: messageId, studentId \}\)/);
    assert.equal(httpIntake.match(/seenAt: acknowledged\.message\.seenAt/g)?.length, 2, "session and scheduled fan-out both carry seenAt");

    const wsIntake = websocket.slice(
      websocket.indexOf("// --- Student FAB chat delivery acknowledgements"),
      websocket.indexOf("// --- ClassPilot teacher command acknowledgements")
    );
    assert.match(wsIntake, /parseTeacherChatAckStatus\(message\.deliveryStatus \|\| message\.status\)/);
    assert.match(wsIntake, /accepted: false, code: "INVALID_CHAT_ACK"/);
    assert.match(wsIntake, /classpilotTeacherChatAckRejection\(\{ schoolId: client\.schoolId!, chatMessageId: messageId, studentId: client\.studentId! \}\)/);
    assert.equal(wsIntake.match(/seenAt: acknowledged\.message\.seenAt/g)?.length, 2);

    const ack = storage.slice(
      storage.indexOf("export async function acknowledgeTeacherChatDelivery"),
      storage.indexOf("export async function classpilotTeacherChatAckRejection")
    );
    assert.match(ack, /status: TeacherChatAckStatus;/);
    assert.match(ack, /nextTeacherChatDeliveryState\(existingMessage, \{ status: options\.status, at: now, errorMessage: options\.errorMessage \}\)/);
    assert.match(ack, /if \(!transition\.changed\) return \{ message: existingMessage, delivery \};/);
    assert.match(ack, /ne\(chatMessages\.deliveryStatus, "seen"\)/, "a seen row is never rewritten");
    assert.doesNotMatch(ack, /state: "seen"/, "the outbox CHECK has no seen state");
    // Binding, authority and expiry checks stay exactly where they were.
    assert.match(ack, /hasExactClasspilotTelemetryBinding\(options, transactionDb\)/);
    assert.match(ack, /hasCurrentClasspilotStudentControlAuthority\(/);
  });

  it("marks read only under the caller's own mutable classroom authority and never for students", async () => {
    const [chat, storage, compat] = await Promise.all([
      source("src/routes/classpilot/chat.ts"),
      source("src/services/storage.ts"),
      source("src/routes/compat.ts"),
    ]);
    const route = chat.slice(chat.indexOf('router.post("/teacher/messages/read"'), chat.indexOf('router.post("/teacher/reply"'));
    assert.match(route, /\.\.\.staffAuth/);
    assert.match(route, /authorizedStaffSession\(req, res, sessionId, \{ mutate: true \}\)/, "admin Observe never marks a teacher's inbox read");
    assert.match(route, /requireScheduledClassroomContext\(\{ schoolId, supervisionContextId: authority\.supervisionContextId, actorId \}\)/);
    assert.doesNotMatch(route, /allowObserve/);
    assert.match(route, /rawIds\.length > 200/);
    assert.equal(route.match(/type: "chat-messages-read"/g)?.length, 2);
    assert.doesNotMatch(route, /sendToDeviceLocal|sendToStudentBindingLocal/, "students are never told about read state");

    const marker = storage.slice(
      storage.indexOf("export async function markAuthorizedClasspilotStudentMessagesRead"),
      storage.indexOf("export async function createChatMessage")
    );
    assert.ok(storage.indexOf("export async function getChatMessages") < storage.indexOf("export async function markAuthorizedClasspilotStudentMessagesRead"),
      "placed after getChatMessages so the chat authority contract slice is unchanged");
    assert.match(marker, /eq\(chatMessages\.senderType, "student"\)/);
    assert.match(marker, /isNull\(chatMessages\.readAt\)/);
    assert.match(marker, /"sessionId" in options\.authority\s+\? eq\(chatMessages\.sessionId, options\.authority\.sessionId\)\s+: eq\(chatMessages\.supervisionContextId, options\.authority\.supervisionContextId\)/);
    assert.match(compat, /chatSeenAckV1: extensionCapabilities\.has\("chatSeenAckV1"\)/);
  });
});
