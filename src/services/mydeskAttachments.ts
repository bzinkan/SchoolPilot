import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { mydeskAttachments, mydeskNotes } from "../schema/mydesk.js";
import { assertMyDeskNoteNonempty, myDeskError, ownedNoteWhere, withMyDeskNoteLock, type MyDeskActor } from "./mydesk.js";
import { MYDESK_MAX_ATTACHMENTS, MYDESK_UPLOAD_LEASE_MS, myDeskObjectStore, myDeskSha256, normalizeMyDeskFile,
  validateMyDeskFileMetadata, type MyDeskObjectStore } from "./mydeskFiles.js";

type Attachment = typeof mydeskAttachments.$inferSelect;
const attachmentWhere = (actor: MyDeskActor, noteId: string, id?: string) => and(eq(mydeskAttachments.schoolId, actor.schoolId),
  eq(mydeskAttachments.authorId, actor.authorId), eq(mydeskAttachments.noteId, noteId), id ? eq(mydeskAttachments.id, id) : undefined);
export const safeMyDeskAttachment = (attachment: Attachment) => ({ id: attachment.id, originalFilename: attachment.originalFilename,
  contentType: attachment.contentType, byteSize: attachment.byteSize, status: attachment.status, committedAt: attachment.committedAt });

export type MyDeskReservation = { clientRequestId: string; filename: string; contentType: string; size: number; sha256: string };

export async function reserveMyDeskAttachment(actor: MyDeskActor, noteId: string, request: MyDeskReservation) {
  validateMyDeskFileMetadata(request.contentType, request.size);
  const requestFingerprint = myDeskSha256(Buffer.from(JSON.stringify([request.filename, request.contentType, request.size, request.sha256])));
  return withMyDeskNoteLock(actor, noteId, async (tx, note) => {
    const [existing] = await tx.select().from(mydeskAttachments).where(and(attachmentWhere(actor, noteId), eq(mydeskAttachments.clientRequestId, request.clientRequestId)));
    if (existing) {
      if (existing.status === "deleted" || existing.status === "delete_pending") throw myDeskError(409, "attachment_deleted", "This upload was cancelled. Choose the file again.");
      if (existing.requestFingerprint !== requestFingerprint) {
        throw myDeskError(409, "request_conflict", "This upload identifier was already used for another file.");
      }
      return safeMyDeskAttachment(existing);
    }
    const reservations = await tx.select({ id: mydeskAttachments.id }).from(mydeskAttachments).where(and(attachmentWhere(actor, noteId),
      inArray(mydeskAttachments.status, ["pending", "uploading", "ready"])));
    if (reservations.length >= MYDESK_MAX_ATTACHMENTS) throw myDeskError(409, "attachment_limit", "A note can have at most five files, including pending uploads. Save any attachment removals before adding more files.");
    const id = randomUUID();
    // The durable key is written before the object. No failed PUT can produce an untraceable object.
    const [attachment] = await tx.insert(mydeskAttachments).values({ id, schoolId: actor.schoolId, authorId: actor.authorId, noteId: note.id,
      clientRequestId: request.clientRequestId, requestFingerprint, storageKey: `mydesk/${actor.schoolId}/${actor.authorId}/${note.id}/${id}`,
      originalFilename: request.filename, contentType: request.contentType, inputSha256: request.sha256, byteSize: request.size, status: "pending" }).returning();
    return safeMyDeskAttachment(attachment!);
  });
}

