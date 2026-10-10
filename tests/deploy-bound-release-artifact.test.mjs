import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateDeploymentArtifact, validatePublicationScope } from '../scripts/validate-release297-deployment-artifact.mjs';
import { BUILD_SECURITY_BINDING_ID, BUILD_SECURITY_OPERATION_DEPENDENCIES } from '../scripts/release-source-binding.mjs';
import { bindingForRole } from '../scripts/release-source-binding.mjs';
import { FALLBACK, inventoryFor } from '../scripts/register-compatible-fallback-inactive.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex'), digest = bytes => `sha256:${sha(bytes)}`;
const main = 'a'.repeat(40), application = 'b'.repeat(40);
const helpers = ['scripts/release-source-binding.mjs', 'scripts/verify-legacy-deploy-image.mjs', 'scripts/register-compatible-fallback-inactive.mjs',
  'scripts/deploy-classpilot-runtime-config.ps1', 'src/config/rlsRegistry.json', ...BUILD_SECURITY_OPERATION_DEPENDENCIES];
function fixture(t, changes = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sp-bound-deploy-')), root = path.join(base, 'repo'), privateRoot = path.join(base, 'private');
  mkdirSync(root); mkdirSync(privateRoot);
  t.after(() => { assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep)); rmSync(base, { recursive: true }); });
  for (const file of [...helpers, 'scripts/prepare-release-artifacts.mjs', 'scripts/stamp-release-runtime-identity.mjs']) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), `reviewed:${file}`); }
  const save = (name, value) => { const file = path.join(privateRoot, name); writeFileSync(file, JSON.stringify(value)); return { path: file, sha256: sha(readFileSync(file)) }; };
  const config = digest('config'), manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: config }, layers: [] }), imageDigest = digest(manifest);
  const binding = { id: BUILD_SECURITY_BINDING_ID, sha256: sha('binding'), schemaVersion: 5, artifactRole: 'serving-anchor', artifactSource: application,
    artifact: { source: application, localIndex: digest('index'), config, platform: imageDigest }, operationToolDependencies: {} };
  const scan = { sourceSha: application, imageId: binding.artifact.localIndex, configDigest: config, passed: true, dockerHost: 'synthetic' };
  const scanRecord = save('scan.json', scan), plan = { schemaVersion: 5, kind: 'release-artifact-preparation', operation: 'PublishImage',
    input: { schemaVersion: 5, kind: 'serving-anchor', releaseBindingId: BUILD_SECURITY_BINDING_ID, source: main, sourceDirectory: root, scan: scanRecord },
    toolSource: main, toolSha256: sha(readFileSync(path.join(root, 'scripts/prepare-release-artifacts.mjs'))),
    helperHashes: Object.fromEntries(helpers.map(file => [file, sha(readFileSync(path.join(root, file)))])),
    releaseBinding: binding, scanIdentity: { imageId: scan.imageId, configDigest: config, dockerHost: scan.dockerHost },
    scanCleanupFile: save('cleanup.json', { complete: true }), tags: [main, main.slice(0, 12)], cloudMutationsDuringPlan: 0, servicesMayChange: false, tasksMayLaunch: false, productionDatabaseOperations: 0, signed: false };
  const fallbackSource = 'f'.repeat(40), currentSource = 'd'.repeat(40), fallbackConfig = digest('fallback-config');
  const fallbackManifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: fallbackConfig }, layers: [] });
  const fallbackDigest = digest(fallbackManifest);
  binding.servingSource = main;
  binding.fallback = { source: fallbackSource, localIndex: digest('fallback-index'), config: fallbackConfig, platform: fallbackDigest };
  binding.artifactPair = { 'serving-anchor': binding.artifact, fallback: { ...binding.fallback } };
  const requests = {}, generated = {}, definitions = {}, actualDefinitions = {}, registered = [];
  for (const role of ['api', 'scheduler-worker']) {
    const family = role === 'api' ? 'schoolpilot-production-api-emergency' : 'schoolpilot-production-scheduler-worker';
    const values = { GIT_SHA: currentSource, SERVICE_NAME: role, RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: inventoryFor(129).join(','),
      CLASSPILOT_USAGE_ROLLUP_MODE: 'off', CLASSPILOT_DIGITAL_USAGE_MODE: 'off' };
    const request = { family, cpu: role === 'api' ? '1024' : '512', memory: role === 'api' ? '2048' : '1024', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [{ name: role, image: `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@${digest('old')}`, environment: Object.entries(values).map(([name,value]) => ({ name,value })), secrets: [] }] };
    const original = { taskDefinition: { ...structuredClone(request), status: 'ACTIVE', taskDefinitionArn: `arn:aws:ecs:us-east-1:135775632425:task-definition/${family}:1` } };
    const originalRecord = save(`${role}-original.json`, original);
    definitions[role] = { path: path.basename(originalRecord.path), sha256: originalRecord.sha256 };
    request.containerDefinitions[0].image = `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@${fallbackDigest}`;
    request.containerDefinitions[0].environment.find(row => row.name === 'GIT_SHA').value = fallbackSource;
    requests[role] = request;
    generated[role] = { ...save(`${role}-request.json`, request), request, source: originalRecord, sourceArn: original.taskDefinition.taskDefinitionArn };
    const arn = `arn:aws:ecs:us-east-1:135775632425:task-definition/${family}:2`;
    registered.push({ role, arn, requestSha256: generated[role].sha256 });
    actualDefinitions[arn] = { taskDefinition: { ...structuredClone(request), status: 'ACTIVE', taskDefinitionArn: arn } };
  }
  const runtimeReview = save('runtime.json', { definitions });
  binding.currentRuntime = { review: { path: path.basename(runtimeReview.path), sha256: runtimeReview.sha256 }, capabilityEnvironment: {} };
  const fallbackBinding = bindingForRole(binding, 'fallback');
  const fallbackScan = { sourceSha: fallbackSource, imageId: binding.fallback.localIndex, configDigest: fallbackConfig, dockerHost: 'synthetic', passed: true };
  const fallbackScanRecord = save('fallback-scan.json', fallbackScan);
  const fallbackProof = save('fallback-proof.json', { schemaVersion: 1, passed: true, sourceSha: fallbackSource, receiptSha256: fallbackScanRecord.sha256,
    repository: 'schoolpilot-production-api', region: 'us-east-1', digest: fallbackDigest, platformDigest: fallbackDigest, configDigest: fallbackConfig });
  const fallbackPublicationPlan = save('fallback-pub-plan.json', { schemaVersion: 5, kind: 'release-artifact-preparation', operation: 'PublishImage',
    input: { schemaVersion: 5, kind: 'fallback', source: fallbackSource, releaseBindingId: BUILD_SECURITY_BINDING_ID, scan: fallbackScanRecord },
    toolSource: main, releaseBinding: fallbackBinding, toolSha256: plan.toolSha256, helperHashes: plan.helperHashes });
  const fallbackPublication = save('fallback-pub.json', { schemaVersion: 5, operation: 'PublishImage', status: 'published', artifactRole: 'fallback', artifactSource: fallbackSource,
    source: fallbackSource, releaseBinding: fallbackBinding, publicationOutcomeUncertain: false, servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0,
    plan: fallbackPublicationPlan, planSha256: fallbackPublicationPlan.sha256, registryDigest: fallbackDigest, registryProof: fallbackProof,
    authorization: save('fallback-pub-auth.json', { schemaVersion: 1, authorized: true, operation: 'PublishImage', planSha256: fallbackPublicationPlan.sha256, singlePublisher: true,
      window: save('fallback-pub-window.json', { owner: 'release-artifact-preparation', operation: 'PublishImage', source: fallbackSource, planSha256: fallbackPublicationPlan.sha256,
        singlePublisher: true, servicesMayChange: false, tasksMayLaunch: false, productionDatabaseOperations: 0, startsAtUtc: '2026-10-09T10:00:00Z', expiresAtUtc: '2026-10-09T10:20:00Z' }) }) });
  const fallbackPlan = { schemaVersion: 5, kind: 'compatible_fallback_inactive', artifactRole: 'fallback', artifactSource: fallbackSource,
    input: { schemaVersion: 5, admissionCount: 129, anchorSource: main, releaseBindingId: BUILD_SECURITY_BINDING_ID, retainedEvidenceDirectory: privateRoot,
      fallbackPublication, registryProof: fallbackProof }, releaseBinding: binding, cloudMutationsDuringPlan: 0, servicesMayChange: false,
    identities: { ...FALLBACK, ...binding.fallback, tag: fallbackSource.slice(0,12) }, generated, registryDigest: fallbackDigest, toolSource: main,
    toolSha256: sha(readFileSync(path.join(root, 'scripts/register-compatible-fallback-inactive.mjs'))), bindingHelperSha256: sha(readFileSync(path.join(root, 'scripts/release-source-binding.mjs'))),
    identityHelperSha256: sha(readFileSync(path.join(root, 'scripts/stamp-release-runtime-identity.mjs'))), permissionHelperSha256: sha(readFileSync(path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1'))) };
  changes.fallbackPlan?.(fallbackPlan);
  const fallbackPlanRecord = save('fallback-plan.json', fallbackPlan);
  const fallbackReceipt = { schemaVersion: 5, kind: 'compatible_fallback_inactive', operation: 'RegisterInactive', status: 'registered_inactive', artifactRole: 'fallback',
    source: fallbackSource, artifactSource: fallbackSource, registrationOutcomeUncertain: false, servicesUnchanged: true, servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0,
    releaseBinding: fallbackBinding, plan: fallbackPlanRecord, planSha256: fallbackPlanRecord.sha256, registered,
    authorization: save('fallback-auth.json', { schemaVersion: 1, authorized: true, operation: 'RegisterInactive', planSha256: fallbackPlanRecord.sha256,
      startsAtUtc: '2026-10-09T10:00:00Z', expiresAtUtc: '2026-10-09T10:20:00Z' }) };
  changes.fallbackReceipt?.(fallbackReceipt);
  const fallbackRegistration = save('fallback-registration.json', fallbackReceipt);
  changes.plan?.(plan);
  const planRecord = save('plan.json', plan), window = save('window.json', { owner: 'release-artifact-preparation', operation: 'PublishImage', source: main,
    planSha256: planRecord.sha256, singlePublisher: true, servicesMayChange: false, tasksMayLaunch: false, productionDatabaseOperations: 0,
    startsAtUtc: '2026-10-09T10:00:00Z', expiresAtUtc: '2026-10-09T10:20:00Z' });
  const receipt = { schemaVersion: 5, operation: 'PublishImage', status: 'published', signed: false, publicationOutcomeUncertain: false,
    servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0, artifactRole: 'serving-anchor', artifactSource: application,
    source: main, releaseBinding: binding, registryDigest: imageDigest, plan: planRecord, planSha256: planRecord.sha256,
    registryProof: save('proof.json', { schemaVersion: 1, passed: true, sourceSha: application, receiptSha256: scanRecord.sha256,
      repository: 'schoolpilot-production-api', region: 'us-east-1', digest: imageDigest, platformDigest: imageDigest, configDigest: config }),
    authorization: save('auth.json', { schemaVersion: 1, authorized: true, operation: 'PublishImage', planSha256: planRecord.sha256, singlePublisher: true, window }) };
  changes.receipt?.(receipt);
  const record = save('publication.json', receipt), calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    if (executable === 'pwsh') return { code: changes.privateFailure ? 1 : 0, stdout: '' };
    if (executable === 'gh') return { code: 0, stdout: JSON.stringify(args[0] === 'api' ? { commit: { sha: changes.movedMain ? 'c'.repeat(40) : main } } :
      [{ headSha: main, headBranch: 'main', event: 'push', workflowName: 'CI', status: 'completed', conclusion: changes.ciFailure ? 'failure' : 'success' }]) };
    assert.equal(executable, 'aws');
    assert.ok(['sts', 'ecr', 'ecs'].includes(args[0]));
    assert.ok(['get-caller-identity', 'describe-images', 'batch-get-image', 'describe-task-definition'].includes(args[1]), 'No mutation API permitted');
    const requestedFallback = args.some(arg => arg === `imageTag=${fallbackSource.slice(0,12)}` || arg === `imageDigest=${fallbackDigest}`);
    if (args[0] === 'ecs') { const value = structuredClone(actualDefinitions[args[args.indexOf('--task-definition')+1]]); if (changes.definitionMoved) value.taskDefinition.containerDefinitions[0].environment.push({ name: 'UNREVIEWED', value: 'true' }); return { code: 0, stdout: JSON.stringify(value) }; }
    const value = args[0] === 'sts' ? { Account: '135775632425' } : args[1] === 'describe-images' ? { imageDetails: [{ imageDigest: changes.tagMoved ? digest('substitution') : imageDigest }] } :
      { images: [{ registryId: '135775632425', repositoryName: 'schoolpilot-production-api', imageId: { imageDigest }, imageManifest: manifest, imageManifestMediaType: 'application/vnd.oci.image.manifest.v1+json' }], failures: [] };
    if (requestedFallback) {
      if (args[1] === 'describe-images') value.imageDetails[0].imageDigest = changes.fallbackTagMoved ? digest('substitution') : fallbackDigest;
      else { value.images[0].imageId.imageDigest = fallbackDigest; value.images[0].imageManifest = fallbackManifest; }
    }
    if (args[1] === 'batch-get-image' && changes.digestAliases) {
      value.images = [main, main.slice(0,12), 'e'.repeat(40), 'e'.repeat(12)].map(imageTag => ({ ...structuredClone(value.images[0]), imageId: { ...value.images[0].imageId, imageTag } }));
      if (changes.reverseAliases) value.images.reverse();
      if (requestedFallback) changes.aliasMutation?.(value);
    }
    return { code: 0, stdout: JSON.stringify(value) };
  };
  return { root, record, calls, options: { root, run, fallbackRegistration, resolve: async () => { if (changes.pending) throw new Error('BINDING_NOT_ACCEPTED'); return binding; },
    verifyScan: async (input, roleBinding) => roleBinding.artifactRole === 'fallback' ? fallbackScan : changes.scanSwap ? { ...scan, sourceSha: main } : scan } };
}

test('accepted serving publication is replayed read-only and stays explicitly unsigned', async t => {
  const f = fixture(t); const result = await validateDeploymentArtifact(f.record, main, f.options);
  assert.deepEqual([result.passed, result.mainSource, result.applicationSource, result.signed, result.cloudMutations], [true, main, application, false, 0]);
  assert.ok(f.calls.some(call => call.executable === 'aws'));
});
for (const reverseAliases of [false, true]) test(`both immutable serving and fallback digests accept four identical tag aliases in ${reverseAliases ? 'reverse' : 'original'} order`, async t => {
  const f = fixture(t, { digestAliases: true, reverseAliases });
  assert.equal((await validateDeploymentArtifact(f.record, main, f.options)).passed, true);
  assert.equal(f.calls.filter(call => call.executable === 'aws' && call.args[1] === 'batch-get-image').length, 2);
  assert.equal(f.calls.filter(call => call.executable === 'aws' && call.args[0] === 'ecs').length, 2);
});
for (const [name, aliasMutation] of Object.entries({
  registry: value => { value.images[1].registryId = '000000000000'; },
  repository: value => { value.images[1].repositoryName = 'other-repository'; },
  digest: value => { value.images[1].imageId.imageDigest = digest('substitution'); },
  manifest: value => { value.images[1].imageManifest += '\n'; },
  mediaType: value => { value.images[1].imageManifestMediaType = 'application/vnd.docker.distribution.manifest.v2+json'; },
  failure: value => { value.failures.push({ failureCode: 'ImageNotFound' }); },
})) test(`conflicting fallback alias ${name} rejects before registered-definition readback`, async t => {
  const f = fixture(t, { digestAliases: true, aliasMutation });
  await assert.rejects(validateDeploymentArtifact(f.record, main, f.options), /REGISTRY_/);
  assert.equal(f.calls.filter(call => call.executable === 'aws' && call.args[0] === 'ecs').length, 0);
});
for (const [name, changes] of Object.entries({ pending: { pending: true }, mixedRole: { receipt: r => { r.artifactRole = 'fallback'; } },
  crossBinding: { receipt: r => { r.releaseBinding.sha256 = sha('other binding'); } }, changedTool: { plan: p => { p.toolSha256 = sha('changed'); } },
  unknownBinding: { plan: p => { p.input.releaseBindingId = 'unreviewed'; } }, oldSchema: { plan: p => { p.input.schemaVersion = 4; } },
  uncertain: { receipt: r => { r.publicationOutcomeUncertain = true; } }, scanSwap: { scanSwap: true }, wrongPrivateAcl: { privateFailure: true },
  movedMain: { movedMain: true }, failedCi: { ciFailure: true } })) {
  test(`${name} rejects before AWS mutation or registry read`, async t => {
    const f = fixture(t, changes); await assert.rejects(validateDeploymentArtifact(f.record, main, f.options));
    assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
  });
}
test('tampered receipt hash and substituted registry tag reject', async t => {
  const f = fixture(t, { tagMoved: true }); await assert.rejects(validateDeploymentArtifact({ ...f.record, sha256: sha('tampered') }, main, f.options));
  assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
  await assert.rejects(validateDeploymentArtifact(f.record, main, f.options), /PUBLICATION_TAG_MOVED/);
});
for (const [name, changes] of Object.entries({ uncertainFallback: { fallbackReceipt: r => { r.registrationOutcomeUncertain = true; } },
  partialFallback: { fallbackReceipt: r => { r.registered.pop(); } }, mixedFallbackRole: { fallbackReceipt: r => { r.artifactRole = 'serving-anchor'; } },
  substitutedFallback: { fallbackPlan: p => { p.identities.source = main; } }, changedFallbackTool: { fallbackPlan: p => { p.toolSha256 = sha('changed'); } },
  wrongAdmission: { fallbackPlan: p => { p.input.admissionCount = 128; } }, changedFallbackRequest: { fallbackPlan: p => { p.generated.api.request.cpu = '512'; } } })) {
  test(`${name} fails before AWS`, async t => {
    const f = fixture(t, changes); await assert.rejects(validateDeploymentArtifact(f.record, main, f.options));
    assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
  });
}
test('missing fallback receipt fails before AWS; moved registered definitions and tags reject', async t => {
  const missing = fixture(t); delete missing.options.fallbackRegistration;
  await assert.rejects(validateDeploymentArtifact(missing.record, main, missing.options), /REVIEWED_FALLBACK/);
  assert.equal(missing.calls.filter(call => call.executable === 'aws').length, 0);
  for (const changes of [{ definitionMoved: true }, { fallbackTagMoved: true }]) {
    const f = fixture(t, changes); await assert.rejects(validateDeploymentArtifact(f.record, main, f.options));
  }
});
test('shell rejects incomplete and conflicting publication flags before AWS', t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!existsSync(bash)) return t.skip('Bash unavailable');
  const script = path.resolve('scripts/deploy.sh');
  for (const args of [ ['--release-artifact-publication', 'missing'], ['--release-artifact-publication-sha256', 'a'.repeat(64)],
    ['--frontend', '--release-artifact-publication', 'missing', '--release-artifact-publication-sha256', 'a'.repeat(64)],
    ['--backend', '--activate-emergency', '--immutable-image-sha', main, '--immutable-image-digest', digest('x'), '--release-artifact-publication', 'missing', '--release-artifact-publication-sha256', 'a'.repeat(64)] ]) {
    const result = spawnSync(bash, [script, ...args], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /AWS credentials/);
  }
});
test('bound deployment replays immediately before every registration, scaling hold and rollout mutation', () => {
  const script = readFileSync(path.resolve('scripts/deploy.sh'), 'utf8').replaceAll('\r\n', '\n');
  for (const fragment of [
    'replay_release_artifact || return 1\n  if ! worker_arn=$(aws ecs register-task-definition',
    'replay_release_artifact\n  STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN=$(aws ecs register-task-definition',
    'replay_release_artifact\n  EMERGENCY_TASK_DEF_ARN=$(aws ecs register-task-definition',
    'replay_release_artifact\n  acquire_production_scaling_hold\n  launch_safe_active_api_preflight',
    'replay_release_artifact\n  aws ecs run-task',
    'replay_release_artifact\n    aws ecs update-service',
  ]) assert.ok(script.includes(fragment), `Missing mutation boundary: ${fragment}`);
  const rollout = script.slice(script.indexOf('info "Updating ECS API service to ${API_ROLLOUT_TASK_DEF}..."'));
  assert.ok(rollout.indexOf('replay_release_artifact') < rollout.indexOf('CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=true'));
  assert.ok(rollout.indexOf('CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=true') < rollout.indexOf('aws ecs update-service'));
  const recovery = script.slice(script.indexOf('rollback_classpilot_tile_auth_deployment()'), script.indexOf('rollback_classpilot_tile_auth_deployment()') + 3300);
  assert.ok(recovery.includes('recovery_api="$RELEASE_ARTIFACT_RECOVERY_API"'));
  assert.ok(recovery.includes('recovery_worker="$RELEASE_ARTIFACT_RECOVERY_WORKER"'));
  assert.ok(recovery.includes('--task-definition "$recovery_api"'));
  assert.ok(recovery.includes('--task-definition "$recovery_worker"'));
  assert.doesNotMatch(recovery, /PRODUCTION_ROLLBACK_API_TASK_DEFINITION=/);
});


