import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import db, { pool } from "../src/db.js";
import { schoolMemberships, schools, users } from "../src/schema/core.js";
import { students } from "../src/schema/students.js";
import { auditLogs } from "../src/schema/shared.js";
import {
  createMembership,
  createSchool,
  createStudent,
  createUser,
  getUserByEmail,
  getUserById,
  GoogleIdentityConflictError,
  IdentityEmailConflictError,
  resolveGoogleLoginIdentity,
} from "../src/services/storage.js";
import {
  attachWorkspaceStaffMembershipForSchool,
  changeStaffEmailForMembership,
  createStaffIdentityForSchool,
  reactivateStaffIdentity,
  resetSchoolScopedStaffPassword,
  resolveWorkspaceStaffUserForSchool,
  StaffIdentityError,
  updateSchoolScopedStaffProfile,
} from "../src/services/staffIdentity.js";
import { comparePassword, hashPassword } from "../src/util/password.js";

const TAG = `staff_identity_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const domainA = `${TAG.replaceAll("_", "-")}-a.example.edu`;
const createdUserIds = new Set<string>();
const createdSchoolIds = new Set<string>();

before(async () => {
  // Local developer databases may predate the additive migration. CI creates
  // from the Drizzle schema, while this keeps the focused test self-contained.
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1
  `);
});

after(async () => {
  if (createdSchoolIds.size > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.schoolId, [...createdSchoolIds]));
    await db.delete(students).where(inArray(students.schoolId, [...createdSchoolIds]));
  }
  if (createdUserIds.size > 0) {
    await db.delete(schoolMemberships).where(inArray(schoolMemberships.userId, [...createdUserIds]));
  }
  if (createdSchoolIds.size > 0) {
    await db.delete(schools).where(inArray(schools.id, [...createdSchoolIds]));
  }
  if (createdUserIds.size > 0) {
    await db.delete(users).where(inArray(users.id, [...createdUserIds]));
  }
  await pool.end();
});

async function school(name: string, domain: string) {
  const row = await createSchool({ name: `${TAG} ${name}`, domain, slug: `${TAG}-${name}` });
  createdSchoolIds.add(row.id);
  return row;
}

async function user(email: string, firstName: string, lastName: string, googleId?: string) {
  const row = await createUser({ email, firstName, lastName, googleId: googleId ?? null });
  createdUserIds.add(row.id);
  return row;
}

function expectIdentityError(error: unknown, code: string) {
  assert.ok(error instanceof StaffIdentityError);
  assert.equal(error.code, code);
  return true;
}

function auditActor(userId: string, source: string) {
  return { userId, userRole: "admin", source };
}

