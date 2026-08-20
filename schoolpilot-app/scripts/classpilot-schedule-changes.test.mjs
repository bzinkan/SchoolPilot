import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TEACHER_ID = "33333333-3333-4333-8333-333333333333";
const PAIR_ID = "44444444-4444-4444-8444-444444444444";
const CHANGE_ID = "55555555-5555-4555-8555-555555555555";
const SCHEDULED_CONFLICT_ID = "66666666-6666-4666-8666-666666666666";
const SCHEDULED_STUDENT_ID = "77777777-7777-4777-8777-777777777777";
const SWAP_DATE = "2026-09-10";

function auth(role) {
  return {
    user: {
      id: role === "teacher" ? TEACHER_ID : "admin-user-id",
      email: `${role}@example.edu`,
      firstName: role === "teacher" ? "Taylor" : "Alex",
      lastName: role === "teacher" ? "Teacher" : "Admin",
      isSuperAdmin: false,
    },
    token: `${role}-schedule-test-token`,
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true, passPilot: false, goPilot: false },
    memberships: [{
      id: `${role}-membership`,
      schoolId: SCHOOL_ID,
      schoolName: "Schedule Test School",
      schoolTimezone: "America/New_York",
      role,
    }],
  };
}

const firstClass = {
  id: "class-math-7",
  name: "7th Math",
  primaryTeacher: { id: TEACHER_ID, name: "Taylor Teacher" },
  normalWindow: { startTime: "09:00", endTime: "09:45" },
};
const secondClass = {
  id: "class-ela-8",
  name: "8th ELA",
  primaryTeacher: { id: OTHER_TEACHER_ID, name: "Ellis Educator" },
  normalWindow: { startTime: "10:00", endTime: "10:45" },
};
const pair = { id: PAIR_ID, status: "active", revision: 0, firstClass, secondClass };
const legs = [
  {
    class: { id: firstClass.id, name: firstClass.name },
    primaryTeacher: firstClass.primaryTeacher,
    normalWindow: firstClass.normalWindow,
    effectiveWindow: secondClass.normalWindow,
  },
  {
    class: { id: secondClass.id, name: secondClass.name },
    primaryTeacher: secondClass.primaryTeacher,
    normalWindow: secondClass.normalWindow,
    effectiveWindow: firstClass.normalWindow,
  },
];

function change(overrides = {}) {
  return {
    id: CHANGE_ID,
    scheduledDate: SWAP_DATE,
    status: "pending_counterpart",
    reason: "Grade-level assembly changes the rotation.",
    revision: 3,
    requestedBy: { id: OTHER_TEACHER_ID, name: "Ellis Educator" },
    legs,
    allowedActions: ["accept", "decline"],
    nextActor: "counterpart_teacher",
    ...overrides,
  };
}

function eligibility(policyOverrides = {}) {
  return {
    scheduledDate: SWAP_DATE,
    schoolTimezone: "America/New_York",
    policy: {
      teacherRequestsEnabled: true,
      adminApprovalRequired: true,
      sameDayCutoffEnforced: true,
      sameDayCutoff: "07:00",
      reasonRequired: true,
      schoolTimezone: "America/New_York",
      revision: 1,
      ...policyOverrides,
    },
    pairs: [{
      pairId: PAIR_ID,
      firstClass,
      secondClass,
      preview: {
        legs: [
          { classId: firstClass.id, className: firstClass.name, normalWindow: firstClass.normalWindow, effectiveWindow: secondClass.normalWindow },
          { classId: secondClass.id, className: secondClass.name, normalWindow: secondClass.normalWindow, effectiveWindow: firstClass.normalWindow },
        ],
      },
      eligible: true,
      blockers: [],
    }],
    capabilities: { canCreate: true },
  };
}

