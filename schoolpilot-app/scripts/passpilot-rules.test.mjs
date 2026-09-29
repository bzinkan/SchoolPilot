import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const source = (relative) => readFile(path.join(APP_ROOT, relative), "utf8");

const students = [
  { id: "student-one", firstName: "Jordan", lastName: "Lee", studentIdNumber: "1001", status: "active" },
  { id: "student-two", firstName: "Taylor", lastName: "Kim", studentIdNumber: "1002", status: "active" },
];

test("rule UI source contracts", async () => {
  const [setup, rulesTab, myClass] = await Promise.all([
    source("src/products/passpilot/components/admin/SetupView.jsx"),
    source("src/products/passpilot/components/admin/RulesTab.jsx"),
    source("src/products/passpilot/components/tabs/MyClassTab.jsx"),
  ]);

  // The Rules tab exists only after the admin-only probe succeeds.
  assert.match(setup, /const RulesTab = lazy\(\(\) => import\("\.\/RulesTab"\)\);/);
  assert.match(setup, /enabled: isAdmin && !!school\?\.id,\s+retry: false,/);
  assert.match(setup, /const showRules = isAdmin && rulesQuery\.isSuccess;/);
  assert.match(setup, /\{showRules \? <TabsTrigger value="rules" data-testid="tab-rules">Rules<\/TabsTrigger> : null\}/);
  assert.match(setup, /const rulesProbePending = requestedTab === "rules" && rulesQuery\.isLoading;/);
  assert.match(setup, /if \(!classesQuery\.isSuccess \|\| rulesProbePending \|\| requestedTab === activeTab\) return;/);

  for (const testId of [
    "switch-capacity-${destination}", "input-capacity-${destination}", "input-daily-limit", "input-period-limit",
    "button-add-student-limit", "row-student-limit-${limit.studentId}", "row-encounter-${restriction.id}",
    "button-add-encounter", "alert-period-enforcement",
  ]) {
    assert.ok(rulesTab.includes(testId), `RulesTab must render ${testId}`);
  }
  assert.match(rulesTab, /data-testid=\{`select-\$\{id\}`\}/, "student pickers render select-encounter-student-a|b");
  assert.match(rulesTab, /<StudentPicker id="encounter-student-a"/);
  assert.match(rulesTab, /<StudentPicker id="encounter-student-b"/);
  assert.match(rulesTab, /const refreshed = await rulesQuery\.refetch\(\);/, "every write is verified by a fresh GET");
  assert.doesNotMatch(rulesTab, /from "\.\/SetupView"/, "RulesTab keeps its own student search");
  assert.doesNotMatch(rulesTab, /Kiosk Requires Approval/);
  assert.doesNotMatch(rulesTab, /frequent|problem student|troublemaker|abuse/i);

  // My Class shows the server's message and offers the override only when the server allows it.
  const markOut = myClass.slice(myClass.indexOf("const handleMarkOut = async"), myClass.indexOf("const confirmRuleOverride = () =>"));
  assert.ok(markOut.length > 0, "handleMarkOut must precede confirmRuleOverride");
  assert.match(markOut, /description: data\?\.error \|\| error\?\.message \|\| 'The pass could not be issued\.'/);
  assert.doesNotMatch(markOut, /description: error\.message,/, "issue errors show the server's message");
  assert.match(myClass, /data\?\.canOverride === true/);
  assert.match(myClass, /!overrideRuleCode\s+&& data\?\.canOverride === true/, "an override retry is never re-offered");
  assert.match(myClass, /\.\.\.\(overrideRuleCode \? \{ overrideRuleCode \} : \{\}\)/);
  assert.match(myClass, /data-testid="dialog-rule-override"/);
  assert.match(myClass, /data-testid="button-confirm-rule-override"/);
});

