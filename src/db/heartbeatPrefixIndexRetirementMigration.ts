import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";
import { HEARTBEAT_PREFIX_INDEX_RETIREMENT_CONTRACT, retireHeartbeatPrefixIndexesOnline } from "./heartbeatPrefixIndexRetirement.js";

export const heartbeatPrefixIndexRetirementMigration: SchoolPilotMigration = {
  id: "classpilot-heartbeat-prefix-index-retirement-20261110",
  checksum: createHash("sha256").update(HEARTBEAT_PREFIX_INDEX_RETIREMENT_CONTRACT).digest("hex"),
  mode: "nontransactional",
  apply: async connection => {
    await retireHeartbeatPrefixIndexesOnline({ query: async (text,values) => {
      const result=await connection.query(text,values);
      return {rows:result.rows};
    } });
  },
};
