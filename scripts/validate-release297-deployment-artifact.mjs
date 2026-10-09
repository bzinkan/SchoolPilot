#!/usr/bin/env node
// Read-only replay of the reviewed publication contract. Never builds, publishes,
// registers a task, launches a task, or changes a service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_SECURITY_BINDING_ID, BUILD_SECURITY_OPERATION_DEPENDENCIES, bindingSchema,
  resolveReleaseBinding, assertBindingReplay, assertBoundPublication, assertBoundScan,
  boundArtifactSource, verifyCurrentReleaseMain, bindingForRole } from './release-source-binding.mjs';
import { FALLBACK, inventoryFor, validateSourceResponse, registrationEnvironmentProjection,
  assertOnlyImageIdentityChanged } from './register-compatible-fallback-inactive.mjs';
import { REGISTRY, validateLocalScan, validatePublicationPlatform } from './prepare-release-artifacts.mjs';
import { runCommand, validateRegistryManifest } from './verify-legacy-deploy-image.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const helperFiles = ['scripts/release-source-binding.mjs', 'scripts/verify-legacy-deploy-image.mjs',
  'scripts/register-compatible-fallback-inactive.mjs', 'scripts/deploy-classpilot-runtime-config.ps1',
  'src/config/rlsRegistry.json', ...BUILD_SECURITY_OPERATION_DEPENDENCIES];
