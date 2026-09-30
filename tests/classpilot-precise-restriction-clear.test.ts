import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  applyClasspilotControlCommand,
  classpilotControlStateRequiresPreciseCapability,
  emptyClasspilotRestrictions,
} from "../src/services/classpilotClassroomState.js";
import {
  PRECISE_CLASSROOM_STATE_PREDICATE_SQL,
  PRECISE_CONTROL_STATE_PREDICATE_SQL,
  PRECISE_RESTRICTION_CLEAR_PROOF_PREFIX,
  PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL,
  clearPreciseRestrictionsFromDesiredState,
  preciseRestrictionClearProof,
} from "../src/services/classpilotPreciseRestrictionRollback.js";
import {
  PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT,
  PRECISE_RESTRICTION_CLEAR_API_FAMILIES,
  PRECISE_RESTRICTION_CLEAR_PRODUCTION_ADMISSION,
  apiTaskDefinitionFamily,
  assertPreciseRestrictionClearExecutionAdmission,
  parsePreciseRestrictionClearCliArgs,
  validatePreciseRestrictionClearCliOptions,
} from "../src/cli/clearClasspilotPreciseRestrictions.js";
import { normalizeAllowedResource } from "../src/services/restrictionResources.js";

// Roadmap PR 2 rollback runbook: before an image older than
// preciseRestrictionResourcesV1 serves traffic, every stored precise Waypoint
// and Flight Path is ended with a revision bump. These are the pure and CLI
// halves; the transactional clear runs against a database in
// classpilot-precise-restriction-dispatch.test.ts.

