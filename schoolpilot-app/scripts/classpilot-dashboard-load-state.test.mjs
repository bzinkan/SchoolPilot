import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

// Optional source override is used only to preserve a failing release-baseline
// browser reproduction while the working Dashboard is being repaired.
function chatBaselinePlugins() {
  const baseline = process.env.CLASSPILOT_CHAT_BASELINE_SOURCE;
  return baseline ? [{
    name: 'chat-release-baseline', enforce: 'pre',
    load(id) {
      if (id.replaceAll('\\', '/').split('?')[0].endsWith('/src/products/classpilot/pages/Dashboard.jsx')) {
        return readFileSync(baseline, 'utf8');
      }
    },
  }] : [];
}

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
    sessionMode: "live",
    endTime: null,
    rosterSnapshotCompletedAt: "2026-08-25T13:00:00.000Z",
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
  const completedRequests = [];

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
    completedRequests,
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
      const supervisionContextId = url.searchParams.get('supervisionContextId');
      const request = { teachingSessionId, supervisionContextId, url: url.toString() };
      requests.push(request);
      const response = await waitUntilResolved(() => (
        teachingSessionId || supervisionContextId ? scopedResponse : schoolResponse
      ));
      if (response.kind === "success") {
        await route.fulfill({ status: 200, json: response.body });
        completedRequests.push(request);
        return;
      }
      await route.fulfill({
        status: response.status,
        json: response.body,
        headers: response.headerRequestId
          ? { "x-request-id": response.headerRequestId }
          : undefined,
      });
      completedRequests.push(request);
    },
  };
}

