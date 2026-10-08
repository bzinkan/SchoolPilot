import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BINDING_FILES, REQUIRED_EVIDENCE, NATIVE_CHECKS, CAMPAIGN_TOPOLOGY, SUCCESSOR_BINDING_ID, SUCCESSOR_SOURCE, SUCCESSOR_CORRECTION, SUCCESSOR_PREPARATION_CHECKS, bindingSchema, bindingHash, imageInputInventory, frontendInputInventory, successorArtifactPair, validateSuccessorSourceDelta, validateLockfileOnlyDelta, validateSuccessorProfile, validateSuccessorPreparation, validateSuccessorMainCiSnapshot, resolveReleaseBinding, bindingForRole, assertBoundScan, assertBoundPublication, assertBindingReplay } from '../scripts/release-source-binding.mjs';
import { FALLBACK, createPlan, createAnchor128Plan, validateImageEvidence, retainSuccessorRegistration } from '../scripts/register-compatible-fallback-inactive.mjs';
import { planPublication, planUnused121, validatePublicationPlatform } from '../scripts/prepare-release-artifacts.mjs';
import { SCANNER, scanCounts } from '../scripts/verify-legacy-deploy-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shipped = JSON.parse(readFileSync(path.join(root, BINDING_FILES[SUCCESSOR_BINDING_ID])));
const time = new Date(Date.now() - 60_000).toISOString(), now = () => Date.parse(time) + 1_800_000;
const digest = text => 'sha256:' + bindingHash(text);
const input = { schemaVersion: 3, releaseBindingId: SUCCESSOR_BINDING_ID };
function tar(entries) {
  const output = [];
  for (const [name, value] of Object.entries(entries)) { const bytes = Buffer.from(value), header = Buffer.alloc(512); header.write(name); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header[156] = 48; output.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)); }
  return Buffer.concat([...output, Buffer.alloc(1024)]);
}

