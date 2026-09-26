import { createHash } from "node:crypto";
import { and, desc, eq, getTableColumns, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { schoolMemberships, schools, users } from "../schema/core.js";
import { groups, groupStudents, groupTeachers } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { mydeskNotes, mydeskAttachments } from "../schema/mydesk.js";
import { mydeskSeatingCharts } from "../schema/mydeskSeating.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { logAudit } from "./audit.js";
import { createLocalDateFormatter } from "../util/schoolTime.js";
import { myDeskCsvCell, myDeskEnabledForSchool, myDeskSeatingEnabledForSchool, type MyDeskCreateInput, type MyDeskNotesQuery, type MyDeskPatch } from "./mydeskValidation.js";
import type { MyDeskActor } from "../middleware/requireMyDesk.js";

export type { MyDeskActor } from "../middleware/requireMyDesk.js";
export type MyDeskDatabase = Pick<typeof db, "select" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute">;
export type MyDeskNote = typeof mydeskNotes.$inferSelect;
export type MyDeskAttachment = typeof mydeskAttachments.$inferSelect;
export const myDeskError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code, expose: true });
const missingNote = () => myDeskError(404, "MYDESK_NOTE_NOT_FOUND", "Note not found");
export const ownedNoteWhere = (actor: MyDeskActor, id?: string): SQL => and(
  eq(mydeskNotes.schoolId, actor.schoolId), eq(mydeskNotes.authorId, actor.authorId), id ? eq(mydeskNotes.id, id) : undefined,
)!;
const attachmentWhere = (actor: MyDeskActor, noteId: string): SQL => and(
  eq(mydeskAttachments.schoolId, actor.schoolId), eq(mydeskAttachments.authorId, actor.authorId), eq(mydeskAttachments.noteId, noteId),
)!;

/** School and membership locks precede the note lock on every write. */
export async function assertMyDeskActor(actor: MyDeskActor, database: MyDeskDatabase = db): Promise<MyDeskActor> {
  if (!myDeskEnabledForSchool(actor.schoolId)) throw myDeskError(404, "MYDESK_NOT_ENABLED", "My Desk is temporarily unavailable");
  await assertClasspilotEntitled(actor.schoolId, database, { lock: true });
  const [user] = await database.select({ id: users.id }).from(users).where(eq(users.id, actor.authorId)).limit(1).for("share");
  if (!user) throw myDeskError(403, "MYDESK_PRIVATE_ACCESS_REQUIRED", "Your own active staff identity is required");
  const memberships = await database.select({ role: schoolMemberships.role }).from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, actor.schoolId), eq(schoolMemberships.userId, actor.authorId), eq(schoolMemberships.status, "active"),
    inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]),
  )).for("share");
  if (!memberships.length) throw myDeskError(403, "MYDESK_MEMBERSHIP_INACTIVE", "Your school membership is no longer active");
  return { ...actor, manager: memberships.some(row => row.role === "admin" || row.role === "school_admin") };
}
export async function withActor<T>(actor: MyDeskActor, operation: (database: MyDeskDatabase, currentActor: MyDeskActor) => Promise<T>, consistentRead = false): Promise<T> {
  // This connection belongs to the database operation, including after an HTTP disconnect.
  // Attachment storage I/O runs between these scopes without retaining a tenant client.
  return runWithTenantContext({ schoolId: actor.schoolId }, () => db.transaction(
    async tx => operation(tx, await assertMyDeskActor(actor, tx)), consistentRead ? { isolationLevel: "repeatable read" } : undefined,
  ));
}
export async function withMyDeskNoteLock<T>(actor: MyDeskActor, noteId: string,
  operation: (database: MyDeskDatabase, note: MyDeskNote) => Promise<T>, options: { allowDeleted?: boolean } = {}): Promise<T> {
  return withActor(actor, async database => {
    const [note] = await database.select().from(mydeskNotes).where(ownedNoteWhere(actor, noteId)).limit(1).for("update");
    if (!note || (!options.allowDeleted && (note.status === "deleted" || note.deletedAt
      || note.status === "pending" && note.expiresAt && note.expiresAt <= new Date()))) throw missingNote();
    return operation(database, note);
  });
}
export function assertMyDeskNoteNonempty(title: string, body: string, readyPhotoCount: number): void {
  if (!title.trim() && !body.trim() && readyPhotoCount < 1) throw myDeskError(409, "MYDESK_NOTE_EMPTY", "Add text or at least one saved attachment");
}
function assertRevision(note: MyDeskNote, revision: number) {
  if (note.revision !== revision) throw myDeskError(409, "MYDESK_REVISION_CONFLICT", "This note changed. Refresh it before saving");
}
async function audit(actor: MyDeskActor, action: string, noteId?: string, metadata: Record<string, unknown> = {}) {
  await logAudit({ schoolId: actor.schoolId, userId: actor.authorId, action: `mydesk.${action}`, entityType: "mydesk_note", entityId: noteId, metadata });
}

