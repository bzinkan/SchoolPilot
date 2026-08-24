import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('ClassPilot corrects staff email on the existing membership identity', async () => {
  const admin = await read('src/products/classpilot/pages/Admin.jsx');

  assert.match(admin, /apiRequest\("GET", "\/users\/staff\?status=all"\)/);
  assert.match(admin, /apiRequest\("PATCH", `\/users\/staff\/\$\{payload\.membershipId\}\/email`, \{/);
  assert.match(admin, /expectedEmail: payload\.expectedEmail/);
  assert.match(admin, /email: payload\.email/);
  assert.match(admin, /emailResult\?\.email \|\| emailResult\?\.user\?\.email/);
  assert.match(admin, /confirmedEmail !== normalizeEmail\(payload\.email\)/);
  assert.match(admin, /emailChanged && profileChanged/);
  assert.match(admin, /STAFF_EDIT_REQUIRES_SEPARATE_SAVES/);
  assert.match(admin, /editingOwnEmail/);
  assert.match(admin, /if \(!editingOwnEmail\)/);
  assert.match(admin, /STAFF_EMAIL_STALE/);
  assert.match(admin, /STAFF_EMAIL_CENTRAL_REVIEW_REQUIRED/);
  assert.doesNotMatch(admin, /apiRequest\("DELETE", `\/admin\/users/);
});

test('ClassPilot exposes former staff, reactivation, and explicit duplicate-person confirmation', async () => {
  const admin = await read('src/products/classpilot/pages/Admin.jsx');

  assert.match(admin, /filter-former-staff/);
  assert.match(admin, /\/users\/staff\/\$\{membershipId\}\/reactivate/);
  assert.match(admin, /POSSIBLE_DUPLICATE_STAFF/);
  assert.match(admin, /STAFF_REACTIVATION_REQUIRED/);
  assert.match(admin, /confirmDistinctPerson: true/);
  assert.match(admin, /Edit existing email/);
  assert.match(admin, /This is a different person/);
  assert.match(admin, /require identity review/);
  assert.match(admin, /No conflicting row was created automatically/);
  assert.match(admin, /Remove school access/);
  assert.doesNotMatch(admin, /Delete Staff Account|Staff account deleted/);
});

test('staff removal uses the revisioned assignment transition contract', async () => {
  const dialog = await read('src/shared/components/StaffAccessTransitionDialog.jsx');

  assert.match(dialog, /impactQuery\.data\?\.impact/);
  assert.match(dialog, /impact\?\.assignments/);
  assert.match(dialog, /expectedRevision: impact\.revision/);
  assert.match(dialog, /action: transitionAction/);
  assert.match(dialog, /newGopilotRole/);
  assert.match(dialog, /action=change_role/);
  assert.match(dialog, /newGopilotRole=\$\{newGopilotRole === null \? "null"/);
  assert.match(dialog, /queryKey: \["staff-assignment-impact"[^\n]+transitionAction, newRole, newGopilotRole\]/);
  assert.match(dialog, /assignmentType: decision\.assignmentType/);
  assert.match(dialog, /assignmentId: decision\.assignmentId/);
  assert.match(dialog, /operation: decision\.operation/);
  assert.match(dialog, /replacementMembershipId/);
  assert.match(dialog, /STAFF_ASSIGNMENT_IMPACT_STALE/);
  assert.match(dialog, /blockers\.length > 0/);
  assert.match(dialog, /Transfer assignments and remove access/);
  assert.match(dialog, /operation: override\?\.operation \|\| ""/);
  assert.match(dialog, /Choose an action/);
  assert.match(dialog, /decision\.operation === "replace" && Boolean\(decision\.replacementMembershipId\)/);
  assert.match(dialog, /ACTIVE_STAFF_DEPENDENCIES/);
  assert.match(dialog, /String\(candidate\.gopilotRole \|\| ""\)\.trim\(\)/);
  assert.match(dialog, /!ACTIVE_STAFF_ROLES\.has\(candidate\.role\) && !ACTIVE_STAFF_ROLES\.has\(effectiveRole\)/);
  assert.match(dialog, /ACTIVE_STAFF_DEPENDENCIES\.has\(dependency\.assignmentType\)[\s\S]+ACTIVE_STAFF_ROLES\.has\(candidate\.role\)/);
  assert.match(dialog, /value=\{decision\.operation\}/);
  assert.match(dialog, /Authorized membership ID:/);
  assert.match(dialog, /Blocker ID:/);
  assert.match(dialog, /Assignment ID:/);
  assert.match(dialog, /Resource ID:/);
  assert.doesNotMatch(dialog, /!dependency\.required && canRemove/);
});

test('ClassPilot role loss opens the guided assignment transition and preserves ordinary edits', async () => {
  const admin = await read('src/products/classpilot/pages/Admin.jsx');

  assert.match(admin, /CLASSPILOT_TEACHABLE_ROLES/);
  assert.match(admin, /losesClassPilotTeachability\(staffToEdit\.role, selectedRole\)/);
  assert.match(admin, /setStaffTransitionRequest\(\{[\s\S]+action: "change_role",[\s\S]+newRole: selectedRole/);
  assert.match(admin, /transitionAction=\{staffTransitionRequest\?\.action \|\| "deactivate"\}/);
  assert.match(admin, /newRole=\{staffTransitionRequest\?\.newRole\}/);
  assert.match(admin, /SelectItem value="office_staff">Office Staff \(non-teaching\)/);
  assert.match(admin, /updateStaffMutation\.mutate\(\{/);
  assert.match(admin, /Save the name change first, then reopen this editor/);
});

test('teacher selectors and GoPilot staff edits use unambiguous, stable identities', async () => {
  const [classes, goPilotStaff] = await Promise.all([
    read('src/products/classpilot/pages/AdminClasses.jsx'),
    read('src/products/gopilot/pages/setup/StaffManager.jsx'),
  ]);

  assert.match(classes, /` — \$\{teacher\.email\}`/);
  assert.match(goPilotStaff, /\/staff\/\$\{s\.id\}\/email/);
  assert.match(goPilotStaff, /expectedEmail: s\.email/);
  assert.match(goPilotStaff, /confirmedEmail !== requestedEmail/);
  assert.match(goPilotStaff, /changeKinds > 1/);
  assert.match(goPilotStaff, /Save email, role, and profile changes separately/);
  assert.match(goPilotStaff, /onEmailCorrected\?\.\(s\.id, confirmedEmail/);
  assert.match(goPilotStaff, /payload\.gopilotRole = s\.role === 'teacher' \? null : 'teacher'/);
  assert.match(goPilotStaff, /orgUnitPath: wsSelectedOU\?\.orgUnitPath \|\| '\/'/);
  assert.match(goPilotStaff, /userIds,/);
  assert.match(goPilotStaff, /wsSelectedUsers\.has\(u\.id\)/);
  assert.doesNotMatch(goPilotStaff, /googleId: u\.id/);
  assert.doesNotMatch(goPilotStaff, /users: usersToImport/);
  assert.match(goPilotStaff, /Remove school access for/);
  assert.match(goPilotStaff, /apiBasePath=\{`\/schools\/\$\{schoolId\}\/staff`\}/);
  assert.match(goPilotStaff, /action: 'change_role'/);
  assert.match(goPilotStaff, /newGopilotRole: 'office_staff'/);
  assert.match(goPilotStaff, /transitionComplete: true/);
  assert.match(goPilotStaff, /POSSIBLE_DUPLICATE_STAFF/);
  assert.match(goPilotStaff, /STAFF_REACTIVATION_REQUIRED/);
  assert.match(goPilotStaff, /confirmDistinctPerson: true/);
});

test('Workspace staff imports preserve updated, skipped, and error review results', async () => {
  const [admin, goPilotStaff] = await Promise.all([
    read('src/products/classpilot/pages/Admin.jsx'),
    read('src/products/gopilot/pages/setup/StaffManager.jsx'),
  ]);

  for (const source of [admin, goPilotStaff]) {
    assert.match(source, /wsImportResult\.imported \|\| 0/);
    assert.match(source, /wsImportResult\.updated \|\| 0/);
    assert.match(source, /wsImportResult\.skipped \|\| 0/);
    assert.match(source, /wsImportResult\.errors\.map/);
    assert.match(source, /Keep this result open until every skipped or failed row has been reviewed/);
  }
  assert.match(goPilotStaff, /setWsImportResult\(res\.data\)/);
  assert.doesNotMatch(goPilotStaff, /alert\(`Imported \$\{res\.data\.imported\}/);
});

test('staff identity gates run in release-focused and CI', async () => {
  const [manifest, workflow] = await Promise.all([
    read('package.json'),
    read('../.github/workflows/ci-build.yml'),
  ]);
  assert.match(manifest, /"test:release-focused": "npm run test:staff-identity-contracts/);
  assert.match(workflow, /Test staff identity lifecycle frontend contracts[\s\S]+npm run test:staff-identity-contracts/);
});

test('IT Readiness renders school-scoped class ownership integrity details', async () => {
  const readiness = await read('src/products/classpilot/pages/ITReadiness.jsx');

  assert.match(readiness, /details\?\.classOwnershipIntegrity/);
  assert.match(readiness, /invalidPrimaryAssignments/);
  assert.match(readiness, /invalidCoTeacherAssignments/);
  assert.match(readiness, /invalidClassRelationships/);
  assert.match(readiness, /primaryMirrorMismatches/);
  assert.match(readiness, /homeroomPrimaryMirrorMismatches/);
  assert.match(readiness, /invalidHomeroomRelationships/);
  assert.match(readiness, /invalidTenantScopes/);
  assert.match(readiness, /invalidLiveAssignments/);
  assert.match(readiness, /invalidLiveBlockers/);
  assert.match(readiness, /Class Ownership Integrity/);
  assert.match(readiness, /Class relationships:/);
  assert.match(readiness, /Homeroom relationships:/);
  assert.match(readiness, /Tenant scope:/);
  assert.match(readiness, /Parent resource/);
  assert.match(readiness, /Stored school/);
  assert.match(readiness, /Parent school/);
  assert.match(readiness, /Open Class Management/);
  assert.match(readiness, /navigate\("\/classpilot\/admin\/classes"\)/);
});
