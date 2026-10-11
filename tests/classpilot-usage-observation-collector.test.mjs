import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildLedgerObservationSql,
  assertPrivateObservationPaths,
  effectiveRetentionHoursSql,
  collectUsageObservation,
  localDayBounds,
  requiredHourlyBuckets,
  requiredObservationExportWindow,
  sha256,
  verifyUsageObservation,
} from '../scripts/collect-classpilot-usage-observation.mjs';
import { assertExactRecountSource, buildRetainedRecountInputSql, buildRetainedRecountSql } from '../scripts/classpilot-usage-retained-recount.mjs';

const HOUR = 3_600_000;
const SCHOOL_A = '11111111-1111-4111-8111-111111111111';
const SCHOOL_B = '22222222-2222-4222-8222-222222222222';
const STREAM = `scheduler-worker/scheduler-worker/${'a'.repeat(32)}`;
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

test('recount source validation refuses untracked source inputs before importing application helpers',()=>{
  const directory=mkdtempSync(join(tmpdir(),'schoolpilot-recount-source-'));
  const git=args=>{const result=spawnSync('git',['-C',directory,...args],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  try{
    mkdirSync(join(directory,'src'));writeFileSync(join(directory,'src/helper.ts'),'export const helper = true;\n');
    git(['init','-q']);git(['config','core.autocrlf','false']);git(['add','src']);
    git(['-c','user.name=Recount Test','-c','user.email=recount-test@example.invalid','-c','core.hooksPath='+join(directory,'absent-hooks'),'commit','-qm','synthetic source']);
    const source=git(['rev-parse','HEAD']);assertExactRecountSource(directory,source);
    assert.throws(()=>assertExactRecountSource(directory,'a'.repeat(40)),/exact serving source/);
    const untracked=join(directory,'src/helper.js');writeFileSync(untracked,"throw Error('Must never be imported');\n");
    assert.throws(()=>assertExactRecountSource(directory,source),/untracked src inputs/);
    rmSync(untracked);assertExactRecountSource(directory,source);
    appendFileSync(join(directory,'src/helper.ts'),'export const drift = true;\n');
    assert.throws(()=>assertExactRecountSource(directory,source),/modified or untracked/);
  }finally{assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(),'schoolpilot-recount-source-'))));rmSync(directory,{recursive:true,force:true});}
});

