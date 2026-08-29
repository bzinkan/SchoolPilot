import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createClasspilotStudentDataProvisionalCache,
  type ClasspilotStudentDataCacheBinding,
  type ClasspilotStudentDataCachedComputation,
} from "../src/services/classpilotStudentDataProvisionalCache.js";

const windowEnd = "2026-08-28T15:00:00.000Z";

function binding(
  patch: Partial<ClasspilotStudentDataCacheBinding> = {}
): ClasspilotStudentDataCacheBinding {
  return {
    schemaVersion: 2,
    schoolId: "school-a",
    teachingSessionId: "session-a",
    groupId: "group-a",
    state: "live",
    reportId: null,
    reportState: null,
    reportVersion: 2,
    windowStart: "2026-08-28T14:30:00.000Z",
    windowEnd,
    snapshotBucket: windowEnd,
    timezone: "America/New_York",
    trackingPolicyHash: "policy-a",
    contextHash: "context-a",
    ...patch,
  };
}

function computation(seconds = 20): ClasspilotStudentDataCachedComputation {
  return {
    asOf: new Date(windowEnd),
    rows: [{
      teachingSessionId: "session-a",
      studentId: "student-a",
      localDate: "2026-08-28",
      totalSeconds: seconds,
      heartbeatCount: 2,
      topDomains: [{ domain: "docs.google.com", seconds, visits: 1 }],
      topActivities: [{
        kind: "google_docs",
        domain: "docs.google.com",
        seconds,
        visits: 1,
      }],
      computedAt: new Date(windowEnd),
    }],
  };
}

function memoryRedis() {
  const values = new Map<string, string>();
  const command = async (args: string[]): Promise<unknown> => {
    const key = args[1];
    if (!key) return undefined;
    if (args[0] === "GET") return values.get(key) ?? null;
    if (args[0] === "SET" && args.includes("NX")) {
      const value = args[2];
      if (value === undefined) return undefined;
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    }
    if (args[0] === "SET") {
      const value = args[2];
      if (value === undefined) return undefined;
      values.set(key, value);
      return "OK";
    }
    if (args[0] === "EVAL") {
      const lockKey = args[3];
      if (lockKey) values.delete(lockKey);
      return 1;
    }
    return undefined;
  };
  return { command, values };
}

