import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildClasspilotTileAuthorizationPlanObservationAttempt,
  buildClasspilotTileAuthorizationPlanObservation,
  canonicalObservationEventsSha256,
  inspectClasspilotTileAuthorizationPlanObservation,
  inspectClasspilotTileAuthorizationPlanObservationAttempt,
  LEGACY_OBSERVATION_VERSION,
  OBSERVATION_ATTEMPT_FILENAME,
  OBSERVATION_ATTEMPT_VERSION,
  OBSERVATION_FUNNEL_FILENAME,
  OBSERVATION_PACKET_FILENAME,
  OBSERVATION_PREFLIGHT_FILENAME,
  OBSERVATION_SELECTION_FILENAME,
  OBSERVATION_VERSION,
  runCli as runObservationCli,
  validateClasspilotTileAuthorizationPlanObservation,
  writeClasspilotTileAuthorizationPlanObservationAttempt,
  writeClasspilotTileAuthorizationPlanObservation,
} from "../scripts/manage-classpilot-tile-auth-plan-observation.mjs";
import {
  validateClasspilotTileAuthorizationPlanRehearsalReceipt,
} from "../scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs";

const previousEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  CLP_LOAD_FIXTURE_TEST_MODE: process.env.CLP_LOAD_FIXTURE_TEST_MODE,
  CLP_LOAD_GATES_TEST_ROOT: process.env.CLP_LOAD_GATES_TEST_ROOT,
};
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function events(...messages: unknown[]) {
  return {
    events: messages.map((message) => ({
      message: typeof message === "string" ? message : JSON.stringify(message),
    })),
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
    firstEmptyStage: "syntheticDescribedGroups",
    cohortSize: 40,
    counts: {
      syntheticDescribedGroups: 0,
      syntheticSchoolGroups: 0,
      primaryTeacherGroups: 0,
      licensedGroups: 0,
      activeRosterStudents: 0,
      canonicalMappedRosterStudents: 0,
      unsupervisedRosterStudents: 0,
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

function failedEvent() {
  return {
    status: "failed",
    failureCode: "representative_scenario_missing",
    labels: [],
    invalidTeachingSessionSchools: 0,
    funnelEvidence: validFunnel(),
  };
}

function testRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-tile-observation-"));
  temporaryRoots.push(root);
  process.env.NODE_ENV = "test";
  process.env.CLP_LOAD_FIXTURE_TEST_MODE = "1";
  process.env.CLP_LOAD_GATES_TEST_ROOT = root;
  return root;
}

function identity() {
  return {
    observationId: "tile-auth-observation-20260725t150000z",
    applicationGitSha: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    candidateApiTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:35",
    candidateWorkerTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:50",
    activeApiTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:31",
    activeWorkerTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:48",
    initialNetworkConfigurationSha256: "c".repeat(64),
    initialProductionPostureSha256: "d".repeat(64),
  };
}

function verified(hash: string) {
  return { status: "verified", sha256: hash, failureCode: null };
}

function completedCollection(eventsDocument: ReturnType<typeof events>) {
  return {
    status: "completed",
    attemptCount: 3,
    completedAtUtc: "2026-07-25T15:00:05.000Z",
    failureCode: null,
    canonicalEventSha256:
      canonicalObservationEventsSha256(eventsDocument),
    logStreamSha256: "e".repeat(64),
    rawErrorPersisted: false,
  };
}

function terminalEvidence(
  exitCode: number,
  eventsDocument: ReturnType<typeof events>
) {
  return {
    createdAtUtc: "2026-07-25T15:00:10.000Z",
    terminalTask: {
      state: "exited",
      taskArn:
        `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/${"f".repeat(32)}`,
      exitCode,
    },
    collection: completedCollection(eventsDocument),
    finalNetwork: verified("c".repeat(64)),
    finalProductionPosture: verified("d".repeat(64)),
    eventsDocument,
  };
}

function eligibleEvidence() {
  const document = events("startup", validSelection(), validPreflight());
  return terminalEvidence(0, document);
}

function ineligibleEvidence() {
  return terminalEvidence(1, events("startup", failedEvent()));
}

function evidenceValues(packet: {
  preflightEvidenceFile: string | null;
  funnelEvidenceFile: string | null;
}) {
  if (packet.preflightEvidenceFile !== null) {
    return {
      preflight: validPreflight(),
      selection: validSelection(),
    };
  }
  if (packet.funnelEvidenceFile !== null) return { funnel: validFunnel() };
  return {};
}

function seal(terminal = eligibleEvidence()) {
  const root = testRoot();
  const options = identity();
  const runRoot = path.join(
    root,
    "observations",
    options.observationId
  );
  const attempt =
    buildClasspilotTileAuthorizationPlanObservationAttempt({
      ...options,
      createdAtUtc: "2026-07-25T14:59:59.000Z",
    });
  const admitted =
    writeClasspilotTileAuthorizationPlanObservationAttempt(
      runRoot,
      attempt
    );
  const packet = buildClasspilotTileAuthorizationPlanObservation({
    ...options,
    attemptRecordSha256: admitted.sha256,
    terminalEvidence: terminal,
  });
  const written = writeClasspilotTileAuthorizationPlanObservation(
    path.join(runRoot, "terminal"),
    packet,
    evidenceValues(packet)
  );
  const expected = {
    ...options,
    expectedAttemptRecordSha256: admitted.sha256,
    expectedPacketSha256: written.sha256,
  };
  return {
    root,
    options,
    terminal,
    attempt,
    admitted,
    packet,
    written,
    expected,
  };
}

describe("ClassPilot tile authorization plan observation v2", () => {
  it("durably admits the immutable attempt before terminal evidence", () => {
    const sealed = seal();
    assert.equal(sealed.attempt.version, OBSERVATION_ATTEMPT_VERSION);
    assert.equal(sealed.attempt.status, "admitted");
    assert.equal(sealed.attempt.rawErrorPersisted, false);
    assert.equal(sealed.packet.attemptRecordSha256, sealed.admitted.sha256);
    assert.equal(
      path.basename(sealed.admitted.path),
      OBSERVATION_ATTEMPT_FILENAME
    );
    assert.throws(
      () =>
        writeClasspilotTileAuthorizationPlanObservationAttempt(
          path.dirname(path.dirname(sealed.admitted.path)),
          sealed.attempt
        ),
      /classpilot_tile_auth_plan_observation_attempt_already_exists/
    );
    fs.mkdirSync(path.join(path.dirname(sealed.admitted.path), "unexpected"));
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservationAttempt(
        sealed.admitted.path,
        sealed.expected
      )
    );
  });

  it("seals eligible preflight and selection evidence as one atomic group", () => {
    const { root, packet, written, expected } = seal();
    assert.equal(packet.schemaVersion, 2);
    assert.equal(packet.version, OBSERVATION_VERSION);
    assert.equal(packet.observationOutcome, "base_eligible");
    assert.equal(packet.terminalTask.exitCode, 0);
    assert.equal(packet.collection.status, "completed");
    assert.equal(packet.collection.rawErrorPersisted, false);
    assert.equal(packet.preflightEvidenceFile, OBSERVATION_PREFLIGHT_FILENAME);
    assert.equal(packet.selectionEvidenceFile, OBSERVATION_SELECTION_FILENAME);
    assert.equal(packet.funnelEvidenceFile, null);
    assert.deepEqual(
      fs.readdirSync(path.dirname(written.path)).sort(),
      [
        OBSERVATION_PACKET_FILENAME,
        OBSERVATION_PREFLIGHT_FILENAME,
        OBSERVATION_SELECTION_FILENAME,
      ].sort()
    );
    assert.equal(
      fs.existsSync(
        path.join(root, "tile-auth-rehearsals", packet.applicationGitSha)
      ),
      false
    );
    const inspected = inspectClasspilotTileAuthorizationPlanObservation(
      written.path,
      expected
    );
    assert.equal(inspected.observationOutcome, "base_eligible");
    assert.equal(inspected.eligibleForDeployment, false);
    assert.equal(inspected.eligibleForDiagnostic, false);
    assert.equal(inspected.eligibleForCertification, false);
    fs.mkdirSync(path.join(path.dirname(written.path), "unexpected"));
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservation(
        written.path,
        expected
      )
    );
  });

  it("seals a representative-scenario exit as base-ineligible funnel evidence", () => {
    const sealed = seal(ineligibleEvidence());
    assert.equal(sealed.packet.observationOutcome, "base_ineligible");
    assert.equal(sealed.packet.preflightEvidenceFile, null);
    assert.equal(sealed.packet.selectionEvidenceFile, null);
    assert.equal(
      sealed.packet.funnelEvidenceFile,
      OBSERVATION_FUNNEL_FILENAME
    );
    assert.equal(
      inspectClasspilotTileAuthorizationPlanObservation(
        sealed.written.path,
        sealed.expected
      ).observationOutcome,
      "base_ineligible"
    );
  });

  it("preserves non-funnel exits as terminal task failures", () => {
    for (const exitCode of [1, 2, 137]) {
      const terminal =
        exitCode === 1
          ? terminalEvidence(
              exitCode,
              events({
                status: "failed",
                failureCode: "history_plan_invalid",
              })
            )
          : terminalEvidence(exitCode, events({ status: "failed" }));
      const { packet } = seal(terminal);
      assert.equal(packet.observationOutcome, "task_failed");
      assert.equal(packet.terminalTask.exitCode, exitCode);
      assert.equal(packet.preflightEvidenceFile, null);
      assert.equal(packet.funnelEvidenceFile, null);
    }
  });

  it("seals unavailable collection without requiring a terminal task", () => {
    const terminal = {
      createdAtUtc: "2026-07-25T15:00:10.000Z",
      terminalTask: null,
      collection: {
        status: "failed",
        attemptCount: 0,
        completedAtUtc: "2026-07-25T15:05:00.000Z",
        failureCode: "terminal_task_unavailable",
        canonicalEventSha256: null,
        logStreamSha256: null,
        rawErrorPersisted: false,
      },
      finalNetwork: {
        status: "failed",
        sha256: null,
        failureCode: "network_unavailable",
      },
      finalProductionPosture: {
        status: "failed",
        sha256: null,
        failureCode: "production_posture_unavailable",
      },
      eventsDocument: null,
    };
    const sealed = seal(terminal);
    assert.equal(sealed.packet.observationOutcome, "evidence_unavailable");
    assert.equal(sealed.packet.terminalTask, null);
    assert.equal(sealed.packet.collection.rawErrorPersisted, false);
    assert.equal(
      inspectClasspilotTileAuthorizationPlanObservation(
        sealed.written.path,
        sealed.expected
      ).observationOutcome,
      "evidence_unavailable"
    );
  });

  it("retains a launched task ARN when its exit remains unavailable", () => {
    const terminal = {
      createdAtUtc: "2026-07-25T15:00:10.000Z",
      terminalTask: {
        state: "exit_unavailable",
        taskArn:
          `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/${"f".repeat(32)}`,
        exitCode: null,
      },
      collection: {
        status: "failed",
        attemptCount: 0,
        completedAtUtc: "2026-07-25T15:05:00.000Z",
        failureCode: "terminal_task_timeout",
        canonicalEventSha256: null,
        logStreamSha256: null,
        rawErrorPersisted: false,
      },
      finalNetwork: verified("c".repeat(64)),
      finalProductionPosture: verified("d".repeat(64)),
      eventsDocument: null,
    };
    const sealed = seal(terminal);
    assert.equal(sealed.packet.observationOutcome, "evidence_unavailable");
    assert.equal(sealed.packet.terminalTask.state, "exit_unavailable");
    assert.equal(sealed.packet.terminalTask.exitCode, null);
    assert.match(sealed.packet.terminalTask.taskArn, /^arn:aws:ecs:/);
  });

  it("retains a known terminal exit even when the controller deadline was exceeded", () => {
    const terminal = {
      createdAtUtc: "2026-07-25T15:00:10.000Z",
      terminalTask: {
        state: "exited",
        taskArn:
          `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/${"f".repeat(32)}`,
        exitCode: 137,
      },
      collection: {
        status: "failed",
        attemptCount: 0,
        completedAtUtc: "2026-07-25T15:05:00.000Z",
        failureCode: "terminal_task_timeout",
        canonicalEventSha256: null,
        logStreamSha256: null,
        rawErrorPersisted: false,
      },
      finalNetwork: verified("c".repeat(64)),
      finalProductionPosture: verified("d".repeat(64)),
      eventsDocument: null,
    };
    const sealed = seal(terminal);
    assert.equal(sealed.packet.observationOutcome, "evidence_unavailable");
    assert.equal(sealed.packet.terminalTask.state, "exited");
    assert.equal(sealed.packet.terminalTask.exitCode, 137);
  });

  it("requires zero collection attempts before a log read can begin", () => {
    const unavailable: any = {
      createdAtUtc: "2026-07-25T15:00:10.000Z",
      terminalTask: null,
      collection: {
        status: "failed",
        attemptCount: 1,
        completedAtUtc: "2026-07-25T15:05:00.000Z",
        failureCode: "terminal_task_unavailable",
        canonicalEventSha256: null,
        logStreamSha256: null,
        rawErrorPersisted: false,
      },
      finalNetwork: verified("c".repeat(64)),
      finalProductionPosture: verified("d".repeat(64)),
      eventsDocument: null,
    };
    assert.throws(
      () =>
        buildClasspilotTileAuthorizationPlanObservation({
          ...identity(),
          attemptRecordSha256: "3".repeat(64),
          terminalEvidence: unavailable,
        }),
      /classpilot_tile_auth_plan_observation_invalid/
    );

    unavailable.collection.failureCode = "log_evidence_unavailable";
    unavailable.terminalTask = {
      state: "exited",
      taskArn:
        `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/${"f".repeat(32)}`,
      exitCode: 0,
    };
    assert.equal(
      seal(unavailable).packet.observationOutcome,
      "evidence_unavailable"
    );
  });

  it("canonically downgrades verified final-hash drift", () => {
    const terminal = eligibleEvidence();
    terminal.finalNetwork = verified("9".repeat(64));
    terminal.finalProductionPosture = verified("8".repeat(64));
    const sealed = seal(terminal);
    assert.equal(sealed.packet.observationOutcome, "evidence_unavailable");
    assert.deepEqual(sealed.packet.finalNetwork, {
      status: "failed",
      sha256: null,
      failureCode: "network_drift",
    });
    assert.deepEqual(sealed.packet.finalProductionPosture, {
      status: "failed",
      sha256: null,
      failureCode: "production_posture_drift",
    });
  });

  it("retains valid companions but rejects acceptance when final posture fails", () => {
    const terminal = eligibleEvidence();
    terminal.finalProductionPosture = {
      status: "failed",
      sha256: null,
      failureCode: "production_posture_drift",
    };
    const sealed = seal(terminal);
    assert.equal(sealed.packet.observationOutcome, "evidence_unavailable");
    assert.equal(
      sealed.packet.preflightEvidenceFile,
      OBSERVATION_PREFLIGHT_FILENAME
    );
    assert.equal(
      sealed.packet.selectionEvidenceFile,
      OBSERVATION_SELECTION_FILENAME
    );
  });

  it("rejects canonical event, failure-code, union, and identity tampering", () => {
    const terminal = eligibleEvidence();
    terminal.collection.canonicalEventSha256 = "0".repeat(64);
    assert.throws(
      () =>
        buildClasspilotTileAuthorizationPlanObservation({
          ...identity(),
          attemptRecordSha256: "3".repeat(64),
          terminalEvidence: terminal,
        }),
      /classpilot_tile_auth_plan_observation_invalid/
    );

    const { packet } = seal();
    const mutations = [
      { ...packet, eligibleForDeployment: true },
      { ...packet, attemptRecordFile: "unexpected-attempt.json" },
      { ...packet, observationOutcome: "task_failed" },
      {
        ...packet,
        collection: {
          ...packet.collection,
          failureCode: "provider_error",
        },
      },
      {
        ...packet,
        collection: {
          ...packet.collection,
          attemptCount: 0,
        },
      },
      {
        ...packet,
        finalNetwork: verified("9".repeat(64)),
      },
      {
        ...packet,
        finalNetwork: {
          status: "failed",
          sha256: null,
          failureCode: "unbounded_error",
        },
      },
      { ...packet, unexpected: false },
    ];
    for (const mutation of mutations) {
      assert.throws(() =>
        validateClasspilotTileAuthorizationPlanObservation(mutation)
      );
    }
  });

  it("rejects companion substitution, extra files, and expected-state drift", () => {
    const substituted = seal();
    fs.appendFileSync(
      path.join(
        path.dirname(substituted.written.path),
        OBSERVATION_SELECTION_FILENAME
      ),
      " "
    );
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservation(
        substituted.written.path,
        substituted.expected
      )
    );

    const extra = seal();
    fs.writeFileSync(
      path.join(path.dirname(extra.written.path), "unexpected.json"),
      "{}"
    );
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservation(
        extra.written.path,
        extra.expected
      )
    );

    const drift = seal();
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservation(
        drift.written.path,
        {
          ...drift.expected,
          initialProductionPostureSha256: "0".repeat(64),
        }
      )
    );
  });

  it("refuses to overwrite an existing atomic observation group", () => {
    const sealed = seal();
    assert.throws(
      () =>
        writeClasspilotTileAuthorizationPlanObservation(
          path.dirname(sealed.written.path),
          sealed.packet,
          evidenceValues(sealed.packet)
        ),
      /classpilot_tile_auth_plan_observation_already_exists/
    );
  });

  it("retains v1 packets as historical inspect-only evidence", async () => {
    const root = testRoot();
    const options = identity();
    const directory = path.join(root, "observations", options.observationId);
    fs.mkdirSync(directory, { recursive: true });
    const preflightPayload = `${JSON.stringify(validPreflight(), null, 2)}\n`;
    fs.writeFileSync(
      path.join(directory, OBSERVATION_PREFLIGHT_FILENAME),
      preflightPayload
    );
    const legacyPacket = {
      schemaVersion: 1,
      type: "classpilot_tile_auth_plan_observation",
      version: LEGACY_OBSERVATION_VERSION,
      status: "observed",
      observationId: options.observationId,
      observationOutcome: "base_eligible",
      applicationGitSha: options.applicationGitSha,
      imageDigest: options.imageDigest,
      candidateApiTaskDefinitionArn:
        options.candidateApiTaskDefinitionArn,
      candidateWorkerTaskDefinitionArn:
        options.candidateWorkerTaskDefinitionArn,
      activeBaseline: {
        apiTaskDefinitionArn: options.activeApiTaskDefinitionArn,
        workerTaskDefinitionArn: options.activeWorkerTaskDefinitionArn,
      },
      networkConfigurationSha256:
        options.initialNetworkConfigurationSha256,
      productionPostureSha256:
        options.initialProductionPostureSha256,
      terminalTask: {
        taskArn:
          `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/${"f".repeat(32)}`,
        exitCode: 0,
        logStreamSha256: "e".repeat(64),
      },
      preflightEvidenceFile: OBSERVATION_PREFLIGHT_FILENAME,
      preflightEvidenceSha256: sha256(preflightPayload),
      funnelEvidenceFile: null,
      funnelEvidenceSha256: null,
      eligibleForDeployment: false,
      eligibleForDiagnostic: false,
      eligibleForCertification: false,
      createdAtUtc: "2026-07-25T15:00:10.000Z",
    };
    const packetPath = path.join(directory, OBSERVATION_PACKET_FILENAME);
    fs.writeFileSync(
      packetPath,
      `${JSON.stringify(legacyPacket, null, 2)}\n`
    );
    const result = inspectClasspilotTileAuthorizationPlanObservation(
      packetPath,
      {
        ...options,
        expectedPacketSha256: sha256(fs.readFileSync(packetPath)),
      }
    );
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.version, LEGACY_OBSERVATION_VERSION);
    assert.equal(result.eligibleForDeployment, false);
    const cliResult = await runObservationCli([
      "inspect",
      "--packet",
      packetPath,
      "--expected-packet-sha256",
      sha256(fs.readFileSync(packetPath)),
      "--observation-id",
      options.observationId,
      "--application-sha",
      options.applicationGitSha,
      "--image-digest",
      options.imageDigest,
      "--candidate-api-task-definition-arn",
      options.candidateApiTaskDefinitionArn,
      "--candidate-worker-task-definition-arn",
      options.candidateWorkerTaskDefinitionArn,
      "--active-api-task-definition-arn",
      options.activeApiTaskDefinitionArn,
      "--active-worker-task-definition-arn",
      options.activeWorkerTaskDefinitionArn,
      "--initial-network-configuration-sha256",
      options.initialNetworkConfigurationSha256,
      "--initial-production-posture-sha256",
      options.initialProductionPostureSha256,
    ]);
    assert.equal(cliResult.version, LEGACY_OBSERVATION_VERSION);
  });

  it("cannot be consumed as rehearsal, diagnostic, or certification admission", () => {
    const { packet } = seal();
    assert.throws(() =>
      validateClasspilotTileAuthorizationPlanRehearsalReceipt(packet, {
        expectedApplicationGitSha: packet.applicationGitSha,
        expectedActiveApiTaskDefinitionArn:
          packet.activeBaseline.apiTaskDefinitionArn,
        expectedActiveWorkerTaskDefinitionArn:
          packet.activeBaseline.workerTaskDefinitionArn,
        expectedNetworkConfigurationSha256:
          packet.initialNetworkConfigurationSha256,
        nowUtc: packet.createdAtUtc,
      })
    );
    assert.notEqual(packet.type, "fixture_preparation_receipt");
    assert.equal(Object.hasOwn(packet, "diagnosticEligible"), false);
    assert.equal(packet.eligibleForDeployment, false);
    assert.equal(packet.eligibleForDiagnostic, false);
    assert.equal(packet.eligibleForCertification, false);
  });
});
