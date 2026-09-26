import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { groups, groupStudents, groupTeachers } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { mydeskNotes, mydeskAttachments } from "../schema/mydesk.js";
import { schoolDisciplineRecords as records, schoolDisciplineVersions as versions, schoolDisciplineAttachments as attachments,
  type DisciplineSnapshot } from "../schema/schoolDiscipline.js";
import { currentClassWhere, type MyDeskDatabase } from "./mydesk.js";
import { myDeskObjectStore, myDeskSha256, type MyDeskObjectStore } from "./mydeskFiles.js";
import { myDeskCsvCell } from "./mydeskValidation.js";
import { disciplineCorrectInput, disciplineSubmitInput, disciplineWithdrawInput, disciplineSearchInput, disciplineError,
  type DisciplineSearch, type DisciplineCorrect } from "./schoolDisciplineValidation.js";
import { withDiscipline, disciplineAudit, type DisciplineActor, type DisciplineIdentity } from "./schoolDisciplineAccess.js";

type RecordRow = typeof records.$inferSelect;
type Version = typeof versions.$inferSelect;
type Attachment = typeof attachments.$inferSelect;
type Evidence = Pick<Attachment, "storageKey" | "contentType" | "filename" | "byteSize" | "sha256"> & { id: string };
const LEASE_MS = 10 * 60_000;
let activeEvidenceCopies = 0;
const own = (actor: DisciplineActor, id: string) => and(eq(records.schoolId, actor.schoolId), eq(records.submittedBy, actor.authorId), eq(records.id, id));
const versionWhere = (schoolId: string, id: string) => and(eq(versions.schoolId, schoolId), eq(versions.id, id));
// PostgreSQL jsonb reorders object keys; request/source equality must survive a round trip.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
const hash = (value: unknown) => myDeskSha256(Buffer.from(JSON.stringify(canonical(value))));
const missing = () => disciplineError(404, "NOT_FOUND", "Discipline record not found");
const conflict = () => disciplineError(409, "REVISION_CONFLICT", "This record changed. Refresh before submitting");
const retryConflict = () => disciplineError(409, "REQUEST_CONFLICT", "This request identifier was already used for different content");

