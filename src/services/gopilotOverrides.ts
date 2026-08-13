import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import {
  dismissalChanges,
  dismissalOverrides,
  dismissalQueue,
  dismissalSessions,
  activityLog,
  type DismissalChange,
  type DismissalOverride,
  type DismissalQueueEntry,
} from "../schema/gopilot.js";
import { students, type Student } from "../schema/students.js";
import { broadcastGoPilot } from "../realtime/socketio.js";
import { createStudentTimelineEvent, getUserById } from "./storage.js";

export type OverrideApplication = {
  override: DismissalOverride;
  removedQueueEntries: DismissalQueueEntry[];
  queueChanged: boolean;
};

export class GoPilotOverrideConflictError extends Error {
  constructor(
    message: string,
    public readonly code: string = "GOPILOT_OVERRIDE_CONFLICT"
  ) {
    super(message);
  }
}

const VALID_DISMISSAL_TYPES = new Set(["car", "bus", "walker", "afterschool"]);

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
    const [session] = await tx
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, input.sessionId),
          eq(dismissalSessions.schoolId, input.schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!session || session.status !== "active") {
      throw new GoPilotOverrideConflictError("Dismissal session is not active", "GOPILOT_SESSION_NOT_ACTIVE");
    }
    const [currentStudent] = await tx
      .select()
      .from(students)
      .where(and(eq(students.id, input.student.id), eq(students.schoolId, input.schoolId)))
      .limit(1);
    if (!currentStudent || currentStudent.status !== "active") {
      throw new GoPilotOverrideConflictError("Student is not active at this school", "GOPILOT_STUDENT_NOT_ACTIVE");
    }
    if (!VALID_DISMISSAL_TYPES.has(input.overrideType)) {
      throw new GoPilotOverrideConflictError("Invalid dismissal type", "GOPILOT_INVALID_DISMISSAL_TYPE");
    }
    if (input.overrideType === "bus" && !cleanBusRoute("bus", input.busRoute)) {
      throw new GoPilotOverrideConflictError("A bus route is required for bus dismissal", "GOPILOT_BUS_ROUTE_REQUIRED");
    }
    const [queuedEntry] = await tx
      .select()
      .from(dismissalQueue)
      .where(
        and(
          eq(dismissalQueue.schoolId, input.schoolId),
          eq(dismissalQueue.sessionId, input.sessionId),
          eq(dismissalQueue.studentId, input.student.id)
        )
      )
      .limit(1)
      .for("update");
    if (queuedEntry && queuedEntry.status !== "waiting") {
      throw new GoPilotOverrideConflictError(
        "Queued students can only be reclassified before they are called",
        "GOPILOT_QUEUE_ALREADY_PROGRESSED"
      );
    }

    const [override] = await tx
      .insert(dismissalOverrides)
      .values({
        schoolId: input.schoolId,
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
      queuedEntry && input.overrideType === "afterschool"
        ? await tx
            .delete(dismissalQueue)
            .where(
              and(
                eq(dismissalQueue.schoolId, input.schoolId),
                eq(dismissalQueue.sessionId, input.sessionId),
                eq(dismissalQueue.studentId, input.student.id),
                eq(dismissalQueue.status, "waiting")
              )
            )
            .returning()
        : [];

    if (queuedEntry && input.overrideType !== "afterschool") {
      const busRoute = cleanBusRoute(input.overrideType, input.busRoute);
      const queueUpdate = input.overrideType === "bus"
        ? {
            checkInMethod: "bus_number",
            guardianName: `Bus #${busRoute}`,
            pickupGroupId: `bus:${busRoute}`,
            pickupGroupLabel: `Bus #${busRoute}`,
          }
        : input.overrideType === "walker"
          ? {
              checkInMethod: "walker",
              guardianName: "Walkers",
              pickupGroupId: "walkers:override",
              pickupGroupLabel: "Walkers",
            }
          : {
              checkInMethod: "car_number",
              pickupGroupId: queuedEntry.pickupGroupId,
              pickupGroupLabel: queuedEntry.pickupGroupLabel,
            };
      const [updatedQueue] = await tx
        .update(dismissalQueue)
        .set(queueUpdate)
        .where(
          and(
            eq(dismissalQueue.id, queuedEntry.id),
            eq(dismissalQueue.schoolId, input.schoolId),
            eq(dismissalQueue.status, "waiting")
          )
        )
        .returning({ id: dismissalQueue.id });
      if (!updatedQueue) {
        throw new GoPilotOverrideConflictError(
          "Queue state changed while the override was being applied",
          "GOPILOT_QUEUE_STATE_CONFLICT"
        );
      }
    }

    await tx.insert(activityLog).values({
      schoolId: input.schoolId,
      sessionId: input.sessionId,
      actorId: input.changedBy,
      action: "dismissal.override_applied",
      entityType: "student",
      entityId: input.student.id,
      details: {
        originalType: input.student.dismissalType ?? "car",
        overrideType: input.overrideType,
        removedWaitingQueueCount: removedQueueEntries.length,
      },
    });

    return { override: override!, removedQueueEntries, queueChanged: Boolean(queuedEntry) };
  });
}

