// Optional release acceptance against an already reviewed, immutable ClassPilot ZIP.
// Run: node --import ./tests/test-environment.mjs --import tsx scripts/verify-student-classroom-extension.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRequire = createRequire(join(root, 'schoolpilot-app/package.json'));
const { chromium } = frontendRequire('playwright');
const expectedZipHash = 'bf884705903cc8234024933ba5d9ee297dd8a30f56393674655ed07f5963346a';
const zipPath = resolve(process.env.CLASSPILOT_REVIEWED_ZIP || 'C:/GitHub/ClassPilot/dist/ClassPilot-v3.0.7.zip');
const packageReceiptPath = resolve(process.env.CLASSPILOT_REVIEWED_RECEIPT || join(dirname(zipPath), 'ClassPilot-v3.0.7.verification.json'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha256(readFileSync(zipPath)), expectedZipHash, 'Use the exact immutable reviewed 3.0.7 ZIP');
const packageReceipt = JSON.parse(readFileSync(packageReceiptPath, 'utf8'));
assert.equal(packageReceipt.archive.sha256, expectedZipHash);
assert.equal(packageReceipt.sourceRevision, 'b0d644eda4c4974b4cfd1e043ed969737c5a6d51');
assert.equal(packageReceipt.archive.inventory.length, 30);
const ownedRoot = mkdtempSync(join(tmpdir(), 'student-classroom-extension-'));
const extensionPath = join(ownedRoot, 'extension');
mkdirSync(extensionPath);
const receiptPath = resolve(process.env.STUDENT_CLASSROOM_EXTENSION_RECEIPT || join(tmpdir(), `student-classroom-extension-${Date.now()}-${process.pid}.json`));
const contexts = [];
let applicationPools;
const proof = { schemaVersion: 1, startedAt: new Date().toISOString(), zipSha256: expectedZipHash,
  extensionSourceRevision: packageReceipt.sourceRevision, managedChromebookAcceptance: false,
  networkIsolation: 'Synthetic HTTP fulfillment and external DNS disabled; no school/provider traffic', cases: [] };

function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false, 'The extracted package must not contain links');
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`];
  }).sort();
}
async function workerReady(worker) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await worker.evaluate(() => {
      try { return typeof authStateRestorePromise?.then === 'function' && typeof classroomStateRestorePromise?.then === 'function'; }
      catch { return false; }
    }).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The native extension worker did not declare its startup state');
}

try {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:STUDENT_CLASSROOM_NATIVE_ZIP,$env:STUDENT_CLASSROOM_NATIVE_EXTRACT)'],
    { env: { ...process.env, STUDENT_CLASSROOM_NATIVE_ZIP: zipPath, STUDENT_CLASSROOM_NATIVE_EXTRACT: extensionPath } });
  } else execFileSync('unzip', ['-q', zipPath, '-d', extensionPath]);
  assert.deepEqual(files(extensionPath), packageReceipt.archive.inventory.map(entry => entry.file).sort());
  for (const entry of packageReceipt.archive.inventory) {
    assert.ok(!entry.file.includes('..') && !entry.file.includes('\\') && !entry.file.startsWith('/'));
    const bytes = readFileSync(join(extensionPath, entry.file));
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(sha256(bytes), entry.sha256, entry.file);
  }
  assert.equal(JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8')).version, '3.0.7');
  proof.verifiedInventoryFiles = 30;

  // These imported server functions are exercised without a database, Redis or
  // Google credentials. Only the source client's provider responses are fake.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:1/student_classroom_no_queries';
  process.env.REDIS_URL = '';
  const [access, classroom, authority, sourceModule, dispatcher] = await Promise.all([
    import('../src/services/classpilotStudentClassroomAccess.js'),
    import('../src/services/classpilotClassroomState.js'),
    import('../src/services/classpilotCommandAuthority.js'),
    import('../src/services/classpilotStudentClassroomAccessSource.js'),
    import('../src/services/classpilotCommandDispatcher.js'),
  ]);
  applicationPools = await import('../src/db.js');
  const schoolId = 'native-classroom-school';
  const teachingSessionId = 'native-classroom-class';
  const members = [{ suffix: 'a', video: 'dQw4w9WgXcQ' }, { suffix: 'b', video: '9bZkp7q19f0' }];
  const sources = await Promise.all(members.map(async member => ({
    ...await sourceModule.fetchStudentClassroomAccessSource({
      profile: async () => ({ data: { id: `directory-${member.suffix}`, emailAddress: `${member.suffix}@native.example` } }),
      courses: async () => ({ data: { courses: [{ id: `course-${member.suffix}`, courseState: 'ACTIVE' }] } }),
      work: async () => ({ data: { courseWork: [{ id: 'work', state: 'PUBLISHED', materials: [
        { link: { url: `https://work-${member.suffix}.example/assignment?attempt=1` } },
        { youtubeVideo: { id: member.video } },
      ] }] } }),
      materials: async () => ({ data: { courseWorkMaterial: [{ id: 'material', state: 'PUBLISHED', materials: [
        { driveFile: { driveFile: { alternateLink: 'https://docs.google.com/document/d/student-copy/edit' } } },
      ] }] } }),
      announcements: async () => ({ data: { announcements: [{ id: 'stream', state: 'PUBLISHED', text: 'https://www.google.com/search?q=native-private-query' }] } }),
    }, { studentId: `native-student-${member.suffix}`, googleUserId: `directory-${member.suffix}`, schoolDomain: 'native.example' }),
    approvalKey: 'c'.repeat(64),
  })));
  const path = { id: 'native-classroom-path', flightPathName: 'Classroom work', allowedDomains: ['classroom.google.com', 'base-shared.example'], resources: [] };
  const compiled = Object.fromEntries(sources.map(source => [source.studentId, access.compileStudentClassroomFlightPath({ schoolId, flightPath: path, source })]));
  const focused = Object.fromEntries(sources.map(source => [source.studentId, access.createStudentClassroomFocusPayload(schoolId, source)]));
  const capabilities = ['classroomStateV1', 'scopedAuthorityChecksV1', 'preciseRestrictionResourcesV1', 'classroomFocusScopeV1', 'screenOnlyUnlockV1'];
  const delivery = { policy: 'persistent_control', expiresAt: null, requiredCapabilities: ['preciseRestrictionResourcesV1', 'classroomFocusScopeV1'] };
  const commandAuthority = authority.classpilotCommandAuthorityEnvelope({ teachingSessionId });
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
  assert.ok(executablePath, 'An installed real Chrome/Chromium is required');

  for (const member of members) {
    const studentId = `native-student-${member.suffix}`;
    const peer = members.find(value => value !== member);
    const ownHost = `work-${member.suffix}.example`;
    const peerHost = `work-${peer.suffix}.example`;
    let restrictions = classroom.emptyClasspilotRestrictions();
    restrictions.blockList = { active: true, blockedDomains: [`teacher-blocked.${ownHost}`] };
    let revision = 0;
    const makeFrame = (type, selected, map, expiry = new Date(Date.now() + 300_000)) => {
      restrictions = classroom.applyClasspilotControlCommand(restrictions, type, selected);
      const state = { schoolId, studentId, revision: ++revision, teachingSessionId, supervisionContextId: null,
        desiredState: { restrictions }, scheduledEndAt: null, hardExpiresAt: expiry };
      const snapshot = classroom.serializeClasspilotStudentControlState(state);
      const commandId = `native-${member.suffix}-${revision}-${type}`;
      const payload = { ...(map ? type === 'apply-flight-path' ? { flightPathId: path.id } : { url: selected.url } : selected), commandId,
        ...(map ? { classroomAccessV1: access.createStudentClassroomAccessEnvelope({ mode: type === 'apply-flight-path' ? 'flight-path' : 'focus', payloadByStudent: map }) } : {}) };
      const target = { schoolId, studentId, studentSessionId: `native-login-${member.suffix}`, deviceId: `native-device-${member.suffix}`,
        studentName: 'Synthetic student', available: true, controlRevision: revision };
      const frame = dispatcher.classpilotCommandFrameForTarget(schoolId, type, type, payload, target, delivery, snapshot, commandAuthority);
      assert.ok(frame, `Canonical framing refused ${type}`);
      const serialized = JSON.stringify(frame);
      for (const privateValue of ['classroomAccessV1', 'classroomMaterials', 'approvalKey', 'payloadByStudent', 'directory-', 'native-private-query', `native-student-${peer.suffix}`, peerHost])
        assert.equal(serialized.includes(privateValue), false, `Private or peer source leaked into ${type}: ${privateValue}`);
      if (map) assert.equal(dispatcher.classpilotCommandFrameForTarget(schoolId, type, type, payload, target, delivery, undefined, commandAuthority), null, 'Derived commands must not frame without their authoritative state');
      return frame;
    };
    const frames = {
      path: makeFrame('apply-flight-path', compiled[studentId], compiled),
      classroomFocus: makeFrame('lock-screen', focused[studentId], focused),
      stopClassroomFocus: makeFrame('unlock-screen', { screenOnly: true }),
      ordinaryFocus: makeFrame('lock-screen', { url: 'https://focus.example/' }),
      stopOrdinaryFocus: makeFrame('unlock-screen', { screenOnly: true }),
      remove: makeFrame('remove-flight-path', {}),
      restorePath: makeFrame('apply-flight-path', compiled[studentId], compiled),
    };
    const bare = makeFrame('apply-flight-path', compiled[studentId], compiled);
    delete bare.classroomState; // Deliberate transport corruption, not a valid server frame.
    const profile = join(ownedRoot, `profile-${member.suffix}`);
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
      args: ['--headless=new', '--enable-automation', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    contexts.push(context);
    await context.route(/^https?:\/\//, route => route.fulfill({ status: route.request().isNavigationRequest() ? 200 : 503,
      contentType: route.request().isNavigationRequest() ? 'text/html' : 'application/json',
      body: route.request().isNavigationRequest() ? '<!doctype html><html><body><h1 data-native-assignment>Controlled native assignment</h1></body></html>' : '{}' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await workerReady(worker);
    const native = await worker.evaluate(async ({ frames, bare, capabilities, studentId, suffix, ownHost, peerHost, ownVideo, peerVideo, schoolId, teachingSessionId }) => {
      const require = (condition, message) => { if (!condition) throw new Error(`[student-classroom-native] ${message}`); };
      const until = async (predicate, message) => { const deadline = Date.now() + 20_000; while (!await predicate()) { require(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); } };
      await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
      await until(() => workerWakeSettled, 'worker startup did not settle');
      CONFIG.autoRegistrationPaused = true;
      if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
      advanceStudentAuthMutationGeneration();
      Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId, deviceId: `native-device-${suffix}`, activeStudentId: studentId,
        activeStudentSessionId: `native-login-${suffix}`, studentToken: 'synthetic-native-token', identitySource: 'integration_test' });
      studentAuthInvalidating = false; studentAuthCommitPending = false;
      activateAuthenticatedContext('student-classroom-native-auth');
      const auth = captureAuthenticatedContext('student Classroom native fixture');
      adoptLicenseState(true, 'active', auth);
      const settings = { enableTrackingHours: false, afterHoursMode: 'off' };
      await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: settings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolPolicyScopeForAuthContext(auth), [SCHOOL_SETTINGS_FETCHED_AT_KEY]: Date.now() });
      await loadCachedSchoolSettings({ authContext: auth });
      trackingState = TRACKING_STATES.ACTIVE;
      fetchWithBackoff = async () => new Response('{}', { status: 503 }); sendHeartbeat = async () => {}; connectWebSocket = async () => {};
      recoverOffscreenWebSocketStatus = async () => true;
      if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
      scheduleEventHeartbeat = () => {}; enqueueMonitoringEvent = async () => {}; scheduleClassroomStateSideEffects = () => {};
      scheduleHeartbeat(null); await chrome.alarms.clearAll();
      currentFabState = { teachingSessionId, activeSessionIds: [teachingSessionId] };
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: capabilities }, auth);
      const acks = []; wsConnected = true; wsSend = value => { acks.push(value); return true; };
      globalBlockedDomains = [`school-blocked.${ownHost}`]; await composeDynamicRules(['school']);
      const matcher = url => RuntimeCore.decideNavigation(url, { classroomState: runtimeClassroomStateForRules(), globalBlockedDomains: [...globalBlockedDomains] }).allowed;
      const nativeAction = async url => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const result = await chrome.declarativeNetRequest.testMatchOutcome({ url, type: 'main_frame' });
        const matching = result.matchedRules.map(match => rules.find(rule => rule.id === match.ruleId)).filter(Boolean);
        matching.sort((a, b) => b.priority - a.priority || (a.action.type === 'allow' ? -1 : 1));
        return matching[0]?.action.type || 'none';
      };
      const install = async frame => {
        observeExactStudentControlRevision(frame, auth, 'synthetic canonical server frame');
        await handleWsMessage(JSON.stringify(frame), wsConnectionGeneration, auth);
        require(acks.some(ack => ack.commandId === frame.commandId && ack.ackState === 'completed' && ack.outcome === 'applied'), `canonical ${frame.command.type} failed: ${JSON.stringify(acks.slice(-2))}`);
      };
      const own = [`https://${ownHost}/work?attempt=2`, 'https://docs.google.com/document/d/student-copy/edit', `https://www.youtube.com/watch?v=${ownVideo}`];
      const denied = [`https://${peerHost}/work`, `https://www.youtube.com/watch?v=${peerVideo}`, 'https://www.google.com/search?q=answers', 'https://www.google.co.uk/search?q=answers',
        'https://unassigned.example/', `https://teacher-blocked.${ownHost}/`, `https://school-blocked.${ownHost}/`];
      const checkOwn = async label => {
        for (const url of own) { require(matcher(url), `${label}: own matcher denied work`); require(await nativeAction(url) !== 'block', `${label}: own native rule denied work`); }
        for (const url of denied) { require(!matcher(url), `${label}: matcher admitted peer/Search/blocked destination`); require(await nativeAction(url) === 'block', `${label}: native rule admitted peer/Search/blocked destination`); }
      };
      await install(frames.path); await checkOwn('compiled Flight Path');
      require(matcher('https://base-shared.example/retained'), 'Flight Path lost its explicitly saved website');
      await install(frames.classroomFocus); await checkOwn('Classroom Focus');
      require(!matcher('https://base-shared.example/retained'), 'Classroom Focus did not overlay the saved path');
      const focusStored = persistedClassroomStateSnapshot(currentClassroomState);
      require(focusStored.schemaVersion === 4, 'Classroom Focus lost schema4 downgrade protection');
      const focusRestored = RuntimeCore.normalizePersistedClassroomState(focusStored);
      require(focusRestored.restrictions.flightPath.resources.length > 0, 'Focus restore dropped the underlying video restriction');
      await install(frames.stopClassroomFocus); await checkOwn('screen-only Classroom Unfocus');
      require(matcher('https://base-shared.example/retained'), 'Classroom Unfocus lost the saved path');
      await install(frames.ordinaryFocus);
      require(matcher('https://focus.example/work') && !matcher(own[0]), 'ordinary Focus did not temporarily override the Classroom Flight Path');
      await install(frames.stopOrdinaryFocus); await checkOwn('screen-only ordinary Unfocus');
      await install(frames.remove);
      require(!flightPathIsActive(), 'Flight Path removal left the derived policy active');
      require((await chrome.declarativeNetRequest.getDynamicRules()).filter(rule => RuntimeCore.isRuleInRange(rule.id, 'classroom')).length === 0, 'Flight Path removal left native allows/blocks');
      await install(frames.restorePath); await checkOwn('reapplied Flight Path');
      const stored = persistedClassroomStateSnapshot(currentClassroomState);
      require(stored.schemaVersion === 2 && stored.precisePersistenceVersion === 1, 'compiled Flight Path lost its existing precise persistence fence');
      const restored = RuntimeCore.normalizePersistedClassroomState(stored);
      require((await applyClassroomState(restored, { authContext: auth, trustedPersistedRestrictionSso: true, force: true })).outcome === 'applied', 'owned persisted path could not restore');
      await checkOwn('persisted Flight Path restore');
      const accepted = JSON.stringify(currentClassroomState);
      observeExactStudentControlRevision(bare, auth, 'deliberately corrupted missing snapshot');
      await handleWsMessage(JSON.stringify(bare), wsConnectionGeneration, auth);
      require(acks.some(ack => ack.commandId === bare.commandId && ack.ackState === 'failed'), 'native client accepted a resource path without its state');
      require(JSON.stringify(currentClassroomState) === accepted, 'missing snapshot changed accepted restriction state');
      globalThis.__studentClassroomNative = { auth, install, matcher, nativeAction, checkOwn, until };
      return { ownChecks: own.length, deniedChecks: denied.length, compiledFlightPath: true, classroomFocus: true,
        schoolAndTeacherPriority: true, bothFocusOverlays: true, screenOnlyUnfocusRestoresPath: true,
        removalClearsRules: true, storageSchema: stored.schemaVersion, ownedRestore: true, snapshotRequired: true };
    }, { frames, bare, capabilities, studentId, suffix: member.suffix, ownHost, peerHost, ownVideo: member.video, peerVideo: peer.video, schoolId, teachingSessionId });

    const assignment = await context.newPage();
    await assignment.goto(`https://${ownHost}/assignment`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    assert.match(await assignment.content(), /data-native-assignment/);
    await assignment.close();
    const newTabResults = [];
    for (const url of ['https://www.google.com/search?q=answers', `https://${peerHost}/assignment`]) {
      const tab = await context.newPage();
      let loaded = false;
      try { await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 }); loaded = !tab.isClosed() && (await tab.content()).includes('data-native-assignment'); }
      catch { /* Native blocking or owned-tab removal is the intended result. */ }
      assert.equal(loaded, false, 'A new tab reached Google Search or peer-only work');
      newTabResults.push({ destination: new URL(url).hostname, blocked: true });
      if (!tab.isClosed()) await tab.close();
    }
    const expiryFrame = makeFrame('apply-flight-path', compiled[studentId], compiled, new Date(Date.now() + 2500));
    const expired = await worker.evaluate(async frame => {
      const fixture = globalThis.__studentClassroomNative;
      await fixture.install(frame);
      await fixture.until(() => currentClassroomState?.expiryReason === 'hard_expiry', 'the native hard-expiry timer did not clear the path');
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      if (flightPathIsActive() || screenLocked || rules.some(rule => RuntimeCore.isRuleInRange(rule.id, 'classroom'))) throw new Error('Hard expiry retained derived Classroom permissions');
      return { hardExpiryClearsRules: true };
    }, expiryFrame);
    proof.cases.push({ student: member.suffix, browser: context.browser().version(), ...native, ownNewTabLoaded: true, newTabResults, ...expired,
      serverFramesSha256: sha256(JSON.stringify({ frames, bare, expiryFrame })), wirePrivateMetadataAbsent: true });
    await context.close();
    contexts.splice(contexts.indexOf(context), 1);
  }
  proof.passed = true;
} catch (error) {
  proof.passed = false;
  proof.failure = error instanceof Error ? error.message : 'Native acceptance failed';
  throw error;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (applicationPools) await Promise.all([applicationPools.pool.end(), applicationPools.sessionPool.end()]);
  proof.completedAt = new Date().toISOString();
  proof.zipUnchanged = sha256(readFileSync(zipPath)) === expectedZipHash;
  writeFileSync(receiptPath, `${JSON.stringify(proof, null, 2)}\n`);
  assert.equal(proof.zipUnchanged, true, 'The reviewed archive changed during acceptance');
  assert.equal(lstatSync(ownedRoot).isSymbolicLink(), false);
  assert.ok(realpathSync(ownedRoot).startsWith(`${realpathSync(tmpdir())}${sep}`));
  assert.ok(relative(tmpdir(), ownedRoot).startsWith('student-classroom-extension-'));
  rmSync(ownedRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ receiptPath, ...proof }, null, 2));
}
