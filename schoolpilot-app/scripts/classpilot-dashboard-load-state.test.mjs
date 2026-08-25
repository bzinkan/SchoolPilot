import assert from "node:assert/strict";
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
const OWN_SESSION_ID = "66666666-6666-4666-8666-666666666666";
const OBSERVED_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const STUDENT_ID = "88888888-8888-4888-8888-888888888888";

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

function student() {
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
} = {}) {
  let dashboardSocket;
  let websocketAuthenticated = false;
  const commandPosts = [];
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
          settings: activeSession ? {
            activeSessionId: activeSession.id,
            handRaisingEnabled: true,
            studentMessagingEnabled: true,
            sessionFabRevision: 1,
          } : {},
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
      await route.fulfill({ json: { subgroups: [] } });
      return;
    }
    if (/^\/api\/groups\/[^/]+\/students$/.test(pathname)) {
      await route.fulfill({ json: { students: [] } });
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
      await route.fulfill({ json: { renewAfterSeconds: 30 } });
      return;
    }
    if (pathname === "/api/classpilot/tiles/screenshots" || pathname === "/api/classpilot/tiles/history") {
      await route.fulfill({ json: { tiles: [] } });
      return;
    }
    if (pathname.startsWith("/api/commands") && request.method() === "POST") {
      commandPosts.push({ pathname, body: request.postDataJSON() });
      await route.fulfill({ status: 500, json: { error: "A command must not be sent in this test state" } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });

  return {
    commandPosts,
    pageErrors,
    async authenticateWebSocket() {
      await waitUntil(
        () => Boolean(dashboardSocket),
        "Dashboard WebSocket must send its auth frame",
      );
      if (websocketAuthenticated) return;
      websocketAuthenticated = true;
      dashboardSocket.send(JSON.stringify({ type: "auth-success" }));
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
  assert.deepEqual(commandPosts, [], "no command POST may be issued without a successful target snapshot");
}

test("ClassPilot distinguishes empty, failed, cached, Observe, and malformed aggregate states", { timeout: 120_000 }, async () => {
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

    const observePage = await browser.newPage();
    pages.push(observePage);
    const observedSession = teachingSession({
      id: OBSERVED_SESSION_ID,
      groupId: OBSERVED_GROUP_ID,
      teacherId: OTHER_TEACHER_ID,
    });
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
