import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOT_PATH_EMF_COUNTERS } from "../src/services/heartbeatHotPathMetrics.ts";

const read = (path: string) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  "utf8"
);

const ALARM_RESOURCES = [
  "classpilot_screenshot_store_unavailable",
  "classpilot_screenshot_broadcast_failures",
  "classpilot_device_rate_limited",
  "classpilot_heartbeat_gap_ratio",
];

function alarmBlock(source: string, name: string): string {
  const header = `resource "aws_cloudwatch_metric_alarm" "${name}" {`;
  const start = source.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = source.indexOf("\nresource ", start + header.length);
  return end >= 0 ? source.slice(start, end) : source.slice(start);
}

function metricNames(block: string): string[] {
  return [...block.matchAll(/metric_name\s+=\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("ClassPilot hot-path CloudWatch alarms", () => {
  const alarms = read("infra/alarms.tf");
  const emittedMetrics = new Set(HOT_PATH_EMF_COUNTERS.map(([, metric]) => metric));

  it("declares the four hot-path alarms on the EMF namespace with shared wiring", () => {
    for (const name of ALARM_RESOURCES) {
      const block = alarmBlock(alarms, name);
      assert.match(block, /namespace\s+=\s+"SchoolPilot\/ClassPilot"/, name);
      assert.doesNotMatch(block, /namespace\s+=\s+"(?!SchoolPilot\/ClassPilot")/, name);
      assert.match(block, /treat_missing_data\s+=\s+"notBreaching"/, name);
      assert.match(block, /alarm_actions\s+=\s+local\.alarm_actions/, name);
      assert.match(block, /ok_actions\s+=\s+local\.alarm_ok_actions/, name);
      assert.match(block, /alarm_name\s+=\s+"\$\{local\.alarm_prefix\}-classpilot-/, name);
      assert.match(block, /Environment\s+=\s+var\.environment/, name);
      assert.match(block, /Service\s+=\s+"api"/, name);
      assert.doesNotMatch(block, /provider\s+=/, name);
      assert.doesNotMatch(block, /\b(school|device|student)[A-Za-z]*\s+=/i, name);
      const names = metricNames(block);
      assert.ok(names.length >= 1, name);
      for (const metric of names) {
        assert.ok(emittedMetrics.has(metric), `${name} references unemitted metric ${metric}`);
      }
    }
  });

  it("alarms on any screenshot-store unavailability within two of three minutes", () => {
    const block = alarmBlock(alarms, "classpilot_screenshot_store_unavailable");
    assert.deepEqual(metricNames(block), ["TileBatchScreenshotStoreUnavailable"]);
    assert.match(block, /comparison_operator\s+=\s+"GreaterThanThreshold"/);
    assert.match(block, /threshold\s+=\s+0\b/);
    assert.match(block, /evaluation_periods\s+=\s+3\b/);
    assert.match(block, /datapoints_to_alarm\s+=\s+2\b/);
    assert.match(block, /period\s+=\s+60\b/);
    assert.match(block, /statistic\s+=\s+"Sum"/);
  });

  it("alarms on elevated screenshot-available broadcast failures", () => {
    const block = alarmBlock(alarms, "classpilot_screenshot_broadcast_failures");
    assert.deepEqual(metricNames(block), ["ScreenshotAvailableBroadcastFailures"]);
    assert.match(block, /comparison_operator\s+=\s+"GreaterThanThreshold"/);
    assert.match(block, /threshold\s+=\s+10\b/);
    assert.match(block, /evaluation_periods\s+=\s+3\b/);
    assert.match(block, /datapoints_to_alarm\s+=\s+2\b/);
    assert.match(block, /period\s+=\s+60\b/);
    assert.match(block, /statistic\s+=\s+"Sum"/);
  });

  it("sums heartbeat and screenshot device rate limiting with metric math", () => {
    const block = alarmBlock(alarms, "classpilot_device_rate_limited");
    assert.deepEqual(metricNames(block), [
      "DeviceHeartbeatRateLimited",
      "DeviceScreenshotRateLimited",
    ]);
    assert.match(block, /id\s+=\s+"limited"[\s\S]*?expression\s+=\s+"heartbeat \+ screenshot"[\s\S]*?return_data\s+=\s+true/);
    assert.match(block, /id\s+=\s+"heartbeat"\s+return_data\s+=\s+false/);
    assert.match(block, /id\s+=\s+"screenshot"\s+return_data\s+=\s+false/);
    assert.match(block, /threshold\s+=\s+50\b/);
    assert.match(block, /evaluation_periods\s+=\s+5\b/);
    assert.match(block, /datapoints_to_alarm\s+=\s+3\b/);
    assert.equal((block.match(/period\s+=\s+60\b/g) ?? []).length, 2);
    assert.equal((block.match(/stat\s+=\s+"Sum"/g) ?? []).length, 2);
  });

  it("alarms on the over-60-second heartbeat gap ratio only with a meaningful base", () => {
    const block = alarmBlock(alarms, "classpilot_heartbeat_gap_ratio");
    assert.deepEqual(metricNames(block), [
      "HeartbeatGapOver60Seconds",
      "HeartbeatRecorded",
    ]);
    assert.match(block, /expression\s+=\s+"IF\(recorded >= 100, gap60 \/ recorded, 0\)"/);
    assert.match(block, /id\s+=\s+"gap60"\s+return_data\s+=\s+false/);
    assert.match(block, /id\s+=\s+"recorded"\s+return_data\s+=\s+false/);
    assert.match(block, /threshold\s+=\s+0\.25\b/);
    assert.match(block, /evaluation_periods\s+=\s+3\b/);
    assert.match(block, /datapoints_to_alarm\s+=\s+2\b/);
    assert.equal((block.match(/period\s+=\s+300\b/g) ?? []).length, 2);
    assert.equal((block.match(/stat\s+=\s+"Sum"/g) ?? []).length, 2);
  });

  it("counts device heartbeat and screenshot rate limiting from the limiter handlers", () => {
    const devices = read("src/routes/classpilot/devices.ts");
    const limiter = (name: string) => {
      const start = devices.indexOf(`const ${name} = rateLimit({`);
      assert.ok(start >= 0, name);
      return devices.slice(start, devices.indexOf("});", start));
    };

    assert.match(
      limiter("deviceHeartbeatLimiter"),
      /handler: \(_req, res, _next, options\) => \{\s*recordHeartbeatHotPathCounter\("deviceHeartbeatRateLimited"\);\s*res\.status\(options\.statusCode\)\.send\(options\.message\);/
    );
    assert.match(
      limiter("deviceScreenshotLimiter"),
      /handler: \(_req, res, _next, options\) => \{\s*recordHeartbeatHotPathCounter\("deviceScreenshotRateLimited"\);\s*res\.status\(options\.statusCode\)\.send\(options\.message\);/
    );
    assert.ok(emittedMetrics.has("DeviceHeartbeatRateLimited"));
    assert.ok(emittedMetrics.has("DeviceScreenshotRateLimited"));
  });
});
