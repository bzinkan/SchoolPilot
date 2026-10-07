import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_INPUTS, BINDING_FILES, REQUIRED_EVIDENCE, NATIVE_CHECKS, CAMPAIGN_TOPOLOGY, frontendInputInventory, verifyCurrentReleaseMain, bindingHash, publicReceiptHash, bindingSchema, imageInputInventory, resolveReleaseBinding, validateBindingProfile, validateOrdinaryRecovery, assertBindingReplay, assertBoundPublication, assertBoundScan, assertBoundFallbackScan } from '../scripts/release-source-binding.mjs';
import { FALLBACK, createPlan, createAnchor128Plan, validateAnchorEvidence } from '../scripts/register-compatible-fallback-inactive.mjs';
import { SCANNER, scanCounts } from '../scripts/verify-legacy-deploy-image.mjs';
import { planPublication, planUnused121 } from '../scripts/prepare-release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'release-297-current-school-v2';
const pending = JSON.parse(readFileSync(path.join(root, BINDING_FILES[id])));
const input = { schemaVersion: 2, releaseBindingId: id };
const run = async (executable, args) => {
  assert.equal(executable, 'git', 'This fixture permits real local Git only');
  return { code: 0, stdout: execFileSync(executable, args, { encoding: 'utf8', windowsHide: true }), stderr: '' };
};

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-release-binding-'));
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, text) => { mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); writeFileSync(path.join(directory, name), text); };
  const json = (name, value) => { const text = JSON.stringify(value, null, 2) + '\n'; write(name, text); return { path: name, sha256: bindingHash(text) }; };
  const commit = () => { git(['add', '.']); git(['-c', 'core.hooksPath=NUL', 'commit', '-qm', 'Synthetic binding fixture']); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
  write('src/app.js', 'export const synthetic = true;\n'); write('package.json', '{}\n'); write('schoolpilot-app/src/app.js', 'export const web = true;\n');
  const applicationSource = commit();
  const profile = structuredClone(pending);
  profile.status = 'accepted'; profile.sourceStatus = 'frozen-and-native-tested'; profile.blockers = []; profile.testedApplicationImage = 'sha256:' + '1'.repeat(64); profile.testedApplicationConfig = 'sha256:' + '2'.repeat(64); profile.applicationSource = applicationSource;
  profile.inventory = await imageInputInventory(directory, applicationSource, run);
  profile.frontendInventory = await frontendInputInventory(directory, applicationSource, run);
  // Synthetic receipts exist only in this disposable Git repository; never release evidence.
  write(profile.policy.path, readFileSync(path.join(root, profile.policy.path), 'utf8').replaceAll('\r\n', '\n'));
  profile.sourceApplicability = { status: 'approved', ...json('docs/release-evidence/fixture-source.json', { schemaVersion: 1, kind: 'owner_release_source_applicability', status: 'APPROVED_READINESS_SOURCE_ONLY', applicationSource, inventorySha256: profile.inventory.sha256, policySha256: profile.policy.sha256, operationalAuthorization: false, releaseBindingId: id, frontendInventorySha256: profile.frontendInventory.sha256, extension: profile.extension, schema: profile.schema }) };
  const fallbackReport = { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: FALLBACK.config }, Results: [{ Target: 'synthetic-safe-image', Vulnerabilities: [] }] };
  const report = { storage: 'committed', ...json('docs/release-evidence/fixture-fallback-report.json', fallbackReport) };
  const scan = { storage: 'committed', ...json('docs/release-evidence/fixture-fallback-scan.json', { schemaVersion: 1, passed: true, createdAt: '2026-10-07T17:33:00.000Z', sourceSha: FALLBACK.source, imageId: FALLBACK.localIndex, configDigest: FALLBACK.config, scanner: SCANNER, os: 'linux', architecture: 'amd64', reportSha256: report.sha256, counts: scanCounts(fallbackReport, FALLBACK.config) }) };
  const cleanup = { storage: 'committed', ...json('docs/release-evidence/fixture-fallback-cleanup.json', { schemaVersion: 1, complete: true, forced: false, exactOwned: true, scannerExitCode: 0, ownedScannerAbsent: true, scanSha256: scan.sha256 }) };
  profile.fallbackScan = { status: 'passed', scan, report, cleanup };
  for (const key of REQUIRED_EVIDENCE) {
    const identity = { releaseBindingId: id, evidenceKind: key, applicationSource, inventorySha256: profile.inventory.sha256, frontendInventorySha256: profile.frontendInventory.sha256, extension: profile.extension, policySha256: profile.policy.sha256, schema: profile.schema, scope: profile.scope };
    const value = key === 'ordinaryRecovery'
      ? { schemaVersion: 1, kind: 'release_binding_ordinary_recovery', ...identity, fallbackSource: FALLBACK.source, phases: ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'], passed: true, restrictedRoleVerified: true, retainedScreenshotFunctionBodyAndAcl: true, privateChatHistoryAndFencesPreserved: true, exactFocusCleanupPassed: true, allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections: true }
      : { schemaVersion: 1, kind: 'release_binding_acceptance', ...identity, passed: true };
    const applicationImage = 'sha256:' + '1'.repeat(64), checks = Object.fromEntries(NATIVE_CHECKS[key].map(check => [check, true]));
    const topology = CAMPAIGN_TOPOLOGY[key];
    const nativeRuns = (topology?.arms ?? ['B']).map((arm, index) => {
      const dimensions = topology ? { arm, index: index + 1, clients: topology.clients, measuredWindowMs: topology.durationMs, offered: topology.offered, succeeded: topology.offered, persisted: topology.offered, startedAtMs: index * (topology.durationMs + 1000), finishedAtMs: index * (topology.durationMs + 1000) + topology.durationMs, failed: 0, refused: 0, lateOffers: 0, invalidBindings: 0, outstandingAfterDrain: 0, measuredSource: arm === 'A' ? '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678' : applicationSource, measuredImage: arm === 'A' ? 'sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8' : applicationImage, migrations: arm === 'A' ? 43 : 53, forcedRlsTables: arm === 'A' ? 121 : 129, absolutePassed: arm !== 'A', rounds: 15, ordinaryOffered: 11970, reconnectOffered: 133, headroomPassed: true } : {};
      return { storage: 'committed', ...json(`docs/release-evidence/fixture-${key}-run${index}.json`, { schemaVersion: 1, kind: 'release_binding_native_run', ...identity, applicationImage, complete: true, safetyPassed: true, completeErrorCoverage: true, cleanupPassed: true, runId: `${key}-synthetic-run${index}`, ...dimensions }) };
    });
    const nativeResult = { storage: 'committed', ...json(`docs/release-evidence/fixture-${key}-native.json`, { schemaVersion: 1, kind: 'release_binding_native_result', ...identity, applicationImage, checks, runs: nativeRuns, passed: true, ...(key === 'ordinaryRecovery' ? { recovery: value } : {}) }) };
    const independentReview = { storage: 'committed', ...json(`docs/release-evidence/fixture-${key}-review.json`, { schemaVersion: 1, kind: 'release_binding_independent_review', ...identity, applicationImage, nativeResultSha256: nativeResult.sha256, runSha256s: nativeRuns.map(value => value.sha256), passed: true, fullIndependentReviewComplete: true }) };
    value.retainedEvidence = { nativeResult, independentReview };
    profile.evidence[key] = { status: 'passed', ...json(`docs/release-evidence/fixture-${key}.json`, value) };
  }
  write('scripts/deploy-classpilot-runtime-config.ps1', readFileSync(path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1')));
  write('scripts/release-source-binding.mjs', readFileSync(path.join(root, 'scripts/release-source-binding.mjs')));
  json(BINDING_FILES[id], profile); const source = commit();
  const reseal = (key, mutate) => {
    const read = record => JSON.parse(readFileSync(path.join(directory, record.path)));
    const envelope = read(profile.evidence[key]), native = read(envelope.retainedEvidence.nativeResult), review = read(envelope.retainedEvidence.independentReview);
    const runs = native.runs.map(read);
    mutate({ envelope, native, review, runs });
    native.runs = runs.map((value, index) => ({ storage: 'committed', ...json(`docs/release-evidence/fixture-${key}-run${index}.json`, value) }));
    envelope.retainedEvidence.nativeResult = { storage: 'committed', ...json(envelope.retainedEvidence.nativeResult.path, native) };
    review.nativeResultSha256 = envelope.retainedEvidence.nativeResult.sha256; review.runSha256s = native.runs.map(value => value.sha256);
    envelope.retainedEvidence.independentReview = { storage: 'committed', ...json(envelope.retainedEvidence.independentReview.path, review) };
    profile.evidence[key] = { status: 'passed', ...json(profile.evidence[key].path, envelope) };
    json(BINDING_FILES[id], profile); commit();
  };
  return { directory, profile, source, git, write, json, commit, reseal,
    options: { root: directory, run, fallback: FALLBACK, sourceDirectory: directory, source },
    clean() { const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('sp-release-binding-')); rmSync(resolved, { recursive: true }); } };
}

test('shipped binding is pending, source-specific and cannot be activated by caller receipts', async () => {
  const commands = [];
  const deniedRun = async (...args) => { commands.push(args); throw new Error('External work must not start'); };
  for (const operation of [planPublication, planUnused121, createPlan, createAnchor128Plan]) {
    await assert.rejects(operation({ ...input, kind: 'serving-anchor', evidence: { passed: true }, sourceApplicability: { status: 'approved' } }, { run: deniedRun }), /RELEASE_BINDING_EVIDENCE_PENDING/);
  }
  assert.deepEqual(commands, []);
  assert.equal(pending.applicationSource, '56df7a4f390b45a2f97ee435c01381ddede5dc2e');
  assert.equal(pending.sourceApplicability.status, 'pending');
});

test('schema and allowlist reject implicit fallback, caller paths and legacy overrides', () => {
  assert.equal(bindingSchema({ schemaVersion: 1 }), 1);
  for (const value of [{ schemaVersion: 3 }, { schemaVersion: 2 }, { ...input, releaseBindingId: '../other' }, { ...input, schemaVersion: 1 }]) assert.throws(() => bindingSchema(value));
});

test('committed public recovery seals use Git LF while private pins remain byte exact', () => {
  const lf = '{\n  "kind": "release_binding_ordinary_recovery"\n}\n', crlf = lf.replaceAll('\n', '\r\n');
  assert.equal(publicReceiptHash(lf), publicReceiptHash(crlf));
  assert.notEqual(bindingHash(lf), bindingHash(crlf));
  assert.notEqual(publicReceiptHash(lf), publicReceiptHash(lf.replace('ordinary', 'historical')));
});

test('actual Git inventory permits documentation-only successors and ignores checkout CRLF', async () => {
  const f = await fixture();
  try {
    const binding = await resolveReleaseBinding(input, f.options);
    assert.deepEqual(binding.inventory, f.profile.inventory);
    assert.notEqual(f.source, f.profile.applicationSource);
    const original = await imageInputInventory(f.directory, f.source, run);
    f.write('src/app.js', 'export const synthetic = true;\r\n');
    assert.deepEqual(await imageInputInventory(f.directory, f.source, run), original);
  } finally { f.clean(); }
});

test('real Git tested source A and documentation-only main B reuse only the exact A-labelled image', async () => {
  const f = await fixture();
  try {
    const binding = await resolveReleaseBinding(input, f.options);
    assert.notEqual(binding.applicationSource, f.source);
    const scan = { schemaVersion: 1, sourceSha: binding.applicationSource, imageId: binding.testedApplicationImage, configDigest: binding.testedApplicationConfig, passed: true, scanner: SCANNER, os: 'linux', architecture: 'amd64', counts: { HIGH: 0, CRITICAL: 0 } };
    const digest = 'sha256:' + '3'.repeat(64), scanSha256 = 'a'.repeat(64);
    const anchorInput = { ...input, anchorSource: f.source, anchorImage: digest, anchorScan: { sha256: scanSha256 } };
    const proof = { schemaVersion: 1, passed: true, sourceSha: binding.applicationSource, scanner: SCANNER, platformDigest: 'sha256:' + '4'.repeat(64), configDigest: scan.configDigest, receiptSha256: scanSha256, digest, region: FALLBACK.region, repository: FALLBACK.repository };
    const tag = { imageDetails: [{ registryId: FALLBACK.account, repositoryName: FALLBACK.repository, imageDigest: digest, imageTags: [f.source.slice(0, 12)] }] };
    assertBoundScan(scan, binding);
    validateAnchorEvidence(anchorInput, scan, proof, tag, binding);
    for (const changed of [{ ...scan, imageId: 'sha256:' + '9'.repeat(64) }, { ...scan, configDigest: 'sha256:' + '8'.repeat(64) }, { ...scan, sourceSha: f.source }]) {
      assert.throws(() => assertBoundScan(changed, binding), /BOUND_TESTED_IMAGE_REQUIRED/);
      assert.throws(() => validateAnchorEvidence(anchorInput, changed, proof, tag, binding), /BOUND_TESTED_IMAGE_REQUIRED/);
    }
    assert.throws(() => validateAnchorEvidence(anchorInput, scan, { ...proof, sourceSha: f.source }, tag, binding), /ANCHOR_SOURCE_PROOF_MISMATCH/);
    // v1 still demands matching artifact and coordination labels.
    assert.throws(() => validateAnchorEvidence({ ...anchorInput, schemaVersion: 1 }, scan, proof, tag), /ANCHOR_SOURCE_PROOF_MISMATCH/);
    assert.throws(() => validateAnchorEvidence(anchorInput, scan, proof, tag), /SCAN_BINDING_REQUIRED/);
    assert.throws(() => bindingSchema({ ...input, artifactSource: binding.applicationSource }), /CALLER_ARTIFACT_SOURCE_FORBIDDEN/);
  } finally { f.clean(); }
});

test('actual Git inventory rejects committed application or file mode drift', async () => {
  for (const mode of ['bytes', 'executable']) {
    const f = await fixture();
    try {
      if (mode === 'bytes') { f.write('src/app.js', 'export const synthetic = false;\n'); f.options.source = f.commit(); }
      else { f.git(['update-index', '--chmod=+x', 'src/app.js']); f.git(['-c', 'core.hooksPath=NUL', 'commit', '-qm', 'Synthetic mode drift']); f.options.source = f.git(['rev-parse', 'HEAD']); }
      await assert.rejects(resolveReleaseBinding(input, f.options), /APPLICATION_BYTES_CHANGED/);
    } finally { f.clean(); }
  }
});

test('uncommitted profile changes and committed receipt substitution are rejected', async () => {
  const f = await fixture();
  try {
    const changed = structuredClone(f.profile); changed.notes = ['unreviewed']; f.json(BINDING_FILES[id], changed);
    await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_UNCOMMITTED_BYTES/);
    f.json(BINDING_FILES[id], f.profile);
    f.json(f.profile.evidence.currentSchoolAcceptance.path, { passed: true }); f.commit();
    await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_EVIDENCE_CHANGED/);
  } finally { f.clean(); }
});

