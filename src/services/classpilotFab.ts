import crypto from "crypto";
import { db } from "../db.js";
import type { TeachingSession } from "../schema/classpilot.js";
import type { Student } from "../schema/students.js";
import type { Settings } from "../schema/shared.js";
import {
  getActiveHandsForStudent,
  getActiveClassOwnersForStudents,
  getActiveSessionsForStudents,
  getActiveSupervisionForStudent,
  getActiveSupervisionForStudents,
  getActiveTeachingSessionsForStudent,
  getClasspilotSessionStudentRoster,
  getClasspilotFabAuthoritySnapshot,
  getClasspilotStudentControlStates,
  getSessionSettings,
  getSettingsForSchool,
  getStudentById,
  upsertSessionSettings,
} from "./storage.js";
import { classpilotControlStateHasLateSignInOrigin } from "./classpilotClassroomState.js";
import { sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch } from "../realtime/ws-redis.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { classpilotCommandAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import { classpilotFabStatePushFrame } from "./classpilotControlStateFrame.js";

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
  sessionId?: string | null,
  knownSchoolSettings?: Settings,
  dbInstance: typeof db = db
): Promise<{
  messagingEnabled: boolean;
  handRaisingEnabled: boolean;
  schoolMessagingEnabled: boolean;
  schoolHandRaisingEnabled: boolean;
  sessionMessagingEnabled: boolean;
  sessionHandRaisingEnabled: boolean;
  lifecycleRevision: number;
}> {
  const schoolSettings = knownSchoolSettings ?? await getSettingsForSchool(schoolId, dbInstance);
  const sessionSettings = sessionId
    ? await getSessionSettings(schoolId, sessionId, dbInstance)
    : undefined;
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
    lifecycleRevision: sessionSettings?.lifecycleRevision ?? 0,
  };
}