describe("staff identity lifecycle", () => {
  it("requires the central workflow before attaching a global identity to another school", async () => {
    const campusA = await school("attach-origin", domainA);
    const campusB = await school("attach-target", domainA);
    const existing = await user(`central-attach@${domainA}`, "Central", "Attach");
    await createMembership({
      userId: existing.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });

    await assert.rejects(
      () => createStaffIdentityForSchool({
        schoolId: campusB.id,
        email: existing.email,
        role: "teacher",
        firstName: existing.firstName,
        lastName: existing.lastName,
        audit: auditActor(existing.id, "test.attach.school-route"),
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );

    const central = await createStaffIdentityForSchool({
      schoolId: campusB.id,
      email: existing.email,
      role: "teacher",
      firstName: existing.firstName,
      lastName: existing.lastName,
      allowGlobalIdentityAttachment: true,
      audit: auditActor(existing.id, "test.attach.central-route"),
    });
    assert.equal(central.user.id, existing.id);
    assert.equal(central.membership.schoolId, campusB.id);

    const centralOnly = await user(`central-only@${domainA}`, "Central", "Only");
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, centralOnly.id));
    await assert.rejects(
      () => createStaffIdentityForSchool({
        schoolId: campusA.id,
        email: centralOnly.email,
        role: "admin",
        audit: auditActor(existing.id, "test.attach.super-school-route"),
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );
  });

  it("guards Workspace resolution and attachment under the canonical identity lock", async () => {
    const campusA = await school("workspace-origin", domainA);
    const campusB = await school("workspace-target", domainA);
    const existing = await user(
      `workspace-global@${domainA}`,
      "Workspace",
      "Global",
      `${TAG}-workspace-global`
    );
    await createMembership({
      userId: existing.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });

    await assert.rejects(
      () => resolveWorkspaceStaffUserForSchool({
        schoolId: campusB.id,
        email: existing.email,
        googleId: null,
        firstName: "Workspace",
        lastName: "Global",
        allowMultiSchoolEmailChange: false,
        allowGlobalIdentityAttachment: false,
        audit: auditActor(existing.id, "test.workspace.global.direct"),
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );

    const authorized = await resolveWorkspaceStaffUserForSchool({
      schoolId: campusB.id,
      email: existing.email,
      googleId: existing.googleId,
      firstName: "Workspace",
      lastName: "Global",
      allowMultiSchoolEmailChange: true,
      allowGlobalIdentityAttachment: true,
      audit: auditActor(existing.id, "test.workspace.global.central"),
    });
    assert.equal(authorized.user.id, existing.id);
    const attached = await attachWorkspaceStaffMembershipForSchool({
      schoolId: campusB.id,
      userId: existing.id,
      role: "teacher",
      allowGlobalIdentityAttachment: true,
      audit: auditActor(existing.id, "test.workspace.global.attach"),
    });
    assert.equal(attached.created, true);
    assert.equal(attached.membership.schoolId, campusB.id);
  });

  it("blocks school-scoped password takeover of Super Admin and multi-school identities", async () => {
    const campusA = await school("password-a", domainA);
    const campusB = await school("password-b", domainA);
    const local = await user(`password-local@${domainA}`, "Password", "Local");
    const localMembership = await createMembership({
      userId: local.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });
    const localReset = await resetSchoolScopedStaffPassword({
      schoolId: campusA.id,
      membershipId: localMembership.id,
      password: "LocalPassword123!",
      audit: auditActor(local.id, "test.password.local"),
    });
    assert.equal(localReset.user.authVersion, local.authVersion + 1);
    assert.equal(await comparePassword("LocalPassword123!", localReset.user.password!), true);

    const originalHash = await hashPassword("OriginalPassword123!");
    const global = await createUser({
      email: `password-global@${domainA}`,
      firstName: "Password",
      lastName: "Global",
      password: originalHash,
    });
    createdUserIds.add(global.id);
    const globalMembership = await createMembership({
      userId: global.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });
    await createMembership({
      userId: global.id,
      schoolId: campusB.id,
      role: "teacher",
      status: "inactive",
    });
    await assert.rejects(
      () => resetSchoolScopedStaffPassword({
        schoolId: campusA.id,
        membershipId: globalMembership.id,
        password: "TakeoverPassword123!",
        audit: auditActor(local.id, "test.password.multi-school"),
      }),
      (error) => expectIdentityError(error, "STAFF_PASSWORD_CENTRAL_REVIEW_REQUIRED")
    );
    const unchangedGlobal = await getUserById(global.id);
    assert.equal(unchangedGlobal?.authVersion, global.authVersion);
    assert.equal(await comparePassword("OriginalPassword123!", unchangedGlobal!.password!), true);

    const superUser = await user(`password-super@${domainA}`, "Password", "Super");
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, superUser.id));
    const superMembership = await createMembership({
      userId: superUser.id,
      schoolId: campusA.id,
      role: "admin",
      status: "active",
    });
    await assert.rejects(
      () => resetSchoolScopedStaffPassword({
        schoolId: campusA.id,
        membershipId: superMembership.id,
        password: "TakeoverPassword123!",
        audit: auditActor(local.id, "test.password.super"),
      }),
      (error) => expectIdentityError(error, "STAFF_PASSWORD_CENTRAL_REVIEW_REQUIRED")
    );
  });

  it("corrects email in place and invalidates prior credentials", async () => {
    const campus = await school("email", domainA);
    const teacher = await user(`kenzie.old@${domainA}`, "Kenzie", "Vatter", `${TAG}-google-email`);
    const membership = await createMembership({
      userId: teacher.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });

    const result = await changeStaffEmailForMembership({
      schoolId: campus.id,
      membershipId: membership.id,
      expectedEmail: ` KENZIE.OLD@${domainA.toUpperCase()} `,
      email: ` Kenzie.Vatter@${domainA.toUpperCase()} `,
      allowMultiSchool: false,
      audit: auditActor(teacher.id, "test.email.correction"),
    });

    assert.equal(result.user.id, teacher.id);
    assert.equal(result.membership.id, membership.id);
    assert.equal(result.user.email, `kenzie.vatter@${domainA}`);
    assert.equal(result.user.googleId, teacher.googleId);
    assert.equal(result.user.authVersion, teacher.authVersion + 1);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        sql`${auditLogs.schoolId} = ${campus.id}
          AND ${auditLogs.action} = 'school.staff.email_corrected'
          AND ${auditLogs.entityId} = ${membership.id}`
      )
      .limit(1);
    assert.equal(audit?.userEmail, null);
    assert.deepEqual(audit?.changes, { fields: ["email"] });

    await assert.rejects(
      () => changeStaffEmailForMembership({
        schoolId: campus.id,
        membershipId: membership.id,
        expectedEmail: `kenzie.old@${domainA}`,
        email: `another@${domainA}`,
        allowMultiSchool: false,
        audit: auditActor(teacher.id, "test.email.stale"),
      }),
      (error) => expectIdentityError(error, "STAFF_EMAIL_STALE")
    );
  });

  it("requires an explicit central actor to correct a current-school Super Admin identity", async () => {
    const campus = await school("email-super-target", domainA);
    const central = await user(`email-super@${domainA}`, "Email", "Central");
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, central.id));
    const membership = await createMembership({
      userId: central.id,
      schoolId: campus.id,
      role: "admin",
      status: "active",
    });
    const before = (await getUserById(central.id))!;

    await assert.rejects(
      () => changeStaffEmailForMembership({
        schoolId: campus.id,
        membershipId: membership.id,
        expectedEmail: before.email,
        email: `email-super-takeover@${domainA}`,
        allowMultiSchool: false,
        allowCentralIdentityMutation: false,
        audit: auditActor(central.id, "test.email.super.rejected"),
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );
    const rejected = (await getUserById(central.id))!;
    assert.equal(rejected.email, before.email);
    assert.equal(rejected.authVersion, before.authVersion);
    const rejectedAudits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        sql`${auditLogs.schoolId} = ${campus.id}
          AND ${auditLogs.action} = 'school.staff.email_corrected'
          AND ${auditLogs.entityId} = ${membership.id}`
      );
    assert.equal(rejectedAudits.length, 0);

    const corrected = await changeStaffEmailForMembership({
      schoolId: campus.id,
      membershipId: membership.id,
      expectedEmail: before.email,
      email: `email-super-reviewed@${domainA}`,
      allowMultiSchool: false,
      allowCentralIdentityMutation: true,
      audit: auditActor(central.id, "test.email.super.central"),
    });
    assert.equal(corrected.user.id, central.id);
    assert.equal(corrected.user.email, `email-super-reviewed@${domainA}`);
    assert.equal(corrected.user.authVersion, before.authVersion + 1);
  });

  it("guards global profile edits for Super Admin and multi-school identities", async () => {
    const campusA = await school("profile-guard-a", domainA);
    const campusB = await school("profile-guard-b", domainA);
    const shared = await user(`profile-shared@${domainA}`, "Profile", "Shared");
    const membershipA = await createMembership({
      userId: shared.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });
    await createMembership({
      userId: shared.id,
      schoolId: campusB.id,
      role: "teacher",
      status: "active",
    });

    await assert.rejects(
      () => updateSchoolScopedStaffProfile({
        schoolId: campusA.id,
        membershipId: membershipA.id,
        firstName: "Tenant",
        lastName: "Rename",
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );
    assert.equal((await getUserById(shared.id))?.displayName, shared.displayName);

    const reviewed = await updateSchoolScopedStaffProfile({
      schoolId: campusA.id,
      membershipId: membershipA.id,
      firstName: "Central",
      lastName: "Rename",
      allowCentralIdentityMutation: true,
    });
    assert.equal(reviewed.user.displayName, "Central Rename");

    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, shared.id));
    await assert.rejects(
      () => updateSchoolScopedStaffProfile({
        schoolId: campusA.id,
        membershipId: membershipA.id,
        displayName: "Tenant Spoof",
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );
  });

  it("rejects Google subject and email identity conflicts before authentication", async () => {
    const emailOwner = await user(
      `google-email-owner@${domainA}`,
      "Google",
      "Email",
      `${TAG}-google-email-owner`
    );
    const subjectOwner = await user(
      `google-subject-owner@${domainA}`,
      "Google",
      "Subject",
      `${TAG}-google-subject-owner`
    );

    await assert.rejects(
      () => resolveGoogleLoginIdentity({
        email: emailOwner.email,
        googleId: subjectOwner.googleId!,
      }),
      (error) => error instanceof GoogleIdentityConflictError
    );
    assert.equal((await getUserById(emailOwner.id))?.googleId, emailOwner.googleId);

    const unbound = await user(`google-unbound@${domainA}`, "Google", "Unbound");
    const bound = await resolveGoogleLoginIdentity({
      email: unbound.email,
      googleId: `${TAG}-google-first-binding`,
    });
    assert.equal(bound?.id, unbound.id);
    assert.equal(bound?.googleId, `${TAG}-google-first-binding`);
    await assert.rejects(
      () => resolveGoogleLoginIdentity({
        email: unbound.email,
        googleId: `${TAG}-google-takeover-binding`,
      }),
      (error) => error instanceof GoogleIdentityConflictError
    );
  });

  it("normalizes persisted email bytes and increments authVersion for a case-only correction", async () => {
    const campus = await school("normalize-bytes", domainA);
    const teacher = await user(`normalize@${domainA}`, "Normalize", "Bytes");
    const membership = await createMembership({
      userId: teacher.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });
    const legacyEmail = ` Normalize@${domainA.toUpperCase()} `;
    await db.update(users).set({ email: legacyEmail }).where(eq(users.id, teacher.id));

    const corrected = await changeStaffEmailForMembership({
      schoolId: campus.id,
      membershipId: membership.id,
      expectedEmail: `normalize@${domainA}`,
      email: `NORMALIZE@${domainA.toUpperCase()}`,
      allowMultiSchool: false,
      audit: auditActor(teacher.id, "test.email.normalize"),
    });

    assert.equal(corrected.user.email, `normalize@${domainA}`);
    assert.equal(corrected.user.authVersion, teacher.authVersion + 1);
  });

  it("requires central review for any other-school membership, including inactive rows", async () => {
    const campusA = await school("multi-a", domainA);
    const campusB = await school("multi-b", domainA);
    const teacher = await user(`multi@${domainA}`, "Multi", "School");
    const membershipA = await createMembership({
      userId: teacher.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });
    const membershipB = await createMembership({
      userId: teacher.id,
      schoolId: campusB.id,
      role: "teacher",
      status: "active",
    });
    await db
      .update(schoolMemberships)
      .set({ status: "inactive" })
      .where(eq(schoolMemberships.id, membershipB.id));

    await assert.rejects(
      () => changeStaffEmailForMembership({
        schoolId: campusA.id,
        membershipId: membershipA.id,
        expectedEmail: teacher.email,
        email: `multi-new@${domainA}`,
        allowMultiSchool: false,
        audit: auditActor(teacher.id, "test.email.central-review"),
      }),
      (error) => expectIdentityError(error, "STAFF_EMAIL_CENTRAL_REVIEW_REQUIRED")
    );
  });

  it("allows a multi-school identity no-op without treating it as an email change", async () => {
    const campusA = await school("multi-noop-a", domainA);
    const campusB = await school("multi-noop-b", domainA);
    const teacher = await user(`multi-noop@${domainA}`, "Multi", "Noop");
    const membershipA = await createMembership({
      userId: teacher.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });
    await createMembership({
      userId: teacher.id,
      schoolId: campusB.id,
      role: "teacher",
      status: "active",
    });

    const unchanged = await changeStaffEmailForMembership({
      schoolId: campusA.id,
      membershipId: membershipA.id,
      expectedEmail: teacher.email,
      email: `  ${teacher.email.toUpperCase()}  `,
      allowMultiSchool: false,
      audit: auditActor(teacher.id, "test.email.multi-noop"),
    });

    assert.equal(unchanged.user.id, teacher.id);
    assert.equal(unchanged.user.email, teacher.email);
    assert.equal(unchanged.user.authVersion, teacher.authVersion);
  });

  it("validates a Super Admin email correction across every active membership school", async () => {
    const domainB = `${TAG.replaceAll("_", "-")}-review.example.edu`;
    const campusA = await school("review-a", domainA);
    const campusB = await school("review-b", domainB);
    const teacher = await user(`review@${domainA}`, "Review", "Everywhere");
    const membershipA = await createMembership({
      userId: teacher.id,
      schoolId: campusA.id,
      role: "teacher",
      status: "active",
    });
    await createMembership({
      userId: teacher.id,
      schoolId: campusB.id,
      role: "parent",
      status: "active",
    });

    await assert.rejects(
      () => changeStaffEmailForMembership({
        schoolId: campusA.id,
        membershipId: membershipA.id,
        expectedEmail: teacher.email,
        email: `review-new@${domainA}`,
        allowMultiSchool: true,
        audit: auditActor(teacher.id, "test.email.all-schools"),
      }),
      (error) => expectIdentityError(error, "STAFF_EMAIL_DOMAIN_MISMATCH")
    );
  });

  it("requires explicit confirmation before creating a same-name identity", async () => {
    const campus = await school("names", domainA);
    const original = await user(`original@${domainA}`, "Same", "Name");
    await createMembership({
      userId: original.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });

    await assert.rejects(
      () => createStaffIdentityForSchool({
        schoolId: campus.id,
        email: `distinct@${domainA}`,
        role: "teacher",
        displayName: "  Same   Name ",
        audit: auditActor(original.id, "test.distinct.required"),
      }),
      (error) => expectIdentityError(error, "POSSIBLE_DUPLICATE_STAFF")
    );

    const confirmed = await createStaffIdentityForSchool({
      schoolId: campus.id,
      email: `distinct@${domainA}`,
      role: "teacher",
      displayName: "Same Name",
      confirmDistinctPerson: true,
      audit: auditActor(original.id, "test.distinct.confirm"),
    });
    createdUserIds.add(confirmed.user.id);
    assert.notEqual(confirmed.user.id, original.id);
    assert.equal(confirmed.distinctIdentityConfirmed, true);
    assert.deepEqual(confirmed.candidateUserIds, [original.id]);
    const identityAudits = await db
      .select({ action: auditLogs.action, userEmail: auditLogs.userEmail })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, confirmed.membership.id));
    assert.deepEqual(
      identityAudits.map((row) => row.action).sort(),
      ["school.staff.created", "school.staff.distinct_identity_confirmed"]
    );
    assert.ok(identityAudits.every((row) => row.userEmail === null));
  });

  it("treats a base parent with a GoPilot staff role as the same canonical staff identity", async () => {
    const campus = await school("gopilot-effective-staff", domainA);
    const teacher = await user(`gopilot-effective@${domainA}`, "GoPilot", "Teacher");
    const membership = await createMembership({
      userId: teacher.id,
      schoolId: campus.id,
      role: "parent",
      gopilotRole: "teacher",
      status: "active",
    });

    await assert.rejects(
      () => createStaffIdentityForSchool({
        schoolId: campus.id,
        email: `gopilot-distinct@${domainA}`,
        role: "teacher",
        displayName: "GoPilot Teacher",
        audit: auditActor(teacher.id, "test.gopilot.duplicate"),
      }),
      (error) => expectIdentityError(error, "POSSIBLE_DUPLICATE_STAFF")
    );

    const corrected = await changeStaffEmailForMembership({
      schoolId: campus.id,
      membershipId: membership.id,
      expectedEmail: teacher.email,
      email: `gopilot-corrected@${domainA}`,
      allowMultiSchool: false,
      audit: auditActor(teacher.id, "test.gopilot.email"),
    });
    assert.equal(corrected.user.id, teacher.id);
    assert.equal(corrected.membership.id, membership.id);

    await db
      .update(schoolMemberships)
      .set({ status: "inactive" })
      .where(eq(schoolMemberships.id, membership.id));
    const restored = await reactivateStaffIdentity({
      schoolId: campus.id,
      membershipId: membership.id,
      audit: auditActor(teacher.id, "test.gopilot.reactivate"),
    });
    assert.equal(restored.user.id, teacher.id);
    assert.equal(restored.membership.id, membership.id);
    assert.equal(restored.membership.role, "parent");
    assert.equal(restored.membership.gopilotRole, "teacher");
  });

  it("requires reactivation and restores the existing membership and user IDs", async () => {
    const campus = await school("reactivate", domainA);
    const teacher = await user(`reactivate@${domainA}`, "Return", "Teacher");
    const membership = await createMembership({
      userId: teacher.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });
    await db
      .update(schoolMemberships)
      .set({ status: "inactive" })
      .where(eq(schoolMemberships.id, membership.id));

    await assert.rejects(
      () => createStaffIdentityForSchool({
        schoolId: campus.id,
        email: teacher.email,
        role: "teacher",
        displayName: "Return Teacher",
        audit: auditActor(teacher.id, "test.reactivate.required"),
      }),
      (error) => expectIdentityError(error, "STAFF_REACTIVATION_REQUIRED")
    );

    const restored = await reactivateStaffIdentity({
      schoolId: campus.id,
      membershipId: membership.id,
      audit: auditActor(teacher.id, "test.reactivate"),
    });
    assert.equal(restored.user.id, teacher.id);
    assert.equal(restored.membership.id, membership.id);
    assert.equal(restored.membership.status, "active");
    assert.equal(restored.user.authVersion, teacher.authVersion + 1);
  });

  it("requires a central actor to reactivate a Super Admin membership", async () => {
    const campus = await school("reactivate-super", domainA);
    const central = await user(`reactivate-super@${domainA}`, "Reactivate", "Central");
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, central.id));
    const membership = await createMembership({
      userId: central.id,
      schoolId: campus.id,
      role: "admin",
      status: "inactive",
    });
    const before = (await getUserById(central.id))!;

    await assert.rejects(
      () => reactivateStaffIdentity({
        schoolId: campus.id,
        membershipId: membership.id,
        allowCentralIdentityMutation: false,
        audit: auditActor(central.id, "test.reactivate.super.rejected"),
      }),
      (error) => expectIdentityError(error, "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED")
    );
    assert.equal((await getUserById(central.id))?.authVersion, before.authVersion);
    const [stillInactive] = await db
      .select()
      .from(schoolMemberships)
      .where(eq(schoolMemberships.id, membership.id));
    assert.equal(stillInactive?.status, "inactive");

    const restored = await reactivateStaffIdentity({
      schoolId: campus.id,
      membershipId: membership.id,
      allowCentralIdentityMutation: true,
      audit: auditActor(central.id, "test.reactivate.super.central"),
    });
    assert.equal(restored.membership.status, "active");
    assert.equal(restored.user.authVersion, before.authVersion + 1);
  });

  it("resolves Workspace users by immutable Google ID and rejects split bindings", async () => {
    const campus = await school("google", domainA);
    const googleUser = await user(
      `workspace-old@${domainA}`,
      "Workspace",
      "Teacher",
      `${TAG}-google-stable`
    );
    await createMembership({
      userId: googleUser.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });

    const renamed = await resolveWorkspaceStaffUserForSchool({
      schoolId: campus.id,
      email: `workspace-new@${domainA}`,
      googleId: googleUser.googleId,
      firstName: "Workspace",
      lastName: "Teacher",
      allowMultiSchoolEmailChange: false,
      audit: auditActor(googleUser.id, "test.workspace.rename"),
    });
    assert.equal(renamed.user.id, googleUser.id);
    assert.equal(renamed.user.email, `workspace-new@${domainA}`);
    assert.equal(renamed.emailChanged, true);

    const conflictingEmailUser = await user(`workspace-conflict@${domainA}`, "Other", "Teacher");
    await assert.rejects(
      () => resolveWorkspaceStaffUserForSchool({
        schoolId: campus.id,
        email: conflictingEmailUser.email,
        googleId: googleUser.googleId,
        firstName: "Workspace",
        lastName: "Teacher",
        allowMultiSchoolEmailChange: false,
        audit: auditActor(googleUser.id, "test.workspace.conflict"),
      }),
      (error) => expectIdentityError(error, "GOOGLE_STAFF_IDENTITY_CONFLICT")
    );

    const persisted = await getUserById(googleUser.id);
    assert.equal(persisted?.googleId, googleUser.googleId);
  });

  it("fails closed when a normalized email resolves to more than one identity", async () => {
    const normalized = `ambiguous@${domainA}`;
    await assert.rejects(
      () => db.transaction(async (tx) => {
        await tx.execute(sql`DROP INDEX IF EXISTS users_email_normalized_unique`);
        await tx.insert(users).values([
          {
            email: ` Ambiguous@${domainA.toUpperCase()} `,
            firstName: "Ambiguous",
            lastName: "One",
          },
          {
            email: normalized,
            firstName: "Ambiguous",
            lastName: "Two",
          },
        ]);
        const lookupDb = Object.assign(tx, { $client: pool });
        await getUserByEmail(normalized, lookupDb);
      }),
      (error) => {
        assert.ok(error instanceof IdentityEmailConflictError);
        assert.equal(error.code, "IDENTITY_EMAIL_CONFLICT");
        return true;
      }
    );
  });

  it("does not mutate email or Google binding before inactive Workspace reactivation", async () => {
    const campus = await school("workspace-inactive", domainA);
    const googleUser = await user(
      `inactive-google@${domainA}`,
      "Inactive",
      "Google",
      `${TAG}-inactive-google`
    );
    const googleMembership = await createMembership({
      userId: googleUser.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });
    await db
      .update(schoolMemberships)
      .set({ status: "inactive" })
      .where(eq(schoolMemberships.id, googleMembership.id));
    await createMembership({
      userId: googleUser.id,
      schoolId: campus.id,
      role: "parent",
      status: "active",
    });

    await assert.rejects(
      () => resolveWorkspaceStaffUserForSchool({
        schoolId: campus.id,
        email: `inactive-google-new@${domainA}`,
        googleId: googleUser.googleId,
        firstName: "Inactive",
        lastName: "Google",
        allowMultiSchoolEmailChange: false,
        audit: auditActor(googleUser.id, "test.workspace.inactive.email"),
      }),
      (error) => expectIdentityError(error, "STAFF_REACTIVATION_REQUIRED")
    );
    const unchangedGoogleUser = await getUserById(googleUser.id);
    assert.equal(unchangedGoogleUser?.email, googleUser.email);
    assert.equal(unchangedGoogleUser?.googleId, googleUser.googleId);
    assert.equal(unchangedGoogleUser?.authVersion, googleUser.authVersion);

    const unboundUser = await user(`inactive-unbound@${domainA}`, "Inactive", "Unbound");
    const unboundMembership = await createMembership({
      userId: unboundUser.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });
    await db
      .update(schoolMemberships)
      .set({ status: "inactive" })
      .where(eq(schoolMemberships.id, unboundMembership.id));
    await createMembership({
      userId: unboundUser.id,
      schoolId: campus.id,
      role: "parent",
      status: "active",
    });
    await assert.rejects(
      () => resolveWorkspaceStaffUserForSchool({
        schoolId: campus.id,
        email: unboundUser.email,
        googleId: `${TAG}-would-bind`,
        firstName: "Inactive",
        lastName: "Unbound",
        allowMultiSchoolEmailChange: false,
        audit: auditActor(unboundUser.id, "test.workspace.inactive.binding"),
      }),
      (error) => expectIdentityError(error, "STAFF_REACTIVATION_REQUIRED")
    );
    assert.equal((await getUserById(unboundUser.id))?.googleId, null);
  });

  it("serializes same-name creation so one request requires explicit confirmation", async () => {
    const campus = await school("concurrent-name", domainA);
    const actor = await user(`name-actor@${domainA}`, "Identity", "Admin");
    await createMembership({
      userId: actor.id,
      schoolId: campus.id,
      role: "admin",
      status: "active",
    });

    const outcomes = await Promise.allSettled([
      createStaffIdentityForSchool({
        schoolId: campus.id,
        email: `concurrent-name-a@${domainA}`,
        role: "teacher",
        displayName: "Concurrent Person",
        audit: auditActor(actor.id, "test.concurrent.name.a"),
      }),
      createStaffIdentityForSchool({
        schoolId: campus.id,
        email: `concurrent-name-b@${domainA}`,
        role: "teacher",
        displayName: "Concurrent Person",
        audit: auditActor(actor.id, "test.concurrent.name.b"),
      }),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof createStaffIdentityForSchool>>> =>
        outcome.status === "fulfilled"
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(expectIdentityError(rejected[0]!.reason, "POSSIBLE_DUPLICATE_STAFF"));
    createdUserIds.add(fulfilled[0]!.value.user.id);
  });

  it("serializes email correction with membership and student identity writers", async () => {
    const domainB = `${TAG.replaceAll("_", "-")}-b.example.edu`;
    const campusA = await school("race-a", domainA);
    const campusB = await school("race-b", domainB);
    const teacher = await user(`race@${domainB}`, "Race", "Teacher");
    const [membershipA] = await db
      .insert(schoolMemberships)
      .values({
        userId: teacher.id,
        schoolId: campusA.id,
        role: "teacher",
        status: "active",
      })
      .returning();

    const membershipRace = await Promise.allSettled([
      changeStaffEmailForMembership({
        schoolId: campusA.id,
        membershipId: membershipA!.id,
        expectedEmail: teacher.email,
        email: `race-new@${domainA}`,
        allowMultiSchool: false,
        audit: auditActor(teacher.id, "test.concurrent.membership.email"),
      }),
      createMembership({
        userId: teacher.id,
        schoolId: campusB.id,
        role: "teacher",
        status: "active",
      }),
    ]);
    assert.equal(membershipRace.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const persistedTeacher = await getUserById(teacher.id);
    const campusBMemberships = await db
      .select()
      .from(schoolMemberships)
      .where(
        sql`${schoolMemberships.userId} = ${teacher.id}
          AND ${schoolMemberships.schoolId} = ${campusB.id}`
      );
    if (campusBMemberships.length > 0) {
      assert.equal(persistedTeacher?.email, teacher.email);
    } else {
      assert.equal(persistedTeacher?.email, `race-new@${domainA}`);
    }

    const collisionEmail = `race-student@${domainA}`;
    const studentRace = await Promise.allSettled([
      changeStaffEmailForMembership({
        schoolId: campusA.id,
        membershipId: membershipA!.id,
        expectedEmail: persistedTeacher!.email,
        email: collisionEmail,
        allowMultiSchool: false,
        audit: auditActor(teacher.id, "test.concurrent.student.email"),
      }),
      createStudent({
        schoolId: campusA.id,
        firstName: "Race",
        lastName: "Student",
        email: collisionEmail,
      }),
    ]);
    assert.equal(studentRace.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const finalTeacher = await getUserById(teacher.id);
    const finalStudents = await db
      .select()
      .from(students)
      .where(
        sql`${students.schoolId} = ${campusA.id}
          AND ${students.emailLc} = ${collisionEmail}`
      );
    assert.ok(!(finalTeacher?.email === collisionEmail && finalStudents.length > 0));
  });

  it("rolls back distinct-person creation when its transactional audit fails", async () => {
    const campus = await school("audit-rollback", domainA);
    const original = await user(`audit-original@${domainA}`, "Audit", "Person");
    await createMembership({
      userId: original.id,
      schoolId: campus.id,
      role: "teacher",
      status: "active",
    });
    await pool.query(`
      CREATE OR REPLACE FUNCTION staff_identity_test_reject_audit()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'school.staff.distinct_identity_confirmed'
           AND NEW.metadata->>'source' = 'test.audit.rollback' THEN
          RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'test audit rejection';
        END IF;
        RETURN NEW;
      END;
      $fn$;
      DROP TRIGGER IF EXISTS staff_identity_test_reject_audit_trigger ON audit_logs;
      CREATE TRIGGER staff_identity_test_reject_audit_trigger
        BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION staff_identity_test_reject_audit();
    `);
    const candidateEmail = `audit-distinct@${domainA}`;
    try {
      await assert.rejects(() => createStaffIdentityForSchool({
        schoolId: campus.id,
        email: candidateEmail,
        role: "teacher",
        displayName: "Audit Person",
        confirmDistinctPerson: true,
        audit: auditActor(original.id, "test.audit.rollback"),
      }));
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS staff_identity_test_reject_audit_trigger ON audit_logs;
        DROP FUNCTION IF EXISTS staff_identity_test_reject_audit();
      `);
    }
    assert.equal(await getUserByEmail(candidateEmail), undefined);
    const rolledBackAudits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        sql`${auditLogs.schoolId} = ${campus.id}
          AND ${auditLogs.metadata}->>'source' = 'test.audit.rollback'`
      );
    assert.equal(rolledBackAudits.length, 0);
  });
});
