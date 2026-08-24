// Executes chat tool calls by delegating to existing storage functions

import {
  getStudentsBySchool,
  createStudent,
  getStudentByEmail,
  reactivateInactiveStudentForRosterImport,
  markStudentsAbsentBulk,
  getAttendanceBySchool,
  getGroupsBySchool,
  upsertAdminClassroomClass,
  getHomeroomsBySchool,
  createHomeroom,
  getActivePassesBySchool,
  getActivePassForStudent,
  expireOverduePasses,
  getStudentById,
  createCanonicalPass,
  createLegacyPass,
  addHomeroomTeacher,
  getSchoolUsageSummary,
  getHeartbeatsByStudent,
  getGroupsByTeacherAndSchool,
  getAbsentStudentIds,
  getSettingsForSchool,
} from "./storage.js";
import {
  filterPassesForRole,
  getPasspilotClassSourceForSchool,
  getTeacherCanonicalClassIds,
  getTeacherGradeIds,
  getLegacyAccessibleStudentIds,
  isPassPilotManager,
  type PassPilotRole,
} from "./passpilotAccess.js";
import { sendChatEscalationEmail } from "./email.js";
import db from "../db.js";
import { heartbeats, teachingSessions, groups, groupStudents } from "../schema/classpilot.js";
import { users } from "../schema/core.js";
import { devices as deviceTable } from "../schema/classpilot.js";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { getToolsForContext } from "./chatTools.js";
import { getPasspilotClasses } from "./passpilotClasses.js";
import { isWithinTrackingWindow } from "./schoolHours.js";

// Lazy imports to avoid circular deps — flight paths may not exist in all setups
let _getFlightPathsBySchool: ((schoolId: string) => Promise<any[]>) | null =
  null;
let _createFlightPath: ((data: any) => Promise<any>) | null = null;

async function loadFlightPathFns() {
  if (!_getFlightPathsBySchool) {
    const storage = await import("./storage.js");
    _getFlightPathsBySchool =
      (storage as any).getFlightPathsBySchool ||
      (storage as any).getFlightPathsByTeacher;
    _createFlightPath = (storage as any).createFlightPath;
  }
}

export interface ToolContext {
  userId: string;
  schoolId: string;
  schoolName: string;
  userName: string;
  userRole: string;
  licensedProducts: string[];
  getTranscript: () => string; // last N messages for escalation
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

type ToolExecutor = (
  args: Record<string, any>,
  ctx: ToolContext
) => Promise<ToolResult>;

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function passpilotRoleForTool(ctx: ToolContext): PassPilotRole | null {
  const role = ctx.userRole as PassPilotRole;
  return ["super_admin", "admin", "school_admin", "office_staff", "teacher"].includes(role)
    ? role
    : null;
}

async function passpilotStudentIdsForTeacher(ctx: ToolContext): Promise<Set<string> | null> {
  const role = passpilotRoleForTool(ctx);
  if (isPassPilotManager(role)) return null;
  if (role !== "teacher") return new Set<string>();
  if (!ctx.licensedProducts.some((product) => product.toUpperCase() === "PASSPILOT")) {
    return null;
  }

  const source = await getPasspilotClassSourceForSchool(ctx.schoolId);
  if (source === "classpilot_groups") {
    const classIds = Array.from(await getTeacherCanonicalClassIds(ctx.userId, ctx.schoolId));
    if (classIds.length === 0) return new Set<string>();
    const rows = await db
      .select({ studentId: groupStudents.studentId })
      .from(groupStudents)
      .where(inArray(groupStudents.groupId, classIds));
    return new Set(rows.map((row) => row.studentId));
  }

  const gradeIds = await getTeacherGradeIds(ctx.userId, ctx.schoolId);
  return getLegacyAccessibleStudentIds(ctx.schoolId, gradeIds);
}

const executors: Record<string, ToolExecutor> = {
  // === SHARED ===

  list_students: async (_args, ctx) => {
    const allowedStudentIds = await passpilotStudentIdsForTeacher(ctx);
    const schoolStudents = await getStudentsBySchool(ctx.schoolId);
    const students = allowedStudentIds
      ? schoolStudents.filter((student) => allowedStudentIds.has(student.id))
      : schoolStudents;
    const summary = students.map((s: any, index: number) => ({
      id: s.id,
      label: `Student ${index + 1}`,
      gradeLevel: s.gradeLevel || "N/A",
      status: s.status,
    }));
    return { success: true, data: { count: students.length, students: summary } };
  },

  create_student: async (args, ctx) => {
    const email = typeof args.email === "string" ? args.email.trim() : "";
    const emailLc = email.toLowerCase();
    let student: Awaited<ReturnType<typeof createStudent>> | undefined;
    let restored = false;

    // The assistant is an administrator-authorized roster surface. Restore an
    // exact inactive school/email identity so retained assignments and history
    // come back with the original student ID.
    if (emailLc) {
      const existing = await getStudentByEmail(ctx.schoolId, emailLc);
      if (existing?.status === "inactive") {
        const result = await reactivateInactiveStudentForRosterImport(
          ctx.schoolId,
          emailLc,
          {
            firstName: args.firstName,
            lastName: args.lastName,
            gradeLevel: args.gradeLevel || null,
            email,
          },
          {
            userId: ctx.userId,
            userRole: ctx.userRole,
            source: "ai_assistant_create_student",
          }
        );
        student = result.student;
        restored = result.reactivated;
      }
    }

    student ??= await createStudent({
      schoolId: ctx.schoolId,
      firstName: args.firstName,
      lastName: args.lastName,
      gradeLevel: args.gradeLevel || null,
      email: email || null,
    });
    return {
      success: true,
      data: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        gradeLevel: student.gradeLevel,
        restored,
      },
    };
  },

