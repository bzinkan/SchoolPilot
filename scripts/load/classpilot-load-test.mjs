#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import WebSocket from "ws";

const JPEG_1X1 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISP/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z";

function usage() {
  console.log(`
ClassPilot load test

Required:
  LOAD_BASE_URL=https://staging.school-pilot.net
  LOAD_DEVICE_MANIFEST=./load-devices.json

Device manifest format:
  [
    { "deviceId": "device-1", "studentToken": "jwt" },
    { "deviceId": "device-2", "studentToken": "jwt" }
  ]

Optional:
  LOAD_DEVICE_COUNT=500
  LOAD_DURATION_SECONDS=300
  LOAD_HEARTBEAT_INTERVAL_MS=10000
  LOAD_SCREENSHOT_INTERVAL_MS=30000
  LOAD_TEACHER_TOKEN=<jwt>
  LOAD_TEACHER_PATHS=/api/classpilot/students-aggregated,/api/classpilot/coverage/overview
  LOAD_TEACHER_INTERVAL_MS=5000
  LOAD_COMMAND_ENDPOINT=/api/classpilot/commands
  LOAD_COMMAND_BODY='{"teachingSessionId":"...","targetScope":"class","commandType":"focus","commandPayload":{}}'
  LOAD_COMMAND_INTERVAL_MS=30000
  LOAD_ENFORCE_THRESHOLDS=true
`);
}

if (process.argv.includes("--help")) {
  usage();
  process.exit(0);
}

const baseUrl = (process.env.LOAD_BASE_URL || "").replace(/\/$/, "");
const manifestPath = process.env.LOAD_DEVICE_MANIFEST;
if (!baseUrl || !manifestPath) {
  usage();
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest) || manifest.length === 0) {
  throw new Error("LOAD_DEVICE_MANIFEST must contain a non-empty JSON array");
}

const durationMs = Number.parseInt(process.env.LOAD_DURATION_SECONDS || "300", 10) * 1000;
const heartbeatIntervalMs = Number.parseInt(process.env.LOAD_HEARTBEAT_INTERVAL_MS || "10000", 10);
const screenshotIntervalMs = Number.parseInt(process.env.LOAD_SCREENSHOT_INTERVAL_MS || "30000", 10);
const teacherIntervalMs = Number.parseInt(process.env.LOAD_TEACHER_INTERVAL_MS || "5000", 10);
const commandIntervalMs = Number.parseInt(process.env.LOAD_COMMAND_INTERVAL_MS || "30000", 10);
const deviceCount = Math.min(
  Number.parseInt(process.env.LOAD_DEVICE_COUNT || String(manifest.length), 10),
  manifest.length
);
const devices = manifest.slice(0, deviceCount);
const teacherToken = process.env.LOAD_TEACHER_TOKEN || "";
const teacherPaths = (process.env.LOAD_TEACHER_PATHS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const commandEndpoint = process.env.LOAD_COMMAND_ENDPOINT || "";
const commandBody = process.env.LOAD_COMMAND_BODY ? JSON.parse(process.env.LOAD_COMMAND_BODY) : null;
const enforceThresholds = process.env.LOAD_ENFORCE_THRESHOLDS === "true";

const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws`;
const timers = new Set();
const sockets = new Set();
const samples = [];
const counters = {
  heartbeat: 0,
  screenshot: 0,
  teacher: 0,
  command: 0,
  http5xx: 0,
  http4xx: 0,
  httpErrors: 0,
  wsConnected: 0,
  wsClosed: 0,
  wsErrors: 0,
};

function addTimer(timer) {
  timers.add(timer);
  return timer;
}

function observe(kind, startedAt, status, error) {
  const latencyMs = Date.now() - startedAt;
  samples.push({ kind, latencyMs, status, error: error ? String(error.message || error) : "" });
  if (status >= 500) counters.http5xx += 1;
  if (status >= 400 && status < 500) counters.http4xx += 1;
  if (error) counters.httpErrors += 1;
}

async function postJson(path, token, body, kind) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    observe(kind, startedAt, res.status);
    return res;
  } catch (error) {
    observe(kind, startedAt, 0, error);
    return null;
  }
}

async function getJson(path, token, kind) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    observe(kind, startedAt, res.status);
    return res;
  } catch (error) {
    observe(kind, startedAt, 0, error);
    return null;
  }
}

function connectDevice(device) {
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
  sockets.add(socket);
  socket.on("open", () => {
    counters.wsConnected += 1;
    socket.send(JSON.stringify({
      type: "auth",
      role: "student",
      deviceId: device.deviceId,
      studentToken: device.studentToken,
    }));
  });
  socket.on("error", () => {
    counters.wsErrors += 1;
  });
  socket.on("close", () => {
    counters.wsClosed += 1;
    sockets.delete(socket);
  });
}

function heartbeatBody(device) {
  const domain = ["example.edu", "docs.google.com", "school-pilot.net"][Math.floor(Math.random() * 3)];
  return {
    activeTabUrl: `https://${domain}/load/${encodeURIComponent(device.deviceId)}`,
    activeTabTitle: `Load ${domain}`,
    visibilityState: "visible",
    screenLocked: false,
    allOpenTabs: [],
    isScreenRecording: false,
    isScreenSharing: false,
    cameraActive: false,
    status: "active",
    extensionVersion: "load-test",
    chromeVersion: "load-test",
    screenshotHealth: {
      lastSuccessAt: new Date().toISOString(),
      attempts: 1,
      successes: 1,
      alarmActive: true,
    },
  };
}