const DOC = normalizeAllowedResource({ url: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit" });
const SECTION = normalizeAllowedResource({ url: "https://www.nasa.gov/solar-system" });
const DOC_URL = "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit";
const SCHOOL = "11111111-1111-4111-8111-111111111111";
const PROOF = `${PRECISE_RESTRICTION_CLEAR_PROOF_PREFIX}${"a".repeat(64)}`;
const LIVE_API_TASK_DEFINITION = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:7";

function restrictionsWith(overrides: Record<string, unknown>) {
  return {
    ...emptyClasspilotRestrictions(),
    blockList: { active: true, blockedDomains: ["games.example"], name: "Games" },
    attentionMode: { active: false },
    tabLimit: 3,
    temporaryAllows: [{ domain: "ixl.com", expiresAt: "2026-09-29T15:00:00.000Z" }],
    ...overrides,
  };
}

describe("precise restriction rollback transform", () => {
  it("ends a precise Waypoint and keeps every other restriction exactly", () => {
    const websitePath = { active: true, allowedDomains: ["khanacademy.org"], name: "Websites" };
    const desiredState = {
      restrictions: restrictionsWith({
        screenLock: { active: true, url: DOC_URL, resource: DOC },
        flightPath: websitePath,
      }),
      lateSignInDelivery: { origin: "deferred", appliedBindings: [] },
    };
    const cleared = clearPreciseRestrictionsFromDesiredState(desiredState);
    assert.equal(cleared.changed, true);
    assert.equal(cleared.clearedScreenLocks, 1);
    assert.equal(cleared.clearedFlightPaths, 0);
    assert.deepEqual(cleared.desiredState, {
      ...desiredState,
      restrictions: { ...desiredState.restrictions, screenLock: { active: false } },
    });
    // The retained website Flight Path is revealed exactly as a screen-only
    // unlock would reveal it.
    assert.deepEqual(
      (cleared.desiredState as typeof desiredState).restrictions.flightPath,
      applyClasspilotControlCommand(desiredState.restrictions, "unlock-screen", { screenOnly: true }).flightPath
    );
    assert.equal(classpilotControlStateRequiresPreciseCapability(cleared.desiredState), false);
    assert.equal(desiredState.restrictions.screenLock.active, true, "the input is not mutated");
  });

  it("ends a precise Flight Path entirely instead of narrowing it to its websites", () => {
    const desiredState = {
      restrictions: restrictionsWith({
        screenLock: { active: true, url: "https://www.ixl.com/math" },
        flightPath: { active: true, allowedDomains: ["khanacademy.org"], name: "Moon phases", resources: [SECTION, DOC] },
      }),
    };
    const cleared = clearPreciseRestrictionsFromDesiredState(desiredState);
    assert.equal(cleared.clearedFlightPaths, 1);
    assert.deepEqual(cleared.desiredState, {
      restrictions: {
        ...desiredState.restrictions,
        flightPath: { active: false, allowedDomains: [] },
      },
    });
    assert.deepEqual(
      (cleared.desiredState as typeof desiredState).restrictions.screenLock,
      { active: true, url: "https://www.ixl.com/math" },
      "a website Waypoint is not a precise restriction and stays"
    );
  });

  it("applies the presence rule: any key counts, active or not, valid or not", () => {
    for (const screenLock of [
      { active: false, resource: null },
      { active: true, url: DOC_URL, resource: { type: "website", hostname: "docs.google.com", includeSubdomains: true } },
      { active: true, url: DOC_URL, resource: "garbage" },
    ]) {
      const cleared = clearPreciseRestrictionsFromDesiredState({ restrictions: { ...emptyClasspilotRestrictions(), screenLock } });
      assert.equal(cleared.changed, true, JSON.stringify(screenLock));
      assert.deepEqual((cleared.desiredState as { restrictions: { screenLock: unknown } }).restrictions.screenLock, { active: false });
    }
    const websiteOnlyList = clearPreciseRestrictionsFromDesiredState({
      restrictions: { ...emptyClasspilotRestrictions(), flightPath: { active: true, allowedDomains: ["a.example"], resources: [] } },
    });
    assert.equal(websiteOnlyList.changed, true, "an empty or website-only resources list is still a precise key");
  });

  it("clears the legacy flat shape and the Coverage restoration snapshot", () => {
    const flat = clearPreciseRestrictionsFromDesiredState({ screenLock: { active: true, url: DOC_URL, resource: DOC } });
    assert.deepEqual(flat.desiredState, { screenLock: { active: false } });

    const restorable = {
      teachingSessionId: "session-1",
      sourceCommandId: "command-1",
      desiredState: {
        restrictions: restrictionsWith({
          flightPath: { active: true, allowedDomains: [], name: "Docs only", resources: [DOC] },
        }),
      },
    };
    const desiredState = { restrictions: emptyClasspilotRestrictions(), restorableClassState: restorable };
    const cleared = clearPreciseRestrictionsFromDesiredState(desiredState);
    assert.equal(cleared.changed, true);
    assert.equal(cleared.clearedRestorableSnapshot, true);
    assert.deepEqual(cleared.desiredState, {
      restrictions: emptyClasspilotRestrictions(),
      restorableClassState: {
        teachingSessionId: "session-1",
        // A later ACK must not complete the original command's target.
        sourceCommandId: null,
        desiredState: {
          restrictions: { ...restorable.desiredState.restrictions, flightPath: { active: false, allowedDomains: [] } },
        },
      },
    });
  });

  it("leaves website-only, empty and non-object snapshots untouched", () => {
    for (const value of [
      {},
      { restrictions: emptyClasspilotRestrictions() },
      { restrictions: restrictionsWith({ flightPath: { active: true, allowedDomains: ["khanacademy.org"] } }) },
      { restrictions: [{ screenLock: { resource: DOC } }] },
      { restrictions: { screenLock: ["resource"] } },
      { screenLock: "resource" },
      { lateSignInDelivery: { screenLock: { resource: DOC } } },
      { restorableClassState: [{ desiredState: { screenLock: { resource: DOC } } }] },
      null,
      "resource",
      [],
    ]) {
      const cleared = clearPreciseRestrictionsFromDesiredState(value);
      assert.equal(cleared.changed, false, JSON.stringify(value));
      assert.equal(cleared.desiredState, value, "the same reference is returned when nothing changes");
    }
  });
});

describe("precise restriction rollback precheck", () => {
  it("checks exactly the stored snapshot, flat and restorable paths with strict jsonpath", () => {
    const paths = [...PRECISE_CONTROL_STATE_PREDICATE_SQL.matchAll(/desired_state @\? 'strict ([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(paths, [
      "$.restrictions.screenLock.resource",
      "$.restrictions.flightPath.resources",
      "$.screenLock.resource",
      "$.flightPath.resources",
      "$.restorableClassState.desiredState.restrictions.screenLock.resource",
      "$.restorableClassState.desiredState.restrictions.flightPath.resources",
      "$.restorableClassState.desiredState.screenLock.resource",
      "$.restorableClassState.desiredState.flightPath.resources",
    ]);
    assert.match(PRECISE_CLASSROOM_STATE_PREDICATE_SQL, /^cleared_at IS NULL\n/);
    assert.match(PRECISE_CLASSROOM_STATE_PREDICATE_SQL, /state_type = 'screen-lock' AND payload \? 'resource'/);
    assert.match(PRECISE_CLASSROOM_STATE_PREDICATE_SQL, /state_type = 'flight-path' AND payload \? 'resources'/);
    assert.doesNotMatch(PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL, /\b(?:UPDATE|DELETE|INSERT|ALTER|DROP)\b/i, "the precheck is read-only");
  });

  it("is quoted verbatim in the rollout runbook with the CLI steps", () => {
    const runbook = readFileSync(new URL("../docs/CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // The runbook indents the block inside a numbered step; compare line by line.
    const dedent = (text: string) => text.split("\n").map((line) => line.trimStart()).join("\n");
    assert.ok(
      dedent(runbook).includes(`${dedent(PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL)};`),
      "the runbook quotes the reviewed precheck exactly"
    );
    assert.ok(runbook.includes("npm run clear:classpilot-precise-restrictions -- --all-schools"));
    assert.ok(runbook.includes(`--acknowledge ${PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT}`));
    assert.ok(runbook.includes(`PRECISE_RESTRICTION_CLEAR_EXECUTION_ADMISSION=${PRECISE_RESTRICTION_CLEAR_PRODUCTION_ADMISSION}`));
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(
      packageJson.scripts["clear:classpilot-precise-restrictions"],
      "node --env-file-if-exists=.env dist/cli/clearClasspilotPreciseRestrictions.js"
    );
  });

  it("binds execution to the exact rows and revisions of the reviewed dry run", () => {
    const rows = [{ id: "b", revision: 4 }, { id: "a", revision: 9 }];
    const proof = preciseRestrictionClearProof({ schoolId: SCHOOL, controlStates: rows, classroomStateIds: ["y", "x"] });
    assert.match(proof, /^precise-clear-proof-v1:[0-9a-f]{64}$/);
    assert.equal(
      preciseRestrictionClearProof({ schoolId: SCHOOL, controlStates: [...rows].reverse(), classroomStateIds: ["x", "y"] }),
      proof,
      "order does not matter"
    );
    for (const changed of [
      { schoolId: SCHOOL, controlStates: [{ id: "b", revision: 5 }, rows[1]!], classroomStateIds: ["y", "x"] },
      { schoolId: SCHOOL, controlStates: rows, classroomStateIds: ["y"] },
      { schoolId: "22222222-2222-4222-8222-222222222222", controlStates: rows, classroomStateIds: ["y", "x"] },
    ]) {
      assert.notEqual(preciseRestrictionClearProof(changed), proof);
    }
  });
});

describe("precise restriction clear CLI safety contract", () => {
  it("accepts only the reviewed API task-definition families the runtime tool uses", () => {
    const tool = readFileSync(new URL("../scripts/deploy-classpilot-runtime-config.ps1", import.meta.url), "utf8");
    const listed = /\$script:AllowedApiFamilies = @\(([^)]*)\)/.exec(tool)?.[1] ?? "";
    assert.deepEqual([...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]), [...PRECISE_RESTRICTION_CLEAR_API_FAMILIES]);
    assert.equal(apiTaskDefinitionFamily(LIVE_API_TASK_DEFINITION), "schoolpilot-production-api");
    assert.equal(
      apiTaskDefinitionFamily("arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:3"),
      "schoolpilot-production-api-emergency"
    );
    for (const arn of [
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:7",
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:0",
      "schoolpilot-production-api:7",
      undefined,
    ]) {
      assert.equal(apiTaskDefinitionFamily(arn), null, String(arn));
    }
  });

  it("defaults to a dry run and forbids all-school execution", () => {
    const dryRun = parsePreciseRestrictionClearCliArgs(["--school-id", SCHOOL]);
    assert.equal(dryRun.execute, false);
    assert.doesNotThrow(() => validatePreciseRestrictionClearCliOptions(dryRun));
    assert.doesNotThrow(() => validatePreciseRestrictionClearCliOptions(parsePreciseRestrictionClearCliArgs(["--all-schools"])));
    const executeArgs = [
      "--school-id", SCHOOL, "--execute", "--proof", PROOF, "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT,
      "--api-task-definition-arn", LIVE_API_TASK_DEFINITION,
    ];
    for (const args of [
      [],
      ["--school-id", SCHOOL, "--all-schools"],
      ["--school-id", "not-a-uuid"],
      ["--all-schools", "--execute", "--proof", PROOF, "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT, "--api-task-definition-arn", LIVE_API_TASK_DEFINITION],
      ["--school-id", SCHOOL, "--execute", "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT, "--api-task-definition-arn", LIVE_API_TASK_DEFINITION],
      ["--school-id", SCHOOL, "--execute", "--proof", "precise-clear-proof-v1:short", "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT, "--api-task-definition-arn", LIVE_API_TASK_DEFINITION],
      ["--school-id", SCHOOL, "--execute", "--proof", PROOF, "--acknowledge", "yes", "--api-task-definition-arn", LIVE_API_TASK_DEFINITION],
      ["--school-id", SCHOOL, "--execute", "--proof", PROOF, "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT],
      ["--school-id", SCHOOL, "--execute", "--proof", PROOF, "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT, "--api-task-definition-arn", "schoolpilot-production-api:7"],
      ["--school-id", SCHOOL, "--execute", "--proof", PROOF, "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT, "--api-task-definition-arn", "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:7"],
      ["--school-id", SCHOOL, "--execute", "--dry-run", "--proof", PROOF, "--acknowledge", PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT, "--api-task-definition-arn", LIVE_API_TASK_DEFINITION],
      ["--school-id", SCHOOL, "--proof", PROOF],
      ["--school-id", SCHOOL, "--api-task-definition-arn", LIVE_API_TASK_DEFINITION],
    ]) {
      assert.throws(() => validatePreciseRestrictionClearCliOptions(parsePreciseRestrictionClearCliArgs(args)), args.join(" "));
    }
    assert.throws(() => parsePreciseRestrictionClearCliArgs(["--school-id"]));
    assert.throws(() => parsePreciseRestrictionClearCliArgs(["--force"]));
    const execute = parsePreciseRestrictionClearCliArgs(executeArgs);
    assert.doesNotThrow(() => validatePreciseRestrictionClearCliOptions(execute));
    assert.equal(execute.expectedProof, PROOF);
    assert.equal(execute.apiTaskDefinitionArn, LIVE_API_TASK_DEFINITION);
  });

  it("requires explicit admission and the live API task definition for every execution", async () => {
    const identity = async () => ({
      taskDefinitionArn: LIVE_API_TASK_DEFINITION,
      taskDefinitionSha256: "runtime-identity-proof",
    });
    await assert.doesNotReject(() => assertPreciseRestrictionClearExecutionAdmission({
      execute: false,
      environment: {},
      resolveRuntimeIdentity: async () => { throw new Error("a dry run never resolves identity"); },
    }));
    const refused = (error: unknown) =>
      (error as { code?: string }).code === "PRECISE_RESTRICTION_CLEAR_ECS_ONE_OFF_REQUIRED";
    await assert.rejects(() => assertPreciseRestrictionClearExecutionAdmission({
      execute: true, environment: {}, resolveRuntimeIdentity: identity,
    }), refused);
    const admitted = { PRECISE_RESTRICTION_CLEAR_EXECUTION_ADMISSION: PRECISE_RESTRICTION_CLEAR_PRODUCTION_ADMISSION };
    await assert.rejects(() => assertPreciseRestrictionClearExecutionAdmission({
      execute: true, environment: admitted, resolveRuntimeIdentity: async () => null,
    }), refused);
    await assert.rejects(() => assertPreciseRestrictionClearExecutionAdmission({
      execute: true, environment: admitted, resolveRuntimeIdentity: async () => { throw new Error("metadata unavailable"); },
    }), refused);
    // The one-off must run exactly the live API revision, so the capability
    // check reads the live service's registry and kill switch.
    const mismatch = (error: unknown) =>
      (error as { code?: string }).code === "PRECISE_RESTRICTION_CLEAR_TASK_DEFINITION_MISMATCH";
    for (const expectedApiTaskDefinitionArn of [
      undefined,
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:6",
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:7",
    ]) {
      await assert.rejects(() => assertPreciseRestrictionClearExecutionAdmission({
        execute: true, expectedApiTaskDefinitionArn, environment: admitted, resolveRuntimeIdentity: identity,
      }), mismatch, String(expectedApiTaskDefinitionArn));
    }
    const workerTaskDefinition = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:7";
    await assert.rejects(() => assertPreciseRestrictionClearExecutionAdmission({
      execute: true,
      expectedApiTaskDefinitionArn: workerTaskDefinition,
      environment: admitted,
      resolveRuntimeIdentity: async () => ({ taskDefinitionArn: workerTaskDefinition, taskDefinitionSha256: "worker" }),
    }), mismatch, "a one-off outside the reviewed API families is refused even when the ARNs match");
    await assert.doesNotReject(() => assertPreciseRestrictionClearExecutionAdmission({
      execute: true,
      expectedApiTaskDefinitionArn: LIVE_API_TASK_DEFINITION,
      environment: admitted,
      resolveRuntimeIdentity: identity,
    }));
  });
});