describe("ClassPilot Student Data provisional cache", () => {
  it("coalesces identical concurrent work and keeps bindings isolated", async () => {
    const cache = createClasspilotStudentDataProvisionalCache(async () => undefined);
    let computeCount = 0;
    const compute = async () => {
      computeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return computation();
    };
    const [first, second] = await Promise.all([
      cache.getOrCompute({ binding: binding(), ttlSeconds: 60, compute }),
      cache.getOrCompute({ binding: binding(), ttlSeconds: 60, compute }),
    ]);
    assert.equal(computeCount, 1);
    assert.deepEqual(first, second);
    await cache.getOrCompute({ binding: binding(), ttlSeconds: 60, compute });
    assert.equal(computeCount, 1, "the local hit must not re-run heartbeat materialization");

    await cache.getOrCompute({
      binding: binding({ contextHash: "changed-supervision-context" }),
      ttlSeconds: 60,
      compute,
    });
    await cache.getOrCompute({
      binding: binding({ schoolId: "school-b" }),
      ttlSeconds: 60,
      compute,
    });
    assert.equal(computeCount, 3, "authority/context changes are cache misses");
  });

  it("shares valid rows through Redis without caching names or trusting malformed rows", async () => {
    const { command, values: redis } = memoryRedis();
    let firstComputes = 0;
    const firstCache = createClasspilotStudentDataProvisionalCache(command);
    await firstCache.getOrCompute({
      binding: binding(),
      ttlSeconds: 60,
      compute: async () => {
        firstComputes += 1;
        return computation();
      },
    });
    assert.equal(firstComputes, 1);
    assert.doesNotMatch([...redis.values()].join("\n"), /student name|firstName|lastName/i);
    const valueKey = [...redis.keys()].find((key) => !key.endsWith(":lock"));
    assert.ok(valueKey);
    assert.match(valueKey, /:classpilot:student-data-provisional:v2:/);
    const firstEncoded = redis.get(valueKey);
    assert.ok(firstEncoded);
    const firstDecoded = JSON.parse(firstEncoded);
    assert.equal(firstDecoded.schemaVersion, 2);
    assert.deepEqual(firstDecoded.rows[0].topActivities, [{
      kind: "google_docs",
      domain: "docs.google.com",
      seconds: 20,
      visits: 1,
    }]);

    let secondComputes = 0;
    const secondCache = createClasspilotStudentDataProvisionalCache(command);
    const shared = await secondCache.getOrCompute({
      binding: binding(),
      ttlSeconds: 60,
      compute: async () => {
        secondComputes += 1;
        return computation(99);
      },
    });
    assert.equal(secondComputes, 0);
    assert.ok(shared.rows[0]);
    assert.equal(shared.rows[0].totalSeconds, 20);
    assert.deepEqual(shared.rows[0].topActivities, [{
      kind: "google_docs",
      domain: "docs.google.com",
      seconds: 20,
      visits: 1,
    }]);

    const encoded = redis.get(valueKey);
    assert.ok(encoded);
    const malformed = JSON.parse(encoded);
    malformed.rows.push(malformed.rows[0]);
    redis.set(valueKey, JSON.stringify(malformed));
    let recoveryComputes = 0;
    const recoveryCache = createClasspilotStudentDataProvisionalCache(command);
    const recovered = await recoveryCache.getOrCompute({
      binding: binding(),
      ttlSeconds: 60,
      compute: async () => {
        recoveryComputes += 1;
        return computation(30);
      },
    });
    assert.equal(recoveryComputes, 1, "duplicate cached usage keys must be rejected");
    assert.ok(recovered.rows[0]);
    assert.equal(recovered.rows[0].totalSeconds, 30);
  });

  it("rejects v1, malformed, or privacy-leaking activity rows from Redis", async () => {
    const { command, values: redis } = memoryRedis();
    const primer = createClasspilotStudentDataProvisionalCache(command);
    await primer.getOrCompute({
      binding: binding(),
      ttlSeconds: 60,
      compute: async () => computation(),
    });
    const valueKey = [...redis.keys()].find((key) => !key.endsWith(":lock"));
    assert.ok(valueKey);
    const validEncoded = redis.get(valueKey);
    assert.ok(validEncoded);

    type EncodedForMutation = {
      schemaVersion: number;
      rows: Array<{
        topActivities?: Array<Record<string, unknown>>;
      }>;
    };
    const cases: Array<{
      label: string;
      mutate: (value: EncodedForMutation) => void;
    }> = [
      {
        label: "v1 schema",
        mutate: (value) => { value.schemaVersion = 1; },
      },
      {
        label: "missing activity dimension",
        mutate: (value) => { delete value.rows[0]!.topActivities; },
      },
      {
        label: "unknown activity kind",
        mutate: (value) => { value.rows[0]!.topActivities![0]!.kind = "google_unknown"; },
      },
      {
        label: "document path leakage",
        mutate: (value) => {
          value.rows[0]!.topActivities![0]!.domain =
            "docs.google.com/document/d/private-document-id/edit";
        },
      },
      {
        label: "query leakage",
        mutate: (value) => {
          value.rows[0]!.topActivities![0]!.domain = "docs.google.com?student-secret=1";
        },
      },
      {
        label: "full URL leakage",
        mutate: (value) => {
          value.rows[0]!.topActivities![0]!.domain =
            "https://docs.google.com/document/d/private-document-id/edit?student-secret=1";
        },
      },
    ];

    for (const malformedCase of cases) {
      const malformed = JSON.parse(validEncoded) as EncodedForMutation;
      malformedCase.mutate(malformed);
      redis.set(valueKey, JSON.stringify(malformed));
      let computes = 0;
      const cache = createClasspilotStudentDataProvisionalCache(command);
      const recovered = await cache.getOrCompute({
        binding: binding(),
        ttlSeconds: 60,
        compute: async () => {
          computes += 1;
          return computation(30);
        },
      });
      assert.equal(computes, 1, `${malformedCase.label} must be a cache miss`);
      assert.deepEqual(recovered.rows[0]?.topActivities, [{
        kind: "google_docs",
        domain: "docs.google.com",
        seconds: 30,
        visits: 1,
      }]);
      assert.doesNotMatch(
        JSON.stringify(recovered),
        /private-document-id|student-secret|document\/d|https:\/\//i
      );
      assert.doesNotMatch(
        redis.get(valueKey) || "",
        /private-document-id|student-secret|document\/d|https:\/\//i
      );
    }
  });

  it("does not retain a failed computation", async () => {
    const cache = createClasspilotStudentDataProvisionalCache(async () => undefined);
    let attempts = 0;
    await assert.rejects(cache.getOrCompute({
      binding: binding(),
      ttlSeconds: 60,
      compute: async () => {
        attempts += 1;
        throw new Error("heartbeat query failed");
      },
    }), /heartbeat query failed/);
    const recovered = await cache.getOrCompute({
      binding: binding(),
      ttlSeconds: 60,
      compute: async () => {
        attempts += 1;
        return computation();
      },
    });
    assert.equal(attempts, 2);
    assert.equal(recovered.rows.length, 1);
  });

  it("falls through immediately when Redis is unavailable", async () => {
    for (const command of [
      async () => undefined,
      async () => { throw new Error("redis unavailable"); },
    ]) {
      const cache = createClasspilotStudentDataProvisionalCache(command);
      const startedAt = Date.now();
      const value = await cache.getOrCompute({
        binding: binding({ contextHash: `unavailable-${startedAt}` }),
        ttlSeconds: 60,
        compute: async () => computation(),
      });
      assert.equal(value.rows.length, 1);
      assert.ok(
        Date.now() - startedAt < 250,
        "Redis absence is not distributed lock contention and must not add a one-second poll"
      );
    }
  });
});
