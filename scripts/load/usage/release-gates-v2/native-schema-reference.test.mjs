import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { hash, PROFILES, profileHash } from './contracts.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';
import { bootstrapHealthOperationalFixture, verifyOperationalFixtureCustody, HEALTH_SENTINEL_DDL } from './operational-fixture.mjs';

// Synthetic protocol tests. Actual PostgreSQL BETWEEN parsing is additionally
// exercised by the retained native fixture proof, never simulated as acceptance.
const input = Buffer.from('CREATE TABLE public.example (ordinal integer, CHECK (ordinal BETWEEN 0 AND 49 AND ordinal > -1));\n');
const rendered = 'CREATE TABLE public.example (ordinal integer, CHECK (ordinal >= 0 AND ordinal <= 49 AND ordinal > -1));\n';
function reviewedSource(bytes) {
  const registry = JSON.parse(readFileSync(new URL('../../../../src/config/rlsRegistry.json', import.meta.url)));
  const expectedMigrations = [{ id: 'synthetic-expand', checksum: 'e'.repeat(64), status: 'complete' }];
  const binding = { schemaVersion: 1, kind: 'usage_final_source_binding', status: 'prepared_not_approved', source: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    applicationImage: 'sha256:' + 'c'.repeat(64), imageBindingSha256: 'd'.repeat(64), sourceInputsSha256: 'e'.repeat(64),
    schemaInputSha256: hash(bytes), canonicalSourceSchemaSha256: canonicalSchemaFingerprint(bytes.toString('utf8')), registrySha256: 'f'.repeat(64),
    migrationManifestSha256: hash(JSON.stringify(expectedMigrations)), migrationStage: 'expand', expectedMigrations,
    rlsInventory: 'classpilotPrivateChatLifecyclePostExpand', rlsTables: [...registry.inventories.classpilotPrivateChatLifecyclePostExpand.tables].sort(),
    profiles: Object.fromEntries(['usage', 'usageDistinct', 'broader', 'broaderConcentrated'].map(key => [key, profileHash(PROFILES[key])])),
    capacityAccepted: false, productionReadiness: false, operationalAuthorization: false };
  const bindingRaw = JSON.stringify(binding), bindingSha256 = hash(bindingRaw);
  const review = { schemaVersion: 1, kind: 'usage_final_source_binding_review', source: binding.source, bindingSha256,
    disposition: 'reviewed_for_synthetic_execution', reviewer: 'synthetic-protocol-test-only', reviewedAtUtc: '2026-10-11T12:00:00Z', operationalAuthorization: false, capacityAccepted: false };
  const reviewRaw = JSON.stringify(review);
  return { binding, bindingRaw, bindingSha256, review, reviewRaw, reviewSha256: hash(reviewRaw) };
}
const privileges = { present: true, superuser: false, bypassRls: false, schemaCreate: false, ownsTable: false, ownerMembership: false,
  select: true, insert: true, delete: true, update: false, truncate: false, references: false, trigger: false, sequenceUsage: true, sequenceSelect: false, sequenceUpdate: false };
