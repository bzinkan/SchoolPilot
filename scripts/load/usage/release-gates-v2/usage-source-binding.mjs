import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PROFILES, profileHash, hash } from './contracts.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';

export const HISTORICAL_USAGE_SOURCE = 'ddc5996b3b8645859fa51a9613486db52c481b7f';
const sha = value => assert.match(value, /^[a-f0-9]{64}$/);
const digest = value => hash(JSON.stringify(value));
const profileBindings = () => Object.fromEntries(['usage', 'usageDistinct', 'broader', 'broaderConcentrated'].map(key => [key, profileHash(PROFILES[key])]));
export function assertExpectedUsageLedger(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['checksum', 'id', 'status']);
    assert.match(row.id, /^[a-zA-Z0-9._:-]{1,160}$/); sha(row.checksum); assert.equal(row.status, 'complete');
  }
  assert.deepEqual(rows.map(row => row.id), rows.map(row => row.id).sort());
  return rows;
}
export function assertUsageSourceBinding(binding) {
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.kind, 'usage_final_source_binding');
  assert.equal(binding.status, 'prepared_not_approved');
  for (const key of ['capacityAccepted', 'productionReadiness', 'operationalAuthorization']) assert.equal(binding[key], false);
  assert.match(binding.source, /^[a-f0-9]{40}$/); assert.match(binding.sourceTree, /^[a-f0-9]{40}$/);
  assert.match(binding.applicationImage, /^(?:sha256:|[a-zA-Z0-9./:_-]+@sha256:)[a-f0-9]{64}$/);
  for (const key of ['imageBindingSha256', 'sourceInputsSha256', 'schemaInputSha256', 'canonicalSourceSchemaSha256', 'registrySha256', 'migrationManifestSha256']) sha(binding[key]);
  assert.ok(['expand', 'contract'].includes(binding.migrationStage));
  assertExpectedUsageLedger(binding.expectedMigrations);
  assert.equal(binding.migrationManifestSha256, digest(binding.expectedMigrations));
  assert.equal(binding.rlsInventory, 'classpilotPrivateChatLifecyclePostExpand');
  assert.ok(Array.isArray(binding.rlsTables) && binding.rlsTables.length === 129);
  assert.deepEqual(binding.rlsTables, [...new Set(binding.rlsTables)].sort());
  assert.ok(binding.rlsTables.includes('classpilot_usage_rollups') && binding.rlsTables.includes('classpilot_usage_rollup_days'));
  assert.deepEqual(binding.profiles, profileBindings());
  return binding;
}
export function assertReviewedUsageSource(envelope) {
  assertUsageSourceBinding(envelope.binding); sha(envelope.bindingSha256); sha(envelope.reviewSha256);
  assert.equal(envelope.bindingSha256, hash(envelope.bindingRaw));
  assert.deepEqual(JSON.parse(envelope.bindingRaw), envelope.binding);
  assert.equal(envelope.reviewSha256, hash(envelope.reviewRaw));
  assert.deepEqual(JSON.parse(envelope.reviewRaw), envelope.review);
  const review = envelope.review;
  assert.equal(review.schemaVersion, 1); assert.equal(review.kind, 'usage_final_source_binding_review');
  assert.equal(review.bindingSha256, envelope.bindingSha256); assert.equal(review.source, envelope.binding.source);
  assert.equal(review.disposition, 'reviewed_for_synthetic_execution');
  assert.ok(typeof review.reviewer === 'string' && review.reviewer.trim().length > 0);
  assert.ok(Number.isFinite(Date.parse(review.reviewedAtUtc)));
  assert.equal(review.operationalAuthorization, false); assert.equal(review.capacityAccepted, false);
  return envelope;
}
export function loadUsageSourceBinding(options, { required = false } = {}) {
  const keys = ['usageSourceBindingFile', 'usageSourceBindingSha256', 'usageSourceReviewFile', 'usageSourceReviewSha256'];
  if (keys.every(key => options[key] === undefined)) { assert.equal(required, false, 'Final-source Usage requires its reviewed source/ledger binding'); return null; }
  for (const key of keys) assert.ok(typeof options[key] === 'string' && options[key].length > 0, key);
  const bindingRaw = readFileSync(options.usageSourceBindingFile, 'utf8'), reviewRaw = readFileSync(options.usageSourceReviewFile, 'utf8');
  return assertReviewedUsageSource({ binding: JSON.parse(bindingRaw), bindingRaw, bindingSha256: options.usageSourceBindingSha256,
    review: JSON.parse(reviewRaw), reviewRaw, reviewSha256: options.usageSourceReviewSha256 });
}
export function assertUsageSourceIdentity(envelope, { source, applicationImage, schemaInputSha256, canonicalSourceSchemaSha256 }) {
  assertReviewedUsageSource(envelope); const binding = envelope.binding;
  for (const [key, expected] of Object.entries({ source, applicationImage, schemaInputSha256, canonicalSourceSchemaSha256 })) if (expected !== undefined) assert.equal(binding[key], expected, key);
  return binding;
}
export function assertUsageSourceDatabase(envelope, { migrations, tables, registrySha256 }) {
  const binding = assertReviewedUsageSource(envelope).binding;
  assert.deepEqual(migrations, binding.expectedMigrations, 'Full migration ledger differs from the reviewed source/stage');
  assert.deepEqual([...tables].sort(), binding.rlsTables, 'RLS admission differs from the reviewed source');
  if (registrySha256 !== undefined) assert.equal(registrySha256, binding.registrySha256);
  return binding;
}
export function loadFixtureUsageSourceBinding(env) {
  if(env.USAGE_SCALE_SOURCE_BINDING_FILE===undefined)return null;
  const envelope=assertReviewedUsageSource(JSON.parse(readFileSync(env.USAGE_SCALE_SOURCE_BINDING_FILE,'utf8')));
  assertUsageSourceIdentity(envelope,{source:env.USAGE_SOURCE_REVISION});
  assert.equal(env.APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS,envelope.binding.migrationStage==='contract'?'true':'false');
  return envelope;
}
export function assertUsageSourceReceipt(root, metrics) {
  const path = join(root, 'usage-source-binding.json');
  if (!metrics.usageSourceBinding) { assert.equal(existsSync(path), false, 'Unclaimed source binding'); return null; }
  const envelope = assertReviewedUsageSource(JSON.parse(readFileSync(path, 'utf8')));
  assert.deepEqual(envelope, metrics.usageSourceBinding);
  assertUsageSourceIdentity(envelope, { source: metrics.source, applicationImage: metrics.applicationImage,
    schemaInputSha256: metrics.schemaInputSha256 ?? undefined, canonicalSourceSchemaSha256: metrics.schemaSha256 });
  if (metrics.databasePreparation?.migrations) assertUsageSourceDatabase(envelope, { migrations: metrics.databasePreparation.migrations,
    tables: metrics.databasePreparation.catalog.map(row => row.relname), registrySha256: metrics.databasePreparation.registrySha256 });
  return envelope;
}

