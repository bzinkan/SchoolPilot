import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FREEZE_SHA256, SOURCES, guard, sha256, assertSha, hashFile, safePath, verifyReference, readReference, verifyRelocation, writeNewJson, readCliRequest, isMain, cliFailure } from './relocation.mjs';
import { loadSourceRestoration, verifyCheckout } from './source-checkout.mjs';
export { verifyCheckout } from './source-checkout.mjs';

export const STAGES = Object.freeze([
  { name: 'sole', profile: 'sole', kind: 'paired', count: 8 },
  { name: 'normal', profile: 'normal', kind: 'paired', count: 8 },
  { name: 'classroom', profile: 'classroomNative', kind: 'classroom', count: 1 },
  { name: 'mixed', profile: 'mixedNative', kind: 'mixed', count: 3 },
  { name: 'usage', profile: 'usage', kind: 'usage', count: 3 },
  { name: 'distinct', profile: 'usageDistinct', kind: 'distinct', count: 1 },
  { name: 'ordinary800', profile: 'broader', kind: 'mixed', count: 3 },
  { name: 'concentrated800', profile: 'broaderConcentrated', kind: 'mixed', count: 3 },
].map(Object.freeze));
export const PAIRED_ORDER = Object.freeze(['A', 'A', 'A', 'B', 'B', 'A', 'A', 'B']);
export function schoolDate(ms) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
export function assertFreshCapture(capture, now, key = 'capturedAtUtc') {
  const at = Date.parse(capture[key]); guard(Number.isFinite(at) && now >= at && now - at <= 600_000, 'READINESS_CAPTURE_STALE');
}
export function assertWindow(window, now, { entry = true } = {}) {
  const start = Date.parse(window.startsAt), end = Date.parse(window.expiresAt);
  guard(Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now, 'QUIET_WINDOW_CLOSED');
  if (entry) guard(end - now >= 240 * 60_000, 'QUIET_WINDOW_TOO_SHORT');
  guard(window.noOtherLoadOrBuilds === true && window.serialExecution === true, 'QUIET_WINDOW_NOT_EXCLUSIVE');
  guard(schoolDate(now) === schoolDate(end - 1), 'QUIET_WINDOW_CROSSES_SCHOOL_DATE'); return { start, end };
}

