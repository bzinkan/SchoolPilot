import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CP_PROTECTED_BINDING_ID, CP_PROTECTED_SOURCE, CP_PROTECTED_SOURCE_REVIEW, CP_PROTECTED_PREPARATION_CHECKS,
  SUCCESSOR_BINDING_ID, BINDING_FILES, bindingSchema, bindingHash, validateReviewedProtectedDelta,
  validateSuccessorPreparation, validateSuccessorProfile, validateProtectedExecutionEvidence, validateProtectedBuildDependencyAudit, resolveReleaseBinding, successorArtifactPair, bindingForRole,
  assertBoundPublication, assertBoundScan, assertBindingReplay } from '../scripts/release-source-binding.mjs';
import { FALLBACK, createPlan, createAnchor128Plan, retainSuccessorRegistration } from '../scripts/register-compatible-fallback-inactive.mjs';
import { planPublication, planUnused121 } from '../scripts/prepare-release-artifacts.mjs';
import { CP_PROTECTED_ACCEPTANCE_ID, ACCEPTANCE_SUCCESSOR_ID, ACCEPTANCE_CANDIDATE_IDENTITIES,
  ACCEPTANCE_BASELINE, ACCEPTANCE_BASELINE_IMAGE, ACCEPTANCE_FALLBACK_IDENTITIES, FIXED_ORDER,
  SUCCESSOR_PROFILES, assertAcceptanceSuccessorIdentity, assertProtectedAcceptanceBuildSecurity } from '../scripts/load/usage/release-gates-v2/acceptance-successor.mjs';
import { profileHash } from '../scripts/load/usage/release-gates-v2/contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = { schemaVersion: 4, releaseBindingId: CP_PROTECTED_BINDING_ID };
const shipped = JSON.parse(readFileSync(path.join(root, BINDING_FILES[CP_PROTECTED_BINDING_ID])));
const digest = value => 'sha256:' + bindingHash(value);

test('schema4 admits one exact ID and preserves previous version/ID pairs', () => {
  assert.equal(bindingSchema(input), 4);
  for (const change of [{ releaseBindingId: 'unknown' }, { releaseBindingId: SUCCESSOR_BINDING_ID }, { schemaVersion: 3 }, { artifactSource: CP_PROTECTED_SOURCE }]) {
    assert.throws(() => bindingSchema({ ...input, ...change }));
  }
  assert.equal(bindingSchema({ schemaVersion: 1 }), 1);
  assert.equal(bindingSchema({ schemaVersion: 2, releaseBindingId: 'release-297-current-school-v2' }), 2);
  assert.equal(bindingSchema({ schemaVersion: 3, releaseBindingId: SUCCESSOR_BINDING_ID }), 3);
  assert.throws(() => bindingSchema({ schemaVersion: 1, releaseBindingId: CP_PROTECTED_BINDING_ID }));
});

test('pending v4 operational Plans and preparation fail before Git, cloud or output writes', async () => {
  const calls = [], run = async (...args) => { calls.push(args); throw new Error('must reject before external work'); };
  for (const operation of [planPublication, planUnused121, createPlan, createAnchor128Plan]) {
    await assert.rejects(operation({ ...input, kind: 'serving-anchor', status: 'accepted', passed: true }, { run }), /SUCCESSOR_PREPARATION_PENDING|SUCCESSOR_SELECTION_PENDING|RELEASE_BINDING_EVIDENCE_PENDING/);
  }
  await assert.rejects(validateSuccessorPreparation(input, { root, run, fallback: FALLBACK }), /SUCCESSOR_PREPARATION_PENDING/);
  await assert.rejects(resolveReleaseBinding(input, { root, run, fallback: FALLBACK }), /SUCCESSOR_PREPARATION_PENDING/);
  assert.deepEqual(calls, []);
  assert.equal(shipped.successorSelection.status, 'pending');
  assert.equal(shipped.operationalAuthorization, false);
});