export function currentClassWhere(actor: MyDeskActor): SQL {
  return and(eq(groups.schoolId, actor.schoolId), eq(groups.status, "active"),
    inArray(groups.groupType, ["admin_class", "teacher_created", "teacher_small_group"]),
    actor.manager ? undefined : or(eq(groups.teacherId, actor.authorId), sql`EXISTS (SELECT 1 FROM group_teachers AS assignment WHERE assignment.group_id=${groups.id} AND assignment.teacher_id=${actor.authorId})`),
  )!;
}
export async function currentClasses(actor: MyDeskActor, database: MyDeskDatabase) {
  return database.select({ id: groups.id, name: groups.name, groupType: groups.groupType, periodLabel: groups.periodLabel })
    .from(groups).where(currentClassWhere(actor)).orderBy(groups.name, groups.id);
}
export async function listMyDeskClasses(actor: MyDeskActor) {
  return withActor(actor, async (database, verified) => {
    const current = await currentClasses(verified, database);
    const pastRows = await database.select({ id: mydeskNotes.filingGroupId, name: mydeskNotes.groupName, updatedAt: mydeskNotes.updatedAt }).from(mydeskNotes).where(and(
      ownedNoteWhere(actor), eq(mydeskNotes.status, "active"), isNull(mydeskNotes.deletedAt), sql`${mydeskNotes.filingGroupId} IS NOT NULL`,
      current.length ? notInArray(mydeskNotes.filingGroupId, current.map(row => row.id)) : undefined,
    )).orderBy(desc(mydeskNotes.updatedAt), desc(mydeskNotes.id));
    if (myDeskSeatingEnabledForSchool(actor.schoolId)) {
      const seatingRows = await database.select({ id: mydeskSeatingCharts.filingGroupId, name: mydeskSeatingCharts.groupName,
        updatedAt: mydeskSeatingCharts.updatedAt }).from(mydeskSeatingCharts).where(and(
        eq(mydeskSeatingCharts.schoolId, actor.schoolId), eq(mydeskSeatingCharts.authorId, actor.authorId), isNull(mydeskSeatingCharts.deletedAt),
        current.length ? notInArray(mydeskSeatingCharts.filingGroupId, current.map(row => row.id)) : undefined,
      ));
      pastRows.push(...seatingRows);
      pastRows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id || "").localeCompare(b.id || ""));
    }
    const past = new Map<string, { id: string; name: string }>();
    for (const row of pastRows) if (row.id && !past.has(row.id)) past.set(row.id, { id: row.id, name: row.name || "Past class" });
    return { current, past: [...past.values()] };
  });
}
export async function listMyDeskClassStudents(actor: MyDeskActor, groupId: string) {
  return withActor(actor, (database, verified) => loadMyDeskClassRoster(verified, groupId, database));
}
export async function loadMyDeskClassRoster(actor: MyDeskActor, groupId: string, database: MyDeskDatabase, options: { lock?: boolean } = {}) {
  const groupQuery = database.select({ id: groups.id, name: groups.name }).from(groups)
    .where(and(currentClassWhere(actor), eq(groups.id, groupId))).limit(1);
  const [group] = await (options.lock ? groupQuery.for("update") : groupQuery);
  if (!group) throw myDeskError(404, "MYDESK_CLASS_NOT_FOUND", "Class not found");
  if (group.name.length > 500 || group.id.length > 128) throw myDeskError(409, "MYDESK_SEATING_ROSTER_TOO_LARGE", "The class roster exceeds seating-chart size limits");
  if (options.lock) {
    await database.select({ id: groupTeachers.teacherId }).from(groupTeachers).where(eq(groupTeachers.groupId, groupId)).for("share");
    // Recheck co-teacher access after locking the assignment rows.
    const [stillAssigned] = await database.select({ id: groups.id }).from(groups).where(and(currentClassWhere(actor), eq(groups.id, groupId))).limit(1);
    if (!stillAssigned) throw myDeskError(404, "MYDESK_CLASS_NOT_FOUND", "Class not found");
  }
  const rosterQuery = database.select({ id: students.id, firstName: students.firstName, lastName: students.lastName, status: students.status }).from(groupStudents)
    .innerJoin(students, and(eq(students.id, groupStudents.studentId), eq(students.schoolId, actor.schoolId)))
    .where(and(eq(groupStudents.groupId, groupId), options.lock ? undefined : eq(students.status, "active")))
    .orderBy(students.lastName, students.firstName, students.id).limit(1001);
  const rows = await (options.lock ? rosterQuery.for("share") : rosterQuery);
  if (rows.length > 1000) throw myDeskError(409, "MYDESK_SEATING_ROSTER_TOO_LARGE", "This class has more than 1,000 roster entries. Use a smaller class for seating charts");
  // Writes also lock inactive roster members so reactivation cannot change the roster during a save.
  const roster = rows.filter(student => student.status === "active").map(({ id, firstName, lastName }) =>
    ({ id, firstName, lastName, name: `${firstName} ${lastName}`.trim() }));
  const snapshot = roster.map(({ id, name }) => ({ id, name }));
  if (snapshot.some(student => student.id.length > 128 || student.name.length > 500)
    || Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 1_000_000) {
    throw myDeskError(409, "MYDESK_SEATING_ROSTER_TOO_LARGE", "The class roster exceeds seating-chart size limits");
  }
  const rosterRevision = createHash("sha256").update(JSON.stringify([group.id, group.name,
    snapshot.sort((a, b) => a.id.localeCompare(b.id)),
  ])).digest("hex");
  return { class: group, students: roster, rosterRevision };
}
export async function listMyDeskClassNoteStudents(actor: MyDeskActor, groupId: string) {
  return withActor(actor, async (database, verified) => {
    const ownClassNotes = and(ownedNoteWhere(actor), eq(mydeskNotes.status, "active"),
      isNull(mydeskNotes.deletedAt), eq(mydeskNotes.filingGroupId, groupId));
    const [currentClass] = await database.select({ id: groups.id }).from(groups)
      .where(and(currentClassWhere(verified), eq(groups.id, groupId))).limit(1);
    if (!currentClass) {
      const [ownNote] = await database.select({ id: mydeskNotes.id }).from(mydeskNotes).where(ownClassNotes).limit(1);
      if (!ownNote) {
        const chart = myDeskSeatingEnabledForSchool(actor.schoolId) ? await database.select({ id: mydeskSeatingCharts.id })
          .from(mydeskSeatingCharts).where(and(eq(mydeskSeatingCharts.schoolId, actor.schoolId),
            eq(mydeskSeatingCharts.authorId, actor.authorId), eq(mydeskSeatingCharts.filingGroupId, groupId),
            isNull(mydeskSeatingCharts.deletedAt))).limit(1) : [];
        if (!chart.length) throw myDeskError(404, "MYDESK_CLASS_NOT_FOUND", "Class not found");
      }
    }
    // Historical filters use only the author's saved filing snapshots, never a live roster.
    const rows = await database.selectDistinctOn([mydeskNotes.filingStudentId], {
      id: mydeskNotes.filingStudentId, name: mydeskNotes.studentName,
    }).from(mydeskNotes).where(and(ownClassNotes, eq(mydeskNotes.targetKind, "student"),
      sql`${mydeskNotes.filingStudentId} IS NOT NULL`, sql`${mydeskNotes.studentName} IS NOT NULL`,
    )).orderBy(mydeskNotes.filingStudentId, desc(mydeskNotes.updatedAt), desc(mydeskNotes.id));
    const students = rows.flatMap(row => row.id && row.name ? [{ id: row.id, name: row.name }] : []);
    students.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { students };
  });
}
type TargetInput = { targetKind: MyDeskNote["targetKind"]; groupId?: string | null; studentId?: string | null };
async function resolveTarget(actor: MyDeskActor, target: TargetInput, database: MyDeskDatabase) {
  const empty = { groupId: null, filingGroupId: null, groupName: null, studentId: null, filingStudentId: null, studentName: null };
  if (target.targetKind === "general") {
    if (target.groupId || target.studentId) throw myDeskError(400, "MYDESK_INVALID_TARGET", "General notes do not have a class or student");
    return { targetKind: target.targetKind, ...empty };
  }
  if (!target.groupId || target.targetKind === "class" && target.studentId || target.targetKind === "student" && !target.studentId) {
    throw myDeskError(400, "MYDESK_INVALID_TARGET", "Choose the note's class and, for a student note, its student");
  }
  const [group] = await database.select({ id: groups.id, name: groups.name }).from(groups)
    .where(and(currentClassWhere(actor), eq(groups.id, target.groupId))).limit(1).for("share");
  if (!group) throw myDeskError(404, "MYDESK_CLASS_NOT_FOUND", "Class not found");
  const result = { ...empty, targetKind: target.targetKind, groupId: group.id, filingGroupId: group.id, groupName: group.name };
  if (target.targetKind === "class") return result;
  const [student] = await database.select({ id: students.id, firstName: students.firstName, lastName: students.lastName }).from(students)
    .innerJoin(groupStudents, and(eq(groupStudents.studentId, students.id), eq(groupStudents.groupId, group.id)))
    .where(and(eq(students.id, target.studentId!), eq(students.schoolId, actor.schoolId), eq(students.status, "active"))).limit(1).for("share");
  if (!student) throw myDeskError(404, "MYDESK_STUDENT_NOT_FOUND", "Student not found in this class");
  return { ...result, studentId: student.id, filingStudentId: student.id, studentName: `${student.firstName} ${student.lastName}`.trim() };
}
async function schoolDate(actor: MyDeskActor, database: MyDeskDatabase) {
  const [school] = await database.select({ timeZone: schools.schoolTimezone }).from(schools).where(eq(schools.id, actor.schoolId)).limit(1);
  return createLocalDateFormatter(school?.timeZone)(new Date());
}
export function safeMyDeskNoteDto(note: MyDeskNote, attachments: MyDeskAttachment[], includeStaged = false) {
  const visible = attachments.filter(row => row.schoolId === note.schoolId && row.authorId === note.authorId && row.noteId === note.id && !row.deletedAt
    && (includeStaged ? ["pending", "uploading", "ready"].includes(row.status) : row.status === "ready" && row.committedAt != null));
  const ready = visible.filter(row => row.status === "ready");
  const attachmentTitle = ready.length > 1 ? `${ready.length} attachments` : ready[0]?.contentType === "application/pdf" ? "PDF note" : ready.length ? "Photo note" : "";
  return {
    id: note.id, clientRequestId: note.clientRequestId, targetKind: note.targetKind,
    groupId: note.groupId, filingGroupId: note.filingGroupId, groupName: note.groupName,
    studentId: note.studentId, filingStudentId: note.filingStudentId, studentName: note.studentName,
    category: note.category, title: note.title, displayTitle: note.title || (!note.body.trim() && attachmentTitle) || (note.studentName ? `Note about ${note.studentName}` : note.groupName ? `${note.groupName} note` : "Untitled note"),
    body: note.body, entryDate: note.entryDate, pinned: note.pinned, status: note.status,
    revision: note.revision, createdAt: note.createdAt, updatedAt: note.updatedAt,
    attachments: visible.map(row => ({ id: row.id, noteId: row.noteId, clientRequestId: row.clientRequestId, originalFilename: row.originalFilename,
        contentType: row.contentType, byteSize: row.byteSize, status: row.status, committedAt: row.committedAt, createdAt: row.createdAt })),
  };
}
async function dto(database: MyDeskDatabase, actor: MyDeskActor, note: MyDeskNote, includeStaged = false) {
  const attachments = await database.select().from(mydeskAttachments).where(attachmentWhere(actor, note.id)).orderBy(mydeskAttachments.createdAt, mydeskAttachments.id);
  return safeMyDeskNoteDto(note, attachments, includeStaged);
}
export async function createMyDeskNote(actor: MyDeskActor, input: MyDeskCreateInput) {
  // Defaults with wall-clock meaning are excluded: an identical retry tomorrow is still the same operation.
  const fingerprint = createHash("sha256").update(JSON.stringify({ targetKind: input.targetKind, groupId: input.groupId || null,
    studentId: input.studentId || null, category: input.category, title: input.title, body: input.body, entryDate: input.entryDate || null, pinned: input.pinned })).digest("hex");
  const result = await withActor(actor, async (database, verified) => {
    // Serializes matching requests before looking up the immutable replay record.
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.schoolId}:${actor.authorId}:${input.clientRequestId}`}, 0))`);
    const [existing] = await database.select().from(mydeskNotes).where(and(ownedNoteWhere(actor), eq(mydeskNotes.clientRequestId, input.clientRequestId))).limit(1).for("update");
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) throw myDeskError(409, "MYDESK_REQUEST_CONFLICT", "This save identifier was already used for different content");
      if (existing.status === "deleted" || existing.deletedAt || existing.status === "pending" && existing.expiresAt && existing.expiresAt <= new Date()) throw missingNote();
      return { note: await dto(database, actor, existing, true), created: false };
    }
    const target = await resolveTarget(verified, input, database);
    const [note] = await database.insert(mydeskNotes).values({ schoolId: actor.schoolId, authorId: actor.authorId,
      clientRequestId: input.clientRequestId, requestFingerprint: fingerprint, ...target,
      category: input.category, title: input.title, body: input.body, entryDate: input.entryDate || await schoolDate(actor, database),
      pinned: input.pinned, status: "pending", expiresAt: new Date(Date.now() + 24 * 3600_000),
    }).returning();
    return { note: await dto(database, actor, note!, true), created: true };
  });
  if (result.created) await audit(actor, "note.create", result.note.id);
  return result;
}
export async function getMyDeskNote(actor: MyDeskActor, id: string) {
  return withMyDeskNoteLock(actor, id, (database, note) => dto(database, actor, note, true));
}
async function patchValues(actor: MyDeskActor, database: MyDeskDatabase, note: MyDeskNote, patch: MyDeskPatch) {
  const values = { category: patch.category ?? note.category, title: patch.title ?? note.title, body: patch.body ?? note.body,
    entryDate: patch.entryDate ?? note.entryDate, pinned: patch.pinned ?? note.pinned };
  if (patch.targetKind !== undefined || patch.groupId !== undefined || patch.studentId !== undefined) {
    const targetKind = patch.targetKind ?? note.targetKind;
    const verified = await assertMyDeskActor(actor, database);
    return { ...values, ...await resolveTarget(verified, { targetKind,
      groupId: targetKind === "general" ? patch.groupId ?? null : patch.groupId === undefined ? note.groupId : patch.groupId,
      studentId: targetKind !== "student" ? patch.studentId ?? null : patch.studentId === undefined ? note.studentId : patch.studentId,
    }, database) };
  }
  return values;
}
export async function updateMyDeskNote(actor: MyDeskActor, id: string, revision: number, patch: MyDeskPatch) {
  const result = await withMyDeskNoteLock(actor, id, async (database, note) => {
    assertRevision(note, revision);
    const values = await patchValues(actor, database, note, patch);
    const photos = await database.select({ id: mydeskAttachments.id }).from(mydeskAttachments).where(and(attachmentWhere(actor, id),
      eq(mydeskAttachments.status, "ready"), isNull(mydeskAttachments.deletedAt), sql`${mydeskAttachments.committedAt} IS NOT NULL`));
    if (note.status === "active") assertMyDeskNoteNonempty(values.title, values.body, photos.length);
    const [updated] = await database.update(mydeskNotes).set({ ...values, revision: note.revision + 1, updatedAt: new Date() }).where(ownedNoteWhere(actor, id)).returning();
    return dto(database, actor, updated!, true);
  });
  await audit(actor, "note.update", id); return result;
}
export async function completeMyDeskNote(actor: MyDeskActor, id: string, revision: number, patch: MyDeskPatch, attachmentIds?: string[]) {
  const result = await withMyDeskNoteLock(actor, id, async (database, note) => {
    const photos = await database.select().from(mydeskAttachments).where(and(attachmentWhere(actor, id), isNull(mydeskAttachments.deletedAt),
      inArray(mydeskAttachments.status, ["pending", "uploading", "ready"]))).for("update");
    const selectedIds = attachmentIds ?? photos.filter(photo => photo.status === "ready" && photo.committedAt).map(photo => photo.id);
    const selected = photos.filter(photo => selectedIds.includes(photo.id));
    if (selected.length !== selectedIds.length || selected.some(photo => photo.status !== "ready")) throw myDeskError(409, "MYDESK_PHOTOS_NOT_READY", "Wait for every selected attachment to finish uploading");
    // A lost successful completion may be replayed; it must describe the exact current result.
    const replay = note.status === "active" && note.revision === revision + 1
      && Object.entries(patch).every(([key, value]) => Reflect.get(note, key) === value)
      && selected.every(photo => photo.committedAt != null)
      && photos.filter(photo => photo.status === "ready" && photo.committedAt).length === selected.length;
    if (replay) return dto(database, actor, note, true);
    assertRevision(note, revision);
    const values = await patchValues(actor, database, note, patch);
    assertMyDeskNoteNonempty(values.title, values.body, selected.length);
    const now = new Date();
    if (selectedIds.length) await database.update(mydeskAttachments).set({ committedAt: now, updatedAt: now })
      .where(and(attachmentWhere(actor, id), inArray(mydeskAttachments.id, selectedIds)));
    const excluded = photos.filter(photo => !selectedIds.includes(photo.id)).map(photo => photo.id);
    if (excluded.length) await database.update(mydeskAttachments).set({ status: "delete_pending", deletedAt: now, nextCleanupAt: now, updatedAt: now })
      .where(and(attachmentWhere(actor, id), inArray(mydeskAttachments.id, excluded)));
    const [updated] = await database.update(mydeskNotes).set({ ...values, status: "active", expiresAt: null, revision: note.revision + 1, updatedAt: now })
      .where(ownedNoteWhere(actor, id)).returning();
    return dto(database, actor, updated!, true);
  });
  await audit(actor, "note.complete", id); return result;
}
export async function deleteMyDeskNote(actor: MyDeskActor, id: string, revision: number) {
  await withMyDeskNoteLock(actor, id, async (database, note) => {
    assertRevision(note, revision); const now = new Date();
    await database.update(mydeskNotes).set({ status: "deleted", deletedAt: now, updatedAt: now, revision: note.revision + 1 }).where(ownedNoteWhere(actor, id));
    await database.update(mydeskAttachments).set({ status: "delete_pending", deletedAt: now, updatedAt: now, nextCleanupAt: now })
      .where(and(attachmentWhere(actor, id), ne(mydeskAttachments.status, "deleted")));
  });
  await audit(actor, "note.delete", id);
}

