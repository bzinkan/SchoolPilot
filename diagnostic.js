#!/usr/bin/env node
// SchoolPilot Frontend Compatibility Diagnostic
// Tests every API path each frontend calls against the unified API

const BASE = "http://localhost:4000/api";
const SCHOOL_ID = "ddb957d2-e0ec-4a9b-8e4a-d216703a4c6b";

let TOKEN = "";
let results = { pass: 0, fail: 0, warn: 0, details: [] };

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "bzinkan@school-pilot.net", password: "SuperAdmin123!" }),
  });
  const data = await res.json();
  TOKEN = data.token;
  if (!TOKEN) throw new Error("Login failed");
  console.log("Logged in successfully\n");
}

async function test(app, method, path, expectedCodes, note) {
  const url = `${BASE}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  if (SCHOOL_ID) headers["X-School-Id"] = SCHOOL_ID;

  try {
    const res = await fetch(url, { method, headers, body: method !== "GET" ? "{}" : undefined });
    const status = res.status;
    const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];

    if (status === 404) {
      // Distinguish route-not-found (HTML/text) from resource-not-found (JSON)
      const contentType = res.headers.get("content-type") || "";
      const isJsonResponse = contentType.includes("application/json");
      if (isJsonResponse) {
        // Route exists but resource not found - count as OK
        results.pass++;
        results.details.push({ app, status: "OK", method, path, httpStatus: 404, note: note || "Route exists (resource 404)" });
      } else {
        results.fail++;
        results.details.push({ app, status: "MISSING", method, path, httpStatus: status, note: note || "Route not found (404)" });
      }
    } else if (codes.includes(status) || status < 500) {
      results.pass++;
      results.details.push({ app, status: "OK", method, path, httpStatus: status, note });
    } else {
      results.warn++;
      results.details.push({ app, status: "WARN", method, path, httpStatus: status, note: note || `Unexpected ${status}` });
    }
  } catch (err) {
    results.fail++;
    results.details.push({ app, status: "ERROR", method, path, httpStatus: 0, note: err.message });
  }
}

async function testPassPilot() {
  console.log("=== PASSPILOT FRONTEND ===\n");

  // Auth
  await test("PassPilot", "POST", "/login", [200, 400, 401], "PP calls /api/login (no /auth prefix)");
  await test("PassPilot", "GET", "/auth/me", [200, 401]);
  await test("PassPilot", "POST", "/auth/logout", [200]);

  // Students
  await test("PassPilot", "GET", "/students", [200]);
  await test("PassPilot", "POST", "/students", [200, 400]);
  await test("PassPilot", "GET", "/students/csv-template", [200, 404], "CSV template download");
  await test("PassPilot", "POST", "/students/import-csv", [200, 400, 404], "CSV import");

  // Grades
  await test("PassPilot", "GET", "/grades", [200, 404], "PP grade/class CRUD");
  await test("PassPilot", "POST", "/grades", [200, 400, 404]);
  await test("PassPilot", "GET", "/grades/available", [200, 404]);

  // Passes (legacy alias at /passes)
  await test("PassPilot", "GET", "/passes", [200]);
  await test("PassPilot", "POST", "/passes", [200, 400]);
  await test("PassPilot", "GET", "/passes/active", [200]);
  await test("PassPilot", "GET", "/passes/history", [200]);

  // Teacher management
  await test("PassPilot", "GET", "/admin/teachers", [200, 404], "PP admin teacher list");
  await test("PassPilot", "POST", "/admin/teachers", [200, 400, 404], "PP admin teacher create");
  await test("PassPilot", "GET", "/teachers", [200, 404], "PP teacher list");

  // Teacher-grade assignments
  await test("PassPilot", "GET", "/teacher-grades/test-id", [200, 404], "PP teacher-grade lookup");
  await test("PassPilot", "POST", "/teacher-grades", [200, 400, 404]);
  await test("PassPilot", "POST", "/teacher-grades/self-assign", [200, 400, 404]);

  // Kiosk (legacy alias at /kiosk)
  await test("PassPilot", "POST", "/kiosk/lookup", [200, 400]);
  await test("PassPilot", "POST", "/kiosk/checkout", [200, 400]);
  await test("PassPilot", "POST", "/kiosk/checkin", [200, 400]);
  await test("PassPilot", "GET", "/kiosk/grades", [200]);
  await test("PassPilot", "GET", "/kiosk/students", [200]);
  await test("PassPilot", "GET", "/kiosk/config", [200]);
  await test("PassPilot", "PUT", "/kiosk-config", [200, 400, 404], "PP kiosk config update");

  // Admin settings/reports
  await test("PassPilot", "GET", "/admin/reports", [200, 404], "PP admin reports");
  await test("PassPilot", "PATCH", "/admin/settings", [200, 404], "PP admin settings");

  // Google integrations (PP uses /directory/* and /classroom/*)
  await test("PassPilot", "GET", "/directory/orgunits", [200, 400, 404], "PP Google Directory");
  await test("PassPilot", "GET", "/directory/users", [200, 400, 404]);
  await test("PassPilot", "POST", "/directory/import", [200, 400, 404]);
  await test("PassPilot", "POST", "/directory/import-teachers", [200, 400, 404]);
  await test("PassPilot", "GET", "/classroom/courses", [200, 400, 404], "PP Google Classroom");
  await test("PassPilot", "POST", "/classroom/courses/test-id/sync", [200, 400, 404]);

  // Super admin
  await test("PassPilot", "GET", "/super-admin/stats", [200, 404], "PP super admin");
  await test("PassPilot", "GET", "/super-admin/schools", [200, 404]);
  await test("PassPilot", "POST", "/super-admin/schools", [200, 400, 404]);
  await test("PassPilot", "GET", `/super-admin/schools/${SCHOOL_ID}`, [200, 404]);
  await test("PassPilot", "GET", `/super-admin/schools/${SCHOOL_ID}/billing`, [200, 404]);
  await test("PassPilot", "POST", `/super-admin/schools/${SCHOOL_ID}/impersonate`, [200, 404]);
  await test("PassPilot", "POST", `/super-admin/schools/${SCHOOL_ID}/reset-login`, [200, 404]);
  await test("PassPilot", "GET", "/super-admin/trial-requests", [200, 404]);
  await test("PassPilot", "GET", "/super-admin/admin-emails", [200, 404], "PP admin email list");
  await test("PassPilot", "POST", "/super-admin/broadcast-email", [200, 400, 404], "PP broadcast");

  // Trial request (public)
  await test("PassPilot", "POST", "/trial-request", [200, 400, 404], "PP trial request (singular)");

  // My classes
  await test("PassPilot", "GET", "/my-classes", [200, 404], "PP teacher my-classes dashboard");
}

async function testGoPilot() {
  console.log("\n=== GOPILOT FRONTEND ===\n");

  // Auth
  await test("GoPilot", "POST", "/auth/login", [200, 400, 401]);
  await test("GoPilot", "POST", "/auth/register", [200, 400]);
  await test("GoPilot", "POST", "/auth/register/parent", [200, 400, 404], "GP parent register");
  await test("GoPilot", "GET", "/auth/me", [200, 401]);

  // User profile
  await test("GoPilot", "PUT", "/me", [200, 400, 404], "GP user profile update");
  await test("GoPilot", "GET", "/me/children", [200, 404], "GP parent children");
  await test("GoPilot", "POST", "/me/children/link", [200, 400, 404], "GP link child");
  await test("GoPilot", "POST", "/me/join-school", [200, 400, 404], "GP join school");

  // Schools (GP uses school-scoped routes)
  await test("GoPilot", "POST", "/schools", [200, 400]);
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}`, [200]);
  await test("GoPilot", "PUT", `/schools/${SCHOOL_ID}`, [200, 400]);
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/invite`, [200, 404], "GP invite token");
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/members`, [200, 404], "GP school members");
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/settings`, [200, 404], "GP school settings");
  await test("GoPilot", "PUT", `/schools/${SCHOOL_ID}/settings`, [200, 404]);

  // Homerooms (GP uses school-scoped: /schools/{id}/homerooms)
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/homerooms`, [200, 404], "GP school-scoped homerooms");
  // Legacy alias
  await test("GoPilot", "GET", "/homerooms", [200], "GP legacy /homerooms");

  // Students (GP uses school-scoped)
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/students`, [200, 404], "GP school-scoped students");
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/students`, [200, 400, 404]);
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/students/import`, [200, 400, 404], "GP student import");
  await test("GoPilot", "PUT", `/schools/${SCHOOL_ID}/students/bulk-update`, [200, 400, 404], "GP bulk update");

  // Staff (GP uses school-scoped)
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/staff`, [200, 404], "GP school-scoped staff");
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/staff`, [200, 400, 404]);

  // Family groups (GP uses school-scoped)
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/family-groups`, [200, 404], "GP school-scoped families");
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/family-groups`, [200, 400, 404]);
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/family-groups/auto-assign`, [200, 404]);

  // Legacy family routes at /gopilot
  await test("GoPilot", "GET", "/gopilot/family-groups", [200], "GP /gopilot/ family groups");

  // Dismissal mode (GP uses school-scoped)
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/dismissal-mode`, [200, 404], "GP dismissal mode");
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/send-to-app-mode`, [200, 404], "GP app mode");
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/switch-to-no-app-mode`, [200, 404], "GP no-app mode");

  // Dismissal sessions (GP calls: POST /schools/{id}/sessions, GET /sessions/{id})
  await test("GoPilot", "POST", `/schools/${SCHOOL_ID}/sessions`, [200, 400, 404], "GP create session (school-scoped)");
  // Legacy alias: /sessions
  await test("GoPilot", "POST", "/sessions/sessions", [200, 400], "GP dismissal sessions via legacy mount");
  await test("GoPilot", "POST", "/dismissal/sessions", [200, 400], "GP dismissal sessions via /dismissal mount");

  // Session operations (GP calls /sessions/{id}/queue, /sessions/{id}/check-in, etc.)
  await test("GoPilot", "GET", "/sessions/sessions/test-id/queue", [200, 400, 404], "GP session queue via /sessions");
  await test("GoPilot", "POST", "/sessions/sessions/test-id/check-in", [200, 400, 404], "GP check-in via /sessions");

  // GoPilot dismissal at proper prefix
  await test("GoPilot", "POST", "/gopilot/dismissal/sessions", [200, 400], "GP /gopilot/dismissal/sessions");
  await test("GoPilot", "GET", "/gopilot/dismissal/sessions/test-id/queue", [200, 404], "GP gopilot queue");

  // Queue operations
  await test("GoPilot", "POST", "/queue/test-id/release", [200, 404], "GP legacy /queue/:id/release");
  await test("GoPilot", "POST", "/gopilot/dismissal/queue/test-id/release", [200, 404], "GP gopilot queue release");
  await test("GoPilot", "POST", "/sessions/queue/test-id/release", [200, 404], "GP /sessions/queue/:id/release");

  // Dismissal changes
  await test("GoPilot", "POST", "/sessions/test-id/changes", [200, 400, 404], "GP legacy changes via /sessions");
  await test("GoPilot", "GET", "/sessions/test-id/changes", [200, 404]);
  await test("GoPilot", "GET", "/gopilot/dismissal/sessions/test-id/changes", [200, 404], "GP changes via gopilot prefix");

  // Dismissal changes approval (at /gopilot or /changes)
  await test("GoPilot", "PUT", "/changes/test-id", [200, 404], "GP legacy /changes/:id");
  await test("GoPilot", "PUT", "/gopilot/changes/test-id", [200, 404], "GP /gopilot/changes/:id");

  // Pickups & Custody
  await test("GoPilot", "GET", "/students/test-id/pickups", [200, 404], "GP student pickups");
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/custody-alerts`, [200, 404], "GP school-scoped custody");
  await test("GoPilot", "GET", "/gopilot/pickups/custody-alerts", [200], "GP gopilot custody");

  // Parent requests
  await test("GoPilot", "GET", `/schools/${SCHOOL_ID}/parent-requests`, [200, 404], "GP parent requests");

  // Google
  await test("GoPilot", "GET", "/google/auth-url", [200, 503]);
  await test("GoPilot", "GET", "/google/status", [200]);
  await test("GoPilot", "GET", "/google/courses", [200, 400, 404], "GP Google Classroom via /google");
  await test("GoPilot", "GET", "/google/workspace/orgunits", [200, 400, 404], "GP Google Workspace");
  await test("GoPilot", "GET", "/google/workspace/users", [200, 400, 404]);
  await test("GoPilot", "POST", "/google/workspace/import", [200, 400, 404]);
  await test("GoPilot", "POST", "/google/workspace/import-staff", [200, 400, 404]);

  // Super admin
  await test("GoPilot", "GET", "/super-admin/stats", [200, 404], "GP super admin stats");
  await test("GoPilot", "GET", "/super-admin/schools", [200, 404]);
  await test("GoPilot", "POST", "/super-admin/trial-requests", [200, 400, 404], "GP trial request submit");
  await test("GoPilot", "GET", "/super-admin/trial-requests", [200, 404]);
}

