import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function section(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return value.slice(from, to);
}

test("policy PATCH converges exact-bound restrictions only after commit", () => {
  const route = source("../src/routes/classpilot/ssoPolicy.ts");
  const patch = section(route, '// PATCH /api/classpilot/admin/sso-policy', 'export default router');
  assert.ok(
    patch.indexOf("await updateClasspilotSsoPolicy")
      < patch.indexOf("syncClasspilotControlStatesToActiveDevices"),
    "the durable policy commit must precede best-effort network convergence",
  );
  assert.match(
    patch,
    /getClasspilotStudentControlStates[\s\S]*classpilotControlStateHasAuthRelevantRestriction[\s\S]*syncClasspilotControlStatesToActiveDevices/,
  );
  assert.match(patch, /restrictionAuthPolicyRefreshFailure/);
  assert.match(
    patch,
    /heartbeat\/WS recovery remains the fallback/,
    "recovery surfaces remain the durable fallback when immediate fan-out fails",
  );
});

test("policy PATCH does not invert SSO and student-control lock order", () => {
  const storage = source("../src/services/storage.ts");
  const update = section(
    storage,
    "export async function updateClasspilotSsoPolicy",
    "export async function createCanonicalPass",
  );
  assert.match(update, /lockClasspilotSsoPolicyAuthority/);
  assert.doesNotMatch(
    update,
    /classpilotStudentControlStates/,
    "the SSO-locked PATCH must not wait on rows acquired before SSO authority by ACK/delivery",
  );
});

test("classroom ACKs validate the policy fence under a shared school lock", () => {
  const storage = source("../src/services/storage.ts");
  const acknowledge = section(
    storage,
    "export async function acknowledgeClasspilotStudentControlState",
    "export async function persistClasspilotControlCommandState",
  );
  assert.match(acknowledge, /lockClasspilotSsoPolicyDeliveryAuthority/);
  assert.doesNotMatch(
    acknowledge,
    /lockClasspilotSsoPolicyAuthority/,
    "device ACKs must not serialize school-wide behind the exclusive policy writer lock",
  );
});

test("every exact auth-bearing server surface freezes policy under the shared lock", () => {
  const surfaces = [
    source("../src/routes/classpilot/devices.ts"),
    source("../src/realtime/websocket.ts"),
    source("../src/services/classpilotCommandDispatcher.ts"),
    source("../src/services/classpilotControlStateDelivery.ts"),
    source("../src/services/classpilotSessionLifecycle.ts"),
  ];
  for (const surface of surfaces) {
    assert.match(surface, /lockClasspilotSsoPolicyDeliveryAuthority/);
    assert.match(surface, /getClasspilotSsoPolicyForSchool\([^)]*transactionDb/);
  }
  assert.match(
    surfaces[0]!,
    /preliminary cache projection[\s\S]*authPassThrough: undefined/,
    "the unlocked heartbeat cache projection must carry no SSO authority",
  );
});
