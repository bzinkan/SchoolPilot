import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { schoolDayObservation } from '../school-day-profile.mjs';

// A new endpoint acceptance operation. The historical 64-request matrix and
// serial observer query-plan diagnostic keep their original contracts.
export const DISTINCT_REPORT_CONTRACT = Object.freeze({
  name: 'release297-usage-distinct-authenticated64-v1',
  requests: 64, waves: 4, waveOffsetsMs: Object.freeze([0, 15_000, 30_000, 45_000]),
  requestsPerWave: 16, apiTasks: 3, csvRequests: 8,
  publicDeadlineMs: 20_000, maximumOfferLatenessMs: 100,
  timingClock: 'monotonic-epoch; explicit fixed offering offsets',
  primaryRanges: Object.freeze([1, 7, 30, 365]),
  alternateSchoolRanges: Object.freeze([2, 8, 31, 364]),
  scopes: Object.freeze(['school', 'grade', 'class', 'student']),
  staffAuthentication: 'existing-real-password-login-session-cookie-csrf',
  expectedData: 'declared-history-and-observations-plus-independent-current-raw-oracle',
  databaseState: 'source-bound restored fixture; actual-worker coverage prepared before distinct offers; not cold first-computation evidence',
  requiredPreparation: 'actual-heavy/current-workers-complete-before-offers; independently-verified-fixed-coverage-cutoff',
  requiredAfterOffering: 'native-coverage-identity-unchanged-plus-exact-eight-export-audits-and-normal-owner-drain',
  productPoolTimeoutDurabilityChanges: 0,
});
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const distinctReportContractHash = () => digest(DISTINCT_REPORT_CONTRACT);
const localDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
const dateBefore = (today, days) => new Date(Date.parse(today + 'T12:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
const datesFor = (today, days) => Array.from({ length: days }, (_, index) => dateBefore(today, days - index - 1));
const safeWhole = value => Number.isSafeInteger(value) && value >= 0;

function assertFixture(fixture) {
  assert.ok(localDate(fixture.today));
  assert.equal(fixture.heavyDate, dateBefore(fixture.today, 2));
  assert.equal(fixture.emptyDate, dateBefore(fixture.today, 3));
  assert.equal(fixture.gapDate, dateBefore(fixture.today, 5));
  assert.equal(fixture.schools.length, 2);
  assert.equal(new Set(fixture.schools.map(row => row.id)).size, 2);
  assert.equal(new Set(fixture.schools.flatMap(row => row.students)).size, 1000);
  assert.equal(new Set(fixture.schools.flatMap(row => row.groups)).size, 200);
  for (const [index, school] of fixture.schools.entries()) {
    assert.equal(school.index, index); assert.equal(school.students.length, 500); assert.equal(school.groups.length, 100);
    assert.equal(new Set(school.students).size, 500); assert.equal(new Set(school.groups).size, 100);
    assert.ok(typeof school.staff === 'string' && school.staff.length > 0);
  }
}

export function distinctReportCases(fixture) {
  assertFixture(fixture);
  const cases = [];
  for (let wave = 0; wave < DISTINCT_REPORT_CONTRACT.waves; wave++) {
    for (const school of fixture.schools) for (const scope of DISTINCT_REPORT_CONTRACT.scopes) for (const alternate of [false, true]) {
      const days = scope === 'school' && alternate ? DISTINCT_REPORT_CONTRACT.alternateSchoolRanges[wave] : DISTINCT_REPORT_CONTRACT.primaryRanges[wave];
      const targetOrdinal = alternate ? 1 : 0;
      const id = scope === 'school' ? null : scope === 'grade' ? String(6 + targetOrdinal) : scope === 'class' ? school.groups[targetOrdinal] : school.students[targetOrdinal];
      cases.push({ ordinal: cases.length, wave, schoolIndex: school.index, schoolId: school.id, scope, id, targetOrdinal,
        days, from: dateBefore(fixture.today, days - 1), to: fixture.today, endpointIndex: cases.length % 3 });
    }
  }
  assert.equal(cases.length, 64);
  assert.equal(new Set(cases.map(distinctCanonicalKey)).size, 64);
  return cases;
}
export function distinctCanonicalKey(item) { return digest([item.schoolId, item.scope, item.id, item.from, item.to]); }
export function distinctCsvCases(fixture) {
  return distinctReportCases(fixture).filter(row => row.wave === 3 && (row.scope === 'school' ? row.targetOrdinal === 0 : row.targetOrdinal === 1));
}

// Companion to the independent exact-microsecond attribution oracle. The
// observer passes raw current-day rows, never aggregate/worker output.
export function countDistinctCurrentObservations(rows, cutoff) {
  const parsed = new Date(cutoff); assert.ok(Number.isSafeInteger(parsed.getTime()));
  const through = BigInt(parsed.getTime()) * 1000n, seen = new Map(); let rawRows = 0;
  for (const row of rows) {
    assert.ok(typeof row.student_id === 'string' && row.student_id.length > 0);
    assert.equal(typeof row.timestamp_microseconds, 'string'); assert.match(row.timestamp_microseconds, /^-?\d{1,20}$/);
    const at = BigInt(row.timestamp_microseconds); if (at >= through) continue;
    const second = at >= 0n ? at / 1_000_000n : (at - 999_999n) / 1_000_000n;
    const seconds = seen.get(row.student_id) ?? new Set(); seconds.add(second); seen.set(row.student_id, seconds); rawRows++;
  }
  const heartbeatsByStudent = [...seen].map(([id, seconds]) => [id, seconds.size]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { rawRows, deduplicatedRows: heartbeatsByStudent.reduce((sum, [, count]) => sum + count, 0), heartbeatsByStudent };
}

const scopeMath = new Map();
function allowedStudents(item, historical = false) {
  return Array.from({ length: 500 }, (_, index) => index).filter(index => item.scope === 'school'
    || (item.scope === 'grade' && index % 5 === item.targetOrdinal)
    || (item.scope === 'student' && index === item.targetOrdinal)
    || (item.scope === 'class' && (!historical || Math.floor(index / 5) === item.targetOrdinal)));
}
const empty = () => ({ monitoredBrowserSeconds: 0, instructionalSeconds: 0, offTaskSeconds: 0, unknownSeconds: 0,
  activeMonitoredStudents: 0, heartbeatCount: 0 });
const domains = () => ({ educational: new Map(), nonEducational: new Map() });
const addDomain = (target, category, domain, seconds) => { if (seconds) target[category].set(domain, (target[category].get(domain) ?? 0) + seconds); };
function declaredScopeMath(item) {
  const key = item.scope + '/' + (item.scope === 'school' ? 0 : item.targetOrdinal);
  if (scopeMath.has(key)) return scopeMath.get(key);
  const heavy = empty(), heavyDomains = domains(), heavyStudents = new Set();
  // Independent fixture arithmetic; no product report/rollup code or stored
  // aggregate rows. Prepare it before timed offers to avoid generator stalls.
  for (const student of allowedStudents(item)) for (let sample = 0; sample < 2000; sample++) {
    const observation = schoolDayObservation(student, sample);
    if (item.scope === 'class' && observation.classIndex !== item.targetOrdinal) continue;
    heavy.monitoredBrowserSeconds += observation.attributedSeconds; heavy.heartbeatCount++;
    const field = observation.classification === 'educational' ? 'instructionalSeconds' : observation.classification === 'non-educational' ? 'offTaskSeconds' : 'unknownSeconds';
    heavy[field] += observation.attributedSeconds; heavyStudents.add(student);
    if (field !== 'unknownSeconds') addDomain(heavyDomains, field === 'instructionalSeconds' ? 'educational' : 'nonEducational', observation.domain, observation.attributedSeconds);
  }
  heavy.activeMonitoredStudents = heavyStudents.size;
  const historicalStudents = allowedStudents(item, true), historical = empty();
  Object.assign(historical, { monitoredBrowserSeconds: historicalStudents.length * 90, instructionalSeconds: historicalStudents.length * 30,
    offTaskSeconds: historicalStudents.length * 30, unknownSeconds: historicalStudents.length * 30,
    activeMonitoredStudents: historicalStudents.length, heartbeatCount: historicalStudents.length * 3 });
  const answer = { heavy, heavyDomains, heavyStudents, historical, historicalStudents };
  scopeMath.set(key, answer); return answer;
}

export function assertDistinctOracle(fixture, oracle) {
  assertFixture(fixture);
  assert.match(oracle.source, /^[a-f0-9]{40}$/); assert.equal(oracle.source, fixture.sourceRevision);
  assert.equal(oracle.kind, 'distinct-report-independent-raw-coverage-v1');
  assert.equal(oracle.aggregateRowsUsedForExpected, false); assert.equal(oracle.productReportCodeUsedForExpected, false);
  assert.equal(oracle.preparedActualWorkersVerified, true); assert.equal(oracle.coverageFrozenForOffering, true);
  assert.ok(Number.isFinite(Date.parse(oracle.cutoff))); assert.equal(oracle.schools.length, 2);
  const cutoffParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(oracle.cutoff));
  assert.equal(['year', 'month', 'day'].map(type => cutoffParts.find(part => part.type === type).value).join('-'), fixture.today);
  const expectedDates = datesFor(fixture.today, 365).filter(date => date !== fixture.gapDate);
  for (const school of fixture.schools) {
    const rows = oracle.schools.filter(row => row.schoolIndex === school.index); assert.equal(rows.length, 1);
    const data = rows[0]; assert.equal(data.invalidRawBindings, 0); assert.equal(data.invalidClassificationOrRoster, 0);
    assert.deepEqual(data.coverage.map(row => row.date), expectedDates);
    assert.equal(new Set(data.coverage.map(row => row.date)).size, expectedDates.length);
    assert.ok(data.coverage.every(row => row.isFinal === (row.date !== fixture.today)));
    assert.ok(data.coverage.every(row => Number.isFinite(Date.parse(row.processedThrough))));
    assert.equal(new Date(data.coverage.find(row => row.date === fixture.today).processedThrough).toISOString(), new Date(oracle.cutoff).toISOString());
    for (const entries of [data.secondsByStudent, data.heartbeatsByStudent]) {
      assert.ok(Array.isArray(entries)); assert.equal(new Set(entries.map(([id]) => id)).size, entries.length);
      assert.ok(entries.every(([id, value]) => school.students.includes(id) && safeWhole(value)));
    }
    // The writer counts one observation per student/whole second. Persisted
    // retries still belong in the raw-row oracle, but must not inflate report
    // heartbeat totals. The observer derives both counts from raw timestamps.
    assert.ok(safeWhole(data.rawRows) && safeWhole(data.deduplicatedRows));
    assert.ok(data.deduplicatedRows <= data.rawRows);
    assert.equal(data.heartbeatsByStudent.reduce((sum, [, count]) => sum + count, 0), data.deduplicatedRows);
    assert.ok(data.heartbeatsByStudent.every(([, count]) => count > 0));
    assert.deepEqual(data.secondsByStudent.map(([id]) => id).sort(), data.heartbeatsByStudent.map(([id]) => id).sort());
    const counts = new Map(data.heartbeatsByStudent);
    assert.ok(data.secondsByStudent.every(([id, seconds]) => seconds === 0 || (counts.get(id) ?? 0) > 0));
  }
}

export function expectedDistinctReport(fixture, item, oracle) {
  const school = fixture.schools[item.schoolIndex], raw = oracle.schools.find(row => row.schoolIndex === school.index);
  const math = declaredScopeMath(item), currentIds = allowedStudents(item, true).map(index => school.students[index]);
  const seconds = new Map(raw.secondsByStudent), counts = new Map(raw.heartbeatsByStudent), current = empty();
  const currentStudents = currentIds.filter(id => (counts.get(id) ?? 0) > 0);
  current.monitoredBrowserSeconds = current.instructionalSeconds = currentIds.reduce((sum, id) => sum + (seconds.get(id) ?? 0), 0);
  current.heartbeatCount = currentIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0); current.activeMonitoredStudents = currentStudents.length;
  const expectedDates = datesFor(fixture.today, item.days), unavailableDates = expectedDates.filter(date => date === fixture.gapDate);
  const byDay = expectedDates.filter(date => date !== fixture.gapDate).map(date => ({ date, state: date === fixture.today ? 'live' : 'final',
    ...(date === fixture.today ? current : date === fixture.emptyDate ? empty() : date === fixture.heavyDate ? math.heavy : math.historical) }));
  const totals = empty();
  for (const field of ['monitoredBrowserSeconds', 'instructionalSeconds', 'offTaskSeconds', 'unknownSeconds', 'heartbeatCount']) totals[field] = byDay.reduce((sum, row) => sum + row[field], 0);
  const activeStudents = new Set(currentStudents.map(id => school.students.indexOf(id)));
  if (expectedDates.includes(fixture.heavyDate)) for (const index of math.heavyStudents) activeStudents.add(index);
  const historyDays = expectedDates.filter(date => ![fixture.today, fixture.heavyDate, fixture.emptyDate, fixture.gapDate].includes(date)).length;
  if (historyDays) for (const index of math.historicalStudents) activeStudents.add(index);
  totals.activeMonitoredStudents = activeStudents.size;
  const allDomains = domains();
  if (expectedDates.includes(fixture.heavyDate)) for (const category of ['educational', 'nonEducational']) for (const [domain, value] of math.heavyDomains[category]) addDomain(allDomains, category, domain, value);
  for (const index of math.historicalStudents) for (const category of ['educational', 'nonEducational']) addDomain(allDomains, category, `history-${index % 200}.example.test`, historyDays * 30);
  addDomain(allDomains, 'educational', 'ixl.com', current.monitoredBrowserSeconds);
  const top = category => [...allDomains[category]].map(([domain, value]) => ({ domain, seconds: value }))
    .sort((a, b) => b.seconds - a.seconds || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)).slice(0, 10);
  return { scope: { kind: item.scope, id: item.id }, range: { from: item.from, to: item.to, today: fixture.today,
    timeZone: 'America/New_York', retentionDays: 365, retainedFrom: dateBefore(fixture.today, 364), partiallyExpired: false,
    requestedDays: item.days, computedDays: byDay.length, unavailableDates, partiallyComputed: unavailableDates.length > 0,
    computedFrom: byDay[0].date, presentedFrom: byDay[0].date, presentedTo: fixture.today },
    dataState: 'live', totals, byDay, topEducationalDomains: top('educational'), topNonEducationalDomains: top('nonEducational') };
}
export function assertDistinctJson(body, expected) {
  assert.equal(body.schemaVersion, 1); assert.equal(body.measure, 'Monitored Browser Time');
  assert.equal(body.scope.kind, expected.scope.kind); assert.equal(body.scope.id, expected.scope.id);
  assert.deepEqual(body.range, expected.range); assert.equal(body.dataState, expected.dataState);
  assert.deepEqual(body.totals, expected.totals); assert.deepEqual(body.byDay, expected.byDay);
  assert.deepEqual(body.topEducationalDomains, expected.topEducationalDomains); assert.deepEqual(body.topNonEducationalDomains, expected.topNonEducationalDomains);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)) && Number.isFinite(Date.parse(body.computedAt)));
}

