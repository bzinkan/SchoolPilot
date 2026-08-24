import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canAttachGlobalWorkspaceIdentity,
  formatStaffIdentityImportError,
  formatStaffMembershipImportError,
  selectWorkspaceStaffMembershipState,
  workspaceStaffGoogleId,
} from "../src/routes/google/directory.js";
import { StaffIdentityError } from "../src/services/staffIdentity.js";

test("Workspace staff import failures never expose unexpected database details", () => {
  const raw = new Error(
    "Failed query: insert into users values ($1); params: staff@example.edu, secret-value"
  );
  (raw as Error & { code: string }).code = "XX999_SECRET_CODE";

  const identityFailure = formatStaffIdentityImportError("staff@example.edu", raw);
  const updateFailure = formatStaffMembershipImportError("staff@example.edu", "update");
  const createFailure = formatStaffMembershipImportError("staff@example.edu", "create");
  const serializedFailures = JSON.stringify([
    identityFailure,
    updateFailure,
    createFailure,
  ]);

  assert.equal(
    identityFailure,
    "staff@example.edu: STAFF_IDENTITY_FAILED: Could not resolve staff identity."
  );
  assert.equal(
    updateFailure,
    "staff@example.edu: MEMBERSHIP_UPDATE_FAILED: Could not update staff membership."
  );
  assert.equal(
    createFailure,
    "staff@example.edu: MEMBERSHIP_CREATE_FAILED: Could not create staff membership."
  );
  assert.doesNotMatch(serializedFailures, /Failed query|params|secret-value|XX999_SECRET_CODE/i);
});

test("Workspace staff import preserves the explicit identity error contract", () => {
  const error = new StaffIdentityError(
    "STAFF_REACTIVATION_REQUIRED",
    "Reactivate the existing staff membership.",
    409
  );

  assert.equal(
    formatStaffIdentityImportError("staff@example.edu", error),
    "staff@example.edu: STAFF_REACTIVATION_REQUIRED: Reactivate the existing staff membership."
  );
});

test("Workspace direct and OU imports ignore active non-staff memberships when reactivation is required", () => {
  const activeParent = {
    id: "parent-membership",
    status: "active",
    role: "parent",
    gopilotRole: null,
  };
  const inactiveTeacher = {
    id: "teacher-membership",
    status: "inactive",
    role: "teacher",
    gopilotRole: null,
  };
  assert.deepEqual(
    selectWorkspaceStaffMembershipState([activeParent, inactiveTeacher]),
    { existing: undefined, inactive: inactiveTeacher }
  );

  const source = readFileSync(
    new URL("../src/routes/google/directory.ts", import.meta.url),
    "utf8"
  );
  assert.equal(
    source.match(/selectWorkspaceStaffMembershipState\(existingMemberships\)/g)?.length,
    2,
    "both OU and direct staff imports must use the canonical staff-only membership selection"
  );
});

test("Workspace direct rows cannot assert Google identity while server-fetched OU rows retain it", () => {
  const clientAuthored = { id: "attacker-selected-google-id" };
  assert.equal(workspaceStaffGoogleId(clientAuthored, false), null);
  assert.equal(workspaceStaffGoogleId(clientAuthored, true), "attacker-selected-google-id");
  assert.equal(workspaceStaffGoogleId({ id: "   " }, true), null);

  assert.equal(canAttachGlobalWorkspaceIdentity(false, true), false);
  assert.equal(canAttachGlobalWorkspaceIdentity(true, false), false);
  assert.equal(canAttachGlobalWorkspaceIdentity(true, true), true);

  const source = readFileSync(
    new URL("../src/routes/google/directory.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /googleId:\s*workspaceStaffGoogleId\(u, true\)/);
  assert.match(source, /googleId:\s*workspaceStaffGoogleId\(u, false\)/);
  assert.doesNotMatch(source, /googleId:\s*u\.(?:id|googleId)/);
});