// Every historical hash reference encountered in the freeze must have an explicit mapping.
export function verifyHistoricalReferences(value, relocation) {
  if (!value || typeof value !== 'object') return;
  if (typeof (value.path ?? value.file) === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')) relocation.ref(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') verifyHistoricalReferences(child, relocation);
}
export function resolveFreeze(freeze, relocation) {
  const ref = r => relocation.ref(r), p = value => relocation.resolve(value);
  return { ...freeze, sourceDirectory: p(freeze.sourceDirectory), baselineSourceDirectory: p(freeze.baselineSourceDirectory), harnessDirectory: p(freeze.harnessDirectory),
    schemaFile: p(freeze.schemaFile), baselineSchema: { ...freeze.baselineSchema, file: p(freeze.baselineSchema.file), receipt: ref(freeze.baselineSchema.receipt) },
    usageSourceBindingFile: relocation.resolve(freeze.usageSourceBindingFile, freeze.usageSourceBindingSha256),
    usageSourceReviewFile: relocation.resolve(freeze.usageSourceReviewFile, freeze.usageSourceReviewSha256),
    baselineUsageSourceBindingFile: relocation.resolve(freeze.baselineUsageSourceBindingFile, freeze.baselineUsageSourceBindingSha256),
    baselineUsageSourceReviewFile: relocation.resolve(freeze.baselineUsageSourceReviewFile, freeze.baselineUsageSourceReviewSha256),
    observedEnvironment: ref(freeze.observedEnvironment), candidateImage: ref(freeze.candidateImage), baselineImage: ref(freeze.baselineImage),
    helpers: Object.fromEntries(Object.entries(freeze.helpers).map(([k, v]) => [k, ref(v)])),
    preparations: Object.fromEntries(Object.entries(freeze.preparations).map(([k, v]) => [k, ref(v)])),
    references: Object.fromEntries(Object.entries(freeze.references).map(([k, v]) => [k, ref(v)])),
  };
}
export function sourceBindingOptions(freeze,role){
  guard(['candidate','baseline'].includes(role),'SOURCE_BINDING_ROLE');
  const prefix=role==='baseline'?'baselineUsageSource':'usageSource';
  const result={};
  for(const suffix of ['BindingFile','BindingSha256','ReviewFile','ReviewSha256']){
    const value=freeze[prefix+suffix];
    guard(typeof value==='string'&&value.length>0,'SOURCE_BINDING_REQUIRED');
    if(suffix.endsWith('Sha256'))assertSha(value);
    result['usageSource'+suffix]=value;
  }
  return result;
}
export async function loadCanonical(freeze) {
  const base = path.join(freeze.harnessDirectory, 'scripts/load/usage');
  const load = rel => import(pathToFileURL(path.join(base, rel)).href);
  const [contracts, campaign, runner, sourceBinding, snapshot, schema, environment, restore] = await Promise.all([
    load('release-gates-v2/contracts.mjs'), load('release-gates-v2/campaign.mjs'), load('release-gates-v2/run.mjs'),
    load('release-gates-v2/usage-source-binding.mjs'), load('roles/snapshot-contract.mjs'), load('release-schema-fingerprint.mjs'), load('release-gates-v2/environment.mjs'), load('roles/restore-snapshot.mjs'),
  ]);
  return { ...contracts, ...campaign, ...runner, ...sourceBinding, ...snapshot, ...schema, ...environment, ...restore };
}

/** Actual OCI blobs and selected local inspect records, all hash-bound. A local image ID is
 * never inferred to be a registry pull digest or silently replaced with the config digest. */
export async function verifyImageImport(record, expected, { root } = {}) {
  guard(record.platform === 'linux/amd64', 'IMAGE_PLATFORM');
  await verifyReference(record.archive, { root, privateMode: true });
  if (expected.archiveSha256) guard(record.archive.sha256 === expected.archiveSha256, 'ORIGINAL_IMAGE_ARCHIVE');
  const [index, manifest, config, inspected, container] = await Promise.all([
    readReference(record.index, { root, privateMode: true }), readReference(record.manifest, { root, privateMode: true }),
    readReference(record.config, { root, privateMode: true }), readReference(record.imageInspect, { root, privateMode: true }),
    readReference(record.containerInspect, { root, privateMode: true }),
  ]);
  const image = Array.isArray(inspected) ? inspected[0] : inspected;
  guard(!Array.isArray(inspected) || inspected.length === 1, 'IMAGE_INSPECT_CARDINALITY');
  guard(image.Id === expected.image && image.Os === 'linux' && image.Architecture === 'amd64', 'IMPORTED_IMAGE_IDENTITY');
  if (image.Descriptor) guard(image.Descriptor.digest === expected.image, 'IMPORTED_INDEX_IDENTITY');
  const descriptor = index.manifests?.find(row => row.platform?.os === 'linux' && row.platform?.architecture === 'amd64');
  guard(descriptor && descriptor.digest === `sha256:${record.manifest.sha256}`, 'OCI_PLATFORM_MANIFEST');
  guard(`sha256:${record.index.sha256}` === expected.image, 'OCI_INDEX_IDENTITY');
  guard(manifest.schemaVersion === 2 && manifest.config?.digest === `sha256:${record.config.sha256}`, 'OCI_CONFIG_DIGEST');
  if (expected.configDigest) guard(manifest.config.digest === expected.configDigest, 'OCI_EXPECTED_CONFIG');
  guard(config.os === 'linux' && config.architecture === 'amd64', 'OCI_CONFIG_PLATFORM');
  guard(Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.length === record.layers?.length, 'OCI_LAYER_SET');
  for (let i = 0; i < record.layers.length; i++) {
    const layer = record.layers[i]; await verifyReference(layer, { root, privateMode: true });
    guard(manifest.layers[i].digest === `sha256:${layer.sha256}` && manifest.layers[i].size === layer.bytes, 'OCI_LAYER_IDENTITY');
  }
  assert.deepEqual(image.RootFS?.Layers, config.rootfs?.diff_ids, 'Imported uncompressed layer identities differ');
  guard(container.Image === (expected.containerImage ?? expected.image) && container.Config?.Image === expected.image, 'CONTAINER_IMAGE_STORE_IDENTITY');
  if (expected.source) guard(config.config?.Labels?.['org.opencontainers.image.revision'] === expected.source && image.Config?.Labels?.['org.opencontainers.image.revision'] === expected.source, 'IMAGE_SOURCE_LABEL');
  return { image: image.Id, indexDigest: `sha256:${record.index.sha256}`, manifestDigest: descriptor.digest, configDigest: manifest.config.digest, archiveSha256: record.archive.sha256 };
}

