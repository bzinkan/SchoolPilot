import { z } from "zod";
import { normalizeClasspilotRestrictions } from "./classpilotClassroomState.js";
import { validateAllowedResourceList, type PreciseAllowedResource } from "./restrictionResources.js";

export type AutomaticFlightPathPolicy = {
  schemaVersion: 1; revision: number; enabled: boolean; flightPathId: string | null; updatedBy: string | null;
};
export type AutomaticFlightPathPayload = {
  flightPathId: string; flightPathName: string; allowedDomains: string[]; resources?: PreciseAllowedResource[];
};
export type AutomaticFlightPathState = {
  schemaVersion: 1; revision: number; status: "inactive" | "active" | "off" | "unavailable";
  assignmentId: string | null; sourcePolicyRevision: number; flightPathId: string | null;
  flightPathUpdatedAt: string | null; name: string | null; payload: AutomaticFlightPathPayload | null;
  reasonCode: string | null; manualOverrideStudentIds: string[]; eligibleStudentIds: string[];
  unavailableStudentIds: string[];
  unavailableReasons: Record<string, string>; deferredStudentIds: string[];
};
const policySchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  enabled: z.boolean(), flightPathId: z.string().min(1).nullable(), updatedBy: z.string().min(1).nullable() }).strict();
const payloadSchema = z.object({ flightPathId: z.string().min(1), flightPathName: z.string(),
  allowedDomains: z.array(z.string().min(1)).max(1000), resources: z.array(z.unknown()).max(1000).optional() }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  status: z.enum(["inactive", "active", "off", "unavailable"]), assignmentId: z.string().min(1).nullable(),
  sourcePolicyRevision: z.number().int().nonnegative(), flightPathId: z.string().min(1).nullable(),
  flightPathUpdatedAt: z.string().nullable(), name: z.string().nullable(), payload: payloadSchema.nullable(),
  reasonCode: z.string().nullable(), manualOverrideStudentIds: z.array(z.string().min(1)),
  eligibleStudentIds: z.array(z.string().min(1)), unavailableStudentIds: z.array(z.string().min(1)),
  unavailableReasons: z.record(z.string(), z.string()).default({}), deferredStudentIds: z.array(z.string().min(1)).default([]) }).strict();
const originSchema = z.object({ schemaVersion: z.literal(1), assignmentId: z.string().min(1),
  teachingSessionId: z.string().min(1) }).strict();
