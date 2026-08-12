import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { preview } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "44444444-4444-4444-8444-444444444444";

const sharedStudent = {
  id: "student-shared",
  firstName: "Shared",
  lastName: "Student",
  name: "Shared Student",
  studentIdNumber: "4001",
  gradeLevel: "5",
  gradeId: "class-a",
};

const secondStudent = {
  id: "student-second",
  firstName: "Second",
  lastName: "Student",
  name: "Second Student",
  studentIdNumber: "4002",
  gradeLevel: "5",
  gradeId: "class-b",
};

function authResponse() {
  return {
    user: {
      id: "admin-one",
      email: "admin@example.edu",
      firstName: "Ada",
      lastName: "Admin",
      isSuperAdmin: false,
    },
    token: "passpilot-legacy-multiclass-token",
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: false, passPilot: true, goPilot: false },
    memberships: [{
      id: "admin-membership",
      schoolId: SCHOOL_ID,
      role: "admin",
      schoolName: "Legacy Multi-Class School",
      schoolTimezone: "America/New_York",
      kioskName: "Front Hall",
    }],
  };
}

function freshState() {
  return {
    classes: [
      { id: "class-a", classId: "class-a", source: "legacy_grades", name: "Fifth Grade", studentCount: 1 },
      { id: "class-b", classId: "class-b", source: "legacy_grades", name: "Science Lab", studentCount: 1 },
    ],
    rosters: new Map([
      ["class-a", [sharedStudent]],
      ["class-b", [secondStudent]],
    ]),
    membershipWrites: [],
    membershipDeletes: [],
    passWrites: [],
    kioskWrites: [],
    kioskClassId: "class-b",
    kioskAvailable: true,
    kioskGradeRequests: 0,
    kioskConfigFailures: 0,
  };
}