function screenshotBody(device) {
  return {
    screenshot: `data:image/jpeg;base64,${JPEG_1X1}`,
    tabTitle: `Load ${device.deviceId}`,
    tabUrl: `https://example.edu/load/${encodeURIComponent(device.deviceId)}`,
  };
}

function startDevice(device, index) {
  const heartbeatJitter = Math.floor((index / devices.length) * heartbeatIntervalMs);
  const screenshotJitter = Math.floor((index / devices.length) * screenshotIntervalMs);

  addTimer(setTimeout(() => {
    void postJson("/api/classpilot/device/heartbeat", device.studentToken, heartbeatBody(device), "heartbeat")
      .then(() => { counters.heartbeat += 1; });
    addTimer(setInterval(() => {
      void postJson("/api/classpilot/device/heartbeat", device.studentToken, heartbeatBody(device), "heartbeat")
        .then(() => { counters.heartbeat += 1; });
    }, heartbeatIntervalMs));
  }, heartbeatJitter));

  addTimer(setTimeout(() => {
    void postJson("/api/classpilot/device/screenshot", device.studentToken, screenshotBody(device), "screenshot")
      .then(() => { counters.screenshot += 1; });
    addTimer(setInterval(() => {
      void postJson("/api/classpilot/device/screenshot", device.studentToken, screenshotBody(device), "screenshot")
        .then(() => { counters.screenshot += 1; });
    }, screenshotIntervalMs));
  }, screenshotJitter));

  addTimer(setTimeout(() => connectDevice(device), Math.min(heartbeatJitter, 10_000)));
}

function startTeacherTraffic() {
  if (!teacherToken || teacherPaths.length === 0) return;
  addTimer(setInterval(() => {
    for (const path of teacherPaths) {
      void getJson(path, teacherToken, "teacher").then(() => { counters.teacher += 1; });
    }
  }, teacherIntervalMs));
}

function startCommandTraffic() {
  if (!teacherToken || !commandEndpoint || !commandBody) return;
  addTimer(setInterval(() => {
    void postJson(commandEndpoint, teacherToken, commandBody, "command").then(() => { counters.command += 1; });
  }, commandIntervalMs));
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function summarize() {
  const byKind = new Map();
  for (const sample of samples) {
    if (!byKind.has(sample.kind)) byKind.set(sample.kind, []);
    byKind.get(sample.kind).push(sample);
  }

  const totalHttp = samples.length;
  const fiveXxRate = totalHttp === 0 ? 0 : counters.http5xx / totalHttp;
  const summary = {
    baseUrl,
    devices: devices.length,
    durationSeconds: Math.round(durationMs / 1000),
    counters,
    http5xxRate: Number((fiveXxRate * 100).toFixed(3)),
    kinds: Object.fromEntries([...byKind.entries()].map(([kind, kindSamples]) => [
      kind,
      {
        count: kindSamples.length,
        p50: percentile(kindSamples.map((s) => s.latencyMs), 50),
        p95: percentile(kindSamples.map((s) => s.latencyMs), 95),
        p99: percentile(kindSamples.map((s) => s.latencyMs), 99),
        errors: kindSamples.filter((s) => s.error || s.status >= 400).length,
      },
    ])),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (enforceThresholds) {
    const heartbeatP95 = summary.kinds.heartbeat?.p95 ?? Infinity;
    if (heartbeatP95 > 500 || fiveXxRate > 0.001 || counters.httpErrors > 0) {
      process.exitCode = 1;
    }
  }
}

console.log(`Starting ClassPilot load test: ${devices.length} devices for ${Math.round(durationMs / 1000)}s`);
devices.forEach(startDevice);
startTeacherTraffic();
startCommandTraffic();

addTimer(setTimeout(() => {
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.close();
  summarize();
}, durationMs));