test('approved source applicability and every evidence component are mandatory', async () => {
  const f = await fixture();
  try {
    for (const key of REQUIRED_EVIDENCE) {
      const changed = structuredClone(f.profile); changed.evidence[key].status = 'unknown';
      assert.throws(() => validateBindingProfile(changed, id, FALLBACK), /RELEASE_BINDING_EVIDENCE_PENDING/);
    }
    const changed = structuredClone(f.profile); changed.sourceApplicability.status = 'pending';
    assert.throws(() => validateBindingProfile(changed, id, FALLBACK), /SOURCE_APPLICABILITY_PENDING/);
    changed.sourceApplicability.status = 'approved'; changed.fallback.source = 'f'.repeat(40);
    assert.throws(() => validateBindingProfile(changed, id, FALLBACK), /BINDING_FALLBACK_CHANGED/);
  } finally { f.clean(); }
});

test('ordinary recovery rejects historical54, missing phase, wrong source and cleanup failure', async () => {
  const f = await fixture();
  try {
    const stage = JSON.parse(readFileSync(path.join(f.directory, f.profile.evidence.ordinaryRecovery.path)));
    validateOrdinaryRecovery(stage, f.profile, FALLBACK);
    for (const mutate of [value => { value.schema.retainedCompletedMigrations = 54; }, value => { value.phases.pop(); }, value => { value.applicationSource = FALLBACK.application; }, value => { value.allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections = false; }]) {
      const changed = structuredClone(stage); mutate(changed); assert.throws(() => validateOrdinaryRecovery(changed, f.profile, FALLBACK));
    }
  } finally { f.clean(); }
});

