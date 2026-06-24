import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import {
  dismissalChanges,
  dismissalOverrides,
  dismissalQueue,
  dismissalSessions,
  parentStudent,
  type DismissalChange,
  type DismissalOverride,
  type DismissalQueueEntry,
} from "../schema/gopilot.js";
import { students, type Student } from "../schema/students.js";
import { getIO } from "../realtime/socketio.js";
import { createStudentTimelineEvent, getUserById } from "./storage.js";

export type OverrideApplication = {
  override: DismissalOverride;
  removedQueueEntries: DismissalQueueEntry[];
};

type OverrideInput = {
  schoolId: string;
  sessionId: string;
  student: Student;
  overrideType: string;
  busRoute?: string | null;
  reason?: string | null;
  changedBy: string;
  changedByRole: string;
};

function cleanBusRoute(overrideType: string, busRoute?: string | null): string | null {
  const value = typeof busRoute === "string" ? busRoute.trim() : "";
  return overrideType === "bus" && value ? value : null;
}

async function upsertOverrideAndQueueCleanup(
  input: OverrideInput
): Promise<OverrideApplication> {
  return db.transaction(async (tx) => {
    const [override] = await tx
      .insert(dismissalOverrides)
      .values({
        sessionId: input.sessionId,
        studentId: input.student.id,
        originalType: input.student.dismissalType ?? "car",
        overrideType: input.overrideType,
        busRoute: cleanBusRoute(input.overrideType, input.busRoute),
        reason: input.reason || null,
        changedBy: input.changedBy,
        changedByRole: input.changedByRole,
      })
      .onConflictDoUpdate({
        target: [dismissalOverrides.sessionId, dismissalOverrides.studentId],
        set: {
          overrideType: sql`EXCLUDED.override_type`,
          busRoute: sql`EXCLUDED.bus_route`,
          reason: sql`EXCLUDED.reason`,
          changedBy: sql`EXCLUDED.changed_by`,
          changedByRole: sql`EXCLUDED.changed_by_role`,
          createdAt: sql`now()`,
        },
      })
      .returning();

    const removedQueueEntries =
      input.overrideType === "afterschool"
        ? await tx
            .delete(dismissalQueue)
            .where(
              and(
                eq(dismissalQueue.sessionId, input.sessionId),
                eq(dismissalQueue.studentId, input.student.id)
              )
            )
            .returning()
        : [];

    return { override: override!, removedQueueEntries };
  });
}

export async function emitDismissalOverrideApplied(options: OverrideInput & OverrideApplication) {
  const io = getIO();
  const changer = await getUserById(options.changedBy);
  const changerName = changer
    ? `${changer.firstName} ${changer.lastName}`.trim() || changer.email
    : "Unknown";
  const busRoute = cleanBusRoute(options.overrideType, options.busRoute);
  const overrideEvent = {
    studentId: options.student.id,
    studentName: `${options.student.firstName} ${options.student.lastName}`.trim(),
    originalType: options.student.dismissalType ?? "car",
    overrideType: options.overrideType,
    busRoute,
    changedBy: changerName,
    changedByRole: options.changedByRole,
    reason: options.reason || null,
  };

  if (io) {
    const officeRoom = `school:${options.schoolId}:office`;
    const teacherRoom = options.student.homeroomId
      ? `school:${options.schoolId}:teacher:${options.student.homeroomId}`
      : null;

    io.to(officeRoom).emit("dismissal:override", overrideEvent);
    io.to(officeRoom).emit("student:typeUpdated", {
      studentId: options.student.id,
      dismissalType: options.overrideType,
      busRoute,
      isOverride: true,
    });

    if (teacherRoom) {
      io.to(teacherRoom).emit("dismissal:override", overrideEvent);
      io.to(teacherRoom).emit("student:typeUpdated", {
        studentId: options.student.id,
        dismissalType: options.overrideType,
        busRoute,
        isOverride: true,
      });
    }

    if (options.removedQueueEntries.length > 0) {
      const queuePayload = {
        action: "override_removed",
        studentId: options.student.id,
        entries: options.removedQueueEntries,
      };
      io.to(officeRoom).emit("queue:updated", queuePayload);
      if (teacherRoom) io.to(teacherRoom).emit("queue:updated", queuePayload);
    }

    if (options.changedByRole !== "parent") {
      const parentLinks = await db
        .select({ parentId: parentStudent.parentId })
        .from(parentStudent)
        .where(
          and(
            eq(parentStudent.studentId, options.student.id),
            eq(parentStudent.status, "approved")
          )
        );
      for (const link of parentLinks) {
        io.to(`school:${options.schoolId}:parent:${link.parentId}`).emit(
          "dismissal:override",
          overrideEvent
        );
      }
    }
  }

  await createStudentTimelineEvent({
    schoolId: options.schoolId,
    studentId: options.student.id,
    eventType: "dismissal",
    sourceType: "gopilot",
    sourceId: options.override.id,
    title: "Dismissal override",
    summary: `${options.student.dismissalType ?? "car"} to ${options.overrideType}${busRoute ? ` #${busRoute}` : ""}${options.reason ? `: ${options.reason}` : ""}`,
    actorUserId: options.changedBy,
    metadata: overrideEvent,
  });
}