async function installApiMocks(context, state) {
  await context.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
    window.localStorage.setItem("pp_kiosk_pin", "1234");
  }, SCHOOL_ID);

  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: authResponse() });
      return;
    }
    if (pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "legacy-multiclass-csrf" } });
      return;
    }
    if (pathname === "/api/passpilot/classes") {
      await route.fulfill({ json: { source: "legacy_grades", classes: state.classes } });
      return;
    }
    if (pathname === "/api/grades" && request.method() === "GET") {
      await route.fulfill({ json: state.classes.map(({ id, name }) => ({ id, name })) });
      return;
    }
    if (pathname === "/api/students" && request.method() === "GET") {
      await route.fulfill({ json: [sharedStudent, secondStudent] });
      return;
    }

    const rosterMatch = pathname.match(/^\/api\/passpilot\/classes\/([^/]+)\/students(?:\/([^/]+))?$/);
    if (rosterMatch) {
      const classId = decodeURIComponent(rosterMatch[1]);
      const studentId = rosterMatch[2] ? decodeURIComponent(rosterMatch[2]) : null;
      if (request.method() === "GET") {
        await route.fulfill({ json: { source: "legacy_grades", students: state.rosters.get(classId) || [] } });
        return;
      }
      if (request.method() === "POST") {
        const payload = request.postDataJSON();
        state.membershipWrites.push({ classId, ...payload });
        const roster = state.rosters.get(classId) || [];
        for (const id of payload.studentIds || []) {
          const student = [sharedStudent, secondStudent].find((item) => item.id === id);
          if (student && !roster.some((item) => item.id === id)) roster.push(student);
        }
        state.rosters.set(classId, roster);
        const cls = state.classes.find((item) => item.id === classId);
        if (cls) cls.studentCount = roster.length;
        await route.fulfill({ json: { added: payload.studentIds?.length || 0 } });
        return;
      }
      if (request.method() === "DELETE" && studentId) {
        state.membershipDeletes.push({ classId, studentId });
        const roster = (state.rosters.get(classId) || []).filter((item) => item.id !== studentId);
        state.rosters.set(classId, roster);
        const cls = state.classes.find((item) => item.id === classId);
        if (cls) cls.studentCount = roster.length;
        await route.fulfill({ json: { removed: true } });
        return;
      }
    }

    if (pathname === "/api/passes" && request.method() === "POST") {
      state.passWrites.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { id: `pass-${state.passWrites.length}` } });
      return;
    }
    if (pathname === "/api/passes/active") {
      await route.fulfill({ json: { passes: [] } });
      return;
    }
    if (pathname === "/api/kiosk-config") {
      await route.fulfill({ json: { source: "legacy_grades", classId: "class-b", gradeId: "class-b" } });
      return;
    }
    if (pathname === "/api/admin/attendance") {
      await route.fulfill({ json: { records: [] } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/grades") {
      state.kioskGradeRequests += 1;
      if (!state.kioskAvailable) {
        await route.fulfill({
          status: 403,
          json: { error: "Kiosk mode is disabled", source: "legacy_grades" },
        });
        return;
      }
      await route.fulfill({ json: { source: "legacy_grades", classes: state.classes } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/config") {
      if (!state.kioskAvailable) {
        state.kioskConfigFailures += 1;
        await route.fulfill({
          status: 403,
          json: { error: "Kiosk mode is disabled", source: "legacy_grades" },
        });
        return;
      }
      await route.fulfill({
        json: {
          source: "legacy_grades",
          classId: state.kioskClassId,
          gradeId: state.kioskClassId,
          kioskName: "Front Hall",
        },
      });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/students") {
      const classId = url.searchParams.get("classId") || url.searchParams.get("gradeId");
      await route.fulfill({ json: { students: state.rosters.get(classId) || [] } });
      return;
    }
    if (pathname === "/api/passpilot/kiosk/checkout") {
      state.kioskWrites.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { id: `kiosk-pass-${state.kioskWrites.length}` } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });
}

function classCard(page, name) {
  return page
    .getByRole("heading", { name, exact: true })
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]");
}

test("legacy PassPilot supports shared students with class-scoped roster writes", { timeout: 90_000 }, async () => {
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
    const context = await browser.newContext();
    const state = freshState();
    await installApiMocks(context, state);

    const page = await context.newPage();
    await page.goto(`${baseUrl}/passpilot/setup?section=classes`);
    await page.getByRole("heading", { name: "School Setup" }).waitFor();

    const scienceCard = classCard(page, "Science Lab");
    await scienceCard.getByRole("button", { name: "Assign Students" }).click();
    const assignDialog = page.getByRole("dialog", { name: "Assign Students to Science Lab" });
    await assignDialog.getByText("Students can belong to multiple classes.", { exact: false }).waitFor();
    const sharedCheckbox = assignDialog.getByRole("checkbox", { name: /Student, Shared/ });
    assert.equal(await sharedCheckbox.isVisible(), true, "a student in another class must remain assignable");
    await sharedCheckbox.check();
    await assignDialog.getByRole("button", { name: "Assign 1 Student", exact: true }).click();

    await page.waitForFunction(() => document.body.textContent?.includes("Science Lab"));
    assert.deepEqual(state.membershipWrites, [{ classId: "class-b", studentIds: ["student-shared"] }]);
    assert.deepEqual(state.rosters.get("class-a").map((item) => item.id), ["student-shared"]);
    assert.deepEqual(state.rosters.get("class-b").map((item) => item.id), ["student-second", "student-shared"]);

    await page.goto(`${baseUrl}/passpilot/my-class?classId=class-b`);
    await page.getByTestId("tab-grade-Science Lab").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("classId"), "class-b");
    await page.getByTestId("button-checkout-student-shared").click();
    await page.getByRole("menuitem", { name: "General/Restroom" }).click();
    await page.waitForFunction(() => document.body.textContent?.includes("Pass created"));
    assert.equal(state.passWrites.at(-1)?.classId, "class-b", "pass issuance must capture the selected legacy class");

    await page.reload();
    await page.getByTestId("button-checkout-student-shared").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("classId"), "class-b", "legacy class selection must survive refresh");

    const kioskPage = await context.newPage();
    await kioskPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}`);
    await kioskPage.getByRole("button", { name: /Student, Shared/ }).click();
    await kioskPage.getByRole("button", { name: "General/Restroom", exact: true }).click();
    await kioskPage.getByText("Pass issued!", { exact: true }).waitFor();
    assert.equal(state.kioskWrites.at(-1)?.classId, "class-b", "kiosk checkout must capture its configured class");

    state.kioskClassId = null;
    await kioskPage.waitForTimeout(5_250);
    await kioskPage.getByText("Select your class", { exact: true }).waitFor();
    assert.equal(
      await kioskPage.getByRole("button", { name: "Science Lab", exact: true }).isVisible(),
      true,
      "clearing the teacher-controlled class must return a legacy kiosk to its class picker",
    );
    await kioskPage.getByRole("button", { name: "Fifth Grade", exact: true }).click();
    await kioskPage.getByRole("heading", { name: "Fifth Grade — Front Hall", exact: true }).waitFor();
    await kioskPage.waitForTimeout(5_250);
    await kioskPage.getByRole("heading", { name: "Fifth Grade — Front Hall", exact: true }).waitFor();

    await kioskPage.close();
    state.kioskAvailable = false;
    const recoveringKioskPage = await context.newPage();
    await recoveringKioskPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=${SCHOOL_ID}`);
    await recoveringKioskPage.getByText("Select your class", { exact: true }).waitFor();
    const disabledObservationDeadline = Date.now() + 5_000;
    while (state.kioskConfigFailures === 0 && Date.now() < disabledObservationDeadline) {
      await recoveringKioskPage.waitForTimeout(50);
    }
    assert.ok(state.kioskConfigFailures > 0, "the recovery test must first observe a disabled config response");
    assert.equal(
      await recoveringKioskPage.getByRole("button", { name: "Science Lab", exact: true }).count(),
      0,
      "a disabled kiosk must not retain a stale class inventory",
    );
    const gradeRequestsBeforeRecovery = state.kioskGradeRequests;
    state.kioskAvailable = true;
    await recoveringKioskPage.getByRole("button", { name: "Science Lab", exact: true }).waitFor({ timeout: 10_000 });
    assert.ok(
      state.kioskGradeRequests > gradeRequestsBeforeRecovery,
      "re-enabling the kiosk must refetch its class inventory without a page reload",
    );
    await recoveringKioskPage.close();

    await page.goto(`${baseUrl}/passpilot/classes`);
    await page.getByRole("heading", { name: "My Classes" }).waitFor();
    await classCard(page, "Science Lab").getByRole("button", { name: "View Science Lab roster" }).click();
    const rosterDialog = page.getByRole("dialog", { name: "Science Lab - Full Roster" });
    await rosterDialog.getByRole("button", { name: "Remove Shared Student from Science Lab" }).click();
    await page.waitForFunction(() => document.body.textContent?.includes("Student removed from class"));
    assert.deepEqual(state.membershipDeletes, [{ classId: "class-b", studentId: "student-shared" }]);
    assert.deepEqual(state.rosters.get("class-a").map((item) => item.id), ["student-shared"]);

    await context.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});
