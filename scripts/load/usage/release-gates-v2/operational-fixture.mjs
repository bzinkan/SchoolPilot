import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { hash } from './contracts.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';

// The existing health monitor owns this operational table. It is not a new
// migration or an addition to the governed tenant-table inventory.
export const HEALTH_SENTINEL_DDL = `CREATE TABLE IF NOT EXISTS public._health_sentinel (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`;

export function healthFixtureSql(appRole, owner) {
  for (const identifier of [appRole, owner]) {
    assert.match(identifier, /^[a-z][a-z0-9_]{1,62}$/);
    assert.equal(/[^a-z0-9_]/.test(identifier), false);
  }
  assert.notEqual(appRole, owner);
  return `BEGIN;
${HEALTH_SENTINEL_DDL}
REVOKE ALL ON TABLE public._health_sentinel FROM ${appRole};
REVOKE ALL ON SEQUENCE public._health_sentinel_id_seq FROM ${appRole};
GRANT SELECT, INSERT, DELETE ON TABLE public._health_sentinel TO ${appRole};
GRANT USAGE ON SEQUENCE public._health_sentinel_id_seq TO ${appRole};
SELECT json_build_object(
  'present', to_regclass('public._health_sentinel') IS NOT NULL,
  'superuser', r.rolsuper, 'bypassRls', r.rolbypassrls,
  'schemaCreate', has_schema_privilege(r.oid, 'public', 'CREATE'),
  'ownsTable', c.relowner = r.oid, 'ownerMembership', pg_has_role(r.oid, '${owner}', 'MEMBER'),
  'select', has_table_privilege(r.oid, c.oid, 'SELECT'),
  'insert', has_table_privilege(r.oid, c.oid, 'INSERT'),
  'delete', has_table_privilege(r.oid, c.oid, 'DELETE'),
  'update', has_table_privilege(r.oid, c.oid, 'UPDATE'),
  'truncate', has_table_privilege(r.oid, c.oid, 'TRUNCATE'),
  'references', has_table_privilege(r.oid, c.oid, 'REFERENCES'),
  'trigger', has_table_privilege(r.oid, c.oid, 'TRIGGER'),
  'sequenceUsage', has_sequence_privilege(r.oid, 'public._health_sentinel_id_seq', 'USAGE'),
  'sequenceSelect', has_sequence_privilege(r.oid, 'public._health_sentinel_id_seq', 'SELECT'),
  'sequenceUpdate', has_sequence_privilege(r.oid, 'public._health_sentinel_id_seq', 'UPDATE')
) FROM pg_roles r CROSS JOIN pg_class c
WHERE r.rolname = '${appRole}' AND c.oid = to_regclass('public._health_sentinel');
COMMIT;`;
}

export function verifyHealthFixturePrivileges(proof) {
  assert.deepEqual(Object.keys(proof).sort(), ['present', 'superuser', 'bypassRls', 'schemaCreate', 'ownsTable', 'ownerMembership',
    'select', 'insert', 'delete', 'update', 'truncate', 'references', 'trigger', 'sequenceUsage', 'sequenceSelect', 'sequenceUpdate'].sort());
  for (const key of ['present', 'select', 'insert', 'delete', 'sequenceUsage']) assert.equal(proof[key], true, key);
  for (const key of ['superuser', 'bypassRls', 'schemaCreate', 'ownsTable', 'ownerMembership', 'update', 'truncate', 'references', 'trigger', 'sequenceSelect', 'sequenceUpdate']) assert.equal(proof[key], false, key);
  return true;
}

export function restoredOperationalIdentities(configuration, ready) {
  assert.match(ready.run, /^[a-f0-9]{12}$/); assert.match(ready.pgContainerId, /^[a-f0-9]{64}$/);
  assert.equal(ready.restorationPassed, true);
  const admin = new URL(configuration.adminUrl), app = new URL(configuration.appUrl);
  for (const url of [admin, app]) {
    assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5437');
    assert.equal(url.pathname, '/schoolpilot_redesign_usage_scale_' + ready.run);
  }
  assert.equal(admin.username, 'restore_owner_' + ready.run); assert.equal(app.username, 'restore_app_' + ready.run);
  assert.equal(ready.freshRole, app.username); assert.equal(ready.database, admin.pathname.slice(1));
  return { containerId: ready.pgContainerId, owner: admin.username, database: ready.database, appRole: app.username };
}

