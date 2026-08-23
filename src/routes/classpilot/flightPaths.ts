import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  getFlightPathsBySchool,
  getFlightPathsByTeacherAndSchool,
  getFlightPathById,
  createFlightPath,
  updateFlightPath,
  deleteFlightPath,
  getBlockListsBySchool,
  getBlockListsByTeacherAndSchool,
  getBlockListById,
  createBlockList,
  updateBlockList,
  deleteBlockList,
} from "../../services/storage.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

const adminAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin"),
] as const;

function canManageOwnedResource(req: any, res: any, teacherId: string | null): boolean {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"])
    || teacherId === req.authUser?.id;
}

/**
 * The currently deployed extension enforces Flight Path allow entries at the
 * hostname level. Keep Classroom imports on that same contract: returning an
 * apparent per-video URL here would silently widen it to all of YouTube when
 * the extension normalizes the rule.
 */
export function allowedEntryFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    // Classroom resources are URLs. Do not pass arbitrary path-like strings
    // through as domain rules and accidentally promise a narrower policy than
    // the extension can enforce.
    return null;
  }
}

export function extractAllowedEntries(resources: any[], fallbackLinks: string[] = []): string[] {
  const entries = new Set<string>();
  for (const url of fallbackLinks) {
    const entry = allowedEntryFromUrl(url);
    if (entry) entries.add(entry);
  }
  for (const resource of resources) {
    for (const link of resource?.links || []) {
      const entry = allowedEntryFromUrl(link?.url || "");
      if (entry) entries.add(entry);
    }
  }
  return [...entries].sort();
}

