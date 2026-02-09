import db from "../db.js";
import { auditLogs } from "../schema/shared.js";
import { desc, eq, and } from "drizzle-orm";

export async function logAudit(entry: {
  schoolId: string;
  userId: string;
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
    await db.insert(auditLogs).values({
      schoolId: entry.schoolId,
      userId: entry.userId,
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