function authResponse(role = "admin") {
  return {
    user: { id: `${role}-one`, email: `${role}@example.edu`, firstName: "Ada", lastName: "Admin", isSuperAdmin: false },
    token: "passpilot-rules-browser-token",
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true, passPilot: true, goPilot: false },
    memberships: [{
      id: `${role}-membership`, schoolId: SCHOOL_ID, role, schoolName: "Rules Browser School", schoolTimezone: "America/New_York",
    }],
  };
}

function emptyRules() {
  return {
    destinations: ["bathroom", "nurse", "office", "counselor", "other_classroom"],
    destinationPolicies: [],
    defaultLimits: null,
    studentLimits: [],
    encounterRestrictions: [],
    periodEnforcement: "unavailable",
    denialRetentionDays: 400,
  };
}

function studentSummary(id) {
  const student = students.find((candidate) => candidate.id === id);
  return student ? { id, firstName: student.firstName, lastName: student.lastName, studentIdNumber: student.studentIdNumber, status: "active" } : null;
}

/** Common School Setup / My Class responses; rules are stateful when state.rules is set. */
async function installStaffMocks(page, state) {
  await page.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
  }, SCHOOL_ID);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === "/api/auth/me") return route.fulfill({ json: authResponse(state.role) });
    if (pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "rules-browser-csrf" } });

    if (pathname === "/api/passpilot/admin/rules" || pathname.startsWith("/api/passpilot/admin/rules/")) {
      state.rulesRequests.push({ method, pathname, body: method === "GET" || method === "DELETE" ? undefined : request.postDataJSON() });
      if (!state.rules) return route.fulfill({ status: 404, json: { error: "Not found" } });
      if (method === "GET") {
        if (state.staleNextGet) {
          state.staleNextGet = false;
          return route.fulfill({ json: state.staleRules });
        }
        return route.fulfill({ json: state.rules });
      }
      state.staleRules = structuredClone(state.rules);
      const body = request.postDataJSON?.() ?? null;
      const destinationMatch = pathname.match(/\/destinations\/([^/]+)$/);
      const studentMatch = pathname.match(/\/limits\/students\/([^/]+)$/);
      const encounterMatch = pathname.match(/\/encounters\/([^/]+)$/);
      if (destinationMatch && method === "PUT") {
        const destination = decodeURIComponent(destinationMatch[1]);
        state.rules.destinationPolicies = [
          ...state.rules.destinationPolicies.filter((policy) => policy.destination !== destination),
          { destination, ...body, updatedAt: new Date().toISOString() },
        ];
      } else if (pathname.endsWith("/limits/default") && method === "PUT") {
        state.rules.defaultLimits = { id: "default-limit", ...body, updatedAt: new Date().toISOString() };
      } else if (studentMatch && method === "PUT") {
        const studentId = decodeURIComponent(studentMatch[1]);
        state.rules.studentLimits = [
          ...state.rules.studentLimits.filter((limit) => limit.studentId !== studentId),
          { id: `limit-${studentId}`, studentId, student: studentSummary(studentId), ...body, updatedAt: new Date().toISOString() },
        ];
      } else if (pathname.endsWith("/encounters") && method === "POST") {
        const [studentAId, studentBId] = [body.studentIdA, body.studentIdB].sort();
        state.rules.encounterRestrictions = [...state.rules.encounterRestrictions, {
          id: `encounter-${state.rules.encounterRestrictions.length + 1}`,
          studentAId, studentBId, students: [studentSummary(studentAId), studentSummary(studentBId)],
          reasonNote: body.reasonNote ?? null, enabled: true, createdAt: new Date().toISOString(),
        }];
      } else if (encounterMatch && method === "PATCH") {
        state.rules.encounterRestrictions = state.rules.encounterRestrictions.map((restriction) => (
          restriction.id === decodeURIComponent(encounterMatch[1]) ? { ...restriction, enabled: body.enabled } : restriction));
      }
      return route.fulfill({ status: method === "POST" ? 201 : 200, json: state.rules });
    }

    if (pathname === "/api/students") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      state.studentSearches.push(search);
      return route.fulfill({ json: { students: students.filter((student) => `${student.firstName} ${student.lastName}`.toLowerCase().includes(search)) } });
    }
    if (pathname === "/api/passpilot/classes") {
      return route.fulfill({ json: { source: "classpilot_groups", classes: [{
        id: "class-two", classId: "class-two", source: "classpilot_groups", name: "Grade 4 Homeroom", gradeLevel: "4",
        studentCount: 2, teacherCount: 1, primaryTeacher: { id: "teacher-one", name: "Cayla Couch", email: "cayla@example.edu" }, coTeachers: [],
      }] } });
    }
    if (pathname === "/api/passpilot/classes/class-two/students") {
      return route.fulfill({ json: { source: "classpilot_groups", class: { id: "class-two", name: "Grade 4 Homeroom" }, students } });
    }
    if (pathname === "/api/passes" && method === "POST") {
      const payload = request.postDataJSON();
      state.passWrites.push(payload);
      const next = state.passResponses.shift() ?? { status: 201, json: { pass: { id: `pass-${state.passWrites.length}` } } };
      return route.fulfill(next);
    }
    if (pathname === "/api/passes/active" || pathname === "/api/passpilot/passes/active") {
      return route.fulfill({ json: { classId: url.searchParams.get("classId"), passes: [] } });
    }
    if (pathname === "/api/passes/history") return route.fulfill({ json: { passes: [], hasMore: false, nextCursor: null } });
    if (pathname === "/api/passpilot/kiosk/sessions/mine") return route.fulfill({ json: { sessions: [] } });
    if (pathname === "/api/kiosk-config") return route.fulfill({ json: { source: "classpilot_groups", classId: null, gradeId: null } });
    if (pathname === "/api/admin/teachers") return route.fulfill({ json: { teachers: [] } });
    if (pathname === "/api/grades" || pathname === "/api/my-classes") return route.fulfill({ json: { grades: [] } });
    if (pathname === "/api/admin/attendance") return route.fulfill({ json: { records: [] } });
    return route.fulfill({ status: 200, json: {} });
  });
}

