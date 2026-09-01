import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TEACHER_ID = "33333333-3333-4333-8333-333333333333";
const OWN_GROUP_ID = "44444444-4444-4444-8444-444444444444";
const OBSERVED_GROUP_ID = "55555555-5555-4555-8555-555555555555";
const OBSERVED_SUBGROUP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OWN_SESSION_ID = "66666666-6666-4666-8666-666666666666";
const OBSERVED_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const STUDENT_ID = "88888888-8888-4888-8888-888888888888";
const SIGNED_OUT_STUDENT_ID = "99999999-9999-4999-8999-999999999999";
const SIGNAL_LOST_STUDENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MOVED_CLASS_STUDENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TINY_SCREENSHOT_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const UPDATED_SCREENSHOT_DATA_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='%230ea5e9'/%3E%3C/svg%3E";
const VIEWER_SCREENSHOT_DATA_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='%2316a34a'/%3E%3C/svg%3E";

const success = (body) => ({ kind: "success", body });
const pending = () => ({ kind: "pending" });
const failure = ({ requestId, headerRequestId, status = 500 } = {}) => ({
  kind: "failure",
  status,
  body: {
    error: "Internal server error",
    ...(requestId === undefined ? {} : { requestId }),
  },
  headerRequestId,
});

function authResponse(role = "admin") {
  return {
    user: {
      id: ADMIN_ID,
      email: "admin@example.edu",
      firstName: "Alex",
      lastName: "Admin",
      isSuperAdmin: false,
    },
    token: "dashboard-load-state-token",
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true, passPilot: false, goPilot: false },
    memberships: [{
      id: "admin-membership",
      schoolId: SCHOOL_ID,
      schoolName: "Dashboard State School",
      schoolTimezone: "America/New_York",
      role,
    }],
  };
}

function teachingSession({
  id = OWN_SESSION_ID,
  groupId = OWN_GROUP_ID,
  teacherId = ADMIN_ID,
} = {}) {
  return {
    id,
    schoolId: SCHOOL_ID,
    groupId,
    teacherId,
    startTime: "2026-08-25T13:00:00.000Z",
    lifecycle: { kind: "manual", state: "active" },
    summaryTrigger: "manual_end",
    summaryExpectedAt: null,
  };
}

const GROUPS = [{
  id: OWN_GROUP_ID,
  name: "Algebra",
  teacherId: ADMIN_ID,
}, {
  id: OBSERVED_GROUP_ID,
  name: "Biology",
  teacherId: OTHER_TEACHER_ID,
}];

function student(overrides = {}) {
  return {
    studentId: STUDENT_ID,
    studentName: "Ada Student",
    studentEmail: "ada@example.edu",
    status: "online",
    loginState: "logged_in",
    isLoggedIn: true,
    commandable: true,
    monitoringState: "healthy",
    activityState: "active",
    activeTabTitle: "Class notes",
    activeTabUrl: "https://classroom.example.edu/notes",
    lastSeenAt: "2026-08-25T13:01:00.000Z",
    realtimeObservedAt: "2026-08-25T13:01:00.000Z",
    realtimeBinding: "binding-a",
    realtimeRevision: 1,
    ...overrides,
  };
}

function aggregateController({ school = success([]), scoped = success([]) } = {}) {
  let schoolResponse = school;
  let scopedResponse = scoped;
  const waiters = new Set();
  const requests = [];

  const wakePendingRequests = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const waitUntilResolved = async (responseForRequest) => {
    let response = responseForRequest();
    while (response.kind === "pending") {
      await new Promise((resolve) => waiters.add(resolve));
      response = responseForRequest();
    }
    return response;
  };

  return {
    requests,
    setSchoolResponse(next) {
      schoolResponse = next;
      wakePendingRequests();
    },
    setScopedResponse(next) {
      scopedResponse = next;
      wakePendingRequests();
    },
    async fulfill(route, url) {
      const teachingSessionId = url.searchParams.get("teachingSessionId");
      requests.push({ teachingSessionId, url: url.toString() });
      const response = await waitUntilResolved(() => (
        teachingSessionId ? scopedResponse : schoolResponse
      ));
      if (response.kind === "success") {
        await route.fulfill({ status: 200, json: response.body });
        return;
      }
      await route.fulfill({
        status: response.status,
        json: response.body,
        headers: response.headerRequestId
          ? { "x-request-id": response.headerRequestId }
          : undefined,
      });
    },
  };
}

async function waitUntil(predicate, message, timeoutMs = 7_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function configureDashboard(page, {
  aggregate,
  userRole = "admin",
  activeSession = null,
  allSessions = [],
  blockedDomains = [],
  groupStudentIds = [],
  subgroups = [],
  subgroupMembers = {},
  screenshotTiles = { tiles: [] },
  historyTiles = { tiles: [] },
} = {}) {
  let dashboardSocket;
  let websocketAuthenticated = false;
  const commandPosts = [];
  const coverageMutationRequests = [];
  const tileRequests = [];
  const observationLeaseRequests = [];
  const pageErrors = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
  }, SCHOOL_ID);

  await page.routeWebSocket("**/ws", (socket) => {
    socket.onMessage((message) => {
      const parsed = JSON.parse(message);
      if (parsed.type !== "auth") return;
      dashboardSocket = socket;
      assert.equal(parsed.role, userRole === "teacher" ? "teacher" : "school_admin");
      assert.equal(parsed.userToken, "dashboard-load-state-token");
      assert.equal(Object.hasOwn(parsed, "token"), false);
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (
      !["GET", "HEAD"].includes(request.method())
      && (
        pathname.startsWith("/api/coverage/")
        || pathname.startsWith("/api/classpilot/coverage/")
        || /^\/api\/classpilot\/scheduled-conflicts\/[^/]+\/start-anyway$/.test(pathname)
      )
    ) {
      coverageMutationRequests.push({
        method: request.method(),
        pathname,
        body: request.postData() ? request.postDataJSON() : null,
      });
    }

    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: authResponse(userRole) });
      return;
    }
    if (pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "dashboard-load-state-csrf" } });
      return;
    }
    if (pathname === "/api/settings") {
      await route.fulfill({
        json: {
          settings: {
            ...(activeSession ? {
              activeSessionId: activeSession.id,
              handRaisingEnabled: true,
              studentMessagingEnabled: true,
              sessionFabRevision: 1,
            } : {}),
            blockedDomains,
          },
        },
      });
      return;
    }
    if (pathname === "/api/flight-paths") {
      await route.fulfill({ json: { flightPaths: [] } });
      return;
    }
    if (pathname === "/api/block-lists") {
      await route.fulfill({ json: { blockLists: [] } });
      return;
    }
    if (pathname === "/api/sessions/active") {
      await route.fulfill({ json: { session: activeSession } });
      return;
    }
    if (pathname === "/api/teacher/groups") {
      await route.fulfill({ json: { groups: GROUPS } });
      return;
    }
    if (pathname === "/api/sessions/all") {
      await route.fulfill({ json: { sessions: allSessions } });
      return;
    }
    if (pathname === "/api/coverage/summary") {
      await route.fulfill({
        json: {
          activeContextCount: 0,
          availableCount: 0,
          claimedCount: 0,
        },
      });
      return;
    }
    if (pathname === "/api/coverage/capabilities") {
      await route.fulfill({ json: { commandTypes: [] } });
      return;
    }
    if (pathname === "/api/students-aggregated") {
      await aggregate.fulfill(route, url);
      return;
    }
    if (pathname === "/api/commands/active-state" && request.method() === "GET") {
      await route.fulfill({ json: { states: [] } });
      return;
    }
    if (/^\/api\/groups\/[^/]+\/subgroups$/.test(pathname)) {
      await route.fulfill({ json: { subgroups } });
      return;
    }
    const subgroupMembersMatch = pathname.match(/^\/api\/subgroups\/([^/]+)\/members$/);
    if (subgroupMembersMatch) {
      const subgroupId = decodeURIComponent(subgroupMembersMatch[1]);
      await route.fulfill({
        json: {
          members: (subgroupMembers[subgroupId] || []).map((studentId) => ({ studentId })),
        },
      });
      return;
    }
    if (/^\/api\/groups\/[^/]+\/students$/.test(pathname)) {
      await route.fulfill({
        json: { students: groupStudentIds.map((studentId) => ({ id: studentId })) },
      });
      return;
    }
    if (pathname === "/api/teacher/raised-hands") {
      await route.fulfill({ json: { raisedHands: [] } });
      return;
    }
    if (pathname === "/api/teacher/messages") {
      await route.fulfill({ json: { messages: [] } });
      return;
    }
    if (/^\/api\/classpilot\/teaching-sessions\/[^/]+\/observation-lease$/.test(pathname)) {
      observationLeaseRequests.push({
        method: request.method(),
        pathname,
        body: request.postData() ? request.postDataJSON() : null,
      });
      await route.fulfill({ json: { renewAfterSeconds: 30 } });
      return;
    }
    if (pathname === "/api/classpilot/tiles/screenshots" || pathname === "/api/classpilot/tiles/history") {
      const body = request.postDataJSON();
      tileRequests.push({
        pathname,
        body,
      });
      const suppliedResponse = pathname.endsWith("/screenshots") ? screenshotTiles : historyTiles;
      const response = typeof suppliedResponse === "function"
        ? suppliedResponse(body)
        : suppliedResponse;
      if (Number.isInteger(response?.status) && response.status >= 400) {
        await route.fulfill({
          status: response.status,
          json: response.body || { error: "Tile data unavailable" },
        });
        return;
      }
      const requestedStudentIds = new Set(body?.studentIds || []);
      await route.fulfill({
        json: {
          ...response,
          tiles: (response?.tiles || []).filter((tile) => requestedStudentIds.has(tile?.studentId)),
        },
      });
      return;
    }
    if (
      request.method() === "POST"
      && (
        pathname.startsWith("/api/commands")
        || pathname === "/api/classpilot/commands"
        || /^\/api\/classpilot\/coverage\/contexts\/[^/]+\/commands$/.test(pathname)
      )
    ) {
      commandPosts.push({ pathname, body: request.postDataJSON() });
      await route.fulfill({ status: 500, json: { error: "A command must not be sent in this test state" } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });

  return {
    commandPosts,
    coverageMutationRequests,
    observationLeaseRequests,
    pageErrors,
    tileRequests,
    async authenticateWebSocket() {
      await waitUntil(
        () => Boolean(dashboardSocket),
        "Dashboard WebSocket must send its auth frame",
      );
      if (websocketAuthenticated) return;
      websocketAuthenticated = true;
      dashboardSocket.send(JSON.stringify({ type: "auth-success" }));
    },
    async sendWebSocketMessage(message) {
      await waitUntil(
        () => Boolean(dashboardSocket),
        "Dashboard WebSocket must send its auth frame",
      );
      dashboardSocket.send(JSON.stringify(message));
    },
  };
}

