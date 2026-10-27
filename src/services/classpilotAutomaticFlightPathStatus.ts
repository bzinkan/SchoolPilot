import type { ClasspilotStudentControlState } from "../schema/classpilot.js";
import {
  automaticFlightPathStateDto,
  normalizeAutomaticFlightPathState,
  readAutomaticFlightPathOrigin,
} from "./classpilotAutomaticFlightPath.js";
import { normalizeClasspilotRestrictions } from "./classpilotClassroomState.js";

export type AutomaticFlightPathStudentStatus = "applied" | "pending" | "failed" | "unavailable" | "overridden" | "off";

/** A request is never evidence that the student's current browser applied it. */
export function summarizeAutomaticFlightPathSession(options: {
  session: { id: string; automaticFlightPathState: unknown; endTime: Date | null; scheduledEndAt: Date | null };
  studentIds: readonly string[];
  controls: readonly ClasspilotStudentControlState[];
  activeSessions: readonly { studentId: string; startedAt: Date }[];
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const session = options.session;
  const state = normalizeAutomaticFlightPathState(session.automaticFlightPathState);
  const ended = !!session.endTime || !!session.scheduledEndAt && session.scheduledEndAt <= now;
  const controls = new Map(options.controls.map(control => [control.studentId, control]));
  const logins = new Map(options.activeSessions.map(login => [login.studentId, login]));
  const overrides = new Set(state.manualOverrideStudentIds);
  const eligible = new Set(state.eligibleStudentIds);
  const students = state.status === "inactive" ? [] : [...new Set(options.studentIds)].map(studentId => {
    const control = controls.get(studentId);
    const login = logins.get(studentId);
    const origin = readAutomaticFlightPathOrigin(control?.desiredState);
    const restrictions = normalizeClasspilotRestrictions((control?.desiredState as any)?.restrictions ?? control?.desiredState);
    const currentClass = control?.teachingSessionId === session.id && !control.supervisionContextId;
    const expired = !!control && [control.hardExpiresAt, control.scheduledEndAt]
      .some(deadline => deadline !== null && deadline <= now);
    const automatic = currentClass && !expired && restrictions.flightPath.active
      && origin?.teachingSessionId === session.id && origin.assignmentId === state.assignmentId;
    // An ACK from the previous sign-in must not confirm a replacement browser.
    const acknowledged = currentClass && !!login && control.appliedRevision === control.revision
      && control.enforcementHealth === "synced" && !!control.lastAcknowledgedAt
      && control.lastAcknowledgedAt >= login.startedAt;
    let status: AutomaticFlightPathStudentStatus;
    if (ended || expired) status = "off";
    else if (overrides.has(studentId)) status = "overridden";
    else if (state.status === "off") {
      status = automatic ? "pending"
        : currentClass && !restrictions.flightPath.active && !acknowledged
          ? control.enforcementHealth === "failed" ? "failed" : "pending"
          : "off";
    } else if (state.status === "unavailable" || !eligible.has(studentId) || !automatic) status = "unavailable";
    else if (control.enforcementHealth === "failed") status = "failed";
    else if (control.enforcementHealth === "unsupported") status = "unavailable";
    else status = acknowledged ? "applied" : "pending";
    return { studentId, status, automatic: automatic && !ended,
      ...(status === "unavailable" && state.unavailableReasons?.[studentId]
        ? { reasonCode: state.unavailableReasons[studentId] } : {}) };
  });
  const summary = { applied: 0, pending: 0, failed: 0, unavailable: 0, overridden: 0, off: 0 };
  for (const student of students) summary[student.status]++;
  return {
    automaticFlightPath: { ...automaticFlightPathStateDto(state),
      ...(ended ? { status: "inactive" as const, reasonCode: "AUTOMATIC_FLIGHT_PATH_SESSION_ENDED" } : {}) },
    summary,
    students,
  };
}
