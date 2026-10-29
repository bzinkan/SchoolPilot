import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsBrowserRequests, partitionWindowsBrowserCommand, projectWindowsBrowserStudent,
  selectWindowsBrowserSource, windowsBrowserMetadata, windowsBrowserScopeKey, windowsBrowserSources,
  pendingWindowsCommandOutcomes, readWindowsCommandOutcome } from '../src/products/classpilot/lib/windowsBrowsers.js';
import { classroomStudentTarget, waitForClassroomTargets } from '../src/products/classpilot/lib/classroomActions.js';
import { combineCommandSettlements, mergeCommandUpdateIntoBatches } from '../src/products/classpilot/lib/dashboardCommandContext.js';
import { completedStudentIdsFromCommand, trackTransientCommandResponse } from '../src/products/classpilot/lib/commandDeliveryTruth.js';
import { tileStudentReadAuthorityKey, isStudentScreenshotReadEligible, isStudentTilePrivacyRevoked } from '../src/products/classpilot/lib/classpilotReadRecovery.js';
import { buildTileStudentBindings, changedTileBindingStudentIds } from '../src/products/classpilot/lib/tileBatchPolling.js';

const chrome = { browserFamily: 'chrome', sourceRef: 'opaque-chrome', bindingRevision: 1, isLoggedIn: true,
  acceptedCapabilities: { exactTabTargetV1: true }, activeTabTitle: 'Chrome title', activeTabUrl: 'https://chrome.example/',
  tabSnapshot: { tabs: [{ tabRef: 'chrome-tab', url: 'https://chrome.example/' }] }, screenshot: 'secret-pixels' };
const edge = { browserFamily: 'edge', sourceRef: 'opaque-edge', bindingRevision: 7, isLoggedIn: true,
  acceptedCapabilities: {}, activeTabTitle: 'Edge title', activeTabUrl: 'https://edge.example/' };
const student = { studentId: 'student-a', activeTabTitle: 'Legacy', screenshot: 'legacy', acceptedCapabilities: { legacy: true } };
const entry = { contextKey: 'class-a', browserSources: [chrome, edge] };

test('Windows policy outcomes get one terminal read after expiry, including failed or cancelled reads', async () => {
  const command = { id: 'policy', commandType: 'lock-screen', transport: 'windows', targets: [{ ...chrome, status: 'sent' }] };
  const entries = new Map([['policy', { command, expiresAtMs: 1_000, deliveryPolicy: 'persistent_control' }]]);
  const finalReads = new Set();
  assert.equal(pendingWindowsCommandOutcomes(entries, finalReads).length, 1);
  let calls = 0;
  const read = () => { calls += 1; return Promise.resolve({ command: { ...command, targets: [{ ...chrome, status: 'expired' }] } }); };
  await readWindowsCommandOutcome(entries.get('policy'), { read, finalReads, now: 500 });
  assert.equal(finalReads.size, 0);
  const data = await readWindowsCommandOutcome(entries.get('policy'), { read, finalReads, now: 10_000 });
  assert.equal(data.command.targets[0].status, 'expired');
  assert.equal(pendingWindowsCommandOutcomes(entries, finalReads).length, 0);
  assert.equal(calls, 2);

  finalReads.clear();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readWindowsCommandOutcome(entries.get('policy'), { finalReads, now: 10_000, signal: controller.signal,
    read: () => Promise.reject(new Error('Cancelled')) }));
  assert.equal(pendingWindowsCommandOutcomes(entries, finalReads).length, 1);
  await assert.rejects(readWindowsCommandOutcome(entries.get('policy'), { finalReads, now: 10_000,
    read: () => Promise.reject(new Error('HTTP 503')) }));
  assert.equal(pendingWindowsCommandOutcomes(entries, finalReads).length, 0);
  finalReads.clear(); entries.get('policy').command.targets[0].status = 'failed';
  assert.equal(pendingWindowsCommandOutcomes(entries, finalReads).length, 0);
});
const choice = source => ({ ...source, scopeKey: windowsBrowserScopeKey(entry.contextKey, student.studentId) });

