import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

// Apply Flight Path, Apply Block List and toolbar Manage Tabs freeze their
// recipients when they open, and a selection the Dashboard clears by itself
// (a ticked device stops reporting, a session changes, the supervision groups
// shown change, including when that switches between the Class and Claimed
// views) is refused rather than widened to the subgroup, class or every
// claimed student. Before this, a ticked student who went stale lost the tick
// and these actions went to every other reporting student instead. A
// scheduled boundary, which resets the selection on purpose, is not a loss,
// and neither a class session starting or ending nor releasing another
// student touches the Claimed view's ticks. Class tools' announce button and
// footer never name a target the Send Message dialog would refuse: not while
// such a loss stands, and not while a student is ticked for sign-out only.
//
// The fixture is deliberately lean: one Vite server (port 0, pid-suffixed
// cacheDir, so it can share a runner with the other shard-2 suites) and one
// browser for the file, and only the API routes the Dashboard reads.

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(APP_ROOT, 'node_modules', `.vite-recipient-freeze-${process.pid}`);
const SCHOOL_ID = '11111111-1111-4111-8111-111111111111';
const TEACHER_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';
const ADA = '88888888-8888-4888-8888-888888888888';
const BEN = '99999999-9999-4999-8999-999999999999';
const CY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FLIGHT_PATH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BLOCK_LIST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LIBRARY_CONTEXT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GYM_CONTEXT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NAMES = { [ADA]: 'Ada Student', [BEN]: 'Ben Student', [CY]: 'Cy Student' };
const CONTEXT_NAMES = { [LIBRARY_CONTEXT_ID]: 'Library', [GYM_CONTEXT_ID]: 'Gym' };
const COVERAGE_COMMANDS = ['open-tab', 'close-tabs', 'lock-screen', 'unlock-screen', 'teacher-message', 'apply-flight-path', 'remove-flight-path', 'apply-block-list', 'remove-block-list'];
// Past the 60-second signal window: the Dashboard stops counting the student
// as reporting and clears their tick.
const STALE_MS = 70_000;
// A scheduled assignment keeps its times across reads; in the boundary test
// only its authority revision changes.
const SCHEDULED_STARTS_AT = new Date(Date.now() - 600_000).toISOString();
const SCHEDULED_ENDS_AT = new Date(Date.now() + 3_600_000).toISOString();

const session = {
  id: SESSION_ID, schoolId: SCHOOL_ID, groupId: GROUP_ID, teacherId: TEACHER_ID,
  startTime: '2026-10-01T13:00:00.000Z', sessionMode: 'live', endTime: null,
  rosterSnapshotCompletedAt: '2026-10-01T13:00:00.000Z', lifecycle: { kind: 'manual', state: 'active' },
  summaryTrigger: 'manual_end', summaryExpectedAt: null,
};

let vite;
let browser;
let baseURL;

before(async () => {
  vite = await createServer({ cacheDir: CACHE_DIR, root: APP_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: process.env.CLASSPILOT_CHAT_BASELINE_SOURCE ? [{ name: 'recipient-release-baseline', enforce: 'pre', load(id) { if (id.replaceAll('\\', '/').split('?')[0].endsWith('/src/products/classpilot/pages/Dashboard.jsx')) return readFileSync(process.env.CLASSPILOT_CHAT_BASELINE_SOURCE, 'utf8'); } }] : [] });
  await vite.listen();
  baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await vite?.close();
});

// `report.signedOut` is a student who is not signed in; with `lateSignIn` the
// school lets the teacher tick them for restrictions that apply after sign-in.
function rosterRow(studentId, report, { lateSignIn = false } = {}) {
  const firstName = NAMES[studentId].split(' ')[0].toLowerCase();
  const observedAt = new Date(report.at).toISOString();
  const signedOut = report.signedOut === true;
  return {
    studentId, studentName: NAMES[studentId], studentEmail: `${firstName}@example.edu`,
    status: signedOut ? 'offline' : 'online', loginState: signedOut ? 'not_logged_in' : 'logged_in',
    isLoggedIn: !signedOut, commandable: !signedOut,
    monitoringState: 'healthy', activityState: signedOut ? 'off' : 'active',
    activeTabTitle: `${NAMES[studentId]} notes`, activeTabUrl: `https://classroom.example.edu/${firstName}`,
    allOpenTabs: signedOut ? [] : [{ tabRef: `tab-${firstName}`, url: `https://classroom.example.edu/${firstName}`, title: `${NAMES[studentId]} notes` }],
    tabSnapshotRevision: 1,
    lastSeenAt: observedAt, realtimeObservedAt: signedOut ? null : observedAt,
    realtimeBinding: signedOut ? null : `binding-${firstName}`, realtimeRevision: signedOut ? null : report.revision,
    ...(lateSignIn ? { lateSignInRestrictionSsoV1Enabled: true } : {}),
  };
}

