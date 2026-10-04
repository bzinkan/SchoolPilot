import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distinctReportContractHash, prepareDistinctReports, distinctPreparedStateHash,
  assertDistinctPreparedState, runDistinctReports, assertDistinctOracle, countDistinctCurrentObservations,
  assertDistinctAuditRecords } from './distinct-reports.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const coverageHash = oracle => digest(oracle.schools.map(({ schoolIndex, coverage }) => ({ schoolIndex, coverage })));
const profile = 'release297-usage-shared-db-three-api-distinct64-v1';
const scopeSql = "SELECT current_user AS role,current_database() AS database,current_setting('app.school_id',true) AS school,current_setting('app.is_super',true) AS is_super";
const text = value => value == null ? '' : String(value);
const wall = value => new Date(value).toISOString().replace('T', ' ').replace('Z', '');
const iso = value => new Date(value).toISOString();
const fixtureIdentity = fixture => digest({ source: fixture.sourceRevision, today: fixture.today,
  heavyDate: fixture.heavyDate, emptyDate: fixture.emptyDate, gapDate: fixture.gapDate, apiBases: fixture.apiBases,
  schools: fixture.schools.map(({ index, id, staff, students, devices, studentSessions, groups, currentSession }) =>
    ({ index, id, staff, students, devices, studentSessions, groups, currentSession })) });
const rawPrefixHash = native => digest(native.map(({ schoolIndex, raw }) => ({ schoolIndex, raw })));

export function createDistinctGeneratorRpc({ run, source, getFixture, getSchools, staffRequest, options = {} }) {
  assert.match(run, /^[a-f0-9]{12}$/); assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(typeof staffRequest, 'function');
  let state;
  return {
    async prepare(request) {
      // Reject duplicate preparation without rendering retained cookies or
      // the large canonical expectation/oracle state in an AssertionError.
      assert.ok(state === undefined, 'A registered operation cannot replace its prepared state');
      const fixture = structuredClone(getFixture()); assert.equal(fixture.sourceRevision, source);
      assert.equal(request.source, source); assert.equal(request.contractSha256, distinctReportContractHash());
      const oracle = structuredClone(request.oracle), prepared = prepareDistinctReports(fixture, oracle);
      const preparedHash = distinctPreparedStateHash({ run, fixture, oracle, prepared });
      state = { fixture, fixtureIdentity: fixtureIdentity(fixture), oracle, prepared, preparedHash, consumed: false };
      return { prepared: true, contractSha256: prepared.contractSha256, casesSha256: prepared.caseManifestSha256,
        expectedSha256: prepared.expectedReportsSha256, oracleSha256: prepared.oracleSha256, preparedHash, caseCount: 64, csvCount: 8 };
    },
    async reports(request) {
      assert.ok(state); assert.equal(state.consumed, false, 'Prepared operation already consumed');
      assert.equal(getFixture().sourceRevision, source);
      assert.equal(fixtureIdentity(getFixture()), state.fixtureIdentity, 'Prepared recipient/fixture bindings changed');
      const actualHash = assertDistinctPreparedState({ run, fixture: state.fixture, oracle: state.oracle,
        prepared: state.prepared, preparedHash: request.preparedHash });
      assert.equal(actualHash, state.preparedHash);
      // Claim synchronously before the first await: duplicate RPCs cannot both
      // issue endpoints. The token comes from owned state, never a request echo.
      state.consumed = true;
      const result = await runDistinctReports({ ...options, fixture: state.fixture, schools: getSchools(), staffRequest,
        oracle: state.oracle, prepared: state.prepared, startsAtMs: request.startsAtMs });
      return { ...result, preparedHash: actualHash };
    },
  };
}

export const DISTINCT_RAW_SQL = `SELECT h.id,h.school_id,h.student_id,h.device_id,
  (EXTRACT(EPOCH FROM h.timestamp)*1000000)::bigint::text AS timestamp_microseconds,
  h.active_tab_url IS NOT DISTINCT FROM 'https://ixl.com/lesson' AS expected_url,
  h.ai_category IS NOT DISTINCT FROM 'educational' AS expected_classification,
  NULLIF(h.teacher_intent_source,'') IS NULL AS expected_teacher_intent,
  student.id IS NOT NULL AND device.device_id IS NOT NULL AND expected.device_id=h.device_id
    AND session.id IS NOT NULL AND session.is_active IS TRUE AS valid_binding
  FROM heartbeats h LEFT JOIN students student ON student.id=h.student_id AND student.school_id=h.school_id
  LEFT JOIN devices device ON device.device_id=h.device_id AND device.school_id=h.school_id
  LEFT JOIN jsonb_to_recordset($4::jsonb) AS expected(student_id text,device_id text,session_id text) ON expected.student_id=h.student_id
  LEFT JOIN student_sessions session ON session.id=expected.session_id AND session.student_id=h.student_id AND session.device_id=h.device_id
  WHERE h.school_id=$1 AND h.timestamp >= $2::timestamp AND h.timestamp < $3::timestamp ORDER BY h.student_id,h.timestamp,h.id`;
