import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { schoolPilot27ExpandMigrations } from "../src/db/migrations27.js";
import { CLASSPILOT_APPS_SQL, classpilotAppsMigration } from "../src/db/classpilotAppsMigration.js";

test("app button migration is an additive expand migration with a verified checksum", async () => {
  const migration = classpilotAppsMigration;
  assert.equal(migration.mode, "transactional");
  assert.equal(migration.checksum, createHash("sha256").update(CLASSPILOT_APPS_SQL).digest("hex"));
  assert.equal(schoolPilot27ExpandMigrations.filter(row => row.id === migration.id).length, 1);
});

test("app button migration preserves data and enforces tenant writes under a non-owner role", async context => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(connectionString, "A local privileged bootstrap URL is required");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(connectionString).hostname));
  const client = new pg.Client({ connectionString });
  await client.connect();
  const tag = randomUUID().replaceAll("-", ""), schema = `app_buttons_${tag}`, role = `app_buttons_rls_${tag}`;
  const schools = [randomUUID(), randomUUID()], teacher = randomUUID();
  const buttons = [randomUUID(), randomUUID()];
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public`);
    await client.query("CREATE TABLE schools(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY)");
    await client.query("INSERT INTO schools(id) VALUES($1),($2)", schools);
    await client.query("INSERT INTO users(id) VALUES($1)", [teacher]);
    await classpilotAppsMigration.apply(client);
    for (let index = 0; index < schools.length; index++) {
      await client.query("INSERT INTO classpilot_app_buttons(id,school_id,owner_teacher_id,scope,name,launch_url) VALUES($1,$2,$3,'personal','IXL','https://www.ixl.com/')", [buttons[index], schools[index], teacher]);
      await client.query("INSERT INTO classpilot_app_button_preferences(school_id,teacher_id,app_key,saved,favorite) VALUES($1,$2,'builtin:ixl',true,true)", [schools[index], teacher]);
    }
    await classpilotAppsMigration.apply(client);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM classpilot_app_buttons")).rows[0].count, 2);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM classpilot_app_button_preferences")).rows[0].count, 2);

    await context.test("revision defaults to one, preserves existing revisions and upgrades an earlier app table", async () => {
      const revision = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='classpilot_app_buttons' AND column_name='revision'", [schema]);
      assert.equal(revision.rowCount, 1, "App buttons require an optimistic concurrency revision");
      assert.deepEqual((await client.query("SELECT revision FROM classpilot_app_buttons ORDER BY id")).rows, [{ revision: 1 }, { revision: 1 }]);
      await client.query("UPDATE classpilot_app_buttons SET revision=7 WHERE id=$1", [buttons[0]]);
      await classpilotAppsMigration.apply(client);
      assert.deepEqual((await client.query("SELECT revision FROM classpilot_app_buttons WHERE id=$1", [buttons[0]])).rows, [{ revision: 7 }]);
      // The earlier unpublished local schema already contains saved records.
      await client.query("ALTER TABLE classpilot_app_buttons DROP COLUMN revision");
      await classpilotAppsMigration.apply(client);
      assert.deepEqual((await client.query("SELECT revision FROM classpilot_app_buttons ORDER BY id")).rows, [{ revision: 1 }, { revision: 1 }]);
    });

    await client.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.is_super','',true),set_config('app.school_id','',true)");
    const rejected = async (code: string, query: string, values: unknown[]) => {
      await client.query("SAVEPOINT expected_failure");
      try { await assert.rejects(client.query(query, values), { code }); }
      finally { await client.query("ROLLBACK TO SAVEPOINT expected_failure"); }
    };
    await context.test("both tables deny unscoped reads and enable forced USING and WITH CHECK policies", async () => {
      const policies = await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS using_policy,p.polwithcheck IS NOT NULL AS check_policy FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname=$1 AND p.polname='tenant_isolation' ORDER BY c.relname", [schema]);
      assert.deepEqual(policies.rows, ["classpilot_app_button_preferences", "classpilot_app_buttons"].map(relname => ({ relname, relrowsecurity: true, relforcerowsecurity: true, using_policy: true, check_policy: true })));
      assert.equal((await client.query("SELECT * FROM classpilot_app_buttons")).rowCount, 0);
      assert.equal((await client.query("SELECT * FROM classpilot_app_button_preferences")).rowCount, 0);
    });
    await context.test("one school can read and update only its own records", async () => {
      await client.query("SELECT set_config('app.school_id',$1,true)", [schools[0]]);
      assert.deepEqual((await client.query("SELECT id FROM classpilot_app_buttons")).rows, [{ id: buttons[0] }]);
      assert.deepEqual((await client.query("SELECT school_id FROM classpilot_app_button_preferences")).rows, [{ school_id: schools[0] }]);
      assert.equal((await client.query("UPDATE classpilot_app_buttons SET name='Math' WHERE id=$1", [buttons[0]])).rowCount, 1);
      assert.equal((await client.query("UPDATE classpilot_app_buttons SET name='Foreign' WHERE id=$1", [buttons[1]])).rowCount, 0);
      assert.equal((await client.query("DELETE FROM classpilot_app_button_preferences WHERE school_id=$1", [schools[1]])).rowCount, 0);
      await rejected("42501", "UPDATE classpilot_app_buttons SET school_id=$1 WHERE id=$2", [schools[1], buttons[0]]);
      await rejected("42501", "INSERT INTO classpilot_app_button_preferences(school_id,teacher_id,app_key) VALUES($1,$2,'builtin:quill')", [schools[1], teacher]);
    });
    await context.test("scope ownership, name and URL bounds, and favorite membership are database constraints", async () => {
      const insert = "INSERT INTO classpilot_app_buttons(school_id,owner_teacher_id,scope,name,launch_url) VALUES($1,$2,$3,$4,$5)";
      await rejected("23514", insert, [schools[0], null, "personal", "Math", "https://www.ixl.com/"]);
      await rejected("23514", insert, [schools[0], teacher, "school", "Math", "https://www.ixl.com/"]);
      await rejected("23514", insert, [schools[0], null, "invalid", "Math", "https://www.ixl.com/"]);
      await rejected("23514", insert, [schools[0], teacher, "personal", "", "https://www.ixl.com/"]);
      await rejected("23514", insert, [schools[0], teacher, "personal", "x".repeat(121), "https://www.ixl.com/"]);
      await rejected("23514", insert, [schools[0], teacher, "personal", "Math", ""]);
      await rejected("23514", insert, [schools[0], teacher, "personal", "Math", "x".repeat(4097)]);
      await rejected("23514", "UPDATE classpilot_app_buttons SET revision=0 WHERE id=$1", [buttons[0]]);
      await rejected("23514", "UPDATE classpilot_app_buttons SET revision=-1 WHERE id=$1", [buttons[0]]);
      await rejected("23514", "UPDATE classpilot_app_button_preferences SET saved=false WHERE school_id=$1", [schools[0]]);
      await rejected("23505", "INSERT INTO classpilot_app_button_preferences(school_id,teacher_id,app_key) VALUES($1,$2,'builtin:ixl')", [schools[0], teacher]);
      assert.equal((await client.query(insert, [schools[0], null, "school", "School math", "https://www.ixl.com/"])).rowCount, 1);
    });
  } finally { await client.query("ROLLBACK").catch(() => {}); await client.end(); }
});
