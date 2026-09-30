import { Router, type Request } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole, requirePasspilotClassModel } from "../../services/passpilotAccess.js";
import { readPasspilotReportsMode } from "../../config/passpilotReportsMode.js";
import { getPasspilotReportCapabilities, getPasspilotReportSummary, getPasspilotReportPage, exportPasspilotReport } from "../../services/passpilotReports.js";
import { passpilotReportFiltersSchema, passpilotReportPageSchema, passpilotReportExportSchema } from "../../services/passpilotReportsValidation.js";
import { isDatabaseErrorCode } from "../../util/databaseError.js";

const router = Router();
router.use((_req, _res, next) => readPasspilotReportsMode() === "v2" ? next() : next("router"));
router.use(authenticate, requireSchoolContext, requireActiveSchool, requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"), requirePasspilotClassModel);
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
const actor = (req: Request) => ({ id: req.authUser!.id, authVersion: req.authUser!.authVersion });
const invalid = { error: "Choose valid report filters and a bounded offset-bearing date range.", code: "PASSPILOT_REPORT_FILTER_INVALID" };

router.get("/capabilities", async (req, res, next) => {
  try { res.json(await getPasspilotReportCapabilities(res.locals.schoolId!, actor(req))); }
  catch (error) { next(error); }
});
router.get("/summary", async (req, res, next) => {
  try {
    const parsed = passpilotReportFiltersSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(invalid);
    return res.json(await getPasspilotReportSummary(res.locals.schoolId!, actor(req), parsed.data));
  } catch (error) { next(error); }
});
router.get("/passes", async (req, res, next) => {
  try {
    const parsed = passpilotReportPageSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(invalid);
    const { limit, cursor, ...filters } = parsed.data;
    return res.json(await getPasspilotReportPage(res.locals.schoolId!, actor(req), filters, limit, cursor));
  } catch (error) { next(error); }
});
router.get("/export.csv", async (req, res, next) => {
  try {
    const parsed = passpilotReportExportSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(invalid);
    const { kind, ...filters } = parsed.data;
    const result = await exportPasspilotReport(res.locals.schoolId!, actor(req), filters, kind);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    return res.send(result.csv);
  } catch (error) { next(error); }
});
router.use((error: unknown, _req: Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (isDatabaseErrorCode(error, "40001")) return res.status(409).json({
    error: "Report access or data changed. Refresh before continuing.", code: "PASSPILOT_REPORT_SNAPSHOT_CHANGED",
  });
  return next(error);
});
export default router;
