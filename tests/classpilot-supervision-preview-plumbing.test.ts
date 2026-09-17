import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertClasspilotSupervisionPreviewEnv,
  classpilotSupervisionPreviewMode,
  classpilotSupervisionPreviewObserved,
  classpilotSupervisionPreviewRetentionEnabled,
} from "../src/config/classpilotSupervisionPreviewRollout.js";
import type { ScreenshotData } from "../src/realtime/ws-redis.js";
import {
  classBoundScreenshotMatchesBinding,
  classBoundScreenshotBindingVersion,
  decodeSupervisionBoundScreenshotBatchRead,
  supervisionBoundScreenshotBindingCacheKey,
  supervisionBoundScreenshotBindingVersion,
  supervisionBoundScreenshotMatchesBinding,
  type ClassBoundScreenshotBinding,
  type SupervisionBoundScreenshotBinding,
} from "../src/realtime/ws-redis.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const BASE = {
  schoolId: "school-1",
  deviceId: "device-1",
  studentId: "student-1",
  studentSessionId: "session-1",
};

const supervisionBinding: SupervisionBoundScreenshotBinding = {
  ...BASE,
  supervisionContextId: "context-1",
  controlRevision: 7,
};

// Deliberately built so every shared field matches the supervision binding and
// only the scope differs. If the two namespaces were not separated, this is the
// pair that would collide.
const classBinding: ClassBoundScreenshotBinding = {
  ...BASE,
  teachingSessionId: "context-1",
  controlRevision: 7,
};

function supervisionPayload(overrides: Partial<ScreenshotData> = {}): ScreenshotData {
  const timestamp = Date.now();
  return {
    screenshot: "pixel",
    timestamp,
    capturedAt: new Date(timestamp).toISOString(),
    ...supervisionBinding,
    bindingVersion: supervisionBoundScreenshotBindingVersion(supervisionBinding),
    ...overrides,
  };
}

describe("supervision preview rollout flag", () => {
  it("defaults to on when absent, and still reads an unrecognized value as off", () => {
    // Absent is the resting state for every school, current and future.
    assert.equal(classpilotSupervisionPreviewMode(undefined), "on");
    // A typo must never retain a frame the operator did not ask for.
    for (const value of ["", "ON", "enabled", "true", "1"]) {
      assert.equal(classpilotSupervisionPreviewMode(value), "off", `value=${String(value)}`);
    }
    assert.equal(classpilotSupervisionPreviewMode("off"), "off");
    assert.equal(classpilotSupervisionPreviewMode("observe"), "observe");
    assert.equal(classpilotSupervisionPreviewMode("on"), "on");
  });

  it("retains for every school except one that is explicitly carved out", () => {
    // No configuration at all: a school nobody has touched retains previews.
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", {} as NodeJS.ProcessEnv), true);
    assert.equal(classpilotSupervisionPreviewObserved("school-1", {} as NodeJS.ProcessEnv), true);

    const on = { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "on" } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", on), true);

    const carved = {
      CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS: " school-1 , school-2 ",
    } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", carved), false);
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-2", carved), false);
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-3", carved), true);

    // A malformed carve-out list refuses every school rather than guessing
    // which entry was meant, so a typo cannot enable the school it excluded.
    const malformed = {
      CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS: "school-1,",
    } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-3", malformed), false);
    assert.equal(classpilotSupervisionPreviewObserved("school-3", malformed), false);

    // observe runs the paths but must never retain.
    const observe = { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "observe" } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", observe), false);
    assert.equal(classpilotSupervisionPreviewObserved("school-1", observe), true);

    const off = { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "off" } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", off), false);
    assert.equal(classpilotSupervisionPreviewObserved("school-1", off), false);
  });

  it("refuses to boot on a value that would silently read as off", () => {
    assert.throws(
      () => assertClasspilotSupervisionPreviewEnv({
        CLASSPILOT_SUPERVISION_PREVIEW_MODE: "enabled",
      } as NodeJS.ProcessEnv),
      /FATAL: CLASSPILOT_SUPERVISION_PREVIEW_MODE/
    );
    for (const value of [undefined, "off", "observe", "on"]) {
      assert.doesNotThrow(() => assertClasspilotSupervisionPreviewEnv(
        (value === undefined ? {} : { CLASSPILOT_SUPERVISION_PREVIEW_MODE: value }) as NodeJS.ProcessEnv
      ));
    }
  });

  it("refuses to boot on the retired allowlist or an unparseable carve-out", () => {
    // Leaving the allowlist set would read as "these schools have previews"
    // while every other school had them too. Refuse rather than mislead.
    assert.throws(
      () => assertClasspilotSupervisionPreviewEnv({
        CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS: "school-1",
      } as NodeJS.ProcessEnv),
      /CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS is retired/
    );
    // An empty value is what a copied .env.example leaves behind; it carries no
    // claim about any school, so it must not stop a developer booting.
    assert.doesNotThrow(() => assertClasspilotSupervisionPreviewEnv({
      CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS: "",
    } as NodeJS.ProcessEnv));
    assert.throws(
      () => assertClasspilotSupervisionPreviewEnv({
        CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS: "school-1,,school-2",
      } as NodeJS.ProcessEnv),
      /EXCLUDED_SCHOOL_IDS must contain nonempty school identifiers/
    );
  });
});

