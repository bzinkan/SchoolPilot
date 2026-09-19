import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  CHAT_TRANSCRIPT_MAX_WINDOW_DAYS,
  chatTranscriptWindow,
  decodeChatTranscriptCursor,
  encodeChatTranscriptCursor,
} from "../src/services/classpilotStudentChat.js";
import { CLASSPILOT_CHAT_OVERSIGHT_SQL, classpilotChatOversightMigration } from "../src/db/classpilotChatOversightMigration.js";
import {
  CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME,
  CLASSPILOT_CHAT_TRANSCRIPT_INDEX_SQL,
  classpilotChatTranscriptIndexMigration,
  ensureClasspilotChatTranscriptIndexOnline,
} from "../src/db/classpilotChatTranscriptIndexMigration.js";
import { schoolPilot27Migrations } from "../src/db/migrations27.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const DAY = 24 * 60 * 60 * 1000;

describe("class chat oversight", () => {
  it("round-trips a transcript cursor and rejects anything it did not issue", () => {
    const cursor = { at: "2026-09-18T14:00:00.000Z", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const encoded = encodeChatTranscriptCursor(cursor);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, "base64url, safe in a query string");
    assert.deepEqual(decodeChatTranscriptCursor(encoded), cursor);
    for (const bad of [undefined, null, "", 1, "not-base64!", Buffer.from("[]").toString("base64url"),
      Buffer.from(JSON.stringify({ at: "yesterday", id: "x" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: cursor.at, id: "" })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: cursor.at, id: "x".repeat(129) })).toString("base64url"),
      "a".repeat(600)]) {
      assert.equal(decodeChatTranscriptCursor(bad), null, JSON.stringify(bad)?.slice(0, 40));
    }
  });

  it("clamps a scoped window to the activity and an unscoped window to the last 90 days", () => {
    const now = new Date("2026-09-18T15:00:00.000Z");
    const scope = { from: new Date("2026-09-18T13:00:00.000Z"), to: new Date("2026-09-18T14:00:00.000Z") };
    assert.deepEqual(chatTranscriptWindow({ scope, now }), scope, "a scoped read defaults to the whole activity");
    assert.deepEqual(chatTranscriptWindow({ scope, now, requestedFrom: new Date("2026-09-18T12:00:00.000Z"), requestedTo: new Date("2026-09-18T16:00:00.000Z") }), scope,
      "a wider request is clamped to the activity");
    const inside = chatTranscriptWindow({ scope, now, requestedFrom: new Date("2026-09-18T13:15:00.000Z"), requestedTo: new Date("2026-09-18T13:30:00.000Z") });
    assert.deepEqual([inside.from.toISOString(), inside.to.toISOString()], ["2026-09-18T13:15:00.000Z", "2026-09-18T13:30:00.000Z"]);
    const inverted = chatTranscriptWindow({ scope, now, requestedFrom: new Date("2026-09-18T13:45:00.000Z"), requestedTo: new Date("2026-09-18T13:15:00.000Z") });
    assert.equal(inverted.from.getTime(), inverted.to.getTime(), "an inverted request yields an empty window, never a negative one");

    const open = chatTranscriptWindow({ now });
    assert.equal(open.to.getTime(), now.getTime());
    assert.equal(open.from.getTime(), now.getTime() - CHAT_TRANSCRIPT_MAX_WINDOW_DAYS * DAY);
    const tooWide = chatTranscriptWindow({ now, requestedFrom: new Date(now.getTime() - 400 * DAY), requestedTo: new Date(now.getTime() + 5 * DAY) });
    assert.equal(tooWide.to.getTime(), now.getTime(), "the future is clamped to now");
    assert.equal(tooWide.from.getTime(), now.getTime() - 90 * DAY, "an admin read never spans more than 90 days");
    const narrow = chatTranscriptWindow({ now, requestedFrom: new Date(now.getTime() - 2 * DAY), requestedTo: new Date(now.getTime() - DAY) });
    assert.deepEqual([narrow.from.getTime(), narrow.to.getTime()], [now.getTime() - 2 * DAY, now.getTime() - DAY]);
  });

  it("registers a transactional soft-delete migration and a nontransactional online index after the seen-state migration", async () => {
    assert.match(CLASSPILOT_CHAT_OVERSIGHT_SQL, /ALTER TABLE chat_messages\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,\s+ADD COLUMN IF NOT EXISTS deleted_by TEXT;/);
    assert.equal(classpilotChatOversightMigration.mode, "transactional");
    assert.equal(classpilotChatTranscriptIndexMigration.mode, "nontransactional");
    assert.match(CLASSPILOT_CHAT_TRANSCRIPT_INDEX_SQL, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME}\\s+ON chat_messages \\(school_id, student_id, created_at DESC, id DESC\\)`));
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    const seen = ids.indexOf("classpilot-chat-seen-state-20260918");
    assert.ok(seen < ids.indexOf(classpilotChatOversightMigration.id));
    assert.ok(ids.indexOf(classpilotChatOversightMigration.id) < ids.indexOf(classpilotChatTranscriptIndexMigration.id));
    assert.equal(ids.at(-1), "20260824_staff_identity_integrity_contract");
    const index = await source("src/index.ts");
    assert.match(index, /await pool\.query\(CLASSPILOT_CHAT_SEEN_STATE_SQL\);\s+await pool\.query\(CLASSPILOT_CHAT_OVERSIGHT_SQL\);\s+await pool\.query\(CLASSPILOT_CHAT_TRANSCRIPT_INDEX_SQL\);/);
  });

  it("drops an invalid leftover index before rebuilding, bounded by a statement timeout, and never wraps it in a transaction", async () => {
    const statements: string[] = [];
    let invalidRows = 1;
    const connection = { query: async (sql: string) => { statements.push(sql); return { rowCount: sql.includes("indisvalid") ? invalidRows : 0 }; } };
    await ensureClasspilotChatTranscriptIndexOnline(connection);
    assert.ok(statements.some((sql) => sql.includes("NOT index.indisvalid")));
    assert.ok(statements.some((sql) => sql.startsWith(`DROP INDEX CONCURRENTLY IF EXISTS ${CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME}`)));
    assert.ok(statements.indexOf("SET statement_timeout = '10min'") < statements.findIndex((sql) => sql.includes("CREATE INDEX CONCURRENTLY")));
    assert.equal(statements.at(-1), "RESET statement_timeout");
    assert.ok(statements.every((sql) => !/^\s*(BEGIN|COMMIT)/i.test(sql)));
    statements.length = 0;
    invalidRows = 0;
    await ensureClasspilotChatTranscriptIndexOnline(connection);
    assert.ok(!statements.some((sql) => sql.startsWith("DROP INDEX")), "a valid index is left alone");
  });

  it("soft-deletes chat rows, hides them from class reads, and audits deletes, closes and transcript reads without content", async () => {
    const [storage, chat, schema] = await Promise.all([
      source("src/services/storage.ts"),
      source("src/routes/classpilot/chat.ts"),
      source("src/schema/classpilot.ts"),
    ]);
    assert.match(schema, /deletedAt: timestamp\("deleted_at", \{ withTimezone: true \}\),\s+deletedBy: text\("deleted_by"\)/);
    const remove = storage.slice(
      storage.indexOf("export async function deleteAuthorizedClasspilotChatMessage"),
      storage.indexOf("export async function updateChatMessageDelivery")
    );
    assert.doesNotMatch(remove, /tx\.delete\(chatMessages\)/, "chat rows are never hard-deleted by a teacher");
    assert.match(remove, /\.set\(\{ deletedAt: new Date\(\), deletedBy: options\.actorId \}\)/);
    assert.match(remove, /if \(!message \|\| message\.deletedAt\)/, "deleting twice is a 404");
    assert.match(remove, /tx\.delete\(classpilotChatDeliveries\)/, "the outbox row still goes");
    const history = storage.slice(storage.indexOf("export async function getChatMessages"), storage.indexOf("export type ClasspilotChatTranscriptPage"));
    assert.match(history, /isNull\(chatMessages\.deletedAt\)/);
    assert.match(chat, /eq\(chatMessages\.supervisionContextId, context\.id\),\s+isNull\(chatMessages\.deletedAt\)/);

    const transcript = storage.slice(
      storage.indexOf("export async function listAuthorizedClasspilotStudentChatTranscript"),
      storage.indexOf("export async function createChatMessage")
    );
    assert.ok(storage.indexOf("export async function getChatMessages") < storage.indexOf("export async function listAuthorizedClasspilotStudentChatTranscript"),
      "kept after getChatMessages so the chat authority contract slice is unchanged");
    assert.match(transcript, /if \(!options\.includeDeleted\) conditions\.push\(isNull\(chatMessages\.deletedAt\)\)/);
    assert.match(transcript, /orderBy\(desc\(chatMessages\.createdAt\), desc\(chatMessages\.id\)\)/);
    assert.match(transcript, /::timestamp/, "cursor and anchor compare against the stored UTC wall clock, never a driver-local Date");
    assert.match(transcript, /Math\.min\(Math\.max\(Math\.trunc\(options\.limit\) \|\| 1, 1\), 200\)/);

    const route = chat.slice(chat.indexOf('router.get("/students/:studentId/messages"'), chat.indexOf('router.post("/teacher/dismiss-hand/:studentId"'));
    assert.match(route, /\.\.\.staffAuth/);
    assert.match(route, /if \(!authority && !admin\)/, "an unscoped read is admin-only");
    assert.match(route, /allowObserve: admin/);
    assert.match(route, /readActivityHistoryScope\(scopeOptions\)/);
    assert.match(route, /latest\.stamp !== historyScope\.stamp/, "a scope change mid-read is a 409");
    assert.match(route, /const includeDeleted = admin && req\.query\.includeDeleted === "true"/);
    assert.match(route, /action: "classpilot\.chat\.transcript_read"/);
    assert.doesNotMatch(route, /content:|\.content\b/, "audit metadata never carries message text");
    const remove_route = chat.slice(chat.indexOf('router.delete("/teacher/messages/:messageId"'), chat.indexOf('router.get("/students/:studentId/messages"'));
    assert.match(remove_route, /logAuditStrict\(\{[\s\S]*action: "classpilot\.chat\.message_deleted"/);
    assert.doesNotMatch(remove_route, /content:|\.content\b/);
    const close = chat.slice(chat.indexOf('router.post("/teacher/close-chat"'), chat.indexOf("router.", chat.indexOf('router.post("/teacher/close-chat"') + 10));
    assert.equal(close.match(/action: "classpilot\.chat\.closed"/g)?.length, 2, "both authority paths audit a close");
  });
});