test('Windows disabled/missing metadata leaves legacy student object untouched', () => {
  assert.equal(projectWindowsBrowserStudent(student, null), student);
  assert.equal(projectWindowsBrowserStudent(student, { ...entry, browserSources: [] }), student);
});
test('two browsers require a choice; a sole browser defaults; duplicate profiles fail closed', () => {
  assert.equal(selectWindowsBrowserSource([chrome, edge]), null);
  assert.equal(selectWindowsBrowserSource([chrome]), chrome);
  assert.deepEqual(windowsBrowserSources([chrome, { ...chrome, sourceRef: 'second-profile' }, edge]), [edge]);
});
test('source projection keeps exact tabs and capabilities separate and never falls back after replacement', () => {
  const selected = projectWindowsBrowserStudent(student, entry, choice(chrome));
  assert.equal(selected.activeTabTitle, chrome.activeTabTitle);
  assert.equal(selected.acceptedCapabilities, chrome.acceptedCapabilities);
  assert.deepEqual(selected.allOpenTabs, chrome.tabSnapshot.tabs);
  const changed = projectWindowsBrowserStudent(student, { ...entry, browserSources: [{ ...chrome, bindingRevision: 2 }, edge] }, choice(chrome));
  assert.equal(changed.selectedWindowsBrowser, null);
  assert.deepEqual(changed.allOpenTabs, []);
  assert.equal(changed.activeTabTitle, '');
  assert.deepEqual(changed.acceptedCapabilities, {});
});
test('error/hidden projection clears selected content without selecting another browser', () => {
  const result = projectWindowsBrowserStudent(student, { ...entry, unavailable: true }, choice(chrome));
  assert.equal(result.windowsBrowserMode, true);
  assert.equal(result.selectedWindowsBrowser, null);
  assert.equal(result.isLoggedIn, false);
  assert.equal(result.activeTabTitle, '');
  assert.equal(result.windowsBrowserSelection.sourceRef, chrome.sourceRef);
});
test('known Windows session with no browser children stays Windows and exposes missing coverage', () => {
  const result = projectWindowsBrowserStudent(student, { ...entry, platform: 'windows', windowsSession: { state: 'active' }, browserSources: [],
    browserCoverage: [{ browserFamily: 'chrome', state: 'unpaired' }, { browserFamily: 'edge', state: 'unpaired' }] });
  assert.equal(result.windowsBrowserMode, true);
  assert.equal(result.selectedWindowsBrowser, null);
  assert.equal(result.windowsBrowserCoverage.length, 2);
  assert.equal(result.activeTabTitle, '');
});
test('failed first discovery cannot revive legacy content or capabilities', () => {
  const result = projectWindowsBrowserStudent(student, { ...entry, pending: true, unavailable: true });
  assert.equal(result.windowsDiscoveryUnavailable, true);
  assert.equal(result.activeTabTitle, undefined);
  assert.equal(result.isLoggedIn, false);
  assert.deepEqual(result.acceptedCapabilities, {});
});

