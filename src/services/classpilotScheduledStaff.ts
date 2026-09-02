import db from "../db.js";
import { getGroupTeachers } from "./storage.js";

/**
 * Staff who may start a scheduled class occurrence: the scheduled (primary)
 * teacher for that occurrence plus every `group_teachers` relationship on the
 * class (primary + co-teachers). The scheduled teacher is always listed first
 * so callers that pick "the first connected staff member" prefer them; the
 * remaining ids follow group_teachers role/assignment order.
 *
 * Eligibility only decides who may START the class. The session's teacherId
 * and the conflict row's teacherId stay the scheduled teacher (routing key,
 * summary recipient) regardless of which eligible staff member started it.
 */
export async function scheduledClassStaffIds(
  options: { groupId: string; scheduledTeacherId?: string | null },
  dbInstance: typeof db = db
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (options.scheduledTeacherId) ids.add(options.scheduledTeacherId);
  const teachers = await getGroupTeachers(options.groupId, dbInstance);
  for (const teacher of teachers) ids.add(teacher.teacherId);
  return ids;
}

export async function isScheduledClassStaff(
  options: { groupId: string; scheduledTeacherId?: string | null; userId: string },
  dbInstance: typeof db = db
): Promise<boolean> {
  if (!options.userId) return false;
  if (options.scheduledTeacherId && options.scheduledTeacherId === options.userId) return true;
  const staff = await scheduledClassStaffIds(options, dbInstance);
  return staff.has(options.userId);
}
