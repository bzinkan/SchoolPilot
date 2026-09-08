import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { CLASSPILOT_SCHEDULING_SQL } from "../src/db/classpilotSchedulingMigration.js";
import { CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL } from "../src/db/classpilotScheduleProfileSupervisionMigration.js";
import { emptySchoolSchedulingConfig, datePlusDays } from "../src/services/classpilotSchedulingRules.js";
import type { ScheduleProfileApplication, ScheduleProfileDefinition } from "../src/services/classpilotScheduleProfileModel.js";
import { localDateInTimeZone } from "../src/util/schoolTime.js";
import { pool, sessionPool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import { deleteCoverageStaffAssignments, deleteCoverageSupervisionGroup } from "../src/services/classpilotCoverageDeletion.js";
import { getStaffAssignmentImpact, transitionStaffAssignments } from "../src/services/staffAssignmentLifecycle.js";
import { createCoverageAssignment, createCoverageScopeGroup, createSupervisionContextWithStudents, extendSupervisionContext, claimScheduledCoverageStudents, getActiveCoverageAssignmentsForStaff, getCoverageScopeGroupByIdAndSchool, replaceCoverageScopeGroupMembers, replaceCoverageScopeGroupStaff, updateCoverageAssignment, updateCoverageAssignmentActive, updateCoverageScopeGroup } from "../src/services/storage.js";

const schoolIds: string[] = [], userIds: string[] = [];
const scoped = <T>(schoolId: string, fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Coverage deletion tests require a local fixture database.");
  await pool.query(CLASSPILOT_SCHEDULING_SQL);
  await pool.query(CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL);
});
after(async () => {
  try {
    for (const table of ["classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_coverage_scope_group_members", "classpilot_coverage_assignments", "classpilot_coverage_scope_groups", "classpilot_school_schedules", "audit_logs", "students", "settings", "school_memberships", "product_licenses"]) await pool.query("DELETE FROM " + table + " WHERE school_id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});
async function fixture() {
  const schoolId = randomUUID(), adminId = randomUUID(), staffId = randomUUID(), groupId = randomUUID(), studentId = randomUUID(), assignmentId = randomUUID();
  schoolIds.push(schoolId); userIds.push(adminId, staffId);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Deletion fixture','active',true,'active','America/New_York')", [schoolId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  for (const [id, role] of [[adminId, "admin"], [staffId, "teacher"]]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Deletion','Fixture')", [id, id + "@example.test"]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, role]);
  }
  await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level) VALUES($1,$2,'Deletion','Student','active','5')", [studentId, schoolId]);
  await pool.query("INSERT INTO classpilot_coverage_scope_groups(id,school_id,name,created_by) VALUES($1,$2,'Testing room',$3)", [groupId, schoolId, adminId]);
  await pool.query("INSERT INTO classpilot_coverage_scope_group_members(school_id,coverage_group_id,student_id) VALUES($1,$2,$3)", [schoolId, groupId, studentId]);
  await pool.query("INSERT INTO classpilot_coverage_assignments(id,school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES($1,$2,$3,'coverage_group',$4,'{\"claim\":true}'::jsonb,$5)", [assignmentId, schoolId, staffId, groupId, adminId]);
  return { schoolId, adminId, staffId, groupId, studentId, assignmentId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const definition = (data: Fixture): ScheduleProfileDefinition => ({ name: "MAP day", grades: [], classIds: [], classRules: [], testingBlocks: [{ id: "test_block", name: "Testing", coverageGroupId: data.groupId, assignedStaffId: data.staffId, startTime: "09:00", endTime: "10:00" }] });
function application(data: Fixture, dayOffset: number, status: "scheduled" | "cancelled" = "scheduled"): ScheduleProfileApplication {
  const day = datePlusDays(localDateInTimeZone(new Date(), "America/New_York"), dayOffset), profileDefinition = definition(data);
  return { id: randomUUID(), profileId: randomUUID(), profileName: "MAP day", profileRevision: 1, dates: [day], definition: profileDefinition, classWindows: {}, testingWindows: [{ ...profileDefinition.testingBlocks[0]!, blockId: profileDefinition.testingBlocks[0]!.id, date: day, studentIds: [data.studentId] }], status, createdAt: new Date().toISOString(), createdBy: data.adminId };
}
async function config(data: Fixture, options: { saved?: boolean; applications?: ScheduleProfileApplication[] } = {}) {
  const value = { ...emptySchoolSchedulingConfig(), scheduleProfiles: options.saved ? [{ id: randomUUID(), revision: 1, definition: definition(data), updatedAt: new Date().toISOString() }] : [], profileApplications: options.applications ?? [] };
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb) ON CONFLICT(school_id) DO UPDATE SET config=EXCLUDED.config", [data.schoolId, JSON.stringify(value)]);
  return value;
}
async function stamp(data: Fixture) {
  // Use the same timestamp mapper as the API; pg's default parser for the
  // legacy timestamp-without-zone column depends on the test host timezone.
  return (await scoped(data.schoolId, () => getCoverageScopeGroupByIdAndSchool(data.schoolId, data.groupId)))!.updatedAt.toISOString();
}
async function removeGroup(data: Fixture, updatedAt?: string) {
  const body = { updatedAt: updatedAt ?? await stamp(data) };
  return scoped(data.schoolId, () => deleteCoverageSupervisionGroup({ schoolId: data.schoolId, actorId: data.adminId, groupId: data.groupId, body }));
}
function removeStaff(data: Fixture, assignmentIds: string[] = [data.assignmentId]) {
  return scoped(data.schoolId, () => deleteCoverageStaffAssignments({ schoolId: data.schoolId, actorId: data.adminId, staffId: data.staffId, body: { assignmentIds } }));
}
async function context(data: Fixture, active: boolean, endsAt = new Date(Date.now() + 3600000)) {
  const id = randomUUID();
  await pool.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,status,assigned_staff_id,coverage_group_id,created_by,ends_at) VALUES($1,$2,'state_testing','Testing history',$3,$4,$5,$6,$7)", [id, data.schoolId, active ? "active" : "ended", data.staffId, data.groupId, data.adminId, endsAt.toISOString()]);
  return id;
}

test("group deletion removes reusable setup atomically while preserving historical snapshots, contexts, students and staff", async () => {
  const data = await fixture();
  const originalConfig = await config(data, { applications: [application(data, -2), application(data, 2, "cancelled")] });
  const historicalId = await context(data, false), expiredId = await context(data, true, new Date(Date.now() - 3600000));
  const result = await removeGroup(data);
  assert.deepEqual(result, { deleted: true, groupId: data.groupId, deletedAssignments: 1, deletedMembers: 1 });
  for (const table of ["classpilot_coverage_scope_groups", "classpilot_coverage_scope_group_members", "classpilot_coverage_assignments"]) assert.equal((await pool.query("SELECT 1 FROM " + table + " WHERE school_id=$1", [data.schoolId])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM students WHERE id=$1", [data.studentId])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM school_memberships WHERE school_id=$1", [data.schoolId])).rowCount, 2);
  assert.deepEqual((await pool.query<{ config: unknown }>("SELECT config FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0]?.config, originalConfig);
  assert.deepEqual((await pool.query<{ id: string }>("SELECT id FROM classpilot_supervision_contexts WHERE school_id=$1 ORDER BY id", [data.schoolId])).rows.map(row => row.id), [historicalId, expiredId].sort());
  const audits = await pool.query<{ entity_name: string; changes: unknown }>("SELECT entity_name,changes FROM audit_logs WHERE school_id=$1 AND action='coverage.supervision_group.delete'", [data.schoolId]);
  assert.deepEqual(audits.rows, [{ entity_name: "Testing room", changes: { deletedAssignments: 1, deletedMembers: 1 } }]);
});

test("group and staff deletion block saved profiles, future applied testing and live contexts without changing any dependency", async () => {
  for (const kind of ["profile", "application", "context"]) {
    const data = await fixture();
    if (kind === "profile") await config(data, { saved: true });
    if (kind === "application") await config(data, { applications: [application(data, 2)] });
    if (kind === "context") await context(data, true);
    for (const remove of [() => removeGroup(data), () => removeStaff(data)]) {
      await assert.rejects(remove(), error => {
        assert.ok(error instanceof Error && "dependencies" in error);
        assert.equal(JSON.stringify(error.dependencies).includes(`"kind":"${kind}"`), true);
        assert.equal(JSON.stringify(error).includes(data.studentId), false);
        return "code" in error && error.code === "COVERAGE_DELETE_IN_USE";
      });
    }
    assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_assignments WHERE id=$1", [data.assignmentId])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM audit_logs WHERE school_id=$1", [data.schoolId])).rowCount, 0);
  }
});