export const DISTINCT_ROSTER_SQL = `WITH observed AS (SELECT student_id,MIN(timestamp) AS first_at,MAX(timestamp) AS last_at
  FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp GROUP BY student_id),
  expected AS (SELECT student_id,group_id FROM jsonb_to_recordset($4::jsonb) AS item(student_id text,group_id text)),
  roster AS (SELECT member.student_id,member.group_id,member.captured_at,session.start_time,session.end_time,session.scheduled_end_at
    FROM classpilot_session_students member JOIN teaching_sessions session ON session.id=member.teaching_session_id AND session.school_id=member.school_id
    WHERE member.school_id=$1 AND session.start_time >= $2::timestamp-interval '12 hours' AND session.start_time < $3::timestamp
      AND (session.end_time IS NULL OR session.end_time >= $2::timestamp)),
  checked AS (SELECT observed.student_id,COUNT(roster.student_id) AS memberships,
    BOOL_AND(roster.group_id=expected.group_id AND roster.start_time<=observed.first_at AND roster.captured_at AT TIME ZONE 'UTC'<=observed.first_at
      AND (roster.end_time IS NULL OR roster.end_time>observed.last_at) AND (roster.scheduled_end_at IS NULL OR roster.scheduled_end_at AT TIME ZONE 'UTC'>observed.last_at)
      AND roster.start_time+interval '12 hours'>observed.last_at) AS covers_observations
    FROM observed LEFT JOIN expected USING(student_id) LEFT JOIN roster USING(student_id) GROUP BY observed.student_id)
  SELECT (SELECT COUNT(*)::int FROM classpilot_ai_decisions WHERE school_id=$1 AND created_at >= $2::timestamp AND created_at < $3::timestamp) AS "currentAiDecisionRows",
    (SELECT COUNT(*)::int FROM checked WHERE memberships<>1 OR covers_observations IS DISTINCT FROM true) AS "invalidRosterStudents"`;
export const DISTINCT_COVERAGE_SQL = `SELECT usage_date::text AS date,processed_through,is_final,
  day_start_at=((usage_date::timestamp AT TIME ZONE $4)) AND day_end_at=(((usage_date+1)::timestamp AT TIME ZONE $4))
    AND processed_through>=day_start_at AND processed_through<=day_end_at AND (NOT is_final OR processed_through=day_end_at) AS valid_window
  FROM classpilot_usage_rollup_days WHERE school_id=$1 AND usage_date >= $2::date AND usage_date <= $3::date ORDER BY usage_date`;
const auditSql = "SELECT id,action,school_id,user_id,entity_type,entity_id,metadata FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export' ORDER BY id";

async function canonicalRawDependencies() {
  const module = await import('/diagnostic/scripts/load/usage/local-usage-scale.mjs');
  return { seconds: module.currentObservationSeconds, violations: module.currentObservationFixtureViolations };
}
function runtimeIdentity(env, run, source) {
  assert.equal(env.NODE_ENV, 'test'); assert.equal(env.USAGE_LOCAL_SCALE, '1');
  assert.equal(env.USAGE_SOURCE_REVISION, source); assert.equal(env.RELEASE297_PROFILE, profile);
  const url = new URL(env.DATABASE_URL); assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5437');
  assert.equal(url.pathname, '/schoolpilot_redesign_usage_scale_' + run);
  const role = decodeURIComponent(url.username); assert.match(role, /^[a-z][a-z0-9_]{1,62}$/);
  return { role, database: url.pathname.slice(1) };
}

/** Existing observer pool only; every borrowed client owns its full read-only
 * transaction and GUC/role cleanup. Raw SQL never reads aggregate rows. */
