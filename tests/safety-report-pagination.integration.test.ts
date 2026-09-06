import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.REDIS_URL = "";
process.env.SCHEDULER_ENABLED = "false";
const { pool, sessionPool } = await import("../src/db.js");
const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const { getSafetyReport, updateSafetyCase, recordSafetyAlert } = await import("../src/services/safetyCenter.js");
const { SAFETY_CENTER_SQL } = await import("../src/db/safetyCenterMigration.js");
const schoolId = randomUUID(), studentId = randomUUID(), caseId = randomUUID(), adminId = randomUUID();
const scoped = <T>(work: () => Promise<T>) => runWithTenantContext({ schoolId }, work);

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  await pool.query(SAFETY_CENTER_SQL);
  await pool.query("INSERT INTO schools(id,name) VALUES($1,'Synthetic report pagination')", [schoolId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)", [adminId, `${adminId}@example.test`]);
  await pool.query("INSERT INTO school_memberships(user_id,school_id,role,status) VALUES($1,$2,'admin','active')", [adminId, schoolId]);
  await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Pagination','active')", [studentId, schoolId]);
  await pool.query("INSERT INTO student_safety_cases(id,school_id,student_id,title,status) VALUES($1,$2,$3,'Synthetic pagination','open')", [caseId, schoolId, studentId]);
  await pool.query(`INSERT INTO student_safety_alerts(school_id,student_id,case_id,fingerprint,source_type,source_id,concern,severity,first_seen_at,last_seen_at)
    SELECT $1,$2,$3,'page-'||n,'browser','observation-'||n,'violence','low',
      '2099-01-01T12:00:00Z'::timestamptz+n*interval '1 microsecond','2099-01-01T12:00:00Z'::timestamptz+n*interval '1 microsecond'
    FROM generate_series(1,205) AS n`, [schoolId, studentId, caseId]);
  await pool.query(`INSERT INTO student_safety_case_events(school_id,case_id,alert_id,kind,created_at)
    SELECT school_id,case_id,id,'alert_created',first_seen_at FROM student_safety_alerts WHERE school_id=$1`, [schoolId]);
  await pool.query(`INSERT INTO safety_notification_outbox(school_id,case_id,alert_id,recipient,kind,alert_revision,due_at)
    SELECT school_id,case_id,id,'fixture@example.test','initial',0,first_seen_at FROM student_safety_alerts WHERE school_id=$1`, [schoolId]);
});

after(async () => {
  try {
    await pool.query("DELETE FROM student_safety_cases WHERE school_id=$1", [schoolId]);
    await pool.query("DELETE FROM students WHERE school_id=$1", [schoolId]);
    await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [schoolId]);
    await pool.query("DELETE FROM product_licenses WHERE school_id=$1", [schoolId]);
    await pool.query("DELETE FROM schools WHERE id=$1", [schoolId]);
    await pool.query("DELETE FROM users WHERE id=$1", [adminId]);
  } finally { await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]); }
});

test("long-lived reports paginate alerts, their delivery records, and actions without losing microseconds", async () => {
  const expected = (await pool.query("SELECT id FROM student_safety_alerts WHERE school_id=$1 ORDER BY first_seen_at DESC,id DESC", [schoolId])).rows.map(row => row.id);
  const seen: unknown[] = [], actions: unknown[] = [];
  let alertCursor: string | undefined, eventCursor: string | undefined;
  for (const expectedLength of [100, 100, 5]) {
    const page = await scoped(() => getSafetyReport(schoolId, caseId, { alertCursor, eventCursor }));
    assert.ok(page.alerts && page.events && page.notifications);
    assert.equal(page.alerts.length, expectedLength);
    assert.equal(page.events.length, expectedLength);
    assert.equal(page.notifications.length, expectedLength);
    const ids = page.alerts.map(row => row.id);
    assert.ok(page.notifications.every(row => ids.includes(row.alert_id)), "deliveries belong only to the displayed alerts");
    assert.ok(page.alerts.every(row => !("url_ciphertext" in row) && !("cursor_at" in row)));
    seen.push(...ids); actions.push(...page.events.map(row => row.id));
    alertCursor = page.alertPage?.nextCursor ?? undefined;
    eventCursor = page.eventPage?.nextCursor ?? undefined;
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(actions).size, 205);
  assert.equal(alertCursor, undefined); assert.equal(eventCursor, undefined);
});

test("report cursors bind the school, case and collection, and an unknown school cannot read the case", async () => {
  const page = await scoped(() => getSafetyReport(schoolId, caseId, { limit: 1 }));
  const cursor = page.alertPage?.nextCursor;
  assert.ok(cursor);
  await assert.rejects(scoped(() => getSafetyReport(schoolId, caseId, { eventCursor: cursor })), { status: 400 });
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
  const foreign = Buffer.from(JSON.stringify({ ...decoded, schoolId: randomUUID() })).toString("base64url");
  await assert.rejects(scoped(() => getSafetyReport(schoolId, caseId, { alertCursor: foreign })), { status: 400 });
  await assert.rejects(scoped(() => getSafetyReport(randomUUID(), caseId)), { status: 404 });
});

test("acknowledgment records receipt separately from assessment and cancels only the single follow-up", async () => {
  const observation = { schoolId, studentId, sourceType: "browser", sourceId: randomUUID(), url: "https://fixture.example.test/review", safetyAlert: "violence", severity: "low" };
  const alert = await scoped(() => recordSafetyAlert(observation));
  const revision = (await pool.query("SELECT revision FROM student_safety_cases WHERE id=$1", [caseId])).rows[0].revision;
  await scoped(() => updateSafetyCase({ schoolId, caseId, actorId: adminId, revision, action: "acknowledge" }));
  await scoped(() => recordSafetyAlert(observation));
  const current = (await pool.query("SELECT acknowledged_at,acknowledged_by,reviewed_at,observation_count FROM student_safety_alerts WHERE id=$1", [alert.alertId])).rows[0];
  assert.ok(current.acknowledged_at); assert.equal(current.acknowledged_by, adminId);
  assert.equal(current.reviewed_at, null); assert.equal(current.observation_count, 2);
  const delivery = (await pool.query("SELECT kind,status FROM safety_notification_outbox WHERE alert_id=$1", [alert.alertId])).rows;
  assert.equal(delivery.find(row => row.kind === "initial")?.status, "pending");
  assert.equal(delivery.find(row => row.kind === "followup")?.status, "cancelled");
  const distinct = await scoped(() => recordSafetyAlert({ ...observation, sourceId: randomUUID(), url: "https://fixture.example.test/distinct" }));
  const fresh = (await pool.query("SELECT acknowledged_at,reviewed_at FROM student_safety_alerts WHERE id=$1", [distinct.alertId])).rows[0];
  assert.equal(fresh.acknowledged_at, null); assert.equal(fresh.reviewed_at, null);
});
