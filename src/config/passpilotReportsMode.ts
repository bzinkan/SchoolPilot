import { parseRlsEnabledTables } from "../db/rlsPolicies.js";
import registry from "./rlsRegistry.json" with { type: "json" };

export const PASSPILOT_REPORTS_MODE_KEY = "PASSPILOT_REPORTS_MODE";
export const PASSPILOT_REPORTS_CONTRACT_VERSION = 2;
export const PASSPILOT_REPORTS_RLS_TABLES = Object.freeze([...registry.inventories.passpilotAppointmentsPostExpand.tables]);
export type PasspilotReportsMode = "off" | "v2";
type Environment = Readonly<Record<string, string | undefined>>;

export function parsePasspilotReportsMode(env: Environment = process.env): PasspilotReportsMode {
  const value = env[PASSPILOT_REPORTS_MODE_KEY];
  if (value === undefined || value === "off") return "off";
  if (value === "v2") return "v2";
  throw Object.assign(new Error("PassPilot reports configuration is invalid"), { code: "PASSPILOT_REPORTS_CONFIGURATION" });
}

export function readPasspilotReportsMode(env: Environment = process.env): PasspilotReportsMode {
  try {
    const admitted = parseRlsEnabledTables(env.RLS_ENABLED_TABLES);
    return parsePasspilotReportsMode(env) === "v2" && env.RLS_GUC_ENABLED === "true"
      && PASSPILOT_REPORTS_RLS_TABLES.every(table => admitted.has(table)) ? "v2" : "off";
  } catch { return "off"; }
}
