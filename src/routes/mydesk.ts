import { Router, type Request, type Response, type NextFunction } from "express";
import { ZodError } from "zod";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContextWithoutTenantBinding } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { createRequireClasspilotEntitlement } from "../middleware/requireClasspilotEntitlement.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { resolveClasspilotEntitlement } from "../services/classpilotEntitlement.js";
import { myDeskActor, rejectMyDeskPrivilegedAccess, requireMyDeskAuthor, requireMyDeskEnabled } from "../middleware/requireMyDesk.js";
import { createLocalDateFormatter } from "../util/schoolTime.js";
import { completeMyDeskNote, createMyDeskNote, deleteMyDeskNote, exportMyDeskNotes, getMyDeskNote, listMyDeskClasses, listMyDeskClassStudents, listMyDeskClassNoteStudents, listMyDeskNotes, myDeskError, updateMyDeskNote } from "../services/mydesk.js";
import { completeMyDeskNoteInput, createMyDeskNoteInput, deleteMyDeskNoteInput, MYDESK_CATEGORIES, myDeskEnabledForSchool, myDeskSeatingEnabledForSchool, myDeskId, myDeskNotesQuery, updateMyDeskNoteInput } from "../services/mydeskValidation.js";
import { mydeskAttachmentsRouter } from "./mydeskAttachments.js";
import { mydeskSeatingRouter } from "./mydeskSeating.js";
import { mydeskImportsRouter } from "./mydeskImports.js";
import { myDeskImportsEnabledForSchool, myDeskImportLimits } from "../services/mydeskImportsValidation.js";

const router = Router();
const requireMyDeskEntitlement = createRequireClasspilotEntitlement(schoolId =>
  runWithTenantContext({ schoolId }, () => resolveClasspilotEntitlement(schoolId)));
router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff"); next(); });
router.use(authenticate, rejectMyDeskPrivilegedAccess, requireSchoolContextWithoutTenantBinding, requireActiveSchool, requireMyDeskEntitlement, requireMyDeskAuthor);
router.get("/capabilities", (req, res) => {
  const { schoolId } = myDeskActor(req, res);
  let aiImportEnabled = myDeskImportsEnabledForSchool(schoolId);
  let importLimits: ReturnType<typeof myDeskImportLimits> | null = null;
  let importUnavailableCode: string | null = null;
  try {
    importLimits = myDeskImportLimits();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "MYDESK_IMPORT_CONFIGURATION") throw error;
    // An import-only configuration failure must not hide the private notebook.
    aiImportEnabled = false;
    importUnavailableCode = "MYDESK_IMPORT_CONFIGURATION";
  }
  res.json({ enabled: myDeskEnabledForSchool(schoolId), seatingEnabled: myDeskSeatingEnabledForSchool(schoolId), aiImportEnabled, importProvider: "Anthropic", importLimits, importUnavailableCode, schoolDate: createLocalDateFormatter(res.locals.school?.schoolTimezone)(new Date()) });
});
router.use(requireMyDeskEnabled);
router.use(mydeskAttachmentsRouter);
router.use(mydeskSeatingRouter);
router.use(mydeskImportsRouter);
export const myDeskEndpoint = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  void handler(req, res).catch(error => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: "Invalid notebook request", code: "MYDESK_INVALID", fields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) }); return;
    }
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      res.status(error.status).json({ error: error.message, code: "code" in error ? error.code : "MYDESK_UNAVAILABLE" }); return;
    }
    next(error);
  });
};
router.get("/categories", (_req, res) => { res.json({ categories: MYDESK_CATEGORIES }); });
router.get("/classes", myDeskEndpoint(async (req, res) => res.json(await listMyDeskClasses(myDeskActor(req, res)))));
router.get("/classes/:id/students", myDeskEndpoint(async (req, res) => res.json(await listMyDeskClassStudents(myDeskActor(req, res), myDeskId.parse(req.params.id)))));
router.get("/classes/:id/note-students", myDeskEndpoint(async (req, res) => res.json(await listMyDeskClassNoteStudents(myDeskActor(req, res), myDeskId.parse(req.params.id)))));
function noteFilters(req: Request) {
  const filters = myDeskNotesQuery.parse(req.method === "POST" ? req.body : req.query);
  // Authored search terms belong in the JSON body, not browser/ALB URL logs.
  if (req.method === "GET" && filters.q) throw myDeskError(400, "MYDESK_PRIVATE_SEARCH_REQUIRED", "Submit notebook search filters in the request body");
  return filters;
}
const searchNotes = myDeskEndpoint(async (req, res) => res.json(await listMyDeskNotes(myDeskActor(req, res), noteFilters(req))));
router.get("/notes", searchNotes);
router.post("/notes/search", searchNotes);
const exportNotes = myDeskEndpoint(async (req, res) => {
  const result = await exportMyDeskNotes(myDeskActor(req, res), noteFilters(req));
  res.set("Content-Type", "text/csv; charset=utf-8"); res.set("Content-Disposition", 'attachment; filename="my-desk.csv"');
  res.set("X-MyDesk-Row-Count", String(result.rowCount)); res.set("X-MyDesk-Export-Limit", "5000"); return res.send(result.csv);
});
router.get("/export", exportNotes);
router.post("/export", exportNotes);
router.post("/notes", myDeskEndpoint(async (req, res) => {
  const result = await createMyDeskNote(myDeskActor(req, res), createMyDeskNoteInput.parse(req.body));
  return res.status(result.created ? 201 : 200).json({ note: result.note });
}));
router.get("/notes/:id", myDeskEndpoint(async (req, res) => res.json({ note: await getMyDeskNote(myDeskActor(req, res), myDeskId.parse(req.params.id)) })));
router.patch("/notes/:id", myDeskEndpoint(async (req, res) => {
  const { revision, ...patch } = updateMyDeskNoteInput.parse(req.body);
  return res.json({ note: await updateMyDeskNote(myDeskActor(req, res), myDeskId.parse(req.params.id), revision, patch) });
}));
router.post("/notes/:id/complete", myDeskEndpoint(async (req, res) => {
  const { revision, attachmentIds, ...patch } = completeMyDeskNoteInput.parse(req.body);
  return res.json({ note: await completeMyDeskNote(myDeskActor(req, res), myDeskId.parse(req.params.id), revision, patch, attachmentIds) });
}));
router.delete("/notes/:id", myDeskEndpoint(async (req, res) => {
  const { revision } = deleteMyDeskNoteInput.parse(req.body);
  await deleteMyDeskNote(myDeskActor(req, res), myDeskId.parse(req.params.id), revision); return res.json({ ok: true });
}));

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Invalid notebook request", code: "MYDESK_INVALID" }); return;
  }
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    res.status(error.status).json({ error: error.message, code: "code" in error ? error.code : "MYDESK_UNAVAILABLE" }); return;
  }
  // Keep database parameters, authored content and raw storage errors out of generic request/error logging.
  console.error(JSON.stringify({ event: "mydesk_request_failed" }));
  res.status(503).json({ error: "My Desk is temporarily unavailable. Please retry.", code: "MYDESK_UNAVAILABLE" });
});
export default router;