// The budget is wall-clock, and a loaded CI runner is roughly four times
// slower than a local one: at 7.5s the aggregate-reconcile assertion below
// flaked three times in one day on diffs that could not reach it. Waiting
// longer costs nothing on a passing run, because the poll returns as soon as
// the predicate holds; it only changes how long a genuine failure takes to
// report. Matches the 30s budget assertInitialPreview already uses.
async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function assertInitialPreview(page, harness, responsePhases = [], timeout = 30_000) {
  try {
    await page.getByTestId(`screenshot-${STUDENT_ID}`).waitFor({ timeout });
  } catch (error) {
    let diagnosticTimer;
    const ui = await Promise.race([
      page.evaluate((studentId) => {
        const read = (id) => document.querySelector(`[data-testid="${id}"]`);
        const card = read(`card-student-${studentId}`);
        return {
          card: Boolean(card), cardText: card?.textContent?.slice(0, 700),
          skeleton: Boolean(read(`student-tile-skeleton-${studentId}`)),
          unavailableStatus: read(`text-unavailable-status-${studentId}`)?.textContent,
          selectedClass: read('select-admin-observe')?.value,
          selection: read('badge-selection-count')?.textContent,
          connected: read('text-online-count')?.textContent, signedOut: read('text-offline-count')?.textContent,
          warnings: [...document.querySelectorAll('[data-testid="tile-read-denied"], [data-testid^="screenshot-observation-"]')].slice(0, 5).map((node) => ({ id: node.dataset.testid, text: node.textContent?.slice(0, 300) })),
          images: [...document.images].filter((node) => node.dataset.testid === `screenshot-${studentId}` || card?.contains(node)).slice(0, 6).map((node) => ({
            id: node.dataset.testid, src: node.getAttribute('src')?.slice(0, 160), complete: node.complete,
            width: node.naturalWidth, height: node.naturalHeight, display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
          })),
        };
      }, STUDENT_ID).catch((failure) => ({ evaluationError: failure.message.slice(0, 300) })),
      new Promise((resolve) => { diagnosticTimer = setTimeout(() => resolve({ evaluationTimedOut: true }), 2000); }),
    ]).finally(() => clearTimeout(diagnosticTimer));
    assert.fail(`Initial preview did not render: ${JSON.stringify({
      error: error.message.split('\n')[0], ui,
      screenshotRequests: harness.tileRequests.filter((request) => request.pathname.endsWith('/screenshots')).slice(-8).map(({ body }) => ({ teachingSessionId: body.teachingSessionId, count: body.studentIds?.length, studentIds: body.studentIds?.slice(0, 4) })),
      responsePhases: responsePhases.slice(-8), pageErrors: harness.pageErrors.slice(-5).map((message) => message.slice(0, 500)),
    })}`);
  }
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
  observationLeaseResponse = { renewAfterSeconds: 30 },
  claimedStudents = [],
  availableStudents = [],
  claimResponse = null,
  coverageSummary = { activeContextCount: 0, availableStudentCount: 0, claimedStudentCount: 0, schoolId: SCHOOL_ID, viewerId: ADMIN_ID, ownTestingContexts: [] },
  authentication = null,
  acknowledgeSessionSubscriptions = false,
  sessionSubscriptionResponse = null,
  dashboardActivity = { enabled: false, schoolId: SCHOOL_ID, viewerId: ADMIN_ID },
} = {}) {
  let dashboardSocket;
  let websocketAuthenticated = false;
  const retiredSockets = new WeakSet();
  const websocketConnections = [];
  const websocketMessages = [];
  const commandPosts = [];
  const coverageMutationRequests = [];
  const tileRequests = [];
  const observationLeaseRequests = [];
  const sessionRequests = [];
  const claimedRosterRequests = [];
  const coverageSummaryRequests = [];
  const activityRequests = [];
  const pageErrors = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((schoolId) => {
    window.localStorage.setItem("sp_activeSchoolId", schoolId);
  }, SCHOOL_ID);

  await page.routeWebSocket("**/ws", (socket) => {
    const connection = { openedAt: Date.now(), authenticationRequests: 0, authenticationResponses: 0 };
    websocketConnections.push(connection);
    socket.onMessage((message) => {
      if (retiredSockets.has(socket)) return;
      const parsed = JSON.parse(message);
      websocketMessages.push(parsed);
      if (acknowledgeSessionSubscriptions && parsed.type === 'subscribe-session') {
        const result = sessionSubscriptionResponse?.(parsed) || { type: 'session-subscription-success' };
        socket.send(JSON.stringify({ ...result, ...(parsed.supervisionContextId
          ? { supervisionContextId: parsed.supervisionContextId, contextAuthorityRevision: parsed.contextAuthorityRevision }
          : { sessionId: parsed.sessionId, teachingSessionId: parsed.sessionId }), requestId: parsed.requestId }));
        return;
      }
      if (parsed.type !== "auth") return;
      connection.authenticationRequests += 1;
      dashboardSocket = socket;
      assert.equal(parsed.role, userRole === "teacher" ? "teacher" : "school_admin");
      assert.equal(parsed.userToken, "dashboard-load-state-token");
      assert.equal(Object.hasOwn(parsed, "token"), false);
      if (acknowledgeSessionSubscriptions) {
        // The real server answers every authentication request, including the
        // on-open / role-refresh pair. Leaving the second unanswered strands
        // a fixture in unauthenticated state after an otherwise valid reconnect.
        websocketAuthenticated = true;
        connection.authenticationResponses += 1;
        socket.send(JSON.stringify({ type: 'auth-success' }));
      }
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
      await route.fulfill({ json: typeof authentication === 'function' ? await authentication(request) : authentication || authResponse(userRole) });
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
            ...(activeSession && typeof activeSession !== 'function' ? {
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
    if (pathname === '/api/classpilot/dashboard-activity') {
      activityRequests.push({ schoolId: request.headers()['x-school-id'] });
      const value = typeof dashboardActivity === 'function' ? await dashboardActivity(request) : dashboardActivity;
      await route.fulfill(value?.status >= 400 ? { status: value.status, json: value.body || { error: 'Assignment unavailable' } } : { json: value });
      return;
    }
    const activitySettings = pathname.match(/^\/api\/classpilot\/supervision-contexts\/([^/]+)\/settings$/);
    if (activitySettings) {
      await route.fulfill({ json: { settings: { supervisionContextId: activitySettings[1], lifecycleRevision: 1, raiseHandEnabled: true, chatEnabled: true } } });
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
      sessionRequests.push(pathname);
      await route.fulfill({ json: { session: typeof activeSession === 'function' ? await activeSession(request) : activeSession } });
      return;
    }
    if (pathname === "/api/teacher/groups") {
      await route.fulfill({ json: { groups: GROUPS } });
      return;
    }
    if (pathname === "/api/sessions/all") {
      sessionRequests.push(pathname);
      await route.fulfill({ json: { sessions: allSessions } });
      return;
    }
    if (pathname === "/api/coverage/summary") {
      coverageSummaryRequests.push({ schoolId: request.headers()['x-school-id'], pathname });
      const response = typeof coverageSummary === 'function' ? await coverageSummary(request) : coverageSummary;
      await route.fulfill(Number(response?.status) >= 400
        ? { status: response.status, json: response.body || { error: 'Coverage summary unavailable' } }
        : { json: response });
      return;
    }
    if (pathname === "/api/coverage/capabilities") {
      await route.fulfill({ json: { commandTypes: [] } });
      return;
    }
    if (pathname === '/api/coverage/claimed-students') {
      claimedRosterRequests.push(pathname);
      const response = typeof claimedStudents === 'function' ? await claimedStudents(request) : claimedStudents;
      await route.fulfill(Number(response?.status) >= 400
        ? { status: response.status, json: response.body || { error: 'Supervision students unavailable' } }
        : { json: { students: response } });
      return;
    }
    if (pathname === '/api/coverage/available-students') {
      await route.fulfill({ json: { students: typeof availableStudents === 'function' ? await availableStudents(request) : availableStudents } });
      return;
    }
    if (pathname === '/api/coverage/claim' && request.method() === 'POST' && claimResponse) {
      const response = await claimResponse(request);
      await route.fulfill({ status: response.status || 201, json: response.body || response });
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
    if (/^\/api\/classpilot\/(?:teaching-sessions|supervision-contexts)\/[^/]+\/observation-lease$/.test(pathname)) {
      observationLeaseRequests.push({
        schoolId: request.headers()['x-school-id'], contextAuthorityRevision: request.headers()['x-classpilot-context-authority-revision'],
        method: request.method(),
        pathname,
        body: request.postData() ? request.postDataJSON() : null,
      });
      const response = typeof observationLeaseResponse === 'function'
        ? await observationLeaseResponse(request.method(), pathname)
        : observationLeaseResponse;
      await route.fulfill(Number(response?.status) >= 400 && request.method() === 'PUT'
        ? { status: response.status, json: response.body || { code: 'OBSERVATION_SESSION_UNAVAILABLE' } }
        : { json: response });
      return;
    }
    if (pathname === "/api/classpilot/tiles/screenshots" || pathname === "/api/classpilot/tiles/history") {
      const body = request.postDataJSON();
      tileRequests.push({
        pathname, contextAuthorityRevision: request.headers()['x-classpilot-context-authority-revision'],
        body,
      });
      const suppliedResponse = pathname.endsWith("/screenshots") ? screenshotTiles : historyTiles;
      // Awaiting lets a test hold a tile response open and observe the
      // dashboard's first-paint state while the POST is still in flight.
      const response = typeof suppliedResponse === "function"
        ? await suppliedResponse(body)
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
    sessionRequests,
    claimedRosterRequests,
    coverageSummaryRequests,
    activityRequests,
    websocketConnections, websocketMessages,
    setActiveSession(session) { activeSession = session; },
    setAllSessions(sessions) { allSessions = sessions; },
    setCoverageSummary(summary) { coverageSummary = summary; },
    setDashboardActivity(activity) { dashboardActivity = activity; },
    setClaimedStudents(students) { claimedStudents = students; },
    async disconnectWebSocket() {
      const previous = dashboardSocket;
      retiredSockets.add(previous);
      dashboardSocket = null;
      websocketAuthenticated = false;
      await previous.close();
    },
    async authenticateWebSocket() {
      await waitUntil(
        () => Boolean(dashboardSocket),
        "Dashboard WebSocket must send its auth frame",
      );
      if (websocketAuthenticated) return;
      websocketAuthenticated = true;
      websocketConnections.at(-1).authenticationResponses += 1;
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
    "button-flight-path-menu",
    "button-block-list-menu",
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

// One test drives every load state because the Vite server and the browser are
// expensive to start; each scenario opens its own page inside that shared
// setup, so the budget tracks the scenario COUNT. Measured locally: ~52s before
// the first-paint/hysteresis scenario was added, ~71s after. CI hardware is
// slower and hit the previous 120s ceiling, so the ceiling is raised rather
// than the coverage dropped. If it times out again, budget for the scenario
// being added or split the file — and measure before concluding the dashboard
// itself got slower.
test("ClassPilot distinguishes empty, failed, cached, Observe, and malformed aggregate states", { timeout: 240_000 }, async () => {
  const dashboardSource = readFileSync(
    path.join(APP_ROOT, "src/products/classpilot/pages/Dashboard.jsx"),
    "utf8",
  );
  assert.match(
    dashboardSource,
    /const LIVE_VIEW_UI_ENABLED = false;/,
    "Dashboard WebRTC stays dormant for both regular and scheduled classrooms",
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
    // The Flight Path / Block List chevron menus must be non-modal: their
    // Status items open a Dialog from inside the menu, and a modal menu plus a
    // dialog can leave body pointer-events disabled after Close. A modal Radix
    // menu sets body pointer-events:none while open, so assert the runtime
    // property directly while each menu is open, then walk the path: menu ->
    // Status -> viewer -> Close -> the toolbar still responds. The literal
    // `<DropdownMenu modal={false}>` count is pinned by
    // assert-classpilot-tile-batching.mjs.
    for (const menu of [
      {
        trigger: "button-flight-path-menu",
        status: "button-flight-path-status",
        dialog: "dialog-flight-path-viewer",
        close: "button-close-flight-path-viewer",
      },
      {
        trigger: "button-block-list-menu",
        status: "button-block-list-status",
        dialog: "dialog-block-list-viewer",
        close: "button-close-block-list-viewer",
      },
    ]) {
      assert.equal(await cachedEmptyPage.getByTestId(menu.status).count(), 0, `${menu.status} must stay unmounted until its menu opens`);
      await cachedEmptyPage.getByTestId(menu.trigger).click();
      await cachedEmptyPage.getByTestId(menu.status).waitFor();
      assert.notEqual(
        await cachedEmptyPage.evaluate(() => getComputedStyle(document.body).pointerEvents),
        "none",
        `${menu.trigger} must open a non-modal menu that leaves the page interactive`,
      );
      await cachedEmptyPage.getByTestId(menu.status).click();
      await cachedEmptyPage.getByTestId(menu.dialog).waitFor();
      await cachedEmptyPage.getByTestId(menu.close).click();
      await cachedEmptyPage.getByTestId(menu.dialog).waitFor({ state: "hidden" });
    }
    await cachedEmptyPage.getByTestId("button-open-tab").click();
    await cachedEmptyPage.getByTestId("dialog-open-tab").waitFor();
    await cachedEmptyPage.getByTestId("button-cancel-open-tab").click();
    await cachedEmptyPage.getByTestId("dialog-open-tab").waitFor({ state: "hidden" });
    assert.deepEqual(cachedEmptyHarness.commandPosts, [], "opening the menus and viewers must not issue a command");
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
      "button-apply-block-list",
      "button-select-all-students",
    ]) {
      assert.equal(
        await staleSignOutPage.getByTestId(testId).isDisabled(),
        true,
        `${testId} must stay disabled for a sign-out-only selection`,
      );
    }
    // Remove and Status live inside the Flight Path / Block List chevron menus,
    // which Radix unmounts while closed. The chevron itself stays enabled so the
    // teacher can still see which actions exist; every item must report
    // disabled once the menu is open.
    for (const [menuTestId, itemTestIds] of [
      ["button-flight-path-menu", ["button-remove-flight-path", "button-flight-path-status"]],
      ["button-block-list-menu", ["button-remove-block-list", "button-block-list-status"]],
    ]) {
      const menuTrigger = staleSignOutPage.getByTestId(menuTestId);
      assert.equal(
        await menuTrigger.isDisabled(),
        false,
        `${menuTestId} must stay openable for a sign-out-only selection`,
      );
      await menuTrigger.click();
      for (const testId of itemTestIds) {
        const item = staleSignOutPage.getByTestId(testId);
        await item.waitFor();
        assert.equal(
          await item.isDisabled(),
          true,
          `${testId} must stay disabled for a sign-out-only selection`,
        );
      }
      await staleSignOutPage.keyboard.press("Escape");
      await staleSignOutPage.getByTestId(itemTestIds[0]).waitFor({ state: "hidden" });
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
    const delegatedRecheck = detailsRevocationAggregate.requests[delegatedRecheckStart];
    await waitUntil(
      () => detailsRevocationAggregate.completedRequests.includes(delegatedRecheck),
      "the delegated authority response must finish before restoring the fixture",
    );
    await detailsRevocationPage.waitForFunction(async () => {
      const { queryClient } = await import('/src/lib/queryClient.js');
      return queryClient.isFetching({ queryKey: ['/api/students-aggregated'] }) === 0;
    });
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
      "Viewing: Biology - All 2 students\n2 connected · 0 signing in · 0 updating · 0 signal lost · 0 updates unavailable · 0 signed out",
    );
    await observePreviewPage.getByTestId("input-search-students").fill("No matching student");
    await observedCard.waitFor({ state: "hidden" });
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 2 students\n2 connected · 0 signing in · 0 updating · 0 signal lost · 0 updates unavailable · 0 signed out",
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
      "Viewing: Biology - All 3 students\n0 connected · 0 signing in · 0 updating · 1 signal lost · 0 updates unavailable · 1 signed out · 1 in supervision",
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
      "Viewing: Biology - Needs Check-In - 1 student\n0 connected · 0 signing in · 0 updating · 1 signal lost · 0 updates unavailable · 0 signed out",
      "Observe subgroup selection must scope its roster and totals",
    );
    await subgroupFilter.selectOption("");
    await supervisedCard.waitFor();
    await signedOutCard.waitFor();
    assert.equal(
      (await observePreviewPage.getByTestId("badge-selection-count").innerText()).trim(),
      "Viewing: Biology - All 3 students\n0 connected · 0 signing in · 0 updating · 1 signal lost · 0 updates unavailable · 1 signed out · 1 in supervision",
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
      "Viewing: Biology - All 1 student\n1 connected · 0 signing in · 0 updating · 0 signal lost · 0 updates unavailable · 0 signed out",
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

    const firstPaintPage = await browser.newPage();
    pages.push(firstPaintPage);
    // A stubbed IntersectionObserver reports nothing until the test drives it,
    // which is exactly the window in which the wall used to paint featureless
    // gray boxes and gate every viewport-scoped read on an empty near set.
    await firstPaintPage.addInitScript(() => {
      const callbacks = new Set();
      window.__emitTileIntersections = (isIntersecting) => {
        const targets = [...document.querySelectorAll("[data-student-viewport-id]")];
        for (const callback of callbacks) {
          callback(targets.map((target) => ({ target, isIntersecting })));
        }
      };
      window.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          callbacks.add(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {
          callbacks.delete(this.callback);
        }
        takeRecords() {
          return [];
        }
      };
    });
    const firstPaintStudent = student({ realtimeBinding: "first-paint-binding" });
    const firstPaintAggregate = aggregateController({
      school: success([]),
      scoped: success({ students: [firstPaintStudent] }),
    });
    let releaseFirstPaintScreenshots;
    const firstPaintScreenshotGate = new Promise((resolve) => {
      releaseFirstPaintScreenshots = resolve;
    });
    const firstPaintHarness = await configureDashboard(firstPaintPage, {
      aggregate: firstPaintAggregate,
      activeSession: ownSession,
      allSessions: [ownSession],
      screenshotTiles: async () => {
        await firstPaintScreenshotGate;
        return {
          tiles: [{
            studentId: STUDENT_ID,
            screenshot: {
              screenshot: TINY_SCREENSHOT_DATA_URL,
              timestamp: new Date().toISOString(),
              tabTitle: "First paint screen",
              tabUrl: "https://lesson.example.edu/first-paint",
            },
          }],
        };
      },
    });
    await firstPaintPage.goto(`${baseURL}/classpilot`);

    const firstPaintSkeleton = firstPaintPage.getByTestId(`student-tile-skeleton-${STUDENT_ID}`);
    await firstPaintSkeleton.waitFor();
    assert.equal(
      await firstPaintPage.getByTestId(`student-tile-skeleton-name-${STUDENT_ID}`).innerText(),
      "Ada Student",
      "the first-paint stand-in must keep the roster identity visible",
    );
    assert.equal(
      await firstPaintPage.locator('div[aria-hidden="true"][class*="bg-muted/10"]').count(),
      0,
      "an unresolved tile must never render a featureless gray box",
    );
    assert.ok(
      (await firstPaintSkeleton.boundingBox())?.height >= 400,
      "the stand-in must hold the real tile height so the wall does not reflow",
    );
    await waitUntil(
      () => firstPaintHarness.tileRequests.some((request) => (
        request.pathname === "/api/classpilot/tiles/history"
        && (request.body?.studentIds || []).includes(STUDENT_ID)
      )),
      "an IntersectionObserver that has not reported yet must poll every cohort, not an empty near set",
    );

    releaseFirstPaintScreenshots();
    const firstPaintCard = firstPaintPage.getByTestId(`card-student-${STUDENT_ID}`);
    await firstPaintCard.waitFor();
    await firstPaintCard.getByTestId(`screenshot-${STUDENT_ID}`).waitFor();
    assert.equal(
      await firstPaintPage.getByTestId(`student-tile-skeleton-${STUDENT_ID}`).count(),
      0,
      "the stand-in must be replaced by the real tile once its cohort resolves",
    );

    // Scrolling a tile out of the enter margin and straight back must not
    // unmount it: the viewport is a polling gate, never a mount gate.
    await firstPaintPage.evaluate(() => window.__emitTileIntersections(false));
    await firstPaintCard.getByTestId(`screenshot-${STUDENT_ID}`).waitFor();
    await firstPaintPage.evaluate(() => window.__emitTileIntersections(true));
    await firstPaintPage.evaluate(() => window.__emitTileIntersections(false));
    await firstPaintPage.evaluate(() => window.__emitTileIntersections(true));
    assert.equal(
      await firstPaintCard.getByTestId(`screenshot-${STUDENT_ID}`).count(),
      1,
      "a scroll-direction reversal must not blank an already painted tile",
    );
    assert.equal(
      await firstPaintPage.locator('div[aria-hidden="true"][class*="bg-muted/10"]').count(),
      0,
      "offscreen tiles must stay mounted instead of collapsing to a gray box",
    );
    assert.deepEqual(firstPaintHarness.pageErrors, []);
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});

test('terminal read denials stop clock and lifecycle replay and recover only after authority or checked retry', { timeout: 120_000 }, async () => {
  const vite = await createServer({ root: APP_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const fixedTime = new Date('2026-09-04T12:00:00Z');
  const live = teachingSession();
  const rows = (binding = 'binding-a') => [student({
    realtimeBinding: binding, lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString(),
  })];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const lifecycleBurst = (page) => page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const pages = [];
  try {
    const tilesPage = await browser.newPage();
    pages.push(tilesPage);
    await tilesPage.clock.install({ time: fixedTime });
    let denyTiles = true;
    let tileStoreUnavailable = false;
    const tileAggregate = aggregateController({ scoped: success(rows()) });
    const tileHarness = await configureDashboard(tilesPage, {
      aggregate: tileAggregate, activeSession: live, allSessions: [live],
      screenshotTiles: () => denyTiles
        ? { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } }
        : tileStoreUnavailable
          ? { status: 503, body: { error: 'Screenshot store temporarily unavailable' } }
          : { tiles: [{ studentId: STUDENT_ID, screenshot: null }] },
    });
    await tilesPage.goto(`${baseURL}/classpilot`);
    await tilesPage.getByTestId('tile-read-denied').waitFor();
    await tileHarness.authenticateWebSocket();
    const screenshots = () => tileHarness.tileRequests.filter((request) => request.pathname.endsWith('/screenshots'));
    const deniedCount = screenshots().length;
    await tilesPage.clock.fastForward(65_000);
    await lifecycleBurst(tilesPage);
    await tileHarness.sendWebSocketMessage({
      type: 'screenshot-available', schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID,
      studentId: STUDENT_ID, capturedAt: '2026-09-04T12:01:00Z',
    });
    await tilesPage.clock.fastForward(65_000);
    await settle();
    assert.equal(screenshots().length, deniedCount, 'cohort404 must survive poll ticks, cache scrubs, focus and targeted events');
    assert.equal(await tilesPage.getByTestId(`screenshot-${STUDENT_ID}`).count(), 0);
    denyTiles = false;
    const parentsBeforeRetry = tileHarness.sessionRequests.length;
    await tilesPage.getByTestId('retry-tile-reads').click();
    await waitUntil(() => screenshots().length > deniedCount, 'a checked explicit retry must recover the current binding');
    await tilesPage.getByTestId('tile-read-denied').waitFor({ state: 'hidden' });
    assert.ok(tileHarness.sessionRequests.length > parentsBeforeRetry, 'explicit retry refreshes parent authority before replay');
    const nullCount = screenshots().length;
    await tilesPage.clock.fastForward(31_000);
    await waitUntil(() => screenshots().length > nullCount, 'successful screenshot:null is a cache miss and keeps reconciliation active');

    tileStoreUnavailable = true;
    const beforeOutage = screenshots().length;
    await tilesPage.clock.fastForward(31_000);
    await waitUntil(() => screenshots().length > beforeOutage, 'transient store failures reach the ordinary poll');
    const duringOutage = screenshots().length;
    await tilesPage.clock.fastForward(31_000);
    await waitUntil(() => screenshots().length > duringOutage, 'a503 must retain later reconciliation without an explicit retry');
    assert.equal(await tilesPage.getByTestId('tile-read-denied').count(), 0);
    tileStoreUnavailable = false;
    const beforeRecovery = screenshots().length;
    await tilesPage.clock.fastForward(31_000);
    await waitUntil(() => screenshots().length > beforeRecovery, 'transient store recovery requires no authority reset');

    // A second denial is independent of the first checked retry. The original
    // student can regain access under a new binding without reloading the app.
    denyTiles = true;
    await tilesPage.clock.fastForward(31_000);
    await tilesPage.getByTestId('tile-read-denied').waitFor();
    const secondDeniedCount = screenshots().length;
    denyTiles = false;
    tileAggregate.setScopedResponse(success(rows('replacement-binding').map((row) => ({
      ...row, realtimeRevision: 2, realtimeObservedAt: '2026-09-04T12:03:00Z', lastSeenAt: '2026-09-04T12:03:00Z',
    }))));
    await tilesPage.clock.fastForward(1000);
    await lifecycleBurst(tilesPage);
    await waitUntil(() => screenshots().length > secondDeniedCount, 'an authoritative binding replacement re-arms its own tile');
    await tilesPage.getByTestId('tile-read-denied').waitFor({ state: 'hidden' });
    assert.deepEqual(tileHarness.pageErrors, []);
    await tilesPage.close();

    const leasePage = await browser.newPage();
    pages.push(leasePage);
    await leasePage.clock.install({ time: fixedTime });
    let denyLease = true;
    const leaseHarness = await configureDashboard(leasePage, {
      aggregate: aggregateController({ scoped: success(rows()) }), activeSession: live, allSessions: [live],
      observationLeaseResponse: () => denyLease
        ? { status: 404, body: { code: 'OBSERVATION_SESSION_UNAVAILABLE' } }
        : { renewAfterSeconds: 30 },
    });
    await leasePage.goto(`${baseURL}/classpilot`);
    await leasePage.getByTestId('screenshot-observation-denied').waitFor();
    const leasePuts = () => leaseHarness.observationLeaseRequests.filter((request) => request.method === 'PUT').length;
    const deniedLeaseCount = leasePuts();
    await leasePage.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await leasePage.clock.fastForward(120_000);
    await lifecycleBurst(leasePage);
    await settle();
    assert.equal(leasePuts(), deniedLeaseCount, 'visibility changes cannot restart a terminally denied lease');
    denyLease = false;
    await leasePage.getByTestId('retry-observation-reads').click();
    await waitUntil(() => leasePuts() === deniedLeaseCount + 1, 'checked retry acquires one new exact-viewer lease');
    await leasePage.getByTestId('screenshot-observation-denied').waitFor({ state: 'hidden' });
    await leasePage.clock.fastForward(31_000);
    await waitUntil(() => leasePuts() === deniedLeaseCount + 2, 'successful leases retain ordinary renewal');
    assert.deepEqual(leaseHarness.pageErrors, []);
    await leasePage.close();

    const claimedPage = await browser.newPage();
    pages.push(claimedPage);
    await claimedPage.clock.install({ time: fixedTime });
    let denyClaimedHistory = true;
    const claimedHarness = await configureDashboard(claimedPage, {
      aggregate: aggregateController(),
      claimedStudents: rows().map((row) => ({
        ...row, contextId: 'coverage-context', supervisionState: 'claimed',
        supervisionContext: { type: 'coverage', id: 'coverage-context', assignedStaffId: ADMIN_ID },
      })),
      historyTiles: () => denyClaimedHistory
        ? { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } }
        : { tiles: [{ studentId: STUDENT_ID, heartbeats: [] }] },
    });
    await claimedPage.goto(`${baseURL}/classpilot`);
    await claimedPage.getByTestId('button-view-claimed-students').click();
    await claimedPage.getByTestId('tile-read-denied').waitFor();
    const historyPosts = () => claimedHarness.tileRequests.filter((request) => request.pathname.endsWith('/history')).length;
    const deniedHistoryCount = historyPosts();
    await claimedPage.clock.fastForward(65_000);
    await lifecycleBurst(claimedPage);
    await claimedPage.getByTestId('button-view-class-students').click();
    await claimedPage.getByTestId('button-view-claimed-students').click();
    await settle();
    assert.equal(historyPosts(), deniedHistoryCount, 'coverage history404 survives lifecycle and view return');
    denyClaimedHistory = false;
    const claimedRefreshesBefore = claimedHarness.claimedRosterRequests.length;
    const classRefreshesBefore = claimedHarness.sessionRequests.length;
    await claimedPage.getByRole('button', { name: 'Refresh coverage', exact: true }).click();
    await waitUntil(() => historyPosts() > deniedHistoryCount, 'checked coverage retry must re-arm restored history without an active class');
    await claimedPage.getByTestId('tile-read-denied').waitFor({ state: 'hidden' });
    assert.ok(claimedHarness.claimedRosterRequests.length > claimedRefreshesBefore);
    assert.equal(claimedHarness.sessionRequests.length, classRefreshesBefore, 'coverage retry uses its own roster authority');
    assert.deepEqual(claimedHarness.pageErrors, []);
    await claimedPage.close();

    const retainedObservePage = await browser.newPage();
    pages.push(retainedObservePage);
    await retainedObservePage.clock.install({ time: fixedTime });
    const observed = teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID });
    let retainedObserveHarness;
    retainedObserveHarness = await configureDashboard(retainedObservePage, {
      aggregate: aggregateController({ scoped: success(rows()) }), activeSession: live, allSessions: [live, observed],
      observationLeaseResponse: (method, pathname) => {
        if (method === 'PUT' && pathname.includes(OBSERVED_SESSION_ID)) {
          retainedObserveHarness.setAllSessions([live]);
          return { status: 404, body: { code: 'OBSERVATION_SESSION_UNAVAILABLE' } };
        }
        return { renewAfterSeconds: 30 };
      },
    });
    await retainedObservePage.goto(`${baseURL}/classpilot`);
    await retainedObservePage.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
    await retainedObservePage.getByTestId('screenshot-observation-denied').waitFor();
    await waitUntil(() => retainedObserveHarness.sessionRequests.filter((path) => path.endsWith('/all')).length >= 2,
      'lease denial refreshes the parent list that removes observed A');
    await settle();
    await assertObserveEntryPointsUnavailable(retainedObservePage, retainedObserveHarness.commandPosts,
      [STUDENT_ID], retainedObserveHarness.coverageMutationRequests);
    assert.deepEqual(retainedObserveHarness.pageErrors, []);
    await retainedObservePage.close();

    const aggregatePage = await browser.newPage();
    pages.push(aggregatePage);
    await aggregatePage.clock.install({ time: fixedTime });
    const aggregate = aggregateController({ scoped: failure({ status: 404 }) });
    const aggregateHarness = await configureDashboard(aggregatePage, { aggregate, activeSession: live, allSessions: [live] });
    await aggregatePage.goto(`${baseURL}/classpilot`);
    await aggregatePage.getByText('This class session is no longer available', { exact: true }).waitFor();
    await assertUnknownCounts(aggregatePage);
    const scopedFailures = aggregate.requests.filter((request) => request.teachingSessionId === OWN_SESSION_ID).length;
    assert.equal(scopedFailures, 1, 'session404 does not inherit the global Query retry');
    const unscopedBefore = aggregate.requests.filter((request) => !request.teachingSessionId).length;
    aggregateHarness.setActiveSession(null);
    aggregateHarness.setAllSessions([]);
    await aggregatePage.clock.fastForward(120_000);
    await lifecycleBurst(aggregatePage);
    await settle();
    assert.equal(aggregate.requests.filter((request) => request.teachingSessionId === OWN_SESSION_ID).length, scopedFailures);
    assert.equal(aggregate.requests.filter((request) => !request.teachingSessionId).length, unscopedBefore,
      'losing the selected class must not broaden a denied scoped read to the school');
    assert.equal(aggregateHarness.commandPosts.length, 0);
    aggregateHarness.setActiveSession(live);
    aggregateHarness.setAllSessions([live]);
    aggregate.setScopedResponse(success(rows()));
    await aggregatePage.getByTestId('students-query-error').getByRole('button', { name: 'Try again' }).click();
    await aggregatePage.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
    assert.equal(aggregate.requests.filter((request) => request.teachingSessionId === OWN_SESSION_ID).length, scopedFailures + 1);
    // The manual event listener owns lifecycle reconciliation; four related
    // browser events must not create four sequential aggregate requests.
    await aggregatePage.clock.fastForward(1000);
    const reconciliationsBefore = aggregate.requests.length;
    await lifecycleBurst(aggregatePage);
    await settle();
    assert.equal(aggregate.requests.length, reconciliationsBefore + 1);
    assert.deepEqual(aggregateHarness.pageErrors, []);
    await aggregatePage.close();

    const replacementPage = await browser.newPage();
    pages.push(replacementPage);
    await replacementPage.clock.install({ time: fixedTime });
    let releaseOldRequest;
    const oldRequestGate = new Promise((resolve) => { releaseOldRequest = resolve; });
    const replacementRequests = [];
    const replacement = teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID });
    const replacementAggregate = {
      async fulfill(route, url) {
        const sessionId = url.searchParams.get('teachingSessionId');
        replacementRequests.push(sessionId);
        if (sessionId === OWN_SESSION_ID) {
          await oldRequestGate;
          await route.fulfill({ status: 404, json: { code: 'CLASSPILOT_SESSION_UNAVAILABLE' } });
        } else {
          await route.fulfill({ json: sessionId ? rows('replacement-session-binding') : [] });
        }
      },
    };
    const replacementHarness = await configureDashboard(replacementPage, {
      aggregate: replacementAggregate, activeSession: live, allSessions: [live, replacement],
    });
    try {
      await replacementPage.goto(`${baseURL}/classpilot`);
      await waitUntil(() => replacementRequests.includes(OWN_SESSION_ID), 'old class aggregate must be pending');
      await replacementPage.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
      await replacementPage.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
      releaseOldRequest();
      await settle();
      assert.equal(await replacementPage.getByText('This class session is no longer available', { exact: true }).count(), 0,
        'a late404 for A cannot deny the currently selected B');
      await lifecycleBurst(replacementPage);
      await settle();
      assert.equal(replacementRequests.filter((id) => id === OWN_SESSION_ID).length, 1,
        'late completion cannot re-arm the superseded class');
      const replacementState = await replacementPage.evaluate((studentId) => ({
        cards: document.querySelectorAll(`[data-testid="card-student-${studentId}"]`).length,
        skeletons: document.querySelectorAll(`[data-testid="student-tile-skeleton-${studentId}"]`).length,
        selectedSession: document.querySelector('[data-testid="select-admin-observe"]')?.value,
        selection: document.querySelector('[data-testid="badge-selection-count"]')?.textContent,
        unavailable: document.querySelector('[data-testid="students-query-error"]')?.textContent,
      }), STUDENT_ID);
      assert.equal(replacementState.cards, 1, JSON.stringify({
        ...replacementState, pageErrors: replacementHarness.pageErrors,
        recentAggregateSessions: replacementRequests.slice(-3),
        recentTileSessions: replacementHarness.tileRequests.slice(-3).map((request) => request.body?.teachingSessionId),
      }));
      assert.deepEqual(replacementHarness.pageErrors, []);
    } finally {
      releaseOldRequest();
      await replacementPage.close();
    }

    const ineligiblePage = await browser.newPage();
    pages.push(ineligiblePage);
    await ineligiblePage.clock.install({ time: fixedTime });
    const nonLive = { ...teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID }), sessionMode: 'report_only', scheduledState: 'active' };
    const ineligibleHarness = await configureDashboard(ineligiblePage, {
      aggregate: aggregateController({ scoped: success(rows()) }), activeSession: null, allSessions: [nonLive],
    });
    await ineligiblePage.goto(`${baseURL}/classpilot`);
    await ineligiblePage.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
    await ineligiblePage.getByTestId('screenshot-observation-ineligible').waitFor();
    await ineligiblePage.clock.fastForward(120_000);
    await lifecycleBurst(ineligiblePage);
    await settle();
    assert.equal(ineligibleHarness.observationLeaseRequests.filter((request) => request.method === 'PUT').length, 0);
    assert.equal(ineligibleHarness.tileRequests.filter((request) => request.pathname.endsWith('/screenshots')).length, 0);
    await assertObserveEntryPointsUnavailable(ineligiblePage, ineligibleHarness.commandPosts, [STUDENT_ID], ineligibleHarness.coverageMutationRequests);
    assert.deepEqual(ineligibleHarness.pageErrors, []);
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    await browser.close();
    await vite.close();
  }
});

test('live preview eligibility follows sign-in without replaying denied or superseded authority', { timeout: 180_000 }, async () => {
  const trace = (message) => {
    if (process.env.CLASSPILOT_BROWSER_TRACE === '1') process.stderr.write(`[preview eligibility] ${message}\n`);
  };
  const vite = await createServer({ root: APP_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const fixedTime = new Date('2026-09-08T12:40:00Z');
  const live = teachingSession();
  const pages = [];
  const pendingReleases = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const screenshots = (harness) => harness.tileRequests.filter((request) => request.pathname.endsWith('/screenshots'));
  const histories = (harness) => harness.tileRequests.filter((request) => request.pathname.endsWith('/history'));
  const scopedRequests = (aggregate, sessionId = OWN_SESSION_ID) => aggregate.requests.filter((request) => request.teachingSessionId === sessionId);
  const signedOut = (overrides = {}) => student({
    status: 'offline', loginState: 'not_logged_in', isLoggedIn: false,
    commandable: false, activityState: 'signed_out', monitoringState: 'not_expected',
    activeTabTitle: null, activeTabUrl: null, lastSeenAt: null, realtimeObservedAt: null,
    realtimeBinding: null, realtimeRevision: 1, classroomState: { revision: 1 },
    ...overrides,
  });
  const newPage = async () => {
    const page = await browser.newPage();
    pages.push(page);
    page.on('pageerror', (error) => trace(`page error: ${error.message}`));
    await page.clock.install({ time: fixedTime });
    return page;
  };
  const assertNoWarning = async (page) => assert.equal(await page.getByTestId('tile-read-denied').count(), 0);
  try {
    // The production report began with a frozen roster of 23 signed-out rows.
    // History is still authorized; only live screenshot requests should wait.
    const signInPage = await newPage();
    trace('signed-out roster and new logins');
    const roster = Array.from({ length: 23 }, (_, index) => signedOut({
      studentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      studentName: `Sign-in Student ${index + 1}`,
      studentEmail: `signin-${index + 1}@example.edu`,
      // A retained binding does not make an explicitly signed-out row eligible.
      realtimeBinding: index === 1 ? 'retained-signin-binding' : null,
    }));
    const signInAggregate = aggregateController({ scoped: success(roster) });
    const signInHarness = await configureDashboard(signInPage, {
      aggregate: signInAggregate, activeSession: live, allSessions: [live],
      screenshotTiles: (body) => ({ tiles: body.studentIds.map((studentId) => ({ studentId, screenshot: null })) }),
      historyTiles: { tiles: roster.map(({ studentId }) => ({ studentId, history: [] })) },
    });
    await signInPage.goto(`${baseURL}/classpilot`);
    await signInPage.waitForFunction(() => document.querySelector('[data-testid="text-offline-count"]')?.textContent === '23');
    await waitUntil(() => histories(signInHarness).length > 0, 'signed-out students must retain their authorized history cohort');
    await signInPage.clock.fastForward(65_000);
    await settle();
    assert.equal(screenshots(signInHarness).length, 0, 'an all-signed-out roster must never send an empty-access live screenshot request');
    assert.deepEqual([...histories(signInHarness)[0].body.studentIds].sort(), roster.map(({ studentId }) => studentId).sort());
    assert.match(await signInPage.getByTestId('badge-selection-count').innerText(), /All 23 students/);
    assert.equal(await signInPage.getByTestId(`card-student-${roster[0].studentId}`).getByText('Waiting for ClassPilot sign-in', { exact: true }).count(), 1);
    await assertNoWarning(signInPage);
    await signInHarness.authenticateWebSocket();
    for (const [index, binding] of [[0, 'fresh-signin-binding'], [1, 'retained-signin-binding']]) {
      const observedAtMs = await signInPage.evaluate(() => Date.now());
      const before = screenshots(signInHarness).length;
      roster[index] = student({
        studentId: roster[index].studentId, studentName: roster[index].studentName,
        studentEmail: roster[index].studentEmail, realtimeBinding: binding,
        realtimeRevision: 2, classroomState: { revision: 1 },
        realtimeObservedAt: new Date(observedAtMs).toISOString(), lastSeenAt: new Date(observedAtMs).toISOString(),
      });
      signInAggregate.setScopedResponse(success([...roster]));
      await signInHarness.sendWebSocketMessage({
        type: 'student-update', eventVersion: 2, schoolId: SCHOOL_ID,
        teachingSessionId: OWN_SESSION_ID, studentId: roster[index].studentId,
        realtimeBinding: binding, revision: 2, observedAtMs,
      });
      // Flush the 100ms socket batch, without waiting for a 30s reconciliation
      // or issuing a focus/refresh event. The second login keeps its old binding.
      await signInPage.clock.runFor(500);
      await waitUntil(() => screenshots(signInHarness).length > before, `login ${index + 1} must immediately request its eligible preview`);
      await signInPage.waitForFunction((count) => document.querySelector('[data-testid="text-online-count"]')?.textContent === String(count), index + 1);
      const eligible = roster.slice(0, index + 1).map(({ studentId }) => studentId).sort();
      assert.deepEqual([...screenshots(signInHarness).at(-1).body.studentIds].sort(), eligible,
        'the live request must contain only signed-in targets, including a same-binding eligibility change');
      assert.equal(await signInPage.getByTestId('text-offline-count').innerText(), String(22 - index));
      await assertNoWarning(signInPage);
    }
    assert.equal(signInHarness.commandPosts.length, 0, 'sign-in recovery must not send a classroom command');
    assert.deepEqual(signInHarness.pageErrors, []);
    await signInPage.close();

    // Missing telemetry is not the same as an explicit sign-out. Suppression
    // remains private, but stale and unknown students retain reconciliation.
    const uncertainPage = await newPage();
    trace('unknown/stale eligibility');
    const staleAt = new Date(fixedTime.getTime() - 120_000).toISOString();
    const uncertainRows = [
      student({ loginState: undefined, isLoggedIn: undefined, realtimeBinding: null, realtimeRevision: null, lastSeenAt: null, realtimeObservedAt: null }),
      student({ studentId: SIGNAL_LOST_STUDENT_ID, activityFresh: false, monitoringState: 'signal_lost', monitoringLostAt: staleAt, realtimeObservedAt: staleAt, lastSeenAt: staleAt }),
      signedOut({ studentId: SIGNED_OUT_STUDENT_ID }),
      student({ studentId: MOVED_CLASS_STUDENT_ID, activityState: 'delegated', _realtimeSuppressed: true, supervisionState: 'temporary_coverage', supervisionContext: { id: 'temporary-context', type: 'supervision' } }),
    ];
    const uncertainHarness = await configureDashboard(uncertainPage, {
      aggregate: aggregateController({ scoped: success(uncertainRows) }), activeSession: live, allSessions: [live],
    });
    await uncertainPage.goto(`${baseURL}/classpilot`);
    await waitUntil(() => screenshots(uncertainHarness).length > 0, 'unknown and stale monitoring must still request authorized previews');
    assert.deepEqual([...screenshots(uncertainHarness)[0].body.studentIds].sort(), [STUDENT_ID, SIGNAL_LOST_STUDENT_ID].sort());
    await waitUntil(() => histories(uncertainHarness).length > 0, 'screenshot eligibility must not remove history targets');
    assert.deepEqual([...histories(uncertainHarness)[0].body.studentIds].sort(), uncertainRows.map(({ studentId }) => studentId).sort());
    assert.deepEqual(uncertainHarness.pageErrors, []);
    await uncertainPage.close();

    // A logout can beat the aggregate snapshot. One screenshot404 may request
    // a fresh aggregate, but it must never clear or replay its denied authority.
    const logoutPage = await newPage();
    trace('recorded404, logout, and same-binding return');
    let releaseLogout;
    const logoutGate = new Promise((resolve) => { releaseLogout = resolve; });
    pendingReleases.push(releaseLogout);
    let logoutCanRead = true;
    const logoutAggregate = aggregateController({ scoped: success([student({ classroomState: { revision: 1 }, lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString() })]) });
    const logoutHarness = await configureDashboard(logoutPage, {
      aggregate: logoutAggregate, activeSession: live, allSessions: [live],
      screenshotTiles: async () => {
        if (logoutCanRead) return { tiles: [{ studentId: STUDENT_ID, screenshot: null }] };
        await logoutGate;
        return { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } };
      },
    });
    await logoutPage.goto(`${baseURL}/classpilot`);
    await waitUntil(() => screenshots(logoutHarness).length > 0, 'establish a successful initial scoped screenshot read');
    await logoutHarness.authenticateWebSocket();
    await logoutPage.waitForLoadState('networkidle');
    const screenshotsBeforeLogout = screenshots(logoutHarness).length;
    logoutCanRead = false;
    await logoutHarness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID, studentId: STUDENT_ID, capturedAt: fixedTime.toISOString() });
    await logoutPage.clock.runFor(500);
    await waitUntil(() => screenshots(logoutHarness).length === screenshotsBeforeLogout + 1, 'hold exactly one new screenshot read across the logout');
    assert.deepEqual(screenshots(logoutHarness).at(-1).body.studentIds, [STUDENT_ID]);
    assert.equal(screenshots(logoutHarness).at(-1).body.teachingSessionId, OWN_SESSION_ID);
    const beforeLogoutCheck = scopedRequests(logoutAggregate).length;
    logoutAggregate.setScopedResponse(success([signedOut({ realtimeBinding: 'binding-a', realtimeRevision: 2 })]));
    releaseLogout();
    await logoutPage.waitForFunction(() => document.querySelector('[data-testid="text-offline-count"]')?.textContent === '1');
    await settle();
    assert.equal(scopedRequests(logoutAggregate).length, beforeLogoutCheck + 1, 'a newly denied screenshot authority gets one aggregate reconciliation');
    await assertNoWarning(logoutPage);
    await logoutPage.clock.fastForward(65_000);
    await logoutPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    await settle();
    assert.equal(screenshots(logoutHarness).length, screenshotsBeforeLogout + 1, 'learning the sign-out must stop live requests rather than replay the404');
    assert.equal(logoutAggregate.requests.some((request) => request.teachingSessionId && request.teachingSessionId !== OWN_SESSION_ID), false);
    const returnedAt = await logoutPage.evaluate(() => Date.now());
    logoutCanRead = true;
    logoutAggregate.setScopedResponse(success([student({
      realtimeBinding: 'binding-a', realtimeRevision: 3, classroomState: { revision: 1 },
      lastSeenAt: new Date(returnedAt).toISOString(), realtimeObservedAt: new Date(returnedAt).toISOString(),
    })]));
    await logoutHarness.sendWebSocketMessage({
      type: 'student-update', eventVersion: 2, schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID,
      studentId: STUDENT_ID, realtimeBinding: 'binding-a', revision: 3, observedAtMs: returnedAt,
    });
    await logoutPage.clock.runFor(500);
    await waitUntil(() => screenshots(logoutHarness).length > screenshotsBeforeLogout + 1, 'a confirmed intervening sign-out permits a new same-binding login after an already-recorded404');
    await assertNoWarning(logoutPage);
    assert.deepEqual(logoutHarness.pageErrors, []);
    await logoutPage.close();

    const deniedPage = await newPage();
    trace('unchanged denial remains latched');
    let denyEstablishedRead = false;
    const deniedAggregate = aggregateController({ scoped: success([student({ lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString() })]) });
    const deniedHarness = await configureDashboard(deniedPage, {
      aggregate: deniedAggregate, activeSession: live, allSessions: [live],
      screenshotTiles: () => denyEstablishedRead
        ? { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } }
        : { tiles: [{ studentId: STUDENT_ID, screenshot: null }] },
    });
    await deniedPage.goto(`${baseURL}/classpilot`);
    await waitUntil(() => screenshots(deniedHarness).length > 0, 'establish the unchanged-authority screenshot read before denial');
    // Socket authentication refetches the aggregate once (auth-success calls
    // refetchQueries on the aggregate key). On a fast machine that fetch lands
    // before networkidle; on a loaded CI runner the CPU-bound React work after
    // auth-success can leave the network quiet for 500ms first, so networkidle
    // resolves with the refetch still to come. The baseline below was then one
    // short and "exactly one reconcile" could never be observed. Wait for the
    // auth reconcile explicitly before taking the baseline.
    const aggregateBeforeAuth = scopedRequests(deniedAggregate).length;
    await deniedHarness.authenticateWebSocket();
    await waitUntil(() => scopedRequests(deniedAggregate).length >= aggregateBeforeAuth + 1, 'socket authentication must reconcile the aggregate before the denial baseline is taken');
    await deniedPage.waitForLoadState('networkidle');
    const screenshotsBeforeDenial = screenshots(deniedHarness).length;
    const aggregateBeforeDenial = scopedRequests(deniedAggregate).length;
    denyEstablishedRead = true;
    await deniedHarness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID, studentId: STUDENT_ID, capturedAt: fixedTime.toISOString() });
    await deniedPage.clock.runFor(500);
    await deniedPage.getByTestId('tile-read-denied').waitFor();
    await waitUntil(() => scopedRequests(deniedAggregate).length === aggregateBeforeDenial + 1, 'the denial must reconcile once even when the aggregate authority is unchanged');
    await settle();
    const deniedRequestsBeforeEvents = scopedRequests(deniedAggregate).length;
    for (let index = 0; index < 3; index += 1) {
      await deniedHarness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID, studentId: STUDENT_ID, capturedAt: fixedTime.toISOString() });
    }
    await deniedPage.clock.runFor(1000);
    await settle();
    assert.equal(scopedRequests(deniedAggregate).length, deniedRequestsBeforeEvents, 'unchanged denied events cannot repeat the aggregate recovery attempt');
    assert.equal(screenshots(deniedHarness).length, screenshotsBeforeDenial + 1, 'successful aggregate reconciliation does not re-arm a genuine screenshot404');
    assert.equal(await deniedPage.getByTestId('tile-read-denied').count(), 1);
    await deniedPage.clock.fastForward(65_000);
    await deniedPage.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
    await settle();
    assert.equal(screenshots(deniedHarness).length, screenshotsBeforeDenial + 1, 'polls and lifecycle events still cannot replay unchanged denied authority');
    assert.deepEqual(deniedHarness.pageErrors, []);
    await deniedPage.close();

    // A new login replaces the request cohort. Its unchanged classmate keeps
    // the exact prior image, and the old cohort's eventual404 cannot deny them.
    const joinedPage = await newPage();
    trace('classmate placeholder across eligible-cohort replacement');
    let releasePriorCohort;
    let releaseJoinedCohort;
    const priorCohortGate = new Promise((resolve) => { releasePriorCohort = resolve; });
    const joinedCohortGate = new Promise((resolve) => { releaseJoinedCohort = resolve; });
    pendingReleases.push(releasePriorCohort, releaseJoinedCohort);
    let cohortPhase = 'startup';
    let heldPriorCohortRequests = 0;
    const joinedResponsePhases = [];
    const joinedRows = [
      student({ lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString() }),
      signedOut({ studentId: SIGNED_OUT_STUDENT_ID, studentName: 'Joining Student' }),
    ];
    const joinedAggregate = aggregateController({ scoped: success(joinedRows) });
    const joinedHarness = await configureDashboard(joinedPage, {
      aggregate: joinedAggregate, activeSession: live, allSessions: [live],
      screenshotTiles: async (body) => {
        const joined = body.studentIds.includes(SIGNED_OUT_STUDENT_ID);
        const reply = { phase: cohortPhase, targets: body.studentIds.length, joined, result: 'pending' };
        joinedResponsePhases.push(reply);
        if (joined) await joinedCohortGate;
        else if (cohortPhase === 'hold-prior') {
          heldPriorCohortRequests += 1;
          await priorCohortGate;
          reply.result = '404';
          return { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } };
        }
        reply.result = '200:image';
        return { tiles: [{ studentId: STUDENT_ID, bindingVersion: 'v2:unchanged-classmate', screenshot: {
          screenshot: joined ? UPDATED_SCREENSHOT_DATA_URL : TINY_SCREENSHOT_DATA_URL,
          timestamp: new Date(fixedTime.getTime() - (joined ? 500 : 1000)).toISOString(),
          bindingVersion: 'v2:unchanged-classmate',
        } }] };
      },
    });
    await joinedPage.goto(`${baseURL}/classpilot`);
    await assertInitialPreview(joinedPage, joinedHarness, joinedResponsePhases);
    trace('initial classmate image rendered');
    await joinedHarness.authenticateWebSocket();
    // Startup can legitimately issue more than one read while the observation
    // lease settles. Every startup read succeeds; only then arm the test race.
    await joinedPage.waitForLoadState('networkidle');
    assert.equal(await joinedPage.getByTestId(`screenshot-${STUDENT_ID}`).getAttribute('src'), TINY_SCREENSHOT_DATA_URL);
    const requestsBeforePriorCohort = screenshots(joinedHarness).length;
    cohortPhase = 'hold-prior';
    await joinedPage.clock.fastForward(31_000);
    await waitUntil(() => heldPriorCohortRequests > 0, 'the deliberately armed previous cohort reconciliation must be held in flight');
    assert.equal(heldPriorCohortRequests, 1, 'hold exactly one old-cohort request after successful startup');
    assert.equal(screenshots(joinedHarness).length, requestsBeforePriorCohort + 1);
    assert.deepEqual(screenshots(joinedHarness).at(-1).body.studentIds, [STUDENT_ID]);
    assert.equal(screenshots(joinedHarness).at(-1).body.teachingSessionId, OWN_SESSION_ID);
    trace('old cohort request held');
    cohortPhase = 'joining';
    const joinedAt = await joinedPage.evaluate(() => Date.now());
    joinedRows[1] = student({ studentId: SIGNED_OUT_STUDENT_ID, studentName: 'Joining Student', realtimeBinding: 'joining-binding', realtimeRevision: 2, lastSeenAt: new Date(joinedAt).toISOString(), realtimeObservedAt: new Date(joinedAt).toISOString() });
    joinedAggregate.setScopedResponse(success([...joinedRows]));
    await joinedHarness.sendWebSocketMessage({ type: 'student-update', eventVersion: 2, schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID, studentId: SIGNED_OUT_STUDENT_ID, realtimeBinding: 'joining-binding', revision: 2, observedAtMs: joinedAt });
    await joinedPage.clock.runFor(500);
    await waitUntil(() => screenshots(joinedHarness).some((request) => request.body.studentIds.length === 2), 'the new login must create its eligible replacement cohort');
    trace('replacement cohort request held');
    assert.equal(await joinedPage.getByTestId(`screenshot-${STUDENT_ID}`).count(), 1,
      `unchanged classmate must retain its preview during eligible-cohort replacement; skeletons: ${await joinedPage.getByTestId(`student-tile-skeleton-${STUDENT_ID}`).count()}, connected: ${await joinedPage.getByTestId('text-online-count').innerText()}`);
    assert.equal(await joinedPage.getByTestId(`screenshot-${STUDENT_ID}`).getAttribute('src'), TINY_SCREENSHOT_DATA_URL,
      'a classmate with unchanged authority retains its decoded frame while the replacement cohort is pending');
    releaseJoinedCohort();
    trace('replacement cohort response released');
    await joinedPage.waitForFunction(({ id, source }) => document.querySelector(`[data-testid="screenshot-${id}"]`)?.getAttribute('src') === source,
      { id: STUDENT_ID, source: UPDATED_SCREENSHOT_DATA_URL });
    const readsBeforePriorCohort = joinedAggregate.requests.length;
    releasePriorCohort();
    await settle();
    assert.equal(joinedAggregate.requests.length, readsBeforePriorCohort, 'a replaced cohort404 cannot recheck unchanged classmates');
    await assertNoWarning(joinedPage);
    assert.equal(await joinedPage.getByTestId(`screenshot-${STUDENT_ID}`).getAttribute('src'), UPDATED_SCREENSHOT_DATA_URL);
    assert.deepEqual(joinedHarness.pageErrors, []);
    await joinedPage.close();
    trace('classmate placeholder case complete');

    // A→signed-out→A may reuse the opaque binding and cohort key. Neither an
    // old targeted success nor404 may revive pixels/denials after that cycle.
    for (const oldResult of ['success', 'denial']) {
      trace(`late targeted ${oldResult} across same-binding sign-out/login`);
      const bindingPage = await newPage();
      let releaseOldTargeted;
      const oldTargetedGate = new Promise((resolve) => { releaseOldTargeted = resolve; });
      pendingReleases.push(releaseOldTargeted);
      let screenshotPhase = 'startup';
      let heldTargetedRequests = 0;
      let restoredScreenshotRequests = 0;
      let delayedCaptureAt = fixedTime.toISOString();
      const bindingResponsePhases = [];
      const bindingRows = (loggedIn, revision) => [student({
        status: loggedIn ? 'online' : 'offline', isLoggedIn: loggedIn,
        loginState: loggedIn ? 'logged_in' : 'not_logged_in',
        activityState: loggedIn ? 'active' : 'signed_out',
        realtimeBinding: 'same-binding-across-eligibility', realtimeRevision: revision,
        classroomState: { revision: 1 }, lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString(),
      })];
      const bindingAggregate = aggregateController({ scoped: success(bindingRows(true, 1)) });
      const bindingHarness = await configureDashboard(bindingPage, {
        aggregate: bindingAggregate, activeSession: live, allSessions: [live],
        screenshotTiles: async () => {
          const requestPhase = screenshotPhase;
          const reply = { phase: requestPhase, result: 'pending' };
          bindingResponsePhases.push(reply);
          if (requestPhase === 'hold-targeted') {
            heldTargetedRequests += 1;
            await oldTargetedGate;
            if (oldResult === 'denial') {
              reply.result = '404';
              return { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } };
            }
          }
          if (requestPhase === 'restored') restoredScreenshotRequests += 1;
          reply.result = '200:image';
          return { tiles: [{ studentId: STUDENT_ID, bindingVersion: 'v2:same-binding-eligibility', screenshot: {
            screenshot: requestPhase === 'hold-targeted' ? VIEWER_SCREENSHOT_DATA_URL : requestPhase === 'restored' ? UPDATED_SCREENSHOT_DATA_URL : TINY_SCREENSHOT_DATA_URL,
            timestamp: requestPhase === 'hold-targeted' ? delayedCaptureAt : new Date(fixedTime.getTime() - (requestPhase === 'restored' ? 500 : 1000)).toISOString(),
            bindingVersion: 'v2:same-binding-eligibility',
          } }] };
        },
      });
      await bindingPage.goto(`${baseURL}/classpilot`);
      await assertInitialPreview(bindingPage, bindingHarness, bindingResponsePhases);
      await bindingHarness.authenticateWebSocket();
      await bindingPage.waitForLoadState('networkidle');
      assert.equal(await bindingPage.getByTestId(`screenshot-${STUDENT_ID}`).getAttribute('src'), TINY_SCREENSHOT_DATA_URL);
      const requestsBeforeTargeted = screenshots(bindingHarness).length;
      screenshotPhase = 'hold-targeted';
      await bindingHarness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID, studentId: STUDENT_ID, capturedAt: fixedTime.toISOString() });
      await bindingPage.clock.runFor(250);
      await waitUntil(() => heldTargetedRequests > 0, 'the deliberately armed targeted request must be held in flight');
      assert.equal(heldTargetedRequests, 1);
      assert.equal(screenshots(bindingHarness).length, requestsBeforeTargeted + 1);
      assert.deepEqual(screenshots(bindingHarness).at(-1).body.studentIds, [STUDENT_ID]);
      assert.equal(screenshots(bindingHarness).at(-1).body.teachingSessionId, OWN_SESSION_ID);
      screenshotPhase = 'signed-out';
      bindingAggregate.setScopedResponse(success(bindingRows(false, 2)));
      await bindingPage.evaluate(() => window.dispatchEvent(new Event('online')));
      await bindingPage.waitForFunction(() => document.querySelector('[data-testid="text-offline-count"]')?.textContent === '1');
      assert.equal(await bindingPage.getByTestId(`screenshot-${STUDENT_ID}`).count(), 0, 'a real sign-out scrubs the former screenshot');
      screenshotPhase = 'restored';
      bindingAggregate.setScopedResponse(success(bindingRows(true, 3)));
      await bindingPage.evaluate(() => window.dispatchEvent(new Event('online')));
      await waitUntil(() => restoredScreenshotRequests > 0, 'returning to the same recent cohort key must immediately fetch after sign-in');
      await bindingPage.waitForFunction(({ id, source }) => document.querySelector(`[data-testid="screenshot-${id}"]`)?.getAttribute('src') === source,
        { id: STUDENT_ID, source: UPDATED_SCREENSHOT_DATA_URL });
      const readsBeforeOldTargeted = bindingAggregate.requests.length;
      // Make the late image look newer by capture time. Only the old request's
      // revoked eligibility generation may reject it, not timestamp ordering.
      delayedCaptureAt = new Date(await bindingPage.evaluate(() => Date.now())).toISOString();
      releaseOldTargeted();
      await settle();
      await bindingPage.clock.runFor(500);
      assert.equal(bindingAggregate.requests.length, readsBeforeOldTargeted, `late targeted ${oldResult} cannot recheck the new eligibility generation`);
      assert.equal(await bindingPage.getByTestId(`screenshot-${STUDENT_ID}`).getAttribute('src'), UPDATED_SCREENSHOT_DATA_URL,
        `late targeted ${oldResult} must not replace or clear the current preview`);
      await assertNoWarning(bindingPage);
      assert.deepEqual(bindingHarness.pageErrors, []);
      await bindingPage.close();
      trace(`late targeted ${oldResult} case complete`);
    }

    // Completing A's old screenshot request after Observe selects B must not
    // deny B, refresh either superseded authority, or broaden to school scope.
    const navigationPage = await newPage();
    trace('old class response after navigation');
    const replacement = teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID });
    let releaseOldScreenshot;
    const oldScreenshotGate = new Promise((resolve) => { releaseOldScreenshot = resolve; });
    pendingReleases.push(releaseOldScreenshot);
    const navigationAggregate = aggregateController({ scoped: success([student({ lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString() })]) });
    const navigationHarness = await configureDashboard(navigationPage, {
      aggregate: navigationAggregate, activeSession: live, allSessions: [live, replacement],
      screenshotTiles: async (body) => {
        if (body.teachingSessionId === OWN_SESSION_ID) {
          await oldScreenshotGate;
          return { status: 404, body: { code: 'CLASSPILOT_NO_ACCESSIBLE_TILES' } };
        }
        return { tiles: [{ studentId: STUDENT_ID, screenshot: null }] };
      },
    });
    await navigationPage.goto(`${baseURL}/classpilot`);
    await waitUntil(() => screenshots(navigationHarness).some((request) => request.body.teachingSessionId === OWN_SESSION_ID), 'A screenshot must be pending before the class switch');
    await navigationPage.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
    await waitUntil(() => screenshots(navigationHarness).some((request) => request.body.teachingSessionId === OBSERVED_SESSION_ID), 'B must obtain its own scoped preview read');
    await settle();
    const requestsBeforeOldCompletion = navigationAggregate.requests.length;
    releaseOldScreenshot();
    await settle();
    assert.equal(navigationAggregate.requests.length, requestsBeforeOldCompletion, 'a late old-class404 cannot trigger recovery in either class');
    await assertNoWarning(navigationPage);
    assert.equal(await navigationPage.getByTestId(`card-student-${STUDENT_ID}`).count(), 1);
    assert.equal(screenshots(navigationHarness).every((request) => Boolean(request.body.teachingSessionId)), true);
    assert.deepEqual(navigationHarness.pageErrors, []);
    await navigationPage.close();
  } finally {
    for (const release of pendingReleases) release();
    for (const page of pages) await page.close().catch(() => {});
    await browser.close();
    await vite.close();
  }
});

