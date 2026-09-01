import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const component = readFileSync(
  path.join(APP_ROOT, "src/products/classpilot/components/StudentSsoPolicyCard.jsx"),
  "utf8"
);
const settings = readFileSync(
  path.join(APP_ROOT, "src/products/classpilot/pages/Settings.jsx"),
  "utf8"
);

test("administrator SSO policy card is role-contained and uses the dedicated revisioned API", () => {
  assert.match(settings, /<StudentSsoPolicyCard canManage=\{canManageSchoolSettings\}/);
  assert.match(component, /if \(!canManage\) return null/);
  assert.match(component, /enabled: canManage === true/);
  assert.match(component, /apiRequest\("GET", "\/classpilot\/admin\/sso-policy"\)/);
  assert.match(component, /apiRequest\("PATCH", "\/classpilot\/admin\/sso-policy", \{/);
  assert.match(component, /expectedRevision: response\.revision/);
  assert.match(component, /error\?\.response\?\.status === 409/);
});

test("policy, rollout gate, and exact-binding extension evidence remain separate", () => {
  assert.match(component, /label="Policy"/);
  assert.match(component, /label="Server rollout"/);
  assert.match(component, /label="Chromebook evidence"/);
  assert.match(component, /response\.operatorGateActive === true/);
  assert.match(component, /readiness\.readyBindings/);
  assert.match(component, /readiness\.observedBindings/);
  assert.match(component, /not every device in the fleet/);
  assert.doesNotMatch(component, /policy enabled[^\n]{0,40}extension ready/i);
});

test("provider editing preserves security and conflict guidance", () => {
  assert.match(component, /Attention, school blocks, and teacher block lists remain authoritative/);
  assert.match(component, /includeSubdomains/);
  assert.match(component, /accounts\.google\.com/);
  assert.match(component, /Block-policy conflict/);
  assert.match(component, /The URL must be HTTPS and match one of this provider’s host rules/);
  assert.match(component, /The operator gate is off; this policy remains operationally inert/);
  assert.match(component, /href="\/classpilot\/admin\/it-readiness"/);
  assert.doesNotMatch(component, /href="\/classpilot\/it-readiness"/);
});