test('reviewed F2 delta is explicit and cannot include dependencies, schema or restriction matching', () => {
  assert.equal(CP_PROTECTED_SOURCE, '6259e768553e55346ba14a6453340772198a3d6b');
  assert.equal(CP_PROTECTED_SOURCE_REVIEW.baseline, 'd75fc1c48d0a3918857508d3965904c69023a153');
  assert.equal(CP_PROTECTED_SOURCE_REVIEW.source, CP_PROTECTED_SOURCE);
  assert.equal(CP_PROTECTED_SOURCE_REVIEW.files.length, 8);
  assert.equal(CP_PROTECTED_SOURCE_REVIEW.patchSha256, '488454d7ac7b2cb754ea91acdad8c01d345a720e0754d5ec271720eb35df32ac');
  assert.deepEqual(shipped.sourceDelta, CP_PROTECTED_SOURCE_REVIEW);
  assert.equal(shipped.credentialBoundary.retainedOnRollback, true);
  assert.equal(shipped.credentialBoundary.policy, 'classpilot-ai-request-input-2026-10-08.1');
  for (const item of CP_PROTECTED_SOURCE_REVIEW.files) {
    assert.ok(item.path.startsWith('tests/') || ['src/services/aiClassification.ts', 'src/services/classpilotAiRequestInput.ts'].includes(item.path));
    assert.equal(item.after.mode, '100644'); assert.match(item.after.object, /^[a-f0-9]{40}$/);
  }
  assert.deepEqual(Object.keys(shipped.preparation.evidence).sort(), Object.keys(CP_PROTECTED_PREPARATION_CHECKS).sort());
});

test('real temporary Git proves a reviewed nonempty source delta and rejects extra paths, blobs, modes and patch substitution', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'sp-cp-protected-git-'));
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  const run = async (executable, args) => ({ code: 0, stdout: execFileSync(executable, args, { encoding: 'utf8', windowsHide: true }), stderr: '' });
  const write = (name, bytes) => { const file = path.join(directory, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
  const commit = () => { git(['add', '.']); git(['-c', 'core.hooksPath=NUL', 'commit', '-qm', 'Synthetic reviewed source fixture']); return git(['rev-parse', 'HEAD']).trim(); };
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
    write('src/services/aiClassification.ts', 'export const providerInput = "original";\n'); write('Dockerfile', 'FROM synthetic.invalid/base\n');
    const baseline = commit();
    write('src/services/aiClassification.ts', 'export const providerInput = "prepared";\n'); write('src/services/classpilotAiRequestInput.ts', 'export const policy = "synthetic-credential-boundary";\n');
    const source = commit();
    const entry = (ref, name) => { const line = git(['ls-tree', ref, '--', name]).trim(), match = /^(\d{6}) blob ([a-f0-9]{40})\t/.exec(line); return line ? { mode: match[1], object: match[2] } : null; };
    const review = { baseline, source, files: ['src/services/aiClassification.ts', 'src/services/classpilotAiRequestInput.ts'].map(name => ({ path: name, before: entry(baseline, name), after: entry(source, name) })), patchSha256: bindingHash(git(['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', baseline, source])) };
    assert.deepEqual(await validateReviewedProtectedDelta(directory, review, run), review);
    const patchSwap = { ...review, patchSha256: bindingHash('not the reviewed patch') };
    await assert.rejects(validateReviewedProtectedDelta(directory, patchSwap, run), /CP_PROTECTED_REVIEWED_PATCH_CHANGED/);
    const blobSwap = structuredClone(review); blobSwap.files[0].after.object = 'a'.repeat(40);
    await assert.rejects(validateReviewedProtectedDelta(directory, blobSwap, run), /CP_PROTECTED_REVIEWED_BLOB_CHANGED/);
    const modeSwap = structuredClone(review); modeSwap.files[0].after.mode = '100755';
    await assert.rejects(validateReviewedProtectedDelta(directory, modeSwap, run), /CP_PROTECTED_REVIEWED_BLOB_CHANGED/);
    write('Dockerfile', 'FROM unreviewed.invalid/substitution\n'); const extra = commit();
    await assert.rejects(validateReviewedProtectedDelta(directory, { ...review, source: extra }, run), /CP_PROTECTED_SOURCE_DELTA_EXCEEDED/);
  } finally {
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('sp-cp-protected-git-'));
    rmSync(resolved, { recursive: true });
  }
});

