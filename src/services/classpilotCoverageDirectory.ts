import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import db from "../db.js";
import { schoolMemberships, users } from "../schema/core.js";
import { classpilotCoverageAssignments, classpilotCoverageGroupCategories as categories, classpilotCoverageScopeGroups as groups, classpilotCoverageScopeGroupMembers as members } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { auditLogs } from "../schema/shared.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool, type StaffAssignmentLifecycleLockDb } from "./staffAssignmentLifecycleLock.js";
import { lockActiveSchoolStudentsForOperationalWrite, replaceCoverageScopeGroupStaffInTransaction } from "./storage.js";
import { touchCoverageGroups } from "./classpilotCoverageDeletion.js";
import { touchCoverageCategories } from "./classpilotCoverageCategoryVersions.js";

type Tx = StaffAssignmentLifecycleLockDb;
export class CoverageDirectoryError extends Error {
  constructor(message: string, public code = "COVERAGE_DIRECTORY_INVALID", public status = 400) { super(message); }
}
function fail(message: string, code?: string, status?: number): never { throw new CoverageDirectoryError(message, code, status); }
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) fail(result.error.issues.slice(0, 10).map(issue => `${issue.path.join(".") || "Request"}: ${issue.message}`).join("; "));
  return result.data;
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const version = z.string().datetime({ precision: 3 });
const name = z.string().trim().min(1).max(80);
const idList = z.array(id).max(5000).refine(ids => new Set(ids).size === ids.length, "IDs must be unique");
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  search: z.string().trim().max(200).default(""),
  categoryId: z.string().max(128).default(""),
  grade: z.string().max(40).default(""),
  staffId: z.string().max(128).default(""),
  active: z.enum(["all", "true", "false"]).default("all"),
}).strict();
type Access = { schoolId: string; actorId: string; admin: boolean; schoolwide: boolean };
type GroupSummary = { id: string; schoolId: string; name: string; description: string | null; active: boolean; createdBy: string; createdAt: string; updatedAt: string; categoryId: string | null; category: { id: string; name: string } | null; studentCount: number; inactiveStudentCount: number; gradeCounts: Array<{ gradeLevel: string | null; count: number }>; staff: Array<{ id: string; displayName: string; email: string; assignmentId: string }> };
type Directory = { groups: GroupSummary[]; page: number; pageSize: number; total: number; totalPages: number; facets: { categories: Array<{ id: string; name: string }>; grades: Array<{ gradeLevel: string | null; count: number }>; staff: Array<{ id: string; displayName: string; email: string }> } };

async function accessFor(tx: Tx, schoolId: string, actorId: string): Promise<Access> {
  const [actor] = await tx.select({ isSuperAdmin: users.isSuperAdmin }).from(users).where(eq(users.id, actorId));
  const memberships = await tx.select({ role: schoolMemberships.role }).from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, actorId), eq(schoolMemberships.status, "active")));
  const admin = actor?.isSuperAdmin === true || memberships.some(row => ["admin", "school_admin"].includes(row.role));
  if (!admin && !memberships.some(row => ["admin", "school_admin", "teacher", "office_staff"].includes(row.role))) fail("Staff access required.", "FORBIDDEN", 403);
  const assignments = admin ? [] : await tx.select({ scopeType: classpilotCoverageAssignments.scopeType }).from(classpilotCoverageAssignments).where(and(eq(classpilotCoverageAssignments.schoolId, schoolId), eq(classpilotCoverageAssignments.staffId, actorId), eq(classpilotCoverageAssignments.active, true), sql`${classpilotCoverageAssignments.permissions}->>'setup' = 'true'`));
  if (!admin && !assignments.length) fail("Setup permission required.", "FORBIDDEN", 403);
  return { schoolId, actorId, admin, schoolwide: admin || assignments.some(row => row.scopeType === "setup" || row.scopeType === "school") };
}

