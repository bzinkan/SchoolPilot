import { Router } from "express";
import authRoutes from "./auth.js";
import schoolRoutes from "./schools.js";
import studentRoutes from "./students.js";
import userRoutes from "./users.js";
import passRoutes from "./passpilot/passes.js";
import kioskRoutes from "./passpilot/kiosk.js";
import homeroomRoutes from "./gopilot/homerooms.js";
import dismissalRoutes from "./gopilot/dismissal.js";
import changeRoutes from "./gopilot/changes.js";
import pickupRoutes from "./gopilot/pickups.js";
import busRouteRoutes from "./gopilot/busRoutes.js";
import familyRoutes from "./gopilot/families.js";
import deviceRoutes from "./classpilot/devices.js";
import monitoringRoutes from "./classpilot/monitoring.js";
import teachingSessionRoutes from "./classpilot/sessions.js";
import groupRoutes from "./classpilot/groups.js";
import flightPathRoutes from "./classpilot/flightPaths.js";
import chatRoutes from "./classpilot/chat.js";
import dashboardRoutes from "./classpilot/dashboard.js";
import superAdminRoutes from "./admin/superAdmin.js";
import trialRequestRoutes from "./admin/trialRequests.js";
import billingRoutes from "./admin/billing.js";
import googleOAuthRoutes from "./google/oauth.js";
import googleClassroomRoutes from "./google/classroom.js";
import googleDirectoryRoutes from "./google/directory.js";

const router = Router();

// Auth routes (login, register, /me, logout)
router.use("/auth", authRoutes);

// School management (CRUD, settings, licenses, grades)
router.use("/schools", schoolRoutes);

// Student management (CRUD, bulk, CSV import)
router.use("/students", studentRoutes);

// User/staff management (profile, staff CRUD, memberships)
router.use("/users", userRoutes);

// PassPilot - Hall passes
router.use("/passpilot/passes", passRoutes);
router.use("/passpilot/kiosk", kioskRoutes);

// Legacy PassPilot aliases
router.use("/passes", passRoutes);
router.use("/kiosk", kioskRoutes);

// GoPilot - Dismissal management
router.use("/gopilot/homerooms", homeroomRoutes);
router.use("/gopilot/dismissal", dismissalRoutes);
router.use("/gopilot", changeRoutes);
router.use("/gopilot/pickups", pickupRoutes);
router.use("/gopilot/bus-routes", busRouteRoutes);
router.use("/gopilot", familyRoutes);

// Legacy GoPilot aliases
router.use("/homerooms", homeroomRoutes);
router.use("/sessions", dismissalRoutes);
router.use("/dismissal", dismissalRoutes);

// ClassPilot - Classroom monitoring & management
router.use("/classpilot", deviceRoutes);
router.use("/classpilot", monitoringRoutes);
router.use("/classpilot/teaching-sessions", teachingSessionRoutes);
router.use("/classpilot/groups", groupRoutes);
router.use("/classpilot/flight-paths", flightPathRoutes);
router.use("/classpilot", chatRoutes);
router.use("/classpilot/teacher", dashboardRoutes);

// Admin - Super admin panel
router.use("/admin", superAdminRoutes);
router.use("/admin/trial-requests", trialRequestRoutes);
router.use("/admin/billing", billingRoutes);

// Google integrations
router.use("/google", googleOAuthRoutes);
router.use("/google/classroom", googleClassroomRoutes);
router.use("/google/directory", googleDirectoryRoutes);

export default router;