export function assertFixtureAuthority(rows, { now, through, schoolIds }) {
  guard(Array.isArray(rows) && rows.length === 2, 'FIXTURE_AUTHORITY_SCHOOLS');
  assert.deepEqual(rows.map(row => row.schoolId).sort(), [...schoolIds].sort());
  for (const row of rows) {
    guard(row.otherClients === 0 && Number.isFinite(Date.parse(row.observedAtUtc)) && Math.abs(now - Date.parse(row.observedAtUtc)) <= 600_000, 'FIXTURE_CLIENT_OR_FRESHNESS');
    guard(row.schoolActiveRows === 1 && row.licenseRows === 1 && row.controlRows === 500 && row.teachingRows === 100 && Number.isSafeInteger(row.manualSharedRows) && row.manualSharedRows >= 0 && row.manualSharedRows <= 500, 'FIXTURE_AUTHORITY_ROW_COVERAGE');
    guard(Number.isFinite(Date.parse(row.requiredValidUntil)) && Date.parse(row.requiredValidUntil) >= through, 'FIXTURE_AUTHORITY_BOUNDARY');
    for (const key of ['schoolExpiries', 'licenseExpiries', 'controlExpiries', 'teachingExpiries', 'manualSessionExpiries']) guard(row[key] === 0, 'FIXTURE_AUTHORITY_HORIZON');
    for (const key of ['schoolActiveUntil', 'licenseExpiresAt', 'controlHardExpiry', 'teachingScheduledEnd', 'manualSharedLeaseUntil']) {
      // NULL means unlimited for the actual school/license/teaching SQL predicate.
      // Controls always expire; an existing manual-shared session must have a lease.
      const nullable = !['controlHardExpiry'].includes(key) && (key !== 'manualSharedLeaseUntil' || row.manualSharedRows === 0);
      guard(row[key] === null ? nullable : Number.isFinite(Date.parse(row[key])) && Date.parse(row[key]) > through, 'FIXTURE_AUTHORITY_HORIZON');
    }
  }
}
export function assertNativeFixtureFacts(proof, binding, snapshot, { now, through }) {
  guard(proof.source === binding.source && proof.snapshotManifestSha256 === snapshot.manifestSha256, 'NATIVE_FIXTURE_BINDING');
  assert.deepEqual(proof.migrations, binding.expectedMigrations);
  assert.deepEqual(proof.catalog.map(row => row.relname).sort(), binding.rlsTables);
  guard(proof.catalog.every(row => row.relrowsecurity === true && row.relforcerowsecurity === true && row.tenantPolicy === true), 'NATIVE_RLS_INCOMPLETE');
  guard(proof.restrictedRole.rolsuper === false && proof.restrictedRole.rolbypassrls === false && proof.restrictedRole.rolinherit === false, 'NATIVE_ROLE_UNRESTRICTED');
  guard(proof.restrictedRole.currentUser === proof.restrictedRole.expectedUser && typeof proof.restrictedRole.currentUser === 'string' && proof.restrictedRole.currentUser.length > 0, 'NATIVE_ROLE_IDENTITY');
  guard(proof.schoolCounts?.length === 2 && proof.schoolCounts.every(row => row.observations === 1_000_001) && proof.heartbeatRows === 2_000_002, 'NATIVE_FIXTURE_COUNTS');
  assert.deepEqual(proof.schoolCounts.map(row => row.schoolId).sort(), snapshot.data['cold-fixture-state.json'].schools.map(row => row.id).sort());
  guard(proof.encoding === 'UTF8' && proof.timezone === 'UTC' && proof.serverVersion === '16.15', 'NATIVE_DATABASE_RUNTIME');
  assertFixtureAuthority(proof.authority, { now, through, schoolIds: proof.schoolCounts.map(row => row.schoolId) });
}
export async function verifyNativeFixture(request, canonical, envelope, freeze, { now, through }) {
  const directory = safePath(request.directory, { directory: true, privateMode: true });
  const snapshot = canonical.loadSnapshot(directory, assertSha(request.manifestSha256), { source: SOURCES.candidate, today: schoolDate(now), usageSourceBinding: envelope });
  guard(snapshot.manifest.pgImage === freeze.postgresImage, 'FIXTURE_POSTGRES_IDENTITY');
  const proof = await readReference(request.nativeProof, { privateMode: true });
  guard(proof.schemaVersion === 1 && proof.kind === 'usage_linux_native_fixture_proof', 'NATIVE_FIXTURE_SCHEMA');
  await verifyReview(request.independentReview, request.nativeProof.sha256, 'usage_linux_native_fixture_review');
  // These raw query-result files must equal the claimed facts. Independent review pins the SQL/custody producer.
  for (const key of ['migrations', 'catalog', 'restrictedRole', 'schoolCounts', 'authority', 'runtime']) {
    const actual = await readReference(proof.rawResults?.[key], { privateMode: true }); assert.deepEqual(actual, proof[key]);
  }
  assert.deepEqual(proof.runtime, { encoding: proof.encoding, timezone: proof.timezone, serverVersion: proof.serverVersion });
  assertNativeFixtureFacts(proof, envelope.binding, snapshot, { now, through });
  const sql = await verifyReference(proof.nativeSchema, { privateMode: true });
  const referenceSql = await verifyReference(proof.nativeReferenceSchema, { privateMode: true });
  const referenceInput = snapshot.manifest.records.find(row => row.file === 'post-convergence-schema.sql');
  guard(proof.nativeReferenceInputSha256 === referenceInput.sha256, 'FIXTURE_REFERENCE_INPUT');
  guard(canonical.canonicalSchemaFingerprint(readFileSync(path.join(directory, referenceInput.file), 'utf8')) === envelope.binding.canonicalSourceSchemaSha256, 'FIXTURE_REFERENCE_INPUT_SCHEMA');
  // A parser-rendered schema may group CHECK expressions differently. Use b938's
  // full normalized native reference model, never a candidate receipt relabeled as A.
  const comparison = canonical.compareNativeSchemas(readFileSync(freeze.schemaFile, 'utf8'), readFileSync(referenceSql, 'utf8'), readFileSync(sql, 'utf8'));
  guard(comparison.originalCanonicalSha256 === envelope.binding.canonicalSourceSchemaSha256, 'FIXTURE_NATIVE_SCHEMA');
  guard(proof.cleanup?.containers?.length > 0 && proof.cleanup.containers.every(row => row.exitCode === 0 && row.oomKilled === false && row.forced === false && row.confirmedAbsent === true), 'NATIVE_FIXTURE_CLEANUP');
  const inventory = await readReference(proof.cleanup.rawInventory, { privateMode: true });
  guard(Array.isArray(inventory.containers) && Array.isArray(inventory.volumes), 'NATIVE_CLEANUP_INVENTORY');
  for (const row of proof.cleanup.containers) guard(!inventory.containers.some(actual => actual.id === row.id || actual.name === row.name), 'NATIVE_FIXTURE_CONTAINER_PRESENT');
  guard(Array.isArray(proof.cleanup.volumes) && proof.cleanup.volumes.length > 0, 'NATIVE_CLEANUP_VOLUME_PROOF');
  for (const row of proof.cleanup.volumes) guard(row.confirmedAbsent === true && row.forced === false && !inventory.volumes.includes(row.name), 'NATIVE_FIXTURE_VOLUME_PRESENT');
  return { snapshot, nativeProofSha256: request.nativeProof.sha256 };
}

