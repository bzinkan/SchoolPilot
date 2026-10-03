import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { assertLocalScreenshotEvidenceFixture } from "../src/cli/prepareClasspilotHeartbeatScreenshotEvidence.js";
import {
  assertClasspilotHeartbeatScreenshotEvidence as verify,
  grantClasspilotHeartbeatScreenshotEvidence as grant,
  installClasspilotHeartbeatScreenshotEvidence as install,
} from "../src/db/classpilotHeartbeatScreenshotEvidenceInstallation.js";
import {
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SIGNATURE as signature,
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL as definition,
} from "../src/db/classpilotHeartbeatScreenshotEvidenceDefinition.js";

test("actual configured runtime has exact function and scoped execution", async () => {
  assertLocalScreenshotEvidenceFixture(process.env);
  const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await runtime.connect(); await verify(runtime);
    if (process.env.RLS_TEST_ROLE && process.env.RLS_TEST_ROLE !== "false") {
      const row = (await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.deepEqual(row, { rolsuper: false, rolbypassrls: false });
    }
  } finally { await runtime.end(); }
});

// All mutations, temporary roles and catalog drifts roll back. Other native
// readers cannot observe this test's uncommitted changes to the shared function.
test("installer preserves exact invoker definition and isolated role ACLs", async context => {
  assertLocalScreenshotEvidenceFixture(process.env);
  const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  const role = `screenshot_acl_${randomUUID().replaceAll("-", "")}`;
  try {
    await admin.connect(); await admin.query("BEGIN");
    await install(admin);
    await admin.query(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin.query(`GRANT SELECT,UPDATE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await context.test("role without exact grant fails startup and invocation", async () => {
      await admin.query(`SET LOCAL ROLE "${role}"`);
      try {
        await assert.rejects(verify(admin), /scoped runtime EXECUTE/);
        await admin.query("SAVEPOINT denied_execution");
        await assert.rejects(admin.query(`SELECT public.classpilot_heartbeat_screenshot_evidence_v1($1,$2,$3,$4)`, ["absent", "absent", "absent", "absent"]), { code: "42501" });
        await admin.query("ROLLBACK TO SAVEPOINT denied_execution");
      } finally { await admin.query("RESET ROLE"); }
    });
    await grant(admin, role);
    await context.test("explicit grant admits nonowner nonbypass invoker without widening table authority", async () => {
      await admin.query(`SET LOCAL ROLE "${role}"`);
      try {
        const facts = (await admin.query("SELECT rolsuper,rolbypassrls,(SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_proc WHERE oid=$1::regprocedure) AS owns FROM pg_roles WHERE rolname=current_user", [signature])).rows[0];
        assert.deepEqual(facts, { rolsuper: false, rolbypassrls: false, owns: false });
        await verify(admin);
        assert.deepEqual((await admin.query("SELECT public.classpilot_heartbeat_screenshot_evidence_v1($1,$2,$3,$4) AS evidence", ["absent", "absent", "absent", "absent"])).rows, [{ evidence: { stage: "session_missing" } }]);
      } finally { await admin.query("RESET ROLE"); }
    });
    await context.test("no-privileges restore's default PUBLIC execution is rejected and exact regrant repairs it", async () => {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`);
      await assert.rejects(verify(admin), /no PUBLIC EXECUTE/);
      await grant(admin, role); await verify(admin);
    });
    for (const alteration of ["STABLE", "SECURITY DEFINER", "PARALLEL SAFE", "STRICT", "SET search_path=public"]) {
      await context.test(`rejects ${alteration} without silently reinstalling`, async () => {
        await admin.query("SAVEPOINT incompatible_function");
        try {
          await admin.query(`ALTER FUNCTION ${signature} ${alteration}`);
          await assert.rejects(verify(admin), /immutable v1 contract/);
          await assert.rejects(install(admin), /immutable v1 contract/);
        } finally { await admin.query("ROLLBACK TO SAVEPOINT incompatible_function"); }
      });
    }
    await context.test("changed body and missing exact signature fail closed; absent install is idempotent", async () => {
      await admin.query("SAVEPOINT changed_body");
      try {
        await admin.query(definition.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace(/\$body\$[\s\S]*\$body\$/, "$body$ BEGIN RETURN NULL; END $body$"));
        await assert.rejects(verify(admin), /immutable v1 contract/);
        await assert.rejects(install(admin), /immutable v1 contract/);
      } finally { await admin.query("ROLLBACK TO SAVEPOINT changed_body"); }
      await admin.query("SAVEPOINT absent_function");
      try {
        await admin.query(`DROP FUNCTION ${signature}`);
        await assert.rejects(verify(admin), /missing/);
        await install(admin); await install(admin); await verify(admin);
      } finally { await admin.query("ROLLBACK TO SAVEPOINT absent_function"); }
    });
  } finally {
    try { await admin.query("ROLLBACK"); } finally { await admin.end(); }
  }
});
