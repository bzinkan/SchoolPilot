import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

// Verifies the Phase-2 RLS request-binding mechanism (Proxy `db` + AsyncLocalStorage):
//   - outside any tenant scope, `db` uses the global pool (no app.school_id GUC),
//   - inside tenantALS.run with a GUC-scoped client, the SAME `db` import routes
//     its queries to that client (so app.school_id is visible),
//   - after the scope exits, `db` reverts to the global pool — and a client
//     returned to the pool with its GUC reset does not leak to the next caller.
// No RLS policies are involved here — this only proves the connection plumbing.
import { db, pool } from "../dist/db.js";
import { tenantALS } from "../dist/db/tenantContext.js";
import * as schema from "../dist/schema/index.js";

async function currentSchoolGuc(): Promise<string | null> {
  const r: any = await db.execute(sql`select current_setting('app.school_id', true) as sid`);
  return r.rows[0]?.sid ?? null;
}

before(() => {
  process.env.RLS_GUC_ENABLED = "true";
});

after(async () => {
  await pool.end();
});

describe("RLS tenant context (Phase 2 plumbing)", () => {
  it("outside any tenant scope, db uses the global pool (no GUC)", async () => {
    assert.ok(!(await currentSchoolGuc()));
  });

  it("inside tenantALS.run, db routes to the GUC-scoped client", async () => {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('app.school_id', $1, false)", ["school-XYZ"]);
      const store = { client, db: drizzle(client, { schema }), schoolId: "school-XYZ" } as any;
      await tenantALS.run(store, async () => {
        assert.equal(await currentSchoolGuc(), "school-XYZ");
      });
    } finally {
      // Mirror the middleware: reset the GUC before returning the client to the
      // pool so it can never leak to the next request.
      await client.query("SELECT set_config('app.school_id', '', false)");
      client.release();
    }
  });

  it("after the scope exits, db reverts to the global pool (no leaked GUC)", async () => {
    assert.ok(!(await currentSchoolGuc()));
  });

  it("with the kill-switch off, db ignores any bound context", async () => {
    process.env.RLS_GUC_ENABLED = "false";
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('app.school_id', $1, false)", ["should-be-ignored"]);
      const store = { client, db: drizzle(client, { schema }), schoolId: "should-be-ignored" } as any;
      await tenantALS.run(store, async () => {
        // flag off → Proxy uses the global pool, not the bound client
        assert.notEqual(await currentSchoolGuc(), "should-be-ignored");
      });
    } finally {
      await client.query("SELECT set_config('app.school_id', '', false)");
      client.release();
      process.env.RLS_GUC_ENABLED = "true";
    }
  });
});