test("inactive, setup-only and orphan staff packages can be deleted without deleting the staff account or saved profiles", async () => {
  for (const mode of ["inactive", "setup", "orphan"]) {
    const data = await fixture();
    const savedConfig = await config(data, { saved: true });
    if (mode === "inactive") await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE id=$1", [data.assignmentId]);
    if (mode === "setup") await pool.query("UPDATE classpilot_coverage_assignments SET permissions='{\"setup\":true}'::jsonb WHERE id=$1", [data.assignmentId]);
    if (mode === "orphan") {
      await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE id=$1", [data.assignmentId]);
      await pool.query("DELETE FROM school_memberships WHERE school_id=$1 AND user_id=$2", [data.schoolId, data.staffId]);
    }
    assert.deepEqual(await removeStaff(data), { deleted: true, staffId: data.staffId, deletedAssignments: 1 });
    assert.equal((await pool.query("SELECT 1 FROM users WHERE id=$1", [data.staffId])).rowCount, 1);
    assert.deepEqual((await pool.query<{ config: unknown }>("SELECT config FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0]?.config, savedConfig);
  }
});

test("delete requests reject stale group versions and exact staff package changes, invalid payloads, and foreign setup IDs", async () => {
  const data = await fixture(), other = await fixture(), originalStamp = await stamp(data);
  await scoped(data.schoolId, () => updateCoverageScopeGroup({ schoolId: data.schoolId, groupId: data.groupId, name: "Renamed room" }));
  await assert.rejects(removeGroup(data, originalStamp), { code: "COVERAGE_DELETE_STALE" });
  const added = await scoped(data.schoolId, () => createCoverageAssignment({ schoolId: data.schoolId, staffId: data.staffId, scopeType: "setup", permissions: { setup: true }, createdBy: data.adminId }));
  await assert.rejects(removeStaff(data), { code: "COVERAGE_DELETE_STALE" });
  await assert.rejects(removeStaff(data, [data.assignmentId, data.assignmentId]), { code: "COVERAGE_DELETE_INVALID" });
  await assert.rejects(scoped(data.schoolId, () => deleteCoverageStaffAssignments({ schoolId: data.schoolId, actorId: data.adminId, staffId: other.staffId, body: { assignmentIds: [other.assignmentId] } })), { code: "NOT_FOUND" });
  const foreignStamp = await stamp(other);
  await assert.rejects(scoped(data.schoolId, () => deleteCoverageSupervisionGroup({ schoolId: data.schoolId, actorId: data.adminId, groupId: other.groupId, body: { updatedAt: foreignStamp } })), { code: "NOT_FOUND" });
  for (const body of [{}, { updatedAt: originalStamp, schoolId: other.schoolId }, { updatedAt: "invalid" }]) await assert.rejects(scoped(data.schoolId, () => deleteCoverageSupervisionGroup({ schoolId: data.schoolId, actorId: data.adminId, groupId: data.groupId, body })), { code: "COVERAGE_DELETE_INVALID" });
  assert.equal((await removeStaff(data, [data.assignmentId, added.id])).deletedAssignments, 2);
  assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_assignments WHERE school_id=$1", [other.schoolId])).rowCount, 1);
});

test("every group/member/staff edit invalidates delete confirmation and deleted groups cannot regain orphan members, assignments or live contexts", async () => {
  const data = await fixture();
  const changes: Array<() => Promise<unknown>> = [
    () => replaceCoverageScopeGroupMembers({ schoolId: data.schoolId, groupId: data.groupId, studentIds: [data.studentId] }),
    () => replaceCoverageScopeGroupStaff({ schoolId: data.schoolId, groupId: data.groupId, staffIds: [data.staffId], createdBy: data.adminId }),
    () => updateCoverageAssignment(data.schoolId, data.assignmentId, { permissions: { claim: true, observe: true } }),
    () => updateCoverageAssignmentActive(data.schoolId, data.assignmentId, false),
  ];
  for (const change of changes) {
    const previous = await stamp(data);
    await scoped(data.schoolId, change);
    assert.notEqual(await stamp(data), previous);
    await assert.rejects(removeGroup(data, previous), { code: "COVERAGE_DELETE_STALE" });
  }
  const beforeStaffDelete = await stamp(data);
  await removeStaff(data);
  assert.notEqual(await stamp(data), beforeStaffDelete);
  await removeGroup(data);
  await assert.rejects(scoped(data.schoolId, () => replaceCoverageScopeGroupStaff({ schoolId: data.schoolId, groupId: data.groupId, staffIds: [data.staffId], createdBy: data.adminId })), { code: "NOT_FOUND" });
  assert.equal(await scoped(data.schoolId, () => replaceCoverageScopeGroupMembers({ schoolId: data.schoolId, groupId: data.groupId, studentIds: [data.studentId] })), undefined);
  await assert.rejects(scoped(data.schoolId, () => createCoverageAssignment({ schoolId: data.schoolId, staffId: data.staffId, scopeType: "coverage_group", scopeValue: data.groupId, permissions: { claim: true }, active: false, createdBy: data.adminId })), { code: "NOT_FOUND" });
  await assert.rejects(scoped(data.schoolId, () => createSupervisionContextWithStudents({ context: { schoolId: data.schoolId, assignedStaffId: data.staffId, coverageGroupId: data.groupId, createdBy: data.adminId, contextType: "state_testing", name: "Late claim", endsAt: new Date(Date.now() + 3600000) }, assignedBy: data.adminId, studentIds: [] })), { code: "NOT_FOUND" });
});

test("guided staff removal and reassignment invalidate an existing group delete confirmation", async () => {
  for (const operation of ["remove", "replace"] as const) {
    const data = await fixture(), originalStamp = await stamp(data);
    const rows = await pool.query<{ id: string; user_id: string }>("SELECT id,user_id FROM school_memberships WHERE school_id=$1", [data.schoolId]);
    const membershipId = rows.rows.find(row => row.user_id === data.staffId)!.id;
    const replacementMembershipId = rows.rows.find(row => row.user_id === data.adminId)!.id;
    const impact = await scoped(data.schoolId, () => getStaffAssignmentImpact(data.schoolId, membershipId));
    await scoped(data.schoolId, () => transitionStaffAssignments({ schoolId: data.schoolId, membershipId, actorUserId: data.adminId, actorRole: "admin", request: { expectedRevision: impact.revision, action: "deactivate", decisions: impact.assignments.map(row => ({ assignmentType: row.assignmentType, assignmentId: row.assignmentId, operation, ...(operation === "replace" ? { replacementMembershipId } : {}) })) } }));
    assert.notEqual(await stamp(data), originalStamp);
    await assert.rejects(removeGroup(data, originalStamp), { code: "COVERAGE_DELETE_STALE" });
  }
});

test("DELETE routes enforce authentication, administrator role, tenant isolation and current entitlement", async () => {
  const data = await fixture(), other = await fixture();
  const { default: router } = await import("../src/routes/classpilot/coverage.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express(); app.use(express.json()); app.use("/api/classpilot", router);
  app.use(((error, _req, res, _next) => { const known = error as Error & { status?: number; code?: string }; res.status(known.status ?? 500).json({ error: known.message, code: known.code }); }) satisfies express.ErrorRequestHandler);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/coverage`;
  const headers = (userId: string, schoolId = data.schoolId) => ({ authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId, "content-type": "application/json" });
  const groupBody = JSON.stringify({ updatedAt: await stamp(data) });
  try {
    for (const [path, requestBody] of [[`supervision-groups/${data.groupId}`, groupBody], [`assignments/staff/${data.staffId}`, JSON.stringify({ assignmentIds: [data.assignmentId] })]]) {
      assert.equal((await fetch(`${base}/${path}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: requestBody })).status, 401);
      assert.equal((await fetch(`${base}/${path}`, { method: "DELETE", headers: headers(data.staffId), body: requestBody })).status, 403);
      assert.equal((await fetch(`${base}/${path}`, { method: "DELETE", headers: headers(other.adminId, other.schoolId), body: requestBody })).status, 404);
    }
    await pool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1", [data.schoolId]);
    assert.equal((await fetch(`${base}/supervision-groups/${data.groupId}`, { method: "DELETE", headers: headers(data.adminId), body: groupBody })).status, 403);
    await pool.query("UPDATE product_licenses SET status='active' WHERE school_id=$1", [data.schoolId]);
    const expiredId = await context(data, true, new Date(Date.now() - 3600000));
    await pool.query("UPDATE classpilot_supervision_contexts SET coverage_group_id=NULL WHERE id=$1", [expiredId]);
    await removeStaff(data);
    const revival = await fetch(`${base}/contexts/${expiredId}`, { method: "PATCH", headers: headers(data.staffId), body: JSON.stringify({ endsAt: new Date(Date.now() + 3600000).toISOString() }) });
    assert.equal(revival.status, 404);
    assert.equal((await revival.json() as { code: string }).code, "COVERAGE_CONTEXT_EXPIRED");
    const liveId = await context(data, true);
    await pool.query("UPDATE classpilot_supervision_contexts SET coverage_group_id=NULL WHERE id=$1", [liveId]);
    const extension = await fetch(`${base}/contexts/${liveId}`, { method: "PATCH", headers: headers(data.staffId), body: JSON.stringify({ endsAt: new Date(Date.now() + 7200000).toISOString() }) });
    assert.equal(extension.status, 200, "Assigned staff retain authority to extend existing live supervision");
    const removed = await fetch(`${base}/supervision-groups/${data.groupId}`, { method: "DELETE", headers: headers(data.adminId), body: JSON.stringify({ updatedAt: await stamp(data) }) });
    assert.equal(removed.status, 200); assert.equal((await removed.json() as { deleted: boolean }).deleted, true);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("deleted delegated setup grants cannot authorize pending group creation, metadata, roster or staff mutations", async () => {
  const data = await fixture();
  await scoped(data.schoolId, () => updateCoverageAssignment(data.schoolId, data.assignmentId, { scopeType: "setup", scopeValue: null, permissions: { setup: true } }));
  const review = await scoped(data.schoolId, () => getActiveCoverageAssignmentsForStaff(data.schoolId, data.staffId));
  await scoped(data.schoolId, () => updateCoverageScopeGroup({ schoolId: data.schoolId, groupId: data.groupId, name: "Delegated setup works", coverageSetupReview: review }));
  await removeStaff(data);
  await scoped(data.schoolId, () => createCoverageAssignment({ schoolId: data.schoolId, staffId: data.staffId, scopeType: "grade", scopeValue: "8", permissions: { claim: true }, createdBy: data.adminId }));
  const pending: Array<() => Promise<unknown>> = [
    () => createCoverageScopeGroup({ group: { schoolId: data.schoolId, name: "Unseen group", createdBy: data.staffId }, studentIds: [data.studentId], coverageSetupReview: review }),
    () => updateCoverageScopeGroup({ schoolId: data.schoolId, groupId: data.groupId, name: "Unseen edit", coverageSetupReview: review }),
    () => replaceCoverageScopeGroupMembers({ schoolId: data.schoolId, groupId: data.groupId, studentIds: [], coverageSetupReview: review }),
    () => replaceCoverageScopeGroupStaff({ schoolId: data.schoolId, groupId: data.groupId, staffIds: [data.staffId], createdBy: data.staffId, coverageSetupReview: review }),
  ];
  const previousStamp = await stamp(data);
  for (const operation of pending) await assert.rejects(scoped(data.schoolId, operation), { code: "COVERAGE_PERMISSION_STALE" });
  assert.equal(await stamp(data), previousStamp);
  assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_scope_groups WHERE school_id=$1", [data.schoolId])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_scope_group_members WHERE school_id=$1", [data.schoolId])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_assignments WHERE school_id=$1 AND scope_type='coverage_group'", [data.schoolId])).rowCount, 0);
});

