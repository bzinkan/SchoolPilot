import { domainMatches } from "./aiClassification.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import db from "../db.js";
import { settings } from "../schema/shared.js";
import { eq } from "drizzle-orm";
const allowedCache = new Map<string, { until: number; value: Promise<string[]> }>();
/** Task-attribution hint only; never used for safety suppression or authorization. */
export async function schoolAllowedDomainsForTaskIntent(schoolId: string): Promise<string[]> {
  const cached = allowedCache.get(schoolId);
  if (cached && cached.until > Date.now()) return cached.value;
  if (allowedCache.size >= 1_000) allowedCache.delete(allowedCache.keys().next().value!);
  const value = runWithTenantContext({ schoolId }, async () => {
    const [row] = await db.select({ allowedDomains: settings.allowedDomains }).from(settings).where(eq(settings.schoolId, schoolId));
    return row?.allowedDomains ?? [];
  }).catch(() => []);
  allowedCache.set(schoolId, { until: Date.now() + 5_000, value });
  return value;
}
export function classpilotTeacherIntentForUrl(url: string, options: {
  allowedDomains: readonly string[]; flightPath?: { active?: boolean; allowedDomains?: readonly string[] | null } | null;
}): "flight_path" | "school_allowed_domain" | null {
  let hostname: string;
  try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) return null; hostname = parsed.hostname; } catch { return null; }
  if (options.flightPath?.active && options.flightPath.allowedDomains?.some((entry) => domainMatches(hostname, entry))) return "flight_path";
  if (options.allowedDomains.some((entry) => domainMatches(hostname, entry))) return "school_allowed_domain";
  return null;
}
