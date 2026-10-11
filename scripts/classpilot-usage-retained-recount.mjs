#!/usr/bin/env node
/** Recount required for wholly retained watched raw days; generates SQL only. */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPrivateObservationPaths, effectiveRetentionHoursSql, localDayBounds, readObservationJson, readObservationSpec, sha256 } from './collect-classpilot-usage-observation.mjs';

const HOUR = 3_600_000;
const MAX_EVENTS = 10_000;
const MAX_HEARTBEATS = 1_000_000;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function assert(value, message) { if (!value) throw new Error(message); }
function utc(value, label) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value)), `${label} must be a real UTC timestamp`);
  return Date.parse(value);
}
function exact(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label} must contain exactly ${keys.join(', ')}`);
}
function watched(spec, schoolId) {
  const day = spec.schoolDays.find(value => value.schoolId === schoolId);
  assert(day, 'school-id must be an exact eligible watched-school binding from spec');
  return { ...day, ...localDayBounds(day.date, day.timeZone) };
}
function header() {
  return `-- Optional retained-input reread; generated SQL only, never executed here.\n-- Requires approved read-only tenant access and psql ON_ERROR_STOP=1.\n-- Canonical attribution algorithm, not independent reference-algorithm proof.\nBEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout = '10s';\nSET LOCAL lock_timeout = '2s';\nSET LOCAL idle_in_transaction_session_timeout = '15s';\nSET LOCAL TIME ZONE 'UTC';\n`;
}
const settingsJson = alias => `jsonb_build_object('retention_hours', ${alias}.retention_hours, 'enable_tracking_hours', ${alias}.enable_tracking_hours, 'tracking_start_time', ${alias}.tracking_start_time, 'tracking_end_time', ${alias}.tracking_end_time, 'tracking_days', ${alias}.tracking_days, 'after_hours_mode', ${alias}.after_hours_mode)`;
const eventJson = alias => `jsonb_build_object('studentId', ${alias}.student_id, 'eventType', ${alias}.event_type, 'origin', ${alias}.origin, 'occurredAt', to_char(${alias}.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'metadata', jsonb_build_object('state', ${alias}.metadata->'state'))`;
const effectiveRetention = alias => effectiveRetentionHoursSql(`${alias}.retention_hours`);
function eventsQuery(day) {
  return `SELECT tracking.id, tracking.student_id, tracking.event_type, tracking.origin, tracking.occurred_at, tracking.metadata\n  FROM classpilot_monitoring_events AS tracking\n  JOIN students AS student ON student.id = tracking.student_id AND student.school_id = ${literal(day.schoolId)}\n  WHERE tracking.school_id = ${literal(day.schoolId)} AND tracking.origin = 'server'\n    AND tracking.event_type = 'monitoring_state_changed'\n    AND tracking.occurred_at >= ${literal(new Date(day.start).toISOString())}::timestamptz\n    AND tracking.occurred_at < ${literal(new Date(day.end).toISOString())}::timestamptz\n  ORDER BY tracking.student_id, tracking.occurred_at, tracking.id LIMIT ${MAX_EVENTS + 1}`;
}

/** Minimal private settings/server-transition export; no URLs or heartbeat rows. */
export function buildRetainedRecountInputSql(spec, schoolId) {
  const day = watched(spec, schoolId);
  return `${header()}WITH tracking_events AS MATERIALIZED (\n  ${eventsQuery(day)}\n)\nSELECT jsonb_build_object(\n  'schemaVersion', 1, 'capturedAt', to_char(transaction_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),\n  'serving', ${literal(JSON.stringify(spec.serving))}::jsonb,\n  'schoolId', school.id, 'date', ${literal(day.date)}, 'timeZone', COALESCE(NULLIF(school.school_timezone, ''), 'America/New_York'),\n  'retentionHours', ${effectiveRetention('settings')},\n  'trackingSettings', ${settingsJson('settings')},\n  'trackingEventsTruncated', (SELECT count(*) > ${MAX_EVENTS} FROM tracking_events),\n  'trackingEvents', COALESCE((SELECT jsonb_agg(${eventJson('event')} ORDER BY event.student_id, event.occurred_at, event.id) FROM tracking_events AS event), '[]'::jsonb)\n)\nFROM schools AS school LEFT JOIN settings ON settings.school_id = school.id\nWHERE school.id = ${literal(day.schoolId)};\nCOMMIT;\n`;
}

/** Application helpers are injected in tests; CLI loads the exact source-bound helpers. */
export function buildRetainedRecountSql({ spec, context, contextBytes = Buffer.from(JSON.stringify(context)), now = new Date(), application }) {
  exact(context, ['schemaVersion', 'capturedAt', 'serving', 'schoolId', 'date', 'timeZone', 'retentionHours', 'trackingSettings', 'trackingEventsTruncated', 'trackingEvents'], 'Recount context');
  const day = watched(spec, context.schoolId);
  assert(context.schemaVersion === 1 && context.date === day.date && context.timeZone === day.timeZone, 'Recount context does not bind the watched school/date/timezone');
  assert(JSON.stringify(context.serving) === JSON.stringify(spec.serving) || ['appSha', 'imageDigest', 'apiArn', 'workerArn'].every(key => context.serving?.[key] === spec.serving[key]), 'Recount context changed exact serving identity');
  const capturedAt = utc(context.capturedAt, 'Recount capturedAt'), nowMs = now.getTime();
  assert(capturedAt <= nowMs + 60_000 && capturedAt >= nowMs - 2 * HOUR, 'Recount context is stale or future-dated');
  assert(Number.isSafeInteger(context.retentionHours) && context.retentionHours >= 24 && context.retentionHours <= 8760 && context.retentionHours % 24 === 0, 'Invalid effective retention in recount context');
  assert(day.start >= nowMs - context.retentionHours * HOUR, 'Full retained raw day is unavailable: its beginning may have been purged');
  assert(day.end <= nowMs, 'A full-day recount requires an ended watched day');
  assert(context.trackingEventsTruncated === false && Array.isArray(context.trackingEvents) && context.trackingEvents.length <= MAX_EVENTS, 'Actual server tracking transitions are incomplete/truncated');
  exact(context.trackingSettings, ['retention_hours', 'enable_tracking_hours', 'tracking_start_time', 'tracking_end_time', 'tracking_days', 'after_hours_mode'], 'Actual tracking settings');
  const trackingEvents = context.trackingEvents.map(event => {
    exact(event, ['studentId', 'eventType', 'origin', 'occurredAt', 'metadata'], 'Actual server tracking transition');
    const occurredAt = utc(event.occurredAt, 'Tracking transition occurredAt');
    assert(typeof event.studentId === 'string' && event.studentId.length > 0 && event.eventType === 'monitoring_state_changed' && event.origin === 'server' && occurredAt >= day.start && occurredAt < day.end, 'Tracking event is outside the watched authoritative school/day');
    exact(event.metadata, ['state'], 'Tracking transition metadata');
    return { ...event, occurredAt: new Date(occurredAt) };
  });
  assert(application && typeof application.classpilotUsageTrackingPolicy === 'function' && typeof application.classpilotUsageExclusions === 'function' && typeof application.classpilotUsageExclusionsJson === 'function', 'Actual application tracking exclusion helpers are required');
  const exclusions = application.classpilotUsageExclusions({
    trackingPolicy: application.classpilotUsageTrackingPolicy(context.trackingSettings, day.timeZone), trackingEvents,
    windowStart: new Date(day.start), windowEnd: new Date(day.end),
  });
  const exclusionsJson = application.classpilotUsageExclusionsJson(exclusions);
  const production = application.CLASSPILOT_USAGE_ROLLUP_INSERT_SQL;
  const endIndex = typeof production === 'string' ? production.indexOf(',\nexisting_grains AS MATERIALIZED (') : -1;
  assert(endIndex > 0, 'Canonical grain query boundary changed; review recount extraction before using it');
  const grainsSql = production.slice(0, endIndex);
  assert(!/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\s+(?:INTO|FROM|TABLE)\b/i.test(grainsSql), 'Extracted recount query must be read-only');
  const schoolLiteral = literal(day.schoolId), start = literal(new Date(day.start).toISOString()), end = literal(new Date(day.end).toISOString());
  const events = JSON.stringify(context.trackingEvents);
  return `${header()}\\o ${process.platform === 'win32' ? 'NUL' : '/dev/null'}\n-- Context bytes SHA-256: ${sha256(contextBytes)}\n-- Refuse partly retained input, settings/state drift, invalidated coverage, or\n-- more than ${MAX_HEARTBEATS} retained observations; failures abort this read-only transaction.\nSELECT 1 / (CASE WHEN ${start}::timestamptz >= now() - make_interval(hours => (${effectiveRetention('settings')})::integer)\n  AND ${settingsJson('settings')} = ${literal(JSON.stringify(context.trackingSettings))}::jsonb\n  AND COALESCE(NULLIF(school.school_timezone, ''), 'America/New_York') = ${literal(day.timeZone)}\n  THEN 1 ELSE 0 END) AS retained_policy_guard\nFROM schools AS school LEFT JOIN settings ON settings.school_id = school.id WHERE school.id = ${schoolLiteral};\nWITH tracking_events AS MATERIALIZED (\n  ${eventsQuery(day)}\n) SELECT 1 / (CASE WHEN count(*) <= ${MAX_EVENTS}\n  AND COALESCE(jsonb_agg(${eventJson('event')} ORDER BY event.student_id, event.occurred_at, event.id), '[]'::jsonb) = ${literal(events)}::jsonb\n  THEN 1 ELSE 0 END) AS actual_tracking_events_guard FROM tracking_events AS event;\nSELECT 1 / (CASE WHEN count(*) = 1 THEN 1 ELSE 0 END) AS final_ledger_guard\nFROM classpilot_usage_rollup_days WHERE school_id = ${schoolLiteral} AND usage_date = ${literal(day.date)}::date\n  AND is_final = true AND day_start_at = ${start}::timestamptz AND day_end_at = ${end}::timestamptz AND processed_through = ${end}::timestamptz;\nSELECT 1 / (CASE WHEN count(*) <= ${MAX_HEARTBEATS} THEN 1 ELSE 0 END) AS raw_size_guard FROM (\n  SELECT 1 FROM heartbeats WHERE school_id = ${schoolLiteral} AND student_id IS NOT NULL\n    AND "timestamp" >= ${start}::timestamptz AT TIME ZONE 'UTC'\n    AND "timestamp" < ${end}::timestamptz AT TIME ZONE 'UTC' LIMIT ${MAX_HEARTBEATS + 1}\n) AS raw_bound;\n\\o\nPREPARE classpilot_usage_retained_recount(text, timestamp, timestamp, date, jsonb) AS\n${grainsSql},\nrecount AS (SELECT COALESCE(sum(seconds), 0)::bigint AS seconds, COALESCE(sum(heartbeat_count), 0)::bigint AS heartbeat_count FROM grains),\npersisted AS (SELECT COALESCE(sum(seconds), 0)::bigint AS seconds, COALESCE(sum(heartbeat_count), 0)::bigint AS heartbeat_count\n  FROM classpilot_usage_rollups WHERE school_id = $1 AND usage_date = $4)\nSELECT jsonb_build_object('schemaVersion', 1, 'schoolId', $1, 'date', $4::text, 'timeZone', ${literal(day.timeZone)},\n  'capturedAt', to_char(transaction_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),\n  'contextSha256', ${literal(sha256(contextBytes))},\n  'trackingPolicySha256', ${literal(sha256(Buffer.from(JSON.stringify(context.trackingSettings))))},\n  'trackingEventsSha256', ${literal(sha256(Buffer.from(JSON.stringify(context.trackingEvents))))},\n  'retentionHours', ${context.retentionHours}, 'rawDayWhollyRetained', true,\n  'rawHeartbeatsComplete', true, 'trackingEventsComplete', true,\n  'serving', ${literal(JSON.stringify(spec.serving))}::jsonb,\n  'basis', 'retained-input-reread-canonical-algorithm', 'independentReferenceAlgorithm', false,\n  'rawHeartbeatCount', (SELECT count(*) FROM heartbeats WHERE school_id = $1 AND student_id IS NOT NULL AND "timestamp" >= $2 AND "timestamp" < $3),\n  'recountSeconds', recount.seconds, 'persistedSeconds', persisted.seconds,\n  'recountHeartbeatCount', recount.heartbeat_count, 'persistedHeartbeatCount', persisted.heartbeat_count,\n  'secondsMatch', recount.seconds = persisted.seconds, 'heartbeatCountMatch', recount.heartbeat_count = persisted.heartbeat_count)\nFROM recount CROSS JOIN persisted;\nEXECUTE classpilot_usage_retained_recount(${schoolLiteral},\n  ${literal(new Date(day.start).toISOString().replace('T', ' ').replace('Z', ''))}::timestamp,\n  ${literal(new Date(day.end).toISOString().replace('T', ' ').replace('Z', ''))}::timestamp,\n  ${literal(day.date)}::date, ${literal(exclusionsJson)}::jsonb);\nCOMMIT;\n`;
}

export function assertExactRecountSource(sourceDirectory, sourceSha) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8', windowsHide: true });
  const clean = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src'], { cwd: sourceDirectory, encoding: 'utf8', windowsHide: true });
  assert(head.status === 0 && head.stdout.trim() === sourceSha && clean.status === 0 && clean.stdout.trim() === '', 'Optional recount requires the exact serving source checkout with no modified or untracked src inputs');
}
async function loadExactApplication(spec) {
  assertExactRecountSource(ROOT, spec.serving.appSha);
  const { tsImport } = await import('tsx/esm/api');
  return tsImport(resolve(ROOT, 'src/services/classpilotUsageRollup.ts'), import.meta.url);
}

const HELP = `Bounded retained-input numerical validation; generates SQL only.\nRequired for every watched raw day whose complete inputs remain retained. Collection blocks without its actual passed recount; an unavailable reason is allowed only when complete inputs are genuinely absent.\n\n  node scripts/classpilot-usage-retained-recount.mjs recount-input-sql --spec <private spec.json> --school-id <watched UUID>\n  node scripts/classpilot-usage-retained-recount.mjs recount-sql --spec <private spec.json> --context <private context.json> [--now UTC]\n\nThe first command prints a 10-second READ ONLY, explicitly tenant-scoped context export. An approved read-only operator captures its actual settings and server tracking transitions as private UTF-8 JSON using psql -X -A -t -q -v ON_ERROR_STOP=1. It contains private student identifiers in server transitions; keep it outside every Git repository under owner-only permissions. No URLs or heartbeat content are exported.\n\nThe second command requires the exact serving source checkout and unchanged src, and loads the application's classpilotUsageTrackingPolicy/classpilotUsageExclusions helpers through tsx. It refuses stale context, truncated transitions and any watched window whose beginning may have been purged. It prints a 10-second READ ONLY retained-input reread of the canonical grain SQL, with 10-second per-statement timeouts, psql guard output suppressed, <=1,000,000 raw heartbeats and <=10,000 tracking transitions; checks the actual live policy/transitions against the context and actual final ledger in the SAME repeatable-read snapshot; and compares summed seconds and counted heartbeats with persisted aggregates. The SQL never rewrites aggregates, synthesizes coverage, changes schema, elevates a role/GUC, or connects to production.\n\nRun reviewed SQL separately only under the separately authorized operator procedure; capture the actual JSON totals result privately. secondsMatch and heartbeatCountMatch must both be true; a timeout, size cap, policy drift, invalidated ledger, lost raw retention or missing input records does not produce a passed recount. Timeouts, size caps or policy drift block collection while complete raw inputs remain retained; only genuinely absent complete inputs allow an explicit unavailable reason. This checks actual retained inputs with the canonical application algorithm; it is NOT independent reference-algorithm proof. Pass the ORIGINAL context and ACTUAL result files through a private recount-index to BOTH collect and verify. The collector validates their exact byte hashes, serving and school/day bindings, raw completeness, policy/exclusion context and matching numerical totals; generated SQL alone remains unavailable evidence. No load test is run.\n`;
async function main(args) {
  if (!args.length || args.includes('--help')) { process.stdout.write(HELP); return; }
  const [command, ...rest] = args, options = {};
  assert(['recount-input-sql', 'recount-sql'].includes(command), 'Unknown command; use --help');
  for (let index = 0; index < rest.length; index += 2) {
    assert(/^--[a-z-]+$/.test(rest[index]) && rest[index + 1] && !rest[index + 1].startsWith('--') && !Object.hasOwn(options, rest[index].slice(2)), 'Provide each named option once');
    options[rest[index].slice(2)] = rest[index + 1];
  }
  const allowed = command === 'recount-input-sql' ? ['spec', 'school-id'] : ['spec', 'context', 'now'];
  assert(allowed.filter(key => key !== 'now').every(key => options[key]) && Object.keys(options).every(key => allowed.includes(key)), 'Missing/unknown option; use --help');
  assertPrivateObservationPaths({ inputs: [options.spec, ...(options.context ? [options.context] : [])] });
  const spec = readObservationSpec(await readFile(resolve(options.spec)));
  if (command === 'recount-input-sql') { process.stdout.write(buildRetainedRecountInputSql(spec, options['school-id'])); return; }
  const contextBytes = await readFile(resolve(options.context));
  assert(contextBytes.length <= 16 * 1024 * 1024 && !(contextBytes[0] === 0xef && contextBytes[1] === 0xbb && contextBytes[2] === 0xbf), 'Context must be bounded UTF-8 JSON without BOM');
  const context = readObservationJson(contextBytes, 'Recount context');
  const now = options.now ? new Date(utc(options.now, 'now')) : new Date();
  const application = await loadExactApplication(spec);
  process.stdout.write(buildRetainedRecountSql({ spec, context, contextBytes, now, application }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { process.stderr.write(`Retained recount unavailable: ${error.message}\n`); process.exitCode = 1; });
