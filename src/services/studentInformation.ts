import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, ilike, lt, or, sql } from "drizzle-orm";
import { students } from "../schema/students.js";
import {
  studentContactProfiles as profiles,
  studentContactProfileVersions as versions,
} from "../schema/studentInformation.js";
import {
  withSharedStudentRecords,
  assertSharedStudentAccess,
  sharedStudentWhere,
  type SharedStudentActor,
  type SharedStudentIdentity,
} from "./sharedStudentRecords.js";
import type { MyDeskDatabase } from "./mydesk.js";
import { myDeskGradeSql, normalizeMyDeskGrade } from "./mydeskGrade.js";
import {
  contactProfile,
  informationError,
  informationSearch,
  profileSaveInput,
  type ContactChange,
  type ContactProfile,
} from "./studentInformationValidation.js";

import {
  informationHash,
  applyContactChanges,
} from "./studentInformationModel.js";
export {
  informationHash,
  applyContactChanges,
} from "./studentInformationModel.js";
export function informationAudit(
  actor: SharedStudentActor,
  action: string,
  ids: string[],
  count = ids.length,
) {
  console.info(
    JSON.stringify({
      event: "student_information",
      action,
      schoolId: actor.schoolId,
      actorId: actor.authorId,
      ids,
      count,
    }),
  );
}
export async function loadContactProfile(
  tx: MyDeskDatabase,
  actor: SharedStudentIdentity,
  studentId: string,
  lock = false,
  allowInactive = false,
) {
  let student;
  try {
    student = await assertSharedStudentAccess(tx, actor, studentId, {
      lock,
      allowInactiveForAdmin: allowInactive,
    });
  } catch (error) {
    if (
      !actor.manager ||
      !allowInactive ||
      !(error instanceof Error) ||
      !("status" in error) ||
      error.status !== 404
    )
      throw error;
    const [historical] = await tx
      .select()
      .from(profiles)
      .where(
        and(
          eq(profiles.schoolId, actor.schoolId),
          eq(profiles.filingStudentId, studentId),
          sql`${profiles.studentId} IS NULL`,
        ),
      );
    if (!historical) throw error;
    student = {
      id: studentId,
      name: historical.studentName,
      firstName: "",
      lastName: "",
      gradeLevel: null,
      status: "deleted",
    };
  }
  if (lock)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`student-contact:${actor.schoolId}:${studentId}`},0))`,
    );
  const query = tx
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.schoolId, actor.schoolId),
        eq(profiles.filingStudentId, studentId),
      ),
    );
  const [profile] = await (lock ? query.for("update") : query);
  return { student, profile };
}
export async function saveContactChanges(
  tx: MyDeskDatabase,
  actor: SharedStudentIdentity,
  studentId: string,
  input: ReturnType<typeof profileSaveInput.parse>,
  importId?: string,
) {
  const { student, profile } = await loadContactProfile(
    tx,
    actor,
    studentId,
    true,
    true,
  );
  const fingerprint = informationHash({ studentId, ...input });
  const prior = profile?.mutationReceipts.find((r) => r.id === input.requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw informationError(
        409,
        "REQUEST_CONFLICT",
        "This request identifier was used for different changes",
      );
    return { student, profile, replayed: true };
  }
  const [receipt] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.schoolId, actor.schoolId),
        eq(versions.authorId, actor.authorId),
        eq(versions.requestId, input.requestId),
      ),
    );
  if (receipt) {
    if (receipt.requestFingerprint !== fingerprint)
      throw informationError(
        409,
        "REQUEST_CONFLICT",
        "This request identifier was used for different changes",
      );
    return {
      student,
      profile: { ...profile!, data: receipt.data, revision: receipt.revision },
      replayed: true,
    };
  }
  if ((profile?.revision ?? 0) !== input.revision)
    throw informationError(
      409,
      "PROFILE_CHANGED",
      "This profile changed. Review the current values before saving",
    );
  const data = applyContactChanges(
    profile?.data ?? { contacts: [] },
    input.changes,
  );
  const changed =
    informationHash(data) !==
    informationHash(profile?.data ?? { contacts: [] });
  const id = profile?.id ?? randomUUID(),
    revision = (profile?.revision ?? 0) + (changed ? 1 : 0),
    updatedAt = new Date();
  const mutationReceipts = [
    ...(profile?.mutationReceipts ?? []),
    { id: input.requestId, fingerprint, revision, kind: "save" },
  ].slice(-100);
  const liveStudentId = student.status === "deleted" ? null : studentId;
  const [saved] = await tx
    .insert(profiles)
    .values({
      id,
      schoolId: actor.schoolId,
      studentId: liveStudentId,
      filingStudentId: studentId,
      studentName: student.name,
      data,
      revision,
      mutationReceipts,
      updatedBy: actor.authorId,
      updatedByName: actor.name,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [profiles.schoolId, profiles.filingStudentId],
      set: changed
        ? {
            studentId: liveStudentId,
            studentName: student.name,
            data,
            revision,
            mutationReceipts,
            updatedBy: actor.authorId,
            updatedByName: actor.name,
            updatedAt,
          }
        : { mutationReceipts },
    })
    .returning();
  if (changed)
    await tx.insert(versions).values({
      schoolId: actor.schoolId,
      authorId: actor.authorId,
      authorName: actor.name,
      profileId: id,
      revision,
      requestId: input.requestId,
      requestFingerprint: fingerprint,
      data,
      changes: input.changes,
      reason: input.reason,
      importId,
    });
  return { student, profile: saved, replayed: false };
}
export const getStudentContactProfile = (
  actor: SharedStudentActor,
  studentId: string,
) =>
  withSharedStudentRecords(actor, async (tx, identity) => {
    const found = await loadContactProfile(
      tx,
      identity,
      studentId,
      false,
      true,
    );
    return {
      student: found.student,
      profile: found.profile ?? {
        id: null,
        data: { contacts: [] },
        revision: 0,
        updatedAt: null,
        updatedByName: null,
      },
    };
  });
export async function updateStudentContactProfile(
  actor: SharedStudentActor,
  studentId: string,
  raw: unknown,
) {
  const input = profileSaveInput.parse(raw);
  const result = await withSharedStudentRecords(
    actor,
    (tx, identity) => saveContactChanges(tx, identity, studentId, input),
    { lifecycle: true },
  );
  informationAudit(actor, "profile_reviewed", [studentId]);
  return result;
}
export const listStudentContactHistory = (
  actor: SharedStudentActor,
  studentId: string,
  cursor?: number,
) =>
  withSharedStudentRecords(actor, async (tx, identity) => {
    const { student, profile } = await loadContactProfile(
      tx,
      identity,
      studentId,
      false,
      true,
    );
    const rows = profile
      ? await tx
          .select({
            id: versions.id,
            revision: versions.revision,
            data: versions.data,
            changes: versions.changes,
            reason: versions.reason,
            authorName: versions.authorName,
            createdAt: versions.createdAt,
          })
          .from(versions)
          .where(
            and(
              eq(versions.schoolId, actor.schoolId),
              eq(versions.profileId, profile.id),
              cursor ? lt(versions.revision, cursor) : undefined,
            ),
          )
          .orderBy(desc(versions.revision))
          .limit(31)
      : [];
    return {
      student,
      versions: rows.slice(0, 30),
      nextCursor: rows.length > 30 ? rows[29]!.revision : null,
    };
  });
export const searchStudentInformation = (
  actor: SharedStudentActor,
  raw: unknown,
) =>
  withSharedStudentRecords(actor, async (tx, identity) => {
    const input = informationSearch.parse(raw),
      q = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await tx
      .select({
        id: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        gradeLevel: students.gradeLevel,
        status: students.status,
        revision: profiles.revision,
        updatedAt: profiles.updatedAt,
        updatedByName: profiles.updatedByName,
      })
      .from(students)
      .leftJoin(
        profiles,
        and(
          eq(profiles.schoolId, actor.schoolId),
          eq(profiles.filingStudentId, students.id),
        ),
      )
      .where(
        and(
          sharedStudentWhere(identity, {
            includeInactive: input.includeInactive,
          }),
          input.cursor ? gt(students.id, input.cursor) : undefined,
          input.q
            ? ilike(sql`${students.firstName}||' '||${students.lastName}`, q)
            : undefined,
          input.gradeLevel
            ? input.gradeLevel === "unrecorded"
              ? sql`${myDeskGradeSql(students.gradeLevel)} IS NULL`
              : sql`${myDeskGradeSql(students.gradeLevel)} = ${normalizeMyDeskGrade(input.gradeLevel)}`
            : undefined,
          input.classId
            ? sql`EXISTS(SELECT 1 FROM group_students gs JOIN groups g ON g.id=gs.group_id WHERE gs.student_id=${students.id} AND g.id=${input.classId} AND g.school_id=${actor.schoolId} AND g.group_type='admin_class' AND g.status='active')`
            : undefined,
        ),
      )
      .orderBy(students.id)
      .limit(input.limit + 1);
    const current = rows.map((s) => ({
      ...s,
      name: `${s.firstName} ${s.lastName}`.trim(),
    }));
    const historical =
      identity.manager &&
      input.includeInactive &&
      !input.classId &&
      !input.gradeLevel
        ? await tx
            .select({
              id: profiles.filingStudentId,
              name: profiles.studentName,
              revision: profiles.revision,
              updatedAt: profiles.updatedAt,
              updatedByName: profiles.updatedByName,
            })
            .from(profiles)
            .where(
              and(
                eq(profiles.schoolId, actor.schoolId),
                sql`${profiles.studentId} IS NULL`,
                input.cursor
                  ? gt(profiles.filingStudentId, input.cursor)
                  : undefined,
                input.q ? ilike(profiles.studentName, q) : undefined,
              ),
            )
            .orderBy(profiles.filingStudentId)
            .limit(input.limit + 1)
        : [];
    const combined = [
      ...current,
      ...historical.map((s) => ({
        ...s,
        firstName: "",
        lastName: "",
        gradeLevel: null,
        status: "deleted",
      })),
    ].sort((a, b) => a.id.localeCompare(b.id));
    return {
      students: combined.slice(0, input.limit),
      nextCursor:
        combined.length > input.limit ? combined[input.limit - 1]!.id : null,
      canViewInactive: identity.manager,
    };
  });