// Alias s is always a same-school, active student. Matches the existing setup
// scope union, including class roster and coverage-group roster assignments.
function studentAllowed(access: Access): SQL {
  if (access.schoolwide) return sql`true`;
  return sql`EXISTS (SELECT 1 FROM classpilot_coverage_assignments a
    WHERE a.school_id=${access.schoolId} AND a.staff_id=${access.actorId} AND a.active=true AND a.permissions->>'setup'='true'
    AND (a.scope_type IN ('school','setup')
      OR (a.scope_type='grade' AND coalesce(s.grade_level,'')=coalesce(a.scope_value,''))
      OR (a.scope_type='students' AND EXISTS (SELECT 1 FROM unnest(string_to_array(a.scope_value,',')) chosen(id) WHERE btrim(chosen.id)=s.id))
      OR (a.scope_type='group' AND EXISTS (SELECT 1 FROM group_students gs JOIN groups cg ON cg.id=gs.group_id AND cg.school_id=${access.schoolId} WHERE gs.group_id=a.scope_value AND gs.student_id=s.id))
      OR (a.scope_type='coverage_group' AND EXISTS (SELECT 1 FROM classpilot_coverage_scope_group_members cm JOIN classpilot_coverage_scope_groups cg ON cg.id=cm.coverage_group_id AND cg.school_id=${access.schoolId} AND cg.active=true WHERE cm.school_id=${access.schoolId} AND cm.coverage_group_id=a.scope_value AND cm.student_id=s.id))))`;
}
function groupAllowed(access: Access): SQL {
  if (access.schoolwide) return sql`true`;
  const activeMembers = sql`SELECT 1 FROM classpilot_coverage_scope_group_members m JOIN students s ON s.id=m.student_id AND s.school_id=${access.schoolId} AND s.status='active' WHERE m.school_id=${access.schoolId} AND m.coverage_group_id=g.id`;
  return sql`((EXISTS (${activeMembers}) AND NOT EXISTS (${activeMembers} AND NOT (${studentAllowed(access)}))) OR (g.created_by=${access.actorId} AND NOT EXISTS (${activeMembers})))`;
}
const staffRows = sql`SELECT DISTINCT ON(a.staff_id) a.staff_id AS id, a.id AS assignment_id,
  coalesce(nullif(u.display_name,''),nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email,u.id) AS display_name, u.email
  FROM classpilot_coverage_assignments a JOIN school_memberships sm ON sm.school_id=a.school_id AND sm.user_id=a.staff_id AND sm.status='active' AND sm.role IN ('admin','school_admin','teacher','office_staff')
  JOIN users u ON u.id=a.staff_id WHERE a.school_id=g.school_id AND a.scope_type='coverage_group' AND a.scope_value=g.id AND a.active=true
  AND (a.permissions->>'claim'='true' OR a.permissions->>'observe'='true') ORDER BY a.staff_id,a.id`;