export async function uploadMyDeskAttachment(actor: MyDeskActor, noteId: string, attachmentId: string, bytes: Buffer, contentType: string,
  store: MyDeskObjectStore = myDeskObjectStore) {
  validateMyDeskFileMetadata(contentType, bytes.length);
  const leaseId = randomUUID();
  const reserved = await withMyDeskNoteLock(actor, noteId, async (tx) => {
    const [attachment] = await tx.select().from(mydeskAttachments).where(attachmentWhere(actor, noteId, attachmentId));
    if (!attachment || attachment.status === "delete_pending" || attachment.status === "deleted") throw myDeskError(404, "not_found", "Attachment not found.");
    if (attachment.inputSha256 !== myDeskSha256(bytes)) throw myDeskError(409, "upload_mismatch", "This file differs from the reserved upload. Choose it again.");
    if (attachment.status === "ready") return attachment;
    if (attachment.contentType !== contentType || attachment.byteSize !== bytes.length) throw myDeskError(409, "upload_mismatch", "The file type or size differs from the reserved upload.");
    if (attachment.uploadLeaseUntil && attachment.uploadLeaseUntil.getTime() > Date.now()) throw myDeskError(409, "upload_in_progress", "This file is still uploading. Retry shortly.");
    const [updated] = await tx.update(mydeskAttachments).set({ status: "uploading", uploadLeaseId: leaseId,
      uploadLeaseUntil: new Date(Date.now() + MYDESK_UPLOAD_LEASE_MS), updatedAt: new Date() }).where(attachmentWhere(actor, noteId, attachmentId)).returning();
    return updated!;
  });
  if (reserved.status === "ready") return safeMyDeskAttachment(reserved);
  try {
    const normalized = await normalizeMyDeskFile(bytes, contentType);
    if (!reserved.uploadLeaseUntil || Date.now() + 60_000 >= reserved.uploadLeaseUntil.getTime()) {
      throw myDeskError(409, "upload_lease_expired", "Processing this file took too long. Retry the upload.");
    }
    await store.put(reserved.storageKey, normalized.bytes, normalized.contentType);
    return await withMyDeskNoteLock(actor, noteId, async (tx, note) => {
      const [current] = await tx.select().from(mydeskAttachments).where(attachmentWhere(actor, noteId, attachmentId));
      if (!current || note.status === "deleted" || current.status !== "uploading" || current.uploadLeaseId !== leaseId) {
        // A deleting transaction or worker keeps this key queued until after the bounded upload lease.
        throw myDeskError(409, "upload_cancelled", "This upload was cancelled.");
      }
      const [ready] = await tx.update(mydeskAttachments).set({ status: "ready", contentType: normalized.contentType,
        byteSize: normalized.bytes.length, sha256: normalized.sha256, uploadLeaseId: null, uploadLeaseUntil: null,
        updatedAt: new Date(), lastErrorCode: null }).where(attachmentWhere(actor, noteId, attachmentId)).returning();
      return safeMyDeskAttachment(ready!);
    }, { allowDeleted: true });
  } catch (error) {
    // Operational cleanup must survive membership/rollout revocation. This can only requeue our already-reserved key;
    // it cannot return content, activate a note, or bypass the ownership tuple captured before this PUT.
    await runWithTenantContext({ schoolId: actor.schoolId }, () => db.transaction(async tx => {
      const [note] = await tx.select({ id: mydeskNotes.id }).from(mydeskNotes).where(ownedNoteWhere(actor, noteId)).for("update");
      if (!note) return;
      const [current] = await tx.select().from(mydeskAttachments).where(attachmentWhere(actor, noteId, attachmentId));
      if (!current) return;
      if (current.status === "deleted" || current.status === "delete_pending") {
        await tx.update(mydeskAttachments).set({ status: "delete_pending", nextCleanupAt: new Date(), updatedAt: new Date(), lastErrorCode: "late_upload" })
          .where(attachmentWhere(actor, noteId, attachmentId));
      } else if (current.status === "uploading" && current.uploadLeaseId === leaseId) {
        // Retain the lease deadline: a locally aborted PUT can still be settling remotely.
        await tx.update(mydeskAttachments).set({ status: "pending", uploadLeaseId: null, updatedAt: new Date(), lastErrorCode: "upload_failed" })
          .where(attachmentWhere(actor, noteId, attachmentId));
      }
    })).catch(() => undefined); // The durable reservation/tombstone is also reconciled by the worker after a process crash.
    throw error;
  }
}

export async function readMyDeskAttachment(actor: MyDeskActor, noteId: string, attachmentId: string, store: MyDeskObjectStore = myDeskObjectStore) {
  const readOwned = () => withMyDeskNoteLock(actor, noteId, async (tx, note) => {
    if (note.status !== "active") throw myDeskError(404, "not_found", "Attachment not found.");
    const [attachment] = await tx.select().from(mydeskAttachments)
      .where(and(attachmentWhere(actor, noteId, attachmentId), eq(mydeskAttachments.status, "ready"), isNotNull(mydeskAttachments.committedAt)));
    if (!attachment) throw myDeskError(404, "not_found", "Attachment not found.");
    return attachment;
  });
  const attachment = await readOwned();
  const bytes = await store.get(attachment.storageKey);
  // Deletion while the object was fetched must not deliver the stale bytes.
  await readOwned();
  return { bytes, contentType: attachment.contentType!, filename: attachment.originalFilename };
}

export async function deleteMyDeskAttachment(actor: MyDeskActor, noteId: string, attachmentId: string, revision: number) {
  return withMyDeskNoteLock(actor, noteId, async (tx, note) => {
    if (note.revision !== revision) throw myDeskError(409, "revision_conflict", "This note changed. Reload it before saving.");
    const [attachment] = await tx.select().from(mydeskAttachments).where(attachmentWhere(actor, noteId, attachmentId));
    if (!attachment || attachment.status === "deleted" || attachment.status === "delete_pending") throw myDeskError(404, "not_found", "Attachment not found.");
    if (note.status === "active") {
      const kept = await tx.select({ id: mydeskAttachments.id }).from(mydeskAttachments).where(and(attachmentWhere(actor, noteId),
        eq(mydeskAttachments.status, "ready"), isNotNull(mydeskAttachments.committedAt), sql`${mydeskAttachments.id} <> ${attachmentId}`));
      assertMyDeskNoteNonempty(note.title, note.body, kept.length);
    }
    await tx.update(mydeskAttachments).set({ status: "delete_pending", deletedAt: new Date(), nextCleanupAt: new Date(), updatedAt: new Date() })
      .where(attachmentWhere(actor, noteId, attachmentId));
    await tx.update(mydeskNotes).set({ revision: note.revision + 1, updatedAt: new Date() }).where(ownedNoteWhere(actor, noteId));
    return { revision: note.revision + 1 };
  });
}