test('a pending observation acknowledgement preserves the first exact-bound preview response', { timeout: 45_000 }, async () => {
  const vite = await createServer({ root: APP_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const fixedTime = new Date('2026-09-08T12:40:00Z');
  let releaseObservation;
  let releaseScreenshot;
  const observationGate = new Promise((resolve) => { releaseObservation = resolve; });
  const screenshotGate = new Promise((resolve) => { releaseScreenshot = resolve; });
  const responsePhases = [];
  let observationStarted = false;
  try {
    await page.clock.install({ time: fixedTime });
    const live = teachingSession();
    const harness = await configureDashboard(page, {
      aggregate: aggregateController({ scoped: success([student({ lastSeenAt: fixedTime.toISOString(), realtimeObservedAt: fixedTime.toISOString() })]) }),
      activeSession: live, allSessions: [live],
      observationLeaseResponse: async (method) => {
        if (method === 'PUT') {
          observationStarted = true;
          await observationGate;
        }
        return { renewAfterSeconds: 30 };
      },
      screenshotTiles: async () => {
        const reply = { phase: 'began-before-observation-acknowledgement', result: 'pending' };
        responsePhases.push(reply);
        await screenshotGate;
        reply.result = '200:exact-image';
        return { tiles: [{ studentId: STUDENT_ID, bindingVersion: 'v2:pending-observation-first-image', screenshot: {
          screenshot: TINY_SCREENSHOT_DATA_URL,
          timestamp: new Date(fixedTime.getTime() - 1000).toISOString(),
          bindingVersion: 'v2:pending-observation-first-image',
        } }] };
      },
    });
    const screenshots = () => harness.tileRequests.filter((request) => request.pathname.endsWith('/screenshots'));
    const histories = () => harness.tileRequests.filter((request) => request.pathname.endsWith('/history'));
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/classpilot`);
    await waitUntil(() => observationStarted && screenshots().length > 0, 'exact-bound screenshot reads must begin while the observation PUT is still pending');
    assert.equal(screenshots().length, 1);
    assert.equal(histories().length, 0, 'the pending observation state must not yet enable history polling');
    assert.deepEqual(screenshots()[0].body.studentIds, [STUDENT_ID]);
    assert.equal(screenshots()[0].body.teachingSessionId, OWN_SESSION_ID);
    releaseObservation();
    // History polling is enabled only after the successful PUT has changed
    // the rendered observation state. This proves the required ordering,
    // rather than sleeping and assuming the acknowledgement was applied.
    await waitUntil(() => histories().length > 0, 'the observation acknowledgement must be committed before the screenshot response is released');
    assert.equal(screenshots().length, 1, 'the observation effect must join the already-pending exact-bound read');
    releaseScreenshot();
    await assertInitialPreview(page, harness, responsePhases, 7_500);
    assert.equal(await page.getByTestId(`screenshot-${STUDENT_ID}`).getAttribute('src'), TINY_SCREENSHOT_DATA_URL);
    assert.equal(screenshots().length, 1, 'the first response must paint without waiting for a periodic or replacement request');
    assert.equal(await page.getByTestId('tile-read-denied').count(), 0);
    assert.deepEqual(harness.pageErrors, []);
  } finally {
    releaseObservation();
    releaseScreenshot();
    await page.close().catch(() => {});
    await browser.close();
    await vite.close();
  }
});

const OWN_TESTING_CONTEXT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_TESTING_CONTEXT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_SCHOOL_ID = '12121212-1212-4212-8212-121212121212';
const TESTING_TIME = new Date('2026-09-14T12:40:00Z');

function ownSupervisionSummary(contexts = []) {
  return {
    ...ownTestingSummary([]),
    ownSupervisionContexts: contexts.map(context => ({
      startsAt: '2026-09-14T12:00:00Z', endsAt: '2026-09-14T16:00:00Z',
      activeStudentCount: 1, ...context,
    })),
  };
}

test('supervision navigation intents are personal, one-use, and contain no student roster', async () => {
  const { createSupervisionDashboardIntent, consumeSupervisionDashboardIntent, withoutSupervisionDashboardIntent } = await import('../src/products/classpilot/lib/supervisionDashboardNavigation.js');
  const context = { id: OWN_TESTING_CONTEXT_ID, name: 'Other', assignedStaffId: ADMIN_ID, endsAt: '2099-01-01T00:00:00Z', studentIds: ['private-student'] };
  const state = createSupervisionDashboardIntent({ schoolId: SCHOOL_ID, viewerId: ADMIN_ID, contexts: [context] });
  assert.equal(JSON.stringify(state).includes('private-student'), false);
  assert.deepEqual(consumeSupervisionDashboardIntent(state, { schoolId: SCHOOL_ID, viewerId: ADMIN_ID }).contexts.map(item => item.id), [OWN_TESTING_CONTEXT_ID]);
  assert.equal(consumeSupervisionDashboardIntent(state, { schoolId: SCHOOL_ID, viewerId: ADMIN_ID }), null);
  const wrongSchool = createSupervisionDashboardIntent({ schoolId: SCHOOL_ID, viewerId: ADMIN_ID, contexts: [context] });
  assert.equal(consumeSupervisionDashboardIntent(wrongSchool, { schoolId: SECOND_SCHOOL_ID, viewerId: ADMIN_ID }), null);
  assert.equal(consumeSupervisionDashboardIntent(wrongSchool, { schoolId: SCHOOL_ID, viewerId: ADMIN_ID }), null, 'A stale foreign-school intent is discarded permanently');
  assert.deepEqual(withoutSupervisionDashboardIntent({ ...state, kept: true }), { kept: true });
});

test('manual supervision displays normal offline tiles from every own context and returns to the current custom class', { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const rows = Array.from({ length: 20 }, (_, index) => testingStudent(
    `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, '0')}`,
    index < 10 ? OWN_TESTING_CONTEXT_ID : OTHER_TESTING_CONTEXT_ID,
  )).map(row => ({ ...row, status: 'offline', online: false, isOnline: false, realtimeStatus: 'offline', lastSeenAt: null, realtimeObservedAt: null, currentUrl: null, activeTabUrl: null }));
  const summary = ownSupervisionSummary([
    { id: OWN_TESTING_CONTEXT_ID, name: 'Other', contextType: 'other', activeStudentCount: 10 },
    { id: OTHER_TESTING_CONTEXT_ID, name: 'Library', contextType: 'supervision_group', activeStudentCount: 10 },
  ]);
  const harness = await configureDashboard(page, {
    aggregate: aggregateController({ scoped: success([student({ studentId: MOVED_CLASS_STUDENT_ID })]) }),
    userRole: 'teacher', coverageSummary: summary,
    claimedStudents: [...rows, rows[0], testingStudent(STUDENT_ID, 'someone-elses-context', OTHER_TEACHER_ID)],
  });
  const personalRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/coverage/claimed-students') personalRequests.push(request.url());
  });
  await page.goto(`${baseURL}/classpilot`);
  await assertPickupView(page, 'claimed');
  await page.getByTestId(`card-student-${rows.at(-1).studentId}`).waitFor();
  assert.equal(await page.locator('[data-testid^="card-student-"]').count(), 20, 'Offline students remain normal Dashboard tiles; duplicate roster rows do not duplicate tiles');
  assert.match(await page.getByTestId('assigned-supervision-notice').innerText(), /Other.*Library/);
  assert(personalRequests.every(url => new URL(url).searchParams.get('scope') === 'mine'));
  await harness.authenticateWebSocket();
  await page.getByTestId('button-view-class-students').click();
  await page.getByTestId('supervision-other-view-notice').waitFor();
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await assertPickupView(page, 'class');
  await page.getByRole('button', { name: 'View supervised students', exact: true }).click();
  await assertPickupView(page, 'claimed');
  await page.waitForFunction(() => document.activeElement?.dataset.testid === 'assigned-testing-notice');

  harness.setCoverageSummary(ownSupervisionSummary([{ id: OTHER_TESTING_CONTEXT_ID, name: 'Library', activeStudentCount: 10 }]));
  harness.setClaimedStudents(rows.slice(10));
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.getByTestId(`card-student-${rows[0].studentId}`).waitFor({ state: 'hidden' });
  await assertPickupView(page, 'claimed');
  harness.setCoverageSummary(ownSupervisionSummary([]));
  harness.setClaimedStudents([]);
  harness.setActiveSession({ ...teachingSession(), lifecycle: { kind: 'scheduled', state: 'active' } });
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await assertPickupView(page, 'class');
  await page.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`).waitFor();
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('confirmed Coverage navigation survives failed reads, retries only reads, and consumes the intent', { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  await page.addInitScript(({ schoolId, viewerId, contextId }) => {
    if (location.pathname !== '/classpilot') return;
    history.replaceState({ ...history.state, usr: { classpilotSupervisionDashboard: {
      id: 'confirmed-own-coverage-navigation', schoolId, viewerId,
      contexts: [{ id: contextId, name: 'Other', assignedStaffId: viewerId, endsAt: '2026-09-14T16:00:00Z' }],
    } } }, '');
  }, { schoolId: SCHOOL_ID, viewerId: ADMIN_ID, contextId: OWN_TESTING_CONTEXT_ID });
  let unavailable = true;
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    coverageSummary: () => unavailable
      ? { status: 503, body: { error: 'Temporary summary failure' } }
      : ownSupervisionSummary([{ id: OWN_TESTING_CONTEXT_ID, name: 'Other' }]),
    claimedStudents: () => unavailable
      ? { status: 503, body: { error: 'Temporary roster failure' } }
      : [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
  });
  await page.goto(`${baseURL}/classpilot`);
  await assertPickupView(page, 'claimed');
  await page.clock.fastForward(2_000);
  await page.getByText('Supervision started; students could not load.', { exact: false }).waitFor();
  await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
  await page.getByLabel('Active supervision count unavailable', { exact: true }).waitFor();
  assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), []);
  assert.deepEqual(await numericSupervisionBadge(page, 'button-coverage-tab'), []);
  await page.waitForFunction(() => document.activeElement?.dataset.testid === 'assigned-testing-notice');
  assert.equal(await page.evaluate(() => !!history.state?.usr?.classpilotSupervisionDashboard), false);
  unavailable = false;
  await page.getByRole('button', { name: 'Retry supervision refresh', exact: true }).click();
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await assertPickupView(page, 'claimed');
  await waitForSupervisionBadges(page, { claimed: 1, coverage: 1 });
  assert.deepEqual(harness.coverageMutationRequests, [], 'Retrying a successful claim only repeats reads');
  assert.deepEqual(harness.pageErrors, []);
});