  mark_students_absent: async (args, ctx) => {
    const records = await markStudentsAbsentBulk(
      ctx.schoolId,
      args.studentIds,
      {
        date: todayDate(),
        status: args.status,
        reason: args.reason || null,
        markedBy: ctx.userId,
        source: "ai_assistant",
      }
    );
    return {
      success: true,
      data: { markedCount: records.length, status: args.status },
    };
  },

  get_attendance_today: async (_args, ctx) => {
    const records = await getAttendanceBySchool(ctx.schoolId, todayDate());
    const summary = records.map((r: any) => ({
      studentId: r.student.id,
      status: r.attendance.status,
    }));
    return {
      success: true,
      data: { date: todayDate(), count: records.length, records: summary },
    };
  },

  // === CLASSPILOT ===

  list_classes: async (_args, ctx) => {
    const schoolGroups = ctx.userRole === "teacher"
      ? await getGroupsByTeacherAndSchool(ctx.userId, ctx.schoolId)
      : await getGroupsBySchool(ctx.schoolId);
    const summary = schoolGroups.map((g: any) => ({
      id: g.id,
      name: g.name,
      gradeLevel: g.gradeLevel || "N/A",
      periodLabel: g.periodLabel || "",
      teacherId: g.teacherId,
    }));
    return { success: true, data: { count: schoolGroups.length, classes: summary } };
  },

  create_class: async (args, ctx) => {
    const { group } = await upsertAdminClassroomClass({
      schoolId: ctx.schoolId,
      primaryTeacherId: ctx.userId,
      coTeacherIds: [],
      data: {
        name: args.name,
        gradeLevel: args.gradeLevel || null,
        periodLabel: args.periodLabel || null,
        groupType: "admin_class",
      },
      scheduleChangeActorId: ctx.userId,
    });
    return {
      success: true,
      data: {
        id: group.id,
        name: group.name,
        gradeLevel: group.gradeLevel,
      },
    };
  },

  list_flight_paths: async (_args, ctx) => {
    await loadFlightPathFns();
    if (!_getFlightPathsBySchool) {
      return { success: false, error: "Flight path feature not available" };
    }
    const fps = await _getFlightPathsBySchool(ctx.schoolId);
    const summary = fps.map((fp: any) => ({
      id: fp.id,
      name: fp.flightPathName,
      allowedDomains: fp.allowedDomains,
      isDefault: fp.isDefault,
    }));
    return {
      success: true,
      data: { count: fps.length, flightPaths: summary },
    };
  },

