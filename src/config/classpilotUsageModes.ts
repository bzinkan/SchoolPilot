import { parseRlsEnabledTables } from "../db/rlsPolicies.js";

export const CLASSPILOT_USAGE_ROLLUP_MODE_KEY = "CLASSPILOT_USAGE_ROLLUP_MODE";
export const CLASSPILOT_DIGITAL_USAGE_MODE_KEY = "CLASSPILOT_DIGITAL_USAGE_MODE";
export type ClasspilotUsageMode = "off" | "on";
export type ClasspilotUsageModes = { rollupMode: ClasspilotUsageMode; digitalUsageMode: ClasspilotUsageMode };
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The reviewed classpilotUsageRollups admission bundle
 * (src/config/rlsRegistry.json). Neither the rollup job nor the Digital Usage
 * API touches the table until it is RLS-enforced in this process.
 */
export const CLASSPILOT_USAGE_ROLLUP_RLS_TABLES = ["classpilot_usage_rollups"] as const;

function strictMode(value: string | undefined): ClasspilotUsageMode {
  if (value === undefined || value === "off") return "off";
  if (value === "on") return "on";
  throw Object.assign(new Error("ClassPilot usage configuration is invalid"), {
    code: "CLASSPILOT_USAGE_CONFIGURATION",
  });
}

/**
 * Strict parser for release preflight; never echoes configuration values.
 * Digital Usage reads what the rollup writes, so it cannot be on alone.
 */
export function parseClasspilotUsageModes(env: Environment = process.env): ClasspilotUsageModes {
  const rollupMode = strictMode(env[CLASSPILOT_USAGE_ROLLUP_MODE_KEY]);
  const digitalUsageMode = strictMode(env[CLASSPILOT_DIGITAL_USAGE_MODE_KEY]);
  if (digitalUsageMode === "on" && rollupMode !== "on") {
    throw Object.assign(new Error("ClassPilot usage configuration is invalid"), {
      code: "CLASSPILOT_USAGE_CONFIGURATION",
    });
  }
  return { rollupMode, digitalUsageMode };
}

/** True only when request binding is on and the rollup table is enforced. */
export function classpilotUsageRollupsRlsAdmitted(env: Environment = process.env): boolean {
  if (env.RLS_GUC_ENABLED !== "true") return false;
  const enabled = parseRlsEnabledTables(env.RLS_ENABLED_TABLES);
  return CLASSPILOT_USAGE_ROLLUP_RLS_TABLES.every((table) => enabled.has(table));
}

/**
 * Runtime readers. Anything but the exact value "on" is off, a malformed or
 * inconsistent pair is off, and "on" still fails closed until
 * classpilot_usage_rollups is RLS-admitted in this process.
 */
export function readClasspilotUsageModes(env: Environment = process.env): ClasspilotUsageModes {
  let modes: ClasspilotUsageModes;
  try {
    modes = parseClasspilotUsageModes(env);
  } catch {
    return { rollupMode: "off", digitalUsageMode: "off" };
  }
  if (!classpilotUsageRollupsRlsAdmitted(env)) return { rollupMode: "off", digitalUsageMode: "off" };
  return modes;
}

/** CLASSPILOT_USAGE_ROLLUP_MODE: the hourly worker job writes rollups only when on. */
export function readClasspilotUsageRollupMode(env: Environment = process.env): ClasspilotUsageMode {
  return readClasspilotUsageModes(env).rollupMode;
}

/** CLASSPILOT_DIGITAL_USAGE_MODE: the admin read/CSV API exists only when on. */
export function readClasspilotDigitalUsageMode(env: Environment = process.env): ClasspilotUsageMode {
  return readClasspilotUsageModes(env).digitalUsageMode;
}
