import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClasspilotScreenshotFallbackStore,
} from "../src/services/classpilotScreenshotFallback.js";
import {
  claimClasspilotSafetyAlert,
  classpilotSafetyCooldownKey,
  resetClasspilotSafetyCooldownForTests,
} from "../src/services/classpilotSafetyCooldown.js";
import { CLASSPILOT_LIVE_VIEW_MAX_LOCAL_CLAIMS } from "../src/services/classpilotLiveViewNegotiation.js";
import {
  DEVICE_STATUS_MAX_BYTES,
  DEVICE_STATUS_MAX_PER_SCHOOL,
  DEVICE_STATUS_TTL_MS,
  deviceStatusCacheMetrics,
  getSchoolDeviceStatuses,
  resetDeviceStatusesForTests,
  updateDeviceClassification,
  updateDeviceStatus,
} from "../src/realtime/student-statuses.js";

const binding = {
  schoolId: "school-a",
  deviceId: "device-a",
  studentId: "student-a",
  studentSessionId: "session-a",
};

describe("ClassPilot bounded process state", () => {
  it("caps local Live View negotiation state", () => {
    assert.equal(CLASSPILOT_LIVE_VIEW_MAX_LOCAL_CLAIMS, 4_096);
  });

  it("evicts screenshots by byte budget and expires without extending freshness", () => {
    let now = 1_000;
    const store = new ClasspilotScreenshotFallbackStore(750, 100, 10, () => now);
    assert.equal(store.set(binding, { screenshot: "a".repeat(200), timestamp: now }), true);
    assert.ok(store.get(binding));
    assert.ok(store.stats().bytes <= 750);
    now += 101;
    assert.equal(store.get(binding), null);
    assert.equal(store.stats().bytes, 0);
  });

  it("rejects an individual screenshot larger than the configured byte budget", () => {
    const store = new ClasspilotScreenshotFallbackStore(100, 100, 10);
    assert.equal(store.set(binding, { screenshot: "x".repeat(1_000), timestamp: Date.now() }), false);
    assert.deepEqual(store.stats(), { entries: 0, bytes: 0, maxBytes: 100 });
  });

  it("does not revive an already stale capture when it enters fallback storage", () => {
    let now = 10_000;
    const store = new ClasspilotScreenshotFallbackStore(750, 100, 10, () => now);
    assert.equal(store.set(binding, { screenshot: "fresh", timestamp: now }), true);
    now += 101;
    assert.equal(store.set(binding, { screenshot: "stale", timestamp: now - 101 }), false);
    assert.equal(store.get(binding), null);
  });

  it("uses a non-identifying HMAC Redis key and deduplicates locally", async () => {
    const previousRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    resetClasspilotSafetyCooldownForTests();
    try {
      const key = classpilotSafetyCooldownKey({ ...binding, domain: "example.test" });
      assert.equal(key.includes(binding.schoolId), false);
      assert.equal(key.includes(binding.deviceId), false);
      assert.equal(key.includes("example.test"), false);
      assert.equal(await claimClasspilotSafetyAlert({ ...binding, domain: "example.test" }), true);
      assert.equal(await claimClasspilotSafetyAlert({ ...binding, domain: "example.test" }), false);
    } finally {
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
      resetClasspilotSafetyCooldownForTests();
    }
  });

  it("bounds realtime device status state and drops expired entries", () => {
    resetDeviceStatusesForTests();
    try {
      for (let index = 0; index < DEVICE_STATUS_MAX_PER_SCHOOL + 4; index += 1) {
        updateDeviceStatus({
          schoolId: "school-bounded",
          deviceId: `device-${index}`,
          studentId: `student-${index}`,
          activeTabUrl: "https://example.test/",
          activeTabTitle: "Example",
          screenLocked: false,
          flightPathActive: false,
          isSharing: false,
          cameraActive: false,
          lastSeenAt: 0,
        });
      }

      const statuses = getSchoolDeviceStatuses("school-bounded");
      assert.equal(statuses.length, DEVICE_STATUS_MAX_PER_SCHOOL);
      assert.equal(statuses.some((status) => status.deviceId === "device-0"), false);
      assert.ok(deviceStatusCacheMetrics().bytes <= DEVICE_STATUS_MAX_BYTES);

      const expired = statuses[0];
      assert.ok(expired);
      expired.lastSeenAt = Date.now() - DEVICE_STATUS_TTL_MS - 1;
      updateDeviceClassification("school-bounded", expired.deviceId, {
        category: "educational",
        safetyAlert: null,
      });
      assert.equal(
        getSchoolDeviceStatuses("school-bounded").some(
          (status) => status.deviceId === expired.deviceId
        ),
        false
      );
    } finally {
      resetDeviceStatusesForTests();
    }
  });
});