test("deleted grants cannot authorize a pending claim even if another unrelated permission remains, while existing live claims block deletion", async () => {
  const data = await fixture();
  const review = await scoped(data.schoolId, () => getActiveCoverageAssignmentsForStaff(data.schoolId, data.staffId));
  const expiredContextId = await context(data, true, new Date(Date.now() - 3600000));
  await removeStaff(data);
  await scoped(data.schoolId, () => createCoverageAssignment({ schoolId: data.schoolId, staffId: data.staffId, scopeType: "grade", scopeValue: "8", permissions: { claim: true }, createdBy: data.adminId }));
  const proposedContext = { schoolId: data.schoolId, assignedStaffId: data.staffId, coverageGroupId: data.groupId, createdBy: data.staffId, contextType: "state_testing", name: "Pending claim", endsAt: new Date(Date.now() + 3600000) };
  await assert.rejects(scoped(data.schoolId, () => createSupervisionContextWithStudents({ context: proposedContext, assignedBy: data.staffId, studentIds: [], coverageAssignmentReview: review })), { code: "COVERAGE_PERMISSION_STALE" });
  await assert.rejects(scoped(data.schoolId, () => extendSupervisionContext({ schoolId: data.schoolId, contextId: expiredContextId, endsAt: proposedContext.endsAt, coverageAssignmentReview: review })), { code: "COVERAGE_PERMISSION_STALE" });
  await assert.rejects(scoped(data.schoolId, () => claimScheduledCoverageStudents({ schoolId: data.schoolId, scheduledConflictId: randomUUID(), className: "Pending class", assignedStaffId: data.staffId, actorId: data.staffId, studentIds: [], endsAt: proposedContext.endsAt, coverageAssignmentReview: review })), { code: "COVERAGE_PERMISSION_STALE" });
  const other = await fixture(), currentReview = await scoped(other.schoolId, () => getActiveCoverageAssignmentsForStaff(other.schoolId, other.staffId));
  await scoped(other.schoolId, () => createSupervisionContextWithStudents({ context: { ...proposedContext, schoolId: other.schoolId, assignedStaffId: other.staffId, coverageGroupId: other.groupId, createdBy: other.staffId }, assignedBy: other.staffId, studentIds: [], coverageAssignmentReview: currentReview }));
  await assert.rejects(removeStaff(other), { code: "COVERAGE_DELETE_IN_USE" });
});

