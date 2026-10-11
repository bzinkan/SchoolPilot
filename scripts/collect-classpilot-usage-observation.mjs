#!/usr/bin/env node
/**
 * Offline, content-free Digital Usage activation evidence. No network or DB connection.
 * Run --help for the concrete export contracts and acquisition SQL command.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_SCHOOLS = 1_000;
const MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const COUNTERS = ['schools', 'finalizedDays', 'recomputedDays', 'unchangedDays', 'retentionSkippedDays', 'deferredDays', 'failedSchools', 'rowCount', 'durationMs'];
const IDENTITY_KEYS = ['appSha', 'imageDigest', 'apiArn', 'workerArn'];
const SPEC_KEYS = ['schemaVersion', 'serving', 'workerLogStreams', 'startedAt', 'endedAt', 'reviewedAt', 'reviewReference', 'schoolDays'];
const ROW_KEYS = ['schoolId', 'date', 'dayStartAt', 'dayEndAt', 'processedThrough', 'isFinal', 'computedAt'];
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

function assert(value, message) { if (!value) throw new Error(message); }
function object(value, label) { assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); }
function exact(value, keys, label) {
  object(value, label);
  assert(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label} must contain exactly: ${keys.join(', ')}`);
}
function integer(value, label, minimum = 0) { assert(Number.isSafeInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`); }
function array(value, label, maximum, minimum = 1) { assert(Array.isArray(value) && value.length >= minimum && value.length <= maximum, `${label} must contain ${minimum}..${maximum} entries`); }
function timestamp(value, label) {
  assert(typeof value === 'string' && UTC.test(value), `${label} must be an exact UTC timestamp`);
  const milliseconds = Date.parse(value);
  assert(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19), `${label} must be a real UTC timestamp`);
  return milliseconds;
}
function canonicalDate(value, label) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, `${label} must be a real ISO local date`);
  return value;
}
function timeZone(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 128, 'timeZone is missing or too long');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); }
  catch { throw new Error(`Invalid timeZone: ${value}`); }
  return value;
}
function localParts(milliseconds, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(milliseconds).map(part => [part.type, part.value]));
}
function localDate(milliseconds, zone) {
  const parts = localParts(milliseconds, zone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function addDay(date) { return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10); }

/** Resolve midnight in an explicit IANA zone; fail instead of silently falling back. */
export function localDayBounds(date, zone) {
  canonicalDate(date, 'date'); timeZone(zone);
  const midnight = (targetDate) => {
    const target = Date.parse(`${targetDate}T00:00:00Z`);
    let guess = target;
    for (let attempt = 0; attempt < 8; attempt++) {
      const p = localParts(guess, zone);
      const rendered = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      if (rendered === target) return guess;
      guess += target - rendered;
    }
    throw new Error(`School-local midnight cannot be resolved for ${targetDate}/${zone}`);
  };
  const start = midnight(date), end = midnight(addDay(date));
  assert(end > start && end - start <= 26 * HOUR, 'Invalid school-local day duration');
  return { start, end };
}

/** UTC scheduler hours, not wall-clock hour labels (including both fall-back hours). */
export function requiredHourlyBuckets(date, zone) {
  const { start, end } = localDayBounds(date, zone);
  const count = Math.ceil((end - start) / HOUR) + 1;
  const finalBucket = Math.ceil(end / HOUR) * HOUR;
  const buckets = [];
  for (let index = 0; index < count; index++) buckets.push(finalBucket - (count - index - 1) * HOUR);
  return buckets;
}