test('plan replay and published artifact cannot cross binding or source identity', async () => {
  const f = await fixture();
  try {
    const binding = await resolveReleaseBinding(input, f.options);
    assertBindingReplay(input, binding, structuredClone(binding));
    assert.throws(() => assertBindingReplay(input, binding, { ...binding, sha256: 'b'.repeat(64) }), /RELEASE_BINDING_CHANGED/);
    assert.throws(() => assertBindingReplay(input, binding, { ...binding, validatorSha256: 'b'.repeat(64) }), /RELEASE_BINDING_CHANGED/);
    const image = 'sha256:' + 'a'.repeat(64), receipt = { schemaVersion: 2, source: f.source, artifactSource: binding.applicationSource, registryDigest: image, status: 'published', operation: 'PublishImage', servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0, publicationOutcomeUncertain: false, releaseBinding: binding };
    assertBoundPublication(receipt, binding, f.source, image);
    for (const changed of [{ ...receipt, schemaVersion: 1 }, { ...receipt, operation: 'RegisterUnused121' }, { ...receipt, servicesUpdated: 1 }, { ...receipt, publicationOutcomeUncertain: true }, { ...receipt, source: FALLBACK.application }, { ...receipt, releaseBinding: { ...binding, id: 'another-release' } }]) assert.throws(() => assertBoundPublication(changed, binding, f.source, image));
  } finally { f.clean(); }
});

