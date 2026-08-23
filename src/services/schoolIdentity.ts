import { and, asc, eq, isNull } from "drizzle-orm";
import db from "../db.js";
import { schoolMemberships, schools } from "../schema/core.js";
import {
  buildVerifiedSchoolIdentities,
  identityHasAnyRole,
  primaryRoleFromRoles,
  SCHOOL_ROLES,
  type SchoolRole,
  type VerifiedSchoolIdentity as VerifiedSchoolIdentityModel,
} from "./schoolIdentityModel.js";

export {
  buildVerifiedSchoolIdentities,
  identityHasAnyRole,
  primaryRoleFromRoles,
  SCHOOL_ROLES,
};
export type { SchoolRole };

export type VerifiedSchoolIdentity = VerifiedSchoolIdentityModel<
  typeof schoolMemberships.$inferSelect,
  typeof schools.$inferSelect
>;

export async function loadVerifiedSchoolIdentities(
  userId: string,
  schoolId?: string
): Promise<VerifiedSchoolIdentity[]> {
  const conditions = [
    eq(schoolMemberships.userId, userId),
    eq(schoolMemberships.status, "active"),
    isNull(schools.deletedAt),
  ];
  if (schoolId) conditions.push(eq(schoolMemberships.schoolId, schoolId));

  const rows = await db
    .select({ membership: schoolMemberships, school: schools })
    .from(schoolMemberships)
    .innerJoin(schools, eq(schoolMemberships.schoolId, schools.id))
    .where(and(...conditions))
    .orderBy(
      asc(schoolMemberships.createdAt),
      asc(schoolMemberships.schoolId),
      asc(schoolMemberships.role),
      asc(schoolMemberships.id)
    );
  return buildVerifiedSchoolIdentities(rows);
}
