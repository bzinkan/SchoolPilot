import { eq } from "drizzle-orm";
import db from "../db.js";
import { schools, users } from "../schema/core.js";
import { credentialVersionMatches } from "./jwt.js";
import { identityHasAnyRole, loadVerifiedSchoolIdentities } from "./schoolIdentity.js";
import { resolveClasspilotEntitlement } from "./classpilotEntitlement.js";
import { ClasspilotDigitalUsageError } from "./classpilotUsageRead.js";

/** Fresh authorization after queue admission; never reuse pre-queue provenance. */
export async function authorizeClasspilotUsage(options: {
  schoolId: string;
  userId: string;
  credentialVersion?: number;
  sessionSchoolVersion?: number;
}) {
  const [user] = await db.select({
    id: users.id, email: users.email, authVersion: users.authVersion, isSuperAdmin: users.isSuperAdmin,
  }).from(users).where(eq(users.id, options.userId)).limit(1);
  if (!user || !credentialVersionMatches(options.credentialVersion, user.authVersion)) {
    throw new ClasspilotDigitalUsageError("CREDENTIAL_INVALIDATED", "Sign in again to view usage reports.", 401);
  }
  const [identity] = user.isSuperAdmin ? [] : await loadVerifiedSchoolIdentities(user.id, options.schoolId);
  if (!user.isSuperAdmin && (!identity || !identityHasAnyRole(identity, ["admin", "school_admin"]))) {
    throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_FORBIDDEN", "Insufficient permissions", 403);
  }
  const school = identity?.school ?? (await db.select().from(schools).where(eq(schools.id, options.schoolId)).limit(1))[0];
  if (!school || !user.isSuperAdmin && options.sessionSchoolVersion !== undefined
    && options.sessionSchoolVersion !== (school.schoolSessionVersion ?? 1)) {
    throw new ClasspilotDigitalUsageError("SESSION_INVALIDATED", "School session is no longer valid.", 401);
  }
  const entitlement = await resolveClasspilotEntitlement(options.schoolId);
  if (!entitlement.entitled) {
    throw new ClasspilotDigitalUsageError("CLASSPILOT_NOT_ENTITLED", "School is not entitled to ClassPilot", 403);
  }
  return { userId: user.id, userEmail: user.email, userRole: user.isSuperAdmin ? "super_admin" : identity!.primaryRole };
}
