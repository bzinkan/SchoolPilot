import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "portal-school-a";
const API_PATH = "/api/classpilot/admin/sso-policy";
const screenshots = path.join(os.tmpdir(), "classpilot-student-portal-browser");

function policyResponse() {
  return {
    revision: 8, policyValid: true, operatorGateActive: false,
    requiredCapability: "restrictionPortalFirstV1", conflicts: [],
    extensionReadiness: { capability: "restrictionPortalFirstV1", observationWindowSeconds: 300,
      recentlyActiveBindings: 4, observedBindings: 3, readyBindings: 2 },
    policy: { schemaVersion: 1, enabled: false, defaultProfileId: "google", attemptTtlSeconds: 300,
      profiles: [
        { id: "clever", name: "Clever", startUrl: "https://clever.com/in/school-a", hostRules: [
          { hostname: "clever.com", includeSubdomains: true },
          { hostname: "accounts.google.com", includeSubdomains: false },
        ] },
        { id: "google", name: "Google", startUrl: "https://accounts.google.com", hostRules: [
          { hostname: "accounts.google.com", includeSubdomains: false },
        ] },
      ] },
  };
}

function authResponse(role, roles) {
  return {
    user: { id: "portal-user", email: "staff@example.test", firstName: "Portal", lastName: "Admin",
      isSuperAdmin: role === "super_admin" },
    token: "portal-fixture-token", activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true },
    memberships: [{ id: "portal-member-a", schoolId: SCHOOL_ID, schoolName: "Portal Test School",
      role: role === "super_admin" ? "teacher" : role, roles, schoolTimezone: "America/New_York" }],
  };
}

async function fixture(browser, baseURL, role = "school_admin", roles) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
  await context.addInitScript(id => localStorage.setItem("sp_activeSchoolId", id), SCHOOL_ID);
  const page = await context.newPage();
  const errors = [], requests = [];
  let current = policyResponse(), nextSave = "success";
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "" }));
  await page.route("https://fonts.gstatic.com/**", route => route.fulfill({ body: "" }));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: authResponse(role, roles) });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "portal-fixture-csrf" } });
    if (url.pathname === API_PATH) {
      requests.push({ method: request.method(), schoolId: request.headers()["x-school-id"], body: request.postDataJSON() });
      if (request.method() === "GET") return route.fulfill({ json: current });
      if (nextSave === "conflict") {
        nextSave = "success";
        current = { ...current, revision: current.revision + 1,
          policy: { ...current.policy, profiles: current.policy.profiles.map(profile => profile.id === "clever"
            ? { ...profile, startUrl: "https://clever.com/in/newer-admin-save" } : profile) } };
        return route.fulfill({ status: 409, json: { error: "Policy changed elsewhere", current } });
      }
      if (nextSave === "forbidden") return route.fulfill({ status: 403, json: { error: "Administrator permission is required" } });
      const body = request.postDataJSON();
      assert.equal(body.expectedRevision, current.revision, "save must use the loaded school policy revision");
      current = { ...current, revision: current.revision + 1, policy: body.policy };
      return route.fulfill({ json: current });
    }
    if (url.pathname === "/api/classpilot/admin/instructional-calendar") return route.fulfill({ json: {
      month: url.searchParams.get("month"), revision: 1, schoolTimezone: "America/New_York",
      schoolLocalToday: "2026-09-01", nonInstructionalDates: [], updatedAt: null,
    } });
    if (url.pathname === "/api/settings") return route.fulfill({ json: { schoolName: "Portal Test School", retentionDays: 30 } });
    if (["/api/sessions/all", "/api/teacher/groups", "/api/flight-paths"].includes(url.pathname)) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  return { context, page, errors, requests, current: () => current, nextSave: mode => { nextSave = mode; } };
}

