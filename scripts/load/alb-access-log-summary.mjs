// Summarize a window of production ALB access logs in one command.
//
// Replaces the zcat/awk pipeline that was hand-run about fifteen times during
// the 2026-09-03 school day. That pipeline produced two field-mapping mistakes
// (received_bytes read as $6; the quoted user agent counted as one awk field),
// so the field table below is the load-bearing part of this file.
//
// FIELD INDEX TABLE -- two numbering systems, both listed on purpose.
//
//   awk $N (space-split, what you type in zcat|awk)   tokenized t[i] (quote-aware, used here)
//   $1  type          (https | http | h2 | wss)        t[0]
//   $2  time          ISO-8601 with microseconds       t[1]   for /ws rows this is the CLOSE time
//   $3  elb                                            t[2]
//   $4  client:port   CloudFront edge IP; not useful   t[3]
//   $5  target:port   "-" when no target was reached   t[4]
//   $6  request_processing_time   -1 => not recorded    t[5]
//   $7  target_processing_time    -1 => not recorded    t[6]
//   $8  response_processing_time  -1 => not recorded    t[7]
//   $9  elb_status_code                                t[8]
//   $10 target_status_code        "-" when no target   t[9]
//   $11 received_bytes  <-- upload size lives HERE     t[10]
//   $12 sent_bytes                                     t[11]
//   $13 "METHOD                                        t[12] = "METHOD URL PROTOCOL" as ONE token
//   $14 URL            carries scheme+host+port
//   $15 PROTOCOL"
//   $16+ user_agent    1 token here, many awk fields   t[13]
//        ssl_cipher                                    t[14]
//        ssl_protocol                                  t[15]
//        target_group_arn                              t[16]
//        trace_id                                      t[17]
//        domain_name                                   t[18]
//        chosen_cert_arn                               t[19]
//        matched_rule_priority                         t[20]
//        request_creation_time                         t[21]  for /ws rows this is the OPEN time
//        actions_executed                              t[22]
//        redirect_url                                  t[23]
//        error_reason                                  t[24]
//        target:port_list                              t[25]
//        target_status_code_list                       t[26]
//        classification                                t[27]
//        classification_reason                         t[28]
//        conn_trace_id                                 t[29]
//        transformed_host                              t[30]
//        transformed_uri                               t[31]
//        request_transform_status                      t[32]
//        alb_node_ip                                   t[33]
//
// Quote-aware tokenization yields exactly 34 tokens on 100% of rows. awk's $N
// is stable only through $15; beyond that it varies with the user agent
// (37 space-split fields for a CloudFront row, 46 for a browser /ws row).
//
// Objects are 5-minute rollups whose name stamp is the interval END and which
// arrive about five minutes late, so object names are only a coarse selector:
// ROWS ARE SELECTED BY THEIR OWN TIMESTAMP, never by the file name.

import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const ALB_ACCESS_LOG_SUMMARY_VERSION = "alb-access-log-summary-v1";

export const UPLOAD_SIZE_BUCKET_BYTES = [25600, 51200];
export const UPLOAD_ROUTE_KEY = "POST /api/classpilot/device/screenshot";
const DEFAULT_BUCKET = "schoolpilot-production-alb-access-logs-135775632425";
const DEFAULT_ACCOUNT = "135775632425";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_ROUTE_PATTERN = "device/heartbeat";
const DEFAULT_TOP = 25;
const MAX_WINDOW_MS = 6 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
// Basenames are ~137 chars and each "--include <basename>" adds ~148 characters;
// keep every argv well under the ~32k Windows command-line limit.
const MAX_INCLUDES_PER_FETCH = 150;
// Routes whose clients are real browsers rather than CloudFront.
const DIRECT_CLIENT_ROUTES = /^\/(?:ws|gopilot-socket)(?:\/|$)/;

const ALB_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const OBJECT_STAMP = /_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z_/;

export function tokenizeAlbLine(line) {
  if (typeof line !== "string") throw new TypeError("ALB log lines must be strings");
  const tokens = [];
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) {
    tokens.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return tokens;
}

function albTimeToMs(value) {
  const match = ALB_TIME.exec(value ?? "");
  if (!match) return null;
  const millis = match[7] ? Number(String(match[7]).slice(0, 3).padEnd(3, "0")) : 0;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]), millis,
  );
}

function objectStampMs(name) {
  const stamp = OBJECT_STAMP.exec(name);
  if (!stamp) return null;
  return Date.UTC(
    Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]),
    Number(stamp[4]), Number(stamp[5]),
  );
}

