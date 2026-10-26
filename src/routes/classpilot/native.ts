import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { ClasspilotNativeError, NATIVE_LIMITS, nativeLeaseSchema, nativeTileSchema, nativeObservationSchema,
  parseNativeCredential } from "../../services/classpilotNativeProtocol.js";
import { issueNativeEnrollment, enrollNativeInstallation, signInNativeStudent, renewNativeSession, signOutNativeSession,
  revokeNativeInstallation, nativeCapturePolicy, stopNativeObservation, acceptNativeObservation, renewNativeViewer,
  releaseNativeViewer, readNativeTiles, checkNativeSessionCredential } from "../../services/classpilotNative.js";
import { normalizeClasspilotNativeJpeg } from "../../services/classpilotNativeImage.js";
import { runWithoutTenantContext } from "../../db/tenantContext.js";
import { nativePhase, nativeRequestDiagnostics, nativeRequestFailure } from "../../services/classpilotNativeDiagnostics.js";

const router = Router();
const releaseStaffContext: RequestHandler = (req, res, next) => {
  // Staff authentication has finished. Native authority owns its own tenant
  // transaction, so never hold this client while waiting for a second one.
  void Promise.resolve(res.locals.releaseTenantContext?.()).then(() => {
    if (!res.destroyed && !res.writableEnded) runWithoutTenantContext(() => next());
  }, next);
};
const staff = [authenticate, requireSchoolContext, requireActiveSchool, requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "teacher", "office_staff"), releaseStaffContext] as const;
const scope = (req: Request, res: Response) => ({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id,
  authVersion: req.authUser!.authVersion,
  contextAuthorityRevision: req.get("X-ClassPilot-Context-Authority-Revision") });
function bearer(req: Request): string {
  const header = req.get("Authorization");
  if (!header || !/^Bearer [^\s]+$/i.test(header)) throw new ClasspilotNativeError("NATIVE_CREDENTIAL_INVALID", 401);
  return header.slice(7);
}
function handle(action: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve().then(() => action(req, res, next)).catch(error => {
      nativeRequestFailure(error);
      if (res.headersSent || res.writableEnded || res.destroyed) return next(error);
      if (error instanceof z.ZodError) return res.status(400).json({ code: "NATIVE_INVALID_REQUEST", error: "Invalid native request" });
      if (error instanceof ClasspilotNativeError) return res.status(error.status).json({ code: error.code, error: error.message });
      if (error?.code === "CLASSROOM_AUTHORITY_CHANGED") return res.status(409).json({ code: error.code, error: "Refresh classroom authority" });
      next(error);
    }).catch(next);
  };
}
router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }); next(); });
router.use(nativeRequestDiagnostics);

router.post("/enrollment-tokens", ...staff, requireRole("admin", "school_admin"), handle(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.status(201).json(await issueNativeEnrollment(scope(req, res)));
}));
router.delete("/installations/:installationId", ...staff, requireRole("admin", "school_admin"), handle(async (req, res) => {
  await revokeNativeInstallation(scope(req, res), z.string().uuid().parse(req.params.installationId));
  res.status(204).end();
}));
router.post("/enroll", handle(async (req, res) => {
  const body = z.object({ enrollmentToken: z.string().min(1).max(600), clientVersion: z.string().min(1).max(40)
    .regex(/^[A-Za-z0-9_.+-]+$/) }).strict().parse(req.body);
  res.status(201).json(await enrollNativeInstallation(body, req.ip ?? "unknown"));
}));
router.post("/sessions", handle(async (req, res) => {
  const body = z.object({ identifier: z.string().trim().min(1).max(200), pin: z.string().regex(/^\d{4}$/),
    osSessionNonce: z.string().uuid() }).strict().parse(req.body);
  res.status(201).json(await signInNativeStudent(bearer(req), body, req.ip ?? "unknown"));
}));
router.post("/session/renew", handle(async (req, res) => {
  const body = z.object({ osSessionNonce: z.string().uuid() }).strict().parse(req.body);
  res.json(await renewNativeSession(bearer(req), body.osSessionNonce));
}));
router.delete("/session", handle(async (req, res) => { await signOutNativeSession(bearer(req)); res.status(204).end(); }));
router.get("/policy", handle(async (req, res) => {
  const query = z.object({ sourceGeneration: z.string().uuid(), bindingRevision: z.coerce.number().int().positive().max(2_147_483_647) }).strict().parse(req.query);
  res.json(await nativeCapturePolicy(bearer(req), query.sourceGeneration, query.bindingRevision));
}));
router.delete("/observations", handle(async (req, res) => {
  const body = z.object({ bindingRevision: z.number().int().positive().max(2_147_483_647),
    sourceGeneration: z.string().uuid().optional() }).strict().parse(req.body);
  await stopNativeObservation(bearer(req), body.bindingRevision, body.sourceGeneration); res.status(204).end();
}));

const uploads = new Set<string>();
const admitUpload = handle(async (req, res, next) => {
  const token = bearer(req);
  const credential = parseNativeCredential(token, "session");
  const key = `${credential.schoolId}:${credential.id}`;
  if (uploads.size >= 2 || uploads.has(key)) throw new ClasspilotNativeError("NATIVE_UPLOAD_BUSY", 429);
  await checkNativeSessionCredential(token);
  if (uploads.size >= 2 || uploads.has(key)) throw new ClasspilotNativeError("NATIVE_UPLOAD_BUSY", 429);
  uploads.add(key);
  const release = () => uploads.delete(key);
  res.once("finish", release); res.once("close", release);
  next();
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: NATIVE_LIMITS.maxBytes,
  files: 1, fields: 1, fieldSize: 4096, parts: 2, fieldNameSize: 50 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "image/jpeg") callback(new ClasspilotNativeError("NATIVE_INVALID_OBSERVATION", 400));
    else callback(null, true);
  } });
const parseUpload: RequestHandler = (req, res, next) => upload.single("image")(req, res, error => {
  if (error) { res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ code: "NATIVE_INVALID_OBSERVATION", error: "Upload one bounded JPEG and metadata field" }); return; }
  next();
});
router.post("/observations", admitUpload, parseUpload, handle(async (req, res) => {
  let normalized: Buffer | undefined;
  try {
    if (!req.file || !req.body || Object.keys(req.body).length !== 1 || typeof req.body.metadata !== "string") {
      throw new ClasspilotNativeError("NATIVE_INVALID_OBSERVATION", 400);
    }
    let raw: unknown;
    try { raw = JSON.parse(req.body.metadata); } catch { throw new ClasspilotNativeError("NATIVE_INVALID_OBSERVATION", 400); }
    const metadata = nativeObservationSchema.parse(raw);
    normalized = await nativePhase("image_decode", () => normalizeClasspilotNativeJpeg(req.file!.buffer));
    res.json(await acceptNativeObservation(bearer(req), metadata, normalized));
  } finally { req.file?.buffer.fill(0); normalized?.fill(0); }
}));
router.put("/observation-leases/:viewerInstanceId", ...staff, handle(async (req, res) => {
  const input = nativeLeaseSchema.parse(req.body);
  res.json(await renewNativeViewer(scope(req, res), z.string().uuid().parse(req.params.viewerInstanceId), input));
}));
router.delete("/observation-leases/:viewerInstanceId", ...staff, handle(async (req, res) => {
  await releaseNativeViewer(scope(req, res), z.string().uuid().parse(req.params.viewerInstanceId)); res.status(204).end();
}));
router.post("/tiles/desktop", ...staff, handle(async (req, res) => {
  await readNativeTiles(scope(req, res), nativeTileSchema.parse(req.body), response => res.json(response));
}));
export default router;
