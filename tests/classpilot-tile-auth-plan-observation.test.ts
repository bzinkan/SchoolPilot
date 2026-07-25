import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildClasspilotTileAuthorizationPlanObservation,
  inspectClasspilotTileAuthorizationPlanObservation,
  OBSERVATION_FUNNEL_FILENAME,
  OBSERVATION_PACKET_FILENAME,
  OBSERVATION_PREFLIGHT_FILENAME,
  validateClasspilotTileAuthorizationPlanObservation,
  writeClasspilotTileAuthorizationPlanObservation,
} from "../scripts/manage-classpilot-tile-auth-plan-observation.mjs";
import {
  validateClasspilotTileAuthorizationPlanRehearsalReceipt,
} from "../scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs";

const diagnosticBinderSource = fs.readFileSync(
  new URL("../scripts/load/bind-fresh-diagnostic.ps1", import.meta.url),
  "utf8"
);
const certificationSupervisorSource = fs.readFileSync(
  new URL("../scripts/load/start-aws-rollout-supervisor.ps1", import.meta.url),
  "utf8"
);

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

function fixture(exitCode = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-tile-observation-"));
  temporaryRoots.push(root);
  process.env.NODE_ENV = "test";
  process.env.CLP_LOAD_FIXTURE_TEST_MODE = "1";
  process.env.CLP_LOAD_GATES_TEST_ROOT = root;
  const options = {
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
    networkConfigurationSha256: "c".repeat(64),
    productionPostureSha256: "d".repeat(64),
    terminalTaskArn:
      `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production/${"e".repeat(32)}`,
    terminalTaskExitCode: exitCode,
    terminalLogStreamSha256: "f".repeat(64),
    eventsDocument:
      exitCode === 0
        ? events("startup noise", validPreflight())
        : events("startup noise", {
            status: "failed",
            failureCode: "representative_scenario_missing",
            labels: [],
            invalidTeachingSessionSchools: 0,
            funnelEvidence: validFunnel(),
          }),
    createdAtUtc: "2026-07-25T15:00:00.000Z",
  };
  const expected = {
    expectedPacketSha256: "",
    ...Object.fromEntries(
      Object.entries(options).filter(
        ([key]) => !["eventsDocument", "createdAtUtc"].includes(key)
      )
    ),
  };
  return { root, options, expected };
}

function sealFixture(exitCode = 1) {
  const { root, options, expected } = fixture(exitCode);
  const packet = buildClasspilotTileAuthorizationPlanObservation(options);
  const evidence = exitCode === 0 ? validPreflight() : validFunnel();
  const written = writeClasspilotTileAuthorizationPlanObservation(
    path.join(root, "observations", options.observationId),
    packet,
    evidence
  );
  expected.expectedPacketSha256 = written.sha256;
  return { root, options, expected, packet, written };
}

