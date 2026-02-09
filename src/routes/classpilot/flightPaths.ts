import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getFlightPathsBySchool,
  getFlightPathsByTeacher,
  getFlightPathById,
  createFlightPath,
  updateFlightPath,
  deleteFlightPath,
  getBlockListsBySchool,
  getBlockListsByTeacher,
  getBlockListById,
  createBlockList,
  updateBlockList,
  deleteBlockList,
} from "../../services/storage.js";
import {
  sendToDeviceLocal,
  broadcastToStudentsLocal,
} from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";

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

// ============================================================================
// Flight Paths
// ============================================================================

// GET /api/classpilot/flight-paths
router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const user = req.authUser!;

    // School-wide + teacher's own
    const schoolPaths = await getFlightPathsBySchool(schoolId);
    const teacherPaths = await getFlightPathsByTeacher(user.id);

    // Deduplicate (teacher paths are already included in school paths)
    const seen = new Set<string>();
    const all = [...schoolPaths, ...teacherPaths].filter((fp) => {
      if (seen.has(fp.id)) return false;
      seen.add(fp.id);
      return true;
    });

    return res.json({ flightPaths: all });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/flight-paths/:id
router.get("/:id", ...auth, async (req, res, next) => {
  try {
    const fp = await getFlightPathById(param(req, "id"));
    if (!fp) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    return res.json({ flightPath: fp });
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

    const updated = await updateFlightPath(id, data);
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
    const existing = await getFlightPathById(param(req, "id"));
    if (!existing) {
      return res.status(404).json({ error: "Flight path not found" });
    }
    await deleteFlightPath(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Block Lists
// ============================================================================

// GET /api/classpilot/block-lists
router.get("/block-lists", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const schoolLists = await getBlockListsBySchool(schoolId);
    const teacherLists = await getBlockListsByTeacher(req.authUser!.id);

    const seen = new Set<string>();
    const all = [...schoolLists, ...teacherLists].filter((bl) => {
      if (seen.has(bl.id)) return false;
      seen.add(bl.id);
      return true;
    });

    return res.json({ blockLists: all });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/block-lists/:id
router.get("/block-lists/:id", ...auth, async (req, res, next) => {
  try {
    const bl = await getBlockListById(param(req, "id"));
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

    const updated = await updateBlockList(id, data);
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
    const existing = await getBlockListById(param(req, "id"));
    if (!existing) {
      return res.status(404).json({ error: "Block list not found" });
    }
    await deleteBlockList(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/:id/apply - Apply block list to devices
router.post("/block-lists/:id/apply", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const bl = await getBlockListById(param(req, "id"));
    if (!bl) {
      return res.status(404).json({ error: "Block list not found" });
    }

    const { deviceIds } = req.body;
    const message = {
      type: "remote-control",
      command: "apply-block-list",
      blockListId: bl.id,
      blockedDomains: bl.blockedDomains,
    };

    if (Array.isArray(deviceIds) && deviceIds.length > 0) {
      for (const deviceId of deviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: deviceIds }, message);
    } else {
      broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/remove - Remove block list from devices
router.post("/block-lists/remove", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds } = req.body;
    const message = { type: "remote-control", command: "remove-block-list" };

    if (Array.isArray(deviceIds) && deviceIds.length > 0) {
      for (const deviceId of deviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: deviceIds }, message);
    } else {
      broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
