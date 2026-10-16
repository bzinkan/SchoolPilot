import { Router, raw, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { ClasspilotSettingsError, getClasspilotSchoolSettings, getClasspilotTeacherPreferences,
  updateClasspilotSchoolSettings, updateClasspilotTeacherPreferences } from "../../services/classpilotSettings.js";
import { DASHBOARD_THEME_ASSET_MAX_BYTES } from "../../services/classpilotThemes.js";
import { deleteDashboardThemeAsset, readDashboardThemeAsset, reserveDashboardThemeAsset,
  uploadDashboardThemeAsset } from "../../services/classpilotThemeAssets.js";

const router = Router();
const auth = [authenticate, requireSchoolContext, requireActiveSchool, requireClasspilotEntitlement] as const;
const teachers = requireRole("teacher", "admin", "school_admin");
const administrators = requireRole("admin", "school_admin");
const scope = (req: Request, res: Response) => ({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id });
function handle(action: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(action(req, res, next)).catch(error => {
      if (error instanceof ClasspilotSettingsError) {
        res.status(error.status).json({ error: error.message, code: error.code,
          ...(error.current === undefined ? {} : { current: error.current }) });
      } else if (error?.code === "SCHOOL_WEBSITE_POLICY_CONFLICT") {
        res.status(409).json({ error: error.message, code: error.code, revision: error.revision });
      } else next(error);
    });
  };
}
router.get("/teacher/preferences", ...auth, teachers, handle(async (req, res) => {
  res.json(await getClasspilotTeacherPreferences(scope(req, res)));
}));
router.patch("/teacher/preferences", ...auth, teachers, handle(async (req, res) => {
  res.json(await updateClasspilotTeacherPreferences(scope(req, res), req.body));
}));
router.get("/admin/settings", ...auth, administrators, handle(async (req, res) => {
  res.json(await getClasspilotSchoolSettings(scope(req, res)));
}));
router.patch("/admin/settings/:section", ...auth, administrators, handle(async (req, res) => {
  res.json(await updateClasspilotSchoolSettings(scope(req, res), String(req.params.section), req.body));
}));

// Teacher background image: reserve, PUT raw bytes, read, delete. A malformed
// id is a 404 like an unknown one, so existence is never confirmed.
const assetId = z.string().uuid();
function parseAssetId(value: unknown): string {
  const parsed = assetId.safeParse(value);
  if (!parsed.success) throw new ClasspilotSettingsError("Background image not found.", 404, "CLASSPILOT_DASHBOARD_THEME_ASSET_NOT_FOUND");
  return parsed.data;
}
// Image normalization is native work; at most two uploads decode at once per process.
let uploadsInFlight = 0;
const admitUpload: RequestHandler = (_req, res, next) => {
  if (uploadsInFlight >= 2) {
    res.set("Retry-After", "2").status(429).json({ error: "Other background images are uploading. Retry shortly.", code: "CLASSPILOT_DASHBOARD_THEME_UPLOAD_BUSY" });
    return;
  }
  uploadsInFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; uploadsInFlight--; } };
  res.once("finish", release); res.once("close", release);
  next();
};
const rawParser = raw({ type: () => true, limit: DASHBOARD_THEME_ASSET_MAX_BYTES });
const rawBody: RequestHandler = (req, res, next) => rawParser(req, res, error => {
  if (!error) return next();
  if (error?.type === "entity.too.large") {
    res.status(413).json({ error: "The image must be no larger than 6 MiB.", code: "CLASSPILOT_DASHBOARD_THEME_ASSET_TOO_LARGE" });
    return;
  }
  next(error);
});
function etagMatches(header: string | undefined, sha256: string): boolean {
  if (!header) return false;
  return header.split(",").some(token => {
    const value = token.trim();
    return value === "*" || value.replace(/^W\//, "").replace(/^"|"$/g, "") === sha256;
  });
}
function knownSha256(header: string | undefined): string[] {
  return (header ?? "").split(",").map(token => token.trim().replace(/^W\//, "").replace(/^"|"$/g, "")).filter(value => /^[a-f0-9]{64}$/.test(value));
}
router.post("/teacher/theme-asset", ...auth, teachers, handle(async (req, res) => {
  res.status(201).json(await reserveDashboardThemeAsset(scope(req, res), req.body));
}));
router.put("/teacher/theme-asset/:id/content", ...auth, teachers, admitUpload, rawBody, handle(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new ClasspilotSettingsError("Upload the image bytes directly.", 400, "CLASSPILOT_DASHBOARD_THEME_ASSET_BODY_REQUIRED");
  }
  const contentType = (req.get("content-type") || "").split(";", 1)[0]!.trim().toLowerCase();
  res.json(await uploadDashboardThemeAsset(scope(req, res), parseAssetId(req.params.id), req.body, contentType));
}));
// A stylesheet url() cannot send headers: requireSchoolContext also accepts ?schoolId=.
router.get("/teacher/theme-asset/:id/content", ...auth, teachers, handle(async (req, res) => {
  const ifNoneMatch = req.get("if-none-match");
  const file = await readDashboardThemeAsset(scope(req, res), parseAssetId(req.params.id), { allowAdmin: true, knownSha256: knownSha256(ifNoneMatch) });
  res.set({ "Cache-Control": "private, max-age=86400", ETag: `"${file.sha256}"`, "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'" });
  if (file.unchanged || etagMatches(ifNoneMatch, file.sha256)) { res.status(304).end(); return; }
  res.set({ "Content-Type": file.contentType, "Content-Length": String(file.byteSize) }).send(file.bytes);
}));
router.delete("/teacher/theme-asset/:id", ...auth, teachers, handle(async (req, res) => {
  res.json({ preferences: await deleteDashboardThemeAsset(scope(req, res), parseAssetId(req.params.id)) });
}));
export default router;