async function configureBase(page, role, handleApi) {
  await page.addInitScript((schoolId) => window.localStorage.setItem("sp_activeSchoolId", schoolId), SCHOOL_ID);
  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(message);
      if (parsed.type === "auth") {
        assert.equal(parsed.userToken, `${role}-schedule-test-token`);
        assert.equal(Object.hasOwn(parsed, "token"), false);
        assert.equal(
          parsed.role,
          ["admin", "school_admin"].includes(role) ? "school_admin" : "teacher",
        );
        socket.send(JSON.stringify({ type: "auth-success" }));
      }
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: auth(role) });
      return;
    }
    if (url.pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "schedule-test-csrf" } });
      return;
    }
    if (await handleApi(route, request, url)) return;
    await route.fulfill({ status: 200, json: {} });
  });
}

test("ClassPilot schedule-change teacher, admin, policy, and mobile workflows", { timeout: 90_000 }, async () => {
  const vite = await createServer({ root: APP_ROOT, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });

    const teacherPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const teacherCreates = [];
    const teacherActions = [];
    let createAttempts = 0;
    let teacherRequestsEnabled = true;
    let teacherReasonRequired = true;
    let scheduledConflictFetches = 0;
    await configureBase(teacherPage, "teacher", async (route, request, url) => {
      if (url.pathname === "/api/classpilot/schedule-changes/settings" && request.method() === "GET") {
        await route.fulfill({ json: { ...eligibility().policy, teacherRequestsEnabled } });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes/eligibility" && request.method() === "GET") {
        assert.equal(url.searchParams.get("date"), SWAP_DATE);
        await route.fulfill({ json: eligibility({ reasonRequired: teacherReasonRequired }) });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes" && request.method() === "GET") {
        const scope = url.searchParams.get("scope");
        await route.fulfill({ json: { changes: scope === "needs_action" ? [change()] : [], schoolTimezone: "America/New_York" } });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes/today" && request.method() === "GET") {
        // The day-of endpoint is intentionally a narrow, role-relevant leg
        // projection rather than the full workflow record.
        await route.fulfill({ json: {
          scheduledDate: SWAP_DATE,
          schoolTimezone: "America/New_York",
          changes: [{
            id: CHANGE_ID,
            class: legs[0].class,
            normalWindow: legs[0].normalWindow,
            effectiveWindow: legs[0].effectiveWindow,
          }],
        } });
        return true;
      }
      if (url.pathname === "/api/classpilot/scheduled-conflicts" && request.method() === "GET") {
        scheduledConflictFetches += 1;
        await route.fulfill({ json: {
          conflicts: Array.from({ length: 12 }, (_, index) => ({
            id: `${SCHEDULED_CONFLICT_ID}-${index}`,
            message: `Global conflict ${index + 1}`,
            status: "coverage_needed",
            canStartAnyway: true,
          })),
        } });
        return true;
      }
      if (url.pathname === "/api/coverage/available-students" && request.method() === "GET") {
        await route.fulfill({ json: {
          students: [],
          scheduledCoverageGroups: [{
            id: SCHEDULED_CONFLICT_ID,
            kind: "scheduled_coverage",
            label: "Scheduled Supervision Needed: 6th Science",
            className: "6th Science",
            teacherName: "Taylor Teacher",
            scheduledTeacher: { id: TEACHER_ID, displayName: "Taylor Teacher" },
            scheduledDate: SWAP_DATE,
            blockStartTime: "11:00",
            blockEndTime: "11:45",
            canStartClass: true,
            claimableCount: 1,
            totalClaimableCount: 1,
            monitoredCount: 0,
            claimedCount: 0,
            students: [{
              studentId: SCHEDULED_STUDENT_ID,
              studentName: "Sam Scheduled",
              gradeLevel: "6",
              status: "online",
              lastSeenAt: new Date().toISOString(),
              activeTabTitle: "Science Notes",
              activeTabUrl: "https://classroom.example.edu/science",
            }],
          }],
        } });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes" && request.method() === "POST") {
        createAttempts += 1;
        teacherCreates.push(request.postDataJSON());
        if (createAttempts === 1) {
          await route.fulfill({ status: 409, json: { code: "SCHEDULE_CHANGE_REVISION_CONFLICT", current: pair } });
        } else {
          await route.fulfill({ json: change({ id: "new-change", allowedActions: ["withdraw"] }) });
        }
        return true;
      }
      if (url.pathname === `/api/classpilot/schedule-changes/${CHANGE_ID}/actions` && request.method() === "POST") {
        teacherActions.push(request.postDataJSON());
        await route.fulfill({ json: change({ status: "pending_admin", revision: 4, allowedActions: [] }) });
        return true;
      }
      return false;
    });

    await teacherPage.goto(`${baseURL}/classpilot/my-settings/schedule-changes`);
    await teacherPage.getByRole("heading", { name: "Schedule Changes", exact: true }).waitFor();
    await teacherPage.getByRole("link", { name: "Teaching Tools" }).waitFor();
    await teacherPage.getByText("7th Math").first().waitFor();
    await teacherPage.getByTestId(`button-accept-${CHANGE_ID}`).click();
    await teacherPage.waitForFunction(() => document.body.textContent.includes("Time swap accepted"));
    assert.deepEqual(teacherActions, [{ action: "accept", expectedRevision: 3 }]);

    await teacherPage.getByTestId("button-request-time-swap").click();
    assert.equal(await teacherPage.getByTestId("textarea-schedule-change-reason").getAttribute("required"), "", "teacher requests must fail closed until date-specific policy loads");
    await teacherPage.getByTestId("input-schedule-change-date").fill(SWAP_DATE);
    await teacherPage.getByTestId("select-schedule-change-pair").click();
    await teacherPage.getByRole("option", { name: "7th Math ↔ 8th ELA" }).click();
    await teacherPage.getByText("Event day", { exact: true }).first().waitFor();
    assert.equal(await teacherPage.getByTestId("textarea-schedule-change-reason").getAttribute("required"), "");
    assert.equal(await teacherPage.getByTestId("button-submit-schedule-change").isDisabled(), true);
    await teacherPage.getByTestId("textarea-schedule-change-reason").fill("Assembly schedule for both grade levels.");
    await teacherPage.getByTestId("button-submit-schedule-change").click();
    await teacherPage.getByTestId("schedule-change-submit-error").waitFor();
    assert.equal(await teacherPage.getByTestId("textarea-schedule-change-reason").inputValue(), "Assembly schedule for both grade levels.");
    await teacherPage.getByTestId("button-refresh-schedule-eligibility").click();
    assert.equal(await teacherPage.getByTestId("textarea-schedule-change-reason").inputValue(), "Assembly schedule for both grade levels.");
    await teacherPage.getByTestId("button-submit-schedule-change").click();
    await teacherPage.getByTestId("dialog-schedule-change-request").waitFor({ state: "hidden" });
    assert.deepEqual(teacherCreates, [
      { pairId: PAIR_ID, scheduledDate: SWAP_DATE, reason: "Assembly schedule for both grade levels." },
      { pairId: PAIR_ID, scheduledDate: SWAP_DATE, reason: "Assembly schedule for both grade levels." },
    ]);

    teacherReasonRequired = false;
    await teacherPage.getByTestId("button-request-time-swap").click();
    await teacherPage.getByTestId("input-schedule-change-date").fill(SWAP_DATE);
    await teacherPage.getByText("Note (optional)", { exact: true }).waitFor();
    await teacherPage.getByTestId("select-schedule-change-pair").click();
    await teacherPage.getByRole("option", { name: "7th Math ↔ 8th ELA" }).click();
    assert.equal(await teacherPage.getByTestId("textarea-schedule-change-reason").getAttribute("required"), null);
    assert.equal(await teacherPage.getByTestId("button-submit-schedule-change").isEnabled(), true);
    await teacherPage.getByTestId("button-submit-schedule-change").click();
    await teacherPage.getByTestId("dialog-schedule-change-request").waitFor({ state: "hidden" });
    assert.deepEqual(teacherCreates.at(-1), { pairId: PAIR_ID, scheduledDate: SWAP_DATE });
    const mobileWidth = await teacherPage.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    assert.ok(mobileWidth.document <= mobileWidth.viewport + 1, `teacher schedule page overflowed: ${JSON.stringify(mobileWidth)}`);
    if (process.env.CLASSPILOT_SCHEDULE_TEACHER_SCREENSHOT) {
      await teacherPage.screenshot({ path: process.env.CLASSPILOT_SCHEDULE_TEACHER_SCREENSHOT, fullPage: true });
    }
    teacherRequestsEnabled = false;
    await teacherPage.goto(`${baseURL}/classpilot/my-settings/schedule-changes`);
    await teacherPage.getByTestId("teacher-schedule-requests-disabled").waitFor();
    assert.equal(await teacherPage.getByTestId("button-request-time-swap").isDisabled(), true, "teacher creation must be policy-gated");
    await teacherPage.goto(`${baseURL}/classpilot`);
    await teacherPage.getByTestId("today-schedule-change-indicator").waitFor();
    assert.match(await teacherPage.getByTestId("today-schedule-change-indicator").innerText(), /Schedule changed today · 7th Math 10:00 AM–10:45 AM/);
    assert.equal(await teacherPage.getByTestId("button-request-time-swap").count(), 0, "the Dashboard must not expose schedule-change creation controls");
    await teacherPage.getByTestId("button-view-available-students").waitFor();
    assert.equal(scheduledConflictFetches, 0, "the Dashboard must not fetch the global scheduled-conflict feed");
    assert.equal(await teacherPage.getByTestId("scheduled-class-conflicts").count(), 0, "scheduled supervision must not render as a global alert stack");
    assert.equal(await teacherPage.getByTestId(`section-scheduled-coverage-${SCHEDULED_CONFLICT_ID}`).count(), 0, "scheduled supervision must stay hidden outside Available");
    await teacherPage.getByTestId("button-view-available-students").click();
    await teacherPage.getByTestId(`section-scheduled-coverage-${SCHEDULED_CONFLICT_ID}`).waitFor();
    await teacherPage.getByTestId(`button-start-scheduled-coverage-${SCHEDULED_CONFLICT_ID}`).waitFor();
    await teacherPage.getByTestId(`button-claim-scheduled-coverage-${SCHEDULED_CONFLICT_ID}`).waitFor();
    await teacherPage.getByTestId("button-view-class-students").click();
    assert.equal(await teacherPage.getByTestId(`section-scheduled-coverage-${SCHEDULED_CONFLICT_ID}`).count(), 0, "scheduled supervision must disappear outside Available");
    await teacherPage.close();

    const adminPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const createdPairs = [];
    const adminCreates = [];
    const adminActions = [];
    const pendingAdminChange = change({ status: "pending_admin", allowedActions: ["approve", "deny"] });
    await configureBase(adminPage, "school_admin", async (route, request, url) => {
      if (url.pathname === "/api/classpilot/schedule-changes/pairs" && request.method() === "GET") {
        await route.fulfill({ json: { pairs: [pair], capabilities: { canManage: true } } });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes/pairs" && request.method() === "POST") {
        createdPairs.push(request.postDataJSON());
        await route.fulfill({ json: { ...pair, id: "created-pair" } });
        return true;
      }
      if (url.pathname === "/api/classpilot/admin/classes" && request.method() === "GET") {
        await route.fulfill({ json: { classes: [
          { ...firstClass, teacherId: TEACHER_ID, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:45" },
          { ...secondClass, teacherId: OTHER_TEACHER_ID, scheduleEnabled: true, blockStartTime: "10:00", blockEndTime: "10:45" },
        ] } });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes/eligibility" && request.method() === "GET") {
        await route.fulfill({ json: eligibility({ reasonRequired: false }) });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes" && request.method() === "GET") {
        await route.fulfill({ json: { changes: url.searchParams.get("scope") === "needs_action" ? [pendingAdminChange] : [] } });
        return true;
      }
      if (url.pathname === "/api/classpilot/schedule-changes" && request.method() === "POST") {
        adminCreates.push(request.postDataJSON());
        await route.fulfill({ json: change({ status: "approved", allowedActions: ["cancel"] }) });
        return true;
      }
      if (url.pathname === `/api/classpilot/schedule-changes/${CHANGE_ID}/actions` && request.method() === "POST") {
        adminActions.push(request.postDataJSON());
        await route.fulfill({ json: change({ status: "approved", revision: 4, allowedActions: ["cancel"] }) });
        return true;
      }
      return false;
    });

    await adminPage.goto(`${baseURL}/classpilot/admin/classes/schedule-changes`);
    await adminPage.getByRole("link", { name: "Classes", exact: true }).waitFor();
    await adminPage.getByTestId(`button-approve-${CHANGE_ID}`).click();
    await adminPage.waitForFunction(() => document.body.textContent.includes("Schedule change approved"));
    assert.deepEqual(adminActions, [{ action: "approve", expectedRevision: 3 }]);

    await adminPage.getByTestId("button-add-schedule-pair").click();
    await adminPage.getByTestId("select-schedule-pair-first").click();
    await adminPage.getByRole("option", { name: /7th Math/ }).click();
    await adminPage.getByTestId("select-schedule-pair-second").click();
    await adminPage.getByRole("option", { name: /8th ELA/ }).click();
    await adminPage.getByTestId("button-enable-schedule-pair").click();
    await adminPage.getByTestId("dialog-schedule-pair").waitFor({ state: "hidden" });
    assert.deepEqual(createdPairs, [{ firstGroupId: firstClass.id, secondGroupId: secondClass.id }]);

    await adminPage.getByTestId("button-admin-create-schedule-change").click();
    await adminPage.getByTestId("input-schedule-change-date").fill(SWAP_DATE);
    await adminPage.getByTestId("select-schedule-change-pair").click();
    await adminPage.getByRole("option", { name: "7th Math ↔ 8th ELA" }).click();
    await adminPage.getByText("Reason", { exact: true }).waitFor();
    assert.equal(await adminPage.getByTestId("textarea-schedule-change-reason").getAttribute("required"), "");
    assert.equal(await adminPage.getByTestId("button-submit-schedule-change").isDisabled(), true, "admin creation must always require a reason");
    await adminPage.getByTestId("textarea-schedule-change-reason").fill("Administrator-created event-day rotation.");
    await adminPage.getByTestId("button-submit-schedule-change").click();
    await adminPage.getByTestId("dialog-schedule-change-request").waitFor({ state: "hidden" });
    assert.deepEqual(adminCreates, [{ pairId: PAIR_ID, scheduledDate: SWAP_DATE, reason: "Administrator-created event-day rotation.", directApprove: true }]);
    if (process.env.CLASSPILOT_SCHEDULE_ADMIN_SCREENSHOT) {
      await adminPage.screenshot({ path: process.env.CLASSPILOT_SCHEDULE_ADMIN_SCREENSHOT, fullPage: true });
    }
    await adminPage.close();

    const settingsPage = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const policyPatches = [];
    await configureBase(settingsPage, "school_admin", async (route, request, url) => {
      if (url.pathname === "/api/classpilot/schedule-changes/settings") {
        if (request.method() === "GET") {
          await route.fulfill({ json: { ...eligibility().policy, teacherRequestsEnabled: false } });
        } else {
          policyPatches.push(request.postDataJSON());
          await route.fulfill({
            status: 409,
            json: {
              code: "SCHEDULE_CHANGE_REVISION_CONFLICT",
              current: { ...eligibility().policy, teacherRequestsEnabled: false, sameDayCutoff: "06:30", revision: 2 },
            },
          });
        }
        return true;
      }
      if (url.pathname === "/api/settings") {
        await route.fulfill({ json: { schoolName: "Schedule Test School", retentionHours: "720", blockedDomains: [], allowedDomains: [], ipAllowlist: [] } });
        return true;
      }
      if (url.pathname === "/api/flight-paths") {
        await route.fulfill({ json: [] });
        return true;
      }
      if (url.pathname === "/api/classpilot/enrollment-key") {
        await route.fulfill({ json: {} });
        return true;
      }
      if (url.pathname === "/api/admin/users") {
        await route.fulfill({ json: { users: [] } });
        return true;
      }
      return false;
    });

    await settingsPage.goto(`${baseURL}/classpilot/settings#schedule-changes`);
    await settingsPage.getByTestId("card-schedule-change-policy").waitFor();
    await settingsPage.waitForFunction(() => document.activeElement?.id === "schedule-changes");
    assert.equal(await settingsPage.getByTestId("card-schedule-change-policy").evaluate((card) => (
      card.nextElementSibling?.textContent?.includes("Privacy & Compliance") === true
    )), true, "Schedule Changes must sit immediately before Privacy & Compliance");
    await settingsPage.getByTestId("switch-teacher-schedule-change-requests").click();
    await settingsPage.getByTestId("switch-schedule-change-cutoff-enforced").focus();
    await settingsPage.keyboard.press("Space");
    assert.equal(await settingsPage.getByTestId("input-schedule-change-cutoff").isDisabled(), true);
    assert.equal(await settingsPage.getByTestId("input-schedule-change-cutoff").inputValue(), "07:00", "turning enforcement off must retain the saved time");
    await settingsPage.getByTestId("switch-schedule-change-reason-required").focus();
    await settingsPage.keyboard.press("Space");
    await settingsPage.getByTestId("button-save-schedule-change-policy").click();
    await settingsPage.getByTestId("schedule-policy-conflict").waitFor();
    assert.equal(await settingsPage.getByTestId("switch-teacher-schedule-change-requests").getAttribute("data-state"), "checked", "409 must preserve the local switch draft");
    assert.equal(await settingsPage.getByTestId("switch-schedule-change-cutoff-enforced").getAttribute("data-state"), "unchecked", "409 must preserve the cutoff draft");
    assert.equal(await settingsPage.getByTestId("switch-schedule-change-reason-required").getAttribute("data-state"), "unchecked", "409 must preserve the reason draft");
    assert.deepEqual(policyPatches, [{
      teacherRequestsEnabled: true,
      adminApprovalRequired: true,
      sameDayCutoffEnforced: false,
      sameDayCutoff: "07:00",
      reasonRequired: false,
      expectedRevision: 1,
    }]);
    await settingsPage.getByRole("button", { name: "Load latest policy" }).click();
    assert.equal(await settingsPage.getByTestId("switch-teacher-schedule-change-requests").getAttribute("data-state"), "unchecked");
    assert.equal(await settingsPage.getByTestId("switch-schedule-change-cutoff-enforced").getAttribute("data-state"), "checked");
    assert.equal(await settingsPage.getByTestId("switch-schedule-change-reason-required").getAttribute("data-state"), "checked");
    assert.equal(await settingsPage.getByTestId("input-schedule-change-cutoff").isEnabled(), true);
    assert.equal(await settingsPage.getByTestId("input-schedule-change-cutoff").inputValue(), "06:30");
    await settingsPage.setViewportSize({ width: 390, height: 844 });
    const settingsMobileWidth = await settingsPage.getByTestId("card-schedule-change-policy").evaluate((card) => ({
      content: card.scrollWidth,
      card: card.clientWidth,
    }));
    assert.ok(settingsMobileWidth.content <= settingsMobileWidth.card + 1, `schedule policy overflowed on mobile: ${JSON.stringify(settingsMobileWidth)}`);
    await settingsPage.close();
  } finally {
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});
