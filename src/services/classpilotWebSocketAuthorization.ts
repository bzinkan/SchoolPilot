import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import db from "../db.js";
import { productLicenses, schoolMemberships, schools } from "../schema/core.js";
import { isClasspilotSchoolActive } from "./classpilotEntitlement.js";

export type ClasspilotStaffSocketRole =
  | "teacher"
  | "office_staff"
  | "school_admin"
  | "super_admin";

const STAFF_ROLE_PRIORITY = [
  "admin",
  "school_admin",
  "teacher",
  "office_staff",
] as const;

export function selectClasspilotStaffSocketRole(
  roles: readonly (string | null)[],
  options: { entitled: boolean; isSuperAdmin: boolean }
): ClasspilotStaffSocketRole | null {
  if (!options.entitled) return null;
  if (options.isSuperAdmin) return "super_admin";
  const roleSet = new Set(roles.filter(Boolean));
  // This is an operation role, not the generic identity display role. A user
  // who is both office staff and a teacher must retain teacher-only ClassPilot
  // capabilities even though office_staff remains their display primaryRole.
  const selected = STAFF_ROLE_PRIORITY.find((role) => roleSet.has(role));
  if (selected === "admin" || selected === "school_admin") return "school_admin";
  if (selected === "office_staff" || selected === "teacher") return selected;
  return null;
}

/**
 * Resolve school lifecycle, ClassPilot licensing, and every active membership
 * role in one tenant-scoped SQL statement. WebSocket authorization must not
 * depend on whichever membership row PostgreSQL happens to return first.
 */
export async function resolveClasspilotStaffWebSocketAuthorization(options: {
  schoolId: string;
  userId: string;
  isSuperAdmin: boolean;
}): Promise<ClasspilotStaffSocketRole | null> {
  const rows = await db
    .select({
      school: {
        status: schools.status,
        isActive: schools.isActive,
        planStatus: schools.planStatus,
        activeUntil: schools.activeUntil,
        disabledAt: schools.disabledAt,
        deletedAt: schools.deletedAt,
      },
      licenseId: productLicenses.id,
      membershipRole: schoolMemberships.role,
    })
    .from(schools)
    .leftJoin(
      productLicenses,
      and(
        eq(productLicenses.schoolId, schools.id),
        eq(productLicenses.product, "CLASSPILOT"),
        eq(productLicenses.status, "active"),
        or(isNull(productLicenses.expiresAt), gt(productLicenses.expiresAt, sql`now()`))
      )
    )
    .leftJoin(
      schoolMemberships,
      and(
        eq(schoolMemberships.schoolId, schools.id),
        eq(schoolMemberships.userId, options.userId),
        eq(schoolMemberships.status, "active")
      )
    )
    .where(eq(schools.id, options.schoolId));

  const school = rows[0]?.school;
  const entitled = Boolean(
    school &&
    isClasspilotSchoolActive(school) &&
    rows.some((row) => row.licenseId)
  );
  return selectClasspilotStaffSocketRole(
    rows.map((row) => row.membershipRole),
    { entitled, isSuperAdmin: options.isSuperAdmin }
  );
}
