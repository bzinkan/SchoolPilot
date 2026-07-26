import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  collectClasspilotTileAuthorizationPlanObservationEvidence,
  hashClasspilotTileAuthorizationPlanObservationEvents,
} from "../scripts/collect-classpilot-tile-auth-plan-observation-evidence.mjs";

const collectorSource = readFileSync(
  new URL(
    "../scripts/collect-classpilot-tile-auth-plan-observation-evidence.mjs",
    import.meta.url
  ),
  "utf8"
);

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

  it("honors an absolute monotonic deadline that began before log binding", async () => {
    const clock = fakeClock();
    clock.advance(2_500);
    const result =
      await collectClasspilotTileAuthorizationPlanObservationEvidence({
        taskExitCode: 0,
        deadlineMs: 300_000,
        deadlineNanoseconds: 3_000_000_000n,
        nowNanoseconds: clock.nowNanoseconds,
        sleep: clock.sleep,
        fetchFreshSnapshot: async () => {
          throw new Error("unavailable");
        },
      });

    assert.equal(result.collection.status, "failed");
    assert.equal(result.collection.attemptCount, 1);
    assert.deepEqual(clock.delays, []);
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