for (const userRole of ['teacher', 'admin']) {
test(`Dashboard ${userRole} claims keep partial successes visible and automatic return remains enabled`, { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const available = [STUDENT_ID, SIGNED_OUT_STUDENT_ID].map((id, index) => ({
    ...testingStudent(id, OWN_TESTING_CONTEXT_ID), supervisionState: 'online_unassigned',
    matchingGroups: [{ id: `claim-group-${index}`, name: `Claim group ${index}` }],
  }));
  const claimRequests = [];
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(), userRole, availableStudents: available,
    coverageSummary: ownSupervisionSummary([]),
    claimResponse: async request => {
      const body = request.postDataJSON();
      claimRequests.push({ body, schoolId: request.headers()['x-school-id'] });
      if (body.supervisionGroupId === 'claim-group-1') {
        return { status: 409, body: { error: 'Another teacher already claimed this student.' } };
      }
      harness.setCoverageSummary(ownSupervisionSummary([{ id: OWN_TESTING_CONTEXT_ID, name: 'Claim group 0' }]));
      harness.setClaimedStudents([testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)]);
      return { context: { id: OWN_TESTING_CONTEXT_ID, name: 'Claim group 0', assignedStaffId: ADMIN_ID, endsAt: '2026-09-14T16:00:00Z' } };
    },
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('button-view-available-students').click();
  assert.equal(await page.getByTestId('select-admin-observe').count(), userRole === 'admin' ? 1 : 0,
    'Observe is available only to administrators, while both roles can claim');
  await page.getByTestId('button-claim-all-students').click();
  await assertPickupView(page, 'claimed');
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await page.getByTestId('assigned-supervision-notice').waitFor();
  assert.equal(await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).count(), 0);
  assert.equal(claimRequests.length, 2);
  assert(claimRequests.every(request => request.schoolId === SCHOOL_ID));
  await harness.authenticateWebSocket();
  harness.setCoverageSummary(ownSupervisionSummary([]));
  harness.setClaimedStudents([]);
  harness.setActiveSession(teachingSession());
  harness.setAllSessions([teachingSession()]);
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await assertPickupView(page, 'class');
  await page.getByTestId(userRole === 'admin' ? 'button-admin-end-session' : 'badge-active-session').waitFor();
  await page.clock.fastForward(10_100);
  assert.equal(claimRequests.length, 2, 'Settling a partial claim never retries either mutation automatically');
  assert.deepEqual(harness.pageErrors, []);
});
}

