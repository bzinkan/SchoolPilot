import { Router, raw, type Request, type Response, type NextFunction, type ErrorRequestHandler, type RequestHandler } from "express";
import { z, ZodError } from "zod";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContextWithoutTenantBinding } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { myDeskActor, rejectMyDeskPrivilegedAccess, requireMyDeskAuthor } from "../middleware/requireMyDesk.js";
import { disciplineId } from "../services/schoolDisciplineValidation.js";
import { disciplineCapabilities, listDisciplineAccess, setDisciplineAccess } from "../services/schoolDisciplineAccess.js";
import { submitDisciplineRecord, correctDisciplineRecord, withdrawDisciplineRecord, getDisciplineRecord, searchDisciplineRecords,
  exportDisciplineRecords, readDisciplineAttachment } from "../services/schoolDiscipline.js";
import { myDeskObjectStore, MyDeskFileError, MYDESK_MAX_FILE_BYTES, type MyDeskObjectStore } from "../services/mydeskFiles.js";
import { createDisciplineDraft, getDisciplineDraft, updateDisciplineDraft, reserveDisciplineAttachment, uploadDisciplineAttachment,
  finalizeDisciplineDraft, cancelDisciplineDraft, getDisciplineDuplicates, listDisciplineStudents, getDisciplineStudent,
  exportDisciplineStudentSummary, readDisciplineDraftAttachment } from "../services/schoolDisciplineWorkspace.js";

