import { parseRlsEnabledTables } from "../db/rlsPolicies.js";

export const PASSPILOT_RULES_MODE_KEY = "PASSPILOT_RULES_MODE";
export type PasspilotRulesMode = "off" | "on";
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The reviewed passpilotRules admission bundle (src/config/rlsRegistry.json).
 * Rules never evaluate until every one of these tables is RLS-enforced.
 */
export const PASSPILOT_RULES_RLS_TABLES = [
  "passpilot_destination_policies",
  "passpilot_pass_limits",
  "passpilot_encounter_restrictions",
  "passpilot_pass_denials",
] as const;

/** Strict parser for release preflight; never echoes configuration values. */
export function parsePasspilotRulesMode(env: Environment = process.env): PasspilotRulesMode {
  const value = env[PASSPILOT_RULES_MODE_KEY];
  if (value === undefined || value === "off") return "off";
  if (value === "on") return "on";
  throw Object.assign(new Error("PassPilot rules configuration is invalid"), {
    code: "PASSPILOT_RULES_CONFIGURATION",
  });
}

/** True only when request binding is on and the whole bundle is enforced. */
export function passpilotRulesRlsAdmitted(env: Environment = process.env): boolean {
  if (env.RLS_GUC_ENABLED !== "true") return false;
  const enabled = parseRlsEnabledTables(env.RLS_ENABLED_TABLES);
  return PASSPILOT_RULES_RLS_TABLES.every((table) => enabled.has(table));
}

/**
 * Runtime reader. Anything but the exact value "on" is off, and "on" still
 * fails closed until the four rule tables are RLS-admitted in this process.
 */
export function readPasspilotRulesMode(env: Environment = process.env): PasspilotRulesMode {
  let mode: PasspilotRulesMode;
  try {
    mode = parsePasspilotRulesMode(env);
  } catch {
    return "off";
  }
  return mode === "on" && passpilotRulesRlsAdmitted(env) ? "on" : "off";
}