test('a delayed own claim cannot switch the Dashboard after the teacher changes schools', { timeout: 75_000 }, async context => {
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';
    import {LicenseProvider} from '/src/contexts/LicenseContext.jsx';
    import {ThemeProvider} from '/src/contexts/ThemeContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js';
    import Dashboard from '/src/products/classpilot/pages/Dashboard.jsx'; import '/src/index.css';
    function Bridge(){const auth=useAuth();React.useEffect(()=>{window.__switchClaimSchool=auth.switchSchool;},[auth.switchSchool]);return React.createElement('div',{'data-testid':'claim-school'},auth.activeSchoolId);}
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(LicenseProvider,null,React.createElement(ThemeProvider,null,React.createElement(MemoryRouter,null,React.createElement(React.Fragment,null,React.createElement(Bridge),React.createElement(Dashboard))))))));
  `;
  const { browser, baseURL } = await assignedTestingBrowser(context, { plugins: [{
    name: 'delayed-claim-school-fixture',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__delayed-claim-school') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__delayed-claim-entry.jsx"></script></body></html>'));
      });
    },
    resolveId(id) { if (id === '/__delayed-claim-entry.jsx') return '\0delayed-claim-entry'; },
    load(id) { if (id === '\0delayed-claim-entry') return entry; },
  }] });
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  let completeClaim;
  const claimGate = new Promise(resolve => { completeClaim = resolve; });
  context.after(() => completeClaim());
  let claimSchool = null;
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(), userRole: 'teacher',
    authentication: request => {
      const schoolId = request.headers()['x-school-id'] || SCHOOL_ID;
      return { ...authResponse(), activeSchoolId: schoolId,
        memberships: [SCHOOL_ID, SECOND_SCHOOL_ID].map(id => ({ schoolId: id, role: 'teacher', schoolName: `School ${id.slice(0, 4)}`, schoolTimezone: 'America/New_York' })) };
    },
    availableStudents: [{ ...testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID), supervisionState: 'online_unassigned' }],
    coverageSummary: request => ({ ...ownSupervisionSummary([]), schoolId: request.headers()['x-school-id'] || SCHOOL_ID }),
    claimResponse: async request => {
      claimSchool = request.headers()['x-school-id'];
      await claimGate;
      return { context: { id: OWN_TESTING_CONTEXT_ID, name: 'Old school claim', assignedStaffId: ADMIN_ID, endsAt: '2026-09-14T16:00:00Z' } };
    },
  });
  await page.goto(`${baseURL}/__delayed-claim-school`);
  await page.getByTestId('button-view-available-students').click();
  await page.getByTestId('button-claim-all-students').click();
  await waitUntil(() => claimSchool === SCHOOL_ID, 'The original claim is submitted under school A');
  await page.evaluate(schoolId => window.__switchClaimSchool(schoolId), SECOND_SCHOOL_ID);
  await page.waitForFunction(id => document.querySelector('[data-testid="claim-school"]')?.textContent === id, SECOND_SCHOOL_ID);
  await assertPickupView(page, 'class');
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/coverage/claim');
  completeClaim();
  await response;
  await page.clock.fastForward(500);
  await assertPickupView(page, 'class');
  assert.equal(await page.getByTestId('assigned-supervision-notice').count(), 0);
  assert.equal(await page.getByTestId(`card-student-${STUDENT_ID}`).count(), 0);
  assert.equal(harness.coverageMutationRequests.filter(request => request.pathname.endsWith('/claim')).length, 1);
  assert.deepEqual(harness.pageErrors, []);
});

function ownTestingSummary(contextIds = [], { schoolId = SCHOOL_ID, viewerId = ADMIN_ID } = {}) {
  return {
    revision: contextIds.join(':') || 'empty', schoolId, viewerId,
    availableStudentCount: 0, claimedStudentCount: contextIds.length + 1,
    activeContextCount: contextIds.length + 1,
    ownTestingContexts: contextIds.map(id => ({ id, name: `Assigned testing ${id.slice(0, 4)}`, endsAt: '2026-09-14T16:00:00Z', activeStudentCount: 1 })),
  };
}

function testingStudent(studentId, contextId, assignedStaffId = ADMIN_ID) {
  return student({
    studentId, studentName: `Testing student ${studentId.slice(0, 4)}`,
    contextId, contextName: `Testing ${contextId.slice(0, 4)}`, supervisionState: 'claimed',
    assignedStaff: { id: assignedStaffId, displayName: assignedStaffId === ADMIN_ID ? 'Alex Admin' : 'Other Teacher' },
    lastSeenAt: TESTING_TIME.toISOString(), realtimeObservedAt: TESTING_TIME.toISOString(),
  });
}

async function assertPickupView(page, view) {
  await page.waitForFunction(value => document.querySelector(`[data-testid="button-view-${value}-students"]`)?.getAttribute('aria-pressed') === 'true', view);
}

const CHAT_MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAT_REPLY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHAT_MESSAGE_TEXT = 'Synthetic student reply stays in this classroom';
const CHAT_REPLY_TEXT = 'Synthetic teacher response';

function storedChatMessage(overrides = {}) {
  return {
    id: CHAT_MESSAGE_ID, schoolId: SCHOOL_ID, sessionId: OWN_SESSION_ID,
    studentId: STUDENT_ID, senderId: STUDENT_ID, senderType: 'student',
    content: CHAT_MESSAGE_TEXT, messageType: 'message', deliveryStatus: 'delivered',
    createdAt: new Date().toISOString(), ...overrides,
  };
}

function studentChatEvent(row = storedChatMessage()) {
  return {
    type: 'student-message', schoolId: row.schoolId, sessionId: row.sessionId,
    data: { id: row.id, sessionId: row.sessionId, studentId: row.studentId,
      studentName: 'Ada Student', studentEmail: 'ada@example.edu',
      message: row.content, messageType: row.messageType, timestamp: row.createdAt },
  };
}

async function chatBrowserFixture(context, options = {}) {
  const { browser, baseURL } = await assignedTestingBrowser(context, { plugins: chatBaselinePlugins() });
  const page = await browser.newPage();
  if (options.clockTime) await page.clock.install({ time: new Date(options.clockTime) });
  const socketConsole = [];
  page.on('console', message => { if (message.text().startsWith('[Dashboard]')) socketConsole.push(message.text()); });
  const aggregate = aggregateController({ scoped: success([student()]) });
  const live = teachingSession();
  const harness = await configureDashboard(page, {
    aggregate, userRole: 'teacher', activeSession: live, allSessions: [live], acknowledgeSessionSubscriptions: true,
  });
  const reads = [];
  const mutations = [];
  let messages = [];
  let historyResponder = null;
  let replyResponder = null;
  let rosterRevision = 1;
  await page.route('**/api/teacher/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/teacher/messages' && request.method() === 'GET') {
      reads.push({ sessionId: url.searchParams.get('sessionId'), schoolId: request.headers()['x-school-id'] });
      const response = historyResponder ? await historyResponder(request) : { messages };
      await route.fulfill(response.status
        ? { status: response.status, json: response.body }
        : { json: response });
      return;
    }
    if (request.method() === 'POST' && ['/api/teacher/reply', '/api/teacher/close-chat', '/api/teacher/messages/read'].includes(url.pathname)) {
      const body = request.postDataJSON();
      mutations.push({ pathname: url.pathname, body });
      const response = url.pathname.endsWith('/reply')
        ? replyResponder ? await replyResponder(request) : {
          message: storedChatMessage({ id: CHAT_REPLY_ID, senderId: ADMIN_ID, senderType: 'teacher', content: CHAT_REPLY_TEXT, deliveryStatus: 'sent' }), queued: true,
        }
        : url.pathname.endsWith('/read')
          ? { readAt: new Date().toISOString(), updatedIds: body?.messageIds || [] }
          : { ok: true };
      await route.fulfill({ status: url.pathname.endsWith('/reply') ? 202 : 200, json: response });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await waitUntil(() => reads.length > 0, 'The canonical chat history must be requested');
  await harness.authenticateWebSocket();
  if (options.openPanel !== false) {
    await openChatPanel(page);
    await page.getByTestId('chat-empty').waitFor();
  }
  const refetch = (prefix, wait = true) => page.evaluate(async ({ prefix, wait }) => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    const pending = queryClient.invalidateQueries({ queryKey: [prefix] });
    if (wait) await pending;
  }, { prefix, wait });
  const fixture = {
    page, harness, reads, mutations, refetch, socketConsole,
    setMessages(next) { messages = next; },
    setHistoryResponder(next) { historyResponder = next; },
    setReplyResponder(next) { replyResponder = next; },
    async updateRoster({ refetchAggregate = true } = {}) {
      rosterRevision += 1;
      const title = `Chat fixture roster revision ${rosterRevision}`;
      const observedAt = Date.now() + rosterRevision;
      aggregate.setScopedResponse(success([student({
        activeTabTitle: title, realtimeRevision: rosterRevision,
        lastSeenAt: new Date(observedAt).toISOString(), realtimeObservedAt: new Date(observedAt).toISOString(),
      })]));
      await harness.sendWebSocketMessage({
        type: 'student-update', eventVersion: 2, schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID,
        studentId: STUDENT_ID, realtimeBinding: 'binding-a', revision: rosterRevision,
        observedAtMs: observedAt, activeTabTitle: title,
      });
      await page.getByTestId(`text-tab-title-${STUDENT_ID}`).getByText(title, { exact: true }).waitFor();
      if (refetchAggregate) await refetch('/api/students-aggregated');
    },
  };
  if (options.onReady) await options.onReady(fixture);
  return fixture;
}

async function chatEvidence(page, name, facts = {}) {
  const evidence = process.env.CLASSPILOT_CHAT_EVIDENCE_DIR;
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
  writeFileSync(path.join(evidence, `${name}.json`), `${JSON.stringify(facts, null, 2)}\n`);
}

async function openChatPanel(page) {
  if (await page.getByTestId('chat-drawer').isVisible()) return;
  if (!await page.getByTestId('class-tools-panel').isVisible()) await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByTestId('chat-open').click();
  await page.getByTestId('chat-drawer').waitFor();
}

// Chat selectors live here so a panel redesign changes one place, not every test.
// The drawer is an inbox: the conversation list previews each thread's last
// line, and the selected thread shows every bubble. Selecting a thread reads it.
async function expectChatUnread(page, count) {
  await page.getByTestId('chat-drawer-unread-count').getByText(String(count), { exact: true }).waitFor();
}
async function selectConversation(page, studentId = STUDENT_ID) {
  const thread = page.getByTestId('chat-thread');
  if (await thread.count() && await thread.getAttribute('data-student-id') === studentId) return;

  await page.getByTestId(`chat-conversation-${studentId}`).click();
  await page.getByTestId('chat-thread').waitFor();
}
function listText(page, text) {
  return page.getByTestId('chat-conversations').getByText(text, { exact: true });
}
function threadText(page, text) {
  return page.getByTestId('chat-thread').getByText(text, { exact: true });
}
function replyInput(page) {
  return page.getByTestId('chat-composer-input');
}
async function endChat(page, studentId = STUDENT_ID) {
  await selectConversation(page, studentId);
  await page.getByTestId('chat-thread-menu').click();
  await page.getByTestId('chat-thread-end').click();
}
async function expectChatEmpty(page) {
  await page.getByTestId('chat-empty').waitFor();
}

test('chat recovery: a live student reply survives roster rehydration with unread and read state intact', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  await expectChatUnread(page, 1);
  await chatEvidence(page, 'realtime-visible', { visible: true, canonicalHistory: 'empty', messageCount: 1 });
  await fixture.updateRoster({ refetchAggregate: false });
  const retained = await listText(page, CHAT_MESSAGE_TEXT).count() === 1;
  await chatEvidence(page, 'after-roster-update', { retained, canonicalHistory: 'empty', studentTelemetryChanged: true });
  if (!retained && process.env.CLASSPILOT_CHAT_BASELINE_SOURCE) {
    fixture.setMessages([row]);
    await page.reload();
    await openChatPanel(page);
    await listText(page, CHAT_MESSAGE_TEXT).waitFor();
    await chatEvidence(page, 'baseline-reload-restored', { restored: true, canonicalHistory: 'committed reply', noStudentResend: true });
  }
  assert.equal(retained, true, 'A roster update must not replace a live student reply with the older cached empty history');
  await expectChatUnread(page, 1);
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await fixture.updateRoster();
  assert.equal(await listText(page, CHAT_MESSAGE_TEXT).count(), 1, 'Duplicate WebSocket delivery must not duplicate a reply');
  await expectChatUnread(page, 1);
  await selectConversation(page);
  await expectChatUnread(page, 0);
  fixture.setMessages([row]);
  await fixture.refetch('/api/teacher/messages');
  await fixture.updateRoster();
  await expectChatUnread(page, 0);
  assert.equal(await threadText(page, CHAT_MESSAGE_TEXT).count(), 1);
  const readsBeforeReconnect = fixture.reads.length;
  await harness.disconnectWebSocket();
  await harness.authenticateWebSocket();
  await waitUntil(() => fixture.reads.length > readsBeforeReconnect, 'Reconnecting must reconcile missed chat messages with one history read');
  await chatHistorySettled(page);
  assert.equal(fixture.reads.length, readsBeforeReconnect + 1);
  await expectChatUnread(page, 0);
  assert.equal(await threadText(page, CHAT_MESSAGE_TEXT).count(), 1);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat safety net: a message that only reaches server history appears while connected and shows when it was sent', { timeout: 60_000 }, async context => {
  // A live student-message event can be dropped before it reaches this socket
  // (subscription, assignment or authority-revision mismatch, relay gap). The
  // WebSocket is the fast path, never the only path: the connected dashboard
  // must re-read history on its own, count the row as new, and stamp its time.
  const fixture = await chatBrowserFixture(context, { clockTime: '2026-09-18T14:05:00.000Z' });
  const { page, harness } = fixture;
  const readsBefore = fixture.reads.length;
  const row = storedChatMessage({ createdAt: '2026-09-18T14:03:00.000Z' });
  fixture.setMessages([row]);
  await page.clock.fastForward(16_000);
  await waitUntil(() => fixture.reads.length > readsBefore, 'A connected dashboard must re-read chat history on its own interval');
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  await expectChatUnread(page, 1);
  await selectConversation(page);
  const stamp = page.getByTestId('chat-message-time').first();
  assert.match(await stamp.innerText(), /\d{1,2}:\d{2}/, 'Each bubble carries the time the message was sent');
  assert.equal(await stamp.locator('time').getAttribute('datetime'), row.createdAt);
  const readsBeforeFocus = fixture.reads.length;
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    window.dispatchEvent(new Event('focus'));
  });
  await waitUntil(() => fixture.reads.length > readsBeforeFocus, 'Returning to the tab must re-read chat history');
  await chatHistorySettled(page);
  assert.equal(await threadText(page, CHAT_MESSAGE_TEXT).count(), 1, 'A re-read never duplicates a known message');
  assert.deepEqual(harness.pageErrors, []);
});

test('chat quick wins: Clear thread hides the conversation locally and never ends the chat on the student device', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await selectConversation(page);
  await page.getByTestId('chat-thread-clear').click();
  await expectChatEmpty(page);
  // Clearing is local: canonical history still holds the row and a re-read must not resurrect it.
  fixture.setMessages([row]);
  await fixture.refetch('/api/teacher/messages');
  await chatHistorySettled(page);
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0, 'A cleared thread stays hidden after a history re-read');
  assert.equal(fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/close-chat').length, 0, 'Clearing never tells the student device the chat ended');
  const next = storedChatMessage({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', content: 'Synthetic follow-up after clearing' });
  await harness.sendWebSocketMessage(studentChatEvent(next));
  await listText(page, next.content).waitFor();
  await expectChatUnread(page, 1);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat quick wins: a one-tap acknowledgement sends "Got it" and a trailing question mark flags a question', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const question = storedChatMessage({ content: 'Can I use the printer?' });
  await harness.sendWebSocketMessage(studentChatEvent(question));
  await selectConversation(page);
  await page.getByTestId(`chat-question-${question.id}`).waitFor();
  const ack = storedChatMessage({ id: CHAT_REPLY_ID, senderId: ADMIN_ID, senderType: 'teacher', content: 'Got it', deliveryStatus: 'sent' });
  fixture.setReplyResponder(async () => ({ message: ack, queued: true }));
  await page.getByTestId('chat-ack').click();
  await waitUntil(() => fixture.mutations.some(mutation => mutation.pathname === '/api/teacher/reply' && mutation.body?.message === 'Got it'),
    'The acknowledgement must post the canned text without typing');
  await page.getByTestId(`chat-bubble-${CHAT_REPLY_ID}`).getByText('Got it', { exact: true }).waitFor();
  assert.equal(fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/reply').length, 1);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat quick wins: the student tile shows an unread count that opens that thread and clears once it is read', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context, { openPanel: false });
  const { page, harness } = fixture;
  assert.equal(await page.getByTestId(`chat-unread-${STUDENT_ID}`).count(), 0, 'No badge before any message');
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  const badge = page.getByTestId(`chat-unread-${STUDENT_ID}`);
  await badge.getByText('1', { exact: true }).waitFor();
  await badge.click();
  await page.getByTestId('chat-drawer').waitFor();
  await threadText(page, CHAT_MESSAGE_TEXT).waitFor();
  // Opening the thread reads it: the header count and the tile badge both clear.
  await expectChatUnread(page, 0);
  await badge.waitFor({ state: 'hidden' });
  assert.deepEqual(harness.pageErrors, []);
});

const SECOND_STUDENT_ID = '99999999-9999-4999-8999-999999999999';

test('chat drawer: conversations list unread first, opening one reads it, and the FAB badge tracks the total', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context, { openPanel: false });
  const { page, harness } = fixture;
  const adaRow = storedChatMessage({ createdAt: '2026-09-18T14:00:00.000Z' });
  const benRow = storedChatMessage({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', studentId: SECOND_STUDENT_ID, content: 'Synthetic second student question', createdAt: '2026-09-18T14:02:00.000Z' });
  await harness.sendWebSocketMessage(studentChatEvent(adaRow));
  await harness.sendWebSocketMessage({ ...studentChatEvent(benRow), data: { ...studentChatEvent(benRow).data, studentName: 'Ben Student', studentEmail: 'ben@example.edu' } });
  await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByTestId('chat-open').getByText('2', { exact: true }).waitFor();
  await openChatPanel(page);
  await expectChatUnread(page, 2);
  const rows = page.getByTestId('chat-conversations').locator('[data-testid^="chat-conversation-"]:not([data-testid*="unread"])');
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.testid)),
    [`chat-conversation-${SECOND_STUDENT_ID}`, `chat-conversation-${STUDENT_ID}`], 'Both unread: newest activity first');
  await page.getByTestId(`chat-conversation-unread-${STUDENT_ID}`).getByText('1', { exact: true }).waitFor();
  await selectConversation(page);
  await threadText(page, CHAT_MESSAGE_TEXT).waitFor();
  await expectChatUnread(page, 1);
  await page.getByTestId(`chat-conversation-unread-${STUDENT_ID}`).waitFor({ state: 'hidden' });
  await page.getByTestId(`chat-conversation-unread-${SECOND_STUDENT_ID}`).getByText('1', { exact: true }).waitFor();
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.testid)),
    [`chat-conversation-${SECOND_STUDENT_ID}`, `chat-conversation-${STUDENT_ID}`], 'The unread thread stays on top of the read one');
  await page.keyboard.press('Escape');
  await page.getByTestId('chat-drawer').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByTestId('chat-open').getByText('1', { exact: true }).waitFor();
  assert.deepEqual(harness.pageErrors, []);
});

test('class tools: a real authority change clears drafts and selection before replies in the new classroom', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage()));
  await selectConversation(page);
  await threadText(page, CHAT_MESSAGE_TEXT).waitFor();
  await replyInput(page).fill('Unsent text from the previous classroom');
  const replacement = teachingSession({ id: OBSERVED_SESSION_ID });
  harness.setActiveSession(replacement);
  harness.setAllSessions([replacement]);
  await fixture.refetch('/api/sessions/active');
  await waitUntil(() => fixture.reads.some(read => read.sessionId === OBSERVED_SESSION_ID), 'The replacement session starts its own history read');
  await chatHistorySettled(page);
  await page.getByTestId('class-tools-panel').waitFor({ state: 'hidden' });
  await openChatPanel(page);
  await page.getByTestId('chat-no-selection').waitFor();
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0, 'The superseded thread is gone from the open drawer');
  const replacementRow = storedChatMessage({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sessionId: OBSERVED_SESSION_ID, content: 'Synthetic replacement classroom reply' });
  await harness.sendWebSocketMessage(studentChatEvent(replacementRow));
  await selectConversation(page);
  await threadText(page, replacementRow.content).waitFor();
  assert.equal(await replyInput(page).inputValue(), '', 'No outgoing draft crosses a classroom authority boundary');
  const reply = storedChatMessage({ id: CHAT_REPLY_ID, sessionId: OBSERVED_SESSION_ID, senderId: ADMIN_ID, senderType: 'teacher', content: CHAT_REPLY_TEXT, deliveryStatus: 'sent' });
  fixture.setReplyResponder(async () => ({ message: reply, queued: true }));
  await replyInput(page).fill(CHAT_REPLY_TEXT);
  await replyInput(page).press('Enter');
  await threadText(page, CHAT_REPLY_TEXT).waitFor();
  const replies = fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.sessionId, OBSERVED_SESSION_ID, 'The reply carries the replacement authority, never the superseded one');
  assert.deepEqual(harness.pageErrors, []);
});

test('chat drawer: a pending reply disables only its own composer', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const benRow = storedChatMessage({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', studentId: SECOND_STUDENT_ID, content: 'Synthetic second student question' });
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage()));
  await harness.sendWebSocketMessage({ ...studentChatEvent(benRow), data: { ...studentChatEvent(benRow).data, studentName: 'Ben Student' } });
  let finishReply;
  const heldReply = new Promise(resolve => { finishReply = resolve; });
  context.after(() => finishReply());
  const reply = storedChatMessage({ id: CHAT_REPLY_ID, senderId: ADMIN_ID, senderType: 'teacher', content: CHAT_REPLY_TEXT, deliveryStatus: 'sent' });
  fixture.setReplyResponder(async () => { await heldReply; return { message: reply, queued: true }; });
  await selectConversation(page);
  await replyInput(page).fill(CHAT_REPLY_TEXT);
  await replyInput(page).press('Enter');
  await waitUntil(() => fixture.mutations.some(mutation => mutation.pathname === '/api/teacher/reply'), 'The reply POST is pending');
  assert.equal(await replyInput(page).isDisabled(), true, 'The pending thread cannot double-send');
  await selectConversation(page, SECOND_STUDENT_ID);
  assert.equal(await replyInput(page).isDisabled(), false, 'Another thread stays usable while a reply is in flight');
  await selectConversation(page);
  assert.equal(await replyInput(page).isDisabled(), true);
  finishReply();
  await threadText(page, CHAT_REPLY_TEXT).waitFor();
  await page.locator('[data-testid="chat-composer-input"]:not([disabled])').waitFor();
  assert.deepEqual(harness.pageErrors, []);
});

test('chat drawer: it is non-modal, so a tile badge switches threads without closing it', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  await page.getByTestId('chat-no-selection').waitFor();
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage()));
  const badge = page.getByTestId(`chat-unread-${STUDENT_ID}`);
  await badge.getByText('1', { exact: true }).waitFor();
  await badge.click();
  await threadText(page, CHAT_MESSAGE_TEXT).waitFor();
  assert.equal(await page.getByTestId('chat-drawer').count(), 1, 'One drawer, still open');
  await badge.waitFor({ state: 'hidden' });
  // The grid behind the drawer is still interactive: opening a tile's details works while chat is open.
  await page.getByTestId(`card-student-${STUDENT_ID}`).click();
  assert.equal(await page.getByTestId('chat-drawer').count(), 1);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat trust signals: Sent, Delivered, Seen never regress on a stray delivered or a history re-read', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage()));
  await selectConversation(page);
  await replyInput(page).fill(CHAT_REPLY_TEXT);
  await replyInput(page).press('Enter');
  const status = page.getByTestId(`chat-delivery-${CHAT_REPLY_ID}`);
  await status.getByText('Sending', { exact: true }).waitFor();
  const delivery = (deliveryStatus, extra = {}) => harness.sendWebSocketMessage({
    type: 'chat-message-delivery', schoolId: SCHOOL_ID, sessionId: OWN_SESSION_ID, messageId: CHAT_REPLY_ID, studentId: STUDENT_ID, deliveryStatus, ...extra,
  });
  await delivery('delivered');
  await status.getByText('Delivered', { exact: true }).waitFor();
  await delivery('seen', { seenAt: new Date().toISOString() });
  await status.getByText('Seen', { exact: true }).waitFor();
  await delivery('delivered');
  await delivery('failed', { errorMessage: 'late failure' });
  await fixture.updateRoster();
  assert.equal(await status.innerText(), 'Seen', 'A stray delivered or a late failure never regresses seen');
  const reply = storedChatMessage({ id: CHAT_REPLY_ID, senderId: ADMIN_ID, senderType: 'teacher', content: CHAT_REPLY_TEXT, deliveryStatus: 'delivered' });
  fixture.setMessages([storedChatMessage(), reply]);
  await fixture.refetch('/api/teacher/messages');
  await chatHistorySettled(page);
  assert.equal(await status.innerText(), 'Seen', 'A history row that still says delivered cannot regress seen');
  const seenRow = { ...reply, deliveryStatus: 'seen', seenAt: new Date().toISOString() };
  fixture.setMessages([storedChatMessage(), seenRow]);
  await page.reload();
  await openChatPanel(page);
  await selectConversation(page);
  await status.getByText('Seen', { exact: true }).waitFor();
  assert.deepEqual(harness.pageErrors, []);
});

test('chat trust signals: the thread header shows device status and an offline note until the device reports again', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage()));
  await selectConversation(page);
  // The fixture student was last seen weeks ago: not current.
  await page.getByTestId('chat-thread-offline-note').waitFor();
  await page.getByTestId('chat-thread-status').waitFor();
  await fixture.updateRoster();
  await page.getByTestId('chat-thread-offline-note').waitFor({ state: 'hidden' });
  assert.match(await page.getByTestId('chat-thread-status').innerText(), /Online|Active|Signing in|On task|Idle/i);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat device readiness: the thread and row say when the device has not joined the class or is still syncing chat controls', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage()));
  await selectConversation(page);
  // A current device with no classroom state is not under this class's control yet.
  await fixture.updateRoster();
  await page.getByTestId('chat-thread-offline-note').waitFor({ state: 'hidden' });
  const note = page.getByTestId('chat-thread-readiness-note');
  await note.waitFor();
  assert.equal(await note.getAttribute('data-kind'), 'not_in_class');
  const marker = page.getByTestId(`chat-conversation-readiness-${STUDENT_ID}`);
  await marker.waitFor();
  assert.equal(await marker.getAttribute('data-kind'), 'not_in_class');
  const frame = (revision, extra) => ({
    type: 'student-update', eventVersion: 2, schoolId: SCHOOL_ID, teachingSessionId: OWN_SESSION_ID,
    studentId: STUDENT_ID, realtimeBinding: 'binding-a', revision, observedAtMs: Date.now() + revision,
    ...extra,
  });
  // The device reports this class as its controlling authority and has applied it.
  await harness.sendWebSocketMessage(frame(1000, {
    classroomState: { schemaVersion: 1, revision: 1, teachingSessionId: OWN_SESSION_ID, supervisionContextId: null },
    enforcementHealth: 'synced',
    fabSyncPending: false,
  }));
  await note.waitFor({ state: 'hidden' });
  await marker.waitFor({ state: 'hidden' });
  // The server re-sent the FAB state on the last heartbeat because the class-start push missed.
  await harness.sendWebSocketMessage(frame(1001, { fabSyncPending: true }));
  await note.waitFor();
  assert.equal(await note.getAttribute('data-kind'), 'fab_syncing');
  assert.match(await note.innerText(), /syncing to this device/);
  assert.equal(await marker.getAttribute('data-kind'), 'fab_syncing');
  await harness.sendWebSocketMessage(frame(1002, { fabSyncPending: false }));
  await note.waitFor({ state: 'hidden' });
  await marker.waitFor({ state: 'hidden' });
  // Another class owning the device is reported, never guessed from the switch.
  await harness.sendWebSocketMessage(frame(1003, {
    classroomState: { schemaVersion: 1, revision: 2, teachingSessionId: '99999999-9999-4999-8999-999999999999', supervisionContextId: null },
  }));
  await note.waitFor();
  assert.equal(await note.getAttribute('data-kind'), 'other_authority');
  assert.deepEqual(harness.pageErrors, []);
});

test('chat trust signals: opening a thread posts one read receipt and another tab\'s receipt reads a thread here', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await expectChatUnread(page, 1);
  assert.equal(fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/messages/read').length, 0, 'Nothing is read until the teacher opens the thread');
  await selectConversation(page);
  await expectChatUnread(page, 0);
  await waitUntil(() => fixture.mutations.some(mutation => mutation.pathname === '/api/teacher/messages/read'), 'Opening the thread posts a read receipt');
  const receipts = fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/messages/read');
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].body.messageIds, [row.id]);
  assert.equal(receipts[0].body.sessionId, OWN_SESSION_ID);
  const benRow = storedChatMessage({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', studentId: SECOND_STUDENT_ID, content: 'Synthetic second student question' });
  await harness.sendWebSocketMessage({ ...studentChatEvent(benRow), data: { ...studentChatEvent(benRow).data, studentName: 'Ben Student' } });
  await expectChatUnread(page, 1);
  await harness.sendWebSocketMessage({ type: 'chat-messages-read', schoolId: SCHOOL_ID, sessionId: OWN_SESSION_ID, messageIds: [benRow.id], readAt: new Date().toISOString(), readBy: ADMIN_ID });
  await expectChatUnread(page, 0);
  await fixture.updateRoster();
  assert.equal(receipts.length, fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/messages/read').length, 'A receipt from elsewhere is not re-posted');
  assert.deepEqual(harness.pageErrors, []);
});

test('chat trust signals: the Messages tab reads the scoped transcript read-only and says so when unavailable', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context, { openPanel: false });
  const { page, harness } = fixture;
  let transcriptStatus = 200;
  const transcriptReads = [];
  const rows = [storedChatMessage({ createdAt: '2026-09-18T14:00:00.000Z' }),
    storedChatMessage({ id: CHAT_REPLY_ID, senderId: ADMIN_ID, senderType: 'teacher', content: CHAT_REPLY_TEXT, deliveryStatus: 'seen', createdAt: '2026-09-18T14:01:00.000Z' })];
  await page.route(`**/api/classpilot/students/${STUDENT_ID}/messages*`, async route => {
    const url = new URL(route.request().url());
    transcriptReads.push({ query: Object.fromEntries(url.searchParams), schoolId: route.request().headers()['x-school-id'] });
    if (transcriptStatus !== 200) { await route.fulfill({ status: transcriptStatus, json: { error: 'Access denied' } }); return; }
    await route.fulfill({ json: { student: { id: STUDENT_ID }, messages: rows, nextCursor: null } });
  });
  await page.getByTestId(`button-student-details-${STUDENT_ID}`).click();
  await page.getByTestId('student-tabs').waitFor();
  await page.getByTestId('tab-messages').click();
  await page.getByTestId('student-transcript').waitFor();
  await page.getByTestId('student-transcript').getByText(CHAT_MESSAGE_TEXT, { exact: true }).waitFor();
  await page.getByTestId('student-transcript').getByTestId(`chat-delivery-${CHAT_REPLY_ID}`).getByText('Seen', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-composer').count(), 0, 'The transcript is read-only');
  assert.equal(transcriptReads.length, 1);
  assert.deepEqual(transcriptReads[0].query, { teachingSessionId: OWN_SESSION_ID }, 'The read is scoped to the class the viewer holds');
  assert.equal(transcriptReads[0].schoolId, SCHOOL_ID);
  await page.keyboard.press('Escape');
  await page.getByTestId('student-transcript').waitFor({ state: 'hidden' });
  transcriptStatus = 403;
  await page.evaluate(async () => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    queryClient.removeQueries({ queryKey: ['/api/classpilot/students/messages'] });
  });
  await page.getByTestId(`button-student-details-${STUDENT_ID}`).click();
  await page.getByTestId('student-tabs').waitFor();
  await page.getByTestId('tab-messages').click();
  await page.getByTestId('student-transcript-unavailable').waitFor();
  assert.deepEqual(harness.pageErrors, []);
});

test('chat trust signals: the drawer pause switch writes chatPaused and a testing pause shows as locked with no settings request', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.clock.install({ time: new Date('2026-09-15T13:11:30Z') });
  const row = student({ supervisionState: 'temporary_coverage',
    supervisionContext: { id: OWN_TESTING_CONTEXT_ID, type: 'testing', assignedStaffId: ADMIN_ID },
    capabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: true },
    lastSeenAt: '2026-09-15T13:11:30Z', realtimeObservedAt: '2026-09-15T13:11:30Z',
  });
  const aggregate = aggregateController({ scoped: success([row]) });
  const harness = await configureDashboard(page, { aggregate, userRole: 'teacher', acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledTestingActivity({ studentCount: 1 }), { serverTime: '2026-09-15T13:11:30Z' }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  const settingsRequests = [];
  let stored = { supervisionContextId: OWN_TESTING_CONTEXT_ID, lifecycleRevision: 2, raiseHandEnabled: true, chatEnabled: true, chatPaused: false };
  let effective = { messagingEnabled: true, handRaisingEnabled: true, messagesPaused: false, pauseReason: null, lifecycleRevision: 2 };
  await page.route(`**/api/classpilot/supervision-contexts/${OWN_TESTING_CONTEXT_ID}/settings`, async route => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      settingsRequests.push(body);
      stored = { ...stored, ...('chatPaused' in body ? { chatPaused: body.chatPaused } : {}), ...('chatEnabled' in body ? { chatEnabled: body.chatEnabled } : {}), lifecycleRevision: stored.lifecycleRevision + 1 };
      effective = { ...effective, messagesPaused: stored.chatPaused, pauseReason: stored.chatPaused ? 'teacher' : null, messagingEnabled: stored.chatEnabled && !stored.chatPaused, lifecycleRevision: stored.lifecycleRevision };
    }
    await route.fulfill({ json: { settings: stored, state: effective } });
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await openToolbarByKeyboard(page);
  await page.getByTestId('chat-open').getByText('Messages', { exact: true }).waitFor();
  await page.getByTestId('chat-open').click({ force: true });
  await page.getByTestId('chat-drawer').waitFor();
  await page.getByTestId('chat-pause-label').getByText('Messages: On', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-pause-banner').count(), 0);
  await page.getByTestId('chat-messaging-switch').click();
  await waitUntil(() => settingsRequests.length === 1, 'The switch writes the soft pause');
  assert.deepEqual(settingsRequests[0], { chatPaused: true, expectedRevision: 2 }, 'Pause never touches the hard channel switch');
  await page.getByTestId('chat-pause-banner').waitFor();
  assert.equal(await page.getByTestId('chat-pause-banner').getAttribute('data-pause-reason'), 'teacher');
  await page.getByTestId('chat-pause-label').getByText('Messages: Paused', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-messaging-switch').isDisabled(), false, 'A teacher pause can be resumed');
  await page.keyboard.press('Escape');
  await openToolbarByKeyboard(page);
  await page.getByTestId('chat-open').getByText('Messages', { exact: true }).waitFor();
  await page.getByTestId('chat-open').click({ force: true });
  await page.getByTestId('chat-pause-banner').waitFor();
  // A testing block pauses on its own: the server reports the pause without chatPaused.
  stored = { ...stored, chatPaused: false, lifecycleRevision: 4 };
  effective = { ...effective, messagesPaused: true, pauseReason: 'testing', messagingEnabled: false, lifecycleRevision: 4 };
  await page.evaluate(async () => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    await queryClient.invalidateQueries({ queryKey: ['/api/classpilot/activity-settings'] });
  });
  await page.getByTestId('chat-pause-label').getByText('Paused for testing', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-pause-banner').getAttribute('data-pause-reason'), 'testing');
  assert.equal(await page.getByTestId('chat-messaging-switch').isDisabled(), true, 'A testing pause is not the teacher\'s to lift');
  await page.getByTestId('chat-messaging-switch').click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(settingsRequests.length, 1, 'A locked switch sends nothing');
  await page.getByTestId('chat-drawer-menu').click();
  await page.getByTestId('chat-channel-toggle').getByText('Turn off messaging for this class', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(harness.pageErrors, []);
});

async function openToolbarByKeyboard(page) {
  // Toasts stack over the toolbar corner, so drive it from the keyboard.
  await page.getByRole('button', { name: 'Class tools', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('chat-open').waitFor();
}

async function chatHistorySettled(page) {
  await page.waitForFunction(async () => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    return queryClient.isFetching({ queryKey: ['/api/teacher/messages'] }) === 0;
  });
}

test('chat recovery: an older in-flight history cannot erase realtime messages, replies, or delivered acknowledgements', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  let finishHistory;
  const heldHistory = new Promise(resolve => { finishHistory = resolve; });
  context.after(() => finishHistory());
  fixture.setHistoryResponder(async () => { await heldHistory; return { messages: [] }; });
  const previousReads = fixture.reads.length;
  await fixture.refetch('/api/teacher/messages', false);
  await waitUntil(() => fixture.reads.length > previousReads, 'The older history request must start before the live message');
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  await selectConversation(page);
  await replyInput(page).fill(CHAT_REPLY_TEXT);
  await replyInput(page).press('Enter');
  await threadText(page, CHAT_REPLY_TEXT).waitFor();
  await page.getByText('Sending', { exact: true }).waitFor();
  await harness.sendWebSocketMessage({
    type: 'chat-message-delivery', schoolId: SCHOOL_ID, sessionId: OWN_SESSION_ID,
    messageId: CHAT_REPLY_ID, studentId: STUDENT_ID, deliveryStatus: 'delivered',
  });
  await page.getByText('Delivered', { exact: true }).waitFor();
  finishHistory();
  await chatHistorySettled(page);
  await fixture.updateRoster();
  assert.equal(await threadText(page, CHAT_MESSAGE_TEXT).count(), 1);
  assert.equal(await threadText(page, CHAT_REPLY_TEXT).count(), 1);
  await page.getByText('Delivered', { exact: true }).waitFor();
  await expectChatUnread(page, 0, 'The open thread was read; a stale history cannot flag it unread again');
  assert.equal(fixture.mutations.filter(row => row.pathname === '/api/teacher/reply').length, 1, 'History refreshes must never replay the teacher reply POST');
  assert.deepEqual(harness.pageErrors, []);
});

test('chat recovery: closing a thread survives stale history, duplicate events and a pending reply while a new message can reopen it', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  await selectConversation(page);
  let finishReply;
  const heldReply = new Promise(resolve => { finishReply = resolve; });
  context.after(() => finishReply());
  const reply = storedChatMessage({ id: CHAT_REPLY_ID, senderId: ADMIN_ID, senderType: 'teacher', content: CHAT_REPLY_TEXT, deliveryStatus: 'sent' });
  fixture.setReplyResponder(async () => { await heldReply; return { message: reply, queued: true }; });
  await replyInput(page).fill(CHAT_REPLY_TEXT);
  await replyInput(page).press('Enter');
  await waitUntil(() => fixture.mutations.some(row => row.pathname === '/api/teacher/reply'), 'The reply POST must be pending before close');
  await endChat(page);
  await expectChatEmpty(page);
  fixture.setMessages([row, reply]);
  await fixture.refetch('/api/teacher/messages');
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await fixture.updateRoster();
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0);
  const replyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/teacher/reply');
  finishReply();
  await replyResponse;
  const newRow = storedChatMessage({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', content: 'A new synthetic question after close' });
  await harness.sendWebSocketMessage(studentChatEvent(newRow));
  await listText(page, newRow.content).waitFor();
  await fixture.updateRoster();
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0, 'Closing must keep the old student item hidden');
  assert.equal(await page.getByText(CHAT_REPLY_TEXT, { exact: true }).count(), 0, 'A reply submitted before close cannot reappear in a newly opened thread');
  await expectChatUnread(page, 1);
  assert.equal(fixture.mutations.filter(row => row.pathname === '/api/teacher/close-chat').length, 1);
  assert.equal(fixture.mutations.filter(row => row.pathname === '/api/teacher/reply').length, 1);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat recovery: session changes fence old history and realtime data', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  let finishOldHistory;
  const heldHistory = new Promise(resolve => { finishOldHistory = resolve; });
  context.after(() => finishOldHistory());
  fixture.setHistoryResponder(async request => {
    if (new URL(request.url()).searchParams.get('sessionId') === OWN_SESSION_ID) {
      await heldHistory;
      return { messages: [row] };
    }
    return { messages: [] };
  });
  const previousReads = fixture.reads.length;
  await fixture.refetch('/api/teacher/messages', false);
  await waitUntil(() => fixture.reads.length > previousReads, 'The original session read is in flight');
  const replacement = teachingSession({ id: OBSERVED_SESSION_ID });
  harness.setActiveSession(replacement);
  harness.setAllSessions([replacement]);
  await fixture.refetch('/api/sessions/active');
  await waitUntil(() => fixture.reads.some(read => read.sessionId === OBSERVED_SESSION_ID), 'The replacement session starts its own history read');
  await openChatPanel(page);
  finishOldHistory();
  await chatHistorySettled(page);
  await harness.sendWebSocketMessage(studentChatEvent(row));
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0, 'A superseded session cannot retain or restore message content');
  const replacementRow = storedChatMessage({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sessionId: OBSERVED_SESSION_ID, content: 'Synthetic replacement classroom reply' });
  await harness.sendWebSocketMessage(studentChatEvent(replacementRow));
  await listText(page, replacementRow.content).waitFor();
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat recovery: a global authorization denial clears and latches chat until an authoritative scope change', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  const row = storedChatMessage();
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  fixture.setHistoryResponder(async () => ({ status: 403, body: { error: 'Access denied' } }));
  await fixture.refetch('/api/teacher/messages');
  await chatHistorySettled(page);
  await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).waitFor({ state: 'hidden' });
  fixture.setHistoryResponder(null);
  fixture.setMessages([row]);
  const readsAfterDenial = fixture.reads.length;
  await harness.sendWebSocketMessage(studentChatEvent(row));
  await fixture.updateRoster();
  await fixture.refetch('/api/teacher/messages');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0);
  assert.equal(fixture.reads.length, readsAfterDenial, 'Cache invalidation and browser events do not re-arm denied authority');
  const replacement = teachingSession({ id: OBSERVED_SESSION_ID });
  const replacementRow = storedChatMessage({ sessionId: OBSERVED_SESSION_ID });
  fixture.setMessages([replacementRow]);
  harness.setActiveSession(replacement);
  harness.setAllSessions([replacement]);
  await fixture.refetch('/api/sessions/active');
  await waitUntil(() => fixture.reads.some(read => read.sessionId === OBSERVED_SESSION_ID), 'New authoritative session re-arms its history read');
  await openChatPanel(page);
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  assert.deepEqual(harness.pageErrors, []);
});

test('chat recovery: a fast browser clock cannot hide a new reply recovered from server history after close', { timeout: 60_000 }, async context => {
  const serverNow = Date.now();
  const fixture = await chatBrowserFixture(context, { clockTime: serverNow + 5 * 60_000 });
  const { page, harness } = fixture;
  const oldRow = storedChatMessage({ createdAt: new Date(serverNow).toISOString() });
  await harness.sendWebSocketMessage(studentChatEvent(oldRow));
  await listText(page, CHAT_MESSAGE_TEXT).waitFor();
  await endChat(page);
  await expectChatEmpty(page);
  const missedRow = storedChatMessage({
    id: 'abababab-abab-4bab-8bab-abababababab', content: 'Synthetic reply missed during disconnect',
    createdAt: new Date(serverNow + 60_000).toISOString(),
  });
  assert.ok(Date.parse(missedRow.createdAt) < await page.evaluate(() => Date.now()), 'The server-created row is older than the browser clock, but was sent after close');
  fixture.setMessages([oldRow, missedRow]);
  // No student-message event delivers this row. Only a fresh server snapshot
  // can recover it, independently of the browser's wall-clock skew.
  await fixture.refetch('/api/teacher/messages');
  await listText(page, missedRow.content).waitFor();
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0);
  const previousReads = fixture.reads.length;
  await harness.disconnectWebSocket();
  await harness.authenticateWebSocket();
  await waitUntil(() => fixture.reads.length > previousReads, 'Reconnect reconciles server history after close');
  await chatHistorySettled(page);
  assert.equal(await listText(page, missedRow.content).count(), 1);
  assert.equal(await page.getByText(CHAT_MESSAGE_TEXT, { exact: true }).count(), 0);
  assert.deepEqual(harness.pageErrors, []);
});

test('chat recovery: reconnect fetches history newer than an empty request begun before disconnect', { timeout: 60_000 }, async context => {
  const fixture = await chatBrowserFixture(context);
  const { page, harness } = fixture;
  let finishOldHistory;
  const heldHistory = new Promise(resolve => { finishOldHistory = resolve; });
  context.after(() => finishOldHistory());
  let snapshotCount = 0;
  const offlineRow = storedChatMessage({ content: 'Synthetic student reply committed while offline' });
  fixture.setHistoryResponder(async () => {
    snapshotCount += 1;
    if (snapshotCount === 1) {
      await heldHistory;
      return { messages: [] };
    }
    return { messages: [offlineRow] };
  });
  await fixture.refetch('/api/teacher/messages', false);
  await waitUntil(() => snapshotCount === 1, 'The old empty snapshot starts before disconnect');
  const connectionsBefore = harness.websocketConnections.length;
  await harness.disconnectWebSocket();
  // The student reply is now in canonical history, but no WebSocket message
  // delivers it to this disconnected teacher.
  await harness.authenticateWebSocket();
  assert.ok(harness.websocketConnections.length > connectionsBefore, 'Authentication must occur on a new socket');
  assert.ok(harness.websocketConnections.at(-1).authenticationRequests > 0);
  assert.equal(harness.websocketConnections.at(-1).authenticationResponses,
    harness.websocketConnections.at(-1).authenticationRequests);
  finishOldHistory();
  try {
    await waitUntil(() => snapshotCount >= 2, 'Reconnect must start a fresh history GET instead of joining the pre-disconnect snapshot');
  } catch (error) {
    const queryState = await page.evaluate(async () => {
      const { queryClient } = await import('/src/lib/queryClient.js');
      return queryClient.getQueryCache().findAll({ queryKey: ['/api/teacher/messages'] }).map(query => ({
        status: query.state.status, fetchStatus: query.state.fetchStatus, active: query.isActive(),
        responseRows: query.state.data?.messages?.length,
      }));
    });
    assert.fail(`${error.message}: ${JSON.stringify({ sockets: harness.websocketConnections, console: fixture.socketConsole, queryState, pageErrors: harness.pageErrors })}`);
  }
  await chatHistorySettled(page);
  await listText(page, offlineRow.content).waitFor();
  assert.equal(await listText(page, offlineRow.content).count(), 1);
  assert.deepEqual(fixture.mutations, [], 'Recovery only reads history; no message is resent');
  assert.deepEqual(harness.pageErrors, []);
});

async function assignedTestingBrowser(context, options = {}) {
  const vite = await createServer({ root: APP_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, ...options });
  await vite.listen();
  let browser;
  context.after(async () => { await browser?.close(); await vite.close(); });
  browser = await chromium.launch({ headless: true });
  return { browser, baseURL: `http://127.0.0.1:${vite.httpServer.address().port}` };
}

