import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  ALB_ACCESS_LOG_SUMMARY_VERSION,
  UPLOAD_SIZE_BUCKET_BYTES,
  tokenizeAlbLine,
  parseAlbLine,
  normalizeRoute,
  parseWindow,
  percentile,
  summarizeRecords,
  readLogFile,
  collectLocalFiles,
  s3DayPrefixes,
  selectLogObjects,
  buildFetchPlan,
  narrowToWindow,
} from "../scripts/load/alb-access-log-summary.mjs";


// The summarizer is plain ESM with no declaration file, so its results are
// untyped. These local shapes annotate the callbacks this test uses and keep
// the test-type debt at exactly the one unavoidable TS7016 for the import.
type RouteRow = {
  routeKey: string; count: number; statuses: Record<string, number>;
  targetMs: { samples: number; avg: number; p50: number; max: number }; noTarget: number;
};
type TargetRow = { target: string; count: number; status5xx: number; status460: number };
type MinuteRow = { utc: string; total: number | null; statuses: Record<string, number>; delivered: boolean };
type ErrorRow = { status: number; routeKey: string; count: number };

const scriptPath = fileURLToPath(new URL("../scripts/load/alb-access-log-summary.mjs", import.meta.url));

const TARGET_A = "10.1.100.65:4000";
const TARGET_B = "10.1.101.126:4000";
const ORIGIN = "https://api-origin.school-pilot.net:443";

// Emits the exact 34-token shape observed in production, including the quoted
// request, the quoted user agent, the trailing placeholders and the node IP.
function line(overrides: Record<string, string | number> = {}): string {
  const row: Record<string, string | number> = {
    type: "https",
    time: "2026-09-03T14:16:10.080824Z",
    target: TARGET_A,
    reqT: "0.000",
    tgtT: "0.140",
    respT: "0.000",
    elbStatus: 200,
    targetStatus: "200",
    received: 4029,
    sent: 3246,
    method: "POST",
    url: `${ORIGIN}/api/device/heartbeat`,
    userAgent: "Amazon CloudFront",
    created: "2026-09-03T14:16:09.940000Z",
    targetList: TARGET_A,
    targetStatusList: "200",
    ...overrides,
  };
  return [
    row.type,
    row.time,
    "app/schoolpilot-production-alb/e2efbc2325423b2e",
    "52.46.60.104:63580",
    row.target,
    row.reqT,
    row.tgtT,
    row.respT,
    row.elbStatus,
    row.targetStatus,
    row.received,
    row.sent,
    `"${row.method} ${row.url} HTTP/1.1"`,
    `"${row.userAgent}"`,
    "TLS_AES_128_GCM_SHA256",
    "TLSv1.3",
    "arn:aws:elasticloadbalancing:us-east-1:135775632425:targetgroup/schoolpilot-production-api-tg/abc123",
    '"Root=1-6a9981c0-67227fe768fc6b225b731099"',
    '"api-origin.school-pilot.net"',
    '"session-reused"',
    "0",
    row.created,
    '"forward"',
    '"-"',
    '"-"',
    `"${row.targetList}"`,
    `"${row.targetStatusList}"`,
    '"-"',
    '"-"',
    "TID_b80db02cd68fac4a8859c71f98cf6cc8",
    '"-"',
    '"-"',
    '"-"',
    "107.20.247.194",
  ].join(" ");
}