async function testClassPilot() {
  console.log("\n=== CLASSPILOT FRONTEND ===\n");

  // Auth (CP calls /api/login, /api/me, /api/logout WITHOUT /auth prefix)
  await test("ClassPilot", "POST", "/login", [200, 400, 401], "CP calls /api/login (no /auth prefix)");
  await test("ClassPilot", "GET", "/me", [200, 401], "CP calls /api/me (no /auth prefix)");
  await test("ClassPilot", "POST", "/logout", [200], "CP calls /api/logout (no /auth prefix)");
  await test("ClassPilot", "GET", "/csrf", [200], "CP CSRF token");

  // Students (CP calls without /classpilot prefix)
  await test("ClassPilot", "GET", "/students", [200], "CP students list");
  await test("ClassPilot", "GET", "/students-aggregated", [200, 404], "CP aggregated students");
  await test("ClassPilot", "POST", "/students", [200, 400]);

  // Roster (CP calls /roster/*)
  await test("ClassPilot", "GET", "/roster/students", [200, 404], "CP roster students");
  await test("ClassPilot", "GET", "/roster/devices", [200, 404], "CP roster devices");
  await test("ClassPilot", "POST", "/roster/student", [200, 400, 404], "CP roster add");

  // Devices (CP calls /devices/*)
  await test("ClassPilot", "GET", "/devices", [200, 404], "CP device list");

  // Groups (CP calls /groups/* without /classpilot prefix)
  await test("ClassPilot", "GET", "/groups", [200, 404], "CP groups list");

  // Subgroups (CP calls /subgroups/*)
  await test("ClassPilot", "GET", "/subgroups/test-id/members", [200, 404], "CP subgroup members");

  // Sessions (CP calls /sessions/start, /sessions/end, /sessions/active)
  await test("ClassPilot", "POST", "/sessions/start", [200, 400, 404], "CP session start");
  await test("ClassPilot", "POST", "/sessions/end", [200, 400, 404], "CP session end");
  await test("ClassPilot", "GET", "/sessions/active", [200, 404], "CP active session");
  await test("ClassPilot", "GET", "/sessions/all", [200, 404], "CP all sessions");

  // Settings (CP calls /settings and /teacher/settings)
  await test("ClassPilot", "GET", "/settings", [200, 404], "CP school settings");
  await test("ClassPilot", "POST", "/settings", [200, 400, 404]);
  await test("ClassPilot", "GET", "/teacher/settings", [200, 404], "CP teacher settings");
  await test("ClassPilot", "POST", "/teacher/settings", [200, 400, 404]);
  await test("ClassPilot", "POST", "/settings/hand-raising", [200, 400, 404], "CP hand-raising setting");
  await test("ClassPilot", "POST", "/settings/student-messaging", [200, 400, 404], "CP messaging setting");

  // Teacher groups (CP calls /teacher/groups)
  await test("ClassPilot", "GET", "/teacher/groups", [200, 404], "CP teacher groups");
  await test("ClassPilot", "POST", "/teacher/groups", [200, 400, 404]);

  // Teacher messages/hands (CP calls /teacher/*)
  await test("ClassPilot", "GET", "/teacher/raised-hands", [200, 404], "CP raised hands");
  await test("ClassPilot", "GET", "/teacher/messages", [200, 404], "CP teacher messages");
  await test("ClassPilot", "POST", "/teacher/reply", [200, 400, 404], "CP teacher reply");

  // Flight paths (CP calls /flight-paths/*)
  await test("ClassPilot", "GET", "/flight-paths", [200, 404], "CP flight paths");
  await test("ClassPilot", "POST", "/flight-paths", [200, 400, 404]);

  // Block lists (CP calls /block-lists/*)
  await test("ClassPilot", "GET", "/block-lists", [200, 404], "CP block lists");
  await test("ClassPilot", "POST", "/block-lists", [200, 400, 404]);

  // Remote control (CP calls /remote/*)
  await test("ClassPilot", "POST", "/remote/open-tab", [200, 400, 404], "CP remote open-tab");
  await test("ClassPilot", "POST", "/remote/lock-screen", [200, 400, 404], "CP remote lock");
  await test("ClassPilot", "POST", "/remote/apply-flight-path", [200, 400, 404], "CP apply flight path");

  // Polls (CP calls /polls/*)
  await test("ClassPilot", "POST", "/polls/create", [200, 400, 404], "CP create poll");

  // Heartbeats & Screenshots (CP calls /heartbeats, /device/screenshot)
  await test("ClassPilot", "GET", "/heartbeats", [200, 404], "CP heartbeats");
  await test("ClassPilot", "GET", "/device/screenshot/test-id", [200, 404], "CP screenshot");
  await test("ClassPilot", "GET", "/student-analytics", [200, 404], "CP student analytics");

  // Admin user management (CP calls /admin/*)
  await test("ClassPilot", "GET", "/admin/users", [200, 404], "CP admin users");
  await test("ClassPilot", "GET", "/admin/teachers", [200, 404], "CP admin teachers");
  await test("ClassPilot", "GET", "/admin/teacher-students", [200, 404], "CP admin teacher-students");
  await test("ClassPilot", "GET", "/admin/analytics/summary", [200, 404], "CP admin analytics");
  await test("ClassPilot", "GET", "/admin/audit-logs", [200, 404], "CP admin audit logs");
  await test("ClassPilot", "POST", "/admin/bulk-import", [200, 400, 404], "CP admin bulk import");
  await test("ClassPilot", "POST", "/admin/students/bulk-delete", [200, 400, 404], "CP admin bulk delete");

  // Classroom/Directory (CP calls without /google prefix)
  await test("ClassPilot", "GET", "/classroom/courses", [200, 400, 404], "CP Classroom courses");
  await test("ClassPilot", "GET", "/directory/users", [200, 400, 404], "CP Directory users");
  await test("ClassPilot", "GET", "/directory/orgunits", [200, 400, 404], "CP Directory orgunits");
  await test("ClassPilot", "POST", "/directory/import", [200, 400, 404], "CP Directory import");
  await test("ClassPilot", "POST", "/directory/import-staff", [200, 400, 404]);

  // Super admin (CP calls /super-admin/*)
  await test("ClassPilot", "GET", "/super-admin/schools", [200, 404], "CP super admin schools");
  await test("ClassPilot", "GET", "/super-admin/trial-requests", [200, 404]);
  await test("ClassPilot", "POST", "/super-admin/stop-impersonate", [200, 404], "CP stop impersonate");
  await test("ClassPilot", "GET", "/super-admin/admin-emails", [200, 404], "CP admin emails");

  // Billing (CP calls /checkout/*)
  await test("ClassPilot", "POST", "/checkout/create-session", [200, 503, 404], "CP Stripe checkout");

  // Trial requests (CP calls /trial-requests)
  await test("ClassPilot", "POST", "/trial-requests", [200, 400, 404], "CP trial request");

  // Export
  await test("ClassPilot", "GET", "/export/activity", [200, 404], "CP activity export");
}