test('frontend, SOC2 and Docker package wildcard inputs are part of the actual Git inventory', async () => {
  for (const filename of ['schoolpilot-app/src/app.js', 'docs/soc2/runtime.md', 'package-extra.json']) {
    const f = await fixture();
    try {
      f.write(filename, 'changed\n'); f.options.source = f.commit();
      await assert.rejects(resolveReleaseBinding(input, f.options), /APPLICATION_BYTES_CHANGED|FRONTEND_BYTES_CHANGED/);
    } finally { f.clean(); }
  }
});

test('extension identity, pending blockers and tested image must be explicitly resolved', async () => {
  const f = await fixture();
  try {
    for (const mutate of [p => { p.extension.version = '2.9.6'; }, p => { p.extension.zipSha256 = 'b'.repeat(64); }, p => { p.blockers = ['fallback-scan-failed']; }, p => { p.testedApplicationImage = null; }]) {
      const changed = structuredClone(f.profile); mutate(changed); assert.throws(() => validateBindingProfile(changed, id, FALLBACK));
    }
  } finally { f.clean(); }
});

test('rehashing envelopes cannot relabel stale native source, schema, client or image evidence', async () => {
  for (const mutate of [
    ({ runs }) => { runs[0].applicationSource = FALLBACK.application; },
    ({ runs }) => { runs[0].schema.candidateMigrations = 54; },
    ({ runs }) => { runs[0].extension.version = '2.9.6'; },
    ({ runs }) => { runs[0].releaseBindingId = 'another-release'; },
    ({ native, review, runs }) => { native.applicationImage = review.applicationImage = runs[0].applicationImage = 'sha256:' + '9'.repeat(64); },
  ]) {
    const f = await fixture();
    try {
      f.reseal('normalLoadAcceptance', mutate);
      await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_NATIVE_IDENTITY_CHANGED|BINDING_NATIVE_IMAGE_CHANGED/);
    } finally { f.clean(); }
  }
});