const cursorInput = z.object({ pinned: z.boolean(), entryDate: z.string(), createdAt: z.string().datetime(), id: z.string(), filter: z.string() }).strict();
const queryFingerprint = (actor: MyDeskActor, query: MyDeskNotesQuery) => createHash("sha256").update(JSON.stringify([
  actor.schoolId, actor.authorId, query.scope, query.classId || null, query.studentId || null, query.category || null, query.from || null, query.to || null, query.q || null,
])).digest("hex");
async function listNotes(database: MyDeskDatabase, actor: MyDeskActor, query: MyDeskNotesQuery) {
  const current = await currentClasses(actor, database); const ids = current.map(group => group.id);
  const conditions: SQL[] = [ownedNoteWhere(actor), eq(mydeskNotes.status, "active"), isNull(mydeskNotes.deletedAt)];
  if (query.scope === "general") conditions.push(eq(mydeskNotes.targetKind, "general"));
  if (query.scope === "all") conditions.push(or(eq(mydeskNotes.targetKind, "general"), ids.length ? inArray(mydeskNotes.filingGroupId, ids) : sql`false`)!);
  if (query.scope === "past") conditions.push(sql`${mydeskNotes.filingGroupId} IS NOT NULL`, ids.length ? notInArray(mydeskNotes.filingGroupId, ids) : sql`true`);
  if (query.classId) conditions.push(eq(mydeskNotes.filingGroupId, query.classId));
  if (query.studentId) conditions.push(eq(mydeskNotes.filingStudentId, query.studentId));
  if (query.category) conditions.push(eq(mydeskNotes.category, query.category));
  if (query.from) conditions.push(sql`${mydeskNotes.entryDate} >= ${query.from}`);
  if (query.to) conditions.push(sql`${mydeskNotes.entryDate} <= ${query.to}`);
  if (query.q) {
    const search = `%${query.q.replace(/[\\%_]/g, value => "\\" + value)}%`;
    conditions.push(or(ilike(mydeskNotes.title, search), ilike(mydeskNotes.body, search), ilike(mydeskNotes.groupName, search), ilike(mydeskNotes.studentName, search))!);
  }
  const filter = queryFingerprint(actor, query);
  if (query.cursor) {
    try {
      const cursor = cursorInput.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
      if (cursor.filter !== filter) throw new Error("filter");
      conditions.push(sql`(${mydeskNotes.pinned},${mydeskNotes.entryDate},${mydeskNotes.createdAt},${mydeskNotes.id}) < (${cursor.pinned},${cursor.entryDate}::date,${cursor.createdAt}::timestamptz,${cursor.id})`);
    } catch { throw myDeskError(400, "MYDESK_INVALID_CURSOR", "Refresh the notebook to start a new page"); }
  }
  // JavaScript Date truncates PostgreSQL microseconds. Keep the database's exact
  // ordering value or a page boundary can silently omit rows created together.
  const rows = await database.select({ ...getTableColumns(mydeskNotes),
    createdAtCursor: sql<string>`to_char(${mydeskNotes.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(mydeskNotes).where(and(...conditions))
    .orderBy(desc(mydeskNotes.pinned), desc(mydeskNotes.entryDate), desc(mydeskNotes.createdAt), desc(mydeskNotes.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const photos = page.length ? await database.select().from(mydeskAttachments).where(and(eq(mydeskAttachments.schoolId, actor.schoolId), eq(mydeskAttachments.authorId, actor.authorId),
    inArray(mydeskAttachments.noteId, page.map(note => note.id)), eq(mydeskAttachments.status, "ready"), isNull(mydeskAttachments.deletedAt), sql`${mydeskAttachments.committedAt} IS NOT NULL`)) : [];
  const last = page[page.length - 1];
  const nextCursor = rows.length > query.limit && last ? Buffer.from(JSON.stringify({ pinned: last.pinned, entryDate: last.entryDate, createdAt: last.createdAtCursor, id: last.id, filter })).toString("base64url") : null;
  return { notes: page.map(note => safeMyDeskNoteDto(note, photos)), nextCursor };
}
export async function listMyDeskNotes(actor: MyDeskActor, query: MyDeskNotesQuery) { return withActor(actor, (database, current) => listNotes(database, current, query)); }
export async function exportMyDeskNotes(actor: MyDeskActor, query: MyDeskNotesQuery) {
  const result = await withActor(actor, async (database, verified) => {
    const rows: ReturnType<typeof safeMyDeskNoteDto>[] = []; let cursor: string | undefined;
    do {
      const page = await listNotes(database, verified, { ...query, cursor, limit: 100 });
      rows.push(...page.notes); cursor = page.nextCursor || undefined;
      if (rows.length > 5000 || rows.length === 5000 && cursor) throw myDeskError(422, "MYDESK_EXPORT_LIMIT", "More than 5,000 notes match. Narrow your filters and export again");
    } while (cursor);
    const header = ["entry_date", "target", "class", "student", "category", "title", "body", "pinned", "created_at", "photos"];
    const csvRows = rows.map(note => [note.entryDate, note.targetKind, note.groupName, note.studentName, note.category, note.title, note.body,
      note.pinned, note.createdAt.toISOString(), note.attachments.map(photo => {
        const production = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
        const baseUrl = process.env.PUBLIC_BASE_URL || process.env.CLIENT_URL || (production ? "" : "http://localhost:5173");
        let configured: URL;
        try { configured = new URL(baseUrl); } catch { throw myDeskError(503, "MYDESK_EXPORT_UNAVAILABLE", "The notebook export URL is not configured"); }
        if (!["https:", "http:"].includes(configured.protocol) || configured.username || configured.password || production && configured.protocol !== "https:") throw myDeskError(503, "MYDESK_EXPORT_UNAVAILABLE", "The notebook export URL is not configured");
        const link = new URL(`/api/mydesk/notes/${encodeURIComponent(note.id)}/attachments/${encodeURIComponent(photo.id)}/content`, configured.origin);
        link.searchParams.set("schoolId", actor.schoolId);
        return link.href;
      }).join(" ")]);
    return { csv: "\uFEFF" + [header, ...csvRows].map(row => row.map(myDeskCsvCell).join(",")).join("\r\n") + "\r\n", rowCount: rows.length };
  }, true);
  await audit(actor, "export.csv", undefined, { rowCount: result.rowCount }); return result;
}
