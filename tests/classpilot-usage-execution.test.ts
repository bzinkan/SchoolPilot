import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "postgresql://unit:unit@127.0.0.1:1/schoolpilot_unit";
const { pool } = await import("../src/db.js");
const { getTenantStore } = await import("../src/db/tenantContext.js");
const { runClasspilotUsageExecution } = await import("../src/services/classpilotUsageExecution.js");
const { ClasspilotUsageBusyError } = await import("../src/services/classpilotUsageAdmission.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("Usage owns a single scoped lease, resets once, and rejects post-release SQL", async t => {
  const previous = process.env.RLS_GUC_ENABLED;
  process.env.RLS_GUC_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.RLS_GUC_ENABLED; else process.env.RLS_GUC_ENABLED = previous; });
  const calls: string[] = [];
  let releases = 0;
  const client = Object.assign(new pg.Client(), { release() { releases++; } });
  t.mock.method(client, "query", async (query: string | { text: string }) => {
    calls.push(typeof query === "string" ? query : query.text);
    return { rows: [] };
  });
  t.mock.method(pool, "connect", async () => client);
  let escaped = () => Promise.resolve();
  await runClasspilotUsageExecution({ schoolId: "a", signal: new AbortController().signal, deadlineAt: performance.now() + 20_000 }, async () => {
    assert.equal(getTenantStore()?.schoolId, "a");
    const scopedDb = getTenantStore()!.db;
    await scopedDb.execute(sql`SELECT 1`);
    escaped = async () => { await scopedDb.execute(sql`SELECT 2`); };
  });
  await assert.rejects(escaped, error => error instanceof Error && error.cause instanceof ClasspilotUsageBusyError);
  assert.equal(releases, 1);
  assert.equal(calls.filter(query => query === "SELECT 1").length, 1);
  assert.equal(calls.filter(query => query === "SELECT 2").length, 0);
  assert.equal(calls.filter(query => query.includes("'app.school_id', ''")).length, 1);
});

test("Usage cancellation destroys active SQL but retains ownership until callback settles", async t => {
  const previous = process.env.RLS_GUC_ENABLED;
  process.env.RLS_GUC_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.RLS_GUC_ENABLED; else process.env.RLS_GUC_ENABLED = previous; });
  const controller = new AbortController();
  const started = deferred(), settle = deferred();
  const calls: string[] = [];
  let ended = false, releases = 0, discarded = false;
  const client = Object.assign(new pg.Client(), {
    release(error?: Error | boolean) { releases++; discarded = !!error; },
  });
  t.mock.method(client, "end", async () => { ended = true; });
  t.mock.method(client, "query", async (query: string | { text: string }) => {
    const text = typeof query === "string" ? query : query.text;
    calls.push(text);
    if (ended) throw new Error("connection closed");
    return { rows: [] };
  });
  t.mock.method(pool, "connect", async () => client);
  const running = runClasspilotUsageExecution({ schoolId: "a", signal: controller.signal, deadlineAt: performance.now() + 20_000 }, async () => {
    started.resolve();
    await settle.promise;
    await getTenantStore()!.db.execute(sql`SELECT 'must-not-run'`);
  });
  const rejection = assert.rejects(running, ClasspilotUsageBusyError);
  await started.promise;
  controller.abort(new ClasspilotUsageBusyError());
  assert.equal(ended, true);
  assert.equal(releases, 0);
  settle.resolve();
  await rejection;
  assert.equal(releases, 1);
  assert.equal(discarded, true);
  assert.ok(!calls.some(query => query.includes("must-not-run")));
});

test("Usage drains a checkout arriving after cancellation without running tenant work", async t => {
  const previous = process.env.RLS_GUC_ENABLED;
  process.env.RLS_GUC_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.RLS_GUC_ENABLED; else process.env.RLS_GUC_ENABLED = previous; });
  const controller = new AbortController(), checkout = deferred();
  let releases = 0, called = false;
  const calls: string[] = [];
  const client = Object.assign(new pg.Client(), { release() { releases++; } });
  t.mock.method(client, "query", async (query: string) => { calls.push(query); return { rows: [] }; });
  t.mock.method(pool, "connect", async () => { await checkout.promise; return client; });
  const pending = runClasspilotUsageExecution({ schoolId: "a", signal: controller.signal, deadlineAt: performance.now() + 20_000 }, async () => { called = true; });
  const rejection = assert.rejects(pending, ClasspilotUsageBusyError);
  controller.abort(new ClasspilotUsageBusyError()); checkout.resolve();
  await rejection;
  assert.equal(called, false);
  assert.equal(releases, 1);
  assert.ok(calls.every(query => query === "ROLLBACK" || query.includes("'app.school_id', ''")));
});

test("Usage rolls back before reset when its deadline passes between transaction statements", async t => {
  const previous = process.env.RLS_GUC_ENABLED;
  process.env.RLS_GUC_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.RLS_GUC_ENABLED; else process.env.RLS_GUC_ENABLED = previous; });
  let inTransaction = false, releases = 0;
  const calls: string[] = [];
  const client = Object.assign(new pg.Client(), { release() { releases++; assert.equal(inTransaction, false); } });
  t.mock.method(client, "query", async (query: string | { text: string }) => {
    const text = typeof query === "string" ? query : query.text;
    calls.push(text);
    if (/^begin/i.test(text)) inTransaction = true;
    if (/^rollback/i.test(text)) inTransaction = false;
    if (text.includes("'app.school_id', ''")) assert.equal(inTransaction, false);
    return { rows: [] };
  });
  t.mock.method(pool, "connect", async () => client);
  const options = { schoolId: "a", signal: new AbortController().signal, deadlineAt: performance.now() + 20_000 };
  await assert.rejects(runClasspilotUsageExecution(options, async () => {
    await getTenantStore()!.db.transaction(async tx => {
      await tx.execute(sql`SELECT 1`);
      options.deadlineAt = 0;
      await tx.execute(sql`SELECT 'expired'`);
    });
  }), ClasspilotUsageBusyError);
  assert.ok(calls.some(text => /^begin/i.test(text)));
  assert.ok(calls.some(text => /^rollback/i.test(text)));
  assert.ok(!calls.some(text => text.includes("expired")));
  assert.equal(releases, 1);
});
