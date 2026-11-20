import assert from "node:assert/strict";
import { it } from "node:test";
import { createPasspilotIndicatorService, type IndicatorAuthority } from "../src/services/passpilotIndicators.js";
import type { AuditEntry } from "../src/services/audit.js";
import { PasspilotIndicatorStore } from "../src/services/passpilotIndicatorsStore.js";

function fixture() {
  const store = new PasspilotIndicatorStore({ redisConfigured: () => false, production: () => false });
  let authority: IndicatorAuthority = { schoolActive: true, licensed: true, staffActive: true, classActive: true, classAuthorized: true, classSource: "legacy_grades" };
  let scopes = 0;
  let reads = 0;
  let failAudit = false;
  const audits: AuditEntry[] = [];
  const service = createPasspilotIndicatorService({
    store,
    loadAuthority: async (scope) => {
      assert.deepEqual(scope, { schoolId: "school-1", userId: "teacher-1", classId: "class-1" });
      return authority;
    },
    withSchoolContext: async (schoolId, fn) => { assert.equal(schoolId, "school-1"); scopes++; return fn(); },
    loadMask: async (pairing) => { reads++; assert.equal(pairing.userId, "teacher-1"); assert.equal(pairing.classId, "class-1"); return 5; },
    audit: async (entry) => { audits.push(entry); if (failAudit) throw new Error("audit offline"); },
  });
  return { service, store, audits, authority: () => authority, setAuthority: (next: IndicatorAuthority) => { authority = next; }, setFailAudit: () => { failAudit = true; }, reads: () => reads, scopes: () => scopes };
}
const owner = { schoolId: "school-1", userId: "teacher-1" };

it("returns only an aggregate state after fresh authorization in the token's tenant context", async () => {
  const f = fixture();
  const result = await f.service.pair(owner, { classId: "class-1", waterCustomDestination: "Water fountain" });
  assert.deepEqual(Object.keys(result).sort(), ["expiresAt", "pairingId", "token"]);
  assert.deepEqual(await f.service.state(result.token), { version: 1, mask: 5, maxAgeSeconds: 30 });
  assert.equal(f.scopes(), 1);
  assert.equal(JSON.stringify(f.audits).includes(result.token), false);
  assert.equal(await f.service.revoke({ ...owner, userId: "other" }, result.pairingId), false);
  assert.equal(await f.service.revoke(owner, result.pairingId), true);
  await assert.rejects(f.service.state(result.token), { status: 401 });
});

it("rechecks each lifecycle, entitlement, membership, assignment and class-source boundary on every poll", async () => {
  for (const denied of ["schoolActive", "licensed", "staffActive", "classActive", "classAuthorized", "classSource"] as const) {
    const f = fixture();
    const result = await f.service.pair(owner, { classId: "class-1" });
    await f.service.state(result.token);
    f.setAuthority({ ...f.authority(), [denied]: denied === "classSource" ? "classpilot_groups" : false });
    await assert.rejects(f.service.state(result.token), { status: 403 }, denied);
    assert.equal(f.reads(), 1, denied);
  }
});

it("does not expose an unaudited credential and rolls back its authority", async () => {
  const f = fixture();
  f.setFailAudit();
  await assert.rejects(f.service.pair(owner, { classId: "class-1" }), /audit offline/);
  assert.ok(f.audits[0]?.entityId);
  assert.equal(await f.store.revoke(f.audits[0].entityId, owner.schoolId, owner.userId), false);
});