// All data is synthetic and disposable. Git commands are real; only immutable
// production commit names are translated to the fixture's actual commits.
async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-successor-binding-')), main = path.join(directory, 'main'), fallbackDirectory = path.join(directory, 'fallback'), retainedEvidenceDirectory = path.join(directory, 'private');
  mkdirSync(main); mkdirSync(retainedEvidenceDirectory);
  const gitAt = (location, args) => execFileSync('git', ['-C', location, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = args => gitAt(main, args);
  const write = (name, value, location = main) => { const filename = path.join(location, name); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, value); };
  const json = (name, value, location = main) => { write(name, JSON.stringify(value, null, 2) + '\n', location); return { path: name, sha256: bindingHash(readFileSync(path.join(location, name))) }; };
  const commit = (location = main) => { gitAt(location, ['add', '.']); gitAt(location, ['-c', 'core.hooksPath=NUL', 'commit', '-qm', 'Disposable synthetic successor fixture']); return gitAt(location, ['rev-parse', 'HEAD']); };
  git(['init', '-q']); git(['config', 'user.name', 'Synthetic fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
  const lock = { lockfileVersion: 3, packages: { '': { name: 'synthetic' }, 'node_modules/proxy-addr': { version: '2.0.7', resolved: 'https://example.invalid/old-proxy' }, 'node_modules/sharp': { version: '0.35.4' }, 'node_modules/@img/sharp-linuxmusl-x64': { version: '0.35.4' }, 'node_modules/tsc-alias': { version: '1.8.16', dev: true } } };
  const repaired = value => { const next = structuredClone(value); next.packages['node_modules/proxy-addr'] = { version: '2.0.8', resolved: 'https://example.invalid/fixed-proxy' }; next.packages['node_modules/sharp'].version = '0.35.5'; next.packages['node_modules/@img/sharp-linuxmusl-x64'].version = '0.35.5'; return next; };
  write('src/app.js', 'export const compatible = true;\n'); write('package.json', '{}\n'); write('schoolpilot-app/src/app.js', 'export const web = true;\n'); json('package-lock.json', lock);
  for (const name of ['src/config/rlsRegistry.json', 'src/services/classpilotProtocol.ts', 'src/services/classpilotPrivateChatLifecycle.ts', 'src/realtime/websocket.ts', 'scripts/release-source-binding.mjs', 'scripts/prepare-release-artifacts.mjs', 'scripts/register-compatible-fallback-inactive.mjs', 'scripts/verify-legacy-deploy-image.mjs', 'scripts/enforce-deploy-rls-allowlist.mjs', 'scripts/stamp-release-runtime-identity.mjs', 'scripts/deploy-classpilot-runtime-config.ps1']) write(name, readFileSync(path.join(root, name)));
  const baseline = commit(); git(['worktree', 'add', '-q', '-b', 'synthetic-fallback', fallbackDirectory, baseline]);
  json('package-lock.json', repaired(lock), fallbackDirectory); const fallbackSource = commit(fallbackDirectory);
  const correctionParentLock = structuredClone(lock); delete correctionParentLock.packages['node_modules/tsc-alias'];
  json('package-lock.json', correctionParentLock); write('src/app.js', 'export const compatible = "candidate";\n'); commit();
  json('package-lock.json', repaired(correctionParentLock)); const correction = commit(), applicationSource = correction;
  const aliases = { [FALLBACK.source]: baseline, [SUCCESSOR_SOURCE]: fallbackSource, [SUCCESSOR_CORRECTION]: correction };
  const commands = [];
  const run = async (executable, args) => {
    commands.push({ executable, args });
    if (executable === 'pwsh') return { code: 0, stdout: '', stderr: '' }; // Disposable ACL fixture; never a live path.
    assert.equal(executable, 'git', 'Offline fixture permits Git and ACL checks only');
    const translated = args.map(arg => Object.entries(aliases).reduce((value, [label, actual]) => value.replaceAll(label, actual), arg));
    let stdout = execFileSync('git', translated, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (args[2] === 'rev-parse' && args[1] === fallbackDirectory) stdout = Object.entries(aliases).reduce((value, [label, actual]) => value.replaceAll(actual, label), stdout);
    return { code: 0, stdout, stderr: '' };
  };
  const profile = structuredClone(shipped); profile.applicationSource = applicationSource;
  profile.inventory = await imageInputInventory(main, applicationSource, run); profile.frontendInventory = await frontendInputInventory(main, applicationSource, run); profile.fallbackInventory = await imageInputInventory(main, SUCCESSOR_SOURCE, run);
  profile.sourceDelta = await validateSuccessorSourceDelta(fallbackDirectory, FALLBACK, run);
  const configBytes = JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': SUCCESSOR_SOURCE } } });
  const archive = tar({ 'manifest.json': JSON.stringify([{ Config: bindingHash(configBytes) + '.json' }]), [bindingHash(configBytes) + '.json']: configBytes });
  const anchorConfig = JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': applicationSource } } });
  const anchorArchive = tar({ 'manifest.json': JSON.stringify([{ Config: bindingHash(anchorConfig) + '.json' }]), [bindingHash(anchorConfig) + '.json']: anchorConfig });
  write('image.tar', archive, retainedEvidenceDirectory);
  write('anchor-image.tar', anchorArchive, retainedEvidenceDirectory);
  profile.artifacts = { 'serving-anchor': { source: applicationSource, localIndex: digest('anchor-index'), config: digest(anchorConfig), platform: digest('anchor-platform'), archiveSha256: bindingHash(anchorArchive) }, fallback: { source: SUCCESSOR_SOURCE, localIndex: digest('fallback-index'), config: digest(configBytes), platform: digest('fallback-platform'), archiveSha256: bindingHash(archive) } };
  profile.fallback = Object.fromEntries(['source', 'localIndex', 'config', 'platform'].map(key => [key, profile.artifacts.fallback[key]]));
  profile.testedApplicationImage = profile.artifacts['serving-anchor'].localIndex; profile.testedApplicationConfig = profile.artifacts['serving-anchor'].config;
  profile.preparation.status = 'passed';
  const pair = successorArtifactPair(profile), scanArtifacts = {};
  const retained = (name, value) => ({ storage: 'committed', ...json('docs/release-evidence/fixture-v3/' + name + '.json', value) });
  const report = { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: profile.fallback.config }, Results: [{ Target: 'synthetic-safe', Vulnerabilities: [] }] };
  scanArtifacts.report = retained('report', report);
  scanArtifacts.scan = retained('scan', { schemaVersion: 1, passed: true, createdAt: time, sourceSha: SUCCESSOR_SOURCE, imageId: profile.fallback.localIndex, configDigest: profile.fallback.config, scanner: SCANNER, os: 'linux', architecture: 'amd64', counts: scanCounts(report, profile.fallback.config), archiveSha256: bindingHash(archive), reportSha256: scanArtifacts.report.sha256 });
  scanArtifacts.cleanup = retained('cleanup', { complete: true, ownedScanner: 'schoolpilot-image-scan-1234' });
  scanArtifacts.custody = retained('custody', { schemaVersion: 1, complete: true, forced: false, exactOwned: true, scannerExitCode: 0, ownedScannerAbsent: true, ownedScanner: 'schoolpilot-image-scan-1234', scanSha256: scanArtifacts.scan.sha256 });
  scanArtifacts.databaseMetadata = retained('database', { Version: 2, UpdatedAt: new Date(Date.parse(time) - 3_600_000).toISOString(), NextUpdate: new Date(Date.parse(time) + 86_400_000).toISOString() });
  scanArtifacts.archive = { storage: 'private', format: 'binary', path: 'image.tar', sha256: bindingHash(archive) };
  profile.fallbackScan = { status: 'passed', scan: scanArtifacts.scan, report: scanArtifacts.report, cleanup: scanArtifacts.custody };
  const evidence = {};
  for (const [key, checks] of Object.entries(SUCCESSOR_PREPARATION_CHECKS)) {
    const identity = { releaseBindingId: SUCCESSOR_BINDING_ID, evidenceKind: key, artifactPair: pair, observedAtUtc: time, passed: true };
    const rawEvidence = key === 'successorScan' ? Object.values(scanArtifacts) : [retained(key + '-raw', { syntheticOnly: true, nativeChecks: checks })];
    const native = { schemaVersion: 1, kind: 'release_successor_native_result', ...identity, producer: 'synthetic-native-producer', checks: Object.fromEntries(checks.map(check => [check, true])), rawEvidence, ...(key === 'successorScan' ? { scanArtifacts } : {}), ...(['screenshotRuntime', 'requestIpRateLimit'].includes(key) ? { testedArtifactRole: 'fallback', source: SUCCESSOR_SOURCE, applicationImage: profile.fallback.localIndex } : {}), ...(key === 'restrictedRestoration' ? { restoration: { ddlOwner: { rolsuper: false, rolbypassrls: false }, probeRole: { rolsuper: false, rolbypassrls: false }, ordinaryMigrationCounts: [43, 53], stableSerializationRoundtrip: true } } : {}), ...(key === 'ordinaryRecovery' ? { migration: { role: { rolsuper: false, rolbypassrls: false }, baselineMigrations: 43, completedMigrations: 53, ordinaryPath: true }, recovery: { baselineMigrations: 43, candidateMigrations: 53, fallbackDeclaredMigrations: 52, retainedCompletedMigrations: 53, admissionCounts: [121, 125, 126, 127, 128, 129], phases: ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'], sequence: [applicationSource, SUCCESSOR_SOURCE, applicationSource] } } : {}) };
    const nativeResult = retained(key + '-native', native);
    const review = { schemaVersion: 1, kind: 'release_successor_independent_review', ...identity, reviewer: 'synthetic-independent-reviewer', independentFromProducer: true, fullIndependentReviewComplete: true, nativeResultSha256: nativeResult.sha256, rawEvidenceSha256s: rawEvidence.map(value => value.sha256) };
    const receipt = { schemaVersion: 1, kind: 'release_successor_preparation_evidence', ...identity, retainedEvidence: { nativeResult, independentReview: retained(key + '-review', review) } };
    evidence[key] = { native, review, receipt };
    profile.preparation.evidence[key] = { status: 'passed', ...json('docs/release-evidence/fixture-v3/' + key + '.json', receipt) };
  }
  write(profile.policy.path, readFileSync(path.join(root, profile.policy.path), 'utf8').replaceAll('\r\n', '\n'));
  for (const name of ['scripts/deploy-classpilot-runtime-config.ps1', 'scripts/release-source-binding.mjs']) write(name, readFileSync(path.join(root, name)));
  const seal = () => { json(BINDING_FILES[SUCCESSOR_BINDING_ID], profile); const source = commit(); value.anchorSource = source; options.source = source; };
  const value = { ...input, anchorDirectory: main, fallbackDirectory, retainedEvidenceDirectory };
  const options = { root: main, run, fallback: FALLBACK, sourceDirectory: main, source: undefined, now };
  seal();
  const reseal = (key, mutate) => {
    const item = evidence[key]; mutate(item);
    item.receipt.retainedEvidence.nativeResult = retained(key + '-native', item.native);
    item.review.nativeResultSha256 = item.receipt.retainedEvidence.nativeResult.sha256; item.review.rawEvidenceSha256s = item.native.rawEvidence.map(value => value.sha256);
    item.receipt.retainedEvidence.independentReview = retained(key + '-review', item.review);
    profile.preparation.evidence[key] = { status: 'passed', ...json('docs/release-evidence/fixture-v3/' + key + '.json', item.receipt) }; seal();
  };
  return { directory, main, fallbackDirectory, profile, value, options, commands, git, write, json, seal, reseal, evidence, scanArtifacts, retained, cleanup() { const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('sp-successor-binding-')); git(['worktree', 'remove', '--force', fallbackDirectory]); rmSync(resolved, { recursive: true }); } };
}

function acceptOperationalFixture(f) {
  const p = f.profile; p.status = 'accepted'; p.sourceStatus = 'frozen-and-native-tested'; p.blockers = [];
  p.successorSelection = { status: 'approved', ...f.json('docs/release-evidence/fixture-v3/selection.json', { schemaVersion: 1, kind: 'reviewed_fallback_successor_selection', releaseBindingId: p.id, status: 'APPROVED_EXACT_SUCCESSOR', artifactPair: successorArtifactPair(p), operationalAuthorization: false }) };
  p.sourceApplicability = { status: 'approved', ...f.json('docs/release-evidence/fixture-v3/source-applicability.json', { schemaVersion: 1, kind: 'owner_release_source_applicability', status: 'APPROVED_READINESS_SOURCE_ONLY', applicationSource: p.applicationSource, inventorySha256: p.inventory.sha256, policySha256: p.policy.sha256, operationalAuthorization: false, releaseBindingId: p.id, frontendInventorySha256: p.frontendInventory.sha256, extension: p.extension, schema: p.schema }) };
  for (const key of REQUIRED_EVIDENCE) {
    const identity = { releaseBindingId: p.id, evidenceKind: key, applicationSource: p.applicationSource, inventorySha256: p.inventory.sha256, frontendInventorySha256: p.frontendInventory.sha256, policySha256: p.policy.sha256, extension: p.extension, schema: p.schema, scope: p.scope };
    const stage = key === 'ordinaryRecovery' ? { schemaVersion: 1, kind: 'release_binding_ordinary_recovery', ...identity, fallbackSource: SUCCESSOR_SOURCE, phases: ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'], passed: true, restrictedRoleVerified: true, retainedScreenshotFunctionBodyAndAcl: true, privateChatHistoryAndFencesPreserved: true, exactFocusCleanupPassed: true, allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections: true } : { schemaVersion: 1, kind: 'release_binding_acceptance', ...identity, passed: true };
    const topology = CAMPAIGN_TOPOLOGY[key];
    const runs = (topology?.arms ?? ['B']).map((arm, index) => f.retained(`${key}-acceptance-run${index}`, { schemaVersion: 1, kind: 'release_binding_native_run', ...identity, applicationImage: p.testedApplicationImage, complete: true, safetyPassed: true, completeErrorCoverage: true, cleanupPassed: true, runId: 'synthetic-' + key + index, ...(topology ? { arm, index: index + 1, clients: topology.clients, measuredWindowMs: topology.durationMs, offered: topology.offered, succeeded: topology.offered, persisted: topology.offered, startedAtMs: index * (topology.durationMs + 1000), finishedAtMs: index * (topology.durationMs + 1000) + topology.durationMs, failed: 0, refused: 0, lateOffers: 0, invalidBindings: 0, outstandingAfterDrain: 0, measuredSource: arm === 'A' ? '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678' : p.applicationSource, measuredImage: arm === 'A' ? 'sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8' : p.testedApplicationImage, migrations: arm === 'A' ? 43 : 53, forcedRlsTables: arm === 'A' ? 121 : 129, absolutePassed: arm !== 'A', rounds: 15, ordinaryOffered: 11970, reconnectOffered: 133, headroomPassed: true } : {}) }));
    const nativeResult = f.retained(`${key}-acceptance-native`, { schemaVersion: 1, kind: 'release_binding_native_result', ...identity, applicationImage: p.testedApplicationImage, passed: true, checks: Object.fromEntries(NATIVE_CHECKS[key].map(check => [check, true])), runs, ...(key === 'restrictedRestoration' ? { restoration: { ddlOwner: { rolsuper: false, rolbypassrls: false }, probeRole: { rolsuper: false, rolbypassrls: false }, ordinaryMigrationCounts: [43, 53], stableSerializationRoundtrip: true } } : {}), ...(key === 'ordinaryRecovery' ? { migration: { role: { rolsuper: false, rolbypassrls: false }, baselineMigrations: 43, completedMigrations: 53, ordinaryPath: true }, recovery: stage } : {}) });
    const independentReview = f.retained(`${key}-acceptance-review`, { schemaVersion: 1, kind: 'release_binding_independent_review', ...identity, applicationImage: p.testedApplicationImage, passed: true, fullIndependentReviewComplete: true, nativeResultSha256: nativeResult.sha256, runSha256s: runs.map(value => value.sha256) });
    stage.retainedEvidence = { nativeResult, independentReview }; p.evidence[key] = { status: 'passed', ...f.json('docs/release-evidence/fixture-v3/' + key + '-acceptance.json', stage) };
  }
  f.seal(); f.git(['update-ref', 'refs/remotes/origin/main', f.value.anchorSource]);
  const ciPath = path.join(f.value.retainedEvidenceDirectory, 'exact-main-ci.json');
  writeFileSync(ciPath, JSON.stringify({ repository: 'bzinkan/SchoolPilot', branch: 'main', source: f.value.anchorSource, observedAtUtc: time, runs: [{ workflowName: 'CI', headSha: f.value.anchorSource, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] }));
  f.value.mainCi = { path: ciPath, sha256: bindingHash(readFileSync(ciPath)) };
}

async function controllerFixture(f) {
  const preparation = await import(pathToFileURL(path.join(f.main, 'scripts/prepare-release-artifacts.mjs')).href);
  const registration = await import(pathToFileURL(path.join(f.main, 'scripts/register-compatible-fallback-inactive.mjs')).href);
  const external = f.value.retainedEvidenceDirectory, plans = path.join(f.directory, 'plans'); mkdirSync(plans);
  const pin = (name, value, raw) => { const filename = path.join(external, name); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, raw ?? JSON.stringify(value, null, 2) + '\n'); return { path: filename, sha256: bindingHash(readFileSync(filename)) }; };
  const scanInput = role => {
    const artifact = f.profile.artifacts[role], name = role === 'fallback' ? 'scan-fallback' : 'scan-anchor';
    const report = { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: artifact.config }, Results: [{ Target: 'synthetic-safe', Vulnerabilities: [] }] };
    pin(name + '/input/image.tar', null, readFileSync(path.join(external, role === 'fallback' ? 'image.tar' : 'anchor-image.tar')));
    const reportPin = pin(name + '/reports/trivy.json', report);
    const receipt = role === 'fallback' ? JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.scan.path))) : { schemaVersion: 1, sourceSha: artifact.source, passed: true, createdAt: time, scanner: SCANNER, os: 'linux', architecture: 'amd64', imageId: artifact.localIndex, configDigest: artifact.config, counts: scanCounts(report, artifact.config), archiveSha256: artifact.archiveSha256, reportSha256: reportPin.sha256 };
    receipt.dockerHost = 'synthetic-docker-host';
    const scan = pin(name + '/scan-receipt.json', receipt), cleanup = { complete: true, ownedScanner: 'schoolpilot-image-scan-1234' }; pin(name + '/cleanup.json', cleanup);
    const custodyValue = role === 'fallback' ? { ...JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.custody.path))), scanSha256: scan.sha256 } : { schemaVersion: 1, ...cleanup, forced: false, exactOwned: true, scannerExitCode: 0, ownedScannerAbsent: true, scanSha256: scan.sha256 };
    const scanCleanup = pin(name + '/custody.json', custodyValue);
    if (role === 'fallback') {
      // Re-seal the profile's exact scan and custody, retaining real archive/report
      // bytes; this fixture never updates release evidence or a cloud resource.
      const committedScan = JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.scan.path))); committedScan.dockerHost = receipt.dockerHost;
      Object.assign(f.scanArtifacts.scan, { storage: 'committed', ...f.json(f.scanArtifacts.scan.path, committedScan) });
      const committedCustody = JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.custody.path))); committedCustody.scanSha256 = scan.sha256;
      Object.assign(f.scanArtifacts.custody, { storage: 'committed', ...f.json(f.scanArtifacts.custody.path, committedCustody) });
      f.reseal('successorScan', () => {}); assert.equal(f.scanArtifacts.scan.sha256, scan.sha256); assert.equal(f.scanArtifacts.custody.sha256, scanCleanup.sha256);
    }
    return { scan, scanCleanup };
  };
  const anchorScan = scanInput('serving-anchor'), fallbackScan = scanInput('fallback');
  // A profile seal advances B without changing application inputs; update exact
  // main snapshot after that final seal, as real operators must also do.
  f.git(['update-ref', 'refs/remotes/origin/main', f.value.anchorSource]);
  f.value.mainCi = pin('exact-main-ci.json', { repository: 'bzinkan/SchoolPilot', branch: 'main', source: f.value.anchorSource, observedAtUtc: time, runs: [{ workflowName: 'CI', headSha: f.value.anchorSource, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] });
  f.options.source = f.value.anchorSource;
  const binding = await resolveReleaseBinding(f.value, f.options), source = f.value.anchorSource;
  const scanProof = (role, value) => { const artifact = f.profile.artifacts[role]; return pin(role + '-registry.json', { schemaVersion: 1, sourceSha: artifact.source, scanner: SCANNER, passed: true, receiptSha256: value.scan.sha256, configDigest: artifact.config, platformDigest: artifact.platform, digest: artifact.platform, region: FALLBACK.region, repository: FALLBACK.repository }); };
  const anchorProof = scanProof('serving-anchor', anchorScan), fallbackProof = scanProof('fallback', fallbackScan);
  const publication = (role, proof) => pin(role + '-publication.json', { schemaVersion: 3, operation: 'PublishImage', releaseBinding: bindingForRole(binding, role), source: role === 'fallback' ? SUCCESSOR_SOURCE : source, artifactSource: f.profile.artifacts[role].source, artifactRole: role, registryDigest: f.profile.artifacts[role].platform, registryProof: proof, status: 'published', signed: false, publicationOutcomeUncertain: false, servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0 });
  const anchorPublication = publication('serving-anchor', anchorProof), fallbackPublication = publication('fallback', fallbackProof);
  const uri = `${FALLBACK.account}.dkr.ecr.${FALLBACK.region}.amazonaws.com/${FALLBACK.repository}`;
  const definition = (role, admission, sourceSha = source, image = f.profile.artifacts['serving-anchor'].platform) => {
    const family = role === 'api' ? 'schoolpilot-production-api-emergency' : 'schoolpilot-production-scheduler-worker';
    return { taskDefinition: { family, taskDefinitionArn: `arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:200`, revision: 200, status: 'ACTIVE', cpu: role === 'api' ? '1024' : '512', memory: role === 'api' ? '2048' : '1024', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], containerDefinitions: [{ name: role, image: `${uri}@${image}`, essential: true, command: ['node', role === 'api' ? 'dist/index.js' : 'dist/worker.js'], environment: Object.entries({ GIT_SHA: sourceSha, SERVICE_NAME: role, RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: admission.join(','), CLASSPILOT_USAGE_ROLLUP_MODE: 'off', CLASSPILOT_DIGITAL_USAGE_MODE: 'off', CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: 'false', CLASSPILOT_CAP_FOCUS_TAB_V1: 'false', CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1: 'false', CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: '{}', UNRELATED: 'preserved' }).map(([name, value]) => ({ name, value })), secrets: [] }] }, tags: [{ key: 'Project', value: 'Synthetic' }] };
  };
  const tag = (role, sourceSha) => pin(role + '-tag.json', { imageDetails: [{ registryId: FALLBACK.account, repositoryName: FALLBACK.repository, imageDigest: f.profile.artifacts[role].platform, imageTags: [sourceSha.slice(0, 12)] }] });
  const live = { services: ['api', 'scheduler-worker'].map(role => { const family = role === 'api' ? 'schoolpilot-production-api-emergency' : 'schoolpilot-production-scheduler-worker'; const arn = `arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:199`; return { serviceName: 'schoolpilot-production-' + role, status: 'ACTIVE', taskDefinition: arn, desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: arn }] }; }), failures: [] };
  const mainCi = f.value.mainCi, common = { ...input, fallbackDirectory: f.fallbackDirectory, retainedEvidenceDirectory: external, mainCi };
  const publisher = { repository: pin('repository.json', { repositories: [{ registryId: FALLBACK.account, repositoryName: FALLBACK.repository, imageTagMutability: 'MUTABLE' }] }), publisherConfiguration: pin('publisher.json', { repository: 'bzinkan/SchoolPilot', variable: 'IMMUTABLE_RELEASE_IMAGE_ENABLED', enabled: false }) };
  const serving = { ...common, kind: 'serving-anchor', source, sourceDirectory: f.main, ...anchorScan, ...publisher };
  const fallback = { ...common, kind: 'fallback', source: SUCCESSOR_SOURCE, sourceDirectory: f.fallbackDirectory, mainSource: source, mainDirectory: f.main, ...fallbackScan, ...publisher };
  const anchor121 = { api: pin('anchor121-api.json', definition('api', registration.anchor128Stages()[0])), worker: pin('anchor121-worker.json', definition('scheduler-worker', registration.anchor128Stages()[0])) };
  const anchor129 = { api: pin('anchor129-api.json', definition('api', registration.inventoryFor(129))), worker: pin('anchor129-worker.json', definition('scheduler-worker', registration.inventoryFor(129))) };
  const registrationCommon = { ...common, anchorDirectory: f.main, anchorSource: source, anchorImage: f.profile.artifacts['serving-anchor'].platform, anchorPublication, anchorScan: anchorScan.scan, anchorScanCleanup: anchorScan.scanCleanup, anchorRegistryProof: anchorProof, anchorPublishedTag: tag('serving-anchor', source), syntheticStage: { path: path.join(f.main, f.profile.evidence.ordinaryRecovery.path), sha256: f.profile.evidence.ordinaryRecovery.sha256 }, liveServices: pin('live.json', live) };
  const anchor = { ...registrationCommon, ...anchor121 };
  const fallbackRegistration = { ...registrationCommon, ...anchor129, ...fallbackScan, registryProof: fallbackProof, publishedTag: tag('fallback', SUCCESSOR_SOURCE), fallbackPublication, admissionCount: 129 };
  const baseline121 = { api: definition('api', registration.anchor128Stages()[0], '7'.repeat(40), digest('baseline')), worker: definition('scheduler-worker', registration.anchor128Stages()[0], '7'.repeat(40), digest('baseline')) };
  const servingLive = structuredClone(live); servingLive.services.forEach((value, index) => { const role = index === 0 ? 'api' : 'worker'; value.taskDefinition = baseline121[role].taskDefinition.taskDefinitionArn; value.deployments[0].taskDefinition = value.taskDefinition; });
  const unused121 = { ...serving, publication: anchorPublication, api: pin('baseline121-api.json', baseline121.api), worker: pin('baseline121-worker.json', baseline121.worker), liveServices: pin('serving-live.json', servingLive) };
  const commands = [], registered = new Map(), behavior = { failWorker: false, mainMoved: false, arm: 'fallback', malformedArn: false };
  const success = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const run = async (executable, args) => {
    commands.push({ executable, args });
    if (executable === 'git' || executable === 'pwsh') return f.options.run(executable, args);
    if (executable === process.execPath) return success(execFileSync(executable, args, { encoding: 'utf8', windowsHide: true }));
    if (executable === 'gh') return success(args[0] === 'api' ? { commit: { sha: behavior.mainMoved ? 'f'.repeat(40) : source } } : JSON.parse(readFileSync(mainCi.path)).runs);
    assert.equal(executable, 'aws', 'Unexpected controller transport');
    if (args[1] === 'get-caller-identity') return success({ Account: FALLBACK.account });
    if (args[1] === 'describe-images') return success(JSON.parse(readFileSync(args.includes('imageTag=' + SUCCESSOR_SOURCE.slice(0, 12)) ? fallbackRegistration.publishedTag.path : anchor.anchorPublishedTag.path)));
    if (args[1] === 'batch-get-image') { const requested = args[args.indexOf('--image-ids') + 1], imageTag = requested.slice('imageTag='.length), artifact = f.profile.artifacts['serving-anchor']; return success({ images: [{ registryId: FALLBACK.account, repositoryName: FALLBACK.repository, imageId: { imageTag, imageDigest: artifact.platform }, imageManifest: '{}', imageManifestMediaType: 'application/vnd.oci.image.manifest.v1+json' }], failures: [] }); }
    if (args[1] === 'describe-services') return success(behavior.arm === 'unused' ? servingLive : live);
    if (args[1] === 'describe-task-definition') { const arn = args[args.indexOf('--task-definition') + 1]; const selected = behavior.arm === 'anchor' ? anchor : behavior.arm === 'unused' ? unused121 : fallbackRegistration; return success(registered.get(arn) ?? JSON.parse(readFileSync(arn.includes('scheduler-worker') ? selected.worker.path : selected.api.path))); }
    if (args[1] === 'register-task-definition') { const filename = args[args.indexOf('--cli-input-json') + 1].replace(/^file:\/\//, ''), request = JSON.parse(readFileSync(filename)), role = request.containerDefinitions[0].name; if (role === 'scheduler-worker' && behavior.failWorker) return { code: 1, stdout: '', stderr: 'synthetic uncertain worker transport' }; const arn = behavior.malformedArn ? 'unexpected-but-returned-identity' : `arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${request.family}:201`, response = { taskDefinition: { ...request, taskDefinitionArn: arn, status: 'ACTIVE', revision: 201 }, tags: request.tags }; delete response.taskDefinition.tags; registered.set(arn, response); return success(response); }
    throw new Error('Unexpected mutation or read');
  };
  const options = { run, now: Date.now, verifyLocalScan: async () => {}, verifyRegistry: async (_plan, _run, role) => { const artifact = f.profile.artifacts[role === 'anchor' || _plan.kind === 'compatible_anchor128_inactive' || typeof _plan === 'function' ? 'serving-anchor' : 'fallback']; return { digest: artifact.platform, platformDigest: artifact.platform, configDigest: artifact.config }; } };
  return { preparation, registration, serving, fallback, unused121, anchor, fallbackRegistration, plans, pin, commands, behavior, run, options };
}

test('schema3 cannot choose a profile, historical binding, override or activation', async () => {
  assert.equal(bindingSchema(input), 3);
  for (const changed of [{ releaseBindingId: 'arbitrary' }, { releaseBindingId: 'release-297-current-school-v2' }, { artifactSource: SUCCESSOR_SOURCE }, { schemaVersion: 2 }]) assert.throws(() => bindingSchema({ ...input, ...changed }));
  const calls = [], run = async (...args) => { calls.push(args); throw new Error('must reject before external work'); };
  for (const operation of [planPublication, planUnused121, createPlan, createAnchor128Plan]) await assert.rejects(operation({ ...input, kind: 'serving-anchor', status: 'accepted', passed: true }, { run }), /SUCCESSOR_PREPARATION_PENDING|SUCCESSOR_SELECTION_PENDING/);
  assert.deepEqual(calls, []);
});

test('real Git proves exact semantic patch, retaining unrelated lock entries and rejecting application drift', async () => {
  const f = await fixture();
  try {
    const actual = await validateSuccessorSourceDelta(f.fallbackDirectory, FALLBACK, f.options.run); assert.ok(actual.changeCount > 0); assert.equal(actual.correctionSource, SUCCESSOR_CORRECTION);
    f.write('src/app.js', 'unreviewed change\n', f.fallbackDirectory);
    await assert.rejects(validateSuccessorSourceDelta(f.fallbackDirectory, FALLBACK, f.options.run), /SUCCESSOR_SOURCE_DIRTY/);
    execFileSync('git', ['-C', f.fallbackDirectory, 'add', '.']); execFileSync('git', ['-C', f.fallbackDirectory, '-c', 'core.hooksPath=NUL', 'commit', '-qm', 'Unreviewed synthetic app delta']);
    const moved = execFileSync('git', ['-C', f.fallbackDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await assert.rejects(validateLockfileOnlyDelta(f.fallbackDirectory, { baseline: FALLBACK.source, source: moved, correction: SUCCESSOR_CORRECTION }, f.options.run), /SUCCESSOR_SOURCE_DELTA_EXCEEDED/);
  } finally { f.cleanup(); }
});

test('offline preparation can pass with real Git input inventories while release acceptance and selection remain pending', async () => {
  const f = await fixture();
  try {
    const result = await validateSuccessorPreparation(f.value, f.options);
    assert.equal(result.preparationPassed, true); assert.equal(result.releaseReady, false); assert.equal(result.operationalAuthorization, false); assert.equal(result.cloudMutations, 0);
    assert.ok(result.pendingAcceptance.includes('currentSchoolAcceptance')); assert.equal(result.successorSelection, 'pending');
    assert.equal(f.commands.some(value => ['aws', 'docker', 'gh'].includes(value.executable)), false);
    await assert.rejects(resolveReleaseBinding(f.value, f.options), /SUCCESSOR_SELECTION_PENDING/);
    f.profile.successorSelection = { status: 'approved', path: 'docs/release-evidence/future-selection.json', sha256: 'e'.repeat(64) }; f.seal();
    await assert.rejects(resolveReleaseBinding(f.value, f.options), /RELEASE_BINDING_EVIDENCE_PENDING/);
  } finally { f.cleanup(); }
});

test('rehashing native envelopes cannot substitute a pair, historical54 recovery or dependent review', async () => {
  const f = await fixture();
  try {
    f.reseal('ordinaryRecovery', ({ native }) => { native.recovery.retainedCompletedMigrations = 54; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_ORDINARY_RECOVERY_CHANGED/);
    f.reseal('ordinaryRecovery', ({ native }) => { native.recovery.retainedCompletedMigrations = 53; native.artifactPair.fallback.config = FALLBACK.config; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_EVIDENCE_IDENTITY_CHANGED/);
    f.reseal('ordinaryRecovery', ({ native, review }) => { native.artifactPair.fallback.config = f.profile.fallback.config; review.reviewer = native.producer; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_REVIEWER_NOT_INDEPENDENT/);
  } finally { f.cleanup(); }
});

test('tampered profile, retained scan bytes, moved and dirty sources fail preparation', async () => {
  const f = await fixture();
  try {
    f.profile.historicalFallback.source = SUCCESSOR_SOURCE; f.seal();
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_HISTORY_CHANGED/);
    f.profile.historicalFallback = structuredClone(shipped.historicalFallback); f.seal();
    const scanPath = path.join(f.main, f.scanArtifacts.scan.path), original = readFileSync(scanPath); writeFileSync(scanPath, '{}\n');
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /TOOL_DIRTY/); writeFileSync(scanPath, original);
    writeFileSync(path.join(f.value.retainedEvidenceDirectory, 'image.tar'), 'substituted archive');
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /BINDING_RETAINED_BYTES_CHANGED/);
  } finally { f.cleanup(); }
});

test('artifact-role projections reject candidate scan/publication at the fallback boundary', () => {
  const pair = shipped.artifacts;
  const binding = { id: SUCCESSOR_BINDING_ID, sha256: 'b'.repeat(64), validatorSha256: 'c'.repeat(64), schemaVersion: 3, artifactPair: pair, fallback: shipped.fallback, artifactRole: 'serving-anchor', artifactSource: pair['serving-anchor'].source, artifact: pair['serving-anchor'], applicationSource: pair['serving-anchor'].source };
  const fallback = bindingForRole(binding, 'fallback');
  const scan = { sourceSha: pair.fallback.source, imageId: pair.fallback.localIndex, configDigest: pair.fallback.config, passed: true };
  assertBoundScan(scan, fallback); assert.throws(() => assertBoundScan(scan, binding), /BOUND_TESTED_IMAGE_REQUIRED/);
  const receipt = { schemaVersion: 3, releaseBinding: fallback, source: pair.fallback.source, artifactSource: pair.fallback.source, artifactRole: 'fallback', registryDigest: pair.fallback.platform, status: 'published', publicationOutcomeUncertain: false, operation: 'PublishImage', servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0 };
  assertBoundPublication(receipt, fallback, pair.fallback.source, pair.fallback.platform);
  assert.throws(() => assertBoundPublication({ ...receipt, artifactRole: 'serving-anchor' }, fallback, pair.fallback.source, pair.fallback.platform), /BOUND_PUBLICATION_ARTIFACT_ROLE_CHANGED/);
  assert.throws(() => assertBoundPublication(receipt, binding, pair.fallback.source, pair.fallback.platform), /PUBLICATION_RELEASE_BINDING_CHANGED/);
  assert.throws(() => assertBindingReplay(input, fallback, binding), /RELEASE_BINDING_CHANGED/);
  assert.throws(() => assertBindingReplay(input, fallback, { ...fallback, validatorSha256: 'd'.repeat(64) }), /RELEASE_BINDING_CHANGED/);
  validatePublicationPlatform('fallback', { digest: pair.fallback.platform, platformDigest: pair.fallback.platform, configDigest: pair.fallback.config }, pair.fallback.config, fallback);
  assert.throws(() => validatePublicationPlatform('fallback', { digest: FALLBACK.platform, platformDigest: FALLBACK.platform, configDigest: pair.fallback.config }, pair.fallback.config, fallback), /EXACT_FALLBACK_PLATFORM_REQUIRED|BOUND_PLATFORM_CHANGED/);
  assert.throws(() => validateImageEvidence({ schemaVersion: 1, ...scan, scanner: SCANNER, os: 'linux', architecture: 'amd64', counts: { HIGH: 0, CRITICAL: 0 } }, { schemaVersion: 1, passed: true, sourceSha: pair.fallback.source, scanner: SCANNER, configDigest: pair.fallback.config, platformDigest: FALLBACK.platform, digest: pair.fallback.platform, region: FALLBACK.region, repository: FALLBACK.repository }, pair.fallback), /FALLBACK_PLATFORM_CHANGED/);
});

test('schema3 exact-main CI snapshots reject stale pending failed PR and moved sources', () => {
  const source = 'e'.repeat(40), proof = { repository: 'bzinkan/SchoolPilot', branch: 'main', source, observedAtUtc: time, runs: [{ workflowName: 'CI', headSha: source, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' }] };
  validateSuccessorMainCiSnapshot(proof, source, now);
  for (const mutate of [value => { value.observedAtUtc = '2026-10-07T00:00:00Z'; }, value => { value.runs[0].status = 'in_progress'; }, value => { value.runs[0].conclusion = 'failure'; }, value => { value.runs[0].event = 'pull_request'; }, value => { value.runs[0].headSha = SUCCESSOR_SOURCE; }]) {
    const changed = structuredClone(proof); mutate(changed); assert.throws(() => validateSuccessorMainCiSnapshot(changed, source, now));
  }
});

test('stale native observations and failed capability/cleanup checks cannot be relabelled by fresh hashes', async () => {
  const f = await fixture();
  try {
    f.reseal('ordinaryRecovery', ({ native }) => { native.observedAtUtc = '2026-10-06T00:00:00Z'; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_EVIDENCE_STALE/);
    f.reseal('ordinaryRecovery', ({ native }) => { native.observedAtUtc = time; native.checks.capabilityEqualityPassed = false; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_NATIVE_CHECK_FAILED/);
    f.reseal('ordinaryRecovery', ({ native }) => { native.checks.capabilityEqualityPassed = true; native.checks.allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections = false; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_NATIVE_CHECK_FAILED/);
    f.reseal('ordinaryRecovery', ({ native }) => { native.checks.allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections = true; native.rawEvidence = Array.from({ length: 257 }, (_, index) => ({ storage: 'committed', path: 'docs/release-evidence/overflow-' + index + '.json', sha256: 'e'.repeat(64) })); });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_RAW_EVIDENCE_REQUIRED/);
  } finally { f.cleanup(); }
});

test('accepted synthetic v3 profile resolves both roles offline and detects changed local remote main', async () => {
  const f = await fixture();
  try {
    acceptOperationalFixture(f);
    const anchor = await resolveReleaseBinding(f.value, f.options);
    assert.equal(anchor.artifactRole, 'serving-anchor'); assert.equal(anchor.artifactSource, f.profile.applicationSource);
    const fallbackInput = { ...f.value, kind: 'fallback', sourceDirectory: f.fallbackDirectory, source: SUCCESSOR_SOURCE, mainDirectory: f.main, mainSource: f.value.anchorSource, anchorDirectory: undefined, anchorSource: undefined };
    const fallback = await resolveReleaseBinding(fallbackInput, { ...f.options, sourceDirectory: f.fallbackDirectory, source: SUCCESSOR_SOURCE });
    assert.deepEqual(fallback, bindingForRole(anchor, 'fallback')); assert.equal(f.commands.some(value => ['aws', 'docker', 'gh'].includes(value.executable)), false);
    await assert.rejects(resolveReleaseBinding({ ...fallbackInput, anchorDirectory: f.main, anchorSource: f.value.anchorSource }, { ...f.options, sourceDirectory: f.fallbackDirectory, source: SUCCESSOR_SOURCE }), /SUCCESSOR_AMBIGUOUS_SOURCE_DIRECTORIES/);
    f.write('operator-notes.txt', 'dirty main');
    await assert.rejects(resolveReleaseBinding(fallbackInput, { ...f.options, sourceDirectory: f.fallbackDirectory, source: SUCCESSOR_SOURCE }), /TOOL_DIRTY|SOURCE_DIRTY/);
    rmSync(path.join(f.main, 'operator-notes.txt'));
    f.git(['update-ref', 'refs/remotes/origin/main', f.profile.applicationSource]);
    await assert.rejects(resolveReleaseBinding(f.value, f.options), /BINDING_LOCAL_REMOTE_MAIN_CHANGED/);
  } finally { f.cleanup(); }
});

test('v3 partial registration preserves prior and malformed returned identities with uncertainty', () => {
  const result = { schemaVersion: 3, registered: [], registrationOutcomeUncertain: true };
  const family = 'schoolpilot-production-api-emergency', arn = `arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:200`;
  assert.equal(retainSuccessorRegistration(result, 'api', { taskDefinition: { taskDefinitionArn: arn } }, 'e'.repeat(64), family), arn);
  assert.equal(result.registered[0].arn, arn); assert.equal(result.registrationOutcomeUncertain, false);
  retainSuccessorRegistration(result, 'scheduler-worker', { taskDefinition: { taskDefinitionArn: 'unexpected-but-returned-identity' } }, 'f'.repeat(64), 'schoolpilot-production-scheduler-worker');
  assert.equal(result.registered[0].arn, arn); assert.equal(result.registered[1].arn, 'unexpected-but-returned-identity'); assert.equal(result.registrationOutcomeUncertain, true);
  retainSuccessorRegistration(result, 'scheduler-worker', {}, 'f'.repeat(64), 'schoolpilot-production-scheduler-worker'); assert.equal(result.registered[2].arn, null); assert.equal(result.registrationOutcomeUncertain, true);
  assert.throws(() => retainSuccessorRegistration({ schemaVersion: 2, registered: [] }, 'api', {}, 'e'.repeat(64), family), /SUCCESSOR_REGISTRATION_SCHEMA_REQUIRED/);
});

test('rehashing stale, blocking or forced scan evidence cannot pass preparation', async () => {
  const f = await fixture();
  try {
    const scan = JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.scan.path)));
    scan.createdAt = '2026-10-06T00:00:00Z'; Object.assign(f.scanArtifacts.scan, { storage: 'committed', ...f.json(f.scanArtifacts.scan.path, scan) });
    f.reseal('successorScan', () => {});
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_SCAN_STALE/);
    scan.createdAt = time; Object.assign(f.scanArtifacts.scan, { storage: 'committed', ...f.json(f.scanArtifacts.scan.path, scan) });
    const custody = JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.custody.path))); custody.scanSha256 = f.scanArtifacts.scan.sha256; custody.forced = true;
    Object.assign(f.scanArtifacts.custody, { storage: 'committed', ...f.json(f.scanArtifacts.custody.path, custody) }); f.reseal('successorScan', () => {});
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_SCAN_CUSTODY_REQUIRED/);
    const report = JSON.parse(readFileSync(path.join(f.main, f.scanArtifacts.report.path))); report.Results[0].Vulnerabilities = [{ VulnerabilityID: 'SYNTHETIC-ONLY', Severity: 'CRITICAL' }];
    Object.assign(f.scanArtifacts.report, { storage: 'committed', ...f.json(f.scanArtifacts.report.path, report) }); scan.reportSha256 = f.scanArtifacts.report.sha256; scan.counts = scanCounts(report, f.profile.fallback.config);
    Object.assign(f.scanArtifacts.scan, { storage: 'committed', ...f.json(f.scanArtifacts.scan.path, scan) }); custody.forced = false; custody.scanSha256 = f.scanArtifacts.scan.sha256;
    Object.assign(f.scanArtifacts.custody, { storage: 'committed', ...f.json(f.scanArtifacts.custody.path, custody) }); f.reseal('successorScan', () => {});
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_SCAN_FAILED/);
  } finally { f.cleanup(); }
});

