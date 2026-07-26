import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  collectBoundClasspilotTileAuthorizationPlanObservationEvidence,
  collectClasspilotTileAuthorizationPlanObservationEvidence,
  hashClasspilotTileAuthorizationPlanObservationEvents,
  runCli as runObservationCollectorCli,
} from "../scripts/collect-classpilot-tile-auth-plan-observation-evidence.mjs";

const collectorSource = readFileSync(
  new URL(
    "../scripts/collect-classpilot-tile-auth-plan-observation-evidence.mjs",
    import.meta.url
  ),
  "utf8"
);
const region = "us-east-1";
const accountId = "135775632425";
const taskId = "a".repeat(32);
const taskArn =
  `arn:aws:ecs:${region}:${accountId}:task/schoolpilot-production-cluster/${taskId}`;
const taskDefinitionArn =
  `arn:aws:ecs:${region}:${accountId}:task-definition/schoolpilot-production-api-emergency:36`;
const exactLogStream = `api/api/${taskId}`;
const logConfiguration = {
  logDriver: "awslogs",
  options: {
    "awslogs-group": "/ecs/schoolpilot-production-api",
    "awslogs-region": region,
    "awslogs-stream-prefix": "api",
  },
};

function terminalTaskResult(
  reportedLogStream: string | null | undefined = undefined
) {
  const api: Record<string, unknown> = {
    name: "api",
    lastStatus: "STOPPED",
    exitCode: 0,
  };
  if (arguments.length > 0) api.logStreamName = reportedLogStream;
  return {
    failures: [],
    tasks: [
      {
        taskArn,
        taskDefinitionArn,
        lastStatus: "STOPPED",
        containers: [api],
      },
    ],
  };
}

function collectorCliArguments(deadlineMs = 500) {
  return [
    "--task-result-file",
    "terminal-task.private.json",
    "--log-configuration-file",
    "log-configuration.private.json",
    "--expected-task-arn",
    taskArn,
    "--expected-task-definition-arn",
    taskDefinitionArn,
    "--expected-region",
    region,
    "--expected-account-id",
    accountId,
    "--deadline-ms",
    String(deadlineMs),
  ];
}

function event(message: unknown, timestamp = 1) {
  return {
    timestamp,
    ingestionTime: timestamp + 1,
    message: typeof message === "string" ? message : JSON.stringify(message),
  };
}

function validPreflight() {
  return {
    version: "classpilot-tile-auth-plan-base-preflight-v1",
    status: "passed",
    eligibleBases: 1,
    requiredSessionPairs: 80,
    reusedActiveSessionPairs: 0,
    missingSessionPairs: 80,
    conflictingSessionPairs: 0,
  };
}

function validSelection() {
  return {
    version: "classpilot-tile-auth-plan-base-selection-v1",
    cohortSize: 40,
    canonicalPrimaryOnlyGroups: 19,
    exactCohortGroups: 19,
    eligibleSchools: 1,
    finalBases: 1,
  };
}

function validFunnel() {
  return {
    version: "classpilot-tile-auth-plan-base-funnel-v1",
    failureStage: "base_funnel",
    firstEmptyStage: "noCoTeacherGroups",
    cohortSize: 40,
    counts: {
      syntheticDescribedGroups: 20,
      syntheticSchoolGroups: 20,
      primaryTeacherGroups: 20,
      licensedGroups: 20,
      activeRosterStudents: 800,
      canonicalMappedRosterStudents: 800,
      unsupervisedRosterStudents: 800,
      noCoTeacherGroups: 0,
      exactCohortGroups: 0,
      eligibleGroupSchools: 0,
      activeOfficeMemberships: 0,
      uniqueOfficeMembershipSchools: 0,
      activeOfficeStudents: 0,
      canonicalMappedOfficeStudents: 0,
      unrosteredOfficeStudents: 0,
      unsupervisedOfficeStudents: 0,
      officeCohortReadySchools: 0,
      alternateTeacherReadySchools: 0,
      eligibleSchools: 0,
      selectedSchools: 0,
      selectedGroups: 0,
      selectedCoTeachers: 0,
      selectedOfficeStaff: 0,
      selectedOfficeCohorts: 0,
      finalBases: 0,
    },
    sessionPosture: null,
  };
}

