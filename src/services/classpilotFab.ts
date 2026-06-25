import type { TeachingSession } from "../schema/classpilot.js";
import type { Student } from "../schema/students.js";
import {
  getActiveHandsForStudent,
  getActiveSupervisionForStudent,
  getActiveTeachingSessionsForStudent,
  getGroupStudents,
  getSessionSettings,
  getSettingsForSchool,
  getStudentById,
  getStudentDevices,
} from "./storage.js";

export type FabFeature = "chat" | "hand";

export const FAB_HAND_TTL_MS = 12 * 60 * 60 * 1000;

export class FabContractError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "FabContractError";
    this.status = status;
    this.code = code;
  }
}

export function studentDisplayName(student: Student): string {
  return [student.firstName, student.lastName].filter(Boolean).join(" ").trim() || student.email || student.id;
}

export async function getEffectiveFabToggles(
  schoolId: string,
  sessionId?: string | null
): Promise<{
  messagingEnabled: boolean;
  handRaisingEnabled: boolean;
  schoolMessagingEnabled: boolean;
  schoolHandRaisingEnabled: boolean;
  sessionMessagingEnabled: boolean;
  sessionHandRaisingEnabled: boolean;
}> {
  const schoolSettings = await getSettingsForSchool(schoolId);
  const sessionSettings = sessionId ? await getSessionSettings(sessionId) : undefined;
  const schoolMessagingEnabled = schoolSettings?.studentMessagingEnabled !== false;
  const schoolHandRaisingEnabled = schoolSettings?.handRaisingEnabled !== false;
  const sessionMessagingEnabled = sessionSettings?.chatEnabled !== false;
  const sessionHandRaisingEnabled = sessionSettings?.raiseHandEnabled !== false;

  return {
    messagingEnabled: schoolMessagingEnabled && sessionMessagingEnabled,
    handRaisingEnabled: schoolHandRaisingEnabled && sessionHandRaisingEnabled,
    schoolMessagingEnabled,
    schoolHandRaisingEnabled,
    sessionMessagingEnabled,
    sessionHandRaisingEnabled,
  };
}

export async function resolveStudentFabSessions(options: {
  schoolId: string;
  studentId: string;
  feature: FabFeature;
}): Promise<{ student: Student; sessions: TeachingSession[] }> {
  const student = await getStudentById(options.studentId);
  if (!student || student.schoolId !== options.schoolId) {
    throw new FabContractError(404, "student_not_found", "Student not found");
  }

  const supervision = await getActiveSupervisionForStudent(options.schoolId, options.studentId);
  if (supervision) {
    throw new FabContractError(409, "temporary_coverage_active", "Student is assigned to temporary coverage");
  }

  const sessions = await getActiveTeachingSessionsForStudent(options.schoolId, options.studentId);
  if (sessions.length === 0) {
    throw new FabContractError(409, "no_active_session", "No active teaching session for this student");
  }

  const enabledSessions: TeachingSession[] = [];
  for (const session of sessions) {
    const toggles = await getEffectiveFabToggles(options.schoolId, session.id);
    if (options.feature === "chat" ? toggles.messagingEnabled : toggles.handRaisingEnabled) {
      enabledSessions.push(session);
    }
  }

  if (enabledSessions.length === 0) {
    throw new FabContractError(403, "fab_feature_disabled", "This FAB feature is disabled for the active class");
  }

  return { student, sessions: enabledSessions };
}

export async function buildStudentFabState(schoolId: string, studentId: string) {
  const supervision = await getActiveSupervisionForStudent(schoolId, studentId);
  if (supervision) {
    return {
      activeSessionIds: [],
      messagingEnabled: false,
      handRaisingEnabled: false,
      handRaised: false,
      activeHands: [],
      sessions: [],
      supervisionContext: {
        id: supervision.context.id,
        type: supervision.context.contextType,
        name: supervision.context.name,
      },
    };
  }

  const sessions = await getActiveTeachingSessionsForStudent(schoolId, studentId);
  const activeHands = await getActiveHandsForStudent(schoolId, studentId);

  let messagingEnabled = false;
  let handRaisingEnabled = false;
  const sessionStates: Array<{
    sessionId: string;
    messagingEnabled: boolean;
    handRaisingEnabled: boolean;
    handRaised: boolean;
  }> = [];

  for (const session of sessions) {
    const toggles = await getEffectiveFabToggles(schoolId, session.id);
    const handRaised = activeHands.some((hand) => hand.teachingSessionId === session.id);
    messagingEnabled = messagingEnabled || toggles.messagingEnabled;
    handRaisingEnabled = handRaisingEnabled || toggles.handRaisingEnabled;
    sessionStates.push({
      sessionId: session.id,
      messagingEnabled: toggles.messagingEnabled,
      handRaisingEnabled: toggles.handRaisingEnabled,
      handRaised,
    });
  }

  return {
    activeSessionIds: sessions.map((session) => session.id),
    messagingEnabled,
    handRaisingEnabled,
    handRaised: activeHands.length > 0,
    activeHands: activeHands.map((hand) => ({
      sessionId: hand.teachingSessionId,
      studentId: hand.studentId,
      deviceId: hand.deviceId,
      raisedAt: hand.raisedAt,
      expiresAt: hand.expiresAt,
    })),
    sessions: sessionStates,
  };
}

export async function getSessionStudentDeviceIds(session: TeachingSession): Promise<string[]> {
  const roster = await getGroupStudents(session.groupId);
  const deviceIds = new Set<string>();
  for (const row of roster) {
    const devices = await getStudentDevices(row.studentId);
    devices.forEach((device) => deviceIds.add(device.deviceId));
  }
  return [...deviceIds];
}