function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function normalizeAutomaticFlightPathPolicy(value: unknown): AutomaticFlightPathPolicy {
  const parsed = policySchema.safeParse(value);
  return parsed.success && (!parsed.data.enabled || parsed.data.flightPathId !== null)
    ? parsed.data : { schemaVersion: 1, revision: 0, enabled: false, flightPathId: null, updatedBy: null };
}
export function emptyAutomaticFlightPathState(reasonCode: string | null = null): AutomaticFlightPathState {
  return { schemaVersion: 1, revision: 0, status: "inactive", assignmentId: null, sourcePolicyRevision: 0,
    flightPathId: null, flightPathUpdatedAt: null, name: null, payload: null, reasonCode,
    manualOverrideStudentIds: [], eligibleStudentIds: [], unavailableStudentIds: [], unavailableReasons: {}, deferredStudentIds: [] };
}
export function normalizeAutomaticFlightPathState(value: unknown): AutomaticFlightPathState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) return emptyAutomaticFlightPathState(value == null ? null : "AUTOMATIC_FLIGHT_PATH_STATE_INVALID");
  const state = parsed.data;
  if (state.payload && (!validateAllowedResourceList(state.payload.resources ?? [])
    || (!state.payload.allowedDomains.length && !state.payload.resources?.length)))
    return emptyAutomaticFlightPathState("AUTOMATIC_FLIGHT_PATH_STATE_INVALID");
  if (state.status === "active" && (!state.assignmentId || !state.payload || state.flightPathId !== state.payload.flightPathId))
    return emptyAutomaticFlightPathState("AUTOMATIC_FLIGHT_PATH_STATE_INVALID");
  return state as AutomaticFlightPathState;
}
export function automaticFlightPathPolicyDto(value: unknown) {
  const policy = normalizeAutomaticFlightPathPolicy(value);
  return { schemaVersion: policy.schemaVersion, revision: policy.revision, enabled: policy.enabled, flightPathId: policy.flightPathId };
}
export function automaticFlightPathStateDto(value: unknown) {
  const state = normalizeAutomaticFlightPathState(value);
  return { schemaVersion: state.schemaVersion, revision: state.revision, status: state.status,
    flightPathId: state.flightPathId, name: state.name, sourcePolicyRevision: state.sourcePolicyRevision,
    reasonCode: state.reasonCode, eligibleCount: state.eligibleStudentIds.length,
    unavailableCount: state.unavailableStudentIds.length };
}
export function readAutomaticFlightPathOrigin(value: unknown) {
  const parsed = originSchema.safeParse(record(value).automaticFlightPath);
  return parsed.success ? parsed.data : null;
}
/** Remove only this automatic assignment, including a saved pre-Coverage state. */
export function removeAutomaticFlightPathFromDesiredState(value: unknown, assignmentId: string, teachingSessionId?: string): Record<string, unknown> {
  const desired = { ...record(value) };
  const origin = readAutomaticFlightPathOrigin(desired);
  if (origin?.assignmentId === assignmentId && (!teachingSessionId || origin.teachingSessionId === teachingSessionId)) {
    desired.restrictions = { ...normalizeClasspilotRestrictions(desired.restrictions ?? desired), flightPath: { active: false, allowedDomains: [] } };
    delete desired.automaticFlightPath;
  }
  const restorable = record(desired.restorableClassState);
  if (restorable.desiredState && (!teachingSessionId || restorable.teachingSessionId === teachingSessionId)) {
    desired.restorableClassState = { ...restorable,
      desiredState: removeAutomaticFlightPathFromDesiredState(restorable.desiredState, assignmentId, teachingSessionId) };
  }
  return desired;
}
/** A manual path command owns the resulting path even when its rules match. */
export function withoutAutomaticFlightPathOrigin(value: unknown): Record<string, unknown> {
  const desired = { ...record(value) };
  delete desired.automaticFlightPath;
  return desired;
}
/** Pure projection shared by initialization and claim-return restoration. */
export function automaticFlightPathDesiredState(options: {
  desiredState: unknown; state: unknown; studentId: string; teachingSessionId: string; allowApply?: boolean;
}): Record<string, unknown> {
  const state = normalizeAutomaticFlightPathState(options.state);
  let desired = { ...record(options.desiredState) };
  const origin = readAutomaticFlightPathOrigin(desired);
  const enabled = state.status === "active" && !!state.assignmentId && !!state.payload
    && !state.manualOverrideStudentIds.includes(options.studentId)
    && state.eligibleStudentIds.includes(options.studentId);
  if (origin && origin.teachingSessionId === options.teachingSessionId
    && (!enabled || origin.assignmentId !== state.assignmentId)) {
    desired = removeAutomaticFlightPathFromDesiredState(desired, origin.assignmentId, options.teachingSessionId);
  }
  if (!enabled || options.allowApply === false || readAutomaticFlightPathOrigin(desired)) return desired;
  const restrictions = normalizeClasspilotRestrictions(desired.restrictions ?? desired);
  // Existing teacher intent always wins. Unlike generic apply-flight-path,
  // automatic initialization never clears a Waypoint, lock, or Focus.
  if (restrictions.flightPath.active || restrictions.screenLock.active || restrictions.focus?.active) return desired;
  return { ...desired, restrictions: { ...restrictions, flightPath: { active: true,
    name: state.payload!.flightPathName, allowedDomains: [...state.payload!.allowedDomains],
    ...(state.payload!.resources ? { resources: state.payload!.resources } : {}) } },
    automaticFlightPath: { schemaVersion: 1, assignmentId: state.assignmentId, teachingSessionId: options.teachingSessionId } };
}
