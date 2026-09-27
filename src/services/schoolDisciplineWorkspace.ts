import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { schools } from "../schema/core.js";
import { localDateInTimeZone } from "../util/schoolTime.js";
import { myDeskGradeSql, normalizeMyDeskGrade } from "./mydeskGrade.js";
import { students } from "../schema/students.js";
import { groups, groupStudents } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { datePlusDays, isSchedulingDate } from "./classpilotSchedulingRules.js";
import { schoolDisciplineRecords as records, schoolDisciplineVersions as versions, schoolDisciplineAttachments as attachments,
  type DisciplineSnapshot } from "../schema/schoolDiscipline.js";
import type { MyDeskDatabase } from "./mydesk.js";
import { assertSharedStudentAccess, sharedStudentWhere, type SharedStudentIdentity } from "./sharedStudentRecords.js";
import { withDiscipline, disciplineAudit, type DisciplineActor, type DisciplineIdentity } from "./schoolDisciplineAccess.js";
import { disciplineDraftInput, disciplineDraftUpdateInput, disciplineFinalizeInput, disciplineAttachmentInput, disciplineDraftCancelInput,
  disciplineStudentsInput, disciplineError, type DisciplineDraft, type DisciplineStudentsQuery } from "./schoolDisciplineValidation.js";
import { myDeskObjectStore, myDeskSha256, normalizeMyDeskFile, validateMyDeskFileMetadata, MYDESK_UPLOAD_LEASE_MS,
  type MyDeskObjectStore } from "./mydeskFiles.js";
import { disciplineSnapshotFlags, getDisciplineRecord, searchDisciplineRecords } from "./schoolDiscipline.js";
import { myDeskCsvCell } from "./mydeskValidation.js";

const hash = (input: unknown) => myDeskSha256(Buffer.from(JSON.stringify(input)));
const missing = () => disciplineError(404, "NOT_FOUND", "Discipline record not found");
const conflict = () => disciplineError(409, "REVISION_CONFLICT", "This draft changed. Refresh and review before saving");
const parentWhere = (actor: DisciplineActor, id: string) => and(eq(records.schoolId, actor.schoolId), eq(records.id, id));
const versionWhere = (actor: DisciplineActor, id: string) => and(eq(versions.schoolId, actor.schoolId), eq(versions.id, id));
const assetWhere = (actor: DisciplineActor, id: string) => and(eq(attachments.schoolId, actor.schoolId), eq(attachments.id, id));
const safeFile = (file: typeof attachments.$inferSelect) => ({ id: file.id, filename: file.filename, contentType: file.contentType, byteSize: file.byteSize, status: file.status });

async function directSnapshot(tx: MyDeskDatabase, identity: SharedStudentIdentity, input: Omit<DisciplineDraft, "clientRequestId">): Promise<DisciplineSnapshot> {
  const student = await assertSharedStudentAccess(tx, identity, input.studentId, { lock: true });
  let classId: string | null = null, className: string | null = null, schoolYear: string | null = null;
  if (input.groupId) {
    const [group] = await tx.select({ id: groups.id, name: groups.name, schoolYear: groups.schoolYear }).from(groups).innerJoin(groupStudents, eq(groupStudents.groupId, groups.id))
      .where(and(eq(groups.id, input.groupId), eq(groups.schoolId, identity.schoolId), eq(groups.status, "active"), eq(groups.groupType, "admin_class"),
        eq(groupStudents.studentId, input.studentId), identity.manager ? undefined : sql`(${groups.teacherId}=${identity.authorId} OR EXISTS(SELECT 1 FROM group_teachers gt WHERE gt.group_id=${groups.id} AND gt.teacher_id=${identity.authorId} AND gt.role IN ('primary','co-teacher')))`)).for("share");
    if (!group) throw disciplineError(404, "CLASS_NOT_FOUND", "Choose a current school-managed class you teach");
    classId = group.id; className = group.name; schoolYear = group.schoolYear;
  }
  if (!input.detentionAssigned && input.detentionDates.length) throw disciplineError(400, "DETENTION_DATES", "Detention dates require an assigned detention");
  return { schemaVersion: 2, studentId: student.id, studentName: student.name, gradeLevel: student.gradeLevel, schoolYear, classId, className,
    category: input.category, title: input.title, body: input.body, entryDate: input.entryDate,
    referralRecorded: input.referralRecorded, detentionAssigned: input.detentionAssigned, detentionDates: [...new Set(input.detentionDates)].sort() };
}

async function lockedDraft(tx: MyDeskDatabase, identity: DisciplineIdentity, id: string) {
  const [record] = await tx.select().from(records).where(and(parentWhere(identity, id), eq(records.submittedBy, identity.authorId))).for("update");
  if (!record || record.status !== "pending") throw missing();
  const [version] = await tx.select().from(versions).where(and(eq(versions.schoolId, identity.schoolId), eq(versions.recordId, id), eq(versions.number, 1), eq(versions.state, "preparing"))).for("update");
  if (!version || record.createdAt.getTime() + 24 * 60 * 60_000 <= Date.now()) throw disciplineError(410, "DRAFT_EXPIRED", "This unfinished draft expired. Start a new entry");
  await assertSharedStudentAccess(tx, identity, version.snapshot.studentId, { lock: true });
  return { record, version };
}
const draftDto = (record: typeof records.$inferSelect, version: typeof versions.$inferSelect, files: (typeof attachments.$inferSelect)[]) => ({
  id: record.id, revision: record.draftRevision, expiresAt: new Date(record.createdAt.getTime() + 24 * 60 * 60_000),
  ...version.snapshot, attachments: files.filter(file => !file.sourceAttachmentId && !["delete_pending", "deleted"].includes(file.status)).map(safeFile),
});
async function draftFiles(tx: MyDeskDatabase, actor: DisciplineActor, versionId: string) {
  return tx.select().from(attachments).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, versionId))).orderBy(attachments.createdAt, attachments.id);
}
async function filingClasses(tx: MyDeskDatabase, identity: SharedStudentIdentity, studentIds: string[]) {
  if (!studentIds.length) return [];
  return tx.select({ studentId: groupStudents.studentId, id: groups.id, name: groups.name })
    .from(groups).innerJoin(groupStudents, eq(groupStudents.groupId, groups.id))
    .where(and(eq(groups.schoolId, identity.schoolId), eq(groups.status, "active"), eq(groups.groupType, "admin_class"),
      inArray(groupStudents.studentId, studentIds), identity.manager ? undefined : sql`(${groups.teacherId}=${identity.authorId} OR EXISTS(SELECT 1 FROM group_teachers gt WHERE gt.group_id=${groups.id} AND gt.teacher_id=${identity.authorId} AND gt.role IN ('primary','co-teacher')))`)).orderBy(groups.name, groups.id);
}