test('both full binding replays overlap in separate contexts and form a barrier before scan or AWS', { timeout: 5000 }, async t => {
  const f = fixture(t), originalResolve = f.options.resolve, originalScan = f.options.verifyScan;
  let notifyStarted, release, completed = 0;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const contexts = [], inputs = [];
  f.options.resolve = async (input, context) => {
    inputs.push(input); contexts.push(context);
    if (inputs.length === 2) notifyStarted();
    await barrier; const result = await originalResolve(input, context); completed += 1; return result;
  };
  f.options.verifyScan = async (...args) => { assert.equal(completed, 2); return originalScan(...args); };
  const pending = validateDeploymentArtifact(f.record, main, f.options);
  await started;
  assert.notEqual(contexts[0], contexts[1]);
  assert.notEqual(inputs[0], inputs[1]);
  assert.equal(inputs[0].kind, 'serving-anchor'); assert.equal(inputs[1].admissionCount, 129);
  assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
  release(); assert.equal((await pending).passed, true); assert.equal(completed, 2);
});

test('full binding replay drains both failures and reports serving failure first without AWS', async t => {
  const f = fixture(t), servingFailure = new Error('SERVING_REPLAY_FAILURE'), fallbackFailure = new Error('FALLBACK_REPLAY_FAILURE');
  const finished = [];
  let fallbackStarted;
  const fallback = new Promise(resolve => { fallbackStarted = resolve; });
  f.options.resolve = (input) => {
    if (input.kind !== 'serving-anchor') { finished.push('fallback'); fallbackStarted(); throw fallbackFailure; }
    return fallback.then(() => { finished.push('serving'); throw servingFailure; });
  };
  await assert.rejects(validateDeploymentArtifact(f.record, main, f.options), error => error === servingFailure);
  assert.deepEqual(finished, ['fallback', 'serving']);
  assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
});