async function assertKnownZeroCounts(page) {
  for (const testId of [
    "text-online-count",
    "text-idle-count",
    "text-offline-count",
    "text-offtask-count",
  ]) {
    assert.equal((await page.getByTestId(testId).innerText()).trim(), "0");
  }
  assert.match(await page.getByTestId("badge-selection-count").innerText(), /All 0 students/);
  assert.match(await page.getByTestId("badge-selection-count").innerText(), /0 connected/);
}

async function assertUnknownCounts(page) {
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="text-online-count"]')?.textContent?.trim() === "—"
  ));
  for (const testId of [
    "text-online-count",
    "text-idle-count",
    "text-offline-count",
    "text-offtask-count",
  ]) {
    assert.equal((await page.getByTestId(testId).innerText()).trim(), "—");
  }
  assert.match(await page.getByTestId("badge-selection-count").innerText(), /Student data unavailable/i);
  assert.match(await page.getByTestId("badge-selection-count").innerText(), /Counts unavailable/);
}

async function assertCommandEntryPointsUnavailable(page, commandPosts) {
  for (const testId of [
    "button-open-tab",
    "button-tabs",
    "button-lock-screen",
    "button-lock-url",
    "button-apply-flight-path",
    "button-flight-path-status",
    "button-apply-block-list",
    "button-block-list-status",
    "button-sign-out-students",
    "dialog-open-tab",
    "dialog-lock-screen",
    "dialog-send-message",
  ]) {
    assert.equal(await page.getByTestId(testId).count(), 0, `${testId} must not be reachable`);
  }
  assert.equal(await page.getByLabel("Quick Classroom Tools").count(), 0, "Teacher FAB must be unavailable");
  assert.deepEqual(commandPosts, [], "no command POST may be issued");
}

async function assertObserveEntryPointsUnavailable(page, commandPosts, studentIds, coverageMutationRequests) {
  await assertCommandEntryPointsUnavailable(page, commandPosts);
  assert.equal(await page.getByTestId("button-select-all-students").count(), 0, "Observe must hide Select All");
  assert.equal(await page.getByTestId("button-clear-selection").count(), 0, "Observe must hide Clear Selection");
  for (const testId of [
    "student-pickup-view-tabs",
    "button-view-class-students",
    "button-view-available-students",
    "button-view-claimed-students",
    "button-coverage-tab",
    "button-reroute-selected",
    "button-claim-selected-students",
    "button-claim-all-students",
  ]) {
    assert.equal(await page.getByTestId(testId).count(), 0, `${testId} must be unavailable in Observe`);
  }
  assert.equal(await page.getByTestId("video-portal").count(), 0, "Observe must not render expanded Live View");

  for (const studentId of studentIds) {
    assert.equal(
      await page.getByTestId(`checkbox-select-student-${studentId}`).count(),
      0,
      `Observe must not expose selection for ${studentId}`,
    );
    assert.equal(
      await page.getByTestId(`button-live-view-${studentId}`).count(),
      0,
      `Observe must not expose Live View for ${studentId}`,
    );
    assert.equal(
      await page.getByTestId(`button-manage-tabs-${studentId}`).count(),
      0,
      `Observe must not expose tab commands for ${studentId}`,
    );
    const lockToggle = page.getByTestId(`button-lock-toggle-${studentId}`);
    if (await lockToggle.count() > 0) {
      assert.equal(
        await lockToggle.isDisabled(),
        true,
        `Observe must disable the tile command for ${studentId}`,
      );
    }
  }
  assert.deepEqual(coverageMutationRequests, [], "Observe must not issue coverage mutations");
}