test('campaign topology rejects shortened, reordered, overlapping or mis-sized runs', async () => {
  for (const [key, mutate] of [
    ['currentSchoolAcceptance', ({ runs }) => { runs.pop(); }],
    ['currentSchoolAcceptance', ({ runs }) => { runs[0].arm = 'B'; }],
    ['classroomAcceptance', ({ runs }) => { runs[1].startedAtMs = 0; }],
    ['classroomAcceptance', ({ runs }) => { runs[0].measuredWindowMs = 60000; }],
    ['headroomAcceptance', ({ runs }) => { runs.pop(); }],
    ['headroomAcceptance', ({ runs }) => { runs[0].clients = 133; }],
    ['normalLoadAcceptance', ({ runs }) => { runs[0].offered = 2039; }],
  ]) {
    const f = await fixture();
    try {
      f.reseal(key, mutate);
      await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_CAMPAIGN_/);
    } finally { f.clean(); }
  }
});

test('private retained bytes must exist and are hashed exactly on every replay', async () => {
  const f = await fixture();
  try {
    const key = 'screenshotRuntime', record = f.profile.evidence[key], envelope = JSON.parse(readFileSync(path.join(f.directory, record.path)));
    const native = readFileSync(path.join(f.directory, envelope.retainedEvidence.nativeResult.path), 'utf8');
    const retainedDirectory = path.join(f.directory, '..', path.basename(f.directory) + '-private'); mkdirSync(retainedDirectory);
    f.privateDirectory = retainedDirectory;
    let permissionChecks = 0;
    f.options.run = async (command, args) => command === 'pwsh' ? (permissionChecks++, { code: 0, stdout: '' }) : run(command, args);
    envelope.retainedEvidence.nativeResult = { storage: 'private', path: 'native.json', sha256: bindingHash(native) };
    f.profile.evidence[key] = { status: 'passed', ...f.json(record.path, envelope) }; f.json(BINDING_FILES[id], f.profile); f.commit();
    const privateInput = { ...input, retainedEvidenceDirectory: retainedDirectory };
    await assert.rejects(resolveReleaseBinding(privateInput, f.options), /ENOENT/);
    writeFileSync(path.join(retainedDirectory, 'native.json'), native);
    await resolveReleaseBinding(privateInput, f.options);
    assert.ok(permissionChecks >= 2);
    await assert.rejects(resolveReleaseBinding({ ...privateInput, retainedEvidenceDirectory: f.directory }, f.options), /BINDING_PRIVATE_DIRECTORY_OVERLAP/);
    await assert.rejects(resolveReleaseBinding(privateInput, { ...f.options, run: async (command, args) => command === 'pwsh' ? { code: 1, stdout: '' } : run(command, args) }), /BINDING_PRIVATE_PERMISSIONS_REQUIRED/);
    writeFileSync(path.join(retainedDirectory, 'native.json'), native.replaceAll('\n', '\r\n'));
    await assert.rejects(resolveReleaseBinding(privateInput, f.options), /BINDING_RETAINED_BYTES_CHANGED/);
  } finally { if (f.privateDirectory) { assert.ok(path.resolve(f.privateDirectory).startsWith(path.resolve(os.tmpdir()) + path.sep)); rmSync(f.privateDirectory, { recursive: true }); } f.clean(); }
});