describe("ClassPilot tile authorization plan observation admission", () => {
  it("seals a successful preflight as non-consuming, ineligible evidence", () => {
    const { root, expected, packet, written } = sealFixture(0);
    assert.equal(packet.observationOutcome, "base_eligible");
    assert.equal(packet.terminalTask.exitCode, 0);
    assert.equal(packet.preflightEvidenceFile, OBSERVATION_PREFLIGHT_FILENAME);
    assert.match(packet.preflightEvidenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(packet.funnelEvidenceFile, null);
    assert.equal(packet.funnelEvidenceSha256, null);
    assert.equal(packet.eligibleForDeployment, false);
    assert.equal(packet.eligibleForDiagnostic, false);
    assert.equal(packet.eligibleForCertification, false);
    assert.equal(
      fs.existsSync(path.join(path.dirname(written.path), OBSERVATION_PACKET_FILENAME)),
      true
    );
    assert.equal(
      fs.existsSync(path.join(path.dirname(written.path), OBSERVATION_PREFLIGHT_FILENAME)),
      true
    );
    assert.equal(
      fs.existsSync(
        path.join(root, "tile-auth-rehearsals", packet.applicationGitSha)
      ),
      false,
      "observation must not create rehearsal admission state"
    );
    const inspected = inspectClasspilotTileAuthorizationPlanObservation(
      written.path,
      expected
    );
    assert.equal(inspected.observationOutcome, "base_eligible");
    assert.equal(inspected.eligibleForDeployment, false);
  });

  it("seals the expected base-ineligible exit as sanitized funnel evidence", () => {
    const { packet, written, expected } = sealFixture(1);
    assert.equal(packet.observationOutcome, "base_ineligible");
    assert.equal(packet.preflightEvidenceFile, null);
    assert.equal(packet.preflightEvidenceSha256, null);
    assert.equal(packet.funnelEvidenceFile, OBSERVATION_FUNNEL_FILENAME);
    assert.match(packet.funnelEvidenceSha256, /^[a-f0-9]{64}$/);
    const storedFunnel = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(written.path), OBSERVATION_FUNNEL_FILENAME),
        "utf8"
      )
    );
    assert.deepEqual(storedFunnel, validFunnel());
    assert.doesNotMatch(
      JSON.stringify(storedFunnel),
      /@|fixture-[a-z0-9]|arn:aws|select\s|insert\s/i
    );
    assert.equal(
      inspectClasspilotTileAuthorizationPlanObservation(
        written.path,
        expected
      ).observationOutcome,
      "base_ineligible"
    );
  });

  it("rejects fatal or signal-like task exits even when funnel evidence is present", () => {
    for (const exitCode of [2, 137, 143, 255]) {
      const { options } = fixture(exitCode);
      assert.throws(
        () => buildClasspilotTileAuthorizationPlanObservation(options),
        /classpilot_tile_auth_plan_observation_invalid/
      );
    }
  });

  it("rejects eligibility, tagged-union, terminal, and identity tampering", () => {
    const { packet } = sealFixture(1);
    const mutations = [
      { ...packet, eligibleForDeployment: true },
      { ...packet, eligibleForDiagnostic: true },
      { ...packet, eligibleForCertification: true },
      {
        ...packet,
        preflightEvidenceFile: OBSERVATION_PREFLIGHT_FILENAME,
        preflightEvidenceSha256: "1".repeat(64),
      },
      {
        ...packet,
        terminalTask: { ...packet.terminalTask, exitCode: 0 },
      },
      { ...packet, unexpected: false },
    ];
    for (const mutation of mutations) {
      assert.throws(() =>
        validateClasspilotTileAuthorizationPlanObservation(mutation)
      );
    }
  });

  it("rejects companion substitution and expected-state drift", () => {
    const { written, expected } = sealFixture(1);
    const companionPath = path.join(
      path.dirname(written.path),
      OBSERVATION_FUNNEL_FILENAME
    );
    fs.appendFileSync(companionPath, " ");
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservation(written.path, expected)
    );

    const clean = sealFixture(0);
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservation(clean.written.path, {
        ...clean.expected,
        productionPostureSha256: "0".repeat(64),
      })
    );
  });

  it("cannot be inspected or consumed as a rehearsal receipt", () => {
    const { packet } = sealFixture(0);
    assert.throws(() =>
      validateClasspilotTileAuthorizationPlanRehearsalReceipt(packet, {
        expectedApplicationGitSha: packet.applicationGitSha,
        expectedActiveApiTaskDefinitionArn:
          packet.activeBaseline.apiTaskDefinitionArn,
        expectedActiveWorkerTaskDefinitionArn:
          packet.activeBaseline.workerTaskDefinitionArn,
        expectedNetworkConfigurationSha256:
          packet.networkConfigurationSha256,
        nowUtc: packet.createdAtUtc,
      })
    );
  });

  it("cannot satisfy diagnostic or certification preparation admission", () => {
    const { packet } = sealFixture(0);
    assert.notEqual(packet.type, "fixture_preparation_receipt");
    assert.notEqual(packet.version, "fixture-preparation-receipt-v1");
    assert.equal(Object.hasOwn(packet, "diagnosticEligible"), false);
    assert.match(
      diagnosticBinderSource,
      /type' ''\) -cne 'fixture_preparation_receipt'/
    );
    assert.match(
      diagnosticBinderSource,
      /\$script:ReceiptVersion = 'fixture-preparation-receipt-v1'/
    );
    assert.match(
      certificationSupervisorSource,
      /type" ""\) -cne "fixture_preparation_receipt"/
    );
    assert.match(
      certificationSupervisorSource,
      /fixturePreparation must bind an eligible repository-owned preparation receipt/
    );
  });

  it("binds exact sanitized companion bytes into the packet hash", () => {
    const { packet, written } = sealFixture(1);
    const companionBytes = fs.readFileSync(
      path.join(path.dirname(written.path), OBSERVATION_FUNNEL_FILENAME)
    );
    assert.equal(sha256(companionBytes), packet.funnelEvidenceSha256);
    assert.equal(
      sha256(fs.readFileSync(written.path)),
      written.sha256
    );
  });
});