test("Student Portal placement, guarded navigation, revisioned save and administrator permissions", { timeout: 120_000 }, async t => {
  const vite = await createServer({ root: APP_ROOT, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  let browser;
  t.signal.addEventListener("abort", () => { void browser?.close().catch(() => {}); }, { once: true });
  try {
    browser = await chromium.launch({ headless: true });
    await t.test("main Admin tab preserves the calendar draft guard and saves Clever-first with exact hosts", async () => {
      const f = await fixture(browser, baseURL);
      try {
        await f.page.goto("/classpilot/admin?tab=calendar&month=2099-09", { waitUntil: "networkidle" });
        await f.page.getByTestId("calendar-day-2099-09-09").click();
        await f.page.getByRole("tab", { name: "Student Portal", exact: true }).click();
        await f.page.getByRole("button", { name: "Keep editing", exact: true }).waitFor();
        assert.equal(f.requests.length, 0, "the portal must not load before leaving the guarded calendar draft");
        await f.page.getByRole("button", { name: "Keep editing", exact: true }).click();
        assert.equal(await f.page.getByTestId("calendar-day-2099-09-09").getAttribute("aria-pressed"), "true");
        await f.page.getByRole("tab", { name: "Student Portal", exact: true }).click();
        await f.page.getByTestId("button-discard-calendar-navigation").click();
        await f.page.getByRole("region", { name: "Student Portal & Sign-In", exact: true }).waitFor();
        assert.equal(new URL(f.page.url()).searchParams.get("tab"), "student-portal");
        await f.page.getByText("2 of 4 recent student sign-ins have compatible Student Portal support; 3 have reported support information.", { exact: true }).waitFor();
        await f.page.getByText("School rollout is off. Settings are saved, but Student Portal behavior is not active yet.", { exact: true }).waitFor();
        assert.equal(await f.page.getByTestId("button-save-sso-policy").isDisabled(), true);
        await f.page.getByTestId("switch-waypoint-student-sign-in").click();
        await f.page.getByTestId("select-sso-default-provider").click();
        await f.page.getByRole("option", { name: "Clever", exact: true }).click();
        await f.page.locator("#provider-url-clever").fill("https://clever.com/in/school-a?login=google");
        assert.equal(await f.page.locator("#sso-host-clever-0").getAttribute("readonly"), "");
        assert.equal(await f.page.locator("#sso-host-clever-1-subdomains").isDisabled(), true);
        await f.page.getByTestId("button-save-sso-policy").click();
        await f.page.getByText("Student Portal configuration saved", { exact: true }).waitFor();
        assert.equal(f.current().revision, 9);
        const saved = f.requests.find(request => request.method === "PATCH");
        assert.deepEqual(saved.body, { expectedRevision: 8, policy: {
          ...policyResponse().policy, enabled: true, defaultProfileId: "clever",
          profiles: policyResponse().policy.profiles.map(profile => profile.id === "clever"
            ? { ...profile, startUrl: "https://clever.com/in/school-a?login=google" } : profile),
        } });
        assert.ok(f.requests.every(request => request.schoolId === SCHOOL_ID));
        assert.equal(new URL(f.page.url()).pathname, "/classpilot/admin", "configuration saves never navigate the administrator to a provider");
        await f.page.locator("[toast-close]").click();
        await f.page.getByText("Student Portal configuration saved", { exact: true }).waitFor({ state: "hidden" });
        await mkdir(screenshots, { recursive: true });
        await f.page.screenshot({ path: path.join(screenshots, "student-portal-admin-desktop.png"), fullPage: true });
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.screenshot({ path: path.join(screenshots, "student-portal-admin-mobile.png"), fullPage: true });
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "portal must fit the mobile viewport");
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await t.test("conflicts require the newer revision and a later forbidden save leaves the policy unchanged", async () => {
      const f = await fixture(browser, baseURL, "admin");
      try {
        await f.page.goto("/classpilot/admin?tab=student-portal", { waitUntil: "networkidle" });
        await f.page.locator("#provider-url-clever").fill("https://clever.com/in/stale-draft");
        f.nextSave("conflict");
        await f.page.getByTestId("button-save-sso-policy").click();
        await f.page.getByTestId("sso-policy-revision-conflict").waitFor();
        assert.equal(await f.page.locator("#provider-url-clever").inputValue(), "https://clever.com/in/stale-draft");
        await f.page.getByRole("button", { name: "Load latest policy", exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector("#provider-url-clever")?.value === "https://clever.com/in/newer-admin-save");
        assert.equal(await f.page.getByTestId("button-save-sso-policy").isDisabled(), true);
        await f.page.locator("#provider-url-clever").fill("https://clever.com/in/reviewed-edit");
        await f.page.getByTestId("button-save-sso-policy").click();
        await f.page.getByText("Student Portal configuration saved", { exact: true }).waitFor();
        assert.equal(f.current().revision, 10);
        f.nextSave("forbidden");
        await f.page.locator("#provider-url-clever").fill("https://clever.com/in/permission-revoked");
        await f.page.getByTestId("button-save-sso-policy").click();
        await f.page.getByRole("alert").filter({ hasText: "Administrator permission is required" }).waitFor();
        assert.equal(f.current().revision, 10);
        assert.equal(f.current().policy.profiles[0].startUrl, "https://clever.com/in/reviewed-edit");
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    for (const [role, roles, allowed] of [
      ["teacher", undefined, false], ["office_staff", undefined, false],
      ["teacher", ["teacher", "school_admin"], true], ["super_admin", undefined, true],
    ]) await t.test(`${role}${roles ? " with an administrator membership role" : ""} access is ${allowed ? "allowed" : "denied"}`, async () => {
      const f = await fixture(browser, baseURL, role, roles);
      try {
        await f.page.goto("/classpilot/admin?tab=student-portal", { waitUntil: "networkidle" });
        if (allowed) {
          await f.page.getByTestId("card-student-sso-policy").waitFor();
          assert.ok(f.requests.some(request => request.method === "GET"));
        } else {
          await f.page.getByText("Access denied", { exact: true }).waitFor();
          assert.equal(await f.page.getByTestId("card-student-sso-policy").count(), 0);
          assert.equal(f.requests.length, 0, "nonadministrators must not read or mutate the policy");
        }
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await t.test("Settings keeps its old anchor as a link and no longer loads the policy editor", async () => {
      const f = await fixture(browser, baseURL);
      try {
        await f.page.goto("/classpilot/settings#student-sign-in-during-waypoints", { waitUntil: "networkidle" });
        await f.page.getByRole("button", { name: "Open Student Portal configuration", exact: true }).waitFor();
        assert.equal(await f.page.getByTestId("card-student-sso-policy").count(), 0);
        assert.equal(f.requests.length, 0);
        await f.page.getByRole("button", { name: "Open Student Portal configuration", exact: true }).click();
        await f.page.getByTestId("card-student-sso-policy").waitFor();
        assert.equal(new URL(f.page.url()).searchParams.get("tab"), "student-portal");
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    console.log(`Student Portal screenshots: ${screenshots}`);
  } finally { await browser?.close(); await vite.close(); }
});
