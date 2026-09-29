import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { isSharedTeachingResourcesEnabled } from "../../config/sharedTeachingResources.js";
import { logAudit } from "../../services/audit.js";
import {
  canViewSharedResource,
  libraryBlockListView,
  libraryFlightPathView,
  ownedTeachingResourceView,
  withoutTeachingResourcePublication,
  type TeachingResourceActor,
} from "../../services/teachingResourceLibrary.js";
import {
  getFlightPathsByTeacherAndSchool,
  getFlightPathById,
  createFlightPath,
  updateFlightPath,
  deleteFlightPath,
  getBlockListsByTeacherAndSchool,
  getBlockListById,
  createBlockList,
  updateBlockList,
  deleteBlockList,
  getLibraryFlightPathsForSchool,
  getLibraryBlockListsForSchool,
  getTeachingResourceOwnerName,
  setFlightPathVisibility,
  setFlightPathOfficial,
  copyFlightPathToTeacher,
  setBlockListVisibility,
  setBlockListOfficial,
  copyBlockListToTeacher,
} from "../../services/storage.js";
import type { BlockList, FlightPath } from "../../schema/classpilot.js";

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

function isSchoolAdmin(req: any, res: any): boolean {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"]);
}

function canManageOwnedResource(req: any, res: any, teacherId: string | null): boolean {
  return isSchoolAdmin(req, res)
    || teacherId === req.authUser?.id;
}

// ============================================================================
// School Library (shared and official items). The school comes from the
// verified request context, never from the request body.
// ============================================================================

function schoolLibraryEnabled(res: any): boolean {
  return isSharedTeachingResourcesEnabled(res.locals.schoolId);
}

function resourceActor(req: any, res: any): TeachingResourceActor {
  return {
    actorId: req.authUser!.id,
    isAdmin: isSchoolAdmin(req, res),
    userEmail: req.authUser?.email ?? null,
    userRole: res.locals.membershipRole ?? null,
  };
}

function auditActor(req: any, res: any) {
  return {
    schoolId: res.locals.schoolId!,
    userId: req.authUser?.id ?? null,
    userEmail: req.authUser?.email ?? undefined,
    userRole: res.locals.membershipRole,
  };
}

/**
 * The owner's or an administrator's view of an item. With the School Library
 * off for the school, the response keeps exactly its previous shape.
 */
function managedFlightPathView(req: any, res: any, row: FlightPath) {
  return schoolLibraryEnabled(res)
    ? ownedTeachingResourceView(row, resourceActor(req, res))
    : withoutTeachingResourcePublication(row);
}

function managedBlockListView(req: any, res: any, row: BlockList) {
  return schoolLibraryEnabled(res)
    ? ownedTeachingResourceView(row, resourceActor(req, res))
    : withoutTeachingResourcePublication(row);
}

function routeError(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function requireSchoolLibrary(res: any): void {
  if (!schoolLibraryEnabled(res)) {
    throw routeError(
      "The School Library is not enabled for this school",
      409,
      "SHARED_TEACHING_RESOURCES_DISABLED"
    );
  }
}

const visibilityBody = z.object({ visibility: z.enum(["private", "school"]) }).strict();
const officialBody = z.object({ official: z.boolean() }).strict();
const copyBody = z.object({}).strict();

function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, body: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw routeError("Invalid request body", 400, "INVALID_REQUEST");
  return parsed.data;
}

/**
 * Copies are owned by the caller, so the caller must be active teaching staff
 * here (createFlightPath/createBlockList enforce it). Office staff and
 * super admins without a teaching membership get 403, not a server error.
 */
