import { and, eq, gt, isNull, ne, or, type SQL } from "drizzle-orm";
import db from "../db.js";
import { productLicenses, schools } from "../schema/core.js";

export type GoPilotEntitlementReason =
  | "active"
  | "school_missing"
  | "school_inactive"
  | "plan_canceled"
  | "access_expired"
  | "license_inactive";

export type GoPilotEntitlement = {
  schoolId: string;
  entitled: boolean;
  reason: GoPilotEntitlementReason;
};

type GoPilotSchoolEntitlementRecord = {
  status: string;
  isActive: boolean;
  planStatus: string;
  activeUntil: Date | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
};

export function gopilotSchoolEntitlementReason(
  school: GoPilotSchoolEntitlementRecord,
  now: Date = new Date()
): GoPilotEntitlementReason {
  if (
    school.status !== "active"
    || !school.isActive
    || school.disabledAt
    || school.deletedAt
  ) {
    return "school_inactive";
  }
  if (school.planStatus === "canceled") return "plan_canceled";
  if (school.activeUntil && school.activeUntil <= now) return "access_expired";
  return "active";
}

export function isGopilotSchoolActive(
  school: GoPilotSchoolEntitlementRecord,
  now: Date = new Date()
): boolean {
  return gopilotSchoolEntitlementReason(school, now) === "active";
}

/** Shared SQL predicate for cross-school scheduler candidate discovery. */
export function gopilotSchoolEntitlementPredicate(now: Date): SQL {
  return and(
    eq(schools.status, "active"),
    eq(schools.isActive, true),
    isNull(schools.disabledAt),
    isNull(schools.deletedAt),
    ne(schools.planStatus, "canceled"),
    or(isNull(schools.activeUntil), gt(schools.activeUntil, now))
  )!;
}

/** Shared SQL predicate for the one canonical GoPilot product license. */
export function gopilotLicenseEntitlementPredicate(now: Date): SQL {
  return and(
    eq(productLicenses.product, "GOPILOT"),
    eq(productLicenses.status, "active"),
    or(isNull(productLicenses.expiresAt), gt(productLicenses.expiresAt, now))
  )!;
}

/**
 * Canonical, uncached GoPilot school + product decision. Security-sensitive
 * HTTP, realtime, and start transitions use this instead of independent
 * lifecycle/license projections so revocation is effective immediately.
 */
export async function resolveGopilotEntitlement(
  schoolId: string,
  dbInstance: typeof db = db,
  options: { lock?: "share" | "update"; now?: Date } = {}
): Promise<GoPilotEntitlement> {
  const now = options.now ?? new Date();
  const schoolQuery = dbInstance
    .select({
      id: schools.id,
      status: schools.status,
      isActive: schools.isActive,
      planStatus: schools.planStatus,
      activeUntil: schools.activeUntil,
      disabledAt: schools.disabledAt,
      deletedAt: schools.deletedAt,
    })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  const [school] = options.lock
    ? await schoolQuery.for(options.lock)
    : await schoolQuery;
  if (!school) return { schoolId, entitled: false, reason: "school_missing" };

  const schoolReason = gopilotSchoolEntitlementReason(school, now);
  if (schoolReason !== "active") {
    return { schoolId, entitled: false, reason: schoolReason };
  }

  const licenseQuery = dbInstance
    .select({ id: productLicenses.id })
    .from(productLicenses)
    .where(and(
      eq(productLicenses.schoolId, schoolId),
      gopilotLicenseEntitlementPredicate(now)
    ))
    .limit(1);
  const [license] = options.lock
    ? await licenseQuery.for("share")
    : await licenseQuery;
  return license
    ? { schoolId, entitled: true, reason: "active" }
    : { schoolId, entitled: false, reason: "license_inactive" };
}

export async function assertGopilotEntitled(
  schoolId: string,
  dbInstance: typeof db = db,
  options: { lock?: "share" | "update"; now?: Date } = {}
): Promise<void> {
  const entitlement = await resolveGopilotEntitlement(schoolId, dbInstance, options);
  if (!entitlement.entitled) {
    throw Object.assign(new Error("School is not entitled to GoPilot"), {
      status: 403,
      code: "GOPILOT_NOT_ENTITLED",
      reason: entitlement.reason,
    });
  }
}