export async function resolveStudentFabSessions(options: {
  schoolId: string;
  studentId: string;
  feature: FabFeature;
}): Promise<{ student: Student; sessions: TeachingSession[] }> {
  await assertClasspilotEntitled(options.schoolId);
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

export async function buildStudentFabState(
  schoolId: string,
  studentId: string,
  options: {
    schoolSettings?: Settings;
    studentSessionId?: string | null;
    dbInstance?: typeof db;
  } = {}
) {
  const authority = await getClasspilotFabAuthoritySnapshot(
    schoolId,
    studentId,
    options.dbInstance
  );
  const supervision = authority.supervision;
  const studentSessionId = options.studentSessionId !== undefined
    ? options.studentSessionId
    : authority.studentSession?.id ?? null;
  const ownershipRevision = authority.ownershipRevision;
  if (supervision) {
    return {
      schemaVersion: 1,
      studentId,
      studentSessionId,
      ownershipRevision,
      teachingSessionId: null,
      lifecycleRevision: 0,
      revision: 0,
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

  const sessions = authority.teachingSession ? [authority.teachingSession] : [];
  const authoritativeSessionIds = new Set(sessions.map((session) => session.id));
  const activeHands = (await getActiveHandsForStudent(
    schoolId,
    studentId,
    options.dbInstance
  ))
    .filter((hand) => authoritativeSessionIds.has(hand.teachingSessionId));

  let messagingEnabled = false;
  let handRaisingEnabled = false;
  const sessionStates: Array<{
    sessionId: string;
    messagingEnabled: boolean;
    handRaisingEnabled: boolean;
    handRaised: boolean;
    lifecycleRevision: number;
  }> = [];

  for (const session of sessions) {
    const toggles = await getEffectiveFabToggles(
      schoolId,
      session.id,
      options.schoolSettings,
      options.dbInstance
    );
    const handRaised = activeHands.some((hand) => hand.teachingSessionId === session.id);
    messagingEnabled = messagingEnabled || toggles.messagingEnabled;
    handRaisingEnabled = handRaisingEnabled || toggles.handRaisingEnabled;
    sessionStates.push({
      sessionId: session.id,
      messagingEnabled: toggles.messagingEnabled,
      handRaisingEnabled: toggles.handRaisingEnabled,
      handRaised,
      lifecycleRevision: toggles.lifecycleRevision,
    });
  }

  return {
    schemaVersion: 1,
    studentId,
    studentSessionId,
    ownershipRevision,
    teachingSessionId: sessions.length === 1 ? sessions[0]!.id : null,
    lifecycleRevision: sessionStates.reduce((revision, state) => Math.max(revision, state.lifecycleRevision), 0),
    revision: sessionStates.reduce((revision, state) => Math.max(revision, state.lifecycleRevision), 0),
    activeSessionIds: sessions.map((session) => session.id),
    messagingEnabled,
    handRaisingEnabled,
    handRaised: activeHands.length > 0,
    activeHands: activeHands.map((hand) => ({
      sessionId: hand.teachingSessionId,
      studentId: hand.studentId,
      raisedAt: hand.raisedAt,
      expiresAt: hand.expiresAt,
    })),
    sessions: sessionStates,
  };
}

export async function getSessionStudentDeviceIds(session: TeachingSession): Promise<string[]> {
  if (!session.schoolId) return [];
  const bindings = await getSessionStudentBindings(session.schoolId, session.id);
  return bindings.map((binding) => binding.deviceId);
}

export async function getSessionStudentBindings(
  schoolId: string,
  teachingSessionId: string
): Promise<Array<{ studentId: string; studentSessionId: string; deviceId: string }>> {
  const roster = await getClasspilotSessionStudentRoster(schoolId, teachingSessionId);
  const studentIds = roster.map((row) => row.studentId);
  if (studentIds.length === 0) return [];
  const supervision = await getActiveSupervisionForStudents(schoolId, studentIds);
  const owners = await getActiveClassOwnersForStudents(schoolId, studentIds);
  const sessions = await getActiveSessionsForStudents(schoolId, studentIds);
  const covered = new Set(supervision.map((entry) => entry.studentId));
  const ownerByStudent = new Map(owners.map((owner) => [owner.studentId, owner.session.id]));
  const bindingByStudent = new Map(sessions.map((session) => [session.studentId, session]));
  return studentIds.flatMap((studentId) => {
    const binding = bindingByStudent.get(studentId);
    if (
      covered.has(studentId) ||
      ownerByStudent.get(studentId) !== teachingSessionId ||
      !binding
    ) return [];
    return [{ studentId, studentSessionId: binding.id, deviceId: binding.deviceId }];
  });
}

export async function updateAndFanoutSessionFabSettings(options: {
  schoolId: string;
  teachingSessionId: string;
  actorId: string;
  chatEnabled?: boolean;
  raiseHandEnabled?: boolean;
  expectedRevision?: number;
}) {
  let settings;
  try {
    settings = await upsertSessionSettings(
      options.schoolId,
      options.teachingSessionId,
      {
        ...(options.chatEnabled !== undefined ? { chatEnabled: options.chatEnabled } : {}),
        ...(options.raiseHandEnabled !== undefined ? { raiseHandEnabled: options.raiseHandEnabled } : {}),
      },
      { expectedRevision: options.expectedRevision, actorId: options.actorId }
    );
  } catch (error: any) {
    if (error?.code === "FAB_REVISION_STALE") {
      const toggles = await getEffectiveFabToggles(options.schoolId, options.teachingSessionId);
      error.current = {
        schemaVersion: 1,
        teachingSessionId: options.teachingSessionId,
        activeSessionIds: [options.teachingSessionId],
        messagingEnabled: toggles.messagingEnabled,
        handRaisingEnabled: toggles.handRaisingEnabled,
        revision: toggles.lifecycleRevision,
        lifecycleRevision: toggles.lifecycleRevision,
      };
    }
    throw error;
  }
  const toggles = await getEffectiveFabToggles(options.schoolId, options.teachingSessionId);
  const bindings = await getSessionStudentBindings(options.schoolId, options.teachingSessionId);
  const controlStates = await getClasspilotStudentControlStates(
    options.schoolId,
    bindings.map((binding) => binding.studentId)
  );
  const controlStateByStudent = new Map(controlStates.map((state) => [state.studentId, state]));
  const publications = [];
  for (const binding of bindings) {
    // Ownership revision is student-specific and monotonic across class,
    // coverage, replacement, and empty-state transitions. Always rebuild the
    // authoritative full state instead of synthesizing a per-session snapshot.
    const controlState = controlStateByStudent.get(binding.studentId);
    // Session-toggle fanout has no per-socket negotiated capability evidence.
    // Keep the legacy toggle messages below, but defer the revision-bound FAB
    // snapshot when it would reveal a hidden late-sign-in control revision.
    if (!controlState || !classpilotControlStateHasLateSignInOrigin(controlState.desiredState)) {
      const fullState = await buildStudentFabState(options.schoolId, binding.studentId, {
        studentSessionId: binding.studentSessionId,
      });
      const payload = classpilotFabStatePushFrame({
        messageId: crypto.randomUUID(),
        sessionId: options.teachingSessionId,
        binding: {
          schoolId: options.schoolId,
          deviceId: binding.deviceId,
          studentId: binding.studentId,
          studentSessionId: binding.studentSessionId,
          controlRevision: fullState.ownershipRevision,
        },
        data: fullState,
      });
      sendToDeviceLocal(options.schoolId, binding.deviceId, payload);
      publications.push({
        target: { kind: "device" as const, schoolId: options.schoolId, deviceId: binding.deviceId },
        message: payload,
      });
    }
    const legacyCommands = [
      ...(options.chatEnabled !== undefined ? [{
        type: "messaging-toggle",
        data: {
          sessionId: options.teachingSessionId,
          studentId: binding.studentId,
          studentSessionId: binding.studentSessionId,
          enabled: toggles.messagingEnabled,
          messagingEnabled: toggles.messagingEnabled,
          revision: settings.lifecycleRevision,
        },
      }] : []),
      ...(options.raiseHandEnabled !== undefined ? [{
        type: "hand-raising-toggle",
        data: {
          sessionId: options.teachingSessionId,
          studentId: binding.studentId,
          studentSessionId: binding.studentSessionId,
          enabled: toggles.handRaisingEnabled,
          handRaisingEnabled: toggles.handRaisingEnabled,
          revision: settings.lifecycleRevision,
        },
      }] : []),
    ];
    for (const command of legacyCommands) {
      const authority = classpilotCommandAuthorityEnvelope({
        teachingSessionId: options.teachingSessionId,
        supervisionContextId: null,
      });
      const legacyPayload = {
        type: "remote-control",
        _msgId: crypto.randomUUID(),
        studentId: binding.studentId,
        studentSessionId: binding.studentSessionId,
        command: {
          ...command,
          studentId: binding.studentId,
          studentSessionId: binding.studentSessionId,
          ...authority,
        },
      };
      sendToDeviceLocal(options.schoolId, binding.deviceId, legacyPayload);
      publications.push({
        target: { kind: "device" as const, schoolId: options.schoolId, deviceId: binding.deviceId },
        message: legacyPayload,
      });
    }
  }
  if (publications.length > 0) await publishWSBatch(publications);
  return {
    settings,
    state: {
      schemaVersion: 1,
      teachingSessionId: options.teachingSessionId,
      activeSessionIds: [options.teachingSessionId],
      messagingEnabled: toggles.messagingEnabled,
      handRaisingEnabled: toggles.handRaisingEnabled,
      revision: settings.lifecycleRevision,
      lifecycleRevision: settings.lifecycleRevision,
    },
    targetedStudentCount: bindings.length,
  };
}