function ordinary(filename) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename), 'PRIVATE_ABSOLUTE_PATH_REQUIRED');
  for (let current = path.resolve(filename);;) {
    if (existsSync(current)) assert.ok(!lstatSync(current).isSymbolicLink(), 'REPARSE_PATH_REJECTED');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  assert.ok(lstatSync(filename).isFile() && realpathSync(filename) === path.resolve(filename), 'ORDINARY_FILE_REQUIRED');
  return filename;
}
async function checked(run, executable, args) {
  const result = await run(executable, args); assert.equal(result.code, 0, 'DEPLOYMENT_ARTIFACT_COMMAND_FAILED'); return result.stdout;
}
async function privateFile(filename, root, run) {
  ordinary(filename);
  const relative = path.relative(root, filename);
  assert.ok(relative.startsWith('..') && !path.isAbsolute(relative), 'PRIVATE_PATH_OUTSIDE_REPOSITORY_REQUIRED');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `$ErrorActionPreference='Stop'; . ${literal(path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1'))}; [void](Assert-PrivateInputPath -Path ${literal(filename)} -RepositoryRoot ${literal(root)})`;
  await checked(run, 'pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
}
async function pinned(record, root, run) {
  assert.match(record?.sha256 ?? '', HASH, 'INPUT_HASH_REQUIRED');
  await privateFile(record.path, root, run);
  const bytes = readFileSync(record.path); assert.equal(hash(bytes), record.sha256, 'INPUT_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}
export function validatePublicationScope(receipt, plan) {
  assert.deepEqual([receipt?.schemaVersion, receipt?.operation, receipt?.status, receipt?.signed,
    receipt?.publicationOutcomeUncertain, receipt?.servicesUpdated, receipt?.tasksLaunched, receipt?.productionDatabaseOperations],
  [5, 'PublishImage', 'published', false, false, 0, 0, 0], 'REVIEWED_UNSIGNED_PUBLICATION_REQUIRED');
  assert.equal(bindingSchema(plan?.input), 5, 'V5_DEPLOYMENT_BINDING_REQUIRED');
  assert.deepEqual([plan.schemaVersion, plan.kind, plan.operation, plan.input.kind, plan.input.releaseBindingId,
    plan.cloudMutationsDuringPlan, plan.servicesMayChange, plan.tasksMayLaunch, plan.productionDatabaseOperations, plan.signed],
  [5, 'release-artifact-preparation', 'PublishImage', 'serving-anchor', BUILD_SECURITY_BINDING_ID, 0, false, false, 0, false], 'SERVING_ANCHOR_PUBLICATION_REQUIRED');
  assert.equal(receipt.artifactRole, 'serving-anchor', 'SERVING_ANCHOR_PUBLICATION_REQUIRED');
  assert.equal(receipt.planSha256, receipt.plan.sha256, 'PUBLICATION_PLAN_CHANGED');
  assert.deepEqual(plan.tags, [plan.input.source, plan.input.source.slice(0, 12)], 'PUBLICATION_TAGS_CHANGED');
}

export function validateFallbackScope(receipt, plan, binding) {
  assert.deepEqual([receipt.schemaVersion, receipt.kind, receipt.operation, receipt.status,
    receipt.artifactRole, receipt.source, receipt.artifactSource, receipt.registrationOutcomeUncertain,
    receipt.servicesUnchanged, receipt.servicesUpdated, receipt.tasksLaunched, receipt.productionDatabaseOperations],
  [5, 'compatible_fallback_inactive', 'RegisterInactive', 'registered_inactive', 'fallback',
    binding.fallback.source, binding.fallback.source, false, true, 0, 0, 0], 'COMPLETED_FALLBACK_REGISTRATION_REQUIRED');
  assert.deepEqual([plan.schemaVersion, plan.kind, plan.artifactRole, plan.artifactSource, plan.input.admissionCount,
    plan.input.anchorSource, plan.input.releaseBindingId, plan.cloudMutationsDuringPlan, plan.servicesMayChange],
  [5, 'compatible_fallback_inactive', 'fallback', binding.fallback.source, 129,
    binding.servingSource, BUILD_SECURITY_BINDING_ID, 0, false], 'EXACT_CURRENT129_FALLBACK_PLAN_REQUIRED');
  assert.equal(receipt.planSha256, receipt.plan.sha256, 'FALLBACK_PLAN_CHANGED');
  assertBindingReplay(plan.input, plan.releaseBinding, binding);
  assert.deepEqual(receipt.releaseBinding, bindingForRole(binding, 'fallback'), 'FALLBACK_BINDING_CHANGED');
  assert.deepEqual(plan.identities, { ...FALLBACK, ...binding.fallback, tag: binding.fallback.source.slice(0, 12) }, 'FALLBACK_IDENTITIES_CHANGED');
  assert.equal(receipt.registered?.length, 2, 'EXACT_FALLBACK_PAIR_REQUIRED');
  assert.deepEqual(receipt.registered.map(row => row.role).sort(), ['api', 'scheduler-worker'], 'EXACT_FALLBACK_PAIR_REQUIRED');
  for (const row of receipt.registered) {
    const request = plan.generated[row.role]?.request;
    assert.ok(request, 'FALLBACK_REQUEST_REQUIRED');
    assert.match(row.arn ?? '', new RegExp(`^arn:aws:ecs:${REGISTRY.region}:${REGISTRY.account}:task-definition/${request.family}:[1-9][0-9]*$`), 'FALLBACK_ARN_INVALID');
    assert.equal(row.requestSha256, plan.generated[row.role].sha256, 'FALLBACK_REQUEST_CHANGED');
  }
}

async function prepareFallback(record, binding, expectedMain, root, run, resolve, verifyScan, now) {
  const receipt = await pinned(record, root, run), plan = await pinned(receipt.plan, root, run);
  validateFallbackScope(receipt, plan, binding);
  assert.equal(plan.toolSource, expectedMain, 'FALLBACK_TOOL_SOURCE_CHANGED');
  assert.equal(plan.toolSha256, hash(readFileSync(path.join(root, 'scripts/register-compatible-fallback-inactive.mjs'))), 'FALLBACK_TOOL_CHANGED');
  assert.equal(plan.bindingHelperSha256, hash(readFileSync(path.join(root, 'scripts/release-source-binding.mjs'))), 'FALLBACK_VALIDATOR_CHANGED');
  assert.equal(plan.identityHelperSha256, hash(readFileSync(path.join(root, 'scripts/stamp-release-runtime-identity.mjs'))), 'FALLBACK_IDENTITY_TOOL_CHANGED');
  assert.equal(plan.permissionHelperSha256, hash(readFileSync(path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1'))), 'FALLBACK_PERMISSION_TOOL_CHANGED');
  for (const value of Object.values(plan.input)) if (value?.path && value?.sha256) await pinned(value, root, run);
  const authorization = await pinned(receipt.authorization, root, run);
  assert.deepEqual([authorization.schemaVersion, authorization.authorized, authorization.operation, authorization.planSha256],
    [1, true, 'RegisterInactive', receipt.plan.sha256], 'FALLBACK_AUTHORIZATION_CHANGED');
  const start = Date.parse(authorization.startsAtUtc), end = Date.parse(authorization.expiresAtUtc);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 3_600_000, 'FALLBACK_WINDOW_INVALID');
  const current = await resolve(plan.input, { root, run, fallback: FALLBACK, sourceDirectory: root, source: expectedMain, now });
  assertBindingReplay(plan.input, plan.releaseBinding, current);
  const publication = await pinned(plan.input.fallbackPublication, root, run), publicationPlan = await pinned(publication.plan, root, run);
  assert.deepEqual([publication.schemaVersion, publication.operation, publication.status, publication.artifactRole,
    publication.publicationOutcomeUncertain, publication.servicesUpdated, publication.tasksLaunched, publication.productionDatabaseOperations],
    [5, 'PublishImage', 'published', 'fallback', false, 0, 0, 0], 'FALLBACK_PUBLICATION_REQUIRED');
  assert.equal(publication.planSha256, publication.plan.sha256, 'FALLBACK_PUBLICATION_PLAN_CHANGED');
  assert.deepEqual([publicationPlan.schemaVersion, publicationPlan.kind, publicationPlan.operation, publicationPlan.input.kind,
    publicationPlan.input.source, publicationPlan.input.releaseBindingId, publicationPlan.toolSource],
    [5, 'release-artifact-preparation', 'PublishImage', 'fallback', binding.fallback.source, BUILD_SECURITY_BINDING_ID, expectedMain], 'FALLBACK_PUBLICATION_PLAN_CHANGED');
  assert.equal(publicationPlan.toolSha256, hash(readFileSync(path.join(root, 'scripts/prepare-release-artifacts.mjs'))), 'FALLBACK_PUBLICATION_TOOL_CHANGED');
  assert.deepEqual(publicationPlan.helperHashes, Object.fromEntries(helperFiles.map(file => [file, hash(readFileSync(path.join(root, file)))])), 'FALLBACK_PUBLICATION_HELPERS_CHANGED');
  const fallbackBinding = bindingForRole(binding, 'fallback');
  assertBindingReplay(publicationPlan.input, publicationPlan.releaseBinding, fallbackBinding);
  assertBoundPublication(publication, fallbackBinding, binding.fallback.source, plan.registryDigest);
  const scan = await verifyScan(publicationPlan.input, fallbackBinding); assertBoundScan(scan, fallbackBinding);
  const proof = await pinned(plan.input.registryProof, root, run);
  assert.deepEqual(proof, await pinned(publication.registryProof, root, run), 'FALLBACK_REGISTRY_PROOF_CHANGED');
  assert.equal(proof.receiptSha256, publicationPlan.input.scan.sha256, 'FALLBACK_SCAN_PROOF_CHANGED');
  const publicationAuthorization = await pinned(publication.authorization, root, run);
  assert.deepEqual([publicationAuthorization.schemaVersion, publicationAuthorization.authorized, publicationAuthorization.operation,
    publicationAuthorization.planSha256, publicationAuthorization.singlePublisher], [1, true, 'PublishImage', publication.plan.sha256, true], 'FALLBACK_PUBLICATION_AUTHORIZATION_CHANGED');
  const publicationWindow = await pinned(publicationAuthorization.window, root, run);
  assert.deepEqual([publicationWindow.owner, publicationWindow.operation, publicationWindow.source, publicationWindow.planSha256,
    publicationWindow.singlePublisher, publicationWindow.servicesMayChange, publicationWindow.tasksMayLaunch, publicationWindow.productionDatabaseOperations],
    ['release-artifact-preparation', 'PublishImage', binding.fallback.source, publication.plan.sha256, true, false, false, 0], 'FALLBACK_PUBLICATION_WINDOW_CHANGED');
  const publicationStart = Date.parse(publicationWindow.startsAtUtc), publicationEnd = Date.parse(publicationWindow.expiresAtUtc);
  assert.ok(Number.isFinite(publicationStart) && Number.isFinite(publicationEnd) && publicationEnd > publicationStart && publicationEnd - publicationStart <= 1_200_000, 'FALLBACK_PUBLICATION_WINDOW_INVALID');
  validatePublicationPlatform('fallback', proof, binding.fallback.config, fallbackBinding);
  const runtimeReview = await pinned({ path: path.join(plan.input.retainedEvidenceDirectory, binding.currentRuntime.review.path), sha256: binding.currentRuntime.review.sha256 }, root, run);
  const pair = {};
  for (const row of receipt.registered) {
    const generated = plan.generated[row.role], request = await pinned(generated, root, run);
    assert.deepEqual(request, generated.request, 'FALLBACK_REQUEST_CHANGED');
    const original = await pinned({ path: path.join(plan.input.retainedEvidenceDirectory, runtimeReview.definitions[row.role].path), sha256: runtimeReview.definitions[row.role].sha256 }, root, run);
    assertOnlyImageIdentityChanged(original, request, row.role, plan.registryDigest, binding.fallback);
    pair[row.role] = row.arn;
  }
  return { plan, receipt, proof, pair };
}

export async function validateDeploymentArtifact(record, expectedMain, {
  root = repositoryRoot, run = runCommand, now = Date.now,
  resolve = resolveReleaseBinding, verifyScan = validateLocalScan, fallbackRegistration,
} = {}) {
  assert.match(expectedMain ?? '', SHA, 'EXACT_MAIN_REQUIRED');
  const receipt = await pinned(record, root, run), plan = await pinned(receipt.plan, root, run);
  validatePublicationScope(receipt, plan);
  assert.deepEqual([receipt.source, plan.input.source, plan.toolSource], [expectedMain, expectedMain, expectedMain], 'PUBLICATION_MAIN_CHANGED');
  assert.equal(path.resolve(plan.input.sourceDirectory), path.resolve(root), 'DEPLOYMENT_SOURCE_DIRECTORY_CHANGED');
  assert.equal(plan.toolSha256, hash(readFileSync(path.join(root, 'scripts/prepare-release-artifacts.mjs'))), 'PUBLICATION_TOOL_CHANGED');
  assert.deepEqual(plan.helperHashes, Object.fromEntries(helperFiles.map(file => [file, hash(readFileSync(path.join(root, file)))])), 'PUBLICATION_HELPERS_CHANGED');
  for (const value of Object.values(plan.input)) if (value?.path && value?.sha256) await pinned(value, root, run);
  await pinned(plan.scanCleanupFile, root, run);
  const authorization = await pinned(receipt.authorization, root, run);
  assert.deepEqual([authorization.schemaVersion, authorization.authorized, authorization.operation,
    authorization.planSha256, authorization.singlePublisher], [1, true, 'PublishImage', receipt.plan.sha256, true], 'PUBLICATION_AUTHORIZATION_CHANGED');
  const window = await pinned(authorization.window, root, run);
  assert.deepEqual([window.owner, window.operation, window.source, window.planSha256, window.singlePublisher,
    window.servicesMayChange, window.tasksMayLaunch, window.productionDatabaseOperations],
  ['release-artifact-preparation', 'PublishImage', expectedMain, receipt.plan.sha256, true, false, false, 0], 'PUBLICATION_WINDOW_CHANGED');
  const start = Date.parse(window.startsAtUtc), end = Date.parse(window.expiresAtUtc);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 1_200_000, 'PUBLICATION_WINDOW_INVALID');
  // Publication authorization is historical; resolve rechecks present readiness,
  // source equality, private evidence, scan freshness and applicable acceptance.
  const binding = await resolve(plan.input, { root, run, fallback: FALLBACK, sourceDirectory: root, source: expectedMain, now });
  assertBindingReplay(plan.input, plan.releaseBinding, binding);
  assertBoundPublication(receipt, binding, expectedMain, receipt.registryDigest);
  const scan = await verifyScan(plan.input, binding); assertBoundScan(scan, binding);
  assert.deepEqual(plan.scanIdentity, { imageId: scan.imageId, configDigest: scan.configDigest, dockerHost: scan.dockerHost }, 'PUBLICATION_SCAN_CHANGED');
  const proof = await pinned(receipt.registryProof, root, run);
  assert.deepEqual([proof.schemaVersion, proof.passed, proof.sourceSha, proof.receiptSha256, proof.repository, proof.region],
    [1, true, boundArtifactSource(binding), plan.input.scan.sha256, REGISTRY.repository, REGISTRY.region], 'REGISTRY_PROOF_CHANGED');
  assert.equal(proof.digest, receipt.registryDigest, 'REGISTRY_DIGEST_CHANGED');
  validatePublicationPlatform('serving-anchor', proof, scan.configDigest, binding);
  assert.ok(fallbackRegistration, 'REVIEWED_FALLBACK_REGISTRATION_REQUIRED');
  const fallback = await prepareFallback(fallbackRegistration, binding, expectedMain, root, run, resolve, verifyScan, now);
  // No AWS call occurs until all local evidence and the accepted binding pass.
  await verifyCurrentReleaseMain(expectedMain, run);
  const aws = args => [...args, '--region', REGISTRY.region, '--output', 'json', '--no-cli-pager'];
  const account = JSON.parse(await checked(run, 'aws', aws(['sts', 'get-caller-identity'])));
  assert.equal(account.Account, REGISTRY.account, 'AWS_ACCOUNT_CHANGED');
  const tags = JSON.parse(await checked(run, 'aws', aws(['ecr', 'describe-images', '--repository-name', REGISTRY.repository, '--image-ids', `imageTag=${expectedMain}`])));
  assert.equal(tags.imageDetails?.length, 1, 'EXACT_MAIN_TAG_REQUIRED');
  assert.equal(tags.imageDetails[0].imageDigest, receipt.registryDigest, 'PUBLICATION_TAG_MOVED');
  const liveProof = await validateRegistryManifest(async digest => {
    const response = JSON.parse(await checked(run, 'aws', aws(['ecr', 'batch-get-image', '--repository-name', REGISTRY.repository, '--image-ids', `imageDigest=${digest}`])));
    assert.ok(response.images?.length > 0 && !(response.failures?.length), 'REGISTRY_IMAGE_UNAVAILABLE');
    const first = response.images[0];
    for (const image of response.images) assert.deepEqual([image.repositoryName, image.imageId?.imageDigest, image.imageManifest, image.imageManifestMediaType],
      [REGISTRY.repository, digest, first.imageManifest, first.imageManifestMediaType], 'REGISTRY_ALIAS_CHANGED');
    return first;
  }, receipt.registryDigest, scan.configDigest);
  validatePublicationPlatform('serving-anchor', liveProof, scan.configDigest, binding);
  assert.deepEqual(liveProof, { digest: proof.digest, platformDigest: proof.platformDigest, configDigest: proof.configDigest }, 'REGISTRY_PROOF_MOVED');
  const fallbackTag = JSON.parse(await checked(run, 'aws', aws(['ecr', 'describe-images', '--repository-name', REGISTRY.repository, '--image-ids', `imageTag=${binding.fallback.source.slice(0, 12)}`])));
  assert.equal(fallbackTag.imageDetails?.length, 1, 'EXACT_FALLBACK_TAG_REQUIRED');
  assert.equal(fallbackTag.imageDetails[0].imageDigest, fallback.plan.registryDigest, 'FALLBACK_TAG_MOVED');
  const fallbackProof = await validateRegistryManifest(async digest => {
    const response = JSON.parse(await checked(run, 'aws', aws(['ecr', 'batch-get-image', '--repository-name', REGISTRY.repository, '--image-ids', `imageDigest=${digest}`])));
    assert.equal(response.images?.length, 1, 'FALLBACK_REGISTRY_IMAGE_UNAVAILABLE');
    assert.equal(response.failures?.length ?? 0, 0, 'FALLBACK_REGISTRY_IMAGE_UNAVAILABLE');
    assert.equal(response.images[0].repositoryName, REGISTRY.repository, 'FALLBACK_REGISTRY_CHANGED');
    assert.equal(response.images[0].imageId?.imageDigest, digest, 'FALLBACK_REGISTRY_CHANGED');
    return response.images[0];
  }, fallback.plan.registryDigest, binding.fallback.config);
  validatePublicationPlatform('fallback', fallbackProof, binding.fallback.config, bindingForRole(binding, 'fallback'));
  for (const row of fallback.receipt.registered) {
    const response = JSON.parse(await checked(run, 'aws', aws(['ecs', 'describe-task-definition', '--task-definition', row.arn, '--include', 'TAGS'])));
    validateSourceResponse(response, row.role, binding.fallback.source, fallback.plan.registryDigest, inventoryFor(129), binding);
    const request = fallback.plan.generated[row.role].request;
    const providerFields = new Set(['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']);
    const projection = Object.fromEntries(Object.entries(response.taskDefinition).filter(([key]) => !providerFields.has(key)));
    if (response.tags?.length) projection.tags = response.tags;
    assert.deepEqual(registrationEnvironmentProjection(projection), registrationEnvironmentProjection(request), 'REGISTERED_FALLBACK_MOVED');
  }
  return { schemaVersion: 1, passed: true, mainSource: expectedMain, applicationSource: boundArtifactSource(binding),
    registryDigest: receipt.registryDigest, releaseBindingId: binding.id, releaseBindingSha256: binding.sha256,
    fallbackApiTaskDefinition: fallback.pair.api, fallbackWorkerTaskDefinition: fallback.pair['scheduler-worker'],
    fallbackSource: binding.fallback.source, fallbackRegistryDigest: fallback.plan.registryDigest,
    signed: false, cloudMutations: 0 };
}
async function main(args) {
  assert.equal(args.length, 5, 'EXPECTED_PUBLICATION_MAIN_AND_FALLBACK_RECEIPT');
  console.log(JSON.stringify(await validateDeploymentArtifact({ path: args[0], sha256: args[1] }, args[2],
    { fallbackRegistration: { path: args[3], sha256: args[4] } })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  // Private inputs and exception contents never enter deploy diagnostics.
  console.error('REVIEWED_DEPLOYMENT_ARTIFACT_REJECTED'); process.exitCode = 1;
});
