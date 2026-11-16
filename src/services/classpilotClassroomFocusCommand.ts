import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { CLASSROOM_FOCUS_SCOPE_CAPABILITY, isClassroomFocusWebsiteUrl, normalizeClassroomFocusScope,
  type ClassroomFocusScope } from "./classroomFocusScope.js";
import type { ClassroomFocusReviewRequest } from "./classpilotClassroomFocusReview.js";

type Context = {
  schoolId: string; actorId: string; teachingSessionId?: string | null; supervisionContextId?: string | null;
  contextAuthorityRevision?: string; targetScope: string; targetStudentIds: string[];
};
type ReviewRequest = ClassroomFocusReviewRequest & { courseId: string; reviewToken: string };
type Dependencies = { enabled?: boolean; confirm?: (request: ReviewRequest) => Promise<ClassroomFocusScope> };
function invalid(message = "Review the exact Classroom course and selected students again"): never {
  throw Object.assign(new Error(message), { status: 400, code: "CLASSROOM_FOCUS_REVIEW_INVALID" });
}

/** Called after strict command validation, before any command/state transaction. */
export async function prepareClassroomFocusCommand(context: Context, payload: Record<string, unknown>, dependencies: Dependencies = {}): Promise<Record<string, unknown>> {
  if (payload.classroomFocus === undefined) return payload;
  const ref = payload.classroomFocus;
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || payload.classroomScope !== undefined
    || !isClassroomFocusWebsiteUrl(payload.url)) invalid();
  const source = ref as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || typeof source.courseId !== "string" || !source.courseId || source.courseId.length > 128
    || typeof source.reviewToken !== "string" || !source.reviewToken || source.reviewToken.length > 8_192) invalid();
  if (!context.schoolId || !context.actorId || context.targetScope !== "students"
    || Boolean(context.teachingSessionId) === Boolean(context.supervisionContextId)
    || context.supervisionContextId && !context.contextAuthorityRevision
    || context.teachingSessionId && context.contextAuthorityRevision !== undefined
    || !Array.isArray(context.targetStudentIds) || context.targetStudentIds.length < 1 || context.targetStudentIds.length > 500
    || context.targetStudentIds.some(id => typeof id !== "string" || !id.trim() || id.length > 128)
    || new Set(context.targetStudentIds).size !== context.targetStudentIds.length) invalid();
  if (!(dependencies.enabled ?? isClasspilotCapabilityActive(CLASSROOM_FOCUS_SCOPE_CAPABILITY, { schoolId: context.schoolId }))) {
    throw Object.assign(new Error("Classroom Focus is not enabled for this school"), { status: 409, code: "CLASSROOM_FOCUS_DISABLED" });
  }
  const confirm = dependencies.confirm ?? (await import("./classpilotClassroomFocusReview.js")).confirmClassroomFocusReview;
  const classroomScope = normalizeClassroomFocusScope(await confirm({ schoolId: context.schoolId, actorId: context.actorId,
    authority: context.teachingSessionId ? { teachingSessionId: context.teachingSessionId }
      : { supervisionContextId: context.supervisionContextId!, contextAuthorityRevision: context.contextAuthorityRevision! },
    targetStudentIds: [...context.targetStudentIds], courseId: source.courseId, reviewToken: source.reviewToken }));
  return { url: "https://classroom.google.com/", classroomScope };
}