export async function applySessionDismissalOverride(
  input: OverrideInput
): Promise<OverrideApplication> {
  const applied = await upsertOverrideAndQueueCleanup(input);
  await emitDismissalOverrideApplied({ ...input, ...applied });
  return applied;
}

export async function reviewDismissalChangeRequest(options: {
  changeId: string;
  schoolId: string;
  status: "approved" | "rejected";
  reviewedBy: string;
  changedByRole: string;
}): Promise<{
  change: DismissalChange;
  student: Student;
  override?: DismissalOverride;
  removedQueueEntries: DismissalQueueEntry[];
} | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ change: dismissalChanges, student: students })
      .from(dismissalChanges)
      .innerJoin(dismissalSessions, eq(dismissalChanges.sessionId, dismissalSessions.id))
      .innerJoin(students, eq(dismissalChanges.studentId, students.id))
      .where(
        and(
          eq(dismissalChanges.id, options.changeId),
          eq(dismissalSessions.schoolId, options.schoolId),
          eq(students.schoolId, options.schoolId)
        )
      )
      .limit(1);

    if (!row) return null;

    let override: DismissalOverride | undefined;
    let removedQueueEntries: DismissalQueueEntry[] = [];
    if (options.status === "approved") {
      const [overrideRow] = await tx
        .insert(dismissalOverrides)
        .values({
          sessionId: row.change.sessionId,
          studentId: row.change.studentId,
          originalType: row.change.fromType || row.student.dismissalType || "car",
          overrideType: row.change.toType,
          busRoute: cleanBusRoute(row.change.toType, row.change.busRoute),
          reason: row.change.note || null,
          changedBy: options.reviewedBy,
          changedByRole: options.changedByRole,
        })
        .onConflictDoUpdate({
          target: [dismissalOverrides.sessionId, dismissalOverrides.studentId],
          set: {
            overrideType: sql`EXCLUDED.override_type`,
            busRoute: sql`EXCLUDED.bus_route`,
            reason: sql`EXCLUDED.reason`,
            changedBy: sql`EXCLUDED.changed_by`,
            changedByRole: sql`EXCLUDED.changed_by_role`,
            createdAt: sql`now()`,
          },
        })
        .returning();
      override = overrideRow!;

      if (row.change.toType === "afterschool") {
        removedQueueEntries = await tx
          .delete(dismissalQueue)
          .where(
            and(
              eq(dismissalQueue.sessionId, row.change.sessionId),
              eq(dismissalQueue.studentId, row.change.studentId)
            )
          )
          .returning();
      }
    }

    const [change] = await tx
      .update(dismissalChanges)
      .set({
        status: options.status,
        reviewedBy: options.reviewedBy,
        reviewedAt: new Date(),
      })
      .where(eq(dismissalChanges.id, options.changeId))
      .returning();

    return {
      change: change!,
      student: row.student,
      override,
      removedQueueEntries,
    };
  });
}