test('recovery native evidence is replayed rather than accepting a passed outer stage', async () => {
  const f = await fixture();
  try {
    f.reseal('ordinaryRecovery', ({ native }) => { native.recovery.schema.retainedCompletedMigrations = 54; });
    await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_RECOVERY_SCHEMA_CHANGED/);
  } finally { f.clean(); }
});

test('accepted fallback scan pin rejects older scan substitution and rehashed blocking findings', async () => {
  const f = await fixture();
  try {
    const binding = await resolveReleaseBinding(input, f.options);
    const records = f.profile.fallbackScan;
    const scan = JSON.parse(readFileSync(path.join(f.directory, records.scan.path)));
    const fallbackInput = { scan: { sha256: records.scan.sha256 }, scanCleanup: { sha256: records.cleanup.sha256 } };
    assertBoundFallbackScan(fallbackInput, scan, binding);
    assert.throws(() => assertBoundFallbackScan({ ...fallbackInput, scan: { sha256: 'a'.repeat(64) } }, scan, binding), /BOUND_FRESH_FALLBACK_SCAN_REQUIRED/);
    const report = JSON.parse(readFileSync(path.join(f.directory, records.report.path)));
    report.Results[0].Vulnerabilities.push({ Severity: 'CRITICAL', VulnerabilityID: 'synthetic-fixture-finding' });
    records.report = { storage: 'committed', ...f.json(records.report.path, report) };
    scan.reportSha256 = records.report.sha256; scan.counts = scanCounts(report, FALLBACK.config);
    records.scan = { storage: 'committed', ...f.json(records.scan.path, scan) };
    const cleanup = JSON.parse(readFileSync(path.join(f.directory, records.cleanup.path))); cleanup.scanSha256 = records.scan.sha256;
    records.cleanup = { storage: 'committed', ...f.json(records.cleanup.path, cleanup) };
    f.json(BINDING_FILES[id], f.profile); f.commit();
    await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_FALLBACK_SCAN_FAILED/);
  } finally { f.clean(); }
});

