import { Router, type Request, type Response } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireDeviceAuth } from "../../middleware/requireDeviceAuth.js";
import { requireClasspilotFullMonitoring } from "../../services/classpilotMonitoringPolicy.js";
import { parseClasspilotActivityAuthority, requireScheduledClassroomRequestRevision } from "../../services/classpilotActivityAuthority.js";
import { mutateStudentHelp, readClassTools, readToolsPresentation, scanToolSubmission, submitQuestion, updateHelp, updateLessonProgress, updateQuestion } from "../../services/classpilotClassTools.js";
import { deleteToolTemplate, previewToolsFollowUp, sendToolsFollowUp, readToolsHistory, readToolsHistoryItem, saveToolTemplate, updatePicker } from "../../services/classpilotToolsPlanning.js";
import { publishClassToolsChanged } from "../../services/classpilotToolsEvents.js";
import { toolId, toolRevision } from "../../services/classpilotToolsValidation.js";
import { toolsError, type ToolsScope, type ToolsStudentScope } from "../../services/classpilotToolsAuthority.js";
import { studentSessionRateLimitKey } from "./chat.js";
import { classToolsPhase } from "../../config/classpilotClassTools.js";
import { readClasspilotRealtimeStatusBatch, classpilotRealtimeFresh } from "../../services/classpilotRealtimeStatus.js";
import { startRoutine, advanceRoutine } from "../../services/classpilotToolsRoutines.js";

const router = Router();
const staffAuth = [authenticate, requireSchoolContext, requireClasspilotEntitlement, requireClasspilotFullMonitoring, requireRole("teacher", "admin", "school_admin", "office_staff")] as const;
const studentLimiter = rateLimit({ windowMs: 60_000, max: 60, keyGenerator: studentSessionRateLimitKey, standardHeaders: true, legacyHeaders: false });
const studentAuth = [requireDeviceAuth, requireClasspilotEntitlement, studentLimiter] as const;
async function requireStudentCapability(scope: ToolsStudentScope, capability: string) {
  const states = await readClasspilotRealtimeStatusBatch(scope.schoolId, [scope]);
  const state = states.get(scope.studentId);
  if (state?.status !== "hit" || !classpilotRealtimeFresh(state.snapshot) || !state.snapshot.acceptedCapabilities?.includes(capability)) {
    throw toolsError("Update or reconnect ClassPilot to use this tool", "CLASS_TOOLS_CLIENT_UNSUPPORTED", 409);
  }
}
const envelope = z.object({ teachingSessionId: toolId.optional(), supervisionContextId: toolId.optional(), data: z.unknown().optional(), studentControlRevision: z.number().int().nonnegative().optional() }).strict();
function staffScope(req: Request, res: Response): ToolsScope {
  const raw = req.method === "GET" ? req.query : envelope.parse(req.body);
  const authority = parseClasspilotActivityAuthority(raw);
  if (!authority) throw toolsError("Exactly one classroom authority is required", "CLASS_TOOLS_AUTHORITY_REQUIRED", 400);
  return { schoolId: res.locals.schoolId!, actorId: req.authUser!.id, authority,
    ...(authority.supervisionContextId ? { contextAuthorityRevision: requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")) } : {}) };
}
function studentScope(req: Request, res: Response): ToolsStudentScope {
  const body = envelope.parse(req.body); const authority = parseClasspilotActivityAuthority(body);
  if (!authority) throw toolsError("Exactly one classroom authority is required", "CLASS_TOOLS_AUTHORITY_REQUIRED", 400);
  return { schoolId: res.locals.schoolId!, studentId: res.locals.studentId!, studentSessionId: res.locals.studentSessionId!, deviceId: res.locals.deviceId!, authority, studentControlRevision: body.studentControlRevision };
}
const endpoint = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: (error?: unknown) => void) => {
  try { await handler(req, res); } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid Class tools request", code: "CLASS_TOOLS_INVALID", fields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) }); return; }
    const failure = error as { status?: number; code?: string; message?: string };
    if (failure.status) { res.status(failure.status).json({ error: failure.message, code: failure.code }); return; }
    next(error);
  }
};
const changed = async (scope: ToolsScope, studentIds: string[] = []) => {
  // The write has committed. A missed push is recovered through authoritative
  // snapshots; a relay outage must not falsely report the mutation failed.
  await publishClassToolsChanged(scope, studentIds).catch(() => {});
};

router.get("/class-tools/rollout", ...staffAuth, endpoint(async (_req, res) => { res.json({ phase: classToolsPhase(res.locals.schoolId!) }); }));
router.get("/class-tools/state", ...staffAuth, endpoint(async (req, res) => { res.set("Cache-Control", "no-store").json(await readClassTools(staffScope(req, res))); }));
router.get("/class-tools/presentation", ...staffAuth, endpoint(async (req, res) => { res.set("Cache-Control", "no-store").json(await readToolsPresentation(staffScope(req, res))); }));
router.get("/class-tools/history", ...staffAuth, endpoint(async (req, res) => {
  const cursor = req.query.beforeId ? { id: toolId.parse(req.query.beforeId), createdAt: z.coerce.date().parse(req.query.beforeTime) } : undefined;
  res.set("Cache-Control", "no-store").json(await readToolsHistory(staffScope(req, res), cursor));
}));
router.post("/class-tools/help/:id", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res); const input = z.object({ expectedRevision: toolRevision, action: z.enum(["acknowledge", "helped"]) }).strict().parse(req.body.data);
  const hand = await updateHelp(scope, toolId.parse(req.params.id), input.expectedRevision, input.action);
  await changed(scope, [hand.studentId]); res.json({ help: hand });
}));
router.post("/class-tools/questions/:id", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res); const input = z.object({ expectedRevision: toolRevision, groupLabel: z.string().trim().max(100).optional(), answer: z.string().trim().max(500).optional(), resolve: z.boolean().optional() }).strict().parse(req.body.data);
  const question = await updateQuestion(scope, toolId.parse(req.params.id), input.expectedRevision, input);
  await changed(scope, [question.studentId]); res.json({ question });
}));
router.post("/class-tools/picker", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res); const input = z.object({ action: z.enum(["pick", "pass", "reset", "exclude"]), expectedRevision: z.number().int().nonnegative(), excludedStudentIds: z.array(toolId).max(500).optional(), volunteerPollId: toolId.optional() }).strict().parse(req.body.data);
  const picker = await updatePicker(scope, input); await changed(scope); res.json({ picker });
}));
router.post("/class-tools/templates", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res); const input = z.object({ id: toolId.optional(), expectedRevision: toolRevision.optional(), name: z.string().trim().min(1).max(100), kind: z.enum(["attention", "poll", "exit_ticket", "activity", "routine"]), content: z.unknown() }).strict().parse(req.body.data);
  res.json({ template: await saveToolTemplate(scope, { ...input, content: input.content }) });
}));
router.delete("/class-tools/templates/:id", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res); const input = z.object({ expectedRevision: toolRevision }).strict().parse(req.body.data);
  await deleteToolTemplate(scope, toolId.parse(req.params.id), input.expectedRevision); res.json({ ok: true });
}));
router.post("/class-tools/follow-up-preview", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res); const input = z.object({ kind: z.enum(["work_status", "answer"]), resourceId: toolId, status: z.enum(["working", "stuck", "ready_for_review", "finished", "not_reported"]).optional(), selectedOption: z.number().int().min(0).max(4).optional() }).strict().parse(req.body.data);
  res.json(await previewToolsFollowUp(scope, input));
}));
router.get("/class-tools/history/:kind/:id", ...staffAuth, endpoint(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await readToolsHistoryItem(staffScope(req, res), z.enum(["activity", "prompt"]).parse(req.params.kind), toolId.parse(req.params.id)));
}));
router.post("/class-tools/follow-up", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res);
  const input = z.object({ kind: z.enum(["work_status", "answer"]), resourceId: toolId, targetStudentIds: z.array(toolId).min(1).max(500),
    commandType: z.enum(["teacher-message", "open-tab"]), commandPayload: z.record(z.unknown()) }).strict().parse(req.body.data);
  res.json(await sendToolsFollowUp(scope, input));
}));
router.post("/class-tools/routines", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res);
  const input = z.object({ templateId: toolId, targetStudentIds: z.array(toolId).min(1).max(500) }).strict().parse(req.body.data);
  const routine = await startRoutine(scope, input.templateId, input.targetStudentIds);
  await changed(scope); res.status(201).json({ routine });
}));
router.post("/class-tools/routines/:id", ...staffAuth, endpoint(async (req, res) => {
  const scope = staffScope(req, res);
  const input = z.object({ action: z.enum(["next", "launch", "skip", "retry", "end"]), expectedRevision: toolRevision, step: z.number().int().min(0).max(19).optional() }).strict().parse(req.body.data);
  const result = await advanceRoutine(scope, toolId.parse(req.params.id), input);
  await changed(scope); res.json(result);
}));