describe("supervision-bound screenshot key family", () => {
  it("never shares a key or a binding version with the class namespace", () => {
    assert.notEqual(
      supervisionBoundScreenshotBindingVersion(supervisionBinding),
      classBoundScreenshotBindingVersion(classBinding)
    );
    assert.match(supervisionBoundScreenshotBindingVersion(supervisionBinding), /^v3:/);
    assert.match(classBoundScreenshotBindingVersion(classBinding), /^v2:/);
    assert.match(
      supervisionBoundScreenshotBindingCacheKey(supervisionBinding),
      /:screenshot:supervision-bound:/
    );
  });

  it("accepts a well-formed supervision payload", () => {
    assert.equal(
      supervisionBoundScreenshotMatchesBinding(supervisionPayload(), supervisionBinding),
      true
    );
  });

  it("rejects a payload whose scope, revision, or stamp disagrees", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["wrong context", { supervisionContextId: "context-2" }],
      ["wrong revision", { controlRevision: 8 }],
      ["wrong student", { studentId: "student-2" }],
      ["carries a teaching session", { teachingSessionId: "session-x" }],
      ["mismatched binding version", { bindingVersion: "v3:not-the-digest" }],
      ["class binding version", { bindingVersion: classBoundScreenshotBindingVersion(classBinding) }],
    ];
    for (const [label, overrides] of cases) {
      assert.equal(
        supervisionBoundScreenshotMatchesBinding(
          supervisionPayload(overrides),
          supervisionBinding
        ),
        false,
        label
      );
    }
  });

  it("keeps the two generations mutually unreadable", () => {
    // A supervision payload must not satisfy a class read...
    assert.equal(
      classBoundScreenshotMatchesBinding(supervisionPayload(), classBinding),
      false
    );
    // ...and a class payload must not satisfy a supervision read.
    const timestamp = Date.now();
    const classPayload: ScreenshotData = {
      screenshot: "pixel",
      timestamp,
      capturedAt: new Date(timestamp).toISOString(),
      ...classBinding,
      bindingVersion: classBoundScreenshotBindingVersion(classBinding),
    };
    assert.equal(
      supervisionBoundScreenshotMatchesBinding(classPayload, supervisionBinding),
      false
    );
    // The strengthened class matcher rejects any pixel carrying a supervision
    // marker even if every other field lines up.
    assert.equal(
      classBoundScreenshotMatchesBinding(
        { ...classPayload, supervisionContextId: "context-1" },
        classBinding
      ),
      false
    );
  });

  it("isolates a bad row in a batch read instead of failing the cohort", () => {
    const good = JSON.stringify(supervisionPayload());
    const mismatched = JSON.stringify(supervisionPayload({ controlRevision: 9 }));
    const result = decodeSupervisionBoundScreenshotBatchRead(
      [supervisionBinding, supervisionBinding, supervisionBinding],
      [good, mismatched, null]
    );
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.screenshots[0]?.screenshot, "pixel");
    assert.equal(result.screenshots[1], null);
    assert.equal(result.screenshots[2], null);

    assert.equal(
      decodeSupervisionBoundScreenshotBatchRead([supervisionBinding], "not-an-array").status,
      "unavailable"
    );
  });
});

