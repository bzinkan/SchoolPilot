import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { getTableColumns, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { classpilotStudentControlStates } from '../src/schema/classpilot.ts';
import { classpilotSsoPolicyFromSettings } from '../src/services/classpilotSsoPolicy.ts';

const source = readFileSync(new URL('../src/services/storage.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const decoder = source.slice(source.indexOf('function decodeHeartbeatControlTimestamp('), source.indexOf('/**\n * Fresh initial heartbeat navigation/privacy projection'));
const helper = source.slice(source.indexOf('export async function getClasspilotStudentControlDeliveryContext('), source.indexOf('export async function getClasspilotStudentControlStates(')).replace('export async', 'async');
const executable = ts.transpileModule(decoder + helper, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const readContext = new Function('sql', 'classpilotStudentControlStates', 'classpilotSsoPolicyFromSettings',
  `${executable};return getClasspilotStudentControlDeliveryContext;`)(sql, classpilotStudentControlStates, classpilotSsoPolicyFromSettings);
const dates = ['scheduledEndAt', 'hardExpiresAt', 'lastAcknowledgedAt', 'createdAt', 'updatedAt'];
const raw = { id: 'synthetic-control', schoolId: 'synthetic-school', studentId: 'synthetic-student',
  teachingSessionId: 'synthetic-class', supervisionContextId: null, revision: 9, desiredState: { screenLocked: true },
  sourceCommandId: 'synthetic-command', scheduledEndAt: '2026-11-01 01:30:00.123-04', hardExpiresAt: '2026-11-01 01:30:00.456-05',
  enforcementHealth: 'failed', appliedRevision: 8, lastOutcome: 'failed', lastError: 'synthetic error',
  lastAcknowledgedAt: '2026-03-08 03:00:00.789-04', createdAt: '2026-01-01 00:00:00.001+00', updatedAt: '2026-02-01 00:00:00.002+00',
  classpilotSsoPolicy: { invalid: true }, classpilotSsoPolicyRevision: 3 };

test('actual final delivery projection maps all schema fields and timestamp decoders in one exact-scoped statement', async t => {
  let count = 0, query;
  const actual = await readContext(raw.schoolId, raw.studentId, { execute: async statement => {
    count++; query = new PgDialect().sqlToQuery(statement); return { rows: [raw] };
  } });
  assert.equal(count, 1);
  const expected = Object.fromEntries(Object.keys(getTableColumns(classpilotStudentControlStates)).map(key => [key,
    dates.includes(key) ? classpilotStudentControlStates[key].mapFromDriverValue(raw[key]) : raw[key]]));
  assert.deepEqual(actual.controlState, expected);
  assert.deepEqual(actual.ssoPolicy, classpilotSsoPolicyFromSettings(raw));
  assert.deepEqual(query.params, [raw.schoolId, raw.studentId, raw.schoolId]);
  assert.match(query.sql, /FROM \(SELECT 1\) anchor\s+LEFT JOIN classpilot_student_control_states AS control/);
  assert.match(query.sql, /control.school_id = \$1 AND control.student_id = \$2/);
  assert.match(query.sql, /LEFT JOIN settings AS policy ON policy.school_id = \$3/);
  assert.doesNotMatch(query.sql, /FOR (?:SHARE|UPDATE)|pg_advisory/);
  t.diagnostic(JSON.stringify({ sql: query.sql, parameters: query.params, controlFields: Object.keys(expected), fixtureOnly: true }));
});

test('control absence, settings absence and nullable timestamps retain independent canonical defaults', async () => {
  const read = row => readContext(raw.schoolId, raw.studentId, { execute: async () => ({ rows: row ? [row] : [] }) });
  for (const row of [undefined, { id: null, classpilotSsoPolicy: null, classpilotSsoPolicyRevision: null }]) {
    assert.deepEqual(await read(row), { controlState: undefined, ssoPolicy: classpilotSsoPolicyFromSettings(undefined) });
  }
  assert.deepEqual((await read({ ...raw, id: null })).ssoPolicy, classpilotSsoPolicyFromSettings(raw));
  const actual = await read({ ...raw, scheduledEndAt: null, hardExpiresAt: null, lastAcknowledgedAt: null,
    classpilotSsoPolicy: null, classpilotSsoPolicyRevision: null });
  assert.equal(actual.controlState.scheduledEndAt, null);
  assert.equal(actual.controlState.hardExpiresAt, null);
  assert.equal(actual.controlState.lastAcknowledgedAt, null);
  assert.deepEqual(actual.ssoPolicy, classpilotSsoPolicyFromSettings(undefined));
});

test('heartbeat uses the joined fresh read only inside the final frozen authority callback', () => {
  const route = readFileSync(new URL('../src/routes/classpilot/devices.ts', import.meta.url), 'utf8');
  const final = route.slice(route.indexOf('    const finalDelivery = await runWithTenantContext('),
    route.indexOf('    if (!finalDelivery.authorized)'));
  assert.match(final, /withClasspilotHeartbeatDeliveryAuthority\([\s\S]*freezeSsoPolicy: true[\s\S]*async \(transactionDb, readScreenshotAuthority\) => \{\s*const \{ controlState: finalControlState, ssoPolicy: finalSsoPolicy \} =\s*await getClasspilotStudentControlDeliveryContext\(schoolId, studentId, transactionDb\)/);
  assert.doesNotMatch(final, /getClasspilotStudentControlState\(|getClasspilotSsoPolicyForSchool\(/);
});
