import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DISTINCT_REPORT_CONTRACT, distinctReportCases, distinctCsvCases, distinctCanonicalKey,
  assertDistinctOracle, prepareDistinctReports, expectedDistinctReport, assertDistinctJson,
  assertDistinctCsv, assertDistinctAuditRecords, countDistinctCurrentObservations, runDistinctReports } from './distinct-reports.mjs';

const source = 'd'.repeat(40), today = '2026-10-04';
const dateBefore = days => new Date(Date.parse(today + 'T12:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
const fixture = { sourceRevision: source, today, heavyDate: dateBefore(2), emptyDate: dateBefore(3), gapDate: dateBefore(5),
  apiBases: ['http://127.0.0.1:4000', 'http://127.0.0.1:4001', 'http://127.0.0.1:4002'],
  schools: [0, 1].map(index => ({ index, id: `school${index}`, staff: `staff${index}`, cookie: `schoolpilot.sid=synthetic${index}`, csrf: 'synthetic',
    students: Array.from({ length: 500 }, (_, n) => `student${index}-${n}`), groups: Array.from({ length: 100 }, (_, n) => `class${index}-${n}`) })) };
const oracle = { kind: 'distinct-report-independent-raw-coverage-v1', source, cutoff: '2026-10-04T07:00:00.000Z',
  aggregateRowsUsedForExpected: false, productReportCodeUsedForExpected: false, preparedActualWorkersVerified: true, coverageFrozenForOffering: true,
  schools: fixture.schools.map(school => ({ schoolIndex: school.index, invalidRawBindings: 0, invalidClassificationOrRoster: 0, rawRows: 4, deduplicatedRows: 3,
    secondsByStudent: [[school.students[0], 13], [school.students[1], 22]], heartbeatsByStudent: [[school.students[0], 1], [school.students[1], 2]],
    coverage: Array.from({ length: 365 }, (_, n) => dateBefore(364 - n)).filter(date => date !== fixture.gapDate)
      .map(date => ({ date, isFinal: date !== today, processedThrough: date === today ? '2026-10-04T07:00:00.000Z' : date + 'T23:59:59.000Z' })) })) };
const prepared = prepareDistinctReports(fixture, oracle), cases = distinctReportCases(fixture);
const responseBody = expected => ({ schemaVersion: 1, measure: 'Monitored Browser Time', ...structuredClone(expected),
  scope: { ...expected.scope, label: 'Synthetic scope' }, generatedAt: '2026-10-04T07:00:01Z', computedAt: oracle.cutoff });
function csvBody(expected) {
  const minuteKeys = ['monitoredBrowserSeconds', 'instructionalSeconds', 'offTaskSeconds', 'unknownSeconds'];
  const numbers = row => [...minuteKeys.map(key => (row[key] / 60).toFixed(1)), String(row.activeMonitoredStudents), String(row.heartbeatCount)];
  const rows = [['Report', 'Monitored Browser Time'], ['Scope', expected.scope.kind], ['Label', 'Synthetic scope'], ['From', expected.range.from], ['To', expected.range.to],
    ['Time zone', expected.range.timeZone], ['Retained from', expected.range.retainedFrom], ['Partially expired', 'no'], ['Computed from', expected.range.computedFrom],
    ['Computed days', expected.range.computedDays], ['Requested retained days', expected.range.requestedDays],
    ['Unavailable dates', expected.range.unavailableDates.join('; ')], ['Data state', expected.dataState], ['Generated at', '2026-10-04T07:00:01Z'],
    ['Note', 'Synthetic browser observation note'], [],
    ['Date', 'Day state', 'Monitored Browser Time (minutes)', 'Instructional (minutes)', 'Off-task (minutes)', 'Unclassified (minutes)', 'Active monitored students', 'Heartbeats'],
    ...expected.byDay.map(row => [row.date, row.state, ...numbers(row)]), ['Total', '', ...numbers(expected.totals)], [],
    ['Top educational sites', 'Minutes'], ...expected.topEducationalDomains.map(row => [row.domain, (row.seconds / 60).toFixed(1)]), [],
    ['Top non-educational sites', 'Minutes'], ...expected.topNonEducationalDomains.map(row => [row.domain, (row.seconds / 60).toFixed(1)])];
  return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
}

test('distinct endpoint set has64 unique canonical slices and32 historical primary combinations', () => {
  assert.equal(cases.length, 64); assert.equal(new Set(cases.map(distinctCanonicalKey)).size, 64);
  assert.deepEqual([...new Set(cases.filter(row => row.scope === 'school').map(row => row.days))].sort((a, b) => a - b), [1, 2, 7, 8, 30, 31, 364, 365]);
  for (const wave of [0, 1, 2, 3]) assert.equal(cases.filter(row => row.wave === wave).length, 16);
  assert.equal(cases.filter(row => row.targetOrdinal === 0).length, 32);
  assert.equal(distinctCsvCases(fixture).length, 8);
  assert.ok(distinctCsvCases(fixture).filter(row => row.scope !== 'school').every(row => row.targetOrdinal === 1));
});
test('independent declared heavy oracle matches closed-form totals for alternate student/grade/class', () => {
  const find = scope => cases.find(row => row.wave === 3 && row.schoolIndex === 0 && row.scope === scope && row.targetOrdinal === 1);
  const student = expectedDistinctReport(fixture, find('student'), oracle).byDay.find(row => row.date === fixture.heavyDate);
  assert.equal(student.monitoredBrowserSeconds, 20005); assert.equal(student.instructionalSeconds, 10005);
  assert.equal(student.offTaskSeconds, 5000); assert.equal(student.unknownSeconds, 5000); assert.equal(student.heartbeatCount, 2000);
  const grade = expectedDistinctReport(fixture, find('grade'), oracle).byDay.find(row => row.date === fixture.heavyDate);
  assert.equal(grade.monitoredBrowserSeconds, 2000500); assert.equal(grade.instructionalSeconds, 1000500); assert.equal(grade.heartbeatCount, 200000);
  const group = expectedDistinctReport(fixture, find('class'), oracle).byDay.find(row => row.date === fixture.heavyDate);
  assert.equal(group.monitoredBrowserSeconds, 85025); assert.equal(group.instructionalSeconds, 42525); assert.equal(group.heartbeatCount, 8500);
  assert.equal(group.activeMonitoredStudents, 30);
});
test('coverage rejects missing computation masquerading as zero and requires actual fixed cutoff', () => {
  for (const mutate of [value => value.schools[0].coverage.push({ date: fixture.gapDate, isFinal: true }),
    value => value.schools[0].coverage.pop(), value => value.schools[0].coverage.at(-1).processedThrough = '2026-10-04T06:59:00Z',
    value => value.schools[0].coverage[0].processedThrough = null, value => value.cutoff = '2026-10-03T07:00:00Z',
    value => value.coverageFrozenForOffering = false, value => value.aggregateRowsUsedForExpected = true]) {
    const copy = structuredClone(oracle); mutate(copy); assert.throws(() => assertDistinctOracle(fixture, copy));
  }
});
test('raw oracle rejects foreign-school bindings, missing counts and invalid current classifications', () => {
  for (const mutate of [value => value.schools[0].secondsByStudent[0][0] = fixture.schools[1].students[0],
    value => value.schools[0].heartbeatsByStudent.pop(), value => value.schools[0].invalidClassificationOrRoster = 1,
    value => value.schools[0].secondsByStudent.pop(),
    value => value.schools[0].secondsByStudent.push(value.schools[0].secondsByStudent[0])]) {
    const copy = structuredClone(oracle); mutate(copy); assert.throws(() => assertDistinctOracle(fixture, copy));
  }
});
test('same-second persisted retries stay in raw evidence without inflating report heartbeats', () => {
  const item = cases.find(row => row.wave === 0 && row.schoolIndex === 0 && row.scope === 'school');
  assertDistinctOracle(fixture, oracle);
  const expected = expectedDistinctReport(fixture, item, oracle);
  assert.equal(expected.totals.heartbeatCount, 3); assert.equal(oracle.schools[0].rawRows, 4);
  const inflated = structuredClone(oracle); inflated.schools[0].heartbeatsByStudent[1][1]++;
  assert.throws(() => assertDistinctOracle(fixture, inflated));
});
test('independent current counts use exact microseconds and exclude the cutoff boundary', () => {
  const cutoff = '2026-10-04T07:00:00.000Z', end = BigInt(Date.parse(cutoff)) * 1000n;
  const rows = [[end - 2_000_000n, 'a'], [end - 1_999_999n, 'a'], [end - 1_000_000n, 'a'], [end - 1_000_000n, 'b'], [end, 'a']]
    .map(([timestamp, student_id]) => ({ student_id, timestamp_microseconds: String(timestamp) }));
  assert.deepEqual(countDistinctCurrentObservations(rows, cutoff), { rawRows: 4, deduplicatedRows: 3, heartbeatsByStudent: [['a', 2], ['b', 1]] });
  assert.throws(() => countDistinctCurrentObservations([{ student_id: 'a', timestamp_microseconds: 123 }], cutoff));
});
test('JSON rejects broadened identity, retention-coalesced ranges, numeric gaps and corrupted totals/domains', () => {
  const item = cases.find(row => row.wave === 3 && row.scope === 'student' && row.targetOrdinal === 1), expected = expectedDistinctReport(fixture, item, oracle);
  for (const mutate of [body => body.scope.id = fixture.schools[0].students[0], body => body.range.presentedFrom = fixture.today,
    body => body.byDay.push({ date: fixture.gapDate, state: 'final', ...body.totals }), body => body.totals.monitoredBrowserSeconds++,
    body => body.topEducationalDomains[0].seconds++, body => body.range.unavailableDates = []]) {
    const body = responseBody(expected); mutate(body); assert.throws(() => assertDistinctJson(body, expected));
  }
});
test('CSV validates unrounded source totals, day gaps and complete domain sections', () => {
  const expected = prepared.expectations.get(63), body = csvBody(expected); assertDistinctCsv(body, expected);
  assert.throws(() => assertDistinctCsv(body.replace('"Total","","', '"Total","","1'), expected));
  assert.throws(() => assertDistinctCsv(body.replace('"Top educational sites","Minutes"', '"Top educational sites","Seconds"'), expected));
  assert.throws(() => assertDistinctCsv(body.replace('"Unavailable dates","' + fixture.gapDate + '"', '"Unavailable dates",""'), expected));
  assert.throws(() => assertDistinctCsv(body.replace('"Date","Day state"', '"Date","Unknown state"'), expected));
  assert.throws(() => assertDistinctCsv(body + '"Unexplained extra row"\r\n', expected));
});
const auditRecords = () => distinctCsvCases(fixture).map(item => ({ action: 'classpilot.usage.export', school_id: item.schoolId,
  user_id: fixture.schools[item.schoolIndex].staff, entity_type: 'classpilot_usage_' + item.scope, entity_id: item.id ?? item.schoolId,
  metadata: { scope: item.scope, from: item.from, to: item.to } }));
test('all8 export audit identities are exact and reject missing, duplicate or wrong-school records', () => {
  assert.equal(assertDistinctAuditRecords(fixture, auditRecords()).passed, true);
  for (const mutate of [rows => rows.pop(), rows => rows[0] = rows[1], rows => rows[0].school_id = 'wrong',
    rows => rows[0].user_id = 'wrong', rows => rows[0].metadata.from = fixture.today, rows => rows[0].action = 'other']) {
    const rows = auditRecords(); mutate(rows); assert.throws(() => assertDistinctAuditRecords(fixture, rows));
  }
});

async function virtualRun(mutate = () => {}, modifications = {}) {
  let now = 1000, done = false, answer, failed; const sleepers = [], calls = [];
  const pause = ms => new Promise(resolve => sleepers.push({ at: now + ms, resolve }));
  const staffRequest = async (school, path, options) => {
    calls.push({ school: school.index, path, endpoint: options.endpoint, signal: options.signal });
    const query = new URLSearchParams(path.split('?')[1]), item = cases.find(row => row.schoolIndex === school.index && row.scope === query.get('scope')
      && row.id === query.get('id') && row.from === query.get('from') && row.to === query.get('to'));
    assert.ok(item); await pause(5);
    const expected = prepared.expectations.get(item.ordinal), response = { status: 200, body: query.get('format') === 'csv' ? csvBody(expected) : responseBody(expected) };
    mutate(response, item, query.get('format')); return response;
  };
  runDistinctReports({ fixture, schools: fixture.schools, staffRequest, oracle, prepared, startsAtMs: now,
    clock: () => now, pause, ...modifications }).then(value => { answer = value; done = true; }, error => { failed = error; done = true; });
  while (!done) {
    for (let n = 0; n < 25; n++) await Promise.resolve(); if (done) break;
    assert.ok(sleepers.length, 'Virtual operation stalled'); now = Math.min(...sleepers.map(row => row.at));
    const ready = sleepers.filter(row => row.at === now); for (const row of ready) sleepers.splice(sleepers.indexOf(row), 1); for (const row of ready) row.resolve();
  }
  if (failed) throw failed; return { result: answer, calls };
}
test('all64 distinct requests and8CSV traverse concurrent staff endpoint calls with honest deadlines', async () => {
  const { result, calls } = await virtualRun(); assert.equal(result.passed, true); assert.equal(result.capacityAcceptance, false);
  assert.equal(calls.length, 72); assert.ok(result.peakInFlight >= 16); assert.ok(calls.every(row => row.signal instanceof AbortSignal));
  assert.equal(new Set(result.reportCases.map(row => row.effectiveKeySha256)).size, 64);
  assert.equal(result.postOfferingNativeCoverageAuditAndOwnerDrainRequired, true);
});
test('busy/rejected reports cannot count as accepted capacity', async () => {
  const { result } = await virtualRun((response, item, format) => { if (item.ordinal === 0 && format === 'json') response.status = 503; });
  assert.equal(result.passed, false); assert.equal(result.reportCases[0].status, 503); assert.equal(result.reportCases[0].correct, false);
});
test('duplicate effective slices and successful incorrect responses fail the distinct endpoint gate', async () => {
  const { result } = await virtualRun((response, item, format) => { if (item.ordinal === 1 && format === 'json') response.body.range.presentedFrom = fixture.today; });
  assert.equal(result.passed, false); assert.equal(result.reportCases[1].correct, false);
});
test('aborted requests, expired staff cookies and stale preparation cannot silently pass', async () => {
  const controller = new AbortController(); controller.abort(); const aborted = await virtualRun(() => {}, { signal: controller.signal }); assert.equal(aborted.result.passed, false);
  await assert.rejects(virtualRun(() => {}, { schools: fixture.schools.map(row => ({ ...row, cookie: '' })) }));
  await assert.rejects(virtualRun(() => {}, { oracle: { ...oracle, cutoff: '2026-10-04T07:00:05Z' } }));
  await assert.rejects(virtualRun(() => {}, { fixture: { ...fixture, apiBases: Array(3).fill(fixture.apiBases[0]) } }));
  const duplicateCases = { ...prepared, cases: prepared.cases.map((row, index) => index === 1 ? prepared.cases[0] : row) };
  await assert.rejects(virtualRun(() => {}, { prepared: duplicateCases }));
});
test('mutated expected values cannot become authoritative by rebinding their stored hash', async () => {
  const expectations = new Map([...prepared.expectations].map(([ordinal, value]) => [ordinal, structuredClone(value)]));
  expectations.get(0).totals.monitoredBrowserSeconds++;
  const rebound = { ...prepared, expectations, expectedReportsSha256: createHash('sha256').update(JSON.stringify([...expectations])).digest('hex') };
  let offered = false;
  await assert.rejects(runDistinctReports({ fixture, schools: fixture.schools, oracle, prepared: rebound, startsAtMs: 1000,
    clock: () => 1000, staffRequest: async () => { offered = true; return { status: 200, body: responseBody(expectations.get(0)) }; } }));
  assert.equal(offered, false);
});
test('distinct contract is separately named and retains all public/report resources and deadlines', () => {
  assert.equal(DISTINCT_REPORT_CONTRACT.requests, 64); assert.equal(DISTINCT_REPORT_CONTRACT.publicDeadlineMs, 20000);
  assert.equal(DISTINCT_REPORT_CONTRACT.apiTasks, 3); assert.equal(DISTINCT_REPORT_CONTRACT.productPoolTimeoutDurabilityChanges, 0);
});
