import db from "../db.js";
import { schedulerDb } from "./schedulerDb.js";
import { auditLogs } from "../schema/shared.js";
import { desc, eq, and, sql, count } from "drizzle-orm";

export async function logAudit(entry: {
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
}): Promise<void> {
  try {
    // Audit writes always go through the is_super scheduler pool so they can
    // never be blocked by audit_logs RLS WITH CHECK — this covers system-origin
    // writes with a NULL school_id and no request tenant context (public
    // login/OAuth/logout, Stripe webhook) as well as normal per-school actions.
    // Reads (getAuditLogs/countAuditLogs) stay on the GUC-scoped Proxy db so a
    // school admin only ever sees their own school's trail.
    await schedulerDb.insert(auditLogs).values({
      schoolId: entry.schoolId ?? null,
      userId: entry.userId ?? null,
      userEmail: entry.userEmail ?? null,
      userRole: entry.userRole ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      entityName: entry.entityName ?? null,
      changes: entry.changes ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (error) {
    console.error("[Audit] Failed to log:", error);
  }
}

export async function getAuditLogs(options: {
  schoolId?: string;
  userId?: string;
  action?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];
  if (options.schoolId) conditions.push(eq(auditLogs.schoolId, options.schoolId));
  if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
  if (options.action) conditions.push(eq(auditLogs.action, options.action));
  if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));

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