test('schema4 publication, scan and replay preserve separate artifact roles and pair bindings', () => {
  const pair = { 'serving-anchor': { source: 'a'.repeat(40), localIndex: digest('anchor'), config: digest('anchor-config'), platform: digest('anchor-platform'), archiveSha256: bindingHash('anchor-archive') },
    fallback: { source: CP_PROTECTED_SOURCE, localIndex: digest('fallback'), config: digest('fallback-config'), platform: digest('fallback-platform'), archiveSha256: bindingHash('fallback-archive') } };
  const binding = { id: CP_PROTECTED_BINDING_ID, schemaVersion: 4, sha256: bindingHash('binding'), validatorSha256: bindingHash('validator'), artifactPair: pair };
  const anchor = bindingForRole(binding, 'serving-anchor'), fallback = bindingForRole(binding, 'fallback');
  assert.equal(anchor.artifactSource, pair['serving-anchor'].source); assert.equal(fallback.artifactSource, CP_PROTECTED_SOURCE);
  assert.deepEqual(successorArtifactPair({ artifacts: pair }), pair);
  const receipt = { schemaVersion: 4, releaseBinding: fallback, artifactSource: CP_PROTECTED_SOURCE, artifactRole: 'fallback', source: CP_PROTECTED_SOURCE,
    registryDigest: pair.fallback.platform, status: 'published', publicationOutcomeUncertain: false, operation: 'PublishImage', servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0 };
  assertBoundPublication(receipt, fallback, CP_PROTECTED_SOURCE, pair.fallback.platform);
  assert.throws(() => assertBoundPublication({ ...receipt, artifactRole: 'serving-anchor' }, fallback, CP_PROTECTED_SOURCE, pair.fallback.platform));
  assert.throws(() => assertBoundPublication({ ...receipt, releaseBinding: anchor }, fallback, CP_PROTECTED_SOURCE, pair.fallback.platform));
  assertBoundScan({ sourceSha: CP_PROTECTED_SOURCE, imageId: pair.fallback.localIndex, configDigest: pair.fallback.config, passed: true }, fallback);
  assert.throws(() => assertBoundScan({ sourceSha: pair['serving-anchor'].source, imageId: pair['serving-anchor'].localIndex, configDigest: pair['serving-anchor'].config, passed: true }, fallback));
  assert.throws(() => assertBindingReplay(input, fallback, { ...fallback, validatorSha256: bindingHash('changed validator') }));
  assert.throws(() => assertBindingReplay(input, fallback, { ...fallback, sha256: bindingHash('cross binding') }));
});

test('schema4 partial registration retains returned identities before certainty is known', () => {
  const result = { schemaVersion: 4, registered: [], registrationOutcomeUncertain: true };
  const family = 'schoolpilot-production-api-emergency';
  const arn = `arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:201`;
  assert.equal(retainSuccessorRegistration(result, 'api', { taskDefinition: { taskDefinitionArn: arn, family } }, bindingHash('request'), family), arn);
  assert.equal(result.registered[0].arn, arn);
  assert.equal(retainSuccessorRegistration(result, 'worker', { taskDefinition: { taskDefinitionArn: 'unexpected-but-returned-identity' } }, bindingHash('worker-request'), 'schoolpilot-production-scheduler-worker'), 'unexpected-but-returned-identity');
  assert.equal(result.registered[1].arn, 'unexpected-but-returned-identity'); assert.equal(result.registrationOutcomeUncertain, true);
});