router.post("/student/class-tools/help", ...studentAuth, endpoint(async (req, res) => {
  const scope = studentScope(req, res); await requireStudentCapability(scope, "helpRequestsV1"); const help = await mutateStudentHelp(scope, "request", req.body.data);
  const teacherScope = { ...scope, actorId: scope.studentId };
  await changed(teacherScope, [scope.studentId]);
  if (help?.explanation) void scanToolSubmission(scope, help.id, help.explanation);
  res.json({ help });
}));
router.delete("/student/class-tools/help", ...studentAuth, endpoint(async (req, res) => {
  const scope = studentScope(req, res); await requireStudentCapability(scope, "helpRequestsV1"); await mutateStudentHelp(scope, "withdraw", null); await changed({ ...scope, actorId: scope.studentId }, [scope.studentId]); res.json({ help: null });
}));
router.post("/student/class-tools/questions", ...studentAuth, endpoint(async (req, res) => {
  const scope = studentScope(req, res); await requireStudentCapability(scope, "questionParkingV1"); const input = z.object({ clientRequestId: z.string().uuid(), question: z.string().trim().min(1).max(500) }).strict().parse(req.body.data);
  const result = await submitQuestion(scope, input.clientRequestId, input.question);
  await changed({ ...scope, actorId: scope.studentId }, [scope.studentId]); if (result.created) void scanToolSubmission(scope, result.question.id, input.question);
  res.status(result.created ? 201 : 200).json(result);
}));
router.put("/student/class-tools/progress", ...studentAuth, endpoint(async (req, res) => {
  const scope = studentScope(req, res); await requireStudentCapability(scope, "lessonActivitiesV1"); const progress = await updateLessonProgress(scope, req.body.data);
  await changed({ ...scope, actorId: scope.studentId }, [scope.studentId]); res.json({ progress });
}));
export default router;