test('rehashing an old passing fallback report cannot erase the later known failed scan', async () => {
  const f = await fixture();
  try {
    const records = f.profile.fallbackScan, scan = JSON.parse(readFileSync(path.join(f.directory, records.scan.path)));
    scan.createdAt = '2026-10-04T17:33:00.000Z';
    records.scan = { storage: 'committed', ...f.json(records.scan.path, scan) };
    const cleanup = JSON.parse(readFileSync(path.join(f.directory, records.cleanup.path))); cleanup.scanSha256 = records.scan.sha256;
    records.cleanup = { storage: 'committed', ...f.json(records.cleanup.path, cleanup) };
    f.json(BINDING_FILES[id], f.profile); f.commit();
    await assert.rejects(resolveReleaseBinding(input, f.options), /BINDING_FALLBACK_SCAN_STALE/);
  } finally { f.clean(); }
});

test('fresh recovery main check rejects moved main, PR CI, pending CI and failed workflows', async () => {
  const source = 'a'.repeat(40), good = { headSha: source, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success', workflowName: 'CI' };
  const check = (main, runs) => verifyCurrentReleaseMain(source, async (executable, args) => {
    assert.equal(executable, 'gh'); return { code: 0, stdout: JSON.stringify(args[0] === 'api' ? { commit: { sha: main } } : runs) };
  });
  await check(source, [good]);
  await assert.rejects(check('b'.repeat(40), [good]), /REMOTE_MAIN_CHANGED/);
  for (const runs of [[], [{ ...good, event: 'pull_request' }], [{ ...good, status: 'in_progress' }], [good, { ...good, workflowName: 'Security', conclusion: 'failure' }]]) await assert.rejects(check(source, runs), /MAIN_CI_/);
});
