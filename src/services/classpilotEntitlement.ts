import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import db from "../db.js";
import { productLicenses, schools } from "../schema/core.js";

export type ClasspilotEntitlement = {
  schoolId: string;
  entitled: boolean;
  reason: "active" | "school_missing" | "school_inactive" | "license_inactive";
};

type ClasspilotSchoolEntitlementRecord = {
  status: string;
  isActive: boolean;
  planStatus: string;
  activeUntil: Date | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
};

export function isClasspilotSchoolActive(
  school: ClasspilotSchoolEntitlementRecord,
  now: Date = new Date()
): boolean {
  return (
    school.status === "active" &&
    school.isActive &&
    !school.disabledAt &&
    !school.deletedAt &&
    school.planStatus !== "canceled" &&
    (!school.activeUntil || school.activeUntil > now)
  );
}

/**
 * Canonical ClassPilot school + product entitlement decision. This is kept
 * uncached for device/FAB/poll/WS authorization so a suspension or expiry is
 * effective on the next authenticated action rather than after a process TTL.
 */
export async function resolveClasspilotEntitlement(
  schoolId: string,
  dbInstance: typeof db = db,
  options: { lock?: boolean } = {}
): Promise<ClasspilotEntitlement> {
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
    ? await schoolQuery.for("share")
    : await schoolQuery;
  if (!school) return { schoolId, entitled: false, reason: "school_missing" };
  const now = new Date();
  if (!isClasspilotSchoolActive(school, now)) {
    return { schoolId, entitled: false, reason: "school_inactive" };
  }
  const licenseQuery = dbInstance
    .select({ id: productLicenses.id })
    .from(productLicenses)
    .where(and(
      eq(productLicenses.schoolId, schoolId),
      eq(productLicenses.product, "CLASSPILOT"),
      eq(productLicenses.status, "active"),
      or(isNull(productLicenses.expiresAt), gt(productLicenses.expiresAt, sql`now()`))
    ))
    .limit(1);
  const [license] = options.lock
    ? await licenseQuery.for("share")
    : await licenseQuery;
  return license
    ? { schoolId, entitled: true, reason: "active" }
    : { schoolId, entitled: false, reason: "license_inactive" };
}

export async function assertClasspilotEntitled(
  schoolId: string,
  dbInstance: typeof db = db,
  options: { lock?: boolean } = {}
): Promise<void> {
  const entitlement = await resolveClasspilotEntitlement(schoolId, dbInstance, options);
  if (!entitlement.entitled) {
    throw Object.assign(new Error("School is not entitled to ClassPilot"), {
      status: 403,
      code: "CLASSPILOT_NOT_ENTITLED",
      reason: entitlement.reason,
    });
  }
}
