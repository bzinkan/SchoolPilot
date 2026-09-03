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
  it("defaults to off for absent, empty, and unrecognized values", () => {
    for (const value of [undefined, "", "ON", "enabled", "true", "1"]) {
      assert.equal(classpilotSupervisionPreviewMode(value), "off", `value=${String(value)}`);
    }
    assert.equal(classpilotSupervisionPreviewMode("off"), "off");
    assert.equal(classpilotSupervisionPreviewMode("observe"), "observe");
    assert.equal(classpilotSupervisionPreviewMode("on"), "on");
  });

  it("retains only when on, and only for a school in the allowlist", () => {
    const on = { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "on" } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", on), true);

    const scoped = {
      CLASSPILOT_SUPERVISION_PREVIEW_MODE: "on",
      CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS: " school-1 , school-2 ",
    } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", scoped), true);
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-3", scoped), false);

    // observe runs the paths but must never retain.
    const observe = { CLASSPILOT_SUPERVISION_PREVIEW_MODE: "observe" } as NodeJS.ProcessEnv;
    assert.equal(classpilotSupervisionPreviewRetentionEnabled("school-1", observe), false);
    assert.equal(classpilotSupervisionPreviewObserved("school-1", observe), true);

    const off = {} as NodeJS.ProcessEnv;
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
  it("is never placed on the wire authority union", () => {
    const storage = read("src/services/storage.ts");
    const claim = storage.slice(
      storage.indexOf("export type ClasspilotScreenshotAuthorityClaim"),
      storage.indexOf("export type ClasspilotScreenshotAuthorityProjection")
    );
    assert.ok(claim.length > 0);
    assert.doesNotMatch(
      claim,
      /supervision/i,
      "the device-facing authority claim must stay a closed two-member union"
    );
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

  it("keeps the teaching gate and both supervision re-assertions intact", () => {
    const storage = read("src/services/storage.ts");
    assert.match(
      storage,
      /!controlState\?\.teachingSessionId\s*\|\|\s*controlState\.supervisionContextId !== null\s*\|\|\s*!controlState\.hardExpiresAt/,
      "the teaching authority gate must be unchanged"
    );
  });
});