export function parseDistinctCsv(text) {
  assert.ok(typeof text === 'string' && text.startsWith('\uFEFF') && text.endsWith('\r\n'));
  const rows = []; let row = [], value = '', quoted = false;
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (char === '"' && text[index + 1] === '"') { value += '"'; index++; } else if (char === '"') quoted = false; else value += char; }
    else if (char === '"') { assert.equal(value, ''); quoted = true; }
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\r' && text[index + 1] === '\n') { row.push(value); rows.push(row); row = []; value = ''; index++; }
    else value += char;
  }
  assert.equal(quoted, false); assert.equal(value, ''); assert.equal(row.length, 0); return rows;
}
export function assertDistinctCsv(text, expected) {
  const rows = parseDistinctCsv(text), one = label => { const found = rows.filter(row => row[0] === label); assert.equal(found.length, 1); return found[0]; };
  for (const [label, value] of [['Report', 'Monitored Browser Time'], ['Scope', expected.scope.kind], ['From', expected.range.from], ['To', expected.range.to],
    ['Time zone', expected.range.timeZone], ['Retained from', expected.range.retainedFrom], ['Partially expired', 'no'], ['Computed from', expected.range.computedFrom],
    ['Computed days', String(expected.range.computedDays)], ['Requested retained days', String(expected.range.requestedDays)],
    ['Unavailable dates', expected.range.unavailableDates.join('; ')], ['Data state', 'live']]) assert.equal(one(label)[1], value);
  for (const label of ['Label', 'Generated at', 'Note']) { const row = one(label); assert.equal(row.length, 2); assert.ok(row[1].length > 0); }
  assert.ok(Number.isFinite(Date.parse(one('Generated at')[1])));
  assert.deepEqual(one('Date'), ['Date', 'Day state', 'Monitored Browser Time (minutes)', 'Instructional (minutes)',
    'Off-task (minutes)', 'Unclassified (minutes)', 'Active monitored students', 'Heartbeats']);
  const fields = ['monitoredBrowserSeconds', 'instructionalSeconds', 'offTaskSeconds', 'unknownSeconds'];
  const numeric = value => fields.map(key => (value[key] / 60).toFixed(1)).concat(String(value.activeMonitoredStudents), String(value.heartbeatCount));
  assert.deepEqual(one('Total').slice(2), numeric(expected.totals));
  const dated = rows.filter(row => localDate(row[0])); assert.equal(dated.length, expected.byDay.length);
  for (const [index, day] of expected.byDay.entries()) assert.deepEqual(dated[index], [day.date, day.state, ...numeric(day)]);
  for (const missing of expected.range.unavailableDates) assert.equal(dated.some(row => row[0] === missing), false);
  for (const [label, expectedSites] of [['Top educational sites', expected.topEducationalDomains], ['Top non-educational sites', expected.topNonEducationalDomains]]) {
    const header = one(label); assert.equal(header[1], 'Minutes'); const start = rows.indexOf(header) + 1, sites = [];
    for (let index = start; index < rows.length && rows[index].some(value => value !== ''); index++) sites.push(rows[index]);
    assert.deepEqual(sites, expectedSites.map(item => [item.domain, (item.seconds / 60).toFixed(1)]));
  }
  const metadataLabels = ['Report', 'Scope', 'Label', 'From', 'To', 'Time zone', 'Retained from', 'Partially expired', 'Computed from',
    'Computed days', 'Requested retained days', 'Unavailable dates', 'Data state', 'Generated at', 'Note'];
  assert.deepEqual(rows.slice(0, metadataLabels.length).map(row => row[0]), metadataLabels);
  assert.ok(rows.slice(0, metadataLabels.length).every(row => row.length === 2));
  assert.equal(rows.length, 15 + 1 + 1 + expected.byDay.length + 1 + 1 + 1 + expected.topEducationalDomains.length + 1 + 1 + expected.topNonEducationalDomains.length);
}
export function assertDistinctAuditRecords(fixture, records) {
  const cases = distinctCsvCases(fixture); assert.equal(records.length, 8);
  assert.ok(records.every(row => row.action === 'classpilot.usage.export'));
  for (const item of cases) {
    const school = fixture.schools[item.schoolIndex], matches = records.filter(row => row.school_id === school.id && row.user_id === school.staff
      && row.entity_type === 'classpilot_usage_' + item.scope && row.entity_id === (item.id ?? school.id)
      && row.metadata.scope === item.scope && row.metadata.from === item.from && row.metadata.to === item.to);
    assert.equal(matches.length, 1);
  }
  return { passed: true, records: 8, expectedKeysSha256: digest(cases.map(distinctCanonicalKey)) };
}