test("audit failure rolls back deletion and a concurrent saved dependency wins the lifecycle lock", async () => {
  const data = await fixture();
  const suffix = randomUUID().replaceAll("-", ""), functionName = `coverage_delete_fail_${suffix}`, triggerName = `coverage_delete_fail_${suffix}`;
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.school_id = '${data.schoolId}') EXECUTE FUNCTION ${functionName}()`);
  try {
    await assert.rejects(removeGroup(data), /Failed query|fixture audit failure/);
    assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_scope_groups WHERE id=$1", [data.groupId])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_assignments WHERE id=$1", [data.assignmentId])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM classpilot_coverage_scope_group_members WHERE school_id=$1", [data.schoolId])).rowCount, 1);
  } finally { await pool.query(`DROP TRIGGER ${triggerName} ON audit_logs`); await pool.query(`DROP FUNCTION ${functionName}()`); }
  const client = await pool.connect(), updatedAt = await stamp(data);
  let pending: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [data.schoolId]);
    const stored = { ...emptySchoolSchedulingConfig(), scheduleProfiles: [{ id: randomUUID(), revision: 1, definition: definition(data), updatedAt: new Date().toISOString() }] };
    await client.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb)", [data.schoolId, JSON.stringify(stored)]);
    pending = removeGroup(data, updatedAt);
    let waiting = false;
    for (let attempts = 0; attempts < 50; attempts++) {
      const locks = await client.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND locktype='transactionid') AS waiting");
      if (locks.rows[0]?.waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, "Deletion waits for the school lifecycle transaction");
    await client.query("COMMIT");
    await assert.rejects(pending, { code: "COVERAGE_DELETE_IN_USE" });
  } finally { await client.query("ROLLBACK"); client.release(); await pending?.catch(() => undefined); }
});