function sourceFacts(sourceDirectory, source, migrationStage, rlsInventory) {
  const root = realpathSync(sourceDirectory);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 ** 2 }).trim();
  assert.equal(git(['status', '--porcelain']), '', 'Freeze and commit source before binding');
  assert.equal(git(['rev-parse', 'HEAD']), source);
  assert.ok(['expand', 'contract'].includes(migrationStage));
  const registryRaw = readFileSync(join(root, 'src/config/rlsRegistry.json')), registry = JSON.parse(registryRaw);
  const inventory = registry.inventories[rlsInventory]; assert.ok(inventory && Array.isArray(inventory.tables));
  for (const table of registry.inventories.classpilotPrivateChatLifecyclePostExpand.tables) assert.ok(inventory.tables.includes(table));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/DATABASE|^PG|^NODE_OPTIONS$|^DOTENV/.test(key)) delete environment[key];
  environment.DOTENV_CONFIG_PATH = join(root, '.usage-binding-no-dotenv'); environment.DOTENV_CONFIG_QUIET = 'true';
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const manifest = pathToFileURL(join(root, 'src/db/migrations27.ts')).href;
  const program = `const m=await import(${JSON.stringify(manifest)});const rows=m.${migrationStage === 'expand' ? 'schoolPilot27ExpandMigrations' : 'schoolPilot27Migrations'};process.stdout.write(JSON.stringify(rows.map(({id,checksum})=>({id,checksum,status:'complete'})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)));`;
  const expectedMigrations = assertExpectedUsageLedger(JSON.parse(execFileSync(process.execPath, ['--import', loader, '--input-type=module', '-e', program], {
    cwd: root, env: environment, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 ** 2 })));
  const files = git(['ls-files', 'src', 'package.json', 'package-lock.json', 'Dockerfile', 'tsconfig.json']).split('\n').filter(Boolean).sort();
  const facts = { sourceTree: git(['rev-parse', 'HEAD^{tree}']),
    sourceInputsSha256: digest(Object.fromEntries(files.map(path => [path, hash(readFileSync(join(root, path)))]))),
    registrySha256: hash(registryRaw), rlsTables: [...inventory.tables].sort(), expectedMigrations,
    migrationManifestSha256: digest(expectedMigrations) };
  assert.equal(git(['status', '--porcelain']), ''); assert.equal(git(['rev-parse', 'HEAD']), source);
  return facts;
}