function seconds(value) {
  // "-1" means no timing was recorded for that phase (the client closed
  // before a response, or the target never answered). It is absence, not a
  // duration, and it does NOT by itself prove no target was selected.
  if (value === undefined || value === "-" || value === "-1") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function normalizeRoute(url) {
  if (typeof url !== "string") throw new TypeError("Routes must be normalized from strings");
  if (url === "-" || url === "") return "-";
  let path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (path === "") return "/";
  const normalized = path.split("/").map((segment) => {
    if (segment === "") return segment;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
    if (/^\d+$/.test(segment)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
    // Opaque tokens carry a digit; hyphenated route names such as
    // "students-aggregated" and "session-gate-presence" must survive.
    if (segment.length >= 20 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment)) return ":id";
    return segment;
  }).join("/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function parseAlbLine(line) {
  const tokens = tokenizeAlbLine(line);
  if (tokens.length < 14) return null;
  const timeMs = albTimeToMs(tokens[1]);
  if (timeMs === null) return null;
  if (!/^\d{3}$/.test(tokens[8] ?? "")) return null;

  const request = tokens[12] ?? "- - -";
  const firstSpace = request.indexOf(" ");
  const lastSpace = request.lastIndexOf(" ");
  const method = firstSpace === -1 ? "-" : request.slice(0, firstSpace);
  const url = firstSpace === -1 || lastSpace <= firstSpace ? "-" : request.slice(firstSpace + 1, lastSpace);
  const protocol = lastSpace === -1 || lastSpace === request.length - 1 ? "-" : request.slice(lastSpace + 1);
  const route = normalizeRoute(url);
  const target = tokens[4] === "-" ? null : tokens[4];

  return {
    type: tokens[0],
    timeMs,
    timeIso: tokens[1],
    requestCreationMs: albTimeToMs(tokens[21]),
    elb: tokens[2],
    client: tokens[3],
    target,
    targetIp: target ? target.slice(0, target.lastIndexOf(":")) : null,
    requestProcessingSeconds: seconds(tokens[5]),
    targetProcessingSeconds: seconds(tokens[6]),
    responseProcessingSeconds: seconds(tokens[7]),
    elbStatus: Number(tokens[8]),
    targetStatus: tokens[9] === "-" || tokens[9] === undefined ? null : Number(tokens[9]),
    receivedBytes: integer(tokens[10]),
    sentBytes: integer(tokens[11]),
    method,
    url,
    protocol,
    route,
    routeKey: `${method} ${route}`,
    userAgent: tokens[13] ?? "-",
    domain: tokens[18] ?? "-",
    errorReason: tokens[24] ?? "-",
    targetStatusList: tokens[26] ?? "-",
  };
}

export function percentile(sorted, p) {
  if (!Array.isArray(sorted)) throw new TypeError("Percentiles need a sorted array");
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function stats(values) {
  if (values.length === 0) return { avg: null, p50: null, max: null, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    max: sorted[sorted.length - 1],
    samples: sorted.length,
  };
}

function zoneDate(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function formatUtc(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
}

export function formatLocal(ms, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(ms));
}

export function parseWindow({ from, to, date, nowMs, timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError("parseWindow requires nowMs");
  // The operator's day is local: after 20:00 ET the UTC date is already
  // tomorrow, so an unqualified "--from 14:30" must not jump a day.
  const day = date || zoneDate(nowMs, timeZone);
  const resolvePoint = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const text = String(value).trim();
    const clock = /^(\d{1,2}):(\d{2})Z?$/.exec(text);
    if (clock) {
      // Date.UTC happily rolls 25:70 into the next day, which would also move
      // the S3 day prefix. Reject it by name instead.
      if (Number(clock[1]) > 23 || Number(clock[2]) > 59) {
        throw new TypeError(`"${text}" is not a clock time between 00:00 and 23:59`);
      }
      const parsed = albTimeToMs(`${day}T${String(clock[1]).padStart(2, "0")}:${clock[2]}:00Z`);
      if (parsed === null) throw new TypeError(`Could not resolve "${text}" on ${day}`);
      return parsed;
    }
    const direct = Date.parse(text);
    if (!Number.isFinite(direct)) throw new TypeError(`Unparseable time "${text}"`);
    return direct;
  };
  const fromMs = resolvePoint(from, null);
  const toMs = resolvePoint(to, nowMs);
  if (fromMs === null) throw new TypeError("A window needs --from");
  if (!(fromMs < toMs)) throw new TypeError("--from must precede --to");
  return { fromMs, toMs, date: day };
}

export function summarizeRecords(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("summarizeRecords needs an array of records");
  const {
    fromMs, toMs, routePattern = DEFAULT_ROUTE_PATTERN, targetIp = null,
    top = DEFAULT_TOP, timeZone = DEFAULT_TIME_ZONE, newestObjectMs = null,
  } = options;
  let routeRegex;
  try {
    routeRegex = new RegExp(routePattern);
  } catch {
    throw new TypeError(`--route is not a valid regular expression: ${routePattern}`);
  }

  const hasWindow = fromMs !== undefined && fromMs !== null && toMs !== undefined && toMs !== null;
  const inWindow = records.filter((record) => {
    if (fromMs !== undefined && fromMs !== null && record.timeMs < fromMs) return false;
    if (toMs !== undefined && toMs !== null && record.timeMs >= toMs) return false;
    // Match "<ip>:" so 10.1.100.6 cannot select 10.1.100.65.
    if (targetIp && (record.target === null || !record.target.startsWith(`${targetIp}:`))) return false;
    return true;
  });

  const byStatusClass = { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  let clientClosed460 = 0;
  let nonCloudFrontRows = 0;
  let wsRows = 0;
  const routes = new Map();
  const targets = new Map();
  const errors = new Map();
  const uploads = [];
  const uploadSlices = new Map();
  const targetSlices = new Map();
  const series = new Map();
  const matchedRouteKeys = new Set();

  for (const record of inWindow) {
    const cls = `${Math.floor(record.elbStatus / 100)}xx`;
    if (byStatusClass[cls] !== undefined) byStatusClass[cls] += 1;
    if (record.elbStatus === 460) clientClosed460 += 1;
    // /ws and /gopilot-socket are reached by browsers directly, so their real
    // user agents are expected; only other routes must be CloudFront-only.
    if (DIRECT_CLIENT_ROUTES.test(record.route)) wsRows += 1;
    else if (record.userAgent !== "Amazon CloudFront") nonCloudFrontRows += 1;

    let route = routes.get(record.routeKey);
    if (!route) {
      route = {
        routeKey: record.routeKey, method: record.method, route: record.route,
        count: 0, statuses: {}, durations: [], noTarget: 0,
      };
      routes.set(record.routeKey, route);
    }
    route.count += 1;
    route.statuses[record.elbStatus] = (route.statuses[record.elbStatus] ?? 0) + 1;
    if (record.targetProcessingSeconds === null) route.noTarget += 1;
    else route.durations.push(record.targetProcessingSeconds * 1000);

    const targetKey = record.target ?? "-";
    let targetEntry = targets.get(targetKey);
    if (!targetEntry) {
      targetEntry = {
        target: targetKey, count: 0, durations: [], status5xx: 0, status460: 0,
        statusClasses: { "1xx": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
      };
      targets.set(targetKey, targetEntry);
    }
    targetEntry.count += 1;
    if (targetEntry.statusClasses[cls] !== undefined) targetEntry.statusClasses[cls] += 1;
    if (cls === "5xx") targetEntry.status5xx += 1;
    if (record.elbStatus === 460) targetEntry.status460 += 1;
    if (record.targetProcessingSeconds !== null) targetEntry.durations.push(record.targetProcessingSeconds * 1000);

    const sliceStart = Math.floor(record.timeMs / TEN_MINUTES_MS) * TEN_MINUTES_MS;
    let targetSlice = targetSlices.get(sliceStart);
    if (!targetSlice) {
      targetSlice = { startMs: sliceStart, count: 0, byTarget: new Map() };
      targetSlices.set(sliceStart, targetSlice);
    }
    targetSlice.count += 1;
    targetSlice.byTarget.set(targetKey, (targetSlice.byTarget.get(targetKey) ?? 0) + 1);

    if (record.elbStatus >= 400) {
      const key = `${record.elbStatus} ${record.routeKey}`;
      let entry = errors.get(key);
      if (!entry) {
        entry = {
          status: record.elbStatus, routeKey: record.routeKey, count: 0, noTarget: 0,
          firstMs: record.timeMs, lastMs: record.timeMs,
        };
        errors.set(key, entry);
      }
      entry.count += 1;
      if (record.targetProcessingSeconds === null) entry.noTarget += 1;
      entry.firstMs = Math.min(entry.firstMs, record.timeMs);
      entry.lastMs = Math.max(entry.lastMs, record.timeMs);
    }

    if (record.routeKey === UPLOAD_ROUTE_KEY && record.elbStatus < 400) {
      uploads.push(record.receivedBytes);
      let slice = uploadSlices.get(sliceStart);
      if (!slice) {
        slice = { startMs: sliceStart, count: 0, le25k: 0 };
        uploadSlices.set(sliceStart, slice);
      }
      slice.count += 1;
      if (record.receivedBytes <= UPLOAD_SIZE_BUCKET_BYTES[0]) slice.le25k += 1;
    }

    if (routeRegex.test(record.routeKey)) {
      matchedRouteKeys.add(record.routeKey);
      const minute = Math.floor(record.timeMs / 60000) * 60000;
      let bucket = series.get(minute);
      if (!bucket) {
        bucket = { minuteMs: minute, total: 0, statuses: {} };
        series.set(minute, bucket);
      }
      bucket.total += 1;
      bucket.statuses[record.elbStatus] = (bucket.statuses[record.elbStatus] ?? 0) + 1;
    }
  }

  const denominator = inWindow.length || 1;
  const routeList = [...routes.values()]
    .map((route) => ({
      routeKey: route.routeKey, method: route.method, route: route.route, count: route.count,
      share: route.count / denominator, statuses: route.statuses,
      targetMs: stats(route.durations), noTarget: route.noTarget,
    }))
    .sort((a, b) => b.count - a.count);
  // Any route that produced a 4xx or 5xx is shown even when --top would cut it.
  // 460 (client closed) is a 4xx and must force the row through too.
  const kept = new Set(routeList.slice(0, top).map((route) => route.routeKey));
  for (const route of routeList) {
    if (Object.keys(route.statuses).some((status) => Number(status) >= 400)) kept.add(route.routeKey);
  }

  const minutes = [];
  if (hasWindow) {
    for (let minute = Math.floor(fromMs / 60000) * 60000; minute < toMs; minute += 60000) {
      const bucket = series.get(minute);
      // A minute the delivered objects do not cover is unknown, not zero:
      // objects arrive about five minutes late, and a real zero-traffic gap
      // must stay distinguishable from undelivered data.
      //
      // The comparison is `>=`, not `>`, because an object's name stamp is the
      // END of its interval: the object stamped T carries rows in [T-5min, T),
      // so minute T is the FIRST minute with no delivered coverage. With `>`
      // that minute printed a confident 0 -- measured against the real logs,
      // 0 where the truth was 298 requests. Rows do spill up to about a second
      // past their stamp (240 of 156,730 on 2026-09-03), so `>=` hides at most
      // a sliver of a minute; reporting it as unknown beats reporting a near
      // empty bucket as complete.
      const undelivered = newestObjectMs !== null && minute >= newestObjectMs;
      minutes.push({
        minuteMs: minute, utc: formatUtc(minute), local: formatLocal(minute, timeZone),
        total: bucket ? bucket.total : (undelivered ? null : 0),
        statuses: bucket ? bucket.statuses : {},
        delivered: !undelivered,
      });
    }
  } else {
    for (const bucket of [...series.values()].sort((a, b) => a.minuteMs - b.minuteMs)) {
      minutes.push({
        minuteMs: bucket.minuteMs, utc: formatUtc(bucket.minuteMs),
        local: formatLocal(bucket.minuteMs, timeZone),
        total: bucket.total, statuses: bucket.statuses, delivered: true,
      });
    }
  }

  const sortedUploads = [...uploads].sort((a, b) => a - b);
  const bucketOf = (bytes) => (
    bytes <= UPLOAD_SIZE_BUCKET_BYTES[0] ? "le25k"
      : bytes <= UPLOAD_SIZE_BUCKET_BYTES[1] ? "mid" : "gt50k"
  );
  const uploadBuckets = {
    le25k: { count: 0, share: 0 }, mid: { count: 0, share: 0 }, gt50k: { count: 0, share: 0 },
  };
  for (const bytes of uploads) uploadBuckets[bucketOf(bytes)].count += 1;
  for (const key of Object.keys(uploadBuckets)) {
    uploadBuckets[key].share = uploads.length ? uploadBuckets[key].count / uploads.length : 0;
  }

  return {
    version: ALB_ACCESS_LOG_SUMMARY_VERSION,
    window: {
      fromMs: fromMs ?? null, toMs: toMs ?? null,
      fromUtc: fromMs ? formatUtc(fromMs) : null, toUtc: toMs ? formatUtc(toMs) : null,
      fromLocal: fromMs ? formatLocal(fromMs, timeZone) : null,
      toLocal: toMs ? formatLocal(toMs, timeZone) : null,
      timeZone,
    },
    filters: { targetIp, routePattern },
    totals: {
      rows: records.length, inWindow: inWindow.length, byStatusClass, clientClosed460,
      nonCloudFrontRows, wsRows, routeCount: routes.size, targetCount: targets.size,
    },
    routes: routeList.filter((route) => kept.has(route.routeKey)),
    targets: [...targets.values()].map((entry) => ({
      target: entry.target, count: entry.count, share: entry.count / denominator,
      targetMs: stats(entry.durations), status5xx: entry.status5xx, status460: entry.status460,
      statusClasses: entry.statusClasses,
    })).sort((a, b) => b.count - a.count),
    targetSlices: [...targetSlices.values()].sort((a, b) => a.startMs - b.startMs).map((slice) => ({
      startMs: slice.startMs, utc: formatUtc(slice.startMs), local: formatLocal(slice.startMs, timeZone),
      count: slice.count,
      targets: [...slice.byTarget.entries()]
        .map(([target, count]) => ({ target, count, share: count / slice.count }))
        .sort((a, b) => b.count - a.count),
    })),
    errors: [...errors.values()].map((entry) => ({
      status: entry.status, routeKey: entry.routeKey, count: entry.count, noTarget: entry.noTarget,
      firstUtc: formatUtc(entry.firstMs), lastUtc: formatUtc(entry.lastMs),
    })).sort((a, b) => b.count - a.count || a.status - b.status),
    routeSeries: { pattern: routePattern, matchedRouteKeys: [...matchedRouteKeys].sort(), minutes },
    uploads: {
      routeKey: UPLOAD_ROUTE_KEY, count: uploads.length, thresholds: [...UPLOAD_SIZE_BUCKET_BYTES],
      buckets: uploadBuckets,
      p50Bytes: percentile(sortedUploads, 50), p90Bytes: percentile(sortedUploads, 90),
      maxBytes: sortedUploads.length ? sortedUploads[sortedUploads.length - 1] : null,
      tenMinuteSlices: [...uploadSlices.values()].sort((a, b) => a.startMs - b.startMs).map((slice) => ({
        startMs: slice.startMs, utc: formatUtc(slice.startMs), local: formatLocal(slice.startMs, timeZone),
        count: slice.count, le25kShare: slice.count ? slice.le25k / slice.count : 0,
      })),
    },
  };
}

const pct = (share) => `${(share * 100).toFixed(1)}%`;
const msTriple = (entry) => (entry.samples
  ? `${Math.round(entry.avg)}/${Math.round(entry.p50)}/${Math.round(entry.max)}`
  : "-");

export function formatSummary(summary) {
  const lines = [];
  const w = summary.window;
  lines.push(`ALB access-log summary ${summary.version}`);
  lines.push(`Window  ${w.fromUtc ?? "(all)"} - ${w.toUtc ?? "(all)"}   (${w.fromLocal ?? "-"} - ${w.toLocal ?? "-"})   rows ${summary.totals.rows} read / ${summary.totals.inWindow} in window`);
  lines.push(`Target filter: ${summary.filters.targetIp ?? "(none)"}   Non-CloudFront rows: ${summary.totals.nonCloudFrontRows}   WebSocket rows: ${summary.totals.wsRows}`);
  lines.push("");
  const c = summary.totals.byStatusClass;
  lines.push(`TOTALS   1xx ${c["1xx"]}   2xx ${c["2xx"]}   3xx ${c["3xx"]}   4xx ${c["4xx"]} (460: ${summary.totals.clientClosed460})   5xx ${c["5xx"]}   routes ${summary.totals.routeCount}   targets ${summary.totals.targetCount}`);
  lines.push("");

  lines.push("ROUTES  (top by count; every route with a 4xx or 5xx is always shown)");
  const statusColumns = [...new Set(summary.routes.flatMap((route) => Object.keys(route.statuses)))]
    .map(Number).sort((a, b) => a - b);
  lines.push(`  count   share  ${"route".padEnd(44)}${statusColumns.map((s) => String(s).padStart(7)).join("")}   tgt ms avg/p50/max   no-tgt`);
  for (const route of summary.routes) {
    const label = route.routeKey.length > 44 ? `${route.routeKey.slice(0, 43)}…` : route.routeKey.padEnd(44);
    const cells = statusColumns.map((status) => String(route.statuses[status] ?? "").padStart(7)).join("");
    lines.push(`  ${String(route.count).padStart(5)}  ${pct(route.share).padStart(6)}  ${label}${cells}   ${msTriple(route.targetMs).padStart(18)}   ${String(route.noTarget).padStart(6)}`);
  }
  lines.push("");

  lines.push("TARGETS  (whole window)");
  for (const entry of summary.targets) {
    lines.push(`  ${entry.target.padEnd(22)} ${String(entry.count).padStart(6)}  ${pct(entry.share).padStart(6)}  tgt ms ${msTriple(entry.targetMs).padStart(18)}   5xx ${entry.status5xx}  460 ${entry.status460}`);
  }
  lines.push("");
  lines.push("TARGETS  (ten-minute slices; a whole-window average hides scale events)");
  for (const slice of summary.targetSlices) {
    const parts = slice.targets.map((entry) => `${entry.target} ${pct(entry.share)}`).join("  ");
    lines.push(`  ${slice.utc} ${slice.local.padEnd(11)} n=${String(slice.count).padStart(5)}  ${parts}`);
  }
  lines.push("");

  const series = summary.routeSeries;
  lines.push(`PER-MINUTE  route ~ /${series.pattern}/  matched: ${series.matchedRouteKeys.join(", ") || "(none)"}`);
  const seriesStatuses = [...new Set(series.minutes.flatMap((minute) => Object.keys(minute.statuses)))]
    .map(Number).sort((a, b) => a - b);
  lines.push(`  minute UTC   local        total${seriesStatuses.map((s) => String(s).padStart(7)).join("")}`);
  for (const minute of series.minutes) {
    const cells = seriesStatuses.map((status) => String(minute.statuses[status] ?? "").padStart(7)).join("");
    const total = minute.total === null ? "  n/a" : String(minute.total).padStart(5);
    lines.push(`  ${minute.utc.padEnd(12)} ${minute.local.padEnd(12)} ${total}${cells}`);
  }
  lines.push("");

  const uploads = summary.uploads;
  lines.push(`UPLOADS  ${uploads.routeKey}  (received_bytes includes ~4 KB of headers)`);
  if (uploads.count === 0) lines.push("  (no successful uploads in window)");
  else {
    lines.push(`  n=${uploads.count}   <=25 KiB ${pct(uploads.buckets.le25k.share)} (${uploads.buckets.le25k.count})   25-50 KiB ${pct(uploads.buckets.mid.share)} (${uploads.buckets.mid.count})   >50 KiB ${pct(uploads.buckets.gt50k.share)} (${uploads.buckets.gt50k.count})   p50 ${uploads.p50Bytes} B   p90 ${uploads.p90Bytes} B   max ${uploads.maxBytes} B`);
    for (const slice of uploads.tenMinuteSlices) {
      lines.push(`  ${slice.utc} ${slice.local.padEnd(11)} n=${String(slice.count).padStart(5)}   <=25 KiB ${pct(slice.le25kShare)}`);
    }
  }
  lines.push("");

  lines.push("4xx/5xx BY STATUS + ROUTE");
  if (summary.errors.length === 0) lines.push("  (none)");
  for (const entry of summary.errors) {
    lines.push(`  ${String(entry.count).padStart(5)}  ${String(entry.status).padStart(3)}  ${entry.routeKey.padEnd(46)} no-tgt ${String(entry.noTarget).padStart(5)}  ${entry.firstUtc}..${entry.lastUtc}`);
  }
  return lines.join("\n");
}

export function readLogFile(path) {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

export function collectLocalFiles(paths) {
  const files = [];
  for (const entry of paths) {
    const full = resolve(entry);
    if (!existsSync(full)) throw new Error(`No such file or directory: ${full}`);
    if (statSync(full).isDirectory()) {
      // Only real ALB objects, identified by their _yyyymmddTHHMMZ_ stamp. A
      // directory that also holds a concatenated scratch file (all.log) would
      // otherwise be counted twice and silently double every number.
      // Key on the object, not the path: a decompressed sibling (X.log next to
      // X.log.gz) is the same delivered object and counting both doubles every
      // number. Prefer the .gz, which is the object as S3 delivered it.
      const byObject = new Map();
      for (const name of readdirSync(full)) {
        if (!name.endsWith(".log.gz") && !name.endsWith(".log")) continue;
        if (!OBJECT_STAMP.test(name)) continue;
        const key = name.endsWith(".gz") ? name.slice(0, -3) : name;
        if (!byObject.has(key) || name.endsWith(".gz")) byObject.set(key, name);
      }
      for (const name of byObject.values()) files.push(join(full, name));
    } else files.push(full);
  }
  return [...new Set(files)].sort();
}

// A cached day holds every object for that day, so re-reading all of them for a
// thirty-minute question is slow. Keep objects whose stamp could carry a row in
// the window: the stamp is the interval end, and one object was seen flushed
// early, so allow a slot on each side. Files with no stamp are always kept.
export function narrowToWindow(files, window) {
  if (!window) return files;
  const low = Math.floor(window.fromMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const high = Math.floor(window.toMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS + FIVE_MINUTES_MS;
  return files.filter((path) => {
    const stampMs = objectStampMs(basename(path));
    return stampMs === null || (stampMs >= low && stampMs <= high);
  });
}

export function s3DayPrefixes({ fromMs, toMs, account = DEFAULT_ACCOUNT, region = DEFAULT_REGION }) {
  const prefixes = [];
  const start = Math.floor((fromMs - FIVE_MINUTES_MS) / 86400000) * 86400000;
  const end = toMs + FIVE_MINUTES_MS;
  for (let day = start; day <= end; day += 86400000) {
    const date = new Date(day);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const prefix = `alb/AWSLogs/${account}/elasticloadbalancing/${region}/${yyyy}/${mm}/${dd}/`;
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

export function selectLogObjects(lsOutput, { fromMs, toMs }) {
  const floor5 = (ms) => Math.floor(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const low = floor5(fromMs);
  const high = floor5(toMs) + FIVE_MINUTES_MS;
  const selected = [];
  for (const line of String(lsOutput).split("\n")) {
    const match = /^\S+\s+\S+\s+\d+\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const name = basename(match[1]);
    const stampMs = objectStampMs(name);
    if (stampMs === null) continue;
    // The stamp is the interval END and one object was seen flushed early, so
    // over-select by a slot on each side; rows are filtered by timestamp later.
    if (stampMs >= low && stampMs <= high) selected.push(name);
  }
  return selected.sort();
}

export function buildFetchPlan({ bucket, dayPrefix, basenames, cacheDir, cached = new Set() }) {
  const missing = basenames.filter((name) => !cached.has(name));
  const cp = [];
  for (let index = 0; index < missing.length; index += MAX_INCLUDES_PER_FETCH) {
    const chunk = missing.slice(index, index + MAX_INCLUDES_PER_FETCH);
    // "*" is passed as a bare argv string, never quoted: a quoted "'*'" would
    // match nothing and silently download the whole day prefix.
    const argv = ["s3", "cp", `s3://${bucket}/${dayPrefix}`, cacheDir, "--recursive", "--quiet", "--exclude", "*"];
    for (const name of chunk) argv.push("--include", name);
    cp.push(argv);
  }
  return {
    ls: ["s3", "ls", `s3://${bucket}/${dayPrefix}`],
    cp,
    files: basenames.map((name) => join(cacheDir, name)),
  };
}

export function defaultRunAws(argv) {
  const result = spawnSync("aws", argv, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run "aws": ${result.error.message}`);
  if (result.status !== 0) throw new Error(`aws ${argv.slice(0, 2).join(" ")} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

export function fetchWindowObjects(options, runAws = defaultRunAws) {
  const { fromMs, toMs, bucket, account, region, cacheDir } = options;
  const files = [];
  for (const dayPrefix of s3DayPrefixes({ fromMs, toMs, account, region })) {
    const day = dayPrefix.slice(-11, -1).replace(/\//g, "-");
    const dayCache = join(cacheDir, day);
    mkdirSync(dayCache, { recursive: true });
    const listing = runAws(["s3", "ls", `s3://${bucket}/${dayPrefix}`, "--region", region]);
    const basenames = selectLogObjects(listing, { fromMs, toMs });
    const cached = new Set(readdirSync(dayCache).filter((name) => statSync(join(dayCache, name)).size > 0));
    const plan = buildFetchPlan({ bucket, dayPrefix, basenames, cacheDir: dayCache, cached });
    if (plan.cp.length > 0) {
      const already = basenames.filter((name) => cached.has(name)).length;
      process.stderr.write(`fetching ${basenames.length - already} objects (${already} cached) into ${dayCache}\n`);
      for (const argv of plan.cp) runAws([...argv, "--region", region]);
    }
    files.push(...plan.files.filter((path) => existsSync(path)));
  }
  return files;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/load/alb-access-log-summary.mjs --from <t> [--to <t>] [--date YYYY-MM-DD]",
    "      [--route <regex>] [--target <ip>] [--top <n>] [--json]",
    "      [--cache-dir <dir>] [--bucket <name>] [--account <id>] [--region <r>]",
    "  node scripts/load/alb-access-log-summary.mjs --files <dir|file> [--files ...] [window flags]",
    "",
    "Times are UTC (HH:MM or full ISO). --date defaults to the current America/New_York date.",
    "Rows are selected by their own timestamp, never by the object name.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2), { nowMs = Date.now(), runAws = defaultRunAws } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        from: { type: "string" }, to: { type: "string" }, date: { type: "string" },
        route: { type: "string" }, target: { type: "string" }, top: { type: "string" },
        json: { type: "boolean" }, files: { type: "string", multiple: true },
        "cache-dir": { type: "string" }, bucket: { type: "string" },
        account: { type: "string" }, region: { type: "string" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  const values = parsed.values;
  const localMode = Array.isArray(values.files) && values.files.length > 0;

  // A zero or non-numeric --top would drop every clean route from the table
  // while still showing the 4xx/5xx ones, which reads like "nothing else ran".
  const top = values.top === undefined ? DEFAULT_TOP : Number(values.top);
  if (!Number.isInteger(top) || top < 1) {
    process.stderr.write(`--top must be a positive integer\n\n${usage()}\n`);
    return 2;
  }
  // In --files mode the window is optional, but half of one is always a typo.
  if (localMode && !values.from && (values.to || values.date)) {
    process.stderr.write(`--to and --date need --from\n\n${usage()}\n`);
    return 2;
  }

  let window = null;
  try {
    if (values.from || !localMode) {
      window = parseWindow({ from: values.from, to: values.to, date: values.date, nowMs });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (window && !localMode && window.toMs - window.fromMs > MAX_WINDOW_MS) {
    process.stderr.write("Refusing a window longer than 6 hours; narrow --from/--to.\n");
    return 2;
  }

  const cacheDir = values["cache-dir"] || join(tmpdir(), "schoolpilot-alb-access-logs");
  let files;
  try {
    files = localMode
      ? narrowToWindow(collectLocalFiles(values.files), window)
      : fetchWindowObjects({
        fromMs: window.fromMs, toMs: window.toMs,
        bucket: values.bucket || DEFAULT_BUCKET, account: values.account || DEFAULT_ACCOUNT,
        region: values.region || DEFAULT_REGION, cacheDir,
      }, runAws);
  } catch (error) {
    process.stderr.write(`${error.message}\nObjects arrive about five minutes late and expire after 90 days.\n`);
    return 3;
  }
  if (files.length === 0) {
    process.stderr.write("No log objects selected. Objects arrive about five minutes late and expire after 90 days.\n");
    return 3;
  }

  const records = [];
  let newestObjectMs = null;
  let unparsed = 0;
  let oddWidth = 0;
  for (const path of files) {
    const stampMs = objectStampMs(basename(path));
    if (stampMs !== null) newestObjectMs = newestObjectMs === null ? stampMs : Math.max(newestObjectMs, stampMs);
    let lines;
    try {
      lines = readLogFile(path);
    } catch (error) {
      // Name the file. A bare zlib stack trace says nothing about which cached
      // object is corrupt, and the fix is usually to delete that one file.
      process.stderr.write(`Unreadable log object ${path}: ${error.message}\n`);
      return 3;
    }
    for (const line of lines) {
      const record = parseAlbLine(line);
      if (record) records.push(record);
      else unparsed += 1;
      // Every row observed in production tokenizes to exactly 34 fields. A
      // different width means the format moved or a quote desynced the split,
      // which would shift fields silently -- say so rather than report numbers
      // derived from a shape this parser was never checked against.
      if (record && tokenizeAlbLine(line).length !== 34) oddWidth += 1;
    }
  }
  if (unparsed > 0) process.stderr.write(`skipped ${unparsed} unparseable lines\n`);
  if (oddWidth > 0) {
    process.stderr.write(`WARNING: ${oddWidth} rows did not tokenize to the expected 34 fields; treat the numbers below as suspect\n`);
  }

  let summary;
  try {
    summary = summarizeRecords(records, {
      fromMs: window ? window.fromMs : undefined,
      toMs: window ? window.toMs : undefined,
      routePattern: values.route || DEFAULT_ROUTE_PATTERN,
      targetIp: values.target || null,
      top,
      newestObjectMs,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  if (values.json) process.stdout.write(`${JSON.stringify({ ...summary, files }, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(summary)}\n`);
  // Operator note goes to stderr in BOTH modes; stdout stays clean for --json.
  if (!localMode) {
    process.stderr.write(`cache: ${cacheDir} (delete it after a monitoring day; logged URLs identify tenants)\n`);
  }
  if (summary.totals.inWindow === 0) process.stderr.write("Note: zero rows fell inside the window.\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