export function prepareDistinctReports(fixture, oracle) {
  assertDistinctOracle(fixture, oracle);
  const cases = distinctReportCases(fixture), expectations = new Map(cases.map(item => [item.ordinal, expectedDistinctReport(fixture, item, oracle)]));
  return { source: oracle.source, fixtureKeySha256: digest([fixture.today, fixture.schools.map(school => [school.id, school.students, school.groups])]),
    oracleSha256: digest(oracle), cases, expectations, caseManifestSha256: digest(cases), expectedReportsSha256: digest([...expectations]),
    contractSha256: distinctReportContractHash(), preparedBeforeTimedOffers: true };
}

// The generator retains this state locally. A caller-supplied token is checked
// against its canonical contents before an authenticated endpoint is offered.
export function distinctPreparedStateHash({ run, fixture, oracle, prepared }) {
  assert.match(run, /^[a-f0-9]{12}$/);
  const canonical = prepareDistinctReports(fixture, oracle);
  assert.equal(prepared.preparedBeforeTimedOffers, true);
  for (const key of ['source', 'fixtureKeySha256', 'oracleSha256', 'caseManifestSha256', 'expectedReportsSha256', 'contractSha256'])
    assert.equal(prepared[key], canonical[key]);
  assert.equal(digest(prepared.cases), canonical.caseManifestSha256);
  assert.equal(digest([...prepared.expectations]), canonical.expectedReportsSha256);
  return digest({ kind: 'distinct-report-generator-owned-state-v1', run, source: oracle.source,
    fixtureKeySha256: canonical.fixtureKeySha256, cutoff: oracle.cutoff, oracleSha256: canonical.oracleSha256,
    contractSha256: canonical.contractSha256, caseManifestSha256: canonical.caseManifestSha256,
    expectedReportsSha256: canonical.expectedReportsSha256 });
}
export function assertDistinctPreparedState({ preparedHash, ...state }) {
  const actual = distinctPreparedStateHash(state); assert.equal(preparedHash, actual); return actual;
}