describe("supervision retention target stays server-side", () => {
  it("keeps retention metadata private while supporting an explicit scheduled authority", () => {
    const storage = read("src/services/storage.ts");
    const claim = storage.slice(
      storage.indexOf("export type ClasspilotScreenshotAuthorityClaim"),
      storage.indexOf("export type ClasspilotScreenshotAuthorityProjection")
    );
    assert.ok(claim.length > 0);
    assert.doesNotMatch(
      claim,
      /supervisionRetention|assignedStaffId|expiresAt/i,
      "retention routing metadata must remain private"
    );
    assert.match(claim, /kind: "supervision_context";\s+supervisionContextId: string;\s+controlRevision: number/);
  });

  it("is dropped when the projection is rewritten onto a delivered revision", () => {
    const policy = read("src/services/classpilotScreenshotPolicy.ts");
    const fn = policy.slice(
      policy.indexOf("export function classpilotScreenshotAuthorityForDeliveredControl"),
      policy.indexOf("export function parseClasspilotScreenshotAuthority")
    );
    assert.ok(fn.length > 0);
    assert.match(
      fn,
      /const \{ supervisionRetention: _supersededRetention, \.\.\.rest \} = projection/,
      "a retention target keyed to the current revision must not ride onto an older delivered one"
    );
    assert.doesNotMatch(fn, /\.\.\.projection,/);
  });

  it("resolves only under a live claim and refuses an expired one", () => {
    const storage = read("src/services/storage.ts");
    const resolver = storage.slice(
      storage.indexOf("async function resolveClasspilotSupervisionRetentionTarget"),
      storage.indexOf("export async function getClasspilotScreenshotAuthorityProjection")
    );
    assert.ok(resolver.length > 0);
    assert.match(resolver, /getActiveSupervisionForStudents/);
    assert.match(resolver, /hardExpiresAt\.getTime\(\) <= now\.getTime\(\)/);
    assert.match(resolver, /expiresAt\.getTime\(\) <= now\.getTime\(\)/);
    assert.match(resolver, /claim\.context\.status !== "active"/);
  });

  it("costs nothing at all when the rollout is off", () => {
    // The retention resolver does real database work. With the feature off it
    // must not run, so "off is byte-identical to today" is true of load as
    // well as of behaviour.
    const storage = read("src/services/storage.ts");
    assert.match(
      storage,
      /controlState\?\.supervisionContextId\s*&&\s*controlState\.hardExpiresAt\s*&&\s*classpilotSupervisionPreviewObserved\(options\.schoolId\)/,
      "the resolver must be gated on the rollout, not merely its retention decision"
    );
  });

  it("leaves the device-visible capture window untouched", () => {
    // authorityExpiresAt feeds expiresInSeconds in the policy the extension
    // acts on. A claimed student must keep today's value, so the mixed
    // 2.8.1/2.8.2 fleet sees an identical policy.
    const storage = read("src/services/storage.ts");
    const literal = storage.slice(
      storage.indexOf("const studentAuthority: ClasspilotScreenshotAuthorityProjection = {"),
      storage.indexOf("// Once the supervision-preview rollout is retaining frames")
    );
    assert.ok(literal.length > 0);
    assert.match(
      literal,
      /authorityExpiresAt: session\.authKind === "manual_shared"\s*\?\s*session\.manualLeaseExpiresAt\s*:\s*null/
    );
    assert.doesNotMatch(literal, /supervision/i);
  });

  it("builds the device-facing policy by naming fields, never by spreading the projection", () => {
    // This is what structurally prevents the server-only retention target from
    // reaching a device: the wire object is an explicit literal.
    const policy = read("src/services/classpilotScreenshotPolicy.ts");
    assert.match(policy, /authority: trackingAuthority\.authority/);
    assert.doesNotMatch(policy, /\.\.\.trackingAuthority/);
  });

  it("keeps the teaching gate and both supervision re-assertions intact", () => {
    const storage = read("src/services/storage.ts");
    assert.match(
      storage,
      /!controlState\?\.teachingSessionId\s*\|\|\s*controlState\.supervisionContextId !== null\s*\|\|\s*!controlState\.hardExpiresAt/,
      "the teaching authority gate must be unchanged"
    );
  });
});

