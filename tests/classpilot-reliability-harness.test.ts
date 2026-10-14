import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createHash } from "node:crypto";
import { readReliabilityFrame } from "../scripts/load/reliability-rendered-frame.mjs";
import { CAPTURE_COLOR_BASES } from "../scripts/load/classpilot-reliability-profile.mjs";
const captureBases=CAPTURE_COLOR_BASES.map(value=>Buffer.from(value.base64,"base64"));
const captureBaseBytes=captureBases[0]!.length;
assert.ok(captureBases.every(base=>base.length===captureBaseBytes));

const runner = fileURLToPath(new URL("../scripts/load/run-classpilot-reliability.mjs", import.meta.url));
const baseUrl = "http://127.0.0.1:9"; // No server: a dry run must never attempt traffic.

for (const primary of [40, 500, 800]) test(`reliability ${primary}-device dry run validates the complete new workload without traffic or credential output`, () => {
  const root = mkdtempSync(join(tmpdir(), "classpilot-reliability-fixture-"));
  try {
    const classrooms = primary === 40 ? 1 : 20;
    const studentsPerClass = primary / classrooms;
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 48 * 3600 })).toString("base64url")}.fixture-signature`;
    const manifest: { deviceId: string; studentId: string; schoolId: string; classId: string | null; studentToken: string }[] =
      Array.from({ length: 10 }, (_, i) => ({ deviceId: `canary-device-${i}`, studentId: `canary-student-${i}`, schoolId: "foreign", classId: null, studentToken: jwt }));
    const teacherAuth = [];
    const commands = [];
    for (let classroom = 0; classroom < classrooms; classroom++) {
      const studentIds = Array.from({ length: studentsPerClass }, (_, i) => `student-${classroom}-${i}`);
      const teachingSessionId = `session-${classroom}`;
      teacherAuth.push({ teacherId: `teacher-${classroom}`, schoolId: "primary", role: "teacher", teachingSessionId,
        teacherCookie: `schoolpilot.sid=private-fixture-cookie-${classroom}`, csrfToken: `private-fixture-csrf-${classroom}`,
        teacherToken: jwt, expiresAt, studentIds });
      commands.push({ teachingSessionId, targetScope: "class", commandType: "open-tab", commandPayload: { url: "https://example.edu" } });
      for (const studentId of studentIds) manifest.push({ deviceId: `device-${studentId}`, studentId, schoolId: "primary", classId: `class-${classroom}`, studentToken: jwt });
    }
    const manifestPath = join(root, "devices.private.json"), authPath = join(root, "teachers.private.json"), commandsPath = join(root, "commands.private.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(commandsPath, JSON.stringify(commands));
    writeFileSync(authPath, JSON.stringify({ schemaVersion: 2, baseUrl, schoolId: "primary", expiresAt, deviceManifestExpiresAt: expiresAt, teacherAuth }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("LOAD_")) delete env[key];
    const result = spawnSync(process.execPath, [runner, "--devices", String(primary), "--dry-run"], {
      encoding: "utf8", timeout: 15_000,
      env: { ...env, NODE_ENV: "test", LOAD_BASE_URL: baseUrl, LOAD_TEST_ARTIFACT_ROOT: root,
        LOAD_DEVICE_MANIFEST: manifestPath, LOAD_TEACHER_AUTH_FILE: authPath, LOAD_COMMAND_BODIES_FILE: commandsPath,
        LOAD_RUN_ID: `reliability-private-${primary}`, LOAD_EXTERNAL_PROGRESS_PATH: join(root, "progress.jsonl"), LOAD_EXTERNAL_SUMMARY_PATH: join(root, "summary.json") },
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.reliabilityWorkload.primaryDevices, primary);
    assert.equal(config.reliabilityWorkload.productionAccepted, false);
    assert.equal(config.reliabilityWorkload.managedDevicesValidated, false);
    assert.equal(config.gateProfile, "partial");
    assert.equal(config.certificationEligible, false);
    assert.equal(config.workloadSchemaVersion, "classpilot-reliability-v3");
    assert.equal(config.screenshotFixture.reliabilityPayload.fixtureCount, primary + 10);
    assert.equal(config.screenshotFixture.reliabilityPayload.distinctFixtures, primary + 10);
    assert.equal(config.screenshotFixture.reliabilityPayload.decodedCacheBytes, (primary + 10) * 3 * 40960);
    assert.equal(config.screenshotFixture.reliabilityPayload.captureEncoding.captures, 0);
    assert.ok(config.screenshotFixture.reliabilityPayload.cohort.gzipBytes >= 40 * 40960 * 0.95);
    assert.ok(config.screenshotFixture.reliabilityPayload.cohort.brotliBytes >= 40 * 40960 * 0.95);
    assert.equal(config.launchContract.teacherTileAssignments, primary);
    assert.equal(config.launchContract.teacherTileCohorts, classrooms);
    assert.doesNotMatch(result.stdout, /private-fixture-cookie|private-fixture-csrf|fixture-signature/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const defect of ["none", "binding", "foreign-tile", "subscription-rejected", "subscription-silent", "subscription-late",
  "subscription-stale", "subscription-foreign-session", "subscription-foreign-school",
  "subscription-foreign-context", "subscription-closed", "auth-role", "auth-rejected", "auth-silent"] as const) test(`reliability HTTP/WS workload enforces exact authority and cleanup: ${defect}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "classpilot-reliability-wire-"));
  const studentIds = Array.from({ length: 40 }, (_, i) => `student-${i}`);
  const devices = new Map<string, WebSocket>();
  const teachers = new Set<WebSocket>();
  const commands = new Map<string, Map<string, string>>();
  const captureTimes = new Map<string, string>();
  const capturePayloads = new Map<string, string>();
  const policy = { captureAllowed: true, captureCadence: { intervalSeconds: 5 },
    authority: { kind: "teaching_session", teachingSessionId: "session", revision: 1 } };
  let leases = 0, releases = 0, probes = 0, screenshots = 0, histories = 0, sequence = 0;
  const negativeTileProbes = new Set<string>();
  const fixtureTimers = new Set<ReturnType<typeof setTimeout>>();
  let lateAckSent = false;
  const fixtureLater = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { fixtureTimers.delete(timer); callback(); }, delay);
    fixtureTimers.add(timer);
  };
  let fixtureError: unknown;
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    const path = request.url || "";
    if (path.includes("canary-device")) return send(404, { error: "Not found" });
    if (path.endsWith("/observation-lease")) {
      assert.equal(request.headers["x-school-id"], "primary");
      assert.ok(parsed.viewerInstanceId);
      if (request.method === "PUT") { leases++; assert.deepEqual(parsed.scope, { kind: "class" }); }
      else { assert.equal(request.method, "DELETE"); releases++; }
      if (request.method === "DELETE" && defect === "subscription-late") {
        // Preserve the socket during compensating cleanup so a real matching
        // ACK can arrive after its deadline and must remain fenced out.
        fixtureLater(() => send(200, { ok: true }), 1000); return;
      }
      return send(200, { ok: true });
    }
    if (path === "/api/classpilot/device/heartbeat") return send(200, { screenshotPolicy: policy });
    if (path === "/api/classpilot/device/screenshot") {
      assert.ok(leases > 0);
      assert.deepEqual(parsed.screenshotAuthority, policy.authority);
      assert.ok(Number.isFinite(Date.parse(parsed.capturedAt)));
      // Ingest identity comes from device authentication, not a body deviceId.
      const device = String(parsed.tabTitle).replace(/^Load /, ""), bytes = Buffer.from(parsed.screenshot.slice('data:image/jpeg;base64,'.length), 'base64');
      assert.equal(bytes.length, 40960);
      assert.equal(readReliabilityFrame(parsed.screenshot)?.capturedAt, Date.parse(parsed.capturedAt));
      assert.ok(captureBases.some(base=>bytes.subarray(0,captureBaseBytes-2).equals(base.subarray(0,-2))), 'Every changing color keeps one exact legal codec base');
      assert.deepEqual([...bytes.subarray(captureBaseBytes-2,captureBaseBytes)],[255,254],'Entropy remains inside the same legal COM segment');
      const payloadHash = createHash('sha256').update(bytes.subarray(captureBaseBytes+2, -98)).digest('hex');
      if (capturePayloads.has(device)) assert.equal(capturePayloads.get(device), payloadHash, 'A device reuses its immutable entropy cache');
      capturePayloads.set(device, payloadHash);
      captureTimes.set(device, parsed.capturedAt);
      return send(200, { ok: true });
    }
    if (path.startsWith("/api/students-aggregated")) {
      assert.equal(new URL(path, "http://localhost").searchParams.get("teachingSessionId"), "session");
      return send(200, studentIds.map(studentId => ({ studentId })));
    }
    if (path.startsWith("/api/classpilot/tiles/")) {
      assert.equal(parsed.teachingSessionId, "session");
      assert.equal(parsed.deviceId, undefined);
      assert.equal(request.headers["x-csrf-token"], "private-csrf");
      if (parsed.studentIds.some((id: string) => id.startsWith("canary-student-"))) {
        assert.equal(parsed.studentIds.length, 1);
        negativeTileProbes.add(`${path}:${parsed.studentIds[0]}`);
        return send(defect === "foreign-tile" ? 200 : 404, { tiles: [] });
      }
      assert.deepEqual([...parsed.studentIds].sort(), [...studentIds].sort());
      if (path.endsWith("/history")) {
        histories++;
        return send(200, { tiles: studentIds.map(studentId => ({ studentId, heartbeats: [{ timestamp: Date.now() }] })) });
      }
      screenshots++;
      return send(200, { tiles: studentIds.map(studentId => ({ studentId, bindingVersion: "v2:current", screenshot: {
        bindingVersion: defect === "binding" ? "v2:retired" : "v2:current",
        screenshot: "data:image/jpeg;base64,/9j/2Q==", capturedAt: captureTimes.get(`device-${studentId}`),
      } })) });
    }
    if (path === "/api/classpilot/commands") {
      assert.equal(parsed.teachingSessionId, "session");
      assert.equal(parsed.targetScope, "class");
      const id = `command-${++sequence}`;
      commands.set(id, new Map(studentIds.map(studentId => [`device-${studentId}`, "sent"])));
      send(200, { command: { id }, summary: { sent: 40 } });
      setImmediate(() => { for (const studentId of studentIds) {
        devices.get(`device-${studentId}`)?.send(JSON.stringify({ type: "remote-control", commandId: id }));
      } });
      return;
    }
    send(404, { error: "Unexpected workload endpoint" });
    } catch (error) { fixtureError = error; send(500, { error: "Fixture contract failed" }); }
  });
  const sockets = new WebSocketServer({ server, path: "/ws" });
  sockets.on("connection", socket => {
    let deviceId = "";
    let teacherAuthenticated = false;
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "auth") {
        if (message.role === "student") {
          deviceId = message.deviceId;
          devices.set(deviceId, socket);
          assert.equal(message.clientProtocolVersion, 3);
        } else {
          teacherAuthenticated = true;
          if (defect === "auth-silent") return;
          if (defect === "auth-rejected") { socket.send(JSON.stringify({ type: "auth-error" })); return; }
        }
        socket.send(JSON.stringify({ type: "auth-success", role: defect === "auth-role" && message.role === "teacher" ? "student" : message.role,
          transportProbeV1: true, screenshotPolicy: policy }));
      } else if (message.type === "subscribe-session") {
        assert.equal(teacherAuthenticated, true);
        assert.equal(message.teachingSessionId, "session");
        assert.match(message.requestId, /^[A-Za-z0-9._-]{1,128}$/);
        const success = { type: "session-subscription-success", teachingSessionId: "session", requestId: message.requestId };
        if (defect === "subscription-silent") return;
        if (defect === "subscription-late") {
          fixtureLater(() => {
            assert.equal(socket.readyState, WebSocket.OPEN, "The late ACK must actually reach the live transport");
            socket.send(JSON.stringify(success));
            lateAckSent = true;
          }, 5500);
          return;
        }
        if (defect === "subscription-closed") { socket.close(1012); return; }
        if (defect === "subscription-rejected") {
          socket.send(JSON.stringify({ type: "session-subscription-error", requestId: message.requestId })); return;
        }
        if (defect === "subscription-stale") {
          socket.send(JSON.stringify({ ...success, requestId: "previous-connection-request" })); return;
        }
        if (defect === "subscription-foreign-session") {
          socket.send(JSON.stringify({ ...success, teachingSessionId: "foreign-session" })); return;
        }
        if (defect === "subscription-foreign-school") {
          socket.send(JSON.stringify({ ...success, schoolId: "foreign" })); return;
        }
        if (defect === "subscription-foreign-context") {
          socket.send(JSON.stringify({ ...success, supervisionContextId: "foreign-context" })); return;
        }
        // Missing/stale correlation and an early command frame cannot establish
        // authority or count as a server ACK. Only the exact ACK below is live.
        socket.send(JSON.stringify({ ...success, requestId: "previous-connection-request" }));
        socket.send(JSON.stringify({ type: success.type, teachingSessionId: "session" }));
        socket.send(JSON.stringify({ type: "classpilot-command-update", commandId: "unsubscribed-command",
          command: { id: "unsubscribed-command", teacherId: "teacher", teachingSessionId: "session", targets: [] } }));
        socket.send(JSON.stringify({ ...success, sessionId: "session" }));
        socket.send(JSON.stringify(success)); // Duplicate ACK must not create a second subscription.
        teachers.add(socket);
      } else if (message.type === "transport-probe") {
        probes++;
        socket.send(JSON.stringify({ type: "transport-probe-reply", nonce: message.nonce }));
      } else if (message.type === "command-ack") {
        const statuses = commands.get(message.commandId);
        assert.ok(statuses);
        assert.ok(statuses.has(deviceId));
        statuses.set(deviceId, message.status);
        const update = { type: "classpilot-command-update", commandId: message.commandId,
          command: { id: message.commandId, teacherId: "teacher", teachingSessionId: "session",
            targets: [...statuses].map(([id, status]) => ({ id, status })) } };
        for (const teacher of teachers) if (teacher.readyState === WebSocket.OPEN) teacher.send(JSON.stringify(update));
      }
    });
    socket.on("close", () => { if (devices.get(deviceId) === socket) devices.delete(deviceId); teachers.delete(socket); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const expiresAt = new Date(Date.now() + 48 * 3600_000).toISOString();
  const jwt = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 48 * 3600 })).toString("base64url")}.private-signature`;
  const manifest = [...Array.from({ length: 10 }, (_, i) => ({ deviceId: `canary-device-${i}`, studentId: `canary-student-${i}`, schoolId: "foreign", classId: null, studentToken: jwt })),
    ...studentIds.map(studentId => ({ deviceId: `device-${studentId}`, studentId, schoolId: "primary", classId: "class", studentToken: jwt }))];
  const manifestPath = join(root, "devices.private.json"), authPath = join(root, "teachers.private.json"), commandsPath = join(root, "commands.private.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(authPath, JSON.stringify({ schemaVersion: 2, baseUrl: origin, schoolId: "primary", expiresAt, deviceManifestExpiresAt: expiresAt,
    teacherAuth: [{ teacherId: "teacher", role: "teacher", schoolId: "primary", teachingSessionId: "session", studentIds,
      teacherCookie: "schoolpilot.sid=private-cookie", csrfToken: "private-csrf", teacherToken: jwt, expiresAt }] }));
  writeFileSync(commandsPath, JSON.stringify([{ teachingSessionId: "session", targetScope: "class", commandType: "open-tab", commandPayload: { url: "https://example.edu" } }]));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LOAD_")) delete env[key];
  const child = spawn(process.execPath, [runner, "--devices", "40", "--smoke"], { env: {
    ...env, NODE_ENV: "test", LOAD_BASE_URL: origin, LOAD_TEST_ARTIFACT_ROOT: root, LOAD_DEVICE_MANIFEST: manifestPath,
    LOAD_TEACHER_AUTH_FILE: authPath, LOAD_COMMAND_BODIES_FILE: commandsPath, LOAD_RUN_ID: "reliability-wire",
    LOAD_EXTERNAL_PROGRESS_PATH: join(root, "progress.jsonl"), LOAD_EXTERNAL_SUMMARY_PATH: join(root, "summary.json"),
    // A cycle may be admitted at the exact accelerated duration boundary. Keep
    // the existing bounded drain so it must meet the unchanged real 2s/5s SLOs.
    LOAD_TEST_ACCELERATED_RUNTIME_MS: "16000", LOAD_REQUEST_TIMEOUT_MS: "2000", LOAD_COMMAND_SETTLE_MS: "1000",
  } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(fixtureError, undefined);
    const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
    assert.equal(leases, releases, "All exact observation viewers are released even on a fatal gate");
    assert.doesNotMatch(stdout, /private-cookie|private-csrf|private-signature/);
    if (defect !== "none") {
      assert.equal(status, 1, `${stderr}\n${stdout}`);
      assert.equal(summary.thresholds.passed, false);
      if (defect === "binding") {
        assert.ok(summary.counters.teacherResponseValidationErrors > 0);
        assert.ok(summary.counters.reliabilityScreenshotAgeUnavailable > 0);
      } else if (defect === "foreign-tile") assert.ok(summary.counters.crossSchoolHttpResponses > 0);
      else {
        assert.equal(summary.websocket.finalPreShutdown.teacherReady, 0);
        assert.equal(summary.counters.teacherWsSubscribed, 0);
        assert.equal(sequence, 0, "No commands may be submitted before an exact acknowledged subscription");
        if (defect === "auth-role" || defect === "auth-rejected" || defect === "auth-silent") {
          assert.equal(summary.counters.teacherWsSubscriptionRequests, 0);
          assert.equal(summary.counters.teacherWsAuthErrors, 1);
          assert.equal(summary.fatalGate.kind, defect === "auth-role" ? "teacher-auth-role-mismatch"
            : defect === "auth-rejected" ? "teacher-auth-rejected" : "teacher-auth-timeout");
        } else if (defect === "subscription-closed") {
          assert.equal(summary.counters.teacherWsUnexpectedClosed, 1);
          assert.equal(summary.fatalGate.kind, "teacher-connection-closed");
        } else {
          assert.equal(summary.counters.teacherWsSubscriptionRequests, 1);
          assert.equal(summary.counters.teacherWsSubscriptionErrors, 1);
          if (defect === "subscription-silent" || defect === "subscription-stale" || defect === "subscription-late") {
            assert.equal(summary.counters.teacherWsSubscriptionTimeouts, 1);
            assert.equal(summary.fatalGate.kind, "teacher-subscription-timeout");
            assert.ok(summary.run.actualTrafficMilliseconds < 8000, "The five-second ACK deadline must fail before command warmup");
            if (defect === "subscription-late") {
              assert.equal(lateAckSent, true);
              assert.equal(summary.counters.teacherWsSubscriptionIgnored, 1);
            }
          } else if (defect === "subscription-rejected") assert.equal(summary.fatalGate.kind, "teacher-subscription-rejected");
          else assert.equal(summary.fatalGate.kind, "teacher-subscription-authority-mismatch");
        }
      }
      return;
    }
    assert.equal(status, 0, `${stderr}\n${stdout}`);
    assert.equal(summary.thresholds.passed, true, JSON.stringify(summary.thresholds.failures));
    assert.equal(summary.tileBatch.pollAccountingVersion, "reliability-separated-cadences-v1");
    assert.equal(summary.tileBatch.requestsPerCohortPerPoll, null);
    assert.ok(screenshots > histories);
    assert.ok(captureTimes.size >= 40);
    assert.equal(capturePayloads.size, captureTimes.size);
    assert.equal(new Set(capturePayloads.values()).size, capturePayloads.size, 'Distinct device entropy must reach the actual screenshot POSTs');
    assert.equal(summary.screenshotFixture.reliabilityPayload.fixtureCount, 50);
    assert.equal(summary.screenshotFixture.reliabilityPayload.captureEncoding.captures, summary.counters.screenshotPost);
    assert.ok(probes > 0);
    assert.equal(negativeTileProbes.size, 20, "Every foreign student is denied by both actual tile POST routes");
    assert.equal(summary.counters.tenantIsolationProbePassed, 20);
    assert.equal(summary.commands.deliveryWithin2sPercent, 100);
    assert.equal(summary.counters.forcedReconnectCompleted, 50);
    assert.equal(summary.counters.teacherWsSubscriptionRequests, 1);
    assert.equal(summary.counters.teacherWsSubscribed, 1);
    assert.equal(summary.counters.teacherWsSubscriptionIgnored, 3);
    assert.equal(summary.counters.teacherWsSubscriptionErrors, 0);
    assert.equal(summary.counters.commandUpdatesBeforeSubscription, 1);
    assert.ok(summary.counters.commandOwnedUpdatesObserved > 0);
    assert.equal(summary.websocket.finalPreShutdown.teacherSubscribed, 1);
    assert.equal(summary.websocket.finalPreShutdown.teacherReady, 1);
    assert.equal(summary.browserPaintValidated, false);
    assert.equal(summary.certificationEligible, false);
    assert.equal(summary.fineEndpointLatency.version, "classpilot-endpoint-latency-1ms-v1");
    assert.equal(summary.fineEndpointLatency.unclassifiedCount, 0);
    for (const [endpoint, expected] of [
      ["POST /api/classpilot/device/heartbeat", summary.counters.heartbeat],
      ["POST /api/classpilot/device/screenshot", summary.counters.screenshotPost],
      ["POST /api/classpilot/tiles/screenshots", summary.counters.tileBatchScreenshotRequests],
      ["POST /api/classpilot/tiles/history", summary.counters.tileBatchHistoryRequests],
    ] as const) {
      const histogram = summary.fineEndpointLatency.endpoints[endpoint];
      assert.equal(histogram.count, expected, `All ${endpoint} samples must be pooled once`);
      assert.equal(histogram.counts.reduce((sum: number, count: number) => sum + count, 0), expected);
      assert.equal(histogram.invalidCount, 0);
      assert.equal(histogram.p95Bounds.quantizationBoundMs, 1);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 16 * 1024 * 1024);
    assert.doesNotMatch(stdout, /private-cookie|private-csrf|private-signature/);
  } finally {
    clearTimeout(watchdog);
    for (const timer of fixtureTimers) clearTimeout(timer);
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
