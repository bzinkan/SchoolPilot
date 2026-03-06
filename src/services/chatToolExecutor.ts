// Executes chat tool calls by delegating to existing storage functions

import {
  getStudentsBySchool,
  createStudent,
  markStudentsAbsentBulk,
  getAttendanceBySchool,
  getGroupsBySchool,
  createGroup,
  getHomeroomsBySchool,
  createHomeroom,
  getActivePassesBySchool,
  createPass,
  addGroupTeacher,
  addHomeroomTeacher,
} from "./storage.js";
import { sendChatEscalationEmail } from "./email.js";

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

const executors: Record<string, ToolExecutor> = {
  // === SHARED ===

  list_students: async (_args, ctx) => {
    const students = await getStudentsBySchool(ctx.schoolId);
    const summary = students.map((s: any) => ({
      id: s.id,
      name: `${s.firstName} ${s.lastName}`,
      gradeLevel: s.gradeLevel || "N/A",
      status: s.status,
    }));
    return { success: true, data: { count: students.length, students: summary } };
  },

  create_student: async (args, ctx) => {
    const student = await createStudent({
      schoolId: ctx.schoolId,
      firstName: args.firstName,
      lastName: args.lastName,
      gradeLevel: args.gradeLevel || null,
      email: args.email || null,
    });
    return {
      success: true,
      data: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        gradeLevel: student.gradeLevel,
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
      studentName: `${r.student.firstName} ${r.student.lastName}`,
      status: r.attendance.status,
      reason: r.attendance.reason,
    }));
    return {
      success: true,
      data: { date: todayDate(), count: records.length, records: summary },
    };
  },

  // === CLASSPILOT ===

  list_classes: async (_args, ctx) => {
    const groups = await getGroupsBySchool(ctx.schoolId);
    const summary = groups.map((g: any) => ({
      id: g.id,
      name: g.name,
      gradeLevel: g.gradeLevel || "N/A",
      periodLabel: g.periodLabel || "",
      teacherId: g.teacherId,
    }));
    return { success: true, data: { count: groups.length, classes: summary } };
  },

  create_class: async (args, ctx) => {
    const group = await createGroup({
      schoolId: ctx.schoolId,
      teacherId: ctx.userId,
      name: args.name,
      gradeLevel: args.gradeLevel || null,
      periodLabel: args.periodLabel || null,
      groupType: "admin_class",
    });
    // Seed the junction table
    await addGroupTeacher(group.id, ctx.userId, "primary");
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

  list_active_passes: async (_args, ctx) => {
    const passes = await getActivePassesBySchool(ctx.schoolId);
    const summary = passes.map((p: any) => ({
      id: p.id,
      studentId: p.studentId,
      destination: p.destination,
      status: p.status,
      duration: p.duration,
      createdAt: p.createdAt,
    }));
    return {
      success: true,
      data: { count: passes.length, passes: summary },
    };
  },

  issue_pass: async (args, ctx) => {
    const duration = args.duration || 5;
    const expiresAt = new Date(Date.now() + duration * 60 * 1000);
    const pass = await createPass({
      schoolId: ctx.schoolId,
      studentId: args.studentId,
      teacherId: ctx.userId,
      destination: args.destination,
      duration,
      expiresAt,
      status: "active",
      issuedVia: "teacher",
    });
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
  const executor = executors[toolName];
  if (!executor) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  try {
    return await executor(args, ctx);
  } catch (err: any) {
    console.error(`[ChatTool] Error executing ${toolName}:`, err);

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
      console.error("[ChatTool] Failed to send escalation email:", emailErr);
    }

    return {
      success: false,
      error:
        "This action failed due to a system error. The development team has been automatically notified and will investigate.",
    };
  }
}
