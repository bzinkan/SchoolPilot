import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import {
  getBusRoutesBySchool,
  createBusRoute,
  updateBusRoute,
  getWalkerZonesBySchool,
  createWalkerZone,
  searchStudents,
} from "../../services/storage.js";
import {
  getBusRouteForSchool,
  requireGoPilotRole,
} from "../../services/gopilotAccess.js";
import { logAudit } from "../../services/audit.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;

const manageAuth = [
  ...auth,
  requireGoPilotRole("admin", "school_admin", "office_staff"),
] as const;

// ============================================================================
// Bus Routes
// ============================================================================

// GET /api/gopilot/bus-routes
router.get("/", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const routes = await getBusRoutesBySchool(schoolId);

    // Count students per route
    const allStudents = await searchStudents(schoolId, { status: "active" });
    const busStudents = allStudents.filter(
      (s) => s.dismissalType === "bus" && s.busRoute
    );
    const countMap = new Map<string, number>();
    for (const s of busStudents) {
      countMap.set(s.busRoute!, (countMap.get(s.busRoute!) ?? 0) + 1);
    }

    const enriched = routes.map((r) => ({
      ...r,
      studentCount: countMap.get(r.routeNumber) ?? 0,
    }));

    return res.json({ routes: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/bus-routes
router.post("/", ...manageAuth, async (req, res, next) => {
  try {
    const { routeNumber, departureTime } = req.body;
    if (!routeNumber) {
      return res.status(400).json({ error: "routeNumber is required" });
    }

    const route = await createBusRoute({
      schoolId: res.locals.schoolId!,
      routeNumber,
      departureTime: departureTime || null,
    });

    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.bus_route.created",
      entityType: "bus_route",
      entityId: route.id,
      changes: { fields: ["routeNumber", ...(departureTime ? ["departureTime"] : [])] },
    });

    return res.status(201).json({ route });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/bus-routes/:id
router.put("/:id", ...manageAuth, async (req, res, next) => {
  try {
    const route = await getBusRouteForSchool(param(req, "id"), res.locals.schoolId!);
    if (!route) {
      return res.status(404).json({ error: "Bus route not found" });
    }

    const { status, departureTime } = req.body;
    const updated = await updateBusRoute(param(req, "id"), {
      ...(status !== undefined && { status }),
      ...(departureTime !== undefined && { departureTime }),
    });

    if (!updated) {
      return res.status(404).json({ error: "Bus route not found" });
    }
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.bus_route.updated",
      entityType: "bus_route",
      entityId: updated.id,
      changes: {
        fields: [
          ...(status !== undefined ? ["status"] : []),
          ...(departureTime !== undefined ? ["departureTime"] : []),
        ],
      },
    });
    return res.json({ route: updated });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Walker Zones
// ============================================================================

// GET /api/gopilot/bus-routes/walker-zones
router.get("/walker-zones", ...auth, async (req, res, next) => {
  try {
    const zones = await getWalkerZonesBySchool(res.locals.schoolId!);
    return res.json({ zones });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/bus-routes/walker-zones
router.post("/walker-zones", ...manageAuth, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const zone = await createWalkerZone({
      schoolId: res.locals.schoolId!,
      name,
    });
    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.walker_zone.created",
      entityType: "walker_zone",
      entityId: zone.id,
      changes: { fields: ["name"] },
    });

    return res.status(201).json({ zone });
  } catch (err) {
    next(err);
  }
});

export default router;