/** Include any leading UTC tick needed by the setter's ceil(dayHours)+1 count. */
export function requiredObservationExportWindow(schoolDays) {
  array(schoolDays, 'Export-window school days', MAX_SCHOOLS);
  let start = Infinity, end = -Infinity;
  for (const day of schoolDays) {
    const bounds = localDayBounds(day.date, day.timeZone);
    start = Math.min(start, bounds.start, requiredHourlyBuckets(day.date, day.timeZone)[0]);
    end = Math.max(end, bounds.end + HOUR);
  }
  return { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() };
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function parseBytes(bytes, label) {
  assert(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, `${label} must be exact input bytes`);
  assert(bytes.length > 0 && bytes.length <= MAX_BYTES, `${label} is empty or exceeds 64 MiB`);
  assert(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${label} must be UTF-8 without BOM`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(!text.startsWith('\uFEFF'), `${label} must be UTF-8 without BOM`);
  // Reject duplicate JSON properties as well as JSON.parse's otherwise silent
  // last-value-wins handling; string contents are skipped, never interpreted.
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') { stack.push(new Set()); index++; continue; }
    if (char === '[') { stack.push(null); index++; continue; }
    if (char === '}' || char === ']') { stack.pop(); index++; continue; }
    if (char !== '"') { index++; continue; }
    const begin = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') break;
    }
    let after = index;
    while (/\s/.test(text[after] ?? '') && after < text.length) after++;
    if (text[after] === ':' && stack.at(-1) instanceof Set) {
      const key = JSON.parse(text.slice(begin, index));
      assert(!stack.at(-1).has(key), `${label} contains duplicate JSON property: ${key}`);
      stack.at(-1).add(key);
    }
  }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}
function identity(value, label) {
  exact(value, IDENTITY_KEYS, label);
  assert(typeof value.appSha === 'string' && /^[0-9a-f]{40}$/.test(value.appSha), `${label}.appSha must be a full lower-case source SHA`);
  assert(typeof value.imageDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.imageDigest), `${label}.imageDigest must be an exact digest`);
  for (const key of ['apiArn', 'workerArn']) assert(typeof value[key] === 'string' && /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:[1-9]\d*$/.test(value[key]), `${label}.${key} must be an exact task-definition ARN`);
}
function sameIdentity(actual, expected, label) {
  identity(actual, label);
  assert(IDENTITY_KEYS.every(key => actual[key] === expected[key]), `${label} does not match the exact serving identity`);
}
function validateSpec(spec) {
  exact(spec, SPEC_KEYS, 'spec'); assert(spec.schemaVersion === 1, 'spec schemaVersion must be 1'); identity(spec.serving, 'spec.serving');
  array(spec.workerLogStreams, 'workerLogStreams', 128);
  assert(new Set(spec.workerLogStreams).size === spec.workerLogStreams.length && spec.workerLogStreams.every(stream => typeof stream === 'string' && /^scheduler-worker\/scheduler-worker\/[0-9a-f]{32}$/.test(stream)), 'workerLogStreams must be distinct exact scheduler-worker task streams');
  timestamp(spec.startedAt, 'startedAt'); timestamp(spec.endedAt, 'endedAt');
  assert(Date.parse(spec.endedAt) > Date.parse(spec.startedAt) && Date.parse(spec.endedAt) - Date.parse(spec.startedAt) <= 32 * DAY, 'Observation export window must be ordered and bounded to 32 days');
  assert(typeof spec.reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(spec.reviewedAt), 'reviewedAt must use the setter .NET roundtrip UTC format with seven fractional digits');
  timestamp(spec.reviewedAt, 'reviewedAt');
  assert(typeof spec.reviewReference === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(spec.reviewReference), 'Invalid reviewReference');
  array(spec.schoolDays, 'schoolDays', MAX_SCHOOLS);
  const schools = new Set();
  for (const day of spec.schoolDays) {
    exact(day, ['schoolId', 'date', 'timeZone'], 'schoolDays entry');
    assert(typeof day.schoolId === 'string' && UUID.test(day.schoolId), 'schoolId must be a canonical UUID');
    assert(!schools.has(day.schoolId), 'Provide exactly one watched school day per eligible school'); schools.add(day.schoolId);
    canonicalDate(day.date, 'Watched date'); timeZone(day.timeZone);
    assert(![0, 6].includes(new Date(`${day.date}T00:00:00Z`).getUTCDay()), 'Watched school dates must be weekdays');
  }
  const exportWindow = requiredObservationExportWindow(spec.schoolDays);
  assert(Date.parse(spec.startedAt) <= Date.parse(exportWindow.startedAt), `Export must start before the whole school-local day and its first required UTC scheduler bucket: ${exportWindow.startedAt}`);
}

export function readObservationSpec(bytes) {
  const spec = parseBytes(bytes, 'spec');
  validateSpec(spec);
  return spec;
}
export function readObservationJson(bytes, label = 'Observation JSON') { return parseBytes(bytes, label); }

/** SQL equivalent of parseClasspilotRetentionDays for the TEXT settings field. */
export function effectiveRetentionHoursSql(column) {
  assert(/^[a-z_]+\.[a-z_]+$/.test(column), 'Retention SQL requires a fixed qualified column');
  // JavaScript String.trim whitespace, not merely PostgreSQL's default ASCII
  // space. Strip leading zeros before a bounded cast so arbitrary TEXT cannot
  // overflow an integer, even when PostgreSQL rearranges predicate evaluation.
  const spaces = String.raw`\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF`;
  const normalized = `btrim(${column}, U&'${spaces}')`;
  const digits = `ltrim(${normalized}, '0')`;
  return `CASE WHEN ${normalized} ~ '^[0-9]+$' AND length(${digits}) BETWEEN 1 AND 4\n      THEN CASE WHEN ${digits}::integer BETWEEN 24 AND 8760 AND ${digits}::integer % 24 = 0\n        THEN ${digits}::integer ELSE 720 END ELSE 720 END`;
}

/** Use the setter's standalone permissions helper, which imports no deploy code. */
export function assertPrivateObservationPaths({ inputs = [], outputs = [], protect = [] }) {
  for (const target of [...inputs, ...outputs, ...protect]) {
    const rel = relative(REPOSITORY_ROOT, resolve(target));
    assert(rel && (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)), 'Observation artifacts must stay outside the repository');
    let ancestor = dirname(resolve(target));
    while (true) {
      assert(!existsSync(join(ancestor, '.git')), 'Observation artifacts must stay outside every Git repository/worktree');
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  const helper = resolve(REPOSITORY_ROOT, 'scripts/private-permissions.ps1');
  const lines = ["$ErrorActionPreference = 'Stop'", 'Set-StrictMode -Version Latest', `. ${literal(helper)}`];
  for (const target of inputs) lines.push(`[void](Assert-PrivateInputPath -Path ${literal(resolve(target))} -RepositoryRoot ${literal(REPOSITORY_ROOT)})`);
  for (const target of outputs) {
    const fullPath = resolve(target), parent = dirname(fullPath);
    lines.push(`Assert-NoReparsePointInExistingPath -Path ${literal(fullPath)}`,
      `if (Test-Path -LiteralPath ${literal(fullPath)}) { throw 'Observation output already exists; refusing overwrite' }`,
      `if (-not (Test-Path -LiteralPath ${literal(parent)} -PathType Container)) { throw 'Create a private operator evidence directory first' }`,
      `Assert-PrivatePathPermissions -Path ${literal(parent)} -Directory`);
  }
  for (const target of protect) lines.push(`Set-PrivatePathPermissions -Path ${literal(resolve(target))}`, `[void](Assert-PrivateInputPath -Path ${literal(resolve(target))} -RepositoryRoot ${literal(REPOSITORY_ROOT)})`);
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lines.join('\n'), 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert(!result.error && result.status === 0, `Private observation path/ACL check failed: ${(result.stderr || result.error?.message || 'permission helper refused').trim()}`);
}

function readRuns(logExport, spec, eligibleCount) {
  object(logExport, 'worker log export');
  assert(!logExport.nextToken, 'Worker log export still has a pagination token; export every page');
  array(logExport.events, 'Worker log events', 100_000);
  const ids = new Set(), runs = new Map();
  for (const event of logExport.events) {
    object(event, 'Worker log event');
    assert(typeof event.logStreamName === 'string' && spec.workerLogStreams.includes(event.logStreamName), 'Log event came from an unbound worker stream');
    assert(typeof event.eventId === 'string' && event.eventId.length > 0 && !ids.has(event.eventId), 'Duplicate or absent log eventId'); ids.add(event.eventId);
    integer(event.timestamp, 'Log event timestamp');
    assert(event.timestamp >= Date.parse(spec.startedAt) && event.timestamp <= Date.parse(spec.endedAt), 'Log event is outside the declared export window');
    assert(typeof event.message === 'string', 'Worker log message must be an exported string');
    assert(!event.message.includes('[ClassPilot] Monitored Browser Time rollup failed'), 'Worker failure log invalidates observation even without its final counter sample');
    let sample;
    try { sample = parseBytes(Buffer.from(event.message), 'Worker message'); }
    catch (error) { if (event.message.includes('classpilot_usage_rollup')) throw error; else continue; }
    for (const metric of ['UsageRollupFailedSchools', 'UsageRollupDeferredDays']) {
      if (sample && Object.hasOwn(sample, metric)) {
        integer(sample[metric], `Worker ${metric}`);
        assert(sample[metric] === 0, 'Worker failure/deferral metric invalidates observation even without its final counter sample');
      }
    }
    assert(typeof sample?.event !== 'string' || !sample.event.startsWith('classpilot_usage_rollup') || sample.event === 'classpilot_usage_rollup', 'Unsupported worker Usage rollup event requires review');
    if (sample?.event !== 'classpilot_usage_rollup') continue;
    exact(sample, ['event', ...COUNTERS, 'budgetExhausted', 'deadline'], 'Worker rollup sample');
    for (const name of COUNTERS) integer(sample[name], `Worker ${name}`);
    assert(sample.schools === eligibleCount, 'Worker school count does not match the complete eligible-school inventory');
    assert(sample.failedSchools === 0 && sample.deferredDays === 0 && sample.retentionSkippedDays === 0 && sample.budgetExhausted === false, 'Worker sample has failures, deferrals, retention skips or exhausted budget');
    assert(sample.durationMs > 0 && sample.durationMs < 1_500_000, 'Worker duration must be >0 and below the setter 1,500,000ms bound');
    assert(sample.finalizedDays <= eligibleCount && sample.unchangedDays <= eligibleCount && sample.recomputedDays >= sample.finalizedDays && sample.recomputedDays <= 2 * eligibleCount && sample.recomputedDays - sample.finalizedDays + sample.unchangedDays === eligibleCount, 'Worker counters do not account for every eligible school current-day task');
    const deadline = timestamp(sample.deadline, 'Worker deadline');
    const bucket = Math.floor(deadline / HOUR) * HOUR;
    assert(deadline === bucket + 25 * 60_000, 'Worker deadline does not identify its actual UTC scheduler hour');
    // :25 stops NEW work; one already admitted operation can finish within its
    // 60s operation budget after that boundary. The setter still caps the total.
    assert(event.timestamp >= bucket && event.timestamp <= deadline + 60_000 && event.timestamp - sample.durationMs >= bucket && event.timestamp - sample.durationMs < deadline, 'Worker timestamp/duration does not fit its UTC scheduler hour and bounded in-flight budget');
    const samples = runs.get(bucket) ?? []; samples.push({ eventId: event.eventId, timestamp: event.timestamp, ...sample }); runs.set(bucket, samples);
  }
  assert(runs.size > 0, 'No actual classpilot_usage_rollup samples were exported');
  return runs;
}

/**
 * Exact-byte inputs -> the existing setter's schema 1 plus a replay receipt.
 * The caller supplies now only for deterministic testing/replay; CLI defaults to UTC now.
 */
export function collectUsageObservation({ specBytes, logBytes, ledgerBytes, recounts = [], recountIndexBytes, now = new Date() }) {
  const nowMs = now instanceof Date ? now.getTime() : timestamp(now, 'now');
  assert(Number.isFinite(nowMs), 'now must be valid');
  const spec = parseBytes(specBytes, 'spec'), logs = parseBytes(logBytes, 'worker logs'), ledger = parseBytes(ledgerBytes, 'ledger export');
  validateSpec(spec);
  const reviewedAt = timestamp(spec.reviewedAt, 'reviewedAt');
  assert(reviewedAt <= nowMs + 5 * 60_000 && reviewedAt >= nowMs - 2 * HOUR, 'Review timestamp is stale or in the future');
  assert(Date.parse(spec.endedAt) <= nowMs + 60_000 && Date.parse(spec.endedAt) <= reviewedAt + 60_000, 'Observation window ends after now/review');
  exact(ledger, ['schemaVersion', 'capturedAt', 'serving', 'eligibleSchoolCount', 'inventoryTruncated', 'schools', 'days'], 'ledger export');
  assert(ledger.schemaVersion === 1, 'ledger schemaVersion must be 1'); sameIdentity(ledger.serving, spec.serving, 'ledger.serving');
  const capturedAt = timestamp(ledger.capturedAt, 'Ledger capturedAt');
  assert(capturedAt <= nowMs + 60_000 && capturedAt <= reviewedAt + 60_000 && capturedAt >= reviewedAt - 2 * HOUR && capturedAt >= Date.parse(spec.endedAt), 'Ledger snapshot is stale, future-dated or predates the observation end');
  integer(ledger.eligibleSchoolCount, 'eligibleSchoolCount', 1);
  array(ledger.schools, 'Eligible inventory', MAX_SCHOOLS);
  assert(ledger.inventoryTruncated === false && ledger.eligibleSchoolCount === ledger.schools.length && ledger.schools.length === spec.schoolDays.length, 'Eligible-school inventory is incomplete, truncated, empty or has omitted schools');
  const inventory = new Map();
  for (const school of ledger.schools) {
    exact(school, ['schoolId', 'timeZone', 'retentionHours'], 'Inventory school');
    assert(typeof school.schoolId === 'string' && UUID.test(school.schoolId) && !inventory.has(school.schoolId), 'Duplicate or invalid inventory school');
    timeZone(school.timeZone); integer(school.retentionHours, 'retentionHours', 24);
    assert(school.retentionHours <= 8760 && school.retentionHours % 24 === 0, 'Inventory must export effective retention as whole days 1..365');
    inventory.set(school.schoolId, school);
  }
  array(ledger.days, 'Ledger days', 2 * MAX_SCHOOLS, 0);
  const coverage = new Map(), wanted = new Set(spec.schoolDays.flatMap(day => [`${day.schoolId}/${day.date}`, `${day.schoolId}/${addDay(day.date)}`]));
  for (const row of ledger.days) {
    exact(row, ROW_KEYS, 'Ledger day');
    const key = `${row.schoolId}/${row.date}`;
    assert(wanted.has(key) && !coverage.has(key), 'Ledger contains an unexpected or duplicate school/day');
    coverage.set(key, row);
  }
  const runs = readRuns(logs, spec, inventory.size);
  const logSha256 = sha256(logBytes), coverageSha256 = sha256(ledgerBytes);
  const numerical = validateRetainedRecounts({ recounts, spec, inventory, nowMs });
  const checks = [];
  const schoolDays = [...spec.schoolDays].sort((a, b) => a.schoolId.localeCompare(b.schoolId)).map(day => {
    const school = inventory.get(day.schoolId);
    assert(school && school.timeZone === day.timeZone, 'Watched school/timezone does not match the complete inventory');
    const { start, end } = localDayBounds(day.date, day.timeZone), nextDate = addDay(day.date);
    assert(start >= nowMs - 30 * DAY && end <= nowMs, 'Watched day must be complete and within the setter 30-day bound');
    assert(localDate(capturedAt, day.timeZone) === nextDate, 'Ledger snapshot must check the watched day and its next-day live coverage');
    assert(Date.parse(spec.startedAt) <= start && Date.parse(spec.endedAt) >= end + HOUR && capturedAt >= end + HOUR, 'Observation must cover the whole school-local day plus the following finalization hour');
    const rawCutoff = capturedAt - school.retentionHours * HOUR;
    const aggregateRetainedFrom = localDate(rawCutoff, day.timeZone);
    const reportRetainedFrom = localDayBounds(aggregateRetainedFrom, day.timeZone).start >= rawCutoff ? aggregateRetainedFrom : addDay(aggregateRetainedFrom);
    const rawDayWhollyRetained = start >= rawCutoff;
    assert(day.date >= aggregateRetainedFrom, 'Watched aggregate ledger day is expired under the actual school-local retention cutoff');
    assert(!rawDayWhollyRetained || numerical.has(`${day.schoolId}/${day.date}`), `Wholly retained watched raw day requires an actual passed recount: ${day.schoolId}/${day.date}; acquire the bounded retained-input context and result exports`);
    const buckets = requiredHourlyBuckets(day.date, day.timeZone);
    const samples = [];
    for (const bucket of buckets) {
      assert(runs.has(bucket), `Missing hourly bucket ${new Date(bucket).toISOString()} for ${day.schoolId}/${day.date}`);
      samples.push(...runs.get(bucket));
    }
    const verifyDay = (date, final) => {
      const row = coverage.get(`${day.schoolId}/${date}`);
      assert(row, `Missing or invalidated ledger day: ${day.schoolId}/${date}`);
      const bounds = localDayBounds(date, day.timeZone);
      const rowStart = timestamp(row.dayStartAt, 'Ledger dayStartAt'), rowEnd = timestamp(row.dayEndAt, 'Ledger dayEndAt');
      const cutoff = timestamp(row.processedThrough, 'Ledger processedThrough'), computed = timestamp(row.computedAt, 'Ledger computedAt');
      assert(rowStart === bounds.start && rowEnd === bounds.end, 'Ledger school-local boundaries do not match its timezone/date');
      assert(row.isFinal === final && cutoff <= bounds.end && cutoff <= computed && computed <= capturedAt, 'Ledger final/live state or cutoff/computation timestamp is invalid');
      if (final) assert(cutoff === bounds.end && computed >= bounds.end, 'Watched day was not completely finalized');
      else assert(cutoff >= bounds.start && cutoff <= capturedAt, 'Next-day live ledger has no valid processed cutoff');
      return { processedThrough: row.processedThrough, computedAt: row.computedAt };
    };
    const finalDay = verifyDay(day.date, true), currentDay = verifyDay(nextDate, false);
    checks.push({ schoolId: day.schoolId, date: day.date, timeZone: day.timeZone, hourlyBuckets: buckets.map(bucket => new Date(bucket).toISOString()), exportedSamples: samples.length, duplicateHourSamples: samples.length - buckets.length, finalDay, currentDay,
      retention: { retentionHours: school.retentionHours, aggregateRetainedFrom, reportRetainedFrom, rawDayWhollyRetained },
      rawRecount: numerical.get(`${day.schoolId}/${day.date}`) ?? { status: 'unavailable', reason: 'The finalized aggregate ledger day remains retained, but the raw watched-day window is partly purged; a full-day retained-input recount is unavailable.' },
    });
    return {
      schoolId: day.schoolId, date: day.date, timeZone: day.timeZone,
      startedAt: spec.startedAt, endedAt: spec.endedAt, coverageCheckedAt: ledger.capturedAt,
      observedRuns: buckets.length, failedSchools: 0, deferredDays: 0, budgetExhausted: false,
      maxRunDurationMs: Math.max(...samples.map(sample => sample.durationMs)),
      // These are derived from the actual school/day ledger predicates above,
      // never from fleet log counts or the existence of aggregate rows.
      finalDayComplete: true, currentDayComplete: true, logSha256, coverageSha256,
    };
  });
  const evidence = { schemaVersion: 1, reviewedAt: spec.reviewedAt, reviewReference: spec.reviewReference, appSha: spec.serving.appSha, imageDigest: spec.serving.imageDigest, schoolDays };
  const evidenceBytes = jsonBytes(evidence);
  const receipt = {
    schemaVersion: 1, tool: 'collect-classpilot-usage-observation', generatedAt: new Date(nowMs).toISOString(), serving: spec.serving,
    inputs: { specSha256: sha256(specBytes), logSha256, coverageSha256 }, evidenceSha256: sha256(evidenceBytes), checks,
    numericRecount: numerical.size === 0
      ? { status: 'unavailable', reason: 'Every watched raw day is partly outside actual retention; per-school checks record the exact cutoff. Worker counters and ledger coverage do not independently prove numerical attribution or recover purged inputs.' }
      : { status: numerical.size === schoolDays.length ? 'retained_input_checks_passed' : 'partial_retained_input_checks_passed', checkedSchools: numerical.size, totalSchools: schoolDays.length, independentReferenceAlgorithm: false, reason: 'Actual retained-input reread results match persisted seconds and heartbeat counts using the canonical application attribution algorithm; this is not independent reference-algorithm proof.' },
  };
  if (recounts.length) receipt.inputs.recounts = [...numerical.values()].map(check => ({ schoolId: check.schoolId, date: check.date, contextSha256: check.contextSha256, resultSha256: check.resultSha256 })).sort((a, b) => a.schoolId.localeCompare(b.schoolId));
  if (recountIndexBytes) receipt.inputs.recountIndexSha256 = sha256(recountIndexBytes);
  return { evidence, receipt, evidenceBytes, receiptBytes: jsonBytes(receipt) };
}

const RECOUNT_CONTEXT_KEYS = ['schemaVersion', 'capturedAt', 'serving', 'schoolId', 'date', 'timeZone', 'retentionHours', 'trackingSettings', 'trackingEventsTruncated', 'trackingEvents'];
const RECOUNT_RESULT_KEYS = ['schemaVersion', 'capturedAt', 'serving', 'schoolId', 'date', 'timeZone', 'contextSha256', 'trackingPolicySha256', 'trackingEventsSha256', 'retentionHours', 'rawDayWhollyRetained', 'rawHeartbeatsComplete', 'trackingEventsComplete', 'basis', 'independentReferenceAlgorithm', 'rawHeartbeatCount', 'recountSeconds', 'persistedSeconds', 'recountHeartbeatCount', 'persistedHeartbeatCount', 'secondsMatch', 'heartbeatCountMatch'];
function validateRetainedRecounts({ recounts, spec, inventory, nowMs }) {
  array(recounts, 'Optional recounts', MAX_SCHOOLS, 0);
  const results = new Map();
  for (const entry of recounts) {
    exact(entry, ['contextBytes', 'resultBytes'], 'Retained recount entry');
    const context = parseBytes(entry.contextBytes, 'Recount context'), result = parseBytes(entry.resultBytes, 'Actual recount result');
    exact(context, RECOUNT_CONTEXT_KEYS, 'Recount context'); exact(result, RECOUNT_RESULT_KEYS, 'Actual recount result');
    sameIdentity(context.serving, spec.serving, 'Recount context serving'); sameIdentity(result.serving, spec.serving, 'Recount result serving');
    const watched = spec.schoolDays.find(day => day.schoolId === context.schoolId);
    assert(watched && context.date === watched.date && context.timeZone === watched.timeZone && result.schoolId === context.schoolId && result.date === context.date && result.timeZone === context.timeZone, 'Recount does not bind an exact watched school/date/timezone');
    const key = `${context.schoolId}/${context.date}`;
    assert(!results.has(key), 'Duplicate school/day numerical recount');
    const contextAt = timestamp(context.capturedAt, 'Recount context capturedAt'), resultAt = timestamp(result.capturedAt, 'Recount result capturedAt');
    assert(context.schemaVersion === 1 && result.schemaVersion === 1 && contextAt <= resultAt && resultAt <= nowMs + 60_000 && contextAt >= nowMs - 2 * HOUR && resultAt <= Date.parse(spec.reviewedAt) + 60_000, 'Recount timestamps are stale, future-dated or out of order');
    assert(context.retentionHours === inventory.get(context.schoolId)?.retentionHours && result.retentionHours === context.retentionHours, 'Recount retention changed from actual ledger inventory');
    const bounds = localDayBounds(context.date, context.timeZone);
    assert(bounds.start >= resultAt - context.retentionHours * HOUR && bounds.end <= resultAt, 'Full retained raw recount window is unavailable or incomplete');
    exact(context.trackingSettings, ['retention_hours', 'enable_tracking_hours', 'tracking_start_time', 'tracking_end_time', 'tracking_days', 'after_hours_mode'], 'Actual recount tracking settings');
    array(context.trackingEvents, 'Actual recount tracking events', 10_000, 0);
    assert(context.trackingEventsTruncated === false, 'Actual recount tracking events are truncated');
    for (const event of context.trackingEvents) {
      exact(event, ['studentId', 'eventType', 'origin', 'occurredAt', 'metadata'], 'Actual recount server tracking event');
      const occurredAt = timestamp(event.occurredAt, 'Actual recount event time');
      exact(event.metadata, ['state'], 'Actual recount tracking event metadata');
      assert(typeof event.studentId === 'string' && event.studentId.length > 0 && event.origin === 'server' && event.eventType === 'monitoring_state_changed' && occurredAt >= bounds.start && occurredAt < bounds.end, 'Actual recount tracking exclusions are not authoritative watched-day transitions');
    }
    assert(result.contextSha256 === sha256(entry.contextBytes) && result.trackingPolicySha256 === sha256(Buffer.from(JSON.stringify(context.trackingSettings))) && result.trackingEventsSha256 === sha256(Buffer.from(JSON.stringify(context.trackingEvents))), 'Actual recount context/policy/exclusion hashes changed');
    assert(result.rawDayWhollyRetained === true && result.rawHeartbeatsComplete === true && result.trackingEventsComplete === true && result.basis === 'retained-input-reread-canonical-algorithm' && result.independentReferenceAlgorithm === false, 'Actual recount lacks full retained-input completeness and canonical algorithm binding');
    for (const name of ['rawHeartbeatCount', 'recountSeconds', 'persistedSeconds', 'recountHeartbeatCount', 'persistedHeartbeatCount']) integer(result[name], `Actual recount ${name}`);
    assert(result.rawHeartbeatCount <= 1_000_000 && result.recountHeartbeatCount <= result.rawHeartbeatCount, 'Actual recount raw input size/completeness is invalid');
    assert(result.secondsMatch === true && result.heartbeatCountMatch === true && result.recountSeconds === result.persistedSeconds && result.recountHeartbeatCount === result.persistedHeartbeatCount, 'Actual retained-input numerical recount does not match persisted totals');
    results.set(key, { status: 'retained_input_check_passed', schoolId: context.schoolId, date: context.date, contextSha256: sha256(entry.contextBytes), resultSha256: sha256(entry.resultBytes), capturedAt: result.capturedAt, rawHeartbeatCount: result.rawHeartbeatCount, seconds: result.recountSeconds, heartbeatCount: result.recountHeartbeatCount, independentReferenceAlgorithm: false });
  }
  return results;
}

/** Re-read original byte inputs; also re-enforce freshness against verification time. */
export function verifyUsageObservation({ specBytes, logBytes, ledgerBytes, evidenceBytes, receiptBytes, recounts = [], recountIndexBytes, now = new Date() }) {
  const receipt = parseBytes(receiptBytes, 'Replay receipt');
  const generatedAt = timestamp(receipt.generatedAt, 'Receipt generatedAt');
  const nowMs = now instanceof Date ? now.getTime() : timestamp(now, 'now');
  assert(generatedAt <= nowMs + 60_000, 'Receipt was generated in the future');
  collectUsageObservation({ specBytes, logBytes, ledgerBytes, recounts, recountIndexBytes, now });
  const expected = collectUsageObservation({ specBytes, logBytes, ledgerBytes, recounts, recountIndexBytes, now: new Date(generatedAt) });
  assert(Buffer.from(evidenceBytes).equals(expected.evidenceBytes), 'Evidence bytes or original input hash changed; replay does not match');
  assert(Buffer.from(receiptBytes).equals(expected.receiptBytes), 'Replay receipt or original input bytes changed');
  return { verified: true, evidenceSha256: sha256(evidenceBytes), schools: expected.evidence.schoolDays.length, numericRecount: expected.receipt.numericRecount };
}

/** New read-only acquisition template; printing this SQL never executes it. */
export function buildLedgerObservationSql(spec) {
  validateSpec(spec);
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  const requested = [...new Set(spec.schoolDays.flatMap(day => [JSON.stringify([day.schoolId, day.date]), JSON.stringify([day.schoolId, addDay(day.date)])]))].map(entry => JSON.parse(entry));
  const values = requested.map(([school, date]) => `(${literal(school)}::text, ${literal(date)}::date)`).join(',\n    ');
  return `-- Read-only, content-free school/day export. Run with an approved read-only\n-- role able to see the COMPLETE eligible inventory; tenant-limited output fails\n-- the collector. No role/GUC/RLS elevation is performed here. Supplied serving\n-- identity records the operator's live inspection; SQL cannot prove ECS identity.\nBEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout = '10s';\nSET LOCAL lock_timeout = '2s';\nSET LOCAL idle_in_transaction_session_timeout = '15s';\nSET LOCAL TIME ZONE 'UTC';\nWITH eligible AS MATERIALIZED (\n  SELECT school.id AS school_id, COALESCE(NULLIF(school.school_timezone, ''), 'America/New_York') AS time_zone,\n    ${effectiveRetentionHoursSql('school_settings.retention_hours')} AS retention_hours\n  FROM schools AS school\n  JOIN product_licenses AS license ON license.school_id = school.id\n    AND license.product = 'CLASSPILOT' AND license.status = 'active'\n  LEFT JOIN settings AS school_settings ON school_settings.school_id = school.id\n  WHERE school.status = 'active' AND school.is_active = true\n    AND school.disabled_at IS NULL AND school.deleted_at IS NULL AND school.plan_status <> 'canceled'\n    AND (school.active_until IS NULL OR school.active_until > now())\n    AND (license.expires_at IS NULL OR license.expires_at > now())\n  ORDER BY school.id LIMIT ${MAX_SCHOOLS + 1}\n), requested(school_id, usage_date) AS (VALUES\n    ${values}\n), covered AS MATERIALIZED (\n  SELECT ledger.school_id, ledger.usage_date, ledger.day_start_at, ledger.day_end_at,\n    ledger.processed_through, ledger.is_final, ledger.computed_at\n  FROM requested\n  JOIN eligible ON eligible.school_id = requested.school_id\n  JOIN classpilot_usage_rollup_days AS ledger\n    ON ledger.school_id = requested.school_id AND ledger.usage_date = requested.usage_date\n)\nSELECT jsonb_build_object(\n  'schemaVersion', 1, 'capturedAt', to_char(transaction_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),\n  'serving', ${literal(JSON.stringify(spec.serving))}::jsonb,\n  'eligibleSchoolCount', (SELECT count(*) FROM eligible),\n  'inventoryTruncated', (SELECT count(*) > ${MAX_SCHOOLS} FROM eligible),\n  'schools', COALESCE((SELECT jsonb_agg(jsonb_build_object(\n    'schoolId', school_id, 'timeZone', time_zone, 'retentionHours', retention_hours) ORDER BY school_id) FROM eligible), '[]'::jsonb),\n  'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(\n    'schoolId', school_id, 'date', usage_date::text,\n    'dayStartAt', to_char(day_start_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),\n    'dayEndAt', to_char(day_end_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),\n    'processedThrough', to_char(processed_through, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),\n    'isFinal', is_final, 'computedAt', to_char(computed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))\n    ORDER BY school_id, usage_date) FROM covered), '[]'::jsonb)\n);\nCOMMIT;\n`;
}

const HELP = `Offline ClassPilot usage observation collector (no production/network access).\n\nCommands:\n  node scripts/collect-classpilot-usage-observation.mjs collect --spec spec.json --logs worker-logs.json --ledger ledger.json --out evidence.json --receipt replay.json [--now UTC] [--recount-index private-recounts.json]\n  node scripts/collect-classpilot-usage-observation.mjs verify --spec spec.json --logs worker-logs.json --ledger ledger.json --evidence evidence.json --receipt replay.json [--now UTC] [--recount-index private-recounts.json]\n  node scripts/collect-classpilot-usage-observation.mjs ledger-sql --spec spec.json\n\nInput shapes (UTF-8 JSON, no BOM; preserve EXACT exported bytes):\n spec = {schemaVersion:1, serving:{appSha:<40 hex>,imageDigest:"sha256:<64 hex>",apiArn:<exact ECS task-definition ARN>,workerArn:<exact ECS task-definition ARN>},workerLogStreams:["scheduler-worker/scheduler-worker/<32 hex task id>"],startedAt:<UTC export window start>,endedAt:<UTC export window end>,reviewedAt:"YYYY-MM-DDTHH:mm:ss.fffffffZ" (seven fractional digits),reviewReference:<safe review id>,schoolDays:[{schoolId:<UUID>,date:"YYYY-MM-DD",timeZone:<IANA zone>}]}.\n One watched weekday per EVERY eligible school; source/digest/ARN/worker streams must be recorded from live serving inspection, never guessed from logs. No worker image/source switch may cross the window.\n logs = actual fully paginated AWS logs filter-log-events JSON {events:[{eventId,logStreamName,timestamp:<epoch ms>,message:<raw JSON log line>,ingestionTime?}], searchedLogStreams?:[...]}; a nonempty nextToken is refused. Export window must span each full school-local day plus its following hour. Derive UTC start as min(each local midnight, each first required UTC bucket) and UTC end as max(each next midnight +1h), using exported requiredObservationExportWindow(schoolDays). Fractional DST (for example Lord_Howe23.5h) can require a UTC tick30minutes before local midnight; include that leading tick rather than starting exactly at midnight. Each required UTC scheduler bucket must contain >=1 clean actual classpilot_usage_rollup sample; clean restart duplicates cannot fill a missing hour. Logs do not establish per-school coverage.\n ledger = {schemaVersion:1,capturedAt:<UTC>,serving:<same exact identity>,eligibleSchoolCount:<int>,inventoryTruncated:false,schools:[{schoolId,timeZone,retentionHours:<effective whole days in hours>}],days:[{schoolId,date,dayStartAt,dayEndAt,processedThrough,isFinal,computedAt}]}. No student ids, URLs, content or aggregate numeric totals. Missing/invalidated coverage is ABSENT, never invented zero.\n ledger-sql prints a bounded repeatable-read READ ONLY SQL template; it DOES NOT EXECUTE SQL. Use an approved read-only role with complete inventory visibility; ledger joins explicitly bind requested school/date. Capture unaligned psql tuples-only output (-X -A -t -q -v ON_ERROR_STOP=1); preserve its bytes. Inventory is capped at 1,000 plus a rejecting sentinel, requested ledger rows at 2,000, SQL at 10 seconds and lock wait at 2 seconds. Identity in SQL records supplied live inspection, not an independently authenticated ECS measurement.\n\nChecks: exact identities, complete eligible inventory, watched weekday/timezone, DST-safe UTC hourly buckets, all emitted counters, zero failures/deferrals/retention skips, no budget exhaustion, duration >0 and <1500000ms; final watched ledger and valid non-final next-day cutoff. Idle unchanged live snapshots may be old within the next day. Expired school-local aggregate ledger days fail; a valid final retained ledger is allowed when raw retention prevents recount, recorded separately with reportRetainedFrom. Coverage snapshot must follow end+1h and be <=2h old at review; review is <=2h old at now. No raw numerical recount is claimed without original actual recount exports: wholly retained raw days require a passed recount, while partly purged days keep a per-school unavailable reason. Recount commands and their retention requirements are documented below.\n\ncollect creates new files only (refuses overwrite); verify re-reads all exact inputs, recomputes evidence, validates freshness and byte hashes. All CLI inputs and outputs require existing private operator evidence storage outside every Git repository/worktree; PowerShell 7.5 and scripts/private-permissions.ps1 enforce no reparse traversal and owner/SYSTEM-only ACLs (owner-only Unix permissions). Create a private parent directory first; the collector never changes an existing parent directory ACL. Re-run verify with current time immediately before setter Plan/Apply. --now exists for deterministic replay/tests; do not override production review time.\n`;

const OPTIONAL_HELP = `\nRetained-input numerical checks (REQUIRED while the whole raw watched day remains retained):\n  node scripts/classpilot-usage-retained-recount.mjs --help\n Generate recount-input-sql for one watched school; capture actual private context JSON. Generate recount-sql using that original context and exact serving source; separately capture its actual private result JSON. A generated query alone is unavailable evidence. Neither script executes SQL.\n recount-index = {schemaVersion:1,entries:[{contextPath:<absolute private original context JSON path>,resultPath:<absolute private original result JSON path>}]}. Add --recount-index to BOTH collect and verify. Exact context/result/index bytes are hashed; identities, school/date/timezone, context/policy/exclusion hashes, actual raw-retention completeness, bounded row count and equal seconds/heartbeat totals are revalidated. A wholly retained raw watched day REQUIRES its actual passed recount; missing exports block collection. Only genuinely partly purged raw days keep explicit unavailable reasons. Mismatches refuse collection. These results reread retained inputs using the canonical attribution algorithm and do not establish independent reference-algorithm proof or recover deleted/expired history.\n`;

async function main(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP + OPTIONAL_HELP); return; }
  const [command, ...rest] = args, options = {};
  assert(['collect', 'verify', 'ledger-sql'].includes(command), 'Unknown command; use --help');
  for (let index = 0; index < rest.length; index += 2) {
    assert(/^--[a-z-]+$/.test(rest[index]) && rest[index + 1] && !rest[index + 1].startsWith('--') && !Object.hasOwn(options, rest[index].slice(2)), 'Provide each named option once with its value');
    options[rest[index].slice(2)] = rest[index + 1];
  }
  const allowed = command === 'ledger-sql' ? ['spec'] : command === 'collect' ? ['spec', 'logs', 'ledger', 'out', 'receipt', 'now', 'recount-index'] : ['spec', 'logs', 'ledger', 'evidence', 'receipt', 'now', 'recount-index'];
  const required = allowed.filter(name => !['now', 'recount-index'].includes(name));
  assert(Object.keys(options).every(name => allowed.includes(name)) && required.every(name => options[name]), 'Missing or unknown option; use --help');
  const inputNames = command === 'ledger-sql' ? ['spec'] : command === 'collect' ? ['spec', 'logs', 'ledger'] : ['spec', 'logs', 'ledger', 'evidence', 'receipt'];
  assertPrivateObservationPaths({ inputs: [...inputNames.map(name => options[name]), ...(options['recount-index'] ? [options['recount-index']] : [])], outputs: command === 'collect' ? [options.out, options.receipt] : [] });
  const specBytes = await readFile(resolve(options.spec));
  if (command === 'ledger-sql') { process.stdout.write(buildLedgerObservationSql(parseBytes(specBytes, 'spec'))); return; }
  const [logBytes, ledgerBytes] = await Promise.all([readFile(resolve(options.logs)), readFile(resolve(options.ledger))]);
  const now = options.now ? new Date(timestamp(options.now, 'now')) : new Date();
  let recountIndexBytes;
  const recounts = [];
  if (options['recount-index']) {
    recountIndexBytes = await readFile(resolve(options['recount-index']));
    const index = parseBytes(recountIndexBytes, 'Recount index');
    exact(index, ['schemaVersion', 'entries'], 'Recount index');
    assert(index.schemaVersion === 1, 'Recount index schemaVersion must be 1');
    array(index.entries, 'Recount index entries', MAX_SCHOOLS);
    for (const entry of index.entries) {
      exact(entry, ['contextPath', 'resultPath'], 'Recount index entry');
      assert(typeof entry.contextPath === 'string' && isAbsolute(entry.contextPath) && typeof entry.resultPath === 'string' && isAbsolute(entry.resultPath), 'Recount original context/result paths must be absolute');
    }
    assertPrivateObservationPaths({ inputs: index.entries.flatMap(entry => [entry.contextPath, entry.resultPath]) });
    for (const entry of index.entries) {
      const [contextBytes, resultBytes] = await Promise.all([readFile(entry.contextPath), readFile(entry.resultPath)]);
      recounts.push({ contextBytes, resultBytes });
    }
  }
  if (command === 'collect') {
    assert(resolve(options.out) !== resolve(options.receipt), 'Evidence and receipt paths must differ');
    const result = collectUsageObservation({ specBytes, logBytes, ledgerBytes, recounts, recountIndexBytes, now });
    const created = [];
    try {
      for (const [target, content] of [[options.out, result.evidenceBytes], [options.receipt, result.receiptBytes]]) {
        await writeFile(resolve(target), content, { flag: 'wx', mode: 0o600 });
        created.push(resolve(target));
      }
      assertPrivateObservationPaths({ protect: created });
    } catch (error) {
      await Promise.allSettled(created.map(target => unlink(target)));
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ evidenceSha256: sha256(result.evidenceBytes), schools: result.evidence.schoolDays.length, numericRecount: result.receipt.numericRecount.status })}\n`);
  } else {
    const [evidenceBytes, receiptBytes] = await Promise.all([readFile(resolve(options.evidence)), readFile(resolve(options.receipt))]);
    process.stdout.write(`${JSON.stringify(verifyUsageObservation({ specBytes, logBytes, ledgerBytes, evidenceBytes, receiptBytes, recounts, recountIndexBytes, now }))}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { process.stderr.write(`Usage observation refused: ${error.message}\n`); process.exitCode = 1; });
