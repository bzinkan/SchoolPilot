import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HEALTH_SENTINEL_DDL, verifyOperationalFixtureCustody } from './operational-fixture.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';
import { hash } from './contracts.mjs';

function fixture(t) {
  const owned = mkdtempSync(join(tmpdir(), 'schoolpilot-operational-custody-')), root = join(owned, 'receipt'); mkdirSync(root);
  t.after(() => { assert.equal(dirname(owned), resolve(tmpdir())); assert.ok(basename(owned).startsWith('schoolpilot-operational-custody-')); rmSync(owned, { recursive: true }); });
  const before = 'CREATE TABLE public.example(id text);\n', after = before + HEALTH_SENTINEL_DDL;
  const metrics = { source: 'a'.repeat(40), schemaInputSha256: hash(before), schemaSha256: canonicalSchemaFingerprint(before), snapshotManifestSha256: null };
  const receipt = { schemaVersion: 1, kind: 'synthetic-existing-health-operational-bootstrap', source: metrics.source,
    sourceSchemaInputSha256: metrics.schemaInputSha256, canonicalSourceSchemaSha256: metrics.schemaSha256,
    beforeDumpFile: 'operational-schema-before.sql', afterDumpFile: 'operational-schema-after.sql', ddlSha256: hash(HEALTH_SENTINEL_DDL),
    beforeDumpSha256: hash(before), afterDumpSha256: hash(after), beforeCanonicalSha256: canonicalSchemaFingerprint(before), afterCanonicalSha256: canonicalSchemaFingerprint(after),
    createdOperationalRelation: true, productionCatalogClaimed: false, canonicalMigrationSchemaRelabeled: false, migrationInventoryChanged: false,
    tenantRlsInventoryChanged: false, healthMonitorExecuted: false, capacityAcceptance: false, originalSnapshotRestore: null,
    runtimePrivileges: { present: true, superuser: false, bypassRls: false, schemaCreate: false, ownsTable: false, ownerMembership: false,
      select: true, insert: true, delete: true, update: false, truncate: false, references: false, trigger: false, sequenceUsage: true, sequenceSelect: false, sequenceUpdate: false } };
  const save = () => writeFileSync(join(root, 'operational-fixture-bootstrap.json'), JSON.stringify(receipt));
  writeFileSync(join(root, receipt.beforeDumpFile), before); writeFileSync(join(root, receipt.afterDumpFile), after); save();
  return { root, metrics, receipt, save, before, after };
}
test('bound native operational SQL custody rejects tamper and missing raw artifacts', t => {
  const { root, metrics, receipt, save, before, after } = fixture(t);
  assert.equal(verifyOperationalFixtureCustody(root, metrics).createdOperationalRelation, true);
  writeFileSync(join(root, receipt.afterDumpFile), 'ALTER TABLE public.example ADD COLUMN unrelated text;');
  assert.throws(() => verifyOperationalFixtureCustody(root, metrics));
  writeFileSync(join(root, receipt.afterDumpFile), after);
  rmSync(join(root, receipt.beforeDumpFile)); assert.throws(() => verifyOperationalFixtureCustody(root, metrics));
  writeFileSync(join(root, receipt.beforeDumpFile), before);
  assert.equal(verifyOperationalFixtureCustody(root, metrics).createdOperationalRelation, true);
  writeFileSync(join(dirname(root), 'unowned.sql'), after);
  receipt.afterDumpFile = '../unowned.sql'; save(); assert.throws(() => verifyOperationalFixtureCustody(root, metrics));
});
test('operational receipt cannot relabel source schema, original DDL or native state', t => {
  const { root, metrics, receipt, save } = fixture(t);
  assert.throws(() => verifyOperationalFixtureCustody(root, { ...metrics, schemaSha256: 'b'.repeat(64) }));
  assert.throws(() => verifyOperationalFixtureCustody(root, { ...metrics, source: 'b'.repeat(40) }));
  receipt.ddlSha256 = hash(HEALTH_SENTINEL_DDL.replace('DEFAULT NOW()', 'DEFAULT NULL')); save();
  assert.throws(() => verifyOperationalFixtureCustody(root, metrics));
  receipt.ddlSha256 = hash(HEALTH_SENTINEL_DDL); receipt.createdOperationalRelation = false; save();
  assert.throws(() => verifyOperationalFixtureCustody(root, metrics));
});
test('post-snapshot operational custody requires the exact successfully verified original snapshot', t => {
  const { root, metrics, receipt, save } = fixture(t), snapshot = 'c'.repeat(64);
  assert.throws(() => verifyOperationalFixtureCustody(root, { ...metrics, snapshotManifestSha256: snapshot }));
  receipt.originalSnapshotRestore = { restorationPassed: true, snapshotManifestSha256: snapshot }; save();
  assert.equal(verifyOperationalFixtureCustody(root, { ...metrics, snapshotManifestSha256: snapshot }).originalSnapshotRestore.restorationPassed, true);
  receipt.originalSnapshotRestore.restorationPassed = false; save();
  assert.throws(() => verifyOperationalFixtureCustody(root, { ...metrics, snapshotManifestSha256: snapshot }));
});
