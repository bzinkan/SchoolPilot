import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";

function authResponse(role = 'teacher') {
  return {
    user: {
      id: TEACHER_ID,
      email: "teacher@example.edu",
      firstName: "Terry",
      lastName: "Teacher",
      isSuperAdmin: false,
    },
    token: "session-lifecycle-test-token",
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true, passPilot: false, goPilot: false },
    memberships: [{
      id: "teacher-membership",
      schoolId: SCHOOL_ID,
      role,
      schoolName: "Lifecycle Test School",
      schoolTimezone: "America/New_York",
    }],
  };
}

function activeSession(kind, overrides = {}) {
  const shared = {
    id: `${kind}-session`,
    schoolId: SCHOOL_ID,
    groupId: GROUP_ID,
    teacherId: TEACHER_ID,
    startTime: "2026-08-11T17:30:00.000Z",
    lifecycle: { kind, state: "active" },
  };

  if (kind === "scheduled") {
    return {
      ...shared,
      scheduledStartAt: "2026-08-11T17:30:00.000Z",
      scheduledEndAt: "2026-08-11T18:45:00.000Z",
      scheduledTimezone: "America/New_York",
      summaryTrigger: "scheduled_end",
      summaryExpectedAt: "2026-08-11T18:45:00.000Z",
      ...overrides,
    };
  }

  return {
    ...shared,
    summaryTrigger: "manual_end",
    summaryExpectedAt: null,
    ...overrides,
  };
}

function readyReportV2() {
  return {
    state: "ready",
    report: {
      reportVersion: 2,
      timezone: "America/New_York",
      totals: {
        roster: 1,
        eligible: 1,
        complete: 0,
        partial: 1,
        none: 0,
        unavailable: 0,
        eligibleSeconds: 120,
        monitoredSeconds: 90,
        gapSeconds: 30,
        unclassifiedSeconds: 15,
        offTaskSeconds: 45,
        offTaskEventCount: 2,
        safetyAlertCount: 1,
      },
      students: [{
        studentId: "report-student",
        studentName: "Ada Student",
        status: "partial",
        eligibleSeconds: 120,
        monitoredSeconds: 90,
        gapSeconds: 30,
        unclassifiedSeconds: 15,
        coveragePercent: 75,
        topDomains: [{
          domain: "https://docs.example.edu/assignment?student=private",
          seconds: 60,
        }],
        offTaskSeconds: 45,
        offTaskEventCount: 2,
        safetyAlerts: [{
          id: "safety-alert-1",
          category: "self_harm",
          normalizedDomain: "search.example.edu",
          occurredAt: "2026-08-11T18:00:00.000Z",
          evidenceAvailability: "available",
          reviewStatus: "escalated",
        }],
      }],
    },
  };
}