function failureWithFunnel() {
  return {
    status: "failed",
    failureCode: "representative_scenario_missing",
    labels: [],
    invalidTeachingSessionSchools: 0,
    funnelEvidence: validFunnel(),
  };
}

function fakeClock() {
  let now = 0n;
  const delays: number[] = [];
  return {
    nowNanoseconds: () => now,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
      now += BigInt(delayMs) * 1_000_000n;
    },
    advance: (milliseconds: number) => {
      now += BigInt(milliseconds) * 1_000_000n;
    },
    delays,
  };
}

describe("ClassPilot tile authorization observation collector", () => {
  it("disables implicit AWS pagination before consuming explicit tokens", () => {
    const pageReader = collectorSource.slice(
      collectorSource.indexOf("function fetchAwsPage("),
      collectorSource.indexOf("\nexport async function", collectorSource.indexOf("function fetchAwsPage("))
    );
    assert.match(pageReader, /"--no-paginate"/);
    assert.match(pageReader, /args\.push\("--next-token", nextToken\)/);
  });

  it("retries fresh snapshots on the 0/1/2/4/5-second cadence", async () => {
    const clock = fakeClock();
    const snapshots = [
      { events: [] },
      { events: [event(validPreflight()), event(validSelection(), 3)] },
    ];
    let calls = 0;
    const result =
      await collectClasspilotTileAuthorizationPlanObservationEvidence({
        taskExitCode: 0,
        deadlineMs: 300_000,
        nowNanoseconds: clock.nowNanoseconds,
        sleep: clock.sleep,
        fetchFreshSnapshot: async () => snapshots[calls++] ?? snapshots[1],
      });

    assert.equal(result.collection.status, "completed");
    assert.equal(result.collection.attemptCount, 2);
    assert.deepEqual(clock.delays, [1_000]);
    assert.equal(result.collection.failureCode, null);
    assert.equal(result.collection.rawErrorPersisted, false);
    assert.deepEqual(result.eventsDocument, snapshots[1]);
  });

  it("accepts one exact exit-one funnel and one allowlisted task failure", async () => {
    const ineligibleEvents = { events: [event(failureWithFunnel())] };
    const ineligible =
      await collectClasspilotTileAuthorizationPlanObservationEvidence({
        taskExitCode: 1,
        fetchFreshSnapshot: async () => ineligibleEvents,
      });
    assert.equal(ineligible.collection.status, "completed");
    assert.deepEqual(ineligible.eventsDocument, ineligibleEvents);

    const taskFailureEvents = {
      events: [
        event({
          status: "failed",
          failureCode: "database_operation_failed",
        }),
      ],
    };
    for (const taskExitCode of [2, 137]) {
      const taskFailure =
        await collectClasspilotTileAuthorizationPlanObservationEvidence({
          taskExitCode,
          fetchFreshSnapshot: async () => taskFailureEvents,
        });
      assert.equal(taskFailure.collection.status, "completed");
      assert.deepEqual(taskFailure.eventsDocument, taskFailureEvents);
    }
  });

  it("never merges partial snapshots across attempts", async () => {
    const clock = fakeClock();
    const snapshots = [
      { events: [event(validPreflight())] },
      { events: [event(validSelection())] },
    ];
    let calls = 0;
    const result =
      await collectClasspilotTileAuthorizationPlanObservationEvidence({
        taskExitCode: 0,
        deadlineMs: 7_500,
        nowNanoseconds: clock.nowNanoseconds,
        sleep: clock.sleep,
        fetchFreshSnapshot: async () => {
          const snapshot = snapshots[calls % snapshots.length];
          calls += 1;
          return snapshot;
        },
      });

    assert.equal(result.collection.status, "failed");
    assert.equal(result.collection.failureCode, "log_evidence_unavailable");
    assert.equal(result.collection.rawErrorPersisted, false);
    assert.equal(result.eventsDocument, null);
    assert.deepEqual(clock.delays, [1_000, 2_000, 4_000]);
    assert.equal(result.collection.attemptCount, 4);
  });

  it("does not persist provider or validator errors at deadline", async () => {
    const clock = fakeClock();
    const result =
      await collectClasspilotTileAuthorizationPlanObservationEvidence({
        taskExitCode: 0,
        deadlineMs: 3_500,
        nowNanoseconds: clock.nowNanoseconds,
        sleep: clock.sleep,
        fetchFreshSnapshot: async ({ attemptCount }) => {
          clock.advance(100);
          throw new Error(`sensitive-provider-error-${attemptCount}`);
        },
      });

    assert.deepEqual(result.collection, {
      status: "failed",
      attemptCount: 3,
      completedAtUtc: result.collection.completedAtUtc,
      failureCode: "log_evidence_unavailable",
      canonicalEventSha256: null,
      logStreamSha256: null,
      rawErrorPersisted: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /sensitive-provider-error/);
  });

  it("resolves null, omitted, and exact streams before the first read", async () => {
    for (const taskResult of [
      terminalTaskResult(),
      terminalTaskResult(null),
      terminalTaskResult(exactLogStream),
    ]) {
      const clock = fakeClock();
      clock.advance(2_500);
      let reads = 0;
      let observedDeadline = 0n;
      const result =
        await collectBoundClasspilotTileAuthorizationPlanObservationEvidence({
          taskResult,
          logConfiguration,
          expectedTaskArn: taskArn,
          expectedTaskDefinitionArn: taskDefinitionArn,
          expectedRegion: region,
          expectedAccountId: accountId,
          deadlineMs: 500,
          nowNanoseconds: clock.nowNanoseconds,
          sleep: clock.sleep,
          freshSnapshotFetcherFactory: (binding, deadlineNanoseconds) => {
            assert.deepEqual(binding, {
              logGroupName: "/ecs/schoolpilot-production-api",
              logStreamName: exactLogStream,
              region,
            });
            observedDeadline = deadlineNanoseconds;
            return async () => {
              reads += 1;
              return {
                events: [
                  event(validPreflight()),
                  event(validSelection(), 3),
                ],
              };
            };
          },
        });

      assert.equal(observedDeadline, 3_000_000_000n);
      assert.equal(reads, 1);
      assert.equal(result.collection.status, "completed");
      assert.equal(result.collection.attemptCount, 1);
      assert.equal(
        result.collection.logStreamSha256,
        createHash("sha256").update(exactLogStream, "utf8").digest("hex")
      );
      assert.equal(result.binding?.logStream, exactLogStream);
    }
  });

  it("does not count a deadline crossing as a CloudWatch attempt", async () => {
    const points = [0n, 0n, 500_000_000n];
    let last = points[0];
    let reads = 0;
    const result =
      await collectBoundClasspilotTileAuthorizationPlanObservationEvidence({
        taskResult: terminalTaskResult(),
        logConfiguration,
        expectedTaskArn: taskArn,
        expectedTaskDefinitionArn: taskDefinitionArn,
        expectedRegion: region,
        expectedAccountId: accountId,
        deadlineMs: 500,
        nowNanoseconds: () => {
          last = points.shift() ?? last;
          return last;
        },
        sleep: async () => undefined,
        freshSnapshotFetcherFactory: () => async () => {
          reads += 1;
          return { events: [] };
        },
      });

    assert.equal(reads, 0);
    assert.deepEqual(result.collection, {
      status: "failed",
      attemptCount: 0,
      completedAtUtc: result.collection.completedAtUtc,
      failureCode: "collector_start_unavailable",
      canonicalEventSha256: null,
      logStreamSha256: null,
      rawErrorPersisted: false,
    });
    assert.equal(result.eventsDocument, null);
  });

  it("latches the CLI deadline before delayed parsing and file reads", async () => {
    const clock = fakeClock();
    let clockLatched = false;
    let parseDelayApplied = false;
    let reads = 0;
    const rawArguments = collectorCliArguments();
    const delayedArguments = new Proxy(rawArguments, {
      get(target, property, receiver) {
        assert.equal(
          clockLatched,
          true,
          "runCli must latch its monotonic start before reading argv"
        );
        if (!parseDelayApplied) {
          parseDelayApplied = true;
          clock.advance(100);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await runObservationCollectorCli(delayedArguments, {
      nowNanoseconds: () => {
        clockLatched = true;
        return clock.nowNanoseconds();
      },
      sleep: clock.sleep,
      readFile: (filePath: string) => {
        clock.advance(200);
        if (filePath === "terminal-task.private.json") {
          return JSON.stringify(terminalTaskResult());
        }
        if (filePath === "log-configuration.private.json") {
          return JSON.stringify(logConfiguration);
        }
        throw new Error("unexpected_file");
      },
      freshSnapshotFetcherFactory: () => async () => {
        reads += 1;
        return { events: [] };
      },
    });

    assert.equal(parseDelayApplied, true);
    assert.equal(reads, 0);
    assert.deepEqual(result.collection, {
      status: "failed",
      attemptCount: 0,
      completedAtUtc: result.collection.completedAtUtc,
      failureCode: "collector_start_unavailable",
      canonicalEventSha256: null,
      logStreamSha256: null,
      rawErrorPersisted: false,
    });
    assert.equal(result.eventsDocument, null);
  });

  it("fails binding with zero reads and never imports an absolute deadline", async () => {
    for (const taskResult of [
      terminalTaskResult("api/api/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      terminalTaskResult(123 as unknown as string),
      {
        ...terminalTaskResult(),
        tasks: [
          {
            ...terminalTaskResult().tasks[0],
            taskDefinitionArn:
              "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:999",
          },
        ],
      },
    ]) {
      let factoryCalls = 0;
      const result =
        await collectBoundClasspilotTileAuthorizationPlanObservationEvidence({
          taskResult,
          logConfiguration,
          expectedTaskArn: taskArn,
          expectedTaskDefinitionArn: taskDefinitionArn,
          expectedRegion: region,
          expectedAccountId: accountId,
          freshSnapshotFetcherFactory: () => {
            factoryCalls += 1;
            return async () => ({ events: [] });
          },
        });
      assert.equal(factoryCalls, 0);
      assert.equal(result.binding, null);
      assert.deepEqual(result.collection, {
        status: "failed",
        attemptCount: 0,
        completedAtUtc: result.collection.completedAtUtc,
        failureCode: "log_binding_unavailable",
        canonicalEventSha256: null,
        logStreamSha256: null,
        rawErrorPersisted: false,
      });
      assert.equal(result.eventsDocument, null);
    }

    assert.doesNotMatch(collectorSource, /--deadline-monotonic-nanoseconds/);
    assert.doesNotMatch(collectorSource, /deadlineNanoseconds\s*=\s*null/);
    assert.doesNotMatch(
      collectorSource,
      /^import\s+\{[\s\S]*?resolveClasspilotTileAuthorizationPlanLogBinding[\s\S]*?from\s+"\.\/resolve-classpilot-tile-auth-plan-log-binding\.mjs";/m
    );
    assert.match(
      collectorSource,
      /await import\(\s*"\.\/resolve-classpilot-tile-auth-plan-log-binding\.mjs"\s*\)/
    );
    assert.match(
      collectorSource,
      /collectBoundClasspilotTileAuthorizationPlanObservationEvidence[\s\S]*nowNanoseconds\(\) \+ BigInt\(deadlineMs\)/
    );
  });

  it("hashes the complete snapshot with recursive key sorting", () => {
    const left = {
      events: [
        {
          message: "one",
          ingestionTime: 2,
          timestamp: 1,
          nested: { z: 2, a: 1 },
        },
      ],
    };
    const right = {
      events: [
        {
          nested: { a: 1, z: 2 },
          timestamp: 1,
          message: "one",
          ingestionTime: 2,
        },
      ],
    };
    const expected = createHash("sha256")
      .update(
        '{"events":[{"ingestionTime":2,"message":"one","nested":{"a":1,"z":2},"timestamp":1}]}',
        "utf8"
      )
      .digest("hex");
    assert.equal(
      hashClasspilotTileAuthorizationPlanObservationEvents(left),
      expected
    );
    assert.equal(
      hashClasspilotTileAuthorizationPlanObservationEvents(right),
      expected
    );
  });
});