  create_flight_path: async (args, ctx) => {
    await loadFlightPathFns();
    if (!_createFlightPath) {
      return { success: false, error: "Flight path feature not available" };
    }
    const fp = await _createFlightPath({
      schoolId: ctx.schoolId,
      teacherId: ctx.userId,
      flightPathName: args.name,
      description: args.description || null,
      allowedDomains: args.allowedDomains || [],
      blockedDomains: [],
      isDefault: false,
    });
    return {
      success: true,
      data: {
        id: fp.id,
        name: fp.flightPathName,
        allowedDomains: fp.allowedDomains,
      },
    };
  },

  // === GOPILOT ===

  list_homerooms: async (_args, ctx) => {
    const homerooms = await getHomeroomsBySchool(ctx.schoolId);
    const summary = homerooms.map((h: any) => ({
      id: h.id,
      name: h.name,
      grade: h.grade,
      room: h.room,
      teacherId: h.teacherId,
    }));
    return {
      success: true,
      data: { count: homerooms.length, homerooms: summary },
    };
  },

  create_homeroom: async (args, ctx) => {
    const hr = await createHomeroom({
      schoolId: ctx.schoolId,
      teacherId: null,
      name: args.name,
      grade: args.grade,
      room: args.room || null,
    });
    return {
      success: true,
      data: { id: hr.id, name: hr.name, grade: hr.grade, room: hr.room },
    };
  },

  get_dismissal_stats: async (_args, ctx) => {
    // Import dynamically to avoid circular deps
    const storage = await import("./storage.js");
    const getActiveSession = (storage as any).getActiveSession || (storage as any).getActiveDismissalSession;
    if (!getActiveSession) {
      return {
        success: true,
        data: { message: "No active dismissal session found for today." },
      };
    }
    try {
      const session = await getActiveSession(ctx.schoolId);
      if (!session) {
        return {
          success: true,
          data: { message: "No active dismissal session found for today." },
        };
      }
      return {
        success: true,
        data: {
          sessionId: session.id,
          date: session.date,
          status: session.status,
        },
      };
    } catch {
      return {
        success: true,
        data: { message: "No active dismissal session found for today." },
      };
    }
  },

  // === PASSPILOT ===

  list_passpilot_classes: async (_args, ctx) => {
    const role = passpilotRoleForTool(ctx);
    const result = await getPasspilotClasses(ctx.schoolId, {
      userId: ctx.userId,
      manager: isPassPilotManager(role),
      scope: "active",
    });
    return {
      success: true,
      data: {
        source: result.source,
        count: result.classes.length,
        classes: result.classes.map((passpilotClass) => ({
          id: passpilotClass.classId,
          name: passpilotClass.name,
          gradeLevel: passpilotClass.gradeLevel,
          periodLabel: passpilotClass.periodLabel,
          studentCount: passpilotClass.studentCount,
        })),
      },
    };
  },

  list_active_passes: async (_args, ctx) => {
    const rawPasses = await getActivePassesBySchool(ctx.schoolId);
    const [user] = await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
    const passes = user
      ? await filterPassesForRole(rawPasses, user, ctx.schoolId, passpilotRoleForTool(ctx))
      : [];
    const summary = passes.map((p: any) => ({
      id: p.id,
      studentId: p.studentId,
      destination: p.destination,
      status: p.status,
      duration: p.duration,
      issuedAt: p.issuedAt,
    }));
    return {
      success: true,
      data: { count: passes.length, passes: summary },
    };
  },

  issue_pass: async (args, ctx) => {
    if (!args.classId) {
      return { success: false, error: "A class ID is required to issue a pass" };
    }
    // Verify the student belongs to this school (no cross-school pass writes).
    const student = await getStudentById(args.studentId);
    if (!student || student.schoolId !== ctx.schoolId) {
      return { success: false, error: "Student not found" };
    }

    const duration = args.duration ?? 5;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 1) {
      return { success: false, error: "Pass duration must be a finite number of at least 1 minute" };
    }

