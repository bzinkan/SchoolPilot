import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLocalScaleFixture } from './local-usage-scale.mjs';
import { assertColdFixtureSnapshot } from './cold-open-loop-profile.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const rawSeedFiles = [
  'src/services/classpilotUsageRollup.ts', 'src/services/classpilotUsageRead.ts', 'src/routes/classpilot/devices.ts',
  'scripts/load/usage/local-school-day-scale.mjs', 'scripts/load/usage/school-day-profile.mjs',
  'scripts/load/usage/school-day-ai-profile.mjs', 'scripts/load/usage/local-usage-scale.mjs',
  'scripts/load/usage/reference-attribution-20260930.sql', 'scripts/load/usage/local-school-day-ai-scale.mjs',
  'scripts/load/usage/open-loop-heartbeats.mjs', 'scripts/load/usage/cold-open-loop-profile.mjs',
  'scripts/load/usage/classpilot-297-advertised-capabilities.json', 'scripts/load/usage/local-cold-open-loop-scale.mjs',
];

export function assertReleaseControlPreparationEnvironment(env) {
  assertLocalScaleFixture(env);
  assert.equal(env.USAGE_SCALE_COLD_PHASE, 'prepare', 'Control preparation must precede the cold restart');
  assert.ok(['combined', 'ingest', 'reports', 'worker', 'preflight'].includes(env.USAGE_RELEASE_PHASE));
  assert.equal(env.RLS_GUC_ENABLED, 'true');
  assert.equal(env.USAGE_SCALE_RLS_INVENTORY, 'classpilotPrivateChatLifecyclePostExpand');
  assert.equal(env.DATABASE_URL_PRIVILEGED, env.DATABASE_URL, 'Canonical preparation must use the restricted application role');
  assert.equal(env.REDIS_URL, '');
  assert.match(env.USAGE_SOURCE_REVISION || '', /^[a-f0-9]{40}$/);
}

export function validateReleaseControlRows(school, rows, prepared) {
  assert.equal(school.groups.length, 100); assert.equal(school.teachers.length, 100); assert.equal(school.students.length, 500);
  assert.equal(rows.sessions.length, 100, 'All current fixture classes must be present');
  const sessions = new Map();
  for (const session of rows.sessions) {
    const index = school.groups.indexOf(session.group_id);
    assert.ok(index >= 0 && !sessions.has(session.group_id), 'Current session group must be unique and fixture-bound');
    assert.equal(session.teacher_id, school.teachers[index], 'Current session teacher must match its fixture class');
    sessions.set(session.group_id, session.id);
    if (prepared) {
      assert.ok(session.roster_snapshot_completed_at && session.class_name_snapshot && session.timezone_snapshot);
    } else {
      assert.equal(session.roster_snapshot_completed_at, null, 'Refuse to overwrite an already prepared fixture');
    }
  }
  assert.equal(rows.roster.length, 500, 'Exactly one current frozen class membership per fixture student');
  const students = new Set();
  for (const member of rows.roster) {
    const index = school.students.indexOf(member.student_id), group = school.groups[Math.floor(index / 5)];
    assert.ok(index >= 0 && !students.has(member.student_id), 'Current roster must be unique and fixture-bound');
    assert.equal(member.group_id, group);
    assert.equal(member.teaching_session_id, sessions.get(group)); students.add(member.student_id);
  }
  assert.equal(rows.staff.length, prepared ? 100 : 0, 'Canonical preparation must capture every current teacher');
  const staffed = new Set();
  for (const staff of rows.staff) {
    const index = school.teachers.indexOf(staff.staff_id);
    assert.ok(index >= 0 && !staffed.has(staff.teaching_session_id));
    assert.equal(staff.teaching_session_id, sessions.get(school.groups[index]));
    assert.equal(staff.role, 'primary'); staffed.add(staff.teaching_session_id);
  }
  assert.equal(rows.controls.length, prepared ? 500 : 0, 'Every fixture student needs canonical current control ownership');
  const controlled = new Set();
  for (const control of rows.controls) {
    const index = school.students.indexOf(control.student_id);
    assert.ok(index >= 0 && !controlled.has(control.student_id)); controlled.add(control.student_id);
    assert.equal(control.teaching_session_id, sessions.get(school.groups[Math.floor(index / 5)]));
    assert.equal(control.supervision_context_id, null); assert.equal(control.source_command_id, null);
    assert.deepEqual(control.desired_state, { restrictions: {} }, 'Initial controls must not manufacture a restriction');
    assert.ok(control.revision > 0 && new Date(control.hard_expires_at).getTime() > Date.now());
  }
}

