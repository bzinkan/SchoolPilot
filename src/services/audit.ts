import db from "../db.js";
import { getTenantStore } from "../db/tenantContext.js";
import { runWithTenantContext, wasTenantPoolAcquisitionFailureReported } from "../middleware/tenantContext.js";
import { auditLogs } from "../schema/shared.js";
import { desc, eq, and, sql, count } from "drizzle-orm";
import { safeErrorMetadata } from "../util/safeLogging.js";
import errorMonitor from "./errorMonitor.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";

export type AuditEntry = {
  schoolId?: string | null;
  userId?: string | null;
  userEmail?: string;
  userRole?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  changes?: unknown;
  metadata?: unknown;
};

function auditScopeError(): Error {
  return Object.assign(new Error("Audit school context does not match the authorized scope"), {
    code: "AUDIT_SCOPE_MISMATCH",
  });
}

async function insertAudit(entry: AuditEntry, system: boolean): Promise<void> {
  const store = getTenantStore();
  const schoolId = system ? null : entry.schoolId ?? store?.schoolId;
  if (system) {
    // Only the explicitly named internal writer may insert global audit rows.
    // It cannot elevate a school-scoped request, even for a NULL-school event.
    if (entry.schoolId || store && !store.isSuper) throw auditScopeError();
  } else if (!schoolId || store?.schoolId && store.schoolId !== schoolId) {
    throw auditScopeError();
  }
  const values = {
    schoolId,
    userId: entry.userId ?? null,
    userEmail: entry.userEmail ?? null,
    userRole: entry.userRole ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    entityName: entry.entityName ?? null,
    changes: entry.changes ?? null,
    metadata: entry.metadata ?? null,
  };
  if (store) {
    if (!store.isSuper && store.schoolId !== schoolId) throw auditScopeError();
    await store.db.insert(auditLogs).values(values);
    return;
  }
  // Trusted auth/webhook/background callers own a fresh, short-lived scope.
  // No caller callback can run inside the system writer's elevated scope.
  await runWithTenantContext(system ? { isSuper: true } : { schoolId: schoolId! }, async () => {
    await db.insert(auditLogs).values(values);
  });
}

function reportAuditFailure(error: unknown, strict: boolean): void {
  recordRuntimePerformanceCounter("auditWriteFailure");
  console.error("[Audit] Failed to log:", safeErrorMetadata(error));
  if (wasTenantPoolAcquisitionFailureReported(error)) return;
  errorMonitor.trackError("health_failure", new Error("Audit write failed"), {
    job: "auditWrite",
    messageType: strict ? "strict" : "best_effort",
    errorCode: "AUDIT_WRITE_FAILED",
  }, { persist: false, priority: "high" });
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await insertAudit(entry, false);
  } catch (error) {
    reportAuditFailure(error, false);
  }
}

/** Global authentication/system events; never a tenant-write fallback. */
export async function logSystemAudit(entry: Omit<AuditEntry, "schoolId"> & { schoolId?: null }): Promise<void> {
  try {
    await insertAudit(entry, true);
  } catch (error) {
    reportAuditFailure(error, false);
  }
}

/**
 * Record a privileged mutation before returning success to the caller.
 * Unlike best-effort telemetry, this intentionally propagates failures so a
 * staff-management response can never claim an unaudited success.
 */
export async function logAuditStrict(entry: Parameters<typeof logAudit>[0]): Promise<void> {
  try {
    await insertAudit(entry, false);
  } catch (error) {
    reportAuditFailure(error, true);
    throw error;
  }
}

export async function getAuditLogs(options: {
  schoolId?: string;
  userId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];
  if (options.schoolId) conditions.push(eq(auditLogs.schoolId, options.schoolId));
  if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
  if (options.action) conditions.push(eq(auditLogs.action, options.action));
  if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));
  if (options.entityId) conditions.push(eq(auditLogs.entityId, options.entityId));

  const query = db
    .select()
    .from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(options.limit || 100)
    .offset(options.offset || 0);

  return query;
}

export async function countAuditLogs(options: {
  schoolId?: string;
  userId?: string;
  action?: string;
  entityType?: string;
}) {
  const conditions = [];
  if (options.schoolId) conditions.push(eq(auditLogs.schoolId, options.schoolId));
  if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
  if (options.action) conditions.push(eq(auditLogs.action, options.action));
  if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));

  const [result] = await db
    .select({ total: count() })
    .from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return result?.total ?? 0;
}
