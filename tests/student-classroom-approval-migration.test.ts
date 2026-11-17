import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { googleStudentClassroomAccessMigration, GOOGLE_STUDENT_CLASSROOM_ACCESS_SQL } from "../src/db/googleStudentClassroomAccessMigration.js";
import { schoolPilot27Migrations } from "../src/db/migrations27.js";

test("student content approval is a separately checksummed additive migration in the ordered ledger", () => {
  assert.equal(googleStudentClassroomAccessMigration.mode, "transactional");
  assert.equal(googleStudentClassroomAccessMigration.checksum, createHash("sha256").update(GOOGLE_STUDENT_CLASSROOM_ACCESS_SQL).digest("hex"));
  assert.equal(schoolPilot27Migrations.filter(migration => migration.id === googleStudentClassroomAccessMigration.id).length, 1);
  assert.ok(schoolPilot27Migrations.indexOf(googleStudentClassroomAccessMigration) > schoolPilot27Migrations.findIndex(migration => migration.id === "20260930_flight_path_content_revision_expand"));
});

const testUrl = process.env.TEST_ADMIN_DATABASE_URL || process.env.ADMIN_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test("nullable approval expansion preserves grants and real connector CAS rejects ABA changes without timestamp changes", { skip: !testUrl, timeout: 60_000 }, async () => {
  const parsed = new URL(testUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && /^(sptest|schoolpilot_test|student_classroom_test)$/.test(parsed.pathname.slice(1)), "Only a disposable local test database may run this fixture");
  const schema = `classroom_access_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  assert.match(schema, /^classroom_access_test_[a-f0-9]{16}$/);
  const owner = new Pool({ connectionString: testUrl, connectionTimeoutMillis: 5000, query_timeout: 15_000, max: 1 });
  let applicationPool: { end: () => Promise<void> } | undefined;
  try {
    await owner.query(`CREATE SCHEMA "${schema}"`);
    await owner.query(`SET search_path TO "${schema}"`);
    await owner.query(`CREATE TABLE google_roster_connectors (
      id VARCHAR PRIMARY KEY, school_id TEXT NOT NULL UNIQUE, domain TEXT NOT NULL,
      delegated_admin_email TEXT, service_account_client_id TEXT, approved_scopes TEXT[] NOT NULL DEFAULT '{}',
      auth_mode TEXT NOT NULL DEFAULT 'service_account_key', status TEXT NOT NULL DEFAULT 'unverified',
      verified_at TIMESTAMP, last_sync_at TIMESTAMP, disabled_at TIMESTAMP, last_error TEXT,
      connected_by_user_id TEXT, created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now())`);
    await owner.query("INSERT INTO google_roster_connectors(id,school_id,domain,delegated_admin_email,service_account_client_id,approved_scopes,status) VALUES ('connector','school','school.example','admin@school.example','client',ARRAY['original-roster-scope'],'verified')");
    for (let run = 0; run < 2; run++) {
      const connection = await owner.connect();
      try { await connection.query("BEGIN"); await googleStudentClassroomAccessMigration.apply(connection); await connection.query("COMMIT"); }
      catch (error) { await connection.query("ROLLBACK"); throw error; }
      finally { connection.release(); }
    }
    const column = await owner.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='google_roster_connectors' AND column_name='classroom_access_approval'", [schema]);
    assert.deepEqual(column.rows, [{ is_nullable: "YES", column_default: null }]);
    const retained = await owner.query("SELECT approved_scopes,classroom_access_approval FROM google_roster_connectors WHERE school_id='school'");
    assert.deepEqual(retained.rows, [{ approved_scopes: ["original-roster-scope"], classroom_access_approval: null }]);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = parsed.toString();
    process.env.REDIS_URL = "";
    const storage = await import("../src/services/storage.js");
    applicationPool = (await import("../src/db.js")).pool;
    const captured = await storage.getGoogleClassroomAccessConnector("school");
    assert.ok(captured?.approvalVersion);
    const approval = { schemaVersion: 1 as const, approvalId: randomUUID(), approvedByUserId: "admin-actor", approvedAt: new Date().toISOString(), schoolId: "school", domain: "school.example", serviceAccountClientId: "client", delegatedAdminEmail: "admin@school.example" };
    const applied = await storage.compareAndSetGoogleClassroomAccessScopes("school", captured, ["original-roster-scope", "content-scope"], approval);
    assert.deepEqual(applied?.classroomAccessApproval, approval);
    const stale = await storage.getGoogleClassroomAccessConnector("school");
    assert.ok(stale);
    await owner.query("UPDATE google_roster_connectors SET connected_by_user_id='changed' WHERE school_id='school'");
    await owner.query("UPDATE google_roster_connectors SET connected_by_user_id=NULL WHERE school_id='school'");
    assert.equal(await storage.compareAndSetGoogleClassroomAccessScopes("school", stale, [], null), undefined, "ABA writes cannot pass a timestamp-based CAS");
    assert.equal(await storage.compareAndSetGoogleClassroomAccessScopes("foreign", stale, [], null), undefined, "school mismatch cannot mutate a connector");
    const final = await storage.getGoogleClassroomAccessConnector("school");
    assert.deepEqual(final?.approvedScopes, ["original-roster-scope", "content-scope"]);
    assert.deepEqual(final?.classroomAccessApproval, approval);
  } finally {
    await applicationPool?.end();
    await owner.query("SET search_path TO public");
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.end();
  }
});