async function readSchoolRows(client, schoolId) {
  const args = [schoolId];
  const sessions = (await client.query('SELECT id,group_id,teacher_id,roster_snapshot_completed_at,class_name_snapshot,timezone_snapshot FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL', args)).rows;
  const roster = (await client.query('SELECT r.student_id,r.teaching_session_id,r.group_id FROM classpilot_session_students r JOIN teaching_sessions t ON t.id=r.teaching_session_id AND t.school_id=r.school_id WHERE r.school_id=$1 AND t.end_time IS NULL', args)).rows;
  const staff = (await client.query('SELECT r.staff_id,r.teaching_session_id,r.role FROM classpilot_session_staff r JOIN teaching_sessions t ON t.id=r.teaching_session_id AND t.school_id=r.school_id WHERE r.school_id=$1 AND t.end_time IS NULL', args)).rows;
  const controls = (await client.query('SELECT student_id,teaching_session_id,supervision_context_id,source_command_id,desired_state,revision,hard_expires_at FROM classpilot_student_control_states WHERE school_id=$1', args)).rows;
  const history = (await client.query(`SELECT (SELECT COUNT(*)::int FROM teaching_sessions WHERE school_id=$1 AND end_time IS NOT NULL) AS sessions,
    (SELECT COUNT(*)::int FROM classpilot_session_students r JOIN teaching_sessions t ON t.id=r.teaching_session_id AND t.school_id=r.school_id WHERE r.school_id=$1 AND t.end_time IS NOT NULL) AS roster,
    (SELECT COUNT(*)::int FROM teaching_sessions WHERE school_id=$1 AND end_time IS NOT NULL AND roster_snapshot_completed_at IS NOT NULL) AS completed_snapshots`, args)).rows[0];
  return { sessions, roster, staff, controls, history };
}

// Exported for the native synthetic fixture proof. The only writer is the
// production backfill; no direct authority/control INSERT or UPDATE exists here.
export async function prepareReleaseSchoolControls(school) {
  assertReleaseControlPreparationEnvironment(process.env);
  const [{ default: db }, { runWithTenantContext }, { getTenantStore }, storage] = await Promise.all([
    import('../../../dist/db.js'), import('../../../dist/middleware/tenantContext.js'),
    import('../../../dist/db/tenantContext.js'), import('../../../dist/services/storage.js'),
  ]);
  return runWithTenantContext({ schoolId: school.id }, async () => {
    const store = getTenantStore(); assert.ok(store && !store.isSuper && store.schoolId === school.id);
    const role = (await store.client.query("SELECT rolsuper,rolbypassrls,current_setting('app.school_id',true) AS school_id,current_setting('app.is_super',true) AS is_super FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    assert.equal(role.school_id, school.id); assert.notEqual(role.is_super, 'on');
    const before = await readSchoolRows(store.client, school.id); validateReleaseControlRows(school, before, false);
    const backfilledSessions = await storage.backfillOpenTeachingSessionRosterSnapshots(db, school.id);
    assert.equal(backfilledSessions, 100, 'Canonical backfill must initialize every current fixture session');
    const after = await readSchoolRows(store.client, school.id); validateReleaseControlRows(school, after, true);
    assert.deepEqual(after.history, before.history, 'Ended seed history must remain unchanged');
    return { schoolIndex: school.index, currentSessions: after.sessions.length, rosterRows: after.roster.length,
      staffBindings: after.staff.length, controlRows: after.controls.length, invalidBindings: 0, nonemptyRestrictions: 0, backfilledSessions };
  });
}

export async function closeReleasePreparationPools() {
  const [db, scheduler, tenant, errors] = await Promise.all([
    import('../../../dist/db.js'), import('../../../dist/services/schedulerDb.js'),
    import('../../../dist/middleware/tenantContext.js'), import('../../../dist/services/errorMonitor.js'),
  ]);
  db.stopApiPoolReadiness(); await db.drainApiPoolReadiness();
  await tenant.drainTenantContextReleases(); await errors.default.disposeAndWait();
  await Promise.all([db.pool.end(), db.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
}

async function main() {
  assertReleaseControlPreparationEnvironment(process.env);
  const file = resolve(process.env.USAGE_SCALE_COLD_STATE || '');
  const directory = dirname(resolve(process.env.USAGE_SCALE_OUTPUT || ''));
  assert.equal(file, resolve(directory, 'cold-fixture-state.json'));
  assert.ok(directory !== root && !directory.startsWith(root), 'Evidence must be outside the checkout');
  const bytes = readFileSync(file), coldFixtureSha256 = hash(bytes);
  assert.equal(coldFixtureSha256, process.env.USAGE_SCALE_COLD_STATE_SHA256);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const snapshot = assertColdFixtureSnapshot(JSON.parse(bytes.toString('utf8')), {
    sourceRevision: process.env.USAGE_SOURCE_REVISION, today,
    sourceHashes: Object.fromEntries(rawSeedFiles.map(name => [name, hash(readFileSync(resolve(root, name)))])),
    registrySha256: hash(readFileSync(resolve(root, 'src/config/rlsRegistry.json'))),
  });
  const result = { schemaVersion: 1, sourceRevision: process.env.USAGE_SOURCE_REVISION, coldFixtureSha256,
    scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))), passed: false, poolsClosed: false, schools: [] };
  try {
    for (const school of snapshot.schools) result.schools.push(await prepareReleaseSchoolControls(school));
    assert.equal(hash(readFileSync(file)), coldFixtureSha256, 'Original raw-seed snapshot must remain immutable');
    result.passed = true;
  } finally {
    await closeReleasePreparationPools(); result.poolsClosed = true;
    writeFileSync(resolve(directory, 'release-control-preparation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ event: 'canonical_release_control_preparation', ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'canonical_release_control_preparation_failed', name: error.name,
      code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PREPARATION_FAILED' }));
    process.exitCode = 1;
  });
}