test('pending discovery preserves only read identity without changing denial or pixel binding keys', () => {
  const legacy = { ...student, realtimeBinding: 'legacy-binding', classroomState: { revision: 8 }, isLoggedIn: true, loginState: 'logged_in' };
  for (const unavailable of [false, true]) {
    const pending = projectWindowsBrowserStudent(legacy, { ...entry, pending: true, unavailable });
    assert.equal(tileStudentReadAuthorityKey('scope', pending), tileStudentReadAuthorityKey('scope', legacy));
    assert.deepEqual(buildTileStudentBindings([pending]), buildTileStudentBindings([legacy]));
    assert.deepEqual(changedTileBindingStudentIds([legacy], [pending]), []);
    assert.equal(isStudentScreenshotReadEligible(pending), false);
    assert.equal(isStudentTilePrivacyRevoked(pending), false, 'discovery cannot manufacture a sign-out purge');
    assert.equal(pending.isLoggedIn, false);
    assert.equal(pending.loginState, 'unknown');
    assert.equal(pending.activeTabTitle, undefined);
    assert.equal(pending.classroomState, undefined);
    assert.deepEqual(pending.acceptedCapabilities, {});
    assert.deepEqual(pending.allOpenTabs, []);
  }
  const changed = projectWindowsBrowserStudent({ ...legacy, classroomState: { revision: 9 } }, { ...entry, pending: true });
  assert.notEqual(tileStudentReadAuthorityKey('scope', changed), tileStudentReadAuthorityKey('scope', legacy));
  const signedOut = projectWindowsBrowserStudent({ ...legacy, isLoggedIn: false, loginState: 'not_logged_in' }, { ...entry, pending: true });
  assert.equal(isStudentTilePrivacyRevoked(signedOut), true, 'actual sign-out still purges during discovery');
  for (const privacyState of [{ _realtimeSignedOut: true }, { activityState: 'delegated' }, { _realtimeSuppressed: true }]) {
    const revoked = projectWindowsBrowserStudent({ ...legacy, ...privacyState }, { ...entry, pending: true });
    assert.equal(isStudentTilePrivacyRevoked(revoked), true);
    assert.equal(isStudentScreenshotReadEligible(revoked), false);
  }
  assert.notEqual(tileStudentReadAuthorityKey('scope', signedOut), tileStudentReadAuthorityKey('scope', legacy));
});
test('an authoritative Chromebook owner requires exact binding and explicit handoff from a selected Windows source', () => {
  const legacy = { ...student, realtimeBinding: 'legacy-current', isLoggedIn: true };
  const owner = { transport: 'legacy', realtimeBinding: 'legacy-current' };
  const current = { contextKey: entry.contextKey, browserSources: [], browserOwner: owner };
  const handoff = projectWindowsBrowserStudent(legacy, current, choice(chrome));
  assert.equal(handoff.windowsBrowserMode, true);
  assert.deepEqual(handoff.windowsLegacyHandoff, owner);
  assert.equal(handoff.activeTabTitle, '');
  assert.equal(handoff.selectedWindowsBrowser, null);
  const accepted = { ...owner, scopeKey: windowsBrowserScopeKey(entry.contextKey, student.studentId) };
  assert.equal(projectWindowsBrowserStudent(legacy, current, accepted), legacy);
  assert.equal(projectWindowsBrowserStudent(legacy, current), legacy, 'a fresh view resolves its confirmed current owner');
  const staleAggregate = projectWindowsBrowserStudent({ ...legacy, realtimeBinding: 'legacy-old' }, current, accepted);
  assert.equal(staleAggregate.windowsLegacyHandoff, null);
  assert.equal(staleAggregate.windowsLegacyOwnerPending, true);
  assert.equal(staleAggregate.activeTabTitle, '');
  assert.notEqual(projectWindowsBrowserStudent(legacy, { ...current, unavailable: true }, accepted), legacy);
  const noCurrentOwner = projectWindowsBrowserStudent(legacy, { contextKey: entry.contextKey, platform: 'windows', browserSources: [], windowsSession: { state: 'unavailable' } }, choice(chrome));
  assert.equal(noCurrentOwner.windowsBrowserMode, true);
  assert.equal(noCurrentOwner.windowsLegacyHandoff, null, 'an expired Windows guard never implies a legacy fallback');
});
test('placeholder metadata strips pixels and all tab observations', () => {
  const result = windowsBrowserMetadata({ enabled: true, tiles: [{ studentId: student.studentId, browserSources: [chrome] }] });
  const metadata = result.tiles[0].browserSources[0];
  for (const field of ['screenshot', 'activeTabTitle', 'activeTabUrl', 'tabSnapshot']) assert.equal(metadata[field], undefined);
  assert.equal(metadata.sourceRef, chrome.sourceRef);
  assert.equal(metadata.acceptedCapabilities, chrome.acceptedCapabilities);
});
test('batched selected reads carry exact authority and source revision; hidden source has metadata only', () => {
  const context = { schoolId: 'school', viewerId: 'teacher', authority: { teachingSessionId: 'class' } };
  const [metadata] = createWindowsBrowserRequests([student], context, {});
  const selection = { ...chrome, scopeKey: windowsBrowserScopeKey(metadata.contextKey, student.studentId) };
  const [selected] = createWindowsBrowserRequests([student], context, { [student.studentId]: selection });
  assert.deepEqual(selected.body.selectedSources, [{ studentId: student.studentId, sourceRef: chrome.sourceRef, bindingRevision: 1 }]);
  assert.equal(selected.body.teachingSessionId, 'class');
  assert.equal(createWindowsBrowserRequests([student], context, { [student.studentId]: { ...selection, active: false } })[0].body.selectedSources, undefined);
  assert.equal(createWindowsBrowserRequests([student], { ...context, authority: { teachingSessionId: 'replacement' } }, { [student.studentId]: selection })[0].body.selectedSources, undefined);
});
test('policies fan out by explicit student while tab actions carry only selected exact source', () => {
  const row = projectWindowsBrowserStudent(student, entry, choice(edge));
  const args = { students: [row], authority: { teachingSessionId: 'class' }, legacyEndpoint: '/commands' };
  const request = { teachingSessionId: 'class', targetScope: 'students', targetStudentIds: [student.studentId], commandPayload: {} };
  const policy = partitionWindowsBrowserCommand({ ...args, request: { ...request, commandType: 'lock-screen' } })[0];
  assert.equal(policy.endpoint, '/classpilot/windows/commands');
  assert.equal(policy.body.browserTargets, undefined);
  assert.deepEqual(policy.body.targetStudentIds, [student.studentId]);
  const tab = partitionWindowsBrowserCommand({ ...args, request: { ...request, commandType: 'open-tab' } })[0];
  assert.deepEqual(tab.body.browserTargets, [{ studentId: student.studentId, sourceRef: edge.sourceRef, bindingRevision: 7 }]);
  assert.equal(JSON.stringify(tab).includes('deviceId'), false);
  assert.throws(() => partitionWindowsBrowserCommand({ ...args, students: [projectWindowsBrowserStudent(student, entry)], request: { ...request, commandType: 'open-tab' } }), /Choose a current/);
});
test('mixed Chromebook and Windows request partitions exact targets and tab payloads', () => {
  const legacy = { studentId: 'legacy' };
  const row = projectWindowsBrowserStudent(student, entry, choice(chrome));
  const parts = partitionWindowsBrowserCommand({ students: [legacy, row], authority: { teachingSessionId: 'class' }, legacyEndpoint: '/commands',
    request: { teachingSessionId: 'class', targetScope: 'class', commandType: 'activate-tab', commandPayload: { tabTargets: [
      { studentId: legacy.studentId, tabRef: 'legacy-tab' }, { studentId: student.studentId, tabRef: 'chrome-tab' }] } } });
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.equal(part.body.targetScope, 'students');
    assert.equal(part.body.commandPayload.tabTargets.length, 1);
    assert.equal(part.body.commandPayload.tabTargets[0].studentId, part.body.targetStudentIds[0]);
  }
});
test('nested context partitions retain both command handles and exact source results', () => {
  const command = (id, source) => ({ id, transport: 'windows', commandType: 'lock-screen', targets: [{ studentId: student.studentId, ...source, status: 'sent' }] });
  const inner = combineCommandSettlements([{ status: 'fulfilled', value: { command: command('a', chrome), summary: { requested: 1 } } },
    { status: 'fulfilled', value: { command: command('b', edge), summary: { requested: 1 } } }], [], 'lock-screen');
  const outer = combineCommandSettlements([{ status: 'fulfilled', value: inner }], [], 'lock-screen');
  assert.deepEqual(outer.commands.map(row => row.id), ['a', 'b']);
  assert.equal(outer.command.targets.length, 2);
  assert.equal(outer.summary.requested, 2);
});
test('mixed student tools create one resource for the entire audience; stop stays on unified transport after selection changes', () => {
  const legacy = { studentId: 'legacy' }, row = projectWindowsBrowserStudent(student, entry, choice(chrome));
  for (const commandType of ['timer', 'poll', 'teacher-message', 'lesson-activity']) {
    const args = { students: [legacy, row], authority: { teachingSessionId: 'class' }, legacyEndpoint: '/commands',
      request: { commandType, commandPayload: { action: 'start' } } };
    const parts = partitionWindowsBrowserCommand(args);
    assert.equal(parts.length, 1); assert.equal(parts[0].endpoint, '/classpilot/windows/commands');
    assert.deepEqual(parts[0].body.targetStudentIds, ['legacy', 'student-a']);
    assert.equal(parts[0].body.browserTargets, undefined);
    assert.equal(partitionWindowsBrowserCommand({ ...args, students: [legacy] })[0].endpoint, '/commands');
    assert.equal(partitionWindowsBrowserCommand({ ...args, students: [legacy], preferWindowsTools: true,
      request: { commandType, commandPayload: { action: 'stop' } } })[0].endpoint, '/classpilot/windows/commands');
  }
});
test('all browser policy outcomes must complete before student confirmation; one failure stays visible', async () => {
  const target = (source, status) => ({ ...source, studentId: student.studentId, status, result: { outcome: 'applied' } });
  const command = { id: 'command', targets: [target(chrome, 'completed'), target(edge, 'sent')] };
  assert.equal(classroomStudentTarget(command, student.studentId).status, 'sent');
  const rows = await waitForClassroomTargets(command, [student.studentId], { sleep: async () => {},
    readCommand: async () => ({ command: { ...command, targets: [target(chrome, 'completed'), { ...target(edge, 'failed'), errorMessage: 'Denied' }] } }) });
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error, /Edge: Denied/);
  assert.equal(completedStudentIdsFromCommand({ command: { ...command, targets: rows[0].browserTargets } }).size, 0);
});
test('server-authoritative sign-out completion never overwrites a different browser failure', () => {
  const value = { command: { id: 'signout', commandType: 'student-sign-out', deliveryPolicy: 'server_authoritative', targets: [
    { ...chrome, studentId: student.studentId, status: 'completed', result: { serverAuthoritative: true } },
    { ...edge, studentId: student.studentId, status: 'failed', errorMessage: 'Denied' }] } };
  const tracked = trackTransientCommandResponse(new Map(), value, 'student-sign-out');
  assert.equal(tracked.get('signout').command.targets.find(row => row.sourceRef === edge.sourceRef).status, 'failed');
});
test('later command updates preserve exact browser identity for a shared student', () => {
  const target = (source, status) => ({ ...source, studentId: student.studentId, status, commandId: 'policy' });
  const batch = { command: { id: 'policy', targets: [target(chrome, 'sent'), target(edge, 'sent')] } };
  const [updated] = mergeCommandUpdateIntoBatches([batch], { command: { id: 'policy', targets: [target(chrome, 'completed'), target(edge, 'failed')] } });
  assert.deepEqual(updated.command.targets.map(row => [row.sourceRef, row.status]), [['opaque-chrome', 'completed'], ['opaque-edge', 'failed']]);
});
