import crypto from "crypto";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
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
import {
  sendToDeviceLocal,
} from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";
import { scopedDeviceTargets } from "../../services/classpilotDeviceScope.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

function allowedEntryFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
      const videoId = url.hostname === "youtu.be"
        ? url.pathname.replace(/^\//, "")
        : url.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return host;
  } catch {
    const trimmed = String(rawUrl || "").trim();
    return trimmed || null;
  }
}

function extractAllowedEntries(resources: any[], fallbackLinks: string[] = []): string[] {
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
      blockedDomains: blockedDomains || [],
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
    const { name, description, blockedDomains, isDefault } = req.body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (blockedDomains !== undefined) data.blockedDomains = blockedDomains;
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
    await deleteBlockList(param(req, "id"), res.locals.schoolId!);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/:id/apply - Apply block list to devices
router.post("/block-lists/:id/apply", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const bl = await getBlockListById(param(req, "id"), schoolId);
    if (!bl) {
      return res.status(404).json({ error: "Block list not found" });
    }

    const { deviceIds, targetDeviceIds } = req.body;
    let resolvedDeviceIds = deviceIds || targetDeviceIds;
    if (!Array.isArray(resolvedDeviceIds) || resolvedDeviceIds.length === 0) {
      return res.status(400).json({
        error: "Explicit targetDeviceIds are required. Use /classpilot/commands for class-scoped teacher commands.",
      });
    }
    const message = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "apply-block-list", data: { blockListId: bl.id, blockListName: bl.name, blockedDomains: bl.blockedDomains } },
    };

    let sentTo = 0;
    let rejectedDeviceCount = 0;
    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      const scoped = await scopedDeviceTargets(resolvedDeviceIds, schoolId);
      if (scoped.deviceIds.length === 0) {
        return res.status(404).json({ error: "No accessible devices", rejectedDeviceCount: scoped.rejectedDeviceCount });
      }
      resolvedDeviceIds = scoped.deviceIds;
      rejectedDeviceCount = scoped.rejectedDeviceCount;
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        sentTo++;
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
    } else {
      return res.status(400).json({ error: "No target devices resolved" });
    }

    return res.json({ success: true, sentTo, rejectedDeviceCount, message: `Applied "${bl.name}" to ${sentTo} device(s)` });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/remove - Remove block list from devices
router.post("/block-lists/remove", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds, targetDeviceIds } = req.body;
    let resolvedDeviceIds = deviceIds || targetDeviceIds;
    if (!Array.isArray(resolvedDeviceIds) || resolvedDeviceIds.length === 0) {
      return res.status(400).json({
        error: "Explicit targetDeviceIds are required. Use /classpilot/commands for class-scoped teacher commands.",
      });
    }
    const message = { type: "remote-control", _msgId: crypto.randomUUID(), command: { type: "remove-block-list", data: {} } };

    let sentTo = 0;
    let rejectedDeviceCount = 0;
    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      const scoped = await scopedDeviceTargets(resolvedDeviceIds, schoolId);
      if (scoped.deviceIds.length === 0) {
        return res.status(404).json({ error: "No accessible devices", rejectedDeviceCount: scoped.rejectedDeviceCount });
      }
      resolvedDeviceIds = scoped.deviceIds;
      rejectedDeviceCount = scoped.rejectedDeviceCount;
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        sentTo++;
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
    } else {
      return res.status(400).json({ error: "No target devices resolved" });
    }

    return res.json({ ok: true, sentTo, rejectedDeviceCount });
  } catch (err) {
    next(err);
  }
});

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
      allowedDomains: allowedDomains || [],
      blockedDomains: blockedDomains || [],
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

    const fp = await createFlightPath({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      flightPathName: flightPathName || name || "Classroom Flight Path",
      description: description || null,
      allowedDomains,
      blockedDomains: Array.isArray(blockedDomains) ? blockedDomains : [],
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
        resourceCount: selectedResources.length,
        youtubeExactUrls: allowedDomains.filter((entry) => entry.startsWith("https://www.youtube.com/watch")),
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
    return res.json({ flightPath: fp });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/flight-paths/:id
router.patch("/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { flightPathName, description, allowedDomains, blockedDomains, isDefault } = req.body;

    const data: Record<string, unknown> = {};
    if (flightPathName !== undefined) data.flightPathName = flightPathName;
    if (description !== undefined) data.description = description;
    if (allowedDomains !== undefined) data.allowedDomains = allowedDomains;
    if (blockedDomains !== undefined) data.blockedDomains = blockedDomains;
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
    await deleteFlightPath(param(req, "id"), res.locals.schoolId!);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
