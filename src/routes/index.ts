import { Router, type Request, type Response, type NextFunction } from "express";
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
import compatRoutes from "./compat.js";

const router = Router();

// ============================================================================
// URL Rewrite Middleware
// Runs before all route handlers to map frontend paths to canonical server paths.
// Each frontend app was built standalone and uses its own URL conventions.
// ============================================================================
router.use((req: Request, _res: Response, next: NextFunction) => {
  const p = req.path;
  const m = req.method;

  // --- Auth aliases (ClassPilot & PassPilot call without /auth prefix) ---
  if (p === "/login" && m === "POST") { req.url = "/auth" + req.url; return next(); }
  if (p === "/logout" && m === "POST") { req.url = "/auth" + req.url; return next(); }
  if (p === "/csrf" && m === "GET") { req.url = "/auth" + req.url; return next(); }
  if (p === "/me" && m === "GET") { req.url = "/auth" + req.url; return next(); }

  // PUT /me → /users/me (GoPilot profile update)
  if (p === "/me" && m === "PUT") { req.url = "/users" + req.url; return next(); }
  // /me/* → /users/me/* (GoPilot: /me/children, /me/join-school, /me/memberships)
  if (p.startsWith("/me/")) { req.url = "/users" + req.url; return next(); }

  // --- Super admin prefix (all frontends use /super-admin, server uses /admin) ---
  if (p === "/super-admin" || p.startsWith("/super-admin/")) {
    req.url = "/admin" + req.url.slice("/super-admin".length);
    return next();
  }

  // --- Google integration aliases ---
  // PassPilot & ClassPilot: /directory/* → /google/directory/*
  if (p === "/directory" || p.startsWith("/directory/")) {
    req.url = "/google/directory" + req.url.slice("/directory".length);
    return next();
  }
  // PassPilot & ClassPilot: /classroom/* → /google/classroom/*
  if (p === "/classroom" || p.startsWith("/classroom/")) {
    req.url = "/google/classroom" + req.url.slice("/classroom".length);
    return next();
  }
  // GoPilot: /google/courses → /google/classroom/courses
  if (p === "/google/courses" || p.startsWith("/google/courses/")) {
    req.url = "/google/classroom/courses" + req.url.slice("/google/courses".length);
    return next();
  }
  // GoPilot: /google/sync → /google/classroom/sync
  if (p === "/google/sync" && m === "POST") {
    req.url = "/google/classroom/sync";
    return next();
  }
  // GoPilot: /google/workspace/* → /google/directory/*
  if (p.startsWith("/google/workspace/")) {
    req.url = "/google/directory" + req.url.slice("/google/workspace".length);
    return next();
  }

  // --- Billing / Checkout ---
  // ClassPilot: /checkout/* → /admin/billing/checkout/*
  if (p === "/checkout" || p.startsWith("/checkout/")) {
    req.url = "/admin/billing/checkout" + req.url.slice("/checkout".length);
    return next();
  }

  // --- Trial requests ---
  // PassPilot: POST /trial-request (singular)
  if (p === "/trial-request" && m === "POST") {
    req.url = "/admin/trial-requests";
    return next();
  }
  // ClassPilot: /trial-requests → /admin/trial-requests
  if (p === "/trial-requests" || p.startsWith("/trial-requests/")) {
    req.url = "/admin/trial-requests" + req.url.slice("/trial-requests".length);
    return next();
  }

  // --- ClassPilot teaching sessions (must run before GoPilot /sessions) ---
  if (p === "/sessions/start" && m === "POST") {
    req.url = "/classpilot/teaching-sessions/start";
    return next();
  }
  if (p === "/sessions/end" && m === "POST") {
    req.url = "/classpilot/teaching-sessions/end";
    return next();
  }
  if (p === "/sessions/active" && m === "GET") {
    req.url = "/classpilot/teaching-sessions/active";
    return next();
  }
  if (p === "/sessions/all" && m === "GET") {
    req.url = "/classpilot/sessions/all";
    return next();
  }

  // --- GoPilot /dismissal/* → /gopilot/dismissal/* ---
  if (p.startsWith("/dismissal/")) {
    req.url = "/gopilot" + req.url;
    return next();
  }

  // --- GoPilot /sessions/sessions* → /gopilot/dismissal/sessions* (legacy doubled prefix) ---
  if (p.startsWith("/sessions/sessions")) {
    req.url = "/gopilot/dismissal" + req.url.slice("/sessions".length);
    return next();
  }
  // --- GoPilot /sessions/queue/* → /gopilot/dismissal/queue/* ---
  if (p.startsWith("/sessions/queue/")) {
    req.url = "/gopilot/dismissal" + req.url.slice("/sessions".length);
    return next();
  }

  // --- ClassPilot route aliases (frontends call without /classpilot prefix) ---
  if (p === "/devices" || p.startsWith("/devices/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/device/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/remote/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p === "/heartbeats" || p.startsWith("/heartbeats/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/extension/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p === "/register-student") { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/roster/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/student-analytics")) { req.url = "/classpilot" + req.url; return next(); }
  if (p === "/groups" || p.startsWith("/groups/")) {
    req.url = "/classpilot/groups" + req.url.slice("/groups".length);
    return next();
  }
  if (p.startsWith("/subgroups/")) {
    req.url = "/classpilot/groups" + req.url;
    return next();
  }
  if (p === "/flight-paths" || p.startsWith("/flight-paths/")) {
    req.url = "/classpilot/flight-paths" + req.url.slice("/flight-paths".length);
    return next();
  }
  if (p === "/block-lists" || p.startsWith("/block-lists/")) {
    req.url = "/classpilot/flight-paths/block-lists" + req.url.slice("/block-lists".length);
    return next();
  }
  if (p.startsWith("/chat/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/student/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/polls/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p.startsWith("/checkin/")) { req.url = "/classpilot" + req.url; return next(); }
  if (p === "/dashboard-tabs" || p.startsWith("/dashboard-tabs/")) {
    req.url = "/classpilot/teacher" + req.url;
    return next();
  }
  // /teacher/* → /classpilot/teacher/* (for chat and dashboard routes)
  if (p.startsWith("/teacher/")) { req.url = "/classpilot" + req.url; return next(); }
  // /settings → ClassPilot teacher settings
  if (p === "/settings" || p.startsWith("/settings/")) {
    req.url = "/classpilot/teacher" + req.url;
    return next();
  }

  // --- GoPilot school-scoped Google routes ---
  // /schools/:uuid/google/<sub> → set X-School-Id header and rewrite to correct Google route
  const googleSchoolMatch = p.match(
    /^\/schools\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/google\/(.+?)(\?.*)?$/i
  );
  if (googleSchoolMatch) {
    const schoolId = googleSchoolMatch[1]!;
    const sub = googleSchoolMatch[2]!;
    req.headers["x-school-id"] = schoolId;
    const googleMap: Record<string, string> = {
      "auth-url": "/google/auth-url",
      "status": "/google/status",
      "disconnect": "/google/disconnect",
      "courses": "/google/classroom/courses",
      "sync": "/google/classroom/sync",
      "org-units": "/google/directory/orgunits",
      "workspace-users": "/google/directory/users",
      "import-users": "/google/directory/import",
      "import-staff": "/google/directory/import-staff",
      "import-org-units": "/google/directory/import-orgunits",
    };
    const mapped = googleMap[sub];
    if (mapped) {
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      req.url = mapped + qs;
      return next();
    }
  }

  // --- GoPilot school-scoped routes ---
  // /schools/:uuid/<resource> → set X-School-Id header and rewrite to canonical path
  const schoolMatch = p.match(
    /^\/schools\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(homerooms|students|staff|family-groups|sessions|dismissal-mode|send-to-app-mode|switch-to-no-app-mode|members|settings|invite|custody-alerts|parent-requests|parents|bus-routes)(\/.*)?$/i
  );
  if (schoolMatch) {
    const schoolId = schoolMatch[1]!;
    const resource = schoolMatch[2]!;
    const rest = schoolMatch[3] ?? "";
    req.headers["x-school-id"] = schoolId;
    const map: Record<string, string> = {
      "homerooms": "/homerooms",
      "students": "/students",
      "staff": "/users/staff",
      "family-groups": "/gopilot/family-groups",
      "sessions": "/gopilot/dismissal/sessions",
      "dismissal-mode": "/gopilot/dismissal-mode",
      "send-to-app-mode": "/gopilot/send-to-app-mode",
      "switch-to-no-app-mode": "/gopilot/switch-to-no-app-mode",
      "members": "/users/members",
      "settings": "/compat/school-settings",
      "invite": "/compat/invite",
      "custody-alerts": "/gopilot/pickups/custody-alerts",
      "parent-requests": "/compat/parent-requests",
      "parents": "/compat/parents",
      "bus-routes": "/gopilot/bus-routes",
    };
    const newBase = map[resource];
    if (newBase) {
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      req.url = newBase + rest + qs;
      return next();
    }
  }

  // --- GoPilot root-level aliases ---
  // /pickups/:id → /gopilot/pickups/:id
  if (p.startsWith("/pickups/")) {
    req.url = "/gopilot/pickups" + req.url.slice("/pickups".length);
    return next();
  }
  // /changes/:id → /gopilot/changes/:id
  if (p.startsWith("/changes/")) {
    req.url = "/gopilot/changes" + req.url.slice("/changes".length);
    return next();
  }
  // /family-groups → /gopilot/family-groups
  if (p === "/family-groups" || p.startsWith("/family-groups/")) {
    req.url = "/gopilot" + req.url;
    return next();
  }
  // /queue/* → dismissal queue
  if (p.startsWith("/queue/")) {
    req.url = "/gopilot/dismissal" + req.url;
    return next();
  }
  // /students/:id/pickups → /gopilot/pickups/student/:id
  const pickupMatch = p.match(/^\/students\/([^/]+)\/pickups$/);
  if (pickupMatch) {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = `/gopilot/pickups/student/${pickupMatch[1]}${qs}`;
    return next();
  }
  // /students/:id/custody-alerts → /gopilot/pickups/student/:id/custody-alert
  const custodyMatch = p.match(/^\/students\/([^/]+)\/custody-alerts?$/);
  if (custodyMatch) {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = `/gopilot/pickups/student/${custodyMatch[1]}/custody-alert${qs}`;
    return next();
  }

  next();
});

// ============================================================================
// Route Mounts
// ============================================================================

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
router.use("/passes", passRoutes);
router.use("/kiosk", kioskRoutes);

// GoPilot - Dismissal management (canonical mounts)
router.use("/gopilot/homerooms", homeroomRoutes);
router.use("/gopilot/dismissal", dismissalRoutes);
router.use("/gopilot/dismissal", changeRoutes);
router.use("/gopilot", changeRoutes);
router.use("/gopilot/pickups", pickupRoutes);
router.use("/gopilot/bus-routes", busRouteRoutes);
router.use("/gopilot", familyRoutes);

// GoPilot root-level aliases (dismissal sessions/queue, changes, homerooms)
router.use("/homerooms", homeroomRoutes);
router.use("/", dismissalRoutes);
router.use("/", changeRoutes);

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

// Compatibility routes for missing features
router.use("/compat", compatRoutes);

// Compatibility aliases (grades, teachers, admin features)
router.use("/", compatRoutes);

export default router;
