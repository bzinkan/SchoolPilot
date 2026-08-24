import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  STAFF_IDENTITY_AUTH_VERSION_SQL,
  STAFF_IDENTITY_CONTRACT_MIGRATION_IDS,
  STAFF_IDENTITY_NORMALIZED_EMAIL_SQL,
  schoolPilot27ExpandMigrations,
  schoolPilot27Migrations,
  selectSchoolPilot27MigrationPlan,
} from "../src/db/migrations27.js";
import { STAFF_IDENTITY_INTEGRITY_SQL } from "../src/db/staffIdentityIntegrityMigration.js";
import { credentialVersionMatches } from "../src/services/jwt.js";
import { createTeacherSchema, updateStaffEmailSchema } from "../src/schema/validation.js";
import {
  getDatabaseErrorDetails,
  isDatabaseErrorCode,
} from "../src/util/databaseError.js";

test("staff identity migrations keep additive auth version ahead of one atomic contract", () => {
  const authIndex = schoolPilot27Migrations.findIndex(
    (migration) => migration.id === "20260824_staff_identity_auth_version_expand"
  );
  const contractIndex = schoolPilot27Migrations.findIndex(
    (migration) => migration.id === "20260824_staff_identity_integrity_contract"
  );
  assert.ok(authIndex >= 0);
  assert.ok(contractIndex > authIndex);
  assert.equal(
    schoolPilot27Migrations[authIndex]?.checksum,
    createHash("sha256").update(STAFF_IDENTITY_AUTH_VERSION_SQL).digest("hex")
  );
  assert.equal(
    schoolPilot27Migrations[contractIndex]?.checksum,
    createHash("sha256").update(STAFF_IDENTITY_INTEGRITY_SQL).digest("hex")
  );
  assert.match(STAFF_IDENTITY_AUTH_VERSION_SQL, /ADD COLUMN IF NOT EXISTS auth_version/);
  assert.doesNotMatch(STAFF_IDENTITY_AUTH_VERSION_SQL, /CREATE UNIQUE INDEX/);
  assert.match(STAFF_IDENTITY_NORMALIZED_EMAIL_SQL, /users_email_normalized_unique/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /normalized_email_collision_count/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /HAVING count\(\*\) > 1/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /STAFF_IDENTITY_CONTRACT_PRECHECK_FAILED/);
  assert.ok(
    STAFF_IDENTITY_INTEGRITY_SQL.indexOf("normalized_email_collision_count")
      < STAFF_IDENTITY_INTEGRITY_SQL.indexOf(
        "CREATE OR REPLACE FUNCTION schoolpilot_lock_staff_assignment_school"
      ),
    "the aggregate preflight must run before installing mutation integrity functions",
  );
  assert.ok(
    STAFF_IDENTITY_INTEGRITY_SQL.indexOf("LOCK TABLE")
      < STAFF_IDENTITY_INTEGRITY_SQL.indexOf("normalized_email_collision_count"),
    "the aggregate preflight must run only after freezing every covered writer",
  );
  assert.ok(
    STAFF_IDENTITY_INTEGRITY_SQL.indexOf("users_email_normalized_unique")
      > STAFF_IDENTITY_INTEGRITY_SQL.indexOf("CREATE CONSTRAINT TRIGGER"),
    "the email index must remain inside and at the end of the atomic contract",
  );
  assert.ok(
    schoolPilot27ExpandMigrations.some(
      (migration) => migration.id === "20260824_staff_identity_auth_version_expand"
    )
  );
  assert.equal(
    schoolPilot27ExpandMigrations.some(
      (migration) => migration.id === "20260824_staff_identity_integrity_contract"
    ),
    false
  );
  assert.deepEqual(
    schoolPilot27ExpandMigrations,
    schoolPilot27Migrations.slice(0, contractIndex),
    "pre-contract rollout must never admit migrations appended after a deferred contract"
  );
  assert.deepEqual(
    selectSchoolPilot27MigrationPlan({
      contractRolloutRequested: false,
      contractPreviouslyApplied: true,
    }),
    schoolPilot27Migrations,
    "a durable ledger marker must make the contract manifest monotonic"
  );
  assert.deepEqual(STAFF_IDENTITY_CONTRACT_MIGRATION_IDS, [
    "20260824_staff_identity_integrity_contract",
  ]);
});

test("migration runner retains staff contracts after their durable phase marker", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /hasCompletedSchoolPilotMigration\([\s\S]*STAFF_IDENTITY_CONTRACT_MIGRATION_IDS/);
  assert.match(source, /contractRolloutRequested \|\| contractPreviouslyApplied/);
  assert.match(source, /selectSchoolPilot27MigrationPlan/);
});

test("credential versions are backward compatible until the first increment", () => {
  assert.equal(credentialVersionMatches(undefined, 1), true);
  assert.equal(credentialVersionMatches(1, 1), true);
  assert.equal(credentialVersionMatches(undefined, 2), false);
  assert.equal(credentialVersionMatches(1, 2), false);
  assert.equal(credentialVersionMatches(2, 2), true);
});

