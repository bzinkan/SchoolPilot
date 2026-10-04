import { parseRlsEnabledTables } from "../db/rlsPolicies.js";
import registry from "./rlsRegistry.json" with { type: "json" };

export const PASSPILOT_APPOINTMENTS_MODE_KEY = "PASSPILOT_APPOINTMENTS_MODE";
export const PASSPILOT_APPOINTMENTS_ATOMIC_WRITER_CONTRACT_VERSION = 2;
export const PASSPILOT_APPOINTMENTS_RLS_TABLES = Object.freeze([...registry.inventories.passpilotAppointmentsPostExpand.tables]);
export type PasspilotAppointmentsMode = "off" | "on";
type Environment = Readonly<Record<string, string | undefined>>;

export function parsePasspilotAppointmentsMode(env: Environment = process.env): PasspilotAppointmentsMode {
  const value = env[PASSPILOT_APPOINTMENTS_MODE_KEY];
  if (value === undefined || value === "off") return "off";
  if (value === "on") return "on";
  throw Object.assign(new Error("PassPilot appointments configuration is invalid"), { code: "PASSPILOT_APPOINTMENTS_CONFIGURATION" });
}

export function readPasspilotAppointmentsMode(env: Environment = process.env): PasspilotAppointmentsMode {
  try {
    const admitted = parseRlsEnabledTables(env.RLS_ENABLED_TABLES);
    return parsePasspilotAppointmentsMode(env) === "on" && env.RLS_GUC_ENABLED === "true"
      && PASSPILOT_APPOINTMENTS_RLS_TABLES.every(table => admitted.has(table)) ? "on" : "off";
  } catch { return "off"; }
}