// The supervision summary and roster for the Claimed view: `claimed` maps a
// supervision context id to its students.
function supervisionSummary(claimed) {
  const contexts = Object.entries(claimed);
  return {
    revision: contexts.map(([contextId, ids]) => `${contextId}:${ids.join(',')}`).join(';') || 'empty',
    schoolId: SCHOOL_ID, viewerId: TEACHER_ID, availableStudentCount: 0,
    claimedStudentCount: contexts.reduce((total, [, ids]) => total + ids.length, 0),
    activeContextCount: contexts.length,
    ownSupervisionContexts: contexts.map(([contextId, ids]) => ({
      id: contextId, name: CONTEXT_NAMES[contextId], contextType: 'supervision_group',
      startsAt: new Date(Date.now() - 600_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      activeStudentCount: ids.length, assignedStaffId: TEACHER_ID,
    })),
  };
}

function claimedRow(studentId, contextId) {
  return {
    ...rosterRow(studentId, { at: Date.now(), revision: 1 }),
    contextId, contextName: CONTEXT_NAMES[contextId], supervisionState: 'claimed',
    assignedStaff: { id: TEACHER_ID, displayName: 'Tess Teacher' },
  };
}

function commandResponse(body, id) {
  const targetStudentIds = body.targetStudentIds || [];
  return {
    command: { id, commandType: body.commandType, targets: targetStudentIds.map((studentId) => ({ studentId, status: 'sent' })) },
    summary: { requested: targetStudentIds.length, attempted: targetStudentIds.length, pending: targetStudentIds.length },
  };
}

// A scheduled supervision (testing) assigned to the teacher; `revision` is its
// authority revision.
function scheduledActivity({ revision }) {
  const current = {
    id: LIBRARY_CONTEXT_ID, source: 'scheduled_testing', name: 'Reading MAP', teacherId: TEACHER_ID,
    startsAt: SCHEDULED_STARTS_AT, endsAt: SCHEDULED_ENDS_AT, status: 'active', studentCount: 2,
    authority: { supervisionContextId: LIBRARY_CONTEXT_ID }, contextAuthorityRevision: revision,
    capabilities: { commands: COVERAGE_COMMANDS, fab: false, chat: false, raiseHand: false, polls: false, timers: false, liveView: false, screenshots: true, settings: false },
  };
  return {
    enabled: true, schoolId: SCHOOL_ID, viewerId: TEACHER_ID, revision: `${current.id}:${revision}`, serverTime: new Date().toISOString(),
    current, activities: [current], next: null, nextBoundaryAt: current.endsAt,
  };
}

// The class Dashboard; with `claimed` (supervision context id -> student ids,
// which a test changes in place) the Claimed view, shown automatically while
// it has a group; with `scheduled` ({ revision }) a scheduled supervision
// instead of a class.
async function classPage(studentIds, { signedOut = [], lateSignIn = false, claimed = null, scheduled = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const reports = Object.fromEntries(studentIds.map((studentId) => [studentId, { at: Date.now(), revision: 1, signedOut: signedOut.includes(studentId) }]));
  const commands = [];
  const claimedCommands = [];
  const releases = [];
  const rosterRevisions = [];
  const pageErrors = [];
  // The teacher's class session; a test can end it and start it again.
  const state = { classSession: scheduled ? null : session, sessionReads: 0, socket: null };
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript((schoolId) => window.localStorage.setItem('sp_activeSchoolId', schoolId), SCHOOL_ID);
  await page.routeWebSocket('**/ws', (socket) => {
    state.socket = socket;
    socket.onMessage((message) => {
      const parsed = JSON.parse(message);
      if (parsed.type === 'auth') socket.send(JSON.stringify({ type: 'auth-success' }));
      if (parsed.type === 'subscribe-session') {
        socket.send(JSON.stringify({ type: 'session-subscription-success', sessionId: parsed.sessionId, teachingSessionId: parsed.sessionId, requestId: parsed.requestId }));
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (request.method() === 'POST' && pathname === '/api/commands') {
      const body = request.postDataJSON();
      commands.push(body);
      return json(commandResponse(body, `command-${commands.length}`), 201);
    }
    const claimedCommand = request.method() === 'POST' && pathname.match(/^\/api\/coverage\/contexts\/([^/]+)\/commands$/);
    if (claimedCommand) {
      const body = request.postDataJSON();
      claimedCommands.push({ contextId: claimedCommand[1], ...body });
      return json(commandResponse(body, `claimed-command-${claimedCommands.length}`), 201);
    }
    // "Release student": the student leaves the group, and a group left empty ends.
    const release = request.method() === 'POST' && pathname.match(/^\/api\/coverage\/contexts\/([^/]+)\/release$/);
    if (release) {
      const contextId = release[1];
      const { studentIds: released } = request.postDataJSON();
      releases.push({ contextId, studentIds: released });
      claimed[contextId] = (claimed[contextId] || []).filter((studentId) => !released.includes(studentId));
      if (claimed[contextId].length === 0) delete claimed[contextId];
      return json({ releasedCount: released.length });
    }
    switch (pathname) {
      case '/api/auth/me': return json({
        user: { id: TEACHER_ID, email: 'teacher@example.edu', firstName: 'Tess', lastName: 'Teacher', isSuperAdmin: false },
        token: 'recipient-freeze-token', activeSchoolId: SCHOOL_ID,
        licenses: { classPilot: true, passPilot: false, goPilot: false },
        memberships: [{ id: 'membership', schoolId: SCHOOL_ID, schoolName: 'Recipient School', schoolTimezone: 'America/New_York', role: 'teacher' }],
      });
      case '/api/auth/csrf': return json({ csrfToken: 'recipient-freeze-csrf' });
      case '/api/settings': return json({ settings: { activeSessionId: state.classSession?.id ?? null, handRaisingEnabled: true, studentMessagingEnabled: true, sessionFabRevision: 1, blockedDomains: [] } });
      case '/api/classpilot/dashboard-activity': return json(scheduled ? scheduledActivity(scheduled) : { enabled: false, schoolId: SCHOOL_ID, viewerId: TEACHER_ID });
      case '/api/flight-paths': return json({ flightPaths: [{ id: FLIGHT_PATH_ID, flightPathName: 'Reading sites', description: '', allowedDomains: ['reading.example.edu'] }] });
      case '/api/block-lists': return json({ blockLists: [{ id: BLOCK_LIST_ID, name: 'Games', description: '', blockedDomains: ['games.example.com'] }] });
      case '/api/sessions/active':
        state.sessionReads += 1;
        return json({ session: state.classSession });
      case '/api/sessions/all': return json({ sessions: state.classSession ? [state.classSession] : [] });
      case '/api/teacher/groups': return json({ groups: [{ id: GROUP_ID, name: 'Algebra', teacherId: TEACHER_ID }] });
      case '/api/coverage/summary': return json(claimed
        ? supervisionSummary(claimed)
        : { activeContextCount: 0, availableStudentCount: 0, claimedStudentCount: 0, schoolId: SCHOOL_ID, viewerId: TEACHER_ID, ownTestingContexts: [] });
      case '/api/coverage/capabilities': return json({ commandTypes: claimed ? COVERAGE_COMMANDS : [] });
      case '/api/coverage/claimed-students': return json({ students: claimed
        ? Object.entries(claimed).flatMap(([contextId, ids]) => ids.map((studentId) => claimedRow(studentId, contextId)))
        : [] });
      case '/api/coverage/available-students': return json({ students: [] });
      case '/api/students-aggregated':
        rosterRevisions.push(request.headers()['x-classpilot-context-authority-revision'] ?? null);
        return json(Object.entries(reports).map(([studentId, report]) => ({
          ...rosterRow(studentId, report, { lateSignIn }),
          ...(scheduled ? { acceptedCapabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: true } } : {}),
        })));
      case '/api/commands/active-state': return json({ states: [] });
      case '/api/teacher/raised-hands': return json({ raisedHands: [] });
      case '/api/teacher/messages': return json({ messages: [] });
      case '/api/classpilot/tiles/screenshots':
      case '/api/classpilot/tiles/history': return json({ tiles: [] });
      default:
        if (/^\/api\/groups\/[^/]+\/subgroups$/.test(pathname)) return json({ subgroups: [] });
        if (/^\/api\/groups\/[^/]+\/students$/.test(pathname)) return json({ students: studentIds.map((id) => ({ id })) });
        if (pathname.endsWith('/observation-lease')) return json({ renewAfterSeconds: 30 });
        return json({});
    }
  });

  const invalidate = (queryKey) => page.evaluate(async (key) => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    await queryClient.invalidateQueries({ queryKey: key });
  }, queryKey);
  // Re-read the class with `fresh` students observed now and `stale` ones
  // observed past the signal window; `signIn` students have signed in.
  const report = async ({ fresh = [], stale = [], signIn = [] }) => {
    for (const studentId of signIn) reports[studentId] = { ...reports[studentId], signedOut: false };
    for (const studentId of [...fresh, ...signIn]) reports[studentId] = { ...reports[studentId], at: Date.now(), revision: reports[studentId].revision + 1 };
    for (const studentId of stale) reports[studentId] = { ...reports[studentId], at: Date.now() - STALE_MS, revision: reports[studentId].revision + 1 };
    await invalidate(['/api/students-aggregated']);
  };
  // A student signs out: the server says so over the socket, for the binding
  // the class shows, and later roster reads agree.
  const signOut = (studentId) => {
    const revision = reports[studentId].revision + 1;
    reports[studentId] = { ...reports[studentId], signedOut: true, at: Date.now(), revision };
    state.socket.send(JSON.stringify({
      type: 'student-signed-out', schoolId: SCHOOL_ID, teachingSessionId: SESSION_ID, studentId,
      realtimeBinding: `binding-${NAMES[studentId].split(' ')[0].toLowerCase()}`, revision, realtimeObservedAt: new Date().toISOString(),
    }));
  };
  const tick = async (studentId) => {
    await page.getByTestId(`checkbox-select-student-${studentId}`).click();
    await waitForTick(page, studentId, 'checked');
  };
  // The supervision groups were changed in `claimed`: the Dashboard reads them again.
  const refreshSupervision = () => invalidate(['/api/coverage/summary']);
  // End or start the teacher's class session, and wait until the Dashboard has
  // read it and rendered the result.
  const setClassSession = async (active) => {
    state.classSession = active ? session : null;
    const reads = state.sessionReads;
    await invalidate(['/api/sessions/active']);
    await waitUntil(() => state.sessionReads > reads, 'the class session is read again');
    await settle(page);
  };

  await page.goto(`${baseURL}/classpilot`);
  const fixture = { page, commands, claimedCommands, releases, rosterRevisions, pageErrors, report, signOut, tick, refreshSupervision, setClassSession };
  const claimedIds = claimed ? Object.values(claimed).flat() : [];
  if (claimedIds.length > 0) {
    for (const studentId of claimedIds) await page.getByTestId(`card-student-${studentId}`).waitFor();
    return fixture;
  }
  for (const studentId of studentIds) await page.getByTestId(`card-student-${studentId}`).waitFor();
  // However long the page took to load, every signed-in student is reporting now.
  const reporting = studentIds.filter((studentId) => !signedOut.includes(studentId));
  await report({ fresh: reporting });
  await page.waitForFunction((ids) => ids.every((id) => (
    document.querySelector(`[data-testid="card-student-${id}"]`)
    && !document.querySelector(`[data-testid="preview-unavailable-${id}"]`)
  )), reporting);
  return fixture;
}

function waitForTick(page, studentId, state) {
  return page.waitForFunction(([id, expected]) => (
    document.querySelector(`[data-testid="checkbox-select-student-${id}"]`)?.getAttribute('data-state') === expected
  ), [studentId, state]);
}

function waitForText(page, testId, expected) {
  return page.waitForFunction(([id, text]) => document.querySelector(`[data-testid="${id}"]`)?.textContent === text, [testId, expected]);
}

function activeTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName || null);
}

async function settle(page) {
  await page.waitForTimeout(300);
}

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

// A toast, not the inline selection-lost notice that can carry the same words.
function toastText(page, text) {
  return page.getByRole('region', { name: /Notifications/ }).getByText(text, { exact: true }).first();
}

const LOST_ADA = 'Your selection was cleared because 1 selected student stopped reporting.';

test('Apply Flight Path keeps its frozen recipient, and a lost selection is refused until the teacher chooses the whole class', { timeout: 120_000 }, async () => {
  const { page, commands, pageErrors, report, tick } = await classPage([ADA, BEN]);
  await tick(ADA);
  await page.getByTestId('button-apply-flight-path').click();
  await page.getByTestId('dialog-apply-flight-path').waitFor();
  await page.getByTestId('select-flight-path').click();
  await page.getByTestId(`option-flight-path-${FLIGHT_PATH_ID}`).click();

  // Ada stops reporting while the dialog is open; the Dashboard clears her tick.
  await report({ fresh: [BEN], stale: [ADA] });
  await waitForTick(page, ADA, 'unchecked');
  await page.getByTestId('button-confirm-apply-flight-path').click();
  await settle(page);
  assert.deepEqual(commands, [], 'a Flight Path for Ada is never re-targeted to the students still reporting');

  await waitForText(page, 'command-recipients-unavailable', "Ada Student can't receive this right now. Nothing was sent.");
  assert.equal(await page.getByTestId('dialog-apply-flight-path').getByTestId('command-recipients-summary').innerText(), 'Send to 1 selected student');
  assert.deepEqual(await page.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ["Ada Student · can't receive right now"]);
  await page.getByTestId('button-cancel-apply-flight-path').click();
  await page.getByTestId('dialog-apply-flight-path').waitFor({ state: 'hidden' });

  // The emptied selection is named, and the one-click and dialog actions refuse it.
  await waitForText(page, 'selection-lost-message', `${LOST_ADA} Choose students again, or use the whole class.`);
  assert.match(await page.getByTestId('badge-selection-count').innerText(), /Selection cleared · choose students again/);
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
  await toastText(page, `${LOST_ADA} Nothing was sent. Choose students again, or use the whole class.`).waitFor();
  await page.getByTestId('button-apply-block-list').click();
  await toastText(page, `${LOST_ADA} Choose students again, or use the whole class.`).waitFor();
  await settle(page);
  assert.equal(await page.getByTestId('dialog-apply-block-list').count(), 0, 'a dialog does not open for a lost selection');
  assert.deepEqual(commands, [], 'nothing is sent while the selection is lost');

  // "Choose again" only moves focus to a student the teacher can tick; it does
  // not turn the class fallback back on.
  await page.getByTestId('button-selection-lost-choose-again').click();
  const focusedAfterChooseAgain = await activeTestId(page);
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
  await settle(page);
  assert.deepEqual(commands, [], '"Choose again" alone never sends to the whole class');
  assert.equal(await page.getByTestId('selection-lost-notice').count(), 1, 'the notice stays until the teacher chooses');
  assert.equal(focusedAfterChooseAgain, `checkbox-select-student-${BEN}`, 'focus moved to the first student who can be ticked');

  // Choosing the whole class explicitly allows a class-wide send, as explicit students.
  await page.getByTestId('button-selection-lost-use-all').click();
  await page.getByTestId('selection-lost-notice').waitFor({ state: 'detached' });
  assert.equal(await activeTestId(page), 'badge-selection-count', 'focus moves to the target, not the page');
  await report({ fresh: [BEN] });
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
  await waitUntil(() => commands.length > 0, 'the whole-class removal is sent');
  await settle(page);
  assert.equal(commands.length, 1, 'the whole-class removal is sent once');
  assert.equal(commands[0].commandType, 'remove-flight-path');
  assert.equal(commands[0].teachingSessionId, SESSION_ID);
  assert.equal(commands[0].targetScope, 'students', 'a class-wide removal still names its students');
  assert.deepEqual(commands[0].targetStudentIds, [BEN], 'only students who can receive it now');
  assert.deepEqual(commands[0].commandPayload, {});
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('toolbar Manage Tabs closes tabs only for its frozen recipients', { timeout: 120_000 }, async () => {
  const { page, commands, pageErrors, report, tick } = await classPage([ADA, BEN, CY]);
  await tick(ADA);
  await tick(BEN);
  await page.getByTestId('button-tabs').click();
  const dialog = page.getByTestId('dialog-tabs');
  await dialog.waitFor();
  assert.equal(await dialog.getByTestId('command-recipients-summary').innerText(), 'Send to 2 selected students');
  await dialog.getByTestId(`tab-row-${ADA}-tab-ada`).waitFor();
  await dialog.getByTestId(`tab-row-${BEN}-tab-ben`).waitFor();

  // Both ticked students stop reporting: the selection is emptied, but the
  // dialog never starts listing (or closing) the rest of the class.
  await report({ fresh: [CY], stale: [ADA, BEN] });
  await waitForTick(page, BEN, 'unchecked');
  await dialog.getByTestId(`tab-row-${ADA}-tab-ada`).waitFor({ state: 'detached' });
  await settle(page);
  assert.equal(await dialog.getByTestId(`tab-row-${CY}-tab-cy`).count(), 0, "Cy's tabs are never offered");
  assert.equal(await dialog.getByTestId('button-close-all-tabs').count(), 0, 'no bulk close for students who cannot receive it');

  // Ben reports again: he is back on the frozen list, Ada is named, and the
  // bulk close needs a separate "Send to 1 available".
  await report({ fresh: [BEN, CY] });
  await dialog.getByTestId(`tab-row-${BEN}-tab-ben`).waitFor();
  await dialog.getByTestId('button-close-all-tabs').click();
  await waitForText(page, 'command-recipients-unavailable', `Ada Student can't receive this right now. Choose "Send to 1 available" to send without them.`);
  await waitForText(page, 'button-close-all-tabs', 'Send to 1 available');
  assert.deepEqual(commands, [], 'losing a recipient needs a second, explicit close');
  await dialog.getByTestId('button-close-all-tabs').click();
  await waitUntil(() => commands.length > 0, 'the confirmed bulk close is sent');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].commandType, 'close-tabs');
  assert.equal(commands[0].targetScope, 'students');
  assert.deepEqual(commands[0].targetStudentIds, [BEN], 'never Cy, who was not on the list');
  assert.deepEqual(commands[0].commandPayload, { closeAll: true });
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('a new supervision group never turns ticked claimed students into every claimed student', { timeout: 120_000 }, async () => {
  const claimed = { [LIBRARY_CONTEXT_ID]: [ADA, BEN] };
  const { page, claimedCommands, commands, pageErrors, tick } = await classPage([], { claimed });
  await tick(ADA);

  // A second group is assigned while Ada is ticked. The Dashboard clears the
  // ticks when the groups it shows change; that must not mean "everyone".
  claimed[GYM_CONTEXT_ID] = [CY];
  await page.evaluate(async () => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    await queryClient.invalidateQueries({ queryKey: ['/api/coverage/summary'] });
  });
  await page.getByTestId(`card-student-${CY}`).waitFor();
  await waitForTick(page, ADA, 'unchecked');
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
  await settle(page);
  assert.deepEqual(claimedCommands, [], 'Remove Flight Path never goes to every claimed student');
  const lost = 'Your selection was cleared because your supervision groups changed.';
  await toastText(page, `${lost} Nothing was sent. Choose students again, or use all claimed students.`).waitFor();
  await waitForText(page, 'selection-lost-message', `${lost} Choose students again, or use all claimed students.`);
  assert.match(await page.getByTestId('badge-selection-count').innerText(), /Selection cleared · choose students again/);

  // Choosing all claimed students explicitly sends to each of them by name.
  await page.getByTestId('button-selection-lost-use-all').click();
  await page.getByTestId('selection-lost-notice').waitFor({ state: 'detached' });
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
  await waitUntil(() => claimedCommands.length === 2, 'one removal per supervision group');
  await settle(page);
  assert.deepEqual(
    claimedCommands.map(({ contextId, commandType, targetScope, targetStudentIds }) => ({ contextId, commandType, targetScope, targetStudentIds: [...targetStudentIds].sort() }))
      .sort((left, right) => left.contextId.localeCompare(right.contextId)),
    [
      { contextId: LIBRARY_CONTEXT_ID, commandType: 'remove-flight-path', targetScope: 'students', targetStudentIds: [ADA, BEN].sort() },
      { contextId: GYM_CONTEXT_ID, commandType: 'remove-flight-path', targetScope: 'students', targetStudentIds: [CY] },
    ].sort((left, right) => left.contextId.localeCompare(right.contextId)),
  );
  assert.deepEqual(commands, [], 'nothing goes through the class command route');
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('a signed-out student ticked for restrictions after sign-in keeps the tick until they sign in', { timeout: 120_000 }, async () => {
  const { page, commands, pageErrors, report, tick } = await classPage([ADA, CY], { signedOut: [CY], lateSignIn: true });
  assert.equal(await page.getByTestId(`checkbox-select-student-${CY}`).getAttribute('title'), 'Select for restrictions that will apply after sign-in');
  await tick(CY);
  assert.match(await page.getByTestId('badge-selection-count').innerText(), /1 selected restriction-eligible student · 1 signed out/);

  // Other students keep reporting. Cy never reports while signed out, and
  // that is not a lost selection.
  for (let heartbeat = 0; heartbeat < 2; heartbeat += 1) {
    await report({ fresh: [ADA] });
    await settle(page);
  }
  assert.equal(await page.getByTestId(`checkbox-select-student-${CY}`).getAttribute('data-state'), 'checked', 'the deferred-restriction tick is kept');
  assert.equal(await page.getByTestId('selection-lost-notice').count(), 0, 'no selection-lost notice for a student who is simply signed out');

  // Cy signs in: the deferred tick has no sign-in binding and is cleared. The
  // Dashboard says why and refuses the class fallback.
  await report({ signIn: [CY] });
  await waitForTick(page, CY, 'unchecked');
  const lost = 'Your selection was cleared because the session changed for 1 selected student.';
  await waitForText(page, 'selection-lost-message', `${lost} Choose students again, or use the whole class.`);
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
  await toastText(page, `${lost} Nothing was sent. Choose students again, or use the whole class.`).waitFor();
  await settle(page);
  assert.deepEqual(commands, [], 'Remove Flight Path is never widened to Ada');
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('a scheduled boundary resets the ticks without reporting a lost selection', { timeout: 120_000 }, async () => {
  const scheduled = { revision: '1' };
  const { page, pageErrors, rosterRevisions, tick } = await classPage([ADA, BEN], { scheduled });
  await tick(ADA);
  await tick(BEN);

  // The same supervision gets a new authority revision. That is a boundary:
  // the Dashboard starts over (the ticks go) while the roster reloads, and no
  // student "stopped reporting".
  scheduled.revision = '2';
  await page.evaluate(async () => {
    const { queryClient } = await import('/src/lib/queryClient.js');
    await queryClient.invalidateQueries({ queryKey: ['/api/classpilot/dashboard-activity'] });
  });
  await waitForTick(page, ADA, 'unchecked');
  await waitUntil(() => rosterRevisions.includes('2'), 'the roster is read again for the new revision');
  await page.getByTestId(`card-student-${BEN}`).waitFor();
  await settle(page);
  await settle(page);
  assert.deepEqual(await page.getByTestId('selection-lost-message').allInnerTexts(), [], 'a boundary is not a lost selection');
  assert.match(await page.getByTestId('badge-selection-count').innerText(), /All 2 students/);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

const GROUPS_CHANGED = 'Your selection was cleared because your supervision groups changed.';

function removalTargets(claimedCommands) {
  return claimedCommands.map(({ contextId, commandType, targetScope, targetStudentIds }) => ({ contextId, commandType, targetScope, targetStudentIds }));
}

async function removeFlightPath(page) {
  await page.getByTestId('button-flight-path-menu').click();
  await page.getByTestId('button-remove-flight-path').click();
}

test('an automatic switch between Class and Claimed is a lost selection, never the new view\'s whole cohort', { timeout: 120_000 }, async () => {
  const claimed = {};
  const { page, commands, claimedCommands, pageErrors, tick, refreshSupervision } = await classPage([ADA, BEN], { claimed });
  await tick(ADA);

  // A supervision group is assigned while Ada is ticked in the class: with no
  // view picked, the Dashboard switches to Claimed by itself.
  claimed[LIBRARY_CONTEXT_ID] = [CY];
  await refreshSupervision();
  await page.getByTestId(`card-student-${CY}`).waitFor();
  await waitForText(page, 'selection-lost-message', `${GROUPS_CHANGED} Choose students again, or use all claimed students.`);
  await removeFlightPath(page);
  await toastText(page, `${GROUPS_CHANGED} Nothing was sent. Choose students again, or use all claimed students.`).waitFor();
  await settle(page);
  assert.deepEqual(claimedCommands, [], 'Ada\'s removal never goes to Cy instead');

  // The teacher ticks Cy. The group then ends and the Dashboard switches back
  // to the class by itself: Cy's removal never goes to the whole class.
  await tick(CY);
  assert.equal(await page.getByTestId('selection-lost-notice').count(), 0, 'ticking a student is choosing again');
  delete claimed[LIBRARY_CONTEXT_ID];
  await refreshSupervision();
  await page.getByTestId(`card-student-${ADA}`).waitFor();
  await waitForText(page, 'selection-lost-message', `${GROUPS_CHANGED} Choose students again, or use the whole class.`);
  await removeFlightPath(page);
  await toastText(page, `${GROUPS_CHANGED} Nothing was sent. Choose students again, or use the whole class.`).waitFor();
  await settle(page);
  assert.deepEqual(commands, [], 'never the whole class');
  assert.deepEqual(claimedCommands, []);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('a class session starting or ending keeps the Claimed view\'s ticks, and a lost selection stays lost', { timeout: 120_000 }, async () => {
  const claimed = { [LIBRARY_CONTEXT_ID]: [ADA, BEN], [GYM_CONTEXT_ID]: [CY] };
  const { page, commands, claimedCommands, pageErrors, tick, refreshSupervision, setClassSession } = await classPage([], { claimed });
  await tick(ADA);

  // Claimed students are commanded through their own groups, so the class
  // session ending changes nothing about who Remove Flight Path reaches.
  await setClassSession(false);
  assert.equal(await page.getByTestId(`checkbox-select-student-${ADA}`).getAttribute('data-state'), 'checked', 'the class session ending keeps Ada ticked');
  await removeFlightPath(page);
  await waitUntil(() => claimedCommands.length > 0, 'the removal is sent');
  await settle(page);
  assert.deepEqual(removalTargets(claimedCommands), [
    { contextId: LIBRARY_CONTEXT_ID, commandType: 'remove-flight-path', targetScope: 'students', targetStudentIds: [ADA] },
  ], 'only Ada, never every claimed student');
  await setClassSession(true);
  assert.equal(await page.getByTestId(`checkbox-select-student-${ADA}`).getAttribute('data-state'), 'checked', 'a class session starting keeps Ada ticked');

  // The Gym group ends: Ada's tick is cleared and recorded. The class session
  // ending after that does not forget the loss.
  delete claimed[GYM_CONTEXT_ID];
  await refreshSupervision();
  await page.getByTestId(`card-student-${CY}`).waitFor({ state: 'detached' });
  await waitForTick(page, ADA, 'unchecked');
  await waitForText(page, 'selection-lost-message', `${GROUPS_CHANGED} Choose students again, or use all claimed students.`);
  await setClassSession(false);
  await waitForText(page, 'selection-lost-message', `${GROUPS_CHANGED} Choose students again, or use all claimed students.`);
  await removeFlightPath(page);
  await toastText(page, `${GROUPS_CHANGED} Nothing was sent. Choose students again, or use all claimed students.`).waitFor();
  await settle(page);
  assert.equal(claimedCommands.length, 1, 'nothing more is sent while the selection is lost');
  assert.deepEqual(commands, []);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('releasing a claimed student unticks only that student', { timeout: 120_000 }, async () => {
  const claimed = { [LIBRARY_CONTEXT_ID]: [ADA, BEN], [GYM_CONTEXT_ID]: [CY] };
  const { page, commands, claimedCommands, releases, pageErrors, tick } = await classPage([], { claimed });
  await tick(ADA);

  // Ben, who is not ticked, is released: Ada stays ticked and stays the target.
  await page.getByTestId(`button-release-student-${BEN}`).click();
  await page.getByTestId(`card-student-${BEN}`).waitFor({ state: 'detached' });
  assert.deepEqual(releases, [{ contextId: LIBRARY_CONTEXT_ID, studentIds: [BEN] }]);
  await waitForTick(page, ADA, 'checked');
  await removeFlightPath(page);
  await waitUntil(() => claimedCommands.length > 0, 'the removal is sent');
  await settle(page);
  assert.deepEqual(removalTargets(claimedCommands), [
    { contextId: LIBRARY_CONTEXT_ID, commandType: 'remove-flight-path', targetScope: 'students', targetStudentIds: [ADA] },
  ], 'releasing Ben never makes the removal reach Cy');

  // Releasing Cy ends the Gym group: the groups shown change, so Ada's tick is
  // cleared and recorded, and the next removal is refused.
  await page.getByTestId(`button-release-student-${CY}`).click();
  await page.getByTestId(`card-student-${CY}`).waitFor({ state: 'detached' });
  await waitForTick(page, ADA, 'unchecked');
  await waitForText(page, 'selection-lost-message', `${GROUPS_CHANGED} Choose students again, or use all claimed students.`);
  await removeFlightPath(page);
  await toastText(page, `${GROUPS_CHANGED} Nothing was sent. Choose students again, or use all claimed students.`).waitFor();
  await settle(page);
  assert.equal(claimedCommands.length, 1, 'nothing more is sent while the selection is lost');
  assert.deepEqual(commands, []);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('a ticked student who signs out is named as having stopped reporting', { timeout: 120_000 }, async () => {
  const { page, commands, pageErrors, signOut, tick } = await classPage([ADA, BEN]);
  await tick(ADA);
  // Signing out both stops Ada's reports and ends her session; the notice
  // keeps the first cause rather than dropping it.
  signOut(ADA);
  await waitForTick(page, ADA, 'unchecked');
  await waitForText(page, 'selection-lost-message', `${LOST_ADA} Choose students again, or use the whole class.`);
  await removeFlightPath(page);
  await toastText(page, `${LOST_ADA} Nothing was sent. Choose students again, or use the whole class.`).waitFor();
  await settle(page);
  assert.deepEqual(commands, [], 'never the students still signed in');
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('Class tools never names the class a lost selection refuses: the announce button and footer say so, and the announce click explains', { timeout: 120_000 }, async () => {
  const { page, commands, pageErrors, report, tick } = await classPage([ADA, BEN]);
  await tick(ADA);
  await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByTestId('chat-open').click();
  const broadcast = page.getByTestId('chat-broadcast');
  const footer = page.getByTestId('class-tools-panel').locator('footer');
  await broadcast.getByText('Message 1 selected student', { exact: true }).waitFor();
  assert.equal(await footer.innerText(), 'New actions for 1 selected student. Active tools keep their original recipients.');

  // Ada stops reporting and the Dashboard clears her tick: neither the
  // announce button nor the footer may fall back to naming the class.
  await report({ fresh: [BEN], stale: [ADA] });
  await waitForTick(page, ADA, 'unchecked');
  const cleared = 'Selection cleared · choose students again';
  await broadcast.getByText(cleared, { exact: true }).waitFor();
  assert.equal(await broadcast.getAttribute('aria-label'), cleared, 'its accessible name says the same');
  assert.match(await page.getByTestId('badge-selection-count').innerText(), new RegExp(cleared), 'as the Target badge does');
  assert.equal(await footer.innerText(), 'New actions for no one until you choose students again. Active tools keep their original recipients.');
  await broadcast.click();
  await toastText(page, `${LOST_ADA} Choose students again, or use the whole class.`).waitFor();
  await settle(page);
  assert.equal(await page.getByTestId('dialog-send-message').count(), 0, 'no dialog opens for a lost selection');
  assert.deepEqual(commands, [], 'nothing is sent');

  // Choosing the whole class names it again.
  await page.getByTestId('button-selection-lost-use-all').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('selection-lost-notice').waitFor({ state: 'detached' });
  await broadcast.getByText('Announce to class', { exact: true }).waitFor();
  assert.equal(await footer.innerText(), 'New actions for all 2 students. Active tools keep their original recipients.');
  assert.deepEqual(commands, []);
  assert.deepEqual(pageErrors, []);
  await page.close();
});

test('Class tools names a sign-out-only selection as the Target badge does, before any other tick or a lost selection, and the announce click explains', { timeout: 120_000 }, async () => {
  const { page, commands, pageErrors, report, tick } = await classPage([ADA, BEN]);
  await tick(ADA);
  // Ben stops reporting but stays signed in: he can be ticked only for
  // Student Sign Out, and while he is every other control refuses, Ada's
  // tick included.
  await report({ fresh: [ADA], stale: [BEN] });
  await page.getByTestId(`preview-unavailable-${BEN}`).waitFor();
  await tick(BEN);
  const badge = page.getByTestId('badge-selection-count');
  assert.match(await badge.innerText(), / · 1 selected for sign-out only\n/);
  await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByTestId('chat-open').click();
  const broadcast = page.getByTestId('chat-broadcast');
  const footer = page.getByTestId('class-tools-panel').locator('footer');
  const signOutOnly = '1 selected for sign-out only';
  const blocked = 'New actions for no one until you clear the sign-out-only selection. Active tools keep their original recipients.';
  await broadcast.getByText(signOutOnly, { exact: true }).waitFor();
  assert.equal(await broadcast.getAttribute('aria-label'), signOutOnly, 'not "Message 1 selected student"');
  assert.equal(await footer.innerText(), blocked);

  // Ada stops reporting and the Dashboard clears her tick, so a lost
  // selection stands too. Ben's tick still comes first, as in the badge.
  await report({ stale: [ADA, BEN] });
  await waitForTick(page, ADA, 'unchecked');
  await waitForText(page, 'selection-lost-message', `${LOST_ADA} Choose students again, or use the whole class.`);
  assert.match(await badge.innerText(), / - 1 selected for sign-out only\n/, 'the badge names the sign-out-only selection');
  assert.equal(await broadcast.getAttribute('aria-label'), signOutOnly, 'and so does the button, not "Selection cleared"');
  assert.equal(await footer.innerText(), blocked);
  await broadcast.click();
  await toastText(page, 'Clear the sign-out-only selection before using other ClassPilot controls.').waitFor();
  await settle(page);
  assert.equal(await page.getByTestId('dialog-send-message').count(), 0, 'no dialog opens for a sign-out-only selection');
  assert.deepEqual(commands, [], 'nothing is sent');

  // Clear Selection clears both, and the class is the target again.
  await page.getByTestId('button-clear-selection').focus();
  await page.keyboard.press('Enter');
  await broadcast.getByText('Announce to class', { exact: true }).waitFor();
  assert.equal(await footer.innerText(), 'New actions for all 2 students. Active tools keep their original recipients.');
  assert.deepEqual(commands, []);
  assert.deepEqual(pageErrors, []);
  await page.close();
});


test('Stop Focus is reachable with every assigned student offline and sends exactly its frozen structural list', { timeout: 60_000 }, async () => {
  const { page, commands, pageErrors, report } = await classPage([ADA, BEN], { signedOut: [ADA, BEN] });
  try {
    await page.getByTestId('button-stop-focus').click();
    const dialog = page.getByTestId('dialog-stop-focus'); await dialog.waitFor();
    assert.deepEqual(await dialog.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ['Ada Student', 'Ben Student']);
    await report({ signIn: [BEN] });
    assert.deepEqual(await dialog.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ['Ada Student', 'Ben Student']);
    await page.getByTestId('button-confirm-stop-focus').click();
    await waitUntil(() => commands.length === 1, 'offline Focus cleanup posts one explicit cohort');
    assert.deepEqual(commands[0].targetStudentIds, [ADA, BEN]);
    assert.equal(commands[0].targetScope, 'students'); assert.equal(commands[0].commandType, 'stop-focus');
    assert.deepEqual(commands[0].commandPayload, {}); assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});

test('Manage Tabs Stop Focus reviews only the named frozen recipients rather than broadening to other offline students', { timeout: 60_000 }, async () => {
  const { page, commands, pageErrors } = await classPage([ADA, BEN, CY], { signedOut: [ADA, BEN] });
  try {
    await page.getByTestId('button-tabs').click(); await page.getByTestId('dialog-tabs').waitFor();
    assert.deepEqual(await page.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ['Cy Student']);
    await page.getByTestId('button-stop-focus-targets').click(); await settle(page);
    assert.deepEqual(commands, [], 'reviewing Stop Focus must not immediately send a different live cohort');
    await page.getByTestId('dialog-stop-focus').waitFor();
    assert.deepEqual(await page.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ['Cy Student']);
    await page.getByTestId('button-confirm-stop-focus').click();
    await waitUntil(() => commands.length === 1, 'the reviewed Focus cleanup posts');
    assert.deepEqual(commands[0].targetStudentIds, [CY]); assert.equal(commands[0].commandType, 'stop-focus');
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});

test('Select All excludes signed-out students while individual saved restriction selection remains available', { timeout: 60_000 }, async () => {
  const { page, commands, pageErrors, tick } = await classPage([ADA, BEN], { signedOut: [ADA], lateSignIn: true });
  try {
    assert.equal(await page.getByTestId('button-select-all-students').innerText(), 'Select All (1)');
    await page.getByTestId('button-select-all-students').click();
    await waitForTick(page, ADA, 'unchecked'); await waitForTick(page, BEN, 'checked');
    assert.equal(await page.getByTestId('button-open-tab').isEnabled(), true);
    await page.getByTestId('button-clear-selection').click(); await tick(ADA);
    assert.equal(await page.getByTestId('button-open-tab').isDisabled(), true);
    assert.equal(await page.getByTestId('button-apply-flight-path').isEnabled(), true);
    assert.deepEqual(commands, []); assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});