test('v4 replays actual native execution identity, timing, isolated network and graceful cleanup', () => {
  const execution = { schemaVersion: 1, kind: 'release297_successor_independent_native_execution', source: CP_PROTECTED_SOURCE,
    image: shipped.fallback.localIndex, artifactRole: 'fallback', syntheticFixturesOnly: true, productionMutations: 0, providerRequests: 0,
    startedAt: '2026-10-08T23:40:16.081Z', completedAt: '2026-10-08T23:40:21.473Z', passed: true,
    resources: { network: 'none' }, exit: { attachCode: 0, daemonExitCode: 0, running: false, oomKilled: false }, cleanup: { forced: false, containerAbsent: true } };
  const native = { observedAtUtc: '2026-10-08T23:41:00Z' };
  for (const key of ['screenshotRuntime', 'requestIpRateLimit']) {
    validateProtectedExecutionEvidence(execution, native, shipped, key);
    for (const [mutate, expected] of [
      [value => { value.startedAt = '2026-10-08T22:00:00Z'; }, /RAW_EXECUTION_STALE/],
      [value => { value.completedAt = native.observedAtUtc + 'invalid'; }, /RAW_EXECUTION_STALE/],
      [value => { value.completedAt = '2026-10-08T23:42:00Z'; }, /RAW_EXECUTION_STALE/],
      [value => { value.source = shipped.previousFallback.source; }, /RAW_EXECUTION_ROLE_CHANGED/],
      [value => { value.image = shipped.artifacts['serving-anchor'].localIndex; }, /RAW_EXECUTION_ROLE_CHANGED/],
      [value => { value.artifactRole = 'serving-anchor'; }, /RAW_EXECUTION_ROLE_CHANGED/],
      [value => { value.syntheticFixturesOnly = false; }, /RAW_EXECUTION_ROLE_CHANGED/],
      [value => { value.productionMutations = 1; }, /RAW_EXECUTION_ROLE_CHANGED/],
      [value => { value.providerRequests = 1; }, /EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN/],
      [value => { value.externalProviderRequests = 1; }, /EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN/],
      [value => { value.exit.oomKilled = true; }, /NATIVE_EXIT_REQUIRED/],
      [value => { value.exit.daemonExitCode = 137; }, /NATIVE_EXIT_REQUIRED/],
      [value => { value.exit.running = true; }, /NATIVE_EXIT_REQUIRED/],
      [value => { value.resources.network = 'bridge'; }, /NATIVE_NETWORK_REQUIRED/],
      [value => { value.cleanup.forced = true; }, /RAW_EXECUTION_FORCED/],
      [value => { value.cleanup.containerAbsent = false; }, /RAW_EXECUTION_CLEANUP_REQUIRED/],
      [value => { value.passed = false; }, /RAW_EXECUTION_FAILED/],
    ]) { const changed = structuredClone(execution); mutate(changed); assert.throws(() => validateProtectedExecutionEvidence(changed, native, shipped, key), expected); }
  }
});

test('v4 compiled credential evidence permits intercepted requests but forbids external calls, wrong pair and incomplete test execution', () => {
  const execution = { schemaVersion: 1, kind: 'release297_f2_image_credential_boundary', releaseBindingId: CP_PROTECTED_BINDING_ID, source: CP_PROTECTED_SOURCE,
    image: shipped.fallback.localIndex, artifactRole: 'fallback', syntheticFixturesOnly: true, productionMutations: 0, externalProviderRequests: 0,
    startedAtUtc: '2026-10-08T23:40:28.678Z', completedAtUtc: '2026-10-08T23:40:30.326Z', passed: true,
    actualCompiledClassifier: true, syntheticProviderInterceptPassed: true, tests: 53, passedTests: 53, failedTests: 0, skippedTests: 0,
    interceptedSyntheticRequests: 14, cleanup: { forced: false, containerAbsent: true, exitCode: 0, oomKilled: false, unforcedRemoval: true } };
  const native = { observedAtUtc: '2026-10-08T23:41:00Z' };
  validateProtectedExecutionEvidence(execution, native, shipped, 'credentialBoundary');
  for (const [mutate, expected] of [
    [value => { value.externalProviderRequests = 1; }, /EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN/],
    [value => { value.providerRequests = 1; }, /EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN/],
    [value => { value.releaseBindingId = SUCCESSOR_BINDING_ID; }, /COMPILED_BOUNDARY_REQUIRED/],
    [value => { value.actualCompiledClassifier = false; }, /COMPILED_BOUNDARY_REQUIRED/],
    [value => { value.source = shipped.previousFallback.source; }, /RAW_EXECUTION_ROLE_CHANGED/],
    [value => { value.artifactRole = 'serving-anchor'; }, /RAW_EXECUTION_ROLE_CHANGED/],
    [value => { value.startedAtUtc = '2026-10-08T23:30:00Z'; }, /RAW_EXECUTION_STALE/],
    [value => { value.tests = 0; value.passedTests = 0; }, /COMPILED_BOUNDARY_TESTS_FAILED/],
    [value => { value.passedTests = 52; }, /COMPILED_BOUNDARY_TESTS_FAILED/],
    [value => { value.failedTests = 1; }, /COMPILED_BOUNDARY_TESTS_FAILED/],
    [value => { value.skippedTests = 1; }, /COMPILED_BOUNDARY_TESTS_FAILED/],
    [value => { value.cleanup.exitCode = 1; }, /COMPILED_BOUNDARY_CLEANUP_FAILED/],
    [value => { value.cleanup.oomKilled = true; }, /COMPILED_BOUNDARY_CLEANUP_FAILED/],
    [value => { value.cleanup.unforcedRemoval = false; }, /COMPILED_BOUNDARY_CLEANUP_FAILED/],
  ]) { const changed = structuredClone(execution); mutate(changed); assert.throws(() => validateProtectedExecutionEvidence(changed, native, shipped, 'credentialBoundary'), expected); }
});