async function testCORS() {
  console.log("\n=== CORS & INFRASTRUCTURE ===\n");

  // Test CORS for each frontend origin
  for (const origin of ["http://localhost:5173", "http://localhost:3000", "http://localhost:5000"]) {
    const res = await fetch(`${BASE}/auth/me`, {
      method: "OPTIONS",
      headers: { "Origin": origin, "Access-Control-Request-Method": "GET" },
    });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    const ok = allowOrigin === origin || allowOrigin === "*";
    if (ok) {
      results.pass++;
      results.details.push({ app: "CORS", status: "OK", method: "OPTIONS", path: `/auth/me (origin: ${origin})`, httpStatus: res.status });
    } else {
      results.fail++;
      results.details.push({ app: "CORS", status: "MISSING", method: "OPTIONS", path: `/auth/me (origin: ${origin})`, httpStatus: res.status, note: `Got: ${allowOrigin}` });
    }
  }

  // Test health endpoint
  const healthRes = await fetch("http://localhost:4000/health");
  const health = await healthRes.json();
  if (health.status === "ok") {
    results.pass++;
    results.details.push({ app: "Infra", status: "OK", method: "GET", path: "/health", httpStatus: 200 });
  }
}

function printReport() {
  console.log("\n" + "=".repeat(80));
  console.log("DIAGNOSTIC REPORT");
  console.log("=".repeat(80) + "\n");

  for (const app of ["PassPilot", "GoPilot", "ClassPilot", "CORS", "Infra"]) {
    const appDetails = results.details.filter(d => d.app === app);
    if (appDetails.length === 0) continue;

    const missing = appDetails.filter(d => d.status === "MISSING");
    const ok = appDetails.filter(d => d.status === "OK");
    const warn = appDetails.filter(d => d.status === "WARN");

    console.log(`\n--- ${app} ---`);
    console.log(`  Routes working: ${ok.length}/${appDetails.length}`);

    if (missing.length > 0) {
      console.log(`  MISSING ROUTES (404):`);
      for (const m of missing) {
        console.log(`    ${m.method.padEnd(7)} ${m.path} ${m.note ? `  -- ${m.note}` : ""}`);
      }
    }

    if (warn.length > 0) {
      console.log(`  WARNINGS:`);
      for (const w of warn) {
        console.log(`    ${w.method.padEnd(7)} ${w.path} (${w.httpStatus}) ${w.note || ""}`);
      }
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`TOTALS: ${results.pass} OK | ${results.fail} MISSING | ${results.warn} WARN`);
  console.log(`${"=".repeat(80)}\n`);
}

async function main() {
  try {
    await login();
    await testPassPilot();
    await testGoPilot();
    await testClassPilot();
    await testCORS();
    printReport();
  } catch (err) {
    console.error("Diagnostic failed:", err);
  }
}

main();
