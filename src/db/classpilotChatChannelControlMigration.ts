import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * Soft chat pause. `chat_paused` is distinct from `chat_enabled`: disabled hides
 * the student's chat entirely, paused keeps the thread visible but refuses new
 * student messages. `pause_chat_during_testing` makes scheduled testing blocks
 * pause automatically (school default on).
 */
export const CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL = `
ALTER TABLE session_settings
  ADD COLUMN IF NOT EXISTS chat_paused BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS pause_chat_during_testing BOOLEAN NOT NULL DEFAULT true;
`;

export const classpilotChatChannelControlMigration: SchoolPilotMigration = {
  id: "classpilot-chat-channel-control-20260918",
  checksum: createHash("sha256").update(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => { await connection.query(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL); },
};