/** Review is a pinned, separately produced decision about exact request bytes, not a boolean supplied by execution. */
export async function verifyReview(ref, subjectSha256, kind) {
  const review = await readReference(ref, { privateMode: true });
  guard(review.schemaVersion === 1 && review.kind === kind && review.subjectSha256 === subjectSha256 && review.disposition === 'reviewed_for_synthetic_execution', 'INDEPENDENT_REVIEW_BINDING');
  guard(typeof review.reviewer === 'string' && review.reviewer.trim() && Number.isFinite(Date.parse(review.reviewedAtUtc)), 'INDEPENDENT_REVIEW_IDENTITY');
  guard(review.capacityAccepted === false && review.productionReadiness === false && review.operationalAuthorization === false, 'REVIEW_SCOPE');
  return review;
}

export async function verifyFrozenInputs(request, { platform = process.platform, uid = process.getuid?.(), canonicalLoader = loadCanonical } = {}) {
  guard(platform === 'linux' && uid === 1000, 'LINUX_UID_1000_REQUIRED');
  guard(/^unix:\/\/\/[^\s?#]+$/.test(request.endpoint) && !request.endpoint.slice(7).split('/').includes('..'), 'LOCAL_UNIX_DOCKER_REQUIRED');
  const relocation = await verifyRelocation(request.relocation);
  guard(request.freeze.sha256 === FREEZE_SHA256, 'WRONG_FREEZE');
  const original = await readReference(request.freeze, { root: relocation.inputRoot, privateMode: true });
  guard(original.applicationSource === SOURCES.candidate && original.baselineSource === SOURCES.baseline && original.harnessSource === SOURCES.harness, 'FROZEN_SOURCE_SEQUENCE');
  verifyHistoricalReferences(original, relocation); const freeze = resolveFreeze(original, relocation);
  const archivesRef = original.references['complete-source-archives.json']; guard(archivesRef, 'COMPLETE_SOURCE_ARCHIVES_REQUIRED');
  const archives = await readReference(relocation.ref(archivesRef), { privateMode: true });
  const checkouts = {}, restoration = await loadSourceRestoration(request.sourceRestoration, { outputRoot: request.sourceRestoration?.outputRoot });
  for (const [key, directory, source] of [['source', freeze.sourceDirectory, SOURCES.candidate], ['baseline-source', freeze.baselineSourceDirectory, SOURCES.baseline], ['harness-source', freeze.harnessDirectory, SOURCES.harness]]) {
    const record = archives.archives[key]; guard(record.source === source, 'SOURCE_ARCHIVE_IDENTITY');
    const role = restoration.roleFor(key);
    guard(directory === restoration.receipt.roles[role].path, 'SOURCE_RESTORATION_DIRECTORY');
    relocation.resolve(record.path, record.sha256);
    checkouts[key] = await verifyCheckout(directory, record, { restoration, role, git: args => restoration.git(directory, args) });
  }
  for (const [file, sha] of Object.entries(original.harnessFiles)) guard(checkouts['harness-source'][file] === sha, 'HARNESS_FILE_DRIFT');
  const canonical = await canonicalLoader(freeze);
  for (const [key, record] of Object.entries(original.profiles)) guard(canonical.profileHash(canonical.PROFILES[key]) === record.sha256, 'CANONICAL_PROFILE_DRIFT');
  const envelope = canonical.loadUsageSourceBinding(sourceBindingOptions(freeze,'candidate'), { required: true });
  const baselineEnvelope = canonical.loadUsageSourceBinding(sourceBindingOptions(freeze,'baseline'), { required: true });
  canonical.assertUsageSourceCheckout(envelope, freeze.sourceDirectory);
  canonical.assertUsageSourceCheckout(baselineEnvelope, freeze.baselineSourceDirectory);
  for(const selected of [envelope,baselineEnvelope])
    guard(selected.binding.migrationStage === 'expand' && selected.binding.expectedMigrations.length === freeze.expectedLedgerEntries && selected.binding.rlsTables.length === 129, 'FROZEN_EXPAND_ADMISSION');
  const schemas = [
    [freeze.schemaFile, freeze.references['schema/lineage/schema-receipt.json'], SOURCES.candidate, envelope],
    [freeze.baselineSchema.file, freeze.baselineSchema.receipt, SOURCES.baseline, baselineEnvelope],
  ];
  for (const [file, receiptRef, source, selected] of schemas) {
    const receipt = await readReference(receiptRef, { privateMode: true });
    guard(receipt.source === source && receipt.schemaSha256 === await hashFile(file), 'SCHEMA_RAW_BINDING');
    guard(canonical.canonicalSchemaFingerprint(readFileSync(file, 'utf8')) === selected.binding.canonicalSourceSchemaSha256, 'SCHEMA_CANONICAL_BINDING');
    canonical.assertUsageSourceIdentity(selected,{source,schemaInputSha256:receipt.schemaSha256});
    assert.deepEqual(receipt.migrations, selected.binding.expectedMigrations); assert.deepEqual([...receipt.rlsTables].sort(), selected.binding.rlsTables);
  }
  const imageExpected = {};
  for (const key of ['candidate', 'baseline']) { const binding = await readReference(freeze[`${key}Image`], { privateMode: true });
    const selected=key==='baseline'?baselineEnvelope:envelope;
    canonical.assertUsageSourceIdentity(selected,{source:SOURCES[key],applicationImage:binding.image});
    guard(binding.verified===true&&binding.source===SOURCES[key]&&selected.binding.imageBindingSha256===freeze[`${key}Image`].sha256,'APPLICATION_SOURCE_BINDING');
    imageExpected[key] = { image: binding.image, source: binding.source, configDigest: binding.configDigest, archiveSha256: binding.archive?.sha256 }; }
  for (const key of ['candidate', 'baseline', 'distinct']) {
    const helper = await readReference(freeze.helpers[key], { privateMode: true }), prep = await readReference(freeze.preparations[key], { privateMode: true });
    guard(helper.preparationSha256 === freeze.preparations[key].sha256 && helper.applicationSource === (key === 'baseline' ? SOURCES.baseline : SOURCES.candidate), 'HELPER_BINDING');
    guard(prep.harnessSource === SOURCES.harness && prep.applicationSource === helper.applicationSource && prep.applicationImage === helper.applicationImage, 'HELPER_PREPARATION');
    const applicationKey=key==='baseline'?'baseline':'candidate';
    guard(helper.applicationImage===imageExpected[applicationKey].image&&prep.imageBindingSha256===freeze[`${applicationKey}Image`].sha256,'HELPER_APPLICATION_BINDING');
    assert.deepEqual(prep.canonicalFiles, original.harnessFiles);
    assert.deepEqual(prep.usageSourceBinding, key === 'baseline' ? baselineEnvelope : envelope);
    imageExpected[`${key}Helper`] = { image: helper.helperImage, containerImage: helper.helperContainerImage, source: helper.applicationSource };
  }
  imageExpected.postgres = { image: original.postgresImage }; imageExpected.redis = { image: original.redisImage };
  assert.deepEqual(Object.keys(request.imageImports).sort(), Object.keys(imageExpected).sort());
  const images = {};
  for (const [key, expected] of Object.entries(imageExpected)) images[key] = await verifyImageImport(request.imageImports[key], expected, { root: relocation.inputRoot });
  return { freeze, originalFreeze: original, relocation, canonical, envelope, baselineEnvelope, images, checkouts };
}
export async function verifyPreflight(request, { now = Date.now(), ...options } = {}) {
  guard(request.schemaVersion === 1 && request.kind === 'usage_linux_preflight_request', 'PREFLIGHT_SCHEMA');
  const context = await verifyFrozenInputs(request, options);
  const { freeze, relocation, canonical, envelope, checkouts } = context;
  const quiet = await readReference(request.quietWindow, { privateMode: true }), window = assertWindow(quiet, now);
  const host = await readReference(request.hostRuntime, { privateMode: true });
  assertFreshCapture(host, now); guard(host.platform === 'linux' && host.arch === 'x64' && host.uid === 1000 && host.endpoint === request.endpoint && host.harnessSource === SOURCES.harness, 'HOST_RUNTIME_IDENTITY');
  guard(host.nodeExecutableSha256 === await hashFile(process.execPath) && host.nodeVersion === process.version, 'HOST_NODE_IDENTITY');
  guard(host.dependencies?.packageLockSha256 === checkouts['harness-source']['package-lock.json'] && host.dependencies.npmCiExitCode === 0, 'LOCKED_LINUX_DEPENDENCIES');
  guard(Array.isArray(host.references) && host.references.length > 0, 'HOST_RUNTIME_RAW_PROOFS_REQUIRED');
  for (const ref of host.references) await verifyReference(ref, { privateMode: true });
  const readiness = await readReference(request.readiness, { privateMode: true });
  guard(readiness.kind === 'usage_linux_measurement_readiness' && readiness.freezeSha256 === FREEZE_SHA256 && readiness.relocationSha256 === request.relocation.sha256 && readiness.endpoint === request.endpoint, 'READINESS_INPUT_BINDING');
  guard(readiness.preparationActivityStopped === true && readiness.productionUsageMode === 'off/off' && readiness.originalThresholdsUnchanged === true && readiness.recoveryReleaseBlockerPreserved === true, 'READINESS_SCOPE');
  for (const key of ['sourceCapture', 'productionCapture']) { const capture = await readReference(readiness[key], { privateMode: true }); assertFreshCapture(capture, now); }
  for (const key of ['isolationProof', 'durabilityProof', 'custodyProof', 'costDeadline', 'failedRecoveryPack']) await verifyReference(readiness[key], { privateMode: true });
  // Exact facts of these externally owned demonstrations require their separate pinned independent review.
  await verifyReview(request.independentReadinessReview, request.readiness.sha256, 'usage_linux_readiness_review');
  await verifyReview(request.independentImportReview, request.relocation.sha256, 'usage_linux_import_review');
  const fixture = await verifyNativeFixture(request.fixture, canonical, envelope, freeze, { now, through: window.end });
  return { ...context, quiet, readiness, fixture, verifiedAt: new Date(now).toISOString() };
}
if (isMain(import.meta.url)) {
  try {
    const { request, requestRef } = await readCliRequest('verify', 'usage_linux_preflight_request');
    const result = await verifyPreflight(request);
    writeNewJson(request.outputFile, { schemaVersion: 1, kind: 'usage_linux_preflight_verification', requestSha256: requestRef.sha256,
      freezeSha256: FREEZE_SHA256, relocationSha256: request.relocation.sha256, snapshotManifestSha256: result.fixture.snapshot.manifestSha256,
      verifiedAt: result.verifiedAt, capacityAccepted: false, productionReadiness: false, operationalAuthorization: false }, request.outputRoot);
    process.stdout.write(JSON.stringify({ passed: true, outputSha256: await hashFile(request.outputFile), capacityAccepted: false }) + '\n');
  } catch (error) { cliFailure(error); }
}