    const [absentStudentIds, schoolSettings] = await Promise.all([
      getAbsentStudentIds(ctx.schoolId, todayDate()),
      getSettingsForSchool(ctx.schoolId),
    ]);
    if (absentStudentIds.has(args.studentId)) {
      return { success: false, error: "Cannot issue a pass to an absent student" };
    }
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      return { success: false, error: "Passes cannot be issued outside school hours" };
    }

    // Mirror the route safeguards: expire stale passes first, then enforce
    // one active pass per student (route + DB partial unique index).
    await expireOverduePasses(ctx.schoolId);
    const active = await getActivePassForStudent(args.studentId, ctx.schoolId);
    if (active) {
      return { success: false, error: "Student already has an active pass" };
    }

    const expiresAt = new Date(Date.now() + duration * 60 * 1000);
    const source = await getPasspilotClassSourceForSchool(ctx.schoolId);
    const manager = ["super_admin", "admin", "school_admin", "office_staff"].includes(ctx.userRole);
    if (source === "legacy_grades" && !manager) {
      const allowedGradeIds = await getTeacherGradeIds(ctx.userId, ctx.schoolId);
      if (!allowedGradeIds.has(args.classId)) {
        return { success: false, error: "You do not have access to that class" };
      }
    }
    let pass;
    try {
      const commonPass = {
        schoolId: ctx.schoolId,
        studentId: args.studentId,
        teacherId: ctx.userId,
        destination: args.destination,
        duration,
        expiresAt,
        status: "active" as const,
        issuedVia: "teacher" as const,
      };
      pass = source === "classpilot_groups"
        ? await createCanonicalPass(
            { ...commonPass, classId: args.classId },
            { actorUserId: ctx.userId, manager }
          )
        : await createLegacyPass(
            { ...commonPass, gradeId: args.classId },
            { actorUserId: ctx.userId, manager }
          );
    } catch (err: any) {
      if (err?.code === "23505") {
        return { success: false, error: "Student already has an active pass" };
      }
      throw err;
    }
    return {
      success: true,
      data: {
        id: pass.id,
        destination: pass.destination,
        duration,
        expiresAt: expiresAt.toISOString(),
      },
    };
  },

  // === CLASSPILOT ANALYTICS ===

  get_top_websites: async (args, ctx) => {
    const period = args.period || "24h";
    const now = new Date();
    let startDate: string;
    if (period === "30d") {
      const d = new Date(now); d.setDate(d.getDate() - 30); startDate = d.toISOString().slice(0, 10);
    } else if (period === "7d") {
      const d = new Date(now); d.setDate(d.getDate() - 7); startDate = d.toISOString().slice(0, 10);
    } else {
      const d = new Date(now); d.setDate(d.getDate() - 1); startDate = d.toISOString().slice(0, 10);
    }

    const topDomains = await db.select({
      domain: sql<string>`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`,
      minutes: sql<number>`(COUNT(*) * 10 / 60)::int`,
      visits: sql<number>`COUNT(*)::int`,
    })
      .from(heartbeats)
      .where(and(
        eq(heartbeats.schoolId, ctx.schoolId),
        sql`${heartbeats.timestamp} >= ${startDate}::timestamp`,
        sql`${heartbeats.activeTabUrl} IS NOT NULL`
      ))
      .groupBy(sql`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(15);

    return {
      success: true,
      data: {
        period,
        websites: topDomains.filter((d: any) => d.domain).map((d: any) => ({
          domain: d.domain,
          estimatedMinutes: d.minutes,
          visits: d.visits,
        })),
      },
    };
  },

  get_usage_summary: async (args, ctx) => {
    const period = args.period || "24h";
    const now = new Date();
    let startDate: string;
    if (period === "30d") {
      const d = new Date(now); d.setDate(d.getDate() - 30); startDate = d.toISOString().slice(0, 10);
    } else if (period === "7d") {
      const d = new Date(now); d.setDate(d.getDate() - 7); startDate = d.toISOString().slice(0, 10);
    } else {
      const d = new Date(now); d.setDate(d.getDate() - 1); startDate = d.toISOString().slice(0, 10);
    }
    const endDate = now.toISOString().slice(0, 10);

    const [usageSummary, students, deviceCount] = await Promise.all([
      getSchoolUsageSummary(ctx.schoolId, startDate, endDate),
      getStudentsBySchool(ctx.schoolId),
      db.select({ c: sql<number>`COUNT(*)::int` }).from(deviceTable).where(eq(deviceTable.schoolId, ctx.schoolId)),
    ]);

    return {
      success: true,
      data: {
        period,
        activeStudents: Number(usageSummary.activeStudents) || 0,
        totalStudents: students.length,
        totalDevices: Number(deviceCount[0]?.c) || 0,
        totalBrowsingMinutes: Math.round((Number(usageSummary.totalSeconds) || 0) / 60),
        avgMinutesPerStudent: Number(usageSummary.activeStudents) > 0
          ? Math.round((Number(usageSummary.totalSeconds) || 0) / 60 / Number(usageSummary.activeStudents))
          : 0,
      },
    };
  },

  get_student_browsing_history: async (args, ctx) => {
    const limit = args.limit || 20;
    const records = await db.select({
      url: heartbeats.activeTabUrl,
      timestamp: heartbeats.timestamp,
    })
      .from(heartbeats)
      .where(and(
        eq(heartbeats.studentId, args.studentId),
        eq(heartbeats.schoolId, ctx.schoolId),
        sql`${heartbeats.activeTabUrl} IS NOT NULL`
      ))
      .orderBy(desc(heartbeats.timestamp))
      .limit(limit);

    return {
      success: true,
      data: {
        count: records.length,
        history: records.map((r: any) => ({
          url: r.url,
          timestamp: r.timestamp,
        })),
      },
    };
  },

  get_teacher_session_stats: async (args, ctx) => {
    const period = args.period || "7d";
    const days = period === "30d" ? 30 : 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const stats = await db.select({
      teacherId: groups.teacherId,
      teacherFirstName: users.firstName,
      teacherLastName: users.lastName,
      sessionCount: sql<number>`COUNT(${teachingSessions.id})::int`,
      totalMinutes: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${teachingSessions.endTime} - ${teachingSessions.startTime})) / 60), 0)::int`,
    })
      .from(teachingSessions)
      .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
      .innerJoin(users, eq(groups.teacherId, users.id))
      .where(and(
        eq(groups.schoolId, ctx.schoolId),
        sql`${teachingSessions.startTime} >= ${cutoff.toISOString()}::timestamp`
      ))
      .groupBy(groups.teacherId, users.firstName, users.lastName)
      .orderBy(sql`COUNT(${teachingSessions.id}) DESC`);

    return {
      success: true,
      data: {
        period,
        teachers: stats.map((s: any) => ({
          name: `${s.teacherFirstName} ${s.teacherLastName}`,
          sessions: s.sessionCount,
          totalMinutes: s.totalMinutes,
          avgMinutesPerSession: s.sessionCount > 0 ? Math.round(s.totalMinutes / s.sessionCount) : 0,
        })),
      },
    };
  },

  // === ESCALATION ===

  report_system_issue: async (args, ctx) => {
    await sendChatEscalationEmail({
      summary: args.summary,
      category: args.category,
      severity: args.severity,
      stepsAttempted: args.steps_attempted,
      userName: ctx.userName,
      userRole: ctx.userRole,
      schoolName: ctx.schoolName,
      chatTranscript: ctx.getTranscript(),
    });
    return {
      success: true,
      data: {
        message:
          "Issue has been reported to the development team. They will investigate and resolve it.",
      },
    };
  },
};

/**
 * Execute a tool call. Returns the result or an error.
 * On unexpected errors, auto-escalates via email.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { toolMeta } = getToolsForContext(ctx.userRole, ctx.licensedProducts);
  if (!toolMeta.has(toolName)) {
    return { success: false, error: `Tool not authorized: ${toolName}` };
  }

  const executor = executors[toolName];
  if (!executor) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  try {
    return await executor(args, ctx);
  } catch (err: any) {
    console.error(`[ChatTool] Execution failed for allowed tool ${toolName}`);

    // Auto-escalate on unexpected errors
    try {
      await sendChatEscalationEmail({
        summary: `Tool "${toolName}" failed with error: ${err.message || "Unknown error"}`,
        category: "bug",
        severity: "high",
        stepsAttempted: `Auto-escalation: tool ${toolName} threw an unexpected error with args: ${JSON.stringify(args)}`,
        userName: ctx.userName,
        userRole: ctx.userRole,
        schoolName: ctx.schoolName,
        chatTranscript: ctx.getTranscript(),
      });
    } catch (emailErr) {
    console.error("[ChatTool] Failed to send escalation email");
    }

    return {
      success: false,
      error:
        "This action failed due to a system error. The development team has been automatically notified and will investigate.",
    };
  }
}
