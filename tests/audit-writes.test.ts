import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { eq, inArray, like } from "drizzle-orm";

// Match a normal API process. The old schedulerDb implementation fails every
// write in this posture even when the database itself has ample capacity.
process.env.SCHEDULER_ENABLED = "false";
process.env.RUN_MIGRATIONS_ONLY = "false";
process.env.RUN_MIGRATIONS_ON_STARTUP = "false";
process.env.RUN_LEGACY_MIGRATIONS_ONLY = "false";
process.env.RLS_GUC_ENABLED = "true";
const { db, pool } = await import("../src/db.js");
const { schools } = await import("../src/schema/core.js");
const { auditLogs } = await import("../src/schema/shared.js");
const { logAudit, logAuditStrict, logSystemAudit, getAuditLogs } = await import("../src/services/audit.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const { getTenantStore } = await import("../src/db/tenantContext.js");
const { schedulerPoolsInitialized } = await import("../src/services/schedulerDb.js");
const { snapshotRuntimePerformanceMetrics } = await import("../src/services/runtimePerformanceMetrics.js");
const { default: errorMonitor } = await import("../src/services/errorMonitor.js");
const prefix = `audit_test_${randomUUID()}`;
const schoolA = `${prefix}_a`;
const schoolB = `${prefix}_b`;

before(async () => {
  await db.insert(schools).values([
    { id: schoolA, name: "Audit fixture A", slug: schoolA },
    { id: schoolB, name: "Audit fixture B", slug: schoolB },
  ]);
});

after(async () => {
  try {
    await runWithTenantContext({ isSuper: true }, async () => {
      await db.delete(auditLogs).where(like(auditLogs.action, `${prefix}%`));
    });
    await db.delete(schools).where(inArray(schools.id, [schoolA, schoolB]));
  } finally {
    await errorMonitor.disposeAndWait();
    await pool.end();
  }
});

async function rowsFor(action: string) {
  return runWithTenantContext({ isSuper: true }, () =>
    db.select().from(auditLogs).where(eq(auditLogs.action, action)));
}

describe("API audit writes with school-scoped connections", () => {
  it("reuses an awaited matching tenant lease and never initializes scheduler pools", async () => {
    const action = `${prefix}.scoped`;
    await runWithTenantContext({ schoolId: schoolA }, async () => {
      const client = getTenantStore()?.client;
      const beforeCount = snapshotRuntimePerformanceMetrics().counters.tenantCheckouts ?? 0;
      await logAuditStrict({ schoolId: schoolA, action });
      assert.equal(getTenantStore()?.client, client);
      assert.equal(snapshotRuntimePerformanceMetrics().counters.tenantCheckouts ?? 0, beforeCount);
    });
    assert.equal((await rowsFor(action))[0]?.schoolId, schoolA);
    assert.deepEqual(schedulerPoolsInitialized(), { query: false, lock: false });
  });

  it("owns a fresh lease for trusted unscoped school events, resetting the GUC afterward", async () => {
    const action = `${prefix}.webhook`;
    assert.equal(getTenantStore(), undefined);
    await logAudit({ schoolId: schoolB, action });
    assert.equal(getTenantStore(), undefined);
    assert.equal((await rowsFor(action))[0]?.schoolId, schoolB);
    const result = await pool.query<{ school_id: string | null }>(
      "SELECT current_setting('app.school_id', true) AS school_id",
    );
    assert.ok(!result.rows[0]?.school_id);
  });

  it("keeps the audit insert inside its caller's transaction rollback", async () => {
    const action = `${prefix}.rolled_back`;
    await runWithTenantContext({ schoolId: schoolA }, async () => {
      await assert.rejects(db.transaction(async () => {
        await logAuditStrict({ schoolId: schoolA, action });
        const inserted = await db.select().from(auditLogs).where(eq(auditLogs.action, action));
        assert.equal(inserted.length, 1);
        throw new Error("Intentional transaction rollback");
      }), /Intentional transaction rollback/);
    });
    assert.equal((await rowsFor(action)).length, 0);
  });

  it("rejects a foreign school and global elevation inside a tenant request", async (t) => {
    const alert = t.mock.method(errorMonitor, "trackError", () => {});
    t.mock.method(console, "error", () => {});
    const action = `${prefix}.rejected`;
    await runWithTenantContext({ schoolId: schoolA }, async () => {
      await assert.rejects(logAuditStrict({ schoolId: schoolB, action }), { code: "AUDIT_SCOPE_MISMATCH" });
      await logSystemAudit({ action });
    });
    assert.equal((await rowsFor(action)).length, 0);
    assert.equal(alert.mock.callCount(), 2);
    for (const call of alert.mock.calls) {
      assert.equal(call.arguments[0], "health_failure");
      assert.equal(call.arguments[2]?.job, "auditWrite");
      assert.equal(call.arguments[3]?.persist, false);
    }
  });

  it("only the explicit system writer permits an unscoped NULL-school event", async (t) => {
    t.mock.method(errorMonitor, "trackError", () => {});
    t.mock.method(console, "error", () => {});
    const action = `${prefix}.global`;
    await logAudit({ action });
    assert.equal((await rowsFor(action)).length, 0);
    await logSystemAudit({ action });
    assert.equal((await rowsFor(action))[0]?.schoolId, null);
    assert.deepEqual(schedulerPoolsInitialized(), { query: false, lock: false });
  });

  it("keeps strict failures throwing and best-effort failures counted without recursive persistence", async (t) => {
    const alert = t.mock.method(errorMonitor, "trackError", () => {});
    t.mock.method(console, "error", () => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const beforeCount = snapshotRuntimePerformanceMetrics().counters.auditWriteFailure ?? 0;
    const action = `${prefix}.database_failure`;
    await assert.rejects(logAuditStrict({ schoolId: schoolA, action, changes: circular }));
    await assert.doesNotReject(logAudit({ schoolId: schoolA, action, changes: circular }));
    assert.equal((snapshotRuntimePerformanceMetrics().counters.auditWriteFailure ?? 0) - beforeCount, 2);
    assert.equal((await rowsFor(action)).length, 0);
    assert.equal(alert.mock.callCount(), 2);
    assert.deepEqual(alert.mock.calls.map((call) => call.arguments[2]?.messageType), ["strict", "best_effort"]);
    assert.ok(alert.mock.calls.every((call) => call.arguments[3]?.persist === false));
  });

  it("reports a checkout failure once through database connectivity without recursive audit alerts", async (t) => {
    const alert = t.mock.method(errorMonitor, "trackError", () => {});
    t.mock.method(console, "error", () => {});
    const failure = new Error("Injected pool checkout failure");
    const connect = t.mock.method(pool, "connect", async () => { throw failure; });
    const beforeCount = snapshotRuntimePerformanceMetrics().counters.auditWriteFailure ?? 0;
    await assert.rejects(logAuditStrict({ schoolId: schoolA, action: `${prefix}.pool_failure` }), failure);
    connect.mock.restore();
    assert.equal((snapshotRuntimePerformanceMetrics().counters.auditWriteFailure ?? 0) - beforeCount, 1);
    assert.equal(alert.mock.callCount(), 1);
    assert.equal(alert.mock.calls[0]?.arguments[0], "database_connectivity");
    assert.equal(alert.mock.calls[0]?.arguments[3]?.persist, false);
  });

  it("keeps school audit reads scoped", async () => {
    await logAuditStrict({ schoolId: schoolA, action: `${prefix}.read_scope` });
    await logAuditStrict({ schoolId: schoolB, action: `${prefix}.read_scope` });
    const scopedRows = await runWithTenantContext({ schoolId: schoolA }, () =>
      getAuditLogs({ schoolId: schoolA, action: `${prefix}.read_scope` }));
    assert.deepEqual(scopedRows.map((row) => row.schoolId), [schoolA]);
  });
});