// Re-derive every source-dependent field before execution; a self-consistent
// rewritten binding/review cannot substitute a different declarative ledger.
export function assertUsageSourceCheckout(envelope, sourceDirectory) {
  const binding = assertReviewedUsageSource(envelope).binding;
  const actual = sourceFacts(sourceDirectory, binding.source, binding.migrationStage, binding.rlsInventory);
  for (const [key, value] of Object.entries(actual)) assert.deepEqual(binding[key], value, key);
  return binding;
}

// This reads a clean source's declarative migration manifest. It never calls
// apply(), opens a database, builds an image, or creates an acceptance receipt.
export function prepareUsageSourceBinding(options) {
  const facts = sourceFacts(options.sourceDirectory, options.source, options.migrationStage, options.rlsInventory);
  const imageRaw = readFileSync(options.imageBindingFile); assert.equal(hash(imageRaw), options.imageBindingSha256);
  const image = JSON.parse(imageRaw); assert.equal(image.verified, true); assert.equal(image.source, options.source); assert.equal(image.image, options.applicationImage);
  const schema = readFileSync(options.schemaFile); assert.equal(hash(schema), options.schemaSha256);
  const binding = assertUsageSourceBinding({ schemaVersion: 1, kind: 'usage_final_source_binding', status: 'prepared_not_approved',
    source: options.source, applicationImage: options.applicationImage, imageBindingSha256: options.imageBindingSha256,
    schemaInputSha256: options.schemaSha256, canonicalSourceSchemaSha256: canonicalSchemaFingerprint(schema.toString('utf8')),
    rlsInventory: options.rlsInventory, migrationStage: options.migrationStage, ...facts,
    profiles: profileBindings(), capacityAccepted: false, productionReadiness: false, operationalAuthorization: false });
  return binding;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    if (process.argv[2] === 'prepare') {
      const binding = prepareUsageSourceBinding(options), path = resolve(options.outputFile), rel = relative(realpathSync(options.sourceDirectory), path);
      assert.ok(isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\'), 'Binding must be outside source');
      writeFileSync(path, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(JSON.stringify({ path, bindingSha256: hash(readFileSync(path)), status: binding.status, capacityAccepted: false }) + '\n');
    } else { assert.ok(['validate','fixture'].includes(process.argv[2])); const envelope=loadUsageSourceBinding(options, { required: true });
      assertUsageSourceCheckout(envelope,options.sourceDirectory); process.stdout.write(process.argv[2]==='fixture'?JSON.stringify(envelope)+'\n':'USAGE_SOURCE_BINDING_VALIDATED_NOT_ACCEPTED\n'); }
  } catch { process.stderr.write('USAGE_SOURCE_BINDING_FAILED\n'); process.exitCode = 1; }
}
