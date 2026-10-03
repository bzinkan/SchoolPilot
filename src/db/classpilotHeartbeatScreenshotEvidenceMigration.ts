import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";
import { CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL, CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_REVOKE_SQL } from "./classpilotHeartbeatScreenshotEvidenceDefinition.js";
import { installClasspilotHeartbeatScreenshotEvidence } from "./classpilotHeartbeatScreenshotEvidenceInstallation.js";

// Additive function only: compatible older applications retain their own reader.
export const CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_MIGRATION_CONTRACT =
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL + CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_REVOKE_SQL + ";\n";

export const classpilotHeartbeatScreenshotEvidenceMigration: SchoolPilotMigration = {
  id: "classpilot-heartbeat-screenshot-evidence-v1-20261003",
  checksum: createHash("sha256").update(CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_MIGRATION_CONTRACT).digest("hex"),
  mode: "transactional",
  apply: installClasspilotHeartbeatScreenshotEvidence,
};