test('protected acceptance has a separate allowlist and cannot reuse the old F1 pair', () => {
  const at = Date.parse('2026-10-09T00:00:00Z');
  const binding = { schemaVersion: 1, id: ACCEPTANCE_SUCCESSOR_ID, kind: 'current_school_acceptance_successor_preparation', preparationReviewed: true, localSyntheticOnly: true, operationalAuthorization: false, releaseReady: false,
    candidate: { ...ACCEPTANCE_CANDIDATE_IDENTITIES }, baseline: { source: ACCEPTANCE_BASELINE, image: ACCEPTANCE_BASELINE_IMAGE }, fallback: { ...ACCEPTANCE_FALLBACK_IDENTITIES }, audience: 'DeSales', clients: 133, extensionVersion: '2.9.7',
    order: [...FIXED_ORDER], profiles: Object.fromEntries(SUCCESSOR_PROFILES.map(value => [value.name, profileHash(value)])), evidenceNotBefore: '2026-10-08T22:00:00Z', recordedAt: '2026-10-08T23:00:00Z', validity: { startsAt: '2026-10-08T23:00:00Z', expiresAt: '2026-10-09T23:00:00Z' } };
  assert.equal(assertAcceptanceSuccessorIdentity(binding, at), true);
  assert.throws(() => assertAcceptanceSuccessorIdentity({ ...binding, id: CP_PROTECTED_ACCEPTANCE_ID, releaseBindingId: CP_PROTECTED_BINDING_ID, credentialBoundaryRetainedOnRollback: true }, at));
  assert.throws(() => assertAcceptanceSuccessorIdentity({ ...binding, id: 'arbitrary pair' }, at));
  const file = path.join(root,BINDING_FILES[CP_PROTECTED_BINDING_ID]);
  assert.throws(()=>assertProtectedAcceptanceBuildSecurity({harness:{directory:root},releaseSourceBinding:{file,sha256:bindingHash(readFileSync(file))}}),/CP_PROTECTED_ACCEPTANCE_PREPARATION_PENDING/);
  assert.throws(()=>assertProtectedAcceptanceBuildSecurity({harness:{directory:root},releaseSourceBinding:{file:'substituted.json',sha256:'a'.repeat(64)}}),/CP_PROTECTED_ACCEPTANCE_PROFILE_SUBSTITUTED/);
});

test('known development audit failure cannot be cleared by flipping preparation or audit status', () => {
  const profile = structuredClone(shipped); profile.preparation.status = 'passed';
  assert.throws(() => validateSuccessorProfile(profile, FALLBACK), /CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED/);
  profile.buildDependencyAudit.status = 'passed';
  const audit = { auditReportVersion: 2, vulnerabilities: { braces: { severity: 'high' } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 7, high: 6, critical: 0, total: 13 } } };
  const sourceChecks = { schemaVersion: 1, evidenceKind: 'protected-fallback-source-checks', source: CP_PROTECTED_SOURCE, cleanSource: true,
    checks: { fullDependencyAudit: { status: 'failed', exitCode: 1, high: 6, critical: 0, evidence: { sha256: profile.buildDependencyAudit.audit.sha256 } } } };
  assert.throws(() => validateProtectedBuildDependencyAudit(audit, sourceChecks, profile), /CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED/);
  Object.assign(sourceChecks.checks.fullDependencyAudit, { status: 'passed', exitCode: 0, high: 0 });
  assert.throws(() => validateProtectedBuildDependencyAudit(audit, sourceChecks, profile), /CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED/);
  const syntheticPassedAudit = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
  validateProtectedBuildDependencyAudit(syntheticPassedAudit, sourceChecks, profile);
  for (const mutate of [value => { value.source = shipped.previousFallback.source; }, value => { value.lockfileGitBlob = 'f'.repeat(40); }, value => { value.inventory.sha256 = 'f'.repeat(64); }]) {
    const changed = structuredClone(profile); mutate(changed.buildDependencyAudit);
    assert.throws(() => validateProtectedBuildDependencyAudit(syntheticPassedAudit, sourceChecks, changed), /CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED/);
  }
  sourceChecks.source = shipped.previousFallback.source;
  assert.throws(() => validateProtectedBuildDependencyAudit(syntheticPassedAudit, sourceChecks, profile), /CP_PROTECTED_BUILD_SOURCE_CHECKS_REQUIRED/);
});

