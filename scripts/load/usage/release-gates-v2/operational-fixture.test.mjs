import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH_SENTINEL_DDL, healthFixtureSql, verifyHealthFixturePrivileges, restoredOperationalIdentities } from './operational-fixture.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';

const safe = () => ({ present: true, superuser: false, bypassRls: false, schemaCreate: false, ownsTable: false, ownerMembership: false,
  select: true, insert: true, delete: true, update: false, truncate: false, references: false, trigger: false,
  sequenceUsage: true, sequenceSelect: false, sequenceUpdate: false });
test('operational fixture refuses effective runtime privilege broadening and missing privileges', () => {
  assert.equal(verifyHealthFixturePrivileges(safe()), true);
  for (const key of ['superuser', 'bypassRls', 'schemaCreate', 'ownsTable', 'ownerMembership', 'update', 'truncate', 'references', 'trigger', 'sequenceSelect', 'sequenceUpdate'])
    assert.throws(() => verifyHealthFixturePrivileges({ ...safe(), [key]: true }));
  for (const key of ['present', 'select', 'insert', 'delete', 'sequenceUsage'])
    assert.throws(() => verifyHealthFixturePrivileges({ ...safe(), [key]: false }));
  const missing = safe(); delete missing.schemaCreate;
  assert.throws(() => verifyHealthFixturePrivileges(missing));
});
test('operational owner bootstrap cannot inject role identifiers or become runtime ownership', () => {
  assert.throws(() => healthFixtureSql('runtime;GRANT', 'owner'));
  assert.throws(() => healthFixtureSql('runtime', 'owner\n'));
  assert.throws(() => healthFixtureSql('same', 'same'));
  const sql = healthFixtureSql('runtime', 'owner');
  assert.ok(sql.includes(HEALTH_SENTINEL_DDL));
  assert.match(sql, /REVOKE ALL ON TABLE public\._health_sentinel FROM runtime/);
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON TABLE public\._health_sentinel TO runtime/);
  assert.match(sql, /GRANT USAGE ON SEQUENCE public\._health_sentinel_id_seq TO runtime/);
  assert.doesNotMatch(sql, /GRANT CREATE|OWNER TO|BYPASSRLS|SUPERUSER/);
});
test('operational table is visible in the full schema fingerprint, separately from canonical migrations', () => {
  const sourceSchema = 'CREATE TABLE public.example(id text);\n';
  assert.notEqual(canonicalSchemaFingerprint(sourceSchema), canonicalSchemaFingerprint(sourceSchema + HEALTH_SENTINEL_DDL));
  assert.notEqual(canonicalSchemaFingerprint(sourceSchema + HEALTH_SENTINEL_DDL),
    canonicalSchemaFingerprint(sourceSchema + HEALTH_SENTINEL_DDL.replace('DEFAULT NOW()', 'DEFAULT NULL')));
});
test('post-restore operational setup requires the original verified exact owned database and role', () => {
  const run = '0123456789ab', database = 'schoolpilot_redesign_usage_scale_' + run;
  const ready = { run, pgContainerId: 'a'.repeat(64), restorationPassed: true, database, freshRole: 'restore_app_' + run };
  const configuration = { adminUrl: `postgresql://restore_owner_${run}:private@127.0.0.1:5437/${database}`,
    appUrl: `postgresql://restore_app_${run}:private@127.0.0.1:5437/${database}` };
  assert.equal(restoredOperationalIdentities(configuration, ready).database, database);
  assert.throws(() => restoredOperationalIdentities(configuration, { ...ready, restorationPassed: false }));
  assert.throws(() => restoredOperationalIdentities({ ...configuration, adminUrl: configuration.adminUrl.replace('127.0.0.1', 'production') }, ready));
  assert.throws(() => restoredOperationalIdentities({ ...configuration, appUrl: configuration.appUrl.replace(database, 'unowned') }, ready));
  assert.throws(() => restoredOperationalIdentities({ ...configuration, adminUrl: configuration.adminUrl.replace('restore_owner', 'restore_app') }, ready));
  assert.throws(() => restoredOperationalIdentities(configuration, { ...ready, freshRole: 'different' }));
});