export async function readDisciplineDraftAttachment(actor: DisciplineActor, id: string, attachmentId: string, store: MyDeskObjectStore = myDeskObjectStore) {
  const check = () => withDiscipline(actor, async (tx, identity) => {
    const { version } = await lockedDraft(tx, identity, id);
    const [file] = await tx.select().from(attachments).where(and(assetWhere(actor, attachmentId), eq(attachments.versionId, version.id), eq(attachments.status, "ready"), isNull(attachments.sourceAttachmentId)));
    if (!file) throw missing();
    return file;
  });
  const file = await check(), bytes = await store.get(file.storageKey);
  const current = await check();
  if (current.sha256 !== file.sha256 || bytes.length !== file.byteSize || myDeskSha256(bytes) !== file.sha256)
    throw disciplineError(503, "EVIDENCE_UNAVAILABLE", "This form is temporarily unavailable");
  return { bytes, contentType: file.contentType };
}

export async function createDisciplineDraft(actor: DisciplineActor, raw: unknown) {
  const input = disciplineDraftInput.parse(raw), fingerprint = hash(input);
  return withDiscipline(actor, async (tx, identity) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`discipline-submit:${actor.schoolId}:${actor.authorId}:${input.clientRequestId}`},0))`);
    const [prior] = await tx.select().from(records).where(and(eq(records.schoolId, actor.schoolId), eq(records.submittedBy, actor.authorId), eq(records.clientRequestId, input.clientRequestId))).for("update");
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw disciplineError(409, "REQUEST_CONFLICT", "This request identifier was already used for different content");
      if (prior.status === "submitted") {
        const [current] = await tx.select().from(versions).where(and(eq(versions.id, prior.currentVersionId!), eq(versions.schoolId, identity.schoolId), eq(versions.state, "published")));
        if (!current) throw missing();
        if (!identity.manager) await assertSharedStudentAccess(tx, identity, current.snapshot.studentId, { lock: true });
        return { created: false, receipt: { recordId: prior.id }, draft: null };
      }
      const draft = await lockedDraft(tx, identity, prior.id);
      return { created: false, draft: draftDto(draft.record, draft.version, await draftFiles(tx, actor, draft.version.id)) };
    }
    const snapshot = await directSnapshot(tx, identity, input);
    const [record] = await tx.insert(records).values({ schoolId: actor.schoolId, submittedBy: actor.authorId, submittedByName: identity.name,
      clientRequestId: input.clientRequestId, requestFingerprint: fingerprint }).returning();
    const [version] = await tx.insert(versions).values({ schoolId: actor.schoolId, recordId: record!.id, number: 1, kind: "submission",
      clientRequestId: input.clientRequestId, requestFingerprint: fingerprint, snapshot, createdBy: actor.authorId }).returning();
    await disciplineAudit(tx, actor, "draft.created", record!.id);
    return { created: true, draft: draftDto(record!, version!, []) };
  }, true);
}
export const getDisciplineDraft = (actor: DisciplineActor, id: string) => withDiscipline(actor, async (tx, identity) => {
  const { record, version } = await lockedDraft(tx, identity, id); return { draft: draftDto(record, version, await draftFiles(tx, actor, version.id)) };
});
export async function updateDisciplineDraft(actor: DisciplineActor, id: string, raw: unknown) {
  const input = disciplineDraftUpdateInput.parse(raw), fingerprint = hash(input);
  return withDiscipline(actor, async (tx, identity) => {
    const { record, version } = await lockedDraft(tx, identity, id);
    const prior = record.draftReceipts.find(receipt => receipt.id === input.clientRequestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw disciplineError(409, "REQUEST_CONFLICT", "This request identifier was already used");
      return { draft: draftDto(record, version, await draftFiles(tx, actor, version.id)) };
    }
    if (record.draftRevision !== input.revision) throw conflict();
    const snapshot = await directSnapshot(tx, identity, input);
    const [saved] = await tx.update(versions).set({ snapshot }).where(versionWhere(actor, version.id)).returning();
    const revision = record.draftRevision + 1;
    const [parent] = await tx.update(records).set({ draftRevision: revision, updatedAt: new Date(),
      draftReceipts: [...record.draftReceipts, { id: input.clientRequestId, fingerprint, revision }].slice(-100) }).where(parentWhere(actor, id)).returning();
    return { draft: draftDto(parent!, saved!, await draftFiles(tx, actor, version.id)) };
  }, true);
}

export async function duplicateCandidates(tx: MyDeskDatabase, identity: SharedStudentIdentity, studentId: string, entryDate: string,
  options: { excludeRecordId?: string; evidenceHashes?: string[] } = {}) {
  await assertSharedStudentAccess(tx, identity, studentId, { allowInactiveForAdmin: true });
  const hashMatches = options.evidenceHashes?.length ? sql`OR EXISTS(SELECT 1 FROM school_discipline_attachments duplicate_asset WHERE duplicate_asset.school_id=${identity.schoolId}
    AND duplicate_asset.version_id=${versions.id} AND duplicate_asset.status='committed' AND duplicate_asset.sha256 IN (${sql.join(options.evidenceHashes.map(value => sql`${value}`), sql`, `)}))` : sql``;
  const found = await tx.select({ id: records.id, revision: records.revision, submittedBy: records.submittedBy, snapshot: versions.snapshot })
    .from(records).innerJoin(versions, and(eq(versions.schoolId, records.schoolId), eq(versions.id, records.currentVersionId)))
    .where(and(eq(records.schoolId, identity.schoolId), eq(records.status, "submitted"), eq(versions.state, "published"),
      sql`${versions.snapshot}->>'studentId'=${studentId}`, options.excludeRecordId ? ne(records.id, options.excludeRecordId) : undefined,
      sql`(${versions.snapshot}->>'entryDate'=${entryDate} ${hashMatches})`)).orderBy(records.id).limit(101);
  if (found.length > 100) throw disciplineError(422, "DUPLICATE_LIMIT", "Too many possible matches. Review this student's existing records before adding another");
  return found.map(row => ({ id: row.id, revision: row.revision, entryDate: row.snapshot.entryDate, title: row.snapshot.title,
    ...disciplineSnapshotFlags(row.snapshot), canAddEvidence: identity.manager || row.submittedBy === identity.authorId }));
}
export const getDisciplineDuplicates = (actor: DisciplineActor, id: string) => withDiscipline(actor, async (tx, identity) => {
  const { version } = await lockedDraft(tx, identity, id), files = await draftFiles(tx, actor, version.id);
  return { candidates: await duplicateCandidates(tx, identity, version.snapshot.studentId, version.snapshot.entryDate,
    { excludeRecordId: id, evidenceHashes: files.filter(file => file.status === "ready").map(file => file.sha256) }) };
});

export async function reserveDisciplineAttachment(actor: DisciplineActor, id: string, raw: unknown) {
  const input = disciplineAttachmentInput.parse(raw);
  validateMyDeskFileMetadata(input.contentType, input.size);
  return withDiscipline(actor, async (tx, identity) => {
    const { record, version } = await lockedDraft(tx, identity, id);
    const files = await draftFiles(tx, actor, version.id), prior = files.find(file => file.clientRequestId === input.clientRequestId);
    if (prior) {
      if (prior.filename !== input.filename || prior.inputSha256 !== input.sha256 || prior.inputContentType !== input.contentType || prior.inputByteSize !== input.size)
        throw disciplineError(409, "REQUEST_CONFLICT", "This upload identifier was already used for another file");
      return { attachment: safeFile(prior), revision: record.draftRevision };
    }
    if (record.draftRevision !== input.revision) throw conflict();
    if (files.filter(file => !["delete_pending", "deleted"].includes(file.status)).length >= 5) throw disciplineError(422, "ATTACHMENT_LIMIT", "A record can contain at most five attachments");
    const attachmentId = randomUUID();
    const [file] = await tx.insert(attachments).values({ id: attachmentId, schoolId: actor.schoolId, versionId: version.id,
      storageKey: `mydesk/${actor.schoolId}/school-discipline/${id}/${version.id}/${attachmentId}`, clientRequestId: input.clientRequestId,
      filename: input.filename, contentType: input.contentType, byteSize: input.size, sha256: input.sha256,
      inputSha256: input.sha256, inputContentType: input.contentType, inputByteSize: input.size }).returning();
    // Reserving changes reviewable evidence and therefore invalidates draft review.
    const revision = record.draftRevision + 1; await tx.update(records).set({ draftRevision: revision, updatedAt: new Date() }).where(parentWhere(actor, id));
    return { attachment: safeFile(file!), revision };
  }, true);
}
export async function uploadDisciplineAttachment(actor: DisciplineActor, id: string, attachmentId: string, bytes: Buffer, contentType: string, store: MyDeskObjectStore = myDeskObjectStore) {
  validateMyDeskFileMetadata(contentType, bytes.length);
  const inputHash = myDeskSha256(bytes), leaseId = randomUUID();
  const reserved = await withDiscipline(actor, async (tx, identity) => {
    const { version } = await lockedDraft(tx, identity, id);
    const [file] = await tx.select().from(attachments).where(and(assetWhere(actor, attachmentId), eq(attachments.versionId, version.id))).for("update");
    if (!file || !["pending", "uploading", "ready"].includes(file.status)) throw missing();
    if (file.inputSha256 !== inputHash || file.inputByteSize !== bytes.length || file.inputContentType !== contentType) throw disciplineError(409, "UPLOAD_MISMATCH", "Upload the originally selected file");
    if (file.status === "ready") return { file, ready: true };
    if (file.leaseUntil && file.leaseUntil > new Date()) throw disciplineError(409, "UPLOAD_IN_PROGRESS", "This file is still uploading. Retry shortly");
    const [claimed] = await tx.update(attachments).set({ status: "uploading", uploadLeaseId: leaseId, leaseUntil: new Date(Date.now() + MYDESK_UPLOAD_LEASE_MS) }).where(assetWhere(actor, attachmentId)).returning();
    return { file: claimed!, ready: false };
  }, true);
  if (reserved.ready) return { attachment: safeFile(reserved.file) };
  try {
    const normalized = await normalizeMyDeskFile(bytes, contentType);
    // The key is durable before object I/O; late writes stay cleanup-owned.
    await store.put(reserved.file.storageKey, normalized.bytes, normalized.contentType);
    return await withDiscipline(actor, async (tx, identity) => {
      await lockedDraft(tx, identity, id);
      const [file] = await tx.select().from(attachments).where(assetWhere(actor, attachmentId)).for("update");
      if (!file || file.status !== "uploading" || file.uploadLeaseId !== leaseId || !file.leaseUntil || file.leaseUntil <= new Date()) throw conflict();
      const [ready] = await tx.update(attachments).set({ status: "ready", sha256: normalized.sha256, byteSize: normalized.bytes.length,
        contentType: normalized.contentType, uploadLeaseId: null, leaseUntil: null }).where(assetWhere(actor, attachmentId)).returning();
      return { attachment: safeFile(ready!) };
    }, true);
  } catch (error) {
    // Expiry/cancellation cleanup does not depend on this release succeeding.
    await withDiscipline(actor, async tx => {
      await tx.update(attachments).set({ status: "pending", uploadLeaseId: null, leaseUntil: null }).where(and(assetWhere(actor, attachmentId), eq(attachments.status, "uploading"), eq(attachments.uploadLeaseId, leaseId)));
    }).catch(() => undefined);
    throw error;
  }
}

export async function finalizeDisciplineDraft(actor: DisciplineActor, id: string, raw: unknown, store: MyDeskObjectStore = myDeskObjectStore) {
  const input = disciplineFinalizeInput.parse(raw), fingerprint = hash(input);
  if (input.duplicateAction === "add_evidence") return addDraftEvidence(actor, id, input, fingerprint, store);
  const receipt = await withDiscipline(actor, async (tx, identity) => {
    const [parent] = await tx.select().from(records).where(and(parentWhere(actor, id), eq(records.submittedBy, actor.authorId))).for("update");
    if (!parent) throw missing();
    const replay = parent.draftReceipts.find(row => row.id === input.clientRequestId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw disciplineError(409, "REQUEST_CONFLICT", "This request identifier was already used");
      const [published] = await tx.select().from(versions).where(and(eq(versions.schoolId, actor.schoolId), eq(versions.recordId, replay.recordId || id), eq(versions.number, replay.revision), eq(versions.state, "published")));
      if (!published) throw missing();
      await assertSharedStudentAccess(tx, identity, published.snapshot.studentId, { lock: true, allowInactiveForAdmin: true });
      return { recordId: replay.recordId || id, versionId: published.id, revision: published.number };
    }
    const { record, version } = await lockedDraft(tx, identity, id);
    if (record.draftRevision !== input.revision) throw conflict();
    const files = await draftFiles(tx, actor, version.id), chosen = files.filter(file => input.attachmentIds.includes(file.id));
    if (chosen.length !== input.attachmentIds.length || chosen.some(file => file.status !== "ready")) throw disciplineError(409, "EVIDENCE_INCOMPLETE", "Finish uploading selected evidence before saving");
    if (files.some(file => file.status === "uploading")) throw disciplineError(409, "UPLOAD_IN_PROGRESS", "Wait for active uploads before saving");
    if (!version.snapshot.title.trim() && !version.snapshot.body.trim() && !chosen.length) throw disciplineError(400, "EMPTY", "Add a factual summary or evidence");
    const matches = await duplicateCandidates(tx, identity, version.snapshot.studentId, version.snapshot.entryDate, { excludeRecordId: id, evidenceHashes: chosen.map(file => file.sha256) });
    if (JSON.stringify(matches.map(match => [match.id, match.revision]).sort()) !== JSON.stringify(input.acknowledgedDuplicates.map(match => [match.id, match.revision]).sort()))
      throw disciplineError(409, "DUPLICATE_REVIEW_REQUIRED", "Review possible existing incidents before saving this as a separate incident");
    const now = new Date();
    if (chosen.length) await tx.update(attachments).set({ status: "committed", sourceStorageKey: null, sourceAttachmentId: null, leaseUntil: null })
      .where(and(eq(attachments.schoolId, actor.schoolId), inArray(attachments.id, chosen.map(file => file.id))));
    const omitted = files.filter(file => !input.attachmentIds.includes(file.id) && !["deleted", "delete_pending"].includes(file.status));
    if (omitted.length) await tx.update(attachments).set({ status: "delete_pending", nextCleanupAt: now }).where(and(eq(attachments.schoolId, actor.schoolId), inArray(attachments.id, omitted.map(file => file.id))));
    await tx.update(versions).set({ state: "published", publishedAt: now }).where(versionWhere(actor, version.id));
    await tx.update(records).set({ status: "submitted", revision: 1, currentVersionId: version.id, updatedAt: now,
      draftReceipts: [...record.draftReceipts, { id: input.clientRequestId, fingerprint, revision: 1 }].slice(-100) }).where(parentWhere(actor, id));
    await disciplineAudit(tx, actor, "submitted", id, { versionId: version.id, revision: 1, attachmentCount: chosen.length, duplicateCount: matches.length });
    return { recordId: id, versionId: version.id, revision: 1 };
  }, true);
  return { receipt, record: await getDisciplineRecord(actor, id) };
}
export async function cancelDisciplineDraft(actor: DisciplineActor, id: string, raw: unknown) {
  const input = disciplineDraftCancelInput.parse(raw);
  return withDiscipline(actor, async (tx, identity) => {
    const [prior] = await tx.select().from(records).where(and(parentWhere(actor, id), eq(records.submittedBy, actor.authorId))).for("update");
    if (prior?.status === "abandoned" && prior.draftReceipts.some(row => row.id === input.clientRequestId && row.fingerprint === hash(input))) return { cancelled: true };
    const { record, version } = await lockedDraft(tx, identity, id);
    if (record.draftRevision !== input.revision) throw conflict();
    await tx.update(versions).set({ state: "abandoned", snapshot: {} as DisciplineSnapshot }).where(versionWhere(actor, version.id));
    await tx.update(attachments).set({ status: "delete_pending", nextCleanupAt: new Date() }).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, version.id), inArray(attachments.status, ["pending", "uploading", "ready"])));
    await tx.update(records).set({ status: "abandoned", submittedByName: "", draftReceipts: [...record.draftReceipts, { id: input.clientRequestId, fingerprint: hash(input), revision: record.draftRevision }].slice(-100) }).where(parentWhere(actor, id));
    await disciplineAudit(tx, actor, "draft.cancelled", id); return { cancelled: true };
  }, true);
}

async function summaryRange(tx: MyDeskDatabase, actor: DisciplineActor, query: DisciplineStudentsQuery) {
  if (query.period === "all") return { from: query.from, to: query.to, period: "all" };
  if (query.period === "custom") {
    if (!query.from || !query.to) throw disciplineError(400, "DATE_RANGE_REQUIRED", "Choose the beginning and end of the date range");
    return { from: query.from, to: query.to, period: "custom" };
  }
  const [schedule] = await tx.select({ config: classpilotSchoolSchedules.config }).from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, actor.schoolId));
  const from = schedule?.config?.yearStart, to = schedule?.config?.yearEnd;
  if (!isSchedulingDate(from) || !isSchedulingDate(to) || to < from || to > datePlusDays(from, 550))
    return { from: undefined, to: undefined, period: "all", noticeCode: "SCHOOL_YEAR_NOT_CONFIGURED",
      notice: "A valid school year date range is not configured. Showing all dates." };
  const configuredSchoolYear = { from, to };
  const [school] = await tx.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, actor.schoolId));
  const today = localDateInTimeZone(new Date(), school?.timezone || "America/New_York");
  if (today < from || today > to)
    return { from: undefined, to: undefined, period: "all", noticeCode: "SCHOOL_YEAR_OUTSIDE_RANGE", configuredSchoolYear,
      notice: `The configured school year (${from} to ${to}) does not include today. Showing all dates.` };
  return { from, to, period: "school_year", configuredSchoolYear };
}
function studentSummaryWhere(identity: DisciplineIdentity, query: DisciplineStudentsQuery): SQL[] {
  if (query.scope === "school" && !identity.manager) throw disciplineError(403, "VIEW_ACCESS_REQUIRED", "School discipline access is required");
  const scoped = query.scope === "assigned" ? { ...identity, manager: false } : identity;
  const conditions = [scoped.manager && query.includeInactive ? eq(students.schoolId, identity.schoolId) : sharedStudentWhere(scoped, { includeInactive: identity.manager && query.includeInactive })];
  if (query.gradeLevel) conditions.push(["UNCLASSIFIED", "unrecorded"].includes(query.gradeLevel) ? sql`${myDeskGradeSql(students.gradeLevel)} IS NULL` : sql`${myDeskGradeSql(students.gradeLevel)}=${normalizeMyDeskGrade(query.gradeLevel)}`);
  if (query.q) conditions.push(sql`(${students.firstName} || ' ' || ${students.lastName}) ILIKE ${`%${query.q.replace(/[\\%_]/g, value => "\\" + value)}%`}`);
  if (query.groupId) conditions.push(sql`EXISTS(SELECT 1 FROM group_students gm JOIN groups g ON g.id=gm.group_id WHERE gm.student_id=${students.id}
    AND g.school_id=${identity.schoolId} AND g.id=${query.groupId} AND g.status='active' AND g.group_type='admin_class'
    ${scoped.manager ? sql`` : sql`AND (g.teacher_id=${identity.authorId} OR EXISTS(SELECT 1 FROM group_teachers gt WHERE gt.group_id=g.id AND gt.teacher_id=${identity.authorId} AND gt.role IN ('primary','co-teacher')))`})`);
  return conditions;
}
async function summaryPage(tx: MyDeskDatabase, identity: DisciplineIdentity, query: DisciplineStudentsQuery) {
  const range = await summaryRange(tx, identity, query), conditions = studentSummaryWhere(identity, query);
  const fingerprint = hash([identity.schoolId, identity.authorId, { ...query, cursor: undefined, limit: undefined }, range]);
  if (query.cursor) {
    try {
      const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (value.fingerprint !== fingerprint || ![value.lastName, value.firstName, value.id].every(v => typeof v === "string" && v.length <= 500)) throw new Error();
      conditions.push(sql`(${students.lastName},${students.firstName},${students.id}) > (${value.lastName},${value.firstName},${value.id})`);
    } catch { throw disciplineError(400, "INVALID_CURSOR", "Refresh the student list to start a new page"); }
  }
  // Deleted enrollment rows must not erase school-owned incident history. Only
  // administrators explicitly requesting former students use saved labels here.
  const directory = identity.manager && query.scope === "school" && query.includeInactive ? sql`(
    SELECT id, school_id, first_name, last_name, grade_level, status FROM students WHERE school_id=${identity.schoolId}
    UNION ALL
    (SELECT DISTINCT ON (v.snapshot->>'studentId') v.snapshot->>'studentId' AS id, r.school_id,
      '' AS first_name, v.snapshot->>'studentName' AS last_name, v.snapshot->>'gradeLevel' AS grade_level, 'deleted' AS status
    FROM school_discipline_records r JOIN school_discipline_versions v ON v.id=r.current_version_id AND v.school_id=r.school_id
    WHERE r.school_id=${identity.schoolId} AND r.status IN ('submitted','withdrawn') AND v.state='published'
      AND NOT EXISTS(SELECT 1 FROM students s WHERE s.id=v.snapshot->>'studentId' AND s.school_id=r.school_id)
    ORDER BY v.snapshot->>'studentId', r.updated_at DESC, r.id DESC)
  ) AS students` : students;
  const page = await tx.select({ id: sql<string>`${students.id}`, firstName: sql<string>`${students.firstName}`, lastName: sql<string>`${students.lastName}`,
    gradeLevel: sql<string | null>`${students.gradeLevel}`, status: sql<string>`${students.status}` })
    .from(directory).where(and(...conditions)).orderBy(asc(students.lastName), asc(students.firstName), asc(students.id)).limit(query.limit + 1);
  const selected = page.slice(0, query.limit);
  const classes = await filingClasses(tx, query.scope === "assigned" ? { ...identity, manager: false } : identity, selected.filter(student => student.status === "active").map(student => student.id));
  const counts = selected.length ? await tx.select({ studentId: sql<string>`${versions.snapshot}->>'studentId'`, latestIncident: sql<string | null>`max(${versions.snapshot}->>'entryDate')`, incidents: sql<number>`count(*)::int`,
    referrals: sql<number>`count(*) FILTER(WHERE CASE WHEN ${versions.snapshot} ? 'referralRecorded' THEN ${versions.snapshot}->>'referralRecorded'='true' ELSE ${versions.snapshot}->>'category'='referral' END)::int`,
    detentions: sql<number>`count(*) FILTER(WHERE CASE WHEN ${versions.snapshot} ? 'detentionAssigned' THEN ${versions.snapshot}->>'detentionAssigned'='true' ELSE ${versions.snapshot}->>'category'='detention' END)::int` })
    .from(records).innerJoin(versions, and(eq(versions.schoolId, records.schoolId), eq(versions.id, records.currentVersionId)))
    .where(and(eq(records.schoolId, identity.schoolId), eq(records.status, "submitted"), eq(versions.state, "published"),
      sql`${versions.snapshot}->>'studentId' IN (${sql.join(selected.map(student => sql`${student.id}`), sql`, `)})`,
      range.from ? sql`${versions.snapshot}->>'entryDate'>=${range.from}` : undefined, range.to ? sql`${versions.snapshot}->>'entryDate'<=${range.to}` : undefined,
      query.incidentType ? query.incidentType === "referral" ? sql`CASE WHEN ${versions.snapshot} ? 'referralRecorded' THEN ${versions.snapshot}->>'referralRecorded'='true' ELSE ${versions.snapshot}->>'category'='referral' END` : sql`CASE WHEN ${versions.snapshot} ? 'detentionAssigned' THEN ${versions.snapshot}->>'detentionAssigned'='true' ELSE ${versions.snapshot}->>'category'='detention' END` : undefined,
      query.submitterId ? eq(records.submittedBy, query.submitterId) : undefined,
      query.submitterName ? sql`${records.submittedByName} ILIKE ${`%${query.submitterName.replace(/[\\%_]/g, value => "\\" + value)}%`}` : undefined))
    .groupBy(sql`${versions.snapshot}->>'studentId'`) : [];
  const last = selected.at(-1);
  return { students: selected.map(student => { const count = counts.find(value => value.studentId === student.id); return { ...student,
    name: `${student.firstName} ${student.lastName}`.trim(), classes: classes.filter(group => group.studentId === student.id).map(({ id, name }) => ({ id, name })), gradeLevel: normalizeMyDeskGrade(student.gradeLevel), latestIncident: count?.latestIncident || null, incidentCount: count?.incidents || 0, referralCount: count?.referrals || 0, detentionCount: count?.detentions || 0 }; }), range,
    nextCursor: page.length > query.limit && last ? Buffer.from(JSON.stringify({ fingerprint, lastName: last.lastName, firstName: last.firstName, id: last.id })).toString("base64url") : null };
}
export const listDisciplineStudents = (actor: DisciplineActor, raw: unknown) => withDiscipline(actor, (tx, identity) => summaryPage(tx, identity, disciplineStudentsInput.parse(raw)), false, true);
export async function getDisciplineStudent(actor: DisciplineActor, studentId: string, raw: unknown = {}) {
  const query = disciplineStudentsInput.parse(raw);
  const context = await withDiscipline(actor, async (tx, identity) => {
    let student;
    try { student = await assertSharedStudentAccess(tx, identity, studentId, { allowInactiveForAdmin: true }); }
    catch (error) {
      if (!identity.manager || query.scope !== "school" || !query.includeInactive) throw error;
      const [historical] = await tx.select({ snapshot: versions.snapshot }).from(records)
        .innerJoin(versions, and(eq(versions.id, records.currentVersionId), eq(versions.schoolId, records.schoolId)))
        .where(and(eq(records.schoolId, actor.schoolId), inArray(records.status, ["submitted", "withdrawn"]), eq(versions.state, "published"), sql`${versions.snapshot}->>'studentId'=${studentId}`))
        .orderBy(desc(records.updatedAt), desc(records.id)).limit(1);
      if (!historical) throw error;
      student = { id: studentId, firstName: "", lastName: historical.snapshot.studentName, name: historical.snapshot.studentName,
        gradeLevel: historical.snapshot.gradeLevel || null, status: "deleted" };
    }
    const classes = student.status === "active" ? await filingClasses(tx, query.scope === "assigned" ? { ...identity, manager: false } : identity, [student.id]) : [];
    return { student: { ...student, classes: classes.map(({ id, name }) => ({ id, name })) }, range: await summaryRange(tx, actor, query) };
  });
  const result = await searchDisciplineRecords(actor, { scope: query.scope, studentId, from: context.range.from, to: context.range.to, incidentType: query.incidentType, submitterId: query.submitterId, submitterName: query.submitterName, cursor: query.cursor, limit: query.limit });
  return { ...context, ...result };
}
export const exportDisciplineStudentSummary = (actor: DisciplineActor, raw: unknown) => withDiscipline(actor, async (tx, identity) => {
  const query = disciplineStudentsInput.parse(raw), rows: Awaited<ReturnType<typeof summaryPage>>["students"] = [];
  let cursor: string | undefined;
  do { const page = await summaryPage(tx, identity, { ...query, cursor, limit: 100 }); rows.push(...page.students); cursor = page.nextCursor || undefined;
    if (rows.length > 5000 || rows.length === 5000 && cursor) throw disciplineError(422, "EXPORT_LIMIT", "More than 5,000 students match. Narrow the filters");
  } while (cursor);
  const csv = [["student_id", "student", "grade", "incidents", "referrals", "detentions_assigned"],
    ...rows.map(row => [row.id, row.name, row.gradeLevel, row.incidentCount, row.referralCount, row.detentionCount])].map(row => row.map(myDeskCsvCell).join(",")).join("\r\n");
  await disciplineAudit(tx, actor, "summary.exported", undefined, { rowCount: rows.length }); return { csv: "\uFEFF" + csv + "\r\n", rowCount: rows.length };
}, false, true);

export type DisciplinePreparedAsset = { id: string; storageKey: string; contentType: string; sha256: string; byteSize: number; sourceAttachmentId?: string; existingAttachmentId?: string };
export async function listAuthorisedRetainedEvidence(tx: MyDeskDatabase, identity: SharedStudentIdentity, recordId: string, revision: number) {
  const [record] = await tx.select().from(records).where(parentWhere(identity, recordId)).for("update");
  if (!record || record.status !== "submitted" || !record.currentVersionId || (!identity.manager && record.submittedBy !== identity.authorId)) throw missing();
  if (record.revision !== revision) throw disciplineError(409, "REVISION_CONFLICT", "The existing incident changed. Review it again");
  const [version] = await tx.select().from(versions).where(versionWhere(identity, record.currentVersionId));
  if (!version) throw missing();
  if (!identity.manager) await assertSharedStudentAccess(tx, identity, version.snapshot.studentId, { lock: true });
  const files = await tx.select().from(attachments).where(and(eq(attachments.schoolId, identity.schoolId), eq(attachments.versionId, version.id), eq(attachments.status, "committed"))).orderBy(attachments.id).for("share");
  return files.map(file => ({ id: file.id, storageKey: file.storageKey, contentType: file.contentType, sha256: file.sha256, byteSize: file.byteSize }));
}
export type ImportedDisciplineInput = { runId: string; itemId: string; studentId: string; groupId: string | null; entryDate: string; title: string; body: string;
  incident: { referral: boolean; detentionAssignment: { dates: string[]; details?: string } | null };
  asset: DisciplinePreparedAsset; retainedAssets?: DisciplinePreparedAsset[]; additionalAssets?: DisciplinePreparedAsset[];
  duplicateDecision?: { action: "separate" | "add_evidence"; recordId?: string; revision?: number; reason?: string; candidateIds?: string[]; candidateRevisions?: Array<{ id: string; revision: number }> } };
/** Caller owns the import transaction and must transfer every returned asset under the same locks. */
export async function publishImportedDiscipline(tx: MyDeskDatabase, actor: SharedStudentIdentity, input: ImportedDisciplineInput) {
  const identity: DisciplineIdentity = { ...actor, canViewSchool: actor.manager };
  const fingerprint = hash(input);
  const target = input.duplicateDecision?.action === "add_evidence" ? input.duplicateDecision.recordId : undefined;
  const [replay] = await tx.select({ version: versions, record: records }).from(versions).innerJoin(records, and(eq(records.id, versions.recordId), eq(records.schoolId, versions.schoolId)))
    .where(and(eq(versions.schoolId, identity.schoolId), eq(versions.createdBy, identity.authorId), eq(versions.clientRequestId, input.itemId), eq(versions.state, "published"))).limit(1);
  if (replay) {
    if (replay.version.requestFingerprint !== fingerprint) throw disciplineError(409, "REQUEST_CONFLICT", "This import item was already saved differently");
    await assertSharedStudentAccess(tx, identity, replay.version.snapshot.studentId, { lock: true, allowInactiveForAdmin: true });
    const files = await draftFiles(tx, identity, replay.version.id);
    const mappings = [input.asset, ...(input.additionalAssets || []), ...(input.retainedAssets || [])].map(asset => ({ assetId: asset.id, attachmentId: files.find(file => file.storageKey === asset.storageKey)?.id }));
    if (mappings.some(mapping => !mapping.attachmentId)) throw disciplineError(409, "EVIDENCE_CHANGED", "Saved import evidence is unavailable");
    return { recordId: replay.record.id, versionId: replay.version.id, attachmentId: mappings[0]!.attachmentId!,
      promotedAttachmentIds: mappings.map(mapping => ({ assetId: mapping.assetId, attachmentId: mapping.attachmentId! })) };
  }
  const snapshot = await directSnapshot(tx, identity, { studentId: input.studentId, groupId: input.groupId, entryDate: input.entryDate,
    title: input.title, body: input.body, category: input.incident.referral ? "referral" : input.incident.detentionAssignment ? "detention" : "other",
    referralRecorded: input.incident.referral, detentionAssigned: input.incident.detentionAssignment !== null, detentionDates: input.incident.detentionAssignment?.dates || [] });
  if (!snapshot.title.trim() && !snapshot.body.trim() && !input.asset) throw disciplineError(400, "EMPTY", "Add a factual summary or form");
  const candidates = await duplicateCandidates(tx, identity, input.studentId, input.entryDate, { evidenceHashes: [input.asset.sha256] });
  const decided = input.duplicateDecision;
  if (candidates.length && (!decided || JSON.stringify(candidates.map(candidate => [candidate.id, candidate.revision]).sort()) !== JSON.stringify((decided.candidateRevisions || []).map(candidate => [candidate.id, candidate.revision]).sort())))
    throw disciplineError(409, "DUPLICATE_REVIEW_REQUIRED", "Possible existing incidents changed. Review duplicate suggestions again");
  let record: typeof records.$inferSelect, finalSnapshot = snapshot, retained: DisciplinePreparedAsset[] = [];
  if (decided?.action === "add_evidence") {
    if (!target || decided.revision === undefined || !decided.reason?.trim()) throw disciplineError(400, "CORRECTION_REASON_REQUIRED", "Choose the existing incident and explain the added evidence");
    const original = await listAuthorisedRetainedEvidence(tx, identity, target, decided.revision);
    const [existing] = await tx.select().from(records).where(parentWhere(identity, target));
    const [current] = await tx.select().from(versions).where(versionWhere(identity, existing!.currentVersionId!));
    if (current!.snapshot.studentId !== input.studentId) throw disciplineError(409, "EVIDENCE_TARGET", "The form and existing incident must concern the same student");
    retained = input.retainedAssets || [];
    if (retained.length !== original.length || original.some(file => !retained.some(copy => copy.sourceAttachmentId === file.id && copy.sha256 === file.sha256 && copy.byteSize === file.byteSize && copy.contentType === file.contentType)))
      throw disciplineError(409, "EVIDENCE_CHANGED", "Existing evidence changed during preparation");
    record = existing!;
    // Adding a second form is one incident. Counts and assigned consequences are
    // preserved; changing them is a separately reviewed correction.
    finalSnapshot = current!.snapshot;
  } else {
    [record] = await tx.insert(records).values({ schoolId: actor.schoolId, submittedBy: actor.authorId, submittedByName: actor.name,
      clientRequestId: input.itemId, requestFingerprint: fingerprint }).returning() as [typeof records.$inferSelect];
  }
  const allAssets = [...retained, input.asset, ...(input.additionalAssets || [])];
  if (allAssets.length > 5 || new Set(allAssets.map(asset => asset.storageKey)).size !== allAssets.length) throw disciplineError(422, "ATTACHMENT_LIMIT", "An incident supports at most five distinct forms");
  const [version] = await tx.insert(versions).values({ schoolId: actor.schoolId, recordId: record.id, number: record.revision + 1,
    kind: target ? "correction" : "submission", state: "published", clientRequestId: input.itemId, requestFingerprint: fingerprint,
    snapshot: finalSnapshot, createdBy: actor.authorId, reason: target ? decided!.reason!.trim() : null, publishedAt: new Date() }).returning();
  const promotedAttachmentIds: Array<{ assetId: string; attachmentId: string }> = [];
  for (const asset of allAssets) {
    if (!asset.storageKey.startsWith(`mydesk/${actor.schoolId}/`) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1 || asset.byteSize > 10485760)
      throw disciplineError(409, "EVIDENCE_INVALID", "Prepared evidence is invalid");
    if (asset.existingAttachmentId) {
      const [staged] = await tx.select({ file: attachments, record: records, version: versions }).from(attachments)
        .innerJoin(versions, and(eq(versions.schoolId, attachments.schoolId), eq(versions.id, attachments.versionId)))
        .innerJoin(records, and(eq(records.schoolId, versions.schoolId), eq(records.id, versions.recordId)))
        .where(and(assetWhere(actor, asset.existingAttachmentId), eq(records.submittedBy, actor.authorId), eq(records.status, "pending"), eq(versions.state, "preparing"), eq(attachments.status, "ready"))).for("update");
      if (!staged || staged.file.storageKey !== asset.storageKey || staged.file.sha256 !== asset.sha256 || staged.file.byteSize !== asset.byteSize || staged.file.contentType !== asset.contentType)
        throw disciplineError(409, "EVIDENCE_CHANGED", "Prepared draft evidence changed");
      await tx.update(attachments).set({ versionId: version!.id, status: "committed", sourceStorageKey: null, sourceAttachmentId: null, leaseUntil: null }).where(assetWhere(actor, asset.existingAttachmentId));
      promotedAttachmentIds.push({ assetId: asset.id, attachmentId: asset.existingAttachmentId });
    } else {
      const [file] = await tx.insert(attachments).values({ schoolId: actor.schoolId, versionId: version!.id, storageKey: asset.storageKey,
        filename: asset.contentType === "application/pdf" ? "reviewed-form.pdf" : "reviewed-form.jpg", contentType: asset.contentType, byteSize: asset.byteSize, sha256: asset.sha256, status: "committed" }).returning();
      promotedAttachmentIds.push({ assetId: asset.id, attachmentId: file!.id });
    }
  }
  await tx.update(records).set({ status: "submitted", revision: version!.number, currentVersionId: version!.id, updatedAt: new Date() }).where(parentWhere(actor, record.id));
  await disciplineAudit(tx, actor, target ? "import.evidence_added" : "import.submitted", record.id, { importId: input.runId, itemId: input.itemId, versionId: version!.id, attachmentCount: allAssets.length });
  return { recordId: record.id, versionId: version!.id, attachmentId: promotedAttachmentIds.find(value => value.assetId === input.asset.id)!.attachmentId, promotedAttachmentIds };
}

let activeDraftCopies = 0;
async function addDraftEvidence(actor: DisciplineActor, id: string, input: ReturnType<typeof disciplineFinalizeInput.parse>, fingerprint: string, store: MyDeskObjectStore) {
  const targetId = input.existingRecordId!, targetRevision = input.existingRevision!;
  const existingReceipt = await withDiscipline(actor, async (tx, identity) => {
    const [record] = await tx.select().from(records).where(and(parentWhere(actor, id), eq(records.submittedBy, actor.authorId)));
    const receipt = record?.draftReceipts.find(row => row.id === input.clientRequestId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || !receipt.recordId || !receipt.versionId) throw disciplineError(409, "REQUEST_CONFLICT", "This request identifier was already used");
    const [version] = await tx.select().from(versions).where(versionWhere(actor, receipt.versionId));
    if (!version) throw missing();
    await assertSharedStudentAccess(tx, identity, version.snapshot.studentId, { allowInactiveForAdmin: true });
    return { recordId: receipt.recordId, versionId: receipt.versionId, revision: receipt.revision };
  });
  if (existingReceipt) return { receipt: existingReceipt, record: await getDisciplineRecord(actor, existingReceipt.recordId) };
  if (activeDraftCopies >= 2) throw disciplineError(429, "COPY_BUSY", "Other evidence is preparing. Retry shortly");
  activeDraftCopies++;
  try {
    const prepared = await withDiscipline(actor, async (tx, identity) => {
      const { record, version } = await lockedDraft(tx, identity, id);
      if (record.draftRevision !== input.revision) throw conflict();
      const selected = (await draftFiles(tx, actor, version.id)).filter(file => input.attachmentIds.includes(file.id));
      if (!selected.length || selected.length !== input.attachmentIds.length || selected.some(file => file.status !== "ready" || file.sourceAttachmentId))
        throw disciplineError(409, "EVIDENCE_INCOMPLETE", "Select successfully uploaded new evidence");
      const originals = await listAuthorisedRetainedEvidence(tx, identity, targetId, targetRevision);
      if (originals.length + selected.length > 5) throw disciplineError(422, "ATTACHMENT_LIMIT", "The existing incident and selected files exceed five attachments");
      const copies: Array<{ id: string; source: typeof originals[number] }> = [];
      for (const original of originals) {
        const digest = hash([input.clientRequestId, original.id]);
        const clientRequestId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
        const [prior] = await tx.select().from(attachments).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, version.id), eq(attachments.clientRequestId, clientRequestId)));
        if (prior) {
          if (prior.sourceAttachmentId !== original.id || prior.sha256 !== original.sha256 || !["pending", "ready"].includes(prior.status)) throw disciplineError(409, "EVIDENCE_CHANGED", "Retained evidence changed");
          copies.push({ id: prior.id, source: original }); continue;
        }
        const copyId = randomUUID();
        await tx.insert(attachments).values({ id: copyId, schoolId: actor.schoolId, versionId: version.id, clientRequestId,
          storageKey: `mydesk/${actor.schoolId}/school-discipline/${id}/${version.id}/${copyId}`,
          sourceAttachmentId: original.id, sourceStorageKey: original.storageKey, filename: "retained-form", contentType: original.contentType, byteSize: original.byteSize, sha256: original.sha256 });
        copies.push({ id: copyId, source: original });
      }
      return { copies };
    }, true);
    for (const copy of prepared.copies) {
      const file = await withDiscipline(actor, async (tx, identity) => {
        const { record } = await lockedDraft(tx, identity, id); if (record.draftRevision !== input.revision) throw conflict();
        await listAuthorisedRetainedEvidence(tx, identity, targetId, targetRevision);
        const [row] = await tx.select().from(attachments).where(assetWhere(actor, copy.id)).for("update");
        if (!row || !["pending", "ready"].includes(row.status)) throw conflict();
        if (row.status === "pending") await tx.update(attachments).set({ leaseUntil: new Date(Date.now() + MYDESK_UPLOAD_LEASE_MS) }).where(assetWhere(actor, row.id));
        return row;
      }, true);
      if (file.status === "ready") continue;
      const bytes = await store.get(copy.source.storageKey);
      if (bytes.length !== copy.source.byteSize || myDeskSha256(bytes) !== copy.source.sha256) throw disciplineError(409, "EVIDENCE_CHANGED", "Existing evidence changed during preparation");
      await store.put(file.storageKey, bytes, file.contentType);
      await withDiscipline(actor, async (tx, identity) => {
        const { record } = await lockedDraft(tx, identity, id); if (record.draftRevision !== input.revision) throw conflict();
        await tx.update(attachments).set({ status: "ready", leaseUntil: null }).where(and(assetWhere(actor, file.id), eq(attachments.status, "pending")));
      }, true);
    }
    const receipt = await withDiscipline(actor, async (tx, identity) => {
      const { record, version } = await lockedDraft(tx, identity, id); if (record.draftRevision !== input.revision) throw conflict();
      const files = await draftFiles(tx, actor, version.id), selected = files.filter(file => input.attachmentIds.includes(file.id));
      if (selected.length !== input.attachmentIds.length || selected.some(file => file.status !== "ready")) throw conflict();
      const retained = prepared.copies.map(copy => {
        const file = files.find(row => row.id === copy.id); if (!file || file.status !== "ready") throw conflict();
        return { id: file.id, existingAttachmentId: file.id, storageKey: file.storageKey, contentType: file.contentType,
          sha256: file.sha256, byteSize: file.byteSize, sourceAttachmentId: copy.source.id };
      });
      const newAssets = selected.map(file => ({ id: file.id, existingAttachmentId: file.id, storageKey: file.storageKey,
        contentType: file.contentType, sha256: file.sha256, byteSize: file.byteSize }));
      const flags = disciplineSnapshotFlags(version.snapshot);
      const result = await publishImportedDiscipline(tx, identity, { runId: id, itemId: input.clientRequestId, studentId: version.snapshot.studentId,
        groupId: version.snapshot.classId, entryDate: version.snapshot.entryDate, title: version.snapshot.title, body: version.snapshot.body,
        incident: { referral: flags.referralRecorded, detentionAssignment: flags.detentionAssigned ? { dates: flags.detentionDates } : null },
        asset: newAssets[0]!, additionalAssets: newAssets.slice(1), retainedAssets: retained,
        duplicateDecision: { action: "add_evidence", recordId: targetId, revision: targetRevision, reason: input.reason, candidateIds: input.acknowledgedDuplicateIds, candidateRevisions: input.acknowledgedDuplicates } });
      await tx.update(versions).set({ state: "abandoned", snapshot: {} as DisciplineSnapshot }).where(versionWhere(actor, version.id));
      await tx.update(attachments).set({ status: "delete_pending", nextCleanupAt: new Date() }).where(and(eq(attachments.schoolId, actor.schoolId), eq(attachments.versionId, version.id), inArray(attachments.status, ["pending", "uploading", "ready"])));
      await tx.update(records).set({ status: "abandoned", submittedByName: "", draftReceipts: [...record.draftReceipts,
        { id: input.clientRequestId, fingerprint, revision: targetRevision + 1, recordId: result.recordId, versionId: result.versionId }].slice(-100) }).where(parentWhere(actor, id));
      return { recordId: result.recordId, versionId: result.versionId, revision: targetRevision + 1 };
    }, true);
    return { receipt, record: await getDisciplineRecord(actor, receipt.recordId) };
  } finally { activeDraftCopies--; }
}
