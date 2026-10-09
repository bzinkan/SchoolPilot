#!/usr/bin/env node
// Artifact preparation only. This module never launches tasks or changes services.
import assert from 'node:assert/strict';
import { bindingSchema, isSuccessorSchema, resolveReleaseBinding, assertBindingReplay, assertBoundPublication, assertBoundScan, boundArtifactSource, validateSuccessorPreparation } from './release-source-binding.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveConfigDigest, inspectImage, runCommand, scanCounts, SCANNER, validateRegistryManifest, verifyPublishedImage } from './verify-legacy-deploy-image.mjs';
import { anchor128Stages, ecsRequestTags, FALLBACK, registrationEnvironmentProjection, validateCleanupCustody, validateSourceResponse, retainSuccessorRegistration } from './register-compatible-fallback-inactive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY = Object.freeze({ account: '135775632425', region: 'us-east-1', repository: 'schoolpilot-production-api' });
const uri = `${REGISTRY.account}.dkr.ecr.${REGISTRY.region}.amazonaws.com/${REGISTRY.repository}`;
const sha = /^[a-f0-9]{40}$/, digest = /^sha256:[a-f0-9]{64}$/, hashPattern = /^[a-f0-9]{64}$/;
const roles = ['api', 'scheduler-worker'];
const providerFields = new Set(['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']);
const imageInputs = ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'drizzle.config.ts', 'Dockerfile', '.dockerignore', 'config', 'docs/soc2'];
const helpers = ['scripts/release-source-binding.mjs', 'scripts/verify-legacy-deploy-image.mjs', 'scripts/register-compatible-fallback-inactive.mjs', 'scripts/deploy-classpilot-runtime-config.ps1', 'src/config/rlsRegistry.json'];
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(sort) : sort(value) : value);
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const equal = (actual, expected, code) => assert.ok(canonical(actual) === canonical(expected), code);
function ordinaryFile(filename) {
  assert.ok(path.isAbsolute(filename), 'ABSOLUTE_PATH_REQUIRED');
  let cursor = path.resolve(filename);
  while (true) { if (existsSync(cursor)) assert.ok(!lstatSync(cursor).isSymbolicLink(), 'REPARSE_PATH_REJECTED'); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  assert.ok(lstatSync(filename).isFile() && realpathSync(filename) === path.resolve(filename), 'ORDINARY_FILE_REQUIRED');
  return filename;
}
function pinned(record) {
  assert.match(record?.sha256 ?? '', hashPattern, 'INPUT_HASH_REQUIRED');
  const bytes = readFileSync(ordinaryFile(record.path)); equal(hash(bytes), record.sha256, 'INPUT_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}
function writeNew(filename, value) { writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
function record(filename) { return { path: filename, sha256: hash(readFileSync(ordinaryFile(filename))) }; }
async function fileHash(filename) { ordinaryFile(filename); const value = createHash('sha256'); for await (const chunk of createReadStream(filename)) value.update(chunk); return value.digest('hex'); }
function helperHashes() { return Object.fromEntries(helpers.map(file => [file, hash(readFileSync(path.join(root, file)))])); }
async function checked(run, executable, args, options = {}) {
  const result = await run(executable, args, options); assert.ok(result.code === 0, 'BOUND_COMMAND_FAILED'); return result.stdout;
}
async function sourceContract(input, run) {
  bindingSchema(input);
  if (input.schemaVersion === 2) assert.equal(input.kind, 'serving-anchor', 'V2_SERVING_BINDING_ONLY');
  const releaseBinding = await resolveReleaseBinding(input, { root, run, fallback: FALLBACK, sourceDirectory: input.sourceDirectory, source: input.source });
  assert.match(input.source ?? '', sha, 'FULL_SOURCE_REQUIRED'); assert.ok(path.isAbsolute(input.sourceDirectory), 'SOURCE_DIRECTORY_REQUIRED');
  equal((await checked(run, 'git', ['-C', input.sourceDirectory, 'rev-parse', 'HEAD'])).trim(), input.source, 'SOURCE_MOVED');
  equal((await checked(run, 'git', ['-C', input.sourceDirectory, 'status', '--porcelain'])).trim(), '', 'SOURCE_DIRTY');
  if (input.kind === 'serving-anchor' && input.schemaVersion === 1) {
    equal((await checked(run, 'git', ['-C', input.sourceDirectory, 'diff', '--name-only', FALLBACK.application, input.source, '--', ...imageInputs])).trim(), '', 'APPLICATION_BYTES_CHANGED');
  } else if (input.kind !== 'serving-anchor') { equal(input.kind, 'fallback', 'PUBLICATION_KIND_INVALID'); equal(input.source, releaseBinding?.fallback?.source ?? FALLBACK.source, 'FALLBACK_SOURCE_CHANGED'); }
  return releaseBinding;
}
export function validateMainCi(proof, source) {
  equal([proof?.repository, proof?.branch, proof?.source], ['bzinkan/SchoolPilot', 'main', source], 'MAIN_CI_IDENTITY_INVALID');
  assert.ok(Array.isArray(proof.runs) && proof.runs.length > 0 && proof.runs.length <= 100, 'MAIN_CI_REQUIRED');
  const latest = new Map();
  for (const run of proof.runs) {
    equal([run.headSha, run.headBranch, run.event], [source, 'main', 'push'], 'MAIN_CI_RUN_IDENTITY_INVALID');
    assert.ok(typeof run.workflowName === 'string' && run.workflowName.length > 0, 'MAIN_CI_WORKFLOW_INVALID');
    if (!latest.has(run.workflowName)) latest.set(run.workflowName, run);
  }
  assert.ok(latest.has('CI') && latest.get('CI').conclusion === 'success', 'MAIN_CI_REQUIRED');
  for (const run of latest.values()) assert.ok(run.status === 'completed' && ['success', 'skipped', 'neutral'].includes(run.conclusion), 'MAIN_CI_NOT_GREEN');
}
export async function validateLocalScan(input, releaseBinding) {
  const artifactSource = boundArtifactSource(releaseBinding) ?? input.source;
  if (input.schemaVersion >= 2) assert.ok(releaseBinding, 'SCAN_BINDING_REQUIRED');
  const scan = pinned(input.scan); equal([scan.schemaVersion, scan.sourceSha, scan.passed, scan.scanner, scan.os, scan.architecture], [1, artifactSource, true, SCANNER, 'linux', 'amd64'], 'SCAN_IDENTITY_INVALID');
  assert.match(scan.imageId ?? '', digest, 'LOCAL_INDEX_REQUIRED'); assert.match(scan.configDigest ?? '', digest, 'CONFIG_DIGEST_REQUIRED');
  assert.ok(typeof scan.dockerHost === 'string' && scan.dockerHost.length > 0 && !/[\r\n]/.test(scan.dockerHost), 'DOCKER_HOST_REQUIRED');
  const custody = pinned(input.scanCleanup); validateCleanupCustody(input.scan.sha256, custody);
  const directory = path.dirname(input.scan.path), report = path.join(directory, 'reports/trivy.json'), archive = path.join(directory, 'input/image.tar');
  const cleanup = JSON.parse(readFileSync(ordinaryFile(path.join(directory, 'cleanup.json')), 'utf8'));
  equal([cleanup.complete, cleanup.ownedScanner], [true, custody.ownedScanner], 'SCAN_CLEANUP_UNCONFIRMED');
  equal(await fileHash(report), scan.reportSha256, 'SCAN_REPORT_CHANGED');
  const counts = scanCounts(JSON.parse(readFileSync(report, 'utf8')), scan.configDigest); equal(counts, scan.counts, 'SCAN_COUNTS_CHANGED'); equal([counts.HIGH, counts.CRITICAL], [0, 0], 'BLOCKING_SCAN_FINDINGS');
  equal(await fileHash(archive), scan.archiveSha256, 'SCAN_ARCHIVE_CHANGED'); equal(await archiveConfigDigest(archive, artifactSource), scan.configDigest, 'ARCHIVE_CONFIG_CHANGED');
  if (releaseBinding) assertBoundScan(scan, releaseBinding);
  if (input.kind === 'fallback') { const fallback = releaseBinding?.fallback ?? FALLBACK; equal([scan.imageId, scan.configDigest], [fallback.localIndex, fallback.config], 'EXACT_FALLBACK_IMAGE_REQUIRED'); }
  return scan;
}
async function privatePermissions(directory, inputs, run) {
  const helper = path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1'); assert.ok([FALLBACK.permissionHelperSha256, FALLBACK.permissionHelperLfSha256].includes(hash(readFileSync(helper))), 'PERMISSION_HELPER_CHANGED');
  const bridge = path.join(directory, 'private-paths.ps1');
  writeNew(path.join(directory, 'private-inputs.json'), inputs);
  writeFileSync(bridge, 'param([string]$Helper,[string]$Directory,[string]$Repository,[string]$Inputs)\n. $Helper\nAssert-NoReparsePointInExistingPath -Path $Directory\nSet-PrivatePathPermissions -Path $Directory -Directory\nAssert-PrivatePathPermissions -Path $Directory -Directory\nforeach ($entry in (Get-Content -LiteralPath $Inputs -Raw | ConvertFrom-Json)) { [void](Assert-PrivateInputPath -Path $entry -RepositoryRoot $Repository) }\n', { flag: 'wx', mode: 0o600 });
  await checked(run, 'pwsh', ['-NoProfile', '-File', bridge, '-Helper', helper, '-Directory', directory, '-Repository', root, '-Inputs', path.join(directory, 'private-inputs.json')]);
}
async function newPlan(input, operation, run) {
  assert.ok([1, 2, 3, 4].includes(input.schemaVersion) && path.isAbsolute(input.outputDirectory) && !existsSync(input.outputDirectory), 'FRESH_PLAN_DIRECTORY_REQUIRED');
  for (const directory of [root, input.sourceDirectory]) { const relative = path.relative(directory, input.outputDirectory); assert.ok(relative.startsWith('..') && !path.isAbsolute(relative), 'PLAN_MUST_BE_OUTSIDE_SOURCE'); }
  const releaseBinding = await sourceContract(input, run);
  const toolSource = (await checked(run, 'git', ['-C', root, 'rev-parse', 'HEAD'])).trim(); assert.match(toolSource, sha, 'TOOL_SOURCE_REQUIRED'); equal((await checked(run, 'git', ['-C', root, 'status', '--porcelain'])).trim(), '', 'TOOL_DIRTY');
  mkdirSync(input.outputDirectory, { recursive: false, mode: 0o700 });
  await privatePermissions(input.outputDirectory, Object.values(input).filter(value => value?.path && value?.sha256).map(value => value.path), run);
  return { schemaVersion: input.schemaVersion, ...(releaseBinding ? { releaseBinding } : {}), kind: 'release-artifact-preparation', operation, input, toolSource, toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))), helperHashes: helperHashes(), cloudMutationsDuringPlan: 0, servicesMayChange: false, tasksMayLaunch: false, productionDatabaseOperations: 0, signed: false };
}
export async function planPublication(input, { run = runCommand, verifyScan = validateLocalScan } = {}) {
  const releaseBinding = bindingSchema(input) >= 2 ? await sourceContract(input, run) : undefined;
  assert.ok(!existsSync(path.join(path.dirname(input.scan.path), 'registry-proof.json')), 'FRESH_REGISTRY_PROOF_REQUIRED');
  if (input.kind === 'serving-anchor') validateMainCi(pinned(input.mainCi), input.source);
  else if (isSuccessorSchema(input.schemaVersion)) validateMainCi(pinned(input.mainCi), input.mainSource);
  equal(pinned(input.publisherConfiguration), { repository: 'bzinkan/SchoolPilot', variable: 'IMMUTABLE_RELEASE_IMAGE_ENABLED', enabled: false }, 'EXCLUSIVE_PUBLISHER_CONFIGURATION_REQUIRED');
  const repository = pinned(input.repository); assert.ok(repository.repositories?.length === 1, 'REPOSITORY_UNAVAILABLE'); validatePublicationRepository(repository.repositories[0]);
  const scan = await verifyScan(input, releaseBinding);
  if (releaseBinding) assertBoundScan(scan, releaseBinding);
  const plan = await newPlan(input, 'PublishImage', run);
  plan.scanCleanupFile = record(path.join(path.dirname(input.scan.path), 'cleanup.json'));
  plan.scanIdentity = { imageId: scan.imageId, configDigest: scan.configDigest, dockerHost: scan.dockerHost };
  plan.tags = [input.source, input.source.slice(0, 12)];
  const filename = path.join(input.outputDirectory, 'publication-plan.private.json'); writeNew(filename, plan); return record(filename);
}
function projection(response) { const request = Object.fromEntries(Object.entries(structuredClone(response.taskDefinition)).filter(([key]) => !providerFields.has(key))); const tags = ecsRequestTags(response.tags); if (tags !== undefined) request.tags = tags; return request; }
export function renderUnused121Pair(sources, live, source, image) {
  assert.match(source, sha); assert.match(image, digest); const inventory = anchor128Stages()[0];
  assert.ok(live?.services?.length === 2 && (live.failures ?? []).length === 0, 'LIVE_SERVICES_REQUIRED');
  equal(live.services.map(value => value.serviceName).sort(), ['schoolpilot-production-api', 'schoolpilot-production-scheduler-worker'], 'LIVE_SERVICES_INVALID');
  const requests = {};
  for (const role of roles) {
    const response = sources[role], container = response?.taskDefinition?.containerDefinitions?.find(value => value.name === role);
    const originalSource = container?.environment?.find(value => value.name === 'GIT_SHA')?.value, originalImage = container?.image?.replace(`${uri}@`, '');
    assert.match(originalSource ?? '', sha, 'BASELINE_SOURCE_REQUIRED'); assert.match(originalImage ?? '', digest, 'BASELINE_DIGEST_REQUIRED');
    validateSourceResponse(response, role, originalSource, originalImage, inventory);
    const service = live.services.find(value => value.serviceName === `schoolpilot-production-${role === 'api' ? 'api' : 'scheduler-worker'}`);
    equal(service.taskDefinition, response.taskDefinition.taskDefinitionArn, 'SOURCE_IS_NOT_CURRENT_SERVICE');
    assert.ok(service.status === 'ACTIVE' && service.runningCount === service.desiredCount && service.pendingCount === 0 && service.desiredCount >= 1 && service.deployments?.length === 1 && service.deployments[0].status === 'PRIMARY' && service.deployments[0].rolloutState === 'COMPLETED', 'LIVE_SERVICE_NOT_STABLE');
    const request = projection(response), target = request.containerDefinitions.find(value => value.name === role); target.image = `${uri}@${image}`;
    target.environment.find(value => value.name === 'GIT_SHA').value = source;
    const restored = structuredClone(request), previous = restored.containerDefinitions.find(value => value.name === role); previous.image = container.image; previous.environment.find(value => value.name === 'GIT_SHA').value = originalSource;
    equal(registrationEnvironmentProjection(restored), registrationEnvironmentProjection(projection(response)), 'UNRELATED_DEFINITION_MUTATION');
    const { tags, ...taskRequest } = request;
    validateSourceResponse({ taskDefinition: { ...taskRequest, ...Object.fromEntries(Object.entries(response.taskDefinition).filter(([key]) => providerFields.has(key))) }, tags }, role, source, image, inventory);
    requests[role] = request;
  }
  const controls = role => Object.fromEntries(sources[role].taskDefinition.containerDefinitions.find(value => value.name === role).environment.filter(value => value.name.startsWith('CLASSPILOT_CAP_') || ['CLASSPILOT_CAPABILITY_ROLLOUTS_JSON', 'CLASSPILOT_PROTOCOL_V3_ENABLED'].includes(value.name)).map(value => [value.name, value.value]));
  equal(controls('api'), controls('scheduler-worker'), 'PAIR_CAPABILITY_MISMATCH');
  return requests;
}
export async function planUnused121(input, { run = runCommand, verifyScan = validateLocalScan } = {}) {
  const releaseBinding = input.schemaVersion >= 2 ? await sourceContract(input, run) : undefined;
  bindingSchema(input);
  equal(input.kind, 'serving-anchor', 'ANCHOR_PUBLICATION_ONLY');
  const publication = pinned(input.publication); assert.ok(publication.status === 'published' && publication.source === input.source && publication.signed === false && publication.publicationOutcomeUncertain === false, 'SUCCESSFUL_PUBLICATION_REQUIRED');
  const proof = pinned(publication.registryProof), scan = await verifyScan(input, releaseBinding);
  if (releaseBinding) assertBoundScan(scan, releaseBinding);
  equal([proof.passed, proof.sourceSha, proof.receiptSha256, proof.configDigest, proof.repository, proof.region], [true, boundArtifactSource(releaseBinding) ?? input.source, input.scan.sha256, scan.configDigest, REGISTRY.repository, REGISTRY.region], 'REGISTRY_PROOF_INVALID'); assert.match(proof.digest ?? '', digest);
  if (releaseBinding) assertBoundPublication(publication, releaseBinding, input.source, proof.digest);
  equal(publication.registryDigest, proof.digest, 'PUBLICATION_DIGEST_CHANGED'); validateMainCi(pinned(input.mainCi), input.source);
  const sources = { api: pinned(input.api), 'scheduler-worker': pinned(input.worker) }, live = pinned(input.liveServices), requests = renderUnused121Pair(sources, live, input.source, proof.digest);
  const plan = await newPlan(input, 'RegisterUnused121', run); plan.scanCleanupFile = record(path.join(path.dirname(input.scan.path), 'cleanup.json')); plan.registryProof = publication.registryProof; plan.registryDigest = proof.digest; plan.liveServicesSha256 = hash(live.services); plan.generated = {};
  for (const role of roles) { const filename = path.join(input.outputDirectory, `${role}.private.json`); writeNew(filename, requests[role]); plan.generated[role] = { ...record(filename), request: requests[role], source: role === 'api' ? input.api : input.worker, sourceArn: sources[role].taskDefinition.taskDefinitionArn }; }
  const filename = path.join(input.outputDirectory, 'unused121-plan.private.json'); writeNew(filename, plan); return record(filename);
}
function authorized(planRecord, plan, authorizationRecord, now) {
  const auth = pinned(authorizationRecord); assert.ok(auth.schemaVersion === 1 && auth.authorized === true && auth.operation === plan.operation && auth.planSha256 === planRecord.sha256, 'EXACT_AUTHORIZATION_REQUIRED');
  const window = pinned(auth.window); equal([window.owner, window.operation, window.source, window.planSha256], ['release-artifact-preparation', plan.operation, plan.input.source, planRecord.sha256], 'WINDOW_BINDING_INVALID');
  equal([window.servicesMayChange, window.tasksMayLaunch, window.productionDatabaseOperations], [false, false, 0], 'WINDOW_SCOPE_INVALID');
  if (plan.operation === 'PublishImage') equal([auth.singlePublisher, window.singlePublisher], [true, true], 'EXCLUSIVE_PUBLISHER_REQUIRED');
  const start = Date.parse(window.startsAtUtc), end = Date.parse(window.expiresAtUtc); assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 1_200_000, 'WINDOW_DURATION_INVALID');
  const inWindow = () => assert.ok(now() >= start && now() < end, 'WINDOW_CLOSED'); inWindow(); return { inWindow, remaining: () => Math.floor(end - now()) };
}
async function replayPlan(planRecord, operation, authorizationRecord, { run, now }) {
  const plan = pinned(planRecord); equal([plan.kind, plan.operation, plan.toolSha256, plan.helperHashes], ['release-artifact-preparation', operation, hash(readFileSync(fileURLToPath(import.meta.url))), helperHashes()], 'PLAN_OR_TOOL_CHANGED');
  equal([plan.schemaVersion, plan.cloudMutationsDuringPlan, plan.servicesMayChange, plan.tasksMayLaunch, plan.productionDatabaseOperations, plan.signed], [bindingSchema(plan.input), 0, false, false, 0, false], 'PLAN_SCOPE_CHANGED');
  if (operation === 'PublishImage') equal(plan.tags, [plan.input.source, plan.input.source.slice(0, 12)], 'EXACT_SOURCE_TAGS_REQUIRED');
  else { equal(plan.input.kind, 'serving-anchor', 'ANCHOR_PUBLICATION_ONLY'); equal(Object.keys(plan.generated).sort(), [...roles].sort(), 'EXACT_PAIR_REQUIRED'); }
  const window = authorized(planRecord, plan, authorizationRecord, now);
  equal((await checked(run, 'git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), plan.toolSource, 'TOOL_SOURCE_MOVED'); equal((await checked(run, 'git', ['-C', root, 'status', '--porcelain'])).trim(), '', 'TOOL_DIRTY'); assertBindingReplay(plan.input, plan.releaseBinding, await sourceContract(plan.input, run));
  for (const value of Object.values(plan.input)) if (value?.path && value?.sha256) pinned(value);
  pinned(plan.scanCleanupFile);
  if (plan.releaseBinding) assertBoundScan(pinned(plan.input.scan), plan.releaseBinding);
  if (plan.releaseBinding && operation === 'RegisterUnused121') assertBoundPublication(pinned(plan.input.publication), plan.releaseBinding, plan.input.source, plan.registryDigest);
  window.inWindow(); return { plan, window };
}
export function validatePublicationRepository(repository) {
  equal([repository?.registryId, repository?.repositoryName], [REGISTRY.account, REGISTRY.repository], 'REGISTRY_CONTEXT_CHANGED');
  assert.ok(['MUTABLE', 'IMMUTABLE', 'MUTABLE_WITH_EXCLUSION', 'IMMUTABLE_WITH_EXCLUSION'].includes(repository.imageTagMutability), 'TAG_POLICY_UNAVAILABLE');
  for (const filter of repository.imageTagMutabilityExclusionFilters ?? []) {
    assert.ok(filter.filterType === 'WILDCARD' && typeof filter.filter === 'string', 'TAG_FILTER_INVALID');
  }
}
export function validatePublicationPlatform(kind, proof, configDigest, releaseBinding) {
  assert.match(proof.digest ?? '', digest, 'REGISTRY_DIGEST_REQUIRED'); assert.match(proof.platformDigest ?? '', digest, 'REGISTRY_PLATFORM_REQUIRED');
  equal(proof.configDigest, configDigest, 'REGISTRY_CONFIG_CHANGED');
  if (isSuccessorSchema(releaseBinding?.schemaVersion)) equal(proof.platformDigest, releaseBinding.artifact.platform, 'BOUND_PLATFORM_CHANGED');
  if (kind === 'fallback') equal(proof.platformDigest, releaseBinding?.fallback?.platform ?? FALLBACK.platform, 'EXACT_FALLBACK_PLATFORM_REQUIRED');
}
const aws = args => [...args, '--region', REGISTRY.region, '--output', 'json', '--no-cli-pager'];
async function identity(run, call) { equal(JSON.parse(await call('aws', aws(['sts', 'get-caller-identity']))).Account, REGISTRY.account, 'AWS_ACCOUNT_CHANGED'); }
async function currentMain(input, call) {
  if (input.kind !== 'serving-anchor' && !isSuccessorSchema(input.schemaVersion)) return;
  const mainSource = input.kind === 'fallback' ? input.mainSource : input.source;
  const branch = JSON.parse(await call('gh', ['api', 'repos/bzinkan/SchoolPilot/branches/main'])); equal(branch.commit?.sha, mainSource, 'REMOTE_MAIN_CHANGED');
  const runs = JSON.parse(await call('gh', ['run', 'list', '--repo', 'bzinkan/SchoolPilot', '--commit', mainSource, '--event', 'push', '--limit', '100', '--json', 'headSha,headBranch,event,status,conclusion,workflowName'])); validateMainCi({ repository: 'bzinkan/SchoolPilot', branch: 'main', source: mainSource, runs }, mainSource);
}
async function exclusivePublisher(call) {
  const pages = JSON.parse(await call('gh', ['api', '--paginate', '--slurp', 'repos/bzinkan/SchoolPilot/actions/variables?per_page=100']));
  assert.ok(Array.isArray(pages) && pages.length > 0 && pages.length <= 100 && pages.every(value => Array.isArray(value.variables)), 'PUBLISHER_CONFIGURATION_UNAVAILABLE');
  const values = pages.flatMap(value => value.variables).filter(value => value.name === 'IMMUTABLE_RELEASE_IMAGE_ENABLED');
  assert.ok(values.length <= 1, 'PUBLISHER_CONFIGURATION_UNAVAILABLE');
  assert.ok(values.length === 0 || values[0].value === 'false', 'CI_PUBLISHER_MUST_REMAIN_DISABLED');
}
// Tokens stay in memory and stdin; never in argv, files, stdout or receipts.
async function loginDocker(host, password, timeout) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['--host', host, 'login', '--username', 'AWS', '--password-stdin', `${REGISTRY.account}.dkr.ecr.${REGISTRY.region}.amazonaws.com`], { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
    let error; const timer = setTimeout(() => { error = new Error('DOCKER_LOGIN_DEADLINE'); child.kill(); }, timeout);
    child.on('error', () => { error = new Error('DOCKER_LOGIN_FAILED'); });
    child.on('close', code => { clearTimeout(timer); error || code !== 0 ? reject(error ?? new Error('DOCKER_LOGIN_FAILED')) : resolve(); });
    child.stdin.on('error', () => { error = new Error('DOCKER_LOGIN_FAILED'); child.kill(); }); child.stdin.end(`${password.trim()}\n`);
  });
}
async function remoteTag(tag, call) {
  const result = JSON.parse(await call('aws', aws(['ecr', 'batch-get-image', '--registry-id', REGISTRY.account, '--repository-name', REGISTRY.repository, '--image-ids', `imageTag=${tag}`])));
  if (result.images?.length === 0 && result.failures?.length === 1 && result.failures[0].failureCode === 'ImageNotFound') return undefined;
  assert.ok(result.images?.length === 1 && (result.failures ?? []).length === 0, 'SOURCE_TAG_READ_FAILED'); equal([result.images[0].registryId, result.images[0].repositoryName, result.images[0].imageId.imageTag], [REGISTRY.account, REGISTRY.repository, tag], 'SOURCE_TAG_IDENTITY_CHANGED'); return result.images[0];
}
async function assertTagsBeforeMutation(tags, expectedDigest, call) {
  for (const tag of tags) { const image = await remoteTag(tag, call); if (image) { assert.ok(expectedDigest, 'SOURCE_TAG_APPEARED'); equal(image.imageId.imageDigest, expectedDigest, 'SOURCE_TAG_CONFLICT'); } }
}
async function finalSource(plan, run) {
  assertBindingReplay(plan.input, plan.releaseBinding, await sourceContract(plan.input, run));
  equal((await checked(run, 'git', ['-C', root, 'rev-parse', 'HEAD'])).trim(), plan.toolSource, 'TOOL_SOURCE_MOVED');
  equal((await checked(run, 'git', ['-C', root, 'status', '--porcelain'])).trim(), '', 'TOOL_DIRTY');
  equal([hash(readFileSync(fileURLToPath(import.meta.url))), helperHashes()], [plan.toolSha256, plan.helperHashes], 'TOOL_CHANGED_DURING_OPERATION'); pinned(plan.scanCleanupFile);
}
function receiptWriter(directory, name, initial) {
  const filename = path.join(directory, name); assert.ok(!existsSync(filename), 'PLAN_ALREADY_USED'); writeNew(filename, initial);
  return { filename, value: initial, save() { writeFileSync(filename, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 }); } };
}
export async function publishImage(planRecord, authorizationRecord, { run = runCommand, now = Date.now, verifyScan = validateLocalScan, login = loginDocker, verifyPublished = verifyPublishedImage } = {}) {
  const { plan, window } = await replayPlan(planRecord, 'PublishImage', authorizationRecord, { run, now });
  const receipt = receiptWriter(plan.input.outputDirectory, 'publication.private.json', { schemaVersion: plan.schemaVersion, ...(plan.releaseBinding ? { releaseBinding: plan.releaseBinding, artifactSource: boundArtifactSource(plan.releaseBinding), ...(isSuccessorSchema(plan.schemaVersion) ? { artifactRole: plan.releaseBinding.artifactRole } : {}) } : {}), operation: plan.operation, plan: planRecord, authorization: authorizationRecord, planSha256: planRecord.sha256, source: plan.input.source, status: 'started', signed: false, publicationOutcomeUncertain: false, publishedTags: [], servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0 });
  const call = async (exe, args, options = {}) => { window.inWindow(); return checked(run, exe, args, { ...options, timeout: Math.min(options.timeout ?? 120_000, window.remaining()) }); };
  try {
    assert.ok(!existsSync(path.join(path.dirname(plan.input.scan.path), 'registry-proof.json')), 'FRESH_REGISTRY_PROOF_REQUIRED');
    const scan = await verifyScan(plan.input, plan.releaseBinding); if (plan.releaseBinding) assertBoundScan(scan, plan.releaseBinding); equal(plan.scanIdentity, { imageId: scan.imageId, configDigest: scan.configDigest, dockerHost: scan.dockerHost }, 'SCAN_IDENTITY_CHANGED');
    await identity(run, call); await currentMain(plan.input, call); await exclusivePublisher(call);
    const repository = JSON.parse(await call('aws', aws(['ecr', 'describe-repositories', '--registry-id', REGISTRY.account, '--repository-names', REGISTRY.repository]))); assert.ok(repository.repositories?.length === 1, 'REPOSITORY_UNAVAILABLE'); validatePublicationRepository(repository.repositories[0]); equal(repository, pinned(plan.input.repository), 'REPOSITORY_POLICY_CHANGED');
    receipt.value.repositoryPolicySha256 = hash(repository); receipt.value.exclusivePublisherRequired = true; receipt.value.atomicTagExclusionGuaranteed = false; receipt.save();
    inspectImage(JSON.parse(await call('docker', ['--host', scan.dockerHost, 'image', 'inspect', scan.imageId])), scan.imageId, boundArtifactSource(plan.releaseBinding) ?? plan.input.source);
    const before = await Promise.all(plan.tags.map(tag => remoteTag(tag, call))); let publishedDigest;
    for (const image of before.filter(Boolean)) {
      const proof = await validateRegistryManifest(async imageDigest => { const response = JSON.parse(await call('aws', aws(['ecr', 'batch-get-image', '--registry-id', REGISTRY.account, '--repository-name', REGISTRY.repository, '--image-ids', `imageDigest=${imageDigest}`]))); assert.ok(response.images?.length === 1 && (response.failures ?? []).length === 0, 'REGISTRY_IMAGE_UNAVAILABLE'); return response.images[0]; }, image.imageId.imageDigest, scan.configDigest);
      validatePublicationPlatform(plan.input.kind, proof, scan.configDigest, plan.releaseBinding);
      if (publishedDigest) equal(proof.digest, publishedDigest, 'SOURCE_TAG_CONFLICT'); publishedDigest = proof.digest;
    }
    if (!publishedDigest) {
      const password = await call('aws', ['ecr', 'get-login-password', '--region', REGISTRY.region]); window.inWindow(); await login(scan.dockerHost, password, Math.min(60_000, window.remaining()));
      const tag = plan.tags[0], imageRef = `${uri}:${tag}`;
      // MUTABLE production relies on the explicitly authorized single publisher.
      // The immediate check detects observed conflicts; it is not an atomic lock.
      await assertTagsBeforeMutation(plan.tags, undefined, call); await call('docker', ['--host', scan.dockerHost, 'tag', scan.imageId, imageRef]);
      receipt.value.publicationOutcomeUncertain = true; receipt.value.lastAttemptedTag = tag; receipt.save();
      if (plan.releaseBinding) { await finalSource(plan, run); await currentMain(plan.input, call); }
      await assertTagsBeforeMutation(plan.tags, undefined, call);
      await call('docker', ['--host', scan.dockerHost, 'push', imageRef], { timeout: 600_000 });
      const image = await remoteTag(tag, call); assert.ok(image, 'PUBLISHED_TAG_UNAVAILABLE'); publishedDigest = image.imageId.imageDigest;
      receipt.value.publishedTags.push({ tag, digest: publishedDigest }); receipt.value.publicationOutcomeUncertain = false; receipt.save();
    }
    for (const tag of plan.tags) {
      const existing = await remoteTag(tag, call);
      if (existing) equal(existing.imageId.imageDigest, publishedDigest, 'SOURCE_TAG_CONFLICT');
      else {
        const original = await remoteTag(plan.tags.find(value => receipt.value.publishedTags.some(item => item.tag === value)) ?? plan.tags[before.findIndex(Boolean)], call); assert.ok(original?.imageManifest, 'ALIAS_MANIFEST_UNAVAILABLE');
        const manifestPath = path.join(plan.input.outputDirectory, `${tag}.manifest.private.json`); writeFileSync(manifestPath, original.imageManifest, { flag: 'wx', mode: 0o600 });
        receipt.value.publicationOutcomeUncertain = true; receipt.value.lastAttemptedTag = tag; receipt.save();
        if (plan.releaseBinding) { await finalSource(plan, run); await currentMain(plan.input, call); }
        await assertTagsBeforeMutation(plan.tags, publishedDigest, call); assert.ok(!await remoteTag(tag, call), 'SOURCE_TAG_APPEARED');
        const rawResponse = await call('aws', aws(['ecr', 'put-image', '--registry-id', REGISTRY.account, '--repository-name', REGISTRY.repository, '--image-tag', tag, '--image-digest', publishedDigest, '--image-manifest', `file://${manifestPath.replaceAll('\\', '/')}`]));
        writeFileSync(path.join(plan.input.outputDirectory, `${tag}.put-response.private.json`), rawResponse, { flag: 'wx', mode: 0o600 });
        const response = JSON.parse(rawResponse); receipt.value.lastMutationResponse = { tag, digest: response.image?.imageId?.imageDigest ?? null }; receipt.save();
        equal([response.image?.registryId, response.image?.repositoryName, response.image?.imageId?.imageDigest, response.image?.imageId?.imageTag], [REGISTRY.account, REGISTRY.repository, publishedDigest, tag], 'ALIAS_DIGEST_CHANGED');
        receipt.value.publishedTags.push({ tag, digest: publishedDigest }); receipt.value.publicationOutcomeUncertain = false; receipt.save();
      }
    }
    window.inWindow(); const proof = await verifyPublished({ receiptPath: plan.input.scan.path, receiptSha256: plan.input.scan.sha256, sourceSha: boundArtifactSource(plan.releaseBinding) ?? plan.input.source, repository: REGISTRY.repository, digest: publishedDigest, region: REGISTRY.region }, { run: (exe, args, options) => call(exe, args, options).then(stdout => ({ code: 0, stdout })) });
    receipt.value.registryDigest = proof.digest; receipt.value.registryProof = record(path.join(path.dirname(plan.input.scan.path), 'registry-proof.json'));
    receipt.save(); validatePublicationPlatform(plan.input.kind, proof, scan.configDigest, plan.releaseBinding);
    for (const tag of plan.tags) { const image = await remoteTag(tag, call); equal(image?.imageId.imageDigest, proof.digest, 'FINAL_TAG_CHANGED'); }
    equal(JSON.parse(await call('aws', aws(['ecr', 'describe-repositories', '--registry-id', REGISTRY.account, '--repository-names', REGISTRY.repository]))), repository, 'REPOSITORY_POLICY_CHANGED');
    await finalSource(plan, run); window.inWindow(); receipt.value.status = 'published'; receipt.save(); return record(receipt.filename);
  } catch { receipt.value.status = 'failed_publication_retained'; receipt.value.errorCode = 'ARTIFACT_PUBLICATION_FAILED'; receipt.save(); throw new Error('ARTIFACT_PUBLICATION_FAILED'); }
}
export async function registerUnused121(planRecord, authorizationRecord, { run = runCommand, now = Date.now, verifyRegistry = validateRegistryManifest, verifyScan = validateLocalScan } = {}) {
  const { plan, window } = await replayPlan(planRecord, 'RegisterUnused121', authorizationRecord, { run, now });
  const receipt = receiptWriter(plan.input.outputDirectory, 'registration.private.json', { schemaVersion: plan.schemaVersion, ...(plan.releaseBinding ? { releaseBinding: plan.releaseBinding, artifactSource: boundArtifactSource(plan.releaseBinding), ...(isSuccessorSchema(plan.schemaVersion) ? { artifactRole: plan.releaseBinding.artifactRole } : {}) } : {}), operation: plan.operation, plan: planRecord, authorization: authorizationRecord, planSha256: planRecord.sha256, source: plan.input.source, status: 'started', registered: [], registrationOutcomeUncertain: false, servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0 });
  const call = async (exe, args) => { window.inWindow(); return checked(run, exe, args, { timeout: Math.min(120_000, window.remaining()) }); };
  const serviceArgs = aws(['ecs', 'describe-services', '--cluster', 'schoolpilot-production-cluster', '--services', 'schoolpilot-production-api', 'schoolpilot-production-scheduler-worker']);
  try {
    await identity(run, call); await currentMain(plan.input, call); await verifyScan(plan.input, plan.releaseBinding);
    const proof = pinned(plan.registryProof), publication = pinned(plan.input.publication); equal([publication.status, publication.registryDigest, publication.registryProof], ['published', plan.registryDigest, plan.registryProof], 'PUBLICATION_CHANGED');
    const remote = await verifyRegistry(async imageDigest => { const response = JSON.parse(await call('aws', aws(['ecr', 'batch-get-image', '--registry-id', REGISTRY.account, '--repository-name', REGISTRY.repository, '--image-ids', `imageDigest=${imageDigest}`]))); assert.ok(response.images?.length === 1 && (response.failures ?? []).length === 0, 'REGISTRY_IMAGE_UNAVAILABLE'); return response.images[0]; }, plan.registryDigest, proof.configDigest); equal(remote, { digest: proof.digest, platformDigest: proof.platformDigest, configDigest: proof.configDigest }, 'REGISTRY_CHANGED');
    for (const tag of [plan.input.source, plan.input.source.slice(0, 12)]) equal((await remoteTag(tag, call))?.imageId.imageDigest, plan.registryDigest, 'SOURCE_TAG_CONFLICT');
    const before = JSON.parse(await call('aws', serviceArgs)); equal(hash(before.services), plan.liveServicesSha256, 'LIVE_SERVICES_DRIFT');
    const sources = {};
    for (const role of roles) { const generated = plan.generated[role]; sources[role] = JSON.parse(await call('aws', aws(['ecs', 'describe-task-definition', '--task-definition', generated.sourceArn, '--include', 'TAGS']))); equal(registrationEnvironmentProjection(sources[role].taskDefinition), registrationEnvironmentProjection(pinned(generated.source).taskDefinition), 'SOURCE_DEFINITION_DRIFT'); equal(ecsRequestTags(sources[role].tags), ecsRequestTags(pinned(generated.source).tags), 'SOURCE_TAGS_DRIFT'); }
    const requests = renderUnused121Pair(sources, before, plan.input.source, plan.registryDigest);
    for (const role of roles) {
      const generated = plan.generated[role]; equal(hash(readFileSync(ordinaryFile(generated.path))), generated.sha256, 'GENERATED_REQUEST_CHANGED'); equal(pinned(generated), requests[role], 'GENERATED_REQUEST_DRIFT'); equal(generated.request, requests[role], 'PLANNED_REQUEST_DRIFT');
      if (plan.releaseBinding) { await finalSource(plan, run); await currentMain(plan.input, call); }
      window.inWindow(); receipt.value.lastAttemptedRole = role; receipt.value.registrationOutcomeUncertain = true; receipt.save();
      const rawResponse = await call('aws', aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${generated.path.replaceAll('\\', '/')}`]));
      writeFileSync(path.join(plan.input.outputDirectory, `${role}.register-response.private.json`), rawResponse, { flag: 'wx', mode: 0o600 });
      const response = JSON.parse(rawResponse);
      const arn = isSuccessorSchema(plan.schemaVersion) ? retainSuccessorRegistration(receipt.value, role, response, generated.sha256, requests[role].family) : response.taskDefinition?.taskDefinitionArn;
      // Retain the returned ARN before any semantic assertion or further command.
      if (!isSuccessorSchema(plan.schemaVersion)) { receipt.value.registered.push({ role, arn: typeof arn === 'string' ? arn : null, requestSha256: generated.sha256 }); receipt.value.registrationOutcomeUncertain = typeof arn !== 'string'; } receipt.save();
      assert.match(arn ?? '', new RegExp(`^arn:aws:ecs:${REGISTRY.region}:${REGISTRY.account}:task-definition/${requests[role].family}:[1-9][0-9]*$`), 'REGISTERED_ARN_INVALID'); assert.ok(arn !== generated.sourceArn, 'NEW_REVISION_REQUIRED'); window.inWindow();
      const actual = JSON.parse(await call('aws', aws(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS'])));
      validateSourceResponse(actual, role, plan.input.source, plan.registryDigest, anchor128Stages()[0]); equal(registrationEnvironmentProjection(projection(actual)), registrationEnvironmentProjection(requests[role]), 'REGISTERED_DEFINITION_DRIFT');
    }
    const after = JSON.parse(await call('aws', serviceArgs)); equal(after.services, before.services, 'SERVICES_CHANGED');
    for (const tag of [plan.input.source, plan.input.source.slice(0, 12)]) equal((await remoteTag(tag, call))?.imageId.imageDigest, plan.registryDigest, 'FINAL_TAG_CHANGED');
    for (const service of after.services) for (const arn of [service.taskDefinition, ...(service.deployments ?? []).map(value => value.taskDefinition), ...(service.taskSets ?? []).map(value => value.taskDefinition)]) assert.ok(!receipt.value.registered.some(value => value.arn === arn), 'REGISTERED_ANCHOR_IS_SERVING');
    await finalSource(plan, run); window.inWindow(); receipt.value.status = 'registered_unused121'; receipt.value.servicesUnchanged = true; receipt.save(); return record(receipt.filename);
  } catch { receipt.value.status = 'failed_registration_retained'; receipt.value.errorCode = 'UNUSED121_REGISTRATION_FAILED'; receipt.save(); throw new Error('UNUSED121_REGISTRATION_FAILED'); }
}
async function main(args) {
  const [operation, inputPath, inputHash, authorizationPath, authorizationHash] = args;
  const input = { path: inputPath, sha256: inputHash }, authorization = { path: authorizationPath, sha256: authorizationHash };
  let result;
  if (operation === 'ValidateSuccessorPreparation' && args.length === 3) result = await validateSuccessorPreparation(pinned(input), { root, run: runCommand, fallback: FALLBACK, sourceDirectory: pinned(input).sourceDirectory, source: pinned(input).source });
  else if (operation === 'PlanPublication' && args.length === 3) result = await planPublication(pinned(input));
  else if (operation === 'PlanUnused121' && args.length === 3) result = await planUnused121(pinned(input));
  else if (operation === 'PublishImage' && args.length === 5) result = await publishImage(input, authorization);
  else if (operation === 'RegisterUnused121' && args.length === 5) result = await registerUnused121(input, authorization);
  else throw new Error('EXPECTED_ARTIFACT_PREPARATION_OPERATION');
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => { console.error('ARTIFACT_PREPARATION_FAILED'); process.exitCode = 1; });
