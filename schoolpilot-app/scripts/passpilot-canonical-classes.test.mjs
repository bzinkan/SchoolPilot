import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { preview } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "33333333-3333-4333-8333-333333333333";

const officialClasses = [
  {
    id: "class-one",
    classId: "class-one",
    source: "classpilot_groups",
    name: "Grade 3 Homeroom",
    gradeLevel: "3",
    periodLabel: "8:30 AM – 9:10 AM",
    studentCount: 15,
    teacherCount: 1,
    primaryTeacher: { id: "teacher-one", name: "Mary Englert", email: "mary@example.edu" },
    coTeachers: [],
  },
  {
    id: "class-two",
    classId: "class-two",
    source: "classpilot_groups",
    name: "Grade 4 Homeroom",
    gradeLevel: "4",
    periodLabel: "8:30 AM – 9:10 AM",
    studentCount: 2,
    teacherCount: 2,
    primaryTeacher: { id: "teacher-two", name: "Cayla Couch", email: "cayla@example.edu" },
    coTeachers: [{ id: "teacher-three", name: "Casey Helper", email: "casey@example.edu" }],
  },
];

function reportPass(id, firstName, destination) {
  const issuedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const returnedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    id,
    studentId: `student-${id}`,
    classpilotGroupId: "class-one",
    className: "Grade 3 Homeroom",
    classNameSnapshot: "Grade 3 Homeroom",
    student: { id: `student-${id}`, firstName, lastName: "Pagination" },
    teacher: { id: "teacher-one", firstName: "Mary", lastName: "Englert" },
    destination,
    status: "returned",
    issuedAt,
    returnedAt,
  };
}

function authResponse(role = "admin", school = {}) {
  return {
    user: {
      id: role === "teacher" ? "teacher-two" : "admin-one",
      email: `${role}@example.edu`,
      firstName: role === "teacher" ? "Cayla" : "Ada",
      lastName: role === "teacher" ? "Couch" : "Admin",
      isSuperAdmin: false,
    },
    token: "passpilot-canonical-browser-token",
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true, passPilot: true, goPilot: false },
    memberships: [{
      id: `${role}-membership`,
      schoolId: SCHOOL_ID,
      role,
      schoolName: school.name || "Browser Test School",
      schoolTimezone: school.schoolTimezone || "America/New_York",
    }],
  };
}