export function verifyOperationalFixtureCustody(directory, metrics) {
  const root = realpathSync(directory);
  const contained = name => {
    const path = realpathSync(join(root, name)), rel = relative(root, path);
    assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'), 'Operational artifact escaped its receipt directory');
    return path;
  };
  const receipt = JSON.parse(readFileSync(contained('operational-fixture-bootstrap.json'), 'utf8'));
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'synthetic-existing-health-operational-bootstrap');
  assert.equal(receipt.source, metrics.source); assert.equal(receipt.sourceSchemaInputSha256, metrics.schemaInputSha256);
  assert.equal(receipt.canonicalSourceSchemaSha256, metrics.schemaSha256);
  assert.equal(receipt.beforeDumpFile, 'operational-schema-before.sql'); assert.equal(receipt.afterDumpFile, 'operational-schema-after.sql');
  assert.equal(receipt.ddlSha256, hash(HEALTH_SENTINEL_DDL)); verifyHealthFixturePrivileges(receipt.runtimePrivileges);
  for (const key of ['productionCatalogClaimed', 'canonicalMigrationSchemaRelabeled', 'migrationInventoryChanged', 'tenantRlsInventoryChanged', 'healthMonitorExecuted', 'capacityAcceptance'])
    assert.equal(receipt[key], false, key);
  assert.equal(typeof receipt.createdOperationalRelation, 'boolean');
  const before = readFileSync(contained(receipt.beforeDumpFile)), after = readFileSync(contained(receipt.afterDumpFile));
  assert.equal(hash(before), receipt.beforeDumpSha256); assert.equal(hash(after), receipt.afterDumpSha256);
  assert.equal(canonicalSchemaFingerprint(before.toString('utf8')), receipt.beforeCanonicalSha256);
  assert.equal(canonicalSchemaFingerprint(after.toString('utf8')), receipt.afterCanonicalSha256);
  assert.equal(receipt.beforeCanonicalSha256, receipt.canonicalSourceSchemaSha256);
  if (receipt.createdOperationalRelation) assert.notEqual(receipt.afterCanonicalSha256, receipt.beforeCanonicalSha256);
  else assert.equal(receipt.afterCanonicalSha256, receipt.beforeCanonicalSha256);
  if (metrics.snapshotManifestSha256) {
    assert.equal(receipt.originalSnapshotRestore?.restorationPassed, true);
    assert.equal(receipt.originalSnapshotRestore?.snapshotManifestSha256, metrics.snapshotManifestSha256);
  } else assert.equal(receipt.originalSnapshotRestore, null);
  return receipt;
}

export async function bootstrapHealthOperationalFixture(options, docker) {
  const { containerId, owner, database, appRole, outputDirectory } = options;
  assert.match(containerId, /^[a-f0-9]{64}$/); assert.match(options.source, /^[a-f0-9]{40}$/);
  assert.match(options.schemaInputSha256, /^[a-f0-9]{64}$/); assert.match(options.canonicalSourceSchemaSha256, /^[a-f0-9]{64}$/);
  if (options.originalSnapshotRestore) {
    assert.equal(options.originalSnapshotRestore.restorationPassed, true);
    assert.match(options.originalSnapshotRestore.snapshotManifestSha256, /^[a-f0-9]{64}$/);
  }
  const sql = healthFixtureSql(appRole, owner);
  const dump = () => docker(['exec', containerId, 'pg_dump', '-p', '5437', '-U', owner, '-d', database, '--schema-only', '--no-owner', '--no-privileges']);
  const before = await dump();
  assert.equal(canonicalSchemaFingerprint(before), options.canonicalSourceSchemaSha256, 'Actual pre-bootstrap schema differs from pinned source schema');
  const present = JSON.parse(await docker(['exec', containerId, 'psql', '-p', '5437', '-U', owner, '-d', database, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-c', "SELECT json_build_object('present',to_regclass('public._health_sentinel') IS NOT NULL)"]));
  assert.deepEqual(Object.keys(present), ['present']); assert.equal(typeof present.present, 'boolean');
  const proof = JSON.parse(await docker(['exec', '-i', containerId, 'psql', '-p', '5437', '-U', owner, '-d', database, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { input: sql }));
  verifyHealthFixturePrivileges(proof);
  const after = await dump();
  const afterCanonical = canonicalSchemaFingerprint(after);
  if (!present.present) assert.notEqual(afterCanonical, options.canonicalSourceSchemaSha256, 'Operational addition must remain visible in the fixture schema');
  else assert.equal(afterCanonical, options.canonicalSourceSchemaSha256, 'Existing operational relation needs only privilege preparation');
  writeFileSync(join(outputDirectory, 'operational-schema-before.sql'), before, { flag: 'wx' });
  writeFileSync(join(outputDirectory, 'operational-schema-after.sql'), after, { flag: 'wx' });
  const receipt = { schemaVersion: 1, kind: 'synthetic-existing-health-operational-bootstrap', source: options.source,
    productionCatalogClaimed: false, sourceSchemaInputSha256: options.schemaInputSha256,
    canonicalSourceSchemaSha256: options.canonicalSourceSchemaSha256, ddlSha256: hash(HEALTH_SENTINEL_DDL),
    beforeDumpFile: 'operational-schema-before.sql', afterDumpFile: 'operational-schema-after.sql',
    beforeDumpSha256: hash(before), beforeCanonicalSha256: canonicalSchemaFingerprint(before),
    afterDumpSha256: hash(after), afterCanonicalSha256: afterCanonical, createdOperationalRelation: !present.present,
    canonicalMigrationSchemaRelabeled: false, migrationInventoryChanged: false, tenantRlsInventoryChanged: false,
    originalSnapshotRestore: options.originalSnapshotRestore ?? null,
    runtimePrivileges: proof, healthMonitorExecuted: false, capacityAcceptance: false };
  writeFileSync(join(outputDirectory, 'operational-fixture-bootstrap.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}
