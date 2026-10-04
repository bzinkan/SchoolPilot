import assert from "node:assert/strict";
import test from "node:test";
import { decodeHeartbeatScreenshotEvidence } from "../src/services/classpilotHeartbeatScreenshotEvidence.js";

const started = "2026-10-03T12:00:00.123456";
const ownerUpdated = "2026-10-03T12:01:00.999999";
const updated = ownerUpdated + "+00:00";
const expires = "2026-10-03T13:00:00.654321+00:00";
function envelope() {
  return {
    stage: "owner",
    session: { id: "student-session", startedAt: started, authKind: "manual_shared", manualLeaseExpiresAt: expires },
    control: { teachingSessionId: "teaching-session", supervisionContextId: null, revision: 8,
      scheduledEndAt: null, hardExpiresAt: expires, updatedAt: updated },
    candidate: { teachingSessionId: "teaching-session", startTime: started, rosterSnapshotCompletedAt: expires,
      teachingScheduledEndAt: null, controlRevision: 8, controlUpdatedAt: updated,
      controlScheduledEndAt: null, controlHardExpiresAt: expires },
    owners: [{ hasActiveSupervision: false, id: "teaching-session", controlUpdatedAt: ownerUpdated,
      startTime: started, createdAt: started }],
  };
}

function change(path: readonly string[], value: unknown, remove = false): unknown {
  const result = envelope();
  let current: unknown = result;
  for (const key of path.slice(0, -1)) {
    assert.ok(current !== null && typeof current === "object");
    current = Reflect.get(current, key);
  }
  assert.ok(current !== null && typeof current === "object");
  const key = path.at(-1); assert.ok(key);
  if (remove) assert.equal(Reflect.deleteProperty(current, key), true);
  else Reflect.set(current, key, value);
  return result;
}

test("screenshot evidence decodes canonical dates without losing nulls or changing the input", () => {
  const input = envelope(), original = structuredClone(input);
  const result = decodeHeartbeatScreenshotEvidence(input);
  assert.equal(result.stage, "owner");
  if (result.stage !== "owner") assert.fail("expected complete teaching evidence");
  assert.equal(result.session.startedAt.toISOString(), "2026-10-03T12:00:00.123Z");
  assert.equal(result.session.manualLeaseExpiresAt?.toISOString(), "2026-10-03T13:00:00.654Z");
  assert.equal(result.control.updatedAt?.toISOString(), "2026-10-03T12:01:00.999Z");
  assert.equal(result.control.scheduledEndAt, null);
  assert.equal(result.candidate.teachingScheduledEndAt, null);
  assert.equal(result.candidate.controlRevision, 8);
  assert.deepEqual(input, original);
  const next = decodeHeartbeatScreenshotEvidence(input);
  assert.equal(next.stage, "owner");
  if (next.stage !== "owner") assert.fail("expected complete teaching evidence");
  assert.notStrictEqual(result, next);
  assert.notStrictEqual(result.session, next.session);
  assert.notStrictEqual(result.session.startedAt, next.session.startedAt);
  result.session.startedAt.setUTCFullYear(2040);
  assert.equal(next.session.startedAt.toISOString(), "2026-10-03T12:00:00.123Z");
  assert.deepEqual(input, original);
});

test("screenshot evidence preserves each actual early-return stage", () => {
  const source = envelope();
  assert.deepEqual(decodeHeartbeatScreenshotEvidence({ stage: "session_missing" }), { stage: "session_missing" });
  for (const control of [null,
    { ...source.control, teachingSessionId: null, hardExpiresAt: null },
    { ...source.control, teachingSessionId: null, supervisionContextId: "supervision-context" },
  ]) {
    const result = decodeHeartbeatScreenshotEvidence({ stage: "control", session: source.session, control });
    assert.equal(result.stage, "control");
    if (result.stage !== "control") assert.fail("expected control continuation");
    assert.equal(result.control?.teachingSessionId ?? null, null);
    assert.equal(result.control?.supervisionContextId ?? null, control?.supervisionContextId ?? null);
  }
  const absent = decodeHeartbeatScreenshotEvidence({ stage: "candidate_missing", session: source.session, control: source.control });
  assert.equal(absent.stage, "candidate_missing");
});

test("native null-owner anchor and nullable ranking timestamp remain distinct from missing owner rows", () => {
  const input = envelope();
  const anchor = { hasActiveSupervision: true, id: null, controlUpdatedAt: null, startTime: null, createdAt: null };
  const result = decodeHeartbeatScreenshotEvidence({ ...input, owners: [anchor] });
  assert.equal(result.stage, "owner");
  if (result.stage !== "owner") assert.fail("expected owner evidence");
  assert.deepEqual(result.owners, [anchor]);
  const nullable = decodeHeartbeatScreenshotEvidence({ ...input, owners: [{ ...input.owners[0], controlUpdatedAt: null }] });
  assert.equal(nullable.stage, "owner");
  if (nullable.stage !== "owner") assert.fail("expected owner evidence");
  assert.equal(nullable.owners[0]?.controlUpdatedAt, null);
});