function visibleCte(access: Access, groupId?: string, justSaved = false) {
  return sql`visible AS (SELECT g.* FROM classpilot_coverage_scope_groups g WHERE g.school_id=${access.schoolId} AND ${groupId ? sql`g.id=${groupId}` : sql`true`} AND ${justSaved ? sql`true` : groupAllowed(access)}),
  summaries AS (SELECT g.id,g.active,g.name,g.category_id,
    jsonb_build_object('id',g.id,'schoolId',g.school_id,'name',g.name,'description',g.description,'active',g.active,'createdBy',g.created_by,
      'createdAt',to_char(g.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(g.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'categoryId',g.category_id,'category',CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'name',c.name) END,
      'studentCount',(SELECT count(*) FROM classpilot_coverage_scope_group_members m JOIN students s ON s.id=m.student_id AND s.school_id=g.school_id AND s.status='active' WHERE m.school_id=g.school_id AND m.coverage_group_id=g.id),
      'inactiveStudentCount',(SELECT count(*) FROM classpilot_coverage_scope_group_members m JOIN students s ON s.id=m.student_id AND s.school_id=g.school_id AND s.status<>'active' WHERE m.school_id=g.school_id AND m.coverage_group_id=g.id),
      'gradeCounts',coalesce((SELECT jsonb_agg(jsonb_build_object('gradeLevel',r.grade_level,'count',r.count) ORDER BY r.grade_level NULLS LAST) FROM (SELECT nullif(s.grade_level,'') AS grade_level,count(*) FROM classpilot_coverage_scope_group_members m JOIN students s ON s.id=m.student_id AND s.school_id=g.school_id AND s.status='active' WHERE m.school_id=g.school_id AND m.coverage_group_id=g.id GROUP BY nullif(s.grade_level,'')) r),'[]'::jsonb),
      'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'displayName',r.display_name,'email',r.email,'assignmentId',r.assignment_id) ORDER BY r.display_name,r.id) FROM (${staffRows}) r),'[]'::jsonb)) AS item
    FROM visible g LEFT JOIN classpilot_coverage_group_categories c ON c.school_id=g.school_id AND c.id=g.category_id)`;
}
async function read<T>(schoolId: string, actorId: string, operation: (tx: Tx, access: Access) => Promise<T>) {
  return db.transaction(async tx => operation(tx, await accessFor(tx, schoolId, actorId)), { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function browseCoverageGroups(options: { schoolId: string; actorId: string; query: unknown }): Promise<Directory> {
  const q = parse(querySchema, options.query);
  return read(options.schoolId, options.actorId, async (tx, access) => {
    const conditions: SQL[] = [sql`true`];
    if (q.active !== "all") conditions.push(sql`active=${q.active === "true"}`);
    if (q.categoryId) conditions.push(q.categoryId === "uncategorized" ? sql`category_id IS NULL` : sql`category_id=${q.categoryId}`);
    if (q.grade) conditions.push(sql`EXISTS (SELECT 1 FROM jsonb_array_elements(item->'gradeCounts') x WHERE ${q.grade === "ungraded" ? sql`x->>'gradeLevel' IS NULL` : sql`x->>'gradeLevel'=${q.grade}`})`);
    if (q.staffId) conditions.push(q.staffId === "unassigned" ? sql`jsonb_array_length(item->'staff')=0` : sql`EXISTS(SELECT 1 FROM jsonb_array_elements(item->'staff') x WHERE x->>'id'=${q.staffId})`);
    // strpos treats %, _ and backslash literally, unlike a LIKE pattern.
    if (q.search) conditions.push(sql`strpos(lower(concat_ws(' ',name,item->>'description',item->'category'->>'name',(SELECT string_agg(concat_ws(' ',x->>'displayName',x->>'email'),' ') FROM jsonb_array_elements(item->'staff') x))),lower(${q.search}))>0`);
    const result = await tx.execute<{ result: Directory }>(sql`WITH ${visibleCte(access)}, filtered AS (SELECT * FROM summaries WHERE ${sql.join(conditions, sql` AND `)}),
      counts AS (SELECT count(*)::int total FROM filtered), paging AS (SELECT total,greatest(1,ceil(total/25.0)::int) pages,least(${q.page},greatest(1,ceil(total/25.0)::int)) page FROM counts)
      SELECT jsonb_build_object('groups',coalesce((SELECT jsonb_agg(item ORDER BY lower(name),id) FROM (SELECT * FROM filtered ORDER BY lower(name),id LIMIT 25 OFFSET (SELECT (page-1)*25 FROM paging)) p),'[]'::jsonb),
        'page',page,'pageSize',25,'total',total,'totalPages',pages,
        'facets',jsonb_build_object(
          'categories',coalesce((SELECT jsonb_agg(c ORDER BY c->>'name',c->>'id') FROM (SELECT DISTINCT item->'category' c FROM summaries WHERE category_id IS NOT NULL) x),'[]'::jsonb),
          'grades',coalesce((SELECT jsonb_agg(jsonb_build_object('gradeLevel',grade,'count',n) ORDER BY grade NULLS LAST) FROM (SELECT x->>'gradeLevel' grade,count(*) n FROM summaries CROSS JOIN LATERAL jsonb_array_elements(item->'gradeCounts') x GROUP BY x->>'gradeLevel') x),'[]'::jsonb),
          'staff',coalesce((SELECT jsonb_agg(x ORDER BY x->>'displayName',x->>'id') FROM (SELECT DISTINCT x-'assignmentId' x FROM summaries CROSS JOIN LATERAL jsonb_array_elements(item->'staff') x) s),'[]'::jsonb))) result FROM paging`);
    return result.rows[0]!.result;
  });
}
export async function getCoverageGroupDetail(options: { schoolId: string; actorId: string; groupId: string; summaryOnly?: boolean }) {
  parse(id, options.groupId);
  return read(options.schoolId, options.actorId, (tx, access) => groupDetail(tx, access, options.groupId, options.summaryOnly));
}
async function groupDetail(tx: Tx, access: Access, groupId: string, summaryOnly = false, justSaved = false) {
    const result = await tx.execute<{ item: GroupSummary }>(sql`WITH ${visibleCte(access, groupId, justSaved)} SELECT item FROM summaries`);
    const group = result.rows[0]?.item;
    if (!group) fail("Supervision group not found.", "NOT_FOUND", 404);
    if (summaryOnly) return { group };
    const rows = await tx.select({ studentId: students.id, firstName: students.firstName, lastName: students.lastName, studentEmail: students.email, gradeLevel: students.gradeLevel }).from(members)
      .innerJoin(students, and(eq(students.id, members.studentId), eq(students.schoolId, access.schoolId), eq(students.status, "active")))
      .where(and(eq(members.schoolId, access.schoolId), eq(members.coverageGroupId, groupId))).orderBy(students.lastName, students.firstName, students.id);
    return { group: { ...group, students: rows.map(row => ({ studentId: row.studentId, studentName: [row.firstName,row.lastName].filter(Boolean).join(" ") || row.studentEmail || row.studentId, studentEmail: row.studentEmail || undefined, gradeLevel: row.gradeLevel || undefined })) } };
}
export async function listCoverageCategories(options: { schoolId: string; actorId: string }) {
  return read(options.schoolId, options.actorId, async (tx, access) => {
    const result = await tx.execute<{ id: string; name: string; updatedAt: string; groupCount: number }>(sql`WITH visible AS (SELECT g.id,g.category_id FROM classpilot_coverage_scope_groups g WHERE g.school_id=${options.schoolId} AND ${groupAllowed(access)})
      SELECT c.id,c.name,to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",(SELECT count(*)::int FROM visible v WHERE v.category_id=c.id) AS "groupCount"
      FROM classpilot_coverage_group_categories c WHERE c.school_id=${options.schoolId} ORDER BY lower(c.name),c.id`);
    return { categories: result.rows };
  });
}
async function write<T>(schoolId: string, actorId: string, operation: (tx: Tx, access: Access) => Promise<T>) {
  return db.transaction(async tx => {
    if (!await lockStaffAssignmentLifecycleSchool(tx, schoolId)) fail("School not found.", "NOT_FOUND", 404);
    await assertClasspilotEntitled(schoolId, tx as unknown as typeof db, { lock: true });
    return operation(tx, await accessFor(tx, schoolId, actorId));
  });
}
export async function mutateCoverageCategory(options: { schoolId: string; actorId: string; categoryId?: string; remove?: boolean; body: unknown }) {
  const input = parse(options.remove ? z.object({ updatedAt: version }).strict() : options.categoryId ? z.object({ name, updatedAt: version }).strict() : z.object({ name }).strict(), options.body);
  if (options.categoryId) parse(id, options.categoryId);
  return write(options.schoolId, options.actorId, async (tx, access) => {
    if (!access.admin) fail("Administrator access is required to manage categories.", "FORBIDDEN", 403);
    const [existing] = options.categoryId ? await tx.select().from(categories).where(and(eq(categories.schoolId, options.schoolId), eq(categories.id, options.categoryId))).for("update") : [];
    if (options.categoryId && !existing) fail("Category not found.", "NOT_FOUND", 404);
    if (existing && (!("updatedAt" in input) || existing.updatedAt.toISOString() !== input.updatedAt)) fail("This category or its groups changed. Reload categories and review again.", "COVERAGE_CATEGORY_STALE", 409);
    if ("name" in input) {
      const duplicate = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.schoolId, options.schoolId), sql`lower(btrim(${categories.name}))=lower(${input.name})`));
      if (duplicate.some(row => row.id !== existing?.id)) fail("A category with this name already exists.", "COVERAGE_CATEGORY_DUPLICATE", 409);
    }
    if (options.remove && existing) {
      const moved = await tx.update(groups).set({ categoryId: null }).where(and(eq(groups.schoolId, options.schoolId), eq(groups.categoryId, existing.id))).returning({ id: groups.id });
      await touchCoverageGroups(tx, options.schoolId, moved.map(row => row.id));
      await tx.delete(categories).where(and(eq(categories.schoolId, options.schoolId), eq(categories.id, existing.id)));
      await tx.insert(auditLogs).values({ schoolId: options.schoolId, userId: options.actorId, action: "coverage.category.delete", entityType: "coverage_group_category", entityId: existing.id, entityName: existing.name, changes: { movedGroupCount: moved.length } });
      return { success: true, categoryId: existing.id, movedGroupCount: moved.length };
    }
    if (!("name" in input)) fail("Category name is required.");
    let saved;
    if (existing) {
      [saved] = await tx.update(categories).set({ name: input.name }).where(and(eq(categories.schoolId, options.schoolId), eq(categories.id, existing.id))).returning();
      await touchCoverageCategories(tx, options.schoolId, [existing.id]);
      const affected = await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolId, options.schoolId), eq(groups.categoryId, existing.id)));
      await touchCoverageGroups(tx, options.schoolId, affected.map(row => row.id));
      [saved] = await tx.select().from(categories).where(and(eq(categories.schoolId, options.schoolId), eq(categories.id, existing.id)));
    } else [saved] = await tx.insert(categories).values({ schoolId: options.schoolId, name: input.name }).returning();
    await tx.insert(auditLogs).values({ schoolId: options.schoolId, userId: options.actorId, action: existing ? "coverage.category.update" : "coverage.category.create", entityType: "coverage_group_category", entityId: saved!.id, entityName: saved!.name, changes: { name: saved!.name } });
    return { category: saved! };
  });
}