export function createSchoolDisciplineRouter(store: MyDeskObjectStore = myDeskObjectStore) {
  const router = Router();
  router.use((_req, res, next) => { res.set({ "Cache-Control": "private, no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff" }); next(); });
  router.use(authenticate, rejectMyDeskPrivilegedAccess, requireSchoolContextWithoutTenantBinding, requireActiveSchool, requireMyDeskAuthor);
  const endpoint = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
  let uploads = 0;
  const admitUpload: RequestHandler = (_req, res, next) => {
    if (uploads >= 2) { res.set("Retry-After", "2").status(429).json({ code: "DISCIPLINE_UPLOAD_BUSY", error: "Other files are uploading. Retry shortly" }); return; }
    uploads++; let released = false;
    res.locals.releaseDisciplineUpload = () => { if (!released) { released = true; uploads--; } };
    const unread = () => { if (!res.locals.disciplineUploadStarted) res.locals.releaseDisciplineUpload(); };
    res.once("finish", unread); res.once("close", unread); next();
  };
  router.get("/capabilities", endpoint(async (req, res) => res.json(await disciplineCapabilities(myDeskActor(req, res)))));
  router.post("/students/search", endpoint(async (req, res) => res.json(await listDisciplineStudents(myDeskActor(req, res), req.body))));
  router.post("/students/export", endpoint(async (req, res) => {
    const result = await exportDisciplineStudentSummary(myDeskActor(req, res), req.body);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="discipline-student-totals.csv"',
      "X-Discipline-Row-Count": String(result.rowCount), "X-Discipline-Export-Limit": "5000" }).send(result.csv);
  }));
  router.post("/students/:studentId/history", endpoint(async (req, res) => res.json(await getDisciplineStudent(myDeskActor(req, res), disciplineId.parse(req.params.studentId), req.body))));
  router.post("/drafts", endpoint(async (req, res) => {
    const result = await createDisciplineDraft(myDeskActor(req, res), req.body); res.status(result.created ? 201 : 200).json(result);
  }));
  router.get("/:id/draft", endpoint(async (req, res) => res.json(await getDisciplineDraft(myDeskActor(req, res), disciplineId.parse(req.params.id)))));
  router.patch("/:id/draft", endpoint(async (req, res) => res.json(await updateDisciplineDraft(myDeskActor(req, res), disciplineId.parse(req.params.id), req.body))));
  router.delete("/:id/draft", endpoint(async (req, res) => res.json(await cancelDisciplineDraft(myDeskActor(req, res), disciplineId.parse(req.params.id), req.body))));
  router.get("/:id/duplicates", endpoint(async (req, res) => res.json(await getDisciplineDuplicates(myDeskActor(req, res), disciplineId.parse(req.params.id)))));
  router.post("/:id/attachments", endpoint(async (req, res) => res.status(201).json(await reserveDisciplineAttachment(myDeskActor(req, res), disciplineId.parse(req.params.id), req.body))));
  router.get("/:id/attachments/:attachmentId/content", endpoint(async (req, res) => {
    const file = await readDisciplineDraftAttachment(myDeskActor(req, res), disciplineId.parse(req.params.id), disciplineId.parse(req.params.attachmentId), store);
    res.set({ "Content-Type": file.contentType, "Content-Security-Policy": "sandbox; default-src 'none'", "Content-Length": String(file.bytes.length), "Content-Disposition": 'attachment; filename="draft-form"' }).send(file.bytes);
  }));
  router.put("/:id/attachments/:attachmentId/content", admitUpload, raw({ type: () => true, limit: MYDESK_MAX_FILE_BYTES }), endpoint(async (req, res) => {
    res.locals.disciplineUploadStarted = true;
    try {
      if (!Buffer.isBuffer(req.body)) throw new MyDeskFileError(400, "file_required", "Upload the file bytes directly");
      res.json(await uploadDisciplineAttachment(myDeskActor(req, res), disciplineId.parse(req.params.id), disciplineId.parse(req.params.attachmentId), req.body,
        (req.get("content-type") || "").split(";", 1)[0]!.trim().toLowerCase(), store));
    } finally { res.locals.releaseDisciplineUpload?.(); }
  }));
  router.post("/:id/finalize", endpoint(async (req, res) => res.json(await finalizeDisciplineDraft(myDeskActor(req, res), disciplineId.parse(req.params.id), req.body, store))));
  router.get("/access", endpoint(async (req, res) => res.json(await listDisciplineAccess(myDeskActor(req, res)))));
  router.put("/access/:userId", endpoint(async (req, res) => res.json(await setDisciplineAccess(myDeskActor(req, res), disciplineId.parse(req.params.userId), req.body))));
  router.post("/search", endpoint(async (req, res) => res.json(await searchDisciplineRecords(myDeskActor(req, res), req.body))));
  router.post("/export", endpoint(async (req, res) => {
    const result = await exportDisciplineRecords(myDeskActor(req, res), req.body);
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="school-discipline-records.csv"',
      "X-Discipline-Row-Count": String(result.rowCount), "X-Discipline-Export-Limit": "5000" }).send(result.csv);
  }));
  router.post("/submit", endpoint(async (req, res) => { const result = await submitDisciplineRecord(myDeskActor(req, res), req.body, store); return res.status(result.created ? 201 : 200).json(result); }));
  router.get("/:id", endpoint(async (req, res) => {
    const { versionsCursor } = z.object({ versionsCursor: z.coerce.number().int().positive().optional() }).strict().parse(req.query);
    res.json({ record: await getDisciplineRecord(myDeskActor(req, res), disciplineId.parse(req.params.id), versionsCursor) });
  }));
  router.post("/:id/correct", endpoint(async (req, res) => res.json(await correctDisciplineRecord(myDeskActor(req, res), disciplineId.parse(req.params.id), req.body, store))));
  router.post("/:id/withdraw", endpoint(async (req, res) => res.json(await withdrawDisciplineRecord(myDeskActor(req, res), disciplineId.parse(req.params.id), req.body))));
  router.get("/:id/versions/:versionId/attachments/:attachmentId/content", endpoint(async (req, res) => {
    const file = await readDisciplineAttachment(myDeskActor(req, res), disciplineId.parse(req.params.id), disciplineId.parse(req.params.versionId), disciplineId.parse(req.params.attachmentId), store);
    const extension = ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[file.contentType] || "bin";
    res.set({ "Content-Type": file.contentType, "Content-Security-Policy": "sandbox; default-src 'none'", "Content-Length": String(file.bytes.length),
      "Content-Disposition": `attachment; filename="evidence.${extension}"` }).send(file.bytes);
  }));
  const privateErrors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.end(); return; }
    if (error instanceof ZodError) { res.status(400).json({ error: "Invalid discipline record request", code: "DISCIPLINE_INVALID" }); return; }
    if (error instanceof MyDeskFileError) { res.status(error.status).json({ error: error.message, code: `DISCIPLINE_${error.code.toUpperCase()}` }); return; }
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      res.status(413).json({ error: "Each file must be no larger than 10 MiB", code: "DISCIPLINE_FILE_TOO_LARGE" }); return;
    }
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (typeof status === "number" && status >= 400 && status <= 599 && code?.startsWith("DISCIPLINE_")) {
      res.status(status).json({ error: (error as Error).message, code }); return;
    }
    // Auth middleware runs before endpoints. Preserve denial statuses so clients
    // clear private caches, without forwarding arbitrary middleware diagnostics.
    if (status === 401 || status === 403 || status === 404) {
      const safe = status === 401 ? { code: "DISCIPLINE_AUTH_REQUIRED", error: "Sign in to access discipline records" }
        : status === 403 ? { code: "DISCIPLINE_ACCESS_DENIED", error: "Discipline record access is unavailable" }
          : { code: "DISCIPLINE_NOT_FOUND", error: "Discipline record not found" };
      res.status(status).json(safe); return;
    }
    // Never pass source text, keys, filenames or storage-provider failures to generic logging.
    res.status(503).json({ error: "Discipline records are temporarily unavailable", code: "DISCIPLINE_UNAVAILABLE" });
  };
  router.use(privateErrors);
  return router;
}
export default createSchoolDisciplineRouter();
