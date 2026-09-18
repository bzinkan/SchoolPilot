import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * Trust signals for class chat. `seen_at` is set from the student's device
 * when a teacher message was actually on screen (delivery_status 'seen');
 * `read_at`/`read_by` record when authorized staff opened a student's message
 * on the dashboard. Students never see read receipts; both are additive and
 * nullable so history rows are untouched.
 */
export const CLASSPILOT_CHAT_SEEN_STATE_SQL = `
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_by TEXT;
`;

export const classpilotChatSeenStateMigration: SchoolPilotMigration = {
  id: "classpilot-chat-seen-state-20260918",
  checksum: createHash("sha256").update(CLASSPILOT_CHAT_SEEN_STATE_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_CHAT_SEEN_STATE_SQL); },
};