test('valid v3 publication roles unused121 Anchor128 and compatible fallback Plans stay offline; partial replay retains F identity', async () => {
  const f = await fixture();
  try {
    acceptOperationalFixture(f); const c = await controllerFixture(f);
    const anchorPublication = await c.preparation.planPublication({ ...c.serving, outputDirectory: path.join(c.plans, 'publish-anchor') }, { run: c.run });
    const fallbackPublication = await c.preparation.planPublication({ ...c.fallback, outputDirectory: path.join(c.plans, 'publish-fallback') }, { run: c.run });
    assert.equal(JSON.parse(readFileSync(anchorPublication.path)).releaseBinding.artifactRole, 'serving-anchor'); assert.equal(JSON.parse(readFileSync(fallbackPublication.path)).releaseBinding.artifactRole, 'fallback');
    const unusedPlan = await c.preparation.planUnused121({ ...c.unused121, outputDirectory: path.join(c.plans, 'unused121') }, { run: c.run });
    const anchorPlan = await c.registration.createAnchor128Plan({ ...c.anchor, outputDirectory: path.join(c.plans, 'anchor128') }, c.options);
    const fallbackInput = { ...c.fallbackRegistration, outputDirectory: path.join(c.plans, 'fallback129') };
    const fallbackPlan = await c.registration.createPlan(fallbackInput, c.options);
    assert.equal(c.commands.some(value => ['aws', 'gh', 'docker'].includes(value.executable)), false);
    const plan = JSON.parse(readFileSync(fallbackPlan.path)); assert.equal(plan.identities.source, SUCCESSOR_SOURCE); assert.equal(plan.artifactRole, 'fallback');
    for (const generated of Object.values(plan.generated)) assert.equal(generated.request.containerDefinitions[0].environment.find(value => value.name === 'GIT_SHA').value, SUCCESSOR_SOURCE);
    const authorization = c.pin('authorization.json', { schemaVersion: 1, operation: 'RegisterInactive', authorized: true, planSha256: fallbackPlan.sha256, startsAtUtc: new Date(Date.now() - 1000).toISOString(), expiresAtUtc: new Date(Date.now() + 300_000).toISOString() });
    c.behavior.failWorker = true;
    await assert.rejects(c.registration.registerInactive(fallbackPlan, authorization, c.options), /COMPATIBLE_INACTIVE_REGISTRATION_FAILED/);
    const receipt = JSON.parse(readFileSync(path.join(fallbackInput.outputDirectory, 'registration.private.json')));
    assert.equal(receipt.status, 'failed_retained_inactive'); assert.equal(receipt.registered.length, 1); assert.equal(receipt.registrationOutcomeUncertain, true); assert.equal(receipt.artifactRole, 'fallback'); assert.equal(receipt.artifactSource, SUCCESSOR_SOURCE);
    assert.equal(c.commands.filter(value => value.executable === 'aws' && value.args[1] === 'register-task-definition').length, 2);
    assert.equal(c.commands.some(value => ['update-service', 'run-task', 'deregister-task-definition', 'put-image'].includes(value.args[1])), false);
    c.behavior.failWorker = false; c.behavior.malformedArn = true; c.behavior.arm = 'anchor';
    const anchorAuthorization = c.pin('anchor-authorization.json', { schemaVersion: 1, operation: 'RegisterInactiveAnchor128', authorized: true, planSha256: anchorPlan.sha256, startsAtUtc: new Date(Date.now() - 1000).toISOString(), expiresAtUtc: new Date(Date.now() + 300_000).toISOString() });
    await assert.rejects(c.registration.registerAnchor128Inactive(anchorPlan, anchorAuthorization, c.options), /COMPATIBLE_ANCHOR128_REGISTRATION_FAILED/);
    const badAnchor = JSON.parse(readFileSync(path.join(c.plans, 'anchor128', 'registration.private.json'))); assert.equal(badAnchor.registered[0].arn, 'unexpected-but-returned-identity'); assert.equal(badAnchor.registrationOutcomeUncertain, true);
    c.behavior.arm = 'unused';
    const window = c.pin('unused-window.json', { owner: 'release-artifact-preparation', operation: 'RegisterUnused121', source: c.serving.source, planSha256: unusedPlan.sha256, servicesMayChange: false, tasksMayLaunch: false, productionDatabaseOperations: 0, startsAtUtc: new Date(Date.now() - 1000).toISOString(), expiresAtUtc: new Date(Date.now() + 300_000).toISOString() });
    const unusedAuthorization = c.pin('unused-authorization.json', { schemaVersion: 1, operation: 'RegisterUnused121', authorized: true, planSha256: unusedPlan.sha256, window });
    await assert.rejects(c.preparation.registerUnused121(unusedPlan, unusedAuthorization, c.options), /UNUSED121_REGISTRATION_FAILED/);
    const badUnused = JSON.parse(readFileSync(path.join(c.plans, 'unused121', 'registration.private.json'))); assert.equal(badUnused.registered[0].arn, 'unexpected-but-returned-identity'); assert.equal(badUnused.registrationOutcomeUncertain, true);
  } finally { f.cleanup(); }
});

