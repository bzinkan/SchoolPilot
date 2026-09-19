import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

export const CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME = "chat_messages_student_created_idx";

/**
 * Keyset order for a student's transcript: newest first within a school and
 * student. Built concurrently so a busy chat table never blocks writes.
 */
export const CLASSPILOT_CHAT_TRANSCRIPT_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME}
  ON chat_messages (school_id, student_id, created_at DESC, id DESC);
`;

const INVALID_INDEX_SQL = `
SELECT 1 FROM pg_index index
  JOIN pg_class relation ON relation.oid = index.indexrelid
  WHERE relation.relname = '${CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME}' AND NOT index.indisvalid
  LIMIT 1
`;

export async function ensureClasspilotChatTranscriptIndexOnline(connection: { query: (sql: string) => Promise<{ rowCount?: number | null }> }) {
  // A build interrupted earlier leaves an invalid index that IF NOT EXISTS
  // would happily keep; drop it first so the rebuild starts clean.
  const invalid = await connection.query(INVALID_INDEX_SQL);
  if ((invalid.rowCount ?? 0) > 0) {
    await connection.query(`DROP INDEX CONCURRENTLY IF EXISTS ${CLASSPILOT_CHAT_TRANSCRIPT_INDEX_NAME}`);
  }
  await connection.query("SET statement_timeout = '10min'");
  try {
    await connection.query(CLASSPILOT_CHAT_TRANSCRIPT_INDEX_SQL);
  } finally {
    await connection.query("RESET statement_timeout");
  }
}

export const classpilotChatTranscriptIndexMigration: SchoolPilotMigration = {
  id: "classpilot-chat-transcript-index-online-20260918",
  checksum: createHash("sha256").update(CLASSPILOT_CHAT_TRANSCRIPT_INDEX_SQL).digest("hex"),
  mode: "nontransactional",
  apply: async (connection) => { await ensureClasspilotChatTranscriptIndexOnline(connection); },
};