for (const [name, value] of [
  ["null", null], ["array", []], ["string", "{}"], ["empty object", {}],
  ["unknown stage", { stage: "fallback" }], ["missing-session stage with injected rows", { stage: "session_missing", session: envelope().session }],
] as const) test(`screenshot evidence rejects ${name}`, () => {
  assert.throws(() => decodeHeartbeatScreenshotEvidence(value));
});

for (const path of [
  ["stage"], ["session"], ["session", "id"], ["session", "startedAt"], ["session", "authKind"], ["session", "manualLeaseExpiresAt"],
  ["control"], ["control", "teachingSessionId"], ["control", "supervisionContextId"], ["control", "revision"],
  ["control", "scheduledEndAt"], ["control", "hardExpiresAt"], ["control", "updatedAt"],
  ["candidate"], ["candidate", "teachingSessionId"], ["candidate", "startTime"], ["candidate", "rosterSnapshotCompletedAt"],
  ["candidate", "teachingScheduledEndAt"], ["candidate", "controlRevision"], ["candidate", "controlUpdatedAt"],
  ["candidate", "controlScheduledEndAt"], ["candidate", "controlHardExpiresAt"], ["owners"],
  ["owners", "0", "hasActiveSupervision"], ["owners", "0", "id"], ["owners", "0", "controlUpdatedAt"],
  ["owners", "0", "startTime"], ["owners", "0", "createdAt"],
]) test(`screenshot evidence rejects missing ${path.join(".")}`, () => {
  assert.throws(() => decodeHeartbeatScreenshotEvidence(change(path, undefined, true)));
});

for (const { name, path, value } of [
  { name: "empty session identity", path: ["session", "id"], value: "" },
  { name: "missing manual lease", path: ["session", "manualLeaseExpiresAt"], value: null },
  { name: "non-string auth kind", path: ["session", "authKind"], value: false },
  { name: "invalid session timestamp", path: ["session", "startedAt"], value: "not-a-date" },
  { name: "numeric session timestamp", path: ["session", "startedAt"], value: 0 },
  { name: "non-JSON Date timestamp", path: ["session", "startedAt"], value: new Date(started + "Z") },
  { name: "invalid manual expiry", path: ["session", "manualLeaseExpiresAt"], value: "infinity" },
  { name: "fractional revision", path: ["control", "revision"], value: 1.5 },
  { name: "negative revision", path: ["control", "revision"], value: -1 },
  { name: "unsafe revision", path: ["control", "revision"], value: Number.MAX_SAFE_INTEGER + 1 },
  { name: "string revision", path: ["control", "revision"], value: "8" },
  { name: "invalid control timestamp", path: ["control", "updatedAt"], value: "not-a-date" },
  { name: "null teaching hard expiry", path: ["control", "hardExpiresAt"], value: null },
  { name: "wrong candidate owner", path: ["candidate", "teachingSessionId"], value: "other-session" },
  { name: "wrong candidate revision", path: ["candidate", "controlRevision"], value: 9 },
  { name: "wrong candidate expiry", path: ["candidate", "controlHardExpiresAt"], value: "2026-10-04T13:00:00Z" },
  { name: "missing roster timestamp", path: ["candidate", "rosterSnapshotCompletedAt"], value: null },
  { name: "empty owner array", path: ["owners"], value: [] },
  { name: "null owner array", path: ["owners"], value: null },
  { name: "truthy supervision flag", path: ["owners", "0", "hasActiveSupervision"], value: "true" },
  { name: "null identity with nonnull dates", path: ["owners", "0", "id"], value: null },
  { name: "nonnull identity with missing start", path: ["owners", "0", "startTime"], value: null },
  { name: "nonnull identity with missing creation", path: ["owners", "0", "createdAt"], value: null },
  { name: "invalid owner start", path: ["owners", "0", "startTime"], value: "not-a-date" },
  { name: "unknown envelope field", path: ["permissionGranted"], value: true },
]) test(`screenshot evidence rejects ${name}`, () => {
  assert.throws(() => decodeHeartbeatScreenshotEvidence(change(path, value)));
});

test("stage transitions cannot omit eligible teaching reads or smuggle candidate rows into a continuation", () => {
  const input = envelope();
  assert.throws(() => decodeHeartbeatScreenshotEvidence({ stage: "control", session: input.session, control: input.control }));
  assert.throws(() => decodeHeartbeatScreenshotEvidence({ ...input, stage: "candidate_missing" }));
  assert.throws(() => decodeHeartbeatScreenshotEvidence({ stage: "candidate_missing", session: input.session, control: null }));
  assert.throws(() => decodeHeartbeatScreenshotEvidence({ ...input, control: { ...input.control, supervisionContextId: "supervision" } }));
});