const HEARTBEAT = line();
const TILES_404 = line({ time: "2026-09-03T14:16:11.000000Z", url: `${ORIGIN}/api/classpilot/tiles/screenshots`, elbStatus: 404, targetStatus: "404", targetStatusList: "404" });
// 460 = the client closed the connection; the ALB never reached a target.
const HEARTBEAT_460 = line({ time: "2026-09-03T14:16:12.000000Z", target: "-", reqT: "-1", tgtT: "-1", respT: "-1", elbStatus: 460, targetStatus: "-", targetList: "-", targetStatusList: "-" });
const LEASE_502 = line({ time: "2026-09-03T14:16:13.000000Z", method: "GET", url: `${ORIGIN}/api/classpilot/teaching-sessions/3f2b9d6e-1c4a-4f0e-9b7a-2d5c8e1f0a11/observation-lease`, elbStatus: 502, targetStatus: "-", reqT: "0.001", tgtT: "0.523", respT: "-1", targetStatusList: "-" });
const UPLOAD_SMALL = line({ time: "2026-09-03T14:16:14.000000Z", url: `${ORIGIN}/api/classpilot/device/screenshot`, received: 14000, target: TARGET_B, targetList: TARGET_B });
const UPLOAD_LARGE = line({ time: "2026-09-03T14:16:15.000000Z", url: `${ORIGIN}/api/classpilot/device/screenshot`, received: 62000 });
const UPLOAD_MID = line({ time: "2026-09-03T14:16:16.000000Z", url: `${ORIGIN}/api/classpilot/device/screenshot`, received: 30000, elbStatus: 409, targetStatus: "409", targetStatusList: "409" });
const HEARTBEAT_LATER = line({ time: "2026-09-03T14:17:05.000000Z", tgtT: "0.220" });
const BEFORE_WINDOW = line({ time: "2026-09-03T14:14:59.999000Z" });
const AT_WINDOW_END = line({ time: "2026-09-03T14:45:00.000000Z" });
// /ws upgrades are reached by browsers directly, so they carry a real user agent.
const WS_UPGRADE = line({ type: "wss", time: "2026-09-03T14:16:20.000000Z", method: "GET", url: "https://school-pilot.net:443/ws", elbStatus: 101, targetStatus: "101", userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36", targetStatusList: "101" });
const NUMERIC_ID = line({ time: "2026-09-03T14:16:21.000000Z", method: "GET", url: `${ORIGIN}/api/groups/123456/subgroups?x=1` });
const AGGREGATED = line({ time: "2026-09-03T14:16:22.000000Z", method: "GET", url: `${ORIGIN}/api/students-aggregated` });

const ALL_LINES = [
  HEARTBEAT, TILES_404, HEARTBEAT_460, LEASE_502, UPLOAD_SMALL, UPLOAD_LARGE, UPLOAD_MID,
  HEARTBEAT_LATER, BEFORE_WINDOW, AT_WINDOW_END, WS_UPGRADE, NUMERIC_ID, AGGREGATED,
];

const WINDOW = {
  fromMs: Date.UTC(2026, 8, 3, 14, 15, 0),
  toMs: Date.UTC(2026, 8, 3, 14, 45, 0),
};

function records(lines: string[] = ALL_LINES) {
  return lines.map((raw) => parseAlbLine(raw)).filter((record) => record !== null);
}

describe("ALB access-log summary", () => {
  it("maps every field of a real CloudFront row", () => {
    const record = parseAlbLine(HEARTBEAT);
    assert.ok(record);
    assert.equal(tokenizeAlbLine(HEARTBEAT).length, 34);
    assert.equal(record.timeMs, Date.UTC(2026, 8, 3, 14, 16, 10, 80));
    assert.equal(record.target, TARGET_A);
    assert.equal(record.targetIp, "10.1.100.65");
    assert.equal(record.elbStatus, 200);
    assert.equal(record.targetStatus, 200);
    // received_bytes is t[10] (awk $11) -- the field the hand-run pipeline got wrong.
    assert.equal(record.receivedBytes, 4029);
    assert.equal(record.sentBytes, 3246);
    assert.equal(record.method, "POST");
    assert.equal(record.route, "/api/device/heartbeat");
    assert.equal(record.routeKey, "POST /api/device/heartbeat");
    assert.equal(record.userAgent, "Amazon CloudFront");
    assert.equal(record.targetProcessingSeconds, 0.14);
    assert.equal(record.requestCreationMs, Date.UTC(2026, 8, 3, 14, 16, 9, 940));
  });

  it("tokenizes a browser /ws row to the same 34 fields", () => {
    assert.equal(tokenizeAlbLine(WS_UPGRADE).length, 34);
    const record = parseAlbLine(WS_UPGRADE);
    assert.ok(record);
    assert.equal(record.type, "wss");
    assert.equal(record.route, "/ws");
    assert.match(record.userAgent, /^Mozilla\/5\.0/);
  });

  it("rejects malformed input and skips unparseable lines", () => {
    assert.equal(parseAlbLine(""), null);
    assert.equal(parseAlbLine("https 2026-09-03T14:16:10Z app x y"), null);
    assert.throws(() => parseAlbLine(42), TypeError);
    assert.throws(() => tokenizeAlbLine(null), TypeError);
    assert.throws(() => normalizeRoute(7), TypeError);
  });

  it("normalizes identifiers without eating hyphenated route names", () => {
    assert.equal(normalizeRoute(`${ORIGIN}/api/classpilot/teaching-sessions/3f2b9d6e-1c4a-4f0e-9b7a-2d5c8e1f0a11/observation-lease`), "/api/classpilot/teaching-sessions/:id/observation-lease");
    assert.equal(normalizeRoute(`${ORIGIN}/api/groups/123456/subgroups?x=1`), "/api/groups/:id/subgroups");
    assert.equal(normalizeRoute("https://school-pilot.net:443/ws"), "/ws");
    assert.equal(normalizeRoute(`${ORIGIN}/api/students-aggregated`), "/api/students-aggregated");
    assert.equal(normalizeRoute(`${ORIGIN}/api/extension/session-gate-presence`), "/api/extension/session-gate-presence");
    assert.equal(normalizeRoute(`${ORIGIN}/api/x/abcdef0123456789abcdef`), "/api/x/:id");
    assert.equal(normalizeRoute("-"), "-");
  });

  it("treats -1 timings as absence, not as a duration", () => {
    const record = parseAlbLine(HEARTBEAT_460);
    assert.ok(record);
    assert.equal(record.targetProcessingSeconds, null);
    assert.equal(record.requestProcessingSeconds, null);
    assert.equal(record.target, null);

    const summary = summarizeRecords(records(), { ...WINDOW });
    const heartbeat = summary.routes.find((route: RouteRow) => route.routeKey === "POST /api/device/heartbeat");
    assert.ok(heartbeat);
    assert.equal(heartbeat.targetMs.samples, 2);
    assert.equal(Math.round(heartbeat.targetMs.avg), 180);
    assert.equal(Math.round(heartbeat.targetMs.max), 220);
    assert.equal(heartbeat.noTarget, 1);
    assert.equal(summary.totals.clientClosed460, 1);
    const noTarget = summary.targets.find((entry: TargetRow) => entry.target === "-");
    assert.ok(noTarget);
    assert.equal(noTarget.status460, 1);
  });

  it("keeps a 5xx route visible even when --top would cut it", () => {
    const record = parseAlbLine(LEASE_502);
    assert.ok(record);
    assert.equal(record.targetStatus, null);
    assert.equal(record.responseProcessingSeconds, null);

    const summary = summarizeRecords(records(), { ...WINDOW, top: 1 });
    const key = "GET /api/classpilot/teaching-sessions/:id/observation-lease";
    assert.ok(summary.routes.some((route: RouteRow) => route.routeKey === key));
    const error = summary.errors.find((entry: ErrorRow) => entry.status === 502 && entry.routeKey === key);
    assert.ok(error);
    assert.equal(error.count, 1);
    // 460 is a 4xx and must force its route through the same way.
    assert.ok(summary.errors.some((entry: ErrorRow) => entry.status === 460));
  });

  it("buckets upload sizes on received_bytes", () => {
    const summary = summarizeRecords(records(), { ...WINDOW });
    const uploads = summary.uploads;
    // The 409 is not a successful upload and is excluded.
    assert.equal(uploads.count, 2);
    assert.deepEqual(uploads.thresholds, UPLOAD_SIZE_BUCKET_BYTES);
    assert.equal(uploads.buckets.le25k.count, 1);
    assert.equal(uploads.buckets.gt50k.count, 1);
    assert.equal(uploads.buckets.mid.count, 0);
    assert.equal(uploads.p50Bytes, 14000);
    assert.equal(uploads.maxBytes, 62000);
    const shares = uploads.buckets.le25k.share + uploads.buckets.mid.share + uploads.buckets.gt50k.share;
    assert.ok(Math.abs(shares - 1) < 1e-9);
  });

  it("aggregates per target and separates browser rows from CloudFront rows", () => {
    const summary = summarizeRecords(records(), { ...WINDOW });
    const a = summary.targets.find((entry: TargetRow) => entry.target === TARGET_A);
    const b = summary.targets.find((entry: TargetRow) => entry.target === TARGET_B);
    assert.ok(a && b);
    assert.equal(b.count, 1);
    assert.equal(a.status5xx, 1);
    // The /ws row carries a browser user agent by design; it must not trip the
    // CloudFront-only tripwire, which would otherwise read non-zero every day.
    assert.equal(summary.totals.nonCloudFrontRows, 0);
    assert.equal(summary.totals.wsRows, 1);
    assert.ok(summary.targetSlices.length >= 1);
  });

  it("selects rows by timestamp over a half-open window and fills every minute", () => {
    const summary = summarizeRecords(records(), { ...WINDOW });
    assert.equal(summary.totals.rows, 13);
    assert.equal(summary.totals.inWindow, 11);
    assert.equal(summary.routeSeries.minutes.length, 30);
    const first = summary.routeSeries.minutes[0];
    assert.equal(first.utc, "14:15Z");
    assert.equal(first.total, 0);
    const busy = summary.routeSeries.minutes.find((minute: MinuteRow) => minute.utc === "14:16Z");
    assert.ok(busy);
    assert.equal(busy.total, 2);
    assert.deepEqual(busy.statuses, { 200: 1, 460: 1 });
  });

  it("marks minutes newer than the newest delivered object as unknown, not zero", () => {
    const summary = summarizeRecords(records(), {
      ...WINDOW,
      newestObjectMs: Date.UTC(2026, 8, 3, 14, 20, 0),
    });
    const known = summary.routeSeries.minutes.find((minute: MinuteRow) => minute.utc === "14:19Z");
    const unknown = summary.routeSeries.minutes.find((minute: MinuteRow) => minute.utc === "14:30Z");
    assert.ok(known && unknown);
    assert.equal(known.total, 0);
    assert.equal(known.delivered, true);
    assert.equal(unknown.total, null);
    assert.equal(unknown.delivered, false);
  });

  it("matches a target on the full ip so a prefix cannot select a sibling", () => {
    const summary = summarizeRecords(records(), { ...WINDOW, targetIp: "10.1.101.126" });
    assert.equal(summary.totals.inWindow, 1);
    const narrow = summarizeRecords(records(), { ...WINDOW, targetIp: "10.1.100.6" });
    assert.equal(narrow.totals.inWindow, 0);
  });

  it("rejects a bad route pattern and a non-array input", () => {
    assert.throws(() => summarizeRecords(records(), { routePattern: "([" }), TypeError);
    assert.throws(() => summarizeRecords("nope"), TypeError);
    assert.equal(percentile([], 50), null);
    assert.throws(() => percentile(null, 50), TypeError);
  });

  it("resolves clock windows on the requested day and refuses an inverted window", () => {
    const nowMs = Date.UTC(2026, 8, 4, 2, 0, 0);
    const window = parseWindow({ from: "14:15", to: "14:45", date: "2026-09-03", nowMs });
    assert.equal(window.fromMs, WINDOW.fromMs);
    assert.equal(window.toMs, WINDOW.toMs);
    assert.throws(() => parseWindow({ from: "14:45", to: "14:15", date: "2026-09-03", nowMs }), TypeError);
    assert.throws(() => parseWindow({ from: "nonsense", date: "2026-09-03", nowMs }), TypeError);
    const iso = parseWindow({ from: "2026-09-03T14:15:00Z", to: "2026-09-03T14:45:00Z", nowMs });
    assert.equal(iso.fromMs, WINDOW.fromMs);
  });

  it("reads plain and gzipped objects identically and ignores scratch files", () => {
    const dir = mkdtempSync(join(tmpdir(), "schoolpilot-alb-summary-"));
    try {
      const stamped = "135775632425_elasticloadbalancing_us-east-1_app.schoolpilot-production-alb.e2efbc2325423b2e_20260903T1420Z_107.20.247.194_25k1j08j.log";
      writeFileSync(join(dir, stamped), `${ALL_LINES.join("\n")}\n`);
      writeFileSync(join(dir, `${stamped}.gz`), gzipSync(Buffer.from(`${ALL_LINES.join("\n")}\n`)));
      // A concatenated scratch file must never be counted: it would double every number.
      writeFileSync(join(dir, "all.log"), `${ALL_LINES.join("\n")}\n`);

      assert.deepEqual(readLogFile(join(dir, stamped)), readLogFile(join(dir, `${stamped}.gz`)));
      const collected = collectLocalFiles([dir]);
      assert.equal(collected.length, 2);
      assert.ok(collected.every((path: string) => !path.endsWith("all.log")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("narrows a cached day to the objects that can carry rows in the window", () => {
    const object = (clock: string) => `/cache/135775632425_elasticloadbalancing_us-east-1_app.schoolpilot-production-alb.e2efbc2325423b2e_20260903T${clock}Z_107.20.247.194_25k1j08j.log.gz`;
    const files = ["1400", "1410", "1415", "1430", "1445", "1450", "1500"].map(object);
    const kept = narrowToWindow(files, WINDOW).map((path: string) => /T(\d{4})Z_/.exec(path)?.[1]);
    // The stamp is the interval END, so the object stamped at the window start
    // is kept (rows can land a moment after its stamp) and so is one slot past
    // the end; objects that can only hold earlier or later rows are skipped.
    assert.deepEqual(kept, ["1415", "1430", "1445", "1450"]);
    // A file with no stamp is never silently dropped.
    assert.deepEqual(narrowToWindow(["/cache/manual-capture.log"], WINDOW), ["/cache/manual-capture.log"]);
    // Without a window nothing is filtered.
    assert.equal(narrowToWindow(files, null).length, files.length);
  });

  it("plans S3 prefixes, object selection and chunked fetches", () => {
    const prefixes = s3DayPrefixes({ fromMs: WINDOW.fromMs, toMs: WINDOW.toMs });
    assert.deepEqual(prefixes, ["alb/AWSLogs/135775632425/elasticloadbalancing/us-east-1/2026/09/03/"]);
    const midnight = s3DayPrefixes({
      fromMs: Date.UTC(2026, 8, 3, 23, 50, 0),
      toMs: Date.UTC(2026, 8, 4, 0, 20, 0),
    });
    assert.equal(midnight.length, 2);

    const name = (stamp: string) => `2026-09-03 14:00:00      12345 135775632425_elasticloadbalancing_us-east-1_app.schoolpilot-production-alb.e2efbc2325423b2e_202609${stamp}Z_107.20.247.194_25k1j08j.log.gz`;
    const listing = ["1405", "1410", "1415", "1420", "1425", "1430", "1435", "1440", "1445", "1455"]
      .map((clock) => name(`03T${clock}`)).join("\n");
    const selected = selectLogObjects(listing, WINDOW);
    const stamps = selected.map((basename: string) => /_(\d{8}T\d{4})Z_/.exec(basename)?.[1]);
    assert.deepEqual(stamps, ["20260903T1415", "20260903T1420", "20260903T1425", "20260903T1430", "20260903T1435", "20260903T1440", "20260903T1445"]);

    const plan = buildFetchPlan({
      bucket: "b", dayPrefix: "alb/p/", basenames: ["one.log.gz", "two.log.gz"],
      cacheDir: "/cache", cached: new Set(["one.log.gz"]),
    });
    assert.deepEqual(plan.cp, [[
      "s3", "cp", "s3://b/alb/p/", "/cache", "--recursive", "--quiet",
      // The exclude must be a bare "*": a quoted "'*'" would match nothing and
      // silently download the whole day prefix.
      "--exclude", "*", "--include", "two.log.gz",
    ]]);
    assert.equal(plan.files.length, 2);

    const fullyCached = buildFetchPlan({
      bucket: "b", dayPrefix: "alb/p/", basenames: ["one.log.gz"],
      cacheDir: "/cache", cached: new Set(["one.log.gz"]),
    });
    assert.deepEqual(fullyCached.cp, []);
  });

  it("chunks large fetch plans so no argv approaches the Windows limit", () => {
    const basenames = Array.from({ length: 230 }, (_unused, index) => (
      `135775632425_elasticloadbalancing_us-east-1_app.schoolpilot-production-alb.e2efbc2325423b2e_20260903T14${String(index).padStart(2, "0")}Z_107.20.247.194_25k1j0${index}.log.gz`
    ));
    const plan = buildFetchPlan({ bucket: "b", dayPrefix: "alb/p/", basenames, cacheDir: "/cache" });
    assert.ok(plan.cp.length >= 2);
    for (const argv of plan.cp) {
      assert.ok(argv.join(" ").length < 30000, "every aws argv must stay well under the command-line limit");
      assert.ok(argv.filter((token: string) => token === "--include").length <= 150);
    }
    const included = plan.cp.flatMap((argv: string[]) => argv.filter((token: string) => token.endsWith(".log.gz")));
    assert.equal(included.length, basenames.length);
  });

  it("runs end to end over local files and refuses a bogus flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "schoolpilot-alb-summary-cli-"));
    try {
      const stamped = join(dir, "135775632425_elasticloadbalancing_us-east-1_app.schoolpilot-production-alb.e2efbc2325423b2e_20260903T1420Z_107.20.247.194_25k1j08j.log.gz");
      writeFileSync(stamped, gzipSync(Buffer.from(`${ALL_LINES.join("\n")}\n`)));

      const jsonRun = spawnSync(process.execPath, [
        scriptPath, "--files", dir, "--from", "14:15", "--to", "14:45", "--date", "2026-09-03", "--json",
      ], { encoding: "utf8" });
      assert.equal(jsonRun.status, 0, jsonRun.stderr);
      const parsed = JSON.parse(jsonRun.stdout);
      assert.equal(parsed.version, ALB_ACCESS_LOG_SUMMARY_VERSION);
      assert.equal(parsed.totals.rows, 13);
      assert.equal(parsed.totals.inWindow, 11);

      const textRun = spawnSync(process.execPath, [
        scriptPath, "--files", dir, "--from", "14:15", "--to", "14:45", "--date", "2026-09-03",
      ], { encoding: "utf8" });
      assert.equal(textRun.status, 0, textRun.stderr);
      for (const section of ["TOTALS", "ROUTES", "TARGETS", "PER-MINUTE", "UPLOADS", "4xx/5xx BY STATUS + ROUTE"]) {
        assert.ok(textRun.stdout.includes(section), `missing section ${section}`);
      }
      assert.match(textRun.stdout, /14:15Z/);
      assert.match(textRun.stdout, /10:15 EDT/);

      const bogus = spawnSync(process.execPath, [scriptPath, "--files", dir, "--nonsense"], { encoding: "utf8" });
      assert.equal(bogus.status, 2);
      assert.match(bogus.stderr, /Usage:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
