#!/usr/bin/env node
// Preparation-only controller: rendering is offline; registration never launches
// a task, updates a service, changes admission, or publishes an image.
import assert from 'node:assert/strict';
import { bindingSchema, isSuccessorSchema, resolveReleaseBinding, assertBindingReplay, assertBoundPublication, verifyCurrentReleaseMain, publicReceiptHash, assertBoundScan, assertBoundFallbackScan, bindingForRole, validateSuccessorPreparation, BUILD_SECURITY_OPERATION_DEPENDENCIES, BUILD_SECURITY_BINDING_ID } from './release-source-binding.mjs';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveConfigDigest, scanCounts, SCANNER, runCommand, selectRegistryDigestImage, validateRegistryManifest } from './verify-legacy-deploy-image.mjs';
import { addReviewedRlsTable, verifyLiveRlsEnablementSources, verifyEnabledRlsCandidates } from './enforce-deploy-rls-allowlist.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(path.join(repositoryRoot, 'src/config/rlsRegistry.json'), 'utf8'));
export const FALLBACK = Object.freeze({
  source: 'c578120d980d4c2405a72f4f40b2d3c29a07e20b', tag: 'c578120d980d',
  localIndex: 'sha256:2fd61fdbda527a0f72cdd947db719531b92e0e5b14cebe5bff2cbd8c62abfd08',
  platform: 'sha256:405f738bc0da4baa99b6e892dd827459cf98c216dbc09232bd3c29d5fcac33a1',
  config: 'sha256:d4f012de43822047ba9fc52277c90f0c18b944522c22a6988f165aa2ee06097b',
  application: 'ddc5996b3b8645859fa51a9613486db52c481b7f',
  region: 'us-east-1', account: '135775632425', repository: 'schoolpilot-production-api',
  stageSha256: 'cca18d0e2d122a2f21ffa6f66b7160636f0dfe6ebc1ffeb8c7f43c5ff5879c98',
  identityHelperSha256: '328701028f7c36554bfc4ff0d4ede28c57a0c63ec4ff9584faa0b54e07eb9a4b',
  identityHelperLfSha256: '75cf33ad0abc3e45217ff6c56802914d266db9daa6ea469296d77e7a96098c3f',
  permissionHelperSha256: 'bcfd3f3575974c23fa958eaad8c46045ff536523f732fdcfb6d082d34bd08049',
  permissionHelperLfSha256: '02552442f804a5b58777d844c7b0f0c3680c84e6b14cfe7a3410cb4426125b24',
});
const repoUri = `${FALLBACK.account}.dkr.ecr.${FALLBACK.region}.amazonaws.com/${FALLBACK.repository}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const identityNames = new Set(['GIT_SHA', 'SERVICE_NAME']);
const controls = Object.freeze({ preciseRestrictionResourcesV1: 'CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1', focusTabV1: 'CLASSPILOT_CAP_FOCUS_TAB_V1', privateChatLifecycleV1: 'CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1' });
const providerFields = new Set(['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']);
const requestFields = new Set(['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform', 'ephemeralStorage', 'proxyConfiguration', 'inferenceAccelerators', 'pidMode', 'ipcMode', 'enableFaultInjection']);
const canonical = value => JSON.stringify(sort(value));
function sort(value) { return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value; }
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
function equal(actual, expected, message) { assert.ok(canonical(actual) === canonical(expected), message); }
function checkString(value, pattern, message) { assert.ok(typeof value === 'string' && pattern.test(value), message); }
export function ecsRequestTags(tags) {
  if (tags === undefined) return undefined;
  assert.ok(Array.isArray(tags), 'TASK_TAGS_INVALID');
  const keys = new Set();
  for (const tag of tags) {
    assert.ok(tag && !Array.isArray(tag) && typeof tag === 'object'
      && Object.keys(tag).every(key => key === 'key' || key === 'value')
      && typeof tag.key === 'string' && tag.key.length > 0 && !keys.has(tag.key)
      && (!Object.hasOwn(tag, 'value') || typeof tag.value === 'string'), 'TASK_TAGS_INVALID');
    keys.add(tag.key);
  }
  // ECS rejects explicit tags:[]; preserve every nonempty tag in its raw order.
  return tags.length === 0 ? undefined : structuredClone(tags);
}
function responseTagProjection(response) {
  const value = structuredClone(response), tags = ecsRequestTags(value.tags);
  if (tags === undefined) delete value.tags; else value.tags = tags;
  return value;
}
export function registrationEnvironmentProjection(request) {
  const value = structuredClone(request);
  const tags = ecsRequestTags(value.tags);
  if (tags === undefined) delete value.tags; else value.tags = tags;
  assert.ok(Array.isArray(value?.containerDefinitions), 'REGISTERED_CONTAINERS_INVALID');
  for (const container of value.containerDefinitions) {
    if (!Object.hasOwn(container, 'environment')) continue;
    assert.ok(Array.isArray(container.environment), 'REGISTERED_ENVIRONMENT_INVALID');
    const names = new Set();
    for (const entry of container.environment) {
      assert.ok(entry && !Array.isArray(entry) && typeof entry === 'object' && Object.keys(entry).sort().join(',') === 'name,value' && typeof entry.name === 'string' && entry.name.length > 0 && typeof entry.value === 'string' && !names.has(entry.name), 'REGISTERED_ENVIRONMENT_INVALID');
      names.add(entry.name);
    }
    container.environment.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  return value;
}
function pinnedJson(record) {
  assert.ok(record && path.isAbsolute(record.path), 'INPUT_PATH_REQUIRED'); checkString(record.sha256, /^[a-f0-9]{64}$/, 'INPUT_HASH_REQUIRED');
  const bytes = readFileSync(record.path); assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'INPUT_SIZE_INVALID');
  equal(hash(bytes), record.sha256, 'INPUT_CHANGED'); return JSON.parse(bytes.toString('utf8'));
}
function env(container) {
  assert.ok(Array.isArray(container.environment) && Array.isArray(container.secrets ?? []), 'ENVIRONMENT_INVALID');
  const names = container.environment.map(item => item.name), secretNames = (container.secrets ?? []).map(item => item.name);
  assert.ok(new Set(names).size === names.length && new Set(secretNames).size === secretNames.length, 'DUPLICATE_RUNTIME_NAME');
  assert.ok(!names.some(name => secretNames.includes(name)), 'ENVIRONMENT_SECRET_COLLISION');
  assert.ok(!secretNames.some(name => identityNames.has(name) || name === 'RLS_ENABLED_TABLES' || name === 'RLS_GUC_ENABLED' || name.startsWith('CLASSPILOT_CAP_') || name === 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON' || name === 'CLASSPILOT_USAGE_ROLLUP_MODE' || name === 'CLASSPILOT_DIGITAL_USAGE_MODE'), 'CONTROL_SECRET_REJECTED');
  return Object.fromEntries(container.environment.map(item => { assert.ok(typeof item.name === 'string' && typeof item.value === 'string', 'ENVIRONMENT_INVALID'); return [item.name, item.value]; }));
}
function runtimeContainer(task, role) { const matches = task?.containerDefinitions?.filter(item => item.name === role); assert.ok(matches?.length === 1, 'SOURCE_CONTAINER_INVALID'); return matches[0]; }
export function capabilityEnvironment(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('CLASSPILOT_CAP_') || key === 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON' || key === 'CLASSPILOT_PROTOCOL_V3_ENABLED'));
}
export function validateSourceResponse(response, role, source, image, inventory, releaseBinding) {
  const task = response?.taskDefinition; assert.ok(task && task.status === 'ACTIVE', 'SOURCE_DEFINITION_INACTIVE');
  ecsRequestTags(response.tags);
  const family = role === 'api' ? '(?:schoolpilot-production-api|schoolpilot-production-api-emergency)' : 'schoolpilot-production-scheduler-worker';
  checkString(task.taskDefinitionArn, new RegExp(`^arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:[1-9][0-9]*$`), 'SOURCE_ARN_INVALID');
  equal(task.family, task.taskDefinitionArn.split('/')[1].split(':')[0], 'SOURCE_FAMILY_INVALID');
  equal([task.cpu, task.memory], role === 'api' ? ['1024', '2048'] : ['512', '1024'], 'SOURCE_RESOURCE_DRIFT');
  assert.ok(task.networkMode === 'awsvpc' && task.requiresCompatibilities?.includes('FARGATE'), 'SOURCE_NETWORK_DRIFT');
  const container = runtimeContainer(task, role); equal(container.image, `${repoUri}@${image}`, 'SOURCE_IMAGE_DRIFT');
  assert.ok(container.memory === undefined || Number(container.memory) >= Number(task.memory), 'SOURCE_HARD_MEMORY_DRIFT');
  const values = env(container); equal(values.GIT_SHA, source, 'SOURCE_IDENTITY_DRIFT'); equal(values.SERVICE_NAME, role, 'SOURCE_IDENTITY_DRIFT');
  equal(values.RLS_GUC_ENABLED, 'true', 'TENANT_GUC_REQUIRED');
  // Admission uses table membership. Preserve the captured CSV serialization;
  // ordered registry stages and reviewed bundle appends remain unchanged.
  const admitted = values.RLS_ENABLED_TABLES?.split(',');
  const tableName = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
  assert.ok(Array.isArray(inventory) && inventory.length > 0 && inventory.every(tableName)
    && new Set(inventory).size === inventory.length, 'ADMISSION_DRIFT');
  assert.ok(Array.isArray(admitted) && admitted.length === inventory.length && admitted.every(tableName)
    && new Set(admitted).size === admitted.length && inventory.every(table => admitted.includes(table)), 'ADMISSION_DRIFT');
  for (const name of ['CLASSPILOT_USAGE_ROLLUP_MODE', 'CLASSPILOT_DIGITAL_USAGE_MODE']) equal(values[name], 'off', 'USAGE_MUST_BE_EXPLICITLY_OFF');
  const rollouts = JSON.parse(values.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON ?? '{}');
  assert.ok(rollouts && !Array.isArray(rollouts) && typeof rollouts === 'object', 'ROLLOUTS_INVALID');
  if (releaseBinding?.schemaVersion === 5) {
    equal(releaseBinding.id, BUILD_SECURITY_BINDING_ID, 'CURRENT129_BINDING_NOT_ALLOWLISTED');
    equal(inventory, inventoryFor(129), 'CURRENT129_ADMISSION_REQUIRED');
    equal(values.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE, undefined, 'CURRENT129_DAILY_ROLLUP_DRIFT');
    equal(capabilityEnvironment(values), releaseBinding.currentRuntime?.capabilityEnvironment, 'CURRENT129_CAPABILITY_DRIFT');
  } else for (const [capability, name] of Object.entries(controls)) {
    assert.ok(values[name] === undefined || values[name] === 'false', 'NEW_ISSUANCE_MUST_BE_OFF');
    assert.ok(rollouts[capability] === undefined || rollouts[capability]?.mode === 'off', 'NEW_ROLLOUT_MUST_BE_OFF');
  }
  assert.ok(!Object.keys(task).some(key => !providerFields.has(key) && !requestFields.has(key)), 'UNKNOWN_TASK_FIELD');
  return task;
}
export function inventoryFor(count) {
  assert.ok(count === 128 || count === 129, 'EXACT_COMPATIBLE_FLOOR_REQUIRED');
  const value = registry.inventories[count === 128 ? 'passpilotAppointmentsPostExpand' : 'classpilotPrivateChatLifecyclePostExpand'];
  assert.ok(value.count === count && value.tables.length === count && new Set(value.tables).size === count, 'REGISTRY_INVENTORY_INVALID'); return [...value.tables];
}
export function anchor128Stages() {
  const keys = ['importProcessingStagesPostExpand', 'passpilotRulesPostExpand', 'classpilotUsageRollupsPostExpand', 'classpilotUsageRollupDaysPostExpand', 'passpilotAppointmentsPostExpand'];
  const counts = [121, 125, 126, 127, 128];
  const stages = keys.map((key, index) => {
    const value = registry.inventories[key];
    assert.ok(value.count === counts[index] && value.tables.length === counts[index] && new Set(value.tables).size === counts[index], 'ANCHOR_INVENTORY_INVALID');
    return [...value.tables];
  });
  for (let index = 1; index < stages.length; index++) equal(stages[index].slice(0, stages[index - 1].length), stages[index - 1], 'ANCHOR_INVENTORY_ORDER_CHANGED');
  return stages;
}
function requestProjection(response) {
  const request = Object.fromEntries(Object.entries(structuredClone(response.taskDefinition)).filter(([key]) => requestFields.has(key)));
  const tags = ecsRequestTags(response.tags); if (tags !== undefined) request.tags = tags;
  return request;
}
export function renderAnchor128Pair(sources, source, image) {
  checkString(source, /^[a-f0-9]{40}$/, 'ANCHOR_SOURCE_REQUIRED'); checkString(image, digestPattern, 'ANCHOR_IMAGE_REQUIRED');
  assert.ok(source !== '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678' && source !== FALLBACK.source, 'COMPATIBLE_CANDIDATE_ANCHOR_REQUIRED');
  const stages = anchor128Stages(), roles = ['api', 'scheduler-worker'];
  for (const role of roles) validateSourceResponse(sources[role], role, source, image, stages[0]);
  const managed = role => Object.fromEntries(Object.entries(env(runtimeContainer(sources[role].taskDefinition, role))).filter(([key]) => key.startsWith('CLASSPILOT_CAP_') || key === 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON' || key === 'CLASSPILOT_PROTOCOL_V3_ENABLED'));
  equal(managed('api'), managed('scheduler-worker'), 'PAIR_CAPABILITY_MISMATCH');
  const requests = Object.fromEntries(roles.map(role => [role, requestProjection(sources[role])]));
  for (let index = 1; index < stages.length; index++) {
    const table = stages[index].slice(stages[index - 1].length);
    verifyLiveRlsEnablementSources({ apiTaskDefinition: requests.api, workerTaskDefinition: requests['scheduler-worker'], table });
    for (const role of roles) addReviewedRlsTable(requests[role], { containerName: role, table });
    verifyEnabledRlsCandidates({ taskDefinitions: roles.map(role => ({ taskDefinition: requests[role], containerName: role })), table, expectedPreviousTables: stages[index - 1] });
  }
  for (const role of roles) assertOnlyAnchorAdmissionChanged(sources[role], requests[role], role, source, image);
  return requests;
}
export function assertOnlyAnchorAdmissionChanged(response, request, role, source, image) {
  const { tags, ...task } = request;
  validateSourceResponse({ taskDefinition: { ...task, ...Object.fromEntries(Object.entries(response.taskDefinition).filter(([key]) => providerFields.has(key))) }, tags }, role, source, image, inventoryFor(128));
  const restored = structuredClone(request), original = runtimeContainer(response.taskDefinition, role);
  runtimeContainer(restored, role).environment.find(entry => entry.name === 'RLS_ENABLED_TABLES').value = env(original).RLS_ENABLED_TABLES;
  equal(restored, requestProjection(response), 'UNRELATED_ANCHOR_MUTATION');
}
function assertUnusedSources(sources, services) {
  assert.ok(services?.services?.length === 2 && (services.failures ?? []).length === 0, 'CAPTURED_BASELINE_REQUIRED');
  equal(services.services.map(value => value.serviceName).sort(), ['schoolpilot-production-api', 'schoolpilot-production-scheduler-worker'], 'CAPTURED_SERVICES_INVALID');
  const arns = Object.values(sources).map(value => value.taskDefinition.taskDefinitionArn);
  for (const service of services.services) {
    const references = [service.taskDefinition, ...(service.deployments ?? []).map(value => value.taskDefinition), ...(service.taskSets ?? []).map(value => value.taskDefinition)];
    assert.ok(references.every(value => !arns.includes(value)), 'ANCHOR_SOURCE_IS_SERVING');
  }
}
function responseEnvironmentProjection(response) {
  return { ...responseTagProjection(response), taskDefinition: registrationEnvironmentProjection(response.taskDefinition) };
}
export function renderRequest(response, role, source, sourceImage, targetImage, count, releaseBinding) {
  checkString(source, /^[a-f0-9]{40}$/, 'SOURCE_SHA_INVALID'); checkString(sourceImage, digestPattern, 'SOURCE_DIGEST_INVALID'); checkString(targetImage, digestPattern, 'TARGET_DIGEST_INVALID');
  assert.ok(source !== '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678' && source !== FALLBACK.source, 'COMPATIBLE_CANDIDATE_ANCHOR_REQUIRED');
  const task = validateSourceResponse(response, role, source, sourceImage, inventoryFor(count), releaseBinding);
  const request = Object.fromEntries(Object.entries(structuredClone(task)).filter(([key]) => requestFields.has(key)));
  const tags = ecsRequestTags(response.tags); if (tags !== undefined) request.tags = tags;
  runtimeContainer(request, role).image = `${repoUri}@${targetImage}`;
  return request;
}
export function assertOnlyImageIdentityChanged(response, request, role, targetImage, fallback = FALLBACK) {
  const restored = structuredClone(request), container = runtimeContainer(restored, role);
  equal(container.image, `${repoUri}@${targetImage}`, 'RENDERED_IMAGE_INVALID');
  const values = env(container); equal(values.GIT_SHA, fallback.source, 'RENDERED_SOURCE_INVALID'); equal(values.SERVICE_NAME, role, 'RENDERED_SERVICE_INVALID');
  const originalContainer = runtimeContainer(response.taskDefinition, role);
  container.image = originalContainer.image;
  container.environment = [...container.environment.filter(item => !identityNames.has(item.name)), ...originalContainer.environment.filter(item => identityNames.has(item.name))];
  const expected = requestProjection(response);
  // The supported identity stamper only reorders its two identity entries.
  for (const value of [restored, expected]) runtimeContainer(value, role).environment.sort((a, b) => a.name.localeCompare(b.name));
  equal(restored, expected, 'UNRELATED_TASK_MUTATION');
}
export function validateImageEvidence(scan, proof, fallback = FALLBACK) {
  assert.ok(scan?.schemaVersion === 1 && scan.passed === true && proof?.schemaVersion === 1 && proof.passed === true, 'PASSED_REGISTRY_AND_SCAN_REQUIRED');
  for (const value of [scan, proof]) { equal(value.sourceSha, fallback.source, 'FALLBACK_SOURCE_CHANGED'); equal(value.scanner, SCANNER, 'PINNED_SCANNER_REQUIRED'); equal(value.configDigest, fallback.config, 'FALLBACK_CONFIG_CHANGED'); }
  equal(scan.imageId, fallback.localIndex, 'FALLBACK_LOCAL_INDEX_CHANGED'); equal([scan.os, scan.architecture], ['linux', 'amd64'], 'FALLBACK_PLATFORM_INVALID');
  equal(proof.platformDigest, fallback.platform, 'FALLBACK_PLATFORM_CHANGED'); checkString(proof.digest, digestPattern, 'PUBLISHED_DIGEST_REQUIRED');
  equal([proof.region, proof.repository], [FALLBACK.region, FALLBACK.repository], 'REGISTRY_CONTEXT_CHANGED');
  assert.ok(scan.counts?.HIGH === 0 && scan.counts?.CRITICAL === 0, 'BLOCKING_SCAN_FINDINGS');
}
async function checked(run, executable, args, options) { const result = await run(executable, args, options); assert.ok(result.code === 0, 'BOUND_COMMAND_FAILED'); return result.stdout; }
function writeNew(filename, value) { writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function sourceContract(directory, source, run) {
  assert.ok(path.isAbsolute(directory), 'SOURCE_DIRECTORY_REQUIRED');
  equal((await checked(run, 'git', ['-C', directory, 'rev-parse', 'HEAD'])).trim(), source, 'SOURCE_MOVED');
  equal((await checked(run, 'git', ['-C', directory, 'status', '--porcelain'])).trim(), '', 'SOURCE_DIRTY');
}
async function releaseBindingFor(input, run) {
  if (isSuccessorSchema(input.schemaVersion)) assert.ok(input.kind === undefined || input.kind === 'serving-anchor', 'ANCHOR_BINDING_ROLE_REQUIRED');
  return resolveReleaseBinding(input, { root: repositoryRoot, run, fallback: FALLBACK, sourceDirectory: input.anchorDirectory, source: input.anchorSource });
}
const selectedFallback = binding => isSuccessorSchema(binding?.schemaVersion) ? { ...FALLBACK, ...binding.fallback, tag: binding.fallback.source.slice(0, 12) } : FALLBACK;
function validateStage(input, releaseBinding) {
  const stage = pinnedJson(input.syntheticStage);
  if (releaseBinding) {
    equal(publicReceiptHash(readFileSync(input.syntheticStage.path)), releaseBinding.ordinaryRecoverySha256, 'BOUND_RECOVERY_PROOF_CHANGED');
    return; // The committed ordinary53 receipt was fully validated by releaseBindingFor.
  }
  equal(input.syntheticStage.sha256, FALLBACK.stageSha256, 'STAGE_PROOF_CHANGED');
  assert.ok(stage.passed === true && stage.servingSource === FALLBACK.application && stage.fallbackSource === FALLBACK.source && stage.retainedCompletedMigrationLedgerRows === 54 && stage.retainedScreenshotFunctionBodyAndAcl === true && stage.allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections === true, 'SYNTHETIC_COMPATIBILITY_PROOF_INVALID');
}
function validatePublicationBinding(input, releaseBinding) {
  if (releaseBinding) assertBoundPublication(pinnedJson(input.anchorPublication), releaseBinding, input.anchorSource, input.anchorImage);
}
async function checkAnchorSource(input, run, releaseBinding) {
  const fallback = selectedFallback(releaseBinding);
  await sourceContract(input.anchorDirectory, input.anchorSource, run);
  if (!releaseBinding) equal((await checked(run, 'git', ['-C', input.anchorDirectory, 'diff', '--name-only', FALLBACK.application, input.anchorSource, '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'drizzle.config.ts', 'Dockerfile', '.dockerignore', 'config', 'docs/soc2'])).trim(), '', 'ANCHOR_APPLICATION_BYTES_CHANGED');
  await sourceContract(input.fallbackDirectory, fallback.source, run);
  const protocol = async (directory, source) => {
    const text = await checked(run, 'git', ['-C', directory, 'show', `${source}:src/services/classpilotProtocol.ts`]);
    const list = text.match(/export const CLASSPILOT_PROTOCOL_V3_CAPABILITIES = \[([\s\S]*?)\] as const;/)?.[1]; assert.ok(list, 'CAPABILITY_REGISTRY_MISSING'); return [...list.matchAll(/"([A-Za-z0-9]+)"/g)].map(match => match[1]);
  };
  const capabilities = await protocol(input.anchorDirectory, input.anchorSource);
  equal(capabilities, await protocol(input.fallbackDirectory, fallback.source), 'CAPABILITY_REGISTRY_MISMATCH');
  for (const [file, markers] of [ ['src/services/classpilotPrivateChatLifecycle.ts', ['export const PRIVATE_CHAT_LIFECYCLE_WRITER_VERSION = 1;', 'export const PRIVATE_CHAT_BRIDGE_VERSION = 1;']], ['src/realtime/websocket.ts', ['export const PRIVATE_CHAT_RELAY_VERSION = 1;']] ]) {
    const text = await checked(run, 'git', ['-C', input.fallbackDirectory, 'show', `${fallback.source}:${file}`]); assert.ok(markers.every(marker => text.includes(marker)), 'PRIVATE_COMPATIBILITY_FLOOR_MISSING');
  }
  return capabilities;
}
export async function verifyRecoveryMutationSource(plan, releaseBinding, run) {
  assert.ok(releaseBinding && bindingSchema(plan.input) >= 2, 'V2_RECOVERY_BINDING_REQUIRED');
  await checkAnchorSource(plan.input, run, releaseBinding);
  await sourceContract(repositoryRoot, plan.toolSource, run);
  equal(plan.toolSha256, hash(readFileSync(fileURLToPath(import.meta.url))), 'TOOL_CHANGED');
  await verifyCurrentReleaseMain(plan.input.anchorSource, run);
}
async function privatePermissions(directory, inputFiles, run, initialize = false) {
  const helper = path.join(repositoryRoot, 'scripts/deploy-classpilot-runtime-config.ps1'); assert.ok([FALLBACK.permissionHelperSha256, FALLBACK.permissionHelperLfSha256].includes(hash(readFileSync(helper))), 'PERMISSION_HELPER_CHANGED');
  const bridge = path.join(directory, 'private-permissions.ps1');
  const bridgeSource = 'param([string]$ToolPath,[string]$DirectoryPath,[string]$RepositoryPath,[string]$InputsPath,[switch]$Initialize)\n. $ToolPath\nAssert-NoReparsePointInExistingPath -Path $DirectoryPath\nif ($Initialize) { Set-PrivatePathPermissions -Path $DirectoryPath -Directory }\nAssert-PrivatePathPermissions -Path $DirectoryPath -Directory\nforeach ($entry in (Get-Content -LiteralPath $InputsPath -Raw | ConvertFrom-Json)) { [void](Assert-PrivateInputPath -Path $entry -RepositoryRoot $RepositoryPath) }\n';
  if (initialize) { writeNew(bridge, bridgeSource); writeNew(path.join(directory, 'private-input-paths.json'), inputFiles); }
  equal(readFileSync(bridge, 'utf8'), bridgeSource, 'PERMISSION_BRIDGE_CHANGED'); equal(JSON.parse(readFileSync(path.join(directory, 'private-input-paths.json'), 'utf8')), inputFiles, 'PERMISSION_INPUTS_CHANGED');
  const args = ['-NoProfile', '-File', bridge, '-ToolPath', helper, '-DirectoryPath', directory, '-RepositoryPath', repositoryRoot, '-InputsPath', path.join(directory, 'private-input-paths.json')]; if (initialize) args.push('-Initialize');
  await checked(run, 'pwsh', args);
}
export function validateCleanupCustody(scanSha256, record) {
  assert.ok(record?.schemaVersion === 1 && record.complete === true && record.forced === false && record.exactOwned === true && record.scannerExitCode === 0 && record.ownedScannerAbsent === true, 'UNFORCED_SCANNER_CLEANUP_REQUIRED');
  checkString(scanSha256, /^[a-f0-9]{64}$/, 'SCAN_HASH_REQUIRED'); equal(record.scanSha256, scanSha256, 'CLEANUP_SCAN_BINDING_CHANGED');
  checkString(record.ownedScanner, /^schoolpilot-image-scan-[a-f0-9-]+$/, 'SCANNER_OWNER_INVALID');
}
export function validatePublishedTag(value, digest, source = FALLBACK.source) {
  assert.ok(value?.imageDetails?.length === 1, 'EXACT_SOURCE_TAG_REQUIRED'); const details = value.imageDetails[0];
  equal([details.registryId, details.repositoryName, details.imageDigest], [FALLBACK.account, FALLBACK.repository, digest], 'SOURCE_TAG_CONFLICT');
  assert.ok(details.imageTags?.includes(source.slice(0, 12)), 'EXACT_SOURCE_TAG_REQUIRED');
}
export function validateAnchorEvidence(input, scan, proof, tag, releaseBinding) {
  if (input.schemaVersion >= 2) assert.ok(releaseBinding, 'SCAN_BINDING_REQUIRED');
  const artifactSource = releaseBinding?.applicationSource ?? input.anchorSource;
  if (releaseBinding) assertBoundScan(scan, releaseBinding);
  assert.ok(scan?.schemaVersion === 1 && scan.passed === true && proof?.schemaVersion === 1 && proof.passed === true, 'PASSED_ANCHOR_SOURCE_PROOF_REQUIRED');
  equal([scan.sourceSha, proof.sourceSha], [artifactSource, artifactSource], 'ANCHOR_SOURCE_PROOF_MISMATCH');
  equal([scan.scanner, proof.scanner], [SCANNER, SCANNER], 'ANCHOR_SCANNER_MISMATCH');
  equal([scan.os, scan.architecture], ['linux', 'amd64'], 'ANCHOR_PLATFORM_INVALID');
  assert.ok(scan.counts?.HIGH === 0 && scan.counts?.CRITICAL === 0, 'ANCHOR_SCAN_FINDINGS');
  checkString(scan.configDigest, digestPattern, 'ANCHOR_CONFIG_REQUIRED'); checkString(scan.imageId, digestPattern, 'ANCHOR_LOCAL_IMAGE_REQUIRED'); checkString(proof.platformDigest, digestPattern, 'ANCHOR_PLATFORM_REQUIRED');
  equal([proof.receiptSha256, proof.configDigest, proof.digest, proof.region, proof.repository], [input.anchorScan.sha256, scan.configDigest, input.anchorImage, FALLBACK.region, FALLBACK.repository], 'ANCHOR_REGISTRY_PROOF_MISMATCH');
  if (isSuccessorSchema(releaseBinding?.schemaVersion)) equal(proof.platformDigest, releaseBinding.artifact.platform, 'BOUND_ANCHOR_PLATFORM_CHANGED');
  validatePublishedTag(tag, input.anchorImage, input.anchorSource);
}
export async function createPlan(input, { run = runCommand, now = Date.now } = {}) {
  const releaseBinding = await releaseBindingFor(input, run);
  const fallback = selectedFallback(releaseBinding);
  validatePublicationBinding(input, releaseBinding);
  assert.ok([1, 2, 3, 4, 5].includes(input?.schemaVersion) && path.isAbsolute(input.outputDirectory) && !existsSync(input.outputDirectory), 'FRESH_PLAN_DIRECTORY_REQUIRED');
  checkString(input.anchorSource, /^[a-f0-9]{40}$/, 'ANCHOR_SOURCE_REQUIRED'); checkString(input.anchorImage, digestPattern, 'ANCHOR_IMAGE_REQUIRED');
  for (const root of [repositoryRoot, input.anchorDirectory, input.fallbackDirectory]) { assert.ok(path.isAbsolute(root), 'SOURCE_DIRECTORY_REQUIRED'); const relative = path.relative(root, input.outputDirectory); assert.ok(relative.startsWith('..') && !path.isAbsolute(relative), 'PLAN_MUST_STAY_OUTSIDE_SOURCE'); }
  const scan = pinnedJson(input.scan), proof = pinnedJson(input.registryProof), cleanup = pinnedJson(input.scanCleanup);
  validateStage(input, releaseBinding);
  if (releaseBinding) assertBoundFallbackScan(input, scan, releaseBinding);
  validateImageEvidence(scan, proof, fallback); equal(proof.receiptSha256, input.scan.sha256, 'REGISTRY_SCAN_BINDING_CHANGED');
  validatePublishedTag(pinnedJson(input.publishedTag), proof.digest, fallback.source);
  if (isSuccessorSchema(input.schemaVersion)) assertBoundPublication(pinnedJson(input.fallbackPublication), bindingForRole(releaseBinding, 'fallback'), fallback.source, proof.digest);
  validateAnchorEvidence(input, pinnedJson(input.anchorScan), pinnedJson(input.anchorRegistryProof), pinnedJson(input.anchorPublishedTag), releaseBinding);
  validateCleanupCustody(input.scan.sha256, cleanup);
  const capabilities = await checkAnchorSource(input, run, releaseBinding);
  const toolSource = (await checked(run, 'git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).trim(); checkString(toolSource, /^[a-f0-9]{40}$/, 'TOOL_SOURCE_REQUIRED'); await sourceContract(repositoryRoot, toolSource, run);
  const sources = { api: pinnedJson(input.api), 'scheduler-worker': pinnedJson(input.worker) };
  const capturedServices = pinnedJson(input.liveServices);
  assert.ok(capturedServices.services?.length === 2 && (capturedServices.failures ?? []).length === 0, 'CAPTURED_BASELINE_REQUIRED');
  equal(capturedServices.services.map(value => value.serviceName).sort(), ['schoolpilot-production-api', 'schoolpilot-production-scheduler-worker'], 'CAPTURED_SERVICES_INVALID');
  const requests = Object.fromEntries(Object.entries(sources).map(([role, response]) => [role, renderRequest(response, role, input.anchorSource, input.anchorImage, proof.digest, input.admissionCount, releaseBinding)]));
  const states = Object.values(sources).map((value, index) => env(runtimeContainer(value.taskDefinition, index === 0 ? 'api' : 'scheduler-worker')));
  const managed = value => Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith('CLASSPILOT_CAP_') || key === 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON' || key === 'CLASSPILOT_PROTOCOL_V3_ENABLED'));
  equal(managed(states[0]), managed(states[1]), 'PAIR_CAPABILITY_MISMATCH');
  for (const state of states) assert.ok(Object.keys(JSON.parse(state.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON ?? '{}')).every(key => capabilities.includes(key)), 'UNKNOWN_CAPABILITY_KEY');
  const helper = path.join(repositoryRoot, 'scripts/stamp-release-runtime-identity.mjs'); const identityHelperSha256 = hash(readFileSync(helper)); assert.ok([FALLBACK.identityHelperSha256, FALLBACK.identityHelperLfSha256].includes(identityHelperSha256), 'IDENTITY_HELPER_CHANGED');
  const permissionHelperSha256 = hash(readFileSync(path.join(repositoryRoot, 'scripts/deploy-classpilot-runtime-config.ps1')));
  mkdirSync(input.outputDirectory, { recursive: false, mode: 0o700 });
  await privatePermissions(input.outputDirectory, [input.api.path, input.worker.path], run, true);
  const generated = {};
  for (const [role, request] of Object.entries(requests)) {
    const filename = path.join(input.outputDirectory, `${role}.private.json`); writeNew(filename, request);
    await checked(run, process.execPath, [helper, '--task-definition', filename, '--service', role, '--git-sha', fallback.source, '--image-ref', `${repoUri}@${proof.digest}`]);
    const stamped = JSON.parse(readFileSync(filename, 'utf8')); assertOnlyImageIdentityChanged(sources[role], stamped, role, proof.digest, fallback);
    generated[role] = { path: filename, sha256: hash(readFileSync(filename)), request: stamped, source: role === 'api' ? input.api : input.worker, sourceArn: sources[role].taskDefinition.taskDefinitionArn };
  }
  const plan = { schemaVersion: input.schemaVersion, ...(releaseBinding ? { releaseBinding } : {}), kind: 'compatible_fallback_inactive', ...(isSuccessorSchema(input.schemaVersion) ? { artifactRole: 'fallback', artifactSource: fallback.source } : {}), createdAtUtc: new Date(now()).toISOString(), executableActions: ['RegisterInactive'], input, toolSource, identityHelperSha256, permissionHelperSha256, liveServicesSha256: hash(capturedServices.services), toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))), identities: fallback, bindingHelperSha256: hash(readFileSync(path.join(repositoryRoot, 'scripts/release-source-binding.mjs'))), registryDigest: proof.digest, generated, cloudMutationsDuringPlan: 0, servicesMayChange: false };
  writeNew(path.join(input.outputDirectory, 'plan.private.json'), plan); return { path: path.join(input.outputDirectory, 'plan.private.json'), sha256: hash(JSON.stringify(plan, null, 2) + '\n'), admissionCount: input.admissionCount, registered: false };
}
async function hashFile(filename) { const digest = createHash('sha256'); for await (const chunk of createReadStream(filename)) digest.update(chunk); return digest.digest('hex'); }
async function replayScan(plan) {
  const fallback = selectedFallback(plan.releaseBinding);
  const scan = pinnedJson(plan.input.scan), proof = pinnedJson(plan.input.registryProof); validateImageEvidence(scan, proof, fallback);
  const custody = pinnedJson(plan.input.scanCleanup);
  validateCleanupCustody(plan.input.scan.sha256, custody);
  const directory = path.dirname(plan.input.scan.path);
  const legacyCleanup = JSON.parse(readFileSync(path.join(directory, 'cleanup.json'), 'utf8')); assert.ok(legacyCleanup.complete === true, 'SCANNER_CLEANUP_UNCONFIRMED'); equal(legacyCleanup.ownedScanner, custody.ownedScanner, 'SCANNER_OWNER_CHANGED');
  const report = readFileSync(path.join(directory, 'reports/trivy.json')); equal(hash(report), scan.reportSha256, 'SCAN_REPORT_CHANGED');
  equal(scanCounts(JSON.parse(report), fallback.config), scan.counts, 'SCAN_COUNTS_CHANGED');
  const archive = path.join(directory, 'input/image.tar'); equal(await hashFile(archive), scan.archiveSha256, 'SCAN_ARCHIVE_CHANGED'); equal(await archiveConfigDigest(archive, fallback.source), fallback.config, 'SCAN_CONFIG_CHANGED');
  const anchorScan = pinnedJson(plan.input.anchorScan), anchorProof = pinnedJson(plan.input.anchorRegistryProof);
  validateAnchorEvidence(plan.input, anchorScan, anchorProof, pinnedJson(plan.input.anchorPublishedTag), plan.releaseBinding);
  const anchorDirectory = path.dirname(plan.input.anchorScan.path);
  assert.ok(JSON.parse(readFileSync(path.join(anchorDirectory, 'cleanup.json'), 'utf8')).complete === true, 'ANCHOR_SCANNER_CLEANUP_UNCONFIRMED');
  const anchorReport = readFileSync(path.join(anchorDirectory, 'reports/trivy.json')); equal(hash(anchorReport), anchorScan.reportSha256, 'ANCHOR_REPORT_CHANGED'); equal(scanCounts(JSON.parse(anchorReport), anchorScan.configDigest), anchorScan.counts, 'ANCHOR_SCAN_COUNTS_CHANGED');
  const anchorArchive = path.join(anchorDirectory, 'input/image.tar'); equal(await hashFile(anchorArchive), anchorScan.archiveSha256, 'ANCHOR_ARCHIVE_CHANGED'); equal(await archiveConfigDigest(anchorArchive, plan.releaseBinding?.applicationSource ?? plan.input.anchorSource), anchorScan.configDigest, 'ANCHOR_IMAGE_SOURCE_CHANGED');
}
async function verifyRemoteRegistry(plan, run, arm = 'fallback') {
  const proof = pinnedJson(arm === 'anchor' ? plan.input.anchorRegistryProof : plan.input.registryProof);
  return validateRegistryManifest(async digest => {
    const response = JSON.parse(await checked(run, 'aws', ['ecr', 'batch-get-image', '--repository-name', FALLBACK.repository, '--image-ids', `imageDigest=${digest}`, '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager']));
    if (plan.schemaVersion === 5) return selectRegistryDigestImage(response, { registryId: FALLBACK.account, repository: FALLBACK.repository, digest });
    assert.ok(response.images?.length === 1 && (response.failures ?? []).length === 0 && response.images[0].repositoryName === FALLBACK.repository, 'REGISTRY_IMAGE_UNAVAILABLE'); return response.images[0];
  }, proof.digest, proof.configDigest);
}
export function retainSuccessorRegistration(result, role, response, requestSha256, family) {
  assert.ok(isSuccessorSchema(result.schemaVersion), 'SUCCESSOR_REGISTRATION_SCHEMA_REQUIRED');
  const arn = response.taskDefinition?.taskDefinitionArn;
  result.registered.push({ role, arn: typeof arn === 'string' ? arn : null, requestSha256 });
  result.registrationOutcomeUncertain = typeof arn !== 'string' || !new RegExp(`^arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:[1-9][0-9]*$`).test(arn);
  return arn;
}
export async function registerInactive(planRecord, authorizationRecord, { run = runCommand, now = Date.now, verifyLocalScan = replayScan, verifyRegistry = verifyRemoteRegistry } = {}) {
  const plan = pinnedJson(planRecord), authorization = pinnedJson(authorizationRecord);
  equal(plan.kind, 'compatible_fallback_inactive', 'PLAN_KIND_INVALID'); equal(plan.toolSha256, hash(readFileSync(fileURLToPath(import.meta.url))), 'TOOL_CHANGED'); equal(plan.identities, selectedFallback(plan.releaseBinding), 'PLAN_IDENTITIES_CHANGED');
  assert.ok(authorization.schemaVersion === 1 && authorization.operation === 'RegisterInactive' && authorization.authorized === true && authorization.planSha256 === planRecord.sha256, 'EXACT_AUTHORIZATION_REQUIRED');
  const start = Date.parse(authorization.startsAtUtc), end = Date.parse(authorization.expiresAtUtc); assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 60 * 60_000, 'BOUNDED_WINDOW_REQUIRED');
  const inWindow = () => assert.ok(now() >= start && now() < end, 'AUTHORIZED_WINDOW_EXPIRED'); inWindow();
  assert.ok(now() - Date.parse(plan.createdAtUtc) >= 0 && now() - Date.parse(plan.createdAtUtc) <= 60 * 60_000, 'PLAN_EXPIRED');
  const receiptPath = path.join(plan.input.outputDirectory, 'registration.private.json'); assert.ok(!existsSync(receiptPath), 'PLAN_ALREADY_USED');
  const releaseBinding = await releaseBindingFor(plan.input, run);
  const fallback = selectedFallback(releaseBinding);
  equal(plan.identities, fallback, 'PLAN_IDENTITIES_CHANGED');
  if (isSuccessorSchema(plan.schemaVersion)) assertBoundPublication(pinnedJson(plan.input.fallbackPublication), bindingForRole(releaseBinding, 'fallback'), fallback.source, plan.registryDigest);
  equal(plan.schemaVersion, bindingSchema(plan.input), 'PLAN_SCHEMA_CHANGED');
  assertBindingReplay(plan.input, plan.releaseBinding, releaseBinding);
  if (releaseBinding) equal(plan.bindingHelperSha256, hash(readFileSync(path.join(repositoryRoot, 'scripts/release-source-binding.mjs'))), 'BINDING_HELPER_CHANGED');
  validatePublicationBinding(plan.input, releaseBinding); validateStage(plan.input, releaseBinding);
  if (releaseBinding) assertBoundFallbackScan(plan.input, pinnedJson(plan.input.scan), releaseBinding);
  await checkAnchorSource(plan.input, run, releaseBinding); await verifyLocalScan(plan);
  await sourceContract(repositoryRoot, plan.toolSource, run);
  equal(hash(readFileSync(path.join(repositoryRoot, 'scripts/stamp-release-runtime-identity.mjs'))), plan.identityHelperSha256, 'IDENTITY_HELPER_BYTES_CHANGED');
  equal(hash(readFileSync(path.join(repositoryRoot, 'scripts/deploy-classpilot-runtime-config.ps1'))), plan.permissionHelperSha256, 'PERMISSION_HELPER_BYTES_CHANGED');
  if (releaseBinding) await verifyCurrentReleaseMain(plan.input.anchorSource, run);
  await privatePermissions(plan.input.outputDirectory, [plan.input.api.path, plan.input.worker.path], run);
  const originalRun = run; let commandIndex = 0;
  run = async (executable, args, options) => {
    assert.ok(executable === 'aws', 'REGISTRATION_TRANSPORT_MUST_BE_AWS');
    const filename = path.join(plan.input.outputDirectory, `${String(++commandIndex).padStart(2, '0')}-${args[0]}-${args[1]}.private.json`);
    const response = await originalRun(executable, args, options); writeNew(filename, { executable, args, code: response.code, stdout: response.stdout, stderr: response.stderr }); return response;
  };
  const identity = JSON.parse(await checked(run, 'aws', ['sts', 'get-caller-identity', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'])); equal(identity.Account, FALLBACK.account, 'AWS_ACCOUNT_CHANGED');
  const tag = JSON.parse(await checked(run, 'aws', ['ecr', 'describe-images', '--repository-name', FALLBACK.repository, '--image-ids', `imageTag=${fallback.tag}`, '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager']));
  validatePublishedTag(tag, plan.registryDigest, fallback.source);
  const remote = await verifyRegistry(plan, run); equal([remote.digest, remote.configDigest, remote.platformDigest], [plan.registryDigest, fallback.config, fallback.platform], 'REGISTRY_IDENTITY_CHANGED');
  const anchorScan = pinnedJson(plan.input.anchorScan), anchorProof = pinnedJson(plan.input.anchorRegistryProof); validateAnchorEvidence(plan.input, anchorScan, anchorProof, pinnedJson(plan.input.anchorPublishedTag), releaseBinding);
  const anchorTag = JSON.parse(await checked(run, 'aws', ['ecr', 'describe-images', '--repository-name', FALLBACK.repository, '--image-ids', `imageTag=${plan.input.anchorSource.slice(0, 12)}`, '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'])); validatePublishedTag(anchorTag, plan.input.anchorImage, plan.input.anchorSource);
  const anchorRemote = await verifyRegistry(plan, run, 'anchor'); equal([anchorRemote.digest, anchorRemote.configDigest, anchorRemote.platformDigest], [plan.input.anchorImage, anchorScan.configDigest, anchorProof.platformDigest], 'ANCHOR_REMOTE_IMAGE_CHANGED');
  const serviceArgs = ['ecs', 'describe-services', '--cluster', 'schoolpilot-production-cluster', '--services', 'schoolpilot-production-api', 'schoolpilot-production-scheduler-worker', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'];
  const live = JSON.parse(await checked(run, 'aws', serviceArgs)); assert.ok(live.services?.length === 2 && (live.failures ?? []).length === 0, 'BASELINE_UNAVAILABLE');
  equal(hash(live.services), plan.liveServicesSha256, 'LIVE_BASELINE_DRIFT'); equal(hash(pinnedJson(plan.input.liveServices).services), plan.liveServicesSha256, 'CAPTURED_BASELINE_CHANGED');
  const result = { schemaVersion: plan.schemaVersion, ...(plan.schemaVersion === 5 ? {kind:'compatible_fallback_inactive',operation:'RegisterInactive',plan:planRecord,authorization:authorizationRecord,registrationOutcomeUncertain:false} : {}), ...(plan.releaseBinding ? { releaseBinding: isSuccessorSchema(plan.schemaVersion) ? bindingForRole(plan.releaseBinding, 'fallback') : plan.releaseBinding, source: isSuccessorSchema(plan.schemaVersion) ? fallback.source : plan.input.anchorSource, artifactSource: isSuccessorSchema(plan.schemaVersion) ? fallback.source : plan.releaseBinding.applicationSource, ...(isSuccessorSchema(plan.schemaVersion) ? { artifactRole: 'fallback' } : {}) } : {}), planSha256: planRecord.sha256, status: 'started', registered: [], servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0 };
  writeNew(receiptPath, result);
  try {
    for (const role of ['api', 'scheduler-worker']) {
      inWindow(); const generated = plan.generated[role]; equal(hash(readFileSync(generated.path)), generated.sha256, 'GENERATED_REQUEST_CHANGED');
      const source = JSON.parse(await checked(run, 'aws', ['ecs', 'describe-task-definition', '--task-definition', generated.sourceArn, '--include', 'TAGS', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager']));
      equal(responseTagProjection(source), responseTagProjection(pinnedJson(generated.source)), 'ANCHOR_DEFINITION_CHANGED');
      const request = JSON.parse(readFileSync(generated.path, 'utf8')); equal(request, generated.request, 'PLANNED_REQUEST_CHANGED'); assertOnlyImageIdentityChanged(source, request, role, plan.registryDigest, fallback);
      if (releaseBinding) {
        assertBindingReplay(plan.input, plan.releaseBinding, await releaseBindingFor(plan.input, originalRun));
        await verifyRecoveryMutationSource(plan, releaseBinding, originalRun);
      }
      inWindow();
      result.lastAttemptedRole = role; result.registrationOutcomeUncertain = true; writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      const registered = JSON.parse(await checked(run, 'aws', ['ecs', 'register-task-definition', '--cli-input-json', `file://${generated.path.replaceAll('\\', '/')}`, '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager']));
      const arn = isSuccessorSchema(plan.schemaVersion) ? retainSuccessorRegistration(result, role, registered, generated.sha256, request.family) : registered.taskDefinition?.taskDefinitionArn;
      if (isSuccessorSchema(plan.schemaVersion)) writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      checkString(arn, new RegExp(`^arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${request.family}:[1-9][0-9]*$`), 'REGISTERED_ARN_INVALID');
      if (!isSuccessorSchema(plan.schemaVersion)) { result.registered.push({ role, arn, requestSha256: generated.sha256 }); result.registrationOutcomeUncertain = false; writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); }
      inWindow();
      const actual = JSON.parse(await checked(run, 'aws', ['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager']));
      validateSourceResponse(actual, role, fallback.source, plan.registryDigest, inventoryFor(plan.input.admissionCount), releaseBinding);
      const actualRequest = Object.fromEntries(Object.entries(actual.taskDefinition).filter(([key]) => requestFields.has(key))); if (actual.tags !== undefined) actualRequest.tags = actual.tags; equal(registrationEnvironmentProjection(actualRequest), registrationEnvironmentProjection(request), 'REGISTERED_DEFINITION_DRIFT');
    }
    inWindow(); const after = JSON.parse(await checked(run, 'aws', serviceArgs)); equal(after.services, live.services, 'SERVICES_CHANGED_DURING_INACTIVE_REGISTRATION');
    result.status = 'registered_inactive'; result.servicesUnchanged = true;
  } catch { result.status = 'failed_retained_inactive'; result.errorCode = 'COMPATIBLE_INACTIVE_REGISTRATION_FAILED'; throw new Error(result.errorCode); }
  finally { writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); }
  return { registered: result.registered, receiptPath, receiptSha256: hash(readFileSync(receiptPath)), servicesUpdated: 0, tasksLaunched: 0 };
}
const anchorHelperFiles = ['scripts/release-source-binding.mjs', 'scripts/enforce-deploy-rls-allowlist.mjs', 'src/config/rlsRegistry.json', 'scripts/verify-legacy-deploy-image.mjs', 'scripts/deploy-classpilot-runtime-config.ps1'];
function anchorHelperHashes(schemaVersion) { return Object.fromEntries([...anchorHelperFiles, ...(schemaVersion === 5 ? BUILD_SECURITY_OPERATION_DEPENDENCIES : [])].map(file => [file, hash(readFileSync(path.join(repositoryRoot, file)))])); }
function anchorEvidence(input, releaseBinding) {
  validatePublicationBinding(input, releaseBinding);
  const scan = pinnedJson(input.anchorScan), proof = pinnedJson(input.anchorRegistryProof);
  validateAnchorEvidence(input, scan, proof, pinnedJson(input.anchorPublishedTag), releaseBinding);
  validateCleanupCustody(input.anchorScan.sha256, pinnedJson(input.anchorScanCleanup));
  validateStage(input, releaseBinding);
  return { scan, proof };
}
async function replayAnchor128Scan(plan) {
  const { scan } = anchorEvidence(plan.input, plan.releaseBinding), directory = path.dirname(plan.input.anchorScan.path);
  const custody = pinnedJson(plan.input.anchorScanCleanup), legacy = JSON.parse(readFileSync(path.join(directory, 'cleanup.json'), 'utf8'));
  assert.ok(legacy.complete === true, 'ANCHOR_SCANNER_CLEANUP_UNCONFIRMED'); equal(legacy.ownedScanner, custody.ownedScanner, 'ANCHOR_SCANNER_OWNER_CHANGED');
  const report = readFileSync(path.join(directory, 'reports/trivy.json')); equal(hash(report), scan.reportSha256, 'ANCHOR_REPORT_CHANGED'); equal(scanCounts(JSON.parse(report), scan.configDigest), scan.counts, 'ANCHOR_SCAN_COUNTS_CHANGED');
  const archive = path.join(directory, 'input/image.tar'); equal(await hashFile(archive), scan.archiveSha256, 'ANCHOR_ARCHIVE_CHANGED'); equal(await archiveConfigDigest(archive, plan.releaseBinding?.applicationSource ?? plan.input.anchorSource), scan.configDigest, 'ANCHOR_IMAGE_SOURCE_CHANGED');
}
export async function createAnchor128Plan(input, { run = runCommand, now = Date.now } = {}) {
  const releaseBinding = await releaseBindingFor(input, run);
  assert.notEqual(input.schemaVersion, 5, 'CURRENT129_OPERATION_REQUIRED');
  assert.ok([1, 2, 3, 4, 5].includes(input?.schemaVersion) && path.isAbsolute(input.outputDirectory) && !existsSync(input.outputDirectory), 'FRESH_PLAN_DIRECTORY_REQUIRED');
  for (const root of [repositoryRoot, input.anchorDirectory, input.fallbackDirectory]) {
    assert.ok(path.isAbsolute(root), 'SOURCE_DIRECTORY_REQUIRED'); const relative = path.relative(root, input.outputDirectory); assert.ok(relative.startsWith('..') && !path.isAbsolute(relative), 'PLAN_MUST_STAY_OUTSIDE_SOURCE');
  }
  const { proof } = anchorEvidence(input, releaseBinding), capabilities = await checkAnchorSource(input, run, releaseBinding);
  const toolSource = (await checked(run, 'git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).trim(); checkString(toolSource, /^[a-f0-9]{40}$/, 'TOOL_SOURCE_REQUIRED'); await sourceContract(repositoryRoot, toolSource, run);
  const sources = { api: pinnedJson(input.api), 'scheduler-worker': pinnedJson(input.worker) }, live = pinnedJson(input.liveServices);
  assertUnusedSources(sources, live);
  const requests = renderAnchor128Pair(sources, input.anchorSource, input.anchorImage);
  for (const [role, request] of Object.entries(requests)) assert.ok(Object.keys(JSON.parse(env(runtimeContainer(request, role)).CLASSPILOT_CAPABILITY_ROLLOUTS_JSON ?? '{}')).every(key => capabilities.includes(key)), 'UNKNOWN_CAPABILITY_KEY');
  mkdirSync(input.outputDirectory, { recursive: false, mode: 0o700 });
  await privatePermissions(input.outputDirectory, [input.api.path, input.worker.path], run, true);
  const generated = {};
  for (const [role, request] of Object.entries(requests)) {
    const filename = path.join(input.outputDirectory, `${role}.private.json`); writeNew(filename, request);
    generated[role] = { path: filename, sha256: hash(readFileSync(filename)), request, source: role === 'api' ? input.api : input.worker, sourceArn: sources[role].taskDefinition.taskDefinitionArn };
  }
  const plan = { schemaVersion: input.schemaVersion, ...(releaseBinding ? { releaseBinding } : {}), kind: 'compatible_anchor128_inactive', createdAtUtc: new Date(now()).toISOString(), executableActions: ['RegisterInactiveAnchor128'], input, toolSource, toolSha256: hash(readFileSync(fileURLToPath(import.meta.url))), helperHashes: anchorHelperHashes(input.schemaVersion), liveServicesSha256: hash(live.services), registryDigest: proof.digest, generated, admissionCounts: [121, 125, 126, 127, 128], cloudMutationsDuringPlan: 0, servicesMayChange: false };
  const filename = path.join(input.outputDirectory, 'plan.private.json'); writeNew(filename, plan);
  return { path: filename, sha256: hash(readFileSync(filename)), admissionCount: 128, registered: false };
}
export async function registerAnchor128Inactive(planRecord, authorizationRecord, { run = runCommand, now = Date.now, verifyLocalScan = replayAnchor128Scan, verifyRegistry = (plan, command) => verifyRemoteRegistry(plan, command, 'anchor') } = {}) {
  const plan = pinnedJson(planRecord), authorization = pinnedJson(authorizationRecord);
  equal(plan.kind, 'compatible_anchor128_inactive', 'PLAN_KIND_INVALID'); equal(plan.executableActions, ['RegisterInactiveAnchor128'], 'PLAN_ACTION_CHANGED'); equal(plan.toolSha256, hash(readFileSync(fileURLToPath(import.meta.url))), 'TOOL_CHANGED'); equal(plan.helperHashes, anchorHelperHashes(plan.schemaVersion), 'ANCHOR_HELPER_CHANGED');
  equal(plan.admissionCounts, [121, 125, 126, 127, 128], 'ANCHOR_SEQUENCE_CHANGED');
  assert.ok(authorization.schemaVersion === 1 && authorization.operation === 'RegisterInactiveAnchor128' && authorization.authorized === true && authorization.planSha256 === planRecord.sha256, 'EXACT_AUTHORIZATION_REQUIRED');
  const start = Date.parse(authorization.startsAtUtc), end = Date.parse(authorization.expiresAtUtc); assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 60 * 60_000, 'BOUNDED_WINDOW_REQUIRED');
  const inWindow = () => assert.ok(now() >= start && now() < end, 'AUTHORIZED_WINDOW_EXPIRED'); inWindow();
  assert.ok(now() - Date.parse(plan.createdAtUtc) >= 0 && now() - Date.parse(plan.createdAtUtc) <= 60 * 60_000, 'PLAN_EXPIRED');
  const receiptPath = path.join(plan.input.outputDirectory, 'registration.private.json'); assert.ok(!existsSync(receiptPath), 'PLAN_ALREADY_USED');
  const releaseBinding = await releaseBindingFor(plan.input, run);
  equal(plan.schemaVersion, bindingSchema(plan.input), 'PLAN_SCHEMA_CHANGED');
  assertBindingReplay(plan.input, plan.releaseBinding, releaseBinding);
  const { scan, proof } = anchorEvidence(plan.input, releaseBinding); equal(plan.registryDigest, proof.digest, 'ANCHOR_DIGEST_CHANGED');
  await checkAnchorSource(plan.input, run, releaseBinding); await sourceContract(repositoryRoot, plan.toolSource, run); await verifyLocalScan(plan);
  if (releaseBinding) await verifyCurrentReleaseMain(plan.input.anchorSource, run);
  await privatePermissions(plan.input.outputDirectory, [plan.input.api.path, plan.input.worker.path], run);
  const sources = { api: pinnedJson(plan.input.api), 'scheduler-worker': pinnedJson(plan.input.worker) }, captured = pinnedJson(plan.input.liveServices);
  const requests = renderAnchor128Pair(sources, plan.input.anchorSource, plan.input.anchorImage); assertUnusedSources(sources, captured); equal(hash(captured.services), plan.liveServicesSha256, 'CAPTURED_BASELINE_CHANGED');
  for (const role of ['api', 'scheduler-worker']) {
    const generated = plan.generated[role]; equal([generated.source, generated.sourceArn], [role === 'api' ? plan.input.api : plan.input.worker, sources[role].taskDefinition.taskDefinitionArn], 'ANCHOR_SOURCE_BINDING_CHANGED');
    equal(hash(readFileSync(generated.path)), generated.sha256, 'GENERATED_REQUEST_CHANGED'); equal(JSON.parse(readFileSync(generated.path, 'utf8')), requests[role], 'PLANNED_REQUEST_CHANGED'); equal(generated.request, requests[role], 'PLANNED_REQUEST_CHANGED');
  }
  const originalRun = run; let commandIndex = 0, mutations = 0, registrationArmed = false;
  run = async (executable, args, options) => {
    const operation = `${args[0]}:${args[1]}`;
    assert.ok(executable === 'aws' && ['sts:get-caller-identity', 'ecr:describe-images', 'ecr:batch-get-image', 'ecs:describe-services', 'ecs:describe-task-definition', 'ecs:register-task-definition'].includes(operation), 'UNEXPECTED_ANCHOR_COMMAND');
    if (operation === 'ecs:register-task-definition') { assert.ok(registrationArmed && ++mutations <= 2, 'UNEXPECTED_ANCHOR_MUTATION'); registrationArmed = false; }
    const filename = path.join(plan.input.outputDirectory, `${String(++commandIndex).padStart(2, '0')}-${args[0]}-${args[1]}.private.json`);
    const response = await originalRun(executable, args, options); writeNew(filename, { executable, args, code: response.code, stdout: response.stdout, stderr: response.stderr }); return response;
  };
  const serviceArgs = ['ecs', 'describe-services', '--cluster', 'schoolpilot-production-cluster', '--services', 'schoolpilot-production-api', 'schoolpilot-production-scheduler-worker', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'];
  const sourceArgs = arn => ['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'];
  const identity = JSON.parse(await checked(run, 'aws', ['sts', 'get-caller-identity', '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'])); equal(identity.Account, FALLBACK.account, 'AWS_ACCOUNT_CHANGED');
  const tag = JSON.parse(await checked(run, 'aws', ['ecr', 'describe-images', '--repository-name', FALLBACK.repository, '--image-ids', `imageTag=${plan.input.anchorSource.slice(0, 12)}`, '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager'])); validatePublishedTag(tag, plan.registryDigest, plan.input.anchorSource);
  const remote = await verifyRegistry(plan, run); equal([remote.digest, remote.configDigest, remote.platformDigest], [plan.registryDigest, scan.configDigest, proof.platformDigest], 'ANCHOR_REMOTE_IMAGE_CHANGED');
  const live = JSON.parse(await checked(run, 'aws', serviceArgs)); equal(hash(live.services), plan.liveServicesSha256, 'LIVE_BASELINE_DRIFT'); assertUnusedSources(sources, live);
  // Check both captured unused sources before the first mutation, then again immediately before each registration.
  for (const role of ['api', 'scheduler-worker']) equal(responseEnvironmentProjection(JSON.parse(await checked(run, 'aws', sourceArgs(plan.generated[role].sourceArn)))), responseEnvironmentProjection(sources[role]), 'ANCHOR_DEFINITION_CHANGED');
  inWindow();
  const result = { schemaVersion: plan.schemaVersion, ...(plan.releaseBinding ? { releaseBinding: plan.releaseBinding, source: plan.input.anchorSource, artifactSource: plan.releaseBinding.applicationSource, ...(isSuccessorSchema(plan.schemaVersion) ? { artifactRole: 'serving-anchor' } : {}) } : {}), kind: plan.kind, planSha256: planRecord.sha256, status: 'started', registered: [], servicesUpdated: 0, tasksLaunched: 0, productionDatabaseOperations: 0, imagesPublished: 0, admissionCounts: plan.admissionCounts };
  writeNew(receiptPath, result);
  try {
    for (const role of ['api', 'scheduler-worker']) {
      inWindow(); const generated = plan.generated[role], source = JSON.parse(await checked(run, 'aws', sourceArgs(generated.sourceArn)));
      equal(responseEnvironmentProjection(source), responseEnvironmentProjection(sources[role]), 'ANCHOR_DEFINITION_CHANGED');
      equal(hash(readFileSync(generated.path)), generated.sha256, 'GENERATED_REQUEST_CHANGED'); const request = JSON.parse(readFileSync(generated.path, 'utf8')); assertOnlyAnchorAdmissionChanged(sources[role], request, role, plan.input.anchorSource, plan.registryDigest);
      if (releaseBinding) {
        assertBindingReplay(plan.input, plan.releaseBinding, await releaseBindingFor(plan.input, originalRun));
        await verifyRecoveryMutationSource(plan, releaseBinding, originalRun);
      }
      inWindow(); result.lastAttemptedRole = role; result.registrationOutcomeUncertain = true; writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); registrationArmed = true;
      const registered = JSON.parse(await checked(run, 'aws', ['ecs', 'register-task-definition', '--cli-input-json', `file://${generated.path.replaceAll('\\', '/')}`, '--region', FALLBACK.region, '--output', 'json', '--no-cli-pager']));
      const arn = isSuccessorSchema(plan.schemaVersion) ? retainSuccessorRegistration(result, role, registered, generated.sha256, request.family) : registered.taskDefinition?.taskDefinitionArn;
      if (isSuccessorSchema(plan.schemaVersion)) writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      checkString(arn, new RegExp(`^arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${request.family}:[1-9][0-9]*$`), 'REGISTERED_ARN_INVALID');
      if (!isSuccessorSchema(plan.schemaVersion)) { result.registered.push({ role, arn, requestSha256: generated.sha256 }); result.registrationOutcomeUncertain = false; writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); } inWindow();
      const actual = JSON.parse(await checked(run, 'aws', sourceArgs(arn))); validateSourceResponse(actual, role, plan.input.anchorSource, plan.registryDigest, inventoryFor(128));
      equal(registrationEnvironmentProjection(requestProjection(actual)), registrationEnvironmentProjection(request), 'REGISTERED_DEFINITION_DRIFT');
    }
    const after = JSON.parse(await checked(run, 'aws', serviceArgs)); equal(after, live, 'SERVICES_CHANGED_DURING_INACTIVE_REGISTRATION'); inWindow();
    assertUnusedSources(Object.fromEntries(result.registered.map(value => [value.role, { taskDefinition: { taskDefinitionArn: value.arn } }])), after);
    result.status = 'registered_inactive'; result.servicesUnchanged = true;
  } catch { result.status = 'failed_retained_inactive'; result.errorCode = 'COMPATIBLE_ANCHOR128_REGISTRATION_FAILED'; throw new Error(result.errorCode); }
  finally { writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); }
  return { registered: result.registered, receiptPath, receiptSha256: hash(readFileSync(receiptPath)), admissionCount: 128, servicesUpdated: 0, tasksLaunched: 0 };
}
async function main(args) {
  const [operation, inputPath, inputHash, authorizationPath, authorizationHash] = args;
  if (operation === 'ValidateSuccessorPreparation' && args.length === 3) {
    const input = pinnedJson({ path: inputPath, sha256: inputHash }); console.log(JSON.stringify(await validateSuccessorPreparation(input, { root: repositoryRoot, run: runCommand, fallback: FALLBACK, sourceDirectory: input.anchorDirectory, source: input.anchorSource })));
  } else if (operation === 'Plan' && args.length === 3) {
    const result = await createPlan(pinnedJson({ path: inputPath, sha256: inputHash })); console.log(JSON.stringify(result));
  } else if (operation === 'RegisterInactive' && args.length === 5) {
    const result = await registerInactive({ path: inputPath, sha256: inputHash }, { path: authorizationPath, sha256: authorizationHash }); console.log(JSON.stringify(result));
  } else if (operation === 'PlanAnchor128' && args.length === 3) {
    const result = await createAnchor128Plan(pinnedJson({ path: inputPath, sha256: inputHash })); console.log(JSON.stringify(result));
  } else if (operation === 'RegisterInactiveAnchor128' && args.length === 5) {
    const result = await registerAnchor128Inactive({ path: inputPath, sha256: inputHash }, { path: authorizationPath, sha256: authorizationHash }); console.log(JSON.stringify(result));
  } else throw new Error('EXPECTED_PLAN_OR_REGISTER_INACTIVE');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => { console.error('COMPATIBLE_FALLBACK_PREPARATION_FAILED'); process.exitCode = 1; });
