export const MYDESK_MODE_KEYS = ["MYDESK_MODE", "MYDESK_SEATING_MODE", "MYDESK_AI_IMPORT_MODE"] as const;
export const MYDESK_LEGACY_KEYS = [
  "MYDESK_ENABLED_SCHOOL_IDS", "MYDESK_SEATING_ENABLED_SCHOOL_IDS", "MYDESK_AI_IMPORT_ENABLED_SCHOOL_IDS",
] as const;
export type MyDeskMode = "off" | "on";
export type MyDeskModes = { mode: MyDeskMode; seatingMode: MyDeskMode; aiImportMode: MyDeskMode };
type Environment = Readonly<Record<string, string | undefined>>;

/** Release preflight uses this strict parser; never expose configuration values in errors. */
export function parseMyDeskModes(env: Environment = process.env): MyDeskModes {
  const invalid = () => Object.assign(new Error("My Desk operational configuration is invalid"), { code: "MYDESK_CONFIGURATION" });
  // Even an empty legacy declaration must be removed: it is not an alternate access policy.
  if (MYDESK_LEGACY_KEYS.some(key => env[key] !== undefined)) throw invalid();
  const values = MYDESK_MODE_KEYS.map(key => {
    const value = env[key];
    if (value === undefined) return "off";
    if (value !== "off" && value !== "on") throw invalid();
    return value;
  });
  const [mode, seatingMode, aiImportMode] = values as [MyDeskMode, MyDeskMode, MyDeskMode];
  if (mode !== "on" && (seatingMode === "on" || aiImportMode === "on")) throw invalid();
  return { mode, seatingMode, aiImportMode };
}

/** A bad configuration hides all private features while independent cleanup keeps running. */
export function readMyDeskModes(env: Environment = process.env): MyDeskModes {
  try { return parseMyDeskModes(env); }
  catch { return { mode: "off", seatingMode: "off", aiImportMode: "off" }; }
}