async function configurePage(page, kind, options = {}) {
  let currentSession = options.active === false ? null : options.session || activeSession(kind);
  let dashboardWebSocket;
  let webSocketAuthenticated = false;
  const endRequests = [];
  const genericEndRequests = [];
  const logoutRequests = [];
  const skipTodayRequests = [];
  const manualTodayRequests = [];
  const startRequests = [];
  let manualToday = options.manualToday || { schoolDate: '2026-10-30', timezone: 'America/New_York', resumesOn: '2026-10-31', resumesAt: '2026-10-31T04:00:00.000Z', canManageManualToday: false, teacherManualTodayAllowed: false, classes: [] };
  const recentRequests = [];
  const finalizedSessionIds = new Set();

  await page.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
  }, SCHOOL_ID);

  await page.routeWebSocket("**/ws", (webSocket) => {
    dashboardWebSocket = webSocket;
    webSocket.onMessage((message) => {
      const parsed = JSON.parse(message);
      if (parsed.type === "auth") {
        webSocketAuthenticated = true;
        webSocket.send(JSON.stringify({ type: "auth-success" }));
      }
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: authResponse(options.role) });
      return;
    }
    if (pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "session-lifecycle-test-csrf" } });
      return;
    }
    if (pathname === "/api/auth/logout" && request.method() === "POST") {
      logoutRequests.push(request.postData());
      await route.fulfill({ json: { success: true } });
      return;
    }
    if (pathname === "/api/sessions/active" && request.method() === "GET") {
      await route.fulfill({ json: { session: currentSession } });
      return;
    }
    if (pathname === '/api/classpilot/groups/manual-today' && request.method() === 'GET') {
      await route.fulfill({ json: manualToday });
      return;
    }
    const manualTodayMatch = pathname.match(/^\/api\/classpilot\/groups\/([^/]+)\/manual-today$/);
    if (manualTodayMatch && request.method() === 'POST') {
      const groupId = decodeURIComponent(manualTodayMatch[1]);
      manualTodayRequests.push({ groupId, body: request.postDataJSON(), schoolId: request.headers()['x-school-id'] });
      if (options.manualTodayDenied) {
        manualToday = { ...manualToday, canManageManualToday: false, teacherManualTodayAllowed: false };
        await route.fulfill({ status: 403, json: { error: 'Teacher adjustments are no longer allowed.' } });
        return;
      }
      const endedScheduledSessionIds = currentSession?.groupId === groupId && currentSession?.lifecycle?.kind === 'scheduled' ? [currentSession.id] : [];
      if (endedScheduledSessionIds.length) currentSession = null;
      manualToday = { ...manualToday, classes: manualToday.classes.map(group => group.id === groupId ? { ...group, isManualToday: true, scheduleManualDate: manualToday.schoolDate, activeScheduledSessionId: null } : group) };
      await route.fulfill({ json: { ...manualToday, class: manualToday.classes.find(group => group.id === groupId), endedScheduledSessionIds } });
      return;
    }
    if (pathname === '/api/sessions/start' && request.method() === 'POST') {
      const body = request.postDataJSON();
      startRequests.push(body);
      currentSession = activeSession('manual', { groupId: body.groupId });
      await route.fulfill({ json: { session: currentSession } });
      return;
    }
    if (pathname === "/api/classpilot/teaching-sessions/recent" && request.method() === "GET") {
      recentRequests.push(new URL(request.url()).search);
      await route.fulfill({ json: { sessions: options.recentSessions || [] } });
      return;
    }
    const reportMatch = pathname.match(/^\/api\/classpilot\/teaching-sessions\/([^/]+)\/report$/);
    if (reportMatch && request.method() === "GET") {
      await route.fulfill({ json: options.reportResponse || { state: "pending" } });
      return;
    }
    const endMatch = pathname.match(/^\/api\/classpilot\/teaching-sessions\/([^/]+)\/end$/);
    if (endMatch && request.method() === "POST") {
      const sessionId = decodeURIComponent(endMatch[1]);
      const alreadyFinalized = finalizedSessionIds.has(sessionId);
      endRequests.push({ sessionId, body: request.postDataJSON() });
      if (currentSession?.id === sessionId) currentSession = null;
      finalizedSessionIds.add(sessionId);
      await route.fulfill({
        json: {
          success: true,
          summaryDisposition: alreadyFinalized ? "already_queued" : "queued",
          finalizationReason: kind === "scheduled" ? "teacher_end" : "manual_end",
        },
      });
      return;
    }
    if (pathname === "/api/sessions/end" && request.method() === "POST") {
      genericEndRequests.push(request.postDataJSON());
      await route.fulfill({ status: 500, json: { error: "Generic End endpoint must not be used" } });
      return;
    }
    if (pathname === `/api/classpilot/scheduled-classes/${GROUP_ID}/skip-today` && request.method() === "POST") {
      skipTodayRequests.push(request.postDataJSON());
      await route.fulfill({ json: { skipped: true } });
      return;
    }
    if (pathname === "/api/teacher/groups") {
      await route.fulfill({
        json: options.groups || [{
          id: GROUP_ID,
          name: "Biology",
          teacherId: TEACHER_ID,
          scheduleEnabled: kind === "scheduled",
          blockStartTime: kind === "scheduled" ? "13:30" : null,
          blockEndTime: kind === "scheduled" ? "14:45" : null,
        }],
      });
      return;
    }
    if (pathname === "/api/students-aggregated") {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === `/api/groups/${GROUP_ID}/students`) {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === `/api/groups/${GROUP_ID}/subgroups`) {
      await route.fulfill({ json: { subgroups: [] } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });

  return {
    endRequests,
    genericEndRequests,
    logoutRequests,
    skipTodayRequests,
    manualTodayRequests,
    startRequests,
    setManualToday(value) { manualToday = value; },
    clearActiveSession() { currentSession = null; },
    recentRequests,
    async replaceActiveSession(session, endedSessionId) {
      currentSession = session;
      finalizedSessionIds.add(endedSessionId);
      const deadline = Date.now() + 5_000;
      while ((!dashboardWebSocket || !webSocketAuthenticated) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(dashboardWebSocket && webSocketAuthenticated, "Dashboard WebSocket must authenticate");
      dashboardWebSocket.send(JSON.stringify({
        type: "session-ended",
        sessionId: endedSessionId,
        reason: "scheduled_end",
        summaryDisposition: "queued",
      }));
    },
  };
}

test("ClassPilot dashboard explains scheduled and manual summary lifecycle", { timeout: 60_000 }, async () => {
  const vite = await createServer({
    root: APP_ROOT,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();

  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite must listen on a local TCP port");

  let browser;
  let scheduledLogoutPage;
  let scheduledPage;
  let backToBackPage;
  let manualLogoutPage;
  let manualPage;
  let pastSessionsPage;
  let scheduledPrestartPage;

  try {
    browser = await chromium.launch({ headless: true });

    scheduledLogoutPage = await browser.newPage();
    const scheduledLogout = await configurePage(scheduledLogoutPage, "scheduled");
    await scheduledLogoutPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await scheduledLogoutPage.getByTestId("badge-automatic-session").waitFor();
    await scheduledLogoutPage.getByTestId("button-logout").click();
    await assert.doesNotReject(async () => {
      await scheduledLogoutPage.getByTestId("dialog-logout-active-session").waitFor();
    });
    await assert.doesNotReject(async () => {
      await scheduledLogoutPage.getByTestId("text-logout-consequence").getByText(
        /continue until 2:45 PM, and the Session Summary will then be emailed automatically/,
      ).waitFor();
    });
    await scheduledLogoutPage.getByTestId("button-confirm-logout").click();
    await scheduledLogoutPage.waitForURL(/\/login$/);
    assert.equal(scheduledLogout.logoutRequests.length, 1, "scheduled logout must sign out once");
    assert.equal(scheduledLogout.endRequests.length, 0, "scheduled logout must not end the class");

    scheduledPage = await browser.newPage();
    const scheduledEnd = await configurePage(scheduledPage, "scheduled");
    await scheduledPage.goto(`http://127.0.0.1:${address.port}/classpilot`);

    await assert.doesNotReject(async () => {
      await scheduledPage.getByTestId("badge-automatic-session").waitFor();
    });
    assert.equal(
      (await scheduledPage.getByTestId("badge-automatic-session").textContent())?.trim(),
      "Automatic · Ends 2:45 PM",
    );

    await scheduledPage.getByTestId("button-end-session").click();
    await assert.doesNotReject(async () => {
      await scheduledPage.getByRole("heading", { name: "End scheduled class early?" }).waitFor();
    });
    await assert.doesNotReject(async () => {
      await scheduledPage.getByTestId("text-end-class-consequence").getByText(
        /cover the scheduled start through now and be emailed; today’s block will not restart/,
      ).waitFor();
    });
    await scheduledPage.getByTestId("button-confirm-end-class").click();
    await assert.doesNotReject(async () => {
      await scheduledPage.getByText(
        "Scheduled class ended early. The Session Summary is queued for email.",
        { exact: true },
      ).waitFor();
    });
    assert.equal(scheduledEnd.endRequests.length, 1, "scheduled End Class must submit exactly once");
    assert.equal(scheduledEnd.endRequests[0].sessionId, "scheduled-session");
    assert.equal(scheduledEnd.genericEndRequests.length, 0, "scheduled End Class must use the ID-specific endpoint");
    assert.equal(scheduledEnd.logoutRequests.length, 0, "scheduled End Class must not log the teacher out");

    backToBackPage = await browser.newPage();
    const firstScheduledSession = activeSession("scheduled", { id: "scheduled-session-a" });
    const nextScheduledSession = activeSession("scheduled", {
      id: "scheduled-session-b",
      startTime: "2026-08-11T18:45:00.000Z",
      scheduledStartAt: "2026-08-11T18:45:00.000Z",
      scheduledEndAt: "2026-08-11T19:45:00.000Z",
      summaryExpectedAt: "2026-08-11T19:45:00.000Z",
    });
    const backToBack = await configurePage(backToBackPage, "scheduled", { session: firstScheduledSession });
    await backToBackPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await backToBackPage.getByTestId("button-end-session").click();
    await backToBackPage.getByTestId("dialog-end-class").waitFor();

    await backToBack.replaceActiveSession(nextScheduledSession, firstScheduledSession.id);
    await backToBackPage.waitForFunction(() => (
      document.querySelector('[data-testid="badge-automatic-session"]')?.textContent?.includes("3:45 PM")
    ));
    await backToBackPage.getByTestId("button-confirm-end-class").click();
    await backToBackPage.getByText(
      "Class ended. The Session Summary was already queued for email.",
      { exact: true },
    ).waitFor();

    assert.deepEqual(
      backToBack.endRequests.map((request) => request.sessionId),
      [firstScheduledSession.id],
      "confirm must finalize only the session snapshotted when the dialog opened",
    );
    assert.equal(backToBack.genericEndRequests.length, 0, "back-to-back End must not resolve the current session generically");
    assert.match(
      (await backToBackPage.getByTestId("badge-automatic-session").textContent()) || "",
      /3:45 PM/,
      "the next scheduled session must remain active",
    );

    manualLogoutPage = await browser.newPage();
    const manualLogout = await configurePage(manualLogoutPage, "manual");
    await manualLogoutPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await manualLogoutPage.getByTestId("badge-active-session").waitFor();
    await manualLogoutPage.getByTestId("button-logout").click();
    await assert.doesNotReject(async () => {
      await manualLogoutPage.getByTestId("text-logout-consequence").getByText(
        /will not end this class or send its Session Summary/,
      ).waitFor();
    });
    await manualLogoutPage.getByTestId("button-confirm-logout").click();
    await manualLogoutPage.waitForURL(/\/login$/);
    assert.equal(manualLogout.logoutRequests.length, 1, "manual logout must sign out once");
    assert.equal(manualLogout.endRequests.length, 0, "manual logout must not end or email the class");

    manualPage = await browser.newPage();
    const manualEnd = await configurePage(manualPage, "manual", { reportResponse: readyReportV2() });
    await manualPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await manualPage.getByTestId("badge-active-session").waitFor();
    assert.equal(await manualPage.getByTestId("badge-automatic-session").count(), 0);

    await manualPage.getByTestId("button-end-session").click();
    await assert.doesNotReject(async () => {
      await manualPage.getByRole("heading", { name: "End class?" }).waitFor();
    });
    await assert.doesNotReject(async () => {
      await manualPage.getByTestId("text-end-class-consequence").getByText(
        /Session Summary will be generated after a short telemetry-settlement window, then emailed/,
      ).waitFor();
    });
    await manualPage.getByTestId("button-confirm-end-class").click();
    await assert.doesNotReject(async () => {
      await manualPage.getByText(
        "Class ended. The Session Summary is queued for email.",
        { exact: true },
      ).waitFor();
    });
    const sessionReportDialog = manualPage.getByTestId("dialog-session-monitoring-report");
    await sessionReportDialog.getByText("Report v2", { exact: true }).waitFor();
    await sessionReportDialog.getByText(
      /Activity time is derived from authenticated monitoring heartbeats\. Screenshots are not used/,
    ).waitFor();
    assert.match(await sessionReportDialog.getByTestId("session-report-monitored-time").innerText(), /1m 30s \/ 2m/);
    assert.match(await sessionReportDialog.getByTestId("session-report-gap-time").innerText(), /30s/);
    assert.match(await sessionReportDialog.getByTestId("session-report-unclassified-time").innerText(), /15s/);
    assert.match(await sessionReportDialog.getByTestId("session-report-off-task").innerText(), /45s · 2 events/);
    await sessionReportDialog.getByText("docs.example.edu", { exact: true }).waitFor();
    await sessionReportDialog.getByText("Self Harm", { exact: true }).waitFor();
    await sessionReportDialog.getByText("Evidence: Available", { exact: true }).waitFor();
    await sessionReportDialog.getByText("Escalated", { exact: true }).waitFor();
    await sessionReportDialog.getByText(/“Automated” means the alert was system-generated/).waitFor();
    assert.doesNotMatch(await sessionReportDialog.innerText(), /student=private/);
    assert.equal(manualEnd.endRequests.length, 1, "manual End Class must submit exactly once");
    assert.equal(manualEnd.endRequests[0].sessionId, "manual-session");
    assert.equal(manualEnd.genericEndRequests.length, 0, "manual End Class must use the ID-specific endpoint");
    assert.equal(manualEnd.logoutRequests.length, 0, "manual End Class must not log the teacher out");

    pastSessionsPage = await browser.newPage();
    const pastSessionRow = (overrides) => ({
      groupId: GROUP_ID,
      teacherId: TEACHER_ID,
      className: "Biology",
      lifecycle: { kind: "manual", state: "ended" },
      summaryTrigger: "manual_end",
      ...overrides,
    });
    const pastSessions = await configurePage(pastSessionsPage, "manual", {
      reportResponse: readyReportV2(),
      recentSessions: [
        pastSessionRow({
          id: "ready-session",
          startTime: "2026-08-10T17:30:00.000Z",
          endTime: "2026-08-10T18:20:00.000Z",
          reportState: "ready",
        }),
        pastSessionRow({
          id: "pending-session",
          startTime: "2026-08-09T17:30:00.000Z",
          endTime: "2026-08-09T18:20:00.000Z",
          reportState: "pending",
        }),
        pastSessionRow({
          id: "expired-session",
          startTime: "2026-07-01T17:30:00.000Z",
          endTime: "2026-07-01T18:45:00.000Z",
          lifecycle: { kind: "scheduled", state: "ended" },
          summaryTrigger: "scheduled_end",
          reportState: "expired",
        }),
        pastSessionRow({
          id: "none-session",
          startTime: "2026-06-30T17:30:00.000Z",
          endTime: "2026-06-30T18:00:00.000Z",
          reportState: "none",
        }),
      ],
    });
    await pastSessionsPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await pastSessionsPage.getByTestId("badge-active-session").waitFor();
    assert.equal(
      pastSessions.recentRequests.length,
      0,
      "the recent-sessions endpoint must not be requested before the teacher opens Past sessions",
    );
    await pastSessionsPage.getByTestId("button-past-sessions").click();
    await pastSessionsPage.getByTestId("dialog-past-sessions").waitFor();
    const readyRow = pastSessionsPage.getByTestId("past-session-ready-session");
    await readyRow.waitFor();
    assert.deepEqual(pastSessions.recentRequests, ["?limit=20"], "opening the popover must request exactly one bounded page");
    await readyRow.getByText("Biology", { exact: true }).waitFor();
    await readyRow.getByText("Manual", { exact: true }).waitFor();
    await readyRow.getByText("Summary ready", { exact: true }).waitFor();
    const expiredRow = pastSessionsPage.getByTestId("past-session-expired-session");
    await expiredRow.getByText("Automatic", { exact: true }).waitFor();
    const expiredButton = pastSessionsPage.getByTestId("button-open-session-report-expired-session");
    assert.equal(await expiredButton.isDisabled(), true, "an expired Session Summary must not be openable");
    assert.equal((await expiredButton.textContent())?.trim(), "Summary expired");
    assert.equal(
      await pastSessionsPage.getByTestId("button-open-session-report-none-session").isDisabled(),
      true,
      "a session without a summary must not be openable",
    );
    await pastSessionsPage.getByTestId("past-session-report-state-pending-session").getByText("Generating…", { exact: true }).waitFor();
    assert.equal(
      await pastSessionsPage.getByTestId("button-open-session-report-pending-session").isDisabled(),
      false,
      "a pending summary stays openable so the report dialog can poll it",
    );
    await pastSessionsPage.getByTestId("button-open-session-report-ready-session").click();
    const pastReportDialog = pastSessionsPage.getByTestId("dialog-session-monitoring-report");
    await pastReportDialog.getByText("Report v2", { exact: true }).waitFor();
    await pastReportDialog.getByText("docs.example.edu", { exact: true }).waitFor();
    assert.equal(await pastSessionsPage.getByTestId("dialog-past-sessions").count(), 0, "the popover closes when a summary opens");
    assert.equal(pastSessions.endRequests.length, 0, "opening a past summary must not end the active class");
    assert.equal(pastSessions.recentRequests.length, 1, "opening a summary must not refetch the recent list");

    scheduledPrestartPage = await browser.newPage();
    const scheduledPrestart = await configurePage(scheduledPrestartPage, "scheduled", { active: false });
    await scheduledPrestartPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await scheduledPrestartPage.getByTestId("button-skip-scheduled-class-today").click();
    await scheduledPrestartPage.getByTestId("dialog-skip-scheduled-class-today").waitFor();
    await scheduledPrestartPage.getByTestId("text-skip-scheduled-class-consequence").getByText(
      /No Session Summary will be sent/,
    ).waitFor();
    await scheduledPrestartPage.getByTestId("button-confirm-skip-scheduled-class-today").click();
    await scheduledPrestartPage.getByText(
      "Today’s automatic class was canceled. No Session Summary will be sent.",
      { exact: true },
    ).waitFor();
    assert.equal(scheduledPrestart.skipTodayRequests.length, 1, "pre-start Skip Today must submit exactly once");
    assert.equal(scheduledPrestart.endRequests.length, 0, "pre-start Skip Today must not end a session");
    assert.equal(scheduledPrestart.logoutRequests.length, 0, "pre-start Skip Today must not log the teacher out");
  } finally {
    await scheduledLogoutPage?.close().catch(() => {});
    await scheduledPage?.close().catch(() => {});
    await backToBackPage?.close().catch(() => {});
    await manualLogoutPage?.close().catch(() => {});
    await manualPage?.close().catch(() => {});
    await pastSessionsPage?.close().catch(() => {});
    await scheduledPrestartPage?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});

test('Manual for today changes only reviewed classes, survives reload, and expires with the school date', { timeout: 90_000 }, async t => {
  const vite = await createServer({ root: APP_ROOT, logLevel: 'error', cacheDir: `node_modules/.vite-manual-today-${process.pid}`, server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await vite.close(); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const chemistryId = '44444444-4444-4444-8444-444444444444';
  const groups = [
    { id: GROUP_ID, name: 'Biology', teacherId: TEACHER_ID, scheduleEnabled: true, blockStartTime: '13:30', blockEndTime: '14:45' },
    { id: chemistryId, name: 'Chemistry', teacherId: TEACHER_ID, scheduleEnabled: true, blockStartTime: '14:45', blockEndTime: '15:30' },
  ];
  const original = { schoolDate: '2026-10-30', timezone: 'America/New_York', resumesOn: '2026-10-31', resumesAt: '2026-10-31T04:00:00.000Z', canManageManualToday: true, teacherManualTodayAllowed: true,
    classes: groups.map(group => ({ ...group, scheduleManualDate: null, isManualToday: false, activeScheduledSessionId: group.id === GROUP_ID ? 'scheduled-session' : null })) };
  const harness = await configurePage(page, 'scheduled', { groups, manualToday: original });
  await page.goto(`http://127.0.0.1:${address.port}/classpilot`);
  await page.getByTestId('badge-automatic-session').waitFor();
  await page.getByTestId('button-manual-today').click();
  const dialog = page.getByTestId('dialog-manual-today');
  await dialog.getByTestId(`button-review-manual-today-${GROUP_ID}`).click();
  await dialog.getByRole('heading', { name: 'Make Biology manual for today?' }).waitFor();
  await dialog.getByText('If an automatic session for this class is running, it will end.', { exact: false }).waitFor();
  assert.equal(harness.manualTodayRequests.length, 0, 'Reviewing a named class does not mutate scheduling');
  await dialog.getByRole('button', { name: 'Back to classes' }).click();
  assert.equal(harness.manualTodayRequests.length, 0, 'Backing out leaves automatic scheduling intact');
  await dialog.getByTestId(`button-review-manual-today-${GROUP_ID}`).click();
  await dialog.getByTestId('button-confirm-manual-today').click();
  await dialog.getByTestId('manual-today-success').getByText(/Biology is manual for today/).waitFor();
  assert.deepEqual(harness.manualTodayRequests, [{ groupId: GROUP_ID, body: { expectedSchoolDate: '2026-10-30' }, schoolId: SCHOOL_ID }]);
  assert.equal(harness.startRequests.length, 0, 'Enabling manual mode does not start a class');
  await dialog.getByTestId(`manual-today-class-${chemistryId}`).getByRole('button', { name: 'Manual for today', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByTestId('button-start-session').waitFor();
  assert.equal(await page.getByTestId('button-skip-scheduled-class-today').count(), 0, 'Manual mode does not offer Skip Today for the selected class');
  await page.getByTestId('manual-today-status').getByText(/Biology/).waitFor();
  assert.ok(!(await page.getByTestId('manual-today-status').textContent()).includes('Chemistry'), 'The other class remains automatic');

  await page.reload();
  await page.getByTestId('manual-today-status').getByText(/Biology/).waitFor();
  await page.getByTestId('button-manual-today').click();
  await page.getByTestId(`button-review-manual-today-${chemistryId}`).click();
  await page.getByTestId('button-confirm-manual-today').click();
  await page.getByTestId('manual-today-success').getByText(/Chemistry is manual for today/).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.deepEqual(harness.manualTodayRequests.map(request => request.groupId), [GROUP_ID, chemistryId]);
  await page.getByTestId('select-start-session-group').selectOption(chemistryId);
  assert.equal(harness.startRequests.length, 0, 'Selecting the class still requires Start Class');
  await page.getByTestId('button-start-session').click();
  await page.getByTestId('badge-active-session').getByText('Chemistry', { exact: true }).waitFor();
  assert.deepEqual(harness.startRequests, [{ groupId: chemistryId }]);
  assert.equal(harness.endRequests.length, 0, 'Override uses its exact class endpoint rather than a separate current-session end request');
  assert.equal(harness.skipTodayRequests.length, 0, 'Override never uses Skip Today');
  assert.equal(harness.logoutRequests.length, 0);

  harness.clearActiveSession();
  const nextDay = { ...original, schoolDate: '2026-10-31', resumesOn: '2026-11-01', resumesAt: '2026-11-01T04:00:00.000Z', classes: original.classes.map(group => ({ ...group, scheduleManualDate: '2026-10-30', isManualToday: false, activeScheduledSessionId: null })) };
  harness.setManualToday(nextDay);
  await page.reload();
  await page.getByTestId('button-skip-scheduled-class-today').waitFor();
  assert.equal(await page.getByTestId('manual-today-status').count(), 0, 'Yesterday’s override does not appear active on the next school date');
  await page.getByTestId('button-manual-today').click();
  await page.getByTestId(`button-review-manual-today-${GROUP_ID}`).waitFor();
  await page.getByTestId(`button-review-manual-today-${chemistryId}`).waitFor();
  assert.match(await page.getByTestId('manual-today-date').textContent(), /Oct 31, 2026.*America\/New_York.*Nov 1, 2026/);
  assert.deepEqual(errors, []);

  const overnightPage = await browser.newPage();
  await overnightPage.clock.install({ time: new Date('2026-10-31T03:59:00.000Z') });
  const overnight = await configurePage(overnightPage, 'scheduled', { active: false, manualToday: { ...original, classes: original.classes.map(group => ({ ...group, isManualToday: group.id === GROUP_ID, activeScheduledSessionId: null })) } });
  await overnightPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
  await overnightPage.getByTestId('manual-today-status').waitFor();
  await overnightPage.getByTestId('button-manual-today').click();
  await overnightPage.getByTestId(`button-review-manual-today-${chemistryId}`).click();
  await overnightPage.clock.pauseAt(new Date('2026-10-31T03:59:59.000Z'));
  overnight.setManualToday(nextDay);
  await overnightPage.clock.fastForward(1_000);
  await overnightPage.getByText('The school date changed while this review was open.', { exact: false }).waitFor();
  assert.equal(await overnightPage.getByTestId('button-confirm-manual-today').isDisabled(), true, 'An overnight review cannot silently enable the next day');
  assert.equal(await overnightPage.getByTestId('manual-today-status').count(), 0, 'The school-midnight boundary clears yesterday’s override without a reload');
  assert.equal(overnight.manualTodayRequests.length, 0);

  const deniedPage = await browser.newPage();
  const denied = await configurePage(deniedPage, 'scheduled', { active: false, manualToday: original, manualTodayDenied: true });
  await deniedPage.goto(`http://127.0.0.1:${address.port}/classpilot`);
  await deniedPage.getByTestId('button-manual-today').click();
  await deniedPage.getByTestId(`button-review-manual-today-${GROUP_ID}`).click();
  await deniedPage.getByTestId('button-confirm-manual-today').click();
  await deniedPage.getByRole('alert').getByText('Teacher adjustments are no longer allowed.', { exact: true }).waitFor();
  assert.equal(await deniedPage.getByTestId('button-confirm-manual-today').isDisabled(), true, 'Revoked school permission disables confirmation after refresh');
  assert.equal(denied.manualTodayRequests.length, 1);
  assert.equal(denied.startRequests.length, 0);
  await deniedPage.getByRole('button', { name: 'Back to classes' }).click();
  await deniedPage.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await deniedPage.getByTestId('button-manual-today').count(), 0, 'Teachers without school permission cannot open the adjustment action');
});
