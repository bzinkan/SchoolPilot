import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { CLASSPILOT_NATIVE_VISIBILITY_SQL } from "../src/db/classpilotNativeVisibilityMigration.js";

test("native identities enforce tenant isolation, same-school parents and active-session uniqueness", async context => {
  const url = process.env.ADMIN_DATABASE_URL;
  assert.ok(url, "An isolated local bootstrap connection is required");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname));
  const client = new pg.Client({ connectionString: url });
  const role = `native_rls_${randomUUID().replaceAll("-", "")}`;
  const rows = [0, 1].map(() => ({ school: randomUUID(), student: randomUUID(),
    enrollment: randomUUID(), spareEnrollment: randomUUID(), installation: randomUUID(), session: randomUUID(), source: randomUUID() }));
  const hash = "a".repeat(64);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(CLASSPILOT_NATIVE_VISIBILITY_SQL);
    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query("SELECT set_config('app.is_super','on',true)");
    for (const row of rows) {
      await client.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Native synthetic RLS',$2,'active','active')", [row.school, `${row.school}.example.edu`]);
      await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Student','active')", [row.student, row.school]);
      await client.query("INSERT INTO classpilot_native_enrollment_tokens(id,school_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,'synthetic-admin',now()+interval '10 minutes')", [row.enrollment, row.school, hash]);
      await client.query("INSERT INTO classpilot_native_enrollment_tokens(id,school_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,'synthetic-admin',now()+interval '10 minutes')", [row.spareEnrollment, row.school, hash]);
      await client.query("INSERT INTO classpilot_native_installations(id,school_id,credential_hash,enrollment_token_id,client_version) VALUES($1,$2,$3,$4,'0.1.0')", [row.installation, row.school, hash, row.enrollment]);
      await client.query("INSERT INTO classpilot_native_sessions(id,school_id,installation_id,student_id,credential_hash,student_credential_fingerprint,os_session_nonce,binding_revision,source_ref,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,1,$7,now()+interval '5 minutes',now()+interval '8 hours')", [row.session, row.school, row.installation, row.student, hash, randomUUID(), row.source]);
    }
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.is_super','',true),set_config('app.school_id','',true)");
    const sqlError = async (code: string, statement: string, values: unknown[]) => {
      await client.query("SAVEPOINT expected_native_denial");
      try { await assert.rejects(client.query(statement, values), { code }); }
      finally { await client.query("ROLLBACK TO SAVEPOINT expected_native_denial"); }
    };
    await context.test("the actual non-owner role has no bypass and each native table has forced policy", async () => {
      const state = await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(state.rows, [{ rolsuper: false, rolbypassrls: false }]);
      const policies = await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS read_policy,p.polwithcheck IS NOT NULL AS write_policy FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relname=ANY($1::text[]) AND p.polname='tenant_isolation'", [["classpilot_native_enrollment_tokens", "classpilot_native_installations", "classpilot_native_sessions"]]);
      assert.equal(policies.rowCount, 3);
      assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && row.read_policy && row.write_policy));
    });
    await context.test("absent tenant context reveals nothing and school context only reveals its own rows", async () => {
      for (const table of ["classpilot_native_enrollment_tokens", "classpilot_native_installations", "classpilot_native_sessions"]) {
        assert.equal((await client.query(`SELECT id FROM ${table}`)).rowCount, 0);
      }
      await client.query("SELECT set_config('app.school_id',$1,true)", [rows[0]!.school]);
      assert.deepEqual((await client.query("SELECT id FROM classpilot_native_sessions WHERE id=ANY($1::text[])", [rows.map(row => row.session)])).rows, [{ id: rows[0]!.session }]);
      assert.equal((await client.query("UPDATE classpilot_native_sessions SET ended_at=now() WHERE id=$1", [rows[1]!.session])).rowCount, 0);
    });
    await context.test("cross-school writes and mismatched enrollment/student parents are rejected", async () => {
      const own = rows[0]!, other = rows[1]!;
      await sqlError("42501", "INSERT INTO classpilot_native_enrollment_tokens(id,school_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,'synthetic',now())", [randomUUID(), other.school, hash]);
      await sqlError("23503", "INSERT INTO classpilot_native_installations(id,school_id,credential_hash,enrollment_token_id,client_version) VALUES($1,$2,$3,$4,'0.1.0')", [randomUUID(), own.school, hash, other.spareEnrollment]);
      await sqlError("23503", "UPDATE classpilot_native_sessions SET student_id=$1 WHERE id=$2", [other.student, own.session]);
    });
    await context.test("only one unended native session owns an installation/student, including expired rows", async () => {
      const own = rows[0]!;
      await sqlError("23505", "INSERT INTO classpilot_native_sessions(id,school_id,installation_id,student_id,credential_hash,student_credential_fingerprint,os_session_nonce,binding_revision,source_ref,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,2,$7,now()+interval '5 minutes',now()+interval '8 hours')", [randomUUID(), own.school, own.installation, own.student, hash, randomUUID(), randomUUID()]);
      await client.query("UPDATE classpilot_native_sessions SET ended_at=now(),end_reason='synthetic-handoff' WHERE id=$1", [own.session]);
      assert.equal((await client.query("INSERT INTO classpilot_native_sessions(id,school_id,installation_id,student_id,credential_hash,student_credential_fingerprint,os_session_nonce,binding_revision,source_ref,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,2,$7,now()+interval '5 minutes',now()+interval '8 hours')", [randomUUID(), own.school, own.installation, own.student, hash, randomUUID(), randomUUID()])).rowCount, 1);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
