import crypto from "crypto";
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
// Block Lists (MUST come before /:id routes to avoid route conflicts)
// ============================================================================

// GET /api/classpilot/block-lists
router.get("/block-lists", ...auth, async (req, res, next) => {
  try {
    const teacherLists = await getBlockListsByTeacher(req.authUser!.id);
    return res.json({ blockLists: teacherLists });
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

    const { deviceIds, targetDeviceIds } = req.body;
    const resolvedDeviceIds = deviceIds || targetDeviceIds;
    const message = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "apply-block-list", data: { blockListId: bl.id, blockListName: bl.name, blockedDomains: bl.blockedDomains } },
    };

    let sentTo = 0;
    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        sentTo++;
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
    } else {
      sentTo = broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
    }

    return res.json({ success: true, sentTo, message: `Applied "${bl.name}" to ${sentTo} device(s)` });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/block-lists/remove - Remove block list from devices
router.post("/block-lists/remove", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds, targetDeviceIds } = req.body;
    const resolvedDeviceIds = deviceIds || targetDeviceIds;
    const message = { type: "remote-control", _msgId: crypto.randomUUID(), command: { type: "remove-block-list", data: {} } };

    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
    } else {
      broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
    }

    return res.json({ ok: true });
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
    const teacherPaths = await getFlightPathsByTeacher(req.authUser!.id);
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

export default router;
