import { rosterError } from "./rosterIntegrationModel.js";
import type { RosterCatalogue, RosterPlan, RosterStep } from "./rosterIntegrationPlanner.js";

export type RosterFieldChange = { field: string; before: unknown; after: unknown; beforeLabel?: string; afterLabel?: string };
export type RosterMemberChange = { memberType: "student" | "teacher"; memberId: string; name: string; beforeRole: string | null; afterRole: string | null };
export type RosterStepReview = { name: string; fields: RosterFieldChange[]; members: RosterMemberChange[] };

/** Persist names and values with the plan. Review must never be re-derived from changing live records. */
export function attachRosterReview(steps: RosterStep[], catalogue: RosterCatalogue): void {
  const people = new Map(catalogue.students.map(row => [row.id, `${row.firstName} ${row.lastName}`.trim()]));
  const staff = new Map(catalogue.teachers.map(row => [row.id, row.name]));
  const students = new Map(catalogue.students.map(row => [row.id, row]));
  const classes = new Map(catalogue.classes.map(row => [row.id, row]));
  // New students do not yet exist in the catalogue, but have stable planned internal IDs.
  for (const step of steps.filter(row => row.kind === "student")) {
    const current = students.get(step.internalId);
    people.set(step.internalId, `${step.data.firstName ?? current?.firstName ?? ""} ${step.data.lastName ?? current?.lastName ?? ""}`.trim() || step.externalId);
  }
  for (const step of steps) {
    const current = step.kind === "student" ? students.get(step.internalId) : classes.get(step.internalId);
    const fields = Object.entries(step.data).filter(([key, value]) => key !== "emailLc" && key !== "archivedAt" && JSON.stringify((current as unknown as Record<string, unknown> | undefined)?.[key] ?? null) !== JSON.stringify(value ?? null)).map(([field, after]) => {
      const before = (current as unknown as Record<string, unknown> | undefined)?.[field] ?? null;
      return { field, before, after, ...(field === "teacherId" ? { beforeLabel: staff.get(String(before)) || String(before ?? "None"), afterLabel: staff.get(String(after)) || String(after ?? "None") } : {}) };
    });
    const members: RosterMemberChange[] = [];
    const group = classes.get(step.internalId);
    if (step.kind === "class") {
      const beforeStudents = new Set(group?.students.map(row => row.memberId) || []);
      const afterStudents = new Set(step.studentIds || []);
      for (const memberId of new Set([...beforeStudents, ...afterStudents])) if (beforeStudents.has(memberId) !== afterStudents.has(memberId)) members.push({ memberType: "student", memberId, name: people.get(memberId) || memberId, beforeRole: beforeStudents.has(memberId) ? "student" : null, afterRole: afterStudents.has(memberId) ? "student" : null });
      const beforeTeachers = new Map(group?.teachers.map(row => [row.memberId, row.memberId === group.teacherId ? "primary" : "co-teacher"]) || []);
      if (group) beforeTeachers.set(group.teacherId, "primary");
      const afterTeachers = new Map((step.coTeacherIds || []).map(id => [id, "co-teacher"]));
      if (step.primaryTeacherId) afterTeachers.set(step.primaryTeacherId, "primary");
      for (const memberId of new Set([...beforeTeachers.keys(), ...afterTeachers.keys()])) if (beforeTeachers.get(memberId) !== afterTeachers.get(memberId)) members.push({ memberType: "teacher", memberId, name: staff.get(memberId) || memberId, beforeRole: beforeTeachers.get(memberId) || null, afterRole: afterTeachers.get(memberId) || null });
    }
    members.sort((a, b) => a.memberType.localeCompare(b.memberType) || a.name.localeCompare(b.name) || a.memberId.localeCompare(b.memberId));
    step.review = { name: step.kind === "student" ? people.get(step.internalId) || step.externalId : step.kind === "teacher" ? staff.get(step.internalId) || step.externalId : String(step.data.name || group?.name || step.externalId), fields, members };
  }
}

export const ROSTER_REVIEW_PAGE_SIZE = 50;
export function assertRosterReviewPlan(plan: RosterPlan | null, planHash: string | null, requestedHash: string): asserts plan is RosterPlan {
  if (!plan || !planHash || requestedHash !== planHash || plan.reviewVersion !== 1 || plan.steps.some(step => !step.review)) throw rosterError("ROSTER_PREVIEW_STALE", "The review changed or is unavailable. Create a fresh preview.", 409);
}

/** A bounded flat stream lets even a very large class expose every named change through pagination. */
export function rosterReviewPage(plan: RosterPlan | null, planHash: string | null, requestedHash: string, page: number) {
  assertRosterReviewPlan(plan, planHash, requestedHash);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000) throw rosterError("ROSTER_INPUT_INVALID", "Invalid review page.");
  const rows: Array<{ stepIndex: number; kind: string; name: string; type: "field" | "membership" | "record"; field?: RosterFieldChange; member?: RosterMemberChange; create?: boolean }> = [];
  let total = 0;
  const start = page * ROSTER_REVIEW_PAGE_SIZE;
  for (const [stepIndex, step] of plan.steps.entries()) {
    const review = step.review!;
    const common = { stepIndex, kind: step.kind, name: review.name };
    const add = (entry: (typeof rows)[number]) => { if (total >= start && total < start + ROSTER_REVIEW_PAGE_SIZE) rows.push(entry); total++; };
    for (const field of review.fields) add({ ...common, type: "field", field });
    for (const member of review.members) add({ ...common, type: "membership", member });
    if (!review.fields.length && !review.members.length) add({ ...common, type: "record", create: step.create });
  }
  return { planHash, page, pageSize: ROSTER_REVIEW_PAGE_SIZE, total, rows };
}
