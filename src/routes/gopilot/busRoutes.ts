import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getBusRoutesBySchool,
  createBusRoute,
  updateBusRoute,
  getWalkerZonesBySchool,
  createWalkerZone,
  searchStudents,
} from "../../services/storage.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
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
router.post("/", ...auth, async (req, res, next) => {
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

    return res.status(201).json({ route });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/bus-routes/:id
router.put("/:id", ...auth, async (req, res, next) => {
  try {
    const { status, departureTime } = req.body;
    const updated = await updateBusRoute(param(req, "id"), {
      ...(status !== undefined && { status }),
      ...(departureTime !== undefined && { departureTime }),
    });

    if (!updated) {
      return res.status(404).json({ error: "Bus route not found" });
    }
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
router.post("/walker-zones", ...auth, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const zone = await createWalkerZone({
      schoolId: res.locals.schoolId!,
      name,
    });

    return res.status(201).json({ zone });
  } catch (err) {
    next(err);
  }
});

export default router;