test("staff validation exposes deliberate identity correction and confirmation inputs", () => {
  assert.equal(
    createTeacherSchema.safeParse({
      email: "teacher@example.edu",
      displayName: "Same Name",
      confirmDistinctPerson: true,
    }).success,
    true
  );
  assert.equal(
    updateStaffEmailSchema.safeParse({
      expectedEmail: "old@example.edu",
      email: "new@example.edu",
      userId: "client-must-not-select-global-user",
    }).success,
    false
  );
});

test("Workspace imports trust Google identity only on server-fetched Directory rows", () => {
  const source = readFileSync(
    new URL("../src/routes/google/directory.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /googleId:\s*workspaceStaffGoogleId\(u, true\)/);
  assert.match(source, /googleId:\s*workspaceStaffGoogleId\(u, false\)/);
  assert.doesNotMatch(source, /googleId:\s*u\.(?:id|googleId)/);
  assert.match(source, /resolveWorkspaceStaffUserForSchool/);
  assert.match(source, /STAFF_REACTIVATION_REQUIRED/);
});

test("school password writers share the central-identity takeover guard", () => {
  const compat = readFileSync(
    new URL("../src/routes/compat.ts", import.meta.url),
    "utf8"
  );
  const usersRoute = readFileSync(
    new URL("../src/routes/users.ts", import.meta.url),
    "utf8"
  );
  assert.match(compat, /resetSchoolScopedStaffPassword\(/);
  assert.doesNotMatch(compat, /hashPassword\(newPassword\)/);
  assert.match(usersRoute, /resetSchoolScopedStaffPassword\(/);
  assert.match(usersRoute, /STAFF_PASSWORD_UPDATE_MUST_BE_SEPARATE/);
  assert.doesNotMatch(usersRoute, /userUpdates\.password/);
});

test("database identity errors retain nested driver code and constraint", () => {
  const wrapped = new Error("query failed", {
    cause: new Error("driver wrapper", {
      cause: Object.assign(new Error("duplicate"), {
        code: "23505",
        constraint: "users_email_normalized_unique",
      }),
    }),
  });
  assert.deepEqual(getDatabaseErrorDetails(wrapped), {
    code: "23505",
    constraint: "users_email_normalized_unique",
  });
  assert.equal(isDatabaseErrorCode(wrapped, "23505"), true);
});

test("database membership backstops retain the guided-transition API contract", () => {
  const source = readFileSync(
    new URL("../src/middleware/errorHandler.ts", import.meta.url),
    "utf8"
  );
  for (const constraint of [
    "staff_live_teaching_dependency_membership",
    "staff_live_active_dependency_membership",
  ]) {
    assert.match(
      source,
      new RegExp(`${constraint}:[\\s\\S]*?code: "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT"`),
    );
  }

  for (const [constraint, code] of [
    ["staff_live_dependency_tenant_scope", "STAFF_DEPENDENCY_SCHOOL_MISMATCH"],
    ["staff_live_dependency_teaching_membership", "STAFF_ASSIGNMENT_INELIGIBLE"],
    ["staff_live_dependency_active_membership", "STAFF_ASSIGNMENT_INELIGIBLE"],
    [
      "classpilot_active_schedule_change_ownership",
      "STAFF_ACTIVE_SCHEDULE_CHANGE_OWNERSHIP_LOCKED",
    ],
    [
      "gopilot_homeroom_primary_teacher_mirror",
      "GOPILOT_HOMEROOM_PRIMARY_MIRROR_MISMATCH",
    ],
  ] as const) {
    assert.match(
      source,
      new RegExp(`${constraint}:[\\s\\S]*?code: "${code}"`),
    );
  }

  assert.doesNotMatch(
    source,
    /staff_live_dependency_kind:\s*\{/,
    "unknown dependency kinds are internal contract defects and must remain 500 errors",
  );
});

test("staff email input failures use the stable 422 identity contract", () => {
  const source = readFileSync(
    new URL("../src/routes/users.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /updateStaffEmailSchema\.safeParse[\s\S]*?status\(422\)[\s\S]*?code: "STAFF_EMAIL_INVALID"/
  );
});

test("school staff identity mutations require explicit central authority and separate profile saves", () => {
  const usersRoute = readFileSync(
    new URL("../src/routes/users.ts", import.meta.url),
    "utf8"
  );
  const compatRoute = readFileSync(
    new URL("../src/routes/compat.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    usersRoute,
    /allowCentralIdentityMutation: req\.authUser!\.isSuperAdmin/
  );
  assert.match(usersRoute, /updateSchoolScopedStaffProfile\(/);
  assert.match(usersRoute, /STAFF_PROFILE_ROLE_UPDATE_MUST_BE_SEPARATE/);
  assert.match(compatRoute, /updateSchoolScopedStaffProfile\(/);
  assert.match(
    compatRoute,
    /if \(role !== undefined && name !== undefined\)[\s\S]*?STAFF_PROFILE_ROLE_UPDATE_MUST_BE_SEPARATE[\s\S]*?updateMembershipForSchool\(/
  );
});