function recoveryExecutionFixture() {
  const execution = { schemaVersion:1, source:shipped.applicationSource, releaseBindingId:CP_PROTECTED_BINDING_ID, productionMutations:0, capacityAccepted:false,
    actualApiWorkerProcesses:true, syntheticSchemaOnly:true, operationalAuthorization:false, releaseReady:false, providerAccessDisabled:true, completedInsideAuthorizedWindow:true,
    startedAt:'2026-10-08T23:49:44.174Z', completedAt:'2026-10-08T23:53:30.278Z', passed:true, cleanupPassed:true, gracefulCleanupPassed:true, networkCleanupPassed:true, localAdmissionFloorVerified:true,
    admissionChain:[121,125,126,127,128,129].map(count => ({count})), sourceSpecificNative:{baseline:{nativeCompletedMigrations:Array.from({length:43},(_,i)=>i)},candidate:{nativeCompletedMigrations:Array.from({length:53},(_,i)=>i)}},services:[],drains:[] };
  for (const phase of ['bridge128','adopt129','fallback129','return129']) for (const service of ['api','worker']) {
    const artifact = shipped.artifacts[phase === 'fallback129' ? 'fallback' : 'serving-anchor'], containerId = bindingHash(`synthetic-${phase}-${service}`);
    execution.services.push({phase,service,containerId,source:artifact.source,image:artifact.localIndex,inventoryCount:phase === 'bridge128' ? 128:129,privateEnabled:phase === 'adopt129',...(service==='api'?{readyzStatus:200}:{})});
    execution.drains.push({phase,service,containerId,sourceImage:artifact.localIndex,exitCode:0,oomKilled:false,forced:false,sqlConnections:0});
  }
  return execution;
}
test('v4 ordinary raw recovery replays all eight exact role-bound services and rejects historical54 or failed drains', () => {
  const execution = recoveryExecutionFixture(), native = {observedAtUtc:'2026-10-08T23:59:00Z'};
  validateProtectedExecutionEvidence(execution,native,shipped,'ordinaryRecovery');
  for (const [mutate,expected] of [
    [value=>{value.sourceSpecificNative.candidate.nativeCompletedMigrations.push(53);},/RAW_ORDINARY_MIGRATIONS_CHANGED/],
    [value=>{value.services[4].source=shipped.previousFallback.source;},/RAW_SERVICE_ROLE_CHANGED/],
    [value=>{value.services[4].image=shipped.artifacts['serving-anchor'].localIndex;},/RAW_SERVICE_ROLE_CHANGED/],
    [value=>{value.services.pop();},/ACTUAL_SERVICE_PAIRS_REQUIRED/],
    [value=>{value.services[1].service='api';},/ACTUAL_SERVICE_PAIRS_REQUIRED/],
    [value=>{for(const row of [...value.services,...value.drains])row.containerId='a'.repeat(64);},/ACTUAL_SERVICE_IDS_REQUIRED/],
    [value=>{value.services[0].containerId='malformed';},/ACTUAL_SERVICE_IDS_REQUIRED/],
    [value=>{value.drains[0].sqlConnections=1;},/RAW_SERVICE_DRAIN_FAILED/],
    [value=>{value.drains[0].forced=true;},/RAW_SERVICE_DRAIN_FAILED/],
    [value=>{value.drains[0].oomKilled=true;},/RAW_SERVICE_DRAIN_FAILED/],
    [value=>{value.admissionChain[3].count=128;},/RAW_ADMISSION_CHANGED/],
    [value=>{value.providerAccessDisabled=false;},/RAW_RECOVERY_IDENTITY_CHANGED/],
    [value=>{value.startedAt='2026-10-08T20:00:00Z';},/RAW_EXECUTION_STALE/],
  ]) {const changed=structuredClone(execution);mutate(changed);assert.throws(()=>validateProtectedExecutionEvidence(changed,native,shipped,'ordinaryRecovery'),expected);}
});
test('v4 restricted raw restoration requires six actual43/53 rounds including exactF2 and restricted roles', () => {
  const execution={schemaVersion:1,kind:'release297_cp_protected_fallback_restricted_owner_restoration',exactFallbackSource:CP_PROTECTED_SOURCE,releaseBindingId:CP_PROTECTED_BINDING_ID,
    startedAtUtc:'2026-10-08T23:54:00Z',completedAtUtc:'2026-10-08T23:55:00Z',passed:true,productionMutations:0,operationalAuthorization:false,releaseReady:false,ownerPoolEnded:true,cleanupPassed:true,
    restorationOwner:{superuser:false,bypassRls:false,inherit:false},runtimeRole:{superuser:false,bypassRls:false,inherit:false,noSchemaCreate:true,ownsNoTables:true},rounds:[],cleanup:[{removed:true,exitCode:0,oomKilled:false,forced:false}]};
  for(const arm of ['baseline','candidate','fallback'])for(const round of [1,2])execution.rounds.push({arm,round,source:arm==='baseline'?'7af9d0dd5bc2bd3e13b96d35a577725e07f8b678':shipped.artifacts[arm==='fallback'?'fallback':'serving-anchor'].source,
    image:arm==='baseline'?digest('syntheticbaseline'):shipped.artifacts[arm==='fallback'?'fallback':'serving-anchor'].localIndex,ledgerRows:arm==='baseline'?43:53,effectiveDdlRole:{rolsuper:false,rolbypassrls:false},allSchemaTablesOwnedByRestrictedOwner:true,ledgerCopiedOnlyFromActualFreshReplay:true,zeroNamedSqlConnections:true,databaseDropped:true,
    inputSchema:{sha256:bindingHash(`${arm}-schema-${round===1?'initial':'first-export'}`)},exportSchema:{sha256:bindingHash(`${arm}-schema-${round===1?'first-export':'second-export'}`)},continuity:{verified:true,...(round===1?{restoredCanonicalSha256:bindingHash(`${arm}-canonical`)}:{exactCanonicalBytesEqual:true,inputCanonical:bindingHash(`${arm}-canonical`),exportCanonical:bindingHash(`${arm}-canonical`)})}});
  const native={observedAtUtc:'2026-10-08T23:59:00Z'};validateProtectedExecutionEvidence(execution,native,shipped,'restrictedRestoration');
  for(const [mutate,expected]of [
    [value=>{value.rounds[4].ledgerRows=54;},/RAW_RESTORATION_FACTS_CHANGED/],
    [value=>{value.rounds[4].source=shipped.previousFallback.source;},/RAW_RESTORATION_FACTS_CHANGED/],
    [value=>{value.rounds[4].image=shipped.artifacts['serving-anchor'].localIndex;},/RAW_RESTORATION_IMAGE_CHANGED/],
    [value=>{value.rounds[4].zeroNamedSqlConnections=false;},/RAW_RESTORATION_FACTS_CHANGED/],
    [value=>{value.rounds[4].effectiveDdlRole.rolbypassrls=true;},/RAW_RESTORATION_FACTS_CHANGED/],
    [value=>{value.restorationOwner.superuser=true;},/RAW_RESTORATION_ROLE_CHANGED/],
    [value=>{value.rounds.pop();},/RAW_RESTORATION_ROUNDS_REQUIRED/],
    [value=>{value.rounds[5]=structuredClone(value.rounds[4]);},/RAW_RESTORATION_ROUNDS_REQUIRED/],
    [value=>{value.rounds[5].inputSchema.sha256=bindingHash('substituted schema');},/RESTORATION_ROUND_CHAIN_CHANGED/],
    [value=>{value.rounds[5].continuity.exactCanonicalBytesEqual=false;},/RESTORATION_STABLE_ROUNDTRIP_REQUIRED/],
    [value=>{value.rounds[5].continuity.exportCanonical=bindingHash('changed canonical');},/RESTORATION_STABLE_ROUNDTRIP_REQUIRED/],
    [value=>{value.cleanup[0].forced=true;},/RAW_RESTORATION_CLEANUP_FAILED/],
  ]){const changed=structuredClone(execution);mutate(changed);assert.throws(()=>validateProtectedExecutionEvidence(changed,native,shipped,'restrictedRestoration'),expected);}
});