const publicErrorNames = new Set(['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
export function sanitizedDistinctReportFailure(error, fallback = 'DISTINCT_REPORT_REJECTED') {
  assert.match(fallback, /^[A-Z_0-9]{1,64}$/);
  return { name: publicErrorNames.has(error?.name) ? error.name : 'Error',
    code: typeof error?.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code : fallback };
}

export async function runDistinctReports({ fixture, schools, staffRequest, oracle, startsAtMs,
  prepared, clock = () => performance.timeOrigin + performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), signal }) {
  assertDistinctOracle(fixture, oracle); assert.deepEqual(schools.map(row => row.id), fixture.schools.map(row => row.id));
  assert.equal(fixture.apiBases.length, 3);
  assert.equal(new Set(fixture.apiBases).size, 3);
  for (const endpoint of fixture.apiBases) { const url = new URL(endpoint); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, ''); assert.equal(url.password, ''); }
  for (const school of schools) assert.match(school.cookie, /(?:^|;\s*)schoolpilot\.sid=/);
  assert.equal(prepared.preparedBeforeTimedOffers, true); assert.equal(prepared.contractSha256, distinctReportContractHash());
  assert.equal(prepared.source, oracle.source); assert.equal(prepared.oracleSha256, digest(oracle));
  assert.equal(prepared.fixtureKeySha256, digest([fixture.today, fixture.schools.map(school => [school.id, school.students, school.groups])]));
  assert.equal(prepared.caseManifestSha256, digest(distinctReportCases(fixture)));
  assert.equal(prepared.caseManifestSha256, digest(prepared.cases));
  assert.equal(prepared.expectedReportsSha256, digest([...prepared.expectations]));
  // A stored hash must not make mutated expected answers authoritative. Recheck
  // against independent canonical fixture/raw arithmetic before offers begin.
  const canonicalExpected = distinctReportCases(fixture).map(item => [item.ordinal, expectedDistinctReport(fixture, item, oracle)]);
  assert.equal(prepared.expectedReportsSha256, digest(canonicalExpected));
  assert.ok(Number.isFinite(startsAtMs) && startsAtMs >= clock());
  const cases = prepared.cases, expected = prepared.expectations;
  const rows = [], csv = [], effectiveKeys = new Set(); let inFlight = 0, peakInFlight = 0;
  const offer = async (item, format, declaredAt) => {
    const query = new URLSearchParams({ scope: item.scope, format, from: item.from, to: item.to }); if (item.id !== null) query.set('id', item.id);
    const began = clock(), row = { ordinal: item.ordinal, wave: item.wave, schoolIndex: item.schoolIndex, scope: item.scope, targetOrdinal: item.targetOrdinal,
      days: item.days, requestKeySha256: distinctCanonicalKey(item), endpointIndex: item.endpointIndex,
      declaredOffsetMs: declaredAt - startsAtMs, offeredOffsetMs: began - startsAtMs, offerLatenessMs: Math.max(0, began - declaredAt), status: 0, correct: false };
    inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      if (signal?.aborted) throw signal.reason ?? Error('Aborted');
      const timeout = AbortSignal.timeout(20_000), requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
      const response = await staffRequest(schools[item.schoolIndex], `/admin/usage?${query}`, { endpoint: fixture.apiBases[item.endpointIndex], signal: requestSignal });
      row.status = response.status; assert.equal(response.status, 200);
      if (format === 'json') {
        assertDistinctJson(response.body, expected.get(item.ordinal));
        const effective = digest([item.schoolId, item.scope, item.id, response.body.range.presentedFrom, response.body.range.presentedTo]);
        assert.equal(effective, row.requestKeySha256); assert.ok(!effectiveKeys.has(effective)); effectiveKeys.add(effective); row.effectiveKeySha256 = effective;
      } else { assertDistinctCsv(response.body, expected.get(item.ordinal)); row.csvSha256 = digest(response.body); }
      row.correct = true;
    } catch (error) { row.error = sanitizedDistinctReportFailure(error); }
    finally { row.durationMs = clock() - began; inFlight--; (format === 'json' ? rows : csv).push(row); }
  };
  await Promise.all(DISTINCT_REPORT_CONTRACT.waveOffsetsMs.map(async (offset, wave) => {
    const at = startsAtMs + offset; while (clock() < at) await pause(Math.max(1, at - clock()));
    await Promise.all(cases.filter(item => item.wave === wave).map(item => offer(item, 'json', at)));
  }));
  // CSV uses the same real endpoint/session/audit path, after concurrent JSON.
  const csvAt = clock(); await Promise.all(distinctCsvCases(fixture).map(item => offer(item, 'csv', csvAt)));
  rows.sort((a, b) => a.ordinal - b.ordinal); csv.sort((a, b) => a.ordinal - b.ordinal);
  const checks = { all64ActualAuthenticatedEndpoints: rows.length === 64 && rows.every(row => row.status === 200 && row.correct),
    allRequestsWithinUnchangedDeadline: [...rows, ...csv].every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs < 20_000),
    actualDeclaredOffers: [...rows, ...csv].every(row => row.offerLatenessMs <= 100),
    uniqueRequestAndEffectiveKeys: effectiveKeys.size === 64 && new Set(rows.map(row => row.requestKeySha256)).size === 64,
    all8CsvCorrect: csv.length === 8 && csv.every(row => row.status === 200 && row.correct && /^[a-f0-9]{64}$/.test(row.csvSha256)),
    drainedClientOffers: inFlight === 0, concurrentEndpointWorkObserved: peakInFlight >= 16 };
  return { schemaVersion: 1, profile: DISTINCT_REPORT_CONTRACT.name, contractSha256: distinctReportContractHash(),
    source: oracle.source, startsAtMs, currentProcessedCutoff: oracle.cutoff, independentOracleSha256: digest(oracle),
    expectedReportsSha256: prepared.expectedReportsSha256, realStaffSessionCookies: true,
    reportCases: rows, csvCases: csv, peakInFlight, checks, passed: Object.values(checks).every(Boolean),
    databaseState: DISTINCT_REPORT_CONTRACT.databaseState,
    postOfferingNativeCoverageAuditAndOwnerDrainRequired: true, capacityAcceptance: false };
}