function validateRuleList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an array`), { status: 400 });
  }
  const normalized = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  if (normalized.length > 1_000) {
    throw Object.assign(new Error(`${label} cannot contain more than 1,000 entries`), {
      status: 400,
      code: "CLASSROOM_RULE_LIMIT_EXCEEDED",
    });
  }
  return normalized;
}

// ============================================================================
// Block Lists (MUST come before /:id routes to avoid route conflicts)
// ============================================================================

// GET /api/classpilot/block-lists
router.get("/block-lists", ...auth, async (req, res, next) => {
  try {
    const teacherLists = await getBlockListsByTeacherAndSchool(req.authUser!.id, res.locals.schoolId!);
    return res.json({ blockLists: teacherLists });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/block-lists/:id
router.get("/block-lists/:id", ...auth, async (req, res, next) => {
  try {
    const bl = await getBlockListById(param(req, "id"), res.locals.schoolId!);
    if (!bl) {
      return res.status(404).json({ error: "Block list not found" });
    }
    if (!canManageOwnedResource(req, res, bl.teacherId)) {
      return res.status(404).json({ error: "Block list not found" });
    }
    return res.json({ blockList: bl });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists
router.post("/block-lists", ...auth, async (req, res, next) => {
  try {
    const { name, description, blockedDomains, isDefault } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const bl = await createBlockList({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      name,
      description: description || null,
      blockedDomains: validateRuleList(blockedDomains, "Block List"),
      isDefault: isDefault || false,
    });

    return res.status(201).json({ blockList: bl });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/block-lists/:id
router.patch("/block-lists/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const existing = await getBlockListById(id, res.locals.schoolId!);
    if (!existing || !canManageOwnedResource(req, res, existing.teacherId)) {
      return res.status(404).json({ error: "Block list not found" });
    }
    const { name, description, blockedDomains, isDefault } = req.body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (blockedDomains !== undefined) data.blockedDomains = validateRuleList(blockedDomains, "Block List");
    if (isDefault !== undefined) data.isDefault = isDefault;

    const updated = await updateBlockList(id, res.locals.schoolId!, data);
    if (!updated) {
      return res.status(404).json({ error: "Block list not found" });
    }
    return res.json({ blockList: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/block-lists/:id
router.delete("/block-lists/:id", ...auth, async (req, res, next) => {
  try {
    const existing = await getBlockListById(param(req, "id"), res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Block list not found" });
    }
    if (!canManageOwnedResource(req, res, existing.teacherId)) {
      return res.status(404).json({ error: "Block list not found" });
    }
    await deleteBlockList(param(req, "id"), res.locals.schoolId!);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/:id/apply - Apply block list to devices
const retiredBlockListDeviceTargeting = (_req: any, res: any) => res.status(410).json({
  error: "Direct device-ID block-list endpoints are retired",
  code: "LEGACY_DEVICE_TARGETING_RETIRED",
  replacement: "/api/classpilot/commands",
});
router.post("/block-lists/:id/apply", ...adminAuth, retiredBlockListDeviceTargeting);
router.post("/block-lists/remove", ...adminAuth, retiredBlockListDeviceTargeting);

// ============================================================================
// Flight Paths
// ============================================================================

// GET /api/classpilot/flight-paths
router.get("/", ...auth, async (req, res, next) => {
  try {
    const teacherPaths = await getFlightPathsByTeacherAndSchool(req.authUser!.id, res.locals.schoolId!);
    return res.json({ flightPaths: teacherPaths });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/flight-paths
router.post("/", ...auth, async (req, res, next) => {
  try {
    const { flightPathName, description, allowedDomains, blockedDomains, isDefault } = req.body;
    if (!flightPathName) {
      return res.status(400).json({ error: "flightPathName is required" });
    }

    const fp = await createFlightPath({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      flightPathName,
      description: description || null,
      allowedDomains: validateRuleList(allowedDomains, "Flight Path"),
      blockedDomains: validateRuleList(blockedDomains, "Flight Path block list"),
      isDefault: isDefault || false,
    });

    return res.status(201).json({ flightPath: fp });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/flight-paths/from-classroom
router.post("/from-classroom", ...auth, async (req, res, next) => {
  try {
    const {
      courseId,
      selectedResourceIds = [],
      resources = [],
      resourceLinks = [],
      name,
      flightPathName,
      description,
      blockedDomains,
      isDefault,
    } = req.body;
    if (!courseId) return res.status(400).json({ error: "courseId is required" });

    const selectedIds = Array.isArray(selectedResourceIds) ? selectedResourceIds.map(String) : [];
    const providedResources = Array.isArray(resources) ? resources : [];
    const selectedResources = selectedIds.length > 0
      ? providedResources.filter((resource: any) => selectedIds.includes(String(resource?.id)))
      : providedResources;
    if (selectedIds.length > 0 && selectedResources.length === 0) {
      return res.status(400).json({ error: "selected resources were not included in the request" });
    }

    const allowedDomains = extractAllowedEntries(
      selectedResources,
      Array.isArray(resourceLinks) ? resourceLinks : []
    );
    if (allowedDomains.length === 0) {
      return res.status(400).json({ error: "No usable Classroom resource URLs were found" });
    }
    validateRuleList(allowedDomains, "Flight Path");

    const fp = await createFlightPath({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      flightPathName: flightPathName || name || "Classroom Flight Path",
      description: description || null,
      allowedDomains,
      blockedDomains: validateRuleList(blockedDomains, "Flight Path block list"),
      isDefault: !!isDefault,
      sourceType: "google_classroom",
      sourceCourseId: String(courseId),
      sourceResourceIds: selectedIds.length > 0
        ? selectedIds
        : selectedResources.map((resource: any) => String(resource?.id)).filter(Boolean),
      sourceUpdatedAt: new Date(),
    });

    return res.status(201).json({
      flightPath: fp,
      extracted: {
        allowedDomains,
        domainLevelEntries: allowedDomains,
        resourceCount: selectedResources.length,
        enforcementLevel: "hostname",
        warning: "Classroom resource links are enforced at the website hostname level, not as individual pages or videos.",
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/flight-paths/:id
router.get("/:id", ...auth, async (req, res, next) => {
  try {
    const fp = await getFlightPathById(param(req, "id"), res.locals.schoolId!);
    if (!fp) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    if (!canManageOwnedResource(req, res, fp.teacherId)) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    return res.json({ flightPath: fp });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/flight-paths/:id
router.patch("/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const existing = await getFlightPathById(id, res.locals.schoolId!);
    if (!existing || !canManageOwnedResource(req, res, existing.teacherId)) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    const { flightPathName, description, allowedDomains, blockedDomains, isDefault } = req.body;

    const data: Record<string, unknown> = {};
    if (flightPathName !== undefined) data.flightPathName = flightPathName;
    if (description !== undefined) data.description = description;
    if (allowedDomains !== undefined) data.allowedDomains = validateRuleList(allowedDomains, "Flight Path");
    if (blockedDomains !== undefined) data.blockedDomains = validateRuleList(blockedDomains, "Flight Path block list");
    if (isDefault !== undefined) data.isDefault = isDefault;

    const updated = await updateFlightPath(id, res.locals.schoolId!, data);
    if (!updated) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    return res.json({ flightPath: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/flight-paths/:id
router.delete("/:id", ...auth, async (req, res, next) => {
  try {
    const existing = await getFlightPathById(param(req, "id"), res.locals.schoolId!);
    if (!existing) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    if (!canManageOwnedResource(req, res, existing.teacherId)) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    await deleteFlightPath(param(req, "id"), res.locals.schoolId!);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
