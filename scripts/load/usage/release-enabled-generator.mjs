import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { offerOpenLoopHeartbeats, OPEN_LOOP_HEARTBEATS } from './open-loop-heartbeats.mjs';
import { COLD_OPEN_LOOP_PROFILE } from './cold-open-loop-profile.mjs';
import { RELEASE_ENABLED_PROFILE, releaseRangeFixture } from './release-enabled-profile.mjs';
import { schoolDayOracle, schoolDayRangeDomains } from './school-day-profile.mjs';
import { summarize } from './local-usage-benchmark.mjs';
import { commandTransportAcknowledgement, focusClassroomAcknowledgement, publicFocusProjectionMatches, assertPrivateLifecycleAdvanced, lifecycleToken } from './release-enabled-protocol.mjs';

assert.ok(process.send, 'Generator requires an owning IPC parent');
const { createStudentToken } = await import('../../../dist/services/deviceJwt.js');
let fixture, base, schools;
let heartbeatStatuses = null;
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const oracles = Object.fromEntries(['school', 'grade', 'class', 'student'].map(scope => [scope, schoolDayOracle(scope)]));
const scopedSize = { school: 500, grade: 100, class: 5, student: 1 };
const safeFailure = error => ({ name: error.name, code: error.code || 'ASSERTION', message: String(error.message).slice(0, 400) });

