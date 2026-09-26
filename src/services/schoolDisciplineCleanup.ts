import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schoolDisciplineRecords as records, schoolDisciplineVersions as versions, schoolDisciplineAttachments as attachments,
  type DisciplineSnapshot } from "../schema/schoolDiscipline.js";
import { schedulerDb } from "./schedulerDb.js";
import { myDeskObjectStore, MYDESK_CLEANUP_GRACE_MS, type MyDeskObjectStore } from "./mydeskFiles.js";

/** Always-on worker cleanup. School membership, grants and product modes are irrelevant. */
export async function cleanupSchoolDiscipline(options: { database?: typeof schedulerDb; store?: MyDeskObjectStore; now?: Date; limit?: number } = {}) {
  const database = options.database ?? schedulerDb, store = options.store ?? myDeskObjectStore, now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200)), cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const stale = await database.select().from(versions).where(and(eq(versions.state, "preparing"), lte(versions.createdAt, cutoff),
    or(isNull(versions.leaseUntil), lte(versions.leaseUntil, now)))).limit(limit);
  let abandoned = 0, deleted = 0;
  for (const candidate of stale) {
    await database.transaction(async tx => {
      const [record] = await tx.select().from(records).where(and(eq(records.schoolId, candidate.schoolId), eq(records.id, candidate.recordId))).for("update");
      const [version] = await tx.select().from(versions).where(and(eq(versions.schoolId, candidate.schoolId), eq(versions.id, candidate.id))).for("update");
      if (!record || !version || version.state !== "preparing" || version.createdAt > cutoff || version.leaseUntil && version.leaseUntil > now) return;
      await tx.update(versions).set({ state: "abandoned", snapshot: {} as DisciplineSnapshot, reason: null, sourceNoteId: null, sourceNoteRevision: null,
        sourceFingerprint: null, leaseId: null, leaseUntil: null }).where(and(eq(versions.schoolId, candidate.schoolId), eq(versions.id, candidate.id)));
      await tx.update(attachments).set({ status: "delete_pending", nextCleanupAt: now, sourceStorageKey: null, sourceAttachmentId: null })
        .where(and(eq(attachments.schoolId, candidate.schoolId), eq(attachments.versionId, candidate.id), inArray(attachments.status, ["pending", "ready"])));
      if (record.status === "pending") await tx.update(records).set({ status: "abandoned", submittedByName: "", updatedAt: now }).where(and(eq(records.schoolId, candidate.schoolId), eq(records.id, candidate.recordId)));
      abandoned++;
    });
  }
  const due = await database.select().from(attachments).where(and(inArray(attachments.status, ["delete_pending", "deleted"]),
    or(isNull(attachments.nextCleanupAt), lte(attachments.nextCleanupAt, now)),
    or(isNull(attachments.leaseUntil), lte(attachments.leaseUntil, new Date(now.getTime() - MYDESK_CLEANUP_GRACE_MS))))).limit(limit);
  for (const candidate of due) {
    // Claim with the same parent-before-asset order as publication. Never delete a
    // promoted object. Tombstones remain scheduled to catch remote late writes.
    const claimed = await database.transaction(async tx => {
      const [version] = await tx.select().from(versions).where(and(eq(versions.schoolId, candidate.schoolId), eq(versions.id, candidate.versionId))).for("update");
      if (!version || version.state === "published") return false;
      const [row] = await tx.update(attachments).set({ nextCleanupAt: new Date(now.getTime() + 5 * 60_000) }).where(and(
        eq(attachments.schoolId, candidate.schoolId), eq(attachments.id, candidate.id), inArray(attachments.status, ["delete_pending", "deleted"]),
        or(isNull(attachments.nextCleanupAt), lte(attachments.nextCleanupAt, now)))).returning();
      return Boolean(row);
    });
    if (!claimed) continue;
    try {
      await store.delete(candidate.storageKey);
      await database.update(attachments).set({ status: "deleted", filename: "", sourceStorageKey: null, sourceAttachmentId: null,
        nextCleanupAt: new Date(now.getTime() + 24 * 60 * 60_000), cleanupAttempts: 0, lastErrorCode: null, leaseUntil: null })
        .where(and(eq(attachments.schoolId, candidate.schoolId), eq(attachments.id, candidate.id), inArray(attachments.status, ["delete_pending", "deleted"])));
      deleted++;
    } catch {
      await database.update(attachments).set({ cleanupAttempts: candidate.cleanupAttempts + 1, lastErrorCode: "object_delete_failed",
        nextCleanupAt: new Date(now.getTime() + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(candidate.cleanupAttempts, 10))) })
        .where(and(eq(attachments.schoolId, candidate.schoolId), eq(attachments.id, candidate.id), inArray(attachments.status, ["delete_pending", "deleted"])));
    }
  }
  return { abandoned, deleted };
}