async function numericSupervisionBadge(page, testId) {
  return page.getByTestId(testId).locator(':scope > span').allTextContents()
    .then(values => values.map(value => value.trim()).filter(value => /^\d+$/.test(value)).map(Number));
}

async function waitForSupervisionBadges(page, { claimed, coverage }) {
  await page.waitForFunction(expected => {
    const count = id => {
      const button = document.querySelector(`[data-testid="${id}"]`);
      if (!button || button.querySelector('[aria-label$="count unavailable"]')) return null;
      return Array.from(button.querySelectorAll(':scope > span'))
        .map(span => span.textContent.trim()).filter(text => /^\d+$/.test(text)).map(Number);
    };
    const matches = (actual, value) => actual !== null && (value === 0 ? actual.length === 0 || actual.every(item => item === 0) : actual.length === 1 && actual[0] === value);
    return matches(count('button-view-claimed-students'), expected.claimed)
      && matches(count('button-coverage-tab'), expected.coverage);
  }, { claimed, coverage });
}

test('supervision badge counts update on Class after partial and final release without reopening Claimed', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const rows = Array.from({ length: 20 }, (_, index) => ({
    ...testingStudent(`ffffffff-ffff-4fff-8fff-${String(index).padStart(12, '0')}`, OWN_TESTING_CONTEXT_ID),
    status: 'offline', loginState: 'not_logged_in', isLoggedIn: false, commandable: false,
    activityState: 'signed_out', monitoringState: 'not_expected',
    lastSeenAt: null, realtimeObservedAt: null, realtimeBinding: null,
  }));
  const summary = count => ({
    ...ownSupervisionSummary(count ? [{ id: OWN_TESTING_CONTEXT_ID, name: 'Other', activeStudentCount: count }] : []),
    claimedStudentCount: count, activeContextCount: count ? 1 : 0,
  });
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(), coverageSummary: summary(20), claimedStudents: rows,
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${rows.at(-1).studentId}`).waitFor();
  await waitForSupervisionBadges(page, { claimed: 20, coverage: 1 });
  await harness.authenticateWebSocket();
  await page.getByTestId('button-view-class-students').click();
  await assertPickupView(page, 'class');
  const readsBeforeRelease = harness.claimedRosterRequests.length;
  // Keep the former roster cached: the fresh summary must control badges even
  // when this view has not fetched the later roster yet.
  harness.setCoverageSummary(summary(7));
  harness.setClaimedStudents(rows.slice(0, 7));
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await waitForSupervisionBadges(page, { claimed: 7, coverage: 1 });
  await assertPickupView(page, 'class');

  harness.setCoverageSummary(summary(0));
  harness.setClaimedStudents([]);
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await waitForSupervisionBadges(page, { claimed: 0, coverage: 0 });
  await page.clock.fastForward(10_100);
  await waitForSupervisionBadges(page, { claimed: 0, coverage: 0 });
  await assertPickupView(page, 'class');
  assert.equal(harness.claimedRosterRequests.length, readsBeforeRelease, 'Class updates its badges without polling an invisible student roster');
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('supervision badges do not resurrect an expired cached context while refresh is unavailable', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const endsAt = new Date(TESTING_TIME.getTime() + 30_000).toISOString();
  const summary = {
    ...ownSupervisionSummary([{ id: OWN_TESTING_CONTEXT_ID, name: 'Other', endsAt, activeStudentCount: 1 }]),
    activeContextCount: 1, claimedStudentCount: 1,
  };
  let unavailable = false;
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    coverageSummary: () => unavailable ? { status: 503, body: { error: 'Temporary summary failure' } } : summary,
    claimedStudents: [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await waitForSupervisionBadges(page, { claimed: 1, coverage: 1 });
  await harness.authenticateWebSocket();
  await page.getByTestId('button-view-class-students').click();
  unavailable = true;
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.clock.fastForward(31_500);
  await page.waitForFunction(() => !Array.from(document.querySelector('[data-testid="button-view-claimed-students"]')?.querySelectorAll(':scope > span') || []).some(span => /^\s*[1-9]\d*\s*$/.test(span.textContent)));
  assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), [], 'Expired personal assignments cannot return through cached roster length');
  assert.deepEqual(await numericSupervisionBadge(page, 'button-coverage-tab'), [], 'A failed summary cannot keep claiming that an expired Coverage context is active');
  await assertPickupView(page, 'class');
  await page.clock.fastForward(20_000);
  assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), []);
  assert.deepEqual(await numericSupervisionBadge(page, 'button-coverage-tab'), []);
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('personal supervision badge uses owned counts rather than schoolwide administrator totals', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    coverageSummary: { ...ownSupervisionSummary([]), activeContextCount: 9, claimedStudentCount: 180 },
    claimedStudents: [testingStudent(STUDENT_ID, OTHER_TESTING_CONTEXT_ID, OTHER_TEACHER_ID)],
  });
  await page.goto(`${baseURL}/classpilot`);
  await waitForSupervisionBadges(page, { claimed: 0, coverage: 9 });
  await assertPickupView(page, 'class');
  assert.deepEqual(harness.claimedRosterRequests, [], 'Schoolwide administrator context counts do not launch a personal roster');
  harness.setCoverageSummary({
    ...ownSupervisionSummary([{ id: OWN_TESTING_CONTEXT_ID, name: 'Other', activeStudentCount: 2 }]),
    activeContextCount: 9, claimedStudentCount: 180,
  });
  harness.setClaimedStudents([testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID), testingStudent(SIGNED_OUT_STUDENT_ID, OWN_TESTING_CONTEXT_ID)]);
  await harness.authenticateWebSocket();
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await waitForSupervisionBadges(page, { claimed: 2, coverage: 9 });
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('supervision badge read failures are unknown and Retry keeps the selected Class view', { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  let unavailable = true;
  let count = 2;
  const summary = () => ({
    ...ownSupervisionSummary(count ? [{ id: OWN_TESTING_CONTEXT_ID, name: 'Other', activeStudentCount: count }] : []),
    activeContextCount: count ? 1 : 0, claimedStudentCount: count,
  });
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    coverageSummary: () => unavailable ? { status: 503, body: { error: 'Temporary summary failure' } } : summary(),
    claimedStudents: [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID), testingStudent(SIGNED_OUT_STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
  });
  await page.goto(`${baseURL}/classpilot`);
  await assertPickupView(page, 'class');
  await waitUntil(() => harness.coverageSummaryRequests.length > 0, 'Summary must be requested');
  await page.clock.fastForward(2_000);
  await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
  await page.getByLabel('Active supervision count unavailable', { exact: true }).waitFor();
  assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), []);
  assert.deepEqual(await numericSupervisionBadge(page, 'button-coverage-tab'), []);
  await page.getByText('Supervision counts could not refresh.', { exact: true }).waitFor();

  // Selecting Class explicitly must survive both retry and a later failure.
  await page.getByTestId('button-view-class-students').click();
  unavailable = false;
  await page.getByRole('button', { name: 'Retry supervision refresh', exact: true }).click();
  await waitForSupervisionBadges(page, { claimed: 2, coverage: 1 });
  await assertPickupView(page, 'class');
  await harness.authenticateWebSocket();
  unavailable = true;
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.clock.fastForward(2_000);
  await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
  await page.getByLabel('Active supervision count unavailable', { exact: true }).waitFor();
  assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), [], 'A cached positive count is visibly uncertain after a failed refresh');
  count = 0;
  unavailable = false;
  await page.getByRole('button', { name: 'Retry supervision refresh', exact: true }).click();
  await waitForSupervisionBadges(page, { claimed: 0, coverage: 0 });
  await assertPickupView(page, 'class');
  assert.equal(await page.getByLabel('Claimed student count unavailable', { exact: true }).count(), 0);
  assert.deepEqual(harness.coverageMutationRequests, [], 'Retry repeats reads only');
  assert.deepEqual(harness.pageErrors, []);
});

test('supervision badge remains unknown for legacy or malformed own metadata while manual Claimed stays accessible', { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  for (const ownership of [{}, { ownSupervisionContexts: [{ id: OWN_TESTING_CONTEXT_ID, activeStudentCount: 'bad', endsAt: 'invalid' }] }]) {
    const page = await browser.newPage();
    await page.clock.install({ time: TESTING_TIME });
    const harness = await configureDashboard(page, {
      aggregate: aggregateController(),
      coverageSummary: { schoolId: SCHOOL_ID, viewerId: ADMIN_ID, activeContextCount: 3, claimedStudentCount: 99, ...ownership },
      claimedStudents: [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
    });
    await page.goto(`${baseURL}/classpilot`);
    await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
    await assertPickupView(page, 'class');
    assert.deepEqual(await numericSupervisionBadge(page, 'button-coverage-tab'), [3]);
    assert.deepEqual(harness.claimedRosterRequests, []);
    await page.getByTestId('button-view-claimed-students').click();
    await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
    await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
    assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), [], 'The cached manually loaded roster is not substituted for unknown ownership metadata');
    assert.deepEqual(harness.coverageMutationRequests, []);
    assert.deepEqual(harness.pageErrors, []);
    await page.close();
  }
});

test('the first valid supervision summary refreshes a manually loaded roster after unavailable metadata', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  let ready = false;
  const rows = [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID), testingStudent(SIGNED_OUT_STUDENT_ID, OWN_TESTING_CONTEXT_ID)];
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    coverageSummary: () => ready ? {
      ...ownSupervisionSummary([{ id: OWN_TESTING_CONTEXT_ID, name: 'Other', activeStudentCount: 2 }]),
      activeContextCount: 1, claimedStudentCount: 2,
    } : { status: 503, body: { error: 'Summary not yet available' } },
    claimedStudents: () => ready ? rows : rows.slice(0, 1),
  });
  await page.goto(`${baseURL}/classpilot`);
  await assertPickupView(page, 'class');
  await page.clock.fastForward(2_000);
  await page.getByTestId('button-view-claimed-students').click();
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
  const earlierReads = harness.claimedRosterRequests.length;
  ready = true;
  // Refresh just the lightweight summary, as its independent polling does.
  // A socket event also invalidates the roster and would conceal this race.
  await page.evaluate(async ({ schoolId, viewerId }) => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    await queryClient.refetchQueries({ queryKey: ['/api/coverage/summary', schoolId, viewerId], exact: true });
  }, { schoolId: SCHOOL_ID, viewerId: ADMIN_ID });
  await waitForSupervisionBadges(page, { claimed: 2, coverage: 1 });
  await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).waitFor();
  assert(harness.claimedRosterRequests.length > earlierReads, 'The first authoritative metadata refreshes the old manual roster without waiting for polling');
  await assertPickupView(page, 'claimed');
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('a confirmed Dashboard claim keeps supervision badges unknown until its summary settles and retries only reads', { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  let phase = 'initial';
  let pendingSummaryStarted = false;
  let releaseSummary;
  const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
  context.after(() => releaseSummary());
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    availableStudents: [{ ...testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID), supervisionState: 'online_unassigned' }],
    coverageSummary: async () => {
      if (phase === 'initial') return { ...ownSupervisionSummary([]), activeContextCount: 0, claimedStudentCount: 0 };
      if (phase === 'pending') {
        pendingSummaryStarted = true;
        await summaryGate;
        return { status: 503, body: { error: 'The committed supervision summary could not refresh' } };
      }
      return { ...ownSupervisionSummary([{ id: OWN_TESTING_CONTEXT_ID, name: 'Other' }]), activeContextCount: 1, claimedStudentCount: 1 };
    },
    claimedStudents: () => phase === 'ready' ? [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)]
      : { status: 503, body: { error: 'The committed supervision roster could not refresh' } },
    claimResponse: async () => {
      phase = 'pending';
      return { context: { id: OWN_TESTING_CONTEXT_ID, name: 'Other', assignedStaffId: ADMIN_ID, endsAt: '2026-09-14T16:00:00Z' } };
    },
  });
  await page.goto(`${baseURL}/classpilot`);
  await waitForSupervisionBadges(page, { claimed: 0, coverage: 0 });
  await page.getByTestId('button-view-available-students').click();
  await page.getByTestId('button-claim-all-students').click();
  await assertPickupView(page, 'claimed');
  await waitUntil(() => pendingSummaryStarted, 'The committed claim must request a fresh supervision summary');
  await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
  await page.getByLabel('Active supervision count unavailable', { exact: true }).waitFor();
  assert.deepEqual(await numericSupervisionBadge(page, 'button-view-claimed-students'), [], 'The previous confirmed zero is no longer authoritative after the claim commits');
  assert.deepEqual(await numericSupervisionBadge(page, 'button-coverage-tab'), []);
  releaseSummary();
  await page.clock.fastForward(2_000);
  await page.getByText('Supervision started; students could not load.', { exact: false }).waitFor();
  await page.getByLabel('Claimed student count unavailable', { exact: true }).waitFor();
  await page.getByLabel('Active supervision count unavailable', { exact: true }).waitFor();
  phase = 'ready';
  await page.getByRole('button', { name: 'Retry supervision refresh', exact: true }).click();
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await waitForSupervisionBadges(page, { claimed: 1, coverage: 1 });
  await assertPickupView(page, 'claimed');
  assert.equal(harness.coverageMutationRequests.length, 1, 'The successful claim is never repeated while recovering its read state');
  assert.equal(harness.coverageMutationRequests[0].pathname, '/api/coverage/claim');
  assert.deepEqual(harness.pageErrors, []);
});

test('assigned testing opens only the own roster and respects explicit view choices without changing assignments', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const own = testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID);
  const other = testingStudent(SIGNED_OUT_STUDENT_ID, OTHER_TESTING_CONTEXT_ID, OTHER_TEACHER_ID);
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(), coverageSummary: ownTestingSummary([OWN_TESTING_CONTEXT_ID]),
    claimedStudents: [own, other],
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('assigned-testing-notice').waitFor();
  await assertPickupView(page, 'claimed');
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  assert.equal(await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).count(), 0, 'Automatic selection filters out another administrator-visible testing group');
  assert.equal((await page.getByTestId('text-online-count').innerText()).trim(), '1');
  await harness.authenticateWebSocket();

  await page.getByTestId('button-view-claimed-students').click();
  await page.getByTestId('assigned-testing-notice').waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).count(), 0, 'Manual Claimed remains personal for administrators');
  for (const choice of ['available', 'class', 'claimed']) {
    await page.getByTestId(`button-view-${choice}-students`).click();
    await assertPickupView(page, choice);
    const before = harness.coverageSummaryRequests.length;
    await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
    await waitUntil(() => harness.coverageSummaryRequests.length > before, 'Summary notification must reconcile while an explicit view is selected');
    await page.clock.fastForward(10_100);
    await assertPickupView(page, choice);
    assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0, `Manual ${choice} survives notification and polling`);
  }
  harness.setCoverageSummary(ownTestingSummary([]));
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.clock.fastForward(10_100);
  await assertPickupView(page, 'claimed');
  assert.equal(await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).count(), 0);
  assert.deepEqual(harness.coverageMutationRequests, [], 'Opening and changing dashboard views must never create, claim, or release supervision');
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('assigned testing reacts to activation, updated rosters, closure and polling while the dashboard stays open', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(), userRole: 'teacher', coverageSummary: ownTestingSummary([]),
  });
  await page.goto(`${baseURL}/classpilot`);
  await assertPickupView(page, 'class');
  await harness.authenticateWebSocket();
  assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0, 'Other staff having active contexts does not trigger my testing view');
  harness.setClaimedStudents([testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)]);
  harness.setCoverageSummary(ownTestingSummary([OWN_TESTING_CONTEXT_ID]));
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.getByTestId('assigned-testing-notice').waitFor();
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await assertPickupView(page, 'claimed');

  harness.setClaimedStudents([testingStudent(SIGNED_OUT_STUDENT_ID, OWN_TESTING_CONTEXT_ID)]);
  const rosterReads = harness.claimedRosterRequests.length;
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await waitUntil(() => harness.claimedRosterRequests.length > rosterReads, 'Claim notifications must refresh the currently assigned roster');
  await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).waitFor();
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor({ state: 'hidden' });

  harness.setCoverageSummary(ownTestingSummary([]));
  harness.setClaimedStudents([]);
  harness.setActiveSession(teachingSession());
  harness.setAllSessions([teachingSession()]);
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await assertPickupView(page, 'class');
  await page.getByTestId('badge-active-session').waitFor();
  await page.getByTestId('assigned-testing-notice').waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).count(), 0, 'Ended assignments do not leave their roster visible');

  harness.setClaimedStudents([testingStudent(MOVED_CLASS_STUDENT_ID, OTHER_TESTING_CONTEXT_ID)]);
  harness.setCoverageSummary(ownTestingSummary([OTHER_TESTING_CONTEXT_ID]));
  const summaryReads = harness.coverageSummaryRequests.length;
  await page.clock.fastForward(10_100);
  await waitUntil(() => harness.coverageSummaryRequests.length > summaryReads, 'A connected WebSocket must not disable the bounded summary reconciliation');
  await page.getByTestId('assigned-testing-notice').waitFor();
  await page.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`).waitFor();
  await assertPickupView(page, 'claimed');
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('assigned testing takes precedence over a regular class while preserving manual Class and administrator Observe choices', { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  for (const resolvedSession of [null, teachingSession()]) {
    const page = await browser.newPage();
    await page.clock.install({ time: TESTING_TIME });
    let resolveSession;
    const gate = new Promise(resolve => { resolveSession = resolve; });
    context.after(() => resolveSession(resolvedSession));
    const harness = await configureDashboard(page, {
      userRole: 'teacher',
      aggregate: aggregateController({ scoped: success([student({ studentId: MOVED_CLASS_STUDENT_ID })]) }),
      activeSession: () => gate, allSessions: resolvedSession ? [resolvedSession] : [],
      coverageSummary: ownTestingSummary([OWN_TESTING_CONTEXT_ID]),
      claimedStudents: [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
    });
    await page.goto(`${baseURL}/classpilot`);
    await waitUntil(() => harness.coverageSummaryRequests.length > 0 && harness.sessionRequests.includes('/api/sessions/active'), 'Both independent lookups must be in flight');
    await page.getByTestId('assigned-testing-notice').waitFor();
    await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
    await assertPickupView(page, 'claimed');
    assert(harness.claimedRosterRequests.length > 0, 'An authoritative testing assignment can load while the regular class lookup is pending');
    resolveSession(resolvedSession);
    if (resolvedSession) {
      assert.equal(await page.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`).count(), 0, 'Assigned testing takes precedence over the overlapping regular class roster');
      await page.getByTestId('button-view-class-students').click();
      await harness.authenticateWebSocket();
      await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
      await page.clock.fastForward(10_100);
      await assertPickupView(page, 'class');
      await page.getByTestId('badge-active-session').waitFor();
      assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0);
    }
    assert.deepEqual(harness.coverageMutationRequests, []);
    assert.deepEqual(harness.pageErrors, []);
    await page.close();
  }

  const page = await browser.newPage();
  const observed = teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID });
  const harness = await configureDashboard(page, {
    aggregate: aggregateController({ scoped: success([student({ studentId: MOVED_CLASS_STUDENT_ID })]) }),
    allSessions: [observed], coverageSummary: ownTestingSummary([]),
    claimedStudents: [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
  await page.getByTestId('observe-read-only-banner').waitFor();
  await harness.authenticateWebSocket();
  harness.setCoverageSummary(ownTestingSummary([OWN_TESTING_CONTEXT_ID]));
  const before = harness.coverageSummaryRequests.length;
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await waitUntil(() => harness.coverageSummaryRequests.length > before, 'Observe receives the current testing summary without changing its selected class');
  assert.equal(await page.getByTestId('select-admin-observe').inputValue(), OBSERVED_SESSION_ID);
  assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0);
  await assertObserveEntryPointsUnavailable(page, harness.commandPosts, [MOVED_CLASS_STUDENT_ID], harness.coverageMutationRequests);
  assert.deepEqual(harness.claimedRosterRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('assigned testing rejects delayed summary and roster responses after school and viewer changes', { timeout: 75_000 }, async context => {
  const entry = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';
    import {LicenseProvider} from '/src/contexts/LicenseContext.jsx';
    import {ThemeProvider} from '/src/contexts/ThemeContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js';
    import Dashboard from '/src/products/classpilot/pages/Dashboard.jsx';
    import '/src/index.css';
    function IdentityBridge(){const auth=useAuth();React.useEffect(()=>{window.__switchTestingSchool=auth.switchSchool;window.__refreshTestingUser=auth.refetchUser;},[auth.switchSchool,auth.refetchUser]);return React.createElement('div',{'data-testid':'testing-viewer'},auth.activeSchoolId+':'+auth.user?.id);}
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(LicenseProvider,null,React.createElement(ThemeProvider,null,React.createElement(MemoryRouter,null,React.createElement(React.Fragment,null,React.createElement(IdentityBridge),React.createElement(Dashboard))))))));
  `;
  const { browser, baseURL } = await assignedTestingBrowser(context, { plugins: [{
    name: 'assigned-testing-identity-fixture',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__assigned-testing-identity') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__assigned-testing-entry.jsx"></script></body></html>'));
      });
    },
    resolveId(id) { if (id === '/__assigned-testing-entry.jsx') return '\0assigned-testing-entry'; },
    load(id) { if (id === '\0assigned-testing-entry') return entry; },
  }] });
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  let viewerId = ADMIN_ID;
  let secondSchoolTesting = false;
  let resolveOldSummary;
  let resolveOldRoster;
  const oldSummaryGate = new Promise(resolve => { resolveOldSummary = resolve; });
  const oldRosterGate = new Promise(resolve => { resolveOldRoster = resolve; });
  context.after(() => { resolveOldSummary(); resolveOldRoster(); });
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(),
    authentication: request => {
      const schoolId = request.headers()['x-school-id'] || SCHOOL_ID;
      return { ...authResponse(), user: { ...authResponse().user, id: viewerId }, activeSchoolId: schoolId,
        memberships: [SCHOOL_ID, SECOND_SCHOOL_ID].map(id => ({ schoolId: id, role: 'admin', schoolName: `School ${id.slice(0, 4)}`, schoolTimezone: 'America/New_York' })) };
    },
    coverageSummary: async request => {
      const schoolId = request.headers()['x-school-id'] || SCHOOL_ID;
      const responseViewerId = viewerId;
      if (schoolId === SCHOOL_ID) {
        await oldSummaryGate;
        return ownTestingSummary([OWN_TESTING_CONTEXT_ID], { schoolId, viewerId: responseViewerId });
      }
      return ownTestingSummary(secondSchoolTesting && responseViewerId === ADMIN_ID ? [OWN_TESTING_CONTEXT_ID] : [], { schoolId, viewerId: responseViewerId });
    },
    claimedStudents: async () => {
      if (viewerId !== ADMIN_ID) return [];
      await oldRosterGate;
      return [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)];
    },
  });
  await page.goto(`${baseURL}/__assigned-testing-identity`);
  await waitUntil(() => harness.coverageSummaryRequests.some(request => request.schoolId === SCHOOL_ID), 'School A summary must be pending before switching');
  await page.evaluate(schoolId => window.__switchTestingSchool(schoolId), SECOND_SCHOOL_ID);
  await page.waitForFunction(expected => document.querySelector('[data-testid="testing-viewer"]')?.textContent === expected, `${SECOND_SCHOOL_ID}:${ADMIN_ID}`);
  await waitUntil(() => harness.coverageSummaryRequests.some(request => request.schoolId === SECOND_SCHOOL_ID), 'School B obtains its own summary');
  resolveOldSummary();
  await page.clock.fastForward(10_100);
  await assertPickupView(page, 'class');
  assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0);
  assert.deepEqual(harness.claimedRosterRequests, [], 'Late school A summary cannot launch a claimed-roster read in school B');

  secondSchoolTesting = true;
  await page.clock.fastForward(10_100);
  await page.getByTestId('assigned-testing-notice').waitFor();
  await waitUntil(() => harness.claimedRosterRequests.length > 0, 'Viewer A roster must be pending before identity changes');
  viewerId = OTHER_TEACHER_ID;
  await page.evaluate(() => window.__refreshTestingUser());
  await page.waitForFunction(expected => document.querySelector('[data-testid="testing-viewer"]')?.textContent === expected, `${SECOND_SCHOOL_ID}:${OTHER_TEACHER_ID}`);
  resolveOldRoster();
  await page.clock.fastForward(10_100);
  await assertPickupView(page, 'class');
  assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0);
  assert.equal(await page.getByTestId(`card-student-${STUDENT_ID}`).count(), 0, 'Late prior-viewer students cannot populate the current viewer');
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('assigned testing expires at its known end even when summary refresh fails and returns to the current class', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const endsAt = new Date(TESTING_TIME.getTime() + 60_000).toISOString();
  const summary = ownTestingSummary([OWN_TESTING_CONTEXT_ID]);
  summary.ownTestingContexts[0].endsAt = endsAt;
  let summaryUnavailable = false;
  const nextClass = teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: ADMIN_ID });
  const classStudent = student({ studentId: MOVED_CLASS_STUDENT_ID, lastSeenAt: TESTING_TIME.toISOString(), realtimeObservedAt: TESTING_TIME.toISOString() });
  const harness = await configureDashboard(page, {
    userRole: 'teacher',
    aggregate: aggregateController({ scoped: success([classStudent]) }),
    activeSession: teachingSession(),
    coverageSummary: () => summaryUnavailable ? { status: 500, body: { error: 'Temporary summary failure' } } : summary,
    claimedStudents: [testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID)],
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('assigned-testing-notice').waitFor();
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await harness.authenticateWebSocket();
  summaryUnavailable = true;
  const failedRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/coverage/summary' && response.status() === 500);
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await failedRefresh;
  await assertPickupView(page, 'claimed');
  assert.equal(await page.getByTestId('assigned-testing-notice').isVisible(), true, 'A temporary refresh failure before the known end retains the active assignment');
  harness.setActiveSession(nextClass);
  const classReadsBeforeEnd = harness.sessionRequests.length;
  const millisecondsToEnd = await page.evaluate(end => Math.max(0, Date.parse(end) - Date.now()) + 100, endsAt);
  await page.clock.fastForward(millisecondsToEnd);
  await assertPickupView(page, 'class');
  await page.getByTestId('assigned-testing-notice').waitFor({ state: 'hidden' });
  await waitUntil(() => harness.sessionRequests.length > classReadsBeforeEnd, 'The active class is reconciled at the testing boundary');
  await page.getByTestId('badge-active-session').getByText('Biology', { exact: true }).waitFor();
  await page.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`).waitFor();
  assert.equal(await page.getByTestId(`card-student-${STUDENT_ID}`).count(), 0, 'Expired cached testing must not strand its students on the dashboard');
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('assigned testing ignores legacy, missing, malformed and failed ownership metadata without removing manual Claimed access', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const ownRow = testingStudent(STUDENT_ID, OWN_TESTING_CONTEXT_ID);
  const invalidSummaries = [
    { activeContextCount: 1, claimedStudentCount: 1 },
    { ownTestingContexts: ownTestingSummary([OWN_TESTING_CONTEXT_ID]).ownTestingContexts },
    { ...ownTestingSummary([OWN_TESTING_CONTEXT_ID]), ownTestingContexts: [{ id: OWN_TESTING_CONTEXT_ID, activeStudentCount: 1, endsAt: 'invalid' }] },
    { status: 500, body: { error: 'Summary unavailable' } },
  ];
  for (const summary of invalidSummaries) {
    const page = await browser.newPage();
    await page.clock.install({ time: TESTING_TIME });
    const harness = await configureDashboard(page, {
      aggregate: aggregateController(), coverageSummary: summary, claimedStudents: [ownRow],
    });
    await page.goto(`${baseURL}/classpilot`);
    await assertPickupView(page, 'class');
    await waitUntil(() => harness.coverageSummaryRequests.length > 0, 'The summary must be requested before checking its safe fallback');
    await page.clock.fastForward(1_100);
    await assertPickupView(page, 'class');
    assert.equal(await page.getByTestId('assigned-testing-notice').count(), 0);
    assert.deepEqual(harness.claimedRosterRequests, []);
    await page.getByTestId('button-view-claimed-students').click();
    await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
    await assertPickupView(page, 'claimed');
    assert.deepEqual(harness.coverageMutationRequests, []);
    assert.deepEqual(harness.commandPosts, []);
    assert.deepEqual(harness.pageErrors, []);
    await page.close();
  }
});


function scheduledActivityResponse(current, { next = null, serverTime = '2026-09-15T13:10:55Z', nextBoundaryAt = null } = {}) {
  return { enabled: true, schoolId: SCHOOL_ID, viewerId: ADMIN_ID, revision: `${current?.id || 'idle'}:${current?.studentCount || 0}`, serverTime,
    current, activities: current ? [current] : [], next, nextBoundaryAt: nextBoundaryAt || current?.endsAt || next?.startsAt || null };
}
function scheduledTestingActivity(overrides = {}) {
  return { id: OWN_TESTING_CONTEXT_ID, source: 'scheduled_testing', name: 'Grade 5 Reading MAP',
    startsAt: '2026-09-15T13:11:00Z', endsAt: '2026-09-15T13:15:00Z', status: 'active', studentCount: 23,
    authority: { supervisionContextId: OWN_TESTING_CONTEXT_ID }, contextAuthorityRevision: '0',
    capabilities: { commands: ['open-tab', 'close-tabs', 'teacher-message', 'timer', 'poll', 'student-sign-out'],
      fab: true, chat: true, raiseHand: true, polls: true, timers: true, liveView: true, screenshots: true, settings: true }, ...overrides };
}
function scheduledClassActivity(overrides = {}) {
  return { id: OWN_SESSION_ID, source: 'scheduled_class', name: 'Grade 5 Homeroom', startsAt: '2026-09-15T12:30:00Z', endsAt: '2026-09-15T13:11:00Z',
    status: 'active', studentCount: 1, authority: { teachingSessionId: OWN_SESSION_ID }, ...overrides };
}
const offlineTestingRoster = () => Array.from({ length: 23 }, (_, index) => student({
  studentId: `offline-test-${index}`, studentName: `Testing student ${index + 1}`, isLoggedIn: false, loginState: 'not_logged_in', status: 'offline',
  activityState: 'inactive', contextId: OWN_TESTING_CONTEXT_ID, supervisionState: 'temporary_coverage',
  supervisionContext: { id: OWN_TESTING_CONTEXT_ID, type: 'testing', assignedStaffId: ADMIN_ID },
}));

test('automatic scheduled Class renders Homeroom then all 23 offline testing tiles then the next applied class without clicks', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: new Date('2026-09-15T13:10:55Z') });
  const aggregate = aggregateController({ scoped: success([student({ studentName: 'Homeroom student' })]) });
  const harness = await configureDashboard(page, { aggregate, activeSession: teachingSession(), acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledClassActivity()),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('scheduled-class-banner').getByText('Class: Grade 5 Homeroom', { exact: true }).waitFor({ state: 'attached' });
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  aggregate.setScopedResponse(success(offlineTestingRoster()));
  harness.setDashboardActivity(scheduledActivityResponse(scheduledTestingActivity(), { serverTime: '2026-09-15T13:11:00Z' }));
  await page.clock.fastForward(5000);
  await page.getByTestId('scheduled-class-banner').getByText('Testing: Grade 5 Reading MAP', { exact: true }).waitFor({ state: 'attached' });
  await page.getByTestId('card-student-offline-test-22').waitFor();
  assert.equal(await page.locator('[data-testid^="card-student-"]').count(), 23);
  await assertPickupView(page, 'class');
  assert.equal(await page.getByTestId(`card-student-${STUDENT_ID}`).count(), 0);
  assert.equal(await page.getByTestId('button-end-session').count(), 0, 'Testing does not offer End Class for the underlying Homeroom');
  assert.ok(aggregate.requests.some(request => request.supervisionContextId === OWN_TESTING_CONTEXT_ID));
  assert.ok(aggregate.requests.every(request => request.teachingSessionId || request.supervisionContextId), 'Never request a school-wide roster');
  const next = scheduledClassActivity({ id: OBSERVED_SESSION_ID, name: 'Grade 5 Specials', startsAt: '2026-09-15T13:15:00Z', endsAt: '2026-09-15T13:55:00Z', authority: { teachingSessionId: OBSERVED_SESSION_ID } });
  aggregate.setScopedResponse(success([student({ studentId: MOVED_CLASS_STUDENT_ID, studentName: 'Specials student' })]));
  harness.setDashboardActivity(scheduledActivityResponse(next, { serverTime: '2026-09-15T13:15:00Z' }));
  await page.clock.fastForward(240000);
  await page.getByTestId('scheduled-class-banner').getByText('Class: Grade 5 Specials', { exact: true }).waitFor({ state: 'attached' });
  await page.getByTestId(`card-student-${MOVED_CLASS_STUDENT_ID}`).waitFor();
  assert.equal(await page.getByTestId('card-student-offline-test-0').count(), 0);
  await assertPickupView(page, 'class');
  assert.deepEqual(harness.pageErrors, []);
  assert.deepEqual(harness.coverageMutationRequests, [], 'Transitions use reads; they never recreate claims');
});

test('automatic scheduled Class permits browsing between boundaries and ignores same-assignment extensions', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await page.clock.install({ time: new Date('2026-09-15T13:11:00Z') });
  const aggregate = aggregateController({ scoped: success(offlineTestingRoster()) });
  const harness = await configureDashboard(page, { aggregate, acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledTestingActivity(), { serverTime: '2026-09-15T13:11:00Z' }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('card-student-offline-test-0').waitFor();
  await page.getByTestId('button-view-available-students').click();
  await assertPickupView(page, 'available');
  const readCount = harness.activityRequests.length;
  harness.setDashboardActivity(scheduledActivityResponse(scheduledTestingActivity({ endsAt: '2026-09-15T13:20:00Z', studentCount: 22 }), { serverTime: '2026-09-15T13:11:00Z' }));
  await harness.sendWebSocketMessage({ type: 'dashboard-activity-updated', schoolId: SCHOOL_ID });
  await waitUntil(() => harness.activityRequests.length > readCount, 'A refresh must read the extended assignment');
  await assertPickupView(page, 'available');
  harness.setDashboardActivity(scheduledActivityResponse(scheduledClassActivity({ id: OBSERVED_SESSION_ID, name: 'Next class', startsAt: '2026-09-15T13:20:00Z', endsAt: '2026-09-15T14:00:00Z', authority: { teachingSessionId: OBSERVED_SESSION_ID } }), { serverTime: '2026-09-15T13:20:00Z' }));
  aggregate.setScopedResponse(success([student({ studentName: 'Next class student' })]));
  await page.clock.fastForward(540000);
  await assertPickupView(page, 'class');
  await page.getByTestId('scheduled-class-banner').getByText('Class: Next class', { exact: true }).waitFor({ state: 'attached' });
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  assert.deepEqual(harness.pageErrors, []);
});

test('automatic scheduled Class resumes the same regular session without restoring its old browsing choice', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: new Date('2026-09-15T13:10:55Z') });
  const regular = scheduledClassActivity({ endsAt: '2026-09-15T13:30:00Z' });
  const aggregate = aggregateController({ scoped: success([student()]) });
  const harness = await configureDashboard(page, { aggregate, activeSession: teachingSession(), acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(regular, { nextBoundaryAt: '2026-09-15T13:11:00Z' }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await page.getByTestId('button-view-available-students').click();
  await assertPickupView(page, 'available');
  aggregate.setScopedResponse(success(offlineTestingRoster()));
  harness.setDashboardActivity(scheduledActivityResponse(scheduledTestingActivity(), { serverTime: '2026-09-15T13:11:00Z' }));
  await page.clock.fastForward(5000);
  await page.getByTestId('card-student-offline-test-22').waitFor();
  await assertPickupView(page, 'class');
  aggregate.setScopedResponse(success([student()]));
  harness.setDashboardActivity(scheduledActivityResponse(regular, { serverTime: '2026-09-15T13:15:00Z' }));
  await page.clock.fastForward(240000);
  await page.getByTestId('scheduled-class-banner').getByText('Class: Grade 5 Homeroom', { exact: true }).waitFor({ state: 'attached' });
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await assertPickupView(page, 'class');
  assert.deepEqual(harness.pageErrors, []);
});

test('automatic scheduled Class expires private during failed refresh and retries reads without a supervision mutation', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: new Date('2026-09-15T13:14:59Z') });
  const aggregate = aggregateController({ scoped: success(offlineTestingRoster()) });
  const harness = await configureDashboard(page, { aggregate, acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledTestingActivity(), { serverTime: '2026-09-15T13:14:59Z' }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('card-student-offline-test-0').waitFor();
  harness.setDashboardActivity({ status: 503 });
  await page.clock.fastForward(1000);
  await page.getByRole('button', { name: 'Retry class assignment' }).waitFor();
  assert.equal(await page.getByTestId('card-student-offline-test-0').count(), 0);
  assert.ok(aggregate.requests.every(request => request.teachingSessionId || request.supervisionContextId));
  harness.setDashboardActivity(scheduledActivityResponse(null, { serverTime: '2026-09-15T13:15:00Z', next: { source: 'scheduled_class', name: 'Specials', startsAt: '2026-09-15T13:15:00Z', endsAt: '2026-09-15T13:55:00Z', status: 'waiting' } }));
  await page.getByRole('button', { name: 'Retry class assignment' }).click();
  await page.getByTestId('scheduled-class-banner').getByText('Awaiting live supervision', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-testid^="card-student-"]').count(), 0);
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});


test('scheduled classroom tools retain passive previews without Live View and close outgoing dialogs at handoff', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  let testingCapture = 0;
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.clock.install({ time: new Date('2026-09-15T13:11:30Z') });
  const row = student({ supervisionState: 'temporary_coverage',
    supervisionContext: { id: OWN_TESTING_CONTEXT_ID, type: 'testing', assignedStaffId: ADMIN_ID },
    capabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: true, liveViewNegotiationV1: true, screenshotTrackingWindowLeaseV1: true },
    lastSeenAt: '2026-09-15T13:11:30Z', realtimeObservedAt: '2026-09-15T13:11:30Z',
  });
  const aggregate = aggregateController({ scoped: success([row]) });
  const harness = await configureDashboard(page, { aggregate, userRole: 'teacher', acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledTestingActivity({ studentCount: 1,
      capabilities: { ...scheduledTestingActivity().capabilities, commands: ['open-tab', 'close-tabs', 'teacher-message', 'timer', 'poll', 'attention-mode', 'student-sign-out'] },
    }), { serverTime: '2026-09-15T13:11:30Z' }),
    screenshotTiles: () => ({ tiles: [{ studentId: STUDENT_ID, bindingVersion: 'v3:testing-preview', screenshot: {
      screenshot: TINY_SCREENSHOT_DATA_URL, bindingVersion: 'v3:testing-preview',
      timestamp: Date.parse('2026-09-15T13:11:30Z') + testingCapture * 1000,
      tabTitle: `Testing screen ${testingCapture}`, tabUrl: 'https://lesson.example.edu/testing',
    } }] }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  const commandRequests = [];
  const commandHeaders = [];
  const settingsRequests = [];
  await page.route('**/api/commands', async route => {
    const body = route.request().postDataJSON(); commandRequests.push(body); commandHeaders.push(route.request().headers()['x-classpilot-context-authority-revision']);
    await route.fulfill({ json: { command: { id: `synthetic-${commandRequests.length}`, ...body,
      targets: body.targetStudentIds.map(studentId => ({ studentId, status: 'acknowledged' })) } } });
  });
  await page.route(`**/api/classpilot/supervision-contexts/${OWN_TESTING_CONTEXT_ID}/settings`, async route => {
    const request = route.request();
    const body = request.method() === 'PATCH' ? request.postDataJSON() : {};
    if (request.method() === 'PATCH') settingsRequests.push(body);
    await route.fulfill({ json: { settings: { supervisionContextId: OWN_TESTING_CONTEXT_ID, lifecycleRevision: 2,
      raiseHandEnabled: body.raiseHandEnabled ?? true, chatEnabled: body.chatEnabled ?? true } } });
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await waitUntil(() => harness.tileRequests.some(row => row.pathname.endsWith('/screenshots')), 'Scheduled tiles load screenshot batches');
  assert.ok(harness.tileRequests.every(row => row.body.supervisionContextId === OWN_TESTING_CONTEXT_ID && !row.body.teachingSessionId && row.contextAuthorityRevision === '0'));
  assert.ok(harness.observationLeaseRequests.some(row => row.method === 'PUT' && row.pathname.includes(OWN_TESTING_CONTEXT_ID) && row.schoolId === SCHOOL_ID && row.contextAuthorityRevision === '0'));
  await page.getByTestId(`screenshot-${STUDENT_ID}`).waitFor();
  testingCapture = 1;
  await harness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID, studentId: STUDENT_ID });
  await page.clock.fastForward(1100);
  await page.getByTestId(`card-student-${STUDENT_ID}`).getByText('Testing screen 1', { exact: true }).waitFor();
  await page.getByTestId(`screenshot-current-${STUDENT_ID}`).click();
  await page.getByTestId('expanded-screenshot-dialog').waitFor();
  await page.getByTestId('expanded-screenshot-dialog').getByRole('button', { name: 'Close' }).click();
  assert.equal(await page.getByTestId(`button-live-view-${STUDENT_ID}`).count(), 0, 'Scheduled testing must not expose View or Stop controls');
  assert.equal(await page.getByTestId(`button-expand-${STUDENT_ID}`).count(), 0, 'Scheduled testing must not expose expanded Live View');
  assert.equal(await page.getByTestId('video-portal').count(), 0);
  await harness.sendWebSocketMessage({ type: 'live-view-requested', schoolId: SCHOOL_ID, supervisionContextId: OWN_TESTING_CONTEXT_ID,
    studentId: STUDENT_ID, contextAuthorityRevision: '0', negotiationId: 'scheduled-negotiation' });
  const openTools = async (tab) => { const launcher = page.getByRole('button', { name: 'Class tools', exact: true }); if (await launcher.getAttribute('aria-expanded') !== 'true') await launcher.click(); if (tab) await page.getByRole('tab', { name: tab, exact: true }).click(); };
  await openTools('Tools');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await page.getByTestId('button-start-timer').click();
  await waitUntil(() => commandRequests.some(row => row.commandType === 'timer'), 'Timer uses scheduled authority');
  await openTools('Activities');
  await page.getByRole('button', { name: 'Create poll', exact: true }).click();
  await page.getByTestId('input-poll-question').fill('Ready for reading?');
  await page.getByTestId('input-poll-option-0').fill('Ready');
  await page.getByTestId('input-poll-option-1').fill('Need help');
  await page.getByTestId('button-create-poll').click();
  await waitUntil(() => commandRequests.some(row => row.commandType === 'poll'), 'Poll uses scheduled authority');
  await openTools('Tools');
  await page.getByRole('button', { name: 'Eyes up', exact: true }).click();
  await page.getByTestId('button-activate-attention').click();
  await waitUntil(() => commandRequests.some(row => row.commandType === 'attention-mode'), 'Attention uses scheduled authority');
  await page.getByTestId('button-cancel-attention').click();
  await openTools('Help');
  await page.getByTestId('hands-switch').click();
  await waitUntil(() => settingsRequests.length === 1, 'Scheduled hand settings are editable');
  assert.equal(settingsRequests[0].raiseHandEnabled, false);
  assert.equal(settingsRequests[0].expectedRevision, 2);
  assert.ok(commandHeaders.every(revision => revision === '0'));
  assert.ok(commandRequests.every(row => row.supervisionContextId === OWN_TESTING_CONTEXT_ID && !row.teachingSessionId
    && row.targetScope === 'students' && row.targetStudentIds.length === 1 && row.targetStudentIds[0] === STUDENT_ID));
  await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  // A form left open cannot submit an outgoing assignment after the boundary.
  await openTools();
  await page.getByTestId('chat-open').click();
  await page.getByTestId('chat-broadcast').click();
  await page.getByTestId('input-send-message').fill('Do not carry me into the next class');
  harness.setDashboardActivity(scheduledActivityResponse(null, { serverTime: '2026-09-15T13:15:00Z' }));
  await page.clock.fastForward(210000);
  await page.getByTestId('scheduled-class-banner').getByText('No class active', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('dialog-send-message').count(), 0);
  assert.equal(await page.getByTestId(`card-student-${STUDENT_ID}`).count(), 0);
  assert.equal(harness.websocketMessages.some(row => ['request-stream', 'offer', 'ice'].includes(row.type)), false, 'Dormant Dashboard must not negotiate Live View even for a supported scheduled assignment');
  assert.equal(commandRequests.filter(row => row.commandType === 'teacher-message').length, 0);
  assert.deepEqual(harness.pageErrors, []);
});


test('scheduled classroom restores acknowledged timer and poll after reload and gates older extensions', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: new Date('2026-09-15T13:11:30Z') });
  const aggregate = aggregateController({ scoped: success([student({
    supervisionState: 'temporary_coverage', supervisionContext: { id: OWN_TESTING_CONTEXT_ID, type: 'testing', assignedStaffId: ADMIN_ID },
    lastSeenAt: '2026-09-15T13:11:30Z', realtimeObservedAt: '2026-09-15T13:11:30Z', capabilities: {},
  })]) });
  const harness = await configureDashboard(page, { aggregate, userRole: 'teacher', acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledTestingActivity({ studentCount: 1 }), { serverTime: '2026-09-15T13:11:30Z' }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  const stateReads = [];
  await page.route('**/api/commands/active-state?**', async route => {
    const url = new URL(route.request().url()); stateReads.push(url.searchParams.toString());
    await route.fulfill({ json: { states: [], transient: {
      timer: { commandId: 'persisted-timer', message: 'Keep working', endsAt: '2026-09-15T13:14:00Z', completedTargetCount: 1, pendingTargetCount: 0 },
      poll: { id: 'persisted-poll', supervisionContextId: OWN_TESTING_CONTEXT_ID, isActive: true, question: 'Ready?', options: ['Yes', 'No'] },
    } } });
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await page.getByText('Extension update required for full testing tools on some student Chromebooks.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Stop timer', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Activities', exact: true }).click();
  await page.getByRole('button', { name: 'View responses (0)', exact: true }).waitFor();
  assert.ok(stateReads.every(query => query === `supervisionContextId=${OWN_TESTING_CONTEXT_ID}`));
  assert.equal(await page.getByTestId(`button-live-view-${STUDENT_ID}`).count(), 0);
  assert.deepEqual(harness.tileRequests.filter(row => row.pathname.endsWith('/screenshots')), [], 'Unsupported clients never use previous-class previews');
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Stop timer', exact: true }).click();
  assert.deepEqual(harness.commandPosts, [], 'Unsupported tool actions must not be reported as submitted');
  assert.deepEqual(harness.pageErrors, []);
});


test('scheduled classroom layout retains offline tiles on desktop and mobile in both themes', { timeout: 90_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  for (const [size, viewport] of [['desktop', { width: 1360, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport });
      await page.addInitScript(theme => localStorage.setItem('sp_theme', theme), theme);
      await page.clock.install({ time: new Date('2026-09-15T13:11:30Z') });
      const harness = await configureDashboard(page, { aggregate: aggregateController({ scoped: success(offlineTestingRoster()) }),
        userRole: 'teacher', acknowledgeSessionSubscriptions: true,
        dashboardActivity: scheduledActivityResponse(scheduledTestingActivity(), { serverTime: '2026-09-15T13:11:30Z' }),
        coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
      });
      await page.goto(`${baseURL}/classpilot`);
      await page.getByTestId('card-student-offline-test-22').waitFor();
      assert.equal(await page.getByText(/^In supervision:/).count(), 0, 'Own testing tiles use the normal Class environment without a covering badge');
      const banner = page.getByTestId('scheduled-class-banner');
      // The class name is announced to assistive technology but not drawn: the
      // header pill already names the class, so the banner must not repeat it.
      await banner.getByText('Testing: Grade 5 Reading MAP', { exact: true }).waitFor({ state: 'attached' });
      // The roster line repeated the header's end time and counted idle students
      // as online, so it read "1 online" while the card below read "0 Online Now".
      assert.equal(await banner.getByText(/students · .*online/).count(), 0,
        'The banner must not restate the roster, the end time, or a second online count');
      const bounds = await banner.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'Assignment banner fits the viewport');
      const evidence = process.env.CLASSPILOT_ACTIVITY_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: path.join(evidence, `scheduled-class-${size}-${theme}.png`) });
      }
      assert.deepEqual(harness.pageErrors, []);
      await page.close();
    }
  }
});

test('scheduled classroom details fence history to their assignment and retry failed reads without fallback', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: new Date('2026-09-15T13:11:30Z') });
  const harness = await configureDashboard(page, { aggregate: aggregateController({ scoped: success([student({
    supervisionState: 'temporary_coverage', supervisionContext: { id: OWN_TESTING_CONTEXT_ID, type: 'testing', assignedStaffId: ADMIN_ID },
  })]) }), userRole: 'teacher', acknowledgeSessionSubscriptions: true,
    dashboardActivity: scheduledActivityResponse(scheduledTestingActivity({ studentCount: 1 }), { serverTime: '2026-09-15T13:11:30Z' }),
    coverageSummary: { ...ownSupervisionSummary([]), ownAdHocContexts: [] },
  });
  const historyReads = [];
  let unavailable = true;
  await page.route(`**/api/classpilot/students/${STUDENT_ID}/timeline?**`, async route => {
    const request = route.request(); historyReads.push({ url: new URL(request.url()), schoolId: request.headers()['x-school-id'], revision: request.headers()['x-classpilot-context-authority-revision'] });
    await route.fulfill(unavailable ? { status: 503, json: { error: 'History temporarily unavailable' } }
      : { json: { events: [{ id: 'testing-history', title: 'Current testing activity', occurredAt: '2026-09-15T13:11:20Z', eventType: 'classroom_context' }] } });
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`button-student-details-${STUDENT_ID}`).click();
  await page.getByTestId('tab-timeline').click();
  await page.getByText('Student timeline unavailable for this assignment.', { exact: true }).waitFor();
  unavailable = false;
  await page.getByRole('button', { name: 'Retry timeline', exact: true }).click();
  await page.getByText('Current testing activity', { exact: true }).waitFor();
  assert.ok(historyReads.length >= 2);
  assert.ok(historyReads.every(read => read.schoolId === SCHOOL_ID && read.revision === '0'
    && read.url.searchParams.get('supervisionContextId') === OWN_TESTING_CONTEXT_ID
    && !read.url.searchParams.has('teachingSessionId')));
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('Class tools integrates support, activities and manual routines without covering the command toolbar', async context => {
  const fixture = await chatBrowserFixture(context, { openPanel: false });
  const { page } = fixture;
  await page.setViewportSize({ width: 1440, height: 1000 });
  const writes = [];
  const toolsState = { phase: 5, roster: [{studentId:STUDENT_ID,firstName:'Alex',lastName:'Student'}],
    help: [{id:'help-one',studentId:STUDENT_ID,status:'waiting',category:'assignment',explanation:'Please explain problem two.',raisedAt:new Date(Date.now()-180000).toISOString(),revision:1}],
    questions:[{id:'question-one',studentId:STUDENT_ID,question:'Can we use a calculator?',answer:null,groupLabel:null,revision:1}], progress:[{studentId:STUDENT_ID,status:'stuck',completedItemIds:[],revision:1}], templates:[], picker:null,routine:null,routineOutcomes:[],prompt:null,responses:[],promptTargets:[],
    activity:{id:'lesson-one',title:'Independent practice',instructions:'Complete problems 1–4 and explain your reasoning.',resources:[],checklist:[],revision:1},
    activityTargets:[{studentId:STUDENT_ID,studentName:'Alex Student',status:'completed'}],
    timer:{id:'timer-one',revision:1,deadline:new Date(Date.now()+240000).toISOString(),pausedRemainingMs:null,message:'Independent practice'},timerTargets:[] };
  await page.route('**/api/classpilot/class-tools/**', async route => {
    const request=route.request(), pathname=new URL(request.url()).pathname;
    if(pathname.endsWith('/rollout')) return route.fulfill({json:{phase:5}});
    if(pathname.endsWith('/state')) return route.fulfill({json:toolsState});
    if(request.method() !== 'GET') {
      const body=request.postDataJSON(); writes.push({pathname,body});
      if(pathname.endsWith('/help/help-one')) toolsState.help[0]={...toolsState.help[0],status:'acknowledged',revision:2};
      if(pathname.endsWith('/questions/question-one')) toolsState.questions[0]={...toolsState.questions[0],...body.data,revision:2};
      if(pathname.endsWith('/templates')) toolsState.templates.push({...body.data,id:'template-one',revision:1});
      if(pathname.endsWith('/follow-up-preview')) return route.fulfill({json:{recipients:[{studentId:STUDENT_ID,name:'Alex Student',available:true}]}});
      if(pathname.endsWith('/follow-up')) return route.fulfill({json:{command:{targets:[{studentId:STUDENT_ID,studentName:'Alex Student',status:'completed'}]}}});
      return route.fulfill({json:{ok:true}});
    }
    return route.fulfill({json:{events:[],nextCursor:null}});
  });
  await fixture.refetch('/api/class-tools/rollout');
  await page.getByRole('button',{name:'Class tools',exact:true}).click();
  await page.getByRole('tab',{name:/Help/}).click();
  await page.getByText('Please explain problem two.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Acknowledge',exact:true}).click();
  await page.getByRole('button',{name:'Mark helped',exact:true}).waitFor();
  assert.deepEqual(writes[0].body,{teachingSessionId:OWN_SESSION_ID,data:{expectedRevision:1,action:'acknowledge'}});
  await page.getByLabel('Group question from Alex Student',{exact:true}).fill('Directions');
  await page.getByLabel('Answer question from Alex Student',{exact:true}).fill('Yes, show your steps too.');
  await page.getByRole('button',{name:'Save answer / group',exact:true}).click();
  await page.getByRole('heading',{name:'Directions · 1',exact:true}).waitFor();
  await page.getByRole('tab',{name:'Activities',exact:true}).click();
  await page.getByRole('button',{name:'Stuck 1',exact:true}).click();
  await page.getByRole('button',{name:'Preview exact recipients',exact:true}).click();
  await page.getByRole('region',{name:'Follow-up recipients'}).getByText('Alex Student',{exact:true}).waitFor();
  await page.getByRole('region',{name:'Follow-up recipients'}).getByLabel('Message',{exact:true}).fill('Try the worked example.');
  await page.getByRole('button',{name:'Send to these 1 students',exact:true}).click();
  await page.getByRole('region',{name:'Follow-up recipients'}).getByTestId('class-tools-delivery').filter({hasText:'1 reached'}).waitFor();
  assert.deepEqual(writes.find(write=>write.pathname.endsWith('/follow-up')).body.data,{kind:'work_status',resourceId:'lesson-one',targetStudentIds:[STUDENT_ID],commandType:'teacher-message',commandPayload:{message:'Try the worked example.'}});
  await page.getByRole('region',{name:'Follow-up recipients'}).getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Save routine',exact:true}).click();
  await page.getByLabel('Template name',{exact:true}).fill('Independent work routine');
  await page.getByRole('button',{name:'Save template',exact:true}).click();
  await page.getByText('Independent work routine',{exact:true}).waitFor();
  const saved = writes.find(write=>write.pathname.endsWith('/templates'));
  assert.deepEqual(saved.body.data.content.steps.map(step=>step.kind),['instructions','timer','exit_ticket']);
  await page.getByRole('tab',{name:'Tools',exact:true}).click();
  await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
  await page.getByRole('button',{name:'Pin Class tools',exact:true}).click();
  assert.equal(await page.getByTestId('class-tools-panel').getAttribute('data-docked'),'true');
  const geometry = async () => page.evaluate(() => {
    const panel=document.querySelector('[data-testid="class-tools-panel"]').getBoundingClientRect();
    const buttons=[...document.querySelector('[data-class-tools-toolbar]').querySelectorAll('button')].filter(node=>node.getBoundingClientRect().width>0);
    return {panel:panel.toJSON(),covered:buttons.filter(node=>{const rect=node.getBoundingClientRect();return rect.right>panel.left&&rect.left<panel.right&&rect.bottom>panel.top&&rect.top<panel.bottom;}).map(node=>node.textContent)};
  });
  await waitUntil(async()=>!(await geometry()).covered.length,'Pinned toolbar must remain outside panel');
  await page.getByRole('button',{name:'Unpin Class tools',exact:true}).click();
  await waitUntil(async()=>!(await geometry()).covered.length,'Floating toolbar must remain outside panel');
  await page.getByRole('tab',{name:'Activities',exact:true}).click();
  await page.locator('#class-tools-content-activities').evaluate(node=>{node.scrollTop=0;});
  await chatEvidence(page,'class-tools-dashboard',{layout:'floating',phase:5});
  await page.setViewportSize({width:900,height:1000});
  await page.getByRole('dialog',{name:'Class tools',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Pin Class tools',exact:true}).count(),0);
  await waitUntil(async () => (await geometry()).panel.height > 250, 'Responsive drawer must have usable height');
  await page.setViewportSize({width:640,height:900});
  await waitUntil(async () => (await geometry()).panel.height > 200, 'A zoom-sized viewport must keep the drawer usable');
  await page.getByRole('button',{name:'Close Class tools',exact:true}).click();
  await page.getByTestId('class-tools-panel').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.testid),'teacher-fab');
});

for (const userRole of ['teacher', 'admin']) {
test(`Claimed ${userRole} tiles authorize, refresh, and enlarge previews from their own roster`, { timeout: 75_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install({ time: TESTING_TIME });
  const contexts = [OWN_TESTING_CONTEXT_ID, OTHER_TESTING_CONTEXT_ID];
  const rows = contexts.map((contextId, index) => ({
    ...testingStudent(index ? SIGNED_OUT_STUDENT_ID : STUDENT_ID, contextId),
    contextAuthorityRevision: String(index + 7), contextEndsAt: '2026-09-14T16:00:00Z',
    classroomState: { revision: 3 },
    acceptedCapabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: true, screenshotActiveObservationCadenceV1: true },
  }));
  let frame = 1;
  let deniedContext = null;
  // Production's navigation summary deliberately has no authority revision.
  const summary = ownSupervisionSummary(contexts.map(id => ({ id, name: `Claim ${id.slice(0, 4)}` })));
  const harness = await configureDashboard(page, {
    aggregate: aggregateController(), userRole, activeSession: teachingSession(),
    allSessions: [teachingSession()], acknowledgeSessionSubscriptions: true,
    claimedStudents: rows, coverageSummary: summary,
    observationLeaseResponse: (method, pathname) => method === 'PUT' && deniedContext && pathname.includes(deniedContext)
      ? { status: 403, body: { code: 'OBSERVATION_SESSION_UNAVAILABLE' } }
      : { renewAfterSeconds: 30 },
    screenshotTiles: body => {
      const row = rows.find(student => student.contextId === body.supervisionContextId);
      assert(row, 'A claimed preview uses its own supervision authority, never the unrelated class');
      const bindingVersion = `v3:claim-${row.studentId}`;
      return { tiles: [{ studentId: row.studentId, bindingVersion, screenshot: {
        screenshot: TINY_SCREENSHOT_DATA_URL, bindingVersion, timestamp: new Date(TESTING_TIME.getTime() + frame * 1000).toISOString(),
        tabTitle: `Claimed screen ${frame}`, tabUrl: 'https://lesson.example.edu/work',
      } }] };
    },
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('button-view-claimed-students').click();
  await waitUntil(() => contexts.every(id => harness.observationLeaseRequests.some(request =>
    request.method === 'PUT' && request.pathname.includes(id))), 'Both claimed contexts must authorize previews');
  for (const row of rows) {
    await page.getByTestId(`screenshot-${row.studentId}`).waitFor();
    assert(harness.tileRequests.some(request => request.body.supervisionContextId === row.contextId
      && request.contextAuthorityRevision === row.contextAuthorityRevision));
  }
  await page.getByTestId(`screenshot-current-${STUDENT_ID}`).click();
  await page.getByTestId('expanded-screenshot-dialog').waitFor();
  await page.getByTestId('expanded-screenshot-dialog').getByRole('button', { name: 'Close' }).click();
  const readsBeforeEvent = harness.tileRequests.length;
  frame = 2;
  await harness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID,
    studentId: SIGNED_OUT_STUDENT_ID, capturedAt: TESTING_TIME.toISOString() });
  await page.clock.fastForward(1100);
  await waitUntil(() => harness.tileRequests.length > readsBeforeEvent,
    'A claimed screenshot notification refreshes without waiting for the 30-second fallback');
  await page.getByTestId(`card-student-${SIGNED_OUT_STUDENT_ID}`).getByText('Claimed screen 2', { exact: true }).waitFor();
  const authorizedReads = harness.tileRequests.filter(request => request.pathname.endsWith('/screenshots')).length;
  await harness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SECOND_SCHOOL_ID, studentId: STUDENT_ID });
  await harness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID, studentId: STUDENT_ID, teachingSessionId: OWN_SESSION_ID });
  await page.clock.fastForward(1100);
  await page.waitForTimeout(100);
  assert.equal(harness.tileRequests.filter(request => request.pathname.endsWith('/screenshots')).length, authorizedReads,
    'Foreign-school and unrelated teaching-session notifications cannot refresh claimed previews');
  deniedContext = OWN_TESTING_CONTEXT_ID;
  await page.clock.fastForward(31_000);
  await page.getByTestId(`screenshot-${STUDENT_ID}`).waitFor({ state: 'hidden' });
  await page.getByTestId(`screenshot-${SIGNED_OUT_STUDENT_ID}`).waitFor();
  assert.equal(await page.getByTestId(`card-student-${STUDENT_ID}`).count(), 1,
    'Losing preview authority hides private pixels without discarding the roster');
  deniedContext = null;
  rows[0] = { ...rows[0], contextAuthorityRevision: '9' };
  harness.setClaimedStudents([...rows]);
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.getByTestId(`screenshot-${STUDENT_ID}`).waitFor();
  assert(harness.observationLeaseRequests.some(request => request.method === 'PUT'
    && request.pathname.includes(OWN_TESTING_CONTEXT_ID) && request.contextAuthorityRevision === '9'),
  'Replacement authority acquires its own lease before restoring a claimed preview');
  harness.setClaimedStudents(rows.slice(1));
  harness.setCoverageSummary(ownSupervisionSummary([{ id: OTHER_TESTING_CONTEXT_ID, name: 'Remaining claim' }]));
  await harness.sendWebSocketMessage({ type: 'coverage-summary-updated', schoolId: SCHOOL_ID });
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor({ state: 'hidden' });
  await page.getByTestId(`screenshot-${SIGNED_OUT_STUDENT_ID}`).waitFor();
  assert.equal(await page.getByTestId(`screenshot-${STUDENT_ID}`).count(), 0, 'Released students lose their preview');
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});
}

test('Observe waits for live supervision and recovers when the same scheduled class becomes live', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  const now = new Date();
  await page.clock.install({ time: now });
  let observed = { ...teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID }),
    sessionMode: 'scheduled_report', scheduledState: 'active', scheduledDate: now.toISOString().slice(0, 10) };
  let observedCapture = 0;
  const harness = await configureDashboard(page, {
    activeSession: null, allSessions: [observed], acknowledgeSessionSubscriptions: true,
    aggregate: aggregateController({ scoped: success([student({ lastSeenAt: now.toISOString(), realtimeObservedAt: now.toISOString() })]) }),
    sessionSubscriptionResponse: () => observed.sessionMode === 'live'
      ? { type: 'session-subscription-success' }
      : { type: 'session-subscription-error', code: 'SESSION_UNAVAILABLE' },
    screenshotTiles: () => ({ tiles: [{ studentId: STUDENT_ID, bindingVersion: 'v2:observe-promotion',
      screenshot: { screenshot: TINY_SCREENSHOT_DATA_URL, timestamp: new Date(now.getTime() + observedCapture * 1000).toISOString(),
        bindingVersion: 'v2:observe-promotion', tabTitle: `Observed screen ${observedCapture}`, tabUrl: 'https://lesson.example.edu/observe' } }] }),
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
  await page.getByTestId('screenshot-observation-ineligible').waitFor();
  await harness.authenticateWebSocket();
  await new Promise(resolve => setTimeout(resolve, 250));
  await chatEvidence(page, 'observe-awaiting-live');
  assert.equal(harness.websocketMessages.filter(message => message.type === 'subscribe-session').length, 0,
    'An active reporting-only occurrence must not request a live subscription and be mislabeled closed');
  assert.equal(await page.getByTestId('session-subscription-error').count(), 0);
  assert.equal(harness.observationLeaseRequests.filter(request => request.method === 'PUT').length, 0);

  observed = { ...observed, sessionMode: 'live', rosterSnapshotCompletedAt: now.toISOString() };
  harness.setAllSessions([observed]);
  // No websocket event or selection change: the reporting occurrence keeps
  // its identity when the teacher starts supervising it.
  await page.clock.fastForward(10_100);
  await waitUntil(() => harness.websocketMessages.some(message => message.type === 'subscribe-session'
    && message.sessionId === OBSERVED_SESSION_ID), 'Observe must subscribe after the same occurrence becomes live');
  await page.getByTestId(`screenshot-${STUDENT_ID}`).waitFor();
  observedCapture = 1;
  await harness.sendWebSocketMessage({ type: 'screenshot-available', schoolId: SCHOOL_ID,
    teachingSessionId: OBSERVED_SESSION_ID, studentId: STUDENT_ID });
  await page.clock.fastForward(1100);
  await page.getByTestId(`card-student-${STUDENT_ID}`).getByText('Observed screen 1', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('session-subscription-error').count(), 0);
  assert.equal(await page.getByTestId('screenshot-observation-ineligible').count(), 0);
  await page.getByTestId(`screenshot-current-${STUDENT_ID}`).click();
  await page.getByTestId('expanded-screenshot-dialog').waitFor();
  await chatEvidence(page, 'observe-live-recovered');
  assert.deepEqual(harness.commandPosts, [], 'Observing must not silently take classroom control');
  assert.deepEqual(harness.coverageMutationRequests, []);
  assert.deepEqual(harness.pageErrors, []);
});

test('Observe selection stays scoped when a refresh removes the observed class', { timeout: 60_000 }, async context => {
  const { browser, baseURL } = await assignedTestingBrowser(context);
  const page = await browser.newPage();
  await page.clock.install();
  const own = teachingSession();
  const observed = teachingSession({ id: OBSERVED_SESSION_ID, groupId: OBSERVED_GROUP_ID, teacherId: OTHER_TEACHER_ID });
  const aggregate = aggregateController({ scoped: success([student()]) });
  const harness = await configureDashboard(page, {
    activeSession: own, allSessions: [own, observed], aggregate, acknowledgeSessionSubscriptions: true,
  });
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId('select-admin-observe').selectOption(OBSERVED_SESSION_ID);
  await page.getByTestId('observe-read-only-banner').waitFor();
  await waitUntil(() => harness.websocketMessages.some(message => message.type === 'subscribe-session'
    && message.sessionId === OBSERVED_SESSION_ID), 'Observe starts on the selected live class');
  const previousReads = harness.sessionRequests.filter(pathname => pathname === '/api/sessions/all').length;
  const requestStart = aggregate.requests.length;
  harness.setAllSessions([own]);
  await page.clock.fastForward(10_100);
  await waitUntil(() => harness.sessionRequests.filter(pathname => pathname === '/api/sessions/all').length > previousReads,
    'The observer reconciles the active class list');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await page.getByTestId('observe-read-only-banner').count(), 1,
    'Removing the observed session must not silently switch into the administrator-owned class');
  assert.equal(await page.getByTestId('teacher-fab').count(), 0);
  assert.ok(aggregate.requests.slice(requestStart).every(request => request.teachingSessionId === OBSERVED_SESSION_ID),
    'An unavailable Observe selection must never become an own-class or school-wide read');
  assert.equal(await page.getByTestId('select-admin-observe').inputValue(), OBSERVED_SESSION_ID);
  harness.setAllSessions([]);
  const emptyListReads = harness.sessionRequests.filter(pathname => pathname === '/api/sessions/all').length;
  await page.clock.fastForward(10_100);
  await waitUntil(() => harness.sessionRequests.filter(pathname => pathname === '/api/sessions/all').length > emptyListReads,
    'The empty class list is reconciled');
  await page.getByTestId('select-admin-observe').selectOption('');
  await page.getByTestId('observe-read-only-banner').waitFor({ state: 'hidden' });
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
});