async function request(path, { method = 'GET', body, cookie, token, schoolId, csrf, signal } = {}) {
  const response = await fetch(`${base}${path}`, { method, signal: signal ?? AbortSignal.timeout(20_000), headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(schoolId ? { 'X-School-Id': schoolId } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data, cookie: response.headers.getSetCookie().map(row => row.split(';')[0]).join('; '), headers: response.headers };
}
const staffRequest = (school, path, options = {}, teacher = false) => request(`/api/classpilot${path}`, {
  ...options, schoolId: school.id, cookie: teacher ? school.teacherCookie : school.cookie,
  csrf: teacher ? school.teacherCsrf : school.csrf,
});
async function login(email, password) {
  const result = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200, `Real session login failed: ${result.status}`); assert.match(result.cookie, /schoolpilot.sid=/);
  const csrf = await request('/api/auth/csrf', { cookie: result.cookie }); assert.equal(csrf.status, 200); assert.ok(csrf.body.csrfToken);
  return { cookie: result.cookie, csrf: csrf.body.csrfToken };
}
async function heartbeat(school, index, signal, allowPreflightThrottle = false) {
  const result = await request('/api/classpilot/device/heartbeat', { method: 'POST', token: school.tokens[index], signal,
    body: { clientProtocolVersion: 3, extensionVersion: '2.9.7', capabilities: COLD_OPEN_LOOP_PROFILE.classPilot.capabilities,
      activeTabUrl: 'https://ixl.com/lesson', activeTabTitle: 'Synthetic current scope', tabSnapshotRevision: 9,
      allOpenTabs: [{ tabRef: `synthetic-tab-${index}`, url: 'https://ixl.com/lesson', title: 'Synthetic current scope' }] } });
  assert.ok([200, 204].includes(result.status), `Heartbeat HTTP ${result.status}`);
  if (heartbeatStatuses) heartbeatStatuses[result.status] = (heartbeatStatuses[result.status] || 0) + 1;
  if (result.status === 204) assert.equal(allowPreflightThrottle, true, 'Only the first offer to a just-warmed fixture may use the five-second throttle');
  if (result.status === 200) for (const capability of ['preciseRestrictionResourcesV1', 'focusTabV1', 'privateChatLifecycleV1']) {
    assert.ok(result.body.acceptedCapabilities?.includes(capability), `Heartbeat did not accept ${capability}`);
  }
  return result;
}

export function assertHistoricalReport(read, scope, fixture, days = 365) {
  assert.equal(read.status, 200);
  const body = read.body, heavy = body.byDay.find(row => row.date === fixture.heavyDate);
  const range = releaseRangeFixture(fixture, days), expected = oracles[scope], count = scopedSize[scope], history = range.historyDates.length;
  assert.equal(body.range.retentionDays, 365); assert.equal(body.range.requestedDays, days);
  if (range.includesEmpty) assert.equal(body.byDay.find(row => row.date === fixture.emptyDate)?.monitoredBrowserSeconds, 0);
  assert.equal(body.byDay.some(row => row.date === fixture.gapDate), false);
  const unavailable = range.dates.filter(date => date === fixture.today || date === fixture.gapDate || (date === fixture.heavyDate && !heavy));
  assert.deepEqual(body.range.unavailableDates, unavailable);
  assert.deepEqual(body.byDay.map(row => row.date), range.dates.filter(date => !unavailable.includes(date)));
  assert.equal(body.totals.monitoredBrowserSeconds, history * 90 * count + (heavy ? expected.monitored : 0));
  assert.equal(body.totals.instructionalSeconds, history * 30 * count + (heavy ? expected.instructional : 0));
  assert.equal(body.totals.offTaskSeconds, history * 30 * count + (heavy ? expected.offTask : 0));
  assert.equal(body.totals.unknownSeconds, history * 30 * count + (heavy ? expected.unknown : 0));
  const domains = history === 0 && !heavy ? { educational: [], nonEducational: [] } : schoolDayRangeDomains(scope, history, !!heavy, expected);
  assert.deepEqual(body.topEducationalDomains, domains.educational); assert.deepEqual(body.topNonEducationalDomains, domains.nonEducational);
  if (heavy) { assert.equal(heavy.heartbeatCount, expected.heartbeats); assert.equal(heavy.monitoredBrowserSeconds, expected.monitored); }
}
async function report(school, scope, format = 'json', days = 365) {
  const id = ({ grade: '6', class: school.groups[0], student: school.students[0] })[scope];
  const query = new URLSearchParams({ scope, format, from: releaseRangeFixture(fixture, days).from, to: fixture.today }); if (id) query.set('id', id);
  const start = performance.now(), result = await staffRequest(school, `/admin/usage?${query}`);
  return { ...result, durationMs: performance.now() - start };
}
async function reportWaves() {
  const rows = [];
  for (let wave = 0; wave < 4; wave++) {
    const days = RELEASE_ENABLED_PROFILE.reportOffers.rangesInDays[wave];
    await Promise.all(schools.flatMap(school => ['school', 'grade', 'class', 'student'].flatMap(scope => [0, 1].map(async () => {
      const row = { wave, days, schoolIndex: school.index, scope, status: 0, correct: false };
      const start = performance.now();
      try { const read = await report(school, scope, 'json', days); row.status = read.status; assertHistoricalReport(read, scope, fixture, days); row.correct = true; }
      catch (error) { row.error = safeFailure(error); }
      row.durationMs = performance.now() - start; rows.push(row);
    }))));
    await sleep(500);
  }
  return rows;
}

async function connectStudent(school, index) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`), frames = [];
  socket.on('message', raw => { if (frames.length < 500) frames.push(JSON.parse(raw.toString())); });
  await once(socket, 'open', { signal: AbortSignal.timeout(10_000) });
  socket.send(JSON.stringify({ type: 'auth', role: 'student', deviceId: school.devices[index], studentToken: school.tokens[index],
    clientProtocolVersion: 3, extensionVersion: '2.9.7', capabilities: COLD_OPEN_LOOP_PROFILE.classPilot.capabilities }));
  const until = Date.now() + 10_000;
  while (!frames.some(frame => ['auth-success', 'auth-error'].includes(frame.type)) && Date.now() < until) await sleep(10);
  const auth = frames.find(frame => frame.type === 'auth-success');
  assert.ok(auth, 'Real WebSocket authentication failed'); assert.equal(auth.studentId, school.students[index]); assert.equal(auth.studentSessionId, school.studentSessions[index]);
  return { socket, frames, auth, async drain() { const pong = once(socket, 'pong', { signal: AbortSignal.timeout(10_000) }); socket.ping(); await pong; }, close() { socket.terminate(); } };
}
async function waitFrame(connection, predicate) {
  const until = Date.now() + 10_000;
  while (!connection.frames.some(predicate) && Date.now() < until) await sleep(10);
  const frame = connection.frames.find(predicate); assert.ok(frame, 'Expected exact student transport frame did not arrive'); return frame;
}
async function assertPublicFocusApplied(school, index, expected) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await request('/api/students-aggregated?teachingSessionId=' + encodeURIComponent(school.currentSession), {
      cookie: school.teacherCookie, schoolId: school.id,
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    assert.equal(result.status, 200, 'Authorized Focus state lookup must succeed');
    assert.ok(Array.isArray(result.body), 'Expected the authorized classroom roster');
    const row = result.body.find(student => student.studentId === school.students[index]);
    assert.ok(row, 'Exact selected student is missing from the authorized classroom roster');
    if (publicFocusProjectionMatches(row, expected)) return;
    await sleep(250);
  } while (Date.now() < deadline);
  assert.fail('Exact public Focus revision did not reach synced state after its classroom acknowledgement');
}

async function command(school, type, payload, index, connection) {
  const issued = await staffRequest(school, '/commands', { method: 'POST', body: { teachingSessionId: school.currentSession,
    targetScope: 'students', targetStudentIds: [school.students[index]], commandType: type, commandPayload: payload } }, true);
  assert.equal(issued.status, 201, `${type} HTTP ${issued.status}: ${JSON.stringify(issued.body)}`);
  const status = await staffRequest(school, `/commands/${issued.body.command.id}/status?teachingSessionId=${school.currentSession}`, {}, true);
  assert.equal(status.status, 200); const item = status.body.command ?? status.body;
  const targets = item.targets ?? issued.body.command.targets; assert.equal(targets.length, 1); assert.equal(targets[0].studentId, school.students[index]);
  assert.ok(!['unavailable', 'failed'].includes(targets[0].status), `${type} unavailable: ${targets[0].errorMessage || targets[0].status}`);
  const frame = await waitFrame(connection, message => message.commandId === issued.body.command.id && message.type === 'remote-control');
  const transportAck = commandTransportAcknowledgement(frame, school, index, type, issued.body.command.id);
  const focusProof = ['focus-tab', 'stop-focus'].includes(type)
    ? focusClassroomAcknowledgement(frame, school, index, type, issued.body.command.id) : null;
  if (focusProof) {
    // The packaged extension sends this distinct state ACK after applying state.
    // Verify canonical public state before a command-completion receipt can mask it.
    connection.socket.send(JSON.stringify(focusProof.classroomAck));
    await assertPublicFocusApplied(school, index, focusProof);
  }
  const ack = await request('/api/classpilot/device/command-acks', { method: 'POST', token: school.tokens[index], body: { acks: [{
    ackId: randomUUID(), commandId: issued.body.command.id, ackState: 'completed', ...transportAck,
    schoolId: school.id, studentId: school.students[index], studentSessionId: school.studentSessions[index], deviceId: school.devices[index],
    result: { syntheticClient: true, ...(focusProof ? { focusStatus: focusProof.focusStatus,
      stateReconciled: true, appliedRevision: focusProof.classroomAck.appliedRevision, outcome: 'applied' } : {}) },
  }] } });
  assert.equal(ack.status, 200); assert.equal(ack.body.receipts[0].accepted, true, `${type} acknowledgement rejected: ${JSON.stringify(ack.body)}`);
  return issued.body.command.id;
}
async function lifecycle() {
  const events = [], sockets = [];
  try {
    // Start after the arrival generator begins; this is concurrent traffic.
    await sleep(1500);
    for (const school of schools) {
      const controlSockets = [];
      for (const index of [0, 1, 2]) { const connection = await connectStudent(school, index); sockets.push(connection); controlSockets.push(connection); }
      const socket = controlSockets[2]; events.push('websocket_authenticated');
      await command(school, 'lock-screen', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', boundary: 'resource' }, 0, controlSockets[0]); events.push('precise_command_ack');
      await command(school, 'focus-tab', { tabTargets: [{ studentId: school.students[1], tabRef: 'synthetic-tab-1', observedRevision: 9 }] }, 1, controlSockets[1]); events.push('focus_command_ack', 'focus_classroom_ack_and_public_state');
      const inbox = await staffRequest(school, `/teacher/messages?sessionId=${school.currentSession}`, {}, true); assert.equal(inbox.status, 200);
      const token = inbox.body.privateChatLifecycles.find(row => row.studentId === school.students[2])?.privateChatLifecycle; assert.ok(token);
      const send = () => staffRequest(school, '/teacher/reply', { method: 'POST', body: { sessionId: school.currentSession, studentId: school.students[2], message: 'Synthetic lifecycle probe', expectedPrivateChatLifecycle: token } }, true);
      const sent = await send(); assert.equal(sent.status, 202);
      const delivered = await waitFrame(socket, frame => frame.type === 'teacher-message' && frame.chatMessageId === sent.body.message.id);
      assert.equal(delivered.studentId, school.students[2]); assert.equal(delivered.studentSessionId, school.studentSessions[2]);
      assert.deepEqual(delivered.privateChatLifecycle, token);
      const chatAck = await request('/api/classpilot/device/chat-acks', { method: 'POST', token: school.tokens[2], body: { acks: [{ ackId: randomUUID(), messageId: sent.body.message.id, status: 'delivered', privateChatLifecycle: token }] } });
      assert.equal(chatAck.status, 200); assert.equal(chatAck.body.receipts[0].accepted, true); events.push('private_reply_ack');
      const pending = await send(); assert.equal(pending.status, 202);
      const closed = await staffRequest(school, '/teacher/close-chat', { method: 'POST', body: { sessionId: school.currentSession, studentId: school.students[2], expectedPrivateChatLifecycle: token } }, true);
      assert.equal(closed.status, 200); assertPrivateLifecycleAdvanced(token, closed.body.privateChatLifecycle); events.push('private_chat_closed');
      const stale = await send(); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'PRIVATE_CHAT_LIFECYCLE_STALE'); events.push('stale_private_reply_rejected');
      const lateAck = await request('/api/classpilot/device/chat-acks', { method: 'POST', token: school.tokens[2], body: { acks: [{ ackId: randomUUID(), messageId: pending.body.message.id, status: 'delivered', privateChatLifecycle: token }] } });
      assert.equal(lateAck.status, 200); assert.equal(lateAck.body.receipts[0].accepted, false); assert.equal(lateAck.body.receipts[0].code, 'PRIVATE_CHAT_EXPIRED');
      const closedInbox = await staffRequest(school, `/teacher/messages?sessionId=${school.currentSession}`, {}, true);
      assert.equal(closedInbox.status, 200); assert.equal(closedInbox.body.messages.find(message => message.id === pending.body.message.id)?.deliveryStatus, 'expired');
      assert.equal(closedInbox.body.messages.find(message => message.id === sent.body.message.id)?.deliveryStatus, 'delivered'); events.push('expired_reply_ack_and_projection_verified');
      socket.close(); const reconnected = await connectStudent(school, 2); sockets.push(reconnected); await reconnected.drain();
      const thread = reconnected.auth.settings?.fab?.privateChatLifecycleState?.threads?.find(row => row.teachingSessionId === school.currentSession);
      assert.ok(thread); assert.deepEqual(lifecycleToken(thread), lifecycleToken(closed.body.privateChatLifecycle));
      assert.equal(reconnected.frames.some(frame => frame.chatMessageId === pending.body.message.id), false); events.push('expired_reply_absent_after_reconnect');
      await command(school, 'stop-focus', {}, 1, controlSockets[1]); events.push('stop_focus_ack', 'stop_focus_classroom_ack_and_public_state');
      await command(school, 'unlock-screen', { screenOnly: true }, 0, controlSockets[0]); events.push('precise_cleanup_ack');
    }
    return { passed: true, events, simulatedClientAcknowledgements: true, browserEnforcementClaimed: false };
  } catch (error) { return { passed: false, events, error: safeFailure(error), simulatedClientAcknowledgements: true, browserEnforcementClaimed: false }; }
  finally { for (const socket of sockets) socket.close(); }
}

process.send({ kind: 'ready', pid: process.pid });
process.on('message', async rpc => {
  try {
    let value;
    if (rpc.operation === 'initialize') {
      fixture = rpc.value; base = fixture.base; schools = fixture.schools;
      for (const school of schools) {
        Object.assign(school, await login(school.email, fixture.password));
        const teacher = await login(`scale-${school.teachers[0]}@example.test`, fixture.password); school.teacherCookie = teacher.cookie; school.teacherCsrf = teacher.csrf;
        school.tokens = school.students.map((studentId, index) => createStudentToken({ studentId, schoolId: school.id, deviceId: school.devices[index], sessionId: school.studentSessions[index], studentEmail: `scale-${studentId}@example.test` }));
        for (let index = 0; index < RELEASE_ENABLED_PROFILE.preflightDevicesPerSchool; index++) await heartbeat(school, index);
        assertHistoricalReport(await report(school, 'school'), 'school', fixture);
      }
      const foreign = await staffRequest(schools[0], `/admin/usage?scope=student&id=${schools[1].students[0]}&from=${fixture.from}&to=${fixture.today}`);
      assert.equal(foreign.status, 404, 'Cross-school report lookup must remain unavailable');
      assert.equal(foreign.body.code, 'CLASSPILOT_USAGE_SCOPE_NOT_FOUND');
      const range = await staffRequest(schools[0], `/admin/usage?scope=school&from=2020-01-01&to=${fixture.today}`);
      assert.equal(range.status, 400, 'Excessive report range must be rejected');
      assert.equal(range.body.code, 'CLASSPILOT_USAGE_RANGE_INVALID');
      value = { realSessionCookies: true, acceptedCapabilities: true };
    } else if (rpc.operation === 'phase') {
      delay.reset(); const utilization = performance.eventLoopUtilization();
      const cpuStart = process.cpuUsage(); heartbeatStatuses = {};
      const config = { ...OPEN_LOOP_HEARTBEATS, ...(rpc.value.durationMs ? { durationMs: rpc.value.durationMs } : {}) };
      const [heartbeats, reports, classroom] = await Promise.all([
        rpc.value.ingest ? offerOpenLoopHeartbeats((offer, signal) => heartbeat(schools[offer.schoolIndex], offer.deviceIndex, signal,
          offer.index < RELEASE_ENABLED_PROFILE.preflightDevicesPerSchool * schools.length), { config }) : null,
        rpc.value.reports ? reportWaves() : [], rpc.value.lifecycle ? lifecycle() : null,
      ]);
      if (heartbeats) { heartbeats.timings = summarize(heartbeats.timingsMs); delete heartbeats.timingsMs; }
      value = { heartbeats, heartbeatStatuses, heartbeat204Reason: 'Only the first offer to each of the ten explicitly warmed bindings may use the5s throttle. Every other204 fails. Raw persistence must equal200responses.',
        reports, lifecycle: classroom, cpuMicroseconds: process.cpuUsage(cpuStart), eventLoop: { p95Ms: delay.percentile(95) / 1e6, maxMs: delay.max / 1e6, utilization: performance.eventLoopUtilization(utilization).utilization } };
      heartbeatStatuses = null;
    } else if (rpc.operation === 'correctness') {
      const rows = [];
      for (const school of schools) for (const scope of ['school', 'grade', 'class', 'student']) {
        const read = await report(school, scope); assert.equal(read.status, 200);
        const csv = await report(school, scope, 'csv'); assert.equal(csv.status, 200); assert.equal(csv.headers.get('cache-control'), 'no-store, private');
        assert.ok(csv.body.includes(`\"${fixture.emptyDate}\",\"final\",\"0.0\"`)); assert.equal(csv.body.includes(`\"${fixture.gapDate}\",`), false);
        rows.push({ schoolIndex: school.index, scope, report: read.body, csvSha256: (await import('node:crypto')).createHash('sha256').update(csv.body).digest('hex'), csv: csv.body, durationMs: read.durationMs });
      }
      value = rows;
    } else if (rpc.operation === 'shutdown') {
      await Promise.all([new Promise(resolve => process.stdout.write('', resolve)), new Promise(resolve => process.stderr.write('', resolve))]);
      process.send({ id: rpc.id, value: true }, () => process.exit(0)); return;
    }
    else throw new Error('Unknown generator operation');
    process.send({ id: rpc.id, value });
  } catch (error) { process.send({ id: rpc.id, error: safeFailure(error) }); }
});
process.on('disconnect', () => process.exit(1));