async function targetLabels(tx: MyDeskDatabase, actor: DisciplineIdentity, classId: string, studentId: string) {
  await tx.select({ id: groupTeachers.id }).from(groupTeachers).where(and(eq(groupTeachers.groupId, classId), eq(groupTeachers.teacherId, actor.authorId))).for("share");
  const [group] = await tx.select({ id: groups.id, name: groups.name }).from(groups).where(and(currentClassWhere(actor), eq(groups.id, classId))).for("share");
  if (!group) throw disciplineError(404, "CLASS_NOT_FOUND", "Choose a current authorized class");
  const [student] = await tx.select({ id: students.id, firstName: students.firstName, lastName: students.lastName }).from(students)
    .innerJoin(groupStudents, and(eq(groupStudents.studentId, students.id), eq(groupStudents.groupId, classId)))
    .where(and(eq(students.schoolId, actor.schoolId), eq(students.id, studentId), eq(students.status, "active"))).for("share");
  if (!student) throw disciplineError(404, "STUDENT_NOT_FOUND", "Choose a current student in this class");
  return { classId, className: group.name.slice(0, 500), studentId, studentName: `${student.firstName} ${student.lastName}`.trim().slice(0, 500) };
}
async function sourceNote(tx: MyDeskDatabase, actor: DisciplineIdentity, id: string, revision: number, ids: string[]) {
  const [note] = await tx.select().from(mydeskNotes).where(and(eq(mydeskNotes.schoolId, actor.schoolId), eq(mydeskNotes.authorId, actor.authorId),
    eq(mydeskNotes.id, id), eq(mydeskNotes.status, "active"), isNull(mydeskNotes.deletedAt))).for("update");
  if (!note) throw disciplineError(404, "SOURCE_NOT_FOUND", "Private source note not found");
  if (note.revision !== revision) throw disciplineError(409, "SOURCE_CHANGED", "The private note changed. Review its current contents before submitting");
  if (note.targetKind !== "student" || !note.filingGroupId || !note.filingStudentId) throw disciplineError(400, "STUDENT_NOTE_REQUIRED", "Choose a saved private student note");
  // Publication concerns the saved note, including historical filing labels. Do not
  // look up a current roster or reveal current labels for a formerly assigned class.
  const target = { classId: note.filingGroupId, className: note.groupName || "Past class", studentId: note.filingStudentId, studentName: note.studentName || "Former student" };
  const rows = ids.length ? await tx.select().from(mydeskAttachments).where(and(eq(mydeskAttachments.schoolId, actor.schoolId),
    eq(mydeskAttachments.authorId, actor.authorId), eq(mydeskAttachments.noteId, id), inArray(mydeskAttachments.id, ids),
    eq(mydeskAttachments.status, "ready"), isNotNull(mydeskAttachments.committedAt), isNull(mydeskAttachments.deletedAt))).for("share") : [];
  if (rows.length !== ids.length || rows.some(a => !a.sha256 || !a.byteSize || !a.contentType)) throw disciplineError(409, "EVIDENCE_CHANGED", "Selected evidence changed. Review the note again");
  const evidence: Evidence[] = rows.map(a => ({ id: a.id, storageKey: a.storageKey, filename: a.originalFilename, contentType: a.contentType!, byteSize: a.byteSize!, sha256: a.sha256! })).sort((a, b) => a.id.localeCompare(b.id));
  const snapshot: DisciplineSnapshot = { ...target, title: note.title, body: note.body, category: note.category, entryDate: note.entryDate };
  if (!snapshot.title.trim() && !snapshot.body.trim() && !evidence.length) throw disciplineError(400, "EMPTY", "Select text or at least one attachment");
  return { snapshot, evidence, fingerprint: hash([id, revision, snapshot, evidence.map(a => [a.id, a.sha256, a.contentType, a.byteSize])]) };
}
async function publishedEvidence(tx: MyDeskDatabase, actor: DisciplineActor, recordId: string, ids: string[]): Promise<Evidence[]> {
  if (!ids.length) return [];
  const rows = await tx.select({ attachment: attachments }).from(attachments).innerJoin(versions,
    and(eq(versions.id, attachments.versionId), eq(versions.schoolId, attachments.schoolId))).where(and(eq(attachments.schoolId, actor.schoolId),
      eq(versions.recordId, recordId), eq(versions.state, "published"), eq(attachments.status, "committed"), inArray(attachments.id, ids)));
  if (rows.length !== ids.length) throw disciplineError(404, "EVIDENCE_NOT_FOUND", "Selected evidence is not part of this record");
  return rows.map(({ attachment: a }) => ({ id: a.id, storageKey: a.storageKey, filename: a.filename, contentType: a.contentType, byteSize: a.byteSize, sha256: a.sha256 })).sort((a, b) => a.id.localeCompare(b.id));
}
async function reserveVersion(tx: MyDeskDatabase, actor: DisciplineIdentity, record: RecordRow, request: { clientRequestId: string; fingerprint: string;
  kind: string; reason?: string; snapshot: DisciplineSnapshot; evidence: Evidence[]; sourceNoteId?: string; sourceNoteRevision?: number; sourceFingerprint?: string }) {
  const [previous] = await tx.select().from(versions).where(and(eq(versions.schoolId, actor.schoolId), eq(versions.recordId, record.id), eq(versions.clientRequestId, request.clientRequestId))).for("update");
  if (previous) {
    if (previous.requestFingerprint !== request.fingerprint) throw retryConflict();
    if (previous.state === "published") return previous;
    if (previous.state === "abandoned") throw disciplineError(409, "REQUEST_EXPIRED", "This unfinished submission expired. Start a new reviewed submission");
    if (previous.leaseUntil && previous.leaseUntil > new Date()) throw disciplineError(409, "IN_PROGRESS", "This submission is still preparing. Retry shortly");
    if (previous.number !== record.revision + 1) throw conflict();
    if (hash(previous.snapshot) !== hash(request.snapshot) || previous.sourceFingerprint !== (request.sourceFingerprint ?? null)) throw disciplineError(409, "SOURCE_CHANGED", "The source changed. Review a new submission");
    const [claimed] = await tx.update(versions).set({ leaseId: randomUUID(), leaseUntil: new Date(Date.now() + LEASE_MS) }).where(versionWhere(actor.schoolId, previous.id)).returning();
    return claimed!;
  }
  const versionId = randomUUID(), leaseId = randomUUID(), leaseUntil = new Date(Date.now() + LEASE_MS);
  const [version] = await tx.insert(versions).values({ id: versionId, schoolId: actor.schoolId, recordId: record.id, number: record.revision + 1,
    kind: request.kind, clientRequestId: request.clientRequestId, requestFingerprint: request.fingerprint, snapshot: request.snapshot,
    reason: request.reason, sourceNoteId: request.sourceNoteId, sourceNoteRevision: request.sourceNoteRevision, sourceFingerprint: request.sourceFingerprint, leaseId, leaseUntil }).returning();
  for (const item of request.evidence) {
    const id = randomUUID();
    await tx.insert(attachments).values({ id, schoolId: actor.schoolId, versionId, storageKey: `mydesk/${actor.schoolId}/school-discipline/${record.id}/${versionId}/${id}`,
      sourceStorageKey: item.storageKey, sourceAttachmentId: item.id, filename: item.filename, contentType: item.contentType, byteSize: item.byteSize, sha256: item.sha256 });
  }
  return version!;
}
async function findReplay(tx: MyDeskDatabase, actor: DisciplineActor, recordId: string, clientRequestId: string, fingerprint: string) {
  const [existing] = await tx.select().from(versions).where(and(eq(versions.schoolId, actor.schoolId), eq(versions.recordId, recordId), eq(versions.clientRequestId, clientRequestId)));
  if (existing && existing.requestFingerprint !== fingerprint) throw retryConflict();
  return existing?.state === "published" ? existing : null;
}
export async function submitDisciplineRecord(actor: DisciplineActor, raw: unknown, store: MyDeskObjectStore = myDeskObjectStore) {
  const input = disciplineSubmitInput.parse(raw), fingerprint = hash(input);
  const reserved = await withDiscipline(actor, async (tx, identity) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`discipline-submit:${actor.schoolId}:${actor.authorId}:${input.clientRequestId}`},0))`);
    const [previous] = await tx.select().from(records).where(and(eq(records.schoolId, actor.schoolId), eq(records.submittedBy, actor.authorId), eq(records.clientRequestId, input.clientRequestId))).for("update");
    if (previous && previous.requestFingerprint !== fingerprint) throw retryConflict();
    if (previous) { const replay = await findReplay(tx, actor, previous.id, input.clientRequestId, fingerprint); if (replay) return { record: previous, version: replay, replay: true }; }
    const source = await sourceNote(tx, identity, input.noteId, input.noteRevision, input.attachmentIds);
    const record = previous ?? (await tx.insert(records).values({ schoolId: actor.schoolId, submittedBy: actor.authorId, submittedByName: identity.name,
      clientRequestId: input.clientRequestId, requestFingerprint: fingerprint, sourceNoteId: input.noteId }).returning())[0]!;
    const version = await reserveVersion(tx, identity, record, { clientRequestId: input.clientRequestId, fingerprint, kind: "submission", snapshot: source.snapshot, evidence: source.evidence,
      sourceNoteId: input.noteId, sourceNoteRevision: input.noteRevision, sourceFingerprint: source.fingerprint });
    return { record, version, replay: false };
  });
  if (!reserved.replay) await copyAndPublish(actor, reserved.record.id, reserved.version, store);
  return mutationResult(actor, reserved.record.id, reserved.version, !reserved.replay);
}
export async function correctDisciplineRecord(actor: DisciplineActor, recordId: string, raw: unknown, store: MyDeskObjectStore = myDeskObjectStore) {
  const input = disciplineCorrectInput.parse(raw), fingerprint = hash(input);
  const reserved = await withDiscipline(actor, async (tx, identity) => {
    const [record] = await tx.select().from(records).where(own(actor, recordId)).for("update");
    if (!record || !record.currentVersionId) throw missing();
    const replay = await findReplay(tx, actor, recordId, input.clientRequestId, fingerprint); if (replay) return { version: replay, replay: true };
    if (record.revision !== input.revision) throw conflict();
    const [current] = await tx.select().from(versions).where(versionWhere(actor.schoolId, record.currentVersionId));
    if (!current) throw missing();
    const target = current.snapshot.classId === input.groupId && current.snapshot.studentId === input.studentId
      ? { classId: current.snapshot.classId, className: current.snapshot.className, studentId: current.snapshot.studentId, studentName: current.snapshot.studentName }
      : await targetLabels(tx, identity, input.groupId, input.studentId);
    const source = input.sourceNoteId ? await sourceNote(tx, identity, input.sourceNoteId, input.sourceNoteRevision!, input.attachmentIds) : null;
    if (source && (source.snapshot.studentId !== input.studentId || source.snapshot.classId !== input.groupId)) throw disciplineError(400, "EVIDENCE_TARGET", "Replacement evidence must come from a private note for this student and class");
    const evidence = source?.evidence ?? await publishedEvidence(tx, actor, recordId, input.attachmentIds);
    if (!input.title.trim() && !input.body.trim() && !evidence.length) throw disciplineError(400, "EMPTY", "Add text or select evidence");
    const snapshot = { ...target, title: input.title, body: input.body, category: input.category, entryDate: input.entryDate };
    const version = await reserveVersion(tx, identity, record, { clientRequestId: input.clientRequestId, fingerprint, kind: "correction", reason: input.reason,
      snapshot, evidence, sourceNoteId: input.sourceNoteId, sourceNoteRevision: input.sourceNoteRevision, sourceFingerprint: source?.fingerprint });
    return { version, replay: false };
  });
  if (!reserved.replay) await copyAndPublish(actor, recordId, reserved.version, store);
  return mutationResult(actor, recordId, reserved.version, !reserved.replay);
}

async function copyAndPublish(actor: DisciplineActor, recordId: string, version: Version, store: MyDeskObjectStore) {
  let admitted = false;
  try {
    if (activeEvidenceCopies >= 2) throw disciplineError(429, "COPY_BUSY", "Other evidence is preparing. Retry this submission shortly");
    activeEvidenceCopies++; admitted = true;
    const pending = await withDiscipline(actor, tx => tx.select().from(attachments).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, version.id))));
    for (const attachment of pending) {
      if (attachment.status === "ready") continue;
      if (!version.leaseUntil || Date.now() + 90_000 >= version.leaseUntil.getTime()) throw disciplineError(409, "COPY_TIMEOUT", "Evidence preparation timed out. Retry this submission");
      // Reserve before any storage write. Database connections are released for all byte I/O.
      await withDiscipline(actor, async tx => {
        const [record] = await tx.select().from(records).where(own(actor, recordId)).for("update");
        const [current] = await tx.select().from(versions).where(versionWhere(actor.schoolId, version.id)).for("update");
        if (!record || !current || current.state !== "preparing" || current.leaseId !== version.leaseId) throw conflict();
        await tx.update(attachments).set({ leaseUntil: version.leaseUntil }).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.id, attachment.id), eq(attachments.status, "pending")));
      });
      if (!attachment.sourceStorageKey) throw disciplineError(409, "EVIDENCE_UNAVAILABLE", "Selected evidence is no longer available");
      const bytes = await store.get(attachment.sourceStorageKey);
      if (bytes.length !== attachment.byteSize || myDeskSha256(bytes) !== attachment.sha256) throw disciplineError(409, "EVIDENCE_CHANGED", "Selected evidence changed. Review it before submitting");
      await store.put(attachment.storageKey, bytes, attachment.contentType);
      await withDiscipline(actor, async tx => {
        const [record] = await tx.select().from(records).where(own(actor, recordId)).for("update");
        const [current] = await tx.select().from(versions).where(versionWhere(actor.schoolId, version.id)).for("update");
        if (!record || !current || current.state !== "preparing" || current.leaseId !== version.leaseId) throw conflict();
        await tx.update(attachments).set({ status: "ready" }).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.id, attachment.id), eq(attachments.status, "pending")));
      });
    }
    await withDiscipline(actor, async (tx, identity) => {
      const [record] = await tx.select().from(records).where(own(actor, recordId)).for("update");
      const [current] = await tx.select().from(versions).where(versionWhere(actor.schoolId, version.id)).for("update");
      if (!record || !current || current.state !== "preparing" || current.leaseId !== version.leaseId || record.revision + 1 !== current.number
        || !current.leaseUntil || current.leaseUntil <= new Date()) throw conflict();
      const files = await tx.select().from(attachments).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, version.id))).for("update");
      if (files.length > 5 || files.some(a => a.status !== "ready")) throw disciplineError(409, "EVIDENCE_INCOMPLETE", "Evidence is still preparing. Retry this submission");
      if (current.sourceNoteId) {
        const source = await sourceNote(tx, identity, current.sourceNoteId, current.sourceNoteRevision!, files.map(a => a.sourceAttachmentId!));
        if (source.fingerprint !== current.sourceFingerprint) throw disciplineError(409, "SOURCE_CHANGED", "The private note changed during preparation. Review a new submission");
      }
      if (current.kind === "correction") {
        const [previous] = await tx.select().from(versions).where(versionWhere(actor.schoolId, record.currentVersionId!));
        if (!previous) throw missing();
        if (previous.snapshot.studentId !== current.snapshot.studentId || previous.snapshot.classId !== current.snapshot.classId) {
          const target = await targetLabels(tx, identity, current.snapshot.classId, current.snapshot.studentId);
          if (target.className !== current.snapshot.className || target.studentName !== current.snapshot.studentName) throw disciplineError(409, "ROSTER_CHANGED", "The student or class changed. Review the correction again");
        }
      }
      await tx.update(attachments).set({ status: "committed", sourceStorageKey: null, sourceAttachmentId: null, leaseUntil: null })
        .where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, version.id)));
      await tx.update(versions).set({ state: "published", publishedAt: new Date(), leaseId: null, leaseUntil: null }).where(versionWhere(actor.schoolId, version.id));
      await tx.update(records).set({ status: "submitted", currentVersionId: version.id, revision: current.number, updatedAt: new Date() }).where(own(actor, recordId));
      await disciplineAudit(tx, actor, current.kind === "submission" ? "submitted" : "corrected", recordId, { versionId: version.id, revision: current.number, attachmentCount: files.length });
    });
  } catch (error) {
    // No privileged content access: this only releases the already-issued lease.
    // A failed or revoked operation remains traceable for unconditional worker cleanup.
    const { default: db } = await import("../db.js"); const { runWithTenantContext } = await import("../middleware/tenantContext.js");
    await runWithTenantContext({ schoolId: actor.schoolId }, () => db.update(versions).set({ leaseId: null, leaseUntil: null }).where(and(
      versionWhere(actor.schoolId, version.id), eq(versions.state, "preparing"), eq(versions.leaseId, version.leaseId!)))).catch(() => undefined);
    if (error instanceof Error && "code" in error && String(error.code).startsWith("DISCIPLINE_")) throw error;
    throw disciplineError(503, "COPY_FAILED", "Evidence preparation failed. Your private note is unchanged; retry this submission");
  } finally { if (admitted) activeEvidenceCopies--; }
}

export async function withdrawDisciplineRecord(actor: DisciplineActor, recordId: string, raw: unknown) {
  const input = disciplineWithdrawInput.parse(raw), fingerprint = hash(input);
  const version = await withDiscipline(actor, async tx => {
    const [record] = await tx.select().from(records).where(own(actor, recordId)).for("update");
    if (!record || !record.currentVersionId) throw missing();
    const replay = await findReplay(tx, actor, recordId, input.clientRequestId, fingerprint); if (replay) return replay;
    if (record.revision !== input.revision) throw conflict();
    if (record.status === "withdrawn") throw disciplineError(409, "ALREADY_WITHDRAWN", "This record is already withdrawn");
    const [current] = await tx.select().from(versions).where(versionWhere(actor.schoolId, record.currentVersionId));
    if (!current) throw missing();
    const [withdrawal] = await tx.insert(versions).values({ schoolId: actor.schoolId, recordId, number: record.revision + 1, kind: "withdrawal", state: "published",
      clientRequestId: input.clientRequestId, requestFingerprint: fingerprint, reason: input.reason, snapshot: current.snapshot, publishedAt: new Date() }).returning();
    await tx.update(records).set({ status: "withdrawn", currentVersionId: withdrawal!.id, revision: withdrawal!.number, updatedAt: new Date() }).where(own(actor, recordId));
    await disciplineAudit(tx, actor, "withdrawn", recordId, { versionId: withdrawal!.id, revision: withdrawal!.number });
    return withdrawal!;
  });
  return mutationResult(actor, recordId, version, false);
}
const safeAttachment = (a: Attachment) => ({ id: a.id, filename: a.filename, contentType: a.contentType, byteSize: a.byteSize });
function safeVersion(v: Version, files: Attachment[], currentId: string | null) {
  return { id: v.id, number: v.number, kind: v.kind, status: v.kind === "withdrawal" ? "withdrawn" : v.id === currentId ? "current" : "superseded",
    reason: v.reason, createdAt: v.publishedAt || v.createdAt, ...v.snapshot, attachments: files.filter(a => a.versionId === v.id && a.status === "committed").map(safeAttachment) };
}
function safeRecord(record: RecordRow, actor: DisciplineActor, version: Version, files: Attachment[]) {
  const author = record.submittedBy === actor.authorId;
  return { id: record.id, status: record.status, revision: record.revision, submittedBy: { id: record.submittedBy, name: record.submittedByName },
    createdAt: record.createdAt, updatedAt: record.updatedAt, canCorrect: author, canWithdraw: author && record.status === "submitted",
    ...(author ? { sourceNoteId: record.sourceNoteId } : {}), currentVersion: safeVersion(version, files, record.currentVersionId) };
}
async function readableRecord(tx: MyDeskDatabase, actor: DisciplineIdentity, id: string) {
  const [record] = await tx.select().from(records).where(and(eq(records.schoolId, actor.schoolId), eq(records.id, id),
    inArray(records.status, ["submitted", "withdrawn"]), actor.canViewSchool ? undefined : eq(records.submittedBy, actor.authorId))).for("share");
  if (!record || !record.currentVersionId) throw missing(); return record;
}
export async function getDisciplineRecord(actor: DisciplineActor, id: string, beforeVersion?: number) {
  return withDiscipline(actor, async (tx, identity) => {
    const record = await readableRecord(tx, identity, id);
    const rows = await tx.select().from(versions).where(and(eq(versions.schoolId, actor.schoolId), eq(versions.recordId, id), eq(versions.state, "published"),
      beforeVersion ? sql`${versions.number}<${beforeVersion}` : undefined)).orderBy(desc(versions.number)).limit(101);
    const page = rows.slice(0, 100);
    const current = page.find(v => v.id === record.currentVersionId) ?? (await tx.select().from(versions).where(versionWhere(actor.schoolId, record.currentVersionId!)))[0]!;
    const ids = [...new Set([...page.map(v => v.id), current.id])];
    const files = await tx.select().from(attachments).where(and(eq(attachments.schoolId, actor.schoolId), inArray(attachments.versionId, ids), eq(attachments.status, "committed")));
    await disciplineAudit(tx, actor, "viewed", id, { versionCount: page.length });
    return { ...safeRecord(record, actor, current, files), versions: page.map(v => safeVersion(v, files, record.currentVersionId)),
      nextVersionsCursor: rows.length > 100 ? page[page.length - 1]!.number : null };
  });
}
async function mutationResult(actor: DisciplineActor, id: string, version: Version, created: boolean) {
  return { record: await getDisciplineRecord(actor, id), created, receipt: { recordId: id, versionId: version.id, revision: version.number } };
}
function searchConditions(actor: DisciplineIdentity, query: DisciplineSearch): SQL[] {
  if (query.scope === "school" && !actor.canViewSchool) throw disciplineError(403, "VIEW_ACCESS_REQUIRED", "School discipline access is required");
  const where: SQL[] = [eq(records.schoolId, actor.schoolId), eq(versions.schoolId, actor.schoolId), eq(versions.state, "published"), inArray(records.status, ["submitted", "withdrawn"])];
  if (query.scope === "own") where.push(eq(records.submittedBy, actor.authorId));
  if (query.status !== "all") where.push(eq(records.status, query.status));
  if (query.studentId) where.push(sql`${versions.snapshot}->>'studentId'=${query.studentId}`);
  if (query.submitterId) where.push(eq(records.submittedBy, query.submitterId));
  if (query.sourceNoteId) where.push(eq(records.sourceNoteId, query.sourceNoteId));
  if (query.category) where.push(sql`${versions.snapshot}->>'category'=${query.category}`);
  if (query.from) where.push(sql`${versions.snapshot}->>'entryDate'>=${query.from}`);
  if (query.to) where.push(sql`${versions.snapshot}->>'entryDate'<=${query.to}`);
  const pattern = (value: string) => `%${value.replace(/[\\%_]/g, x => "\\" + x)}%`;
  if (query.studentName) where.push(sql`${versions.snapshot}->>'studentName' ILIKE ${pattern(query.studentName)}`);
  if (query.submitterName) where.push(sql`${records.submittedByName} ILIKE ${pattern(query.submitterName)}`);
  if (query.q) where.push(sql`(${versions.snapshot}->>'title' ILIKE ${pattern(query.q)} OR ${versions.snapshot}->>'body' ILIKE ${pattern(query.q)})`);
  return where;
}
async function list(tx: MyDeskDatabase, actor: DisciplineIdentity, query: DisciplineSearch) {
  const where = searchConditions(actor, query), fingerprint = hash([actor.schoolId, actor.authorId, { ...query, cursor: undefined, limit: undefined }]);
  if (query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!cursor || cursor.fingerprint !== fingerprint || typeof cursor.id !== "string" || cursor.id.length > 128 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at)) throw new Error();
      where.push(sql`(${records.createdAt},${records.id})<(${cursor.at}::timestamptz,${cursor.id})`);
    } catch { throw disciplineError(400, "INVALID_CURSOR", "Refresh the record list to start a new page"); }
  }
  const rows = await tx.select({ record: records, version: versions,
    at: sql<string>`to_char(${records.createdAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(records)
    .innerJoin(versions, eq(versions.id, records.currentVersionId)).where(and(...where)).orderBy(desc(records.createdAt), desc(records.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit), ids = page.map(r => r.version.id);
  const files = ids.length ? await tx.select().from(attachments).where(and(eq(attachments.schoolId, actor.schoolId), inArray(attachments.versionId, ids), eq(attachments.status, "committed"))) : [];
  const last = page[page.length - 1];
  return { records: page.map(r => safeRecord(r.record, actor, r.version, files)),
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ fingerprint, id: last.record.id, at: last.at })).toString("base64url") : null };
}
export async function searchDisciplineRecords(actor: DisciplineActor, raw: unknown) {
  const query = disciplineSearchInput.parse(raw);
  return withDiscipline(actor, async (tx, identity) => { const result = await list(tx, identity, query);
    await disciplineAudit(tx, actor, "listed", undefined, { scope: query.scope, count: result.records.length }); return result; });
}
export async function exportDisciplineRecords(actor: DisciplineActor, raw: unknown) {
  const query = disciplineSearchInput.parse(raw);
  return withDiscipline(actor, async (tx, identity) => {
    const rows: Awaited<ReturnType<typeof list>>["records"] = []; let cursor: string | undefined;
    do { const page = await list(tx, identity, { ...query, cursor, limit: 100 }); rows.push(...page.records); cursor = page.nextCursor || undefined;
      if (rows.length > 5000 || rows.length === 5000 && cursor) throw disciplineError(422, "EXPORT_LIMIT", "More than 5,000 records match. Narrow your filters and export again");
    } while (cursor);
    const evidenceLinks = (record: (typeof rows)[number]) => record.currentVersion.attachments.map(file => {
      const production = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
      let base: URL;
      try { base = new URL(process.env.PUBLIC_BASE_URL || process.env.CLIENT_URL || (production ? "" : "http://localhost:5173")); }
      catch { throw disciplineError(503, "EXPORT_UNAVAILABLE", "The record export URL is not configured"); }
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || production && base.protocol !== "https:") throw disciplineError(503, "EXPORT_UNAVAILABLE", "The record export URL is not configured");
      const url = new URL(`/api/classpilot/discipline-records/${encodeURIComponent(record.id)}/versions/${encodeURIComponent(record.currentVersion.id)}/attachments/${encodeURIComponent(file.id)}/content`, base.origin);
      url.searchParams.set("schoolId", actor.schoolId); return url.href;
    }).join(" ");
    const csv = [["record_id", "status", "version", "entry_date", "student", "class", "submitted_by", "category", "title", "body", "correction_or_withdrawal_reason", "submitted_at", "evidence"],
      ...rows.map(r => [r.id, r.status, r.revision, r.currentVersion.entryDate, r.currentVersion.studentName, r.currentVersion.className,
        r.submittedBy.name, r.currentVersion.category, r.currentVersion.title, r.currentVersion.body, r.currentVersion.reason, r.createdAt.toISOString(), evidenceLinks(r)])]
      .map(row => row.map(myDeskCsvCell).join(",")).join("\r\n");
    await disciplineAudit(tx, actor, "exported", undefined, { scope: query.scope, rowCount: rows.length });
    return { csv: "\uFEFF" + csv + "\r\n", rowCount: rows.length };
  }, false, true);
}
export async function readDisciplineAttachment(actor: DisciplineActor, recordId: string, versionId: string, attachmentId: string, store: MyDeskObjectStore = myDeskObjectStore) {
  const check = (audit = false) => withDiscipline(actor, async (tx, identity) => {
    await readableRecord(tx, identity, recordId);
    const [row] = await tx.select({ attachment: attachments }).from(attachments).innerJoin(versions,
      and(eq(versions.schoolId, attachments.schoolId), eq(versions.id, attachments.versionId))).where(and(eq(attachments.schoolId, actor.schoolId),
      eq(attachments.id, attachmentId), eq(versions.id, versionId), eq(versions.recordId, recordId), eq(versions.state, "published"), eq(attachments.status, "committed")));
    if (!row) throw missing(); if (audit) await disciplineAudit(tx, actor, "attachment.downloaded", recordId, { versionId, attachmentId }); return row.attachment;
  });
  const file = await check(), bytes = await store.get(file.storageKey);
  await check(true); // Role/grant revocation while fetching bytes cannot deliver them.
  if (bytes.length !== file.byteSize || myDeskSha256(bytes) !== file.sha256) throw disciplineError(503, "EVIDENCE_UNAVAILABLE", "This evidence is temporarily unavailable");
  return { bytes, contentType: file.contentType };
}
