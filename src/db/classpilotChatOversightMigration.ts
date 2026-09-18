import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * Soft deletes for class chat. A teacher removing a message hides it from the
 * class views but keeps the row so a transcript stays complete for review;
 * retention purges it with the rest of the safety spine.
 */
export const CLASSPILOT_CHAT_OVERSIGHT_SQL = `
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;
`;

export const classpilotChatOversightMigration: SchoolPilotMigration = {
  id: "classpilot-chat-oversight-20260918",
  checksum: createHash("sha256").update(CLASSPILOT_CHAT_OVERSIGHT_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_CHAT_OVERSIGHT_SQL); },
};
