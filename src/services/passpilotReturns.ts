import { z } from "zod";
import { getActivePassReturnMatches } from "./storage.js";

export const passpilotReturnLookupSchema = z.object({
  search: z.string().trim().min(2).max(100),
}).strict();

// Return discovery deliberately contains no destination, notes, issuer,
// activity, or historical records. It grants no checkout or history access.
export async function findPasspilotReturnMatches(schoolId: string, search: string,
  classScope?: { source: "legacy_grades" | "classpilot_groups"; classId: string } | null) {
  const rows = await getActivePassReturnMatches(schoolId, search.trim(), classScope);
  return { matches: rows.slice(0, 20), hasMore: rows.length > 20 };
}