function copyError(err: unknown): unknown {
  if (err && typeof err === "object" && (err as { code?: unknown }).code === "CLASS_TEACHER_NOT_FOUND") {
    return routeError(
      "Only teaching staff can copy items into their own Teaching tools",
      403,
      "CLASS_TEACHER_NOT_FOUND"
    );
  }
  return err;
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
    const schoolId = res.locals.schoolId!;
    const teacherLists = await getBlockListsByTeacherAndSchool(req.authUser!.id, schoolId);
    if (!schoolLibraryEnabled(res)) {
      return res.json({ blockLists: teacherLists.map((row) => withoutTeachingResourcePublication(row)) });
    }
    const actor = resourceActor(req, res);
    const library = await getLibraryBlockListsForSchool(schoolId, actor.actorId);
    return res.json({
      blockLists: teacherLists.map((row) => ownedTeachingResourceView(row, actor)),
      library: library.map(({ blockList, ownerName }) => libraryBlockListView(blockList, ownerName, actor)),
      features: { sharedTeachingResources: true },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/block-lists/:id
router.get("/block-lists/:id", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const bl = await getBlockListById(param(req, "id"), schoolId);
    if (!bl) {
      return res.status(404).json({ error: "Block list not found" });
    }
    if (canManageOwnedResource(req, res, bl.teacherId)) {
      return res.json({ blockList: managedBlockListView(req, res, bl) });
    }
    if (schoolLibraryEnabled(res) && canViewSharedResource(bl, req.authUser!.id)) {
      const ownerName = await getTeachingResourceOwnerName(schoolId, bl.teacherId);
      return res.json({ blockList: libraryBlockListView(bl, ownerName, resourceActor(req, res)) });
    }
    return res.status(404).json({ error: "Block list not found" });
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

    return res.status(201).json({ blockList: managedBlockListView(req, res, bl) });
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

    // Official items are administrator-only and shared or non-owner edits are
    // audited; storage re-checks both on the locked row.
    const updated = await updateBlockList(id, res.locals.schoolId!, data, resourceActor(req, res));
    if (!updated) {
      return res.status(404).json({ error: "Block list not found" });
    }
    return res.json({ blockList: managedBlockListView(req, res, updated) });
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
    await deleteBlockList(param(req, "id"), res.locals.schoolId!, resourceActor(req, res));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/:id/visibility - owner shares or unshares
router.post("/block-lists/:id/visibility", ...auth, async (req, res, next) => {
  try {
    requireSchoolLibrary(res);
    const { visibility } = parseBody(visibilityBody, req.body);
    const actor = resourceActor(req, res);
    const updated = await setBlockListVisibility(param(req, "id"), res.locals.schoolId!, { visibility, actor });
    return res.json({ blockList: ownedTeachingResourceView(updated, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/:id/official - administrators only
router.post("/block-lists/:id/official", ...adminAuth, async (req, res, next) => {
  try {
    requireSchoolLibrary(res);
    const { official } = parseBody(officialBody, req.body);
    const actor = resourceActor(req, res);
    const updated = await setBlockListOfficial(param(req, "id"), res.locals.schoolId!, { official, actor });
    return res.json({ blockList: ownedTeachingResourceView(updated, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/:id/copy - copy into the caller's own Block Lists
router.post("/block-lists/:id/copy", ...auth, async (req, res, next) => {
  try {
    requireSchoolLibrary(res);
    parseBody(copyBody, req.body);
    const actor = resourceActor(req, res);
    const copied = await copyBlockListToTeacher(param(req, "id"), res.locals.schoolId!, actor)
      .catch((err: unknown) => { throw copyError(err); });
    if (!copied) {
      return res.status(404).json({ error: "Block list not found" });
    }
    await logAudit({
      ...auditActor(req, res),
      action: "classpilot.block_list.copied",
      entityType: "block_list",
      entityId: copied.copy.id,
      entityName: copied.copy.name,
      metadata: { sourceId: copied.source.id, sourceOfficial: copied.source.official },
    });
    return res.status(201).json({ blockList: ownedTeachingResourceView(copied.copy, actor) });
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
    const schoolId = res.locals.schoolId!;
    const teacherPaths = await getFlightPathsByTeacherAndSchool(req.authUser!.id, schoolId);
    if (!schoolLibraryEnabled(res)) {
      return res.json({ flightPaths: teacherPaths.map((row) => withoutTeachingResourcePublication(row)) });
    }
    const actor = resourceActor(req, res);
    const library = await getLibraryFlightPathsForSchool(schoolId, actor.actorId);
    return res.json({
      flightPaths: teacherPaths.map((row) => ownedTeachingResourceView(row, actor)),
      library: library.map(({ flightPath, ownerName }) => libraryFlightPathView(flightPath, ownerName, actor)),
      features: { sharedTeachingResources: true },
    });
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

    return res.status(201).json({ flightPath: managedFlightPathView(req, res, fp) });
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
      flightPath: managedFlightPathView(req, res, fp),
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
    const schoolId = res.locals.schoolId!;
    const fp = await getFlightPathById(param(req, "id"), schoolId);
    if (!fp) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    if (canManageOwnedResource(req, res, fp.teacherId)) {
      return res.json({ flightPath: managedFlightPathView(req, res, fp) });
    }
    // A library viewer sees the library projection: no Classroom provenance,
    // and the owner's name only while the owner is a member of this school.
    if (schoolLibraryEnabled(res) && canViewSharedResource(fp, req.authUser!.id)) {
      const ownerName = await getTeachingResourceOwnerName(schoolId, fp.teacherId);
      return res.json({ flightPath: libraryFlightPathView(fp, ownerName, resourceActor(req, res)) });
    }
    return res.status(404).json({ error: "Flight path not found" });
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

    // Official items are administrator-only and shared or non-owner edits are
    // audited; storage re-checks both on the locked row.
    const updated = await updateFlightPath(id, res.locals.schoolId!, data, resourceActor(req, res));
    if (!updated) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    return res.json({ flightPath: managedFlightPathView(req, res, updated) });
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
    await deleteFlightPath(param(req, "id"), res.locals.schoolId!, resourceActor(req, res));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/flight-paths/:id/visibility - owner shares or unshares
router.post("/:id/visibility", ...auth, async (req, res, next) => {
  try {
    requireSchoolLibrary(res);
    const { visibility } = parseBody(visibilityBody, req.body);
    const actor = resourceActor(req, res);
    const updated = await setFlightPathVisibility(param(req, "id"), res.locals.schoolId!, { visibility, actor });
    return res.json({ flightPath: ownedTeachingResourceView(updated, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/flight-paths/:id/official - administrators only
router.post("/:id/official", ...adminAuth, async (req, res, next) => {
  try {
    requireSchoolLibrary(res);
    const { official } = parseBody(officialBody, req.body);
    const actor = resourceActor(req, res);
    const updated = await setFlightPathOfficial(param(req, "id"), res.locals.schoolId!, { official, actor });
    return res.json({ flightPath: ownedTeachingResourceView(updated, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/flight-paths/:id/copy - copy into the caller's own Flight Paths
router.post("/:id/copy", ...auth, async (req, res, next) => {
  try {
    requireSchoolLibrary(res);
    parseBody(copyBody, req.body);
    const actor = resourceActor(req, res);
    const copied = await copyFlightPathToTeacher(param(req, "id"), res.locals.schoolId!, actor)
      .catch((err: unknown) => { throw copyError(err); });
    if (!copied) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    await logAudit({
      ...auditActor(req, res),
      action: "classpilot.flight_path.copied",
      entityType: "flight_path",
      entityId: copied.copy.id,
      entityName: copied.copy.flightPathName,
      metadata: { sourceId: copied.source.id, sourceOfficial: copied.source.official },
    });
    return res.status(201).json({ flightPath: ownedTeachingResourceView(copied.copy, actor) });
  } catch (err) {
    next(err);
  }
});

export default router;
