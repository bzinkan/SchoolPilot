import { Router, raw, type ErrorRequestHandler, type RequestHandler } from "express";
import { z } from "zod";
import { myDeskActor } from "../middleware/requireMyDesk.js";
import { deleteMyDeskAttachment, readMyDeskAttachment, reserveMyDeskAttachment, uploadMyDeskAttachment } from "../services/mydeskAttachments.js";
import { MYDESK_MAX_FILE_BYTES, MyDeskFileError } from "../services/mydeskFiles.js";

export const mydeskAttachmentsRouter = Router();
const path = z.object({ noteId: z.string().uuid(), attachmentId: z.string().uuid().optional() });
const reservation = z.object({ clientRequestId: z.string().uuid(), filename: z.string().trim().min(1).max(255)
  .refine(value => !/[\u0000-\u001f\u007f/\\]/.test(value), "Invalid filename"), contentType: z.string().max(100),
  size: z.number().int().positive().max(MYDESK_MAX_FILE_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const revisionSchema = z.object({ revision: z.number().int().positive() }).strict();
let activeUploads = 0;
const boundUploadMemory: RequestHandler = (_req, res, next) => {
  // Admit before reading the 10-MiB body. Bounded image decoding alone does not bound simultaneous requests.
  if (activeUploads >= 2) {
    res.set("Retry-After", "2").status(429).json({ error: "Other files are uploading. Retry in a moment.", code: "upload_busy" }); return;
  }
  activeUploads++;
  let released = false;
  const release = () => { if (!released) { released = true; activeUploads--; } };
  res.locals.myDeskReleaseUpload = release;
  const releaseUnread = () => { if (!res.locals.myDeskUploadStarted) release(); };
  res.once("finish", releaseUnread); res.once("close", releaseUnread); next();
};

mydeskAttachmentsRouter.post("/notes/:noteId/attachments", async (req, res, next) => {
  try {
    const actor = myDeskActor(req, res); if (!actor) return;
    const { noteId } = path.parse(req.params);
    const attachment = await reserveMyDeskAttachment(actor, noteId, reservation.parse(req.body));
    res.status(201).json({ attachment });
  } catch (error) { next(error); }
});

mydeskAttachmentsRouter.put("/notes/:noteId/attachments/:attachmentId/content", boundUploadMemory, raw({ type: () => true, limit: MYDESK_MAX_FILE_BYTES }), async (req, res, next) => {
  res.locals.myDeskUploadStarted = true;
  try {
    const actor = myDeskActor(req, res); if (!actor) return;
    const { noteId, attachmentId } = path.parse(req.params);
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes)) throw new MyDeskFileError(400, "file_required", "Upload the file bytes directly.");
    const contentType = (req.get("content-type") || "").split(";", 1)[0]!.trim().toLowerCase();
    res.json({ attachment: await uploadMyDeskAttachment(actor, noteId, attachmentId!, bytes, contentType) });
  } catch (error) { next(error); }
  finally { res.locals.myDeskReleaseUpload?.(); }
});

mydeskAttachmentsRouter.get("/notes/:noteId/attachments/:attachmentId/content", async (req, res, next) => {
  try {
    const actor = myDeskActor(req, res); if (!actor) return;
    const { noteId, attachmentId } = path.parse(req.params);
    const file = await readMyDeskAttachment(actor, noteId, attachmentId!);
    res.set({ "Cache-Control": "private, no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
      "Content-Type": file.contentType, "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": `attachment; filename="attachment.${file.contentType === "application/pdf" ? "pdf" : "jpg"}"`,
      "Content-Length": String(file.bytes.length) }).send(file.bytes);
  } catch (error) { next(error); }
});

mydeskAttachmentsRouter.delete("/notes/:noteId/attachments/:attachmentId", async (req, res, next) => {
  try {
    const actor = myDeskActor(req, res); if (!actor) return;
    const { noteId, attachmentId } = path.parse(req.params);
    res.json(await deleteMyDeskAttachment(actor, noteId, attachmentId!, revisionSchema.parse(req.body).revision));
  } catch (error) { next(error); }
});

const fileErrors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (error instanceof MyDeskFileError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
    res.status(413).json({ error: "Each file must be no larger than 10 MiB.", code: "file_too_large" }); return;
  }
  next(error);
};
mydeskAttachmentsRouter.use(fileErrors);