async function installApiMocks(page, state) {
  await page.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
  }, SCHOOL_ID);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (
      pathname.startsWith("/api/passpilot/classes")
      || pathname.startsWith("/api/passpilot/admin/class-migration")
      || pathname === "/api/passes"
      || pathname === "/api/passes/active"
      || pathname === "/api/passes/history"
      || pathname === "/api/kiosk-config"
    ) {
      state.classModelHeaders.push({
        pathname,
        value: request.headers()["x-passpilot-class-model"] || null,
      });
    }

    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: authResponse(state.role, state.settings) });
      return;
    }
    if (pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "browser-test-csrf" } });
      return;
    }
    if (pathname === "/api/passpilot/admin/settings") {
      if (request.method() === "GET") {
        state.settingsGetCount += 1;
        if (state.settingsVerificationFailuresRemaining > 0 && state.settingsWrites.length > 0) {
          state.settingsVerificationFailuresRemaining -= 1;
          await route.fulfill({
            status: 500,
            json: { error: "Saved settings could not be verified." },
          });
          return;
        }
        await route.fulfill({ json: state.settings });
        return;
      }
      if (request.method() === "PATCH") {
        const payload = request.postDataJSON();
        state.settingsWrites.push(payload);
        if (state.settingsSaveFailuresRemaining > 0) {
          state.settingsSaveFailuresRemaining -= 1;
          await route.fulfill({
            status: 500,
            json: { error: "School settings could not be saved." },
          });
          return;
        }
        if (payload.expectedRevision !== state.settings.revision) {
          await route.fulfill({
            status: 409,
            json: {
              error: "Settings were changed by another administrator. Load the latest settings and try again.",
              code: "PASSPILOT_SETTINGS_REVISION_CONFLICT",
              current: state.settings,
            },
          });
          return;
        }
        const updates = { ...payload };
        delete updates.expectedRevision;
        delete updates.kioskPin;
        state.settings = {
          ...state.settings,
          ...updates,
          ...(payload.kioskPin ? { kioskPinConfigured: true } : {}),
          revision: state.settings.revision + 1,
        };
        await new Promise((resolve) => setTimeout(resolve, 75));
        await route.fulfill({ json: state.settings });
        return;
      }
    }
    if (pathname === "/api/passpilot/classes") {
      if (url.searchParams.get("scope") === "history") {
        const historyClasses = state.source === "classpilot_groups"
          ? [
              officialClasses[0],
              {
                id: "archived-class",
                classId: "archived-class",
                source: "classpilot_groups",
                name: "Archived Science",
                status: "archived",
                studentCount: 0,
                filterKey: { type: "classId", value: "archived-class" },
              },
              {
                id: "legacy-history",
                legacyGradeId: "legacy-history",
                source: "legacy_grades",
                name: "Legacy Grade 2",
                status: "archived",
                historyOnly: true,
                migrationState: "history_only",
                studentCount: 0,
                filterKey: { type: "gradeId", value: "legacy-history" },
              },
            ]
          : [{
              id: "legacy-grade",
              legacyGradeId: "legacy-grade",
              source: "legacy_grades",
              name: "Legacy Advisory",
              status: "active",
              studentCount: 1,
              filterKey: { type: "gradeId", value: "legacy-grade" },
            }];
        await route.fulfill({ json: { source: state.source, classes: historyClasses } });
        return;
      }
      const classes = state.source === "classpilot_groups"
        ? (state.emptyCanonical
          ? []
          : (state.role === "teacher" ? [officialClasses[1]] : officialClasses))
        : [{ id: "legacy-grade", classId: "legacy-grade", name: "Legacy Advisory", studentCount: 1 }];
      await route.fulfill({ json: { source: state.source, classes } });
      return;
    }
    if (pathname === "/api/passpilot/classes/class-two/students") {
      state.rosterRequests.push(pathname);
      if (state.rosterFailuresRemaining > 0) {
        state.rosterFailuresRemaining -= 1;
        await route.fulfill({
          status: 500,
          json: { error: "Canonical roster temporarily unavailable" },
        });
        return;
      }
      await route.fulfill({
        json: {
          source: "classpilot_groups",
          class: officialClasses[1],
          students: [{ id: "student-two", firstName: "Taylor", lastName: "Student", studentIdNumber: "2002" }],
        },
      });
      return;
    }
    if (pathname === "/api/passes" && request.method() === "POST") {
      state.passWrites.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { id: "pass-one" } });
      return;
    }
    if (pathname === "/api/passes/active") {
      await route.fulfill({ json: { passes: [] } });
      return;
    }
    if (pathname === "/api/passes/history") {
      state.passHistoryRequests.push(url.search);
      if (state.historyFailuresRemaining > 0) {
        state.historyFailuresRemaining -= 1;
        await route.fulfill({
          status: 500,
          json: { error: "Pass history temporarily unavailable" },
        });
        return;
      }
      if (state.historyPages) {
        const cursor = url.searchParams.get("cursor") || "first";
        const page = state.historyPages[cursor];
        if (!page) {
          await route.fulfill({ status: 400, json: { error: "Unexpected history cursor" } });
          return;
        }
        await route.fulfill({ json: page });
        return;
      }
      await route.fulfill({ json: { passes: [] } });
      return;
    }
    if (pathname === "/api/kiosk-config") {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON();
        state.kioskWrites.push(payload);
        state.kioskClassId = state.source === "classpilot_groups"
          ? (payload.classId || null)
          : (payload.gradeId || null);
      }
      await route.fulfill({
        json: {
          source: state.source,
          classId: state.source === "classpilot_groups" ? state.kioskClassId : null,
          gradeId: state.source === "legacy_grades" ? state.kioskClassId : null,
        },
      });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/sessions/mine") {
      await route.fulfill({ json: { sessions: state.kioskSessions } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/sessions/claim") {
      const payload = request.postDataJSON();
      state.kioskClaims.push(payload);
      const session = {
        id: `kiosk-session-${state.kioskClaims.length}`,
        status: "active",
        classId: payload.classId,
        className: "Class Two",
      };
      state.kioskSessions = [...state.kioskSessions, session];
      await route.fulfill({ json: { session } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/sessions/retarget") {
      const payload = request.postDataJSON();
      state.kioskRetargets.push(payload);
      state.kioskSessions = state.kioskSessions.map((session) => ({
        ...session,
        classId: payload.classId,
      }));
      await route.fulfill({ json: { updated: state.kioskSessions.length, sessions: state.kioskSessions } });
      return;
    }
    if (pathname.startsWith("/api/passpilot/kiosk/sessions/") && request.method() === "DELETE") {
      const sessionId = pathname.split("/").pop();
      state.kioskSessions = state.kioskSessions.filter((session) => session.id !== sessionId);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (pathname === "/api/grades" || pathname === "/api/my-classes") {
      await route.fulfill({ json: { grades: [{ id: "legacy-grade", name: "Legacy Advisory" }] } });
      return;
    }
    if (pathname === "/api/grades/available") {
      await route.fulfill({ json: { grades: [] } });
      return;
    }
    if (pathname === "/api/students") {
      await route.fulfill({ json: { students: [{ id: "legacy-student", firstName: "Legacy", lastName: "Student", gradeId: "legacy-grade" }] } });
      return;
    }
    if (pathname === "/api/admin/attendance") {
      await route.fulfill({ json: { records: [] } });
      return;
    }
    if (pathname === "/api/classpilot/admin/classes") {
      await route.fulfill({ json: { classes: [] } });
      return;
    }
    if (pathname === "/api/classpilot/admin/staff") {
      await route.fulfill({ json: { staff: [] } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });
}

function freshState(overrides = {}) {
  return {
    role: "admin",
    source: "classpilot_groups",
    rosterRequests: [],
    passWrites: [],
    classModelHeaders: [],
    passHistoryRequests: [],
    kioskClassId: "class-two",
    kioskWrites: [],
    kioskSessions: [],
    kioskClaims: [],
    kioskRetargets: [],
    emptyCanonical: false,
    rosterFailuresRemaining: 0,
    historyFailuresRemaining: 0,
    historyPages: null,
    settings: {
      name: "Browser Test School",
      schoolTimezone: "America/New_York",
      kioskEnabled: true,
      kioskRequiresApproval: false,
      kioskPinConfigured: true,
      revision: 4,
    },
    settingsGetCount: 0,
    settingsWrites: [],
    settingsSaveFailuresRemaining: 0,
    settingsVerificationFailuresRemaining: 0,
    ...overrides,
  };
}

test("cross-product pass widgets advertise canonical capability and do not mask load errors as zero passes", async () => {
  for (const relativePath of [
    "src/shell/widgets/PassWidget.jsx",
    "src/products/classpilot/components/sidebar/PassPilotMiniView.jsx",
  ]) {
    const source = await readFile(path.join(APP_ROOT, relativePath), "utf8");
    assert.match(source, /passPilotClassRequest/);
    assert.match(source, /Passes unavailable/);
    assert.doesNotMatch(source, /api\.get\(['"]\/passpilot\/passes\/active/);
  }
});

test("PassPilot canonical classes use the persisted source and preserve the legacy path before cutover", { timeout: 90_000 }, async () => {
  const server = await preview({
    root: APP_ROOT,
    logLevel: "error",
    preview: { host: "127.0.0.1", port: 0 },
  });
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite preview must listen on a local TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const installCreateSchoolMocks = async (page, payloads) => {
      await page.route("**/api/**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/auth/me") {
          await route.fulfill({
            json: {
              user: {
                id: "super-admin-one",
                email: "super@example.edu",
                firstName: "Super",
                lastName: "Admin",
                isSuperAdmin: true,
              },
              token: "create-school-browser-token",
              memberships: [],
              licenses: {},
            },
          });
          return;
        }
        if (pathname === "/api/super-admin/schools" && request.method() === "POST") {
          payloads.push(request.postDataJSON());
          await route.fulfill({
            status: 201,
            json: { school: { id: `created-school-${payloads.length}` } },
          });
          return;
        }
        await route.fulfill({ status: 200, json: {} });
      });
    };

    const singleProductPayloads = [];
    const singleProductPage = await browser.newPage();
    await installCreateSchoolMocks(singleProductPage, singleProductPayloads);
    await singleProductPage.goto(`${baseUrl}/super-admin/schools/new`);
    await singleProductPage.locator('input[name="name"]').fill("Single Product School");
    await singleProductPage.locator('input[name="domain"]').fill("single.example.edu");
    await singleProductPage.getByRole("button", { name: /^ClassPilot/ }).click();
    await singleProductPage.getByRole("button", { name: "Create School", exact: true }).click();
    await singleProductPage.getByRole("heading", { name: "School Created!", exact: true }).waitFor();
    assert.equal(singleProductPayloads.length, 1);
    assert.equal(
      Object.hasOwn(singleProductPayloads[0], "passpilotClassModelAcknowledged"),
      false,
      "single-product creation must omit the canonical-only acknowledgement field",
    );

    const dualProductPayloads = [];
    const dualProductPage = await browser.newPage();
    await installCreateSchoolMocks(dualProductPage, dualProductPayloads);
    await dualProductPage.goto(`${baseUrl}/super-admin/schools/new`);
    await dualProductPage.locator('input[name="name"]').fill("Dual Product School");
    await dualProductPage.locator('input[name="domain"]').fill("dual.example.edu");
    await dualProductPage.getByRole("button", { name: /^ClassPilot/ }).click();
    await dualProductPage.getByRole("button", { name: /^PassPilot/ }).click();
    const classModelAcknowledgement = dualProductPage.getByRole("checkbox", {
      name: /Use ClassPilot classes in PassPilot/,
    });
    await classModelAcknowledgement.waitFor();
    await dualProductPage.getByRole("button", { name: "Create School", exact: true }).click();
    await dualProductPage.getByText(/Confirm that every PassPilot web, kiosk, and installed app/).waitFor();
    assert.equal(dualProductPayloads.length, 0);
    await classModelAcknowledgement.check();
    await dualProductPage.getByRole("button", { name: "Create School", exact: true }).click();
    await dualProductPage.getByRole("heading", { name: "School Created!", exact: true }).waitFor();
    assert.equal(dualProductPayloads.length, 1);
    assert.equal(dualProductPayloads[0].passpilotClassModelAcknowledged, true);

    const canonicalPage = await browser.newPage();
    const canonicalState = freshState();
    await installApiMocks(canonicalPage, canonicalState);
    await canonicalPage.goto(`${baseUrl}/passpilot/classes`);

    await canonicalPage.getByTestId("canonical-passpilot-classes").waitFor();
    await canonicalPage.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    assert.equal(await canonicalPage.getByText("Managed in ClassPilot", { exact: true }).count(), 3);
    await canonicalPage.getByText("Mary Englert", { exact: true }).waitFor();
    await canonicalPage.getByText("15 students", { exact: true }).waitFor();
    assert.equal(await canonicalPage.getByRole("button", { name: /Add Class/i }).count(), 0);
    assert.equal(await canonicalPage.getByRole("button", { name: /Delete/i }).count(), 0);
    assert.match(
      await canonicalPage.getByTestId("manage-classpilot-classes").getAttribute("href"),
      /^\/classpilot\/admin\/classes\?returnTo=/,
    );

    await canonicalPage.reload();
    await canonicalPage.getByTestId("canonical-passpilot-classes").waitFor();
    assert.equal(new URL(canonicalPage.url()).pathname, "/passpilot/classes");

    await canonicalPage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await canonicalPage.getByText("Taylor Student", { exact: true }).waitFor();
    // No claimed kiosks yet: Send to Kiosk opens the claim-code dialog.
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).waitFor();
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").fill("123456");
    await canonicalPage.getByTestId("button-submit-kiosk-claim").click();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();
    assert.deepEqual(canonicalState.kioskClaims[0], { claimCode: "123456", classId: "class-two" });
    // With a claimed kiosk, the button is an explicit menu: retarget or enter a code.
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("menu-send-to-kiosks").click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Kiosk Updated"));
    assert.deepEqual(canonicalState.kioskRetargets[0], { classId: "class-two" });
    // The menu always offers direct code entry as well.
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("menu-enter-kiosk-code").click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").waitFor();
    await canonicalPage.getByTestId("button-cancel-kiosk-claim").click();
    // Releasing via the kiosk chip returns to the unclaimed state.
    await canonicalPage.getByLabel("Release kiosk").click();
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).waitFor();
    // Re-claim so the reload path below still sees an active kiosk.
    await canonicalPage.getByRole("button", { name: "Send to Kiosk", exact: true }).click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").fill("654321");
    await canonicalPage.getByTestId("button-submit-kiosk-claim").click();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();

    // The Kiosk Mode dropdown claims student-device kiosks from anywhere,
    // with an explicit class picker (no class context in the top bar).
    await canonicalPage.getByRole("button", { name: "Kiosk Mode" }).click();
    await canonicalPage.getByTestId("menu-claim-kiosk").click();
    await canonicalPage.getByTestId("select-kiosk-claim-class").click();
    await canonicalPage.getByRole("option", { name: "Grade 4 Homeroom", exact: true }).click();
    await canonicalPage.getByTestId("input-kiosk-claim-code").fill("222333");
    await canonicalPage.getByTestId("button-submit-kiosk-claim").click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Kiosk Claimed"));
    assert.deepEqual(canonicalState.kioskClaims[2], { claimCode: "222333", classId: "class-two" });
    // Release one of the two class-two kiosks; the survivor keeps On Kiosk.
    await canonicalPage.getByLabel("Release kiosk").last().click();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();

    await canonicalPage.reload();
    await canonicalPage.getByText("Taylor Student", { exact: true }).waitFor();
    await canonicalPage.getByRole("button", { name: "On Kiosk", exact: true }).waitFor();
    assert.deepEqual(canonicalState.rosterRequests, [
      "/api/passpilot/classes/class-two/students",
      "/api/passpilot/classes/class-two/students",
    ]);
    await canonicalPage.getByTestId("button-checkout-student-two").click();
    await canonicalPage.getByRole("menuitem", { name: "General/Restroom" }).click();
    await canonicalPage.waitForFunction(() => document.body.textContent.includes("Pass created"));
    assert.equal(canonicalState.passWrites.length, 1);
    assert.equal(canonicalState.passWrites[0].classId, "class-two");
    assert.equal(canonicalState.passWrites[0].gradeId, undefined);
    for (const requiredPath of [
      "/api/passpilot/classes",
      "/api/passpilot/classes/class-two/students",
      "/api/passes",
    ]) {
      assert.ok(
        canonicalState.classModelHeaders.some(
          (entry) => entry.pathname === requiredPath && entry.value === "classpilot-groups-v1",
        ),
        `${requiredPath} must advertise the canonical class model capability`,
      );
    }

    const rosterFailurePage = await browser.newPage();
    const rosterFailureState = freshState({ rosterFailuresRemaining: 2 });
    await installApiMocks(rosterFailurePage, rosterFailureState);
    await rosterFailurePage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await rosterFailurePage.getByRole("heading", { name: "Class roster couldn’t be loaded" }).waitFor();
    assert.equal(
      await rosterFailurePage.getByText(/This class has no students/).count(),
      0,
      "a failed canonical roster must not render the empty-roster state",
    );
    assert.equal(await rosterFailurePage.getByText("Taylor Student", { exact: true }).count(), 0);
    await rosterFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await rosterFailurePage.getByText("Taylor Student", { exact: true }).waitFor();
    assert.equal(rosterFailureState.rosterRequests.length, 3);

    const myClassHistoryFailurePage = await browser.newPage();
    const myClassHistoryFailureState = freshState({ historyFailuresRemaining: 2 });
    await installApiMocks(myClassHistoryFailurePage, myClassHistoryFailureState);
    await myClassHistoryFailurePage.goto(`${baseUrl}/passpilot/my-class?classId=class-two`);
    await myClassHistoryFailurePage.getByText("Taylor Student", { exact: true }).waitFor();
    await myClassHistoryFailurePage.getByRole("button", { name: "Pass Data", exact: true }).click();
    await myClassHistoryFailurePage.getByText("Pass history couldn’t be loaded.", { exact: true }).waitFor();
    assert.equal(
      await myClassHistoryFailurePage.getByRole("button", { name: "Export CSV", exact: true }).count(),
      0,
      "My Class must not export a failed or partial history load",
    );
    assert.equal(await myClassHistoryFailurePage.getByText(/Total:/).count(), 0);
    await myClassHistoryFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await myClassHistoryFailurePage.getByText(/Total:/).waitFor();
    assert.equal(myClassHistoryFailureState.passHistoryRequests.length, 3);

    const legacyPage = await browser.newPage();
    const legacyState = freshState({ source: "legacy_grades" });
    await installApiMocks(legacyPage, legacyState);
    await legacyPage.goto(`${baseUrl}/passpilot/classes`);
    await legacyPage.getByRole("button", { name: "Add Class", exact: true }).waitFor();
    await legacyPage.getByText("Legacy Advisory", { exact: true }).waitFor();
    assert.equal(await legacyPage.getByTestId("canonical-passpilot-classes").count(), 0);

    for (const source of ["legacy_grades", "classpilot_groups"]) {
      const removedClassSourcePage = await browser.newPage();
      const removedClassSourceState = freshState({ source });
      await installApiMocks(removedClassSourcePage, removedClassSourceState);
      await removedClassSourcePage.goto(`${baseUrl}/passpilot/setup?section=class-source`);
      await removedClassSourcePage.waitForFunction(() => {
        const current = new URL(window.location.href);
        return current.pathname === "/passpilot/setup" && !current.searchParams.has("section");
      });
      const teachersTab = removedClassSourcePage.getByRole("tab", { name: "Teachers", exact: true });
      await teachersTab.waitFor();
      assert.equal(await teachersTab.getAttribute("aria-selected"), "true");
      assert.equal(
        await removedClassSourcePage.getByRole("tab", { name: "Class Source", exact: true }).count(),
        0,
      );
      assert.equal(await removedClassSourcePage.getByTestId("passpilot-class-source-setup").count(), 0);
      assert.equal(
        removedClassSourceState.classModelHeaders.filter(
          (entry) => entry.pathname.startsWith("/api/passpilot/admin/class-migration"),
        ).length,
        0,
        "the removed Class Source surface must not call migration APIs",
      );
      assert.equal(
        await removedClassSourcePage.getByRole("tab", { name: "Classes", exact: true }).count(),
        source === "legacy_grades" ? 1 : 0,
      );
      assert.equal(
        await removedClassSourcePage.getByRole("tab", { name: "Class Assignments", exact: true }).count(),
        source === "legacy_grades" ? 1 : 0,
      );
      await removedClassSourcePage.close();
    }

    const legacyClassSourceHashPage = await browser.newPage();
    const legacyClassSourceHashState = freshState({ source: "legacy_grades" });
    await installApiMocks(legacyClassSourceHashPage, legacyClassSourceHashState);
    await legacyClassSourceHashPage.goto(`${baseUrl}/passpilot#setup/class-source`);
    await legacyClassSourceHashPage.waitForFunction(() => {
      const current = new URL(window.location.href);
      return current.pathname === "/passpilot/setup"
        && !current.searchParams.has("section")
        && current.hash === "";
    });
    assert.equal(
      await legacyClassSourceHashPage.getByRole("tab", { name: "Class Source", exact: true }).count(),
      0,
    );
    assert.equal(
      legacyClassSourceHashState.classModelHeaders.filter(
        (entry) => entry.pathname.startsWith("/api/passpilot/admin/class-migration"),
      ).length,
      0,
    );

    const settingsPage = await browser.newPage();
    const settingsState = freshState({ source: "legacy_grades" });
    await installApiMocks(settingsPage, settingsState);
    await settingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const kioskSwitch = settingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await kioskSwitch.waitFor();
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "true");
    assert.equal(
      await settingsPage.getByRole("switch", { name: "Kiosk Requires Approval", exact: true }).count(),
      0,
      "the unenforced approval setting must not be presented as an operational control",
    );

    await settingsPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "false");
    await kioskSwitch.press("Space");
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "true");
    await kioskSwitch.press("Space");
    assert.equal(await kioskSwitch.getAttribute("aria-checked"), "false");
    await settingsPage.getByLabel("School Name", { exact: true }).fill("Verified Kiosk School");
    // The timezone field is a Radix Select (combobox button), not a native <select>.
    await settingsPage.getByLabel("School Timezone", { exact: true }).click();
    await settingsPage.getByRole("option", { name: "Central (America/Chicago)", exact: true }).click();

    const saveSettingsButton = settingsPage.getByRole("button", { name: "Save Settings", exact: true });
    await saveSettingsButton.evaluate((button) => {
      button.click();
      button.click();
    });
    await settingsPage.getByText("Settings saved", { exact: true }).waitFor();
    assert.equal(settingsState.settingsWrites.length, 1, "a double-click must issue one settings write");
    assert.deepEqual(settingsState.settingsWrites[0], {
      expectedRevision: 4,
      name: "Verified Kiosk School",
      schoolTimezone: "America/Chicago",
      kioskEnabled: false,
    });
    assert.ok(settingsState.settingsGetCount >= 2, "save must be verified through an authoritative GET");
    await settingsPage.locator("header").getByText("Verified Kiosk School", { exact: true }).waitFor();

    await settingsPage.reload();
    const reloadedKioskSwitch = settingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await reloadedKioskSwitch.waitFor();
    assert.equal(await reloadedKioskSwitch.getAttribute("aria-checked"), "false");
    assert.equal(
      (await settingsPage.getByLabel("School Timezone", { exact: true }).textContent()).trim(),
      "Central (America/Chicago)",
    );
    assert.equal(
      await settingsPage.getByLabel("School Name", { exact: true }).inputValue(),
      "Verified Kiosk School",
    );
    assert.equal(settingsState.settingsWrites.length, 1, "reload must not write settings");

    const failedSettingsPage = await browser.newPage();
    const failedSettingsState = freshState({
      source: "legacy_grades",
      settingsSaveFailuresRemaining: 1,
    });
    await installApiMocks(failedSettingsPage, failedSettingsState);
    await failedSettingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const failedDraftSwitch = failedSettingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await failedDraftSwitch.waitFor();
    await failedSettingsPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    await failedSettingsPage.getByRole("button", { name: "Save Settings", exact: true }).click();
    await failedSettingsPage.getByText("School settings could not be saved.", { exact: true }).waitFor();
    assert.equal(await failedDraftSwitch.getAttribute("aria-checked"), "false");
    assert.equal(failedSettingsState.settings.kioskEnabled, true);
    assert.equal(await failedSettingsPage.getByText("Settings saved", { exact: true }).count(), 0);

    const unverifiedSettingsPage = await browser.newPage();
    const unverifiedSettingsState = freshState({
      source: "legacy_grades",
      settingsVerificationFailuresRemaining: 1,
    });
    await installApiMocks(unverifiedSettingsPage, unverifiedSettingsState);
    await unverifiedSettingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const unverifiedSwitch = unverifiedSettingsPage.getByRole("switch", {
      name: "Kiosk Mode Enabled",
      exact: true,
    });
    await unverifiedSwitch.waitFor();
    await unverifiedSettingsPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    await unverifiedSettingsPage.getByRole("button", { name: "Save Settings", exact: true }).click();
    await unverifiedSettingsPage.getByText(
      "Settings were saved, but the confirmation could not be loaded. Verify the saved settings before making another change.",
      { exact: true },
    ).waitFor();
    assert.equal(await unverifiedSettingsPage.getByText("Settings saved", { exact: true }).count(), 0);
    assert.equal(await unverifiedSwitch.getAttribute("aria-checked"), "false");
    assert.equal(unverifiedSettingsState.settingsWrites.length, 1);
    await unverifiedSettingsPage.getByRole("button", { name: "Verify Saved Settings", exact: true }).click();
    await unverifiedSettingsPage.getByText("Settings saved", { exact: true }).waitFor();
    assert.equal(unverifiedSettingsState.settingsWrites.length, 1, "verification retry must not repeat the write");
    assert.equal(await unverifiedSwitch.getAttribute("aria-checked"), "false");

    const conflictSettingsPage = await browser.newPage();
    const conflictSettingsState = freshState({ source: "legacy_grades" });
    await installApiMocks(conflictSettingsPage, conflictSettingsState);
    await conflictSettingsPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const conflictName = conflictSettingsPage.getByLabel("School Name", { exact: true });
    await conflictName.waitFor();
    await conflictName.fill("Local Unsaved School Name");
    conflictSettingsState.settings = {
      ...conflictSettingsState.settings,
      name: "Other Administrator School Name",
      kioskEnabled: false,
      revision: conflictSettingsState.settings.revision + 1,
    };
    await conflictSettingsPage.getByRole("button", { name: "Save Settings", exact: true }).click();
    await conflictSettingsPage.getByText(
      "Settings were changed by another administrator. Load the latest settings and try again.",
      { exact: true },
    ).waitFor();
    assert.equal(await conflictName.inputValue(), "Local Unsaved School Name");
    assert.equal(await conflictSettingsPage.getByText("Settings saved", { exact: true }).count(), 0);
    assert.equal(conflictSettingsState.settingsWrites.length, 1);
    await conflictSettingsPage.getByRole("button", { name: "Load latest settings", exact: true }).click();
    await conflictSettingsPage.waitForFunction(() => (
      document.querySelector("#passpilot-school-name")?.value === "Other Administrator School Name"
    ));
    assert.equal(
      await conflictSettingsPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true }).getAttribute("aria-checked"),
      "false",
    );

    const newKioskPage = await browser.newPage();
    const newKioskState = freshState({
      source: "legacy_grades",
      settings: {
        name: "Browser Test School",
        schoolTimezone: "America/New_York",
        kioskEnabled: false,
        kioskRequiresApproval: false,
        kioskPinConfigured: false,
        revision: 9,
      },
    });
    await installApiMocks(newKioskPage, newKioskState);
    await newKioskPage.goto(`${baseUrl}/passpilot/setup?section=settings`);
    const newKioskSwitch = newKioskPage.getByRole("switch", { name: "Kiosk Mode Enabled", exact: true });
    await newKioskSwitch.waitFor();
    await newKioskPage.getByText("Kiosk Mode Enabled", { exact: true }).click();
    const newKioskSave = newKioskPage.getByRole("button", { name: "Save Settings", exact: true });
    assert.equal(await newKioskSave.isDisabled(), true);
    await newKioskPage.getByText("A kiosk PIN is required while Kiosk Mode is enabled.", { exact: true }).waitFor();
    await newKioskPage.getByLabel("Kiosk PIN", { exact: true }).fill("12ab34");
    assert.equal(await newKioskPage.getByLabel("Kiosk PIN", { exact: true }).inputValue(), "1234");
    assert.equal(await newKioskSave.isEnabled(), true);
    await newKioskSave.click();
    await newKioskPage.getByText("Settings saved", { exact: true }).waitFor();
    assert.deepEqual(newKioskState.settingsWrites[0], {
      expectedRevision: 9,
      kioskEnabled: true,
      kioskPin: "1234",
    });
    assert.equal(newKioskState.settings.kioskPinConfigured, true);

    const teacherPage = await browser.newPage();
    const teacherState = freshState({ role: "teacher" });
    await installApiMocks(teacherPage, teacherState);
    await teacherPage.goto(`${baseUrl}/passpilot/setup`);
    await teacherPage.waitForURL("**/passpilot/my-class**");
    assert.equal(new URL(teacherPage.url()).pathname, "/passpilot/my-class");

    const officePage = await browser.newPage();
    const officeState = freshState({ role: "office_staff", emptyCanonical: true });
    await installApiMocks(officePage, officeState);
    await officePage.goto(`${baseUrl}/passpilot/classes`);
    await officePage.getByRole("heading", { name: "Classes", exact: true }).waitFor();
    await officePage.getByText("No official classes yet", { exact: true }).waitFor();
    assert.equal(await officePage.getByText("No ClassPilot classes are assigned to you", { exact: true }).count(), 0);
    assert.equal(await officePage.getByTestId("manage-classpilot-classes").count(), 0);
    await officePage.getByRole("link", { name: "Reports" }).click();
    await officePage.waitForURL("**/passpilot/reports");
    const reportClassSelect = officePage.getByLabel("Class");
    await reportClassSelect.click();
    await officePage.getByText("Legacy class history", { exact: true }).waitFor();
    const legacyHistoryRequest = officePage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("gradeId") === "legacy-history";
    });
    await officePage.getByRole("option", { name: "Legacy Grade 2 (History only)" }).click();
    await legacyHistoryRequest;
    await reportClassSelect.click();
    const archivedClassRequest = officePage.waitForRequest((request) => {
      const requestUrl = new URL(request.url());
      return requestUrl.pathname === "/api/passes/history"
        && requestUrl.searchParams.get("classId") === "archived-class";
    });
    await officePage.getByRole("option", { name: "Archived Science (Archived)" }).click();
    await archivedClassRequest;

    const reportFailurePage = await browser.newPage();
    const reportFailureState = freshState({ historyFailuresRemaining: 2 });
    await installApiMocks(reportFailurePage, reportFailureState);
    await reportFailurePage.goto(`${baseUrl}/passpilot/reports`);
    await reportFailurePage.getByRole("heading", { name: "Report data couldn’t be loaded" }).waitFor();
    assert.equal(
      await reportFailurePage.getByText("Total Passes", { exact: true }).count(),
      0,
      "a failed history page must not render false zero totals",
    );
    assert.equal(
      await reportFailurePage.getByRole("button", { name: "Export CSV", exact: true }).count(),
      0,
      "partial or failed history must not expose export",
    );
    assert.equal(await reportFailurePage.getByText("No activity today", { exact: true }).count(), 0);
    await reportFailurePage.getByRole("button", { name: "Retry", exact: true }).click();
    await reportFailurePage.getByText("Total Passes", { exact: true }).waitFor();
    assert.equal(reportFailureState.passHistoryRequests.length, 3);

    const paginatedReportPage = await browser.newPage();
    const paginatedReportState = freshState({
      historyPages: {
        first: {
          passes: [reportPass("page-one", "Page One", "bathroom")],
          hasMore: true,
          nextCursor: "page-2",
        },
        "page-2": {
          passes: [reportPass("page-two", "Page Two", "nurse")],
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    await installApiMocks(paginatedReportPage, paginatedReportState);
    await paginatedReportPage.goto(`${baseUrl}/passpilot/reports`);
    const totalPassesLabel = paginatedReportPage.getByText("Total Passes", { exact: true });
    await totalPassesLabel.waitFor();
    assert.match(
      (await totalPassesLabel.locator("..").textContent()) || "",
      /2\s*Total Passes/,
      "report totals must include every history page",
    );
    assert.equal(paginatedReportState.passHistoryRequests.length, 2);
    const firstHistoryRequest = new URLSearchParams(paginatedReportState.passHistoryRequests[0]);
    const secondHistoryRequest = new URLSearchParams(paginatedReportState.passHistoryRequests[1]);
    assert.equal(firstHistoryRequest.get("limit"), "500");
    assert.equal(firstHistoryRequest.get("cursor"), null);
    assert.equal(secondHistoryRequest.get("limit"), "500");
    assert.equal(secondHistoryRequest.get("cursor"), "page-2");

    const downloadPromise = paginatedReportPage.waitForEvent("download");
    await paginatedReportPage.getByRole("button", { name: "Export CSV", exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert.ok(downloadPath, "CSV download must have a readable local path");
    const csv = await readFile(downloadPath, "utf8");
    assert.match(csv, /Page One Pagination/);
    assert.match(csv, /Page Two Pagination/);
    await paginatedReportPage.getByText("Export Complete", { exact: true }).waitFor();

    const staleKioskPage = await browser.newPage();
    await staleKioskPage.addInitScript(() => {
      window.localStorage.setItem("pp_kiosk_pin", "1234");
    });
    const staleKioskHeaders = [];
    await staleKioskPage.route("**/api/passpilot/kiosk/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      staleKioskHeaders.push(request.headers()["x-passpilot-class-model"] || null);
      if (pathname.endsWith("/session")) {
        // Legacy server without per-device kiosk sessions: the kiosk must
        // feature-detect the 404 and stay on the school-global flow.
        await route.fulfill({ status: 404, json: { error: "Not found" } });
        return;
      }
      if (pathname.endsWith("/grades")) {
        await route.fulfill({ json: { source: "classpilot_groups", classes: [] } });
        return;
      }
      if (pathname.endsWith("/config")) {
        await route.fulfill({
          status: 409,
          json: {
            source: "classpilot_groups",
            code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
            error: "The configured kiosk class is no longer active.",
          },
        });
        return;
      }
      await route.fulfill({ status: 500, json: { error: "Unexpected kiosk request" } });
    });
    await staleKioskPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}`);
    await staleKioskPage.getByRole("heading", { name: "Kiosk Class Required" }).waitFor();
    await staleKioskPage.getByText(/configured ClassPilot class is no longer active/).waitFor();
    assert.equal(await staleKioskPage.getByText("No students in this class", { exact: true }).count(), 0);
    assert.ok(staleKioskHeaders.every((value) => value === "classpilot-groups-v1"));

    await officePage.goto(`${baseUrl}/passpilot/setup`);
    await officePage.waitForURL("**/passpilot/my-class**");

    const roundTripPage = await browser.newPage();
    await installApiMocks(roundTripPage, freshState());
    await roundTripPage.goto(`${baseUrl}/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses`);
    const backToPassPilot = roundTripPage.getByTestId("button-back-passpilot");
    await backToPassPilot.waitFor();
    await backToPassPilot.click();
    await roundTripPage.waitForURL("**/passpilot/classes");
    await roundTripPage.goto(`${baseUrl}/classpilot/admin/classes?returnTo=https%3A%2F%2Fexample.invalid`);
    assert.equal(await roundTripPage.getByTestId("button-back-passpilot").count(), 0);
  } finally {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
