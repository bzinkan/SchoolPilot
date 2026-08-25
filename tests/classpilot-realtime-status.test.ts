import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const {
  CLASSPILOT_REALTIME_MAX_BYTES,
  CLASSPILOT_REALTIME_MAX_TABS,
  classpilotPublicRealtimeBinding,
  classpilotRealtimeFresh,
  classpilotRealtimeStatusFromHeartbeat,
  classpilotRealtimeStatusKey,
  createClasspilotRealtimeStatusStore,
  normalizeClasspilotPublicCapabilities,
  normalizeClasspilotPublicClassroomControls,
} = await import("../src/services/classpilotRealtimeStatus.ts");

const binding = {
  schoolId: "school-a",
  studentId: "student-a",
  studentSessionId: "session-a",
  deviceId: "device-a",
};

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    ...binding,
    heartbeatId: "heartbeat-a",
    observedAt: 1_000_000,
    activeTabUrl: "https://example.test/path",
    activeTabTitle: "Example",
    trackingStatus: "ACTIVE",
    allOpenTabs: [],
    classificationPending: true,
    ...overrides,
  };
}

describe("ClassPilot cluster-safe realtime status", () => {
  it("builds heartbeat fallback status from Date, string, and numeric timestamps", () => {
    const now = Date.parse("2026-08-25T13:20:00.000Z");
    const observedAt = now - 30_000;
    const history = {
      id: "heartbeat-history-a",
      schoolId: binding.schoolId,
      studentId: binding.studentId,
      deviceId: binding.deviceId,
      timestamp: new Date(observedAt),
      activeTabUrl: "https://example.test/history",
      activeTabTitle: "History",
      screenLocked: true,
      flightPathActive: false,
      isSharing: false,
      cameraActive: false,
    };

    const timestampForms = [
      new Date(observedAt),
      new Date(observedAt).toISOString(),
      observedAt,
    ];
    for (const sessionStartedAt of timestampForms) {
      for (const timestamp of timestampForms) {
        const snapshot = classpilotRealtimeStatusFromHeartbeat(
          binding.schoolId,
          { ...binding, sessionStartedAt },
          { ...history, timestamp },
          now
        );
        assert.ok(snapshot);
        assert.equal(snapshot.observedAt, observedAt);
        assert.equal(snapshot.activeTabTitle, "History");
        assert.equal(snapshot.studentSessionId, binding.studentSessionId);
      }
    }
  });

  it("fails closed for invalid, stale, pre-session, future, or mismatched heartbeat history", () => {
    const now = Date.parse("2026-08-25T13:20:00.000Z");
    const observedAt = now - 30_000;
    const validBinding = {
      ...binding,
      sessionStartedAt: new Date(observedAt).toISOString(),
    };
    const history = {
      id: "heartbeat-history-a",
      schoolId: binding.schoolId,
      studentId: binding.studentId,
      deviceId: binding.deviceId,
      timestamp: new Date(observedAt),
      activeTabUrl: "https://example.test/history",
      activeTabTitle: "History",
    };
    const build = (
      bindingOverride: Record<string, unknown> = {},
      heartbeatOverride: Record<string, unknown> = {}
    ) => classpilotRealtimeStatusFromHeartbeat(
      binding.schoolId,
      { ...validBinding, ...bindingOverride },
      { ...history, ...heartbeatOverride },
      now
    );

    for (const sessionStartedAt of [
      null,
      undefined,
      "",
      "not-a-date",
      "0",
      String(observedAt),
      "2026-02-31T13:15:00.000Z",
      new Date(0),
      1_700_000_000,
    ]) {
      assert.equal(build({ sessionStartedAt }), null);
    }
    for (const timestamp of [
      "not-a-date",
      "0",
      String(observedAt),
      "2026-02-31T13:15:00.000Z",
      new Date(0),
      1_700_000_000,
    ]) {
      assert.equal(build({}, { timestamp }), null);
    }
    assert.equal(build({ sessionStartedAt: new Date(observedAt + 1).toISOString() }), null);
    assert.equal(build({}, { timestamp: new Date(now - 300_000) }), null);
    assert.equal(build({}, { timestamp: new Date(now + 1) }), null);
    assert.equal(build({}, { schoolId: "school-b" }), null);
    assert.equal(build({}, { studentId: "student-b" }), null);
    assert.equal(build({}, { deviceId: "device-b" }), null);
    assert.equal(classpilotRealtimeStatusFromHeartbeat(
      binding.schoolId,
      validBinding,
      null,
      now
    ), null);
  });

  it("uses a hashed Redis key without exposing school or device identifiers", () => {
    const key = classpilotRealtimeStatusKey(binding.schoolId, binding.deviceId);
    assert.match(key, /:classpilot:latest-status:[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(key, /school-a|device-a/);
  });

  it("derives a stable public binding without exposing the student-session id", () => {
    const publicBinding = classpilotPublicRealtimeBinding(binding.studentSessionId);
    assert.match(publicBinding || "", /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(publicBinding || "", /session-a/);
    assert.equal(publicBinding, classpilotPublicRealtimeBinding(binding.studentSessionId));
    assert.notEqual(publicBinding, classpilotPublicRealtimeBinding("session-b"));
    assert.equal(classpilotPublicRealtimeBinding(null), null);
  });

  it("bounds tabs and snapshot bytes in the outage-safe local fallback", async () => {
    const store = createClasspilotRealtimeStatusStore(async () => undefined, () => 1_000_000);
    const result = await store.write(heartbeat({
      allOpenTabs: Array.from({ length: 100 }, (_, index) => ({
        url: `https://example.test/${index}/${"x".repeat(5_000)}`,
        title: `Tab ${index} ${"y".repeat(1_000)}`,
        favicon: `data:image/png;base64,${"z".repeat(1_000)}`,
      })),
    }));

    assert.equal(result.status, "local");
    assert.ok(result.snapshot);
    assert.ok(result.snapshot.allOpenTabs.length <= CLASSPILOT_REALTIME_MAX_TABS);
    assert.equal(result.snapshot.openTabCount, 100);
    assert.equal(result.snapshot.tabsTruncated, true);
    assert.ok(result.snapshot.allOpenTabs.every((tab) => tab.favicon === undefined));
    assert.ok(Buffer.byteLength(JSON.stringify(result.snapshot), "utf8") <= CLASSPILOT_REALTIME_MAX_BYTES);
  });

  it("evicts one circular local snapshot without suppressing another student", async () => {
    const store = createClasspilotRealtimeStatusStore(async () => undefined, () => 1_000_000);
    const secondBinding = {
      schoolId: binding.schoolId,
      studentId: "student-b",
      studentSessionId: "session-b",
      deviceId: "device-b",
    };
    const corrupted = await store.write(heartbeat());
    const valid = await store.write(heartbeat({
      ...secondBinding,
      heartbeatId: "heartbeat-b",
      activeTabUrl: "https://valid.example.test",
    }));
    assert.ok(corrupted.snapshot);
    assert.ok(valid.snapshot);
    Object.assign(corrupted.snapshot, { circular: corrupted.snapshot });

    const results = store.readLocal(binding.schoolId, [binding, secondBinding]);
    assert.equal(results.get(binding.studentId)?.status, "rejected");
    assert.equal(results.get(secondBinding.studentId)?.status, "hit");
    const validResult = results.get(secondBinding.studentId);
    if (validResult?.status === "hit") {
      assert.equal(validResult.snapshot.activeTabUrl, "https://valid.example.test");
    }

    const evicted = store.readLocal(binding.schoolId, [binding]);
    assert.equal(evicted.get(binding.studentId)?.status, "miss");
  });

  it("normalizes malformed public controls and capabilities without throwing", () => {
    const inactiveControls = {
      screenLocked: false,
      flightPathActive: false,
      isSharing: false,
      cameraActive: false,
    };
    for (const malformed of [
      undefined,
      null,
      "controls",
      [],
      { screenLocked: true },
      {
        screenLocked: true,
        flightPathActive: false,
        isSharing: false,
        cameraActive: "false",
        activeFlightPathName: "Math",
      },
    ]) {
      assert.deepEqual(
        normalizeClasspilotPublicClassroomControls(malformed),
        inactiveControls
      );
    }

    const revokedControls = Proxy.revocable({}, {});
    revokedControls.revoke();
    assert.deepEqual(
      normalizeClasspilotPublicClassroomControls(revokedControls.proxy),
      inactiveControls
    );

    const validControls = {
      screenLocked: true,
      flightPathActive: true,
      activeFlightPathName: "Algebra Flight Path",
      isSharing: true,
      cameraActive: false,
    };
    assert.deepEqual(
      normalizeClasspilotPublicClassroomControls(validControls),
      validControls
    );

    for (const malformed of [
      undefined,
      null,
      "exactTabCloseV1",
      { exactTabCloseV1: true },
      ["exactTabCloseV1", 2],
      ["x".repeat(65)],
    ]) {
      assert.deepEqual(normalizeClasspilotPublicCapabilities(malformed), []);
    }
    const revokedCapabilities = Proxy.revocable([], {});
    revokedCapabilities.revoke();
    assert.deepEqual(
      normalizeClasspilotPublicCapabilities(revokedCapabilities.proxy),
      []
    );
    assert.deepEqual(
      normalizeClasspilotPublicCapabilities([
        "exactTabCloseV1",
        "screenOnlyUnlockV1",
        "exactTabCloseV2",
      ]),
      ["exactTabCloseV1", "screenOnlyUnlockV1", "exactTabCloseV2"]
    );
  });

  it("keeps the latest-status value bounded when desired restrictions are unusually large", async () => {
    const store = createClasspilotRealtimeStatusStore(async () => undefined, () => 1_000_000);
    const result = await store.write(heartbeat({
      classroomState: {
        schemaVersion: 1,
        revision: 1,
        teachingSessionId: "teaching-session-a",
        receivedAt: new Date(1_000_000).toISOString(),
        scheduledEndAt: null,
        hardExpiresAt: new Date(2_000_000).toISOString(),
        restrictions: {
          screenLock: { active: false },
          flightPath: {
            active: true,
            allowedDomains: Array.from({ length: 1_000 }, (_, index) =>
              `${index}-${"x".repeat(253)}.example.test`
            ),
          },
          blockList: { active: false, blockedDomains: [] },
          attentionMode: { active: false },
          tabLimit: null,
          temporaryAllows: [],
        },
      },
    }));

    assert.ok(result.snapshot);
    assert.equal(result.snapshot.classroomState, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result.snapshot), "utf8") <= CLASSPILOT_REALTIME_MAX_BYTES);
  });

  it("keeps server-accepted capabilities separate from raw legacy declarations", async () => {
    const store = createClasspilotRealtimeStatusStore(async () => undefined, () => 1_000_000);
    const result = await store.write(heartbeat({
      clientProtocolVersion: 3,
      extensionCapabilities: ["exactTabCloseV1", "screenshotObservationLeaseV1"],
      acceptedCapabilities: ["exactTabCloseV2", "screenshotObservationLeaseV1"],
    }));
    assert.equal(result.snapshot?.clientProtocolVersion, 3);
    assert.deepEqual(result.snapshot?.extensionCapabilities, [
      "exactTabCloseV1",
      "screenshotObservationLeaseV1",
    ]);
    assert.deepEqual(result.snapshot?.acceptedCapabilities, [
      "exactTabCloseV2",
      "screenshotObservationLeaseV1",
    ]);
  });

  it("guards local classification patches by exact heartbeat and session", async () => {
    let clock = 1_000_000;
    const store = createClasspilotRealtimeStatusStore(async () => undefined, () => clock++);
    const written = await store.write(heartbeat());
    assert.ok(written.snapshot);

    const stale = await store.patchClassification({
      ...binding,
      heartbeatId: "older-heartbeat",
      classification: { category: "non-educational", safetyAlert: null },
    });
    assert.equal(stale.status, "stale");

    const applied = await store.patchClassification({
      ...binding,
      heartbeatId: "heartbeat-a",
      classification: { category: "educational", safetyAlert: null },
    });
    assert.equal(applied.status, "local");
    assert.equal(applied.snapshot?.classificationPending, false);
    assert.equal(applied.snapshot?.aiClassification?.category, "educational");
    assert.ok((applied.snapshot?.revision ?? 0) > (written.snapshot?.revision ?? 0));
  });

  it("rejects wrong-school, wrong-device, and wrong-session Redis values", async () => {
    const encoded = JSON.stringify({
      schemaVersion: 2,
      state: "active",
      ...binding,
      revision: 1_000_000_000,
      heartbeatId: "heartbeat-a",
      observedAt: 1_000_000,
      activeTabUrl: "https://example.test",
      activeTabTitle: "Example",
      allOpenTabs: [],
      openTabCount: 0,
      tabsTruncated: false,
      activityState: "active",
      classroomControls: {
        screenLocked: false,
        flightPathActive: false,
        isSharing: false,
        cameraActive: false,
      },
      classificationPending: false,
    });
    const store = createClasspilotRealtimeStatusStore(async (args) => {
      if (args[0] === "MGET") return [encoded];
      return undefined;
    }, () => 1_001_000);

    const exact = await store.readBatch(binding.schoolId, [binding]);
    assert.equal(exact.get(binding.studentId)?.status, "hit");

    const wrongSession = await store.readBatch(binding.schoolId, [{
      ...binding,
      studentSessionId: "session-b",
    }]);
    assert.equal(wrongSession.get(binding.studentId)?.status, "mismatch");

    const wrongSchool = await store.readBatch("school-b", [binding]);
    assert.equal(wrongSchool.get(binding.studentId)?.status, "mismatch");
  });

  it("treats the exact 300-second boundary as expired", async () => {
    const encoded = JSON.stringify({
      schemaVersion: 2,
      state: "active",
      ...binding,
      revision: 1_000_000_000,
      heartbeatId: "heartbeat-a",
      observedAt: 1_000_000,
      activeTabUrl: "https://example.test",
      activeTabTitle: "Example",
      allOpenTabs: [],
      openTabCount: 0,
      tabsTruncated: false,
      activityState: "active",
      classroomControls: {
        screenLocked: false,
        flightPathActive: false,
        isSharing: false,
        cameraActive: false,
      },
      classificationPending: false,
    });
    const store = createClasspilotRealtimeStatusStore(
      async (args) => args[0] === "MGET" ? [encoded] : undefined,
      () => 1_300_000
    );
    const result = await store.readBatch(binding.schoolId, [binding]);
    assert.equal(result.get(binding.studentId)?.status, "expired");
  });

  it("marks the exact 60-second boundary stale", () => {
    const snapshot = {
      observedAt: 1_000_000,
    } as Parameters<typeof classpilotRealtimeFresh>[0];
    assert.equal(classpilotRealtimeFresh(snapshot, 1_059_999), true);
    assert.equal(classpilotRealtimeFresh(snapshot, 1_060_000), false);
  });

  it("keeps signed-out tombstones revisioned and refuses to clear a replacement session", async () => {
    let clock = 1_000_000;
    const store = createClasspilotRealtimeStatusStore(async () => undefined, () => clock++);
    const written = await store.write(heartbeat());
    const signedOut = await store.markSignedOut({
      ...binding,
      reason: "explicit_sign_out",
      observedAt: 1_000_010,
    });
    assert.equal(signedOut.snapshot?.state, "signed_out");
    assert.ok((signedOut.snapshot?.revision ?? 0) > (written.snapshot?.revision ?? 0));

    const stale = await store.markSignedOut({
      ...binding,
      studentSessionId: "session-old",
      reason: "session_replaced",
    });
    assert.equal(stale.status, "stale");

    const replacement = await store.write(heartbeat({
      studentSessionId: "session-b",
      heartbeatId: "heartbeat-b",
      observedAt: 1_000_020,
    }));
    assert.notEqual(replacement.status, "stale");
    assert.equal(replacement.snapshot?.state, "active");
    assert.equal(replacement.snapshot?.studentSessionId, "session-b");
  });

  it("shares the latest page across API instances and rejects a stale classification race", async () => {
    const values = new Map<string, string>();
    const fakeRedis = async (args: string[]) => {
      if (args[0] === "MGET") return args.slice(1).map((key) => values.get(key) ?? null);
      if (args[0] !== "EVAL") return undefined;
      const key = args[3]!;
      if (args.length === 7) {
        const proposed = JSON.parse(args[5]!);
        const current = values.has(key) ? JSON.parse(values.get(key)!) : null;
        proposed.revision = Math.max(Number(args[4]), Number(current?.revision || 0) + 1);
        const encoded = JSON.stringify(proposed);
        values.set(key, encoded);
        return encoded;
      }
      if (args.length === 12) {
        const current = values.has(key) ? JSON.parse(values.get(key)!) : null;
        if (
          !current ||
          current.schoolId !== args[4] ||
          current.studentId !== args[5] ||
          current.studentSessionId !== args[6] ||
          current.deviceId !== args[7] ||
          current.heartbeatId !== args[8]
        ) {
          return "";
        }
        current.revision = Math.max(Number(args[9]), Number(current.revision) + 1);
        current.aiClassification = JSON.parse(args[10]!);
        current.classificationPending = false;
        const encoded = JSON.stringify(current);
        values.set(key, encoded);
        return encoded;
      }
      return undefined;
    };

    let clockA = 1_000_000;
    let clockB = 1_000_100;
    const taskA = createClasspilotRealtimeStatusStore(fakeRedis, () => clockA++);
    const taskB = createClasspilotRealtimeStatusStore(fakeRedis, () => clockB++);
    await taskA.write(heartbeat({ heartbeatId: "heartbeat-old" }));
    const newest = await taskB.write(heartbeat({
      heartbeatId: "heartbeat-new",
      activeTabUrl: "https://newest.example.test",
      observedAt: 1_000_100,
    }));

    const stale = await taskA.patchClassification({
      ...binding,
      heartbeatId: "heartbeat-old",
      classification: { category: "non-educational", safetyAlert: null },
    });
    assert.equal(stale.status, "stale");

    const taskBRead = await taskB.readBatch(binding.schoolId, [binding]);
    const snapshot = taskBRead.get(binding.studentId);
    assert.equal(snapshot?.status, "hit");
    if (snapshot?.status === "hit") {
      assert.equal(snapshot.snapshot.heartbeatId, "heartbeat-new");
      assert.equal(snapshot.snapshot.activeTabUrl, "https://newest.example.test");
      assert.equal(snapshot.snapshot.aiClassification, undefined);
      assert.equal(snapshot.snapshot.revision, newest.snapshot?.revision);
    }
  });

  it("keeps the roster fallback order and heartbeat publication contract explicit", () => {
    const compat = readFileSync(
      new URL("../src/routes/compat.ts", import.meta.url),
      "utf8"
    );
    const devices = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const aggregateStart = compat.indexOf('router.get("/students-aggregated"');
    const aggregateEnd = compat.indexOf("// Export (ClassPilot)", aggregateStart);
    const aggregate = compat.slice(aggregateStart, aggregateEnd);
    const realtimeLoaderStart = compat.indexOf("async function loadAuthorizedRealtimeStatuses");
    const realtimeLoaderEnd = compat.indexOf("// ============================================================================", realtimeLoaderStart);
    const realtimeLoader = compat.slice(realtimeLoaderStart, realtimeLoaderEnd);

    assert.ok(aggregateStart >= 0 && aggregateEnd > aggregateStart);
    assert.match(aggregate, /studentSessionId: row\.studentSessionId!/);
    assert.match(aggregate, /monitoringState/);
    assert.match(aggregate, /realtimeBinding:\s*!delegatedAway[\s\S]*?classpilotPublicRealtimeBinding\(snapshot\?\.studentSessionId\)/);
    assert.match(aggregate, /realtimeRevision/);
    assert.doesNotMatch(aggregate, /getSchoolDeviceStatuses|getConnectedStudentDeviceIds/);
    assert.ok(
      realtimeLoader.indexOf("readClasspilotRealtimeStatusBatch") <
      realtimeLoader.indexOf("readHeartbeatTileCacheBatch")
    );
    assert.ok(
      realtimeLoader.indexOf("readHeartbeatTileCacheBatch") <
      realtimeLoader.indexOf("readLocalClasspilotRealtimeStatusBatch")
    );
    assert.match(realtimeLoader, /classpilotRealtimeStatusFromHeartbeat\(/);
    assert.doesNotMatch(realtimeLoader, /sessionStartedAt\?\.getTime\(\)/);

    assert.match(devices, /Promise\.all\(\[\s*heartbeatTileCacheWrite,\s*realtimeStatusWrite/);
    assert.match(devices, /patchClasspilotRealtimeClassification\(\{[\s\S]*?heartbeatId: heartbeat\.id/);
    assert.match(devices, /publishRevisionedRealtimeUpdate/);
    assert.match(devices, /realtimeBinding:\s*classpilotPublicRealtimeBinding\(snapshot\.studentSessionId\)/);
    assert.match(devices, /acceptedCapabilities:\s*protocol\.acceptedCapabilities/);

    const screenshotStart = devices.indexOf('router.post("/device/screenshot"');
    const screenshotEnd = devices.indexOf('// POST /api/classpilot/tiles/screenshots', screenshotStart);
    const screenshot = devices.slice(screenshotStart, screenshotEnd);
    assert.match(screenshot, /realtime\.snapshot\.acceptedCapabilities/);
    assert.match(screenshot, /SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED/);
    assert.doesNotMatch(screenshot, /screenshotClientProtocolVersion|screenshotCapabilities/);
  });

  it("publishes exact-tab and extension capabilities without device identifiers", () => {
    const compat = readFileSync(
      new URL("../src/routes/compat.ts", import.meta.url),
      "utf8"
    );
    const devices = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const contractStart = compat.indexOf("function publicClasspilotExtensionContract");
    const contractEnd = compat.indexOf("async function loadAuthorizedRealtimeStatuses", contractStart);
    const contract = compat.slice(contractStart, contractEnd);
    const aggregateStart = compat.indexOf('router.get("/students-aggregated"');
    const aggregateEnd = compat.indexOf("// Export (ClassPilot)", aggregateStart);
    const aggregate = compat.slice(aggregateStart, aggregateEnd);
    const serializerStart = aggregate.indexOf("return {", aggregate.indexOf("const publicExtensionContract"));
    const serializer = aggregate.slice(serializerStart, aggregate.indexOf("return res.json(aggregated)"));

    assert.ok(contractStart >= 0 && contractEnd > contractStart);
    assert.match(contract, /tabSnapshot:.*[\s\S]*schemaVersion: 1, revision: tabSnapshotRevision/);
    assert.match(contract, /tabSnapshotRevision,/);
    assert.match(contract, /extensionVersion: snapshot\?\.extensionVersion \?\? null/);
    assert.match(contract, /clientProtocolVersion: snapshot\?\.clientProtocolVersion \?\? null/);
    assert.match(contract, /normalizeClasspilotPublicCapabilities\(snapshot\?\.extensionCapabilities\)/);
    assert.match(contract, /normalizeClasspilotPublicCapabilities\(snapshot\?\.acceptedCapabilities\)/);
    assert.match(contract, /exactTabCloseV2: acceptedCapabilities\.has\("exactTabCloseV2"\)/);
    for (const capability of [
      "exactTabCloseV1",
      "screenOnlyUnlockV1",
      "fabStateRevisionV1",
      "durableChatAckV1",
      "commandAckReceiptV1",
      "classroomOverlayRestoreV1",
      "liveViewNegotiationV1",
    ]) {
      assert.match(contract, new RegExp(`${capability}: extensionCapabilities\\.has\\("${capability}"\\)`));
    }
    assert.match(contract, /minExtensionVersion: "2\.6\.0"/);
    assert.doesNotMatch(contract, /deviceId|studentSessionId|schoolId/);
    assert.match(aggregate, /publicClasspilotExtensionContract\(visibleRealtime\)/);
    assert.match(aggregate, /normalizeClasspilotPublicClassroomControls\([\s\S]*?visibleRealtime\?\.classroomControls/);
    assert.match(serializer, /\.\.\.publicExtensionContract/);
    assert.doesNotMatch(serializer, /\bdeviceId\s*:/);

    const deviceProjectionStart = devices.indexOf("function publicRealtimeFields");
    const deviceProjectionEnd = devices.indexOf("type ClasspilotRealtimeControlAuthority", deviceProjectionStart);
    const deviceProjection = devices.slice(deviceProjectionStart, deviceProjectionEnd);
    assert.match(deviceProjection, /normalizeClasspilotPublicCapabilities\(snapshot\.extensionCapabilities\)/);
    assert.match(deviceProjection, /normalizeClasspilotPublicCapabilities\(snapshot\.acceptedCapabilities\)/);
    assert.match(deviceProjection, /normalizeClasspilotPublicClassroomControls\([\s\S]*?snapshot\.classroomControls/);
    assert.doesNotMatch(deviceProjection, /snapshot\.classroomControls\.(?:screenLocked|flightPathActive|activeFlightPathName|isSharing|cameraActive)/);
  });
});
