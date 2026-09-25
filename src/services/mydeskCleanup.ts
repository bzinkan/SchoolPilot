import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { mydeskAttachments, mydeskNotes } from "../schema/mydesk.js";
import { schedulerDb } from "./schedulerDb.js";
import { MYDESK_CLEANUP_GRACE_MS, myDeskObjectStore, type MyDeskObjectStore } from "./mydeskFiles.js";

/** Worker-only durable cleanup. Deliberately independent of school rollout, entitlement and membership. */
export async function cleanupMyDesk(options: { store?: MyDeskObjectStore; now?: Date; database?: typeof schedulerDb; limit?: number } = {}) {
  const database = options.database ?? schedulerDb;
  const store = options.store ?? myDeskObjectStore;
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const expiredBefore = new Date(now.getTime() - 24 * 60 * 60_000);
  const notes = await database.select({ id: mydeskNotes.id, schoolId: mydeskNotes.schoolId, authorId: mydeskNotes.authorId })
    .from(mydeskNotes).where(or(and(eq(mydeskNotes.status, "pending"), lte(mydeskNotes.expiresAt, now)),
      and(eq(mydeskNotes.status, "deleted"), sql`(${mydeskNotes.title} <> '' OR ${mydeskNotes.body} <> '' OR coalesce(${mydeskNotes.groupName}, '') <> '' OR coalesce(${mydeskNotes.studentName}, '') <> '')`)))
    .limit(limit);
  for (const owner of notes) {
    await database.transaction(async tx => {
      const predicate = and(eq(mydeskNotes.id, owner.id), eq(mydeskNotes.schoolId, owner.schoolId), eq(mydeskNotes.authorId, owner.authorId));
      const [note] = await tx.select().from(mydeskNotes).where(predicate).for("update");
      if (!note || (note.status !== "deleted" && !(note.status === "pending" && note.expiresAt && note.expiresAt <= now))) return;
      await tx.update(mydeskAttachments).set({ status: "delete_pending", nextCleanupAt: now, deletedAt: now, updatedAt: now })
        .where(and(eq(mydeskAttachments.schoolId, owner.schoolId), eq(mydeskAttachments.authorId, owner.authorId), eq(mydeskAttachments.noteId, owner.id),
          inArray(mydeskAttachments.status, ["pending", "uploading", "ready"])));
      // Keep only the idempotency tombstone and historical filing IDs, not private note text or labels.
      await tx.update(mydeskNotes).set({ status: "deleted", title: "", body: "", groupName: note.groupName === null ? null : "",
        studentName: note.studentName === null ? null : "", deletedAt: note.deletedAt ?? now, updatedAt: now }).where(predicate);
    });
  }
  const abandoned = await database.select({ id: mydeskAttachments.id, noteId: mydeskAttachments.noteId, schoolId: mydeskAttachments.schoolId,
    authorId: mydeskAttachments.authorId }).from(mydeskAttachments)
    .where(and(isNull(mydeskAttachments.committedAt), lte(mydeskAttachments.createdAt, expiredBefore), inArray(mydeskAttachments.status, ["pending", "uploading", "ready"]))).limit(limit);
  for (const attachment of abandoned) {
    await database.transaction(async tx => {
      await tx.select({ id: mydeskNotes.id }).from(mydeskNotes).where(and(eq(mydeskNotes.id, attachment.noteId), eq(mydeskNotes.schoolId, attachment.schoolId),
        eq(mydeskNotes.authorId, attachment.authorId))).for("update");
      await tx.update(mydeskAttachments).set({ status: "delete_pending", nextCleanupAt: now, deletedAt: now, updatedAt: now })
        .where(and(eq(mydeskAttachments.id, attachment.id), eq(mydeskAttachments.schoolId, attachment.schoolId), eq(mydeskAttachments.authorId, attachment.authorId),
          isNull(mydeskAttachments.committedAt), inArray(mydeskAttachments.status, ["pending", "uploading", "ready"])));
    });
  }
  const due = await database.select().from(mydeskAttachments).where(and(inArray(mydeskAttachments.status, ["delete_pending", "deleted"]),
    or(isNull(mydeskAttachments.nextCleanupAt), lte(mydeskAttachments.nextCleanupAt, now)),
    or(isNull(mydeskAttachments.uploadLeaseUntil), lte(mydeskAttachments.uploadLeaseUntil, new Date(now.getTime() - MYDESK_CLEANUP_GRACE_MS))))).limit(limit);
  let deleted = 0;
  for (const attachment of due) {
    // A paused/crashed process or late remote PUT must not orphan an object after the first DELETE.
    // Terminal tombstones remain scheduled for idempotent daily reconciliation even after deletion was confirmed.
    try {
      await store.delete(attachment.storageKey);
      await database.update(mydeskAttachments).set({ status: "deleted", originalFilename: "", contentType: null, inputSha256: null,
        sha256: null, byteSize: null, committedAt: null, uploadLeaseId: null, uploadLeaseUntil: null, nextCleanupAt: new Date(now.getTime() + 24 * 60 * 60_000),
        cleanupAttempts: 0, lastErrorCode: null, updatedAt: now }).where(and(eq(mydeskAttachments.id, attachment.id), eq(mydeskAttachments.schoolId, attachment.schoolId),
          eq(mydeskAttachments.authorId, attachment.authorId), inArray(mydeskAttachments.status, ["delete_pending", "deleted"])));
      deleted++;
    } catch {
      // Never log raw SDK errors, keys, filenames or content. The durable row carries only a bounded operational code.
      await database.update(mydeskAttachments).set({ cleanupAttempts: attachment.cleanupAttempts + 1, lastErrorCode: "object_delete_failed",
        nextCleanupAt: new Date(now.getTime() + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attachment.cleanupAttempts, 10))), updatedAt: now })
        .where(and(eq(mydeskAttachments.id, attachment.id), eq(mydeskAttachments.schoolId, attachment.schoolId),
          eq(mydeskAttachments.authorId, attachment.authorId), inArray(mydeskAttachments.status, ["delete_pending", "deleted"])));
    }
  }
  return { expiredNotes: notes.length, expiredAttachments: abandoned.length, deleted };
}