test("ClassPilot distinguishes empty, failed, cached, Observe, and malformed aggregate states", { timeout: 120_000 }, async () => {
  const dashboardSource = readFileSync(
    path.join(APP_ROOT, "src/products/classpilot/pages/Dashboard.jsx"),
    "utf8",
  );
  assert.match(
    dashboardSource,
    /const LIVE_VIEW_UI_ENABLED = false;/,
    "the unstable WebRTC entrypoint must stay dormant while its implementation is retained",
  );
  assert.match(
    dashboardSource,
    /\{LIVE_VIEW_UI_ENABLED\s*&&\s*dashboardCapabilities\.canUseLiveView\s*&&\s*liveViewState\.expanded/,
    "the retained WebRTC portal must remain behind the dormant UI gate",
  );

  const vite = await createServer({
    root: APP_ROOT,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite must listen on a local TCP port");
  const baseURL = `http://127.0.0.1:${address.port}`;

  let browser;
  const pages = [];
  try {
    browser = await chromium.launch({ headless: true });

    const emptyPage = await browser.newPage();
    pages.push(emptyPage);
    const emptyAggregate = aggregateController({ school: success({ students: [] }) });
    const emptyHarness = await configureDashboard(emptyPage, { aggregate: emptyAggregate });
    await emptyPage.goto(`${baseURL}/classpilot`);
    await emptyPage.getByText("No students are available in this view.", { exact: true }).waitFor();
    await assertKnownZeroCounts(emptyPage);
    assert.equal(
      emptyAggregate.requests.some((request) => request.teachingSessionId !== null),
      false,
      "admin-school aggregate request must not invent a teachingSessionId",
    );
    assert.equal(await emptyPage.getByTestId("students-query-error").count(), 0);
    assert.equal(await emptyPage.getByTestId("students-refresh-error").count(), 0);
    assert.deepEqual(emptyHarness.pageErrors, []);

    const initialFailurePage = await browser.newPage();
    pages.push(initialFailurePage);
    const ownSession = teachingSession();
    const initialFailureAggregate = aggregateController({
      school: success([]),
      scoped: pending(),
    });
    const initialFailureHarness = await configureDashboard(initialFailurePage, {
      aggregate: initialFailureAggregate,
      activeSession: ownSession,
      allSessions: [ownSession],
    });
    await initialFailurePage.goto(`${baseURL}/classpilot`);
    await waitUntil(
      () => initialFailureAggregate.requests.some((request) => request.teachingSessionId === OWN_SESSION_ID),
      "owned-session aggregate request must start",
    );
    await assertUnknownCounts(initialFailurePage);
    await assertCommandEntryPointsUnavailable(initialFailurePage, initialFailureHarness.commandPosts);

    initialFailureAggregate.setScopedResponse(failure({
      requestId: "req.initial_500-1",
      headerRequestId: "req-header-ignored",
    }));
    await initialFailurePage.getByTestId("students-query-error").waitFor();
    assert.equal(
      (await initialFailurePage.getByTestId("students-error-request-id").innerText()).trim(),
      "Request ID: req.initial_500-1",
      "a valid response-body request ID must win over the response header",
    );
    assert.match(await initialFailurePage.getByTestId("students-query-error").innerText(), /Student data could not be loaded from the server/);
    assert.doesNotMatch(await initialFailurePage.getByTestId("students-query-error").innerText(), /Request failed with status code 500/);
    await assertUnknownCounts(initialFailurePage);
    await assertCommandEntryPointsUnavailable(initialFailurePage, initialFailureHarness.commandPosts);
    assert.ok(
      initialFailureAggregate.requests.filter((request) => request.teachingSessionId === OWN_SESSION_ID).length >= 2,
      "the existing one-retry query policy must remain in effect",
    );

    initialFailureAggregate.setScopedResponse(success({ students: [] }));
    await initialFailurePage.getByRole("button", { name: "Try again" }).click();
    await initialFailurePage.getByTestId("students-query-error").waitFor({ state: "hidden" });
    await initialFailurePage.getByText("No students are available in this view.", { exact: true }).waitFor();
    await assertKnownZeroCounts(initialFailurePage);
    await initialFailurePage.getByTestId("button-open-tab").waitFor();
    assert.deepEqual(initialFailureHarness.commandPosts, []);
    assert.deepEqual(initialFailureHarness.pageErrors, []);

    const cachedEmptyPage = await browser.newPage();
    pages.push(cachedEmptyPage);
    const cachedEmptyAggregate = aggregateController({ school: success([]), scoped: success([]) });
    const cachedEmptyHarness = await configureDashboard(cachedEmptyPage, {
      aggregate: cachedEmptyAggregate,
      activeSession: ownSession,
      allSessions: [ownSession],
    });
    await cachedEmptyPage.goto(`${baseURL}/classpilot`);
    await cachedEmptyPage.getByText("No students are available in this view.", { exact: true }).waitFor();
    await cachedEmptyPage.getByTestId("button-open-tab").waitFor();
    cachedEmptyAggregate.setScopedResponse(failure({ requestId: "req-cached-empty" }));
    await cachedEmptyHarness.authenticateWebSocket();
    await cachedEmptyPage.getByTestId("students-refresh-error").waitFor();
    assert.equal(await cachedEmptyPage.getByTestId("students-query-error").count(), 0);
    assert.equal(
      (await cachedEmptyPage.getByTestId("students-refresh-request-id").innerText()).trim(),
      "Request ID: req-cached-empty",
    );
    await cachedEmptyPage.getByText("No students are available in this view.", { exact: true }).waitFor();
    await assertKnownZeroCounts(cachedEmptyPage);
    cachedEmptyAggregate.setScopedResponse(success({ students: [] }));
    await cachedEmptyPage.getByTestId("students-refresh-error").getByRole("button", { name: "Retry" }).click();
    await cachedEmptyPage.getByTestId("students-refresh-error").waitFor({ state: "hidden" });
    assert.deepEqual(cachedEmptyHarness.commandPosts, []);
    assert.deepEqual(cachedEmptyHarness.pageErrors, []);

    const cachedStudentPage = await browser.newPage();
    pages.push(cachedStudentPage);
    const cachedStudentAggregate = aggregateController({ school: success([]), scoped: success([student()]) });
    const cachedStudentHarness = await configureDashboard(cachedStudentPage, {
      aggregate: cachedStudentAggregate,
      activeSession: ownSession,
      allSessions: [ownSession],
    });
    await cachedStudentPage.goto(`${baseURL}/classpilot`);
    await cachedStudentPage.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
    cachedStudentAggregate.setScopedResponse(failure({ requestId: "req-cached-student" }));
    await cachedStudentHarness.authenticateWebSocket();
    await cachedStudentPage.getByTestId("students-refresh-error").waitFor();
    assert.equal(await cachedStudentPage.getByTestId("students-query-error").count(), 0);
    assert.equal(
      (await cachedStudentPage.getByTestId("students-refresh-request-id").innerText()).trim(),
      "Request ID: req-cached-student",
    );
    assert.equal(await cachedStudentPage.getByTestId(`card-student-${STUDENT_ID}`).count(), 1);
    assert.deepEqual(cachedStudentHarness.commandPosts, []);
    assert.deepEqual(cachedStudentHarness.pageErrors, []);

    const staleSignOutPage = await browser.newPage();
    pages.push(staleSignOutPage);
    const staleObservedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const staleSignOutAggregate = aggregateController({
      school: success([]),
      scoped: success({
        students: [student({
          monitoringState: "signal_lost",
          activityFresh: false,
          monitoringLostAt: staleObservedAt,
          lastSeenAt: staleObservedAt,
          realtimeObservedAt: staleObservedAt,
          realtimeBinding: "binding-stale-login",
        })],
      }),
    });
    const staleSignOutHarness = await configureDashboard(staleSignOutPage, {
      aggregate: staleSignOutAggregate,
      activeSession: ownSession,
      allSessions: [ownSession],
    });
    await staleSignOutPage.goto(`${baseURL}/classpilot`);
    const staleCheckbox = staleSignOutPage.getByTestId(`checkbox-select-student-${STUDENT_ID}`);
    await staleCheckbox.waitFor();
    assert.equal(await staleCheckbox.isDisabled(), false);
    await staleCheckbox.click();
    await staleSignOutPage.waitForFunction((studentId) => (
      document.querySelector(`[data-testid="checkbox-select-student-${studentId}"]`)?.getAttribute("data-state") === "checked"
    ), STUDENT_ID);
    assert.match(
      await staleSignOutPage.getByTestId("badge-selection-count").innerText(),
      /1 selected for sign-out only/,
    );
    for (const testId of [
      "button-open-tab",
      "button-tabs",
      "button-lock-screen",
      "button-unlock-screen",
      "button-apply-flight-path",
      "button-flight-path-status",
      "button-apply-block-list",
      "button-block-list-status",
      "button-select-all-students",
    ]) {
      assert.equal(
        await staleSignOutPage.getByTestId(testId).isDisabled(),
        true,
        `${testId} must stay disabled for a sign-out-only selection`,
      );
    }
    assert.equal(
      await staleSignOutPage.getByLabel("Quick Classroom Tools").count(),
      0,
      "Teacher FAB must close rather than fall back to a class-wide command",
    );
    assert.equal(
      await staleSignOutPage.getByTestId("button-reroute-selected").count(),
      0,
      "coverage reroute must not receive a sign-out-only selection",
    );
    await staleSignOutPage.getByTestId("button-sign-out-students").click();
    await staleSignOutPage.getByTestId("button-confirm-sign-out-students").click();
    await waitUntil(
      () => staleSignOutHarness.commandPosts.length === 1,
      "the exact student-sign-out command must be submitted",
    );
    assert.deepEqual(staleSignOutHarness.commandPosts, [{
      pathname: "/api/commands",
      body: {
        teachingSessionId: OWN_SESSION_ID,
        targetScope: "students",
        targetStudentIds: [STUDENT_ID],
        commandType: "student-sign-out",
        commandPayload: {},
      },
    }]);

    const replacementObservedAt = new Date(Date.now() - 500).toISOString();
    staleSignOutAggregate.setScopedResponse(success({
      students: [student({
        lastSeenAt: replacementObservedAt,
        realtimeObservedAt: replacementObservedAt,
        realtimeBinding: "binding-replacement-login",
        realtimeRevision: 2,
      })],
    }));
    const replacementRequestCount = staleSignOutAggregate.requests.length;
    await staleSignOutPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => staleSignOutAggregate.requests.length > replacementRequestCount,
      "binding replacement must reconcile the current roster",
    );
    await staleSignOutPage.waitForFunction((studentId) => (
      document.querySelector(`[data-testid="checkbox-select-student-${studentId}"]`)?.getAttribute("data-state") === "unchecked"
    ), STUDENT_ID);
    assert.equal(await staleSignOutPage.getByTestId("button-sign-out-students").isDisabled(), true);
    assert.equal(await staleSignOutPage.getByTestId("button-confirm-sign-out-students").isDisabled(), true);
    assert.equal(staleSignOutHarness.commandPosts.length, 1, "a replacement binding must not receive a delayed sign-out");
    assert.deepEqual(staleSignOutHarness.pageErrors, []);

    const persistencePage = await browser.newPage();
    pages.push(persistencePage);
    const persistenceObservedAt = new Date(Date.now() - 500).toISOString();
    const persistenceBindingVersion = "v2:persistent-owned-class-binding";
    let persistenceScreenshotAvailable = true;
    let persistenceScreenshotSource = TINY_SCREENSHOT_DATA_URL;
    let persistenceScreenshotCapturedAt = persistenceObservedAt;
    const persistenceClassmate = student({
      studentId: SIGNAL_LOST_STUDENT_ID,
      studentName: "Grace Classmate",
      studentEmail: "grace@example.edu",
      lastSeenAt: persistenceObservedAt,
      realtimeObservedAt: persistenceObservedAt,
      realtimeBinding: "binding-persistent-classmate",
    });
    const persistenceAggregate = aggregateController({
      school: success([]),
      scoped: success({
        students: [
          student({
            lastSeenAt: persistenceObservedAt,
            realtimeObservedAt: persistenceObservedAt,
          }),
          persistenceClassmate,
        ],
      }),
    });
    const persistenceHarness = await configureDashboard(persistencePage, {
      aggregate: persistenceAggregate,
      userRole: "teacher",
      activeSession: ownSession,
      allSessions: [ownSession],
      groupStudentIds: [STUDENT_ID, SIGNAL_LOST_STUDENT_ID],
      screenshotTiles: () => ({
        tiles: [{
          studentId: STUDENT_ID,
          bindingVersion: persistenceBindingVersion,
          screenshot: persistenceScreenshotAvailable ? {
            screenshot: persistenceScreenshotSource,
            timestamp: persistenceScreenshotCapturedAt,
            tabTitle: "Persistent class preview",
            tabUrl: "https://persistent.example.edu/current",
            bindingVersion: persistenceBindingVersion,
          } : null,
        }],
      }),
    });
    await persistencePage.goto(`${baseURL}/classpilot`);
    const persistenceScreenshot = persistencePage.getByTestId(`screenshot-${STUDENT_ID}`);
    await persistenceScreenshot.waitFor();
    assert.ok(
      persistenceHarness.tileRequests.some((request) => (
        request.pathname === "/api/classpilot/tiles/screenshots"
        && request.body?.studentIds?.length === 2
      )),
      "the recovery poll must retain the complete fixed screenshot cohort",
    );
    assert.equal(
      await persistencePage.getByTestId(`button-live-view-${STUDENT_ID}`).count(),
      0,
      "teacher tiles must hide the dormant WebRTC View entrypoint",
    );
    assert.equal(
      await persistencePage.getByTestId(`button-manage-tabs-${STUDENT_ID}`).count(),
      1,
      "hiding WebRTC View must retain the teacher's View Tabs action",
    );
    assert.equal(
      await persistencePage.getByTestId(`button-student-details-${STUDENT_ID}`).count(),
      1,
      "teacher tiles must expose an explicit Details action",
    );
    await persistenceHarness.authenticateWebSocket();
    const targetedRequestStart = persistenceHarness.tileRequests.length;
    persistenceScreenshotSource = UPDATED_SCREENSHOT_DATA_URL;
    persistenceScreenshotCapturedAt = new Date().toISOString();
    await persistenceHarness.sendWebSocketMessage({
      type: "screenshot-available",
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      teachingSessionId: OWN_SESSION_ID,
      capturedAt: persistenceScreenshotCapturedAt,
    });
    await waitUntil(
      () => persistenceHarness.tileRequests.slice(targetedRequestStart).some((request) => (
        request.pathname === "/api/classpilot/tiles/screenshots"
        && request.body?.teachingSessionId === OWN_SESSION_ID
        && request.body?.studentIds?.length === 1
        && request.body.studentIds[0] === STUDENT_ID
      )),
      "a screenshot event must fetch only the changed student in the exact teaching session",
    );
    await persistencePage.waitForFunction(
      ({ studentId, expectedSource }) => document.querySelector(`[data-testid="screenshot-${studentId}"]`)?.getAttribute("src") === expectedSource,
      { studentId: STUDENT_ID, expectedSource: UPDATED_SCREENSHOT_DATA_URL },
    );

    const screenshotOpener = persistencePage.getByTestId(`screenshot-current-${STUDENT_ID}`);
    await screenshotOpener.click();
    await persistencePage.getByTestId("expanded-screenshot-dialog").waitFor();
    await persistencePage.getByText("Automatically refreshed screenshot. Not live video.", { exact: true }).waitFor();
    assert.equal(
      await persistencePage.getByTestId("expanded-screenshot-dialog").getByRole("button", { name: /download/i }).count(),
      0,
      "the student screenshot viewer must not expose a download action",
    );
    assert.match(
      await persistencePage.getByTestId("expanded-screenshot-status").innerText(),
      /Updated .*Captured/,
      "the large viewer must show capture age and time",
    );
    for (const zoom of ["fit", "100", "125", "150", "200"]) {
      assert.equal(
        await persistencePage.getByTestId(`expanded-screenshot-zoom-${zoom}`).count(),
        1,
        `the large viewer must expose the ${zoom} zoom option`,
      );
    }
    await persistencePage.getByTestId("expanded-screenshot-zoom-125").click();
    assert.equal(
      await persistencePage.getByTestId("expanded-screenshot-zoom-125").getAttribute("aria-pressed"),
      "true",
    );

    persistenceScreenshotSource = VIEWER_SCREENSHOT_DATA_URL;
    persistenceScreenshotCapturedAt = new Date().toISOString();
    await persistenceHarness.sendWebSocketMessage({
      type: "screenshot-available",
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      teachingSessionId: OWN_SESSION_ID,
      capturedAt: persistenceScreenshotCapturedAt,
    });
    await persistencePage.waitForFunction(
      (expectedSource) => document.querySelector('[data-testid="expanded-screenshot-image"]')?.getAttribute("src") === expectedSource,
      VIEWER_SCREENSHOT_DATA_URL,
    );
    assert.equal(await persistencePage.getByTestId("expanded-screenshot-dialog").count(), 1);
    const decodedViewerStatus = await persistencePage.getByTestId("expanded-screenshot-status").innerText();
    const decodedViewerCaptureLabel = decodedViewerStatus.match(/Captured (.+)$/)?.[1];
    assert.ok(
      decodedViewerCaptureLabel,
      "the decoded viewer frame must expose its committed capture metadata",
    );

    await persistencePage.waitForTimeout(5_200);
    persistenceScreenshotSource = "data:image/jpeg;base64,not-a-valid-jpeg";
    persistenceScreenshotCapturedAt = new Date().toISOString();
    const corruptReplacementRequestStart = persistenceHarness.tileRequests.length;
    await persistenceHarness.sendWebSocketMessage({
      type: "screenshot-available",
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      teachingSessionId: OWN_SESSION_ID,
      capturedAt: persistenceScreenshotCapturedAt,
    });
    await waitUntil(
      () => persistenceHarness.tileRequests.length > corruptReplacementRequestStart,
      "the corrupt replacement must reach the exact screenshot endpoint",
    );
    await persistencePage.waitForFunction(
      (previousStatus) => document.querySelector('[data-testid="expanded-screenshot-status"]')?.innerText !== previousStatus,
      decodedViewerStatus,
    );
    assert.equal(
      await persistencePage.getByTestId("expanded-screenshot-image").getAttribute("src"),
      VIEWER_SCREENSHOT_DATA_URL,
      "a corrupt same-context replacement must retain the last decoded frame",
    );
    const corruptReplacementStatus = await persistencePage.getByTestId("expanded-screenshot-status").innerText();
    assert.equal(
      corruptReplacementStatus.match(/Captured (.+)$/)?.[1],
      decodedViewerCaptureLabel,
      "a corrupt replacement must retain the prior decoded frame's exact capture metadata",
    );
    persistenceScreenshotSource = VIEWER_SCREENSHOT_DATA_URL;
    persistenceScreenshotCapturedAt = new Date().toISOString();
    await persistenceHarness.sendWebSocketMessage({
      type: "screenshot-available",
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      teachingSessionId: OWN_SESSION_ID,
      capturedAt: persistenceScreenshotCapturedAt,
    });

    const confirmedLossAt = new Date(Date.now() - 95_000).toISOString();
    persistenceAggregate.setScopedResponse(success({
      students: [
        student({
          monitoringState: "signal_lost",
          activityFresh: false,
          monitoringLostAt: confirmedLossAt,
          lastSeenAt: confirmedLossAt,
          realtimeObservedAt: confirmedLossAt,
          realtimeRevision: 2,
        }),
        persistenceClassmate,
      ],
    }));
    await persistencePage.evaluate(() => window.dispatchEvent(new Event("online")));
    await persistencePage.getByTestId("expanded-screenshot-unavailable").waitFor();
    assert.equal(
      await persistencePage.getByTestId("expanded-screenshot-image").count(),
      0,
      "confirmed signal loss must remove pixels without closing the large viewer",
    );
    assert.equal(await persistencePage.getByTestId("expanded-screenshot-dialog").count(), 1);

    const recoveredAt = new Date().toISOString();
    persistenceAggregate.setScopedResponse(success({
      students: [
        student({
          lastSeenAt: recoveredAt,
          realtimeObservedAt: recoveredAt,
          realtimeRevision: 3,
        }),
        persistenceClassmate,
      ],
    }));
    await persistencePage.evaluate(() => window.dispatchEvent(new Event("online")));
    await persistencePage.waitForFunction(
      (expectedSource) => document.querySelector('[data-testid="expanded-screenshot-image"]')?.getAttribute("src") === expectedSource,
      VIEWER_SCREENSHOT_DATA_URL,
    );
    assert.equal(
      await persistencePage.getByTestId("expanded-screenshot-zoom-125").getAttribute("aria-pressed"),
      "true",
      "soft monitoring loss and recovery must preserve the viewer zoom",
    );
    await persistencePage.keyboard.press("Escape");
    await persistencePage.getByTestId("expanded-screenshot-dialog").waitFor({ state: "hidden" });
    assert.equal(
      await screenshotOpener.evaluate((element) => document.activeElement === element),
      true,
      "closing the large viewer must restore keyboard focus to its screenshot tile",
    );

    await persistencePage.getByTestId(`text-student-name-${STUDENT_ID}`).click();
    await persistencePage.getByTestId("expanded-screenshot-dialog").waitFor();
    assert.equal(
      await persistencePage.getByTestId("student-tabs").count(),
      0,
      "clicking the teacher tile body must enlarge the screenshot without opening Details",
    );
    await persistencePage.getByTestId("expanded-screenshot-dialog").getByRole("button", { name: "Close" }).click();
    await persistencePage.getByTestId("expanded-screenshot-dialog").waitFor({ state: "hidden" });

    const teacherDetailsButton = persistencePage.getByTestId(`button-student-details-${STUDENT_ID}`);
    await teacherDetailsButton.click();
    await persistencePage.getByTestId("student-tabs").waitFor();
    assert.equal(
      await persistencePage.getByTestId("expanded-screenshot-dialog").count(),
      0,
      "Details must open only the existing student sidebar",
    );
    await persistencePage.getByRole("button", { name: "Close" }).click();
    await persistencePage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    assert.equal(
      await teacherDetailsButton.evaluate((element) => document.activeElement === element),
      true,
      "closing the teacher Details sidebar must restore focus to Details",
    );
    persistenceScreenshotAvailable = false;

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const hiddenViewTestId = cycle % 2 === 0
        ? "button-view-available-students"
        : "button-view-claimed-students";
      await persistencePage.getByTestId(hiddenViewTestId).click();
      await persistenceScreenshot.waitFor({ state: "hidden" });
      await persistencePage.getByTestId("button-view-class-students").click();
      await persistenceScreenshot.waitFor();
      assert.equal(
        await persistenceScreenshot.getAttribute("src"),
        VIEWER_SCREENSHOT_DATA_URL,
        `cycle ${cycle + 1} must synchronously reuse the exact V2 class preview`,
      );
    }

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await persistencePage.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await persistencePage.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await persistenceScreenshot.waitFor();
    }
    assert.deepEqual(persistenceHarness.pageErrors, []);

    const detailsRevocationPage = await browser.newPage();
    pages.push(detailsRevocationPage);
    const detailsObservedAt = new Date(Date.now() - 500).toISOString();
    const detailsClassmate = student({
      studentId: SIGNAL_LOST_STUDENT_ID,
      studentName: "Grace Classmate",
      studentEmail: "grace@example.edu",
      lastSeenAt: detailsObservedAt,
      realtimeObservedAt: detailsObservedAt,
      realtimeBinding: "binding-details-classmate",
    });
    const authorizedDetailsStudent = (overrides = {}) => student({
      lastSeenAt: detailsObservedAt,
      realtimeObservedAt: detailsObservedAt,
      realtimeBinding: "binding-details-student",
      ...overrides,
    });
    const detailsRevocationAggregate = aggregateController({
      school: success([]),
      scoped: success({
        students: [authorizedDetailsStudent(), detailsClassmate],
      }),
    });
    let globallyDenyDetailHistory = false;
    const detailsRevocationHarness = await configureDashboard(detailsRevocationPage, {
      aggregate: detailsRevocationAggregate,
      userRole: "teacher",
      activeSession: ownSession,
      allSessions: [ownSession],
      groupStudentIds: [STUDENT_ID, SIGNAL_LOST_STUDENT_ID],
      historyTiles: (body) => (
        globallyDenyDetailHistory && body?.studentIds?.length === 1
          ? { status: 403, body: { error: "History authorization revoked" } }
          : { tiles: [] }
      ),
    });
    const detailHistoryRequestCount = () => detailsRevocationHarness.tileRequests.filter((request) => (
      request.pathname === "/api/classpilot/tiles/history"
      && request.body?.studentIds?.length === 1
      && request.body.studentIds[0] === STUDENT_ID
    )).length;

    await detailsRevocationPage.goto(`${baseURL}/classpilot`);
    let revocationDetailsButton = detailsRevocationPage.getByTestId(`button-student-details-${STUDENT_ID}`);
    await revocationDetailsButton.waitFor();
    await revocationDetailsButton.click();
    await detailsRevocationPage.getByTestId("student-tabs").waitFor();
    await waitUntil(
      () => detailHistoryRequestCount() >= 1,
      "opening Details must issue one authorized student-scoped history request",
    );

    const delegatedAggregateRequestStart = detailsRevocationAggregate.requests.length;
    detailsRevocationAggregate.setScopedResponse(success({
      students: [
        authorizedDetailsStudent({
          activityState: "delegated",
          realtimeRevision: 2,
        }),
        detailsClassmate,
      ],
    }));
    await detailsRevocationPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => detailsRevocationAggregate.requests.length > delegatedAggregateRequestStart,
      "delegation must reconcile the selected student's current authority",
    );
    await detailsRevocationPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    assert.equal(
      await detailsRevocationPage.getByTestId(`button-student-details-${STUDENT_ID}`).count(),
      0,
      "delegated monitoring must hide Details immediately",
    );
    const detailRequestsAfterDelegation = detailHistoryRequestCount();
    const delegatedRecheckStart = detailsRevocationAggregate.requests.length;
    await detailsRevocationPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => detailsRevocationAggregate.requests.length > delegatedRecheckStart,
      "delegated authority must remain closed across reconciliation",
    );
    await detailsRevocationPage.waitForTimeout(150);
    assert.equal(
      detailHistoryRequestCount(),
      detailRequestsAfterDelegation,
      "delegated monitoring must not issue another detail-history query",
    );

    const restoredAuthorityRequestStart = detailsRevocationAggregate.requests.length;
    detailsRevocationAggregate.setScopedResponse(success({
      students: [authorizedDetailsStudent({ realtimeRevision: 3 }), detailsClassmate],
    }));
    await detailsRevocationPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => detailsRevocationAggregate.requests.length > restoredAuthorityRequestStart,
      "the authorized student must reconcile after delegation ends",
    );
    revocationDetailsButton = detailsRevocationPage.getByTestId(`button-student-details-${STUDENT_ID}`);
    await revocationDetailsButton.waitFor();
    assert.equal(
      await detailsRevocationPage.getByTestId("student-tabs").count(),
      0,
      "restored authority must not reopen a previously revoked drawer",
    );

    await revocationDetailsButton.click();
    await detailsRevocationPage.getByTestId("student-tabs").waitFor();
    await waitUntil(
      () => detailHistoryRequestCount() > detailRequestsAfterDelegation,
      "restored authority must permit a new explicit Details request",
    );
    const removedDetailsOpener = await revocationDetailsButton.elementHandle();
    assert.ok(removedDetailsOpener);
    const removalRequestStart = detailsRevocationAggregate.requests.length;
    detailsRevocationAggregate.setScopedResponse(success({ students: [detailsClassmate] }));
    await detailsRevocationPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => detailsRevocationAggregate.requests.length > removalRequestStart,
      "roster removal must reconcile before selection can be reused",
    );
    await detailsRevocationPage.getByTestId(`card-student-${STUDENT_ID}`).waitFor({ state: "hidden" });
    await detailsRevocationPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    assert.equal(
      await removedDetailsOpener.evaluate((element) => element.isConnected),
      false,
      "roster removal must detach the old Details opener",
    );
    assert.equal(
      await removedDetailsOpener.evaluate((element) => document.activeElement === element),
      false,
      "roster removal must not restore focus to a stale Details opener",
    );
    const detailRequestsAfterRemoval = detailHistoryRequestCount();

    const readdRequestStart = detailsRevocationAggregate.requests.length;
    detailsRevocationAggregate.setScopedResponse(success({
      students: [authorizedDetailsStudent({ realtimeRevision: 4 }), detailsClassmate],
    }));
    await detailsRevocationPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => detailsRevocationAggregate.requests.length > readdRequestStart,
      "re-added roster authority must reconcile explicitly",
    );
    const readdedDetailsButton = detailsRevocationPage.getByTestId(`button-student-details-${STUDENT_ID}`);
    await readdedDetailsButton.waitFor();
    await detailsRevocationPage.waitForTimeout(150);
    assert.equal(
      await detailsRevocationPage.getByTestId("student-tabs").count(),
      0,
      "remove then re-add must not reopen the old drawer",
    );
    assert.equal(
      await readdedDetailsButton.evaluate((element) => document.activeElement === element),
      false,
      "remove then re-add must not focus the replacement Details button",
    );
    assert.equal(
      detailHistoryRequestCount(),
      detailRequestsAfterRemoval,
      "remove then re-add must not reuse selection to issue another detail-history query",
    );

    globallyDenyDetailHistory = true;
    await readdedDetailsButton.click();
    await waitUntil(
      () => detailHistoryRequestCount() > detailRequestsAfterRemoval,
      "the explicit Details action must reach the globally denied history boundary",
    );
    await detailsRevocationPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    assert.equal(
      await detailsRevocationPage.getByTestId(`button-student-details-${STUDENT_ID}`).count(),
      0,
      "a global tile authorization failure must hide Details for the selected student",
    );
    assert.equal(
      await detailsRevocationPage.getByTestId(`button-student-details-${SIGNAL_LOST_STUDENT_ID}`).count(),
      0,
      "a global tile authorization failure must hide Details across the cohort",
    );
    const detailRequestsAfterGlobalDenial = detailHistoryRequestCount();
    const globalDenialRecheckStart = detailsRevocationAggregate.requests.length;
    await detailsRevocationPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => detailsRevocationAggregate.requests.length > globalDenialRecheckStart,
      "global denial must remain closed across aggregate reconciliation",
    );
    await detailsRevocationPage.waitForTimeout(150);
    assert.equal(
      detailHistoryRequestCount(),
      detailRequestsAfterGlobalDenial,
      "global authorization revocation must disable future detail-history queries",
    );
    assert.deepEqual(detailsRevocationHarness.pageErrors, []);

    const noAccessDetailsPage = await browser.newPage();
    pages.push(noAccessDetailsPage);
    const noAccessObservedAt = new Date(Date.now() - 500).toISOString();
    const noAccessClassmate = student({
      studentId: SIGNAL_LOST_STUDENT_ID,
      studentName: "Grace Classmate",
      studentEmail: "grace@example.edu",
      lastSeenAt: noAccessObservedAt,
      realtimeObservedAt: noAccessObservedAt,
      realtimeBinding: "binding-no-access-classmate",
    });
    const noAccessStudent = (overrides = {}) => student({
      lastSeenAt: noAccessObservedAt,
      realtimeObservedAt: noAccessObservedAt,
      realtimeBinding: "binding-no-access-student",
      ...overrides,
    });
    const noAccessAggregate = aggregateController({
      school: success([]),
      scoped: success({ students: [noAccessStudent(), noAccessClassmate] }),
    });
    let historyNoLongerAuthorized = false;
    const noAccessHarness = await configureDashboard(noAccessDetailsPage, {
      aggregate: noAccessAggregate,
      userRole: "teacher",
      activeSession: ownSession,
      allSessions: [ownSession],
      groupStudentIds: [STUDENT_ID, SIGNAL_LOST_STUDENT_ID],
      historyTiles: (body) => (
        historyNoLongerAuthorized && body?.studentIds?.length === 1
          ? { status: 404, body: { error: "History is not available in this roster" } }
          : { tiles: [] }
      ),
    });
    const noAccessDetailHistoryCount = () => noAccessHarness.tileRequests.filter((request) => (
      request.pathname === "/api/classpilot/tiles/history"
      && request.body?.studentIds?.length === 1
      && request.body.studentIds[0] === STUDENT_ID
    )).length;

    await noAccessDetailsPage.goto(`${baseURL}/classpilot`);
    const noAccessDetailsButton = noAccessDetailsPage.getByTestId(`button-student-details-${STUDENT_ID}`);
    await noAccessDetailsButton.waitFor();
    await noAccessDetailsButton.click();
    await noAccessDetailsPage.getByTestId("student-tabs").waitFor();
    await waitUntil(
      () => noAccessDetailHistoryCount() >= 1,
      "the initially authorized Details request must finish before access is removed",
    );

    const detailHistoryCountBeforeNoAccess = noAccessDetailHistoryCount();
    historyNoLongerAuthorized = true;
    const noAccessTileRequestStart = noAccessHarness.tileRequests.length;
    const noAccessRequestStart = noAccessAggregate.requests.length;
    noAccessAggregate.setScopedResponse(success({
      students: [
        noAccessStudent({
          realtimeBinding: "binding-no-access-replaced",
          realtimeRevision: 2,
        }),
        noAccessClassmate,
      ],
    }));
    await noAccessDetailsPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => noAccessAggregate.requests.length > noAccessRequestStart,
      "the replacement binding must reconcile before its history denial is enforced",
    );
    await waitUntil(
      () => noAccessHarness.tileRequests.slice(noAccessTileRequestStart).some((request) => (
        request.pathname === "/api/classpilot/tiles/history"
        && request.body?.studentIds?.length === 1
        && request.body.studentIds[0] === STUDENT_ID
      )),
      "the selected student's exact detail request must reach the 404 history boundary",
    );
    await noAccessDetailsPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    await noAccessDetailsPage.getByTestId(`button-student-details-${STUDENT_ID}`).waitFor({ state: "hidden" });
    assert.equal(
      await noAccessDetailsPage.getByTestId(`button-student-details-${STUDENT_ID}`).count(),
      0,
      "a memoized tile must remove Details when a single-detail 404 revokes history access",
    );
    const detailHistoryCountAfterNoAccess = noAccessDetailHistoryCount();
    assert.ok(
      detailHistoryCountAfterNoAccess > detailHistoryCountBeforeNoAccess,
      "the denied replacement must record its one already-started detail request",
    );
    const noAccessRecheckStart = noAccessAggregate.requests.length;
    await noAccessDetailsPage.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitUntil(
      () => noAccessAggregate.requests.length > noAccessRecheckStart,
      "the 404 state must remain closed across aggregate reconciliation",
    );
    await noAccessDetailsPage.waitForTimeout(150);
    assert.equal(
      noAccessDetailHistoryCount(),
      detailHistoryCountAfterNoAccess,
      "a 404 history denial must prevent follow-on detail queries",
    );
    assert.deepEqual(noAccessHarness.pageErrors, []);

    const observedSession = teachingSession({
      id: OBSERVED_SESSION_ID,
      groupId: OBSERVED_GROUP_ID,
      teacherId: OTHER_TEACHER_ID,
    });
    const observeTransitionPage = await browser.newPage();
    pages.push(observeTransitionPage);
    const transitionObservedAt = new Date(Date.now() - 1_000).toISOString();
    const observeTransitionAggregate = aggregateController({
      school: success([]),
      scoped: success({
        students: [student({
          lastSeenAt: transitionObservedAt,
          realtimeObservedAt: transitionObservedAt,
          activeTabTitle: "Unapproved game",
          activeTabUrl: "https://carryover.example.edu/game",
          aiClassification: { category: "non-educational" },
        })],
      }),
    });
    const observeTransitionHarness = await configureDashboard(observeTransitionPage, {
      aggregate: observeTransitionAggregate,
      activeSession: ownSession,
      allSessions: [ownSession, observedSession],
    });
    await observeTransitionPage.goto(`${baseURL}/classpilot`);
    const transitionCard = observeTransitionPage.getByTestId(`card-student-${STUDENT_ID}`);
    await transitionCard.getByTestId(`badge-offtask-${STUDENT_ID}`).waitFor();
    await transitionCard.getByTestId(`button-allow-domain-${STUDENT_ID}`).click();
    await transitionCard.getByTestId(`badge-offtask-${STUDENT_ID}`).waitFor({ state: "hidden" });
    await observeTransitionPage.getByTestId("button-open-tab").click();
    await observeTransitionPage.getByTestId("dialog-open-tab").waitFor();
    await observeTransitionPage.getByTestId("select-admin-observe").evaluate((select, sessionId) => {
      select.value = sessionId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, OBSERVED_SESSION_ID);
    await observeTransitionPage.getByTestId("observe-read-only-banner").waitFor();
    await observeTransitionPage.getByTestId("dialog-open-tab").waitFor({ state: "hidden" });
    await transitionCard.getByTestId(`badge-offtask-${STUDENT_ID}`).waitFor();
    await assertObserveEntryPointsUnavailable(
      observeTransitionPage,
      observeTransitionHarness.commandPosts,
      [STUDENT_ID],
      observeTransitionHarness.coverageMutationRequests,
    );
    assert.deepEqual(observeTransitionHarness.pageErrors, []);

    const observePreviewPage = await browser.newPage();
    pages.push(observePreviewPage);
    const freshObservedAt = new Date(Date.now() - 1_000).toISOString();
    const observedStudent = student({
      lastSeenAt: freshObservedAt,
      realtimeObservedAt: freshObservedAt,
    });
    const movableObservedStudent = student({
      studentId: MOVED_CLASS_STUDENT_ID,
      studentName: "Mia Moved Class",
      studentEmail: "mia@example.edu",
      activeTabTitle: "Reading assignment",
      activeTabUrl: "https://reading.example.edu/chapter",
      lastSeenAt: freshObservedAt,
      realtimeObservedAt: freshObservedAt,
      realtimeBinding: "binding-movable",
    });
    const observePreviewAggregate = aggregateController({
      school: success([]),
      scoped: success({ students: [observedStudent, movableObservedStudent] }),
    });
    let returnedTelemetryEnabled = false;
    const observeBindingVersion = "v2:persistent-observe-binding";
    const observePreviewHarness = await configureDashboard(observePreviewPage, {
      aggregate: observePreviewAggregate,
      activeSession: null,
      allSessions: [observedSession],
      blockedDomains: ["supervised-secret.example.edu", "moved-secret.example.edu"],
      groupStudentIds: [SIGNED_OUT_STUDENT_ID],
      subgroups: [{ id: OBSERVED_SUBGROUP_ID, name: "Needs Check-In" }],
      subgroupMembers: {
        [OBSERVED_SUBGROUP_ID]: [SIGNAL_LOST_STUDENT_ID],
      },
      screenshotTiles: () => ({
        tiles: [{
          studentId: STUDENT_ID,
          bindingVersion: observeBindingVersion,
          screenshot: {
            screenshot: TINY_SCREENSHOT_DATA_URL,
            timestamp: freshObservedAt,
            tabTitle: returnedTelemetryEnabled ? "Returned after supervision" : "Observed lesson screen",
            tabUrl: returnedTelemetryEnabled
              ? "https://returned.example.edu/current"
              : "https://lesson.example.edu/current",
            bindingVersion: observeBindingVersion,
          },
        }],
      }),
      historyTiles: () => ({
        tiles: [{
          studentId: STUDENT_ID,
          heartbeats: [{
            activeTabUrl: returnedTelemetryEnabled
              ? "https://returned.example.edu/activity"
              : "https://research.example.edu/article",
            activeTabTitle: returnedTelemetryEnabled ? "Returned activity" : "Research history",
            favicon: TINY_SCREENSHOT_DATA_URL,
            timestamp: freshObservedAt,
          }],
        }],
      }),
    });
    await observePreviewPage.goto(`${baseURL}/classpilot`);
    await observePreviewPage.getByTestId("button-view-available-students").click();
    await observePreviewPage.getByTestId("button-claim-selected-students").waitFor();
    await observePreviewPage.getByTestId("select-admin-observe").selectOption(OBSERVED_SESSION_ID);
    await observePreviewPage.getByTestId("observe-read-only-banner").waitFor();

    const observedCard = observePreviewPage.getByTestId(`card-student-${STUDENT_ID}`);
    await observedCard.waitFor();
    const screenshot = observedCard.getByTestId(`screenshot-${STUDENT_ID}`);
    await screenshot.waitFor();
    assert.equal(await screenshot.getAttribute("src"), TINY_SCREENSHOT_DATA_URL);
    await observedCard.getByTestId(`screenshot-current-${STUDENT_ID}`).click();
    await observePreviewPage.getByTestId("expanded-screenshot-dialog").waitFor();
    await observePreviewPage.getByText("Automatically refreshed screenshot. Not live video.", { exact: true }).waitFor();
    await observePreviewPage.getByTestId("expanded-screenshot-dialog").getByRole("button", { name: "Close" }).click();
    await observePreviewPage.getByTestId("expanded-screenshot-dialog").waitFor({ state: "hidden" });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await observePreviewPage.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await observePreviewPage.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await screenshot.waitFor();
    }
    await observedCard.getByText("Recent", { exact: true }).waitFor();
    await observedCard.locator('[title="Research history"]').waitFor();
    assert.equal(await observedCard.getByText(/In supervision/i).count(), 0);
    assert.equal(await observedCard.getByText("Controls locked", { exact: true }).count(), 0);
    await observedCard.getByText("Ada Student", { exact: true }).click();
    await observePreviewPage.getByTestId("expanded-screenshot-dialog").waitFor();
    assert.equal(
      await observePreviewPage.getByTestId("student-tabs").count(),
      0,
      "clicking an Observe tile body must enlarge the screenshot without opening Details",
    );
    await observePreviewPage.getByTestId("expanded-screenshot-dialog").getByRole("button", { name: "Close" }).click();
    await observePreviewPage.getByTestId("expanded-screenshot-dialog").waitFor({ state: "hidden" });

    const observeDetailsButton = observedCard.getByTestId(`button-student-details-${STUDENT_ID}`);
    await observeDetailsButton.click();
    await observePreviewPage.getByTestId("student-tabs").waitFor();
    assert.equal(await observePreviewPage.getByTestId("tab-screens").count(), 1, "ordinary Observe must open the read-only detail drawer");
    assert.equal(
      await observePreviewPage.getByTestId("expanded-screenshot-dialog").count(),
      0,
      "Observe Details must not reopen the screenshot viewer",
    );
    await observePreviewPage.getByRole("button", { name: "Close" }).click();
    await observePreviewPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    assert.equal(
      await observeDetailsButton.evaluate((element) => document.activeElement === element),
      true,
      "closing the Observe Details sidebar must restore focus to Details",
    );
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 2 students\n2 connected · 0 updating · 0 signal lost · 0 updates unavailable · 0 signed out",
    );
    await observePreviewPage.getByTestId("input-search-students").fill("No matching student");
    await observedCard.waitFor({ state: "hidden" });
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 2 students\n2 connected · 0 updating · 0 signal lost · 0 updates unavailable · 0 signed out",
      "text search must not change Observe totals",
    );
    await observePreviewPage.getByTestId("input-search-students").fill("");
    await observedCard.waitFor();
    await assertObserveEntryPointsUnavailable(
      observePreviewPage,
      observePreviewHarness.commandPosts,
      [STUDENT_ID, MOVED_CLASS_STUDENT_ID],
      observePreviewHarness.coverageMutationRequests,
    );

    const movableObservedCard = observePreviewPage.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`);
    await movableObservedCard.getByTestId(`button-student-details-${MOVED_CLASS_STUDENT_ID}`).click();
    await observePreviewPage.getByTestId("student-tabs").waitFor();

    await waitUntil(
      () => observePreviewHarness.tileRequests.some((request) => (
        request.pathname === "/api/classpilot/tiles/screenshots"
        && request.body?.studentIds?.includes(STUDENT_ID)
      )),
      "Observe must request the observed student's screenshot batch",
    );
    await waitUntil(
      () => observePreviewHarness.tileRequests.some((request) => (
        request.pathname === "/api/classpilot/tiles/history"
        && request.body?.studentIds?.includes(STUDENT_ID)
      )),
      "Observe must request the observed student's history batch",
    );
    await waitUntil(
      () => observePreviewHarness.observationLeaseRequests.some((request) => (
        request.method === "PUT"
        && request.pathname === `/api/classpilot/teaching-sessions/${OBSERVED_SESSION_ID}/observation-lease`
      )),
      "Observe must acquire a lease for the observed teaching session",
    );
    const observedLease = observePreviewHarness.observationLeaseRequests.find((request) => (
      request.method === "PUT"
      && request.pathname === `/api/classpilot/teaching-sessions/${OBSERVED_SESSION_ID}/observation-lease`
    ));
    assert.deepEqual(observedLease.body?.scope, { kind: "class" });
    assert.equal(typeof observedLease.body?.viewerInstanceId, "string");
    assert.ok(observedLease.body.viewerInstanceId.length > 0);

    const tileRequestCountBeforeSupervision = observePreviewHarness.tileRequests.length;
    const signalLostAt = new Date(Date.now() - 2 * 60_000).toISOString();
    observePreviewAggregate.setScopedResponse(success({
      students: [
        student({
          lastSeenAt: freshObservedAt,
          realtimeObservedAt: freshObservedAt,
          realtimeBinding: "binding-supervised",
          realtimeRevision: 2,
          activeTabTitle: "Supervised secret",
          activeTabUrl: "https://supervised-secret.example.edu/private",
          aiClassification: { category: "non-educational" },
          supervisionState: "temporary_coverage",
          supervisionContext: {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            type: "supervision",
            name: "Study Hall",
            assignedStaff: {
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              displayName: "Morgan Monitor",
            },
          },
        }),
        student({
          studentId: SIGNED_OUT_STUDENT_ID,
          studentName: "Sam Signed Out",
          studentEmail: "sam@example.edu",
          status: "offline",
          loginState: "not_logged_in",
          isLoggedIn: false,
          commandable: false,
          monitoringState: "offline",
          activityState: "signed_out",
          activeTabTitle: null,
          activeTabUrl: null,
          lastSeenAt: null,
          realtimeObservedAt: null,
          realtimeBinding: null,
          realtimeRevision: 2,
        }),
        student({
          studentId: SIGNAL_LOST_STUDENT_ID,
          studentName: "Lena Signal",
          studentEmail: "lena@example.edu",
          monitoringState: "signal_lost",
          activityFresh: false,
          monitoringLostAt: signalLostAt,
          lastSeenAt: signalLostAt,
          realtimeObservedAt: signalLostAt,
          realtimeBinding: "binding-signal",
          realtimeRevision: 2,
        }),
        student({
          studentId: MOVED_CLASS_STUDENT_ID,
          studentName: "Mia Moved Class",
          studentEmail: "mia@example.edu",
          activeTabTitle: "Different class secret",
          activeTabUrl: "https://moved-secret.example.edu/private",
          lastSeenAt: freshObservedAt,
          realtimeObservedAt: freshObservedAt,
          realtimeBinding: "binding-moved",
          realtimeRevision: 2,
          supervisionContext: {
            id: "12121212-1212-4121-8121-121212121212",
            type: "class",
            name: "Different Active Class",
          },
        }),
      ],
    }));
    await observePreviewHarness.authenticateWebSocket();

    const supervisedCard = observePreviewPage.getByTestId(`card-student-${STUDENT_ID}`);
    const signedOutCard = observePreviewPage.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`);
    const signalLostCard = observePreviewPage.getByTestId(`card-student-${SIGNAL_LOST_STUDENT_ID}`);
    const movedClassCard = observePreviewPage.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`);
    await signedOutCard.waitFor();
    await signalLostCard.waitFor();
    await observePreviewPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
    await supervisedCard.getByText("Controls locked", { exact: true }).waitFor();
    assert.ok(await supervisedCard.getByText("In supervision: Study Hall - Morgan Monitor", { exact: true }).count() > 0);
    assert.equal(await supervisedCard.getByTestId(`screenshot-${STUDENT_ID}`).count(), 0);
    assert.equal(await supervisedCard.getByText("Recent", { exact: true }).count(), 0);
    assert.equal(await supervisedCard.getByText("Online", { exact: true }).count(), 0, "supervised telemetry must not show a current-status badge");
    assert.equal(await supervisedCard.getByTestId(`badge-offtask-${STUDENT_ID}`).count(), 0);
    assert.equal(await supervisedCard.getByTestId(`button-lock-toggle-${STUDENT_ID}`).count(), 0, "supervision must hide the tile command button");
    assert.equal(
      await supervisedCard.getByTestId(`button-student-details-${STUDENT_ID}`).count(),
      0,
      "supervision must hide Details with the rest of the student's private monitoring context",
    );
    assert.equal(
      await signedOutCard.getByTestId(`button-student-details-${SIGNED_OUT_STUDENT_ID}`).count(),
      1,
      "signed-out students must retain the authorized Details action",
    );
    assert.equal(
      await signalLostCard.getByTestId(`button-student-details-${SIGNAL_LOST_STUDENT_ID}`).count(),
      1,
      "signal-lost students must retain the authorized Details action",
    );
    assert.equal(
      await movedClassCard.count(),
      0,
      "a frozen-roster student now owned by another active class must not render",
    );
    assert.equal(
      await observePreviewPage.getByText("Blocked Domain Accessed", { exact: true }).count(),
      0,
      "supervised telemetry must not leak through blocked-domain alerts",
    );
    assert.equal(
      await observePreviewPage.getByText(/(?:supervised-secret|moved-secret)\.example\.edu/).count(),
      0,
      "supervised URLs must not appear outside the suppressed tile",
    );
    assert.equal(
      (await signedOutCard.getByTestId(`text-unavailable-status-${SIGNED_OUT_STUDENT_ID}`).innerText()).trim(),
      "Not logged in",
    );
    assert.equal(
      (await signalLostCard.getByTestId(`text-unavailable-status-${SIGNAL_LOST_STUDENT_ID}`).innerText()).trim(),
      "Monitoring signal lost",
    );
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 3 students\n0 connected · 0 updating · 1 signal lost · 0 updates unavailable · 1 signed out · 1 in supervision",
    );
    assert.equal((await observePreviewPage.getByTestId("text-online-count").innerText()).trim(), "0");
    assert.equal((await observePreviewPage.getByTestId("text-idle-count").innerText()).trim(), "0");
    assert.equal((await observePreviewPage.getByTestId("text-offtask-count").innerText()).trim(), "0");

    await waitUntil(
      () => observePreviewHarness.tileRequests.some((request) => (
        request.body?.studentIds?.includes(SIGNAL_LOST_STUDENT_ID)
      )),
      "eligible status tiles must finish their batch request",
    );
    assert.equal(
      observePreviewHarness.tileRequests.slice(tileRequestCountBeforeSupervision).some((request) => (
        request.body?.studentIds?.includes(STUDENT_ID)
        && request.body?.studentIds?.includes(MOVED_CLASS_STUDENT_ID)
        && request.body?.studentIds?.includes(SIGNAL_LOST_STUDENT_ID)
      )),
      true,
      "presentation filters and supervision state must not reshape the frozen-roster query cohort",
    );
    const tileRequestCountBeforeSupervisedClick = observePreviewHarness.tileRequests.length;
    await supervisedCard.click();
    await observePreviewPage.waitForTimeout(200);
    assert.equal(await observePreviewPage.getByTestId("student-tabs").count(), 0, "a supervised tile must not open the detail drawer");
    assert.equal(await observePreviewPage.getByTestId("expanded-screenshot-dialog").count(), 0, "a supervised tile must not open a screenshot viewer");
    assert.equal(
      observePreviewHarness.tileRequests.slice(tileRequestCountBeforeSupervisedClick).some((request) => (
        request.body?.studentIds?.length === 1
        &&
        request.body?.studentIds?.includes(STUDENT_ID)
      )),
      false,
      "clicking a supervised tile must not issue a single-student history request",
    );

    const subgroupFilter = observePreviewPage.getByTestId("select-subgroup-filter");
    await subgroupFilter.waitFor();
    await subgroupFilter.selectOption(OBSERVED_SUBGROUP_ID);
    await signalLostCard.waitFor();
    await supervisedCard.waitFor({ state: "hidden" });
    await signedOutCard.waitFor({ state: "hidden" });
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - Needs Check-In - 1 student\n0 connected · 0 updating · 1 signal lost · 0 updates unavailable · 0 signed out",
      "Observe subgroup selection must scope its roster and totals",
    );
    await subgroupFilter.selectOption("");
    await supervisedCard.waitFor();
    await signedOutCard.waitFor();
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 3 students\n0 connected · 0 updating · 1 signal lost · 0 updates unavailable · 1 signed out · 1 in supervision",
    );
    await assertObserveEntryPointsUnavailable(
      observePreviewPage,
      observePreviewHarness.commandPosts,
      [STUDENT_ID, SIGNED_OUT_STUDENT_ID, SIGNAL_LOST_STUDENT_ID],
      observePreviewHarness.coverageMutationRequests,
    );
    assert.deepEqual(observePreviewHarness.commandPosts, []);
    assert.deepEqual(observePreviewHarness.coverageMutationRequests, []);

    const tileRequestCountBeforeReturn = observePreviewHarness.tileRequests.length;
    const aggregateRequestCountBeforeReturn = observePreviewAggregate.requests.length;
    const returnedObservedAt = new Date(Date.now() - 500).toISOString();
    returnedTelemetryEnabled = true;
    observePreviewAggregate.setScopedResponse(success({
      students: [student({
        lastSeenAt: returnedObservedAt,
        realtimeObservedAt: returnedObservedAt,
        realtimeBinding: "binding-returned",
        realtimeRevision: 3,
        supervisionState: null,
        supervisionContext: null,
        aiClassification: null,
      })],
    }));
    await observePreviewHarness.sendWebSocketMessage({
      type: "student-registered",
      studentId: STUDENT_ID,
    });
    await waitUntil(
      () => observePreviewAggregate.requests.length > aggregateRequestCountBeforeReturn,
      "ownership return must refetch the observed roster",
    );
    await waitUntil(
      () => observePreviewHarness.tileRequests.slice(tileRequestCountBeforeReturn).some((request) => (
        request.body?.studentIds?.includes(STUDENT_ID)
      )),
      "returned student telemetry may be requested only after the ownership-eligible roster refetch",
    );
    const returnedCard = observePreviewPage.getByTestId(`card-student-${STUDENT_ID}`);
    await returnedCard.getByTestId(`screenshot-${STUDENT_ID}`).waitFor();
    await returnedCard.getByText("Returned after supervision", { exact: true }).waitFor();
    await returnedCard.locator('[title="Returned activity"]').waitFor();
    assert.equal(await returnedCard.getByText("Controls locked", { exact: true }).count(), 0);
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 1 student\n1 connected · 0 updating · 0 signal lost · 0 updates unavailable · 0 signed out",
    );
    await assertObserveEntryPointsUnavailable(
      observePreviewPage,
      observePreviewHarness.commandPosts,
      [STUDENT_ID],
      observePreviewHarness.coverageMutationRequests,
    );
    assert.deepEqual(observePreviewHarness.pageErrors, []);

    const observePage = await browser.newPage();
    pages.push(observePage);
    const observeAggregate = aggregateController({
      school: success([]),
      scoped: failure({
        requestId: "bad:id",
        headerRequestId: ".req-observe_header",
      }),
    });
    const observeHarness = await configureDashboard(observePage, {
      aggregate: observeAggregate,
      activeSession: null,
      allSessions: [observedSession],
    });
    await observePage.goto(`${baseURL}/classpilot`);
    await observePage.getByTestId("select-admin-observe").selectOption(OBSERVED_SESSION_ID);
    await observePage.getByTestId("observe-read-only-banner").waitFor();
    await observePage.getByTestId("students-query-error").waitFor();
    assert.equal(
      (await observePage.getByTestId("students-error-request-id").innerText()).trim(),
      "Request ID: .req-observe_header",
      "an invalid response-body request ID must fall back to a valid punctuation-leading x-request-id header",
    );
    assert.ok(
      observeAggregate.requests.some((request) => request.teachingSessionId === OBSERVED_SESSION_ID),
      "Observe mode must scope the aggregate request to the selected session",
    );
    await assertUnknownCounts(observePage);
    await assertCommandEntryPointsUnavailable(observePage, observeHarness.commandPosts);
    assert.deepEqual(observeHarness.pageErrors, []);

    const malformedPage = await browser.newPage();
    pages.push(malformedPage);
    const malformedAggregate = aggregateController({
      school: success([]),
      scoped: success({ students: null }),
    });
    const malformedHarness = await configureDashboard(malformedPage, {
      aggregate: malformedAggregate,
      activeSession: ownSession,
      allSessions: [ownSession],
    });
    await malformedPage.goto(`${baseURL}/classpilot`);
    await waitUntil(
      () => malformedAggregate.requests.some((request) => request.teachingSessionId === OWN_SESSION_ID),
      "malformed owned-session aggregate request must start",
    );
    await malformedPage.getByTestId("students-query-error").waitFor({ timeout: 7_500 }).catch(async (error) => {
      assert.fail(`${error.message}\nAggregate requests: ${JSON.stringify(malformedAggregate.requests)}\nPage: ${await malformedPage.locator("body").innerText()}`);
    });
    assert.match(await malformedPage.getByTestId("students-query-error").innerText(), /Student data could not be loaded from the server/);
    assert.doesNotMatch(await malformedPage.getByTestId("students-query-error").innerText(), /expected contract/);
    assert.equal(await malformedPage.getByTestId("students-error-request-id").count(), 0);
    await assertUnknownCounts(malformedPage);
    await assertCommandEntryPointsUnavailable(malformedPage, malformedHarness.commandPosts);
    assert.deepEqual(malformedHarness.pageErrors, []);
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});