export async function emitDismissalOverrideApplied(options: OverrideInput & OverrideApplication) {
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

  const officeRoom = `school:${options.schoolId}:office`;
  const teacherRoom = options.student.homeroomId
    ? `school:${options.schoolId}:teacher:${options.student.homeroomId}`
    : null;

  await broadcastGoPilot(officeRoom, "dismissal:override", overrideEvent);
  await broadcastGoPilot(officeRoom, "student:typeUpdated", {
      studentId: options.student.id,
      dismissalType: options.overrideType,
      busRoute,
      isOverride: true,
  });

  if (teacherRoom) {
    await broadcastGoPilot(teacherRoom, "dismissal:override", overrideEvent);
    await broadcastGoPilot(teacherRoom, "student:typeUpdated", {
        studentId: options.student.id,
        dismissalType: options.overrideType,
        busRoute,
        isOverride: true,
    });
  }

  if (options.queueChanged) {
    const queuePayload = {
      action: options.removedQueueEntries.length > 0 ? "override_removed" : "override_reclassified",
      studentId: options.student.id,
      entries: options.removedQueueEntries.map((entry) => ({
        id: entry.id,
        queueId: entry.id,
        studentId: entry.studentId,
        status: entry.status,
      })),
    };
    await broadcastGoPilot(officeRoom, "queue:updated", queuePayload);
    if (teacherRoom) await broadcastGoPilot(teacherRoom, "queue:updated", queuePayload);
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

export async function revertSessionDismissalOverride(options: {
  schoolId: string;
  sessionId: string;
  studentId: string;
  changedBy: string;
}): Promise<{
  student: Student;
  deletedOverride: DismissalOverride;
  queueChanged: boolean;
} | null> {
  const reverted = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, options.sessionId),
          eq(dismissalSessions.schoolId, options.schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!session || session.status !== "active") {
      throw new GoPilotOverrideConflictError("Dismissal session is not active", "GOPILOT_SESSION_NOT_ACTIVE");
    }
    const [student] = await tx
      .select()
      .from(students)
      .where(
        and(
          eq(students.id, options.studentId),
          eq(students.schoolId, options.schoolId),
          eq(students.status, "active")
        )
      )
      .limit(1);
    if (!student) return null;
    const [override] = await tx
      .select()
      .from(dismissalOverrides)
      .where(
        and(
          eq(dismissalOverrides.schoolId, options.schoolId),
          eq(dismissalOverrides.sessionId, options.sessionId),
          eq(dismissalOverrides.studentId, options.studentId)
        )
      )
      .limit(1)
      .for("update");
    if (!override) return null;
    const [queue] = await tx
      .select()
      .from(dismissalQueue)
      .where(
        and(
          eq(dismissalQueue.schoolId, options.schoolId),
          eq(dismissalQueue.sessionId, options.sessionId),
          eq(dismissalQueue.studentId, options.studentId)
        )
      )
      .limit(1)
      .for("update");
    if (queue && queue.status !== "waiting") {
      throw new GoPilotOverrideConflictError(
        "Queued students can only be reverted before they are called",
        "GOPILOT_QUEUE_ALREADY_PROGRESSED"
      );
    }

    const [deletedOverride] = await tx
      .delete(dismissalOverrides)
      .where(
        and(
          eq(dismissalOverrides.id, override.id),
          eq(dismissalOverrides.schoolId, options.schoolId)
        )
      )
      .returning();
    if (!deletedOverride) {
      throw new GoPilotOverrideConflictError("Dismissal override changed concurrently");
    }

    if (queue) {
      const permanentType = student.dismissalType ?? "car";
      if (permanentType === "afterschool") {
        await tx
          .delete(dismissalQueue)
          .where(
            and(
              eq(dismissalQueue.id, queue.id),
              eq(dismissalQueue.schoolId, options.schoolId),
              eq(dismissalQueue.status, "waiting")
            )
          );
      } else {
        const [updated] = await tx
          .update(dismissalQueue)
          .set({
            checkInMethod: permanentType === "bus" ? "bus_number" : permanentType === "walker" ? "walker" : "car_number",
            guardianName: permanentType === "bus" && student.busRoute
              ? `Bus #${student.busRoute}`
              : permanentType === "walker" ? "Walkers" : queue.guardianName,
            pickupGroupId: permanentType === "bus" && student.busRoute
              ? `bus:${student.busRoute}`
              : permanentType === "walker" ? "walkers:revert" : queue.pickupGroupId,
            pickupGroupLabel: permanentType === "bus" && student.busRoute
              ? `Bus #${student.busRoute}`
              : permanentType === "walker" ? "Walkers" : queue.pickupGroupLabel,
          })
          .where(
            and(
              eq(dismissalQueue.id, queue.id),
              eq(dismissalQueue.schoolId, options.schoolId),
              eq(dismissalQueue.status, "waiting")
            )
          )
          .returning({ id: dismissalQueue.id });
        if (!updated) throw new GoPilotOverrideConflictError("Queue state changed concurrently");
      }
    }
    await tx.insert(activityLog).values({
      schoolId: options.schoolId,
      sessionId: options.sessionId,
      actorId: options.changedBy,
      action: "dismissal.override_reverted",
      entityType: "student",
      entityId: options.studentId,
      details: { permanentType: student.dismissalType ?? "car", queueChanged: Boolean(queue) },
    });
    return { student, deletedOverride, queueChanged: Boolean(queue) };
  });
  if (!reverted) return null;

  const permanentType = reverted.student.dismissalType ?? "car";
  const revertEvent = {
    studentId: options.studentId,
    studentName: `${reverted.student.firstName} ${reverted.student.lastName}`.trim(),
    originalType: permanentType,
    overrideType: null,
    busRoute: reverted.student.busRoute ?? null,
    changedBy: "System",
    changedByRole: "system",
    reason: "Override reverted",
  };
  const officeRoom = `school:${options.schoolId}:office`;
  const teacherRoom = reverted.student.homeroomId
    ? `school:${options.schoolId}:teacher:${reverted.student.homeroomId}`
    : null;
  await broadcastGoPilot(officeRoom, "dismissal:override", revertEvent);
  await broadcastGoPilot(officeRoom, "student:typeUpdated", {
    studentId: options.studentId,
    dismissalType: permanentType,
    busRoute: reverted.student.busRoute ?? null,
    isOverride: false,
  });
  if (reverted.queueChanged) {
    await broadcastGoPilot(officeRoom, "queue:updated", {
      action: "override_reverted",
      studentId: options.studentId,
    });
  }
  if (teacherRoom) {
    await broadcastGoPilot(teacherRoom, "dismissal:override", revertEvent);
    await broadcastGoPilot(teacherRoom, "student:typeUpdated", {
      studentId: options.studentId,
      dismissalType: permanentType,
      busRoute: reverted.student.busRoute ?? null,
      isOverride: false,
    });
    if (reverted.queueChanged) {
      await broadcastGoPilot(teacherRoom, "queue:updated", {
        action: "override_reverted",
        studentId: options.studentId,
      });
    }
  }
  await createStudentTimelineEvent({
    schoolId: options.schoolId,
    studentId: options.studentId,
    eventType: "dismissal",
    sourceType: "gopilot",
    sourceId: reverted.deletedOverride.id,
    title: "Dismissal override reverted",
    summary: `Dismissal method restored to ${permanentType}`,
    actorUserId: options.changedBy,
    metadata: revertEvent,
  });
  return reverted;
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
  queueChanged: boolean;
} | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gopilot:change:${options.changeId}`}, 0::bigint))`
    );
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
    if (row.student.status !== "active") {
      throw new GoPilotOverrideConflictError(
        "Student is not active at this school",
        "GOPILOT_STUDENT_NOT_ACTIVE"
      );
    }
    if (row.change.status !== "pending") {
      throw new GoPilotOverrideConflictError(
        "This dismissal change has already been resolved",
        "GOPILOT_CHANGE_ALREADY_RESOLVED"
      );
    }
    if (!VALID_DISMISSAL_TYPES.has(row.change.toType) || row.change.toType === row.change.fromType) {
      throw new GoPilotOverrideConflictError(
        "Dismissal change has an invalid type transition",
        "GOPILOT_INVALID_DISMISSAL_TRANSITION"
      );
    }
    if (row.change.toType === "bus" && !cleanBusRoute("bus", row.change.busRoute)) {
      throw new GoPilotOverrideConflictError(
        "A bus route is required for bus dismissal",
        "GOPILOT_BUS_ROUTE_REQUIRED"
      );
    }
    const [session] = await tx
      .select()
      .from(dismissalSessions)
      .where(
        and(
          eq(dismissalSessions.id, row.change.sessionId),
          eq(dismissalSessions.schoolId, options.schoolId)
        )
      )
      .limit(1)
      .for("update");
    if (!session || (options.status === "approved" && session.status !== "active")) {
      throw new GoPilotOverrideConflictError(
        "Dismissal session is not active",
        "GOPILOT_SESSION_NOT_ACTIVE"
      );
    }

    let override: DismissalOverride | undefined;
    let removedQueueEntries: DismissalQueueEntry[] = [];
    let queueChanged = false;
    if (options.status === "approved") {
      const [queuedEntry] = await tx
        .select()
        .from(dismissalQueue)
        .where(
          and(
            eq(dismissalQueue.schoolId, options.schoolId),
            eq(dismissalQueue.sessionId, row.change.sessionId),
            eq(dismissalQueue.studentId, row.change.studentId)
          )
        )
        .limit(1)
        .for("update");
      if (queuedEntry && queuedEntry.status !== "waiting") {
        throw new GoPilotOverrideConflictError(
          "Queued students can only be reclassified before they are called",
          "GOPILOT_QUEUE_ALREADY_PROGRESSED"
        );
      }
      queueChanged = Boolean(queuedEntry);
      const [overrideRow] = await tx
        .insert(dismissalOverrides)
        .values({
          schoolId: options.schoolId,
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
              eq(dismissalQueue.schoolId, options.schoolId),
              eq(dismissalQueue.sessionId, row.change.sessionId),
              eq(dismissalQueue.studentId, row.change.studentId),
              eq(dismissalQueue.status, "waiting")
            )
          )
          .returning();
      } else if (queuedEntry) {
        const route = cleanBusRoute(row.change.toType, row.change.busRoute);
        const queueUpdate = row.change.toType === "bus"
          ? {
              checkInMethod: "bus_number",
              guardianName: `Bus #${route}`,
              pickupGroupId: `bus:${route}`,
              pickupGroupLabel: `Bus #${route}`,
            }
          : row.change.toType === "walker"
            ? {
                checkInMethod: "walker",
                guardianName: "Walkers",
                pickupGroupId: "walkers:override",
                pickupGroupLabel: "Walkers",
              }
            : {
                checkInMethod: "car_number",
                pickupGroupId: queuedEntry.pickupGroupId,
                pickupGroupLabel: queuedEntry.pickupGroupLabel,
              };
        const [updatedQueue] = await tx
          .update(dismissalQueue)
          .set(queueUpdate)
          .where(
            and(
              eq(dismissalQueue.id, queuedEntry.id),
              eq(dismissalQueue.schoolId, options.schoolId),
              eq(dismissalQueue.status, "waiting")
            )
          )
          .returning({ id: dismissalQueue.id });
        if (!updatedQueue) throw new GoPilotOverrideConflictError("Queue state changed concurrently");
      }
    }

    const [change] = await tx
      .update(dismissalChanges)
      .set({
        status: options.status,
        reviewedBy: options.reviewedBy,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(dismissalChanges.id, options.changeId),
          eq(dismissalChanges.schoolId, options.schoolId),
          eq(dismissalChanges.status, "pending")
        )
      )
      .returning();

    if (!change) {
      throw new GoPilotOverrideConflictError(
        "This dismissal change has already been resolved",
        "GOPILOT_CHANGE_ALREADY_RESOLVED"
      );
    }

    await tx.insert(activityLog).values({
      schoolId: options.schoolId,
      sessionId: row.change.sessionId,
      actorId: options.reviewedBy,
      action: `dismissal.change_${options.status}`,
      entityType: "dismissal_change",
      entityId: row.change.id,
      details: {
        studentId: row.change.studentId,
        fromType: row.change.fromType,
        toType: row.change.toType,
        removedWaitingQueueCount: removedQueueEntries.length,
      },
    });

    return {
      change: change!,
      student: row.student,
      override,
      removedQueueEntries,
      queueChanged,
    };
  });
}