for (const target of ['receipt', 'plan']) test(`a fallback ${target} changed during full replay rejects before AWS`, async t => {
  const f = fixture(t), original = f.options.resolve;
  let changed = false;
  f.options.resolve = async (...args) => {
    if (!changed) {
      changed = true;
      const receipt = JSON.parse(readFileSync(f.options.fallbackRegistration.path, 'utf8'));
      const file = target === 'receipt' ? f.options.fallbackRegistration.path : receipt.plan.path;
      const value = JSON.parse(readFileSync(file, 'utf8')); value.unreviewedChange = true; writeFileSync(file, JSON.stringify(value));
    }
    return original(...args);
  };
  await assert.rejects(validateDeploymentArtifact(f.record, main, f.options), /INPUT_CHANGED/);
  assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
});

for (const role of ['serving-anchor', 'fallback']) test(`a substituted ${role} replay cannot pass the paired replay barrier`, async t => {
  const f = fixture(t), original = f.options.resolve;
  let completed = 0;
  f.options.resolve = async (input, context) => {
    const binding = structuredClone(await original(input, context)); completed += 1;
    if ((input.kind === 'serving-anchor') === (role === 'serving-anchor')) binding.sha256 = sha('substituted binding');
    return binding;
  };
  await assert.rejects(validateDeploymentArtifact(f.record, main, f.options));
  assert.equal(completed, 2); assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
});

test('invalid pinned fallback tool fails before either full replay or AWS', async t => {
  const f = fixture(t, { fallbackPlan: plan => { plan.toolSha256 = sha('changed'); } });
  let replays = 0; f.options.resolve = async () => { replays += 1; throw new Error('MUST_NOT_RESOLVE'); };
  await assert.rejects(validateDeploymentArtifact(f.record, main, f.options), /FALLBACK_TOOL_CHANGED/);
  assert.equal(replays, 0); assert.equal(f.calls.filter(call => call.executable === 'aws').length, 0);
});
