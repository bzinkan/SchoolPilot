import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { mydeskSeatingCharts } from "../schema/mydeskSeating.js";
import { groups } from "../schema/classpilot.js";
import { logAudit } from "./audit.js";
import { currentClasses, loadMyDeskClassRoster, myDeskError, withActor, type MyDeskActor, type MyDeskDatabase } from "./mydesk.js";
import { myDeskSeatingEnabledForSchool } from "./mydeskValidation.js";
import { seatingCreateInput, seatingUpdateInput, seatingDuplicateInput, seatingMutationInput, seatingListQuery,
  type SeatingLayout, type SeatingRosterEntry } from "./mydeskSeatingValidation.js";

type Chart = typeof mydeskSeatingCharts.$inferSelect;
type CreateInput = z.infer<typeof seatingCreateInput>;
type UpdateInput = z.infer<typeof seatingUpdateInput>;
type DuplicateInput = z.infer<typeof seatingDuplicateInput>;
type MutationInput = z.infer<typeof seatingMutationInput>;
type ListQuery = z.infer<typeof seatingListQuery>;
type MutationKind = "update" | "current" | "delete";
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = () => myDeskError(404, "MYDESK_SEATING_NOT_FOUND", "Seating chart not found");
const conflict = () => myDeskError(409, "MYDESK_SEATING_REVISION_CONFLICT", "This seating chart changed. Reload it before saving");
const requestConflict = () => myDeskError(409, "MYDESK_SEATING_REQUEST_CONFLICT", "This request identifier was already used for a different change");
const own = (actor: MyDeskActor, id?: string): SQL => and(eq(mydeskSeatingCharts.schoolId, actor.schoolId),
  eq(mydeskSeatingCharts.authorId, actor.authorId), id ? eq(mydeskSeatingCharts.id, id) : undefined)!;