test('superuser migration and restoration evidence fails even with fresh independent hashes', async () => {
  const f = await fixture();
  try {
    f.reseal('ordinaryRecovery', ({ native }) => { native.migration.role.rolsuper = true; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_RESTRICTED_MIGRATION_REQUIRED/);
    f.reseal('ordinaryRecovery', ({ native }) => { native.migration.role.rolsuper = false; });
    f.reseal('restrictedRestoration', ({ native }) => { native.restoration.ddlOwner.rolbypassrls = true; });
    await assert.rejects(validateSuccessorPreparation(f.value, f.options), /SUCCESSOR_RESTRICTED_RESTORATION_REQUIRED/);
  } finally { f.cleanup(); }
});

test('read-only preparation rejects a validator edit occurring during retained-evidence replay', async () => {
  const f = await fixture();
  try {
    let permissionCalls = 0;
    const run = async (executable, args) => {
      const result = await f.options.run(executable, args);
      if (executable === 'pwsh' && ++permissionCalls === 1) f.write('scripts/release-source-binding.mjs', readFileSync(path.join(f.main, 'scripts/release-source-binding.mjs'), 'utf8') + '\n// changed during replay\n');
      return result;
    };
    await assert.rejects(validateSuccessorPreparation(f.value, { ...f.options, run }), /SUCCESSOR_VALIDATOR_CHANGED/);
  } finally { f.cleanup(); }
});