describe("Claiming a student grants the same classroom it grants a scheduled block", () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("admits an ad hoc claim through its own rollout, not the scheduled one", () => {
    const authority = source("src/services/classpilotActivityAuthority.ts");
    // Claiming IS the act of taking supervisory responsibility, so the gate turns
    // on which rollout covers the school rather than on whether a schedule exists.
    assert.match(authority, /scheduledSupervisionSource\(context\)\s*\?\s*isScheduledClassroomEnabled\(schoolId\)\s*:\s*classpilotSupervisionPreviewObserved\(schoolId\)/);
    // Every supervision context has a source; an ad hoc claim simply has no schedule.
    assert.match(authority, /export function supervisionActivitySource/);
    assert.match(authority, /scheduledSupervisionSource\(context\) \?\? "ad_hoc_supervision"/);
    // The preview-only authority existed solely to keep tools shut. That
    // distinction is gone, so a second near-identical gate must not linger.
    assert.doesNotMatch(authority, /requireSupervisionPreviewContext/);
  });

  it("lets an ad hoc claim reach the activity feed at all", () => {
    const activity = source("src/services/classpilotDashboardActivity.ts");
    // The SQL prefilter used to exclude ad hoc claims before any gate ran.
    assert.doesNotMatch(activity, /isNotNull\(classpilotSupervisionContexts\.scheduleProfileApplicationId\)/);
    assert.match(activity, /source: supervisionActivitySource\(context\)/);
    assert.match(activity, /isScheduledClassroomEnabled\(schoolId\) \|\| classpilotSupervisionPreviewObserved\(schoolId\)/);
    const history = source("src/services/classpilotActivityHistory.ts");
    assert.doesNotMatch(history, /schedule_profile_application_id IS NOT NULL/);
  });

  it("keeps the command surface server-authoritative", () => {
    // The route filter must never be narrower than the dispatcher's authority,
    // or a command the school is entitled to would 400 before reaching it.
    const coverage = source("src/routes/classpilot/coverage.ts");
    assert.match(coverage, /const classroomTools = scheduledContextHasClassroomTools\(context\)/);
    assert.match(coverage, /SCHEDULED_CLASSROOM_COMMANDS as readonly string\[\]\)\.includes\(commandType\)/);
    // The client renders whatever the server says it may render.
    assert.match(coverage, /commandTypes: classpilotSupervisionPreviewObserved\(res\.locals\.schoolId!\)/);
  });

  it("still names the same one school in both the registry and the environment", () => {
    assert.match(source("src/routes/classpilot/coverage.ts"),
      /contextAuthorityRevision: context\?\.classroomAuthorityRevision \?\? null/);
  });

  it("reaches every school, carving out only the schools that are named", () => {
    const rollout = source("src/config/classpilotSupervisionPreviewRollout.ts");
    // The reader must go through the shared carve-out helper. An allowlist here
    // narrows previews to whatever a stale variable happens to name, and a
    // school onboarded afterwards never receives them at all — which is not
    // visible from the product, only from this file.
    assert.match(rollout,
      /schoolIsOutsideScope\(schoolId, env\.CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS\)/);
    // The retired allowlist has to stop a boot rather than quietly do nothing.
    assert.match(rollout, /assertRetiredClasspilotAllowlist\(\s*env\.CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS/);
    // A school nobody has configured is in the rollout. This is the assertion
    // every future school depends on.
    assert.equal(classpilotSupervisionPreviewObserved("school-a", {} as NodeJS.ProcessEnv), true);
    assert.equal(classpilotSupervisionPreviewObserved("school-a",
      { CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS: "school-a" } as NodeJS.ProcessEnv), false);
    assert.equal(classpilotSupervisionPreviewObserved("school-b",
      { CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS: "school-a" } as NodeJS.ProcessEnv), true);
    // observe still runs the paths without retaining, and off still stops both.
    assert.equal(classpilotSupervisionPreviewObserved("school-a",
      { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "observe" } as NodeJS.ProcessEnv), true);
    assert.equal(classpilotSupervisionPreviewObserved("school-a",
      { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "off" } as NodeJS.ProcessEnv), false);
  });
});
