import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertReleaseControlPreparationEnvironment, validateReleaseControlRows } from '../scripts/load/usage/prepare-release-control-ownership.mjs';

function environment() {
  return { USAGE_LOCAL_SCALE: '1', NODE_ENV: 'test', USAGE_SCALE_CONTAINER: 'schoolpilot-usage-scale-123456abcdef',
    DATABASE_URL: 'postgresql://restricted:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_123456abcdef',
    ADMIN_DATABASE_URL: 'postgresql://owner:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_123456abcdef',
    DATABASE_URL_PRIVILEGED: 'postgresql://restricted:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_123456abcdef',
    USAGE_SCALE_COLD_PHASE: 'prepare', USAGE_RELEASE_PHASE: 'preflight', RLS_GUC_ENABLED: 'true',
    USAGE_SCALE_RLS_INVENTORY: 'classpilotPrivateChatLifecyclePostExpand', REDIS_URL: '', USAGE_SOURCE_REVISION: 'a'.repeat(40) };
}
function fixture(prepared = true) {
  const school = { index: 0, groups: Array.from({ length: 100 }, (_, i) => `group-${i}`),
    teachers: Array.from({ length: 100 }, (_, i) => `teacher-${i}`), students: Array.from({ length: 500 }, (_, i) => `student-${i}`) };
  const sessions = school.groups.map((group_id, i) => ({ id: `session-${i}`, group_id, teacher_id: school.teachers[i],
    roster_snapshot_completed_at: prepared ? new Date() : null, class_name_snapshot: prepared ? 'Synthetic' : null,
    timezone_snapshot: prepared ? 'America/New_York' : null }));
  const roster = school.students.map((student_id, i) => ({ student_id, teaching_session_id: `session-${Math.floor(i / 5)}`, group_id: school.groups[Math.floor(i / 5)] }));
  const staff = prepared ? sessions.map((session, i) => ({ staff_id: school.teachers[i], teaching_session_id: session.id, role: 'primary' })) : [];
  const controls = prepared ? roster.map(row => ({ student_id: row.student_id, teaching_session_id: row.teaching_session_id,
    supervision_context_id: null, source_command_id: null, desired_state: { restrictions: {} }, revision: 1,
    hard_expires_at: new Date(Date.now() + 3_600_000) })) : [];
  return { school, rows: { sessions, roster, staff, controls } };
}

test('release control preparation requires a local restricted before-restart fixture', () => {
  assert.doesNotThrow(() => assertReleaseControlPreparationEnvironment(environment()));
  for (const change of [{ NODE_ENV: 'production' }, { USAGE_SCALE_COLD_PHASE: 'measure' }, { USAGE_RELEASE_PHASE: undefined },
    { RLS_GUC_ENABLED: 'false' }, { REDIS_URL: 'redis://127.0.0.1:6380' },
    { DATABASE_URL_PRIVILEGED: environment().ADMIN_DATABASE_URL },
    { DATABASE_URL: environment().DATABASE_URL.replace('127.0.0.1', 'remote.example.test') }]) {
    assert.throws(() => assertReleaseControlPreparationEnvironment({ ...environment(), ...change }));
  }
});

test('complete100-class500-student raw and canonical mappings validate', () => {
  for (const prepared of [false, true]) {
    const { school, rows } = fixture(prepared); assert.doesNotThrow(() => validateReleaseControlRows(school, rows, prepared));
  }
});

test('every student and class must keep exact empty initial control ownership', () => {
  for (const mutate of [rows => rows.controls.pop(), rows => { rows.controls[499].teaching_session_id = 'session-0'; },
    rows => { rows.controls[499].student_id = 'other-school-student'; }, rows => { rows.controls[499].desired_state = { restrictions: { attention: true } }; },
    rows => { rows.controls[499].revision = 0; }, rows => { rows.controls[499].hard_expires_at = new Date(0); },
    rows => { rows.roster[499].group_id = 'group-0'; }, rows => { rows.staff[99].staff_id = 'teacher-0'; },
    rows => { rows.sessions[99].teacher_id = 'teacher-0'; }, rows => { rows.controls[499].supervision_context_id = 'replacement'; }]) {
    const { school, rows } = fixture(); mutate(rows); assert.throws(() => validateReleaseControlRows(school, rows, true));
  }
});

test('runner prepares only release ownership before restart and leaves comparison seed untouched', () => {
  const runner = readFileSync(new URL('../scripts/load/usage/run-release-enabled-scale.ps1', import.meta.url), 'utf8');
  const prep = runner.indexOf('scripts/load/usage/prepare-release-control-ownership.mjs');
  assert.ok(prep > runner.indexOf("'preparation.log'"));
  assert.ok(prep < runner.indexOf('restart $container'));
  const helper = readFileSync(new URL('../scripts/load/usage/prepare-release-control-ownership.mjs', import.meta.url), 'utf8');
  assert.match(helper, /runWithTenantContext\(\{ schoolId: school\.id \}/);
  assert.match(helper, /backfillOpenTeachingSessionRosterSnapshots\(db, school\.id\)/);
  assert.match(helper, /await closeReleasePreparationPools\(\); result\.poolsClosed = true/);
  assert.doesNotMatch(helper, /\b(?:INSERT INTO|UPDATE)\s+classpilot_(?:session_staff|student_control_states)/i);
  const oldRunner = readFileSync(new URL('../scripts/load/usage/local-school-day-scale.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(oldRunner, /prepareReleaseSchoolControls|prepare-release-control-ownership/);
});
