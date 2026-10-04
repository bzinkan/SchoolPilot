import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

// Class tools -> Messages opens on the class roster: the whole class in the
// grid's order, one quiet line per student with presence and an unread count
// and no message text, with Find, "need reply", one Tab stop for the rows,
// read-only threads for students with other staff, and a single pane below
// 640 px, and what a messaging switch turned off elsewhere does to an open
// conversation, a draft, the quick replies and focus (which lands only on the
// open conversation or a note, never on a control that acts by itself or on
// another student, and stays on the page once the teacher put it there). The
// first two browser tests moved here from
// classpilot-dashboard-load-state.test.mjs, release shard 1's long pole, to
// release shard 2. The rest of the Messages coverage (delivery, recovery,
// starting conversations, the class and school switches) stays there.
//
// The fixture is deliberately lean: one Vite server (port 0, pid-suffixed
// cacheDir, so it can share a runner with the other shard-2 suites) and one
// browser for the file, and only the API routes the Dashboard reads for a
// teacher's own live class.

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(APP_ROOT, 'node_modules', `.vite-messages-roster-${process.pid}`);
const SCHOOL_ID = '11111111-1111-4111-8111-111111111111';
const TEACHER_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';
const STUDENT_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_STUDENT_ID = '99999999-9999-4999-8999-999999999999';
const THIRD_STUDENT_ID = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const FOURTH_STUDENT_ID = 'efefefef-efef-4fef-8fef-efefefefefef';
const CHAT_MESSAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAT_REPLY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHAT_MESSAGE_TEXT = 'Synthetic student reply stays in this classroom';
const CHAT_REPLY_TEXT = 'Synthetic teacher response';
const ROSTER_CLOCK = '2026-09-18T14:05:00.000Z';
const ROSTER_ORDER = [SECOND_STUDENT_ID, STUDENT_ID, FOURTH_STUDENT_ID, THIRD_STUDENT_ID];

const session = {
  id: SESSION_ID, schoolId: SCHOOL_ID, groupId: GROUP_ID, teacherId: TEACHER_ID,
  startTime: '2026-08-25T13:00:00.000Z', sessionMode: 'live', endTime: null,
  rosterSnapshotCompletedAt: '2026-08-25T13:00:00.000Z', lifecycle: { kind: 'manual', state: 'active' },
  summaryTrigger: 'manual_end', summaryExpectedAt: null,
};

let vite;
let browser;
let baseURL;