function withSeating<T>(actor: MyDeskActor, operation: (database: MyDeskDatabase, verified: MyDeskActor) => Promise<T>) {
  return withActor(actor, async (database, verified) => {
    if (!myDeskSeatingEnabledForSchool(actor.schoolId)) throw myDeskError(404, "MYDESK_SEATING_NOT_ENABLED", "Seating charts are not enabled for this school");
    return operation(database, verified);
  });
}
async function audit(actor: MyDeskActor, action: string, id: string) {
  await logAudit({ schoolId: actor.schoolId, userId: actor.authorId, action: `mydesk.seating.${action}`, entityType: "mydesk_seating_chart", entityId: id });
}
async function lockClass(database: MyDeskDatabase, actor: MyDeskActor, classId: string) {
  await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mydesk-seating-class:${actor.schoolId}:${actor.authorId}:${classId}`},0))`);
}
async function lockRequest(database: MyDeskDatabase, actor: MyDeskActor, requestId: string) {
  await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mydesk-seating-request:${actor.schoolId}:${actor.authorId}:${requestId}`},0))`);
}
async function lockLiveGroups(database: MyDeskDatabase, actor: MyDeskActor, ids: string[]) {
  const uniqueIds = [...new Set(ids)].sort();
  if (uniqueIds.length) await database.select({ id: groups.id }).from(groups)
    .where(and(eq(groups.schoolId, actor.schoolId), inArray(groups.id, uniqueIds))).orderBy(groups.id).for("update");
}
async function ownedChart(database: MyDeskDatabase, actor: MyDeskActor, id: string, lock = false, allowDeleted = false) {
  const query = database.select().from(mydeskSeatingCharts).where(own(actor, id)).limit(1);
  const [chart] = await (lock ? query.for("update") : query);
  if (!chart || chart.deletedAt && !allowDeleted) throw missing();
  return chart;
}
async function lockedChart(database: MyDeskDatabase, actor: MyDeskActor, id: string, allowDeleted = false) {
  const snapshot = await ownedChart(database, actor, id, false, allowDeleted);
  await lockClass(database, actor, snapshot.filingGroupId);
  // Group deletion updates chart FKs, so every writer must lock live groups before chart rows.
  await lockLiveGroups(database, actor, snapshot.groupId ? [snapshot.groupId] : []);
  return ownedChart(database, actor, id, true, allowDeleted);
}
type ChartSummary = Pick<Chart, "id" | "groupId" | "filingGroupId" | "groupName" | "name" | "revision" | "isCurrent" | "createdAt" | "updatedAt">;
function safeSummary(chart: ChartSummary, canEdit: boolean) {
  return { id: chart.id, classId: chart.groupId, filingGroupId: chart.filingGroupId, className: chart.groupName,
    name: chart.name, revision: chart.revision, isCurrent: chart.isCurrent, canEdit, createdAt: chart.createdAt, updatedAt: chart.updatedAt };
}
function safeChart(chart: Chart, canEdit: boolean) {
  return { ...safeSummary(chart, canEdit), layout: chart.layout, roster: chart.rosterSnapshot, rosterRevision: chart.rosterRevision };
}
async function dto(database: MyDeskDatabase, actor: MyDeskActor, chart: Chart) {
  const accessible = await currentClasses(actor, database);
  return safeChart(chart, Boolean(chart.groupId && accessible.some(group => group.id === chart.groupId)));
}
function assertRevision(chart: Chart, revision: number) { if (chart.revision !== revision) throw conflict(); }
function replayMutation(chart: Chart, id: string, expected: string, kind: MutationKind): boolean {
  const receipt = chart.mutationReceipts.find(row => row.id === id);
  if (!receipt) return false;
  if (receipt.fingerprint !== expected || receipt.kind !== kind) throw requestConflict();
  return true;
}
function receipts(chart: Chart, id: string, hash: string, kind: MutationKind) {
  return [...chart.mutationReceipts, { id, fingerprint: hash, revision: chart.revision + 1, kind }].slice(-100);
}
async function editableRoster(database: MyDeskDatabase, actor: MyDeskActor, classId: string | null, rosterRevision?: string) {
  if (!classId) throw myDeskError(409, "MYDESK_SEATING_READ_ONLY", "This past class chart is read-only. Copy its layout to a current class");
  let roster: Awaited<ReturnType<typeof loadMyDeskClassRoster>>;
  try { roster = await loadMyDeskClassRoster(actor, classId, database, { lock: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MYDESK_CLASS_NOT_FOUND") {
      throw myDeskError(409, "MYDESK_SEATING_READ_ONLY", "This past class chart is read-only. Copy its layout to a current class");
    }
    throw error;
  }
  if (rosterRevision !== undefined && rosterRevision !== roster.rosterRevision) {
    throw myDeskError(409, "MYDESK_SEATING_ROSTER_CHANGED", "The class roster changed. Refresh it before saving");
  }
  return roster;
}
function assertAssignments(layout: SeatingLayout, roster: SeatingRosterEntry[]) {
  const ids = new Set(roster.map(student => student.id));
  if (layout.seats.some(seat => seat.studentId && !ids.has(seat.studentId))) {
    throw myDeskError(409, "MYDESK_SEATING_STUDENT_UNAVAILABLE", "A seated student is no longer in this class. Refresh the roster before saving");
  }
}
async function existingCreate(database: MyDeskDatabase, actor: MyDeskActor, requestId: string, hash: string) {
  const [existing] = await database.select().from(mydeskSeatingCharts)
    .where(and(own(actor), eq(mydeskSeatingCharts.clientRequestId, requestId))).limit(1);
  if (!existing) return undefined;
  if (existing.requestFingerprint !== hash) throw requestConflict();
  if (existing.deletedAt) throw missing();
  return { chart: await dto(database, actor, existing), created: false };
}
async function insertChart(database: MyDeskDatabase, actor: MyDeskActor, input: { clientRequestId: string; name: string; layout: SeatingLayout },
  hash: string, roster: Awaited<ReturnType<typeof loadMyDeskClassRoster>>) {
  const snapshots = roster.students.map(({ id, name }) => ({ id, name }));
  assertAssignments(input.layout, snapshots);
  // Tombstones count: deleting the current chart must not silently designate a later save.
  const [previous] = await database.select({ id: mydeskSeatingCharts.id }).from(mydeskSeatingCharts)
    .where(and(own(actor), eq(mydeskSeatingCharts.filingGroupId, roster.class.id))).limit(1);
  const [chart] = await database.insert(mydeskSeatingCharts).values({ schoolId: actor.schoolId, authorId: actor.authorId,
    clientRequestId: input.clientRequestId, requestFingerprint: hash, groupId: roster.class.id, filingGroupId: roster.class.id,
    groupName: roster.class.name, name: input.name, layout: input.layout, rosterSnapshot: snapshots,
    rosterRevision: roster.rosterRevision, isCurrent: !previous }).returning();
  return { chart: safeChart(chart!, true), created: true };
}

export async function createMyDeskSeatingChart(actor: MyDeskActor, input: CreateInput) {
  const hash = fingerprint(["create", input]);
  const result = await withSeating(actor, async (database, verified) => {
    await lockRequest(database, actor, input.clientRequestId);
    const existing = await existingCreate(database, verified, input.clientRequestId, hash); if (existing) return existing;
    await lockClass(database, actor, input.classId);
    const roster = await loadMyDeskClassRoster(verified, input.classId, database, { lock: true });
    if (roster.rosterRevision !== input.rosterRevision) throw myDeskError(409, "MYDESK_SEATING_ROSTER_CHANGED", "The class roster changed. Refresh it before saving");
    return insertChart(database, verified, input, hash, roster);
  });
  if (result.created) await audit(actor, "create", result.chart.id); return result;
}
export async function getMyDeskSeatingChart(actor: MyDeskActor, id: string) {
  return withSeating(actor, async (database, verified) => dto(database, verified, await ownedChart(database, actor, id)));
}
export async function updateMyDeskSeatingChart(actor: MyDeskActor, id: string, input: UpdateInput) {
  const hash = fingerprint(["update", id, input]);
  const result = await withSeating(actor, async (database, verified) => {
    const chart = await lockedChart(database, actor, id);
    if (replayMutation(chart, input.requestId, hash, "update")) return dto(database, verified, chart);
    assertRevision(chart, input.revision);
    const roster = await editableRoster(database, verified, chart.groupId, input.rosterRevision);
    const snapshots = roster.students.map(({ id: studentId, name }) => ({ id: studentId, name }));
    assertAssignments(input.layout, snapshots);
    const [updated] = await database.update(mydeskSeatingCharts).set({ name: input.name, layout: input.layout,
      groupName: roster.class.name, rosterSnapshot: snapshots, rosterRevision: roster.rosterRevision,
      revision: chart.revision + 1, mutationReceipts: receipts(chart, input.requestId, hash, "update"), updatedAt: new Date() })
      .where(own(actor, id)).returning();
    return safeChart(updated!, true);
  });
  await audit(actor, "update", id); return result;
}
export async function duplicateMyDeskSeatingChart(actor: MyDeskActor, id: string, input: DuplicateInput) {
  const hash = fingerprint(["duplicate", id, input]);
  const result = await withSeating(actor, async (database, verified) => {
    await lockRequest(database, actor, input.clientRequestId);
    const existing = await existingCreate(database, verified, input.clientRequestId, hash); if (existing) return existing;
    const snapshot = await ownedChart(database, actor, id);
    // Always acquire both class locks in one order, including copies between different classes.
    for (const classId of [...new Set([snapshot.filingGroupId, input.targetClassId])].sort()) await lockClass(database, actor, classId);
    await lockLiveGroups(database, actor, [input.targetClassId, ...(snapshot.groupId ? [snapshot.groupId] : [])]);
    const source = await ownedChart(database, actor, id, true); assertRevision(source, input.sourceRevision);
    if (input.mode === "chart" && (!source.groupId || source.groupId !== input.targetClassId)) {
      throw myDeskError(400, "MYDESK_SEATING_COPY_CLASS", "Copy the layout when using a different class");
    }
    const roster = input.mode === "chart" ? await editableRoster(database, verified, source.groupId)
      : await loadMyDeskClassRoster(verified, input.targetClassId, database, { lock: true });
    if (roster.rosterRevision !== input.rosterRevision) throw myDeskError(409, "MYDESK_SEATING_ROSTER_CHANGED", "The class roster changed. Refresh it before saving");
    const layout: SeatingLayout = { version: 1, seats: source.layout.seats.map(seat => ({ ...seat, id: randomUUID(),
      ...(input.mode === "layout" ? { studentId: null, locked: false } : {}) })) };
    return insertChart(database, verified, { clientRequestId: input.clientRequestId, name: input.name, layout }, hash, roster);
  });
  if (result.created) await audit(actor, "duplicate", result.chart.id); return result;
}
export async function setCurrentMyDeskSeatingChart(actor: MyDeskActor, id: string, input: MutationInput) {
  const hash = fingerprint(["current", id, input]);
  const result = await withSeating(actor, async (database, verified) => {
    const chart = await lockedChart(database, actor, id);
    if (replayMutation(chart, input.requestId, hash, "current")) return dto(database, verified, chart);
    assertRevision(chart, input.revision); await editableRoster(database, verified, chart.groupId);
    const now = new Date();
    await database.update(mydeskSeatingCharts).set({ isCurrent: false, revision: sql`${mydeskSeatingCharts.revision}+1`, updatedAt: now })
      .where(and(own(actor), eq(mydeskSeatingCharts.filingGroupId, chart.filingGroupId), eq(mydeskSeatingCharts.isCurrent, true),
        isNull(mydeskSeatingCharts.deletedAt), ne(mydeskSeatingCharts.id, id)));
    const [updated] = await database.update(mydeskSeatingCharts).set({ isCurrent: true, revision: chart.revision + 1,
      mutationReceipts: receipts(chart, input.requestId, hash, "current"), updatedAt: now }).where(own(actor, id)).returning();
    return safeChart(updated!, true);
  });
  await audit(actor, "current", id); return result;
}
export async function deleteMyDeskSeatingChart(actor: MyDeskActor, id: string, input: MutationInput) {
  const hash = fingerprint(["delete", id, input]);
  await withSeating(actor, async (database) => {
    const chart = await lockedChart(database, actor, id, true);
    if (replayMutation(chart, input.requestId, hash, "delete")) return;
    if (chart.deletedAt) throw missing();
    assertRevision(chart, input.revision); const now = new Date();
    await database.update(mydeskSeatingCharts).set({ name: "", groupName: "", groupId: null,
      layout: { version: 1, seats: [] }, rosterSnapshot: [], rosterRevision: "", isCurrent: false, deletedAt: now, updatedAt: now,
      revision: chart.revision + 1, mutationReceipts: receipts(chart, input.requestId, hash, "delete") }).where(own(actor, id));
  });
  await audit(actor, "delete", id);
}

const cursorShape = z.object({ id: z.string().min(1).max(128), updatedAt: z.string().datetime({ offset: true }), scope: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export async function listMyDeskSeatingCharts(actor: MyDeskActor, query: ListQuery) {
  return withSeating(actor, async (database, verified) => {
    const current = await currentClasses(verified, database), currentIds = current.map(group => group.id);
    const scope = fingerprint([actor.schoolId, actor.authorId, query.scope, query.classId || null]);
    let cursor: z.infer<typeof cursorShape> | undefined;
    if (query.cursor) {
      try { cursor = cursorShape.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); }
      catch { throw myDeskError(400, "MYDESK_SEATING_CURSOR_INVALID", "Reload seating charts to continue"); }
      if (cursor.scope !== scope) throw myDeskError(400, "MYDESK_SEATING_CURSOR_INVALID", "Reload seating charts to continue");
    }
    const rows = await database.select({ id: mydeskSeatingCharts.id, groupId: mydeskSeatingCharts.groupId,
      filingGroupId: mydeskSeatingCharts.filingGroupId, groupName: mydeskSeatingCharts.groupName, name: mydeskSeatingCharts.name,
      revision: mydeskSeatingCharts.revision, isCurrent: mydeskSeatingCharts.isCurrent,
      createdAt: mydeskSeatingCharts.createdAt, updatedAt: mydeskSeatingCharts.updatedAt,
      updatedAtCursor: sql<string>`to_char(${mydeskSeatingCharts.updatedAt} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(mydeskSeatingCharts).where(and(own(actor), isNull(mydeskSeatingCharts.deletedAt),
      query.scope === "current" ? currentIds.length ? inArray(mydeskSeatingCharts.filingGroupId, currentIds) : sql`false`
        : currentIds.length ? notInArray(mydeskSeatingCharts.filingGroupId, currentIds) : undefined,
      query.classId ? eq(mydeskSeatingCharts.filingGroupId, query.classId) : undefined,
      cursor ? sql`(${mydeskSeatingCharts.updatedAt},${mydeskSeatingCharts.id}) < (${cursor.updatedAt}::timestamptz,${cursor.id})` : undefined,
    )).orderBy(desc(mydeskSeatingCharts.updatedAt), desc(mydeskSeatingCharts.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit), last = page.at(-1);
    return { charts: page.map(chart => safeSummary(chart, Boolean(chart.groupId && currentIds.includes(chart.groupId)))),
      nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ id: last.id, updatedAt: last.updatedAtCursor, scope })).toString("base64url") : null };
  });
}