function fixture({ secondSchool = false, date = '2026-10-09', zone = 'America/New_York', retentionHours = 24 } = {}) {
  const serving = {
    appSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    apiArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-api:20',
    workerArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-scheduler-worker:30',
  };
  const schoolDays = [{ schoolId: SCHOOL_A, date, timeZone: zone }];
  if (secondSchool) schoolDays.push({ schoolId: SCHOOL_B, date, timeZone: 'America/Los_Angeles' });
  const first = Math.min(...schoolDays.map(day => localDayBounds(day.date, day.timeZone).start));
  const last = Math.max(...schoolDays.map(day => localDayBounds(day.date, day.timeZone).end)) + HOUR;
  const spec = {
    schemaVersion: 1, serving, workerLogStreams: [STREAM], startedAt: new Date(first).toISOString(), endedAt: new Date(last).toISOString(),
    reviewedAt: new Date(last + 90 * 60_000).toISOString().replace(/(\.\d{3})Z$/, '$10000Z'),
    reviewReference: 'private/usage-activation/20261010', schoolDays,
  };
  const bucketSet = new Set(schoolDays.flatMap(day => requiredHourlyBuckets(day.date, day.timeZone)));
  const logs = { events: [...bucketSet].sort((a, b) => a - b).map((bucket, index) => ({
    eventId: `actual-cloudwatch-event-${index}`, logStreamName: STREAM, timestamp: bucket + 1_000, ingestionTime: bucket + 1_100,
    message: JSON.stringify({
      event: 'classpilot_usage_rollup', schools: schoolDays.length,
      finalizedDays: 0, recomputedDays: schoolDays.length, unchangedDays: 0,
      retentionSkippedDays: 0, deferredDays: 0, failedSchools: 0, rowCount: 0,
      budgetExhausted: false, durationMs: 1_000, deadline: new Date(bucket + 25 * 60_000).toISOString(),
    }),
  })) };
  const ledger = {
    schemaVersion: 1, capturedAt: new Date(last + HOUR).toISOString(), serving: { ...serving }, eligibleSchoolCount: schoolDays.length, inventoryTruncated: false,
    schools: schoolDays.map(day => ({ schoolId: day.schoolId, timeZone: day.timeZone, retentionHours })),
    days: schoolDays.flatMap(day => {
      const { start, end } = localDayBounds(day.date, day.timeZone);
      const nextDate = new Date(Date.parse(`${day.date}T00:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
      const nextBounds = localDayBounds(nextDate, day.timeZone);
      return [
        { schoolId: day.schoolId, date: day.date, dayStartAt: new Date(start).toISOString(), dayEndAt: new Date(end).toISOString(), processedThrough: new Date(end).toISOString(), isFinal: true, computedAt: new Date(end + 1_000).toISOString() },
        { schoolId: day.schoolId, date: nextDate, dayStartAt: new Date(nextBounds.start).toISOString(), dayEndAt: new Date(nextBounds.end).toISOString(), processedThrough: new Date(nextBounds.start + 10).toISOString(), isFinal: false, computedAt: new Date(nextBounds.start + 1_000).toISOString() },
      ];
    }),
  };
  return { spec, logs, ledger, now: new Date(last + 2 * HOUR) };
}
function input(f) { return { specBytes: bytes(f.spec), logBytes: bytes(f.logs), ledgerBytes: bytes(f.ledger), now: f.now }; }
function collect(f) { return collectUsageObservation(input(f)); }
function mutateSample(f, index, change) {
  const sample = JSON.parse(f.logs.events[index].message);
  change(sample);
  f.logs.events[index].message = JSON.stringify(sample);
}
function refused(change, pattern, options) {
  const f = fixture(options); change(f);
  assert.throws(() => collect(f), pattern);
}

test('actual zero-row samples + successful ledger produce deterministic setter schema 1', () => {
  const f = fixture(), result = collect(f);
  assert.deepEqual(result.evidenceBytes, collect(f).evidenceBytes);
  assert.deepEqual(result.receiptBytes, collect(f).receiptBytes);
  assert.equal(result.evidence.schemaVersion, 1);
  assert.deepEqual(Object.keys(result.evidence), ['schemaVersion', 'reviewedAt', 'reviewReference', 'appSha', 'imageDigest', 'schoolDays']);
  assert.equal(result.evidence.schoolDays[0].observedRuns, 25);
  assert.equal(result.evidence.schoolDays[0].maxRunDurationMs, 1_000);
  assert.equal(result.evidence.schoolDays[0].finalDayComplete, true);
  assert.equal(result.evidence.schoolDays[0].currentDayComplete, true);
  assert.equal(result.evidence.schoolDays[0].logSha256, sha256(input(f).logBytes));
  assert.equal(result.evidence.schoolDays[0].coverageSha256, sha256(input(f).ledgerBytes));
  assert.equal(result.receipt.numericRecount.status, 'unavailable');
  assert.match(result.receipt.numericRecount.reason, /partly outside actual retention/);
});

test('every eligible school needs its own final and current ledger binding across timezones', () => {
  const f = fixture({ secondSchool: true }), result = collect(f);
  assert.equal(result.evidence.schoolDays.length, 2);
  assert.equal(result.receipt.checks.length, 2);
  assert.equal(result.evidence.schoolDays.every(day => day.observedRuns === 25), true);
  f.ledger.days = f.ledger.days.filter(day => day.schoolId !== SCHOOL_B);
  assert.throws(() => collect(f), /Missing or invalidated ledger day/);
});

test('hour buckets use elapsed UTC time over DST changes including repeated wall-clock hours', () => {
  const spring = localDayBounds('2026-03-08', 'America/New_York');
  const autumn = localDayBounds('2026-11-01', 'America/New_York');
  assert.equal(spring.end - spring.start, 23 * HOUR);
  assert.equal(autumn.end - autumn.start, 25 * HOUR);
  assert.equal(requiredHourlyBuckets('2026-03-08', 'America/New_York').length, 24);
  const buckets = requiredHourlyBuckets('2026-11-01', 'America/New_York');
  assert.equal(buckets.length, 26);
  assert.equal(new Set(buckets).size, 26);
  assert.ok(buckets.includes(Date.parse('2026-11-01T05:00:00Z')));
  assert.ok(buckets.includes(Date.parse('2026-11-01T06:00:00Z')));
  assert.equal(requiredHourlyBuckets('2026-10-09', 'Asia/Kolkata').length, 25);
  for (const date of ['2026-04-05', '2026-10-04']) {
    const bounds = localDayBounds(date, 'Australia/Lord_Howe');
    assert.equal(requiredHourlyBuckets(date, 'Australia/Lord_Howe').length, Math.ceil((bounds.end - bounds.start) / HOUR) + 1);
    const exportWindow = requiredObservationExportWindow([{ date, timeZone: 'Australia/Lord_Howe' }]);
    assert.ok(Date.parse(exportWindow.startedAt) <= Math.min(bounds.start, requiredHourlyBuckets(date, 'Australia/Lord_Howe')[0]));
    assert.equal(Date.parse(exportWindow.endedAt), bounds.end + HOUR);
  }
  const fractionalSpring = localDayBounds('2026-10-04', 'Australia/Lord_Howe');
  assert.equal(Date.parse(requiredObservationExportWindow([{ date: '2026-10-04', timeZone: 'Australia/Lord_Howe' }]).startedAt), fractionalSpring.start - HOUR / 2);
});

test('DST weekdays work while Sunday evidence remains refused', () => {
  const f = fixture({ date: '2026-11-02' });
  assert.equal(collect(f).evidence.schoolDays[0].observedRuns, 25);
  refused(() => {}, /weekdays/, { date: '2026-11-01' });
});

test('clean restart duplicates are checked but do not increase observed hourly runs', () => {
  const f = fixture();
  f.logs.events.push({ ...f.logs.events[2], eventId: 'restart-new-run', timestamp: f.logs.events[2].timestamp + 1_000 });
  const result = collect(f);
  assert.equal(result.evidence.schoolDays[0].observedRuns, 25);
  assert.equal(result.receipt.checks[0].duplicateHourSamples, 1);
  f.logs.events.splice(3, 1);
  assert.throws(() => collect(f), /Missing hourly bucket/);
});

test('a dirty duplicate cannot hide behind a clean sample from the same hour', () => {
  const f = fixture();
  f.logs.events.push({ ...f.logs.events[1], eventId: 'restart-dirty-run' });
  mutateSample(f, f.logs.events.length - 1, sample => { sample.failedSchools = 1; });
  assert.throws(() => collect(f), /failures/);
});

test('duplicate event identity, empty export and unfinished pagination are refused', () => {
  refused(f => { f.logs.events.push({ ...f.logs.events[0] }); }, /Duplicate or absent log eventId/);
  refused(f => { f.logs.events = []; }, /Worker log events/);
  refused(f => { f.logs.nextToken = 'another-page'; }, /pagination token/);
  refused(f => { f.logs.events[0].logStreamName = `scheduler-worker/scheduler-worker/${'c'.repeat(32)}`; }, /unbound worker stream/);
});

test('all counters must be actual, integer, complete and clean', () => {
  for (const counter of ['failedSchools', 'deferredDays', 'retentionSkippedDays']) refused(f => mutateSample(f, 0, sample => { sample[counter] = 1; }), /failures/);
  refused(f => mutateSample(f, 0, sample => { sample.budgetExhausted = true; }), /exhausted budget/);
  refused(f => mutateSample(f, 0, sample => { delete sample.failedSchools; }), /must contain exactly/);
  refused(f => mutateSample(f, 0, sample => { sample.rowCount = '0'; }), /must be an integer/);
  refused(f => mutateSample(f, 0, sample => { sample.unchangedDays = -1; }), /must be an integer/);
  refused(f => mutateSample(f, 0, sample => { sample.recomputedDays = 0; }), /account for every/);
  refused(f => mutateSample(f, 0, sample => { sample.schools = 0; }), /school count/);
});

test('setter runtime threshold is strict and scheduler UTC budget timestamps must fit', () => {
  for (const value of [0, 1_500_000]) refused(f => mutateSample(f, 0, sample => { sample.durationMs = value; }), /duration/);
  refused(f => mutateSample(f, 0, sample => { sample.deadline = '2026-10-09T04:24:00.000Z'; }), /actual UTC scheduler hour/);
  refused(f => { f.logs.events[0].timestamp = Date.parse('2026-10-09T04:26:00.001Z'); }, /does not fit/);
  refused(f => { f.logs.events[0].timestamp += 2 * HOUR; }, /does not fit/);
});

test('idle next-day unchanged coverage keeps its actual old processed cutoff', () => {
  const f = fixture();
  for (let index = 0; index < f.logs.events.length; index++) mutateSample(f, index, sample => { sample.recomputedDays = 0; sample.unchangedDays = 1; });
  assert.equal(collect(f).receipt.checks[0].currentDay.processedThrough, '2026-10-10T04:00:00.010Z');
  assert.notEqual(collect(f).receipt.checks[0].currentDay.computedAt, f.ledger.capturedAt);
});

test('successful empty next-day midnight cutoff and an admitted in-flight completion remain valid', () => {
  const f = fixture();
  f.ledger.days[1].processedThrough = f.ledger.days[1].dayStartAt;
  f.logs.events[0].timestamp = Date.parse('2026-10-09T04:25:30Z');
  mutateSample(f, 0, sample => { sample.durationMs = 40_000; });
  assert.equal(collect(f).receipt.checks[0].currentDay.processedThrough, '2026-10-10T04:00:00.000Z');
  f.ledger.days[1].processedThrough = '2026-10-10T03:59:59.999Z';
  assert.throws(() => collect(f), /valid processed cutoff/);
});

test('missing, invalidated, duplicate, partial and wrong-state ledger days cannot become zero coverage', () => {
  refused(f => { f.ledger.days = []; }, /Missing or invalidated/);
  refused(f => { f.ledger.days.pop(); }, /Missing or invalidated/);
  refused(f => { f.ledger.days.push({ ...f.ledger.days[0] }); }, /duplicate school\/day/);
  refused(f => { f.ledger.days[0].isFinal = false; }, /final\/live state/);
  refused(f => { f.ledger.days[0].processedThrough = '2026-10-10T03:59:00Z'; }, /completely finalized/);
  refused(f => { f.ledger.days[1].isFinal = true; }, /final\/live state/);
  refused(f => { f.ledger.days[1].processedThrough = '2026-10-10T03:59:59.999Z'; }, /valid processed cutoff/);
});

test('coverage boundaries, cutoff, computedAt and capture must bind actual date and timezone', () => {
  refused(f => { f.ledger.days[0].dayStartAt = '2026-10-09T00:00:00Z'; }, /boundaries/);
  refused(f => { f.ledger.days[1].processedThrough = '2026-10-10T11:00:00Z'; }, /cutoff\/computation/);
  refused(f => { f.ledger.days[1].computedAt = '2026-10-10T11:00:00Z'; }, /cutoff\/computation/);
  refused(f => { f.ledger.days[0].computedAt = '2026-10-10T03:59:00Z'; }, /cutoff\/computation/);
  refused(f => { f.spec.schoolDays[0].timeZone = 'America/Los_Angeles'; }, /school\/timezone/);
  refused(f => { f.spec.schoolDays[0].timeZone = 'Mars/Olympus'; }, /Invalid timeZone/);
});

test('whole eligible inventory cannot omit schools, truncate, duplicate or use fleet count as coverage', () => {
  refused(f => { f.spec.schoolDays.pop(); }, /schoolDays/);
  refused(f => { f.ledger.inventoryTruncated = true; }, /incomplete, truncated/);
  refused(f => { f.ledger.eligibleSchoolCount = 2; }, /omitted schools/);
  refused(f => { f.spec.schoolDays.pop(); }, /omitted schools/, { secondSchool: true });
  refused(f => { f.ledger.schools[1] = { ...f.ledger.schools[0] }; }, /Duplicate or invalid inventory/, { secondSchool: true });
  refused(f => { f.spec.schoolDays[0].schoolId = SCHOOL_B; }, /unexpected/);
});

test('exact source SHA, image digest and both serving ARNs are required', () => {
  for (const key of ['appSha', 'imageDigest', 'apiArn', 'workerArn']) {
    refused(f => { f.ledger.serving[key] = key === 'appSha' ? 'c'.repeat(40) : key === 'imageDigest' ? `sha256:${'c'.repeat(64)}` : f.ledger.serving[key].replace(/:\d+$/, ':99'); }, /exact serving identity/);
  }
  refused(f => { f.spec.serving.appSha = 'a'.repeat(12); }, /full lower-case source SHA/);
  refused(f => { f.spec.serving.imageDigest = 'schoolpilot:latest'; }, /exact digest/);
});

test('reviews, coverage and watched windows reject stale and future evidence', () => {
  refused(f => { f.now = new Date(f.now.getTime() + 3 * HOUR); }, /Review timestamp is stale/);
  refused(f => { f.spec.reviewedAt = new Date(f.now.getTime() + 6 * 60_000).toISOString().replace(/(\.\d{3})Z$/, '$10000Z'); }, /future/);
  refused(f => { f.spec.reviewedAt = f.now.toISOString(); }, /seven fractional digits/);
  refused(f => { f.ledger.capturedAt = '2026-10-10T04:59:59.000Z'; }, /predates the observation/);
  refused(f => { f.spec.endedAt = '2026-10-10T04:59:59.000Z'; }, /following finalization hour/);
  refused(f => { f.spec.startedAt = '2026-10-09T04:00:00.001Z'; }, /outside the declared export window|whole school-local day/);
  refused(f => { f.ledger.capturedAt = '2026-10-11T06:00:00Z'; }, /future-dated/);
});

test('a retained final ledger remains admissible when one-day raw retention prevents an independent recount', () => {
  const f = fixture(); f.ledger.schools[0].retentionHours = 24;
  const result = collect(f);
  assert.equal(result.evidence.schoolDays[0].finalDayComplete, true);
  assert.equal(result.receipt.checks[0].retention.rawDayWhollyRetained, false);
  assert.equal(result.receipt.checks[0].retention.aggregateRetainedFrom, '2026-10-09');
  assert.equal(result.receipt.checks[0].retention.reportRetainedFrom, '2026-10-10');
  assert.match(result.receipt.checks[0].rawRecount.reason, /partly purged/);
  refused(f => { delete f.ledger.schools[0].retentionHours; }, /exactly/);
  refused(f => { f.ledger.schools[0].retentionHours = 25; }, /whole days/);
});

test('replay re-reads exact bytes and re-enforces current review freshness', () => {
  const f = fixture(), raw = input(f), result = collectUsageObservation(raw);
  assert.deepEqual(verifyUsageObservation({ ...raw, ...result }), { verified: true, evidenceSha256: sha256(result.evidenceBytes), schools: 1, numericRecount: result.receipt.numericRecount });
  assert.throws(() => verifyUsageObservation({ ...raw, ...result, now: new Date(f.now.getTime() + 3 * HOUR) }), /Review timestamp is stale/);
  assert.throws(() => verifyUsageObservation({ ...raw, ...result, logBytes: Buffer.concat([raw.logBytes, Buffer.from(' ')]) }), /hash changed|input bytes changed/);
  assert.throws(() => verifyUsageObservation({ ...raw, ...result, ledgerBytes: Buffer.concat([raw.ledgerBytes, Buffer.from('\n')]) }), /hash changed|input bytes changed/);
  assert.throws(() => verifyUsageObservation({ ...raw, ...result, specBytes: Buffer.concat([raw.specBytes, Buffer.from('\n')]) }), /input bytes changed/);
  assert.throws(() => verifyUsageObservation({ ...raw, ...result, evidenceBytes: bytes({ ...result.evidence, appSha: 'c'.repeat(40) }) }), /Evidence bytes/);
  assert.throws(() => verifyUsageObservation({ ...raw, ...result, receiptBytes: bytes({ ...result.receipt, numericRecount: { status: 'passed' } }) }), /Replay receipt/);
});

test('malformed JSON, duplicate properties and content-bearing ledger extras are refused', () => {
  const f = fixture(), raw = input(f);
  assert.throws(() => collectUsageObservation({ ...raw, specBytes: Buffer.from('{"schemaVersion":1,"schemaVersion":1}') }), /duplicate JSON property/);
  assert.throws(() => collectUsageObservation({ ...raw, logBytes: Buffer.from('{broken') }), /not valid JSON/);
  assert.throws(() => collectUsageObservation({ ...raw, ledgerBytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw.ledgerBytes]) }), /BOM/);
  refused(f => { f.ledger.days[0].studentId = SCHOOL_A; }, /exactly/);
  refused(f => { f.ledger.days[0].urls = []; }, /exactly/);
});

test('read-only SQL acquisition is bounded and school/date scoped with complete eligible predicate', () => {
  const f = fixture({ secondSchool: true }), sql = buildLedgerObservationSql(f.spec);
  assert.match(sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(sql, /statement_timeout = '10s'/);
  assert.match(sql, /lock_timeout = '2s'/);
  assert.match(sql, /LIMIT 1001/);
  assert.match(sql, /ledger.school_id = requested.school_id AND ledger.usage_date = requested.usage_date/);
  assert.match(sql, /license.expires_at IS NULL OR license.expires_at > now\(\)/);
  assert.match(sql, /school.disabled_at IS NULL AND school.deleted_at IS NULL/);
  assert.match(sql, /school.plan_status <> 'canceled'/);
  assert.match(sql, /'inventoryTruncated'/);
  assert.match(sql, /'processedThrough'/);
  assert.ok(sql.includes(f.spec.serving.appSha));
  assert.ok(sql.includes(SCHOOL_A) && sql.includes(SCHOOL_B));
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
  assert.doesNotMatch(sql, /set_config|app\.is_super|heartbeats|active_tab_url|student_id/);
});

test('CLI help documents real input shapes, replay and numerical-proof limitations', () => {
  const result = spawnSync(process.execPath, ['scripts/collect-classpilot-usage-observation.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const text of ['filter-log-events', 'ledger-sql', 'eligibleSchoolCount', 'retentionHours', 'seven', 'No raw numerical recount', 'verify', 'EVERY eligible school']) assert.ok(result.stdout.includes(text), text);
});

function recountFixture(f) {
  const watched = f.spec.schoolDays[0];
  f.ledger.schools.find(school => school.schoolId === watched.schoolId).retentionHours = 720;
  const context = {
    schemaVersion: 1, capturedAt: f.ledger.capturedAt, serving: f.spec.serving,
    schoolId: watched.schoolId, date: watched.date, timeZone: watched.timeZone, retentionHours: 720,
    trackingSettings: { retention_hours: '720', enable_tracking_hours: true, tracking_start_time: '07:00', tracking_end_time: '17:00', tracking_days: ['Friday'], after_hours_mode: 'off' },
    trackingEventsTruncated: false,
    trackingEvents: [
      { studentId: SCHOOL_A, eventType: 'monitoring_state_changed', origin: 'server', occurredAt: '2026-10-09T14:00:00.000000Z', metadata: { state: 'off' } },
      { studentId: SCHOOL_A, eventType: 'monitoring_state_changed', origin: 'server', occurredAt: '2026-10-09T14:30:00.000000Z', metadata: { state: 'active' } },
    ],
  };
  const contextBytes = bytes(context);
  const result = {
    schemaVersion: 1, capturedAt: f.ledger.capturedAt, serving: f.spec.serving, schoolId: watched.schoolId, date: watched.date, timeZone: watched.timeZone,
    contextSha256: sha256(contextBytes), trackingPolicySha256: sha256(Buffer.from(JSON.stringify(context.trackingSettings))), trackingEventsSha256: sha256(Buffer.from(JSON.stringify(context.trackingEvents))),
    retentionHours: 720, rawDayWhollyRetained: true, rawHeartbeatsComplete: true, trackingEventsComplete: true,
    basis: 'retained-input-reread-canonical-algorithm', independentReferenceAlgorithm: false,
    rawHeartbeatCount: 5, recountSeconds: 30, persistedSeconds: 30, recountHeartbeatCount: 2, persistedHeartbeatCount: 2, secondsMatch: true, heartbeatCountMatch: true,
  };
  return { context, result, contextBytes, resultBytes: bytes(result) };
}

test('actual optional recount exports bind exact context/policy/event bytes and matching numerical totals', () => {
  const f = fixture({ secondSchool: true }), recount = recountFixture(f);
  const raw = { ...input(f), recounts: [{ contextBytes: recount.contextBytes, resultBytes: recount.resultBytes }] };
  const result = collectUsageObservation(raw);
  assert.equal(result.receipt.numericRecount.status, 'partial_retained_input_checks_passed');
  assert.equal(result.receipt.checks[0].rawRecount.status, 'retained_input_check_passed');
  assert.equal(result.receipt.checks[1].rawRecount.status, 'unavailable');
  assert.equal(result.receipt.inputs.recounts[0].contextSha256, sha256(recount.contextBytes));
  assert.equal(verifyUsageObservation({ ...raw, ...result }).verified, true);
  const changed = { ...raw, recounts: [{ contextBytes: recount.contextBytes, resultBytes: Buffer.concat([recount.resultBytes, Buffer.from(' ')]) }] };
  assert.throws(() => verifyUsageObservation({ ...changed, ...result }), /Replay receipt/);
});

test('a wholly retained watched raw day cannot pass by omitting its required actual numerical recount', () => {
  refused(() => {}, /requires an actual passed recount/, { retentionHours: 720 });
});

test('optional raw recount refuses mismatches, incomplete inputs, changed identity/context and partial raw retention', () => {
  const mutate = (change, pattern) => {
    const f = fixture(), recount = recountFixture(f); change(recount, f);
    assert.throws(() => collectUsageObservation({ ...input(f), recounts: [{ contextBytes: bytes(recount.context), resultBytes: bytes(recount.result) }] }), pattern);
  };
  mutate(r => { r.result.persistedSeconds = 31; }, /does not match persisted totals/);
  mutate(r => { r.result.heartbeatCountMatch = false; }, /does not match persisted totals/);
  mutate(r => { r.result.rawHeartbeatsComplete = false; }, /completeness/);
  mutate(r => { r.context.trackingEventsTruncated = true; }, /truncated/);
  mutate(r => { r.context.trackingSettings.tracking_start_time = '08:00'; }, /hashes changed/);
  mutate(r => { r.result.serving = { ...r.result.serving, appSha: 'c'.repeat(40) }; }, /exact serving identity/);
  mutate((r, f) => { r.context.retentionHours = 24; r.result.retentionHours = 24; f.ledger.schools[0].retentionHours = 24; }, /raw recount window/);
});

test('optional recount SQL uses the actual application tracking exclusions and a bounded read-only canonical grain query', async () => {
  const f = fixture(), recount = recountFixture(f);
  const { tsImport } = await import('tsx/esm/api');
  const application = await tsImport(new URL('../src/services/classpilotUsageRollup.ts', import.meta.url).href, import.meta.url);
  const sql = buildRetainedRecountSql({ spec: f.spec, context: recount.context, contextBytes: recount.contextBytes, now: f.now, application });
  assert.match(sql, /READ ONLY/);
  assert.match(sql, /LIMIT 1000001/);
  assert.match(sql, /actual_tracking_events_guard/);
  assert.match(sql, /retained_policy_guard/);
  assert.match(sql, /final_ledger_guard/);
  assert.match(sql, /'contextSha256'/);
  assert.ok(sql.includes(sha256(recount.contextBytes)));
  assert.match(sql, /2026-10-09 14:00:00\.000/);
  assert.match(sql, /2026-10-09 14:30:00\.000/);
  assert.match(sql, /2026-10-09 11:00:00\.000/);
  assert.match(sql, /'secondsMatch', recount.seconds = persisted.seconds/);
  assert.doesNotMatch(sql, /\b(?:INSERT INTO|UPDATE classpilot|DELETE FROM|ALTER TABLE|DROP TABLE)\b/);
  assert.doesNotMatch(sql, /app\.is_super|app\.school_id/);
  const inputSql = buildRetainedRecountInputSql(f.spec, SCHOOL_A);
  assert.match(inputSql, /tracking.school_id = '11111111-1111-4111-8111-111111111111'/);
  assert.match(inputSql, /LIMIT 10001/);
  assert.doesNotMatch(inputSql, /active_tab_url/);
});

test('collector refuses output artifacts within any repository before writing', () => {
  assert.throws(() => assertPrivateObservationPaths({ outputs: [fileURLToPath(new URL('../evidence.json', import.meta.url))] }), /outside the repository/);
});

test('retention SQL parses the actual TEXT column with bounded casts and shared application fallback rules', () => {
  const sql = effectiveRetentionHoursSql('settings.retention_hours');
  assert.match(sql, /btrim\(settings.retention_hours, U&'/);
  assert.match(sql, /\^\[0-9\]\+\$/);
  assert.match(sql, /length\(ltrim\(/);
  assert.match(sql, /BETWEEN 1 AND 4/);
  assert.match(sql, /BETWEEN 24 AND 8760/);
  assert.match(sql, /::integer % 24 = 0/);
  assert.match(sql, /ELSE 720 END ELSE 720 END/);
  assert.throws(() => effectiveRetentionHoursSql('settings.retention_hours); DELETE FROM schools;'), /fixed qualified column/);
});

test('CLI writes private artifacts, verifies original bytes, and refuses overwrite/tamper', t => {
  const powershell = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true });
  if (powershell.error?.code === 'ENOENT') { t.skip('PowerShell is required by the private artifact ACL helper'); return; }
  assert.equal(powershell.status, 0, powershell.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'schoolpilot-usage-observation-cli-'));
  const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
  try {
    const helper = fileURLToPath(new URL('../scripts/private-permissions.ps1', import.meta.url));
    const setup = `. ${psLiteral(helper)}\nSet-PrivatePathPermissions -Path ${psLiteral(directory)} -Directory\nAssert-PrivatePathPermissions -Path ${psLiteral(directory)} -Directory`;
    const initialized = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(setup, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    assert.equal(initialized.status, 0, initialized.stderr);
    const f = fixture();
    const paths = Object.fromEntries(['spec', 'logs', 'ledger', 'evidence', 'receipt'].map(name => [name, join(directory, `${name}.json`)]));
    for (const name of ['spec', 'logs', 'ledger']) writeFileSync(paths[name], bytes(f[name]), { mode: 0o600 });
    assertPrivateObservationPaths({ protect: ['spec', 'logs', 'ledger'].map(name => paths[name]) });
    const script = fileURLToPath(new URL('../scripts/collect-classpilot-usage-observation.mjs', import.meta.url));
    const base = ['--spec', paths.spec, '--logs', paths.logs, '--ledger', paths.ledger, '--receipt', paths.receipt, '--now', f.now.toISOString()];
    const collected = spawnSync(process.execPath, [script, 'collect', ...base, '--out', paths.evidence], { encoding: 'utf8', windowsHide: true });
    assert.equal(collected.status, 0, collected.stderr);
    assertPrivateObservationPaths({ inputs: [paths.evidence, paths.receipt] });
    const verified = spawnSync(process.execPath, [script, 'verify', ...base, '--evidence', paths.evidence], { encoding: 'utf8', windowsHide: true });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verified, true);
    const original = readFileSync(paths.evidence);
    const overwrite = spawnSync(process.execPath, [script, 'collect', ...base, '--out', paths.evidence], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /already exists/);
    assert.deepEqual(readFileSync(paths.evidence), original);
    appendFileSync(paths.logs, ' ');
    const tampered = spawnSync(process.execPath, [script, 'verify', ...base, '--evidence', paths.evidence], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /hash changed|input bytes changed/);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'schoolpilot-usage-observation-cli-'))));
    rmSync(directory, { recursive: true, force: true });
  }
});