before(async () => {
  vite = await createServer({ cacheDir: CACHE_DIR, root: APP_ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await vite?.close();
});

function student(overrides = {}) {
  return {
    studentId: STUDENT_ID, studentName: 'Ada Student', studentEmail: 'ada@example.edu',
    status: 'online', loginState: 'logged_in', isLoggedIn: true, commandable: true,
    monitoringState: 'healthy', activityState: 'active',
    activeTabTitle: 'Class notes', activeTabUrl: 'https://classroom.example.edu/notes',
    lastSeenAt: '2026-08-25T13:01:00.000Z', realtimeObservedAt: '2026-08-25T13:01:00.000Z',
    realtimeBinding: 'binding-a', realtimeRevision: 1,
    ...overrides,
  };
}

// The class behind the Messages roster: Ada reports now (attendance also marks
// her absent), Ben is signed out, Dee is absent and silent, and Cy is with
// another staff member. Grid and roster order: Adams, Student, Vance, Zed.
function rosterClass() {
  return [
    student({ lastSeenAt: ROSTER_CLOCK, realtimeObservedAt: ROSTER_CLOCK, enforcementHealth: 'synced', fabSyncPending: false,
      classroomState: { schemaVersion: 1, revision: 1, teachingSessionId: SESSION_ID, supervisionContextId: null } }),
    student({ studentId: THIRD_STUDENT_ID, studentName: 'Cy Zed', studentEmail: 'cy@example.edu', realtimeBinding: 'binding-c',
      lastSeenAt: ROSTER_CLOCK, realtimeObservedAt: ROSTER_CLOCK, supervisionState: 'temporary_coverage',
      supervisionContext: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'supervision', name: 'Study Hall',
        assignedStaff: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Morgan Monitor' } } }),
    student({ studentId: SECOND_STUDENT_ID, studentName: 'Ben Adams', studentEmail: 'ben@example.edu', realtimeBinding: 'binding-b',
      status: 'offline', loginState: 'not_logged_in', isLoggedIn: false }),
    student({ studentId: FOURTH_STUDENT_ID, studentName: 'Dee Vance', studentEmail: 'dee@example.edu', realtimeBinding: 'binding-d' }),
  ];
}

function storedChatMessage(overrides = {}) {
  return {
    id: CHAT_MESSAGE_ID, schoolId: SCHOOL_ID, sessionId: SESSION_ID,
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

async function waitUntil(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

// A teacher's own live class on the Dashboard at ROSTER_CLOCK. `absentIds` are
// marked absent in today's attendance. With `openPanel`, Messages is open on
// the roster. Every chat message arrives over the class WebSocket, and
// `harness.setSettings` changes the dashboard settings (the school-wide
// messaging switch among them) as another tab or an administrator would.
async function messagesPage({ students, absentIds = [], openPanel = true } = {}) {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date(ROSTER_CLOCK) });
  const pageErrors = [];
  const reads = [];
  const mutations = [];
  const commandPosts = [];
  const canonicalMessages = new Map();
  let socket = null;
  let settings = { activeSessionId: SESSION_ID, handRaisingEnabled: true, studentMessagingEnabled: true, sessionFabRevision: 1, blockedDomains: [] };
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript((schoolId) => window.localStorage.setItem('sp_activeSchoolId', schoolId), SCHOOL_ID);
  await page.routeWebSocket('**/ws', (ws) => {
    ws.onMessage((message) => {
      const parsed = JSON.parse(message);
      if (parsed.type === 'auth') {
        socket = ws;
        ws.send(JSON.stringify({ type: 'auth-success' }));
      }
      if (parsed.type === 'subscribe-session') {
        ws.send(JSON.stringify({ type: 'session-subscription-success', sessionId: parsed.sessionId, teachingSessionId: parsed.sessionId, requestId: parsed.requestId }));
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (request.method() === 'POST' && ['/api/teacher/reply', '/api/teacher/close-chat', '/api/teacher/messages/read'].includes(pathname)) {
      const body = request.postDataJSON();
      mutations.push({ pathname, body });
      if (pathname.endsWith('/read')) {
        const readAt = new Date().toISOString();
        for (const id of body?.messageIds || []) {
          const row = canonicalMessages.get(id);
          if (row) canonicalMessages.set(id, { ...row, readAt });
        }
        return json({ readAt, updatedIds: body?.messageIds || [] });
      }
      if (pathname.endsWith('/reply')) {
        const message = storedChatMessage({ id: CHAT_REPLY_ID, studentId: body.studentId,
          senderId: TEACHER_ID, senderType: 'teacher', content: body.message, deliveryStatus: 'sent' });
        canonicalMessages.set(message.id, message);
        return json({ message, queued: true }, 202);
      }
      return json({ ok: true });
    }
    if (request.method() === 'POST' && (pathname.startsWith('/api/commands') || pathname === '/api/classpilot/commands')) {
      commandPosts.push({ pathname, body: request.postDataJSON() });
      return json({ error: 'A command must not be sent in this test' }, 500);
    }
    switch (pathname) {
      case '/api/auth/me': return json({
        user: { id: TEACHER_ID, email: 'teacher@example.edu', firstName: 'Tess', lastName: 'Teacher', isSuperAdmin: false },
        token: 'messages-roster-token', activeSchoolId: SCHOOL_ID,
        licenses: { classPilot: true, passPilot: false, goPilot: false },
        memberships: [{ id: 'membership', schoolId: SCHOOL_ID, schoolName: 'Roster School', schoolTimezone: 'America/New_York', role: 'teacher' }],
      });
      case '/api/auth/csrf': return json({ csrfToken: 'messages-roster-csrf' });
      case '/api/settings': return json({ settings });
      case '/api/classpilot/dashboard-activity': return json({ enabled: false, schoolId: SCHOOL_ID, viewerId: TEACHER_ID });
      case '/api/flight-paths': return json({ flightPaths: [] });
      case '/api/block-lists': return json({ blockLists: [] });
      case '/api/sessions/active': return json({ session });
      case '/api/sessions/all': return json({ sessions: [session] });
      case '/api/teacher/groups': return json({ groups: [{ id: GROUP_ID, name: 'Algebra', teacherId: TEACHER_ID }] });
      case '/api/coverage/summary': return json({ activeContextCount: 0, availableStudentCount: 0, claimedStudentCount: 0, schoolId: SCHOOL_ID, viewerId: TEACHER_ID, ownTestingContexts: [] });
      case '/api/coverage/capabilities': return json({ commandTypes: [] });
      case '/api/coverage/claimed-students':
      case '/api/coverage/available-students': return json({ students: [] });
      case '/api/students-aggregated': return json(students);
      case '/api/commands/active-state': return json({ states: [] });
      case '/api/teacher/raised-hands': return json({ raisedHands: [] });
      case '/api/teacher/messages':
        reads.push(pathname);
        return json({ messages: [...canonicalMessages.values()] });
      case '/api/admin/attendance': return json({ records: absentIds.map((studentId) => ({ studentId, status: 'absent' })) });
      case '/api/classpilot/tiles/screenshots':
      case '/api/classpilot/tiles/history': return json({ tiles: [] });
      default:
        if (/^\/api\/groups\/[^/]+\/subgroups$/.test(pathname)) return json({ subgroups: [] });
        if (/^\/api\/groups\/[^/]+\/students$/.test(pathname)) return json({ students: [] });
        if (pathname.endsWith('/observation-lease')) return json({ renewAfterSeconds: 30 });
        return json({});
    }
  });

  const harness = {
    pageErrors,
    commandPosts,
    async sendWebSocketMessage(message) {
      await waitUntil(() => Boolean(socket), 'The Dashboard WebSocket must authenticate');
      // A live notification follows durable history. Hard-off now re-reads that
      // history while retaining conversations; it must not receive a false []
      // after this fixture has already notified the teacher of a saved message.
      if (message.type === 'student-message') {
        const data = message.data;
        canonicalMessages.set(data.id, storedChatMessage({ id: data.id,
          schoolId: message.schoolId, sessionId: data.sessionId, studentId: data.studentId,
          senderId: data.studentId, content: data.message, messageType: data.messageType,
          createdAt: data.timestamp }));
      }
      socket.send(JSON.stringify(message));
    },
    async setSettings(patch) {
      settings = { ...settings, ...patch };
      await page.evaluate(async () => {
        const { queryClient } = await import('/src/lib/queryClient.js');
        await queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      });
    },
  };
  await page.goto(`${baseURL}/classpilot`);
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor();
  await waitUntil(() => reads.length > 0, 'The canonical chat history must be requested');
  await waitUntil(() => Boolean(socket), 'The Dashboard WebSocket must authenticate');
  if (openPanel) {
    await openChatPanel(page);
    // Messages opens on the class roster: every student, before anyone writes.
    await page.getByTestId(`chat-conversation-${students[0].studentId}`).waitFor();
  }
  return { page, harness, reads, mutations };
}

async function chatEvidence(page, name, facts = {}) {
  const evidence = process.env.CLASSPILOT_CHAT_EVIDENCE_DIR;
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
  writeFileSync(path.join(evidence, `${name}.json`), `${JSON.stringify(facts, null, 2)}\n`);
}

async function openToolbarByKeyboard(page) {
  // Toasts stack over the toolbar corner, so drive it from the keyboard.
  await page.getByRole('button', { name: 'Class tools', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('chat-open').waitFor();
}

async function openChatPanel(page) {
  if (await page.getByTestId('chat-drawer').isVisible()) return;
  if (!await page.getByTestId('class-tools-panel').isVisible()) await page.getByRole('button', { name: 'Class tools', exact: true }).click();
  await page.getByTestId('chat-open').click();
  await page.getByTestId('chat-drawer').waitFor();
}

async function expectChatUnread(page, count) {
  await page.getByTestId('chat-drawer-unread-count').getByText(String(count), { exact: true }).waitFor();
}

async function selectConversation(page, studentId = STUDENT_ID) {
  const thread = page.getByTestId('chat-thread');
  if (await thread.count() && await thread.getAttribute('data-student-id') === studentId) return;
  await page.getByTestId(`chat-conversation-${studentId}`).click();
  await page.getByTestId('chat-thread').waitFor();
}

// A student's roster row: its unread count.
function rowUnread(page, studentId = STUDENT_ID) {
  return page.getByTestId(`chat-conversation-unread-${studentId}`);
}

async function expectRowUnread(page, count, studentId = STUDENT_ID) {
  await rowUnread(page, studentId).getByText(String(count), { exact: true }).waitFor();
}

function threadText(page, text) {
  return page.getByTestId('chat-thread').getByText(text, { exact: true });
}

function replyInput(page) {
  return page.getByTestId('chat-composer-input');
}

function focusedTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

async function waitForFocus(page, testId) {
  await page.waitForFunction(id => document.activeElement?.getAttribute('data-testid') === id, testId);
}

// Long enough for a click's state update, effects and a focus frame to land.
function afterFrames(page) {
  return page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
}

async function rosterOrder(page) {
  return page.getByTestId('chat-conversations').locator('[data-roster-id]').evaluateAll(nodes => nodes.map(node => node.dataset.rosterId));
}

test('chat roster: Messages lists the whole class in the grid order with presence and no message text, whatever the grid filter', { timeout: 120_000 }, async () => {
  const fixture = await messagesPage({ openPanel: false, students: rosterClass(), absentIds: [STUDENT_ID, FOURTH_STUDENT_ID] });
  const { page, harness } = fixture;
  for (const id of ROSTER_ORDER) await page.getByTestId(`card-student-${id}`).waitFor();
  assert.deepEqual(await page.locator('[data-testid^="card-student-"]').evaluateAll(nodes => nodes.map(node => node.dataset.testid)),
    ROSTER_ORDER.map(id => `card-student-${id}`), 'The grid order');
  // The grid search narrows the tiles; the roster stays the whole class.
  await page.getByTestId('input-search-students').fill('Zed');
  await page.getByTestId(`card-student-${STUDENT_ID}`).waitFor({ state: 'detached' });
  const benRow = storedChatMessage({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', studentId: SECOND_STUDENT_ID, content: 'Synthetic second student question', createdAt: '2026-09-18T14:00:00.000Z' });
  const adaRow = storedChatMessage({ createdAt: '2026-09-18T14:02:00.000Z' });
  await harness.sendWebSocketMessage(studentChatEvent(benRow));
  await harness.sendWebSocketMessage(studentChatEvent(adaRow));
  await openToolbarByKeyboard(page);
  await page.getByTestId('chat-open').getByText('2', { exact: true }).waitFor();
  await openChatPanel(page);
  await expectChatUnread(page, 2);
  await expectRowUnread(page, 1, SECOND_STUDENT_ID);
  assert.deepEqual(await rosterOrder(page), ROSTER_ORDER, 'The whole class in the grid order, never newest or unread first');
  // Each row is a mark, a name, at most one status word and an unread count;
  // the status is spelled out for screen readers, and each mark has its own shape.
  const row = id => page.getByTestId(`chat-conversation-${id}`).evaluate(node => ({
    mark: node.querySelector('[data-mark]')?.dataset.mark ?? null,
    text: node.textContent.replace(/\s+/g, ' ').trim(),
  }));
  assert.deepEqual(await row(SECOND_STUDENT_ID), { mark: 'dash', text: 'Ben Adams, Not signed in, 1 unread' });
  assert.deepEqual(await row(STUDENT_ID), { mark: 'dot', text: 'Ada Student, On now, 1 unread' }, 'Reporting outranks an absence mark');
  assert.deepEqual(await row(FOURTH_STUDENT_ID), { mark: 'cross', text: 'Dee Vance, Absent' });
  assert.deepEqual(await row(THIRD_STUDENT_ID), { mark: 'diamond', text: 'Cy Zed, With Morgan Monitor' });
  const list = page.getByTestId('chat-conversations');
  for (const text of [CHAT_MESSAGE_TEXT, benRow.content]) {
    assert.equal(await list.getByText(text).count(), 0, 'The roster never previews what a student wrote');
  }
  assert.equal(await list.locator('time, img').count(), 0, 'No times or avatars');
  await chatEvidence(page, 'class-roster', { rows: ROSTER_ORDER.length, gridFilter: 'Zed' });
  await selectConversation(page);
  await threadText(page, CHAT_MESSAGE_TEXT).waitFor();
  await expectChatUnread(page, 1);
  await rowUnread(page).waitFor({ state: 'hidden' });
  await expectRowUnread(page, 1, SECOND_STUDENT_ID);
  assert.equal(await page.getByTestId(`chat-conversation-${STUDENT_ID}`).getAttribute('aria-current'), 'true');
  assert.deepEqual(await rosterOrder(page), ROSTER_ORDER, 'Reading a thread never reorders the roster');
  // Cy is with another staff member and has no thread: the row opens nothing.
  const cyRow = page.getByTestId(`chat-conversation-${THIRD_STUDENT_ID}`);
  assert.equal(await cyRow.getAttribute('aria-disabled'), 'true');
  // A real click; Playwright would otherwise wait for an aria-disabled row to enable.
  await cyRow.click({ force: true });
  await afterFrames(page);
  assert.equal(await page.getByTestId('chat-thread').getAttribute('data-student-id'), STUDENT_ID, 'A With-staff row with no thread opens nothing');
  // Another tab hides Messages: the roster is not rendered behind it.
  await page.getByTestId('class-tools-tab-help').click();
  await page.getByTestId('chat-roster-find').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('chat-conversations').count(), 0, 'No roster rows while Messages is hidden');
  await page.getByTestId('chat-open').click();
  await expectRowUnread(page, 1, SECOND_STUDENT_ID);
  await page.keyboard.press('Escape');
  await page.getByTestId('chat-drawer').waitFor({ state: 'hidden' });
  await openToolbarByKeyboard(page);
  await page.getByTestId('chat-open').getByText('1', { exact: true }).waitFor();
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
  await page.close();
});

test('chat roster: "need reply", Find with Enter and Escape, arrow keys, a read-only With-staff row, and one pane', { timeout: 120_000 }, async () => {
  const fixture = await messagesPage({ students: rosterClass() });
  const { page, harness } = fixture;
  // Dee, third in the roster, has waited longest. Cy wrote before Ben but is
  // with another staff member, so only Dee and Ben need a reply.
  const deeRow = storedChatMessage({ id: 'abababab-abab-4bab-8bab-abababababab', studentId: FOURTH_STUDENT_ID, content: 'Synthetic question that waited longest', createdAt: '2026-09-18T14:00:00.000Z' });
  const cyRow = storedChatMessage({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', studentId: THIRD_STUDENT_ID, content: 'Synthetic question before coverage', createdAt: '2026-09-18T14:01:00.000Z' });
  const benRow = storedChatMessage({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', studentId: SECOND_STUDENT_ID, content: 'Synthetic second student question', createdAt: '2026-09-18T14:03:00.000Z' });
  await harness.sendWebSocketMessage(studentChatEvent(benRow));
  await harness.sendWebSocketMessage(studentChatEvent(cyRow));
  await harness.sendWebSocketMessage(studentChatEvent(deeRow));
  await expectRowUnread(page, 1, FOURTH_STUDENT_ID);
  await expectRowUnread(page, 1, THIRD_STUDENT_ID);
  const needReply = page.getByTestId('chat-need-reply');
  await needReply.getByText('2 need reply', { exact: true }).waitFor();
  // The jump opens whoever has waited longest, wherever they sit in the roster, ready to type.
  await needReply.click();
  await threadText(page, deeRow.content).waitFor();
  assert.equal(await page.getByTestId('chat-thread').getAttribute('data-student-id'), FOURTH_STUDENT_ID);
  await waitForFocus(page, 'chat-composer-input');
  await needReply.getByText('1 needs reply', { exact: true }).waitFor();
  // Find narrows the roster; Enter opens nothing unless one student can be messaged.
  const find = page.getByTestId('chat-roster-find');
  await find.fill('zed');
  await page.getByTestId(`chat-conversation-${STUDENT_ID}`).waitFor({ state: 'detached' });
  await find.press('Enter');
  await afterFrames(page);
  // Escape clears Find and leaves Class tools open.
  await find.press('Escape');
  assert.equal(await find.inputValue(), '');
  assert.equal(await page.getByTestId('class-tools-panel').isVisible(), true, 'Escape in Find must not close Class tools');
  assert.equal(await page.getByTestId('chat-thread').getAttribute('data-student-id'), FOURTH_STUDENT_ID, 'Enter on a read-only match opened nothing');
  assert.deepEqual(await rosterOrder(page), ROSTER_ORDER);
  // The rows are one Tab stop: arrows move between them, Enter opens one.
  await find.press('ArrowDown');
  await waitForFocus(page, `chat-conversation-${FOURTH_STUDENT_ID}`);
  assert.deepEqual(await page.getByTestId('chat-conversations').locator('[data-roster-id][tabindex="0"]').evaluateAll(nodes => nodes.map(node => node.dataset.rosterId)),
    [FOURTH_STUDENT_ID], 'Exactly one row is in the Tab order: the open thread');
  await page.keyboard.press('End');
  await waitForFocus(page, `chat-conversation-${THIRD_STUDENT_ID}`);
  // A student with another staff member is read-only: the thread opens to read, with no reply box.
  await page.keyboard.press('Enter');
  await threadText(page, cyRow.content).waitFor();
  assert.equal(await page.getByTestId('chat-thread-read-only').innerText(), 'Cy Zed is with Morgan Monitor right now. You can reply when they’re back in this class.');
  assert.equal(await replyInput(page).count(), 0, 'No reply box: the server would refuse the reply');
  assert.equal(await page.getByTestId('chat-thread-menu').count(), 0, 'Nor an End chat that would reach their device');
  assert.equal(await page.getByTestId('chat-thread').getByRole('button', { name: 'Details', exact: true }).count(), 0, 'Nor Details, which this class cannot open');
  assert.equal(await focusedTestId(page), `chat-conversation-${THIRD_STUDENT_ID}`, 'Focus stays on the row');
  await rowUnread(page, THIRD_STUDENT_ID).waitFor({ state: 'detached' });
  await chatEvidence(page, 'roster-read-only-thread', { student: 'Cy Zed', with: 'Morgan Monitor', composer: false });
  // Ben still needs a reply. With his thread open, nobody does.
  await needReply.getByText('1 needs reply', { exact: true }).waitFor();
  await needReply.click();
  await threadText(page, benRow.content).waitFor();
  await waitForFocus(page, 'chat-composer-input');
  await needReply.waitFor({ state: 'detached' });
  // Two matches: Enter waits. One match: Enter opens it with the reply box focused.
  await find.fill('ada');
  await find.press('Enter');
  await afterFrames(page);
  assert.equal(await page.getByTestId('chat-thread').getAttribute('data-student-id'), SECOND_STUDENT_ID);
  await find.fill('ada s');
  await page.getByTestId(`chat-conversation-${SECOND_STUDENT_ID}`).waitFor({ state: 'detached' });
  await find.press('Enter');
  await page.getByTestId('chat-thread-empty').waitFor();
  assert.equal(await page.getByTestId('chat-thread').getAttribute('data-student-id'), STUDENT_ID);
  await waitForFocus(page, 'chat-composer-input');
  assert.equal(await replyInput(page).getAttribute('aria-label'), 'Message Ada Student');
  assert.equal(await find.inputValue(), '', 'Find clears once it has opened a thread');
  assert.deepEqual(await rosterOrder(page), ROSTER_ORDER);
  assert.equal(await page.getByTestId(`chat-conversation-${STUDENT_ID}`).getAttribute('aria-current'), 'true');
  await chatEvidence(page, 'roster-empty-thread', { student: 'Ada Student', openedBy: 'Find + Enter' });
  // Below 640 px Messages is one pane: the open thread with Back, or the roster.
  // The short drawer can tuck the header under its footer, so use the keyboard.
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByTestId('chat-thread-back').focus();
  await page.keyboard.press('Enter');
  // Back puts focus on the student's row in the roster that replaces the thread.
  await waitForFocus(page, `chat-conversation-${STUDENT_ID}`);
  assert.equal(await page.getByTestId('chat-thread').count(), 0);
  await page.keyboard.press('Home');
  await waitForFocus(page, `chat-conversation-${SECOND_STUDENT_ID}`);
  await page.keyboard.press('Enter');
  await threadText(page, benRow.content).waitFor();
  assert.equal(await page.getByTestId('chat-conversations').count(), 0, 'The thread replaces the roster');
  await waitForFocus(page, 'chat-composer-input');
  // With no reply box to take it, focus lands on Back rather than the page.
  await page.getByTestId('chat-thread-back').focus();
  await page.keyboard.press('Enter');
  await waitForFocus(page, `chat-conversation-${SECOND_STUDENT_ID}`);
  await page.keyboard.press('End');
  await waitForFocus(page, `chat-conversation-${THIRD_STUDENT_ID}`);
  await page.keyboard.press('Enter');
  await page.getByTestId('chat-thread-read-only').waitFor();
  await waitForFocus(page, 'chat-thread-back');
  assert.equal(fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/reply').length, 0);
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
  await page.close();
});

test('chat roster: a switch turned off elsewhere is announced, closes a conversation not yet started without losing its draft, and moves the focus it takes only to the open conversation or a note', { timeout: 120_000 }, async () => {
  const [ada, , ben] = rosterClass();
  const fixture = await messagesPage({ students: [ada, ben] });
  const { page, harness } = fixture;
  const noSelection = page.getByTestId('chat-no-selection');
  const benRow = page.getByTestId(`chat-conversation-${SECOND_STUDENT_ID}`);
  const adaRow = page.getByTestId(`chat-conversation-${STUDENT_ID}`);
  // A static part of the Dashboard, outside Messages, that takes no focus.
  const pageHeading = page.getByRole('heading', { level: 1, name: 'ClassPilot', exact: true });
  // The school turns messaging off or back on, as an administrator would.
  const setSchoolMessaging = async (enabled) => {
    await harness.setSettings({ schoolStudentMessagingEnabled: enabled });
    await page.getByTestId('chat-school-off-banner').waitFor({ state: enabled ? 'detached' : 'visible' });
    await afterFrames(page);
  };
  // The teacher, still typing, finishes the message and presses Enter where
  // focus landed: nothing opens or sends a message to anyone.
  const typeOn = async (expectedFocus) => {
    await page.keyboard.type(' x');
    await afterFrames(page);
    await page.keyboard.press('Enter');
    await afterFrames(page);
    assert.equal(await page.getByTestId('dialog-send-message').count(), 0, 'no Send Message dialog opens');
    assert.deepEqual(harness.commandPosts, []);
    assert.deepEqual(fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/reply'), [], 'no message is sent');
    assert.equal(await focusedTestId(page), expectedFocus);
  };
  const pageHasFocus = () => page.evaluate(() => document.activeElement === document.body);

  // Two panes. Ben has no conversation yet: the teacher starts one and types.
  await benRow.click();
  await page.getByTestId('chat-thread-empty').waitFor();
  await waitForFocus(page, 'chat-composer-input');
  await page.keyboard.type('Draft to Ben');
  // Turned off: the banner is announced and the unstarted conversation closes
  // instead of waiting hidden. Focus moves to the note in its place, never to
  // the announce button, where the next Space would open a message to the
  // whole class and Enter would send the rest of this one there.
  await setSchoolMessaging(false);
  assert.equal(await page.getByTestId('chat-school-off-banner').evaluate(node => node.closest('[role="status"]')?.dataset.testid), 'chat-off-region');
  assert.equal(await page.getByTestId('chat-thread').count(), 0);
  assert.equal(await benRow.count(), 0, 'Ben has no conversation to read');
  assert.equal(await noSelection.innerText(), 'No conversations to read', 'nothing promises messages students cannot send');
  await waitForFocus(page, 'chat-no-selection');
  await typeOn('chat-no-selection');
  // Back on: nothing reopens by itself, and focus stays where it is.
  await setSchoolMessaging(true);
  await benRow.waitFor();
  assert.equal(await page.getByTestId('chat-thread').count(), 0, 'the closed conversation does not reopen by itself');
  assert.equal(await noSelection.innerText(), 'Choose a student to message');
  assert.equal(await focusedTestId(page), 'chat-no-selection', 'turning messaging back on moves no focus');
  // Ben's draft waited for the teacher.
  await benRow.click();
  await waitForFocus(page, 'chat-composer-input');
  assert.equal(await replyInput(page).inputValue(), 'Draft to Ben');

  // Ada writes. With her thread open and a draft typed, turning messaging off
  // keeps the thread and the draft to read, and focus moves to her row.
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage({ createdAt: '2026-09-18T14:04:00.000Z' })));
  await expectRowUnread(page, 1);
  await adaRow.click();
  await threadText(page, CHAT_MESSAGE_TEXT).waitFor();
  await waitForFocus(page, 'chat-composer-input');
  await page.keyboard.type('Draft to Ada');
  await setSchoolMessaging(false);
  assert.equal(await replyInput(page).isDisabled(), true);
  assert.equal(await replyInput(page).inputValue(), 'Draft to Ada');
  await waitForFocus(page, `chat-conversation-${STUDENT_ID}`);
  // The reply box, Send and every quick reply are off, so nothing replaces the
  // draft that waits for messaging to come back.
  assert.deepEqual(await page.getByTestId('chat-composer').locator('button').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => node.textContent)), []);
  await page.getByTestId('chat-canned-yes').click({ force: true });
  assert.equal(await replyInput(page).inputValue(), 'Draft to Ada', 'a quick reply cannot replace the kept draft');
  await adaRow.focus();
  await setSchoolMessaging(true);
  await page.locator('[data-testid="chat-composer-input"]:not([disabled])').waitFor();
  assert.equal(await focusedTestId(page), `chat-conversation-${STUDENT_ID}`, 'turning messaging back on never pulls focus');
  assert.equal(await replyInput(page).inputValue(), 'Draft to Ada');

  // The teacher leaves the reply box with a click on the page, or on text in
  // the conversation. A switch turned off and on again leaves focus on the
  // page both times: it was not the switch's to take.
  for (const elsewhere of [pageHeading, page.getByTestId('chat-thread').getByText('Ada Student', { exact: true })]) {
    await replyInput(page).focus();
    await page.keyboard.press('End');
    await page.keyboard.type(', more');
    await elsewhere.click();
    assert.equal(await pageHasFocus(), true);
    await setSchoolMessaging(false);
    assert.equal(await pageHasFocus(), true, 'focus the teacher moved stays where it is');
    await setSchoolMessaging(true);
    assert.equal(await pageHasFocus(), true, 'turning messaging back on never pulls focus');
  }
  assert.equal(await replyInput(page).inputValue(), 'Draft to Ada, more, more');
  // Clear thread removes its own button, so focus falls to the page, as it
  // always has. Turning messaging back on later still moves no focus.
  await setSchoolMessaging(false);
  await page.getByTestId('chat-thread-clear').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('chat-thread').waitFor({ state: 'detached' });
  assert.equal(await pageHasFocus(), true);
  await setSchoolMessaging(true);
  assert.equal(await pageHasFocus(), true, 'turning messaging on never pulls focus into Messages');
  // Nor does turning it off once the teacher has clicked the page since.
  const later = storedChatMessage({ id: 'abababab-abab-4bab-8bab-abababababab', content: 'Synthetic question after the clear', createdAt: '2026-09-18T14:04:30.000Z' });
  await harness.sendWebSocketMessage(studentChatEvent(later));
  await adaRow.click();
  await threadText(page, later.content).waitFor();
  await page.getByTestId('chat-thread-clear').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('chat-thread').waitFor({ state: 'detached' });
  assert.equal(await pageHasFocus(), true);
  await pageHeading.click();
  await setSchoolMessaging(false);
  assert.equal(await pageHasFocus(), true, 'a click on the page put the teacher there');
  await setSchoolMessaging(true);

  // Ada writes again. With a conversation to read, an unstarted one closes the
  // same way. Focus moves to the note in its place, not to Ada's row: if
  // messaging came straight back, a Space there would open Ada's reply box for
  // the rest of a message meant for Ben.
  await harness.sendWebSocketMessage(studentChatEvent(storedChatMessage({ id: 'acacacac-acac-4cac-8cac-acacacacacac', content: 'Synthetic question after another clear', createdAt: '2026-09-18T14:04:45.000Z' })));
  await expectRowUnread(page, 1);
  await benRow.click();
  await page.getByTestId('chat-thread-empty').waitFor();
  await waitForFocus(page, 'chat-composer-input');
  await setSchoolMessaging(false);
  assert.equal(await noSelection.innerText(), 'Select a conversation to read it');
  await waitForFocus(page, 'chat-no-selection');
  await setSchoolMessaging(true);
  await typeOn('chat-no-selection');
  assert.equal(await page.getByTestId('chat-thread').count(), 0, 'nothing opened');

  // One pane: the thread replaces the list. Turning messaging off brings the
  // list back, with focus on the Messages heading above it rather than on
  // Ada's row, and turning it on leaves both in place.
  await page.setViewportSize({ width: 600, height: 900 });
  await benRow.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('chat-thread-empty').waitFor();
  // The empty thread can render before the resize event updates panel width.
  // Back exists only after the workspace has committed its one-pane layout.
  await page.getByTestId('chat-thread-back').waitFor();
  assert.equal(await page.getByTestId('chat-conversations').count(), 0, 'the thread replaces the list');
  await waitForFocus(page, 'chat-composer-input');
  await setSchoolMessaging(false);
  await page.getByTestId('chat-conversations').waitFor();
  await waitForFocus(page, 'chat-drawer-heading');
  await typeOn('chat-drawer-heading');
  await setSchoolMessaging(true);
  await benRow.waitFor();
  assert.equal(await page.getByTestId('chat-thread').count(), 0, 'the list stays: the closed conversation does not replace it');
  assert.equal(await focusedTestId(page), 'chat-drawer-heading', 'turning messaging back on moves no focus');
  await benRow.focus();
  await page.keyboard.press('Enter');
  await waitForFocus(page, 'chat-composer-input');
  assert.equal(await replyInput(page).inputValue(), 'Draft to Ben', 'the draft survives every switch');
  assert.equal(fixture.mutations.filter(mutation => mutation.pathname === '/api/teacher/reply').length, 0);
  assert.deepEqual(harness.commandPosts, []);
  assert.deepEqual(harness.pageErrors, []);
  await page.close();
});
