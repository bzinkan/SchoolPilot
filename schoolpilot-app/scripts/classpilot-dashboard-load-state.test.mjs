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

function authResponse() {
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
      role: "admin",
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
      assert.equal(parsed.role, "school_admin");
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
      await route.fulfill({ json: authResponse() });
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
    /\{dashboardCapabilities\.canUseLiveView\s*&&\s*liveViewState\.expanded\s*&&\s*liveViewState\.stream(?:\s*&&\s*!activeLiveViewMonitoringSuppressed)?\s*\?\s*\(/,
    "expanded Live View must remain capability-gated when Observe revokes Live View",
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
          screenshot: {
            screenshot: TINY_SCREENSHOT_DATA_URL,
            timestamp: freshObservedAt,
            tabTitle: returnedTelemetryEnabled ? "Returned after supervision" : "Observed lesson screen",
            tabUrl: returnedTelemetryEnabled
              ? "https://returned.example.edu/current"
              : "https://lesson.example.edu/current",
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
    await observedCard.getByText("Recent", { exact: true }).waitFor();
    await observedCard.locator('[title="Research history"]').waitFor();
    assert.equal(await observedCard.getByText(/In supervision/i).count(), 0);
    assert.equal(await observedCard.getByText("Controls locked", { exact: true }).count(), 0);
    await observedCard.click();
    await observePreviewPage.getByTestId("student-tabs").waitFor();
    assert.equal(await observePreviewPage.getByTestId("tab-screens").count(), 1, "ordinary Observe must open the read-only detail drawer");
    await observePreviewPage.getByRole("button", { name: "Close" }).click();
    await observePreviewPage.getByTestId("student-tabs").waitFor({ state: "hidden" });
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
    await movableObservedCard.click();
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