export function createDistinctObserverRpc({ pool, run, source, getFixture, env = process.env,
  privateDirectory = '/control', rawDependencies = canonicalRawDependencies, persistPrivateProof }) {
  assert.match(run, /^[a-f0-9]{12}$/); assert.match(source, /^[a-f0-9]{40}$/); assert.equal(pool.options.max, 2);
  let before, claimed = false, audited = false, proofOrdinal = 0, boundFixture;
  const persist = persistPrivateProof ?? (async record => {
    const bytes = JSON.stringify(record) + '\n', filename = `distinct-native-${++proofOrdinal}.private.json`;
    writeFileSync(join(privateDirectory, filename), bytes, { flag: 'wx', mode: 0o600 });
    return createHash('sha256').update(bytes).digest('hex');
  });
  async function read(cutoff) {
    const identity = runtimeIdentity(env, run, source), currentFixture = getFixture(); assert.equal(currentFixture.sourceRevision, source);
    boundFixture ??= structuredClone(currentFixture);
    assert.equal(fixtureIdentity(currentFixture), fixtureIdentity(boundFixture), 'Native fixture bindings changed');
    const fixture = boundFixture;
    assert.equal(iso(cutoff), cutoff); const dependencies = await rawDependencies();
    const schools = [], native = [], audits = [];
    for (const school of fixture.schools) {
      const client = await pool.connect(); let prior, begun = false, broken = false, failure;
      try {
        prior = (await client.query(scopeSql)).rows[0]; assert.equal(prior.database, identity.database);
        begun = true; await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query(`SET LOCAL ROLE "${identity.role}"`);
        await client.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)", [school.id]);
        const role = (await client.query("SELECT current_user AS role,rolsuper,rolbypassrls,current_setting('app.school_id') AS school,current_setting('app.is_super') AS is_super FROM pg_roles WHERE rolname=current_user")).rows[0];
        assert.equal(role.role, identity.role); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
        assert.equal(role.school, school.id); assert.equal(role.is_super, 'off');
        const window = (await client.query(`WITH boundary AS (SELECT school_timezone AS zone,
          $2::date::timestamp AT TIME ZONE school_timezone AS start_at,
          ($2::date+1)::timestamp AT TIME ZONE school_timezone AS end_at FROM schools WHERE id=$1)
          SELECT zone,(start_at AT TIME ZONE 'UTC')::text AS start,(end_at AT TIME ZONE 'UTC')::text AS end,
          (EXTRACT(EPOCH FROM start_at)*1000000)::bigint::text AS start_microseconds,
          (EXTRACT(EPOCH FROM end_at)*1000000)::bigint::text AS end_microseconds FROM boundary`, [school.id, fixture.today])).rows[0];
        assert.equal(window?.zone, 'America/New_York'); assert.ok(wall(cutoff) >= window.start && wall(cutoff) < window.end);
        const bounds = [school.id, window.start, wall(cutoff)];
        const expected = school.students.map((student_id, index) => ({ student_id, device_id: school.devices[index], session_id: school.studentSessions[index] }));
        const raw = (await client.query(DISTINCT_RAW_SQL, [...bounds, JSON.stringify(expected)])).rows;
        // Assert the raw slice's native school-local boundaries independently
        // of the oracle helper, which only knows the processed cutoff.
        assert.match(window.start_microseconds, /^\d+$/); assert.match(window.end_microseconds, /^\d+$/);
        const startMicros = BigInt(window.start_microseconds), endMicros = BigInt(Date.parse(cutoff)) * 1000n;
        assert.ok(endMicros >= startMicros && endMicros < BigInt(window.end_microseconds));
        assert.ok(raw.every(row => row.school_id === school.id && typeof row.timestamp_microseconds === 'string'
          && /^\d+$/.test(row.timestamp_microseconds) && BigInt(row.timestamp_microseconds) >= startMicros && BigInt(row.timestamp_microseconds) < endMicros));
        const counts = (await client.query(DISTINCT_ROSTER_SQL, [...bounds,
          JSON.stringify(school.students.map((student_id, index) => ({ student_id, group_id: school.groups[Math.floor(index / 5)] })))])).rows[0];
        const violations = dependencies.violations(raw, school.students, counts);
        const invalidBindings = raw.filter(row => row.valid_binding !== true).length;
        const from = new Date(Date.parse(fixture.today + 'T12:00:00Z') - 364 * 86_400_000).toISOString().slice(0, 10);
        const coverage = (await client.query(DISTINCT_COVERAGE_SQL, [school.id, from, fixture.today, window.zone])).rows;
        assert.ok(coverage.every(row => row.valid_window === true));
        const scoped = (await client.query(`SELECT (SELECT COUNT(*)::int FROM students WHERE school_id<>$1) AS students,
          (SELECT COUNT(*)::int FROM heartbeats WHERE school_id<>$1) AS heartbeats,
          (SELECT COUNT(*)::int FROM classpilot_usage_rollup_days WHERE school_id<>$1) AS coverage`, [school.id])).rows[0];
        assert.deepEqual(scoped, { students: 0, heartbeats: 0, coverage: 0 });
        const schoolAudits = (await client.query(auditSql, [school.id])).rows; audits.push(...schoolAudits);
        const counted = countDistinctCurrentObservations(raw, cutoff);
        schools.push({ schoolIndex: school.index, invalidRawBindings: invalidBindings,
          invalidClassificationOrRoster: Object.values(violations).reduce((sum, count) => sum + count, 0), ...counted,
          secondsByStudent: [...dependencies.seconds(raw, new Date(cutoff))].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
          coverage: coverage.map(row => ({ date: row.date, isFinal: row.is_final, processedThrough: iso(row.processed_through) })) });
        native.push({ schoolIndex: school.index, role, window, scoped, raw, counts, violations, coverage, auditRecords: schoolAudits });
        await client.query('COMMIT'); begun = false;
      } catch (error) {
        failure = error; if (begun) try { await client.query('ROLLBACK'); } catch { broken = true; }
      } finally {
        if (!prior) broken = true;
        if (!broken) try {
          const after = (await client.query(scopeSql)).rows[0];
          assert.equal(after.role, prior.role); assert.equal(after.database, prior.database);
          assert.equal(text(after.school), text(prior.school)); assert.equal(text(after.is_super), text(prior.is_super));
        } catch (error) { broken = true; failure ??= error; }
        client.release(broken);
      }
      if (failure) throw failure;
    }
    const oracle = { kind: 'distinct-report-independent-raw-coverage-v1', source, cutoff,
      aggregateRowsUsedForExpected: false, productReportCodeUsedForExpected: false,
      preparedActualWorkersVerified: true, coverageFrozenForOffering: true, schools };
    assertDistinctOracle(fixture, oracle); return { oracle, native, audits, rawPrefixSha256: rawPrefixHash(native) };
  }
  return {
    async oracle(request) {
      assert.equal(claimed, false); assert.equal(request.source, source); claimed = true;
      const data = await read(request.cutoff); assert.equal(data.audits.length, 0, 'Distinct operation requires its own fresh-restored audit state');
      const proofSha256 = await persist({ kind: 'distinct-report-native-before', run, source, cutoff: request.cutoff, ...data });
      assert.match(proofSha256, /^[a-f0-9]{64}$/); before = { ...data, proofSha256 }; return data.oracle;
    },
    async audit(request) {
      assert.ok(before); assert.equal(audited, false); assert.equal(request.source, source); assert.equal(request.cutoff, before.oracle.cutoff);
      assert.equal(request.oracleSha256, digest(before.oracle)); assert.equal(request.coverageBeforeSha256, coverageHash(before.oracle)); audited = true;
      const after = await read(request.cutoff), fixture = getFixture();
      assert.equal(digest(after.oracle), digest(before.oracle), 'Raw attribution/coverage prefix changed during the distinct operation');
      assert.equal(after.rawPrefixSha256, before.rawPrefixSha256, 'Native raw-row identities changed despite equal totals');
      const verified = assertDistinctAuditRecords(fixture, after.audits);
      const privateRawProofSha256 = await persist({ kind: 'distinct-report-native-after', run, source,
        beforeProofSha256: before.proofSha256, cutoff: request.cutoff, ...after }); assert.match(privateRawProofSha256, /^[a-f0-9]{64}$/);
      return { source, cutoff: request.cutoff, passed: true, coverageBeforeSha256: coverageHash(before.oracle),
        coverageAfterSha256: coverageHash(after.oracle), coverageUnchanged: true, auditCount: after.audits.length,
        auditRecordsSha256: digest(after.audits), expectedAuditKeysSha256: verified.expectedKeysSha256,
        rawOracleSha256: digest(after.oracle), privateRawProofSha256,
        violations: { invalidRawBindings: 0, invalidClassificationOrRoster: 0, coverageDifferences: 0, auditDifferences: 0, rawOracleDifferences: 0 } };
    },
  };
}