function freshState(overrides = {}) {
  return {
    role: "admin",
    rules: null,
    staleRules: null,
    staleNextGet: false,
    rulesRequests: [],
    studentSearches: [],
    passWrites: [],
    passResponses: [],
    ...overrides,
  };
}

async function pickStudent(page, pickerId, search, studentId) {
  await page.getByTestId(`input-${pickerId}-search`).fill(search);
  await page.locator(`[data-testid="select-${pickerId}"] option[value="${studentId}"]`).waitFor({ state: "attached" });
  await page.getByTestId(`select-${pickerId}`).selectOption(studentId);
}

const textAppears = (page, text) => page.waitForFunction((expected) => document.body.textContent.includes(expected), text);

test("Rules tab, kiosk denial message, and administrator override in Chromium", { timeout: 240_000 }, async () => {
  const vite = await createServer({ root: APP_ROOT, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite must listen on a local TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    // Rules off: the 404 probe hides the tab and a deep link falls back to Teachers.
    const offPage = await browser.newPage();
    const offState = freshState();
    await installStaffMocks(offPage, offState);
    await offPage.goto(`${baseUrl}/passpilot/setup?section=rules`);
    await offPage.getByRole("heading", { name: "School Setup" }).waitFor({ timeout: 30_000 });
    await offPage.waitForURL((current) => current.pathname === "/passpilot/setup" && !current.searchParams.has("section"));
    assert.equal(await offPage.getByTestId("tab-rules").count(), 0);
    assert.ok(offState.rulesRequests.length >= 1, "School Setup probes the rules endpoint");
    assert.ok(offState.rulesRequests.every((entry) => entry.method === "GET"), "the probe never writes");
    await offPage.close();

    // Rules on: the deep link survives the probe, and every write is verified by GET.
    const page = await browser.newPage();
    const state = freshState({ rules: emptyRules() });
    await installStaffMocks(page, state);
    await page.goto(`${baseUrl}/passpilot/setup?section=rules`);
    await page.getByTestId("tab-rules").waitFor({ timeout: 30_000 });
    assert.equal(await page.getByTestId("tab-rules").getAttribute("aria-selected"), "true");
    assert.equal(new URL(page.url()).searchParams.get("section"), "rules");

    await page.getByTestId("input-capacity-bathroom").fill("3");
    assert.equal(await page.getByTestId("switch-capacity-bathroom").getAttribute("aria-checked"), "true");
    const getsBefore = state.rulesRequests.filter((entry) => entry.method === "GET").length;
    await page.getByTestId("button-save-capacity-bathroom").click();
    await textAppears(page, "Rules saved");
    const writes = state.rulesRequests.filter((entry) => entry.method !== "GET");
    assert.deepEqual(writes, [{ method: "PUT", pathname: "/api/passpilot/admin/rules/destinations/bathroom", body: { maxConcurrent: 3, enabled: true } }]);
    assert.ok(state.rulesRequests.filter((entry) => entry.method === "GET").length > getsBefore, "a fresh GET confirms the save");
    await page.getByTestId("button-remove-capacity-bathroom").waitFor();

    await page.getByTestId("input-period-limit").fill("1");
    await page.getByTestId("button-save-default-limits").click();
    await page.getByTestId("alert-period-enforcement").waitFor();
    assert.match(await page.getByTestId("alert-period-enforcement").innerText(), /not enforced/);
    assert.deepEqual(state.rulesRequests.filter((entry) => entry.pathname.endsWith("/limits/default")).at(-1)?.body,
      { dailyLimit: null, periodLimit: 1, enabled: true });

    await pickStudent(page, "student-limit-student", "Jordan", "student-one");
    await page.getByTestId("input-student-daily-limit").fill("0");
    await page.getByTestId("button-add-student-limit").click();
    await page.getByTestId("row-student-limit-student-one").waitFor();
    assert.match(await page.getByTestId("row-student-limit-student-one").innerText(), /Lee, Jordan/);
    assert.deepEqual(state.rulesRequests.filter((entry) => entry.pathname.endsWith("/limits/students/student-one"))[0]?.body,
      { dailyLimit: 0, periodLimit: null, enabled: true });

    await pickStudent(page, "encounter-student-a", "Taylor", "student-two");
    await pickStudent(page, "encounter-student-b", "Jordan", "student-one");
    await page.getByTestId("button-add-encounter").click();
    await page.getByTestId("row-encounter-encounter-1").waitFor();
    assert.deepEqual(state.rulesRequests.find((entry) => entry.method === "POST")?.body, { studentIdA: "student-two", studentIdB: "student-one" });
    assert.match(await page.getByTestId("row-encounter-encounter-1").innerText(), /Lee, Jordan and Kim, Taylor/);

    // A write whose follow-up GET does not show the change is never reported as saved.
    state.staleNextGet = true;
    await page.getByTestId("switch-encounter-enabled-encounter-1").click();
    await page.getByTestId("alert-rules-unverified").waitFor();
    await textAppears(page, "Saved rules could not be verified");
    await page.close();

    // My Class: the server's message replaces the axios status text, and only a
    // server-approved override opens the confirmation dialog.
    const myClass = await browser.newPage();
    const classState = freshState({
      passResponses: [
        { status: 409, json: { error: "2 passes today (limit 2).", code: "PASSPILOT_RULE_DAILY_LIMIT",
          rule: { kind: "daily_limit", count: 2, limit: 2 }, canOverride: true } },
        { status: 201, json: { pass: { id: "override-pass", ruleOverrideCode: "PASSPILOT_RULE_DAILY_LIMIT" } } },
        { status: 409, json: { error: "A pass isn't available for this student right now. Check with an administrator.",
          code: "PASSPILOT_RULE_NOT_AVAILABLE", canOverride: false } },
      ],
    });
    await installStaffMocks(myClass, classState);
    await myClass.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await myClass.getByText("Taylor Kim", { exact: true }).waitFor({ timeout: 30_000 });
    await myClass.getByTestId("button-checkout-student-two").click();
    await myClass.getByRole("menuitem", { name: "General/Restroom" }).click();
    const dialog = myClass.getByTestId("dialog-rule-override");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /2 passes today \(limit 2\)\./);
    await myClass.getByTestId("button-confirm-rule-override").click();
    await textAppears(myClass, "Pass created");
    assert.deepEqual(classState.passWrites.map((write) => write.overrideRuleCode ?? null), [null, "PASSPILOT_RULE_DAILY_LIMIT"]);
    assert.equal(classState.passWrites[1].studentId, "student-two");
    assert.equal(classState.passWrites[1].classId, "class-two");

    await myClass.getByTestId("button-checkout-student-two").click();
    await myClass.getByRole("menuitem", { name: "General/Restroom" }).click();
    await textAppears(myClass, "A pass isn't available for this student right now.");
    assert.equal(await myClass.getByTestId("dialog-rule-override").count(), 0, "no override without server approval");
    assert.doesNotMatch(await myClass.locator("body").innerText(), /Request failed with status code/);
    await myClass.close();

    // Kiosk: a 409 rule denial shows the student-facing message and never a code.
    const kiosk = await browser.newPage();
    await kiosk.addInitScript(() => window.localStorage.setItem("pp_kiosk_pin", "2468"));
    const kioskCheckouts = [];
    await kiosk.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/me") return route.fulfill({ status: 401, json: { error: "Not signed in" } });
      if (pathname === "/api/passpilot/kiosk/auth") return route.fulfill({ json: { token: "rules-kiosk-token", expiresInSeconds: 900 } });
      if (pathname === "/api/passpilot/kiosk/session") {
        return route.fulfill({ json: { kioskStyle: "simple", session: {
          id: "rules-session", status: "active", source: "classpilot_groups", classId: "rules-class", className: "Biology",
        } } });
      }
      if (pathname === "/api/passpilot/kiosk/snapshot") {
        return route.fulfill({ status: 200, headers: { ETag: '"rules-snapshot"' }, json: {
          revision: "rules-snapshot", kioskStyle: "simple",
          config: { source: "classpilot_groups", classId: "rules-class", className: "Biology" },
          session: { id: "rules-session", status: "active" },
          roster: { students: [{ id: "kiosk-student", firstName: "Ada", lastName: "Student" }] },
          passes: [],
        } });
      }
      if (pathname === "/api/passpilot/kiosk/checkout") {
        kioskCheckouts.push(request.postDataJSON());
        return route.fulfill({ status: 409, json: {
          error: "Bathroom is full right now. Please try again in a few minutes.", code: "PASSPILOT_RULE_DESTINATION_CAPACITY",
        } });
      }
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    });
    await kiosk.goto(`${baseUrl}/passpilot/kiosk/simple?school=rules-school`);
    await kiosk.getByText("Student, Ada", { exact: true }).waitFor({ timeout: 30_000 });
    await kiosk.getByText("Student, Ada", { exact: true }).click();
    await kiosk.getByRole("button", { name: "General/Restroom" }).click();
    await textAppears(kiosk, "Bathroom is full right now. Please try again in a few minutes.");
    assert.equal(kioskCheckouts.length, 1);
    assert.equal(kioskCheckouts[0].destination, "bathroom");
    const kioskText = await kiosk.locator("body").innerText();
    assert.doesNotMatch(kioskText, /PASSPILOT_RULE|\b409\b|capacity \(/, "students see no code, status or counts");
    await kiosk.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
});