function fixture(t, { actual = rendered, reference = rendered, source = input, bound = true, present = false, failRestore = false, failDrop = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'usage-native-reference-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); assert.ok(basename(root).startsWith('usage-native-reference-')); rmSync(root, { recursive: true }); });
  const envelope = reviewedSource(source), sourceCanonical = canonicalSchemaFingerprint(source.toString('utf8'));
  const options = { containerId: '1'.repeat(64), owner: 'fixture_owner', database: 'fixture_database', appRole: 'fixture_app', outputDirectory: root,
    source: envelope.binding.source, schemaInputSha256: hash(source), canonicalSourceSchemaSha256: sourceCanonical,
    ...(bound ? { usageSourceBinding: envelope, nativeSchemaSource: source } : {}) };
  const metrics = { source: options.source, schemaInputSha256: hash(source), schemaSha256: sourceCanonical, snapshotManifestSha256: null,
    ...(bound ? { usageSourceBinding: envelope } : {}) };
  const calls = []; let actualDumps = 0;
  const docker = async (args, data) => {
    calls.push({ args, input: data?.input }); assert.equal(args[0], 'exec'); assert.ok(args.includes(options.containerId));
    if (args.includes('dropdb') && failDrop) throw Error('NATIVE_REFERENCE_DROP_FAILED');
    if (args.includes('createdb') || args.includes('dropdb')) return '';
    if (args.includes('pg_dump')) {
      if (args.some(arg => arg.startsWith('usage_schema_reference_'))) return reference;
      return actualDumps++ === 0 ? actual : actual + (present ? '' : HEALTH_SENTINEL_DDL);
    }
    assert.ok(args.includes('psql'));
    if (args.some(arg => arg.startsWith('usage_schema_reference_'))) {
      assert.deepEqual(data.input, source); if (failRestore) throw Error('NATIVE_REFERENCE_RESTORE_FAILED'); return '';
    }
    if (args.includes('-c')) return JSON.stringify({ present });
    assert.match(data.input, /CREATE TABLE IF NOT EXISTS public\._health_sentinel/); return JSON.stringify(privileges);
  };
  return { root, options, metrics, calls, docker };
}
test('reviewed schema uses complete native reference identity while retaining exact input identity and custody', async t => {
  const f = fixture(t); assert.notEqual(canonicalSchemaFingerprint(input.toString('utf8')), canonicalSchemaFingerprint(rendered));
  const receipt = await bootstrapHealthOperationalFixture(f.options, f.docker);
  assert.equal(receipt.canonicalSourceSchemaSha256, f.metrics.schemaSha256);
  assert.equal(receipt.beforeCanonicalSha256, canonicalSchemaFingerprint(rendered));
  assert.equal(receipt.nativeSchemaReference.comparison.originalSha256, hash(input));
  assert.equal(receipt.nativeSchemaReference.dropped, true);
  assert.deepEqual(verifyOperationalFixtureCustody(f.root, f.metrics), receipt);
  writeFileSync(join(f.root, 'operational-schema-reference.sql'), rendered.replace('<= 49', '<= 50'));
  assert.throws(() => verifyOperationalFixtureCustody(f.root, f.metrics), /native-rendered schema|fingerprints/);
});
test('actual constraint drift is refused before operational DDL, and the owned reference is dropped', async t => {
  const f = fixture(t, { actual: rendered.replace('<= 49', '<= 50') });
  await assert.rejects(bootstrapHealthOperationalFixture(f.options, f.docker), /native-rendered schema/);
  assert.equal(f.calls.filter(call => call.args.includes('dropdb')).length, 1);
  assert.equal(f.calls.some(call => typeof call.input === 'string' && call.input.includes(HEALTH_SENTINEL_DDL)), false);
});
test('native reference restore failure still drops only its generated database', async t => {
  const f = fixture(t, { failRestore: true }); await assert.rejects(bootstrapHealthOperationalFixture(f.options, f.docker), /NATIVE_REFERENCE_RESTORE_FAILED/);
  const create = f.calls.find(call => call.args.includes('createdb')), drop = f.calls.find(call => call.args.includes('dropdb'));
  assert.equal(create.args.at(-1), drop.args.at(-1)); assert.match(drop.args.at(-1), /^usage_schema_reference_[a-f0-9]{12}$/);
});
test('reference cleanup failure refuses health DDL and cannot emit a successful bootstrap receipt', async t => {
  const f = fixture(t, { failDrop: true });
  await assert.rejects(bootstrapHealthOperationalFixture(f.options, f.docker), /NATIVE_REFERENCE_DROP_FAILED/);
  assert.equal(f.calls.filter(call => call.args.includes('dropdb')).length, 1);
  assert.equal(f.calls.some(call => typeof call.input === 'string' && call.input.includes(HEALTH_SENTINEL_DDL)), false);
  assert.equal(existsSync(join(f.root, 'operational-fixture-bootstrap.json')), false);
});
test('unbound historical path still rejects parser representation differences and never creates a reference', async t => {
  const f = fixture(t, { bound: false }); await assert.rejects(bootstrapHealthOperationalFixture(f.options, f.docker), /Actual pre-bootstrap schema differs/);
  assert.equal(f.calls.some(call => call.args.includes('createdb')), false);
});
test('new path requires matching reviewed bytes, source and review hash before reference creation', async t => {
  for (const change of [options => { delete options.usageSourceBinding; }, options => { delete options.nativeSchemaSource; },
    options => { options.nativeSchemaSource = Buffer.from('ALTER TABLE public.example DROP CONSTRAINT example_check;'); },
    options => { options.usageSourceBinding.reviewSha256 = '0'.repeat(64); }, options => { options.source = '0'.repeat(40); }]) {
    const f = fixture(t); change(f.options); await assert.rejects(bootstrapHealthOperationalFixture(f.options, f.docker));
    assert.equal(f.calls.some(call => call.args.includes('createdb')), false);
  }
});
test('existing health relation compares native before and after without relabeling the source input', async t => {
  const f = fixture(t, { present: true }); const receipt = await bootstrapHealthOperationalFixture(f.options, f.docker);
  assert.equal(receipt.createdOperationalRelation, false); assert.equal(receipt.beforeCanonicalSha256, receipt.afterCanonicalSha256);
  assert.equal(verifyOperationalFixtureCustody(f.root, f.metrics).canonicalMigrationSchemaRelabeled, false);
  const changed = structuredClone(f.metrics); delete changed.usageSourceBinding; assert.throws(() => verifyOperationalFixtureCustody(f.root, changed));
});