const groupInput = z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(4000).nullable().optional(), active: z.boolean().optional(), categoryId: id.nullable().optional(), studentIds: idList.optional(), staffIds: idList.optional(), updatedAt: version.optional() }).strict();
/** One commit for metadata, membership, staff pairings and audit. Legacy PATCH
 * remains partial; the new editor supplies every field and its reviewed version. */
export async function saveCoverageDirectoryGroup(options: { schoolId: string; actorId: string; groupId?: string; body: unknown }) {
  const input = parse(groupInput, options.body);
  if (!options.groupId && !input.name) fail("Group name is required.");
  if (options.groupId) parse(id, options.groupId);
  return write(options.schoolId, options.actorId, async (tx, access) => {
    const [existing] = options.groupId ? await tx.select().from(groups).where(and(eq(groups.schoolId, options.schoolId), eq(groups.id, options.groupId))).for("update") : [];
    if (options.groupId && !existing) fail("Supervision group not found.", "NOT_FOUND", 404);
    if (existing) {
      const allowed = await tx.execute(sql`SELECT 1 FROM classpilot_coverage_scope_groups g WHERE g.school_id=${options.schoolId} AND g.id=${existing.id} AND ${groupAllowed(access)}`);
      if (!allowed.rows.length) fail("Supervision group is outside your setup scope.", "FORBIDDEN", 403);
      if (input.updatedAt && input.updatedAt !== existing.updatedAt.toISOString()) fail("This supervision group changed. Reload it before saving.", "COVERAGE_GROUP_STALE", 409);
    }
    if (input.categoryId) {
      const found = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.schoolId, options.schoolId), eq(categories.id, input.categoryId)));
      if (!found.length) fail("The selected category is no longer available. Choose a current category.", "COVERAGE_CATEGORY_STALE", 409);
    }
    if (input.staffIds?.length) {
      const found = await tx.execute<{ id: string }>(sql`SELECT DISTINCT user_id id FROM school_memberships WHERE school_id=${options.schoolId} AND status='active' AND role IN ('admin','school_admin','teacher','office_staff') AND user_id IN (${sql.join(input.staffIds.map(staffId => sql`${staffId}`), sql`,`)})`);
      if (found.rows.length !== input.staffIds.length) fail("One or more staff members are no longer active at this school.", "STAFF_MEMBERSHIP_NOT_FOUND", 409);
    }
    const studentIds = input.studentIds ?? (existing ? undefined : []);
    if (studentIds) {
      await lockActiveSchoolStudentsForOperationalWrite(options.schoolId, studentIds, tx as unknown as typeof db);
      if (!access.schoolwide && studentIds.length) {
        const result = await tx.execute(sql`SELECT s.id FROM students s WHERE s.school_id=${options.schoolId} AND s.status='active' AND s.id IN (${sql.join(studentIds.map(studentId => sql`${studentId}`), sql`,`)}) AND ${studentAllowed(access)}`);
        if (result.rows.length !== studentIds.length) fail("One or more students are outside your setup scope.", "FORBIDDEN", 403);
      }
    }
    const metadata = { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.active !== undefined ? { active: input.active } : {}), ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}) };
    const [saved] = existing
      ? await tx.update(groups).set({ ...metadata, updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), ${groups.updatedAt}+interval '1 millisecond')` }).where(and(eq(groups.schoolId, options.schoolId), eq(groups.id, existing.id))).returning()
      : await tx.insert(groups).values({ schoolId: options.schoolId, name: input.name!, description: input.description ?? null, categoryId: input.categoryId ?? null, active: true, createdBy: options.actorId }).returning();
    if (!saved) fail("Unable to save supervision group.");
    if (studentIds) {
      await tx.delete(members).where(and(eq(members.schoolId, options.schoolId), eq(members.coverageGroupId, saved.id)));
      if (studentIds.length) await tx.insert(members).values(studentIds.map(studentId => ({ schoolId: options.schoolId, coverageGroupId: saved.id, studentId })));
    }
    if (input.staffIds !== undefined || !existing) await replaceCoverageScopeGroupStaffInTransaction(tx, { schoolId: options.schoolId, groupId: saved.id, staffIds: input.staffIds ?? [], createdBy: options.actorId });
    if (!existing || (input.categoryId !== undefined && input.categoryId !== existing.categoryId)) await touchCoverageCategories(tx, options.schoolId, [existing?.categoryId, saved.categoryId]);
    await tx.insert(auditLogs).values({ schoolId: options.schoolId, userId: options.actorId, action: existing ? "coverage.supervision_group.update" : "coverage.supervision_group.create", entityType: "coverage_scope_group", entityId: saved.id, entityName: saved.name, changes: { ...metadata, ...(studentIds ? { studentCount: studentIds.length } : {}), ...(input.staffIds ? { staffCount: input.staffIds.length } : {}) } });
    // Return this exact committed edit even when removing its last student
    // means a delegated editor will no longer see it in the directory.
    return groupDetail(tx, access, saved.id, false, true);
  });
}
